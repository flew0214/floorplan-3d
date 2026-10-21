@echo off
rem ============================================================
rem  floorplan-3d launcher (Windows)
rem  Starts a local HTTP server, then opens the app in your browser.
rem  Reason: browsers block file:// -> file:// ES module imports
rem  (CORS), so double-clicking index.html cannot load three.js.
rem ============================================================
chcp 65001 >nul
cd /d "%~dp0"

set PORT=8123

rem pick the first available python
set PY=
where python >nul 2>nul && set PY=python
if not defined PY ( where py >nul 2>nul && set PY=py -3 )
if not defined PY (
  echo.
  echo   Python not found. Install Python 3 and run again,
  echo   or serve this folder with any static server, e.g.:
  echo       npx serve .
  echo.
  pause
  exit /b 1
)

echo.
echo   floorplan-3d  -  starting local server on port %PORT% ...
echo   URL: http://127.0.0.1:%PORT%/index.html
echo   Keep this window open while using the app. Ctrl+C to stop.
echo.

start "floorplan-3d server" cmd /k "%PY% -m http.server %PORT% --bind 127.0.0.1"
timeout /t 2 /nobreak >nul
start "" "http://127.0.0.1:%PORT%/index.html"
exit /b 0
