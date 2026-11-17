@echo off
rem ASCII-only on purpose: .cmd files are parsed as ANSI, Chinese text here turns into garbage.
chcp 65001 >nul
setlocal
cd /d "%~dp0"

rem --- locate node.exe: PATH first, then the copy DSH ships with ---
set "NODE="
for /f "delims=" %%i in ('where node.exe 2^>nul') do if not defined NODE set "NODE=%%i"
if not defined NODE if exist "%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" set "NODE=%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
if not defined NODE (
  echo [X] node.exe not found. Install Node.js LTS or run DSH once so it ships its runtime.
  pause
  exit /b 1
)
echo [i] node: %NODE%

rem --- refuse to touch the profile while DSH is running (it locks package.json) ---
tasklist /FI "IMAGENAME eq DeepSeek Harness.exe" 2>nul | find /I "DeepSeek Harness.exe" >nul
if not errorlevel 1 (
  echo [!] DSH is still running. Quit it completely first
  echo     ^(tray icon - right click - Quit^), then double-click this file again.
  pause
  exit /b 1
)

"%NODE%" "scripts\install.mjs" %*
set RC=%ERRORLEVEL%
echo.
if not "%RC%"=="0" echo [X] install failed, see messages above.
if "%RC%"=="0" echo [OK] installed. Start DSH again and the voiceover tool is ready.
pause
exit /b %RC%