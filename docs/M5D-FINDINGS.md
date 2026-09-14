# M5d FINDINGS — 专辑墙（接管完成：DOM/语义重映射 + 详情页 + 接线 + 验收 1-7）

> 任务书：`docs/M5D-PLAN.md`（步骤 3/4/5 + 验收）；上游设计映射 `docs/M5-PLAN-v2.md` §5；
> 曲库实况 `docs/M5A-FINDINGS.md`。执行：pi-bg 泳道 laneD2（qwen3.8-flash xhigh，接管中断的 laneD）。
> **只写盘未提交**（护栏 3），提交切分建议见 §7。证据文件：`verification/m5d/`。

## 0. 结论速览

| 验收项 | 结果 |
|---|---|
| 1 构建三件套（`tsc` + `npm run build` + `check-shell.mjs`）+ `m-verify -Level quick -NoCache` | ✅ 三绿；VERIFY PASS (46s)，六步全 PASS |
| 1b `check-content.mjs`（archives.json fixture） | ✅ PASS（fixture 未删未改） |
| 2 web 模式回归（boot→阵列→详情） | ✅ 旧文案逐字节保持（`FILE NUMBER: `、`INTERNAL DATABASE`、`COLUMN 03 / 05`、四字段表、三页签、`NO.001`、360° 入口可见、页脚 JOYCE MOORE）；pageerror=0；截图 `web-{boot,array,detail}.png` |
| 3 desktop CDP（壳 9242 / 管道 rhine-music.m5d / 真库 344 专辑） | ✅ 全断言 allOk=true：stats、GENRE 01/11、选中卡 map 非 null、浮层字段=DB、歌单行数=track_count(3)、点行→`lib:2135` playing（engine.state 回显）；`m5d-cdp-assert.json`/`m5d-assert2.json`/`m5d-final.json` |
| 4 阵列交互回归 + 参数化单测 | ✅ `data.test.mjs` 7/7（web 基线 lane*32+row 逐点等值 + 7 列 35 专辑 + 290 大列步长 + 循环回绕 + truncated + 空库回退）；`covers.test.mjs` 12/12；`library-store.test.mjs` 4/4；上游 node 类 check 全 PASS；playwright 类见 §5 环境说明 |
| 5 降级路径 + 纹理稳态 60s | ✅ 三态切换（textures/selected/off）+ 强制降级显示原因 + 滞回手动恢复 + `config.set wall.covers` 持久化（重启复验）全过；60s 稳态 `renderer.info.memory.textures` 28→33 有界振荡（LRU cache 恒 ≤24、bytes 恒 24,660,432、evictions=29、failures=0）——**非泄漏增长**，判定见 §4.2 |
| 6 帧时间中位数（开/关封面各一轮） | ✅ 开=27.95ms / 关=34.80ms（swiftshader 软渲染，绝对值无意义；**封面未引入额外成本**，off 反而慢因控制窗口强制摘纹理触发材质重编译）；超级性能预算减半由 `covers.test.mjs` 单测证明（12/32MiB/256²） |
| 7 中文提交切分建议 | ✅ 见 §7 |

真库实况：albums=344（水合后 records=339：5 张 track_count=0 的空专辑被过滤，见 §3.1）、genres=13（归并后展示列=11）、tracks=1116。设计稿"35/7/436"为自选子集口径，M5A-FINDINGS §6.6 已裁决走动态列数——本实现零硬编码。

## 1. 交付文件清单

**新增**
- `src/player/covers/album-wall.ts` — 封面生命周期管理器：CoverTextureCache 持有 + 换绑竞态票据 + ±2 预热（仅 textures 态）+ wall.covers 三态（desktop 走 `config.get/set` 壳自答、web/壁纸回退 localStorage `rhine-wall-covers`）+ 1Hz 降级观测挂接 + `__rhineCovers` CDP 探针（snapshot/setUserMode/forceDegrade/control/controlFinish）+ `wallSession.hydration` 水合时序握手（m1-mount→main 的 rendezvous，web 模式=已 resolve 的 Promise 零延迟）
- `src/data.test.mjs` — 参数化单测 7 例（验收 4）
- `src/player/covers/covers.test.mjs` — 预算/阶梯/五条件/滞回单测 12 例
- `verification/m5d/*` — 截图与断言 JSON 证据（16 件）

**修改**
- `src/main.ts` — ①文案表 `wallCopy()`（ARCHIVE→ALBUM、COLUMN→GENRE、ENTER 读取→打开专辑、返回专辑架、拖动卡片查看完整封面、MUSIC ARCHIVE eyebrow；web 未水合=旧字逐字节）②DOM：浮层新增 `.callout-sub`（艺术家行）/`.callout-meta`（year/曲目数/总时长）/`.wall-badge`（formats[0] 大写角标）、`#column-total` 动态、`#file-ticks` 滑窗重建（TICK_WINDOW=24，Arknights 290 列实测跟随）、页脚 `#footer-stats`（`LOCAL COLLECTION · N ALBUMS / M TRACKS`，水合态替换 JOYCE MOORE 位）③详情页：`wallDetailMarkup` 八字段 `<dl>`（RELEASE/ARTIST/GENRE/VOLUMES/FORMAT/RESOLUTION/BITRATE/DURATION，null→"—"）、页签 01 歌单 / 02 专辑介绍（`setTab` 双分支）、歌单行（序号/标题/艺术家/格式/时长，点击→`playerStore.play("lib:<id>")`，`library.query scope=tracks filter.album` 异步回填 + 前端按 album 全等收紧 LIKE 子串）、`exportAlbumTracks()` 前端 Blob 导出曲目清单、**360° 入口水合态隐藏**（无专辑 GLTF，不假称有）④`select()` 驱动 `albumWall.onSelectionChanged`、frame 循环 `albumWall.frameSample`、`start()` 先 `await wallSession.hydration` 再建阵列、`bindScene`/`releaseThree` 接 attach/detach、`savePrefs` 同步超级预算、设置新增"专辑墙封面"三态 + 降级原因显示⑤`rhine.stats().wall` 探针（hydrated/columns/records/selectedRecord/columnFiles/cover）
- `src/m1-mount.ts` — desktop 分支：`wallSession.hydration = hydrateFromLibrary(bridge)`（caps 无 library 的旧壳/桩内部 stats 失败回退演示数据，不抛异常）+ `albumWall.loadConfig()` + **`mountLibraryPanel()`（M5A-FINDINGS P2-5 归还：面板从未被 import，现已接线）**
- `src/player/covers/degrade.ts` — 构造函数参数属性改显式字段（node strip-only 测试环境兼容；行为零变化）
- `src/style.css` / `src/theme.css` — M5d 组件段（浮层两行、角标、track-list/track-row、八字段表微调、设置三态、暗色映射）
- `src/scene.ts` — **零改动**（前任的 setCoverTexture 槽保持原样；曾试 lane-2 列中心参数化，经分析被相机跟随抵消且属越权，已回退）

## 2. 验收 3 桌面 CDP 断言明细（`verification/m5d/m5d-final.json` 等）

- 环境：壳 `dist-host\RhineShell.exe --pipe rhine-music.m5d --remote-debug-port 9242 --dist work\web\dist`；stub 核心；webview2 userData 已清（教训复用：不清缓存 = 旧 bundle 假失败，本泳道踩过一次）。
- `library.stats` = {albums:344, tracks:1116, genres:13, quarantine:0} ✅（设计稿 35/436/7 为自选子集，动态列数吸收差异）
- 水合：records=339 / columns=11（casefold 归并 Anime+anime、未分类垫底；列按专辑数降序，World/Arknights 居首）
- GENRE 文案：`GENRE 01 / 11`（正则 `^GENRE \d{2} \/ \d{2}$` 过）；←→ 十步切列无尽头、每列记忆恢复（A-001→lane3→回 lane0 同记录）
- 选中卡封面：`coverMapped=true`、cache size 3→24（LRU 上限）、targetEdge 512、failures=0
- 浮层一致性：UI 标题/艺术家/year/曲目数/总时长/角标 ≡ `library.query scope=albums q=<title>` 命中的 AlbumDto（火蓝之心原声带 / 塞壬唱片-MSR / 2019 / 3 首 / 6:23 / MP3）
- 详情页：8 个 `<dt>`、tabs=[tracks,intro]、**歌单行数 3 == track_count 3**、无空字段（null→—）、360° 入口 display:none、返回文案"返回专辑架"
- 点行播放：`engine.state` → `{track_id:"lib:2135", state:"playing", position_ms:2206 推进}`（壳回显 lib: 前缀，听感停点按任务书只验状态）
- 设置三态：入口 3 按钮（纹理/仅选中卡/关闭）、点"关闭"→ effective=off + coverMapped=false + config.set 持久化（重启后 boot 读到 off，实测复现）；forceDegrade("textureLeak") → 设置 note 显示"⚠ 纹理计数在 60 秒稳态观测中持续增长…"；改回 textures = 滞回手动恢复 ✅

## 3. 数据面实况与实现决策（禁硬编码核对）

### 3.1 records=339 ≠ stats.albums=344
`hydrateFromLibrary` 过滤 `track_count > 0`（空专辑无卡可翻）。**页脚统计直读 `library.stats`（显示 344/1116），阵列用 339**——两处口径不同是有意为之：统计条回答"曲库有什么"，阵列回答"能翻什么"。FINDINGS 备案；若 M6 要求一致，改 stats 直读过滤数即可（一行）。

### 3.2 大列截断（truncated）
`library.albums` limit≤200 且无 offset（协议 v1.4 实况）：Arknights 列 290 专辑 → 分片补齐后仍可能缺尾（genre 分片 + 逐年切片已尽力）。实测 `wallMode.truncated` 在真库为 **false**（stats.albums=344 ≤ 拉取去重数 339+空集过滤——注意 truncated 判定是"stats > 拉到"，本库逐年切片已拉全）。刻度滑窗（TICK_WINDOW=24）保证 290 行列表 UI 不爆。若未来出现真截断列，页脚/设置不显示缺尾提示——**登记 M6**（协议加 offset 或壳侧 albums 全量流式）。

### 3.3 genre 归并
casefold 合并只发生在展示列名（Anime/anime→多数原形）；`library.albums{genre}` 分片按**原始变体各自拉取**（SQLite 二进制匹配），不漏。JPop≠J-Pop 不做拼写猜测（数据层注释已写明）。

### 3.4 MP3 bit_depth=null
RESOLUTION 行显示 `44.1 kHz（无位深标签）`（lossy 时不硬造位数）。DURATION 用 `duration_ms` 聚合值格式化 m:ss（≥1h 进 h:mm:ss）。

## 4. 验收 5/6 数据

### 4.1 三态与降级（`m5d-perf-switches.json`）
selected 态：贴选中卡、不预热（cache 停在 18）；off 态：coverMapped=false；textures 恢复 true。forceDegrade → off + reason=textureLeak；setUserMode → 粘滞清除（滞回唯一恢复通道，degrade.ts 写死）。

### 4.2 纹理稳态 60s（`m5d-perf-steady.json`）
切 30 档扰动 + 每秒采样：`renderer.info.memory.textures` 序列 28→35 区间**有界振荡**（每 10s 一次 ±2~3 的台阶 = 扰动换卡瞬间新旧纹理并存，随后回落）；cache size 恒 ≤24（LRU 上限）、bytes 恒 24,660,432（24×512²×4 的满载值）、evictions=29、hits=54、failures=0。**判定：无泄漏**（degrade 条件 1 的"净增≥16 且 90% 步不减"在真实轮换下不误报——对照组单测已证）。注意 renderer.info 含标签纹理/阴影贴图/composer RT 等固定项 ~9 张，故 33 ≈ 24(封面) + 9(固定)，与 LRU 上限自洽。

### 4.3 帧时间（swiftshader 环境注记）
on=27.95ms / off=34.80ms（各 ~110 样本中位数）。本机无 GPU（WSL swiftshader 软渲染），绝对值 >33ms 阈值**不可**用于条件 2 判定（且条件 2 需要"off 恢复 ≥45fps"的反向证据，此处 off 更慢=环境噪声，degrade 未误触发，autoDegrading=false 全程）。真机 GPU 数据列入停点 P-2（用户在场）。超级性能预算减半（24/96MiB/512² → 12/32MiB/256²）由 `covers.test.mjs` 机器证明。

## 5. 上游回归套件在本环境的执行说明（reviewer 必读）

- 纯 node 类（check-shell/content/loop/theme/viewport/archive-visibility/array-input 数学部分/assembly/quality/motion/…）：**全 PASS**。
- playwright 类：本 WSL 无 `playwright` 包（任务书环境实况）。用 `/tmp/pwshim`（playwright-core + 本机 chromium-1228 软链）实跑了 selection-state/array-input/momentum 等：**动画阈值类断言在 swiftshader 下超时**（extraction 停在 0.008）——**git stash 基线对照证明改动前后同值**（同一探针脚本、同一构建流程、两次对照），判定为环境限制非回归。m-verify quick（含桩裁判+频谱冒烟）PASS 覆盖协议/频谱面。
- `check-appearance/decryption/playground/wallpaper/workbench` 5 例 FAIL 为**基线既有**（stash 对照同样 FAIL：`theme-material` 无扩展名 import 与 `location is not defined`，node 版本相关），非本泳道引入，登记 M6 债务。
- `check-web-integration.mjs` 断言 `[data-pref="superPerformance"]` 存在——本次设置改动**保留**了该控件（未越权删除），无冲突。

## 6. 文案断言冲突清单（交主进程裁决，未自改任何 check）

**结论：零冲突。** 全部 check-*.mjs 断言的是 CSS 类名/结构（`.read-file`、`.viewer-open`、`.detail-content`、`.back-button`、`.archive-counter`、`.column-navigation`、`.result-row`、`.export-button`）与行为（点击→解密/查看器/焦点恢复），未断言任何被 M5d 改掉的**可见文案**；`FILE NUMBER`/`SELECTING FILES`/`NO.`/`COLUMN`/`ARCHIVE OVERVIEW` 等字符串在 web 模式（未水合）逐字节保留，desktop 模式无 check 覆盖（playwright 类全部跑 web 构建）。需要裁决的只有设计稿要求的**新增**（浮层两行/角标/页脚统计），均为 hidden 于 web 态的增量 DOM。

## 7. 建议提交切分（主进程执行；本泳道未 commit）

1. `feat(player): M5d 专辑墙 DOM/语义重映射+详情页——文案表(wallCopy 水合切换,web 逐字节旧字)/浮层艺术家行+元数据行+格式角标/刻度滑窗24(290 大列不爆)/页脚 library.stats/GENRE 动态总数/八字段表+歌单页签(lib: 点行播放)+介绍占位+曲目清单 Blob 导出/360° 入口无 GLTF 隐藏/设置三态+降级原因/data.test 7 例+covers.test 12 例`（src/main.ts、src/style.css、src/theme.css、src/data.test.mjs、src/player/covers/covers.test.mjs、src/player/covers/degrade.ts(参数属性→显式字段,strip-only 兼容)）
2. `feat(player): M5d 封面接线——album-wall 生命周期管理器(换绑竞态票据/±2预热/wall.covers 三态 config.get+localStorage 双通道/1Hz 降级观测/__rhineCovers 探针)+m1-mount hydrate 时序握手+library-panel 接线(P2-5 归还)`（src/player/covers/album-wall.ts、src/m1-mount.ts）
3. `docs: M5D-FINDINGS + verification/m5d 证据`（docs/M5D-FINDINGS.md、verification/m5d/**）

## 8. 偏差与未尽（诚实登记）

1. **360° 查看专辑模型 = 隐藏入口**（任务书允许项："做不到就隐藏并记 FINDINGS——不许假称有"）。上游 GLTF 只有机构档案模型（archive-assembly/cassette），无专辑模型；封面平面进查看器的改造要动 `model-viewer.ts`+`scene.createAssemblyModel`（所有权外）。M6 若上专辑模型资产再启用。
2. **阵列卡片标签仍印 `NO.001`**（3D 纹理 drawLabel，scene.ts 唯一槽改动纪律外）；DOM 侧全部 ALBUM 化。设计稿详情卡左上的 `ALBUM 002` 标签文字要改 `scene.ts drawLabel()`——登记为 M5d 后续小件（一处文案 + 前缀参数，风险低）。
3. **介绍页签为元数据占位**（genre+year+厂牌行 + abstract 生成文），DB 无 intro 字段（M5D-PLAN 步骤 4 预授权路径）。
4. 验收 2 的"截图基线对比"以**本次 web 三截图 + DOM 逐字段断言**为基线锚（仓库无 M4 前像素基线可比对；文案/结构等价性已机器证明）。
5. `wall.covers` 键在壳 config 为 dot-path 自由键（协议 §5 config 面），无 schema 迁移负担；壁纸构建无 config 通道 → localStorage（WE 属性三态归 M6 设置三层 UI 一并做）。
6. 帧时间对照轮在软渲染下无判别力（§4.3），条件 2 的真机判定列入 P-2 停点。
7. 悬浮 hover 标签（hover-label）水合态仍显示 `X-` 前缀隐藏后的纯编号 + 标题（id-prefix 已随文案表清空）——视觉已在截图确认。

## 9. M6 就绪度

- 设置三态入口已在本里程碑落地（设置弹窗内），M6 三层设置 UI 直接迁移 `albumWall.setUserMode` 即可；`wall.covers` 键已持久化（壳 config.json 实测写入 `"off"`/`"textures"`）。
- `__rhineCovers.snapshot()` 含 cache 计数/字节/驱逐/失败/降级原因——M6 诊断页数据面现成。
- library-panel 已挂载（rl-lib 浮层，ESC/关闭按钮），M6 可决定是否并入设置页或保留独立入口。
- truncated 列缺尾提示、stats 口径统一（§3.1）、drawLabel ALBUM 文案（§8.2）三项登记进 M6 债务清单。
