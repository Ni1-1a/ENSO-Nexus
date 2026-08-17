# Надзор за сервером и туннелем. Запускается из start.ps1, отдельно не нужен.
#
# Логика та же, что в scripts/serve-public.sh на маке: сервер перезапускается
# только после ДВУХ подряд неудачных проверок — под нагрузкой (загрузка модели,
# распознавание сканов) машина может коротко «замирать», и рестарт по первой
# осечке убил бы идущий анализ.
#requires -Version 7.0
param(
    [switch]$NoTunnel,
    [int]$IntervalSec = 60
)

. "$PSScriptRoot\common.ps1"
Initialize-AppEnv
$log = Join-Path $LogDir 'watchdog.log'

function Write-Log([string]$msg) {
    "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $msg" | Add-Content -Path $log -Encoding utf8
}

Write-Log 'надзор запущен'
$serverFails = 0

while ($true) {
    Start-Sleep -Seconds $IntervalSec

    if (Test-AppHealth 10) {
        $serverFails = 0
    } else {
        $serverFails++
        if ($serverFails -ge 2) {
            Write-Log "сервер недоступен ($serverFails проверки) — перезапуск"
            Stop-Saved 'server'
            Start-AppServer | Out-Null
            $serverFails = 0
            Start-Sleep -Seconds 8
        }
    }

    # Именной туннель сам держит четыре резервных соединения, поэтому чиним
    # только мёртвый процесс. Проверка по внешнему адресу здесь была бы вредна:
    # задержка DNS или сети убивала бы живой туннель.
    if (-not $NoTunnel) {
        if (-not (Get-SavedProcess 'tunnel')) {
            Write-Log 'процесс туннеля умер — перезапуск'
            if (Start-AppTunnel 60) { Write-Log 'туннель поднят' } else { Write-Log 'туннель поднять не удалось' }
        }
    }
}
