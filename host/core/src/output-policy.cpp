// M4-a OutputPolicy 实现（纯逻辑；单测见 host/OutputPolicyTests）。
#include "output-policy.h"

#include <algorithm>

namespace rhine {

namespace {
constexpr const char* ModeName(OutputMode m) {
  switch (m) {
    case OutputMode::Exclusive: return "exclusive";
    case OutputMode::Shared: return "shared";
    default: return "auto";
  }
}
}  // namespace

OutputPolicy::OutputPolicy(OutputPolicyConfig config)
    : config_(std::move(config)), bufferMs_(std::max(1, config_.requestedBufferMs)) {}

std::vector<OutputMode> OutputPolicy::EffectiveOrder() const {
  if (!config_.fallbackOrder.empty()) return config_.fallbackOrder;
  switch (config_.mode) {
    case OutputMode::Shared: return {OutputMode::Shared};
    case OutputMode::Exclusive: return {OutputMode::Exclusive, OutputMode::Shared};
    case OutputMode::Auto:
    default: return {OutputMode::Exclusive, OutputMode::Shared};
  }
}

std::vector<int> OutputPolicy::Ladder() const {
  static const int kSteps[] = {5, 10, 25, 50, 100, 300};
  std::vector<int> out;
  for (const int s : kSteps) {
    if (s <= config_.bufferMaxMs) out.push_back(s);
  }
  if (out.empty()) out.push_back(std::max(1, config_.bufferMaxMs));
  return out;
}

void OutputPolicy::Note(const std::string& line) {
  timeline_.push_back(line);
  if (timeline_.size() > 20) {
    timeline_.erase(timeline_.begin());
  }
}

Negotiation OutputPolicy::Negotiate(const OpenFn& tryOpen, const OpenAttempt& base) {
  Negotiation out;
  out.bufferMs = bufferMs_;
  out.periodMs = base.periodMs;

  const auto succeed = [&](OutputMode share) {
    out.opened = true;
    out.achieved = share;
    // 降级语义：auto 的意图是"优先独占"——凡请求非 shared 而达成 shared 即降级
    // （UI 据此显示"独占不可用，已降级共享"；§7.2）。shared 模式达成 shared 不算。
    out.degraded = config_.mode != OutputMode::Shared && share != OutputMode::Exclusive;
    if (out.degraded) Note(std::string("degraded ") + ModeName(config_.mode) + " -> " +
                           ModeName(share));
    else Note(share == OutputMode::Exclusive ? "exclusive acquired" : "shared opened");
    out.timeline = timeline_;            // 持久账本并入（Note 不再经 current_ 中转）
    current_ = out;
    current_.autoExpanded = bufferMs_ > config_.requestedBufferMs;
    if (share != OutputMode::Exclusive) {
      degradedSinceMs_ = 0;  // 降级态：允许探测（首次立即）
      nextProbeMs_ = 0;
    } else {
      degradedSinceMs_ = -1;
    }
    return out;
  };

  for (const OutputMode share : EffectiveOrder()) {
    // 整型容器硬约束（§23：float32 独占全设备不支持）——非整型直接跳独占。
    if (share == OutputMode::Exclusive && !base.integerEncoding) {
      Note("skip exclusive: non-integer source format");
      continue;
    }
    OpenAttempt attempt = base;
    attempt.share = share;
    attempt.bufferMs = bufferMs_;
    OpenResult r = tryOpen(attempt);
    if (r.ok) return succeed(share);
    Note(std::string("open ") + ModeName(share) + " failed: " +
         (r.fail == FailKind::Busy                ? "device busy"
          : r.fail == FailKind::FormatUnsupported ? "format unsupported"
          : r.fail == FailKind::BufferTooSmall    ? "buffer below device minimum"
                                                   : "unknown"));
    // §7.2：buffer 低于设备下限 → 抬到 minPeriod（向上取整到阶梯档）同 share 重试一次。
    if (r.fail == FailKind::BufferTooSmall && r.minPeriodMs > attempt.bufferMs) {
      int raised = r.minPeriodMs;
      for (const int step : Ladder()) {
        if (step >= raised) { raised = step; break; }
      }
      raised = std::min(std::max(raised, r.minPeriodMs), config_.bufferMaxMs);
      if (raised > bufferMs_) {
        bufferMs_ = raised;
        Note("buffer raised to device minimum " + std::to_string(raised) + "ms");
        OpenAttempt retry = attempt;
        retry.bufferMs = raised;
        r = tryOpen(retry);
        if (r.ok) return succeed(share);
        Note(std::string("retry at ") + std::to_string(raised) + "ms still failed");
      }
    }
  }
  // 全败：opened=false，交调用方按 internal 处理；账本保留供诊断。
  out.timeline = timeline_;
  current_ = out;
  return out;
}

int OutputPolicy::OnUnderrun(int64_t nowMs) {
  if (!config_.autoExpandBuffer) return 0;
  if (nowMs - windowStartMs_ > kWindowMs) {
    windowStartMs_ = nowMs;
    windowHits_ = 0;
  }
  ++windowHits_;
  if (windowHits_ < kHitsToExpand) return 0;
  windowHits_ = 0;
  const auto ladder = Ladder();
  const auto it = std::find_if(ladder.begin(), ladder.end(), [&](int s) { return s > bufferMs_; });
  if (it == ladder.end()) return 0;  // 已封顶
  const int next = *it;
  Note("underrun x" + std::to_string(kHitsToExpand) + " in window -> buffer " +
       std::to_string(bufferMs_) + "ms -> " + std::to_string(next) + "ms (auto-expand)");
  bufferMs_ = next;
  current_.bufferMs = next;
  current_.autoExpanded = true;
  return next;
}

bool OutputPolicy::ProbeDue(int64_t nowMs) const {
  if (current_.achieved == OutputMode::Exclusive) return false;  // 已独占无需探测
  if (config_.mode == OutputMode::Shared) return false;          // 用户明确只要共享
  return nextProbeMs_ == 0 || nowMs >= nextProbeMs_;
}

void OutputPolicy::OnProbeResult(bool exclusiveAvailable, int64_t nowMs) {
  nextProbeMs_ = nowMs + kProbeIntervalMs;
  if (exclusiveAvailable) {
    Note("exclusive probe: available (will re-acquire at track gap)");
    // 重开流的决定权在调用方（Session）：它掌握"曲间间隙/暂停"时机（§7.2 不打断当前曲）。
    degradedSinceMs_ = -1;
  } else {
    if (degradedSinceMs_ < 0) degradedSinceMs_ = nowMs;
  }
}

void OutputPolicy::UpdateConfig(const OutputPolicyConfig& config) {
  config_ = config;
  bufferMs_ = std::max(1, config.requestedBufferMs);
  current_ = {};
  timeline_.clear();
  windowHits_ = 0;
  nextProbeMs_ = 0;
}

}  // namespace rhine
