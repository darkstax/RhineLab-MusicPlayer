/**
 * M1 全局入口（任务书 C3）：挂底部播放条；M3 追加频谱桥（桌面环境下才接线）。
 * Wallpaper Engine 构建不挂播放条（其工作台另有媒体信息区），但频谱桥在 WE 下负责
 * 把桌面核心谱数据喂进上游 `window.rhineWallpaperSpectrum` 律动通道（shell 宿主内）。
 */
import "./player/player.css";
import { bridge } from "./desktop-bridge";
import { mountPlayerBar } from "./player/player-bar";
import { spectrumBridge } from "./player/spectrum-bridge";

if (bridge.desktop) {
  spectrumBridge.start();
}

if (import.meta.env.MODE !== "wallpaper") {
  const mount = () => {
    const host = document.getElementById("player-bar");
    if (host && !host.dataset.mounted) {
      host.dataset.mounted = "1";
      mountPlayerBar(host);
    }
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mount, { once: true });
  } else {
    mount();
  }
}
