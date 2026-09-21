@echo off
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"
color 0B
title PUSH CLXN - START

cls
echo ==================================================
echo              PUSH CLXN - START
echo ==================================================
echo.

where node >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Node.js 18+ not found.
  echo Install Node.js 18 or newer, then run START_FINAL.bat again.
  goto END
)

if not exist "%~dp0package.json" (
  echo [ERROR] package.json not found.
  echo Run START_FINAL.bat from the extracted PUSH CLXN folder.
  goto END
)

if not exist "%~dp0node_modules\express" (
  echo [1/3] Installing packages...
  call npm install
  if errorlevel 1 (
    echo.
    echo [ERROR] npm install failed. The window will stay open.
    goto END
  )
)

if not exist "%~dp0.env" (
  copy /Y "%~dp0.env.example" "%~dp0.env" >nul
  echo [2/3] Created .env
)

findstr /R /B /C:"STRIPE_SECRET_KEY=$" /C:"STRIPE_SECRET_KEY= *$" "%~dp0.env" >nul 2>&1
if not errorlevel 1 (
  echo [2/3] Stripe key is not configured.
  echo Opening key setup. Paste the ENTIRE sk_live_... or rk_live_... key with Ctrl+V.
  call "%~dp0SETUP_STRIPE_KEY.bat"
  if errorlevel 1 goto END
) else (
  echo [2/3] Stripe key found locally
)

set "PORT="
for /L %%P in (3000,1,3010) do (
  netstat -ano 2>nul | findstr /R /C:":%%P .*LISTENING" >nul
  if errorlevel 1 (
    set "PORT=%%P"
    goto PORT_FOUND
  )
)

echo [ERROR] Ports 3000-3010 are all busy.
goto END

:PORT_FOUND
set "PUBLIC_BASE_URL=http://localhost:%PORT%"
set "PORT=%PORT%"

echo [3/3] Starting server on port %PORT%...
echo.
echo Site:    http://localhost:%PORT%
echo Payment: http://localhost:%PORT%/payment.html
echo API:     http://localhost:%PORT%/api/status
echo.
echo Keep this window open while PUSH CLXN is running.
echo Press Ctrl+C to stop the server.
echo.

start "PUSH CLXN Browser" /B cmd /c "timeout /t 2 /nobreak >nul & start http://localhost:%PORT%"
node server.js

echo.
echo ==================================================
echo PUSH CLXN stopped. Any error is shown above.
echo ==================================================

goto END

:END
echo.
echo Press any key to close this window...
pause >nul
endlocal
