# Several files on one timeline: add them, split one, drag a clip to the front, remove one, play
# across the cuts, export the joined video, then undo a removal and remove with Delete.
$ErrorActionPreference = 'Stop'
Import-Module $env:FC_UI_MODULE

$AE = [System.Windows.Automation.AutomationElement]
$Descendants = [System.Windows.Automation.TreeScope]::Descendants

function New-Replay([string]$Path, [int]$Seconds, [string]$Size, [int]$Rate, [int]$Tracks) {
    # Shaped like a game replay: 1080p60 with several audio tracks, each a different tone.
    $inputs = @('-f', 'lavfi', '-i', "testsrc2=size=$($Size):rate=$($Rate):duration=$Seconds")
    $maps = @('-map', '0:v:0')
    for ($i = 0; $i -lt $Tracks; $i++) {
        $inputs += @('-f', 'lavfi', '-i', "sine=frequency=$(220 + 110 * $i):sample_rate=48000:duration=$Seconds")
        $maps += @('-map', "$($i + 1):a:0")
    }
    & ffmpeg -hide_banner -loglevel error -y @inputs @maps -c:v libx264 -preset ultrafast -pix_fmt yuv420p -g $Rate -c:a aac -ac 2 -shortest $Path
    if ($LASTEXITCODE -ne 0) { throw "ffmpeg could not make $Path" }
}

function Complete-FcOpenDialog([string]$Folder, [string[]]$Names) {
    $dlg = Get-FcDialog -Title 'Add clips'
    Start-Sleep -Milliseconds 700
    Save-FcScreenshot -Name 'add-dialog' -Element $dlg | Out-Null
    $h = [IntPtr]$dlg.Current.NativeWindowHandle
    $edit = [FcWin32]::FileNameEdit($h)
    if ($edit -eq [IntPtr]::Zero) { throw 'the Add clips dialog has no File name box' }
    # A folder in the box and Open moves the dialog there; quoted names then pick several files.
    [FcWin32]::SetText($edit, $Folder)
    [FcWin32]::ClickButton($h, 1) | Out-Null
    Start-Sleep -Milliseconds 1200
    $edit = [FcWin32]::FileNameEdit($h)
    $list = ($Names | ForEach-Object { "`"$_`"" }) -join ' '
    [FcWin32]::SetText($edit, $list)
    Start-Sleep -Milliseconds 200
    Write-FcLog "file name box holds '$([FcWin32]::GetText($edit))'"
    [FcWin32]::ClickButton($h, 1) | Out-Null
    Wait-Fc -TimeoutSeconds 15 -What 'the Add clips dialog to close' { -not (Get-FcWindow -Title 'Add clips' -TimeoutSeconds 0 -Optional) }
}

function Get-ClipNames {
    # The lane's remove buttons, in timeline order: "Remove clip 2, r1.mp4" -> "r1.mp4".
    $win = Get-FcWindow
    $c = New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)
    @($win.FindAll($Descendants, $c) | ForEach-Object { $_.Current.Name } | Where-Object { $_ -like 'Remove clip *' } |
        Sort-Object { [int](($_ -split ' ')[2].TrimEnd(',')) } | ForEach-Object { ($_ -split ', ', 2)[1] })
}

function Get-OutputLength { ((Get-FcTimeLabel) -split ' / ')[1] }

function Move-Mouse([int]$X, [int]$Y) { [FcWin32]::SetCursorPos($X, $Y) | Out-Null; Start-Sleep -Milliseconds 30 }

function Invoke-Drag([int]$FromX, [int]$Y, [int]$ToX) {
    Set-FcForeground
    Move-Mouse $FromX $Y
    [FcWin32]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
    $steps = 20
    for ($i = 1; $i -le $steps; $i++) { Move-Mouse ([int]($FromX + ($ToX - $FromX) * $i / $steps)) $Y }
    Start-Sleep -Milliseconds 200
    Save-FcScreenshot -Name 'dragging' | Out-Null
    [FcWin32]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 500
}

Invoke-FcCheck 'splice-clips' {
    Initialize-FcProfile | Out-Null
    $work = Get-FcWorkDir
    New-Replay (Join-Path $work 'r1.mp4') 8 '1920x1080' 60 6
    New-Replay (Join-Path $work 'r2.mp4') 6 '1920x1080' 60 6
    New-Replay (Join-Path $work 'r3.mp4') 5 '1280x720' 30 1
    New-Replay (Join-Path $work 'r4.mp4') 7 '1920x1080' 60 6

    Start-Fc -File (Join-Path $work 'r1.mp4') | Out-Null
    Assert-Fc ((Get-ClipNames).Count -eq 0) 'one file shows no clip lane'
    Save-FcScreenshot -Name 'one-file' | Out-Null

    Invoke-FcElement (Find-FcElement -Id 'tl-add-clip' -Name 'Add clips' -ControlType Button)
    Complete-FcOpenDialog -Folder $work -Names @('r4.mp4', 'r2.mp4', 'r3.mp4')
    Wait-Fc -TimeoutSeconds 20 -What 'four clips in the lane' { (Get-ClipNames).Count -eq 4 }
    $names = (Get-ClipNames) -join ','
    Assert-Fc ($names -eq 'r1.mp4,r2.mp4,r3.mp4,r4.mp4') "added clips follow the first in name order ($names)"
    Assert-Fc ((Get-OutputLength) -eq '0:26.0') "the timeline is 26 s long ($(Get-FcTimeLabel))"
    Start-Sleep -Seconds 3
    Save-FcScreenshot -Name 'four-clips' | Out-Null

    # Split r1 at 3 s.
    $play = Find-FcElement -Id 'play-btn' -Name 'Play' -ControlType Button
    Set-FcForeground
    $play.SetFocus()
    Send-FcKeys '{HOME}'
    for ($i = 0; $i -lt 3; $i++) { Send-FcKeys '+{RIGHT}' }
    Send-FcKeys 'x'
    Wait-Fc -TimeoutSeconds 5 -What 'the split' { (Get-ClipNames).Count -eq 5 }
    $names = (Get-ClipNames) -join ','
    Assert-Fc ($names -eq 'r1.mp4,r1.mp4,r2.mp4,r3.mp4,r4.mp4') "X split r1 in two ($names)"
    Assert-Fc ((Get-OutputLength) -eq '0:26.0') 'a split keeps the length'
    Save-FcScreenshot -Name 'split' | Out-Null

    # Drag r3 by its label to the start of the lane.
    $cross = (Find-FcElement -Name 'Remove clip 4, r3.mp4' -ControlType Button).Current.BoundingRectangle
    $lane = (Find-FcElement -Id 'tl-clips').Current.BoundingRectangle
    $y = [int]($cross.Top + $cross.Height / 2)
    Invoke-Drag ([int]($cross.Left - 30)) $y ([int]($lane.Left + 4))
    Wait-Fc -TimeoutSeconds 5 -What 'r3 to move first' { ((Get-ClipNames) -join ',') -eq 'r3.mp4,r1.mp4,r1.mp4,r2.mp4,r4.mp4' }
    Save-FcScreenshot -Name 'reordered' | Out-Null

    # Remove the second piece of r1 with its cross.
    Invoke-FcElement (Find-FcElement -Name 'Remove clip 3, r1.mp4' -ControlType Button)
    Wait-Fc -TimeoutSeconds 5 -What 'the removal' { ((Get-ClipNames) -join ',') -eq 'r3.mp4,r1.mp4,r2.mp4,r4.mp4' }
    Assert-Fc ((Get-OutputLength) -eq '0:21.0') "removing the 5 s piece leaves 21 s ($(Get-FcTimeLabel))"
    Save-FcScreenshot -Name 'removed' | Out-Null

    # Play from the start across two cuts: r3 to r1 at 5 s, r1 to r2 at 8 s.
    Set-FcForeground
    $play.SetFocus()
    Send-FcKeys '{HOME}'
    Invoke-FcElement $play
    Start-Sleep -Seconds 6
    Save-FcScreenshot -Name 'playing-r1' | Out-Null
    Start-Sleep -Seconds 4
    Save-FcScreenshot -Name 'playing-r2' | Out-Null
    $label = Get-FcTimeLabel
    Invoke-FcElement (Find-FcElement -Id 'play-btn' -ControlType Button)
    $now = ($label -split ' / ')[0]
    $seconds = [double](($now -split ':')[1]) + 60 * [int](($now -split ':')[0])
    Assert-Fc ($seconds -gt 8.5) "playback ran on through both cuts ($label)"

    # Export the joined video.
    $route = Start-FcExport
    Assert-Fc ($route -eq 'dialog') "a timeline of clips goes straight to the save dialog (got '$route')"
    $out = Join-Path $work 'joined.mp4'
    Complete-FcSaveDialog -Path $out -ShotName 'joined-save-dialog'
    Wait-FcExported -FileName 'joined.mp4' -TimeoutSeconds 300 | Out-Null
    Save-FcScreenshot -Name 'exported' | Out-Null
    $probe = Get-FcProbe $out
    Write-FcLog "joined.mp4: $($probe | ConvertTo-Json -Compress)"
    Assert-Fc ([math]::Abs($probe.Duration - 21) -lt 0.3) "the export is 21 s ($($probe.Duration))"
    Assert-Fc ($probe.Video -eq 'h264' -and $probe.Audio -eq 'aac') "picture and sound (video $($probe.Video), audio $($probe.Audio))"
    $size = (& ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0 $out) -join ''
    Assert-Fc ($size -eq '1920,1080') "every clip is fitted into the first clip's frame ($size)"
    Assert-Fc (Test-FcDecodes $out) 'the export decodes without errors'

    # Undo puts the removed piece back, and Delete removes the clip under the playhead.
    Set-FcForeground
    $play.SetFocus()
    Send-FcKeys '^z'
    Wait-Fc -TimeoutSeconds 5 -What 'undo to restore the removed clip' { (Get-ClipNames).Count -eq 5 }
    Assert-Fc ((Get-OutputLength) -eq '0:26.0') 'undo restores the length'
    Send-FcKeys '{HOME}'
    Send-FcKeys '{DELETE}'
    Wait-Fc -TimeoutSeconds 5 -What 'Delete to remove the first clip' { ((Get-ClipNames) -join ',') -eq 'r1.mp4,r1.mp4,r2.mp4,r4.mp4' }
    Save-FcScreenshot -Name 'after-delete' | Out-Null
    Close-Fc | Out-Null
}
