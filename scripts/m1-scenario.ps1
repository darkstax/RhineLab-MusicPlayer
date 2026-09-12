<#
.SYNOPSIS
  M1 验收 2 的无人值守状态机端到端场景：脚本假演“壳”直连命名管道，
  用真实协议帧驱动桩（hello → engine.play → 1Hz position → pause 冻结 → resume →
  seek 跳变 → volume ack → 播完自动 stopped），再重启桩验证音量持久化恢复。
  双证 = 桩 --trace 落盘 + 本脚本逐断言输出。

.DESCRIPTION
      pwsh -NoProfile -File scripts/m1-scenario.ps1 -Scenario full

  说明：脚本是**第二个客户端形态的测试驱动**，运行期间不要同时开真实壳（桩同一时刻
  只服务一个连接）；壳侧转发链路由 m1-run.ps1 + shell.log 另行取证。
  桩状态文件用临时目录（RHINE_STUB_STATE_FILE），不污染 %APPDATA%。
#>
[CmdletBinding()]
param(
  [string]$DistHost,
  [string]$Pipe = '\\.\pipe\rhine-music.m1-scenario.v1',
  [ValidateSet('full')]
  [string]$Scenario = 'full',
  [string]$LogDirectory
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Write-Step([string]$Text) { Write-Host "`n=== $Text ===" -ForegroundColor Cyan }
$script:failures = 0
function Assert([bool]$Condition, [string]$Label) {
  if ($Condition) { Write-Host "  [PASS] $Label" -ForegroundColor Green }
  else { Write-Host "  [FAIL] $Label" -ForegroundColor Red; $script:failures++ }
}

$root = (Resolve-Path -LiteralPath (Split-Path -Parent $PSScriptRoot)).ProviderPath
if (-not $DistHost) { $DistHost = Join-Path $root 'dist-host' }
$stubExe = Join-Path $DistHost 'core/RhineCoreStub.exe'
if (-not (Test-Path -LiteralPath $stubExe)) { throw "missing $stubExe — run scripts/m-build.ps1 first" }

if (-not $LogDirectory) { $LogDirectory = Join-Path $env:LOCALAPPDATA 'RhineMusic\logs' }
New-Item -ItemType Directory -Force -Path $LogDirectory | Out-Null
$traceFile = Join-Path $LogDirectory 'm1-scenario-trace.log'
$stubLog = Join-Path $LogDirectory 'm1-scenario-core.log'
$stateFile = Join-Path ([System.IO.Path]::GetTempPath()) ("rhine-m1-stub-state-{0}.json" -f ([guid]::NewGuid().ToString('N')))
Remove-Item -LiteralPath $traceFile, $stubLog, $stateFile -ErrorAction SilentlyContinue

# 取管道名末段（NamedPipeClientStream 只需名称）；避免正则转义坑，用字符串操作。
$pipeName = $Pipe.Substring($Pipe.LastIndexOf('\') + 1)

function Start-Stub {
  $env:RHINE_STUB_STATE_FILE = $stateFile
  # 每次启动独立的 stdout 日志（重启场景有两个桩生命周期，互相不覆盖证据）。
  $log = $stubLog -replace '\.log$', ('-{0:d2}.log' -f (++$script:stubInstance))
  $p = Start-Process -FilePath $stubExe -ArgumentList @('--pipe', $Pipe, '--trace', $traceFile) `
    -RedirectStandardOutput $log -PassThru -WindowStyle Hidden
  Start-Sleep -Milliseconds 600
  if ($p.HasExited) { throw "stub exited immediately (code $($p.ExitCode)); see $stubLog" }
  return $p
}

function Connect-Core {
  $client = New-Object System.IO.Pipes.NamedPipeClientStream('.', $pipeName, ([System.IO.Pipes.PipeDirection]::InOut))
  $client.Connect(5000)
  $reader = New-Object System.IO.StreamReader($client, [System.Text.Encoding]::UTF8)
  $writer = New-Object System.IO.StreamWriter($client, (New-Object System.Text.UTF8Encoding($false)))
  $writer.AutoFlush = $true
  $hello = '{"v":1,"t":"hello","role":"shell","proto":1,"caps":["cmd","evt.state","evt.position"],"app":"rhine-music-player","ver":"0.1.0"}'
  $writer.WriteLine($hello)
  $line = $reader.ReadLine()
  if (-not $line) { throw 'no hello reply from core' }
  return [pscustomobject]@{ Client = $client; Reader = $reader; Writer = $writer; Hello = ($line | ConvertFrom-Json); ReadTask = $null }
}

$script:cmdSeq = 0
$script:stubInstance = 0
function Send-Cmd($conn, [string]$cmd, [string]$dataJson) {
  $script:cmdSeq++
  $id = "m1s-$script:cmdSeq"
  # 直接拼字符串：参数形状简单（固定键名），无需 PS 层的 JSON 序列化/转义。
  if ($dataJson) {
    $line = '{"v":1,"t":"cmd","id":"' + $id + '","cmd":"' + $cmd + '","data":' + $dataJson + '}'
  } else {
    $line = '{"v":1,"t":"cmd","id":"' + $id + '","cmd":"' + $cmd + '"}'
  }
  $conn.Writer.WriteLine($line)
  return $id
}

# StreamReader 不允许并发多次 ReadLineAsync：保持一个在飞任务，超时返回后复用同一任务继续等。
function Read-Frame($conn, [int]$timeoutMs = 2000) {
  if ($null -eq $conn.ReadTask) { $conn.ReadTask = $conn.Reader.ReadLineAsync() }
  if (-not $conn.ReadTask.Wait($timeoutMs)) { return $null }
  $line = $conn.ReadTask.Result
  $conn.ReadTask = $null
  if ($null -eq $line) { return $null }
  return ($line | ConvertFrom-Json)
}

function Wait-Ack($conn, [string]$id, [int]$timeoutSec = 8) {
  $deadline = (Get-Date).AddSeconds($timeoutSec)
  while ((Get-Date) -lt $deadline) {
    $frame = Read-Frame $conn 2000
    if ($null -eq $frame) { continue }
    if (($frame.t -ceq 'ack' -or $frame.t -ceq 'err') -and $frame.id -eq $id) { return $frame }
    # 期间的事件帧忽略（由收集器另行处理）
  }
  throw "no ack/err for id=$id within ${timeoutSec}s"
}

function Collect-Evts($conn, [int]$seconds) {
  $events = @()
  $deadline = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $deadline) {
    $frame = Read-Frame $conn 1500
    if ($frame -and $frame.t -ceq 'evt') { $events += $frame }
  }
  return $events
}

# =====================================================================
Write-Step "M1 scenario=$Scenario  pipe=$Pipe"

# ---------- 1) play 30s 假曲 → 1Hz position 推进 ----------
$stub = Start-Stub
Write-Host "stub pid=$($stub.Id) trace=$traceFile" -ForegroundColor DarkGray
$conn = Connect-Core
Assert ($conn.Hello.role -eq 'core') 'hello 应答 role=core'
Assert ($null -ne $conn.Hello.ep) 'hello 携带会话世代 ep（v1.2）'
$ep1 = $conn.Hello.ep

$id = Send-Cmd $conn 'engine.play' '{"track_id":"M1-TEST","duration_ms":30000}'
$ack = Wait-Ack $conn $id
Assert ($ack.t -eq 'ack') "engine.play ack 成功（$($ack.t)）"
Assert ($ack.result.stream_token -like 'fake-*') "stream_token=$($ack.result.stream_token)"

$evts = Collect-Evts $conn 26
$positions = @($evts | Where-Object { $_.evt -ceq 'position' } | ForEach-Object { [long]$_.data.position_ms })
Assert ($positions.Count -ge 20) "1Hz position 帧数 = $($positions.Count)（要求 ≥20，26s 窗口）"
$monotonic = $true
for ($i = 1; $i -lt $positions.Count; $i++) { if ($positions[$i] -le $positions[$i-1]) { $monotonic = $false } }
Assert $monotonic "position_ms 严格单调推进（$($positions[0]) → $($positions[-1])）"
Assert ($positions[-1] -ge 20000) "末帧位置 $($positions[-1])ms ≥ 20000ms（≈每秒 1s）"
$seqs = @($evts | ForEach-Object { [long]$_.seq })
$seqMonotonic = $true
for ($i = 1; $i -lt $seqs.Count; $i++) { if ($seqs[$i] -le $seqs[$i-1]) { $seqMonotonic = $false } }
Assert $seqMonotonic 'evt.seq 单调递增'
Assert (@($evts | Where-Object { $_.ep -ne $ep1 }).Count -eq 0) '全部 evt 的 ep 一致'

# ---------- 2) pause 冻结 ----------
$id = Send-Cmd $conn 'engine.pause' $null
$ack = Wait-Ack $conn $id
Assert ($ack.result.state -eq 'paused') 'pause → ack.state=paused'
$evts = Collect-Evts $conn 4
$positions = @($evts | Where-Object { $_.evt -ceq 'position' } | ForEach-Object { [long]$_.data.position_ms })
# 首帧可能是 pause 生效前在途的 tick（位置略小），从第二帧起必须恒定 = 冻结。
$tail = @($positions | Select-Object -Skip 1)
$frozen = $tail.Count -ge 2
if ($frozen) { foreach ($p in $tail) { if ($p -ne $tail[0]) { $frozen = $false } } }
Assert $frozen "暂停期间 position 冻结（尾 $($tail.Count) 帧恒定 $($tail[0])ms）"

# ---------- 3) resume 续播 ----------
$id = Send-Cmd $conn 'engine.resume' $null
$ack = Wait-Ack $conn $id
Assert ($ack.result.state -eq 'playing') 'resume → ack.state=playing'
$evts = Collect-Evts $conn 3
$positions = @($evts | Where-Object { $_.evt -ceq 'position' } | ForEach-Object { [long]$_.data.position_ms })
$advance = ($positions.Count -ge 2 -and $positions[-1] -gt $positions[0])
Assert $advance "resume 后位置继续推进（$($positions[0]) → $($positions[-1])）"

# ---------- 4) seek 10s 跳变 ----------
$id = Send-Cmd $conn 'engine.seek' '{"position_ms":10000}'
$ack = Wait-Ack $conn $id
Assert ([long]$ack.result.applied_ms -eq 10000) 'seek → ack.applied_ms=10000'
$evts = Collect-Evts $conn 2
$positions = @($evts | Where-Object { $_.evt -ceq 'position' } | ForEach-Object { [long]$_.data.position_ms })
Assert ($positions.Count -ge 1 -and [math]::Abs($positions[0] - 10000) -le 2500) "seek 后 position 跳变到 ≈10000（实测 $($positions[0])ms）"

# ---------- 5) volume 0.3 ack + 持久化（重启恢复） ----------
$id = Send-Cmd $conn 'engine.volume' '{"mode":"hardware","value":0.3}'
$ack = Wait-Ack $conn $id
Assert ($ack.result.effective.value -eq 0.3) 'volume → ack.effective.value=0.3'
Assert ($ack.result.effective.mode -eq 'hardware') 'volume → ack.effective.mode=hardware'
Assert (Test-Path -LiteralPath $stateFile) "桩状态文件已写入 $stateFile"

$id = Send-Cmd $conn 'engine.state' $null
$ack = Wait-Ack $conn $id
Assert ($ack.result.state -eq 'playing') 'engine.state 快照 state=playing'
Assert ($null -eq $ack.result.negotiated) 'M1 豁免：negotiated=null'
Assert ($null -eq $ack.result.badges) 'M1 豁免：badges=null'

# ---------- 6) 播完自动 stopped（30s 曲 seek 到 10s，再等 ~20s） ----------
$evts = Collect-Evts $conn 22
$stopped = @($evts | Where-Object { $_.evt -ceq 'state' -and $_.data.state -eq 'stopped' })
Assert ($stopped.Count -ge 1) "播完自动 evt{state:stopped} ×$($stopped.Count)"
$id = Send-Cmd $conn 'engine.state' $null
$ack = Wait-Ack $conn $id
Assert ($ack.result.state -eq 'stopped') '曲终后 engine.state=stopped'

$conn.Client.Close()
Stop-Process -Id $stub.Id -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 500

# ---------- 7) 重启桩：音量持久化恢复（验收 2 尾项） ----------
$stub = Start-Stub
$conn = Connect-Core
$stateEvts = Collect-Evts $conn 2
# 协议 §9：握手后桩立刻补发 state 快照。
$restored = @($stateEvts | Where-Object { $_.evt -ceq 'state' })
Assert ($restored.Count -ge 1) '重启后握手补发 state 快照（§9）'
Assert ($restored[-1].data.volume -eq 0.3) "重启后音量恢复 0.3（实测 $($restored[-1].data.volume)）"
Assert ($conn.Hello.ep -eq 1) '新进程 ep 从 1 重新开始（进程内世代）'

$conn.Client.Close()
Stop-Process -Id $stub.Id -Force -ErrorAction SilentlyContinue

# ---------- trace 双证 ----------
Write-Step 'trace 双证（桩落盘 vs 客户端收集）'
$traceLines = @()
if (Test-Path -LiteralPath $traceFile) { $traceLines = @(Get-Content -LiteralPath $traceFile) }
Assert ($traceLines.Count -ge 50) "trace 行数 = $($traceLines.Count)（≥50）"
$tracePositions = @($traceLines | Where-Object { $_ -match 'evt=position' })
Assert ($tracePositions.Count -ge 45) "trace position 行数 = $($tracePositions.Count)"
Write-Host "  样例: $($tracePositions[0])" -ForegroundColor DarkGray
Write-Host "  样例: $($tracePositions[-1])" -ForegroundColor DarkGray

Remove-Item -LiteralPath $stateFile -ErrorAction SilentlyContinue

Write-Step '结果'
if ($script:failures -eq 0) {
  Write-Host 'M1 scenario full: ALL PASS' -ForegroundColor Green
  exit 0
} else {
  Write-Host "M1 scenario full: $($script:failures) FAILURES" -ForegroundColor Red
  exit 1
}
