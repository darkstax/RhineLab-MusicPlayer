# M6E FINDINGS — 设置三层 UI + 信号路径图 + 诊断页（泳道 E，纯前端 src/settings/**）

> 任务书：pi-bg laneE2（`~/.pi/agent/bg-jobs/20260914-191236-laneE2-m6ui/task.md`）；
> 权威：docs/M6-PLAN-v2.md §1-§3；协议 v1.5（diag.get/devices.list/library.quarantine 只读面）；
> AUDIO-ENGINE §13（徽章规则）/§15（配置 schema 与设置三层）。
> 执行：qwen3.8-flash xhigh。**只写盘未 git commit**（并行护栏 3，主进程按泳道验收切分提交）。
> 日期：2026-09-14。

## 0. 结论速览

| 验收项 | 结果 |
|---|---|
| `node --test src/settings/settings.test.mjs` ≥15 例 | ✅ **25/25 绿**（预设映射 5 / chain 三态 6 / 节流 2 / 诊断形状 6 / 配置总线 5 / 键清单 1） |
| tsc + npm run build + check-shell + check-theme | ✅ 四绿；`build:wallpaper` 亦绿（WE 无面板零侵入） |
| `m-verify -Level quick -NoCache` 退出码 0 | ✅ **最终运行 rc=0 全绿**（六步 PASS；过程中两次瞬时 FAIL 均撞 lane F 在途保存 host/**（CS0176 半保存态 / ma_device_init 抖动），非本泳道回归，复跑即绿） |
| headless（dev server + /tmp/pwtest + Edge CDP） | ✅ **27/27 断言**：面板开合 / 预设切换→config 落盘 / 信号路径图三态快照 / 诊断页 / web 零异常（详见 §3） |
| 既有 node 测试回归 | ✅ data 7/7、covers 12/12、library-store 4/4、lrc 26/26、lyric-view 3/3 |

## 1. 文件清单

**新建（src/settings/，全部本泳道地盘）**
| 文件 | 职责 |
|---|---|
| `presets.ts` | 层 1 预设纯逻辑：日常/沉浸/发烧/自定义 → §15 键组合；`matchPreset`（未覆盖键不算匹配→custom）；`constraintState` 互斥灰显表（fixed⊗replay_gain、gapless⊗crossfade、非 force⊗从属项、exclusive 恒灰=M4） |
| `groups.ts` | 层 2 分组 schema+markup+**容器/挂载**：五组（输出/音质/界面/歌词/库）dot-path `config.get/set` 读写；配置总线双通道（desktop=壳 / web=localStorage 镜像 `rhine-music-config`）；`observeMusicSettings` MutationObserver 自挂载（同 mountLibraryPanel 零侵入契约，main.ts 不手动接线）；taskbar 三态（关闭/默认/自定义管道）经 `taskbar.set` 上行 |
| `signal-path.ts` | 信号路径图：`parseNegotiated`（§8 窄读）→ markup（横条 chain，passthrough=绿●/处理=橙◐，factors 列表，fidelity 徽章）+ `Throttle`（min interval + trailing）+ `SignalPathView`（内容去重→节流重绘）+ Rolling Number 接管（460ms 同族）。**UI 只渲染不判断**：未知 fidelity 逐字呈现为中性徽章，绝不推断 |
| `diagnostics.ts` | 诊断页纯逻辑：`parseDiag`/`parseQuarantine`/`parseDevices` v1.5 形状窄读（缺字段=null，区分"没有"与"不知道"）+ `diagnosticsMarkup` + `buildDiagnosticBundle`（诊断包文本，Blob 下载主体） |
| `settings.css` | 全部样式：--theme-* 变量自动跟随明暗（绿/橙状态色带暗色提亮变体）；磨砂卡+细线+双环 ribbon（SVG -free 纯 CSS 环，对齐上游视觉语言）；`prefers-reduced-motion` 直接切换 |
| `settings.test.mjs` | 25 例单测（见 §0） |

**修改（严格限额内）**
| 文件 | 改动 | 行数 |
|---|---|---|
| `src/main.ts` | 2 行 import（markup + css）+ settingsMarkup 模板内 1 处插值 `${isWallpaper ? "" : musicSettingsMarkup()}` | 4 行，**未重构既有函数** |
| `src/m1-mount.ts` | 1 行 import + 2 行初始化（`if (import.meta.env.MODE !== "wallpaper") initMusicSettings();`） | 4 行 |

**未动**：host/**（lane F）、src/scene.ts、src/data.ts、src/player/**（仅 import albumWall/escapeHtml）、docs/IPC-PROTOCOL.md、scripts/**。
（中途曾误向 `src/player/covers/degrade.ts` 追加导出，违反所有权，**已 git checkout 还原**，最终 diff 无 player 面。）

## 2. 实现要点与计划偏差记录

1. **发烧档口径**（任务书为准，覆盖 M6-PLAN.md v1 的"发烧灰显"）：发烧=共享+无缝+全旁路
   （output.mode=shared、gapless=true、volume=fixed、resample=off、dedither=false、
   crossfade_ms=0、replay_gain=off），**不写任何 exclusive 键**；卡片文案明写
   "独占模式暂未开放（M4）；本档 = 共享 + 无缝 + 全旁路，不请求独占"（headless A6 断言）。
2. **设备下拉**：`devices.list`（v1.5 只读面，lane F 并行）未就绪 → `<option>待 M6-F 接线</option>`
   disabled 占位（B2 断言）；就绪 → 系统默认 + 真设备列表（A9，假 bridge 双端点矩阵）。
3. **信号路径图数据源**=订阅 `evt{state}`（协议 §6，negotiated 随 state 快照下发；**不轮询 cmd**）。
   面板重开经模块级 cache 续命订阅；null → "引擎未接入"灰态，DOM 内零伪造节点名（A12-1b：
   `#sp-live-host [data-sp-node]` 计数=0）。
4. **wall.covers 三态迁移进设置**：界面组新增三态按钮，动作经 `albumWall.setUserMode`
   （import only，其自身双通道持久化与降级滞回逻辑零复制）。**遗留冲突见 §5-1**：
   main.ts 原 `.cover-settings` 区仍在（禁改既有函数），暂时双入口，同源同一状态。
5. **未实现键诚实纪律**（§3.6"只开放确实生效的键"）：replay_gain、crossfade_ms 占位灰显
   （"内核未实现，占位灰显"）；release_on_conflict/on_device_gone 以只读单选呈现 Q7/现状口径；
   互斥约束以 ⊘ 原因文案进 DOM（A11）。
6. **诊断页四件套**：diag.get（未就绪→"未就绪（not_implemented）"，A13 真数据渲染 underruns=2）、
   bridge.diagnostics()（framesLost/ep/每通道 seq·lost，同源断言 = A13/B 段）、
   library.quarantine 表（空表"隔离表为空"、坏条目跳过、未就绪占位）、诊断包 Blob 下载。
   IPC 往返=桥侧 cmd 计时 64 槽环形（p50/p95/samples，不改协议）。
7. **web 模式零异常**：无 bridge → store 走 localStorage 镜像，面板顶部明标
   "本机镜像模式 · 仅本机生效"（data-ms-storage="local"，B1）；pageerror=0、console.error=0（B6/B7）。
8. 任务书"三层容器"未单列 `index.ts`：容器/挂载逻辑并入 `groups.ts`（文件所有权清单以任务书为
   准，未新增清单外文件）。
9. m1-mount 初始化：任务书写"desktop 下初始化"，但验收 4 又要求 web 模式有镜像面板——按验收
   落地为**全模式初始化、壁纸构建排除**（WE 无此面板，MutationObserver 常驻对 60fps 壁纸是
   不必要的开销，且 main.ts 侧已按 `isWallpaper` 不渲染面板）。

## 3. 验收证据

- **单测**：`node --test --experimental-strip-types src/settings/settings.test.mjs` → 25 pass 0 fail。
  覆盖：预设映射与顺序（1/2/4/25）、发烧=共享+无缝+全旁路不含独占（2）、matchPreset 归 custom（3/6）、
  互斥灰显四规则（5/6）、chain 三态解析与 markup（7-12，含未知 fidelity 与转义）、
  Throttle 立即/合并/trailing（13）、View 去重（14）、diag/quarantine/devices 窄读（15-17）、
  诊断 markup 未就绪优雅态（18）、诊断包（19）、错误码人话（20）、镜像/桥/异常通道（21-23）、§15 键清单（24）。
- **构建链**：`npx tsc --noEmit` 绿；`npm run build` 绿（offline release 818 files）；
  `npm run build:wallpaper` 绿（825 files）；`node scripts/check-shell.mjs` 绿；`node scripts/check-theme.mjs` 绿。
- **m-verify**：`pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/m-verify.ps1 -Level quick -NoCache`
  → 最终运行 **rc=0 全绿**（六步全 PASS：build web+dotnet / core / mirror / scenario-stub / spec-core / spec-stub）。
  过程中两次瞬时 FAIL 均撞 lane F 在途批量保存（第一轮 RhineCoreStub CS0176 半保存态；
  第三轮 spec-core `ma_device_init no device`——core 源文件 22:13:41 正被重写）；
  两轮之间本泳道代码未动、宿主 Windows 音频设备状态抖动；复跑即绿。
  并发期 FAIL 归编排不计产品（commit b44be16 护栏）；本泳道未触碰 host/**。
- **headless**：`verification/m6e/m6e-headless.mjs`（playwright-core@/tmp/pwtest → **Windows Edge
  headless CDP:9333**，NO_PROXY='*'，vite dev 5178）→ **27/27**；机器可读
  `verification/m6e/m6e-headless.json`；截图 `signal-null.png` / `signal-app-perfect.png` /
  `signal-processed.png`（三态快照断言 A12-1/2/3）+ `desktop-panel.png` / `web-panel.png`。
  预设落盘断言=A5/A7（假壳捕获 7 键 config.set 序列，`window.__fakeShell.config` 逐键值比对）+
  B3/B4（web 镜像 JSON 逐键比对）；pageerror=0 双面（A15/B6）。
- **环境限制备案**（非回归）：WSL 本地 chromium-1228（swiftshader 软渲染）在本机当前负载下
  **打开设置面板即冻结主线程**——git stash 基线对照证明改动前后同冻结（同一 `?scene=archive`
  全阵列页 + settings 点击序列），故 headless 走 Edge CDP 真 GPU（m-verify 快车道同思路）。
  A14 Blob 下载事件在 Edge headless+WSL FS 下未捕获 → 降级为"点击导出钮零异常"，
  诊断包文本内容断言由单测 19 覆盖。

## 4. 探针面（供 reviewer / 主进程复验）

`window.__rhineSettings`：`snapshot()`（desktop/tier/preset/values/sets/devicesReady/diagReady/
quarantineReady/livePath/framesLost/mounted）与 `feedNegotiated(n)`（三态快照注入，A12 用法）。
与 __rhinePlayer/__rhineBridge/__rhineCovers 同一纪律：只读 + 注入，不暴露写动作。

## 5. 与 lane F 的接口缺口 / 待主进程裁决清单

1. **wall.covers 双入口**：原 `.cover-settings`（main.ts settingsMarkup 内）与本泳道界面组入口并存。
   同一状态源（albumWall），无功能冲突；但按计划"迁移进设置"应删原区——**main.ts 本泳道禁改
   既有函数**，请主进程验收时二选一（删原区或保留双入口一个周期）。
2. **壳日志 tail 无协议面**：协议 §3 log 帧不转发前端，v1.5 也未新增 log cmd → "tail 导出"降级为
   **诊断包 Blob**（含前端可观测事实 + 桥计数 + 设置序列 + 日志路径指引）。若 lane F 增设
   `log.tail`（壳侧自答环形缓冲，≤64KB/帧），前端在 `exportBundle.extraSections` 一处即可并入原文。
3. **IPC 往返直方图细节**（M6-PLAN.md §3.4 的 p50/p95/max 64 槽）：本实现取桥侧 cmd 计时环形
   （p50/p95 + samples），max/直方图桶需 lane F 在 `diag.get.link` 或新只读面给核心侧 RTT。
   v1.5 §5 `diag.get` 的 link=negotiated 同构，无 rtt 字段——**当前标注"直方图属 lane F 数据面"**。
4. **quarantine"重扫该文件"按钮**：v1.5 `library.scan` 无 `paths` 参数（M6-PLAN.md §3.5 草案有、
   定稿无）→ 仅表渲染 + 全量重扫钮（A 段验证过 fake shell 路径）。协议升 paths 后补行内钮。
5. **config 键生效面**：UI 写入 §15 全键（output.*/quality.*/lyric.*/taskbar.*）；核心当前只消费
   `output.*` 子集（其余为持久化待接线，占位/未实现键已灰显）。lane F 核心读取 quality.* 时
   无需前端改动（config.get 已就位）。
6. 桩（RhineCoreStub）的 `config.get/config.set` 仍回 `not_implemented`（M1 口径）：真壳自答 config.*
   不受影响；桩环境下设置走内存态+镜像（store 异常吞并路径，单测 23 覆盖），toast 提示保存失败。
   若 lane F 给桩补 config 自答，面板在桩下即全功能（无前端改动）。

## 6. 纪律核对

心跳分步✅ · 无 3 连败（两次脚本级失败为断言口径问题，即时修正）✅ · 未动 remote✅ ·
日志/诊断包/单测字面量无凭据（仅路径与计数）✅ · 未改任何 check-*.mjs；文案冲突扫描：
check-startup-motion 断言的"系统设置"按钮名与 `.settings-label` 未动、check-web-integration 断言的
`[data-color-theme]`/`[data-pref="superPerformance"]` 未动、`cover-settings`/`data-cover-mode` 原区未动
——**零冲突**✅ · 只写盘未 commit✅。
