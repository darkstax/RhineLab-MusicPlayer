/**
 * LRC 歌词解析（M5b 泳道 B，纯函数零依赖）。语义参照 go-musicfox
 * `internal/lyric/lrc.go`（ReadLRC / readLRCLine / parseLRCTime），差异与裁定：
 * - **YRC 逐字歌词不做**（M5-Q3 用户裁定）；行内 `<mm:ss.xx>` 卡拉OK标签只剥离、不拆句。
 * - **行内双语拆句不做**（用户已改库为标准双行同时间轴：一行原文一行译文，各自带时间标签）；
 *   本模块只做相邻行脚本配对标注（`annotatePairs`：贪心跳档，只标译文行）。
 * - 多时间标签 `[mm:ss.xx][mm:ss.xx]text` 与 go 版同语义：一个标签产一帧，共享行文本。
 * - 元标签 ar/ai/al/by/ti/au/re/ve/offset 识别并从歌词行剔除；`[by:…]` 无时间标签行按水印过滤
 *   （任务书规则：无时间标签且以 [by: 开头）。
 * - skipParseErr 语义（go-musicfox NewService 构造参数）：坏行跳过并计数，默认不抛。
 * - offset 符号沿用 LRC 规范/Aegisub：正值=歌词提前（行时间戳减去 offset）。
 *
 * node --test 可直跑（v24 原生类型剥离），因此本文件禁止 import 任何 DOM/上游模块。
 */

/** 主要文字种类：按字符计数取众数（cn 含CJK基本+A/兼容表意；jp 假名；ko 谚文；latin 拉丁扩展）。 */
export type ScriptClass = "cn" | "jp" | "ko" | "latin" | "none";

export type LyricLine = {
  /** 生效时间戳（毫秒，已应用 offset）。 */
  startMs: number;
  text: string;
  script: ScriptClass;
  /** 相邻配对：本行是上一行的译文行（脚本种类不同且时间邻近）。 */
  paired: boolean;
};

export type LyricMeta = {
  title: string | null;
  artist: string | null;
  album: string | null;
  author: string | null; // by:（也是水印过滤的判据来源）
  lyricist: string | null; // au: 作词
  /** [offset:±ms]，原始值；应用方式：startMs - offsetMs（正值提前）。 */
  offsetMs: number;
  /** 是否存在被过滤的 [by:] 水印行。 */
  watermarkFiltered: boolean;
};

export type LyricParseResult = {
  lines: LyricLine[];
  meta: LyricMeta;
  /** skipParseErr 语义下跳过的坏行数（水印/meta 不计）。 */
  skipped: number;
};

export type ParseOptions = {
  /** 默认 true：坏行跳过计数；false 时首个无时间标签非空行抛错（严格模式，单测覆盖）。 */
  skipParseErr?: boolean;
};

/** 相邻配对的译文行时间邻近阈值（毫秒）：标准双语库译文与原文同/近时间戳。 */
export const PAIR_MAX_GAP_MS = 5000;

const TIME_TAG = /^\[(\d{1,3}):([0-5]?\d(?:\.\d{1,3})?)\]/;
/** 元标签（键固定表，值到首个 `]`），整行均为元标签+可选空白时视为 meta 行。 */
const META_TAG = /^\[([a-zA-Z]{2,7}):([^\]]*)\]/;
const META_KEYS = new Set(["ar", "ai", "al", "ti", "by", "au", "re", "ve", "offset", "id", "length"]);
/** 行内卡拉OK逐字/逐词标签：剥离不拆句（YRC 不做的兜底）。 */
const INLINE_TAG = /<\d{1,3}:\d{2}(?:\.\d{1,3})?>/g;

const scriptRanges: Array<[ScriptClass, RegExp]> = [
  ["cn", /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/],
  ["jp", /[\u3040-\u30ff\u31f0-\u31ff]/],
  ["ko", /[\u1100-\u11ff\u3130-\u318f\uac00-\ud7af]/],
  ["latin", /[A-Za-z\u00c0-\u024f]/],
];

/** 判定文本的主要文字种类（各脚本字符计数取众数；无实义文字 → none）。 */
export function classifyScript(text: string): ScriptClass {
  let best: ScriptClass = "none";
  let bestCount = 0;
  const counted: Partial<Record<ScriptClass, number>> = {};
  for (const ch of text) {
    for (const [cls, re] of scriptRanges) {
      if (re.test(ch)) {
        const n = (counted[cls] ?? 0) + 1;
        counted[cls] = n;
        if (n > bestCount) {
          best = cls;
          bestCount = n;
        }
        break;
      }
    }
  }
  return best;
}

/** 解析单个时间标签为毫秒；非法返回 null（对齐 go parseLRCTime 的容错语义）。 */
export function parseTimeTag(tag: string): number | null {
  const m = /^\[?(\d{1,3}):([0-5]?\d(?:\.\d{1,3})?)\]?$/.exec(tag.trim());
  if (!m) return null;
  const minutes = Number(m[1]);
  const seconds = Number(m[2]);
  if (!Number.isFinite(minutes) || !Number.isFinite(seconds)) return null;
  // go 版 math.Floor(seconds*1000)：浮点秒向下取整毫秒。
  return Math.floor(minutes * 60_000 + seconds * 1000);
}

function parseMetaValue(key: string, value: string): Partial<LyricMeta> {
  const v = value.trim();
  switch (key) {
    case "ti": return { title: v };
    case "ar": return { artist: v };
    case "al": return { album: v };
    case "by": return { author: v };
    case "au": return { lyricist: v };
    case "offset": {
      const n = Number.parseInt(v, 10);
      return { offsetMs: Number.isFinite(n) ? n : 0 };
    }
    default: return {};
  }
}

/**
 * 解析 LRC 全文。空文本/无有效行返回 lines=[]（渲染端显示空态）。
 * 行为与 go ReadLRC 对齐：逐行、多标签展开、最后按 startMs 稳定排序。
 */
export function parseLrc(text: string, options: ParseOptions = {}): LyricParseResult {
  const skipParseErr = options.skipParseErr !== false;
  const meta: LyricMeta = {
    title: null,
    artist: null,
    album: null,
    author: null,
    lyricist: null,
    offsetMs: 0,
    watermarkFiltered: false,
  };
  const lines: LyricLine[] = [];
  let skipped = 0;

  for (const raw of text.split(/\r\n|\r|\n/)) {
    let line = raw.trim();
    if (!line) continue;

    const watermark = /^\[by:/i.test(line) && !TIME_TAG.test(line);

    // 1) 剥离行首连续的元标签（[ar:] [offset:] 等，键必须在白名单）。
    let sawMeta = false;
    for (;;) {
      const m = META_TAG.exec(line);
      if (!m || !META_KEYS.has(m[1].toLowerCase())) break;
      // meta 只认首个同名键（与常见播放器一致，重复键忽略）。
      const patch = parseMetaValue(m[1].toLowerCase(), m[2]);
      for (const [k, v] of Object.entries(patch)) {
        if (k === "offsetMs" ? meta.offsetMs === 0 : (meta as Record<string, unknown>)[k] == null) {
          (meta as Record<string, unknown>)[k] = v;
        }
      }
      line = line.slice(m[0].length).trim();
      sawMeta = true;
    }

    // 2) 无剩余内容：meta 行或水印行 → 过滤（不计坏行）。
    if (!line) {
      if (watermark) meta.watermarkFiltered = true;
      else if (!sawMeta) skipped += 1;
      continue;
    }

    // 3) 收集行首连续时间标签（第一个必须在行首，否则整行视为坏行/水印）。
    const stamps: number[] = [];
    for (;;) {
      const m = TIME_TAG.exec(line);
      if (!m) break;
      const ms = parseTimeTag(m[0]);
      if (ms === null) break;
      stamps.push(ms);
      line = line.slice(m[0].length);
    }
    if (stamps.length === 0) {
      if (watermark) meta.watermarkFiltered = true;
      else if (skipParseErr) skipped += 1;
      else throw new Error(`lrc: no time tag on line: ${raw.slice(0, 60)}`);
      continue;
    }

    // 4) 行文本：去卡拉OK标签（不拆句），trim。空文本不产帧（间奏由上一行延续）。
    const content = line.replace(INLINE_TAG, "").trim();
    if (!content) continue;

    for (const startMs of stamps) {
      lines.push({ startMs, text: content, script: classifyScript(content), paired: false });
    }
  }

  // 5) 排序归并（go sort.Slice 语义）+ offset 应用（正值=歌词提前 → 时间戳前移）。
  lines.sort((a, b) => a.startMs - b.startMs); // Array.sort 稳定（ES2019+）。
  if (meta.offsetMs !== 0) {
    for (const l of lines) l.startMs = Math.max(0, l.startMs - meta.offsetMs);
  }
  annotatePairs(lines);
  return { lines, meta, skipped };
}

/**
 * 相邻双语配对标注（贪心跳档）：若 i 与 i+1 脚本种类不同、均非 none、时间间隔 ≤
 * PAIR_MAX_GAP_MS，则视为一对（原文+译文）并跳两行继续；否则前移一行。
 * 匹配用户库格式「一行原文一行译文，同时间轴」：只有译文行被标 paired，
 * 交替格式（cn/lat/cn/lat…）不会把原文行误标为上行译文。
 */
export function annotatePairs(lines: LyricLine[]): void {
  for (let i = 0; i + 1 < lines.length; ) {
    const a = lines[i];
    const b = lines[i + 1];
    const canPair =
      a.script !== b.script &&
      a.script !== "none" &&
      b.script !== "none" &&
      b.startMs - a.startMs <= PAIR_MAX_GAP_MS;
    if (canPair) {
      b.paired = true;
      i += 2;
    } else {
      i += 1;
    }
  }
}

/**
 * 二分：返回 startMs <= timeMs 的最后一行下标；时间早于首行返回 -1。
 * 恰在时间戳上命中该行（单测边界：首行/末行/恰在标签/两行之间/超前）。
 */
export function findLineIndex(lines: LyricLine[], timeMs: number): number {
  let lo = 0;
  let hi = lines.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].startMs <= timeMs) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

/**
 * 任务栏上行的 primary/secondary（任务书规则：primary=当前行原文、secondary=下一行/译文行）：
 * - 当前行是配对译文行（标准双行同时间轴里译文略晚于原文）→ primary 回看配对的上一行原文，
 *   secondary=本译文行；
 * - 否则 primary=当前行，secondary=下一行（双语库即其译文，非双语即下一句）。
 */
export function taskbarPair(lines: LyricLine[], index: number): { primary: string; secondary: string } {
  if (index < 0 || index >= lines.length) return { primary: "", secondary: "" };
  const current = lines[index];
  if (current.paired && index > 0) {
    return { primary: lines[index - 1].text, secondary: current.text };
  }
  const next = lines[index + 1];
  return { primary: current.text, secondary: next ? next.text : "" };
}
