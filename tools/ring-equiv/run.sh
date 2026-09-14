#!/usr/bin/env bash
# ring-equiv（M5a 债 1 等价性 harness，WSL g++ 直跑 = GOAL-AUTONOMY D 快车道）。
# 旧 SpscRing 复刻（git 删除版同语义） vs vendor ma_pcm_rb：push/pop/readable/reset/
# 满环丢多余帧/EOF 排空判定/并发流量账本 逐项等价断言。
set -euo pipefail
cd "$(dirname "$0")"
CORE=../../host/core
# 只需 rb 实现，不需要音频后端设备（MA_NO_DEVICE 加快编译链接）
g++ -std=c++20 -O2 -Wall -Wextra -pthread -DMINIAUDIO_IMPLEMENTATION -DMA_NO_DEVICE -I "$CORE/vendor" -c "$CORE/vendor/miniaudio.h" -x c++ -o build-miniaudio.o 2>/dev/null || \
g++ -std=c++20 -O2 -pthread -DMINIAUDIO_IMPLEMENTATION -I "$CORE/vendor" -x c++ "$CORE/vendor/miniaudio.h" -c -o build-miniaudio.o
g++ -std=c++20 -O2 -Wall -Wextra -pthread -I "$CORE/vendor" -o ring-equiv ring-equiv.cpp build-miniaudio.o
./ring-equiv
