# M5 计划书 v2（收敛修订版）：曲库 + 歌词 + 任务栏歌词 + 专辑墙

> 状态：**草案，待用户过目——未开工** · 2026-09-13
> 取代：`docs/M5-PLAN.md`（v1）。v1 的选型结论（§1/§1.1）与范围裁定继续有效，本 v2 只做**收敛与补齐**：
> 把 v1 里"一句话带过"的四件事写实——① 子工单边界与协议草案；② 技术债归还的可验收化；
> ③ M5d 专辑墙（v1 只有一行，实际是 M5 里最大的件）；④ 风险清单改为**先检索后结论**（v1 的
> FTS5 中文假设经实测**不成立**，见 §7.1，这是 v2 最实质的修正）。
> 依据：`docs/GOAL-AUTONOMY.md`（范围/泳道/验证纪律）、`docs/IPC-PROTOCOL.md` v1.3、
> `docs/AUDIO-ENGINE.md` §13/§15/§16、`docs/M2-FINDINGS.md`、`docs/M3-PLAN.md`、
> 用户设计稿三张（09-13，`/mnt/c/Users/StarL/Downloads/{d29187…,f22442…,ce2fce…}.png`）、
> `/home/starl/AGENTS.md` 轮子优先铁律。

## 0. v2 相对 v1 的变更摘要

| # | 变更 | 原因 |
|---|---|---|
| 1 | **FTS5 分词器改判：`unicode61` → 双索引（`trigram` 为主 + `unicode61` 为辅）** | 实测 unicode61 把 CJK 连续串切成**单个 token**，"岁月如歌"查"岁月"/"如"全部 0 命中（§7.1 证据）；v1 §4 验收 2 的写法在真机上必失败 |
| 2 | 技术债归还（ring→`ma_pcm_rb`、FFT→kissfft）**升格为 M5a 的 P1 硬项**，并给出各自的等价性验收法 | v1 只写"顺手做"，无验收法 = 不会做；且 v1 的轮子表述**不准确**：`ma_rb` 无 peek、kissfft 上游 license 字段为 NOASSERTION（实为 BSD-3-Clause），先纠正事实再动手 |
| 3 | M5d 从"一行"展开为完整子工单：封面纹理管线、数据源切换、导航语义重映射、详情页复用映射表 | 三张设计稿显示的是**新界面范式**（35 专辑 × 13 页 + 流派列 + 字段表 + 歌单页签），复用上游三维阵列，工作量在 M5 内占比最大 |
| 4 | **小窗模式改判归 M6**（v1 写"可后置 M6"，v2 给明确建议与理由） | 小窗是**窗口宿主**能力（WPF 无边框/置顶/缩放），不是前端组件；与 M6 的打包/设置宿主工作同域，塞进 M5d 会让一轮 worker 背两个宿主 |
| 5 | 新增 §8 停点清单与 §9 待拍板问题（v1 §7 的三个 Q 已关闭两个，残余重新编号） | GOAL-AUTONOMY §5.2 要求 Q 字攒批交用户 |

**范围不变项（v1 结论直接继承，不重开）**：TagLibSharp2 0.6.0（MIT）+ Microsoft.Data.Sqlite 为
仅有两个 NuGet 依赖；FileSystemWatcher / System.IO.Pipes / WPF BitmapImage 全 BCL；
YRC 逐字歌词 = **不做**（M5-Q3 关闭，用户已把内嵌歌词改为标准双行 LRC）；行内双语拆句 = 不做；
v1 解码范围不变（FLAC/MP3/WAV，设计稿里的 M4A/AAC 为稿面随手画，库内无 M4A）。

## 1. 轮子检索对比表（v2 补齐四张）

> 元数据（TagLibSharp2）选型表已在 v1 §1.1 完成并继续有效（结论：MIT 的 TagLibSharp2 0.6.0
> 胜出，LGPL 的 TagLibSharp 出局），v2 不重复；本节补的是 v1 缺检索的**另外四个新子系统**。

轮子优先铁律要求"新子系统开工前先交检索对比表"。v1 只交了元数据一张，M5 实际有**四个**新子系统
（全文检索 / 封面纹理管线 / 专辑墙数据源 / 任务栏 writer），v2 补齐。

### 1.1 全文检索（中文/日文 CJK 歌名）

| 候选 | 许可 | CJK 能力 | 架构契合 | 判定 |
|---|---|---|---|---|
| SQLite FTS5 `unicode61`（v1 方案） | 公版 | ✗ 连续 CJK = 单 token，子串/单字查不到（实测 §7.1） | ✓ 零依赖 | ✗ **单独用不成立** |
| SQLite FTS5 `trigram` | 公版 | ✓ 任意 ≥3 字符子串命中（CJK/拉丁一视同仁）；✗ <3 字符不命中 | ✓ 同一 FTS5，零新依赖 | ✅ **主索引** |
| SQLite FTS5 `unicode61` + `remove_diacritics=2` | 公版 | 只解决拉丁变音符，不解决 CJK 切词 | ✓ | ⚠ 作为**辅索引**保留（整词/前缀更快、索引更小） |
| ICU tokenizer（`sqlite3-icu` 扩展） | 公版/UCSL | ✓ 真分词 | ✗ 需自编译扩展 + 分发 ICU 数据（数十 MB），Windows 侧无预编译件 | ✗ 部署成本不匹配"本地自用" |
| jieba 分词系（`jiebaNet`/`NGettext`…）+ 自建倒排 | MIT/Apache | ✓ 中文分词 | ✗ 词典内存 + 分词结果入库后**新词不可检索**；且分词≠子串检索（用户搜的是"片段"） | ✗ 问题域错位 |
| Lucene.NET | Apache-2.0 | ✓（CJKUnigramTokenizer） | ✗ 重量级（索引目录/段合并/ analyzer 配置），436 曲规模纯属杀鸡牛刀 | ✗ 规模不匹配 |
| LIKE `%kw%` 全表扫（v1 兜底写法） | — | ✓ 语义正确 | ✓ 零依赖 | ⚠ **降级为兜底**：436 行全表扫 <1ms，作为 trigram 短词（<3 字）路径 |
| 自写 CJK bigram 分词器喂 FTS5 | — | ✓ | ✗ 轮子已有（trigram 就是同族件），违反铁律 | ✗ |

**结论**：`tracks_fts`（trigram，主检索）+ `tracks_fts_w`（unicode61，整词/前缀与拉丁）双索引，
同一 `tracks` 表内容冗余两份（436 曲量级 ≈ 数百 KB，可忽略）；查询按关键字长度路由（§7.1）。
短于 3 字符的 CJK 关键字（"月"、"光"）走 `LIKE` 兜底——**不承诺拼音检索**（v1 已声明，v2 维持）。

### 1.2 封面纹理管线（M5d 最大件）

分层检索（①同品类完整应用 ②系统原生 API ③专用库 ④自写）：

| 层 | 候选 | 许可 | 能力 | 判定 |
|---|---|---|---|---|
| ① 完整应用 | **go-musicfox**（本机 fork，已有任务栏歌词集成） | MIT | 无封面纹理渲染（终端字符 UI） | ✗ 无可抄的渲染件 |
| ① 完整应用 | **louder** / **cmus** / **strawberry**（Qt） | GPL | 封面=2D pixmap 缩放，无三维阵列 | ✗ 架构不同 + GPL 永不入包 |
| ① 完整应用 | Wallpaper Engine 侧（本工程 `wallpaper/`） | 自有 | 已有 HUD 投影/磨砂/纹理质量件（`quality-renderer.ts`） | ✅ **复用自家件**（见 §5.4） |
| ② 系统原生 | WIC（Windows Imaging Component） | OS | 解码 JPEG/PNG/WebP → 像素缓冲 | ⚠ 壳侧解码可用，但**纹理上传必须在 WebView 的 WebGL 上下文**，跨进程传像素不值当 |
| ② 系统原生 | WinRT `SoftwareBitmap` | OS | 同上 | ✗ 同一跨进程问题 |
| ③ 专用库 | `THREE.TextureLoader`（three 已在依赖） | MIT | `createObjectURL(blob)` 直接可用作 `map` | ✅ **解码/上传交给浏览器**，零新依赖 |
| ③ 专用库 | `three-stdlib` TextureLoader 变体 / `@pixi/loaders` | MIT | 与 three 内置功能重复 | ✗ 重复引入 |
| ③ 专用库 | `gl-texture-manager` 类 LRU 包 | 零散/无维护 | 纹理 LRU 池 | ✗ 无成熟件；three 的 `renderer.info.memory.textures` + 手写 LRU ~80 行更可控 |
| ④ 自写 | **封面 LRU 缓存 + mip 预算 + 降级 2D 网格** | — | — | ✅ 见 §5.4/§5.5 |

**自写部分的"前三层不可用"理由**：纹理缓存的**淘汰策略必须与本项目特有的实例化阵列生命周期耦合**
（`scene.ts:457` 的 `labelTexture` 是单张常驻、`createAssemblyModel` 每次选中 clone 一份材质
`scene.ts:677-680`），外部库不认识我们的 cell→mesh 映射，接进来还得包一层，净收益为负。
**解码与上传一律不自写**（浏览器已做），自写只剩"缓存 + 预算 + 降级"三件胶水。

### 1.3 专辑墙数据源（archives.json → SQLite）

| 候选 | 许可 | 判定 |
|---|---|---|
| 继续 `content/archives.json`（v1 隐含选项） | 自有 | ✗ 无法承载真曲库（436 曲 / 35 专辑动态增长、需检索与增量） |
| 前端 fetch REST（壳起 HTTP 服务） | — | ✗ 破坏既有 IPC 单一网关（协议 §1"前端不能直连核心"同一纪律），多一个端口/防火墙面 |
| **既有 `bridge.call(cmd)` 通道 + 壳侧 SQLite** | MIT | ✅ 零新依赖：`desktop-bridge.ts:168 call()` 与壳 `Bridge.cs:88-95` 的 cmd 路由现成，只加 `library.*` 分支 |
| 壳把整库 JSON 一次性塞进 `window` | — | ✗ 436 曲元数据 + 封面引用 ≈ 数百 KB 起步，且每次变更全量重发 |

### 1.4 任务栏歌词 writer（v1 已定，v2 补检索证据）

| 候选 | 许可 | 判定 |
|---|---|---|
| **既有冻结协议 `\\.\pipe\go-musicfox.lyric.v1`**（Taskbar-Lyrics C++ 插件已实装读端） | MIT（本仓 fork） | ✅ 白嫖自家已验证协议，writer 只需 JSON Lines + 退避重连 |
| 自定新协议 + 改插件 | — | ✗ 插件端已上线，改它 = 双份维护，违反"能用的轮子绝不重写" |
| 第三方 lyric 管道件 | 无 | ✗ 检索无果（该协议是本机特有），属"轮子不存在"层 |

M5-Q1 已因此关闭。

## 2. 仅剩的自造清单（v2 收敛后）

| 件 | 规模 | 位置 | 为什么没有轮子 |
|---|---|---|---|
| 扫描编排 | ~250 行 C# | `host/RhineShell/Library/Scanner.cs` | 枚举→TagLibSharp2→upsert→watcher 的调度各件皆有轮、编排无 |
| LRC 时间轴解析 | ~60 行 TS | `src/player/lyrics/lrc.ts` | npm 同类包都要再转一层且带不需要的 UI；规则就是逐行正则（v1 结论保留） |
| 封面纹理 LRU + 预算 + 降级 | ~120 行 TS | `src/player/covers/texture-cache.ts` | 见 §1.2 |
| 双索引检索编排（长度路由 + 排名合并） | ~60 行 C# | `host/RhineShell/Library/Search.cs` | 路由规则是本项目语义，无轮子 |

~~YRC 逐字解析~~（M5-Q3 关闭）、~~行内双语拆句~~（v1 已取消）。**合计自研 ≤490 行**，其余全胶水。

## 3. 子工单总览

| 工单 | 一句话 | 协议 | 文件所有权（越界即打回） | 预估 |
|---|---|---|---|---|
| **M5a** | 曲库落地：扫描 + DB + 双索引检索 + `library.*` 协议 + 列表/搜索消费；**同轮归还两项技术债** | v1.4 | `host/RhineShell/Library/**`、`host/core/src/{ring,audio,spectrum}.{h,cpp}`、`host/core/vendor/kiss_fft*`、`src/player/library/**`、`docs/IPC-PROTOCOL.md` | worker **1.5 轮** |
| **M5b** | 歌词：内嵌/旁挂 LRC 取文 + 前端解析与逐行渲染 + SMTC 封面补 M3 欠账 | v1.4 | `host/RhineShell/Library/Lyrics.cs`、`src/player/lyrics/**`、`host/RhineShell/Smtc/SmtcManager.cs` | worker **1 轮** |
| **M5c** | 任务栏 writer + watcher 增量 + 收藏从 localStorage 迁 DB | v1.4 | `host/RhineShell/Taskbar/**`、`host/RhineShell/Library/Watcher.cs`、`host/RhineShell/Library/UserState.cs` | worker **0.5 轮** |
| **M5d** | 专辑墙（设计稿三张）：封面纹理管线 + 数据源切 DB + 列=流派导航重映射 + 详情页字段表/歌单页签 | v1.4 | `src/scene.ts`、`src/main.ts`、`src/player/covers/**`、`src/data.ts`、`src/archive-loop.ts`、`host/RhineShell/Library/Albums.cs`、`src/style.css`/`theme.css` | worker **2 轮** + reviewer 1 轮 |
| **M5-r** | reviewer 审查 + P1 修复（两轮内收敛） | — | 同上 | 1 轮 |

> **M5d 需要修改上游 `src/scene.ts`/`src/main.ts`** —— 这与 GOAL-AUTONOMY §5.3"需要修改上游
> src/* 才能继续 → 停下报告"直接冲突，**已列为停点 P-1，须用户点头后才开工**（详见 §8）。
> M5a/b/c 全部在 `host/**` + `src/player/**` 新目录内，零上游侵入。

## 4. M5a：曲库落地 + 技术债归还

### 4.1 目标（一句话）
把 `C:\Users\StarL\Music`（1116 文件 / 44GB / 35 专辑 / 436 曲）扫进 SQLite 并以
`library.scan` / `library.query` 两条 cmd 提供检索，同轮把 ring 与 FFT 两处手写件换成 vendor 轮子。

### 4.2 文件所有权
新增 `host/RhineShell/Library/{LibraryDb.cs,Scanner.cs,Search.cs,LibraryApi.cs}`；
改 `host/RhineShell/Hosting/Bridge.cs`（cmd 路由，现 `Bridge.cs:180` 的 `config.set` 同位置加分支）；
改 `host/RhineShell/RhineShell.csproj`（+2 PackageReference）；
改 `host/core/src/{ring.h,ring.cpp,audio.h,audio.cpp,spectrum.h,spectrum.cpp}` + 新增
`host/core/vendor/kiss_fft.{c,h}`、`kiss_fftr.{c,h}`、`LICENSES/kissfft-BSD-3-Clause.txt`、
`host/core/CMakeLists.txt`；改 `docs/IPC-PROTOCOL.md`；新增 `src/player/library/**`（前端消费与列表 UI）。
**不碰** `src/scene.ts`、`src/main.ts`（列表 UI 在 M5a 只挂到既有播放条，专辑墙是 M5d）。

### 4.3 协议增量草案（IPC v1.4）

```jsonc
// §5 cmd 表新增（壳侧自答，不经核心管道；与 config.get/set 同一路由位置）
"library.scan":   { "roots": ["C:\\Users\\StarL\\Music"], "full": false }
                    → { "scanned": 1116, "added": 436, "updated": 0, "removed": 0,
                        "failed": 1, "elapsed_ms": 8420 }
"library.query":  { "q": "岁月", "scope": "tracks|albums", "filter": {"genre":"World","year":1999},
                    "sort": "title|artist|album|year|duration|added", "offset": 0, "limit": 200 }
                    → { "total": 436, "items": [ { "id": 12, "title": "…", "artist": "…",
                          "album": "…", "genre": "World", "year": 1999, "track_no": 1,
                          "duration_ms": 253000, "codec": "FLAC", "sample_rate": 44100,
                          "bit_depth": 24, "bitrate": 900000, "cover_key": "sha1:…",
                          "lyric_state": "embedded|sidecar|none" } ] }
"library.albums": { "genre": "World", "limit": 200 }
                    → { "total": 35, "items": [ { "album_key": "sha1:…", "title": "…",
                          "artist": "…", "year": 1999, "genre": "World", "disc_count": 1,
                          "track_count": 10, "duration_ms": 2687000, "cover_key": "sha1:…",
                          "formats": ["FLAC"], "bitrate_range": [258000, 282000],
                          "resolution": {"lossy": false, "sample_rate": 44100} } ] }
"library.get":    { "id": 12 } → { …track 全字段, "album": {…}, "lyric_text": "…" }
"library.stats":  — → { "albums": 35, "tracks": 436, "genres": 7, "roots": […],
                        "last_scan_ms": 8420, "quarantine": 1 }
// §5 既有占名行 "library.scan / library.query（M5 定形，先占名）" → 改为"v1.4 已定形"
// §6 evt 新增 kind
"library":        扫描/增量完成时（非周期）→ { "phase":"start|progress|done", "scanned":n,
                    "total":n, "quarantine":n }   // 节流：progress ≤1Hz
// §7 错误码新增
"library_busy"    扫描进行中收到写类命令（可重试=true）
"library_unavailable"  DB 打不开/损坏（重试=false，UI 提示重建）
// §4 caps：壳 hello 的 caps 追加 "library"（前端据此判断曲库能力，桩/无库环境优雅降级）
```

`engine.play` 的 `track_id` 支持 **`lib:<id>`**：壳在转发核心前把 `lib:` 解析成 `file:<绝对路径>`
（协议 §5 与核心侧 scheme 均**零改动**，M2-FINDINGS §2.1 的 `file:` 约束继续成立）。

### 4.4 DB schema（`%LOCALAPPDATA%/RhineMusic/library.db`，WAL）

AUDIO-ENGINE §16 精简版 + 专辑表 + **双 FTS 索引**：

```sql
CREATE TABLE tracks(id INTEGER PRIMARY KEY, path TEXT UNIQUE, cue_offset INTEGER DEFAULT 0,
  title, artist, album, album_artist, year INT, genre, track_no INT, disc_no INT,
  duration_ms INT, codec, sample_rate INT, bit_depth INT, channels INT, bitrate INT,
  container_bitperfect_capable INT, gain_track REAL, gain_album REAL,
  album_art_key TEXT, lyric_embedded TEXT, lyric_path TEXT,
  mtime INT, size INT, added_at INT, play_count INT DEFAULT 0, last_played_at INT);
CREATE TABLE albums(key TEXT PRIMARY KEY, title, artist, year, genre, disc_count INT,
  track_count INT, duration_ms INT, cover_key TEXT, scanned_at INT);
CREATE TABLE tracks_fts(rowid INTEGER, title, artist, album, tokenize='trigram');      -- 主
CREATE TABLE tracks_fts_w(rowid INTEGER, title, artist, album,
  tokenize='unicode61 remove_diacritics 2');                                           -- 辅
CREATE TABLE quarantine(path TEXT PRIMARY KEY, reason TEXT, mtime INT, size INT, seen_at INT);
CREATE TABLE user_state(kind TEXT, key TEXT, value TEXT, at INT, PRIMARY KEY(kind,key)); -- M5c 收藏/历史
PRAGMA journal_mode=WAL;
```

`tracks_fts` / `tracks_fts_w` 用 `content='tracks'` 外部内容表 + 三个触发器同步（避免正文双份存储）。

### 4.5 技术债归还（P1 硬项，v2 升格）

**债 1：`ring.{h,cpp}` → miniaudio `ma_pcm_rb`**
- 事实纠正：vendor `miniaudio.h:3542-3600` 确有 `ma_rb`/`ma_pcm_rb`（92 处符号，**单文件头内**，
  无需新 vendor 件），license 与 miniaudio 同为 MIT（`vendor/LICENSES/miniaudio-LICENSE.txt`）。
- **已知差异（诚实登记，决定工作量）**：`ma_pcm_rb` 的 API 是
  `acquire_read/commit_read/acquire_write/commit_write/pointer_distance/seek_read/reset`，
  **没有** 我们的 `peek(skip,…)`（非消费读），且 `seek_*` 只能**向前**移动指针。
  当前 `peek` 的唯一调用者是 `ring.cpp:62` 自身（grep 全仓：`audio.cpp`/`spectrum.cpp` 未调用——
  M3 实际落地的是回调侧 `spectrum_.PushFromCallback(...)`，`audio.cpp:229`），
  所以**删除 `peek` 不破坏任何现存行为**，M4 若需真 peek 再单独评估。
- 实施：`audio.h:136` 的 `SpscRing ring_{1u<<16}` → `ma_pcm_rb ring_`（`ma_format_s32`, 2ch,
  65536 帧，**预分配**：`ma_pcm_rb_init_ex` 传自有 buffer 以满足回调零分配红线）；
  `audio.cpp:217` pop → `acquire_read`+`commit_read`（注意两段回绕需循环调用）；
  `audio.cpp:503` push → `acquire_write`+`commit_write`；`audio.cpp:319/345/368/401/430` reset →
  `ma_pcm_rb_reset`；`audio.cpp:444/485`、`audio.h:93` 的 `readable()`/`capacity_frames()` →
  `ma_rb_pointer_distance`（字节）÷8 与 `capacity/8`；`audio.cpp:444` 的
  `readable()==0` EOF 排空判定语义**必须逐条保持**（M2-FINDINGS §7.2 依赖它）。
- 删除 `host/core/src/ring.{h,cpp}`（93+40 行）与 `CMakeLists.txt` 中的条目。
- **验收法 A1（等价性，无人值守）**：
  1. `pwsh scripts/m2-build.ps1` → `errors=0 warnings(project)=0`；
  2. `pwsh tools/m2-smoke/smoke.ps1`（FLAC24 + MP3 全链路）→ `SMOKE-PASS`，且
     **逐字段比对**改前/改后 trace：`position` 帧序列单调不减、`buffered_ms` 量级一致
     （±5%）、`state` 序不变、`bye` exit=0；
  3. `pwsh scripts/m1-scenario.ps1`（桩裁判）→ `ALL PASS`（协议面不破）；
  4. 曲终收敛专项：M2-FINDINGS §1 #28/#7 场景（播到 EOF → 同曲 re-play → toggle）
     重跑 `tools/m2-smoke/repro.ps1`，位置恢复推进（对照修复记录里的 pos 40→5520 量级）；
  5. 24bit 红线回归：FLAC24 冒烟帧仍为 `{"detail":"flac s24->s32","passthrough":true}`
     （M2-FINDINGS §5 取证口径不许退化）。

**债 2：手写 radix-2 FFT → kissfft**
- 事实纠正：`gh api repos/mborgerding/kissfft` 的 `license.spdx_id` 返回 **NOASSERTION**，
  但仓库 `COPYING` 明写 `SPDX-License-Identifier: BSD-3-Clause`（`LICENSES/BSD-3-Clause` 在库内）
  → 许可可用，**但 `THIRD-PARTY-NOTICES` 里必须写 BSD-3-Clause 并附 COPYING 原文**，
  不得凭 GitHub 字段误判（M6 §3 的机器生成会踩这个坑，见 M6-PLAN §3.2）。
- 实施：vendor `kiss_fft.{c,h}`、`kiss_fftr.{c,h}`、`_kiss_fft_guts.h`、`kiss_fft_log.h`
  （6 文件，纯 C，`KISSFFT_USE_ALLOCATIC=0` + `KISSFFT_SCALAR` 避免 SIMD/alloc 依赖）；
  `spectrum.h:87` 的 `std::array<std::complex<double>,1024> fft_` → `kiss_fftr_cfg`
  （**实数 FFT**：输入是单声道实数，`spectrum.cpp:109-110` 把虚部填 0，正好是 `kiss_fftr` 的定义域，
  1024 点实变换 ≈ 512 复数点，**理论省一半**）；`spectrum.cpp:105-128` 的位反转+蝶形整段删除；
  输出谱线取 `kiss_fftr` 的 `KiSS_FFT_R+1` 个 bin，与现 `fft_[bin]` 索引一一对应。
- **验收法 A2（数值等价，无人值守）**：
  1. 新增 `tools/fft-equiv/`（一次性对照，不常驻）：对 3 组真实输入（静音 / FLAC24 采样帧 /
     MP3 帧）分别用**改前**（git stash 版）与**改后**各产 100 帧 `bands_l/bands_r`，
     断言 `max|Δband| < 1e-4`（float 域）与 `low/mid/high/activity/beat_phase` 完全一致；
  2. `pwsh tools/m3-smoke/spec-smoke.ps1`（M3 已有）→ 帧数 ≥10、非全零、L≠R、帧间隔中位数
     25–45ms 全绿；
  3. CPU 预算：30Hz×2ch 下核心进程 CPU 增量 ≤ 改前（M3 任务书红线 <2%），
     记录进 `docs/M5-FINDINGS.md`；
  4. 构建零警告（kissfft TU 走 `/external:W0`，与 miniaudio_impl 同口径 M2-FINDINGS §6.6）。

### 4.6 命令级无人值守验收（M5a）

```
1  pwsh scripts/m2-build.ps1                      → errors=0 warnings(project)=0
2  pwsh scripts/m-build.ps1                       → dotnet 壳 0 警告 0 错误
3  npx tsc --noEmit && npm run build              → 绿
4  node scripts/check-shell.mjs                   → 绿（上游资产不破）
5  pwsh scripts/m1-scenario.ps1                   → ALL PASS
6  pwsh tools/m2-smoke/smoke.ps1                  → SMOKE-PASS ×2（FLAC24/MP3）
7  A1 等价性五项 / A2 等价性四项                  → 全绿（技术债归还的独立证据）
8  dotnet run --project host/RhineShell -- --cli-scan "C:\Users\StarL\Music"
     → stdout 末行 JSON: {"scanned":1116,"albums":35,"tracks":436,"failed":<=5,"elapsed_ms":<30000}
     → library.db 存在、WAL、SELECT COUNT(*) FROM tracks == 436
9  二次启动 reconcile：同命令再跑 → elapsed_ms < 2000 且 added=0 updated=0
10 --cli-query "岁月如歌" / "光るなら" / "Eason" / "Melody"
     → 各 ≥1 命中；--cli-query "月"（短于 3 字）→ LIKE 兜底 ≥1 命中
11 --cli-query "zzzz不存在zzzz" → total=0 且不抛异常
12 quarantine 表：人为放一个 0 字节 .flac → failed=1、quarantine 行数=1、扫描不中断
```

`--cli-scan/--cli-query` 是**壳的无头自检开关**（与既有 `--core-exe`、`--no-smtc` 同族，
`ShellOptions.cs` 加分支），专为无人值守验收，不进产品 UI。

### 4.7 预估轮数
worker-qwen **1.5 轮**（扫描+DB+协议 0.5、前端消费+列表 0.3、技术债归还与等价性取证 0.7）。

## 5. M5d：专辑墙（设计稿三张 → 实施映射）

### 5.1 设计稿读图结论（三张，09-13）

| 稿 | 内容 | 提炼出的硬要求 |
|---|---|---|
| `d29187…`（浅/暖昼，阵列 + 右侧浮层） | 三维阵列磨砂卡片，**仅选中卡露出封面**（陈奕迅同名专辑），其余为素面；右侧信息浮层：`MUSIC ARCHIVE ／ World`、`ALBUM 002`、大标题"陈奕迅"、`Eason Chan`、`陈奕迅`、`1999 / 10 首曲目 / 44:47`、`打开专辑 ↗`；右上 `M4A` 角标；左下 `ALBUM / SELECT 01 / 13` + 上下箭头 + 刻度条；右下 `GENRE 04 / 07` + `World` + 左右箭头；页脚 `LOCAL COLLECTION · 35 ALBUMS / 436 TRACKS`；顶栏 `音乐库` `搜索` `暖昼/深夜` 切换、滑块、播放、窗口 | ①列=**流派**（GENRE 04/07，左右切列）②行=**专辑**（上下切档，13 页刻度）③选中卡才显示封面，其余素面 ④右侧浮层是**阵列态**的摘要（非详情页）⑤`M4A` 类格式角标 ⑥页脚统计条 |
| `f22442…`（详情页） | 左：大封面卡片（磨砂边框 + 三颗螺丝 + `RHINE LAB LLC` 压印 + 左上标签），`← 返回专辑架` + `ESC`、`ALBUM / 002`、`拖动卡片，查看完整封面`、`360° 查看专辑模型 ↗`；右：`ALBUM 002` / 标题 / 艺术家两行 / **八字段两列表格**（RELEASE 发行年份、ARTIST 歌手、GENRE 流派、VOLUMES 内含 CD、FORMAT 文件格式、RESOLUTION 位深与采样率、BITRATE 码率、DURATION 总时长）/ 页签 `01 歌单` `02 专辑介绍` / 曲目行（序号、标题、艺术家、格式角标、时长） | ①详情页 = **字段表 + 两页签（歌单/介绍）**（替换上游三页签）②卡片左侧文案改语义 ③`360° 查看专辑模型` 复用既有查看器 ④曲目行可点击播放 |
| `ce2fce…`（深夜/暗色，同构图） | 同第一张，石墨背景、暖白文字、选中卡封面仍饱和 | 暗色沿用既有 `ThemeWave` 逐实例渐变，**封面不随主题去饱和**（保持色彩可读） |

**与上游界面的差异（= M5d 的实际工作量）**：文案与语义重映射（ARCHIVE→ALBUM、COLUMN→GENRE、
NO.→ALBUM 编号）、总数从固定 40 变为动态 35/436、刻度条页数 12→13（动态）、右侧浮层为新增组件、
详情页字段表与页签内容替换、封面纹理管线为全新件。

### 5.2 目标（一句话）
把上游"40 份机构档案"的阵列与详情页改造成"35 张专辑 / 7 流派 / 436 曲"的**音乐库专辑墙**，
数据源从 `content/archives.json` 切到 `library.*`（DB），封面走三维纹理管线，暗色与阵列交互规则不变。

### 5.3 文件所有权
`src/scene.ts`（封面材质槽 + 实例纹理绑定）、`src/main.ts`（DOM 骨架与文案、字段表、页签、浮层、
刻度动态化）、`src/data.ts`（改为异步 provider + 内存索引，保留同步查询签名）、
`src/archive-loop.ts`（列数动态化）、`src/player/covers/**`（新）、`host/RhineShell/Library/Albums.cs`（新）、
`src/style.css`/`src/theme.css`（新组件样式）。
**不碰** `host/core/**`、`docs/IPC-PROTOCOL.md`（协议在 M5a 已定形，M5d 只消费）。

### 5.4 封面纹理管线（最大件）

**数据通路**（不跨进程传像素，见 §1.2）：
```
壳：封面字节 → %LOCALAPPDATA%/RhineMusic/covers/<cover_key>.jpg|png（内容寻址，去重）
     library.albums/get 返回 cover_key
前端：new URL(`/rhine-cover://<cover_key>`) —— 不引入自定义 scheme，
     改用 WebView2 的 **WebResourceRequested 拦截 virtual host**（壳已持有 WebView2 环境）：
     `https://cover.rhine.local/<cover_key>.jpg` → 壳读文件回 Stream
     → THREE.TextureLoader.load(url)（解码/上传交给浏览器，§1.2 结论）
```
（若 WebResourceRequested 接线路径不通，退路是 `library.cover` cmd 返回 base64 data URI，
代价是 IPC 帧体积；两条路都在 M5d 范围内，先试前者，结果写 FINDINGS。）

**缓存与预算（`src/player/covers/texture-cache.ts`，~120 行自写）**：
- LRU，上限 `maxTextures = 24`（覆盖 9×3 可见窗口 + 详情 1 + 查看器 1 + 预取 4 + 余量）；
- 上限内存 `maxBytes = 96 MiB`：按 `w*h*4` 估算，纹理分辨率阶梯 **512² → 256² → 128²**；
  超级性能模式（`scene.ts:94 setSuperPerformance`）直接压到 **256² / 32 MiB / maxTextures 12**；
- 复用既有 `applyTextureQuality(scene, renderer, quality)`（`quality-renderer.ts:8`）统一
  anisotropy；mip 生成开 `generateMipmaps=true`（阵列里封面是斜视小面积，无 mip 会糊）；
- 未命中/加载中：素面（当前 `Index_Inlay` 的 `#e4d6c5`，`scene.ts:440`）——**不允许白块/闪烁**；
- 解码失败（TagLibSharp2 抽出的是非法图像）：回素面 + `cover_key` 记入 quarantine（壳侧）。

**纹理挂载点（唯一允许的 scene.ts 改动）**：
`Index_Inlay` 材质族新增 `map` 槽（`scene.ts:419-421` 的 arrayMat 分支 +
`createAssemblyModel()` `scene.ts:481` 的选中卡分支）。
- **阵列中的卡片**：`InstancedMesh` + `instanceMatrix`（`scene.ts:450`）——v1 **不给阵列实例上纹理**
  （逐实例纹理需要 `InstancedMesh` 的纹理数组或图集，代价大）；设计稿本身也只画了选中卡有封面，
  与阵列磨砂素面一致 → **阵列保持素面，只有选中卡（`this.model`，普通 Mesh）贴封面**；
- **详情/选中卡**：与 `labelTexture` 完全同构的替换路径（`scene.ts:457-464` 建纹理、
  `scene.ts:733-756 drawLabel()` 重绘 + `needsUpdate`）→ 新增 `setCoverTexture(tex?)`，
  在 `select()`（`scene.ts:661`）里换绑，复用 `scene.ts:677-680` 的 clone-材质模式避免污染原材质；
- **暗色**：`themeMaterial` 的 uniform 注入（`theme-material.ts:9`）只改 `diffuseColor`，
  有 `map` 时需在 `#include <map_fragment>` 之后参与混合——**封面在暗色下去饱和**是设计稿明确否掉的
  （`ce2fce…` 封面仍饱和），故封面材质**不注册进 themeMaterial 的调色分支**，仅边框/螺丝跟随主题。

**降级到 2D 网格的条件（写死，供 reviewer 核对）**：满足任一即切 2D 封面网格（`#detail` 式 DOM 列表，
复用既有 `SurfaceTransition`/`ContentTransition`，`main.ts:130-131`），并在设置里给出原因：
1. `renderer.info.memory.textures` 在 60s 稳态观测中**持续增长**（缓存失效，判定为泄漏）；
2. 帧时间中位数 > 33ms（30fps 以下）且**关闭封面纹理后**恢复到 ≥ 45fps（证明是纹理成本）；
3. `gl.MAX_TEXTURE_SIZE < 2048`（老驱动，512² 阶梯也可能被拒）；
4. WebResourceRequested 封面通路失败且 base64 退路导致 IPC 往返 p95 > 50ms（拖垮 spectrum 通道）；
5. 用户显式选择（设置里的"专辑墙封面"三态：纹理 / 仅选中卡 / 关闭）。
观测数据源现成：`scene.getStats()`（`scene.ts:1686`）+ `renderer.info`；阈值判定进
`src/player/covers/degrade.ts`，一次性实现，不做自适应抖动（滞回：降级后只有用户手动才恢复）。

### 5.5 数据源切换：archives.json → DB

- `src/data.ts` 现状：`records`（40 条）、`categories`、`archiveColumns`（5 列固定）+
  三个同步查询函数 `columnFiles` / `fileLocation` / `fileAtSlot`（`data.ts:19-38`）。
- 改造：**保留全部导出签名**（`scene.ts`、`main.ts`、`archive-loop.ts` 都依赖它们，签名不变 = 零调用点改动），
  内部改为 `AlbumIndex` 内存视图 + 异步水合：
  ```
  web 模式（无 bridge）：仍从 content/archives.json 构建（40 份档案 → 5 列，作为演示数据，
    保证 npm run build / 线上站点 / check-*.mjs 全不受影响）
  desktop 模式：await bridge.call("library.albums") → 填充同形状结构（genres→columns、
    albums→records、专辑字段→ArchiveRecord 字段映射表见 §5.7）
  ```
- **`fileLocation` 的 `lane*32+row` 与 `row = 12 + …` 偏移是硬编码**（`data.ts:26-31`），
  `LOOP_ROWS=32`（`archive-loop.ts:8`）——列数动态化时 `POOL_LANES`/`visibleCell` 也要跟着
  参数化（`archive-loop.ts:58-74`）。**这是 M5d 里最容易破回归的一处**：验收 5.8-4 专门盯它。
- archives.json **不删除**：作为 web 降级与 `check-content.mjs` 的 fixture 永久保留（上游资产处置）。

### 5.6 导航语义重映射（列=流派）

| 上游 | M5d | 实现位置 |
|---|---|---|
| `←/→` 切列（5 类档案） | 切**流派**（7 类，`GENRE 04 / 07`） | `main.ts:403 stepColumn()` + `scene.onNavigate("lane",±1)`（`scene.ts:238`） |
| `↑/↓` 同列切档案 | 同流派切**专辑** | `main.ts:395 stepFile()` |
| 刻度条 12 格 | 当前流派专辑数（13/8/…动态），点击跳档 | `main.ts:331 fileTicks` 重建；`#file-ticks` 按钮数随列变化 |
| `COLUMN 03 / 05` | `GENRE 04 / 07` | `#column-index`/`#column-name`（Rolling Number/Text 复用，`main.ts:174,192`） |
| `ARCHIVE / SELECT 01 / 12` | `ALBUM / SELECT 01 / 13` | `#selected-number`（`main.ts:170`）+ 总数改动态 |
| 每列记忆选档 | 每**流派**记忆（语义等价，直接沿用） | `main.ts:237 columnMemory` |
| 循环阵列（无尽头） | 保留：流派与专辑各自循环 | `archive-loop.ts` wrap 逻辑不变，仅列数参数化 |
| `ENTER 读取` | `ENTER 打开专辑` | `main.ts:471 openFile()` |
| 页脚 `JOYCE MOORE / SESSION AUTHORIZED` | `LOCAL COLLECTION · 35 ALBUMS / 436 TRACKS` | `main.ts` footer + `library.stats` |
| 右上 `M4A` 角标 | 实际容器/编码（FLAC/MP3/WAV；库内无 M4A，稿面为示意） | `#detail` 浮层 + 曲目行 |

### 5.7 详情页逐元素复用映射表（设计稿 2）

| 设计稿元素 | 上游对应物 | 复用方式 | 证据 |
|---|---|---|---|
| 磨砂卡片 + 三颗螺丝 + 压印 + 左上标签 | 外壳模型 + `Titanium_Fasteners`/`Index_Inlay` + `labelTexture` | **直接复用**，标签内容从 `NO.xxx` 改 `ALBUM 002` | `scene.ts:455-470`（label 纹理）、`scene.ts:733-756`（drawLabel）、`scene.ts:392-397`（螺丝/盖板名单） |
| 封面显示区（卡片中央） | 无（上游是磨砂体内部件） | **新增 `map` 槽**（§5.4 唯一 scene.ts 改动） | `scene.ts:419-421` |
| `← 返回专辑架` + `ESC` | `.back-button` `← ARCHIVE OVERVIEW` + `small ESC` | 改文案 | `main.ts:80` |
| `拖动卡片，查看完整封面` | `DRAG TO INSPECT ↔`（`.object-caption small`） | 改文案 | `main.ts:81` |
| `360° 查看专辑模型 ↗` | `360° 查看文档模型 ↗`（`data-action="model-viewer"`） | **直接复用** `ModelViewer.open(id,title,provider,reduced)` | `model-viewer.ts:186`、`main.ts:748-758` |
| 右侧大标题/艺术家两行 | `.detail-kicker` + `h2`(en) + `.detail-title-cn` | 改绑 album.title/artist/album_artist | `main.ts:503-504` |
| **八字段两列表格** | `.metadata` `<dl>` 四字段（DEPARTMENT/COLLECTION/RELATED/STATUS） | **同结构扩到 8 字段**（`<dl><div><dt><dd>` 原样，CSS 两列已就绪） | `main.ts:507` |
| 页签 `01 歌单` `02 专辑介绍` | 三页签 `01 概述` `02 研究记录` `03 访问日志` | **删一页签、改两页签文案**；`setTab()` 的面板注入与指示条位移**完全复用** | `main.ts:508`（页签 DOM）、`main.ts:520-556`（setTab） |
| 歌单行（序号/标题/艺术家/格式/时长） | `.research-notes` `<ol>` 编号列表（`main.ts:539`） | 新增 `.track-row` 样式（grid），点击 → `playerStore.play("lib:<id>")` | `main.ts:539`、`player-store.ts:77` |
| 专辑介绍 | `overview()` 摘要段 | 复用（v1 内容 = 上游 archives 的 abstract，或留空占位） | `main.ts:517` |
| `+ SAVE ARCHIVE` / `EXPORT ↓` | 同名按钮 | 收藏改走 `user_state`（M5c 迁移）；导出 TXT 改为**专辑曲目清单**（`scripts/export-records.mjs` 同族，前端生成 Blob） | `main.ts:510`、`main.ts:488`（收藏态切换） |
| 解密遮罩（正文自上而下清晰） | `documentDecryption` | 直接复用 | `main.ts:514`、`document-decryption.ts` |
| 右侧浮层（阵列态摘要，稿 1） | `.archive-callout`（eyebrow/file-title/read-file） | **改造**：字段换 album.title/artist/year/曲目数/总时长 + `打开专辑 ↗` | `main.ts:72`（callout）、`main.ts:74`（counter） |
| 滚动数字/滚动文字 | `createRollingNumber` / `createRollingText` | 直接复用（ALBUM 编号、GENRE 名、总数） | `main.ts:170-207` |
| 明暗切换 `暖昼/深夜` | 既有 theme 开关 | 直接复用 | `scene.ts:116 setTheme`、`theme-ui.ts` |

**净结论**：详情页 90% 是文案与字段绑定改动，真新增只有"封面 map 槽"和"曲目行样式"两处。

### 5.8 命令级无人值守验收（M5d）

```
1  npx tsc --noEmit && npm run build && node scripts/check-shell.mjs      → 三绿
2  node scripts/check-content.mjs                                         → archives.json fixture 仍校验通过
3  node scripts/check-loop.mjs && node scripts/check-array-input.mjs
   && node scripts/check-archive-visibility.mjs && node scripts/check-theme.mjs
   && node scripts/check-selection-state.mjs && node scripts/check-super-performance.mjs
   && node scripts/check-viewport.mjs && node scripts/check-responsive.mjs → 全绿（上游回归底线）
4  新增 scripts/check-album-wall.mjs（headless，CDP 9240，NO_PROXY='*'）：
   a. desktop 模式注入 35 专辑/7 流派假 bridge（tools/m1-e2e 模式）→
      列数=7、当前列刻度按钮数 == 该流派专辑数、GENRE 文案 == "GENRE 04 / 07"
   b. ←/→ 十次 → 无尽头、每列记忆恢复；↑/↓ 循环同理
   c. 选中卡材质 map != null 且 texture.image.width >= 256；非选中卡 map == null
   d. renderer.info.memory.textures <= 24（LRU 上限生效，切 40 张专辑后仍 <= 24）
   e. 暗色下封面材质 color 未被 themeMaterial 改写（断言封面 mesh 不在 theme 注册表）
   f. 详情页：8 个 <dt>、2 个页签、歌单行数 == track_count、点第 1 行 → playerStore 状态 playing
      且 track_id 前缀 "lib:"
5  2D 降级路径：--force-degrade 开关下 a-f 除 c/d 外全绿，且无 console 异常
6  真机（用户在场，非无人值守）：35 专辑墙滚动帧率、封面清晰度 —— 列入停点 P-2
```

### 5.9 预估轮数
worker-qwen **2 轮**（纹理管线+数据源 1 轮、DOM/导航/详情复用+脚本 1 轮）+ reviewer **1 轮** + P1 修复 0.5 轮。

### 5.10 小窗模式归属建议：**M6**（v1 写"可后置 M6"，v2 给结论）

三张设计稿右上角均有一对独立控件：实心播放三角（▶）与**方框图标（小窗/迷你播放窗）**，
后者即"小窗模式"的入口（稿面未展开其内部布局）。判定归 M6 的理由：

| 维度 | 事实 |
|---|---|
| 能力归属 | 小窗 = **窗口宿主**行为（无边框、置顶、可缩放、随窗口尺寸重排 DOM），主体工作在 WPF `MainWindow` 与窗口样式，不在前端组件里 |
| 与 M6 的同域性 | M6 已含"设置三层 UI + 打包"，其中打包/宿主（安装、单实例、托盘、开机自启）与小窗共用同一批文件（`host/RhineShell/MainWindow.xaml*`、`App.xaml.cs`、`ShellOptions.cs`） |
| 与 M5d 的耦合度 | 低：小窗只需 `playerStore` + `library.get` 的现成数据（M5a/M5b 已交付），不需要 M5d 的封面纹理管线 |
| 轮子检索 | ①完整应用：Wallpaper Engine 壁纸宿主已有"工作台/展示"双模切换先例（`src/wallpaper.ts`），但那是**同一窗口的内容切换**，不是独立小窗，不能直接拄；②系统原生：WPF `WindowStyle=None` + `AllowsTransparency` + `Topmost` + `ResizeMode` 全 BCL，**零新依赖**；③专用库：无必要（引 WinUI/MAUI 只为一个小窗属架构级扩张）；④自写：~150 行 XAML/C# 胶水即可 |
| 风险 | M5d 已是 M5 最大件（2 轮），再挂一个宿主窗口 = 单轮背两个高风险域，违反 GOAL-AUTONOMY §2 每里程碑一轮的泳道纪律 |

**结论**：M5d 只做"打开专辑"的图标占位（`data-action="mini-window"` 按钮，点击回
`not_implemented` 或 toast「小窗模式将在下一里程碑提供」），实装进 **M6 §4**。
若用户希望 M5d 内就见到小窗，则 M5d 预估从 2 轮上调到 2.5 轮，并把 M6 的窗口宿主项前置——需显式点头（停点 P-6）。

## 6. M5b / M5c（保持 v1 范围，补齐可验收化）

### 6.1 M5b 歌词
- 目标：内嵌（FLAC Vorbis `LYRICS`/`UNSYNCEDLYRICS`、MP3 USLT）与旁挂 `.lrc` 取文 → 前端逐行时间轴
  渲染（原文/译文双行同时间轴，用户已改标准格式，**零拆句**）+ SMTC `Thumbnail` 补 M3 欠账。
- 文件：`host/RhineShell/Library/Lyrics.cs`（取文 + 旁挂探测，`lyric_embedded`/`lyric_path` 已在 schema）、
  `src/player/lyrics/{lrc.ts,lyric-view.ts}`、`host/RhineShell/Smtc/SmtcManager.cs`
  （现 `SmtcManager.cs:305` 有 track_id scheme 分支，封面挂载点在此）。
- 协议 v1.4 增量：`library.get` 的 `lyric_text` 字段（已在 §4.3）；`evt{kind:"lyric"}`
  （`{track_id,line_no,primary,secondary,start_ms,end_ms}`，前端驱动、壳转发给 M5c writer）。
- 验收：
  1. `lrc.ts` 单测（node，纯函数）：标准双行、`[mm:ss.xx]`/`[mm:ss.xxx]`、多时间标签、
     元信息行（`[ar:]`/`[by:]`/`[ti:]`/`[offset:]`）过滤与偏移、乱序时间轴归并、空行不产帧 → 全绿；
  2. 真库抽样：`--cli-lyric "<某 flac 路径>"` 输出前 5 行时间戳单调；无词曲 → `lyric_state:"none"`；
  3. SMTC：`tools/m3-smoke` 扩展断言 session `Thumbnail != null` 且 `DisplayProperties.Title`
     为真标题（不再是文件名占位，M3 任务书 §B.1 的占位在此还账）；
  4. 三绿 + m1-scenario ALL PASS。
- 预估：worker **1 轮**。

### 6.2 M5c 任务栏 writer + watcher + 收藏迁移
- 目标：`evt{lyric}` → 冻结协议 writer（`\\.\pipe\go-musicfox.lyric.v1`，只发 `{type:"lyric",
  primary,secondary}`，**不发 config**，Q4 裁定）；FileSystemWatcher 500ms 去抖增量 + 夜间全量
  reconcile；`localStorage:rhine-saved` → `user_state` 一次性导入。
- 文件：`host/RhineShell/Taskbar/TaskbarLyricWriter.cs`、`host/RhineShell/Library/Watcher.cs`、
  `host/RhineShell/Library/UserState.cs`；配置键 `taskbar.enabled`/`taskbar.pipe`（§15 已定形）。
- 验收：
  1. writer 单测（壳侧 `RhineCoreTests` 或新 `LibraryTests`）：模拟前端 3 帧 → 管道收到合法
     JSON Lines；插件未装 → 静默退避（≤5s 封顶）、日志无 error 级；
  2. 真机（无人值守可做）：`--cli-taskbar-dump` 起一个假读端，断言收到帧；
  3. watcher：新建/改/删各 1 文件 → 500ms 后 DB 行数/内容正确（`--cli-watch-test` 自测开关）；
     一次删 200 文件（模拟拔盘）→ 去抖合并为 1 次 reconcile，不出现 200 次单文件重扫；
  4. 收藏迁移：预置 `rhine-saved` → 首启后 `user_state` 行数一致、localStorage 键标记已迁移不重复导入；
  5. 三绿 + m1-scenario ALL PASS。
- 预估：worker **0.5 轮**。

## 7. 风险清单（v2：**先检索/实测，再写结论**）

### 7.1 FTS5 `unicode61` 对 CJK 的真实行为 —— 实测证伪 v1 假设

**方法**（本机可复现，WSL sqlite3 3.46.1）：
```bash
sqlite3 /tmp/fts.db "CREATE VIRTUAL TABLE t USING fts5(title, tokenize='unicode61');
INSERT INTO t VALUES('光るなら'),('岁月如歌'),('时代曲(Melody of Time)'),('Eason Chan 陈奕迅');"
# 逐条：MATCH '光るなら' / '岁月' / '岁' / '陈奕迅' / '陈*' / '如' / 'ody' / 'Melody'
# 再建 tokenize='trigram' 表重放同批查询
```
**实测结果**：

| 查询 | unicode61 | trigram |
|---|---|---|
| `光るなら`（整串） | ✅ 命中 | ✅ |
| `岁月`（连续两字，词中） | ❌ **0 命中** | ❌（<3 字符，见下） |
| `岁`（单字） | ❌ 0 命中 | ❌ |
| `岁月如歌`（整串） | ✅ 命中 | ✅ |
| `如`（夹在两词之间） | ❌ 0 命中 | ❌ |
| `陈奕迅`（整串，前面有拉丁词） | ✅ 命中 | ✅ |
| `陈*` / `岁*` / `光る*`（前缀） | ✅ / ✅ / ✅ | ✅ |
| `Melody`（拉丁整词） | ✅ | ✅ |
| `ody`（拉丁子串） | ❌ | ✅ |
| `MELODY`（大小写） | ✅（caseless 默认） | ✅ |
| 多列 `title:岁月` 列过滤 | — | ✅（3 字时） |

**结论（三条）**：
1. `unicode61` 把**连续 CJK 串当作一个 token**（不做字/词切分）→ 只有"整串相等"或"前缀"能命中，
   用户搜"岁月"搜不到"岁月如歌"。**v1 §4 验收 2（查"月色"命中）在 unicode61 下必失败**——
   实测 `月色` 若在正文中间则 0 命中。
2. `trigram` 能覆盖 CJK 与拉丁的**任意 ≥3 字符子串**，且大小写不敏感、支持列过滤；
   **硬限制：查询串 <3 字符不匹配**（实测 `岁月`(2) 与 `岁`(1) 均 0 命中）。
   中文 2 字词（"月色"、"后来"）是**高频真实场景**，不能忽略。
3. 因此 v2 采**三路径路由**（`Search.cs`，~60 行自写，理由见 §1.1）：
   - `len(kw) >= 3` → `tracks_fts`（trigram）；
   - 拉丁整词/前缀 → `tracks_fts_w`（unicode61，`kw*`）；
   - `len(kw) < 3` 且含 CJK → `tracks` 上 `LIKE '%kw%' COLLATE NOCASE`（436 行，实测全表扫 <1ms）。
   合并去重后按（列优先级, 专辑, 曲目号）排序；`LIMIT` 200。

**残余风险与验证方法**：
- **R-7.1-a 发行版 SQLite 是否编入 trigram**：trigram tokenizer 是 SQLite **3.34.0(2021)** 引入的
  FTS5 内建件。`SQLitePCLRaw.bundle_e_sqlite3 3.0.5`（2026-07-27 发布）依赖包 `SQLite` **3.53.4**
  （证据：`gh release view v3.0.5 -R ericsink/SQLitePCL.raw` 正文 "Update the lib dependency …
  to package ID `SQLite` version 3.53.4"）→ 远大于 3.34，**判定可用**。
  `Microsoft.Data.Sqlite` 最新稳定 **10.0.12**（NuGet flatcontainer 实测），传递依赖 SQLitePCLRaw 3.x。
  **验收法**：M5a 首条命令即 `--cli-sqlite-probe`，打印 `sqlite_version()`、
  `PRAGMA compile_options`（须含 `ENABLE_FTS5`）、并**实际建一张 trigram 表插一行查一次**，
  三项任一失败即停手上报（不许静默退化成 LIKE-only）。
- **R-7.1-b 外部内容表触发器写错 → 索引与正文漂移**：验收加一条 `--cli-fts-verify`，
  随机抽 30 曲，断言 trigram 索引命中集与 `LIKE` 全扫命中集**完全一致**（3 字以上关键字）。
- **R-7.1-c 假想扩张**：不做拼音、不做繁简转换、不做纠错（用户搜错字不在承诺面）；
  如后续要拼音，属新需求，另立工单（§10 建议）。

### 7.2 TagLibSharp2 quarantine 设计（v1 只有一句"记入表 + 诊断页可见"，v2 定形）

- **触发面**（只读，永不写回用户文件——产品红线）：`MediaFile.CreateFromInformation`/
  `ReadFromBinaryData` 抛异常（含 `CorruptFileException`）、返回 null、超时（单文件 5s 上限）、
  或返回的 `Properties.Count` 与文件 size 明显矛盾（0 字节 / 时长 0 但 size>1MB）。
- **表**：`quarantine(path PRIMARY KEY, reason, mtime, size, seen_at, attempts INT DEFAULT 1)`。
- **行为**：quarantine 命中 → **不写 tracks、不删 tracks 旧行**（若之前成功读过则保留旧行并打
  `stale` 标记，避免一次读失败把已入库数据清空）；同 `(path,mtime,size)` 已 quarantine 则
  `attempts+1` 不重复记录；扫描继续，**绝不因单文件失败中断整轮**（M2-FINDINGS 的"不崩溃"纪律同源）。
- **可见性**：`library.stats.quarantine` 计数 + `--cli-quarantine` 列出前 20 条（路径/原因）+
  M6 诊断页展示（§M6-PLAN 诊断页含 quarantine 项）。
- **选型失败判定**（v1 遗留，v2 定形）：全库扫描 `failed / total > 0.5%`（1116 → >6 个）→
  **停点 P-3**，不自行换库；处置预案（届时才做）：TagLib# 独立 dll（LGPL，需用户点头）
  或自写 FLAC/MP3 头读取（~200 行，最后手段）。
- **R-7.2-a 年轻库（0.6.0、~30★、最后推送 2026-07）API 漂移**：M5a 只依赖
  `File/AbsFile.Create(path, ReadStyle.Partial)` → `.TagFacade`（Title/Artist/Album/AlbumArtist/
  Year/Genre/Track/Disc）+ `.Properties`（CountTime/AudioBitrate/AudioSampleRate/AudioBitsPerSample/
  AudioChannels）+ `.TagLib.Pictures`（Type=CoverFront）+ Vorbis `LYRICS`。
  **验收**：把这些调用集中到一个 `TagReader` 适配器类（唯一接触面），万一换库只改一个文件。

### 7.3 超级性能模式下的降级策略（与上游既有开关对齐，不新造）

| 上游件 | 超级模式现状 | M5d 策略 |
|---|---|---|
| 渲染比例/DPR/总像素 | 60% / DPR≤1 / ≤921600px（`scene.ts:94 setSuperPerformance`） | 不变 |
| 阵列阴影/AO/景深/SMAA | 关闭，直出主场景 | 不变 |
| 阵列材质折射/清漆 | 无折射无清漆、隐藏小螺丝 | **封面纹理同时降级**：512²→256²、`maxTextures` 24→12、预算 96→32 MiB |
| 全局屏幕滤镜（色散/暗角/颗粒） | 停用 | 不变（封面受影响自动消失） |
| HUD 曲面投影 + 鼠标追踪 | 保留 | 保留（专辑墙 UI 浮层同样投影） |
| DOM 文字分辨率 | 不降 | 不降（字段表/歌单文字必须始终清晰） |
| 新增 | — | `covers` 三态开关（纹理/仅选中卡/关闭），超级模式下默认"仅选中卡"，用户可覆盖 |

**验收**：`node scripts/check-super-performance.mjs` 仍绿 + 新增断言：超级模式下
`renderer.info.memory.textures <= 12` 且封面纹理尺寸 == 256。

### 7.4 其余风险（简表）

| # | 风险 | 对策 |
|---|---|---|
| R-7.4-a | 首扫 44GB 时磁盘 IO 打满导致播放卡顿 | 扫描线程 `ThreadPriority.BelowNormal` + 并发度 4（可配）；播放中收到 `library.scan` 则排队（`library_busy`） |
| R-7.4-b | `ma_pcm_rb` 无 peek → 未来 M4/频谱想读未消费数据 | 已确认当前无调用者（§4.5 债 1）；若 M4 需要，改用**独立 tap 环**（回调侧 push，与主环解耦），不回滚到自写 ring |
| R-7.4-c | kissfft 的 `kiss_fftr` 输出 bin 数 = N/2+1，与现 `fft_[bin]` 索引不同 → 带映射偏移 | 改后断言 64 带边界索引不变（`spectrum.cpp:157-161` 的 startBin/endBin 计算保持），A2 数值等价验收兜底 |
| R-7.4-d | 列数 5→7 破坏循环阵列（`LOOP_COLUMNS=9` 是可见窗口，`archiveColumns.length` 是数据列） | 区分两个常量：数据列数动态、可见窗口容量固定；`check-loop.mjs`/`check-array-input.mjs` 兜底（§5.8-3） |
| R-7.4-e | WebResourceRequested 自定义 host 在 WE（壁纸）构建下的可用性 | M5d 验收含 wallpaper 构建一次（`npm run build:wallpaper`）；失败即走 base64 退路并记 FINDINGS |
| R-7.4-f | 上游 40 档案内容与音乐库语义混淆（两套数据同时存在） | 明确：web 模式=演示档案（只读 fixture），desktop 模式=真库；同一套 UI 代码，由 `bridge.desktop` 分流（`desktop-bridge.ts:122`） |
| R-7.4-g | 任务栏管道与 musicfox 同时运行抢显示 | 配置键 `taskbar.pipe` 已可错开（§15）；启动时检测同名 session 存在 → 设置页提示（M6 设置面） |

## 8. 停点清单（goal 遇到即停，报告后等待）

| # | 停点 | 触发时机 | 交什么 |
|---|---|---|---|
| **P-1** | **M5d 需修改上游 `src/scene.ts` / `src/main.ts`**（封面 map 槽、DOM 骨架与文案、导航动态化） | M5d 开工前 | 本 §5.3/§5.4/§5.7 的改动清单；GOAL-AUTONOMY §5.3 铁律要求显式点头 |
| **P-2** | 视觉与听感验收：35 专辑墙滚动帧率与封面清晰度、详情页解密遮罩在字段表上的观感、歌词滚动观感、真曲首次出声 | 各里程碑编码完成后 | 截图 + CDP 数据 + 待确认清单（GOAL-AUTONOMY §5.1） |
| **P-3** | TagLibSharp2 全库失败率 >0.5% | M5a 验收 8 | 失败样本清单 + 三条处置预案（TagLib# LGPL / 自写头读取 / 换库）供拍板 |
| **P-4** | 发行版 SQLite 无 trigram / 无 FTS5 | M5a 验收 `--cli-sqlite-probe` | 停手，转 LIKE-only 或换 bundle 的决策 |
| **P-5** | 封面通路（WebResourceRequested）不可用且 base64 退路过重 | M5d | 二选一：2D 网格降级 / 自定义 scheme |
| **P-6** | 小窗模式归属（见 §5.10 建议）与窗口宿主改动 | M5d 收尾 | 用户确认归 M6 |
| **P-7** | 任何"新需求"苗头（拼音检索、在线歌词、cue、播放列表编辑） | 全程 | 记 `docs/OPEN-DECISIONS.md` 攒批，不猜（GOAL-AUTONOMY §5.2） |

## 9. 待用户拍板（v2 重编号）

- **M5-Q1**（关闭）：LGPL → TagLibSharp2 MIT，v1 已定，v2 维持。
- **M5-Q2**（关闭）：曲库 UI = 专辑墙 + 详情页，v1 已定，v2 展开为 §5。
- **M5-Q3**（关闭）：YRC 不做，v2 从自造清单移除。
- **M5v2-Q1**：批准 M5d 修改上游 `src/scene.ts`/`src/main.ts`（停点 P-1）？
- **M5v2-Q2**：批准"阵列卡片素面、仅选中卡贴封面"（与设计稿一致，代价最小）？
  若要"整墙都显示封面"，需纹理图集方案，工作量 +1 轮。
- **M5v2-Q3**：接受 §7.1 的三路径检索路由（含 <3 字 CJK 走 LIKE）作为 v1 承诺？
- **M5v2-Q4**：技术债归还（ring/FFT）是否**并入 M5a 同轮提交**（v2 建议：是，各自独立 commit，
  便于回滚）？
- **M5v2-Q5**：小窗模式归属（v2 建议：**M6**，理由见 §5.10）。

## 10. 建议（不属于 M5 范围，另列，不实现）

1. 拼音/首字母检索（"cyrg"→岁月如歌）：需拼音库或自写映射表，属新需求。
2. 播放列表编辑与拖拽排序：`playlists`/`playlist_items` 表已在 §16 设计，UI 未立项。
3. 整轨 cue 支持：AUDIO-ENGINE §12 实测本机 cue=0，v2 不排期。
4. 在线歌词匹配：GOAL-AUTONOMY 纯本地裁定域，需用户解禁。
5. 纹理图集（atlas）整墙封面：若 M5v2-Q2 选"整墙"，建议单开 M5e。
6. ReplayGain 响度均衡：`gain_track/gain_album` 列已留，处理图属 M4/DSP 域。

---
*本文件仅为计划，未做任何实现/构建/提交。v1（`docs/M5-PLAN.md`）保留作选型检索记录存档，
其 §1/§1.1 结论继续有效，冲突处以本 v2 为准。*
