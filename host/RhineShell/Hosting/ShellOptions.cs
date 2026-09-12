using System.IO;

namespace RhineShell.Hosting;

/// <summary>
/// 壳的启动参数与产物定位。M0 只认命令行 + 环境变量，不读配置文件（配置系统在 M1）。
/// </summary>
public sealed class ShellOptions
{
    /// <summary>协议 §1 默认管道名；<c>--pipe</c> 与 <c>RHINE_CORE_PIPE</c> 可覆盖。</summary>
    public const string DefaultPipe = @"\\.\pipe\rhine-music.core.v1";

    /// <summary>前端构建产物目录（须含 index.html）。</summary>
    public required string DistDirectory { get; init; }

    public required string PipeName { get; init; }

    /// <summary>不连接核心（只看页面渲染时用）。</summary>
    public bool CoreDisabled { get; init; }

    /// <summary>启动即打开 DevTools（F12 总是可用）。</summary>
    public bool OpenDevTools { get; init; }

    /// <summary>
    /// M0 验证辅助（dev-only，M1 删除）：指定后，在 <see cref="SelfCheckAfterSeconds"/> 秒时
    /// 读取页面 #m0-selfcheck 面板文本写入该文件，随后退出壳。
    /// 用于无人工点击的验收取证（验收 2/3/4 要求面板数值可核）。
    /// </summary>
    public string? SelfCheckDump { get; init; }

    public double SelfCheckAfterSeconds { get; init; } = 20;

    /// <summary>退出时同时结束本次由壳拉起的核心进程（仅 <c>--spawn-core</c> 模式下有意义）。</summary>
    public bool SpawnedCoreOwned { get; init; }

    public string Describe() =>
        $"dist=\"{DistDirectory}\" pipe=\"{PipeName}\" coreDisabled={CoreDisabled} devtools={OpenDevTools} "
        + $"dump={SelfCheckDump ?? "-"}@{SelfCheckAfterSeconds:F0}s";

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
            SelfCheckDump = Value(args, "--selfcheck-dump"),
            SelfCheckAfterSeconds = double.TryParse(Value(args, "--selfcheck-after"), out var seconds) && seconds > 0
                ? seconds
                : 20,
        };
    }

    private static string? Value(string[] args, string name)
    {
        var index = Array.IndexOf(args, name);
        return index >= 0 && index + 1 < args.Length ? args[index + 1] : null;
    }

    /// <summary>
    /// 产物定位顺序：显式 <c>--dist</c> → 从 exe 逐级上溯找 <c>dist/index.html</c>（开发构建树）
    /// → <c>%LOCALAPPDATA%\RhineMusic\m0\web</c>（m0-build.ps1 发布布局）。
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
            "m0",
            "web");
    }
}
