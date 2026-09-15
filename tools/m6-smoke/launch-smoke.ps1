# R5 冒烟（Tier-1 结构断言）：发行版布局下**零参数**启动壳 → 必须拉起随包真核心并握手。
# 覆盖缺陷：发行版双击 RhineShell.exe 无核心在跑（用户完全无声）。
# 用法：pwsh -File launch-smoke.ps1 [-Root <发行版目录>] [-SkipPlay]
param(
  [string]$Root = "$PSScriptRoot\..\..\dist-release\stage",
  [switch]$SkipPlay,
  [int]$WaitSec = 25
)
$ErrorActionPreference = 'Continue'
$fail = 0
function Assert([bool]$ok, [string]$name) {
  if ($ok) { Write-Host "  ok   $name" -ForegroundColor Green }
  else { Write-Host "  FAIL $name" -ForegroundColor Red; $script:fail++ }
}

$shellExe = Join-Path $Root 'RhineShell.exe'
$coreExe  = Join-Path $Root 'core\RhineCore.exe'
Assert (Test-Path $shellExe) "发行版壳存在：$shellExe"
Assert (Test-Path $coreExe)  "随包真核心存在：$coreExe"
if (-not (Test-Path $shellExe)) { exit 1 }

$log = "$env:LOCALAPPDATA\RhineMusic\logs\shell.log"
$before = if (Test-Path $log) { (Get-Item $log).Length } else { 0 }
Get-Process RhineShell,RhineCore,RhineCoreStub -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Milliseconds 800

# ★ 关键：**零参数**启动（与用户双击 exe / installer 快捷方式完全一致）
$shell = Start-Process -FilePath $shellExe -PassThru
Start-Sleep -Seconds $WaitSec

$procs = Get-Process RhineShell,RhineCore,RhineCoreStub -ErrorAction SilentlyContinue
$shellP = $procs | Where-Object ProcessName -eq 'RhineShell' | Select-Object -First 1
$coreP  = $procs | Where-Object { $_.ProcessName -in @('RhineCore','RhineCoreStub') } | Select-Object -First 1
Assert ($null -ne $shellP) "壳进程在跑（pid=$($shellP.Id)）"
Assert ($null -ne $coreP)  "核心进程被自动拉起（$(if($coreP){"$($coreP.ProcessName) pid=$($coreP.Id)"}else{'无'})）"
Assert ($coreP -and $coreP.ProcessName -eq 'RhineCore') "拉起的是**真核心** RhineCore（非桩）"

# 日志断言
$tail = if (Test-Path $log) { Get-Content $log -Raw | Select-Object -Skip 0 } else { '' }
$new = if (Test-Path $log) {
  $fs = [IO.File]::Open($log,'Open','Read','ReadWrite'); $fs.Seek($before,'Begin') | Out-Null
  $sr = New-Object IO.StreamReader($fs); $t = $sr.ReadToEnd(); $sr.Close(); $fs.Close(); $t
} else { '' }
Assert ($new -match 'spawned core pid=') 'shell.log 有 "spawned core pid=" 记录'
Assert ($new -match 'core ready|hello from|core connection ok') '壳与核心握手成功（非无限重连失败）'
Assert ($new -notmatch 'core connection failed') '无 "core connection failed"（缺陷特征）'

# 清理
Get-Process RhineShell,RhineCore,RhineCoreStub -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Milliseconds 600
$left = Get-Process RhineShell,RhineCore,RhineCoreStub -ErrorAction SilentlyContinue
Assert ($null -eq $left) '关窗后无残留进程（owned core 一并结束）'

if ($script:fail -eq 0) { Write-Host 'M6-LAUNCH-SMOKE-PASS' -ForegroundColor Green; exit 0 }
Write-Host "M6-LAUNCH-SMOKE-FAIL ($script:fail)" -ForegroundColor Red; exit 1
