using System.IO;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Threading;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.Wpf;
using RhineShell.Hosting;

namespace RhineShell;

/// <summary>
/// M0 宿主窗口：WebView2 载入 Vite 构建产物（虚拟主机映射，免起 HTTP 端口），
/// 并把页面消息接到 <see cref="Bridge"/>。
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
    private System.Diagnostics.Process? _ownedCore;

    public MainWindow(ShellOptions options)
    {
        _options = options;
        InitializeComponent();
        HostRoot.Children.Add(_view);
        HostRoot.Children.Add(_fallback);
        _fallback.Visibility = Visibility.Collapsed;

        Loaded += OnLoaded;
        Closed += OnClosed;
    }

    private async void OnLoaded(object sender, RoutedEventArgs e)
    {
        ConfigureFallback();
        // 无人值守验收定时器无条件调度：即使页面导航失败也能写 dump（面板缺失文案）并退出，不挂死。
        if (_options.SelfCheckDump is not null) ScheduleSelfCheckDump();

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
                "RhineMusic", "m0", "webview2");
            Directory.CreateDirectory(userData);

            var environment = await CoreWebView2Environment.CreateAsync(userDataFolder: userData);
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

            if (!Directory.Exists(_options.DistDirectory) ||
                !File.Exists(Path.Combine(_options.DistDirectory, "index.html")))
            {
                ShowMissingDist();
                return;
            }

            _view.CoreWebView2.SetVirtualHostNameToFolderMapping(
                VirtualHost, _options.DistDirectory, CoreWebView2HostResourceAccessKind.DenyCors);
            _view.CoreWebView2.Navigate($"https://{VirtualHost}/index.html");
        }
        catch (Exception ex) when (ex is WebView2RuntimeNotFoundException or IOException or UnauthorizedAccessException)
        {
            ShowFatal("WebView2 初始化失败", ex.Message);
        }
    }

    /// <summary>
    /// <c>--spawn-core</c>：由壳拉起随包的 M0 核心桩（<c>dist-host\core\RhineCoreStub.exe</c>），
    /// 关窗时一并结束。M1 起这是正式的核心生命周期模型，M0 仅用于本机自测。
    /// </summary>
    private void StartOwnedCore()
    {
        var exe = Path.Combine(AppContext.BaseDirectory, "core", "RhineCoreStub.exe");
        if (!File.Exists(exe))
        {
            Log.Error($"--spawn-core: stub not found at {exe}");
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
            Log.Info($"spawned core stub pid={_ownedCore?.Id}");
        }
        catch (Exception ex) when (ex is System.ComponentModel.Win32Exception or IOException)
        {
            Log.Error($"--spawn-core failed: {ex.Message}");
        }
    }

    /// <summary>M0 验证辅助（dev-only，M1 删除）：页面稳定后定时把 #m0-selfcheck 面板文本落盘并退出。
    /// 面板是 `white-space:pre-wrap` 的纯文本节点，innerText 与 page_to_markdown 看到的完全一致。
    /// </summary>
    private void ScheduleSelfCheckDump()
    {
        var delay = TimeSpan.FromSeconds(_options.SelfCheckAfterSeconds);
        var timer = new DispatcherTimer(DispatcherPriority.Background) { Interval = delay };
        timer.Tick += async (_, _) =>
        {
            timer.Stop();
            try
            {
                if (_view.CoreWebView2 is null)
                {
                    throw new InvalidOperationException("WebView2 not initialized yet");
                }

                var script = "(document.getElementById('m0-selfcheck')||{}).innerText||'<panel missing>';";
                var text = await _view.CoreWebView2.ExecuteScriptAsync(script).ConfigureAwait(true);
                // ExecuteScriptAsync 返回 JSON 字符串（带引号与转义）。
                var value = System.Text.Json.JsonSerializer.Deserialize<string>(text) ?? string.Empty;
                var target = Path.GetFullPath(_options.SelfCheckDump!);
                Directory.CreateDirectory(Path.GetDirectoryName(target)!);
                File.WriteAllText(target, value, new System.Text.UTF8Encoding(false));
                Log.Info($"selfcheck dump written to {target} ({value.Length} chars)");
            }
            catch (Exception ex) when (ex is System.Text.Json.JsonException or IOException or InvalidOperationException)
            {
                Log.Error($"selfcheck dump failed: {ex.Message}");
                try
                {
                    File.WriteAllText(Path.GetFullPath(_options.SelfCheckDump!), "<dump failed: " + ex.Message + ">",
                        new System.Text.UTF8Encoding(false));
                }
                catch (IOException)
                {
                    // 写入目标不可用时仅留日志
                }
            }
            finally
            {
                Close();
            }
        };
        timer.Start();
    }

    private async void OnClosed(object? sender, EventArgs e)
    {
        _bridge?.Detach();
        if (_channel is not null)
        {
            await _channel.ShutdownAsync("shell-window-closed");
            await _channel.DisposeAsync();
        }

        if (_ownedCore is { HasExited: false } core)
        {
            try
            {
                core.Kill(entireProcessTree: true);
                Log.Info("owned core stub stopped");
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
            "RhineShell M0 · 找不到前端构建产物\n\n" +
            $"期望目录: {_options.DistDirectory}\n\n" +
            "请先运行: pwsh scripts/m0-build.ps1\n" +
            "或在启动时指定: RhineShell.exe --dist <dist 目录路径>";
        RefreshStatus();
    }

    private void ShowFatal(string title, string detail)
    {
        Log.Error($"{title}: {detail}");
        _view.Visibility = Visibility.Collapsed;
        _fallback.Visibility = Visibility.Visible;
        _fallback.Text = $"RhineShell M0 · {title}\n\n{detail}";
    }

    private void RefreshStatus()
    {
        var core = _channel is null ? "off" : _channel.State.ToString().ToLowerInvariant();
        var pending = _channel?.LastError is { Length: > 0 } error ? $" lastError=\"{error}\"" : string.Empty;
        var frames = _channel is null ? string.Empty : $" tx={_channel.FramesSent} rx={_channel.FramesReceived}";
        StatusText.Text = $"core={core}{frames}{pending} · {_options.Describe()}";
    }
}
