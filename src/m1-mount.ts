/**
 * M1 全局入口（任务书 C3）：挂底部播放条。main.ts 不改；
 * M1 结束（M2 起接入正式生命周期）后，本入口整体接管或删除。
 * Wallpaper Engine 构建不挂（其工作台另有媒体信息区）。
 */
import "./player/player.css";
import { mountPlayerBar } from "./player/player-bar";

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
