// R5（cb 复核 + 真机实测）：核心启动决策——发行版启动必须拉起核心。
//
// 背景（发布阻断级缺陷，M6-F 验收盲区）：
//   zip/exe 发行版双击 RhineShell.exe 时**没有任何核心在跑**（真机实测只有 RhineShell 进程，
//   shell.log 无限 "core connection failed"）→ 用户完全无法播放。
//   根因两层：①拉核心的唯一入口是 --spawn-core，而 installer 快捷方式与 zip README 都不带它；
//   ②--core-exe 缺省硬编码为**桩**（RhineCoreStub.exe），真核心 RhineCore.exe 就在同目录却从不被选。
//
// 修复策略（默认值反转，方案 B）：
//   无参数启动 ⇒ 拉起核心，按 「显式 --core-exe > core\RhineCore.exe > core\RhineCoreStub.exe」选择。
//   外部核心（开发脚本/调试自己起核）显式传 --no-spawn-core。
//
// 本文件是**纯逻辑零 WPF 依赖**，便于 WSL 直跑单测（同 TaskbarWriter/OutputPolicy 的"逻辑与 IO 分离"纪律）。
using System.IO;

namespace RhineShell.Hosting;

/// <summary>核心可执行文件的决策结果。</summary>
public sealed record CoreLaunchDecision(string? ExePath, string Reason, bool IsStub)
{
    /// <summary>是否应当拉起核心（路径为空 = 不拉起）。</summary>
    public bool ShouldLaunch => ExePath is not null;
}

public static class CoreLaunch
{
    public const string CoreDirName = "core";
    public const string RealCoreName = "RhineCore.exe";
    public const string StubCoreName = "RhineCoreStub.exe";

    /// <summary>
    /// 决定要拉起哪个核心可执行文件。
    /// </summary>
    /// <param name="explicitExe">显式 <c>--core-exe</c>（null/空 = 未指定）。</param>
    /// <param name="baseDirectory">壳 exe 所在目录（发行版布局：&lt;base&gt;\core\RhineCore.exe）。</param>
    /// <param name="spawnAllowed">是否允许拉起（false = 用户传了 <c>--no-spawn-core</c>，自己管核心）。</param>
    /// <param name="fileExists">文件存在性探测（注入以便单测）。</param>
    public static CoreLaunchDecision Resolve(
        string? explicitExe,
        string baseDirectory,
        bool spawnAllowed,
        Func<string, bool> fileExists)
    {
        if (!spawnAllowed)
        {
            return new CoreLaunchDecision(null, "spawn disabled (--no-spawn-core; external core expected)", false);
        }

        // 优先级 1：显式 --core-exe（开发/测试指定任意核心，包括 dist-host 的真核心）。
        if (!string.IsNullOrWhiteSpace(explicitExe))
        {
            var p = Path.GetFullPath(explicitExe);
            if (fileExists(p))
            {
                return new CoreLaunchDecision(p, $"explicit --core-exe ({Path.GetFileName(p)})",
                    string.Equals(Path.GetFileName(p), StubCoreName, StringComparison.OrdinalIgnoreCase));
            }
            return new CoreLaunchDecision(null, $"explicit --core-exe not found: {p}", false);
        }

        // 优先级 2：随包真核心（**发行版默认要走这条**——修复前硬编码成桩是第二层缺陷）。
        var real = Path.Combine(baseDirectory, CoreDirName, RealCoreName);
        if (fileExists(real))
        {
            return new CoreLaunchDecision(real, "packaged real core (core/RhineCore.exe)", false);
        }

        // 优先级 3：桩（开发树里只有桩时兜底，明确标记 isStub 供日志区分）。
        var stub = Path.Combine(baseDirectory, CoreDirName, StubCoreName);
        if (fileExists(stub))
        {
            return new CoreLaunchDecision(stub, "packaged stub (core/RhineCoreStub.exe)", true);
        }

        return new CoreLaunchDecision(null,
            $"no core found under {Path.Combine(baseDirectory, CoreDirName)}", false);
    }
}
