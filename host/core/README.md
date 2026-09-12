# RhineCore — M2 C++ 音频核心

`host/core/` 是真音频核心（miniaudio WASAPI 共享事件模式 + ma_decoder FLAC/MP3/WAV），
实现 `docs/IPC-PROTOCOL.md` v1.2 的 engine.* 命令集；语义裁判为 `host/RhineCoreStub/`
（假引擎桩，永久保留）。实施记录与已知缺口见 `docs/M2-FINDINGS.md`。

## 构建

Windows 侧 PowerShell 7（构建必须在本地盘镜像跑，UNC 下 msbuild 有坑——脚本自动 robocopy）：

```powershell
pwsh.exe -NoProfile -ExecutionPolicy Bypass -File scripts\m2-build.ps1
```

- 工具链：VS BuildTools 18（vswhere 定位）自带 CMake；MSVC x64 Release，C++20，`/W4 /utf-8 /permissive-`。
- 产物：镜像构建后拷回 `dist-host/core/RhineCore.exe`（不入库）。
- 手工等效：`cmake -S host/core -B host/core/build -A x64 && cmake --build host/core/build --config Release`。
- `MINIAUDIO_IMPLEMENTATION` 隔离在 `src/miniaudio_impl.cpp` 单独 TU（增量编译友好）。

## Vendored 依赖（单头文件，零 GPL——Q8 原则）

| 库 | 版本 | 来源 | 许可 |
|---|---|---|---|
| miniaudio | v0.11.25（2026-03-04） | https://github.com/mackron/miniaudio | public domain / MIT 双许可（自选） |
| nlohmann/json | 3.12.0 | https://github.com/nlohmann/json | MIT |

许可证原文在 `vendor/LICENSES/`（合规红线，不许省）。更新 vendor 时同步替换单头文件、
记录新版本号并全量重编冒烟。

## 运行与替换桩

```
RhineCore [--pipe <name>] [--trace <file>] [--verbose] [--kill-after <sec>]
```

- 默认管道 `rhine-music.core.v1`（`RHINE_CORE_PIPE` 可覆盖）；退出码 0 有序 / 3 管道占用 /
  5 会话异常 / 7 模拟崩溃（与桩对齐）。
- 用真核心起桌面：

```powershell
RhineShell.exe --spawn-core --core-exe <dist-host目录>\core\RhineCore.exe
```

  不带 `--core-exe` 时仍拉起随包桩 `core\RhineCoreStub.exe`（默认行为不变）。
  前端零改动：播放输入接受 `file:<绝对路径>`（M5 曲库接管线名后再映射）。

## 源码地图

| 文件 | 职责 |
|---|---|
| `src/main.cpp` | 管道 server + 帧循环 + ACL + trace（对照桩 Program.cs） |
| `src/protocol.{h,cpp}` | JSON Lines 编解码 + SafeString 族（越界不抛） |
| `src/engine.{h,cpp}` | 状态机（FakeEngine 语义直译，对照表在 M2-FINDINGS §1） |
| `src/audio.{h,cpp}` | ma_device/ma_decoder 封装、设备时钟账本、negotiated 组装 |
| `src/ring.{h,cpp}` | 无锁 SPSC（s32 容器，24bit 红线）、M3 频谱 peek |
| `src/miniaudio_impl.cpp` | vendor 实现 TU（MA_NO_ENGINE/EFFECTS/ENCODING/GENERATION） |

冒烟脚本：`tools/m2-smoke/smoke.ps1`（pwsh，一次全链路 + 非法帧 + 有序退出）。
