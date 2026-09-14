// fft-equiv 对照判定（A2 验收第 1 项，规格 = docs/M5-PLAN-v2 §4.5 债 2）：
// 读 build-old / build-new 两份 payload JSONL（driver.cpp 产物），断言：
//   1) 行数一致（≥100 帧）；
//   2) bands_l/bands_r 逐带 |Δ| < 1e-4（float 域量化后为 4 位小数，判定用量化前语义：
//      两份都是量化值，比较 |Δ| < 1e-4 —— 网格间距 1e-4 的邻接只会取等或 1e-4，
//      故实际成立条件是「逐值相等或至多一档漂移」，报告里列出任何非零 Δ）；
//   3) low/mid/high/activity/beat_phase 逐帧完全一致（协议 §6 v1.3 同量化域）。
// 任一断言失败 → exit 1 + 首个差异上下文；全过 → 打印 FFT-EQUIV-PASS 与统计。
import { readFileSync } from "node:fs";

const [, , oldPath, newPath] = process.argv;
if (!oldPath || !newPath) {
  console.error("usage: node equiv-check.mjs <old.jsonl> <new.jsonl>");
  process.exit(2);
}
const parse = (p) =>
  readFileSync(p, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));

const oldFrames = parse(oldPath);
const newFrames = parse(newPath);

const fail = (msg) => {
  console.error(`FFT-EQUIV-FAIL: ${msg}`);
  process.exit(1);
};

if (oldFrames.length !== newFrames.length)
  fail(`frame count mismatch: old=${oldFrames.length} new=${newFrames.length}`);
if (oldFrames.length < 100) fail(`too few frames (${oldFrames.length} < 100)`);

let maxDelta = 0;
let maxDeltaWhere = "";
let nonZeroDeltas = 0;
const summary = {};
for (let i = 0; i < oldFrames.length; i++) {
  const a = oldFrames[i];
  const b = newFrames[i];
  const key = `${a.set ?? "?"}#${a.frame ?? i}`;
  if (a.set !== b.set || a.frame !== b.frame) fail(`frame ${i} metadata mismatch: ${key} vs ${b.set}#${b.frame}`);
  for (const band of ["bands_l", "bands_r"]) {
    const la = a[band].length;
    const lb = b[band].length;
    if (la !== 64 || lb !== 64) fail(`${key} ${band} length ${la}/${lb} != 64`);
    for (let j = 0; j < 64; j++) {
      const d = Math.abs(a[band][j] - b[band][j]);
      if (d > 0) nonZeroDeltas++;
      if (d >= 1e-4) fail(`${key} ${band}[${j}] Δ=${d} >= 1e-4 (${a[band][j]} vs ${b[band][j]})`);
      if (d > maxDelta) {
        maxDelta = d;
        maxDeltaWhere = `${key} ${band}[${j}]`;
      }
    }
  }
  for (const scalar of ["low", "mid", "high", "activity", "beat_phase"]) {
    if (a[scalar] !== b[scalar])
      fail(`${key} ${scalar} not identical: ${a[scalar]} vs ${b[scalar]}`);
  }
  summary[a.set] = (summary[a.set] ?? 0) + 1;
}

console.log(
  `frames=${oldFrames.length} sets=${JSON.stringify(summary)} max|Δband|=${maxDelta}${maxDeltaWhere ? ` (at ${maxDeltaWhere})` : ""} non-zero-Δ samples=${nonZeroDeltas}`,
);
console.log("FFT-EQUIV-PASS");
