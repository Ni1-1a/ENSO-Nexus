# Запуск Enso-nexus на Windows: сервер + туннель Cloudflare + watchdog.
# Аналог scripts/serve-public.sh с мака.
#
#   pwsh -File win\scripts\start.ps1                # всё вместе
#   pwsh -File win\scripts\start.ps1 -NoTunnel      # туннель поднимает служба cloudflared
#   pwsh -File win\scripts\start.ps1 -NoWatchdog    # без надзора (для отладки)
#requires -Version 7.0
param(
    [switch]$NoTunnel,
    [switch]$NoWatchdog
)

. "$PSScriptRoot\common.ps1"
Initialize-AppEnv

$port = Get-AppPort
Write-Host '════════════════════════════════════════════════'
Write-Host '  Enso-nexus — запуск'
Write-Host '════════════════════════════════════════════════'

if (Test-AppHealth 5) {
    Write-Host "Уже запущено: http://localhost:$port"
    Write-Host 'Полный перезапуск — restart.ps1'
    exit 0
}

# ── Сервер ────────────────────────────────────────────────────────────────
Write-Host 'Сервер…' -NoNewline
$srv = Start-AppServer
$ok = $false
for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Seconds 1
    if (Test-AppHealth 3) { $ok = $true; break }
    if ($srv.HasExited) { break }
}
if (-not $ok) {
    Write-Host ' не поднялся.'
    Write-Host 'Причина — в первых строках logs\server.err.log:'
    Get-Content (Join-Path $LogDir 'server.err.log') -Tail 20 -ErrorAction SilentlyContinue
    exit 1
}
Write-Host " http://localhost:$port"

# Режим ИИ виден в /api/health: mock — это заглушка, людям её показывать нельзя.
try {
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/health" -TimeoutSec 10
    Write-Host "Режим ИИ: $($health.aiMode)"
    if ($health.aiMode -eq 'mock') {
        Write-Host 'ВНИМАНИЕ: mock — ни ключа API, ни LM Studio не видно. Это заглушка.'
    }
} catch { }

# ── Туннель ───────────────────────────────────────────────────────────────
if ($NoTunnel) {
    Write-Host 'Туннель: пропущен (-NoTunnel) — считаем, что его держит служба cloudflared.'
} else {
    Write-Host 'Туннель…' -NoNewline
    if (Start-AppTunnel 60) {
        Write-Host ' подключён: https://enso-nexus.com'
    } else {
        Write-Host ' не подключился.'
        Write-Host 'Смотреть logs\tunnel.err.log. Частые причины:'
        Write-Host '  • туннель уже поднят на маке или службой на этой машине;'
        Write-Host '  • сеть режет соединение с краем Cloudflare (порт 7844) — см. win\2-СЕТЬ-И-HAPP.md;'
        Write-Host '  • в config.yml остался путь к ключу от мака.'
    }
}

# ── Watchdog ──────────────────────────────────────────────────────────────
if (-not $NoWatchdog) {
    $wdArgs = @('-NoProfile', '-WindowStyle', 'Hidden', '-File', "$PSScriptRoot\watchdog.ps1")
    if ($NoTunnel) { $wdArgs += '-NoTunnel' }
    $wd = Start-Process -FilePath 'pwsh' -ArgumentList $wdArgs -WindowStyle Hidden -PassThru
    $wd.Id | Set-Content -Path (Get-PidFile 'watchdog') -Encoding ascii
    Write-Host 'Надзор запущен: проверка раз в минуту, перезапуск после двух неудач подряд.'
}

Write-Host ''
Write-Host 'Журналы: logs\server.log, logs\tunnel.log, logs\watchdog.log'
Write-Host 'Остановка: win\scripts\stop.ps1'
