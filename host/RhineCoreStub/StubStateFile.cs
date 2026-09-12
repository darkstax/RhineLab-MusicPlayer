using System.Text.Json;
using System.Text.Json.Nodes;

namespace RhineCoreStub;

/// <summary>
/// 桩侧配置持久化（任务书 M1 范围 A7）：音量/模式写
/// <c>%APPDATA%\RhineMusic\stub-state.json</c>；壳侧 config 走壳（<c>config.json</c>），互不混淆。
/// 文件形状不是协议内容，只受本类读写。
/// </summary>
internal static class StubStateFile
{
    private static readonly object Gate = new();

    private static string DefaultPath => System.IO.Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
        "RhineMusic",
        "stub-state.json");

    private static string FilePath =>
        Environment.GetEnvironmentVariable("RHINE_STUB_STATE_FILE") is { Length: > 0 } over
            ? over
            : DefaultPath;

    /// <summary>读取已持久化的音量/模式；文件缺失或损坏返回 null（不崩溃，按协议 §10 精神降级）。</summary>
    public static (double Volume, string Mode)? Load()
    {
        try
        {
            var text = File.ReadAllText(FilePath);
            var node = JsonNode.Parse(text)?.AsObject();
            var volume = node?["volume"]?.GetValue<double>();
            var mode = node?["volume_mode"]?.GetValue<string>();
            if (volume is null || mode is null) return null;
            return (Math.Clamp(volume.Value, 0.0, 1.0), mode);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException or InvalidOperationException)
        {
            return null;
        }
    }

    /// <summary>原子写（tmp+move 与壳 config 同一套路）；失败只记日志不影响命令路径。</summary>
    public static bool Save(double volume, string mode, Action<string>? log)
    {
        lock (Gate)
        {
            try
            {
                var path = FilePath;
                Directory.CreateDirectory(System.IO.Path.GetDirectoryName(path)!);
                var frame = new JsonObject
                {
                    ["volume"] = volume,
                    ["volume_mode"] = mode,
                    ["saved_at_ms"] = RhineShared.IpcFrame.NowMs(),
                };
                var tmp = path + ".tmp";
                File.WriteAllText(tmp, frame.ToJsonString(RhineShared.IpcFrame.Json));
                File.Move(tmp, path, overwrite: true);
                return true;
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                log?.Invoke($"stub-state save failed: {ex.Message}");
                return false;
            }
        }
    }
}
