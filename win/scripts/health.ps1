# Быстрая проверка состояния: сервер, режим ИИ, локальная модель, туннель,
# внешние программы. Ничего не запускает и не останавливает.
#
#   pwsh -File win\scripts\health.ps1
#requires -Version 7.0

. "$PSScriptRoot\common.ps1"
Initialize-AppEnv
$port = Get-AppPort

function Show([string]$name, [bool]$ok, [string]$note = '') {
    $mark = if ($ok) { '  OK  ' } else { ' НЕТ  ' }
    Write-Host ("[{0}] {1}{2}" -f $mark, $name, $(if ($note) { " — $note" } else { '' }))
}

# Строгий режим считает обращение к несуществующему полю ошибкой, а состав
# ответа /api/health со временем меняется — читаем поля через проверку.
function Get-Prop($obj, [string]$name) {
    if ($null -eq $obj) { return $null }
    if ($obj.PSObject.Properties.Name -contains $name) { return $obj.$name }
    return $null
}

Write-Host "Проект: $AppRoot"
Write-Host ''

# ── Сервер ────────────────────────────────────────────────────────────────
$health = $null
try { $health = Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/health" -TimeoutSec 10 } catch { }
Show "сервер на :$port" ($null -ne $health)

if ($health) {
    $mode = Get-Prop $health 'aiMode'
    $model = Get-Prop $health 'model'
    Show 'режим ИИ' ($mode -ne 'mock') "$mode$(if ($model) { " ($model)" })"
    $kb = Get-Prop $health 'kb'
    if ($kb) { Show 'база знаний' ([bool](Get-Prop $kb 'enabled')) ($kb | ConvertTo-Json -Compress -Depth 3) }
}

# ── Локальная модель ──────────────────────────────────────────────────────
$lm = $null
try { $lm = Invoke-RestMethod -Uri 'http://localhost:1234/v1/models' -TimeoutSec 5 } catch { }
$lmModels = Get-Prop $lm 'data'
Show 'LM Studio на :1234' ($null -ne $lm) $(if ($lmModels) { "моделей: $($lmModels.Count)" } else { 'сервер не отвечает' })

# ── Туннель ───────────────────────────────────────────────────────────────
$tunnelProc = Get-SavedProcess 'tunnel'
$svc = Get-Service -Name 'cloudflared' -ErrorAction SilentlyContinue
$registered = $false
foreach ($f in @('tunnel.log', 'tunnel.err.log')) {
    $p = Join-Path $LogDir $f
    if ((Test-Path $p) -and (Select-String -Path $p -Pattern 'Registered tunnel connection' -Quiet)) { $registered = $true }
}
Show 'процесс туннеля' ($null -ne $tunnelProc -or ($null -ne $svc -and $svc.Status -eq 'Running')) `
    $(if ($svc) { "служба cloudflared: $($svc.Status)" } else { 'запущен скриптом' })
Show 'соединения зарегистрированы' $registered 'по журналу туннеля'

# ── Внешние программы ─────────────────────────────────────────────────────
Write-Host ''
foreach ($bin in @('node', 'cloudflared', 'pdfinfo', 'pdftoppm', 'pdftotext', 'dwg2dxf', 'dxf2dwg', 'lms')) {
    $found = Get-Command $bin -ErrorAction SilentlyContinue
    Show $bin ($null -ne $found) $(if ($found) { $found.Source } else { 'не найдено в PATH' })
}

# ── Занятость ─────────────────────────────────────────────────────────────
Write-Host ''
Write-Host "Прогонов в очереди или в работе: $(Get-BusyJobs)"
Write-Host ''
Write-Host 'Внешний адрес проверяется ТОЛЬКО снаружи — с телефона по мобильному интернету:'
Write-Host '  https://enso-nexus.com/api/health'
