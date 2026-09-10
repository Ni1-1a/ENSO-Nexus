'use strict';
/**
 * Чистая геометрия сцены офиса: ни three.js, ни DOM. Здесь живёт то, что
 * ошибалось знаком или координатой и должно проверяться тестом, а не глазом:
 * ориентация поручня по маршу (Б3) и развеска на стене без пересечений (В10).
 *
 * Модуль намеренно без зависимостей: `tests/office.test.js` подключает его
 * динамическим import(), и любой импорт three.js сделал бы это невозможным.
 */

/**
 * Поворот поручня по маршу.
 *
 * Марш поднимается в сторону УБЫВАНИЯ координаты: ступень ставится в
 * `z1 − run·i` (или `x1 − run·i`) при растущем y. Поэтому знак уклона у трубы
 * обратный знаку из `atan2`, и он разный у двух осей: для оси z поворот идёт
 * вокруг X, для оси x — вокруг Z, а эти два поворота смотрят в разные стороны.
 * Прежний код брал один и тот же знак для обеих осей, и труба летела поперёк
 * кадра мимо марша.
 *
 * @param {object} p
 * @param {'x'|'z'} p.axis   ось марша
 * @param {number} p.yFrom   отметка низа
 * @param {number} p.yTo     отметка верха
 * @param {number} p.len     длина марша в плане (со знаком: z1 − z0 или x1 − x0)
 * @returns {{ key: 'x'|'z', angle: number, slope: number, length: number, midY: number }}
 */
export function railPose({ axis, yFrom, yTo, len }) {
  const slope = Math.atan2(yTo - yFrom, len);
  return {
    key: axis === 'z' ? 'x' : 'z',
    angle: axis === 'z' ? Math.PI / 2 + slope : Math.PI / 2 - slope,
    slope,
    length: Math.hypot(len, yTo - yFrom) + 0.6,   // заход 300 мм за крайние ступени
    midY: (yFrom + yTo) / 2 + 0.9,                // 900 мм над линией носков
  };
}

/**
 * Направление оси поручня в мире. Цилиндр three.js стоит вдоль +Y: поворот
 * вокруг X переводит (0,1,0) в (0, cos θ, sin θ), поворот вокруг Z — в
 * (−sin θ, cos θ, 0). Этой функцией тест сверяет, что труба лежит ПО марш­у.
 */
export function railDirection({ axis, angle }) {
  if (axis === 'z') return { x: 0, y: Math.cos(angle), z: Math.sin(angle) };
  return { x: -Math.sin(angle), y: Math.cos(angle), z: 0 };
}

/**
 * Направление самого марша: ступень ставится в `x1/z1 − run·i` при растущем y,
 * то есть подъём идёт в сторону УБЫВАНИЯ координаты.
 */
export function flightDirection({ axis, yFrom, yTo, len }) {
  const dy = yTo - yFrom;
  return axis === 'z' ? { x: 0, y: dy, z: -len } : { x: -len, y: dy, z: 0 };
}

/**
 * Развеска на стене. Раньше каждая серия постеров считала свои координаты
 * своей формулой и ничего не знала про соседей: постер садился на косяк
 * проёма, налезал на другой постер и висел над пустотой проёма в крыло.
 *
 * Место занято, если по той же стене (тот же x или z) прямоугольники
 * пересекаются с зазором `gap`, или если оно попадает в проём.
 *
 * @param {Array<{along:number,width:number}>} placed  уже занятые места
 * @param {Array<[number,number]>} openings            проёмы по той же оси
 * @param {number} along  координата центра вдоль стены
 * @param {number} width  ширина предмета
 * @param {number} gap    минимальный просвет между соседями
 */
export function slotFree(placed, openings, along, width, gap = 0.5) {
  for (const [a, b] of openings) {
    if (along + width / 2 > a && along - width / 2 < b) return false;
  }
  return !placed.some((o) => Math.abs(o.along - along) < (o.width + width) / 2 + gap);
}

/** Прямоугольник предмета вдоль стены — для проверок пересечения в тестах. */
export function slotRect(along, width) {
  return [along - width / 2, along + width / 2];
}

/* ================= лестница: один источник для геометрии и ходьбы ================= */

/**
 * Отметка марша в точке. Правило 11: геометрия ступеней и поверхность ходьбы
 * обязаны считаться ОДНОЙ формулой. Пока их было две, они разошлись знаком —
 * в зале реактора человек шёл вниз, а ступени под ним поднимались.
 *
 * Марш идёт от края `a1` (там отметка `yFrom`) к краю `a0` (там `yTo`): ступень
 * ставится в `a1 − run·i` при отметке `yFrom + rise·i`.
 */
export function stairSurface(spec, x, z) {
  const a = spec.axis === 'z' ? z : x;
  const a1 = spec.axis === 'z' ? spec.z1 : spec.x1;
  const a0 = spec.axis === 'z' ? spec.z0 : spec.x0;
  const t = Math.max(0, Math.min(1, (a1 - a) / (a1 - a0)));
  return spec.yFrom + t * (spec.yTo - spec.yFrom);
}

/** Положение i-й ступени того же марша — им строится геометрия. */
export function stairStep(spec, i) {
  const len = spec.axis === 'z' ? spec.z1 - spec.z0 : spec.x1 - spec.x0;
  const run = len / spec.steps;
  const rise = (spec.yTo - spec.yFrom) / spec.steps;
  const along = (spec.axis === 'z' ? spec.z1 : spec.x1) - run * (i + 0.5);
  const y = spec.yFrom + rise * (i + 0.5);
  return spec.axis === 'z'
    ? { x: (spec.x0 + spec.x1) / 2, y, z: along, run, rise }
    : { x: along, y, z: (spec.z0 + spec.z1) / 2, run, rise };
}

/** Точка внутри прямоугольника марша. */
export function inStair(spec, x, z) {
  const [ax, bx] = spec.x0 < spec.x1 ? [spec.x0, spec.x1] : [spec.x1, spec.x0];
  const [az, bz] = spec.z0 < spec.z1 ? [spec.z0, spec.z1] : [spec.z1, spec.z0];
  return x > ax && x < bx && z > az && z < bz;
}
