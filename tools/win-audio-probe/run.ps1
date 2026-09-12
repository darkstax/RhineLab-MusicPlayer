# WASAPI 端点能力探测（设备矩阵/独占格式/period），用于 docs/AUDIO-ENGINE.md §19 硬件矩阵
[Console]::OutputEncoding=[Text.Encoding]::UTF8
Set-Location $PSScriptRoot
$env:DOTNET_CLI_TELEMETRY_OPTOUT='1'
dotnet run -c Release 2>&1
