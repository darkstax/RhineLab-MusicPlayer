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

    /// <summary>任务书 M2 约束 8：<c>--core-exe &lt;path&gt;</c> 改 <c>--spawn-core</c> 拉起的核心
    /// 可执行文件（如 dist-host\core\RhineCore.exe 真音频核心）；缺省仍为随包桩
    /// <c>core\RhineCoreStub.exe</c>，壳其余行为零改动。</summary>
    public string? CoreExe { get; init; }

    /// <summary>任务书 B4：<c>--dev</c> 加载 vite dev 端口代替 app.rhine.local，窗口标题加 [dev]，
    /// 供 UI 迭代免重编壳；无参数时行为不变。</summary>
    public bool Dev { get; init; }

    /// <summary>M1 验收钩子：<c>--remote-debug-port &lt;port&gt;</c> 开启 WebView2 CDP（仅 127.0.0.1），
    /// 供无人值守取证（keep_awake/丢帧检测）；长期保留为诊断能力（M6 诊断页同源）。</summary>
    public int RemoteDebugPort { get; init; }

    /// <summary>任务书 M3 范围 B4：<c>--no-smtc</c> 禁用系统媒体卡（E2E 隔离用：
    /// 冒烟/飞屏验证需要无 SMTC 的纯净壳实例）。配置键 <c>smtc.enabled</c> 同样控制，
    /// 命令行参数优先级高于配置。</summary>
    public bool NoSmtc { get; init; }

    /// <summary>M5a 无头自检（验收 §4.6）：<c>--cli-scan [root...]</c> 扫完 stdout 末行 JSON 退出；
    /// <c>--cli-query &lt;q&gt;</c> 查一条；<c>--cli-sqlite-probe</c> / <c>--cli-fts-verify</c> / <c>--cli-quarantine</c>。
    /// 与 --core-exe/--no-smtc 同族，专为无人值守验收，不进产品 UI。</summary>
    public string? CliMode { get; init; }

    /// <summary>--cli-query 的参数（查询串或 id）。</summary>
    public string? CliArg { get; init; }

    /// <summary>--cli-scan 的可选 roots（其后所有非开关参数）。注意 Value() 取的是后继一项。</summary>
    public string[] CliRoots { get; init; } = [];

    public bool CliScan { get; init; }

    /// <summary>--cli-full：--cli-scan 忽略 mtime 增量，强制重读全部元数据（封面修复后重扫用）。</summary>
    public bool CliFull { get; init; }

    public string Describe() =>
        $"dist=\"{DistDirectory}\" pipe=\"{PipeName}\" coreDisabled={CoreDisabled} devtools={OpenDevTools} dev={Dev} cdp={RemoteDebugPort} coreExe={(CoreExe ?? "(stub)")} noSmtc={NoSmtc} cli={CliMode ?? (CliScan ? "scan" : "(none)")}";

    public static ShellOptions FromCommandLine(string[] args)
    {
        string? dist = Value(args, "--dist");
        var pipe = Value(args, "--pipe")
            ?? Environment.GetEnvironmentVariable("RHINE_CORE_PIPE")
            ?? DefaultPipe;
        var cliMode = args.Contains("--cli-sqlite-probe") ? "sqlite-probe"
            : args.Contains("--cli-fts-verify") ? "fts-verify"
            : args.Contains("--cli-quarantine") ? "quarantine"
            : args.Contains("--cli-query") ? "query"
            : args.Contains("--cli-stats") ? "stats"
            : null;

        return new ShellOptions
        {
            DistDirectory = ResolveDist(dist),
            PipeName = pipe,
            CoreDisabled = args.Contains("--no-core"),
            OpenDevTools = args.Contains("--devtools"),
            SpawnedCoreOwned = args.Contains("--spawn-core"),
            CoreExe = Value(args, "--core-exe"),
            Dev = args.Contains("--dev"),
            RemoteDebugPort = int.TryParse(Value(args, "--remote-debug-port"), out var port) && port is > 0 and < 65536
                ? port
                : 0,
            NoSmtc = args.Contains("--no-smtc"),
            CliScan = args.Contains("--cli-scan"),
            CliFull = args.Contains("--cli-full"),
            CliMode = cliMode,
            CliArg = Value(args, "--cli-query"),
            CliRoots = AfterFlag(args, "--cli-scan"),
        };
    }

    /// <summary>--cli-scan 后面的全部非 -- 开头参数 = roots 列表（可省 = config 根）。</summary>
    private static string[] AfterFlag(string[] args, string name)
    {
        var index = Array.IndexOf(args, name);
        if (index < 0) return [];
        var list = new List<string>();
        for (var i = index + 1; i < args.Length && !args[i].StartsWith("--", StringComparison.Ordinal); i++)
            list.Add(args[i]);
        return list.ToArray();
    }

    private static string? Value(string[] args, string name)
    {
        var index = Array.IndexOf(args, name);
        return index >= 0 && index + 1 < args.Length ? args[index + 1] : null;
    }

    /// <summary>
    /// 产物定位顺序：显式 <c>--dist</c> → exe 同级 <c>web/index.html</c>（打包随包形态，
    /// 审查 P1-1 补）→ 逐级上溯找 <c>dist/index.html</c>（开发构建树）
    /// → <c>%LOCALAPPDATA%\RhineMusic\web</c>（m1-run.ps1 镜像布局，开发兜底）。
    /// 找不到不抛异常：由 MainWindow 渲染白底红字提示页（任务书要求不崩溃）。
    /// </summary>
    private static string ResolveDist(string? explicitPath)
    {
        if (!string.IsNullOrWhiteSpace(explicitPath)) return Path.GetFullPath(explicitPath);

        // 审查 P1-1（发布阻断）：打包布局是 <exe 同级>/web/（package.ps1 stage），
        // 原实现只上溯找 dist/ 或回退开发镜像路径 → 干净机 zip 解压后必现"找不到前端产物"。
        // 优先查同级 web/（随包分发形态），再上溯 dist/（开发构建树）。
        var siblingWeb = Path.Combine(AppContext.BaseDirectory, "web");
        if (File.Exists(Path.Combine(siblingWeb, "index.html"))) return siblingWeb;

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
