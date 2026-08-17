; iscc /DAppVersion=0.2.0-beta /DVersionNumeric=0.2.0.0 installer.iss -> dist_installer\FlipperClipper-Setup.exe

#define AppName "FlipperClipper"
#define AppPublisher "mkiera"
#define AppURL "https://github.com/mkiera/FlipperClipper"
#define AppExeName "FlipperClipper.exe"

#ifndef AppSourceExe
  #define AppSourceExe "src-tauri\target\release\flipperclipper.exe"
#endif

; Fallbacks for a hand-run iscc only; every real build passes both defines in.
#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
#ifndef VersionNumeric
  #define VersionNumeric "0.0.0.0"
#endif

[Setup]
; NEVER change: Windows keys the installed product on this GUID.
AppId={{A67FDBB5-CF45-489D-8A41-0E7576A446F1}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#AppPublisher}
AppPublisherURL={#AppURL}
AppSupportURL={#AppURL}/issues
AppUpdatesURL={#AppURL}/releases

PrivilegesRequired=lowest
DefaultDirName={localappdata}\Programs\FlipperClipper
DefaultGroupName={#AppName}

DisableStartupPrompt=yes
DisableWelcomePage=yes
DisableDirPage=yes
DisableProgramGroupPage=yes
DisableReadyPage=yes
DisableFinishedPage=yes

; The updater passes no /DIR or /TASKS, so a silent update would otherwise relocate the install.
UsePreviousAppDir=yes
UsePreviousTasks=yes

CloseApplications=yes
; Relaunching is the [Run] entry's job; Restart Manager doing it too opens a second window.
RestartApplications=no

Uninstallable=yes
UninstallDisplayName={#AppName}
UninstallDisplayIcon={app}\{#AppExeName}

OutputDir=dist_installer
OutputBaseFilename=FlipperClipper-Setup
SetupIconFile=src-tauri\icons\icon.ico
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern

; A setup exe with no version resource scores on antivirus heuristics.
VersionInfoVersion={#VersionNumeric}
VersionInfoProductVersion={#VersionNumeric}
VersionInfoTextVersion={#AppVersion}
VersionInfoProductName={#AppName}
VersionInfoDescription={#AppName} Setup
VersionInfoCompany={#AppPublisher}
VersionInfoCopyright=MIT License

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"

[Files]
; Cargo emits lowercase flipperclipper.exe and `tauri build` does not rename it, so DestName does.
Source: "{#AppSourceExe}"; DestDir: "{app}"; DestName: "{#AppExeName}"; Flags: ignoreversion

[Icons]
; No AppUserModelID: tagging the shortcut while the process stays untagged splits the taskbar button.
Name: "{autoprograms}\{#AppName}"; Filename: "{app}\{#AppExeName}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExeName}"; Tasks: desktopicon

[Run]
; Neither postinstall nor skipifsilent: this is the only thing that restarts the app after an update.
Filename: "{app}\{#AppExeName}"; StatusMsg: "Starting {#AppName}..."; Flags: nowait

[UninstallDelete]
Type: filesandordirs; Name: "{localappdata}\com.mkiera.flipperclipper"
Type: filesandordirs; Name: "{userappdata}\com.mkiera.flipperclipper"
