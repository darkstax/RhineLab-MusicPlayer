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
