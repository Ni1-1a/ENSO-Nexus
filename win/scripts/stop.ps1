# Полная остановка Enso-nexus: надзор, сервер, туннель.
# После этого платформа недоступна и снаружи, и локально.
#
#   pwsh -File win\scripts\stop.ps1          # спросит, если идёт анализ
#   pwsh -File win\scripts\stop.ps1 -Force   # без вопросов
#requires -Version 7.0
param([switch]$Force)

. "$PSScriptRoot\common.ps1"
Initialize-AppEnv

if (-not $Force) {
    $busy = Get-BusyJobs
    if ($busy -gt 0) {
        Write-Host "Сейчас выполняется задач: $busy — остановка их ПРЕРВЁТ."
        $answer = Read-Host 'Всё равно остановить? (да/нет)'
        if ($answer -notmatch '^(да|д|y|yes)$') { Write-Host 'Отменено.'; exit 0 }
    }
}

Write-Host 'Останавливаю:'
Stop-All
Write-Host 'Остановлено.'
