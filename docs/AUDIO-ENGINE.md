# 音频引擎与播放设置设计（AUDIO-ENGINE）

> 状态：v0.3 · 2026-09-12（**Q1 全案定稿 D2、Windows 先行**；决策全部闭环，进入实施）
> 范围：RhineLab-MusicPlayer 本机应用化的音频核心、播放设置与系统集成。
> 借鉴：go-musicfox（无缝/频谱/任务栏歌词协议/配置系统）、btop4win / Taskbar-Lyrics（Windows 原生经验）。
> 上游视觉与交互皮肤来自 RhineLabUI（MIT）；本文档只覆盖其不具备的"后端/系统"层。

---

## 0. 设计公理（为什么必须这样做）

1. **WebView 音频栈没有无损输出。** 一切经 `<audio>`/Web Audio 的声音必进 Windows AudioEngine：
   重采样到设备混音格式（常见 48kHz float32）、24bit 拉成 32 float、与其他应用混音。
   想要 bit-perfect 与 WASAPI 独占，音频核心必须在原生层直接持有设备句柄。
2. **UI 与声音分家。** 皮肤、歌词、频谱动画留在 WebView；解码→处理→输出全部下沉原生进程。
   两者之间只走**低频控制与状态 IPC**，音频样本流永不过 IPC 边界。
3. **交互音效与音乐天生冲突于独占模式。** 设备被独占后 Web Audio 发不出声。
   设计决策：UI 音效走独立总线，独占模式下自动静音并在界面明示（发烧场景本就不需要点击声）。
4. **信任边界。** 本应用唯一的输入源是：用户选择的本地文件、本地命名管道（Taskbar-Lyrics）、
   自家原生层发来的 IPC。均为信任域内数据；解析器做"健壮"（不崩溃）即可，不做注入防御。
5. **证据先于断言。** 每个"位完美/无缝/低延迟"声明都必须有可观测的诊断计数器支撑（§14），
   未验证的硬件行为不写进默认配置。

---

## 1. 总体架构

```
┌─ 原生进程（单进程，音频实时性优先）────────────────────────┐
│                                                            │
│  ┌ 应用核心 ┐     ┌ 音频引擎（见 §3-§8）───────────────┐   │
│  │ 状态机   │────▶│ 解码 → 处理图 → 输出后端            │   │
│  │ 曲库DB   │     │           │(tap)                   │   │
│  │ 歌词服务 │     │           ▼                        │   │
│  │ SMTC/媒体键    │        频谱分析器(64带 L/R)        │   │
│  │ 设备监听 │     └───────────┬────────────────────────┘   │
│  │ 任务栏管道 writer          │                            │
│  └────┬───────────────────────┼────────────────────────────┘
│       │ IPC(invoke/event)     │ WASAPI shared / exclusive / [ASIO]
│       │ 本地命名管道          ▼
├───────┼───────────────────  Windows 音频栈 ─────────────────┤
│  ┌────▼──────────────── WebView 窗口 ────────────────────┐  │
│  │ 皮肤/主题/开机动画（复用上游 boot/appearance/theme）    │  │
│  │ 播放 UI + 歌词渲染(lrc/yrc 前端移植)                   │  │
│  │ 频谱律动(订阅事件,替代假 bands)                        │  │
│  │ Web 兜底引擎(仅降级/预览模式使用,§8.3)                 │  │
│  │ 交互音效总线(独占时自动静音)                           │  │
│  └────────────────────────────────────────────────────────┘  │
│  ┌ Taskbar-Lyrics 插件(外部进程,协议兼容复用,§11) ┐          │
└──┴────────────────────────────────────────────────────────────┘
```

**关键不变式**

- 音频样本：原生层内部流动，永不跨 IPC；WebView 只收到达 §10 定义频率的控制/统计事件。
- 单一事实源：播放器状态机在原生层；WebView 是纯视图（重开/刷新不改状态）。
- 歌词文件读取经原生（路径沙盒=曲库根），解析在 WebView 前端。

---

## 2. 宿主技术路线（待拍板 → 决策点 Q1；31 项属性拆解见 `DECISION-Q1-HOST.md`）

音频核心语言三方案对比（以"独占位完美"为最高优先级评判）：

| | A. Tauri v2 + Rust | B. .NET 10 + WebView2 | C. Go + webview |
|---|---|---|---|
| WASAPI 独占 | `wasapi` crate（成熟，事件式+int24 需小补丁） | **NAudio `WasapiOut(goodForBitPerfect)` 现成** | 自己绑 COM，成本最高 ✗ |
| 设备枚举/监听 | windows-rs 手写 | NAudio MMDevice / CSCore 现成 | winrt-go 可用 |
| SMTC | windows-rs 手写 | WinRT 投影现成（sysmon-cmdpal 同栈经验） | winrt-go 有先例 |
| 每应用音量/duck | 手写 CoreAudio | NAudio/CSCore 现成 | ✗ |
| 解码 | symphonia（纯 Rust，FLAC/WAV/AIFF/MP3/AAC/OGG） | NAudio 全家桶 + TagLib# 元数据 | musicfox 现成依赖 |
| 频谱/gapless 逻辑 | 按 musicfox 算法重写 | 重写 | **`spectrum.go`/`beep_gapless.go` 近乎直接拷贝** |
| 前端嵌入 | WebView2，成熟 | WebView2（Edge 内核），成熟 | webview 库，一般 |
| 产物体积 | ~10MB | 自包含 ~70MB | ~30MB |
| 与本地资产协同 | 中 | **高**：sysmon-cmdpal(broker 经验)、Taskbar-Lyrics(C++)、btop4win 同生态 | 高（musicfox 本体） |
| 跨平台余量 | Win/mac/Linux | 仅 Windows（本项目实际目标） | Win/mac/Linux |

**已定案：D2 = 共享 C++ 音频核心（miniaudio）+ 各平台异构薄壳**（详见 `DECISION-Q1-HOST.md` §7.5-§7.6/§9）。

裁定过程：第一轮倾向 B（.NET 独占最省力）→ 第二轮用户答 Q1-a **Linux 需求真实** 且 Q1-b **Rust 出局**
（AI 全保不可接受），且 Wine 跑 WebView2 经查证**不可维护**（installer 装不上、winetricks 至今无 verb）
→ B 的 Windows-only 短板被激活，A 被否决 ⇒ 核心必须跨平台、壳允许异构：

| 层 | 选型 | 理由 |
|---|---|---|
| **音频核心** | **C++ + miniaudio**（单文件 C，public domain，~6k 行核心 surface） | WASAPI **独占后端官方支持**；ALSA 后端可直设 `S32_LE`/rate/period（Linux 位完美的实测正确姿势）；内建 `ma_decoder`（dr_flac **整数解码**、dr_mp3、dr_wav）→ 解码不再平台特定；`i24-in-i32` 与 Linux `S32_LE` **两平台位完美语义天然统一** |
| **Windows 壳** | **.NET 10 + WPF + WebView2**（框架依赖分发，Q1-d） | 用户可读/可审（Q1-b 精神）；WebView2 152 已装；NAudio **降级为设备枚举 + 每应用音量/会话诊断工具**（不再承载独占）；SMTC/托盘/安装器全在托管侧 |
| **Linux 壳**（v2） | C++ GTK4+WebKitGTK，或 Go 薄壳 | musicfox `internal/webkitgtk`（purego dlopen、4.1/6.0 双栈降级）已趟过同一条路，可参照；MPRIS/dbus 接管媒体键 |
| 前端 TS | 三平台零改动（Vite 产物直嵌） | — |
| IPC | 命名管道(Windows) / Unix socket，JSON Lines | 沿用 musicfox 任务栏管道同源模式 |

**underrun 对策（Q1-c 定案）**：主路径 = **缓冲自动升档**（设备最小值 → … → 25 → **300ms 封顶**，
可配置上限并允许用户锁定）；渲染线程本就是 C++（D2 下该风险自动消除）。
**风险登记**：C++ 核心由 AI 全保（用户可读不可写）——以 Taskbar-Lyrics 已验证模式对冲：
极小 C ABI 边界 + musicfox T1-T7 单测直译为对拍基准。miniaudio 的 s24-packed vs i24-in-i32 需 M2 实测确认
（不行则核心内自填 4 字节容器，数十行量级）。

---

## 3. 引擎抽象（移植 musicfox 的接口分层）

借鉴 `player.Player`（17 方法）+ `GaplessPlayer`（可选能力）模式，核心 trait/接口：

```
interface AudioEngine:
    open(device, format_policy) -> NegotiatedFormat
    play(track, start_pos) -> StreamToken
    preload(next_track)              # 仅支持无缝的后端实现
    seek(position)
    pause() / resume() / stop()
    position() -> (samples, rate)    # 设备时钟换算，样本精度
    set_volume(VolumePolicy)
    state() -> {Playing|Paused|Stopped|Buffering|Error}
    subscribe(event_kind) -> Stream  # position/state/spectrum/transition/diag
    close()

optional capability interfaces:
    Gapless:   preload/cancel_preload/transition_channel     (musicfox 同名)
    Formats:   probe(uri) -> {rate, depth, channels, codec}  (选流前探格式)
    Session:   ducking / per-app-volume 查询                 (共享路径诊断用)
```

引擎注册表按配置选择，失败显式报错并提示缺什么（musicfox `NewPlayerFromConfig` 的 panic 文案策略→改为 UI 错误页）。

---

## 4. 解码层

- **容器/编解码**（按曲库实况定案，Q5 实测：FLAC 964 / MP3 152 / DSF 2 / 其他≈0）：
  **v1 只需 FLAC + MP3 + WAV**；AAC/ALAC/OGG 留接口按需加。**DSD 出局**（Q3 定案，仅 2 个 DSF，
  留 `formats.dsd=off` 占位，库存成规模再启动 DoP 专项）。MP3 含 LAME/iTunes 间隙元数据解析
  （实测本库 MP3 无 gapless 标签 → 主走保守估计路径，见 §8）。
- **解码器（D2 定案）**：`ma_decoder`（dr_flac / dr_mp3 / dr_wav）在核心层统一跨平台。
  FLAC **解码全程整数运算** → i16/i24 原生整型直通（24bit→i32 容器）；MP3 本质只能 float →
  该路径永不位完美，徽章如实显示（§13）。
- **统一中间格式**：`{interleaved, i16 | i24-in-i32 | f32, rate, channels}`；解码能力如实上报。
  **实现红线**（历史教训，仍有效）：任何"便利入口"都可能偷偷把 24bit 拉成 float32——
  实测 NAudio `AudioFileReader` 即如此（§23）；选定解码路径后必须**断言输出容器为整型**，
  不得依赖默认行为。
- **元数据**：TagLib 级（标题/艺术家/专辑/年份/曲目号/封面/歌词字段/ReplayGain/LAME 头/iTunSMPB/
  cue 索引表）。专辑级封面缓存到应用数据目录（哈希寻址）。
- **cue sheet**：解析后视为虚拟分轨（源文件 + 起止样本 + INDEX 修正），与整轨镜像同库异视图。
- 解码运行在专用线程池，输出定长样本块（帧数对齐设备 period），队列深度=预加载窗口。

## 5. 处理图（pipeline）

固定节点顺序，每个节点可旁路；**任何激活的非直通节点都会改变位完美徽章**：

```
[解码 i16/i24/f32]
  → Trim(gapless 裁剪: delay/padding)     # 直通=1
  → Resampler(soxr/内置; off|auto|force)  # 旁路=1
  → Gain(ReplayGain track/album)          # 旁路=1
  → Volume(§6 策略)                        # fixed100%+整型=1
  → [EQ/DSP 预留, v1 不实现]
  → Dither(可选, 仅降位深时)
  → Tap(频谱分接, 数学只读, 不影响输出)     # 恒 1
  → [输出后端]
```

## 6. 音量策略（bit-perfect 冲突的正解）

| 策略 | 行为 | 位完美 | 适用 |
|---|---|---|---|
| `fixed`（默认，独占） | 恒定 100%，UI 音量条隐藏或标注无效 | ✅ | 外接 DAC+前级 |
| `hardware` | CoreAudio 端点音量（独占时自动退化隐藏） | ✅（模拟域） | 共享路径 |
| `integer` | 定点整数因子衰减 | 动态范围折损 | 需要调音的独占 |
| `float` | 浮点软件增益 | ❌ | 共享/日常 |

切换策略即时生效（musicfox 音量处理器包流层的做法），UI 徽章同步变色。

---

## 7. 输出后端与模式协商状态机

### 7.1 后端

- `wasapi-shared-event`：默认日常。设备混音格式，事件驱动回调。
- `wasapi-exclusive`：**发烧主路径**。AUDCLNT_SHAREMODE_EXCLUSIVE，事件式，
  协商原生格式（rate/bit-exact 容器宽度，支持 i16/i24(i32 容器)/f32 按设备能力）。
- `[asio]`：v1 仅配置占位（§16 Q3）。
- `[wasapi-push / apollo]`：保留枚举值，不实现。
- `alsa-direct`（Linux 壳，v2）：`S32_LE` + 显式 rate/period_size，绕过 PipeWire 混音器；
  **Linux 位完美真相说明**（实测资料）：PipeWire 通用路径会把容器拉到 32bit 并做协商，
  需 `default.clock.allowed-rates` 或 Pro Audio profile 才不断流——核心按能力探测处理，徽章语义与 Win 一致
  （i24 装在 i32 容器里不算污染）。
- `[dlna/mpd]`：Q6 定案——**v1 不实现，仅保留枚举值与配置占位**（"留个口子"），不排期不测试。
- **缓冲与格式实测约束**（§23）：全设备 **float32 独占不支持** → 独占必走整型容器（i16/i24-in-i32）；
  主力设备 minPeriod=3ms → 5/10/25ms 预设全部合法，**underrun 自动升档封顶 300ms**（Q1-c）；虚拟设备（Steam 等）仅 16bit 独占、
  蓝牙预期无独占 → 设备下拉必须渲染每设备能力三态标签（防误配）。

### 7.2 协商/降级链（每次打开设备与每次换曲复用）

```
请求独占
  ├─ IMMDevice 被占用? ──重试 N 次(250ms 退避, 上限 2s)──▶ 失败: 降级共享 + 事件通知 UI
  ├─ GetMixFormat≠源格式 → 按 policy:
  │     auto   : 独占需重开流(§7.3)
  │     force  : 应用层 SRC 到固定率, 独占不断流, 徽章"有处理"
  │     off    : 仅当源=设备能力才独占, 否则共享
  └─ Initialize(EXCLUSIVE) 成功 → 锁定格式; 失败错误码分类:
        驱动不支持 / 缓冲<设备最小 / 权限 → 各自提示 + 按 fallback 顺序降级
降级生效期间: 后台每 5s 静默探测独占可用性; 恢复需满足
  (源无播放中 ∧ 探测成功 ∧ 用户未锁定共享) → 播完当前曲的间隙静默升回, 或用户点"立即恢复"
```

**独占模式副作用的共存策略（Q7 定案 = keep）**：独占期间**其他应用由系统自行切换到其他输出设备**（或静音），
本应用**不让位、不释放设备**；UI 常驻"独占中"角标 + 首次开启一次性说明。若外部抢占导致设备端报错，仍走 §7.2 被动降级链。`release_on_conflict` 键保留但默认且推荐 `keep`。

### 7.3 采样率切换（独占特有）

换曲率不同 → 重开流：`stop → 重协商 → start → 等待对齐`，全程样本计数连续；
衔接点做 2ms 淡入消除重开瞬态（此淡入属于"边界修复"，不算破坏位完美声明——徽章仍绿，
文档如实记录该 2ms 例外）。共享路径无此问题（混音器代劳 SRC）。

### 7.4 设备热插拔与切换

`IMMNotificationClient` 监听 Default/Remove：
- 拔出当前设备 → 自动切系统默认（或暂停等配置，按 `on_device_gone`）；
- 系统默认变更 ∧ 用户设了 `default` 跟踪 → 平滑迁移（续播 seek）；
- 手动切设备：暂停→关旧流→开新流→恢复+对齐进度。
设备下拉项标注每个设备的**独占能力与格式矩阵**（启动时 `IsFormatSupported` 批量探测缓存）。

### 7.5 underrun 处理（Q1-c 定案：缓冲自动升档为主对策）

事件循环优先级：设备事件 > 解码队列 > UI。队列空时输出静音并计数，
`recover_gapless`：补上后从断点样本续（无缝流内），不重启设备。
**升档机制**：滑动窗口内 underrun ≥N 次 → period/buffer 自动提升一档
（设备 min → 5 → 10 → 25 → 50 → 100 → **300ms 封顶**），写入降级事件时间线并 UI 明示
"已放宽缓冲至 Xms（爆音保护）"；`auto_expand_buffer=false` / `buffer_max_ms` 供用户锁定；
D2 下渲染线程零 GC（C++ 核心），升档主要针对 IO/解码饥饿类 underrun。诊断面板暴露计数（§14）。

---

## 8. 无缝播放（gapless）—— 移植 musicfox `beep_gapless.go` 全套算法

1. **元数据裁剪**：MP3 解析 LAME `回放延迟/尾部填充` 与 iTunes `iTunSMPB`（musicfox 已验证：
   字段非法/缺失的判定表、保守估计法 `estimateMP3Padding`——宁少剪不多剪）。
2. **预加载**：`GaplessPreloadSeconds`（默认 5s，musicfox 同名参数）触发对**下一首**（队列确定性已知）
   的解码入队；预载归属校验（fromID == 当前曲）防止队列变更后的串错。
3. **边界切流**：在**同一个输出样本缓冲内**完成旧流耗尽→新流填充（`streamAcrossBoundary`），
   不经过"停-启"，这是无缝的真正来源。
4. **去咔哒**：边界处仅对邻接样本做短窗平滑（`deClickBoundary`），**不做交叉淡化**——
   保留两曲内容原样，消掉不连续点。
5. 采样率不同的两曲边界：走 §7.3 重开流路径（无缝降级为 ≤2ms 间隙），UI 标注原因。
6. 交叉淡化（听感功能，非无缝）作为独立可选节点 `crossfade_ms`，与无缝互斥启用并提示。
7. 以上 1-5 每项都有 musicfox 单测用例可移植为对拍基准（T2）。

### 8.3 Web 兜底引擎

PWA/预览模式保留上游 `TerminalAudio`（三 stem BGM + 音效），仅作降级 UI 演示用；
本机应用主路径不经它。两套引擎共享同一份 UI 状态机契约。

---

## 9. 时钟与进度

- **唯一时钟 = 设备时钟**：`position_samples = 已提交帧数 - 缓冲队列在途帧 + GetPixelPosition`，
  样本级精度；共享后端用 `IAudioClient::GetPosition`。
- 原生 1Hz 广播 position + 每次状态变更立即广播；UI seek/拖动本地外推，
  收到广播偏差 >40ms 时 200ms 平滑收敛（不跳变）。
- 歌词驱动、进度条、SMTC `TimelineProperties` 三方共用同一 position 源。

## 10. 可视化 Tap 与 IPC 契约（移植 musicfox `spectrum.go`）

- Tap 规格照搬 musicfox 验证过的参数：FFT 1024、Hann 窗、预计算 twiddle、**64 带对数分布**、
  **L/R 分离 levels + 主 bin phases**（立体声可视化素材）、EMA 帧平均、
  **弹簧物理阻尼位置**（positions/velocities——观感"活"的关键，上游假 bands 直接换成它）。
- 事件频率：30Hz；payload 见下表。WebView 收到后喂给 `MusicBands` 消费者，场景律动代码不改接口。

| 通道 | 方向 | 频率 | payload 摘要 |
|---|---|---|---|
| `cmd/*` | UI→原生 | 按需 | play/pause/seek/config/device 操作，参数见配置 schema |
| `state` | 原生→UI | 变更时 | 状态机 + 当前曲 + 协商结果 + 徽章事实 |
| `position` | → | 1Hz | ms + samples + rate + 缓冲水位 |
| `spectrum` | → | 30Hz | bands64 L/R + 4 频带聚合 + activity + beat 相位 |
| `transition` | → | 事件 | 无缝切曲 {old_id,new_id,at_samples} |
| `diag` | → | 变更/1Hz | underrun 计数、重开流次数、降级链历史、格式协商明细 |

## 11. 任务栏歌词（复用冻结协议 = 白嫖现有 C++ 插件）

- **协议**：命名管道 `\\.\pipe\go-musicfox.lyric.v1`，JSON Lines：
  `{type:"lyric", primary, secondary}`、`{type:"config", config:map<string,string>}`。
  **Q4 定案：设置面只暴露"管道开关 + 管道名"一项**，管内消息格式完全按 musicfox↔Taskbar-Lyrics
  冻结协议；样式（颜色/对齐/字体）归 Taskbar-Lyrics 插件端配置，我方**不主动下发 config 消息**
  （保持插件端设置权威，避免双主）。
- 借用 musicfox 踩过的坑：连接失败 5s 封顶指数退避；config 值一律字符串；
  颜色格式 `0x?[A-F0-9]{6|8}` 或 `theme|auto|空`（空=跟随系统深浅色），非法值**源头告警+按空下发**；
  与 Taskbar-Lyrics C++ 侧 `ParseColorValue` 的 trim 语义对齐。
- 归属切换：同一时刻只允许一个 lyric 源（检测管道已有写者/配置声明），设置页提供
  "歌词源：MusicPlayer / go-musicfox / 关"三选一，避免双写打架。
- 桌面歌词自绘窗口（musicfox desktop_lyrics）= v2 备选（Q4）。

## 12. 歌词子系统

- 解析器移植 musicfox `lrc.go`/`yrc.go` 语义到 **前端 TS**（歌词是显示问题，留在 WebView）：
  LRC 基础 + 元标签、**YRC 逐字时间戳**、`AlignTranslationToYRC`/罗马音对齐、
  `offset_ms`、`skip_parse_err` 宽容模式、渲染风格 smooth/wave/glow 三态（映射到皮肤的滚动数字/解密动效语言）。
- 来源优先级（**按曲库实测定案，Q2=纯本地**）：内嵌 `LYRICS` 标签（实测覆盖 ~26%）> 同名 sidecar
  （.lrc/.yrc，可配歌词目录，默认关——实测本库 0 个 sidecar）> 无歌词（仅显示元数据）；
  **在线匹配出局**（Q2 定案，未来解禁再加）。
- 解析增强（实测数据驱动的新需求，musicfox 无对应物）：
  1. 站点水印行过滤（实测存在 `[by:鲜果微笑]` 形式首行）；
  2. **行内双语拆句**：内嵌歌词常见 `雨上がりの虹も 雨过天晴的彩虹` 原文+译文同处一行，
     需按字符脚本切换（假名/汉字/拉丁分区）行内拆双栅——与 musicfox `AlignTranslationToYRC`
     （跨文件对齐）互补，属新算法；
  3. cue 实测 0 个 → 整轨/cue 支持降为 v2（§4 设计保留，不排期）。

## 13. 位完美：两级徽章的严格定义

| 徽章 | 条件 |
|---|---|
| `EXCLUSIVE` | 独占流持有中 |
| `BIT-PERFECT ✓`（绿） | 独占 ∧ 全程整型路径(i16/i24 容器宽) ∧ 无重采样 ∧ 音量 fixed/100 ∧ 无 DSP ∧ 采样率=源 ∧ 通道≤2 |
| `APP-PERFECT`（橙） | 应用链路直通，但存在共享混音/f32 解码(如 MP3)/整数音量/force-SRC 中的任一项——UI 逐项列出破坏因子 |
| `PROCESSED`（灰） | ReplayGain/EQ/float 音量/交叉淡化激活 |

规则表进代码为单一 `FidelityAssessor`，所有 UI 徽章/角标/信号路径图由它渲染，不允许旁路文案。
**信号路径图**（Roon 式，复用上游双环内构视觉语言）：解码器名→各节点 直通|处理→输出后端+协商格式，
实时反映当前曲实际链路。

## 14. 错误处理与诊断

- 播放错误重试：`max_play_err_count`（musicfox 同名，默认 3，超限跳曲并在队列入黑名单位置标记）。
- 网络类（Q2 定案纯本地后不存在）；本地文件错误（拔盘/占用）：跳曲计数 + 队列内标记。
- 崩溃安全：状态文件+SQLite WAL；独占设备句柄异常退出由 OS 回收（无泄漏残留）。
- 诊断页（设置内"高级"）：underrun/重开流/降级事件时间线、当前协商格式 vs 源格式对照、
  IPC 往返延迟直方图、环形日志导出。**这是发烧用户信任的来源，优先级不做可裁剪。**

## 15. 配置系统（移植 musicfox `configs/` 经验）

- 格式 TOML（`config.toml`，应用数据目录；首启带注释导出——借 musicfox `toml_edit` 思路）；
  **版本化 + 迁移器链**（`config_upgrade.go` 模式：每版一个 transform，未知键保留不丢）。
- Windows 编辑容忍：UTF-8 BOM（musicfox 有专门测试用例）。
- 默认值原则：日常共享 + hardware 音量 + 无缝开；**独占绝不默认开**（会吓到普通用户）。
- 设置 UI 三层：预设（日常/沉浸/发烧/自定义，互斥约束联动灰显）→ 分组精细 → 诊断。

```toml
schema = 1
[output]
device = "default"        # 或 endpoint id
mode = "auto"             # auto|shared|exclusive
fallback_order = ["exclusive", "shared-event"]
buffer_ms = 10            # 5|10|25|custom(≥设备最小; 本机实测 minPeriod=3ms)
auto_expand_buffer = true # underrun 自动升档（Q1-c 主对策）
buffer_max_ms = 300       # 升档天花板（用户经验值，Q1-c）
on_device_gone = "follow-default"   # pause|follow-default
release_on_conflict = "keep"        # keep|pause（Q7 定案 keep：独占不让位，其他应用自行切设备）
[quality]
volume_mode = "hardware"  # fixed|hardware|integer|float
resample = "off"          # off|auto|force; force 时:
target_rate = 96000
resample_quality = "balanced"
gapless = true
preload_seconds = 5
dedither = false
replay_gain = "off"       # off|track|album
crossfade_ms = 0
[library]
roots = []                # 扫描根目录(多)
watch = true
[dsp]                     # v1 仅占位
eq_enabled = false
[system]
smtc = true
takeover_media_keys = true
autostart = false        # 可 --minimized-to-tray 参数(借 musicfox CLI 开关经验)
single_instance = true
[lyric]
offset_ms = 0
sources = ["embedded", "sidecar"]
render = "word"           # line|word
translation = true
[taskbar]                       # Q4 定案:设置面仅此两项
enabled = false
pipe = ""                       # 空 = 默认 go-musicfox.lyric.v1;可覆盖以与 musicfox 错开
# 样式配置(颜色/对齐/字体)由 Taskbar-Lyrics 插件端持有,本应用不下发 config 消息
[audio_fx]                # UI 音效(与音乐引擎无关)
enabled = true
volume = 0.55
mute_in_exclusive = true  # 默认行为,提供开关(接第二输出设备时)
```

## 16. 曲库存储（原生层，SQLite）

```
tracks(id, path UNIQUE, cue_offset, title, artist, album, album_artist, year, track_no, disc_no,
       duration_ms, codec, sample_rate, bit_depth, channels, bitrate, container_bitperfect_capable,
       gain_track, gain_album, album_art_key, lyric_embedded, lyric_path, mtime, size,
       added_at, play_count, last_played_at)
tracks_fts(FTS5: title, artist, album)
albums/art(哈希寻址文件缓存) playlists(id,name,mtime) playlist_items(pos)
cuesheets(path, source_track)
user_state(收藏/历史, 迁移上游 localStorage rhine-saved → DB, 一次性导入)
```

- 增量同步：目录 watcher（去抖 500ms）+ 定期全量 reconcile；删除采用软删+vacuum。
- 首扫性能目标：1 万曲 <10s（并行元数据读取，仅音频体不读；借 btop4win 的 IO 批量经验）。

## 17. 系统集成细节

- **SMTC**：播放状态/元数据/缩略图（≤200KB，经验值自 musicfox win_media）/Timeline/播放控制命令
  双向；系统媒体键经 SMTC session 或全局热键二选一（`takeover_media_keys`），避免与音乐fox 打架：
  检测同名 session 存在时设置页提示"接管"。
- **托盘**：最小化进托盘、双击回主窗、右键快捷控制（借 btop4win/常见播放器习惯）。
- **单实例**：事件+窗口句柄转发 argv（再次双击文件=当前实例播放）。
- **.music 关联**：安装器注册文件类型（可选开关）。
- **开机自启**：任务计划方式（避 UAC 虚惊，sysmon-cmdpal 经验）或注册表 Run（简单），v1 用后者。
- **文件打开方式**：`RhineLabMusicPlayer.exe "x.flac"` 直接入队播放（musicfox 启动参数经验：
  `--minimized-to-tray` 等价物照抄）。

## 18. 里程碑（对上一轮路线图的最终修订）

| # | 里程碑 | 验收（全部要证据） |
|---|---|---|
| M0 | 壳与皮肤进窗口（**D2**：.NET10+WPF+WebView2 壳 + 核心 C ABI 打桩） | Vite 工程原样渲染，SSAO 帧率基线；IPC ping 往返通 |
| M1 | 状态机 + 双引擎骨架 + Web 兜底 | UI 全链路（播放/暂停/seek/音量/设置持久化）走通 |
| M2 | **核心：ma_decoder 解码 + miniaudio 共享输出 + gapless**（含 s24 容器实测） | musicfox 对拍：同批 MP3/FLAC 边界样本一致；无缝实测；断言 24bit 输出整型 |
| M3 | 频谱 tap + 律动 + SMTC | 64 带 L/R 事件 30Hz；系统媒体卡控制闭环 |
| ~~M4~~ | **（已排除出自主循环，09-13：延后至用户在场窗口）** 独占 + 协商状态机 + 降级链 + 300ms 升档 + 热插拔 | 设计保留 §7.2 |
| M5 | 曲库/watcher/SQLite + 歌词(lrc/yrc + 行内双语拆句) + 任务栏协议 | 44GB 库可用；Taskbar-Lyrics 显示歌词实测 |
| M6 | 设置三层 UI + 信号路径图 + 诊断页 + 安装包（框架依赖 ~5MB）/updater | 发烧预设一键到位，徽章与 FidelityAssessor 一致 |
| **M7** | **Linux 壳**（GTK4+WebKitGTK 或 Go 薄壳 + ALSA direct + MPRIS），核心零改动 | 同一对拍单测集绿；目标机 PipeWire 位完美实测 |

> M7 与 M0-M6 的时序（并行 vs Win 先行）= 新决策 Q1-g（§24）；接口从 M2 起按平台无关写
> （miniaudio 本身平台无关，C ABI 边界即 D2 防漂移护栏）。

## 19. 测试策略

**单元（移植 musicfox 用例）** T1 边界切流不插静音/精确缓冲界保持；T2 iTunSMPB 各畸形组合判定表；
T3 保守 padding 估计；T4 de-click 只动边界；T5 频谱带映射与 EMA 收敛；T6 LRC/YRC 解析语料；
T7 配置迁移链 + BOM。
**集成** T8 协商状态机全路径（mock 设备能力矩阵）；T9 独占抢占→降级→恢复注入测试；
T10 设备拔出/默认变更模拟；T11 gapless 长跑队列（1000 曲混合采样率）断流=0；T12 IPC 事件风暴下限频。
**硬件矩阵（手动，M4 前建表）**：内置声卡(Realtek) / USB DAC(24/192) / 蓝牙耳机(A2DP 无独占→
验证降级文案) / HDMI 音轨；每项记录：独占成败、最小 buffer、underrun、切换间隙实测(ms)。
**回归皮肤**：沿用上游 `verification/` 截图基线思路，UI 里程碑各留一版。

## 20. 上游资产处置清单

| 上游模块 | 处置 |
|---|---|
| `audio.ts` TerminalAudio | 拆分：音效合成部分保留（Web 内 UI 音效总线）；音乐三 stem 仅兜底模式用 |
| `archive-play-motion.ts` MusicBands | 保留接口，数据源从假 bands 换成真频谱事件 |
| `typing-preview.wav` + `typing-samples.ts` | **移除**（原片采样，README 明示非 MIT；用 synthesizeSound 同类音效替代）|
| `pwa.ts`/SW/build-pwa | 仅 Web 版保留；桌面版构建剔除 |
| `boot*.ts` | 转 splash 演出 |
| `scene.ts` 档案阵列 | 改造为播放队列/专辑墙视图（大改，单列计划） |
| `workbench.ts` | 保留：时间/事项/专注组件正是桌面挂件素材 |
| `wallpaper/*` | 与本目标无关，分支隔离或删 |

## 21. 许可证备忘

上游 MIT（保留版权头即可，含分发）。若选 C 路线嵌 mpv → GPL 传染随二进制分发；
D2 依赖树核查：miniaudio 与 dr_flac/dr_mp3/dr_wav = **public domain（unlicense/MIT 双许可可选）**、
WebView2 SDK/NAudio/TagLib# = BSD-3/MIT、.NET 运行时 = MIT —— **全部宽松无 GPL 传染，GitHub 开源发布无障碍**
（早期"嵌 mpv → GPL"分支随 C 方案出局而失效）。
**Q8 定案**：**任何情况下不打包 mpv**——若未来加 mpv 外部引擎（musicfox 式 `mpv.bin` 配置），
要求用户自行下载并指定路径，**GPL 组件永不进入分发边界**；仓库自身 license 推荐 MIT（发布前终确认）。

---

## 23. 本机环境实测（2026-09-12，证据存档）

> 探测程序已收编：`tools/win-audio-probe/`（pwsh 一键重测任意设备能力矩阵）。
> 完整分析见 `docs/DECISION-Q1-HOST.md` §6-§7。

- **曲库**（Q5）：1116 文件 / 44GB；FLAC 964、MP3 152、DSF 2；FLAC ≈60% 是 48k/24bit Hi-Res，
  含 192k/24、96k/24；MP3 无 gapless 标签；内嵌歌词 ~26%（LRC，含 `[by:]` 水印与行内双语），
  无 sidecar/cue；1 个未解压 .rar（Hi-Res 专辑）。
- **设备/独占矩阵**（Q9，NAudio 3.1.0 实探）：默认 = USB DAC CX31993 MAX97220PRO
  （MixFormat float32@384kHz，**独占 16/24bit @ 44.1k–384k 全通过**，minPeriod 3ms）；
  Realtek ALC256 内置（独占 16/24bit ≤192kHz）；Steam 虚拟设备（独占仅 16bit）；
  **float32 独占全设备不支持** → §5 整型容器硬约束实锤；蓝牙耳机未连，A2DP 场景待补测。
- **解码保真**（当时按 B 路线测）：`MediaFoundationReader` 直出 `24 bit PCM` / `16 bit PCM` 整型 ✅；
  `AudioFileReader` 统一降 float32 ❌ → 该教训泛化为 §4 实现红线（D2 下解码改用 ma_decoder 整数路径，不再依赖 MF）。
- **跨平台事实核查**（Q1-a/D2 依据）：WebView2 无法在 Wine 维护（installer 失败、winetricks 无 verb）；
  miniaudio WASAPI 后端支持独占（CoreAudio 后端**不**支持，选对后端是关键）；Linux 位完美 = ALSA direct S32_LE
  或 PipeWire allowed-rates/Pro Audio profile；S32_LE == i24-in-i32 容器语义两平台一致。
- **宿主环境**：WebView2 Runtime 152.0.4191.66 已装（安装包免带）；.NET SDK 10.0.400；
  NuGet 缓存已含 WebView2/WinAppSDK 包；Win11 24H2 (26100)；代理 7897 可用。

---

## 24. 决策台账（v0.2）

- **Q1 宿主路线**：✅ **D2 定稿（Q1-f 通过）**+ **Q1-g：Windows 先行交付，Linux 壳（M7）跟进**
  （接口自 M2 起即平台无关，Linux 壳为纯增量）。细则 `DECISION-Q1-HOST.md` §7.5-§7.6/§9。
  Linux 目标环境暂以"用户跑 musicfox 的机器"为默认假设，M7 启动前再确认发行版/PipeWire。
- **Q4 歌词显示面**：✅ 定（09-12）——**任务栏歌词做**：设置只暴露管道开关+管道名，
  管内格式 = musicfox↔Taskbar-Lyrics 冻结协议（JSON Lines），样式配置归插件端，我方不下发。
- **Q6 DLNA/MPD**：✅ 定——v1 不实现，保留 `engine="dlna"` 枚举与配置占位（留口子）。
- **Q8 license**：✅ **定案（09-13）——仓库 MIT**；**零 GPL 入包**原则不变（不打包 mpv）。
  **安装包形态：zip（便携）+ exe（Inno Setup 安装器，09-13 P-1 批准推翻 NSIS）双产物**，框架依赖分发。
- **M4 独占模式**：✅ **从自主循环范围排除（09-13 用户裁定）**——延后到用户在场的专门窗口再做；
  §7.2 协商/降级链设计保留备用，M2/M3 只走共享模式。
- **M2 节奏**：✅ 先写码不跑测试（09-13），编译通过即合入，功能验证并入后续统一冒烟。
> **决策全部闭环 → M0 开工**（§18 里程碑为准）。
- **Q2 产品边界**：✅ 定（09-12）——**纯本地曲库**，不接在线源。
- **Q3 ASIO/DSD**：✅ 定——**v1 出局**，仅留占位；本地现有 2 个 DSF，库存成规模后启动 DoP 专项。
- **Q5 曲库实况**：✅ 已实测（§23）——解码范围据此收敛为 FLAC/MP3/WAV。
- **Q7 独占共存**：✅ 定——**keep**：独占时不让位不释放，其他应用自行切换输出设备；
  仅当设备端报错才走 §7.2 被动降级链。
- **Q9 音频硬件**：✅ 已实测（§23）——USB DAC 独占至 384kHz/24bit 全绿；蓝牙场景待补测。
