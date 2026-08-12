'use strict';
/**
 * Хранение и АКТУАЛЬНОСТЬ зон ограничений.
 *
 * Зачем понадобилось. Зоны считались один раз — по кнопке «Рассчитать
 * ограничения» — и дописывались прямо в план, который тут же сохранялся
 * в таблицу `plans`. Дальше подбор вариантов, посадка, чертёж и отчёт читали
 * `site.buildable` из этой записи. Пока человек ничего не менял, всё сходилось.
 * Но шаг «Существующие объекты» в том и состоит, чтобы менять: человек помечает
 * строение под снос — и ждёт, что место под ним освободится.
 *
 * Оно не освобождалось. Проверено на боевом комплекте (Горбунки, 2026-08-12):
 * зоны посчитаны → допустимая территория 689,05 м²; восемь строений внутри
 * участка помечены «сносится» → варианты посадки по-прежнему считаются по
 * 689,05 м², ноль вариантов; и только повторное нажатие «Рассчитать
 * ограничения» давало 1783,56 м² и четыре варианта. То есть здание, которого
 * на площадке не будет, продолжало держать пятно застройки.
 *
 * Здесь это закрыто. Вместе с зонами хранятся ПРАВИЛА, по которым они
 * построены, и отпечаток решений человека на момент расчёта. Отпечаток
 * изменился — движок пересобирает зоны по тем же правилам: детерминированно,
 * за десятые доли секунды и без единого обращения к модели. Модель нужна, чтобы
 * ПРОЧИТАТЬ ограничение из документа; чтобы пересчитать геометрию после решения
 * человека, она не нужна.
 */
const crypto = require('crypto');
const { db, now } = require('../../db');
const engine = require('./restriction-engine');

/**
 * Отпечаток всего, что человек решил про этот проект.
 *
 * Входит и содержимое правок, и время правки: смена решения «сносится» →
 * «сохраняется» меняет patch, а отмена правки убирает строку целиком.
 * Граница участка из документа — там же: подставили другой контур, значит
 * все зоны считаются от другой границы.
 */
function editsFingerprint(sessionId) {
  const edits = db.prepare(
    'SELECT object_key, patch, updated_at FROM plan_object_edits WHERE session_id = ? ORDER BY object_key',
  ).all(sessionId);
  const parcel = db.prepare('SELECT points, meta, updated_at FROM plan_parcel_source WHERE session_id = ?')
    .get(sessionId);
  const payload = JSON.stringify({
    edits: edits.map((e) => [e.object_key, e.patch, e.updated_at]),
    parcel: parcel ? [parcel.points, parcel.meta, parcel.updated_at] : null,
  });
  return crypto.createHash('sha256').update(payload).digest('hex').slice(0, 32);
}

function safeParse(s, fallback) {
  try { return JSON.parse(s); } catch { return fallback; }
}

/** Запись зон по версии плана. Возвращает null, если зоны ещё не считались. */
function get(planId) {
  const row = db.prepare('SELECT * FROM plan_zones WHERE plan_id = ?').get(planId);
  if (!row) return null;
  return {
    planId: row.plan_id,
    sessionId: row.session_id,
    rules: safeParse(row.rules, []) || [],
    zones: safeParse(row.zones, null),
    editsHash: row.edits_hash || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Сохранить результат расчёта вместе с правилами и отпечатком решений.
 *
 * Полигоны зон в запись кладутся целиком: пересобирать их на каждый показ плана
 * незачем, а перечитать готовое — сотни микросекунд.
 */
function save(sessionId, planId, { rules, built }) {
  const ts = now();
  const hash = editsFingerprint(sessionId);
  const zones = JSON.stringify({
    restrictions: built.restrictions || [],
    // группы показа: объединение зон одного правила. Хранятся рядом с зонами,
    // а не пересобираются при каждом показе — их читают и экран, и отчёт,
    // и чертёж, а булева операция на полусотне полигонов не бесплатна.
    zoneGroups: built.zoneGroups || [],
    buildable: built.buildable || null,
    attributes: built.attributes || [],
    unresolved: built.unresolved || [],
    warnings: built.warnings || [],
    stats: built.stats || {},
  });
  const exists = db.prepare('SELECT plan_id FROM plan_zones WHERE plan_id = ?').get(planId);
  if (exists) {
    db.prepare('UPDATE plan_zones SET session_id = ?, rules = ?, zones = ?, edits_hash = ?, updated_at = ? WHERE plan_id = ?')
      .run(sessionId, JSON.stringify(rules || []), zones, hash, ts, planId);
  } else {
    db.prepare('INSERT INTO plan_zones (plan_id, session_id, rules, zones, edits_hash, created_at, updated_at) VALUES (?,?,?,?,?,?,?)')
      .run(planId, sessionId, JSON.stringify(rules || []), zones, hash, ts, ts);
  }
  return get(planId);
}

/**
 * Последний расчёт зон проекта. Нужен там, где версия плана под рукой не
 * лежит, — например, комплекту документов: перечень непостроенных зон и
 * атрибутивных ограничений живёт здесь, а не в геометрии плана.
 */
function latest(sessionId) {
  const row = db.prepare('SELECT plan_id FROM plan_zones WHERE session_id = ? ORDER BY updated_at DESC LIMIT 1')
    .get(sessionId);
  return row ? get(row.plan_id) : null;
}

/** Забыть посчитанные зоны проекта — например, при удалении чертежа. */
function clear(sessionId) {
  db.prepare('DELETE FROM plan_zones WHERE session_id = ?').run(sessionId);
}

/**
 * Приложить зоны к плану и, если решения человека с тех пор изменились,
 * ПЕРЕСОБРАТЬ их по тем же правилам.
 *
 * Возвращает { attached, recomputed, built }. Никаких исключений наружу:
 * зоны — надстройка над планом, и сорванный пересчёт не должен ронять показ
 * чертежа. Причина уходит предупреждением в сам план.
 *
 * @param {string} sessionId
 * @param {string} planId   версия плана: зоны привязаны именно к ней
 * @param {object} site     план С УЖЕ НАЛОЖЕННЫМИ правками человека
 */
function attach(sessionId, planId, site) {
  // Зоны из прежних версий платформы могли остаться внутри самой записи плана.
  // Источник правды теперь один, поэтому всё, что пришло из `plans.geometry`,
  // сбрасывается: иначе на плане висели бы зоны, посчитанные неизвестно когда.
  site.restrictions = [];
  site.zoneGroups = [];
  site.buildable = null;

  const rec = get(planId);
  if (!rec || !rec.zones) return { attached: false, recomputed: false, built: null };

  const hash = editsFingerprint(sessionId);
  if (hash === rec.editsHash) {
    site.restrictions = rec.zones.restrictions || [];
    // группы могли не сохраниться: запись сделана прежней версией платформы.
    // Пустой массив — законное состояние, показ откатывается на поштучный.
    site.zoneGroups = rec.zones.zoneGroups || [];
    site.buildable = rec.zones.buildable || null;
    return { attached: true, recomputed: false, built: rec.zones };
  }

  /*
   * Решения человека изменились — зоны, посчитанные до них, недействительны.
   *
   * Пересчёт идёт по СОХРАНЁННЫМ правилам: правило («10 м от ВЛ-10 кВ»,
   * основание ПП РФ № 160) от правки объекта не меняется, меняется геометрия,
   * к которой оно применяется. Поэтому модель здесь не нужна и не зовётся —
   * иначе каждое нажатие «сносится» стоило бы прогона на 85 секунд и денег.
   */
  if (!rec.rules.length) {
    site.warnings = site.warnings || [];
    site.warnings.push({
      code: 'zones-stale',
      message: 'Зоны ограничений посчитаны до последних правок объектов, а правил для пересчёта не сохранено. '
        + 'Нажмите «Рассчитать ограничения» ещё раз — иначе пятно застройки считается по устаревшей схеме.',
    });
    site.restrictions = rec.zones.restrictions || [];
    site.zoneGroups = rec.zones.zoneGroups || [];
    site.buildable = rec.zones.buildable || null;
    return { attached: true, recomputed: false, stale: true, built: rec.zones };
  }

  let built;
  try {
    built = engine.build(site, rec.rules);
  } catch (err) {
    site.warnings = site.warnings || [];
    site.warnings.push({
      code: 'zones-recompute-failed',
      message: `Зоны не удалось пересчитать после правок объектов: ${err.message}. `
        + 'Показаны зоны предыдущего расчёта — пятно застройки по ним считать нельзя.',
    });
    site.restrictions = rec.zones.restrictions || [];
    site.zoneGroups = rec.zones.zoneGroups || [];
    site.buildable = rec.zones.buildable || null;
    return { attached: true, recomputed: false, stale: true, built: rec.zones };
  }

  save(sessionId, planId, { rules: rec.rules, built });
  site.restrictions = built.restrictions;
  site.zoneGroups = built.zoneGroups || [];
  site.buildable = built.buildable;

  const wasArea = rec.zones.buildable ? rec.zones.buildable.areaM2 : null;
  const nowArea = built.buildable ? built.buildable.areaM2 : null;
  site.warnings = site.warnings || [];
  site.warnings.push({
    code: 'zones-recomputed',
    message: 'Зоны ограничений пересчитаны по вашим правкам на плане'
      + (wasArea !== null && nowArea !== null && wasArea !== nowArea
        ? `: допустимая территория ${wasArea} → ${nowArea} м².`
        : '.')
      + ' Правила и основания остались прежними — пересчитана только геометрия.',
  });
  return { attached: true, recomputed: true, built };
}

module.exports = { attach, save, get, latest, clear, editsFingerprint };
