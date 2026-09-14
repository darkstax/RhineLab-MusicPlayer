#!/usr/bin/env bash
# fft-equiv 对照运行脚本（M5a A2 验收 1；一次性对照、可常驻回归）。
# 在 WSL 用 g++ 分别构建 baseline（自写 radix-2 double FFT）与现版（kissfft 实数 FFT），
# 同一批确定性输入（静音 + 真实 FLAC24/MP3 采样，ffmpeg 转 s32le 交错 2ch 48k）各产
# 100+ 帧 spectrum payload，交 equiv-check.mjs 逐帧比对。
# 前置：WSL 有 g++/ffmpeg/node；参数 = <FLAC 文件> <MP3 文件>（默认取本机真库样例）。
set -euo pipefail
cd "$(dirname "$0")"

FLAC="${1:-/mnt/c/Users/StarL/Music/Goose house - 光るなら.flac}"
MP3="${2:-/mnt/c/Users/StarL/Music/明日方舟/ALIVE/ALIVE.mp3}"
OUT=out
mkdir -p "$OUT" build-old build-new baseline-copy

CORE=../../host/core
# —— 输入：截 20s 转 s32le 交错 2ch 48k ——
ffmpeg -hide_banner -loglevel error -y -t 20 -i "$FLAC" -ac 2 -ar 48000 -c:a pcm_s32le -f s32le "$OUT/in-flac.raw"
ffmpeg -hide_banner -loglevel error -y -t 20 -i "$MP3" -ac 2 -ar 48000 -c:a pcm_s32le -f s32le "$OUT/in-mp3.raw"

# —— 构建：两版共用同一 driver/protocol，唯一差异 = spectrum.{h,cpp} 与 FFT 实现 ——
# baseline（改前）：spectrum_old.* 复制为 spectrum.{h,cpp} 放独立 include 目录。
cp baseline/spectrum_old.h baseline-copy/spectrum.h
cp baseline/spectrum_old.cpp baseline-copy/spectrum.cpp
g++ -std=c++20 -O2 -Wall -Wextra -I shim -I "$CORE/vendor" -I baseline-copy -I "$CORE/src" \
  -o build-old/fft-equiv \
  baseline-copy/spectrum.cpp "$CORE/src/protocol.cpp" driver.cpp

# 现版（改后）：src/spectrum.cpp + vendor kissfft（scalar=double，与生产 CMake 同定义）。
gcc -O2 -fPIC -Dkiss_fft_scalar=double -I "$CORE/vendor" -c "$CORE/vendor/kiss_fft.c" -o build-new/kiss_fft.o
gcc -O2 -fPIC -Dkiss_fft_scalar=double -I "$CORE/vendor" -c "$CORE/vendor/kiss_fftr.c" -o build-new/kiss_fftr.o
g++ -std=c++20 -O2 -Wall -Wextra -Dkiss_fft_scalar=double -I shim -I "$CORE/vendor" -I "$CORE/src" \
  -o build-new/fft-equiv \
  "$CORE/src/spectrum.cpp" "$CORE/src/protocol.cpp" build-new/kiss_fft.o build-new/kiss_fftr.o driver.cpp

# —— 产帧 + 比对（产物留档在 out/，报告证据引用）——
build-old/fft-equiv "$OUT/in-flac.raw" "$OUT/in-mp3.raw" "$OUT/old.jsonl"
build-new/fft-equiv "$OUT/in-flac.raw" "$OUT/in-mp3.raw" "$OUT/new.jsonl"
node equiv-check.mjs "$OUT/old.jsonl" "$OUT/new.jsonl" | tee "$OUT/check.log"
grep -q FFT-EQUIV-PASS "$OUT/check.log"
