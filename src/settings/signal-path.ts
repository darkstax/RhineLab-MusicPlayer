/**
 * M6 信号路径图（M6-PLAN-v2 §2；Roon 式，AUDIO-ENGINE §13）。
 *
 * 横条渲染 `negotiated.chain`（decoder→resample→volume→output），数据源 = 订阅
 * `evt{state}`（协议 §6：negotiated 随 state 快照下发）。**UI 只渲染不判断**：
 * 直通/处理颜色直接映射 chain[].passthrough 字段，fidelity 徽章与 factors 逐字来自
 * negotiated（FidelityAssessor 在壳/核心侧；任何 UI 文案不得自行推断保真状态，协议 §8）。
 *
 * 三态：
 *   - app-perfect（有 chain，全/部分直通）→ 正常渲染，橙/绿按 passthrough；
 *   - processed → 同渲染，fidelity 徽章如实标注；
 *   - null（桩/引擎未接入，M1 豁免）→ "引擎未接入"灰态占位，DOM 内无伪造节点名。
 *
 * 视觉：磨砂卡 + 细线 + --theme-* 变量（亮暗自动跟随），rate/bit 标注复用上游
 * Rolling Number（createRollingNumber，460ms 同族）。实时性纪律：不轮询 cmd，
 * 由订阅侧喂帧；本模块自带节流（min interval + trailing）。
 *
 * 纯逻辑（parse/markup/Throttle）零 DOM 依赖，node --test 直接加载；
 * SignalPathView 仅在 document 环境构造（lyric-view 同模式）。
 */
import { createRollingNumber } from "@kitlangton/rolling-number";

export type ChainNodeModel = {
  readonly node: string;
  readonly detail: string | null;
  readonly passthrough: boolean;
};

export type FormatModel = {
  readonly rate: number | null;
  readonly bits_container: number | null;
  readonly bits_valid: number | null;
  readonly encoding: string | null;
  readonly channels: number | null;
};

export type SignalPathModel = {
  readonly status: "live" | "absent";
  readonly share: string | null;
  readonly backend: string | null;
  readonly format: FormatModel | null;
  readonly bufferMs: number | null;
  readonly periodMs: number | null;
  readonly autoExpanded: boolean;
  readonly chain: readonly ChainNodeModel[];
  readonly fidelity: string | null;
  readonly factors: readonly string[];
};

export const ABSENT_MODEL: SignalPathModel = {
  status: "absent",
  share: null,
  backend: null,
  format: null,
  bufferMs: null,
  periodMs: null,
  autoExpanded: false,
  chain: [],
  fidelity: null,
  factors: [],
};

const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
const str = (value: unknown): string | null => (typeof value === "string" ? value : null);
const flag = (value: unknown, fallback = false): boolean =>
  typeof value === "boolean" ? value : fallback;

function parseFormat(raw: unknown): FormatModel | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  return {
    rate: num(value.rate),
    bits_container: num(value.bits_container),
    bits_valid: num(value.bits_valid),
    encoding: str(value.encoding),
    channels: num(value.channels),
  };
}

/**
 * 协议 §8 `negotiated` → 渲染模型（信任边界：自家核心/壳的窄读取；非法形状按
 * "未接入"处理即可——出现非法帧说明发送端有 bug，不做载荷级防御）。
 */
export function parseNegotiated(raw: unknown): SignalPathModel {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return ABSENT_MODEL;
  const value = raw as Record<string, unknown>;
  const chain = Array.isArray(value.chain)
    ? value.chain.flatMap((entry): ChainNodeModel[] => {
        if (typeof entry !== "object" || entry === null) return [];
        const node = str((entry as Record<string, unknown>).node);
        if (node === null) return [];
        return [{ node, detail: str((entry as Record<string, unknown>).detail), passthrough: flag((entry as Record<string, unknown>).passthrough) }];
      })
    : [];
  const factors = Array.isArray(value.factors) ? value.factors.map(String) : [];
  return {
    status: "live",
    share: str(value.share),
    backend: str(value.backend),
    format: parseFormat(value.format),
    bufferMs: num(value.buffer_ms),
    periodMs: num(value.period_ms),
    autoExpanded: flag(value.auto_expanded),
    chain,
    fidelity: str(value.fidelity),
    factors,
  };
}

const FIDELITY_LABEL: Readonly<Record<string, string>> = {
  "bit-perfect": "BIT-PERFECT",
  "app-perfect": "APP-PERFECT",
  processed: "PROCESSED",
};

/** fidelity → 徽章样式类（枚举内映射；未知值一律中性样式，不推断）。 */
export function fidelityClass(fidelity: string | null): string {
  switch (fidelity) {
    case "bit-perfect":
      return "sp-badge sp-green";
    case "app-perfect":
      return "sp-badge sp-amber";
    case "processed":
      return "sp-badge sp-grey";
    default:
      return "sp-badge sp-neutral";
  }
}

export function fidelityLabel(fidelity: string | null): string {
  if (fidelity === null) return "未上报";
  return FIDELITY_LABEL[fidelity] ?? fidelity; // 逐字呈现未知值（不翻译不推断）。
}

function escapeText(value: string): string {
  return value.replace(/[&<>"]/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&quot;"));
}

/** 横条 markup（含 aria 文本；滚动数字由 attachRollingFormat 事后接管）。 */
export function signalPathMarkup(model: SignalPathModel): string {
  if (model.status === "absent") {
    return `<div class="signal-path sp-absent" data-sp-state="absent" role="img" aria-label="引擎未接入">
  <span class="sp-idle-ribbon" aria-hidden="true"></span>
  <div class="sp-absent-copy"><strong>ENGINE OFFLINE</strong><span>引擎未接入 · negotiated = null（协议 §6 桩豁免）</span></div>
</div>`;
  }
  const nodes = model.chain
    .map(
      (node) => `<div class="sp-node ${node.passthrough ? "sp-passthrough" : "sp-processed-node"}" data-sp-node="${escapeText(node.node)}" data-sp-passthrough="${node.passthrough}">
  <span class="sp-node-name">${escapeText(node.node)}</span>
  <span class="sp-node-detail">${node.detail ? escapeText(node.detail) : node.passthrough ? "直通" : "处理"}</span>
  <span class="sp-node-state" aria-hidden="true">${node.passthrough ? "●" : "◐"}</span>
</div>`,
    )
    .join(`<span class="sp-link" aria-hidden="true">─▶</span>`);
  const format = model.format;
  const formatText = format
    ? `${format.rate ?? "?"} Hz · ${format.bits_valid ?? "?"}/${format.bits_container ?? "?"} bit · ${format.encoding ?? "?"} · ${format.channels ?? "?"} ch`
    : "格式未上报";
  const factors = model.factors.length
    ? `<ul class="sp-factors">${model.factors.map((f) => `<li>${escapeText(f)}</li>`).join("")}</ul>`
    : `<p class="sp-factors sp-factors-empty">无破坏位完美因子（factors = []）</p>`;
  return `<div class="signal-path" data-sp-state="live" role="img" aria-label="信号路径：${escapeText(fidelityLabel(model.fidelity))}">
  <div class="sp-head"><span class="sp-kicker">SIGNAL PATH / 信号路径</span><span class="${fidelityClass(model.fidelity)}">${escapeText(fidelityLabel(model.fidelity))}</span></div>
  <div class="sp-ribbon" aria-hidden="true"></div>
  <div class="sp-chain">${nodes}</div>
  <div class="sp-meta">
    <div class="sp-format"><span>协商格式</span><strong id="sp-rate">${format?.rate != null ? String(format.rate) : "--"}</strong><i>Hz</i><strong id="sp-bits">${format?.bits_valid != null ? String(format.bits_valid) : "--"}</strong><i>bit</i><small>${escapeText(formatText)}</small></div>
    <div class="sp-line"><span>输出</span><strong>${model.share ? escapeText(model.share) : "?"} · ${model.backend ? escapeText(model.backend) : "?"}</strong></div>
    <div class="sp-line"><span>缓冲</span><strong>${model.bufferMs ?? "?"} ms${model.autoExpanded ? "（已自动升档）" : ""}</strong><small>周期 ${model.periodMs ?? "?"} ms</small></div>
  </div>
  <div class="sp-factors-block"><span>破坏因子 / FACTORS</span>${factors}</div>
</div>`;
}

/** 把 rate/bit 两个节点接管为 Rolling Number（460ms 同族；减少动态效果直接到位）。 */
export function attachRollingFormat(host: HTMLElement, model: SignalPathModel, animated: boolean): void {
  if (model.status !== "live" || model.format === null) return;
  const specs: [string, number | null][] = [
    ["sp-rate", model.format.rate],
    ["sp-bits", model.format.bits_valid],
  ];
  for (const [id, value] of specs) {
    const node = host.querySelector<HTMLElement>(`#${id}`);
    if (!node || value === null) continue;
    if (node.dataset.rolling === "1") continue;
    node.dataset.rolling = "1";
    const initial = value;
    node.replaceChildren();
    const controller = createRollingNumber(node, {
      value: initial,
      duration: 460,
      motionBlur: animated,
      locales: "en-GB",
      format: { minimumIntegerDigits: 1, useGrouping: false },
      animated: false,
    });
    controller.update({ value: initial, animated: false });
    controller.finish();
    node.dataset.rollingTarget = String(initial);
  }
}

/** 更新滚动数字（值变化才播；animated=false 或减少动态效果直接到位）。 */
export function updateRollingFormat(host: HTMLElement, model: SignalPathModel, animated: boolean): void {
  if (model.status !== "live" || model.format === null) return;
  for (const [id, value] of [
    ["sp-rate", model.format.rate],
    ["sp-bits", model.format.bits_valid],
  ] as [string, number | null][]) {
    const node = host.querySelector<HTMLElement>(`#${id}`);
    if (!node || value === null || node.dataset.rolling !== "1") continue;
    const previous = Number(node.dataset.rollingTarget ?? NaN);
    if (previous === value) continue;
    node.dataset.rollingTarget = String(value);
    const controller = (node as HTMLElement & { __spRolling?: ReturnType<typeof createRollingNumber> }).__spRolling;
    if (controller) controller.update({ value, animated: animated && !prefersReducedMotion() });
  }
}

export function prefersReducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * 节流（验收 1"节流"单测对象）：最小间隔内丢弃中间帧、保留 trailing 最新帧。
 * 时钟注入以便测试（默认 performance.now / Date.now 语义由调用方提供）。
 */
export class Throttle {
  private last = -Infinity;
  private pending: boolean | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly minMs: number;
  private readonly invoke: () => void;
  private readonly now: () => number;
  private readonly schedule: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  private readonly cancel: (handle: ReturnType<typeof setTimeout>) => void;

  constructor(
    minMs: number,
    invoke: () => void,
    now: () => number = () => Date.now(),
    schedule: (fn: () => void, ms: number) => ReturnType<typeof setTimeout> = (fn, ms) => setTimeout(fn, ms),
    cancel: (handle: ReturnType<typeof setTimeout>) => void = (handle) => clearTimeout(handle),
  ) {
    this.minMs = minMs;
    this.invoke = invoke;
    this.now = now;
    this.schedule = schedule;
    this.cancel = cancel;
  }

  /** 请求执行；返回是否**立即**执行。间隔内的调用合并为一次 trailing。 */
  request(): boolean {
    const now = this.now();
    if (now - this.last >= this.minMs) {
      this.fire(now);
      return true;
    }
    if (this.pending === true || this.timer !== null) return false;
    this.pending = true;
    this.timer = this.schedule(() => {
      this.timer = null;
      if (this.pending !== true) return;
      this.pending = null;
      this.fire(this.now());
    }, this.minMs);
    return false;
  }

  private fire(now: number): void {
    this.last = now;
    this.invoke();
  }

  cancelPending(): void {
    if (this.timer !== null) this.cancel(this.timer);
    this.timer = null;
    this.pending = null;
  }
}

/**
 * DOM 视图（headless 验收 4 的目标节点）：host.innerHTML = markup + 节流更新。
 * 只渲染不判断：更新入口唯一 `feed(negotiated)`（evt.state 到达时由 groups.ts 调用）。
 * 节流复用 `Throttle`（min interval + trailing 保最新帧）。
 */
export class SignalPathView {
  private model: SignalPathModel;
  private pendingNegotiated: SignalPathModel | null = null;
  private readonly throttle: Throttle;
  private readonly host: HTMLElement;
  private readonly renderMs: number;

  constructor(host: HTMLElement, renderMs = 250, clock: () => number = () => Date.now()) {
    this.host = host;
    this.renderMs = renderMs;
    this.model = ABSENT_MODEL;
    this.throttle = new Throttle(renderMs, () => this.render(), clock);
    this.render();
  }

  get currentModel(): SignalPathModel {
    return this.model;
  }

  /** evt.state 的 negotiated 快照（null=引擎未接入）；内容未变不重绘，变则经 Throttle 合并。 */
  feed(negotiated: unknown): void {
    const next = parseNegotiated(negotiated);
    if (JSON.stringify(next) === JSON.stringify(this.model) && this.pendingNegotiated === null) return;
    this.pendingNegotiated = next;
    this.throttle.request();
  }

  private render(): void {
    if (this.pendingNegotiated !== null) this.model = this.pendingNegotiated;
    this.host.innerHTML = signalPathMarkup(this.model);
    if (this.model.status === "live") {
      attachRollingFormat(this.host, this.model, !prefersReducedMotion());
    }
  }

  dispose(): void {
    this.throttle.cancelPending();
  }
}
