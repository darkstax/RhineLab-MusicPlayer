import { bridge, type Frame } from "../desktop-bridge";
import {
  advance,
  currentTrack,
  emptyQueue,
  isLoopMode,
  nextLoopMode,
  normalizeLoopMode,
  queueTrack,
  startQueue,
  step as stepQueue,
  withMode,
  type LoopMode,
  type PlayQueue,
  type QueueStep,
  type QueueTrack,
} from "./queue";

/**
 * 播放状态仓库（任务书 M1 范围 C3）：单一状态 + 订阅收敛。
 *
 * 两条通路，形状完全一致：
 * - **桌面（desktop=true）**：所有动作走 `bridge.call("engine.*")`，状态由壳重放/核心 `evt` 收敛；
 *   任何 bridge 异常（未握手/断线/超时）都不外抛，转 `error` 状态并回退假引擎继续驱动 UI。
 * - **web / Wallpaper Engine（desktop=false）**：本地 `LocalEngine` 假引擎回退——
 *   语义镜像桩的 `FakeEngine`（同状态机、同 1Hz position、同时长缺省），UI 无感。
 *
 * 队列与循环模式（本轮追加）：决策是纯逻辑（queue.ts，可 node --test）；本模块只做两件事——
 * 把"曲终"信号喂进 `advance()`，把决策结果发成 `engine.play`。曲终有两条来源路径：
 * 本地假引擎的 `tick()`（EOF 才返回 true）与核心的 `evt{state:"stopped"}`（EOF 或显式 stop），
 * 后者靠 `userStopped` 标记区分"用户按了停止"与"真的播完了"——否则用户一按停止就被自动续播。
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
  /** 循环模式（三态，持久化于 config 点路径 player.loop_mode）。 */
  loopMode: LoopMode;
  /** 当前曲在队列中的下标；-1 = 队列为空。 */
  queueIndex: number;
  /** 队列长度（0 表示没有队列，播放条据此禁用上/下一首）。 */
  queueLength: number;
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
 * 循环模式在配置总线上的点路径（与 settings/groups.ts 的 CONFIG_DEFAULTS 同一把钥匙）。
 * 必须定义在 PlayerStore 之前：类字段初始化在模块求值时就会读它（TDZ 会直接抛）。
 */
const LOOP_MODE_PATH = "player.loop_mode";

/**
 * 曲目展示标签（M3 验收发现修正）：file:<路径> 取文件名去扩展（与核心 TrackTitle 同逻辑，
 * 否则整条 Windows 路径塞进播放条的标题窗口毫无意义）；档案号等其它 id 维持 ARCHIVE 前缀。
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
  /** 启动时的循环模式：优先 localStorage 镜像（与 readVolumeMode 同一把钥匙），壳配置随后校正。 */
  private readonly initialLoopMode = readLoopModeMirror();

  /** 播放队列（点专辑曲目时整张入队；散曲播放退化为单曲队列）。 */
  private queue: PlayQueue = emptyQueue(this.initialLoopMode);

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
    loopMode: this.initialLoopMode,
    queueIndex: -1,
    queueLength: 0,
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
  /**
   * 用户主动停止标记：核心的 `state:"stopped"` 同时用于 EOF 与显式 stop，
   * 只按帧面区分不出"播完了"和"我不想听了"。stop() 置位；观察到 playing 帧
   * （任何来源的重播）或 startTrack() 复位——所以它只是"下一次 stopped 是不是曲终"的答案。
   */
  private userStopped = false;

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
      // 循环模式以壳配置为准（镜像只是启动瞬间的猜测）；未存过则保留镜像值。
      void this.hydrateLoopMode();
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
    const wasPlaying = this.snapshot.state === "playing";
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
    // 曲终（核心侧 EOF）：playing → stopped 且非用户主动停止 → 按循环模式续播/停止。
    // 位置不下发任何命令：核心已在 EOF 自行 stopped，续播只需再发一次 engine.play。
    // 刻意不用 position>=duration 做判据：标签时长大于实际文件（VBR/错标签）时核心走
    // endByEof，位置会**小于** duration，那样的判据会让队列卡死在半路。
    if (state === "playing") this.userStopped = false; // 观察到真播放（任何来源的重播）即复位
    if (state === "stopped" && wasPlaying && !this.userStopped) void this.handleTrackEnd();
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
      // tick 只在"播完"时返回 true（用户 stop 走 stop()，不经过这里），天然就是曲终信号。
      if (changed) void this.handleTrackEnd();
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

  // ---------- 队列与曲终（决策在 queue.ts，这里只负责接引擎） ----------

  /** 把队列状态同步进快照（模式/下标/长度三者一起变，订阅者按帧重绘按钮）。 */
  private emitQueue(): void {
    this.emit({
      loopMode: this.queue.mode,
      queueIndex: this.queue.index,
      queueLength: this.queue.tracks.length,
    });
  }

  /** 起播队列里的某一首：先本地更新标签（选曲反馈立即性），再走统一动作出口。 */
  private async startTrack(track: QueueTrack): Promise<void> {
    this.userStopped = false;
    const label =
      track.label ?? this.resolvedLabels.get(track.trackId) ?? trackLabelOf(track.trackId);
    this.emit({ trackId: track.trackId, trackLabel: label });
    await this.command(
      () => bridge.call("engine.play", { track_id: track.trackId, duration_ms: track.durationMs }),
      () => {
        this.local.play(track.trackId, track.durationMs);
        return { trackId: track.trackId, trackLabel: label, durationMs: track.durationMs };
      },
    );
  }

  /**
   * 执行一次队列决策：none（stop）时不下发命令——核心/假引擎在 EOF 已经停了，
   * 再发一次 engine.stop 只会把位置清零、让界面从"播完停在末尾"跳成 00:00。
   */
  private async applyStep(next: QueueStep): Promise<void> {
    this.queue = next.queue;
    this.emitQueue();
    if (next.decision.kind !== "play") return;
    await this.startTrack(next.decision.track);
  }

  /** 曲终（本地假引擎 tick / 桌面核心 evt state=stopped）：按循环模式决定下一首。 */
  private async handleTrackEnd(): Promise<void> {
    await this.applyStep(advance(this.queue));
  }

  /** 桌面启动时以壳配置为准校正循环模式；壳未存过（undefined）则保留镜像值。 */
  private async hydrateLoopMode(): Promise<void> {
    try {
      const result = (await bridge.call("config.get", { path: LOOP_MODE_PATH }, 4000)) as {
        value?: unknown;
      } | null;
      const value = result?.value;
      if (!isLoopMode(value) || value === this.queue.mode) return;
      this.queue = withMode(this.queue, value);
      this.emitQueue();
    } catch {
      // 壳不可用：镜像值继续生效，不打断播放。
    }
  }

  /** 持久化：localStorage 镜像（web 全量 / 桌面兜底）+ 桌面 config.set 落壳 config.json。 */
  private persistLoopMode(mode: LoopMode): void {
    writeMirror(LOOP_MODE_PATH, mode);
    if (!bridge.desktop) return;
    void bridge.call("config.set", { path: LOOP_MODE_PATH, value: mode }, 4000).catch(() => {
      // 壳写失败不回滚：本次会话照常生效，下次启动回落到镜像值。
    });
  }

  // ---------- 动作（dispatch） ----------

  /**
   * 播放单曲（全局搜索、曲库面板点行的既有入口，能力保持不变）。
   * 同时把它当成"只有一首的队列"：这样散曲状态下三种循环模式仍有确定语义
   * （顺序=播完停、专辑=重播、单曲=重播），也保证不会被上一张专辑的队列带着乱跑。
   */
  async play(trackId: string, durationMs = DEFAULT_DURATION_MS): Promise<void> {
    const id = trackId.trim();
    if (!id) {
      this.emit({ error: "请输入档案号（如 X-001）" });
      return;
    }

    const track = queueTrack(id, durationMs, this.resolvedLabels.get(id) ?? null);
    this.queue = startQueue([track], 0, this.queue.mode);
    this.emitQueue();
    await this.startTrack(track);
  }

  /**
   * 整张专辑入队并从 startIndex 开始播（专辑详情页点某首曲目）。
   * 队列项自带时长，切曲不再查库；label 用专辑行标题，先本地显示真名，不走 "ARCHIVE lib:NNN"。
   */
  async playQueue(tracks: readonly QueueTrack[], startIndex: number): Promise<void> {
    const queue = startQueue(tracks, startIndex, this.queue.mode);
    const track = currentTrack(queue);
    if (!track) {
      this.emit({ error: "队列为空，无法播放" });
      return;
    }

    this.queue = queue;
    this.emitQueue();
    await this.startTrack(track);
  }

  /** 手动下一首（队列内环绕，不受单曲循环影响）。 */
  async next(): Promise<void> {
    await this.applyStep(stepQueue(this.queue, 1));
  }

  /** 手动上一首（队列内环绕）。 */
  async previous(): Promise<void> {
    await this.applyStep(stepQueue(this.queue, -1));
  }

  /** 循环模式三态切换（顺序 → 专辑 → 单曲 → 顺序），返回切换后的模式。 */
  cycleLoopMode(): LoopMode {
    const mode = nextLoopMode(this.queue.mode);
    this.setLoopMode(mode);
    return mode;
  }

  setLoopMode(mode: LoopMode): void {
    this.queue = withMode(this.queue, mode);
    this.persistLoopMode(this.queue.mode);
    this.emitQueue();
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
    // 队列项也要跟着修正：否则下次自动切回这一首时标签又退回 id 或专辑行标题。
    if (this.queue.tracks.some((track) => track.trackId === id)) {
      this.queue = {
        ...this.queue,
        tracks: this.queue.tracks.map((track) =>
          track.trackId === id ? { ...track, label: text } : track,
        ),
      };
    }
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
    // 先置位再发命令：紧随其后的 state=stopped 是"用户要停"，不能被当成曲终而自动续播。
    this.userStopped = true;
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
  const value = readMirror("quality.volume_mode");
  return typeof value === "string" && ALLOWED.has(value) ? value : "hardware";
}

/**
 * 读配置镜像里的某个点路径。镜像 = localStorage 键 rhine-music-config 的扁平 JSON，
 * web/壁纸模式下它就是持久化本体；桌面模式下由壳 config.json 兜底（见 hydrateLoopMode）。
 */
function readMirror(path: string): unknown {
  try {
    const raw =
      typeof localStorage === "undefined" ? null : localStorage.getItem("rhine-music-config");
    if (!raw) return undefined;
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)[path]
      : undefined;
  } catch {
    return undefined;
  }
}

/** 写镜像（读-改-写整包，与 settings/groups.ts 的 mirrorPort 同格式，避免互相覆盖）。 */
function writeMirror(path: string, value: unknown): void {
  try {
    if (typeof localStorage === "undefined") return;
    const raw = localStorage.getItem("rhine-music-config");
    const parsed: unknown = raw === null ? {} : JSON.parse(raw);
    const all =
      typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    all[path] = value;
    localStorage.setItem("rhine-music-config", JSON.stringify(all));
  } catch {
    // 配额/隐私模式异常：内存态已更新，下次启动回退默认值，不打断播放。
  }
}

function readLoopModeMirror(): LoopMode {
  return normalizeLoopMode(readMirror(LOOP_MODE_PATH));
}
