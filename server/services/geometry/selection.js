'use strict';
/**
 * Вопрос модели по выделенной области (ТЗ, п. 34).
 *
 * Главное требование: в модель нельзя отправлять ОДИН скриншот. Картинка без
 * чисел — это гадание по пикселям, а нам нужен инженерный ответ. Поэтому
 * собирается мультимодальный контекст: изображение области, её координаты,
 * объекты и ограничения, которые в неё попадают, документы проекта, извлечённые
 * факты и сам вопрос. Модель видит картинку и одновременно знает, что на ней.
 *
 * Если провайдер не умеет зрение, картинка не отправляется — но текстовая часть
 * остаётся полной, и ответ всё равно опирается на геометрию, а не на догадки.
 */
const jts = require('./jts');
const G = require('./site-geometry');
const RR = require('./restriction-rules');
const ZoneStyle = require('../../../public/zone-style.js');

const LAYER_TITLES = {
  parcel: 'Границы участка',
  buildings: 'Здание',
  redLines: 'Красная линия',
  utilities: 'Инженерная сеть',
  existingObjects: 'Существующий объект',
  restrictions: 'Зона ограничения',
  buildable: 'Потенциально допустимая территория',
  forbidden: 'Запретная зона (объединение ограничений)',
};

/**
 * Все объекты плана с указанием слоя. Порядок = порядок отрисовки: допустимая
 * территория ложится под зоны, иначе её заливка перекрывает штриховки.
 */
function allWithLayer(site) {
  const out = [];
  // запретная зона — самая нижняя: сплошная подложка, поверх которой ложатся
  // штриховки отдельных зон. Сначала видно, куда нельзя, потом — из-за чего
  if (site.buildable && site.buildable.forbidden && site.buildable.forbidden.geometry) {
    out.push({
      layer: 'forbidden',
      obj: {
        id: 'forbidden',
        geometry: site.buildable.forbidden.geometry,
        properties: { areaM2: site.buildable.forbidden.areaM2 },
      },
    });
  }
  if (site.buildable && site.buildable.geometry) {
    out.push({ layer: 'buildable', obj: { id: 'buildable', geometry: site.buildable.geometry, properties: { areaM2: site.buildable.areaM2 } } });
  }
  if (site.parcel) out.push({ layer: 'parcel', obj: site.parcel });
  for (const key of ['buildings', 'redLines', 'utilities', 'existingObjects', 'restrictions']) {
    for (const obj of site[key] || []) out.push({ layer: key, obj });
  }
  return out;
}

/**
 * Объекты, пересекающие выделение. Пересечение считается по площади и длине,
 * а не по габаритам: рамка рядом с сетью не должна «захватывать» её.
 */
function objectsIn(site, rectPoints) {
  const sel = jts.toJts({ type: 'polygon', closed: true, points: rectPoints });
  const hits = [];
  for (const { layer, obj } of allWithLayer(site)) {
    let g;
    try { g = jts.toJts(obj.geometry); } catch { continue; }
    if (!g || !sel.intersects(g)) continue;
    let share = null;
    try {
      const inter = g.intersection(sel);
      const whole = obj.geometry.type === 'polyline' ? g.getLength() : g.getArea();
      const part = obj.geometry.type === 'polyline' ? inter.getLength() : inter.getArea();
      if (whole > 0) share = Math.round((part / whole) * 100);
    } catch { /* вырожденная геометрия — доля неизвестна */ }
    hits.push({ layer, obj, sharePercent: share });
  }
  return hits;
}

/** Текстовое описание попавших объектов — то, что читает модель. */
function describeHits(hits) {
  if (!hits.length) return 'В выделенную область не попал ни один распознанный объект плана.';
  const lines = [];
  for (const { layer, obj, sharePercent } of hits) {
    const p = obj.properties || {};
    const bits = [`${LAYER_TITLES[layer] || layer}`];
    if (p.kind) bits.push(`тип: ${p.kind}`);
    if (p.areaM2) bits.push(`площадь ${p.areaM2} м²`);
    if (p.lengthM) bits.push(`длина ${p.lengthM} м`);
    if (sharePercent !== null) bits.push(`в области ${sharePercent}% объекта`);
    if (obj.provenance) {
      if (obj.provenance.sourceLayer) bits.push(`слой «${obj.provenance.sourceLayer}»`);
      if (obj.provenance.basis) bits.push(`основание: ${obj.provenance.basis}`);
      bits.push(`уверенность ${Math.round((obj.provenance.confidence || 0) * 100)}%`);
    }
    if (p.statusLabel) bits.push(`статус: ${p.statusLabel}`);
    lines.push(`- ${bits.join(' · ')}`);
  }
  return lines.join('\n');
}

/* ---------------- отрисовка crop'а ---------------- */

const STYLE = {
  parcel: 'fill:none;stroke:#26211b;stroke-width:2',
  buildings: 'fill:#4a6b8a55;stroke:#4a6b8a;stroke-width:1.5',
  redLines: 'fill:none;stroke:#a93e2c;stroke-width:1.5;stroke-dasharray:8 5',
  utilities: 'fill:none;stroke:#b07e36;stroke-width:1.5',
  existingObjects: 'fill:#8578684d;stroke:#857b6e;stroke-width:1',
  buildable: `fill:${ZoneStyle.BUILDABLE.fill};stroke:${ZoneStyle.BUILDABLE.color};stroke-width:1`,
  forbidden: `fill:${ZoneStyle.FORBIDDEN.fill};stroke:${ZoneStyle.FORBIDDEN.color};stroke-width:1;stroke-dasharray:6 4`,
};

/**
 * Стиль объекта слоя.
 *
 * Зона ограничения рисуется штриховкой: угол — от ТИПА ограничения, цвет — от
 * ОБЪЕКТА, вокруг которого она построена. Наложенные зоны показывают обе
 * штриховки, а не прячут нижнюю под верхней, и по цвету видно, чья каждая.
 */
function styleOf(layer, obj, assignment) {
  if (layer === 'restrictions') {
    if (assignment && assignment.byZone && assignment.byZone[obj.id]) {
      return ZoneStyle.zoneStyleById(obj.id, assignment, 'cs-');
    }
    return ZoneStyle.zoneStyle((obj.properties && obj.properties.kind) || 'other', 'cs-');
  }
  return STYLE[layer] || '';
}

function ringPath(points, close) {
  const d = points.map(([x, y], i) => `${i ? 'L' : 'M'}${r(x)} ${r(y)}`).join(' ');
  return close ? `${d} Z` : d;
}

function geometryPath(g) {
  if (!g) return '';
  if (g.type === 'multipolygon') {
    return (g.polygons || []).map((p) => [ringPath(p.points, true), ...(p.holes || []).map((h) => ringPath(h, true))].join(' ')).join(' ');
  }
  if (g.type === 'polygon') {
    return [ringPath(g.points, true), ...(g.holes || []).map((h) => ringPath(h, true))].join(' ');
  }
  return ringPath(g.points, false);
}

const r = (n) => Math.round(n * 100) / 100;

/**
 * SVG выделенной области с запасом вокруг: без контекста по краям модель не
 * поймёт, что рамка стоит вплотную к границе участка.
 * Ось Y переворачивается так же, как в интерфейсе.
 */
function cropSvg(site, rectPoints, { width = 900, height = 640, marginRatio = 0.35, highlight = 'selection', frame = null } = {}) {
  // кадр может задаваться отдельно от выделенного: на генплане в кадр берут
  // участок целиком, а подсвечивают пятно застройки
  const b = G.bounds(frame && frame.length >= 3 ? frame : rectPoints);
  const w = Math.max(b.maxX - b.minX, 1);
  const h = Math.max(b.maxY - b.minY, 1);
  const margin = Math.max(w, h) * marginRatio;
  let vw = w + margin * 2;
  let vh = h + margin * 2;
  const aspect = width / height;
  if (vw / vh > aspect) vh = vw / aspect; else vw = vh * aspect;
  const cx = (b.minX + b.maxX) / 2;
  const cy = (b.minY + b.maxY) / 2;
  const minX = cx - vw / 2;
  const minY = cy - vh / 2;

  const zones = site.restrictions || [];
  const assignment = ZoneStyle.assignColors(zones);
  const parts = [];
  for (const { layer, obj } of allWithLayer(site)) {
    const d = geometryPath(obj.geometry);
    if (!d) continue;
    const open = obj.geometry.type === 'polyline';
    const style = open ? `${styleOf(layer, obj, assignment)};fill:none` : styleOf(layer, obj, assignment);
    parts.push(`<path d="${d}" style="${style}" vector-effect="non-scaling-stroke"/>`);
  }
  // поверх всего — то, о чём идёт речь: рамка вопроса или пятно застройки.
  // `highlight: 'none'` рисует чистую схему: на схеме ограничений в отчёте
  // подсвечивать нечего, а рамка по габаритам участка читалась бы как объект
  if (highlight !== 'none' && rectPoints && rectPoints.length >= 3) {
    const style = highlight === 'footprint'
      ? `fill:${ZoneStyle.FOOTPRINT.fill};stroke:${ZoneStyle.FOOTPRINT.color};stroke-width:2.5`
      : 'fill:#b9574022;stroke:#b95740;stroke-width:2.5;stroke-dasharray:7 4';
    parts.push(`<path d="${ringPath(rectPoints, true)}" style="${style}" vector-effect="non-scaling-stroke"/>`);
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" ` +
    `viewBox="${r(minX)} ${r(-(minY + vh))} ${r(vw)} ${r(vh)}">` +
    // Шаг штриховки задан в единицах чертежа, а рисуем мы участок целиком:
    // без пересчёта под размер картинки полосы на участке в 74 м выходят
    // толщиной в метр и закрывают собой подложку. Тот же пересчёт делает вьювер.
    ZoneStyle.defs('cs-', ZoneStyle.unitsPerPixel(vw, width), zones) +
    `<g transform="scale(1,-1)">${parts.join('')}</g></svg>`;
}

/** Координатная справка по выделению — числа, а не «где-то в левом верхнем углу». */
function describeArea(rectPoints, site) {
  const b = G.bounds(rectPoints);
  const area = G.polygonArea(rectPoints);
  const lines = [
    `Границы области: X ${r(b.minX)}…${r(b.maxX)}, Y ${r(b.minY)}…${r(b.maxY)} (метры, система координат чертежа)`,
    `Размер: ${r(b.maxX - b.minX)} × ${r(b.maxY - b.minY)} м, площадь ${Math.round(area)} м²`,
  ];
  if (site.parcel) {
    const parcelArea = site.parcel.properties.areaM2 || 0;
    if (parcelArea) lines.push(`Это ${Math.round((area / parcelArea) * 100)}% площади участка (${parcelArea} м²)`);
  }
  return lines.join('\n');
}

module.exports = { objectsIn, describeHits, cropSvg, describeArea, allWithLayer, LAYER_TITLES };
