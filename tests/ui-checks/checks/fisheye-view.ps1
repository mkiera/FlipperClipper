# The fisheye view: fit the circle, aim and zoom by dragging and typing, and export a flat clip
# of the size the bar shows. FC_UI_FISHEYE_CLIP runs it on a real fisheye clip instead.
$ErrorActionPreference = 'Stop'
Import-Module $env:FC_UI_MODULE

function Invoke-FcDrag([int]$X, [int]$Y, [int]$DX, [int]$DY) {
    Write-FcLog "drag from ($X, $Y) by ($DX, $DY)"
    [FcWin32]::SetCursorPos($X, $Y) | Out-Null
    Start-Sleep -Milliseconds 150
    [FcWin32]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
    for ($i = 1; $i -le 10; $i++) {
        [FcWin32]::SetCursorPos($X + [int]($DX * $i / 10), $Y + [int]($DY * $i / 10)) | Out-Null
        Start-Sleep -Milliseconds 40
    }
    [FcWin32]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 400
}

Invoke-FcCheck 'fisheye-view' {
    Initialize-FcProfile | Out-Null
    $work = Get-FcWorkDir
    $clip = $env:FC_UI_FISHEYE_CLIP
    if (-not $clip) {
        # A 180 degree fisheye of a test pattern, centred in a 16:9 frame: the circle the app
        # starts with is exactly this one.
        $clip = Join-Path $work 'fisheye.mp4'
        & ffmpeg -hide_banner -loglevel error -y -f lavfi -i 'testsrc2=size=2160x1080:rate=30' -t 4 `
            -vf 'v360=input=e:output=fisheye:h_fov=180:v_fov=180:w=1080:h=1080,pad=1920:1080:420:0' `
            -c:v libx264 -preset veryfast -pix_fmt yuv420p $clip
        Assert-Fc ($LASTEXITCODE -eq 0) 'ffmpeg made the fisheye clip'
    }

    Start-Fc -File $clip | Out-Null
    $crop = Find-FcElement -Id 'crop-btn' -ControlType Button
    Invoke-FcElement (Find-FcElement -Id 'lens-btn' -Name 'Fisheye' -ControlType Button)
    Find-FcElement -Id 'lens-done' -Name 'Done' -ControlType Button | Out-Null
    Get-FcTree -Name 'tree-lens' | Out-Null
    Save-FcScreenshot -Name 'lens-circle' | Out-Null

    Invoke-FcElement (Find-FcElement -Name 'View' -ControlType Button)
    Save-FcScreenshot -Name 'view-start' | Out-Null

    # The size label has no accessible id of its own: it is the only text that reads "W x H".
    $readSize = { Get-FcTexts | Where-Object { $_ -match '^\d+ x \d+$' } | Select-Object -First 1 }
    $before = & $readSize
    $fov = Find-FcElement -Id 'lens-view-fov' -ControlType Spinner
    # A long clip is still building its filmstrip here, which can take the focus back once.
    $sizeText = $null
    for ($try = 1; $try -le 3 -and -not $sizeText; $try++) {
        $fov.SetFocus()
        Send-FcKeys '^a50{TAB}'
        $sizeText = try { Wait-Fc -TimeoutSeconds 4 -What 'the size label to follow the new field' { $t = & $readSize; if ($t -and $t -ne $before) { $t } } } catch { $null }
    }
    Write-FcLog "output size label: $sizeText"
    Assert-Fc ($sizeText -match '^(\d+) x (\d+)$') "the bar shows the output size ('$sizeText')"
    $outW = [int]$Matches[1]
    $outH = [int]$Matches[2]
    Save-FcScreenshot -Name 'view-50' | Out-Null

    # The stage has no accessible element: aim from a point in the picture above the bar.
    $win = (Get-FcWindow).Current.BoundingRectangle
    $cx = [int]($win.X + $win.Width / 2)
    $cy = [int]($win.Y + $win.Height * 0.3)
    Set-FcForeground
    Invoke-FcDrag -X $cx -Y $cy -DX 0 -DY 160
    Save-FcScreenshot -Name 'view-aimed' | Out-Null

    Invoke-FcElement (Find-FcElement -Id 'lens-done' -Name 'Done' -ControlType Button)
    Start-Sleep -Milliseconds 500
    Save-FcScreenshot -Name 'lens-set' | Out-Null
    Assert-Fc (-not $crop.Current.IsEnabled) 'Crop is off while the fisheye view is on'

    $route = Start-FcExport
    Assert-Fc ($route -eq 'dialog') "a fisheye view goes straight to the save dialog (got '$route')"
    $out = Join-Path $work 'flat.mp4'
    Complete-FcSaveDialog -Path $out -ShotName 'save-dialog'
    Wait-FcExported -FileName 'flat.mp4' | Out-Null
    Save-FcScreenshot -Name 'exported' | Out-Null

    $dims = (& ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0 $out) -join ''
    Write-FcLog "flat.mp4 is $dims"
    Assert-Fc ($dims -eq "$outW,$outH") "the export is the size the bar showed ($dims, bar $outW x $outH)"
    Assert-Fc (Test-FcDecodes $out) 'the export decodes without errors'
    & ffmpeg -hide_banner -loglevel error -y -ss 1 -i $out -frames:v 1 (Join-Path (Get-FcOutDir) 'export-frame.png')
    Close-Fc | Out-Null
}
