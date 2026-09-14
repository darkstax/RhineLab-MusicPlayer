// fft-equiv 对照专用 shim：Windows 侧真 windows.h 的最小替代品（仅 WSL 对照构建使用）。
// 只提供 spectrum.cpp 用到的 GetTickCount64——由对照程序的**模拟时钟**实现（driver.cpp
// 定义并逐帧推进），保证改前/改后两版在同一时间轴上逐帧对齐，beat_phase 才可逐值比对。
#pragma once
#include <cstdint>
extern "C" unsigned long long GetTickCount64(void);
using ULONGLONG = unsigned long long;
