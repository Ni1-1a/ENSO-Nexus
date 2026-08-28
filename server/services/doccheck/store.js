'use strict';
/**
 * Модуль «Проверка документа»: хранение проверок, прогонов и решений.
 *
 * Устройство повторяет модуль «Анализ ТЗ» (services/tz/store.js): таблицы
 * в основной SQLite, модуль заводит их сам и живёт ВНЕ сессий платформы и их
 * TTL; обращения к моделям — через служебную сессию (sessions.status='service'),
 * чтобы весь стек адаптера — облачный гейт, учёт расхода, лимиты — работал
 * без правок. origin_host служебной сессии обновляется при каждом запуске:
 * гейт .com/.ru должен видеть адрес, с которого человек запустил проверку.
 *
 * Одна «проверка» (doccheck_checks) — один документ: имя, извлечённый текст,
 * классификация (двухслойная: догадка системы + выбор человека, человек
 * сильнее) и выбранная модель. Прогоны — отдельными строками: документ и
 * промпт снимаются в прогон на момент запуска.
 */
const crypto = require('crypto');
const config = require('../../config');
const { db, now } = require('../../db');

db.exec(`
CREATE TABLE IF NOT EXISTS doccheck_checks (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  ai_provider TEXT NOT NULL DEFAULT '',
  ai_model TEXT NOT NULL DEFAULT '',
  document_text TEXT NOT NULL DEFAULT '',
  document_name TEXT NOT NULL DEFAULT '',
  document_note TEXT NOT NULL DEFAULT '',
  document_sha256 TEXT NOT NULL DEFAULT '',
  detected_type TEXT NOT NULL DEFAULT '',
  detected_via TEXT NOT NULL DEFAULT '',
  detected_evidence TEXT NOT NULL DEFAULT '',
  chosen_type TEXT NOT NULL DEFAULT '',
  chosen_prompt_id TEXT NOT NULL DEFAULT '',
  service_session_id TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL DEFAULT '',
  created_by_name TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_doccheck_checks_alive ON doccheck_checks(deleted_at, updated_at);
CREATE TABLE IF NOT EXISTS doccheck_runs (
  id TEXT PRIMARY KEY,
  check_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  progress TEXT NOT NULL DEFAULT '',
  error_text TEXT NOT NULL DEFAULT '',
  provider TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  doc_type TEXT NOT NULL DEFAULT '',
  prompt_id TEXT NOT NULL DEFAULT '',
  prompt_sha256 TEXT NOT NULL DEFAULT '',
  document_text TEXT NOT NULL DEFAULT '',
  document_sha256 TEXT NOT NULL DEFAULT '',
  result_json TEXT NOT NULL DEFAULT '',
  started_by TEXT NOT NULL DEFAULT '',
  started_by_name TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  finished_at TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_doccheck_runs_check ON doccheck_runs(check_id, created_at);
CREATE TABLE IF NOT EXISTS doccheck_decisions (
  run_id TEXT NOT NULL,
  finding_id TEXT NOT NULL,
  decision TEXT NOT NULL DEFAULT '',
  decided_by TEXT NOT NULL DEFAULT '',
  decided_by_name TEXT NOT NULL DEFAULT '',
  decided_at TEXT NOT NULL,
  PRIMARY KEY (run_id, finding_id)
);
`);

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

/* ---------------- проверки ---------------- */

function createCheck({ name, provider, model, user }) {
  const id = crypto.randomUUID();
  db.prepare(`INSERT INTO doccheck_checks
      (id, name, ai_provider, ai_model, created_by, created_by_name, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?)`)
    .run(id, name, provider || '', model || '', (user && user.id) || '', userName(user), now(), now());
  return checkById(id);
}

function checkById(id) {
  return db.prepare('SELECT * FROM doccheck_checks WHERE id = ? AND deleted_at IS NULL').get(id) || null;
}

function listChecks() {
  return db.prepare(`SELECT c.id, c.name, c.ai_provider, c.ai_model, c.document_name,
      c.document_sha256 != '' AS has_document, length(c.document_text) AS document_chars,
      c.detected_type, c.detected_via, c.chosen_type, c.created_by_name, c.created_at, c.updated_at,
      (SELECT count(*) FROM doccheck_runs r WHERE r.check_id = c.id) AS run_count,
      (SELECT r.status FROM doccheck_runs r WHERE r.check_id = c.id ORDER BY r.created_at DESC LIMIT 1) AS last_run_status,
      (SELECT r.id FROM doccheck_runs r WHERE r.check_id = c.id ORDER BY r.created_at DESC LIMIT 1) AS last_run_id
      FROM doccheck_checks c WHERE c.deleted_at IS NULL ORDER BY c.updated_at DESC`).all();
}

function updateCheck(id, fields) {
  const check = checkById(id);
  if (!check) throw httpError(404, 'Проверка не найдена');
  const allowed = ['name', 'ai_provider', 'ai_model', 'chosen_type', 'chosen_prompt_id'];
  const sets = [];
  const args = [];
  for (const key of allowed) {
    if (fields[key] !== undefined) { sets.push(`${key} = ?`); args.push(String(fields[key])); }
  }
  if (sets.length) {
    sets.push('updated_at = ?');
    args.push(now(), id);
    db.prepare(`UPDATE doccheck_checks SET ${sets.join(', ')} WHERE id = ?`).run(...args);
  }
  return checkById(id);
}

function setDocument(id, { text, name, note }) {
  const check = checkById(id);
  if (!check) throw httpError(404, 'Проверка не найдена');
  // новый документ обнуляет прежнюю классификацию: она относилась к старому тексту
  db.prepare(`UPDATE doccheck_checks SET document_text = ?, document_name = ?, document_note = ?,
      document_sha256 = ?, detected_type = '', detected_via = '', detected_evidence = '',
      updated_at = ? WHERE id = ?`)
    .run(text, name || '', note || '', sha256(text), now(), id);
  return checkById(id);
}

function setDetected(id, { type, via, evidence }) {
  db.prepare(`UPDATE doccheck_checks SET detected_type = ?, detected_via = ?, detected_evidence = ?,
      updated_at = ? WHERE id = ?`)
    .run(type || '', via || '', evidence || '', now(), id);
}

function deleteCheck(id) {
  const r = db.prepare('UPDATE doccheck_checks SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL').run(now(), id);
  if (!r.changes) throw httpError(404, 'Проверка не найдена');
}

/* ---------------- служебная сессия ---------------- */

function ensureServiceSession(check, user, host = '') {
  if (check.service_session_id) {
    const row = db.prepare('SELECT id, origin_host FROM sessions WHERE id = ?').get(check.service_session_id);
    if (row) {
      if (host && row.origin_host !== host) {
        db.prepare('UPDATE sessions SET origin_host = ? WHERE id = ?').run(host, row.id);
      }
      return check.service_session_id;
    }
  }
  const id = crypto.randomUUID();
  db.prepare(`INSERT INTO sessions (id, token, status, device_id, user_id, prompt_version, origin_host, title, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
    id, crypto.randomBytes(32).toString('hex'), 'service', '',
    (user && user.id) || check.created_by || '', config.promptVersion, host,
    `Проверка документа: ${check.name}`.slice(0, 60), now(), now());
  db.prepare('UPDATE doccheck_checks SET service_session_id = ? WHERE id = ?').run(id, check.id);
  return id;
}

/* ---------------- прогоны ---------------- */

function createRun(check, user) {
  const id = crypto.randomUUID();
  db.prepare(`INSERT INTO doccheck_runs (id, check_id, status, provider, model,
      document_text, document_sha256, started_by, started_by_name, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(id, check.id, 'queued', check.ai_provider, check.ai_model,
      check.document_text, check.document_sha256, (user && user.id) || '', userName(user), now());
  return runById(id);
}

function runById(id, { withText = false } = {}) {
  const row = db.prepare('SELECT * FROM doccheck_runs WHERE id = ?').get(id);
  if (!row) return null;
  let result = null;
  try { result = row.result_json ? JSON.parse(row.result_json) : null; } catch { result = null; }
  const decisions = {};
  for (const d of db.prepare('SELECT * FROM doccheck_decisions WHERE run_id = ?').all(id)) {
    decisions[d.finding_id] = { decision: d.decision, by: d.decided_by_name, at: d.decided_at };
  }
  const out = { ...row, result, decisions };
  if (!withText) delete out.document_text;
  delete out.result_json;
  return out;
}

function listRuns(checkId) {
  // nullif — как в tz/store.js: у прогона без результата result_json пуст,
  // и json_extract на пустой строке роняет весь список
  return db.prepare(`SELECT id, check_id, status, progress, error_text, provider, model,
      doc_type, prompt_id, document_sha256, started_by_name, created_at, finished_at,
      json_extract(nullif(result_json, ''), '$.summary.findings_count') AS findings_count,
      json_extract(nullif(result_json, ''), '$.summary.ntd_refs_count') AS ntd_refs_count
      FROM doccheck_runs WHERE check_id = ? ORDER BY created_at DESC`).all(checkId);
}

function setRunRoute(id, { docType, promptId, promptSha }) {
  db.prepare('UPDATE doccheck_runs SET doc_type = ?, prompt_id = ?, prompt_sha256 = ? WHERE id = ?')
    .run(docType || '', promptId || '', promptSha || '', id);
}

function setRunStatus(id, status, { progress, error, result } = {}) {
  const sets = ['status = ?'];
  const args = [status];
  if (progress !== undefined) { sets.push('progress = ?'); args.push(progress); }
  if (error !== undefined) { sets.push('error_text = ?'); args.push(error); }
  if (result !== undefined) { sets.push('result_json = ?'); args.push(JSON.stringify(result)); }
  if (status === 'done' || status === 'failed') { sets.push('finished_at = ?'); args.push(now()); }
  args.push(id);
  db.prepare(`UPDATE doccheck_runs SET ${sets.join(', ')} WHERE id = ?`).run(...args);
}

function setRunProgress(id, progress) {
  db.prepare('UPDATE doccheck_runs SET progress = ? WHERE id = ?').run(progress, id);
}

/** Прерванные перезапуском сервера прогоны — честная ошибка, не вечное queued. */
function recoverInterrupted() {
  const r = db.prepare(`UPDATE doccheck_runs SET status = 'failed',
      error_text = 'Прогон прерван перезапуском сервера — запустите проверку повторно.',
      finished_at = ? WHERE status IN ('queued','running')`).run(now());
  if (r.changes) console.log(`[doccheck/recovery] прерванных прогонов: ${r.changes}`);
}

/* ---------------- решения по находкам ---------------- */

/** Решение принимает ЧЕЛОВЕК: ФИО и дату пишет сервер из req.user (правило датасета). */
function setDecision(runId, findingId, decision, user) {
  const run = runById(runId);
  if (!run) throw httpError(404, 'Прогон не найден');
  const known = ((run.result && run.result.findings) || []).some((f) => f.id === findingId);
  if (!known) throw httpError(404, 'Находка не найдена в этом прогоне');
  if (decision === null || decision === '') {
    db.prepare('DELETE FROM doccheck_decisions WHERE run_id = ? AND finding_id = ?').run(runId, findingId);
    return null;
  }
  if (!['accepted', 'rejected'].includes(decision)) {
    throw httpError(400, 'Допустимые решения: accepted, rejected или null (снять решение)');
  }
  db.prepare(`INSERT INTO doccheck_decisions (run_id, finding_id, decision, decided_by, decided_by_name, decided_at)
      VALUES (?,?,?,?,?,?)
      ON CONFLICT(run_id, finding_id) DO UPDATE SET decision = excluded.decision,
        decided_by = excluded.decided_by, decided_by_name = excluded.decided_by_name, decided_at = excluded.decided_at`)
    .run(runId, findingId, decision, (user && user.id) || '', userName(user), now());
  return { decision, by: userName(user), at: now() };
}

module.exports = {
  db, httpError, sha256, userName,
  createCheck, checkById, listChecks, updateCheck, setDocument, setDetected, deleteCheck,
  ensureServiceSession,
  createRun, runById, listRuns, setRunRoute, setRunStatus, setRunProgress, recoverInterrupted, setDecision,
};
