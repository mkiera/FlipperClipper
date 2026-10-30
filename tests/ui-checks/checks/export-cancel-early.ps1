# Cancel pressed the moment an export over an existing file starts leaves that file alone,
# and the next export runs normally. The long clip makes sure the cancel lands before the
# export could have finished on its own.
$ErrorActionPreference = 'Stop'
Import-Module $env:FC_UI_MODULE

Invoke-FcCheck 'export-cancel-early' {
    Initialize-FcProfile | Out-Null
    $clip = Get-FcMedia 'long.mp4'
    $work = Get-FcWorkDir
    $dest = Join-Path $work 'existing.mp4'
    Copy-Item (Join-Path $env:FC_UI_MEDIA 'other.mp4') $dest
    $before = Get-FcHash $dest
    $beforeTime = (Get-Item $dest).LastWriteTimeUtc

    Start-Fc -File $clip | Out-Null
    $route = Start-FcExport
    if ($route -eq 'popover') { Confirm-FcPopoverExport -Lossless $false }
    Complete-FcSaveDialog -Path $dest -ShotName 'save-over-existing'

    # The Cancel button replaces Export as soon as the export starts.
    $cancel = Wait-Fc -TimeoutSeconds 10 -PollMs 20 -What 'the Cancel export button' {
        Find-FcElement -Id 'export-cancel' -Name 'Cancel export' -ControlType Button -TimeoutSeconds 0 -Optional
    }
    (Get-FcPattern $cancel ([System.Windows.Automation.InvokePattern]::Pattern)).Invoke()
    $spawned = (Get-FcFfmpegProcesses).Count
    $temps = (Get-FcExportTemps $work).Count
    Write-FcLog "cancel pressed; ffmpeg processes then: $spawned, temp export files then: $temps"
    Save-FcScreenshot -Name 'after-cancel' | Out-Null

    $deadline = (Get-Date).AddSeconds(15)
    $toast = $null
    while ((Get-Date) -lt $deadline -and -not $toast) {
        $toast = Find-FcText -Like 'Exported*'
        Start-Sleep -Milliseconds 250
    }
    Save-FcScreenshot -Name 'fifteen-seconds-later' | Out-Null
    Assert-Fc (-not $toast) "no 'Exported' toast appeared after the cancel ($toast)"
    Assert-Fc ((Get-FcHash $dest) -eq $before -and (Get-Item $dest).LastWriteTimeUtc -eq $beforeTime) 'the existing file is unchanged'
    $left = Get-FcFfmpegProcesses
    Assert-Fc ($left.Count -eq 0) "no ffmpeg.exe is left running ($($left.Count))"
    $temps = Get-FcExportTemps $work
    Assert-Fc ($temps.Count -eq 0) "no .flipperclipper-export-* file is left ($($temps.Name -join ', '))"
    $export = Find-FcElement -Id 'export-btn' -Name 'Export' -ControlType Button
    Assert-Fc ($export.Current.IsEnabled) 'the Export button is back and enabled'

    # Three seconds of the clip, so the next export finishes quickly.
    Set-FcTrimEnd -Seconds 3 | Out-Null
    $next = Join-Path $work 'after-cancel.mp4'
    $route = Start-FcExport
    if ($route -eq 'popover') { Confirm-FcPopoverExport -Lossless $false }
    Complete-FcSaveDialog -Path $next -ShotName 'next-export'
    Wait-FcExported -FileName 'after-cancel.mp4' | Out-Null
    Save-FcScreenshot -Name 'next-export-done' | Out-Null
    $probe = Get-FcProbe $next
    Write-FcLog "after-cancel.mp4: $($probe | ConvertTo-Json -Compress)"
    Assert-Fc ($probe.Video -eq 'h264' -and $probe.Duration -gt 2.5 -and $probe.Duration -lt 4) "the next export finished as a 3 s h264 clip ($($probe.Video), $($probe.Duration) s)"
    Assert-Fc ((Get-FcHash $dest) -eq $before) 'the existing file is still unchanged'
    Close-Fc | Out-Null
}
