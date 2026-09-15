// audio.cpp — 见 audio.h 的契约与线程模型说明。
#include <windows.h>

#include "audio.h"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstring>
#include <thread>

namespace rhine {
namespace {

std::int64_t SteadyMs() {
    using namespace std::chrono;
    return duration_cast<milliseconds>(steady_clock::now().time_since_epoch()).count();
}

const char* FormatName(ma_format format) {
    switch (format) {
        case ma_format_s16: return "s16";
        case ma_format_s24: return "s24";
        case ma_format_s32: return "s32";
        case ma_format_f32: return "f32";
        case ma_format_u8: return "u8";
        default: return "unknown";
    }
}

int FormatBits(ma_format format) {
    switch (format) {
        case ma_format_s16: return 16;
        case ma_format_s24: return 24;
        case ma_format_s32: return 32;
        case ma_format_f32: return 32;
        case ma_format_u8: return 8;
        default: return 0;
    }
}

std::string ToLower(std::string s) {
    std::transform(s.begin(), s.end(), s.begin(),
                   [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
    return s;
}

std::string EncodingOf(const std::string& lowerPath) {
    const auto dot = lowerPath.find_last_of('.');
    std::string ext = dot == std::string::npos ? std::string() : lowerPath.substr(dot + 1);
    if (ext == "flac") return "flac";
    if (ext == "mp3") return "mp3";
    if (ext == "wav") return "wav";
    return ext.empty() ? std::string("unknown") : ext;
}

// UTF-8 → 宽字符：miniaudio 的 _init_file() 走 fopen（ACP），中文/全角路径会失败；
// 必须用 _init_file_w（内部 _wfopen）才能播 C:\Users\…\音乐 下的真实曲库（冒烟约束）。
std::wstring Utf8ToWideLocal(const std::string& utf8) {
    if (utf8.empty()) return {};
    const int need = MultiByteToWideChar(CP_UTF8, 0, utf8.data(), static_cast<int>(utf8.size()),
                                         nullptr, 0);
    std::wstring out(static_cast<std::size_t>(need), L'\0');
    MultiByteToWideChar(CP_UTF8, 0, utf8.data(), static_cast<int>(utf8.size()), out.data(), need);
    return out;
}

// 源文件原生位深探测（24bit 红线取证）：ma_decoder 的 probe（format=unknown）对 FLAC 报
// f32（backend 默认输出），不是源的真实整数格式；直读容器头才能如实上报 chain 的
// decoder 节点（flac s16/s24/s32、wav PCM/IEEE float；mp3 本质 float）。
// 返回空串 = 探不到（交回 probe 值）。
std::string ProbeSourceNativeFormat(const std::string& utf8Path) {
    FILE* f = _wfopen(Utf8ToWideLocal(utf8Path).c_str(), L"rb");
    if (f == nullptr) return {};
    unsigned char hdr[64] = {0};
    const size_t got = std::fread(hdr, 1, sizeof(hdr), f);
    std::fclose(f);
    if (got < 12) return {};
    if (std::memcmp(hdr, "fLaC", 4) == 0 && got >= 22) {
        // STREAMINFO（首块必须紧跟 magic）：byte20.bit0 = bps 最高位，byte21 高 4 位 = 低 4 位（存值=真值-1）
        const std::uint64_t bits =
            (static_cast<std::uint64_t>(hdr[20] & 0x01) << 4) | (hdr[21] >> 4);
        const std::uint64_t bps = bits + 1;
        if (bps <= 16) return "s16";
        if (bps <= 24) return "s24";
        if (bps <= 32) return "s32";
        return {};
    }
    if (std::memcmp(hdr, "RIFF", 4) == 0 && std::memcmp(hdr + 8, "WAVE", 4) == 0 && got >= 36) {
        // fmt 子块通常在 12：'fmt ' size=16/18/40
        if (std::memcmp(hdr + 12, "fmt ", 4) == 0) {
            const std::uint16_t tag = static_cast<std::uint16_t>(hdr[20] | (hdr[21] << 8));
            const std::uint16_t bits = static_cast<std::uint16_t>(hdr[34] | (hdr[35] << 8));
            if (tag == 0x0003) return bits == 64 ? "f64" : "f32";  // IEEE float
            if (tag == 0x0001) {
                if (bits <= 16) return "s16";
                if (bits <= 24) return "s24";
                if (bits <= 32) return "s32";
            }
        }
        return {};
    }
    if (std::memcmp(hdr, "ID3", 3) == 0) return "f32";  // mp3 with tag
    if ((hdr[0] == 0xFF && (hdr[1] & 0xE0) == 0xE0) || hdr[0] == 0x33) return "f32";  // mpeg frame/sync
    if (hdr[0] == 'O' && hdr[1] == 'g' && hdr[2] == 'g') return "f32";                // ogg/vorbis（如扩展）
    return {};
}

std::string WideToUtf8Local(const wchar_t* wide) {
    if (wide == nullptr || *wide == 0) return {};
    const int need = WideCharToMultiByte(CP_UTF8, 0, wide, -1, nullptr, 0, nullptr, nullptr);
    if (need <= 1) return {};
    std::string out(static_cast<std::size_t>(need) - 1, '\0');
    WideCharToMultiByte(CP_UTF8, 0, wide, -1, out.data(), need - 1, nullptr, nullptr);
    return out;
}

constexpr double kFullScale = 2147483648.0;  // 2^31：s32 → [-1,1)

}  // namespace

AudioBackend::AudioBackend() {
    chunkS32_.resize(static_cast<std::size_t>(kChunkFrames) * 2);
    ringStorage_.resize(kRingBytes);
    // 环：预分配自有缓冲（回调零分配红线）；s32 × 2ch × 65536 帧。
    const ma_result rbRc = ma_pcm_rb_init_ex(
        ma_format_s32, kRingChannels, kRingFrames, 1, kRingFrames, ringStorage_.data(), nullptr, &ring_);
    if (rbRc != MA_SUCCESS) {
        // 理论上不可达（init_ex 传预分配缓冲只校验参数）；失败时置空，首次 push/pop 自降级。
        ring_.rb.pBuffer = nullptr;
    }
}

AudioBackend::~AudioBackend() {
    CloseTrack();
    CloseDevice();
    ma_pcm_rb_uninit(&ring_);
}

// ---------------------------------------------------------------------------
// 环适配层（M5a 债 1）：ma_pcm_rb 的 acquire/commit 每次只交出一段连续区间，
// 回绕需循环调用；语义与旧 SpscRing 逐条对齐：
//   push：满时丢多余帧（只写可用空间），返回实写帧数；
//   pop ：不足时读全部可读帧，返回实读帧数；
//   readable：写-读指针字节距离 ÷ 8（EOF 排空判据 EofDrained 消费，M2-FINDINGS §7.2 语义保持）。
// ---------------------------------------------------------------------------

std::size_t AudioBackend::RingPush(const std::int32_t* data, std::size_t frames) {
    std::size_t written = 0;
    while (written < frames) {
        ma_uint32 want = static_cast<ma_uint32>(frames - written);
        void* dst = nullptr;
        if (ma_pcm_rb_acquire_write(&ring_, &want, &dst) != MA_SUCCESS || want == 0) break;
        std::memcpy(dst, data + written * kRingChannels,
                    static_cast<std::size_t>(want) * kRingChannels * sizeof(std::int32_t));
        if (ma_pcm_rb_commit_write(&ring_, want) != MA_SUCCESS) break;
        written += want;
    }
    return written;
}

std::size_t AudioBackend::RingPop(std::int32_t* data, std::size_t frames) {
    std::size_t got = 0;
    while (got < frames) {
        ma_uint32 want = static_cast<ma_uint32>(frames - got);
        void* src = nullptr;
        if (ma_pcm_rb_acquire_read(&ring_, &want, &src) != MA_SUCCESS || want == 0) break;
        std::memcpy(data + got * kRingChannels, src,
                    static_cast<std::size_t>(want) * kRingChannels * sizeof(std::int32_t));
        if (ma_pcm_rb_commit_read(&ring_, want) != MA_SUCCESS) break;
        got += want;
    }
    return got;
}

std::size_t AudioBackend::RingReadableFrames() {
    const ma_int32 bytes = ma_rb_pointer_distance(&ring_.rb);
    return bytes > 0 ? static_cast<std::size_t>(bytes) / (kRingChannels * sizeof(std::int32_t)) : 0;
}

// ---------------------------------------------------------------------------
// 设备：WASAPI 共享（miniaudio 在 shared 下无条件使用 AUDCLNT_STREAMFLAGS_EVENTCALLBACK，
// 即任务书要求的「共享·事件模式」——见 vendor/miniaudio.h:23655）。
// ---------------------------------------------------------------------------

bool AudioBackend::OpenDevice(std::string& error) {
    if (deviceOpen_.load(std::memory_order_acquire)) return true;

    ma_context_config ctxConfig = ma_context_config_init();
    if (ma_context_init(nullptr, 0, &ctxConfig, &context_) != MA_SUCCESS) {
        error = "ma_context_init failed (no audio backend?)";
        return false;
    }
    if (!CacheDefaultEndpoint()) {  // 枚举默认端点：name/mix 格式/独占能力表
        ma_context_uninit(&context_);
        error = "ma_device_init failed (no default render endpoint?)";
        return false;
    }
    // 启动默认共享（播放期按源格式可切独占，见 ReopenForTrack / M4）。
    return OpenDeviceKind(/*exclusive=*/false, mixRate_, policy_.bufferMs(), error);
}

// 枚举默认端点缓存：混音格式（避免设备层内部重采样）+ 独占能力表
// （nativeDataFormats 的 MA_DATA_FORMAT_FLAG_EXCLUSIVE_MODE 位，s32 容器才算——
//  §23 实锤 float32 独占全设备不支持）。
bool AudioBackend::CacheDefaultEndpoint() {
    ma_device_info* playbackInfos = nullptr;
    ma_uint32 playbackCount = 0;
    ma_device_info* captureInfos = nullptr;
    ma_uint32 captureCount = 0;
    if (ma_context_get_devices(&context_, &playbackInfos, &playbackCount, &captureInfos,
                               &captureCount) != MA_SUCCESS) {
        return false;
    }
    exclusiveFormats_.clear();
    for (ma_uint32 i = 0; i < playbackCount; ++i) {
        if (!playbackInfos[i].isDefault) continue;
        deviceFacts_.name = playbackInfos[i].name;
        // P1-2：跟随默认时**不钉 id**（hasDeviceId_ 保持 false → OpenDeviceKind 传
        // pDeviceID=nullptr → miniaudio 才开 allowPlaybackAutoStreamRouting 并注册
        // IMMNotificationClient；钉死 id 会让热插拔自动跟随与失效通知双双失效）。
        // lastDeviceId_ 仅在 devices.select 显式钉选时置位（见 SelectDevice）。
        for (ma_uint32 f = 0; f < playbackInfos[i].nativeDataFormatCount; ++f) {
            const auto& df = playbackInfos[i].nativeDataFormats[f];
            if (df.channels != 2 || df.sampleRate < 8000) continue;
            if (mixRate_ == 0 && df.format == ma_format_f32) {
                mixFormat_ = df.format;
                mixRate_ = df.sampleRate;
            }
            // 独占能力：s16/s32 容器 + EXCLUSIVE 标志位（s24 设备一般以 s32 容器上报）。
            const bool integer = df.format == ma_format_s16 || df.format == ma_format_s32;
            if (integer && (df.flags & MA_DATA_FORMAT_FLAG_EXCLUSIVE_MODE) != 0) {
                exclusiveFormats_.emplace_back(df.sampleRate, FormatBits(df.format));
            }
        }
        break;
    }
    if (mixRate_ == 0) mixRate_ = 48000;  // 无 f32 混音上报时的兜底（共享几乎总可开）
    return true;
}

// 枚举表参考（仅 devices.list 展示用；M4-a 实测本机枚举表为空 → 恒 false，
// 不得用作开设备门槛——开设备走 ReopenForTrack 的"试开即探测"）。
bool AudioBackend::ExclusiveCapable(ma_uint32 rate) const {
    if (exclusiveFormats_.empty()) return true;  // 枚举表空 = 未知，交给试开判定
    for (const auto& [r, bits] : exclusiveFormats_) {
        (void)bits;
        if (r == rate) return true;
    }
    return false;
}

// 设备打开内核（context 必须已存在）。exclusive：s32 容器 @ 源率（位完美路，无混音器）；
// shared：混音格式 @ 混音率。bufferMs→periodSizeInMilliseconds（OutputPolicy 已钳好）。
bool AudioBackend::OpenDeviceKind(bool exclusive, ma_uint32 rate, int bufferMs,
                                  std::string& error, const ma_device_id* deviceId,
                                  ma_result* rcOut) {
    ma_device_config config = ma_device_config_init(ma_device_type_playback);
    // M4-c：deviceId=nullptr → 跟随系统默认（miniaudio 内置自动重路由，共享模式）；
    // 非空 → 钉选该端点（devices.select 显式指定，或 CacheDefaultEndpoint 缓存的默认）。
    config.playback.pDeviceID = deviceId;
    config.playback.channels = 2;
    if (exclusive) {
        config.playback.format = ma_format_s32;
        config.sampleRate = rate;
        config.playback.shareMode = ma_share_mode_exclusive;
    } else {
        config.playback.format = mixFormat_;
        config.sampleRate = mixRate_;
        config.playback.shareMode = ma_share_mode_shared;
    }
    config.periodSizeInMilliseconds =
        static_cast<ma_uint32>(std::max<std::int64_t>(1, bufferMs / 2));  // periods=2
    config.periods = 2;
    config.dataCallback = &AudioBackend::StaticCallback;
    config.notificationCallback = &AudioBackend::StaticNotification;  // M4-c 设备事件
    config.pUserData = this;

    deviceLostSeen_.store(false, std::memory_order_relaxed);
    const ma_result initRc = ma_device_init(&context_, &config, &device_);
    if (rcOut != nullptr) *rcOut = initRc;
    if (initRc != MA_SUCCESS) {
        error = (exclusive ? "exclusive ma_device_init failed rc=" : "shared ma_device_init failed rc=") +
                std::to_string((int)initRc);
        return false;
    }
    // P2-4：独占路径 miniaudio 用 PKEY_AudioEngine_DeviceFormat 原样开，可能给非 s32
    // （原生 s16 端点）；本实现独占回调按 ma_int32* 写 → 格式不符必越界。校验后拒开。
    if (exclusive && device_.playback.format != ma_format_s32) {
        ma_device_uninit(&device_);
        error = "exclusive granted non-s32 format (native " + std::to_string((int)device_.playback.format) + ")";
        if (rcOut != nullptr) *rcOut = MA_FORMAT_NOT_SUPPORTED;
        return false;
    }
    deviceFacts_.opened = true;
    deviceFacts_.exclusive = exclusive;
    deviceFacts_.appFormat = device_.playback.format;
    deviceFacts_.appRate = device_.sampleRate;
    deviceFacts_.appChannels = device_.playback.channels;
    deviceFacts_.periodFrames = device_.playback.internalPeriodSizeInFrames;
    deviceFacts_.periods = device_.playback.internalPeriods;
    popScratch_.assign(static_cast<std::size_t>(deviceFacts_.periodFrames) * 2 + 4096 * 2, 0);
    deviceOpen_.store(true, std::memory_order_release);
    return true;
}

void AudioBackend::CloseDeviceOnly() {
    StopDeviceIfStarted();
    if (deviceOpen_.load(std::memory_order_acquire)) {
        ma_device_uninit(&device_);
        deviceOpen_.store(false, std::memory_order_release);
        deviceFacts_.opened = false;
        deviceFacts_.exclusive = false;
    }
}

void AudioBackend::StaticNotification(const ma_device_notification* n) {
    if (n != nullptr && n->pDevice != nullptr && n->pDevice->pUserData != nullptr) {
        static_cast<AudioBackend*>(n->pDevice->pUserData)->OnNotification(n);
    }
}

// 通知线程（WASAPI 回调线程）：只置原子旗，重活交会话线程 tick 消费——
// 零分配零阻塞红线；rerouted（共享模式 miniaudio 已自动重路由，这里刷新 facts）
// 与 interruption/失效（独占不自动重路由，需上层重建）统一一面旗。
void AudioBackend::OnNotification(const ma_device_notification* n) {
    // P2（审查）：interruption_began / 失效 = 设备已不可用，必须置 lost 旗；
    // 否则 device_running() 的 lost 判据成死代码（只写 false 从不置 true）。
    if (n->type == ma_device_notification_type_interruption_began) {
        deviceLostSeen_.store(true, std::memory_order_release);
    }
    if (n->type == ma_device_notification_type_rerouted ||
        n->type == ma_device_notification_type_interruption_began ||
        n->type == ma_device_notification_type_interruption_ended) {
        deviceEventPending_.store(true, std::memory_order_release);
    }
}

bool AudioBackend::device_running() const {
    // 名义 started 且未见过失效错误 = 设备活着（拔出/invalidated 的廉价判据）。
    if (!deviceOpen_.load(std::memory_order_acquire)) return false;
    if (deviceLostSeen_.load(std::memory_order_acquire)) return false;
    return ma_device_is_started(const_cast<ma_device*>(&device_)) == MA_TRUE;
}

// M4-c devices.select：钉选设备并立即重开（调用方保证安全点）。id 空 = 回默认。
bool AudioBackend::SelectDevice(const std::string& endpointId, std::string& error) {
    if (endpointId.empty()) {
        hasDeviceId_ = false;  // 跟随系统默认
        return true;
    }
    // 在枚举表里找该 id（校验存在性；找不到 = bad_request 交上层）。
    ma_device_info* pb = nullptr; ma_uint32 pbc = 0;
    ma_device_info* cp = nullptr; ma_uint32 cpc = 0;
    if (ma_context_get_devices(&context_, &pb, &pbc, &cp, &cpc) != MA_SUCCESS) {
        error = "enum failed";
        return false;
    }
    const std::wstring want = Utf8ToWideLocal(endpointId);
    for (ma_uint32 i = 0; i < pbc; ++i) {
        if (wcscmp(pb[i].id.wasapi, want.c_str()) == 0) {
            lastDeviceId_ = pb[i].id;
            hasDeviceId_ = true;
            deviceFacts_.name = pb[i].name;
            return true;
        }
    }
    error = "unknown device id";
    return false;
}

// M4-a 核心：播放期按源格式重开设备（独占/换率/降级）。调用方保证安全点（设备已停、
// 解码已静默）。成功→facts_/decoder 输出率对齐；失败→降级共享（保出声优先）。
bool AudioBackend::ReopenForTrack(ma_uint32 srcRate, std::string& why) {
    const OutputMode requested = policy_.requested();
    // 完整关闭（stop+uninit）：OpenDeviceKind 会对同一 device_ 二次 init，
    // 只 stop 不 uninit 是句柄泄漏（自查修正）。调用方已保证安全点（解码静默）。
    CloseDeviceOnly();

    // §7.2 正规路径：走 OutputPolicy::Negotiate（fallback_order × BufferTooSmall 抬升重试）。
    // 失败分类现实（miniaudio init 只给泛化错误；WASAPI 设备 minPeriod 无公开查询）：
    // 独占失败按"缓冲过小"保守归类 → 抬一档重试一次（实测：period<设备下限 3ms 时
    // 独占 init 失败、≥5ms 成功——expand-smoke 抓到 buffer_ms=5 直落 shared 的缺口）；
    // 再失败才降级 shared。共享失败 = 真不可用（Unknown），整体 return false。
    OpenAttempt base;
    base.rate = srcRate;
    base.bitsContainer = 32;
    base.bitsValid = 24;
    base.integerEncoding = true;
    base.periodMs = 0;  // 由策略 buffer 推导
    const auto result = policy_.Negotiate(
        [this, srcRate](const OpenAttempt& a) -> OpenResult {
            OpenResult r;
            std::string err;
            ma_result rc = MA_SUCCESS;
            const ma_device_id* pin = hasDeviceId_ ? &lastDeviceId_ : nullptr;
            if (OpenDeviceKind(a.share == OutputMode::Exclusive,
                               a.share == OutputMode::Exclusive ? srcRate : mixRate_,
                               a.bufferMs, err, pin, &rc)) {
                r.ok = true;
                return r;
            }
            // P1-3：真错误分类（不再一律伪造 BufferTooSmall）。
            // miniaudio 独占失败映射：MA_SHARE_MODE_NOT_SUPPORTED / MA_FORMAT_NOT_SUPPORTED /
            // MA_BUSY(DEVICE_IN_USE) / MA_ACCESS_DENIED；无"设备最小 period"专码 →
            // BufferTooSmall 只在独占且 rc 属缓冲/尺寸族时用，其余如实 Unknown/Format/Busy。
            if (a.share == OutputMode::Exclusive) {
                if (rc == MA_BUSY) r.fail = FailKind::Busy;
                else if (rc == MA_SHARE_MODE_NOT_SUPPORTED || rc == MA_FORMAT_NOT_SUPPORTED ||
                         rc == MA_ACCESS_DENIED || rc < 0)
                    // miniaudio 把 WASAPI HRESULT 原样透传（S_FALSE/负 HRESULT 族）：
                    // 任何非具名失败码都归"格式/能力不支持"（保守，抬升重试不再触发）。
                    r.fail = FailKind::FormatUnsupported;
                else r.fail = FailKind::Unknown;
            } else {
                r.fail = FailKind::Unknown;
            }
            return r;
        },
        base);
    if (!result.opened) {
        why = "all open attempts failed";
        return false;
    }
    why = result.achieved == OutputMode::Exclusive ? "exclusive"
          : (requested != OutputMode::Shared ? "degraded to shared" : "shared");
    return true;
}

// M4-b：underrun 升档后的同参数重开（只换 buffer）。
bool AudioBackend::ReopenBuffer(int bufferMs) {
    const bool excl = deviceFacts_.exclusive;
    const ma_uint32 rate = excl ? deviceFacts_.appRate : mixRate_;
    StopDeviceIfStarted();
    CloseDeviceOnly();
    std::string err;
    return OpenDeviceKind(excl, rate, bufferMs, err);
}

void AudioBackend::StopDeviceIfStarted() {
    if (deviceStarted_.exchange(false, std::memory_order_acq_rel)) {
        ma_device_stop(&device_);  // 同步：返回后回调线程已退出
    }
}

void AudioBackend::CloseDevice() {
    if (!deviceOpen_.load(std::memory_order_acquire)) return;
    StopDeviceIfStarted();
    ma_device_uninit(&device_);
    ma_context_uninit(&context_);
    deviceOpen_.store(false, std::memory_order_release);
    deviceFacts_.opened = false;
    deviceFacts_.exclusive = false;
}

void AudioBackend::StaticCallback(ma_device* device, void* pOutput, const void* /*pInput*/,
                                  ma_uint32 frameCount) {
    if (auto* self = static_cast<AudioBackend*>(device->pUserData)) {
        self->Callback(pOutput, frameCount);
    }
}

// 音频回调：零分配、零锁、零 IO；只读 ring + 原子计数 + 增益乘法。
// M4 独占分支：设备格式 s32 → 直写 int32（fixed 音量 = 纯 memcpy 位完美；
// 软件增益时整型域乘 gain 再四舍五入，如实记 float-volume 因子——见 Negotiated）。
void AudioBackend::Callback(void* pOutput, ma_uint32 frameCount) {
    if (deviceFacts_.exclusive) {
        auto* outS = static_cast<ma_int32*>(pOutput);
        const std::size_t wantS = frameCount;
        std::int32_t* scratchS = popScratch_.data();
        const std::size_t gotS =
            wantS <= popScratch_.size() / 2 ? RingPop(scratchS, wantS) : 0;
        if (gotS < wantS && primed_.load(std::memory_order_relaxed) &&
            !feedPaused_.load(std::memory_order_relaxed)) {
            underrunCount_.fetch_add(1, std::memory_order_relaxed);
        }
        firedFrames_.fetch_add(wantS, std::memory_order_relaxed);
        if (gotS > 0) {
            playedFrames_.fetch_add(gotS, std::memory_order_acq_rel);
            spectrum_.PushFromCallback(scratchS, gotS, deviceFacts_.appRate);
        }
        const float gainS = softwareGain_.load(std::memory_order_relaxed);
        if (gainS >= 0.999999f) {
            std::memcpy(outS, scratchS, gotS * 2 * sizeof(std::int32_t));  // 位完美直通
        } else {
            for (std::size_t i = 0; i < gotS * 2; ++i) {
                outS[i] = static_cast<std::int32_t>(
                    static_cast<double>(scratchS[i]) * gainS);
            }
        }
        for (std::size_t i = gotS * 2; i < wantS * 2; ++i) {
            outS[i] = 0;  // 欠载/EOF 补静音
        }
        return;
    }
    auto* out = static_cast<float*>(pOutput);
    const std::size_t want = frameCount;
    std::int32_t* scratch = popScratch_.data();
    const std::size_t got = want <= popScratch_.size() / 2
                                ? RingPop(scratch, want)
                                : 0;  // 理论不可达：popScratch 按 period*2+4096 预配
    // underrun 只在「已喂过数据之后仍断流」时计（startup ramp 与停喂窗口不算，否则
    // 每次起播都假报一轮）。
    if (got < want && primed_.load(std::memory_order_relaxed) &&
        !feedPaused_.load(std::memory_order_relaxed)) {
        underrunCount_.fetch_add(1, std::memory_order_relaxed);
    }
    firedFrames_.fetch_add(want, std::memory_order_relaxed);
    if (got > 0) {
        playedFrames_.fetch_add(got, std::memory_order_acq_rel);
        // M3 频谱 tap：只读分接已弹出的帧（memcpy 进预分配滑窗；未订阅时零开销直返）。
        spectrum_.PushFromCallback(scratch, got, deviceFacts_.appRate);
    }

    const float gain = softwareGain_.load(std::memory_order_relaxed);
    for (std::size_t i = 0; i < got * 2; ++i) {
        out[i] = static_cast<float>(static_cast<double>(scratch[i]) * (1.0 / kFullScale)) * gain;
    }
    for (std::size_t i = got * 2; i < want * 2; ++i) {
        out[i] = 0.0f;  // 欠载/EOF 补静音
    }
}

void AudioBackend::SetSoftwareGain(float gain) {
    softwareGain_.store(std::clamp(gain, 0.0f, 1.0f), std::memory_order_relaxed);
}

void AudioBackend::SetVolumeMode(const std::string& mode) {
    volumeMode_ = mode;  // 控制线程独占写（与 Negotiated 同线程）
    // hardware 模式 = 端点音量路（约束 5：两路都留接口）；切离 hardware 时恢复端点 100%，
    // 避免 M6 手动启用后残留静音。ma_device_set_master_volume 只影响本进程会话音量。
    if (mode == "hardware") {
        SetEndpointVolume(1.0f);
    } else if (hardwareApplied_.exchange(false, std::memory_order_relaxed)) {
        SetEndpointVolume(1.0f);
    }
}

bool AudioBackend::SetEndpointVolume(float volume) {
    // hardware 模式挂点：ma_device_set_master_volume 是**进程会话音量**（非系统主音量，
    // 无跨进程泄漏风险）。M2 启用路径：volume.mode=hardware 时增益走端点、软件增益锁 1.0；
    // 失败时回退软件路（链因子 float-volume 如实上报）。
    if (!deviceOpen_.load(std::memory_order_acquire)) return false;
    const bool ok =
        ma_device_set_master_volume(&device_, std::clamp(volume, 0.0f, 1.0f)) == MA_SUCCESS;
    if (ok) {
        hardwareApplied_.store(true, std::memory_order_relaxed);
        hardwareVolume_ = std::clamp(volume, 0.0f, 1.0f);  // 仅控制线程（与 Negotiated 同线程）
    }
    return ok;
}

// ---------------------------------------------------------------------------
// 曲目
// ---------------------------------------------------------------------------

bool AudioBackend::OpenTrack(const std::string& utf8Path, std::string& error) {
    CloseTrack();

    // 第 1 步：probe 源原生格式（formatOut=unknown → 直通不转换）。
    const std::wstring widePath = Utf8ToWideLocal(utf8Path);
    ma_decoder probeDecoder{};
    ma_decoder_config probeConfig = ma_decoder_config_init(ma_format_unknown, 0, 0);
    if (ma_decoder_init_file_w(widePath.c_str(), &probeConfig, &probeDecoder) != MA_SUCCESS) {
        error = "cannot open/decode file";
        return false;
    }
    ma_format srcFormat = ma_format_unknown;
    ma_uint32 srcChannels = 0;
    ma_uint32 srcRate = 0;
    ma_decoder_get_data_format(&probeDecoder, &srcFormat, &srcChannels, &srcRate, nullptr, 0);
    ma_decoder_uninit(&probeDecoder);
    if (srcFormat == ma_format_unknown || srcRate == 0) {
        error = "decoded stream format unknown";
        return false;
    }

    // 第 2 步（M4）：独占能力允许时按源率重开设备（位完美路，无混音器无重采样）；
    // 失败自动降级共享（保出声优先）。CloseTrack 已制造安全点（设备停 + 解码静默）。
    std::string why;
    if (!ReopenForTrack(srcRate, why) && !deviceOpen_.load(std::memory_order_acquire)) {
        // 连共享都开不了：设备彻底不可用，按 decode_failed 上抛。
        error = "no device: " + why;
        return false;
    }

    // 主解码器 = s32 整型容器（24bit 红线）× 2ch × 设备速率（不等则记 resample 因子）。
    // 独占时 appRate == srcRate → 天然直通；共享时按混音率（重采样因子如实）。
    const ma_uint32 outChannels = 2;
    const ma_uint32 outRate = deviceFacts_.appRate != 0 ? deviceFacts_.appRate : srcRate;
    ma_decoder_config config = ma_decoder_config_init(ma_format_s32, outChannels, outRate);
    if (ma_decoder_init_file_w(widePath.c_str(), &config, &decoder_) != MA_SUCCESS) {
        error = "cannot open decoder (s32 output)";
        return false;
    }
    ma_uint64 lengthFrames = 0;
    ma_decoder_get_length_in_pcm_frames(&decoder_, &lengthFrames);

    facts_.path = utf8Path;
    facts_.lengthFrames = lengthFrames;
    facts_.sourceRate = srcRate;
    facts_.sourceChannels = srcChannels;
    // probe（format=unknown）对 FLAC/MP3 报的是 backend 默认 f32，不是源原生位深；
    // 直读容器头修正（24bit 红线取证：chain.decoder.detail 必须如实）。
    const std::string nativeFormat = ProbeSourceNativeFormat(utf8Path);
    facts_.sourceFormat = nativeFormat.empty() ? FormatName(srcFormat) : nativeFormat;
    facts_.sourceEncoding = EncodingOf(ToLower(utf8Path));
    facts_.outRate = outRate;
    facts_.outChannels = outChannels;
    facts_.outInteger = true;  // 本实现强制 s32 输出容器

    ma_pcm_rb_reset(&ring_);
    anchorFrames_.store(0, std::memory_order_relaxed);
    anchorPlayed_.store(0, std::memory_order_relaxed);
    playedFrames_.store(0, std::memory_order_relaxed);
    firedFrames_.store(0, std::memory_order_relaxed);
    eofReached_.store(false, std::memory_order_relaxed);
    feedPaused_.store(true, std::memory_order_relaxed);  // 线程先挂起，RestartStream 放行
    threadStopRequested_.store(false, std::memory_order_relaxed);
    trackOpen_.store(true, std::memory_order_release);
    decoderThread_ = std::thread([this] { DecoderLoop(); });
    return true;
}

void AudioBackend::CloseTrack() {
    StopDeviceIfStarted();
    if (trackOpen_.load(std::memory_order_acquire)) {
        if (decoderThread_.joinable()) {
            threadStopRequested_.store(true, std::memory_order_release);
            feedPaused_.store(false, std::memory_order_release);  // 防卡在 CV
            cv_.notify_all();
            decoderThread_.join();
        }
        ma_decoder_uninit(&decoder_);
        trackOpen_.store(false, std::memory_order_release);
    }
    facts_ = TrackFacts{};
    ma_pcm_rb_reset(&ring_);
    anchorFrames_.store(0, std::memory_order_relaxed);
    anchorPlayed_.store(0, std::memory_order_relaxed);
    playedFrames_.store(0, std::memory_order_relaxed);
    firedFrames_.store(0, std::memory_order_relaxed);
    eofReached_.store(false, std::memory_order_relaxed);
}

void AudioBackend::QuiesceFeed() {
    // 调用方负责保证设备已停（回调不 pop）。静默 = 解码线程停在 CV / 短睡眠点。
    feedPaused_.store(true, std::memory_order_release);
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(500);
    while (feeding_.load(std::memory_order_acquire)) {
        if (std::chrono::steady_clock::now() > deadline) break;  // 防死等（chunk 极短）
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
}

bool AudioBackend::RestartStream(std::uint64_t startFrames, std::int64_t* elapsedMsOut,
                                 std::string& error) {
    const std::int64_t t0 = SteadyMs();
    StopDeviceIfStarted();
    QuiesceFeed();
    ma_pcm_rb_reset(&ring_);
    if (startFrames > facts_.lengthFrames) startFrames = facts_.lengthFrames;
    if (ma_decoder_seek_to_pcm_frame(&decoder_, startFrames) != MA_SUCCESS) {
        // 不可 seek 的流：回 EOF 位置（= 立刻曲终自动 stopped 语义），不算命令失败。
        eofReached_.store(true, std::memory_order_relaxed);
        startFrames = facts_.lengthFrames;
    } else {
        // 审查 P0-1：seek 成功必须清 EOF 标志——否则曲终后同曲重播/toggle 永久锁死
        //（解码线程只检 eofReached_ 不响应 feedPaused_，ring 永空→秒收敛 stopped）。
        eofReached_.store(false, std::memory_order_relaxed);  // FIX-P0-1
    }
    primed_.store(false, std::memory_order_relaxed);
    anchorFrames_.store(startFrames, std::memory_order_relaxed);
    anchorPlayed_.store(playedFrames_.load(std::memory_order_relaxed), std::memory_order_relaxed);
    feedPaused_.store(false, std::memory_order_release);
    cv_.notify_all();
    if (!deviceOpen_.load(std::memory_order_acquire) ||
        ma_device_start(&device_) != MA_SUCCESS) {
        error = "ma_device_start failed";
        return false;
    }
    deviceStarted_.store(true, std::memory_order_release);
    // M6 diag.get（协议 v1.5）：重开流成功计数（采样率切换/play 重建类，任务书§2-1）。
    reopenCount_.fetch_add(1, std::memory_order_relaxed);
    if (elapsedMsOut != nullptr) *elapsedMsOut = SteadyMs() - t0;
    return true;
}

void AudioBackend::FreezeStream() {
    // 先把外推位置落到锚点（此刻 played 仍含在途弹出值），再停设备/静默/清 ring。
    const std::uint64_t frozen = PositionFrames();
    StopDeviceIfStarted();
    QuiesceFeed();
    anchorFrames_.store(frozen, std::memory_order_relaxed);
    anchorPlayed_.store(playedFrames_.load(std::memory_order_relaxed), std::memory_order_relaxed);
    ma_pcm_rb_reset(&ring_);
}

void AudioBackend::ResumeStream(std::string& error) {
    // 锚点 = 冻结位置：seek decoder 回锚点 → 恢复解码 → 起设备（不重锚 = 位置连续）。
    // ring 在 Freeze 已清，允许短重建（任务书约束 4）。
    StopDeviceIfStarted();
    QuiesceFeed();
    const std::uint64_t from = anchorFrames_.load(std::memory_order_relaxed);
    eofReached_.store(false, std::memory_order_relaxed);
    if (ma_decoder_seek_to_pcm_frame(&decoder_, from) != MA_SUCCESS) {
        error = "resume seek failed";
        // 继续起设备：ring 空 → 补静音 → EofDrained 收敛，位置不跳变。
        eofReached_.store(true, std::memory_order_relaxed);
    }
    feedPaused_.store(false, std::memory_order_release);
    cv_.notify_all();
    if (!deviceOpen_.load(std::memory_order_acquire) ||
        ma_device_start(&device_) != MA_SUCCESS) {
        error = "ma_device_start failed";
        return;
    }
    deviceStarted_.store(true, std::memory_order_release);
}

void AudioBackend::SeekFrozen(std::uint64_t frames) {
    // 调用方（engine）保证设备已停且状态机处于非 playing；解码线程可能仍在喂
    // （stopped 后 feed 继续的情况 = ring 残留）——同样先静默再动 decoder/ring。
    QuiesceFeed();
    ma_pcm_rb_reset(&ring_);
    primed_.store(false, std::memory_order_relaxed);
    if (frames > facts_.lengthFrames) frames = facts_.lengthFrames;
    if (ma_decoder_seek_to_pcm_frame(&decoder_, frames) != MA_SUCCESS) {
        eofReached_.store(true, std::memory_order_relaxed);
        frames = facts_.lengthFrames;
    } else {
        eofReached_.store(false, std::memory_order_relaxed);  // FIX-P0-1（SeekFrozen 同款）
    }
    Reanchor(frames);
}

bool AudioBackend::EofDrained() {
    return track_open() && eofReached_.load(std::memory_order_relaxed) &&
           RingReadableFrames() == 0;
}

void AudioBackend::Reanchor(std::uint64_t frames) {
    anchorFrames_.store(frames, std::memory_order_relaxed);
    anchorPlayed_.store(playedFrames_.load(std::memory_order_relaxed), std::memory_order_relaxed);
}

std::uint64_t AudioBackend::PositionFrames() {
    // playing 域：锚点 + (played - anchorPlayed)；设备停（pause/stop）后 played 不推进
    // → 公式自然冻结（与 FakeEngine 锚点语义同构）。
    const std::uint64_t played = playedFrames_.load(std::memory_order_acquire);
    const std::uint64_t anchorPlayed = anchorPlayed_.load(std::memory_order_relaxed);
    std::uint64_t pos = anchorFrames_.load(std::memory_order_relaxed);
    if (played > anchorPlayed) pos += played - anchorPlayed;
    const std::uint64_t length = facts_.lengthFrames;
    if (length != 0 && pos > length) pos = length;
    return pos;
}

// ---------------------------------------------------------------------------
// 解码线程：读 s32 chunk → push ring；被 feedPaused 静默；EOF 后置位停喂。
// ---------------------------------------------------------------------------

void AudioBackend::DecoderLoop() {
    for (;;) {
        if (threadStopRequested_.load(std::memory_order_acquire)) return;
        if (feedPaused_.load(std::memory_order_acquire)) {
            feeding_.store(false, std::memory_order_release);
            std::unique_lock<std::mutex> lock(cvMtx_);
            cv_.wait(lock, [this] {
                return !feedPaused_.load(std::memory_order_acquire) ||
                       threadStopRequested_.load(std::memory_order_acquire);
            });
            continue;
        }
        if (eofReached_.load(std::memory_order_relaxed)) {
            std::this_thread::sleep_for(std::chrono::milliseconds(10));
            continue;
        }

        const std::size_t space = static_cast<std::size_t>(kRingFrames) - RingReadableFrames();
        if (space < static_cast<std::size_t>(kChunkFrames)) {
            std::this_thread::sleep_for(std::chrono::milliseconds(2));
            continue;
        }

        feeding_.store(true, std::memory_order_release);
        ma_uint64 got = 0;
        const ma_result rc =
            ma_decoder_read_pcm_frames(&decoder_, chunkS32_.data(), kChunkFrames, &got);
        // 审查 P1-1：check-then-act 收口——read 期间若 QuiesceFeed 已置暂停（它看到
        // feeding_==false 的窗口里我们才翻 true），丢弃本 chunk 不 push：随后调用方会
        // reset ring 并 seek 重定位解码器，丢弃无害；否则旧位置样本会混入新流（错位爆音）。
        if (feedPaused_.load(std::memory_order_acquire)) {
            feeding_.store(false, std::memory_order_release);
            continue;
        }
        if (got > 0) {
            RingPush(chunkS32_.data(), static_cast<std::size_t>(got));
            primed_.store(true, std::memory_order_relaxed);
        }
        if (rc == MA_AT_END || got == 0 || got < kChunkFrames) {
            eofReached_.store(true, std::memory_order_relaxed);
        }
        feeding_.store(false, std::memory_order_release);
    }
}

// ---------------------------------------------------------------------------
// negotiated / badges（协议 §8：单一事实源；字段严格按表，不自加）
// ---------------------------------------------------------------------------

proto::Json AudioBackend::Negotiated() const {
    if (!deviceOpen_.load(std::memory_order_acquire)) return proto::Json(nullptr);

    const bool hasTrack = track_open();
    const bool resampled = hasTrack && facts_.sourceRate != deviceFacts_.appRate;
    const bool channelAdapt = hasTrack && facts_.sourceChannels != 2;
    // 音量直通判定按**实际生效路**（§13：音量 fixed/100 才直通）：
    //   hardware 且端点已应用 → 看端点音量是否 100（hardwareVolume_）；
    //   其余（float/fixed）→ 看软件增益。integer 属 M4（engine 层 not_implemented）。
    const bool hwPath = volumeMode_ == "hardware" && hardwareApplied_.load(std::memory_order_relaxed);
    const float gain = softwareGain_.load(std::memory_order_relaxed);
    // 审查 P1-4 纵深：miniaudio 的 masterVolumeFactor 在回调后还会乘一遍输出帧
    // （共享/独占都乘）——任何非 1 值都破坏直通，与 volumeMode_ 无关。
    float master = 1.0f;
    if (ma_device_get_master_volume(const_cast<ma_device*>(&device_), &master) != MA_SUCCESS) {
        master = 1.0f;  // 查询失败按默认直通（保守：不误判降级）
    }
    const bool volumePassthrough =
        (hwPath ? hardwareVolume_ >= 0.999999f : gain >= 0.999999f) && master >= 0.999999f;

    proto::Json chain = proto::Json::array();
    // 源后端是否整型（24bit 红线取证：FLAC/WAV 整型直通 s32 容器；MP3 本质 float，
    // f32→s32 转换段必须如实记 float-decode 因子，不得谎报直通）。
    const bool sourceFloat = hasTrack &&
        (facts_.sourceFormat == "f32" || facts_.sourceFormat == "f64");
    // 审查 P1-2：重采样/通道适配走 ma_data_converter，其内部以 f32 中转（mid 格式），
    // s24-in-s32 整型位在此丢低位——decoder 节点不得再报直通，且需明列 float-convert 因子。
    const bool floatConvert = resampled || channelAdapt;
    chain.push_back({{"node", "decoder"},
                     {"detail",
                      std::string(hasTrack ? facts_.sourceEncoding : "none") + " " +
                          std::string(hasTrack ? facts_.sourceFormat : "-") + "->s32"},
                     {"passthrough", hasTrack && facts_.outInteger && !sourceFloat && !floatConvert}});
    chain.push_back({{"node", "resample"}, {"passthrough", !resampled}});
    chain.push_back({{"node", "volume"}, {"mode", volumeMode_}, {"passthrough", volumePassthrough}});

    std::string fidelity = [&] {
        // §13：bit-perfect 前提是独占流 → 共享模式恒非 bit-perfect（红线如实上报）。
        // 链路直通（无重采样/无通道适配/100% 音量）= app-perfect；任一激活 = processed。
        // 源 float 解码（MP3）不降级到 processed，但明列 float-decode 因子（§13 APP-PERFECT 定义）。
        if (!resampled && !channelAdapt && volumePassthrough) return std::string("app-perfect");
        return std::string("processed");
    }();
    proto::Json factors = proto::Json::array();
    factors.push_back("shared-mixer");  // §13：共享混音属 app-perfect 的明列因子
    if (sourceFloat) factors.push_back("float-decode");  // 任务书约束 3：解码 float 化注明
    if (resampled) factors.push_back("resample");
    if (channelAdapt) factors.push_back("channel-adapt");
    if (floatConvert) factors.push_back("float-convert");  // 审查 P1-2：converter 内部 f32 中转丢位
    if (!volumePassthrough) {
        factors.push_back(hwPath ? std::string("hardware-volume") : std::string("float-volume"));
    }

    proto::Json format = {
        {"rate", deviceFacts_.appRate},
        {"bits_container", FormatBits(deviceFacts_.appFormat)},
        {"bits_valid", FormatBits(deviceFacts_.appFormat)},
        {"encoding", deviceFacts_.appFormat == ma_format_f32 ? std::string("pcm-float")
                                                             : std::string("pcm")},
        {"channels", deviceFacts_.appChannels},
    };
    const ma_uint32 rate = deviceFacts_.appRate != 0 ? deviceFacts_.appRate : 48000;
    const std::int64_t periodMs =
        static_cast<std::int64_t>(deviceFacts_.periodFrames) * 1000 / rate;
    // M4：独占事实进 share/factors/fidelity（§13 bit-perfect 的唯一前提）。
    // 独占下无 shared-mixer 因子；fidelity 判定：整型容器 ∧ 因子全空 = bit-perfect，
    // 有因子 = processed（任何处理都破坏位完美，与共享口径区分开）。
    const bool excl = deviceFacts_.exclusive;
    if (excl) {
        factors = proto::Json::array();
        if (sourceFloat) factors.push_back("float-decode");
        if (resampled) factors.push_back("resample");
        if (channelAdapt) factors.push_back("channel-adapt");
        if (!volumePassthrough) {
            factors.push_back(hwPath ? std::string("hardware-volume")
                                     : std::string("float-volume"));
        }
        if (volumeMode_ == "integer") factors.push_back("integer-volume");
        fidelity = (factors.empty() && deviceFacts_.appFormat == ma_format_s32)
                       ? "bit-perfect"
                       : (factors.empty() ? "app-perfect" : "processed");
    }
    // buffer_ms = 策略管理缓冲（§15 语义：用户请求 + 升档后的真实档；
    // 不用设备 internalPeriod×periods——独占大 period 请求下该读数被 miniaudio
    // 异常放大（实测 300ms→2612ms），且它表达的是设备节奏不是我们的缓冲策略）。
    return proto::Json{{"share", excl ? "exclusive" : "shared-event"},
                       {"backend", "wasapi"},
                       {"format", std::move(format)},
                       {"buffer_ms", policy_.bufferMs()},
                       // P2（审查）：period 未知时报 null 而非假 0（对齐 devices.list 口径）。
                       {"period_ms", periodMs == 0 ? proto::Json(nullptr) : proto::Json(periodMs)},
                       {"auto_expanded", policy_.current().autoExpanded},
                       {"chain", std::move(chain)},
                       {"fidelity", fidelity},
                       {"factors", std::move(factors)}};
}

proto::Json AudioBackend::Badges() const {
    if (!deviceOpen_.load(std::memory_order_acquire)) return proto::Json(nullptr);
    const proto::Json negotiated = Negotiated();
    std::string fidelity;
    proto::Json factors = proto::Json::array();
    if (negotiated.is_object()) {
        fidelity = negotiated.value("fidelity", std::string());
        if (negotiated.contains("factors") && negotiated["factors"].is_array()) {
            factors = negotiated["factors"];
        }
    }
    return proto::Json{{"exclusive", false},
                       {"bit_perfect", fidelity == "bit-perfect"},
                       {"app_perfect", fidelity == "app-perfect"},
                       {"factors", std::move(factors)}};
}

// ---------------------------------------------------------------------------
// M6 只读面（协议 v1.5 §5）：devices.list / diag.get 的数据侧。
// ---------------------------------------------------------------------------

std::int64_t AudioBackend::BufferMsNow() {
    if (!deviceOpen_.load(std::memory_order_acquire) || deviceFacts_.appRate == 0) return 0;
    return static_cast<std::int64_t>(RingReadableFrames()) * 1000 /
           static_cast<std::int64_t>(deviceFacts_.appRate);
}

// 共享枚举面：ma_context_get_devices 会重新枚举并持 deviceEnumLock（miniaudio 内部串行，
// 仅会话线程调用），结果缓存在 context 内。返回 null = 无可用 context（设备未开），
// 调用方按 §5 回 not_implemented（不得拿空数组假装有设备）。
// devices.list 的 exclusive 三态（见调用点注释 ①②③）。
proto::Json AudioBackend::DeviceExclusiveJson(const ma_device_info& info, ma_uint32 formatCap) {
    const bool isOpen = info.isDefault && deviceOpen_.load(std::memory_order_relaxed);
    if (isOpen && deviceFacts_.exclusive) {
        proto::Json bitsArr = proto::Json::array();
        bitsArr.push_back(static_cast<int>(FormatBits(deviceFacts_.appFormat)));
        proto::Json one = proto::Json::array();
        one.push_back({{"rate", deviceFacts_.appRate}, {"bits", std::move(bitsArr)}});
        return proto::Json{{"supported", true}, {"rates", std::move(one)}};
    }
    proto::Json agg = ExclusiveCapabilityJson(info, formatCap);
    if (agg["rates"].empty()) return proto::Json(nullptr);  // 未知态（本机常态）
    return agg;
}

// M4-a：单设备独占能力聚合（{supported, rates:[{rate,bits_container}]}，rate 升序去重）。
proto::Json AudioBackend::ExclusiveCapabilityJson(const ma_device_info& info,
                                                  ma_uint32 formatCap) {
    std::vector<std::pair<ma_uint32, ma_uint32>> excl;  // (rate, bitsContainer)
    for (ma_uint32 f = 0; f < info.nativeDataFormatCount && f < formatCap; ++f) {
        const auto& df = info.nativeDataFormats[f];
        if (df.sampleRate == 0 || (df.channels != 0 && df.channels != 2)) continue;
        const bool integer = df.format == ma_format_s16 || df.format == ma_format_s32;
        if (!integer || (df.flags & MA_DATA_FORMAT_FLAG_EXCLUSIVE_MODE) == 0) continue;
        excl.emplace_back(df.sampleRate,
                          static_cast<ma_uint32>(df.format == ma_format_s16 ? 16 : 32));
    }
    std::sort(excl.begin(), excl.end());
    proto::Json rates = proto::Json::array();
    for (const auto& [rate, bits] : excl) {
        if (!rates.empty() && rates.back()["rate"] == rate) {
            const bool has = std::any_of(
                rates.back()["bits"].begin(), rates.back()["bits"].end(),
                [&](const proto::Json& b) { return b == bits; });
            if (!has) rates.back()["bits"].push_back(bits);
            continue;
        }
        proto::Json bitsArr = proto::Json::array();
        bitsArr.push_back(bits);
        rates.push_back({{"rate", rate}, {"bits", std::move(bitsArr)}});
    }
    return proto::Json{{"supported", !excl.empty()}, {"rates", std::move(rates)}};
}

proto::Json AudioBackend::ListDevices() {
    if (!deviceOpen_.load(std::memory_order_acquire)) return proto::Json(nullptr);

    ma_device_info* playbackInfos = nullptr;
    ma_uint32 playbackCount = 0;
    ma_device_info* captureInfos = nullptr;
    ma_uint32 captureCount = 0;
    if (ma_context_get_devices(&context_, &playbackInfos, &playbackCount, &captureInfos,
                               &captureCount) != MA_SUCCESS ||
        playbackCount == 0) {
        return proto::Json(nullptr);
    }

    // 已开设备的协商周期（只对它报真实值，其余 null）。
    const std::int64_t myPeriodMs =
        deviceFacts_.appRate != 0 && deviceFacts_.periodFrames != 0
            ? std::max<std::int64_t>(
                  1, static_cast<std::int64_t>(deviceFacts_.periodFrames) * 1000 /
                         static_cast<std::int64_t>(deviceFacts_.appRate))
                  : 0;

    proto::Json devices = proto::Json::array();
    for (ma_uint32 i = 0; i < playbackCount; ++i) {
        const auto& info = playbackInfos[i];
        // nativeDataFormats 是定长内嵌数组（vendor 无公开 countof 宏，用 sizeof 自算）。
        const ma_uint32 kFormatCap = static_cast<ma_uint32>(
            sizeof(info.nativeDataFormats) / sizeof(info.nativeDataFormats[0]));
        const bool isOpened = info.isDefault && deviceOpen_.load(std::memory_order_relaxed);
        // 本实现只打开默认端点；当前产品面共享模式下唯一真用的设备即默认设备。
        // 非默认设备的 min_period_ms 不报假数据（null），混音格式同理。

        // nativeDataFormats 聚合：只取 2 声道（stereo 产品基线）的 {rate, bits}，
        // 按 rate 升序分组去重。无 2ch 条目时保留全部（虚拟设备只报单声道等异常形态）。
        std::vector<std::pair<ma_uint32, ma_uint32>> entries;  // (rate, bits)
        for (ma_uint32 f = 0; f < info.nativeDataFormatCount && f < kFormatCap; ++f) {
            const auto& df = info.nativeDataFormats[f];
            if (df.sampleRate == 0) continue;  // "所有速率"的占位条目（null 后端）= 无信息
            if (df.channels != 0 && df.channels != 2) continue;
            entries.emplace_back(df.sampleRate, static_cast<ma_uint32>(FormatBits(df.format)));
        }
        if (entries.empty()) {
            for (ma_uint32 f = 0; f < info.nativeDataFormatCount && f < kFormatCap; ++f) {
                const auto& df = info.nativeDataFormats[f];
                if (df.sampleRate == 0 || df.channels == 0) continue;
                entries.emplace_back(df.sampleRate, static_cast<ma_uint32>(FormatBits(df.format)));
            }
        }
        std::sort(entries.begin(), entries.end());
        proto::Json rates = proto::Json::array();
        ma_uint32 lastRate = 0;
        for (const auto& [rate, bits] : entries) {
            if (rates.is_array() && !rates.empty() && lastRate == rate) {
                // 同 rate 合并 bits 数组（16/24/32 容器共存）。
                rates.back()["bits"].push_back(bits);
                continue;
            }
            lastRate = rate;
            proto::Json bitsArr = proto::Json::array();
            bitsArr.push_back(bits);
            rates.push_back({{"rate", rate}, {"bits", std::move(bitsArr)}});
        }

        proto::Json mixFormat = proto::Json(nullptr);
        std::int64_t minPeriodMs = 0;
        if (isOpened) {
            // 本实现已协商的混音格式（= 打开设备时选定的 f32 混音格式事实）；
            // 其他设备的 GetMixFormat 属 M4 热切换域，不猜。
            mixFormat = proto::Json{{"rate", deviceFacts_.appRate},
                                    {"bits_container", FormatBits(deviceFacts_.appFormat)},
                                    {"bits_valid", FormatBits(deviceFacts_.appFormat)},
                                    {"encoding", deviceFacts_.appFormat == ma_format_f32
                                                     ? std::string("pcm-float")
                                                     : std::string("pcm")},
                                    {"channels", deviceFacts_.appChannels}};
            minPeriodMs = myPeriodMs;
        }
        devices.push_back({{"id", WideToUtf8Local(info.id.wasapi)},
                           {"name", std::string(info.name)},
                           {"kind", "playback"},
                           {"default", info.isDefault == MA_TRUE},
                           {"capabilities",
                            proto::Json{{"rates", std::move(rates)},
                                        {"min_period_ms", minPeriodMs == 0 ? proto::Json(nullptr)
                                                                           : proto::Json(minPeriodMs)},
                                        {"mix_format", std::move(mixFormat)},
                                        // M4-a（协议 v1.6）：exclusive 能力三态——
                                        // ① 当前已开设备：报实况（share==exclusive 即支持+当前档）；
                                        // ② 枚举表有 EXCLUSIVE 条目：报探测表；
                                        // ③ 其余 = null（未知，miniaudio 枚举表本机为空，
                                        //    真判定在 output.mode 试开；不假称支持/不支持）。
                                        {"exclusive", DeviceExclusiveJson(info, kFormatCap)}}}});
    }
    return devices;
}


}  // namespace rhine
