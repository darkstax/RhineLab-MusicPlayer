import { bridge } from "../../desktop-bridge.ts";

/**
 * 曲库前端消费层（M5a，协议 v1.4 §5 library.*）：bridge caps 含 "library" 才启用。
 *
 * - 零上游侵入：不 import scene/main/data；面板由 library-panel.ts 自建 DOM 挂 body，
 *   接线（播放条按钮等）由主进程验收时统一做（m1-mount 是泳道 B 地盘）。
 * - web 模式（无 bridge / caps 无 library）：available=false，所有查询静默返回空结果，
 *   不抛异常、不发帧（与 lyric-view 同一降级纪律）。
 * - 数据只经类型化窄读取（协议字段可能为 null；未知类型 → null/0，绝不做载荷防御之外的假设）。
 */

export type TrackDto = {
  readonly id: number;
  readonly title: string | null;
  readonly artist: string | null;
  readonly album: string | null;
  readonly genre: string | null;
  readonly year: number | null;
  readonly track_no: number | null;
  readonly disc_no: number | null;
  readonly duration_ms: number | null;
  readonly codec: string | null;
  readonly sample_rate: number | null;
  readonly bit_depth: number | null;
  readonly channels: number | null;
  readonly bitrate: number | null;
  readonly cover_key: string | null;
  readonly lyric_state: "embedded" | "sidecar" | "none";
  readonly path: string | null;
};

export type AlbumDto = {
  readonly album_key: string;
  readonly title: string | null;
  readonly artist: string | null;
  readonly year: number | null;
  readonly genre: string | null;
  readonly disc_count: number;
  readonly track_count: number;
  readonly duration_ms: number;
  readonly cover_key: string | null;
  readonly formats: readonly string[];
  readonly bitrate_range: readonly [number, number] | null;
  readonly resolution: { readonly lossy: boolean; readonly sample_rate: number | null; readonly bit_depth: number | null };
};

export type LibraryStats = {
  readonly albums: number;
  readonly tracks: number;
  readonly genres: number;
  readonly roots: readonly string[];
  readonly last_scan_ms: number;
  readonly quarantine: number;
};

export type QueryPage<T> = { readonly total: number; readonly items: readonly T[] };

const EMPTY_TRACKS: QueryPage<TrackDto> = { total: 0, items: [] };
const EMPTY_ALBUMS: QueryPage<AlbumDto> = { total: 0, items: [] };
const EMPTY_STATS: LibraryStats = { albums: 0, tracks: 0, genres: 0, roots: [], last_scan_ms: 0, quarantine: 0 };

const num = (value: unknown, fallback = 0): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;
const str = (value: unknown): string | null => (typeof value === "string" ? value : null);
const numOrNull = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

function parseTrack(raw: unknown): TrackDto | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  return {
    id: num(o.id, -1),
    title: str(o.title),
    artist: str(o.artist),
    album: str(o.album),
    genre: str(o.genre),
    year: numOrNull(o.year),
    track_no: numOrNull(o.track_no),
    disc_no: numOrNull(o.disc_no),
    duration_ms: numOrNull(o.duration_ms),
    codec: str(o.codec),
    sample_rate: numOrNull(o.sample_rate),
    bit_depth: numOrNull(o.bit_depth),
    channels: numOrNull(o.channels),
    bitrate: numOrNull(o.bitrate),
    cover_key: str(o.cover_key),
    lyric_state: o.lyric_state === "embedded" || o.lyric_state === "sidecar" ? o.lyric_state : "none",
    path: str(o.path),
  };
}

function parseAlbum(raw: unknown): AlbumDto | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const formats = Array.isArray(o.formats) ? o.formats.filter((f): f is string => typeof f === "string") : [];
  const range = Array.isArray(o.bitrate_range) && o.bitrate_range.length === 2
    ? ([num(o.bitrate_range[0]), num(o.bitrate_range[1])] as const)
    : null;
  const resolutionRaw = (typeof o.resolution === "object" && o.resolution !== null ? o.resolution : {}) as Record<string, unknown>;
  return {
    album_key: str(o.album_key) ?? "",
    title: str(o.title),
    artist: str(o.artist),
    year: numOrNull(o.year),
    genre: str(o.genre),
    disc_count: num(o.disc_count, 1),
    track_count: num(o.track_count),
    duration_ms: num(o.duration_ms),
    cover_key: str(o.cover_key),
    formats,
    bitrate_range: range,
    resolution: { lossy: resolutionRaw.lossy === true, sample_rate: numOrNull(resolutionRaw.sample_rate), bit_depth: numOrNull(resolutionRaw.bit_depth) },
  };
}

/** cover_key（"sha1:<hex>"）→ 封面虚拟主机 URL（协议 §5.1：冒号换横杠；扩展名由壳侧魔数决定，
 * 先按 jpg——png 等变体的探测在 M5d 纹理管线里做，这里服务列表缩略图）。 */
export function coverUrl(coverKey: string | null): string | null {
  if (!coverKey || !coverKey.startsWith("sha1:")) return null;
  return `https://cover.rhine.local/${coverKey.replace(":", "-")}.jpg`;
}

type Listener = (state: LibraryStoreSnapshot) => void;

export type LibraryStoreSnapshot = {
  readonly available: boolean;
  readonly busy: boolean;
  readonly query: string;
  readonly tracks: QueryPage<TrackDto>;
  readonly albums: QueryPage<AlbumDto>;
  readonly stats: LibraryStats;
  readonly error: string | null;
  /** evt{library} 最近一帧（协议 §6；扫描进度显示用）。 */
  readonly scan: { phase: string; scanned: number; total: number; quarantine: number } | null;
};

/**
 * 单一状态仓库（player-store 同构）：query/albums/stats 消费 + lib:<id> 播放直通。
 * 扫描触发（UI 的"重新扫描"按钮）走 library.scan——ack 完成态即回填统计。
 */
export class LibraryStore {
  private snapshot: LibraryStoreSnapshot = {
    available: false,
    busy: false,
    query: "",
    tracks: EMPTY_TRACKS,
    albums: EMPTY_ALBUMS,
    stats: EMPTY_STATS,
    error: null,
    scan: null,
  };

  private readonly listeners = new Set<Listener>();
  private initialized = false;
  private queryTimer: ReturnType<typeof setTimeout> | null = null;
  private unsubscribe: (() => void)[] = [];
  /** 查询竞态令牌：只接受最新一次的响应（快速输入时旧响应不得覆盖新结果）。 */
  private querySeq = 0;

  get state(): LibraryStoreSnapshot {
    return this.snapshot;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.snapshot);
    return () => this.listeners.delete(listener);
  }

  private emit(patch: Partial<LibraryStoreSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of [...this.listeners]) listener(this.snapshot);
  }

  /** 握手后初始化（caps 判定；幂等）。web 模式 = available:false 零副作用。 */
  async init(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    if (!bridge.desktop) return; // web：静默不可用（任务书：零异常）
    const hello = await bridge.handshake();
    if (!hello.caps.includes("library")) {
      // 桩/旧壳：无曲库能力，全部静默降级（协议 §4 caps 交集纪律）。
      return;
    }
    this.unsubscribe.push(
      bridge.on("library", (frame) => {
        const data = (frame.data ?? {}) as Record<string, unknown>;
        if (typeof data.phase !== "string") return;
        this.emit({
          scan: {
            phase: data.phase,
            scanned: num(data.scanned),
            total: num(data.total),
            quarantine: num(data.quarantine),
          },
        });
      }),
    );
    this.emit({ available: true });
    await this.refreshStats();
  }

  async refreshStats(): Promise<void> {
    if (!this.snapshot.available) return;
    try {
      const raw = (await bridge.call("library.stats", {}, 8000)) as Record<string, unknown> | null;
      const roots = Array.isArray(raw?.roots) ? (raw!.roots as unknown[]).filter((r): r is string => typeof r === "string") : [];
      this.emit({
        stats: {
          albums: num(raw?.albums),
          tracks: num(raw?.tracks),
          genres: num(raw?.genres),
          roots,
          last_scan_ms: num(raw?.last_scan_ms),
          quarantine: num(raw?.quarantine),
        },
      });
    } catch {
      // 统计失败不打断 UI（下一次动作或重扫描会再试）
    }
  }

  /** 输入去抖查询（300ms）；立即查询用 runQuery。 */
  setQuery(q: string): void {
    this.emit({ query: q });
    if (this.queryTimer) clearTimeout(this.queryTimer);
    this.queryTimer = setTimeout(() => void this.runQuery(q), 300);
  }

  async runQuery(q: string): Promise<void> {
    if (!this.snapshot.available) return;
    const seq = ++this.querySeq;
    this.emit({ busy: true, error: null });
    try {
      const args = q.trim() ? { q: q.trim(), scope: "tracks", limit: 200 } : { scope: "tracks", limit: 200 };
      const raw = (await bridge.call("library.query", args, 15000)) as Record<string, unknown> | null;
      if (seq !== this.querySeq) return; // 旧响应丢弃
      const items = Array.isArray(raw?.items) ? (raw!.items as unknown[]).map(parseTrack).filter((t): t is TrackDto => t !== null) : [];
      this.emit({ busy: false, tracks: { total: num(raw?.total), items } });
    } catch (error) {
      if (seq !== this.querySeq) return;
      const code = (error as { code?: string }).code;
      const message =
        code === "library_unavailable" ? "曲库不可用（DB 损坏/占用）" : code === "library_busy" ? "扫描进行中，请稍候" : "曲库查询失败";
      this.emit({ busy: false, error: `${message}（${code ?? "unknown"}）`, tracks: EMPTY_TRACKS });
    }
    if (q.trim()) {
      try {
        const rawAlbums = (await bridge.call("library.query", { q: q.trim(), scope: "albums", limit: 50 }, 15000)) as Record<string, unknown> | null;
        if (seq !== this.querySeq) return;
        const albumItems = Array.isArray(rawAlbums?.items)
          ? (rawAlbums!.items as unknown[]).map(parseAlbum).filter((a): a is AlbumDto => a !== null)
          : [];
        this.emit({ albums: { total: num(rawAlbums?.total), items: albumItems } });
      } catch {
        this.emit({ albums: EMPTY_ALBUMS });
      }
    } else {
      this.emit({ albums: EMPTY_ALBUMS });
    }
  }

  async scan(full = false): Promise<void> {
    if (!this.snapshot.available || this.snapshot.busy) return;
    this.emit({ busy: true, error: null, scan: { phase: "start", scanned: 0, total: 0, quarantine: 0 } });
    try {
      const raw = (await bridge.call("library.scan", { full }, 120_000)) as Record<string, unknown> | null;
      const rate = num(raw?.failure_rate);
      this.emit({
        busy: false,
        scan: {
          phase: "done",
          scanned: num(raw?.scanned),
          total: num(raw?.scanned),
          quarantine: num(raw?.failed),
        },
        ...(typeof raw?.warning === "string"
          ? { error: `部分文件读取异常（失败率 ${(rate * 100).toFixed(2)}%，已入隔离清单）` }
          : {}),
      });
      await this.refreshStats();
      if (this.snapshot.query) await this.runQuery(this.snapshot.query);
    } catch (error) {
      const code = (error as { code?: string }).code;
      this.emit({ busy: false, error: code === "library_busy" ? "扫描已在进行中" : "扫描失败，详见日志" });
    }
  }

  /** 播放委托（解耦 seam）：默认动态 import player-store（浏览器/vite 可用）；
   * node --test 环境 import 链会因 player-store 的无扩展名 import 解析失败——
   * setPlayDelegate 注入替身即可测（零改既有文件，泳道纪律）。 */
  private playDelegate: ((trackId: string, durationMs: number) => void) | null = null;

  setPlayDelegate(fn: ((trackId: string, durationMs: number) => void) | null): void {
    this.playDelegate = fn;
  }

  /** 点行播放（任务书消费入口）：lib:<id> 由壳解析成 file:<path>（协议 §5.1）。 */
  playTrack(track: TrackDto): void {
    const id = `lib:${track.id}`;
    const durationMs = (track.duration_ms ?? 180_000) || 180_000;
    if (this.playDelegate) {
      this.playDelegate(id, durationMs);
      return;
    }
    void import("../player-store.ts")
      .then(({ playerStore }) => playerStore.play(id, durationMs))
      .catch(() => {
        // 理论上浏览器不可达（同源模块）；测试/异常环境静默不崩 UI。
      });
  }

  dispose(): void {
    for (const off of this.unsubscribe) off();
    this.unsubscribe.length = 0;
    this.listeners.clear();
    if (this.queryTimer) clearTimeout(this.queryTimer);
    this.initialized = false;
  }
}

export const libraryStore = new LibraryStore();

// 诊断/E2E 入口（与 __rhinePlayer/__rhineBridge 同一思路：只暴露读）。
declare global {
  interface Window {
    __rhineLibrary?: { snapshot(): LibraryStoreSnapshot };
  }
}
if (typeof window !== "undefined") {
  window.__rhineLibrary = { snapshot: () => libraryStore.state };
}
