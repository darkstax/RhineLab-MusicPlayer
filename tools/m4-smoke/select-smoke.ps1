# M4-c devices.select 机器冒烟：枚举→钉选第二设备→回默认→未知 id 拒绝；playing 全程位置连续。
# 物理拔插（交互④⑤）另由用户在场验证；本脚本只验软件路径。
param(
  [string]$CoreExe = 'C:\Users\StarL\m2-work\host\core\build\Release\RhineCore.exe',
  [string]$PipeName = 'rhine-music.m4.select',
  [string]$WorkDir = 'C:\Users\StarL\m2-work\runs\m4s',
  [string]$Track = 'C:\Users\StarL\Music\Goose house - 光るなら.flac'
)
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null
$proc = Start-Process -FilePath $CoreExe -ArgumentList @('--pipe', $PipeName) -PassThru `
  -WindowStyle Hidden -RedirectStandardOutput "$WorkDir\core.log"
Start-Sleep -Milliseconds 900
$c = [System.IO.Pipes.NamedPipeClientStream]::new('.', $PipeName, 'InOut'); $c.Connect(5000)
$w = [System.IO.StreamWriter]::new($c, (New-Object System.Text.UTF8Encoding($false))); $w.AutoFlush = $true; $w.NewLine = "`n"
$r = [System.IO.StreamReader]::new($c, [System.Text.Encoding]::UTF8)
function Send($o) { $w.WriteLine(($o | ConvertTo-Json -Compress -Depth 8)) }
function Wait-Reply([string]$id, [int]$ms = 10000) {
  $end = (Get-Date).AddMilliseconds($ms)
  while ((Get-Date) -lt $end) {
    $line = $r.ReadLine(); if ($null -eq $line) { return $null }
    $f = $line | ConvertFrom-Json
    if (($f.t -eq 'ack' -or $f.t -eq 'err') -and $f.id -eq $id) { return $f }
  }
  return $null
}
$fail = 0
function Assert([bool]$ok, [string]$n) {
  if ($ok) { Write-Host "  ok   $n" -ForegroundColor Green }
  else { Write-Host "  FAIL $n" -ForegroundColor Red; $script:fail++ }
}
Send @{v=1;t='hello';role='shell';proto=1;caps=@('cmd');app='m4-select';ver='0'}; $null = $r.ReadLine()
Send @{v=1;t='cmd';id='d-1';cmd='devices.list'}
$devs = (Wait-Reply 'd-1').result.devices
$nonDefault = @($devs | Where-Object { -not $_.default })
Write-Host "  info devices=$($devs.Count) 非默认且可枚举=$($nonDefault.Count)"
Send @{v=1;t='cmd';id='p-1';cmd='engine.play';data=@{track_id="file:$Track"}}
$null = Wait-Reply 'p-1'
Start-Sleep -Seconds 2
Send @{v=1;t='cmd';id='s-0';cmd='engine.state'}
$pos0 = (Wait-Reply 's-0').result.position_ms
Assert ($pos0 -gt 500) "起步 playing pos=$pos0"
if ($nonDefault.Count -ge 1) {
  $target = $nonDefault[0]
  Send @{v=1;t='cmd';id='q-1';cmd='devices.select';data=@{id=$target.id}}
  $o = Wait-Reply 'q-1'
  Assert ($o.t -eq 'ack') "钉选 '$($target.name)' → ack share=$($o.result.negotiated.share)"
  Send @{v=1;t='cmd';id='s-1';cmd='engine.state'}
  $st1 = Wait-Reply 's-1'
  Assert ($st1.result.state -eq 'playing' -and $st1.result.position_ms -ge $pos0) `
    "切换后续播位置连续（$pos0 -> $($st1.result.position_ms)）"
  # 切回跟随默认
  Send @{v=1;t='cmd';id='q-2';cmd='devices.select';data=@{id=''}}
  $o2 = Wait-Reply 'q-2'
  Assert ($o2.t -eq 'ack') "回默认（空 id）ack"
} else {
  Write-Host '  skip 无非默认枚举设备（单声卡机器）——钉选路径未覆盖，记 FINDINGS'
}
Send @{v=1;t='cmd';id='q-3';cmd='devices.select';data=@{id='{0.0.0.00000000}.{deadbeef-dead-beef-dead-deadbeefdead}'}}
$o3 = Wait-Reply 'q-3'
Assert ($o3.t -eq 'err' -and $o3.error.code -eq 'bad_request') '未知 id → bad_request'
Send @{v=1;t='cmd';id='s-2';cmd='engine.state'}
$st2 = Wait-Reply 's-2'
Assert ($st2.result.state -eq 'playing') "失败选择后播放链无损（$($st2.result.state)）"
Send @{v=1;t='bye';reason='select-done'}
$proc.WaitForExit(8000) | Out-Null
Assert ($proc.ExitCode -eq 0) 'bye 有序退出'
if ($script:fail -eq 0) { Write-Host 'M4-SELECT-SMOKE-PASS' -ForegroundColor Green; exit 0 }
Write-Host "M4-SELECT-SMOKE-FAIL ($script:fail)" -ForegroundColor Red; exit 1
