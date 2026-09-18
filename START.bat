@echo off
setlocal
cd /d "%~dp0"

echo ========================================
echo PUSH CLXN - START SERVER
echo ========================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo ERROR: Node.js was not found.
  echo Install Node.js LTS, then run this file again.
  echo.
  pause
  exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
  echo ERROR: npm was not found.
  echo Reinstall Node.js LTS, then run this file again.
  echo.
  pause
  exit /b 1
)

if not exist node_modules (
  echo Installing dependencies...
  call npm install
  if errorlevel 1 (
    echo.
    echo ERROR: npm install failed.
    pause
    exit /b 1
  )
)

echo.
echo Starting server...
echo.
echo Open this address in your browser:
echo http://localhost:3000
echo.
echo Keep this window open while the site is running.
echo Press Ctrl+C to stop the server.
echo.
start "" http://localhost:3000
call npm start

pause
