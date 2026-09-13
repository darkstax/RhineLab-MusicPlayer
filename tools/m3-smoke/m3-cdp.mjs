/* eslint-disable no-undef */
/**
 * M3 验收 4 的 CDP 取证助手（也被 smtc-check.ps1 复用发 play 指令）。
 * 连 WebView2 的 --remote-debugging-port（GOAL-AUTONOMY §3 三坑之一：node 要 NO_PROXY='*'，
 * 由外层 ps1 注入），在页面里执行断言/动作并输出 JSON 到 stdout。
 *
 * 用法：node m3-cdp.mjs <port> <mode> [args...]
 *   参数也可经 **args-file** 传：首参为 `@<path>` 时从该 JSON 数组文件读全部参数
 *   （接管修正：PowerShell → wsl.exe → bash 三层引号/编码下，含中文与空格的
 *   track_id 会被拆词/乱码；文件传参完全无损）。
 *   play <trackId>          页面内 bridge.call("engine.play",{track_id}) → 输出 ack 概要
 *   state                   输出 __rhinePlayer.snapshot()
 *   bars                    微型频谱条 16 根 scaleY 采样（两次间隔 120ms）
 *   spectrum                __rhineSpectrum.frames()/subscribed/last() 概要
 *   shot <file>             播放条区域截图（验收 4 证据图）
 *   errors                  累计 pageerror/console.error（自 attach 起）
 */
const PW = process.env.RHINE_PW_CORE ?? "/tmp/pwtest/node_modules/playwright-core/index.mjs";
import { readFile } from "node:fs/promises";
const { chromium } = await import(PW);

const [, , firstArg, ...tail] = process.argv;
const argvRest = firstArg?.startsWith("@")
  ? JSON.parse(await readFile(firstArg.slice(1), "utf8")).map(String)
  : [firstArg, ...tail];
const port = Number(argvRest[0]);
const mode = argvRest[1];
const rest = argvRest.slice(2);
if (!port || !mode) {
  console.error("usage: node m3-cdp.mjs <port> <mode> [args...]  (or @args.json)");
  process.exit(2);
}

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 20000 });
const context = browser.contexts()[0];
const page =
  context.pages().find((p) => p.url().includes("app.rhine.local") || p.url().includes("127.0.0.1")) ??
  context.pages()[0];

const errors = [];
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(`console.error: ${m.text()}`);
});

const out = (value) => console.log(JSON.stringify(value));

switch (mode) {
  case "play": {
    const trackId = rest[0] ?? "X-001";
    const result = await page.evaluate(async (id) => {
      try {
        const ack = await window.__rhineBridge.call("engine.play", { track_id: id }, 8000);
        return { ok: true, ack };
      } catch (error) {
        return { ok: false, code: error.code, message: error.message };
      }
    }, trackId);
    out(result);
    break;
  }
  case "state":
    out(await page.evaluate(() => window.__rhinePlayer?.snapshot() ?? null));
    break;
  case "spectrum":
    out(
      await page.evaluate(() => {
        const s = window.__rhineSpectrum;
        if (!s) return { present: false };
        const last = s.last();
        return {
          present: true,
          frames: s.frames(),
          subscribed: s.subscribed(),
          last: last
            ? {
                activity: last.activity,
                low: last.low,
                mid: last.mid,
                high: last.high,
                beatPhase: last.beatPhase,
                l0: last.bandsL[0],
                r0: last.bandsR[0],
                ageMs: Math.round(performance.now() - last.receivedAt),
              }
            : null,
        };
      }),
    );
    break;
  case "bars": {
    const sample = async () =>
      page.evaluate(() =>
        Array.from(document.querySelectorAll("#player-bar .pb-spectrum i")).map((bar) => {
          const match = /scaleY\(([\d.]+)\)/.exec(bar.style.transform ?? "");
          return match ? Number(match[1]) : 0;
        }),
      );
    const a = await sample();
    await new Promise((r) => setTimeout(r, 120));
    const b = await sample();
    out({ first: a, second: b, active: await page.evaluate(() => document.querySelector("#player-bar .pb-spectrum")?.dataset.active ?? null) });
    break;
  }
  case "shot": {
    const file = rest[0] ?? "m3-player-bar.png";
    await page.waitForSelector("#player-bar .pb-spectrum i", { timeout: 10000 });
    const bar = page.locator("#player-bar");
    await bar.screenshot({ path: file });
    out({ shot: file, ok: true });
    break;
  }
  case "errors":
    out({ errors });
    break;
  default:
    console.error(`unknown mode ${mode}`);
    process.exit(2);
}

await browser.close();
process.exit(0);
