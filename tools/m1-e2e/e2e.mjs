/* eslint-disable no-undef */
/**
 * M1 验收 3/4 + 桌面播放链路的无人值守 E2E：
 * 通过 WebView2 CDP（壳以 WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port 启动，
 * WSL mirrored 网络下 127.0.0.1:9223 直达）连进壳内页面，驱动真实播放条与桥，
 * 断言 = 页面快照（__rhinePlayer）+ 桥诊断（__rhineBridge.diagnostics()）+ 壳日志（由外层脚本 grep）。
 *
 * 前置（m1-e2e.ps1 负责）：
 *   stub --halt-events 25（握手后 25s 暂停 evt 输出，制造可检测丢帧）
 *   shell  --remote-debug-port 9223
 *
 * 用法：node /tmp/m1-e2e.mjs（playwright-core 在 /tmp/pwtest，M0 同套路，不入库）
 */
const PW = process.env.RHINE_PW_CORE ?? "/tmp/pwtest/node_modules/playwright-core/index.mjs";
const { chromium } = await import(PW);

const results = [];
let failures = 0;
function check(label, ok, detail = "") {
  results.push(`[${ok ? "PASS" : "FAIL"}] ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const browser = await chromium.connectOverCDP("http://127.0.0.1:9223", { timeout: 15000 });
const context = browser.contexts()[0];
const page =
  context.pages().find((p) => p.url().includes("app.rhine.local")) ?? context.pages()[0];

const errors = [];
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(`console.error: ${m.text()}`);
});

const snapshot = () => page.evaluate(() => window.__rhinePlayer?.snapshot() ?? null);
const diag = () => page.evaluate(() => window.__rhineBridge?.diagnostics() ?? null);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

await page.waitForFunction(
  () =>
    document.getElementById("player-bar")?.dataset.mounted === "1" &&
    !!document.querySelector("#player-bar .pb-main") &&
    !!window.__rhineBridge &&
    !!window.__rhinePlayer,
  null,
  { timeout: 30000 },
);

// ---------- 挂载与环境 ----------
check("播放条挂载 + 诊断入口存在", true);
check("M0 自检面板已消失", await page.evaluate(() => !document.getElementById("m0-selfcheck")));
const env = await page.evaluate(() => ({ desktop: window.__rhineBridge.desktop }));
check("桌面环境检测 desktop=true", env.desktop === true);
const hello = await page.evaluate(async () => {
  const h = await window.__rhineBridge.handshake();
  return { ok: h.ok, state: h.state, coreCaps: h.core?.caps ?? null, coreEp: h.core?.ep ?? null, ep: h.ep };
});
check("握手 ok 且壳通道 ready", hello.ok === true && hello.state === "ready", JSON.stringify(hello));
check("核心 hello 快照含 engine.* caps", Array.isArray(hello.coreCaps) && hello.coreCaps.includes("engine.play"));
check("核心 hello 携带会话世代 ep（v1.2 经壳透传）", typeof hello.coreEp === "number", `ep=${hello.coreEp}`);

// ---------- 播放（真 IPC；播放条的"手输档案号 + LOAD"已删除，改由桥直接下发同一命令） ----------
// 页面是 dist 产物（app.rhine.local 虚拟主机），拿不到 /src 模块路径，故这里只验 IPC 链路本身；
// 播放条的点击路径（专辑行 → playQueue → engine.play）由 web 降级脚本与人工验收覆盖。
await page.evaluate(() =>
  window.__rhineBridge.call("engine.play", { track_id: "X-007", duration_ms: 180000 }),
);
await page.waitForFunction(() => {
  const s = window.__rhinePlayer?.snapshot();
  return s && s.trackId === "X-007" && s.state === "playing" && s.engine === "desktop";
}, null, { timeout: 15000 });
let s = await snapshot();
check("engine.play 经真 IPC 进入 playing（engine=desktop）", true, `pos=${s.positionMs}`);
check("徽章显示 M1 · stub engine 占位",
  (await page.textContent("#player-bar .pb-badges"))?.includes("M1 · stub engine"));

const posA = s.positionMs;
// 桩处于 --halt-events 窗口时 tick 帧被吞（seq 照烧）；等到可见帧恢复再断言推进。
await page.waitForFunction((min) => (window.__rhinePlayer?.snapshot().positionMs ?? 0) > min + 2000, posA, { timeout: 40000 });
s = await snapshot();
check("position 持续推进（含 halt 窗口恢复）", s.positionMs > posA + 2000, `${posA} → ${s.positionMs}`);
check("UI mm:ss 同步（进度时间非 00:00）", (await page.textContent("#player-bar .pb-pos")) !== "00:00");

// ---------- pause / resume ----------
await page.click("#player-bar .pb-toggle");
await page.waitForFunction(() => window.__rhinePlayer?.snapshot().state === "paused", null, { timeout: 15000 });
const pausedPos = (await snapshot()).positionMs;
await wait(2600);
s = await snapshot();
check("pause 冻结位置", Math.abs(s.positionMs - pausedPos) < 1500 && s.state === "paused", `${pausedPos} → ${s.positionMs}`);
await page.click("#player-bar .pb-toggle");
await page.waitForFunction(() => window.__rhinePlayer?.snapshot().state === "playing", null, { timeout: 15000 });
await wait(2600);
s = await snapshot();
check("toggle 恢复后续播", s.positionMs > pausedPos + 1000, `${pausedPos} → ${s.positionMs}`);

// ---------- seek（点击进度条 25% 处） ----------
{
  const box = await page.locator("#player-bar .pb-progress").boundingBox();
  await page.mouse.click(box.x + box.width * 0.25, box.y + box.height / 2);
  await wait(1500);
  s = await snapshot();
  const target = s.durationMs * 0.25;
  check("点击进度条 seek 跳变（±4s）", Math.abs(s.positionMs - target) < 4000, `pos=${Math.round(s.positionMs)} target=${Math.round(target)}`);
}

// ---------- volume（引擎只存值；重连后由 ack+快照收敛） ----------
await page.evaluate(() => {
  const input = document.querySelector("#player-bar .pb-volume input");
  input.value = "0.4";
  input.dispatchEvent(new Event("input", { bubbles: true }));
});
await page.waitForFunction(() => window.__rhinePlayer?.snapshot().volume === 0.4, null, { timeout: 15000 });
check("engine.volume 0.4 生效（bridge→桩 ack/快照）", true);

// ---------- 丢帧检测（桩握手时 --halt-events 25 已布防：窗口内 seq 照烧、帧不发） ----------
const t0 = Date.now();
let d = null;
while (Date.now() - t0 < 30000) {
  d = await diag();
  if (d && d.framesLost > 0) break;
  await wait(1500);
}
check("桩 --halt-events 制造丢帧 → bridge diagnostics.framesLost>0",
  d !== null && d.framesLost > 0, JSON.stringify(d));

// ---------- keep_awake（config.set 壳侧自答 + SetThreadExecutionState；日志由外层 grep） ----------
const awake = await page.evaluate(async () => {
  const on = await window.__rhineBridge.call("config.set", { path: "desktop.keep_awake", value: true });
  const back = await window.__rhineBridge.call("config.get", { path: "desktop.keep_awake" });
  const off = await window.__rhineBridge.call("config.set", { path: "desktop.keep_awake", value: false });
  const audio = await window.__rhineBridge.call("config.set", { path: "audio.music", value: 0.55 });
  return { on, back, off, audio };
});
check("config.set desktop.keep_awake=true 回值 true", awake.on?.value === true, JSON.stringify(awake.on));
check("config.get 回读 true", awake.back?.value === true);
check("config.set 回 false（释放，不留系统状态）", awake.off?.value === false);
check("config.set audio.music=0.55 持久化回值", awake.audio?.value === 0.55);

// ---------- 错误链路（evt.error / err 的 toast） ----------
const errResult = await page.evaluate(async () => {
  try {
    await window.__rhineBridge.call("devices.list", {});
    return "resolved?!";
  } catch (error) {
    return `${error.code}`;
  }
});
check("未实现 cmd 回 not_implemented（M3 前保持现状）", errResult === "not_implemented", String(errResult));

// ---------- 前端报错 ----------
const upstreamErrors = errors.filter((e) => !e.includes("favicon"));
check("E2E 全程 pageerror=0 / console.error=0", upstreamErrors.length === 0, upstreamErrors.slice(0, 3).join(" | "));

console.log(results.join("\n"));
console.log(`M1 desktop e2e: ${failures === 0 ? "ALL PASS" : `${failures} FAILURES`}`);
await browser.close();
process.exit(failures === 0 ? 0 : 1);
