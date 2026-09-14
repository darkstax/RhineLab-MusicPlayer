// output-policy-test — M4-a 协商状态机的行为级单测 harness（可常驻，WSL 直跑）。
//
// 被测：host/core/src/output-policy.{h,cpp}（纯逻辑，零 miniaudio 依赖——
// 开设备以回调注入，本文件用可编程 mock 模拟各种设备/占用/格式组合）。
//
// 断言组（对应 AUDIO-ENGINE §7.2 每条转移边 + Q1-c 升档 + Q7 keep 探测纪律）：
//   1 auto 且独占可用 → exclusive 达成，无降级；
//   2 auto 且独占 busy → 降级 shared，timeline 记 degraded，探测节奏就绪(ProbeDue)；
//   3 显式 exclusive 失败 → 仍按 fallback 落 shared 且 degraded=true；
//   4 显式 shared → 从不尝试 exclusive（mock 计数=0）；
//   5 非整型源（float 解码）→ 直接跳过独占（§23 float32 独占全设备不支持）；
//   6 升档阶梯：10s 窗口 3 次 underrun → 逐档升 → 300 封顶后不再升；
//   7 auto_expand_buffer=false → OnUnderrun 恒 0；buffer_max_ms=20 → 阶梯只到 10；
//   8 升档后 Negotiate 用新 bufferMs 重试；
//   9 探测节奏：降级后立即可探、OnProbeResult 后 5s 内不可探、已独占不可探、
//     用户显式 shared 不可探（不骚扰）；
//  10 timeline 滚动 ≤20 条；UpdateConfig 重置升档与账本。
// 运行：bash tools/output-policy-test/run.sh → 末行 OUTPUT-POLICY-PASS。
#include <cstdint>
#include <cstdio>
#include <functional>
#include <string>
#include <vector>

#include "../../host/core/src/output-policy.h"

using namespace rhine;

namespace {

int failures = 0;
int checks = 0;

void Check(bool ok, const std::string& name) {
  ++checks;
  if (!ok) { ++failures; std::printf("  [FAIL] %s\n", name.c_str()); }
  else std::printf("  [ok]   %s\n", name.c_str());
}

// 可编程 mock：记录每次尝试的 (share, bufferMs)，按脚本返回结果。
struct Mock {
  std::vector<OpenAttempt> attempts;
  std::function<OpenResult(const OpenAttempt&)> script;
  OpenResult operator()(const OpenAttempt& a) {
    attempts.push_back(a);
    return script ? script(a) : OpenResult{.ok = true};
  }
  int ExclusiveTries() const {
    int n = 0;
    for (const auto& a : attempts) {
      if (a.share == OutputMode::Exclusive) ++n;
    }
    return n;
  }
};

OpenAttempt Base(bool integer = true) {
  OpenAttempt a;
  a.rate = 48000;
  a.bitsContainer = 32;
  a.bitsValid = 24;
  a.integerEncoding = integer;
  return a;
}

OutputPolicyConfig Cfg(OutputMode mode) {
  OutputPolicyConfig c;
  c.mode = mode;
  return c;
}

bool HasTimeline(const Negotiation& n, const std::string& needle) {
  for (const auto& line : n.timeline) {
    if (line.find(needle) != std::string::npos) return true;
  }
  return false;
}

}  // namespace

int main() {
  // 1) auto + 独占可用 → exclusive，无降级
  {
    Mock m;  // 默认全成功
    OutputPolicy p{Cfg(OutputMode::Auto)};
    const auto n = p.Negotiate([&m](const OpenAttempt& a){ return m(a); }, Base());
    Check(n.achieved == OutputMode::Exclusive && !n.degraded, "1 auto->exclusive, no degrade");
    Check(m.attempts.size() == 1 && m.attempts[0].share == OutputMode::Exclusive,
          "1 first attempt is exclusive");
    Check(!p.ProbeDue(1000), "1 exclusive held -> no probe");
  }

  // 2) auto + 独占 busy → shared + degraded 记录 + 探测就绪
  {
    Mock m;
    m.script = [](const OpenAttempt& a) {
      OpenResult r;
      r.ok = a.share != OutputMode::Exclusive;
      r.fail = FailKind::Busy;
      return r;
    };
    OutputPolicy p{Cfg(OutputMode::Auto)};
    const auto n = p.Negotiate([&m](const OpenAttempt& a){ return m(a); }, Base());
    Check(n.achieved == OutputMode::Shared && n.degraded, "2 auto busy->shared degraded");
    Check(HasTimeline(n, "degraded") && HasTimeline(n, "device busy"), "2 timeline records reason");
    Check(p.ProbeDue(5000), "2 degraded -> probe immediately due");
    p.OnProbeResult(false, 5000);
    Check(!p.ProbeDue(5000 + 4000), "2 after failed probe: not due within 5s");
    Check(p.ProbeDue(5000 + 6000), "2 after failed probe: due after 5s");
  }

  // 3) 显式 exclusive 失败 → fallback 落 shared，degraded=true（用户点名独占却没成）
  {
    Mock m;
    m.script = [](const OpenAttempt& a) {
      OpenResult r;
      r.ok = a.share != OutputMode::Exclusive;
      r.fail = FailKind::FormatUnsupported;
      return r;
    };
    OutputPolicy p{Cfg(OutputMode::Exclusive)};
    const auto n = p.Negotiate([&m](const OpenAttempt& a){ return m(a); }, Base());
    Check(n.achieved == OutputMode::Shared && n.degraded, "3 explicit exclusive fail->shared degraded");
    Check(HasTimeline(n, "format unsupported"), "3 timeline reason=format unsupported");
  }

  // 4) 显式 shared → 从不尝试 exclusive（keep 纪律：不占就不去抢）
  {
    Mock m;
    OutputPolicy p{Cfg(OutputMode::Shared)};
    const auto n = p.Negotiate([&m](const OpenAttempt& a){ return m(a); }, Base());
    Check(n.achieved == OutputMode::Shared && m.ExclusiveTries() == 0, "4 shared never tries exclusive");
    Check(!p.ProbeDue(99999), "4 explicit shared -> no probing (不骚扰)");
  }

  // 5) 非整型源 → 直接跳独占（§23 实锤 float32 独占全设备不支持）
  {
    Mock m;
    OutputPolicy p{Cfg(OutputMode::Auto)};
    const auto n = p.Negotiate([&m](const OpenAttempt& a){ return m(a); }, Base(false));
    Check(m.ExclusiveTries() == 0, "5 float source skips exclusive attempt");
    Check(n.achieved == OutputMode::Shared && HasTimeline(n, "non-integer"), "5 timeline skip reason");
  }

  // 6) 升档阶梯：每 3 次/窗口 升一档，300 封顶
  {
    OutputPolicy p{Cfg(OutputMode::Shared)};  // 从 shared 起（无独占干扰）
    int64_t t = 0;
    int expect = 0;
    // 初始 requestedBufferMs=10 → 下一档 25
    const int ladder[] = {25, 50, 100, 300};
    for (const int step : ladder) {
      expect = step;
      for (int i = 0; i < 3; ++i) {
        const int r = p.OnUnderrun(t += 100);  // 同窗口 3 连击
        if (i == 2) Check(r == expect, ("6 expand to " + std::to_string(step) + "ms").c_str());
      }
    }
    // 封顶后再 3 连击：不再升
    for (int i = 0; i < 3; ++i) Check(p.OnUnderrun(t += 100) == 0, "6 capped at 300ms");
    // 窗口分隔：3 次跨 11s（每发都开窗）→ 永不触发
    OutputPolicy q{Cfg(OutputMode::Shared)};
    Check(q.OnUnderrun(0) == 0 && q.OnUnderrun(11000) == 0 && q.OnUnderrun(22000) == 0,
          "6 window resets: spaced hits never expand");
  }

  // 7) 开关与天花板
  {
    OutputPolicyConfig off = Cfg(OutputMode::Shared);
    off.autoExpandBuffer = false;
    OutputPolicy p{off};
    bool allZero = true;
    for (int i = 0; i < 9; ++i) allZero = allZero && p.OnUnderrun(i * 100) == 0;
    Check(allZero, "7 auto_expand=false never expands");

    OutputPolicyConfig cap = Cfg(OutputMode::Shared);
    cap.bufferMaxMs = 20;
    OutputPolicy q{cap};
    const auto lad = q.Ladder();
    Check(lad.size() == 2 && lad[0] == 5 && lad[1] == 10, "7 bufferMax=20 ladder truncates to {5,10}");
    // 起点 requested=10 已在阶梯顶 → 不升
    bool zero = true;
    for (int i = 0; i < 3; ++i) zero = zero && q.OnUnderrun(i * 50) == 0;
    Check(zero, "7 already at capped top -> no expand");
  }

  // 8) BufferTooSmall → 抬到设备下限同 share 重试成功（§7.2 转移边）
  {
    Mock m;
    m.script = [](const OpenAttempt& a) {
      OpenResult r;
      r.ok = a.bufferMs >= 25;       // 设备最小 25ms（虚构）
      r.fail = FailKind::BufferTooSmall;
      r.minPeriodMs = 25;
      return r;
    };
    OutputPolicy p{Cfg(OutputMode::Shared)};  // 从 10ms 起
    const auto n = p.Negotiate([&m](const OpenAttempt& a){ return m(a); }, Base());
    Check(n.opened && n.achieved == OutputMode::Shared, "8 raised-retry opened");
    Check(m.attempts.size() == 2 && m.attempts[1].bufferMs == 25, "8 retry at 25ms");
    Check(HasTimeline(n, "buffer raised"), "8 timeline notes raise");
    Check(p.current().autoExpanded, "8 autoExpanded=true after raise");
  }

  // 9) 探测节奏细化：探测成功后不再到期（已升回独占由调用方重开流达成）
  {
    Mock m;
    m.script = [](const OpenAttempt& a) {
      OpenResult r;
      r.ok = a.share != OutputMode::Exclusive;
      r.fail = FailKind::Busy;
      return r;
    };
    OutputPolicy p{Cfg(OutputMode::Auto)};
    p.Negotiate([&m](const OpenAttempt& a){ return m(a); }, Base());
    Check(p.ProbeDue(10000), "9 probe due right after degrade");
    p.OnProbeResult(true, 10000);
    Check(!p.ProbeDue(11000), "9 available-probe then quiet 5s");
    Check(p.ProbeDue(10000 + 6000), "9 due again after 5s");
  }

  // 10) timeline 滚动 ≤20；UpdateConfig 重置
  {
    Mock m;
    m.script = [](const OpenAttempt&) {
      OpenResult r;
      r.ok = false;
      r.fail = FailKind::Unknown;
      return r;
    };
    OutputPolicy p{Cfg(OutputMode::Exclusive)};
    for (int i = 0; i < 15; ++i) p.Negotiate([&m](const OpenAttempt& a){ return m(a); }, Base());
    Check(p.current().timeline.size() <= 20, "10 timeline capped at 20");
    Check(!p.current().opened, "10 all-fail opened=false");
    OutputPolicy q{Cfg(OutputMode::Exclusive)};
    q.Negotiate(m, Base());
    OutputPolicyConfig fresh = Cfg(OutputMode::Auto);
    fresh.requestedBufferMs = 50;
    q.UpdateConfig(fresh);
    Check(q.bufferMs() == 50 && !q.current().autoExpanded && !q.current().opened,
          "10 UpdateConfig resets buffer & ledger");
  }

  std::printf("\n%d checks, %d failures\n", checks, failures);
  if (failures == 0) { std::printf("OUTPUT-POLICY-PASS\n"); return 0; }
  std::printf("OUTPUT-POLICY-FAIL\n"); return 1;
}
