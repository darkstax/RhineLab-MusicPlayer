using System.Text.Json;
using System.Text.Json.Nodes;
using RhineShell.Hosting;

namespace RhineShell.Taskbar;

/// <summary>
/// 任务栏 writer 与 Bridge/Config 的接线（M5c）：MainWindow 只调 Install 一行，
/// 事件订阅、config 读键、ack 语义全部集中在这里——TaskbarWriter 本体保持纯逻辑可单测。
///
/// config 键（协议 v1.4 / M5-PLAN-v2 §1.4）：
///   taskbar.source  "off"（默认）| "player" | "musicfox" —— 与 go-musicfox 的归属单选，
///                   只有 player 才接管管道（防双写打架，FINDINGS 记文案）。
///   taskbar.pipe    管道名覆盖（缺省 go-musicfox.lyric.v1）。
/// taskbar.set（cmd）可运行时改 enabled/pipe，并**回写 config**（用户意图持久化）。
/// </summary>
public static class TaskbarWiring
{
    /// <summary>类型越界安全取值（前端/config 帧类型不可信；RaiseAsync 虽有兜底，源头收敛不冒泡）。</summary>
    private static string? Str(JsonNode? node) =>
        node is not null && node.GetValueKind() == JsonValueKind.String ? node.GetValue<string>() : null;

    private static bool? Bool(JsonNode? node) =>
        node switch
        {
            null => null,
            var n when n.GetValueKind() == JsonValueKind.True => true,
            var n when n.GetValueKind() == JsonValueKind.False => false,
            _ => null,
        };

    public static TaskbarWriter Install(Bridge bridge)
    {
        var source = Str(ConfigStore.Get("taskbar.source"));
        var enabled = string.Equals(source, "player", StringComparison.OrdinalIgnoreCase);
        var pipe = Str(ConfigStore.Get("taskbar.pipe"));
        var writer = new TaskbarWriter(enabled, pipe);

        bridge.LyricShowRequested += async frame =>
        {
            var data = frame["data"] as JsonObject;
            var primary = Str(data?["primary"]);
            var secondary = Str(data?["secondary"]);
            if (primary is null) return false;
            return await writer.ShowAsync(primary, secondary).ConfigureAwait(false);
        };

        bridge.TaskbarSetRequested += async frame =>
        {
            var data = frame["data"] as JsonObject;
            var next = Bool(data?["enabled"]);
            var pipeOverride = Str(data?["pipe"]);
            if (next is null && string.IsNullOrEmpty(pipeOverride)) return false;
            if (next is not null)
            {
                // 用户显式开关 = 意图持久化：true → source=player，false → source=off。
                writer.SetEnabled(next.Value, pipeOverride);
                ConfigStore.Set("taskbar.source", JsonValue.Create(next.Value ? "player" : "off"));
            }
            else if (!string.IsNullOrEmpty(pipeOverride))
            {
                writer.SetEnabled(writer.Enabled, pipeOverride);
            }
            if (!string.IsNullOrEmpty(pipeOverride)) ConfigStore.Set("taskbar.pipe", JsonValue.Create(pipeOverride));
            return true;
        };

        return writer;
    }
}
