# M1 实施记录与发现

> 依据 `docs/M1-PLAN.md`、`docs/IPC-PROTOCOL.md` v1.2。
> 本文只记录**发现问题/待办/偏差**；正常实现细节见代码与验证输出。

## 1. 环境与取证（M0 套路的增量经验）

- **WebView2 CDP 无人值守驱动**：`CoreWebView2EnvironmentOptions("--remote-debugging-port=…")`
  在本机 Runtime 152 上**不生效**（端口不起）；改用官方支持的 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`
  环境变量即通。壳仍保留 `--remote-debug-port <n>` 命令行（MainWindow 内部翻译成该环境变量，
  仅绑 127.0.0.1），作为长期诊断能力（M6 诊断页同源）。
- WSL `networkingMode=mirrored`：WSL 侧 node/playwright-core 可直接 `connectOverCDP` 到
  Windows 侧 WebView2 的 9223 端口——**桌面壳内前端可全无人值守验收**（E2E 21 项断言，
  含真实点击、拖拽 seek、config.set→ES 置位日志、halt 丢帧计数），无需人工截图。
  注意 node 的 fetch 会走 `HTTP_PROXY`（7897）导致 CDP 连不上，须 `NO_PROXY=127.0.0.1,localhost`。
- **验收 2 的 ≥25 帧 position**：客户端直连管道收集 27/26s + trace 落盘双证（末态 72+ 行、
  position 64 行，含重启的第二桩实例——trace 已改 `FileMode.Append + FileShare.ReadWrite` 使两实例累积同一文件）。
- **PWA Service Worker 会钉住旧 bundle**：迭代前端后壳内仍是旧版（SW 按设计"新版本准备好后
  由用户在设置中更新"）。验证脚本的处理 = 清 `%LOCALAPPDATA%\RhineMusic\webview2` userData
  冷启动；正式用户路径是设置内更新，非缺陷。
- `GetThreadExecutionState` 在本机 kernel32 **无导出**（实测 `EntryPointNotFoundException`，
  该只读 API 仅部分 Windows build 导出）。`KeepAwake` 的回读不依赖它，以
  `SetThreadExecutionState` 返回值（0=失败）+ `Active` 标志 + 壳日志为准；外部交叉取证
  `powercfg /requests` 需管理员（本机非管理员拒绝），按任务书"pwsh 可 P/Invoke 回读
  进程持有权则免"以壳日志 `keep_awake ES set … active=True state=0x80000000` 为证据。

## 2. 语义决定（协议内，不改文档即成立的实现裁量）

- **engine.play 的 duration 钳制方向**：`position_ms > duration_ms` 按 §5 seek 同款"钳到曲长"
  处理（成功钳制，不算 bad_request）；`duration_ms < 1` 与 `position_ms < 0` 才是越界钳制失败
  → `bad_request`。`volume value` 越界同理钳到 [0,1]。
- **stop 语义**（照 musicfox `Player.Stop()`）：位置清零、`track_id` 保留展示；idle 上 stop 幂等收敛为 stopped。
- **toggle 语义**（照 musicfox `Player.Toggle()`）：playing↔paused；idle/stopped 且有曲目 = 从头重播。
- **1Hz 心跳换成 position**：M0 的 1Hz `state{idle}` 改为 §6 的 `position` 帧（不播时位置恒定），
  保持链路可观测性又符合"position 1Hz"的协议表。
- **命令补发帧 + ack 后回拉双保险**：任务书 A2 的"立刻补发 position+state"会被 `--halt-events`
  吞掉；前端 store 在动作 ack 后主动 `engine.state` 回拉一次，保证 UI 在丢帧窗口内也即时收敛
  （事件仍是权威通路，回拉只是补偿）。实测 halt 窗口内 framesLost=340、UI 零卡顿。
  ——审查 P1-5 更正：halt 窗口内补发帧被吞时，**ack 后回拉实为主收敛通路**，事件为常态权威；详见 §6。
- **caps 只声明已实现集**（echo+engine.*）：`devices/output/diag` 不声明，调用回 `not_implemented`——
  §4 的 caps 交集语义与 §5 的"未实现必须回错"一致，避免"声明了却只回错"的自相矛盾。

## 3. 与上游的接线（偏差记录）

- **archive 事件不可达 → 按任务书降级**：上游选档变化没有全局 CustomEvent（仅 wallpaper 宿主
  属性链路），player-bar 采用「手输档案号 + 输入为空时只读观察 `#selected-id`（取
  Rolling Number 的 `.rn-value` 节点拼 `X-###`）」演示"档案即曲目"。零侵入上游文件。
  M2 若上游愿意发 `rhine-archive-selected` 事件，store 可直接订阅替换该观察。
- `#selected-id` 的 `textContent` 在滚动动画中会混入 `.rn-measure/.rn-visual` 残留
  （X-006006006 形态）——观察 DOM 文字时必须读 `.rn-value`。这是给后续任何"读上游 UI
  状态"代码的通用坑。
- `index.html` 改动 = 净 1 行 div + 挂载行注释调整；上游 `src/*` 对 `upstream/main` 零修改
  （`git diff upstream/main --name-only -- src/` 只含 desktop-bridge/m1-mount/player/*）。

## 4. M0 遗留收编状态

- P1-C（丢帧检测）：**落地**（per-kind `(ep,seq)` 基线 + `framesLost` + `diagnostics()`，验收 4 实测 >0）。
- P2-4（proto 不匹配的 err 帧语义）：协议 §2/§7 既有"回 proto_mismatch 后保持最小可用"文字；
  桩/壳行为一致（回 err 后关连接），本轮未再动文档——若 C++ 核心需要更严的"保持最小可用"
  细则，M2 再补 §4。
- P2-5（壳聚合 hello）：v1.1 已收编，本轮补 `core.ep` 透传（v1.2）。
- dev-only ping（FINDINGS §5 待办）：随 M0 面板一并删除（常量 `DevOnlyPing` 全仓零残留）。

## 5. 待办（M2 起）

- 前端 `ep` 变化 → UI 明示"引擎已重启"（当前 store.ep 只入快照未渲染）；配合 M2 真核心的崩溃重启监管。
- player-store 的 `engine.state` 回拉在 M2 应改为仅在 `ep` 变化或 framesLost 增长时执行（省往返）。
- 播放条与上游 `#system-footer` 的层级在 WE 构建共存性未验证（本构建 m1-mount 已跳过 wallpaper MODE）。
- `config.get/set` 的参数校验极小（只查 path 非空）：M2 迁 TOML schema 时补键名白名单与类型检查。
- keep_awake 的 `ES_DISPLAY_REQUIRED` 在电池模式的系统策略下可能被组策略屏蔽——本机实测有效，
  M6 安装包文档需注明。

## 6. 审查 P1 修复记录（主进程执行，2026-09-12 深夜）

审查结论"修后复审"后的处置：

- **P1-1 Toggle 丢时长**：`FakeEngine.Toggle` 重播改传 `Play(track, DurationMs)`；
  补 2 项对拍单测（stopped 重播保时长 / 曲终 Tick→stopped 后 toggle 保时长），
  `dotnet test` **34/34 绿**（WSL 直接可跑）。TS 侧 LocalEngine 本已正确，无需动。
- **P1-2 fail 永久降级**：player-store 新增 `recoverFromLocal()`——acceptState/acceptPosition
  （含 refresh 回拉构造帧）入口统一复位 desktop 并停本地 ticker；真事件恢复即接管。
- **P1-3 握手死代码**：构造函数桌面分支 `bridge.handshake().catch(()=>{})`（hello.core.ep
  透传通道接通接收侧复位；失败静默，事件路径自带重连）。
- **P1-4 CDP 根因修正（重要，覆盖本文 §1 的归因）**：A/B/C 三组隔离实测——
  父 env 纯端口=OK；代码内 `ip:port` 形式=FAIL；代码内纯端口=OK。
  **真实根因是 Runtime 152 静默忽略 `--remote-debugging-port=127.0.0.1:9231` 这种带 IP 的写法**，
  与 §1 推测的"profile 复用"无关（中途引入的 webview2-debug 独立目录已回退，保持单一 userData）。
  修复：MainWindow 在 CreateAsync 前 `SetEnvironmentVariable(..., "--remote-debugging-port=<port>")`
  （纯端口；CDP 本就默认绑 127.0.0.1，无暴露增量）。验证：镜像仓新 build 不带任何父 env 起壳
  `--remote-debug-port 9261` → `/json/version` 返回 `Edg/152.0.4191.66`。
  E2E 取证脚本已归档 `tools/m1-e2e/`（e2e.mjs / web-degrade.mjs / launch.ps1，
  playwright-core 路径经 RHINE_PW_CORE 参数化）。
- **P1-5 FINDINGS §2 措辞**：更正为"**ack 后的 engine.state 回拉是 halt 窗口内 UI 收敛的主通路**，
  事件为常态权威；命令补发帧在 halt 期间被吞属预期（协议 §6 事件可丢）"。
- **P2 表 15 项**：全部按信任边界纪律与 M2 排期备案，不修；其中 P2-6（壳侧 SafeString 统一）
  并入 M2 壳任务。
- 端到端回归：镜像仓 `m1-scenario full` **ALL PASS**（协议级 28 项 + trace 双证）。
