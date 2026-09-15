// R5 单测：核心启动决策（发行版默认必须选**真核心**）。
// 覆盖缺陷：①默认拉起（原仅在 --spawn-core 时拉）②缺省选真核心（原硬编码桩）。
using RhineShell.Hosting;
using Xunit;

namespace RhineShell.Tests;

public class CoreLaunchTests
{
    private static readonly string Base = Path.Combine(Path.GetTempPath(), "rhine-corelaunch-test");

    private static Func<string, bool> Exists(params string[] paths)
    {
        var set = new HashSet<string>(paths, StringComparer.OrdinalIgnoreCase);
        return p => set.Contains(p);
    }

    private static string Real => Path.Combine(Base, "core", "RhineCore.exe");
    private static string Stub => Path.Combine(Base, "core", "RhineCoreStub.exe");

    [Fact]
    public void Default_picks_packaged_real_core()
    {
        // 发行版布局：core/ 下同时有真核心与桩 → 必须选真核心（修复前选桩）。
        var d = CoreLaunch.Resolve(null, Base, spawnAllowed: true, Exists(Real, Stub));
        Assert.True(d.ShouldLaunch);
        Assert.Equal(Real, d.ExePath);
        Assert.False(d.IsStub);
        Assert.Contains("real core", d.Reason);
    }

    [Fact]
    public void Explicit_core_exe_wins()
    {
        var custom = Path.Combine(Base, "dist-host", "RhineCore.exe");
        var d = CoreLaunch.Resolve(custom, Base, spawnAllowed: true, Exists(custom, Real, Stub));
        Assert.Equal(custom, d.ExePath);
        Assert.False(d.IsStub);
    }

    [Fact]
    public void No_spawn_core_disables_launch()
    {
        // 外部核心场景（开发脚本自己起核）：不得再拉一个。
        var d = CoreLaunch.Resolve(null, Base, spawnAllowed: false, Exists(Real, Stub));
        Assert.False(d.ShouldLaunch);
        Assert.Null(d.ExePath);
        Assert.Contains("--no-spawn-core", d.Reason);
    }

    [Fact]
    public void Falls_back_to_stub_when_real_core_absent()
    {
        // 开发树只有桩 → 用桩并如实标记（日志据此区分 core 类型）。
        var d = CoreLaunch.Resolve(null, Base, spawnAllowed: true, Exists(Stub));
        Assert.Equal(Stub, d.ExePath);
        Assert.True(d.IsStub);
    }

    [Fact]
    public void Neither_present_skips_with_readable_reason()
    {
        var d = CoreLaunch.Resolve(null, Base, spawnAllowed: true, Exists());
        Assert.False(d.ShouldLaunch);
        Assert.Contains("no core found", d.Reason);
    }

    [Fact]
    public void Explicit_core_exe_missing_reports_not_found()
    {
        var missing = Path.Combine(Base, "nope", "RhineCore.exe");
        var d = CoreLaunch.Resolve(missing, Base, spawnAllowed: true, Exists(Real, Stub));
        Assert.False(d.ShouldLaunch);
        Assert.Contains("not found", d.Reason);
    }
}
