using System.IO;

namespace RhineShell.Hosting;

/// <summary>
/// 壳的启动参数与产物定位。M1 起配置系统存在（config.get/set 走 <see cref="ConfigStore"/>），
/// 但启动参数仍只认命令行 + 环境变量（配置文件影响的是运行时行为，不是启动布局）。
/// </summary>
public sealed class ShellOptions
{
    /// <summary>协议 §1 默认管道名；<c>--pipe</c> 与 <c>RHINE_CORE_PIPE</c> 可覆盖。</summary>
    public const string DefaultPipe = @"\\.\pipe\rhine-music.core.v1";

    /// <summary>任务书 B4：<c>--dev</c> 时加载 vite dev 服务（与 <c>npm run dev --port 5173</c> 对齐）。</summary>
    public const string DevUrl = "http://127.0.0.1:5173/";

    /// <summary>前端构建产物目录（须含 index.html）。</summary>
    public required string DistDirectory { get; init; }

    public required string PipeName { get; init; }

    /// <summary>不连接核心（只看页面渲染时用）。</summary>
    public bool CoreDisabled { get; init; }

    /// <summary>启动即打开 DevTools（F12 总是可用）。</summary>
    public bool OpenDevTools { get; init; }

    /// <summary>退出时同时结束本次由壳拉起的核心进程（仅 <c>--spawn-core</c> 模式下有意义）。</summary>
    public bool SpawnedCoreOwned { get; init; }

    /// <summary>任务书 B4：<c>--dev</c> 加载 vite dev 端口代替 app.rhine.local，窗口标题加 [dev]，
    /// 供 UI 迭代免重编壳；无参数时行为不变。</summary>
    public bool Dev { get; init; }

    public string Describe() =>
        $"dist=\"{DistDirectory}\" pipe=\"{PipeName}\" coreDisabled={CoreDisabled} devtools={OpenDevTools} dev={Dev}";

    public static ShellOptions FromCommandLine(string[] args)
    {
        string? dist = Value(args, "--dist");
        var pipe = Value(args, "--pipe")
            ?? Environment.GetEnvironmentVariable("RHINE_CORE_PIPE")
            ?? DefaultPipe;

        return new ShellOptions
        {
            DistDirectory = ResolveDist(dist),
            PipeName = pipe,
            CoreDisabled = args.Contains("--no-core"),
            OpenDevTools = args.Contains("--devtools"),
            SpawnedCoreOwned = args.Contains("--spawn-core"),
            Dev = args.Contains("--dev"),
        };
    }

    private static string? Value(string[] args, string name)
    {
        var index = Array.IndexOf(args, name);
        return index >= 0 && index + 1 < args.Length ? args[index + 1] : null;
    }

    /// <summary>
    /// 产物定位顺序：显式 <c>--dist</c> → 从 exe 逐级上溯找 <c>dist/index.html</c>（开发构建树）
    /// → <c>%LOCALAPPDATA%\RhineMusic\web</c>（m1-run.ps1 镜像布局）。
    /// 找不到不抛异常：由 MainWindow 渲染白底红字提示页（任务书要求不崩溃）。
    /// </summary>
    private static string ResolveDist(string? explicitPath)
    {
        if (!string.IsNullOrWhiteSpace(explicitPath)) return Path.GetFullPath(explicitPath);

        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        for (var depth = 0; depth < 8 && directory is not null; depth++)
        {
            var candidate = Path.Combine(directory.FullName, "dist");
            if (File.Exists(Path.Combine(candidate, "index.html"))) return candidate;
            directory = directory.Parent;
        }

        return Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "RhineMusic",
            "web");
    }
}
