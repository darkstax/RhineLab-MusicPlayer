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

/**
 * 曲目展示标签（M3 验收发现修正）：file:<路径> 取文件名去扩展（与核心 TrackTitle 同逻辑，
 * 否则整条 Windows 路径塞进 150px 窗口毫无意义）；档案号等其它 id 维持 ARCHIVE 前缀。
 */
export function trackLabelOf(trackId: string): string {
  const filePrefix = "file:";
  if (trackId.startsWith(filePrefix)) {
    const path = trackId.slice(filePrefix.length);
    const base = path.split(/[\\/]/).pop() ?? path;
    const dot = base.lastIndexOf(".");
    return dot > 0 ? base.slice(0, dot) : base;
  }
  return `ARCHIVE ${trackId}`;
}

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
  /**
   * R6（用户实测修正）：`lib:<id>` 的真实歌名缓存（trackId → 显示名）。
   * trackLabelOf 只能从 id 猜（lib: 猜不出），真名由 m1-mount 查 library.get 后回填；
   * 缓存后 acceptState 重放时优先用它，否则每次 state 帧都会把真名覆盖回 "ARCHIVE lib:NNN"。
   */
  private readonly resolvedLabels = new Map<string, string>();
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
      // 审查 P1-3：握手显式触发一次（hello.core.ep 透传通道入接收侧复位；
      // 失败不阻断——后续事件/命令路径自带重连语义）。
      bridge.handshake().catch(() => {});
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
    this.recoverFromLocal(); // 审查 P1-2：真事件恢复桌面引擎
    const data = (frame.data ?? {}) as Record<string, unknown>;
    const state = asPlayerState(data.state);
    if (state === null) return;
    const trackId = asString(data.track_id);
    this.emit({
      state,
      trackId,
      trackLabel: trackId
        ? (this.resolvedLabels.get(trackId) ?? trackLabelOf(trackId))
        : this.snapshot.trackLabel,
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
    this.recoverFromLocal(); // 审查 P1-2：同上，position 也是存活证明
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

  /**
   * 审查 P1-2：降级不再是单程票——只要收到任何真引擎事件（state/position，含 engine.state
   * 回拉应答），就复位 desktop 引擎并停掉本地 ticker；真事件天然压过假引擎。
   * 否则一次瞬时故障（核心重启窗口期点击，retryable 超时）就把用户永久钉在 LOCAL 假引擎上，
   * 后续所有操作静默失效。
   */
  private recoverFromLocal() {
    if (!bridge.desktop || this.snapshot.engine === "desktop") return;
    if (this.localTimer) {
      clearInterval(this.localTimer);
      this.localTimer = null;
    }
    this.emit({ engine: "desktop" });
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
    this.emit({ trackId: id, trackLabel: trackLabelOf(id) });
    await this.command(
      () => bridge.call("engine.play", { track_id: id, duration_ms: durationMs }),
      () => {
        this.local.play(id, durationMs);
        return { trackId: id, trackLabel: trackLabelOf(id), durationMs };
      },
    );
  }

  /**
   * R6：回填 `lib:<id>` 的真实歌名（m1-mount 查 library.get 后调用）。
   * 只改名、不触发 IPC（纯展示层修正），并记入缓存供后续 state 帧复用。
   */
  setTrackLabel(label: string): void {
    const id = this.snapshot.trackId;
    const text = label.trim();
    if (!id || !text) return;
    this.resolvedLabels.set(id, text);
    this.emit({ trackLabel: text });
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
    // R3-P2-8（cb 复核）：原实现把 mode 恒写死 "hardware"——设置页「音质→音量模式」
    // 的 fixed/integer/float 四个选项写进 config 后**永无消费点**（选 fixed="应用满音量"
    // 承诺的旁路不成立）。改为读镜像配置；fixed 由核心锁 1.0（此处仍传值，核心裁决）。
    const mode = readVolumeMode();
    await this.command(
      () => bridge.call("engine.volume", { mode, value: volume }),
      () => {
        this.local.volume = mode === "fixed" ? 1 : volume;
        this.local.volumeMode = mode;
        return { volume: this.local.volume, volumeMode: mode };
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

/**
 * R3-P2-8：读设置页镜像的 `quality.volume_mode`（localStorage 键 rhine-music-config）。
 * 无 localStorage（node/web 早期）或非法值时回退 "hardware"（M1 既定默认）。
 */
function readVolumeMode(): string {
  const ALLOWED = new Set(["hardware", "fixed", "integer", "float"]);
  try {
    const raw =
      typeof localStorage === "undefined"
        ? null
        : localStorage.getItem("rhine-music-config");
    if (!raw) return "hardware";
    const parsed: unknown = JSON.parse(raw);
    const v =
      typeof parsed === "object" && parsed !== null
        ? (parsed as Record<string, unknown>)["quality.volume_mode"]
        : undefined;
    return typeof v === "string" && ALLOWED.has(v) ? v : "hardware";
  } catch {
    return "hardware";
  }
}
