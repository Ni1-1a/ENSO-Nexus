@echo off
chcp 65001 >nul
title Enso-nexus - proverka
rem Только проверка: сервер, режим ИИ, LM Studio, туннель, внешние программы.
rem Ничего не запускает и не останавливает.
pwsh -NoProfile -ExecutionPolicy Bypass -File "%~dp0health.ps1"
if errorlevel 9009 echo PowerShell 7 ne nayden: winget install --id Microsoft.PowerShell
echo.
pause
