# M6 任务书 v2：设置三层 UI + 信号路径图 + 诊断页 + zip/exe 打包

> 依据：docs/M6-PLAN.md（planner 检索版，选型已定：Inno Setup 7.1 + Compress-Archive，P-1 已批准）、
> docs/AUDIO-ENGINE.md §13/§15（徽章规则/配置 schema）、协议 v1.4（negotiated/diag/framesLost 数据面）。
> 前置：M5 全部合入（library/wall.covers 键、covers 目录、quarantine 表）。

## 目标（一句话）

设置面板三层化（预设/分组/诊断）+ Roon 式信号路径图（渲染 negotiated.chain 真数据）+
诊断页（underrun/framesLost/quarantine/IPC 延迟）+ 一键出 **zip 便携版 + exe 安装器**
（框架依赖，含 .NET/WebView2 前置检测），LICENSE/THIRD-PARTY-NOTICES 终稿。

## 范围五块

1. **设置三层 UI**（src/settings/**，新目录；main.ts 仅加挂载行）：
   - 第 1 层预设：日常/沉浸/发烧/自定义（映射 AUDIO-ENGINE §15；**发烧=共享+无缝+全旁路**，
     不含独占——M4 排除，预设文案明写"独占模式暂未开放"）；互斥约束联动灰显。
   - 第 2 层分组：输出（设备下拉+能力三态标签——devices.list 属 M4 域？**否**：共享模式的
     devices.list 只读枚举在 M6 启用，核心加 `devices.list` 共享面实现（miniaudio 枚举已现成），
     独占相关字段返回 null；这不算 M4——只列设备与格式，不提供 exclusive 切换）/
     音质（音量四模式、重采样、无缝、ReplayGain 占位灰显）/ 界面（暖昼/深夜、超 perf、
     wall.covers 三态、动效）/ 歌词（offset、双语开关、任务栏 source 三态+管道名）/
     库（roots 管理、重扫按钮、quarantine 入口）。
   - 第 3 层诊断：见 3。
2. **信号路径图组件**（src/settings/signal-path.ts，新）：横条渲染 `negotiated.chain`
   （decoder→resample→volume→output），节点直通=绿/处理=橙，factors 列表 + fidelity 徽章
   （FidelityAssessor 数据在壳/核心侧，UI 只渲染不判断）；复用上游双环内构视觉语言
   （磨砂卡片 + 滚动数字标注 rate/bit）；M3 微型频谱条同款数据驱动思路。
3. **诊断页**：`diag.get`（核心共享面 M6 启用只读：underrun 计数、重开流次数、buffer 现状；
   **不含**降级链历史——M4 域）+ 壳侧 framesLost/IPC p50/p95（bridge.diagnostics 现成）+
   quarantine 列表（library.quarantine 新 cmd，只读）+ 环形日志导出（壳日志 tail 下载）。
   协议 v1.5：diag.get 从 not_implemented 转真实现（只读面）、library.quarantine。
4. **打包**（scripts/package.ps1 + installer/rhine.iss）：
   - dotnet publish（框架依赖）+ dist（前端）+ RhineCore.exe → staging
   - zip：Compress-Archive → `dist-release/RhineMusic-win-x64-<ver>.zip`
   - exe：Inno Setup 7.1（ISCC /Qp）→ 同目录 `.exe`；.iss ~40 行：显示名/卸载/开始菜单/
     桌面可选/.NET 10 Desktop 与 WebView2 运行时检测（缺则提示页给下载链接，不静默装）
   - 版本号单一源：`version.json`（壳 csproj FileVersion、iss MyVersion、前端 about 页共读）
   - Inno 本体不入库：package.ps1 检测 `ISCC.exe`（默认查 Program Files(x86)\Inno Setup 7），
     缺则只出 zip 并 WARN（README 写构建前置）
5. **合规终稿**：LICENSE=MIT（年份+作者行按用户定，默认 "Copyright (c) 2026 StarL / darkstax"）；
   THIRD-PARTY-NOTICES.md 机器生成（nuget-license 2.7.1 锁稳定版 + 手工节：vendor C 头文件
   miniaudio/json/kissfft 的 PD/MIT/BSD-3 原文附录——kissfft 的 GitHub NOASSERTION 坑按
   COPYING 实文写 BSD-3-Clause）；npm 依赖节用 license-report 6.8.5；UNKNOWN 许可即 fail。
   README 桌面版章节 + docs/RELEASE.md（发布流程：手动 GitHub Releases，updater 不做）。

## 文件所有权
新：src/settings/**、scripts/package.ps1、installer/rhine.iss、version.json、THIRD-PARTY-NOTICES.md、docs/RELEASE.md
改：main.ts（设置挂载一行）、Bridge/ConfigStore（新键透传）、核心 diag 只读面（host/core/src/main.cpp 的 cmd 分发一处 + audio.h 计数 getter）、桩同步 diag/devices.list 假数据（协议裁判继续可用）、LICENSE、README.md、.gitignore（dist-release/）
禁：src/scene.ts、src/player/lyrics/**、host/RhineShell/Library/**（只 import）、docs/IPC-PROTOCOL.md（v1.5 由主进程升）

## 验收
1. m-verify -Level full 退出码 0（含 CPU 采样——打包前最后一次全绿）。
2. 设置：预设切换 → config.json 落盘 → 重启恢复；互斥灰显逻辑单测（node --test）；
   信号路径图对 negotiated 三种输入（app-perfect/processed/null）渲染快照（headless 截图）。
3. 诊断：diag.get 真数据非 not_implemented；framesLost 与桥计数一致；quarantine 空表渲染。
4. 打包：`pwsh scripts/package.ps1` 出 zip+exe；**解压 zip 到干净目录跑通播放**（headless 冒烟：
   起壳→握手→play lib:1→state playing）；exe 静默装到 TEMP（/VERYSILENT /PORTABLE=1）→
   开始菜单项存在 → 卸载残留检查；两产物 SHA256 进 FINDINGS。
5. 合规：nuget-license 输出与 THIRD-PARTY-NOTICES diff 为空（UNKNOWN=0）；LICENSE 头核对。
6. 停点清单更新：听感/蓝牙/Taskbar-Lyrics 联调/SmartScreen 提示（无签名）——列 RELEASE.md。

## 纪律
协议 v1.5 主进程升（diag/devices 只读面 + library.quarantine）；m0 文案的"独占"字样全部
按 M4 排除口径改写；3 连败停手；心跳分步。

## 报告
①清单 ②验收 1-6 证据 ③产物路径+哈希 ④FINDINGS/RELEASE 路径 ⑤发布前待用户动作清单。
