# UI checks

`.github/workflows/ui-check.yml` builds the app on a GitHub Windows runner, puts a pinned FFmpeg
build on PATH, runs every script in `checks/` against the real app, and uploads the screenshots,
control lists and logs as the `ui-check-results` artifact. The runner starts clean on every run,
so a check can wipe the app's settings and WebView2 profile freely.

Do not run these on a desktop you use. They launch the app, take over the mouse and keyboard,
and delete `%APPDATA%\com.mkiera.flipperclipper` and `%LOCALAPPDATA%\com.mkiera.flipperclipper`.

## Run it

Push a branch. The workflow runs on every push that changes more than Markdown files. To run only
some checks on a branch that is already pushed:

    gh workflow run ui-check.yml --ref <branch> -f filter=<name or wildcard>

`workflow_dispatch` works only once the workflow file is on the default branch. Until then, push.

Read the result:

    gh run list --workflow ui-check.yml --branch <branch> --limit 1
    gh run watch <run id> --exit-status
    gh run download <run id> --name ui-check-results --dir <folder>

Each check gets a folder holding `log.txt`, numbered screenshots and any control lists it wrote.
A failed check also holds `failure.png` and `tree-on-failure.txt`. The log ends with a
`PASS: <check>` or `FAIL: <check> - <reason>` line, and `summary.md` lists every check.

## Test media

`Invoke-UiChecks.ps1` makes the clips once with FFmpeg before the first check:

| File | Contents |
| --- | --- |
| `clip.wmv` | 6 s, 640x360, wmv2 and wmav2. WebView2 cannot play it |
| `clip.mp4` | 6 s, 1280x720, h264 and aac, a keyframe every second |
| `long.mp4` | 120 s, 1920x1080, h264 and aac, for an export that is still running when the check acts |
| `other.mp4` | 2 s red frame, used as an existing file an export overwrites |

`Get-FcMedia <name>` copies one into the check's own work folder and returns its path.

## Write a check

Add `checks/<name>.ps1`. A check passes when its body finishes without an error.

    $ErrorActionPreference = 'Stop'
    Import-Module $env:FC_UI_MODULE

    Invoke-FcCheck 'my-check' {
        Initialize-FcProfile | Out-Null
        Start-Fc -File (Get-FcMedia 'clip.mp4') | Out-Null
        if ((Start-FcExport) -eq 'popover') { Confirm-FcPopoverExport -Lossless $false }
        Complete-FcSaveDialog -Path (Join-Path (Get-FcWorkDir) 'out.mp4')
        Wait-FcExported -FileName 'out.mp4' | Out-Null
        Save-FcScreenshot -Name 'exported' | Out-Null
        Close-Fc | Out-Null
    }

The app opens a file given on its command line, so checks open clips with `Start-Fc -File`
instead of the open dialog. Exports go through the real Windows save dialog.

WebView2 exposes each HTML element's `id` as its UI Automation `AutomationId`, and its accessible
name (`aria-label`, label text or button text) as `Name`. `Find-FcElement` tries `-Id` first, then
`-Name`. Run `Get-FcTree` to see what a window exposes.

| Function | Does |
| --- | --- |
| `Initialize-FcProfile [-Settings] [-NoSettings]` | Wipes the app's data and writes `settings.json` with the update check off. CI only, unless `FC_UI_ALLOW_LOCAL=1` |
| `Start-Fc [-File]` | Launches the app and waits for the page, and for Export to enable when a file is given |
| `Close-Fc` | Closes the window like its X button and returns the seconds until the process exited |
| `Find-FcElement -Id -Name -NameLike -ControlType -Index -Scope -Window` | Waits for a control |
| `Get-FcTexts`, `Find-FcText -Like` | Visible text, for toasts, labels and banners |
| `Invoke-FcElement`, `Switch-FcElement`, `Select-FcOption`, `Set-FcText` | Click, toggle, pick a `<select>` option, type into a text box |
| `Send-FcKeys`, `Invoke-FcDrag` | Real keyboard and mouse input to the app window |
| `Set-FcTrimEnd -Fraction` | Drags the trim-end handle and confirms the export length changed |
| `Start-FcExport`, `Confirm-FcPopoverExport`, `Complete-FcSaveDialog`, `Wait-FcExported` | One export, from the Export button to the toast |
| `Get-FcProbe`, `Test-FcDecodes` | ffprobe a file, decode it fully |
| `Get-FcExportTemps <folder>` | The `.flipperclipper-export-*` files in a folder |
| `Save-FcScreenshot -Name [-Element]` | One window, captured with `PrintWindow` |
| `Assert-Fc <condition> <message>` | Fails the check with the message |
