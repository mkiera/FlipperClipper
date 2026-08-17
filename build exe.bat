@echo off
cd /d "%~dp0"

echo ========================================
echo   FlipperClipper - Build EXE + installer
echo ========================================
echo.

set EXE_DIR=src-tauri\target\release
REM Lowercase: cargo names the binary after the crate; the installer's DestName
REM is what ships the capitalised FlipperClipper.exe.
set EXE_NAME=flipperclipper.exe
set OUTPUT_DIR=%USERPROFILE%\Downloads

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

for /f "delims=" %%v in ('node scripts\vernum.mjs --raw') do set "VERSION=%%v"
for /f "delims=" %%v in ('node scripts\vernum.mjs') do set "VERNUM=%%v"

echo.
echo [1/3] Building FlipperClipper %VERSION% - a cold Rust build takes a few minutes...
echo.

call node scripts\build_info.mjs

REM npx, not `npm run tauri build -- --no-bundle`: npm swallows the flag and
REM Tauri bundles anyway, downloading WiX and NSIS.
call npx tauri build --no-bundle

if errorlevel 1 (
    echo.
    echo [ERROR] Build failed!
    pause
    exit /b 1
)

echo.
echo [2/3] Looking for Inno Setup...

REM Inno Setup is not on PATH, and winget installs it per-user into
REM %LOCALAPPDATA%\Programs rather than Program Files.
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
    echo   release exe into the single FlipperClipper-Setup.exe we ship.
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
echo   Output: %OUTPUT_DIR%\FlipperClipper-Setup.exe
echo   Version: %VERSION% ^(%VERNUM%^)
echo   Installs per-user, no admin prompt
echo   FFmpeg: the app installs it on first run if missing
echo ========================================
echo.
pause
