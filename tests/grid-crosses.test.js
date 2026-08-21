'use strict';
/**
 * Привязка чертежа по крестам координатной сетки.
 *
 * Смысл всех тестов один: положение участка обязано быть ИЗМЕРЕНО по подписям
 * сетки, а не угадано по тому, попадает ли контур в габариты чертежа. Догадка
 * врёт молча — при неверной раскладке осей площадь остаётся правильной, и
 * сверка с ГПЗУ ошибку не ловит.
 */
process.env.DATA_DIR = require('path').join(require('os').tmpdir(), `pilot1-grid-${process.pid}`);
const { test } = require('node:test');
const assert = require('node:assert');

const GC = require('../server/services/geometry/grid-crosses');
const PS = require('../server/services/geometry/parcel-source');

/** Подписи сетки Горбунков: значение стоит у своей линии, все на слое «0». */
const GORBUNKI_TEXTS = [
  { value: '2195850', layer: '0', at: [2195849.5, 422400.5] },
  { value: '2196000', layer: '0', at: [2195999.5, 422250.5] },
  { value: '422250', layer: '0', at: [2196000.5, 422250.5] },
  { value: '422400', layer: '0', at: [2195850.5, 422400.5] },
  // шум, который обязан отсеяться: отметки высот, марки труб, номера колодцев
  { value: '24.02', layer: '61_Отметки высоты поверхности', at: [2195900, 422300] },
  { value: '2ст.108', layer: '32_Теплосеть', at: [2195910, 422310] },
  { value: '№397', layer: '45_Номера колодцев', at: [2195920, 422320] },
];

const BOUNDS = { minX: 2195874, minY: 422259, maxX: 2196005, maxY: 422387 };

test('сетка: подписи опознаются по совпадению значения с местом, а не по слою', () => {
  const g = GC.read(GORBUNKI_TEXTS, BOUNDS);
  assert.strictEqual(g.ok, true, 'сетка прочитана');
  assert.strictEqual(g.crosses.length, 4, 'ровно четыре подписи — отметки высот и марки труб не в счёт');
  // все четыре лежат на слое «0», а не на «02_Сетка»: выбирать по имени слоя нельзя
  assert.ok(g.crosses.every((c) => c.layer === '0'));
  assert.deepStrictEqual(g.axisX, { min: 2195850, max: 2196000 }, 'горизонталь чертежа несёт восточные координаты');
  assert.deepStrictEqual(g.axisY, { min: 422250, max: 422400 }, 'вертикаль чертежа несёт северные');
});

test('сетка: отступ подписи от линии — не сдвиг чертежа', () => {
  const g = GC.read(GORBUNKI_TEXTS, BOUNDS);
  assert.strictEqual(g.offsetX, 0, 'полметра — это место подписи рядом с крестом');
  assert.strictEqual(g.offsetY, 0);
  assert.ok(Math.abs(g.standoffX - 0.5) < 0.01, 'сам отступ при этом измерен и назван');
  assert.ok(g.note.includes('оформление'), 'и объяснён человеку словами');
});

test('сетка: настоящий сдвиг чертежа определяется и применяется', () => {
  // чертёж вычерчен на 1000 м восточнее и 500 м севернее своей системы координат
  const shifted = GORBUNKI_TEXTS.slice(0, 4).map((t) => ({
    ...t, at: [t.at[0] - 1000, t.at[1] - 500],
  }));
  const g = GC.read(shifted, null);
  assert.ok(Math.abs(g.offsetX - 1000) < 1, `сдвиг по горизонтали найден (${g.offsetX})`);
  assert.ok(Math.abs(g.offsetY - 500) < 1, `сдвиг по вертикали найден (${g.offsetY})`);
  assert.ok(g.note.includes('сдвинут'));
});

test('сетка: разнобой в подписях сдвигом не считается', () => {
  const messy = [
    { value: '2195850', layer: '0', at: [2195830, 422400] },   // −20
    { value: '2196000', layer: '0', at: [2195960, 422250] },   // −40
    { value: '422250', layer: '0', at: [2196000, 422210] },    // −40
    { value: '422400', layer: '0', at: [2195850, 422380] },    // −20
  ];
  const g = GC.read(messy, null);
  assert.strictEqual(g.offsetX, 0, 'подписи расходятся между собой — двигать участок по ним нельзя');
  assert.ok(g.note.includes('расходятся'));
});

test('сетка: без подписей честно говорится, что привязать не по чему', () => {
  const g = GC.read([{ value: '24.02', layer: '61', at: [1, 2] }], BOUNDS);
  assert.strictEqual(g.ok, false);
  assert.ok(g.note.length > 0, 'причина названа, а не оставлена пустой');
});

/* ---------------- главное: кресты перебивают догадку ---------------- */

/** Шесть характерных точек ГПЗУ Горбунков, как напечатаны: первая колонка — X (север). */
const GPZU = [
  { label: '1', first: 422352.83, second: 2195897.76 },
  { label: '2', first: 422308.62, second: 2195954.01 },
  { label: '3', first: 422286.62, second: 2195973.10 },
  { label: '4', first: 422288.36, second: 2195974.18 },
  { label: '5', first: 422322.63, second: 2195984.16 },
  { label: '6', first: 422369.92, second: 2195930.42 },
];
const META = { declaredAreaM2: 0, areaToleranceM2: 0, firstColumnMeans: 'X' };

test('границы: раскладка осей берётся у крестов, а не у габаритов чертежа', () => {
  const site = { drawingBounds: BOUNDS, gridRef: GC.read(GORBUNKI_TEXTS, BOUNDS) };
  const built = PS.build({ points: GPZU, meta: META }, site);
  assert.ok(built.ok, 'контур собран');
  assert.ok(built.report.axisBasis.includes('кресты'), `основание — кресты, а не габариты: ${built.report.axisBasis}`);
  // первая точка обязана лечь восточной координатой по горизонтали чертежа
  assert.ok(Math.abs(built.points[0][0] - 2195897.76) < 0.01, 'по горизонтали — 2 195 xxx');
  assert.ok(Math.abs(built.points[0][1] - 422352.83) < 0.01, 'по вертикали — 422 xxx');
});

test('границы: кресты решают там, где габариты чертежа отвечают неверно', () => {
  /*
   * Ровно та беда, ради которой всё и делалось: чертёж — узкая полоса съёмки,
   * и правильная раскладка выносит часть точек участка ЗА его габариты, а
   * неправильная случайно укладывается внутрь. Прежний способ («какая
   * раскладка попадает в габариты») выбрал бы неверную, и заметить это было бы
   * нечем: площадь при перестановке осей не меняется.
   */
  const narrow = { minX: 422200, minY: 422200, maxX: 2196100, maxY: 2196100 };
  const withGrid = { drawingBounds: narrow, gridRef: GC.read(GORBUNKI_TEXTS, BOUNDS) };
  const noGrid = { drawingBounds: narrow, gridRef: null };

  const a = PS.build({ points: GPZU, meta: META }, withGrid);
  const b = PS.build({ points: GPZU, meta: META }, noGrid);

  assert.ok(Math.abs(a.points[0][0] - 2195897.76) < 0.01,
    'с крестами — восточная координата по горизонтали чертежа');
  assert.ok(a.report.axisBasis.includes('кресты'));

  assert.ok(!b.report.axisBasis.includes('кресты'), 'без крестов основание другое');
  assert.ok(b.warnings.some((w) => w.includes('сетк')),
    'и об этом сказано вслух: раскладка выбрана запасным способом');
  assert.strictEqual(a.areaM2, b.areaM2,
    'площадь у обеих раскладок одинакова — именно поэтому по ней ошибку и не поймать');
});

test('границы: сдвиг чертежа переносится на контур участка', () => {
  const shiftedTexts = GORBUNKI_TEXTS.slice(0, 4).map((t) => ({ ...t, at: [t.at[0] - 1000, t.at[1] - 500] }));
  const site = { drawingBounds: null, gridRef: GC.read(shiftedTexts, null) };
  const built = PS.build({ points: GPZU, meta: META }, site);
  assert.ok(built.ok);
  assert.ok(Math.abs(built.points[0][0] - (2195897.76 - 1000)) < 1, 'контур сдвинут вместе с чертежом');
  assert.ok(built.warnings.some((w) => w.includes('сдвиг')), 'и сдвиг назван числом');
});
