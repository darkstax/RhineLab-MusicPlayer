# smtc-feed.ps1
#
# WHY THIS EXISTS
# --------------
# We are chasing a handle/thread leak attributed to BthAvctpSvc (the Windows AVCTP
# service, which backs bluetooth AVRCP media control). Measured so far:
#
#   mpv (driven by go-musicfox)  ->  ~73 handles/s  +  ~19.9 threads/s  WHILE PLAYING
#   Zen Browser (bilibili)       ->  0, flat, 42+56s with audio confirmed rendering
#   paused / stopped             ->  releases everything within ~10s, back to baseline
#
# Working hypothesis: the leak rate tracks HOW OFTEN a player updates the SMTC
# timeline. go-musicfox shows a live playback position but nothing else, which smells
# like a minimal SMTC session that pushes position updates very frequently. 73/s is
# ~13.7ms apart -- suspiciously close to an audio callback period.
#
# This tool is the measuring instrument for that hypothesis: it enumerates live SMTC
# sessions and reports what each player publishes AND how often its timeline moves.
#
# REQUIREMENTS
# ------------
#   Windows PowerShell 5.1  (powershell.exe).   NOT pwsh 7 -- PowerShell 7 ships no
#   built-in WinRT projection and cannot instantiate Windows.Media.Control types.
#
# USAGE
# -----
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\smtc-feed.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\smtc-feed.ps1 -OutFile "$env:TEMP\smtc.jsonl"
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\smtc-feed.ps1 -PipeName smtc.feed.v1
#
#   Run it, start playing something, and watch the "updatesPerSec" number for that
#   session. Play the SAME track in musicfox and in Edge, and compare.
#
# OUTPUT  (JSON Lines, one object per line)
# -----------------------------------------
#   {"k":"evt", ...}   emitted whenever status or timeline position changed
#   {"k":"sess", ...}  session metadata (title/artist/album), refreshed every 2s
#   {"k":"stat", ...}  every N seconds: how many timeline updates that session made
#   {"k":"gone", ...}  a session disappeared
#
#   The field that matters for our hypothesis is "updatesPerSec" in "stat" lines.
#
#   SAMPLING CEILING -- read this before trusting the number
#   updatesPerSec can never exceed 1000/IntervalMs. The default is 10ms => ceiling
#   100/s, which is enough to see the ~73/s that mpv seems to cause. An earlier
#   version defaulted to 50ms, whose ceiling of 20/s would have silently flattened a
#   73/s player down to 20/s -- i.e. it would have "disproved" the hypothesis by
#   construction. Keep the interval below ~13ms when measuring a fast player.

param(
    [int]$IntervalMs   = 10,
    [int]$StatEverySec = 5,
    [string]$PipeName  = "",
    [string]$OutFile   = "",
    [switch]$NoConsole
)

$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------- WinRT plumbing
try {
    Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null
}
catch {
    Write-Host "FATAL: cannot load System.Runtime.WindowsRuntime. Run this under Windows PowerShell 5.1, not pwsh." -ForegroundColor Red
    exit 1
}

$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
        $_.Name -eq 'AsTask' -and
        $_.GetParameters().Count -eq 1 -and
        $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
    })[0]

function Await($op, $resultType) {
    $asTask = $asTaskGeneric.MakeGenericMethod($resultType)
    $netTask = $asTask.Invoke($null, @($op))
    $netTask.Wait(-1) | Out-Null
    $netTask.Result
}

function J([string]$s) {
    if ($null -eq $s) { return '""' }
    $t = $s.Replace('\', '\\').Replace('"', '\"')
    $t = $t.Replace("`r", '\r').Replace("`n", '\n').Replace("`t", '\t')
    return '"' + $t + '"'
}

try {
    [void][Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
    $mgr = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
}
catch {
    Write-Host ("FATAL: cannot open the SMTC session manager: " + $_.Exception.Message) -ForegroundColor Red
    exit 1
}

# ---------------------------------------------------------------- optional pipe
# The pipe is single-instance. If the reader disconnects, we re-arm instead of
# dying -- a one-shot reader must not be able to kill the feed.
$script:pipeStream = $null
$script:writer = $null

function Open-Pipe {
    if (-not $PipeName) { return }
    if ($script:writer) { try { $script:writer.Dispose() } catch { } }
    if ($script:pipeStream) { try { $script:pipeStream.Dispose() } catch { } }
    $script:writer = $null
    $script:pipeStream = $null

    $script:pipeStream = New-Object System.IO.Pipes.NamedPipeServerStream(
        $PipeName,
        [System.IO.Pipes.PipeDirection]::Out,
        1,
        [System.IO.Pipes.PipeTransmissionMode]::Byte,
        [System.IO.Pipes.PipeOptions]::None)
    Write-Host ("waiting for a reader on \\.\pipe\" + $PipeName + " ...") -ForegroundColor Yellow
    $script:pipeStream.WaitForConnection()
    $script:writer = New-Object System.IO.StreamWriter($script:pipeStream)
    $script:writer.AutoFlush = $true
    Write-Host "reader connected" -ForegroundColor Green
}

if ($PipeName) { Open-Pipe }

function Emit([string]$line) {
    if ($PipeName) {
        if ($script:writer) {
            try { $script:writer.WriteLine($line) }
            catch {
                Write-Host ("[pipe] reader went away (" + $_.Exception.Message + "); re-arming") -ForegroundColor Yellow
                try { Open-Pipe } catch { Write-Host ("[pipe] re-arm failed: " + $_.Exception.Message) -ForegroundColor Red }
            }
        }
    }
    else {
        Write-Output $line
    }
    if (-not $NoConsole) { Write-Host $line -ForegroundColor DarkGray }
    if ($OutFile) { try { Add-Content -LiteralPath $OutFile -Value $line -Encoding UTF8 } catch { } }
}

Write-Host "--- smtc-feed: interval=${IntervalMs}ms  statEvery=${StatEverySec}s ---" -ForegroundColor Cyan
Write-Host "watching for sessions. play something and compare 'updatesPerSec' between players." -ForegroundColor Cyan

# ---------------------------------------------------------------- main loop
$state     = @{}   # appId -> signature string
$counters  = @{}   # appId -> @{ moves; t0 }
$metaCache = @{}   # appId -> @{ title; artist; album; at }
$seen      = @{}   # appId -> $true
$nextStat  = (Get-Date).AddSeconds($StatEverySec)

while ($true) {
    $now = Get-Date

    try { $sessions = @($mgr.GetSessions()) }
    catch { $sessions = @() }

    $alive = @{}

    foreach ($s in $sessions) {
        $app = $s.SourceAppUserModelId
        $alive[$app] = $true

        $pb = $s.GetPlaybackInfo()
        $tl = $s.GetTimelineProperties()
        $status = [string]$pb.PlaybackStatus
        $pos = $tl.Position
        $lu = $tl.LastUpdatedTime

        $sig = ($status + '|' + $pos.ToString() + '|' + $lu.ToString('o'))
        if ($state[$app] -ne $sig) {
            $state[$app] = $sig

            if (-not $counters.ContainsKey($app)) { $counters[$app] = @{ moves = 0; t0 = $now } }
            $counters[$app].moves = $counters[$app].moves + 1
            $seen[$app] = $true

            Emit ('{"k":"evt","t":' + (J $now.ToString('HH:mm:ss.fff')) +
                  ',"id":' + (J $app) +
                  ',"st":' + (J $status) +
                  ',"pos":' + (J $pos.ToString()) +
                  ',"lu":' + (J $lu.ToString('HH:mm:ss.fff')) + '}')
        }

        # metadata: refresh every 2s, only while the session is not stopped
        $m = $metaCache[$app]
        $need = (-not $m) -or (($now - $m.at).TotalSeconds -ge 2)
        if ($need -and $status -ne 'Stopped') {
            $title = ''; $artist = ''; $album = ''
            try {
                $mp = Await ($s.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
                $title = [string]$mp.Title
                $artist = [string]$mp.Artist
                $album = [string]$mp.AlbumTitle
            }
            catch { }
            $metaCache[$app] = @{ title = $title; artist = $artist; album = $album; at = $now }
            Emit ('{"k":"sess","t":' + (J $now.ToString('HH:mm:ss.fff')) +
                  ',"id":' + (J $app) +
                  ',"st":' + (J $status) +
                  ',"title":' + (J $title) +
                  ',"artist":' + (J $artist) +
                  ',"album":' + (J $album) + '}')
        }
    }

    # sessions that disappeared
    foreach ($k in @($state.Keys)) {
        if (-not $alive.ContainsKey($k)) {
            Emit ('{"k":"gone","t":' + (J $now.ToString('HH:mm:ss.fff')) + ',"id":' + (J $k) + '}')
            $state.Remove($k)
            $counters.Remove($k)
            $metaCache.Remove($k)
        }
    }

    # periodic rate report -- THIS is the number that answers the question
    if ($now -ge $nextStat) {
        foreach ($k in @($counters.Keys)) {
            $c = $counters[$k]
            $el = ($now - $c.t0).TotalSeconds
            $rate = 0
            if ($el -gt 0) { $rate = [math]::Round($c.moves / $el, 2) }
            Emit ('{"k":"stat","t":' + (J $now.ToString('HH:mm:ss.fff')) +
                  ',"id":' + (J $k) +
                  ',"updatesPerSec":' + $rate.ToString([System.Globalization.CultureInfo]::InvariantCulture) +
                  ',"updates":' + $c.moves +
                  ',"windowSec":' + ([math]::Round($el, 1)).ToString([System.Globalization.CultureInfo]::InvariantCulture) + '}')
            $counters[$k] = @{ moves = 0; t0 = $now }
        }
        $nextStat = $now.AddSeconds($StatEverySec)
    }

    Start-Sleep -Milliseconds $IntervalMs
}
