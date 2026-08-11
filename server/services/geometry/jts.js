'use strict';
/**
 * Тонкая обёртка над JSTS — планарным движком геометрии.
 *
 * Почему JSTS, а не turf: turf считает буферы и площади по сфере, трактуя
 * координаты как градусы WGS84. Наши планы — МСК, метры, значения порядка
 * 2 200 000. На таком входе turf.buffer строит зону не того размера, а
 * turf.area возвращает бессмыслицу. JSTS планарный и работает в тех единицах,
 * что ему дали, — ровно то, что нужно инженерной геометрии.
 *
 * Почему версия 2.7.1, а не свежая: начиная с 2.9 пакет собирается только как
 * ESM без CommonJS-точки входа, а перевод проекта на ESM запрещён ТЗ (часть XIX).
 * 2.7.1 — последняя версия с рабочим require().
 *
 * Наружу отдаются обычные массивы координат, объекты JSTS за пределы модуля
 * не выходят: остальному коду незачем знать, чем именно считается пересечение.
 */
const jsts = require('jsts');

const reader = new jsts.io.GeoJSONReader();
const writer = new jsts.io.GeoJSONWriter();

/** Замыкает кольцо: GeoJSON требует, чтобы последняя точка совпадала с первой. */
function closeRing(points) {
  if (points.length < 3) return points;
  const [fx, fy] = points[0];
  const [lx, ly] = points[points.length - 1];
  return (fx === lx && fy === ly) ? points : [...points, [fx, fy]];
}

/**
 * Кольцо, пригодное для JSTS: минимум четыре точки с совпадающими концами.
 *
 * Вырожденные кольца («ниточки» из двух точек, петли a→b→a) появляются после
 * булевых операций над реальными чертежами постоянно. Раньше такое кольцо
 * роняло весь расчёт исключением из недр JSTS — теперь оно просто
 * отбрасывается: одна выродившаяся щепка не стоит потерянного генплана.
 */
function validRing(points) {
  const clean = finitePoints(points);
  if (clean.length < 3) return null;
  const ring = closeRing(clean);
  return ring.length >= 4 ? ring : null;
}

/**
 * Точки, пригодные для геометрии: пары конечных чисел.
 *
 * NaN и undefined в координатах прилетают из битых чертежей и из чужих вызовов.
 * Раньше они доезжали до JSTS и превращались в площадь NaN и вершину (0,0)
 * посреди МСК-координат — то есть в правдоподобный, но неверный результат.
 */
function finitePoints(points) {
  if (!Array.isArray(points)) return [];
  return points.filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]))
    .map(([x, y]) => [x, y]);
}

/**
 * Наше представление → геометрия JSTS.
 *
 * Вырожденное не роняет расчёт, а отбрасывается (возвращается null) — то же
 * правило, что и у полигональных веток: одна выродившаяся щепка не стоит
 * потерянного генплана. Раньше линия из одной точки и геометрия без points
 * бросали исключение из недр JSTS.
 */
function toJts(geometry) {
  if (!geometry) return null;
  if (geometry.type === 'polygon' || (geometry.closed && geometry.points)) {
    const outer = validRing(geometry.points);
    if (!outer) return null;
    const rings = [outer, ...(geometry.holes || []).map(validRing).filter(Boolean)];
    return repair(reader.read({ type: 'Polygon', coordinates: rings }));
  }
  if (geometry.type === 'multipolygon') {
    const polys = (geometry.polygons || [])
      .map((p) => {
        const outer = validRing(p.points);
        if (!outer) return null;
        return [outer, ...(p.holes || []).map(validRing).filter(Boolean)];
      })
      .filter(Boolean);
    if (!polys.length) return null;
    return repair(reader.read({ type: 'MultiPolygon', coordinates: polys }));
  }
  const line = finitePoints(geometry.points);
  if (line.length < 2) return null;
  return reader.read({ type: 'LineString', coordinates: line });
}

/**
 * Проверка замкнутого контура: простой он или самопересекающийся, и какова
 * его площадь после починки. Отдаётся наружу для site-geometry — там площадь
 * объекта обязана совпадать с той, по которой считает движок.
 * @returns {{area:number, valid:boolean}|null}
 */
function ringInfo(points) {
  const ring = validRing(points);
  if (!ring) return null;
  let geom;
  try {
    geom = reader.read({ type: 'Polygon', coordinates: [ring] });
  } catch {
    return null;
  }
  let valid = false;
  try { valid = geom.isValid(); } catch { valid = false; }
  if (valid) return { area: geom.getArea(), valid: true };
  const fixed = repair(geom);
  return { area: fixed && !fixed.isEmpty() ? fixed.getArea() : 0, valid: false };
}

/**
 * Самопересекающиеся контуры в чертежах — обычное дело. buffer(0) приводит
 * такую геометрию к корректной, вместо того чтобы ронять весь расчёт.
 */
function repair(geom) {
  try {
    return geom.isValid() ? geom : geom.buffer(0);
  } catch {
    return geom;
  }
}

/** Геометрия JSTS → наше представление (координаты числами, без SVG). */
function fromJts(geom) {
  if (!geom || geom.isEmpty()) return null;
  const gj = writer.write(geom);
  const round = (ring) => ring.map(([x, y]) => [r6(x), r6(y)]);
  if (gj.type === 'Polygon') {
    const [outer, ...holes] = gj.coordinates;
    return { type: 'polygon', closed: true, points: dropClosing(round(outer)), holes: holes.map((h) => dropClosing(round(h))) };
  }
  if (gj.type === 'MultiPolygon') {
    return {
      type: 'multipolygon',
      polygons: gj.coordinates.map(([outer, ...holes]) => ({
        points: dropClosing(round(outer)),
        holes: holes.map((h) => dropClosing(round(h))),
      })),
    };
  }
  if (gj.type === 'LineString') return { type: 'polyline', closed: false, points: round(gj.coordinates) };
  return null;
}

function dropClosing(ring) {
  if (ring.length > 3) {
    const [fx, fy] = ring[0];
    const [lx, ly] = ring[ring.length - 1];
    if (fx === lx && fy === ly) return ring.slice(0, -1);
  }
  return ring;
}

// миллиметровая точность: дальше идут погрешности представления, а не геометрия
const r6 = (n) => Math.round(n * 1000) / 1000;

/* ---------------- операции ---------------- */

/** Полоса наружу: охранные зоны, разрывы. Для линии даёт полосу по обе стороны. */
function bufferOutward(geometry, distanceM) {
  const g = toJts(geometry);
  return g ? repair(g.buffer(distanceM)) : null;
}

/**
 * Отступ внутрь от границы: кольцо между контуром и уменьшенным контуром.
 * Если отступ съедает участок целиком, кольцом становится весь участок —
 * это корректный результат, означающий «строить негде».
 */
function insetRing(geometry, distanceM) {
  const g = toJts(geometry);
  if (!g) return null;
  const inner = repair(g.buffer(-distanceM));
  return inner.isEmpty() ? g : repair(g.difference(inner));
}

function union(geoms) {
  const list = geoms.filter(Boolean);
  if (!list.length) return null;
  return list.reduce((acc, g) => (acc ? repair(acc.union(g)) : g), null);
}

function intersection(a, b) {
  if (!a || !b) return null;
  const res = repair(a.intersection(b));
  return res.isEmpty() ? null : res;
}

function difference(a, b) {
  if (!a) return null;
  if (!b) return a;
  const res = repair(a.difference(b));
  return res.isEmpty() ? null : res;
}

function area(geom) {
  return geom ? geom.getArea() : 0;
}

/** Пересекаются ли геометрии по площади (касание границами не считается). */
function overlaps(a, b) {
  if (!a || !b) return false;
  const i = a.intersection(b);
  return !i.isEmpty() && i.getArea() > 1e-9;
}

/** Полностью ли a внутри b. */
function within(a, b) {
  return !!(a && b) && a.within(b);
}

module.exports = {
  toJts, fromJts, repair, ringInfo,
  bufferOutward, insetRing, union, intersection, difference,
  area, overlaps, within,
};
