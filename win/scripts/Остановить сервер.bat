@echo off
chcp 65001 >nul
title Enso-nexus - ostanovka
rem Полная остановка: платформа станет недоступна, пока не запустите снова.
pwsh -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop.ps1"
if errorlevel 9009 echo PowerShell 7 ne nayden: winget install --id Microsoft.PowerShell
echo.
pause
