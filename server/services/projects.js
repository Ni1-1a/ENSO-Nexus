'use strict';
/**
 * Проекты платформы — единица работы, внутри которой живут все модули.
 *
 * Решение владельца 02.09.2026: сначала заводится проект, потом в нём
 * выбирается модуль; модули стоят в порядке надобности проекту:
 *   1 Анализ ТЗ → 2 Посадка здания → 3 Проверка документа →
 *   4 Нормоконтроль → 5 Контроль ГГЭ → 6 Акты (АОСР).
 *
 * Сущности модулей привязаны к проекту колонкой project_id: sessions (посадка),
 * tz_projects, doccheck_checks, doccheck_ab — в основной SQLite; проекты
 * нормоконтроля — колонкой platform_project_id в его PostgreSQL. Акты и ГГЭ
 * ничего не хранят, за них проект помнит только отметку последнего прогона
 * (project_marks). Всё, что было заведено ДО появления проектов, переезжает
 * в проект «Ранние работы» (id 'legacy'): ничего не теряется и не прячется.
 *
 * Сводка по модулям (summarize) собирается здесь, а не на клиенте: четыре
 * варианта отображения читают одни и те же строки состояния.
 */
const crypto = require('node:crypto');
const config = require('../config');
const { db, now } = require('../db');

const LEGACY_ID = 'legacy';
/** Порядок модулей — порядок надобности проекту. Ключи общие с клиентом. */
const MODULES = ['tz', 'site', 'doc', 'normo', 'gge', 'akty'];
const ID_RE = /^[\w-]{1,64}$/;

db.exec(`
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,                       -- короткое имя: АВИВАК-2
  full_name TEXT NOT NULL DEFAULT '',       -- полное название объекта
  client TEXT NOT NULL DEFAULT '',          -- заказчик
  stage TEXT NOT NULL DEFAULT '',           -- предпроект / П / Р / П+Р / стройка
  note TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL DEFAULT '',
  created_by_name TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_projects_alive ON projects(deleted_at, updated_at);
CREATE TABLE IF NOT EXISTS project_marks (
  project_id TEXT NOT NULL,
  module TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  by_name TEXT NOT NULL DEFAULT '',
  last_at TEXT NOT NULL,
  PRIMARY KEY (project_id, module)
);
`);

const userName = (user) => (user ? `${user.lastName || ''} ${user.firstName || ''}`.trim() : '');
const normId = (v) => (ID_RE.test(String(v || '').trim()) ? String(v).trim() : '');
const clip = (v, n) => String(v == null ? '' : v).trim().slice(0, n);

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

/** Поля проекта — строки; число, массив или null раньше молча превращались в «5» и «». */
function assertStrings(fields) {
  for (const key of Object.keys(EDITABLE)) {
    if (fields[key] !== undefined && typeof fields[key] !== 'string') {
      throw httpError(400, `Поле ${key} должно быть строкой`);
    }
  }
}

/**
 * Привязка сущности модуля к проекту платформы — единое правило для сессий,
 * ТЗ, проверок документов и нормоконтроля:
 *  - пусто → «Ранние работы» (проект заводится тут же, id 'legacy');
 *  - не по форме идентификатора → 400;
 *  - нет или мягко удалён → 404. Раньше такая запись принималась молча и
 *    исчезала из всех списков: ни в одном проекте её не было.
 */
function resolveProjectId(raw, user) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) { ensureLegacy(); return { id: LEGACY_ID }; }
  if (!ID_RE.test(s)) throw httpError(400, 'Некорректный идентификатор проекта');
  const project = byId(s);
  if (!project) throw httpError(404, 'Проект не найден');
  if (!canSee(project, user)) throw httpError(403, 'Это чужой проект');
  return { id: s };
}

/** ?project= в списках: пусто — все записи; не по форме — 400, чужой — 403. */
function filterId(raw, user) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return '';
  if (!ID_RE.test(s)) throw httpError(400, 'Некорректный идентификатор проекта');
  const project = byId(s);
  if (project && !canSee(project, user)) throw httpError(403, 'Это чужой проект');
  return s;
}

/*
 * Решение владельца 02.09.2026: у каждого человека свой набор проектов, править
 * можно свои. Владелец платформы (owner в users.json) видит и правит всё.
 * «Ранние работы» — общий приёмник записей до появления проектов: читают все,
 * правит владелец. При выключенном входе (REQUIRE_LOGIN=0) ограничений нет.
 */
function canEdit(project, user) {
  if (!project) return false;
  if (!config.requireLogin) return true;
  if (!user) return false;
  if (user.owner === true) return true;
  return !!project.created_by && project.created_by === user.id;
}
function canSee(project, user) {
  if (!project) return false;
  return project.id === LEGACY_ID || canEdit(project, user);
}

function plural(n, one, few, many) {
  const m10 = n % 10; const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return `${n} ${one}`;
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return `${n} ${few}`;
  return `${n} ${many}`;
}

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${dd}.${mm}.${d.getFullYear()}`;
}

/* ---------------- CRUD ---------------- */

function create({ name, fullName, client, stage, note, user, id }) {
  assertStrings({ name, fullName, client, stage, note });
  const pid = id || crypto.randomUUID();
  db.prepare(`INSERT INTO projects
      (id, name, full_name, client, stage, note, created_by, created_by_name, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(pid, clip(name, 120), clip(fullName, 300), clip(client, 200), clip(stage, 40), clip(note, 2000),
      (user && user.id) || '', userName(user), now(), now());
  return byId(pid);
}

function byId(id) {
  return db.prepare('SELECT * FROM projects WHERE id = ? AND deleted_at IS NULL').get(id) || null;
}

/** Проекты, видимые человеку: свои (+ «Ранние работы»); владельцу — все. */
function list(user) {
  return db.prepare('SELECT * FROM projects WHERE deleted_at IS NULL ORDER BY updated_at DESC').all()
    .filter((p) => canSee(p, user));
}

const EDITABLE = { name: 120, fullName: 300, client: 200, stage: 40, note: 2000 };
const COLUMN = { name: 'name', fullName: 'full_name', client: 'client', stage: 'stage', note: 'note' };

function update(id, fields) {
  assertStrings(fields);
  const sets = []; const vals = [];
  for (const [key, max] of Object.entries(EDITABLE)) {
    if (fields[key] === undefined) continue;
    sets.push(`${COLUMN[key]} = ?`); vals.push(clip(fields[key], max));
  }
  if (!sets.length) return byId(id);
  sets.push('updated_at = ?'); vals.push(now(), id);
  db.prepare(`UPDATE projects SET ${sets.join(', ')} WHERE id = ? AND deleted_at IS NULL`).run(...vals);
  return byId(id);
}

/** Мягкое удаление: сущности модулей остаются на месте и читаемы по прямым ссылкам. */
function remove(id) {
  // приёмник ранних записей удалять нельзя — всё, что в нём, стало бы сиротами
  if (id === LEGACY_ID) throw httpError(400, 'Проект «Ранние работы» удалить нельзя');
  return db.prepare('UPDATE projects SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL')
    .run(now(), now(), id).changes > 0;
}

/** Проект «ожил»: в нём что-то завели или прогнали. */
function touch(id) {
  if (!id) return;
  try { db.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(now(), id); } catch { /* нет проекта — не страшно */ }
}

/** Модули без хранения: только у них проект помнит отметку прогона. */
const MARK_MODULES = ['gge', 'akty'];

/** Отметка прогона модуля без хранения (акты, ГГЭ): дата и короткая заметка. */
function mark(projectId, module, note, user) {
  if (!MARK_MODULES.includes(module) || !byId(projectId)) return false;
  db.prepare(`INSERT INTO project_marks (project_id, module, note, by_name, last_at) VALUES (?,?,?,?,?)
      ON CONFLICT(project_id, module) DO UPDATE SET note = excluded.note, by_name = excluded.by_name, last_at = excluded.last_at`)
    .run(projectId, module, clip(note, 200), userName(user), now());
  touch(projectId);
  return true;
}

/* ---------------- ранние работы ---------------- */

function ensureLegacy() {
  if (db.prepare('SELECT 1 FROM projects WHERE id = ?').get(LEGACY_ID)) {
    db.prepare('UPDATE projects SET deleted_at = NULL WHERE id = ?').run(LEGACY_ID);
    return byId(LEGACY_ID);
  }
  return create({
    id: LEGACY_ID,
    name: 'Ранние работы',
    fullName: 'Сессии, проверки и проекты, заведённые до появления проектов платформы',
    client: '',
    stage: '',
  });
}

/**
 * Всё без проекта переезжает в «Ранние работы». Идемпотентно: повторный
 * запуск ничего не трогает. Вызывается при старте приложения, когда таблицы
 * модулей уже созданы (их заводят сами модули при require).
 */
function migrateLegacy() {
  let moved = 0;
  for (const table of ['sessions', 'tz_projects', 'doccheck_checks', 'doccheck_ab']) {
    try {
      moved += db.prepare(`UPDATE ${table} SET project_id = ? WHERE project_id = ''`).run(LEGACY_ID).changes;
    } catch { /* таблицы или колонки ещё нет — модуль не подключён */ }
  }
  if (moved) {
    ensureLegacy();
    console.log(`[projects] в «Ранние работы» переведено записей: ${moved}`);
  }
  return moved;
}

/* ---------------- сводка по модулям ---------------- */

const NONE = (line) => ({ state: 'none', count: 0, line });

function summarizeSite(id) {
  const row = db.prepare(`SELECT count(*) AS n, max(updated_at) AS at FROM sessions
      WHERE project_id = ? AND status = 'active'`).get(id);
  if (!row || !row.n) return NONE('Не запускалась');
  const last = db.prepare(`SELECT job_status AS st, title FROM sessions
      WHERE project_id = ? AND status = 'active' ORDER BY updated_at DESC LIMIT 1`).get(id);
  const n = plural(row.n, 'сессия', 'сессии', 'сессий');
  const st = last ? last.st : 'idle';
  if (st === 'queued' || st === 'running') return { state: 'run', count: row.n, line: `${n} · идёт анализ`, at: row.at };
  if (st === 'needs_clarification' || st === 'awaiting_approval') return { state: 'warn', count: row.n, line: `${n} · ждёт ответа человека`, at: row.at };
  if (st === 'failed') return { state: 'bad', count: row.n, line: `${n} · последняя упала`, at: row.at };
  if (st === 'completed') return { state: 'ok', count: row.n, line: `${n} · последняя завершена`, at: row.at };
  return { state: 'none', count: row.n, line: `${n} · без прогона`, at: row.at };
}

function summarizeTz(id) {
  const row = db.prepare(`SELECT count(*) AS n, max(updated_at) AS at FROM tz_projects
      WHERE project_id = ? AND deleted_at IS NULL`).get(id);
  if (!row || !row.n) return NONE('Не запускался');
  const run = db.prepare(`SELECT r.status, r.result_json FROM tz_runs r
      JOIN tz_projects p ON p.id = r.project_id
      WHERE p.project_id = ? AND p.deleted_at IS NULL ORDER BY r.created_at DESC LIMIT 1`).get(id);
  const n = plural(row.n, 'проверка', 'проверки', 'проверок');
  if (!run) return { state: 'none', count: row.n, line: `${n} · без прогона`, at: row.at };
  if (run.status === 'queued' || run.status === 'running') return { state: 'run', count: row.n, line: `${n} · идёт проверка`, at: row.at };
  if (run.status === 'failed') return { state: 'bad', count: row.n, line: `${n} · последняя упала`, at: row.at };
  let status = '';
  try { status = JSON.parse(run.result_json || '{}').verdict?.status || ''; } catch { status = ''; }
  const state = status === 'готово' ? 'ok' : status === 'условно готово' ? 'warn' : status ? 'bad' : 'ok';
  return { state, count: row.n, line: status ? `${n} · ${status}` : n, at: row.at };
}

function summarizeDoc(id) {
  const c = db.prepare(`SELECT count(*) AS n, max(updated_at) AS at FROM doccheck_checks
      WHERE project_id = ? AND deleted_at IS NULL`).get(id);
  const a = db.prepare(`SELECT count(*) AS n, max(updated_at) AS at,
      sum(status = 'running') AS running FROM doccheck_ab WHERE project_id = ? AND deleted_at IS NULL`).get(id);
  const total = (c?.n || 0) + (a?.n || 0);
  if (!total) return NONE('Не запускалась');
  const running = db.prepare(`SELECT count(*) AS n FROM doccheck_runs r
      JOIN doccheck_checks ch ON ch.id = r.check_id
      WHERE ch.project_id = ? AND ch.deleted_at IS NULL AND r.status IN ('queued','running')`).get(id);
  const parts = [];
  if (c?.n) parts.push(plural(c.n, 'проверка', 'проверки', 'проверок'));
  if (a?.n) parts.push(plural(a.n, 'сравнение', 'сравнения', 'сравнений'));
  const at = [c?.at, a?.at].filter(Boolean).sort().pop() || null;
  const busy = (running?.n || 0) + (a?.running || 0);
  if (busy) return { state: 'run', count: total, line: `${parts.join(' · ')} · ${plural(busy, 'идёт', 'идут', 'идут')}`, at };
  return { state: 'ok', count: total, line: parts.join(' · '), at };
}

function summarizeMark(id, module, verb) {
  const m = db.prepare('SELECT * FROM project_marks WHERE project_id = ? AND module = ?').get(id, module);
  if (!m) return NONE(verb);
  return { state: 'ok', count: 1, line: `Последний прогон ${fmtDate(m.last_at)}${m.note ? ` · ${m.note}` : ''}`, at: m.last_at };
}

/**
 * Сводка нормоконтроля живёт в его PostgreSQL: недоступна — так и говорим.
 * Отказ запоминается на NORMO_DOWN_MS: иначе каждый список проектов ждал бы
 * connectionTimeoutMillis (5 с) заново, и интерфейс «висел» на каждом открытии.
 */
const NORMO_DOWN_MS = 30_000;
let normoDownUntil = 0;

async function normoByProject(ids) {
  if (Date.now() < normoDownUntil) return null;
  try {
    const store = require('./normo/store');
    const out = await store.summaryByPlatform(ids);
    normoDownUntil = 0;
    return out;
  } catch (err) {
    normoDownUntil = Date.now() + NORMO_DOWN_MS;
    console.warn(`[projects] база нормоконтроля недоступна, ${NORMO_DOWN_MS / 1000} с не опрашивается: ${err.message}`);
    return null;
  }
}

/** Для тестов: забыть, что база была недоступна. */
function _resetNormoDown() { normoDownUntil = 0; }

/**
 * Сводка по модулям для списка проектов. Одна поездка в PostgreSQL на весь
 * список, остальное — SQLite. Строки уже по-русски: все варианты отображения
 * показывают их как есть.
 */
async function summarize(ids) {
  const normo = await normoByProject(ids);
  const out = {};
  for (const id of ids) {
    const nm = normo === null
      ? { state: 'off', count: 0, line: 'База нормоконтроля недоступна' }
      : normo[id]
        ? {
          state: normo[id].open_findings > 0 ? 'warn' : 'ok',
          count: normo[id].projects,
          line: `${plural(normo[id].sections, 'раздел', 'раздела', 'разделов')} · ${normo[id].open_findings
            ? plural(normo[id].open_findings, 'открытое замечание', 'открытых замечания', 'открытых замечаний')
            : 'открытых замечаний нет'}`,
        }
        : NONE('Не запускался');
    out[id] = {
      tz: summarizeTz(id),
      site: summarizeSite(id),
      doc: summarizeDoc(id),
      normo: nm,
      gge: summarizeMark(id, 'gge', 'Не запускался'),
      akty: summarizeMark(id, 'akty', 'Не запускались'),
    };
  }
  return out;
}

module.exports = {
  LEGACY_ID, MODULES, MARK_MODULES, normId, resolveProjectId, filterId,
  create, byId, list, update, remove, touch, mark, canEdit, canSee,
  ensureLegacy, migrateLegacy, summarize, _resetNormoDown,
};
