# RHINE LAB · Music Player

**把「莱茵生命」的终端界面，做成一个真正能听歌的 Windows 桌面播放器。**

三维档案阵列、玻璃解密、循环档案墙不只是能看——它背后跑着一个自研的音频引擎、一套本地曲库、
一整套面向桌面场景的系统集成：独占输出、任务栏歌词、系统媒体控制、热插拔跟随。

> 界面设计、三维场景与动效来自开源项目 [LBEILC/RhineLabUI](https://github.com/LBEILC/RhineLabUI)（MIT）。
> 本仓库是它的**非官方桌面播放器衍生**；上游 README 存档于 [`docs/UPSTREAM-README.md`](docs/UPSTREAM-README.md)。
> 《明日方舟》相关名称与商标归鹰角网络所有。

![莱茵生命终端：由透明档案盒构成的三维阵列](docs/media/archive.jpg)

---

## 能力

### 音频引擎（本项目自研，C++20）

- **解码**：FLAC / MP3 / WAV，支持 16/24/32bit 与 44.1k–384k 全采样率
- **独占输出**：WASAPI 独占模式，**位完美直通**（整型容器 + 源采样率 + 零处理）
  经 USB DAC 实测 16/24bit @ 44.1k–384k 全通过
- **协商状态机**：`shared` / `exclusive` / `auto` 三态，失败按 `ma_result` 真分类后走降级链
- **缓冲自愈**：欠载滑动窗口 → 自动升档（5→10→25→…→300ms 封顶），曲间静默重探独占可恢复性
- **热插拔**：设备拔出自动跟随系统默认并续播（位置零回跳）；钉选设备插回自动切回
- **频谱**：FFT 1024 点 / 64 带 L/R，回调内零分配

### 曲库与歌词（本项目自研，C# + TS）

- **扫描**：TagLibSharp 递归扫描，提取标题/艺术家/专辑/流派/年份/位深/码率与内嵌封面
- **检索**：SQLite + **双 FTS5 索引**（曲目 + 专辑），支持中文/日文分词与多字段联合查询
- **封面**：内嵌图优先、侧车文件兜底，LRU 缓存 + 内存预算 + 阶梯降级
- **歌词**：LRC 解析（时间轴、水印过滤、双语自动配对）+ **任务栏歌词**（复用 musicfox 冻结管道协议）

### 桌面集成（本项目自研，C#/WPF）

- **系统媒体控制（SMTC）**：Windows 音量键 / 播放器弹窗 / 耳机线控可直接操作
- **任务栏**：进度条 + 歌词滚动（对接 Taskbar-Lyrics 插件协议）
- **设置系统**：三层 UI（基础 / 音质 / 信号路径图）+ 诊断页（欠载、丢帧、隔离、IPC 延迟）
- **生命周期**：壳自动拉起音频核心（随包真核心，非桩）、退出时一并回收、断线指数退避重连

### 分发

- **便携版** zip（解压即用）+ **安装版** exe（Inno Setup，每用户安装，不需管理员）
- 依赖全部为 MIT/BSD/Apache/PD——**零 GPL**（`THIRD-PARTY-NOTICES.md` 可核）

---

## 下载

| 产物 | 说明 |
|---|---|
| `RhineMusic-win-x64-<ver>.zip` | **便携版** — 解压后双击 `RhineShell.exe` |
| `RhineMusic-<ver>-x64-setup.exe` | **安装版** |

见 [**Releases →**](https://github.com/darkstax/RhineLab-MusicPlayer/releases)

**运行前置**：Windows 10/11 x64 · [.NET 10 Desktop Runtime](https://dotnet.microsoft.com/download/dotnet/10.0) · [WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/)（Win11 自带）

> 无代码签名 → 首次运行会出现 SmartScreen「未知发布者」，选「更多信息 → 仍要运行」。

---

## 架构

```
┌──────────────────────────────────────────────────────┐
│  RhineShell   C#/.NET 10 · WPF · WebView2            │
│  ├─ 曲库（SQLite + FTS5）· 歌词 · 封面               │
│  ├─ SMTC · 任务栏歌词/进度 · 设置 · 打包              │
│  └─ 前端界面（TypeScript + Three.js）                 │
└───────────────────────┬──────────────────────────────┘
                        │  \\.\pipe\rhine-music.core.v1
                        │  JSON Lines（协议 v1.6，文档化）
┌───────────────────────┴──────────────────────────────┐
│  RhineCore   C++20 · miniaudio                       │
│  ├─ 解码（FLAC/MP3/WAV）                              │
│  ├─ 输出（共享 / 独占 / 自动协商 + 降级链）           │
│  ├─ 设备（枚举 / 钉选 / 热插拔 / 位完美判定）          │
│  └─ 频谱 tap（FFT 1024 / 64 带）                      │
└──────────────────────────────────────────────────────┘
```

**设计取舍**：音频核心是**纯 C++、零 UI 依赖**——壳可以换（WPF/macOS/Linux），核心不动。
壳与核心之间只走**文档化协议**（26 个命令 + 事件流），任一侧可独立替换与测试。

---

## 从源码构建

```powershell
npm ci && npm run build          # 前端
pwsh -File scripts/m-build.ps1   # 桌面壳 → dist-host/
pwsh -File scripts/m1-run.ps1    # 启动（壳 + 核心）

pwsh -File scripts/package.ps1   # 一键出 zip + exe
```

**环境**：Windows 11 x64 · .NET SDK 10 · VS Build Tools（C++）· CMake ≥3.24 · Node.js ≥22.12 · Inno Setup 6.4+（仅安装器）

---

## 操作

`←` `→` 切列 · `↑` `↓` 选档 · `Enter` 读取 · `/` 检索 · `Esc` 返回 · 拖动卡片 360° 查看模型

播放条：上/下一首 · 播放暂停 · 停止 · **三态循环**（顺序/专辑/单曲）· 歌词面板 · 音量

---

## 许可

MIT（[`LICENSE`](LICENSE)）。上游部分 © LBEILC（MIT）；本项目新增部分 © 2026 StarL / darkstax。
《明日方舟》相关名称与商标归鹰角网络所有。本项目为粉丝向非营利作品，不含官方素材分发。
