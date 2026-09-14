// M4-a：输出协商状态机（AUDIO-ENGINE §7.2）——纯逻辑零 miniaudio 依赖，
// 开设备以回调注入（单测 WSL 直跑，同 FakeEngine/Ring 的"逻辑与 IO 分离"纪律）。
//
// 职责：
//   · 模式请求（shared/exclusive/auto）→ 尝试序列（fallback_order）→ 结果分类；
//   · underrun 滑动窗口 → 缓冲自动升档（Q1-c：min→5→10→25→50→100→300ms 封顶，
//     auto_expand_buffer=false 或 buffer_max_ms 锁定）；
//   · 独占恢复探测节奏（§7.2：降级后每 5s 判"可探测时刻"，只在曲间间隙/暂停时探测——
//     keep 是"我占着不让"，不是"我抢别人的"）。
// 线程模型：单线程使用方（Session 循环）调用；本类不自加锁。
#pragma once

#include <cstdint>
#include <functional>
#include <string>
#include <vector>

namespace rhine {

enum class OutputMode { Shared, Exclusive, Auto };

struct OutputPolicyConfig {
  // §15 默认值纪律：**独占绝不默认开**（默认 Auto 会在首播就静默抢独占、吓到普通用户）
  // ——核心默认 Shared；auto/exclusive 由设置预设或 output.mode 显式开启。
  OutputMode mode = OutputMode::Shared;    // 用户请求（config output.mode）
  int requestedBufferMs = 10;              // 用户基准缓冲
  bool autoExpandBuffer = true;            // Q1-c 主对策开关
  int bufferMaxMs = 300;                   // 升档天花板（用户经验值）
  std::vector<OutputMode> fallbackOrder;   // 空 = 按 mode 推导（auto:{Excl,Shared}; 其余单元素）
};

// 一次开设备尝试的输入/输出（IO 方填）。
struct OpenAttempt {
  OutputMode share = OutputMode::Shared;
  int bufferMs = 10;
  int periodMs = 5;
  int rate = 44100;
  int bitsContainer = 32;   // 16 或 32（i24-in-i32）
  int bitsValid = 24;
  bool integerEncoding = true;   // float32 独占全设备不支持（§23 实锤）→ false 时独占必败
};

enum class FailKind { None, Busy, FormatUnsupported, BufferTooSmall, Unknown };

struct OpenResult {
  bool ok = false;
  FailKind fail = FailKind::None;
  int minPeriodMs = 3;      // 失败时可携带设备下限信息
};

struct Negotiation {
  bool opened = false;                 // 全败时 false（调用方按 internal 处理）
  OutputMode achieved = OutputMode::Shared;
  int bufferMs = 10;
  int periodMs = 5;
  bool autoExpanded = false;
  std::vector<std::string> timeline;   // 人读降级/升档事件（诊断页时间线，≤20 条滚动）
  bool degraded = false;               // 未达成用户请求模式
};

class OutputPolicy {
public:
  using OpenFn = std::function<OpenResult(const OpenAttempt&)>;

  explicit OutputPolicy(OutputPolicyConfig config = {});

  // —— 协商主流程：按 fallbackOrder × 升档序列尝试 tryOpen；成功即停。
  // 返回 achieved 结果；timeline 累积事件。tryOpen 由 IO 方注入（真机=ma_device_init 包装）。
  Negotiation Negotiate(const OpenFn& tryOpen, const OpenAttempt& base);

  // —— underrun 记账（IO 方在设备事件里喂）：滑动窗口计数触发升档请求。
  // 返回新的目标 bufferMs（未变则 0，调用方只在 >0 时重开流）。
  int OnUnderrun(int64_t nowMs);

  // —— 降级后的恢复探测：返回 true = 此刻允许发起一次独占探测（曲间/暂停由调用方保证）。
  bool ProbeDue(int64_t nowMs) const;
  void OnProbeResult(bool exclusiveAvailable, int64_t nowMs);

  // —— 用户配置变更（设置页）：立即生效于下次 Negotiate；重置升档。
  void UpdateConfig(const OutputPolicyConfig& config);

  const Negotiation& current() const { return current_; }
  const OutputPolicyConfig& config() const { return config_; }  // 读回现策略（engine 改前取值）
  // M4 接线：IO 层降级事实记入时间线（不改变状态机，纯账本）。
  void NoteDegrade(const std::string& line) { Note(line); }
  OutputMode requested() const { return config_.mode; }
  int bufferMs() const { return bufferMs_; }
  bool autoExpanded() const { return current_.autoExpanded; }

  // 升档阶梯（公开供单测/诊断）：设备 min → 5 → 10 → 25 → 50 → 100 → 300（≤bufferMax 截断）。
  std::vector<int> Ladder() const;

private:
  std::vector<OutputMode> EffectiveOrder() const;
  void Note(const std::string& line);   // 追加到持久 timeline_（滚动 ≤20）

  OutputPolicyConfig config_;
  int bufferMs_;
  Negotiation current_;
  std::vector<std::string> timeline_;   // 跨多次 Negotiate 持久累积（succeed 不抹）

  // underrun 滑窗（10s 窗口 ≥3 次 → 升一档）
  int64_t windowStartMs_ = 0;
  int windowHits_ = 0;
  static constexpr int kWindowMs = 10'000;
  static constexpr int kHitsToExpand = 3;

  // 恢复探测节奏
  int64_t degradedSinceMs_ = -1;
  int64_t nextProbeMs_ = -1;
  static constexpr int64_t kProbeIntervalMs = 5'000;
};

}  // namespace rhine
