# M0 实施记录与发现

> 依据 `docs/M0-PLAN.md`、`docs/IPC-PROTOCOL.md` v1（唯一协议权威）。
> 本文只记录**发现问题/待办/偏差**；正常实现细节见代码与验证输出。

## 1. 链路上必须显式实现的协议约定（文档未给出字面示例）

实施时按 IPC-PROTOCOL.md 逐条对照，以下为阅读后确定的字面格式，凡与后续 C++ 核心不一致应改协议文档而非各自实现：

| 位置 | 我们的实现 | 依据 |
|---|---|---|
| `hello`（壳→核心） | `{"v":1,"t":"hello","role":"shell","proto":1,"caps":["cmd","evt.state","evt.position","smtc"],"app":"rhine-music-player","ver":"0.1.0"}` | §4 示例 |
| `hello`（核心→壳） | 同构，`role":"core"`，`caps":["echo"]` | §4「M0 打桩行为：…核心 `caps:["echo"]`」 |
| `cmd` | `{"v":1,"t":"cmd","id":"c-17","cmd":"echo","data":{...},"ts":...}` | §5「payload 内 `cmd` 字段选择」 |
| `ack` | `{"v":1,"t":"ack","id":"c-17","result":{...},"ts":...}` | §3/§5 |
| `err` | `{"v":1,"t":"err","id":"c-17","error":{"code","message","retryable"},"ts":...}` | §3/§7 |
| `evt` | `{"v":1,"t":"evt","seq":N,"evt":"state","data":{...},"ts":...}` | §6「`payload.kind` 选择」+ §5「payload 内 `cmd`」 |
| `log` | `{"v":1,"t":"log","level":"info","msg":"...",...fields}` | §6「`log`（壳侧）」 |

**说明**：`cmd`/`evt` 的负载字段名在文档里只写作 “payload 内的 `cmd`/`kind`”，未示例 JSON；
M0 采用「展开到顶层」的写法（`cmd`/`evt` 直接是顶层键，参数放 `data`）。这样单帧可读性最好，
也与 §2 的通用字段表（`id`/`seq`/`ts` 都在顶层）一致。**这是 M0 需要 reviewer 重点确认的一点**，
若将来 C++ 核心采用嵌套 `payload:{...}` 写法，只需改 `host/Shared/IpcFrame.cs` 与
`src/desktop-bridge.ts` 的字段读取处，协议版本不变。

## 2. 环境实测（与任务书给定的差异）

- 任务书说“建议 pwsh 脚本内 `Set-Location (wslpath -w ...)` 以保证 .NET 构建在 Windows 文件系统内跑”：
  实测**不必**。`\\wsl.localhost\Ubuntu` UNC 路径下 `dotnet restore/publish` 全绿
  （NuGet 走 `HTTPS_PROXY=http://127.0.0.1:7897`，还原 WebView2 包用时 6s）。
  但 UNC 路径导致 `npm` 不可解析（Windows 侧无 node），因此前端构建仍在 WSL 侧跑。
- 因此 `scripts/m0-build.ps1` 的**推荐入口是 WSL**（读 WSL 路径），内部：
  ① 调 `pwsh.exe -File` 完成 dotnet 部分；② 调 `npm run build` 完成前端部分。
  可另用 `-FrontendOnly` / `-HostOnly` 单独跑一半。
- WebView2 Runtime 已在 `C:\Program Files (x86)\Microsoft\EdgeWebView\Application\152.0.4191.66`。
- Windows 侧**没有 node/npm**，`RhineShell` 的 WebView2 用户数据目录必须显式设置
  （默认目录在 exe 同目录，会把 EBWebView 落进 `dist-host/`），我们设为
  `%LOCALAPPDATA%\RhineMusic\m0\webview2`。

## 3. 与上游主工程的交互

- `index.html` 只**追加两行**（两条 `script type="module"`），无其它改动；
- `src/desktop-bridge.ts`、`src/m0-selfcheck.ts` 为新文件，不 import 任何现有 `src/*` 模块
  （selfcheck 自带样式注入，`desktop-bridge` 零依赖）；
- PWA（`scripts/build-pwa.mjs`）对 `/src/*.ts` 不在构建产物内，无影响；
  但**桌面壳内 Service Worker 不会注册**（`window.isSecureContext` 为 false），
  与既有 `pwaSettingsMarkup()` 的“开发预览不保存离线副本”分支一致，无需改动。

## 4. 并发写管道的锁

`ShellChannel` 的写路径有三个来源（`hello`、`cmd` 转发、`bye`），
因此所有写入统一经 `SemaphoreSlim(1,1)` + 内部队列排队，避免消息交错。

## 5. 待办（M1 起）

- 删除 `src/m0-selfcheck.ts` 与 `index.html` 的两行挂载点（已在 selfcheck 顶部注明）。
- `Bridge.cs` 的 `cmd=ping` 本地自答是 **dev-only**，M1 接入真实核心后必须移除
  （已用 `DevOnlyPing` 常量集中标注，便于搜索）。
- 协议字段名若与 C++ 核心不一致（见 §1），改的是文档 + 两处字段读取，不升 `proto`。

## 6. 接管验收记录（2026-09-12 由接管者补全）

本节是对前任 worker 未提交代码的验证与补缺。实现与任务书基本一致，但验收中暴露并修复了
以下真实缺陷（均为正常使用路径会触发的问题，非假想防御）：

| # | 缺陷 | 位置 | 症状与修复 |
|---|---|---|---|
| D1 | 虚拟主机映射名与导航域名不一致（映射注册 `app`、导航去 `app.rhine.local`） | `MainWindow.xaml.cs` | 页面永远导航失败（ConnectionAborted）；统一为 `app.rhine.local` |
| D2 | echo 自检断言读 `result.i`，协议 §5 规定 result 是 `{data}` 原样回带 | `src/m0-selfcheck.ts` | 100 条全部误判 mismatch；改读 `result.data.i` |
| D3 | 桩在读循环内 `await HandleCommand`，人工延迟把后续命令串行排队 | `host/RhineCoreStub/Program.cs` | burst 下 p95 150–190ms；改并发处理（写路径仍由 WriteGate 串行，ack 靠 id 路由）；配合自检改串发后 p95=20ms |
| D4 | 连接 finally 中 `StreamWriter.DisposeAsync` 抛 `ObjectDisposedException` 未捕获 | `Hosting/ShellChannel.cs` | 关窗退出码 0xE0434352（CLR 未处理异常）；补捕获（SendFrame/Shutdown 同步补） |
| D5 | `new Mutex(initiallyOwned: true)` 遇上一实例被强杀（abandoned）时抛 `AbandonedMutexException` | `App.xaml.cs` | 强杀过一次后每次启动静默秒退且来不及写日志；改 MSDN 标准获取模式，接管验证中实际踩到 |
| D6 | 从 \\wsl.localhost UNC 路径 `Start-Process` 拉起 WPF 壳冷启动挂死分钟级（控制台 stub 不受影响；同 exe 本地副本正常） | `scripts/m0-run.ps1` | 交付脚本默认把 dist-host+dist 镜像到 `%LOCALAPPDATA%\RhineMusic\m0\{bin,web}` 再启动（web 正好命中 ShellOptions 的 dist fallback）；显式 `-DistHost` 时不镜像 |

另：目录与任务书字面不符（实现用 `Hosting/` 而非 `Ipc/`，功能无影响）；前任遗留的 `Ipc/` 空目录已删。
`package.json` 的 `allowScripts.esbuild` 是 npm 不识别的惰性字段（pnpm 专用，本机 npm 安装本就正常），
为守零侵入已还原；发现者若用 pnpm 需另行处理，不在 M0 范围。

### 验收逐项证据（命令均在 WSL 仓库根目录执行）

**(1) 构建** —— `pwsh.exe -NoProfile -ExecutionPolicy Bypass -File scripts/m0-build.ps1`

```
publishing RhineShell -> …\dist-host
publishing RhineCoreStub -> …\dist-host\core
dotnet publish output lines: 10; warning/error lines: 0
  [OK  ] dist/index.html
  [OK  ] dist-host/RhineShell.exe
  [OK  ] dist-host/core/RhineCoreStub.exe
M0 build OK
```

另对三 csproj 各做 `-t:Rebuild -c Release` 全新重建：`exit=0 warn_err_lines=0`（零警告非增量假象）。

**(2) stub+shell 往返** —— `pwsh.exe … scripts/m0-run.ps1 -SelfCheckDump /tmp/m0/selfcheck-real.txt -SelfCheckAfter 25`

shell.log：`core ready caps=[echo]` → `frontend hello` → `page loaded` → `selfcheck dump written` →
`RhineShell exit code=0`；stub 侧 `bye reason=shell-window-closed → orderly shutdown exit=0`。
面板 dump（UTF-8 文件直接 cat）：

```
M0 SELF-CHECK  env=desktop
handshake: ok · shell_state=ready · proto=1
shell caps: [cmd, evt.state, evt.position, smtc]
core: rhine-music-player 0.1.0 caps=[echo]
state 事件: 累计 24 / 近 60s 24
echo 100 连发: ok=100 fail=0
  p50=15.20ms p95=20.00ms max=63.10ms
ping: shell=0.60ms core=15.10ms
```

desktop=true ✓、caps 含 echo ✓、p95=20ms < 50ms ✓、state 累计 24/24s ≈ 每秒 +1 ✓（GUI 无法截图，
按任务书退而求其次用无人值守 dump + 双日得取证）。max 的单点尖峰是 WebView 主线程/GC 抖动，
以 p95 为准。注：自检面板的 echo 连发为串行 100 发（D3 说明）；面板另含 `hold:` 取证行，
仅在 `?m0hold` 或壳虚拟主机域名下启用，M1 随面板整体删除。

**(3) 崩溃重连（含恢复）** —— `scripts/m0-run.ps1 -KillAfter 12 -SelfCheckDump … -SelfCheckAfter 40`

shell.log：`core reconnect in 500ms attempt=1 → 1000 → 2000 → 4000 → 5000ms（封顶）`；
面板：`state 累计停在 10`（断流）、`hold: 错=[disconnected×29, disconnected<1ms×7]`。
恢复场景另用监管脚本（桩崩溃后 2s 手工重拉 stub，代演 M1 的核心重启策略）：
`core ready caps=[echo]` 重现，面板 `state 累计 37`（重新每秒 +1）、`hold 快=ok36`（重连后新 call 立即恢复 ok）、
断线窗口内慢 call 以 `disconnected<1ms` 快速 reject（验收 4：旧 pending 不悬挂、新 call 不悬挂 ✓，
壳侧 `FailPending("disconnected")` + `SendCommandAsync` 非 Ready 态直接回错）。

**(5) web 降级** —— `npm run dev -- --port 5201` + 本地 chromium headless（playwright-core，`--use-angle=swiftshader`）：
面板显示 `env=web` + 降级文案；`pageerror=0、console.error=0`，主工程零报错；
`node scripts/check-shell.mjs` exit=0；`npm run build` 全程绿（tsc 覆盖两个新 TS 文件的类型检查）。

**(6) git** —— 本笔及 feat(bridge) 拆两笔中文提交；`host/**/bin|obj`、`dist-host/` 已在 .gitignore（前任已加）。

### 环境备注

- playwright MCP 本会话全部超时不可用，改用缓存里的 `chromium_headless_shell` + `playwright-core`（装在 /tmp，不入库）。
- 验证中途长时间观察到“壳无声消失”均源于 D5/D6，修复后所有场景可重复。
