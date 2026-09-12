using System.Collections.Concurrent;
using System.IO;
using System.IO.Pipes;
using System.Text;
using System.Text.Json.Nodes;
using RhineShared;

namespace RhineShell.Hosting;

public enum ChannelState
{
    Connecting,
    Handshaking,
    Ready,
    Disconnected,
}

/// <summary>
/// 壳 ↔ 核心 的命名管道客户端（<c>docs/IPC-PROTOCOL.md</c> §1/§4/§9）。
///
/// 职责：
/// <list type="bullet">
/// <item>JSON Lines 收发（单行 ≤64KB，UTF-8，`\n` 结尾），写路径全局串行；</item>
/// <item>连接首帧发 <c>hello</c>，3s 内未收到对端 <c>hello</c> 视为失败；</item>
/// <item>断线指数退避重连（封顶 5s）；</item>
/// <item>请求 id 路由：<c>ack</c>/<c>err</c> 回填对应 pending，其余为事件；</item>
/// <item>缓存最近一份 <c>evt{evt:"state"}</c> 供页面重载后重放（§9）。</item>
/// </list>
///
/// 本类**不实现任何 cmd 语义**，只做传输与生命周期；命令语义在核心。
/// </summary>
public sealed class ShellChannel : IAsyncDisposable
{
    private const int ConnectTimeoutMs = 3000;
    private const int Proto = 1;
    private const string App = "rhine-music-player";
    private const string Ver = "0.1.0";

    /// <summary>协议 §4：壳声明的能力。M0 只用到 cmd 与 state/position 事件的转发。</summary>
    private static readonly string[] ShellCaps = ["cmd", "evt.state", "evt.position", "smtc"];

    private readonly string _pipeName;
    private readonly CancellationTokenSource _shutdown = new();
    private readonly ConcurrentDictionary<string, PendingRequest> _pending = new();
    private readonly SemaphoreSlim _writeGate = new(1, 1);
    private readonly TimeSpan _commandTimeout;

    private Task? _loop;
    private StreamWriter? _writer;
    private volatile ChannelState _state = ChannelState.Disconnected;
    private int _attempt;
    private long _sent;
    private long _received;

    public ShellChannel(string pipeName, TimeSpan? commandTimeout = null)
    {
        _pipeName = pipeName;
        _commandTimeout = commandTimeout ?? TimeSpan.FromSeconds(10);
    }

    public ChannelState State => _state;

    /// <summary>最近一次对端 <c>hello</c>（未握手为 null）。</summary>
    public JsonObject? RemoteHello { get; private set; }

    /// <summary>最近一份 <c>evt{evt:"state"}</c> 快照，用于页面重载重放（协议 §9）。</summary>
    public JsonObject? LatestState { get; private set; }

    /// <summary>最近一次连接错误（诊断显示用）。</summary>
    public string? LastError { get; private set; }

    public long FramesSent => Interlocked.Read(ref _sent);

    public long FramesReceived => Interlocked.Read(ref _received);

    /// <summary>收到核心发来的事件帧（<c>evt</c>）与握手帧（<c>hello</c>）。</summary>
    public event Action<JsonObject>? FrameReceived;

    public event Action<ChannelState>? StateChanged;

    public void Start() => _loop ??= Task.Run(() => RunAsync(_shutdown.Token));

    /// <summary>壳退出前发 <c>bye</c>（协议 §9）并停掉重连循环。</summary>
    public async Task ShutdownAsync(string reason)
    {
        if (!_shutdown.IsCancellationRequested)
        {
            try
            {
                await SendFrameAsync(new JsonObject
                {
                    ["v"] = Proto,
                    ["t"] = "bye",
                    ["reason"] = reason,
                }).ConfigureAwait(false);
            }
            catch (IOException)
            {
                // 对端已走
            }
            catch (ObjectDisposedException)
            {
                // 连接已断，bye 无处可发
            }
            catch (InvalidOperationException)
            {
                // 尚未建立连接
            }
        }

        _shutdown.Cancel();
        FailPending("disconnected", "shell is shutting down", retryable: true);
        if (_loop is { } loop)
        {
            try
            {
                await loop.ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                // expected
            }
        }
    }

    public async ValueTask DisposeAsync()
    {
        await ShutdownAsync("shell-exit").ConfigureAwait(false);
        _writeGate.Dispose();
        _shutdown.Dispose();
    }

    /// <summary>
    /// 发送一条 <c>cmd</c> 并等待 <c>ack</c>/<c>err</c>。
    /// 未握手 / 未连接 / 超时都会得到一条**壳侧生成的 <c>err</c> 帧**（不抛异常），
    /// 由 Bridge 原样转发给前端；错误码 <c>disconnected</c> 与 <c>timeout</c> 见 M0-FINDINGS。
    /// </summary>
    public async Task<JsonObject> SendCommandAsync(string id, JsonObject command, CancellationToken token)
    {
        if (_state != ChannelState.Ready)
        {
            return ErrorFrame(id, "disconnected",
                $"core channel is {_state.ToString().ToLowerInvariant()}", retryable: true);
        }

        var pending = new PendingRequest();
        if (!_pending.TryAdd(id, pending))
        {
            return ErrorFrame(id, "bad_request", $"duplicate request id '{id}'", retryable: false);
        }

        try
        {
            var frame = new JsonObject
            {
                ["v"] = Proto,
                ["t"] = "cmd",
                ["id"] = id,
                ["cmd"] = command["cmd"]?.GetValue<string>(),
            };
            if (command["data"] is { } data) frame["data"] = data.DeepClone();

            try
            {
                await SendFrameAsync(frame).ConfigureAwait(false);
            }
            catch (Exception ex) when (ex is IOException or InvalidOperationException or ObjectDisposedException or OperationCanceledException)
            {
                return FailOne(id, "disconnected", $"core pipe write failed: {ex.Message}", retryable: true);
            }

            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(token, _shutdown.Token);
            timeout.CancelAfter(_commandTimeout);
            try
            {
                return await pending.Completion.Task.WaitAsync(timeout.Token).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                return FailOne(id, "timeout", $"core did not answer within {_commandTimeout.TotalMilliseconds:F0}ms", retryable: true);
            }
        }
        finally
        {
            _pending.TryRemove(id, out _);
        }
    }

    private static JsonObject ErrorFrame(string? id, string code, string message, bool retryable)
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

    private static JsonObject FailOne(string id, string code, string message, bool retryable) =>
        ErrorFrame(id, code, message, retryable);

    private void FailPending(string code, string message, bool retryable)
    {
        foreach (var (id, pending) in _pending)
        {
            if (_pending.TryRemove(id, out _)) pending.TrySetResult(ErrorFrame(id, code, message, retryable));
        }
    }

    private async Task SendFrameAsync(JsonObject frame)
    {
        var writer = _writer ?? throw new InvalidOperationException("no active core connection");
        var line = frame.ToJsonString(IpcFrame.Json);
        await _writeGate.WaitAsync(_shutdown.Token).ConfigureAwait(false);
        try
        {
            await writer.WriteLineAsync(line).ConfigureAwait(false);
            await writer.FlushAsync(_shutdown.Token).ConfigureAwait(false);
            Interlocked.Increment(ref _sent);
        }
        finally
        {
            _writeGate.Release();
        }
    }

    private void SetState(ChannelState next)
    {
        if (_state == next) return;
        _state = next;
        try
        {
            StateChanged?.Invoke(next);
        }
        catch (Exception ex)
        {
            Log.Warn($"StateChanged handler threw: {ex.Message}");
        }
    }

    /// <summary>连接循环：连上 → 握手 → 读帧；任何异常都退化为「断开 + 退避重连」。</summary>
    private async Task RunAsync(CancellationToken token)
    {
        while (!token.IsCancellationRequested)
        {
            SetState(ChannelState.Connecting);
            try
            {
                await using var pipe = new NamedPipeClientStream(
                    ".", PipeNameOnly(_pipeName), PipeDirection.InOut, PipeOptions.Asynchronous);
                await pipe.ConnectAsync(ConnectTimeoutMs, token).ConfigureAwait(false);

                using var reader = new StreamReader(pipe, Encoding.UTF8, detectEncodingFromByteOrderMarks: false, leaveOpen: true);
                using var writer = new StreamWriter(pipe, new UTF8Encoding(encoderShouldEmitUTF8Identifier: false), leaveOpen: true)
                {
                    AutoFlush = true,
                    NewLine = "\n",
                };

                _writer = writer;
                SetState(ChannelState.Handshaking);

                if (!await HandshakeAsync(reader, writer, token).ConfigureAwait(false))
                {
                    LastError = "handshake timed out (3s)";
                    Log.Warn($"{LastError} — reconnecting");
                }
                else
                {
                    _attempt = 0;
                    LastError = null;
                    SetState(ChannelState.Ready);
                    Log.Info($"core ready caps=[{string.Join(",", Caps(RemoteHello))}]");
                    await ReadLoopAsync(reader, token).ConfigureAwait(false);
                }
            }
            catch (OperationCanceledException) when (token.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex) when (ex is IOException or TimeoutException or UnauthorizedAccessException)
            {
                LastError = ex.Message;
                Log.Warn($"core connection failed: {ex.Message}");
            }
            finally
            {
                if (_writer is { } w)
                {
                    try
                    {
                        await w.DisposeAsync().ConfigureAwait(false);
                    }
                    catch (IOException)
                    {
                        // 对端已关闭
                    }
                    catch (ObjectDisposedException)
                    {
                        // 底层管道句柄已随 using pipe 关闭，Dispose 的尾部 flush 必然失败：忽略。
                    }
                }

                _writer = null;
                RemoteHello = null;
                LatestState = null; // 审查 P1-B：陈旧快照不得跨核心生命周期重放（新实例 seq 从 1 重新开始）；
                                    // 重连后等新 state 到达（桩 1Hz）再重放。
                SetState(ChannelState.Disconnected);
                FailPending("disconnected", "core connection lost", retryable: true);
            }

            if (token.IsCancellationRequested) break;

            var backoff = Backoff();
            Log.Info($"core reconnect in {backoff.TotalMilliseconds:F0}ms attempt={_attempt}");
            try
            {
                await Task.Delay(backoff, token).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                break;
            }
        }

        SetState(ChannelState.Disconnected);
    }

    /// <summary>协议 §4：壳作为连接建立方发 hello，3s 内须收到对端同构 hello。</summary>
    private async Task<bool> HandshakeAsync(StreamReader reader, StreamWriter writer, CancellationToken token)
    {
        var hello = new JsonObject
        {
            ["v"] = Proto,
            ["t"] = "hello",
            ["role"] = "shell",
            ["proto"] = Proto,
            ["caps"] = new JsonArray(ShellCaps.Select(c => (JsonNode)JsonValue.Create(c)!).ToArray()),
            ["app"] = App,
            ["ver"] = Ver,
        };
        var line = hello.ToJsonString(IpcFrame.Json);
        await _writeGate.WaitAsync(token).ConfigureAwait(false);
        try
        {
            await writer.WriteLineAsync(line).ConfigureAwait(false);
            await writer.FlushAsync(token).ConfigureAwait(false);
            Interlocked.Increment(ref _sent);
        }
        finally
        {
            _writeGate.Release();
        }

        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(token, _shutdown.Token);
        timeout.CancelAfter(TimeSpan.FromMilliseconds(ConnectTimeoutMs));
        while (!timeout.IsCancellationRequested)
        {
            string? incoming;
            try
            {
                incoming = await reader.ReadLineAsync(timeout.Token).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                return false;
            }

            if (incoming is null) return false;
            var frame = IpcFrame.ParseObject(incoming);
            if (frame is null)
            {
                Log.Warn("dropped unparsable frame during handshake");
                continue;
            }

            Interlocked.Increment(ref _received);
            if (frame["t"]?.GetValue<string>() != "hello")
            {
                // 握手前的非 hello 帧（含核心抢发的 err）按 §10 丢弃并记录
                Log.Warn($"ignored t={frame["t"]?.GetValue<string>() ?? "(none)"} before handshake");
                continue;
            }

            var peerProto = (int)(frame["proto"]?.GetValue<double>() ?? Proto);
            if (Math.Min(peerProto, Proto) != Proto)
            {
                LastError = $"proto mismatch (peer {peerProto})";
                return false;
            }

            RemoteHello = frame;
            RaiseFrame(frame);
            return true;
        }

        return false;
    }

    /// <summary>协议 §9：连接期内持续读帧；EOF 即断开。</summary>
    private async Task ReadLoopAsync(StreamReader reader, CancellationToken token)
    {
        while (!token.IsCancellationRequested)
        {
            var line = await reader.ReadLineAsync(token).ConfigureAwait(false);
            if (line is null) return;

            var frame = IpcFrame.ParseObject(line);
            if (frame is null)
            {
                Log.Warn("dropped unparsable frame");
                continue;
            }

            Interlocked.Increment(ref _received);
            Route(frame);
        }
    }

    private void Route(JsonObject frame)
    {
        var type = frame["t"]?.GetValue<string>();
        switch (type)
        {
            case "ack":
            case "err":
                if (Id(frame) is { } id && _pending.TryRemove(id, out var pending))
                {
                    pending.TrySetResult(frame);
                    return;
                }

                Log.Warn($"orphan {type} id={Id(frame) ?? "(none)"}");
                RaiseFrame(frame);
                return;
            case "evt":
                if (frame["evt"]?.GetValue<string>() == "state")
                {
                    // 协议 §6：state 例外，壳做可靠合并（后值覆盖），断线重连必补发最新快照。
                    LatestState = (JsonObject)frame.DeepClone();
                }

                RaiseFrame(frame);
                return;
            case "log":
                // 协议 §3/§6：核心日志不转发前端，只进壳日志。
                Log.Info($"core log level={frame["level"]?.GetValue<string>() ?? "?"} msg={frame["msg"]?.GetValue<string>() ?? ""}");
                return;
            case "bye":
                Log.Info($"core said bye reason={frame["reason"]?.GetValue<string>() ?? "(none)"}");
                RaiseFrame(frame);
                return;
            default:
                Log.Warn($"ignored unexpected frame t={type ?? "(none)"}");
                return;
        }
    }

    private void RaiseFrame(JsonObject frame)
    {
        try
        {
            FrameReceived?.Invoke(frame);
        }
        catch (Exception ex)
        {
            Log.Warn($"FrameReceived handler threw: {ex.Message}");
        }
    }

    private static string? Id(JsonObject frame) => frame["id"]?.GetValue<string>();

    private static IEnumerable<string> Caps(JsonObject? hello) =>
        hello?["caps"] is JsonArray caps ? caps.Select(c => c?.ToString() ?? string.Empty) : [];

    /// <summary>协议 §4/§9：指数退避，封顶 5s。</summary>
    private TimeSpan Backoff()
    {
        var ms = Math.Min(500 * Math.Pow(2, _attempt), 5000);
        _attempt = Math.Min(_attempt + 1, 6);
        return TimeSpan.FromMilliseconds(ms);
    }

    private static string PipeNameOnly(string pipe)
    {
        var name = pipe.Trim();
        const string prefix = @"\\.\pipe\";
        if (name.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) name = name[prefix.Length..];
        return name.Length == 0 ? "rhine-music.core.v1" : name;
    }

    private sealed class PendingRequest
    {
        public TaskCompletionSource<JsonObject> Completion { get; } =
            new(TaskCreationOptions.RunContinuationsAsynchronously);

        public void TrySetResult(JsonObject frame) => Completion.TrySetResult(frame);
    }
}
