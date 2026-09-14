<#
.SYNOPSIS
  M 系列统一验证入口：清场 → 构建指纹 → 并行构建 → 单镜像 staging → 并行测试 → 缓存/汇总退出码。
  worker/reviewer 任务书只需引用一条命令 + 退出码（0=全绿）。

.DESCRIPTION
  Level：
    quick = 构建 + [并行] 桩裁判(scale) + 频谱冒烟×2            [目标 ~1.5min]
    full  = quick + SMTC(-RealCore 四段) + 律动 bars/errors + CPU 采样  [目标 ~3min]
  加速四件套（2026-09-13 用户裁定 A-D）：
    A 桩 --time-scale（假引擎时钟 N×，tick 真实 1Hz）→ 裁判窗长按 N 缩短
    B 测试层并行（管道类互不冲突；壳类因单实例互斥体串行）
    C 验证缓存（git 指纹 = 上次同 Level PASS 的指纹 → 直接秒过；-NoCache 强制）
    D WSL 快车道（dotnet test 等纯逻辑测试不经 pwsh，见 GOAL-AUTONOMY §3）
  时间戳陷阱根治：robocopy 保留 WSL 源 mtime（常早于上次产物 → MSBuild/CMake 误判
  "无需重编"，实测踩过）。对策 = git 指纹变化时 touch 变更源 + 镜像复制清单 touch 目标。

.EXAMPLE
  pwsh.exe -NoProfile -File scripts\m-verify.ps1                     # full
  pwsh.exe -NoProfile -File scripts\m-verify.ps1 -Level quick        # 提交前门槛
  pwsh.exe -NoProfile -File scripts\m-verify.ps1 -NoCache -Level full
#>
[CmdletBinding()]
param(
  [ValidateSet('quick', 'full')] [string]$Level = 'quick',
  [switch]$SkipBuild,
  [switch]$NoCache,
  [ValidateRange(1, 4)] [int]$TimeScale = 4,
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
$suiteFailed = $false
$pwsh = (Get-Process -Id $PID).Path   # 本 pwsh7 绝对路径（子进程复用）

function Add-Result([string]$Name, [bool]$Ok, [double]$Sec, [string]$Note) {
  [void]$results.Add([pscustomobject]@{ Name = $Name; Ok = $Ok; Sec = [math]::Round($Sec, 1); Note = $Note })
  $c = if ($Ok) { 'Green' } else { 'Red' }
  Write-Host ("[{0}] {1} {2,6:F1}s {3}" -f $(if ($Ok) { 'PASS' } else { 'FAIL' }), $Name.PadRight(20), $Sec, $Note) -ForegroundColor $c
  if (-not $Ok) { $script:suiteFailed = $true }
}

# —— 0. 清场（残留进程 = 假失败首因：占管道 exit=3 / 占互斥体秒退 / webview2 组旧缓存）——
Get-Process RhineShell, RhineCore, RhineCoreStub -ErrorAction SilentlyContinue | Stop-Process -Force
Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -match 'RhineMusic' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Milliseconds 600
Write-Host "=== verify level=$Level scale=$TimeScale mirror=$work ===" -ForegroundColor Cyan

# —— 1. git 构建指纹（缓存判定 + 强制重编触发器）——
function Git-Out([string]$cmd) {
  # Windows git 对 UNC（-C 与 cwd 皆败，exit 128/129，实测）→ 走 WSL 原生 git。
  # $cmd 为完整 bash 命令（内部只用单引号，路径均 ASCII 无空格）；失败/非零退出 → 空数组。
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = 'wsl.exe'
  $psi.Arguments = '-e bash -c "' + $cmd + '"'
  $psi.RedirectStandardOutput = $true
  $psi.UseShellExecute = $false
  $psi.StandardOutputEncoding = [System.Text.Encoding]::UTF8
  $proc = [System.Diagnostics.Process]::Start($psi)
  $stdout = $proc.StandardOutput.ReadToEnd()
  $proc.WaitForExit()
  if ($proc.ExitCode -ne 0) {
    # 静默返空会让"指纹退化"与"touch 失效"同时哑火（审查 P0-1 根因放大器）→ 必须出声。
    Write-Warning "Git-Out failed (exit=$($proc.ExitCode)): $cmd"
    return @()
  }
  return @($stdout -split "`n" | Where-Object { $_ -ne '' })
}

function Get-BuildFingerprint {
  # repoWin 的 WSL 视角（本仓固定；换仓需同步或自动转换）
  $repoLinux = '/home/starl/ai-code/RhineLab-MusicPlayer'
  $head = (Git-Out "git -C $repoLinux rev-parse --short HEAD") -join ''
  $changed = @(Git-Out "git -C $repoLinux diff --name-only HEAD") +
             @(Git-Out "git -C $repoLinux ls-files --others --exclude-standard")
  # （ASCII 路径版）
  $changed = @($changed | Where-Object { $_ } | Sort-Object -Unique)
  $blobs = @()
  if ($changed.Count -gt 0) {
    # 清单写本地盘（\wsl.localhost 反推 /mnt/c 路径给 WSL 读）
    $listWin = Join-Path $work '.fp-list.txt'
    [IO.File]::WriteAllLines($listWin, [string[]]$changed, [Text.UTF8Encoding]::new($false))
    # 清单经 /mnt/c 文件传给 WSL git（中文文件名不过 PowerShell 字符串管道）
    # 盘符大小写不敏感且按实际盘符映射（LOCALAPPDATA 可能是 c:\\...，审查附带项）
    $drv = ($listWin.Substring(0,1)).ToLower()
    $listLinux = ('/mnt/' + $drv + ($listWin.Substring(2) -replace '\\', '/'))
    # ⚠ --stdin 会把清单当**一段数据**出一个 blob（内容变更不进指纹，审查 P0-1）；
    # --stdin-paths 才是"逐行列出的路径各算一个 blob"。
    $blobs = Git-Out "git -C $repoLinux hash-object --stdin-paths < '$listLinux'"
  }
  $sha = ([Security.Cryptography.SHA256]::Create()).ComputeHash(
    [Text.Encoding]::UTF8.GetBytes("$head|$($changed -join ',')|$($blobs -join ',')"))
  return "$head-$(([BitConverter]::ToString($sha)).Replace('-','').Substring(0,16))"
}

$fp = Get-BuildFingerprint
$fpFile = Join-Path $work '.build-fingerprint'
$passFile = Join-Path $work ".verify-pass-$Level.$TimeScale"
$fpOld = if (Test-Path $fpFile) { (Get-Content $fpFile -Raw).Trim() } else { '' }

# C：缓存命中 = 同 Level+Scale 上次全绿且指纹未变 → 秒过
if (-not $NoCache -and (Test-Path $passFile) -and ((Get-Content $passFile -Raw).Trim() -eq $fp)) {
  Write-Host "=== VERIFY PASS (cached, fingerprint=$fp) ===" -ForegroundColor Green
  exit 0
}

# A 触发器：指纹变化 → touch 变更源文件（robocopy 必然复制 → 镜像 mtime 新 → 重编）
if (-not $SkipBuild -and $fp -ne $fpOld) {
  # 审查 P0-1：这里曾用旧数组签名 Git-Out @('-C',...)（改单字符串形参后恒返空 → touched 恒 0，
  # "强制重编"兜底静默失效）。统一走 WSL git 字符串形参，与 Get-BuildFingerprint 同源。
  $repoLinux = '/home/starl/ai-code/RhineLab-MusicPlayer'
  $changed = @(Git-Out "git -C $repoLinux diff --name-only HEAD") +
              @(Git-Out "git -C $repoLinux ls-files --others --exclude-standard")
  $now = Get-Date; $n = 0
  foreach ($rel in ($changed | Sort-Object -Unique)) {
    if (-not $rel) { continue }
    if ($rel -notmatch '^(host|src|scripts|tools|content|index\.html|package\.json|vite\.config\.ts|tsconfig)') { continue }
    $win = Join-Path $repoWin ($rel -replace '/', '\')
    if (Test-Path -LiteralPath $win) { (Get-Item -LiteralPath $win -Force).LastWriteTime = $now; $n++ }
  }
  Write-Host "fingerprint [$fpOld] -> [$fp] touched=$n (force rebuild)" -ForegroundColor Yellow
}

# —— 2. 并行构建（web+dotnet ∥ C++）——
if ($SkipBuild) {
  Write-Host '=== SkipBuild（信任既有产物）===' -ForegroundColor Cyan
} else {
  $w = [System.Diagnostics.Stopwatch]::StartNew()
  $j1 = Start-Process -FilePath $pwsh -WindowStyle Hidden -PassThru -ArgumentList @(
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $repoWin 'scripts\m-build.ps1')) `
    -RedirectStandardOutput "$suite.build-web.log" -RedirectStandardError "$suite.build-web.err"
  $j2 = Start-Process -FilePath $pwsh -WindowStyle Hidden -PassThru -ArgumentList @(
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $repoWin 'scripts\m2-build.ps1'), '-MirrorRoot', $work) `
    -RedirectStandardOutput "$suite.build-core.log" -RedirectStandardError "$suite.build-core.err"
  $j1.WaitForExit(); $j2.WaitForExit()
  $ok1 = ($j1.ExitCode -eq 0) -and (Select-String -Path "$suite.build-web.log" -Pattern 'M build OK' -Quiet)
  $ok2 = ($j2.ExitCode -eq 0) -and (Select-String -Path "$suite.build-core.log" -Pattern 'm2 build OK' -Quiet)
  Add-Result 'build(web+dotnet)' $ok1 $w.Elapsed.TotalSeconds "exit=$($j1.ExitCode)"
  Add-Result 'build(core cpp)' $ok2 0 "exit=$($j2.ExitCode)"
  if (-not ($ok1 -and $ok2)) {
    Get-Content "$suite.build-web.log", "$suite.build-web.err", "$suite.build-core.log", "$suite.build-core.err" -ErrorAction SilentlyContinue | Select-Object -Last 30
    exit 1
  }
  Set-Content -LiteralPath $fpFile -Value $fp -NoNewline
}

# —— 3. staging 镜像（robocopy /MIR；新鲜度由 §1 git 指纹保证）——
function Robo([string]$sub, [string]$dstSub, [string[]]$xd) {
  $src = Join-Path $repoWin $sub
  if (-not (Test-Path -LiteralPath $src)) { return }
  $dst = Join-Path $work $dstSub
  New-Item -ItemType Directory -Force -Path $dst | Out-Null
  # 日志必须无空格路径（robocopy /LOG: 对空格敏感）→ 放目标目录内，用完即删
  $rlog = Join-Path $dst '.robolog.txt'
  $argl = @("`"$src`"", "`"$dst`"", '/MIR', '/NFL', '/NDL', '/NJH', '/NP', '/R:1', '/W:1', "/LOG:`"$rlog`"")
  if ($xd) { $argl += @('/XD') + $xd }
  # Start-Process 直调 exe：绕开 cmd.exe 的 UNC cwd 与 PS 的 NativeCommandError 噪音
  $rp = Start-Process -FilePath 'robocopy.exe' -ArgumentList $argl -WindowStyle Hidden -Wait -PassThru
  if ($rp.ExitCode -ge 8) { throw "robocopy $sub rc=$($rp.ExitCode)" }
  $global:LASTEXITCODE = 0
  # 不做"复制清单 touch"：WSL 源 mtime 常早于镜像目标副本 → robocopy 不报 Newer（实测 touched=0），
  # 清单机制在此场景无效。新鲜度由 §1 的 git 指纹保证（变更时 touch **源** → robocopy 必然复制）。
  Remove-Item -LiteralPath $rlog -Force -ErrorAction SilentlyContinue
}
$w = [System.Diagnostics.Stopwatch]::StartNew()
Robo 'host' 'host' @('bin', 'obj', '.vs')
Robo 'scripts' 'scripts' @()
Robo 'tools' 'tools' @()
Robo 'dist' 'web\dist' @()
Robo 'dist-host' 'dist-host' @()
Add-Result 'mirror' $true $w.Elapsed.TotalSeconds 'ok'
$coreExe = Join-Path $work 'dist-host\core\RhineCore.exe'
$stubExe = Join-Path $work 'dist-host\core\RhineCoreStub.exe'
$shellExe = Join-Path $work 'dist-host\RhineShell.exe'
$webDist = Join-Path $work 'web\dist'
foreach ($p in @($coreExe, $stubExe, $shellExe)) { if (-not (Test-Path $p)) { Write-Host "missing $p" -ForegroundColor Red; exit 1 } }

# —— 4. 测试层（B：管道类并行；壳类因单实例互斥体串行在后）——
$scenarioPs = Join-Path $work 'scripts\m1-scenario.ps1'
$specPs = Join-Path $work 'tools\m3-smoke\spec-smoke.ps1'
$smtcPs = Join-Path $work 'tools\m3-smoke\smtc-check.ps1'
$feedPs = Join-Path $work 'tools\smtc-feed\smtc-feed.ps1'
$cdpMjs = ($work -replace '^C:\\', '/mnt/c/' -replace '\\', '/') + '/tools/m3-smoke/m3-cdp.mjs'
$pwsh = (Get-Process -Id $PID).Path

function Start-Child([string]$name, [string]$file, [string[]]$childArgs, [string]$cwd) {
  $dir = Join-Path $work ("runs\$name"); New-Item -ItemType Directory -Force -Path $dir | Out-Null
  # 注意①：-ArgumentList @(...) + $childArgs 会被解析成位置参数（实测报错），必须先拼变量。
  # 注意②：子参数含空格/中文（如曲目路径）时 Start-Process 拼命令行会拆词（实测），
  #        全部显式加双引号（-File 路径同理）。
  $quoted = @($childArgs | ForEach-Object { '"' + ("" + $_).Replace('"', '\"') + '"' })
  $fullArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $file + '"')) + $quoted
  $p = Start-Process -FilePath $pwsh -WindowStyle Hidden -PassThru -ArgumentList $fullArgs `
    -WorkingDirectory $cwd -RedirectStandardOutput "$dir\out.log" -RedirectStandardError "$dir\err.log"
  return @{ Name = $name; Proc = $p; Dir = $dir }
}
function Finish-Child($job, [string]$pattern) {
  $w = $job.Proc
  $w.WaitForExit()
  $txt = (Get-Content "$($job.Dir)\out.log" -Raw -ErrorAction SilentlyContinue)
  if (-not $txt) { $txt = '' }
  $ok = ($w.ExitCode -eq 0) -and ($txt -match $pattern)
  $note = "exit=$($w.ExitCode)"
  if (-not $ok) { $note += ' · ' + ((($txt -split "`n" | Where-Object { "$_".Trim() }) | Select-Object -Last 1) -join '') }
  Add-Result $job.Name $ok 0 $note
  return $ok
}

$groupA = @()
foreach ($d in @('scenario', 'spec-core', 'spec-stub', 'smtc', 'live')) {
  New-Item -ItemType Directory -Force -Path (Join-Path $work "runs\$d") | Out-Null
}
$groupA += Start-Child 'scenario-stub' $scenarioPs @(
  '-Scenario', 'full', '-TimeScale', "$TimeScale",
  '-DistHost', (Join-Path $work 'dist-host'),
  '-Pipe', "\\.\pipe\rhine-music.verify.scenario",
  '-LogDirectory', (Join-Path $work 'runs\scenario')) $work
$groupA += Start-Child 'spec-core' $specPs @(
  '-CoreExe', $coreExe, '-Track', $Track, '-WorkDir', (Join-Path $work 'runs\spec-core'),
  '-PipeName', 'rhine-music.verify.spec-core') $work
$groupA += Start-Child 'spec-stub' $specPs @(
  '-CoreExe', $stubExe, '-Stub', '-WorkDir', (Join-Path $work 'runs\spec-stub'),
  '-PipeName', 'rhine-music.verify.spec-stub') $work
$wA = [System.Diagnostics.Stopwatch]::StartNew()
foreach ($j in $groupA) { $null = Finish-Child $j '(ALL PASS|SMOKE-PASS)' }
Write-Host ("group-A parallel wall: {0:F1}s" -f $wA.Elapsed.TotalSeconds) -ForegroundColor DarkGray

if (-not $suiteFailed -and $Level -eq 'full') {
  # —— SMTC 全链路（必须 WinPS 5.1：pwsh7 无 WinRT 投影）——
  $wS = [System.Diagnostics.Stopwatch]::StartNew()
  $smtcDir = Join-Path $work 'runs\smtc'; New-Item -ItemType Directory -Force -Path $smtcDir | Out-Null
  $smtcProc = Start-Process -FilePath 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' `
    -WindowStyle Hidden -PassThru -ArgumentList @(
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $smtcPs,
    '-DistHost', (Join-Path $work 'dist-host'), '-WebDist', $webDist,
    '-WorkDir', $smtcDir, '-RealCore') `
    -WorkingDirectory $work -RedirectStandardOutput "$smtcDir\out.log" -RedirectStandardError "$smtcDir\err.log"
  $smtcProc.WaitForExit()
  $txt = Get-Content "$smtcDir\out.log" -Raw -ErrorAction SilentlyContinue
  $okSmtc = ($smtcProc.ExitCode -eq 0) -and ($txt -match 'SMTC-CHECK-PASS')
  if (-not $okSmtc) {
    # 诊断：用户工具 smtc-feed 抓 6s 会话快照（定位"找不到 SMTC 会话"类问题）
    if (Test-Path $feedPs) {
      $feed = Start-Process -FilePath 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' -WindowStyle Hidden -PassThru `
        -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $feedPs, '-StatEverySec', '2', '-NoConsole', '-OutFile', "$smtcDir\smtc-feed.jsonl") `
        -WorkingDirectory $work
      Start-Sleep -Seconds 6; Stop-Process -Id $feed.Id -Force -ErrorAction SilentlyContinue
    }
    Add-Result 'smtc(real-core)' $false $wS.Elapsed.TotalSeconds "exit=$($smtcProc.ExitCode)（快照见 $smtcDir\smtc-feed.jsonl）"
  } else {
    Add-Result 'smtc(real-core)' $true $wS.Elapsed.TotalSeconds 'ok'
  }

  # —— 律动 + CPU（真核心长曲；与 SMTC 串行=壳单实例）——
  $vWatch = [System.Diagnostics.Stopwatch]::StartNew()
  Get-Process RhineShell, RhineCore -ErrorAction SilentlyContinue | Stop-Process -Force
  Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match 'RhineMusic' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
  Start-Sleep -Milliseconds 600
  $pipe = 'rhine-music.verify.live'
  $cdpPort = 9240
  $core = Start-Process -FilePath $coreExe -ArgumentList @('--pipe', $pipe) -PassThru -WindowStyle Hidden `
    -RedirectStandardOutput "$suite.live-core.log"
  Start-Sleep -Milliseconds 900
  $shell = Start-Process -FilePath $shellExe -ArgumentList @(
    '--pipe', $pipe, '--remote-debug-port', "$cdpPort", '--dist', $webDist) `
    -WorkingDirectory $work -PassThru -WindowStyle Hidden `
    -RedirectStandardOutput "$suite.live-shell.out" -RedirectStandardError "$suite.live-shell.err"
  Start-Sleep -Seconds 8

  function WslNode([object[]]$nodeArgs) {
    $idx = Get-Random -Maximum 999999
    $argsWin = "\\wsl.localhost\Ubuntu\tmp\mverify-args-$idx.json"
    [IO.File]::WriteAllText($argsWin, (ConvertTo-Json $nodeArgs -Compress), [Text.UTF8Encoding]::new($false))
    $cmd = "unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy NO_PROXY no_proxy; export NO_PROXY='*' RHINE_PW_CORE=/tmp/pwtest/node_modules/playwright-core/index.mjs; node $cdpMjs @/tmp/mverify-args-$idx.json 2>&1; rc=`$?; rm -f /tmp/mverify-args-$idx.json; exit `$rc"
    $out = & wsl.exe -e bash -lc $cmd
    return (@($out | ForEach-Object { [string]$_ }) -join "`n")
  }
  $playOk = (WslNode @($cdpPort, 'play', "file:$LongTrack")) -match '"ok":\s*true'
  Start-Sleep -Seconds 2
  $bars1 = WslNode @($cdpPort, 'bars'); Start-Sleep -Milliseconds 400; $bars2 = WslNode @($cdpPort, 'bars')
  $noErrors = (WslNode @($cdpPort, 'errors')) -match '"errors":\[\]'
  $actives = @($bars1, $bars2) | Where-Object { $_ -match '"active":"1"' }
  $nonTrivial = @($bars1, $bars2) | Where-Object { $_ -match '0\.[1-9]' }
  $barsOk = $playOk -and $actives.Count -ge 1 -and $nonTrivial.Count -ge 1 -and $noErrors
  Add-Result 'live(bars/errors)' $barsOk $vWatch.Elapsed.TotalSeconds "play=$playOk active=$($actives.Count)/2 errors=$noErrors"

  # CPU 采样纪律（实测教训）：同负载读数受系统噪声影响（1.3%↔3.12%），
  # 单次测量无统计意义 → warmup 10s 丢弃（起播解码/填充突发）+ 3×10s 取**最小值**
  # （min = 无干扰时的稳定下界，正是我们要卡的"核心自身开销"）。
  $cpuPct = 999.0
  Start-Sleep -Seconds 10
  for ($i = 0; $i -lt 3; $i++) {
    $c0 = (Get-Process -Id $core.Id).TotalProcessorTime; $t0 = Get-Date
    Start-Sleep -Seconds 10
    $core.Refresh()
    $wallMs = ((Get-Date) - $t0).TotalMilliseconds
    if ($wallMs -gt 0) { $cpuPct = [math]::Min($cpuPct, 100 * ($core.TotalProcessorTime - $c0).TotalMilliseconds / $wallMs) }
  }
  Add-Result 'cpu(core<3%)' ($cpuPct -lt 3.0) 40 ("min={0:F2}% (3x10s after warmup)" -f $cpuPct)

  Stop-Process -Id $shell.Id -Force -ErrorAction SilentlyContinue
  Stop-Process -Id $core.Id -Force -ErrorAction SilentlyContinue
}

# —— 汇总 + 缓存写入 ——
$elapsed = [math]::Round($suiteWatch.Elapsed.TotalSeconds)
if ($suiteFailed) {
  Remove-Item -LiteralPath $passFile -ErrorAction SilentlyContinue
  Write-Host "`n=== VERIFY FAIL (${elapsed}s) logs: $suite.* / $work\runs\* ===" -ForegroundColor Red
} else {
  Set-Content -LiteralPath $passFile -Value $fp -NoNewline
  Write-Host "`n=== VERIFY PASS (${elapsed}s, fingerprint $fp 已缓存) ===" -ForegroundColor Green
}
$results | Format-Table -AutoSize
exit $(if ($suiteFailed) { 1 } else { 0 })
