<#
.SYNOPSIS
  M2 冒烟（一次性，非正式测试）：RhineCore.exe 真音频核心的管道往返。
  hello → play(file: 真实 FLAC) → 5s 内 position 推进 → pause/resume/seek/stop → bye 有序退出。

.DESCRIPTION
  在本地镜像目录起核心（UNC 下不跑构建产物），客户端用 .NET NamedPipeClientStream。
  判定：进程全程存活、state 帧含 negotiated（非 null）、position_ms 两次采样推进、
  bye 后进程退出码 0、trace 落盘。

.EXAMPLE
  pwsh.exe -NoProfile -ExecutionPolicy Bypass -File tools\m2-smoke\smoke.ps1 `
      -CoreExe C:\Users\StarL\m2-work\host\core\build\Release\RhineCore.exe
#>
[CmdletBinding()]
param(
  [string]$CoreExe = 'C:\Users\StarL\m2-work\host\core\build\Release\RhineCore.exe',
  [string]$PipeName = 'rhine-music.m2.smoke',
  [string]$Track = 'C:\Users\StarL\Music\流浪地球 电影原声大碟\火石.flac',
  [string]$WorkDir = 'C:\Users\StarL\m2-work'
)

$ErrorActionPreference = 'Stop'
$trace = Join-Path $WorkDir 'm2-smoke-trace.log'
Remove-Item -LiteralPath $trace -ErrorAction SilentlyContinue

Write-Host "=== launch core: $CoreExe ==="
$coreStdout = Join-Path $WorkDir 'm2-smoke-core.log'
Remove-Item -LiteralPath $coreStdout -ErrorAction SilentlyContinue
$proc = Start-Process -FilePath $CoreExe `
  -ArgumentList @('--pipe', $PipeName, '--trace', $trace, '--verbose') `
  -WorkingDirectory $WorkDir -PassThru -WindowStyle Hidden `
  -RedirectStandardOutput $coreStdout
Write-Host "pid=$($proc.Id)"

function Fail([string]$msg) {
  Write-Host "SMOKE-FAIL: $msg" -ForegroundColor Red
  Write-Host '--- core stdout tail ---'
  if (Test-Path -LiteralPath $coreStdout) { Get-Content -LiteralPath $coreStdout -Tail 30 | ForEach-Object { Write-Host "  $_" } }
  try { Get-Process -Id $proc.Id -ErrorAction SilentlyContinue | Stop-Process -Force } catch { }
  exit 1
}

try {
  $client = [System.IO.Pipes.NamedPipeClientStream]::new('.', $PipeName,
    [System.IO.Pipes.PipeDirection]::InOut, [System.IO.Pipes.PipeOptions]::Asynchronous)
  $client.Connect(5000)
  $stream = $client
} catch {
  # 核心需要一点启动时间（打开默认输出设备），重试一轮
  Start-Sleep -Milliseconds 800
  try {
    $client = [System.IO.Pipes.NamedPipeClientStream]::new('.', $PipeName,
      [System.IO.Pipes.PipeDirection]::InOut, [System.IO.Pipes.PipeOptions]::Asynchronous)
    $client.Connect(5000)
    $stream = $client
  } catch { Fail "cannot connect pipe: $($_.Exception.Message)" }
}

$reader = [System.IO.StreamReader]::new($stream, [System.Text.UTF8Encoding]::new($false))
$writer = [System.IO.StreamWriter]::new($stream, [System.Text.UTF8Encoding]::new($false))
$writer.AutoFlush = $true
$writer.NewLine = "`n"

function Send($obj) { $writer.WriteLine(($obj | ConvertTo-Json -Compress -Depth 10)) }

# 非阻塞等待一帧指定类型（其余帧按 pattern 记录）
function Wait-Frame([string]$t, [int]$timeoutMs, [scriptblock]$match = $null) {
  $deadline = (Get-Date).AddMilliseconds($timeoutMs)
  while ((Get-Date) -lt $deadline) {
    if ($reader.Peek() -lt 0) { Fail "pipe closed while waiting t=$t" }
    $line = $reader.ReadLine()
    if (-not $line) { continue }
    $frame = $line | ConvertFrom-Json
    if ($frame.t -eq $t -and (-not $match -or (& $match $frame))) { return $frame }
    Write-Host "  (frame t=$($frame.t) evt=$($frame.evt))" -ForegroundColor DarkGray
  }
  Fail "timeout waiting t=$t"
}

Write-Host "=== hello ==="
Send @{ v = 1; t = 'hello'; role = 'shell'; proto = 1; caps = @('cmd','evt.position','evt.state','smtc'); app = 'm2-smoke'; ver = '0.0.1' }
$hello = Wait-Frame 'hello' 5000
if ($hello.proto -ne 1 -or -not $hello.caps -or $hello.caps -notcontains 'engine.play') { Fail "bad hello: $hello" }
Write-Host "core hello ep=$($hello.ep) caps=$($hello.caps -join ',')"
$state0 = Wait-Frame 'evt' 5000 { param($f) $f.evt -eq 'state' }
if ($null -eq $state0.data.negotiated) { Fail 'negotiated is null (engine not wired?)' }
Write-Host "state0 negotiated.share=$($state0.data.negotiated.share) fidelity=$($state0.data.negotiated.fidelity) fmt=$($state0.data.negotiated.format.rate)/$($state0.data.negotiated.format.bits_container)"

Write-Host "=== play file ==="
Send @{ v = 1; t = 'cmd'; id = 's-1'; cmd = 'engine.play'; data = @{ track_id = "file:$Track" } }
$ack = Wait-Frame 'ack' 15000 { param($f) $f.id -eq 's-1' }
if (-not $ack.result.stream_token) { Fail "play ack: $ack" }
Write-Host "stream_token=$($ack.result.stream_token)"
$st = Wait-Frame 'evt' 5000 { param($f) $f.evt -eq 'state' }
if ($st.data.state -ne 'playing') { Fail "state != playing: $($st.data.state)" }
if ($st.data.duration_ms -lt 1000) { Fail "duration too short: $($st.data.duration_ms)" }
Write-Host "playing track=$($st.data.track_id) duration=$($st.data.duration_ms)ms"

Write-Host "=== position advance (5s) ==="
# 先消费 play 即时帧（seq 紧接 state 之后），再连续读 tick 帧取最新值
$pos0 = Wait-Frame 'evt' 4000 { param($f) $f.evt -eq 'position' }
Write-Host "position@play=$([long]$pos0.data.position_ms)ms"
$pLast = [long]$pos0.data.position_ms
for ($i = 0; $i -lt 6; $i++) {
  $f = Wait-Frame 'evt' 2500 { param($f) $f.evt -eq 'position' }
  $v = [long]$f.data.position_ms
  Write-Host "  tick position_ms=$v buffered=$($f.data.buffered_ms) seq=$($f.seq)"
  if ($v -gt $pLast) { $pLast = $v }
  if ($pLast -gt $pos0.data.position_ms + 3000) { break }
}
if ($pLast -lt 3000) { Fail "position not advancing: $pLast" }

Write-Host "=== pause / resume / seek / stop ==="
Send @{ v = 1; t = 'cmd'; id = 's-2'; cmd = 'engine.pause' }
$ack = Wait-Frame 'ack' 5000 { param($f) $f.id -eq 's-2' }
if ($ack.result.state -ne 'paused') { Fail "pause state: $($ack.result.state)" }
$pausedPos = (Wait-Frame 'evt' 5000 { param($f) $f.evt -eq 'state' }).data.position_ms
Start-Sleep -Milliseconds 1500
Send @{ v = 1; t = 'cmd'; id = 's-2b'; cmd = 'engine.state' }
$chk = Wait-Frame 'ack' 5000 { param($f) $f.id -eq 's-2b' }
if ([long]$chk.result.position_ms -ne [long]$pausedPos) { Fail "position drifted while paused ($pausedPos -> $($chk.result.position_ms))" }
Write-Host "paused stable at $pausedPos"

Send @{ v = 1; t = 'cmd'; id = 's-3'; cmd = 'engine.resume' }
$ack = Wait-Frame 'ack' 5000 { param($f) $f.id -eq 's-3' }
if ($ack.result.state -ne 'playing') { Fail "resume state: $($ack.result.state)" }
Wait-Frame 'evt' 5000 { param($f) $f.evt -eq 'position' } | Out-Null

Send @{ v = 1; t = 'cmd'; id = 's-4'; cmd = 'engine.seek'; data = @{ position_ms = 1500 } }
$ack = Wait-Frame 'ack' 10000 { param($f) $f.id -eq 's-4' }
if ([long]$ack.result.applied_ms -ne 1500) { Fail "seek applied: $($ack.result.applied_ms)" }
Write-Host "seek applied 1500"

Send @{ v = 1; t = 'cmd'; id = 's-5'; cmd = 'engine.volume'; data = @{ mode = 'float'; value = 0.5 } }
$ack = Wait-Frame 'ack' 5000 { param($f) $f.id -eq 's-5' }
if ($ack.result.effective.value -ne 0.5) { Fail "volume effective: $($ack.result.effective)" }
Write-Host "volume=$($ack.result.effective.mode)/$($ack.result.effective.value)"

Send @{ v = 1; t = 'cmd'; id = 's-6'; cmd = 'engine.stop' }
$ack = Wait-Frame 'ack' 5000 { param($f) $f.id -eq 's-6' }
if ($ack.result.state -ne 'stopped') { Fail "stop state: $($ack.result.state)" }
Write-Host "stopped"

Write-Host "=== bad frames (must not crash) ==="
Send @{ v = 1; t = 'cmd'; id = 's-7'; cmd = 'engine.play'; data = @{ track_id = @{ evil = 1 } } }
$err = Wait-Frame 'err' 5000 { param($f) $f.id -eq 's-7' }
Write-Host "obj-track_id -> $($err.error.code)"
$writer.WriteLine('{not json')
$err = Wait-Frame 'err' 5000 { param($f) $f.error.code -eq 'bad_request' }
Write-Host "garbage line -> $($err.error.code)"
# M6-F（协议 v1.5）：devices.list 转正只读实现（not_implemented 断言作废，
# 形状验证归 tools/m6-smoke/diag-smoke.ps1）；这里只验不崩 + 有应答。
Send @{ v = 1; t = 'cmd'; id = 's-8'; cmd = 'devices.list' }
$rep = Wait-Frame 'ack' 5000 { param($f) $f.id -eq 's-8' }
if ($null -eq $rep) { Fail 'devices.list: no ack (M6-F 只读面回归?)' } else { Write-Host 'devices.list -> ack' }
if ($proc.HasExited) { Fail 'core died on bad frames' }

Write-Host "=== bye ==="
Send @{ v = 1; t = 'bye'; reason = 'smoke-done' }
$proc.WaitForExit(8000) | Out-Null
if ($proc.HasExited -and $proc.ExitCode -eq 0) {
  Write-Host "core exited 0 (orderly)"
} elseif ($proc.HasExited) {
  Fail "core exit code $($proc.ExitCode)"
} else {
  Fail 'core still alive 8s after bye'
}
try { $reader.Dispose() } catch { } ; try { $writer.Dispose() } catch { } ; try { $client.Dispose() } catch { }

Write-Host "=== trace ==="
if (-not (Test-Path -LiteralPath $trace)) { Fail 'trace file missing' }
$traceLines = @(Get-Content -LiteralPath $trace)
Write-Host "trace lines=$($traceLines.Count)"
$traceLines | Select-Object -First 3 | ForEach-Object { Write-Host "  $_" }
Write-Host '  ...'
$traceLines | Select-Object -Last 3 | ForEach-Object { Write-Host "  $_" }

Write-Host "`nSMOKE-PASS" -ForegroundColor Green
exit 0
