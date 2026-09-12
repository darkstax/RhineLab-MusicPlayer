# 音频引擎与播放设置设计（AUDIO-ENGINE）

> 状态：Draft v0.1 · 2026-09-12
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

## 2. 宿主技术路线（待拍板 → 决策点 Q1）

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

**主进程意见**：若目标锁定 Windows + 发烧播放，**B（.NET 10 + WebView2 + NAudio）胶水层最薄、
与用户现有工具链同构**；A 工程质量上限更高但所有原生能力要手搓；C 唯一能白嫖 musicfox 代码，
但恰好在最难的部分（独占）最弱。文档其余章节按语言无关的接口契约书写，选型不影响主体设计。

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

- **容器/编解码**（第一优先级按本地库实况，见 Q5）：FLAC（含嵌套 OGG）、WAV、AIFF、ALAC(m4a)、
  MP3（含 LAME/iTunes 间隙元数据解析）、AAC/MP4、OGG（Vorbis/Opus）、WV/TTA 视库而定。
- **统一中间格式**：`{interleaved | planar, i16 | i24(packed→i32) | f32, rate, channels}`；
  解码器能力如实上报（如 symphonia FLAC 原生 i16/i24 → 整型直通保真；MP3 只能 float → 该路径永不
  位完美，徽章如实显示，见 §13）。
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
- `[dlna/mpd]`：musicfox 特色（投送输出），v2 再议（Q6）。

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

**独占模式的副作用明示**（设置页一次性说明 + 状态栏常驻角标）：
系统全部其他声音静音；WebView UI 音效自动静音；检测到其他应用请求音频时按配置
`release_on_conflict = pause-and-release | keep` 处理（利用独占被抢占会失败/断连的现象做被动检测 + `IAudioSessionNotification` 主动检测，两档实现深度见测试清单 T9）。

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

### 7.5 underrun 处理

事件循环优先级：设备事件 > 解码队列 > UI。队列空时输出静音并计数，
`recover_gapless`：补上后从断点样本续（无缝流内），不重启设备。诊断面板暴露计数（§14）。

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
  新播放器默认以**同协议**作为 client 连接（可配置 pipe 名以兼容共存/切换来源）。
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
- 来源优先级可配：内嵌标签 > 同名 sidecar（.lrc/.yrc，含歌词专属目录设置）>（若接在线源）API 匹配（Q2/Q7）。

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
- 网络类（若接在线源）：超时/中断沿用上游 `prepareMusic` 的 AbortController 模式原生化。
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
buffer_ms = 10            # 5|10|25|custom(≥设备最小)
on_device_gone = "follow-default"   # pause|follow-default
release_on_conflict = "pause"       # keep|pause
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
[taskbar]
enabled = false
protocol = "musicfox-v1"  # 兼容冻结协议; "" = 关
pipe = ""                 # 自定义覆盖
primary = ""              # 颜色: 空=跟随主题 | theme | 0xAARRGGBB
secondary = ""
alignment = "auto"
font_family = ""
font_size_primary = 0
font_size_secondary = 0
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
| M0 | 壳与皮肤进窗口（路线定后） | Vite 工程原样渲染，SSAO 帧率基线报告 |
| M1 | 状态机+双引擎骨架+Web 兜底 | UI 全链路（播放/暂停/seek/音量/设置持久化）走通 |
| M2 | 原生共享后端 + 解码 + gapless | musicfox 对拍：同批 MP3/FLAC 边界样本一致；无缝实测 |
| M3 | 频谱 tap + 律动 + SMTC | 64 带 L/R 事件 30Hz；系统媒体卡控制闭环 |
| M4 | **独占 + 协商状态机 + 降级链 + 热插拔** | §19 硬件测试矩阵全绿；underrun=0 长跑 2h |
| M5 | 曲库/watcher/SQLite + 歌词(lrc/yrc) + 任务栏协议 | 1 万曲库可用；Taskbar-Lyrics 显示歌词实测 |
| M6 | 设置三层 UI + 信号路径图 + 诊断页 + NSIS 打包/updater | 发烧预设一键到位，徽章与 FidelityAssessor 一致 |

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
选 A/B 自研核心则依赖均为 MIT/Apache/LGPL-可兼容，**GitHub 开源发布无障碍**。
新仓库 license 待定（Q8）。

---

## 22. 待拍板决策（阻塞后续里程碑）

- **Q1 宿主路线**：A Tauri+Rust / B .NET10+WebView2+NAudio / C Go+webview（§2 表，倾向 B，理由见表格行"与本地资产协同"与"独占现成度"）。
- **Q2 产品边界**：纯本地曲库？是否要接入网易云等在线源（musicfox 的 netease 层经验与账号/DRM 复杂度完全是另一个量级，建议 v1 纯本地）。
- **Q3 ASIO / DSD**：v1 砍掉只留占位是否接受（有 PS1/DFF 库存需要则另议）。
- **Q4 歌词显示面**：任务栏（借冻结协议白嫖 C++ 插件）✓；桌面歌词自绘窗 v2？还是任务栏都不要（先专注主窗歌词页）。
- **Q5 曲库实况**：格式分布（FLAC 为主？有无 ALAC/WV/DSD）、数量级（决定 DB 与扫描并行度）、
  歌词形态（内嵌/sidecar/无）、有无整轨+cue 专辑。
- **Q6 DLNA/MPD 输出**：musicfox 有此玩法，本机应用要不要留想象空间。
- **Q7 独占共存策略**：默认 `release_on_conflict=pause`（其他应用出声就让位）符合直觉吗？
  还是发烧场景应该"死死咬住设备，别人闭嘴"（keep）？
- **Q8 新仓库 license**：MIT 沿用？还是个人项目常见的 CC BY-NC 之类。
- **Q9 音频硬件**：主力 DAC 与目标最高格式（384k/32bit？有 DSD？），影响硬件测试矩阵优先级。
