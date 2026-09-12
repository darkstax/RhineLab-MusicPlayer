$ErrorActionPreference='Stop'
$bin = Join-Path $env:LOCALAPPDATA 'RhineMusic\bin'
$stubExe = Join-Path $bin 'core/RhineCoreStub.exe'
$shellExe = Join-Path $bin 'RhineShell.exe'
$logs = Join-Path $env:LOCALAPPDATA 'RhineMusic\logs'
$stubLog = Join-Path $logs 'm1-e2e-core.log'
Remove-Item -LiteralPath $stubLog -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $env:APPDATA\RhineMusic\config.json -ErrorAction SilentlyContinue
$stub = Start-Process -FilePath $stubExe -ArgumentList @('--pipe','\\.\pipe\rhine-music.core.v1','--verbose','--halt-events','25') -RedirectStandardOutput $stubLog -PassThru -WindowStyle Hidden
Start-Sleep -Milliseconds 700
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--remote-debugging-port=9223'
$shell = Start-Process -FilePath $shellExe -ArgumentList @() -PassThru
Write-Host "stub=$($stub.Id) shell=$($shell.Id)"
Start-Sleep -Seconds 4
Write-Host "stub alive=$(-not $stub.HasExited) shell alive=$(-not $shell.HasExited)"
