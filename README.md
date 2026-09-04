# Enso-nexus

Платформа для проектировщика: анализ исходных данных и посадка здания на
земельный участок (генплан по ГОСТ 21.508-2020), проверка заданий и документов,
нормоконтроль, входной контроль ГГЭ, черновики актов. Всё — веб-приложение на
Node.js без сборки фронтенда.

## Проект → модуль

Сначала заводится **проект платформы**, потом внутри него выбирается модуль.
Модули стоят в порядке надобности проекту:

1. Анализ ТЗ — задание на проектирование по чек-листу;
2. Посадка здания — исходные данные, план участка, зоны ограничений, варианты, чертёж;
3. Проверка документа — автоподбор промпта из библиотеки, сравнение редакций «A → B»;
4. Нормоконтроль — версии разделов, правила, заключение (своя база PostgreSQL);
5. Контроль ГГЭ — реквизиты, форматы и текстовый слой комплекта перед подачей;
6. Акты (АОСР) — черновики из реестра и шаблона, сверка дат с журналом.

Проект — единица работы: сущности модулей привязаны к нему колонкой
`project_id`, список проектов со сводкой по модулям отдаёт `GET /api/projects`.
Всё, что заведено до появления проектов, лежит в проекте «Ранние работы».
Датасет, статистика и настройки — свойства платформы, живут вне проекта.

В «Настройки → Вид» четыре вида одного и того же интерфейса: **A** «Досье»,
**B** «Стол проекта» (по умолчанию), **C** «Лента», **D** «Штамп». DOM один,
переключается атрибут `html[data-view]`, раскладку делает `public/shell.css`.

## Структура

```
enso-platform/
├── server/
│   ├── index.js             # точка входа: проба LM Studio, listen(PORT, BIND_HOST)
│   ├── app.js               # сборка Express-приложения, монтирование роутеров, очистка сессий
│   ├── config.js            # вся конфигурация из переменных окружения (единая точка)
│   ├── db.js                # SQLite (node:sqlite): сессии, сообщения, файлы, факты, результаты
│   ├── middleware/          # rate limit, токен сессии, токен человека, заголовки, ошибки
│   ├── routes/              # api.js (вход, сессии, статистика), projects.js, tz.js, doccheck.js,
│   │                        # normo.js, gge.js, akty.js, dataset.js — по роутеру на модуль
│   └── services/
│       ├── ai/              # реестр провайдеров и возможностей, Gemini, GigaChat, доступ к облаку
│       ├── claude/          # адаптер ко всем моделям, память сессии, схема ответа, проверяющий
│       ├── geometry/        # участок, ограничения, зоны, посадка, варианты, отчёт (JSTS)
│       ├── cad/             # спецификация чертежа, DXF-писатель, мост к AutoCAD
│       ├── projects.js      # проекты платформы и сводка по модулям
│       ├── tz/ doccheck/ akty/ gge/ dataset/ normo/   # службы модулей
│       ├── kb.js            # RAG по базе знаний (эмбеддинги LM Studio)
│       ├── doc-vision.js    # распознавание сканов: poppler + vision-модель
│       ├── pipeline.js      # оркестрация анализа, прогресс, события
│       └── prompts.js       # чтение текстов промтов из prompts/*.md (единственное место)
├── prompts/                 # ВСЕ тексты, уходящие модели, — в коде их нет (карта — prompts/README.md)
├── public/                  # фронтенд: index.html + tz/doccheck/normo/gge/akty.html, без сборки
│   ├── shell.js, shell.css  # общий каркас страниц: навигация по модулям, четыре вида
│   ├── hub.js, boot.js, auth.js   # главная, тема и вид до отрисовки, вход
│   └── app.js, viewer.js, …       # посадка здания, SVG-вьювер плана
├── библиотека-промптов/     # промпты канала @ai_prompt_eng для «Проверки документа» (не prompts/)
├── нормоконтроль/           # база знаний модуля: правила, шаблон заключения, реестр НТД
├── scripts/                 # публикация (serve-public.sh), индексация базы знаний, LISP для AutoCAD
├── tests/                   # unit / API / e2e (node:test)
├── Dockerfile, render.yaml  # контейнер и blueprint для Render.com
└── .env.example             # шаблон переменных окружения
```

## Стек

- **Backend:** Node.js ≥ 22.13, CommonJS, Express 5, встроенный `node:sqlite`,
  multer (загрузка), adm-zip (архивы, чтение DOCX/XLSX), js-yaml, JSTS
  (планарная геометрия), pg (только нормоконтроль), Playwright (SVG → PNG,
  HTML → PDF комплекта), `@anthropic-ai/sdk`, `@google/genai`, undici.
- **Frontend:** семантический HTML + CSS + vanilla JS, без фреймворка и без шага
  сборки. Шрифты системные: SF Pro Text для текста, New York для заголовков,
  SF Mono для кода (запасные — Helvetica Neue / Segoe UI, Georgia, Menlo).
- **Внешние бинарники:** `pdftotext`/`pdftoppm` (poppler), `dwg2dxf`/`dxf2dwg`
  (LibreDWG) — через `execFile`, без shell.
- **AI:** режим выбирается автоматически (`AI_PROVIDER=auto`):
  1. **anthropic** — Claude через официальный API (`claude-opus-5`) при наличии `ANTHROPIC_API_KEY`;
  2. **local** — LM Studio по OpenAI-совместимому API (`http://localhost:1234/v1`):
     по умолчанию `qwen/qwen3.8-27b` для анализа и `qwen/qwen3-vl-30b` для
     распознавания сканов, structured output через `response_format: json_schema`;
  3. **mock** — помеченная демо-заглушка, если недоступны оба.

## Установка и локальный запуск

```bash
cd ENSO-Nexus/enso-platform
npm ci                      # или npm install
cp .env.example .env        # заполнить ключи; без них — локальная модель или демо
npm start                   # http://localhost:3000
```

`npm start` поднимает и backend, и frontend (статика отдаётся тем же сервером).
Для разработки — `npm run dev` (перезапуск при изменениях). Переменные читает
сам Node (`--env-file-if-exists=.env`), поэтому нужен Node 22.9 и новее.

Сервер слушает только `127.0.0.1` (`BIND_HOST`): наружу его выпускает
`scripts/serve-public.sh` через именной туннель Cloudflare — см. [DEPLOYMENT.md](DEPLOYMENT.md).

## Вход и люди

Вход по «Фамилия Имя», без пароля. Список людей — `users.json` в корне (создаётся
при первом старте, в git не попадает): режим регистрации `free`/`approval`, флаги
`approved`, `cloudAi`, `dataset`, `owner`, `statsAll`. Токен человека уходит в
заголовке `X-User-Token`, токен сессии посадки — в `Authorization: Bearer`.
`REQUIRE_LOGIN=0` выключает вход на время отладки.

## Переменные окружения

Полный список с умолчаниями — в [.env.example](.env.example) и
[server/config.js](server/config.js). Ключевые:

| Переменная | Назначение |
|---|---|
| `PORT`, `BIND_HOST`, `TRUST_PROXY` | порт, интерфейс (`127.0.0.1`), кому верить в `X-Forwarded-For` (`loopback`) |
| `AI_PROVIDER` | `auto` (по умолчанию) / `anthropic` / `local` / `mock` |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`, `ANTHROPIC_BASE_URL` | Claude; `BASE_URL` — шлюз на маке |
| `OPENAI_*`, `GEMINI_*`, `KIMI_*`, `GIGACHAT_*`, `YANDEX_*` | остальные облачные провайдеры |
| `LOCAL_AI_BASE_URL`, `LOCAL_AI_MODEL`, `LOCAL_AI_OCR_MODEL`, `LOCAL_AI_CONTEXT` | LM Studio |
| `CLOUD_AI_OPEN_PROVIDERS`, `CLOUD_AI_HOSTS`, `CLOUD_AI_HOSTS_PROVIDERS` | кому и на каком домене открыто облако |
| `KB_DIR`, `KB_VERIFIED_DIR`, `KB_EMBEDDING_MODEL` | базы знаний |
| `DATA_DIR`, `ARCHIVE_DIR`, `USERS_FILE` | данные, архив результатов, список людей |
| `MAX_FILE_SIZE_MB`, `MAX_TOTAL_UPLOAD_MB`, `MAX_FILES_PER_SESSION`, `DOC_CHAR_LIMIT` | лимиты загрузки и текста документа |
| `MAX_AI_REQUESTS_PER_SESSION`, `MAX_TOKENS_PER_SESSION`, `MAX_ANALYSIS_CALLS` | бюджет модели на сессию и на анализ |
| `SESSION_TTL_HOURS` | автоудаление сессий посадки (72 ч; `0` — бессрочно) |
| `NORMO_DATABASE_URL`, `NORMO_DATA_DIR`, `NORMO_KB_DIR`, `NORMO_LLM` | нормоконтроль |

## Выбор нейросети и базы знаний

В настройках сессии посадки (и в свойствах проектов модулей) выбирается:

- **Нейросеть:** Claude (Anthropic), ChatGPT (OpenAI), Gemini (Google), Kimi
  (Moonshot), GigaChat (Сбер), YandexGPT, любая модель локального LM Studio,
  демо-режим. Доступность определяется автоматически, недоступные варианты
  показаны с причиной. Ollama в пикере нет — в реестре остался скрытым маршрутом.
  Облачные модели выдаются по флагу `cloudAi` в `users.json` и белому списку
  `CLOUD_AI_OPEN_PROVIDERS`; Claude, ChatGPT и Gemini живут только на
  `enso-nexus.com`, на `.ru` — локальные, Kimi, GigaChat и YandexGPT.
- **База знаний:** «Общая база» (`main`, `KB_DIR`) или «Верифицировано»
  (`verified`, `KB_VERIFIED_DIR`; по умолчанию папка
  `Knowledge-Base-Верифицировано` рядом с основной, подключается, если существует).
  База Гриши из выбора убрана.
- **Сравнение моделей:** 2–4 модели → один и тот же анализ каждой, сводная
  таблица в чате и файл `СРАВНЕНИЕ-МОДЕЛЕЙ.md`; факты и вопросы сессии не меняются.

## База знаний (RAG)

Перед анализом сервер находит релевантные пункты норм (семантический поиск по
эмбеддингам LM Studio, запасной путь — по словам) и передаёт их модели выдержками
с шифром и пунктом. Индекс — таблица `kb_chunks` в основной SQLite: 9572 чанка на
конец августа 2026 (актуальное число — `GET /api/health`, поле `kb.chunks`).

```bash
# .env: KB_DIR=/путь/к/Knowledge-Base
npm run kb:index   # индексация; повторять при обновлении базы
```

Источники: `09_Векторный-индекс/*/чанки.jsonl`, запасной — `04_JSON/*/пункты.json`.
Переиндексация без работающей embedding-модели сохраняет чанки без векторов —
после неё проверять `withVectors` в `/api/health`.

## Тесты

```bash
npm test          # unit + API + e2e, 450 тестов на 2026-09-02
npm run test:e2e  # только e2e smoke
```

Тесты используют временный `DATA_DIR` и демо-режим, сеть и живые модели не нужны.

## Сборка и контейнер

Шага сборки нет. Контейнер:

```bash
docker build -t enso-platform .
docker run -p 3000:3000 -v enso-data:/app/data -e ANTHROPIC_API_KEY=... enso-platform
```

Что образ покрывает и чего нет (AutoCAD, Playwright, LM Studio, PostgreSQL) —
в [DEPLOYMENT.md](DEPLOYMENT.md).

## Документы рядом

- [API.md](API.md) — маршруты, заголовки, формы ответов.
- [DEPLOYMENT.md](DEPLOYMENT.md) — туннель Cloudflare, домены, Render, Docker, мост AutoCAD.
- [CLAUDE.md](CLAUDE.md) — устройство и принятые решения.
- [REPORT.md](REPORT.md) — отчёт о разработке.
- Шлюз облачных моделей на маке живёт вне репозитория: `~/enso/mac` (запускается launchd).
