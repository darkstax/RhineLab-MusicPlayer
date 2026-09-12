/* M1 验收 5：web 降级（npm run dev，非 WebView2）。headless chromium 复用 M0 缓存的
   chromium_headless_shell + /tmp/pwtest 的 playwright-core（playwright MCP 当时不可用，同套路）。
   断言：player-bar 正常显示并可播放（假引擎 engine=local）、M0 面板消失、pageerror=0 console.error=0。 */
const PW = process.env.RHINE_PW_CORE ?? "/tmp/pwtest/node_modules/playwright-core/index.mjs";
const { chromium } = await import(PW);

const exe =
  "/home/starl/.cache/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-linux64/chrome-headless-shell";

const results = [];
let failures = 0;
const check = (label, ok, detail = "") => {
  results.push(`[${ok ? "PASS" : "FAIL"}] ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

const browser = await chromium.launch({
  executablePath: exe,
  args: ["--no-sandbox", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--disable-gpu-sandbox"],
});
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(`console.error: ${m.text()}`);
});

await page.goto("http://127.0.0.1:5201/", { waitUntil: "domcontentloaded" });

// player-bar 由 m1-mount 异步挂载；等 store 快照可用。
await page.waitForFunction(() => !!window.__rhinePlayer && !!document.querySelector("#player-bar .pb-main"), null, { timeout: 20000 });
check("web：player-bar 已挂载且可见", await page.evaluate(() => {
  const bar = document.getElementById("player-bar");
  return !!bar && !bar.hidden && getComputedStyle(bar).display !== "none";
}));

// web 桥是 no-op：desktop=false，store 走假引擎（engine=local）。
check("web：M0 自检面板已消失", await page.evaluate(() => !document.getElementById("m0-selfcheck")));
check("web：desktop=false（假引擎回退）", await page.evaluate(() => window.__rhinePlayer.snapshot().engine === "local"));
check("web：初始 state=idle", await page.evaluate(() => window.__rhinePlayer.snapshot().state === "idle"));

// 手输档案号 LOAD → 假引擎播放（engine=local，无 IPC）。
await page.evaluate(() => {
  const input = document.querySelector("#player-bar .pb-id");
  input.value = "X-042";
});
await page.evaluate(() => document.querySelector("#player-bar .pb-play-btn").click());
await page.waitForFunction(() => window.__rhinePlayer.snapshot().state === "playing", null, { timeout: 8000 });
let snap = await page.evaluate(() => window.__rhinePlayer.snapshot());
check("web：假引擎播放 engine=local", snap.engine === "local" && snap.state === "playing", JSON.stringify({ engine: snap.engine, state: snap.state, trackId: snap.trackId }));

// 假引擎 position 推进（本地 setInterval 1Hz）。
const p0 = snap.positionMs;
await new Promise((r) => setTimeout(r, 2300));
snap = await page.evaluate(() => window.__rhinePlayer.snapshot());
check("web：假引擎 position 推进", snap.positionMs > p0, `${p0} → ${snap.positionMs}`);

// toggle 暂停（假引擎）。
await page.evaluate(() => document.querySelector("#player-bar .pb-toggle").click());
await new Promise((r) => setTimeout(r, 300));
check("web：假引擎 toggle→paused", (await page.evaluate(() => window.__rhinePlayer.snapshot().state)) === "paused");

// 徽章占位在假引擎下同样显示 negotiated=null → stub。
check("web：徽章显示 stub 占位", (await page.textContent("#player-bar .pb-badges"))?.includes("M1 · stub engine"));

const clean = errors.filter((e) => !/favicon|Download the Vue Devtools|axe/i.test(e));
check("web：pageerror=0 / console.error=0", clean.length === 0, clean.slice(0, 4).join(" | "));

console.log(results.join("\n"));
console.log(`M1 web e2e: ${failures === 0 ? "ALL PASS" : `${failures} FAILURES`}`);
await browser.close();
process.exit(failures === 0 ? 0 : 1);
