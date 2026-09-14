# M4-b 升档/恢复冒烟：--dev-inject 注入 underrun → 断言 auto-expand 重建链。
# 独占模式测（period 由请求定，buffer_ms 可观测抬升；共享模式 period 被设备混音器钳制，
# 只验 auto_expanded 标志——见 FINDINGS 产品事实）。长曲光るなら(254s) 避免播完。
param(
  [string]$CoreExe = 'C:\Users\StarL\m2-work\host\core\build\Release\RhineCore.exe',
  [string]$PipeName = 'rhine-music.m4.expand',
  [string]$WorkDir = 'C:\Users\StarL\m2-work\runs\m4e',
  [string]$Track = 'C:\Users\StarL\Music\Goose house - 光るなら.flac'
)
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null
function New-Core([string]$pipe) {
  $si = [System.Diagnostics.ProcessStartInfo]::new()
  $si.FileName = $CoreExe; $si.Arguments = "--pipe $pipe --dev-inject"
  $si.WorkingDirectory = $WorkDir
  $si.RedirectStandardInput = $true; $si.RedirectStandardOutput = $true; $si.UseShellExecute = $false
  $si.CreateNoWindow = $true
  $p = [System.Diagnostics.Process]::Start($si)
  # 核心 stdout 持续抽干落盘（排障用；不抽干会满塞阻塞）
  Start-Job -ArgumentList $p -ScriptBlock {
    param($proc) while (-not $proc.StandardOutput.EndOfStream) {
      $line = $proc.StandardOutput.ReadLine()
      Add-Content -Path "C:\Users\StarL\m2-work\runs\m4e\core-$tag.log" -Value $line
    }
  } | Out-Null
  return $p
}
$fail = 0
function Assert([bool]$ok, [string]$n) {
  if ($ok) { Write-Host "  ok   $n" -ForegroundColor Green }
  else { Write-Host "  FAIL $n" -ForegroundColor Red; $script:fail++ }
}
function Session([bool]$exclusive) {
  $tag = if ($exclusive) { 'EXCL' } else { 'SHARED' }
  $pipe = "rhine-music.m4.exp.$tag"
  $proc = New-Core $pipe
  Start-Sleep -Milliseconds 900
  $c = [System.IO.Pipes.NamedPipeClientStream]::new('.', $pipe, 'InOut'); $c.Connect(5000)
  $w = [System.IO.StreamWriter]::new($c, (New-Object System.Text.UTF8Encoding($false))); $w.AutoFlush = $true; $w.NewLine = "`n"
  $r = [System.IO.StreamReader]::new($c, [System.Text.Encoding]::UTF8)
  $w.WriteLine((@{v=1;t='hello';role='shell';proto=1;caps=@('cmd');app='m4';ver='0'} | ConvertTo-Json -Compress))
  $null = $r.ReadLine()
  function Read-To([string]$id, [int]$ms) {
    $end = (Get-Date).AddMilliseconds($ms)
    while ((Get-Date) -lt $end) {
      $line = $r.ReadLine(); if ($null -eq $line) { return $null }
      $f = $line | ConvertFrom-Json
      if (($f.t -eq 'ack' -or $f.t -eq 'err') -and $f.id -eq $id) { return $f }
    }
    return $null
  }
  $mode = if ($exclusive) { 'exclusive' } else { 'shared' }
  $w.WriteLine((@{v=1;t='cmd';id='x-1';cmd='output.mode';data=@{mode=$mode;buffer_ms=5;auto_expand_buffer=$true;buffer_max_ms=300}} | ConvertTo-Json -Compress -Depth 8))
  $o1 = Read-To 'x-1' 8000
  $buf0 = $o1.result.negotiated.buffer_ms
  $share0 = $o1.result.negotiated.share
  Write-Host "  info [$tag] 起步 share=$share0 buffer_ms=$buf0"
  $w.WriteLine((@{v=1;t='cmd';id='p-1';cmd='engine.play';data=@{track_id="file:$Track"}} | ConvertTo-Json -Compress -Depth 8))
  $null = Read-To 'p-1' 8000
  $w.WriteLine((@{v=1;t='cmd';id='s-0';cmd='engine.state'} | ConvertTo-Json -Compress))
  $st0 = Read-To 's-0' 8000
  $pos0 = $st0.result.position_ms
  # play 之后才是真协商时机（无曲目时 output.mode 不重开设备——ack 里的 share 是起步值）。
  Write-Host "  info [$tag] play 后 share=$($st0.result.negotiated.share) fidelity=$($st0.result.negotiated.fidelity)"
  if ($exclusive) { Assert ($st0.result.negotiated.share -eq 'exclusive') "[$tag] play 后独占达成" }
  $proc.StandardInput.WriteLine('underrun 3'); $proc.StandardInput.Flush()
  Start-Sleep -Milliseconds 1500
  $w.WriteLine((@{v=1;t='cmd';id='s-1';cmd='engine.state'} | ConvertTo-Json -Compress))
  $st1 = Read-To 's-1' 8000
  $buf1 = $st1.result.negotiated.buffer_ms
  Write-Host "  info [$tag] 注入后 buffer_ms=$buf1 auto_expanded=$($st1.result.negotiated.auto_expanded) state=$($st1.result.state)"
  Assert ($st1.result.negotiated.auto_expanded -eq $true) "[$tag] 升档触发 auto_expanded=true"
  Assert ($st1.result.position_ms -ge $pos0) "[$tag] 重建续播位置不回退（$pos0 -> $($st1.result.position_ms)）"
  if ($exclusive) {
    Assert ($buf1 -gt $buf0) "[$tag] buffer_ms 实际抬升 $buf0 -> $buf1（策略读数）"
    # 封顶：注到顶
    for ($i = 0; $i -lt 6; $i++) { $proc.StandardInput.WriteLine('underrun 3'); $proc.StandardInput.Flush(); Start-Sleep -Milliseconds 1200 }
    $w.WriteLine((@{v=1;t='cmd';id='s-2';cmd='engine.state'} | ConvertTo-Json -Compress))
    $st2 = Read-To 's-2' 8000
    $buf2 = $st2.result.negotiated.buffer_ms
    Write-Host "  info [$tag] 封顶后 buffer_ms=$buf2 state=$($st2.result.state)"
    Assert ($buf2 -eq 300) "[$tag] 升档封顶 = buffer_max（$buf2）"
    Assert ($st2.result.state -eq 'playing') "[$tag] 高频升档长曲仍 playing"
  } else {
    Assert ($buf1 -gt $buf0) "[$tag] 共享模式策略缓冲同样抬升 $buf0 -> $buf1（设备 period 钳制归 period_ms）"
  }
  $w.WriteLine((@{v=1;t='bye';reason='done'} | ConvertTo-Json -Compress))
  $proc.StandardInput.Close(); $proc.WaitForExit(8000) | Out-Null
  Assert ($proc.ExitCode -eq 0) "[$tag] bye 有序退出 exit=$($proc.ExitCode)"
  $w.Dispose(); $r.Dispose(); $c.Dispose()
  # 独占设备释放有 drain（ma_device_stop 等缓冲排空）——跨进程会话间留窗口，
  # 否则下一进程 exclusive/shared init 吃 device-busy（实测偶发 FAIL 根因）。
  Start-Sleep -Seconds 2
}
Session $false   # 共享：验标志 + 钳制事实
Session $true    # 独占：验实际抬升 + 封顶 + playing
if ($script:fail -eq 0) { Write-Host 'M4-EXPAND-SMOKE-PASS' -ForegroundColor Green; exit 0 }
Write-Host "M4-EXPAND-SMOKE-FAIL ($script:fail)" -ForegroundColor Red; exit 1
