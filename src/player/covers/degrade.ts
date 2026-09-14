import type { CoverTextureCache } from "./texture-cache.ts";

/**
 * 封面管线降级判定（M5-PLAN-v2 §5.4 五条硬条件，写死供 reviewer 核对）。
 *
 * 三态模型（config `wall.covers`，验收 5 + M6 设置入口）：
 * - "textures"：全量纹理（选中卡贴图 + 相邻 ±2 预热）；
 * - "selected"：仅选中卡贴图，不预热（省内存/流量）；
 * - "off"：素面（2D 路径，即 §5.4 的降级形态）。
 *
 * 五条降级条件（满足任一 → 自动切 off 并给出原因；其中条件 5 就是用户显式 off）：
 * 1. 纹理计数 60s 稳态持续增长（LRU 失效 = 泄漏）；
 * 2. 帧时间中位数 > 33ms 且关纹理对照恢复 ≥45fps（证明是纹理成本）；
 * 3. gl.MAX_TEXTURE_SIZE < 2048（老驱动）；
 * 4. 封面虚拟主机通路连续失败（≥12 次）——本项目零 base64 退路，"IPC 往返 p95>50ms"
 *    分支不适用，等价为通路整体失败（FINDINGS 记录该偏差）；
 * 5. 用户显式选择 off。
 *
 * 滞回纪律（写死）：自动降级后置 autoDegrading 粘滞，**只有用户手动改设置
 * （setUserMode）才恢复**；本模块每秒被 evaluate 驱动，但只做单向判定，无抖动。
 */

export type CoverUserMode = "textures" | "selected" | "off";
export const USER_MODES: CoverUserMode[] = ["textures", "selected", "off"];

export function normalizeUserMode(value: unknown): CoverUserMode {
  return value === "off" || value === "selected" || value === "textures"
    ? value
    : "textures";
}

export type DegradeReason =
  | "textureLeak"
  | "frameBudget"
  | "gpuLimit"
  | "hostFailed"
  | "userOff"
  | null;

export const DEGRADE_REASONS: Record<Exclude<DegradeReason, null>, string> = {
  textureLeak: "纹理计数在 60 秒稳态观测中持续增长（缓存失效），封面已停用",
  frameBudget: "帧时间中位数 >33ms 且关闭封面后恢复（纹理成本过高），封面已停用",
  gpuLimit: "GPU 最大纹理尺寸 <2048（老驱动），封面已停用",
  hostFailed: "封面虚拟主机连续取回失败（本地通路异常），封面已停用",
  userOff: "设置中已关闭专辑墙封面",
};

export type DegradeSampler = {
  /** renderer.info.memory.textures。 */
  textures(): number;
  /** 帧时间中位数（ms）。 */
  frameMedianMs(): number;
  /** 关纹理对照轮的中位数（ms）；未做过对照测量时 null（条件 2 不触发）。 */
  frameMedianMsNoCover(): number | null;
  /** gl.MAX_TEXTURE_SIZE（未知时给 4096，不误触条件 3）。 */
  maxTextureSize(): number;
  cache(): CoverTextureCache | null;
};

export type DegradeSnapshot = {
  userMode: CoverUserMode;
  autoDegrading: boolean;
  reason: DegradeReason;
  /** 有效模式（渲染层唯一消费点）。 */
  effective: CoverUserMode;
};

export class CoverDegrader {
  private userMode: CoverUserMode = "textures";
  private autoDegrading = false;
  private reason: DegradeReason = null;
  /** 60s 稳态窗口的每秒纹理样本。 */
  private textureSamples: number[] = [];
  private lastGrowthCheck = -1e9;
  private lastFrameCheck = -1e9;

  constructor(private sampler: DegradeSampler) {}

  /** 用户三态变更（设置入口 = 滞回的唯一恢复通道）。 */
  setUserMode(mode: CoverUserMode) {
    this.userMode = mode;
    this.autoDegrading = false;
    this.reason = null;
    this.textureSamples = [];
  }

  get state(): DegradeSnapshot {
    const effective: CoverUserMode = this.autoDegrading
      ? "off"
      : this.userMode === "off"
        ? "off"
        : this.userMode;
    return {
      userMode: this.userMode,
      autoDegrading: this.autoDegrading,
      reason: this.userMode === "off" ? "userOff" : this.reason,
      effective,
    };
  }

  /**
   * 周期驱动（建议 1Hz；渲染层调用）。按 §5.4 顺序判定，命中即粘滞。
   * 返回当前快照（幂等；已降级时只保持，不再测量）。
   */
  evaluate(nowMs: number): DegradeSnapshot {
    if (this.autoDegrading || this.userMode === "off") return this.state;
    // 条件 3：一次性硬件判定。
    if (this.sampler.maxTextureSize() < 2048) return this.mark("gpuLimit");
    // 条件 1：纹理计数 60s 净增且 90% 步不减（填满期的合法增长被净增阈值排除）。
    if (nowMs - this.lastGrowthCheck >= 1000) {
      this.lastGrowthCheck = nowMs;
      this.textureSamples.push(this.sampler.textures());
      if (this.textureSamples.length > 61) this.textureSamples.shift();
      if (this.growthOverWindow()) return this.mark("textureLeak");
    }
    // 条件 2：每秒一次帧预算判定（需已有关纹理对照测量，避免开机噪声误杀）。
    if (nowMs - this.lastFrameCheck >= 1000) {
      this.lastFrameCheck = nowMs;
      const median = this.sampler.frameMedianMs();
      const control = this.sampler.frameMedianMsNoCover();
      if (median > 33 && control !== null && control <= 22.2)
        return this.mark("frameBudget");
    }
    // 条件 4：封面管线连续失败。
    const cache = this.sampler.cache();
    if (cache && cache.consecutiveFailures >= 12)
      return this.mark("hostFailed");
    return this.state;
  }

  /** 稳态测试钩子（CDP 验收 5：强制走降级路径而不等 60s）。 */
  forceDegrade(reason: Exclude<DegradeReason, null> = "textureLeak") {
    return this.mark(reason);
  }

  private mark(reason: Exclude<DegradeReason, null>): DegradeSnapshot {
    this.autoDegrading = true;
    this.reason = reason;
    return this.state;
  }

  /**
   * 泄漏判定（评审修正版）：窗口 ≥55 个每秒样本、首尾净增 ≥16、≥90% 相邻步不减。
   * LRU 上限 24，正常轮换稳态净增≈0；驱逐真失效时无限净增必命中。
   */
  private growthOverWindow() {
    const samples = this.textureSamples;
    if (samples.length < 55) return false;
    let rising = 0;
    for (let i = 1; i < samples.length; i++)
      if (samples[i] > samples[i - 1]) rising++;
    return (
      samples[samples.length - 1] - samples[0] >= 16 &&
      rising / (samples.length - 1) >= 0.9
    );
  }
}
