using System.Diagnostics;
using System.IO.Pipes;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using RhineShared;

namespace RhineCoreStub;

/// <summary>
/// M0 音频核心桩：冒充将来的 C++ + miniaudio 核心，只实现 <c>docs/IPC-PROTOCOL.md</c> v1
/// 在 M0 声明的最小集（hello / echo / 1Hz state evt / bye），用于验证壳与前端桥的往返链路。
///
/// 协议纪律：**不得自加字段**。任何新增消息或字段都必须先改协议文档。
/// 命令行：<c>RhineCoreStub [--pipe &lt;name&gt;] [--kill-after &lt;sec&gt;] [--verbose]</c>
/// 环境变量：<c>RHINE_CORE_PIPE</c>（协议 §1 的 core.pipe 覆盖项）
/// 退出码：0 = 有序退出（收到 bye 或 stdin exit/bye）；3 = 已有核心实例占用管道；7 = --kill-after 模拟崩溃。
/// </summary>
internal static class Program
{
    private const string DefaultPipe = @"\\.\pipe\rhine-music.core.v1";
    private const int Proto = 1;
    private const string App = "rhine-music-player";
    private const string Ver = "0.1.0";

    /// <summary>协议 §4：M0 打桩核心只声明 echo。</summary>
    private static readonly string[] Caps = ["echo"];

    private static readonly CancellationTokenSource Shutdown = new();
    private static readonly SemaphoreSlim WriteGate = new(1, 1);

    private static readonly Random Jitter = new();
    private static readonly Stopwatch Uptime = Stopwatch.StartNew();

    private static bool _verbose;
    private static long _sequence;
    private static int _connections;
    private static volatile StreamWriter? _sessionWriter;

    private static async Task<int> Main(string[] args)
    {
        TryUseUtf8Console();

        if (args.Contains("--help") || args.Contains("-h"))
        {
            Console.WriteLine("RhineCoreStub — M0 core stub (IPC protocol v1)");
            Console.WriteLine("  --pipe <name>       named pipe (default: \\\\.\\pipe\\rhine-music.core.v1)");
            Console.WriteLine("  --kill-after <sec>  simulate a crash after N seconds (exit code 7)");
            Console.WriteLine("  --verbose           log every frame");
            Console.WriteLine("  stdin: 'exit' or 'bye' => orderly shutdown");
            return 0;
        }

        _verbose = args.Contains("--verbose");

        var pipe = ArgValue(args, "--pipe")
            ?? Environment.GetEnvironmentVariable("RHINE_CORE_PIPE")
            ?? DefaultPipe;

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

    /// <summary>单连接会话：握手 → 帧循环（读任务 + 1Hz 事件任务）。</summary>
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

        Log("info", $"hello from role={peerRole} proto={peerProto} caps=[{peerCaps}]");
        await send.Send(new JsonObject
        {
            ["v"] = Proto,
            ["t"] = "hello",
            ["role"] = "core",
            ["proto"] = Proto,
            ["caps"] = new JsonArray(Caps.Select(c => (JsonNode)JsonValue.Create(c)!).ToArray()),
            ["app"] = App,
            ["ver"] = Ver,
        }).ConfigureAwait(false);
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
                await HandleCommand(frame, send).ConfigureAwait(false);
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
            // 任务书：ack 原样回带 + 1–8ms 随机人工延迟（延迟直方图用）。不附加任何自加字段。
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

        // 协议 §5：未实现的 cmd 必须回 not_implemented，不得静默丢弃。
        await send.Send(Error(id, "not_implemented", $"cmd '{cmd}' is not implemented by this M0 stub", retryable: false)).ConfigureAwait(false);
        Log("warn", $"not_implemented id={id} cmd={cmd}");
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

    /// <summary>协议 §6：每 1s 推 evt{evt:"state", seq 递增}。连接期间持续，断线即停。</summary>
    private static async Task PublishEvents(PipeSink send)
    {
        while (!Shutdown.IsCancellationRequested)
        {
            await Task.Delay(TimeSpan.FromSeconds(1), Shutdown.Token).ConfigureAwait(false);
            var seq = Interlocked.Increment(ref _sequence);
            await send.Send(new JsonObject
            {
                ["v"] = Proto,
                ["t"] = "evt",
                ["seq"] = seq,
                ["evt"] = "state",
                ["data"] = new JsonObject
                {
                    ["state"] = "idle",
                    ["stub"] = true,
                },
            }).ConfigureAwait(false);
            if (_verbose) Log("debug", $"evt state seq={seq}");
        }
    }

    private static async Task WatchStdin()
    {
        try
        {
            while (await Console.In.ReadLineAsync(Shutdown.Token).ConfigureAwait(false) is { } line)
            {
                var text = line.Trim().ToLowerInvariant();
                if (text is not ("exit" or "bye")) continue;

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

    private static string? IpcType(JsonObject frame) => frame["t"]?.GetValue<string>();

    private static string? Str(JsonObject frame, string name) => frame[name]?.GetValue<string>();

    private static double? Num(JsonObject frame, string name) => frame[name]?.GetValue<double>();

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
