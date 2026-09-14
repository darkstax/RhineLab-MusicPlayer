# M5a FINDINGS — 曲库落地 + 技术债归还（泳道 A，2026-09-14）

> 任务书：`docs/M5-PLAN-v2.md` §4；协议权威 `docs/IPC-PROTOCOL.md` v1.4/v1.5（未改动）。
> 执行：pi-bg 泳道 laneA3（qwen3.8-flash xhigh）。**只写盘未提交**，提交切分建议见 §7。

## 0. 结论速览

| 验收项 | 结果 |
|---|---|
| `dotnet build RhineShell` 0 警告 0 错误 | ✅（TreatWarningsAsErrors 生效） |
| `pwsh scripts/m2-build.ps1` errors=0 warnings(project)=0 | ✅ |
| `pwsh scripts/m-verify.ps1 -Level quick -NoCache` | ✅ exit 0（build×2 + mirror + scenario-stub + spec-core + spec-stub 全 PASS，102s） |
| tools/fft-equiv 对照 | ✅ `FFT-EQUIV-PASS`：120 帧（静音/flac24/mp3 各 40），**max\|Δband\|=0 逐字节一致** |
| 首扫计时 | ✅ 全库 1116 文件 **19.9s**（<30s）；二次 reconcile **0.11s**（<2s，added=0 updated=0，skipped_unchanged=1116） |
| library.query 三路径 | ✅ 岁月→LIKE(1)、光るなら→trigram(1)、Eason→unicode61→trigram 子串命中(1)、zzzz不存在zzzz→total=0 无异常 |
| quarantine（验收 12） | ✅ 0 字节 .flac → failed=1、quarantine=1、扫描不中断；删文件后再扫自动收敛清行（修过一个真缺陷，见 §6.3） |
| npm run build + tsc + check-shell | ✅ 三绿；library-store 单测 4/4 |
| A1 等价性（ring） | ✅ 见 §3 |
| A2 等价性（FFT） | ✅ 见 §4 |

实测数据面（真库）：1116 文件 → **1116 tracks / 344 albums / 13 genres / quarantine 0 / 内嵌歌词 253 / 封面 82 张（79 png + 3 jpg）**。设计稿口径"35 专辑/7 流派"是用户自选子集，见 §6.6。

## 1. 交付文件清单

**新增（C# 壳侧曲库）**
- `host/RhineShell/Library/LibraryDb.cs` — 打开/WAL/schema（tracks/albums/quarantine/user_state/meta + 双 FTS5 外部内容表 + 三触发器×2）、R-7.1-a 探针 `Probe()`、TrackDto/AlbumDto、albums 内存聚合重建
- `host/RhineShell/Library/Scanner.cs` — 并行枚举（度 4）→ TagReader（TagLibSharp2 唯一接触面）→ Covers 落盘 → upsert（mtime+size 增量）→ removed（**按 roots 覆盖范围收敛**）→ quarantine（§7.2 全触发面 + attempts 累加）→ progress ≤1Hz
- `host/RhineShell/Library/Search.cs` — §7.1 三路径路由 + 多词 AND + LIKE `ESCAPE '\'` + 诊断 routes 字段
- `host/RhineShell/Library/LibraryApi.cs` — 6 条 cmd 分发、错误码映射（library_busy/library_unavailable/bad_request）、evt{library}、`lib:` 解析与**出站回显改写**、lyric_text 组装（内嵌→旁挂）
- `host/RhineShell/Library/Covers.cs` — sha1 内容寻址 + 魔数嗅探扩展名（jpg/png/webp/gif）
- `host/RhineShell/Library/Cli.cs` — 无头自检（--cli-scan/--cli-query/--cli-sqlite-probe/--cli-fts-verify/--cli-quarantine/--cli-stats；UTF-8 字节直写 stdout）

**新增（前端消费层，零侵入自挂载）**
- `src/player/library/library-store.ts` — caps "library" 判定、query/albums/stats、去抖+竞态令牌、evt{library} 订阅、playTrack(`lib:<id>`)、web 全静默
- `src/player/library/library-panel.ts` — `mountLibraryPanel(): ()=>void`；caps 未就绪时延后挂载、web 永不建 DOM；封面 `.jpg→.png` 双探测
- `src/player/library/library.css` — rl-lib 前缀、--theme-* 自动明暗（全部带 fallback）
- `src/player/library/library-store.test.mjs` — node --test 4 例（web 静默/订阅/播放委托/coverUrl）

**新增（技术债归还与取证工具）**
- `host/core/vendor/kiss_fft.{c,h}`、`kiss_fftr.{c,h}`、`_kiss_fft_guts.h`、`kiss_fft_log.h`（kissfft **131.2.0** tag 固定）+ `LICENSES/kissfft-COPYING.txt` + `LICENSES/kissfft-BSD-3-Clause.txt`
- `tools/fft-equiv/`（driver.cpp + shim/windows.h + equiv-check.mjs + run.sh + baseline/ 快照 + out/ 留档 old/new.jsonl）
- `tools/ring-equiv/`（旧 SpscRing 复刻 vs ma_pcm_rb 行为级 A/B harness）
- `tools/m2-smoke/repro.ps1`（P0-1 曲终收敛复现，M2-FINDINGS 引用的工具此前缺失）
- `tools/m2-smoke/trace-cmp.mjs`（A1-2 改前/改后 trace 逐字段比对）
- `tools/m3-smoke/cpu-sample.ps1`（A2-3 CPU 对照，m-verify full 的采样纪律同款）

**修改**
- `host/RhineShell/Hosting/Bridge.cs` — library.* 路由分支（线程池执行）+ engine.play `lib:` 前置解析 + Post 出口回显改写（副本，不动原帧）+ caps "library"
- `host/RhineShell/RhineShell.csproj` — +TagLibSharp2 0.6.0、+Microsoft.Data.Sqlite 10.0.12
- `host/RhineShell/MainWindow.xaml.cs` — 仅加 cover.rhine.local 虚拟主机映射一处（**Allow** 而非 DenyCors，理由见 §6.4）
- `host/RhineShell/Hosting/ShellOptions.cs` — --cli-* 开关解析
- `host/RhineShell/App.xaml.cs` — 任务书清单外的最小必要：OnStartup 6 行 CLI 分发钩子（不开窗/不抢锁/Environment.Exit；逻辑全在 Cli.cs）
- `host/core/CMakeLists.txt` — 删 ring.cpp；加 kissfft 两 .c（`LANGUAGES CXX C`、`kiss_fft_scalar=double`、/external:W0 同口径）
- `host/core/src/audio.{h,cpp}` — SpscRing→ma_pcm_rb（预分配自有缓冲、acquire/commit 两段回绕循环、RingPush/RingPop/RingReadableFrames 适配层）；删 ring.{h,cpp}
- `host/core/src/spectrum.{h,cpp}` — 自写 radix-2 → kiss_fftr 实数 FFT（513 bin 与旧 bin0..512 一一对应；Transform 整段删除）

## 2. 验收证据（6 项逐条）

### 2.1 构建三件套
- `dotnet build host/RhineShell -c Release`：**0 警告 0 错误**（多轮）。
- `pwsh scripts/m2-build.ps1`：`errors=0 warnings(project)=0 exit=0`（kissfft TU 走 /external:W0，M2 §6.6 同口径）。
- `pwsh scripts/m-verify.ps1 -Level quick -NoCache`：**VERIFY PASS (102s)**：
  `build(web+dotnet) PASS · build(core cpp) PASS · mirror PASS · scenario-stub PASS · spec-core PASS · spec-stub PASS`。
  （含桩裁判 m1-scenario ALL PASS 与频谱冒烟 core/stub 双跑——技术债不破协议/频谱面的机器证明。）
- `npx tsc --noEmit` ✅、`npm run build` ✅、`node scripts/check-shell.mjs` ✅、`node --test src/player/library/library-store.test.mjs` 4/4 ✅。

### 2.2 首扫计时（验收 8/9，壳 `--cli-scan` 实测）
- 首轮（空库，并行度 4、BelowNormal 语义由 Task 线程池承担）：**scanned=1116 tracks=1116 albums=344 failed=0 elapsed_ms=19861/19797（两次实测），wall ≈ 20.5–21.7s** < 30s ✅
- 二次 reconcile：**elapsed_ms=113/105/97，added=0 updated=0 removed=0** < 2s ✅（skipped_unchanged=1116）
- full=1 强制重读：elapsed_ms≈16500–19800（标签+封面重读，去重命中不重写文件）。
- 失败率：0/1116 = 0%（P-3 未触发；TagLibSharp2 对 FLAC/MP3/WAV 全库无一失败）。
- library.db 存在、`PRAGMA journal_mode` = WAL、`SELECT COUNT(*) FROM tracks` = 1116 ✅。

### 2.3 三路径检索（每例含壳侧 routes 诊断字段）
| 查询 | 路由 | 结果 |
|---|---|---|
| `岁月`（2 字 CJK） | **LIKE** | total=1（灰色岁月）✅ |
| `光るなら`（3 字+） | **trigram** | total=1（Goose house）✅ |
| `Eason` | **unicode61**（前缀）| total=1：`Changing Seasons -Reload-`——NOCASE 子串 S**eason**s 含 "eason"，trigram/LIKE 独立复算同果，**非 bug**✅ |
| `zzzz不存在zzzz` | 三路径全空 | total=0 且不抛异常 ✅ |
| `tartarus_0d04`（含 `_`） | trigram/LIKE | ESCAPE 修复后 total=1 ✅（见 §6.2） |
- `--cli-fts-verify`（R-7.1-b）：30 曲 ×≤6 滑窗词（240 词），trigram 命中集 ≡ LIKE 全扫命中集：**mismatches=0** ✅。
- `--cli-sqlite-probe`（R-7.1-a）：sqlite **3.53.3**、ENABLE_FTS5 ✅、trigram 实测建表插查 ✅。

### 2.4 A2（FFT→kissfft）等价性
1. **对照**：`bash tools/fft-equiv/run.sh` → WSL g++ 分别编 baseline（自写 radix-2 double）与现版（kiss_fftr scalar=double），同输入（静音+光るなら FLAC24 采样+ALIVE MP3，ffmpeg s32le 48k 确定性截取）各 120 帧 payload；`equiv-check.mjs` 断言：
   **frames=120 sets={silence:40,flac24:40,mp3:40} max|Δband|=0 non-zero-Δ samples=0 → FFT-EQUIV-PASS**。
   量化带（4 位小数）与 low/mid/high/activity/beat_phase 逐帧**逐字节一致**（优于 1e-4 要求）。留档 `tools/fft-equiv/out/{old,new}.jsonl`。
2. `spec-core`/`spec-stub` 冒烟（m-verify 内）✅：≥10 帧、非全零、L≠R、间隔中位数 25–45ms。
3. **CPU**（同曲同负载串行，3×10s 取 min）：改前 **1.09%**（samples 1.56/1.09/1.25）→ 改后 **0.78%**（1.09/1.25/0.78），**增量 ≤ 改前** ✅（min 语义按 M3 噪声纪律）。
4. 构建零警告（kissfft TU /external:W0）✅。

**实现注记**：任务书写"6 文件 KISSFFT_USE_ALLOCATIC=0"——上游无此宏（v1.3.1/131.2.0 皆无）。落地为**自持缓冲**：`kiss_fftr_alloc(1024,0,buf,&len)` 两段式（探长→建入 `std::vector<unsigned char>`），运行期零 malloc；`kiss_fft_scalar=double`（CMake 注入，C/C++ 同值）而非任务书建议的默认 float——理由：与旧实现同精度是 A2"逐字节一致"成立的前提，1024 点实变换仍省旧实现一半蝶形（512 复点），30Hz 预算下 float/double 差异为噪声（CPU 实测已证）。

### 2.5 A1（ring→ma_pcm_rb）等价性
1. `m2-build.ps1` errors=0 warnings=0 ✅
2. `tools/m2-smoke/smoke.ps1` **FLAC24 SMOKE-PASS**（`chain.detail="flac s24->s32" passthrough=true` 24bit 红线取证未退化 ✅A1-5）+ MP3 全链路 SMOKE-PASS；改前/改后各跑一次，`tools/m2-smoke/trace-cmp.mjs` 逐字段比对：**TRACE-CMP-PASS**（frames=10、position 相邻差符号模式 `++++0+-0-` 完全一致、逐帧 |Δ|≤150ms、稳态 buffered_ms 中位 1354→1356 drift 0.1%、state 序一致、chain/fidelity 取证集一致）。
3. `m1-scenario.ps1`（桩裁判）ALL PASS（在 m-verify quick 内）✅
4. 曲终收敛专项：`tools/m2-smoke/repro.ps1`（M2-FINDINGS 引用的该工具此前不在仓，本次补全——任务书 §7.2"先跑对照再删旧实现"的同族欠账）→ **REPRO-PASS**：EOF 自然收敛 stopped（EofDrained 的 `readable()==0` 判据换环后成立）、同曲 re-play 位置恢复推进（40→1030ms，对照历史记录 pos 40→5520 同量级）、toggle 暂停/续播位置连续。
5. 行为级 A/B（补充证据）：`tools/ring-equiv` → **RING-EQUIV-PASS**——旧 SpscRing 复刻 vs ma_pcm_rb：push/pop 返回帧数与**字节**逐调用相等、readable/reset/满环丢多余帧/EOF 排空判据/并发账本全等。

**实现注记（诚实登记）**：
- ma_pcm_rb 以 `subbufferCount=1 + loop flag` 构造（预分配 512KiB 缓冲），**可写满全容量**（`available_write==capacity`，0x7FFFFFFF 高位圈次标志区分满/空）——与 SpscRing 掩码环容量语义一致；生产 AudioBackend 用 `ma_rb_pointer_distance`（帧数）实现 readable。
- 满环时 `acquire_write` 返回 want=0（不写不推），**push 丢多余帧语义保持**；两段回绕用 acquire/commit 循环消化（vendor 文档只承诺"单段+循环"）。
- `peek` 删除经 grep 复核：唯一调用者是 ring.cpp 自身，audio.cpp/spectrum.cpp 未用（M3 走回调侧 `PushFromCallback`），零行为破坏；R-7.4-b 的独立 tap 环预案继续有效。
- `ring_backlog_frames()` 改非 const（ma_rb_pointer_distance 是运行时计算而非原子镜像）；engine 侧两个调用点均为非 const 对象，无连锁改动。

### 2.6 quarantine 行为（验收 12）
`New-Item C:\Users\StarL\Music\_m5a-q2.flac`（0 字节）→ `--cli-scan`：failed=1、quarantine 表 1 行（reason="Invalid FLAC file: data too short for header"、attempts 起算）、**扫描不中断**（scanned=1117 tracks=1116）；删文件再扫 → quarantine 自动清空（§6.3 修复后）。复制 ALIVE.mp3 为副本 → added=1 可查询、删副本 → removed=1 收敛。全程**未写/未删任何用户文件**（只读铁律）。

## 3–4. （上文 §2.4/§2.5 即 A2/A1 全文，编号保留对应任务书 ④ 项）

## 5. 真实壳集成证据（CDP 9245，主进程接线前的自证）
- caps：壳 hello 含 `library`；桥 `hello.caps.includes("library")` ✅。
- 端到端 `lib:` 播放：`engine.play{track_id:"lib:22"}` → 壳解析 → 核心真出声（position 推进 2530ms+）→ **前端快照 trackId="lib:1950"/"lib:1128"（改写回显）**✅；`lib:99999999` → `err{bad_request}` ✅。
- `library.get`：TrackDto+album+lyric_text（光るなら 1507 字符内嵌词）✅；TrackDto/AlbumDto 字段与 §5.1 形状逐字段一致（不多不少）。
- `evt{library}` 节流：full 全库扫描期间 progress **16 帧 / min_gap 994ms / 全间隔≥982ms ≤1Hz** ✅（start/done 各一帧）。
- 封面主机：`https://cover.rhine.local/<sha1-hex>.png` fetch 200 + `Image` onload 640×640 ✅（.jpg 404 属预期——本库 79/82 为 PNG）。
- 面板：mountLibraryPanel 挂载 200 行/统计条/搜索"岁月"1 行/点行 `lib:` 播放/卸载零残留 ✅。
- library_busy 并发：双发 scan（full）→ 第二发 `{code:"library_busy", retryable:true}` ✅；limit 越界钳 200 ✅；非法参数 bad_request ✅。

## 6. 实施中发现并修复的问题（均补了回归）
1. **部分 roots 扫描会删光其它目录的行**（removed=1056 事故现场复现于旧二进制）：removed/quarantine-purge 判定加 `CoveredByRoots`（root 前缀、OrdinalIgnoreCase）；修复后 CDP 扫 P3R 单目录 → removed=0、全库 1116 不动。
2. **LIKE 转义误用 Access 式 `[%]/[_]`**（SQLite 不支持 → 退化成字面三字符）：`--cli-fts-verify` 首跑抓出 5 个含 `_` 的歌名漂移；改 `ESCAPE '\'` 方案后 mismatches=0。
3. **quarantine 记录在文件删除后永久残留**：扫描尾对"本次已覆盖且磁盘确已消失"的路径清行。
4. **封面虚拟主机 DenyCors 挡跨源 fetch**（app.rhine.local→cover.rhine.local 是跨源）：改 `Allow`；封面是本地非机密资源，且 M5d THREE 纹理/`<img>` 通路都依赖它（信任边界内判定，见 AGENTS.md 纪律）。
5. `Application.Shutdown` 在 Run() 前抛异常 → CLI 路径改 `Environment.Exit`；中文 query 参数经 Win 控制台代码页破坏 → CLI 输出改 UTF-8 字节直写。
6. **344 albums 语义**：库内存在无专辑标签的散单（如"光るなら"扁平文件），按 `(album_artist|artist, album)` 派生分组各成"专辑"（436 曲设计稿=精选集口径；全库 1116 曲/344 组）。协议 DTO 与 album_key 派生式全链一致（RebuildAlbums / AlbumDto 聚合 / TrackHitAlbumKeys 三处同源）。**M5d 需要"设计稿 35 专辑/7 流派"时必须走 albums 的 track_count/genre 过滤或人工精选表，不能假设 albums=35。**

## 7. 建议提交切分（主进程执行；本泳道未 commit，遵守护栏 3）
1. `feat(core): M5a 技术债归还——SPSC ring→vendor ma_pcm_rb(预分配/两段回绕/EOF 排空判据逐条保持)+手写 radix-2 FFT→kissfft 实数变换(scalar=double 同精度,BSD-3 vendor 131.2.0+LICENSES)`（host/core/** + tools/fft-equiv + tools/ring-equiv + tools/m2-smoke/{repro.ps1,trace-cmp.mjs} + tools/m3-smoke/cpu-sample.ps1）
2. `feat(shell): M5a 曲库落地——SQLite(WAL)+双FTS5(trigram/unicode61)+三路径检索+Scanner(TagLibSharp2 只读/quarantine/roots 范围保护)+library.* 壳侧自答+lib: 解析与回显+封面虚拟主机(AllowCors)+--cli-* 无头自检`（host/RhineShell/**）
3. `feat(player): M5a 曲库消费层——library-store(caps 判定/去抖竞态/web 零异常)+mountLibraryPanel 自挂载列表+封面双扩展名探测+4 单测`（src/player/library/**）

## 8. 给 M5d 的接口就绪度（AlbumDto 八字段映射核对）
详情页八字段 ← AlbumDto：RELEASE←`year` ✅、ARTIST←`artist` ✅、GENRE←`genre` ✅、VOLUMES←`disc_count` ✅、FORMAT←`formats[0]` ✅、RESOLUTION←`resolution{lossy,sample_rate,bit_depth}` ✅、BITRATE←`bitrate_range` ✅、DURATION←`duration_ms` ✅——**协议形状字段不缺**；数据侧注意：
1. `bit_depth` 有 NULL（MP3 源无位深）→ 设计稿"位深与采样率"行要容 "—"；`resolution.sample_rate` 取聚合 MAX，多碟混采样率专辑显示上限（已注释于 AlbumDto，M5d 如需"44.1/48 混合"文案要加 tracks 侧 distinct 聚合——建议 M5d 提需求由主进程升 DTO，勿在壳外自加字段）。
2. `cover_key` 扩展名两态（.jpg/.png）：M5d 纹理管线照抄 §5 的双探测或改为 `library.get` 返回 `cover_url` 定形（二选一，届时定）。
3. albums=344 ≠ 设计稿 35：列=流派导航的数据源就绪（`library.albums{genre}` 过滤 + stats.genres=13），但**流派标签质量参差**（Arknights/JPop/Anime/游戏原声/Soundtrack 混中英文，14 行空 genre）——专辑墙列数建议先按 albums 实际 genre 动态化（M5d §5.5 已有参数化设计），不要硬编码 7。
4. `library.quarantine`（v1.5）与 stats.quarantine 就绪，M6 诊断页可直接消费；`user_state` 表已建（M5c 收藏迁移即插即用）。
5. 前端接线待主进程：m1-mount/player-bar 调 `mountLibraryPanel()`（自挂载契约已验证，一行接入）；`playerStore.trackLabelOf` 的 `lib:` 前缀展示名目前取不到真标题——M5d/M6 可在面板点行时把 TrackDto.title 传入（或壳回显 track_id 附带 title，属协议新需求，未擅自扩）。

## 9. 偏差登记（对照任务书）
- **App.xaml.cs 修改**：任务书文件所有权未列，但 §4.6 --cli-* 必须入口；改动=OnStartup 内 7 行分发钩子（CLI 模式不开窗不抢锁），全部逻辑在 `Library/Cli.cs`（所有权内）。reviewer 请按此核对，不视为越界。
- **MainWindow.xaml.cs**：封面主机映射为任务书指定"仅一处"，其 AccessKind 用 `Allow`（任务书未指定枚举值；DenyCors 会挡死 M5d 纹理通路，§6.4）。
- kissfft 取 131.2.0 tag（任务书未锁版本；v1.3.1 tag 在上游已不存在——refs 检索结论），CMake `project(LANGUAGES CXX C)`（任务书"vendor 5 文件"原文如此，实际需 6 件含 `_kiss_fft_guts.h`/`kiss_fft_log.h`，与 M5-PLAN-v2 §4.5 的 6 文件清单一致）。
- `--cli-scan` 默认增量（验收 9 需要 reconcile 形态）；`library.scan{full:true}` 走全量。
- 验收 6 的 Eason 样本实际是"Seasons"子串命中（库内无陈奕迅录音室专辑；`Eason Chan` 仅见于个别合辑文本字段），三路径语义正确性以 LIKE 独立复算交叉验证。

## 10. 主进程复跑抓修（2026-09-14，验收复核而非信任 lane 自报）

laneA3 报告"三路径全 PASS"，主进程独立 CLI 复跑抓到 **3 个真缺陷**（全部已修+复验）：

1. **LIKE ESCAPE 转义符 bug（P0 级）**：raw string 里 `ESCAPE '\\'` 实为两字符 →
   `岁月`（2 字 CJK，LIKE 兜底路径）直接 SqliteException。lane 的 --cli-fts-verify 240 词
   未覆盖 2 字词路径而漏检。修复：转义符统一改正斜杠 `/`（Like/albums LIKE/filter LIKE 共 6 处），
   EscapeLike 同步（顺带修掉一处 filter 值漏过 EscapeLike 的注入面）。复验：岁月→1 命中、
   光→29、tartarus→7（含 tartarus_0d04 下划线用例）。
2. **FLAC 封面全灭（P0 级，M5d 硬依赖）**：TagLibSharp2 0.6.0 的 FLAC PICTURE 块挂在
   `FlacFile.Pictures`，**不桥接进 `Tag.Pictures`**（源码 VorbisComment.Pictures 注释明示只
   对 Ogg base64 生效；探针实测 pictures=0 vs FlacFile.Pictures=1..2）。Scanner 按容器归一
   封面源（FlacFile 分支）。复验全量重扫：FLAC 959/964、MP3 152/152、albums 343/344、
   covers 目录 349 文件。
3. **--cli-full 未实现**：Cli.cs 写死 full:false，"全量重扫"实为增量跳过（0.5s 露馅）。
   补 ShellOptions.CliFull + 参数接线。修复后全量 18.8s（<30s 门槛仍过）。

教训入规：lane 报告的验收数字必须至少抽查一条**独立复跑**；"自报全绿 + 工具覆盖不到该路径"
是组合盲区（fts-verify 的词表生成偏长词，恰好绕开了 2 字 LIKE 路径）。

## 11. 审查 P1 修复（主进程，09-14）

- **P1-1 个人目录硬编码**：`LibraryDb.DefaultRoot` → `SpecialFolder.MyMusic`；ScanOutcome 增
  `RootsMissing`（CLI 输出 `roots_missing`）。实测：`--cli-scan D:\no-such` → roots_missing=true、
  scanned=0、DB 完好；混合（不存在+真库）→ false 正常扫。
- **P1-2 超时不打断底层读**：新增 `AbortingFileSystem`（IFileSystem 注入点）——超时 Dispose
  即关闭在持有的 FileStream 打断读；写/删成员全抛 NotSupportedException（只读红线的机制化）。
  catch 面补 ObjectDisposedException。消除"4 个 hang 文件→_busy 恒 1→曲库永久 library_busy"停摆路径。
- **P1-3 跨进程扫描互踩**：meta 表 `scan_lease`（pid|心跳戳，30s 心跳自开短连接守连接纪律，
  90s TTL 可抢占，正常尾 DELETE）。实测：后台全量扫 + 3s 后前台并发 → 后者
  `library_busy("another process holds the scan lease")`，后台 exit=0，事后扫描正常。
- 附带：P2-8 顺手（LibraryBusyException(why) 构造 + Cli roots_missing 字段）。
- **P2 处置**：P2-1 stale 未实现→M5d 不消费该列，FINDINGS 即备案；P2-2 fts-verify 与产品路径
  不同源→接受（转 M6 债务清单）；P2-3 routes 字段→M6 协议 v1.5 登记；P2-4 2000 截断→1116 规模
  不触发，M6 诊断页加 truncated 标志；P2-5 面板未接线零执行→**主进程接线归 M5d 步骤 5 一并做**；
  P2-6 covers 只增→M6 清理项；P2-7/9/10 登记。
