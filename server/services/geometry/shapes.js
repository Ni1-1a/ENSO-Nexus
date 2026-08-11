'use strict';
/**
 * Формы пятна застройки (ТЗ, п. 43).
 *
 * Здание не обязано быть прямоугольником: участок клиновидный, сети идут по
 * диагонали, отступы съедают углы — и Г-образный или ступенчатый корпус
 * помещается там, где прямоугольник не помещается вовсе. Поэтому движок
 * посадки перебирает не только габариты и поворот, но и форму.
 *
 * Каждая форма описана в единичном габарите 1×1 как замкнутое кольцо против
 * часовой стрелки. Дальше кольцо масштабируется так, чтобы ПЛОЩАДЬ ФИГУРЫ
 * (а не площадь габарита) совпала с требуемой: у Г-образной формы габарит
 * заметно больше площади, и путать их нельзя — иначе здание окажется меньше ТЗ.
 *
 * Координат тут нет и быть не может: форма — это пропорция, конкретные вершины
 * появляются только после привязки к участку в placement-engine.
 */

/** Доля от габарита, занятая толщиной крыла у Г/Т/П-образных форм. */
const WING = 0.42;

/**
 * Описания форм. `ring(1×1)` возвращает кольцо в единичном габарите,
 * `fill` — доля площади габарита, которую фигура реально занимает.
 */
const SHAPES = [
  {
    id: 'rect',
    label: 'прямоугольник',
    note: 'простая планировка, дешёвый каркас',
    ring: () => [[0, 0], [1, 0], [1, 1], [0, 1]],
  },
  {
    id: 'lshape',
    label: 'Г-образная',
    note: 'обходит угол участка или охранную зону',
    ring: (t = WING) => [[0, 0], [1, 0], [1, t], [t, t], [t, 1], [0, 1]],
  },
  {
    id: 'tshape',
    label: 'Т-образная',
    note: 'широкий торец при узкой основной части',
    ring: (t = WING) => {
      const a = (1 - t) / 2;
      const h = t;
      return [[a, 0], [a + t, 0], [a + t, 1 - h], [1, 1 - h], [1, 1], [0, 1], [0, 1 - h], [a, 1 - h]];
    },
  },
  {
    id: 'ushape',
    label: 'П-образная',
    note: 'внутренний двор, две линии подъезда',
    ring: (t = WING * 0.8) => [[0, 0], [1, 0], [1, 1], [1 - t, 1], [1 - t, t], [t, t], [t, 1], [0, 1]],
  },
  {
    id: 'step',
    label: 'ступенчатая',
    note: 'уступами вдоль косой границы или зоны',
    ring: () => [[0, 0], [1, 0], [1, 0.34], [0.7, 0.34], [0.7, 0.67], [0.4, 0.67], [0.4, 1], [0, 1]],
  },
  {
    id: 'trapezoid',
    label: 'трапеция',
    note: 'повторяет сходящиеся границы участка',
    ring: (k = 0.2) => [[0, 0], [1, 0], [1 - k, 1], [k, 1]],
  },
  {
    id: 'triangle',
    label: 'треугольная',
    note: 'острый клин участка используется целиком',
    ring: () => [[0, 0], [1, 0], [0.5, 1]],
  },
];

const BY_ID = new Map(SHAPES.map((s) => [s.id, s]));

/** Площадь кольца по формуле Гаусса. Знак отброшен: направление обхода не важно. */
function ringArea(points) {
  let s = 0;
  for (let i = 0; i < points.length; i++) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[(i + 1) % points.length];
    s += x1 * y2 - x2 * y1;
  }
  return Math.abs(s) / 2;
}

/** Доля габарита, занятая фигурой: считается из самого кольца, а не вписывается руками. */
function fillRatio(shapeId) {
  const shape = BY_ID.get(shapeId) || BY_ID.get('rect');
  return ringArea(shape.ring());
}

const round = (n) => Math.round(n * 100) / 100;
const rad = (deg) => (deg * Math.PI) / 180;

/**
 * Габарит фигуры заданной формы, площади и вытянутости.
 * @param {string} shapeId  форма из SHAPES
 * @param {number} areaM2   требуемая площадь ЗАСТРОЙКИ (не габарита)
 * @param {number} ratio    вытянутость габарита: длина / ширина
 * @returns {{width:number,length:number}} габарит в метрах
 */
function boxFor(shapeId, areaM2, ratio) {
  const fill = fillRatio(shapeId);
  if (!(areaM2 > 0) || !(ratio > 0) || !(fill > 0)) return null;
  const width = Math.sqrt(areaM2 / (fill * ratio));
  return { width: round(width), length: round(width * ratio) };
}

/**
 * Пятно заданной формы: центр, габарит, поворот.
 * Поворот против часовой стрелки, как и у прямоугольника в placement-engine.
 *
 * `origin` — начало локальной системы, к которому прибавляется готовое пятно.
 * Округление до сантиметра идёт по ЛОКАЛЬНОЙ координате, а не по абсолютной:
 * иначе тот же участок в МСК-47 (значения порядка 2 200 000) и в локальных
 * координатах давал слегка разные вершины, а за ними — разный отбор форм
 * в четырёх вариантах посадки. Начало координат чертежа не должно влиять
 * на то, какое здание предложено.
 */
function footprint(shapeId, cx, cy, width, length, angleDeg, origin = null) {
  const shape = BY_ID.get(shapeId) || BY_ID.get('rect');
  const a = rad(angleDeg);
  const ca = Math.cos(a);
  const sa = Math.sin(a);
  const ox = origin ? origin[0] : 0;
  const oy = origin ? origin[1] : 0;
  return shape.ring().map(([u, v]) => {
    const x = (u - 0.5) * width;
    const y = (v - 0.5) * length;
    return [round(cx + x * ca - y * sa) + ox, round(cy + x * sa + y * ca) + oy];
  });
}

/** Русское название формы для карточки варианта и отчёта. */
function label(shapeId) {
  const s = BY_ID.get(shapeId);
  return s ? s.label : shapeId;
}

function note(shapeId) {
  const s = BY_ID.get(shapeId);
  return s ? s.note : '';
}

module.exports = {
  SHAPES, WING, ringArea, fillRatio, boxFor, footprint, label, note,
  ids: () => SHAPES.map((s) => s.id),
};
