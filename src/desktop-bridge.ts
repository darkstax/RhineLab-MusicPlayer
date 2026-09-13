/**
 * 前端 ↔ 桌面壳（WebView2）的唯一入口。
 *
 * 协议唯一权威：docs/IPC-PROTOCOL.md v1.3。本文件**不翻译消息格式**：
 * 经 `window.chrome.webview.postMessage(string)` / `WebMessageReceived` 直传的 JSON
 * 与管道层完全一致（`v/t/id/seq/ts/ep` + 顶层 `cmd`/`evt`/`data`）。
 *
 * 本模块对上游主工程零侵入：不 import 任何既有 src/* 模块；非桌面环境（普通浏览器、
 * Wallpaper Engine、PWA）一律安全降级为 no-op，不抛异常、不产生副作用。
 */

/** 桌面壳首帧（协议 §4 `hello`）在桥侧的解读结果；`desktop`/`ok` 由桥补充，不属于协议字段。 */
export type HelloResult = {
  /** 是否运行在 WebView2 桌面壳内。 */
  readonly desktop: boolean;
  /** 是否与壳完成握手（web 模式恒为 false）。 */
  readonly ok: boolean;
  /** 前端与壳协商后的能力交集（协议 §4）。 */
  readonly caps: readonly string[];
  readonly proto: number;
  /** 壳侧通道状态：connecting / handshaking / ready / disconnected。 */
  readonly state: string;
  /** 壳已连接的核心身份；未连接为 null（字段形状 = 协议 §4 壳聚合 hello 的 core，v1.1/v1.2）。 */
  readonly core: {
    readonly app?: string;
    readonly ver?: string;
    readonly caps: readonly string[];
    /** 协议 v1.2：核心的会话世代（旧核心缺失时为 undefined）。 */
    readonly ep?: number;
    readonly connected: boolean;
    /** 前端与壳的协商交集（壳侧拼装的扩展字段，仅存在于壳↔前端链路）。 */
    readonly negotiated_with_frontend?: readonly string[];
  } | null;
  /** 本次桥接收到的核心事件会话世代（v1.2）；未收到任何带 ep 的帧时为 undefined。 */
  readonly ep?: number;
};

/** `evt` 帧的 kind（协议 §6）；自定义 kind 保留字串兼容。 */
export type EventKind = "state" | "position" | "transition" | "spectrum" | "error";

/** 丢帧诊断快照（任务书 C2：审查 P1-C 落地；M6 诊断页复用）。 */
export type BridgeDiagnostics = {
  /** 当前会话世代（核心 ep）；未知为 null。 */
  readonly ep: number | null;
  /** 各 kind 通道的最近 seq 与累计丢帧数。 */
  readonly channels: Readonly<Record<string, { seq: number; lost: number }>>;
  /** 全部通道的累计丢帧总数（`ep` 变化不复位计数，但复位 seq 基线）。 */
  readonly framesLost: number;
  /** 会话世代切换（核心重启/重连）次数。 */
  readonly epochSwitches: number;
};

/** 桥抛出的错误：`code` 取协议 §7 错误码表，或桥/壳侧的 disconnected / timeout / not_desktop。 */
export type BridgeError = Error & { code: string; retryable: boolean };

export type Frame = Record<string, unknown> & {
  v?: number;
  t?: string;
  id?: string;
  evt?: string;
  seq?: number;
  /** 协议 v1.2：核心会话世代（仅核心侧 evt 与核心 hello 应答携带）。 */
  ep?: number;
  ts?: number;
};

type WebViewHost = {
  postMessage(message: string): void;
  addEventListener(type: "message", handler: (event: { data: unknown }) => void): void;
  removeEventListener(type: "message", handler: (event: { data: unknown }) => void): void;
};

declare global {
  interface Window {
    chrome?: { webview?: WebViewHost };
    /** 桥的自测入口（任务书 C2：diagnostics 自测用，M6 诊断页复用）。仅桌面宿主下赋值。 */
    __rhineBridge?: DesktopBridge;
  }
}

const PROTO = 1;
const DEFAULT_TIMEOUT_MS = 10000;
const HANDSHAKE_TIMEOUT_MS = 3000;

function host(): WebViewHost | undefined {
  const webview = typeof window === "undefined" ? undefined : window.chrome?.webview;
  return typeof webview?.postMessage === "function" && typeof webview.addEventListener === "function"
    ? webview
    : undefined;
}

function failure(code: string, message: string, retryable = false): BridgeError {
  const error = new Error(message) as BridgeError;
  error.code = code;
  error.retryable = retryable;
  return error;
}

const isFrame = (value: unknown): value is Frame =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** 与壳的连接状态机：握手、id 路由、事件分发（kind 级订阅 + 丢帧检测）、页面重载后的壳侧重放。 */
class DesktopBridge {
  private readonly listeners = new Set<{ type: string; fn: (frame: Frame) => void }>();
  private readonly pending = new Map<string, {
    resolve: (frame: Frame) => void;
    reject: (error: BridgeError) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  /** 协议 v1.2 接收侧丢帧检测（审查 P1-C）：按 kind 通道记 (ep, last_seq)。
   * 规则（§6）：ep 变化 → 复位基线不记丢帧；ep 相同且 seq > last+1 → 计入 framesLost；
   * seq ≤ last 视为乱序/重复，丢弃不计数。 */
  private readonly channels = new Map<string, { ep: number | null; seq: number; lost: number }>();
  private ep: number | null = null;
  private epochSwitches = 0;
  private framesLost = 0;
  private sequence = 0;
  private attached = false;
  private hello?: HelloResult;
  private helloWaiters: ((value: HelloResult) => void)[] = [];

  readonly desktop = host() !== undefined;

  /** 最近一次收到的 hello/evt 帧（页面重载后壳会重放，见协议 §9）。 */
  last: { hello?: Frame; state?: Frame } = {};

  constructor() {
    if (!this.desktop) return;
    host()!.addEventListener("message", (event) => this.receive(event.data));
    this.attached = true;
    // 自测/诊断入口（验收 4 的 headless 读取路径；M6 诊断页复用）。
    if (typeof window !== "undefined") window.__rhineBridge = this;
  }

  /** 与壳握手（协议 §4）。非桌面环境返回降级结果，永不 reject。 */
  handshake(timeoutMs = HANDSHAKE_TIMEOUT_MS): Promise<HelloResult> {
    if (!this.desktop) {
      return Promise.resolve({
        desktop: false,
        ok: false,
        caps: [],
        proto: PROTO,
        state: "unavailable",
        core: null,
      });
    }
    if (this.hello) return Promise.resolve(this.hello);

    return new Promise<HelloResult>((resolve) => {
      let settled = false;
      const finish = (value: HelloResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.helloWaiters = this.helloWaiters.filter((waiter) => waiter !== finish);
        resolve(value);
      };
      const timer = setTimeout(
        () => finish(this.hello ?? { desktop: true, ok: false, caps: [], proto: PROTO, state: "timeout", core: null }),
        timeoutMs,
      );
      this.helloWaiters.push(finish);
      this.send({ v: PROTO, t: "hello", role: "webview", proto: PROTO, caps: ["cmd", "evt.state", "evt.position"], app: "rhine-music-player", ver: "0.1.0" });
    });
  }

  /** 发一条 `cmd` 并等待 `ack`/`err`（协议 §5）。非桌面环境以 `not_desktop` reject。 */
  call(cmd: string, args?: object, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<unknown> {
    if (!this.desktop) {
      return Promise.reject(failure("not_desktop", `'${cmd}' requires the desktop shell`));
    }

    const id = `c-${++this.sequence}`;
    const frame: Frame = { v: PROTO, t: "cmd", id, cmd };
    if (args !== undefined) frame.data = args;

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(failure("timeout", `'${cmd}' did not answer within ${timeoutMs}ms`, true));
      }, timeoutMs);
      this.pending.set(id, {
        timer,
        resolve: (reply) => {
          const error = reply.error;
          if (isFrame(error)) {
            reject(failure(String(error.code ?? "internal"), String(error.message ?? "core error"), error.retryable === true));
            return;
          }
          resolve(reply.result);
        },
        reject,
      });
      this.send(frame);
    });
  }

  /**
   * 订阅帧。`type` 取：`evt`（全部事件，旧全量订阅保留兼容）/ 具体 kind（`state`、`position`、
   * `transition`、`spectrum`、`error`，= evt 且 evt 同名的 kind 级订阅，任务书 C2）/ `hello`。
   * 返回退订函数。
   */
  on(type: "evt" | "hello" | EventKind | (string & {}), fn: (frame: Frame) => void): () => void {
    const entry = { type, fn };
    this.listeners.add(entry);
    return () => this.listeners.delete(entry);
  }

  /**
   * 频谱订阅开关（协议 §5/§6 v1.3，M3）：`spectrum.on/off` → `{enabled}`。
   * 非桌面环境以 `not_desktop` reject（调用方自行静默，web 降级零异常）。
   * 便捷方法供 spectrum-bridge 集中管理，不在 UI 代码里散写 cmd 字符串。
   */
  spectrumOn(): Promise<unknown> {
    return this.call("spectrum.on", {});
  }

  spectrumOff(): Promise<unknown> {
    return this.call("spectrum.off", {});
  }

  /** 丢帧检测快照（验收 4 取证；M6 诊断页复用）。 */
  diagnostics(): BridgeDiagnostics {
    const channels: Record<string, { seq: number; lost: number }> = {};
    for (const [kind, channel] of this.channels) channels[kind] = { seq: channel.seq, lost: channel.lost };
    return {
      ep: this.ep,
      channels,
      framesLost: this.framesLost,
      epochSwitches: this.epochSwitches,
    };
  }

  /** dev-only 的 M0 ping 演示链路已随自检面板退役（壳侧同步删除）；保留本方法签名供未来诊断页用。 */
  private async timed(cmd: string, args?: object): Promise<number> {
    const start = performance.now();
    await this.call(cmd, args, 4000);
    return Math.round((performance.now() - start) * 1000);
  }

  private send(frame: Frame) {
    try {
      host()?.postMessage(JSON.stringify(frame));
    } catch (error) {
      this.failAll(failure("internal", `postMessage failed: ${(error as Error).message}`, true));
    }
  }

  private receive(data: unknown) {
    // 协议 §10：先 parse try-catch 再入状态机。
    let frame: Frame | undefined;
    try {
      const parsed: unknown = typeof data === "string" ? JSON.parse(data) : data;
      if (!isFrame(parsed)) throw new Error("not a JSON object");
      frame = parsed;
    } catch {
      return;
    }
    if (frame.t === "ack" || frame.t === "err") return this.settle(frame);
    if (frame.t === "hello") return this.acceptHello(frame);
    this.emit(frame);
  }

  private settle(frame: Frame) {
    const id = typeof frame.id === "string" ? frame.id : undefined;
    const entry = id === undefined ? undefined : this.pending.get(id);
    if (entry === undefined || id === undefined) return;
    this.pending.delete(id);
    clearTimeout(entry.timer);
    entry.resolve(frame);
  }

  /** 协议 v1.2：每帧 evt 的 (ep, seq) 按 kind 通道做丢帧检测（规则见 §6）。 */
  private trackSequence(frame: Frame) {
    const kind = typeof frame.evt === "string" ? frame.evt : "(none)";
    const seq = typeof frame.seq === "number" && Number.isFinite(frame.seq) ? frame.seq : null;
    const ep = typeof frame.ep === "number" && Number.isFinite(frame.ep) ? frame.ep : null;
    if (seq === null) return;

    if (ep !== null && this.ep !== ep) {
      // 会话世代切换（核心重启/新会话）：复位全局基线，跨重连不误报丢帧。
      if (this.ep !== null) this.epochSwitches += 1;
      this.ep = ep;
      this.channels.clear();
    }

    let channel = this.channels.get(kind);
    if (!channel) {
      channel = { ep, seq: 0, lost: 0 };
      this.channels.set(kind, channel);
    }

    if (ep !== channel.ep) {
      // 本通道首次在新世代下见帧：只重置基线。
      channel.ep = ep;
      channel.seq = seq;
      return;
    }

    if (channel.seq === 0) {
      channel.seq = seq;
      return;
    }

    if (seq > channel.seq + 1) {
      channel.lost += seq - channel.seq - 1;
      this.framesLost += seq - channel.seq - 1;
    }

    if (seq > channel.seq) channel.seq = seq;
    // seq ≤ last：乱序/重复，丢弃不计数。
  }

  private acceptHello(frame: Frame) {
    const raw = isFrame(frame.core) ? frame.core : undefined;
    const core = raw === undefined ? null : {
      app: typeof raw.app === "string" ? raw.app : undefined,
      ver: typeof raw.ver === "string" ? raw.ver : undefined,
      caps: Array.isArray(raw.caps) ? raw.caps.map(String) : [],
      ep: typeof raw.ep === "number" ? raw.ep : undefined,
      connected: raw.connected === true,
      negotiated_with_frontend: Array.isArray(raw.negotiated_with_frontend)
        ? raw.negotiated_with_frontend.map(String)
        : undefined,
    };
    this.last.hello = frame;
    // 协议 v1.2：壳聚合 hello 的 core.ep 变化 = 核心新会话（重连/重启），复位丢帧基线。
    if (core?.ep !== undefined && this.ep !== core.ep) {
      if (this.ep !== null) this.epochSwitches += 1;
      this.ep = core.ep;
      this.channels.clear();
    }
    const result: HelloResult = {
      desktop: true,
      ok: true,
      caps: Array.isArray(frame.caps) ? frame.caps.map(String) : [],
      proto: typeof frame.proto === "number" ? frame.proto : PROTO,
      state: typeof frame.state === "string" ? frame.state : "unknown",
      core,
      ep: this.ep ?? undefined,
    };
    this.hello = result;
    const waiters = this.helloWaiters;
    this.helloWaiters = [];
    for (const waiter of waiters) waiter(result);
    this.emit(frame);
  }

  private emit(frame: Frame) {
    if (frame.t === "evt") this.trackSequence(frame);
    if (frame.t === "evt" && frame.evt === "state") this.last.state = frame;
    for (const listener of [...this.listeners]) {
      const match = listener.type === "evt"
        ? frame.t === "evt"
        : listener.type === frame.t ||
          // kind 级订阅：`state`/`position`/… 命中 evt 帧的 evt 字段（旧 "state" 语义并入此规则）。
          (frame.t === "evt" && frame.evt === listener.type);
      if (!match) continue;
      try {
        listener.fn(frame);
      } catch {
        // 订阅者异常不得影响桥的状态机
      }
    }
  }

  private failAll(error: BridgeError) {
    for (const [id, entry] of [...this.pending]) {
      if (!this.pending.delete(id)) continue;
      clearTimeout(entry.timer);
      entry.reject(error);
    }
  }

  /** 页面卸载/卸载重载时清掉挂起请求，避免外部 await 悬挂。 */
  dispose() {
    if (!this.attached) return;
    this.failAll(failure("disconnected", "page is unloading", true));
    this.listeners.clear();
    this.attached = false;
  }
}

export const bridge = new DesktopBridge();
