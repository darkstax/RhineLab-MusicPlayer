// M6 设置三层 UI 纯逻辑单测（node --test，无 DOM）：
// 预设映射/互斥灰显/chain 渲染三态/节流 + 诊断形状窄读 + 配置总线双通道。
// 运行：node --test --experimental-strip-types src/settings/settings.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import {
  PRESETS,
  applyPreset,
  matchPreset,
  constraintState,
  withConfigChange,
  EXCLUSIVE_NOTE,
} from "./presets.ts";
import {
  ABSENT_MODEL,
  Throttle,
  fidelityClass,
  fidelityLabel,
  parseNegotiated,
  signalPathMarkup,
} from "./signal-path.ts";
import {
  DIAG_NOT_READY,
  buildDiagnosticBundle,
  diagnosticsMarkup,
  parseDiag,
  parseDevices,
  parseQuarantine,
  reasonFromError,
} from "./diagnostics.ts";
import {
  ALL_CONFIG_PATHS,
  CONFIG_DEFAULTS,
  MIRROR_KEY,
  bridgePort,
  createSettingsStore,
  memoryStorage,
  mirrorPort,
} from "./groups.ts";

// ——— APP-PERFECT（§8 样例形状：decoder 直通、resample 直通、volume 处理）———
const APP_PERFECT = {
  share: "shared-event",
  backend: "wasapi",
  format: { rate: 96000, bits_container: 32, bits_valid: 24, encoding: "pcm", channels: 2 },
  buffer_ms: 10,
  period_ms: 3,
  auto_expanded: false,
  chain: [
    { node: "decoder", detail: "dr_flac s24", passthrough: true },
    { node: "resample", passthrough: true },
    { node: "volume", mode: "fixed", passthrough: false },
  ],
  fidelity: "app-perfect",
  factors: ["shared-mixer"],
};

// ——— PROCESSED（重采样 + 浮点音量）———
const PROCESSED = {
  share: "shared-event",
  backend: "wasapi",
  format: { rate: 48000, bits_container: 32, bits_valid: 32, encoding: "pcm-float", channels: 2 },
  buffer_ms: 25,
  period_ms: 10,
  auto_expanded: true,
  chain: [
    { node: "decoder", detail: "mad f32", passthrough: false },
    { node: "resample", detail: "sinc balanced", passthrough: false },
    { node: "volume", mode: "float", passthrough: false },
  ],
  fidelity: "processed",
  factors: ["shared-mixer", "float-decode", "resample", "float-volume"],
};

// ——————————————————————————— 预设映射（§15 / M6-PLAN-v2 §1）———————————————————————————

test("1. 预设清单：日常/沉浸/发烧三档 + 各自映射 §15 键", () => {
  assert.deepEqual(PRESETS.map((p) => p.id), ["everyday", "immersive", "audiophile"]);
  const everyday = applyPreset("everyday");
  assert.ok(everyday);
  assert.deepEqual(everyday.ipc, [
    ["output.mode", "auto"],
    ["quality.volume_mode", "hardware"],
    ["quality.resample", "off"],
    ["quality.gapless", true],
    ["quality.replay_gain", "off"],
    ["quality.crossfade_ms", 0],
  ]);
  const immersive = applyPreset("immersive");
  assert.equal(immersive.ipc.find(([path]) => path === "quality.volume_mode")[1], "fixed");
  assert.deepEqual(immersive.local, { "ui.reduced_motion": false, "wall.covers": "textures" });
});

test("2. 发烧=共享+无缝+全旁路，不含独占；文案明写「独占模式暂未开放（M4）」", () => {
  const audiophile = applyPreset("audiophile");
  assert.ok(audiophile);
  assert.equal(audiophile.ipc.find(([path]) => path === "output.mode")[1], "shared");
  assert.equal(audiophile.ipc.find(([path]) => path === "quality.gapless")[1], true);
  // 全旁路：fixed 音量 + 不重采样 + 无抖动移除 + 无淡化 + 无 ReplayGain
  assert.equal(audiophile.ipc.find(([path]) => path === "quality.volume_mode")[1], "fixed");
  assert.equal(audiophile.ipc.find(([path]) => path === "quality.resample")[1], "off");
  assert.equal(audiophile.ipc.find(([path]) => path === "quality.dedither")[1], false);
  assert.equal(audiophile.ipc.find(([path]) => path === "quality.crossfade_ms")[1], 0);
  // 不写任何 exclusive 键/值（M4 排除）
  assert.equal(audiophile.ipc.some(([path, value]) => path.includes("exclusive") || value === "exclusive"), false);
  assert.ok(audiophile.note ?? PRESETS[2].note);
  assert.match(PRESETS[2].note, /独占模式暂未开放（M4）/);
  assert.match(EXCLUSIVE_NOTE, /独占模式暂未开放/);
});

test("3. matchPreset：默认配置=日常；全旁路组合=发烧；偏离=自定义", () => {
  assert.equal(matchPreset({ ...CONFIG_DEFAULTS }), "everyday");
  const audiophileConfig = { ...CONFIG_DEFAULTS, ...Object.fromEntries(applyPreset("audiophile").ipc) };
  assert.equal(matchPreset(audiophileConfig), "audiophile");
  assert.equal(matchPreset({ ...CONFIG_DEFAULTS, "quality.gapless": false }), "custom");
  // 未覆盖的键不算匹配（诚实性：缺 quality.volume_mode → custom）
  const { ["quality.volume_mode"]: _drop, ...partial } = CONFIG_DEFAULTS;
  assert.equal(matchPreset(partial), "custom");
});

test("4. 预设切换→config.set 序列（applyPresetIpc 走 dot-path 通道）", async () => {
  const calls = [];
  const fakeBridge = {
    desktop: true,
    call: async (cmd, args) => {
      calls.push([cmd, args]);
      return { value: args.value };
    },
  };
  const store = createSettingsStore(bridgePort(fakeBridge), true, { localProvider: () => ({}) });
  const results = await store.applyPresetIpc("audiophile");
  assert.equal(results.length, 7);
  assert.ok(results.every((entry) => entry.ok));
  assert.deepEqual(calls.map(([cmd]) => cmd), Array(7).fill("config.set"));
  assert.deepEqual(calls[0][1], { path: "output.mode", value: "shared" });
  assert.equal(store.preset(), "audiophile");
});

test("5. 互斥灰显：fixed 音量 ⊗ ReplayGain；gapless ⊗ crossfade；非 force ⊗ 从属项", () => {
  const base = { ...CONFIG_DEFAULTS };
  assert.equal(constraintState(base)["quality.replay_gain"], null); // off 音量模式下可选
  const fixedReplay = constraintState({ ...base, "quality.volume_mode": "fixed", "quality.replay_gain": "album" });
  assert.match(fixedReplay["quality.replay_gain"], /与 fixed 音量互斥/);
  const gapCross = constraintState({ ...base, "quality.crossfade_ms": 3000 });
  assert.match(gapCross["quality.crossfade_ms"], /与无缝播放互斥/);
  assert.equal(constraintState({ ...base, "quality.crossfade_ms": 3000, "quality.gapless": false })["quality.crossfade_ms"], null);
  assert.match(constraintState(base)["quality.target_rate"], /仅在强制重采样/);
  assert.equal(constraintState({ ...base, "quality.resample": "force" })["quality.target_rate"], null);
});

test("6. 互斥灰显联动：改动后重算 + withConfigChange 归自定义", () => {
  const state = withConfigChange({ ...CONFIG_DEFAULTS }, {}, { path: "quality.volume_mode", value: "hardware" });
  assert.equal(state.preset, "everyday"); // 与默认一致仍为日常
  const moved = withConfigChange({ ...CONFIG_DEFAULTS }, {}, { path: "quality.volume_mode", value: "float" });
  assert.equal(moved.preset, "custom");
  // output.mode 的 exclusive 选项恒灰显（M4 域，不实现不欺骗）
  assert.match(constraintState(CONFIG_DEFAULTS)["output.mode.exclusive"], /独占模式暂未开放/);
});

// ——————————————————————————— chain 渲染三态（只渲染不判断）———————————————————————————

test("7. parseNegotiated：app-perfect → 节点/passthrough/fidelity 逐字来自数据", () => {
  const model = parseNegotiated(APP_PERFECT);
  assert.equal(model.status, "live");
  assert.equal(model.chain.length, 3);
  assert.deepEqual(model.chain.map((n) => [n.node, n.passthrough]), [["decoder", true], ["resample", true], ["volume", false]]);
  assert.equal(model.chain[0].detail, "dr_flac s24");
  assert.equal(model.fidelity, "app-perfect");
  assert.deepEqual([...model.factors], ["shared-mixer"]);
  assert.equal(model.format.rate, 96000);
  assert.equal(model.autoExpanded, false);
});

test("8. parseNegotiated：processed 多因子 + auto_expanded 如实；未知字段不报错", () => {
  const model = parseNegotiated(PROCESSED);
  assert.equal(model.fidelity, "processed");
  assert.equal(model.factors.length, 4);
  assert.ok(model.chain.every((node) => !node.passthrough));
  assert.equal(model.autoExpanded, true);
  // 未知顶层字段（未来扩展）不影响既有解析
  assert.equal(parseNegotiated({ ...APP_PERFECT, future_field: 42 }).fidelity, "app-perfect");
});

test("9. parseNegotiated：null（桩/引擎未接入）→ absent，无伪造节点；空对象=live 空链（如实呈现）", () => {
  for (const raw of [null, undefined, "null", 7, []]) {
    const model = parseNegotiated(raw);
    assert.equal(model.status, "absent");
    assert.equal(model.chain.length, 0);
    assert.equal(model.fidelity, null);
  }
  assert.equal(parseNegotiated(null), ABSENT_MODEL);
  // 非 null 的对象是"有协商事实"：即使字段缺失也按 live 如实渲染（fidelity=null → 未上报）
  assert.equal(parseNegotiated({}).status, "live");
  assert.equal(parseNegotiated({}).fidelity, null);
});

test("10. signalPathMarkup：live 三态类名/节点/徽章；absent 灰态无 sp-node", () => {
  const live = signalPathMarkup(parseNegotiated(APP_PERFECT));
  assert.match(live, /data-sp-state="live"/);
  assert.match(live, /sp-node sp-passthrough/);
  assert.match(live, /sp-node sp-processed-node/);
  assert.match(live, /data-sp-node="decoder"/);
  assert.match(live, /sp-amber/); // app-perfect → 橙
  assert.match(live, /shared-mixer/);
  const processed = signalPathMarkup(parseNegotiated(PROCESSED));
  assert.match(processed, /sp-grey/); // processed → 灰
  assert.match(processed, /float-volume/);
  const bitPerfect = signalPathMarkup(parseNegotiated({ ...APP_PERFECT, fidelity: "bit-perfect", factors: [] }));
  assert.match(bitPerfect, /sp-green/);
  assert.match(bitPerfect, /factors = \[\]/);
  const absent = signalPathMarkup(ABSENT_MODEL);
  assert.match(absent, /data-sp-state="absent"/);
  assert.match(absent, /引擎未接入/);
  assert.doesNotMatch(absent, /sp-node"|data-sp-node/); // 灰态 DOM 内无伪造节点名
});

test("11. fidelity 徽章映射只认枚举：未知值逐字呈现为中性（UI 不推断）", () => {
  assert.equal(fidelityClass("bit-perfect"), "sp-badge sp-green");
  assert.equal(fidelityClass("app-perfect"), "sp-badge sp-amber");
  assert.equal(fidelityClass("processed"), "sp-badge sp-grey");
  assert.equal(fidelityClass(null), "sp-badge sp-neutral");
  assert.equal(fidelityClass("mystery"), "sp-badge sp-neutral");
  assert.equal(fidelityLabel("mystery"), "mystery");
  assert.equal(fidelityLabel("bit-perfect"), "BIT-PERFECT");
});

test("12. markup 转义：detail/factors 文本进 DOM 属性前转义（防破结构）", () => {
  const hostile = { ...APP_PERFECT, chain: [{ node: 'dec"><x', detail: "a<b&c\"", passthrough: true }], factors: ['f<img src=x>'] };
  const markup = signalPathMarkup(parseNegotiated(hostile));
  assert.doesNotMatch(markup, /<x/);
  assert.doesNotMatch(markup, /a<b&c/);
  assert.doesNotMatch(markup, /<img/);
});

// ——————————————————————————— 节流 ———————————————————————————

test("13. Throttle：首次立即执行；间隔内合并，trailing 用最新数据执行一次", () => {
  let now = 0;
  let runs = 0;
  const timers = [];
  const throttle = new Throttle(
    250,
    () => runs++,
    () => now,
    (fn, ms) => {
      timers.push({ fn, at: now + ms });
      return timers.length - 1;
    },
    () => {},
  );
  assert.equal(throttle.request(), true); // t=0 立即
  assert.equal(runs, 1);
  now = 100;
  assert.equal(throttle.request(), false); // 间隔内排队
  now = 180;
  assert.equal(throttle.request(), false); // 已有排队，丢弃（trailing 合并）
  assert.equal(runs, 1);
  timers[0].fn(); // 触发 trailing（250ms 后）
  assert.equal(runs, 2);
  now = 500;
  assert.equal(throttle.request(), true); // 距上次 fire（180）已过窗口 → 再次立即
  assert.equal(runs, 3);
});

test("14. SignalPathView.feed 的模型级去重：同内容不重绘（经 parseNegotiated 判等）", () => {
  // 纯逻辑面：两次解析内容一致（对象级 JSON 比较），驱动 View 时零渲染。
  const a = JSON.stringify(parseNegotiated(APP_PERFECT));
  const b = JSON.stringify(parseNegotiated({ ...APP_PERFECT, future: 1 })); // 未读字段不影响模型
  assert.equal(a, b);
  const c = JSON.stringify(parseNegotiated({ ...APP_PERFECT, fidelity: "processed" }));
  assert.notEqual(a, c);
});

// ——————————————————————————— 诊断形状窄读（v1.5）———————————————————————————

test("15. parseDiag：v1.5 只读面形状 → ready；缺失字段=null 不编造；坏输入=未就绪", () => {
  const model = parseDiag({
    underruns: 3,
    reopens: 1,
    buffer_ms_now: 10,
    period_ms: 3,
    link: APP_PERFECT,
    fallback_history: null,
  });
  assert.equal(model.ready, true);
  assert.equal(model.underruns, 3);
  assert.equal(model.link.status, "live");
  assert.equal(model.fallbackHistory, null);
  const sparse = parseDiag({ underruns: 0 });
  assert.equal(sparse.ready, true);
  assert.equal(sparse.reopens, null); // 缺字段=不知道（null），不是 0
  assert.equal(parseDiag(null), DIAG_NOT_READY);
  assert.equal(parseDiag("not_implemented").ready, false);
});

test("16. parseQuarantine：items 表形状；坏条目跳过；缺席=未就绪", () => {
  const model = parseQuarantine({
    items: [
      { path: "D:\\bad.flac", reason: "decode_failed", mtime: 1700000000000, size: 123, seen_at: 1700000001000 },
      { reason: "no path" },
      null,
      { path: "D:\\ok.wav", reason: null, mtime: null, size: null, seen_at: null },
    ],
  });
  assert.equal(model.ready, true);
  assert.equal(model.items.length, 2);
  assert.equal(model.items[0].path, "D:\\bad.flac");
  assert.equal(model.items[1].reason, null);
  assert.deepEqual(parseQuarantine({}), { ready: false, items: [], reason: null });
  assert.equal(parseQuarantine(null).ready, false);
});

test("17. parseDevices：v1.5 只读面；exclusive 恒 null；min_period/mix 能力提取", () => {
  const model = parseDevices({
    devices: [
      {
        id: "{0.0.0.00000000}.abc",
        name: "USB DAC",
        kind: "playback",
        default: true,
        capabilities: {
          rates: [{ rate: 44100, bits: [16, 24] }, { rate: 96000, bits: [32] }, "bogus"],
          min_period_ms: 3,
          mix_format: { rate: 384000, bits_container: 32, bits_valid: 32, encoding: "pcm-float", channels: 2 },
          exclusive: null,
        },
      },
    ],
  });
  assert.equal(model.ready, true);
  assert.equal(model.devices[0].rates.join(","), "44100,96000");
  assert.equal(model.devices[0].isDefault, true);
  assert.equal(model.devices[0].minPeriodMs, 3);
  assert.equal(model.devices[0].exclusive, null);
  assert.equal(parseDevices(null).ready, false); // 未实现/缺席 → 下拉显示"待 M6-F 接线"
});

test("18. diagnosticsMarkup：未就绪优雅文案（不编造数值）+ framesLost 同源呈现", () => {
  const html = diagnosticsMarkup({
    diag: { ...DIAG_NOT_READY, reason: "not_implemented" },
    bridge: { ep: 2, channels: { state: { seq: 9, lost: 0 }, position: { seq: 120, lost: 3 } }, framesLost: 3, epochSwitches: 1 },
    quarantine: { ready: false, items: [], reason: "not_implemented" },
    quarantineTotal: 0,
    handshake: { state: "ready", caps: ["cmd", "library"], core: "RhineCore" },
    rtt: { p50: 0.4, p95: 1.2, samples: 17 },
  });
  assert.match(html, /未就绪/);
  assert.match(html, /not_implemented/);
  assert.match(html, /累计丢帧 framesLost<\/span><strong>3/);
  assert.match(html, /通道 position/);
  assert.match(html, /quarantine 未就绪/);
  assert.match(html, /p50 0\.4 ms/);
  // 桥缺席（web）
  const webHtml = diagnosticsMarkup({
    diag: DIAG_NOT_READY,
    bridge: null,
    quarantine: { ready: false, items: [], reason: null },
    quarantineTotal: null,
    handshake: null,
    rtt: null,
  });
  assert.match(webHtml, /非桌面宿主/);
});

test("19. 诊断包文本：计数/设置序列/日志说明齐备，不含密钥样式字段", () => {
  const text = buildDiagnosticBundle({
    diag: parseDiag({ underruns: 0, reopens: 0, buffer_ms_now: 10, period_ms: 3, link: null, fallback_history: null }),
    bridge: { ep: 1, channels: { state: { seq: 5, lost: 0 } }, framesLost: 0, epochSwitches: 0 },
    quarantine: parseQuarantine({ items: [{ path: "C:\\x\\bad.flac", reason: "decode_failed", mtime: 1, size: 2, seen_at: 3 }] }),
    negotiated: APP_PERFECT,
    version: { app: "1.0.0", shell: "ready", core: "RhineCore", proto: 1 },
    logHint: null,
    extraSections: { settingsSets: "output.mode=\"shared\"" },
  });
  assert.match(text, /\[bridge\][\s\S]*framesLost=0/);
  assert.match(text, /\[diag\.get\][\s\S]*underruns=0/);
  assert.match(text, /\[quarantine\][\s\S]*bad\.flac/);
  assert.match(text, /\[negotiated\][\s\S]*shared-event/);
  assert.match(text, /settingsSets|output\.mode/);
  assert.match(text, /日志说明/);
});

test("20. reasonFromError：协议错误码 → 人话（not_implemented/timeout/not_desktop）", () => {
  const err = (code) => Object.assign(new Error("x"), { code });
  assert.equal(reasonFromError(err("not_implemented")), "not_implemented");
  assert.equal(reasonFromError(err("timeout")), "壳应答超时");
  assert.equal(reasonFromError(err("not_desktop")), "非桌面宿主");
  assert.equal(reasonFromError(new Error("boom")), "boom");
});

// ——————————————————————————— 配置总线双通道 ———————————————————————————

test("21. mirrorPort + store：web 模式 set 落镜像（JSON dot-path），load 恢复", async () => {
  const storage = memoryStorage();
  const store = createSettingsStore(mirrorPort(storage), false, { localProvider: () => ({}) });
  await store.set("quality.volume_mode", "float");
  const mirror = JSON.parse(storage.dump()[MIRROR_KEY]);
  assert.equal(mirror["quality.volume_mode"], "float");
  assert.equal(store.preset(), "custom");
  // 新 store 从镜像恢复
  const restored = createSettingsStore(mirrorPort(storage), false, { localProvider: () => ({}) });
  await restored.load(ALL_CONFIG_PATHS);
  assert.equal(restored.values["quality.volume_mode"], "float");
  assert.equal(restored.preset(), "custom");
});

test("22. bridgePort：config.get/set dot-path 调用形状与壳侧钳制生效值", async () => {
  const calls = [];
  const fakeBridge = {
    call: async (cmd, args) => {
      calls.push([cmd, args]);
      if (cmd === "config.get") return { value: args.path === "output.buffer_ms" ? 10 : undefined };
      return { value: Math.min(args.value, 100) }; // 模拟壳钳制
    },
  };
  const store = createSettingsStore(bridgePort(fakeBridge), true, { localProvider: () => ({}) });
  await store.load(["output.buffer_ms", "lyric.offset_ms"]);
  assert.deepEqual(calls[0], ["config.get", { path: "output.buffer_ms" }]);
  const applied = await store.set("output.buffer_max_ms", 5000);
  assert.equal(applied, 100); // 钳制后生效值（§5：result=生效值）
  assert.equal(store.values["output.buffer_max_ms"], 100);
  assert.deepEqual(store.sets.at(-1), { path: "output.buffer_max_ms", value: 100 });
});

test("23. 通道异常不阻塞内存态（UI 不假死），错误可被 toast 层拿到", async () => {
  const failing = {
    async get() {
      throw Object.assign(new Error("disconnected"), { code: "disconnected" });
    },
    async set() {
      throw Object.assign(new Error("disconnected"), { code: "disconnected" });
    },
  };
  const store = createSettingsStore(failing, true, { localProvider: () => ({}) });
  await store.load(ALL_CONFIG_PATHS); // 全部失败：保持默认值
  assert.equal(store.values["quality.volume_mode"], "hardware");
  const applied = await store.set("quality.gapless", false);
  assert.equal(applied, false); // 内存态仍记录
  assert.equal(store.values["quality.gapless"], false);
});

test("24. §15 键清单：ALL_CONFIG_PATHS 与 AUDIO-ENGINE §15 的 output/quality/lyric/taskbar 面对齐", () => {
  for (const key of [
    "output.mode",
    "output.buffer_ms",
    "output.auto_expand_buffer",
    "output.buffer_max_ms",
    "quality.volume_mode",
    "quality.resample",
    "quality.gapless",
    "quality.replay_gain",
    "lyric.offset_ms",
    "taskbar.enabled",
    "taskbar.pipe",
  ]) {
    assert.ok(ALL_CONFIG_PATHS.includes(key), `${key} ∈ §15 键清单`);
  }
});

test("25. 预设点选序列断言（headless 同款）：日常档六键写入顺序稳定", async () => {
  const storage = memoryStorage();
  const store = createSettingsStore(mirrorPort(storage), false, { localProvider: () => ({}) });
  const results = await store.applyPresetIpc("everyday");
  assert.deepEqual(results.map((entry) => entry.path), [
    "output.mode",
    "quality.volume_mode",
    "quality.resample",
    "quality.gapless",
    "quality.replay_gain",
    "quality.crossfade_ms",
  ]);
  assert.equal(store.preset(), "everyday");
  assert.equal(applyPreset("custom"), null); // 自定义不可直接应用
  assert.deepEqual(await store.applyPresetIpc("custom"), []);
});
