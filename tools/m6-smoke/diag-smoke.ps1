<#
.SYNOPSIS
  M6 冒烟（验收 5-2）：diag.get / devices.list 只读面管道往返——真核心与桩各跑一遍，
  字段形状与协议 v1.5 §5 逐字比对（含 exclusive=null / fallback_history=null）。

.DESCRIPTION
  断言链（协议 §5 v1.5 + §8 negotiated 同构）：
    1) hello caps 含 devices.list 与 diag.get（真核心与桩同步声明）。
    2) diag.get ack result 字段集恰为 {underruns,reopens,buffer_ms_now,period_ms,link,fallback_history}
       （不多不少）；underruns/reopens/buffer_ms_now 为非负整数；fallback_history 恒 null（M4 域）。
    3) diag.get.link：设备未开时可能 null（真核心无音频环境）；若为对象则必须与 §8 negotiated
       同构——字段集 {share,backend,format,buffer_ms,period_ms,auto_expanded,chain,fidelity,factors}，
       format 字段集 {rate,bits_container,bits_valid,encoding,channels}，chain 为数组。
    4) devices.list ack {devices:[...]}（真核心无设备时回 not_implemented——判定分支）：
       每台设备字段集恰为 {id,name,kind,default,capabilities}；capabilities 字段集恰为
       {rates,min_period_ms,mix_format,exclusive}；exclusive 三态（v1.6：null=未知/实况/探测表）；
       rates 元素 {rate,bits[]}；kind 恒 "playback"；恰一台 default=true。
    5) 播放后 diag.get：真核心 link 非 null、period_ms>0；桩 link=null（negotiated 豁免同口径）、
       buffer_ms_now 随合成 buffered 语义。
    6) bye 退出码 0。

.EXAMPLE
  pwsh.exe -NoProfile -ExecutionPolicy Bypass -File tools\m6-smoke\diag-smoke.ps1            # 真核心
  pwsh.exe ... -Stub -CoreExe C:\...\RhineCoreStub\bin\Release\net10.0-windows\RhineCoreStub.exe
#>
[CmdletBinding()]
param(
  [string]$CoreExe = 'C:\Users\StarL\m2-work\host\core\build\Release\RhineCore.exe',
  [string]$PipeName = 'rhine-music.m6.diag',
  [string]$Track = 'C:\Users\StarL\Music\流浪地球 电影原声大碟\火石.flac',
  [string]$WorkDir = 'C:\Users\StarL\m6-work',
  [switch]$Stub
)

$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null
$role = if ($Stub) { 'stub' } else { 'core' }
$log = Join-Path $WorkDir "m6-diag-$role.log"
Remove-Item -LiteralPath $log -ErrorAction SilentlyContinue

# —— 形状断言器：JSON 对象键集合「恰为」期望集（顺序无关、不多不少）——
$script:Failures = 0
function Assert-Keys($obj, [string[]]$expect, [string]$what) {
  if ($null -eq $obj) { Write-Host "  FAIL $what = null（期望对象）" -ForegroundColor Red; $script:Failures++; return }
  $actual = @($obj.PSObject.Properties.Name)
  $missing = @($expect | Where-Object { $_ -notin $actual })
  $extra = @($actual | Where-Object { $_ -notin $expect })
  if ($missing -or $extra) {
    Write-Host "  FAIL $what 键集：缺=[$($missing -join ',')] 多=[$($extra -join ',')]" -ForegroundColor Red
    $script:Failures++
  } else {
    Write-Host "  ok   $what 键集 = $($expect -join ',')" -ForegroundColor Green
  }
}

Write-Host "=== launch ${role}: $CoreExe ==="
$proc = Start-Process -FilePath $CoreExe `
  -ArgumentList @('--pipe', $PipeName, '--verbose') `
  -WorkingDirectory $WorkDir -PassThru -WindowStyle Hidden -RedirectStandardOutput $log

function Fail([string]$msg) {
  Write-Host "M6-DIAG-SMOKE-FAIL($role): $msg" -ForegroundColor Red
  if (Test-Path -LiteralPath $log) { Get-Content -LiteralPath $log -Tail 30 | ForEach-Object { Write-Host "  $_" } }
  try { Get-Process -Id $proc.Id -ErrorAction SilentlyContinue | Stop-Process -Force } catch { }
  exit 1
}

$client = $null
for ($try = 0; $try -lt 15; $try++) {
  try {
    $client = [System.IO.Pipes.NamedPipeClientStream]::new('.', $PipeName,
      [System.IO.Pipes.PipeDirection]::InOut, [System.IO.Pipes.PipeOptions]::Asynchronous)
    $client.Connect(2000)
    break
  } catch { Start-Sleep -Milliseconds 500 }
}
if (-not $client) { Fail 'cannot connect pipe' }

$reader = [System.IO.StreamReader]::new($client, [System.Text.UTF8Encoding]::new($false))
$writer = [System.IO.StreamWriter]::new($client, [System.Text.UTF8Encoding]::new($false))
$writer.AutoFlush = $true
$writer.NewLine = "`n"
function Send($obj) { $writer.WriteLine(($obj | ConvertTo-Json -Compress -Depth 12)) }
$script:cid = 0
function Wait-Response([string]$id, [int]$timeoutMs) {
  $deadline = (Get-Date).AddMilliseconds($timeoutMs)
  while ((Get-Date) -lt $deadline) {
    if ($reader.Peek() -lt 0) { Fail "pipe closed waiting $id" }
    $frame = $reader.ReadLine() | ConvertFrom-Json
    if ($frame.t -in @('ack', 'err') -and $frame.id -eq $id) { return $frame }
  }
  Fail "timeout waiting response for $id"
}

try {
  # 1) hello caps
  Send @{ v = 1; t = 'hello'; role = 'shell'; proto = 1; caps = @('cmd'); app = 'rhine-music-player'; ver = '0.1.0' }
  if ($reader.Peek() -lt 0) { Fail 'no hello reply' }
  $hello = $reader.ReadLine() | ConvertFrom-Json
  if ($hello.t -ne 'hello') { Fail "first reply t=$($hello.t)" }
  foreach ($cap in 'devices.list', 'diag.get') {
    if ($hello.caps -notcontains $cap) { Write-Host "  FAIL caps 缺 $cap" -ForegroundColor Red; $script:Failures++ }
  }
  Write-Host "  ok   caps=[$($hello.caps -join ' ')]" -ForegroundColor Green

  # 2) diag.get（idle 态）
  $script:cid++; $id = "d-$script:cid"
  Send @{ v = 1; t = 'cmd'; id = $id; cmd = 'diag.get' }
  $resp = Wait-Response $id 5000
  if ($resp.t -ne 'ack') { Fail "diag.get(idle) -> $($resp.t) $($resp.error.code) $($resp.error.message)" }
  Assert-Keys $resp.result @('underruns', 'reopens', 'buffer_ms_now', 'period_ms', 'link', 'fallback_history') 'diag.get.result'
  foreach ($k in 'underruns', 'reopens', 'buffer_ms_now') {
    if ($resp.result.$k -isnot [long] -and $resp.result.$k -isnot [int]) { Write-Host "  FAIL $k 非整数" -ForegroundColor Red; $script:Failures++ }
    elseif ($resp.result.$k -lt 0) { Write-Host "  FAIL $k 为负" -ForegroundColor Red; $script:Failures++ }
  }
  if ($null -ne $resp.result.fallback_history) { Write-Host '  FAIL fallback_history 非 null（M4 域必须 null）' -ForegroundColor Red; $script:Failures++ }
  else { Write-Host '  ok   fallback_history = null（M4 域）' -ForegroundColor Green }

  # 3) link 与 §8 同构（idle 也应有——设备常开；桩 negotiated=null 豁免同口径）
  if ($Stub) {
    if ($null -ne $resp.result.link) { Write-Host '  FAIL 桩 link 应 null（negotiated 豁免）' -ForegroundColor Red; $script:Failures++ }
    else { Write-Host '  ok   桩 link = null（与 state.negotiated 同口径）' -ForegroundColor Green }
  } else {
    Assert-Keys $resp.result.link @('share', 'backend', 'format', 'buffer_ms', 'period_ms', 'auto_expanded', 'chain', 'fidelity', 'factors') 'diag.get.link'
    if ($resp.result.link) {
      Assert-Keys $resp.result.link.format @('rate', 'bits_container', 'bits_valid', 'encoding', 'channels') 'link.format'
      if ($resp.result.link.chain -isnot [Array]) { Write-Host '  FAIL chain 非数组' -ForegroundColor Red; $script:Failures++ }
      if ($resp.result.link.fidelity -notin @('bit-perfect', 'app-perfect', 'processed')) { Write-Host "  FAIL fidelity=$($resp.result.link.fidelity)" -ForegroundColor Red; $script:Failures++ }
    }
  }

  # 4) devices.list
  $script:cid++; $id = "v-$script:cid"
  Send @{ v = 1; t = 'cmd'; id = $id; cmd = 'devices.list' }
  $resp = Wait-Response $id 8000
  if ($resp.t -eq 'err' -and $resp.error.code -eq 'not_implemented' -and -not $Stub) {
    Write-Host '  info devices.list = not_implemented（真核心无音频设备/环境）' -ForegroundColor Yellow
  } elseif ($resp.t -ne 'ack') {
    Fail "devices.list -> $($resp.t) $($resp.error.code) $($resp.error.message)"
  } else {
    $devices = @($resp.result.devices)
    if (-not $devices -or $devices.Count -lt 1) { Write-Host '  FAIL devices 空数组' -ForegroundColor Red; $script:Failures++ }
    Assert-Keys $devices[0] @('id', 'name', 'kind', 'default', 'capabilities') 'devices[i]'
    Assert-Keys $devices[0].capabilities @('rates', 'min_period_ms', 'mix_format', 'exclusive') 'devices[i].capabilities'
    foreach ($d in $devices) {
      if ($d.kind -ne 'playback') { Write-Host "  FAIL kind=$($d.kind)" -ForegroundColor Red; $script:Failures++ }
      # v1.6：exclusive 三态——null=未知（枚举表空，试开判定）或 {supported,rates} 形状皆合法。
      if ($null -ne $d.capabilities.exclusive -and -not ($d.capabilities.exclusive.PSObject.Properties.Name -contains 'supported')) {
        Write-Host '  FAIL exclusive 非 null 但缺 supported 字段' -ForegroundColor Red; $script:Failures++ }
      foreach ($r in @($d.capabilities.rates)) {
        $rKeys = @($r.PSObject.Properties.Name) | Sort-Object
        if (($rKeys -join ',') -ne 'bits,rate') { Write-Host "  FAIL rates 元素键=$($rKeys -join ',')" -ForegroundColor Red; $script:Failures++ }
        if ($r.bits -isnot [Array]) { Write-Host '  FAIL rates.bits 非数组' -ForegroundColor Red; $script:Failures++ }
      }
    }
    $defaults = @($devices | Where-Object { $_.default })
    if ($defaults.Count -ne 1) { Write-Host "  FAIL default=true 台数=$($defaults.Count)" -ForegroundColor Red; $script:Failures++ }
    else { Write-Host "  ok   devices=$($devices.Count) 台、default 唯一、exclusive 三态合法（v1.6）" -ForegroundColor Green }
  }

  # 5) 播放后 diag.get（真核心 link 必须有设备事实）
  $script:cid++; $id = "p-$script:cid"
  $trackId = if ($Stub) { 'fake:m6' } else { "file:$Track" }
  Send @{ v = 1; t = 'cmd'; id = $id; cmd = 'engine.play'; data = @{ track_id = $trackId } }
  $resp = Wait-Response $id 8000
  if ($resp.t -ne 'ack') { Fail "engine.play -> $($resp.t) $($resp.error.code) $($resp.error.message)" }
  Start-Sleep -Seconds 2
  $script:cid++; $id = "d2-$script:cid"
  Send @{ v = 1; t = 'cmd'; id = $id; cmd = 'diag.get' }
  $resp = Wait-Response $id 5000
  if ($resp.t -ne 'ack') { Fail "diag.get(play) -> $($resp.t)" }
  Assert-Keys $resp.result @('underruns', 'reopens', 'buffer_ms_now', 'period_ms', 'link', 'fallback_history') 'diag.get.playing'
  if (-not $Stub) {
    if ($null -eq $resp.result.link) { Write-Host '  FAIL 真核心播放中 link=null' -ForegroundColor Red; $script:Failures++ }
    elseif ($resp.result.period_ms -le 0) { Write-Host "  FAIL period_ms=$($resp.result.period_ms)" -ForegroundColor Red; $script:Failures++ }
    else { Write-Host "  ok   playing: period=$($resp.result.period_ms)ms buffer_now=$($resp.result.buffer_ms_now)ms underruns=$($resp.result.underruns) reopens=$($resp.result.reopens)" -ForegroundColor Green }
    # reopens 应 ≥1（play 走 RestartStream 成功计数）
    if ($resp.result.reopens -lt 1) { Write-Host '  FAIL reopens 未随 play 递增' -ForegroundColor Red; $script:Failures++ }
  } else {
    Write-Host "  ok   桩 playing: buffer_now=$($resp.result.buffer_ms_now)ms（合成，与 position.buffered_ms 同源）" -ForegroundColor Green
  }

  # 6) bye
  Send @{ v = 1; t = 'bye'; reason = 'm6-diag-smoke-done' }
} catch { Fail "exception: $($_.Exception.Message)" }
finally {
  try { $client.Dispose() } catch { }
}

$exited = $proc.WaitForExit(5000)
if (-not $exited) { Fail 'core did not exit after bye' }
if ($proc.ExitCode -ne 0) { Fail "exit code $($proc.ExitCode)" }
if ($script:Failures -gt 0) { Fail "$($script:Failures) assertion failures" }
Write-Host "`nM6-DIAG-SMOKE PASS ($role)" -ForegroundColor Green
exit 0
