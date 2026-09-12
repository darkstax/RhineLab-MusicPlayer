<#
.SYNOPSIS
  M2 构建：C++ 音频核心 RhineCore.exe（MSVC x64 Release + CMake）。

.DESCRIPTION
  vswhere 定位 VS BuildTools 18 → 把 host/ 镜像到本地盘（UNC 下 msbuild/cl 有坑）→
  cmake configure + build → 产物拷回 dist-host\core\RhineCore.exe → 输出错误/警告计数。

  推荐经 Windows 侧 PowerShell 7 调用（pwsh.exe）：
      pwsh.exe -NoProfile -File scripts/m2-build.ps1

  说明：/W4 只管本工程 TU；vendor（miniaudio/json.hpp）经 /external:I + /external:W0
  隔离，不计入「零警告」验收线（docs/M2-PLAN.md 验收 1）。

.EXAMPLE
  pwsh.exe -NoProfile -File scripts/m2-build.ps1               # 全量（首次 configure）
  pwsh.exe -NoProfile -File scripts/m2-build.ps1 -Configure    # 仅重新 configure
  pwsh.exe -NoProfile -File scripts/m2-build.ps1 -MirrorOnly   # 只同步镜像（调试用）
#>
[CmdletBinding()]
param(
  [string]$Configuration = 'Release',
  [string]$MirrorRoot = 'C:\Users\StarL\m2-work',
  [switch]$Configure,
  [switch]$MirrorOnly
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Write-Step([string]$Text) { Write-Host "`n=== $Text ===" -ForegroundColor Cyan }

# —— 1. 定位工具链 ——
Write-Step 'toolchain'
$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
if (-not (Test-Path -LiteralPath $vswhere)) { throw "vswhere not found: $vswhere" }
$vsPath = (& $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath |
  Select-Object -First 1)
if (-not $vsPath) { throw 'no Visual Studio with VC tools found (expected BuildTools 18)' }
$cmake = Join-Path $vsPath 'Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe'
if (-not (Test-Path -LiteralPath $cmake)) { throw "cmake not found: $cmake" }
Write-Host "vs=`$vsPath  cmake=$cmake" -ForegroundColor DarkGray

# —— 2. 镜像 host → 本地盘（robocopy /XD 排除 bin/obj/build）——
Write-Step 'mirror (robocopy host -> local)'
$repoRoot = Split-Path -Parent $PSScriptRoot
$srcHost = Join-Path $repoRoot 'host'
if (-not (Test-Path -LiteralPath $srcHost)) { throw "missing $srcHost" }
$dstHost = Join-Path $MirrorRoot 'host'
New-Item -ItemType Directory -Force -Path $dstHost | Out-Null
# /MIR 会删除目标多余文件——目标专属镜像目录，安全。
& robocopy $srcHost $dstHost /MIR /XD bin obj build .vs /NFL /NDL /NJH /NJS /R:1 /W:1 | Out-Null
$rc = $LASTEXITCODE
if ($rc -ge 8) { throw "robocopy failed with code $rc" }
Write-Host "robocopy code=$rc  $srcHost -> $dstHost" -ForegroundColor DarkGray
$srcCore = Join-Path $repoRoot 'host/core'
$dstCore = Join-Path $dstHost 'core'
if ($MirrorOnly) { Write-Host 'MirrorOnly: done' -ForegroundColor Green; exit 0 }

# —— 3. cmake configure + build ——
Write-Step 'cmake configure'
$buildDir = Join-Path $dstCore 'build'
$arguments = @('-S', "$dstCore", '-B', "$buildDir", '-A', 'x64')
& $cmake @arguments 2>&1 | Tee-Object -Variable configureLog | Out-Host
if ($LASTEXITCODE -ne 0) { throw "cmake configure failed (exit $LASTEXITCODE)" }

if ($Configure -and -not $MirrorOnly) { Write-Host 'Configure-only requested; skipping build.' }

Write-Step "cmake build ($Configuration)"
& $cmake --build $buildDir --config $Configuration --parallel 2>&1 | Tee-Object -Variable buildLog | Out-Host
$buildExit = $LASTEXITCODE

# —— 4. 结果摘要（错误/警告计数，vendor 告警不计）——
$lines = @($configureLog) + @($buildLog) | ForEach-Object { [string]$_ }
$errors = @($lines | Where-Object { $_ -match ': error ' })
$warnings = @($lines | Where-Object { $_ -match ': warning ' -and $_ -notmatch '\\vendor\\|\\build\\' })
Write-Step 'summary'
Write-Host "errors=$($errors.Count) warnings(project)=$($warnings.Count) exit=$buildExit"
$errors | Select-Object -First 30 | ForEach-Object { Write-Host $_ -ForegroundColor Red }
$warnings | Select-Object -First 30 | ForEach-Object { Write-Host $_ -ForegroundColor Yellow }
if ($buildExit -ne 0) { throw "cmake build failed (exit $buildExit)" }

# —— 5. 拷产物回仓库 dist-host\core\ ——
$exe = Get-ChildItem -Path $buildDir -Recurse -Filter 'RhineCore.exe' |
  Where-Object { $_.FullName -match "\\$Configuration\\" } | Select-Object -First 1
if (-not $exe) { throw "RhineCore.exe not found under $buildDir" }
$outDir = Join-Path $repoRoot 'dist-host\core'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
Copy-Item -LiteralPath $exe.FullName -Destination (Join-Path $outDir 'RhineCore.exe') -Force
Write-Host "copied $($exe.FullName) -> $outDir\RhineCore.exe ($([math]::Round($exe.Length/1KB)) KB)"
Write-Host "`nm2 build OK" -ForegroundColor Green
