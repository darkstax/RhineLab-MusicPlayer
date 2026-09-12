import { bridge, type Frame } from "../desktop-bridge";

/**
 * 播放状态仓库（任务书 M1 范围 C3）：单一状态 + 订阅收敛。
 *
 * 两条通路，形状完全一致：
 * - **桌面（desktop=true）**：所有动作走 `bridge.call("engine.*")`，状态由壳重放/核心 `evt` 收敛；
 *   任何 bridge 异常（未握手/断线/超时）都不外抛，转 `error` 状态并回退假引擎继续驱动 UI。
 * - **web / Wallpaper Engine（desktop=false）**：本地 `LocalEngine` 假引擎回退——
 *   语义镜像桩的 `FakeEngine`（同状态机、同 1Hz position、同时长缺省），UI 无感。
 *
 * 本模块不 import 任何上游业务模块；事件只依赖 desktop-bridge 的导出。
 */

export type PlayerState = "idle" | "playing" | "paused" | "stopped";

export type PlayerSnapshot = {
  state: PlayerState;
  trackId: string | null;
  trackLabel: string;
  positionMs: number;
  durationMs: number;
  volume: number;
  volumeMode: string;
  /** 协议 §6：M1 桩 negotiated/badges=null；web 回退同样为 null。 */
  negotiated: unknown | null;
  badges: unknown | null;
  /** 桌面壳/核心的错误提示（evt.error 与调用异常汇入此处，由播放条做 toast）。 */
  error: string | null;
  /** 引擎来源：desktop=真 IPC；local=假引擎回退。 */
  engine: "desktop" | "local";
  /** 会话世代（v1.2）；用于 UI 显示“引擎已重启”。 */
  ep: number | null;
  framesLost: number;
};

/** E2E/诊断入口（与 bridge 的 __rhineBridge 同一思路：只暴露读接口，不暴露写接口）。 */
declare global {
  interface Window {
    __rhinePlayer?: { snapshot(): PlayerSnapshot };
  }
}

const DEFAULT_DURATION_MS = 180_000;
const TICK_MS = 1000;

type Listener = (snapshot: PlayerSnapshot) => void;

const asNumber = (value: unknown, fallback: number) =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;
const asString = (value: unknown) => (typeof value === "string" ? value : null);
const asPlayerState = (value: unknown): PlayerState | null =>
  value === "playing" || value === "paused" || value === "stopped" || value === "idle" ? value : null;

/**
 * 假引擎：与 host/RhineCoreStub/FakeEngine.cs 同语义（时钟锚点状态机）。
 * 保持极小：只支撑 UI 的 play/pause/toggle/seek/stop/音量。
 */
class LocalEngine {
  state: PlayerState = "idle";
  trackId: string | null = null;
  durationMs = DEFAULT_DURATION_MS;
  volume = 1;
  volumeMode = "float";
  private anchorEpoch = 0;
  private anchorPosition = 0;

  private get now(): number {
    return Date.now();
  }

  position(): number {
    if (this.state !== "playing") return this.anchorPosition;
    return Math.min(this.anchorPosition + (this.now - this.anchorEpoch), this.durationMs);
  }

  play(trackId: string, durationMs = DEFAULT_DURATION_MS): PlayerSnapshot | null {
    this.trackId = trackId;
    this.durationMs = Math.max(1, durationMs);
    this.anchorPosition = 0;
    this.anchorEpoch = this.now;
    this.state = "playing";
    return null;
  }

  pause() {
    if (this.state === "playing") {
      this.anchorPosition = this.position();
      this.state = "paused";
    }
  }

  resume() {
    if (this.state === "paused") {
      this.anchorEpoch = this.now;
      this.state = "playing";
    }
  }

  toggle() {
    if (this.state === "playing") this.pause();
    else if (this.state === "paused") this.resume();
    else if (this.trackId) this.play(this.trackId, this.durationMs);
  }

  stop() {
    this.anchorPosition = 0;
    this.anchorEpoch = this.now;
    this.state = "stopped";
  }

  seek(positionMs: number) {
    this.anchorPosition = Math.min(Math.max(0, positionMs), this.durationMs);
    this.anchorEpoch = this.now;
  }

  /** 1Hz 心跳：播完自动 stopped（与桩 Tick 同语义）。返回是否发生状态变化。 */
  tick(): boolean {
    if (this.state === "playing" && this.position() >= this.durationMs) {
      this.anchorPosition = this.durationMs;
      this.state = "stopped";
      return true;
    }

    return false;
  }
}

export class PlayerStore {
  private snapshot: PlayerSnapshot = {
    state: "idle",
    trackId: null,
    trackLabel: "NO SIGNAL / 未载入曲目",
    positionMs: 0,
    durationMs: DEFAULT_DURATION_MS,
    volume: 1,
    volumeMode: "float",
    negotiated: null,
    badges: null,
    error: null,
    engine: bridge.desktop ? "desktop" : "local",
    ep: null,
    framesLost: 0,
  };

  private readonly listeners = new Set<Listener>();
  private readonly local = new LocalEngine();
  private localTimer: ReturnType<typeof setInterval> | null = null;
  private readonly unsubscribe: (() => void)[] = [];
  private busy = false;
  private errorTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    if (bridge.desktop) {
      this.unsubscribe.push(
        bridge.on("state", (frame) => this.acceptState(frame)),
        bridge.on("position", (frame) => this.acceptPosition(frame)),
        bridge.on("error", (frame) => this.acceptError(frame)),
      );
    } else {
      this.startLocalTicker();
    }
  }

  get state(): PlayerSnapshot {
    return this.snapshot;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.snapshot);
    return () => this.listeners.delete(listener);
  }

  private emit(patch: Partial<PlayerSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of [...this.listeners]) listener(this.snapshot);
  }

  /** 协议 §6 state 事件 / engine.state 快照。 */
  private acceptState(frame: Frame) {
    const data = (frame.data ?? {}) as Record<string, unknown>;
    const state = asPlayerState(data.state);
    if (state === null) return;
    const trackId = asString(data.track_id);
    this.emit({
      state,
      trackId,
      trackLabel: trackId ? `ARCHIVE ${trackId}` : this.snapshot.trackLabel,
      positionMs: asNumber(data.position_ms, this.snapshot.positionMs),
      durationMs: asNumber(data.duration_ms, this.snapshot.durationMs),
      volume: asNumber(data.volume, this.snapshot.volume),
      negotiated: data.negotiated === undefined ? this.snapshot.negotiated : data.negotiated,
      badges: data.badges === undefined ? this.snapshot.badges : data.badges,
      ep: asNumber(frame.ep, this.snapshot.ep ?? 0) || this.snapshot.ep,
      framesLost: bridge.desktop ? bridge.diagnostics().framesLost : 0,
    });
  }

  private acceptPosition(frame: Frame) {
    const data = (frame.data ?? {}) as Record<string, unknown>;
    this.emit({
      positionMs: asNumber(data.position_ms, this.snapshot.positionMs),
      ep: asNumber(frame.ep, this.snapshot.ep ?? 0) || this.snapshot.ep,
      framesLost: bridge.diagnostics().framesLost,
    });
  }

  private acceptError(frame: Frame) {
    const data = (frame.data ?? {}) as Record<string, unknown>;
    this.fail(`${asString(data.code) ?? "engine"}: ${asString(data.message) ?? "核心事件错误"}`);
  }

  /** 桌面引擎不可用时切本地假引擎（保持 UI 可用），并把原因作为 toast 文案。 */
  private fail(message: string) {
    if (this.snapshot.engine === "desktop") this.snapshot = { ...this.snapshot, engine: "local" };
    this.emit({ error: message, engine: "local" });
    if (!this.localTimer) this.startLocalTicker();
    if (this.errorTimer) clearTimeout(this.errorTimer);
    this.errorTimer = setTimeout(() => this.emit({ error: null }), 4200);
  }

  private startLocalTicker() {
    if (this.localTimer) return;
    this.localTimer = setInterval(() => {
      const changed = this.local.tick();
      this.emit({
        positionMs: this.local.position(),
        durationMs: this.local.durationMs,
        volume: this.local.volume,
        volumeMode: this.local.volumeMode,
        ...(changed ? { state: this.local.state } : {}),
      });
    }, TICK_MS);
    if (typeof window !== "undefined") {
      window.addEventListener("pagehide", () => this.dispose(), { once: true });
    }
  }

  /** 从本地假引擎同步一帧（动作后立即刷新，不等待下一 tick）。 */
  private syncLocal(patch: Partial<PlayerSnapshot> = {}) {
    this.emit({
      state: this.local.state,
      trackId: this.local.trackId,
      positionMs: this.local.position(),
      durationMs: this.local.durationMs,
      volume: this.local.volume,
      volumeMode: this.local.volumeMode,
      ...patch,
    });
  }

  /**
   * 统一的动作出口：桌面走真 IPC，web/降级走假引擎。
   * 所有 bridge 调用 try-catch；异常时 fail() 切回退，UI 无感继续。
   */
  private async command(
    desktop: () => Promise<unknown>,
    local: () => Partial<PlayerSnapshot>,
  ): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      if (this.snapshot.engine === "desktop" && bridge.desktop) {
        await desktop();
        // ack 为准、事件为补：动作后回拉一次 engine.state 收敛。丢帧（如 --halt-events 窗口
        // 吞掉命令补发帧）不能卡住 UI；多一次 10ms 往返可接受。
        await this.refresh();
      } else {
        this.syncLocal(local());
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const patch = local();
      this.local.tick();
      this.fail(message);
      this.syncLocal(patch);
    } finally {
      this.busy = false;
    }
  }

  // ---------- 动作（dispatch） ----------

  async play(trackId: string, durationMs = DEFAULT_DURATION_MS): Promise<void> {
    const id = trackId.trim();
    if (!id) {
      this.emit({ error: "请输入档案号（如 X-001）" });
      return;
    }

    // 先本地更新标签，不等 IPC 往返（选曲反馈立即性；真快照随后覆盖）。
    this.emit({ trackId: id, trackLabel: `ARCHIVE ${id}` });
    await this.command(
      () => bridge.call("engine.play", { track_id: id, duration_ms: durationMs }),
      () => {
        this.local.play(id, durationMs);
        return { trackId: id, trackLabel: `ARCHIVE ${id}`, durationMs };
      },
    );
  }

  async pause(): Promise<void> {
    await this.command(
      () => bridge.call("engine.pause", {}),
      () => {
        this.local.pause();
        return { state: "paused" };
      },
    );
  }

  async resume(): Promise<void> {
    await this.command(
      () => bridge.call("engine.resume", {}),
      () => {
        this.local.resume();
        return { state: "playing" };
      },
    );
  }

  async toggle(): Promise<void> {
    await this.command(
      () => bridge.call("engine.toggle", {}),
      () => {
        this.local.toggle();
        return { state: this.local.state };
      },
    );
  }

  async stop(): Promise<void> {
    await this.command(
      () => bridge.call("engine.stop", {}),
      () => {
        this.local.stop();
        return { state: "stopped", positionMs: 0 };
      },
    );
  }

  async seek(positionMs: number): Promise<void> {
    const target = Math.max(0, Math.round(positionMs));
    await this.command(
      () => bridge.call("engine.seek", { position_ms: target }),
      () => {
        this.local.seek(target);
        return { positionMs: target };
      },
    );
  }

  async setVolume(value: number): Promise<void> {
    const volume = Math.min(1, Math.max(0, value));
    await this.command(
      // 协议 §5：mode=hardware 交宿主音量；M1 桩只存值（不改声）。
      () => bridge.call("engine.volume", { mode: "hardware", value: volume }),
      () => {
        this.local.volume = volume;
        this.local.volumeMode = "hardware";
        return { volume, volumeMode: "hardware" };
      },
    );
  }

  /** 查询核心状态快照（engine.state）：桌面启动时拉一次，与重放互补。 */
  async refresh(): Promise<void> {
    if (!bridge.desktop || this.snapshot.engine !== "desktop") return;
    try {
      const result = await bridge.call("engine.state", {}, 4000);
      if (result && typeof result === "object") {
        this.acceptState({ t: "evt", evt: "state", data: result } as Frame);
      }
    } catch {
      // 未连接/超时不打断 UI：下一次 state 事件或重连重放会补齐。
    }
  }

  dispose() {
    for (const off of this.unsubscribe) off();
    this.unsubscribe.length = 0;
    this.listeners.clear();
    if (this.localTimer) clearInterval(this.localTimer);
    if (this.errorTimer) clearTimeout(this.errorTimer);
    this.localTimer = null;
    this.errorTimer = null;
  }
}

export const playerStore = new PlayerStore();

// 诊断/E2E 入口：只暴露快照读（不暴露动作），验收脚本据此断言 UI 背后的真实状态。
if (typeof window !== "undefined") {
  window.__rhinePlayer = { snapshot: () => playerStore.state };
}
