<#
.SYNOPSIS
  M6 打包：staging → zip 便携版 +（有 ISCC 时）exe 安装器，双产物落 dist-release\。

.DESCRIPTION
  产物命名：RhineMusic-win-x64-<ver>.zip / RhineMusic-<ver>-x64-setup.exe
  前置（构建机）：scripts/m-build.ps1 与 m2-build.ps1 的产物（dist-host\ 含 RhineCore.exe、dist\）；
  Inno Setup 7（ISCC.exe，缺则 WARN 只出 zip——Inno 是构建期工具，永不进产品包）。
  目标机（运行）：.NET 10 Desktop Runtime + WebView2 Runtime（iss 检测；zip 版由 README 说明）。
  版本号单一源 version.json（壳/iss/前端共读）。

.EXAMPLE
  pwsh -NoProfile -File scripts\package.ps1              # 全量（会先跑 m-build/m2-build）
  pwsh -NoProfile -File scripts\package.ps1 -SkipBuild   # 用现有 dist 直接打包
#>
[CmdletBinding()]
param(
  [switch]$SkipBuild,
  [string]$OutDir,
  [string]$MirrorRoot
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
if (-not $env:HTTPS_PROXY) { $env:HTTPS_PROXY = 'http://127.0.0.1:7897' }

$repo = (Resolve-Path -LiteralPath (Split-Path -Parent $PSScriptRoot)).ProviderPath
$ver = (Get-Content -LiteralPath (Join-Path $repo 'version.json') -Raw | ConvertFrom-Json).version
if (-not $OutDir) { $OutDir = Join-Path $repo 'dist-release' }
$work = if ($MirrorRoot) { $MirrorRoot } else { Join-Path $env:LOCALAPPDATA 'RhineMusic\package' }
$stage = Join-Path $work "stage-$ver"
$log = Join-Path $env:TEMP "package-$ver.log"

function Say([string]$m) { Write-Host "=== $m ===" -ForegroundColor Cyan }

# —— 1. 构建（复用既有脚本；产物在仓库 dist-host\ 与 dist\）——
if (-not $SkipBuild) {
  Say 'build (m-build + m2-build)'
  # 统一走 PowerShell 7（pwsh）：Windows PowerShell 5.1 对 Bypass+中文脚本+UNC 兼容差，
  # 且项目其余链（m-verify 等）均以 pwsh 为准。
  $pwsh = (Get-Command pwsh.exe -ErrorAction SilentlyContinue)?.Source
  if (-not $pwsh) { $pwsh = 'powershell.exe' }
  foreach ($s in 'm-build.ps1', 'm2-build.ps1') {
    & $pwsh -NoProfile -ExecutionPolicy Bypass -File (Join-Path $repo "scripts\$s") *> $null
    if ($LASTEXITCODE -ne 0) { throw "$s failed (exit $LASTEXITCODE) — 单独重跑看输出：pwsh scripts\$s" }
  }
}
foreach ($p in 'dist-host\RhineShell.exe', 'dist-host\core\RhineCore.exe', 'dist\index.html') {
  if (-not (Test-Path -LiteralPath (Join-Path $repo $p))) { throw "missing artifact $p — run without -SkipBuild" }
}

# —— 2. staging（本地盘组装，UNC 纪律）——
Say 'staging'
if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
New-Item -ItemType Directory -Force -Path $stage, (Join-Path $stage 'core') | Out-Null
function Robo([string]$src, [string]$dst, [string[]]$extra) {
  # 直调 robocopy.exe（cmd.exe /C 继承 UNC cwd 会喷"不支持"噪音，m-verify 同教训）。
  $argl = @("`"$src`"", "`"$dst`"", '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/R:1', '/W:1') + $extra
  $p = Start-Process -FilePath 'robocopy.exe' -ArgumentList $argl -WindowStyle Hidden -Wait -PassThru
  if ($p.ExitCode -ge 8) { throw "robocopy $src -> $dst rc=$($p.ExitCode)" }
}
Robo (Join-Path $repo 'dist-host') $stage @('/XD', (Join-Path $repo 'dist-host\core'))
Robo (Join-Path $repo 'dist-host\core') (Join-Path $stage 'core') @()
Robo (Join-Path $repo 'dist') (Join-Path $stage 'web') @()
foreach ($f in 'LICENSE', 'THIRD-PARTY-NOTICES.md', 'README.md') {
  $src = Join-Path $repo $f
  if (Test-Path -LiteralPath $src) { Copy-Item -LiteralPath $src -Destination $stage -Force }
}
# 便携版启动说明（zip 用户第一眼看到的东西）
@"
Rhine Lab Music Player $ver (portable)
--------------------------------------
双击 RhineShell.exe 启动。
前置：.NET 10 Desktop Runtime 与 WebView2 Runtime（Win11 通常自带；缺失请到官网安装）。
曲库：设置 → 库 → 添加音乐目录。
"@ | Set-Content -LiteralPath (Join-Path $stage 'README-portable.txt') -Encoding UTF8

# —— 3. zip ——
Say 'zip'
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$zip = Join-Path $OutDir "RhineMusic-win-x64-$ver.zip"
Remove-Item -LiteralPath $zip -ErrorAction SilentlyContinue
Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zip -CompressionLevel Optimal

# —— 4. exe 安装器（Inno 是构建期工具，缺则 WARN 不阻塞）——
$exe = $null
# Inno Setup 查找：Program Files（机器级）→ 用户目录（winget 无管理员时的默认落点，
# 2026-09-14 实测 JRSoftware.InnoSetup 6.7.3 装在 %LOCALAPPDATA%\Programs\Inno Setup 6）。
$iscc = @('C:\Program Files (x86)\Inno Setup 7\ISCC.exe', 'C:\Program Files\Inno Setup 7\ISCC.exe',
          'C:\Program Files (x86)\Inno Setup 6\ISCC.exe', 'C:\Program Files\Inno Setup 6\ISCC.exe',
          (Join-Path $env:LOCALAPPDATA 'Programs\Inno Setup 7\ISCC.exe'),
          (Join-Path $env:LOCALAPPDATA 'Programs\Inno Setup 6\ISCC.exe')) |
  Where-Object { Test-Path $_ } | Select-Object -First 1
if ($iscc) {
  Say "inno setup ($iscc)"
  # 中文向导语言包是官方非默认分发件：探测到才传 /DHasChinese（iss 内 #ifdef 守卫）。
  $islArgs = @()
  if (Test-Path -LiteralPath (Join-Path (Split-Path $iscc) 'Languages\ChineseSimplified.isl')) {
    $islArgs += '/DHasChinese=1'
  } else {
    Write-Host 'note: ChineseSimplified.isl 不在 Inno 语言目录——安装器用英文向导（jrsoftware.org/files/isl 可补）' -ForegroundColor DarkGray
  }
  & $iscc /Qp "/DAppVersion=$ver" "/DStageDir=$stage" "/DOutDir=$OutDir" @islArgs (Join-Path $repo 'installer\rhine.iss') 2>&1 | Tee-Object -FilePath $log | Out-Host
  if ($LASTEXITCODE -ne 0) { throw "ISCC failed (exit $LASTEXITCODE), see $log" }
  $exe = Join-Path $OutDir "RhineMusic-$ver-x64-setup.exe"
  if (-not (Test-Path -LiteralPath $exe)) { throw "installer not found at $exe" }
} else {
  Write-Host 'WARN: ISCC.exe not found — zip only（安装器需 Inno Setup 6.4+/7，README/RELEASE.md 有构建前置说明）' -ForegroundColor Yellow
}

# —— 5. 汇总 + 哈希 ——
Say 'result'
$files = @($zip) + @($exe | Where-Object { $_ })
foreach ($f in $files) {
  $h = (Get-FileHash -LiteralPath $f -Algorithm SHA256).Hash
  "{0}  {1:N1} MB  sha256={2}" -f (Split-Path $f -Leaf), ((Get-Item $f).Length / 1MB), $h
}
Write-Host "`npackage OK" -ForegroundColor Green
