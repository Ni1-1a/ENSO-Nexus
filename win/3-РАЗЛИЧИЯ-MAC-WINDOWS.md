# 3. Что завязано на macOS и что с этим делать

Сам сервер написан переносимо: пути везде через `path.join`, внешние программы
вызываются `execFile` без shell, база — встроенный `node:sqlite`, нативных
зависимостей в `package.json` нет. Ломается ровно то, где в код вписаны пути
Homebrew и команды macOS. Ниже — полный список, каждый пункт проверен чтением
кода, а не по памяти.

## Сводка

| Место | Что на маке | На Windows | Нужен ли патч |
|---|---|---|---|
| `server/services/model-manager.js:16` | `lms` по путям Homebrew, без расширения | `lms.exe` в профиле пользователя | **да, обязательно** |
| `server/services/doc-vision.js:29` | poppler в `/opt/homebrew/bin` | `pdfinfo.exe` и др. из PATH | нет, но полезно |
| `server/services/cad.js:19` | `dwg2dxf` в `/opt/homebrew/bin` | `dwg2dxf.exe` из PATH | нет, но полезно |
| `server/services/cad/acad-bridge.js` | AppleScript, `osascript`, `pgrep`, AutoCAD for Mac | нет аналога | нет, выключить `ACAD_ENABLED=0` |
| `scripts/serve-public.sh` | `caffeinate`, `cloudflared`, watchdog на bash | `win/scripts/start.ps1` | заменено |
| `Перезапуск/*.command` | двойной клик в Finder | `win/scripts/*.bat` | заменено |
| `scripts/kb-ocr-queue.sh`, `update-public-link.sh` | обслуживание базы знаний и GitHub Pages | запускать с мака | не переносить |
| `model-manager.js:23` | бюджет памяти = 72 % общей (у мака память единая) | RAM ≠ VRAM, бюджет соврёт | нет, но см. п. 5 |

## 1. `lms` не находится — обязательный патч

`server/services/model-manager.js`, строки 16–20:

```js
const LMS_CANDIDATES = [
  path.join(os.homedir(), '.cache', 'lm-studio', 'bin', 'lms'),
  '/opt/homebrew/bin/lms',
  '/usr/local/bin/lms',
];
```

На Windows файл называется `lms.exe` и лежит в другом месте — ни один кандидат
не совпадёт и `findLms()` вернёт `null`. Падения не будет: `ensureLoaded()` в
этом случае честно возвращает `{ok:true, managed:false}` («нет CLI — надеемся
на JIT»), а `unload()` — «нет CLI lms». То есть отказ тихий и обидный: пропадает
ровно то, ради чего менеджер писался — загрузка с нужным контекстом и осознанная
выгрузка соседней модели. Анализ пойдёт на том, что LM Studio догрузит сама и с
тем окном, которое выберет сама; исторически это и давало ошибки 400 «Model
unloaded».

Заменить на:

```js
const LMS_EXE = process.platform === 'win32' ? 'lms.exe' : 'lms';
const LMS_CANDIDATES = [
  process.env.LMS_PATH || '',                                        // явный путь из .env, если понадобится
  path.join(os.homedir(), '.lmstudio', 'bin', LMS_EXE),              // Windows и свежие сборки LM Studio
  path.join(os.homedir(), '.cache', 'lm-studio', 'bin', LMS_EXE),
  '/opt/homebrew/bin/lms',
  '/usr/local/bin/lms',
].filter(Boolean);
```

`findLms()` менять не нужно: он перебирает список через `fs.accessSync(p, X_OK)`,
а на Windows это фактически проверка существования файла.

Проверка после патча — не «сервер поднялся», а вот это:

```powershell
node -e "console.log(require('./server/services/model-manager').constructor ? 'модуль загружен' : '')"
& "$env:USERPROFILE\.lmstudio\bin\lms.exe" ps
```

и дальше настоящий прогон анализа: в логе сервера должны появиться события
загрузки модели с нужным контекстом, а не тишина.

## 2. poppler — работает и без патча

`server/services/doc-vision.js`, строка 29:

```js
const POPPLER_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', ''];
```

Последний кандидат — пустая строка, то есть «просто имя программы». Node на
Windows ищет её в PATH и сам подставляет `.exe`. Значит, если poppler добавлен
в PATH, всё работает как есть.

Патч полезен, только чтобы не зависеть от PATH (например, когда сервер запущен
службой с урезанным окружением):

```js
const POPPLER_DIRS = [process.env.POPPLER_DIR || '', '/opt/homebrew/bin', '/usr/local/bin', ''];
```

и в `.env`: `POPPLER_DIR=C:\Tools\poppler\Library\bin`.

Отказ здесь тоже тихий и дорогой: без `pdfinfo` число страниц не читается,
и от 17-страничного скана ГПЗУ распознается ровно первая страница. В коде на
этот счёт уже стоит защита (`pdfPageCount` бросает исключение вместо «одной
страницы»), но проверять всё равно надо прогоном по настоящему сканy.

## 3. LibreDWG — работает и без патча

`server/services/cad.js`, строка 19 — та же схема: два пути Homebrew, затем
`return 'dwg2dxf'` в расчёте на PATH. `dxf2dwg` в `acad-bridge.js` вызывается
сразу по имени. Достаточно положить обе программы в PATH.

Если хочется явности:

```js
const DWG2DXF_CANDIDATES = [process.env.DWG2DXF_PATH || '', '/opt/homebrew/bin/dwg2dxf', '/usr/local/bin/dwg2dxf'].filter(Boolean);
```

Без LibreDWG платформа не падает: DWG на входе не читается (человек получает
внятную ошибку), а на выходе отдаётся DXF — и в примечаниях к результату это
сказано.

## 4. Мост AutoCAD — только macOS

`server/services/cad/acad-bridge.js` целиком построен на AppleScript: команда
`CLAUDE-PUMP` вводится в окно AutoCAD через `osascript`, наличие приложения
проверяется через `pgrep`, раскладка клавиатуры читается через `defaults`.
Ни одной из этих программ на Windows нет.

Падения не будет — `probe()` вернёт «приложение не запущено», и выгрузка
уйдёт на запасной путь (конвертер LibreDWG). Но правильнее выключить мост явно,
чтобы не тратить время на попытку и не пугать примечаниями:

```ini
ACAD_ENABLED=0
```

Что теряется: настоящий DWG, собранный самим AutoCAD. Остаётся DXF (пишется
своим кодом, `cad/dxf-writer.js`) и DWG от конвертера LibreDWG — он помечается
в примечаниях как «(конвертер)».

На будущее: у AutoCAD для Windows есть `accoreconsole.exe` — консольный движок,
который выполняет скрипты без окна. Это принципиально более надёжный путь, чем
AppleScript-мост на маке, но это отдельная работа, а не часть переноса.

## 5. Бюджет памяти под модели

`model-manager.js:23`:

```js
const MEMORY_BUDGET_BYTES = Math.round(os.totalmem() * 0.72);
```

У мака память единая: 72 % от 48 ГБ — это реально доступно видеоядру. На Windows
`os.totalmem()` — это оперативная память, а модель живёт в VRAM видеокарты.
Расчёт получится оптимистичным: сервер решит, что вторая модель помещается,
LM Studio начнёт выгружать слои в оперативную память, и анализ упрётся в таймаут
вместо честного отказа.

Патчить не обязательно — достаточно двух настроек в `.env`:

```ini
LOCAL_AI_EXCLUSIVE=1      # одна модель за раз: загрузилась → отработала → выгрузилась
LOCAL_AI_CONTEXT=32768    # подобрать под VRAM замером, см. 4-ЧЕКЛИСТ.md п. 7
```

## 6. Мелочи, на которых легко потерять час

**Переводы строк.** Git на Windows по умолчанию превращает LF в CRLF, и обратный
коммит в тот же репозиторий приходит «изменены все файлы». Один раз:

```powershell
git config --global core.autocrlf false
```

**Кодировка консоли.** Логи и вывод сервера — UTF-8. `cmd.exe` по умолчанию
показывает их кракозябрами; PowerShell 7 — нормально. В `.bat`-обёртках уже
стоит `chcp 65001`. Читать логи: `Get-Content logs\server.log -Tail 50 -Encoding UTF8`.

**`npm test`.** В `package.json` стоит `node --test tests/*.test.js`. Шаблон
раскрывает shell, а `cmd.exe` этого не делает. Если тесты не находятся —
запускать `node --test tests\` (папкой); при желании так же можно поправить и
сам скрипт — на маке это тоже работает.

**PATH подхватывается только новыми процессами.** После добавления poppler или
LibreDWG в PATH окно PowerShell нужно открыть заново, иначе `pdfinfo -v` будет
говорить «не найдено» на правильно настроенной системе.

**Кавычки в путях.** Проект на маке лежит по пути с пробелом (`Pilot 1/Web`).
На Windows его стоит положить в `C:\Enso\web` — не из-за ограничений, а чтобы
не тащить в каждую команду кавычки.
