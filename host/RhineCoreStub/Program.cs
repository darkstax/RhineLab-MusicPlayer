using System.Diagnostics;
using System.IO.Pipes;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using RhineShared;

namespace RhineCoreStub;

/// <summary>
/// M1 音频核心桩：冒充将来的 C++ + miniaudio 核心，实现 <c>docs/IPC-PROTOCOL.md</c> v1.2
/// 在 M1 声明的命令集（hello / echo / engine.* / 1Hz position+state evt / bye）。
/// 状态机本体在 <see cref="FakeEngine"/>（纯逻辑、可 dotnet test），本文件只做管道 IO 与协议拼装；
/// M2 换真核心时按同一 FakeEngine 语义在 C++ 重写并对拍。
///
/// 协议纪律：**不得自加字段**。任何新增消息或字段都必须先改协议文档。
/// 命令行：<c>RhineCoreStub [--pipe &lt;name&gt;] [--kill-after &lt;sec&gt;] [--halt-events &lt;sec&gt;]
///            [--trace &lt;file&gt;] [--verbose] [--no-spectrum]</c>
/// 环境变量：<c>RHINE_CORE_PIPE</c>（协议 §1 的 core.pipe 覆盖项）、<c>RHINE_STUB_STATE_FILE</c>
/// （配置持久化落点覆盖，验收用）。
/// 退出码：0 = 有序退出（收到 bye 或 stdin exit/bye）；3 = 已有核心实例占用管道；
/// 5 = 会话未预期异常；7 = --kill-after 模拟崩溃。
/// </summary>
internal static class Program
{
    private const string DefaultPipe = @"\\.\pipe\rhine-music.core.v1";
    private const int Proto = 1;
    private const string App = "rhine-music-player";
    private const string Ver = "0.1.0";

    /// <summary>协议 §4/§5：M1 核心声明 echo 与 engine.* 全集（§5 表 M1 行）。
    /// devices/output/diag 属 M3/M4：caps 里不声明，被调用时按 §5 回 not_implemented。</summary>
    private static readonly string[] Caps =
    [
        "echo",
        "engine.state",
        "engine.play",
        "engine.pause",
        "engine.resume",
        "engine.stop",
        "engine.toggle",
        "engine.seek",
        "engine.volume",
        // M3（协议 v1.3）：假谱与真核心同形（正弦+噪声，参数见 docs/M3-FINDINGS.md）。
        "spectrum",
    ];

    private static readonly CancellationTokenSource Shutdown = new();
    private static readonly SemaphoreSlim WriteGate = new(1, 1);

    private static readonly Random Jitter = new();
    private static readonly Stopwatch Uptime = Stopwatch.StartNew();

    /// <summary>M3 假谱：订阅开关（cmd spectrum.on/off，协议 §5/§6 v1.3，默认 off）。
    /// 与真核心同形 payload（bands 各 64、4 位小数），但数值是合成正弦+噪声，不代表真音频。</summary>
    private static volatile bool _spectrumOn;
    private static bool _spectrumDisabled;

    private static bool _verbose;
    private static long _sequence;
    private static int _connections;
    private static volatile StreamWriter? _sessionWriter;

    /// <summary>协议 §4（v1.2）：会话世代。每次 hello 成功应答自增，evt 帧带 ep=本值，
    /// 供接收侧区分「丢帧」与「核心重启/新会话」（丢帧检测跨重连复位）。</summary>
    private static long _epoch;

    /// <summary>任务书验收 4 的调试开关：<c>--halt-events N</c> 暂停 evt 输出 N 秒
    /// （seq 照常消耗、帧不发 = 制造接收侧可检测的真实丢帧）。</summary>
    private static int _haltSeconds;
    private static long _haltUntilUptimeMs;

    /// <summary>任务书验收 2 的落盘 trace（与壳日志双证）；未指定 --trace 时仅日志。</summary>
    private static StreamWriter? _trace;

    /// <summary>验证加速（m-verify A 方案）：<c>--time-scale N</c> 把假引擎时钟按 N 倍推进
    /// （1Hz tick 仍真实发帧，故帧数不变、位置跳跃变快）；仅影响 FakeEngine 虚拟时钟，
    /// halt/uptime/持久化一律真实时间。默认 1 = 行为与旧版完全一致。</summary>
    private static double _timeScale = 1.0;
    private static readonly long TimeBaseMs = IpcFrame.NowMs();

    private static long ScaledNowMs()
    {
        var real = IpcFrame.NowMs();
        return _timeScale == 1.0 ? real : TimeBaseMs + (long)((real - TimeBaseMs) * _timeScale);
    }

    /// <summary>假引擎单例：状态跨连接保留（页面刷新/壳重连不重置播放），音量另有文件持久化。</summary>
    private static readonly FakeEngine Engine = new(ScaledNowMs);

    private static long Epoch => Interlocked.Read(ref _epoch);

    private static async Task<int> Main(string[] args)
    {
        TryUseUtf8Console();

        if (args.Contains("--help") || args.Contains("-h"))
        {
            Console.WriteLine("RhineCoreStub — M1 core stub (IPC protocol v1.2, fake engine)");
            Console.WriteLine("  --pipe <name>          named pipe (default: \\\\.\\pipe\\rhine-music.core.v1)");
            Console.WriteLine("  --kill-after <sec>     simulate a crash after N seconds (exit code 7)");
            Console.WriteLine("  --halt-events <sec>    drop evt output for N seconds (seq keeps burning; frame-loss test hook)");
            Console.WriteLine("  --time-scale <N>       advance the fake clock N× (1-1000; tick cadence unchanged; for fast verification)");
            Console.WriteLine("  --trace <file>         append every emitted engine event to a file (acceptance evidence)");
            Console.WriteLine("  --verbose              log every frame");
            Console.WriteLine("  stdin: 'exit' or 'bye' => orderly shutdown; 'halt <sec>' => halt events at runtime");
            return 0;
        }

        _verbose = args.Contains("--verbose");
        // E2E 隔离钩子：--no-spectrum 时假谱完全不可订阅（回 not_implemented），
        // 供 m1-scenario 等旧用例保持纯净帧序。
        _spectrumDisabled = args.Contains("--no-spectrum");

        var pipe = ArgValue(args, "--pipe")
            ?? Environment.GetEnvironmentVariable("RHINE_CORE_PIPE")
            ?? DefaultPipe;

        if (ArgValue(args, "--halt-events") is { } haltText && int.TryParse(haltText, out var haltSeconds) && haltSeconds > 0)
        {
            _haltSeconds = haltSeconds;
            Log("info", $"evt halt armed: {haltSeconds}s (applies on first hello handshake)");
        }

        if (ArgValue(args, "--time-scale") is { } scaleText &&
            double.TryParse(scaleText, System.Globalization.CultureInfo.InvariantCulture, out var scale) &&
            scale >= 1.0 && scale <= 1000.0)
        {
            _timeScale = scale;
            Log("info", $"fake engine time scale = {scale:F0}×");
        }

        if (ArgValue(args, "--trace") is { } tracePath)
        {
            try
            {
                var full = Path.GetFullPath(tracePath);
                var directory = Path.GetDirectoryName(full);
                if (!string.IsNullOrEmpty(directory)) Directory.CreateDirectory(directory);
                // 追加 + FileShare.ReadWrite：验收场景会先后启动两个桩（重启验证持久化），
                // 两份 trace 必须累积在同一个文件里互为证据。
                var stream = new FileStream(full, FileMode.Append, FileAccess.Write, FileShare.ReadWrite);
                _trace = new StreamWriter(stream, new UTF8Encoding(false)) { AutoFlush = true };
                Log("info", $"trace -> {Path.GetFullPath(tracePath)}");
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                Log("error", $"cannot open trace file: {ex.Message}");
            }
        }

        // 任务书 A7：音量/模式从 %APPDATA%\RhineMusic\stub-state.json 恢复（壳侧 config 是另一份）。
        if (StubStateFile.Load() is (var storedVolume, var storedMode))
        {
            Engine.SetVolume(storedMode, storedVolume);
            Log("info", $"stub-state restored volume={storedVolume:F2} mode={storedMode}");
        }

        if (ArgValue(args, "--kill-after") is { } killText && int.TryParse(killText, out var killSeconds) && killSeconds > 0)
        {
            _ = Task.Run(async () =>
            {
                await Task.Delay(TimeSpan.FromSeconds(killSeconds)).ConfigureAwait(false);
                Log("warn", $"simulated crash after {killSeconds}s exit=7");
                Console.Out.Flush();
                Environment.Exit(7);
            });
        }

        _ = Task.Run(WatchStdin);

        Log("info", $"start pid={Environment.ProcessId} proto={Proto} caps=[{string.Join(",", Caps)}]");

        var backoff = new ReconnectBackoff();
        while (!Shutdown.IsCancellationRequested)
        {
            NamedPipeServerStream server;
            try
            {
                server = CreateServer(pipe);
            }
            catch (IOException ex)
            {
                Log("error", $"another core instance owns the pipe ({ex.Message}) exit=3");
                return 3;
            }

            try
            {
                Log("info", $"listening pipe={pipe}");
                await server.WaitForConnectionAsync(Shutdown.Token).ConfigureAwait(false);
                backoff.Reset();
                _connections++;
                Log("info", $"client connected conn={_connections}");
                var outcome = await Session(server).ConfigureAwait(false);
                if (outcome is SessionOutcome.Orderly)
                {
                    Log("info", "orderly shutdown exit=0");
                    return 0;
                }
            }
            catch (OperationCanceledException)
            {
                // stdin shutdown or process shutdown.
            }
            catch (IOException ex)
            {
                Log("warn", $"connection lost: {ex.Message}");
            }
            catch (Exception ex)
            {
                // 审查 P1-A：会话内未预期异常（帧字段越界已由 SafeString/Num 拦截，此为未知类型兜底）
                // 不得伪装成退出码 0——Session 的 finally 已 poison Shutdown，原地续命不可行；
                // 以非零码退出，让壳的崩溃重启监管（M1）看见真实崩溃。
                Log("error", $"session fault → exit 5: {ex.GetType().Name}: {ex.Message}");
                Console.Out.Flush();
                return 5;
            }
            finally
            {
                await server.DisposeAsync().ConfigureAwait(false);
            }
            if (Shutdown.IsCancellationRequested) break;
            var wait = backoff.Next();
            Log("info", $"listen again in {wait.TotalMilliseconds:F0}ms");
            try
            {
                await Task.Delay(wait, Shutdown.Token).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                break;
            }
        }

        Log("info", "stopped");
        _trace?.Dispose();
        return 0;
    }

    /// <summary>
    /// 协议 §10：仅当前用户 SID 可连 + 拒绝远程客户端。
    /// <see cref="PipeOptions.CurrentUserOnly"/> 同时给出「当前用户 DACL」与
    /// <c>PIPE_REJECT_REMOTE_CLIENTS</c>；不得与显式 <c>PipeSecurity</c> 同时传入（.NET 会抛异常）。
    /// </summary>
    private static NamedPipeServerStream CreateServer(string pipe) =>
        new(
            NormalizePipeName(pipe),
            PipeDirection.InOut,
            maxNumberOfServerInstances: 1,
            PipeTransmissionMode.Byte,
            PipeOptions.Asynchronous | PipeOptions.WriteThrough | PipeOptions.CurrentUserOnly,
            inBufferSize: 64 * 1024,
            outBufferSize: 64 * 1024);

    private static string NormalizePipeName(string pipe)
    {
        var name = pipe.Trim();
        const string prefix = @"\\.\pipe\";
        if (name.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) name = name[prefix.Length..];
        if (name.StartsWith(@"\\?\pipe\", StringComparison.OrdinalIgnoreCase)) name = name[@"\\?\pipe\".Length..];
        if (name.Length == 0) throw new ArgumentException("empty pipe name", nameof(pipe));
        return name;
    }

    private enum SessionOutcome
    {
        Closed,
        Orderly,
    }

    /// <summary>单连接会话：握手 → 帧循环（读任务 + 1Hz tick 事件任务）。</summary>
    private static async Task<SessionOutcome> Session(NamedPipeServerStream server)
    {
        using var reader = new StreamReader(server, Encoding.UTF8, detectEncodingFromByteOrderMarks: false, leaveOpen: true);
        using var writer = new StreamWriter(server, new UTF8Encoding(encoderShouldEmitUTF8Identifier: false), leaveOpen: true)
        {
            AutoFlush = true,
            NewLine = "\n",
        };
        _sessionWriter = writer;

        var send = new PipeSink(writer, WriteGate);

        // 协议 §4：3s 内未完成握手视为连接失败（壳会指数退避重连）。
        using var handshake = CancellationTokenSource.CreateLinkedTokenSource(Shutdown.Token);
        handshake.CancelAfter(TimeSpan.FromSeconds(3));

        var helloLine = await ReadLineAsync(reader, handshake.Token).ConfigureAwait(false);
        if (helloLine is null || !await Handshake(helloLine, send).ConfigureAwait(false))
        {
            if (helloLine is null && !Shutdown.IsCancellationRequested)
                Log("warn", "handshake timeout (3s) — closing connection");
            return SessionOutcome.Closed;
        }

        var events = PublishEvents(send);
        var spectrum = PublishSpectrum(send);
        var outcome = SessionOutcome.Closed;
        try
        {
            while (!Shutdown.IsCancellationRequested)
            {
                var line = await ReadLineAsync(reader, Shutdown.Token).ConfigureAwait(false);
                if (line is null) break;
                if (await HandleFrame(line, send).ConfigureAwait(false) is SessionOutcome.Orderly)
                {
                    outcome = SessionOutcome.Orderly;
                    break;
                }
            }
        }
        finally
        {
            _sessionWriter = null;
            Shutdown.Cancel();
            try
            {
                await events.ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                // expected on session end
            }

            try
            {
                await spectrum.ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                // expected on session end
            }
        }

        Log("info", "session ended");
        return outcome;
    }

    private static async Task<bool> Handshake(string line, PipeSink send)
    {
        var frame = Parse(line);
        if (frame is null || IpcType(frame) != "hello")
        {
            Log("warn", "first frame is not hello — closing connection");
            return false;
        }

        var peerProto = (int)(Num(frame, "proto") ?? Proto);
        var peerRole = Str(frame, "role") ?? "(none)";
        var peerCaps = frame["caps"] is JsonArray caps
            ? string.Join(",", caps.Select(c => c?.ToString() ?? string.Empty))
            : string.Empty;
        var effective = Math.Min(peerProto, Proto);

        if (effective != Proto)
        {
            await send.Send(new JsonObject
            {
                ["v"] = Proto,
                ["t"] = "err",
                ["error"] = new JsonObject
                {
                    ["code"] = "proto_mismatch",
                    ["message"] = $"peer proto {peerProto}, this core speaks {Proto}",
                    ["retryable"] = false,
                },
            }).ConfigureAwait(false);
            Log("error", $"proto mismatch peer={peerProto} — closing connection");
            return false;
        }

        // 协议 §4（v1.2）：每次 hello 成功应答自增会话世代 ep。
        var epoch = Interlocked.Increment(ref _epoch);
        Log("info", $"hello from role={peerRole} proto={peerProto} caps=[{peerCaps}] ep={epoch}");
        await send.Send(new JsonObject
        {
            ["v"] = Proto,
            ["t"] = "hello",
            ["role"] = "core",
            ["proto"] = Proto,
            ["ep"] = epoch,
            ["caps"] = new JsonArray(Caps.Select(c => (JsonNode)JsonValue.Create(c)!).ToArray()),
            ["app"] = App,
            ["ver"] = Ver,
        }).ConfigureAwait(false);

        // 协议 §9：断线重连必补发最新 state 快照（FakeEngine 跨连接保留状态，重连后 UI 立即一致）。
        await Emit(send, new EngineEvent("state", Engine.Snapshot())).ConfigureAwait(false);

        // 验收 4 的 halt 钩子：握手成功时刻开始暂停 evt 输出（--halt-events N 或 stdin 'halt N'）。
        if (_haltSeconds > 0)
        {
            Interlocked.Exchange(ref _haltUntilUptimeMs, Uptime.ElapsedMilliseconds + _haltSeconds * 1000L);
            Log("info", $"evt halted for {_haltSeconds}s (seq keeps burning, frames suppressed)");
        }

        return true;
    }

    private static async Task<SessionOutcome> HandleFrame(string line, PipeSink send)
    {
        var frame = Parse(line);
        if (frame is null)
        {
            // 协议 §10：对端非法帧的处理义务仅限不崩溃 + 丢弃 + 回 bad_request。
            Log("warn", "dropped unparsable frame");
            await send.Send(Error(null, "bad_request", "frame is not a JSON object", retryable: false)).ConfigureAwait(false);
            return SessionOutcome.Closed;
        }

        var type = IpcType(frame);
        if (_verbose) Log("debug", $"recv {type}");
        switch (type)
        {
            case "cmd":
                // 并发处理命令：**不能** 在读写循环里 `await HandleCommand`，否则人工延迟会把后续命令排成队。
                // 写路径经 `WriteGate` 串行，ack 靠 `id` 路由，不依赖到达顺序（M0 D3 结论沿用）。
                _ = RunCommandAsync(frame, send);
                break;
            case "bye":
                Log("info", $"bye reason={Str(frame, "reason") ?? "(none)"}");
                return SessionOutcome.Orderly;
            case "hello":
                Log("warn", "duplicate hello ignored");
                break;
            default:
                Log("warn", $"ignored unexpected frame t={type ?? "(none)"}");
                break;
        }

        return SessionOutcome.Closed;
    }

    /// <summary>后台执行一条命令；异常不得顶掉会话读循环。</summary>
    private static async Task RunCommandAsync(JsonObject frame, PipeSink send)
    {
        try
        {
            await HandleCommand(frame, send).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            // session ending
        }
        catch (IOException ex)
        {
            Log("warn", $"cmd write failed: {ex.Message}");
        }
        catch (Exception ex)
        {
            Log("error", $"cmd handler faulted: {ex.GetType().Name}: {ex.Message}");
        }
    }

    private static async Task HandleCommand(JsonObject frame, PipeSink send)
    {
        var id = Str(frame, "id");
        var cmd = Str(frame, "cmd");
        if (id is null || cmd is null)
        {
            await send.Send(Error(id, "bad_request", "cmd frame requires string fields id and cmd", retryable: false)).ConfigureAwait(false);
            return;
        }

        if (cmd == "echo")
        {
            // M0 回归：ack 原样回带 + 1–8ms 随机人工延迟（延迟直方图用）。不附加任何自加字段。
            var delay = Jitter.Next(1, 9);
            await Task.Delay(delay).ConfigureAwait(false);
            var payload = frame.TryGetPropertyValue("data", out var data) ? data?.DeepClone() : JsonValue.Create((string?)null);
            await send.Send(new JsonObject
            {
                ["v"] = Proto,
                ["t"] = "ack",
                ["id"] = id,
                ["result"] = new JsonObject { ["data"] = payload },
            }).ConfigureAwait(false);
            if (_verbose) Log("debug", $"ack id={id} cmd=echo artificial_delay_ms={delay}");
            return;
        }

        try
        {
            var (result, events) = Execute(cmd, frame);
            await send.Send(new JsonObject
            {
                ["v"] = Proto,
                ["t"] = "ack",
                ["id"] = id,
                ["result"] = result is null ? null : ToJson(result),
            }).ConfigureAwait(false);
            foreach (var engineEvent in events)
            {
                await Emit(send, engineEvent).ConfigureAwait(false);
            }

            Log("info", $"cmd ok id={id} cmd={cmd}");
        }
        catch (EngineBadRequest ex)
        {
            await send.Send(Error(id, "bad_request", ex.Message, retryable: false)).ConfigureAwait(false);
            Log("warn", $"bad_request id={id} cmd={cmd}: {ex.Message}");
        }
        catch (EngineNotImplemented ex)
        {
            // 协议 §5：未实现的 cmd 必须回 not_implemented，不得静默丢弃。
            await send.Send(Error(id, "not_implemented", ex.Message, retryable: false)).ConfigureAwait(false);
            Log("warn", $"not_implemented id={id} cmd={cmd}");
        }
    }

    /// <summary>
    /// 协议 §5 的 M1 命令集（engine.*）。返回 ack 的 result 与需要立刻补发的事件
    /// （任务书 A2：seek/volume/state 变更即时生效并立刻补发一帧 position+state）。
    /// </summary>
    private static (Dictionary<string, object?>? Result, List<EngineEvent> Events) Execute(string cmd, JsonObject frame)
    {
        var data = frame["data"] as JsonObject;
        switch (cmd)
        {
            case "engine.state":
                return (Engine.Snapshot(), []);
            case "engine.play":
            {
                var trackId = Str(data!, "track_id");
                if (string.IsNullOrEmpty(trackId))
                    throw new EngineBadRequest("engine.play requires a non-empty track_id");
                var duration = Num(data!, "duration_ms");
                var position = Num(data!, "position_ms");
                if (duration is < 1) throw new EngineBadRequest("duration_ms must be >= 1");
                if (position is < 0) throw new EngineBadRequest("position_ms must be >= 0");
                var events = Engine.Play(trackId, duration is null ? null : (long)duration.Value, position is null ? null : (long)position.Value);
                return (new Dictionary<string, object?> { ["stream_token"] = Engine.NextStreamToken() }, events);
            }
            case "engine.pause":
                return (PauseResume(Engine.Pause));
            case "engine.resume":
                return (PauseResume(Engine.Resume));
            case "engine.stop":
                return (PauseResume(Engine.Stop));
            case "engine.toggle":
                return (PauseResume(Engine.Toggle));
            case "engine.seek":
            {
                var position = Num(data!, "position_ms");
                if (position is null) throw new EngineBadRequest("engine.seek requires number position_ms");
                var (applied, events) = Engine.Seek((long)position.Value);
                return (
                    new Dictionary<string, object?> { ["applied_ms"] = applied },
                    events);
            }
            case "engine.volume":
            {
                var mode = Str(data!, "mode");
                if (mode is null) throw new EngineBadRequest("engine.volume requires string mode (fixed/hardware/integer/float)");
                var value = Num(data!, "value"); // 越界值由引擎按 §7 钳制（钳制失败才 bad_request）
                var (effectiveMode, effectiveValue, events) = Engine.SetVolume(mode, value);
                // A7：音量/模式持久化（写失败不影响命令成功）。
                StubStateFile.Save(effectiveValue, effectiveMode, message => Log("warn", message));
                return (
                    new Dictionary<string, object?>
                    {
                        ["effective"] = new Dictionary<string, object?> { ["mode"] = effectiveMode, ["value"] = effectiveValue },
                    },
                    events);
            }
            // M3/M4 能力先占名（§5）：一律 not_implemented，不得静默丢弃。
            case "devices.list" or "devices.select" or "output.mode" or "diag.get":
                throw new EngineNotImplemented($"cmd '{cmd}' is not implemented before M3/M4");
            case "engine.preload" or "engine.cancel_preload" or "engine.queue" or "config.get" or "config.set"
                or "library.scan" or "library.query" or "taskbar.set":
                throw new EngineNotImplemented($"cmd '{cmd}' is not implemented by this M1 stub");
            // 协议 §5/§6 v1.3（M3）：假谱订阅开关（与真核心同构 result）。
            case "spectrum.on" or "spectrum.off":
            {
                if (_spectrumDisabled)
                    throw new EngineNotImplemented($"cmd '{cmd}' is disabled by --no-spectrum");
                _spectrumOn = cmd == "spectrum.on";
                return (new Dictionary<string, object?> { ["enabled"] = _spectrumOn }, []);
            }
            default:
                throw new EngineNotImplemented($"cmd '{cmd}' is not implemented by this stub");
        }
    }

    /// <summary>pause/resume/stop/toggle 的共同形状：result={state}（协议 §5），事件=立刻补发的 state+position。</summary>
    private static (Dictionary<string, object?>, List<EngineEvent>) PauseResume(Func<List<EngineEvent>> action)
    {
        var events = action();
        return (new Dictionary<string, object?> { ["state"] = Engine.State.ToWire() }, events);
    }

    private static JsonObject Error(string? id, string code, string message, bool retryable)
    {
        var frame = new JsonObject
        {
            ["v"] = Proto,
            ["t"] = "err",
            ["error"] = new JsonObject
            {
                ["code"] = code,
                ["message"] = message,
                ["retryable"] = retryable,
            },
        };
        if (id is not null) frame["id"] = id;
        return frame;
    }

    /// <summary>把引擎的字典结果转 JsonNode（negotiated/badges 的 null 值必须保留——协议 §6 的显式豁免语义）。</summary>
    private static JsonNode? ToJson(object value) => value switch
    {
        IReadOnlyDictionary<string, object?> map => AsObject(map),
        _ => JsonValueOf(value) ?? JsonValue.Create((string?)null),
    };

    private static JsonObject AsObject(IReadOnlyDictionary<string, object?> map)
    {
        var obj = new JsonObject();
        foreach (var (key, value) in map) obj[key] = JsonValueOf(value);
        return obj;
    }

    private static JsonNode? JsonValueOf(object? value) => value switch
    {
        null => null,
        string s => JsonValue.Create(s),
        bool b => JsonValue.Create(b),
        int i => JsonValue.Create(i),
        long l => JsonValue.Create(l),
        double d => JsonValue.Create(d),
        List<string> list => new JsonArray(list.Select(s => (JsonNode)JsonValue.Create(s)!).ToArray()),
        // M3 假谱：bands 数组（64 个 0..1 数值，协议 §6 v1.3）。
        List<double> numbers => new JsonArray(numbers.Select(d => (JsonNode)JsonValue.Create(d)!).ToArray()),
        IReadOnlyDictionary<string, object?> map => AsObject(map),
        _ => throw new InvalidOperationException($"unsupported result type {value.GetType().Name}"),
    };

    /// <summary>
    /// 每秒 tick（任务书 A2）：发 evt{kind:"position"}；播完自动 evt{kind:"state",state:"stopped"}。
    /// 与命令补发帧共用 <see cref="Emit"/>，seq 单调、ep 恒为当前会话世代。
    /// 注：<c>--time-scale N</c> 只缩放引擎虚拟时钟，**tick 保持真实 1Hz**——
    /// 否则“窗长缩短 + 帧密提升”两种加速叠加会使末帧位置超出曲长（与曲终断言冲突）。
    /// </summary>
    private static async Task PublishEvents(PipeSink send)
    {
        while (!Shutdown.IsCancellationRequested)
        {
            await Task.Delay(TimeSpan.FromSeconds(1), Shutdown.Token).ConfigureAwait(false);
            foreach (var engineEvent in Engine.Tick())
            {
                await Emit(send, engineEvent).ConfigureAwait(false);
            }
        }
    }

    /// <summary>
    /// M3 假谱的 30Hz 发布（协议 §6 v1.3）：仅 spectrum.on 后发帧，off 立即停发；
    /// 与 1Hz tick 共用 <see cref="Emit"/>（seq 同一条进程内单调线、写入经 WriteGate 串行）。
    /// </summary>
    private static async Task PublishSpectrum(PipeSink send)
    {
        var period = TimeSpan.FromMilliseconds(33);
        var next = DateTime.UtcNow + period;
        while (!Shutdown.IsCancellationRequested)
        {
            // 审查 M-4 修复：并行负载下单次 Delay 可超时 33ms，next 落后于 now 时
            // (next - UtcNow) 为负 → Task.Delay 抛 ArgumentOutOfRangeException 杀死发布循环
            // （实测：spectrum 8 帧后静默停发）。到期时间钳非负；漂移复位逻辑保留在下行。
            var due = next - DateTime.UtcNow;
            if (due < TimeSpan.Zero) { due = TimeSpan.Zero; }
            await Task.Delay(due, Shutdown.Token).ConfigureAwait(false);
            next += period;
            if (DateTime.UtcNow - next > TimeSpan.FromMilliseconds(200)) next = DateTime.UtcNow + period;
            if (!_spectrumOn) continue;
            await Emit(send, new EngineEvent("spectrum", FakeSpectrumPayload())).ConfigureAwait(false);
        }
    }

    /// <summary>
    /// 假谱 payload（与真核心 AnalyzeFrame 同形：bands_l/bands_r 各 64、4 位小数、
    /// low/mid/high/activity/beat_phase）——合成参数见 docs/M3-FINDINGS.md §3：
    /// 1.7Hz 上行宽波 + 逐带相位差（L/R 错相 0.6 rad）+ ±0.03 页内噪声 + 高频轻微衰减，
    /// beat_phase = (uptime × 2Hz) mod 1。仅用于无真核心时演示链路，不代表音频事实。
    /// </summary>
    private static IReadOnlyDictionary<string, object?> FakeSpectrumPayload()
    {
        const int bands = 64;
        var t = Uptime.Elapsed.TotalSeconds;
        var left = new double[bands];
        var right = new double[bands];
        double Q(double v) => Math.Round(Math.Clamp(v, 0d, 1d), 4, MidpointRounding.AwayFromZero);
        for (var i = 0; i < bands; i++)
        {
            var weight = 1.0 / (1.0 + i * 0.03);
            var sweep = Math.Max(0.0, Math.Sin(2 * Math.PI * 1.7 * t - i * 0.18));
            left[i] = Q(0.10 + 0.55 * sweep * weight + (Random.Shared.NextDouble() - 0.5) * 0.06);
            right[i] = Q(0.10 + 0.55 * Math.Max(0.0, Math.Sin(2 * Math.PI * 1.7 * t - i * 0.18 + 0.6)) * weight +
                         (Random.Shared.NextDouble() - 0.5) * 0.06);
        }

        double Rms(int from, int to)
        {
            var sum = 0.0;
            for (var i = from; i < to; i++)
            {
                var mean = (left[i] + right[i]) / 2;
                sum += mean * mean;
            }

            return Q(Math.Sqrt(sum / (to - from)));
        }

        var activity = 0.0;
        for (var i = 0; i < bands; i++) activity += (left[i] + right[i]) / 2;
        return new Dictionary<string, object?>
        {
            ["bands_l"] = left.Select(Q).ToList(),
            ["bands_r"] = right.Select(Q).ToList(),
            ["low"] = Rms(0, 8),
            ["mid"] = Rms(8, 32),
            ["high"] = Rms(32, bands),
            ["activity"] = Q(activity / bands),
            ["beat_phase"] = Q(t * 2.0 % 1.0),
        };
    }

    /// <summary>统一出口：seq 进程内单调（§6）、ep 会话世代（v1.2）、halt 窗口内只烧 seq 不发帧。</summary>
    private static async Task Emit(PipeSink send, EngineEvent engineEvent)
    {
        var seq = Interlocked.Increment(ref _sequence);
        var halted = Uptime.ElapsedMilliseconds < Interlocked.Read(ref _haltUntilUptimeMs);
        if (halted)
        {
            Log("warn", $"evt {engineEvent.Kind} seq={seq} suppressed by --halt-events window (burned for loss detection)");
            return;
        }

        await send.Send(new JsonObject
        {
            ["v"] = Proto,
            ["t"] = "evt",
            ["seq"] = seq,
            ["ep"] = Epoch,
            ["evt"] = engineEvent.Kind,
            ["data"] = ToJson((object)engineEvent.Data),
            ["ts"] = IpcFrame.NowMs(),
        }).ConfigureAwait(false);
        Trace(seq, engineEvent);
        if (_verbose) Log("debug", $"evt {engineEvent.Kind} seq={seq} ep={Epoch}");
    }

    /// <summary>trace 行不是协议帧：一行一条，只含 kind + seq + data（验收 2 的位置推进证据）。
    /// M3：spectrum 是 30Hz 高频数据帧，不进 trace（防证据文件膨胀；冒烟断言直接读管道帧）。</summary>
    private static void Trace(long seq, EngineEvent engineEvent)
    {
        if (_trace is null) return;
        if (engineEvent.Kind == "spectrum") return;
        try
        {
            var data = AsObject(engineEvent.Data);
            _trace.WriteLine($"{DateTime.Now:HH:mm:ss.fff} evt={engineEvent.Kind} seq={seq} ep={Epoch} data={data.ToJsonString(IpcFrame.Json)}");
        }
        catch (IOException ex)
        {
            Log("warn", $"trace write failed: {ex.Message}");
        }
    }

    private static async Task WatchStdin()
    {
        try
        {
            while (await Console.In.ReadLineAsync(Shutdown.Token).ConfigureAwait(false) is { } line)
            {
                var text = line.Trim();
                if (text.StartsWith("halt", StringComparison.OrdinalIgnoreCase))
                {
                    // 运行中触发丢帧窗口：'halt 5' = 暂停 evt 输出 5 秒（验收 4 用，免重启进程）。
                    if (int.TryParse(text[4..].Trim(), out var seconds) && seconds > 0)
                    {
                        Interlocked.Exchange(ref _haltUntilUptimeMs, Uptime.ElapsedMilliseconds + seconds * 1000L);
                        Log("info", $"evt halted for {seconds}s via stdin");
                    }

                    continue;
                }

                if (text.ToLowerInvariant() is not ("exit" or "bye")) continue;

                // 有序退出：先向对端发 bye（协议 §3），再结束会话与进程。
                if (_sessionWriter is { } writer)
                {
                    var frame = new JsonObject { ["v"] = Proto, ["t"] = "bye", ["reason"] = "stdin" };
                    await WriteGate.WaitAsync().ConfigureAwait(false);
                    try
                    {
                        await writer.WriteLineAsync(frame.ToJsonString(IpcFrame.Json)).ConfigureAwait(false);
                        await writer.FlushAsync().ConfigureAwait(false);
                    }
                    catch (IOException)
                    {
                        // peer already gone
                    }
                    finally
                    {
                        WriteGate.Release();
                    }
                }

                Log("info", $"stdin '{text}' — orderly shutdown");
                Shutdown.Cancel();
                return;
            }
        }
        catch (OperationCanceledException)
        {
            // process is shutting down
        }
        catch (InvalidOperationException)
        {
            // stdin is not available (detached); nothing to watch
        }
    }

    private static async Task<string?> ReadLineAsync(StreamReader reader, CancellationToken token)
    {
        try
        {
            return await reader.ReadLineAsync(token).ConfigureAwait(false);
        }
        catch (IOException)
        {
            return null;
        }
        catch (OperationCanceledException)
        {
            return null;
        }
    }

    private static JsonObject? Parse(string line) => IpcFrame.ParseObject(line);

    // 审查 P1-A：对端帧字段类型越界（合法 JSON 但 t 非字符串/proto 非数字等）不得抛
    // InvalidOperationException 穿栈；按协议 §10 降级为“丢弃该帧/默认值”，不崩溃。
    // 任务书铁律：对端帧取值全部走 SafeString 族（d0a8acc 已立规范），新增命令解析同样走它。
    private static string? IpcType(JsonObject frame) => SafeString(frame["t"]);

    private static string? Str(JsonObject? frame, string name) => frame is null ? null : SafeString(frame[name]);

    private static double? Num(JsonObject? frame, string name)
    {
        if (frame is null) return null;
        try { return frame[name]?.GetValue<double>(); }
        catch (InvalidOperationException) { return null; }
    }

    private static string? SafeString(JsonNode? node)
    {
        try { return node?.GetValue<string>(); }
        catch (InvalidOperationException) { return null; }
        catch (JsonException) { return null; }
    }

    private static string? ArgValue(string[] args, string name)
    {
        var index = Array.IndexOf(args, name);
        return index >= 0 && index + 1 < args.Length ? args[index + 1] : null;
    }

    private static void Log(string level, string message)
    {
        var stamp = DateTime.Now.ToString("HH:mm:ss.fff", System.Globalization.CultureInfo.InvariantCulture);
        Console.WriteLine($"[core][{stamp}] {level} {message} uptime={Uptime.ElapsedMilliseconds}ms");
    }

    private static void TryUseUtf8Console()
    {
        try
        {
            Console.OutputEncoding = new UTF8Encoding(false);
        }
        catch (IOException)
        {
            // stdout redirected to a file/host that refuses reconfiguration
        }
    }

    /// <summary>管道写入串行化：多个任务共享同一 StreamWriter。</summary>
    private sealed class PipeSink(StreamWriter writer, SemaphoreSlim gate)
    {
        public async Task Send(JsonObject frame)
        {
            var line = frame.ToJsonString(IpcFrame.Json);
            await gate.WaitAsync(Shutdown.Token).ConfigureAwait(false);
            try
            {
                await writer.WriteLineAsync(line).ConfigureAwait(false);
                await writer.FlushAsync(Shutdown.Token).ConfigureAwait(false);
            }
            finally
            {
                gate.Release();
            }
        }
    }

    /// <summary>监听循环的重试退避（协议 §4：指数退避，封顶 5s）。</summary>
    private sealed class ReconnectBackoff
    {
        private int _step;

        public TimeSpan Next()
        {
            var ms = Math.Min(500 * Math.Pow(2, _step), 5000);
            _step = Math.Min(_step + 1, 6);
            return TimeSpan.FromMilliseconds(ms);
        }

        public void Reset() => _step = 0;
    }
}
