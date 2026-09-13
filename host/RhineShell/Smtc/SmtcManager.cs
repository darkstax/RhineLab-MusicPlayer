using System.IO;
using System.Text.Json;
using System.Text.Json.Nodes;
using Windows.Media;
using RhineShell.Hosting;

namespace RhineShell.Smtc;

/// <summary>
/// 系统媒体传输控制（SMTC，M3 范围 B）：壳侧 C# WinRT 原生桥接
/// （WebView2 Media Session → SMTC 映射不可靠，查证后弃用浏览器路径，见 docs/M3-PLAN.md）。
///
/// <list type="bullet">
/// <item><b>出站</b>：消费 <see cref="Bridge.CoreFrameObserved"/> 转发的 <c>evt{state}</c> /
/// <c>evt{position}</c>（协议 §6）→ <c>DisplayUpdater.MusicProperties</c>（M2 期无元数据：Title=
/// track_id 文件名/档案号占位，M5 接真元数据）、<c>PlaybackStatus</c>、
/// <c>UpdateTimelineProperties(SystemMediaTransportControlsTimelineProperties)</c>。
/// 节流纪律（任务书红线 ≤1Hz）：状态变更即发；position 事件本身 1Hz，另加 900ms 守卫。</item>
/// <item><b>入站</b>：<c>ButtonPressed</c>（Play/Pause/PlayPause → engine.toggle；Stop → engine.stop；
/// Next/Previous 属 M2b/M5 队列域 → 按钮置灰，若仍触发按协议 §5 转发拿 not_implemented）与
/// <c>PlaybackPositionChangeRequested</c>（飞屏/键盘 seek → engine.seek，本机 WinRT 投影
/// 无 TimelineProperties.SeekReceived，此为桌面 seek 的对应事件，M3-FINDINGS 记）
/// ——全部复用 <see cref="ShellChannel.SendCommandAsync"/> 既有 cmd 转发链，不自开旁路。</item>
/// <item><b>降级</b>：WPF 线程无 CoreWindow，<c>GetForCurrentView()</c> 实测报
/// Invalid window handle（0x80070578）——改用桌面官方入口 <c>GetForWindow(hwnd)</c>；
/// 再抛异常时 catch 记日志返回 null，UI 零影响（任务书 B2）。封面 M3 无数据源不贴
/// （M5 用 CopyFromFileAsync 补，就绪度见 M3-FINDINGS §6）。</item>
/// </list>
/// </summary>
public sealed class SmtcManager : IDisposable
{
    private readonly ShellChannel _channel;
    private readonly SystemMediaTransportControlsTimelineProperties _timeline = new();
    private SystemMediaTransportControls? _controls;
    private int _commandSequence;

    // 时间线账本：state/position 到达时记 (positionMs, epochMs)，刷新时按播放态外推。
    private long _positionMs;
    private long _epochMs;
    private bool _isPlaying;
    private long _durationMs;
    private long _lastTimelineUpdateMs;
    private string _lastTitle = "";
    private MediaPlaybackStatus _lastStatus = MediaPlaybackStatus.Stopped;

    private SmtcManager(ShellChannel channel) => _channel = channel;

    /// <summary>创建并注册 SMTC；失败（含 WinRT 不可用）返回 null 并记日志——调用方无须分支处理。
    /// 窗口句柄：WPF 下 <c>GetForCurrentView()</c> 报 Invalid window handle（M3 实测 0x80070578：
    /// Win32 线程无 CoreWindow），改用官方桌面入口
    /// <c>SystemMediaTransportControlsInterop.GetForWindow(hwnd)</c>（任务书 B2 的降级条款
    /// 在此升级为完整实现，FINDINGS 记录）。</summary>
    public static SmtcManager? TryCreate(ShellChannel channel, Bridge bridge, IntPtr hwnd)
    {
        try
        {
            var manager = new SmtcManager(channel);
            if (!manager.Register(hwnd))
            {
                return null;
            }

            bridge.CoreFrameObserved += manager.OnCoreFrame;
            return manager;
        }
        catch (Exception ex)
        {
            // 任务书 B2：任何注册异常（含 TypeLoadException/HRESULT）都只降级不冒泡。
            Log.Warn($"smtc registration failed (UI unaffected): {ex.GetType().Name} 0x{ex.HResult:x8}: {ex.Message}");
            return null;
        }
    }

    private bool Register(IntPtr hwnd)
    {
        Log.Info($"smtc step: GetForWindow(hwnd=0x{hwnd:x})");
        var controls = SystemMediaTransportControlsInterop.GetForWindow(hwnd);
        _controls = controls;
        Log.Info("smtc step: GetForWindow ok; IsEnabled=true");
        controls.IsEnabled = true;
        controls.ButtonPressed += OnButtonPressed;
        controls.PlaybackPositionChangeRequested += OnPositionChangeRequested;

        // 初值：Stopped + 空媒体卡。注意 MediaPlaybackStatus.Closed **不可编程 set**
        // （实测 set Closed 抛 COMException「不支持该请求」E_NOT_SUPPORTED——它是系统
        // 保留的「无媒体活动」只读态），初值只能用 Stopped；首份 state 事件到达即刷新
        // （桩/核心 hello 后必补发快照，M2-FINDINGS §1 #34）。
        Log.Info("smtc step: PlaybackStatus=Stopped");
        controls.PlaybackStatus = MediaPlaybackStatus.Stopped;
        // 顺序坑（M3 实测 E_NOT_SUPPORTED 0x80070032）：必须**先设 Type 再碰 MusicProperties**，
        // Type 未定时访问 .MusicProperties 直接抛「不支持该请求」。
        Log.Info("smtc step: DisplayUpdater seed");
        controls.DisplayUpdater.Type = MediaPlaybackType.Music;
        var music = controls.DisplayUpdater.MusicProperties;
        music.Title = "Rhine Lab";
        music.Artist = "分析终端";
        Log.Info("smtc step: DisplayUpdater.Update()");
        controls.DisplayUpdater.Update();

        Log.Info("smtc registered (SystemMediaTransportControlsInterop.GetForWindow ok)");
        return true;
    }

    /// <summary>释放：退订事件 + 状态归 Stopped（窗口关闭路径调用；不触碰转发链）。</summary>
    public void Dispose()
    {
        if (_controls is null) return;
        try
        {
            _controls.ButtonPressed -= OnButtonPressed;
            _controls.PlaybackPositionChangeRequested -= OnPositionChangeRequested;
            _controls.IsEnabled = false;
            _controls.PlaybackStatus = MediaPlaybackStatus.Stopped;
        }
        catch (Exception ex)
        {
            Log.Warn($"smtc release failed: {ex.Message}");
        }

        _controls = null;
    }

    // —— 出站：核心帧 → SMTC（UI 线程：Bridge 观察点已在 Dispatcher 上）——

    private void OnCoreFrame(JsonObject frame)
    {
        string? type;
        try
        {
            type = frame["t"]?.GetValue<string>();
        }
        catch (InvalidOperationException)
        {
            return; // t 非字符串：非法帧由 Bridge/核心处理，此处静默
        }

        if (type != "evt") return;
        switch (SafeString(frame["evt"]))
        {
            case "state":
                ApplyState(frame["data"] as JsonObject);
                break;
            case "position":
                ApplyPosition(frame["data"] as JsonObject);
                break;
            default:
                break;
        }
    }

    private void ApplyState(JsonObject? data)
    {
        var controls = _controls;
        if (controls is null || data is null) return;
        var state = SafeString(data["state"]);
        if (state is null) return;

        _positionMs = Number(data, "position_ms") ?? _positionMs;
        _durationMs = Number(data, "duration_ms") ?? _durationMs;
        _epochMs = Environment.TickCount64;
        _isPlaying = state == "playing";

        // DisplayProperties：M2 期无元数据接口——track_id 占位（file: 取文件名去扩展，
        // 桩的档案号原样），M5 换真 Title/Artist（就绪度见 M3-FINDINGS §6）。
        var trackId = SafeString(data["track_id"]);
        var title = TrackTitle(trackId);
        if (title != _lastTitle)
        {
            _lastTitle = title;
            controls.DisplayUpdater.Type = MediaPlaybackType.Music;
            var music = controls.DisplayUpdater.MusicProperties;
            music.Title = title;
            music.Artist = "Rhine Lab 档案"; // 占位（M5 元数据接管后为真艺人）
            // 封面挂载点：controls.DisplayUpdater.Thumbnail = RandomAccessStreamReference
            //   .CreateFromFile(uri)（M5；M3 无封面数据源，任务书 B1 裁定先不贴）。
            controls.DisplayUpdater.Update();
        }

        var status = state switch
        {
            "playing" => MediaPlaybackStatus.Playing,
            "paused" => MediaPlaybackStatus.Paused,
            _ => MediaPlaybackStatus.Stopped,
        };
        if (status != _lastStatus)
        {
            _lastStatus = status;
            controls.PlaybackStatus = status;
        }

        // Next/Previous 可用性：M2 核心/桩无 engine.next/prev（属 M2b/M5 队列域）→
        // 按钮置灰（任务书 B1）；Play/Pause/Stop 恒可用（toggle 幂等，空曲时核心回幂等 state）。
        controls.IsPlayEnabled = true;
        controls.IsPauseEnabled = true;
        controls.IsStopEnabled = true;
        controls.IsNextEnabled = false;
        controls.IsPreviousEnabled = false;

        UpdateTimeline(force: true);
        Log.Info($"smtc state={state} track=\"{_lastTitle}\" duration={_durationMs}ms");
    }

    private void ApplyPosition(JsonObject? data)
    {
        if (_controls is null || data is null) return;
        var position = Number(data, "position_ms");
        if (position is null) return;
        _positionMs = position.Value;
        _epochMs = Environment.TickCount64;
        UpdateTimeline(force: false); // position 即 1Hz；900ms 守卫防核心未来加频
    }

    /// <summary>时间线刷新（节流红线 ≤1Hz：状态变更 force=true 即时，其余 900ms 守卫）。</summary>
    private void UpdateTimeline(bool force)
    {
        var controls = _controls;
        if (controls is null) return;
        var now = Environment.TickCount64;
        if (!force && now - _lastTimelineUpdateMs < 900) return;
        _lastTimelineUpdateMs = now;

        try
        {
            var projected = _isPlaying
                ? Math.Max(_positionMs, _positionMs + (now - _epochMs))
                : _positionMs;
            if (_durationMs > 0) projected = Math.Min(projected, _durationMs);
            _timeline.Position = TimeSpan.FromMilliseconds(Math.Max(0, projected));
            _timeline.StartTime = TimeSpan.Zero;
            _timeline.EndTime = TimeSpan.FromMilliseconds(Math.Max(0, _durationMs));
            controls.UpdateTimelineProperties(_timeline);
        }
        catch (Exception ex)
        {
            Log.Warn($"smtc timeline update failed: {ex.Message}");
        }
    }

    // —— 入站：SMTC 按钮/seek → 既有 cmd 转发链 ——

    private void OnButtonPressed(SystemMediaTransportControls sender, SystemMediaTransportControlsButtonPressedEventArgs args)
    {
        var cmd = args.Button switch
        {
            SystemMediaTransportControlsButton.Play => "engine.toggle",
            SystemMediaTransportControlsButton.Pause => "engine.toggle",
            SystemMediaTransportControlsButton.Stop => "engine.stop",
            // Next/Previous：核心未实现（按钮已置灰；若仍被触发，走转发拿 not_implemented err，
            // 不静默丢弃——协议 §5 的诚实性对链路每一环成立）。
            SystemMediaTransportControlsButton.Next => "engine.next",
            SystemMediaTransportControlsButton.Previous => "engine.previous",
            _ => null, // Record/FastForward/Rewind/ChannelUp/Down 等忽略（任务书 B1）
        };
        if (cmd is null) return;
        _ = SendCommandAsync(cmd, null, $"smtc {args.Button}");
    }

    private void OnPositionChangeRequested(SystemMediaTransportControls sender, PlaybackPositionChangeRequestedEventArgs args)
    {
        var ms = (long)args.RequestedPlaybackPosition.TotalMilliseconds;
        _ = SendCommandAsync("engine.seek", new JsonObject { ["position_ms"] = ms }, $"smtc seek {ms}ms");
    }

    private async Task SendCommandAsync(string cmd, JsonObject? data, string label)
    {
        var id = $"smtc-{++_commandSequence}";
        var frame = new JsonObject { ["cmd"] = cmd };
        if (data is not null) frame["data"] = data;
        try
        {
            var reply = await _channel.SendCommandAsync(id, frame, CancellationToken.None).ConfigureAwait(false);
            if (reply["t"]?.GetValue<string>() == "err")
            {
                Log.Warn($"smtc {label} -> err {reply["error"]?["code"]?.GetValue<string>() ?? "?"}");
            }
            else
            {
                Log.Info($"smtc {label} -> ack");
            }
        }
        catch (Exception ex)
        {
            Log.Warn($"smtc {label} forward failed: {ex.Message}");
        }
    }

    private static string? SafeString(JsonNode? node)
    {
        try
        {
            return node?.GetValueKind() == JsonValueKind.String ? node!.GetValue<string>() : null;
        }
        catch (InvalidOperationException)
        {
            return null; // 信任边界外的防御仅到「不崩」为止（协议 §10）
        }
    }

    private static long? Number(JsonObject obj, string key) =>
        obj[key]?.GetValueKind() == JsonValueKind.Number ? (long)Math.Round(obj[key]!.GetValue<double>()) : null;

    private static string TrackTitle(string? trackId)
    {
        if (string.IsNullOrEmpty(trackId)) return "Rhine Lab";
        if (!trackId.StartsWith("file:", StringComparison.Ordinal)) return trackId; // 桩的档案号形态
        var path = trackId[5..];
        try
        {
            var name = Path.GetFileNameWithoutExtension(path);
            return string.IsNullOrEmpty(name) ? trackId : name;
        }
        catch (Exception ex) when (ex is ArgumentException or NotSupportedException or PathTooLongException)
        {
            return trackId;
        }
    }
}
