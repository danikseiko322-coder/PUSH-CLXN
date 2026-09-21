@echo off
setlocal
cd /d "%~dp0"
echo PUSH CLXN - проверка оплаты
echo.
if not exist ".env" (
  echo [ERROR] .env не найден.
  goto END
)
findstr /B "STRIPE_SECRET_KEY=" ".env"
echo.
echo Проверяю сервер...
where node >nul 2>&1 || (echo [ERROR] Node.js не найден.&goto END)
if not exist "node_modules\express" call npm install
start "" cmd /c "node server.js"
timeout /t 2 /nobreak >nul
echo.
echo Открой в браузере: http://localhost:3000/api/status
echo.
:END
pause
endlocal
