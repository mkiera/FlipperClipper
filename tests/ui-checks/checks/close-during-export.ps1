# Closing the window mid-export stops FFmpeg and removes the part-written file and the
# text overlay's temp folder before the app exits.
$ErrorActionPreference = 'Stop'
Import-Module $env:FC_UI_MODULE

Invoke-FcCheck 'close-during-export' {
    Initialize-FcProfile | Out-Null
    $clip = Get-FcMedia 'long.mp4'
    $work = Get-FcWorkDir
    $tempRoot = [IO.Path]::GetTempPath()
    $overlayDirs = { @(Get-ChildItem -Force -LiteralPath $tempRoot -Directory -Filter 'flipperclipper-overlay-*' -ErrorAction SilentlyContinue) }

    Start-Fc -File $clip | Out-Null
    Invoke-FcElement (Find-FcElement -Id 'effects-btn' -Name 'Effects' -ControlType Button)
    $text = Find-FcElement -Name 'Text overlay' -ControlType CheckBox
    Switch-FcElement $text
    Assert-Fc ((Get-FcToggleState $text) -eq 'On') 'the text overlay is switched on'
    Get-FcTree -Name 'tree-effects' | Out-Null
    Save-FcScreenshot -Name 'text-overlay-on' | Out-Null

    $out = Join-Path $work 'long-export.mp4'
    $route = Start-FcExport
    if ($route -eq 'popover') { Confirm-FcPopoverExport -Lossless $false }
    Complete-FcSaveDialog -Path $out -ShotName 'save-long-export'

    # Proof the export is really under way: FFmpeg is writing the temp file and the overlay folder exists.
    Wait-Fc -TimeoutSeconds 60 -What 'FFmpeg to start writing the export' {
        $t = Get-FcExportTemps $work | Where-Object Length -gt 0
        $t -and (Get-FcFfmpegProcesses).Count -gt 0
    } | Out-Null
    Start-Sleep -Seconds 3
    $temps = Get-FcExportTemps $work
    $dirs = & $overlayDirs
    $pct = Get-FcTexts | Where-Object { $_ -match '^\d+%$' } | Select-Object -First 1
    Write-FcLog "mid-export: progress $pct, temp files $($temps.Name -join ', ') ($($temps.Length -join ', ') bytes), overlay dirs $($dirs.Name -join ', '), ffmpeg $((Get-FcFfmpegProcesses).Count)"
    Save-FcScreenshot -Name 'exporting' | Out-Null
    Assert-Fc ($temps.Count -eq 1) 'a part-written export file exists before the close'
    Assert-Fc ($dirs.Count -ge 1) 'the overlay temp folder exists before the close'
    Assert-Fc (-not (Find-FcText -Like 'Exported*')) 'the export is still running when the window is closed'
    $ffmpegIds = @(Get-FcFfmpegProcesses | ForEach-Object Id)

    $seconds = Close-Fc -TimeoutSeconds 20
    Assert-Fc ($seconds -lt 8) ("the app exited {0:N1} s after the window was closed" -f $seconds)
    Start-Sleep -Milliseconds 500
    $left = @(Get-FcFfmpegProcesses)
    Write-FcLog "ffmpeg pids during the export: $($ffmpegIds -join ', ')"
    Assert-Fc ($left.Count -eq 0) "no ffmpeg.exe is left running ($($left.Id -join ', '))"
    $temps = Get-FcExportTemps $work
    Assert-Fc ($temps.Count -eq 0) "no .flipperclipper-export-* file is left ($($temps.Name -join ', '))"
    Assert-Fc (-not (Test-Path $out)) 'no half-finished export took the destination name'
    $dirs = & $overlayDirs
    Assert-Fc ($dirs.Count -eq 0) "no flipperclipper-overlay-* folder is left in %TEMP% ($($dirs.Name -join ', '))"
}
