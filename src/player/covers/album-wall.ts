/**
 * 专辑墙封面生命周期管理器（M5d 步骤 5 接线核心）。
 *
 * 职责（M5D-PLAN §步骤3/5、M5-PLAN-v2 §5.4）：
 * - 持有 CoverTextureCache（选中卡唯一贴图源）与 CoverDegrader（五条硬条件）；
 * - 选中卡变化 → 换绑纹理（竞态票据：旧请求迟到只释放不上屏）；
 * - 预热：userMode="textures" 时对 records 选中 ±2 预取（"selected" 不预热）；
 * - wall.covers 三态：desktop 模式经 config.get/set 持久化（协议 §5 壳自答），
 *   web/wallpaper 回退 localStorage（键 rhine-wall-covers）；
 * - 降级观测：1Hz evaluate（帧时间中位数 + renderer.info 纹理计数 + 连续失败）；
 * - CDP 探针：snapshot()/setUserMode/forceDegrade/control（验收 3/5/6 取证面）。
 *
 * 纪律：web 模式（records 无 coverKey）全程 no-op；scene 释放（3D 关闭）时
 * detach，重载后 attach 重绑当前选中卡；驱逐 dispose 归 texture-cache。
 */
import { bridge } from "../../desktop-bridge.ts";
import { records } from "../../data.ts";
import type { ArchiveScene } from "../../scene.ts";
import { CoverTextureCache } from "./texture-cache.ts";
import {
  CoverDegrader,
  DEGRADE_REASONS,
  normalizeUserMode,
  type CoverUserMode,
  type DegradeSnapshot,
} from "./degrade.ts";

export type AlbumWallConfig = {
  /** 超级性能模式（预算减半：12/32MiB/256²）。 */
  superPerformance(): boolean;
  /** 当前画质 anisotropy 设置（applyTextureQuality 同口径）。 */
  anisotropy(): number;
  /** 减少动态效果（预热节奏无关，仅探针显示）。 */
  reduced(): boolean;
  /** 是否壁纸构建（壁纸无 config 通道，偏好走 localStorage）。 */
  wallpaper(): boolean;
};

const PREF_KEY = "rhine-wall-covers";

/**
 * 水合时序握手：m1-mount（早于 main.ts 执行）把 hydrateFromLibrary 的 promise 放进来；
 * main.ts 在首帧选择/文案构建前 await。web 模式 = 立即 resolve(null)（零延迟，行为不变）。
 */
export const wallSession: { hydration: Promise<unknown> } = {
  hydration: Promise.resolve(null),
};

function readStoredMode(): CoverUserMode {
  try {
    return normalizeUserMode(JSON.parse(localStorage.getItem(PREF_KEY) ?? "null"));
  } catch {
    return "textures";
  }
}

class AlbumWallManager {
  private cache: CoverTextureCache | null = null;
  private scene: ArchiveScene | null = null;
  private config: AlbumWallConfig = {
    superPerformance: () => false,
    anisotropy: () => 4,
    reduced: () => false,
    wallpaper: () => false,
  };
  private degrade = new CoverDegrader({
    textures: () => this.scene?.renderer.info.memory.textures ?? 0,
    frameMedianMs: () => this.median(this.frameSamples),
    frameMedianMsNoCover: () => this.lastControlMedian,
    maxTextureSize: () => this.maxTextureSize,
    cache: () => this.cache,
  });
  /** 换绑竞态票据（与 scene.coverTicket 独立：manager 侧只认最新选择）。 */
  private ticket = 0;
  private selectedIndex = 0;
  private lastNotifyReason: DegradeSnapshot["reason"] = null;
  private maxTextureSize = 4096;
  /** 帧时间滑窗（ms，最近 600 帧）。 */
  private frameSamples: number[] = [];
  private controlSamples: number[] | null = null;
  private lastControlMedian: number | null = null;
  private controlLabel: string | null = null;
  private configLoaded = false;
  private notifyCallback: ((message: string) => void) | null = null;

  configure(config: Partial<AlbumWallConfig>) {
    this.config = { ...this.config, ...config };
  }

  setNotify(fn: (message: string) => void) {
    this.notifyCallback = fn;
  }

  /** 3D 场景就绪/重建：建立缓存、应用当前有效模式、重绑选中卡。 */
  attach(scene: ArchiveScene) {
    this.scene = scene;
    this.maxTextureSize = scene.renderer.capabilities.maxTextureSize ?? 4096;
    if (!this.cache) this.cache = new CoverTextureCache(scene.renderer);
    this.cache.setSuperPerformance(this.config.superPerformance());
    this.cache.setMaxTextureSize(this.maxTextureSize);
    this.applyAnisotropy();
    scene.setCoverEnabled(this.degrade.state.effective !== "off");
    this.onSelectionChanged(this.selectedIndex, true);
  }

  /** 3D 释放（壁纸 3D 开关/页面卸载）：scene 侧 holding 已在 dispose 释放。 */
  detach() {
    this.scene = null;
  }

  dispose() {
    this.cache?.dispose();
    this.cache = null;
    this.scene = null;
  }

  get ready() {
    return this.scene !== null && this.cache !== null;
  }

  /** desktop 启动后从壳 config 拉三态（协议 §5 config.get 壳自答；幂等）。 */
  async loadConfig(): Promise<void> {
    if (this.configLoaded) return;
    this.configLoaded = true;
    if (this.config.wallpaper()) {
      this.degrade.setUserMode(readStoredMode());
      return;
    }
    if (!bridge.desktop) {
      this.degrade.setUserMode(readStoredMode());
      return;
    }
    try {
      const result = (await bridge.call("config.get", { path: "wall.covers" }, 4000)) as
        | { value?: unknown }
        | null;
      const mode = result?.value === undefined || result.value === null
        ? this.persistedOrDefault()
        : normalizeUserMode(result.value);
      this.applyMode(mode);
    } catch {
      this.applyMode(this.persistedOrDefault());
    }
  }

  private applyMode(mode: CoverUserMode) {
    this.degrade.setUserMode(mode);
    this.applyEffective();
    if (this.scene) this.onSelectionChanged(this.selectedIndex, true);
  }

  private persistedOrDefault(): CoverUserMode {
    return readStoredMode();
  }

  /** 用户三态入口（设置/CDP）；写 localStorage + desktop config.set（滞回的唯一恢复通道）。 */
  setUserMode(mode: CoverUserMode) {
    const normalized = normalizeUserMode(mode);
    this.degrade.setUserMode(normalized);
    try {
      localStorage.setItem(PREF_KEY, JSON.stringify(normalized));
    } catch {}
    if (bridge.desktop && !this.config.wallpaper()) {
      void bridge.call("config.set", { path: "wall.covers", value: normalized }, 4000).catch(() => {});
    }
    this.applyEffective();
    this.onSelectionChanged(this.selectedIndex, true);
  }

  get userMode(): CoverUserMode {
    return this.degrade.state.userMode;
  }

  get state(): DegradeSnapshot {
    return this.degrade.state;
  }

  degradeReasonText(reason: DegradeSnapshot["reason"]): string {
    return reason ? DEGRADE_REASONS[reason] : "";
  }

  /** CDP/演示强制降级（验收 5：不等 60s）。 */
  forceDegrade(reason: Parameters<CoverDegrader["forceDegrade"]>[0] = "textureLeak") {
    this.degrade.forceDegrade(reason);
    this.applyEffective();
    this.onSelectionChanged(this.selectedIndex, true);
    return this.degrade.state;
  }

  /** 主循环帧采样（main.frame 每帧调用；1Hz 触发降级评估）。 */
  frameSample(dtMs: number, nowMs: number) {
    if (dtMs > 0 && dtMs < 1000) {
      this.frameSamples.push(dtMs);
      if (this.frameSamples.length > 600) this.frameSamples.shift();
      this.controlSamples?.push(dtMs);
    }
    const before = this.degrade.state;
    const after = this.degrade.evaluate(nowMs);
    if (after.effective !== before.effective) {
      this.applyEffective();
      this.onSelectionChanged(this.selectedIndex, true);
    }
    if (after.autoDegrading && !before.autoDegrading && after.reason && after.reason !== this.lastNotifyReason) {
      this.lastNotifyReason = after.reason;
      this.notifyCallback?.(this.degradeReasonText(after.reason));
    }
    if (this.cache && this.degrade.state.effective === "textures") this.applyAnisotropy();
  }

  private applyAnisotropy() {
    const max = this.scene?.renderer.capabilities.getMaxAnisotropy() ?? 1;
    this.cache?.configureAnisotropy(this.config.anisotropy(), max);
  }

  private applyEffective() {
    this.scene?.setCoverEnabled(this.degrade.state.effective !== "off");
  }

  /** 选中卡变化（main.updateSelection / select 驱动）。 */
  onSelectionChanged(index: number, force = false) {
    if (!force) this.selectedIndex = index;
    else this.selectedIndex = index;
    const scene = this.scene;
    const cache = this.cache;
    if (!scene || !cache) return;
    const record = records[index];
    const key = record?.coverKey ?? null;
    const effective = this.degrade.state.effective;
    const ticket = ++this.ticket;
    if (!key || effective === "off" || !record) {
      scene.setCoverTexture(null);
      return;
    }
    if (scene.coverKey === key && scene.coverTexture && !force) {
      // 同 key 已上屏：仅保引用（无变化）。
      return;
    }
    void cache.acquire(key).then((holding) => {
      if (ticket !== this.ticket || this.scene !== scene) {
        holding?.release();
        return;
      }
      if (!holding) {
        // 加载失败/负缓存命中：保持素面（绝不上白块）。
        if (scene.coverKey !== key) scene.setCoverTexture(null);
        return;
      }
      scene.setCoverTexture(holding, key);
    });
    if (effective === "textures") this.prefetchAround(index);
  }

  /** 相邻 ±2 预取（textures 态）。 */
  prefetchAround(index: number, span = 2) {
    const cache = this.cache;
    if (!cache) return;
    for (let offset = 1; offset <= span; offset++)
      for (const i of [index - offset, index + offset])
        if (i >= 0 && i < records.length) cache.prefetch(records[i].coverKey);
  }

  /** 缓存预算跟随超级性能（savePrefs 驱动）。 */
  syncBudget() {
    if (!this.cache || !this.scene) return;
    this.cache.setSuperPerformance(this.config.superPerformance());
  }

  /** 帧时间中位数（验收 6：开/关封面各一轮）。 */
  medianFrameMs(): number {
    return this.median(this.frameSamples);
  }

  /** CDP 对照窗口：covers=false 强制素面采样（不动 userMode）。 */
  controlStart(covers: boolean, label: string) {
    this.controlSamples = [];
    this.controlLabel = label;
    this.scene?.setCoverEnabled(covers && this.degrade.state.effective !== "off");
    if (!covers) this.scene?.setCoverTexture(null);
    else this.onSelectionChanged(this.selectedIndex, true);
    return { ok: true, label, covers };
  }

  controlFinish(): { label: string | null; medianMs: number | null; samples: number } {
    const samples = this.controlSamples ?? [];
    const medianMs = this.median(samples);
    this.controlSamples = null;
    if (this.controlLabel === "off") this.lastControlMedian = medianMs;
    const label = this.controlLabel;
    this.controlLabel = null;
    return { label, medianMs, samples: samples.length };
  }

  /** CDP 探针（验收 3/5/6 数据面）。 */
  snapshot() {
    return {
      ...this.degrade.state,
      ready: this.ready,
      superPerformance: this.config.superPerformance(),
      targetEdge: this.cache?.targetEdge ?? null,
      budget: this.cache
        ? {
            maxTextures: this.cache.superPerformanceBudget ? 12 : 24,
            maxBytes: this.cache.superPerformanceBudget ? 32 * 1024 * 1024 : 96 * 1024 * 1024,
          }
        : null,
      cache: this.cache?.getSnapshot() ?? null,
      rendererTextures: this.scene?.renderer.info.memory.textures ?? null,
      coverMapped: this.scene?.coverTexture !== null && this.scene?.coverTexture !== undefined,
      frameMedianMs: this.medianFrameMs(),
      controlMedianMs: this.lastControlMedian,
      maxTextureSize: this.maxTextureSize,
    };
  }

  private median(values: number[]): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }
}

export const albumWall = new AlbumWallManager();

// 诊断/E2E 入口（与 __rhineLibrary/__rhinePlayer 同思路：读写均限本模块职责面）。
declare global {
  interface Window {
    __rhineCovers?: {
      snapshot(): ReturnType<AlbumWallManager["snapshot"]>;
      setUserMode(mode: CoverUserMode): ReturnType<AlbumWallManager["snapshot"]>;
      forceDegrade(reason?: "textureLeak" | "frameBudget" | "gpuLimit" | "hostFailed" | "userOff"): unknown;
      control(covers: boolean, label?: string): unknown;
      controlFinish(): unknown;
      medianFrameMs(): number;
    };
  }
}
if (typeof window !== "undefined") {
  window.__rhineCovers = {
    snapshot: () => albumWall.snapshot(),
    setUserMode: (mode) => {
      albumWall.setUserMode(mode);
      return albumWall.snapshot();
    },
    forceDegrade: (reason) => albumWall.forceDegrade(reason),
    control: (covers, label) => albumWall.controlStart(covers, label ?? (covers ? "on" : "off")),
    controlFinish: () => albumWall.controlFinish(),
    medianFrameMs: () => albumWall.medianFrameMs(),
  };
}
