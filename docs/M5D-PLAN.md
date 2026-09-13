# M5d 任务书：专辑墙（设计稿三张 → 上游阵列改造）

> 依据：docs/M5-PLAN-v2.md §5（映射表/纹理管线/降级条件全部已定，本工单不重复其内容，只立边界与顺序）、
> 用户批准记录（M5d-Q1 上游豁免 / M5d-Q2 仅选中卡贴图，09-13）、docs/IPC-PROTOCOL.md v1.4。
> 前置：M5a 已合入（library.* 可用、covers 目录有封面文件、AlbumDto 字段齐）。

## 目标（一句话）

把上游"40 份机构档案"的三维阵列与详情页改造成"35 专辑 / 7 流派 / 436 曲"的音乐库专辑墙：
数据源 archives.json→`library.albums`（desktop 模式），选中卡贴封面（cover.rhine.local 虚拟主机
→ THREE 纹理 LRU），导航语义列=流派/行=专辑，详情页=八字段表+歌单/介绍页签+曲目行点击播放，
暗色封面不去饱和；web 模式回退 archives.json 原样（演示数据 + 全部 check-*.mjs 不破）。

## 实施顺序（防大爆炸，每段独立可回归）

1. **数据层**（src/data.ts 异步化）：保留全部导出签名（`records/categories/archiveColumns/
   columnFiles/fileLocation/fileAtSlot`），内部 `AlbumIndex` + `hydrateFromLibrary(bridge)`；
   web 模式不水合=现行为逐字节不变。`fileLocation` 的 `lane*32+row`、`LOOP_ROWS=32` 参数化
   （M5-PLAN-v2 §5.5 红字警告：这是最容易破回归的一处，验收 4 专盯）。
2. **封面管线**（src/player/covers/**，新目录）：texture-cache.ts（LRU 24/96MiB/512²阶梯，
   超 perf 12/32MiB/256²）+ degrade.ts（五条硬条件，滞回=降级后仅手动恢复）；
   scene.ts 唯一改动=Index_Inlay 材质族加 `map` 槽 + `setCoverTexture(tex?)`（选中卡分支，
   clone 材质模式防污染；不注册进 themeMaterial 调色分支——暗色保饱和）。
3. **DOM/语义重映射**（main.ts + style.css/theme.css 新组件段）：文案表（ARCHIVE→ALBUM、
   COLUMN→GENRE、ENTER 读取→打开专辑…）、右侧浮层（阵列态摘要，新组件）、
   刻度条动态页数（当前流派专辑数）、GENRE 04/07、页脚统计（library.stats）、
   格式角标（formats[0] 大写）。
4. **详情页**：八字段两列表格（AlbumDto 直读，缺字段显 "—"）、页签 01 歌单（library.query
   scope=tracks filter.album=key，行=序号/标题/艺术家/格式/时长，点击→play lib:<id>）
   02 专辑介绍（archives.json 的 intro 字段在 DB 无对应→显示 genre+year+厂牌占位，FINDINGS 记）、
   `360° 查看专辑模型`→既有 model-viewer（封面作为平面贴图进查看器，无 GLTF 时用封面卡替代模型，
   做不到就隐藏该入口并记 FINDINGS——不许假称有）。
5. **接线与收尾**：m1-mount 调 library hydrate + covers 预热（选中卡 ±2 预取）；
   设置里"专辑墙封面"三态（纹理/仅选中卡/关闭，config `wall.covers`）。

## 文件所有权

- 改：src/data.ts、src/scene.ts（仅 §5.4 纹理槽一处）、src/main.ts（文案/浮层/详情页 DOM）、
  src/archive-loop.ts（列数参数化）、src/style.css、src/theme.css（新组件段）、src/player/player.css（角标微调）
- 新：src/player/covers/**、src/player/library/albums-view.ts（浮层/详情页组件，若 M5a 的 library/ 已有 store 则 import 它）
- 改：scripts/check-*.mjs **不许改**——它们必须在新界面上继续过（文案变了就改产品代码不改断言；
  断言里确实写死"档案"文案而设计稿要求改掉的，列清单交主进程裁决，不自改）
- **禁**：host/**、docs/IPC-PROTOCOL.md、src/desktop-bridge.ts、src/player/lyrics/**、
  src/player/spectrum-bridge.ts、host/core/**

## 验收（m-verify full 之外，全部 headless 可跑）

1. `npm run build` + `tsc` 绿；`node scripts/check-shell.mjs` 绿。
2. web 模式回归：dev server + headless——boot→阵列→选档→详情全链路与 M4 前**截图基线对比**
   （archives.json 数据、5 列 40 档原样；文案未水合时保持旧字）。
3. desktop 模式（起壳 + 已有 library.db）：CDP 断言——
   `__rhineLibrary.stats()` = {albums:35,tracks:436,genres:7}；GENRE 计数随 ←→ 变化；
   选中卡材质 map 非 null（scene.getStats 或 __rhineScene 探针）；
   浮层字段与 library.albums 首条一致；详情页歌单行数=track_count；
   点歌单行 → engine.state track_id=lib:<id> 且出声（听感停点，只验状态）。
4. **阵列交互回归**：拖拽惯性/选择波/抽取动画/每列记忆在列数=7、行高不变下全过
   （手动 headless 脚本 + 截图进 FINDINGS）；archive-loop 参数化后 `fileAtSlot/fileLocation`
   单测（node --test 新加，web 数据 fixture）。
5. 降级路径演示：CDP 强制 `wall.covers="off"` → 素面 + 设置显示原因；纹理稳态 60s
   `renderer.info.memory.textures` 不增长（LRU 有效证明，数字进 FINDINGS）。
6. 性能：60s 稳态帧时间中位数（开/关封面各一轮）进 FINDINGS；超 perf 模式预算减半生效。
7. 中文提交建议切分写 FINDINGS（数据层 / covers / DOM / 详情页）。

## 纪律

- 上游豁免只覆盖本工单列出的改动点；reviewer 逐行对照 M5-PLAN-v2 §5 映射表，越权改动=P0。
- archives.json 不删（web fixture 永久保留）。
- 心跳/镜像/清场纪律照 GOAL-AUTONOMY §3；m-verify -Level quick 每段结束跑一次。
- 3 连败停手；文案断言冲突交主进程裁决不自改。

## 报告
①文件清单 ②验收 1-7 证据（截图路径/CDP 断言输出/纹理计数曲线摘要）③文案断言冲突清单（如有）
④FINDINGS 路径 ⑤未尽与 M6 就绪度（设置三态入口、wall.covers 键）。
