# The Distortion effect: switch it on, fit the lens circle, aim by dragging, set the rise and
# the size, and export a flat clip of that size. FC_UI_FISHEYE_CLIP runs it on a real fisheye.
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

Invoke-FcCheck 'distortion' {
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
    Invoke-FcElement (Find-FcElement -Id 'effects-btn' -Name 'Effects' -ControlType Button)
    Switch-FcElement (Find-FcElement -Name 'Distortion' -ControlType CheckBox)
    Start-Sleep -Milliseconds 500
    Get-FcTree -Name 'tree-distortion' | Out-Null
    Save-FcScreenshot -Name 'distortion-on' | Out-Null
    $crop = Find-FcElement -Id 'crop-btn' -ControlType Button
    Assert-Fc (-not $crop.Current.IsEnabled) 'Crop is off while Distortion is on'

    Switch-FcElement (Find-FcElement -Name 'Fit lens circle' -ControlType Button)
    Save-FcScreenshot -Name 'fit-circle' | Out-Null
    Switch-FcElement (Find-FcElement -Name 'Fit lens circle' -ControlType Button)

    # The picture sits left of the effects panel: aim from a point in it.
    $before = Save-FcScreenshot -Name 'before-aim'
    $win = (Get-FcWindow).Current.BoundingRectangle
    $cx = [int]($win.X + $win.Width * 0.3)
    $cy = [int]($win.Y + $win.Height * 0.3)
    Set-FcForeground
    Invoke-FcDrag -X $cx -Y $cy -DX 0 -DY -200
    $after = Save-FcScreenshot -Name 'aimed'
    Assert-Fc ((Get-FcHash $before) -ne (Get-FcHash $after)) 'dragging the picture moves the view'

    $rise = Find-FcElement -Name 'Rise' -ControlType Slider
    (Get-FcPattern $rise ([System.Windows.Automation.RangeValuePattern]::Pattern)).SetValue(0.3)
    Wait-Fc -TimeoutSeconds 5 -What 'the Rise slider to read +30%' { Find-FcText -Like '+30%' } | Out-Null
    Save-FcScreenshot -Name 'risen' | Out-Null

    Select-FcOption -Combo (Find-FcElement -Name 'Output size' -ControlType ComboBox) -Option '720p' -TypeKeys '7'
    Save-FcScreenshot -Name 'sized' | Out-Null

    $route = Start-FcExport
    Assert-Fc ($route -eq 'dialog') "a distorted clip goes straight to the save dialog (got '$route')"
    $out = Join-Path $work 'flat.mp4'
    Complete-FcSaveDialog -Path $out -ShotName 'save-dialog'
    Wait-FcExported -FileName 'flat.mp4' -TimeoutSeconds 300 | Out-Null
    Save-FcScreenshot -Name 'exported' | Out-Null

    $dims = (& ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0 $out) -join ''
    Write-FcLog "flat.mp4 is $dims"
    Assert-Fc ($dims -eq '1280,720') "the export is 720p at 16:9 ($dims)"
    Assert-Fc (Test-FcDecodes $out) 'the export decodes without errors'
    & ffmpeg -hide_banner -loglevel error -y -ss 1 -i $out -frames:v 1 (Join-Path (Get-FcOutDir) 'export-frame.png')
    Close-Fc | Out-Null
}
