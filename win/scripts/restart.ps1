# Полный перезапуск: сервер + туннель + надзор.
# Нужен в основном после правок .env — сервер читает его только на старте.
#
#   pwsh -File win\scripts\restart.ps1 [-NoTunnel] [-Force]
#requires -Version 7.0
param(
    [switch]$NoTunnel,
    [switch]$Force
)

. "$PSScriptRoot\common.ps1"
Initialize-AppEnv

Write-Host '════════════════════════════════════════════════'
Write-Host '  Enso-nexus — перезапуск'
Write-Host '════════════════════════════════════════════════'

if (-not $Force) {
    $busy = Get-BusyJobs
    if ($busy -gt 0) {
        Write-Host "Сейчас выполняется задач: $busy — перезапуск их ПРЕРВЁТ."
        $answer = Read-Host 'Всё равно перезапустить? (да/нет)'
        if ($answer -notmatch '^(да|д|y|yes)$') { Write-Host 'Отменено.'; exit 0 }
    }
}

Stop-All
Start-Sleep -Seconds 2

$startArgs = @('-NoProfile', '-File', "$PSScriptRoot\start.ps1")
if ($NoTunnel) { $startArgs += '-NoTunnel' }
& pwsh @startArgs
