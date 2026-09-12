// audio.h — miniaudio 封装：ma_device（WASAPI 共享模式）+ ma_decoder（FLAC/MP3/WAV）
// + SPSC ring（s32 容器）+ 独立解码线程。
//
// 设备时钟口径（任务书约束 2 / AUDIO-ENGINE §9）：本版本 miniaudio 无公开设备 cursor API，
// 采用「回调消耗节奏 = 设备消耗节奏」等价口径：position = 锚点 + 已从 ring 弹出的真实帧数
// （playedFrames 记账）；play/pause/seek 重锚，钳 [0,length]，不倒退不漂移（对照表见
// M2-FINDINGS）。
//
// 线程模型（任务书约束 1）：
//   · 音频回调线程（miniaudio 拥有，共享模式事件驱动）：只从 ring pop → 写输出 → 计数，
//     零分配零锁零 IO；
//   · 解码线程（每 track 一个）：decoder 读 s32 → push ring；feedPaused/stop 由 CV 静默；
//   · 控制线程（IPC）：动 ring/decoder 前先制造安全点（ma_device_stop 同步返回 = 回调已退出
//     + QuiesceFeed 静默解码线程），再复位/seek/重锚。
#pragma once

#include <atomic>
#include <condition_variable>
#include <cstdint>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "miniaudio.h"
#include "protocol.h"
#include "ring.h"

namespace rhine {

// 打开 track 后测得的解码事实（协议 §8 chain/format/factors 的来源）。
struct TrackFacts {
    std::string path;                // UTF-8 绝对路径（track_id 的 file: 载荷）
    std::uint64_t lengthFrames = 0;  // 输出域（设备速率/2ch）总帧数
    std::uint32_t sourceRate = 0;
    std::uint32_t sourceChannels = 0;
    std::string sourceEncoding;      // flac / mp3 / wav / ...
    std::string sourceFormat;        // 源原生格式名：s16/s24/s32/f32（probe 所得）
    std::uint32_t outRate = 0;
    std::uint32_t outChannels = 0;
    bool outInteger = false;         // 解码输出容器是否整型（24bit 红线：本实现强制 s32）
};

// 共享模式设备事实（negotiated 的静态部分）。
struct DeviceFacts {
    bool opened = false;
    ma_format appFormat = ma_format_f32;  // 设备输出格式（本实现固定 f32）
    std::uint32_t appRate = 0;
    std::uint32_t appChannels = 0;
    std::uint32_t periodFrames = 0;
    std::uint32_t periods = 0;
    std::string name;                     // 设备友好名（日志/诊断，非协议字段）
};

class AudioBackend {
public:
    AudioBackend();
    ~AudioBackend();
    AudioBackend(const AudioBackend&) = delete;
    AudioBackend& operator=(const AudioBackend&) = delete;

    // ---- 设备（默认播放端点，共享模式）----
    bool OpenDevice(std::string& error);
    void CloseDevice();
    bool device_open() const { return deviceOpen_.load(std::memory_order_acquire); }
    const DeviceFacts& device_facts() const { return deviceFacts_; }

    // ---- 曲目 ----
    bool OpenTrack(const std::string& utf8Path, std::string& error);
    void CloseTrack();
    bool track_open() const { return trackOpen_.load(std::memory_order_acquire); }
    const TrackFacts& track_facts() const { return facts_; }
    std::uint64_t length_frames() const { return facts_.lengthFrames; }
    std::uint32_t rate() const { return deviceFacts_.appRate; }

    // 从 startFrames 起重建流（play/seek 共用）：停设备 → 静默解码 → 清 ring →
    // decoder seek → 重锚 → 恢复解码 → 起设备。耗时写 *elapsedMsOut（约束 4 记 trace）。
    bool RestartStream(std::uint64_t startFrames, std::int64_t* elapsedMsOut, std::string& error);
    // 冻结（pause/stop 共用）：落地锚点 → 停设备 → 静默解码 → 清 ring。
    void FreezeStream();
    // 冻结态 seek（paused/stopped 用）：设备必须已停 → 清 ring → decoder seek → 重锚；
    // 不起设备不放喂（resume 时统一重建）。
    void SeekFrozen(std::uint64_t frames);
    // 续播：decoder seek 到锚点 → 恢复解码 → 起设备（不重锚 = 位置连续）。
    void ResumeStream(std::string& error);
    // 曲终检测（解码线程 EOF 且 ring 排空）：状态机 1Hz tick 用。
    bool EofDrained() const;

    // ---- 时钟（帧域 = 设备应用速率）----
    std::uint64_t PositionFrames();  // 锚点 + max(0, played - anchorPlayed)，钳 [0,length]
    void Reanchor(std::uint64_t frames);
    std::size_t ring_backlog_frames() const { return ring_.readable(); }

    // ---- 音量（约束 5：float 软件增益 + 端点音量两路都留接口）----
    void SetSoftwareGain(float gain);
    float SoftwareGain() const { return softwareGain_.load(std::memory_order_relaxed); }
    bool SetEndpointVolume(float volume);  // hardware 模式挂点（M2 不启用）
    // volume 模式的展示事实（chain.volume.mode；控制线程写，Negotiated 同线程读）。
    void SetVolumeMode(const std::string& mode);

    // ---- 协议 §8 negotiated / §6 badges ----
    proto::Json Negotiated() const;
    proto::Json Badges() const;

    std::uint64_t underruns() const { return underrunCount_.load(std::memory_order_relaxed); }

private:
    void Callback(void* pOutput, ma_uint32 frameCount);
    static void StaticCallback(ma_device* device, void* pOutput, const void* pInput,
                               ma_uint32 frameCount);
    void DecoderLoop();
    void QuiesceFeed();
    void StopDeviceIfStarted();

    std::int64_t RestartMs(std::uint64_t startFrames, std::string& error) {
        std::int64_t elapsedMs = 0;
        RestartStream(startFrames, &elapsedMs, error);
        return elapsedMs;
    }

    ma_device device_{};
    ma_context context_{};
    std::atomic<bool> deviceOpen_{false};
    std::atomic<bool> deviceStarted_{false};
    DeviceFacts deviceFacts_;

    ma_decoder decoder_{};
    std::atomic<bool> trackOpen_{false};
    TrackFacts facts_;

    SpscRing ring_{1u << 16};  // 65536 帧（≈683ms@96k / 1.36s@48k ≥ 2×buffer_ms 纪律）

    std::thread decoderThread_;
    std::mutex cvMtx_;
    std::condition_variable cv_;
    std::atomic<bool> threadStopRequested_{false};
    std::atomic<bool> feedPaused_{false};
    std::atomic<bool> feeding_{false};
    std::atomic<bool> eofReached_{false};
    std::atomic<bool> primed_{false};  // 首帧已入 ring（underrun 只在其后计数，startup ramp 不算）

    // 设备时钟账本。
    std::atomic<std::uint64_t> playedFrames_{0};  // 从 ring 真实弹出的 track 帧
    std::atomic<std::uint64_t> firedFrames_{0};   // 回调总输出帧（欠载诊断用）
    // 锚点（anchorPlayed_ 与 playedFrames_ 原子配对读；anchorFrames_ 仅安全点写入）。
    std::atomic<std::uint64_t> anchorFrames_{0};
    std::atomic<std::uint64_t> anchorPlayed_{0};
    std::atomic<std::uint64_t> underrunCount_{0};

    std::atomic<float> softwareGain_{1.0f};
    std::string volumeMode_{"float"};  // 仅控制线程读写（engine 会话线程）
    std::atomic<bool> hardwareApplied_{false};  // 端点音量路是否真实生效（SetEndpointVolume 成功）
    float hardwareVolume_{1.0f};                // 端点路最近一次应用值（仅控制线程）

    // 回调专用暂存（预分配，满足「回调零分配」）。
    std::vector<std::int32_t> popScratch_;

    std::vector<ma_int32> chunkS32_;  // 解码线程暂存（OpenTrack 分配，线程内复用）
    static constexpr ma_uint64 kChunkFrames = 1024;
};

}  // namespace rhine
