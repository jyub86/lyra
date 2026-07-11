@echo off
rem Lyra launcher (Windows) - double-click to start the server and open the browser.
rem (Internet is needed only on the first run: installs Bun runtime + dependencies.)
setlocal
cd /d "%~dp0"

rem --- Ensure Bun (install if missing) ---
where bun >nul 2>nul
if errorlevel 1 (
  echo Installing Bun runtime ^(first run only^)...
  powershell -NoProfile -Command "irm bun.sh/install.ps1 | iex"
)
set "PATH=%USERPROFILE%\.bun\bin;%PATH%"

where bun >nul 2>nul
if errorlevel 1 (
  echo.
  echo [X] Bun not found. Check your internet connection and run again.
  pause
  exit /b 1
)

rem --- Dependencies (only if missing) ---
if not exist node_modules (
  echo Installing dependencies...
  call bun install
)

rem --- Optional: seed content DB if source JSON exists and DB is missing ---
if not exist "data\worship.db" if exist "data\source\bible.json" (
  echo Seeding content database...
  call bun run seed
)

echo.
echo ^> Lyra is running... your browser will open automatically.
echo    (Close this window to stop Lyra.)
echo.
set LYRA_OPEN=1
bun run server/index.js
pause
