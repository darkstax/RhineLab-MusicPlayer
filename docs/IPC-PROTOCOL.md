# IPC 协议契约 v1.5（壳 ↔ 音频核心 ↔ 前端桥）

> 状态：v1.5 修订 2026-09-14（M6 只读数据面）· 前版 v1.4（M5 library/lyric）· 配套 `AUDIO-ENGINE.md` §1/§10（D2 路线，见 `DECISION-Q1-HOST.md` §7.6）
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
  "ep": 2,                // 仅核心侧 event 与核心 hello 应答：会话世代，见 §4/§6（v1.2，可选字段）
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
{"v":1,"t":"hello","role":"shell","proto":1,"caps":["cmd","evt.position","evt.state","smtc","library"],"app":"rhine-music-player","ver":"0.1.0"}
```
- 应答方回同构 `hello` 携带自身 `caps`。`proto` 双方取 `min`；`caps` 交集即本次会话能力。
- **会话世代 `ep`（v1.2）**：核心每次 `hello` **成功应答**（即发出 core 角色 hello 帧）时自增进程内
  `epoch`，并在应答帧与后续全部 `evt` 帧携带整数 `ep` 字段（`evt` 见 §6）。`ep` 用于接收侧把
  「`seq` 基线复位」与「核心重启/重连」区分开：`ep` 不变而 `seq` 跳跃 = 丢帧；`ep` 变化 = 新会话，
  接收方复位该通道 `seq` 基线、不记丢帧（吸收审查 P1-B：跨核心生命周期的 seq 倒退不是丢帧）。
  可选字段：`ep` 缺失（旧核心）时接收方以连接重建作为复位基线的唯一时机。壳自身角色帧不发 `ep`；
  壳向核心转发的 `cmd` 不动 `ep`；核心 hello 快照（含 `ep`）经壳聚合 hello 的 `core` 字段透传给前端。
- **壳→前端的 hello 为聚合帧**（审查 P2-5 收编）：除自身 `role:"shell"` hello 字段外，
  壳附加 `state`（ShellChannel 连接态）与 `core`（核心 hello 快照，未连接时为 null）两个
  **本地扩展字段**。约定：扩展字段仅存在于壳↔前端链路，**永不进入壳↔核心管道帧**；
  前端类型化读取（desktop-bridge `HelloResult`），核心实现（M2 的 C++）无需也不得感知。
- **M0 打桩行为**：壳自答一份 stub `hello`（`caps:["echo"]`），并回 `ack` 任何 `t=cmd, cmd="echo"`——用于验证往返。
- 3s 内未完成握手，双方视连接失败重试（指数退避，封顶 5s，musicfox 同源参数）。

## 5. `cmd` 命令表（`payload` 内 `cmd` 字段选择；参数省略=保持现状）

M0-M6 增量启用；未实现的 cmd 必须回 `err{code:"not_implemented"}`，**不得静默丢弃**。

| cmd | payload 参数 | result | 里程碑 |
|---|---|---|---|
| `echo` | `data:any` | `{data}` 原样 | M0 |
| `engine.state` | — | `{state,track_id,position_ms,duration_ms,...}`（§7 state 快照） | M1 |
| `engine.play` | `{track_id, duration_ms?=180000, position_ms?=0}` | `{stream_token}` | M1 |
| `engine.pause` / `resume` / `stop` / `toggle` | — | `{state}` | M1 |
| `engine.seek` | `{position_ms}`（钳到 [0, duration_ms]） | `{applied_ms}` | M1 |
| `engine.volume` | `{mode:fixed/hardware/integer/float, value?=0..1}` | `{effective:{mode,value}}` | M1 |
| `config.set` 持久化 | 壳侧写 `%APPDATA%\RhineMusic\config.json`（dot-path 键；M2 起迁移 TOML schema，键名不变） | | M1 |
| `engine.preload` / `cancel_preload` | `{track_id}` | `{accepted:bool, reason?}` | M2 |
| `engine.queue` | `{items:[track_id...], head:int}` | `{queue_rev:int}` | M2 |
| `spectrum.on` / `spectrum.off` | —（无参数） | `{enabled:boolean}` | M3（v1.3 启用） |
| `devices.list` | — | `{devices:[{id,name,kind,default,capabilities:{rates:[{rate,bits...}],min_period_ms,mix_format}}]}`（**v1.5 只读面**：枚举+共享能力；exclusive 能力字段 M4 域返回 null） | M6 |
| `library.quarantine` | `{limit?=100}` | `{items:[{path,reason,mtime,size,seen_at}]}`（v1.5，壳侧自答只读） | M6 |
| `devices.select` | `{id, mode:auto/shared/exclusive}` | `{negotiated:{...}}`（§8） | M3 |
| `output.mode` | `{mode, buffer_ms?, auto_expand_buffer?, buffer_max_ms?}` | `{negotiated}` | M4 |
| `config.get` / `config.set` | `{path:"output.buffer_ms", value}` | `{value}`（生效值，可能被钳制） | M1 |
| `library.scan` | `{roots?:[path], full?:bool}`（缺省=config 根；full=忽略 mtime 增量） | `{scanned,added,updated,removed,failed,elapsed_ms}` | M5（v1.4 定形；**壳侧自答**，不经核心） |
| `library.query` | `{q?, scope?:"tracks"\|"albums", filter?:{genre?,year?,artist?,album?}, sort?:"title"\|"artist"\|"album"\|"year"\|"duration"\|"added", offset?=0, limit?=200}` | `{total, items:[TrackDto\|AlbumDto]}`（形状见 §5.1） | M5 v1.4 |
| `library.albums` | `{genre?, limit?}` | `{total, items:[AlbumDto]}` | M5 v1.4 |
| `library.get` | `{id:int}` | `{TrackDto, album:AlbumDto, lyric_text:string\|null}` | M5 v1.4 |
| `library.stats` | — | `{albums,tracks,genres,roots,last_scan_ms,quarantine}` | M5 v1.4 |
| `lyric.show` | `{primary:string, secondary?:string}`（前端歌词行上行；空串=清除） | `{delivered:bool}`（管道未启用时 false 不报错） | M5 v1.4（**壳侧自答**→任务栏 writer） |
| `taskbar.set` | `{enabled:bool, pipe?:string}` | `{connected:boolean}` | M5 v1.4（壳侧自答） |
| `diag.get` | — | **v1.5 只读面（M6）**：`{underruns,reopens,buffer_ms_now,period_ms,link:<negotiated 同构>}`；`fallback_history` 属 M4 域返回 `null` | M6 |

### 5.1 TrackDto / AlbumDto（v1.4 定形，字段不多不少）

```jsonc
// TrackDto
{ "id":12, "title":"…", "artist":"…", "album":"…", "genre":"World", "year":1999,
  "track_no":1, "disc_no":1, "duration_ms":253000, "codec":"FLAC", "sample_rate":44100,
  "bit_depth":24, "channels":2, "bitrate":900000, "cover_key":"sha1:…",
  "lyric_state":"embedded|sidecar|none", "path":"C:\…" }
// AlbumDto
{ "album_key":"sha1:…", "title":"…", "artist":"…", "year":1999, "genre":"World",
  "disc_count":1, "track_count":10, "duration_ms":2687000, "cover_key":"sha1:…",
  "formats":["FLAC"], "bitrate_range":[258000,282000],
  "resolution":{"lossy":false, "sample_rate":44100, "bit_depth":24} }
```
封面取回：`https://cover.rhine.local/<cover_key 冒号换横杠>.jpg|png`（WebView2 虚拟主机映射
`%LOCALAPPDATA%\RhineMusic\covers`，壳侧 `SetVirtualHostNameToFolderMapping`，零 IPC 载荷）。
`engine.play` 的 `track_id` 新增 **`lib:<track_id>`** 前缀：壳查 DB 解析为 `file:<绝对路径>` 后
转发核心（核心 scheme 面零改动）；解析失败回 `bad_request{unknown lib id}`（壳侧产生）。

## 6. 事件 `evt`（`payload.kind` 选择）

| kind | 频率 | payload 摘要 |
|---|---|---|
| `state` | 变更即发 | `{state:idle/playing/paused/stopped, track_id?, position_ms?, duration_ms?, volume?, negotiated, badges:{exclusive,bit_perfect,app_perfect,factors:[]}}`（M1 桩允许 negotiated/badges 为 `null`=引擎未接入） |
| `position` | 1Hz + 状态变更时 | `{position_ms, frames, rate, buffered_ms, drift_ms}` |
| `transition` | 无缝切曲时 | `{old_id, new_id, at_frames, at_ms}` |
| `spectrum` | 30Hz（订阅开关 `spectrum.on/off`，§5；默认 off，无消费者不产出） | `{bands_l[64], bands_r[64], low, mid, high, activity, beat_phase}`（payload v1.3 定形，见下） |
| `diag` | 计数变更/1Hz | `{underruns(+delta), buffer_ms_now, reopened, last_fallback}` |
| `error` | 即时 | `{where, code, message, retryable, degraded_to?}` |
| `library`（**壳侧产生**） | 扫描阶段（非周期；progress ≤1Hz） | `{phase:"start"\|"progress"\|"done", scanned, total, quarantine}` |
| `log`（壳侧） | — | 不转发前端，仅进环形缓冲与日志文件 |

- **spectrum payload 定形（v1.3 / M3）**：
  - `bands_l` / `bands_r`：各 64 个 float，0..1 归一（对数 64 带，60Hz..min(16kHz, Nyquist)；
    核心侧 FFT 1024/Hann + 主 bin 相位谱，规格移植 musicfox `spectrum.go`，见 AUDIO-ENGINE §10）；
    数值统一保留 4 位小数（控制帧体积 ≈1KB/帧、30Hz）；
  - `low` / `mid` / `high`：64 带聚合（对前端 `MusicBands` 语义）：`low`=带 0–7、`mid`=8–31、
    `high`=32–63 的 RMS（L/R 均值的带组合），0..1；
  - `activity`：全 64 带均值（0..1），上游用于呼吸淡出判定；
  - `beat_phase`：低频包络相位 0..1——0 = 准拍点（低频包络上升沿刚触发），随时间向 1 推进，
    下一次上升沿复位；超过两倍平均击间隔无新触发则冻结在 1（简化包络检测，非严格 BPM）。
  - 频率纪律：`spectrum.on` 后核心以 30Hz（±5Hz）连续发帧；`spectrum.off` 或无活动连接即停发。
    非 playing（无新音频）时 target 回落，帧仍按 30Hz 发出直至全零后保持发零帧（订阅期内频率恒定，
    接收端无需超时推断）。实现侧细节（桩假谱参数、核心 tap 线程模型）见 `docs/M3-FINDINGS.md`。
- **position 权威源是设备时钟**（AUDIO-ENGINE §9）；UI 本地外推，收广播偏差 >40ms 起 200ms 平滑收敛。
- 事件是**可丢的**（`evt` 带 `seq`，丢帧可检测）；`state` 例外：壳/核心对 `state` 做可靠合并（后值覆盖，断线重连必补发最新快照）。
- **v1.2**：核心发出的每一帧 `evt` 顶层携带可选 `ep`（会话世代，§4）。接收侧丢帧检测规则：
  每通道记录 `(ep, last_seq)`；`ep` 与上帧不同 → 复位基线（本帧只记 `last_seq`，不计丢失）；
  `ep` 相同且 `seq > last_seq + 1` → 计入 `framesLost += seq - last_seq - 1`。
  `seq ≤ last_seq` 视为乱序/重复，只丢帧不计数。

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
| `library_busy` | 扫描进行中收到写类库命令 | 是 |
| `library_unavailable` | DB 打不开/损坏（UI 提示重建） | 否 |
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
- v1.1（2026-09-12，M1 前）：§4 收编壳聚合 hello（P2-5）；§5 M1 引擎命令参数定形（duration_ms、
  volume.effective 对象化、config 持久化落点）；§6 state 事件补 idle/playing/paused/stopped 枚举与
  M1 桩的 negotiated=null 豁免。帧语法与 v1.0 兼容，proto 仍为 1。
- v1.2（2026-09-12，M1）：§4/§6 新增会话世代 `ep`（核心 hello 应答自增并随全部 `evt` 携带）；
  §6 明确接收侧丢帧检测规则（`ep` 变化复位 seq 基线，吸收 P1-B 的跨生命周期 seq 倒退语义）。
  帧语法向后兼容，旧接收方忽略 `ep` 即可，proto 仍为 1。
- v1.3（2026-09-13，M3）：§5 启用 `spectrum.on/off`（result `{enabled}`，默认 off）；§6 spectrum 行
  payload 定形（bands_l/bands_r 各 64 float 四位小数、low/mid/high 聚合带界、activity、beat_phase
  语义）；核心侧 `spectrum` 声明进 caps（真核心与桩同步）。帧语法向后兼容，proto 仍为 1。
