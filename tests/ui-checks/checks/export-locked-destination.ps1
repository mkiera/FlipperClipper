# An export that cannot replace a locked destination keeps both files and names the kept one.
$ErrorActionPreference = 'Stop'
Import-Module $env:FC_UI_MODULE

Invoke-FcCheck 'export-locked-destination' {
    Initialize-FcProfile | Out-Null
    $clip = Get-FcMedia 'clip.mp4'
    $work = Get-FcWorkDir
    $dest = Join-Path $work 'locked.mp4'
    Copy-Item (Join-Path $env:FC_UI_MEDIA 'other.mp4') $dest
    $before = Get-FcHash $dest

    Start-Fc -File $clip | Out-Null

    # FileShare None: the app cannot even open the destination to check it, so it refuses before
    # encoding anything. Nothing may be lost or left behind.
    $lock = [IO.File]::Open($dest, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::None)
    try {
        Write-FcLog "locked $dest with FileShare None"
        $route = Start-FcExport
        if ($route -eq 'popover') { Confirm-FcPopoverExport -Lossless $false }
        Complete-FcSaveDialog -Path $dest -ShotName 'save-over-share-none'
        $message = Wait-Fc -TimeoutSeconds 120 -PollMs 250 -What 'the export to report a problem' {
            $done = Find-FcText -Like 'Exported*'
            if ($done) { throw "the export reported success over a locked file: $done" }
            Find-FcText -Like '*could not*'
        }
        Write-FcLog "message (FileShare None): $message"
        Save-FcScreenshot -Name 'share-none-message' | Out-Null
    } finally {
        $lock.Dispose()
    }
    Assert-Fc ((Get-FcHash $dest) -eq $before) 'with FileShare None the existing file is unchanged'
    Start-Sleep -Seconds 1
    $temps = @(Get-FcExportTemps $work)
    Assert-Fc ($temps.Count -eq 0) "with FileShare None no .flipperclipper-export-* file is left ($($temps.Name -join ', '))"
    Invoke-FcElement (Find-FcElement -Id 'toast-close' -Name 'Dismiss' -ControlType Button)

    # FileShare Read: the app can open the destination to check it, but cannot replace it.
    # This is the case the fix is about: the finished encode must be kept, not deleted.
    $lock = [IO.File]::Open($dest, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    try {
        Write-FcLog "locked $dest with FileShare Read"
        $route = Start-FcExport
        if ($route -eq 'popover') { Confirm-FcPopoverExport -Lossless $false }
        Complete-FcSaveDialog -Path $dest -ShotName 'save-over-locked'
        $message = Wait-Fc -TimeoutSeconds 120 -PollMs 250 -What 'the export to report it could not replace the file' {
            $done = Find-FcText -Like 'Exported*'
            if ($done) { throw "the export reported success over a locked file: $done" }
            Find-FcText -Like '*could not*'
        }
        Write-FcLog "message (FileShare Read): $message"
        Save-FcScreenshot -Name 'locked-message' | Out-Null
    } finally {
        $lock.Dispose()
    }

    Assert-Fc ($message -like '*existing file*left as it was*') 'the message says the existing file was left as it was'
    $m = [regex]::Match($message, '\.flipperclipper-export-[^\s\\/]+?\.mp4')
    Assert-Fc $m.Success 'the message names the kept .flipperclipper-export-* file'
    $kept = Join-Path $work $m.Value
    Assert-Fc (Test-Path -LiteralPath $kept) "the kept file $($m.Value) exists in the export folder"
    $probe = Get-FcProbe $kept
    Write-FcLog "$($m.Value): $($probe | ConvertTo-Json -Compress)"
    Assert-Fc ($probe.Video -eq 'h264' -and $probe.Duration -gt 5) "the kept file is a full h264 clip ($($probe.Video), $($probe.Duration) s)"
    Assert-Fc (Test-FcDecodes $kept) 'the kept file decodes without errors'
    Assert-Fc ((Get-FcHash $dest) -eq $before) 'the locked file is unchanged'
    $all = @(Get-FcExportTemps $work)
    Assert-Fc ($all.Count -eq 1) "exactly the one kept export file is in the folder ($($all.Name -join ', '))"
    Close-Fc | Out-Null
}
