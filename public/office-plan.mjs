'use strict';
/**
 * ПЛАН ЗДАНИЯ «Кольцо с атриумом» (ТЗ №2, Р2 — решение владельца 10.09.2026).
 *
 * Наружный Ø 48 м, атриум Ø 21 м, глубина корпуса 13,5 м, два этажа по 4,2 м.
 * Два павильона — зал реактора (запад) и мастерская (юго-запад), два
 * лестничных ядра в противоположных четвертях. Вход с юга, лестниц во
 * входной зоне нет.
 *
 * Здесь только числа и чистая геометрия: ни three.js, ни DOM. Отсюда берут
 * координаты и сборка сцены, и план проходимости, и автотесты — чтобы не
 * повторилась история реакторной лестницы, где геометрия и пол считались
 * двумя формулами и разошлись знаком (правило 11).
 *
 * УГОЛ φ отсчитывается от направления НА ЮГ (+z, там вход) по часовой стрелке
 * при взгляде сверху, то есть в сторону +x (восток):
 *   точка на радиусе r: x = r·sin φ, z = r·cos φ.
 */

export const RING = {
  rOut: 24,          // наружный радиус, м
  rIn: 10.5,         // радиус атриума
  wallT: 0.3,        // толщина наружной стены
  floor1: 0,         // отметка первого этажа
  floor2: 4.2,       // отметка второго
  height: 4.2,       // высота этажа
  pit: -3.0,         // дно ямы зала реактора
  parapet: 1.05,     // высота парапета по контуру атриума
};

const D = Math.PI / 180;

/** Сектор кольца: доля площади задана планом, углы посчитаны из неё. */
function sectors(list) {
  const total = list.reduce((s, r) => s + r.area, 0);
  const k = (Math.PI * 2) / total;
  let from = -list[0].area * k / 2;                 // первый сектор симметричен югу
  return list.map((r) => {
    const to = from + r.area * k;
    const out = { ...r, from, to, mid: (from + to) / 2 };
    from = to;
    return out;
  });
}

/** Первый этаж, отметка 0.00. Обход по часовой стрелке от входа. */
export const FLOOR1 = sectors([
  { id: 'lobby', name: 'Вестибюль', area: 168, sub: 'приём · макет · гардероб' },
  { id: 'aquarium', name: 'Аквариум-галерея', area: 189, sub: 'стена 12 × 4 м' },
  { id: 'meeting', name: 'Переговорные', area: 189, sub: '12 мест и две малые' },
  { id: 'studio', name: 'Проектная', area: 588, sub: '24 места двумя дугами' },
  { id: 'toReactor', name: 'Переход', area: 189, sub: 'в зал реактора' },
  { id: 'tea', name: 'Чайная и переход', area: 189, sub: 'в мастерскую' },
]);

/** Второй этаж, отметка +4.20. Те же 360°, другое наполнение. */
export const FLOOR2 = sectors([
  { id: 'gallery', name: 'Галерея над входом', area: 168, sub: 'вид на вестибюль' },
  { id: 'library', name: 'Библиотека нормативов', area: 378, sub: 'стеллажи по наружной стене' },
  { id: 'cabins', name: 'Кабины и малые переговорные', area: 294, sub: '6 кабин и 3 комнаты' },
  { id: 'lounge', name: 'Лаундж-кольцо', area: 294, sub: 'бар, отдых, вид в атриум' },
  { id: 'reactorBalcony', name: 'Балкон реактора', area: 189, sub: 'вход в павильон сверху' },
  { id: 'workshopBalcony', name: 'Антресоль мастерской', area: 189, sub: 'вид на подъёмник' },
]);

/**
 * Павильоны стоят СНАРУЖИ кольца и соединены с ним переходом. Так они
 * перестают быть коробками, приклеенными к прямоугольнику.
 */
export const PAVILIONS = {
  reactor: {
    name: 'Зал реактора', x0: -45.5, x1: -27.5, z0: -8, z1: 8,
    floor: RING.pit, ceiling: RING.floor2 + RING.height, // двойной свет
    link: { from: 265 * D, x0: -27.5, x1: -22.5, z0: -2.4, z1: 2.4 },
    // вход по мостику на отметке 0.00, дальше лестница ВДОЛЬ стены вниз к яме
    balcony: { x0: -32.6, x1: -27.5, z0: -6.4, z1: 6.4, y: RING.floor1 },
    stair: { axis: 'x', x0: -41.0, x1: -32.6, z0: -5.2, z1: -2.0, yFrom: RING.floor1, yTo: RING.pit, steps: 20, railSide: 1 },
  },
  workshop: {
    name: 'Мастерская', x0: -35, x1: -15, z0: 20, z1: 34,
    floor: 0, ceiling: RING.floor2 + RING.height,
    link: { from: 315 * D, x0: -22.0, x1: -15.4, z0: 16.6, z1: 21.4 },
  },
};

/**
 * Лестничные ядра — в противоположных четвертях, СНАРУЖИ кольца, чтобы марш
 * не занимал ни вестибюль, ни рабочие сектора. Марш идёт по оси ядра.
 */
export const CORES = {
  se: {
    name: 'Ядро 1 · лестница', at: 45 * D,
    x0: 17.4, x1: 22.2, z0: 15.6, z1: 24.4,
    stair: { axis: 'z', x0: 18.2, x1: 21.4, z0: 16.2, z1: 23.8, yFrom: RING.floor1, yTo: RING.floor2, steps: 24, railSide: 1 },
  },
  nw: {
    name: 'Ядро 2 · лестница и лифт', at: 225 * D,
    x0: -22.2, x1: -17.4, z0: -24.4, z1: -15.6,
    stair: { axis: 'z', x0: -21.4, x1: -18.2, z0: -23.8, z1: -16.2, yFrom: RING.floor2, yTo: RING.floor1, steps: 24, railSide: -1 },
  },
};

/** Атриум: сад и амфитеатр из пяти рядов лицом к главному экрану. */
export const ATRIUM = {
  r: RING.rIn,
  screen: { at: Math.PI, width: 12.6, height: 3.6, y: 2.4 },   // на северной кромке
  rows: 5,
  rowRise: 0.34,
  rowDepth: 1.35,
  rowR0: 3.6,          // ближайший ряд — в 3,6 м от экрана
};

/* ================= чистая геометрия ================= */

export function angleAt(x, z) {
  const a = Math.atan2(x, z);
  return a < 0 ? a + Math.PI * 2 : a;
}

export function radiusAt(x, z) { return Math.hypot(x, z); }

/** Угол попадает в сектор с учётом перехода через 0. */
export function inArc(from, to, a) {
  const norm = (v) => { let r = v % (Math.PI * 2); if (r < 0) r += Math.PI * 2; return r; };
  const f = norm(from), t = norm(to), v = norm(a);
  return f <= t ? (v >= f && v < t) : (v >= f || v < t);
}

export function sectorAt(floor, x, z) {
  const r = radiusAt(x, z);
  if (r < RING.rIn || r > RING.rOut) return null;
  const a = angleAt(x, z);
  return (floor === 2 ? FLOOR2 : FLOOR1).find((s) => inArc(s.from, s.to, a)) || null;
}

function inRect(x, z, r) { return x > r.x0 && x < r.x1 && z > r.z0 && z < r.z1; }

/**
 * Ступень амфитеатра в атриуме: ряды — дуги вокруг экрана, подъём НАЗАД от
 * него. Возвращает отметку пола сада в точке.
 */
export function atriumFloor(x, z) {
  const sx = 0, sz = -RING.rIn;                       // экран на северной кромке
  const d = Math.hypot(x - sx, z - sz);
  if (d < ATRIUM.rowR0) return 0;
  const i = Math.floor((d - ATRIUM.rowR0) / ATRIUM.rowDepth);
  return Math.min(ATRIUM.rows - 1, i) * ATRIUM.rowRise;
}

/** Точка внутри проходимой части здания на заданной отметке. */
export function insideWalkable(x, z, floorY = 0) {
  const r = radiusAt(x, z);
  const second = floorY > RING.floor2 - 1.2;
  if (r > RING.rIn + 0.15 && r < RING.rOut - RING.wallT) return true;   // кольцо на любом этаже
  if (!second && r <= RING.rIn + 0.15) return true;                     // атриум только внизу
  for (const c of Object.values(CORES)) if (inRect(x, z, c)) return true;
  for (const p of Object.values(PAVILIONS)) {
    if (inRect(x, z, p)) return true;
    if (inRect(x, z, p.link)) return true;
  }
  return false;
}

/**
 * Отметка пола. ЧЕТЫРЕ плоскости вместо ступенчатого ландшафта: кольцо 0.00,
 * кольцо +4.20, павильоны 0.00 (зал реактора −3.00) и сад атриума с пятью
 * ступенями амфитеатра. Лестницы считаются тем же `stairSurface`, что и
 * рисует ступени.
 */
export function floorHeight(x, z, prevY = 0, stairSurface = null) {
  const cands = [];
  const r = radiusAt(x, z);
  if (r <= RING.rIn + 0.15) cands.push(atriumFloor(x, z));
  if (r > RING.rIn && r < RING.rOut) { cands.push(RING.floor1); cands.push(RING.floor2); }
  for (const p of Object.values(PAVILIONS)) {
    if (inRect(x, z, p)) cands.push(p.floor);
    if (inRect(x, z, p.link)) cands.push(RING.floor1);
    if (p.balcony && inRect(x, z, p.balcony)) cands.push(p.balcony.y);
    if (p.stair && stairSurface && inRect(x, z, p.stair)) cands.push(stairSurface(p.stair, x, z));
  }
  for (const c of Object.values(CORES)) {
    if (!inRect(x, z, c)) continue;
    if (stairSurface && inRect(x, z, c.stair)) cands.push(stairSurface(c.stair, x, z));
    else { cands.push(RING.floor1); cands.push(RING.floor2); }
  }
  if (!cands.length) return prevY;
  const reach = cands.filter((c) => Math.abs(c - prevY) < 0.45);
  if (reach.length) return Math.max(...reach);
  return cands.reduce((best, c) => (Math.abs(c - prevY) < Math.abs(best - prevY) ? c : best), cands[0]);
}

/** Точка на радиусе r под углом φ — короткая запись, которой полна сборка. */
export function pt(r, a) { return { x: r * Math.sin(a), z: r * Math.cos(a) }; }

/** Площадь сектора кольца — для проверки, что план собран по плану. */
export function sectorArea(s) {
  return ((s.to - s.from) / 2) * (RING.rOut * RING.rOut - RING.rIn * RING.rIn);
}
