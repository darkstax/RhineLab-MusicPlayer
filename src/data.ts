import content from "../content/archives.json" with { type: "json" };
import type { AlbumDto } from "./player/library/library-store.ts";

/**
 * 阵列数据层（M5d 专辑墙改造）。
 *
 * 上游契约：`records/categories/archiveColumns` 为**同引用数组**（main.ts/scene.ts/
 * archive-loop.ts 持有引用），`columnFiles/fileLocation/fileAtSlot` 为同步查询签名——
 * 全部保持不变。desktop 模式经 `hydrateFromLibrary()` 原地填充（in-place splice），
 * web 模式不水合 = archives.json 演示数据，行为逐字节不变（check-*.mjs 回归底线）。
 *
 * 参数化（M5-PLAN-v2 §5.5 红字警告项）：行池几何常量 `ROW_OFFSET`（首行行号）与
 * `ROWS_PER_COLUMN`（slot 池每列行数）取代原硬编码 `12`/`32`；列数（流派数）本就由
 * `archiveColumns.length` 实时推导，无独立常量。默认值与上游逐点等值。
 */
export interface ArchiveRecord {
  id: string;
  title: string;
  en: string;
  department: string;
  category: string;
  date: string;
  lead: string;
  clearance: string;
  abstract: string;
  findings: string[];
  source: string;
  /** ——以下 M5d 专辑墙扩展（archives.json 演示记录缺省，全部可选）—— */
  albumKey?: string;
  coverKey?: string | null;
  trackCount?: number;
  durationMs?: number;
  discCount?: number;
  formats?: string[];
  year?: number | null;
  bitrateRange?: readonly [number, number] | null;
  resolution?: { lossy: boolean; sample_rate: number | null; bit_depth: number | null } | null;
}

/** slot 池几何：每列 ROWS_PER_COLUMN 个实例行，数据行从 ROW_OFFSET 起（与上游硬编码同值）。 */
export const ROW_OFFSET = 12;
export const ROWS_PER_COLUMN = 32;

/** slot 编解码步长：默认与上游相同（32）。水合时若某列专辑数使 row≥32，按 32 的倍数
 * 放大步长，保证 fileLocation/fileAtSlot 双射在任意列长下无碰撞（web 模式恒为 32）。 */
let slotStride = ROWS_PER_COLUMN;
export function getSlotStride() {
  return slotStride;
}

export const records: ArchiveRecord[] = content.records;
export const categories = ["全部档案", ...content.categories];
export const archiveColumns = content.columns;

/** 水合状态（main.ts 读取以决定文案/详情页分支；const 对象防重导出）。 */
export const wallMode: { hydrated: boolean; truncated: boolean } = {
  hydrated: false,
  truncated: false,
};

export const UNGENRED = "未分类";

/** 流派标签归一（数据面实况：Anime/anime 同义、首尾空白、大小写）：
 * casefold 合并只发生在展示列名上（取出现次数最多的原形），不做拼写猜测（JPop≠J-Pop）。 */
function normalizeGenre(genre: string | null | undefined): string {
  const trimmed = genre?.trim() ?? "";
  return trimmed || UNGENRED;
}

export function columnFiles(lane: number) {
  return records
    .map((record, index) => ({ record, index }))
    .filter(({ record }) => record.category === archiveColumns[lane])
    .map(({ index }) => index);
}
export function fileLocation(index: number) {
  const lane = archiveColumns.indexOf(records[index].category);
  const row = ROW_OFFSET + columnFiles(lane).indexOf(index);
  return { lane, row, slot: lane * slotStride + row };
}
export function fileAtSlot(slot: number) {
  // 列数在水合后可变（5→N）：lane 越界按当前列数回绕，保持循环阵列语义。
  const lanes = Math.max(1, archiveColumns.length);
  const raw = Math.floor(slot / slotStride);
  const lane = ((raw % lanes) + lanes) % lanes;
  const files = columnFiles(lane);
  return files[
    Math.max(0, Math.min(files.length - 1, (slot % slotStride) - ROW_OFFSET))
  ];
}

/** 数据源窄接口（DesktopBridge.call 的鸭子形；单测注入 mock 即可，零新依赖）。 */
export type LibrarySource = {
  call(cmd: string, args?: object, timeoutMs?: number): Promise<unknown>;
};

export type HydrateResult = {
  ok: boolean;
  albums: number;
  columns: number;
  /** 壳侧 library.albums limit≤200 钳制且无 offset（协议 v1.4）——超量时的分片补齐是否完整。 */
  truncated: boolean;
  reason?: string;
};

const asArray = (value: unknown): value is unknown[] => Array.isArray(value);

/** 专辑行 → ArchiveRecord 形状（§5.7 字段映射；缺字段回退 "—"，禁硬编码列数/流派）。
 * genre 传入**归一后的列名**（canonical），保证 category 与 archiveColumns 严格一致。 */
function toRecord(album: AlbumDto, genre: string, serial: number): ArchiveRecord {
  const title = album.title?.trim() || album.artist?.trim() || "未知专辑";
  const artist = album.artist?.trim() || "未知艺术家";
  const year = album.year ?? null;
  return {
    id: "A-" + String(serial).padStart(3, "0"),
    title,
    en: artist,
    department: artist,
    category: genre,
    date: year === null ? "—" : String(year),
    lead: artist,
    clearance: album.formats[0]?.toUpperCase() || "—",
    abstract: `《${title}》由 ${artist} 发行${year ? `（${year}）` : ""}，收录 ${album.track_count} 首曲目。流派：${genre}。${album.disc_count > 1 ? `共 ${album.disc_count} 张碟片。` : ""}专辑介绍待曲库标签补全（DB 无对应字段）。`,
    findings: [],
    source: "",
    albumKey: album.album_key,
    coverKey: album.cover_key,
    trackCount: album.track_count,
    durationMs: album.duration_ms,
    discCount: album.disc_count,
    formats: [...album.formats],
    year,
    bitrateRange: album.bitrate_range,
    resolution: album.resolution,
  };
}

/** AlbumDto 窄解析（library-store.parseAlbum 未导出；此处按协议 §5.1 形状独立防御读取）。 */
function parseAlbumDto(raw: unknown): AlbumDto | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.album_key !== "string" || !o.album_key) return null;
  const str = (v: unknown) => (typeof v === "string" && v ? v : null);
  const num = (v: unknown, fallback = 0) =>
    typeof v === "number" && Number.isFinite(v) ? v : fallback;
  const formats = asArray(o.formats)
    ? o.formats.filter((f): f is string => typeof f === "string")
    : [];
  const range = asArray(o.bitrate_range) && o.bitrate_range.length === 2
    ? ([num(o.bitrate_range[0]), num(o.bitrate_range[1])] as const)
    : null;
  const res = (typeof o.resolution === "object" && o.resolution !== null
    ? o.resolution
    : {}) as Record<string, unknown>;
  return {
    album_key: o.album_key,
    title: str(o.title),
    artist: str(o.artist),
    year:
      typeof o.year === "number" && Number.isFinite(o.year) ? o.year : null,
    genre: str(o.genre),
    disc_count: num(o.disc_count, 1),
    track_count: num(o.track_count),
    duration_ms: num(o.duration_ms),
    cover_key: str(o.cover_key),
    formats,
    bitrate_range: range,
    resolution: {
      lossy: res.lossy === true,
      sample_rate:
        typeof res.sample_rate === "number" && Number.isFinite(res.sample_rate)
          ? res.sample_rate
          : null,
      bit_depth:
        typeof res.bit_depth === "number" && Number.isFinite(res.bit_depth)
          ? res.bit_depth
          : null,
    },
  };
}

async function fetchAlbums(
  source: LibrarySource,
  args: Record<string, unknown>,
): Promise<{ items: AlbumDto[]; total: number }> {
  const raw = (await source
    .call("library.albums", { limit: 200, ...args }, 15000)
    .catch(() => null)) as Record<string, unknown> | null;
  const items = asArray(raw?.items)
    ? raw!.items.map(parseAlbumDto).filter((a): a is AlbumDto => a !== null)
    : [];
  const total =
    typeof raw?.total === "number" && Number.isFinite(raw.total)
      ? raw.total
      : items.length;
  return { items, total };
}

/** 全库拉取：base 一遍 + 每个已知流派原形一遍（SQLite genre 为二进制匹配，
 * Anime/anime 变体分别取）；流派超 200 行时叠加逐年切片（filter.year）补齐；
 * 完整性以 stats.albums 对比判定 truncated（壳侧无 offset，协议 v1.4 实况）。 */
async function collectAlbums(
  source: LibrarySource,
): Promise<{ byKey: Map<string, AlbumDto>; truncated: boolean }> {
  const byKey = new Map<string, AlbumDto>();
  const merge = (items: AlbumDto[]) => {
    for (const album of items)
      if (!byKey.has(album.album_key)) byKey.set(album.album_key, album);
  };
  const base = await fetchAlbums(source, {});
  merge(base.items);
  const queue: string[] = [];
  const seen = new Set<string>();
  const enqueue = (genre: string | null) => {
    if (!genre || seen.has(genre)) return;
    seen.add(genre);
    queue.push(genre);
  };
  for (const album of byKey.values()) enqueue(album.genre);
  const thisYear = new Date().getFullYear();
  for (let guard = 0; queue.length > 0 && guard < 400; guard++) {
    const genre = queue.shift()!;
    const page = await fetchAlbums(source, { genre });
    merge(page.items);
    for (const album of page.items) enqueue(album.genre);
    if (page.total > page.items.length) {
      // 大流派列（如 Arknights 290 > 200 上限）：逐年切片补尾（year 范围覆盖现实曲库 + 容错余量）。
      for (let year = 1970; year <= thisYear + 5; year++) {
        const slice = await fetchAlbums(source, { genre, filter: { year } });
        merge(slice.items);
      }
    }
  }
  return { byKey, truncated: false }; // truncated 由调用方与 stats.albums 对比后定
}

/**
 * desktop 水合（任务书 §1）：library.stats + library.albums → records/categories/
 * archiveColumns 原地重建。空库/失败 = 保持 archives.json 演示数据（ok:false）。
 * 列（流派）按专辑数降序、"未分类"垫底；列内按 年份升序 → 标题。
 */
export async function hydrateFromLibrary(
  source: LibrarySource,
): Promise<HydrateResult> {
  try {
    const stats = (await source
      .call("library.stats", {}, 8000)
      .catch(() => null)) as Record<string, unknown> | null;
    if (!stats || typeof stats.albums !== "number" || stats.albums <= 0)
      return { ok: false, albums: 0, columns: 0, truncated: false, reason: "empty" };
    const collected = await collectAlbums(source);
    const byKey = collected.byKey;
    // 完整性判定：壳报的专辑总数 > 实际拉到的去重数 → 截断（如单年仍超 200 的极端列）。
    const truncated = stats.albums > byKey.size;
    const albums = [...byKey.values()].filter((a) => a.track_count > 0);
    if (albums.length === 0)
      return { ok: false, albums: 0, columns: 0, truncated, reason: "empty" };
    const groups = new Map<string, AlbumDto[]>();
    const display = new Map<string, Map<string, number>>(); // casefold 键 → 原形计数
    for (const album of albums) {
      const genre = normalizeGenre(album.genre);
      if (!groups.has(genre)) groups.set(genre, []);
      groups.get(genre)!.push(album);
      if (genre !== UNGENRED) {
        const key = genre.toLowerCase();
        const tally = display.get(key) ?? new Map<string, number>();
        tally.set(genre, (tally.get(genre) ?? 0) + 1);
        display.set(key, tally);
      }
    }
    // casefold 合并：把大小写变体归到出现次数最多的原形（Anime+anime）。
    const canonical = new Map<string, string>();
    for (const [key, tally] of display) {
      const best = [...tally.entries()].sort((a, b) => b[1] - a[1] || b[0].localeCompare(a[0]))[0][0];
      for (const variant of tally.keys()) canonical.set(variant, best);
    }
    const merged = new Map<string, AlbumDto[]>();
    for (const [genre, list] of groups) {
      const target = canonical.get(genre) ?? genre;
      if (!merged.has(target)) merged.set(target, []);
      merged.get(target)!.push(...list);
    }
    const columns = [...merged.entries()]
      .sort(
        (a, b) =>
          (a[0] === UNGENRED ? 1 : 0) - (b[0] === UNGENRED ? 1 : 0) ||
          b[1].length - a[1].length ||
          a[0].localeCompare(b[0]),
      )
      .map(([genre]) => genre);
    const byColumn = columns.map(
      (genre) =>
        merged
          .get(genre)!
          .sort(
            (a, b) =>
              (a.year ?? 0) - (b.year ?? 0) ||
              (a.title ?? a.album_key).localeCompare(b.title ?? b.album_key),
          ),
      // 每次取列时用排序后的副本
    );
    // 步长放大：任一列 row = ROW_OFFSET + n 超出 32 时按 32 的倍数扩容（web 恒为 32）。
    const maxRows = Math.max(...byColumn.map((list) => list.length));
    slotStride =
      maxRows + ROW_OFFSET > slotStride
        ? Math.ceil((maxRows + ROW_OFFSET) / ROWS_PER_COLUMN) * ROWS_PER_COLUMN
        : ROWS_PER_COLUMN;
    const next: ArchiveRecord[] = [];
    byColumn.forEach((list, column) =>
      list.forEach((album) => next.push(toRecord(album, columns[column], next.length + 1))),
    );
    // 原地重建（保持数组引用）：records / archiveColumns / categories。
    records.splice(0, records.length, ...next);
    archiveColumns.splice(0, archiveColumns.length, ...columns);
    categories.splice(
      0,
      categories.length,
      "全部专辑",
      ...columns.filter((c) => c !== UNGENRED),
    );
    wallMode.hydrated = true;
    wallMode.truncated = truncated;
    return {
      ok: true,
      albums: next.length,
      columns: columns.length,
      truncated,
    };
  } catch (error) {
    return {
      ok: false,
      albums: 0,
      columns: 0,
      truncated: false,
      reason: error instanceof Error ? error.message : "hydrate failed",
    };
  }
}
