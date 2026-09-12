/**
 * M0 临时自检面板 —— **M1 起整体删除**。
 *
 * 只做验收 1-5 要求的可视化：环境、握手 caps、echo 100 连发延迟分布、每秒 state 事件计数。
 * 不 import 任何既有 src/* 模块，样式自注入到自己的根节点，不改动主工程任何节点。
 * 非桌面环境（npm run dev 的浏览器、PWA、Wallpaper Engine）显示降级文案后立即返回。
 */
import { bridge } from "./desktop-bridge";

const PANEL_ID = "m0-selfcheck";
const ECHO_SAMPLES = 100;
// 串行连发：实测 burst 并发（≥8）会把 ack 在写路径/IPC 投递上挤成批次，尾样本被自造成的
// 排队抬高（p95 89–190ms，偏离真实链路开销）；串发单请求总时长 ≈100×16ms=1.6s 可接受，
// 且人工延迟（1–8ms，Windows 定时器分辨率下实测单轮 ≈15ms）与链路开销均可分辨。
const ECHO_CONCURRENCY = 1;

function percentile(sorted: readonly number[], ratio: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return sorted[index];
}

const ms = (microseconds: number) => `${(microseconds / 1000).toFixed(2)}ms`;

export function initM0Selfcheck(): void {
  // Wallpaper Engine 构建不显示调试面板（那里的正常路径没有桌面壳）。
  if (import.meta.env.MODE === "wallpaper") return;
  if (document.getElementById(PANEL_ID)) return;

  const host = document.createElement("section");
  host.id = PANEL_ID;
  host.style.cssText = [
    "position:fixed", "left:12px", "bottom:12px", "z-index:2147483000",
    "max-width:min(440px,calc(100vw - 24px))", "padding:10px 12px",
    "font:11px/1.55 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace",
    "color:#e6e6ea", "background:rgba(12,12,14,.82)", "border:1px solid rgba(255,255,255,.18)",
    "border-radius:6px", "pointer-events:none", "white-space:pre-wrap", "letter-spacing:.02em",
  ].join(";");
  document.body.append(host);

  const lines = [`M0 SELF-CHECK  env=${bridge.desktop ? "desktop" : "web"}`, "protocol=v1 · handshake 中…"];
  const render = () => { host.textContent = lines.join("\n"); };
  render();

  if (!bridge.desktop) {
    lines[1] = "降级：当前不是 WebView2 桌面壳，桥为 no-op（不抛异常、不发起任何请求）。";
    lines.push("主工程功能不受影响；桌面链路请在 RhineShell 窗口中查看。");
    render();
    return;
  }

  // ---- state 事件计数（验收 2/3：每秒 +1；断流后计数停止）----
  // 只订阅 state 事件（不含 hello 帧），断线重连时壳重放的 state 快照也计入，累计值语义纯粹。
  let total = 0;
  const recent: number[] = [];
  lines.push("state 事件: 累计 0 / 近 60s 0");
  const stateLine = () => `state 事件: 累计 ${total} / 近 60s ${recent.length}`;
  bridge.on("state", () => {
    total += 1;
    const now = performance.now();
    recent.push(now);
    while (recent.length > 0 && now - recent[0] > 60000) recent.shift();
    lines[2] = stateLine();
    render();
  });
  const ticker = setInterval(() => {
    const now = performance.now();
    const before = recent.length;
    while (recent.length > 0 && now - recent[0] > 60000) recent.shift();
    if (before !== recent.length) {
      lines[2] = stateLine();
      render();
    }
  }, 1000);
  window.addEventListener("pagehide", () => {
    clearInterval(ticker);
    bridge.dispose();
    host.remove();
  }, { once: true });

  // ---- 握手 ----
  void (async () => {
    const hello = await bridge.handshake();
    lines[1] = `handshake: ${hello.ok ? "ok" : "FAILED"} · shell_state=${hello.state} · proto=${hello.proto}`
      + `\nshell caps: [${hello.caps.join(", ")}]`
      + `\ncore: ${hello.core ? `${hello.core.app} ${hello.core.ver} caps=[${hello.core.caps.join(", ")}]` : "未连接"}`;
    render();

    // ---- echo 100 连发：并发 8，量往返延迟分布 ----
    const samples: number[] = [];
    const failures: string[] = [];
    let cursor = 0;
    const worker = async () => {
      while (cursor < ECHO_SAMPLES) {
        const index = cursor++;
        const start = performance.now();
        try {
          // 协议 §5：echo 的 result 是 `{data}` 原样回带（参数在 cmd 帧的顶层 `data` 里）。
          const result = await bridge.call("echo", { i: index, echo: true }, 8000) as { data?: { i?: number } } | undefined;
          if (result?.data?.i !== index) throw Object.assign(new Error(`payload mismatch at ${index}`), { code: "mismatch" });
          samples.push((performance.now() - start) * 1000);
        } catch (error) {
          const code = (error as { code?: string }).code ?? "error";
          failures.push(`${code}@${index}`);
        }
      }
    };
    await Promise.all(Array.from({ length: ECHO_CONCURRENCY }, worker));

    samples.sort((a, b) => a - b);
    lines.push(`echo ${ECHO_SAMPLES} 连发: ok=${samples.length} fail=${failures.length}`);
    if (samples.length > 0) {
      lines.push(`  p50=${ms(percentile(samples, 0.5))} p95=${ms(percentile(samples, 0.95))} max=${ms(samples[samples.length - 1])}`);
    }
    if (failures.length > 0) {
      lines.push(`  failures: ${failures.slice(0, 6).join(" ")}${failures.length > 6 ? " …" : ""}`);
    }
    const ping = await bridge.ping().catch(() => undefined);
    lines.push(`ping: shell=${ping ? ms(ping.shell_rtt_us) : "n/a"}${ping?.core_rtt_us === undefined ? "" : ` core=${ms(ping.core_rtt_us)}`}`);
    render();
  })();

  // ---- 验收 3/4 取证：断线窗口内每秒 echo 一次（快探活，验证新 call 不悬挂、秒回 err），
  // 另保持若干 30s 超时的慢 call 在飞（验证旧 pending 在断线时被 reject{disconnected}、
  // 不挂到超时）。触发：?m0hold 或桌面壳虚拟主机（production 构建无法用 import.meta.env.DEV 区分）。
  // M1 随本文件整体删除。 ----
  const holdEnabled = new URLSearchParams(location.search).has("m0hold") || location.hostname === "app.rhine.local";
  if (holdEnabled) {
    lines.push("hold echo: 运行中…");
    const holdIndex = lines.length - 1;
    const hold = { fast: 0, slowOk: 0, codes: new Map<string, number>(), worstSlowMs: 0 };
    const holdLine = () =>
      `hold: 快=ok${hold.fast} 慢在飞=ok${hold.slowOk} 慢最长=${hold.worstSlowMs}ms 错=[${[...hold.codes].map(([c, n]) => `${c}×${n}`).join(", ") || "none"}]`;
    const slowCall = () => {
      const start = performance.now();
      void bridge.call("echo", { slow: true }, 30_000).then(
        () => { hold.slowOk += 1; hold.worstSlowMs = Math.max(hold.worstSlowMs, Math.round(performance.now() - start)); },
        (error: unknown) => {
          const msTaken = Math.round(performance.now() - start);
          hold.worstSlowMs = Math.max(hold.worstSlowMs, msTaken);
          const code = `${String((error as { code?: string }).code ?? "error")}<${msTaken}ms`;
          hold.codes.set(code, (hold.codes.get(code) ?? 0) + 1);
        },
      ).finally(() => { lines[holdIndex] = holdLine(); render(); });
    };
    let ticks = 0;
    const timer = setInterval(async () => {
      ticks += 1;
      if (ticks % 4 === 1) slowCall();
      try {
        await bridge.call("echo", { hold: true }, 1500);
        hold.fast += 1;
      } catch (error) {
        const code = String((error as { code?: string }).code ?? "error");
        hold.codes.set(code, (hold.codes.get(code) ?? 0) + 1);
      }
      lines[holdIndex] = holdLine();
      render();
    }, 1000);
    window.addEventListener("pagehide", () => clearInterval(timer), { once: true });
  }
}

initM0Selfcheck();
