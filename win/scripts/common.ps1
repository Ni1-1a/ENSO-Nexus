# Общие функции запуска Enso-nexus на Windows.
# Подключается точкой из start.ps1 / stop.ps1 / restart.ps1 / watchdog.ps1 / health.ps1.
# Требуется PowerShell 7 (файлы без BOM, кириллица в комментариях).
#requires -Version 7.0

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8

# win\scripts → win → корень проекта
$script:AppRoot   = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$script:LogDir    = Join-Path $AppRoot 'logs'
$script:TunnelName = 'enso-nexus'

function Initialize-AppEnv {
    if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir | Out-Null }
}

# Порт берём из .env, чтобы проверки не разъезжались с настройками сервера.
function Get-AppPort {
    $envFile = Join-Path $AppRoot '.env'
    if (Test-Path $envFile) {
        $line = Select-String -Path $envFile -Pattern '^\s*PORT\s*=\s*(\d+)' | Select-Object -First 1
        if ($line) { return [int]$line.Matches[0].Groups[1].Value }
    }
    return 3000
}

function Get-PidFile([string]$name) { Join-Path $LogDir "$name.pid" }

function Get-SavedProcess([string]$name) {
    $file = Get-PidFile $name
    if (-not (Test-Path $file)) { return $null }
    $id = (Get-Content $file -Raw).Trim()
    if (-not $id) { return $null }
    return Get-Process -Id ([int]$id) -ErrorAction SilentlyContinue
}

# Журнал предыдущего запуска сохраняем: Start-Process пишет файл заново,
# и без этого причина падения исчезает вместе с рестартом.
function Move-OldLog([string]$path) {
    if (Test-Path $path) {
        $prev = [IO.Path]::ChangeExtension($path, $null) + '.prev.log'
        Move-Item -Path $path -Destination $prev -Force
    }
}

function Test-AppHealth([int]$TimeoutSec = 10) {
    $port = Get-AppPort
    try {
        $r = Invoke-WebRequest -Uri "http://127.0.0.1:$port/api/health" -UseBasicParsing -TimeoutSec $TimeoutSec
        return $r.StatusCode -eq 200
    } catch { return $false }
}

# Сколько прогонов сейчас в очереди или выполняется: остановка их прервёт.
function Get-BusyJobs {
    Push-Location $AppRoot
    try {
        $out = & node --env-file-if-exists=.env (Join-Path $PSScriptRoot 'busy-count.js') 2>$null
        return [int]($out | Select-Object -Last 1)
    } catch { return 0 } finally { Pop-Location }
}

function Start-AppServer {
    Initialize-AppEnv
    $out = Join-Path $LogDir 'server.log'
    $err = Join-Path $LogDir 'server.err.log'
    Move-OldLog $out ; Move-OldLog $err

    $p = Start-Process -FilePath 'node' `
        -ArgumentList '--env-file-if-exists=.env', 'server/index.js' `
        -WorkingDirectory $AppRoot -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput $out -RedirectStandardError $err
    $p.Id | Set-Content -Path (Get-PidFile 'server') -Encoding ascii
    return $p
}

function Start-AppTunnel([int]$WaitSec = 60) {
    Initialize-AppEnv
    $out = Join-Path $LogDir 'tunnel.log'
    $err = Join-Path $LogDir 'tunnel.err.log'
    Move-OldLog $out ; Move-OldLog $err

    $p = Start-Process -FilePath 'cloudflared' `
        -ArgumentList 'tunnel', 'run', $TunnelName `
        -WorkingDirectory $AppRoot -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput $out -RedirectStandardError $err
    $p.Id | Set-Content -Path (Get-PidFile 'tunnel') -Encoding ascii

    # cloudflared пишет ход подключения в stderr — смотрим оба файла
    for ($i = 0; $i -lt $WaitSec; $i++) {
        Start-Sleep -Seconds 1
        foreach ($f in @($out, $err)) {
            if ((Test-Path $f) -and (Select-String -Path $f -Pattern 'Registered tunnel connection' -Quiet)) {
                return $true
            }
        }
        if ($p.HasExited) { return $false }
    }
    return $false
}

function Stop-Saved([string]$name) {
    $proc = Get-SavedProcess $name
    if ($proc) {
        try { Stop-Process -Id $proc.Id -Force -ErrorAction Stop } catch { }
        Write-Host "  остановлен $name (PID $($proc.Id))"
    }
    Remove-Item (Get-PidFile $name) -ErrorAction SilentlyContinue
}

function Stop-All {
    foreach ($n in @('watchdog', 'server', 'tunnel')) { Stop-Saved $n }
}
