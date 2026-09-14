// M5a 曲库消费层 web 模式静默降级单测（node --test，无 DOM）：
// node 环境无 window.chrome.webview → bridge.desktop=false → libraryStore 全程
// available=false：init/查询/扫描/stats 零异常、零网络帧、播放动作落 playerStore
// 本地假引擎（web 回退），任务书「web 模式零异常」的自动化覆盖。
// 运行：node --test --unhandled-rejections=strict src/player/library/library-store.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { libraryStore, coverUrl } from "./library-store.ts";

test("web 模式：init/查询/扫描/stats 全程静默零异常", async () => {
  await libraryStore.init(); // bridge 缺席：握手返回 desktop=false，立即 return
  assert.equal(libraryStore.state.available, false);
  await libraryStore.runQuery("岁月");
  await libraryStore.scan(true);
  await libraryStore.refreshStats();
  const st = libraryStore.state;
  assert.deepEqual(st.tracks, { total: 0, items: [] });
  assert.equal(st.busy, false);
  assert.equal(st.error, null);
  assert.equal(st.stats.tracks, 0);
});

test("订阅可拿快照且退订不抛", () => {
  let seen = 0;
  const off = libraryStore.subscribe(() => seen++);
  assert.ok(seen >= 1, "subscribe 立即回一帧");
  off();
  assert.doesNotThrow(() => off());
});

test("playTrack 走 lib:<id>（委托 seam；注入替身断言 id/duration）", () => {
  const calls = [];
  libraryStore.setPlayDelegate((trackId, durationMs) => calls.push([trackId, durationMs]));
  libraryStore.playTrack({
    id: 42,
    title: "岁月如歌",
    artist: null,
    album: null,
    genre: null,
    year: null,
    track_no: null,
    disc_no: null,
    duration_ms: 123000,
    codec: null,
    sample_rate: null,
    bit_depth: null,
    channels: null,
    bitrate: null,
    cover_key: null,
    lyric_state: "none",
    path: null,
  });
  assert.deepEqual(calls, [["lib:42", 123000]]);
  libraryStore.setPlayDelegate(null);
});

test("coverUrl：sha1 key → 虚拟主机 URL（冒号换横杠），非 key → null", () => {
  assert.equal(
    coverUrl("sha1:0123abcd"),
    "https://cover.rhine.local/sha1-0123abcd.jpg",
  );
  assert.equal(coverUrl(null), null);
  assert.equal(coverUrl("md5:xxx"), null);
});
