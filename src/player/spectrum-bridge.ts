/**
 * 频谱桥（M3，任务书范围 C）：核心 `evt{spectrum}`（协议 §6 v1.3）→ 三条消费路径。
 *
 * 1. **订阅生命周期**：playing → `spectrum.on`；paused/stopped 持续 3s 或页面隐藏 →
 *    `spectrum.off`（省电纪律：无消费者不产出，协议 §5 默认 off）。任何 bridge 异常静默
 *    （桥自带 reject 形状，不打扰 UI）。
 * 2. **壁纸构建律动（零侵入接 scene.setPlayfield）**：wallpaper 构建的上游
 *    `ArchivePlayground` 每个 rAF 轮询 `window.rhineWallpaperSpectrum = { samples, time }`
 *    （128 样本 = bands_l[64] ++ bands_r[64]，上游既有输入通道，WE 宿主同款形状），经
 *    `SpectrumEnvelope` → `MusicBands` → `scene.setPlayfield`——不 import、不改 scene/main。
 * 3. **微型频谱条**：player-bar 订阅 `latestFrame()` 自绘（数据链路可视证据 + M6 活体演示）。
 *
 * web 环境（desktop=false）：不注册、不抛、维持现状（任务书 C4）。
 */
import { bridge, type Frame } from "../desktop-bridge";

export type SpectrumPayload = {
  readonly bandsL: readonly number[];
  readonly bandsR: readonly number[];
  readonly low: number;
  readonly mid: number;
  readonly high: number;
  readonly activity: number;
  readonly beatPhase: number;
  /** 前端收到帧的时刻（performance.now() ms）；陈旧帧判定用。 */
  readonly receivedAt: number;
};

/** 观测入口（headless 验收 4 读取路径；与 __rhinePlayer/__rhineBridge 同一思路，只读）。 */
declare global {
  interface Window {
    __rhineSpectrum?: {
      subscribed(): boolean;
      frames(): number;
      last(): SpectrumPayload | null;
    };
    /** wallpaper 构建的上游频谱输入（WE host.js 同款形状；本桥在桌面核心下顶替写入）。 */
    rhineWallpaperSpectrum?: { samples: number[]; time: number };
  }
}

const BAND_COUNT = 64;
const QUIET_OFF_MS = 3000; // paused/stopped 3s 后退订（任务书 C2「3s 后 quietBands 缓落」）

const asFinite = (value: unknown, fallback = 0) =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

/** 协议 §6 v1.3 的数组读取（信任边界：自家核心出 bug 时丢帧即可，不做注入防御）。 */
function readBands(value: unknown): readonly number[] | null {
  if (!Array.isArray(value) || value.length !== BAND_COUNT) return null;
  const out = new Array<number>(BAND_COUNT);
  for (let i = 0; i < BAND_COUNT; i++) {
    const v = value[i];
    if (typeof v !== "number" || !Number.isFinite(v)) return null;
    out[i] = Math.min(1, Math.max(0, v));
  }
  return out;
}

class SpectrumBridge {
  private latest: SpectrumPayload | null = null;
  private frameCount = 0;
  private readonly listeners = new Set<(payload: SpectrumPayload) => void>();
  private readonly unsubscribe: (() => void)[] = [];
  private subscribed = false;
  private subscribePending = false;
  private quietTimer: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  private playing = false;
  private readonly visibilityHandler = () => {
    // 页面隐藏立即退订（省电）；恢复可见时若在播放再订阅。
    if (document.hidden) this.setSubscribed(false);
    else if (this.playing) this.setSubscribed(true);
  };

  /** 桌面环境启动接线（m1-mount 调用一次；重复调用无效果）。 */
  start() {
    if (this.started || !bridge.desktop || typeof document === "undefined") return;
    this.started = true;
    this.unsubscribe.push(
      bridge.on("spectrum", (frame) => this.accept(frame)),
      bridge.on("state", (frame) => this.syncState(frame)),
    );
    document.addEventListener("visibilitychange", this.visibilityHandler);
    window.addEventListener("pagehide", () => this.stop(), { once: true });
    // 起点假设未播放：等第一份 state 事件收敛（避免 idle 页面无谓订阅 30Hz）。
    void bridge.call("engine.state", {}, 4000).then((result) => {
      if (result && typeof result === "object") this.syncState({ t: "evt", evt: "state", data: result } as Frame);
    }).catch(() => {});
  }

  stop() {
    for (const off of this.unsubscribe) off();
    this.unsubscribe.length = 0;
    if (this.quietTimer) clearTimeout(this.quietTimer);
    this.quietTimer = null;
    document.removeEventListener("visibilitychange", this.visibilityHandler);
    if (this.subscribed) void this.setSubscribed(false);
    this.started = false;
  }

  latestFrame(): SpectrumPayload | null {
    return this.latest;
  }

  onFrame(listener: (payload: SpectrumPayload) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private syncState(frame: Frame) {
    const data = (frame.data ?? {}) as Record<string, unknown>;
    const state = data.state;
    this.playing = state === "playing";
    if (this.playing) {
      if (this.quietTimer) {
        clearTimeout(this.quietTimer);
        this.quietTimer = null;
      }
      if (!document.hidden) this.setSubscribed(true);
      return;
    }
    // paused/stopped/idle：3s 后仍非 playing 才退订（快速往返不抖动订阅）。
    if (this.quietTimer) clearTimeout(this.quietTimer);
    this.quietTimer = setTimeout(() => {
      this.quietTimer = null;
      if (!this.playing) this.setSubscribed(false);
    }, QUIET_OFF_MS);
  }

  private setSubscribed(next: boolean) {
    if (this.subscribed === next || this.subscribePending) return;
    this.subscribePending = true;
    const request = next ? bridge.spectrumOn() : bridge.spectrumOff();
    request
      .then(() => {
        this.subscribed = next;
      })
      .catch(() => {
        // 核心未实现/断线：静默维持现状（web 降级纪律 C4；重连后 state 收敛会重试）。
      })
      .finally(() => {
        this.subscribePending = false;
        // 请求期间状态又变了：补偿一轮（例如 on 回程途中进入 quiet 定时器）。
        if (this.wanted() !== this.subscribed && !this.subscribePending) this.setSubscribed(this.wanted());
      });
  }

  private wanted() {
    return this.playing && !document.hidden;
  }

  private accept(frame: Frame) {
    const data = (frame.data ?? {}) as Record<string, unknown>;
    const bandsL = readBands(data.bands_l);
    const bandsR = readBands(data.bands_r);
    if (!bandsL || !bandsR) return; // 形状不符 = 自家核心 bug 信号，丢帧不崩 UI
    const payload: SpectrumPayload = {
      bandsL,
      bandsR,
      low: asFinite(data.low),
      mid: asFinite(data.mid),
      high: asFinite(data.high),
      activity: asFinite(data.activity),
      beatPhase: asFinite(data.beatPhase),
      receivedAt: performance.now(),
    };
    this.latest = payload;
    this.frameCount += 1;

    // 壁纸构建律动输入：顶替 WE 宿主数组（同一形状），上游 envelope 自动消费。
    if (import.meta.env.MODE === "wallpaper") {
      const samples = new Array<number>(BAND_COUNT * 2);
      for (let i = 0; i < BAND_COUNT; i++) {
        samples[i] = bandsL[i];
        samples[BAND_COUNT + i] = bandsR[i];
      }
      window.rhineWallpaperSpectrum = { samples, time: performance.now() / 1000 };
    }

    for (const listener of [...this.listeners]) {
      try {
        listener(payload);
      } catch {
        // 订阅者异常不影响桥
      }
    }
  }

  /** 诊断/E2E 入口（只读）。 */
  expose() {
    if (typeof window === "undefined") return;
    window.__rhineSpectrum = {
      subscribed: () => this.subscribed,
      frames: () => this.frameCount,
      last: () => this.latest,
    };
  }
}

export const spectrumBridge = new SpectrumBridge();
spectrumBridge.expose();
