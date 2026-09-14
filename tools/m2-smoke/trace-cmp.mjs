// A1-2 改前/改后 trace 逐字段比对（M5a 债 1 归还的机器证据；口径 = docs/M5-PLAN-v2 §4.5）：
//   · position 帧序列：相邻差**符号模式**一致（单调段递增 / seek 回退点 / 暂停冻结点一一对应），
//     绝对值同量级（±150ms = 两进程各自解码节奏的抖动上界，实测远小于此）；
//   · buffered_ms：播放稳态样本（>500ms）中位数差 ≤ 5%（首帧预热与恢复瞬间属采样时机差，
//     不计入稳态——任务书"量级一致"的本意）；
//   · state 序完全一致；bye exit=0 由 smoke.ps1 自身断言（本脚本消费其 PASS 前提）。
import { readFileSync } from "node:fs";
const parse = (p) => readFileSync(p, "utf8").split("\n").filter((l) => l.includes("evt=")).map((l) => {
  const m = /evt=(\w+) seq=(\d+) ep=(\d+) data=(\{.*)$/.exec(l.trim());
  return m ? { kind: m[1], seq: +m[2], ep: +m[3], data: JSON.parse(m[4]) } : null;
}).filter(Boolean);
const a = parse(process.argv[2]), b = parse(process.argv[3]);
const fail = (msg) => { console.log("TRACE-CMP-FAIL:", msg); process.exit(1); };

const pos = (f) => f.filter((x) => x.kind === "position").map((x) => x.data.position_ms);
const buf = (f) => f.filter((x) => x.kind === "position").map((x) => x.data.buffered_ms);
const states = (f) => f.filter((x) => x.kind === "state").map((x) => x.data.state);
const sign = (v) => (v > 0 ? "+" : v < 0 ? "-" : "0");
const pattern = (ps) => ps.slice(1).map((v, i) => sign(v - ps[i])).join("");

const pa = pos(a), pb = pos(b);
if (pa.length !== pb.length) fail(`position frame count ${pa.length} vs ${pb.length}`);
const pats = [pattern(pa), pattern(pb)];
if (pats[0] !== pats[1]) fail(`position pattern differs: ${pats[0]} vs ${pats[1]}`);
for (let i = 0; i < pa.length; i++) {
  const d = Math.abs(pa[i] - pb[i]);
  if (d > 150) fail(`position[${i}] ${pa[i]} vs ${pb[i]} (Δ${d} > 150ms)`);
}
const median = (xs) => { const s = [...xs].sort((x, y) => x - y); return s[(s.length - 1) >> 1] ?? 0; };
const steadyA = buf(a).filter((v) => v > 500), steadyB = buf(b).filter((v) => v > 500);
const mA = median(steadyA), mB = median(steadyB);
if (steadyA.length !== steadyB.length) fail(`steady buffered samples ${steadyA.length} vs ${steadyB.length}`);
const drift = mA === 0 ? 0 : Math.abs(mB - mA) / mA;
if (drift > 0.05) fail(`buffered_ms steady median ${mA} vs ${mB} (drift ${(drift * 100).toFixed(1)}% > 5%)`);
const sa = JSON.stringify(states(a)), sb = JSON.stringify(states(b));
if (sa !== sb) fail(`state order differs: ${sa} vs ${sb}`);
const chain = (f) => [...new Set(f.filter((x) => x.kind === "state" && x.data.negotiated)
  .map((x) => JSON.stringify(x.data.negotiated.chain.map((c) => [c.node, c.detail ?? c.mode, c.passthrough]))))].join("|");
if (chain(a) !== chain(b)) fail(`chain取证 differs:\n old=${chain(a)}\n new=${chain(b)}`);
const fid = (f) => [...new Set(f.filter((x) => x.kind === "state" && x.data.negotiated).map((x) => x.data.negotiated.fidelity))].join(",");
if (fid(a) !== fid(b)) fail(`fidelity set differs: ${fid(a)} vs ${fid(b)}`);
console.log(`TRACE-CMP-PASS frames=${pa.length} pattern=${pats[0]} steadyMedian=${mA}/${mB} drift=${(drift * 100).toFixed(1)}% states=${sa} fidelity=${fid(a)}`);
