; QuickClip installer.
;
; Tauri can produce an NSIS or a WiX installer of its own, and this script
; exists in place of either because the in-app updater depends on behaviour
; neither of them lets us pin down: a per-user install under {localappdata}
; that never raises UAC, an AppId frozen forever so an upgrade replaces the
; previous install instead of landing beside it, and a [Run] entry that is the
; only thing responsible for starting the app again after a silent update.
; updater.rs is written against exactly that contract, so the build runs
; `npx tauri build --no-bundle` and hands the resulting exe to this script
; instead.
;
; Per-user by design: PrivilegesRequired=lowest means Windows never shows a UAC
; prompt, because an elevation dialog on an unsigned installer is its own scare.
;
; No WebView2 bootstrapper is bundled or checked for. Windows 11 ships the
; runtime, and Windows 10 has been receiving it through Windows Update since
; 2021, so the check would cost every user a bundled 1.7 MB bootstrapper to
; cover a case that has not been reproduced. Worth revisiting if anyone ever
; reports a blank window on launch, which is what its absence looks like.
;
; Compile with (both defines optional, see below for the fallbacks):
;   iscc /DAppVersion=0.2.0-beta /DVersionNumeric=0.2.0.0 installer.iss
; The output is dist_installer\QuickClip-Setup.exe.

#define AppName "QuickClip"
#define AppPublisher "mkiera"
#define AppURL "https://github.com/mkiera/QuickClip"
#define AppExeName "QuickClip.exe"

; Where `tauri build --no-bundle` leaves the release binary. Relative paths
; resolve against this script's directory.
#ifndef AppSourceExe
  #define AppSourceExe "src-tauri\target\release\QuickClip.exe"
#endif

; Both version defines are passed in by whoever compiles this script -- the
; workflows and "build exe.bat" -- rather than being read here.
;
; FinFetcher's installer read its version.txt directly, on the grounds that a
; number the script reads itself can never drift from the one the app reports.
; The same guarantee holds here by a different route: the version now lives in
; package.json, the Inno Setup preprocessor has no way to read JSON, and
; hand-rolling a JSON parser out of FileRead calls would create precisely the
; second version parser that scripts\vernum.mjs exists to prevent. So node
; reads package.json once, in one place, and passes both forms in.
;
; The fallbacks are only for someone running iscc by hand on this file; they
; produce an obviously-wrong version rather than a build that silently claims
; to be a real release. 0.0.0.0 is Inno Setup's own default for
; VersionInfoVersion.
#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
#ifndef VersionNumeric
  #define VersionNumeric "0.0.0.0"
#endif

[Setup]
; This GUID is what identifies the installed product to Windows. It must NEVER
; change: a new AppId makes Windows treat the next release as a different
; program, so it installs alongside the old one instead of replacing it, and the
; stale entry sits in Add/Remove Programs forever. It is also deliberately not
; FinFetcher's GUID -- two products sharing one AppId is the same bug seen from
; the other side, where installing one would uninstall the other.
AppId={{A96EC7EC-CE36-405E-BF0A-8842C6FB7C6D}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#AppPublisher}
AppPublisherURL={#AppURL}
AppSupportURL={#AppURL}/issues
AppUpdatesURL={#AppURL}/releases

; Per-user install, no elevation. {localappdata}\Programs is where a
; non-administrative install belongs, and writing there needs no UAC prompt.
PrivilegesRequired=lowest
DefaultDirName={localappdata}\Programs\QuickClip
DefaultGroupName={#AppName}

; QuickClip is a tool you open, use for forty seconds and close, so an installer
; that asks five questions before it will let you do that is the wrong shape.
; Every page that is not asking a real question is off: what is left is the
; single "additional tasks" page holding the desktop-shortcut checkbox, and its
; button reads Install.
DisableStartupPrompt=yes
DisableWelcomePage=yes
DisableDirPage=yes
DisableProgramGroupPage=yes
DisableReadyPage=yes
DisableFinishedPage=yes

; Both of these are Inno Setup defaults, spelled out because the in-app updater
; depends on them and deliberately does not pass /DIR or /TASKS. Turning either
; off would move a silently-updated app to the default directory and reset the
; user's desktop-shortcut choice.
UsePreviousAppDir=yes
UsePreviousTasks=yes

; Close a running QuickClip before overwriting it. The updater exits first and
; passes /CLOSEAPPLICATIONS as well, but a second window -- or simply losing the
; race with our own shutdown -- would otherwise leave the exe locked. The
; default filter of *.exe,*.dll is enough here: unlike the PyInstaller app this
; pattern came from, a Tauri build holds open nothing but itself and the
; WebView2 runtime, which lives elsewhere and is not ours to close.
CloseApplications=yes
; Relaunching the app is the [Run] entry's job and only its job. Letting the
; Restart Manager put it back too is how you end up with two windows open on
; the same clip. The updater passes /NORESTARTAPPLICATIONS for the same reason;
; this makes it true for interactive installs as well.
RestartApplications=no

Uninstallable=yes
UninstallDisplayName={#AppName}
UninstallDisplayIcon={app}\{#AppExeName}

OutputDir=dist_installer
OutputBaseFilename=QuickClip-Setup
SetupIconFile=src-tauri\icons\icon.ico
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern

; The setup exe is the file people actually download, so it carries a version
; resource of its own for the same reason the app exe does: an executable with
; no company, product or description reads as suspicious to antivirus
; heuristics. Measured on FinFetcher, filling this block in removed a detection
; on VirusTotal by itself.
VersionInfoVersion={#VersionNumeric}
VersionInfoProductVersion={#VersionNumeric}
VersionInfoTextVersion={#AppVersion}
VersionInfoProductName={#AppName}
VersionInfoDescription={#AppName} Setup
VersionInfoCompany={#AppPublisher}
VersionInfoCopyright=MIT License

; No ArchitecturesAllowed or ArchitecturesInstallIn64BitMode on purpose: nothing
; lands under Program Files, so there is no WOW64 redirection to opt out of, and
; the accepted spelling of the 64-bit value changed in Inno Setup 6.3 -- pinning
; one would break whichever version the build machine happens to have.

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"

[Files]
; One file. That is the whole reason this script is shorter than the one it was
; adapted from: FinFetcher shipped a PyInstaller --onedir tree, where an upgrade
; that copied over the top left the previous build's orphaned DLLs behind for
; the new app to import by accident, so its [Code] section had to park the old
; tree under another name, delete it only once the install could no longer fail,
; and move it back if it never got there. A Tauri release build is a single
; self-contained exe, so an upgrade is a plain overwrite with nothing to orphan
; and nothing to roll back. That machinery is dropped, along with the
; _internal.old cleanup that existed to catch it failing halfway.
;
; DestName because cargo names the binary after the crate, which is lowercase:
; the file on disk really is quickclip.exe, and `tauri build` does NOT rename it
; to productName (verified against a release build). The source line only
; matches it because Windows filenames are case-insensitive, so DestName is what
; actually puts QuickClip.exe in the install folder - and the [Icons] and [Run]
; entries below, and the shortcut the user ends up with, all name that file.
; ignoreversion because the file is ours and its version resource is not a
; reliable "is this newer" signal for a reinstall of the same version.
Source: "{#AppSourceExe}"; DestDir: "{app}"; DestName: "{#AppExeName}"; Flags: ignoreversion

[Icons]
; No AppUserModelID on purpose. With no explicit ID anywhere, Windows groups
; taskbar buttons by the executable path, and that path is the same whether the
; app was started from a shortcut, from a command line, or by the [Run] entry
; after a silent update. Tagging the shortcut while the process stays untagged
; breaks exactly that: the pinned icon and the running window become two
; separate buttons on any launch that did not come from the shortcut, which
; includes the post-update relaunch -- the common case for an app that updates
; itself. It could only go back in if the app also called
; SetCurrentProcessExplicitAppUserModelID with the same string before its window
; appears, and nothing here does; that would mean taking on the windows crate
; for a taskbar detail that is already correct without it.
Name: "{autoprograms}\{#AppName}"; Filename: "{app}\{#AppExeName}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExeName}"; Tasks: desktopicon

[Run]
; Deliberately neither "postinstall" nor "skipifsilent". A postinstall entry is a
; checkbox on the Setup Completed page, which is disabled here, and skipifsilent
; would leave a silent update with no app running at all -- the updater exits
; before Setup starts and expects Setup to be what brings the app back.
Filename: "{app}\{#AppExeName}"; StatusMsg: "Starting {#AppName}..."; Flags: nowait

[UninstallDelete]
; Everything QuickClip leaves outside {app}, removed without asking.
;
; FinFetcher's uninstaller put a question here, because what it would have been
; deleting was a user's saved settings and a 30 MB ffmpeg they might well want
; again. Neither applies. QuickClip has no project files and no saved work by
; design -- the only thing in these folders is WebView2's own profile cache and
; the remembered quality-dropdown choice, which is one enum value. Asking
; someone whether to keep that would be a question with no wrong answer, which
; is a question not worth putting in front of them.
;
; The local folder is where WebView2 keeps that profile. The roaming one is
; where the updater parks the setup exes it downloads: pure cache, and worth
; nothing the moment the app it would have updated is gone. Both are named in
; full rather than swept with a wildcard.
Type: filesandordirs; Name: "{localappdata}\com.mkiera.quickclip"
Type: filesandordirs; Name: "{userappdata}\com.mkiera.quickclip"

; No [Code] section. See the note in [Files] for what used to be in one.
