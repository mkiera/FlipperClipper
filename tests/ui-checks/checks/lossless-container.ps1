# A trimmed WMV offers lossless only as MKV, and that export works. An MP4 still offers it as MP4.
$ErrorActionPreference = 'Stop'
Import-Module $env:FC_UI_MODULE

Invoke-FcCheck 'lossless-container' {
    Initialize-FcProfile | Out-Null
    $wmv = Get-FcMedia 'clip.wmv'
    $mp4 = Get-FcMedia 'clip.mp4'
    $work = Get-FcWorkDir

    Start-Fc -File $wmv | Out-Null
    Get-FcTree -Name 'tree-wmv' | Out-Null
    $label = Set-FcTrimEnd -Seconds 3
    Save-FcScreenshot -Name 'wmv-trimmed' | Out-Null

    $format = Find-FcElement -Id 'format-select' -Name 'Export format' -ControlType ComboBox
    Assert-Fc ((Get-FcValue $format) -eq 'MP4') "a WMV starts on '$(Get-FcValue $format)'"
    $route = Start-FcExport
    Assert-Fc ($route -eq 'dialog') "WMV to MP4 skips the lossless choice and goes straight to the save dialog (got '$route')"
    Complete-FcSaveDialog -Path (Join-Path $work 'unused.mp4') -Cancel -ShotName 'wmv-mp4-save-dialog'

    Select-FcOption -Combo $format -Option 'MKV' -TypeKeys 'mk'
    Save-FcScreenshot -Name 'wmv-mkv-selected' | Out-Null
    $route = Start-FcExport
    Assert-Fc ($route -eq 'popover') "WMV to MKV offers the lossless choice (got '$route')"
    Confirm-FcPopoverExport -Lossless $true
    $out = Join-Path $work 'wmv-lossless.mkv'
    Complete-FcSaveDialog -Path $out -ShotName 'wmv-mkv-save-dialog'
    Wait-FcExported -FileName 'wmv-lossless.mkv' | Out-Null
    Save-FcScreenshot -Name 'wmv-mkv-exported' | Out-Null

    $probe = Get-FcProbe $out
    Write-FcLog "wmv-lossless.mkv: $($probe | ConvertTo-Json -Compress)"
    Assert-Fc ($probe.Format -like '*matroska*') "the export is Matroska ($($probe.Format))"
    Assert-Fc ($probe.Video -eq 'wmv2' -and $probe.Audio -eq 'wmav2') "the streams were copied, not re-encoded (video $($probe.Video), audio $($probe.Audio))"
    Assert-Fc ($probe.Duration -gt 2 -and $probe.Duration -lt 5.5) "the export is trimmed ($($probe.Duration) s of a 6 s clip, label '$label')"
    Assert-Fc (Test-FcDecodes $out) 'the export decodes without errors'
    Close-Fc | Out-Null

    Start-Fc -File $mp4 | Out-Null
    $label = Set-FcTrimEnd -Seconds 3
    $format = Find-FcElement -Id 'format-select' -Name 'Export format' -ControlType ComboBox
    Assert-Fc ((Get-FcValue $format) -eq 'MP4') "an MP4 starts on '$(Get-FcValue $format)'"
    $route = Start-FcExport
    Assert-Fc ($route -eq 'popover') "MP4 to MP4 still offers the lossless choice (got '$route')"
    Confirm-FcPopoverExport -Lossless $true
    $out = Join-Path $work 'mp4-lossless.mp4'
    Complete-FcSaveDialog -Path $out -ShotName 'mp4-save-dialog'
    Wait-FcExported -FileName 'mp4-lossless.mp4' | Out-Null
    Save-FcScreenshot -Name 'mp4-exported' | Out-Null
    $probe = Get-FcProbe $out
    Write-FcLog "mp4-lossless.mp4: $($probe | ConvertTo-Json -Compress)"
    Assert-Fc ($probe.Video -eq 'h264' -and $probe.Audio -eq 'aac') "the MP4 export copied h264 and aac (video $($probe.Video), audio $($probe.Audio))"
    Assert-Fc ($probe.Duration -gt 2 -and $probe.Duration -lt 5.5) "the MP4 export is trimmed ($($probe.Duration) s, label '$label')"
    Close-Fc | Out-Null
}
