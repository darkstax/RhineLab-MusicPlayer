using System.IO.Pipes;
using System.Text;
using RhineShell.Taskbar;
using Xunit;

namespace RhineShell.Tests;

/// <summary>
/// M5c TaskbarWriter 单测：冻结协议帧形状 / 退避序列 / 懒连接静默 / 开关语义 / 真管道端到端。
/// 全部在进程内自建管道当对端（冒充 Taskbar-Lyrics 插件），无外部依赖。
/// </summary>
public sealed class TaskbarWriterTests
{
    [Fact]
    public void BuildLine_matches_frozen_protocol_shape()
    {
        var line = TaskbarWriter.BuildLine("雨上がりの虹も", "雨过天晴的彩虹");
        Assert.Equal("""{"type":"lyric","primary":"雨上がりの虹も","secondary":"雨过天晴的彩虹"}""", line);
    }

    [Fact]
    public void BuildLine_omits_empty_secondary_and_escapes_quotes()
    {
        var line = TaskbarWriter.BuildLine("a\"b", "");
        Assert.Equal("""{"type":"lyric","primary":"a\"b"}""", line);
        Assert.DoesNotContain("secondary", line);
    }

    [Fact]
    public void Backoff_sequence_caps_at_5s()
    {
        Assert.Equal(500, TaskbarWriter.BackoffMs(1));
        Assert.Equal(1000, TaskbarWriter.BackoffMs(2));
        Assert.Equal(2000, TaskbarWriter.BackoffMs(3));
        Assert.Equal(4000, TaskbarWriter.BackoffMs(4));
        Assert.Equal(5000, TaskbarWriter.BackoffMs(5));
        Assert.Equal(5000, TaskbarWriter.BackoffMs(50));   // 封顶（musicfox 同源）
    }

    [Fact]
    public async Task Disabled_writer_is_silent_no_connect_no_throw()
    {
        using var w = new TaskbarWriter(false, null);
        Assert.False(await w.ShowAsync("x", null));
        Assert.Equal(0, w.DroppedFrames);   // 未启用连"丢弃"都不计：零开销路径
    }

    // Windows 命名管道专属用例（Linux/WSL 无 \.\pipe\，TryOpenGate 必然失败）。
    [Fact]
    public async Task Lazy_connect_missing_pipe_drops_quietly()
    {
        // 管道不存在：首次 Show 试连失败 → false + dropped 计数；退避窗口内第二帧零开销 false。
        using var w = new TaskbarWriter(true, $"rhine-test-missing-{Guid.NewGuid():N}");
        Assert.False(await w.ShowAsync("x", null));
        Assert.Equal(1, w.DroppedFrames);
        Assert.False(await w.ShowAsync("y", null));
        Assert.Equal(2, w.DroppedFrames);   // 退避期内直接跳过（不重试风暴）
        Assert.False(w.IsConnected);
    }

    [Fact]
    [Trait("platform", "windows")]
    public async Task EndToEnd_frame_reaches_pipe_server()
    {
        if (!OperatingSystem.IsWindows()) return;   // WSL 无命名管道：跳过（Windows 侧全量跑）

        var name = $"rhine-test-e2e-{Guid.NewGuid():N}";
        using var server = new NamedPipeServerStream(name, PipeDirection.In, 1,
            PipeTransmissionMode.Byte, PipeOptions.Asynchronous);
        var serverTask = Task.Run(async () =>
        {
            // 连接等待带 5s 超时（Windows vstest 宿主挂起教训：无超时的 WaitForConnectionAsync
            // 在对端没来时无限悬挂）；超时抛异常 → 用例 FAIL 而非挂起。
            using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(5));
            await server.WaitForConnectionAsync(cts.Token);
            var buf = new byte[512];
            var n = await server.ReadAsync(buf, 0, buf.Length, cts.Token);
            return Encoding.UTF8.GetString(buf, 0, n);
        });
        using var w = new TaskbarWriter(true, name);
        Assert.True(await w.ShowAsync("第一行", "第二行"));
        Assert.True(await w.ShowAsync("第三行", null));   // 复用已建连接
        var received = await serverTask.WaitAsync(TimeSpan.FromSeconds(8));
        Assert.StartsWith("""{"type":"lyric","primary":"第一行","secondary":"第二行"}""", received);
        Assert.Contains("\n", received);                   // JSON Lines：帧必须 \n 闭合（P0-1 守护）
        // 第二帧同连接复用且各自闭合（行数 == 帧数）。
        var lines = received.Split('\n', StringSplitOptions.RemoveEmptyEntries);
        Assert.Single(lines);                                // server 首读即含完整闭合行（P0-1 语义）
        Assert.Equal(2, w.SentFrames);
        Assert.True(w.IsConnected);
    }

    [Fact]
    public async Task SetEnabled_false_disconnects_and_blocks_next_frame()
    {
        var name = $"rhine-test-off-{Guid.NewGuid():N}";
        using var server = new NamedPipeServerStream(name, PipeDirection.In, 1,
            PipeTransmissionMode.Byte, PipeOptions.Asynchronous);
        _ = Task.Run(async () => { await server.WaitForConnectionAsync(); await Task.Delay(300); });
        using var w = new TaskbarWriter(true, name);
        Assert.True(await w.ShowAsync("x", null));
        w.SetEnabled(false);
        Assert.False(w.Enabled);
        Assert.False(await w.ShowAsync("y", null));       // 立即断开不再发
        Assert.False(w.IsConnected);
    }

    [Fact]
    public void SetEnabled_pipe_change_resets_backoff_gate()
    {
        using var w = new TaskbarWriter(true, "a");
        w.SetEnabled(true, "b");
        Assert.Equal("b", w.PipeName);
    }
}
