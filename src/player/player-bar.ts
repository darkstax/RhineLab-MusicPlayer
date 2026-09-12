import { createRollingText } from "@kitlangton/rolling-number";
import { playerStore, type PlayerSnapshot } from "./player-store";
import { FidelityBadges } from "./FidelityBadges";

/**
 * 底部最小播放条（任务书 M1 范围 C3）：
 * 曲目名（复用上游 createRollingText 滚动文字）、播放/暂停/停止钮、可拖拽 seek 进度条（mm:ss）、
 * 音量条（engine.volume float 语义）、错误 toast、保真徽章占位。
 *
 * 视觉语言全部取 theme-ui.ts 注入的 --theme-* 变量（亮暗自动跟随）；零新依赖；
 * pointer-events 自管，不干扰上游阵列拖动（只在自己的条内响应）。
 */

const reducedMotion = () =>
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** 时长格式化：与上游工作台 durationText 同思路（mm:ss，四舍五入到秒），此处独立实现不 import 上游。 */
export function durationText(ms: number): string {
  const seconds = Math.ceil(Math.max(0, ms) / 1000);
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

const STATE_LABEL: Record<PlayerSnapshot["state"], string> = {
  idle: "IDLE",
  playing: "PLAYING",
  paused: "PAUSED",
  stopped: "STOPPED",
};

/**
 * UI 修复：滚动文字组件的视觉层是绝对定位子元素，CSS ellipsis 对它无效（硬裁无“…”），
 * 故在喂给组件前先按容器可用宽度用 canvas 测量截断——移植上游 workbench-rolling.ts
 * fitMediaText 的二分套路，但宽度基准取 .pb-title 自身 clientWidth（上游取 parentElement）。
 */
const textMeasure = document.createElement("canvas").getContext("2d");
function fitTitleText(element: HTMLElement, text: string): string {
  element.title = text; // 全文可达（同上游 title 约定）
  if (!textMeasure) return text;
  const width = element.clientWidth;
  if (!width) return text;
  const style = getComputedStyle(element);
  textMeasure.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
  const spacing = parseFloat(style.letterSpacing) || 0;
  const measure = (value: string) =>
    textMeasure.measureText(value).width + [...value].length * spacing;
  if (measure(text) <= width) return text;
  const chars = [...text];
  let low = 0,
    high = chars.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (measure(chars.slice(0, mid).join("") + "…") <= width) low = mid;
    else high = mid - 1;
  }
  return chars.slice(0, low).join("") + "…";
}

export function mountPlayerBar(root: HTMLElement): () => void {
  root.hidden = true;
  root.setAttribute("aria-label", "播放控制条");

  root.innerHTML = `
    <div class="pb-main">
      <div class="pb-identity">
        <span class="pb-state" data-state="idle">IDLE</span>
        <span class="pb-title" aria-live="polite"><span class="pb-title-roll"></span></span>
        <span class="pb-badges"></span>
      </div>
      <div class="pb-controls">
        <button type="button" class="pb-btn pb-toggle" aria-label="播放或暂停">▶</button>
        <button type="button" class="pb-btn pb-stop" aria-label="停止">■</button>
      </div>
      <div class="pb-progress" role="slider" tabindex="0" aria-label="播放进度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
        <div class="pb-rail"><div class="pb-fill"></div><div class="pb-knob"></div></div>
      </div>
      <div class="pb-times"><span class="pb-pos">00:00</span><span class="pb-sep">/</span><span class="pb-dur">03:00</span></div>
      <label class="pb-volume">
        <span class="pb-vol-icon" aria-hidden="true">VOL</span>
        <input type="range" min="0" max="1" step="0.01" value="1" aria-label="音量" />
      </label>
      <div class="pb-load">
        <input type="text" class="pb-id" placeholder="档案号 · X-001" aria-label="档案号（即曲目 id）" />
        <button type="button" class="pb-btn pb-play-btn">LOAD</button>
      </div>
    </div>
    <div class="pb-toast" role="status" hidden></div>
  `;

  const el = (selector: string) => root.querySelector<HTMLElement>(selector)!;
  const stateEl = el(".pb-state");
  const titleEl = el(".pb-title");
  const rollEl = el(".pb-title-roll");
  const badgesEl = el(".pb-badges");
  const toggleEl = el(".pb-toggle") as HTMLButtonElement;
  const stopEl = el(".pb-stop") as HTMLButtonElement;
  const progressEl = el(".pb-progress");
  const fillEl = el(".pb-fill");
  const knobEl = el(".pb-knob");
  const posEl = el(".pb-pos");
  const durEl = el(".pb-dur");
  const volumeInput = el(".pb-volume input") as HTMLInputElement;
  const idInput = el(".pb-id") as HTMLInputElement;
  const playBtn = el(".pb-play-btn") as HTMLButtonElement;
  const toastEl = el(".pb-toast");

  // 曲目名用上游同款滚动文字（direct / 同时启动 / 460ms，与主标题一致）。
  // UI 修复（用户定方向）：组件挂在**内层 .pb-title-roll**（按内容宽），外层 .pb-title 是
  // 150px 窗口；内容溢出时挂 pb-overflow 类由 CSS 跑马灯来回滚动，悬停暂停；
  // reduced-motion 降级为截断加省略号（fitTitleText）。title 属性永远给全文。
  const rolling = createRollingText(rollEl, {
    text: playerStore.state.trackLabel,
    duration: 460,
    motionBlur: !reducedMotion(),
    animated: !reducedMotion(),
    transition: "direct",
    stagger: "none",
  });

  const badges = new FidelityBadges(badgesEl);

  let lastLabel: string | null = null; // 哨兵：首帧 subscribe 必须跑一次 applyTitle（溢出测量要等 visible 后才有真实宽度）。
  let dragging = false;
  let suppressVolumeEvent = false;

  const ratioFromEvent = (event: PointerEvent | KeyboardEvent) => {
    const rect = progressEl.getBoundingClientRect();
    if ("clientX" in event && typeof event.clientX === "number" && rect.width > 0) {
      return Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    }

    return null;
  };

  const seekFrom = async (event: PointerEvent) => {
    const ratio = ratioFromEvent(event);
    if (ratio === null) return;
    const snapshot = playerStore.state;
    const target = Math.round(ratio * snapshot.durationMs);
    posEl.textContent = durationText(target);
    fillEl.style.width = `${ratio * 100}%`;
    knobEl.style.left = `${ratio * 100}%`;
    await playerStore.seek(target);
  };

  progressEl.addEventListener("pointerdown", (event) => {
    dragging = true;
    progressEl.setPointerCapture(event.pointerId);
    void seekFrom(event);
  });
  progressEl.addEventListener("pointermove", (event) => {
    if (dragging) void seekFrom(event);
  });
  progressEl.addEventListener("pointerup", (event) => {
    if (!dragging) return;
    dragging = false;
    progressEl.releasePointerCapture(event.pointerId);
    void seekFrom(event);
  });
  progressEl.addEventListener("keydown", (event) => {
    const snapshot = playerStore.state;
    const step = event.key === "ArrowRight" ? 5000 : event.key === "ArrowLeft" ? -5000 : 0;
    if (step !== 0) {
      event.preventDefault();
      void playerStore.seek(snapshot.positionMs + step);
    } else if (event.key === "Home") {
      event.preventDefault();
      void playerStore.seek(0);
    } else if (event.key === "End") {
      event.preventDefault();
      void playerStore.seek(snapshot.durationMs);
    }
  });

  toggleEl.addEventListener("click", () => void playerStore.toggle());
  stopEl.addEventListener("click", () => void playerStore.stop());

  volumeInput.addEventListener("input", () => {
    if (suppressVolumeEvent) return;
    void playerStore.setVolume(Number(volumeInput.value));
  });

  const loadTrack = () => {
    let id = idInput.value.trim();
    if (!id) {
      // 降级接线（任务书 C4：archive 事件不可达 → 不侵入上游）：输入为空时读主界面
      // 当前选中档案号，演示“档案即曲目”。#selected-id 内嵌 Rolling Number，
      // textContent 会混入测量/动画节点，所以取“X-”前缀 + .rn-value 的数字部分。
      const code = document.querySelector("#selected-id .rn-value")?.textContent?.trim();
      id = code ? `X-${code}` : (document.getElementById("selected-id")?.textContent?.trim() ?? "");
      if (id) idInput.value = id;
    }

    if (id) void playerStore.play(id);
  };
  playBtn.addEventListener("click", loadTrack);
  idInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") loadTrack();
  });

  const unsubscribe = playerStore.subscribe((snapshot) => {
    root.hidden = false;

    stateEl.dataset.state = snapshot.state;
    stateEl.textContent = `${snapshot.engine === "local" ? "LOCAL · " : ""}${STATE_LABEL[snapshot.state]}`;

    if (snapshot.trackLabel !== lastLabel) {
      lastLabel = snapshot.trackLabel;
      const text = snapshot.trackLabel;
      titleEl.title = text; // 全文可达（悬停 tooltip）
      rolling.update({
        // reduced-motion 降级：无滚动时用 canvas 截断补“…”（fit 基准=外层 150px 窗口）；
        // 否则全文交给内层组件，溢出部分由跑马灯展示。
        text: reducedMotion() ? fitTitleText(titleEl, text) : text,
        animated: !reducedMotion(),
      });
      // 溢出测量要等组件渲染完成（rAF 后下一帧布局就绪）；悬停暂停在 CSS 里。
      if (!reducedMotion()) {
        requestAnimationFrame(() => {
          const dist = rollEl.offsetWidth - titleEl.clientWidth;
          if (dist > 1) {
            titleEl.style.setProperty("--pb-roll-dist", `${-(dist + 4)}px`);
            titleEl.style.setProperty("--pb-roll-dur", `${Math.max(4, (dist + 4) / 14)}s`); // ≈14px/s
            titleEl.classList.add("pb-overflow");
          } else {
            titleEl.classList.remove("pb-overflow");
          }
        });
      } else {
        titleEl.classList.remove("pb-overflow");
      }
    }

    const ratio = snapshot.durationMs > 0 ? Math.min(1, snapshot.positionMs / snapshot.durationMs) : 0;
    if (!dragging) {
      fillEl.style.width = `${ratio * 100}%`;
      knobEl.style.left = `${ratio * 100}%`;
      posEl.textContent = durationText(snapshot.positionMs);
    }

    durEl.textContent = durationText(snapshot.durationMs);
    progressEl.setAttribute("aria-valuenow", String(Math.round(ratio * 100)));
    toggleEl.textContent = snapshot.state === "playing" ? "❚❚" : "▶";
    toggleEl.setAttribute("aria-label", snapshot.state === "playing" ? "暂停" : "播放");

    if (document.activeElement !== volumeInput) {
      suppressVolumeEvent = true;
      volumeInput.value = String(snapshot.volume);
      suppressVolumeEvent = false;
    }

    badges.render(snapshot.negotiated, snapshot.badges);

    toastEl.hidden = snapshot.error === null;
    if (snapshot.error !== null) toastEl.textContent = snapshot.error;
  });

  void playerStore.refresh();

  return () => {
    unsubscribe();
    playerStore.dispose();
    root.replaceChildren();
  };
}
