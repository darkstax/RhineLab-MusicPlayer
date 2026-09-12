# M3 任务书：频谱 tap（核心→前端律动）+ SMTC 系统媒体卡（壳侧原生）

> 依据：`AUDIO-ENGINE.md` v0.3 §18 M3、§10（tap 规格）、`IPC-PROTOCOL.md` v1.2、
> `GOAL-AUTONOMY.md` §1-§3。前序：M2 完成（真核心共享模式出声，9c5baef）。
> 范围裁定：仍**不碰独占（M4 域）**；SMTC 走壳侧 C# WinRT 原生（WebView2 Media Session→SMTC
> 映射不可靠，查证后弃用浏览器路径）；前端 Media Session API 不实现。

## 目标（一句话）

核心侧在解码→输出链上挂只读频谱 tap（FFT 1024/Hann/64 带 L/R+phases/弹簧阻尼，musicfox
`spectrum.go` 规格移植），30Hz 经 `evt{spectrum}` 推给前端喂 `MusicBands` 律动；壳侧实现
SMTC（元数据/时间线/播放控制双向），媒体键与飞屏卡片可控制播放。

## 范围三块

### A. 核心：频谱 tap（host/core/src/spectrum.{h,cpp} + audio.cpp 挂点 + main.cpp 事件）

1. **tap 规格**（对照 musicfox spectrum.go 与 AUDIO-ENGINE §10，参数照抄）：
   - FFT 1024、Hann 窗、预计算 twiddle；64 带**对数分布**；L/R 分离 levels + 主 bin phases；
   - EMA 帧平均 + 弹簧阻尼（positions/velocities）；输入 = ring 消费侧的 s32 帧镜像
     （**只读分接**：音频回调把已弹出帧 memcpy 给 tap 的环形槽位，tap 在 IPC 线程聚合——
     音频线程零分配纪律不破，约束 A1）。
   - 采样率适配：FFT 输入按设备率（共享模式=混音率），带映射用实际 rate 归一。
2. **事件**：`evt{kind:"spectrum"}` 30Hz（协议 §6 表；payload bands_l[64]/bands_r[64]/low/mid/
   high/activity/beat_phase，float 归一 0..1）；**订阅开关**：cmd `spectrum.on/off`（§5 表已占名，
   本里程碑启用；协议 v1.3 补参数行）。默认 off（CPU 纪律：无消费者不产出）。
3. beat_phase：简化实现=过零/包络上升沿计时（musicfox 无 beat 检测，phases 已有；
   `beat_phase` 给包络相位 0..1 即可，FINDINGS 记语义）。
4. 桩（RhineCoreStub）**同步加假谱**（正弦+噪声，同 payload 形状）——协议裁判继续对前端可用。
5. 性能红线：tap+FFT 在 30Hz 输出下 CPU 增量 <2%（冒烟自测一次记录即可，不做基准套件）。

### B. 壳：SMTC（host/RhineShell/Smtc/ 新目录，C# WinRT）

1. `SmtcManager.cs`：`SystemMediaTransportControls.GetForCurrentView()`；
   - **出站**：订阅 Bridge 转发的 `evt.state`（含 position）→ 更新
     `DisplayProperties`（Title/Artist——M2 期无元数据，用 track_id/文件名占位，M5 接真元数据）、
     `PlaybackStatus`（playing/paused/stopped）、`TimelineProperties`（Position/LastUpdatedTime/
     SeekResolving 开启，Start/End 从 duration）；节流：状态变更即发，时间线 1s。
   - **入站**：`ButtonPressed`（Play/Pause/PlayPause/Next/Previous/Stop/ChannelUp-Down 忽略）
     → 转 `cmd engine.toggle/next?/prev?/stop`（next/prev M2 未实现→回 not_implemented，
     按钮 IsEnabled 相应置 false）；`SystemMediaTransportControls.IsEnabled=true`。
   - 封面：`Thumbnail` 用 `RandomAccessStreamReference.CreateFromUri(ms-appx:// 或 file:)`——
     M3 无封面源，先不贴（M5 补）；FINDINGS 记。
2. App 生命周期：窗口关闭释放事件订阅；GetForCurrentView 在无 CoreWindow 场景失败时
   降级 `GlobalSystemMediaTransportControlsSessionManager`?? 不——直接 catch 记日志，UI 不受影响。
3. 壳配置键：`smtc.enabled`（config.get/set 已有 dot-path 机制，默认 true）；关闭时不注册。
4. `--no-smtc` 启动参数（E2E 隔离用）。

### C. 前端：律动接线 + 桥扩展（src/）

1. `desktop-bridge.ts`：kind 订阅已支持（M1）；补 `spectrum.on/off` 便捷方法
   （player-store 激活律动时自动 on，页面隐藏/停止时 off——省电）。
2. **律动消费者**：把上游 `archive-play-motion.ts` 的 `MusicBands` 喂真数据——
   `m1-mount.ts`（改名 m-mount? 不改名也行）里加 `spectrum-bridge.ts`：
   `bridge.on("spectrum", f => scene.setPlayfield(...bands...))`？——**注意零侵入铁律**：
   scene.ts 的 `setPlayfield(enabled, bands, strength, flatten, target, breathing)` 是现成 public API
   （M0 侦察确认），前端只需在**播放中**以 rAF 调它，不碰 scene.ts 本体。
   播放状态联动：playing→enabled=true + bands 实时；stopped/paused 3s 后→quietBands 缓落。
3. 播放条加微型频谱条（16 根，bands_l 抽稀，CSS transform scaleY）——验证数据链路的可视化证据，
   也进 M6 信号路径图的"活体演示"素材。
4. web 降级：无 bridge 时律动维持现状（假 bands/关），零异常。

### D. 协议 v1.3（先改文档再动码）

- §5 启用 `spectrum.on/off`（result `{enabled}`）；§6 spectrum 行参数定形（数组 64 float、
  low/mid/high/activity/beat_phase 语义一句话）；桩假谱声明（`stub:true` 不加——payload 同形，
  诚实性由 negotiated 域外，FINDINGS 记桩假谱参数即可）。

## 验收（无人值守部分全做；听感/观感仍停点移交）

1. 构建三绿：m2-build（核心+桩）、dotnet 壳、npm build+tsc+check-shell。
2. 协议冒烟扩展（tools/m2-smoke/smoke.ps1 加段或新 spec-smoke.ps1）：play 真 FLAC →
   spectrum.on → 收到 ≥10 帧 spectrum、bands 非全零、L≠R 至少一帧、频率≈30Hz（帧间隔中位数
   25-45ms）→ off 后停发 → bye。桩同形验证。
3. SMTC 真机验证（pwsh 无人值守）：播放中 `Get-Command Windows.Media`…——用
   `[Windows.Media.SystemMediaTransportControls,Windows.Media,ContentType=WindowsRuntime]`
   经 WinRT 读**当前会话**（GlobalSystemMediaTransportControlsSessionManager.RequestAsync
   枚举 sessions）断言：出现本应用 session、PlaybackStatus=Playing、ButtonPressed 注入
   （session.TogglePlayStatus 等 API 可远程触发）→ 桩/核心日志见 engine.toggle。
   若 WinRT 枚举脚本不可行，降级为：壳日志记录 SMTC 注册成功 + 手动一次飞屏验证列入停点清单。
4. 律动链路：headless CDP（tools/m1-e2e 模式）读 `__rhinePlayer` + 微型频谱条 DOM transform
   非零断言；截图一张进 FINDINGS。
5. CPU 冒烟：播放+spectrum.on 30s，核心进程 CPU% 采样（Get-Counter 或 Process.TotalProcessorTime
   差值）记录进 FINDINGS（阈值 <2% 增量，超了先优化弹簧/降带数再报）。
6. 提交：中文分笔（协议+桩 / 核心 tap / 壳 SMTC / 前端）；FINDINGS 更新；生成物不入库。

## 纪律（不变项从略，新增两条）

- 音频回调零分配红线不许破：tap 的槽位预分配、IPC 线程聚合；违反=reviewer P0。
- SMTC 出站节流不许高频打 WinRT（1Hz 上限），入站命令走既有 cmd 转发链，不自开旁路。
- 环境三坑照 GOAL-AUTONOMY §3；构建分步防心跳误杀；3 连败停手。

## 报告格式
①文件清单 ②验收 1-6 证据 ③桩/核心假谱与真谱参数说明 ④commit 列表 ⑤缺口与 M5 就绪度
（元数据接口形状、封面挂载点）⑥给 reviewer 的重点文件。
