@echo off
chcp 65001 >nul
title Enso-nexus - zapusk
rem Двойной клик по этому файлу запускает сервер, туннель и надзор.
rem Весь вывод печатает start.ps1 - он работает с UTF-8 без оговорок.
pwsh -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1"
if errorlevel 9009 echo PowerShell 7 ne nayden: winget install --id Microsoft.PowerShell
echo.
pause
