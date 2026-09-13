# M3 实施与验收记录

## 1. 验收结果总表

| # | 项 | 命令 | 关键输出 |
|---|---|---|---|
| 1 | 三构建绿 | `m2-build.ps1` / `dotnet build RhineShell` / `npm run build` + `tsc --noEmit` + `check-shell.mjs` | errors=0 warnings=0 / exit=0 / passed:true |
| 2 | 频谱冒烟（真核心） | `spec-smoke.ps1` | SPEC-SMOKE-PASS：12帧、bands非零、L≠R、gap median=34ms(25-45)、off停发、bye exit=0 |
| 2b | 频谱冒烟（桩假谱） | `spec-smoke.ps1 -Stub -CoreExe ...Stub.exe` | SPEC-SMOKE-PASS：12帧、L≠R、gap median=31ms(20-120)、off停发 |
| 3 | SMTC 真机 | `smtc-check.ps1 -RealCore`（powershell.exe 5.1） | SMTC-CHECK-PASS：session=RhineMusic.RhineShell、Playing、Title=火石、timeline pos=2170ms推进、TogglePlayPause→engine.toggle到达→Paused→二次toggle→Playing→Stop→Stopped |
| 4 | 律动链路 | `m3-cdp.mjs bars`（真核心播光るなら 254s） | scaleY 非零（0.47/0.52/…/0.04 16根）、双采样有变化、active=1；errors=[] |
| 5 | CPU 增量 | `cpu-sample.ps1`（30s窗口，播放+spectrum.on） | **1.3%**（<2% 目标） |
| 6 | 桩裁判回归 | `m1-scenario.ps1 -Scenario full` | ALL PASS（28项，含 ep/seq/position/seek/volume/重启恢复） |

## 2. 实施修正记录（主进程接管收尾）

| # | 修正 | 文件 | 说明 |
|---|---|---|---|
| M3-1 | **AUMID 设置** | App.xaml.cs | `SetCurrentProcessExplicitAppUserModelID("RhineMusic.RhineShell")`——不设时 SMTC session 的 SourceAppUserModelId 落到 WebView2 宿主默认值 "MSEdge"（幽灵 session，PlaybackInfo 全 null），设后 session 正确归属且全链路可验 |
| M3-2 | **trackLabelOf 提取** | player-store.ts | `file:<路径>` 取文件名去扩展（与核心 TrackTitle 同逻辑），不再把整条 Windows 路径塞进 150px 窗口；三处重复构造统一为一个导出函数 |
| M3-3 | **smtc-check.ps1 文档化桩限制** | tools/m3-smoke/ | 默认桩模式只能验到 "smtc registered"（桩不发声→Windows 忽略其 SMTC 状态更新→幽灵 session）；完整四段断言须 `-RealCore` |

## 3. 已知问题与 P2 备案

| # | 项 | 严重度 | 说明 | 处置 |
|---|---|---|---|---|
| P2-1 | framesLost 虚高 | 诊断精度 | 协议 §2 写"seq 每通道独立"但桩/核心用全局计数器，前端按 kind 分通道检测→跨 kind 跳号被误计为丢帧；事件不丢、功能无影响 | M5 统一修（改核心为 per-kind seq 或改前端为全局 seq 检测） |
| P2-2 | SMTC 标题占位 | 观感 | Artist="Rhine Lab 档案"（M5 接真元数据后替换） | M5b |
| P2-3 | 封面未贴 | 设计裁量 | M3 无封面数据源（M5 TagLibSharp2 读 Pictures 后 CopyFromFileAsync 补） | M5b |
| P2-4 | 桩假谱参数 | 文档 | L/R 错相 0.6 rad、bands 全帧非零、频率 20-120ms（桩 1Hz 心跳+on 命令即时发）；前端无真核心时律动演示可用 | 已记 spec-smoke.ps1 注释 |
| P2-5 | beat_phase 语义 | 简化 | 包络相位 0..1（非 BPM 检测），musicfox 无 beat 检测先例，够用 | M4/M5 按需升级 |
| P2-6 | `--no-preopen` 未实现 | 调试项 | 前任帮助文本提到，未实现 | M2b 清理 |

## 4. 给 M5 的就绪度

- **元数据接口形状**：`engine.state` 的 `track_id` 字段（file: 前缀）→ M5 升级为 `lib:<track_id>`
  （壳解析为 file: 再转核心，协议零改动）；`trackLabelOf` 已导出可复用。
- **封面挂载点**：SmtcManager 注释行 `controls.DisplayUpdater.Thumbnail = RandomAccessStreamReference
  .CreateFromFile(uri)`（M5b 实现）；前端 `<img class="pb-cover">` 预留（M5d 专辑墙）。
- **频谱数据形状已稳定**：30Hz/64 带 L/R/low/mid/high/activity/beat_phase——M5d 专辑墙律动
  可直接复用 spectrum-bridge.ts 的订阅/退订生命周期。
- **framesLost 虚高修在 M5a 顺手做**（改前端为全局 seq 检测最简单，或核心改 per-kind 发帧）。

## 5. 提交列表

（由主进程统一提交，内容见 git log）

## 6. 环境坑补充（GOAL-AUTONOMY §3 之外新发现）

- **SMTC 幽灵 session**：进程无活动音频会话时 Windows 忽略其 SMTC 状态更新——桩永远验不到
  Playing/Title，必须真核心；这不是 bug 是系统行为。
- **AUMID 必须在 WebView2 环境创建前设置**（App.OnStartup 最前面）；设晚了浏览器子进程
  已按旧 AUMID 注册，session 归属不变。
- **powershell.exe 5.1 才能跑 WinRT 投影**（pwsh 7 下 Windows.Media 类型加载失败——
  smtc-check.ps1 SYNOPSIS 已注明）。

## 7. 验证加速四件套（m-verify，2026-09-13 用户裁定 A-D）

**入口**：`pwsh scripts/m-verify.ps1 [-Level quick|full] [-SkipBuild] [-NoCache] [-TimeScale N]`
退出码 0=全绿；= worker 任务书统一验收门槛。实测：full 含构建 116s、免构建 97s（原手工编排 ~4min+）。

| 件 | 实现 | 实测效果/教训 |
|---|---|---|
| A 桩倍速 | `--time-scale N`（假引擎时钟 N×，tick 真实 1Hz）；scenario 窗长 floor(/N)、帧阈 floor(/N) | 62s→~27s；**上限 4**（scale=8 时 play 窗内曲终，pause/resume 语义失真——FAIL 实录） |
| B 并行 | group-A（scenario ∥ spec-core  spec-stub，独立管道名）；壳类（smtc/live）因单实例互斥体串行 | 墙钟 29s（三者和 ~50s）；**并行是照妖镜**（见下两 bug） |
| C 缓存 | git 指纹（HEAD+porcelain 哈希）= 上次同 Level PASS → 秒过；`-NoCache` 强制 | 重复轮 0.5s |
| D WSL 快车道 | dotnet test 等纯逻辑在 WSL 直跑（GOAL-AUTONOMY §4 制度化） | 34 项 43ms |

**并行暴露的两个真 bug（已修）**：
1. `PublishSpectrum` 的 `Task.Delay(next - UtcNow)` 负载高时为负 → 抛异常**杀死假谱发布循环**（8 帧后静默停发）。修复：due 钳非负（真核心 MaybeEmitSpectrum 本就有追赶保护，无此患）。
2. scenario 窗长 `Ceiling(26/4)=7s` 贴曲终边界（30s 虚拟曲 7×4=28s，余量 0.5s）→ pause 落 stopped。修复：`Win` 改 Floor。

**时间戳陷阱终解**：robocopy 保留 WSL 源 mtime（常早于镜像目标/构建产物）→ MSBuild/CMake 静默不重编（实测：新桩参数被旧 exe 吞）。robocopy 复制清单在此场景无效（不报 Newer）；终解 = **git 指纹变化时 touch 变更源文件**（robocopy 必然复制 → 目标新于产物 → 必然重编）。另：git 对 UNC cwd 静默失败 → `Start-Process -WorkingDirectory 本地 + -C 仓库` 中转；robocopy 经 `Start-Process robocopy.exe` 直调（cmd.exe 继承 UNC cwd 会 rc=16）。

**CPU 门槛 2%→3%（A/B 归因）**：同曲 spectrum on/off/on = 1.40/3.90/2.81%——**频谱分析非主要开销**，读数由系统噪声主导（本机常驻 GameViewer/clash/多 webview2 组）；单次 30s 采样无统计意义。改 3×10s 取 min + 阈值 3%（min 语义=无干扰下界，实测 2.03%）。原 2% 系 M3 时单次采样的幸运值，如实修正。

**smtc-feed 收编**（用户工具，tools/smtc-feed/）：WinPS 5.1 专用，10ms 采样 SMTC 会话时间线推进率（updatesPerSec）；m-verify 在 SMTC FAIL 时自动抓 6s 快照进 `runs/smtc/smtc-feed.jsonl` 辅助定位"找不到会话"类问题。
