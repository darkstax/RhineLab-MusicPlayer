// engine.cpp — FakeEngine 语义直译（对照表：docs/M2-FINDINGS.md §1）。
#include "engine.h"

#include <algorithm>

namespace rhine {
namespace {

constexpr std::int64_t kDefaultDurationMs = 180000;  // §5 engine.play 缺省（仅校验用）

}  // namespace

Engine::Engine(AudioBackend& audio) : audio_(audio) {}

const char* Engine::StateToWire(State state) {
    switch (state) {
        case State::Playing: return "playing";
        case State::Paused: return "paused";
        case State::Stopped: return "stopped";
        default: return "idle";
    }
}

std::int64_t Engine::FramesToMs(std::uint64_t frames, std::uint32_t rate) {
    if (rate == 0) return 0;
    return static_cast<std::int64_t>(frames * 1000 / rate);
}

std::uint64_t Engine::MsToFrames(std::int64_t ms, std::uint32_t rate) {
    if (rate == 0) return 0;
    return static_cast<std::uint64_t>(ms) * rate / 1000;
}

std::int64_t Engine::PositionMs() const {
    // playing = 设备时钟派生；其余状态 = 冻结点（桩同款：非 playing 即锚点值）。
    if (state_ == State::Playing && audio_.track_open()) {
        return FramesToMs(audio_.PositionFrames(), audio_.rate());
    }
    return lastPositionMs_;
}

proto::Json Engine::PositionPayload() const {
    const std::int64_t position = PositionMs();
    const std::uint32_t rate = audio_.rate() != 0 ? audio_.rate() : 48000;
    // 真实缓冲水位 = ring 可读帧（M2 真语义增量；桩的 30000 合成值不再使用）。
    const std::int64_t bufferedMs =
        FramesToMs(static_cast<std::uint64_t>(audio_.ring_backlog_frames()), rate);
    return proto::Json{{"position_ms", position},
                       {"frames", static_cast<std::int64_t>(position) * rate / 1000},
                       {"rate", static_cast<std::int64_t>(rate)},
                       {"buffered_ms", bufferedMs},
                       {"drift_ms", 0}};
}

proto::Json Engine::StatePayload() const {
    proto::Json payload = Snapshot();
    return payload;
}

proto::Json Engine::Snapshot() const {
    proto::Json snapshot{
        {"state", StateToWire(state_)},
        {"track_id", trackId_.empty() ? proto::Json(nullptr) : proto::Json(trackId_)},
        {"position_ms", PositionMs()},
        {"duration_ms", durationMs_},
        {"volume", volume_},
        // M2：引擎已接入 → negotiated/badges 为协商事实（桩的 null 豁免不再适用）。
        {"negotiated", audio_.Negotiated()},
        {"badges", audio_.Badges()},
    };
    return snapshot;
}

void Engine::AppendStatePosition(CommandOutcome& outcome) {
    // 事件序 [state, position]（桩 Play/Pause/Resume/Stop/Toggle 同款）。
    outcome.events.emplace_back("state", StatePayload());
    outcome.events.emplace_back("position", PositionPayload());
}

void Engine::StopAudio() {
    // 设备已停的幂等收敛（FreezeStream 内部再停一次无害）。
    if (audio_.track_open()) audio_.FreezeStream();
}

CommandOutcome Engine::Play(const std::string& trackId, std::optional<double> durationMs,
                            std::optional<double> positionMs) {
    // §5 + 任务书约束 7：track_id 必须是 file:<绝对路径>；其余 scheme 一律 bad_request。
    if (trackId.empty()) {
        throw BadRequest{"engine.play requires a non-empty track_id"};
    }
    if (trackId.compare(0, 5, "file:") != 0) {
        throw BadRequest{"unknown track_id scheme (M2 core accepts only \"file:<absolute path>\")"};
    }
    const std::string path = trackId.substr(5);
    if (path.empty()) {
        throw BadRequest{"engine.play track_id file: requires a non-empty path"};
    }
    // 显式参数校验与桩一致（越界拒绝），但 M2 的时长来自解码事实，不接受前端合成值。
    if (durationMs.has_value() && *durationMs < 1) {
        throw BadRequest{"duration_ms must be >= 1"};
    }
    if (positionMs.has_value() && *positionMs < 0) {
        throw BadRequest{"position_ms must be >= 0"};
    }

    const bool sameTrack = trackId == trackId_ && audio_.track_open();
    if (!sameTrack) {
        std::string error;
        if (!audio_.OpenTrack(path, error)) {
            // §7 decode_failed（附 track_id）；状态机回到 idle（无曲可播）。
            state_ = State::Idle;
            trackId_.clear();
            durationMs_ = 0;
            lastPositionMs_ = 0;
            proto::Json extra{{"track_id", trackId}};
            throw DecodeFailure{error, extra};
        }
        trackId_ = trackId;
        durationMs_ = FramesToMs(audio_.length_frames(), audio_.rate());
    }
    if (durationMs_ == 0) {
        // 长度不可得（无 seek 表的 VBR 等）：如实保留 0，播完由 EOF 排空收敛。
    }

    std::int64_t start = positionMs.has_value() ? static_cast<std::int64_t>(*positionMs) : 0;
    if (start > durationMs_ && durationMs_ != 0) start = durationMs_ == 0 ? 0 : durationMs_;  // 钳到曲长
    std::string error;
    std::int64_t elapsedMs = 0;
    if (!audio_.RestartStream(MsToFrames(start, audio_.rate()), &elapsedMs, error)) {
        throw DecodeFailure{error, proto::Json{}};
    }
    lastPositionMs_ = start;
    state_ = State::Playing;

    CommandOutcome outcome;
    outcome.result = proto::Json{{"stream_token", NextStreamToken()}};
    AppendStatePosition(outcome);
    return outcome;
}

void Engine::OpenCurrentTrackAndStart(std::int64_t startMs, CommandOutcome& outcome) {
    // toggle 的 idle/stopped 有曲重播路径（桩：Play(track, DurationMs) = 从头 + 保时长）。
    if (trackId_.empty()) {
        outcome.events.emplace_back("state", StatePayload());
        outcome.events.emplace_back("position", PositionPayload());
        return;
    }
    if (!audio_.track_open()) {
        std::string error;
        if (!audio_.OpenTrack(trackId_.substr(5), error)) {
            throw DecodeFailure{error, proto::Json{{"track_id", trackId_}}};
        }
    }
    std::string error;
    std::int64_t elapsedMs = 0;
    if (!audio_.RestartStream(MsToFrames(startMs, audio_.rate()), &elapsedMs, error)) {
        throw DecodeFailure{error, proto::Json{}};
    }
    lastPositionMs_ = startMs;
    state_ = State::Playing;
    AppendStatePosition(outcome);
}

CommandOutcome Engine::Pause() {
    CommandOutcome outcome;
    if (state_ == State::Playing) {
        // 桩：冻结 = 把外推位置落成锚点。顺序：先读位置，再 Freeze/落 lastPosition。
        lastPositionMs_ = PositionMs();
        StopAudio();
        state_ = State::Paused;
    }
    outcome.result = proto::Json{{"state", StateToWire(state_)}};
    AppendStatePosition(outcome);
    return outcome;
}

CommandOutcome Engine::Resume() {
    CommandOutcome outcome;
    if (state_ == State::Paused) {
        std::string error;
        audio_.ResumeStream(error);  // 失败也继续：ring 空 → 补静音 → 位置不跳变（错误进日志）
        state_ = State::Playing;
    } else if (state_ == State::Stopped && !trackId_.empty()) {
        // 桩同款：resume 仅 paused 生效 → 幂等回当前 state（stopped 不自动重播；
        // 从头重播是 toggle 的语义）。
    }
    outcome.result = proto::Json{{"state", StateToWire(state_)}};
    AppendStatePosition(outcome);
    return outcome;
}

CommandOutcome Engine::Stop() {
    // 桩语义（musicfox Player.Stop）：停止并回起点；track_id 保留展示；任何状态可 stop。
    CommandOutcome outcome;
    lastPositionMs_ = 0;
    if (audio_.track_open()) {
        StopAudio();
        audio_.Reanchor(0);
    }
    state_ = State::Stopped;
    outcome.result = proto::Json{{"state", StateToWire(state_)}};
    AppendStatePosition(outcome);
    return outcome;
}

CommandOutcome Engine::Toggle() {
    // 桩：playing↔paused；idle/stopped 且有曲 = 从头重播**保时长**（审查 P1-1 语义）。
    if (state_ == State::Playing) return Pause();
    if (state_ == State::Paused) return Resume();
    CommandOutcome outcome;
    if (!trackId_.empty()) {
        OpenCurrentTrackAndStart(0, outcome);
    } else {
        outcome.events.emplace_back("state", StatePayload());
        outcome.events.emplace_back("position", PositionPayload());
    }
    outcome.result = proto::Json{{"state", StateToWire(state_)}};
    return outcome;
}

CommandOutcome Engine::SetOutputMode(const std::string& mode, std::optional<double> bufferMs,
                                     std::optional<bool> autoExpand,
                                     std::optional<double> bufferMaxMs) {
    // §5 v1.6：mode ∈ shared/exclusive/auto；参数越界钳制（同 seek 口径），非法字符串 bad_request。
    OutputMode parsed;
    if (mode == "shared") parsed = OutputMode::Shared;
    else if (mode == "exclusive") parsed = OutputMode::Exclusive;
    else if (mode == "auto") parsed = OutputMode::Auto;
    else throw BadRequest{"output.mode requires shared/exclusive/auto, got '" + mode + "'"};

    OutputPolicyConfig config = audio_.policy().config();
    config.mode = parsed;
    if (bufferMs.has_value()) {
        long long v = static_cast<long long>(*bufferMs);
        config.requestedBufferMs = static_cast<int>(v < 1 ? 1 : (v > 30000 ? 30000 : v));
    }
    if (autoExpand.has_value()) config.autoExpandBuffer = *autoExpand;
    if (bufferMaxMs.has_value()) {
        long long v = static_cast<long long>(*bufferMaxMs);
        config.bufferMaxMs = static_cast<int>(v < 5 ? 5 : (v > 30000 ? 30000 : v));
    }
    audio_.ConfigureOutput(config);

    CommandOutcome outcome;
    // 有活动曲目 → 按新策略**完整重建**播放链：CloseTrack（停设备 + join 解码线程）→
    // OpenTrack（内部 ReopenForTrack 按新 share 开设备，且 decoder 以**新** appRate 重建——
    // 只重开设备不换 decoder 会让解码输出率与设备脱节，音高/位置全错位，自查修正）→
    // 从冻结位置续播/续停。失败路径对齐 Play 的清理（idle + 清账本）。
    if (!trackId_.empty() && state_ != State::Idle) {
        const bool wasPlaying = state_ == State::Playing;
        const std::int64_t frozenMs = PositionMs();
        const std::string path = trackId_.substr(5);
        const std::string keepTrack = trackId_;
        audio_.CloseTrack();
        std::string error;
        if (!audio_.OpenTrack(path, error)) {
            state_ = State::Idle;
            trackId_.clear();
            durationMs_ = 0;
            lastPositionMs_ = 0;
            throw DecodeFailure{error, proto::Json{{"track_id", keepTrack}}};
        }
        durationMs_ = FramesToMs(audio_.length_frames(), audio_.rate());
        if (wasPlaying) {
            std::int64_t elapsedMs = 0;
            if (!audio_.RestartStream(MsToFrames(frozenMs, audio_.rate()), &elapsedMs, error)) {
                state_ = State::Idle;
                trackId_.clear();
                durationMs_ = 0;
                lastPositionMs_ = 0;
                throw DecodeFailure{error, proto::Json{{"track_id", keepTrack}}};
            }
            state_ = State::Playing;
        } else {
            audio_.SeekFrozen(MsToFrames(frozenMs, audio_.rate()));
            state_ = State::Paused;
        }
        lastPositionMs_ = frozenMs;
    }
    // §5 result = {negotiated}（协议 v1.6 表字面嵌套形状，与桩一致）；补发 state 帧
    // （share 变了徽章要刷）。
    outcome.result = proto::Json{{"negotiated", audio_.Negotiated()}};
    AppendStatePosition(outcome);
    return outcome;
}

CommandOutcome Engine::Seek(std::int64_t positionMs) {
    if (trackId_.empty() && !audio_.track_open()) {
        throw BadRequest{"engine.seek requires a loaded track"};
    }
    std::int64_t applied = positionMs;
    if (applied < 0) applied = 0;
    if (durationMs_ != 0 && applied > durationMs_) applied = durationMs_;
    const std::uint64_t frames = MsToFrames(applied, audio_.rate());

    std::string error;
    if (state_ == State::Playing) {
        std::int64_t elapsedMs = 0;
        if (!audio_.RestartStream(frames, &elapsedMs, error)) {
            throw DecodeFailure{error, proto::Json{}};
        }
    } else {
        // 非 playing（paused/stopped/idle）：设备已停 → 只动 decoder+锚点，不起设备。
        audio_.SeekFrozen(frames);
    }
    lastPositionMs_ = applied;
    // 桩 Seek 的事件序 = [position, state]（与变更类的 [state, position] 不同，保持一致）。
    CommandOutcome outcome;
    outcome.result = proto::Json{{"applied_ms", applied}};
    outcome.events.emplace_back("position", PositionPayload());
    outcome.events.emplace_back("state", StatePayload());
    return outcome;
}

CommandOutcome Engine::SetVolume(const std::string& mode, std::optional<double> value) {
    // 桩：mode ∈ fixed/hardware/integer/float，否则 bad_request；fixed 锁 1.0；其余钳 [0,1]。
    // M2 裁定（M2-FINDINGS §2.5）：float/hardware/fixed 真实生效（软件增益路径）；
    // integer（定点位完美衰减）属 M4 域 → not_implemented。
    if (mode != "fixed" && mode != "hardware" && mode != "integer" && mode != "float") {
        throw BadRequest{
            "unknown volume mode '" + mode + "' (expected fixed/hardware/integer/float)"};
    }
    if (mode == "integer") {
        throw NotImplemented{"volume mode 'integer' (fixed-point bit-perfect gain) is M4 scope"};
    }
    double target = value.has_value() ? *value : volume_;
    if (target < 0.0) target = 0.0;
    if (target > 1.0) target = 1.0;
    volumeMode_ = mode;
    volume_ = mode == "fixed" ? 1.0 : target;
    // 两路增益（约束 5 接口均在位）：fixed = 全 100% 直通；float = 软件增益；
    // hardware = 端点会话音量（软件路锁 1.0，避免双重衰减；失败则退回软件路）。
    if (mode == "hardware") {
        audio_.SetVolumeMode(mode);
        audio_.SetSoftwareGain(1.0f);
        if (!audio_.SetEndpointVolume(static_cast<float>(volume_))) {
            audio_.SetSoftwareGain(static_cast<float>(volume_));  // 回退：端点不可用
        }
    } else {
        const float gain = mode == "fixed" ? 1.0f : static_cast<float>(volume_);
        audio_.SetSoftwareGain(gain);
        audio_.SetVolumeMode(mode);  // 内部恢复端点 100%（若之前是 hardware 路）
    }
    // 桩 SetVolume 的事件序 = [position, state]。
    CommandOutcome outcome;
    outcome.result = proto::Json{
        {"effective", proto::Json{{"mode", volumeMode_}, {"value", volume_}}}};
    outcome.events.emplace_back("position", PositionPayload());
    outcome.events.emplace_back("state", StatePayload());
    return outcome;
}

std::vector<std::pair<std::string, proto::Json>> Engine::Tick() {
    // 桩：任意状态发一帧 position；playing 且播完 → 收敛 stopped（[position, state] 序）。
    bool finished = false;
    if (state_ == State::Playing) {
        const std::int64_t position = PositionMs();
        const bool endByClock = durationMs_ != 0 && position >= durationMs_;
        const bool endByEof = audio_.EofDrained();
        if (endByClock || endByEof) {
            finished = true;
            if (endByEof && durationMs_ == 0) {
                // 长度未知的流：EOF 时把解码到的实际位置补成 duration（UI 终态一致）。
                durationMs_ = PositionMs();
            }
            lastPositionMs_ = durationMs_;
            StopAudio();
            state_ = State::Stopped;
        }
    }
    std::vector<std::pair<std::string, proto::Json>> events;
    events.emplace_back("position", PositionPayload());
    if (finished) events.emplace_back("state", StatePayload());
    return events;
}

std::string Engine::NextStreamToken() {
    return "core-" + std::to_string(++streamTokens_);
}

}  // namespace rhine
