# M5b 歌词（泳道 B）实施与验证记录

日期：2026-09-13 · 泳道：B（纯前端 TS，只写盘未提交）· 任务书：`~/.pi/agent/bg-jobs/20260913-220754-laneB-m5b/task.md`

## 1. 文件清单

| 文件 | 类型 | 内容 |
|---|---|---|
| `src/player/lyrics/lrc.ts` | 新增 | LRC 解析纯函数（零依赖、node 可直跑）：多时间标签、元标签、offset、水印过滤、skipParseErr 容错、卡拉OK标签剥离（不拆句）、脚本分类、贪心配对标注、二分行查找、taskbarPair 上行取数 |
| `src/player/lyrics/lyric-view.ts` | 新增 | 歌词面板 `LyricView`（单例 `lyricView` + `window.__rhineLyric` 诊断入口）：setText/setPosition/clear/toggle、当前行高亮+平滑滚动居中、`lyric.show` fire-and-forget 上行 |
| `src/player/lyrics/lyric-view.css` | 新增 | 面板样式：全部 `--theme-*` 变量（亮暗自动跟随）、mask 上下渐隐、配对行左竖线弱档、reduced-motion 降级、≤700px 底部抽屉化；含播放条「词」钮选中态 |
| `src/player/lyrics/lrc.test.mjs` | 新增 | node --test 解析单测 **26 用例**（要求 ≥12） |
| `src/player/lyrics/lyric-view.test.mjs` | 新增 | node --test 面板静默降级单测 **3 用例**（无 DOM 跑通 lyric.show 路径） |
| `src/player/player-bar.ts` | 修改 | +2 行有效改动：import lyricView；`.pb-controls` 内 `lyricView.attachButtonTo(...)` 挂「词」钮（样式沿用 pb-btn） |
| `src/m1-mount.ts` | 修改 | 歌词接线：订阅 playerStore——trackId 变化 → `lib:<id>` 走 `library.get` 取 `lyric_text`（其它来源置空）；position 驱动 `setPosition`；state **转移**到 stopped/idle 时 `clear()`（1Hz 重复 emit 不重发清除帧） |
| `.tools/m5b-lyric-smoke.cjs` | 新增（gitignored） | headless 冒烟脚本（可复跑取证） |

未触碰：host/**、docs/ 既有文档、src/desktop-bridge.ts、src/player/player-store.ts、src/player/library/**、src/scene.ts、src/main.ts、src/data.ts。

## 2. 验收证据（5 项全绿，2026-09-13）

1. **单测**：`node --test src/player/lyrics/lrc.test.mjs src/player/lyrics/lyric-view.test.mjs` → `tests 29, pass 29, fail 0`（WSL 直跑，不碰 Windows；lyric-view 顶层不 import css，node 可直加载）。覆盖：单/多时间标签、`[mm:ss.xxx]`、分钟>59、offset 正负与钳位、元标签提取、水印过滤、带时间标签的 [by:] 混排行不过滤、坏行容错计数、严格模式抛错、空文本、乱序归并、空文本标签不产帧、卡拉OK剥离、双语配对（含贪心跳档不误标）、配对阈值边界、同时间戳稳定保序、二分 7 种边界 + 500 行×2000 次随机与线性对照、classifyScript 五类、parseTimeTag 容错、taskbarPair（含译文行回看原文）、CRLF、重复 meta 键；面板层：桥缺席静默（not_desktop 被吞 + bridgeAbsentSilent 置位 + 零 unhandledRejection，`--unhandled-rejections=strict` 下跑通）、去重不重发、clear 空串清除帧、无词幂等。
2. **类型与构建**：`npx tsc --noEmit` exit 0；`npm run build` ✓ built（chunk >500kB 警告为上游既有）；`node scripts/check-shell.mjs` exit 0。
3. **headless 冒烟（web 面）**：`npm run dev`（127.0.0.1:5173）+ playwright-core（/tmp/pwtest，WSL chromium，NO_PROXY='*'）→ 22 项断言全过：注入测试词解析 7 行/水印过滤/3 配对行、面板打开渲染、首行前去重不发帧、行变化高亮与滚动、**假引擎播放 + 进度条 seek 驱动面板滚动**（scrollTop=1235、当前行居中偏差 1px）、非 lib: 曲目空态「暂无歌词」、全程 `pageerror=0`、`console.error=0`。截图 `.tools/m5b-lyric-panel.png`（暗色高亮当前行 + 上下文 mask 渐隐 + 「词」钮选中态可见）。
4. **desktop 面（lyric.show 静默与帧形状）**：
   - 代码走查：`sendLyricShow` 对 `bridge.call` 同步 throw 与异步 reject 双重吞掉并计数（`bridgeAbsentSilent`）；web 模式 `bridge.call` 恒 reject `not_desktop` → 冒烟断言「web 模式 lyric.show 静默降级」证实零异常（lyric-view 顶层 import css，node 单测无法直跑该模块，静默路径由假宿主冒烟覆盖）。
   - 假宿主冒烟（addInitScript 注入 `window.chrome.webview`）：捕获到协议帧 `t=cmd, cmd=lyric.show, data={primary:"第一句 原文",secondary:"First line translated"}`，与 IPC-PROTOCOL v1.4 §5 形状一致；无壳应答时超时被吞，`pageerror=0`。
   - 单测层（`lyric-view.test.mjs`）：node 无 window.chrome.webview → bridge.desktop=false → 恒 not_desktop；断言吞异常、bridgeAbsentSilent 置位、去重与清除帧语义；`taskbarPair` 取数规则（含空串清除路径）由 lrc.test.mjs 覆盖。
5. **零新依赖**：git diff package.json 为空；node --test 用 v24 原生类型剥离直 import `./lrc.ts`。

## 3. 规则说明（给 reviewer 核对）

### 3.1 水印过滤
- 判据（任务书定形）：**整行无时间标签且以 `[by:` 开头**（大小写不敏感）→ 过滤，`meta.by` 仍收录其值，`meta.watermarkFiltered=true`，**不计坏行**。
- 带时间标签的 `[by:…]` 混排行（如 `[00:03.00][by:某人] 文本`）是正常歌词，不过滤。
- 其余无时间标签非空行：skipParseErr=true（默认）跳过并计入 `skipped`；false 抛错（严格模式，单测覆盖）。

### 3.2 双语配对（行内拆句不做的替代）
- 脚本分类 `classifyScript`：按字符计数取众数，cn（CJK 基本+A/兼容表意）/ jp（假名）/ ko（谚文）/ latin（拉丁扩展）/ none（无实义文字）。
- 配对规则 `annotatePairs`（**贪心跳档**）：相邻两行 i、i+1 脚本种类不同、均非 none、时间间隔 ≤ **5000ms** → i+1 标 `paired`（译文行），指针跳两行继续；否则前移一行。跳档保证交替格式（cn/lat/cn/lat…）里第 2 句原文不会因紧邻上行译文而被误标。
- 渲染：paired 行字号降一档 + 左竖线缩进（`lyric-paired`），当前行 paired 时高亮用 `--theme-accent`。
- 任务栏上行 `taskbarPair`（对齐 go-musicfox BuildTaskbarLyric 的「当前行翻译→否则下一行」优先级，适配双行格式）：
  - 当前行是译文行 → **primary=回看配对的上一行原文，secondary=本译文行**（面板停在译文行时任务栏仍显示原文主导）；
  - 否则 primary=当前行，secondary=下一行（双语库即其译文）；末行 secondary=""；无当前行（首行前/无词/切曲）→ `{"",""}` 清除帧。
  - 去重：与上一帧内容相同不重发（`lastSent` 基准）。

### 3.3 其它语义决策
- **offset 符号**：LRC 规范/Aegisub 语义，正值=歌词提前（startMs − offsetMs），钳位 ≥0。注意 go-musicfox 的 `offset` 是用户动态偏移（service.SetOffset），与文件内 `[offset:]` 标签不同源；本实现只处理文件标签。
- 行内 `<mm:ss.xx>` 卡拉OK标签：**剥离不拆句**（YRC 不做的兜底，防标签泄漏进显示文本）。
- 排序：全部帧按 startMs 稳定排序（多标签乱序归并，同 go sort.Slice + ES2019 稳定 sort）；空文本时间标签不产帧。
- 数据流：lyric-view **不 import player-store**（单向依赖、可独立冒烟）；m1-mount 订阅后以 `setPosition/setText/clear` 驱动。`library.get` 只在 `lib:<id>` 前缀 trackId 时发起（协议 §5.1），web/档案演示曲目直接空态。

## 4. 给 M5d / 主进程的话

1. **布局共存建议（歌词面板 × 专辑墙详情页）**：当前实现是**右侧浮层**（fixed，right 22px，bottom 96px 让开播放条，≤700px 转底部抽屉）。M5d 详情页占据右半屏时会与面板重叠，建议二选一：
   - a) 详情页打开时 `lyricView.setOpen(false)`（一行接线，最省事）；
   - b) 把面板改挂详情页右栏之下（`lyricView` 已把 DOM 构建收敛在 `mountDom()`，改宿主容器只需换 appendChild 目标 + css 从 fixed 改 static）。
   倾向上 a 进 M5d、b 留给「详情页内嵌歌词 tab」的真实需求出现时再做。
2. **M5c writer 对接**：lyric.show 帧形状已在假宿主冒烟中固证（`{primary,secondary}`，空串=清除）；任务栏插件侧无需再猜格式。
3. **SMTC Thumbnail（M3 欠账）**：不在本泳道文件所有权内，未动 host/**；提醒主进程该账仍在 M5b 总验收单里。
4. **reconcile**：`setText` 是公开注入 API，未来在线歌词/本地文件热更新可复用同一入口。
5. **性能**：面板零逐帧计算（高亮只在行变化时更新，滚动交给 CSS smooth）；61 行溢出滚动实测居中偏差 1px。

## 5. 未尽事项

- 真库抽样（`library.get` 取真 FLAC 内嵌词）依赖泳道 A 的宿主 Lyrics.cs 落地，本泳道以协议帧 + 注入 API 等价验证；A 合并后建议跑一次端到端 `lib:<id>` 路径。
- 面板打开动画（当前为直接显隐）与 WE 属性接线（若 WE 侧也要歌词浮层）未在本任务书范围。
- `.tools/m5b-lyric-smoke.cjs` 在 gitignored 目录，若主进程想纳入回归面可移入 scripts/（未动，避免与泳道 A 的 scripts 改动冲突）。
