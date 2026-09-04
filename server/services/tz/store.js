'use strict';
/**
 * Модуль «Анализ ТЗ»: хранение проектов, текста ЗнП и прогонов проверки.
 *
 * Таблицы модуль заводит сам (по образцу dataset/store.js): проверки ТЗ живут
 * ВНЕ сессий платформы и их TTL — заключение по заданию не имеет права
 * исчезнуть вместе с проектом «Этапа 1».
 *
 * Обращения к моделям идут через СЛУЖЕБНУЮ СЕССИЮ (sessions.status='service'),
 * как в датасете: весь стек адаптера — облачный гейт, учёт расхода, лимиты —
 * работает без правок. origin_host служебной сессии обновляется при каждом
 * запуске прогона: гейт .com/.ru обязан видеть адрес, С КОТОРОГО человек
 * запустил проверку, а не адрес первого запуска.
 */
const crypto = require('crypto');
const config = require('../../config');
const { db, now } = require('../../db');

db.exec(`
CREATE TABLE IF NOT EXISTS tz_projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  checklist TEXT NOT NULL DEFAULT 'production',
  ai_provider TEXT NOT NULL DEFAULT '',
  ai_model TEXT NOT NULL DEFAULT '',
  object_json TEXT NOT NULL DEFAULT '{}',
  document_text TEXT NOT NULL DEFAULT '',
  document_name TEXT NOT NULL DEFAULT '',
  document_note TEXT NOT NULL DEFAULT '',
  document_sha256 TEXT NOT NULL DEFAULT '',
  service_session_id TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL DEFAULT '',
  created_by_name TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_tz_projects_alive ON tz_projects(deleted_at, updated_at);
CREATE TABLE IF NOT EXISTS tz_runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  progress TEXT NOT NULL DEFAULT '',
  error_text TEXT NOT NULL DEFAULT '',
  provider TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  checklist TEXT NOT NULL DEFAULT '',
  document_text TEXT NOT NULL DEFAULT '',
  document_sha256 TEXT NOT NULL DEFAULT '',
  result_json TEXT NOT NULL DEFAULT '',
  started_by TEXT NOT NULL DEFAULT '',
  started_by_name TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  finished_at TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_tz_runs_project ON tz_runs(project_id, created_at);
CREATE TABLE IF NOT EXISTS tz_decisions (
  run_id TEXT NOT NULL,
  finding_id TEXT NOT NULL,
  decision TEXT NOT NULL DEFAULT '',
  decided_by TEXT NOT NULL DEFAULT '',
  decided_by_name TEXT NOT NULL DEFAULT '',
  decided_at TEXT NOT NULL,
  PRIMARY KEY (run_id, finding_id)
);
`);
// проект платформы, в котором живёт проверка ТЗ (services/projects.js, 2026-09-02)
try { db.exec("ALTER TABLE tz_projects ADD COLUMN project_id TEXT NOT NULL DEFAULT ''"); } catch { /* колонка уже есть */ }
try { db.exec('CREATE INDEX IF NOT EXISTS idx_tz_projects_project ON tz_projects(project_id, updated_at)'); } catch { /* уже есть */ }

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function userName(user) {
  if (!user) return '';
  return `${user.lastName || ''} ${user.firstName || ''}`.trim();
}

const sha256 = (text) => crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');

/* ---------------- проекты ---------------- */

function createProject({ name, checklist, provider, model, object, user, projectId }) {
  const id = crypto.randomUUID();
  db.prepare(`INSERT INTO tz_projects
      (id, name, checklist, ai_provider, ai_model, object_json, project_id, created_by, created_by_name, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, name, checklist, provider || '', model || '', JSON.stringify(object || {}), projectId || 'legacy',
      (user && user.id) || '', userName(user), now(), now());
  return projectById(id);
}

function projectById(id) {
  const row = db.prepare('SELECT * FROM tz_projects WHERE id = ? AND deleted_at IS NULL').get(id);
  if (!row) return null;
  let object = {};
  try { object = JSON.parse(row.object_json); } catch { object = {}; }
  return { ...row, object };
}

/** Строка задания и после мягкого удаления — для гейта доступа к его прогонам. */
function projectRowAny(id) {
  return db.prepare('SELECT id, project_id, created_by, deleted_at FROM tz_projects WHERE id = ?').get(id) || null;
}

/** ?project=<id платформы> — только проверки этого проекта; пусто — все. */
function listProjects({ projectId = '' } = {}) {
  return db.prepare(`SELECT p.id, p.name, p.checklist, p.ai_provider, p.ai_model, p.document_name, p.project_id,
      p.document_sha256 != '' AS has_document, length(p.document_text) AS document_chars,
      p.created_by_name, p.created_at, p.updated_at,
      (SELECT count(*) FROM tz_runs r WHERE r.project_id = p.id) AS run_count,
      (SELECT r.status FROM tz_runs r WHERE r.project_id = p.id ORDER BY r.created_at DESC LIMIT 1) AS last_run_status,
      (SELECT r.id FROM tz_runs r WHERE r.project_id = p.id ORDER BY r.created_at DESC LIMIT 1) AS last_run_id
      FROM tz_projects p WHERE p.deleted_at IS NULL AND (? = '' OR p.project_id = ?)
      ORDER BY p.updated_at DESC`).all(projectId, projectId);
}

function updateProject(id, { name, checklist, provider, model, object }) {
  const project = projectById(id);
  if (!project) throw httpError(404, 'Проект не найден');
  const next = {
    name: name !== undefined ? name : project.name,
    checklist: checklist !== undefined ? checklist : project.checklist,
    provider: provider !== undefined ? provider : project.ai_provider,
    model: model !== undefined ? model : project.ai_model,
    object: object !== undefined ? object : project.object,
  };
  db.prepare(`UPDATE tz_projects SET name = ?, checklist = ?, ai_provider = ?, ai_model = ?,
      object_json = ?, updated_at = ? WHERE id = ?`)
    .run(next.name, next.checklist, next.provider, next.model, JSON.stringify(next.object || {}), now(), id);
  return projectById(id);
}

function setDocument(id, { text, name, note }) {
  const project = projectById(id);
  if (!project) throw httpError(404, 'Проект не найден');
  db.prepare(`UPDATE tz_projects SET document_text = ?, document_name = ?, document_note = ?,
      document_sha256 = ?, updated_at = ? WHERE id = ?`)
    .run(text, name || '', note || '', sha256(text), now(), id);
  return projectById(id);
}

/** Мягкое удаление: прогоны остаются в базе — заключение может быть уже разослано. */
function deleteProject(id) {
  const r = db.prepare('UPDATE tz_projects SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL').run(now(), id);
  if (!r.changes) throw httpError(404, 'Проект не найден');
}

/* ---------------- служебная сессия ---------------- */

/**
 * Служебная сессия проекта ТЗ. TTL платформы её со временем удалит — тогда
 * заводится новая: результаты прогонов лежат в таблицах модуля, а расход
 * пишется в момент вызова модели.
 */
function ensureServiceSession(project, user, host = '') {
  if (project.service_session_id) {
    const row = db.prepare('SELECT id, origin_host FROM sessions WHERE id = ?').get(project.service_session_id);
    if (row) {
      if (host && row.origin_host !== host) {
        db.prepare('UPDATE sessions SET origin_host = ? WHERE id = ?').run(host, row.id);
      }
      return project.service_session_id;
    }
  }
  const id = crypto.randomUUID();
  // project_id — проекта платформы, в котором живёт задание: с пустым служебная
  // сессия при каждом перезапуске «переезжала» в «Ранние работы» (migrateLegacy)
  db.prepare(`INSERT INTO sessions (id, token, token_hash, status, device_id, user_id, prompt_version, origin_host, title, project_id, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, '', crypto.createHash('sha256').update(crypto.randomBytes(32)).digest('hex'), 'service', '',
    (user && user.id) || project.created_by || '', config.promptVersion, host,
    `Анализ ТЗ: ${project.name}`.slice(0, 60), project.project_id || 'legacy', now(), now());
  db.prepare('UPDATE tz_projects SET service_session_id = ? WHERE id = ?').run(id, project.id);
  return id;
}

/* ---------------- прогоны ---------------- */

function createRun(project, user) {
  const id = crypto.randomUUID();
  db.prepare(`INSERT INTO tz_runs (id, project_id, status, provider, model, checklist,
      document_text, document_sha256, started_by, started_by_name, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, project.id, 'queued', project.ai_provider, project.ai_model, project.checklist,
      project.document_text, project.document_sha256, (user && user.id) || '', userName(user), now());
  return runById(id);
}

function runById(id, { withText = false } = {}) {
  const row = db.prepare('SELECT * FROM tz_runs WHERE id = ?').get(id);
  if (!row) return null;
  let result = null;
  try { result = row.result_json ? JSON.parse(row.result_json) : null; } catch { result = null; }
  const decisions = {};
  for (const d of db.prepare('SELECT * FROM tz_decisions WHERE run_id = ?').all(id)) {
    decisions[d.finding_id] = { decision: d.decision, by: d.decided_by_name, at: d.decided_at };
  }
  const out = { ...row, result, decisions };
  if (!withText) delete out.document_text;
  delete out.result_json;
  return out;
}

function listRuns(projectId) {
  // nullif: у прогона без результата (queued/failed) result_json — пустая строка,
  // и json_extract на ней бросает «malformed JSON», роняя весь список
  return db.prepare(`SELECT id, project_id, status, progress, error_text, provider, model, checklist,
      document_sha256, started_by_name, created_at, finished_at,
      json_extract(nullif(result_json, ''), '$.verdict.status') AS verdict_status,
      json_extract(nullif(result_json, ''), '$.verdict.readiness_percent') AS readiness_percent,
      json_extract(nullif(result_json, ''), '$.verdict.blocking_count') AS blocking_count
      FROM tz_runs WHERE project_id = ? ORDER BY created_at DESC`).all(projectId);
}

function setRunStatus(id, status, { progress, error, result } = {}) {
  const sets = ['status = ?'];
  const args = [status];
  if (progress !== undefined) { sets.push('progress = ?'); args.push(progress); }
  if (error !== undefined) { sets.push('error_text = ?'); args.push(error); }
  if (result !== undefined) { sets.push('result_json = ?'); args.push(JSON.stringify(result)); }
  if (status === 'done' || status === 'failed') { sets.push('finished_at = ?'); args.push(now()); }
  args.push(id);
  db.prepare(`UPDATE tz_runs SET ${sets.join(', ')} WHERE id = ?`).run(...args);
}

function setRunProgress(id, progress) {
  db.prepare('UPDATE tz_runs SET progress = ? WHERE id = ?').run(progress, id);
}

/** Прерванные перезапуском сервера прогоны — честная ошибка, не вечное queued. */
function recoverInterrupted() {
  const r = db.prepare(`UPDATE tz_runs SET status = 'failed',
      error_text = 'Прогон прерван перезапуском сервера — запустите проверку повторно.',
      finished_at = ? WHERE status IN ('queued','running')`).run(now());
  if (r.changes) console.log(`[tz/recovery] прерванных прогонов: ${r.changes}`);
}

/* ---------------- решения по находкам ---------------- */

/**
 * Решение принимает ЧЕЛОВЕК: ФИО и дату пишет сервер из req.user, клиентские
 * значения игнорируются (то же правило, что у validated в датасете).
 */
function setDecision(runId, findingId, decision, user) {
  const run = runById(runId);
  if (!run) throw httpError(404, 'Прогон не найден');
  const known = ((run.result && run.result.findings) || []).some((f) => f.id === findingId);
  if (!known) throw httpError(404, 'Находка не найдена в этом прогоне');
  if (decision === null || decision === '') {
    db.prepare('DELETE FROM tz_decisions WHERE run_id = ? AND finding_id = ?').run(runId, findingId);
    return null;
  }
  if (!['accepted', 'rejected'].includes(decision)) {
    throw httpError(400, 'Допустимые решения: accepted, rejected или null (снять решение)');
  }
  db.prepare(`INSERT INTO tz_decisions (run_id, finding_id, decision, decided_by, decided_by_name, decided_at)
      VALUES (?,?,?,?,?,?)
      ON CONFLICT(run_id, finding_id) DO UPDATE SET decision = excluded.decision,
        decided_by = excluded.decided_by, decided_by_name = excluded.decided_by_name, decided_at = excluded.decided_at`)
    .run(runId, findingId, decision, (user && user.id) || '', userName(user), now());
  return { decision, by: userName(user), at: now() };
}

module.exports = {
  db, httpError, sha256, userName,
  createProject, projectById, projectRowAny, listProjects, updateProject, setDocument, deleteProject,
  ensureServiceSession,
  createRun, runById, listRuns, setRunStatus, setRunProgress, recoverInterrupted, setDecision,
};
