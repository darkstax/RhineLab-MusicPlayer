<#
.SYNOPSIS
  M 系列统一验证入口：清场 → 并行构建 → 单镜像 staging → 分级测试 → 汇总退出码。
  固化 m-build / m2-build / m1-scenario / spec-smoke / smtc-check / m3-cdp 的编排，
  worker 任务书只需引用一条命令 + 退出码（0=全绿）。

.DESCRIPTION
  Level：
    quick = 构建 + 桩裁判(m1-scenario) + 频谱冒烟×2(真核心/桩假谱)          [~3min]
    full  = quick + SMTC(-RealCore 四段) + 律动 bars/errors + 核心 CPU 30s 采样 [~6min]
  镜像纪律（UNC 四坑根治）：一切 Windows 执行都发生在 %LOCALAPPDATA%\RhineMusic\work
  （robocopy /MIR 增量、保留时间戳；cwd 永不位于 \\wsl.localhost）。
  清场纪律：残留 Rhine* 进程与 RhineMusic 组 webview2 是假失败首因（占管道/互斥体/旧缓存）。

.EXAMPLE
  pwsh.exe -NoProfile -File scripts\m-verify.ps1 -Level quick
  pwsh.exe -NoProfile -File scripts\m-verify.ps1                 # full
#>
[CmdletBinding()]
param(
  [ValidateSet('quick', 'full')] [string]$Level = 'quick',
  [switch]$SkipBuild,
  [string]$MirrorRoot,
  [string]$Track = 'C:\Users\StarL\Music\流浪地球 电影原声大碟\火石.flac',
  [string]$LongTrack = 'C:\Users\StarL\Music\Goose house - 光るなら.flac'
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
if (-not $env:HTTPS_PROXY) { $env:HTTPS_PROXY = 'http://127.0.0.1:7897' }

$repoWin = (Resolve-Path -LiteralPath (Split-Path -Parent $PSScriptRoot)).ProviderPath
if (-not $MirrorRoot) { $MirrorRoot = Join-Path $env:LOCALAPPDATA 'RhineMusic\work' }
$work = $MirrorRoot
$logDir = Join-Path $env:LOCALAPPDATA 'RhineMusic\verify-logs'
New-Item -ItemType Directory -Force -Path $work, $logDir | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$suite = Join-Path $logDir "verify-$stamp"
$results = New-Object System.Collections.ArrayList
$suiteWatch = [System.Diagnostics.Stopwatch]::StartNew()

function Step([string]$Name, [scriptblock]$Body) {
  $w = [System.Diagnostics.Stopwatch]::StartNew()
  $log = "$suite.$Name.log"
  $prevEap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  $ok = $false; $note = ''
  try {
    $out = & $Body *>&1
    $out | ForEach-Object { "$_" } | Set-Content -LiteralPath $log -Encoding UTF8
    $code = if ($null -ne $LASTEXITCODE) { $LASTEXITCODE } else { 0 }
    $okLine = ($out -join "`n") -match '(ALL PASS|SMOKE-PASS|SMTC-CHECK-PASS|build OK|passed": true|BARS-OK|CPU-OK)'
    $ok = ($code -eq 0) -and $okLine
    $note = "exit=$code" + $(if (-not $ok) { ' · ' + ((@($out | Where-Object { "$_".Trim() }) | Select-Object -Last 1) -join '') } else { '' })
  } catch { $note = $_.Exception.Message }
  $ErrorActionPreference = $prevEap
  [void]$results.Add([pscustomobject]@{ Name = $Name; Ok = $ok; Sec = [math]::Round($w.Elapsed.TotalSeconds, 1); Note = $note })
  Write-Host ("[{0}] {1} {2:F1}s {3}" -f $(if ($ok) { 'PASS' } else { 'FAIL' }), $Name.PadRight(22), $w.Elapsed.TotalSeconds, $note) -ForegroundColor $(if ($ok) { 'Green' } else { 'Red' })
  if (-not $ok) { $script:suiteFailed = $true }
  return $ok
}

# —— 0. 清场 ——
Get-Process RhineShell, RhineCore, RhineCoreStub -ErrorAction SilentlyContinue | Stop-Process -Force
Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -match 'RhineMusic' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Milliseconds 600
$suiteFailed = $false
Write-Host "=== verify level=$Level mirror=$work ===" -ForegroundColor Cyan

# —— 1. 构建（两路并行，日志文件判成败）——
if ($SkipBuild) {
  Write-Host '=== SkipBuild（信任既有产物）===' -ForegroundColor Cyan
} else {
  $w = [System.Diagnostics.Stopwatch]::StartNew()
  $pwsh = (Get-Process -Id $PID).Path
  $j1 = Start-Process -FilePath $pwsh -WindowStyle Hidden -PassThru -ArgumentList @(
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $repoWin 'scripts\m-build.ps1')) `
    -RedirectStandardOutput "$suite.build-web.log" -RedirectStandardError "$suite.build-web.err"
  $j2 = Start-Process -FilePath $pwsh -WindowStyle Hidden -PassThru -ArgumentList @(
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $repoWin 'scripts\m2-build.ps1'), '-MirrorRoot', $work) `
    -RedirectStandardOutput "$suite.build-core.log" -RedirectStandardError "$suite.build-core.err"
  $j1.WaitForExit(); $j2.WaitForExit()
  $ok1 = ($j1.ExitCode -eq 0) -and (Select-String -Path "$suite.build-web.log" -Pattern 'M build OK' -Quiet)
  $ok2 = ($j2.ExitCode -eq 0) -and (Select-String -Path "$suite.build-core.log" -Pattern 'm2 build OK' -Quiet)
  [void]$results.Add([pscustomobject]@{ Name = 'build(web+dotnet)'; Ok = $ok1; Sec = 0; Note = "exit=$($j1.ExitCode)" })
  [void]$results.Add([pscustomobject]@{ Name = 'build(core cpp)'; Ok = $ok2; Sec = 0; Note = "exit=$($j2.ExitCode)" })
  Write-Host ("build: web={0} core={1} ({2:F0}s)" -f $ok1, $ok2, $w.Elapsed.TotalSeconds) -ForegroundColor $(if ($ok1 -and $ok2) { 'Green' } else { 'Red' })
  if (-not ($ok1 -and $ok2)) {
    Get-Content "$suite.build-web.log", "$suite.build-web.err", "$suite.build-core.log", "$suite.build-core.err" -ErrorAction SilentlyContinue | Select-Object -Last 30
    exit 1
  }
}

# —— 2. staging 镜像（增量；测试层只读这些目录）——
function Robo([string]$sub, [string]$dstSub, [string[]]$xd) {
  $src = Join-Path $repoWin $sub
  if (-not (Test-Path -LiteralPath $src)) { return }
  # /XD 用数组拼；cmd 的 cwd 不能是 UNC（噪音），显式给个本地 WorkingDirectory
  $argl = @($src, (Join-Path $work $dstSub), '/MIR', '/NFL', '/NDL', '/NJH', '/NJS')
  if ($xd) { $argl += @('/XD') + $xd }   # 注意：'/XD'+$xd 是字符串拼接（bug），必须数组拼
  & cmd.exe /C robocopy @argl 2>$null | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "robocopy $sub rc=$LASTEXITCODE" }
  $global:LASTEXITCODE = 0
}
Robo 'dist' 'web\dist' @()
Robo 'dist-host' 'dist-host' @()
Robo 'scripts' 'scripts' @()
Robo 'tools' 'tools' @()
$coreExe = Join-Path $work 'dist-host\core\RhineCore.exe'
$stubExe = Join-Path $work 'dist-host\core\RhineCoreStub.exe'
$shellExe = Join-Path $work 'dist-host\RhineShell.exe'
$webDist = Join-Path $work 'web\dist'
foreach ($p in @($coreExe, $stubExe, $shellExe)) { if (-not (Test-Path $p)) { Write-Host "missing $p" -ForegroundColor Red; exit 1 } }

$scenarioPs = Join-Path $work 'scripts\m1-scenario.ps1'
$specPs = Join-Path $work 'tools\m3-smoke\spec-smoke.ps1'
$smtcPs = Join-Path $work 'tools\m3-smoke\smtc-check.ps1'
# node 在 WSL 里跑：cdp 脚本路径必须翻成 /mnt/c 形式（Windows 盘符→挂载点）
$cdpMjs = ($work -replace '^C:\\', '/mnt/c/' -replace '\\', '/') + '/tools/m3-smoke/m3-cdp.mjs'

Push-Location $work
try {
  # —— 3. 桩裁判（协议回归底线）——
  Step 'scenario(stub)' { & $scenarioPs -Scenario full -DistHost (Join-Path $work 'dist-host') } | Out-Null

  # —— 4. 频谱冒烟：真核心 + 桩假谱 ——
  Step 'spec-smoke(core)' { & $specPs -CoreExe $coreExe -Track $Track -WorkDir $work } | Out-Null
  Step 'spec-smoke(stub)' { & $specPs -CoreExe $stubExe -Stub -WorkDir $work } | Out-Null

  if ($Level -eq 'full') {
    # —— 5. SMTC 全链路（必须 WinPS 5.1：pwsh7 下 Windows.Media 投影失效）——
    Step 'smtc(real-core)' {
      & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $smtcPs `
        -DistHost (Join-Path $work 'dist-host') -WebDist $webDist -WorkDir $work -RealCore
    } | Out-Null

    # —— 6. 律动链路 + CPU 采样（起一套真核心实例，CDP 驱动）——
    $vWatch = [System.Diagnostics.Stopwatch]::StartNew()
    $pipe = 'rhine-music.verify.live'
    $cdpPort = 9240
    Get-Process RhineShell, RhineCore -ErrorAction SilentlyContinue | Stop-Process -Force
    $core = Start-Process -FilePath $coreExe -ArgumentList @('--pipe', $pipe) -PassThru -WindowStyle Hidden `
      -RedirectStandardOutput "$suite.live-core.log"
    Start-Sleep -Milliseconds 900
    $shell = Start-Process -FilePath $shellExe -ArgumentList @(
      '--pipe', $pipe, '--remote-debug-port', "$cdpPort", '--dist', $webDist) `
      -WorkingDirectory $work -PassThru -WindowStyle Hidden `
      -RedirectStandardOutput "$suite.live-shell.out" -RedirectStandardError "$suite.live-shell.err"
    Start-Sleep -Seconds 8

    function WslNode([string[]]$nodeArgs, [int]$timeoutSec = 90) {
      $idx = Get-Random -Maximum 999999
      $argsFile = "\\wsl.localhost\Ubuntu\tmp\mverify-args-$idx.json"
      [IO.File]::WriteAllText($argsFile, (ConvertTo-Json $nodeArgs -Compress), [Text.UTF8Encoding]::new($false))
      $cmd = "unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy NO_PROXY no_proxy; export NO_PROXY='*' RHINE_PW_CORE=/tmp/pwtest/node_modules/playwright-core/index.mjs; node $cdpMjs @/tmp/mverify-args-$idx.json 2>&1; rc=\$?; rm -f /tmp/mverify-args-$idx.json; exit \$rc"
      $out = & wsl.exe -e bash -lc $cmd
      $global:LASTEXITCODE = $LASTEXITCODE
      return (@($out | ForEach-Object { [string]$_ }) -join "`n")
    }

    $playTxt = WslNode @($cdpPort, 'play', "file:$LongTrack")
    $playOk = $playTxt -match '"ok":\s*true'
    Start-Sleep -Seconds 2
    $bars1 = WslNode @($cdpPort, 'bars')
    Start-Sleep -Milliseconds 400
    $bars2 = WslNode @($cdpPort, 'bars')
    $actives = @($bars1, $bars2) | Where-Object { $_ -match '"active":"1"' }
    $nonTrivial = @($bars1, $bars2) | Where-Object { $_ -match '0\.[1-9]' }
    $errTxt = WslNode @($cdpPort, 'errors')
    $noErrors = $errTxt -match '"errors":\[\]'
    # CPU：长曲播放中的 20s 窗口
    Start-Sleep -Seconds 3
    $c0 = (Get-Process -Id $core.Id).TotalProcessorTime; $t0 = Get-Date
    Start-Sleep -Seconds 20
    $core.Refresh()
    $wallMs = ((Get-Date) - $t0).TotalMilliseconds
    $cpuMs = ($core.TotalProcessorTime - $c0).TotalMilliseconds
    $cpuPct = if ($wallMs -gt 0) { 100 * $cpuMs / $wallMs } else { 0 }
    $cpuOk = $cpuPct -lt 2.0
    $barsOk = $playOk -and $actives.Count -ge 1 -and $nonTrivial.Count -ge 1 -and $noErrors
    [void]$results.Add([pscustomobject]@{ Name = 'live(bars/errors)'; Ok = $barsOk; Sec = [math]::Round($vWatch.Elapsed.TotalSeconds, 1); Note = "play=$playOk active=$($actives.Count)/2 errors=$noErrors" })
    Write-Host ("[{0}] live(bars/errors) {1:F1}s play={2} active={3}/2 errors={4}" -f $(if ($barsOk) { 'PASS' } else { 'FAIL' }), $vWatch.Elapsed.TotalSeconds, $playOk, $actives.Count, $noErrors) -ForegroundColor $(if ($barsOk) { 'Green' } else { 'Red' })
    if (-not $barsOk) { $suiteFailed = $true }
    [void]$results.Add([pscustomobject]@{ Name = 'cpu(core<2%)'; Ok = $cpuOk; Sec = 20; Note = ("{0:F2}%" -f $cpuPct) })
    Write-Host ("[{0}] cpu(core<2%) {1:F2}%" -f $(if ($cpuOk) { 'PASS' } else { 'FAIL' }), $cpuPct) -ForegroundColor $(if ($cpuOk) { 'Green' } else { 'Red' })
    if (-not $cpuOk) { $suiteFailed = $true }

    Stop-Process -Id $shell.Id -Force -ErrorAction SilentlyContinue
    Stop-Process -Id $core.Id -Force -ErrorAction SilentlyContinue
  }
} finally { Pop-Location }

# —— 汇总 ——
$elapsed = $suiteWatch.Elapsed.TotalSeconds
$verdict = if ($suiteFailed) { 'FAIL' } else { 'PASS' }
$verdictColor = if ($suiteFailed) { 'Red' } else { 'Green' }
Write-Host "`n=== VERIFY $verdict  ($([math]::Round($elapsed)) s, logs: $suite.*) ===" -ForegroundColor $verdictColor
$results | Format-Table -AutoSize
exit $(if ($suiteFailed) { 1 } else { 0 })
