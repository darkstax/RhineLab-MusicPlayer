import { bridge } from "../../desktop-bridge.ts";
import {
  annotatePairs,
  findLineIndex,
  parseLrc,
  taskbarPair,
  type LyricLine,
  type LyricMeta,
  type LyricParseResult,
} from "./lrc.ts";

/**
 * 歌词面板（M5b 泳道 B）：当前行高亮 + 平滑滚动居中 + 上下上下文行淡出。
 * - 数据源：`library.get{id}` 的 `lyric_text`（协议 v1.4 §5，desktop 桥可用时，由
 *   m1-mount.ts 取回后调 `setText()`）；冒烟/降级场景同样用 `setText()` 注入。
 * - 进度源：playerStore.positionMs —— 本模块**不 import player-store**（保持单向依赖、
 *   便于 headless 冒烟与复用），由 m1-mount.ts 订阅后调用 `setPosition(ms)` 驱动。
 * - 行变化时 `bridge.call("lyric.show",{primary,secondary})` fire-and-forget，catch 吞掉；
 *   web 模式 bridge.call 以 not_desktop reject，同样静默零异常（协议：空串=清除）。
 * - 视觉全部取 --theme-* 变量（亮暗自动跟随），风格延续上游工作台/解密面板（细线、
 *   近黑/暖灰、backdrop blur、竖线刻度），不 import scene。
 *
 * 可测性：本模块**不 import css**（样式由入口 m1-mount.ts 统一引入），因此
 * node --test 能直接加载本文件验证 lyric.show 静默降级路径（任务书验收 5）。
 */

const EMPTY_META: LyricMeta = {
  title: null,
  artist: null,
  album: null,
  author: null,
  lyricist: null,
  offsetMs: 0,
  watermarkFiltered: false,
};

export type LyricViewStats = {
  mounted: boolean;
  open: boolean;
  lineCount: number;
  skipped: number;
  activeIndex: number;
  watermarkFiltered: boolean;
  offsetMs: number;
  lyricShownCalls: number;
  lastLyricShown: { primary: string; secondary: string } | null;
  bridgeAbsentSilent: boolean;
};

const reducedMotion = () =>
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** 空态文案（与 go-musicfox「暂无歌词」一致）。 */
const EMPTY_TEXT = "暂无歌词";

declare global {
  interface Window {
    /** 冒烟/E2E 只读入口（与 __rhinePlayer/__rhineBridge 同一思路）。 */
    __rhineLyric?: LyricView;
  }
}

export class LyricView {
  private root: HTMLElement | null = null;
  private body: HTMLElement | null = null;
  private caption: HTMLElement | null = null;
  private parseResult: LyricParseResult = { lines: [], meta: { ...EMPTY_META }, skipped: 0 };
  private activeIndex = -1;
  /** -1 = 尚未收到进度（setText 时不自发驱动，避免越级上行 lyric.show）。 */
  private lastPositionMs = -1;
  private lyricShownCalls = 0;
  private lastLyricShown: { primary: string; secondary: string } | null = null;
  /** 去重基准：仅在上行内容变化时发 lyric.show（含切曲后清空为 "",""）。 */
  private lastSent = { primary: "", secondary: "" };
  private bridgeAbsentSilent = false;
  /** P1-1 纵深：clear() 后抑制位置驱动，直到 setText（新曲/新词）解除——
   *  否则 stop→position:0 会把首行写回、任务栏歌词"复活"（m1-mount 已有守卫，
   *  此处兜底并使之可单测）。 */
  private clearedSilent = false;
  private open = false;
  private onToggle: (() => void) | null = null;

  /** 注入歌词全文并立即重渲染（m1-mount 取 lyric_text 后调用；冒烟用同一公开 API）。 */
  setText(text: string | null): void {
    this.parseResult = text && text.trim() ? parseLrc(text) : { lines: [], meta: { ...EMPTY_META }, skipped: 0 };
    this.activeIndex = -1;
    this.clearedSilent = false;  // 新词到位 = 解除 clear() 抑制
    this.render();
    // 用已收到的最新进度对齐（setPosition 自带行比较，行未变不会重发上行）；
    // 尚未收到进度（冒烟直接 setText）时保持静默。
    if (this.lastPositionMs >= 0) this.setPosition(this.lastPositionMs);
  }

  /** 按当前播放位置刷新高亮、滚动与任务栏上行（面板收起时仍上行——任务栏歌词不依赖面板可见）。 */
  setPosition(positionMs: number): void {
    if (!Number.isFinite(positionMs) || positionMs < 0) return;
    // clear() 后、新词到位前的残留驱动（stop 的 position:0）不得复活歌词。
    if (this.clearedSilent) return;
    this.lastPositionMs = positionMs;
    const index = findLineIndex(this.parseResult.lines, positionMs);
    if (index !== this.activeIndex) {
      this.activeIndex = index;
      this.highlight();
    }
    // index>=0 → 当前行；-1（首行前/无词/切曲）→ 空串清除；与已发内容一致则不重发。
    const { primary, secondary } = taskbarPair(this.parseResult.lines, index);
    if (primary !== this.lastSent.primary || secondary !== this.lastSent.secondary) {
      this.sendLyricShow(primary, secondary);
    }
  }

  /** 停止/无词时清除高亮并通知壳清空任务栏。 */
  clear(): void {
    this.clearedSilent = true;
    if (this.activeIndex !== -1) {
      this.activeIndex = -1;
      this.highlight();
    }
    if (this.lastSent.primary !== "" || this.lastSent.secondary !== "") {
      this.sendLyricShow("", "");
    }
    this.lastPositionMs = -1;  // 旧进度作废：setText 不得据它立刻复活首行
  }

  toggle(): void {
    this.setOpen(!this.open);
  }

  isOpen(): boolean {
    return this.open;
  }

  setOpen(open: boolean): void {
    if (this.open === open && this.root !== null) {
      this.onToggle?.();
      return;
    }
    this.open = open;
    if (open) {
      this.mountDom();
      if (this.root) this.root.hidden = false;
      this.render();
      // 展开后用当前进度重新对齐（面板收起期间 position 仍消费，此处仅防漏刷）。
      if (this.lastPositionMs >= 0) {
        const saved = this.lastPositionMs;
        this.lastPositionMs = -1;
        this.activeIndex = -1;
        this.setPosition(saved);
      }
    } else if (this.root) {
      this.root.hidden = true;
    }
    this.onToggle?.();
  }

  /** 播放条歌词按钮入口（样式沿用播放条 pb-btn 体系，不新增 css 文件归属歧义）。 */
  attachButtonTo(container: HTMLElement): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "pb-btn pb-lyric";
    button.setAttribute("aria-label", "展开或收起歌词");
    button.setAttribute("aria-expanded", String(this.open));
    button.textContent = "词";
    button.addEventListener("click", () => this.toggle());
    container.appendChild(button);
    this.setToggleListener(() => {
      button.setAttribute("aria-expanded", String(this.open));
      button.classList.toggle("pb-lyric-active", this.open);
    });
    this.onToggle?.();
    return button;
  }

  /** 面板开关状态回调（player-bar 用它同步按钮态）。 */
  setToggleListener(fn: () => void): void {
    this.onToggle = fn;
  }

  /** 只读诊断（headless 冒烟据此断言行数/当前行/lyric.show 上行与静默降级）。 */
  stats(): LyricViewStats {
    return {
      mounted: this.root !== null,
      open: this.open,
      lineCount: this.parseResult.lines.length,
      skipped: this.parseResult.skipped,
      activeIndex: this.activeIndex,
      watermarkFiltered: this.parseResult.meta.watermarkFiltered,
      offsetMs: this.parseResult.meta.offsetMs,
      lyricShownCalls: this.lyricShownCalls,
      lastLyricShown: this.lastLyricShown,
      bridgeAbsentSilent: this.bridgeAbsentSilent,
    };
  }

  private mountDom(): void {
    if (this.root || typeof document === "undefined") return;
    const root = document.createElement("aside");
    root.className = "lyric-panel";
    root.setAttribute("aria-label", "歌词面板");
    root.innerHTML = `
      <header class="lyric-head">
        <span class="lyric-kicker">LYRICS · 歌词</span>
        <span class="lyric-meta"></span>
        <button type="button" class="lyric-close" aria-label="关闭歌词">×</button>
      </header>
      <div class="lyric-body" tabindex="0"></div>
    `;
    document.body.appendChild(root);
    this.root = root;
    this.body = root.querySelector<HTMLElement>(".lyric-body");
    this.caption = root.querySelector<HTMLElement>(".lyric-meta");
    root.querySelector<HTMLElement>(".lyric-close")?.addEventListener("click", () => this.setOpen(false));
  }

  private render(): void {
    if (!this.open) return;
    this.mountDom();
    const body = this.body;
    if (!body) return;
    const lines = this.parseResult.lines;
    const fragment = document.createDocumentFragment();

    if (lines.length === 0) {
      const empty = document.createElement("div");
      empty.className = "lyric-line lyric-empty";
      empty.textContent = EMPTY_TEXT;
      fragment.appendChild(empty);
    } else {
      lines.forEach((line, i) => {
        const el = document.createElement("div");
        el.className = `lyric-line s-${line.script}${line.paired ? " lyric-paired" : ""}`;
        el.dataset.index = String(i);
        el.textContent = line.text;
        fragment.appendChild(el);
      });
    }
    body.replaceChildren(fragment);

    if (this.caption) {
      const meta = this.parseResult.meta;
      this.caption.textContent = [meta.title, meta.artist].filter(Boolean).join(" · ");
    }
    this.highlight();
  }

  private highlight(): void {
    const body = this.body;
    if (!this.open || !body) return;
    const children = Array.from(body.children) as HTMLElement[];
    for (const el of children) el.classList.remove("lyric-active");
    const active = children[this.activeIndex];
    if (!active) return;
    active.classList.add("lyric-active");
    // 平滑滚动居中：以当前行相对 body 的偏移构造 scrollTop，CSS scroll-behavior 完成平滑。
    const target = active.offsetTop - body.clientHeight / 2 + active.clientHeight / 2;
    body.scrollTo({ top: Math.max(0, target), behavior: reducedMotion() ? "auto" : "smooth" });
  }

  /** 协议 v1.4 §5：lyric.show 上行。fire-and-forget，任何异常静默计数（web/壳缺席零异常）。 */
  private sendLyricShow(primary: string, secondary: string): void {
    this.lastSent = { primary, secondary };
    this.lyricShownCalls += 1;
    this.lastLyricShown = { primary, secondary };
    try {
      const promise = bridge.call("lyric.show", { primary, secondary });
      if (promise && typeof promise.catch === "function") {
        promise.catch(() => {
          this.bridgeAbsentSilent = true; // 桥/壳缺席（含 web 模式 not_desktop）：静默
        });
      }
    } catch {
      this.bridgeAbsentSilent = true;
    }
  }
}

/** 单例（m1-mount 与 player-bar 共享；view 自身不订阅引擎状态，构造无副作用）。 */
export const lyricView = new LyricView();
if (typeof window !== "undefined") window.__rhineLyric = lyricView;

// 类型与纯函数再导出（测试/调用方按需）。
export type { LyricLine };
export { annotatePairs };
