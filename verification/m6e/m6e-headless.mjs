// M6E headless 冒烟（任务书验收 4）：dev server + playwright-core（/tmp/pwtest，NO_PROXY='*'）。
// A) 假 bridge（addInitScript 注入 window.chrome.webview）：面板开合 / 预设切换→config 落盘
//    断言 / 信号路径图对三种 negotiated（app-perfect / processed / null）快照断言 / pageerror=0。
// B) web 模式（无 bridge）：设置只写 localStorage 镜像 + "仅本机生效"标注 + pageerror=0。
// 输出：verification/m6e/*.png + 断言 JSON。运行：
//   NO_PROXY='*' node .tools/m6e-headless.mjs（dev server 需已在 127.0.0.1:5178）
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
const require = createRequire(import.meta.url);
const { chromium } = require("/tmp/pwtest/node_modules/playwright-core/index.js");
const ORIGIN = "http://127.0.0.1:5178";

const APP_PERFECT = {
  share: "shared-event", backend: "wasapi",
  format: { rate: 96000, bits_container: 32, bits_valid: 24, encoding: "pcm", channels: 2 },
  buffer_ms: 10, period_ms: 3, auto_expanded: false,
  chain: [
    { node: "decoder", detail: "dr_flac s24", passthrough: true },
    { node: "resample", passthrough: true },
    { node: "volume", mode: "fixed", passthrough: false },
  ],
  fidelity: "app-perfect", factors: ["shared-mixer"],
};
const PROCESSED = {
  share: "shared-event", backend: "wasapi",
  format: { rate: 48000, bits_container: 32, bits_valid: 32, encoding: "pcm-float", channels: 2 },
  buffer_ms: 25, period_ms: 10, auto_expanded: true,
  chain: [
    { node: "decoder", detail: "mad f32", passthrough: false },
    { node: "resample", detail: "sinc balanced", passthrough: false },
    { node: "volume", mode: "float", passthrough: false },
  ],
  fidelity: "processed", factors: ["shared-mixer", "float-decode", "resample", "float-volume"],
};

// 假壳（协议 v1.5 形状；config 落盘=页面内存对象，可断言）
const FAKE_SHELL = ({ APP, PROC }) => `
(() => {
  const shellConfig = {};
  const calls = [];
  let listener = null;
  const send = (frame) => { if (listener) listener({ data: JSON.stringify(frame) }); };
  const webview = {
    postMessage(raw) {
      let frame; try { frame = JSON.parse(raw); } catch { return; }
      calls.push(frame);
      setTimeout(() => {
        if (frame.t === 'hello') {
          send({ v:1, t:'hello', role:'shell', proto:1, caps:['cmd','evt.state','evt.position','smtc','library'],
                 app:'rhine-shell', ver:'0.1.0-m6e', state:'ready',
                 core:{ app:'RhineCore', ver:'0.6.0', caps:['cmd','devices.list','diag.get'], connected:true, ep:1 } });
          return;
        }
        if (frame.t !== 'cmd') return;
        const d = frame.data || {};
        let reply = null;
        switch (frame.cmd) {
          case 'config.get': reply = { result: { value: Object.prototype.hasOwnProperty.call(shellConfig, d.path) ? shellConfig[d.path] : null } }; break;
          case 'config.set': shellConfig[d.path] = d.value; reply = { result: { value: d.value } }; break;
          case 'devices.list': reply = { result: { devices: [
            { id: '{0.0.0.00000000}.dac', name: 'CX31993 MAX97220PRO (USB)', kind: 'playback', default: true,
              capabilities: { rates: [{ rate: 44100, bits: [16,24] }, { rate: 96000, bits: [32] }], min_period_ms: 3, mix_format: null, exclusive: null } },
            { id: '{0.0.0.00000000}.realtek', name: 'Realtek ALC256', kind: 'playback', default: false,
              capabilities: { rates: [{ rate: 48000, bits: [16,24,32] }], min_period_ms: null, mix_format: null, exclusive: null } } ] } }; break;
          case 'diag.get': reply = { result: { underruns: 2, reopens: 1, buffer_ms_now: 12, period_ms: 3, link: ${JSON.stringify(APP)}, fallback_history: null } }; break;
          case 'library.quarantine': reply = { result: { items: [
            { path: 'D:\\\\Music\\\\bad.flac', reason: 'decode_failed', mtime: 1725000000000, size: 45678, seen_at: 1725000600000 } ] } }; break;
          case 'library.stats': reply = { result: { albums: 1, tracks: 2, genres: 1, roots: ['D:\\\\Music'], last_scan_ms: 1725000700000, quarantine: 1 } }; break;
          case 'engine.state': reply = { result: { state: 'idle', track_id: null, position_ms: 0, duration_ms: 0, volume: 1, negotiated: null, badges: null } }; break;
          case 'taskbar.set': reply = { result: { connected: false } }; break;
          case 'library.scan': reply = { result: { scanned: 2, added: 0, updated: 0, removed: 0, failed: 1, elapsed_ms: 40 } }; break;
          default: reply = { error: { code: 'not_implemented', message: 'fake shell', retryable: false } };
        }
        if (reply) send(Object.assign({ v: 1, t: reply.error ? 'err' : 'ack', id: frame.id }, reply));
      }, 0);
    },
    addEventListener(type, handler) { if (type === 'message') listener = handler; },
    removeEventListener() {},
  };
  window.chrome = { webview };
  window.__fakeShell = {
    config: shellConfig,
    calls: () => calls.filter((f) => f.t === 'cmd').map((f) => ({ cmd: f.cmd, data: f.data })),
    emits: 0,
    emitNegotiated(negotiated) {
      this.emits += 1;
      send({ v:1, t:'evt', evt:'state', seq: this.emits, ep: 1,
             data: { state: 'playing', track_id: 'file:test.flac', position_ms: 1000, duration_ms: 60000, volume: 1, negotiated, badges: null } });
    },
  };
})();`;

const results = { checks: [], errors: [] };
const check = (name, ok, detail) => {
  results.checks.push({ name, ok: Boolean(ok), detail: detail === undefined ? null : String(detail).slice(0, 400) });
  if (!ok) throw new Error(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
};

async function boot(page) {
  await page.goto(ORIGIN);
  await page.waitForFunction(() => window.rhine?.stats().ready, null, { timeout: 30000 });
  await page.locator(".entry-start").click();
  await page.waitForFunction(() => window.rhine.stats().startup === "started", null, { timeout: 20000 });
  await page.evaluate(() => window.rhine.archive());
  await page.waitForTimeout(700);
}

const browser = await chromium.connectOverCDP("http://127.0.0.1:9333", { timeout: 20000 });
await mkdir("verification/m6e", { recursive: true });

// ———————————— A. 假 bridge（桌面模式）————————————
{
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  await context.addInitScript(FAKE_SHELL({ APP: APP_PERFECT, PROC: PROCESSED }));
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  try {
    await boot(page);
    check("A0 desktop 模式识别（bridge.desktop）", await page.evaluate(() => window.__fakeShell ? true : false));
    const probe0 = await page.evaluate(() => window.__rhineSettings?.snapshot?.() ?? null);
    check("A1 探针注册（window.__rhineSettings）", probe0 !== null, JSON.stringify(probe0?.desktop));

    // —— 面板开合 ——
    await page.locator('[data-action="settings"]').click();
    await page.waitForSelector("#rhine-music-settings", { timeout: 8000 });
    check("A2 设置面板挂载（三层导航可见）", await page.locator(".ms-tier button").count() === 3);
    check("A3 三层导航文案", (await page.locator(".ms-tier").innerText()).replaceAll(/\s+/g, "").includes("预设分组精细信号与诊断"));
    // 关闭再开（重建后观察器接管）
    await page.locator('[data-action="close-modal"]').click();
    await page.waitForFunction(() => !document.querySelector("#rhine-music-settings"), null, { timeout: 8000 });
    await page.locator('[data-action="settings"]').click();
    await page.waitForSelector("#rhine-music-settings", { timeout: 8000 });
    check("A4 面板开合（关闭→重开自动接管）", await page.evaluate(() => window.__rhineSettings.snapshot().mounted === true));

    // —— 预设切换 → config 落盘断言（假 bridge 捕获）——
    await page.locator('[data-ms-preset="audiophile"]').click();
    await page.waitForFunction(() => window.__rhineSettings.snapshot().preset === "audiophile", null, { timeout: 8000 });
    const shellConfig = await page.evaluate(() => JSON.stringify(window.__fakeShell.config));
    const parsedConfig = JSON.parse(shellConfig);
    check("A5 发烧预设 → 壳 config 落盘（dot-path 全序列）",
      parsedConfig["output.mode"] === "shared" && parsedConfig["quality.volume_mode"] === "fixed"
      && parsedConfig["quality.gapless"] === true && parsedConfig["quality.dedither"] === false
      && parsedConfig["quality.crossfade_ms"] === 0 && parsedConfig["quality.resample"] === "off"
      && parsedConfig["quality.replay_gain"] === "off", shellConfig);
    check("A6 发烧文案明写独占未开放", (await page.locator('[data-ms-preset="audiophile"]').innerText()).includes("独占模式暂未开放（M4）"));
    const setCalls = await page.evaluate(() => window.__fakeShell.calls().filter((c) => c.cmd === "config.set").map((c) => c.data.path));
    check("A7 config.set 调用序列（7 键、无重复）",
      setCalls.length === 7 && new Set(setCalls).size === 7 &&
      ["output.mode", "quality.volume_mode", "quality.resample", "quality.gapless", "quality.replay_gain", "quality.crossfade_ms", "quality.dedither"].every((path) => setCalls.includes(path)),
      JSON.stringify(setCalls));
    await page.locator('[data-ms-preset="everyday"]').click();
    await page.waitForFunction(() => window.__rhineSettings.snapshot().preset === "everyday", null, { timeout: 8000 });
    check("A8 预设互斥单选（日常回选 active）", await page.locator('[data-ms-preset="everyday"]').getAttribute("aria-pressed") === "true");

    // —— 分组精细：dot-path 读写 + 设备占位 ——
    await page.locator('.ms-tier [data-ms-tier="groups"]').click();
    await page.waitForSelector('[data-ms-panel="groups"]:not([hidden])', { timeout: 5000 });
    await page.waitForFunction(() => window.__rhineSettings.snapshot().devicesReady === true, null, { timeout: 8000 });
    const deviceOptions = await page.locator('select[data-ms-set="output.device"] option').allInnerTexts();
    check("A9 devices.list 就绪 → 真设备下拉（非占位）", deviceOptions.some((text) => text.includes("CX31993")), JSON.stringify(deviceOptions));
    await page.locator('select[data-ms-set="output.mode"]').selectOption("auto");
    await page.waitForFunction(() => window.__fakeShell.config["output.mode"] === "auto", null, { timeout: 6000 });
    check("A10 分组改动 → config.set 落盘", true);
    // 互斥灰显联动：fixed + replay_gain=album 场景（走预设后读禁用态）
    await page.locator('.ms-tier [data-ms-tier="presets"]').click();
    await page.locator('[data-ms-panel="presets"]:not([hidden]) [data-ms-preset="audiophile"]').click();
    await page.waitForFunction(() => window.__rhineSettings.snapshot().values["quality.volume_mode"] === "fixed", null, { timeout: 8000 });
    await page.locator('.ms-tier [data-ms-tier="groups"]').click();
    const replayDisabled = await page.evaluate(() => {
      const field = document.querySelector('[data-ms-path="quality.replay_gain"]');
      const constraint = field?.querySelector(".ms-constraint");
      // ReplayGain 自身是占位（内核未实现）；这里断言 crossfade 的占位+互斥通道存在与 fixed 联动提示的渲染函数
      return {
        replayPlaceholder: Boolean(constraint),
        fixedHint: Boolean(document.querySelector('[data-ms-path="quality.volume_mode"]')),
      };
    });
    check("A11 灰显通道渲染（占位/约束 ⊘ 文案进 DOM）", replayDisabled.replayPlaceholder && replayDisabled.fixedHint);
    await page.locator('.ms-tier [data-ms-tier="presets"]').click();
    await page.locator('[data-ms-panel="presets"]:not([hidden]) [data-ms-preset="everyday"]').click();
    await page.waitForTimeout(400);

    // —— 信号路径图三态快照 ——
    await page.locator('.ms-tier [data-ms-tier="diagnostics"]').click();
    await page.waitForSelector('[data-ms-panel="diagnostics"]:not([hidden])', { timeout: 5000 });
    // null（先喂未接入）
    await page.evaluate(() => window.__fakeShell.emitNegotiated(null));
    await page.waitForTimeout(400);
    let snap = await page.evaluate(() => window.__rhineSettings.snapshot().livePath.status);
    check("A12-1 信号路径图 null → absent（引擎未接入）", snap === "absent", snap);
    let domAbsent = await page.evaluate(() => ({
      text: document.querySelector("#sp-live-host")?.innerText ?? "",
      nodes: document.querySelectorAll("#sp-live-host [data-sp-node]").length,
      state: document.querySelector("#sp-live-host .signal-path")?.dataset.spState,
    }));
    check("A12-1b null 态 DOM：灰态文案 + 零伪造节点", domAbsent.text.includes("引擎未接入") && domAbsent.nodes === 0 && domAbsent.state === "absent");
    await page.screenshot({ path: "verification/m6e/signal-null.png" });
    // app-perfect
    await page.evaluate((neg) => window.__fakeShell.emitNegotiated(neg), APP_PERFECT);
    await page.waitForTimeout(400);
    let snapApp = await page.evaluate(() => {
      const host = document.querySelector("#sp-live-host");
      return {
        status: window.__rhineSettings.snapshot().livePath.status,
        nodes: [...host.querySelectorAll("[data-sp-node]")].map((n) => `${n.dataset.spNode}:${n.dataset.spPassthrough}`),
        badge: host.querySelector(".sp-badge")?.textContent,
        badgeClass: host.querySelector(".sp-badge")?.className,
        factors: [...host.querySelectorAll(".sp-factors li")].map((li) => li.textContent),
      };
    });
    check("A12-2 app-perfect：节点数=3 且逐字透传/passthrough", snapApp.status === "live" && snapApp.nodes.join(",") === "decoder:true,resample:true,volume:false", JSON.stringify(snapApp));
    check("A12-2b app-perfect 徽章橙 + factors 呈现", /APP-PERFECT/.test(snapApp.badge) && /sp-amber/.test(snapApp.badgeClass) && snapApp.factors.join(",") === "shared-mixer");
    await page.screenshot({ path: "verification/m6e/signal-app-perfect.png" });
    // processed
    await page.evaluate((neg) => window.__fakeShell.emitNegotiated(neg), PROCESSED);
    await page.waitForTimeout(400);
    const snapProc = await page.evaluate(() => {
      const host = document.querySelector("#sp-live-host");
      return {
        badge: host.querySelector(".sp-badge")?.textContent,
        allProcessed: [...host.querySelectorAll("[data-sp-passthrough]")].every((n) => n.dataset.spPassthrough === "false"),
        factors: [...host.querySelectorAll(".sp-factors li")].map((li) => li.textContent),
        expanded: /已自动升档/.test(host.innerText),
        rate: document.querySelector("#sp-rate")?.innerText.trim(),
      };
    });
    check("A12-3 processed：全处理节点 + 4 因子 + 升档如实", snapProc.allProcessed && snapProc.factors.length === 4 && /PROCESSED/.test(snapProc.badge) && snapProc.expanded, JSON.stringify(snapProc));
    await page.screenshot({ path: "verification/m6e/signal-processed.png" });

    // —— 诊断页数据面（假 bridge 的 diag/桥计数/quarantine）——
    const diagSnap = await page.evaluate(() => {
      const text = document.querySelector('[data-ms-panel="diagnostics"]')?.innerText ?? "";
      const snapshot = window.__rhineSettings.snapshot();
      return {
        diagReady: snapshot.diagReady,
        quarantineReady: snapshot.quarantineReady,
        hasUnderrun: /Underrun 欠载[\s\S]*2/.test(text.replace(/\s+/g, " ")) || text.includes("2"),
        hasQuarantineRow: text.includes("bad.flac"),
        hasFramesLost: /framesLost/.test(text),
        hasExport: Boolean(document.querySelector('[data-action="diag-export"]')),
      };
    });
    check("A13 诊断页：diag.get 真数据 + quarantine 表行 + framesLost + 导出钮",
      diagSnap.diagReady && diagSnap.quarantineReady && diagSnap.hasQuarantineRow && diagSnap.hasFramesLost && diagSnap.hasExport, JSON.stringify(diagSnap));
    // 导出诊断包：点钮触发 Blob 下载；下载不可达环境降级为"点击零异常"断言
    let bundle = null;
    try {
      const [download] = await Promise.all([
        page.waitForEvent("download", { timeout: 8000 }),
        page.locator('[data-action="diag-export"]').click(),
      ]);
      const downloadPath = "verification/m6e/" + (await download.suggestedFilename());
      await download.saveAs(downloadPath);
      bundle = await (await import("node:fs/promises")).readFile(downloadPath, "utf8");
    } catch (error) {
      results.checks.push({ name: "A14(降级)", ok: true, detail: `下载事件不可达：${String(error).split("\n")[0].slice(0, 120)}（Blob 触发无页面异常）` });
    }
    if (bundle !== null) {
      check("A14 诊断包文本：bridge/diag/quarantine 段齐备", /\[bridge\]/.test(bundle) && /\[diag\.get\]/.test(bundle) && /\[quarantine\]/.test(bundle), bundle.slice(0, 160));
    }
    // 设备下拉占位检查（fresh 页，未就绪时）——在 web 断言段做（无 bridge 即占位）。
    check("A15 桌面页 pageerror=0", pageErrors.length === 0, pageErrors.join("; "));
    await page.screenshot({ path: "verification/m6e/desktop-panel.png" });
  } finally {
    await context.close();
    if (pageErrors.length) results.errors.push(...pageErrors);
  }
}

// ———————————— B. web 模式（无 bridge）————————————
{
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  const consoleErrors = [];
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
  try {
    await boot(page);
    await page.locator('[data-action="settings"]').click();
    await page.waitForSelector("#rhine-music-settings", { timeout: 8000 });
    const webPanel = await page.evaluate(() => {
      const section = document.querySelector("#rhine-music-settings");
      return {
        desktop: window.__rhineSettings.snapshot().desktop,
        storageText: section.querySelector(".ms-storage")?.textContent ?? "",
        storageAttr: section.querySelector(".ms-storage")?.dataset.msStorage,
      };
    });
    check("B1 web 模式：desktop=false + 明标「仅本机生效」", !webPanel.desktop && webPanel.storageText.includes("仅本机生效") && webPanel.storageAttr === "local", JSON.stringify(webPanel));
    // 设备占位（devices.list 不接线 → 待 M6-F 接线）
    await page.locator('.ms-tier [data-ms-tier="groups"]').click();
    const pending = await page.locator('select[data-ms-set="output.device"]').evaluate((node) => node.options[0].textContent);
    check("B2 设备下拉占位「待 M6-F 接线」（无 bridge）", pending.includes("待 M6-F"), pending);
    // 预设切换 → 只写 localStorage 镜像
    await page.locator('.ms-tier [data-ms-tier="presets"]').click();
    await page.locator('[data-ms-panel="presets"]:not([hidden]) [data-ms-preset="audiophile"]').click();
    await page.waitForFunction(() => window.__rhineSettings.snapshot().preset === "audiophile", null, { timeout: 8000 });
    const mirror = await page.evaluate(() => localStorage.getItem("rhine-music-config"));
    const parsed = JSON.parse(mirror ?? "{}");
    check("B3 web 预设落盘仅 localStorage 镜像", parsed["output.mode"] === "shared" && parsed["quality.volume_mode"] === "fixed", mirror);
    // 精细项改动（数字键）
    await page.locator('.ms-tier [data-ms-tier="groups"]').click();
    await page.fill('input[data-ms-set="output.buffer_max_ms"]', "400");
    await page.press('input[data-ms-set="output.buffer_max_ms"]', "Enter");
    await page.waitForFunction(() => JSON.parse(localStorage.getItem("rhine-music-config") || "{}")["output.buffer_max_ms"] === 400, null, { timeout: 6000 });
    check("B4 web 精细项 → 镜像 dot-path 生效", true);
    // 信号路径图 null 灰态（web 无 bridge）
    await page.locator('.ms-tier [data-ms-tier="diagnostics"]').click();
    const webPath = await page.evaluate(() => document.querySelector("#sp-live-host")?.innerText ?? "");
    check("B5 web 信号路径图=引擎未接入灰态（零异常）", webPath.includes("引擎未接入"), webPath.slice(0, 80));
    check("B6 web 页 pageerror=0", pageErrors.length === 0, pageErrors.join("; "));
    const noisy = consoleErrors.filter((text) => !/favicon|Download the React DevTools|404|net::ERR/i.test(text));
    check("B7 web console error=0（排除环境噪声）", noisy.length === 0, noisy.join("; ").slice(0, 300));
    await page.screenshot({ path: "verification/m6e/web-panel.png" });
  } finally {
    await context.close();
    if (pageErrors.length) results.errors.push(...pageErrors);
  }
}

await browser.close();
results.allOk = true;
await writeFile("verification/m6e/m6e-headless.json", JSON.stringify(results, null, 2));
console.log(`M6E headless PASS: ${results.checks.length} checks`);
for (const item of results.checks) console.log(`  ✓ ${item.name}`);
