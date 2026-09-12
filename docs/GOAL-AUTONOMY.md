# Goal 自循环纲领（Windows 版交付线）

> 本文件是 /goal 自循环的**唯一权威作业规程**。goal 每轮继续时先重读本文件与决策台账
> （`AUDIO-ENGINE.md` §24），再决定本轮动作。用户裁定（2026-09-13）内嵌于此，冲突时以本文件为准。

## 0. 目标一句话

把 RhineLab-MusicPlayer 推进到 **Windows 版可交付**：真音频核心（M2）→ 频谱+SMTC（M3）→
曲库+歌词+任务栏管道（M5）→ 设置/信号路径图/打包（M6），产物 **zip 便携版 + exe 安装器**，
仓库 **MIT**。

## 1. 范围裁定（用户已定，不得扩张）

- **M4（独占/协商降级/300ms 升档/热插拔）整体排除**——延后到用户在场的专门窗口。
  M2/M3 只走 WASAPI 共享事件模式；协议与代码里给 M4 留枚举占位即可，不实现不测试。
- **M2 先写码不跑正式测试**（编译零警告 + 一次冒烟不崩即合入）；正式测试与听感验收
  统一延后到用户在场窗口（§5 停点）。
- Q8=MIT；不打包任何 GPL（mpv 永不进包）。
- D2 架构：C++/miniaudio 核心 + .NET10/WPF/WebView2 壳 + TS 前端；桩（RhineCoreStub）
  永久保留作协议裁判与 CI 假引擎。

## 2. 里程碑顺序与泳道

| 轮次 | 里程碑 | 任务书 | 文件所有权（越界即打回） |
|---|---|---|---|
| 1 | M2 核心出声 | docs/M2-PLAN.md | host/core/**、scripts/m2-*、ShellOptions --core-exe |
| 2 | M3 频谱+SMTC | 开工时写 docs/M3-PLAN.md | 核心 tap/事件：host/core/**；SMTC/设备枚举：host/RhineShell/**；前端消费：src/player/** |
| 3 | M5 曲库+歌词+任务栏 | docs/M5-PLAN.md | 壳 Library/**（C# SQLite/watcher）、src/player/lyrics/**（TS）、管道 writer |
| 4 | M6 设置 UI+打包 | docs/M6-PLAN.md | src/settings/**、scripts/package-*、docs 终稿 |

- **协议单写者**：只有当轮 worker 经主进程批准可改 `docs/IPC-PROTOCOL.md`（版本史必须加行）。
- 每里程碑流水线：worker-qwen 实施 → reviewer-qwen 审查（信任边界纪律：内部 IPC 不做载荷防御、
  假想攻击面归 P2 备案）→ 主进程修 P1 → 中文提交。两轮 review 内收敛，不无限循环。

## 3. 环境与验证纪律（M0-M2 实测教训，逐条遵守）

- WSL 写码；**构建/运行走 pwsh.exe**；NuGet/npm/raw.githubusercontent 走代理 7897。
- UNC 不能跑 dotnet/cmake：Windows 验证一律 robocopy 镜像到 `C:\Users\StarL\<lane>-work\`
  （/XD bin obj build），跑完清理。
- WebView2 三坑：①进程按 userData 分组复用+HTTP 缓存——换构建必须杀 `CommandLine -match
  RhineMusic` 的 msedgewebview2 并必要时清 `%LOCALAPPDATA%\RhineMusic\webview2`；
  ②CDP 只认 `--remote-debugging-port=<纯端口>`（带 IP 静默失效）；③node 连 CDP 要
  `NO_PROXY='*'` 绕代理。取证脚本模式见 tools/m1-e2e/。
- 并行泳道资源隔离：独立管道名（rhine-music.<lane>.v1）、独立 CDP 端口（9240/9250/9260）、
  独立镜像目录。当前默认**串行推进**（一次一个里程碑），仅当任务书显式声明泳道 B/C 时并行。
- 子代理：qwen 系（worker-qwen/reviewer-qwen），`timeout: 15` 防心跳误杀，`restarts: 2`。
- 每轮收尾：`git status` 干净 + 中文 commit（-c user.name="StarL" -c user.email="starl@local"）
  + workflow-status 面板更新 + 生成物不入库。
- 密钥红线：任何配置/日志输出过 sanitize 管道（本项目无凭据面，防呆条款）。

## 4. 机器可验证的完成定义（每里程碑合入前）

- `pwsh scripts/m-build.ps1`（含 m2-build 若存在）零错误零警告；
- `npx tsc --noEmit` + `npm run build` + `node scripts/check-shell.mjs` 全绿（前端回归底线）；
- 协议级冒烟：m1-scenario（桩裁判）仍 ALL PASS——核心换了不许破坏协议面；
- M6 终态追加：`dist-release/` 出 zip + exe 双产物，解压/安装后冒烟一次。

## 5. 停点（goal 遇到即停在该里程碑边界，向用户报告并等待，不许硬闯）

1. **听感/物理验收**：首次真出声质量、蓝牙/拔插场景、独占（M4 域）——列清单交用户，
   不阻塞后续里程碑的**编码**，但 M6 打包前必须销账。
2. **Q 字未决**：goal 推进中发现新决策点（如 M5 歌词在线匹配解禁与否、M6 updater 渠道），
   记入 `docs/OPEN-DECISIONS.md` 攒批问用户，不猜。
3. **同一错误 3 连败**、reviewer 与 worker 两轮不收敛、或需要修改上游 src/* 才能继续——
   停下报告（上游零侵入是 M0 起的铁律）。
4. 用户随时可打断/改道；打断内容与本文件冲突时，以用户最新指示为准并更新本文件。

## 6. goal_complete 条件（全部满足才调 goal_complete）

- [ ] M2/M3/M5/M6 四里程碑均：实施+审查+P1 修复+提交，§4 验证证据在各自 FINDINGS
- [ ] 真实曲库（C:\Users\StarL\Music）可浏览/搜索/播放/歌词/任务栏显示（M5 验收记录）
- [ ] `dist-release/` zip+exe 双产物冒烟通过；README/AGENTS.md（本仓库版）与文档终稿同步
- [ ] 停点清单（§5.1）已全部移交用户（不要求已执行，要求已列明）
- [ ] git 工作区干净，无未提交改动

## 7. 版本史

- v1.0（2026-09-13）：M2 启动时定稿；M4 排除、M2 免测、MIT、zip+exe 均为用户当日裁定。
