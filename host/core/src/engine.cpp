// engine.cpp — FakeEngine 语义直译（对照表：docs/M2-FINDINGS.md §1）。
#include "engine.h"

#include <algorithm>
#include <chrono>

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
        std::string error;
        if (!RebuildChain(frozenMs, wasPlaying, error)) {
            throw DecodeFailure{error, proto::Json{{"track_id", trackId_}}};
        }
    }
    // §5 result = {negotiated}（协议 v1.6 表字面嵌套形状，与桩一致）；补发 state 帧
    // （share 变了徽章要刷）。
    outcome.result = proto::Json{{"negotiated", audio_.Negotiated()}};
    AppendStatePosition(outcome);
    return outcome;
}

bool Engine::RebuildChain(std::int64_t frozenMs, bool wasPlaying, std::string& error) {
    // CloseTrack（停设备 + join 解码线程）→ OpenTrack（ReopenForTrack 按策略开设备 +
    // decoder 以新 appRate 重建）→ 从冻结位置续播/续停。失败 = 设备彻底不可用，
    // 状态机清账（对齐 Play 失败路径）。
    const std::string keepTrack = trackId_;
    const std::string path = keepTrack.compare(0, 5, "file:") == 0 ? keepTrack.substr(5) : "";
    audio_.CloseTrack();
    if (path.empty() || !audio_.OpenTrack(path, error)) {
        state_ = State::Idle;
        trackId_.clear();
        durationMs_ = 0;
        lastPositionMs_ = 0;
        return false;
    }
    durationMs_ = FramesToMs(audio_.length_frames(), audio_.rate());
    if (wasPlaying) {
        std::int64_t elapsedMs = 0;
        if (!audio_.RestartStream(MsToFrames(frozenMs, audio_.rate()), &elapsedMs, error)) {
            state_ = State::Idle;
            trackId_.clear();
            durationMs_ = 0;
            lastPositionMs_ = 0;
            return false;
        }
        state_ = State::Playing;
    } else {
        audio_.SeekFrozen(MsToFrames(frozenMs, audio_.rate()));
        state_ = State::Paused;
    }
    lastPositionMs_ = frozenMs;
    return true;
}

std::vector<std::pair<std::string, proto::Json>> Engine::MaybeExpandBuffer() {
    // M4-b（Q1-c）：underrun 增量喂 OutputPolicy 滑窗；触发升档 → 完整重建链续播。
    std::vector<std::pair<std::string, proto::Json>> extra;
    if (trackId_.empty() || state_ != State::Playing) {
        lastUnderrunSeen_ = audio_.underruns();
        return extra;
    }
    const std::uint64_t now = audio_.underruns();
    int hits = 0;
    if (now > lastUnderrunSeen_) {
        hits = static_cast<int>(std::min<std::uint64_t>(now - lastUnderrunSeen_, 16));
        lastUnderrunSeen_ = now;
    }
    if (hits == 0) return extra;
    const auto nowMs = std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::steady_clock::now().time_since_epoch()).count();
    int target = 0;
    for (int i = 0; i < hits; ++i) {
        const int r = audio_.policy().OnUnderrun(nowMs);
        if (r > target) target = r;
    }
    if (target == 0) return extra;  // 滑窗未触发升档
    const std::int64_t frozenMs = PositionMs();
    std::string error;
    if (RebuildChain(frozenMs, true, error)) {
        // 升档成功：徽章/缓冲事实刷新（negotiated 变了）。
        extra.emplace_back("state", StatePayload());
        extra.emplace_back("position", PositionPayload());
    } else {
        // 重建失败（设备没了）：RebuildChain 已清账到 idle，发 state 让 UI 收敛。
        extra.emplace_back("state", StatePayload());
    }
    return extra;
}

std::vector<std::pair<std::string, proto::Json>> Engine::MaybeRecoverExclusive() {
    // M4-b（§7.2）：降级态的独占恢复——只在非 playing（暂停/曲终/停止）时机，
    // 走 RebuildChain 的"试开即探测"（内部 ReopenForTrack 先试独占）；
    // 绝不在播放中打断当前曲（keep 语义：我占着不让，但不抢别人正在播的）。
    std::vector<std::pair<std::string, proto::Json>> extra;
    if (trackId_.empty() || state_ == State::Playing || !audio_.track_open()) return extra;
    const auto nowMs = std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::steady_clock::now().time_since_epoch()).count();
    if (!audio_.policy().ProbeDue(nowMs)) return extra;
    // R4（交互④后半句"插回 → 切回"）：钉选设备插回时先恢复钉选（拔出时只临时解钉，
    // 用户意图保留着），再走下面的重建（会按钉选设备重开）。
    const bool repinned = audio_.RestorePinnedIfAvailable();
    const bool wasExclusive = audio_.exclusive();
    const std::int64_t frozenMs = PositionMs();
    std::string error;
    const bool ok = RebuildChain(frozenMs, false, error);
    const bool nowExclusive = ok && audio_.exclusive();
    audio_.policy().OnProbeResult(nowExclusive, nowMs);
    if (nowExclusive && !wasExclusive) {
        // 升回成功：state 刷新（share/badges 变了）。
        extra.emplace_back("state", StatePayload());
        extra.emplace_back("position", PositionPayload());
    } else if (repinned) {
        // 钉选设备已插回并切回：即使 share 没变也要刷 state（设备名变了）。
        extra.emplace_back("state", StatePayload());
    }
    return extra;
}

CommandOutcome Engine::SelectDevice(const std::string& id) {
    // §5 devices.select：id 空串 = 回"跟随系统默认"；非空 = 钉选（校验存在性）。
    std::string error;
    if (!audio_.SelectDevice(id, error)) {
        throw BadRequest{"devices.select: " + error};
    }
    CommandOutcome outcome;
    // 有曲目 → 完整重建链到新设备（RebuildChain 内 OpenTrack→ReopenForTrack 走新 pin）。
    if (!trackId_.empty() && state_ != State::Idle) {
        const bool wasPlaying = state_ == State::Playing;
        const std::int64_t frozenMs = PositionMs();
        if (!RebuildChain(frozenMs, wasPlaying, error)) {
            throw DecodeFailure{error, proto::Json{{"track_id", trackId_}}};
        }
        lastPositionMs_ = frozenMs;
    }
    outcome.result = proto::Json{{"negotiated", audio_.Negotiated()}};
    AppendStatePosition(outcome);
    return outcome;
}

std::vector<std::pair<std::string, proto::Json>> Engine::MaybeHandleDeviceEvent() {
    // M4-c：设备事件消费（通知线程置旗 + 会话线程轮询兜底——钉选设备拔出时
    // Windows 不一定发默认设备变更通知，但 ma_device 会 stop：playing 却非 started 即失效）。
    const bool flagged = audio_.TakeDeviceEventPending();
    const bool lostWhilePlaying =
        state_ == State::Playing && !trackId_.empty() && !audio_.device_running();
    std::vector<std::pair<std::string, proto::Json>> extra;
    if (!flagged && !lostWhilePlaying) return extra;
    if (trackId_.empty() || state_ != State::Playing) return extra;  // 非播放：忽略（下次 play 自然对齐）
    if (audio_.device_running()) {
        // 共享模式 miniaudio 已自动重路由（rerouted 通知）：位置账本不变，刷新 state
        // （negotiated 里设备名/格式可能已变）。
        extra.emplace_back("state", StatePayload());
        return extra;
    }
    // 设备失效/拔出且 playing：自动重开尝试（跟随默认则切到新默认；钉选设备没了则失败）；
    // 重开不成 → 收敛 paused + evt.error{device_gone}（§7，交 UI 提示）。
    // R3-P1-1（cb 复核）：必须取**实时**位置。lastPositionMs_ 按设计只在非 playing
    // 状态有效（playing 期它是起播锚点，Tick 不刷新）——用它会让"播到 2:30 拔 DAC"
    // 重开后回跳到 0:00。与 SelectDevice/MaybeExpandBuffer 统一用 PositionMs()。
    const std::int64_t frozenMs = PositionMs();
    std::string error;
    if (RebuildChain(frozenMs, true, error)) {
        extra.emplace_back("state", StatePayload());
        extra.emplace_back("position", PositionPayload());
        return extra;
    }
    // R4（交互④实测，拔 DAC 复现）：失败路径必须把冻结位置写回 lastPositionMs_，
    // 否则 PositionMs() 在 Paused 下返回**旧值**（起播锚点/0）→ 用户拔设备后看到
    // 进度归零、续播从头开始（RebuildChain 成功路径有写回，这里漏了）。
    state_ = State::Paused;  // 设备没了，无法续播：冻结在末位置
    lastPositionMs_ = frozenMs;
    extra.emplace_back("state", StatePayload());
    extra.emplace_back("error", proto::Json{{"code", "device_gone"},
                                            {"message", error.empty() ? "device unavailable" : error},
                                            {"retryable", true}});
    return extra;
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
    // P1-4/P1-1（审查）：独占下 miniaudio 的 master volume 实为应用侧软件增益，
    // 记 hardware-volume 会谎报直通路径。**回落 float 而非 fixed**：
    //   - 回落 fixed(1.0) 会让独占下音量条静默失效（拖了没反应，UI 却显示新值）；
    //   - 回落 float 保留软件增益（音量条可用）， fidelity/factors 如实降级为
    //     float-volume（非位完美），语义诚实且功能不丢。
    // 位完美 = 独占 ∧ 音量 100% ∧ 无其它因子（音量非 1 时本就不是位完美）。
    std::string effectiveMode = mode;
    if (effectiveMode == "hardware" && audio_.exclusive()) {
        effectiveMode = (target >= 0.999999) ? "fixed" : "float";
    }
    volumeMode_ = effectiveMode;
    volume_ = effectiveMode == "fixed" ? 1.0 : target;
    // 两路增益（约束 5 接口均在位）：fixed = 全 100% 直通；float = 软件增益；
    // hardware = 端点会话音量（软件路锁 1.0，避免双重衰减；失败则退回软件路）。
    if (effectiveMode == "hardware") {
        audio_.SetVolumeMode(effectiveMode);
        audio_.SetSoftwareGain(1.0f);
        if (!audio_.SetEndpointVolume(static_cast<float>(volume_))) {
            audio_.SetSoftwareGain(static_cast<float>(volume_));  // 回退：端点不可用
        }
    } else {
        // P2-4：统一传 effectiveMode（原传原始 mode 会让 audio_.volumeMode_ 留在
        // "hardware" → negotiated.chain.volume.mode 与 ack 的 effective.mode 互相矛盾）。
        const float gain = effectiveMode == "fixed" ? 1.0f : static_cast<float>(volume_);
        audio_.SetSoftwareGain(gain);
        audio_.SetVolumeMode(effectiveMode);
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
    // M4-b：升档/恢复探测钩子（各自只在对应状态生效）。
    auto expandEvents = MaybeExpandBuffer();
    auto recoverEvents = MaybeRecoverExclusive();
    auto deviceEvents = MaybeHandleDeviceEvent();
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
    for (auto& e : expandEvents) events.push_back(std::move(e));
    for (auto& e : recoverEvents) events.push_back(std::move(e));
    for (auto& e : deviceEvents) events.push_back(std::move(e));
    return events;
}

std::string Engine::NextStreamToken() {
    return "core-" + std::to_string(++streamTokens_);
}

}  // namespace rhine
