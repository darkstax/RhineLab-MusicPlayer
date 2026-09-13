# M6 计划书：设置三层 UI + 信号路径图 + 诊断 + 打包交付（zip + exe）

> 状态：**已批准（09-13 用户：P-1 Inno Setup 通过）——待开工** · 2026-09-13
> 依据：`docs/GOAL-AUTONOMY.md` §0/§2/§4/§5/§6（Windows 版交付线的最后一个里程碑）、
> `docs/AUDIO-ENGINE.md` §13（信号路径图定义）/§14（诊断页"优先级不做可裁剪"）/§15（配置系统与三层设置）/§21（许可备忘）/§24（Q8 台账）、
> `docs/IPC-PROTOCOL.md` v1.3、`docs/M5-PLAN-v2.md`（曲库/歌词/专辑墙交付面）、
> `/home/starl/AGENTS.md` 轮子优先铁律。
> 前序：M2 完成；M3 代码写盘待收尾；M5（v2）交付曲库+歌词+专辑墙。**M6 之后 goal_complete**。

## 0. 范围（一句话）与三块工作

把"能跑的工程"变成"能交给别人的软件"：**设置三层 UI（预设 → 分组精细 → 诊断）+ 信号路径图**
（渲染 `negotiated.chain`，复用上游双环内构视觉语言）+ **打包链**（`scripts/package.ps1` 出
zip 便携版 + exe 安装器）+ **许可终稿**（LICENSE 与 THIRD-PARTY-NOTICES）。

| 块 | 内容 | 新依赖 |
|---|---|---|
| A | 设置三层 UI（预设/分组/诊断）+ 配置持久化对齐（TOML 键名不变） | 无（纯前端 + 既有 `config.get/set`） |
| B | 信号路径图（活体链路图）+ 诊断页（underrun / framesLost / quarantine） | 无（前端组件 + `diag.get` 启用） |
| C | 打包：`dotnet publish`（框架依赖）+ zip + exe 安装器 + 图标/版本/卸载 | 构建期工具 1 个（安装器编译器，**不进分发产物**） |
| D | 许可终稿：LICENSE 核对 + `THIRD-PARTY-NOTICES.md` 机器生成 | 生成器工具（构建期） |
| E | 小窗模式（自 M5d 移来，见 M5-PLAN-v2 §5.10） | 无（WPF 窗口宿主，BCL） |

**明确不做**：updater（§8 停点）、独占/M4 域（`output.mode` 仍 `not_implemented`，
`host/core/src/main.cpp:432`）、Linux 壳（M7）、签名证书（§8 停点）、GPL 任何件入包（Q8 铁律）。

## 1. 现状核实（写计划前先读盘，v1 式"假设先行"的纠正）

| 事项 | 计划假设的来源 | 实测事实 | 结论 |
|---|---|---|---|
| LICENSE 需"换成 MIT" | 任务书原文 | **仓库根 `LICENSE` 已是 MIT**（`Copyright (c) 2026 LBEILC`，commit `e27c2b3` "docs: license project code under MIT and clarify asset rights"） | 本项从"改写"降级为**核对 + 补资产权利说明**（§6.1） |
| 安装器选型 | ~~Q8 台账 NSIS vs 推荐 Inno 矛盾~~ | — | ✅ **P-1 已批准（09-13 用户）：Inno Setup**；AUDIO-ENGINE §24 台账已同步 |
| 产物目录 | GOAL-AUTONOMY §4 写 `dist-release/`；工作区 AGENTS.md 写 `release/<project>/<target>/`（本仓 `.gitignore` 第 13 行已忽略 `release/`） | 两个约定并存 | 生成在 `dist-release/`（**需向 `.gitignore` 新增该条目**，实测当前只有 `dist/`、`dist-host/`），交付副本放 `release/RhineLab-MusicPlayer/win/`（§5.1-6） |
| `diag.get` | 协议 §5 标 M4 | 真核心 `host/core/src/main.cpp:432` 与 `devices.*`/`output.mode` 同分支回 `not_implemented`；但 underrun 计数器**已存在**（`host/core/src/audio.h:106`、`audio.cpp:219-223`） | 诊断页需要**只读**启用 `diag.get`（§3.4，协议 v1.5），不碰 M4 的写路径 |
| `framesLost` | — | 桥已实现（`src/desktop-bridge.ts:111-116,222-228`），注释明写"**M6 诊断页复用**" | 现成，零改动 |
| 设置 UI 挂载点 | — | `main.ts:661 settingsMarkup()` 已是"markup 函数族"拼装（`themeSettingsMarkup`/`audioSettingsMarkup`/`qualityMarkup`/`workbench.settingsMarkup`/`motionSettingsMarkup`/`pwaSettingsMarkup`） | 新模块**照同一族风格**加入，不重构既有函数（§3.1） |
| 配置存储 | §15 要求 TOML | 壳现为 `ConfigStore` + `%APPDATA%\RhineMusic\config.json`（dot-path，`Bridge.cs:169-215`）；协议 §5 注："M2 起迁移 TOML schema，键名不变" | **迁移未做**。M6 决定：保留 JSON（键名/语义不变），TOML 降级为"建议"（§9-1），理由见 §3.2 |
| 上游资产许可 | §21 | `package.json` 已是 `"license": "MIT"`；npm 依赖仅 `three` + `@kitlangton/rolling-number`（lock 内 76 个顶层包，含 vite/prettier 等 dev）；vendor = miniaudio(MIT/Unlicense) + nlohmann-json(MIT) + kissfft(BSD-3，M5a 新增) | 依赖树可机器枚举（§6.2） |

## 2. 打包工具链检索对比表（轮子优先铁律：先检索，再选型）

### 2.1 分层检索

**第①层：同品类完整开源应用（可抄打包件）**

| 项目 | 技术栈 | 打包方式（实测其仓库脚本） | 可拄性 |
|---|---|---|---|
| **go-musicfox**（本机 fork，同作者生态、同任务栏协议） | Go 单二进制 | `goreleaser` + GitHub Actions，产物 zip / deb / rpm / **exe（NSIS）** | ✅ **形态参照**（zip+exe 双产物、版本号注入、多平台矩阵），但 NSIS 脚本与 Go 的 CGO/单文件假设与我们 .NET 多文件产物不同，脚本不能直接搬 |
| **btop4win**（本工作区，C++） | C++ + MSVC | CMake + 手工 zip / release 上传 | ⚠ 无安装器经验可拄 |
| **sysmon-cmdpal**（本工作区，C#/.NET 10 PowerToys 扩展） | C#/.NET 10 | PowerToys 宿主负责安装；本机另有 MSIX 侧（`verify-devmode.ps1` 存在 = 开发模式旁路） | ⚠ 它的安装面被 PowerToys 吃掉，不适用独立应用 |
| **Wallpaper Engine 壁纸（本工程 `wallpaper/`）** | Web | `publish.xml` + 编码盘（`docs/WALLPAPER-PUBLISH.md`） | ⚠ 完全不同的分发面（创意工坊），不复用 |
| **Taskbar-Lyrics**（C++ 插件） | C++ | 用户手工放文件 + 注册脚本 | ⚠ 无安装器 |

→ 第①层结论：**没有可直接复用的 .NET 桌面安装器件**；go-musicfox 只给"双产物 + CI 出包"的形态参照。

**第②层：系统原生 API（Windows 自带能力）**

| 能力 | 事实 | 判定 |
|---|---|---|
| **MSIX / AppxPackaging**（`MakeAppx.exe`、`Add-AppxPackage`） | Win10+ 内置部署面；但 WPF/Win32 桌面应用需**打包外壳工程**（Windows Application Packaging Tool / VFS），且 **MSIX 强制签名**（自签需用户侧安装证书 + 开发模式/信任策略），WebView2 in MSIX 有虚拟化合并与 userDataFolder 的已知坑 | ✗ 与"本地自用 + 无人值守 + 任意路径"三点冲突；签名是硬门槛（§8 P-3） |
| **`Compress-Archive` / `Expand-Archive`**（PowerShell 内置） | 零依赖出 zip；~40MB 产物耗时可接受（秒级） | ✅ **zip 便携版直接用**（不引 7z，避免构建期外部依赖） |
| **`msiexec` + Windows Installer 服务** | MSI 需 MSI 数据库工具链（WiX 即是），非"原生脚本" | ⚠ 属第③层工具的产出 |
| **ClickOnce** | 需签名清单 + IIS/共享部署点，桌面自用不适配 | ✗ |
| **`dotnet publish --self-contained` / 单文件** | .NET 10 SDK 原生（本机 SDK 10.0.400，§23 实测） | ✅ 产物生成方式；**框架依赖 vs 自包含**需拍板（§2.3） |

**第③层：专用库/工具（安装器编译器）**

| 候选 | 许可（实测原文） | 最新形态（实测） | 脚本量 | 无人值守 | 与本项目匹配度 | 判定 |
|---|---|---|---|---|---|---|
| **Inno Setup**（`jrsoftware/issrc`，5628★，pushed 2026-09-11） | 自有 **BSD 风格 3 条款**（`license.txt` 原文："Permission is granted to anyone to use this software for any purpose, including commercial applications…"，条件为保留版权声明/不歪曲来源/不冒充作者） | **7.1.0**（2026-08-12）；6.x 末版 **6.7.3**（2026-05-26） | **~40 行 `.iss`** | ✅ `ISCC.exe /Qp /O<out> setup.iss`，退出码可靠 | ✅ 装 .NET 检测（Pascal `RegQueryMultiSzValue` 查 `sharedfx\Microsoft.WindowsDesktop.App`）、卸载、开始菜单/桌面图标、`/PORTABLE=1` 静默、组件选择（核心/桩）全内置 | ✅ **推荐** |
| **WiX Toolset v7**（`wixtoolset/wix`，1138★，pushed 2026-09-09） | **MS-RL**（`LICENSE.TXT` 原文：Microsoft Reciprocal License） | **v7.0.0**（2026-04-06）；v6.0.2（2025-08） | **~100–150 行 XML**（`Package.wxs` + Fragment + 目录表 + 注册表 + UI）+ SDK NuGet 接线 | ⚠ `wix build` CLI 可用，但 v7 是**大版本切换**（v6→v7 语法/扩展破坏性变更，需重学） | ⚠ MS-RL 属"reciprocal"，虽为构建期工具不入分发产物，但**不在用户白名单（MIT/BSD/Apache/PD）**，需显式点头 | ✗ 出局（许可面 + 脚本量 + v7 迁移风险） |
| **NSIS**（`nsis-dev/nsis`，865★，镜像自 SourceForge，pushed 2026-09-12） | **zlib/libpng**（源码/插件/头文件）；bzip2 模块 = bzip2 许可；**LZMA 模块 = CPL 1.0**（`COPYING` 原文） | 无 GitHub release 页（发布在 SourceForge，取版本需额外一跳） | **~60–80 行 `.nsi`** | ✅ `makensis /V2 /DVERSION=… setup.nsi` | ⚠ Q8 台账字面选它；但 UI 现代度低、无内置 .NET 检测（需插件）、简体中文需 Languagepack 插件、LZMA 模块 CPL 需备案 | ⚠ **备选**（若用户坚持台账字面） |
| **MSIX（第②层）+ 自签** | OS | — | 高（外壳工程） | ✗ 需证书与信任步骤 | ✗ 破坏便携性 | ✗ 见 §2.1-② |
| **纯 zip（无安装器）** | — | — | 0 | ✅ | ⚠ 交付要求明写"zip 便携版 **+ exe 安装器**"（GOAL-AUTONOMY §0） | ✗ 单独不满足交付面 |
| **Tauri v2 / Electron builder** | MIT | — | — | — | ✗ 架构错位（我们是 WebView2 壳，不是 Tauri/Electron），换它等于重写宿主 | ✗ 不评估 |

**第④层：自写** → 不写安装器（Windows 上自写安装器 = 手写 MSI/PE 资源/卸载登记，
第①②③层均有十年以上成熟件，违反铁律）。

### 2.2 选型结论

**zip = `Compress-Archive`（PS 内置，零新依赖）；exe = Inno Setup（推荐 7.1.0，保守可锁 6.7.3）。**

淘汰理由汇总：WiX v7 = MS-RL 不在许可白名单 + 脚本量 2–3 倍 + v6→v7 迁移风险；
NSIS = 可用但 .NET 依赖检测/中文 UI/现代观感都要额外插件，且 SourceForge 取件多一跳网络依赖
（本环境代理只放行 GitHub/nuget/npm 已验证）；MSIX = 签名硬门槛 + 破坏便携；自写 = 违反铁律。

**许可纯净性说明（重要，防 reviewer 误判）**：Inno Setup / NSIS / WiX 都是**构建期工具**，
其产物（安装器 exe）不包含工具的可分发运行时（Inno 的 `ISCDEXE`/`Setup.e32` 属其自身许可下的
运行时 stub，按 Inno 许可条款允许随安装包再分发，条款 2 要求保留版权出现处——安装向导"关于"里
已有）。因此**它们不进 `THIRD-PARTY-NOTICES.md` 的产品依赖清单**，改为在 `docs/PACKAGING.md`
的"构建工具"小节备案（§6.3）。构建期工具与分发依赖分开登记，避免把许可面搞混。

**已定案（09-13 用户批准 P-1）**：Inno Setup（推荐 7.1.0，保守锁 6.7.3）；`AUDIO-ENGINE.md` §24 台账行已同步改注。

### 2.3 框架依赖 vs 自包含（同属打包选型，必须一起拍板）

| 方案 | 产物体积（估算） | 用户前置 | 判定 |
|---|---|---|---|
| **框架依赖**（现状 `dotnet publish`，无 `-r`/`--self-contained`） | ~30–45MB（壳 + 核心 642KB + 前端 dist + 字体/GLB 资产） | 需 **.NET 10 Windows Desktop Runtime**（本机已装 SDK 10.0.400，§23）+ WebView2 Runtime（已装 152.0.4191.66） | ✅ **GOAL-AUTONOMY §0 明写"框架依赖"**，维持；安装器负责检测并给出明确提示（缺 runtime 时不静默失败） |
| 自包含单文件（`--self-contained -p:PublishSingleFile=true`） | ~150–180MB | 无 | ⚠ 体积 4 倍；且核心是独立 C++ exe，不能真"单文件"；zip 双产物意义被削弱 |
| 自包含 + 裁剪（`PublishTrimmed`） | ~80MB | 无 | ✗ WPF 不支持 trimming（官方限制），直接出局 |

## 3. A+B：设置三层 UI、信号路径图、诊断页

### 3.1 文件所有权与模块边界

```
src/settings/                      ← M6 新目录（前端零新依赖）
  index.ts            三层容器：预设 → 分组精细 → 诊断；沿用 modal 机制（`main.ts:564 openModal()`、`main.ts:661 settingsMarkup()`）
  presets.ts          预设档位（日常/沉浸/发烧/自定义）→ 映射为 §15 的 config 键组合
  groups.ts           分组精细（输出/音质/曲库/歌词/任务栏/系统/界面）
  signal-path.ts      信号路径图（渲染 negotiated.chain，§3.3）
  diagnostics.ts      诊断页（underrun/framesLost/quarantine/协商 vs 源/IPC 往返，§3.4）
  settings.css        新组件样式（沿用既有 .settings-list / label / .toggle 结构）
src/main.ts          仅改 settingsMarkup() 的拼装（把既有六段 markup 归入"分组精细"层）
host/RhineShell/Hosting/Bridge.cs   diag.get 的壳侧聚合（若核心未连则本地自答，§3.4）
docs/IPC-PROTOCOL.md  v1.5（diag.get 定形 + evt{diag} 定形）
scripts/package.ps1  scripts/installer.iss  scripts/third-party-notices.mjs   ← C/D 块
host/RhineShell/MainWindow.xaml*  App.xaml.cs  Hosting/ShellOptions.cs        ← E 块（小窗）
```
**不碰** `host/core/**`（除 §3.4 若需 `diag.get` 只读实现——见该节边界声明）、`src/scene.ts`。

### 3.2 配置层：保留 JSON，TOML 降级为"建议"

§15 写的是 TOML（借 musicfox 经验）。实测：协议 §5 注"M2 起迁移 TOML schema，**键名不变**"，
但 `ConfigStore` 至今是 JSON 且**已被前端 dot-path 依赖**（`config.get/set` 全链）。
M6 判定：**不迁移 TOML**，理由三条：
1. 用户面收益为零（本机自用，改配置走 UI，不手编文件）；
2. 迁移要动 `ConfigStore` + 首启导出注释 + BOM 容忍测试（§15 三条），纯成本；
3. 键名/语义不变 = 未来真要 TOML 时是**一次机械替换**，不构成锁定。
→ 记入 §9 建议-1，`docs/OPEN-DECISIONS.md` 备案；M6 只做"配置键清单与 §15 对齐"（缺的键补默认值）。

### 3.3 信号路径图（AUDIO-ENGINE §13，"Roon 式"）

**唯一数据源 = `negotiated` 对象**（协议 §8）。UI 不得自行推断保真状态（§8 末行铁律），
徽章由 `badges` 渲染（M1 桩允许 null；真核心为对象，M2-FINDINGS §1 #30）。

```
[源文件] → decoder → resample → volume → (tap: spectrum) → output backend → endpoint
           chain[i].node/detail/passthrough    fidelity    factors[]
```

**渲染规则（逐条可实现）**：
- 节点序列：直接遍历 `negotiated.chain`，**顺序与内容全由核心给出**，前端不硬编码节点名
  （M2-FINDINGS §5 的 `flac s24->s32`、`mp3 f32->s32`、`float-convert` 等 detail 原样显示）；
- 节点态：`passthrough: true` → 实线 + "直通"；`false` → 虚线 + "处理"（颜色用琥珀标记，暗色同族）；
- 端点标签：`share`（exclusive/shared-event）、`backend`、`format{rate,bits_container,bits_valid,encoding,channels}`、
  `buffer_ms`/`period_ms`/`auto_expanded`；
- 徽章行：`fidelity`（bit-perfect 绿 / app-perfect 橙 / processed 灰）+ `factors` 逐项列出
  （`shared-mixer`/`float-decode`/`resample`/`float-volume`/`hardware-volume`——M2-FINDINGS §3-B8/§5 已产出的实际值）；
- **数据驱动，零推断**：桩（无 negotiated）时整图显示"引擎未接入"占位，不画假链路。

**视觉复用（上游双环内构语言）**：
- 拓扑语言：内圈=信号链（节点沿圆周排布）、外圈=保真刻度（factors 标出打断点），
  与 `src/internal-optics.ts:33 configureInternalOptics` / `:63 internalOpticsFragment`
  的双环材质/发光语言同源（对照 `verification/INTERNAL-OPTICS.md`、`verification/RING-TEXTURE.md`）；
- 实现形态：**2D SVG/DOM 组件**（不新建 WebGL 场景）——理由：设置弹窗内嵌、需在减少动态效果下可读、
  且 M3 任务书 §C.3 已把"播放条 16 根微型频谱条"作为活体演示素材，路径图沿用同一 DOM 层级；
  双环观感靠 SVG `circle` + `stroke-dasharray` + 既有 `--theme-*` 变量达成，
  真三维版列入 §9 建议-3（不做）；
- 过渡：复用 `SurfaceTransition`/`ContentTransition`（`main.ts:130-131`），150/180ms 同族；
  减少动态效果直接切换（上游既有约定）。
- 实时性：订阅 `evt{state}`（negotiated 随 state 快照下发，协议 §6）+ `evt{position}` 的
  `buffered_ms`；**不轮询 cmd**（省电与 IPC 纪律）。

### 3.4 诊断页（§14"优先级不做可裁剪"）

| 指标 | 数据源 | 现状 | M6 动作 |
|---|---|---|---|
| **underrun** | 核心 `underrunCount_`（`host/core/src/audio.h:153`，`audio.cpp:219-223` 只在 primed 后计数） | 计数器在，但**无出口**：`diag.get` 回 `not_implemented`（`main.cpp:432`）；`evt{diag}` 未发 | **启用 `diag.get`（只读）**，见下方边界声明 |
| **framesLost / 丢帧** | 桥 `diagnostics()`（`desktop-bridge.ts:222-228`：`framesLost`、`epochSwitches`、`sequence`），注释已写"M6 诊断页复用" | ✅ 现成 | 直接渲染 + 每通道（state/position/spectrum/lyric）明细 |
| **quarantine** | M5a 的 `quarantine` 表 + `library.stats.quarantine` | M5a 交付 | 列表（前 20 条：路径/原因/attempts）+ "重扫该文件"按钮（走 `library.scan {full:false, paths:[…]}`，若 M5a 未实现 paths 参数则降级为"仅展示"） |
| 协商格式 vs 源格式 | `negotiated.format` + `tracks.sample_rate/bit_depth/codec`（M5a schema） | 两侧都有 | 对照表（当前曲源 → 设备实际），差异项高亮 |
| IPC 往返延迟直方图 | 桥的 `call()` 计时（`desktop-bridge.ts:168`） | 未记录 | 桥内加 64 槽环形直方图（p50/p95/max），**不改协议** |
| 环形日志导出 | 壳 `Log.cs` + 核心 `log` 帧（协议 §3，不转发前端，仅进环形缓冲与日志文件） | 壳侧有 | 诊断页"导出诊断包"→ 写 `%LOCALAPPDATA%/RhineMusic/diag/<ts>.txt`（含 negotiated/stats/版本/曲库计数） |

**`diag.get` 启用的边界声明（防 M4 扩张，写给 reviewer）**：
- 只做**只读计数聚合**：`{underruns, reopened, buffer_ms_now, last_fallback, link:{…壳侧统计…}}`；
- **不实现** `output.mode`、不做缓冲升档、不做独占/协商状态机（M4 域，一字不碰）；
- `reopened`/`last_fallback` 在共享模式下恒为 0/null，如实返回（不编造）；
- 壳侧聚合：核心未连接（桩/离线）时壳自答 `diag.get`，`link` 段填壳可见事实（管道 RTT、
  重连次数），`underruns` 填 null 而非 0（**区分"没有"与"不知道"**，诚实性红线同 M2-FINDINGS §5）。

### 3.5 协议 v1.5 增量草案

```jsonc
// §5：diag.get 由"M4"改标"M6（只读子集）"，参数 —
"diag.get":  — → { "underruns": 0, "reopened": 0, "buffer_ms_now": 10,
                   "last_fallback": null, "link": { "rtt_ms_p50": 0.4, "rtt_ms_p95": 1.2,
                     "reconnects": 0, "framesLost": {"state":0,"position":0,"spectrum":3} } }
// §6：evt{diag} 由"计数变更/1Hz"定形为最小集（仅计数变更时发，不做 1Hz 心跳）
"diag": { "underruns": n, "underrun_delta": d, "buffer_ms_now": n, "reopened": n }
// §7：不新增错误码
// §4 caps：核心 caps 追加 "diag"（桩同步追加，保持协议裁判可用）
```
`library.scan` 的 `paths` 可选参数（诊断页"重扫该文件"用）也一并写进 v1.5 的 library 行。

### 3.6 设置三层 UI 结构（§15 原文的分层）

```
层 1 预设（互斥单选，联动灰显）
  日常   = shared + hardware 音量 + gapless 开 + 独占关 + 律动开
  沉浸   = shared + fixed 音量 100 + 减少动效关 + 封面纹理开
  发烧   = （M4 域）→ **灰显 + 标注"需独占模式支持，将在后续里程碑开放"**（不实现不欺骗）
  自定义 = 任一精细项被改动后自动进入
层 2 分组精细（§15 的 TOML 节 → 现 JSON 键，键名逐条对齐）
  输出 output.*    | 音质 quality.*   | 曲库 library.*  | 歌词 lyric.*
  任务栏 taskbar.*（仅 enabled + pipe 两项，Q4 裁定）
  系统 system.*（smtc / takeover_media_keys / autostart / single_instance）
  界面（既有 theme / superPerformance / reduced / quality / workbench / pwa 六段归此层）
层 3 诊断（§3.4）
```
- 约束联动：`volume_mode=fixed` 与 `replay_gain≠off` 互斥（§6 bit-perfect 冲突的正解）→ 灰显 + 说明；
  `dedither`/`crossfade_ms>0`/`resample=force` 任一激活 → 路径图与徽章自动变 processed（数据驱动，UI 不判定）。
- **v1 只开放"确实生效"的键**：`exclusive`/`dsp.eq_enabled`/`replay_gain`/`cue` 等未实现项
  以**只读展示 + "未启用"标记**呈现，不做能改但不生效的开关（诚实性；桩/真核心行为差异同 M2-FINDINGS §2.6 纪律）。
- 持久化：全部经既有 `config.set`（dot-path，`Bridge.cs:180`），前端不写文件。

### 3.7 验收（A+B 块，无人值守）

```
1  npx tsc --noEmit && npm run build && node scripts/check-shell.mjs            → 三绿
2  node scripts/check-settings.mjs（新增，headless CDP 9250，NO_PROXY='*'）：
   a. 打开设置 → 三层导航可达（预设/分组/诊断），预设切换后 config.set 调用序列符合 §3.6 表
   b. "发烧"档位 aria-disabled=true 且不可点
   c. volume_mode=fixed + replay_gain=album 组合下，被禁项灰显且带说明文案
   d. 桩环境（无 negotiated）→ 路径图显示"引擎未接入"占位，DOM 内无伪造节点名
   e. 真核心环境（--core-exe）→ 路径图节点数 == chain 长度、detail 文本与 §8 样例逐字匹配、
      factors 全部呈现（shared-mixer / float-decode / resample / float-volume）
   f. 诊断页：framesLost 数字与 bridge.diagnostics() 返回值一致（同源断言）；
      quarantine 行数 == library.stats.quarantine
   g. 减少动态效果：路径图/设置过渡直接切换，无 animation 运行（getAnimations().length==0）
3  pwsh tools/m2-smoke/smoke.ps1 扩展段：diag.get → ack 且 underruns 为整数、reopened=0、
   last_fallback=null；桩同形（caps 含 diag）
4  pwsh scripts/m1-scenario.ps1 → ALL PASS（协议面不破）
5  node scripts/check-super-performance.mjs && node scripts/check-theme.mjs
   && node scripts/check-quality.mjs → 既有设置面回归绿
```

## 4. E：小窗模式（自 M5d 移来）

- 目标：设计稿右上角方框图标对应的**迷你播放窗**——无边框、置顶、可拖动、随尺寸重排，
  显示封面 + 曲名/艺术家 + 当前歌词行 + 播放/上下曲。
- 实现（BCL，零新依赖）：`host/RhineShell/MiniWindow/` 新增 `MiniWindow.xaml(.cs)`
  （`WindowStyle=None` + `AllowsTransparency` + `Topmost` + `ResizeMode=CanResizeWithGrip` +
  `AllowsTransparency` 下的圆角与阴影）；`ShellOptions.cs` 加 `--mini` 启动参数；
  前端复用 `src/player/player-bar.ts` 的紧凑态（同一 store，不复制状态机）。
- 数据：小窗内嵌第二个 WebView2 控件 vs 复用主 WebView 的可见区？**取前者**（独立页面
  `mini.html`，Vite 多入口），理由：主窗口最小化到托盘时小窗要能独立存活（同 WebView2 进程组，
  注意 GOAL-AUTONOMY §3 的 userData 分组复用坑）。
- 验收：`--mini` 启动 → 窗口存在且置顶、播放控制可用（CDP 9260 断言 playerStore 状态变更）、
  关闭主窗后小窗存活、退出时两窗均释放（无进程泄漏）。
- 预估：worker **0.5 轮**。

## 5. C：打包链实施（`scripts/package.ps1`）

### 5.1 步骤（编号，含文件）

1. **产物准备**（复用既有脚本，不重写）：
   `scripts/m-build.ps1`（`dotnet publish` 壳+桩 → `dist-host/`，含前端 `dist/`）+
   `scripts/m2-build.ps1`（`RhineCore.exe` → `dist-host/core/`）。
   package.ps1 **调用**它们而非重实现（单一构建事实源）。
2. **暂存目录** `dist-release/staging/RhineMusic/`：
   `RhineShell.exe`、`RhineCore.exe`、`RhineCoreStub.exe`（保留：协议裁判，GOAL-AUTONOMY §1 D2）、
   `web/`（前端 dist）、`LICENSE`、`THIRD-PARTY-NOTICES.md`、`README-Windows.md`（新增，安装/卸载/
   曲库扫描/任务栏管道说明）、`VERSION.json`（`{app,core,proto,build,git}` —— `app` 取
   `RhineShell.csproj` 的 `<Version>`，`proto` 取协议 §11 最新行，构建时注入）。
   **排除清单**（硬编码 + 断言）：`*.pdb`、`bin/`、`obj/`、`library.db*`、`config.json`、
   `webview2/`、`covers/`、`diag/`、任何 `.env`/密钥（防呆：命中即 fail，密钥红线）。
3. **zip**：`Compress-Archive` → `dist-release/RhineMusic-<ver>-win-x64-portable.zip`。
4. **exe**：`scripts/installer.iss`（Inno，~40 行）→ `ISCC.exe` →
   `dist-release/RhineMusic-<ver>-win-x64-setup.exe`。
   `.iss` 要点：`DefaultDirName={autopf}\RhineMusic`、`PrivilegesRequiredOverridesAllowed=dialog`、
   `ArchitecturesInstallIn64BitMode=x64compatible`、`[Run]` 可选启动、卸载保留
   `%LOCALAPPDATA%\RhineMusic`（曲库/收藏）并给"同时删除数据"复选、
   `PrepareToInstall` 里查 .NET 10 Desktop Runtime（`HKLM\SOFTWARE\dotnet\Setup\InstalledVersions\x64\sharedfx\Microsoft.WindowsDesktop.App`）
   与 WebView2 Runtime（`HKLM\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-9BDF-00C3A9A70D4C}`），
   缺失 → 中止并给出**明确文案 + 下载链接**（不静默失败）。
   Inno 编译器定位：`ISCC.exe` 路径经 `-InnoSetup` 参数或 `PATH`，缺失即 fail-fast 并打印安装指引
   （构建机需一次性装 Inno，属环境准备，不进仓库）。
5. **校验与清单**：`dist-release/checksums.sha256.txt`（两产物）+ 打印体积、文件数、
   `git rev-parse --short HEAD`；产物名不含空格。
6. **交付副本**：可选 `-Publish` 开关把两产物复制到工作区
   `release/RhineLab-MusicPlayer/win/`，并只保留最近 3 个（工作区约定）。

### 5.2 无人值守可跑性

- 全程 `pwsh.exe -NoProfile -File scripts/package.ps1`，无交互弹窗（ISCC 静默、
  Compress-Archive 原生、dotnet/cmake 已有脚本处理 UNC→镜像盘）。
- 代理：Inno 需**本机预装**（不下载），故 package 链**零网络依赖**（除首次 NuGet 还原，
  已在 m-build 里走代理 7897）。
- 幂等：每次先清 `dist-release/`（保留 `release/` 历史）。

### 5.3 验收（C 块，命令级）

```
1  pwsh scripts/package.ps1                          → 退出码 0，末行打印两产物 + sha256 + 体积
2  产物存在性：zip 与 exe 均 >1MB；sha256 可被 Get-FileHash 复核一致
3  内容检查：Expand-Archive 到临时目录 → 断言含 RhineShell.exe/RhineCore.exe/web/index.html/
   LICENSE/THIRD-PARTY-NOTICES.md/VERSION.json，且**不含** .pdb / library.db / config.json
4  干净目录安装冒烟（GOAL-AUTONOMY §4 终态要求）：
   a. 便携：解压到 C:\Users\StarL\rhine-clean\ → 启动 RhineShell.exe --spawn-core
      --core-exe .\core\RhineCore.exe → 窗口出现（CDP 9240 可达）→ 首扫可发起
      → 退出后进程树清空（Get-Process 无残留 msedgewebview2/Rhine*）
   b. 安装：exe 静默安装 /VERYSILENT /DIR=… → 卸载表出现条目 → 启动快捷方式可跑 →
      卸载（/VERYSILENT）后 %LOCALAPPDATA%\RhineMusic 保留（数据不丢）
   c. 缺 runtime 模拟：临时改名注册表键（或 -SkipRuntimeCheck 的自测开关）→ 安装器给出
      明确错误文案且不完成安装（无人值守下断言退出码非 0）
5  三绿复跑（产物内的前端与仓库一致）：npx tsc --noEmit && npm run build && node scripts/check-shell.mjs
6  pwsh scripts/m1-scenario.ps1 → ALL PASS
7  生成物不入库：.gitignore 新增 dist-release/（当前只有 dist/ 与 dist-host/，实测无该条目）
   → git status --porcelain 无 dist-release/ 条目
```

## 6. D：许可终稿

### 6.1 LICENSE（现状已是 MIT）

- 核对：根 `LICENSE` = MIT 标准文本（`Copyright (c) 2026 LBEILC`）；`package.json` `"license": "MIT"`。
  → **无需改写**。本项动作只有两条：
  1. 补一行**资产权利声明**（现有 LICENSE 只覆盖代码；`public/fonts/novecento/` 是独立 MyFonts
     Webfont 许可、`content/archives.json` 内容参考 Arknights wiki、`reference/` 视频为参考不可分发）
     → 新增 `docs/LICENSES.md` 分面说明（代码 / 字体 / 美术资产 / 第三方 vendor / 构建工具），
     LICENSE 正文不动（法律文本不掺水）。
  2. csproj 补 `<PackageLicenseExpression>MIT</PackageLicenseExpression>` 与
     `<Copyright>`（供 §6.2 生成器读取；目前三个 csproj 都没有，实测 grep 无命中）。

### 6.2 `THIRD-PARTY-NOTICES.md` 机器生成（检索对比表）

| 候选 | 许可 | 覆盖范围 | 判定 |
|---|---|---|---|
| **`dotnet-project-licenses`**（NuGet 工具，实为 `tomchavakis/nuget-license`，Apache-2.0，289★，pushed 2026-09-08） | Apache-2.0 | .NET 项目传递依赖图 + 许可证表达式 | ✅ **NuGet 侧选定**（`dotnet tool install -g dotnet-project-licenses` → `-p host/RhineShell -f json`；最新稳定 **2.7.1**，3.x 仅 alpha，锁 2.7.1） |
| `license-report`（npm，MIT，6.8.5，2026-05-28） | MIT | npm 依赖（含 dev 可选、可 `--only=prod`） | ✅ **npm 侧选定**（`npx license-report --only=prod --output=json`） |
| `npm-license-crawler`（BSD-3） | BSD-3 | 同上但**最后发布 2019-03** | ✗ 停更 |
| `about-code-generator` / `NoticeGeneration` / `dotnet-about` | 零散/微软内部 | .NET | ✗ 生态弱/不活跃，不如上两者组合 |
| 自写扫描（读 `node_modules/*/package.json` + `*.nuspec`） | — | 全覆盖 | ⚠ **兜底**：若工具在离线/代理下失败，退化为自写 ~80 行 mjs（读 lock + 抓 LICENSE 文件）。**不作为首选**（铁律） |

**生成脚本** `scripts/third-party-notices.mjs`（~120 行胶水，非算法）：
1. 跑 `dotnet-project-licenses`（JSON）+ `npx license-report --only=prod --output=json`；
2. **合并手工登记的 vendor 段**（无法机器发现）：`miniaudio`（MIT/Unlicense 双许可，
   `host/core/vendor/LICENSES/miniaudio-LICENSE.txt`）、`nlohmann/json`（MIT）、
   **`kissfft`（BSD-3-Clause）** —— 关键坑：`gh api repos/mborgerding/kissfft` 的
   `license.spdx_id` 返回 **NOASSERTION**，**必须**以仓库 `COPYING`（明写
   `SPDX-License-Identifier: BSD-3-Clause`）为准（M5-PLAN-v2 §4.5 债 2 同一事实）→
   生成器对"工具报不出许可"的条目一律标 `UNKNOWN — 需人工核对`并 **fail 构建**，不静默放行；
3. 输出 `THIRD-PARTY-NOTICES.md`：每条含 名称 / 版本 / 许可 SPDX / 用途一句话 / 版权原文（截断到条款头）；
4. 断言：所有条目许可 ∈ {MIT, BSD-2-Clause, BSD-3-Clause, Apache-2.0, Unlicense, 0BSD, ISC,
   zlib, libpng, bzip2-1.0.6, **MS-RL(仅当用户点头 WiX)**, Public-Domain}；
   命中 GPL/AGPL/LGPL/CPOL/UNKNOWN → **构建失败**（Q8 零 GPL 入包的机器化执行）。
   注：NSIS 的 LZMA 模块是 **CPL 1.0**（§2.1-③ 实测），属构建工具不入分发清单，但若用户选 NSIS，
   白名单里要明确"构建期例外"并在 `docs/LICENSES.md` 备案。
5. 密钥红线：生成器只读 `*.csproj`/`package.json`/`LICENSE`，**不读**任何 config/auth 文件。

### 6.3 许可文档三件套（交付包内）

`LICENSE`（MIT，仓库根）+ `THIRD-PARTY-NOTICES.md`（机器生成，禁手改，头部标注生成命令与时间）
+ `docs/LICENSES.md`（人工：字体/美术/构建工具/未分发参考资产四节）。三者都进 §5.1 暂存目录。

## 7. 里程碑拆分与预估

| 子步 | 内容 | 文件 | 预估 |
|---|---|---|---|
| M6a | 设置三层 UI + 配置键对齐 + 信号路径图 | `src/settings/**`、`src/main.ts`（settingsMarkup 拼装）、`src/settings/settings.css` | worker **1 轮** |
| M6b | 诊断页 + `diag.get` 只读启用 + 协议 v1.5 + 日志导出包 | `src/settings/diagnostics.ts`、`host/RhineShell/Hosting/Bridge.cs`、`host/core/src/main.cpp`（只读分支）、`docs/IPC-PROTOCOL.md` | worker **0.5 轮** |
| M6c | 打包链：package.ps1 + installer.iss + 干净目录冒烟 | `scripts/package.ps1`、`scripts/installer.iss`、`README-Windows.md`、`.gitignore` | worker **1 轮** |
| M6d | 许可终稿 + THIRD-PARTY-NOTICES 生成器 + 文档终稿（AGENTS/README/GOAL 销账） | `scripts/third-party-notices.mjs`、`docs/LICENSES.md`、`THIRD-PARTY-NOTICES.md`、`README.md`、`AGENTS.md` | worker **0.5 轮** |
| M6e | 小窗模式（§4） | `host/RhineShell/MiniWindow/**`、`mini.html`、`ShellOptions.cs` | worker **0.5 轮** |
| M6-r | reviewer 审查 + P1 修复（两轮内收敛） | — | **1 轮** |

合计 **~4.5 轮**（M5 全链 ~5 轮；两里程碑相加 ≈ goal 的收尾）。

## 8. 停点清单（遇到即停，报告后等待）

| # | 停点 | 何时 | 交什么 |
|---|---|---|---|
| ~~P-1~~ | ✅ **已批准（09-13）：Inno Setup**；§24 台账已同步 | — | — |
| **P-2** | **updater 渠道**（M6-Q1）：v1 不做（本地自用，GitHub Releases 手动更，留 `update.url` 占位）——需用户确认"确认不做" | M6b 收尾 | 三选项：不做 / GitHub Releases 手动 / 自建静态 JSON 清单（需服务器） |
| **P-3** | **代码签名**：无证书 → SmartScreen"未知发布者"警告 + 部分杀软误报。是否接受？ | M6c | 选项：接受警告（写进 README）/ 购 OV 证书（花钱）/ 自签+用户装信任（仅自用可行） |
| **P-4** | **push 新 origin / 发布 GitHub Release**：任何向远端推送（含新 remote、Release 附件上传）需用户显式点头；本仓库当前 remote 状态与推送策略不在计划内自动决定 | M6d/M6 收尾 | 待推清单（分支、tag、Release 资产） |
| **P-5** | **框架依赖 vs 自包含**（§2.3）：维持框架依赖需用户确认目标机已装 .NET 10 Desktop Runtime；否则体积 ×4 | M6c | 体积与前置对照表 |
| **P-6** | **听感/物理验收销账**（GOAL-AUTONOMY §5.1 + M2-FINDINGS §6.5 清单）：M6 打包前必须销账 | M6c 前 | 移交清单（首次出声质量、seek 听感、pause/resume、SRC 品质、蓝牙/拔插、欠载） |
| **P-7** | 视觉验收：设置三层/路径图/诊断页观感、小窗布局、暗色对比 | M6a/M6e 后 | 截图 + CDP 数据 |
| **P-8** | 任何新需求苗头（TOML 迁移、EQ、播放列表、在线歌词、拼音检索、MSIX） | 全程 | 记 `docs/OPEN-DECISIONS.md` 攒批，不猜 |

## 9. 建议（不属 M6 范围，另列，不实现）

1. **配置迁移 TOML**（§3.2）：键名不变前提下是一次机械替换，等"用户要手编配置"时再做。
2. **CI 出包**（GitHub Actions：Windows runner 跑 package.ps1 + 上传 Release）：
   本机已能无人值守，CI 的增量只是"不占本机"，且要处理 runner 侧代理与 Inno 安装。
3. **三维版信号路径图**（复用 `scene.ts` 双环内构真模型）：观感更好但设置弹窗内嵌三维场景
   代价高（额外 WebGL 上下文 + 超级模式交互），先 2D。
4. **MSIX 变体**（若将来要上 Microsoft Store）。
5. **诊断页历史趋势**（underrun 时间序列图）：需要落库，属新数据面。
6. **ReplayGain / 响度均衡**：列与配置键已在（§15、M5a schema），处理图属 M4/DSP 域。
7. **Linux 壳（M7）**：接口自 M2 起平台无关（§24 Q1-g），打包链届时另立（deb/AppImage）。

## 10. 与 goal_complete 的对接（GOAL-AUTONOMY §6 逐条）

- [ ] M2/M3/M5/M6 均"实施+审查+P1 修复+提交"，证据在各 FINDINGS → M6 需新增 `docs/M6-FINDINGS.md`
- [ ] 真库可浏览/搜索/播放/歌词/任务栏 → M5 验收记录（M5-PLAN-v2 §4.6/§5.8/§6.1/§6.2）
- [x] 本计划已把"zip+exe 双产物冒烟"写成 §5.3 的命令级验收（**待执行**）
- [ ] 停点清单全部移交 → §8 八条 + M5-PLAN-v2 §8 七条，合并移交
- [ ] git 工作区干净、无未提交改动 → 每子步中文提交（feat/fix/chore/docs/test 前缀）

---
*本文件仅为计划，未做任何实现/构建/提交。所有检索事实（版本、许可原文、行号、实测结果）
于 2026-09-13 本机核实：GitHub 侧经 `gh api`（代理 7897）、NuGet/npm 侧经注册源、
SQLite 行为经 `sqlite3 3.46.1` 实测（证据见 `docs/M5-PLAN-v2.md` §7.1）。*
