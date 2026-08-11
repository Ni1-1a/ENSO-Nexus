'use strict';
/**
 * Хранение запусков генерации и вариантов посадки (ТЗ, п. 53, 73).
 *
 * Каждый запуск привязан к версии плана: перегенерация заводит новый запуск,
 * а прошлый вместе с выбранным вариантом остаётся нетронутым. Иначе повторный
 * анализ молча переписал бы то, что человек уже согласовал (ТЗ, п. 74).
 */
const crypto = require('crypto');
const { db, now } = require('../../db');

function saveRun(sessionId, { planId, requirements, criterion, variants, stats }) {
  const runId = crypto.randomUUID();
  const ts = now();
  db.prepare('INSERT INTO placement_runs (id, session_id, plan_id, requirements, criterion, stats, created_at) VALUES (?,?,?,?,?,?,?)')
    .run(runId, sessionId, planId, JSON.stringify(requirements), criterion, JSON.stringify(stats || {}), ts);

  for (const v of variants) {
    const vid = crypto.randomUUID();
    db.prepare('INSERT INTO placement_variants (id, run_id, session_id, number, footprint, metrics, status, selected, preview, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
      // statusLabel в метрики НЕ пишется: он замораживается на момент генерации
      // и после решения по мероприятию врёт («требует решения» при статусе
      // «допустим»). Подпись считается от живого статуса при чтении варианта.
      .run(vid, runId, sessionId, v.number, JSON.stringify(v.footprint), JSON.stringify({
        ...v.metrics, warnings: v.warnings, touchesCritical: v.touchesCritical,
      }), v.status, 0, v.preview || '', ts);
    for (const a of v.actions) {
      db.prepare(`INSERT INTO placement_actions
          (id, variant_id, kind, object_id, title, volume, unit, classification, requires_decision, decision, note, created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(crypto.randomUUID(), vid, a.kind, a.objectId || '', a.title,
          Number.isFinite(a.volume) ? a.volume : null, a.unit || '', a.classification || '',
          a.requiresDecision ? 1 : 0, '', a.note || '', ts);
    }
  }
  return runId;
}

/**
 * Подписи статусов берутся ЖИВЫМИ из текущего статуса варианта.
 * Ярлык, замороженный в metrics при генерации, врёт после первого же решения
 * по мероприятию: статус стал «допустим», а в чертёж уходило «требует решения».
 */
const STATUS_LABELS = {
  admissible: 'допустим',
  needs_decision: 'требует решения пользователя',
  violations: 'есть нарушения',
  rejected: 'отклонён решением пользователя',
};

function variantRow(row) {
  const metrics = JSON.parse(row.metrics);
  const actions = db.prepare('SELECT * FROM placement_actions WHERE variant_id = ? ORDER BY created_at').all(row.id)
    .map((a) => ({
      id: a.id,
      kind: a.kind,
      objectId: a.object_id,
      title: a.title,
      volume: a.volume,
      unit: a.unit,
      classification: a.classification,
      requiresDecision: !!a.requires_decision,
      decision: a.decision || '',
      note: a.note || '',
    }));
  return {
    id: row.id,
    runId: row.run_id,
    number: row.number,
    footprint: JSON.parse(row.footprint),
    metrics,
    warnings: metrics.warnings || [],
    status: row.status,
    statusLabel: STATUS_LABELS[row.status] || metrics.statusLabel || row.status,
    selected: !!row.selected,
    preview: row.preview || '',
    actions,
    // вариант становится допустимым, когда все требующие решения мероприятия решены
    pendingDecisions: actions.filter((a) => a.requiresDecision && !a.decision).length,
  };
}

/** Последний запуск сессии со всеми вариантами. */
function latestRun(sessionId) {
  const run = db.prepare('SELECT * FROM placement_runs WHERE session_id = ? ORDER BY created_at DESC LIMIT 1').get(sessionId);
  if (!run) return null;
  const variants = db.prepare('SELECT * FROM placement_variants WHERE run_id = ? ORDER BY number').all(run.id).map(variantRow);
  return {
    id: run.id,
    planId: run.plan_id,
    requirements: JSON.parse(run.requirements),
    criterion: run.criterion,
    stats: run.stats ? JSON.parse(run.stats) : {},
    createdAt: run.created_at,
    variants,
  };
}

function getVariant(sessionId, variantId) {
  const row = db.prepare('SELECT * FROM placement_variants WHERE id = ? AND session_id = ?').get(variantId, sessionId);
  return row ? variantRow(row) : null;
}

/**
 * Решение по мероприятию, затрагивающему критический объект (ТЗ, п. 46).
 * Пока решение не принято, вариант допустимым не считается.
 */
function decideAction(sessionId, actionId, { decision, decidedBy }) {
  if (!['allow', 'forbid'].includes(decision)) throw new Error('Решение должно быть allow или forbid');
  if (!String(decidedBy || '').trim()) throw new Error('Нужно указать, кто принял решение');
  const row = db.prepare(`SELECT a.* FROM placement_actions a
      JOIN placement_variants v ON v.id = a.variant_id
      WHERE a.id = ? AND v.session_id = ?`).get(actionId, sessionId);
  if (!row) return null;
  db.prepare('UPDATE placement_actions SET decision = ?, note = ? WHERE id = ?')
    .run(decision, `${row.note ? `${row.note}; ` : ''}решение принял ${String(decidedBy).trim()} (${now()})`, actionId);

  // все решения приняты и запретов нет — вариант переводится в допустимые
  const variant = getVariant(sessionId, row.variant_id);
  const forbidden = variant.actions.some((a) => a.decision === 'forbid');
  if (!variant.pendingDecisions && variant.status === 'needs_decision') {
    db.prepare('UPDATE placement_variants SET status = ? WHERE id = ?')
      .run(forbidden ? 'rejected' : 'admissible', row.variant_id);
  }
  return getVariant(sessionId, row.variant_id);
}

/** Назначение варианта выбранным: в сессии он ровно один (ТЗ, п. 53). */
function select(sessionId, variantId) {
  const variant = getVariant(sessionId, variantId);
  if (!variant) return null;
  if (variant.pendingDecisions) {
    throw new Error(`По варианту ${variant.number} не принято решений: ${variant.pendingDecisions}. ` +
      'Сначала подтвердите или запретите воздействие на критические объекты.');
  }
  db.prepare('UPDATE placement_variants SET selected = 0 WHERE session_id = ?').run(sessionId);
  db.prepare('UPDATE placement_variants SET selected = 1 WHERE id = ?').run(variantId);
  return getVariant(sessionId, variantId);
}

/** id последнего запуска сессии. */
function latestRunId(sessionId) {
  const run = db.prepare('SELECT id FROM placement_runs WHERE session_id = ? ORDER BY created_at DESC LIMIT 1').get(sessionId);
  return run ? run.id : '';
}

/**
 * Выбранный вариант ПОСЛЕДНЕГО запуска.
 *
 * Привязка к запуску обязательна: после замечания («переделать») заводится
 * новый запуск, в нём выбранных вариантов нет, а отметка `selected` остаётся
 * у варианта прошлого запуска. Без этой проверки чертёж и комплект собирались
 * по посадке, которую человек уже отправил на переделку и которой нет среди
 * показанных ему вариантов.
 */
function selected(sessionId) {
  const runId = latestRunId(sessionId);
  if (!runId) return null;
  const row = db.prepare('SELECT * FROM placement_variants WHERE run_id = ? AND selected = 1 LIMIT 1').get(runId);
  return row ? variantRow(row) : null;
}

module.exports = { saveRun, latestRun, latestRunId, getVariant, decideAction, select, selected, STATUS_LABELS };
