Set-StrictMode -Version 3
$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Drawing, System.Windows.Forms

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class FcWin32 {
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern void mouse_event(uint flags, int dx, int dy, uint data, UIntPtr extra);
    [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
}
"@

$script:AE = [System.Windows.Automation.AutomationElement]
$script:Descendants = [System.Windows.Automation.TreeScope]::Descendants
$script:Children = [System.Windows.Automation.TreeScope]::Children
$script:Shot = 0
$script:AppName = 'flipperclipper'
$script:AppId = 'com.mkiera.flipperclipper'

function Get-FcOutDir {
    $dir = $env:FC_UI_OUT
    if (-not $dir) { $dir = Join-Path ([IO.Path]::GetTempPath()) 'fc-ui-out' }
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    return $dir
}

function Get-FcWorkDir {
    $dir = $env:FC_UI_WORK
    if (-not $dir) { $dir = Join-Path ([IO.Path]::GetTempPath()) 'fc-ui-work' }
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    return $dir
}

function Get-FcMedia {
    # Test clips the runner script generated once with ffmpeg, copied into this check's folder.
    param([Parameter(Mandatory)][string]$Name)
    $src = Join-Path $env:FC_UI_MEDIA $Name
    if (-not (Test-Path $src)) { throw "no test media '$Name' in $env:FC_UI_MEDIA" }
    $dst = Join-Path (Get-FcWorkDir) $Name
    Copy-Item $src $dst -Force
    return $dst
}

function Write-FcLog([string]$Message) { Write-Host "[$((Get-Date).ToString('HH:mm:ss.fff'))] $Message" }

function Remove-FcDir([string]$Path) {
    # WebView2 child processes hold the profile folder for a moment after the app exits.
    for ($i = 0; $i -lt 20 -and (Test-Path $Path); $i++) {
        try { Remove-Item -Recurse -Force $Path -ErrorAction Stop } catch { Start-Sleep -Milliseconds 500 }
    }
    if (Test-Path $Path) { throw "could not remove $Path" }
}

function Initialize-FcProfile {
    # Wipes the app's settings and WebView2 profile, so it refuses to run outside CI.
    param([hashtable]$Settings = @{}, [switch]$NoSettings)

    if ($env:GITHUB_ACTIONS -ne 'true' -and $env:FC_UI_ALLOW_LOCAL -ne '1') {
        throw 'Initialize-FcProfile wipes the app data folders. It runs only on CI, or with FC_UI_ALLOW_LOCAL=1 in a throwaway Windows session.'
    }
    Stop-FcAll
    $config = Join-Path $env:APPDATA $script:AppId
    $local = Join-Path $env:LOCALAPPDATA $script:AppId
    Remove-FcDir $config
    Remove-FcDir $local
    New-Item -ItemType Directory -Force -Path $config | Out-Null

    if (-not $NoSettings) {
        # The update check is off so a GitHub reply cannot put a pill or a banner on screen.
        $s = [ordered]@{ autoCheckUpdates = $false }
        foreach ($k in $Settings.Keys) { $s[$k] = $Settings[$k] }
        $s | ConvertTo-Json | Set-Content -Encoding utf8 (Join-Path $config 'settings.json')
    }
    [pscustomobject]@{ Config = $config; Local = $local; Settings = (Join-Path $config 'settings.json') }
}

function Get-FcProcess {
    Get-Process $script:AppName -ErrorAction SilentlyContinue | Where-Object { -not $_.HasExited } | Select-Object -First 1
}

function Get-FcFfmpegProcesses { @(Get-Process ffmpeg -ErrorAction SilentlyContinue) }

function Stop-FcAll {
    Get-Process $script:AppName -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    Get-Process ffmpeg, ffprobe -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    Get-Process msedgewebview2 -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 500
}

function Start-Fc {
    # Launches the app, with a clip to open when -File is given (the app opens a file argument).
    param([string]$File, [int]$TimeoutSeconds = 90)

    $exe = $env:FC_UI_APP
    if (-not $exe -or -not (Test-Path $exe)) { throw "FC_UI_APP does not point at the app: '$exe'" }
    $p = @{ FilePath = $exe; PassThru = $true }
    if ($File) { $p.ArgumentList = @("`"$File`"") }
    $proc = Start-Process @p
    Write-FcLog "started $exe pid $($proc.Id) $File"
    Get-FcWindow -TimeoutSeconds $TimeoutSeconds | Out-Null
    # The window appears before WebView2 has loaded the page.
    Find-FcElement -Name 'Settings' -ControlType Button -TimeoutSeconds $TimeoutSeconds | Out-Null
    if ($File) {
        Wait-Fc -TimeoutSeconds $TimeoutSeconds -What 'the clip to load and Export to enable' {
            $b = Find-FcElement -Id 'export-btn' -Name 'Export' -ControlType Button -TimeoutSeconds 1 -Optional
            $b -and $b.Current.IsEnabled
        }
    }
    Start-Sleep -Seconds 1
    return $proc
}

function Close-Fc {
    # Closes the window the way the title bar X does and returns the seconds until the process exited.
    param([int]$TimeoutSeconds = 20)
    $proc = Get-FcProcess
    if (-not $proc) { return 0 }
    $win = Get-FcWindow
    $start = Get-Date
    try {
        (Get-FcPattern $win ([System.Windows.Automation.WindowPattern]::Pattern)).Close()
    } catch {
        $proc.CloseMainWindow() | Out-Null
    }
    $exited = $proc.WaitForExit($TimeoutSeconds * 1000)
    $seconds = ((Get-Date) - $start).TotalSeconds
    if (-not $exited) {
        $proc.Kill()
        throw "the app did not exit within $TimeoutSeconds seconds of closing its window"
    }
    Write-FcLog ("app exited {0:N1} s after the window was closed" -f $seconds)
    return $seconds
}

function Get-FcWindow {
    # The main window, or a dialog of the app by title (owned dialogs can sit under the main window).
    param([string]$Title, [int]$TimeoutSeconds = 10, [switch]$Optional)

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
        $proc = Get-FcProcess
        if ($proc) {
            $cond = New-Object System.Windows.Automation.PropertyCondition($AE::ProcessIdProperty, $proc.Id)
            $tops = $AE::RootElement.FindAll($Children, $cond)
            if (-not $Title) {
                foreach ($t in $tops) { if ($t.Current.Name -eq 'FlipperClipper') { return $t } }
            } else {
                foreach ($t in $tops) { if ($t.Current.Name -eq $Title) { return $t } }
                $byTitle = New-Object System.Windows.Automation.AndCondition(
                    (New-Object System.Windows.Automation.PropertyCondition($AE::NameProperty, $Title)),
                    (New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, [System.Windows.Automation.ControlType]::Window)))
                foreach ($t in $tops) {
                    $w = $t.FindFirst($Descendants, $byTitle)
                    if ($w) { return $w }
                }
            }
        }
        Start-Sleep -Milliseconds 200
    } while ((Get-Date) -lt $deadline)

    if ($Optional) { return $null }
    if ($Title) { throw "no window titled '$Title'" }
    throw 'no FlipperClipper main window'
}

function Find-FcElement {
    # By HTML id (WebView2 exposes it as AutomationId) first, then by Name, within one window.
    param(
        [string]$Name,
        [string]$Id,
        [string]$ControlType,
        [string]$NameLike,
        [int]$Index = 0,
        [string]$Window,
        $Scope,
        [int]$TimeoutSeconds = 10,
        [switch]$Optional
    )

    $type = $null
    if ($ControlType) { $type = [System.Windows.Automation.ControlType]::$ControlType }
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
        $root = $Scope
        if (-not $root) { $root = Get-FcWindow -Title $Window -TimeoutSeconds 2 -Optional }
        if ($root) {
            $found = $null
            try {
                if ($Id) {
                    $c = New-Object System.Windows.Automation.PropertyCondition($AE::AutomationIdProperty, $Id)
                    $all = $root.FindAll($Descendants, $c)
                    if ($all.Count -gt $Index) { $found = $all.Item($Index) }
                }
                if (-not $found -and ($Name -or $NameLike -or $type)) {
                    $conds = @()
                    if ($Name) { $conds += New-Object System.Windows.Automation.PropertyCondition($AE::NameProperty, $Name) }
                    if ($type) { $conds += New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, $type) }
                    if ($conds.Count -eq 0) { $conds += [System.Windows.Automation.Condition]::TrueCondition }
                    $cond = if ($conds.Count -eq 1) { $conds[0] } else { New-Object System.Windows.Automation.AndCondition($conds) }
                    $all = @($root.FindAll($Descendants, $cond))
                    if ($NameLike) { $all = @($all | Where-Object { $_.Current.Name -like $NameLike }) }
                    if ($all.Count -gt $Index) { $found = $all[$Index] }
                }
            } catch [System.Windows.Automation.ElementNotAvailableException] { $found = $null }
            if ($found) { return $found }
        }
        if ($TimeoutSeconds -le 0) { break }
        Start-Sleep -Milliseconds 200
    } while ((Get-Date) -lt $deadline)

    if ($Optional) { return $null }
    throw "no element id='$Id' name='$Name' like='$NameLike' type='$ControlType' in '$(if ($Window) { $Window } else { 'main window' })'"
}

function Get-FcTexts {
    # Every Text element's Name in the main window, for reading toasts, labels and banners.
    param([string]$Window)
    $root = Get-FcWindow -Title $Window -TimeoutSeconds 2 -Optional
    if (-not $root) { return @() }
    $c = New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, [System.Windows.Automation.ControlType]::Text)
    try { return @($root.FindAll($Descendants, $c) | ForEach-Object { $_.Current.Name } | Where-Object { $_ }) }
    catch { return @() }
}

function Find-FcText {
    # The first visible text matching a wildcard, or $null.
    param([Parameter(Mandatory)][string]$Like)
    Get-FcTexts | Where-Object { $_ -like $Like } | Select-Object -First 1
}

function Get-FcPattern($Element, $Pattern) {
    $obj = $null
    if (-not $Element.TryGetCurrentPattern($Pattern, [ref]$obj)) {
        throw "element '$($Element.Current.Name)' does not support $($Pattern.ProgrammaticName)"
    }
    return $obj
}

function Invoke-FcElement {
    param([Parameter(ValueFromPipeline)]$Element)
    process {
        Write-FcLog "invoke '$($Element.Current.Name)' ($($Element.Current.AutomationId))"
        (Get-FcPattern $Element ([System.Windows.Automation.InvokePattern]::Pattern)).Invoke()
        Start-Sleep -Milliseconds 300
    }
}

function Switch-FcElement {
    param([Parameter(ValueFromPipeline)]$Element)
    process {
        Write-FcLog "toggle '$($Element.Current.Name)'"
        (Get-FcPattern $Element ([System.Windows.Automation.TogglePattern]::Pattern)).Toggle()
        Start-Sleep -Milliseconds 300
    }
}

function Get-FcToggleState($Element) {
    (Get-FcPattern $Element ([System.Windows.Automation.TogglePattern]::Pattern)).Current.ToggleState.ToString()
}

function Get-FcValue($Element) {
    $obj = $null
    if ($Element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$obj)) { return $obj.Current.Value }
    if ($Element.TryGetCurrentPattern([System.Windows.Automation.SelectionPattern]::Pattern, [ref]$obj)) {
        $sel = $obj.Current.GetSelection()
        if ($sel.Count -gt 0) { return $sel[0].Current.Name }
    }
    return $Element.Current.Name
}

function Set-FcText {
    param([Parameter(ValueFromPipeline)]$Element, [string]$Value)
    process { (Get-FcPattern $Element ([System.Windows.Automation.ValuePattern]::Pattern)).SetValue($Value); Start-Sleep -Milliseconds 200 }
}

function Set-FcForeground {
    param($Element)
    if (-not $Element) { $Element = Get-FcWindow }
    $h = [IntPtr]$Element.Current.NativeWindowHandle
    # A key press first lifts the foreground lock Windows puts on background processes.
    [FcWin32]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
    [FcWin32]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
    [FcWin32]::SetForegroundWindow($h) | Out-Null
    Start-Sleep -Milliseconds 300
}

function Send-FcKeys {
    # SendKeys syntax: '{RIGHT}', '+{RIGHT}', '^e'. Goes to whatever has focus in the app window.
    param([Parameter(Mandatory)][string]$Keys, $Window)
    Set-FcForeground $Window
    Write-FcLog "keys $Keys"
    [System.Windows.Forms.SendKeys]::SendWait($Keys)
    Start-Sleep -Milliseconds 300
}

function ConvertTo-FcSendKeys([string]$Text) {
    # SendKeys treats + ^ % ~ ( ) { } [ ] as commands; braces make them literal.
    -join ($Text.ToCharArray() | ForEach-Object { if ('+^%~(){}[]'.Contains($_)) { "{$_}" } else { "$_" } })
}

function Select-FcOption {
    # Picks an option of an HTML <select> by its text, then confirms the select shows it.
    param([Parameter(Mandatory)]$Combo, [Parameter(Mandatory)][string]$Option, [string]$TypeKeys)

    Write-FcLog "select '$Option' in '$($Combo.Current.Name)' ($($Combo.Current.AutomationId))"
    $done = $false
    try {
        $ec = $null
        if ($Combo.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$ec)) {
            $ec.Expand(); Start-Sleep -Milliseconds 500
        }
        $item = Find-FcElement -Scope $Combo -Name $Option -ControlType ListItem -TimeoutSeconds 3 -Optional
        if (-not $item) { $item = Find-FcElement -Name $Option -ControlType ListItem -TimeoutSeconds 2 -Optional }
        if ($item) {
            $sp = $null
            if ($item.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$sp)) { $sp.Select() }
            else { (Get-FcPattern $item ([System.Windows.Automation.InvokePattern]::Pattern)).Invoke() }
            Start-Sleep -Milliseconds 500
        }
        if ($ec) { try { $ec.Collapse() } catch { } ; Start-Sleep -Milliseconds 300 }
        $done = ((Get-FcValue $Combo) -eq $Option)
    } catch { Write-FcLog "selection pattern route failed: $_" }

    if (-not $done) {
        # Typing on a closed, focused select picks the first option starting with those letters.
        Write-FcLog 'falling back to the keyboard'
        $Combo.SetFocus()
        $keys = if ($TypeKeys) { $TypeKeys } else { $Option }
        Send-FcKeys $keys
        Start-Sleep -Milliseconds 500
        $done = ((Get-FcValue $Combo) -eq $Option)
    }
    if (-not $done) { throw "could not select '$Option'; the select shows '$(Get-FcValue $Combo)'" }
    Write-FcLog "select now shows '$(Get-FcValue $Combo)'"
}

function Invoke-FcDrag {
    # Drags with the real mouse from one screen point to another, in small steps.
    param([int]$FromX, [int]$FromY, [int]$ToX, [int]$ToY, [int]$Steps = 20)
    Set-FcForeground
    Write-FcLog "drag ($FromX,$FromY) -> ($ToX,$ToY)"
    [FcWin32]::SetCursorPos($FromX, $FromY) | Out-Null
    Start-Sleep -Milliseconds 200
    [FcWin32]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 150
    for ($i = 1; $i -le $Steps; $i++) {
        $x = [int]($FromX + ($ToX - $FromX) * $i / $Steps)
        $y = [int]($FromY + ($ToY - $FromY) * $i / $Steps)
        [FcWin32]::SetCursorPos($x, $y) | Out-Null
        [FcWin32]::mouse_event(0x0001, 0, 0, 0, [UIntPtr]::Zero)
        Start-Sleep -Milliseconds 30
    }
    Start-Sleep -Milliseconds 150
    [FcWin32]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 400
}

function Get-FcTimeLabel {
    # "0:00.0 / 0:06.0": the second half is the length of the export.
    Get-FcTexts | Where-Object { $_ -match '^\d+:\d\d\.\d / \d+:\d\d\.\d$' } | Select-Object -First 1
}

function Set-FcTrimEnd {
    # Drags the timeline's trim-end handle to a fraction of the clip, then returns the time label.
    param([double]$Fraction = 0.6)
    $before = Get-FcTimeLabel
    $handle = Find-FcElement -Id 'tl-out' -Name 'Trim end (O)' -TimeoutSeconds 5 -Optional
    $track = Find-FcElement -Id 'tl-track' -TimeoutSeconds 2 -Optional
    if (-not $track) { $track = Find-FcElement -Id 'tl-scroll' -TimeoutSeconds 2 -Optional }
    if ($handle) {
        $hr = $handle.Current.BoundingRectangle
        $fromX = [int]($hr.Left + $hr.Width / 2); $y = [int]($hr.Top + $hr.Height / 2)
        Write-FcLog "trim-end handle at $hr"
    } else {
        throw 'the trim-end handle is not exposed to UI Automation'
    }
    if ($track) {
        $tr = $track.Current.BoundingRectangle
        $toX = [int]($tr.Left + $tr.Width * $Fraction)
        Write-FcLog "track at $tr"
    } else {
        $win = (Get-FcWindow).Current.BoundingRectangle
        $toX = [int]($win.Left + ($fromX - $win.Left) * $Fraction)
    }
    $win = Get-FcWindow
    Invoke-FcDrag -FromX $fromX -FromY $y -ToX $toX -ToY $y
    $fg = [FcWin32]::GetForegroundWindow()
    Write-FcLog "foreground window $fg, app window $($win.Current.NativeWindowHandle)"
    $after = Get-FcTimeLabel
    Write-FcLog "time label after the drag '$before' -> '$after'"
    if ($before -ne $after) { return $after }

    Save-FcDesktopScreenshot -Name 'trim-drag-no-effect' | Out-Null
    # Keyboard route: Shift+Right steps one second, O sets the trim end at the playhead.
    $play = Find-FcElement -Id 'play-btn' -Name 'Play' -ControlType Button
    $play.SetFocus()
    Send-FcKeys '{HOME}'
    $seconds = [int][math]::Max(1, [math]::Round(6 * $Fraction))
    for ($i = 0; $i -lt $seconds; $i++) { Send-FcKeys '+{RIGHT}' }
    Send-FcKeys 'o'
    $after = Get-FcTimeLabel
    Write-FcLog "time label after the keyboard trim '$before' -> '$after'"
    if ($before -eq $after) { throw "neither dragging the trim-end handle nor Shift+Right then O changed the export length ('$after')" }
    return $after
}

function Complete-FcSaveDialog {
    # Drives the Windows "Export clip" save dialog: types the full path and presses Save,
    # answering Yes when Windows asks to replace an existing file.
    param([Parameter(Mandatory)][string]$Path, [switch]$Cancel, [string]$ShotName = 'save-dialog')

    $dlg = Get-FcWindow -Title 'Export clip' -TimeoutSeconds 20
    Start-Sleep -Milliseconds 700
    Save-FcScreenshot -Name $ShotName -Element $dlg | Out-Null
    if ($Cancel) {
        $btn = Find-FcElement -Scope $dlg -Id '2' -Name 'Cancel' -ControlType Button
        Invoke-FcElement $btn
        Wait-Fc -TimeoutSeconds 10 -What 'the save dialog to close' { -not (Get-FcWindow -Title 'Export clip' -TimeoutSeconds 0 -Optional) }
        return
    }
    $edit = Find-FcElement -Scope $dlg -Id '1001' -ControlType Edit -TimeoutSeconds 5 -Optional
    if (-not $edit) { $edit = Find-FcElement -Scope $dlg -Name 'File name:' -ControlType Edit }
    $vp = $null
    if ($edit.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$vp)) {
        $vp.SetValue($Path)
    } else {
        # The File name box in this dialog exposes no Value pattern, so type into it instead.
        $edit.SetFocus()
        Send-FcKeys '^a' -Window $dlg
        Send-FcKeys (ConvertTo-FcSendKeys $Path) -Window $dlg
    }
    Start-Sleep -Milliseconds 300
    Write-FcLog "file name box holds '$(try { $edit.Current.Name; (Get-FcValue $edit) } catch { '?' })'"
    $save = Find-FcElement -Scope $dlg -Id '1' -ControlType Button -TimeoutSeconds 5 -Optional
    if (-not $save) { $save = Find-FcElement -Scope $dlg -Name 'Save' -ControlType Button }
    Invoke-FcElement $save

    $deadline = (Get-Date).AddSeconds(10)
    while ((Get-Date) -lt $deadline) {
        $confirm = Get-FcWindow -Title 'Confirm Save As' -TimeoutSeconds 0 -Optional
        if ($confirm) {
            Save-FcScreenshot -Name "$ShotName-replace" -Element $confirm | Out-Null
            Invoke-FcElement (Find-FcElement -Scope $confirm -Name 'Yes' -ControlType Button)
            continue
        }
        if (-not (Get-FcWindow -Title 'Export clip' -TimeoutSeconds 0 -Optional)) { return }
        Start-Sleep -Milliseconds 100
    }
    throw 'the save dialog did not close'
}

function Start-FcExport {
    # Clicks Export. Returns 'popover' when the lossless choice opened, 'dialog' when the save
    # dialog came straight up.
    param([switch]$Lossless, [switch]$ExpectPopover)
    Invoke-FcElement (Find-FcElement -Id 'export-btn' -Name 'Export' -ControlType Button)
    $deadline = (Get-Date).AddSeconds(20)
    while ((Get-Date) -lt $deadline) {
        if (Get-FcWindow -Title 'Export clip' -TimeoutSeconds 0 -Optional) { return 'dialog' }
        $box = Find-FcElement -Id 'lossless' -Name 'Lossless (instant, cuts snap to keyframes)' -ControlType CheckBox -TimeoutSeconds 0 -Optional
        if ($box -and -not $box.Current.IsOffscreen) { return 'popover' }
        Start-Sleep -Milliseconds 150
    }
    throw 'neither the lossless choice nor the save dialog appeared after Export'
}

function Confirm-FcPopoverExport {
    # In the open lossless popover: sets the checkbox and presses the popover's Export.
    param([bool]$Lossless)
    $box = Find-FcElement -Id 'lossless' -Name 'Lossless (instant, cuts snap to keyframes)' -ControlType CheckBox
    $state = Get-FcToggleState $box
    if (($state -eq 'On') -ne $Lossless) { Switch-FcElement $box }
    Write-FcLog "lossless box is $(Get-FcToggleState $box)"
    Save-FcScreenshot -Name 'lossless-choice' | Out-Null
    $go = Find-FcElement -Id 'popover-go' -TimeoutSeconds 2 -Optional
    if (-not $go) { $go = Find-FcElement -Name 'Export' -ControlType Button -Index 1 }
    Invoke-FcElement $go
}

function Wait-Fc {
    param([Parameter(Mandatory, Position = 0)][scriptblock]$Condition, [int]$TimeoutSeconds = 30, [string]$What = 'condition', [int]$PollMs = 200)
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
        $r = $null
        try { $r = & $Condition } catch { $r = $null }
        if ($r) { return $r }
        Start-Sleep -Milliseconds $PollMs
    } while ((Get-Date) -lt $deadline)
    throw "timed out after $TimeoutSeconds s waiting for $What"
}

function Wait-FcExported {
    # Waits for the "Exported <name>" toast. The toast clears itself after 9 seconds.
    param([Parameter(Mandatory)][string]$FileName, [int]$TimeoutSeconds = 120)
    Wait-Fc -TimeoutSeconds $TimeoutSeconds -What "the 'Exported $FileName' toast" -PollMs 250 {
        $err = Find-FcText -Like '*could not*'
        if ($err) { throw "export failed: $err" }
        Find-FcText -Like "Exported $FileName"
    }
}

function Get-FcTree {
    # Writes every named control of a window to <out>\<name>.txt.
    param([string]$Window, [string]$Name = 'tree', $Element)
    $scope = if ($Element) { $Element } else { Get-FcWindow -Title $Window }
    $cond = [System.Windows.Automation.Condition]::TrueCondition
    $lines = foreach ($e in $scope.FindAll($Descendants, $cond)) {
        try {
            $c = $e.Current
            if ($c.Name -or $c.AutomationId) {
                '{0,-12} enabled={1,-5} offscreen={2,-5} id={3,-22} rect={4,-22} {5}' -f ($c.ControlType.ProgrammaticName -replace 'ControlType\.', ''), $c.IsEnabled, $c.IsOffscreen, $c.AutomationId, $c.BoundingRectangle, $c.Name
            }
        } catch { }
    }
    $lines | Set-Content -Encoding utf8 (Join-Path (Get-FcOutDir) "$Name.txt")
    return $lines
}

function Save-FcScreenshot {
    # One window, captured with PrintWindow so nothing else on the screen ends up in the file.
    param([Parameter(Mandatory)][string]$Name, [string]$Window, $Element)

    $el = if ($Element) { $Element } else { Get-FcWindow -Title $Window }
    $h = [IntPtr]$el.Current.NativeWindowHandle
    if ($h -eq [IntPtr]::Zero) { return Save-FcDesktopScreenshot -Name $Name }
    Start-Sleep -Milliseconds 400

    $r = New-Object FcWin32+RECT
    [FcWin32]::GetWindowRect($h, [ref]$r) | Out-Null
    $w = $r.R - $r.L
    $ht = $r.B - $r.T
    if ($w -le 0 -or $ht -le 0) { throw "window '$($el.Current.Name)' has no size" }
    $bmp = New-Object System.Drawing.Bitmap($w, $ht)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $dc = $g.GetHdc()
    # 2 = PW_RENDERFULLCONTENT, without which the WebView2 surface comes out black.
    [FcWin32]::PrintWindow($h, $dc, 2) | Out-Null
    $g.ReleaseHdc($dc)
    $g.Dispose()
    $script:Shot++
    $path = Join-Path (Get-FcOutDir) ('{0:D2}-{1}.png' -f $script:Shot, $Name)
    $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    Write-FcLog "screenshot $path ($w x $ht)"
    return $path
}

function Save-FcDesktopScreenshot {
    param([Parameter(Mandatory)][string]$Name)
    $b = [System.Windows.Forms.SystemInformation]::VirtualScreen
    $bmp = New-Object System.Drawing.Bitmap($b.Width, $b.Height)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size)
    $g.Dispose()
    $script:Shot++
    $path = Join-Path (Get-FcOutDir) ('{0:D2}-{1}.png' -f $script:Shot, $Name)
    $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    Write-FcLog "screenshot $path"
    return $path
}

function Get-FcProbe {
    # ffprobe's JSON for a file, or throws when ffprobe cannot read it.
    param([Parameter(Mandatory)][string]$Path)
    $json = & ffprobe -v error -show_entries 'format=duration,format_name:stream=codec_type,codec_name' -of json $Path 2>&1
    if ($LASTEXITCODE -ne 0) { throw "ffprobe could not read $Path`: $json" }
    $info = ($json -join "`n") | ConvertFrom-Json
    $video = @($info.streams | Where-Object codec_type -eq 'video')
    $audio = @($info.streams | Where-Object codec_type -eq 'audio')
    [pscustomobject]@{
        Duration = [double]$info.format.duration
        Format   = $info.format.format_name
        Video    = ($video | ForEach-Object codec_name) -join ','
        Audio    = ($audio | ForEach-Object codec_name) -join ','
    }
}

function Test-FcDecodes {
    # Decodes every frame, so a file that only has a readable header does not pass.
    param([Parameter(Mandatory)][string]$Path)
    $out = & ffmpeg -v error -i $Path -f null - 2>&1
    return ($LASTEXITCODE -eq 0 -and -not $out)
}

function Get-FcHash([string]$Path) { (Get-FileHash -Algorithm SHA256 $Path).Hash }

function Get-FcExportTemps([string]$Folder) { @(Get-ChildItem -Force -LiteralPath $Folder -Filter '.flipperclipper-export-*' -ErrorAction SilentlyContinue) }

function Invoke-FcCheck {
    # Runs a check body and turns its outcome into one PASS or FAIL line and the exit code.
    param([Parameter(Mandatory)][string]$Name, [Parameter(Mandatory)][scriptblock]$Body)
    try {
        & $Body
        Write-Host "PASS: $Name"
        exit 0
    } catch {
        Write-Host "FAIL: $Name - $($_.Exception.Message)"
        Write-Host $_.ScriptStackTrace
        try {
            if (Get-FcProcess) {
                Get-FcTree -Name 'tree-on-failure' | Out-Null
                Save-FcScreenshot -Name 'failure' | Out-Null
            }
        } catch { Write-Host "no failure capture: $_" }
        exit 1
    }
}

function Assert-Fc {
    param([Parameter(Mandatory)][bool]$Condition, [Parameter(Mandatory)][string]$Message)
    if (-not $Condition) { throw "check failed: $Message" }
    Write-FcLog "ok: $Message"
}

Export-ModuleMember -Function *-Fc*
