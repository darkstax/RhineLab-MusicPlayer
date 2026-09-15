#!/usr/bin/env bash
# 复核派单：走 CodeBuddy 无头模式（09-15 用户裁定——reviewer 一律用 cb，避开 pi subagent 长任务 503）。
#
# 用法：
#   bash scripts/dispatch-review.sh              # 前台（看完整输出）
#   bash scripts/dispatch-review.sh bg           # 后台（codebuddy --bg，用 ps/logs 跟踪）
#   bash scripts/dispatch-review.sh fg > out.md  # 前台并落盘报告
#
# 环境变量：
#   MODEL  默认 deepseek-v4.1-flash      EFFORT 默认 max
#   OUT    报告落盘路径                  NAME   后台会话名（bg 模式）
#   EXTRA_PROMPT  追加到任务书的额外指令（如"只审 M4-c"）
#
# 设计要点：
#   - 任务书从 stdin 喂入（长中文任务书不进 argv，规避 UTF-8 / 长度限制）。
#   - --allowedTools 只给读类工具：reviewer 从机制上无法改文件（不是靠自觉）。
#   - -y 是 -p 的必需项，否则文件/命令操作会被拦。
set -euo pipefail

REPO=/home/starl/ai-code/RhineLab-MusicPlayer
MODEL=${MODEL:-deepseek-v4.1-flash}
EFFORT=${EFFORT:-max}
MODE=${1:-fg}
STAMP=$(date +%Y%m%d-%H%M%S)
OUT=${OUT:-/tmp/review-$STAMP.md}
NAME=${NAME:-review-$STAMP}
TASK_SRC=$REPO/docs/REVIEW-PROTOCOL.md

[[ -f "$TASK_SRC" ]] || { echo "找不到任务书：$TASK_SRC" >&2; exit 1; }

TASK_FILE=/tmp/review-task-$STAMP.md
{
  echo "# 复核任务（本文件由 $TASK_SRC 导出）"
  echo
  echo "- 仓库：$REPO"
  echo "- 基线 HEAD：$(git -C "$REPO" log -1 --format='%h %s')"
  echo "- 要求：读 §1–§6 通用协议，执行 §7 本轮任务；按 §4 格式输出。"
  echo "- 报告落盘到：$OUT（若你能写文件则写入该路径，否则直接打印完整报告）"
  echo
  [[ -n "${EXTRA_PROMPT:-}" ]] && { echo "## 本次追加指令"; echo; echo "$EXTRA_PROMPT"; echo; }
  echo "---"
  echo
  cat "$TASK_SRC"
} > "$TASK_FILE"

echo "任务书：$TASK_FILE ($(wc -l < "$TASK_FILE") 行)" >&2
echo "模型：  $MODEL / effort=$EFFORT" >&2
echo "报告：  $OUT" >&2
echo >&2

cd "$REPO"
# reviewer 只读：不给 Edit/Write/NotebookEdit
ALLOWED="Bash,Read,Grep,Glob,LS"

if [[ "$MODE" == "bg" ]]; then
  codebuddy -p -y --bg --name "$NAME" \
    --model "$MODEL" --effort "$EFFORT" --allowedTools "$ALLOWED" \
    < "$TASK_FILE"
  echo "已后台派单：codebuddy ps / codebuddy logs $NAME" >&2
else
  codebuddy -p -y \
    --model "$MODEL" --effort "$EFFORT" --allowedTools "$ALLOWED" \
    < "$TASK_FILE" | tee "$OUT"
fi
