# API — ENSO Nexus Pilot 1 Web

Базовый путь: `/api`. Все ответы — JSON (кроме скачивания файлов). Ошибки всегда в виде `{ "error": "текст" }`, stack trace клиенту не раскрывается.

## Схема сессий и авторизация

- `POST /api/sessions` возвращает `{ id, token }`. `id` — UUID сессии, `token` — 64-символьный секрет.
- Все остальные операции с сессией требуют заголовок `Authorization: Bearer <token>`.
- Чужую сессию нельзя открыть ни подбором URL (нужен токен), ни чужим токеном (ответ единый — `404`, без раскрытия существования сессии).
- Данные сессии (файлы, история, результаты) хранятся на сервере до ручного удаления или истечения TTL (`SESSION_TTL_HOURS`, по умолчанию 72 ч).

## Схема статусов задачи (`jobStatus`)

`idle → queued → running → needs_clarification | completed | failed`

- `needs_clarification` — есть вопросы со статусом `pending`; после ответа на все обработка продолжается автоматически (снова `queued → running`).
- Повторный запуск при уже идущей задаче → `409`.
- Статусы вопросов: `pending` (ожидает ответа) → `answered`; также `needs_followup`, `closed`.

## Endpoints

### Служебные

| Метод | Путь | Описание |
|---|---|---|
| GET | `/api/health` | Состояние сервера, режим AI (`live`/`local`/`mock`), статус базы знаний (`kb`), лимиты |

Пример ответа:
```json
{ "ok": true, "aiMode": "live", "model": "claude-opus-5", "promptVersion": "1.0.0",
  "limits": { "maxFileSizeMb": 25, "maxTotalUploadMb": 60, "maxFiles": 10,
              "allowedExtensions": ["pdf","dwg","dxf","docx","txt","md","json","csv","png","jpg","jpeg"],
              "maxMessageLength": 4000, "sessionTtlHours": 72 } }
```

### Сессии

| Метод | Путь | Описание |
|---|---|---|
| POST | `/api/sessions` | Создать сессию → `201 { id, token }` |
| GET | `/api/sessions/:id` | Полное состояние: файлы, сообщения, вопросы, события, результаты, факты |
| GET | `/api/sessions/:id/status` | Только `jobStatus` + журнал этапов (для polling) |
| GET | `/api/sessions/:id/messages` | История сообщений |
| DELETE | `/api/sessions/:id` | Удалить сессию и все её данные (файлы, результаты, историю) |

Пример `GET /api/sessions/:id` (сокращено):
```json
{ "id": "…", "jobStatus": "needs_clarification", "comment": "ТХ отсутствует",
  "files": [{ "id": "…", "name": "ГПЗУ.pdf", "size": 12345, "ext": "pdf" }],
  "messages": [{ "role": "assistant", "kind": "result", "content": "…", "created_at": "…" }],
  "questions": [{ "id": "…", "text": "…", "why": "…", "status": "pending", "answer": null }],
  "events": [{ "stage": "Выполняется анализ (AI-модель)", "level": "info", "created_at": "…" }],
  "results": [], "facts": [{ "key": "plot.area_m2", "value": "3700", "source": "ГПЗУ, стр. 1" }] }
```

### Файлы

| Метод | Путь | Описание |
|---|---|---|
| POST | `/api/sessions/:id/files` | multipart/form-data, поле `files` (до 5 за запрос). Ответ: `{ uploaded: [...], errors: [{name, error}] }` |
| DELETE | `/api/sessions/:id/files/:fileId` | Удалить файл до обработки |

Валидация: расширение из списка + magic bytes (содержимое должно соответствовать формату), лимиты размера/количества. Невалидные файлы возвращаются в `errors` с понятной причиной.

```bash
curl -X POST "$BASE/api/sessions/$ID/files" \
  -H "Authorization: Bearer $TOKEN" \
  -F "files=@ГПЗУ.pdf"
```

### Обработка и диалог

| Метод | Путь | Описание |
|---|---|---|
| POST | `/api/sessions/:id/settings` | `{ aiProvider, aiModel, kbChoice }` — выбор нейросети (`claude`/`chatgpt`/`lmstudio`/`ollama`/`demo`; `""` = по умолчанию сервера) и базы знаний (`main`/`grisha`). Недоступный провайдер → 400 с причиной. Список доступного — в `/api/health` (`providers`, `kbBases`) |
| POST | `/api/sessions/:id/process` | Запустить обработку загруженных данных → `202` |
| POST | `/api/sessions/:id/compare` | `{ models: [{provider, model}, …] }` (2–4 шт.) — сравнительный прогон: один анализ каждой моделью по очереди, без изменения фактов/вопросов сессии; итог — файл `СРАВНЕНИЕ-МОДЕЛЕЙ.md` и сводная таблица в чате → `202` |
| POST | `/api/sessions/:id/messages` | `{ "text": "…" }` — сообщение помощнику; сохраняется и запускает обработку → `202` |
| POST | `/api/sessions/:id/questions/:qid/answer` | `{ "answer": "…" }` — ответ на уточняющий вопрос. Если вопросов `pending` не осталось — обработка продолжается автоматически. Ответ: `{ ok, continued, pending }` |

### Результаты

| Метод | Путь | Описание |
|---|---|---|
| GET | `/api/sessions/:id/results` | Список файлов: `{ id, filename, title, format, size }` |
| GET | `/api/sessions/:id/results/:resultId/download` | Скачивание (Content-Disposition: attachment) |

Типовой набор результатов: `ОТЧЁТ.md`, `session-data.json`, `генплан-эскиз.dxf` (при наличии координат), `результаты.zip`.

## Коды ошибок

| Код | Когда |
|---|---|
| 400 | Невалидные данные: пустое сообщение, неподдерживаемый файл, нет файлов для обработки, битый id |
| 404 | Сессия/файл/вопрос не найдены, либо неверный токен |
| 409 | Обработка уже выполняется |
| 413 | Файл или запрос больше лимита |
| 429 | Rate limit (на IP) или превышен лимит одновременных задач |
| 500 | Внутренняя ошибка (детали — только в серверных логах) |

## Защитные механизмы API

- Rate limiting на IP: общий и усиленный для «дорогих» операций (создание сессии, загрузка, запуск AI).
- Лимит тела JSON-запроса 256 КБ; лимиты multipart по размеру и числу файлов.
- Path traversal исключён: имена файлов санитизируются, выдача файлов проверяет, что путь остаётся внутри каталога сессии.
- Типы файлов проверяются по содержимому (magic bytes), не только по расширению.
- Загруженные файлы никогда не отдаются как статика и не исполняются.
- Serверные ошибки логируются с полным stack trace, клиент получает нейтральное сообщение.
