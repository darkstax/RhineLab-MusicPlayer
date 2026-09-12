using System.Runtime.InteropServices;

namespace RhineShell.Hosting;

/// <summary>
/// 窗口电源请求（任务书 M1 范围 B2：keep_awake 真身的最小实装）。
///
/// 这是本壳第一个真实系统能力：<c>desktop.keep_awake=true</c> 时进程持
/// <c>ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED</c>，防止息屏/睡眠；
/// 关闭或进程退出（句柄随进程释放）即恢复系统默认。默认关。
///
/// 注意：Win32 <c>GetThreadExecutionState</c> 在本机 kernel32 中无入口点
/// （验证时实测 EntryPointNotFoundException——该只读回传 API 只在部分 Windows build 导出），
/// 因此状态回读不做 API 依赖，以 <c>SetThreadExecutionState</c> 返回值（0=失败）+ 本类
/// <see cref="Active"/> 标志为准；外部取证用 <c>powercfg /requests</c>（需管理员）。
/// </summary>
public static class KeepAwake
{
    private const uint EsContinuous = 0x80000000;
    private const uint EsSystemRequired = 0x00000001;
    private const uint EsDisplayRequired = 0x00000002;

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint SetThreadExecutionState(uint esFlags);

    /// <summary>当前是否持有电源请求（本进程视角；SetThreadExecutionState 非零返回即持有）。</summary>
    public static bool Active { get; private set; }

    /// <summary>开启/关闭请求；返回操作后的实际持有状态。失败只记日志（不崩 UI 路径）。</summary>
    public static bool Apply(bool enable)
    {
        try
        {
            if (enable)
            {
                var result = SetThreadExecutionState(EsContinuous | EsSystemRequired | EsDisplayRequired);
                Active = result != 0;
                Log.Info($"keep_awake ES set (display+system) -> active={Active} state=0x{result:X8}");
            }
            else
            {
                // 只清本进程的请求：ES_CONTINUOUS 单独调用即释放其余标志。
                SetThreadExecutionState(EsContinuous);
                Active = false;
                Log.Info("keep_awake ES cleared (ES_CONTINUOUS only)");
            }
        }
        catch (Exception ex) when (ex is InvalidOperationException or DllNotFoundException or EntryPointNotFoundException)
        {
            Log.Error($"keep_awake P/Invoke unavailable: {ex.Message}");
            Active = false;
        }

        return Active;
    }
}
