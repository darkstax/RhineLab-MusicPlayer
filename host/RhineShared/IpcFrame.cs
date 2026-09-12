using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;

namespace RhineShared;

/// <summary>
/// 壳侧与桩共用的帧辅助函数。
/// 协议唯一权威是 <c>docs/IPC-PROTOCOL.md</c>；本文件只提供**不改变语义**的读写便利层，
/// 不含任何协议字段决策（字段名改动必须同步改协议文档）。
/// </summary>
public static class IpcFrame
{
    /// <summary>协议基准时钟；仅用于诊断字段 ts，不作时钟同步依据（协议 §2）。</summary>
    public static long NowMs() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

    /// <summary>
    /// 读取顶层字符串字段（取不到返回 null）。
    /// 非字符串、缺失、类型错误一律视为“无此字段”，调用方按协议自行回错。
    /// </summary>
    public static string? Str(JsonElement obj, string name)
    {
        if (obj.ValueKind != JsonValueKind.Object) return null;
        if (!obj.TryGetProperty(name, out var value)) return null;
        return value.ValueKind == JsonValueKind.String ? value.GetString() : null;
    }

    /// <summary>读取顶层整数/浮点字段（兼容 JSON number 的两种写法）。</summary>
    public static double? Num(JsonElement obj, string name)
    {
        if (obj.ValueKind != JsonValueKind.Object) return null;
        if (!obj.TryGetProperty(name, out var value)) return null;
        return value.ValueKind == JsonValueKind.Number && value.TryGetDouble(out var d) ? d : null;
    }

    /// <summary>
    /// 解析一帧字节流文本为对象；非对象、空行、语法错误一律返回 null，
    /// 由调用方按协议 §10 自行决定丢弃或回 <c>bad_request</c>（不崩溃）。
    /// </summary>
    public static JsonObject? ParseObject(string line)
    {
        if (string.IsNullOrWhiteSpace(line)) return null;
        try
        {
            return JsonNode.Parse(line) as JsonObject;
        }
        catch (JsonException)
        {
            return null;
        }
    }

    /// <summary>
    /// 发送前的统一出口：本进程内的动态值（延迟、计数、时间戳）一律由此转义，
    /// 保证任何外部数据都不会破坏 JSON Lines 的单行约束（协议 §1）。
    /// </summary>
    public static readonly JsonSerializerOptions Json = new()
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
    };
}
