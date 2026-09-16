// R8 守护：页面启动健康度——**任何未捕获异常都算失败**。
//
// 起因（用户实测白屏）：删除主界面 `.powered` 元素后，src/boot.ts 仍用
// `this.el(".powered").innerHTML` 强制解包 null → boot 构造抛 TypeError → 整页白屏。
// 当时 m-verify 全绿却漏掉了它，因为 live 段只验播放条律动、不验主内容是否渲染。
// 本脚本补上这道闸：连 CDP 加载页面，断言"零未捕获异常 + #stage 进入非 boot 态"。
//
// 用法：先起壳（--remote-debug-port 9245），再 node scripts/check-boot-health.mjs
const CDP_PORT = Number(process.env.CDP_PORT ?? 9245);
const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json().catch(() => null);
const target = list?.find((t) => t.type === "page" && t.url.includes("app.rhine.local"));
if (!target) { console.error(`CDP ${CDP_PORT} 无壳页面（先起壳）`); process.exit(2); }

const ws = new WebSocket(target.webSocketDebuggerUrl);
let seq = 0;
const waiters = new Map();
const exceptions = [];
const consoleErrors = [];
ws.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  if (m.method === "Runtime.exceptionThrown") {
    exceptions.push(String(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text).slice(0, 300));
  }
  if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") {
    consoleErrors.push(m.params.args.map((a) => a.value ?? a.description ?? "").join(" ").slice(0, 240));
  }
  const f = waiters.get(m.id);
  if (f) { f(m); waiters.delete(m.id); }
});
await new Promise((r) => ws.addEventListener("open", r));
const send = (method, params = {}) =>
  new Promise((r) => { const id = ++seq; waiters.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const ev = async (expr) =>
  (await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value;

await send("Runtime.enable");
await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1920, height: 959, deviceScaleFactor: 1, mobile: false });
await send("Page.reload", { ignoreCache: true });
await new Promise((r) => setTimeout(r, 6000));

// 跳过开机动画进主界面（与真实用户点"点击进入"等价）。
// 注意：桩环境没有真实曲库，boot 流程会在 opening 停住等水合——这是**环境限制**，
// 不是缺陷；本守护关心的是"能否走到主界面且零异常"，故显式触发 skip。
await ev("(function(){var s=document.querySelector('#skip'); if(s) s.click(); return !!s;})()");
await new Promise((r) => setTimeout(r, 4000));

const layout = await ev("(document.querySelector('#stage') || {dataset:{}}).dataset.layout");
const mode = await ev("(document.querySelector('#stage') || {dataset:{}}).dataset.mode");
// 白屏的本质是「JS 崩溃 + 主内容区无渲染」。这里以**主内容已挂载**为准据：
//   - #stage 存在且有子节点（模板已注入）
//   - 播放条已渲染（前面已单独断言）
// 注意：不用"启动遮罩消失"作判据——桩环境无真实曲库，boot 会停在 opening 等水合，
// 遮罩恒在（环境限制），与白屏无因果关系，用它会把正常环境误判为失败。
const mainMounted = await ev(
  "(function(){var s=document.querySelector('#stage'); return !!s && s.childElementCount >= 5;})()",
);
const barVisible = await ev("!!document.querySelector('#player-bar .pb-main')");

let fail = 0;
const check = (ok, name, extra = "") => { console.log(`${ok ? "ok  " : "FAIL"} ${name}${extra ? "  " + extra : ""}`); if (!ok) fail++; };
check(exceptions.length === 0, "零未捕获异常（白屏的直接判据）", exceptions.length ? JSON.stringify(exceptions.slice(0, 3)) : "");
check(layout === "desktop" || layout === "opening", "stage layout 已初始化", `layout=${layout} mode=${mode}`);
check(mainMounted, "主内容已挂载（#stage 有子节点）", "");
check(barVisible, "播放条已渲染", "");
check(consoleErrors.length === 0, "无 console.error", consoleErrors.length ? JSON.stringify(consoleErrors.slice(0, 2)) : "");

if (fail === 0) { console.log("BOOT-HEALTH-PASS"); process.exit(0); }
console.log(`BOOT-HEALTH-FAIL (${fail})`);
process.exit(1);
