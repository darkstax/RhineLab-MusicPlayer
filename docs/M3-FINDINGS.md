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
