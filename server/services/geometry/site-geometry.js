'use strict';
/**
 * SiteGeometry — нормализованное представление участка.
 *
 * Единая модель, к которой сводится всё, что удалось извлечь из исходников:
 * контуры из CAD, координаты поворотных точек из ГПЗУ, вычисленные зоны.
 * Дальше с ней работают движок ограничений, движок посадки и viewer.
 *
 * Три правила, на которых всё держится:
 *
 * 1. Геометрия хранится ЧИСЛАМИ — точками, линиями, полигонами. SVG и любой
 *    другой формат отрисовки строится из неё, но никогда не подменяет её.
 * 2. Координаты приведены к метрам. Исходные единицы и множитель записаны,
 *    поэтому обратный перевод в единицы чертежа точен.
 * 3. У каждого объекта есть происхождение: из какого файла, слоя и сущности он
 *    взят, каким способом и с какой уверенностью. Объект без provenance —
 *    ошибка модели, а не допустимое состояние (ТЗ, п. 24).
 */

/** Категории объектов. Набор расширяем: добавление типа не ломает API (ТЗ, п. 22). */
/**
 * Типы объектов. Перечень слоёв — в geometry/layers.js, он же единственный
 * источник правды для разбора чертежа, переназначения человеком и выгрузки DXF.
 * Здесь список остаётся плоским (его проверяет makeObject) и обязан покрывать
 * все назначаемые слои: иначе человек не сможет переназначить объект в тип,
 * который платформа сама же и предлагает.
 */
const OBJECT_TYPES = [
  'parcel',           // границы земельного участка
  'buildLine',        // границы застройки, линия регулирования
  'redLine',          // красная линия
  'building',         // капитальное строение
  'structure',        // некапитальное сооружение, навес
  'utility',          // инженерные сети
  'utilityStructure', // сооружения сетей: колодцы, опоры, ТП
  'road',             // дороги и проезды
  'parking',          // стоянки
  'footpath',         // тротуары и пешеходные связи
  'landscaping',      // благоустройство и озеленение
  'relief',           // рельеф: горизонтали, откосы, углубления, насыпи
  'water',            // водные объекты, канавы, дренаж
  'fence',            // ограждения
  'existingObject',   // прочие существующие объекты
  'restriction',      // зона ограничения (её считает движок, не модель)
  'annotation',       // подписи и пользовательские пометки
];

/**
 * Куда складывается объект каждого типа.
 *
 * Раскладка НЕ пишется руками: она выводится из geometry/layers.js — того же
 * списка, по которому чертёж разбирается, объект переназначается человеком и
 * пишется слой DXF. Свой список здесь уже стоил тридцати трёх контуров: слои
 * «14_Ограждения», «06_Инженерно-технические сооружения» и «45_Номера колодцев»
 * разбор опознавал как fence, structure и utilityStructure — а таких ключей в
 * раскладке не было, и addObject падал на `site[undefined].push(...)`. Наружу
 * это выглядело как «Контур пропущен: Cannot read properties of undefined»:
 * геометрия терялась молча, и никакой список типов было не свести глазами.
 *
 * Расчётные и служебные типы (их в layers.LAYERS нет) дописываются явно.
 */
const layerTaxonomy = require('./layers');

const TYPE_COLLECTION = {
  ...Object.fromEntries(layerTaxonomy.ASSIGNABLE.map((l) => [l.id, l.bucket])),
  restriction: 'restrictions',
  annotation: 'annotations',
};

/** Способы извлечения — важны для доверия к числу (ТЗ, п. 25, 28). */
const EXTRACTION_METHODS = [
  'cad-vector',        // разбор векторной геометрии DXF/DWG — самый надёжный источник
  'document-stated',   // координаты, записанные в документе (ГПЗУ), перенесены моделью
  'computed',          // вычислено детерминированным движком из другой геометрии
  'user',              // задано человеком
  'vision',            // распознано по изображению — только как подсказка
];

/**
 * Коды INSUNITS из DXF → множитель к метрам.
 *
 * Таблица полная (коды 0…24 по спецификации DXF), а не «те, что попадались».
 * Неполная таблица опаснее отсутствующей: код 7 (километры) молча принимался
 * за метры, участок 0,03×0,05 км превращался в 0 м², а сообщение уверяло, что
 * единицы в чертеже не заданы — человеку нечего было чинить.
 */
const UNIT_SCALE = {
  0: { scale: 1, label: 'не заданы (принято: метры)', assumed: true },
  1: { scale: 0.0254, label: 'дюймы' },
  2: { scale: 0.3048, label: 'футы' },
  3: { scale: 1609.344, label: 'мили' },
  4: { scale: 0.001, label: 'миллиметры' },
  5: { scale: 0.01, label: 'сантиметры' },
  6: { scale: 1, label: 'метры' },
  7: { scale: 1000, label: 'километры' },
  8: { scale: 2.54e-8, label: 'микродюймы' },
  9: { scale: 2.54e-5, label: 'милы (тысячные дюйма)' },
  10: { scale: 0.9144, label: 'ярды' },
  11: { scale: 1e-10, label: 'ангстремы' },
  12: { scale: 1e-9, label: 'нанометры' },
  13: { scale: 1e-6, label: 'микроны' },
  14: { scale: 0.1, label: 'дециметры' },
  15: { scale: 10, label: 'декаметры' },
  16: { scale: 100, label: 'гектометры' },
  17: { scale: 1e9, label: 'гигаметры' },
  18: { scale: 1.495978707e11, label: 'астрономические единицы' },
  19: { scale: 9.4607304725808e15, label: 'световые годы' },
  20: { scale: 3.0856775814913673e16, label: 'парсеки' },
  21: { scale: 1200 / 3937, label: 'футы США (survey)' },
  22: { scale: 100 / 3937, label: 'дюймы США (survey)' },
  23: { scale: 3600 / 3937, label: 'ярды США (survey)' },
  24: { scale: 6336000 / 3937, label: 'мили США (survey)' },
};

/**
 * Сведения о единицах чертежа по коду INSUNITS.
 * `assumed` — масштаб домыслен, а не взят из чертежа; `known` — код опознан.
 * Разница важна для текста предупреждения: «единицы не заданы» и «единицы
 * заданы кодом 42, которого нет в спецификации» — это разные починки.
 */
function unitInfo(insunits) {
  if (insunits === undefined || insunits === null || !Number.isFinite(Number(insunits))) {
    return { scale: 1, label: 'не заданы (принято: метры)', assumed: true, known: false, code: null };
  }
  const code = Number(insunits);
  const known = UNIT_SCALE[code];
  if (known) return { ...known, assumed: !!known.assumed, known: true, code };
  return {
    scale: 1,
    label: `код ${code} не распознан (принято: метры)`,
    assumed: true,
    known: false,
    code,
  };
}

/* ---------------- элементарная планарная геометрия ---------------- */
/* Считается здесь, а не моделью: площади и длины должны быть воспроизводимы. */

/** Площадь простого многоугольника (формула шнурования), м². */
function polygonArea(points) {
  if (!Array.isArray(points) || points.length < 3) return 0;
  let s = 0;
  for (let i = 0; i < points.length; i++) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[(i + 1) % points.length];
    s += x1 * y2 - x2 * y1;
  }
  return Math.abs(s) / 2;
}

/**
 * Площадь замкнутого контура с проверкой на самопересечение.
 *
 * Формула шнурования на «бабочке» гасит знаковые части и выдаёт 0 м² — молча,
 * с видом полной уверенности. В реальных чертежах такие контуры встречаются
 * постоянно (переставленные при оцифровке вершины), и участок 100×50 объявлялся
 * нулевым. Здесь контур сначала проверяется JTS: простой — площадь та же, что
 * и по шнурованию (до последнего знака, чтобы не поехали эталонные тесты);
 * самопересекающийся — площадь берётся после repair/buffer(0), тем самым она
 * совпадает с той, по которой считает весь остальной движок.
 *
 * @returns {{areaM2:number, selfIntersecting:boolean}}
 */
const AREA_CHECK_MAX_POINTS = 5000; // дальше проверка дороже пользы

function polygonAreaChecked(points) {
  const simple = polygonArea(points);
  if (!Array.isArray(points) || points.length < 3 || points.length > AREA_CHECK_MAX_POINTS) {
    return { areaM2: simple, selfIntersecting: false };
  }
  try {
    const info = require('./jts').ringInfo(points);
    if (!info) return { areaM2: simple, selfIntersecting: false };
    if (info.valid) return { areaM2: simple, selfIntersecting: false };
    return { areaM2: info.area, selfIntersecting: true };
  } catch {
    // JTS недоступен или подавился контуром — лучше честное шнурование, чем падение
    return { areaM2: simple, selfIntersecting: false };
  }
}

/** Длина ломаной (для замкнутой — периметр), м. */
function pathLength(points, closed = false) {
  if (!Array.isArray(points) || points.length < 2) return 0;
  let p = 0;
  const n = closed ? points.length : points.length - 1;
  for (let i = 0; i < n; i++) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[(i + 1) % points.length];
    p += Math.hypot(x2 - x1, y2 - y1);
  }
  return p;
}

function bounds(points) {
  if (!points || !points.length) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of points) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
}

/** Центр тяжести многоугольника; для вырожденных — среднее вершин. */
function centroid(points) {
  if (!points || !points.length) return null;
  let a = 0, cx = 0, cy = 0;
  for (let i = 0; i < points.length; i++) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[(i + 1) % points.length];
    const cross = x1 * y2 - x2 * y1;
    a += cross;
    cx += (x1 + x2) * cross;
    cy += (y1 + y2) * cross;
  }
  if (Math.abs(a) < 1e-9) {
    const sx = points.reduce((s, p) => s + p[0], 0);
    const sy = points.reduce((s, p) => s + p[1], 0);
    return [sx / points.length, sy / points.length];
  }
  a *= 0.5;
  return [cx / (6 * a), cy / (6 * a)];
}

/** Убирает дубли подряд идущих точек и замыкающее повторение первой вершины. */
function cleanPoints(points, closed) {
  const out = [];
  for (const p of points || []) {
    if (!Array.isArray(p) || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) continue;
    const last = out[out.length - 1];
    if (last && Math.abs(last[0] - p[0]) < 1e-9 && Math.abs(last[1] - p[1]) < 1e-9) continue;
    out.push([p[0], p[1]]);
  }
  if (closed && out.length > 2) {
    const a = out[0], b = out[out.length - 1];
    if (Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9) out.pop();
  }
  return out;
}

/* ---------------- построение модели ---------------- */

function createSiteGeometry({ coordinateSystem = null, sourceReferences = [] } = {}) {
  return {
    version: 1,
    coordinateSystem: coordinateSystem || {
      name: 'система координат чертежа',
      kind: 'unknown',      // unknown | local | msk — уточняется при разборе документов
      units: 'm',           // рабочие единицы модели всегда метры
      sourceUnits: 'не определены',
      unitScale: 1,         // множитель «единица источника → метр»
      assumedUnits: true,
    },
    drawingBounds: null,
    /*
     * Привязка чертежа по крестам координатной сетки (geometry/grid-crosses.js):
     * какая ось чертежа несёт какое семейство координат и есть ли сдвиг.
     * null — сетку в чертеже прочитать не удалось.
     */
    gridRef: null,
    parcel: null,
    buildings: [],
    redLines: [],
    restrictions: [],
    existingObjects: [],
    utilities: [],
    annotations: [],
    sourceReferences: [...sourceReferences],
    warnings: [],
  };
}

let seq = 0;
function nextId(type) {
  seq += 1;
  return `${type}-${seq.toString(36)}`;
}

/**
 * Объект модели. Бросает, если нет происхождения или геометрия пустая:
 * молча принять объект без источника — значит потерять возможность объяснить,
 * откуда он взялся, а это прямое требование ТЗ (п. 24).
 */
function makeObject({
  type, points, closed = false, geometry = null, properties = {}, provenance = {}, id = null,
}) {
  if (!OBJECT_TYPES.includes(type)) throw new Error(`Неизвестный тип объекта: ${type}`);
  const method = provenance.extractionMethod;
  if (!EXTRACTION_METHODS.includes(method)) {
    throw new Error(`У объекта ${type} нет способа извлечения (extractionMethod)`);
  }
  if (!provenance.sourceFile && method !== 'computed' && method !== 'user') {
    throw new Error(`У объекта ${type} не указан исходный файл`);
  }

  // Готовая геометрия от движка: зона ограничения может быть мультиполигоном
  // с отверстиями — простым списком точек её не описать.
  if (geometry) return makeFromGeometry({ type, geometry, properties, provenance, id, method });

  const pts = cleanPoints(points, closed);
  if (pts.length < (closed ? 3 : 2)) throw new Error(`У объекта ${type} недостаточно точек`);

  const isPolygon = closed && pts.length >= 3;
  const checked = isPolygon ? polygonAreaChecked(pts) : { areaM2: 0, selfIntersecting: false };
  const length = pathLength(pts, closed);

  return {
    id: id || nextId(type),
    type,
    geometry: { type: isPolygon ? 'polygon' : 'polyline', closed: !!closed, points: pts },
    properties: {
      ...(isPolygon ? { areaM2: round(checked.areaM2, 2) } : {}),
      [isPolygon ? 'perimeterM' : 'lengthM']: round(length, 2),
      vertices: pts.length,
      // самопересечение не прячется: по нему выдаётся предупреждение при разборе
      ...(checked.selfIntersecting ? { selfIntersecting: true } : {}),
      ...properties,
    },
    provenance: {
      sourceFile: provenance.sourceFile || null,
      sourceFileId: provenance.sourceFileId || null,
      sourceLayer: provenance.sourceLayer || null,
      sourceEntity: provenance.sourceEntity || null,
      extractionMethod: method,
      confidence: clamp01(provenance.confidence ?? 0.5),
      reason: provenance.reason || '',
      basis: provenance.basis || null, // норматив/пункт документа, если объект вычислен по правилу
    },
  };
}

/** Объект из готовой геометрии (полигон с отверстиями или мультиполигон). */
function makeFromGeometry({ type, geometry, properties, provenance, id, method }) {
  const areaOf = (poly) => polygonArea(poly.points) - (poly.holes || []).reduce((s, h) => s + polygonArea(h), 0);
  let area = 0, vertices = 0;
  if (geometry.type === 'multipolygon') {
    for (const p of geometry.polygons || []) {
      area += areaOf(p);
      vertices += p.points.length + (p.holes || []).reduce((s, h) => s + h.length, 0);
    }
  } else {
    area = areaOf(geometry);
    vertices = geometry.points.length + (geometry.holes || []).reduce((s, h) => s + h.length, 0);
  }
  return {
    id: id || nextId(type),
    type,
    geometry,
    properties: { areaM2: round(area, 2), vertices, ...properties },
    provenance: {
      sourceFile: provenance.sourceFile || null,
      sourceFileId: provenance.sourceFileId || null,
      sourceLayer: provenance.sourceLayer || null,
      sourceEntity: provenance.sourceEntity || null,
      extractionMethod: method,
      confidence: clamp01(provenance.confidence ?? 0.5),
      reason: provenance.reason || '',
      basis: provenance.basis || null,
    },
  };
}

function addObject(site, object) {
  const key = TYPE_COLLECTION[object.type];
  // Тип есть в OBJECT_TYPES, а места под него в модели нет — это дефект раскладки,
  // а не данных. Говорим об этом прямо: молчаливая потеря контура обходится дороже.
  if (!key || (key !== 'parcel' && !Array.isArray(site[key]))) {
    throw new Error(`Тип «${object.type}» некуда положить: в раскладке нет массива «${key || 'не задан'}»`);
  }
  if (key === 'parcel') {
    // участок один; при нескольких кандидатах остаётся крупнейший, остальные — в существующие
    const prev = site.parcel;
    if (!prev) { site.parcel = object; return object; }
    const [keep, drop] = (object.properties.areaM2 || 0) > (prev.properties.areaM2 || 0)
      ? [object, prev] : [prev, object];
    site.parcel = keep;
    drop.properties.note = 'кандидат в границы участка, отклонён: площадь меньше выбранного';
    site.existingObjects.push(drop);
    return object;
  }
  site[key].push(object);
  return object;
}

/**
 * Все вершины геометрии любого вида: полилиния, полигон с отверстиями,
 * мультиполигон. Раньше габариты собирались прямым `...o.geometry.points`,
 * и первая же посчитанная зона (а они как раз мультиполигоны) роняла расчёт
 * исключением «points is not iterable».
 */
function geometryPoints(geometry) {
  if (!geometry) return [];
  const out = [];
  const takeRing = (ring) => { for (const p of ring || []) if (Array.isArray(p)) out.push(p); };
  const takePoly = (poly) => {
    takeRing(poly.points);
    for (const h of poly.holes || []) takeRing(h);
  };
  if (geometry.type === 'multipolygon') {
    for (const p of geometry.polygons || []) takePoly(p);
  } else if (Array.isArray(geometry.points)) {
    takePoly(geometry);
  }
  return out;
}

/** Габариты всей модели пересчитываются по фактическим объектам. */
function recomputeBounds(site) {
  const all = [];
  for (const o of allObjects(site)) all.push(...geometryPoints(o.geometry));
  site.drawingBounds = bounds(all.filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1])));
  return site.drawingBounds;
}

/**
 * Слияние списков предупреждений без дублей.
 *
 * Нужно там, где один и тот же расчёт мог отработать и в основном потоке
 * (предупреждение уже лежит в site.warnings), и в worker'е (оно вернулось
 * из движка отдельным списком). Показывать человеку одно и то же дважды —
 * верный способ приучить его не читать предупреждения вовсе.
 */
function mergeWarnings(target, extra) {
  const list = Array.isArray(target) ? target : [];
  const seen = new Set(list.map((w) => `${w && w.code}|${w && w.message}`));
  for (const w of extra || []) {
    if (!w) continue;
    const key = `${w.code}|${w.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    list.push(w);
  }
  return list;
}

function allObjects(site) {
  return [
    ...(site.parcel ? [site.parcel] : []),
    ...site.buildings, ...site.redLines, ...site.restrictions,
    ...site.existingObjects, ...site.utilities,
  ];
}

/**
 * Человеческое объяснение происхождения объекта (ТЗ, п. 24).
 * Именно это показывается пользователю рядом с зоной ограничения.
 */
function explain(object) {
  if (!object || !object.provenance) return 'происхождение не записано';
  const p = object.provenance;
  const steps = [];
  if (p.basis) steps.push(`основание: ${p.basis}`);
  if (p.sourceFile) steps.push(`источник: ${p.sourceFile}`);
  if (p.sourceLayer) steps.push(`слой: ${p.sourceLayer}`);
  if (p.sourceEntity) steps.push(`объект чертежа: ${p.sourceEntity}`);
  steps.push(`способ: ${METHOD_LABELS[p.extractionMethod] || p.extractionMethod}`);
  if (p.reason) steps.push(p.reason);
  steps.push(`уверенность: ${Math.round(p.confidence * 100)}%`);
  return steps.join(' → ');
}

const METHOD_LABELS = {
  'cad-vector': 'векторная геометрия чертежа',
  'document-stated': 'координаты, указанные в документе',
  computed: 'вычислено геометрическим движком',
  user: 'задано пользователем',
  vision: 'распознано по изображению',
};

/** Сводка для интерфейса и журнала. */
function summary(site) {
  return {
    // единицы чертежа могут быть не заданы вовсе — тогда так и пишем,
    // а не показываем «код undefined»: это читает человек, а не отладчик
    единицы: site.coordinateSystem.assumedUnits
      ? 'в чертеже не заданы, приняты метры'
      : `${site.coordinateSystem.sourceUnits} → метры (×${site.coordinateSystem.unitScale})`,
    участок: site.parcel ? `${site.parcel.properties.areaM2} м²` : 'не определён',
    зданий: site.buildings.length,
    красныхЛиний: site.redLines.length,
    существующихОбъектов: site.existingObjects.length,
    инженерныхСетей: site.utilities.length,
    ограничений: site.restrictions.length,
    предупреждений: site.warnings.length,
  };
}

function round(n, digits) {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

function clamp01(n) {
  return Math.max(0, Math.min(1, Number.isFinite(n) ? n : 0));
}

module.exports = {
  OBJECT_TYPES, EXTRACTION_METHODS, TYPE_COLLECTION,
  createSiteGeometry, makeObject, addObject, recomputeBounds, allObjects,
  explain, summary, unitInfo, mergeWarnings, geometryPoints,
  polygonArea, polygonAreaChecked, pathLength, bounds, centroid, cleanPoints, round,
};
