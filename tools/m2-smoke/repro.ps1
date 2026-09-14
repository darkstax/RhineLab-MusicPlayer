<#
.SYNOPSIS
  M2-FINDINGS #7/#28 曲终收敛专项复现（M5a A1-4 验收）：播到 EOF → 自然 stopped
  → 同曲 re-play → 位置恢复推进 → toggle 暂停/续播 → 再次自然播放不锁死。
  审查 P0-1 修复的回归兜底：ring 换成 ma_pcm_rb 后 EOF 排空判定（readable==0）
  与 seek 成功清 eof 标志的语义必须逐条保持（M2-FINDINGS §7.2 依赖）。

.DESCRIPTION
  短曲（火石.flac ≈9.8s）全曲播完触发 EofDrained → 状态机收敛 stopped；
  随后重播观察 position 恢复推进（对照修复记录 pos 40→5520 量级）。

.EXAMPLE
  pwsh.exe -NoProfile -ExecutionPolicy Bypass -File tools\m2-smoke\repro.ps1 `
      -CoreExe C:\Users\StarL\m2-work\host\core\build\Release\RhineCore.exe
#>
[CmdletBinding()]
param(
  [string]$CoreExe = 'C:\Users\StarL\m2-work\host\core\build\Release\RhineCore.exe',
  [string]$PipeName = 'rhine-music.m2.repro',
  [string]$Track = 'C:\Users\StarL\Music\流浪地球 电影原声大碟\火石.flac',
  [string]$WorkDir = 'C:\Users\StarL\m2-work'
)

$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null
$coreLog = Join-Path $WorkDir 'm2-repro-core.log'
$trace = Join-Path $WorkDir 'm2-repro-trace.log'
Remove-Item -LiteralPath $coreLog, $trace -ErrorAction SilentlyContinue

$proc = Start-Process -FilePath $CoreExe -ArgumentList @('--pipe', $PipeName, '--trace', $trace) `
  -WorkingDirectory $WorkDir -PassThru -WindowStyle Hidden -RedirectStandardOutput $coreLog

function Fail([string]$msg) {
  Write-Host "REPRO-FAIL: $msg" -ForegroundColor Red
  try { Get-Process -Id $proc.Id -ErrorAction SilentlyContinue | Stop-Process -Force } catch { }
  exit 1
}
$client = $null
for ($try = 0; $try -lt 10; $try++) {
  try {
    $client = [System.IO.Pipes.NamedPipeClientStream]::new('.', $PipeName,
      [System.IO.Pipes.PipeDirection]::InOut)
    $client.Connect(2000)
    break
  } catch { Start-Sleep -Milliseconds 500 }
}
if (-not $client -or -not $client.IsConnected) { Fail 'cannot connect pipe' }
$reader = [System.IO.StreamReader]::new($client, [System.Text.UTF8Encoding]::new($false))
$writer = [System.IO.StreamWriter]::new($client, [System.Text.UTF8Encoding]::new($false))
$writer.AutoFlush = $true
$writer.NewLine = "`n"
function Send($obj) { $writer.WriteLine(($obj | ConvertTo-Json -Compress -Depth 6)) }
function Wait-Kind([string]$evt, [int]$timeoutMs) {
  $deadline = (Get-Date).AddMilliseconds($timeoutMs)
  while ((Get-Date) -lt $deadline) {
    if ($reader.Peek() -lt 0) { Fail "pipe closed waiting $evt" }
    $f = $reader.ReadLine() | ConvertFrom-Json
    if ($f.t -eq 'evt' -and $f.evt -eq $evt) { return $f }
  }
  Fail "timeout waiting evt=$evt"
}

Send @{ v = 1; t = 'hello'; role = 'shell'; proto = 1; caps = @('cmd','evt.position','evt.state'); app = 'm2-repro'; ver = '0.0.1' }
$deadline = (Get-Date).AddSeconds(6)
$gotHello = $false
while (-not $gotHello -and (Get-Date) -lt $deadline) {
  $f = $reader.ReadLine() | ConvertFrom-Json
  if ($f.t -eq 'hello') { $gotHello = $true }
}
if (-not $gotHello) { Fail 'no hello' }

Write-Host '=== play to EOF (short track) ==='
Send @{ v = 1; t = 'cmd'; id = 'r-1'; cmd = 'engine.play'; data = @{ track_id = "file:$Track" } }
$null = Wait-Kind 'state' 8000

# 等自然收敛 stopped（1Hz tick 的 EofDrained 判定 = readable==0；换环后此判据是关键回归点）。
# 单帧窗 15s > 曲长 9.8s + 排空（ring 1.35s）+ tick（1s）≈ 12.5s。
$converged = $false
$deadline = (Get-Date).AddSeconds(30)
while ((Get-Date) -lt $deadline) {
  $st = Wait-Kind 'state' 15000
  if ($st.data.state -eq 'stopped') { $converged = $true; break }
}
if (-not $converged) { Fail 'EOF did not converge to stopped' }
Write-Host 'converged stopped (EOF drained ok)'

Write-Host '=== re-play same track (P0-1 场景) ==='
Send @{ v = 1; t = 'cmd'; id = 'r-2'; cmd = 'engine.play'; data = @{ track_id = "file:$Track" } }
$st = Wait-Kind 'state' 8000
if ($st.data.state -ne 'playing') { Fail "re-play state=$($st.data.state) (expect playing)" }
$p1 = Wait-Kind 'position' 4000
Start-Sleep -Milliseconds 2300
$p2 = Wait-Kind 'position' 4000
$adv = [long]$p2.data.position_ms - [long]$p1.data.position_ms
Write-Host "replay position $($p1.data.position_ms) -> $($p2.data.position_ms) (Δ=$adv ms)"
if ($adv -lt 300) { Fail "replay position not advancing (Δ=$adv, P0-1 锁死时≈0)" }

Write-Host '=== toggle pause -> toggle resume ==='
Send @{ v = 1; t = 'cmd'; id = 'r-3'; cmd = 'engine.toggle' }
$st = Wait-Kind 'state' 5000
if ($st.data.state -ne 'paused') { Fail "toggle->pause state=$($st.data.state)" }
$pp = [long](Wait-Kind 'position' 3000).data.position_ms
Send @{ v = 1; t = 'cmd'; id = 'r-4'; cmd = 'engine.toggle' }
$st = Wait-Kind 'state' 5000
if ($st.data.state -ne 'playing') { Fail "toggle->play state=$($st.data.state)" }
Start-Sleep -Milliseconds 1600
$rp = [long](Wait-Kind 'position' 3000).data.position_ms
Write-Host "toggle resume position $pp -> $rp"
if ($rp -le $pp) { Fail "position not advancing after toggle-resume ($pp -> $rp)" }

Send @{ v = 1; t = 'bye'; reason = 'repro-done' }
$proc.WaitForExit(8000) | Out-Null
if (-not $proc.HasExited -or $proc.ExitCode -ne 0) { Fail "core exit=$($proc.ExitCode)" }
try { $reader.Dispose() } catch {} ; try { $writer.Dispose() } catch {} ; try { $client.Dispose() } catch {}
Write-Host "`nREPRO-PASS" -ForegroundColor Green
exit 0
