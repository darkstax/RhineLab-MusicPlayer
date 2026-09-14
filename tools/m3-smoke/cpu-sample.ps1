<#
.SYNOPSIS
  M5a A2-3 CPU 对照：同一长曲 + spectrum.on，改前/改后核心各采样 3×10s 取 min
  （口径 = m-verify full 的 cpu(core<3%) 纪律：warmup 10s 丢弃起播突发，min=无干扰下界）。

.EXAMPLE
  pwsh.exe -NoProfile -ExecutionPolicy Bypass -File tools\m3-smoke\cpu-sample.ps1 `
      -CoreExe C:\Users\StarL\m2-work\host\core\build\Release\RhineCore.exe -OutFile out.json
#>
[CmdletBinding()]
param(
  [string]$CoreExe = 'C:\Users\StarL\m2-work\host\core\build\Release\RhineCore.exe',
  [string]$PipeName = 'rhine-music.m5a.cpu',
  [string]$Track = 'C:\Users\StarL\Music\Goose house - 光るなら.flac',
  [string]$OutFile,
  [int]$Samples = 3,
  [int]$SampleSeconds = 10
)
$ErrorActionPreference = 'Stop'
$work = Split-Path -Parent $CoreExe
$log = Join-Path $work ("cpu-core-" + [guid]::NewGuid().ToString("N").Substring(0, 6) + ".log")
$proc = Start-Process -FilePath $CoreExe -ArgumentList @('--pipe', $PipeName, '--verbose') `
  -WorkingDirectory $work -PassThru -WindowStyle Hidden -RedirectStandardOutput $log
try {
  $client = $null
  for ($try = 0; $try -lt 12; $try++) {
    try {
      $client = [System.IO.Pipes.NamedPipeClientStream]::new('.', $PipeName, [System.IO.Pipes.PipeDirection]::InOut)
      $client.Connect(2000); break
    } catch { Start-Sleep -Milliseconds 400 }
  }
  if (-not $client) { throw 'cannot connect pipe' }
  $reader = [System.IO.StreamReader]::new($client, [System.Text.UTF8Encoding]::new($false))
  $writer = [System.IO.StreamWriter]::new($client, [System.Text.UTF8Encoding]::new($false))
  $writer.AutoFlush = $true; $writer.NewLine = "`n"
  function Send($obj) { $writer.WriteLine(($obj | ConvertTo-Json -Compress -Depth 6)) }
  Send @{ v = 1; t = 'hello'; role = 'shell'; proto = 1; caps = @('cmd','evt.position','evt.state','spectrum'); app = 'm5a-cpu'; ver = '0.0.1' }
  # 吞掉 hello/state 首帧（读满 3 行足够：hello + state + state）
  for ($i = 0; $i -lt 3; $i++) { $null = $reader.ReadLine() }
  Send @{ v = 1; t = 'cmd'; id = 'c-1'; cmd = 'engine.play'; data = @{ track_id = "file:$Track" } }
  for ($i = 0; $i -lt 4; $i++) { $null = $reader.ReadLine() }
  Send @{ v = 1; t = 'cmd'; id = 'c-2'; cmd = 'spectrum.on' }
  Start-Sleep -Seconds 10   # warmup（起播解码/填环突发，与 m-verify 同纪律丢弃）

  $pcts = @()
  for ($s = 0; $s -lt $Samples; $s++) {
    $core = Get-Process -Id $proc.Id
    $c0 = $core.TotalProcessorTime; $t0 = Get-Date
    Start-Sleep -Seconds $SampleSeconds
    $core.Refresh()
    $wallMs = ((Get-Date) - $t0).TotalMilliseconds
    if ($wallMs -gt 0) { $pcts += (100 * ($core.TotalProcessorTime - $c0).TotalMilliseconds / $wallMs) }
  }
  $min = ($pcts | Measure-Object -Minimum).Minimum
  $result = @{ exe = $CoreExe; track = $Track; samples = ($pcts | ForEach-Object { [math]::Round($_, 2) }); min_pct = [math]::Round($min, 2) }
  Write-Host ("CPU-MIN={0:F2}% samples={1}" -f $min, ($pcts | ForEach-Object { $_.ToString('F2') }) -join ',')
  if ($OutFile) { $result | ConvertTo-Json -Compress | Set-Content -Path $OutFile -Encoding utf8 }
  Send @{ v = 1; t = 'bye'; reason = 'cpu-sample-done' }
  $proc.WaitForExit(6000) | Out-Null
} finally {
  try { Get-Process -Id $proc.Id -ErrorAction SilentlyContinue | Stop-Process -Force } catch { }
}
