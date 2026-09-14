#!/usr/bin/env bash
# M4-a OutputPolicy 单测（GOAL-AUTONOMY D 快车道：WSL g++ 直跑，不经 Windows）。
set -euo pipefail
cd "$(dirname "$0")"
g++ -std=c++20 -Wall -Wextra -Werror -O1 \
  ../../host/core/src/output-policy.cpp output-policy-test.cpp -o output-policy-test
./output-policy-test
