/**
 * M6 设置三层 UI · 第 1 层预设（M6-PLAN-v2 §1，AUDIO-ENGINE §15）。
 *
 * 纯逻辑模块（无 DOM、无 bridge import）：node --test 直接加载。
 * 预设 = §15 config 键组合 + 本地上游偏好键（界面组）：
 *   - 日常 everyday：共享 + hardware 音量 + 无缝 + 不重采样；
 *   - 沉浸 immersive：共享 + fixed 音量 + 完整动效 + 封面纹理；
 *   - 发烧 audiophile：共享 + 无缝 + 全旁路（fixed 音量/不重采样/无抖动移除/无淡化/无
 *     ReplayGain）——**不含独占**（M4 排除），文案明写"独占模式暂未开放（M4）"；
 *   - 自定义 custom：任一精细项偏离已知预设时由 `matchPreset` 自动判定，不可直接点选。
 *
 * 互斥约束（联动灰显，§3.6 + §6 bit-perfect 冲突的正解）：
 *   - `quality.volume_mode=fixed` ∧ `quality.replay_gain≠off` → replay_gain 禁用；
 *   - `quality.crossfade_ms>0` ∧ `quality.gapless=true` → crossfade 禁用（无缝与淡化互斥）；
 *   - `quality.resample≠force` → target_rate / resample_quality 禁用（从属联动）；
 *   - `output.mode` 的 exclusive 选项恒禁用（M4 域，不实现不欺骗）。
 */

/** 本地（前端）偏好键——不经 config.set，走 localStorage / albumWall 通道。 */
export type LocalPrefs = {
  "ui.reduced_motion"?: boolean;
  "wall.covers"?: "textures" | "selected" | "off";
};

export type PresetId = "everyday" | "immersive" | "audiophile" | "custom";

export type PresetDef = {
  readonly id: PresetId;
  readonly label: string;
  readonly desc: string;
  /** 经 `config.set`（dot-path）写入的桌面键（web 模式仅镜像到本机）。 */
  readonly ipc: Readonly<Record<string, unknown>>;
  /** 本地上游偏好键。 */
  readonly local: Readonly<LocalPrefs>;
  /** 附加说明（如发烧档的独占口径）。 */
  readonly note?: string;
};

export const EXCLUSIVE_NOTE = "独占模式已开放（M4：bit-perfect 需整型源+fixed 音量+不重采样）";

export const PRESETS: readonly PresetDef[] = [
  {
    id: "everyday",
    label: "日常",
    desc: "共享输出 · 系统音量控制 · 无缝播放",
    ipc: {
      "output.mode": "auto",
      "quality.volume_mode": "hardware",
      "quality.resample": "off",
      "quality.gapless": true,
      "quality.replay_gain": "off",
      "quality.crossfade_ms": 0,
    },
    local: {},
  },
  {
    id: "immersive",
    label: "沉浸",
    desc: "共享输出 · 应用满音量 · 完整动效与封面",
    ipc: {
      "output.mode": "auto",
      "quality.volume_mode": "fixed",
      "quality.resample": "off",
      "quality.gapless": true,
      "quality.replay_gain": "off",
      "quality.crossfade_ms": 0,
    },
    local: { "ui.reduced_motion": false, "wall.covers": "textures" },
  },
  {
    id: "audiophile",
    label: "发烧",
    desc: "共享输出 · 无缝 · 全旁路（解码直通不重采样）",
    ipc: {
      "output.mode": "shared",
      "quality.volume_mode": "fixed",
      "quality.resample": "off",
      "quality.gapless": true,
      "quality.replay_gain": "off",
      "quality.dedither": false,
      "quality.crossfade_ms": 0,
    },
    local: {},
    note: `${EXCLUSIVE_NOTE}；本档 = 共享 + 无缝 + 全旁路，不请求独占。`,
  },
];

/** custom 不出现在 PRESETS 点选列表（由偏离自动进入）。 */
export function presetById(id: PresetId): PresetDef | null {
  return PRESETS.find((preset) => preset.id === id) ?? null;
}

/** 预设应用清单：逐条 [path, value]（写序稳定，便于断言调用序列）。 */
export function applyPreset(id: PresetId): { ipc: [string, unknown][]; local: LocalPrefs } | null {
  const preset = presetById(id);
  if (!preset || preset.id === "custom") return null;
  return {
    ipc: Object.entries(preset.ipc),
    local: { ...preset.local },
  };
}

/**
 * 当前配置 → 预设归属。ipc 快照与本地快照中**已定义**的键需全部命中；
 * 任一命中不了 → "custom"（诚实性：读取失败/未覆盖的键不算匹配）。
 */
export function matchPreset(
  ipcConfig: Readonly<Record<string, unknown>>,
  local: Readonly<LocalPrefs> = {},
): PresetId {
  for (const preset of PRESETS) {
    let ipcHit = true;
    for (const [path, value] of Object.entries(preset.ipc)) {
      if (!(path in ipcConfig) || !sameValue(ipcConfig[path], value)) {
        ipcHit = false;
        break;
      }
    }
    if (!ipcHit) continue;
    let localHit = true;
    for (const [key, value] of Object.entries(preset.local)) {
      const current = (local as Record<string, unknown>)[key];
      if (current === undefined || current !== value) {
        localHit = false;
        break;
      }
    }
    if (localHit) return preset.id;
  }
  return "custom";
}

function sameValue(a: unknown, b: unknown): boolean {
  if (typeof a === "number" && typeof b === "number") return a === b;
  if (typeof a === "boolean" || typeof b === "boolean") return a === b;
  if (typeof a === "string" && typeof b === "string") return a === b;
  return a === b;
}

/** 配置快照（dot-path 扁平）→ 互斥禁用表：path → 原因（null=可用）。 */
export type ConstraintMap = Record<string, string | null>;

const num = (value: unknown, fallback: number) =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;
const flag = (value: unknown, fallback = false) =>
  typeof value === "boolean" ? value : fallback;
const text = (value: unknown, fallback: string) => (typeof value === "string" ? value : fallback);

export function constraintState(config: Readonly<Record<string, unknown>>): ConstraintMap {
  const volumeMode = text(config["quality.volume_mode"], "hardware");
  const replayGain = text(config["quality.replay_gain"], "off");
  const crossfade = num(config["quality.crossfade_ms"], 0);
  const gapless = flag(config["quality.gapless"], true);
  const resample = text(config["quality.resample"], "off");
  return {
    "quality.replay_gain":
      volumeMode === "fixed" && replayGain !== "off"
        ? "与 fixed 音量互斥（§6：位/响度路径冲突），需先切换音量模式"
        : null,
    "quality.crossfade_ms":
      crossfade > 0 && gapless
        ? "与无缝播放互斥（§8），需先关闭无缝"
        : null,
    "quality.target_rate": resample !== "force" ? "仅在强制重采样（force）时可调" : null,
    "quality.resample_quality": resample !== "force" ? "仅在强制重采样（force）时可调" : null,
    // P1-5（审查）：exclusive+hardware 的提示原挂在 "output.mode.exclusive" 死键上
    // （select 按 field.path 查约束，永不命中）。P1-4 已在核心侧真回落 hardware→fixed，
    // 该组合不再需要 UI 阻断（且约束会 disable 整个 select 导致"改不回去"）——删除；
    // 位完美前提改由 output.mode 的 hint（EXCLUSIVE_NOTE）陈述性表达。
  };
}

export type ConfigPatch = { path: string; value: unknown };

/**
 * 精细项变更 → 应用后配置 + 预设归属重算。返回 { next, preset, writes }：
 * writes = 需要落盘的 config.set 序列（本次改动本身；预设联动写入走 applyPreset 独立通道）。
 */
export function withConfigChange(
  config: Readonly<Record<string, unknown>>,
  local: Readonly<LocalPrefs>,
  patch: ConfigPatch,
): { next: Record<string, unknown>; preset: PresetId } {
  const next = { ...config, [patch.path]: patch.value };
  return { next, preset: matchPreset(next, local) };
}
