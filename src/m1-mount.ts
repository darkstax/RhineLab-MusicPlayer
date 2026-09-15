/**
 * M1 全局入口（任务书 C3）：挂底部播放条；M3 追加频谱桥（桌面环境下才接线）。
 * Wallpaper Engine 构建不挂播放条（其工作台另有媒体信息区），但频谱桥在 WE 下负责
 * 把桌面核心谱数据喂进上游 `window.rhineWallpaperSpectrum` 律动通道（shell 宿主内）。
 *
 * M5b 追加：歌词面板接线——订阅 playerStore（position 驱动滚动、track 变化时经
 * `library.get` 取 lyric_text、stop 清除任务栏上行）；web 模式全部静默降级。
 */
import "./player/player.css";
import "./player/lyrics/lyric-view.css";
import { bridge } from "./desktop-bridge";
import { mountPlayerBar } from "./player/player-bar";
import { playerStore } from "./player/player-store";
import { spectrumBridge } from "./player/spectrum-bridge";
import { lyricView } from "./player/lyrics/lyric-view";
import { albumWall, wallSession } from "./player/covers/album-wall";
import { hydrateFromLibrary } from "./data";
import { mountLibraryPanel } from "./player/library/library-panel";
import { initMusicSettings } from "./settings/groups";
// M6 设置三层 UI（壁纸构建无此面板，跳过观察器）：web=localStorage 镜像仅本机；desktop=壳 config 落盘。
if (import.meta.env.MODE !== "wallpaper") initMusicSettings();

if (bridge.desktop) {
  spectrumBridge.start();
  // M5d：专辑墙数据层水合（caps 无 library 的旧壳/桩 → hydrate 内部 stats 失败回退
  // 演示数据，不抛异常）。main.ts 在首帧前 await wallSession.hydration。
  wallSession.hydration = (async () => {
    const result = await hydrateFromLibrary(bridge).catch((error) => ({
      ok: false,
      albums: 0,
      columns: 0,
      truncated: false,
      reason: error instanceof Error ? error.message : "hydrate crashed",
    }));
    return result;
  })();
  // 封面三态配置（壳 config.get wall.covers；失败回退 localStorage）。
  void albumWall.loadConfig();
  // M5A-FINDINGS P2-5 归还：曲库面板接线（自挂载契约；caps 就绪才建 DOM）。
  mountLibraryPanel();
}

/**
 * 协议 v1.4 §5：engine.play 的 lib:<track_id> 前缀 → library.get 数字 id。其它来源无库条目。
 *
 * R6（用户实测）：此前只取歌词、不取标题，播放条于是显示 `ARCHIVE lib:1143`（原始 track_id）
 * 而不是真实歌名。现在一次 library.get 同时补**标题**与**歌词**——不多一次往返。
 * 标题回填走 playerStore.setTrackLabel（用户选曲后瞬时显示 id，随即被真名覆盖）。
 */
function loadTrackMeta(trackId: string | null): void {
  const match = trackId ? /^lib:(\d+)$/.exec(trackId) : null;
  if (!match) {
    lyricView.setText(null);
    return;
  }
  bridge
    .call("library.get", { id: Number(match[1]) })
    .then((result) => {
      const dto = result as { lyric_text?: unknown; title?: unknown; artist?: unknown } | null;
      const text = dto?.lyric_text;
      lyricView.setText(typeof text === "string" ? text : null);
      // 标题：title（无则回退 id）；有 artist 时拼成「歌名 · 艺术家」便于确认选中的是哪首。
      const title = typeof dto?.title === "string" && dto.title.trim() ? dto.title.trim() : null;
      const artist = typeof dto?.artist === "string" && dto.artist.trim() ? dto.artist.trim() : null;
      if (title) playerStore.setTrackLabel(artist ? `${title} · ${artist}` : title);
    })
    .catch(() => lyricView.setText(null)); // 壳未就绪/查询失败：空态，不打断播放
}

function mountLyricWiring(): void {
  let lastTrackId: string | null | undefined;
  let lastState = playerStore.state.state;
  playerStore.subscribe((snapshot) => {
    if (snapshot.trackId !== lastTrackId) {
      lastTrackId = snapshot.trackId;
      loadTrackMeta(snapshot.trackId);
    }
    // 只在停止/待机是**转移**发生时清除（1Hz ticker 反复 emit 同状态不得重复 clear）。
    if (snapshot.state !== lastState) {
      if (snapshot.state === "stopped" || snapshot.state === "idle") lyricView.clear();
      // P1-2：进入播放态显式解除 clear() 闩锁——停止后重播同一曲不会触发
      // setText（trackId 未变），没有这一步歌词会永久空白。
      if (snapshot.state === "playing" || snapshot.state === "paused") {
        lyricView.setPlaybackActive(true);
      }
      lastState = snapshot.state;
    }
    // 审查 P1-1：停止后引擎把 position 归 0（FakeEngine/engine.cpp 既定语义），
    // 紧随的 setPosition(0) 会把首行写回、任务栏歌词复活——非播放态短路位置驱动。
    if (snapshot.state === "playing" || snapshot.state === "paused") {
      lyricView.setPosition(snapshot.positionMs);
    }
  });
}

if (import.meta.env.MODE !== "wallpaper") {
  const mount = () => {
    const host = document.getElementById("player-bar");
    if (host && !host.dataset.mounted) {
      host.dataset.mounted = "1";
      mountPlayerBar(host);
      mountLyricWiring();
    }
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mount, { once: true });
  } else {
    mount();
  }
}
