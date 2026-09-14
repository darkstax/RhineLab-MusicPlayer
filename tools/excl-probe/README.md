# excl-probe — M4-a 独占能力判定依据（一次性探针，留档）

构建（Windows，vcvars64 环境）：
  cl /nologo /EHsc /W3 enumerate_probe.cpp /Fe:enum.exe /link ole32.lib user32.lib advapi32.lib
  cl /nologo /EHsc /W3 open_probe.cpp /Fe:open.exe /link ole32.lib user32.lib advapi32.lib
（miniaudio.h 从 ../../host/core/vendor/ 拷贝到本目录或加 /I）

2026-09-14 本机实测（USB DAC CX31993 为默认端点）：
- enumerate_probe：三端点 nativeDataFormatCount **全为 0**（miniaudio WASAPI 枚举路径
  不填独占能力表）→ ExclusiveCapable 预探测不可依赖枚举表。
- open_probe：ma_device_init(EXCLUSIVE) 实测 s32@44.1k/48k/96k、s16@44.1k、
  **f32@48k 也成功**（§23 的"float32 独占不支持"是 IsFormatSupported 口径，
  miniaudio 试开路径行为不同——如实记录；本实现独占固定 s32 容器，不受影响）。
→ 结论：开设备走"试开即探测"（ReopenForTrack），devices.list 的 exclusive 三态
（null=未知/实况/探测表）。教训：s16 设备回调按 4B/声道清零会越界崩溃（探针第一版踩过）。
