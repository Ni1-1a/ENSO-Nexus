@echo off
chcp 65001 >nul
title Enso-nexus - perezapusk
rem Полный перезапуск. Нужен после правок .env - сервер читает его на старте.
rem Идущий анализ будет прерван, скрипт об этом предупредит.
pwsh -NoProfile -ExecutionPolicy Bypass -File "%~dp0restart.ps1"
if errorlevel 9009 echo PowerShell 7 ne nayden: winget install --id Microsoft.PowerShell
echo.
pause
