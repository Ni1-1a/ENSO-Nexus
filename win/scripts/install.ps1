# Подготовка Windows-машины: проверка и установка того, на что опирается сервер.
#
#   pwsh -File win\scripts\install.ps1              # проверить и доустановить через winget
#   pwsh -File win\scripts\install.ps1 -CheckOnly   # только проверить, ничего не ставить
#
# Что ставится через winget: PowerShell 7, Node LTS, Git, cloudflared.
# Что ставится руками (готовых пакетов может не быть): poppler, LibreDWG, LM Studio —
# скрипт скажет, чего не хватает и откуда брать.
#requires -Version 7.0
param([switch]$CheckOnly)

. "$PSScriptRoot\common.ps1"

$missing = @()

function Test-Bin([string]$name, [string]$hint) {
    $cmd = Get-Command $name -ErrorAction SilentlyContinue
    if ($cmd) {
        Write-Host "[  OK  ] $name — $($cmd.Source)"
        return $true
    }
    Write-Host "[ НЕТ  ] $name — $hint"
    $script:missing += $name
    return $false
}

function Install-Winget([string]$id, [string]$title) {
    if ($CheckOnly) { Write-Host "        поставить: winget install --id $id"; return }
    Write-Host "        ставлю $title…"
    winget install --id $id --accept-source-agreements --accept-package-agreements
}

Write-Host '════════════════════════════════════════════════'
Write-Host '  Enso-nexus — подготовка Windows'
Write-Host '════════════════════════════════════════════════'
Write-Host "Проект: $AppRoot"
Write-Host ''

# ── Базовое ───────────────────────────────────────────────────────────────
if (-not (Test-Bin 'winget' 'установщик пакетов Windows — без него всё ставится вручную')) { }
if (-not (Test-Bin 'git' 'winget install --id Git.Git')) { Install-Winget 'Git.Git' 'Git' }
if (-not (Test-Bin 'node' 'winget install --id OpenJS.NodeJS.LTS')) { Install-Winget 'OpenJS.NodeJS.LTS' 'Node.js LTS' }
if (-not (Test-Bin 'cloudflared' 'winget install --id Cloudflare.cloudflared')) { Install-Winget 'Cloudflare.cloudflared' 'cloudflared' }

# Версия Node важна не сама по себе: база лежит на встроенном node:sqlite,
# а он до Node 23.4 требовал экспериментального флага.
if (Get-Command node -ErrorAction SilentlyContinue) {
    Write-Host ''
    Write-Host "Node: $(node -v)"
    & node -e "require('node:sqlite')" 2>$null
    if ($LASTEXITCODE -eq 0) {
        Write-Host '[  OK  ] node:sqlite доступен без флагов'
    } else {
        Write-Host '[ НЕТ  ] node:sqlite недоступен — нужен Node 24 LTS или новее'
        $missing += 'node:sqlite'
    }
}

# ── Внешние программы, которые сервер вызывает ────────────────────────────
Write-Host ''
Test-Bin 'pdfinfo'  'poppler: https://github.com/oschwartz10612/poppler-windows/releases → C:\Tools\poppler\Library\bin в PATH' | Out-Null
Test-Bin 'pdftoppm' 'из того же архива poppler' | Out-Null
Test-Bin 'dwg2dxf'  'LibreDWG: https://github.com/LibreDWG/libredwg/releases (сборка win64) → C:\Tools\libredwg\bin в PATH' | Out-Null
Test-Bin 'dxf2dwg'  'из того же архива LibreDWG' | Out-Null

$lms = Join-Path $env:USERPROFILE '.lmstudio\bin\lms.exe'
if (Test-Path $lms) {
    Write-Host "[  OK  ] lms — $lms"
} else {
    Write-Host '[ НЕТ  ] lms — поставить LM Studio (https://lmstudio.ai), затем: & "$env:USERPROFILE\.lmstudio\bin\lms.exe" bootstrap'
    $missing += 'lms'
}

# ── Зависимости проекта ───────────────────────────────────────────────────
if (-not $CheckOnly -and (Get-Command npm -ErrorAction SilentlyContinue)) {
    Write-Host ''
    Write-Host 'npm ci…'
    Push-Location $AppRoot
    try {
        npm ci
        Write-Host 'Chromium для Playwright…'
        npx playwright install chromium
    } finally { Pop-Location }
}

# ── Данные и секреты ──────────────────────────────────────────────────────
Write-Host ''
foreach ($item in @(
    @{ path = '.env';        note = 'скопировать с мака и поправить пути (см. win\env.windows.example)' },
    @{ path = 'users.json';  note = 'скопировать с мака — без него в платформу никто не войдёт' },
    @{ path = 'data';        note = 'скопировать с мака при остановленном сервере (вместе с app.db-wal и app.db-shm)' },
    @{ path = 'node_modules'; note = 'ставится командой npm ci' }
)) {
    $p = Join-Path $AppRoot $item.path
    if (Test-Path $p) { Write-Host "[  OK  ] $($item.path)" }
    else { Write-Host "[ НЕТ  ] $($item.path) — $($item.note)"; $missing += $item.path }
}

$cf = Join-Path $env:USERPROFILE '.cloudflared\config.yml'
if (Test-Path $cf) {
    Write-Host "[  OK  ] $cf"
    $cred = Select-String -Path $cf -Pattern '^\s*credentials-file:\s*(.+)$'
    if ($cred) {
        $credPath = $cred.Matches[0].Groups[1].Value.Trim()
        if ($credPath -like '/Users/*') {
            Write-Host "[ НЕТ  ] в config.yml остался путь от мака: $credPath"
            $missing += 'credentials-file'
        } elseif (-not (Test-Path $credPath)) {
            Write-Host "[ НЕТ  ] ключ туннеля не найден: $credPath"
            $missing += 'credentials-file'
        } else {
            Write-Host "[  OK  ] ключ туннеля: $credPath"
        }
    }
} else {
    Write-Host "[ НЕТ  ] $cf — скопировать из ~/.cloudflared с мака"
    $missing += 'cloudflared config'
}

# ── Итог ──────────────────────────────────────────────────────────────────
Write-Host ''
if ($missing.Count -eq 0) {
    Write-Host 'Всё на месте. Запуск: pwsh -File win\scripts\start.ps1'
} else {
    Write-Host "Не хватает: $($missing -join ', ')"
    Write-Host 'Подробности по каждому пункту — win\1-ПЕРЕНОС.md'
}
