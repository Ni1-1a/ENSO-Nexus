-- Модуль «Нормоконтроль»: схема БД (PostgreSQL + pgvector).
-- Источник проекта: нормоконтроль/README.md, раздел «Этап 2» (согласован 24.08.2026).
-- Миграция идемпотентна: только IF NOT EXISTS, запускается при каждом старте.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS files (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sha256        TEXT NOT NULL UNIQUE,
  path          TEXT NOT NULL,
  size_bytes    BIGINT NOT NULL,
  mime          TEXT,
  original_name TEXT NOT NULL,
  uploaded_by   TEXT,
  uploaded_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS projects (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name         TEXT NOT NULL,
  customer     TEXT,
  stage        TEXT NOT NULL CHECK (stage IN ('П','Р','П+Р')),
  object_kind  TEXT NOT NULL DEFAULT 'непроизводственный'
               CHECK (object_kind IN ('производственный','непроизводственный','линейный')),
  date_started DATE NOT NULL,
  local_only   BOOLEAN NOT NULL DEFAULT FALSE,
  owner_user   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at  TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS sections (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  project_id     BIGINT NOT NULL REFERENCES projects ON DELETE CASCADE,
  code           TEXT NOT NULL,
  name           TEXT NOT NULL,
  required       BOOLEAN NOT NULL DEFAULT TRUE,
  required_basis TEXT,
  sort_order     INT NOT NULL DEFAULT 0,
  UNIQUE (project_id, code)
);

CREATE TABLE IF NOT EXISTS section_versions (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  section_id   BIGINT NOT NULL REFERENCES sections ON DELETE CASCADE,
  version_no   INT NOT NULL,
  stage        TEXT NOT NULL CHECK (stage IN ('П','Р')),
  author       TEXT,
  uploaded_by  TEXT,
  uploaded_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  content_hash TEXT NOT NULL,
  is_current   BOOLEAN NOT NULL DEFAULT TRUE,
  note         TEXT,
  UNIQUE (section_id, version_no)
);
CREATE UNIQUE INDEX IF NOT EXISTS one_current_version
  ON section_versions (section_id) WHERE is_current;

CREATE TABLE IF NOT EXISTS section_version_files (
  version_id BIGINT NOT NULL REFERENCES section_versions ON DELETE CASCADE,
  file_id    BIGINT NOT NULL REFERENCES files,
  PRIMARY KEY (version_id, file_id)
);

CREATE TABLE IF NOT EXISTS input_data (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  project_id  BIGINT NOT NULL REFERENCES projects ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('ТЗ','ТУ','ГПЗУ','изыскания','задание_смежника','прочее')),
  title       TEXT NOT NULL,
  version_no  INT NOT NULL DEFAULT 1,
  is_current  BOOLEAN NOT NULL DEFAULT TRUE,
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS input_data_files (
  input_id BIGINT NOT NULL REFERENCES input_data ON DELETE CASCADE,
  file_id  BIGINT NOT NULL REFERENCES files,
  PRIMARY KEY (input_id, file_id)
);

CREATE TABLE IF NOT EXISTS requirements (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  input_id        BIGINT NOT NULL REFERENCES input_data ON DELETE CASCADE,
  seq             INT NOT NULL,
  text            TEXT NOT NULL,
  source_doc      TEXT NOT NULL,
  source_clause   TEXT,
  addressee_codes TEXT[] NOT NULL DEFAULT '{}',
  status          TEXT NOT NULL DEFAULT 'new'
                  CHECK (status IN ('new','covered','partial','not_covered','conflict','dropped')),
  embedding       vector(1024)
);

CREATE TABLE IF NOT EXISTS requirement_coverage (
  requirement_id BIGINT NOT NULL REFERENCES requirements ON DELETE CASCADE,
  version_id     BIGINT NOT NULL REFERENCES section_versions ON DELETE CASCADE,
  status         TEXT NOT NULL CHECK (status IN ('covered','partial','contradicts')),
  evidence_quote TEXT NOT NULL,
  location       JSONB,
  confirmed_by   TEXT NOT NULL CHECK (confirmed_by IN ('llm','human')),
  run_id         BIGINT,
  PRIMARY KEY (requirement_id, version_id)
);

CREATE TABLE IF NOT EXISTS analysis_runs (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  project_id  BIGINT NOT NULL REFERENCES projects ON DELETE CASCADE,
  version_id  BIGINT REFERENCES section_versions,
  scope       TEXT NOT NULL CHECK (scope IN ('document','complex','ingest_id','diff','impact')),
  rules_hash  TEXT NOT NULL,
  params      JSONB NOT NULL,
  cache_key   TEXT NOT NULL UNIQUE,
  status      TEXT NOT NULL DEFAULT 'queued'
              CHECK (status IN ('queued','running','done','failed','cancelled')),
  started_at  TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  error       TEXT
);

CREATE TABLE IF NOT EXISTS run_rules (
  run_id      BIGINT NOT NULL REFERENCES analysis_runs ON DELETE CASCADE,
  rule_id     TEXT NOT NULL,
  outcome     TEXT NOT NULL CHECK (outcome IN ('ok','finding','skipped','error')),
  skip_reason TEXT,
  duration_ms INT,
  PRIMARY KEY (run_id, rule_id)
);

CREATE TABLE IF NOT EXISTS findings (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id         BIGINT NOT NULL REFERENCES analysis_runs,
  version_id     BIGINT NOT NULL REFERENCES section_versions,
  rule_id        TEXT NOT NULL,
  rule_hash      TEXT NOT NULL,
  origin         TEXT NOT NULL CHECK (origin IN ('deterministic','llm','manual')),
  severity       TEXT NOT NULL CHECK (severity IN ('critical','major','minor','remark')),
  status         TEXT NOT NULL DEFAULT 'open'
                 CHECK (status IN ('open','fixed','rejected','accepted_with_deviation')),
  verification   TEXT NOT NULL DEFAULT 'auto'
                 CHECK (verification IN ('auto','needs_human','human_confirmed','human_rejected')),
  location       JSONB NOT NULL,
  doc_quote      TEXT,
  ntd            TEXT NOT NULL,
  ntd_clause     TEXT,
  ntd_quote      TEXT,
  wording        TEXT NOT NULL,
  fix_hint       TEXT,
  confidence     REAL,
  codes          JSONB NOT NULL DEFAULT '{}',
  predecessor_id BIGINT REFERENCES findings,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Правило Этапа 3: LLM-замечание без цитат с обеих сторон живёт только как needs_human.
  CHECK (origin <> 'llm'
         OR (doc_quote IS NOT NULL AND ntd_clause IS NOT NULL AND ntd_quote IS NOT NULL)
         OR verification = 'needs_human')
);
CREATE INDEX IF NOT EXISTS findings_by_version ON findings (version_id, status);

CREATE TABLE IF NOT EXISTS reports (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  project_id        BIGINT NOT NULL REFERENCES projects ON DELETE CASCADE,
  scope             TEXT NOT NULL CHECK (scope IN ('document','complex')),
  version_id        BIGINT REFERENCES section_versions,
  run_id            BIGINT REFERENCES analysis_runs,
  reviewer          TEXT NOT NULL,
  checked_at        DATE NOT NULL,
  verdict_compliant BOOLEAN,
  verdict_approved  BOOLEAN,
  form_payload      JSONB NOT NULL,
  docx_file         BIGINT REFERENCES files,
  status            TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','issued')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS diffs (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  section_id   BIGINT NOT NULL REFERENCES sections ON DELETE CASCADE,
  from_version BIGINT NOT NULL REFERENCES section_versions,
  to_version   BIGINT NOT NULL REFERENCES section_versions,
  computed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  items        JSONB NOT NULL,
  UNIQUE (section_id, from_version, to_version)
);

CREATE TABLE IF NOT EXISTS impact_links (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  diff_id     BIGINT NOT NULL REFERENCES diffs ON DELETE CASCADE,
  item_index  INT NOT NULL,
  target_type TEXT NOT NULL CHECK (target_type IN ('section','requirement','finding')),
  target_id   BIGINT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending','needs_recheck','not_propagated','propagated','dismissed')),
  note        TEXT,
  updated_by  TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ntd_docs (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code       TEXT NOT NULL UNIQUE,
  title      TEXT NOT NULL,
  edition    TEXT,
  status     TEXT,
  system     TEXT,
  role       TEXT,
  source     TEXT NOT NULL DEFAULT 'корпус' CHECK (source IN ('корпус','техэксперт')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ntd_chunks (
  id        BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  doc_id    BIGINT NOT NULL REFERENCES ntd_docs ON DELETE CASCADE,
  clause    TEXT NOT NULL,
  parent    TEXT,
  heading   TEXT,
  body      TEXT NOT NULL,
  chunk_no  INT NOT NULL DEFAULT 0,
  tsv       TSVECTOR GENERATED ALWAYS AS (to_tsvector('russian', body)) STORED,
  -- Вектор обязателен: чанк без эмбеддинга — ошибка загрузки корпуса,
  -- а не тихая деградация поиска (инцидент базы знаний, август 2026).
  embedding vector(1024) NOT NULL,
  UNIQUE (doc_id, clause, chunk_no)
);
CREATE INDEX IF NOT EXISTS ntd_chunks_tsv ON ntd_chunks USING gin (tsv);
CREATE INDEX IF NOT EXISTS ntd_chunks_vec ON ntd_chunks USING hnsw (embedding vector_cosine_ops);

-- Аддитивные миграции (по образцу db.js приложения — только ADD COLUMN IF NOT EXISTS)
ALTER TABLE projects ADD COLUMN IF NOT EXISTS service_session_id TEXT;
-- Комплексные находки уровня проекта (состав разделов) не привязаны к версии
ALTER TABLE findings ALTER COLUMN version_id DROP NOT NULL;

-- Проект платформы (services/projects.js, 2026-09-02): всё, что было без него,
-- живёт в «Ранних работах» (id 'legacy'); UPDATE идемпотентен.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS platform_project_id TEXT;
UPDATE projects SET platform_project_id = 'legacy' WHERE platform_project_id IS NULL;
CREATE INDEX IF NOT EXISTS projects_platform_idx ON projects(platform_project_id);
