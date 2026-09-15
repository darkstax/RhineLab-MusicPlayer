/**
 * 播放队列 + 循环模式（纯逻辑，**零 import**：node --test 可直接加载，见 queue.test.mjs）。
 *
 * 为什么单独成文件：player-store 依赖 desktop-bridge 的无扩展名 import，node --test 解析不了；
 * 而"播完该放哪一首"这种状态机最容易写错、最值得单测。所以决策全部收敛在这里的纯函数里，
 * player-store 只负责把引擎事件喂进来、把决策结果发出去（engine.play / 停止）。
 *
 * 语义约定：
 * - 队列项自带 trackId 与 durationMs，切曲时**不再查库**（engine.play 的 duration_ms 直接取用）；
 * - `advance` = 自然播完（曲终）的决策，受循环模式影响；
 * - `step` = 用户手动上/下一首，只在队列内前后移动并环绕，**不受单曲循环影响**——
 *   手动切歌却被"单曲循环"钉在同一首上，是比"越界停住"更坏的体验；
 * - 所有函数不改写入参，返回新队列（同 player-store 的不可变快照风格）。
 */

/** 三态循环模式：顺序播放（默认）/ 专辑循环 / 单曲循环。 */
export type LoopMode = "sequential" | "album" | "single";

/** 点按钮的循环顺序（也是持久化取值的全集）。 */
export const LOOP_MODES: readonly LoopMode[] = ["sequential", "album", "single"];

export const DEFAULT_LOOP_MODE: LoopMode = "sequential";

/** 与 player-store 的 DEFAULT_DURATION_MS 同值：库里没有时长时的兜底。 */
export const DEFAULT_TRACK_MS = 180_000;

/**
 * 按钮文案（播放条三态钮）：图标 + 上标 + 中文小字，三态必须一眼可分。
 * `sup` 只用于单曲循环的"1"角标（↻ vs ↻¹），避免用两个不同字形的 ↻ 让人猜。
 */
export const LOOP_MODE_TEXT: Readonly<
  Record<LoopMode, { readonly glyph: string; readonly sup: string | null; readonly label: string; readonly hint: string }>
> = {
  sequential: {
    glyph: "→",
    sup: null,
    label: "顺序",
    hint: "循环模式：顺序播放（播完队列末尾停止）",
  },
  album: {
    glyph: "↻",
    sup: null,
    label: "专辑",
    hint: "循环模式：专辑循环（播完末尾回到第一首）",
  },
  single: {
    glyph: "↻",
    sup: "1",
    label: "单曲",
    hint: "循环模式：单曲循环（播完重播当前曲）",
  },
};

/** 队列项：trackId 原样交给 engine.play（lib:<id> 由壳解析成 file:<path>）。 */
export type QueueTrack = {
  readonly trackId: string;
  readonly durationMs: number;
  /** 展示名（专辑行标题等）；空值交给 player-store 查库回填。 */
  readonly label: string | null;
};

export type PlayQueue = {
  readonly tracks: readonly QueueTrack[];
  /** 当前曲下标；-1 = 队列为空（未选曲）。 */
  readonly index: number;
  readonly mode: LoopMode;
};

/** 曲终/切歌决策：play 表示接着播 queue.index 指向的那一首；stop 表示到此为止。 */
export type QueueDecision =
  | { readonly kind: "play"; readonly track: QueueTrack }
  | { readonly kind: "stop" };

/** 决策 + 更新后的队列（索引已经落到要播的那一首）。 */
export type QueueStep = { readonly queue: PlayQueue; readonly decision: QueueDecision };

export function isLoopMode(value: unknown): value is LoopMode {
  return value === "sequential" || value === "album" || value === "single";
}

/** 读取持久化值/壳配置时的归一化：非法值一律回退顺序播放。 */
export function normalizeLoopMode(value: unknown): LoopMode {
  return isLoopMode(value) ? value : DEFAULT_LOOP_MODE;
}

/** 三态循环：顺序 → 专辑 → 单曲 → 顺序（非法输入按默认档起步）。 */
export function nextLoopMode(mode: LoopMode): LoopMode {
  const current = LOOP_MODES.indexOf(normalizeLoopMode(mode));
  return LOOP_MODES[(current + 1) % LOOP_MODES.length];
}

/**
 * 队列项构造：时长缺失（库里的 duration_ms 为 null）/非法 → 默认 180s；
 * label 只接受非空字符串，其它一律 null（player-store 会回填真名）。
 */
export function queueTrack(trackId: string, durationMs?: unknown, label?: unknown): QueueTrack {
  const ms =
    typeof durationMs === "number" && Number.isFinite(durationMs) && durationMs > 0
      ? Math.max(1, Math.round(durationMs))
      : DEFAULT_TRACK_MS;
  const text = typeof label === "string" ? label.trim() : "";
  return { trackId: trackId.trim(), durationMs: ms, label: text ? text : null };
}

export function emptyQueue(mode: LoopMode = DEFAULT_LOOP_MODE): PlayQueue {
  return { tracks: [], index: -1, mode: normalizeLoopMode(mode) };
}

/** 建队列并定位起始曲：startIndex 越界钳到两端（点行播放时行序一定合法，这里是防御）。 */
export function startQueue(
  tracks: readonly QueueTrack[],
  startIndex: number,
  mode: LoopMode = DEFAULT_LOOP_MODE,
): PlayQueue {
  const list = [...tracks];
  if (list.length === 0) return emptyQueue(mode);
  const raw = Number.isFinite(startIndex) ? Math.trunc(startIndex) : 0;
  return { tracks: list, index: Math.min(Math.max(raw, 0), list.length - 1), mode: normalizeLoopMode(mode) };
}

/** 只换模式，保留曲目与当前曲（切换循环模式不该打断正在播的歌）。 */
export function withMode(queue: PlayQueue, mode: LoopMode): PlayQueue {
  return { ...queue, mode: normalizeLoopMode(mode) };
}

export function currentTrack(queue: PlayQueue): QueueTrack | null {
  return queue.index >= 0 ? (queue.tracks[queue.index] ?? null) : null;
}

/**
 * 曲终决策（自然播完）：
 * - 顺序播放：还有下一首就播，到末尾停止；
 * - 专辑循环：末尾回到第一首；
 * - 单曲循环：重播当前曲。
 * 空队列/未选曲不猜目标，一律 stop。
 */
export function advance(queue: PlayQueue): QueueStep {
  const { tracks, index, mode } = queue;
  if (tracks.length === 0 || index < 0) return { queue, decision: { kind: "stop" } };
  if (mode === "single") return { queue, decision: { kind: "play", track: tracks[index] } };
  const next = index + 1;
  if (next < tracks.length) {
    return { queue: { ...queue, index: next }, decision: { kind: "play", track: tracks[next] } };
  }
  if (mode === "album") {
    return { queue: { ...queue, index: 0 }, decision: { kind: "play", track: tracks[0] } };
  }
  return { queue, decision: { kind: "stop" } };
}

/** 手动上/下一首：只看 delta 符号，队列内前后移动并环绕（不改变循环模式）。 */
export function step(queue: PlayQueue, delta: number): QueueStep {
  const { tracks } = queue;
  if (tracks.length === 0) return { queue, decision: { kind: "stop" } };
  const dir = delta < 0 ? -1 : 1;
  const from = queue.index < 0 ? (dir > 0 ? -1 : 0) : queue.index;
  const next = (from + dir + tracks.length) % tracks.length;
  return { queue: { ...queue, index: next }, decision: { kind: "play", track: tracks[next] } };
}

/**
 * 曲库专辑行 → 播放队列（专辑详情页点某首曲目：整张入队并定位到那一首）。
 *
 * 行来自壳侧 `library.query scope=tracks`（id/title/duration_ms 都可能缺失），
 * 这里做的是"点行 → 队列 + 起始下标"的纯映射，好让 main.ts 的点击处理只负责取缓存与调用；
 * 点中的曲目不在行里（歌单尚未回填、或行被过滤）时 startIndex = -1，调用方退回单曲播放。
 */
export type AlbumRowLike = {
  readonly id: number;
  readonly title?: string | null;
  readonly duration_ms?: number | null;
};

export function albumQueue(
  rows: readonly AlbumRowLike[],
  trackId: number,
): { tracks: QueueTrack[]; startIndex: number } {
  return {
    tracks: rows.map((row) => queueTrack(`lib:${row.id}`, row.duration_ms, row.title)),
    startIndex: rows.findIndex((row) => row.id === trackId),
  };
}
