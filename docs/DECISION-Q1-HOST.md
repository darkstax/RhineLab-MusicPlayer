# Q1 宿主路线：属性优劣拆解（决策支撑文档）

> 状态：待用户拍板 · 2026-09-12
> 配套：`AUDIO-ENGINE.md` §2（三方案概要）。本文把各方案**按属性逐条拆开**，每条含事实与代价。
> 已并入本机实测证据（§6）：曲库实况、音频设备独占能力矩阵、NAudio 解码保真验证。

---

## 0. 评判权重（按本项目实际诉求排序）

| 序 | 属性 | 权重 | 依据 |
|---|---|---|---|
| P0 | 独占位完美的**实现确定性** | 35% | 用户核心诉求（无损 + 独享模式） |
| P0 | 与本机既有资产协同 | 20% | sysmon-cmdpal / Taskbar-Lyrics / btop4win / go-musicfox |
| P1 | 工程量（含手搓系统 API 的量） | 18% | 单人 + AI 协作开发 |
| P1 | 运行时可靠性（音频线程不被 GC/调度打断） | 12% | 独占小缓冲对抖动敏感 |
| P2 | 分发体积 / 更新体验 | 8% | 桌面应用日常体感 |
| P2 | 跨平台余量 | 5% | 目标锁定 Windows（曲库全在 NTFS） |
| P2 | 长期可维护 / 生态活跃 | 2% | — |

**注意**：权重是主进程建议，可调。若把"跨平台"提到 P1，结论会从 B 明显偏向 A。

---

## 1. 属性矩阵（逐项打分，★=该属性最优）

| 属性 | **A. Tauri v2 + Rust** | **B. .NET 10 + WebView2 + NAudio** | **C. Go + webview2** |
|---|---|---|---|
| 1.1 独占流实现 | ◐ `wasapi` crate（社区维护，事件式 OK，但 i24 容器/重开流逻辑需自查补丁） | ★ NAudio `WasapiOut(Exclusive, true, latency)` 现成，`Init(provider)` 直喂任意 `IWaveProvider` | ✗ 需手写 COM 绑定（golang.org/x/sys + ole），无成熟播放器先例 |
| 1.2 格式协商 / IsFormatSupported | ◐ windows-rs 手搓 | ★ `AudioClient.IsFormatSupported(Exclusive, wf, out closest)` 已在本机实测跑通（见 §6.2） | ✗ 手搓 |
| 1.3 24bit 整型直通能力 | ◐ symphonia 原生 i16/i24 → 需自证容器宽度对齐 | ★ **实测：`MediaFoundationReader` 输出 `24 bit PCM 48kHz` 整型**（§6.3）；Win 原生解码器覆盖 AAC/ALAC/MP3 | ✗ musicfox 的 beep 路径固定 44.1k float32（反例，见 §5 of AUDIO-ENGINE） |
| 1.4 设备热插拔监听 | ◐ windows-rs `IMMNotificationClient` | ★ NAudio `MMDeviceEnumerator` + `DeviceState` 事件封装可用 | △ winrt-go |
| 1.5 SMTC 媒体卡 | △ windows-rs 手写 WinRT | ★ WinRT C# 投影原生（sysmon-cmdpal 同款技能） | △ winrt-go 有 Audio 命名空间先例 |
| 1.6 每应用音量 / duck 诊断 | △ 手搓 | ★ `AudioSessionManager` 现成 | ✗ |
| 1.7 频谱/gapless 算法复用 | △ 按 musicfox 逻辑重写 Rust | △ 重写 C#（但有 NAudio.Dsp.Fft 现成） | ★ **`spectrum.go`/`beep_gapless.go` 近乎直拷** |
| 1.8 曲库元数据 | △ `lofty`/`id3` crate | ★ TagLib# / `MetadataExtractor` | ★ `music-metadata` 同源（musicfox 用） |
| 1.9 WebView 嵌入 | ★ WebView2 via tauri-plugin，成熟 | ★ `Microsoft.Web.WebView2` NuGet（本机已有 SDK 包缓存，§6.4） | △ `13thgoutham/go-webview2`（musicfox vendor 里那个，维护一般） |
| 2.0 与用户既有代码同构 | ✗（无 Rust 资产） | ★★ 与 sysmon-cmdpal（.NET 10）、btop4win、Taskbar-Lyrics(C++) 同一调试/构建生态 | △ Go 资产仅 musicfox |
| 2.1 内存占用 | ★ ~150–220MB | △ ~200–320MB（含 .NET 堆） | △ ~180MB |
| 2.2 安装包体积 | ★ NSIS ~8–12MB | ◐ 自包含 ~65–90MB / 框架依赖 ~5MB（需装 runtime） | ★ ~25–35MB |
| 2.3 音频线程实时性 | ★ 无 GC，`set_thread_priority` + 锁页 | △ **GC 抖动风险**（缓解：`ServerGC=false`、`GCSettings.LatencyMode=LowLatency/SustainedLowLatency`、输出线程 0 分配、`ThreadPriority.AboveNormal`） | △ Go GC（亚 ms 级 STW 已很好，但仍有） |
| 2.4 启动速度 | ★ 快 | ◐ 冷启 ~400–900ms（ReadyToRun 可缓解） | ◐ 快，Go |
| 2.5 崩溃隔离 | ★ | ◐（托管异常可 catch，但 UI 线程与音频线程同进程需小心） | ◐ |
| 2.6 上游 TS 皮肤迁移量 | ★ 零改动 | ★ 零改动 | ★ 零改动 |
| 2.7 学习/维护成本（本项目作者视角） | ✗ 需 Rust 熟练度 | ★ 已在 sysmon-cmdpal 上证明熟练 | ◐ 已会 Go，但独占要碰的 WinRT 面不熟 |
| 2.8 AI 协作友好度（本会话生成代码质量） | ◐ Rust 借用检查会拉长迭代 | ★ C# 一次通过率高（实测：本会话探测程序 C# 编译即跑） | ◐ |
| 2.9 跨平台（mac/Linux） | ★★ | ✗ 仅 Windows | ◐ |
| 3.0 生态活跃度 2026 | ★ Tauri 活跃 | ★ .NET 10 长期支持 + WebView2 随 Edge 更新 | △ 小众 |
| 3.1 许可证传染 | ★ 依赖均 MIT/Apache/ISC | ★ 同 | ◐ |

**加权小结（按 §0 权重）**：B ≈ 0.86 · A ≈ 0.68 · C ≈ 0.55
（粗算，仅示意量级；把跨平台提到 P1 时 A 会反超到 ~0.82 vs B ~0.75。）

---

## 2. A. Tauri v2 + Rust —— 优劣细目

**优点**
1. 体积/内存最优，启动最快，日常体验最"轻"。
2. 无 GC → 独占模式 5ms 缓冲下爆音风险天然最低（对发烧诉求最硬核）。
3. `wasapi` / `coreaudio-rs` / `windows` crate 是 Rust 音频生态的事实标准，HifiFi 类开源项目多选用。
4. 跨平台一份代码覆盖 mac/Linux（若日后想上 mac 或做 Linux 版，A 是唯一低成本路径）。
5. 崩溃不会拖垮宿主（可拆 sidecar 进程）。

**代价**
1. **所有 Windows 集成能力都要手搓**：设备监听、SMTC、每应用音量、文件关联、托盘、单实例、updater 之外的部分——SMTC 与 CoreAudio 通知在 Rust 侧代码量显著（估 3–5k 行）。
2. 无现成"24bit PCM 直通"验证路径：需自行确认 `wasapi` crate 对 `i24-in-i32` 容器与 `WAVE_FORMAT_EXTENSIBLE` 的处理，可能读源码/打补丁（本会话已证明 C# 侧一步实测通过）。
3. 迭代速度：借用检查 + trait bound 让 AI 生成代码的往返次数上升，本项目大量"探测→验证"式工作会明显变慢。
4. 与用户既有仓库（全 C#/C++/Go）**零代码复用**，调试工具链要另配（cargo、rust-analyzer、Windows SDK 版本锁定）。
5. 团队/自己 Rust 熟练度未知——若不高，P0 风险直接放大。

**适合**：追求最小体积 + 未来要跨平台 + 愿意为音频硬核度付出手搓 API 的时间。

---

## 3. B. .NET 10 + WebView2 + NAudio —— 优劣细目

**优点**
1. **P0 确定性最高**：独占 + 协商 + 设备监听 + SMTC + 会话音量全部有现成库，本会话已用 NAudio 3.1.0 实机跑通能力探测（§6.2），API 形状与文档一致（`WasapiOut(shareMode, isEventDriven, latency)` + `Init(IWaveProvider)` + `GetPosition()`）。
2. 与 sysmon-cmdpal / btop4win / Taskbar-Lyrics **同栈同工具链**（pwsh 互操作、MSBuild、WinRT 投影、C#↔C++ 互操作经验），你已有的调试肌肉记忆全部有效。
3. 元数据（TagLib#）、重采样（`WdlResampler` 实测在 NAudio.Core 里，§6.3）、FFT（`NAudio.Dsp.Fft`）、音量/淡变（`VolumeProvider`/`FadeInFadeOutStream`）都在同一依赖树，**不用拼多来源库**。
4. Windows 原生 `MediaFoundationReader` 提供 `24 bit PCM` 整型输出（实测 §6.3）→ Win 自带的 FLAC/ALAC/AAC/MP3 解码器覆盖面，且能显式拿整型格式，**这是 A/C 都要自己论证的能力**。
5. AI 协作效率高：本会话 C# 探测程序一次编译即运行。

**代价 / 必须正视的风险**
1. **GC 与独占的冲突是唯一真问题**（P1）。缓解方案明确但有纪律要求：
   - 音频线程**零托管分配**：预分配环形缓冲（`ArrayPool`/`stackalloc`/固定 byte[]），把解码放到后台线程池喂无锁队列；
   - `GCSettings.LatencyMode = SustainedLowLatency`（播放中），`ThreadPriority.AboveNormal`；
   - 关闭 Server GC（`<ServerGarbageCollection>false</ServerGarbageCollection>`）；
   - 极端要求可上 `NativeAOT`（同时解决体积，但会砍掉部分反射依赖，需验证 WebView2 SDK 兼容性）。
   - **验收方式**：§19 T11 长跑 + underrun 计数器必须为 0，用真机数据决定档位；不达标则把输出后端换成 Rust/C++ 音频侧车（B' 混合方案，见 §5）。
2. 自包含分发体积 ~70MB（框架依赖装 runtime ~5MB，但需用户预装 .NET 10 Desktop Runtime）。
3. 仅 Windows（对锁定 Windows 的曲库不是问题，只是失去跨平台期权）。
4. WebView2 + WinForms/WPF/WinUI 的宿主选择要定（建议 **WPF** 或 **WinForms + WebView2 控件**，最轻；WinUI3 会引入 WindowsAppSDK 依赖复杂度）。
5. NAudio 是社区库（Mark Heath），独占路径在部分声卡上有历史 issue 记录（如某些 Realtek 驱动的 int24 处理）——但 **A 同样要面对现实声卡的坑，且 B 有实测手段**（§6.2 脚本已入 `tools/win-audio-probe/`，可对任意新设备 5 分钟重测）。

**适合**：Windows-only、要最快做到 P0、且既有资产全在 .NET/C++ 生态——即本项目的实际情形。

---

## 4. C. Go + webview2 —— 优劣细目

**优点**
1. **唯一能近乎直接拷贝 musicfox 代码**的方案：`spectrum.go`（1024 FFT/Hann/64带/L-R phases/弹簧阻尼）、`beep_gapless.go`（边界切流/de-click/iTunSMPB/保守 padding 估计）及其 **7 个单测** 全部可复用，连 `internal/lyric/`（lrc/yrc/对齐/管道 writer）也能直接搬。
2. 部署为单二进制，无 GC 停顿显著问题，体积 ~30MB。
3. 与 musicfox 生态**天然兼容**：同一 `lyric` 包、同一任务栏管道协议、甚至可考虑抽公共模块为共享 Go module。
4. 启动快、交叉编译容易。

**代价（致命项）**
1. **独占模式要手写 COM**：`IAudioClient`/`IAudioRenderClient`/`WAVEFORMATEXTENSIBLE` 在 Go 无成熟播放级封装；winrt-go 覆盖的是 WinRT（MediaPlayback 一类），**不是 CoreAudio 的 WASAPI 原生接口**。这条路等于"从零写一个 WASAPI 绑定 + 事件驱动渲染循环"，是全案最难的地基。
2. musicfox 自己的 beep 引擎固定 `44100Hz + 200ms 缓冲 + float32`（`beep_player.go`），**它走的正是共享软解路径**——经验可借，但它没有解决你要的独占；mpv 引擎才有 `--audio-exclusive=yes`，也就滑向"嵌 mpv"（= A/B 讨论中的 mpv 跳板方案，非纯 Go）。
3. webview2 Go 库（vendor 里 13thgoutham 那个）维护度一般，postMessage 双向吞吐/大 payload 需自测。
4. 元数据、重采样、音量策略在 Go 侧要凑库，工程胶水反而比 C# 多。

**适合**：若 Q1 目标改成"和 musicfox 共享大量代码 + 用 mpv 出独占"，C 才有优势；**以自研音频核心为目标时 C 排最后**。

---

## 5. B' 混合方案（值得单独列出的第三选择）

> 若你既想要 B 的系统集成效率，又对 GC 打进独占有洁癖式担忧：
> **C# 做宿主（WebView2/曲库/设置/SMTC/UI/IPC），单独把"独占渲染线程"写成一个小的 C++/Rust DLL（或直接用 NAudio + 零分配纪律），进程内 P/Invoke。**

- 成本：一个 ~800 行的 C++ `EXCL_HOST`（`IAudioClient` 独占 + 事件循环 + C ABI `rhine_excl_open/write/poll/close`），你已有 Taskbar-Lyrics/btop4win 的 C++ 工程经验，比整案转 Rust 便宜得多。
- 收益：99% 代码享受 C# 生态，1% 实时线程零 GC。
- 这是 foobar2000 / MusicBee 一类 Windows 播放器的实际形态（C++ 核心 + 托管/原生 UI 分层）。
- **建议把它当作 B 的"逃生通道"而非起点**：先用纯 B 跑 T11 长跑，underrun>0 才下沉渲染线程。

---

## 6. 本机实测证据（本次会话产出）

### 6.1 曲库实况（`C:\Users\StarL\Music`，Q5 答复）
- **总量**：1116 个音频文件 / **44 GB**，21 个顶层目录（多层嵌套，如 `YOASOBI/THE BOOK/`）。
- **格式**：FLAC **964**（86%）、MP3 **152**（14%）、DSF **2**（`_DSD原盘/`，千与千寻/龙猫）、
  另有 1 个 `.rar` 压缩包（Hi-Res yuanfen 96k/24bit，未解出）。
- **FLAC 采样率/位深分布**（随机 60 样本）：`48k/24bit ≈ 60%`、`44.1k/16bit ≈ 27%`、`192k/24bit ≈ 10%`、零星 96k/24、44.1k/24。
- **MP3**：48kHz（23/30 样本）与 44.1kHz 混合，**未见 LAME/iTunes gapless 元数据**（8 个样本全空）→ 无缝裁剪主要靠 FLAC/MD5 侧。
- **歌词**：**约 26% 的 FLAC 有内嵌 `LYRICS` 标签**（100 样本，LRC 格式，含 `[by:]` 与中日双语行）；
  全库 **0 个 `.lrc`/`.yrc` sidecar**、**0 个 `.cue`**。
  → 歌词优先级须是 **内嵌 > 在线/外部匹配**，不能假设 sidecar 存在（影响 §12 设计，见 §7）。
- **专辑组织**：目录名即专辑（含 Hi-Res 标注、日文/中文混排、`;` 分隔多艺人），文件名含全角括号与空格
  → 路径处理必须 UTF-8 安全、注意 Windows 保留字符与长路径（`\\?\` 前缀）。
- **关键推论**：库以 **Hi-Res FLAC 24bit 为主**（非普通 16/44.1），独占位完美 **有真实价值**（不是自我安慰）；
  16bit 部分在共享路径下也基本无损（可整型对齐），float 路径只损失极小尾数——但 24bit 部分被 SRC+float 拉一次就实打实丢动态。

### 6.2 音频设备与独占能力矩阵（`tools/win-audio-probe/`，Q9 答复）
| 设备 | 角色 | MixFormat | minPeriod | 独占支持（实测） |
|---|---|---|---|---|
| **耳机 (CX31993 MAX97220PRO AUDIO)** USB DAC，VID_0BDA:PID_0023 | **当前默认** | float32 **384kHz** 2ch | 3.00ms | **16/24bit @ 44.1/48/88.2/96/176.4/192/352.8/384 kHz 全通过** |
| 扬声器 (Realtek(R) Audio) ALC256 | 非默认 | float32 48kHz | 3.00ms | 16/24bit @ 44.1–192kHz 通过（352.8/384 未列=不支持） |
| Steam Streaming Speakers | 虚拟 | float32 48kHz | 3.00ms | 16bit @ 44.1–192kHz（**无 24bit**）|
| NVIDIA HDA / AMD HDA / NVIDIA Virtual Audio | 非活跃/未枚举 | — | — | 未测（ inactive 时不枚举） |

**推论与决定项**
1. ✅ **独占完全可行，且你的 USB DAC 支持到 384kHz**——正好覆盖曲库最高规格（192kHz/24bit，留足余量）。
2. ✅ 两台主力设备都支持 **24bit 整型独占** → `BIT-PERFECT ✓` 徽章有硬件基础。
3. ⚠️ **float32 独占一律不支持**（实测 `EXCL float32@192k: False`）→ 印证 §5 处理图必须走整型容器（i16/i24-in-i32），
   解码器输出 float 时**必须**显式转整型（并如实降级徽章），不能指望设备吃 float。
4. ⚠️ 虚拟设备（Steam/NVIDIA Virtual）**无 24bit** → 若被选为默认会破坏位完美；设置页设备下拉须显示每设备能力矩阵（§7.4 设计已覆盖），并在选到无 24bit 设备时**主动告知**徽章变橙原因。
5. ℹ️ `minPeriod=3ms`（两台都是）→ 缓冲预设 `5/10/25ms` 合理，最低档可到 3–5ms；`SupportsAudioClient3=True`（可考虑 AUDIOCLIENT3 定时策略，v1 不用）。
6. ℹ️ `InstanceId` 在 NAudio 3.1.0 返回 `Unknown`（探测脚本小瑕疵，正式实现应从 `MMDevice.ID`/`PropertyStore` 取 `DEVPKEY_Device_InstanceId`）——记入待办，不影响结论。
7. ℹ️ 蓝牙耳机（A2DP）当前未连接，**独占对蓝牙通常不可用**，§7.2 降级链必须在蓝牙场景实测（Q9 补测）。

### 6.3 NAudio 解码保真验证（决定 B 路线成立性的关键实测）
| 输入 | `MediaFoundationReader` 输出 | `AudioFileReader` 输出 |
|---|---|---|
| 月色真美 OST（FLAC 48k/24bit） | **`24 bit PCM: 48000Hz 2ch`** ✅ 整型保真 | `32 bit IEEEFloat 48kHz`（丢整型性） |
| Goose house 光るなら（FLAC 44.1k/16bit） | **`16 bit PCM: 44100Hz 2ch`** ✅ | `32 bit IEEEFloat 44.1kHz` |

- **结论**：B 路线 **能** 做到 24bit 整型直通 → 独占位完美；但必须**绕开 `AudioFileReader`**，
  直接用 `MediaFoundationReader` 并确认返回格式为 PCM 整型（若返回 float 需显式要求 `MFAudioAttributes` 或自建解码）。
- **副作用**：`AudioFileReader` 内部会把 24bit FLAC **解码为 float32**——这是上游默认路径的位完美陷阱，写进实现红线。
- 附带发现：NAudio.Core 内含 **`WdlResampler`**（可用作可选 SRC 节点，高质量）与 `NAudio.Dsp.Fft`（频谱器不必手搓 radix-2）。

### 6.4 宿主环境
- WebView2 Runtime：**152.0.4191.66 已安装**（Edge 常青分支随系统更新）→ 上一轮遗留问题解除，**无需在安装包里带 runtime**。
- .NET SDK：**10.0.400**；NuGet 缓存已含 `Microsoft.Web.WebView2`、`Microsoft.WindowsAppSDK`、`Microsoft.Windows.SDK.NET.Ref` → 上一轮克隆时既有依赖，B 路线零额外环境成本。
- Windows：26100 基础（`Microsoft Streaming Service Proxy 10.0.26100.6`）→ Win11 24H2 系。
- 代理 7897 可用（NuGet 拉包实测通过）。

---

## 7. 实测数据反过来修订 AUDIO-ENGINE 的三处设计

1. **§12 歌词来源优先级重排**：曲库无 sidecar、26% 内嵌 → 主路径改为
   `内嵌 LYRICS 标签 → 外部歌词目录（可选，默认关）→ 在线匹配（若 Q2 未来解禁）`；
   并新增需求：**歌词首行 `[by:鲜果微笑]` 之类的站点水印要能过滤**（实测存在）。
   双语行（原文+中文同处一行，如 `雨上がりの虹も 雨过天晴的彩虹`）需要**行内拆句**能力——
   musicfox 的 `AlignTranslationToYRC` 是跨文件对齐，本库更常需要"单行内按空格/字符脚本切换拆两栏"，属新算法。
2. **§5 处理图加一条硬约束**：`解码器输出 float 且目标独占` → 必须整型量化（非 dither 直通），
   并在徽章标注"解码器 float 化"（MP3 天然如此）→ 与 §6.3 实测一致，写进 `FidelityAssessor` 规则表。
3. **§7.4 设备下拉必显能力矩阵**：因存在"虚拟设备无 24bit""蓝牙无独占"两类真实陷阱（§6.2 推论 4/7），
   设备项必须显示 `独占:24bit≤192k` / `共享` / `无独占` 三态标签——不再是 nice-to-have，而是防误配。

---

## 8. 需要你确认的问题（Q1 专用）

- **Q1-a 跨平台期权**：未来 12 个月内有没有 mac/Linux 版需求？
  （有 → A；无 → B，这是唯一能翻盘的属性）
- **Q1-b Rust 熟练度**：你/愿意让 AI 主力写 Rust 吗？B 路线的"AI 一次通过率高"是实测过的（本会话）。
- **Q1-c GC 容忍度**：如果纯 C# 方案在 T11 长跑中出现 underrun（概率低但非零），
  你接受 (i) 放宽独占缓冲到 25ms、(ii) 下沉 C++ 渲染线程（§5 B'）、还是 (iii) 直接改投 A？
- **Q1-d 体积偏好**：自包含 ~70MB vs 框架依赖 5MB+要求装 .NET 10 Desktop Runtime——你自己机器已装 SDK 无所谓，但发布给别人时选哪个？
- **Q1-e 宿主 UI 框架**（若定 B）：WPF + WebView2（成熟、我推荐）/ WinForms + WebView2（最轻）/ WinUI3（最现代但 WindowsAppSDK 依赖链最重）。

---

## 9. 主进程推荐（供参考，你拍板）

**B（.NET 10 + WebView2 + WPF）+ §5 的 B' 逃生通道 + C 的算法参照。**

理由：P0 两项（独占确定性、既有资产协同）B 直接胜出且已被本会话实测背书
（NAudio 能力探测跑通、24bit PCM 整型解码拿到、WebView2/DotNet SDK/依赖缓存全在位）；
而 C 的最大卖点（musicfox 代码复用）在**最难的那块（独占）恰好无用**，可只借其**算法与测试用例**（不移植代码）；
A 唯一压倒性优势（跨平台 + 无 GC）在本项目实际约束下权重最低（曲库 44GB 躺在 NTFS 上）。
