// engine.h — 状态机：FakeEngine（RhineCoreStub）语义直译 + AudioBackend 控制接线。
// 转换表/锚点/钳制/toggle 保时长/idle→stop 幂等/曲终自动 stopped 逐条对照见 docs/M2-FINDINGS.md。
//
// 与桩的差异（M2 真语义增量）：
//   · play 只接受 "file:<绝对路径>"（非 file: 前缀 bad_request）；duration 来自解码事实，
//     不接受也不伪造 duration_ms（显式给了也只是非法时同样 bad_request——与桩校验一致）；
//   · position 权威 = 设备时钟（AudioBackend），不再模拟；
//   · state 快照的 negotiated/badges 不再为 null（引擎接入后的协商事实）。
// 线程：状态机本体只在 IPC 会话线程内操作（含 1Hz tick 由会话线程驱动），无需加锁；
// 与音频线程的交互全部经 AudioBackend 的原子账本。
#pragma once

#include <cstdint>
#include <functional>
#include <optional>
#include <string>
#include <vector>

#include "audio.h"
#include "protocol.h"

namespace rhine {

// 状态机对外的一次变更结果：ack result（可无）+ 需要立刻补发的事件（kind + payload）。
struct CommandOutcome {
    proto::Json result;  // null = 无 result 字段语义（调用方按桩的 MakeAck 处理）
    std::vector<std::pair<std::string, proto::Json>> events;
};

// 待抛出的错误（桩的 EngineBadRequest / EngineNotImplemented 对应物；§7 错误码）。
struct BadRequest {
    std::string message;
};
struct NotImplemented {
    std::string message;
};
// §7 decode_failed（retryable=是，附 track_id）。
struct DecodeFailure {
    std::string message;
    proto::Json extra;  // 可空；非空时并入 err.error（协议 §3 error 对象内扩展字段）
};

class Engine {
public:
    explicit Engine(AudioBackend& audio);

    // —— 协议 §5 命令（返回值即 ack result；事件写入 out.Events，[state, position] 序）——
    CommandOutcome Play(const std::string& trackId, std::optional<double> durationMs,
                        std::optional<double> positionMs);
    CommandOutcome Pause();
    CommandOutcome Resume();
    CommandOutcome Stop();
    CommandOutcome Toggle();
    CommandOutcome Seek(std::int64_t positionMs);
    CommandOutcome SetVolume(const std::string& mode, std::optional<double> value);
    // M4-a（协议 v1.6 output.mode）：策略更新 + 有曲时立即重开设备（独占↔共享/换缓冲）。
    CommandOutcome SetOutputMode(const std::string& mode, std::optional<double> bufferMs,
                                 std::optional<bool> autoExpand, std::optional<double> bufferMaxMs);
    proto::Json Snapshot() const;  // engine.state 的 result（与 state 事件 payload 同构）

    // 会话 1Hz tick：任意状态发一帧 position；playing 且（播完或 EOF 排空）→ 自动 stopped。
    std::vector<std::pair<std::string, proto::Json>> Tick();

    std::string NextStreamToken();

private:
    // 状态机视图：与 FakeEngine 的 PlayState 对齐。
    enum class State { Idle, Playing, Paused, Stopped };

    static const char* StateToWire(State state);
    // 当前毫秒位置：设备帧 → ms（桩同款：非 playing 时即锚点冻结值）。
    std::int64_t PositionMs() const;
    proto::Json PositionPayload() const;
    proto::Json StatePayload() const;
    // 状态变更后统一补发 [state, position]（§任务书 A2 即时帧序与桩一致）。
    void AppendStatePosition(CommandOutcome& outcome);
    // 把当前曲（file: track_id）重新打开并从 positionMs 起播（resume/replay 共用）。
    void OpenCurrentTrackAndStart(std::int64_t startMs, CommandOutcome& outcome);
    // 停止全部音频（不动状态机账本）。
    void StopAudio();

    static std::int64_t FramesToMs(std::uint64_t frames, std::uint32_t rate);
    static std::uint64_t MsToFrames(std::int64_t ms, std::uint32_t rate);

    AudioBackend& audio_;
    State state_ = State::Idle;
    std::string trackId_;    // 完整 track_id（"file:..."），idle 时为空
    std::int64_t durationMs_ = 0;
    double volume_ = 1.0;
    std::string volumeMode_ = "float";
    std::uint64_t streamTokens_ = 0;
    std::int64_t lastPositionMs_ = 0;  // 非 playing 状态的冻结位置（idle/stopped 用）
};

}  // namespace rhine
