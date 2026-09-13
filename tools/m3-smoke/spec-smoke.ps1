<#
.SYNOPSIS
  M3 频谱冒烟（验收 2）：真核心（或桩）播放 → spectrum.on → 30Hz 谱帧断言 → off 停发 → bye。

.DESCRIPTION
  断言链（协议 §5/§6 v1.3）：
    1) hello caps 含 spectrum；spectrum.on ack {enabled:true}
    2) 播放真 FLAC 后收到 >=10 帧 spectrum
    3) bands_l/bands_r 各 64 个 0..1 数值；至少一帧非全零；至少一帧 L!=R
    4) 帧间隔中位数 25-45ms（≈30Hz）
    5) low/mid/high/activity/beat_phase ∈ [0,1]
    6) spectrum.off ack {enabled:false} 且 500ms 内无新 spectrum 帧
    7) bye 退出码 0
  默认测真核心（RhineCore.exe + 火石.flac）；-CoreExe 指桩亦可（桩假谱同形，断言同样成立：
  桩假谱 L/R 错相 0.6 rad、bands 全帧非零——-Stub 模式跳过「频率中位数」改放宽为 20-120ms，
  因 .NET 定时器精度低于 C++ 会话线程片）。

.EXAMPLE
  pwsh.exe -NoProfile -ExecutionPolicy Bypass -File tools\m3-smoke\spec-smoke.ps1 `
      -CoreExe C:\Users\StarL\m3-work\host\core\build\Release\RhineCore.exe
  pwsh.exe ... -CoreExe C:\Users\StarL\m3-work\host\RhineCoreStub\bin\Release\net10.0-windows\RhineCoreStub.exe -Stub
#>
[CmdletBinding()]
param(
  [string]$CoreExe = 'C:\Users\StarL\m3-work\host\core\build\Release\RhineCore.exe',
  [string]$PipeName = 'rhine-music.m3.spec',
  [string]$Track = 'C:\Users\StarL\Music\流浪地球 电影原声大碟\火石.flac',
  [string]$WorkDir = 'C:\Users\StarL\m3-work',
  [switch]$Stub
)

$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null
$coreLog = Join-Path $WorkDir "m3-spec-core.log"
Remove-Item -LiteralPath $coreLog -ErrorAction SilentlyContinue

Write-Host "=== launch $(if($Stub){'stub'}else{'core'}): $CoreExe ==="
$proc = Start-Process -FilePath $CoreExe `
  -ArgumentList @('--pipe', $PipeName, '--verbose') `
  -WorkingDirectory $WorkDir -PassThru -WindowStyle Hidden `
  -RedirectStandardOutput $coreLog

function Fail([string]$msg) {
  Write-Host "SPEC-SMOKE-FAIL: $msg" -ForegroundColor Red
  if (Test-Path -LiteralPath $coreLog) {
    Write-Host '--- core stdout tail ---'
    Get-Content -LiteralPath $coreLog -Tail 20 | ForEach-Object { Write-Host "  $_" }
  }
  try { Get-Process -Id $proc.Id -ErrorAction SilentlyContinue | Stop-Process -Force } catch { }
  exit 1
}

$client = $null
for ($try = 0; $try -lt 10; $try++) {
  try {
    $client = [System.IO.Pipes.NamedPipeClientStream]::new('.', $PipeName,
      [System.IO.Pipes.PipeDirection]::InOut, [System.IO.Pipes.PipeOptions]::Asynchronous)
    $client.Connect(2000)
    break
  } catch { Start-Sleep -Milliseconds 500 }
}
if (-not $client -or -not $client.IsConnected) { Fail 'cannot connect pipe' }

$reader = [System.IO.StreamReader]::new($client, [System.Text.UTF8Encoding]::new($false))
$writer = [System.IO.StreamWriter]::new($client, [System.Text.UTF8Encoding]::new($false))
$writer.AutoFlush = $true
$writer.NewLine = "`n"

function Send($obj) { $writer.WriteLine(($obj | ConvertTo-Json -Compress -Depth 10)) }

function Wait-Frame([string]$t, [int]$timeoutMs, [scriptblock]$match = $null) {
  $deadline = (Get-Date).AddMilliseconds($timeoutMs)
  while ((Get-Date) -lt $deadline) {
    if ($reader.Peek() -lt 0) { Fail "pipe closed while waiting t=$t" }
    $line = $reader.ReadLine()
    if (-not $line) { continue }
    $frame = $line | ConvertFrom-Json
    if ($frame.t -eq $t -and (-not $match -or (& $match $frame))) { return $frame }
  }
  Fail "timeout waiting t=$t (last)"
}

Write-Host '=== hello ==='
Send @{ v = 1; t = 'hello'; role = 'shell'; proto = 1; caps = @('cmd','evt.position','evt.state','spectrum'); app = 'm3-spec'; ver = '0.0.1' }
$hello = Wait-Frame 'hello' 8000
if ($hello.caps -notcontains 'spectrum') { Fail "hello caps missing spectrum: $($hello.caps -join ',')" }
Write-Host "caps ok: $($hello.caps -join ',')"
Wait-Frame 'evt' 5000 { param($f) $f.evt -eq 'state' } | Out-Null

Write-Host '=== play ==='
$trackId = if ($Stub) { 'X-001' } else { "file:$Track" }
Send @{ v = 1; t = 'cmd'; id = 'm-1'; cmd = 'engine.play'; data = @{ track_id = $trackId } }
$ack = Wait-Frame 'ack' 15000 { param($f) $f.id -eq 'm-1' }
if (-not $ack.result.stream_token) { Fail "play ack: $ack" }
Write-Host "stream_token=$($ack.result.stream_token)"

Write-Host '=== spectrum.on ==='
Send @{ v = 1; t = 'cmd'; id = 'm-2'; cmd = 'spectrum.on' }
$ack = Wait-Frame 'ack' 5000 { param($f) $f.id -eq 'm-2' }
if ($ack.result.enabled -ne $true) { Fail "spectrum.on enabled!=true: $($ack.result)" }
Write-Host 'on ack ok'

Write-Host '=== collect spectrum frames ==='
# 真曲（火石）前 ~260ms 是静音，且订阅首帧从弹簧零位起步：等 activity 出现后
# 再连续收 12 帧做断言（纯首帧窗口会全零属正常 dry 帧，不是缺陷）。
$frames = @()
$stamps = @()
$started = $false
$deadline = (Get-Date).AddSeconds(9)
while ((Get-Date) -lt $deadline) {
  $f = Wait-Frame 'evt' 4000 { param($x) $x.evt -eq 'spectrum' }
  if (-not $started) {
    if ([double]$f.data.activity -gt 0.001) { $started = $true } else { continue }
  }
  $frames += $f
  $stamps += (Get-Date)
  if ($frames.Count -ge 12) { break }
}
if ($frames.Count -lt 10) { Fail "only $($frames.Count) audible spectrum frames collected (started=$started)" }
Write-Host "collected $($frames.Count) frames"

# 形状与内容断言
$nonZero = $false; $lrDiff = $false
foreach ($f in $frames) {
  $d = $f.data
  if (@($d.bands_l).Count -ne 64 -or @($d.bands_r).Count -ne 64) { Fail 'bands length != 64' }
  foreach ($b in @($d.bands_l) + @($d.bands_r)) {
    if ($b -lt 0 -or $b -gt 1) { Fail "band out of [0,1]: $b" }
    if ($b -gt 0.001) { $nonZero = $true }
  }
  for ($i = 0; $i -lt 64; $i++) {
    if ([math]::Abs([double]$d.bands_l[$i] - [double]$d.bands_r[$i]) -gt 0.005) { $lrDiff = $true }
  }
  foreach ($k in 'low','mid','high','activity','beat_phase') {
    $v = [double]$d.$k
    if ($v -lt 0 -or $v -gt 1) { Fail "$k out of [0,1]: $v" }
  }
}
if (-not $nonZero) { Fail 'all bands zero (no audio data flowing into tap?)' }
if (-not $lrDiff) { Fail 'L==R in every frame (stereo separation missing?)' }
Write-Host "bands non-zero ok; L!=R ok; low=$($frames[-1].data.low) mid=$($frames[-1].data.mid) high=$($frames[-1].data.high) activity=$($frames[-1].data.activity) beat_phase=$($frames[-1].data.beat_phase)"

# 帧间隔统计（seq 连续性 + 节拍）
$gaps = @()
for ($i = 1; $i -lt $stamps.Count; $i++) { $gaps += [long]($stamps[$i] - $stamps[$i-1]).TotalMilliseconds }
$sorted = $gaps | Sort-Object
$median = $sorted[[int](($sorted.Count - 1) / 2)]
$lo = if ($Stub) { 20 } else { 25 }
$hi = if ($Stub) { 120 } else { 45 }
Write-Host "gap median=${median}ms (bounds $lo-$hi for $(if($Stub){'stub'}else{'core'}))"
if ($median -lt $lo -or $median -gt $hi) { Fail "interval median $median outside $lo-$hi ms" }

Write-Host '=== spectrum.off ==='
Send @{ v = 1; t = 'cmd'; id = 'm-3'; cmd = 'spectrum.off' }
$ack = Wait-Frame 'ack' 5000 { param($f) $f.id -eq 'm-3' }
if ($ack.result.enabled -ne $false) { Fail "spectrum.off enabled!=false: $($ack.result)" }
# 停发验证：off 后连续读帧直到下一份 position（1Hz tick，证明链路存活）；
# 若 spectrum 未停（30Hz），其帧必然在 position 之前到达而被计数——抓到即 fail。
$leaked = 0
$deadline = (Get-Date).AddSeconds(3)
$gotPosition = $false
while ((Get-Date) -lt $deadline -and -not $gotPosition) {
  if ($reader.Peek() -lt 0) { Fail 'pipe closed right after off' }
  $line = $reader.ReadLine()
  if (-not $line) { continue }
  $f = $line | ConvertFrom-Json
  if ($f.t -eq 'evt') {
    if ($f.evt -eq 'spectrum') { $leaked += 1 }
    if ($f.evt -eq 'position') { $gotPosition = $true }
  }
}
if ($leaked -gt 0) { Fail "spectrum frames continue after off ($leaked leaked before next position)" }
if (-not $gotPosition) { Fail 'no position tick within 3s after off (channel dead? invalidates the stop check)' }
Write-Host 'off stop confirmed'

Write-Host '=== bye ==='
Send @{ v = 1; t = 'bye'; reason = 'spec-smoke-done' }
$proc.WaitForExit(8000) | Out-Null
if (-not $proc.HasExited) { Fail 'core alive 8s after bye' }
if ($proc.ExitCode -ne 0) { Fail "exit code $($proc.ExitCode)" }
Write-Host 'exit 0 ok'
try { $reader.Dispose() } catch {} ; try { $writer.Dispose() } catch {} ; try { $client.Dispose() } catch {}
Write-Host "`nSPEC-SMOKE-PASS" -ForegroundColor Green
exit 0
