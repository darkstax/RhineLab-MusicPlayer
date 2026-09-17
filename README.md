# RHINE LAB · Music Player

**把莱茵生命（Rhine Lab）的终端界面，做成一个真正能用的桌面音乐播放器。**

[Rhine Lab · ANALYSIS OS] 原项目是一个用 TypeScript + Three.js 复刻《明日方舟》特别映像「莱茵生命：访问」终端界面的**网页视觉作品**。本项目在它之上做了**桌面化 + 音乐播放器化**改造：换成 WPF/WebView2 桌面壳 + 自研 C++ 音频核心，让它从"能看的界面"变成"能听歌的软件"。

> ## ⚠️ 上游来源声明
>
> 本项目的**界面设计、三维场景、动效与视觉语言**均来自上游开源项目：
>
> | | |
> |---|---|
> | **上游仓库** | [**LBEILC/RhineLabUI**](https://github.com/LBEILC/RhineLabUI) |
> | **上游作者** | [LBEILC](https://github.com/LBEILC) |
> | **上游许可** | MIT |
> | **上游简介** | *Rhine Lab archive interface built with TypeScript and Three.js* |
>
> 感谢原作者 LBEILC 创造出这套极具质感的界面。**如果没有上游项目，本项目无从谈起。**
>
> 本仓库是**非官方衍生作品（unofficial derivative work）**，与 LBEILC 无隶属关系。
> 上游的 `README.md` 原文存档于 [`docs/UPSTREAM-README.md`](docs/UPSTREAM-README.md)。
>
> 版权与许可：
> - 上游代码与设计 — MIT，© LBEILC
> - 本项目新增部分（音频核心、桌面壳、曲库/歌词/任务栏等）— MIT，© 2026 StarL / darkstax
> - 《明日方舟》《Arknights》及其角色、商标归**鹰角网络（Hypergryph）**所有；本项目为粉丝向非营利作品，不含任何官方素材的分发。

![莱茵生命终端：由透明档案盒构成的三维阵列](docs/media/archive.jpg)

---

## 与上游的差异

| | 上游 RhineLabUI | 本项目 |
|---|---|---|
| 形态 | 网页（浏览器） | **Windows 桌面应用**（WPF + WebView2 壳） |
| 音频 | 无 | **自研 C++ 音频核心**（miniaudio，FLAC/MP3/WAV） |
| 曲库 | 静态演示档案 | **本地曲库**（SQLite + FTS5 全文检索、封面、元数据） |
| 歌词 | 无 | **LRC 解析**（水印过滤、双语配对）+ **任务栏歌词** |
| 输出 | 无 | **独占模式**（位完美直通）、共享/协商降级链、热插拔 |
| 系统集成 | 无 | **SMTC**（系统媒体控制）、频谱可视化、任务栏进度 |
| 分发 | 网页/PWA | **便携 zip + Inno Setup 安装器** |

保留的上游能力：三维档案阵列、专辑墙、检索界面、开场动效、亮暗主题、壁纸模式的动效语言。

---

## 下载

见 [Releases](https://github.com/darkstax/RhineLab-MusicPlayer/releases)：

| 产物 | 说明 |
|---|---|
| `RhineMusic-win-x64-<ver>.zip` | **便携版**，解压双击 `RhineShell.exe` 即用 |
| `RhineMusic-<ver>-x64-setup.exe` | **安装版**（Inno Setup，每用户安装，不需要管理员） |

**运行前置**：
- Windows 10/11 x64
- [.NET 10 Desktop Runtime](https://dotnet.microsoft.com/download/dotnet/10.0)
- [WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/)（Win11 通常自带）

> 无代码签名 → 首次运行会有 SmartScreen「未知发布者」提示，选「更多信息 → 仍要运行」。

---

## 快速运行（从源码）

```powershell
# 1. 前端
npm ci
npm run build

# 2. 桌面壳（Windows）
pwsh -File scripts/m-build.ps1     # 产出 dist-host/

# 3. 启动（开发模式：壳 + 核心一起拉）
pwsh -File scripts/m1-run.ps1
```

一键打包（zip + exe）：`pwsh -File scripts/package.ps1`

---

## 架构

```
┌─────────────────────────────────────────────┐
│ RhineShell (C#/.NET 10 WPF + WebView2)      │  ← 桌面壳：进程/生命周期/设置/任务栏/SMTC
│  ├─ 命名管道 IPC（JSON Lines 协议）          │
│  └─ 前端（TS + Three.js，上游界面为本项目基础）│
└────────────────┬────────────────────────────┘
                 │ \\.\pipe\rhine-music.core.v1
┌────────────────┴────────────────────────────┐
│ RhineCore (C++20 + miniaudio)               │  ← 音频核心：解码/输出/频谱
│  ├─ FLAC / MP3 / WAV 解码                    │
│  ├─ 共享 & 独占输出（位完美直通）             │
│  ├─ 协商状态机 + 降级链 + 热插拔              │
│  └─ FFT 频谱 tap（64 带 L/R）                │
└─────────────────────────────────────────────┘
```

- **跨平台核心 + 异构薄壳**：音频核心是纯 C++，理论上可换壳（macOS/Linux 壳未做）
- **协议优先**：核心与壳之间只用文档化的 JSON Lines 帧（见 [`docs/IPC-PROTOCOL.md`](docs/IPC-PROTOCOL.md)）
- **上游零侵入**：对上游 `src/` 的改动都记录在案，尽量以最小侵入方式接入播放器能力

---

## 文档

| 文档 | 内容 |
|---|---|
| [`docs/README`](docs/) | 各里程碑计划与实测记录（M0–M6） |
| [`docs/IPC-PROTOCOL.md`](docs/IPC-PROTOCOL.md) | 壳 ⇄ 核心协议（v1.6） |
| [`docs/AUDIO-ENGINE.md`](docs/AUDIO-ENGINE.md) | 音频引擎设计（独占/协商/位完美判定） |
| [`docs/RELEASE.md`](docs/RELEASE.md) | 发布流程与前置检查 |
| [`docs/REVIEW-PROTOCOL.md`](docs/REVIEW-PROTOCOL.md) | 代码审查流程（含 AI 审查后端约定） |
| [`docs/UPSTREAM-README.md`](docs/UPSTREAM-README.md) | **上游 README 原文存档** |

---

## 操作说明

- `←` `→` 切列 · `↑` `↓` 选档 · `Enter` 读取 · `/` 检索 · `Esc` 返回
- 播放条：上/下一首、播放/暂停、停止、**三态循环**（顺序 / 专辑 / 单曲）、歌词面板
- 拖动封面卡片可 360° 查看归档模型

---

## 许可

MIT（见 [`LICENSE`](LICENSE)）。
上游部分 © LBEILC（MIT）；本项目新增部分 © 2026 StarL / darkstax。
《明日方舟》相关名称与商标归鹰角网络所有。
