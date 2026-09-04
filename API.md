# API — Enso-nexus

Базовый путь: `/api`. Ответы — JSON (кроме скачивания файлов). Ошибка всегда
`{ "error": "текст" }`, stack trace клиенту не уходит. Тело JSON — до 256 КБ
(маршруты с текстом документа в модулях принимают до 2 МБ).

Роутеры (`server/app.js`): `/api/projects`, `/api/tz`, `/api/doccheck`,
`/api/normo`, `/api/gge`, `/api/akty`, `/api/dataset` и общий `/api`
(`routes/api.js`: вход, сессии посадки здания, статистика).

## Два токена — два заголовка

| Заголовок | Что это | Где нужен |
|---|---|---|
| `X-User-Token: <64 hex>` | токен человека; выдаёт `POST /api/auth/enter` | модули, проекты, статистика, создание сессии |
| `Authorization: Bearer <64 hex>` | токен сессии посадки здания; выдаёт `POST /api/sessions` | всё под `/api/sessions/:id/…` |

Ключи не смешиваются: в `Authorization` живёт только токен сессии, токен
человека всегда в `X-User-Token`. Маршруты сессии проверяют её токен; те, что
меняют данные или тратят модель, дополнительно требуют хозяина (`sessionOwner`):
чужой человек с верным токеном сессии получает `403`, сессия без хозяина
(заведена до появления входа) закрепляется за первым вошедшим.

Обозначения в таблицах: **U** — `X-User-Token` одобренного человека;
**S** — `Authorization: Bearer` токен сессии; **S+U** — токен сессии и её
хозяин; **—** — без заголовков. `REQUIRE_LOGIN=0` снимает проверку **U** целиком.

## Вход

Пароля нет: человек называет фамилию и имя. Режим регистрации живёт в
`users.json`: `free` — вход сразу, `approval` — сначала владелец ставит
человеку `"approved": true`.

| Метод | Путь | Смысл | Заголовок |
|---|---|---|---|
| GET | `/api/auth/state` | `{ requireLogin, registration }` — нужен ли вход и какой режим | — |
| POST | `/api/auth/enter` | `{ lastName, firstName, deviceId? }` → `{ status: "active", token, user }`, либо `{ status: "pending", message }`, либо `400 { status: "invalid", error }`. Ответ одинаков для нового и известного имени. Лимит попыток — `RATE_LIMIT_AUTH` | — |
| GET | `/api/auth/me` | кто вошёл: `{ status: "active" \| "pending", user }`; без токена `401 { needLogin: true }` | U (любой статус) |
| POST | `/api/auth/logout` | отозвать токен → `{ ok }` | U |

Статусы человека: **pending** — заявка подана, ждёт одобрения; **approved** —
доступ открыт. Маршруты с **U** отвечают `401 { needLogin: true }` без токена
и `403 { status: "pending" }` до одобрения. Облачные модели, «Датасет» и чужая
статистика зависят от флагов в `users.json` (`cloudAi`, `dataset`, `owner`,
`statsAll`).

## Служебное

| Метод | Путь | Смысл | Заголовок |
|---|---|---|---|
| GET | `/api/health` | состояние сервера: `aiMode` (`live`/`local`/`mock`), `model`, `localBundle { text, vision }`, `promptVersion` (сейчас `1.4.0`), `providers[]` (список зависит от того, кто спрашивает и с какого домена), `kbBases[]`, `kb`, `dataset.allowed`, `limits` | — (U необязателен) |
| GET | `/api/cad/status` | доступна ли выгрузка DWG (AutoCAD или конвертер) | — |
| GET | `/api/placement/criteria` | критерии отбора вариантов посадки | — |
| GET | `/api/critical-objects` | база критических объектов по классам | — |
| POST | `/api/critical-objects` | добавить класс объекта в базу | U |
| GET | `/api/workplan/default.xlsx` | стандартный порядок работы (Excel) — доступен до создания сессии | — |

Пример `/api/health` (сокращённо):
```json
{ "ok": true, "aiMode": "local", "model": "qwen/qwen3.8-27b",
  "localBundle": { "text": "qwen/qwen3.8-27b", "vision": "qwen/qwen3-vl-30b" },
  "promptVersion": "1.4.0",
  "providers": [{ "id": "lmstudio", "label": "LM Studio (локально)", "available": true, "models": ["…"] }],
  "kbBases": [{ "id": "main", "label": "Общая база" }, { "id": "verified", "label": "Верифицировано (разбор по пунктам и таблицам)" }],
  "limits": { "maxFileSizeMb": 25, "maxTotalUploadMb": 60, "maxFiles": 10, "visionMaxPages": 50,
              "allowedExtensions": ["pdf","dwg","dxf","docx","txt","md","json","csv","png","jpg","jpeg"],
              "maxMessageLength": 4000, "sessionTtlHours": 72 } }
```

## Провайдеры и базы знаний

Идентификаторы провайдеров (`services/ai/registry.js`) — они же в `providers`
у `/api/health` и в `aiProvider` настроек сессии и модулей: `claude`, `chatgpt`,
`gemini`, `kimi`, `gigachat`, `yandexgpt`, `lmstudio`, `demo`. Пустая строка —
маршрут сервера по умолчанию. `ollama` и `openai-compat` в реестре есть, но в
пикер не попадают — скрытый маршрут. Недоступный провайдер → `400` с причиной:
нет ключа, облако закрыто этому человеку (`cloudAi`, `CLOUD_AI_OPEN_PROVIDERS`)
или этому домену (`CLOUD_AI_HOSTS`: Claude, ChatGPT и Gemini живут только на `.com`).

Базы знаний (`kbBases`, поле `kbChoice`): `main` — общая (`KB_DIR`), `verified` —
«Верифицировано», разбор по пунктам и таблицам (`KB_VERIFIED_DIR`; подключается,
только если каталог существует). База Гриши из выбора убрана.

## Проекты платформы — `/api/projects`

Проект — единица работы, внутри которой живут модули (порядок: 1 Анализ ТЗ →
2 Посадка здания → 3 Проверка документа → 4 Нормоконтроль → 5 Контроль ГГЭ →
6 Акты). Списки модулей фильтруются `?project=<id>`, создание принимает
`projectId` (у нормоконтроля — `platformProjectId`). Пустой `projectId`
означает проект «Ранние работы» (`id = "legacy"`) — туда же при старте
переезжает всё, что заведено до появления проектов. Все маршруты — **U**.

| Метод | Путь | Смысл |
|---|---|---|
| GET | `/api/projects` | `{ projects: [{ id, name, full_name, client, stage, note, created_by_name, created_at, updated_at, summary }] }` |
| POST | `/api/projects` | `{ name, fullName?, client?, stage?, note? }` → `201 { project }` |
| GET | `/api/projects/:id` | `{ project }` со сводкой |
| PATCH | `/api/projects/:id` | правка тех же полей → `{ project }` |
| DELETE | `/api/projects/:id` | мягкое удаление → `{ ok }`; сущности модулей остаются |
| POST | `/api/projects/:id/marks` | `{ module: "gge" \| "akty", note? }` — отметка прогона модуля без хранения |

`summary` считает сервер, по строке на модуль (`tz`, `site`, `doc`, `normo`,
`gge`, `akty`): `{ state: "none" \| "ok" \| "warn" \| "bad" \| "run" \| "off", count, line, at }`.
`off` — база нормоконтроля недоступна.

## Посадка здания — сессии `/api/sessions`

Сессия — один прогон посадки: файлы, диалог, факты, план участка, варианты,
результаты. Данные живут до удаления или до TTL (`SESSION_TTL_HOURS`, 72 ч;
`0` — бессрочно).

Статусы задачи (`jobStatus`): `idle → queued → running → needs_clarification | completed | failed`.
`needs_clarification` — есть вопросы `pending`; после ответа на все обработка
продолжается сама. Повторный запуск при идущей задаче → `409`. Статусы вопросов:
`pending → answered`, также `needs_followup`, `closed`. Отдельно этап работы
(`stage`/`stageLabel`) — по нему интерфейс понимает, чего ждут от человека
(согласование зон, вариантов).

### Сессии и список

| Метод | Путь | Смысл | Заголовок |
|---|---|---|---|
| POST | `/api/sessions` | `{ deviceId?, projectId? }` → `201 { id, token }` | U |
| GET | `/api/devices/:deviceId/sessions` | `?project=<id>` — сессии человека (плюс «ничьи» этого устройства) → `{ sessions: [{ id, token, title, jobStatus, createdAt, updatedAt, files }] }` | U |
| POST | `/api/sessions/:id/device` | привязать сессию к устройству и закрепить за вошедшим | S+U |
| GET | `/api/sessions/:id` | полное состояние (см. ниже) | S |
| GET | `/api/sessions/:id/status` | `{ jobStatus, events }` — для опроса | S |
| GET | `/api/sessions/:id/messages` | `{ messages }` | S |
| DELETE | `/api/sessions/:id` | удалить сессию и все данные | S+U |
| POST | `/api/sessions/:id/settings` | `{ aiProvider?, aiModel?, kbChoice?, title? }` → `{ ok }`; недоступный провайдер → `400` | S+U |
| POST | `/api/sessions/:id/comment` | указание к исходным данным (уходит в каждый прогон) | S+U |
| POST | `/api/sessions/:id/cancel` | остановить текущую задачу | S+U |

`GET /api/sessions/:id` (сокращённо):
```json
{ "id": "…", "projectId": "legacy", "title": "…", "jobStatus": "needs_clarification",
  "settings": { "aiProvider": "", "aiModel": "", "kbChoice": "main" },
  "ai": { "provider": "lmstudio", "model": "qwen/qwen3.8-27b" },
  "usage": { "inputTokens": 0, "outputTokens": 0, "costUsd": 0, "aiRequests": 0, "aiSubrequests": 0 },
  "stage": "idle", "stageLabel": "", "chatBusy": false, "pendingChats": 0,
  "workplan": { … }, "jobProgress": null, "suggestedRequirements": null,
  "files": [{ "id": "…", "name": "ГПЗУ.pdf", "size": 12345, "ext": "pdf" }],
  "messages": [{ "role": "assistant", "kind": "result", "content": "…" }],
  "questions": [{ "id": "…", "text": "…", "why": "…", "status": "pending", "answer": null, "options": [] }],
  "events": [{ "stage": "Выполняется анализ", "level": "info", "created_at": "…" }],
  "results": [], "facts": [{ "key": "plot.area_m2", "value": "3700", "source": "ГПЗУ, стр. 1" }] }
```

### Файлы и порядок работы

| Метод | Путь | Смысл | Заголовок |
|---|---|---|---|
| POST | `/api/sessions/:id/files` | multipart, поле `files` (до 5 за запрос) → `{ uploaded, errors: [{ name, error }] }`; тип проверяется по magic bytes | S+U |
| DELETE | `/api/sessions/:id/files/:fileId` | удалить файл | S+U |
| GET | `/api/sessions/:id/workplan.xlsx` | текущий порядок работы сессии (Excel) | S |
| POST | `/api/sessions/:id/workplan` | multipart `file` — свой порядок работы | S+U |
| DELETE | `/api/sessions/:id/workplan` | вернуть стандартный порядок | S+U |

### Обработка и диалог

| Метод | Путь | Смысл | Заголовок |
|---|---|---|---|
| POST | `/api/sessions/:id/process` | запустить анализ; `{ instruction? }` дополняет методику → `202` | S+U |
| POST | `/api/sessions/:id/compare` | `{ models: [{ provider, model }, …] }` (2–4) — один анализ каждой моделью, итог `СРАВНЕНИЕ-МОДЕЛЕЙ.md` → `202` | S+U |
| POST | `/api/sessions/:id/messages` | `{ text }` — реплика помощнику; принимается всегда → `202 { ok, queued, pinnedAsComment }` | S+U |
| POST | `/api/sessions/:id/questions/:qid/answer` | `{ answer }` → `{ ok, continued, pending }`; когда `pending` не осталось — анализ продолжается сам | S+U |
| POST | `/api/sessions/:id/questions/:qid/skip` | пропустить вопрос — анализ пойдёт на допущении | S+U |

### План участка, зоны, варианты

| Метод | Путь | Смысл | Заголовок |
|---|---|---|---|
| GET | `/api/sessions/:id/plan` | разбор чертежей: объекты, слои, участок (детерминирован, без модели) | S |
| POST | `/api/sessions/:id/plan/parcel-source` | границы ЗУ по поворотным точкам (ГПЗУ/ЕГРН); полигон считает код | S+U |
| DELETE | `/api/sessions/:id/plan/parcel-source` | убрать заданные границы | S+U |
| POST | `/api/sessions/:id/plan/objects/:objectId` | правка типа/свойств объекта человеком (переживает переразбор) | S+U |
| DELETE | `/api/sessions/:id/plan/objects/:objectKey` | снять правку | S+U |
| GET | `/api/sessions/:id/plan/drawing` | чертёж: DWG (AutoCAD или LibreDWG) либо честно DXF — формат в заголовке `X-Drawing-Format` | S |
| GET | `/api/sessions/:id/plan/corrections.jsonl` | выгрузка правок «разбор → человек» для дообучения | S |
| POST | `/api/sessions/:id/annotations` | выделение области плана с комментарием | S+U |
| POST | `/api/sessions/:id/annotations/:aid` | правка выделения | S+U |
| DELETE | `/api/sessions/:id/annotations/:aid` | удалить выделение | S+U |
| POST | `/api/sessions/:id/annotations/:aid/ask` | вопрос модели по выделенной области (мультимодальный контекст) | S+U |
| POST | `/api/sessions/:id/plan/restrictions` | расчёт зон ограничений: модель даёт правила, движок строит полигоны | S+U |
| POST | `/api/sessions/:id/plan/variants` | сгенерировать четыре различающихся варианта посадки | S+U |
| GET | `/api/sessions/:id/plan/variants` | варианты и решения по ним | S |
| POST | `/api/sessions/:id/plan/actions/:actionId` | решение по мероприятию с критическим объектом | S+U |
| POST | `/api/sessions/:id/plan/variants/:variantId/select` | выбрать вариант; `{ decisions: [{ actionId, decision: "allow" \| "forbid" }], decidedBy? }` | S+U |
| POST | `/api/sessions/:id/plan/export` | комплект по выбранному варианту: PDF, схема PNG, чертёж | S+U |
| GET | `/api/sessions/:id/critical-objects/unknown` | объекты чертежа, класс которых базе неизвестен | S |

### Этапы согласования

| Метод | Путь | Смысл | Заголовок |
|---|---|---|---|
| POST | `/api/sessions/:id/stages/zones/approve` | схема зон согласована → к вариантам | S+U |
| POST | `/api/sessions/:id/stages/zones/revise` | замечания к зонам — пересчёт с их учётом | S+U |
| POST | `/api/sessions/:id/stages/variants/revise` | замечания к вариантам — новая четвёрка | S+U |
| POST | `/api/sessions/:id/stages/variants/approve` | вариант согласован (с решениями по мероприятиям) | S+U |

### Результаты

| Метод | Путь | Смысл | Заголовок |
|---|---|---|---|
| GET | `/api/sessions/:id/results` | `{ results: [{ id, filename, title, format, size }] }` | S |
| GET | `/api/sessions/:id/results/:resultId/download` | скачивание (`Content-Disposition: attachment`) | S |

Типовой набор: `ОТЧЁТ.md`, `session-data.json`, `генплан-эскиз.dxf`, `результаты.zip`.

## Статистика — `/api/stats`

Своё видит каждый, чужое — владелец и допущенные (`owner`/`statsAll` в
`users.json`). Все маршруты — **U**.

| Метод | Путь | Смысл |
|---|---|---|
| GET | `/api/stats/overview` | расход по дням и провайдерам (`?days=`, `?user=` — только допущенным) |
| GET | `/api/stats/people` | расход по людям → `{ canSeeAll, people }` |
| GET | `/api/stats/balance` | деньги на счетах провайдеров → `{ providers }` |
| POST | `/api/stats/topups` | `{ provider, amountUsd, note?, happenedAt? }` — записать пополнение |
| DELETE | `/api/stats/topups/:id` | удалить запись о пополнении |

## Анализ ТЗ — `/api/tz`

Проверка задания на проектирование по чек-листу. Проект модуля хранит текст
документа и прогоны (таблицы `tz_*` в основной SQLite, вне TTL сессий).
Все маршруты — **U**.

| Метод | Путь | Смысл |
|---|---|---|
| GET | `/api/tz/meta` | `{ checklists, severities, itemStatuses }` |
| POST | `/api/tz/projects` | `{ name, checklist?, provider?, model?, object?, projectId? }` → `201 { project }` |
| GET | `/api/tz/projects` | `?project=` → `{ projects: [{ id, name, checklist, ai_provider, ai_model, document_name, project_id, has_document, document_chars, run_count, last_run_status, last_run_id, … }] }` |
| GET | `/api/tz/projects/:id` | `{ project, runs }` (без текста документа) |
| PATCH | `/api/tz/projects/:id` | имя, чек-лист, модель, объект |
| DELETE | `/api/tz/projects/:id` | удалить |
| GET | `/api/tz/projects/:id/document` | `{ name, note, text }` |
| PUT | `/api/tz/projects/:id/document` | `{ text, name? }` — вставить текст руками |
| POST | `/api/tz/projects/:id/document/file` | multipart `file`: DOCX, PDF с текстовым слоем, TXT, MD; скан → `422` |
| POST | `/api/tz/projects/:id/analyze` | запустить прогон → `202 { runId, status: "queued" }`; идущий прогон → `409` |
| GET | `/api/tz/runs/:rid` | `{ run }` — статус, прогресс, находки |
| POST | `/api/tz/runs/:rid/findings/:fid/decision` | решение человека по находке |
| GET | `/api/tz/runs/:rid/export.xlsx` | реестр замечаний (Excel); незавершённый прогон → `409` |
| GET | `/api/tz/runs/:rid/export.docx` | отчёт (Word) |

## Проверка документа — `/api/doccheck`

Проверка документа с автоподбором промпта из библиотеки (`библиотека-промптов/`)
плюс сравнение двух редакций «A → B». Все маршруты — **U**.

| Метод | Путь | Смысл |
|---|---|---|
| GET | `/api/doccheck/meta` | `{ types }` — типы документов библиотеки |
| POST | `/api/doccheck/checks` | `{ name, provider?, model?, projectId? }` → `201 { check }` |
| GET | `/api/doccheck/checks` | `?project=` → `{ checks: [{ id, name, ai_provider, ai_model, document_name, project_id, has_document, document_chars, detected_type, chosen_type, run_count, last_run_status, last_run_id, … }] }` |
| GET | `/api/doccheck/checks/:id` | проверка с прогонами (без текста) |
| PATCH | `/api/doccheck/checks/:id` | имя, модель, выбранный тип документа |
| DELETE | `/api/doccheck/checks/:id` | удалить |
| PUT | `/api/doccheck/checks/:id/document` | `{ text, name? }` — текст руками; тип документа определяется сразу |
| POST | `/api/doccheck/checks/:id/document/file` | multipart `file`: DOCX, PDF с текстовым слоем, TXT, MD, XML (график MS Project) |
| POST | `/api/doccheck/checks/:id/analyze` | прогон → `202 { runId, status: "queued" }` |
| GET | `/api/doccheck/runs/:rid` | `{ run }` |
| POST | `/api/doccheck/runs/:rid/findings/:fid/decision` | решение по находке |
| GET | `/api/doccheck/runs/:rid/export.xlsx` | реестр находок (Excel) |
| POST | `/api/doccheck/ab` | `{ name, provider?, model?, projectId? }` — сравнение редакций → `201 { ab }` |
| GET | `/api/doccheck/ab` | `?project=` → `{ list }` |
| GET | `/api/doccheck/ab/:id` | `{ ab }` |
| PATCH | `/api/doccheck/ab/:id` | имя, модель |
| DELETE | `/api/doccheck/ab/:id` | удалить |
| PUT | `/api/doccheck/ab/:id/docs/:kind` | текст редакции `a` или `b` руками |
| POST | `/api/doccheck/ab/:id/docs/:kind/file` | файл редакции (те же форматы) |
| DELETE | `/api/doccheck/ab/:id/docs/:kind` | убрать редакцию |
| POST | `/api/doccheck/ab/:id/run` | запустить сравнение → `202 { status: "running" }` |
| POST | `/api/doccheck/ab/:id/rows/:rowId/decision` | решение по строке сравнения |
| GET | `/api/doccheck/ab/:id/export.xlsx` | таблица сравнения (Excel) |

## Нормоконтроль — `/api/normo`

Своя БД PostgreSQL + pgvector (`NORMO_DATABASE_URL`, порт 5433), файлы — в
`NORMO_DATA_DIR`, база знаний модуля — каталог `нормоконтроль/` (`NORMO_KB_DIR`).
Схема разворачивается при первом запросе к модулю. Все маршруты — **U**.

| Метод | Путь | Смысл |
|---|---|---|
| GET | `/api/normo/health` | `{ db, rules: { files, count, hash } }` |
| GET | `/api/normo/catalog/rules` | каталог правил; фильтры `?applies_to=`, `?severity=` |
| POST | `/api/normo/projects` | `{ name, stage, dateStarted, customer?, objectKind?, localOnly?, platformProjectId? }` → `201 { project }` |
| GET | `/api/normo/projects` | `?project=<проект платформы>` → `{ projects }` |
| GET | `/api/normo/projects/:id` | `{ project }` |
| PUT | `/api/normo/projects/:id/sections` | состав разделов `{ sections: [{ code, name, … }] }` |
| POST | `/api/normo/projects/:id/sections/:code/versions` | multipart — новая версия раздела (файлы) → `201` |
| GET | `/api/normo/sections/:sid/versions` | `{ versions }` |
| GET | `/api/normo/versions/:vid` | `{ version }` |
| POST | `/api/normo/versions/:vid/check` | проверка версии → `{ runId, status, cached }`; поле `llm` в ответе говорит, включены ли смысловые проверки (`NORMO_LLM`) |
| GET | `/api/normo/runs/:rid` | `{ run }` |
| GET | `/api/normo/versions/:vid/findings` | `{ findings }` |
| PATCH | `/api/normo/findings/:fid` | `{ status: open \| fixed \| rejected \| accepted_with_deviation, verification: human_confirmed \| human_rejected }` |
| POST | `/api/normo/projects/:id/input-data` | multipart — исходные данные (ТЗ, ГПЗУ, ТУ) → извлечение требований |
| GET | `/api/normo/projects/:id/input-data` | `{ inputData }` |
| GET | `/api/normo/projects/:id/requirements` | требования из исходных данных |
| GET | `/api/normo/projects/:id/traceability` | прослеживаемость «требование → раздел» |
| GET | `/api/normo/projects/:id/uncovered` | требования без покрытия разделами |
| POST | `/api/normo/projects/:id/check-complex` | комплексная (межразделная) проверка → `{ runId, status, cached }` |
| GET | `/api/normo/projects/:id/findings` | находки по проекту |
| GET | `/api/normo/sections/:sid/diff` | сравнение версий раздела → `{ diff }` |
| GET | `/api/normo/diffs/:did` | `{ diff }` |
| GET | `/api/normo/diffs/:did/impact` | на какие разделы влияет изменение |
| PATCH | `/api/normo/impact/:iid` | решение по влиянию → `{ link }` |
| POST | `/api/normo/versions/:vid/reports` | заключение нормоконтроля (DOCX по шаблону) → `201 { report }`; вердикты — только от человека |
| GET | `/api/normo/reports/:rid` | `{ report }` |
| GET | `/api/normo/reports/:rid/file` | файл заключения (`?format=json` — данные формы) |

## Входной контроль ГГЭ — `/api/gge`

Реквизитно-форматная проверка комплекта перед подачей. Детерминированно,
без моделей, ничего не хранится. Все маршруты — **U**.

| Метод | Путь | Смысл |
|---|---|---|
| POST | `/api/gge/forks` | `{ taskDate, fgisDate }` — развилки по датам, чистый расчёт |
| POST | `/api/gge/check` | multipart `files[]` + `fields` (JSON «реквизит → эталон») + даты → отчёт проверки; `?project=<id>` ставит отметку в проекте |

## Акты (АОСР) — `/api/akty`

Черновики актов из реестра и шаблона, сверка дат акт↔журнал. Без моделей и
без хранения. Все маршруты — **U**.

| Метод | Путь | Смысл |
|---|---|---|
| POST | `/api/akty/registry/preview` | multipart `registry` (XLSX) → `{ headers, rowCount, sample }` |
| POST | `/api/akty/template/preview` | multipart `template` (DOCX) → `{ keys }` — плейсхолдеры шаблона |
| POST | `/api/akty/generate` | `registry` + `template` → ZIP черновиков; отчёт о пропусках в заголовке `X-Akty-Report`; `?project=<id>` ставит отметку |
| POST | `/api/akty/dates` | `acts` + `journal` (XLSX) → таблица конфликтов дат |

## Датасет — `/api/dataset`

Сбор обучающих пар для дообучения локальных моделей. Доступ: **U** плюс
`datasetAccess` (`DATASET_OPEN=1` — всем вошедшим; `0` — владельцу и людям с
`"dataset": true`). Статусы пар с клиента не принимаются; удаление мягкое.

| Метод | Путь | Смысл |
|---|---|---|
| GET | `/api/dataset/settings` | `{ settings, datasetOpen }` |
| PUT | `/api/dataset/settings` | настройки модуля (модель генерации и др.) |
| GET | `/api/dataset/documents` | `{ documents }` |
| POST | `/api/dataset/documents` | multipart `file` → `201 { document, duplicate }` (повтор по хэшу — `200 { duplicate: true }`) |
| GET | `/api/dataset/documents/:docId` | `{ document, progress }` |
| GET | `/api/dataset/documents/:docId/file` | исходный файл |
| POST | `/api/dataset/documents/:docId/generate` | перезапуск генерации черновиков |
| GET | `/api/dataset/documents/:docId/elements` | `?state=` → `{ elements, progress }` |
| GET | `/api/dataset/elements/:elementId` | `{ element, pairs }` |
| POST | `/api/dataset/documents/:docId/elements/:elementId/defer` | «пропустить» элемент |
| POST | `/api/dataset/elements/:elementId/pairs` | ручная пара (всегда `pending`) → `201 { pair }` |
| PATCH | `/api/dataset/pairs/:pairId` | правка `question`/`answer` (optimistic lock: конфликт → `409 { updatedBy, updatedAt }`) |
| POST | `/api/dataset/pairs/:pairId/validate` | подтвердить (ФИО — из токена) |
| POST | `/api/dataset/pairs/:pairId/reject` | отклонить |
| DELETE | `/api/dataset/pairs/:pairId` | мягкое удаление |
| POST | `/api/dataset/pairs/:pairId/restore` | вернуть |
| GET | `/api/dataset/pairs` | история: `?q=&status=&document=&validator=&kind=&origin=&from=&to=&sort=` |
| GET | `/api/dataset/export` | весь валидированный набор (JSONL), фильтры UI не учитываются |

## Коды ошибок

| Код | Когда |
|---|---|
| 400 | невалидные данные: пустое поле, битый id, неизвестный провайдер или база, неподдерживаемый файл |
| 401 | нет токена человека (`needLogin: true`) |
| 403 | заявка не одобрена (`status: "pending"`), чужая сессия, закрытый модуль |
| 404 | сессия/проект/файл не найдены либо неверный токен сессии (ответ единый — сессии не перечисляются) |
| 409 | прогон уже идёт; экспорт незавершённого прогона; конфликт правки пары |
| 413 | файл или тело больше лимита |
| 422 | файл принят, но текста в нём нет (скан без слоя) или он не разобран |
| 429 | лимит запросов на IP или превышен лимит одновременных задач |
| 500 | внутренняя ошибка (детали — только в серверных логах) |

## Защита

- Лимиты на IP: общий (`RATE_LIMIT_GENERAL`), для дорогих операций
  (`RATE_LIMIT_EXPENSIVE`: создание сессии, загрузка, запуск модели) и для
  входа (`RATE_LIMIT_AUTH`). Отдельный потолок на адрес TCP-соединения
  (`RATE_LIMIT_PEER_FACTOR`) не обходится подделкой `X-Forwarded-For`.
- `trust proxy` — `loopback` по умолчанию (`TRUST_PROXY`): сервер слушает
  127.0.0.1 за cloudflared, других хопов нет.
- Path traversal исключён: имена файлов санитизируются, выдача проверяет, что
  путь остаётся внутри каталога сессии.
- Типы файлов проверяются по содержимому (magic bytes), не только по расширению;
  загруженные файлы не отдаются как статика и не исполняются.
- Ключи провайдеров живут только на сервере; облако выдаётся по флагам в
  `users.json` и домену запроса (`services/ai/cloud-access.js`).
- Серверные ошибки логируются с полным stack trace, клиент получает нейтральное сообщение.
