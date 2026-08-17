@echo off
cd /d "%~dp0"

echo ========================================
echo   QuickClip - Build EXE + installer
echo ========================================
echo.

set EXE_DIR=src-tauri\target\release
set EXE_NAME=QuickClip.exe
set OUTPUT_DIR=%USERPROFILE%\Downloads

REM npm ci wipes and reinstalls node_modules from the lockfile, which takes long
REM enough to be annoying on a build you run to check one change. It is only
REM needed when there is nothing there yet; a stale tree is what "npm ci" by hand
REM is for.
if not exist "node_modules" (
    echo [INFO] Installing npm dependencies from the lockfile...
    call npm ci
    if errorlevel 1 (
        echo.
        echo [ERROR] npm ci failed!
        pause
        exit /b 1
    )
)

REM vernum.mjs is the only thing in the project that knows how to turn the
REM version into four plain numbers for Windows, so both forms are asked of it
REM rather than parsed here. Reading package.json in a second place is how the
REM installer ends up claiming a version the app does not report.
for /f "delims=" %%v in ('node scripts\vernum.mjs --raw') do set "VERSION=%%v"
for /f "delims=" %%v in ('node scripts\vernum.mjs') do set "VERNUM=%%v"

echo.
echo [1/3] Building QuickClip %VERSION% - a cold Rust build takes a few minutes...
echo.

REM Records which commit this build came from, so a copy handed to someone can
REM be told apart from the other builds of the same version.
call node scripts\build_info.mjs

REM --no-bundle: Tauri's own NSIS/WiX bundlers are skipped because installer.iss
REM is what packages this project. See the header comment there for why.
REM npx, not `npm run tauri build -- --no-bundle`: npm swallows the flag and
REM Tauri bundles anyway, downloading WiX and NSIS to build an MSI and a setup
REM exe this project does not ship.
call npx tauri build --no-bundle

if errorlevel 1 (
    echo.
    echo [ERROR] Build failed!
    pause
    exit /b 1
)

echo.
echo [2/3] Looking for Inno Setup...

REM Inno Setup does not add itself to PATH, and winget installs it per-user into
REM %LOCALAPPDATA%\Programs rather than Program Files, so all three are searched.
set "ISCC="
for /f "delims=" %%i in ('where iscc.exe 2^>nul') do set "ISCC=%%i"
if not defined ISCC for /d %%d in ("%ProgramFiles(x86)%\Inno Setup *") do if exist "%%d\ISCC.exe" set "ISCC=%%d\ISCC.exe"
if not defined ISCC for /d %%d in ("%ProgramFiles%\Inno Setup *") do if exist "%%d\ISCC.exe" set "ISCC=%%d\ISCC.exe"
if not defined ISCC for /d %%d in ("%LOCALAPPDATA%\Programs\Inno Setup *") do if exist "%%d\ISCC.exe" set "ISCC=%%d\ISCC.exe"

if not defined ISCC (
    echo.
    echo ========================================
    echo   No installer was built
    echo ========================================
    echo.
    echo   Inno Setup is not installed on this machine. It is what turns the
    echo   release exe into the single QuickClip-Setup.exe we ship.
    echo.
    echo   Install it, then run this script again:
    echo       winget install -e --id JRSoftware.InnoSetup
    echo   or download it from https://jrsoftware.org/isdl.php
    echo.
    echo   The app itself is built and runnable right now at:
    echo       %CD%\%EXE_DIR%\%EXE_NAME%
    echo.
    pause
    exit /b 0
)

echo       Found: %ISCC%
echo.
echo [3/3] Building the installer...
echo.

"%ISCC%" "/O%OUTPUT_DIR%" "/DAppVersion=%VERSION%" "/DVersionNumeric=%VERNUM%" "installer.iss"

if errorlevel 1 (
    echo.
    echo [ERROR] Installer build failed!
    pause
    exit /b 1
)

echo.
echo ========================================
echo   Output: %OUTPUT_DIR%\QuickClip-Setup.exe
echo   Version: %VERSION% ^(%VERNUM%^)
echo   Installs per-user, no admin prompt
echo   FFmpeg: the app installs it on first run if missing
echo ========================================
echo.
pause
