<#
.SYNOPSIS
  M 系列构建：宿主（.NET 10 WPF + WebView2）发布到 dist-host\，并构建前端 Vite 产物。

.DESCRIPTION
  可用 WSL 或 Windows 侧 PowerShell 7 直接调用；在 WSL 下推荐：

      pwsh.exe -NoProfile -File scripts/m-build.ps1

  前端部分需要 node/npm。若当前会话里没有 npm（在 WSL 里从 Windows 侧 pwsh 启动时常见），
  脚本会自动通过 `wsl.exe -d <发行版>` 在 Linux 侧执行 `npm run build`。

  产物布局（dist-host\）：
      RhineShell.exe / RhineShell.dll / WebView2Loader.dll …   ← 壳（框架依赖，需已装 WebView2 Runtime）
      core\RhineCoreStub.exe                                    ← 核心桩（M1 假引擎）

.EXAMPLE
  pwsh.exe -NoProfile -File scripts/m-build.ps1
  pwsh.exe -NoProfile -File scripts/m-build.ps1 -SkipFrontend     # 只出宿主
  pwsh.exe -NoProfile -File scripts/m-build.ps1 -SkipHost         # 只出前端
#>
[CmdletBinding()]
param(
  [string]$Configuration = 'Release',
  [string]$OutputDirectory,
  [ValidateSet('auto', 'wsl', 'native')]
  [string]$FrontendRunner = 'auto',
  [switch]$SkipFrontend,
  [switch]$SkipHost
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# NuGet 在本机需要走代理（任务书给定 127.0.0.1:7897）；已设置则保留。
if (-not $env:HTTPS_PROXY) { $env:HTTPS_PROXY = 'http://127.0.0.1:7897' }
if (-not $env:HTTP_PROXY) { $env:HTTP_PROXY = $env:HTTPS_PROXY }

function Write-Step([string]$Text) { Write-Host "`n=== $Text ===" -ForegroundColor Cyan }

function Get-RepoRoot {
  # $PSScriptRoot 可能是 UNC 路径（\\wsl.localhost\Ubuntu\...），统一规范化。
  $root = Split-Path -Parent $PSScriptRoot
  return (Resolve-Path -LiteralPath $root).ProviderPath
}

function Get-LinuxRoot([string]$WindowsRoot) {
  if ($WindowsRoot -notmatch '^\\\\wsl(\.localhost|\$)\\[^\\]+\\(.*)$') { return $null }
  return '/' + ($Matches[2] -replace '\\', '/')
}

function Get-WslDistro([string]$WindowsRoot) {
  if ($WindowsRoot -match '^\\\\wsl(\.localhost|\$)\\([^\\]+)\\') { return $Matches[2] }
  return $null
}

function Invoke-FrontendBuild([string]$Root) {
  $linuxRoot = Get-LinuxRoot $Root
  $npm = Get-Command npm -ErrorAction SilentlyContinue

  $useWsl = $FrontendRunner -eq 'wsl' -or ($FrontendRunner -eq 'auto' -and $null -eq $npm)
  if ($useWsl) {
    if ($null -eq $linuxRoot) {
      throw "npm not found in this session and the repository is not on a WSL UNC path; run this script inside WSL instead."
    }
    $distro = Get-WslDistro $Root
    $distroArgs = if ($distro) { @('-d', $distro) } else { @() }
    $command = "cd '$linuxRoot' && npm run build"
    Write-Host "runner=wsl distro=$distro path=$linuxRoot" -ForegroundColor DarkGray
    & wsl.exe @distroArgs -e bash -lc $command
  }
  else {
    Write-Host "runner=native npm=$($npm.Source)" -ForegroundColor DarkGray
    Push-Location $Root
    try { & npm run build } finally { Pop-Location }
  }

  if ($LASTEXITCODE -ne 0) { throw "frontend build failed with exit code $LASTEXITCODE" }
}

function Invoke-HostPublish([string]$Root, [string]$Out) {
  $projects = @(
    @{ Name = 'RhineShell';    Path = 'host/RhineShell/RhineShell.csproj';         Destination = $Out }
    @{ Name = 'RhineCoreStub'; Path = 'host/RhineCoreStub/RhineCoreStub.csproj';   Destination = (Join-Path $Out 'core') }
  )

  $log = New-Object System.Collections.Generic.List[string]
  foreach ($project in $projects) {
    $csproj = Join-Path $Root $project.Path
    if (-not (Test-Path -LiteralPath $csproj)) { throw "missing project: $csproj" }
    Write-Host "publishing $($project.Name) -> $($project.Destination)" -ForegroundColor DarkGray

    $output = & dotnet publish $csproj -c $Configuration -o $project.Destination --nologo 2>&1
    $exit = $LASTEXITCODE
    $output | ForEach-Object { $log.Add([string]$_) }
    if ($exit -ne 0) {
      $output | ForEach-Object { Write-Host $_ }
      throw "dotnet publish $($project.Name) failed with exit code $exit"
    }
  }

  $warnings = @($log | Where-Object { $_ -match ':\s*(warning|error)\s+[A-Z]+\d+' })
  Write-Host "dotnet publish output lines: $($log.Count); warning/error lines: $($warnings.Count)" -ForegroundColor DarkGray
  if ($warnings.Count -gt 0) {
    $warnings | ForEach-Object { Write-Host $_ -ForegroundColor Yellow }
    throw "host build produced warnings/errors (TreatWarningsAsErrors should have failed the build)"
  }
}

$root = Get-RepoRoot
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $root 'dist-host' }
$OutputDirectory = [System.IO.Path]::GetFullPath($OutputDirectory)

Write-Step "M build  root=$root  out=$OutputDirectory  config=$Configuration"

if (-not $SkipHost) {
  Write-Step 'host (dotnet publish)'
  New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
  Invoke-HostPublish $root $OutputDirectory
}

if (-not $SkipFrontend) {
  Write-Step 'frontend (npm run build)'
  Invoke-FrontendBuild $root
}

Write-Step 'results'
foreach ($probe in @(
    @{ Label = 'dist/index.html';            Path = (Join-Path $root 'dist/index.html') }
    @{ Label = 'dist-host/RhineShell.exe';   Path = (Join-Path $OutputDirectory 'RhineShell.exe') }
    @{ Label = 'dist-host/core/RhineCoreStub.exe'; Path = (Join-Path $OutputDirectory 'core/RhineCoreStub.exe') }
  )) {
  $state = if (Test-Path -LiteralPath $probe.Path) { 'OK  ' } else { 'MISS' }
  $color = if ($state -eq 'OK  ') { 'Green' } else { 'Red' }
  Write-Host "  [$state] $($probe.Label)" -ForegroundColor $color
  if (-not (Test-Path -LiteralPath $probe.Path)) { $script:missing = $true }
}

if ($script:missing) { exit 1 }
Write-Host "`nM build OK" -ForegroundColor Green
