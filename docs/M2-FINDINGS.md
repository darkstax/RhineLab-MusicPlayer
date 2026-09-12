# M2 FINDINGS — C++ 音频核心实施记录

> 任务书：`docs/M2-PLAN.md` · 协议：`docs/IPC-PROTOCOL.md` v1.2 · 语义裁判：`host/RhineCoreStub/FakeEngine.cs`（不可改）
> 实施：前任会话完成核心源码（未编译）；本会话（接管）建立构建系统、编译迭代修正、冒烟、壳接线与文档。
> 环境：MSVC BuildTools 18（14.44 工具集，VS 18）+ CMake 4.3.1-msvc1，x64 Release，构建在本地盘镜像
> `C:\Users\StarL\m2-work\host`（robocopy 自 UNC 工作树）。

## 0. 验收状态

| 验收 | 结果 | 证据 |
|---|---|---|
| 1a `pwsh scripts/m2-build.ps1` 产出 RhineCore.exe，/W4 零警告 | ✅ | 构建日志 `errors=0 warnings(project)=0`（vendor 经 /external:W0 隔离，见 §6.6）；产物 `dist-host/core/RhineCore.exe` 642KB |
| 1b `dotnet build` 壳绿 | ✅ | RhineShell.csproj Release `0 个警告 0 个错误`（含 --core-exe 改动） |
| 1c `npm run build` 绿 | ✅ | vite 正常完成（>500KB chunk 提示为既有现象，前端零改动） |
| 2 冒烟不崩（一次） | ✅ | `tools/m2-smoke/smoke.ps1` SMOKE-PASS：FLAC24 + MP3 各一次全链路（§8） |
| 3 FakeEngine 静态对照表 | ✅ | 本文 §1/§2 |
| 4 中文分笔提交 | ✅ | 3 笔 feat（vendor+cmake / 核心+冒烟修正 / 壳+docs） |

## 1. FakeEngine ↔ rhine::Engine 逐条对照表

状态机本体（`host/core/src/engine.{h,cpp}`）对 FakeEngine 的直译关系。
「一致」= 行为逐条等价；差异全部为 M2 真语义增量（§2）或有意裁定（标 ⚖）。

| # | 场景 | FakeEngine（裁判） | C++ Engine | 判定 |
|---|---|---|---|---|
| 1 | 初始状态 | `Idle`，position=0，volume=1.0/"float" | 同 | 一致 |
| 2 | play 空 track_id | `EngineBadRequest` | `BadRequest`（同文案） | 一致 |
| 3 | play duration_ms<1 / position_ms<0 | bad_request | 同（显式参数仍校验；时长实际取解码事实） | 一致+增量 |
| 4 | play 起始位置钳制 | `min(start, duration)` | `start > duration && duration != 0 → start = duration` | 一致（duration=0 见 §2.3） |
| 5 | play 事件序 | `[state, position]` | 同 | 一致 |
| 6 | play ack | `{stream_token:"fake-<n>"}` | `{stream_token:"core-<n>"}`（进程内单调同款） | 一致（前缀=来源标识） |
| 7 | 重复 play 同 track | 从头（重锚 + Playing） | 不重开解码器，`RestartStream(0)` 从头 | **审查 P0-1 修正后成立**：修复前 EOF 后同曲重播永久锁死（seek 成功不清 eofReached_，解码线程不再供喂）；audio.cpp RestartStream/SeekFrozen 成功分支已补 `eofReached_=false`，真机 repro.ps1 实测重播恢复推进（pos 40→…→5520）+toggle 重播 OK |
| 8 | position 外推（playing） | 锚点 + (now − epoch)，`min(…, duration)` | 设备时钟：锚点帧 + (played − anchorPlayed)，钳 [0,length] | 一致（时钟源换权威，§4） |
| 9 | position（非 playing） | 锚点冻结值 | `lastPositionMs_` 冻结值 | 一致 |
| 10 | pause 仅 playing 生效 | 冻结=外推落锚；否则幂等回 state | 先 `PositionMs()` 读点再 `FreezeStream()`；否则幂等 | 一致 |
| 11 | pause/resume/stop/toggle ack | `{state:<wire>}` | 同 | 一致 |
| 12 | pause/resume/stop 事件序 | `[state, position]` | 同 | 一致 |
| 13 | resume 仅 paused 生效 | 重锚续播不跳变；stopped 不重播 | `ResumeStream()` seek 回冻结锚点，不重锚 | 一致 |
| 14 | stop | 位置清零、track_id 保留、任何状态可用（idle 幂等） | 同 + `Reanchor(0)` | 一致 |
| 15 | toggle idle/stopped 有曲 | `Play(track, DurationMs)` —— **保留时长**从头重播（审查 P1-1） | `OpenCurrentTrackAndStart(0)`：解码器已关则重开，`durationMs_` 不变 | 一致（时长来自解码事实，天然保留） |
| 16 | toggle 无曲 | 幂等 `[state, position]` | 同 | 一致 |
| 17 | seek 无曲目 | bad_request | `trackId_.empty() && !track_open()` → bad_request | 一致 |
| 18 | seek 钳制 | `Clamp(pos, 0, duration)` | [0, duration]（duration=0 不封顶，见 §2.3） | 一致+增量 |
| 19 | seek ack / 事件序 | `{applied_ms}` / `[position, state]` | 同 | 一致 |
| 20 | seek playing 中 | 重锚即时生效 | `RestartStream(frames)`（清 ring+decoder seek+重锚，≤100ms 重建记 trace 语义） | 一致+增量 |
| 21 | seek 非 playing | 动锚点，不起播 | `SeekFrozen`（decoder+锚点动，设备保持停） | 一致 |
| 22 | volume 非法 mode | bad_request（枚举表同文案） | 同 | 一致 |
| 23 | volume fixed | 锁 1.0，ack effective | 锁 1.0 + 增益直通 ⚖（任务书 §5 裁定，见 §2.5） | 一致 |
| 24 | volume value 越界 | `Clamp(v, 0, 1)` | 同 | 一致 |
| 25 | volume 缺 value | 保持现值 | 同 | 一致 |
| 26 | volume ack / 事件序 | `{effective:{mode,value}}` / `[position, state]` | 同 | 一致 |
| 27 | Tick 任意状态 | 每 1s 一帧 position | 同（会话线程 1Hz 驱动） | 一致 |
| 28 | Tick 曲终收敛 | `position ≥ duration` → anchor=duration, `Stopped`；`[position, state]` 序 | `endByClock ∨ endByEof` → 同 | 一致+增量（EOF 双路，§2.4） |
| 29 | position payload | `{position_ms, frames, rate, buffered_ms, drift_ms}` | 同字段；rate=设备实际速率；`buffered_ms`=ring 真实水位（桩合成 30000 不再用） | 一致+增量 |
| 30 | state 快照 | negotiated/badges = null（M1 豁免） | 协商事实对象（§5；null 豁免只属桩，任务书约束 3） | 有意差异 |
| 31 | 未实现 cmd | not_implemented，不静默丢弃 | 同（preload/cancel_preload/queue 在真核心也显式 not_implemented——见 §2.6） | 一致 |
| 32 | echo | 桩实现（M0 遗留） | 不实现（caps 未声明，按 §5 回 not_implemented） | 有意差异（真核心无回声测试面） |
| 33 | hello 成功 → ep 自增、evt 携带 ep | 进程内计数 | 同（进程级 atomic，跨连接延续） | 一致 |
| 34 | hello 后补发最新 state | 是（§9） | 同 | 一致 |
| 35 | 3s 握手超时 → 关连接、进程存活待重连 | CancellationToken | `ReadLineTimeout(3000)`（接管修正，§3-B1） | **审查 P0-2 修正后成立**：修复前超时后续听新实例吃 231 → exit=5 死亡；main.cpp 改为先 Disconnect+Close 旧实例再建（231 重试环），handshake.ps1 实测超时后 conn=2 续连 OK |
| 36 | bye → 有序退出 exit 0，不回帧 | 同 | 接管修正为同款（前任回 `bye{core-ack}` 已删，§3-B2） | 一致 |
| 37 | EOF（壳断线）→ 会话结束继续 listen | 同 | 同 | **审查 P0-2 修正后成立**：同 #35（预创建下一实例在 max=1 下必吃 231）；hardcut.ps1 实测硬断线→conn2 重连 ep=2 递增→bye exit 0 |
| 38 | 非法帧（非 JSON / 非对象 / cmd 缺 id） | bad_request 不崩溃 | 同 | 一致 |
| 39 | 状态机跨连接保留 | 进程级单例 | 接管修正为进程级单例（前任在 Session 内 new，§3-B3） | 一致 |
| 40 | 第二实例 | 管道占用 exit 3 | 同（CreateNamedPipe 失败首连 → 3） | 一致 |
| 41 | 会话未预期异常 | exit 5 | 同 | 一致 |
| 42 | `--kill-after` 模拟崩溃 | exit 7 | 同 | 一致 |
| 43 | `--halt-events` 丢帧钩子 | 有 | 不迁移（GOAL-AUTONOMY 裁定：m1-scenario 只对桩） | 有意差异 |

## 2. M2 真语义增量（相对桩的有意差异，全部有任务书依据）

1. **track_id scheme**（约束 7）：仅接受 `file:<绝对路径>`；非 file: 前缀回
   `bad_request{unknown track_id scheme}`。中文/全角路径经 `_wfopen` 宽字符路（§3-B7）。
2. **position 权威 = 设备时钟**（约束 2）：见 §4。
3. **duration=0（长度不可得）**：桩恒有 duration（默认 180000）；真核心对无总帧数流（理论上
   VBR 无 seek 表）如实报 0，seek 不封顶、曲终由 EOF 排空收敛，并把实际位置回填 duration（UI 终态一致）。
4. **曲终双路**：`position ≥ duration`（时钟路，桩同款）∨ `EofDrained()`（解码 EOF + ring 排空，
   真音频新增）任一成立即收敛 stopped。
5. **volume 模式裁定 ⚖ → 主进程定案（09-13）：采桩兼容方案，不回退任务书字面**。理由：
   前端 M1 已依赖四 mode 全 ack 行为，真核心突然 not_implemented 会造成接入断裂；
   fidelity factors 已如实标注（float-volume/hardware-volume），诚实性约束（§4 红线）满足；
   integer 属 M4 定点域，拒得对。任务书约束 5 字面作废，以本节为准。
6. **engine.preload / cancel_preload / queue 回 not_implemented**：§5 标 M2，但用户裁定
   gapless/预加载边界队列拆入 M2b（队列结构已立对，见 §7.2）；§5 纪律「未实现的 cmd 必须
   回 not_implemented，不得静默丢弃」满足。
7. **volume 持久化不在 M2**：桩有 StubStateFile（M1 A7）；真核心音量重启即回 1.0。
   M5 配置系统（TOML）接管，键名不变。记 §6 缺口。
8. **caps**：桩声明 `echo + engine.*`；真核心只声明 engine.* 八字（§5 caps=已实现能力交集）。
   壳不依赖 echo（M0 自检已退役）。

## 3. 接管修复清单（前任未编译代码 → 可运行）

### A. 编译/链接错误（cl /W4，构建镜像内）

| # | 位置 | 错误 | 修法 |
|---|---|---|---|
| A1 | main.cpp | `std::min(long long, int)` C2672/`FrameType()!=const char*` C2678 等 | `#include <algorithm>` + NOMINMAX（CMake 定义）、peerProto/effective 统一 int、`FrameType(frame).value_or("")` |
| A2 | main.cpp | `ConvertStringSecurityDescriptorToSecurityDescriptorW` C3861 | `#include <sddl.h>`（链接 advapi32） |
| A3 | main.cpp | `MultiByteToWideChar` 传了 8 参（WideCharToMultiByte 的形状）C2660 | 改 6 参正确调用 |
| A4 | protocol.cpp | `FrameType`/`FrameId` 声明未定义 → LNK2019 | 补实现（SafeString 转发） |
| A5 | audio.cpp | `ma_device_stop(&d, MA_TRUE)` C2660（v0.11.25 单参） | `ma_device_stop(&d)` |
| A6 | audio.cpp | `MA_END_OF_DATA` 不存在（v0.11.25 为 `MA_AT_END`） | 改 `MA_AT_END`（`got==0` 兜底保留） |
| A7 | audio.cpp | `ma_context_get_devices` 要 `ma_device_info**`，实参 `const*` | 去 const |
| A8 | audio.cpp | `CP_UTF8/MultiByteToWideChar` 未声明（miniaudio.h 不对外暴露 windows.h） | 文件头 `#include <windows.h>` |
| A9 | main.cpp | 恒真表达式 `GetLastError() == ERROR_PIPE_CONNECTED \|\| TRUE`（W4428 类风险）+ 停信号走错分支 | 重写为 WAIT_OBJECT_0=连接完成 / 其余=停机退出 |
| A10 | main.cpp | `--verbose` 解析后未用（C4189） | `Session::SetVerbose` 接进会话 |

### B. 行为/正确性修复（冒烟中暴露 + 静态审查）

| # | 问题 | 影响 | 修法 |
|---|---|---|---|
| B1 | 握手用 `WaitReadable(3000)` 后接**阻塞** `ReadLine`：对端只连不发 → 会话线程永久挂死（桩靠 CancellationToken 无此问题） | 违反 §4（3s 关闭可重连）| `PipeIo::ReadLineTimeout`（Peek+限时片读） |
| B2 | bye 回 `bye{reason:"core-ack"}` | 与桩不一致（桩不回帧；协议 §3 bye 无 ack 语义） | 删回帧，直接有序退出 |
| B3 | `Engine` 值成员在 Session 内构造 | 断线重连播放状态丢失（桩是进程级单例保留） | main 持有单例，Session 引用 |
| B4 | Emit 里 `Send(MakeEvt(..., std::move(payload)))` 之后 trace 再 `payload.dump()` | trace 全部 `data=null`（move 后对象为空）——冒烟首轮实锤 | dump 文本先于 move 取 |
| B5 | 管道 ACL 用 `D:(A;;GA;;;SU)…` | **SU=服务登录组**，交互式进程连不上（ACCESS_DENIED，冒烟实锤：桩可连/核心不可连 A/B 对照） | 取本进程令牌 User SID 动态构造 SDDL（+SY/BA，与 .NET CurrentUserOnly 同构），保留 `PIPE_REJECT_REMOTE_CLIENTS` |
| B6 | probe 解码器（format=unknown）对 FLAC 报 `f32`（backend 默认输出格式，非源原生位深） | chain.decoder.detail 谎报（"flac f32" 实为 s24 源）——24bit 红线取证错误 | 直读容器头（fLaC STREAMINFO / RIFF fmt / mpeg sync）取真实位深：s16/s24/s32/f32 |
| B7 | `ma_decoder_init_file`（char*）在 Windows 走 `fopen`（ANSI CP），中文/全角路径必失败 | `C:\Users\…\音乐` 真实曲库不可播 | 改 `ma_decoder_init_file_w`（内部 `_wfopen`） |
| B8 | Negotiated 音量直通判定只看软件增益 | MP3 float 解码被标 app-perfect 无因子（约束 3「禁止谎报」）；hardware 路生效时增益读数失真 | 源 float → 明列 `float-decode` 因子 + decoder.passthrough=false；hardware 路以端点音量值判定（hardware-volume 因子） |

未修（如实记录）：`Engine::Play` 的钳制三目含一个不可达分支（`durationMs_ == 0 ? 0 : durationMs_`
在外层条件永假），行为无害，留作 M2b 顺手清理。

## 4. 设备时钟口径与 40ms 起点

本版本 miniaudio 无公开的 `IAudioClient::GetPosition`（cursor）封装；采用
**「回调消耗节奏 = 设备消耗节奏」等价口径**：`position = 锚点 + (已从 ring 真实弹出帧数)`。
- 播放中 ring 由解码线程保持在 ≈683ms 深（65536 帧 @96k / 1.365s @48k ≥ 2×buffer_ms），
  回调永不欠载 → 弹出帧数与设备渲染帧数只差一个缓冲深度（startup 后恒定），不漂移不倒退。
- 冒烟实测起播 0.1s 后 position=40ms：= 设备启动预填充（1 period 561 帧 ≈11.7ms 的
  ring 深度差 + priming），量级符合口径推断；play 即时帧即含此值，UI 外推会自然吸收。
- M3 若接 `IAudioClient`（或 miniaudio 上游公开 cursor API），只需替换 `PositionFrames()`
  的实现，锚点语义不变。
- 与 AUDIO-ENGINE §9 的 `已提交 − 在途 + GetPixelPosition` 严格式差距已在类型层隔离
  （单一函数边界），不构成协议可见差异。

## 5. 24bit 红线取证（AUDIO-ENGINE §4 / 任务书约束 3）

- 解码输出容器强制 `ma_format_s32`（`ma_decoder_config_init(ma_format_s32, 2, rate)`）：
  FLAC i16/i24 经 dr_flac `read_s32` **全程整数直通**（24bit 高对齐鲁位，s24-in-s32）；
  ring/回调域均为 s32 容器 → 核心内部无隐性 float 化。设备路 miniaudio 共享模式把 s32
  填入 f32 端点缓冲（WASAPI mix format 探测为 f32 时直接按 f32 写，浮点乘法增益）——
  这属于共享混音域，`shared-mixer` 因子已明列，符合 §13（共享模式恒非 bit-perfect）。
- probe 头直读（§3-B6）把源真实位深写进 chain：FLAC24 冒烟帧 =
  `{"detail":"flac s24->s32","passthrough":true}`；MP3（44.1k）冒烟帧 =
  `{"detail":"mp3 f32->s32","passthrough":false}, factors:[shared-mixer,float-decode,resample]`，
  fidelity=processed（重采样激活）如实降级。
- `format` 对象报**设备端点事实**（bits_container=32/bits_valid=32/encoding=pcm-float
  @f32 混音），不冒充解码容器；「解码整型直通」证据在 chain。fidelity 恒 ≤ app-perfect
  （共享模式无 bit-perfect 宣称，§13）。

## 6. 已知缺口与欠账

1. **gapless 未做**：拆 M2b（用户已允许）；边界切流队列结构已就位（§7.2），当前曲终
   = 时钟/EOF 双路收敛 stopped，无自动下一曲（与桩一致）。
2. **volume 精确语义**：hardware 模式在共享端点的位完美宣称依赖系统混音器行为，
   M4（独占/协商）后才有完整真值；integer 模式 not_implemented。
3. **音量持久化**：M5 配置系统接管（桩的 stub-state.json 行为真核心暂无）。
4. **underrun 上报**：计数器已在（`underruns()`，primed 后断流才计），但 §5 `diag.get`
   与 §6 `evt{diag}` 属 M4 域未接线。
5. **听感验收**：任务书裁定延后统一验收；技术冒烟不等于听感确认。待验收清单：
   玻璃交互 vs 真曲淡入、seek ≤100ms 重建听感、pause/resume 无缝、44.1→48k SRC 品质、
   MP3 float 路高频细节、volume 0.5 双路（软件/端点）一致性、欠载听感（M4）。
6. **vendor 告警隔离口径**：`/external:W0` 使 miniaudio/json 告警不计入零警告线——这是
   本工程验收 1 的解释（任务书「/W4 零警告」约束本工程 TU）；vendor 自身在 MA_DEBUG/
   全警告下未单独审计（上游自证零警告发布）。
7. **`--no-preopen`** 帮助文本提到但未实现（调试项，桩同款无此开关）；不影响任何已声明能力。
8. **第二实例 superseded 语义**：M2 靠 CreateNamedPipe 占用即 exit 3（桩同款）；协议 §9 的
   「第二实例连上收 bye{superseded}」完整形态属 M4。

## 7. 给 M3 的接口就绪度

### 7.1 频谱 tap 挂点
- `SpscRing::peek(skip, dst, n)` 已实现（非消费读取，M3 频谱线程可与音频回调并发消费/读取，
  SPSC 不破约：tap 是只读第三指针需升级为 SPSC+只读者时改用双 peek 或独立 tap ring，
  当前签名预留）。
- 更稳的挂点建议：音频回调里 `popScratch_` 写完后加一次 `tapPush()`（回调零分配已满足——
  tap 环预分配），spectrum 30Hz 事件在解码线程或独立线程聚合，不碰 track 域账本。
- `evt{spectrum}` 需要 seq/ep 通道：`Session::Emit` 已统一（任意 kind 直接可用），
  但 M3 需把事件发射从会话线程扩展到非会话线程（当前 Emit 在会话线程内串行写管道，
  与桩的 WriteGate 串行同构——M3 加一个写入互斥量即可）。

### 7.2 边界切流队列结构（M2b/M5）
- 线程模型固定三方（回调/解码/IPC），ring 深 ≥ 2×buffer_ms 纪律已立；
  gapless 需要的「双解码器共享同一 ring + playedFrames 连续计账」在现结构上是增量：
  ring 存 track 混合流，`Reanchor/playedFrames` 在边界不重置（transition 事件补发
  `at_frames/at_ms` 从 anchor 换算），`TrackFacts` 需从「单实例」改「current/next 对」。
- `EofDrained` 语义在边界切流时要拆成「当前 track EOF 但 ring 非空 ≠ 排空」，
  已按此设计（readable()==0 参与判定），M2b 只换收敛动作（停→transition 续）。

### 7.3 negotiated 结构（M3 devices.* / M4 output.mode）
- 现对象严格按协议 §8：`share/backend/format{rate,bits_container,bits_valid,encoding,channels}/
  buffer_ms/period_ms/auto_expanded/chain[{node,detail,mode?,passthrough}]/fidelity/factors[]`。
- `AudioBackend::Negotiated()` 是**唯一组装点**，M3 换设备（`config.playback.pDeviceID`）后
  只需扩 DeviceFacts；`exclusive` 分支字段（rates/min_period_ms/mix_format）来自
  `ma_context_get_devices` 的 nativeDataFormats（已在用，devices.list 数据源现成）。
- fidelity 规则表集中在 Negotiated（§13 语义），M4 独占后加 bit-perfect 分支即可，
  徽章（Badges）自动跟随。

### 7.4 其它
- 退出码 0/3/5/7 与桩对齐，壳的重启监管（max_play_err_count）无需感知核心类型。
- 壳 `--core-exe`（约束 8）已接线：`RhineShell --spawn-core --core-exe <dist-host\core\RhineCore.exe>`
  即真核心；日志 `spawned core pid=… exe=RhineCore.exe` 区分类型。
- trace 格式与桩同款（`HH:mm:ss.fff evt=… seq= ep= data=…`），m1-scenario 的位置推进断言
  可直接复用解析。

## 8. 冒烟证据摘录（tools/m2-smoke/smoke.ps1，一次通过）

- FLAC 24bit/48k（流浪地球·火石，9818ms）：
  `hello ep=1 → play ack stream_token=core-1 → state(playing,duration=9818) →
  tick position 960/1970/3020/4080（≈1000ms/秒，无倒退）→ pause 后 1.5s 位置稳定 4090 →
  resume → seek applied 1500 → volume float/0.5（fidelity app-perfect→processed，
  factors +float-volume）→ stop position=0 → 对象型 track_id/裸垃圾行 → bad_request 存活 →
  devices.list → not_implemented → bye → 进程 exit 0，trace 19 行落盘。SMOKE-PASS`
- MP3 44.1k（Not Your Business，115768ms）：SMOKE-PASS；chain 如实 `mp3 f32->s32
  passthrough:false`，factors `[shared-mixer,float-decode,resample]`，fidelity=processed。

## 9. 编译迭代摘要（最终态）

- 迭代轮次：configure 修参数 1 轮 + 编译修复 4 轮（A1–A10）+ 行为修复至冒烟通过（B1–B8）。
- 同一错误无 3 连败记录；无遗留 workaround。
- 最终构建：`errors=0 warnings(project)=0`；增量编译只编业务 TU
  （miniaudio_impl 单独成 TU，全量约 3 分钟，增量 <20 秒）。

## 8. 审查修复记录（reviewer-qwen 报告后，主进程执行，2026-09-13）

审查结论"修后复审"，四项全部落地并真机复验：

- **P0-1 EOF 后同曲重播锁死**（audio.cpp）：`RestartStream`/`SeekFrozen` seek 成功分支补
  `eofReached_.store(false)`。复验：repro.ps1（曲终→同曲 re-play→toggle）修复前"秒回 stopped
  永久锁死"，修复后重播恢复推进（pos=40→5520）且 pause 冻结正常，exit=0。
- **P0-2 断线后进程死亡**（main.cpp）：预创建下一实例模式在 max=1 下必吃 ERROR 231 → 改为
  先 `DisconnectNamedPipe+CloseHandle` 再建（含 231 重试环 20×50ms，首建失败仍 exit=3 保互斥）。
  复验：handshake.ps1 超时后 conn=2 续连；hardcut.ps1 硬断线→重连 ep=2→bye exit=0。
- **P1-1 seek 清 ring 竞态**（audio.cpp DecoderLoop）：read 后 push 前复查 `feedPaused_`，
  命中即丢 chunk continue（调用方随后 reset+seek，丢弃无害），封死 Quiesce 误判静默窗口。
- **P1-2 重采样路 chain 失真**（audio.cpp Negotiated）：`resampled||channelAdapt` 时 decoder 节点
  `passthrough:false` + 新增 `float-convert` 因子（ma_data_converter 内部 f32 中转丢位，M3 信号
  路径图上线前必须诚实）。
- **P1-3 对照表 #7/#35/#37 改实**（本文 §1）+ 本节的"接管期漏修"补记。
- 构建复验：m2-build.ps1 errors=0 warnings(project)=0；三脚本真机全绿。
- reviewer 的 P2 表（trace elapsed 未消费、非常规 WAV probe 保守、hardware 增益措辞、LICENSE 年份、
  superseded 简化等）按信任边界与 M2b/M4 域全部备案不修。
