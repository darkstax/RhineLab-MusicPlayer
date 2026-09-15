// R6 布局回归守护（用户实测反馈）：
// ①播放条元素不得溢出 #player-bar 主条边界
// ②频谱 / 品牌行(.powered) / 系统页脚 三者与播放条不得重叠
// ③详情页内容（#detail-content）限高可滚动，不压底部装饰
//
// 运行：node scripts/check-player-layout.mjs   （需先 npm run build；用内置 playwright）
// 退出码 0 = 全过。
import http from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { extname, join } from "node:path";

const DIST = new URL("../dist/", import.meta.url).pathname.replace(/\/$/, "");
const PORT = 8901;
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".woff2": "font/woff2",
  ".json": "application/json", ".gif": "image/gif", ".txt": "text/plain" };

if (!existsSync(join(DIST, "index.html"))) {
  console.error("dist/index.html 不存在，先跑 npm run build");
  process.exit(1);
}

const server = http.createServer((req, res) => {
  const p = join(DIST, decodeURIComponent((req.url ?? "/").split("?")[0]));
  try {
    const body = readFileSync(p);
    res.writeHead(200, { "Content-Type": MIME[extname(p)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end("404");
  }
});
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));

// 用 CDP 连一个已开的浏览器（环境变量 CDP_PORT，默认真实壳的 9245，
// 与 playwrigh MCP 的浏览器二选一）。校验页由本脚本自起的静态服务提供。
const CDP_PORT = Number(process.env.CDP_PORT ?? 9245);
const list = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`, { dispatcher: undefined })
  .then(r => r.json()).catch(() => null);
const target = list?.find(t => t.type === "page");
if (!target) {
  console.error(`CDP ${CDP_PORT} 无可用页面。先起壳（--remote-debug-port）或设 CDP_PORT。`);
  server.close(); process.exit(2);
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
let seq = 0; const waiting = new Map();
ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); } });
await new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", rej); });
const send = (method, params = {}) => new Promise((res) => { const id = ++seq; waiting.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1226, height: 800, deviceScaleFactor: 1, mobile: false });
await send("Page.navigate", { url: `http://127.0.0.1:${PORT}/index.html` });
await new Promise(r => setTimeout(r, 2500));

const evalJs = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  return r.result?.result?.value;
};
const result = await evalJs(`(() => {
  const B = (s) => {
    const e = document.querySelector(s);
    if (!e) return null;
    const b = e.getBoundingClientRect();
    return { x: Math.round(b.x), y: Math.round(b.y), r: Math.round(b.right), b: Math.round(b.bottom), w: Math.round(b.width) };
  };
  const ov = (a, b) => {
    if (!a || !b) return { overlaps: false, area: 0 };
    const ix = Math.max(0, Math.min(a.r, b.r) - Math.max(a.x, b.x));
    const iy = Math.max(0, Math.min(a.b, b.b) - Math.max(a.y, b.y));
    return { overlaps: ix > 0 && iy > 0, area: ix * iy, overlapX: ix, overlapY: iy };
  };
  // ① 主条内元素溢出检测
  const bar = document.querySelector("#player-bar .pb-main");
  const overflow = [];
  if (bar) {
    const rb = bar.getBoundingClientRect();
    for (const c of bar.querySelectorAll("*")) {
      const cb = c.getBoundingClientRect();
      if (cb.width > 0 && cb.right > rb.right + 1)
        overflow.push({ cls: (c.className || c.tagName).toString().slice(0, 36), over: Math.round(cb.right - rb.right) });
    }
  }
  const spec = B(".pb-spectrum"), powered = B(".powered"), footer = B(".system-footer"), pb = B("#player-bar");
  const dc = document.querySelector("#detail-content");
  return {
    vw: innerWidth,
    overflow,
    specVSbar: ov(spec, pb),
    poweredVSbar: ov(powered, pb),
    footerVSbar: ov(footer, pb),
    poweredVSfooter: ov(powered, footer),
    detailContentMaxH: dc ? getComputedStyle(dc).maxHeight : null,
    detailOverflowY: dc ? getComputedStyle(dc).overflowY : null,
  };
})()`);

ws.close();
server.close();

let fail = 0;
const check = (ok, name, extra = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${extra ? "  " + extra : ""}`);
  if (!ok) fail++;
};

check(result.overflow.length === 0, "播放条内无元素溢出主条", result.overflow.length ? JSON.stringify(result.overflow) : "");
check(!result.specVSbar.overlaps, "频谱不压播放条", `overlapY=${result.specVSbar.overlapY ?? 0}`);
check(!result.poweredVSbar.overlaps, "品牌行(POWERED BY)不压播放条", `overlapY=${result.poweredVSbar.overlapY ?? 0}`);
check(!result.footerVSbar.overlaps, "系统页脚不压播放条", `overlapY=${result.footerVSbar.overlapY ?? 0}`);
check(!result.poweredVSfooter.overlaps, "品牌行不压系统页脚", `overlapY=${result.poweredVSfooter.overlapY ?? 0}`);
check(result.detailOverflowY === "auto", "详情内容可滚动", `overflow-y=${result.detailOverflowY}`);
check(result.detailContentMaxH !== "none" && result.detailContentMaxH !== null, "详情内容有限高", `max-height=${result.detailContentMaxH}`);

if (fail === 0) { console.log("PLAYER-LAYOUT-PASS"); process.exit(0); }
console.log(`PLAYER-LAYOUT-FAIL (${fail})`);
process.exit(1);
