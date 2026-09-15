#!/usr/bin/env bash
# 复核派单：把 docs/REVIEW-PROTOCOL.md 的任务书交给一个独立 agent 执行。
#
# 用法：
#   bash scripts/dispatch-review.sh                 # 前台跑（看输出）
#   bash scripts/dispatch-review.sh bg              # 后台跑（pi-bg 跟踪）
#   AGENT=reviewer-qwen bash scripts/dispatch-review.sh
#
# 说明：
#   - 任务书很长（含中文），**不能**直接塞进 pi -p 的 argv（实测 invalid UTF-8），
#     所以一律落盘到任务目录，派单时只传"读这个文件"的短指令。
#   - 复核阶段禁止并发跑 m-verify（抢镜像与命名管道），任务书 §5 已写明。
set -euo pipefail

REPO=/home/starl/ai-code/RhineLab-MusicPlayer
AGENT=${AGENT:-reviewer}
TASK_FILE=$REPO/docs/REVIEW-PROTOCOL.md
STAMP=$(date +%Y%m%d-%H%M%S)
OUT_DIR=${OUT_DIR:-/tmp/review-$STAMP}
mkdir -p "$OUT_DIR"

# 落盘任务书副本 + 出处锚点（含 HEAD，便于报告里标注基线）
{
  echo "# 复核任务书（由 $TASK_FILE 导出）"
  echo
  echo "- 仓库：$REPO"
  echo "- 基线 HEAD：$(git -C "$REPO" log -1 --format='%h %s')"
  echo "- 任务书要求：读 §1–§6 的通用协议，然后执行 §7 的本轮任务。"
  echo "- 输出报告到：$OUT_DIR/report.md，并在回复里给 P0/P1 摘要 + 总判定。"
  echo
  echo "---"
  echo
  cat "$TASK_FILE"
} > "$OUT_DIR/task.md"

PROMPT="读取 $OUT_DIR/task.md 并严格执行（只读复核：不改文件、不提交）。按任务书 §4 的格式把完整报告写入 $OUT_DIR/report.md，回复中给出 P0/P1 摘要与总判定。仓库 $REPO。"

echo "任务书已落盘：$OUT_DIR/task.md ($(wc -l < "$OUT_DIR/task.md") 行)"
echo "报告将写入：  $OUT_DIR/report.md"
echo "agent：        $AGENT"
echo

if [[ "${1:-}" == "bg" ]]; then
  ~/.pi/agent/bin/pi-bg submit -n "review-$STAMP" -d "$REPO" "$OUT_DIR/task.md"
  echo "已后台派单，跟踪：pi-bg status review-$STAMP / pi-bg logs review-$STAMP"
else
  exec pi --agent "$AGENT" -p "$PROMPT"
fi
