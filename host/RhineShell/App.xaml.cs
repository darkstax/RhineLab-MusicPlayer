using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows;
using RhineShell.Hosting;
using RhineShell.Library;

namespace RhineShell;

/// <summary>
/// 应用入口：单实例互斥 + 启动壳窗口。
/// M1 仍不做托盘/安装器（AUDIO-ENGINE §2 的 Windows 壳完整形态在 M6 安装包阶段补）。
/// </summary>
public partial class App : Application
{
    /// <summary>单实例互斥体名（本机命名空间，不跨会话）。</summary>
    private const string InstanceMutex = @"Local\RhineShell.SingleInstance";

    /// <summary>
    /// 显式进程 AppUserModelID（M3 验收发现）：不设时本进程 SMTC 会话的
    /// SourceAppUserModelId 落到 WebView2 宿主默认值 "MSEdge"（smtc-check.ps1 实测），
    /// 无法归属本应用；设后 SMTC/任务栏/通知归属统一。
    /// </summary>
    private const string AppUserModelId = "RhineMusic.RhineShell";

    [DllImport("shell32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern int SetCurrentProcessExplicitAppUserModelID(string AppID);

    private Mutex? _mutex;
    private ShellOptions _options = ShellOptions.FromCommandLine([]);

    protected override void OnStartup(StartupEventArgs e)
    {
        _options = ShellOptions.FromCommandLine(e.Args);

        // M5a 验收 §4.6：无头自检开关（--cli-scan/--cli-query/…）——不开窗、不抢实例锁、
        // stdout 末行 JSON、退出码 0=成/1=败（专为无人值守，不进产品 UI）。
        if (_options.CliScan || _options.CliMode is not null)
        {
            var code = Cli.Run(_options);
            Console.Out.Flush();
            // Shutdown() 在 Run() 前调用会抛 InvalidOperationException（WPF 契约）；
            // 无头模式根本不开窗口，直接终止进程。
            Environment.Exit(code);
            return;
        }

        try
        {
            var hr = SetCurrentProcessExplicitAppUserModelID(AppUserModelId);
            Log.Info($"aumid set hr=0x{hr:X8} id={AppUserModelId}");
        }
        catch (Exception ex)
        {
            Log.Warn($"aumid set failed: {ex.Message}"); // 不阻断启动：SMTC 归属退化为 MSEdge
        }

        _options = ShellOptions.FromCommandLine(e.Args);
        if (!TryAcquireInstanceMutex(InstanceMutex, out _mutex))
        {
            Log.Info("another RhineShell instance holds the single-instance mutex — exiting");
            // 现阶段重复启动直接退出；跨进程「唤前窗」需要 IPC 广播，随 M6 托盘一起补。
            Shutdown(0);
            return;
        }

        base.OnStartup(e);
        Log.Info($"RhineShell start pid={Environment.ProcessId} {_options.Describe()}");
        var window = new MainWindow(_options);
        MainWindow = window;
        window.Show();
    }

    /// <summary>
    /// 获取单实例互斥体。旧写法 new Mutex(initiallyOwned: true, ...) 在上一持有者被
    /// 强制结束（abandoned mutex）时会在获取处抛 AbandonedMutexException，
    /// 导致后续每次启动都静默崩溃（验证中实际踩到：被 Stop-Process 强杀一次后壳再也起不来）。
    /// 按 MSDN 标准用法：非占有的 WaitOne(timeout) 在取得已废弃互斥体时抛
    /// AbandonedMutexException，此时本次已取得新所有权，记日志后继续启动。
    /// </summary>
    private static bool TryAcquireInstanceMutex(string name, out Mutex mutex)
    {
        var instance = new Mutex(initiallyOwned: false, name);
        try
        {
            if (instance.WaitOne(TimeSpan.Zero))
            {
                mutex = instance;
                return true;
            }
        }
        catch (AbandonedMutexException)
        {
            Log.Warn("single-instance mutex was abandoned by a previous instance - taking ownership");
            mutex = instance;
            return true;
        }

        instance.Dispose();
        mutex = null!;
        return false;
    }

    protected override void OnExit(ExitEventArgs e)
    {
        _mutex?.ReleaseMutex();
        _mutex?.Dispose();
        Log.Info($"RhineShell exit code={e.ApplicationExitCode}");
        base.OnExit(e);
    }
}
