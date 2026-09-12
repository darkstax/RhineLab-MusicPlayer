/**
 * 保真徽章雏形（AUDIO-ENGINE §13 的徽章组件占位，任务书 M1 范围 C3）。
 *
 * 协议 §6/§8：徽章**只能**渲染 negotiated/factors 事实，UI 文案不得自行推断保真状态。
 * M1 桩 negotiated==null（引擎未接入）→ 渲染 `M1 · stub engine` 灰徽章占位；
 * M4 接真数据源后按 §8 对象渲染 exclusive / bit-perfect / app-perfect 与 factors。
 */

export class FidelityBadges {
  private lastKey = "";

  constructor(private readonly host: HTMLElement) {}

  render(negotiated: unknown | null, badges: unknown | null) {
    // 单一事实源：negotiated 与 badges 同时为 null 才算桩未接入。
    const stub = negotiated === null || negotiated === undefined;
    const key = stub ? "stub" : JSON.stringify(badges ?? null);
    if (key === this.lastKey) return;
    this.lastKey = key;

    if (stub) {
      this.host.innerHTML = `<span class="fb-badge fb-stub" title="音频核心未接入（协议 §6 M1 豁免）：negotiated=null">M1 · stub engine</span>`;
      return;
    }

    // M4 前不会有真数据源；出现未知形状时如实显示而不推断（徽章纪律）。
    this.host.innerHTML = `<span class="fb-badge fb-unknown" title="协商事实到达，渲染器在 M4 实现">negotiated</span>`;
  }
}
