// spectrum.h — 解码→输出链上的只读频谱 tap（M3；AUDIO-ENGINE §10，规格移植 musicfox
// go-musicfox/internal/player/spectrum.go：FFT 1024 / Hann / 预计算 twiddle / 64 对数带 /
// EMA 帧平均 / harmonica 临界阻尼弹簧；L/R 分离 + 主 bin 相位）。
//
// 线程模型（任务书红线：音频回调零分配/零锁/零 IO）：
//   · 生产者 = 音频回调线程（唯一）：PushFromCallback 只把已弹出的 s32 帧 memcpy 进
//     预分配滑动窗，每累积 512 新帧把整窗 1024 帧提交到一个空闲 slot（再 memcpy 8KB，
//     零分配）；无空闲 slot 丢本次提交（latest-wins，与 musicfox 同语义）。
//   · 消费者 = IPC 会话线程：AnalyzeFrame 以 30Hz 节拍调用——s32→float 换算、FFT×2ch、
//     带聚合、EMA、弹簧、low/mid/high/activity/beat_phase，组协议 §6（v1.3 定形）payload。
//   · 订阅开关 enabled（cmd spectrum.on/off，默认 off = 无消费者不产出，回调零开销直返）。
// 采样率适配：slot 携带设备实际 rate，带映射 lo=60 / hi=min(16000, rate/2) 按真实率归一。
// 相位谱：按规格计算并保存在成员（payload 不含——协议 v1.3 §6 定形无此字段；
//   为 M5 之后的示波器/3D 频谱预留，见 docs/M3-FINDINGS.md）。
#pragma once

#include <array>
#include <atomic>
#include <complex>
#include <cstddef>
#include <cstdint>

#include "protocol.h"

namespace rhine {

inline constexpr int kSpectrumBands = 64;      // 对数带数（musicfox SpectrumBandCount）
inline constexpr int kSpectrumFFT = 1024;      // FFT 点数
inline constexpr int kTapSlots = 3;            // 槽位数（musicfox spectrumSlots）
inline constexpr std::uint32_t kTapCommitFrames = 512;  // 每半个窗提交一次
// slot.state：0=free（生产者可写）/ 1=writing（仅生产者瞬时）/ 2=ready（待读）/ 3=reading（消费者独占）

class SpectrumTap {
public:
    SpectrumTap();

    // —— 音频回调线程（唯一生产者）——
    // enabled=false 时零开销直返；否则只 memcpy + 原子置位（红线 A1）。
    void PushFromCallback(const std::int32_t* interleaved, std::size_t frames, std::uint32_t rate);
    void SetEnabled(bool on) { enabled_.store(on, std::memory_order_relaxed); }
    bool enabled() const { return enabled_.load(std::memory_order_relaxed); }

    // —— IPC 会话线程（30Hz 节拍消费者）——
    // 分析最新 slot 产出 evt{spectrum} payload；无新音频（>150ms）时 target 回落 0，
    // 弹簧把 pause/stop 的包络平滑收拢（协议 §6 v1.3 语义）。
    proto::Json AnalyzeFrame();
    // 曲目/采样率变化时复位聚合侧（弹簧/EMA/包络全零）。
    void Reset();

private:
    struct Slot {
        std::array<std::int32_t, kSpectrumFFT * 2> samples{};
        std::uint32_t rate = 0;
        std::uint64_t sequence = 0;
        // 0=free（生产者可写）/ 2=ready（数据完整待读）/ 3=reading（消费者独占）。
        std::atomic<std::uint32_t> state{0};
    };

    // FFT 一整窗（srcSlot 的 L 或 R 声道，交错步长 2）→ 64 带 dB 级别 + 主 bin 相位。
    void AnalyzeChannel(const std::int32_t* interleaved, bool rightChannel, std::uint32_t rate,
                        double* levels, double* phases);
    // radix-2 迭代 FFT（musicfox transform 同款：前置补零 + 位反转 + 蝶形）。
    void Transform(const float* windowed);

    std::atomic<bool> enabled_{false};

    // —— 回调线程独占状态（无并发访问，无需原子）——
    std::array<std::int32_t, kSpectrumFFT * 2> window_{};  // 滑动窗（1024 帧 × 2ch）
    std::size_t writePos_ = 0;                              // 环内写位置（帧）
    std::uint32_t sinceCommit_ = 0;                         // 距上次提交的新帧数
    std::uint64_t sequence_ = 0;                            // 提交序号（latest-wins 依据）

    // —— 跨线程共享：槽位（生产者写入/消费者读取，CAS 状态机）——
    std::array<Slot, kTapSlots> slots_;

    // —— 消费者线程独占状态 ——
    std::array<double, kSpectrumBands> targetL_{};  // EMA 后的目标级别
    std::array<double, kSpectrumBands> targetR_{};
    std::array<double, kSpectrumBands> avgL_{};     // EMA 状态（musicfox avgLevelsL/R）
    std::array<double, kSpectrumBands> avgR_{};
    std::array<double, kSpectrumBands> posL_{};     // 弹簧位置/速度（harmonica）
    std::array<double, kSpectrumBands> velL_{};
    std::array<double, kSpectrumBands> posR_{};
    std::array<double, kSpectrumBands> velR_{};
    std::array<double, kSpectrumBands> phaseL_{};   // 预留（不进 payload，见文件头）
    std::array<double, kSpectrumBands> phaseR_{};
    std::array<std::complex<double>, kSpectrumFFT> fft_{};
    std::array<float, kSpectrumFFT> mono_{};        // s32→f32 × Hann 的中转
    std::array<double, kSpectrumFFT> windowCoeff_{};  // Hann（构建一次）
    // beat_phase：低频包络上升沿计时（简化包络检测，语义见 M3-FINDINGS）。
    double lastBeatUptimeS_ = -1.0;
    double beatIntervalS_ = 0.5;  // 间隔 EMA 初值（120bpm）
    double lowBaseline_ = 0.0;    // 低频能量慢速基线
    bool armed_ = true;           // 触发后休眠到包络回落
    std::atomic<std::int64_t> lastDataMs_{0};  // 最近一次新音频提交时刻（回调写/消费读）
};

}  // namespace rhine
