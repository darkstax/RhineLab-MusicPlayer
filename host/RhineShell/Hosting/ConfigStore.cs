using System.IO;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace RhineShell.Hosting;

/// <summary>
/// 壳侧配置存储（任务书 M1 范围 B1、协议 §5 config.get/set）：
/// <c>%APPDATA%\RhineMusic\config.json</c>，dot-path 键、原子写（tmp+move）。
/// M1 存 <c>audio.*</c>（sound/music 开关、两路音量）与 <c>desktop.keep_awake</c>；
/// M2 起迁移 TOML schema 时键名不变（§5）。桩侧音量持久化是另一份文件（stub-state.json），互不混淆。
/// </summary>
public static class ConfigStore
{
    private static readonly object Gate = new();

    private static string DirectoryPath => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
        "RhineMusic");

    private static string FilePath =>
        Environment.GetEnvironmentVariable("RHINE_SHELL_CONFIG_FILE") is { Length: > 0 } @override
            ? @override
            : Path.Combine(DirectoryPath, "config.json");

    private static JsonObject LoadLocked()
    {
        try
        {
            if (!File.Exists(FilePath)) return new JsonObject();
            return JsonNode.Parse(File.ReadAllText(FilePath)) as JsonObject ?? new JsonObject();
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException)
        {
            // 配置损坏不能锁死壳：按空配置继续（下次 set 会重写）。
            Log.Warn($"config.json unreadable ({ex.GetType().Name}) — treating as empty");
            return new JsonObject();
        }
    }

    private static bool SaveLocked(JsonObject root)
    {
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(FilePath)!);
            var tmp = FilePath + ".tmp";
            File.WriteAllText(tmp, root.ToJsonString(RhineShared.IpcFrame.Json));
            File.Move(tmp, FilePath, overwrite: true);
            return true;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            Log.Error($"config.json save failed: {ex.Message}");
            return false;
        }
    }

    /// <summary>dot-path 读取；缺失返回 null。</summary>
    public static JsonNode? Get(string path)
    {
        lock (Gate)
        {
            JsonNode? cursor = LoadLocked();
            foreach (var segment in path.Split('.', StringSplitOptions.RemoveEmptyEntries))
            {
                if (cursor is not JsonObject obj) return null;
                cursor = obj[segment];
            }

            return cursor?.DeepClone();
        }
    }

    /// <summary>全部配置的快照（深拷贝，启动时应用配置用）。</summary>
    public static JsonObject Snapshot()
    {
        lock (Gate)
        {
            return (JsonObject)LoadLocked().DeepClone();
        }
    }

    /// <summary>dot-path 写入（value=null 删除该键），返回写入后的生效值；写盘失败抛 IOException。</summary>
    public static JsonNode? Set(string path, JsonNode? value)
    {
        var segments = path.Split('.', StringSplitOptions.RemoveEmptyEntries);
        if (segments.Length == 0) throw new ArgumentException("empty config path", nameof(path));

        lock (Gate)
        {
            var root = LoadLocked();
            var cursor = root;
            for (var i = 0; i < segments.Length - 1; i++)
            {
                if (cursor[segments[i]] is not JsonObject child)
                {
                    child = new JsonObject();
                    cursor[segments[i]] = child;
                }

                cursor = child;
            }

            var leaf = segments[^1];
            if (value is null)
            {
                cursor.Remove(leaf);
            }
            else
            {
                var clone = value.DeepClone();
                cursor[leaf] = clone;
                value = clone;
            }

            if (!SaveLocked(root)) throw new IOException("config.json write failed");

            // 返回叶子路径的当前值（可能被父键覆盖语义影响时以读回为准）。
            return Get(path);
        }
    }
}
