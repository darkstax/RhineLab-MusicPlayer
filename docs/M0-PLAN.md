# M0 任务书：Windows 壳骨架 + IPC 往返打通

> 依据：`AUDIO-ENGINE.md` v0.3 §18 M0、`IPC-PROTOCOL.md` v1.0、`DECISION-Q1-HOST.md` §7.6。
> 环境（已实测）：WSL 编辑 / `pwsh.exe` 构建；.NET SDK 10.0.400；WebView2 Runtime 152 已装；
> NuGet 经代理 7897 可用；前端 `npm run build` 基线已绿（dist/ 产出正常）。

## 目标（一句话）

WPF 壳窗口内嵌 WebView2 加载 Vite 构建产物，前端经 TS 桥与壳完成 IPC 协议握手 + echo 往返，
并在页面上可视化显示往返延迟——**核心尚不存在，由 C# 桩进程模拟**。

## 交付物与目录

```
host/
  RhineShell/                     # .NET 10 WPF + WebView2（框架依赖）
    RhineShell.csproj             # net10.0-windows10.0.19041, UseWPF, PackageReference WebView2 + NAudio(仅枚举用,M0可不引)
    App.xaml / App.xaml.cs        # 单实例 Mutex（重复启动→唤前窗）
    MainWindow.xaml(.cs)          # 无边框宿主窗口先不强求,M0 允许普通窗口; WebView2 初始化:
                                  #   CoreWebView2Settings: DevTools 允许(F12), DefaultContextMenusEnabled
                                  #   导航到 http://127.0.0.1:<port>/ （本地 HttpListener 伺服 ../web/dist）
                                  #   或虚拟主机映射 SetVirtualHostNameToFolderMapping("app", dist)（优先,免端口）
    Ipc/ShellChannel.cs           # JSON Lines 命名管道 client: 连 \\.\pipe\rhine-music.core.v1(可 env 覆盖),
                                  #   hello 握手、指数退避重连(封顶5s)、req/res id 路由、evt 转发
    Ipc/Bridge.cs                 # WebMessageReceived ↔ ShellChannel 双向转发 + 本地自答:
                                  #   cmd=ping → 立即回 ack{result:{shell_ts}}（M0 验收用,不进正式协议表,
                                  #   标注 dev-only）;最新 state 缓存重放
    Program note: 构建时若 dist 不存在,给白底红字提示页(不崩溃)
  RhineCoreStub/                  # C# 控制台桩,冒充核心(将来被 C++ 替换,协议不变)
    管道 server(字节流) + hello(caps:["echo"], proto:1)
    cmd echo → ack 原样回带 + 1-8ms 随机人工延迟(测延迟直方图用)
    每 1s 主动推 evt{kind:"state",state:"idle",stub:true} 带 seq 递增
    支持 --kill-after N（模拟崩溃,测壳重启）与 stdin "exit"/bye 有序退出
scripts/
  m0-build.ps1                    # dotnet publish host/* -c Release → dist-host/;构建前端(npm run build);
  m0-run.ps1                      # 启动 stub(后台)+shell(前台),日志落 %LOCALAPPDATA%\RhineMusic\m0\logs\
web 桥(进主 Vite 工程):
  src/desktop-bridge.ts           # 见下 API;typeof window.chrome?.webview 检测环境;非桌面环境 no-op
```

## desktop-bridge.ts 契约（前端唯一入口，M0 只做这些）

```ts
type Bridge = {
  readonly desktop: boolean;              // WebView2 环境检测
  handshake(): Promise<HelloResult>;      // hello → 双方 caps
  call(cmd: string, args?: object, timeoutMs?: number): Promise<unknown>;  // 自生成 id,超时 reject
  on(type: "evt"|"state"|"hello", fn): () => void;                          // 退订函数
  ping(): Promise<{ shell_rtt_us: number; core_rtt_us?: number }>;          // dev-only 演示链路
};
export const bridge: Bridge;               // 永不抛异常,非桌面环境全部安全降级
```
- 消息体 = IPC-PROTOCOL.md §2 的 JSON（经 postMessage 直传,桥不翻译格式,保持与管道层一致）。
- M0 **不接线**任何播放 UI；只在 `index.html` 注入一段临时自检面板：
  "环境: desktop/web"、握手 caps、echo 100 连发的 p50/p95/max 延迟、每秒 state 事件计数。
  该面板代码隔离在 `src/m0-selfcheck.ts`，M1 起整体删除——不得污染现有模块。

## 验收标准（全部要执行证据）

1. WSL：`pwsh scripts/m0-build.ps1` 成功产出 `dist-host/` 与前端 `dist/`；`dotnet build` 零警告错误。
2. Windows：`scripts/m0-run.ps1` 起 stub+shell → 窗口内页面正常渲染（现有档案 UI 不动）；
   自检面板显示：desktop=true、握手成功（caps 含 echo）、echo p95 < 50ms、state 计数每秒 +1。
3. stub `--kill-after 30` 场景：面板显示事件断流 → 壳自动重连（指数退避日志）→ 恢复计数。
4. 断线重连后 bridge 缓存重放：新 `call` 不悬挂（旧 pending 全部 reject{code:"disconnected"}）。
5. web 浏览器直开 `npm run dev`：`desktop=false`，自检面板降级文案，**主工程零报错**（回归保证：
   `npm run build` 与上游 `node scripts/check-shell.mjs`（若可跑）不劣化）。
6. git：全部新文件按仓库规范中文 feat 提交；`host/**/bin|obj`、`dist-host/` 进 .gitignore。

## 纪律与边界

- **不改上游现有 src/* 模块**（除新增 desktop-bridge.ts / m0-selfcheck.ts 与 index.html 挂载两行）；
  M0 是纯增量。发现主工程问题记录到 docs/M0-FINDINGS.md，不顺手修。
- 密钥红线：任何日志/输出不含真实凭据（本项目无凭据面，防呆条款）。
- stub 的所有协议行为必须**从 IPC-PROTOCOL.md 逐条实现**，禁止自加字段（将来 C++ 核心按同一文档替换）。
- C# 代码风格：nullable enable、file-scoped namespace、显式 async（后续 Linux 壳不复用它,但用户要能审）。
- 不要动 git remote 结构（upstream 保持）。

## 分工建议（reviewer 审查时对照）

worker 独立完成三块（stub → 壳 → 桥），提交前自跑全部验收项并附命令输出摘要；
reviewer 重点：协议实现与 IPC-PROTOCOL.md 的一致性、重连/生命周期竞态（hello 未完成时来 cmd）、
bridge 降级安全（web 模式）、对上游 src/ 的零侵入。
