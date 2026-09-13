# RhineCore — M2 C++ 音频核心（docs/M2-PLAN.md）
# MSVC (VS BuildTools 18) x64 Release；/W4 /utf-8 /permissive-；产物 RhineCore.exe。
# vendor 单头文件（miniaudio.h / json.hpp）经 /external:I + /external:W0 隔离，
# 避免第三方代码污染本工程「零警告」验收线。
cmake_minimum_required(VERSION 3.24)
project(RhineCore LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

if(NOT MSVC)
  message(FATAL_ERROR "RhineCore 是 Windows 专属音频核心（miniaudio/WASAPI/命名管道），请使用 scripts/m2-build.ps1 经 MSVC 构建。")
endif()

add_executable(RhineCore
  src/main.cpp
  src/protocol.cpp
  src/engine.cpp
  src/audio.cpp
  src/ring.cpp
  src/spectrum.cpp   # M3 频谱 tap（FFT/聚合在会话线程；回调侧只 memcpy）
  src/miniaudio_impl.cpp   # MINIAUDIO_IMPLEMENTATION 单独成 TU（增量编译友好）
)

target_include_directories(RhineCore PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}/src")
# vendor 目录不进常规 /I（防第三方告警计入），改由下方 /external:I 提供。
target_compile_definitions(RhineCore PRIVATE
  NOMINMAX                # windows.h 的 min/max 宏会破坏 std::min/std::max
  _CRT_SECURE_NO_WARNINGS # fopen/strnicmp 等 CRT4996
  WIN32_LEAN_AND_MEAN
)
target_compile_options(RhineCore PRIVATE
  /W4 /utf-8 /permissive-
  "/external:I${CMAKE_CURRENT_SOURCE_DIR}/vendor"
  /external:W0
)

# miniaudio（WASAPI/COM、winmm 高精度时钟）+ SDDL 安全描述符（advapi32）。
target_link_libraries(RhineCore PRIVATE ole32 advapi32 winmm user32)

set_target_properties(RhineCore PROPERTIES OUTPUT_NAME "RhineCore")
