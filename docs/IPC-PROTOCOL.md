# IPC 协议契约 v1（壳 ↔ 音频核心 ↔ 前端桥）

> 状态：v1.0 定稿 · 2026-09-12 · 配套 `AUDIO-ENGINE.md` §1/§10（D2 路线，见 `DECISION-Q1-HOST.md` §7.6）
> 本文件是三方（WPF 壳、C++ 核心、TS 前端桥）的**唯一消息格式权威**；改协议必须改本文并升 `proto`。

## 1. 拓扑与传输

```
WebView 前端 ──(WebView2 postMessage / WebMessageReceived)── WPF 壳 ──(命名管道)── C++ 核心
```

- **壳 ↔ 核心**：Windows 命名管道，字节流模式（`PIPE_TYPE_BYTE | PIPE_READMODE_BYTE`），
  UTF-8 **JSON Lines**（`\n` 结尾，单行 ≤64KB）。
  管道名：`\\.\pipe\rhine-music.core.v1`（可被 `core.pipe` 配置覆盖，与 musicfox 任务栏管道错开）。
- **前端 ↔ 壳**：WebView2 原生 `window.chrome.webview.postMessage(string)` /
  `WebMessageReceived`（消息体同样是本文的 JSON 对象，一条消息 = 一次 postMessage；
  无换行约束，但保留 `\n` 兼容以便未来复用管道层解析器）。
- 壳是**前端消息的唯一特权网关**：前端不能直连核心管道。
- 音频样本流**永不**进入任何 IPC（AUDIO-ENGINE 公理 1/2）。

## 2. 帧格式（全消息通用字段）

```jsonc
{
  "v": 1,                 // 协议大版本；接收方遇不匹配应回 error{code:"proto_mismatch"} 后保持最小可用
  "t": "<type>",          // 见 §3
  "id": "c-17",           // 仅 request/response：调用方生成的不透明字符串，响应原样回带
  "seq": 1234,            // 仅 event：发送方单调递增（每通道独立），接收方用于丢帧检测
  "ts": 1699790000123     // 可选，发送方 epoch ms（诊断用，不作时钟同步依据——进度同步用 §6）
}
```

- 时间单位约定：**位置/时长一律毫秒整数**（`ms`），样本数一律 `frames` 且伴随 `rate`。
- 标识符（device id、track id、pipe name）一律字符串；设备 id 使用 `MMDevice.ID`（endpoint 格式，含 `{0.0.0.00000000}.` 前缀）。

## 3. 消息类型总表

| t | 方向 | 语义 |
|---|---|---|
| `hello` | 双向（连接首帧） | 版本与能力协商，§4 |
| `cmd` | 前端→壳→核心 | 命令请求，带 `id`，§5 |
| `ack` | 反向 | 命令成功响应 `{id, result}` |
| `err` | 反向 | 命令失败响应 `{id, error:{code, message, retryable}}` |
| `evt` | 核心→壳→前端 | 事件推送，带 `seq`，§7 |
| `log` | 核心→壳（不转发前端） | 结构化日志行 `{level, msg, ...fields}` |
| `bye` | 双向 | 有序关闭 `{reason}` |

## 4. 握手 `hello`

- 发起方为**连接建立方**（壳连核心；前端页面加载后向壳发）。
```json
{"v":1,"t":"hello","role":"shell","proto":1,"caps":["cmd","evt.position","evt.state","smtc"],"app":"rhine-music-player","ver":"0.1.0"}
```
- 应答方回同构 `hello` 携带自身 `caps`。`proto` 双方取 `min`；`caps` 交集即本次会话能力。
- **M0 打桩行为**：壳自答一份 stub `hello`（`caps:["echo"]`），并回 `ack` 任何 `t=cmd, cmd="echo"`——用于验证往返。
- 3s 内未完成握手，双方视连接失败重试（指数退避，封顶 5s，musicfox 同源参数）。

## 5. `cmd` 命令表（`payload` 内 `cmd` 字段选择；参数省略=保持现状）

M0-M6 增量启用；未实现的 cmd 必须回 `err{code:"not_implemented"}`，**不得静默丢弃**。

| cmd | payload 参数 | result | 里程碑 |
|---|---|---|---|
| `echo` | `data:any` | `{data}` 原样 | M0 |
| `engine.state` | — | `{state,track_id,position_ms,...}`（§7 state 快照） | M1 |
| `engine.play` | `{track_id, position_ms?}` | `{stream_token}` | M1 |
| `engine.pause` / `resume` / `stop` / `toggle` | — | `{state}` | M1 |
| `engine.seek` | `{position_ms}` | `{applied_ms}` | M1 |
| `engine.volume` | `{mode:fixed/hardware/integer/float, value?}` | `{effective}` | M1 |
| `engine.preload` / `cancel_preload` | `{track_id}` | `{accepted:bool, reason?}` | M2 |
| `engine.queue` | `{items:[track_id...], head:int}` | `{queue_rev:int}` | M2 |
| `devices.list` | — | `{devices:[{id,name,kind,default,exclusive:{rates:[{rate,bits...}],min_period_ms,mix_format}}]}` | M3 |
| `devices.select` | `{id, mode:auto/shared/exclusive}` | `{negotiated:{...}}`（§8） | M3 |
| `output.mode` | `{mode, buffer_ms?, auto_expand_buffer?, buffer_max_ms?}` | `{negotiated}` | M4 |
| `config.get` / `config.set` | `{path:"output.buffer_ms", value}` | `{value}`（生效值，可能被钳制） | M1 |
| `library.scan` / `library.query` | （M5 定形，先占名） | | M5 |
| `taskbar.set` | `{enabled, pipe?}` | `{connected:boolean}` | M5 |
| `diag.get` | — | `{underruns,reopens,fallback_history:[...],link:{...}}` | M4 |

## 6. 事件 `evt`（`payload.kind` 选择）

| kind | 频率 | payload 摘要 |
|---|---|---|
| `state` | 变更即发 | `{state, track_id, duration_ms, negotiated, badges:{exclusive,bit_perfect,app_perfect,factors:[]}}` |
| `position` | 1Hz + 状态变更时 | `{position_ms, frames, rate, buffered_ms, drift_ms}` |
| `transition` | 无缝切曲时 | `{old_id, new_id, at_frames, at_ms}` |
| `spectrum` | 30Hz（可订阅开关 `spectrum.on/off`） | `{bands_l[64], bands_r[64], low, mid, high, activity, beat_phase}`（float 归一 0..1；上游 `MusicBands` 直接消费） |
| `diag` | 计数变更/1Hz | `{underruns(+delta), buffer_ms_now, reopened, last_fallback}` |
| `error` | 即时 | `{where, code, message, retryable, degraded_to?}` |
| `log`（壳侧） | — | 不转发前端，仅进环形缓冲与日志文件 |

- **position 权威源是设备时钟**（AUDIO-ENGINE §9）；UI 本地外推，收广播偏差 >40ms 起 200ms 平滑收敛。
- 事件是**可丢的**（`evt` 带 `seq`，丢帧可检测）；`state` 例外：壳/核心对 `state` 做可靠合并（后值覆盖，断线重连必补发最新快照）。

## 7. 错误码表（`err.error.code`）

| code | 语义 | retryable |
|---|---|---|
| `proto_mismatch` | 版本协商失败 | 否（升级提示） |
| `not_implemented` | 能力缺失（caps 未声明却被调用） | 否 |
| `bad_request` | 参数非法（含越界钳制失败） | 否 |
| `device_busy` | 目标设备被占（独占协商失败的分类之一） | 是（已自动降级时可继续） |
| `device_gone` | 设备拔出/默认变更竞态 | 是（自动迁移后重试） |
| `decode_failed` | 解码器打开/读取失败（附 `track_id`） | 是（跳曲策略见 AUDIO-ENGINE §14） |
| `stream_restart` | 需重开流（采样率切换），**信息性** | 自动处理 |
| `internal` | 未分类核心异常 | 视上下文 |

## 8. `negotiated` 对象（协商事实，单一事实源）

```json
{
  "share": "exclusive | shared-event",
  "backend": "wasapi | alsa-direct | null",
  "format": {"rate": 96000, "bits_container": 32, "bits_valid": 24, "encoding": "pcm", "channels": 2},
  "buffer_ms": 10, "period_ms": 3, "auto_expanded": false,
  "chain": [ {"node":"decoder","detail":"dr_flac i24","passthrough":true},
             {"node":"resample","passthrough":true},
             {"node":"volume","mode":"fixed","passthrough":true} ],
  "fidelity": "bit-perfect | app-perfect | processed",
  "factors": []          // 破坏位完美的因子枚举，来自 FidelityAssessor（AUDIO-ENGINE §13）
}
```
- 徽章/信号路径图/诊断页**全部**渲染此对象；任何 UI 文案不得自行推断保真状态。

## 9. 连接与生命周期

- 壳启动 → 拉起核心（或连接已存在的管道）→ `hello`。断线：壳指数退避重连，核心**单实例互斥**（第二实例 `hello` 后收 `bye{reason:"superseded"}` 自杀，配合单实例锁）。
- 壳退出前发 `bye`，核心释放设备句柄并退出（子进程模式）；核心崩溃时壳按 `max_play_err_count` 策略重启核心（上限 3 次后 UI 报错页）。
- 页面刷新（WebView 重载）不动核心：前端重连后由壳重放最新 `state` + `hello`（壳缓存最近一份）。

## 10. 安全与信任边界

- 命名管道 ACL：仅当前用户 SID 可连（`PIPE_REJECT_REMOTE_CLIENTS`）。
- 本项目信任边界内（自家进程互连），**不做**载荷级注入防御；对端非法帧的处理义务仅限：不崩溃、计数（`diag`）、丢弃或回 `bad_request`。
- 前端桥（`desktop-bridge.ts`）对来自 `WebMessageReceived` 的字符串先 `JSON.parse` try-catch 再入状态机。

## 11. 版本史

- v1.0（2026-09-12）：M0 定稿——hello/cmd/ack/err/evt/bye + echo/state 最小集；其余 cmd 先占名后启用。
