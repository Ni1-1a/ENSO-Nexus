'use strict';
/**
 * Аннотации к плану: пользовательские выделения и комментарии (ТЗ, п. 36–37).
 *
 * Геометрия хранится в координатах ПЛАНА, в метрах. Экранных пикселей здесь нет
 * и быть не может: зум и панорамирование не должны сдвигать сохранённое.
 *
 * Каждая аннотация привязана к конкретной версии плана. Если чертежи переразобрали
 * и появилась новая версия, старые аннотации не исчезают и не переезжают молча —
 * они помечаются как относящиеся к прежней версии, и решает человек (ТЗ, п. 74).
 */
const crypto = require('crypto');
const { db, now } = require('../../db');

const GEOMETRY_TYPES = ['rect', 'polygon', 'point'];
const STATUSES = ['open', 'answered', 'resolved'];

const MAX_COMMENT = 4000;
const MAX_POINTS = 500;

/** Проверка и приведение геометрии выделения. Мусор в базу не попадает. */
function normalizeGeometry(raw, geometryType) {
  const type = GEOMETRY_TYPES.includes(geometryType) ? geometryType : 'rect';
  const points = Array.isArray(raw && raw.points) ? raw.points : [];
  const clean = [];
  for (const p of points.slice(0, MAX_POINTS)) {
    if (!Array.isArray(p) || p.length < 2) continue;
    const x = Number(p[0]); const y = Number(p[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    clean.push([round(x), round(y)]);
  }
  const need = type === 'point' ? 1 : type === 'rect' ? 4 : 3;
  if (clean.length < need) {
    throw new Error(`Выделение типа «${type}» требует не меньше ${need} точек`);
  }
  return { type, points: clean };
}

const round = (n) => Math.round(n * 1000) / 1000;

function rowToApi(row, currentPlanId) {
  return {
    id: row.id,
    planId: row.plan_id,
    author: row.author || '',
    geometry: JSON.parse(row.geometry),
    geometryType: row.geometry_type,
    comment: row.comment || '',
    status: row.status,
    linkedMessageId: row.linked_message_id || '',
    coordinateSystem: row.coordinate_system || '',
    metadata: row.metadata ? safeParse(row.metadata) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    // аннотация с прежней версии плана: геометрия могла измениться под ней
    stale: !!currentPlanId && row.plan_id !== currentPlanId,
  };
}

function safeParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}

/** Все аннотации сессии; те, что сделаны на прежней версии плана, помечаются. */
function list(sessionId, currentPlanId = null) {
  const rows = db.prepare('SELECT * FROM plan_annotations WHERE session_id = ? ORDER BY created_at').all(sessionId);
  return rows.map((r) => rowToApi(r, currentPlanId));
}

function create(sessionId, { planId, geometry, geometryType, comment = '', author = '', coordinateSystem = '', metadata = null }) {
  if (!planId) throw new Error('Аннотация должна быть привязана к версии плана');
  const geo = normalizeGeometry(geometry, geometryType);
  const id = crypto.randomUUID();
  const ts = now();
  db.prepare(`INSERT INTO plan_annotations
      (id, session_id, plan_id, author, geometry, geometry_type, comment, status, linked_message_id, coordinate_system, metadata, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, sessionId, planId, String(author).slice(0, 120), JSON.stringify(geo), geo.type,
      String(comment).slice(0, MAX_COMMENT), 'open', '', String(coordinateSystem).slice(0, 120),
      metadata ? JSON.stringify(metadata) : '', ts, ts);
  return rowToApi(db.prepare('SELECT * FROM plan_annotations WHERE id = ?').get(id), planId);
}

function update(sessionId, id, patch = {}) {
  const row = db.prepare('SELECT * FROM plan_annotations WHERE id = ? AND session_id = ?').get(id, sessionId);
  if (!row) return null;
  const comment = typeof patch.comment === 'string' ? patch.comment.slice(0, MAX_COMMENT) : row.comment;
  const status = STATUSES.includes(patch.status) ? patch.status : row.status;
  const linked = typeof patch.linkedMessageId === 'string' ? patch.linkedMessageId : row.linked_message_id;
  const geometry = patch.geometry
    ? JSON.stringify(normalizeGeometry(patch.geometry, patch.geometryType || row.geometry_type))
    : row.geometry;
  db.prepare('UPDATE plan_annotations SET comment = ?, status = ?, linked_message_id = ?, geometry = ?, updated_at = ? WHERE id = ?')
    .run(comment, status, linked, geometry, now(), id);
  return rowToApi(db.prepare('SELECT * FROM plan_annotations WHERE id = ?').get(id), row.plan_id);
}

function remove(sessionId, id) {
  const row = db.prepare('SELECT id FROM plan_annotations WHERE id = ? AND session_id = ?').get(id, sessionId);
  if (!row) return false;
  db.prepare('DELETE FROM plan_annotations WHERE id = ?').run(id);
  return true;
}

module.exports = { list, create, update, remove, normalizeGeometry, GEOMETRY_TYPES, STATUSES };
