# The default output size chosen in Settings survives a restart, and the save leaves no temp file.
$ErrorActionPreference = 'Stop'
Import-Module $env:FC_UI_MODULE

Invoke-FcCheck 'settings-output-size' {
    $p = Initialize-FcProfile
    $clip = Get-FcMedia 'clip.mp4'

    Start-Fc | Out-Null
    Get-FcTree -Name 'tree-start' | Out-Null
    Invoke-FcElement (Find-FcElement -Id 'settings-btn' -Name 'Settings' -ControlType Button)
    Invoke-FcElement (Find-FcElement -Id 'settings-tab-editing' -Name 'Editing' -ControlType Button)
    $res = Find-FcElement -Id 'set-res' -Name 'Default output resolution' -ControlType ComboBox
    Get-FcTree -Name 'tree-settings' | Out-Null
    Select-FcOption -Combo $res -Option '720p' -TypeKeys '7'
    Start-Sleep -Seconds 1
    Save-FcScreenshot -Name 'settings-720' | Out-Null
    Invoke-FcElement (Find-FcElement -Id 'settings-close' -Name 'Close settings' -ControlType Button)
    Close-Fc | Out-Null

    $saved = Get-Content -Raw $p.Settings | ConvertFrom-Json
    Write-FcLog "settings.json: $(Get-Content -Raw $p.Settings)"
    Assert-Fc ($saved.defaultOutputHeight -eq 720) "settings.json holds defaultOutputHeight 720 (it holds '$($saved.defaultOutputHeight)')"
    $files = @(Get-ChildItem -Force -LiteralPath $p.Config -File | ForEach-Object Name)
    Write-FcLog "files beside settings.json: $($files -join ', ')"
    # The save writes a NamedTempFile (".tmpXXXXXX") beside settings.json and renames it over.
    $temps = @($files | Where-Object { $_ -like '.tmp*' -or $_ -like '*.tmp' -or $_ -like 'settings.json?*' })
    Assert-Fc ($temps.Count -eq 0) "no temp file is left beside settings.json (folder holds: $($files -join ', '))"

    Start-Fc | Out-Null
    Invoke-FcElement (Find-FcElement -Id 'settings-btn' -Name 'Settings' -ControlType Button)
    Invoke-FcElement (Find-FcElement -Id 'settings-tab-editing' -Name 'Editing' -ControlType Button)
    $res = Find-FcElement -Id 'set-res' -Name 'Default output resolution' -ControlType ComboBox
    $shown = Get-FcValue $res
    Save-FcScreenshot -Name 'settings-after-restart' | Out-Null
    Assert-Fc ($shown -eq '720p') "after a restart Settings shows '$shown' as the default output resolution"
    Invoke-FcElement (Find-FcElement -Id 'settings-close' -Name 'Close settings' -ControlType Button)
    Close-Fc | Out-Null

    # A 720p clip opened after the restart starts on the saved size.
    Start-Fc -File $clip | Out-Null
    $main = Find-FcElement -Id 'res-select' -Name 'Output resolution' -ControlType ComboBox
    $shown = Get-FcValue $main
    Save-FcScreenshot -Name 'clip-after-restart' | Out-Null
    Assert-Fc ($shown -eq '720p') "a clip opened after the restart starts on '$shown'"
    Close-Fc | Out-Null
}
