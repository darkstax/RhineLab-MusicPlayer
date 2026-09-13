# M5 计划书（轮子版）：曲库 + 歌词 + 任务栏歌词

> 状态：**草案，待用户过目——未开工** · 2026-09-13
> 前序：M2 完成（真核心出声）；M3 代码已全部写盘+三构建绿，剩验收 1-6 与提交（恢复后先收尾）。
> 本计划书的最高纪律：**能用的轮子绝不重写，必须自造的只剩三小块**（无轮子可用，见 §2）。

## 0. 为什么轮子路线成立

M5 的四个子域（元数据/DB/watcher/歌词解析）在 .NET 生态全有十年以上的成熟件，且全部落在
**壳侧（C#）**——正是轮子最厚的语言。前端只消费 JSON，不引框架。

## 1. 选型表

| 子域 | 轮子 | 版本/许可 | 用途 | 备注 |
|---|---|---|---|---|
| 音频元数据 | **TagLibSharp2**（clean-room 重写，非 TagLib# 衍生） | **0.6.0，MIT** ✅ | FLAC/MP3/WAV 的标题/艺术家/专辑/年份/曲目号/时长/码率/位深/**封面**/**内嵌歌词**（FLAC 走 Vorbis Comment 任意字段，含 `LYRICS`）/ReplayGain；异步 I/O + Span<T> 零分配解析，.NET 8/10 多目标 | 检索结论见 §1.1；风险与对策见 §1.2 |
| 数据库 | **Microsoft.Data.Sqlite** | 9.x，MIT | 曲库表 + **FTS5** 全文检索（SQLitePCLRaw bundle 默认编入 FTS5） | schema 直接照 AUDIO-ENGINE §16，删去 v1 不用的列 |
| 目录监听 | **FileSystemWatcher**（BCL） | MIT | 曲库根目录增量变更，500ms 去抖 + 全量 reconcile 兜底 | 零新依赖 |
| 封面渲染 | **WPF BitmapImage**（BCL） | MIT | SMTC `Thumbnail`（M3 欠账）+ 播放条/专辑墙封面 | TagLibSharp2 的 IPicture 字节流 → MemoryStream 直接构造 |
| LRC 解析 | 前端 ~60 行 TS（**不算轮子**，但也不越 100 行） | — | 内嵌歌词主体格式（TagLibSharp2 交付原始文本，时间轴解析在前端） | npm 上的 lrc 解析包质量参差且都要再转一层，规则就是逐行正则；水印行过滤（`[by:...]`）反正要自写 |
| 任务栏管道 | **System.IO.Pipes**（BCL） | MIT | 冻结协议 writer：`\\.\pipe\go-musicfox.lyric.v1` JSON Lines，`{type:"lyric",primary,secondary}`；退避重连（musicfox 参数：封顶 5s）；**只发 lyric 帧不发 config**（Q4 裁定） | 样式归 Taskbar-Lyrics 插件端；配置面=开关+管道名两项 |
| 虚拟列表 | **TanStack Virtual**（若需要） | MIT | 歌单/专辑墙长列表 | 1116 曲不上虚拟列表；>5k 时再启用，预留组件边界 |

**净新增 NuGet 依赖：2 个**（TagLibSharp2、Microsoft.Data.Sqlite）。其余全 BCL。

### 1.1 元数据轮子检索记录（2026-09-13，M5-Q1 已因此关闭）

| 候选 | 许可 | 音频标签能力 | 判定 |
|---|---|---|---|
| TagLibSharp 2.3.0 | LGPL-2.1 | 全 | ✗ 用户要纯净性，LGPL 出局 |
| MetadataExtractor 2.9.3 | Apache-2.0 | 偏 EXIF/图像；音频 Vorbis 注释/歌词/封面支持弱 | ✗ 能力不够 |
| **TagLibSharp2 0.6.0** | **MIT** | 格式矩阵覆盖 MP3/FLAC/Ogg/WAV/MP4/DSF…；封面/歌词(Vorbis Comment)/ReplayGain/MusicBrainz 全绿；异步+Span | ✅ **选定** |
| music-metadata (npm) | MIT | 能力最强但 JS——要进 WebView 解析或起子进程，破坏"元数据在壳侧"分层 | ✗ 架构不合 |
| 自写 Vorbis Comment 读取 | — | FLAC 块结构确实简单 | ✗ 轮子已有，不重复造 |

### 1.2 TagLibSharp2 风险登记（年轻库，诚实备案）
- v0.6.0、~30★、最后推送 2026-07：非久经沙场。缓解：我们**只读不写**（写标签永不碰用户文件，
  这本身也是产品红线）；API 面窄（File.ReadAsync→Tag/Properties/Pictures/Lyrics）；
- **兜底预案**（不预写，触发才做）：扫描器把 TagLibSharp2 异常文件记入 quarantine 表 +
  诊断页可见；若大面积不可用再评估回 TagLib#（LGPL 独立 dll 姿势）或自写 FLAC 头读取（~200 行，最后手段）。
- M5a 验收加一条：对 `C:\Users\StarL\Music` 全库跑一遍，**读取失败率 <0.5%** 才算轮子选型成立。

## 2. 仅剩的两块自造（轮子检索无果/用户裁定，确认为必要自研）

| 件 | 规模 | 为什么没有轮子 |
|---|---|---|
| **YRC 逐字歌词解析** | ~150 行 TS | 网易云私有格式，npm 无维护良好的解析包；语义直译 musicfox `yrc.go`（词级时间戳/行结构/容错），顺带白嫖它的测试语料。**M5-Q3 用户未点头前不做**（内嵌歌词主体是 LRC，TagLibSharp2 直接交付文本） |
| **扫描编排** | ~250 行 C# | 并行枚举→TagLibSharp2 读取→upsert SQLite→watcher 增量的调度逻辑本身，各件都有轮子、编排没有 |

~~行内双语拆句~~ **已取消（用户裁定 09-13）**：用户会自行把曲库内嵌歌词改成标准双行格式
（同时间轴原文行+译文行），歌词渲染只需按普通 LRC 逐行显示，零拆句逻辑。
合计自研 ≤450 行（YRC 不做则 ≤250 行），其余全是胶水。

## 3. 数据流与模块边界

```
[壳 C#] Library/
  Scanner.cs      根目录(多)并行枚举 → TagLibSharp2.MediaFile.ReadAsync 读元数据+歌词字段+封面哈希
                  → Microsoft.Data.Sqlite upsert（mtime+size 未变则跳过）
  Watcher.cs      FileSystemWatcher 去抖 → 单文件重扫/删除标记；夜间全量 reconcile
  LibraryApi.cs   cmd: library.scan / library.query{filter,sort,limit} / library.get{id}
                  → JSON 给前端（元数据+歌词文本+封面路径，不含音频流）
  TaskbarLyric.cs 订阅前端 lyric 帧（见下）→ 冻结协议 writer
[前端 TS] src/player/lyrics/
  lrc.ts / yrc.ts（自研两件之一，YRC 待 M5-Q3）
  lyric-view.ts   当前行高亮 + 逐字（有 YRC 时）+ 原文/译文双行同时间轴自然呈现（用户改库为标准格式，零拆句）；复用上游滚动/解密视觉语言
  歌词文本经 bridge 上行壳（evt 通道 cmd: lyric.show{primary,secondary}）→ TaskbarLyric 转发
[DB] %LOCALAPPDATA%/RhineMusic/library.db
  tracks(...AUDIO-ENGINE §16 精简版, +lyric_embed TEXT, +cover_key)
  tracks_fts(FTS5)  playlists 延到 M6+
```

- 播放联动：`engine.play` 的 `track_id` 升级为支持 `lib:<track_id>`（核心经壳回调取路径？
  **不**——保持核心简单：壳把 `lib:` 解析成 `file:` 路径再转发核心，协议零改动）。
- 收藏/历史：上游 `rhine-saved` localStorage 一次性导入 DB（M0 计划内旧账）。

## 4. 验收（全部真机、无人值守可跑）

1. **首扫**：`C:\Users\StarL\Music`（1116 文件/44GB）全量入库，计时断言 <30s（并行 TagLibSharp2
   只读头尾不读音频体）；二次启动 reconcile <2s（mtime 跳过）。
2. **检索**：FTS5 查询"光るなら / 月色 / RADWIMPS"命中；中文拼音不承诺（LIKE 兜底）。
3. **播放闭环**：列表点曲 → `lib:` → 核心出声（听感仍列停点）→ SMTC 卡片带封面（补 M3 欠账）。
4. **歌词**：内嵌曲（如 光るなら.flac）显示原文/译文双行（用户改库后标准格式）+水印行已滤；无词曲显示元数据占位；
   YRC 用例用测试语料（musicfox 单测数据移植）断言词级时间轴。
5. **任务栏**：Taskbar-Lyrics 插件在装时实测滚动歌词出现（冻结协议兼容性 = 连上即显示，
   无需我方样式帧）；插件未装时 writer 静默退避不报错。
6. 回归底线三绿 + m1-scenario 桩裁判 ALL PASS（协议面不破）。

## 5. 里程碑拆分与预估（goal 恢复后执行）

| 子步 | 内容 | 预估 |
|---|---|---|
| M5a | Scanner+DB+LibraryApi+列表 UI（先不歌词） | worker 一轮 |
| M5b | 歌词三件（lrc/yrc/split）+ lyric-view + SMTC 封面补账 | worker 一轮 |
| M5c | 任务栏管道 writer + watcher 增量 + 收藏迁移 | 半轮 |
| **M5d** | **专辑墙 UI（用户设计稿 09-13）**：卡片封面纹理管线（最大件 ~1 天）、阵列数据源 archives.json→DB（协议加 library.albums）、详情 DOM 重排（字段表+歌单/介绍页签，复用 model-viewer 做封面 360°）、导航语义重映射（列=流派/行=专辑/页码器）、打开专辑转场复用抽取动画；小窗模式可后置 M6 | worker 一轮+审查 |
| M5-r | reviewer 审查 + P1 修复 | 一轮 |

## 6. M6 轮子预告（到点照此办，不再展开）

- 打包：**dotnet publish（框架依赖）** → zip 用 `Compress-Archive`/7z；exe 安装器 **Inno Setup 6**
  （免费，ISC 类许可）或 **WiX 7**（MIT）——推荐 Inno，脚本 20 行；
- updater：**v1 不做**（本地自用，GitHub Releases 手动更；留 `update.url` 占位）——M6-Q1 确认；
- 设置三层 UI/信号路径图：纯前端组件（吃 negotiated/diag 现成数据），无新依赖；
- LICENSE 换 MIT + 全部依赖许可证清单进 `THIRD-PARTY-NOTICES.md`（轮子越多这份越要机器生成：
  `dotnet-project-licenses`（MIT 工具）一键出）。

## 7. 待你拍板（M5 专属，开工前一问）

- **M5-Q1**：~~LGPL 接受与否~~ → **已关闭（09-13 检索轮子）**：改用 TagLibSharp2（MIT，见 §1.1）。
  残余风险登记 §1.2（年轻库，只读面+quarantine 兜底+全库失败率 <0.5% 验收卡）。
- **M5-Q2**：✅ 定（09-13 设计稿三张 + 用户确认）——曲库 UI = **专辑墙（3D 阵列改造）+ 详情页**，
  不做简单列表过渡态；新增 **M5d** 里程碑（见 §5）。设计稿里的 M4A/AAC 为稿子随手画，
  库内无 M4A，**v1 解码范围不变（FLAC/MP3/WAV）**。
- **技术债登记（轮子优先铁律的自查产出，09-13）**：手写 ring.{h,cpp} → 换 miniaudio 自带
  `ma_ring_buffer`；M3 手搜 FFT → 换 kissfft（BSD 单文件）。均限单文件改动，冒烟回归即可，
  并入 M5a 顺手做。
- **M5-Q2**：曲库 UI 形态——简单列表+搜索框（v1 够用）还是专辑墙分组（多半天）？
- **M5-Q3**：YRC 逐字（你库内嵌歌词是 LRC 格式，YRC 只在想接网易云导出词时有用）——
  照做、还是降级 v2 省掉那 150 行？（你已改标准双行格式后，此问更倾向"不做"）

---
*本文件仅为计划，未做任何实现/提交。M3 的 19 个未提交文件保持原样等恢复。*
