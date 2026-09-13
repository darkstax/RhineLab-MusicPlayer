/* eslint-disable no-undef */
/**
 * M3 验收 3 的 CDP 小助手：连壳内页面，经真桥发 engine.play（模拟用户选曲动作，
 * 走完整 前端→壳→核心 链路）。用法：node cdp-play.mjs <port> <track_id>
 * 环境纪律：node 走 NO_PROXY='*'（GOAL-AUTONOMY §3 坑③），由外层 ps1 注入。
 */
const PW = process.env.RHINE_PW_CORE ?? "/tmp/pwtest/node_modules/playwright-core/index.mjs";
const { chromium } = await import(PW);

const [, , portArg, trackId] = process.argv;
const port = Number(portArg);
if (!port || !trackId) {
  console.error("usage: node cdp-play.mjs <port> <track_id>");
  process.exit(2);
}

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 20000 });
const context = browser.contexts()[0];
const page = context.pages().find((p) => p.url().includes("app.rhine.local")) ?? context.pages()[0];

const result = await page.evaluate(async (id) => {
  try {
    const ack = await window.__rhineBridge.call("engine.play", { track_id: id }, 8000);
    return { ok: true, ack };
  } catch (error) {
    return { ok: false, code: error.code, message: error.message };
  }
}, trackId);
console.log(JSON.stringify(result));
await browser.close();
process.exit(result.ok ? 0 : 1);
