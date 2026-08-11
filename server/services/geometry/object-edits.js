'use strict';
/**
 * Правки свойств объектов плана человеком.
 *
 * Разбор чертежа угадывает тип объекта по имени слоя и геометрии — и ошибается:
 * на настоящем МСК-47_Горбунки за границу участка берётся контур покрытия 72 м²
 * вместо 3700 м² из ГПЗУ. Человек, глядя на план, знает правду. Здесь она и
 * хранится: чем объект является на самом деле, как он называется и переносится ли он.
 *
 * Три следствия, и все три обязательны:
 *  1) правка ПРИМЕНЯЕТСЯ к плану — иначе редактирование свойств было бы театром;
 *  2) правка ПЕРЕЖИВАЕТ переразбор чертежа — ключом служит не id объекта
 *     (он выдаётся по порядку и меняется), а файл + слой + сущность DXF;
 *  3) правка СОХРАНЯЕТСЯ для дообучения — пара «что увидел разбор → что сказал
 *     человек» и есть обучающий пример (exportJsonl).
 */
const crypto = require('crypto');
const { db, now } = require('../../db');
const G = require('./site-geometry');

// Перечень слоёв — общий с разбором чертежа и с выгрузкой DXF (geometry/layers.js).
// Свой список здесь уже приводил к тому, что объект, переназначенный человеком
// в «ландшафт», в чертёж уходил по-прежнему в слой сетей.
const layers = require('./layers');

/** Типы, которые человек вправе назначить. Расчётные (restriction) сюда не входят. */
const USER_TYPES = layers.ids();

/** Куда в плане попадает объект назначенного типа. parcel — отдельное поле, не массив. */
const TYPE_LAYER = Object.fromEntries(USER_TYPES.map((id) => [id, layers.bucketOf(id)]));

/**
 * Что человек решил делать с существующим объектом. Пока не спрошено — «не
 * решено»: молча «оставить» ставить нельзя, от этого зависит пятно застройки.
 *
 * `demolish` (снос) добавлен потому, что без него шаг «Существующие объекты»
 * методики выразить было нечем. Человек, разметивший здание под демонтаж,
 * выбирал «переносится» и дописывал «демонтаж» в комментарий — то есть решение
 * оставалось словами в свободном поле и до расчётов не доходило. Снесённое
 * здание не даёт противопожарных разрывов и освобождает место под пятно;
 * перенесённое — тоже, но требует мероприятия. Это разные вещи.
 */
const RELOCATIONS = ['undecided', 'keep', 'move', 'demolish'];

/** Подписи решений — одни на сервер, интерфейс и чертёж. */
const RELOCATION_LABELS = {
  undecided: 'не решено',
  keep: 'сохраняется',
  move: 'переносится',
  demolish: 'сносится (демонтаж)',
};

const LAYER_ARRAYS = ['buildings', 'redLines', 'utilities', 'existingObjects'];

const MAX_LABEL = 200;
const MAX_COMMENT = 1000;

/**
 * Отпечаток геометрии: то, что отличает ОДИН контур от соседнего и при этом
 * не меняется при повторном разборе того же файла.
 *
 * Берутся габариты (до сантиметра), число вершин и длина обхода. Разбор одного
 * и того же DXF даёт те же координаты до последнего знака, поэтому отпечаток
 * устойчив; совпасть сразу по габаритам, числу вершин и периметру два разных
 * контура на одной площадке практически не могут, а если совпадут — они
 * геометрически неразличимы, и правка к ним и должна относиться одинаково.
 */
function geometryFingerprint(obj) {
  const g = obj && obj.geometry;
  if (!g) return '';
  const pts = [];
  const ring = (r) => { for (const p of r || []) if (Array.isArray(p)) pts.push(p); };
  const poly = (p) => { ring(p.points); for (const h of p.holes || []) ring(h); };
  if (g.type === 'multipolygon') for (const p of g.polygons || []) poly(p);
  else if (g.points) poly(g);
  if (!pts.length) return '';
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const q = (n) => Math.round(n * 100) / 100; // сантиметр — предел точности съёмки
  const len = G.pathLength(pts, g.type !== 'polyline');
  return [q(Math.min(...xs)), q(Math.min(...ys)), q(Math.max(...xs)), q(Math.max(...ys)),
    pts.length, q(len)].join(',');
}

/**
 * Устойчивый ключ объекта. Пока чертёж тот же, ключ тот же — и правка находит
 * свой объект после переразбора.
 *
 * В ключ ОБЯЗАН входить отпечаток геометрии. Раньше он состоял из файла, слоя
 * и вида сущности DXF — и все 33 здания со слоя «03_Здания и строения»,
 * снятые замкнутой полилинией, получали ОДИН ключ на всех. Человек помечал
 * одно здание сносимым, а помеченными оказывались все: правка одного объекта
 * расползалась по чертежу. Файл и слой остаются в ключе, чтобы он оставался
 * читаемым в выгрузке для дообучения.
 */
function keyOf(obj, layer) {
  const p = (obj && obj.provenance) || {};
  const fp = geometryFingerprint(obj);
  const parts = [p.sourceFileId || p.sourceFile || '', p.sourceLayer || '', p.sourceEntity || ''];
  if (fp) return `g:${parts.join('|')}#${fp}`;
  if (parts.some((x) => x)) return `e:${parts.join('|')}`;
  return `o:${layer}|${(obj && obj.id) || ''}`;
}

/**
 * Ключ прежнего образца — без отпечатка геометрии. Нужен ровно затем, чтобы
 * правки, сохранённые до версии 3, не пропали: они накладываются, но только
 * если такой ключ в плане ровно у одного объекта. Совпало у нескольких —
 * применять нельзя, это и есть та самая расползающаяся правка.
 */
function legacyKeyOf(obj, layer) {
  const p = (obj && obj.provenance) || {};
  const parts = [p.sourceFileId || p.sourceFile || '', p.sourceLayer || '', p.sourceEntity || ''];
  if (parts.some((x) => x)) return `e:${parts.join('|')}`;
  return `o:${layer}|${(obj && obj.id) || ''}`;
}

/** Что видел разбор — вторая половина обучающего примера. */
function parserSnapshot(obj, layer) {
  const p = (obj && obj.provenance) || {};
  const pr = (obj && obj.properties) || {};
  return {
    type: obj && obj.type,
    layer,
    sourceFile: p.sourceFile || null,
    sourceLayer: p.sourceLayer || null,
    sourceEntity: p.sourceEntity || null,
    extractionMethod: p.extractionMethod || null,
    confidence: typeof p.confidence === 'number' ? p.confidence : null,
    reason: p.reason || null,
    geometry: {
      kind: obj && obj.geometry ? obj.geometry.type : null,
      areaM2: pr.areaM2 ?? null,
      lengthM: pr.lengthM ?? pr.perimeterM ?? null,
      vertices: pr.vertices ?? null,
    },
  };
}

function normalizePatch(raw = {}) {
  const patch = {};
  if (raw.type !== undefined && raw.type !== null && raw.type !== '') {
    if (!USER_TYPES.includes(raw.type)) throw new Error(`Недопустимый тип объекта: ${raw.type}`);
    patch.type = raw.type;
  }
  if (raw.label !== undefined) patch.label = String(raw.label).slice(0, MAX_LABEL);
  if (raw.comment !== undefined) patch.comment = String(raw.comment).slice(0, MAX_COMMENT);
  if (raw.relocation !== undefined && raw.relocation !== '') {
    if (!RELOCATIONS.includes(raw.relocation)) throw new Error(`Недопустимое решение по объекту: ${raw.relocation}`);
    patch.relocation = raw.relocation;
  }
  if (!Object.keys(patch).length) throw new Error('Правка пустая: нечего сохранять');
  return patch;
}

function rowToApi(row) {
  return {
    id: row.id,
    objectId: row.object_id,
    objectKey: row.object_key,
    layer: row.layer,
    patch: safeParse(row.patch) || {},
    parser: safeParse(row.parser) || null,
    author: row.author || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function safeParse(s) { try { return JSON.parse(s); } catch { return null; } }

function list(sessionId) {
  return db.prepare('SELECT * FROM plan_object_edits WHERE session_id = ? ORDER BY created_at').all(sessionId).map(rowToApi);
}

/**
 * Сохранить правку. Повторная правка того же объекта дополняет прежнюю, а не
 * заводит вторую: иначе в выгрузке для обучения окажутся два противоречащих
 * примера на один и тот же контур.
 */
function save(sessionId, { planId = '', objectId, layer, object, patch, author = '' }) {
  if (!objectId) throw new Error('Не указан объект');
  const clean = normalizePatch(patch);
  const key = keyOf(object, layer);
  const ts = now();
  const existing = db.prepare('SELECT * FROM plan_object_edits WHERE session_id = ? AND object_key = ?').get(sessionId, key);
  if (existing) {
    const merged = { ...(safeParse(existing.patch) || {}), ...clean };
    db.prepare('UPDATE plan_object_edits SET plan_id = ?, object_id = ?, layer = ?, parser = ?, patch = ?, author = ?, updated_at = ? WHERE id = ?')
      .run(String(planId), String(objectId), String(layer), JSON.stringify(parserSnapshot(object, layer)),
        JSON.stringify(merged), String(author).slice(0, 120), ts, existing.id);
    return rowToApi(db.prepare('SELECT * FROM plan_object_edits WHERE id = ?').get(existing.id));
  }
  const id = crypto.randomUUID();
  db.prepare(`INSERT INTO plan_object_edits
      (id, session_id, plan_id, object_id, object_key, layer, parser, patch, author, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, sessionId, String(planId), String(objectId), key, String(layer),
      JSON.stringify(parserSnapshot(object, layer)), JSON.stringify(clean), String(author).slice(0, 120), ts, ts);
  return rowToApi(db.prepare('SELECT * FROM plan_object_edits WHERE id = ?').get(id));
}

function remove(sessionId, objectKey) {
  const row = db.prepare('SELECT id FROM plan_object_edits WHERE session_id = ? AND object_key = ?').get(sessionId, objectKey);
  if (!row) return false;
  db.prepare('DELETE FROM plan_object_edits WHERE id = ?').run(row.id);
  return true;
}

/**
 * Смена типа меняет и ПРИРОДУ геометрии.
 *
 * Сеть, красная линия и рельеф хранятся ломаной, даже если контур замкнут:
 * буфер вокруг кольца — это не буфер вокруг залитой площадки. Поэтому контур
 * со слоя «33_Газопровод», назначенный человеком участком, оставался ломаной —
 * и участок получался БЕЗ ПЛОЩАДИ, а на ней стоит всё: ТЭП, зоны ограничений,
 * посадка. Здесь геометрия пересобирается под новый тип.
 *
 * Замыкание не выдумывается: ломаная становится полигоном, только если она
 * и была кольцом (первая точка совпадает с последней либо стоит пометка
 * closedRing от разбора). Открытая линия, названная зданием, полигоном не станет.
 */
function retypeGeometry(obj, newType) {
  const g = obj.geometry;
  if (!g || g.type === 'multipolygon') return;
  const wantPolygon = !layers.isLinear(newType);

  if (wantPolygon && g.type === 'polyline') {
    let pts = [...(g.points || [])];
    const first = pts[0];
    const last = pts[pts.length - 1];
    if (!first || !last || pts.length < 3) return;
    // Концы контура в съёмке почти никогда не совпадают до знака: у настоящего
    // контура с газопровода в Горбунках разрыв 5 см на 274 м. Требовать точного
    // равенства значило бы отказывать человеку в праве назначить участком
    // ровно тот контур, который он видит замкнутым. Допуск — 5 см или 0,1 % длины.
    const gap = Math.hypot(first[0] - last[0], first[1] - last[1]);
    const length = G.pathLength(pts, false);
    const tolerance = Math.max(0.05, length * 0.001);
    const isRing = (obj.properties && obj.properties.closedRing) || gap <= tolerance;
    if (!isRing) return;
    // хвостовая точка отбрасывается: полигон замыкается сам, а лишняя вершина
    // в 5 см от первой даёт вырожденный сегмент
    if (gap <= tolerance) pts = pts.slice(0, -1);
    if (pts.length < 3) return;
    obj.geometry = { type: 'polygon', closed: true, points: pts };
    const props = { ...obj.properties };
    delete props.lengthM;
    delete props.closedRing;
    obj.properties = {
      ...props,
      areaM2: G.round(G.polygonArea(pts), 2),
      perimeterM: G.round(G.pathLength(pts, true), 2),
      vertices: pts.length,
    };
    return;
  }

  if (!wantPolygon && g.type === 'polygon') {
    const ring = [...(g.points || [])];
    if (ring.length < 3) return;
    obj.geometry = { type: 'polyline', closed: false, points: [...ring, ring[0]] };
    const props = { ...obj.properties };
    delete props.areaM2;
    delete props.perimeterM;
    obj.properties = { ...props, closedRing: true, lengthM: G.round(G.pathLength(ring, true), 2) };
  }
}

/** Все объекты плана с их слоем — единый обход для поиска и применения правок. */
function* iterate(plan) {
  if (plan.parcel) yield { obj: plan.parcel, layer: 'parcel' };
  for (const layer of LAYER_ARRAYS) {
    for (const obj of plan[layer] || []) yield { obj, layer };
  }
}

/** Объект плана по id — для сохранения правки нужен снимок того, что видел разбор. */
function findObject(plan, objectId) {
  for (const item of iterate(plan)) if (item.obj.id === objectId) return item;
  return null;
}

/**
 * Накладывает правки на план. Тип меняется по-настоящему: объект переезжает
 * в свой слой, а назначенный участком становится границей участка — ради этого
 * правка и делается. Прежняя догадка разбора не затирается, она уходит
 * в properties.parserType: в предупреждениях и в выгрузке должно быть видно,
 * что именно поправил человек.
 */
function applyTo(plan, edits) {
  if (!plan || !edits || !edits.length) return { applied: 0, parcelReplaced: false };
  const byKey = new Map(edits.map((e) => [e.objectKey, e]));
  const moves = [];
  let applied = 0;
  let parcelReplaced = false;

  /*
   * Правки прежнего образца (без отпечатка геометрии) применяются только там,
   * где их ключ однозначен. Слой «03_Здания и строения» с замкнутой полилинией
   * даёт один и тот же старый ключ у всех тридцати трёх зданий — и такая правка
   * не применяется ни к одному из них: пусть человек поставит её заново тому
   * объекту, который имел в виду, чем платформа молча пометит весь чертёж.
   */
  const legacyCount = new Map();
  for (const { obj, layer } of iterate(plan)) {
    const lk = legacyKeyOf(obj, layer);
    legacyCount.set(lk, (legacyCount.get(lk) || 0) + 1);
  }
  let legacySkipped = 0;

  for (const { obj, layer } of iterate(plan)) {
    let edit = byKey.get(keyOf(obj, layer));
    if (!edit) {
      const lk = legacyKeyOf(obj, layer);
      const legacy = byKey.get(lk);
      if (legacy && legacyCount.get(lk) === 1) edit = legacy;
      else if (legacy) legacySkipped++;
    }
    if (!edit) continue;
    const patch = edit.patch || {};
    applied++;
    obj.properties = { ...obj.properties, userEdited: true };
    if (patch.label) obj.properties.userLabel = patch.label;
    if (patch.comment) obj.properties.userComment = patch.comment;
    if (patch.relocation) obj.properties.relocation = patch.relocation;
    if (patch.type && patch.type !== obj.type) {
      obj.properties.parserType = obj.type;
      retypeGeometry(obj, patch.type); // ломаная ↔ полигон: см. комментарий выше
      obj.type = patch.type;
      moves.push({ obj, from: layer, to: TYPE_LAYER[patch.type] });
    }
  }

  for (const m of moves) {
    if (m.from === m.to) continue;
    if (m.from === 'parcel') plan.parcel = null;
    else plan[m.from] = (plan[m.from] || []).filter((o) => o !== m.obj);
    if (m.to === 'parcel') {
      // прежний участок не выбрасывается: он остаётся объектом плана, но уже
      // не границей — иначе исправление уничтожало бы геометрию без следа
      if (plan.parcel && plan.parcel !== m.obj) {
        plan.parcel.properties = { ...plan.parcel.properties, demotedFromParcel: true };
        plan.existingObjects.push(plan.parcel);
      }
      plan.parcel = m.obj;
      parcelReplaced = true;
    } else {
      plan[m.to] = plan[m.to] || [];
      plan[m.to].push(m.obj);
    }
  }

  if (legacySkipped) {
    plan.warnings = (plan.warnings || []);
    plan.warnings.push({
      code: 'edits-legacy-ambiguous',
      message: `Правки свойств, сохранённые прежней версией, не применены к ${legacySkipped} объект(ам): ` +
        'их ключ не различал однотипные контуры одного слоя, и правка одного объекта расползалась на все. ' +
        'Откройте нужный объект на плане и сохраните правку заново — теперь она относится только к нему.',
    });
  }

  if (parcelReplaced) {
    plan.warnings = (plan.warnings || []).filter((w) => w.code !== 'parcel-guess');
    plan.warnings.push({
      code: 'parcel-user',
      message: 'Границей участка назначен контур, выбранный человеком, а не разбором чертежа. ' +
        'Площади, зоны ограничений и посадка считаются по нему.',
    });
  }
  return { applied, parcelReplaced, legacySkipped };
}

/**
 * Выгрузка для дообучения: по строке JSON на правку. Вход примера — то, что
 * видел разбор (имя слоя, геометрия, его собственная догадка и уверенность),
 * ответ — то, что сказал человек. Ничего, кроме этой пары, для обучения не нужно.
 */
function exportJsonl(sessionId) {
  const session = db.prepare('SELECT id, title FROM sessions WHERE id = ?').get(sessionId);
  return list(sessionId).map((e) => JSON.stringify({
    projectId: sessionId,
    project: (session && session.title) || '',
    key: e.objectKey,
    parser: e.parser,
    human: e.patch,
    author: e.author,
    at: new Date(e.updatedAt).toISOString(),
  })).join('\n');
}

module.exports = {
  list, save, remove, applyTo, exportJsonl, keyOf, legacyKeyOf, geometryFingerprint,
  findObject, parserSnapshot, normalizePatch,
  USER_TYPES, RELOCATIONS, RELOCATION_LABELS, TYPE_LAYER,
};
