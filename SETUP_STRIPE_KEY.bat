@echo off
setlocal EnableExtensions
cd /d "%~dp0"
color 0B
title PUSH CLXN - Stripe key setup

echo ==================================================
echo          PUSH CLXN - STRIPE KEY SETUP
echo ==================================================
echo.
echo Откроется файл stripe-key.txt.
echo Вставь ВЕСЬ секретный ключ ОДНИМ Ctrl+V, сохрани и закрой файл.
echo Не отправляй ключ в Telegram, Discord или чат.
echo.
start /wait "" notepad.exe "%~dp0stripe-key.txt"

powershell -NoProfile -ExecutionPolicy Bypass -Command "$p=Join-Path (Get-Location) 'stripe-key.txt'; $raw=Get-Content -Raw -LiteralPath $p; $key=($raw -split '\r?\n' | Where-Object {$_ -and $_ -notmatch '^\s*#'} | Select-Object -First 1).Trim(); if(-not ($key -match '^(sk|rk)_(live|test)_[A-Za-z0-9]+$')) { Write-Host 'Ошибка: в stripe-key.txt не найден полный Stripe Secret Key.' -ForegroundColor Red; exit 1 }; $envPath=Join-Path (Get-Location) '.env'; $lines=@(); if(Test-Path $envPath){$lines=Get-Content $envPath}; if($lines -match '^STRIPE_SECRET_KEY='){ $lines=$lines -replace '^STRIPE_SECRET_KEY=.*$',('STRIPE_SECRET_KEY='+$key) } else { $lines += ('STRIPE_SECRET_KEY='+$key) }; if($lines -match '^SHOP_CURRENCY='){ $lines=$lines -replace '^SHOP_CURRENCY=.*$','SHOP_CURRENCY=rub' } else { $lines += 'SHOP_CURRENCY=rub' }; Set-Content -LiteralPath $envPath -Value $lines -Encoding UTF8; Set-Content -LiteralPath $p -Value '# Ключ сохранён в .env. Не удаляй файл, если хочешь хранить копию локально.' -Encoding UTF8; Write-Host 'Готово: полный ключ сохранён в .env, валюта RUB.' -ForegroundColor Green"
if errorlevel 1 pause & exit /b 1

echo.
echo Теперь можно запускать START.bat
pause
endlocal
