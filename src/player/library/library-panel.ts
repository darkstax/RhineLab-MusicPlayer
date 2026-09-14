import { libraryStore, coverUrl, type TrackDto } from "./library-store.ts";

/**
 * 曲库列表面板（M5a）：极简消费 UI——搜索框 + 曲目行（序号/标题/艺术家/专辑/时长），
 * 点行 → playerStore.play(`lib:${id}`)（经 library-store.playTrack）。
 *
 * 零侵入契约（任务书）：mountLibraryPanel() 自建 DOM 到 body、自带样式类前缀 rl-lib，
 * 不改任何既有前端文件；主进程验收时才在 m1-mount/播放条挂入口。web 模式（caps 无
 * library）默认不挂载、不查询、零异常；显式传入 {force:true} 也只显示不可用态。
 *
 * 视觉：--theme-* 变量自动跟随明暗（与 lyric-view/player-bar 同一语言）；细线、
 * 近黑/暖灰、backdrop blur，不引入新依赖。
 */

const prefersReducedMotion = () =>
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

function durationText(ms: number | null): string {
  const seconds = Math.ceil(Math.max(0, ms ?? 0) / 1000);
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** 挂到 body 的曲目列表浮层；返回卸载函数（移除 DOM 与全部订阅）。
 * caps 判定异步（握手后才知道有没有 library）：web/桩环境永不建 DOM（零副作用），
 * 桌面环境握手完成后自动挂载；unmount 可在任一时点安全调用。 */
export function mountLibraryPanel(options: { force?: boolean } = {}): () => void {
  let unsubs: (() => void)[] = [];
  let disposed = false;
  let detach: (() => void) | null = null;

  const attach = () => {
    if (disposed || detach !== null) return;
    detach = buildPanel();
  };

  void libraryStore.init().then(() => {
    if (libraryStore.state.available || options.force) attach();
    // 不可用（web/无 caps）：保持不建 DOM；订阅 available 变化兜底（壳后接曲库）
    else {
      const off = libraryStore.subscribe((state) => {
        if (state.available) {
          off();
          attach();
        }
      });
      unsubs.push(off);
    }
  });

  return () => {
    disposed = true;
    detach?.();
    for (const off of unsubs) off();
    unsubs = [];
  };
}

function buildPanel(): () => void {
  let unsubs: (() => void)[] = [];

  const root = el("aside", "rl-lib");
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-label", "音乐库");

  const head = el("header", "rl-lib-head");
  head.append(el("span", "rl-lib-title", "MUSIC LIBRARY"));
  const stats = el("span", "rl-lib-stats");
  const close = el("button", "rl-lib-close", "✕");
  close.type = "button";
  close.setAttribute("aria-label", "关闭音乐库");
  head.append(stats, close);

  const search = el("input", "rl-lib-search");
  search.type = "search";
  search.placeholder = "搜索曲目 / 艺术家 / 专辑（≥3 字子串，拉丁整词，短词 LIKE）";
  search.setAttribute("aria-label", "搜索曲库");

  const bar = el("div", "rl-lib-bar");
  const hint = el("span", "rl-lib-hint");
  const rescan = el("button", "rl-lib-rescan", "重新扫描");
  rescan.type = "button";
  bar.append(hint, rescan);

  const list = el("div", "rl-lib-list");
  list.setAttribute("role", "list");

  root.append(head, search, bar, list);
  document.body.append(root);

  let lastRendered: TrackDto[] | null = null;

  function renderTracks(tracks: readonly TrackDto[], busy: boolean): void {
    const items = tracks as TrackDto[];
    if (lastRendered === items && !busy) return; // 浅比较：store 每查询生成新数组
    lastRendered = items;
    list.replaceChildren();
    for (const track of items) {
      const row = el("div", "rl-lib-row");
      row.setAttribute("role", "listitem");
      row.tabIndex = 0;
      const no = el("span", "rl-lib-no", String(track.track_no ?? "—").padStart(2, "0"));
      const title = el("span", "rl-lib-track", track.title ?? track.path ?? "(未命名)");
      if (track.title) title.title = `${track.artist ?? "?"} — ${track.album ?? "?"}`;
      const artist = el("span", "rl-lib-artist", track.artist ?? "—");
      const album = el("span", "rl-lib-album", track.album ?? "—");
      const meta = el("span", "rl-lib-meta", `${track.codec ?? "?"}${track.bit_depth ? `/${track.bit_depth}bit` : ""}`);
      const dur = el("span", "rl-lib-dur", durationText(track.duration_ms));
      if (track.cover_key) {
        const img = el("img", "rl-lib-cover");
        img.alt = "";
        img.loading = "lazy";
        // 协议 §5.1 扩展名 jpg|png 两态（封面魔数嗅探，本机多数为 png）：
        // 先 .jpg，失败换 .png，再失败移除（不留破图占位）。
        const base = coverUrl(track.cover_key)!.replace(/\.jpg$/, "");
        img.src = base + ".jpg";
        img.addEventListener("error", () => {
          if (img.dataset.tried === "jpg") img.remove();
          else { img.dataset.tried = "jpg"; img.src = base + ".png"; }
        });
        row.append(img);
      }
      row.append(no, title, artist, album, meta, dur);
      const play = () => libraryStore.playTrack(track);
      row.addEventListener("click", play);
      row.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          play();
        }
      });
      list.append(row);
    }
    if (items.length === 0 && !busy) {
      list.append(el("div", "rl-lib-empty", "无匹配曲目（首次使用请先「重新扫描」）"));
    }
  }

  unsubs.push(
    libraryStore.subscribe((state) => {
      renderTracks(state.tracks.items, state.busy);
      stats.textContent = `${state.stats.tracks} 曲 · ${state.stats.albums} 专辑 · ${state.stats.genres} 流派`;
      const scan = state.scan;
      hint.textContent = state.error
        ? state.error
        : state.busy
          ? scan && scan.phase === "progress"
            ? `扫描中 ${scan.scanned}/${scan.total}…`
            : "处理中…"
          : scan && scan.phase === "done" && state.tracks.total === 0
            ? `扫描完成（${scan.scanned} 文件，隔离 ${scan.quarantine}）`
            : state.tracks.total > 0
              ? `${state.tracks.total} 条结果`
              : `共 ${state.stats.tracks} 曲`;
      rescan.disabled = state.busy;
    }),
  );

  let composing = false;
  search.addEventListener("compositionstart", () => (composing = true));
  search.addEventListener("compositionend", () => {
    composing = false;
    libraryStore.setQuery(search.value);
  });
  search.addEventListener("input", () => {
    if (!composing) libraryStore.setQuery(search.value);
  });
  rescan.addEventListener("click", () => void libraryStore.scan(false));
  close.addEventListener("click", () => {
    root.classList.toggle("rl-lib-closed");
  });
  const onKey = (event: KeyboardEvent) => {
    if (event.key === "Escape" && !root.classList.contains("rl-lib-closed")) root.classList.add("rl-lib-closed");
  };
  document.addEventListener("keydown", onKey);

  // 初次填充：无查询时展示前 200 曲（全库浏览）。
  void libraryStore.runQuery("");

  return () => {
    for (const off of unsubs) off();
    unsubs = [];
    document.removeEventListener("keydown", onKey);
    root.remove();
    lastRendered = null;
  };
}


/** 焦点陷阱之外——reduced-motion 时列表直接跳变无过渡（类挂根，CSS 消费）。 */
if (prefersReducedMotion() && typeof document !== "undefined") {
  document.documentElement.dataset.rlLibReduced = "1";
}
