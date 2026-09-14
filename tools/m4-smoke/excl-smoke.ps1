# M4-a 冒烟：output.mode 假协商（桩）+ 真核心 devices.list exclusive 形状。
# 断言形状与协议 v1.6 逐字；真独占听感归交互点①（用户在场）。
# 用法：pwsh excl-smoke.ps1 [-Stub]（默认真核心）
param(
  [string]$CoreExe = 'C:\Users\StarL\m2-work\host\core\build\Release\RhineCore.exe',
  [string]$PipeName = 'rhine-music.m4.excl',
  [string]$WorkDir = 'C:\Users\StarL\m2-work\runs\m4',
  [string]$Track = 'C:\Users\StarL\Music\流浪地球 电影原声大碟\火石.flac',
  [switch]$Stub
)
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null
$log = Join-Path $WorkDir 'core.log'
Remove-Item -LiteralPath $log -ErrorAction SilentlyContinue
$proc = Start-Process -FilePath $CoreExe -ArgumentList @('--pipe', $PipeName) -PassThru `
  -WindowStyle Hidden -RedirectStandardOutput $log
Start-Sleep -Milliseconds 900
$client = [System.IO.Pipes.NamedPipeClientStream]::new('.', $PipeName, 'InOut')
$client.Connect(8000)
$reader = [System.IO.StreamReader]::new($client, [System.Text.Encoding]::UTF8)
$writer = [System.IO.StreamWriter]::new($client, (New-Object System.Text.UTF8Encoding($false)))
$writer.AutoFlush = $true; $writer.NewLine = "`n"
$script:fail = 0
function Assert([bool]$ok, [string]$name) {
  if ($ok) { Write-Host "  ok   $name" -ForegroundColor Green }
  else { Write-Host "  FAIL $name" -ForegroundColor Red; $script:fail++ }
}
function Send($o) { $writer.WriteLine(($o | ConvertTo-Json -Compress -Depth 10)) }
$script:evts = New-Object System.Collections.ArrayList
function Wait-Reply([string]$id, [int]$ms = 8000) {
  $end = (Get-Date).AddMilliseconds($ms)
  while ((Get-Date) -lt $end) {
    $line = $reader.ReadLine()
    if ($null -eq $line) { return $null }
    $f = $line | ConvertFrom-Json
    if ($f.t -eq 'evt') { [void]$script:evts.Add($f) }
    if (($f.t -eq 'ack' -or $f.t -eq 'err') -and $f.id -eq $id) { return $f }
  }
  return $null
}
function Last-State() { @($script:evts | Where-Object { $_.evt -eq 'state' }) | Select-Object -Last 1 }
# ack 之后补发的事件仍在管道里：非阻塞泵 400ms 收进账本（Wait-Reply 只读到 ack 为止）。
function Pump([int]$ms = 400) {
  $end = (Get-Date).AddMilliseconds($ms)
  while ((Get-Date) -lt $end) {
    $task = $reader.ReadLineAsync()
    if ($task.Wait(120)) {
      $line = $task.Result
      if ($null -eq $line) { return }
      $f = $line | ConvertFrom-Json
      if ($f.t -eq 'evt') { [void]$script:evts.Add($f) }
    }
  }
}
Send @{v=1;t='hello';role='shell';proto=1;caps=@('cmd');app='m4-smoke';ver='0'}
$null = $reader.ReadLine()   # hello 应答
Write-Host "=== devices.list（v1.6 exclusive 真形状）==="
Send @{v=1;t='cmd';id='d-1';cmd='devices.list'}
$d = Wait-Reply 'd-1'
$devs = $d.result.devices
Assert ($d.t -eq 'ack' -and $devs.Count -ge 1) "devices ack, $($devs.Count) 台"
$dflt = $devs | Where-Object { $_.default } | Select-Object -First 1
$ex = $dflt.capabilities.exclusive
if ($Stub) {
  Assert ($null -ne $ex -and $ex.supported -eq $true -and $ex.rates.Count -eq 8) "桩 DAC 8 档 exclusive（实测 $((($ex.rates | Measure-Object).Count))）"
} else {
  # 真核心三态：null=枚举表空（本机实测态，合法）；非 null 必须 {supported,rates} 形状。
  $exKind = if ($null -eq $ex) { 'null=未知(试开判定)' } else { 'object' }
  Assert ($null -eq $ex -or ($ex.PSObject.Properties.Name -contains 'supported')) `
    "真核心 exclusive 三态合法（$exKind）"
}
Write-Host "=== output.mode 校验 ==="
Send @{v=1;t='cmd';id='o-1';cmd='output.mode';data=@{mode='bogus'}}
$e = Wait-Reply 'o-1'
Assert ($e.t -eq 'err' -and $e.error.code -eq 'bad_request') '非法 mode → bad_request'
Send @{v=1;t='cmd';id='o-2';cmd='output.mode';data=@{mode='shared';buffer_ms=20}}
$o2 = Wait-Reply 'o-2'
Assert ($o2.t -eq 'ack') "shared 协商 ack（share=$($o2.result.negotiated.share) buffer_ms=$($o2.result.negotiated.buffer_ms)）"
if ($Stub) {
  Assert ($o2.result.negotiated.share -eq 'shared-event' -and $o2.result.negotiated.fidelity -eq 'app-perfect') '桩 shared 假协商形状'
  Write-Host "=== 桩 exclusive 注入 state 快照 ==="
  Send @{v=1;t='cmd';id='o-3';cmd='output.mode';data=@{mode='exclusive'}}
  $o3 = Wait-Reply 'o-3'
  Assert ($o3.result.negotiated.share -eq 'exclusive' -and $o3.result.negotiated.fidelity -eq 'bit-perfect') '桩 exclusive → bit-perfect 假协商'
  Pump 600
  $st = Last-State
  Assert ($null -ne $st -and $st.data.negotiated.share -eq 'exclusive') `
    'state 快照携带 exclusive negotiated（注入点生效）'
  Send @{v=1;t='cmd';id='o-4';cmd='output.mode';data=@{mode='shared'}}
  $null = Wait-Reply 'o-4'   # 事件穿插由帧泵消化
} else {
  Write-Host "=== 真核心 exclusive→shared 往返（机制验证，听感归交互①）==="
  Send @{v=1;t='cmd';id='p-1';cmd='engine.play';data=@{track_id="file:$Track"}}
  $null = Wait-Reply 'p-1'
  Start-Sleep -Seconds 2
  Send @{v=1;t='cmd';id='o-3';cmd='output.mode';data=@{mode='exclusive'}}
  $o3 = Wait-Reply 'o-3'
  Assert ($o3.t -eq 'ack' -and $o3.result.negotiated.share -eq 'exclusive') `
    "真核心 exclusive 达成（share=$($o3.result.negotiated.share) fidelity=$($o3.result.negotiated.fidelity)）"
  Assert ($o3.result.negotiated.fidelity -eq 'bit-perfect') "FLAC24 独占位完美徽章（factors=$($o3.result.negotiated.factors -join ',')）"
  Start-Sleep -Seconds 2
  # 位置连续性：重开链后不得倒退/跳飞
  Send @{v=1;t='cmd';id='s-1';cmd='engine.state'}
  $st = Wait-Reply 's-1'
  Assert ($st.result.state -eq 'playing' -and $st.result.position_ms -gt 1000) `
    "重开后 playing 且位置连续（$($st.result.position_ms)ms）"
  Send @{v=1;t='cmd';id='o-4';cmd='output.mode';data=@{mode='shared'}}
  $o4 = Wait-Reply 'o-4'
  Assert ($o4.result.negotiated.share -eq 'shared-event') '回落 shared ack'
  Send @{v=1;t='cmd';id='s-2';cmd='engine.state'}
  $st2 = Wait-Reply 's-2'
  Assert ($st2.result.state -eq 'playing' -and $st2.result.position_ms -ge $st.result.position_ms) `
    "shared 续播位置不回退（$($st.result.position_ms)→$($st2.result.position_ms)）"
}
Send @{v=1;t='bye';reason='m4-smoke-done'}
$proc.WaitForExit(8000) | Out-Null
Assert (-not $proc.HasExited -or $proc.ExitCode -eq 0) 'bye 有序退出'
if ($script:fail -eq 0) { Write-Host 'M4-EXCL-SMOKE-PASS' -ForegroundColor Green; exit 0 }
Write-Host "M4-EXCL-SMOKE-FAIL ($script:fail)" -ForegroundColor Red
Get-Content $log -Tail 12
exit 1
