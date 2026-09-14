/**
 * M6 诊断页（M6-PLAN-v2 §3；AUDIO-ENGINE §14"发烧用户信任的来源，优先级不做可裁剪"）。
 *
 * 四个数据面：
 *   1. `diag.get`（协议 v1.5 只读面，lane F 并行实现）——按形状窄读，缺席/未实现
 *      （not_implemented/disconnected/timeout）时优雅显示"未就绪"，不编造数值
 *      （区分"没有"与"不知道"，M2-FINDINGS §5 诚实性红线：unknown → null）；
 *   2. `bridge.diagnostics()`（framesLost / ep / 每通道明细 / epochSwitches，现成）；
 *   3. `library.quarantine`（v1.5 壳侧自答只读）表渲染 + `library.stats.quarantine` 计数；
 *   4. 壳日志 tail：协议无 log 转发前端面（§3 log 不转发）→ 导出"诊断包"Blob 下载
 *      （negotiated/diag/桥计数/quarantine/设备/版本 + 日志路径指引）；`log.tail` cmd
 *      若壳侧提供（lane F 接口缺口，见 FINDINGS）则并入原文。
 *
 * 纯逻辑（parse/markup/组装/节流刷新）无 DOM 依赖，node --test 直接加载；
 * DOM 编排在 groups.ts（与信号路径图同一挂载）。
 */
import { parseNegotiated, signalPathMarkup, type SignalPathModel } from "./signal-path.ts";

export type DiagModel = {
  /** false = 未就绪（cmd 缺席/not_implemented/未连接），UI 灰态明示而非零值。 */
  readonly ready: boolean;
  readonly underruns: number | null;
  readonly reopens: number | null;
  readonly bufferMsNow: number | null;
  readonly periodMs: number | null;
  readonly link: SignalPathModel;
  /** M4 域：协议恒 null，如实展示"暂不可用（M4）"。 */
  readonly fallbackHistory: null;
  readonly reason: string | null;
};

export const DIAG_NOT_READY: DiagModel = {
  ready: false,
  underruns: null,
  reopens: null,
  bufferMsNow: null,
  periodMs: null,
  link: parseNegotiated(null),
  fallbackHistory: null,
  reason: null,
};

const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
const str = (value: unknown): string | null => (typeof value === "string" ? value : null);

/** 协议 v1.5 §5 diag.get result → 模型（缺字段=null，不做推断）。 */
export function parseDiag(raw: unknown): DiagModel {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return DIAG_NOT_READY;
  const value = raw as Record<string, unknown>;
  return {
    ready: true,
    underruns: num(value.underruns),
    reopens: num(value.reopens),
    bufferMsNow: num(value.buffer_ms_now),
    periodMs: num(value.period_ms),
    link: parseNegotiated(value.link),
    fallbackHistory: null, // v1.5：M4 域恒 null（即使对端误发也不渲染）。
    reason: null,
  };
}

export type QuarantineItem = {
  readonly path: string;
  readonly reason: string | null;
  readonly mtime: number | null;
  readonly size: number | null;
  readonly seen_at: number | null;
};

export type QuarantineModel = { ready: boolean; items: readonly QuarantineItem[]; reason: string | null };

/** 协议 v1.5 §5 library.quarantine result → 表模型。 */
export function parseQuarantine(raw: unknown): QuarantineModel {
  if (typeof raw !== "object" || raw === null || !Array.isArray((raw as Record<string, unknown>).items)) {
    return { ready: false, items: [], reason: null };
  }
  const items = ((raw as Record<string, unknown>).items as unknown[]).flatMap(
    (entry): QuarantineItem[] => {
      if (typeof entry !== "object" || entry === null) return [];
      const value = entry as Record<string, unknown>;
      const path = str(value.path);
      if (path === null) return [];
      return [{ path, reason: str(value.reason), mtime: num(value.mtime), size: num(value.size), seen_at: num(value.seen_at) }];
    },
  );
  return { ready: true, items, reason: null };
}

export type DeviceEntry = {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly isDefault: boolean;
  readonly rates: readonly number[];
  readonly minPeriodMs: number | null;
  readonly exclusive: null;
};

export type DevicesModel = { ready: boolean; devices: readonly DeviceEntry[]; reason: string | null };

/** 协议 v1.5 §5 devices.list result → 下拉数据（exclusive 恒 null=M4 域）。 */
export function parseDevices(raw: unknown): DevicesModel {
  if (typeof raw !== "object" || raw === null || !Array.isArray((raw as Record<string, unknown>).devices)) {
    return { ready: false, devices: [], reason: null };
  }
  const devices = ((raw as Record<string, unknown>).devices as unknown[]).flatMap(
    (entry): DeviceEntry[] => {
      if (typeof entry !== "object" || entry === null) return [];
      const value = entry as Record<string, unknown>;
      const id = str(value.id);
      if (id === null) return [];
      const capabilities = (typeof value.capabilities === "object" && value.capabilities !== null
        ? value.capabilities
        : {}) as Record<string, unknown>;
      const rates = Array.isArray(capabilities.rates)
        ? capabilities.rates
            .map((rate) => (typeof rate === "object" && rate !== null ? num((rate as Record<string, unknown>).rate) : null))
            .filter((rate): rate is number => rate !== null)
        : [];
      return [{
        id,
        name: str(value.name) ?? id,
        kind: str(value.kind) ?? "playback",
        isDefault: value.default === true,
        rates,
        minPeriodMs: num(capabilities.min_period_ms),
        exclusive: null,
      }];
    },
  );
  return { ready: true, devices, reason: null };
}

/** 桥诊断快照（desktop-bridge BridgeDiagnostics 形状）→ 文本表。 */
export type BridgeCounts = {
  framesLost: number;
  ep: number | null;
  epochSwitches: number;
  channels: Readonly<Record<string, { seq: number; lost: number }>>;
};

function escapeText(value: string): string {
  return value.replace(/[&<>"]/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&quot;"));
}

function sizeText(bytes: number | null): string {
  if (bytes === null) return "?";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

function timeText(ms: number | null): string {
  if (ms === null) return "?";
  try {
    return new Date(ms).toISOString().replace("T", " ").slice(0, 19);
  } catch {
    return String(ms);
  }
}

/** 诊断页整体 markup：diag.get + 桥计数 + quarantine + IPC 往返（桥侧 64 槽环形，直方图属 lane F）。 */
export function diagnosticsMarkup(input: {
  diag: DiagModel;
  bridge: BridgeCounts | null;
  quarantine: QuarantineModel;
  quarantineTotal: number | null;
  handshake: { state: string; caps: readonly string[]; core: string | null } | null;
  rtt: { p50: number; p95: number; samples: number } | null;
}): string {
  const { diag, bridge, quarantine } = input;
  const diagRows = diag.ready
    ? [
        ["Underrun 欠载", diag.underruns === null ? "未知" : String(diag.underruns)],
        ["重开流次数", diag.reopens === null ? "未知" : String(diag.reopens)],
        ["当前缓冲", diag.bufferMsNow === null ? "未知" : `${diag.bufferMsNow} ms`],
        ["设备周期", diag.periodMs === null ? "未知" : `${diag.periodMs} ms`],
        ["降级链历史", "暂不可用（M4 域，v1.5 恒 null）"],
      ]
        .map(([k, v]) => `<div class="dg-row"><span>${escapeText(k)}</span><strong>${escapeText(v)}</strong></div>`)
        .join("")
    : `<div class="dg-row dg-muted"><span>diag.get</span><strong>未就绪${diag.reason ? `（${escapeText(diag.reason)}）` : ""}</strong></div>`;
  const bridgeRows = bridge
    ? [
        ["累计丢帧 framesLost", String(bridge.framesLost)],
        ["会话世代 ep", bridge.ep === null ? "未知" : String(bridge.ep)],
        ["世代切换次数", String(bridge.epochSwitches)],
        ...Object.entries(bridge.channels).map(
          ([kind, channel]) => [`通道 ${kind}`, `seq ${channel.seq} · 丢 ${channel.lost}`] as [string, string],
        ),
      ]
        .map(([k, v]) => `<div class="dg-row"><span>${escapeText(k)}</span><strong>${escapeText(v)}</strong></div>`)
        .join("")
    : `<div class="dg-row dg-muted"><span>bridge.diagnostics()</span><strong>非桌面宿主</strong></div>`;
  const qHead = `<tr><th>路径</th><th>原因</th><th>修改时间</th><th>大小</th><th>最近发现</th></tr>`;
  const qRows = quarantine.ready
    ? quarantine.items.length
      ? quarantine.items
          .map(
            (item) => `<tr><td class="dg-path" title="${escapeText(item.path)}">${escapeText(item.path)}</td><td>${item.reason ? escapeText(item.reason) : "?"}</td><td>${timeText(item.mtime)}</td><td>${sizeText(item.size)}</td><td>${timeText(item.seen_at)}</td></tr>`,
          )
          .join("")
      : `<tr><td colspan="5" class="dg-muted">隔离表为空——没有损坏或无法读取的文件</td></tr>`
    : `<tr><td colspan="5" class="dg-muted">quarantine 未就绪（library.quarantine 未接入或壳未连接）</td></tr>`;
  const linkSection =
    diag.link.status === "live"
      // 诊断快照与实时图同屏：去掉拷贝体的 rolling id，避免重复 DOM id（只读快照不需动画）。
      ? signalPathMarkup(diag.link).replace(/\sid="sp-(rate|bits)"/g, ' data-snap="$1"')
      : `<div class="signal-path sp-absent" data-sp-state="absent"><div class="sp-absent-copy"><strong>LINK OFFLINE</strong><span>diag.get 的 link 为 null——当前无协商事实</span></div></div>`;
  const handshake = input.handshake
    ? [
        ["壳连接态", input.handshake.state],
        ["能力交集 caps", input.handshake.caps.join(" · ") || "（空）"],
        ["核心身份", input.handshake.core ?? "未连接"],
        ["IPC 往返（桥侧 cmd 环形 64 槽）", input.rtt === null ? "未测（本会话无样本）" : `p50 ${input.rtt.p50} ms · p95 ${input.rtt.p95} ms · ${input.rtt.samples} 样本`],
      ]
        .map(([k, v]) => `<div class="dg-row"><span>${escapeText(k)}</span><strong>${escapeText(v)}</strong></div>`)
        .join("")
    : `<div class="dg-row dg-muted"><span>IPC 握手</span><strong>非桌面宿主（bridge 不可用）</strong></div>`;
  return `<div class="dg-grid">
  <section class="dg-card"><h4>CORE · diag.get（协议 v1.5 只读面）</h4><div class="dg-rows">${diagRows}</div></section>
  <section class="dg-card"><h4>BRIDGE · 丢帧与 IPC</h4><div class="dg-rows">${bridgeRows}${handshake}</div></section>
  <section class="dg-card dg-negotiated"><h4>当前协商（诊断快照）</h4>${linkSection}</section>
  <section class="dg-card dg-quarantine"><h4>QUARANTINE · 隔离文件${input.quarantineTotal !== null ? `（stats: ${input.quarantineTotal}）` : ""}</h4><table class="dg-table">${qHead}${qRows}</table></section>
  <div class="dg-actions"><button type="button" data-action="diag-export">导出诊断包 ⤓</button><button type="button" data-action="diag-refresh">刷新 ⟳</button></div>
</div>`;
}

export function reasonFromError(error: unknown): string {
  const code = typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : null;
  if (code === "not_implemented") return "not_implemented";
  if (code === "not_desktop") return "非桌面宿主";
  if (code === "disconnected") return "壳未连接";
  if (code === "timeout") return "壳应答超时";
  return code ?? (error instanceof Error ? error.message : String(error));
}

/** 诊断包文本（Blob 导出主体；不含任何凭据——协议字段与计数 only）。 */
export function buildDiagnosticBundle(input: {
  diag: DiagModel;
  bridge: BridgeCounts | null;
  quarantine: QuarantineModel;
  negotiated: unknown;
  version: { app: string; shell: string | null; core: string | null; proto: number | null };
  logHint: string | null;
  extraSections?: Readonly<Record<string, string>>;
}): string {
  const lines: string[] = [];
  lines.push("Rhine Music Player · 诊断包");
  lines.push(`生成时间: ${new Date().toISOString()}`);
  lines.push(`版本: app=${input.version.app} shell=${input.version.shell ?? "?"} core=${input.version.core ?? "?"} proto=${input.version.proto ?? "?"}`);
  const pushRows = (label: string, rows: [string, unknown][]) => {
    lines.push("", `[${label}]`);
    for (const [key, value] of rows) lines.push(`${key}=${value === undefined ? "" : String(value)}`);
  };
  if (input.bridge) {
    pushRows("bridge", [
      ["framesLost", input.bridge.framesLost],
      ["ep", input.bridge.ep],
      ["epochSwitches", input.bridge.epochSwitches],
      ["channels", JSON.stringify(input.bridge.channels)],
    ]);
  } else pushRows("bridge", [["state", "not-desktop"]]);
  if (input.diag.ready) {
    pushRows("diag.get", [
      ["underruns", input.diag.underruns],
      ["reopens", input.diag.reopens],
      ["buffer_ms_now", input.diag.bufferMsNow],
      ["period_ms", input.diag.periodMs],
      ["link", input.diag.link.status === "live" ? JSON.stringify(input.diag.link.chain.map((n) => `${n.node}:${n.passthrough ? "pass" : "proc"}`)) : "null"],
    ]);
  } else pushRows("diag.get", [["state", `not-ready(${input.diag.reason ?? "unknown"})`]]);
  pushRows("quarantine", [
    ["ready", input.quarantine.ready],
    ["count", input.quarantine.items.length],
    ...input.quarantine.items.slice(0, 100).map(
      (item, index): [string, string] => [`item${index}`, `${item.path}\t${item.reason ?? "?"}\t${item.size ?? "?"}`],
    ),
  ]);
  if (input.negotiated !== null && input.negotiated !== undefined) {
    lines.push("", "[negotiated]");
    lines.push(JSON.stringify(input.negotiated));
  }
  for (const [label, body] of Object.entries(input.extraSections ?? {})) {
    lines.push("", `[${label}]`);
    lines.push(body);
  }
  lines.push("", `[日志说明] ${input.logHint ?? "壳/核心日志在宿主机器本地（协议 §3 log 帧不转发前端）；桌面构建的导出诊断包同样以本文件为准。"}`);
  return lines.join("\n");
}

/** 刷新节流间隔（诊断页 1Hz 上限；evt.state 驱动的帧率不在此列）。 */
export const DIAG_REFRESH_MS = 1000;
