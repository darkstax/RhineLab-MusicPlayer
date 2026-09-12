using System.Text.Json.Nodes;
using System.Windows.Threading;
using Microsoft.Web.WebView2.Wpf;
using RhineShared;

namespace RhineShell.Hosting;

/// <summary>
/// 前端 ↔ 壳 的转发网关（<c>docs/IPC-PROTOCOL.md</c> §1：壳是前端的唯一特权网关）。
///
/// <list type="bullet">
/// <item>WebView2 <c>WebMessageReceived</c> → 解析 → 壳自身处理的 <c>hello</c>/<c>ping</c> / 转发 <c>cmd</c> 给核心；</item>
/// <item>核心 <c>evt</c>/<c>hello</c> → <c>PostWebMessageAsJson</c> 推给前端；</item>
/// <item>页面（重新）加载后重放 <c>hello</c> + 最新 <c>evt{state}</c> 快照（§9）；</item>
/// <item>壳侧生成的错误帧与核心来的 <c>ack</c>/<c>err</c> 同形，前端只写一条处理路径。</item>
/// </list>
///
/// M0 的 <c>cmd=ping</c> 本地自答是 **dev-only** 演示链路（未进协议表），
/// M1 接入真实核心时随 <see cref="DevOnlyPing"/> 一并删除。
/// </summary>
public sealed class Bridge
{
    /// <summary>搜索这个常量即可定位所有 dev-only ping 代码。</summary>
    public const string DevOnlyPing = "dev-only:m0";

    private readonly ShellChannel _channel;
    private readonly Dispatcher _dispatcher = Dispatcher.CurrentDispatcher;
    private readonly Action<JsonObject> _post;

    public Bridge(ShellChannel channel, Action<JsonObject> post)
    {
        _channel = channel;
        _post = post;
        _channel.FrameReceived += OnCoreFrame;
    }

    public void Detach() => _channel.FrameReceived -= OnCoreFrame;

    /// <summary>页面加载完成：先补 hello，再重放最新 state 快照（协议 §9）。</summary>
    public void ReplayToFrontend()
    {
        var hello = ShellHello();
        AttachRuntime(hello, negotiated: null);
        Post(hello);

        if (_channel.LatestState is { } snapshot) Post((JsonObject)snapshot.DeepClone());
    }

    /// <summary>核心推送 → 前端。握手帧与事件帧统一走这条路。</summary>
    private void OnCoreFrame(JsonObject frame) =>
        _dispatcher.InvokeAsync(() => Post(frame)).Task.ContinueWith(
            task => Log.Warn($"post to frontend failed: {task.Exception?.GetBaseException().Message}"),
            TaskContinuationOptions.OnlyOnFaulted);

    /// <summary>处理一条来自前端的字符串消息（协议 §10：先 parse try-catch 再入状态机）。</summary>
    public void OnWebMessage(string raw)
    {
        var frame = IpcFrame.ParseObject(raw);
        if (frame is null)
        {
            Log.Warn("dropped unparsable frame from frontend");
            Post(ErrorFrame(null, "bad_request", "frame is not a JSON object"));
            return;
        }

        switch (frame["t"]?.GetValue<string>())
        {
            case "hello":
                Log.Info("frontend hello");
                Post(HelloAck(frame));
                return;
            case "cmd":
                _ = HandleCommandAsync(frame);
                return;
            case "bye":
                Log.Info($"frontend bye reason={frame["reason"]?.GetValue<string>() ?? "(none)"}");
                return;
            default:
                Log.Warn($"ignored frame from frontend t={frame["t"]?.GetValue<string>() ?? "(none)"}");
                return;
        }
    }

    private JsonObject HelloAck(JsonObject request)
    {
        var reply = ShellHello();
        var peerCaps = request["caps"] is JsonArray caps
            ? caps.Select(c => c?.ToString() ?? string.Empty).ToHashSet(StringComparer.Ordinal)
            : [];
        var shellCaps = (reply["caps"] as JsonArray)!.Select(c => c!.ToString()).ToHashSet(StringComparer.Ordinal);
        peerCaps.IntersectWith(shellCaps);
        AttachRuntime(reply, peerCaps);
        return reply;
    }

    /// <summary>hello 帧的运行时附加位：当前通道状态 + 已连接核心的身份与能力。
    /// 这两项是壳侧链路状态，不属于协议 §4 的框架字段，集中在此一处拼装。</summary>
    private void AttachRuntime(JsonObject hello, IReadOnlySet<string>? negotiated)
    {
        hello["state"] = _channel.State.ToString().ToLowerInvariant();
        hello["core"] = _channel.RemoteHello is null
            ? null
            : new JsonObject
            {
                ["app"] = _channel.RemoteHello["app"]?.GetValue<string>(),
                ["ver"] = _channel.RemoteHello["ver"]?.GetValue<string>(),
                ["caps"] = _channel.RemoteHello["caps"]?.DeepClone(),
                ["connected"] = _channel.State == ChannelState.Ready,
                ["negotiated_with_frontend"] = new JsonArray(
                    (negotiated ?? new HashSet<string>(StringComparer.Ordinal))
                        .Select(c => (JsonNode)JsonValue.Create(c)!).ToArray()),
            };
    }

    private static JsonObject ShellHello() => new()
    {
        ["v"] = 1,
        ["t"] = "hello",
        ["role"] = "shell",
        ["proto"] = 1,
        ["caps"] = new JsonArray("cmd", "evt.state", "evt.position", "smtc"),
        ["app"] = "rhine-music-player",
        ["ver"] = "0.1.0",
    };

    private async Task HandleCommandAsync(JsonObject frame)
    {
        var id = frame["id"]?.GetValue<string>();
        var cmd = frame["cmd"]?.GetValue<string>();
        if (id is null || cmd is null)
        {
            Post(ErrorFrame(id, "bad_request", "cmd frame requires string fields id and cmd"));
            return;
        }

        if (cmd == "ping")
        {
            // dev-only：不起管道、不转发，立刻回壳时间戳，供自检面板量测壳-WebView 单边往返。
            Post(new JsonObject
            {
                ["v"] = 1,
                ["t"] = "ack",
                ["id"] = id,
                ["result"] = new JsonObject
                {
                    ["shell_ts"] = IpcFrame.NowMs(),
                    ["dev_only"] = DevOnlyPing,
                },
            });
            return;
        }

        Post(await _channel.SendCommandAsync(id, frame, CancellationToken.None).ConfigureAwait(false));
    }

    private static JsonObject ErrorFrame(string? id, string code, string message)
    {
        var frame = new JsonObject
        {
            ["v"] = 1,
            ["t"] = "err",
            ["error"] = new JsonObject
            {
                ["code"] = code,
                ["message"] = message,
                ["retryable"] = false,
            },
        };
        if (id is not null) frame["id"] = id;
        return frame;
    }

    private void Post(JsonObject frame)
    {
        if (!_dispatcher.CheckAccess())
        {
            _dispatcher.InvokeAsync(() => Post(frame));
            return;
        }

        try
        {
            _post(frame);
        }
        catch (ObjectDisposedException ex)
        {
            Log.Warn($"frontend post failed: {ex.Message}");
        }
    }

    /// <summary>WebView2 侧的一行式接线（保留在主窗口里以防初始化顺序耦合）。</summary>
    public static void Attach(WebView2 view, Bridge bridge)
    {
        view.CoreWebView2.WebMessageReceived += (_, e) =>
        {
            string raw;
            try
            {
                raw = e.TryGetWebMessageAsString();
            }
            catch (InvalidOperationException)
            {
                // 调用方用了 postMessage(对象) 而非字符串；协议 §1 只承诺字符串帧。
                Log.Warn("frontend sent a non-string web message");
                bridge.Post(ErrorFrame(null, "bad_request", "web message must be a JSON string"));
                return;
            }

            bridge.OnWebMessage(raw);
        };
    }
}
