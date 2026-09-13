// M5b 歌词面板静默降级单测（node --test，无 DOM）：
// desktop 面验收要求的「lyric.show 在桥缺席时静默」的自动化覆盖——
// node 环境无 window.chrome.webview → bridge.desktop=false → call 恒 reject not_desktop，
// LyricView 必须吞掉异常、置位 bridgeAbsentSilent、不产生 unhandledRejection。
// 运行：node --test --unhandled-rejections=strict src/player/lyrics/lyric-view.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { LyricView } from "./lyric-view.ts";

const LRC = "[00:02.00]第一句 原文\n[00:02.10]First line translated\n[00:06.00]尾句";

test("web/桥缺席：setText+setPosition 静默（not_desktop 被吞，零异常）", async () => {
  const view = new LyricView(); // node 下 mountDom 自动跳过（typeof document === undefined）
  view.setText(LRC);
  view.setPosition(2500);
  await new Promise((r) => setTimeout(r, 10)); // 等 promise rejection 的微任务
  const st = view.stats();
  assert.equal(st.lineCount, 3);
  assert.equal(st.activeIndex, 1, "二分到译文行");
  assert.deepEqual(st.lastLyricShown, { primary: "第一句 原文", secondary: "First line translated" });
  assert.equal(st.bridgeAbsentSilent, true, "桥缺席标记置位");
  assert.equal(st.mounted, false, "node 下不触 DOM 不崩");
});

test("行未变化不重发；clear 发空串清除帧", async () => {
  const view = new LyricView();
  view.setText(LRC);
  view.setPosition(2500);
  view.setPosition(3000); // 同一行 → 去重
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(view.stats().lyricShownCalls, 1, "同内容不重发");
  view.clear();
  await new Promise((r) => setTimeout(r, 10));
  const st = view.stats();
  assert.equal(st.lyricShownCalls, 2);
  assert.deepEqual(st.lastLyricShown, { primary: "", secondary: "" }, "清除帧=空串（协议 §5）");
  assert.equal(st.activeIndex, -1);
});

test("无歌词时 clear 幂等静默；setText(null) 回到空态", async () => {
  const view = new LyricView();
  view.clear(); // 从未上行：lastSent 为空 → 不发清除帧
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(view.stats().lyricShownCalls, 0);
  view.setText(LRC);
  view.setPosition(1000); // 首行前 → 空对空去重
  assert.equal(view.stats().lyricShownCalls, 0);
  view.setText(null);
  assert.equal(view.stats().lineCount, 0);
});
