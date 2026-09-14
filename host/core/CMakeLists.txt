# RhineCore — M2 C++ 音频核心（docs/M2-PLAN.md）
# MSVC (VS BuildTools 18) x64 Release；/W4 /utf-8 /permissive-；产物 RhineCore.exe。
# vendor 单头文件（miniaudio.h / json.hpp）与 kissfft 纯 C 件经 /external:I + /external:W0 隔离，
# 避免第三方代码污染本工程「零警告」验收线（M5a 债 2：kiss_fft/kiss_fftr 以 C 编译，
# 加 extern "C" 保护已在头内，无需单独 TU 包裹）。
cmake_minimum_required(VERSION 3.24)
project(RhineCore LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

if(NOT MSVC)
  message(FATAL_ERROR "RhineCore 是 Windows 专属音频核心（miniaudio/WASAPI/命名管道），请使用 scripts/m2-build.ps1 经 MSVC 构建。")
endif()

enable_language(C)  # M5a 债 2：kissfft 的 .c 源件需要 C 编译器

add_executable(RhineCore
  src/main.cpp
  src/protocol.cpp
  src/engine.cpp
  src/audio.cpp
  src/spectrum.cpp   # M3 频谱 tap（FFT=kissfft 在会话线程；回调侧只 memcpy）
  src/miniaudio_impl.cpp   # MINIAUDIO_IMPLEMENTATION 单独成 TU（增量编译友好）
  # M5a 债 2：kissfft（BSD-3-Clause）——实数 FFT 轮子，走 vendor 同口径 /external:W0。
  # 必须列在 add_executable 里：CMake 默认把 .c 当 C 编译（本工程 LANGUAGES 只声明了 CXX，
  # 下方 enable_language(C) 补齐）。
  vendor/kiss_fft.c
  vendor/kiss_fftr.c
)

target_include_directories(RhineCore PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}/src")
# vendor 目录不进常规 /I（防第三方告警计入），改由下方 /external:I 提供。
target_compile_definitions(RhineCore PRIVATE
  NOMINMAX                # windows.h 的 min/max 宏会破坏 std::min/std::max
  _CRT_SECURE_NO_WARNINGS # fopen/strnicmp 等 CRT4996
  WIN32_LEAN_AND_MEAN
  kiss_fft_scalar=double  # M5a 债 2：与旧自写 double 路径同精度，A2 等价断言余量最大化
)
target_compile_options(RhineCore PRIVATE
  /W4 /utf-8 /permissive-
  "/external:I${CMAKE_CURRENT_SOURCE_DIR}/vendor"
  /external:W0
)

# kissfft 的 C TU 不吃 CXX 选项；源文件位于 /external:I 目录下，MSVC 将其归入外部范畴
# （外部头与外部源的告警同被 /external:W0 隔离）。告警线验收口径与 miniaudio 同（M2-FINDINGS §6.6）。
# kiss_fft_scalar 宏由 target_compile_definitions 统一注入（C/C++ 两侧必须同值）。
set_source_files_properties(vendor/kiss_fft.c vendor/kiss_fftr.c PROPERTIES
  COMPILE_OPTIONS "/external:W0"
)

# miniaudio（WASAPI/COM、winmm 高精度时钟）+ SDDL 安全描述符（advapi32）+ 环缓冲（ma_pcm_rb，M5a 债 1）。
target_link_libraries(RhineCore PRIVATE ole32 advapi32 winmm user32)

set_target_properties(RhineCore PROPERTIES OUTPUT_NAME "RhineCore")
