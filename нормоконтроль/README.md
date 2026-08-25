# Модуль «Нормоконтроль» — ENSO Nexus

Подсистема проверки проектной (ПД) и рабочей (РД) документации на соответствие НТД РФ:
версионирование разделов, документный и комплексный (междисциплинарный) нормоконтроль,
заключение по форме организации.

Статус: **Этап 1 завершён 24.08.2026** (база знаний собрана). Этап 2 (модель данных
и сценарии) — следующий; его схема будет дописана в этот README. Код не пишется
до утверждения Этапов 1–2.

## Карта модуля

```
нормоконтроль/
├── README.md                    ← этот файл
├── knowledge/                   ← нормализованная база знаний (Этап 1)
│   ├── sources-index.md         журнал источников: файл → что извлечено → куда пошло
│   ├── ntd-registry.yaml        реестр НТД: 208 записей (СПДС 50, ЕСКД 33, НПА 65, МД 24, прочее 36)
│   ├── sections.yaml            разделы ПД по ПП 87 (13/10 + условия), шифры прил. Б, марки РД прил. Г
│   └── glossary.md              96 статей + сокращения, с источниками
├── rules/                       ← каталог правил проверки (174 правила, все со ссылкой на пункт НТД)
│   ├── common.yaml              120 общих правил (14 категорий: комплектность, надписи, изменения, ЭДО…)
│   ├── cross-section.yaml       41 междисциплинарное (состав ПП 87, согласованность, ЦИМ, форматы, ссылки)
│   ├── ПЗ.yaml                  6 правил (xml-схема ПЗ, UsedNorms, перечень применённых документов)
│   └── СМ.yaml                  7 правил (XML ЛСР по 783/пр, границы нормоконтроля смет)
├── templates/
│   ├── conclusion.md            форма заключения 1:1 по исходному .docx + поля-подстановки
│   ├── conclusion-mapping.md    поля формы ↔ модель данных ↔ группы правил (28 строк)
│   └── wordings.yaml            120 формулировок: классификаторы МР-2024 (35) и МР-1989 (36),
│                                ОСТ 108.001.17-82 (13, частично), типовые формулировки (36)
├── prompts/
│   └── README.md                матрица «утверждённый приём → будущий промт агента» (промты — Этап 3)
├── decisions/
│   ├── conflicts.md             33 конфликта источников (CF-01…CF-33), решения за Никитой
│   ├── open-questions.md        13 вопросов (OQ-01…OQ-13) + 72 кандидата в правила без пункта НТД
│   └── prompt-techniques-review.md  обзор техник из @ai_prompt_eng (согласован 24.08.2026)
├── _raw/                        ← сырьё (в git не попадает)
│   └── telegram/                выгрузка канала: 290 постов jsonl, 78 медиа, опись вложений
└── tools/
    └── telegram/                скрипты выгрузки (зеркало t.me/s + резервный MTProto)
```

Рабочие материалы Этапа 0 (извлечения A–G, OCR-тексты) — в scratchpad сессии;
их конденсат перенесён в knowledge/ и rules/, происхождение — в sources-index.md.

## Как устроены правила

Единая схема (`rules/*.yaml`), пример:

```yaml
- id: COM-EDOC-006
  title: ...
  scope: document | cross_section
  applies_to: [АР]        # или [все]
  stage: [П, Р]
  severity: critical | major | minor | remark
  source: { ntd: ..., clause: "..." }   # ОБЯЗАТЕЛЬНО — без пункта правило не принимается
  check: { type: presence|format|consistency|reference|numeric, description: ... }
  auto: llm | deterministic | manual
  wording: ...            # типовая формулировка замечания
  fix_hint: ...
```

Жёсткие принципы (заданы ТЗ, подтверждены согласованным обзором техник):
- **ни одного правила без `source.ntd` + `clause`** — кандидаты без пункта живут
  в open-questions.md (секция «г»), возвращаются после добора полных текстов;
- **детерминированное — кодом** (`auto: deterministic` — 110 правил из 174), LLM — только
  смысловой анализ (53), спорное — человеку (`manual`, 11);
- замечание LLM обязано нести цитату из проверяемого документа и подтверждённую ссылку
  на пункт НТД, иначе уходит в «требует проверки человеком»;
- конфликты источников не решаются молча — фиксируются в conflicts.md.

## Как обновлять

1. **Новое правило**: только через схему выше; пункт НТД подтверждать по тексту стандарта
   (не по памяти модели). id — префикс файла + категория + номер, не переиспользовать.
2. **Новая редакция НТД**: обновить запись в ntd-registry.yaml (status/edition), прогнать
   каталог на затронутые правила (поле source.ntd), конфликт редакций — в conflicts.md.
3. **Добор из no-clause**: при появлении полного текста стандарта (OQ-06/OQ-07) перенести
   кандидатов из open-questions «г» в соответствующий rules/*.yaml с реальным пунктом.
4. **Дозагрузка Telegram-канала**: `tools/telegram/fetch_via_web.py` (инкрементально);
   новые приёмы — через процедуру Этапа 0-Б (карантин → 4 фильтра → дополнение review-файла).
5. **Проверка целостности** (перед коммитом): все YAML парсятся, id уникальны, у каждого
   правила есть source.ntd+clause — скрипт проверки появится в Этапе 3.

## Этап 2 — модель данных и сценарии (спроектировано 24.08.2026, на согласовании)

### Место модуля в платформе

Модуль — подсистема приложения `Pilot 1/Web`: свой Express-роутер `/api/normo/*`
в том же процессе (переиспользуются вход по `X-User-Token`, users.json, очередь задач),
но **своя база PostgreSQL 16 + pgvector**, как требует ТЗ модуля. SQLite приложения
не трогается и не мигрируется — правило «не менять SQLite на PostgreSQL» относится
к существующим данным приложения; модуль подключает свою БД через `NORMO_DATABASE_URL`
в `.env`. Каталог правил (`rules/*.yaml`) и шаблоны — источник истины на диске;
БД хранит проекты, версии, прогоны и результаты.

### Сущности (DDL, PostgreSQL)

```sql
CREATE EXTENSION IF NOT EXISTS vector;     -- pgvector

-- Единое файловое хранилище (дедупликация по хэшу)
CREATE TABLE files (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sha256        TEXT NOT NULL UNIQUE,
  path          TEXT NOT NULL,             -- путь в NORMO_DATA_DIR
  size_bytes    BIGINT NOT NULL,
  mime          TEXT,
  original_name TEXT NOT NULL,
  uploaded_by   TEXT,                      -- id человека из users.json
  uploaded_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Project: объект строительства
CREATE TABLE projects (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name         TEXT NOT NULL,
  customer     TEXT,
  stage        TEXT NOT NULL CHECK (stage IN ('П','Р','П+Р')),
  object_kind  TEXT NOT NULL DEFAULT 'непроизводственный'
               CHECK (object_kind IN ('производственный','непроизводственный','линейный')),
  date_started DATE NOT NULL,              -- решение OQ-11: выбор редакции перечней НТД
  local_only   BOOLEAN NOT NULL DEFAULT FALSE,  -- принудительный контур (override матрицы)
  owner_user   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at  TIMESTAMPTZ
);

-- Section: раздел документации в составе проекта
CREATE TABLE sections (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  project_id     BIGINT NOT NULL REFERENCES projects ON DELETE CASCADE,
  code           TEXT NOT NULL,            -- шифр: ПЗ, ПЗУ, АР, КР, ИОС1…ИОС7, ПОС, ООС, ПБ, ОДИ, СМ…
  name           TEXT NOT NULL,
  required       BOOLEAN NOT NULL DEFAULT TRUE,
  required_basis TEXT,                     -- «ПП 87 п.3(1)» / «задание на проектирование»
  sort_order     INT NOT NULL DEFAULT 0,
  UNIQUE (project_id, code)
);

-- SectionVersion: версия раздела; новая загрузка становится актуальной, старые сохраняются
CREATE TABLE section_versions (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  section_id   BIGINT NOT NULL REFERENCES sections ON DELETE CASCADE,
  version_no   INT NOT NULL,
  stage        TEXT NOT NULL CHECK (stage IN ('П','Р')),
  author       TEXT,                       -- исполнитель (в форму заключения)
  uploaded_by  TEXT,
  uploaded_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  content_hash TEXT NOT NULL,              -- сводный хэш файлов: идемпотентность анализа
  is_current   BOOLEAN NOT NULL DEFAULT TRUE,
  note         TEXT,
  UNIQUE (section_id, version_no)
);
CREATE UNIQUE INDEX one_current_version ON section_versions (section_id) WHERE is_current;

CREATE TABLE section_version_files (
  version_id BIGINT NOT NULL REFERENCES section_versions ON DELETE CASCADE,
  file_id    BIGINT NOT NULL REFERENCES files,
  PRIMARY KEY (version_id, file_id)
);

-- InputData (ИД): ТЗ, ТУ, ГПЗУ, изыскания, задания смежников
CREATE TABLE input_data (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  project_id BIGINT NOT NULL REFERENCES projects ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('ТЗ','ТУ','ГПЗУ','изыскания','задание_смежника','прочее')),
  title      TEXT NOT NULL,
  version_no INT NOT NULL DEFAULT 1,
  is_current BOOLEAN NOT NULL DEFAULT TRUE,
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE input_data_files (
  input_id BIGINT NOT NULL REFERENCES input_data ON DELETE CASCADE,
  file_id  BIGINT NOT NULL REFERENCES files,
  PRIMARY KEY (input_id, file_id)
);

-- Requirement: атомарное требование из ТЗ/ИД
CREATE TABLE requirements (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  input_id       BIGINT NOT NULL REFERENCES input_data ON DELETE CASCADE,
  seq            INT NOT NULL,
  text           TEXT NOT NULL,            -- дословно из документа (экстракция, не пересказ — П13/П14)
  source_doc     TEXT NOT NULL,            -- документ-источник
  source_clause  TEXT,                     -- пункт; NULL допустим, но помечает требование к ручной сверке
  addressee_codes TEXT[] NOT NULL DEFAULT '{}',  -- шифры разделов-адресатов
  status         TEXT NOT NULL DEFAULT 'new'
                 CHECK (status IN ('new','covered','partial','not_covered','conflict','dropped')),
  embedding      VECTOR(1024)              -- локальная модель класса bge-m3 (решение А8-A)
);

-- Матрица трассируемости: требование → где учтено
CREATE TABLE requirement_coverage (
  requirement_id BIGINT NOT NULL REFERENCES requirements ON DELETE CASCADE,
  version_id     BIGINT NOT NULL REFERENCES section_versions ON DELETE CASCADE,
  status         TEXT NOT NULL CHECK (status IN ('covered','partial','contradicts')),
  evidence_quote TEXT NOT NULL,            -- цитата из раздела — без неё покрытие не засчитывается
  location       JSONB,                    -- {sheet,page,clause}
  confirmed_by   TEXT NOT NULL CHECK (confirmed_by IN ('llm','human')),
  run_id         BIGINT,
  PRIMARY KEY (requirement_id, version_id)
);

-- Прогон анализа: единица идемпотентности и журналирования
CREATE TABLE analysis_runs (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  project_id  BIGINT NOT NULL REFERENCES projects ON DELETE CASCADE,
  version_id  BIGINT REFERENCES section_versions,      -- NULL для комплексного
  scope       TEXT NOT NULL CHECK (scope IN ('document','complex','ingest_id','diff','impact')),
  rules_hash  TEXT NOT NULL,               -- хэш каталога правил на момент прогона
  params      JSONB NOT NULL,              -- модель, seed, temperature=0, версии промптов, контур
  cache_key   TEXT NOT NULL UNIQUE,        -- sha256(version.content_hash + rules_hash + params):
                                           -- повтор той же версии отдаёт кэш, не новый прогон
  status      TEXT NOT NULL DEFAULT 'queued'
              CHECK (status IN ('queued','running','done','failed','cancelled')),
  started_at  TIMESTAMPTZ, finished_at TIMESTAMPTZ,
  error       TEXT
);

-- Журнал правил прогона: «какие отработали, какие пропущены и почему» (требование Этапа 3)
CREATE TABLE run_rules (
  run_id      BIGINT NOT NULL REFERENCES analysis_runs ON DELETE CASCADE,
  rule_id     TEXT NOT NULL,               -- COM-EDOC-006 и т.п.
  outcome     TEXT NOT NULL CHECK (outcome IN ('ok','finding','skipped','error')),
  skip_reason TEXT,
  duration_ms INT,
  PRIMARY KEY (run_id, rule_id)
);

-- Finding: замечание
CREATE TABLE findings (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id         BIGINT NOT NULL REFERENCES analysis_runs,
  version_id     BIGINT NOT NULL REFERENCES section_versions,
  rule_id        TEXT NOT NULL,
  rule_hash      TEXT NOT NULL,            -- снимок правила на момент прогона
  origin         TEXT NOT NULL CHECK (origin IN ('deterministic','llm','manual')),
  severity       TEXT NOT NULL CHECK (severity IN ('critical','major','minor','remark')),
  status         TEXT NOT NULL DEFAULT 'open'
                 CHECK (status IN ('open','fixed','rejected','accepted_with_deviation')),
  verification   TEXT NOT NULL DEFAULT 'auto'
                 CHECK (verification IN ('auto','needs_human','human_confirmed','human_rejected')),
  location       JSONB NOT NULL,           -- {sheet,page,clause,line}
  doc_quote      TEXT,                     -- цитата из проверяемого документа
  ntd            TEXT NOT NULL,            -- source.ntd
  ntd_clause     TEXT,                     -- source.clause
  ntd_quote      TEXT,                     -- цитата пункта НТД из базы (верифицируется кодом)
  wording        TEXT NOT NULL,
  fix_hint       TEXT,
  confidence     REAL,
  codes          JSONB NOT NULL DEFAULT '{}',  -- {"mr2024":"101","mr1989":"1.01"} — обе редакции (OQ-10)
  predecessor_id BIGINT REFERENCES findings,   -- то же замечание в предыдущей версии
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- LLM-замечание без обеих цитат не выдаётся как подтверждённое (правило Этапа 3):
  CHECK (origin <> 'llm'
         OR (doc_quote IS NOT NULL AND ntd_clause IS NOT NULL AND ntd_quote IS NOT NULL)
         OR verification = 'needs_human')
);

-- Report: заключение (рендер формы templates/conclusion.md)
CREATE TABLE reports (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  project_id       BIGINT NOT NULL REFERENCES projects ON DELETE CASCADE,
  scope            TEXT NOT NULL CHECK (scope IN ('document','complex')),
  version_id       BIGINT REFERENCES section_versions,  -- NULL для комплексного
  run_id           BIGINT REFERENCES analysis_runs,
  reviewer         TEXT NOT NULL,          -- нормоконтролёр
  checked_at       DATE NOT NULL,
  verdict_compliant BOOLEAN,               -- «соответствует требованиям»
  verdict_approved  BOOLEAN,               -- «допущена к выпуску»
  form_payload     JSONB NOT NULL,         -- заполненные поля формы (машиночитаемый JSON)
  docx_file        BIGINT REFERENCES files,
  status           TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','issued')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Diff: сравнение двух версий раздела
CREATE TABLE diffs (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  section_id   BIGINT NOT NULL REFERENCES sections ON DELETE CASCADE,
  from_version BIGINT NOT NULL REFERENCES section_versions,
  to_version   BIGINT NOT NULL REFERENCES section_versions,
  computed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  items        JSONB NOT NULL,             -- [{kind:'added|removed|changed', locus:{sheet,page,clause}, summary}]
  UNIQUE (section_id, from_version, to_version)
);

-- ImpactLink: изменение → затронутый объект
CREATE TABLE impact_links (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  diff_id     BIGINT NOT NULL REFERENCES diffs ON DELETE CASCADE,
  item_index  INT NOT NULL,                -- элемент diffs.items
  target_type TEXT NOT NULL CHECK (target_type IN ('section','requirement','finding')),
  target_id   BIGINT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending','needs_recheck','not_propagated','propagated','dismissed')),
  note        TEXT,
  updated_by  TEXT, updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- RAG по НТД: реестр + структурные чанки по иерархии пунктов
CREATE TABLE ntd_docs (
  id       BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code     TEXT NOT NULL UNIQUE,           -- «ГОСТ Р 21.101-2020»; синхронизация с knowledge/ntd-registry.yaml
  title    TEXT NOT NULL,
  edition  TEXT, status TEXT, system TEXT, role TEXT,
  source   TEXT NOT NULL DEFAULT 'корпус' CHECK (source IN ('корпус','техэксперт')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE ntd_chunks (
  id        BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  doc_id    BIGINT NOT NULL REFERENCES ntd_docs ON DELETE CASCADE,
  clause    TEXT NOT NULL,                 -- «5.4.3»; иерархия — по префиксу
  parent    TEXT,
  heading   TEXT,
  body      TEXT NOT NULL,
  chunk_no  INT NOT NULL DEFAULT 0,
  tsv       TSVECTOR GENERATED ALWAYS AS (to_tsvector('russian', body)) STORED,
  embedding VECTOR(1024) NOT NULL,         -- NOT NULL намеренно: чанк без вектора — ошибка загрузки,
                                           -- а не тихая деградация (инцидент базы знаний 08.2026)
  UNIQUE (doc_id, clause, chunk_no)
);
CREATE INDEX ON ntd_chunks USING gin (tsv);
CREATE INDEX ON ntd_chunks USING hnsw (embedding vector_cosine_ops);
```

### Как сущности обслуживают сценарии ТЗ

| # | Сценарий | Механизм | Приоритет |
|---|---|---|---|
| 3 | Загрузить раздел | `POST versions` → `section_versions` (is_current автоматически, старая снимается), `content_hash`, автозапуск `analysis_runs` | **1-й** |
| 4 | Нормоконтроль документа | run по `rules/common.yaml` + `rules/<шифр>.yaml`: deterministic-правила кодом, llm-правила через RAG; `run_rules` — полный журнал; `cache_key` — идемпотентность | **2-й** |
| 1 | Создать проект | `projects` + `sections` (предзаполнение состава из `knowledge/sections.yaml` по `object_kind`) | **3-й** |
| 6 | Заключение | `reports.form_payload` → рендер docx по `templates/conclusion.md` (правленая форма, CF-01/02) + JSON; галочки блоков — агрегаты Finding по `conclusion-mapping.md` | **4-й** |
| 7 | Версионирование | `diffs` (два прогона сравнения), `impact_links` (needs_recheck / not_propagated), пересчёт статусов: сопоставление findings новой версии с предыдущей по (rule_id + отпечаток location) → `fixed`/унаследован `predecessor_id` | **5-й** |
| 2 | ИД/ТЗ → требования | `input_data` → экстракция в `requirements` (дословные цитаты), `requirement_coverage` — матрица трассируемости | **6-й** |
| 5 | Комплексный нормоконтроль | run scope=complex по `cross-section.yaml` над всеми `is_current`-версиями + непокрытые `requirements` (status not_covered) отдельным списком | **7-й** |

### API (Express-роутер `/api/normo`, авторизация платформы)

```
Проекты и состав
  POST   /projects                          создать проект (+состав из sections.yaml по типу объекта)
  GET    /projects  |  GET /projects/:id    список / карточка со сводкой
  PATCH  /projects/:id                      стадия, local_only, date_started, архив
  PUT    /projects/:id/sections             состав разделов целиком
  GET    /projects/:id/sections             состав с актуальными версиями и счётчиками замечаний

Исходные данные и требования (сценарий 2)
  POST   /projects/:id/input-data           multipart; фоновая экстракция требований
  GET    /projects/:id/input-data
  GET    /projects/:id/requirements?status=…
  PATCH  /requirements/:id                  правка текста/адресатов/статуса человеком
  GET    /projects/:id/traceability         матрица «требование → раздел → где учтено»
  GET    /projects/:id/uncovered            требования без покрытия (выход сценария 5)

Версии разделов (сценарий 3)
  POST   /projects/:id/sections/:code/versions   multipart → новая версия (актуальная) + автозапуск проверки
  GET    /sections/:sid/versions            все версии (просмотр любой)
  GET    /versions/:vid                     карточка версии: файлы, прогоны, замечания
  GET    /versions/:vid/files/:fid          скачивание файла

Проверки (сценарии 4, 5)
  POST   /versions/:vid/check               документный нормоконтроль (повтор → кэш по cache_key)
  POST   /projects/:id/check-complex        комплексная проверка актуальных версий
  GET    /runs/:rid                         статус + журнал правил (отработало/пропущено/почему)
  POST   /runs/:rid/cancel
  GET    /versions/:vid/findings?status=&severity=
  GET    /projects/:id/findings?scope=complex
  PATCH  /findings/:fid                     статус / подтверждение-отклонение человеком

Заключения (сценарий 6)
  POST   /versions/:vid/reports             документное заключение → docx + json
  POST   /projects/:id/reports              комплексное заключение
  GET    /reports/:rid  |  GET /reports/:rid/file?format=docx|json

Версии и импакт (сценарий 7)
  GET    /sections/:sid/diff?from=&to=      дифф (кэшируется в diffs)
  GET    /diffs/:did/impact                 затронутые разделы/требования/замечания
  POST   /diffs/:did/impact/recheck         перепроверка затронутого (только его, остальное из кэша)
  PATCH  /impact/:iid                       propagated / dismissed / not_propagated

Справочники и служебное
  GET    /catalog/rules?applies_to=&severity=    каталог из rules/*.yaml (живьём с диска)
  GET    /catalog/ntd  |  GET /catalog/wordings
  GET    /health                            БД, pgvector, embedding-модель, каталог правил
```

### Решения, заложенные в схему

- **Идемпотентность** — `analysis_runs.cache_key` = хэш(содержимое версии + каталог правил + параметры модели с seed/t=0): повторный анализ той же версии не запускает модель, а отдаёт готовый результат.
- **Двойная кодировка замечаний** (`findings.codes`) — решение OQ-10 «обе редакции параллельно».
- **Цитаты с двух концов** обязательны для LLM-замечаний на уровне CHECK-ограничения; без них замечание рождается только со статусом `needs_human` (П43/П44, правило Этапа 3).
- **`date_started`** в проекте — операционализация OQ-11 (выбор редакции перечней).
- **`local_only`** — принудительный override; штатно контур выбирается на шаг пайплайна по матрице «класс документа × контур» (А17-B), фиксируется в `analysis_runs.params`.
- **`ntd_chunks.embedding NOT NULL`** — урок инцидента с тихой переиндексацией базы знаний без векторов.
- **Правила не копируются в БД** — источник истины YAML; воспроизводимость даёт `rules_hash` + `rule_hash` снимки.

## Этап 3 — реализация (первый рабочий срез, 24.08.2026)

Код живёт в приложении Web: `server/routes/normo.js` (REST `/api/normo/*`),
`server/services/normo/*` (db, store, rules, checks/{run,deterministic,llm,verify},
ntd-corpus, input-data, complex, diff, report, report-payload), интерфейс —
`public/normo.html|js|css` (пункт «Нормоконтроль» в сайдбаре платформы).
Промты LLM-агентов — `prompts/normo-*.md` (правило платформы: текстов в коде нет).

Что работает (проверено тестами и живыми прогонами на реальных документах):
- **сценарии 1, 3, 4**: проект с предзаполненным составом (sections.yaml) →
  загрузка версии раздела (актуальная сменяется автоматически) → автозапуск прогона;
  174 правила каталога: детерминированный слой кодом (7 реализаций v1 —
  текстовый слой PDF, имена/размеры файлов 783/пр, рассинхрон обозначений в штампах
  docx, шифр раздела, XML/GUID смет), LLM-слой на локальной модели через адаптер
  платформы с RAG-заземлением; правила без реализации/без текста пункта в корпусе —
  в журнале прогона с причиной, молчаливых пропусков нет;
- **верификация цитат кодом** (checks/verify.js): цитата из документа + пункт НТД
  из корпуса (780 чанков с эмбеддингами: 21.101, 21.002, 21.501, 21.618, 7.0.97,
  7.0.8, 783/пр) — неподтверждённое живёт только как needs_human (CHECK в БД);
  «правило двух адресов» (А19): находки об отсутствии — всегда человеку;
- **сценарий 6**: заключение .docx по исправленной форме (блоки 1–7, 21.101-2020)
  + машиночитаемый JSON; галочки — агрегаты находок по conclusion-mapping;
  вердикты модуль не выставляет (П41) — только человек;
- **сценарий 7**: дифф версий по абзацам с привязкой к файлам, impact-анализ
  (замечания → needs_recheck, требования, смежные разделы → not_propagated),
  статусы замечаний предыдущей версии пересчитываются при новом прогоне;
- **сценарии 2, 5**: ИД → извлечение дословных требований (сверка кодом,
  не-дословное помечается) → комплексная проверка: состав по ПП 87 кодом,
  покрытие требований по разделам с цитатами-доказательствами, непокрытые — списком;
- **идемпотентность**: cache_key(содержимое версии + каталог + версии движков) —
  повтор отдаёт кэш; изменение кода проверок обязано менять VERSION слоя;
- **local_only**: LLM-слой работает только через локальную модель (lmstudio),
  облачный маршрут появится отдельным решением с матрицей контуров (А17-B).

Очередь (журналируется в прогонах как «очередь Этапа 3»): остальные детерминированные
реализации (~103), межраздельные LLM-сверки текстов пар разделов, добор текстов НТД
из Техэксперта (вернёт 72 кандидата и расширит LLM-покрытие), облачный маршрут
по матрице контуров, vision-ингест сканов (А1/А6).

## Дорожная карта этапов

- [x] Этап 0 — изучение источников (отчёт в scratchpad, журнал: knowledge/sources-index.md)
- [x] Этап 0-Б — сбор промт-техник из @ai_prompt_eng (decisions/prompt-techniques-review.md, согласован)
- [x] Этап 1 — база знаний (этот каталог)
- [x] Этап 2 — модель данных и сценарии: согласовано 24.08.2026 (раздел выше)
- [~] Этап 3 — реализация: первый рабочий срез 24.08.2026 (раздел выше) — все 7 сценариев
      сквозным путём, UI на платформе; в очереди добор реализаций правил, межраздельные
      LLM-сверки, Техэксперт, облачный маршрут
