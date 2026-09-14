using System.IO;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Windows.Threading;
using Microsoft.Web.WebView2.Wpf;
using RhineShared;
using RhineShell.Library;

namespace RhineShell.Hosting;

/// <summary>
/// 前端 ↔ 壳 的转发网关（<c>docs/IPC-PROTOCOL.md</c> §1：壳是前端的唯一特权网关）。
///
/// <list type="bullet">
/// <item>WebView2 <c>WebMessageReceived</c> → 解析 → 壳自身处理的 <c>hello</c>/<c>config.*</c> / 转发 <c>cmd</c> 给核心；</item>
/// <item>核心 <c>evt</c>/<c>hello</c> → <c>PostWebMessageAsJson</c> 推给前端；</item>
/// <item>页面（重新）加载后重放 <c>hello</c> + 最新 <c>evt{state}</c> 快照（§9）；</item>
/// <item>壳侧生成的错误帧与核心来的 <c>ack</c>/<c>err</c> 同形，前端只写一条处理路径。</item>
/// </list>
///
/// M1：壳自答 <c>config.get/set</c>（§5，落 <see cref="ConfigStore"/>，不转发核心）；
/// M0 的 dev-only <c>ping</c> 自答已随验收链退役。
/// </summary>
public sealed class Bridge
{
    private readonly ShellChannel _channel;
    private readonly Dispatcher _dispatcher = Dispatcher.CurrentDispatcher;
    private readonly Action<JsonObject> _post;
    private readonly LibraryApi _library;
    // M4-d：config.set output.* 的键 → 核心 cmd 翻译表（§15 键名不变，cmd 面 v1.6）。
    // output.device → devices.select{id}；其余四键聚合成一次 output.mode。
    private static readonly string[] OutputModeKeys =
        ["output.mode", "output.buffer_ms", "output.auto_expand_buffer", "output.buffer_max_ms"];

    public Bridge(ShellChannel channel, Action<JsonObject> post)
    {
        _channel = channel;
        _post = post;
        _library = new LibraryApi(frame => Post(frame));
        _channel.FrameReceived += OnCoreFrame;
    }

    public void Detach() => _channel.FrameReceived -= OnCoreFrame;

    /// <summary>
    /// 核心帧观察接入口（M3 SMTC 接入点；UI 线程调度）。与转发前端同一条路径、
    /// 同一帧实例：壳侧消费者（SMTC）不另开事件解析旁路；处理器异常被捕获，
    /// 不影响转发。
    /// </summary>
    public event Action<JsonObject>? CoreFrameObserved;

    /// <summary>M5c 钩子（协议 v1.4 lyric.show / taskbar.set）：壳侧自答 ack，同时把帧抛给
    /// 订阅者（TaskbarWriter.Install）；无订阅者时 delivered=false 不报错（Q4：样式归插件端，
    /// 本应用只在用户显式开启时写管道）。返回值被忽略；处理器异常自捕获。</summary>
    public event Func<JsonObject, Task<bool>>? LyricShowRequested;
    public event Func<JsonObject, Task<bool>>? TaskbarSetRequested;

    private async Task<bool> RaiseAsync(Func<JsonObject, Task<bool>>? handler, JsonObject frame)
    {
        if (handler is null) return false;
        foreach (Func<JsonObject, Task<bool>> one in handler.GetInvocationList())
        {
            try
            {
                if (await one(frame).ConfigureAwait(false)) return true;
            }
            catch (Exception ex)
            {
                Log.Warn($"lyric/taskbar handler failed: {ex.GetType().Name}: {ex.Message}");
            }
        }
        return false;
    }

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
        _dispatcher.InvokeAsync(() =>
        {
            Post(frame);
            if (CoreFrameObserved is { } observed)
            {
                try
                {
                    observed(frame);
                }
                catch (Exception ex)
                {
                    Log.Warn($"core frame observer failed: {ex.GetType().Name}: {ex.Message}");
                }
            }
        }).Task.ContinueWith(
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
                // 协议 §4 v1.2：会话世代 ep 随核心 hello 快照透传，前端据此复位丢帧基线。
                ["ep"] = _channel.RemoteHello["ep"]?.DeepClone(),
                ["connected"] = _channel.State == ChannelState.Ready,
                ["negotiated_with_frontend"] = new JsonArray(
                    (negotiated ?? new HashSet<string>(StringComparer.Ordinal))
                        .Select(c => (JsonNode)JsonValue.Create(c)!).ToArray()),
            };
    }

    /// <summary>M4-d：壳侧主动下发核心命令（无前端 id 上下文 → 用 shell-N 序列号；
    /// 应答帧照常路由（pending 里没有对应 id → 前端忽略），实况以 evt{state} 为准。</summary>
    private void ForwardCoreCmd(string cmd, JsonObject data)
    {
        try
        {
            var id = $"shell-{_forwardSeq++}";
            var frame = new JsonObject
            {
                ["v"] = 1,
                ["t"] = "cmd",
                ["id"] = id,
                ["cmd"] = cmd,
                ["data"] = data,
            };
            _ = _channel.SendCommandAsync(id, frame, CancellationToken.None);
        }
        catch (Exception ex)
        {
            Log.Warn($"forward {cmd} failed: {ex.Message}");
        }
    }

    private int _forwardSeq;

    /// <summary>M4-d：核心就绪后的 config→cmd 启动同步——持久化的 output.* 若偏离
    /// 核心默认（shared/10/auto/300）则补发一次 output.mode；钉选设备同理。
    /// 幂等：值与默认一致时零命令。</summary>
    public void SyncOutputConfigToCore()
    {
        try
        {
            var mode = (ConfigStore.Get("output.mode")?.GetValueKind() == JsonValueKind.String
                ? ConfigStore.Get("output.mode")!.GetValue<string>() : "shared");
            var device = ConfigStore.Get("output.device")?.GetValueKind() == JsonValueKind.String
                ? ConfigStore.Get("output.device")!.GetValue<string>() : "default";
            if (device.Length > 0 && device != "default")
            {
                ForwardCoreCmd("devices.select", new JsonObject { ["id"] = device });
            }
            var bufferMs = ConfigStore.Get("output.buffer_ms");
            var autoExpand = ConfigStore.Get("output.auto_expand_buffer");
            var bufferMax = ConfigStore.Get("output.buffer_max_ms");
            bool nonDefault = mode != "shared" || bufferMs is not null || autoExpand is not null
                || bufferMax is not null;
            if (!nonDefault) return;
            var payload = new JsonObject { ["mode"] = mode };
            if (bufferMs is not null) payload["buffer_ms"] = bufferMs.DeepClone();
            if (autoExpand is not null) payload["auto_expand_buffer"] = autoExpand.DeepClone();
            if (bufferMax is not null) payload["buffer_max_ms"] = bufferMax.DeepClone();
            ForwardCoreCmd("output.mode", payload);
            Log.Info($"output config synced to core: {payload.ToJsonString()}");
        }
        catch (Exception ex)
        {
            Log.Warn($"output sync failed: {ex.Message}");
        }
    }

    private static JsonObject ShellHello() => new()
    {
        ["v"] = 1,
        ["t"] = "hello",
        ["role"] = "shell",
        ["proto"] = 1,
        // 协议 v1.4 §4：曲库能力落地即声明（前端据此启用 library-store；桩/无库环境优雅降级）。
        ["caps"] = new JsonArray("cmd", "evt.state", "evt.position", "smtc", "library"),
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

        // 协议 §5（M1）：config.get/set 是壳侧职责（持久化归壳，不转发核心）。
        if (cmd is "config.get" or "config.set")
        {
            Post(ConfigCommand(id, cmd, frame));
            return;
        }

        // 协议 v1.4 §5（M5a）：library.* 全部壳侧自答（DB 在壳内，不经核心管道；
        // 与 config.* 同路由位）。扫描/查询的错误码映射在 LibraryApi（§7）。
        if (cmd.StartsWith("library.", StringComparison.Ordinal))
        {
            // 扫描可长（全库 44GB 首轮），放线程池避免堵其它命令的回调。
            _ = Task.Run(() => Post(_library.Handle(id, cmd, frame)));
            return;
        }

        // 协议 v1.4 §5.1：engine.play 的 lib:<id> 在转发核心前解析为 file:<绝对路径>
        //（核心 scheme 面零改动）；解析失败回 bad_request{unknown lib id}（壳侧产生）。
        if (cmd == "engine.play")
        {
            var resolved = _library.ResolvePlayTrack(frame, out var playError);
            if (resolved is null)
            {
                Post(playError!);
                return;
            }
            frame = resolved;
        }

        // 协议 §5（M5c/v1.4）：lyric.show / taskbar.set 壳侧自答 + 事件钩子（不经核心）。
        if (cmd is "lyric.show" or "taskbar.set")
        {
            var handler = cmd == "lyric.show" ? LyricShowRequested : TaskbarSetRequested;
            var delivered = await RaiseAsync(handler, frame).ConfigureAwait(false);
            Post(new JsonObject
            {
                ["v"] = 1,
                ["t"] = "ack",
                ["id"] = id,
                ["result"] = new JsonObject { ["delivered"] = delivered },
            });
            return;
        }

        Post(await _channel.SendCommandAsync(id, frame, CancellationToken.None).ConfigureAwait(false));
    }

    /// <summary>壳侧 config 自答：dot-path 读写 <see cref="ConfigStore"/>；
    /// desktop.keep_awake 变更时同步应用电源请求（在 UI 线程执行，线程常驻才能持续持有）。</summary>
    private JsonObject ConfigCommand(string id, string cmd, JsonObject frame)
    {
        try
        {
            var data = frame["data"] as JsonObject;
            var path = data?["path"]?.GetValue<string>();
            if (string.IsNullOrWhiteSpace(path))
                return ErrorFrame(id, "bad_request", $"{cmd} requires string data.path");

            JsonNode? value;
            if (cmd == "config.set")
            {
                ConfigStore.Set(path, data?["value"]?.DeepClone());
                value = ConfigStore.Get(path);
                Log.Info($"config.set {path} persisted (value={value?.ToJsonString() ?? "null"})");

                if (path == "desktop.keep_awake")
                {
                    var enabled = value?.GetValueKind() == JsonValueKind.True;
                    // P/Invoke 调度到 UI 线程：执行状态标志随线程消亡，后台线程池退出会静默失效。
                    _ = _dispatcher.InvokeAsync(() => KeepAwake.Apply(enabled));
                }
                // M4-d（协议 v1.6）：output.* 键变更 → 翻译下发核心（fire-and-forget：
                // config.set 的 ack 语义仍是"已持久化"；核心实况经 evt{state} 的
                // negotiated 回流，UI 不依赖此 ack）。设备未就绪/核心缺席时静默（下次
                // play 时核心按 config 兜底重协商由 M6 收口项处理，见 FINDINGS）。
                if (path == "output.device")
                {
                    ForwardCoreCmd("devices.select", new JsonObject
                    {
                        ["id"] = value?.GetValueKind() == JsonValueKind.String
                            ? JsonValue.Create(value!.GetValue<string>()) : JsonValue.Create(""),
                    });
                }
                else if (Array.IndexOf(OutputModeKeys, path) >= 0)
                {
                    var mode = ConfigStore.Get("output.mode")?.GetValueKind() == JsonValueKind.String
                        ? ConfigStore.Get("output.mode")!.GetValue<string>() : "shared";
                    var payload = new JsonObject { ["mode"] = mode };
                    if (ConfigStore.Get("output.buffer_ms") is { } bm) payload["buffer_ms"] = bm.DeepClone();
                    if (ConfigStore.Get("output.auto_expand_buffer") is { } ae) payload["auto_expand_buffer"] = ae.DeepClone();
                    if (ConfigStore.Get("output.buffer_max_ms") is { } bx) payload["buffer_max_ms"] = bx.DeepClone();
                    ForwardCoreCmd("output.mode", payload);
                }
            }
            else
            {
                value = ConfigStore.Get(path);
            }

            return new JsonObject
            {
                ["v"] = 1,
                ["t"] = "ack",
                ["id"] = id,
                ["result"] = new JsonObject { ["value"] = value?.DeepClone() },
            };
        }
        catch (Exception ex) when (ex is InvalidOperationException or JsonException or IOException or ArgumentException)
        {
            // 对端帧字段越界：按 §10 回 bad_request，不崩溃（与桩的 SafeString 族同一纪律）。
            return ErrorFrame(id, "bad_request", $"{cmd} failed: {ex.Message}");
        }
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
            // v1.4 §5.1：lib: 会话内核心回报的 file: track_id 在**出站副本**上改写回 lib:<id>
            //（M5b 歌词/M5d 播放断言前提）；原帧不动——SMTC 观察者与 LatestState 缓存继续
            // 看核心原始形态；非曲库帧为 no-op（直接返回原引用）。
            _post(_library.RewriteForFrontend(frame));
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
