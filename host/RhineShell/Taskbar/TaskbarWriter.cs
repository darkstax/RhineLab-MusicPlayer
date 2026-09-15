using System.IO;
using System.IO.Pipes;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;

namespace RhineShell.Taskbar;

/// <summary>
/// M5c 任务栏歌词 writer：把前端 lyric.show 帧转发给 Taskbar-Lyrics 的**冻结命名管道协议**。
/// 语义逐条参照 go-musicfox internal/lyric/pipe_writer_windows.go（同协议另一实现）：
/// JSON Lines（UTF-8 无 BOM、\n 结尾）、指数退避封顶 5s、失败静默降级、
/// 懒连接（首个 lyric 帧才试连）。
///
/// Q4 用户裁定的两条硬纪律：
/// ① **只发 lyric 帧，永不发 config 帧**（样式归 Taskbar-Lyrics 插件端，避免双主）；
/// ② 设置面只暴露开关 + 管道名（taskbar.source=="player" 显式接管才启用——
///    与 go-musicfox 共存时由用户单选，防双写打架）。
///
/// 本类是**纯逻辑**（不引用 Bridge/ConfigStore），便于单测直链；
/// 事件接线在 TaskbarWiring.Install（同目录，exe 工程内）。线程安全：内部信号量串行化。
/// </summary>
public sealed class TaskbarWriter : IDisposable
{
    /// <summary>musicfox↔Taskbar-Lyrics 冻结协议的默认管道名（不含 \\.\pipe\ 前缀）。</summary>
    public const string DefaultPipeName = "go-musicfox.lyric.v1";

    private readonly object gate = new();
    private readonly SemaphoreSlim writeGate = new(1, 1);  // P1-4：写序串行化
    private NamedPipeClientStream? pipe;
    private StreamWriter? writer;
    private int attempts;                       // 连续失败计数（退避用）
    private DateTime nextTryUtc = DateTime.MinValue;
    private bool enabled;                       // source==player 且开关开
    private string pipeName = DefaultPipeName;
    private long sentFrames;                    // 诊断计数（测试与日志用）
    private long droppedFrames;                 // 未送达计数（静默降级证据，不刷屏）

    public TaskbarWriter(bool enabled, string? pipeNameOverride)
    {
        this.enabled = enabled;
        if (!string.IsNullOrWhiteSpace(pipeNameOverride)) pipeName = pipeNameOverride.Trim();
    }

    public long SentFrames { get { lock (gate) return sentFrames; } }
    public long DroppedFrames { get { lock (gate) return droppedFrames; } }
    public bool IsConnected { get { lock (gate) return writer is not null; } }
    public bool Enabled { get { lock (gate) return enabled; } }
    public string PipeName { get { lock (gate) return pipeName; } }

    /// <summary>taskbar.set 语义：enabled 覆盖 + 管道名可改（改名即重连）。</summary>
    public void SetEnabled(bool next, string? pipeOverride = null)
    {
        lock (gate)
        {
            if (next != enabled || (!string.IsNullOrWhiteSpace(pipeOverride) && pipeOverride.Trim() != pipeName))
            {
                ClosePipeLocked();
                attempts = 0;
                nextTryUtc = DateTime.MinValue;
            }
            if (!string.IsNullOrWhiteSpace(pipeOverride)) pipeName = pipeOverride.Trim();
            enabled = next;
        }
    }

    /// <summary>
    /// 推一帧歌词（协议 §5 lyric.show → 冻结 lyric 帧）。永不抛异常：
    /// 未启用/退避窗口内/连接失败 → 计 dropped 返回 false（调用方 ack{delivered:false}）。
    /// </summary>
    public async Task<bool> ShowAsync(string primary, string? secondary, CancellationToken cancel = default)
    {
        string line;
        lock (gate)
        {
            if (!enabled) return false;
            line = BuildLine(primary, secondary);
        }
        var target = PipeName;
        if (!TryOpenGate(out var stream, out var textWriter, target))
        {
            // 未启用之外的失败（试连不上/退避窗口）= 帧被丢弃：计入 dropped 供诊断
            // （enabled 已在上面短路，不在此计数，保持"零开销路径不记账"语义）。
            lock (gate) droppedFrames++;
            return false;
        }
        // P0-1（审查）：WriteAsync 不追加 NewLine——冻结协议按 \n 切行，
        // 必须 WriteLineAsync（NewLine="\n" 在 TryOpenGate 已配）。
        // P1-4（审查）：Bridge 事件 fire-and-forget，两个 ShowAsync 可并发取到同一 writer
        // → 帧字节交错；写序锁覆盖"取流+写+flush"整段（musicfox PushLyric 全程持 mu 同构）。
        await writeGate.WaitAsync(cancel).ConfigureAwait(false);
        try
        {
            await textWriter.WriteLineAsync(line.AsMemory(), cancel).ConfigureAwait(false);
            await textWriter.FlushAsync(cancel).ConfigureAwait(false);
            lock (gate) { sentFrames++; attempts = 0; }
            return true;
        }
        catch
        {
            // 写失败（对端消失/管道断开）：静默降级，下帧再走退避重连。
            lock (gate)
            {
                droppedFrames++;
                ClosePipeLocked();
                BumpBackoffLocked();
            }
            try { textWriter.Dispose(); } catch { /* 尽力回收 */ }
            try { stream.Dispose(); } catch { /* 同上 */ }
            return false;
        }
        finally
        {
            writeGate.Release();
        }
    }

    private bool TryOpenGate(out NamedPipeClientStream stream, out StreamWriter writer, string target)
    {
        stream = null!; writer = null!;
        lock (gate)
        {
            if (!enabled) return false;
            if (this.writer is not null) { stream = this.pipe!; writer = this.writer; return true; }
            if (DateTime.UtcNow < nextTryUtc) return false;   // 退避窗口内：零开销跳过
            var candidate = new NamedPipeClientStream(".", target, PipeDirection.Out);
            try
            {
                // 本地管道毫秒级；250ms 上限防对端半死挂起（懒连接纪律）。
                // 注：Connect(int) 返回 void，超时/无对端以 IOException/TimeoutException 报。
                candidate.Connect(250);
                pipe = candidate;
                writer = this.writer = new StreamWriter(candidate, new UTF8Encoding(false))
                {
                    AutoFlush = false,
                    NewLine = "\n",
                };
                stream = candidate;
                attempts = 0;
                return true;
            }
            catch (Exception)
            {
                try { candidate.Dispose(); } catch { }
                BumpBackoffLocked();
                return false;
            }
        }
    }

    private void BumpBackoffLocked()
    {
        attempts++;
        nextTryUtc = DateTime.UtcNow + TimeSpan.FromMilliseconds(BackoffMs(attempts));
    }

    private void ClosePipeLocked()
    {
        try { writer?.Dispose(); } catch { }
        try { pipe?.Dispose(); } catch { }
        writer = null;
        pipe = null;
    }

    /// <summary>冻结协议 lyric 帧（JSON Lines；System.Text.Json 负责转义/UTF-8）。
    /// 导出为 internal 供单测直链断言形状。</summary>
    /// <summary>与 Go json.Marshal 同形：非 ASCII 不转义（中文原样 UTF-8），
    /// 只转义引号/控制符——冻结协议对端（Taskbar-Lyrics C++）按 JSON 解析，
    /// 但字节形状与 musicfox 实现保持一致便于抓包比对。</summary>
    internal static readonly JsonSerializerOptions ProtocolJson = new()
    {
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
    };

    internal static string BuildLine(string primary, string? secondary)
    {
        var frame = new Dictionary<string, string> { ["type"] = "lyric", ["primary"] = primary };
        if (!string.IsNullOrEmpty(secondary)) frame["secondary"] = secondary;
        return JsonSerializer.Serialize(frame, ProtocolJson);
    }

    /// <summary>退避序列（musicfox 同源参数）：500→1000→2000→4000→5000 封顶。</summary>
    internal static int BackoffMs(int attempt)
    {
        if (attempt <= 0) return 500;
        var ms = 500L << Math.Min(attempt - 1, 4);
        return (int)Math.Min(ms, 5000L);
    }

    public void Dispose()
    {
        lock (gate) ClosePipeLocked();
    }
}
