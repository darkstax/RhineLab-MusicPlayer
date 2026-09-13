<#
.SYNOPSIS
  M3 验收 3：SMTC 真机无人值守验证。必须经 **Windows PowerShell 5.1（powershell.exe）** 跑——
  pwsh 7 下 Windows.Media WinRT 投影类型加载失败（M3 实测），本脚本内已注明。

.DESCRIPTION
  链路：桩（默认，协议裁判同款）或真核心 + 壳（--remote-debug-port 9240，独立管道）
  → CDP 经真桥发 engine.play（模拟前端真实动作）→ 本脚本用
  GlobalSystemMediaTransportControlsSessionManager 枚举会话断言：
    1) 出现本应用 session（SourceAppUserModelId 含 RhineShell）
    2) PlaybackInfo.PlaybackStatus=Playing；MediaProperties.Title 非空（占位=track 标签）；
       Timeline.Position 3s 推进 ≥1s（桩时钟）
    3) session.TryTogglePlayPauseAsync() 远程注入 → 核心/桩日志见 engine.toggle
       （cmd 转发链闭环，入站方向验证）；状态回 Paused
    4) 再 toggle 回 Playing；TryStopAsync → Stopped
  降级条款（任务书验收 3）：WinRT 投影不可用/session 枚举不到时输出
  SMTC-CHECK-DEGRADED + 壳日志注册断言，并把飞屏人工验证列入停点——不假称已验。

.NOTES
  ⚠ 默认（桩）模式只能验到 "smtc registered"：桩不发声，Windows 对**无活动音频会话**的进程
  会忽略其 SMTC 状态更新（session 出现但 PlaybackInfo/MediaProperties 全 null 的"幽灵会话"，
  2026-09-13 实测定性）——这是系统行为非产品缺陷。**完整四段断言必须 -RealCore**（真核心
  有真音频会话，出站/入站/时间线/远程控制全链路可验，SMTC-CHECK-PASS 已达成）。

.EXAMPLE
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools\m3-smoke\smtc-check.ps1
  powershell.exe ... -RealCore    # 真音频核心（火石.flac，时长 9.8s，跳时间线推进断言）
#>
[CmdletBinding()]
param(
  [string]$DistHost = 'C:\Users\StarL\m3-work\dist-host',
  [string]$WebDist  = 'C:\Users\StarL\m3-work\web\dist',
  [string]$WorkDir  = 'C:\Users\StarL\m3-work',
  [int]$CdpPort = 9240,
  [switch]$RealCore
)

$ErrorActionPreference = 'Stop'
$pipe = 'rhine-music.m3.smtc'
$shellLogPath = Join-Path $env:LOCALAPPDATA 'RhineMusic\logs\shell.log'
$coreLog  = Join-Path $WorkDir 'm3-smtc-core.log'
Remove-Item -LiteralPath $coreLog -ErrorAction SilentlyContinue
$shellBaseline = 0
if (Test-Path -LiteralPath $shellLogPath) {
  $shellBaseline = (Get-Content -LiteralPath $shellLogPath | Measure-Object -Line).Lines
}

function Kill-WebviewGroup {
  # 坑①：WebView2 按 userData 分组复用——按命令行清掉本机 RhineMusic 组（PS5.1 走 CIM）。
  Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match 'RhineMusic' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

function Cleanup {
  Kill-WebviewGroup
  Get-Process RhineShell -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  if ($script:coreProc -and -not $script:coreProc.HasExited) {
    Stop-Process -Id $script:coreProc.Id -Force -ErrorAction SilentlyContinue
  }
}

function Fail([string]$msg) {
  Write-Host "SMTC-CHECK-FAIL: $msg" -ForegroundColor Red
  Write-Host '--- shell log (new lines) ---'
  if (Test-Path -LiteralPath $shellLogPath) {
    Get-Content -LiteralPath $shellLogPath | Select-Object -Skip $shellBaseline -Last 25 | ForEach-Object { Write-Host "  $_" }
  }
  Write-Host '--- core log tail ---'
  if (Test-Path -LiteralPath $coreLog) {
    Get-Content -LiteralPath $coreLog -Tail 25 | ForEach-Object { Write-Host "  $_" }
  }
  Cleanup
  exit 1
}

function ShellLogNew {
  if (-not (Test-Path -LiteralPath $shellLogPath)) { return @() }
  @(Get-Content -LiteralPath $shellLogPath | Select-Object -Skip $shellBaseline)
}

# —— 0. WinRT 投影可用性（不可用 → 降级条款）——
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager,Windows.Media,ContentType=WindowsRuntime]
} catch {
  Write-Host "SMTC-CHECK-DEGRADED: WinRT projection unavailable ($($_.Exception.Message))" -ForegroundColor Yellow
  Write-Host '降级：仅能靠壳日志 smtc registered + 飞屏人工验证（停点清单）'
  exit 2
}

$asTaskOfT = ([System.WindowsRuntimeSystemExtensions].GetMethods() |
  Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
                 $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
function Await($op, $ResultType) {
  $net = $asTaskOfT.MakeGenericMethod($ResultType).Invoke($null, @($op))
  if (-not $net.Wait(15000)) { throw 'WinRT op timed out (15s)' }
  return $net.Result
}

$coreExe = if ($RealCore) { Join-Path $DistHost 'core\RhineCore.exe' } else { Join-Path $DistHost 'core\RhineCoreStub.exe' }
$shellExe = Join-Path $DistHost 'RhineShell.exe'
foreach ($p in @($shellExe, $coreExe)) { if (-not (Test-Path -LiteralPath $p)) { Fail "missing $p" } }

Cleanup
Write-Host "=== launch $(if($RealCore){'REAL CORE'}else{'stub'}) pipe=$pipe ==="
$script:coreProc = Start-Process -FilePath $coreExe -ArgumentList @('--pipe', $pipe, '--verbose') `
  -WorkingDirectory $WorkDir -PassThru -WindowStyle Hidden -RedirectStandardOutput $coreLog
Start-Sleep -Milliseconds 900
if ($script:coreProc.HasExited) { Fail "core exited early code=$($script:coreProc.ExitCode)" }

Write-Host "=== launch shell (cdp=$CdpPort) ==="
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$CdpPort"
# 接管修正：壳不重定向 stdout 时会继承控制台句柄——外层 `pwsh -File` 会等子进程句柄关闭
# 而不返回（无人值守挂死）。壳自身日志已落 shell.log，这里只隔离句柄。
$shellOut = Join-Path $WorkDir 'm3-smtc-shell.out'
$shell = Start-Process -FilePath $shellExe -ArgumentList @('--pipe', $pipe, '--dist', $WebDist) `
  -WorkingDirectory $WorkDir -PassThru -WindowStyle Hidden `
  -RedirectStandardOutput $shellOut -RedirectStandardError (Join-Path $WorkDir 'm3-smtc-shell.err')
Write-Host "shell pid=$($shell.Id) core pid=$($script:coreProc.Id)"

Write-Host '=== assert shell log: smtc registered ==='
$deadline = (Get-Date).AddSeconds(30)
$registered = $false
while ((Get-Date) -lt $deadline) {
  $lines = ShellLogNew
  if ($lines | Select-String 'smtc registration failed' -Quiet) {
    ($lines | Select-String 'smtc registration failed' | Select-Object -First 1) | ForEach-Object { Write-Host "  $_" }
    Fail 'shell logged smtc registration FAILED (registration threw)'
  }
  if ($lines | Select-String 'smtc registered' -Quiet) { $registered = $true; break }
  Start-Sleep -Milliseconds 500
}
if (-not $registered) { Fail 'no "smtc registered" shell log within 30s' }
Write-Host 'smtc registered ok'

Write-Host '=== wait CDP page ready ==='
# Windows 侧无 node（本机事实）：CDP 助手经 wsl.exe 的 node 跑（M1 e2e 同套路），
# 参数用 Linux 路径；坑③ NO_PROXY='*' 在 bash 内联注入。
$cdpUnix = '/home/starl/ai-code/RhineLab-MusicPlayer/tools/m3-smoke/m3-cdp.mjs'
function WslNode([string]$script, [string[]]$nodeArgs) {
  # 接管修正：PowerShell → wsl.exe → bash -lc 三层引号/编码下，含中文与空格的 track_id
  # 会被拆词/乱码（实测单引号包参丢引号、env 传参中文损耗）。改为**参数写 JSON 文件**，
  # node 侧 `@<path>` 读回（m3-cdp.mjs 已支持）；文件放 WSL 的 /tmp（UNC 前缀写入）。
  $idx = Get-Random -Maximum 99999
  $linuxArgs = "/tmp/m3-args-$idx.json"
  $tmpWin = Join-Path '\\wsl.localhost\Ubuntu' 'tmp'
  $json = ConvertTo-Json -InputObject @($nodeArgs) -Compress
  New-Item -ItemType Directory -Force -Path $tmpWin | Out-Null
  $file = Join-Path $tmpWin "m3-args-$idx.json"
  [IO.File]::WriteAllText($file, $json, [Text.UTF8Encoding]::new($false))
  # 坑③全形态：WSL 继承的 Windows 代理变量（大小写）会劫持 127.0.0.1 —— 全部清掉再走。
  $cmd = "unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy NO_PROXY no_proxy; export NO_PROXY='*' RHINE_PW_CORE=/tmp/pwtest/node_modules/playwright-core/index.mjs; node $script @$linuxArgs 2>&1"
  # node 向 stderr 输出不得以 NativeCommandError 炸穿 ErrorActionPreference=Stop：函数内局部降级。
  $prior = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $out = @(& wsl.exe -e bash -lc $cmd | ForEach-Object { [string]$_ })
  $ErrorActionPreference = $prior
  Remove-Item -LiteralPath $file -ErrorAction SilentlyContinue
  return $out
}
$deadline = (Get-Date).AddSeconds(90)
$probe = $null
while ((Get-Date) -lt $deadline) {
  $lines = @(WslNode $cdpUnix @($CdpPort, 'state'))
  $probe = $lines | Where-Object { $_ -match '"engine"' } | Select-Object -Last 1
  if ($probe) { break }
  Start-Sleep -Seconds 3
}
if ($probe -notmatch '"engine"') { Fail 'CDP page not ready in 60s' }
Write-Host "page ok: $probe"

Write-Host '=== engine.play via real bridge ==='
$trackId = if ($RealCore) { 'file:C:\Users\StarL\Music\流浪地球 电影原声大碟\火石.flac' } else { 'X-042' }
# 接管修正：统一走 m3-cdp.mjs 的 play 模式（已支持 @args JSON 文件传参；旧 cdp-play.mjs
# 直接读 argv，在三层引号下拿不到带空格的中文路径）。
$playLines = @(WslNode $cdpUnix @($CdpPort, 'play', $trackId))
$playOut = $playLines | Where-Object { $_ -match '"ok"' } | Select-Object -Last 1
Write-Host "play -> $playOut"
if ($playOut -notmatch '"ok":\s*true') { Fail "bridge engine.play failed: $($playLines -join ' | ')" }
Start-Sleep -Seconds 2

# —— 2. 枚举 SMTC 会话 ——
Write-Host '=== enumerate SMTC sessions ==='
$mgrType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager,Windows.Media,ContentType=WindowsRuntime]
$propsType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties,Windows.Media,ContentType=WindowsRuntime]
# 接管修正（M3 实测）：会话侧状态属性是 PlaybackInfo.PlaybackStatus（非 PlayStatus），
# 枚举类型是 GlobalSystemMediaTransportControlsSessionPlaybackStatus（非 Windows.Media.MediaPlaybackStatus，
# 跨投影 -eq 比较永假）——统一用字符串比较，稳定且可读。
$mgr = Await ($mgrType::RequestAsync()) $mgrType
$mine = $null
$deadline = (Get-Date).AddSeconds(20)
while ((Get-Date) -lt $deadline -and -not $mine) {
  foreach ($s in @($mgr.GetSessions())) {
    if ($s.SourceAppUserModelId -match 'RhineShell') { $mine = $s; break }
  }
  if (-not $mine) { Start-Sleep -Milliseconds 500 }
}
Write-Host "sessions=$(@($mgr.GetSessions()).Count)"
foreach ($s in @($mgr.GetSessions())) {
  Write-Host ("  session source='{0}' status={1}" -f $s.SourceAppUserModelId, $s.GetPlaybackInfo().PlaybackStatus)
}
if (-not $mine) { Fail 'no session with SourceAppUserModelId containing RhineShell' }

$playback = $mine.GetPlaybackInfo()
Write-Host "our session status=$($playback.PlaybackStatus) enabledControls=$($playback.Controls)"
if ("$($playback.PlaybackStatus)" -ne 'Playing') { Fail "PlaybackStatus != Playing (got $($playback.PlaybackStatus))" }
Write-Host 'PlaybackStatus=Playing ok'

$props = Await ($mine.TryGetMediaPropertiesAsync()) $propsType
Write-Host "Title='$($props.Title)' Artist='$($props.Artist)'"
if ([string]::IsNullOrEmpty($props.Title)) { Fail 'SMTC Title empty (placeholder wiring broken)' }

$timeline = $mine.GetTimelineProperties()
$posA = $timeline.Position.TotalMilliseconds
Write-Host "timeline posA=$posA end=$($timeline.EndTime.TotalMilliseconds)"
if (-not $RealCore) {
  Start-Sleep -Seconds 3
  $posB = $mine.GetTimelineProperties().Position.TotalMilliseconds
  Write-Host "timeline posB=$posB (after 3s)"
  if ($posB -le $posA + 1000) { Fail "timeline not advancing ($posA -> $posB)" }
} else {
  Write-Host 'real core 9.8s 曲：推进断言改看 posA>0（起播即有位置）'
  if ($posA -le 0) { Fail 'real-core timeline position is 0 while playing' }
}

# —— 3. 远程注入 TogglePlayPause → 核心日志 engine.toggle ——
Write-Host '=== remote TryTogglePlayPauseAsync (pause leg) ==='
$toggleOk = Await ($mine.TryTogglePlayPauseAsync()) ([bool])
Write-Host "TryTogglePlayPauseAsync -> $toggleOk"
if (-not $toggleOk) { Fail 'TryTogglePlayPauseAsync returned false (control unavailable?)' }
$deadline = (Get-Date).AddSeconds(6)
$seenToggle = $false
$tail = @()
while ((Get-Date) -lt $deadline) {
  $tail = @(Get-Content -LiteralPath $coreLog -Tail 60 -ErrorAction SilentlyContinue)
  if ($tail | Select-String 'engine\.toggle' -Quiet) { $seenToggle = $true; break }
  Start-Sleep -Milliseconds 300
}
if (-not $seenToggle) { Fail 'core/stub log has no engine.toggle after remote toggle' }
Write-Host 'engine.toggle reached core log ok'
$tail | Select-String 'smtc-' | Select-Object -First 2 | ForEach-Object { Write-Host "  $_" }

$deadline = (Get-Date).AddSeconds(6)
while ((Get-Date) -lt $deadline) {
  if ("$($mine.GetPlaybackInfo().PlaybackStatus)" -eq 'Paused') { break }
  Start-Sleep -Milliseconds 400
}
$mid = $mine.GetPlaybackInfo().PlaybackStatus
Write-Host "after toggle status=$mid"
if ("$mid" -ne 'Paused') { Fail "status not Paused after remote toggle (got $mid)" }

# —— 4. 再 toggle 回 Playing（真核心曲终则接受重播态）——
Write-Host '=== second toggle (play leg) ==='
Await ($mine.TryTogglePlayPauseAsync()) ([bool]) | Out-Null
$deadline = (Get-Date).AddSeconds(6)
$backOk = $false
while ((Get-Date) -lt $deadline) {
  $st = "$($mine.GetPlaybackInfo().PlaybackStatus)"
  if ($st -eq 'Playing') { $backOk = $true; break }
  # 真核心曲终：toggle 对 stopped+有曲 = 从头重播 → 短暂 Stopped/Playing 竞态，容忍最终 Playing
  Start-Sleep -Milliseconds 400
}
if (-not $backOk) { Fail 'status not back to Playing after second toggle' }
Write-Host 'back to Playing ok'

Write-Host '=== remote stop ==='
Await ($mine.TryStopAsync()) ([bool]) | Out-Null
$deadline = (Get-Date).AddSeconds(6)
while ((Get-Date) -lt $deadline) {
  if ("$($mine.GetPlaybackInfo().PlaybackStatus)" -eq 'Stopped') { break }
  Start-Sleep -Milliseconds 400
}
$st = $mine.GetPlaybackInfo().PlaybackStatus
Write-Host "after stop status=$st"
if ("$st" -ne 'Stopped') { Fail "status not Stopped after remote stop (got $st)" }

Write-Host '=== teardown ==='
Cleanup
Write-Host "`nSMTC-CHECK-PASS" -ForegroundColor Green
exit 0
