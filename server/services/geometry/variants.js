'use strict';
/**
 * Четыре варианта посадки (ТЗ, п. 43, 46–48).
 *
 * Движок посадки выдаёт сотни допустимых пятен, но почти все они — один и тот же
 * прямоугольник, сдвинутый на метр. Здесь из этой массы отбираются четыре
 * ГЕОМЕТРИЧЕСКИ РАЗНЫХ варианта и для каждого считается перечень мероприятий.
 *
 * Правило владельца, жёстче требования ТЗ: вариант 1 всегда без воздействия на
 * критические объекты. Варианты 2–4 могут предлагать перенос, но получают статус
 * «требует решения» и допустимыми не считаются, пока человек не подтвердит.
 */
const G = require('./site-geometry');
const jts = require('./jts');
const critical = require('./critical-objects');

const VARIANT_COUNT = 4;

/** Критерии дальнейшего поиска (ТЗ, п. 44). Рабочий пока один. */
const CRITERIA = [
  { id: 'maxArea', label: 'Максимальная площадь застройки', enabled: true },
  { id: 'minRelocations', label: 'Минимум переносов', enabled: false },
  { id: 'minImpact', label: 'Минимум воздействия на существующие объекты', enabled: false },
  { id: 'minCost', label: 'Минимальная потенциальная стоимость', enabled: false },
  { id: 'bestAccess', label: 'Лучший подъезд', enabled: false },
  { id: 'maxParking', label: 'Максимум парковки', enabled: false },
  { id: 'efficientUse', label: 'Эффективное использование участка', enabled: false },
];

/* ---------------- мероприятия ---------------- */

const ACTION_TITLES = {
  demolish: 'Демонтаж строения',
  relocate: 'Перенос объекта',
  relocateFence: 'Перенос ограждения',
  relocateUtility: 'Вынос инженерной сети',
  clear: 'Освобождение территории',
};

/**
 * Мероприятия по задетым объектам. Объём считается геометрией (ТЗ, п. 48):
 * площадь сноса в м², длина переносимой сети или ограждения в м.
 * Стоимость здесь не появляется и появиться не может — только объём.
 */
function actionsFor(site, affected) {
  const actions = [];
  for (const hit of affected) {
    const obj = findObject(site, hit.id);
    if (!obj) continue;
    const layer = obj.provenance.sourceLayer || '';
    const info = critical.classify(layer);
    const linear = obj.geometry.type === 'polyline';

    let kind = 'clear';
    if (hit.layer === 'buildings') kind = info.classification === 'movable' ? 'relocate' : 'demolish';
    else if (hit.layer === 'utilities') kind = 'relocateUtility';
    else if (/ограждени|забор/i.test(layer)) kind = 'relocateFence';
    else kind = info.classification === 'demolishable' ? 'demolish' : 'relocate';

    actions.push({
      kind,
      objectId: obj.id,
      title: `${ACTION_TITLES[kind]}: ${layer || 'объект без слоя'}`,
      volume: linear ? obj.properties.lengthM : obj.properties.areaM2,
      unit: linear ? 'м' : 'м²',
      classification: info.classification,
      classificationLabel: critical.LABELS[info.classification],
      basis: info.basis || '',
      validatedBy: info.validatedBy || '',
      // критический объект нельзя переносить без решения человека (ТЗ, п. 46)
      requiresDecision: info.classification === 'critical' || info.classification === 'unknown',
      note: info.classification === 'unknown'
        ? 'Класс объекта не определён — подтвердите, критический ли он'
        : (info.source === 'норматив' ? 'классификация по нормативу' : ''),
    });
  }
  return actions;
}

function findObject(site, id) {
  return G.allObjects(site).find((o) => o.id === id) || null;
}

/** Объём мероприятий в формате существующего контракта tep[] (ТЗ, п. 48). */
function actionsToTep(actions) {
  const byUnit = new Map();
  for (const a of actions) {
    if (!Number.isFinite(a.volume)) continue;
    const key = `${ACTION_TITLES[a.kind] || a.kind}|${a.unit}`;
    byUnit.set(key, (byUnit.get(key) || 0) + a.volume);
  }
  return [...byUnit.entries()].map(([key, value]) => {
    const [name, unit] = key.split('|');
    return { name, value: Math.round(value * 100) / 100, unit };
  });
}

/* ---------------- отбор различающихся вариантов ---------------- */

/**
 * Признаки кандидата для сравнения «насколько варианты разные».
 * Ровно то, что перечислено в §43: место на участке, поворот, конфигурация
 * пятна и зависимость от существующих объектов.
 */
function features(candidate, scale) {
  const aspect = candidate.width / candidate.length;
  return {
    x: candidate.center[0] / scale,
    y: candidate.center[1] / scale,
    // поворот цикличен: 0° и 180° — одно и то же
    rotSin: Math.sin((candidate.rotationDeg * Math.PI) / 90),
    rotCos: Math.cos((candidate.rotationDeg * Math.PI) / 90),
    aspect: Math.log(aspect),
    shape: candidate.shape || 'rect',
    affected: new Set(candidate.affected.map((a) => a.id)),
  };
}

function distance(a, b) {
  const geo = Math.hypot(a.x - b.x, a.y - b.y);
  const rot = Math.hypot(a.rotSin - b.rotSin, a.rotCos - b.rotCos) * 0.5;
  const proportion = Math.abs(a.aspect - b.aspect) * 0.4;
  // разная конфигурация корпуса — самое заметное для человека различие,
  // поэтому вес у неё выше, чем у сдвига и поворота
  const form = a.shape === b.shape ? 0 : 0.9;
  // разная зависимость от существующих объектов — тоже различие вариантов
  const union = new Set([...a.affected, ...b.affected]);
  const common = [...a.affected].filter((id) => b.affected.has(id)).length;
  const objects = union.size ? (1 - common / union.size) * 0.5 : 0;
  return geo + rot + proportion + form + objects;
}

/**
 * Канонический ключ пятна: вершины, округлённые до дециметра и отсортированные.
 * Квадрат, повёрнутый на 90° вокруг своего центра, — это ТОТ ЖЕ многоугольник,
 * и показывать его как отдельный вариант нельзя (ТЗ, п. 43: различие не может
 * состоять в одном лишь сдвиге или развороте).
 */
function shapeKey(candidate) {
  return candidate.footprint.points
    .map(([x, y]) => `${Math.round(x * 10)},${Math.round(y * 10)}`)
    .sort()
    .join(';');
}

/** Отбрасывает геометрически одинаковые пятна, сохраняя порядок предпочтения. */
function dedupeGeometric(candidates) {
  const seen = new Set();
  const out = [];
  for (const c of candidates) {
    const key = shapeKey(c);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

/**
 * Жадный отбор максимально непохожих: берём лучший по критерию, затем каждый раз
 * тот, что дальше всего от уже выбранных. Это даёт разброс по участку вместо
 * четырёх одинаковых прямоугольников рядом.
 */
function selectDiverse(candidates, count, scale, seeds = []) {
  if (count <= 0) return [];
  if (candidates.length <= count) return [...candidates];
  const feats = candidates.map((c) => features(c, scale));
  // уже выбранные варианты участвуют в расчёте расстояний, но в выдачу не идут —
  // иначе второй вариант окажется в трёх метрах от первого
  const seedFeats = seeds.map((c) => features(c, scale));
  const picked = [];
  if (!seedFeats.length) picked.push(0);
  while (picked.length < count) {
    let best = -1; let bestDist = -1;
    for (let i = 0; i < candidates.length; i++) {
      if (picked.includes(i)) continue;
      let minD = Infinity;
      for (const p of picked) minD = Math.min(minD, distance(feats[i], feats[p]));
      for (const f of seedFeats) minD = Math.min(minD, distance(feats[i], f));
      if (minD > bestDist) { bestDist = minD; best = i; }
    }
    if (best < 0) break;
    picked.push(best);
  }
  return picked.map((i) => candidates[i]);
}

/** Сортировка кандидатов по выбранному критерию (ТЗ, п. 44). */
function rank(candidates, criterion) {
  const byArea = (a, b) => b.areaM2 - a.areaM2;
  const byImpact = (a, b) => a.affected.length - b.affected.length || byArea(a, b);
  if (criterion === 'minRelocations' || criterion === 'minImpact') return [...candidates].sort(byImpact);
  return [...candidates].sort(byArea); // maxArea по умолчанию
}

/* ---------------- сборка вариантов ---------------- */

/**
 * Четыре варианта из массы кандидатов.
 * @param {object} site        SiteGeometry с ограничениями
 * @param {Array}  candidates  результат placement-engine
 * @param {string} criterion   критерий предпочтения
 */
function build(site, candidates, { criterion = 'maxArea', count = VARIANT_COUNT } = {}) {
  if (!candidates.length) return { variants: [], notes: ['Допустимых размещений не найдено.'] };

  const b = site.parcel ? G.bounds(site.parcel.geometry.points) : G.bounds(candidates[0].footprint.points);
  const scale = Math.max(b.maxX - b.minX, b.maxY - b.minY, 1);

  // каждому кандидату — его мероприятия: без них не понять, кто трогает критику
  const enriched = candidates.map((c) => {
    const actions = actionsFor(site, c.affected);
    return {
      ...c,
      actions,
      touchesCritical: actions.some((a) => a.classification === 'critical'),
      needsDecision: actions.some((a) => a.requiresDecision),
    };
  });

  // Вариант 1 — строго без воздействия на критические объекты (решение владельца).
  const clean = rank(enriched.filter((c) => !c.touchesCritical && c.admissible), criterion);
  const rest = rank(enriched.filter((c) => !clean.includes(c)), criterion);

  const chosen = [];
  const notes = [];
  if (clean.length) {
    chosen.push(clean[0]);
  } else {
    notes.push('Ни одно размещение не обошлось без воздействия на критические объекты — ' +
      'вариант 1 тоже требует вашего решения.');
  }

  // остальные добираются из общего пула с максимальным разбросом;
  // одинаковые по геометрии пятна из пула убираются
  const pool = dedupeGeometric([...clean.slice(chosen.length ? 1 : 0), ...rest])
    .filter((c) => !chosen.includes(c) && shapeKey(c) !== (chosen[0] && shapeKey(chosen[0])));
  for (const c of selectDiverse(pool, Math.max(0, count - chosen.length), scale, chosen)) chosen.push(c);

  const variants = chosen.slice(0, count).map((c, i) => toVariant(c, i + 1, site));
  if (variants.length < count) {
    notes.push(`Найдено ${variants.length} различающихся размещений вместо ${count}: ` +
      'допустимая территория слишком мала или требования слишком жёсткие.');
  }
  return { variants, notes };
}

function toVariant(c, number, site) {
  const warnings = [];
  for (const v of c.violations) warnings.push(v.message);
  for (const w of c.warnings) warnings.push(w.message);
  const needsDecision = c.needsDecision || (number === 1 ? false : c.touchesCritical);

  return {
    number,
    footprint: c.footprint,
    metrics: {
      areaM2: c.areaM2,
      width: c.width,
      length: c.length,
      shape: c.shape || 'rect',
      shapeLabel: c.shapeLabel || 'прямоугольник',
      shapeNote: c.shapeNote || '',
      rotationDeg: c.rotationDeg,
      floors: c.floors || null,
      reshaped: c.reshaped,
      center: c.center,
      affectedCount: c.affected.length,
      buildingsAffected: c.affected.filter((a) => a.layer === 'buildings').length,
      utilitiesAffected: c.affected.filter((a) => a.layer === 'utilities').length,
      tep: actionsToTep(c.actions),
    },
    actions: c.actions,
    warnings,
    // допустимым вариант считается, только если нет нарушений И не ждёт решения
    status: c.violations.length ? 'violations' : (needsDecision ? 'needs_decision' : 'admissible'),
    statusLabel: c.violations.length
      ? 'есть нарушения'
      : (needsDecision ? 'требует вашего решения' : 'допустим'),
    touchesCritical: c.touchesCritical,
  };
}

module.exports = { build, selectDiverse, dedupeGeometric, shapeKey, actionsFor, actionsToTep, rank, features, distance, CRITERIA, VARIANT_COUNT };
