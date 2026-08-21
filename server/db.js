'use strict';
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const config = require('./config');

fs.mkdirSync(config.dataDir, { recursive: true });
fs.mkdirSync(path.join(config.dataDir, 'uploads'), { recursive: true });
fs.mkdirSync(path.join(config.dataDir, 'outputs'), { recursive: true });

const db = new DatabaseSync(path.join(config.dataDir, 'app.db'));
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  token TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',           -- active | deleted
  job_status TEXT NOT NULL DEFAULT 'idle',         -- idle | queued | running | needs_clarification | completed | failed
  comment TEXT DEFAULT '',
  summary TEXT DEFAULT '',                         -- rolling conversation summary (memory)
  prompt_version TEXT,
  ai_requests INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL,                              -- user | assistant | system
  kind TEXT NOT NULL DEFAULT 'chat',               -- chat | comment | answer | result | error
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, created_at);
CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  original_name TEXT NOT NULL,
  stored_path TEXT NOT NULL,
  size INTEGER NOT NULL,
  ext TEXT NOT NULL,
  mime TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS questions (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  why TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',          -- pending | answered | needs_followup | closed
  answer TEXT,
  created_at TEXT NOT NULL,
  answered_at TEXT
);
CREATE TABLE IF NOT EXISTS facts (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  source TEXT DEFAULT '',
  created_at TEXT NOT NULL,
  UNIQUE(session_id, key)
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  stage TEXT NOT NULL,
  detail TEXT DEFAULT '',
  level TEXT NOT NULL DEFAULT 'info',              -- info | warn | error
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS results (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  title TEXT DEFAULT '',
  format TEXT NOT NULL,
  size INTEGER NOT NULL,
  stored_path TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`);

// лёгкие миграции: добавление колонок в существующие таблицы
for (const sql of [
  "ALTER TABLE sessions ADD COLUMN ai_provider TEXT DEFAULT ''",
  "ALTER TABLE sessions ADD COLUMN ai_model TEXT DEFAULT ''",
  "ALTER TABLE sessions ADD COLUMN kb_choice TEXT DEFAULT 'main'",
  'ALTER TABLE sessions ADD COLUMN cost_usd REAL NOT NULL DEFAULT 0',
  "ALTER TABLE sessions ADD COLUMN workplan TEXT DEFAULT ''", // пользовательский пайплайн (JSON)
  "ALTER TABLE questions ADD COLUMN options TEXT DEFAULT ''", // варианты ответа (JSON-массив строк)
  "ALTER TABLE sessions ADD COLUMN device_id TEXT DEFAULT ''", // привязка истории сессий к устройству
  "ALTER TABLE sessions ADD COLUMN title TEXT DEFAULT ''",     // название проекта (авто или заданное)
  'CREATE INDEX IF NOT EXISTS idx_sessions_device ON sessions(device_id)',
  // несколько чатов с помощником на проект, с группировкой по темам
  `CREATE TABLE IF NOT EXISTS chat_threads (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    title TEXT DEFAULT '',
    topic TEXT DEFAULT 'Общее',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  "ALTER TABLE messages ADD COLUMN thread_id TEXT DEFAULT ''", // '' = лента анализа проекта

  // Версии плана участка. Повторный разбор чертежей создаёт НОВУЮ версию, а не
  // переписывает старую: иначе аннотации, поставленные на прежней геометрии,
  // молча съедут (ТЗ, п. 74). Версия определяется отпечатком набора файлов.
  `CREATE TABLE IF NOT EXISTS plans (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    source_hash TEXT NOT NULL,
    geometry TEXT NOT NULL,
    coordinate_system TEXT DEFAULT '',
    created_at TEXT NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS idx_plans_session ON plans(session_id, version)',

  // Пользовательские выделения и комментарии к плану.
  // geometry хранится в координатах ПЛАНА (метры), а не экрана — зум и
  // панорамирование на сохранённое не влияют.
  `CREATE TABLE IF NOT EXISTS plan_annotations (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    plan_id TEXT NOT NULL,
    author TEXT DEFAULT '',
    geometry TEXT NOT NULL,
    geometry_type TEXT NOT NULL DEFAULT 'rect',
    comment TEXT DEFAULT '',
    status TEXT NOT NULL DEFAULT 'open',
    linked_message_id TEXT DEFAULT '',
    coordinate_system TEXT DEFAULT '',
    metadata TEXT DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS idx_annotations_session ON plan_annotations(session_id, plan_id)',

  // Запуски генерации вариантов посадки и сами варианты (ТЗ, п. 73).
  // Привязаны к версии плана: перегенерация не переписывает прошлый запуск.
  `CREATE TABLE IF NOT EXISTS placement_runs (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    plan_id TEXT NOT NULL,
    requirements TEXT NOT NULL,
    criterion TEXT DEFAULT 'maxArea',
    stats TEXT DEFAULT '',
    created_at TEXT NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS idx_runs_session ON placement_runs(session_id, created_at)',
  `CREATE TABLE IF NOT EXISTS placement_variants (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES placement_runs(id) ON DELETE CASCADE,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    number INTEGER NOT NULL,
    footprint TEXT NOT NULL,
    metrics TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'proposed',
    selected INTEGER NOT NULL DEFAULT 0,
    preview TEXT DEFAULT '',
    created_at TEXT NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS idx_variants_run ON placement_variants(run_id, number)',
  `CREATE TABLE IF NOT EXISTS placement_actions (
    id TEXT PRIMARY KEY,
    variant_id TEXT NOT NULL REFERENCES placement_variants(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    object_id TEXT DEFAULT '',
    title TEXT NOT NULL,
    volume REAL,
    unit TEXT DEFAULT '',
    classification TEXT DEFAULT '',
    requires_decision INTEGER NOT NULL DEFAULT 0,
    decision TEXT DEFAULT '',
    note TEXT DEFAULT '',
    created_at TEXT NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS idx_actions_variant ON placement_actions(variant_id)',

  // База критической инфраструктуры: по КЛАССАМ объектов, живёт между проектами
  // и переживает их удаление (ТЗ, п. 45). Подпись подтвердившего обязательна.
  `CREATE TABLE IF NOT EXISTS critical_objects (
    id TEXT PRIMARY KEY,
    signature TEXT NOT NULL UNIQUE,
    label TEXT NOT NULL,
    classification TEXT NOT NULL,
    basis TEXT DEFAULT '',
    validated_by TEXT DEFAULT '',
    validated_at TEXT DEFAULT '',
    note TEXT DEFAULT '',
    created_at TEXT NOT NULL
  )`,

  // Этап работы над проектом: анализ → вопросы → объекты и зоны → согласование
  // схемы → варианты посадки → выбор варианта → чертёж. Согласование живёт
  // в ленте диалога, поэтому этап нужен серверу: по нему решается, что делать
  // дальше и какую карточку показывать.
  "ALTER TABLE sessions ADD COLUMN stage TEXT NOT NULL DEFAULT 'idle'",
  // Проект принадлежит человеку. Правда о людях живёт в users.json (владелец
  // правит его руками), здесь — только ссылка: внешнего ключа на файл нет,
  // целостность проверяется кодом.
  "ALTER TABLE sessions ADD COLUMN user_id TEXT DEFAULT ''",
  'CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)',
  // Замечания человека к этапу. Хранятся отдельно от переписки: они уходят
  // в промпт следующего прогона и должны быть доступны без разбора ленты.
  `CREATE TABLE IF NOT EXISTS stage_notes (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    stage TEXT NOT NULL,
    note TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS idx_stage_notes_session ON stage_notes(session_id, created_at)',
  // Сообщение написано самой задачей (анализ, этап, сравнение), а не ответом
  // помощника. Очередь диалога выводится из ленты, и без этой пометки
  // сообщение «анализ упал» засчитывалось за ответ на вопрос человека —
  // вопрос, заданный во время анализа, исчезал молча.
  'ALTER TABLE messages ADD COLUMN from_job INTEGER NOT NULL DEFAULT 0',

  // Служебные обращения к модели считаются ОТДЕЛЬНО от запросов человека.
  // Лимит ai_requests заводился как предохранитель от бесконечного цикла, то есть
  // считал «сколько раз человек запустил машину». Когда распознавание сканов
  // перешло на выбранную модель, каждая страница стала таким же запросом — и ГПЗУ
  // на 17 страниц выбирал лимит в 25 штук ещё до начала анализа. Число служебных
  // вызовов ограничено самими документами (страницы и файлы), убежать оно не может,
  // а расход денег держит лимит токенов.
  'ALTER TABLE sessions ADD COLUMN ai_subrequests INTEGER NOT NULL DEFAULT 0',

  // Правки свойств объектов плана человеком: чем объект является на самом деле,
  // как он называется и переносится ли он. Ключ — НЕ id объекта: id выдаётся
  // разбором по порядку и меняется при следующем разборе того же чертежа.
  // Устойчивый ключ — файл + слой + сущность DXF (object_key); id хранится рядом
  // только для текущей версии плана.
  `CREATE TABLE IF NOT EXISTS plan_object_edits (
     id TEXT PRIMARY KEY,
     session_id TEXT NOT NULL,
     plan_id TEXT NOT NULL DEFAULT '',
     object_id TEXT NOT NULL DEFAULT '',
     object_key TEXT NOT NULL DEFAULT '',
     layer TEXT NOT NULL DEFAULT '',
     parser TEXT NOT NULL DEFAULT '',
     patch TEXT NOT NULL DEFAULT '',
     author TEXT NOT NULL DEFAULT '',
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   )`,
  'CREATE INDEX IF NOT EXISTS idx_object_edits_session ON plan_object_edits(session_id)',
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_object_edits_key ON plan_object_edits(session_id, object_key)',

  // Границы участка по ПОВОРОТНЫМ ТОЧКАМ из документа (ГПЗУ, выписка ЕГРН).
  //
  // Топосъёмка границ ЗУ может не содержать вовсе: в «МСК-47_Горбунки.dwg»
  // самый крупный контур на слоях с границами — покрытие 72 м², а участок по
  // ГПЗУ — 3700 м². Считать зоны и посадку по такому «участку» бессмысленно.
  // Координаты характерных точек в ГПЗУ есть всегда — они и хранятся здесь.
  // Точки — то, что прочла модель; полигон из них собирает код (parcel-source).
  `CREATE TABLE IF NOT EXISTS plan_parcel_source (
     session_id TEXT PRIMARY KEY,
     points TEXT NOT NULL DEFAULT '[]',
     meta TEXT NOT NULL DEFAULT '{}',
     author TEXT NOT NULL DEFAULT '',
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   )`,

  // Зоны ограничений живут ОТДЕЛЬНО от разбора чертежа.
  //
  // Раньше посчитанные зоны дописывались в site и весь site сохранялся обратно
  // в `plans.geometry`. Отсюда две беды сразу. Первая: в таблице планов, где
  // обязан лежать ЧИСТЫЙ разбор, оказывался план с уже наложенными правками
  // человека — обучающий пример врал, а ключ правки переставал совпадать
  // с объектом. Вторая, куда хуже: зоны замерзали. Человек помечал здание под
  // снос, шёл за вариантами посадки — и получал пятно, посчитанное ДО его
  // решения, потому что подбор вариантов читал `site.buildable` из плана.
  //
  // Поэтому здесь хранятся и сами зоны, и ПРАВИЛА, по которым они построены,
  // и отпечаток решений человека на момент расчёта. Совпал отпечаток — зоны
  // отдаются как есть; не совпал — движок пересобирает их по тем же правилам,
  // детерминированно и без единого обращения к модели.
  `CREATE TABLE IF NOT EXISTS plan_zones (
     plan_id TEXT PRIMARY KEY,
     session_id TEXT NOT NULL,
     rules TEXT NOT NULL DEFAULT '[]',
     zones TEXT NOT NULL DEFAULT '{}',
     edits_hash TEXT NOT NULL DEFAULT '',
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   )`,
  'CREATE INDEX IF NOT EXISTS idx_plan_zones_session ON plan_zones(session_id)',

  /*
   * Расход по одному запросу к модели — строка на каждое обращение.
   *
   * До этой таблицы расход существовал только итогами в самой сессии
   * (ai_requests, input_tokens, output_tokens, cost_usd). Итог отвечает на
   * вопрос «сколько всего», но не на «когда», «какой моделью» и «за чей счёт»:
   * из суммы нельзя достать ни график по дням, ни разбивку по моделям, ни
   * расход конкретного человека. Поэтому пишем событиями, а итоги в сессии
   * оставляем — на них держатся предохранители проекта.
   *
   * Задним числом это не восстановить: у прошлых прогонов есть только суммы.
   * Графики начинаются с появления таблицы, и вкладка говорит об этом прямо.
   */
  `CREATE TABLE IF NOT EXISTS usage_events (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     session_id TEXT NOT NULL,
     user_id TEXT DEFAULT '',
     provider TEXT DEFAULT '',
     model TEXT DEFAULT '',
     internal INTEGER NOT NULL DEFAULT 0,          -- служебный подзапрос: OCR страницы, конспект документа
     input_tokens INTEGER NOT NULL DEFAULT 0,      -- включая кэш-токены: их тоже оплачивают
     output_tokens INTEGER NOT NULL DEFAULT 0,
     cache_write_tokens INTEGER NOT NULL DEFAULT 0,
     cache_read_tokens INTEGER NOT NULL DEFAULT 0,
     cost_usd REAL NOT NULL DEFAULT 0,
     created_at TEXT NOT NULL
   )`,
  'CREATE INDEX IF NOT EXISTS idx_usage_created ON usage_events(created_at)',
  'CREATE INDEX IF NOT EXISTS idx_usage_user ON usage_events(user_id, created_at)',
  'CREATE INDEX IF NOT EXISTS idx_usage_session ON usage_events(session_id)',

  /*
   * Пополнения счёта у провайдера — вносятся руками.
   *
   * Остаток кредитов не отдаёт ни одна ручка Anthropic: в Admin API есть
   * участники, workspace, ключи, отчёты о расходе и лимитах — и ничего про
   * доступные кредиты (проверено по документации 21.08.2026). Живой баланс
   * даёт только Kimi. Поэтому для остальных остаток считается «внесено минус
   * потрачено» и помечается оценкой, а не выдаётся за биллинг.
   */
  `CREATE TABLE IF NOT EXISTS credit_topups (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     provider TEXT NOT NULL,
     amount_usd REAL NOT NULL,
     note TEXT DEFAULT '',
     happened_at TEXT NOT NULL,
     author TEXT DEFAULT '',
     created_at TEXT NOT NULL
   )`,
  'CREATE INDEX IF NOT EXISTS idx_topups_provider ON credit_topups(provider, happened_at)',
]) {
  try { db.exec(sql); } catch { /* колонка уже есть */ }
}

/*
 * Проекты, оставшиеся на исчезнувшей базе Гриши, переводятся на «Верифицировано».
 *
 * Это не косметика. Выбранная база хранится у проекта строкой, а поиск по
 * несуществующей базе не падает — он молча возвращает пустой список. Проект
 * продолжал бы работать, просто без единой нормативной выдержки в контексте,
 * и заметить это можно было бы только по качеству ответов.
 *
 * Список документов у обеих баз один и тот же, разбор у «Верифицировано»
 * лучше, так что перевод ничего не отнимает.
 */
try {
  const moved = db.prepare("UPDATE sessions SET kb_choice = 'verified' WHERE kb_choice = 'grisha'").run().changes;
  if (moved) console.log(`[kb] проектов переведено с базы Гриши на «Верифицировано»: ${moved}`);
} catch { /* колонки ещё нет — свежая база */ }

const now = () => new Date().toISOString();

module.exports = { db, now };
