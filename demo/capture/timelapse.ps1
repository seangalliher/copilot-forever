# Time-lapse of the screen during a long agent run (Windows; needs ffmpeg on PATH).
#
#   pwsh demo/capture/timelapse.ps1 start [-Every 5] [-Monitor primary|all] [-Window <title regex>] [-Dir <folder>]
#       Saves one JPEG every -Every seconds in the background, until stopped. Survives closing the
#       terminal; a restart continues the numbering. Frames are plain files, so a crash loses nothing.
#       -Window captures one window only (for example -Window '^Agents$' for the VS Code Agents window),
#       through Windows Graphics Capture: it works while other windows cover it, and nothing else on the
#       screen is recorded. If that window closes (quitting VS Code), capture stops; run start again.
#   pwsh demo/capture/timelapse.ps1 stop
#   pwsh demo/capture/timelapse.ps1 status
#   pwsh demo/capture/timelapse.ps1 build [-Seconds 75] [-Out <file.mp4>]
#       Turns the frames into a 1920x1080 clip of about -Seconds seconds (30 fps). A wider screen
#       (e.g. an ultrawide monitor) is letterboxed to fit.
#
# Frames go to %USERPROFILE%\Videos\goal-loop-timelapse\frames by default: outside the repo, and they
# show your whole screen, so look through them before sharing.
param(
    [Parameter(Position = 0, Mandatory)][ValidateSet('start', 'stop', 'status', 'build')][string]$Action,
    [double]$Every = 5,
    [ValidateSet('primary', 'all')][string]$Monitor = 'primary',
    [string]$Window,
    [string]$Dir = (Join-Path ([Environment]::GetFolderPath('MyVideos')) 'goal-loop-timelapse'),
    [double]$Seconds = 75,
    [string]$Out
)
$ErrorActionPreference = 'Stop'
$frames = Join-Path $Dir 'frames'
$pidFile = Join-Path $Dir 'ffmpeg.pid'
$ffmpeg = (Get-Command ffmpeg -ErrorAction Stop).Source
New-Item -ItemType Directory -Force $frames | Out-Null

function Get-Running {
    if (-not (Test-Path $pidFile)) { return $null }
    $p = Get-Process -Id ([int](Get-Content $pidFile)) -ErrorAction SilentlyContinue
    if ($p -and $p.ProcessName -eq 'ffmpeg') { return $p }
    return $null
}
function Get-Frames { @(Get-ChildItem $frames -Filter '*.jpg' | Sort-Object Name) }

switch ($Action) {
    'start' {
        if (Get-Running) { Write-Host "already running (pid $(Get-Content $pidFile))"; exit 0 }
        $existing = Get-Frames
        $next = if ($existing.Count) { [int]$existing[-1].BaseName + 1 } else { 1 }
        $out = @('-q:v', '4', '-start_number', "$next", (Join-Path $frames '%06d.jpg'))
        if ($Window) {
            # gdigrab returns black frames for GPU-drawn windows such as VS Code; Windows Graphics
            # Capture (ffmpeg 8+, gfxcapture) does not. fps= keeps a steady rate when the window is idle.
            $re = $Window -replace '([\:,;\[\]=''])', '\$1'
            $fc = "gfxcapture=window_title=$($re):max_framerate=2,hwdownload,format=bgra,fps=1/$Every,scale='min(1920,iw)':-2"
            $ffArgs = @('-hide_banner', '-loglevel', 'error', '-filter_complex', "`"$fc`"") + $out
        } else {
            $grab = @('-f', 'gdigrab', '-framerate', "1/$Every", '-draw_mouse', '1')
            if ($Monitor -eq 'primary') {
                Add-Type -AssemblyName System.Windows.Forms
                $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
                $grab += @('-offset_x', "$($b.X)", '-offset_y', "$($b.Y)", '-video_size', "$($b.Width)x$($b.Height)")
            }
            $ffArgs = @('-hide_banner', '-loglevel', 'error') + $grab + @('-i', 'desktop', '-vf', 'scale=1920:-2') + $out
        }
        $p = Start-Process -FilePath $ffmpeg -ArgumentList $ffArgs -WindowStyle Hidden -PassThru `
            -RedirectStandardError (Join-Path $Dir 'ffmpeg.err.txt')
        Set-Content $pidFile $p.Id
        Write-Host "time-lapse started (pid $($p.Id)): one frame every $Every s, $(if ($Window) { "window /$Window/" } else { "$Monitor monitor" }), into $frames"
    }
    'stop' {
        $p = Get-Running
        if (-not $p) { Write-Host 'not running'; exit 0 }
        Stop-Process -Id $p.Id -Force
        Start-Sleep 1
        # The frame being written at the moment of the stop can be cut short: drop it if it's empty.
        $last = (Get-Frames)[-1]
        if ($last -and $last.Length -lt 1024) { Remove-Item $last.FullName }
        Remove-Item $pidFile -ErrorAction SilentlyContinue
        Write-Host "stopped; $((Get-Frames).Count) frames in $frames"
    }
    'status' {
        $p = Get-Running
        $f = Get-Frames
        $span = if ($f.Count -gt 1) { '{0:N1} h' -f (($f[-1].LastWriteTime - $f[0].LastWriteTime).TotalHours) } else { '-' }
        Write-Host ("{0}; {1} frames covering {2}; folder {3}" -f $(if ($p) { "running (pid $($p.Id))" } else { 'stopped' }), $f.Count, $span, $frames)
    }
    'build' {
        $f = Get-Frames
        if ($f.Count -lt 2) { throw "only $($f.Count) frames in $frames" }
        if (-not $Out) { $Out = Join-Path $Dir 'timelapse.mp4' }
        # Renumber into a gap-free sequence so restarts and deleted frames don't break the input pattern.
        $seq = Join-Path $Dir 'seq'
        Remove-Item $seq -Recurse -Force -ErrorAction SilentlyContinue
        New-Item -ItemType Directory $seq | Out-Null
        $i = 0
        foreach ($x in $f) { $i++; New-Item -ItemType HardLink -Path (Join-Path $seq ('{0:D6}.jpg' -f $i)) -Target $x.FullName | Out-Null }
        $rate = [math]::Max(1, [math]::Round($f.Count / $Seconds, 3))
        & $ffmpeg -hide_banner -loglevel error -y -framerate $rate -i (Join-Path $seq '%06d.jpg') `
            -vf 'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,format=yuv420p' -r 30 -c:v libx264 -crf 20 -movflags +faststart $Out
        if ($LASTEXITCODE) { throw "ffmpeg failed ($LASTEXITCODE)" }
        Remove-Item $seq -Recurse -Force
        Write-Host ("built {0}: {1} frames at {2} fps = {3:N0} s" -f $Out, $f.Count, $rate, ($f.Count / $rate))
    }
}
