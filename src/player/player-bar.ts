import { createRollingText } from "@kitlangton/rolling-number";
import { playerStore, type PlayerSnapshot } from "./player-store";
import { LOOP_MODE_TEXT } from "./queue";
import { spectrumBridge } from "./spectrum-bridge";
import { FidelityBadges } from "./FidelityBadges";
import { lyricView } from "./lyrics/lyric-view";

/**
 * 底部最小播放条（任务书 M1 范围 C3）：
 * 曲目名（复用上游 createRollingText 滚动文字）、上一首/播放暂停/停止/下一首、循环模式三态钮、
 * 可拖拽 seek 进度条（mm:ss）、音量条（engine.volume float 语义）、错误 toast、保真徽章占位。
 *
 * 视觉语言全部取 theme-ui.ts 注入的 --theme-* 变量（亮暗自动跟随）；零新依赖；
 * pointer-events 自管，不干扰上游阵列拖动（只在自己的条内响应）。
 *
 * 本轮删除"档案号输入 + LOAD"（曲目一律由曲库/专辑详情点选）：手输 id 既没有队列归属、
 * 也没有真实时长，留着只是把错误用法摆在最显眼的位置。playerStore.play() 能力保留。
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
        <button type="button" class="pb-btn pb-prev" aria-label="上一首">⏮</button>
        <button type="button" class="pb-btn pb-toggle" aria-label="播放或暂停">▶</button>
        <button type="button" class="pb-btn pb-stop" aria-label="停止">■</button>
        <button type="button" class="pb-btn pb-next" aria-label="下一首">⏭</button>
        <button type="button" class="pb-btn pb-loop" aria-label="循环模式">
          <span class="pb-loop-icon" aria-hidden="true"></span><span class="pb-loop-sup" aria-hidden="true"></span><span class="pb-loop-text"></span>
        </button>
      </div>
      <div class="pb-progress" role="slider" tabindex="0" aria-label="播放进度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
        <div class="pb-rail"><div class="pb-fill"></div><div class="pb-knob"></div></div>
      </div>
      <div class="pb-times"><span class="pb-pos">00:00</span><span class="pb-sep">/</span><span class="pb-dur">03:00</span></div>
      <label class="pb-volume">
        <span class="pb-vol-icon" aria-hidden="true">VOL</span>
        <input type="range" min="0" max="1" step="0.01" value="1" aria-label="音量" />
      </label>
    </div>
    <div class="pb-spectrum" aria-hidden="true">${"<i></i>".repeat(16)}</div>
    <div class="pb-toast" role="status" hidden></div>
  `;

  const el = (selector: string) => root.querySelector<HTMLElement>(selector)!;
  const stateEl = el(".pb-state");
  const titleEl = el(".pb-title");
  const rollEl = el(".pb-title-roll");
  const badgesEl = el(".pb-badges");
  const prevEl = el(".pb-prev") as HTMLButtonElement;
  const toggleEl = el(".pb-toggle") as HTMLButtonElement;
  const stopEl = el(".pb-stop") as HTMLButtonElement;
  const nextEl = el(".pb-next") as HTMLButtonElement;
  const loopEl = el(".pb-loop") as HTMLButtonElement;
  const loopIconEl = el(".pb-loop-icon");
  const loopSupEl = el(".pb-loop-sup");
  const loopTextEl = el(".pb-loop-text");
  const progressEl = el(".pb-progress");
  const fillEl = el(".pb-fill");
  const knobEl = el(".pb-knob");
  const posEl = el(".pb-pos");
  const durEl = el(".pb-dur");
  const volumeInput = el(".pb-volume input") as HTMLInputElement;
  const toastEl = el(".pb-toast");
  const spectrumEl = root.querySelector<HTMLElement>(".pb-spectrum")!;
  const spectrumBars = Array.from(spectrumEl.querySelectorAll<HTMLElement>("i"));

  /** M3：本挂载内额外订阅的清理（随返回的 dispose 统一执行）。 */
  const spectrumCleanups: (() => void)[] = [];

  // M3 微型频谱条（任务书 C3）：16 根，bands_l 按对数距离抽稀，CSS transform scaleY；
  // rAF 自消：无新帧（>400ms）自然归零，不常驻动画帧。桌面/桩/web 统一消费 latestFrame。
  {
    let dirty = false;
    let raf = 0;
    const paint = () => {
      const frame = spectrumBridge.latestFrame();
      const fresh = frame !== null && performance.now() - frame.receivedAt < 400;
      for (let i = 0; i < spectrumBars.length; i++) {
        let level = 0;
        if (frame && fresh) {
          // 16 根 → 64 带的对数抽稀（低频段多分），取段内最大。
          const from = Math.floor(Math.pow(i / spectrumBars.length, 1.35) * 64);
          const to = Math.max(from + 1, Math.floor(Math.pow((i + 1) / spectrumBars.length, 1.35) * 64));
          for (let b = from; b < Math.min(to, 64); b++) level = Math.max(level, frame.bandsL[b]);
        }
        spectrumBars[i].style.transform = `scaleY(${Math.max(0.04, level).toFixed(3)})`;
      }
      dirty = false;
      raf = fresh || dirty ? requestAnimationFrame(paint) : 0;
    };
    const offFrame = spectrumBridge.onFrame(() => {
      dirty = true;
      if (!raf) raf = requestAnimationFrame(paint);
    });
    const offState = playerStore.subscribe((snapshot) => {
      // 停止/暂停时退场（归零由 fresh 超时自然完成）；订阅保留，重播无需重建。
      spectrumEl.dataset.active = snapshot.state === "playing" ? "1" : "0";
      if (!raf) raf = requestAnimationFrame(paint);
    });
    spectrumCleanups.push(offFrame, offState);
  }

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
  prevEl.addEventListener("click", () => void playerStore.previous());
  nextEl.addEventListener("click", () => void playerStore.next());
  // 三态循环钮：点一次进一档（顺序 → 专辑 → 单曲），文案/图标由订阅帧统一重绘。
  loopEl.addEventListener("click", () => playerStore.cycleLoopMode());

  // M5b：歌词展开按钮（样式在 lyrics/lyric-view.css，不动 player.css；面板状态由 lyricView 回调同步）。
  lyricView.attachButtonTo(root.querySelector<HTMLElement>(".pb-controls")!);

  volumeInput.addEventListener("input", () => {
    if (suppressVolumeEvent) return;
    void playerStore.setVolume(Number(volumeInput.value));
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

    // 队列只有一首（或无队列）时没有可去的地方：灰显上/下一首，避免点了没反应的死按钮。
    const skippable = snapshot.queueLength > 1;
    prevEl.disabled = !skippable;
    nextEl.disabled = !skippable;

    const loop = LOOP_MODE_TEXT[snapshot.loopMode];
    loopIconEl.textContent = loop.glyph;
    loopSupEl.textContent = loop.sup ?? "";
    loopTextEl.textContent = loop.label;
    loopEl.dataset.mode = snapshot.loopMode;
    loopEl.title = loop.hint;
    loopEl.setAttribute("aria-label", `${loop.hint}；点击切换`);

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
    for (const cleanup of spectrumCleanups) cleanup();
    spectrumCleanups.length = 0;
    playerStore.dispose();
    root.replaceChildren();
  };
}
