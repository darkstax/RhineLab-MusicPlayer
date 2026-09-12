<#
.SYNOPSIS
  M0 运行：拉起核心桩（后台）+ 启动 WPF 壳（前台），日志落 %LOCALAPPDATA%\RhineMusic\m0\logs\。

.DESCRIPTION
  先运行 scripts/m0-build.ps1 产出 dist-host\ 与 dist\。然后：

      pwsh -NoProfile -File scripts/m0-run.ps1

  常用验收场景：
      # 验收 3/4：30 秒后桩模拟崩溃，观察断流 → 退避重连 → 计数恢复
      pwsh -NoProfile -File scripts/m0-run.ps1 -KillAfter 30

      # 无人值守取证：25 秒时把页面自检面板文本写入文件并退出
      pwsh -NoProfile -File scripts/m0-run.ps1 -KillAfter 12 -SelfCheckDump out.txt -SelfCheckAfter 25

      # 只跑壳（不拉起桩），用于验收 1 的「dist 缺失提示页」等
      pwsh -NoProfile -File scripts/m0-run.ps1 -NoStub

.PARAMETER KillAfter
  传给桩的 --kill-after 秒数（模拟核心崩溃）。0 表示不模拟。

.PARAMETER SelfCheckDump
  透传壳的 --selfcheck-dump：把页面 #m0-selfcheck 面板文本写入该路径后退出壳。

.PARAMETER ExtraShellArgs
  追加给 RhineShell.exe 的原始参数（如 --no-core）。
#>
[CmdletBinding()]
param(
  [string]$DistHost,
  [string]$Pipe,
  [int]$KillAfter = 0,
  [switch]$NoStub,
  [switch]$SpawnCore,
  [switch]$NoCore,
  [switch]$DevTools,
  [string]$SelfCheckDump,
  [double]$SelfCheckAfter = 20,
  [string[]]$ExtraShellArgs = @()
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Write-Step([string]$Text) { Write-Host "`n=== $Text ===" -ForegroundColor Cyan }

$root = (Resolve-Path -LiteralPath (Split-Path -Parent $PSScriptRoot)).ProviderPath
if (-not $DistHost) { $DistHost = Join-Path $root 'dist-host' }
if (-not $Pipe) { $Pipe = '\\.\pipe\rhine-music.core.v1' }

# WSL 仓库的产物在 \\wsl.localhost UNC 路径上：实测从 UNC 启动 GUI 宿主（WPF/WebView2）
# 冷路径下会挂死分钟级且不稳定，而控制台 stub 不受影响。默认把宿主与前端镜像到
# %LOCALAPPDATA%\RhineMusic\m0\ 本地目录再启动（web 子目录正好命中 ShellOptions 的
# dist fallback，壳无需额外参数）。显式传 -DistHost 时尊重用户选择，不做镜像。
$mirrored = $false
if (-not $PSBoundParameters.ContainsKey('DistHost') -and $root.StartsWith('\\wsl', [StringComparison]::OrdinalIgnoreCase)) {
  $localBin = Join-Path $env:LOCALAPPDATA 'RhineMusic\m0\bin'
  $localWeb = Join-Path $env:LOCALAPPDATA 'RhineMusic\m0\web'
  Write-Step 'mirror dist-host + dist to LOCALAPPDATA (UNC -> local)'
  robocopy (Join-Path $root 'dist-host') $localBin /MIR /NFL /NDL /NJH /NJS | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "robocopy dist-host mirror failed rc=$LASTEXITCODE" }
  robocopy (Join-Path $root 'dist') $localWeb /MIR /NFL /NDL /NJH /NJS | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "robocopy dist mirror failed rc=$LASTEXITCODE" }
  $mirrored = $true
  $DistHost = $localBin
  Write-Host "bin=$localBin  web=$localWeb" -ForegroundColor DarkGray
}

$logDirectory = Join-Path $env:LOCALAPPDATA 'RhineMusic\m0\logs'
New-Item -ItemType Directory -Force -Path $logDirectory | Out-Null
$stubLog = Join-Path $logDirectory 'core-stub.log'
$shellLog = Join-Path $logDirectory 'shell.log'

$shellExe = Join-Path $DistHost 'RhineShell.exe'
$stubExe = Join-Path $DistHost 'core/RhineCoreStub.exe'
foreach ($probe in @($shellExe, $stubExe)) {
  if (-not (Test-Path -LiteralPath $probe)) {
    throw "missing $probe — run scripts/m0-build.ps1 first"
  }
}

# 清掉上一轮日志，避免验收时看到陈旧行。
Remove-Item -LiteralPath $stubLog, $shellLog -ErrorAction SilentlyContinue

$stub = $null
try {
  if (-not $NoStub) {
    Write-Step "core stub  pipe=$Pipe  killAfter=$(if ($KillAfter -gt 0) { $KillAfter } else { 'off' })"
    $stubArgs = @('--pipe', $Pipe, '--verbose')
    if ($KillAfter -gt 0) { $stubArgs += @('--kill-after', $KillAfter) }
    $stub = Start-Process -FilePath $stubExe -ArgumentList $stubArgs `
      -RedirectStandardOutput $stubLog -PassThru -WindowStyle Hidden
    Write-Host "stub pid=$($stub.Id) log=$stubLog" -ForegroundColor DarkGray
    Start-Sleep -Milliseconds 700
    if ($stub.HasExited) {
      throw "core stub exited immediately (code $($stub.ExitCode)); see $stubLog"
    }
  }

  Write-Step 'shell (foreground)'
  $shellArgs = @('--pipe', $Pipe)
  if ($SpawnCore) { $shellArgs += '--spawn-core' }
  if ($NoCore) { $shellArgs += '--no-core' }
  if ($DevTools) { $shellArgs += '--devtools' }
  if ($SelfCheckDump) {
    # 允许传 WSL 路径（/home/...）；壳是 Windows 进程，统一转成 Windows 绝对路径。
    $dumpPath = $SelfCheckDump
    if ($dumpPath.StartsWith('/')) {
      $dumpPath = (& wsl.exe -e wslpath -w $dumpPath).Trim()
      if ($LASTEXITCODE -ne 0 -or -not $dumpPath) { throw "cannot translate WSL path: $SelfCheckDump" }
    }
    $dumpPath = [System.IO.Path]::GetFullPath($dumpPath)
    Write-Host "selfcheck dump: $dumpPath (after $SelfCheckAfter s)" -ForegroundColor DarkGray
    $shellArgs += @('--selfcheck-dump', $dumpPath)
    $shellArgs += @('--selfcheck-after', $SelfCheckAfter.ToString([System.Globalization.CultureInfo]::InvariantCulture))
  }
  $shellArgs += $ExtraShellArgs

  Write-Host "RhineShell.exe $($shellArgs -join ' ')" -ForegroundColor DarkGray
  Write-Host "shell log: $shellLog" -ForegroundColor DarkGray
  $shell = Start-Process -FilePath $shellExe -ArgumentList $shellArgs -PassThru
  $shell.WaitForExit()
  Write-Host "`nshell exit code: $($shell.ExitCode)" -ForegroundColor DarkGray
}
finally {
  if ($stub -and -not $stub.HasExited) {
    Write-Step 'stop core stub'
    try { $stub.CloseMainWindow() | Out-Null } catch { }
    if (-not $stub.WaitForExit(2000)) { $stub.Kill() }
    Write-Host "stub stopped (exit $($stub.ExitCode))" -ForegroundColor DarkGray
  }
}

Write-Step 'logs'
foreach ($log in @($stubLog, $shellLog)) {
  if (-not (Test-Path -LiteralPath $log)) { Write-Host "  (missing) $log"; continue }
  Write-Host "  --- $log (last 20 lines) ---" -ForegroundColor DarkGray
  Get-Content -LiteralPath $log -Tail 20 | ForEach-Object { Write-Host "  $_" }
}
