// 播放队列 + 循环模式纯逻辑单测（node --test，无 DOM）：
// 队列构造/索引钳制、三态循环模式状态机、曲终决策（顺序停 / 专辑环绕 / 单曲重播）、
// 手动上下一首环绕、纯函数不可变性。player-store 只负责"把决策接到引擎"，决策本身在这里锁死。
// 运行：node --test src/player/queue.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_LOOP_MODE,
  DEFAULT_TRACK_MS,
  LOOP_MODES,
  LOOP_MODE_TEXT,
  advance,
  albumQueue,
  currentTrack,
  emptyQueue,
  isLoopMode,
  nextLoopMode,
  normalizeLoopMode,
  queueTrack,
  startQueue,
  step,
  withMode,
} from "./queue.ts";

/** 造队列：['A','B','C'] + 时长 1000/2000/3000，便于断言落到哪一首。 */
const album = (ids = ["A", "B", "C"]) =>
  ids.map((id, i) => queueTrack(`lib:${id}`, (i + 1) * 1000, id));

// ————————————————————— 循环模式（三态状态机） —————————————————————

test("1. normalizeLoopMode/isLoopMode：合法三态原样，其余回退默认（顺序播放）", () => {
  for (const mode of LOOP_MODES) {
    assert.equal(normalizeLoopMode(mode), mode);
    assert.equal(isLoopMode(mode), true);
  }
  for (const bad of [undefined, null, "", "repeat", "loop", 0, 1, true, {}, []]) {
    assert.equal(normalizeLoopMode(bad), DEFAULT_LOOP_MODE, `${String(bad)} → 默认`);
    assert.equal(isLoopMode(bad), false);
  }
  assert.equal(DEFAULT_LOOP_MODE, "sequential");
});

test("2. nextLoopMode：顺序 → 专辑 → 单曲 → 顺序，三态闭环不回退", () => {
  assert.equal(nextLoopMode("sequential"), "album");
  assert.equal(nextLoopMode("album"), "single");
  assert.equal(nextLoopMode("single"), "sequential");
  // 连点 3 次必须回到原点（设置里持久化的就是这三个值之一）。
  let mode = DEFAULT_LOOP_MODE;
  for (let i = 0; i < 3; i++) mode = nextLoopMode(mode);
  assert.equal(mode, DEFAULT_LOOP_MODE);
  // 非法输入不炸、不产生新态。
  assert.equal(nextLoopMode("nonsense"), "album");
});

test("3. LOOP_MODE_TEXT：每个模式都有可区分的图标与中文标注", () => {
  assert.deepEqual(Object.keys(LOOP_MODE_TEXT).sort(), [...LOOP_MODES].sort());
  const labels = LOOP_MODES.map((m) => LOOP_MODE_TEXT[m].label);
  assert.deepEqual(labels, ["顺序", "专辑", "单曲"]);
  const marks = LOOP_MODES.map((m) => LOOP_MODE_TEXT[m].glyph + (LOOP_MODE_TEXT[m].sup ?? ""));
  assert.equal(new Set(marks).size, 3, "图标+上标三态互不相同");
  for (const mode of LOOP_MODES) assert.ok(LOOP_MODE_TEXT[mode].hint.length > 0);
});

// ————————————————————— 队列项与构造 —————————————————————

test("4. queueTrack：id 裁剪、时长归一（缺失/非法回退默认）、空标注为 null", () => {
  assert.deepEqual(queueTrack(" lib:7 ", 1234, "歌名"), {
    trackId: "lib:7",
    durationMs: 1234,
    label: "歌名",
  });
  for (const bad of [null, undefined, NaN, Infinity, 0, -5, "3000", {}]) {
    assert.equal(queueTrack("lib:7", bad).durationMs, DEFAULT_TRACK_MS);
  }
  assert.equal(queueTrack("lib:7", 0.4).durationMs, 1, "正数至少 1ms");
  assert.equal(queueTrack("lib:7", 1234.6).durationMs, 1235, "四舍五入到整数 ms");
  assert.equal(queueTrack("lib:7", 1234, "  ").label, null);
  assert.equal(queueTrack("lib:7", 1234, 42).label, null);
  assert.equal(queueTrack("lib:7", DEFAULT_TRACK_MS).label, null);
});

test("5. startQueue：定位当前曲、越界钳制、空列表 → 无当前曲", () => {
  const tracks = album();
  assert.equal(currentTrack(startQueue(tracks, 1, "sequential")).trackId, "lib:B");
  assert.equal(currentTrack(startQueue(tracks, 0, "sequential")).trackId, "lib:A");
  assert.equal(currentTrack(startQueue(tracks, 99, "sequential")).trackId, "lib:C", "右越界钳末位");
  assert.equal(currentTrack(startQueue(tracks, -3, "sequential")).trackId, "lib:A", "左越界钳首位");
  assert.equal(currentTrack(startQueue(tracks, 1.7, "sequential")).trackId, "lib:B", "小数截断");
  assert.equal(currentTrack(startQueue(tracks, NaN, "sequential")).trackId, "lib:A", "NaN 取首位");

  const none = startQueue([], 0, "album");
  assert.equal(none.index, -1);
  assert.deepEqual(none.tracks, []);
  assert.equal(currentTrack(none), null);
  assert.equal(none.mode, "album");
});

test("6. emptyQueue/withMode：模式随行、空队列无当前曲，切模式保留曲目与位置", () => {
  const empty = emptyQueue("single");
  assert.deepEqual(empty, { tracks: [], index: -1, mode: "single" });

  const playing = startQueue(album(), 2, "sequential");
  const switched = withMode(playing, "album");
  assert.equal(switched.mode, "album");
  assert.equal(switched.index, 2, "切模式不动当前曲");
  assert.deepEqual(switched.tracks, playing.tracks);
  assert.equal(playing.mode, "sequential", "原队列不被改写");
  assert.equal(withMode(playing, "bullshit").mode, DEFAULT_LOOP_MODE);
});

// ————————————————————— 曲终决策（advance） —————————————————————

test("7. 顺序播放：中间进下一首，末尾停止（不环绕）", () => {
  const tracks = album();
  const first = startQueue(tracks, 0, "sequential");
  const second = advance(first);
  assert.equal(second.decision.kind, "play");
  assert.equal(second.decision.track.trackId, "lib:B");
  assert.equal(second.queue.index, 1);

  const last = startQueue(tracks, 2, "sequential");
  const afterLast = advance(last);
  assert.equal(afterLast.decision.kind, "stop");
  assert.equal(afterLast.queue.index, 2, "停止时保留原位置（不偷偷回卷）");
  assert.equal(advance(afterLast.queue).decision.kind, "stop", "停在末尾后再次判曲终仍是停止");
});

test("8. 专辑循环：末尾回到第一首，中间照常进下一首", () => {
  const tracks = album();
  const last = startQueue(tracks, 2, "album");
  const wrapped = advance(last);
  assert.equal(wrapped.decision.track.trackId, "lib:A");
  assert.equal(wrapped.queue.index, 0);

  const mid = advance(startQueue(tracks, 0, "album"));
  assert.equal(mid.decision.track.trackId, "lib:B");

  // 单曲队列（一张专辑只有一首，或散曲入队）：专辑循环 = 重播自己。
  const one = startQueue(album(["X"]), 0, "album");
  assert.equal(advance(one).decision.track.trackId, "lib:X");
});

test("9. 单曲循环：任何位置播完都重播当前曲，索引不动", () => {
  const tracks = album();
  for (const index of [0, 1, 2]) {
    const queue = startQueue(tracks, index, "single");
    const again = advance(queue);
    assert.equal(again.decision.kind, "play");
    assert.equal(again.decision.track.trackId, tracks[index].trackId);
    assert.equal(again.queue.index, index);
  }
});

test("10. advance：空队列/未选曲不猜目标，一律停止", () => {
  assert.equal(advance(emptyQueue("sequential")).decision.kind, "stop");
  assert.equal(advance(emptyQueue("album")).decision.kind, "stop");
  assert.equal(advance(emptyQueue("single")).decision.kind, "stop");
  const unselected = { tracks: album(), index: -1, mode: "album" };
  assert.equal(advance(unselected).decision.kind, "stop");
  assert.equal(advance(unselected).queue.index, -1);
});

// ————————————————————— 手动上/下一首（step） —————————————————————

test("11. step：队列两端环绕，与循环模式无关（手动切歌不因单曲循环卡住）", () => {
  const tracks = album();
  for (const mode of LOOP_MODES) {
    const last = startQueue(tracks, 2, mode);
    assert.equal(step(last, 1).decision.track.trackId, "lib:A", `${mode} 末位→下一首回首位`);
    const first = startQueue(tracks, 0, mode);
    assert.equal(step(first, -1).decision.track.trackId, "lib:C", `${mode} 首位→上一首回末位`);
    const mid = startQueue(tracks, 1, mode);
    assert.equal(step(mid, 1).decision.track.trackId, "lib:C");
    assert.equal(step(mid, -1).decision.track.trackId, "lib:A");
  }
});

test("12. step：未选曲时按方向落到首/末位；空队列停止；方向只看符号", () => {
  const unselected = { tracks: album(), index: -1, mode: "sequential" };
  assert.equal(step(unselected, 1).decision.track.trackId, "lib:A");
  assert.equal(step(unselected, -1).decision.track.trackId, "lib:C");

  const empty = emptyQueue("album");
  assert.equal(step(empty, 1).decision.kind, "stop");
  assert.equal(step(empty, -1).decision.kind, "stop");

  const mid = startQueue(album(), 1, "sequential");
  assert.equal(step(mid, 5).decision.track.trackId, "lib:C", "+5 等同 +1");
  assert.equal(step(mid, -0.5).decision.track.trackId, "lib:A", "−0.5 等同 −1");
});

// ————————————————————— 纯函数与连续场景 —————————————————————

test("13. 决策不改写入参（冻结队列也能算）", () => {
  const tracks = Object.freeze(album());
  const queue = Object.freeze(startQueue(tracks, 0, "sequential"));
  const snapshot = JSON.stringify(queue);
  const next = advance(queue);
  step(queue, 1);
  withMode(queue, "single");
  assert.equal(JSON.stringify(queue), snapshot, "队列内容零改写");
  assert.equal(queue.index, 0);
  assert.notEqual(next.queue, queue, "返回新对象（引用可比较）");
});

test("14. 连续场景：顺序播完 3 首停在末尾；专辑循环 4 次回到起点", () => {
  let queue = startQueue(album(), 0, "sequential");
  const walked = [];
  for (let i = 0; i < 5; i++) {
    const result = advance(queue);
    if (result.decision.kind === "stop") break;
    queue = result.queue;
    walked.push(currentTrack(queue).trackId);
  }
  assert.deepEqual(walked, ["lib:B", "lib:C"], "顺序播放只走一遍队列");

  let looped = startQueue(album(), 0, "album");
  const seen = [];
  for (let i = 0; i < 4; i++) {
    const result = advance(looped);
    looped = result.queue;
    seen.push(currentTrack(looped).trackId);
  }
  assert.deepEqual(seen, ["lib:B", "lib:C", "lib:A", "lib:B"], "专辑循环首尾相接");
});

test("15. albumQueue：专辑行 → lib:<id> 队列 + 点中行的下标（曲库行缺字段照常兜底）", () => {
  const rows = [
    { id: 11, title: "第一首", duration_ms: 120_000 },
    { id: 22, title: null, duration_ms: null },
    { id: 33, title: "第三首", duration_ms: 0 },
  ];
  const { tracks, startIndex } = albumQueue(rows, 33);
  assert.deepEqual(
    tracks.map((t) => t.trackId),
    ["lib:11", "lib:22", "lib:33"],
  );
  assert.equal(startIndex, 2);
  assert.equal(tracks[0].durationMs, 120_000, "库里时长原样带走");
  assert.equal(tracks[1].durationMs, DEFAULT_TRACK_MS, "缺时长兜底");
  assert.equal(tracks[2].durationMs, DEFAULT_TRACK_MS, "0 时长（流长度未知）同样兜底");
  assert.deepEqual(
    tracks.map((t) => t.label),
    ["第一首", null, "第三首"],
  );

  // 点中的行不在缓存里（歌单尚未回填）：startIndex=-1，由调用方退回单曲播放。
  assert.equal(albumQueue(rows, 99).startIndex, -1);
  assert.equal(albumQueue([], 1).tracks.length, 0);
  assert.equal(albumQueue([], 1).startIndex, -1);
  assert.equal(rows.length, 3, "入参不被改写");
});

test("16. albumQueue → startQueue → advance：点专辑第 2 首，曲终进第 3 首、末尾停止", () => {
  const rows = [
    { id: 1, title: "A", duration_ms: 1000 },
    { id: 2, title: "B", duration_ms: 1000 },
    { id: 3, title: "C", duration_ms: 1000 },
  ];
  const { tracks, startIndex } = albumQueue(rows, 2);
  const queue = startQueue(tracks, startIndex, "sequential");
  assert.equal(currentTrack(queue).trackId, "lib:2");
  const next = advance(queue);
  assert.equal(next.decision.track.trackId, "lib:3");
  assert.equal(advance(next.queue).decision.kind, "stop");
});

test("17. 曲目时长随队列带走：切曲时不需要再查库", () => {
  const tracks = [queueTrack("lib:1", 61_000, "第一首"), queueTrack("lib:2", null, null)];
  const first = startQueue(tracks, 0, "sequential");
  assert.equal(currentTrack(first).durationMs, 61_000);
  assert.equal(first.tracks[0].label, "第一首");
  const next = advance(first);
  assert.equal(next.decision.track.durationMs, DEFAULT_TRACK_MS, "无时长那一首用默认值");
  // 库里没有时长（null）时用默认值兜底，engine.play 永远拿到合法 duration_ms。
  assert.equal(next.decision.track.trackId, "lib:2");
  assert.equal(advance(next.queue).decision.kind, "stop");
  assert.equal(tracks[1].durationMs, DEFAULT_TRACK_MS);
});
