/**
 * M6 设置三层 UI · 第 2 层分组精细 + 三层容器/挂载（M6-PLAN-v2 §1、§3.6）。
 *
 * 层 1 预设（presets.ts 纯逻辑 + 本文件 markup）：日常/沉浸/发烧/自定义；
 *      发烧=共享+无缝+全旁路（不含独占，文案明写"独占模式暂未开放（M4）"）；
 *      互斥约束联动灰显（constraintState → 字段 ⊘ 原因）。
 * 层 2 分组：输出/音质/界面/歌词/库，config.get/set dot-path 读写（§15 键逐条对齐）；
 *      devices.list（v1.5 只读面）未就绪 → 设备下拉显示「待 M6-F 接线」占位。
 * 层 3 诊断：信号路径图（signal-path.ts，订阅 evt{state}，不轮询 cmd）+
 *      diag.get / bridge.diagnostics() / library.quarantine / 诊断包 Blob 下载。
 *
 * 配置总线（createSettingsStore）：
 *   desktop → 壳 config.get/set（协议 §5，%APPDATA%\RhineMusic\config.json）；
 *   web/壁纸 → localStorage 镜像（键 rhine-music-config），顶部明标「仅本机生效」。
 *
 * 主工程零重构契约：main.ts 只加 `${musicSettingsMarkup()}` 一处插值 + 两行 import；
 * 挂载经 `mountMusicSettings()`（renderModal 后调用，幂等）与 `observeMusicSettings()`
 * （m1-mount 调一次，MutationObserver 兜底动态重建）；wall.covers 三态经 import
 * `albumWall.setUserMode` 迁入（不改 player/**）。
 *
 * 不 import css（node --test 可加载本文件；settings.css 由 m1-mount.ts 统一引入）。
 */
import { bridge, type Frame } from "../desktop-bridge.ts";
import { albumWall } from "../player/covers/album-wall.ts";
import { escapeHtml } from "../html.ts";
import {
  PRESETS,
  applyPreset,
  constraintState,
  matchPreset,
  EXCLUSIVE_NOTE,
  type LocalPrefs,
  type PresetId,
} from "./presets.ts";
import {
  ABSENT_MODEL,
  SignalPathView,
  parseNegotiated,
  signalPathMarkup,
  type SignalPathModel,
} from "./signal-path.ts";
import {
  DIAG_NOT_READY,
  buildDiagnosticBundle,
  diagnosticsMarkup,
  parseDiag,
  parseDevices,
  parseQuarantine,
  reasonFromError,
  type BridgeCounts,
  type DiagModel,
  type DevicesModel,
  type QuarantineModel,
} from "./diagnostics.ts";

// ————————————————————————————————— 配置总线 —————————————————————————————————

/** 简单 KV 存储面（localStorage / 内存 Map 均可，便于 node 单测注入）。 */
export type SimpleStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

/** 配置通道（get 返回 undefined=未设置；set 返回可能被壳钳制的生效值）。 */
export type ConfigPort = {
  get(path: string): Promise<unknown>;
  set(path: string, value: unknown): Promise<unknown>;
};

/** AUDIO-ENGINE §15 键默认值（渲染/预设匹配用，不代表已持久化）。 */
export const CONFIG_DEFAULTS: Readonly<Record<string, unknown>> = {
  "output.device": "default",
  "output.mode": "auto",
  "output.buffer_ms": 10,
  "output.auto_expand_buffer": true,
  "output.buffer_max_ms": 300,
  "output.on_device_gone": "follow-default",
  "output.release_on_conflict": "keep",
  "quality.volume_mode": "hardware",
  "quality.resample": "off",
  "quality.target_rate": 96000,
  "quality.resample_quality": "balanced",
  "quality.gapless": true,
  "quality.preload_seconds": 5,
  "quality.dedither": false,
  "quality.replay_gain": "off",
  "quality.crossfade_ms": 0,
  "wall.covers": "textures",
  // 播放条三态循环模式（顺序/专辑/单曲）。非 AUDIO-ENGINE §15 键，但走同一条 dot-path 总线：
  // 桌面写壳 config.json，web 落 localStorage 镜像；播放条的循环钮即写入端。
  "player.loop_mode": "sequential",
  "lyric.offset_ms": 0,
  "lyric.render": "word",
  "lyric.translation": true,
  "taskbar.enabled": false,
  "taskbar.pipe": "",
};

export const MIRROR_KEY = "rhine-music-config";

/** 内存 KV（node 单测与无 localStorage 环境）。 */
export function memoryStorage(): SimpleStorage & { dump(): Record<string, string> } {
  const map = new Map<string, string>();
  return {
    getItem: (key) => (map.has(key) ? (map.get(key) as string) : null),
    setItem: (key, value) => void map.set(key, value),
    dump: () => Object.fromEntries(map),
  };
}

/** localStorage / 内存 KV 的点路径镜像通道（web 模式：仅本机生效）。 */
export function mirrorPort(storage: SimpleStorage): ConfigPort {
  const readAll = (): Record<string, unknown> => {
    try {
      const raw = storage.getItem(MIRROR_KEY);
      const parsed: unknown = raw === null ? {} : JSON.parse(raw);
      return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  };
  return {
    async get(path) {
      const all = readAll();
      return path in all ? all[path] : undefined;
    },
    async set(path, value) {
      const all = readAll();
      all[path] = value;
      try {
        storage.setItem(MIRROR_KEY, JSON.stringify(all));
      } catch {
        /* 存储配额异常不影响内存态 */
      }
      return value;
    },
  };
}

/** 可注入的 bridge 窄面（单测假 bridge；线上传真 bridge）。 */
export type BridgeLike = {
  readonly desktop: boolean;
  call(cmd: string, args?: object, timeoutMs?: number): Promise<unknown>;
  on(type: string, fn: (frame: Frame) => void): () => void;
  diagnostics(): BridgeCounts;
  handshake(): Promise<{ state: string; caps: readonly string[]; core: { app?: string } | null }>;
  readonly last: { hello?: Frame; state?: Frame };
};

/** 壳通道（协议 §5 config.get/set dot-path）。 */
export function bridgePort(target: BridgeLike, timeoutMs = 4000): ConfigPort {
  return {
    async get(path) {
      const result = (await target.call("config.get", { path }, timeoutMs)) as { value?: unknown } | null;
      return result?.value;
    },
    async set(path, value) {
      const result = (await target.call("config.set", { path, value }, timeoutMs)) as { value?: unknown } | null;
      return result && typeof result === "object" && "value" in result ? result.value : value;
    },
  };
}

export type SetRecord = { path: string; value: unknown };

export type SettingsStore = {
  readonly desktop: boolean;
  readonly values: Record<string, unknown>;
  readonly sets: readonly SetRecord[];
  load(paths: readonly string[]): Promise<void>;
  set(path: string, value: unknown): Promise<unknown>;
  preset(): PresetId;
  constraints(): Record<string, string | null>;
  /** 重读本地偏好通道（wall.covers ← albumWall、ui.reduced_motion ← rhine-settings）。 */
  syncLocal(): void;
  /** 预设应用：ipc 键逐条 set（异常吞并到 {ok:false,error}）；返回调用序列。 */
  applyPresetIpc(id: PresetId): Promise<(SetRecord & { ok: boolean; error?: string })[]>;
};

/** local 偏好提供者（默认读浏览器通道；单测注入固定值）。 */
export type LocalProvider = () => LocalPrefs;

export function createSettingsStore(
  port: ConfigPort,
  desktop: boolean,
  opts: { localProvider?: LocalProvider } = {},
): SettingsStore {
  const values: Record<string, unknown> = { ...CONFIG_DEFAULTS };
  const sets: SetRecord[] = [];
  const local: LocalPrefs = {};
  const provideLocal: LocalProvider =
    opts.localProvider ??
    (() => {
      const prefs: LocalPrefs = {};
      try {
        prefs["wall.covers"] = albumWall.userMode;
      } catch {
        /* 无 document 环境（node 单测）跳过 */
      }
      try {
        const raw = typeof localStorage !== "undefined" ? localStorage.getItem("rhine-settings") : null;
        const parsed: unknown = raw === null ? null : JSON.parse(raw);
        if (parsed && typeof parsed === "object" && "reduced" in parsed) {
          prefs["ui.reduced_motion"] = (parsed as { reduced?: unknown }).reduced === true;
        }
      } catch {
        /* 偏好读取失败不推断 */
      }
      return prefs;
    });

  const store: SettingsStore = {
    desktop,
    values,
    sets,
    async load(paths) {
      await Promise.all(
        paths.map(async (path) => {
          try {
            const value = await port.get(path);
            if (value !== undefined && value !== null) values[path] = value;
          } catch {
            /* 单键读取失败保持默认值（诊断页另有壳连接状态） */
          }
        }),
      );
      store.syncLocal();
    },
    async set(path, value) {
      let applied: unknown = value;
      try {
        const returned = await port.set(path, value);
        if (returned !== undefined) applied = returned;
      } catch {
        /* 通道异常仍记录内存态（UI 不假死；错误由调用方 toast） */
      }
      values[path] = applied;
      sets.push({ path, value: applied });
      if (sets.length > 64) sets.shift();
      return applied;
    },
    preset() {
      return matchPreset(values, local);
    },
    constraints() {
      return constraintState(values);
    },
    syncLocal() {
      Object.assign(local, provideLocal());
      if (local["wall.covers"] !== undefined) values["wall.covers"] = local["wall.covers"];
    },
    async applyPresetIpc(id) {
      const plan = applyPreset(id);
      if (!plan) return [];
      const results: (SetRecord & { ok: boolean; error?: string })[] = [];
      for (const [path, value] of plan.ipc) {
        try {
          await store.set(path, value);
          results.push({ path, value, ok: true });
        } catch (error) {
          results.push({ path, value, ok: false, error: reasonFromError(error) });
        }
      }
      return results;
    },
  };
  return store;
}

// ————————————————————————————————— schema —————————————————————————————————

export type FieldDef = {
  readonly path: string;
  readonly kind: "select" | "toggle" | "number" | "text";
  readonly label: string;
  readonly hint?: string;
  readonly options?: readonly (readonly [string, string])[];
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
  readonly unit?: string;
  /** 内核未实现：占位灰显 + 原因（不做"能改但不生效"的开关）。 */
  readonly placeholder?: boolean;
  readonly placeholderReason?: string;
};

export type GroupId = "output" | "quality" | "ui" | "lyric" | "library";
export type GroupDef = { readonly id: GroupId; readonly label: string; readonly fields: readonly FieldDef[] };

export const GROUPS: readonly GroupDef[] = [
  {
    id: "output",
    label: "输出 / OUTPUT",
    fields: [
      { path: "output.device", kind: "select", label: "输出设备", hint: "枚举+共享/独占能力（协议 v1.6；钉选后拔出将自动回退）", options: [["default", "系统默认设备"]] },
      { path: "output.mode", kind: "select", label: "输出模式", options: [["shared", "共享（混音）"], ["auto", "自动（优先独占）"], ["exclusive", "独占（bit-perfect）"]], hint: EXCLUSIVE_NOTE },
      { path: "output.buffer_ms", kind: "select", label: "缓冲时长", options: [["5", "5 ms（低延迟）"], ["10", "10 ms"], ["25", "25 ms（稳）"]] },
      { path: "output.auto_expand_buffer", kind: "toggle", label: "欠载自动升档", hint: "underrun 主对策（Q1-c）" },
      { path: "output.buffer_max_ms", kind: "number", label: "升档上限", min: 10, max: 2000, step: 10, unit: "ms" },
      // P2（审查）：核心侧实况 = 拔出后自动重开（成功即续播），失败才收敛 paused；
      // 尚无"一律暂停"分支 → 占位灰显，不做假接线。
      { path: "output.on_device_gone", kind: "select", label: "设备拔出", options: [["follow-default", "跟随默认设备"]], placeholder: true, placeholderReason: "内核当前为自动重开（M4-c），pause 分支未实现" },
      { path: "output.release_on_conflict", kind: "select", label: "占用冲突（Q7 定案：不让位）", options: [["keep", "保持（其他应用自行切设备）"]] },
    ],
  },
  {
    id: "quality",
    label: "音质 / QUALITY",
    fields: [
      // R3-P2-8：integer（定点位完美衰减）核心侧仍是 not_implemented（engine.cpp 显式
      // 拒绝）→ 只保留已实现三态；integer 作为占位项单独标注，避免"选了没反应"。
      { path: "quality.volume_mode", kind: "select", label: "音量模式", options: [["hardware", "硬件（会话音量）"], ["fixed", "固定（应用满音量 · 位完美前提）"], ["float", "浮点（软件增益）"]] },
      { path: "quality.volume_mode_integer", kind: "select", label: "整型音量（定点衰减）", options: [["off", "未启用"]], placeholder: true, placeholderReason: "内核未实现（M4 范围外），占位灰显" },
      { path: "quality.resample", kind: "select", label: "重采样", options: [["off", "关闭（源速率直出）"], ["auto", "自动"], ["force", "强制 SRC"]] },
      { path: "quality.target_rate", kind: "select", label: "目标采样率", options: [["44100", "44100 Hz"], ["48000", "48000 Hz"], ["88200", "88200 Hz"], ["96000", "96000 Hz"], ["176400", "176400 Hz"], ["192000", "192000 Hz"], ["352800", "352800 Hz"], ["384000", "384000 Hz"]] },
      { path: "quality.resample_quality", kind: "select", label: "重采样质量", options: [["fast", "省电"], ["balanced", "均衡"], ["quality", "高品质"]] },
      { path: "quality.gapless", kind: "toggle", label: "无缝播放（gapless）", hint: "§8：跨曲目边界对齐" },
      { path: "quality.preload_seconds", kind: "number", label: "预加载时长", min: 0, max: 30, step: 1, unit: "s" },
      { path: "quality.dedither", kind: "toggle", label: "去抖动（dedither）", hint: "激活即 processed（路径图如实呈现）" },
      { path: "quality.replay_gain", kind: "select", label: "ReplayGain", options: [["off", "关闭"], ["track", "按曲"], ["album", "按专辑"]], placeholder: true, placeholderReason: "内核未实现，占位灰显" },
      { path: "quality.crossfade_ms", kind: "number", label: "交叉淡化", min: 0, max: 12000, step: 500, unit: "ms", placeholder: true, placeholderReason: "内核未实现，占位灰显" },
    ],
  },
  { id: "ui", label: "界面 / INTERFACE", fields: [] },
  {
    id: "lyric",
    label: "歌词与任务栏 / LYRIC",
    fields: [
      { path: "lyric.offset_ms", kind: "number", label: "歌词偏移", min: -10000, max: 10000, step: 100, unit: "ms" },
      { path: "lyric.render", kind: "select", label: "渲染方式", options: [["word", "逐字"], ["line", "逐行"]] },
      { path: "lyric.translation", kind: "toggle", label: "双语对照" },
    ],
  },
  { id: "library", label: "曲库 / LIBRARY", fields: [] },
];

export const ALL_CONFIG_PATHS: readonly string[] = Object.keys(CONFIG_DEFAULTS);

// ————————————————————————————————— 面板状态与 markup —————————————————————————————————

export type Tier = "presets" | "groups" | "diagnostics";
export type RttStats = { p50: number; p95: number; samples: number };

export type PanelState = {
  activeTier: Tier;
  preset: PresetId;
  values: Readonly<Record<string, unknown>>;
  constraints: Readonly<Record<string, string | null>>;
  devices: DevicesModel;
  diag: DiagModel;
  bridge: BridgeCounts | null;
  quarantine: QuarantineModel;
  quarantineTotal: number | null;
  handshake: { state: string; caps: readonly string[]; core: string | null } | null;
  rtt: RttStats | null;
  livePath: SignalPathModel;
  desktop: boolean;
  coverMode: string;
  coverDegradeNote: string | null;
  libraryRoots: readonly string[];
  lastScanMs: number | null;
  taskbarConnected: boolean | null;
};

export function emptyPanelState(desktop: boolean): PanelState {
  return {
    activeTier: "presets",
    preset: "everyday",
    values: { ...CONFIG_DEFAULTS },
    constraints: constraintState(CONFIG_DEFAULTS),
    devices: { ready: false, devices: [], reason: null },
    diag: DIAG_NOT_READY,
    bridge: null,
    quarantine: { ready: false, items: [], reason: null },
    quarantineTotal: null,
    handshake: null,
    rtt: null,
    livePath: ABSENT_MODEL,
    desktop,
    coverMode: "textures",
    coverDegradeNote: null,
    libraryRoots: [],
    lastScanMs: null,
    taskbarConnected: null,
  };
}

function fieldMarkup(field: FieldDef, state: PanelState): string {
  const constraintReason = state.constraints[field.path] ?? null;
  const placeholderReason = field.placeholder ? field.placeholderReason ?? "未实现" : null;
  const disabled = constraintReason !== null || placeholderReason !== null;
  const reason = placeholderReason ?? constraintReason;
  const value = state.values[field.path];
  let control: string;
  if (field.kind === "select") {
    const devicePending = field.path === "output.device" && !state.devices.ready;
    const options: readonly (readonly [string, string])[] = devicePending
      ? field.options ?? []
      : field.path === "output.device"
        ? [
            ...(field.options ?? []),
            ...state.devices.devices.map((device) => {
              const cap = device.exclusive
                ? device.exclusive.supported ? " · 可独占" : " · 无独占"
                : "";
              return [device.id, `${device.name}${device.isDefault ? " · 默认" : ""}${cap}`] as const;
            }),
          ]
        : field.options ?? [];
    const optionMarkup = options
      .map(([key, label]) => `<option value="${escapeHtml(key)}" ${String(value) === key ? "selected" : ""}>${escapeHtml(label)}</option>`)
      .join("");
    control = `<select data-ms-set="${escapeHtml(field.path)}" aria-label="${escapeHtml(field.label)}"${devicePending ? ' data-ms-pending="1" disabled' : ""}>${devicePending ? `<option value="">待 M6-F 接线</option>` : optionMarkup}</select>`;
  } else if (field.kind === "toggle") {
    control = `<input type="checkbox" data-ms-set="${escapeHtml(field.path)}" aria-label="${escapeHtml(field.label)}"${value === true ? " checked" : ""}${disabled ? " disabled" : ""}/><i class="toggle"></i>`;
  } else if (field.kind === "number") {
    control = `<span class="ms-num"><input type="number" class="ms-number" data-ms-set="${escapeHtml(field.path)}" aria-label="${escapeHtml(field.label)}" value="${typeof value === "number" ? value : ""}" min="${field.min ?? 0}" max="${field.max ?? 1000000}" step="${field.step ?? 1}"${disabled ? " disabled" : ""}/>${field.unit ? `<small>${escapeHtml(field.unit)}</small>` : ""}</span>`;
  } else {
    control = `<input type="text" data-ms-set="${escapeHtml(field.path)}" aria-label="${escapeHtml(field.label)}" value="${escapeHtml(typeof value === "string" ? value : "")}"${disabled ? " disabled" : ""}/>`;
  }
  return `<label class="ms-field${disabled ? " disabled" : ""}" data-ms-path="${escapeHtml(field.path)}">
  <div class="ms-field-copy"><strong>${escapeHtml(field.label)}</strong>${reason ? `<span class="ms-constraint" data-ms-constraint="${escapeHtml(field.path)}">⊘ ${escapeHtml(reason)}</span>` : field.hint ? `<span>${escapeHtml(field.hint)}</span>` : ""}</div>
  <div class="ms-control">${control}</div>
</label>`;
}

export function presetsMarkup(state: PanelState): string {
  const cards = PRESETS.map((preset) => {
    const active = state.preset === preset.id;
    return `<button type="button" class="ms-preset${active ? " active" : ""}" data-ms-preset="${preset.id}" aria-pressed="${active}">
  <strong>${escapeHtml(preset.label)}</strong><span>${escapeHtml(preset.desc)}</span>${preset.note ? `<small class="ms-preset-note">${escapeHtml(preset.note)}</small>` : ""}
</button>`;
  }).join("");
  const derived = state.preset === "custom";
  return `<p class="ms-tier-title">PRESETS / 预设</p>
<div class="ms-preset-grid">${cards}<div class="ms-preset ms-preset-derived${derived ? " active" : ""}" data-ms-preset="custom" aria-pressed="${derived}"><strong>自定义</strong><span>任一精细项偏离预设时自动进入</span></div></div>
<p class="ms-tier-sub">预设成组写入「输出/音质」配置；界面项（配色／动效／封面三态）在「分组精细」单独调整。${EXCLUSIVE_NOTE}。</p>`;
}

function taskbarMarkup(state: PanelState): string {
  const enabled = state.values["taskbar.enabled"] === true;
  const pipe = typeof state.values["taskbar.pipe"] === "string" ? String(state.values["taskbar.pipe"]) : "";
  const mode: "off" | "default" | "custom" = !enabled ? "off" : pipe === "" ? "default" : "custom";
  const choices = ([["off", "关闭"], ["default", "默认管道"], ["custom", "自定义管道"]] as const)
    .map(([key, label]) => `<button type="button" data-ms-taskbar="${key}" aria-pressed="${mode === key}">${label}</button>`)
    .join("");
  return `<div class="ms-field" data-ms-path="taskbar.enabled">
  <div class="ms-field-copy"><strong>任务栏歌词</strong><span>复用 Taskbar-Lyrics 冻结协议（Q4：设置面仅此两项，样式由插件端持有）${state.taskbarConnected === null ? "" : state.taskbarConnected ? " · 管道已连接" : " · 管道未连接"}</span></div>
  <div class="ms-control"><div class="theme-choices ms-tri">${choices}</div></div>
</div>
<label class="ms-field${mode === "custom" ? "" : " disabled"}" data-ms-path="taskbar.pipe">
  <div class="ms-field-copy"><strong>管道名（source 三态：关闭／默认／自定义）</strong><span>${mode === "custom" ? "留空 = 默认 go-musicfox.lyric.v1；填写可与 musicfox 错开" : "仅「自定义管道」时可编辑"}</span></div>
  <div class="ms-control"><input type="text" data-ms-set="taskbar.pipe" aria-label="任务栏管道名" value="${escapeHtml(mode === "custom" ? pipe : "")}" placeholder="留空使用默认管道"${mode === "custom" ? "" : " disabled"}/></div>
</label>`;
}

function uiSectionMarkup(state: PanelState): string {
  const coverChoices = ([["textures", "纹理"], ["selected", "仅选中卡"], ["off", "关闭"]] as const)
    .map(([mode, label]) => `<button type="button" data-ms-cover="${mode}" aria-pressed="${state.coverMode === mode}">${label}</button>`)
    .join("");
  const degrade = state.coverDegradeNote
    ? `<span class="cover-degrade-reason">⚠ ${escapeHtml(state.coverDegradeNote)}</span>`
    : `<span>选中卡展示曲库封面；自动降级仅在纹理泄漏／帧预算／GPU／通路故障时停用，改回任一档即恢复</span>`;
  return `<div class="ms-field" data-ms-path="wall.covers">
  <div class="ms-field-copy"><strong>ALBUM WALL COVERS · 封面三态</strong>${degrade}</div>
  <div class="ms-control"><div class="theme-choices">${coverChoices}</div></div>
</div>
<div class="ms-field ms-upstream">
  <div class="ms-field-copy"><strong>上游界面偏好</strong><span>界面配色、超级性能模式、减少动态效果与渲染画质沿用上方面板原分区（本层不重复设置，避免双事实源）</span></div>
  <div class="ms-control"><button type="button" data-ms-jump="theme">配色 ↟</button><button type="button" data-ms-jump="reduced">动效 ↟</button></div>
</div>`;
}

function librarySectionMarkup(state: PanelState): string {
  const roots = state.libraryRoots.length
    ? `<ul class="ms-roots">${state.libraryRoots.map((root) => `<li title="${escapeHtml(root)}">${escapeHtml(root)}</li>`).join("")}</ul>`
    : `<span class="ms-inline-note">${state.desktop ? "曲库未连接或尚无扫描根（roots 为空）" : "web 模式不接曲库（无桌面壳）"}</span>`;
  const scan = state.lastScanMs === null ? "未记录" : new Date(state.lastScanMs).toISOString().slice(0, 19).replace("T", " ");
  return `<div class="ms-field" data-ms-path="library.roots">
  <div class="ms-field-copy"><strong>扫描根目录</strong>${roots}</div>
  <div class="ms-control"><button type="button" data-ms-scan${state.desktop ? "" : " disabled"} title="${state.desktop ? "增量重扫曲库（library.scan）" : "需要桌面壳"}">重扫 ⟳</button></div>
</div>
<div class="ms-field">
  <div class="ms-field-copy"><strong>最近扫描 / 隔离文件</strong><span>${escapeHtml(scan)} · 隔离清单在「信号与诊断」页</span></div>
  <div class="ms-control"><button type="button" data-ms-tier="diagnostics">隔离区 ⌕</button></div>
</div>`;
}

export function groupsMarkup(state: PanelState): string {
  return GROUPS.map((group) => {
    let body = group.fields.map((field) => fieldMarkup(field, state)).join("");
    if (group.id === "ui") body = uiSectionMarkup(state);
    if (group.id === "lyric") body += taskbarMarkup(state);
    if (group.id === "library") body = librarySectionMarkup(state);
    return `<fieldset class="ms-group" data-ms-group="${group.id}"><legend>${escapeHtml(group.label)}</legend>${body}</fieldset>`;
  }).join("");
}

export function diagnosticsSectionMarkup(state: PanelState): string {
  return `<p class="ms-tier-title">SIGNAL PATH / 信号路径（实时订阅 evt{state}）</p>
<div id="sp-live-host">${signalPathMarkup(state.livePath)}</div>
<p class="ms-tier-title ms-tier-gap">DIAGNOSTICS / 诊断</p>
${diagnosticsMarkup({
    diag: state.diag,
    bridge: state.bridge,
    quarantine: state.quarantine,
    quarantineTotal: state.quarantineTotal,
    handshake: state.handshake,
    rtt: state.rtt,
  })}
<div class="dg-lognote">${state.desktop
    ? "壳与核心日志：协议 §3 规定 log 帧不转发前端，环形缓冲与文件留在宿主侧（%LOCALAPPDATA%\\RhineMusic\\logs）；「导出诊断包」汇总前端可观测事实、桥计数与设置序列。"
    : "非桌面宿主：无 IPC、核心诊断与曲库隔离面，以下均为未就绪态（web 模式不产生异常）。"}</div>`;
}

export function panelInnerMarkup(state: PanelState): string {
  const storageNote = state.desktop
    ? "经壳持久化 · %APPDATA%\\RhineMusic\\config.json（dot-path）"
    : "本机镜像模式 · 仅本机生效（设置写入浏览器 localStorage）";
  const tab = (key: Tier, label: string) =>
    `<button type="button" role="tab" data-ms-tier="${key}" aria-pressed="${state.activeTier === key}" aria-selected="${state.activeTier === key}">${label}</button>`;
  return `<div class="ms-kicker"><span>MUSIC SETTINGS / 音频与显示</span><span class="ms-storage" data-ms-storage="${state.desktop ? "shell" : "local"}">${escapeHtml(storageNote)}</span></div>
  <nav class="ms-tier" role="tablist" aria-label="音频设置层级">${tab("presets", "预设")}${tab("groups", "分组精细")}${tab("diagnostics", "信号与诊断")}</nav>
  <div class="ms-tier-body">
    <div data-ms-panel="presets"${state.activeTier === "presets" ? "" : " hidden"}>${presetsMarkup(state)}</div>
    <div data-ms-panel="groups"${state.activeTier === "groups" ? "" : " hidden"}>${groupsMarkup(state)}</div>
    <div data-ms-panel="diagnostics"${state.activeTier === "diagnostics" ? "" : " hidden"}>${diagnosticsSectionMarkup(state)}</div>
  </div>
  <div class="ms-toast" data-show="0" role="status"></div>`;
}

export function panelMarkup(state: PanelState): string {
  return `<section class="rhine-music-settings" id="rhine-music-settings" data-ms-desktop="${state.desktop}">${panelInnerMarkup(state)}</section>`;
}

// ————————————————————————————————— 挂载与接线 —————————————————————————————————

/** 跨 modal 重开保留的模块级缓存（renderModal 每次重建 DOM，数据与订阅在这里续命）。 */
const cache: {
  store: SettingsStore | null;
  state: PanelState;
  liveNegotiated: unknown;
  customPipe: string;
  rttRing: number[];
  configLoaded: boolean;
  mounted: HTMLElement | null;
  unmount: (() => void) | null;
  offState: (() => void) | null;
  view: SignalPathView | null;
} = {
  store: null,
  state: emptyPanelState(false),
  liveNegotiated: null,
  customPipe: "",
  rttRing: [],
  configLoaded: false,
  mounted: null,
  unmount: null,
  offState: null,
  view: null,
};

function rttSnapshot(): RttStats | null {
  const ring = cache.rttRing;
  if (ring.length === 0) return null;
  const sorted = [...ring].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return { p50: Math.round(at(0.5) * 10) / 10, p95: Math.round(at(0.95) * 10) / 10, samples: sorted.length };
}

async function timed<T>(run: () => Promise<T>): Promise<T> {
  const start = Date.now();
  try {
    return await run();
  } finally {
    cache.rttRing.push(Date.now() - start);
    if (cache.rttRing.length > 64) cache.rttRing.shift();
  }
}

/** 观测入口（headless 验收读取面；与 __rhinePlayer / __rhineBridge 同一思路，只读 + 注入）。 */
export type SettingsProbe = {
  snapshot(): {
    desktop: boolean;
    tier: Tier;
    preset: PresetId;
    values: Record<string, unknown>;
    sets: SetRecord[];
    devicesReady: boolean;
    diagReady: boolean;
    quarantineReady: boolean;
    livePath: SignalPathModel;
    framesLost: number;
    mounted: boolean;
  };
  /** 注入 negotiated（headless 快照断言用；桌面真帧到达会覆盖）。 */
  feedNegotiated(negotiated: unknown): void;
};

declare global {
  interface Window {
    __rhineSettings?: SettingsProbe;
  }
}

function browserStorage(): SimpleStorage {
  return {
    getItem: (key) => {
      try {
        return localStorage.getItem(key);
      } catch {
        return null;
      }
    },
    setItem: (key, value) => {
      try {
        localStorage.setItem(key, value);
      } catch {
        /* 隐私模式写入异常忽略 */
      }
    },
  };
}

function ensureStore(): SettingsStore {
  if (!cache.store) {
    const desktop = bridge.desktop;
    cache.store = createSettingsStore(
      desktop ? bridgePort(bridge as unknown as BridgeLike) : mirrorPort(browserStorage()),
      desktop,
    );
    cache.state.desktop = desktop;
  }
  return cache.store;
}

function syncStateFromStore(store: SettingsStore): PanelState {
  store.syncLocal();
  const state = cache.state;
  state.values = store.values;
  state.constraints = store.constraints();
  state.preset = store.preset();
  state.livePath = parseNegotiated(cache.liveNegotiated);
  try {
    const coverState = albumWall.state;
    state.coverMode = albumWall.userMode;
    state.coverDegradeNote = coverState.autoDegrading ? albumWall.degradeReasonText(coverState.reason) : null;
  } catch {
    /* node 环境保持默认 */
  }
  return state;
}

/**
 * 挂载/接管一个 panelMarkup 生成的 section（事件委托 + 信号视图 + 诊断加载）。
 * 幂等：同一节点重复调用直接复用；新节点替换旧挂载（旧监听与视图释放）。
 */
export function mountMusicSettings(section: HTMLElement): () => void {
  const store = ensureStore();
  if (cache.mounted === section && cache.unmount) return cache.unmount;
  cache.unmount?.();

  let disposed = false;

  const render = () => {
    if (disposed) return;
    const state = syncStateFromStore(store);
    section.innerHTML = panelInnerMarkup(state);
    attachView();
  };

  const attachView = () => {
    const state = cache.state;
    cache.view?.dispose();
    const host = section.querySelector<HTMLElement>("#sp-live-host");
    cache.view = host ? new SignalPathView(host, 250) : null;
    if (cache.view) cache.view.feed(cache.liveNegotiated);
  };

  const toast = (message: string) => {
    const node = section.querySelector<HTMLElement>(".ms-toast");
    if (!node) return;
    node.textContent = message;
    node.dataset.show = "1";
    setTimeout(() => {
      if (node.dataset.show === "1") node.dataset.show = "0";
    }, 4200);
  };

  const onClick = (event: MouseEvent) => {
    const target = event.target as HTMLElement;
    const tierButton = target.closest<HTMLElement>("[data-ms-tier]");
    if (tierButton) {
      cache.state.activeTier = tierButton.dataset.msTier as Tier;
      render();
      return;
    }
    const presetButton = target.closest<HTMLElement>("[data-ms-preset]");
    if (presetButton) {
      const id = presetButton.dataset.msPreset as PresetId;
      if (id === "custom") return; // 自定义不可直接点选（由偏离自动进入）
      void (async () => {
        const results = await store.applyPresetIpc(id);
        const plan = applyPreset(id);
        if (plan) {
          const modal = section.closest(".terminal-modal");
          const wantReduced = plan.local["ui.reduced_motion"];
          if (typeof wantReduced === "boolean") {
            const checkbox = modal?.querySelector<HTMLInputElement>('[data-pref="reduced"]');
            if (checkbox && checkbox.checked !== wantReduced) checkbox.click();
          }
          const cover = plan.local["wall.covers"];
          if (cover && albumWall.userMode !== cover) albumWall.setUserMode(cover);
        }
        const failed = results.find((entry) => !entry.ok);
        if (failed) toast(`部分设置未能保存：${failed.path}（${failed.error}）`);
        render();
      })();
      return;
    }
    const coverButton = target.closest<HTMLElement>("[data-ms-cover]");
    if (coverButton) {
      albumWall.setUserMode(coverButton.dataset.msCover as "textures" | "selected" | "off");
      void store.set("wall.covers", albumWall.userMode);
      render();
      return;
    }
    const taskbarButton = target.closest<HTMLElement>("[data-ms-taskbar]");
    if (taskbarButton) {
      const mode = taskbarButton.dataset.msTaskbar;
      const currentPipe = typeof store.values["taskbar.pipe"] === "string" ? String(store.values["taskbar.pipe"]) : "";
      if (mode === "off") {
        void store.set("taskbar.enabled", false);
      } else if (mode === "default") {
        if (currentPipe) cache.customPipe = currentPipe;
        void store.set("taskbar.enabled", true);
        void store.set("taskbar.pipe", "");
      } else if (mode === "custom") {
        void store.set("taskbar.enabled", true);
        void store.set("taskbar.pipe", cache.customPipe || currentPipe || "rhine-music.lyric.v1");
      }
      // 状态上行壳侧（协议 v1.4 taskbar.set 壳侧自答；失败静默）
      if (bridge.desktop) {
        void bridge
          .call("taskbar.set", { enabled: store.values["taskbar.enabled"] === true, pipe: store.values["taskbar.pipe"] }, 5000)
          .then((result) => {
            cache.state.taskbarConnected = (result as { connected?: unknown } | null)?.connected === true;
          })
          .catch(() => {
            cache.state.taskbarConnected = null;
          });
      }
      render();
      return;
    }
    const jump = target.closest<HTMLElement>("[data-ms-jump]");
    if (jump) {
      const selector = jump.dataset.msJump === "theme" ? "[data-color-theme]" : '[data-pref="reduced"]';
      section.closest(".terminal-modal")?.querySelector(selector)?.scrollIntoView({ block: "center" });
      return;
    }
    if (target.closest("[data-ms-scan]")) {
      void (async () => {
        if (!bridge.desktop) {
          toast("重扫需要桌面壳（web 模式不接曲库）");
          return;
        }
        try {
          const result = (await bridge.call("library.scan", {}, 20000)) as Record<string, unknown> | null;
          toast(`扫描完成：${String(result?.scanned ?? "?")} 文件，隔离 ${String(result?.quarantine ?? result?.failed ?? 0)}`);
        } catch (error) {
          toast(`重扫失败：${reasonFromError(error)}`);
        }
        await loadAsync(true);
        render();
      })();
      return;
    }
    if (target.closest('[data-action="diag-refresh"]')) {
      void loadAsync(true).then(render);
      return;
    }
    if (target.closest('[data-action="diag-export"]')) {
      exportBundle(store, syncStateFromStore(store));
      return;
    }
  };

  const onChange = (event: Event) => {
    const input = event.target as HTMLInputElement | HTMLSelectElement;
    const path = input?.dataset?.msSet;
    if (!path) return;
    const field = GROUPS.flatMap((group) => group.fields).find((def) => def.path === path);
    let value: unknown;
    if (field?.kind === "toggle") value = (input as HTMLInputElement).checked;
    else if (field?.kind === "number") value = Number((input as HTMLInputElement).value);
    else value = input.value;
    if (field?.kind === "number" && !Number.isFinite(value as number)) {
      toast(`${field.label}：请输入数字`);
      render();
      return;
    }
    if (path === "taskbar.pipe" && typeof value === "string") cache.customPipe = value;
    void store.set(path, value).then(() => {
      if (path === "taskbar.enabled" || path === "taskbar.pipe") {
        if (bridge.desktop) {
          void bridge
            .call("taskbar.set", { enabled: store.values["taskbar.enabled"] === true, pipe: store.values["taskbar.pipe"] }, 5000)
            .then((result) => {
              cache.state.taskbarConnected = (result as { connected?: unknown } | null)?.connected === true;
            })
            .catch(() => {
              cache.state.taskbarConnected = null;
            });
        }
      }
      render();
    });
  };

  section.addEventListener("click", onClick);
  section.addEventListener("change", onChange);
  render();

  // 信号路径数据源：订阅 evt{state}（协议 §6；negotiated 随 state 快照下发，不轮询 cmd）。
  // 订阅挂在 cache（跨 modal 重建存续），有挂载面板时喂视图。
  if (bridge.desktop && !cache.offState) {
    const accept = (frame: Frame) => {
      const data = (frame.data ?? {}) as Record<string, unknown>;
      cache.liveNegotiated = data.negotiated === undefined ? null : data.negotiated;
      cache.state.livePath = parseNegotiated(cache.liveNegotiated);
      cache.view?.feed(cache.liveNegotiated);
    };
    cache.offState = bridge.on("state", accept);
    if (bridge.last.state) accept(bridge.last.state);
  }

  function teardown(): void {
    if (disposed) return;
    disposed = true;
    cache.view?.dispose();
    cache.view = null;
    section.removeEventListener("click", onClick);
    section.removeEventListener("change", onChange);
    if (cache.mounted === section) {
      cache.mounted = null;
      cache.unmount = null;
    }
  }

  cache.mounted = section;
  cache.unmount = teardown;
  void loadAsync(false).then(() => {
    if (!disposed) render();
  });
  return teardown;
}

/** 异步只读面加载（config 全量 + devices/diag/quarantine/stats/handshake）。 */
export async function loadAsync(manual = false): Promise<void> {
  const store = ensureStore();
  const state = cache.state;
  const jobs: Promise<unknown>[] = [];
  if (!cache.configLoaded || manual) {
    cache.configLoaded = true;
    jobs.push(store.load(ALL_CONFIG_PATHS));
  }
  if (bridge.desktop) {
    jobs.push(
      (async () => {
        if (state.devices.ready && !manual) return;
        try {
          state.devices = parseDevices(await timed(() => bridge.call("devices.list", {}, 6000)));
        } catch (error) {
          state.devices = { ready: false, devices: [], reason: reasonFromError(error) };
        }
      })(),
      (async () => {
        try {
          state.diag = parseDiag(await timed(() => bridge.call("diag.get", {}, 6000)));
        } catch (error) {
          state.diag = { ...DIAG_NOT_READY, reason: reasonFromError(error) };
        }
      })(),
      (async () => {
        try {
          state.quarantine = parseQuarantine(await bridge.call("library.quarantine", { limit: 20 }, 6000));
        } catch (error) {
          state.quarantine = { ready: false, items: [], reason: reasonFromError(error) };
        }
        try {
          const stats = (await bridge.call("library.stats", {}, 6000)) as Record<string, unknown> | null;
          state.quarantineTotal = typeof stats?.quarantine === "number" ? stats.quarantine : null;
          state.libraryRoots = Array.isArray(stats?.roots) ? stats.roots.map(String) : [];
          state.lastScanMs = typeof stats?.last_scan_ms === "number" ? stats.last_scan_ms : null;
        } catch {
          /* stats 缺席保持空态（壳未含 library caps） */
        }
      })(),
      (async () => {
        try {
          const hello = await bridge.handshake();
          state.handshake = {
            state: hello.state,
            caps: hello.caps,
            core: hello.core ? String((hello.core as { app?: string }).app ?? "core") : null,
          };
        } catch {
          state.handshake = null;
        }
      })(),
    );
    state.bridge = bridge.diagnostics() as unknown as BridgeCounts;
  } else {
    state.handshake = null;
    state.bridge = null;
  }
  await Promise.allSettled(jobs);
  state.rtt = rttSnapshot();
  store.syncLocal();
}

/** 诊断包导出（Blob 下载；不含凭据，仅协议事实与计数）。返回文本（单测断言用）。 */
export function exportBundle(store: SettingsStore, state: PanelState): string {
  const text = buildDiagnosticBundle({
    diag: state.diag,
    bridge: state.bridge,
    quarantine: state.quarantine,
    negotiated: state.livePath.status === "live" ? cache.liveNegotiated : null,
    version: {
      app: "1.0.0",
      shell: state.handshake ? state.handshake.state : null,
      core: state.handshake?.core ?? null,
      proto: store.desktop ? 1 : null,
    },
    logHint: store.desktop
      ? "壳/核心日志在 %LOCALAPPDATA%\\RhineMusic\\logs（协议 §3：log 帧不转发前端；log.tail 前端导出面属 lane F 接口缺口）"
      : "web 模式无壳日志",
    extraSections: {
      bridgeRtt: state.rtt ? `p50=${state.rtt.p50}ms p95=${state.rtt.p95}ms samples=${state.rtt.samples}` : "（无样本）",
      settingsSets: store.sets.slice(-32).map((entry) => `${entry.path}=${JSON.stringify(entry.value)}`).join("\n"),
      configSnapshot: JSON.stringify(store.values),
    },
  });
  if (typeof document === "undefined") return text; // node 单测：只返回文本
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `rhine-diag-${new Date().toISOString().replace(/[:.]/g, "-")}.txt`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  return text;
}

/** 设置面板 markup（main.ts 的 settingsMarkup 以同风格插值调用；节点由 mount 接管）。 */
export function musicSettingsMarkup(): string {
  const store = ensureStore();
  return panelMarkup(syncStateFromStore(store));
}

/**
 * 自挂载观察器（m1-mount.ts 调一次）：main.ts 的 renderModal 每次 innerHTML 重建设置面板，
 * MutationObserver 检测 #rhine-music-settings 出现/更换后接管（同 mountLibraryPanel 零侵入
 * 思路）；返回释放函数。
 */
export function observeMusicSettings(target: ParentNode = document.body): () => void {
  const scan = () => {
    const section = target.querySelector<HTMLElement>("#rhine-music-settings");
    if (!section || section === cache.mounted) return;
    mountMusicSettings(section);
  };
  scan();
  if (typeof MutationObserver === "undefined") return () => {};
  const observer = new MutationObserver(scan);
  observer.observe(target, { childList: true, subtree: true });
  return () => observer.disconnect();
}

/** 初始化入口（m1-mount 调用一次）：探针 + 观察器。 */
export function initMusicSettings(): () => void {
  if (typeof window !== "undefined") {
    const probe: SettingsProbe = {
      snapshot: () => {
        const store = ensureStore();
        const state = syncStateFromStore(store);
        return {
          desktop: store.desktop,
          tier: state.activeTier,
          preset: state.preset,
          values: { ...store.values },
          sets: [...store.sets],
          devicesReady: state.devices.ready,
          diagReady: state.diag.ready,
          quarantineReady: state.quarantine.ready,
          livePath: state.livePath,
          framesLost: bridge.desktop ? bridge.diagnostics().framesLost : 0,
          mounted: cache.mounted !== null,
        };
      },
      feedNegotiated: (negotiated: unknown) => {
        cache.liveNegotiated = negotiated;
        cache.state.livePath = parseNegotiated(negotiated);
        if (cache.mounted) {
          // 重建面板内容（markup 含新快照，旧 view 随 innerHTML 一并替换——单一事实源）。
          cache.mounted.innerHTML = panelInnerMarkup(cache.state);
          const host = cache.mounted.querySelector<HTMLElement>("#sp-live-host");
          if (host) new SignalPathView(host, 250).feed(negotiated);
        }
      },
    };
    window.__rhineSettings = probe;
  }
  if (typeof document === "undefined") return () => {};
  return observeMusicSettings(document.body);
}
