'use strict';
/**
 * Модуль «Датасет»: хранение документов, элементов и обучающих пар.
 *
 * Таблицы модуль заводит сам (по образцу kb.js): датасет живёт ВНЕ сессий и
 * их TTL — провалидированные пары не имеют права исчезнуть вместе с проектом.
 *
 * Переходы статусов пары зашиты здесь и только здесь:
 *   draft    → pending (правка) | validated | rejected
 *   pending  → validated | rejected (правка оставляет pending)
 *   validated: правка → pending, ФИО и дата валидации ОЧИЩАЮТСЯ
 *   rejected → pending (правка)
 * `validated` ставит только validatePair — по действию человека. Ни импорт,
 * ни генерация, ни правка полей напрямую этот статус выставить не могут:
 * createPair и editPair принимают только question/answer.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const config = require('../../config');
const { db, now } = require('../../db');

db.exec(`
CREATE TABLE IF NOT EXISTS dataset_documents (
  id TEXT PRIMARY KEY,
  filename TEXT NOT NULL,
  file_sha256 TEXT NOT NULL UNIQUE,
  format TEXT NOT NULL DEFAULT '',
  mime TEXT NOT NULL DEFAULT '',
  size INTEGER NOT NULL DEFAULT 0,
  stored_path TEXT NOT NULL DEFAULT '',
  uploaded_by TEXT NOT NULL DEFAULT '',
  uploaded_by_name TEXT NOT NULL DEFAULT '',
  uploaded_at TEXT NOT NULL,
  service_session_id TEXT NOT NULL DEFAULT '',
  processing_status TEXT NOT NULL DEFAULT 'queued',
  progress TEXT NOT NULL DEFAULT '',
  error_text TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS dataset_elements (
  id TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL DEFAULT 'text',
  token_count INTEGER NOT NULL DEFAULT 0,
  descr TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS dataset_document_elements (
  document_id TEXT NOT NULL,
  element_id TEXT NOT NULL,
  order_index INTEGER NOT NULL DEFAULT 0,
  location TEXT NOT NULL DEFAULT '{}',
  state TEXT NOT NULL DEFAULT 'no_pairs',
  PRIMARY KEY (document_id, element_id)
);
CREATE INDEX IF NOT EXISTS idx_ds_doc_el_doc ON dataset_document_elements(document_id, order_index);
CREATE INDEX IF NOT EXISTS idx_ds_doc_el_el ON dataset_document_elements(element_id);
CREATE TABLE IF NOT EXISTS dataset_pairs (
  id TEXT PRIMARY KEY,
  element_id TEXT NOT NULL,
  question TEXT NOT NULL DEFAULT '',
  answer TEXT NOT NULL DEFAULT '',
  origin TEXT NOT NULL DEFAULT 'manual',
  status TEXT NOT NULL DEFAULT 'draft',
  prompt_version TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_by TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  validated_by_name TEXT NOT NULL DEFAULT '',
  validated_at TEXT NOT NULL DEFAULT '',
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_ds_pairs_element ON dataset_pairs(element_id);
CREATE INDEX IF NOT EXISTS idx_ds_pairs_status ON dataset_pairs(status, deleted_at);
CREATE TABLE IF NOT EXISTS dataset_pair_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pair_id TEXT NOT NULL,
  actor TEXT NOT NULL DEFAULT '',
  at TEXT NOT NULL,
  action TEXT NOT NULL,
  old_values TEXT NOT NULL DEFAULT '{}',
  new_values TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_ds_audit_pair ON dataset_pair_audit(pair_id, at);
CREATE TABLE IF NOT EXISTS dataset_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '');
`);

/*
 * Полнотекстовый поиск «Истории» — FTS5 (доступен в node:sqlite, проверено).
 * Таблица обычная (не external content): пар тысячи, дублирование текста
 * элемента в индексе дешевле, чем триггеры и синхронизация со строками.
 */
let ftsReady = false;
try {
  db.exec('CREATE VIRTUAL TABLE IF NOT EXISTS dataset_pairs_fts USING fts5(pair_id UNINDEXED, question, answer, content)');
  ftsReady = true;
} catch (err) {
  console.warn('[dataset] FTS5 недоступен, поиск будет по LIKE:', err.message);
}

/* Обработка, прерванная перезапуском сервера, не имеет права висеть «идёт»
 * вечно — по образцу recoverInterruptedJobs платформы. Генерацию можно
 * запустить заново кнопкой: элементы и готовые пары целы. */
{
  const stuck = db.prepare(
    "UPDATE dataset_documents SET processing_status = 'failed', error_text = 'Обработка была прервана перезапуском сервера — запустите генерацию повторно.' WHERE processing_status IN ('queued','chunking','generating')",
  ).run().changes;
  if (stuck) console.log(`[dataset] прерванных обработок помечено: ${stuck}`);
}

/* ---------------- нормализация и хэш ---------------- */

/**
 * Нормализация текста для content_hash: CRLF → LF, схлопнутые пробелы внутри
 * строк, обрезанные края. Переводы строк СОХРАНЯЮТСЯ: у таблицы строка — это
 * смысловая единица, и склеенная в ленту таблица совпала бы с другой таблицей.
 */
function normalizeText(text) {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(/[^\S\n]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function contentHash(text) {
  return crypto.createHash('sha256').update(normalizeText(text), 'utf8').digest('hex');
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/* ---------------- настройки модуля ---------------- */

const SETTINGS_DEFAULTS = () => ({
  gen_prompt: '',            // сеется из prompts/dataset-generate.md при первом чтении
  gen_prompt_version: 'v1',  // поднимается на каждой правке промпта; пишется в пары
  seed: '42',
  ai_provider: config.datasetGenProvider,
  ai_model: config.datasetGenModel,
});

function settingsGet() {
  const out = SETTINGS_DEFAULTS();
  for (const row of db.prepare('SELECT key, value FROM dataset_settings').all()) {
    if (Object.prototype.hasOwnProperty.call(out, row.key)) out[row.key] = row.value;
  }
  if (!out.gen_prompt) {
    // умолчание живёт файлом по общему правилу платформы «промты — в prompts/»;
    // правка в настройках модуля кладёт свой текст в БД и файл больше не трогает
    const prompts = require('../prompts');
    try { out.gen_prompt = prompts.load('dataset-generate'); } catch { out.gen_prompt = ''; }
  }
  return out;
}

function settingsSet(patch) {
  const current = settingsGet();
  const write = db.prepare('INSERT INTO dataset_settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  if (typeof patch.gen_prompt === 'string' && patch.gen_prompt.trim() && patch.gen_prompt !== current.gen_prompt) {
    const next = `v${(parseInt(String(current.gen_prompt_version).replace(/\D/g, ''), 10) || 1) + 1}`;
    write.run('gen_prompt', patch.gen_prompt);
    write.run('gen_prompt_version', next);
  }
  if (patch.seed !== undefined) {
    const seed = parseInt(patch.seed, 10);
    if (!Number.isFinite(seed)) throw httpError(400, 'Seed должен быть целым числом');
    write.run('seed', String(seed));
  }
  // Провайдер генерации — только локальные движки: у датасета нет проекта,
  // а облачный гейт платформы решает по проекту и его хозяину.
  if (patch.ai_provider !== undefined) {
    const p = String(patch.ai_provider).trim().toLowerCase();
    if (!['lmstudio', 'ollama', 'openai-compat'].includes(p)) {
      throw httpError(400, 'Для генерации датасета доступны локальные провайдеры: lmstudio, ollama, openai-compat');
    }
    write.run('ai_provider', p);
  }
  if (patch.ai_model !== undefined) write.run('ai_model', String(patch.ai_model).trim().slice(0, 200));
  return settingsGet();
}

/* ---------------- документы ---------------- */

function docDir() {
  const dir = path.join(config.dataDir, 'dataset', 'uploads');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function docBySha(fileSha) {
  return db.prepare('SELECT * FROM dataset_documents WHERE file_sha256 = ?').get(fileSha) || null;
}

function docById(id) {
  return db.prepare('SELECT * FROM dataset_documents WHERE id = ?').get(id) || null;
}

function createDocument({ filename, fileSha, format, mime, size, storedPath, user, serviceSessionId }) {
  const id = crypto.randomUUID();
  db.prepare(`INSERT INTO dataset_documents
    (id, filename, file_sha256, format, mime, size, stored_path, uploaded_by, uploaded_by_name, uploaded_at, service_session_id, processing_status)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,'queued')`).run(
    id, filename, fileSha, format, mime || '', size, storedPath,
    (user && user.id) || '', userName(user), now(), serviceSessionId || '');
  return docById(id);
}

function userName(user) {
  return user ? `${user.lastName} ${user.firstName}`.trim() : '';
}

function setDocStatus(id, status, { error = null, progress = null } = {}) {
  const doc = docById(id);
  if (!doc) return;
  db.prepare('UPDATE dataset_documents SET processing_status = ?, error_text = ?, progress = ? WHERE id = ?')
    .run(status, error !== null ? String(error).slice(0, 500) : doc.error_text,
      progress !== null ? String(progress).slice(0, 300) : doc.progress, id);
}

function setDocProgress(id, progress) {
  db.prepare('UPDATE dataset_documents SET progress = ? WHERE id = ?').run(String(progress).slice(0, 300), id);
}

function listDocuments() {
  return db.prepare(`
    SELECT d.*,
      (SELECT COUNT(*) FROM dataset_document_elements l WHERE l.document_id = d.id) AS elements,
      (SELECT COUNT(*) FROM dataset_document_elements l WHERE l.document_id = d.id AND l.state = 'done') AS done,
      (SELECT COUNT(*) FROM dataset_pairs p JOIN dataset_document_elements l ON l.element_id = p.element_id
        WHERE l.document_id = d.id AND p.deleted_at IS NULL) AS pairs
    FROM dataset_documents d ORDER BY d.uploaded_at DESC`).all();
}

/* ---------------- элементы и связки ---------------- */

/** Элемент по нормализованному содержимому: существующий переиспользуется —
 *  вместе со всеми его парами, включая валидированные. */
function upsertElement({ content, kind, descr, tokenCount }) {
  const hash = contentHash(content);
  const existing = db.prepare('SELECT * FROM dataset_elements WHERE content_hash = ?').get(hash);
  if (existing) return { element: existing, existed: true };
  const id = crypto.randomUUID();
  db.prepare('INSERT INTO dataset_elements (id, content, content_hash, kind, token_count, descr, created_at) VALUES (?,?,?,?,?,?,?)')
    .run(id, content, hash, kind, tokenCount, descr || '', now());
  return { element: db.prepare('SELECT * FROM dataset_elements WHERE id = ?').get(id), existed: false };
}

function linkElement(documentId, elementId, orderIndex, location) {
  // повтор того же элемента в одном документе связку не удваивает
  db.prepare('INSERT OR IGNORE INTO dataset_document_elements (document_id, element_id, order_index, location, state) VALUES (?,?,?,?,?)')
    .run(documentId, elementId, orderIndex, JSON.stringify(location || {}), 'no_pairs');
}

function elementById(id) {
  return db.prepare('SELECT * FROM dataset_elements WHERE id = ?').get(id) || null;
}

function livePairsOf(elementId) {
  return db.prepare('SELECT * FROM dataset_pairs WHERE element_id = ? AND deleted_at IS NULL ORDER BY created_at, id').all(elementId);
}

function elementsOfDocument(documentId, { state = '' } = {}) {
  const rows = db.prepare(`
    SELECT l.document_id, l.element_id, l.order_index, l.location, l.state,
           e.kind, e.token_count, e.descr,
           substr(e.content, 1, 240) AS preview,
           (SELECT COUNT(*) FROM dataset_pairs p WHERE p.element_id = e.id AND p.deleted_at IS NULL) AS pairs,
           (SELECT COUNT(*) FROM dataset_pairs p WHERE p.element_id = e.id AND p.deleted_at IS NULL AND p.status = 'validated') AS validated
    FROM dataset_document_elements l JOIN dataset_elements e ON e.id = l.element_id
    WHERE l.document_id = ? ${state ? 'AND l.state = ?' : ''}
    ORDER BY l.order_index`).all(...(state ? [documentId, state] : [documentId]));
  return rows;
}

function docProgress(documentId) {
  const r = db.prepare(`SELECT COUNT(*) AS total, SUM(state = 'done') AS done
    FROM dataset_document_elements WHERE document_id = ?`).get(documentId);
  return { total: r.total || 0, done: r.done || 0 };
}

/**
 * Состояние связок пересчитывается ИЗ ПАР, кроме «отложено»: это ручная
 * пометка человека, и снимает её только появившаяся валидированная пара
 * (элемент пройден — откладывать больше нечего) или явное действие.
 */
function recomputeStates(elementId) {
  const pairs = livePairsOf(elementId);
  const hasValidated = pairs.some((p) => p.status === 'validated');
  const links = db.prepare('SELECT document_id, state FROM dataset_document_elements WHERE element_id = ?').all(elementId);
  const set = db.prepare('UPDATE dataset_document_elements SET state = ? WHERE document_id = ? AND element_id = ?');
  for (const l of links) {
    let next;
    if (hasValidated) next = 'done';
    else if (l.state === 'deferred') next = 'deferred';
    else if (pairs.length) next = 'in_progress';
    else next = 'no_pairs';
    if (next !== l.state) set.run(next, l.document_id, elementId);
  }
}

function deferElement(documentId, elementId, on = true) {
  const link = db.prepare('SELECT * FROM dataset_document_elements WHERE document_id = ? AND element_id = ?').get(documentId, elementId);
  if (!link) throw httpError(404, 'Элемент в этом документе не найден');
  if (on) {
    // «Пропустить» не трогает статусы пар — только пометку связки
    db.prepare("UPDATE dataset_document_elements SET state = 'deferred' WHERE document_id = ? AND element_id = ?").run(documentId, elementId);
  } else {
    db.prepare("UPDATE dataset_document_elements SET state = 'no_pairs' WHERE document_id = ? AND element_id = ?").run(documentId, elementId);
    recomputeStates(elementId);
  }
  return db.prepare('SELECT state FROM dataset_document_elements WHERE document_id = ? AND element_id = ?').get(documentId, elementId).state;
}

/* ---------------- пары ---------------- */

const httpError = (status, message) => Object.assign(new Error(message), { status });

function pairById(id) {
  return db.prepare('SELECT * FROM dataset_pairs WHERE id = ?').get(id) || null;
}

function auditWrite(pairId, actor, action, oldValues, newValues) {
  db.prepare('INSERT INTO dataset_pair_audit (pair_id, actor, at, action, old_values, new_values) VALUES (?,?,?,?,?,?)')
    .run(pairId, actor || '', now(), action, JSON.stringify(oldValues || {}), JSON.stringify(newValues || {}));
}

function auditSnapshot(p) {
  return { question: p.question, answer: p.answer, status: p.status, validated_by_name: p.validated_by_name, validated_at: p.validated_at };
}

function ftsPut(pair) {
  if (!ftsReady) return;
  try {
    db.prepare('DELETE FROM dataset_pairs_fts WHERE pair_id = ?').run(pair.id);
    if (!pair.deleted_at) {
      const el = elementById(pair.element_id);
      db.prepare('INSERT INTO dataset_pairs_fts (pair_id, question, answer, content) VALUES (?,?,?,?)')
        .run(pair.id, pair.question, pair.answer, (el && el.content) || '');
    }
  } catch (err) { console.warn('[dataset] FTS не обновлён:', err.message); }
}

const QUESTION_MAX = 2000;
const ANSWER_MAX = 20000;

function cleanPairFields({ question, answer }) {
  const q = String(question ?? '').replace(/\r\n?/g, '\n').trim();
  const a = String(answer ?? '').replace(/\r\n?/g, '\n').trim();
  if (!q) throw httpError(400, 'Вопрос не может быть пустым');
  if (!a) throw httpError(400, 'Эталонный ответ не может быть пустым');
  if (q.length > QUESTION_MAX) throw httpError(400, `Вопрос длиннее ${QUESTION_MAX} символов`);
  if (a.length > ANSWER_MAX) throw httpError(400, `Ответ длиннее ${ANSWER_MAX} символов`);
  return { question: q, answer: a };
}

/**
 * Создание пары. Статус выбирается здесь, а не приходит снаружи:
 * auto → draft (модель, человек её не открывал), manual → pending.
 */
function createPair({ elementId, question, answer, origin, promptVersion = '', actor = '' }) {
  const el = elementById(elementId);
  if (!el) throw httpError(404, 'Элемент не найден');
  const fields = cleanPairFields({ question, answer });
  const id = crypto.randomUUID();
  const status = origin === 'auto' ? 'draft' : 'pending';
  db.prepare(`INSERT INTO dataset_pairs
    (id, element_id, question, answer, origin, status, prompt_version, created_by, created_at, updated_by, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, elementId, fields.question, fields.answer, origin === 'auto' ? 'auto' : 'manual',
    status, promptVersion, actor, now(), actor, now());
  const pair = pairById(id);
  auditWrite(id, actor, 'create', {}, auditSnapshot(pair));
  ftsPut(pair);
  recomputeStates(elementId);
  return pair;
}

/** Проверка optimistic lock: кто-то сохранил пару позже, чем её читали. */
function checkLock(pair, expectedUpdatedAt) {
  if (expectedUpdatedAt === undefined || expectedUpdatedAt === null || expectedUpdatedAt === '') return;
  if (String(expectedUpdatedAt) !== pair.updated_at) {
    throw Object.assign(httpError(409, `Пару уже изменил ${pair.updated_by || 'кто-то другой'} (${pair.updated_at}). Перечитайте её и повторите правку.`),
      { updatedBy: pair.updated_by, updatedAt: pair.updated_at });
  }
}

function requireLivePair(id) {
  const pair = pairById(id);
  if (!pair || pair.deleted_at) throw httpError(404, 'Пара не найдена или удалена');
  return pair;
}

/**
 * Правка текста пары. ЛЮБАЯ правка приводит к статусу «на валидации»:
 * validated теряет ФИО и дату (подтверждали другой текст), rejected получает
 * второй шанс. Никакие другие поля через правку не меняются.
 */
function editPair(id, { question, answer, actor = '', expectedUpdatedAt }) {
  const pair = requireLivePair(id);
  checkLock(pair, expectedUpdatedAt);
  const fields = cleanPairFields({ question, answer });
  if (fields.question === pair.question && fields.answer === pair.answer) return pair; // правки нет — статус не трогаем
  const old = auditSnapshot(pair);
  db.prepare(`UPDATE dataset_pairs SET question = ?, answer = ?, status = 'pending',
    validated_by_name = '', validated_at = '', updated_by = ?, updated_at = ? WHERE id = ?`)
    .run(fields.question, fields.answer, actor, now(), id);
  const next = pairById(id);
  auditWrite(id, actor, 'edit', old, auditSnapshot(next));
  ftsPut(next);
  recomputeStates(pair.element_id);
  return next;
}

/**
 * Подтверждение — ЕДИНСТВЕННОЕ место, где появляется validated.
 * ФИО берётся из переданного пользователя сервера, а не из тела запроса.
 */
function validatePair(id, { user, actor = '', expectedUpdatedAt }) {
  const pair = requireLivePair(id);
  checkLock(pair, expectedUpdatedAt);
  if (!['draft', 'pending'].includes(pair.status)) {
    throw httpError(400, `Подтвердить можно черновик или пару на валидации, а эта — «${statusLabel(pair.status)}»`);
  }
  const name = userName(user);
  if (!name) throw httpError(403, 'Подтверждать пары может только вошедший человек');
  const old = auditSnapshot(pair);
  db.prepare(`UPDATE dataset_pairs SET status = 'validated', validated_by_name = ?, validated_at = ?,
    updated_by = ?, updated_at = ? WHERE id = ?`).run(name, now(), name, now(), id);
  const next = pairById(id);
  auditWrite(id, actor || name, 'validate', old, auditSnapshot(next));
  recomputeStates(pair.element_id);
  return next;
}

function rejectPair(id, { user, actor = '', expectedUpdatedAt }) {
  const pair = requireLivePair(id);
  checkLock(pair, expectedUpdatedAt);
  if (!['draft', 'pending'].includes(pair.status)) {
    throw httpError(400, `Отклонить можно черновик или пару на валидации, а эта — «${statusLabel(pair.status)}»`);
  }
  const name = userName(user);
  const old = auditSnapshot(pair);
  db.prepare("UPDATE dataset_pairs SET status = 'rejected', updated_by = ?, updated_at = ? WHERE id = ?").run(name, now(), id);
  const next = pairById(id);
  auditWrite(id, actor || name, 'reject', old, auditSnapshot(next));
  recomputeStates(pair.element_id);
  return next;
}

/** Удаление мягкое: строка остаётся, из показа и экспорта уходит. */
function deletePair(id, { actor = '' } = {}) {
  const pair = requireLivePair(id);
  const old = auditSnapshot(pair);
  db.prepare('UPDATE dataset_pairs SET deleted_at = ?, updated_by = ?, updated_at = ? WHERE id = ?').run(now(), actor, now(), id);
  const next = pairById(id);
  auditWrite(id, actor, 'delete', old, auditSnapshot(next));
  ftsPut(next);
  recomputeStates(pair.element_id);
  return next;
}

function restorePair(id, { actor = '' } = {}) {
  const pair = pairById(id);
  if (!pair) throw httpError(404, 'Пара не найдена');
  if (!pair.deleted_at) return pair;
  db.prepare('UPDATE dataset_pairs SET deleted_at = NULL, updated_by = ?, updated_at = ? WHERE id = ?').run(actor, now(), id);
  const next = pairById(id);
  auditWrite(id, actor, 'restore', auditSnapshot(pair), auditSnapshot(next));
  ftsPut(next);
  recomputeStates(pair.element_id);
  return next;
}

const STATUS_LABELS = { draft: 'черновик', pending: 'на валидации', validated: 'валидирован', rejected: 'отклонён' };
function statusLabel(s) { return STATUS_LABELS[s] || s; }

/* ---------------- «История»: реестр пар ---------------- */

/** Первая (по времени загрузки) связка элемента — для колонки «документ». */
const FIRST_LINK_JOIN = `
  LEFT JOIN dataset_document_elements l ON l.element_id = e.id AND l.document_id = (
    SELECT l2.document_id FROM dataset_document_elements l2
    JOIN dataset_documents d2 ON d2.id = l2.document_id
    WHERE l2.element_id = e.id ORDER BY d2.uploaded_at, d2.id LIMIT 1)
  LEFT JOIN dataset_documents d ON d.id = l.document_id`;

/** Запрос FTS5 из пользовательской строки: только слова, каждое — префиксом. */
function ftsExpr(q) {
  const tokens = String(q || '').split(/[^\p{L}\p{N}]+/u).filter((t) => t.length >= 2).slice(0, 8);
  if (!tokens.length) return '';
  return tokens.map((t) => `"${t.replace(/"/g, '')}"*`).join(' ');
}

const HISTORY_SORTS = {
  updated: 'p.updated_at DESC',
  validated: "NULLIF(p.validated_at,'') DESC NULLS LAST",
  created: 'p.created_at DESC',
  status: 'p.status, p.updated_at DESC',
};

function history({ q = '', status = '', documentId = '', validator = '', kind = '', origin = '', from = '', to = '', sort = 'updated', page = 1, per = 50 } = {}) {
  const where = ['p.deleted_at IS NULL'];
  const args = [];
  if (status) { where.push('p.status = ?'); args.push(status); }
  if (validator) { where.push('p.validated_by_name = ?'); args.push(validator); }
  if (kind) { where.push('e.kind = ?'); args.push(kind); }
  if (origin) { where.push('p.origin = ?'); args.push(origin); }
  if (from) { where.push('p.updated_at >= ?'); args.push(`${from}T00:00:00`); }
  if (to) { where.push('p.updated_at <= ?'); args.push(`${to}T23:59:59.999Z`); }
  if (documentId) {
    where.push('EXISTS (SELECT 1 FROM dataset_document_elements lx WHERE lx.element_id = e.id AND lx.document_id = ?)');
    args.push(documentId);
  }
  if (q.trim()) {
    const expr = ftsReady ? ftsExpr(q) : '';
    if (expr) {
      where.push('p.id IN (SELECT pair_id FROM dataset_pairs_fts WHERE dataset_pairs_fts MATCH ?)');
      args.push(expr);
    } else {
      where.push('(p.question LIKE ? OR p.answer LIKE ? OR e.content LIKE ?)');
      const like = `%${q.trim()}%`;
      args.push(like, like, like);
    }
  }
  const order = HISTORY_SORTS[sort] || HISTORY_SORTS.updated;
  const perPage = Math.min(Math.max(parseInt(per, 10) || 50, 10), 200);
  const pageNum = Math.max(parseInt(page, 10) || 1, 1);
  const base = `FROM dataset_pairs p JOIN dataset_elements e ON e.id = p.element_id ${FIRST_LINK_JOIN} WHERE ${where.join(' AND ')}`;
  const total = db.prepare(`SELECT COUNT(*) AS c ${base}`).get(...args).c;
  const items = db.prepare(`
    SELECT p.id, p.element_id, p.question, p.answer, p.origin, p.status, p.prompt_version,
           p.created_by, p.created_at, p.updated_by, p.updated_at, p.validated_by_name, p.validated_at,
           e.kind, e.descr, e.token_count, substr(e.content, 1, 240) AS preview,
           d.id AS document_id, d.filename, l.order_index
    ${base} ORDER BY ${order}, p.id LIMIT ? OFFSET ?`).all(...args, perPage, (pageNum - 1) * perPage);
  return {
    items, total, page: pageNum, per: perPage,
    validatedTotal: db.prepare("SELECT COUNT(*) AS c FROM dataset_pairs WHERE status = 'validated' AND deleted_at IS NULL").get().c,
    facets: {
      validators: db.prepare("SELECT DISTINCT validated_by_name AS v FROM dataset_pairs WHERE validated_by_name <> '' ORDER BY v").all().map((r) => r.v),
      documents: db.prepare('SELECT id, filename FROM dataset_documents ORDER BY uploaded_at DESC').all(),
    },
  };
}

module.exports = {
  db, now,
  normalizeText, contentHash, sha256, userName, httpError, statusLabel,
  settingsGet, settingsSet, docDir,
  createDocument, docBySha, docById, listDocuments, setDocStatus, setDocProgress,
  upsertElement, linkElement, elementById, livePairsOf, elementsOfDocument, docProgress,
  recomputeStates, deferElement,
  createPair, editPair, validatePair, rejectPair, deletePair, restorePair, pairById,
  history,
  QUESTION_MAX, ANSWER_MAX,
};
