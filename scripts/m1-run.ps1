<#
.SYNOPSIS
  M1 运行与无人值守验收：拉起核心桩（后台，带 --trace 落盘）+ WPF 壳（前台），
  日志落 %LOCALAPPDATA%\RhineMusic\logs\。M0 的面板取证链已随自检面板一并退役。

.DESCRIPTION
  先运行 scripts/m-build.ps1 产出 dist-host\ 与 dist\。然后：

      pwsh -NoProfile -File scripts/m1-run.ps1                    # 交互运行
      pwsh -NoProfile -File scripts/m1-run.ps1 -KillAfter 30      # 桩 N 秒后模拟崩溃
      pwsh -NoProfile -File scripts/m1-run.ps1 -HaltEvents 8      # 握手后暂停 evt 输出 8s（丢帧验收）
      pwsh -NoProfile -File scripts/m1-run.ps1 -KillShellAfter 40 # N 秒后自动关壳（无人值守）
      pwsh -NoProfile -File scripts/m1-run.ps1 -Scenario full     # 状态机端到端（见 m1-scenario）

.PARAMETER Scenario
  full = 跑 m1-scenario.ps1（play→tick→pause→seek→volume→重启恢复 的脚本化驱动），本脚本只镜像+组环境。

.PARAMETER ExtraStubArgs / ExtraShellArgs
  透传给桩/壳的原始参数。
#>
[CmdletBinding()]
param(
  [string]$DistHost,
  [string]$Pipe,
  [int]$KillAfter = 0,
  [int]$HaltEvents = 0,
  [int]$KillShellAfter = 0,
  [switch]$NoStub,
  [switch]$SpawnCore,
  [switch]$NoCore,
  [switch]$DevTools,
  [switch]$Dev,
  [string]$Scenario,
  [string[]]$ExtraStubArgs = @(),
  [string[]]$ExtraShellArgs = @()
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Write-Step([string]$Text) { Write-Host "`n=== $Text ===" -ForegroundColor Cyan }

$root = (Resolve-Path -LiteralPath (Split-Path -Parent $PSScriptRoot)).ProviderPath

# UNC -> 本地镜像（M0 D6 教训：从 \\wsl.localhost 启动 WPF 壳冷路径挂死分钟级）。
if (-not $PSBoundParameters.ContainsKey('DistHost') -and $root.StartsWith('\\wsl', [StringComparison]::OrdinalIgnoreCase)) {
  $localBin = Join-Path $env:LOCALAPPDATA 'RhineMusic\bin'
  $localWeb = Join-Path $env:LOCALAPPDATA 'RhineMusic\web'
  Write-Step 'mirror dist-host + dist to LOCALAPPDATA (UNC -> local)'
  & cmd.exe /C robocopy (Join-Path $root 'dist-host') $localBin /MIR /NFL /NDL /NJH /NJS /XD bin obj | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "robocopy dist-host mirror failed rc=$LASTEXITCODE" }
  & cmd.exe /C robocopy (Join-Path $root 'dist') $localWeb /MIR /NFL /NDL /NJH /NJS | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "robocopy dist mirror failed rc=$LASTEXITCODE" }
  $DistHost = $localBin
  Write-Host "bin=$localBin  web=$localWeb" -ForegroundColor DarkGray
}
if (-not $DistHost) { $DistHost = Join-Path $root 'dist-host' }
if (-not $Pipe) { $Pipe = '\\.\pipe\rhine-music.core.v1' }

$logDirectory = Join-Path $env:LOCALAPPDATA 'RhineMusic\logs'
New-Item -ItemType Directory -Force -Path $logDirectory | Out-Null
$stubLog = Join-Path $logDirectory 'core-stub.log'
$shellLog = Join-Path $logDirectory 'shell.log'
$traceFile = Join-Path $logDirectory 'core-trace.log'

$shellExe = Join-Path $DistHost 'RhineShell.exe'
$stubExe = Join-Path $DistHost 'core/RhineCoreStub.exe'
foreach ($probe in @($shellExe, $stubExe)) {
  if (-not (Test-Path -LiteralPath $probe)) { throw "missing $probe — run scripts/m-build.ps1 first" }
}

Remove-Item -LiteralPath $stubLog, $shellLog, $traceFile -ErrorAction SilentlyContinue

# 场景模式把执行权交给 m1-scenario.ps1（同一镜像与环境）。
if ($Scenario) {
  $scenario = Join-Path $PSScriptRoot 'm1-scenario.ps1'
  & $scenario -DistHost $DistHost -Pipe $Pipe -Scenario $Scenario -LogDirectory $logDirectory
  exit $LASTEXITCODE
}

$stub = $null
try {
  if (-not $NoStub) {
    Write-Step "core stub  pipe=$Pipe  killAfter=$KillAfter  haltEvents=$HaltEvents"
    $stubArgs = @('--pipe', $Pipe, '--verbose', '--trace', $traceFile)
    if ($KillAfter -gt 0) { $stubArgs += @('--kill-after', $KillAfter) }
    if ($HaltEvents -gt 0) { $stubArgs += @('--halt-events', $HaltEvents) }
    $stubArgs += $ExtraStubArgs
    $stub = Start-Process -FilePath $stubExe -ArgumentList $stubArgs `
      -RedirectStandardOutput $stubLog -PassThru -WindowStyle Hidden
    Write-Host "stub pid=$($stub.Id) log=$stubLog trace=$traceFile" -ForegroundColor DarkGray
    Start-Sleep -Milliseconds 700
    if ($stub.HasExited) { throw "core stub exited immediately (code $($stub.ExitCode)); see $stubLog" }
  }

  Write-Step 'shell (foreground)'
  # R5：壳默认会自己拉起核心；本脚本已自行起核 → 显式声明不重复拉起。
  $shellArgs = @('--pipe', $Pipe)
  if (-not $SpawnCore) { $shellArgs += '--no-spawn-core' }
  if ($SpawnCore) { $shellArgs += '--spawn-core' }
  if ($NoCore) { $shellArgs += '--no-core' }
  if ($DevTools) { $shellArgs += '--devtools' }
  if ($Dev) { $shellArgs += '--dev' }
  $shellArgs += $ExtraShellArgs

  Write-Host "RhineShell.exe $($shellArgs -join ' ')" -ForegroundColor DarkGray
  Write-Host "shell log: $shellLog" -ForegroundColor DarkGray
  $shell = Start-Process -FilePath $shellExe -ArgumentList $shellArgs -PassThru
  if ($KillShellAfter -gt 0) {
    Write-Host "auto-close shell after $KillShellAfter s (unattended)" -ForegroundColor DarkGray
    Start-Sleep -Seconds $KillShellAfter
    try { $shell.CloseMainWindow() | Out-Null } catch { }
    if (-not $shell.WaitForExit(5000)) { $shell.Kill() }
  } else {
    $shell.WaitForExit()
  }
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
foreach ($log in @($stubLog, $shellLog, $traceFile)) {
  if (-not (Test-Path -LiteralPath $log)) { Write-Host "  (missing) $log"; continue }
  Write-Host "  --- $log (last 20 lines) ---" -ForegroundColor DarkGray
  Get-Content -LiteralPath $log -Tail 20 | ForEach-Object { Write-Host "  $_" }
}
