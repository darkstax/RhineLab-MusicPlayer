using RhineCoreStub;
using Xunit;

namespace RhineCoreTests;

/// <summary>
/// M1 假引擎状态机全转换表单测（任务书验收 2 的“dotnet test 状态机全转换”轨）。
/// 时钟注入为可控假时钟：所有断言与真实时间无关。
/// M2 换 C++ 真核心时，本表即对拍基准（同输入序列 → 同状态/位置/事件序列）。
/// </summary>
public class FakeEngineTests
{
    private sealed class FakeClock
    {
        public long NowMs { get; set; } = 1_000_000;

        public long Now() => NowMs;

        public void Advance(int ms) => NowMs += ms;
    }

    private static (FakeEngine engine, FakeClock clock) NewEngine()
    {
        var clock = new FakeClock();
        return (new FakeEngine(clock.Now), clock);
    }

    private static T? Field<T>(EngineEvent evt, string name) =>
        evt.Data.TryGetValue(name, out var value) && value is T typed ? typed : default;

    private static EngineEvent? Event(List<EngineEvent> events, string kind) =>
        events.FirstOrDefault(e => e.Kind == kind);

    // ---------- 初始与 idle 幂等 ----------

    [Fact]
    public void Initial_state_is_idle_with_null_track()
    {
        var (engine, _) = NewEngine();
        var snapshot = engine.Snapshot();
        Assert.Equal("idle", snapshot["state"]);
        Assert.Null(snapshot["track_id"]);
        Assert.Equal(0L, snapshot["position_ms"]);
        // 协议 §6：M1 桩 negotiated/badges 显式为 null（键必须存在）。
        Assert.True(snapshot.ContainsKey("negotiated") && snapshot["negotiated"] is null);
        Assert.True(snapshot.ContainsKey("badges") && snapshot["badges"] is null);
    }

    [Fact]
    public void Pause_resume_stop_on_idle_are_idempotent_and_emit_state_position()
    {
        var (engine, _) = NewEngine();
        foreach (var action in new Func<List<EngineEvent>>[] { engine.Pause, engine.Resume, engine.Stop })
        {
            var events = action();
            Assert.Equal(2, events.Count);
            Assert.NotNull(Event(events, "state"));
            Assert.NotNull(Event(events, "position"));
        }

        Assert.Equal(PlayState.Stopped, engine.State); // stop 把 idle 也收敛为 stopped（幂等，不报错）
    }

    [Fact]
    public void Toggle_without_track_is_noop()
    {
        var (engine, _) = NewEngine();
        var events = engine.Toggle();
        Assert.Equal(PlayState.Idle, engine.State);
        Assert.Equal("idle", Field<string>(Event(events, "state")!, "state"));
    }

    // ---------- play ----------

    [Fact]
    public void Play_enters_playing_with_clock_anchor_and_default_duration()
    {
        var (engine, clock) = NewEngine();
        var events = engine.Play("X-001");
        Assert.Equal(PlayState.Playing, engine.State);
        Assert.Equal("X-001", engine.TrackId);
        Assert.Equal(180_000L, engine.DurationMs); // §5 duration_ms 缺省 = 180000
        Assert.Equal("playing", Field<string>(Event(events, "state")!, "state"));
        Assert.Equal(0L, Field<long>(Event(events, "position")!, "position_ms"));

        clock.Advance(5_000);
        Assert.Equal(5_000L, engine.PositionMs);
    }

    [Fact]
    public void Play_with_position_starts_offset()
    {
        var (engine, clock) = NewEngine();
        engine.Play("X-002", 60_000, 10_000);
        clock.Advance(2_000);
        Assert.Equal(12_000L, engine.PositionMs);
    }

    [Fact]
    public void Play_position_beyond_duration_clamps_not_rejects()
    {
        var (engine, _) = NewEngine();
        engine.Play("X-003", 10_000, 99_000);
        Assert.Equal(10_000L, engine.PositionMs);
        Assert.Equal(PlayState.Playing, engine.State);
    }

    [Fact]
    public void Play_same_track_restarts_from_head_and_other_track_switches()
    {
        var (engine, clock) = NewEngine();
        engine.Play("A", 60_000);
        clock.Advance(7_000);
        engine.Play("A", 60_000); // 同 track = 从头
        Assert.Equal(0L, engine.PositionMs);
        clock.Advance(3_000);
        engine.Play("B", 90_000); // 异 track = 切曲
        Assert.Equal("B", engine.TrackId);
        Assert.Equal(90_000L, engine.DurationMs);
        Assert.Equal(0L, engine.PositionMs);
    }

    [Fact]
    public void Play_from_paused_or_stopped_resumes_new_playback()
    {
        var (engine, _) = NewEngine();
        engine.Play("A");
        engine.Pause();
        engine.Play("A");
        Assert.Equal(PlayState.Playing, engine.State);
        Assert.Equal(0L, engine.PositionMs);
    }

    [Theory]
    [InlineData("")]
    public void Play_rejects_empty_track_id(string track)
    {
        var (engine, _) = NewEngine();
        Assert.Throws<EngineBadRequest>(() => engine.Play(track));
    }

    [Fact]
    public void Play_rejects_non_positive_duration_and_negative_position()
    {
        var (engine, _) = NewEngine();
        Assert.Throws<EngineBadRequest>(() => engine.Play("A", 0));
        Assert.Throws<EngineBadRequest>(() => engine.Play("A", -5));
        Assert.Throws<EngineBadRequest>(() => engine.Play("A", 10, -1));
    }

    // ---------- pause / resume / toggle ----------

    [Fact]
    public void Pause_freezes_progress_and_resume_continues_without_jump()
    {
        var (engine, clock) = NewEngine();
        engine.Play("A", 60_000);
        clock.Advance(10_000);
        engine.Pause();
        Assert.Equal(PlayState.Paused, engine.State);
        clock.Advance(30_000); // 暂停期间不推进
        Assert.Equal(10_000L, engine.PositionMs);
        engine.Resume();
        Assert.Equal(PlayState.Playing, engine.State);
        Assert.Equal(10_000L, engine.PositionMs); // 从冻结处续，不跳变
        clock.Advance(5_000);
        Assert.Equal(15_000L, engine.PositionMs);
    }

    [Fact]
    public void Pause_is_idempotent_when_not_playing()
    {
        var (engine, clock) = NewEngine();
        engine.Play("A", 60_000);
        engine.Pause();
        clock.Advance(1_000);
        engine.Pause(); // paused 再 pause：位置不变
        Assert.Equal(PlayState.Paused, engine.State);
        Assert.Equal(0L, engine.PositionMs);
    }

    [Fact]
    public void Resume_ignores_when_playing_or_stopped()
    {
        var (engine, clock) = NewEngine();
        engine.Play("A", 60_000);
        clock.Advance(4_000);
        engine.Resume(); // playing 时 resume 幂等，不打断
        Assert.Equal(PlayState.Playing, engine.State);
        Assert.Equal(4_000L, engine.PositionMs);
    }

    [Fact]
    public void Toggle_alternates_playing_and_paused()
    {
        var (engine, clock) = NewEngine();
        engine.Play("A", 60_000);
        engine.Toggle();
        Assert.Equal(PlayState.Paused, engine.State);
        engine.Toggle();
        Assert.Equal(PlayState.Playing, engine.State);
        clock.Advance(2_000);
        Assert.Equal(2_000L, engine.PositionMs);
    }

    [Fact]
    public void Toggle_on_stopped_replays_current_track_from_head()
    {
        var (engine, clock) = NewEngine();
        engine.Play("A", 60_000);
        clock.Advance(10_000);
        engine.Stop();
        engine.Toggle();
        Assert.Equal(PlayState.Playing, engine.State);
        Assert.Equal(0L, engine.PositionMs);
    }

    // ---------- stop ----------

    [Fact]
    public void Stop_zeroes_position_keeps_track()
    {
        var (engine, clock) = NewEngine();
        engine.Play("A", 60_000);
        clock.Advance(9_000);
        var events = engine.Stop();
        Assert.Equal(PlayState.Stopped, engine.State);
        Assert.Equal(0L, engine.PositionMs);
        Assert.Equal("A", engine.TrackId);
        Assert.Equal("stopped", Field<string>(Event(events, "state")!, "state"));
        clock.Advance(5_000);
        Assert.Equal(0L, engine.PositionMs); // stopped 不再推进
    }

    // ---------- seek ----------

    [Fact]
    public void Seek_clamps_to_range_and_emits_position_then_state()
    {
        var (engine, clock) = NewEngine();
        engine.Play("A", 60_000);
        var (applied, events) = engine.Seek(120_000);
        Assert.Equal(60_000L, applied); // 钳到 duration
        Assert.Equal("position", events[0].Kind);
        Assert.Equal("state", events[1].Kind); // 任务书：立刻补发一帧 position+state
        Assert.Equal(60_000L, engine.PositionMs);

        (applied, _) = engine.Seek(-1_000);
        Assert.Equal(0L, applied);

        (applied, _) = engine.Seek(10_000);
        Assert.Equal(10_000L, applied);
        clock.Advance(1_000);
        Assert.Equal(11_000L, engine.PositionMs); // seek 重设锚点，playing 继续推进
    }

    [Fact]
    public void Seek_while_paused_updates_frozen_position()
    {
        var (engine, _) = NewEngine();
        engine.Play("A", 60_000);
        engine.Pause();
        engine.Seek(30_000);
        Assert.Equal(30_000L, engine.PositionMs);
        Assert.Equal(PlayState.Paused, engine.State);
    }

    [Fact]
    public void Seek_without_track_is_bad_request()
    {
        var (engine, _) = NewEngine();
        Assert.Throws<EngineBadRequest>(() => engine.Seek(1_000));
    }

    // ---------- volume ----------

    [Theory]
    [InlineData("hardware")]
    [InlineData("integer")]
    [InlineData("float")]
    public void Volume_stores_mode_and_value(string mode)
    {
        var (engine, _) = NewEngine();
        var (effectiveMode, value, events) = engine.SetVolume(mode, 0.3);
        Assert.Equal(mode, effectiveMode);
        Assert.Equal(0.3, value, precision: 9);
        Assert.Equal(0.3, engine.Volume, precision: 9);
        Assert.NotNull(Event(events, "state"));
        Assert.NotNull(Event(events, "position"));
    }

    [Fact]
    public void Volume_fixed_mode_locks_value_to_one()
    {
        var (engine, _) = NewEngine();
        engine.SetVolume("float", 0.25);
        var (mode, value, _) = engine.SetVolume("fixed", 0.7);
        Assert.Equal("fixed", mode);
        Assert.Equal(1.0, value, precision: 9); // 任务书 A3：fixed 锁定 1.0
    }

    [Fact]
    public void Volume_value_clamps_to_unit_range_and_keeps_current_when_omitted()
    {
        var (engine, _) = NewEngine();
        var (_, value, _) = engine.SetVolume("float", 1.5);
        Assert.Equal(1.0, value, precision: 9);
        (_, value, _) = engine.SetVolume("float", -0.5);
        Assert.Equal(0.0, value, precision: 9);
        (_, value, _) = engine.SetVolume("hardware", null);
        Assert.Equal(0.0, value, precision: 9); // 省略 value = 保持现状（§5 参数省略语义）
    }

    [Theory]
    [InlineData("loud")]
    [InlineData("FIXED")] // 线上枚举为小写（§5/§6），大小写敏感
    public void Volume_rejects_unknown_mode(string mode)
    {
        var (engine, _) = NewEngine();
        Assert.Throws<EngineBadRequest>(() => engine.SetVolume(mode, 0.5));
    }

    // ---------- 进度推进与自动停止 ----------

    [Fact]
    public void Tick_emits_position_at_current_progress()
    {
        var (engine, clock) = NewEngine();
        engine.Play("A", 60_000);
        clock.Advance(1_000);
        var events = engine.Tick();
        Assert.Single(events);
        var position = events[0];
        Assert.Equal("position", position.Kind);
        Assert.Equal(1_000L, Field<long>(position, "position_ms"));
        Assert.Equal(48_000, Field<int>(position, "rate"));
        Assert.Equal(48_000L, Field<long>(position, "frames")); // 1000ms × 48000Hz / 1000
        Assert.Equal(30_000L, Field<long>(position, "buffered_ms")); // min(59000, 30000)
        Assert.Equal(0, Field<int>(position, "drift_ms"));
    }

    [Fact]
    public void Buffered_ms_shrinks_near_track_end()
    {
        var (engine, clock) = NewEngine();
        engine.Play("A", 60_000);
        clock.Advance(50_000);
        var position = engine.Tick().First(e => e.Kind == "position");
        Assert.Equal(10_000L, Field<long>(position, "buffered_ms")); // min(10000, 30000)
    }

    [Fact]
    public void Playing_to_end_emits_position_then_stopped_state_exactly_once()
    {
        var (engine, clock) = NewEngine();
        engine.Play("A", 3_000);
        clock.Advance(3_000);
        var events = engine.Tick();
        Assert.Equal(2, events.Count);
        Assert.Equal("position", events[0].Kind);
        Assert.Equal(3_000L, Field<long>(events[0], "position_ms"));
        Assert.Equal("state", events[1].Kind);
        Assert.Equal("stopped", Field<string>(events[1], "state"));
        Assert.Equal(PlayState.Stopped, engine.State);

        events = engine.Tick(); // 再 tick 不重复发 stopped
        Assert.Single(events);
        Assert.Equal("position", events[0].Kind);
    }

    [Fact]
    public void Stopped_track_keeps_constant_position_on_ticks()
    {
        var (engine, clock) = NewEngine();
        engine.Play("A", 3_000);
        clock.Advance(5_000);
        engine.Tick(); // 自动 stopped，位置钳在 duration
        clock.Advance(5_000);
        var events = engine.Tick();
        var position = events.Single(e => e.Kind == "position");
        Assert.Equal(3_000L, Field<long>(position, "position_ms")); // 位置停在末尾，不再外推
        Assert.Equal(0L, Field<long>(position, "buffered_ms"));
    }

    [Fact]
    public void Idle_tick_still_emits_position_heartbeat()
    {
        // 任务书 A2 的 1Hz position 语义：不播放时位置恒定 0（链路心跳可观测，沿用 M0 的 1Hz 传统）。
        var (engine, _) = NewEngine();
        var events = engine.Tick();
        var position = Assert.Single(events);
        Assert.Equal("position", position.Kind);
        Assert.Equal(0L, Field<long>(position, "position_ms"));
    }

    // ---------- stream token ----------

    [Fact]
    public void Stream_tokens_are_monotonic_within_process()
    {
        var (engine, _) = NewEngine();
        Assert.Equal("fake-1", engine.NextStreamToken());
        Assert.Equal("fake-2", engine.NextStreamToken());
    }

    // ---------- 快照一致性 ----------

    [Fact]
    public void Snapshot_shape_matches_protocol_6_state_fields()
    {
        var (engine, clock) = NewEngine();
        engine.Play("A", 60_000);
        clock.Advance(5_000);
        var snapshot = engine.Snapshot();
        Assert.Equal(
            new[] { "badges", "duration_ms", "negotiated", "position_ms", "state", "track_id", "volume" },
            snapshot.Keys.OrderBy(k => k, StringComparer.Ordinal).ToArray());
        Assert.Equal(5_000L, snapshot["position_ms"]);
        Assert.Equal("A", snapshot["track_id"]);
        Assert.Equal(1.0, snapshot["volume"]);
    }
}
