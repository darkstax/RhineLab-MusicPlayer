// spectrum.cpp — 见 spectrum.h 的契约。数值规格逐条对照 musicfox spectrum.go：
//   Hann:      0.5 * (1 - cos(2πi/(N-1)))
//   FFT:       迭代 radix-2，位反转交换后蝶形；twiddle[k] = e^{-2πik/N}（预计算）
//   带映射:    lo=60, hi=min(16000, rate/2)，ratio=hi/lo，
//              startFreq = lo * ratio^(band/64)，endFreq = lo * ratio^((band+1)/64)
//              startBin = max(1, floor(startFreq*N/rate))，endBin = min(N/2, ceil(endFreq*N/rate))
//   级别:      mag = max|X(bin)|（带内幅值最大 bin，同 bin 记相位 atan2），
//              db = 20*log10(mag*4/N + 1e-9)，level = clamp01((db+72)/72)   ← logScale 默认开
//   EMA:       alpha = 1/avg（avg=2 → 0.5，本项目定值），out = raw*alpha + prev*(1-alpha)
//   弹簧:      harmonica.NewSpring(dt, 9, 1)（临界阻尼分支）逐带 Update 后 clamp01
#include "spectrum.h"

#include <algorithm>
#include <cmath>
#include <cstring>

#include <windows.h>

namespace rhine {
namespace {

constexpr double kTwoPi = 6.283185307179586;
constexpr double kFullScale = 2147483648.0;  // 2^31：s32 → [-1,1)
constexpr int kAvgFactor = 2;                // EMA 平均帧数（musicfox SpectrumAverage，本项目定 2）
constexpr double kEmitHz = 30.0;             // 事件节拍（协议 §6）

std::int64_t SteadyMsLocal() {
    return static_cast<std::int64_t>(GetTickCount64());  // 单调毫秒（与 steady 时钟同量级用途）
}

std::uint32_t ReverseBits10(std::uint32_t v) {
    std::uint32_t rev = 0;
    for (int bit = 0; bit < 10; ++bit) {  // log2(1024) = 10（musicfox reverseSpectrumBits）
        rev = rev << 1 | (v & 1u);
        v >>= 1;
    }
    return rev;
}

double Clamp01(double v) { return std::min(1.0, std::max(0.0, v)); }

}  // namespace

SpectrumTap::SpectrumTap() {
    for (int i = 0; i < kSpectrumFFT; ++i) {
        windowCoeff_[i] =
            static_cast<double>(0.5f *
                                (1.0f - static_cast<float>(std::cos(kTwoPi * i / (kSpectrumFFT - 1)))));
    }
}

// ---------------------------------------------------------------------------
// 生产者（音频回调线程）：memcpy + 原子置位，零分配零锁。
// ---------------------------------------------------------------------------

void SpectrumTap::PushFromCallback(const std::int32_t* interleaved, std::size_t frames,
                                   std::uint32_t rate) {
    if (!enabled_.load(std::memory_order_relaxed) || frames == 0 || rate == 0) return;

    const std::size_t cap = kSpectrumFFT;
    for (std::size_t f = 0; f < frames; ++f) {
        const std::size_t pos = writePos_;
        window_[pos * 2] = interleaved[f * 2];
        window_[pos * 2 + 1] = interleaved[f * 2 + 1];
        writePos_ = (pos + 1) % cap;
    }
    sinceCommit_ += static_cast<std::uint32_t>(frames);
    if (sinceCommit_ < kTapCommitFrames) return;
    sinceCommit_ = 0;

    // 提交整窗：找一个 free slot；无空闲 → 丢本次（latest-wins）。
    for (auto& slot : slots_) {
        std::uint32_t expected = 0;  // free
        if (!slot.state.compare_exchange_strong(expected, 1, std::memory_order_acq_rel,
                                                std::memory_order_relaxed)) {
            continue;  // 1=writing（仅本线程会置 1，理论不冲突；2=ready/3=reading 跳过）
        }
        std::memcpy(slot.samples.data(), window_.data(), sizeof(std::int32_t) * kSpectrumFFT * 2);
        slot.rate = rate;
        slot.sequence = ++sequence_;
        slot.state.store(2, std::memory_order_release);  // ready
        lastDataMs_.store(SteadyMsLocal(), std::memory_order_relaxed);
        return;
    }
}

void SpectrumTap::Reset() {
    targetL_.fill(0);
    targetR_.fill(0);
    avgL_.fill(0);
    avgR_.fill(0);
    posL_.fill(0);
    velL_.fill(0);
    posR_.fill(0);
    velR_.fill(0);
    phaseL_.fill(0);
    phaseR_.fill(0);
    lastBeatUptimeS_ = -1.0;
    lowBaseline_ = 0.0;
    armed_ = true;
    lastDataMs_.store(0, std::memory_order_relaxed);
}

// ---------------------------------------------------------------------------
// FFT（消费者线程）：输入 = mono_（已乘 Hann 的 float 单声道），原地迭代 radix-2。
// ---------------------------------------------------------------------------

void SpectrumTap::Transform(const float* windowed) {
    for (int i = 0; i < kSpectrumFFT; ++i) {
        fft_[i] = {static_cast<double>(windowed[i]), 0.0};
    }
    for (int i = 1; i < kSpectrumFFT; ++i) {
        const std::uint32_t rev = ReverseBits10(static_cast<std::uint32_t>(i));
        if (static_cast<std::uint32_t>(i) < rev) std::swap(fft_[i], fft_[rev]);
    }
    // twiddle 现算（5120 次 sincos/FFT 对现代 CPU ≈ 几十 µs，30Hz×2ch 远低于预算；
    // 避免 1024×2 静态表 + once_flag 的初始化顺序负担——增量与 musicfox 的差别仅此一处）。
    for (int size = 2; size <= kSpectrumFFT; size <<= 1) {
        const int half = size / 2;
        const int stride = kSpectrumFFT / size;
        for (int offset = 0; offset < kSpectrumFFT; offset += size) {
            for (int i = 0; i < half; ++i) {
                const double angle = -kTwoPi * static_cast<double>(i * stride) / kSpectrumFFT;
                const std::complex<double> w(std::cos(angle), std::sin(angle));
                const auto even = fft_[static_cast<std::size_t>(offset + i)];
                const auto odd = w * fft_[static_cast<std::size_t>(offset + i + half)];
                fft_[static_cast<std::size_t>(offset + i)] = even + odd;
                fft_[static_cast<std::size_t>(offset + i + half)] = even - odd;
            }
        }
    }
}

void SpectrumTap::AnalyzeChannel(const std::int32_t* interleaved, bool rightChannel,
                                 std::uint32_t rate, double* levels, double* phases) {
    const int shift = rightChannel ? 1 : 0;
    for (int i = 0; i < kSpectrumFFT; ++i) {
        mono_[static_cast<std::size_t>(i)] = static_cast<float>(
            static_cast<double>(interleaved[static_cast<std::size_t>(i) * 2 + shift]) *
            (1.0 / kFullScale)) * static_cast<float>(windowCoeff_[static_cast<std::size_t>(i)]);
    }
    Transform(mono_.data());

    const double lo = 60.0;
    const double hi = std::min(16000.0, static_cast<double>(rate) / 2.0);
    if (hi <= lo) {
        std::fill_n(levels, kSpectrumBands, 0.0);
        std::fill_n(phases, kSpectrumBands, 0.0);
        return;
    }
    const double ratio = hi / lo;
    const double fftScale = 4.0 / static_cast<double>(kSpectrumFFT);
    for (int band = 0; band < kSpectrumBands; ++band) {
        const double startFreq = lo * std::pow(ratio, static_cast<double>(band) / kSpectrumBands);
        const double endFreq =
            lo * std::pow(ratio, static_cast<double>(band + 1) / kSpectrumBands);
        int startBin =
            std::max(1, static_cast<int>(std::floor(startFreq * kSpectrumFFT / rate)));
        int endBin = std::min(kSpectrumFFT / 2,
                              static_cast<int>(std::ceil(endFreq * kSpectrumFFT / rate)));
        if (endBin <= startBin) endBin = std::min(kSpectrumFFT / 2, startBin + 1);
        double mag = 0.0;
        double bestPhase = 0.0;
        for (int bin = startBin; bin < endBin; ++bin) {
            const auto& v = fft_[static_cast<std::size_t>(bin)];
            const double m = std::hypot(v.real(), v.imag());
            if (m > mag) {
                mag = m;
                bestPhase = std::atan2(v.imag(), v.real());
            }
        }
        const double db = 20.0 * std::log10(mag * fftScale + 1e-9);
        levels[band] = Clamp01((db + 72.0) / 72.0);
        phases[band] = bestPhase;
    }
}

// ---------------------------------------------------------------------------
// 30Hz 帧（IPC 会话线程）：取最新 slot → EMA → 弹簧 → 聚合 → payload。
// ---------------------------------------------------------------------------

proto::Json SpectrumTap::AnalyzeFrame() {
    // 取最新 ready slot（musicfox analyzeLatest：CAS ready→reading，多个取 sequence 最大，
    // 其余归还 free）。
    Slot* latest = nullptr;
    for (auto& slot : slots_) {
        std::uint32_t expected = 2;  // ready
        if (!slot.state.compare_exchange_strong(expected, 3, std::memory_order_acq_rel,
                                                std::memory_order_relaxed)) {
            continue;
        }
        if (latest == nullptr || slot.sequence > latest->sequence) {
            if (latest != nullptr) latest->state.store(0, std::memory_order_release);
            latest = &slot;
        } else {
            slot.state.store(0, std::memory_order_release);
        }
    }

    const std::int64_t nowMs = SteadyMsLocal();

    if (latest != nullptr) {
        std::array<double, kSpectrumBands> rawL{};
        std::array<double, kSpectrumBands> rawR{};
        AnalyzeChannel(latest->samples.data(), false, latest->rate, rawL.data(), phaseL_.data());
        AnalyzeChannel(latest->samples.data(), true, latest->rate, rawR.data(), phaseR_.data());
        const double alpha = 1.0 / static_cast<double>(kAvgFactor);
        for (int band = 0; band < kSpectrumBands; ++band) {
            avgL_[band] = rawL[band] * alpha + avgL_[band] * (1.0 - alpha);
            avgR_[band] = rawR[band] * alpha + avgR_[band] * (1.0 - alpha);
            targetL_[band] = avgL_[band];
            targetR_[band] = avgR_[band];
        }
        latest->state.store(0, std::memory_order_release);  // 归还 free
    } else {
        // 无新音频（暂停/停止/未开订阅后的空转）：目标逐帧直落 0，由弹簧收拢。
        targetL_.fill(0);
        targetR_.fill(0);
        avgL_.fill(0);
        avgR_.fill(0);
    }

    // harmonica 临界阻尼弹簧（deltaTime=1/30, ω=9, ζ=1 —— musicfox NewSpring 同参）。
    constexpr double dt = 1.0 / kEmitHz;
    constexpr double omega = 9.0;
    constexpr double zeta = 1.0;
    const double expTerm = std::exp(-omega * zeta * dt);
    const double timeExp = dt * expTerm;
    const double posPos = timeExp * omega + expTerm;   // 临界阻尼分支系数
    const double posVel = timeExp;
    const double velPos = -omega * timeExp * omega;
    const double velVel = -timeExp * omega + expTerm;
    auto spring = [&](double* pos, double* vel, const double* target) {
        for (int band = 0; band < kSpectrumBands; ++band) {
            const double oldPos = pos[band] - target[band];
            const double oldVel = vel[band];
            pos[band] = Clamp01(oldPos * posPos + oldVel * posVel + target[band]);
            vel[band] = oldPos * velPos + oldVel * velVel;
        }
    };
    spring(posL_.data(), velL_.data(), targetL_.data());
    spring(posR_.data(), velR_.data(), targetR_.data());

    // 聚合（协议 §6 v1.3：low=0–7、mid=8–31、high=32–63 的 RMS(L/R 均值)；activity=全带均值）。
    auto rms = [](const double* l, const double* r, int from, int to) {
        double sum = 0.0;
        for (int band = from; band < to; ++band) {
            const double m = (l[band] + r[band]) * 0.5;
            sum += m * m;
        }
        return Clamp01(std::sqrt(sum / static_cast<double>(to - from)));
    };
    const double low = rms(posL_.data(), posR_.data(), 0, 8);
    const double mid = rms(posL_.data(), posR_.data(), 8, 32);
    const double high = rms(posL_.data(), posR_.data(), 32, 64);
    double activitySum = 0.0;
    for (int band = 0; band < kSpectrumBands; ++band) {
        activitySum += (posL_[band] + posR_[band]) * 0.5;
    }
    const double activity = Clamp01(activitySum / kSpectrumBands);

    // beat_phase（任务书 §A3 简化实现）：低频能量（带 0–3 均值）相对慢速基线的上穿触发拍点。
    double lowEnergy = 0.0;
    for (int band = 0; band < 4; ++band) lowEnergy += (posL_[band] + posR_[band]) * 0.5;
    lowEnergy /= 4.0;
    lowBaseline_ += (lowEnergy - lowBaseline_) * 0.02;  // 慢速基线（≈时间常数 0.5s）
    const double uptimeS = static_cast<double>(nowMs) / 1000.0;
    if (armed_ && lowEnergy > lowBaseline_ + 0.06 && lowEnergy > 0.08) {
        const double gap = lastBeatUptimeS_ < 0 ? 0.0 : uptimeS - lastBeatUptimeS_;
        lastBeatUptimeS_ = uptimeS;
        armed_ = false;
        if (gap > 0.18 && gap < 2.0) {  // 合理区间才更新周期估计（0.5~5.5Hz）
            beatIntervalS_ = beatIntervalS_ * 0.7 + gap * 0.3;
        }
    }
    if (!armed_ && lowEnergy < lowBaseline_ + 0.02) armed_ = true;  // 回落后可再触发
    double beatPhase = 1.0;
    if (lastBeatUptimeS_ >= 0.0) {
        beatPhase = Clamp01((uptimeS - lastBeatUptimeS_) / beatIntervalS_);
    }

    // payload（协议 §6 v1.3：float 归一 0..1，统一 4 位小数控制帧体积）。
    auto quantize = [](double v) { return std::round(std::clamp(v, 0.0, 1.0) * 10000.0) / 10000.0; };
    proto::Json bandsL = proto::Json::array();
    proto::Json bandsR = proto::Json::array();
    for (int band = 0; band < kSpectrumBands; ++band) {
        bandsL.push_back(quantize(posL_[band]));
        bandsR.push_back(quantize(posR_[band]));
    }
    return proto::Json{{"bands_l", std::move(bandsL)},
                       {"bands_r", std::move(bandsR)},
                       {"low", quantize(low)},
                       {"mid", quantize(mid)},
                       {"high", quantize(high)},
                       {"activity", quantize(activity)},
                       {"beat_phase", quantize(beatPhase)}};
}

}  // namespace rhine
