@echo off
setlocal EnableExtensions
cd /d "%~dp0"
color 0B
title PUSH CLXN - START

cls
echo ==================================================
echo             PUSH CLXN - START
echo ==================================================
echo.

where node >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Node.js not found.
  echo Install Node.js 18+ and run this file again.
  goto END
)

if not exist "%~dp0package.json" (
  echo [ERROR] package.json not found.
  echo Make sure START.bat is inside the PUSH_CLXN_CARD_CHECKOUT_READY folder.
  goto END
)

if not exist "%~dp0node_modules\express" (
  echo Installing packages... Please wait.
  call npm install
  if errorlevel 1 (
    echo.
    echo [ERROR] npm install failed.
    goto END
  )
)

if not exist "%~dp0.env" (
  copy /Y "%~dp0.env.example" "%~dp0.env" >nul
  echo Created .env
)

findstr /R /B /C:"STRIPE_SECRET_KEY=$" /C:"STRIPE_SECRET_KEY= *$" "%~dp0.env" >nul 2>&1
if not errorlevel 1 (
  echo.
  echo [SETUP] Stripe secret key is not configured.
  echo The key stays on this PC only and is never sent to the browser.
  call "%~dp0SETUP_STRIPE_KEY.bat"
)

set "PORT=3000"
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
echo.
echo [OK] Site:    http://localhost:%PORT%
echo [OK] Payment: http://localhost:%PORT%/payment.html
echo [OK] API:     http://localhost:%PORT%/api/status
echo.
echo This window will stay open.
echo Press Ctrl+C to stop the server.
echo.

start "PUSH CLXN Browser" /B cmd /c "timeout /t 2 /nobreak >nul & start http://localhost:%PORT%"

node server.js

if errorlevel 1 (
  echo.
  echo ==================================================
  echo [ERROR] PUSH CLXN stopped with an error.
  echo The error is shown above.
  echo ==================================================
) else (
  echo.
  echo PUSH CLXN was stopped.
)

goto END

:END
echo.
echo Press any key to close this window...
pause >nul
endlocal
