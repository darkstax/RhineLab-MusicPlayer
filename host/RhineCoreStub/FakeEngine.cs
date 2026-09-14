namespace RhineCoreStub;

/// <summary>协议 §6 的播放状态枚举（线上传输用的小写字符串见 <see cref="PlayStateExtensions.ToWire"/>）。</summary>
public enum PlayState
{
    Idle,
    Playing,
    Paused,
    Stopped,
}

public static class PlayStateExtensions
{
    public static string ToWire(this PlayState state) => state switch
    {
        PlayState.Playing => "playing",
        PlayState.Paused => "paused",
        PlayState.Stopped => "stopped",
        _ => "idle",
    };
}

/// <summary>协议 §7 bad_request 的引擎侧表达：参数非法（含枚举不识别）；由宿主转成 err 帧。</summary>
public sealed class EngineBadRequest(string message) : Exception(message);

/// <summary>协议 §5 not_implemented：命令未定形/未到里程碑；由宿主转成 err 帧。</summary>
public sealed class EngineNotImplemented(string message) : Exception(message);

/// <summary>
/// 一条待发出的 <c>evt</c>：<paramref name="Kind"/> 是协议 §6 的 kind（state/position/...），
/// <see cref="Data"/> 是 payload。seq/ep/ts 等框架字段由宿主统一附加，引擎不感知传输。
/// </summary>
public sealed record EngineEvent(string Kind, IReadOnlyDictionary<string, object?> Data);

/// <summary>
/// M1 假播放引擎：带模拟时钟锚点的状态机 + 进度推进 + 音量（只存值不出声）。
///
/// 设计纪律（任务书 M1 范围 A/纪律）：
/// <list type="bullet">
/// <item>**纯逻辑、零 IO、零 System.Text.Json 依赖**：时间经 <see cref="Func{TResult}"/> 注入，
/// 输出为 <see cref="EngineEvent"/> 列表；M2 用同语义在 C++ 重写并与此对拍，故保持单文件可移植结构。</item>
/// <item>**不自加协议字段**：事件 payload 严格取 <c>docs/IPC-PROTOCOL.md</c> v1.2 §5/§6 的字段集；
/// M1 豁免项 negotiated/badges 显式为 null。</item>
/// </list>
/// </summary>
public sealed class FakeEngine
{
    /// <summary>position 事件里合成 frames/rate 用的假采样率（M2 起换成协商事实）。</summary>
    public const int DefaultRate = 48000;

    /// <summary>协议 §5 engine.play 的 duration_ms 默认值。</summary>
    public const long DefaultDurationMs = 180000;

    /// <summary>§6：M1 桩的 buffered_ms 合成值 = min(duration-pos, 30000)。</summary>
    public const long SyntheticBufferedMs = 30000;

    private static readonly string[] VolumeModes = ["fixed", "hardware", "integer", "float"];

    private readonly Func<long> _nowMs;
    private readonly int _rate;
    private long _streamTokens;

    // 时钟锚点：playing 时 position = AnchorPosition + (now - AnchorEpoch)，钳到 [0, Duration]。
    private long _anchorEpochMs;
    private long _anchorPositionMs;

    public FakeEngine(Func<long> nowMs, int rate = DefaultRate)
    {
        _nowMs = nowMs;
        _rate = rate;
    }

    public PlayState State { get; private set; } = PlayState.Idle;

    public string? TrackId { get; private set; }

    public long DurationMs { get; private set; }

    public double Volume { get; private set; } = 1.0;

    public string VolumeMode { get; private set; } = "float";

    /// <summary>当前播放位置（毫秒）：playing 按锚点外推，其余状态即锚点值。</summary>
    public long PositionMs
    {
        get
        {
            if (State != PlayState.Playing) return _anchorPositionMs;
            var elapsed = Math.Max(0, _nowMs() - _anchorEpochMs);
            return Math.Min(_anchorPositionMs + elapsed, DurationMs);
        }
    }

    /// <summary>协议 §5 engine.state 的快照 result（与 state 事件 payload 同构）。</summary>
    /// <summary>M4-a（协议 v1.6）：output.mode 假协商注入点——null = 保持 §6 的 M1 桩豁免
    /// （negotiated/badges 皆 null，m1-scenario 断言不破）；非 null 时 state 快照携带假
    /// negotiated/badges（前端信号路径图/徽章三态在无真核心时也可演示）。</summary>
    public static volatile Dictionary<string, object?>? FakeNegotiated;
    public static volatile Dictionary<string, object?>? FakeBadges;

    public Dictionary<string, object?> Snapshot() => new()
    {
        ["state"] = State.ToWire(),
        ["track_id"] = TrackId,
        ["position_ms"] = PositionMs,
        ["duration_ms"] = DurationMs,
        ["volume"] = Volume,
        // §6：M1 桩豁免——引擎未接入时 negotiated/badges 输出 null（不得省略、不得自加替代字段）。
        ["negotiated"] = FakeNegotiated,
        ["badges"] = FakeBadges,
    };

    private EngineEvent StateEvent() => new("state", Snapshot());

    private EngineEvent PositionEvent()
    {
        var position = PositionMs;
        return new("position", new Dictionary<string, object?>
        {
            ["position_ms"] = position,
            ["frames"] = position * _rate / 1000,
            ["rate"] = _rate,
            ["buffered_ms"] = Math.Min(Math.Max(0, DurationMs - position), SyntheticBufferedMs),
            ["drift_ms"] = 0,
        });
    }

    /// <summary>
    /// 协议 §5 engine.play。重复 play 同 track = 从头；异 track = 切曲。
    /// 返回 [state, position] 一对即时帧（§任务书 A2：状态变更立刻补发）。
    /// </summary>
    public List<EngineEvent> Play(string trackId, long? durationMs = null, long? positionMs = null)
    {
        if (string.IsNullOrEmpty(trackId))
            throw new EngineBadRequest("engine.play requires a non-empty track_id");

        var duration = durationMs ?? DefaultDurationMs;
        if (duration <= 0)
            throw new EngineBadRequest($"duration_ms must be positive, got {duration}");

        var start = positionMs ?? 0;
        if (start < 0)
            throw new EngineBadRequest($"position_ms must be >= 0, got {start}");

        TrackId = trackId;
        DurationMs = duration;
        _anchorPositionMs = Math.Min(start, duration); // 钳到曲长以内（协议 §5 seek 同款钳制）
        _anchorEpochMs = _nowMs();
        State = PlayState.Playing;
        return [StateEvent(), PositionEvent()];
    }

    /// <summary>协议 §5 engine.pause：仅 playing 生效，其余状态幂等回当前 state。</summary>
    public List<EngineEvent> Pause()
    {
        if (State == PlayState.Playing)
        {
            // 冻结：把外推位置落成锚点。
            _anchorPositionMs = PositionMs;
            State = PlayState.Paused;
        }

        return [StateEvent(), PositionEvent()];
    }

    /// <summary>协议 §5 engine.resume：仅 paused 生效，其余状态幂等回当前 state。</summary>
    public List<EngineEvent> Resume()
    {
        if (State == PlayState.Paused)
        {
            _anchorEpochMs = _nowMs(); // 从冻结位置续播，不跳变
            State = PlayState.Playing;
        }

        return [StateEvent(), PositionEvent()];
    }

    /// <summary>
    /// 协议 §5 engine.stop（语义照 musicfox Player.Stop）：停止并回到起点；
    /// track_id 保留展示，位置清零，任何状态都可 stop（idle 时幂等）。
    /// </summary>
    public List<EngineEvent> Stop()
    {
        _anchorPositionMs = 0;
        _anchorEpochMs = _nowMs();
        State = PlayState.Stopped;
        return [StateEvent(), PositionEvent()];
    }

    /// <summary>协议 §5 engine.toggle（语义照 musicfox Player.Toggle）：playing↔paused；idle/stopped 且有曲目=从头重播。
    /// 审查 P1-1：重播**保留当前曲目时长**（不能退回 180s 缺省，否则曲终重播后进度/自动停止点失真）。</summary>
    public List<EngineEvent> Toggle() => State switch
    {
        PlayState.Playing => Pause(),
        PlayState.Paused => Resume(),
        _ when TrackId is { } track => Play(track, DurationMs),
        _ => [StateEvent(), PositionEvent()],
    };

    /// <summary>协议 §5 engine.seek：钳到 [0, duration_ms]，返回 applied_ms。无曲目时 bad_request。</summary>
    public (long AppliedMs, List<EngineEvent> Events) Seek(long positionMs)
    {
        if (TrackId is null)
            throw new EngineBadRequest("engine.seek requires a loaded track");

        var applied = Math.Clamp(positionMs, 0, DurationMs);
        _anchorPositionMs = applied;
        _anchorEpochMs = _nowMs();
        // 任务书 A2：变更即时生效并立刻补发一帧 position+state。
        return (applied, [PositionEvent(), StateEvent()]);
    }

    /// <summary>
    /// 协议 §5 engine.volume：mode ∈ fixed/hardware/integer/float；mode=fixed 时 value 锁定 1.0。
    /// value 越界按 §7「越界钳制」处理（钳到 [0,1]）；非数值由宿主在解析层回 bad_request。
    /// </summary>
    public (string Mode, double Value, List<EngineEvent> Events) SetVolume(string mode, double? value)
    {
        if (Array.IndexOf(VolumeModes, mode) < 0)
            throw new EngineBadRequest($"unknown volume mode '{mode}' (expected fixed/hardware/integer/float)");

        VolumeMode = mode;
        Volume = mode == "fixed" ? 1.0 : Math.Clamp(value ?? Volume, 0.0, 1.0);
        return (VolumeMode, Volume, [PositionEvent(), StateEvent()]);
    }

    /// <summary>
    /// 宿主每秒调用一次：任意状态都发一帧 position（不播时位置恒定，保持链路心跳可见，
    /// 沿用 M0 的 1Hz 语义但换成 §6 position 载荷）；播完自动收敛为
    /// <c>evt{state:"stopped"}</c>（M1 不做自动下一曲，队列在 M2）。
    /// </summary>
    public List<EngineEvent> Tick()
    {
        var finished = State == PlayState.Playing && PositionMs >= DurationMs;
        if (finished)
        {
            _anchorPositionMs = DurationMs;
            State = PlayState.Stopped;
        }

        var events = new List<EngineEvent> { PositionEvent() };
        if (finished) events.Add(StateEvent());
        return events;
    }

    /// <summary>§5：stream_token。桩只保证进程内单调（fake-&lt;n&gt;）。</summary>
    public string NextStreamToken() => $"fake-{Interlocked.Increment(ref _streamTokens)}";
}
