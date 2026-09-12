# M2 任务书：C++ 音频核心（miniaudio）——真解码真出声，共享模式

> 依据：`AUDIO-ENGINE.md` v0.3 §18 M2（**用户裁定 09-13：先写码，不跑正式测试套件**）、
> `DECISION-Q1-HOST.md` §7.6（D2 定案）、`IPC-PROTOCOL.md` v1.2。
> 范围裁剪（用户裁定）：**M4（独占/协商/降级/热插拔）整体排除**，本里程碑只走共享事件模式；
> gapless 若工作量大可拆 M2b（goal 循环续做），但**边界切流的队列结构 M2 就要立对**。

## 目标（一句话）

`host/core/` 新建 C++20 音频核心：miniaudio（WASAPI 共享事件模式）+ ma_decoder（FLAC/MP3/WAV），
实现协议 v1.2 的 engine.* 全命令集（真音频语义），RhineShell 可切换 `--core-exe` 拉起它替代桩；
前端零改动。**编译通过 + 冒烟不崩即合入，正式测试与听感验收延后。**

## 交付物

```
host/core/
  vendor/                      ← 第三方单头文件（vendored，各自 LICENSE 原文保留）
    miniaudio.h                （public domain/MIT 双许可，含 ma_decoder 与 dr_*）
    json.hpp                   （nlohmann/json，MIT）
    LICENSES/                  ← 上游许可证原文（合规红线，不许省）
  src/
    main.cpp                   ← 管道 server + 帧循环（对照 RhineCoreStub 结构，语义逐条 §4/§5/§6）
    protocol.{h,cpp}           ← JSON Lines 编解码、SafeString 族对应物（越界不抛，§10 纪律）
    engine.{h,cpp}             ← 状态机（FakeEngine 语义直译：锚点时钟/钳制/toggle 保时长）
    audio.{h,cpp}              ← ma_engine/ma_decoder 封装：play/seek/stop/volume + device clock position
    ring.{h,cpp}               ← 无锁 SPSC 环形缓冲（解码线程→音频回调），容量按 2×buffer_ms 定
  CMakeLists.txt               ← MSVC (VS BuildTools 18) x64 Release；/W4 /utf-8 /permissive-
  README.md                    ← 构建命令 + 依赖版本与下载 URL + 替换桩的方法
scripts/
  m2-build.ps1                 ← cmake configure+build（vswhere 定位工具集，经 pwsh）；产物 dist-host/core/RhineCore.exe
```

## 关键设计约束（违反=reviewer 打回）

1. **音频线程零分配**：ma 数据回调里只允许从 ring 读；解码在独立线程；IPC 读写在第三线程。
2. **position 权威 = 设备时钟**：`ma_device_get_cursor`/已提交帧数换算，FakeEngine 的锚点语义照搬
   （play/pause/seek 重锚，不漂移不倒退）。
3. **24bit 红线**（AUDIO-ENGINE §4）：解码输出断言整型容器（i16/i24-in-i32）；ma_decoder 若给 f32
   则**必须**在状态帧如实标 `fidelity:"app-perfect"` + factors 注明"解码 float 化"，禁止谎报。
   M2 共享模式下 negotiated 可给 `{share:"shared-event", backend:"wasapi", format:<实际>, chain:[...]}`
   （不再是 null——协议 §6 的 null 豁免只属桩）。
4. **seek 真语义**：ma_decoder seek 到样本 + 清 ring + 重锚（允许 ≤100ms 的缓冲重建，记 trace）。
5. **volume**：M2 实现 float 模式（ma 端点音量 + 软件增益两路都留接口）；fixed/hardware/integer
   语义按 §6 表回 `not_implemented`（M4 域，排除）。
6. **协议纪律**：字段以 IPC-PROTOCOL v1.2 为准，不自加；`ep` 语义与桩一致（hello 成功自增）；
   未支持命令一律 `not_implemented`；bad_request 不崩溃（SafeString 对应物）。
7. **track_id 语义过渡**：M2 核心接受 `file:<绝对路径>` 前缀直接播本地文件（M5 曲库接管线名后再映射）；
   非 file: 前缀回 `bad_request{unknown track_id scheme}`。前端 LOAD 输入框天然可输路径，无需改前端。
8. 壳改动最小化：`ShellOptions` 加 `--core-exe <path>`（SpawnedCoreOwned 逻辑复用），日志区分
   core 类型；**RhineShell 其余行为零改动**。
9. vendored 文件必须记版本与来源 URL（README + LICENSES/），零 GPL（Q8 原则）。
10. 不动 src/（前端）、不动桩（协议裁判保留）、不动 git remote。

## 构建环境（已实测在位）

- MSVC：`C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools`（vswhere 可定位）；
  CMake：`...\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe`（不在 PATH，脚本内定位）。
- WSL g++ 15 可做快速语法预检（非 Windows 头文件路径的部分），**最终构建以 Windows cl 为准**。
- 下载 vendored 依赖走代理 7897：
  miniaudio: https://raw.githubusercontent.com/mackron/miniaudio/master/miniaudio.h
  nlohmann: https://raw.githubusercontent.com/nlohmann/json/develop/single_include/nlohmann/json.hpp
  （建议锁 release tag 而非 master，README 记 tag 号）
- UNC 坑照旧：Windows 构建在镜像目录跑（robocopy host→C:\Users\StarL\m2-work\host）。

## 验收（用户裁定"先写不测"后的最低线）

1. `pwsh scripts/m2-build.ps1` 产出 RhineCore.exe，**零警告**（/W4）；`dotnet build` 壳仍绿；
   `npm run build` 仍绿（前端没动）。
2. **冒烟不崩**（不算正式测试，只做一次）：镜像目录起 RhineCore.exe（管道名 `rhine-music.m2.smoke`）
   + 客户端脚本（可仿 m1-scenario 最小化）：hello→play(file: 一个真实 16/44.1 FLAC, 可从
   C:\Users\StarL\Music 挑最小的)→等 5s→position 帧推进→pause/resume/seek/stop→bye 有序退出，
   全程进程存活、trace 落盘。**不要求听感**（延后统一验收）。
3. 状态机语义对拍（静态级）：engine.h/cpp 的状态转换与 FakeEngine 逐条对照表写进
   docs/M2-FINDINGS.md（人工对照记录即可，不写测试代码）。
4. 提交：中文 feat 分笔（vendor+构建 / 核心 / 壳参数），bin/build 产物与 dist 不入库
   （.gitignore 追加 host/core/build、dist-host 已有规则确认覆盖）。

## 纪律

- 心跳防误杀：构建命令分步短跑、长任务后台化轮询日志（timeout≥10min）。
- 同一错误 3 连败停手，错误原文进报告。
- 日志/文档不含凭据（防呆）。
- 发现协议文档歧义：先改 docs/IPC-PROTOCOL.md（v1.2 内澄清）再改码，版本史加行。

## 报告格式
①文件清单 ②验收 1-4 证据（命令+输出摘要）③FakeEngine 对照表位置 ④commit 列表
⑤已知缺口（gapless 拆 M2b 与否、volume 模式欠账、听感待验收清单）⑥给 M3 的接口就绪度说明。
