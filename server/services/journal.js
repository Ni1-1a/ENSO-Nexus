'use strict';
/**
 * Структурный журнал этапов (07.10.2026).
 *
 * Событие журнала раньше было строкой: «Зоны построены — зон 8». Откуда зоны,
 * по каким правилам, после какого замечания — из строки не достать, и журнал
 * читался как лента уведомлений, а не как след работы. Теперь событие несёт
 * ССЫЛКИ (`ref` — на сущности, которых оно касается: правила, зоны, вариант,
 * файл, пометка) и ПРИЧИНУ (`cause` — реплика или замечание человека, правка,
 * решение). Клиент превращает ссылки в кнопки: клик открывает карточку
 * сущности на плане или в графе связей.
 *
 * Обе колонки добавочные (`events.ref`, `events.cause`, JSON-строки); старые
 * строки остаются пустыми и читаются как раньше. Ссылка — {type, id, label}:
 * `type` — тип узла графа происхождения (public/provenance-core.js), `id` —
 * ключ внутри типа, `label` — подпись для человека. Узел графа из ссылки —
 * `${type}:${id}`.
 */
const { db, now } = require('../db');

const MAX_REFS = 40;
const MAX_LABEL = 160;

/**
 * Проект могли удалить, пока задача выполнялась, — это штатное действие
 * человека, а не авария. Запись по исчезнувшей сессии молча пропускается:
 * иначе INSERT падает на внешнем ключе, исключение летит из catch-ветки,
 * и всё, что стоит в коде после записи, уже не выполняется.
 */
function sessionAlive(sessionId) {
  return !!db.prepare('SELECT 1 AS ok FROM sessions WHERE id = ?').get(sessionId);
}

/** Пропускать ли запись: сессии больше нет либо она исчезла между проверкой и вставкой. */
function isGoneError(err) {
  return err && (err.errcode === 787 || /FOREIGN KEY/i.test(String(err.message)));
}

/** Ссылка на сущность. Пустой id — не ссылка: такое молча выбрасывается. */
function ref(type, id, label = '') {
  const t = String(type || '').trim();
  const key = id === undefined || id === null ? '' : String(id).trim();
  if (!t || !key) return null;
  return { type: t, id: key, label: String(label || '').slice(0, MAX_LABEL) };
}

/** Список ссылок: принимает одну ссылку, массив, null; чистит мусор и дубли. */
function refs(list) {
  const arr = Array.isArray(list) ? list : (list ? [list] : []);
  const seen = new Set();
  const out = [];
  for (const r of arr) {
    if (!r || typeof r !== 'object' || !r.type || !r.id) continue;
    const key = `${r.type}:${r.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ type: String(r.type), id: String(r.id), label: String(r.label || '').slice(0, MAX_LABEL) });
    if (out.length >= MAX_REFS) break;
  }
  return out;
}

/** Ссылка на человека как причину: подпись решения, замечания, правки. */
function person(name, id = '') {
  const label = String(name || '').trim();
  if (!label) return null;
  return { type: 'person', id: String(id || label).slice(0, 80), label: label.slice(0, MAX_LABEL) };
}

/** JSON-строки для колонок; пустые ссылки — пустая строка, как у старых событий. */
function serialize(links) {
  const list = refs(links && links.ref);
  const cause = links && links.cause && links.cause.type && links.cause.id
    ? { type: String(links.cause.type), id: String(links.cause.id), label: String(links.cause.label || '').slice(0, MAX_LABEL) }
    : null;
  return { ref: list.length ? JSON.stringify(list) : '', cause: cause ? JSON.stringify(cause) : '' };
}

/**
 * Событие журнала. Пятый аргумент — ссылки: { ref, cause }. Без него событие
 * пишется как раньше: все 75 точек записи платформы продолжают работать.
 */
function logEvent(sessionId, stage, detail = '', level = 'info', links = null) {
  if (!sessionAlive(sessionId)) return false;
  const { ref: refJson, cause } = serialize(links);
  try {
    db.prepare('INSERT INTO events (session_id, stage, detail, level, ref, cause, created_at) VALUES (?,?,?,?,?,?,?)')
      .run(sessionId, stage, detail, level, refJson, cause, now());
    return true;
  } catch (err) {
    if (isGoneError(err)) return false;
    throw err;
  }
}

function safeParse(s, fallback) {
  if (!s) return fallback;
  try { return JSON.parse(s); } catch { return fallback; }
}

/** Строка таблицы → событие с разобранными ссылками. Битый JSON читается как «ссылок нет». */
function parse(row) {
  const list = safeParse(row.ref, []);
  const cause = safeParse(row.cause, null);
  return {
    id: row.id,
    stage: row.stage,
    detail: row.detail,
    level: row.level,
    created_at: row.created_at,
    ref: Array.isArray(list) ? list.filter((r) => r && r.type && r.id) : [],
    cause: cause && cause.type && cause.id ? cause : null,
  };
}

/** События сессии, новые первыми (журнал в интерфейсе строится снизу вверх). */
function list(sessionId, { limit = 50 } = {}) {
  const n = Math.max(1, Math.min(1000, Number(limit) || 50));
  return db.prepare('SELECT id, stage, detail, level, ref, cause, created_at FROM events WHERE session_id = ? ORDER BY id DESC LIMIT ?')
    .all(sessionId, n).map(parse);
}

/**
 * Насколько журнал связан: доля событий со ссылками. Нужна проверке «на
 * прогоне события этапов ссылаются на сущности», а не для показа.
 */
function stats(sessionId) {
  const row = db.prepare(`SELECT COUNT(*) AS total,
      SUM(CASE WHEN ref <> '' THEN 1 ELSE 0 END) AS withRef,
      SUM(CASE WHEN cause <> '' THEN 1 ELSE 0 END) AS withCause
    FROM events WHERE session_id = ?`).get(sessionId);
  return { total: row.total || 0, withRef: row.withRef || 0, withCause: row.withCause || 0 };
}

module.exports = { logEvent, ref, refs, person, serialize, parse, list, stats, sessionAlive, isGoneError };
