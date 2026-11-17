@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
set "NODE="
for /f "delims=" %%i in ('where node.exe 2^>nul') do if not defined NODE set "NODE=%%i"
if not defined NODE if exist "%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" set "NODE=%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
if not defined NODE (
  echo [X] node.exe not found.
  pause
  exit /b 1
)
tasklist /FI "IMAGENAME eq DeepSeek Harness.exe" 2>nul | find /I "DeepSeek Harness.exe" >nul
if not errorlevel 1 (
  echo [!] DSH is still running. Quit it completely first.
  pause
  exit /b 1
)
"%NODE%" "scripts\install.mjs" --uninstall
pause