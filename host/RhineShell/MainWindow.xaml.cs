using System.IO;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Threading;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.Wpf;
using RhineShell.Hosting;
using RhineShell.Smtc;

namespace RhineShell;

/// <summary>
/// 宿主窗口：WebView2 载入 Vite 构建产物（虚拟主机映射，免起 HTTP 端口），
/// 并把页面消息接到 <see cref="Bridge"/>。<c>--dev</c> 时改加载本地 vite 服务（任务书 B4）。
/// </summary>
public partial class MainWindow : Window
{
    /// <summary>虚拟主机名；映射与导航必须用同一个 hostName，否则 WebView2 会把它当真实域名解析而导航失败。</summary>
    private const string VirtualHost = "app.rhine.local";

    private readonly ShellOptions _options;
    private readonly WebView2 _view = new();
    private readonly TextBlock _fallback = new();
    private ShellChannel? _channel;
    private Bridge? _bridge;
    private SmtcManager? _smtc;
    private System.Diagnostics.Process? _ownedCore;

    public MainWindow(ShellOptions options)
    {
        _options = options;
        InitializeComponent();
        if (options.Dev) Title = "Rhine Lab · [dev]";
        HostRoot.Children.Add(_view);
        HostRoot.Children.Add(_fallback);
        _fallback.Visibility = Visibility.Collapsed;

        // 任务书 B2：启动时应用持久化的 keep_awake（默认关）。
        ApplyKeepAwakeFromConfig();

        Loaded += OnLoaded;
        Closed += OnClosed;
    }

    /// <summary>从壳 config 读 desktop.keep_awake 并置位（读不到一律视为关，不报错）。</summary>
    private static void ApplyKeepAwakeFromConfig()
    {
        var enabled = ConfigStore.Get("desktop.keep_awake")?.GetValueKind()
            is System.Text.Json.JsonValueKind.True;
        if (enabled) KeepAwake.Apply(true);
        else Log.Info("keep_awake config off (default)");
    }

    private async void OnLoaded(object sender, RoutedEventArgs e)
    {
        ConfigureFallback();

        // 核心通道先起，这样页面一加载就已有 hello/state 可重放（协议 §9）。
        if (!_options.CoreDisabled)
        {
            if (_options.SpawnedCoreOwned) StartOwnedCore();
            _channel = new ShellChannel(_options.PipeName);
            _channel.StateChanged += state => Dispatcher.InvokeAsync(() => RefreshStatus());
            _channel.Start();
        }

        try
        {
            var userData = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "RhineMusic", "webview2");
            if (_options.RemoteDebugPort > 0)
            {
                // 审查 P1-4 根因（A/B/C 隔离实测）：Runtime 152 对 `--remote-debugging-port=ip:port`
                // 形式**静默忽略**，纯端口形式生效（CDP 本就默认只绑 127.0.0.1，无损失）；
                // 另：options.AdditionalBrowserArguments 通道在本机不生效（M1 实施发现，FINDINGS §1），
                // 环境变量通道经实测可靠，在 CreateAsync 前写入即对所有浏览器子进程生效。
                Environment.SetEnvironmentVariable(
                    "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
                    $"--remote-debugging-port={_options.RemoteDebugPort}");
            }
            Directory.CreateDirectory(userData);

            var environment = await CoreWebView2Environment.CreateAsync(
                browserExecutableFolder: null, userDataFolder: userData, options: null);
            await _view.EnsureCoreWebView2Async(environment);

            var settings = _view.CoreWebView2.Settings;
            settings.AreDevToolsEnabled = true;                       // F12
            settings.AreDefaultContextMenusEnabled = false;           // 任务书要求关闭默认右键菜单
            settings.IsStatusBarEnabled = false;
            settings.AreBrowserAcceleratorKeysEnabled = true;
            settings.IsZoomControlEnabled = false;
            settings.IsSwipeNavigationEnabled = false;

            if (_channel is not null)
            {
                _bridge = new Bridge(_channel, frame =>
                    _view.CoreWebView2.PostWebMessageAsJson(frame.ToJsonString(RhineShared.IpcFrame.Json)));
                Bridge.Attach(_view, _bridge);
                RegisterSmtc();
            }

            _view.CoreWebView2.NavigationCompleted += (_, args) =>
            {
                if (!args.IsSuccess)
                {
                    Log.Warn($"navigation failed: {args.WebErrorStatus}");
                    return;
                }

                Log.Info("page loaded");
                _bridge?.ReplayToFrontend();
                if (_options.OpenDevTools) _view.CoreWebView2.OpenDevToolsWindow();
                RefreshStatus();
            };

            if (!_options.Dev && (!Directory.Exists(_options.DistDirectory) ||
                                   !File.Exists(Path.Combine(_options.DistDirectory, "index.html"))))
            {
                ShowMissingDist();
                return;
            }

            _view.CoreWebView2.SetVirtualHostNameToFolderMapping(
                VirtualHost, _options.DistDirectory, CoreWebView2HostResourceAccessKind.DenyCors);
            // 任务书 B4：--dev 直连 vite 服务（HMR 改 UI 不重编壳）；无参数行为不变。
            _view.CoreWebView2.Navigate(_options.Dev ? ShellOptions.DevUrl : $"https://{VirtualHost}/index.html");
        }
        catch (Exception ex) when (ex is WebView2RuntimeNotFoundException or IOException or UnauthorizedAccessException)
        {
            ShowFatal("WebView2 初始化失败", ex.Message);
        }
    }

    /// <summary>
    /// 任务书 M3 范围 B：SMTC 注册。优先级：<c>--no-smtc</c>（E2E 隔离）&gt; config
    /// <c>smtc.enabled</c>（缺省 true，关闭时不注册）；注册失败在 SmtcManager 内部
    /// catch 降级记日志，UI 零影响（B2）。WPF 窗口句柄经 WindowInteropHelper 取
    /// （OnLoaded 时必已就绪），交给 GetForWindow 的桌面入口——见 SmtcManager 注释。
    /// </summary>
    private void RegisterSmtc()
    {
        if (_options.NoSmtc)
        {
            Log.Info("smtc skipped by --no-smtc");
            return;
        }

        if (_channel is null || _bridge is null)
        {
            Log.Info("smtc skipped (no core channel)");
            return;
        }

        var enabled = ConfigStore.Get("smtc.enabled");
        if (enabled?.GetValueKind() == System.Text.Json.JsonValueKind.False)
        {
            Log.Info("smtc disabled by config smtc.enabled=false");
            return;
        }

        _smtc = SmtcManager.TryCreate(_channel, _bridge, new System.Windows.Interop.WindowInteropHelper(this).Handle);
    }

    /// <summary>
    /// <c>--spawn-core</c>：由壳拉起随包的核心桩（<c>dist-host\core\RhineCoreStub.exe</c>），
    /// 关窗时一并结束。M1 起这是正式的核心生命周期模型。
    /// M2 约束 8：<c>--core-exe &lt;path&gt;</c> 换成真音频核心（RhineCore.exe）等同一路径，
    /// 日志区分 core 类型；壳其余行为零改动。
    /// </summary>
    private void StartOwnedCore()
    {
        var exe = _options.CoreExe is { Length: > 0 } coreExe
            ? Path.GetFullPath(coreExe)
            : Path.Combine(AppContext.BaseDirectory, "core", "RhineCoreStub.exe");
        if (!File.Exists(exe))
        {
            Log.Error($"--spawn-core: core exe not found at {exe}");
            return;
        }

        try
        {
            _ownedCore = System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(exe)
            {
                Arguments = $"--pipe \"{_options.PipeName}\" --verbose",
                UseShellExecute = false,
                CreateNoWindow = true,
            });
            Log.Info($"spawned core pid={_ownedCore?.Id} exe={Path.GetFileName(exe)}");
        }
        catch (Exception ex) when (ex is System.ComponentModel.Win32Exception or IOException)
        {
            Log.Error($"--spawn-core failed: {ex.Message}");
        }
    }

    private async void OnClosed(object? sender, EventArgs e)
    {
        _bridge?.Detach();
        _smtc?.Dispose();
        _smtc = null;
        if (_channel is not null)
        {
            await _channel.ShutdownAsync("shell-window-closed");
            await _channel.DisposeAsync();
        }

        // 退出前释放本进程的电源请求（任务书 B2：不残留系统状态）。
        if (KeepAwake.Active) KeepAwake.Apply(false);

        if (_ownedCore is { HasExited: false } core)
        {
            try
            {
                core.Kill(entireProcessTree: true);
                Log.Info("owned core stopped");
            }
            catch (InvalidOperationException)
            {
                // 自己已经退了
            }
        }
    }

    private void ConfigureFallback()
    {
        _fallback.FontFamily = new FontFamily("Consolas");
        _fallback.FontSize = 14;
        _fallback.Foreground = new SolidColorBrush(Color.FromRgb(0xE8, 0x2E, 0x2E));
        _fallback.Background = Brushes.White;
        _fallback.TextWrapping = TextWrapping.Wrap;
        _fallback.Margin = new Thickness(24);
        _fallback.VerticalAlignment = VerticalAlignment.Center;
    }

    /// <summary>任务书：构建时若 dist 不存在，给白底红字提示页（不崩溃）。</summary>
    private void ShowMissingDist()
    {
        Log.Error($"dist not found: {_options.DistDirectory}");
        _view.Visibility = Visibility.Collapsed;
        _fallback.Visibility = Visibility.Visible;
        _fallback.Text =
            "RhineShell · 找不到前端构建产物\n\n" +
            $"期望目录: {_options.DistDirectory}\n\n" +
            "请先运行: pwsh scripts/m-build.ps1\n" +
            "或在启动时指定: RhineShell.exe --dist <dist 目录路径>";
        RefreshStatus();
    }

    private void ShowFatal(string title, string detail)
    {
        Log.Error($"{title}: {detail}");
        _view.Visibility = Visibility.Collapsed;
        _fallback.Visibility = Visibility.Visible;
        _fallback.Text = $"RhineShell · {title}\n\n{detail}";
    }

    private void RefreshStatus()
    {
        var core = _channel is null ? "off" : _channel.State.ToString().ToLowerInvariant();
        var pending = _channel?.LastError is { Length: > 0 } error ? $" lastError=\"{error}\"" : string.Empty;
        var frames = _channel is null ? string.Empty : $" tx={_channel.FramesSent} rx={_channel.FramesReceived}";
        StatusText.Text = $"core={core}{frames}{pending} · {_options.Describe()}";
    }
}
