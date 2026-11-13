Set-StrictMode -Version 3
$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Drawing, System.Windows.Forms

Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class FcWin32 {
    public delegate bool EnumProc(IntPtr h, IntPtr l);
    [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr parent, EnumProc cb, IntPtr l);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] public static extern IntPtr GetParent(IntPtr h);
    [DllImport("user32.dll")] public static extern int GetDlgCtrlID(IntPtr h);
    [DllImport("user32.dll")] public static extern IntPtr GetDlgItem(IntPtr h, int id);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr SendMessage(IntPtr h, uint msg, IntPtr w, string l);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr SendMessage(IntPtr h, uint msg, IntPtr w, StringBuilder l);
    [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
    static string ClassOf(IntPtr h) { var s = new StringBuilder(256); GetClassName(h, s, 256); return s.ToString(); }
    // The File name box of a common file dialog: an Edit inside the ComboBox with control id 1001.
    public static IntPtr FileNameEdit(IntPtr dlg) {
        IntPtr found = IntPtr.Zero;
        EnumChildWindows(dlg, (h, l) => {
            if (ClassOf(h) == "Edit") {
                IntPtr p = GetParent(h);
                if (ClassOf(p) == "ComboBox" && GetDlgCtrlID(p) == 1001) { found = h; return false; }
            }
            return true;
        }, IntPtr.Zero);
        return found;
    }
    public static string GetText(IntPtr h) { var s = new StringBuilder(1024); SendMessage(h, 0x000D, (IntPtr)1024, s); return s.ToString(); }
    public static void SetText(IntPtr h, string text) { SendMessage(h, 0x000C, IntPtr.Zero, text); }
    // Posted, not sent: the replace prompt is modal and would block a sent click.
    public static bool ClickButton(IntPtr dlg, int id) { IntPtr b = GetDlgItem(dlg, id); return b != IntPtr.Zero && PostMessage(b, 0x00F5, IntPtr.Zero, IntPtr.Zero); }
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
                    if ($type) {
                        $c = New-Object System.Windows.Automation.AndCondition($c,
                            (New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, $type)))
                    }
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
    if ([FcWin32]::GetForegroundWindow() -eq $h) { return }
    # Not Alt: a lone Alt tap puts the window in menu mode, which eats the next key or click.
    [FcWin32]::keybd_event(0x87, 0, 0, [UIntPtr]::Zero)
    [FcWin32]::keybd_event(0x87, 0, 2, [UIntPtr]::Zero)
    [FcWin32]::SetForegroundWindow($h) | Out-Null
    Start-Sleep -Milliseconds 300
    if ([FcWin32]::GetForegroundWindow() -ne $h) { Write-FcLog "warning: window $h did not come to the foreground" }
}

function Send-FcKeys {
    # SendKeys syntax: '{RIGHT}', '+{RIGHT}', '^e'. Goes to whatever has focus in the app window.
    param([Parameter(Mandatory)][string]$Keys, $Window)
    Set-FcForeground $Window
    Write-FcLog "keys $Keys"
    [System.Windows.Forms.SendKeys]::SendWait($Keys)
    Start-Sleep -Milliseconds 300
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

function Get-FcTimeLabel {
    # "0:00.0 / 0:06.0": the second half is the length of the export.
    Get-FcTexts | Where-Object { $_ -match '^\d+:\d\d\.\d / \d+:\d\d\.\d$' } | Select-Object -First 1
}

function Set-FcTrimEnd {
    # Moves the playhead with Shift+Right (one second each) and sets the trim end there with O,
    # the app's own keyboard route. Returns the time label, whose second half is the export length.
    param([int]$Seconds = 3)
    $before = Get-FcTimeLabel
    $play = Find-FcElement -Id 'play-btn' -Name 'Play' -ControlType Button
    Set-FcForeground
    $play.SetFocus()
    Send-FcKeys '{HOME}'
    for ($i = 0; $i -lt $Seconds; $i++) { Send-FcKeys '+{RIGHT}' }
    Send-FcKeys 'o'
    $after = Get-FcTimeLabel
    Write-FcLog "time label '$before' -> '$after'"
    if ($before -eq $after) { throw "Shift+Right then O did not change the export length ('$after')" }
    return $after
}

function Get-FcDialog {
    # A dialog of the app as its own top-level element. Reached through the main window, its
    # controls show up as bare panes without the Value and Invoke patterns.
    param([Parameter(Mandatory)][string]$Title, [int]$TimeoutSeconds = 20, [switch]$Optional)
    $w = Get-FcWindow -Title $Title -TimeoutSeconds $TimeoutSeconds -Optional
    if (-not $w) {
        if ($Optional) { return $null }
        throw "no window titled '$Title'"
    }
    $h = [IntPtr]$w.Current.NativeWindowHandle
    if ($h -ne [IntPtr]::Zero) {
        try { return $AE::FromHandle($h) } catch { }
    }
    return $w
}

function Find-FcDialogControl($Dialog, [string]$Id, [string]$ControlType) {
    $cond = New-Object System.Windows.Automation.AndCondition(
        (New-Object System.Windows.Automation.PropertyCondition($AE::AutomationIdProperty, $Id)),
        (New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, [System.Windows.Automation.ControlType]::$ControlType)))
    try { return $Dialog.FindFirst($Descendants, $cond) } catch { return $null }
}

function Complete-FcSaveDialog {
    # Drives the Windows "Export clip" save dialog: enters the full path and presses Save,
    # answering Yes when Windows asks to replace an existing file.
    param([Parameter(Mandatory)][string]$Path, [switch]$Cancel, [string]$ShotName = 'save-dialog')

    $dlg = Get-FcDialog -Title 'Export clip'
    Start-Sleep -Milliseconds 700
    Save-FcScreenshot -Name $ShotName -Element $dlg | Out-Null
    if ($Cancel) {
        $btn = Find-FcDialogControl $dlg '2' 'Button'
        if ($btn) { Invoke-FcElement $btn } else { Send-FcKeys '{ESC}' -Window $dlg }
        Wait-Fc -TimeoutSeconds 10 -What 'the save dialog to close' { -not (Get-FcWindow -Title 'Export clip' -TimeoutSeconds 0 -Optional) }
        return
    }

    # The File name box exposes no Value pattern, and typing into it races its autocomplete,
    # so the path goes in with WM_SETTEXT and Save is clicked with BM_CLICK.
    $h = [IntPtr]$dlg.Current.NativeWindowHandle
    $edit = [FcWin32]::FileNameEdit($h)
    if ($edit -ne [IntPtr]::Zero) {
        [FcWin32]::SetText($edit, $Path)
        Start-Sleep -Milliseconds 200
        $typed = [FcWin32]::GetText($edit)
        Write-FcLog "file name box holds '$typed'"
        if ($typed -ne $Path) { throw "the File name box holds '$typed', not '$Path'" }
        if (-not [FcWin32]::ClickButton($h, 1)) { Send-FcKeys '{ENTER}' -Window $dlg }
    } else {
        Write-FcLog 'no File name edit found; pasting the path'
        Set-Clipboard -Value $Path
        Send-FcKeys '%n' -Window $dlg
        Send-FcKeys '^a' -Window $dlg
        Send-FcKeys '^v' -Window $dlg
        Send-FcKeys '{ENTER}' -Window $dlg
    }

    $deadline = (Get-Date).AddSeconds(10)
    while ((Get-Date) -lt $deadline) {
        $confirm = Get-FcDialog -Title 'Confirm Save As' -TimeoutSeconds 0 -Optional
        if ($confirm) {
            Save-FcScreenshot -Name "$ShotName-replace" -Element $confirm | Out-Null
            # Alt+Y is the dialog's own Yes; its button is not reliably exposed to UI Automation.
            Send-FcKeys '%y' -Window $confirm
            continue
        }
        if (-not (Get-FcWindow -Title 'Export clip' -TimeoutSeconds 0 -Optional)) { return }
        Start-Sleep -Milliseconds 100
    }
    Save-FcDesktopScreenshot -Name "$ShotName-stuck" | Out-Null
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

function Invoke-FcFileDrop {
    # Drags files from Explorer's side of an OLE drag onto the screen point X, Y, the way a
    # drop from a folder window arrives. The source is a small window in its own STA process,
    # which starts the drag when it is pressed. Returns the screenshot taken while hovering.
    param([Parameter(Mandatory)][string[]]$Paths, [Parameter(Mandatory)][int]$X, [Parameter(Mandatory)][int]$Y, [string]$ShotName = 'dragging-files')

    $work = Get-FcWorkDir
    $source = Join-Path $work 'drag-source.ps1'
    $list = Join-Path $work 'drag-source.txt'
    Set-Content -LiteralPath $list -Value $Paths -Encoding UTF8
    Set-Content -LiteralPath $source -Encoding UTF8 -Value @'
param([string]$List)
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$files = New-Object System.Collections.Specialized.StringCollection
Get-Content -LiteralPath $List -Encoding UTF8 | Where-Object { $_ } | ForEach-Object { [void]$files.Add($_) }
$form = New-Object System.Windows.Forms.Form
$form.Text = 'fc-drag-source'
$form.FormBorderStyle = 'None'
$form.StartPosition = 'Manual'
$form.Location = New-Object System.Drawing.Point(0, 0)
$form.Size = New-Object System.Drawing.Size(120, 120)
$form.TopMost = $true
$form.ShowInTaskbar = $false
$form.BackColor = [System.Drawing.Color]::Orange
$form.Add_MouseDown({
    $data = New-Object System.Windows.Forms.DataObject
    $data.SetFileDropList($files)
    [void]$form.DoDragDrop($data, [System.Windows.Forms.DragDropEffects]::Copy)
    $form.Close()
})
[System.Windows.Forms.Application]::Run($form)
'@
    $shell = (Get-Process -Id $PID).Path
    $proc = Start-Process -FilePath $shell -ArgumentList @('-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', "`"$source`"", '-List', "`"$list`"") -PassThru
    try {
        $byName = New-Object System.Windows.Automation.PropertyCondition($AE::NameProperty, 'fc-drag-source')
        $win = Wait-Fc -TimeoutSeconds 20 -What 'the drag source window' { $AE::RootElement.FindFirst($Children, $byName) }
        $r = $win.Current.BoundingRectangle
        Write-FcLog "drag source at $($r.Left), $($r.Top), $($r.Width) x $($r.Height)"
        $fromX = [int]($r.Left + $r.Width / 2)
        $fromY = [int]($r.Top + $r.Height / 2)
        [FcWin32]::SetCursorPos($fromX, $fromY) | Out-Null
        Start-Sleep -Milliseconds 200
        [FcWin32]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
        # DoDragDrop starts from the press and then follows the cursor.
        Start-Sleep -Milliseconds 400
        $steps = 25
        for ($i = 1; $i -le $steps; $i++) {
            [FcWin32]::SetCursorPos([int]($fromX + ($X - $fromX) * $i / $steps), [int]($fromY + ($Y - $fromY) * $i / $steps)) | Out-Null
            Start-Sleep -Milliseconds 40
        }
        # Small moves on the target, so the drop target sees it hover rather than pass through.
        for ($i = 0; $i -lt 5; $i++) {
            [FcWin32]::SetCursorPos($X + ($i % 2), $Y) | Out-Null
            Start-Sleep -Milliseconds 100
        }
        if ($proc.HasExited) { Write-FcLog 'warning: the drag source closed before the drop, so no drag ran' }
        $shot = Save-FcScreenshot -Name $ShotName
        Save-FcDesktopScreenshot -Name "$ShotName-desktop" | Out-Null
        [FcWin32]::SetCursorPos($X, $Y) | Out-Null
        [FcWin32]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
        Write-FcLog "dropped $($Paths.Count) file(s) at $X, $Y"
        Wait-Fc -TimeoutSeconds 10 -What 'the drag source to close' { $proc.HasExited } | Out-Null
        return $shot
    } finally {
        if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
        Remove-Item -LiteralPath $source, $list -Force -ErrorAction SilentlyContinue
    }
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
