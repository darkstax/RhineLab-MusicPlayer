/**
 * 前端 ↔ 桌面壳（WebView2）的唯一入口。
 *
 * 协议唯一权威：docs/IPC-PROTOCOL.md v1。本文件**不翻译消息格式**：
 * 经 `window.chrome.webview.postMessage(string)` / `WebMessageReceived` 直传的 JSON
 * 与管道层完全一致（`v/t/id/seq/ts` + 顶层 `cmd`/`evt`/`data`）。
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
  /** 壳已连接的核心身份；未连接为 null。 */
  readonly core: {
    readonly app?: string;
    readonly ver?: string;
    readonly caps: readonly string[];
    readonly connected: boolean;
  } | null;
};

/** 桥抛出的错误：`code` 取协议 §7 错误码表，或桥/壳侧的 disconnected / timeout / not_desktop。 */
export type BridgeError = Error & { code: string; retryable: boolean };

export type Frame = Record<string, unknown> & {
  v?: number;
  t?: string;
  id?: string;
  evt?: string;
  seq?: number;
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

/** 与壳的连接状态机：握手、id 路由、事件分发、页面重载后的壳侧重放。 */
class DesktopBridge {
  private readonly listeners = new Set<{ type: string; fn: (frame: Frame) => void }>();
  private readonly pending = new Map<string, {
    resolve: (frame: Frame) => void;
    reject: (error: BridgeError) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
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

  /** 订阅帧。`type` 为 `evt`（全部事件）/ `state`（evt 且 evt==="state"）/ `hello`。返回退订函数。 */
  on(type: "evt" | "state" | "hello", fn: (frame: Frame) => void): () => void {
    const entry = { type, fn };
    this.listeners.add(entry);
    return () => this.listeners.delete(entry);
  }

  /** dev-only：壳本地自答 ping + 核心 echo 各测一次，返回微秒往返（M0 演示链路用）。 */
  async ping(): Promise<{ shell_rtt_us: number; core_rtt_us?: number }> {
    if (!this.desktop) throw failure("not_desktop", "ping requires the desktop shell");
    const shell = await this.timed("ping");
    let core: number | undefined;
    try {
      core = await this.timed("echo", { data: "ping" });
    } catch {
      core = undefined;
    }
    return core === undefined ? { shell_rtt_us: shell } : { shell_rtt_us: shell, core_rtt_us: core };
  }

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

  private acceptHello(frame: Frame) {
    const raw = isFrame(frame.core) ? frame.core : undefined;
    const core = raw === undefined ? null : {
      app: typeof raw.app === "string" ? raw.app : undefined,
      ver: typeof raw.ver === "string" ? raw.ver : undefined,
      caps: Array.isArray(raw.caps) ? raw.caps.map(String) : [],
      connected: raw.connected === true,
    };
    this.last.hello = frame;
    this.hello = {
      desktop: true,
      ok: true,
      caps: Array.isArray(frame.caps) ? frame.caps.map(String) : [],
      proto: typeof frame.proto === "number" ? frame.proto : PROTO,
      state: typeof frame.state === "string" ? frame.state : "unknown",
      core,
    };
    const waiters = this.helloWaiters;
    this.helloWaiters = [];
    for (const waiter of waiters) waiter(this.hello);
    this.emit(frame);
  }

  private emit(frame: Frame) {
    if (frame.t === "evt" && frame.evt === "state") this.last.state = frame;
    for (const listener of [...this.listeners]) {
      const match = listener.type === "evt" || listener.type === frame.t ||
        (listener.type === "state" && frame.t === "evt" && frame.evt === "state");
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
