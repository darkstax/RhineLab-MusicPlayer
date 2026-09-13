// M5b 歌词解析单测（node --test，WSL 直跑，不碰 Windows、不需 DOM）。
// 语料参照 go-musicfox internal/lyric 的 LRC 语义（其仓库仅有 YRC/offset 用例，
// LRC 解析用例按同语义自行构造，YRC 用例按用户裁定跳过）；只移植语义不抄实现。
import test from "node:test";
import assert from "node:assert/strict";
import {
  annotatePairs,
  classifyScript,
  findLineIndex,
  parseLrc,
  parseTimeTag,
  PAIR_MAX_GAP_MS,
  taskbarPair,
} from "./lrc.ts";

test("单时间标签标准行", () => {
  const { lines, skipped } = parseLrc("[00:12.34]第一句");
  assert.equal(lines.length, 1);
  assert.equal(lines[0].startMs, 12340);
  assert.equal(lines[0].text, "第一句");
  assert.equal(skipped, 0);
});

test("三位毫秒 [mm:ss.xxx] 与分钟超过 59", () => {
  const a = parseLrc("[00:01.234]x").lines[0];
  assert.equal(a.startMs, 1234);
  const b = parseLrc("[75:00.50]y").lines[0];
  assert.equal(b.startMs, 75 * 60_000 + 500);
});

test("多时间标签行 [a][b]text：一个标签一帧，共享行文本", () => {
  const { lines } = parseLrc("[00:05.00][01:20.00][01:45.00]副歌");
  assert.equal(lines.length, 3);
  assert.deepEqual(
    lines.map((l) => l.startMs),
    [5000, 80000, 105000],
  );
  assert.ok(lines.every((l) => l.text === "副歌"));
});

test("offset 正值 = 歌词提前（Aegisub 语义）", () => {
  const { lines, meta } = parseLrc("[offset:+500]\n[00:10.00]句");
  assert.equal(meta.offsetMs, 500);
  assert.equal(lines[0].startMs, 9500);
});

test("offset 负值 = 歌词滞后，且不为负时间戳", () => {
  const { lines, meta } = parseLrc("[offset:-800]\n[00:10.00]晚\n[00:00.100]头");
  assert.equal(meta.offsetMs, -800);
  assert.equal(lines.find((l) => l.text === "晚").startMs, 10800);
  // 100ms + 800ms 后仍非负
  assert.equal(lines.find((l) => l.text === "头").startMs, 900);
  const clamped = parseLrc("[offset:+5000]\n[00:00.100]头");
  assert.equal(clamped.lines[0].startMs, 0, "提前量超过时间戳 → 钳位到 0，不为负");
});

test("元标签提取为 meta，不产出歌词行", () => {
  const { lines, meta, skipped } = parseLrc(
    [
      "[ti:曲名]",
      "[ar:歌手]",
      "[al:专辑]",
      "[au:词作者]",
      "[00:01.00]唱",
    ].join("\n"),
  );
  assert.equal(lines.length, 1);
  assert.equal(meta.title, "曲名");
  assert.equal(meta.artist, "歌手");
  assert.equal(meta.album, "专辑");
  assert.equal(meta.lyricist, "词作者");
  assert.equal(skipped, 0);
});

test("水印行过滤：无时间标签且以 [by: 开头", () => {
  const { lines, meta, skipped } = parseLrc(
    ["[00:01.00]句一", "[by:鲜果微笑]", "[00:02.00]句二"].join("\n"),
  );
  assert.equal(lines.length, 2);
  assert.equal(meta.author, "鲜果微笑");
  assert.equal(meta.watermarkFiltered, true);
  assert.equal(skipped, 0, "水印不算坏行");
});

test("带时间标签的 [by:] 行是正常歌词，不过滤", () => {
  const { lines, meta } = parseLrc("[00:03.00][by:某人] 混排行");
  assert.equal(lines.length, 1);
  assert.equal(lines[0].text, "[by:某人] 混排行");
  assert.equal(meta.watermarkFiltered, false);
});

test("坏行容错：skipParseErr 语义跳过并计数，不抛", () => {
  const { lines, skipped } = parseLrc(
    ["这是一行没有标签的垃圾", "[00:01.00]好", "[abc]怪", "   ", "[00:99.99.9]坏格式"].join("\n"),
  );
  assert.equal(lines.length, 1);
  assert.equal(lines[0].text, "好");
  assert.equal(skipped, 3, "垃圾行 / [abc] / 非法秒 均跳过计数");
});

test("严格模式 skipParseErr=false 首个无时间标签行抛错", () => {
  assert.throws(() => parseLrc("没有标签的行", { skipParseErr: false }), /no time tag/);
  // 纯空行与 meta 行不触发
  assert.doesNotThrow(() => parseLrc("\n[ar:x]\n[00:01.00]好", { skipParseErr: false }));
});

test("空文本 / 全空白 / 仅 meta → 零行", () => {
  assert.equal(parseLrc("").lines.length, 0);
  assert.equal(parseLrc("  \n\t\n").lines.length, 0);
  assert.equal(parseLrc("[ar:x]\n[ti:y]").lines.length, 0);
});

test("乱序时间轴归并排序（多标签与跨行乱序）", () => {
  const { lines } = parseLrc("[01:00.00]后\n[00:10.00]前\n[00:30.00][00:05.00]插");
  assert.deepEqual(
    lines.map((l) => l.startMs),
    [5000, 10000, 30000, 60000],
  );
});

test("空文本时间标签不产帧（间奏由上一行延续）", () => {
  const { lines } = parseLrc("[00:01.00]唱\n[00:05.00]\n[00:06.00]   ");
  assert.equal(lines.length, 1);
});

test("行内卡拉OK逐字标签：剥离不拆句（YRC 不做）", () => {
  const { lines } = parseLrc("[00:01.00]<00:01.00>逐<00:01.50>字<00:02.00>词");
  assert.equal(lines.length, 1);
  assert.equal(lines[0].text, "逐字词");
});

test("双语配对：相邻两行脚本不同且时间邻近 → 后行标 paired；贪心跳档不把下行原文误标", () => {
  const { lines } = parseLrc("[00:01.00]中文原文\n[00:01.10]English translation");
  assert.equal(lines[0].paired, false);
  assert.equal(lines[1].paired, true);
  assert.equal(lines[0].script, "cn");
  assert.equal(lines[1].script, "latin");
  // 交替四行：只有译文行（1、3）成对，第 2 行原文不得因紧邻上行译文而被标 paired
  const alt = parseLrc(
    "[00:01.00]原文A\n[00:01.10]Trans A\n[00:02.00]原文B\n[00:02.10]Trans B",
  ).lines;
  assert.deepEqual(alt.map((l) => l.paired), [false, true, false, true]);
});

test("同语言相邻不成对；none 脚本不成对", () => {
  const same = parseLrc("[00:01.00]AAA\n[00:01.10]BBB").lines;
  assert.ok(same.every((l) => !l.paired));
  const symbols = parseLrc("[00:01.00]中文\n[00:01.10]♪~").lines;
  assert.equal(symbols[1].paired, false, "无实义文字行不配对");
});

test("配对时间跨度超过阈值 → 不成对", () => {
  const { lines } = parseLrc(`[00:01.00]中\n[${fmt(1000 + PAIR_MAX_GAP_MS + 100)}]trans`);
  assert.equal(lines[1].paired, false);
  const near = parseLrc(`[00:01.00]中\n[${fmt(1000 + PAIR_MAX_GAP_MS - 100)}]trans`);
  assert.equal(near.lines[1].paired, true, "阈值内仍成对");
});

function fmt(ms) {
  const m = Math.floor(ms / 60000);
  const s = (ms % 60000) / 1000;
  return `${String(m).padStart(2, "0")}:${s.toFixed(2)}`;
}

test("annotatePairs 对空/单行安全", () => {
  assert.doesNotThrow(() => annotatePairs([]));
  assert.doesNotThrow(() => annotatePairs(parseLrc("[00:01.00]只有一行").lines));
});

test("二分边界：早于首行 -1、恰在首行 0、两行之间、恰在末行、超过末行", () => {
  const { lines } = parseLrc("[00:10.00]一\n[00:20.00]二\n[00:30.00]三");
  assert.equal(findLineIndex(lines, 9999), -1);
  assert.equal(findLineIndex(lines, 10000), 0, "恰在时间戳上命中该行");
  assert.equal(findLineIndex(lines, 15000), 0);
  assert.equal(findLineIndex(lines, 20000), 1);
  assert.equal(findLineIndex(lines, 29999), 1);
  assert.equal(findLineIndex(lines, 30000), 2, "恰在末行时间戳");
  assert.equal(findLineIndex(lines, 999999), 2, "超过末行停在末行");
  assert.equal(findLineIndex([], 0), -1, "空文本");
});

test("二分随机一致性（与线性扫描对照 2000 次）", () => {
  const stamps = [];
  for (let i = 0; i < 500; i++) stamps.push(i * 1234);
  const text = stamps.map((ms) => `[${fmt(ms)}]L${ms}`).join("\n");
  const { lines } = parseLrc(text);
  assert.equal(lines.length, 500);
  for (let t = 0; t < 2000; t++) {
    const ms = Math.floor(Math.random() * 700000);
    let linear = -1;
    for (let i = 0; i < lines.length; i++) if (lines[i].startMs <= ms) linear = i;
    assert.equal(findLineIndex(lines, ms), linear, `t=${t} ms=${ms}`);
  }
});

test("同时间戳多行（双语同时间轴标准格式）稳定保序", () => {
  const { lines } = parseLrc("[00:05.00]原文行\n[00:05.00]译文行");
  assert.deepEqual(lines.map((l) => l.text), ["原文行", "译文行"], "sort 稳定性");
  assert.equal(lines[1].paired, false, "同为 cn 脚本不成对（本例两行都中文）");
});

test("classifyScript：中/日/韩/拉丁/无实义", () => {
  assert.equal(classifyScript("莱茵生命"), "cn");
  assert.equal(classifyScript("ラインライト"), "jp");
  assert.equal(classifyScript("가사"), "ko");
  assert.equal(classifyScript("Rhine Lab"), "latin");
  assert.equal(classifyScript("♪ ~ 123"), "none");
  assert.equal(classifyScript("中文为主 mixed 少量英"), "cn", "众数胜出");
});

test("parseTimeTag 容错", () => {
  assert.equal(parseTimeTag("[00:12.34]"), 12340);
  assert.equal(parseTimeTag("00:12.34"), 12340);
  assert.equal(parseTimeTag("[60:00]"), 3600000);
  assert.equal(parseTimeTag("[00:9]"), 9000);
  assert.equal(parseTimeTag("[0:1.5]"), 1500);
  assert.equal(parseTimeTag("[ab:cd]"), null);
  assert.equal(parseTimeTag("[00:60.00]"), null, "秒必须 <60");
  assert.equal(parseTimeTag(""), null);
});

test("taskbarPair：primary=原文行（译文行回看配对原文），secondary=译文/下一行，末行为空串", () => {
  const { lines } = parseLrc("[00:01.00]中文原文\n[00:01.10]translation\n[00:05.00]第三行");
  assert.deepEqual(taskbarPair(lines, 0), { primary: "中文原文", secondary: "translation" });
  assert.deepEqual(taskbarPair(lines, 1), { primary: "中文原文", secondary: "translation" }, "停在译文行→回看配对原文");
  assert.deepEqual(taskbarPair(lines, 2), { primary: "第三行", secondary: "" });
  assert.deepEqual(taskbarPair(lines, -1), { primary: "", secondary: "" });
  assert.deepEqual(taskbarPair(lines, 99), { primary: "", secondary: "" });
  // 非双语普通行：secondary=下一句
  const plain = parseLrc("[00:01.00]AA\n[00:09.00]BB").lines;
  assert.deepEqual(taskbarPair(plain, 0), { primary: "AA", secondary: "BB" });
});

test("CRLF 与无尾换行", () => {
  const { lines } = parseLrc("[00:01.00]a\r\n[00:02.00]b");
  assert.equal(lines.length, 2);
  assert.equal(lines[1].text, "b");
});

test("重复同名 meta 键只认首个", () => {
  const { meta } = parseLrc("[ar:第一个]\n[ar:第二个]\n[00:01.00]x");
  assert.equal(meta.artist, "第一个");
});
