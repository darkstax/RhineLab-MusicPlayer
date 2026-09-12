# M1 任务书：播放状态机骨架 + 前端播放 UI 接线（假引擎驱动真 IPC）

> 依据：`AUDIO-ENGINE.md` v0.3 §18 M1、`IPC-PROTOCOL.md` **v1.1**（§4/§5/§6 已为本里程碑定形）、
> M0 交付（e33a7e6..d0a8acc）与审查遗留（P1-C、P2-4、P2-5 已收编入协议文档）。
> 环境同 M0：WSL 写码、pwsh.exe 构建运行、代理 7897；**心跳超时按 AGENTS.md ≥10min**。

## 目标（一句话）

桩进程升级为**带模拟时钟的假播放引擎**（状态机+进度推进+音量+持久化配置，全部走真协议真管道），
前端新增一个**最小播放条**订阅并操控它——为 M2 换真音频核心验证整条 IPC/状态/UI 通路；
M0 自检面板与 dev-only 取证链一并退役。

## 范围四块

### A. RhineCoreStub → FakeEngine（host/RhineCoreStub/Program.cs，可拆多文件）

实现 IPC-PROTOCOL §5 的 M1 全命令集（echo 保留作回归）：
1. **状态机**：`idle|playing|paused|stopped`；`engine.play{track_id,duration_ms?=180000,position_ms?=0}`
   → 置 playing、记录时钟锚点（epoch、position、rate）、回 `{stream_token:"fake-<n>"}`；
   pause/resume/toggle/stop 语义照 musicfox Player 接口；重复 play 同 track=从头、异 track=切曲。
2. **进度推进**：每秒 tick 发 `evt{kind:"position"}`（§6 字段含 buffered_ms：合成值=min(duration-pos, 30000)）；
   播完自动 → `evt{kind:"state",state:"stopped"}`（M1 不做自动下一曲，队列在 M2）。
   seek/volume/state 变更即时生效并**立刻**补发一帧 position+state。
3. **音量**：`engine.volume{mode,value}`（M1 桩只存值不改声）；mode=fixed 时 value 锁定 1.0。
4. **协商豁免**：M1 negotiated/badges 输出 `null`（协议 §6 已写明豁免）；
   `devices.list`/`output.mode`/`diag.get` 一律 `not_implemented`（M3/M4 前保持现状）。
5. **seq 语义**：evt.seq 进程内单调；**新增会话世代 `epoch`**：每次 hello 成功自增，
   帧里带 `ep` 字段（协议 v1.2 修订：见 D）供前端丢帧检测跨重连复位。
6. **bad-request 加固回归**：沿用 d0a8acc 的 SafeString 族；新增命令解析全部走它。
7. 配置持久化（桩侧）：音量/模式写 `%APPDATA%\RhineMusic\stub-state.json`（壳侧 config 走 C，别混）。

### B. 壳（host/RhineShell/）

1. `Bridge.cs`：cmd 转发已在；新增 **`config.get/set` 壳侧自答**——持久化
   `%APPDATA%\RhineMusic\config.json`（dot-path、原子写 tmp+move），M1 先存 `audio.*`
   （sound/music 开关、两路音量）与 `desktop.keep_awake`（占位，不实施能力）。
2. **窗口电源请求**（keep_awake 真身，属 M1 验收 3 的最小实装）：`SetThreadExecutionState`
   P/Invoke，ES_CONTINUOUS|ES_DISPLAY_REQUIRED|ES_SYSTEM_REQUIRED 按 config 开/关；
   默认关，配置开则壳持请求（这是"本机应用"第一个真实系统能力，独立小函数+注释）。
3. 退役 dev-only：删 `-SelfCheckDump/-SelfCheckAfter` 参数与 `GetSelfCheckDumpScript`；
   保留 `--kill-after`（stub）与日志设施（长期资产）。
4. 壳启动参数 `--dev`（可选）：加载 `http://127.0.0.1:5173/`（vite dev 端口）代替 app.rhine.local，
   并在窗口标题加 `[dev]`——供 UI 迭代免重编壳（无参数行为不变）。

### C. 前端（src/）

1. **删除**：`src/m0-selfcheck.ts`、index.html 两行挂载（保留 desktop-bridge 挂载行，改一行）。
2. `desktop-bridge.ts` 升级：
   - **P1-C 丢帧检测落地**：per-channel 记录 `ep.seq`，`seq>last+1` 计 `framesLost` 并暴露
     `bridge.diagnostics()`（自测用，M6 诊断页复用）；
   - `evt` 分发细化：`on("state"|"position"|"transition"|"spectrum"|"error", fn)`（kind 级订阅，
     旧 `"evt"` 全量订阅兼容保留）；hello 聚合帧类型对齐 v1.1。
3. **新模块 `src/player/`**（纯增量，不 import 上游业务模块；样式新文件 player.css）：
   - `player-store.ts`：单一状态（track/state/position_ms/duration/volume/mode/error），
     订阅 bridge 事件收敛，暴露 `dispatch` 动作（play/pause/toggle/seek/volume）；
     **所有 bridge 调用 try-catch：web 环境（desktop=false）自动切"假引擎"回退**
     （本地 setInterval 模拟 position，UI 无感）；
   - `player-bar.ts`：底部播放条 DOM——曲目名（用上游滚动文字效果 createRollingText）、
     播放/暂停/停止钮、进度条（可拖拽 seek，显示 mm:ss，复用上游时钟的时长格式函数思路）、
     音量条（engine.volume float）、错误 toast（evt.error）；
     挂载点：`index.html` 一行 `<div id="player-bar">` + `m1-mount.ts`（**唯一新的全局入口**，
     main.ts 不改，M1 结束该入口整体接管或删除）；
   - **FidelityBadges.ts**：`negotiated==null` 时渲染 `M1 · stub engine` 灰徽章占位
     （§13 徽章组件雏形，M4 接真数据源）。
4. 视觉语言：全部新 UI 用上游 theme.css 变量（--paper/--ink/--accent 等），亮暗配色自动跟随；
   不引入新依赖；不碰 archive 阵列交互（点击档案盒=选曲占位：把该档案 id 塞进 track_id 播放，
   正好演示"档案即曲目"，接线走 archive-playground 已有事件——若事件不可达则 player-bar 输入框手输 id，
   不侵入上游文件）。

### D. 协议 v1.2 修订（本任务书内完成，worker 直接改 docs/IPC-PROTOCOL.md）

- evt/hello 帧新增可选 `ep`（会话世代 int，桩 hello 响应与全部 evt 携带）；
  前端丢帧检测规则：`ep` 变化 → 复位 seq 基线（吸收 P1-B 的 seq 倒退问题在**接收侧**的语义）。
- 版本史追加 v1.2 行。proto 仍 1。

## 验收标准（全部执行证据；pwsh 侧注意心跳超时，构建分步跑）

1. 构建：`pwsh scripts/m0-build.ps1`（改名 m-build.ps1 或保留兼容 shim 均可）零错误；
   `npm run build` + `tsc` 绿；上游 `check-shell.mjs` 不劣化。
2. 状态机端到端（无人值守）：新增 `scripts/m1-run.ps1 -Scenario full`：起 stub+壳（--dev 不必，
   用生产 dist），通过 **Playwright/CDP 不可用时的替代**——壳日志 + stub 落盘 trace 双证：
   play(30s 假曲) → 1s 间隔 position 推进日志 ×≥25 → 自动 stopped；pause 冻结、resume 续、
   seek 10s 后 position 跳变、volume 0.3→ack→重启进程后**恢复 0.3**（持久化）。
   （若 headless 化困难：允许在桩单元级 `RhineCoreTests`（dotnet test）跑状态机全转换 +
   壳级手工验证一次截图/日志——两者取其全，不许都不做。）
3. keep_awake：config.set desktop.keep_awake=true → 壳日志见 ES 置位；`powercfg /q` 或
   GetThreadExecutionState 回读证据（pwsh 可 P/Invoke 回读进程持有权则免）。
4. 丢帧检测：桩 `--halt-events N`（新增调试参数：暂停 evt 输出 N 秒再续）→
   前端 diagnostics.framesLost>0（headless chromium 复用 M0 方法读面板/console）。
5. web 降级：`npm run dev` + headless 检查：player-bar 正常显示并可播放（假引擎），
   `pageerror=0 console.error=0`；**M0 面板已消失**（全文 grep `m0-selfcheck` 零残留）。
6. 上游回归：档案阵列交互、boot 动画、设置面板人工冒烟一次（日志/截图任一）；
   `git diff` 确认对上游既有 src/* 零修改（mount 一行与删除 m0 文件除外）。
7. 提交：中文 feat/refactor 分笔（协议 v1.2+桩 / 壳 / 前端 / 退役清理可合 2-4 笔），
   作者身份 `-c user.name="StarL" -c user.email="starl@local"`；bin/obj/dist 不入。

## 纪律

- 协议先行：任何消息形状改动先改 `IPC-PROTOCOL.md` 再改代码；桩禁止自加字段。
- 信任边界：继续按"自家进程 IPC"处理，不做载荷防御（审查 P2 精神）。
- 长构建分步命令、日志轮询，防心跳误杀；同一错误连败 3 次停手报告。
- M2 会整体替换桩为 C++/miniaudio——**桩内状态机保持单文件可移植结构**（纯逻辑与管道 IO 分离，
  逻辑部分将来用同语义在 C++ 重写并有对拍单测）。
- 不动 git remote；发现主工程问题记 `docs/M1-FINDINGS.md` 不顺手修。

## 报告格式（同 M0）
①文件清单 ②验收 1-7 逐条证据 ③偏差/FINDINGS ④commit 列表 ⑤未尽风险。
