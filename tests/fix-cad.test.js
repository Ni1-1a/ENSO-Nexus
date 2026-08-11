'use strict';
/**
 * Чертёж генплана: кодировка файла, отверстия штриховок, параметры образцов
 * и отказ вместо тихой подмены координаты.
 *
 * Все проверки идут по СОДЕРЖИМОМУ выгруженного DXF, а не по спецификации:
 * именно файл уезжает смежникам, и врал раньше именно он.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const planSpec = require('../server/services/cad/plan-spec');
const dxfWriter = require('../server/services/cad/dxf-writer');
const acadBridge = require('../server/services/cad/acad-bridge');
const ZoneStyle = require('../public/zone-style.js');

/* ---------------- разбор DXF ---------------- */

/** Пары «код — значение»: файл DXF — это ровно они, по строке на каждую. */
function pairs(text) {
  const lines = text.split('\n');
  const out = [];
  for (let i = 0; i + 1 < lines.length; i += 2) out.push([Number(lines[i]), lines[i + 1]]);
  return out;
}

/** Сущности секции ENTITIES в порядке записи. */
function entitiesOf(text) {
  const p = pairs(text);
  const list = [];
  let cur = null;
  let inside = false;
  for (const [code, value] of p) {
    if (code === 2 && value === 'ENTITIES') { inside = true; continue; }
    if (!inside) continue;
    if (code === 0) {
      if (value === 'ENDSEC') break;
      cur = { type: value, tags: [] };
      list.push(cur);
      continue;
    }
    if (cur) cur.tags.push([code, value]);
  }
  return list;
}

const tag = (e, code) => { const t = e.tags.find(([c]) => c === code); return t === undefined ? undefined : t[1]; };
const allTags = (e, code) => e.tags.filter(([c]) => c === code).map(([, v]) => v);

/** Байты файла → текст ЧУЖИМ декодером: своя таблица перекодировки не участвует. */
const decodeFile = (buf) => new TextDecoder('windows-1251').decode(buf);

/* ---------------- исходные данные ---------------- */

const ring = (x, y, w, h) => [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];

/**
 * Участок в МСК: большие координаты здесь не украшение — на них видно, во что
 * обходится вершина, уехавшая в (0, 0).
 */
const X = 2200000;
const Y = 420000;

function siteFixture() {
  const zone = (kind, geometry, areaM2) => ({ geometry, properties: { kind, areaM2 } });
  const site = {
    parcel: { geometry: { type: 'polygon', points: ring(X, Y, 200, 150) } },
    buildings: [{ geometry: { type: 'polygon', points: ring(X + 150, Y + 100, 30, 30) } }],
    restrictions: [
      // отступ от границ — КОЛЬЦО: внешний контур по границе участка, внутри дырка
      zone('setback', { type: 'polygon', points: ring(X, Y, 200, 150), holes: [ring(X + 5, Y + 5, 190, 140)] }, 3400),
      zone('protectionZone', { type: 'polygon', points: ring(X + 20, Y + 20, 60, 40) }, 2400),
      zone('fireBreak', { type: 'polygon', points: ring(X + 100, Y + 60, 40, 40) }, 1600),
      zone('sanitaryZone', { type: 'polygon', points: ring(X + 140, Y + 90, 50, 50) }, 2500),
    ],
    drawingBounds: { minX: X, minY: Y, maxX: X + 200, maxY: Y + 150 },
  };
  // допустимая территория с отверстием: внутри дырки лежит запретная зона
  const buildable = {
    areaM2: 26000,
    geometry: { type: 'polygon', points: ring(X + 5, Y + 5, 190, 140), holes: [ring(X + 20, Y + 20, 60, 40)] },
  };
  return { site, buildable };
}

/** Вариант посадки: статус живой, подпись в metrics намеренно устаревшая. */
function variantFixture(status = 'admissible') {
  return {
    number: 2,
    status,
    statusLabel: 'требует вашего решения',
    footprint: { points: ring(X + 90, Y + 30, 40, 30) },
    metrics: { areaM2: 1200, width: 40, length: 30, shapeLabel: 'прямоугольник', rotationDeg: 0, floors: 3, tep: [] },
  };
}

function buildText(opts = {}) {
  const { site, buildable } = siteFixture();
  const spec = planSpec.build(site, { buildable, title: 'Тестовый проект', ...opts });
  const warnings = [];
  const buf = dxfWriter.writeSpecBuffer(spec, { warnings });
  return { spec, buf, warnings, text: decodeFile(buf) };
}

/* ---------------- кодировка ---------------- */

test('чертёж: DXF объявляет ANSI_1251, и кириллица читается кириллицей', () => {
  const { buf, text } = buildText();
  assert.ok(Buffer.isBuffer(buf), 'на диск обязаны уходить байты, а не строка JS');
  assert.ok(text.includes('\n9\n$DWGCODEPAGE\n3\nANSI_1251\n'), 'в заголовке нет кодовой страницы');
  assert.ok(text.includes('\n9\n$ACADVER\n1\nAC1015\n'));

  // имена слоёв — то, по чему чертёж разбирают; экранированием их не спасти
  for (const name of ['AI_ГРАНИЦЫ_ЗУ', 'AI_ЗОНА_ОТСТУПЫ', 'AI_ДОПУСТИМАЯ_ТЕРРИТОРИЯ', 'AI_ТЭП']) {
    assert.ok(text.includes(`\n2\n${name}\n`), `имя слоя ${name} не прочиталось из файла`);
  }
  assert.ok(text.includes('ЭКСПЛИКАЦИЯ ЗОН'), 'подписи не прочитались из файла');
  assert.ok(text.includes('санитарно-защитная зона'));

  // тех же букв в UTF-8 в файле быть не должно: иначе объявленная страница врёт
  assert.ok(!buf.includes(Buffer.from('AI_ГРАНИЦЫ_ЗУ', 'utf8')), 'в файле остались UTF-8 байты');
  assert.ok(!text.includes('Ð'), 'признак чтения UTF-8 как однобайтовой страницы');
  assert.ok(!buf.includes(0x98), 'в CP1251 байт 0x98 не определён');
});

test('чертёж: символы вне кодовой страницы уходят экранированием AutoCAD', () => {
  const { text } = buildText({ variant: variantFixture() });
  // «м²» и «×» в CP1251 отсутствуют: AutoCAD пишет такие символы как \U+XXXX
  assert.ok(text.includes('м\\U+00B2'), 'квадратный метр потерян');
  assert.ok(text.includes('\\U+00D7'), 'знак умножения в габарите потерян');
  assert.ok(!text.includes('²') && !text.includes('×'), 'непредставимый символ записан как есть');
  assert.strictEqual(dxfWriter.toCodepageText('стена 10 м² × 2'), 'стена 10 м\\U+00B2 \\U+00D7 2');
  // кириллица экранированием НЕ трогается: слои должны остаться читаемыми
  assert.strictEqual(dxfWriter.toCodepageText('AI_ГРАНИЦЫ_ЗУ'), 'AI_ГРАНИЦЫ_ЗУ');
});

/* ---------------- отверстия штриховок ---------------- */

test('чертёж: отверстия полигона попадают в спецификацию штриховки', () => {
  const geometry = {
    type: 'multipolygon',
    polygons: [
      { points: ring(0, 0, 100, 100), holes: [ring(20, 20, 20, 20), [[0, 0], [1, 1]]] },
      { points: ring(200, 0, 50, 50), holes: [] },
    ],
  };
  const polys = planSpec.polygonsOf(geometry);
  assert.strictEqual(polys.length, 2);
  assert.strictEqual(polys[0].holes.length, 1, 'кольцо из двух точек — не отверстие, а мусор');
  assert.strictEqual(polys[1].holes.length, 0);
  assert.deepStrictEqual(planSpec.polygonsOf({ type: 'polyline', points: ring(0, 0, 10, 10) }), []);
});

test('чертёж: кольцевая зона и дырявая территория не закрашиваются целиком', () => {
  const { text } = buildText();
  const hatches = entitiesOf(text).filter((e) => e.type === 'HATCH');

  const setback = hatches.find((h) => tag(h, 8) === planSpec.ZONE_LAYER_NAMES.setback);
  assert.ok(setback, 'штриховка зоны отступа не найдена');
  assert.strictEqual(Number(tag(setback, 91)), 2, 'у кольца обязано быть два пути границы');
  // 92: бит 1 — внешний путь, бит 2 — путь задан полилинией; у отверстия «внешнего» нет
  assert.deepStrictEqual(allTags(setback, 92).map(Number), [3, 2]);
  assert.strictEqual(Number(tag(setback, 75)), 0, 'стиль «нечётность» — он и вычитает отверстие');
  // число вершин в путях объявлено честно
  assert.deepStrictEqual(allTags(setback, 93).map(Number), [4, 4]);

  const solid = hatches.find((h) => tag(h, 8) === planSpec.LAYERS.buildable.name);
  assert.ok(solid && tag(solid, 2) === 'SOLID');
  assert.strictEqual(Number(tag(solid, 91)), 2, 'зелёная заливка ложилась поверх запретной зоны');

  // зона без отверстий остаётся с одним путём — лишних путей не появляется
  const plain = hatches.find((h) => tag(h, 8) === planSpec.ZONE_LAYER_NAMES.fireBreak);
  assert.strictEqual(Number(tag(plain, 91)), 1);
  assert.deepStrictEqual(allTags(plain, 92).map(Number), [3]);
});

/* ---------------- углы и шаг образцов ---------------- */

test('чертёж: угол и шаг штриховки записаны в DXF, а не только в описании образца', () => {
  const { spec, text } = buildText();
  const specHatches = spec.entities.filter((e) => e.type === 'hatch');
  const dxfHatches = entitiesOf(text).filter((e) => e.type === 'HATCH');
  assert.strictEqual(dxfHatches.length, specHatches.length);

  const byLayer = new Map();
  dxfHatches.forEach((h, i) => byLayer.set(specHatches[i], h));

  for (const [e, h] of byLayer) {
    const params = planSpec.hatchParams(e);
    assert.strictEqual(tag(h, 2), params.pattern);
    if (e.solid) continue;
    assert.strictEqual(Number(tag(h, 52)), params.angle, `угол зоны ${e.layer} не записан в код 52`);
    assert.strictEqual(Number(tag(h, 41)), params.scale, `шаг зоны ${e.layer} не записан в код 41`);
    assert.strictEqual(Number(tag(h, 76)), 0, 'образец описан своими линиями — значит пользовательский');
    // описание образца и заявленные параметры не должны расходиться
    assert.strictEqual(Number(tag(h, 53)), params.angle);
    assert.strictEqual(Number(tag(h, 46)), params.scale);
  }

  // углы зон разведены ровно так, как задано в оформлении
  const angleOf = (kind) => {
    const h = dxfHatches.find((x) => tag(x, 8) === planSpec.ZONE_LAYER_NAMES[kind]);
    return Number(tag(h, 52));
  };
  for (const kind of ['setback', 'protectionZone', 'fireBreak', 'sanitaryZone']) {
    assert.strictEqual(angleOf(kind), ZoneStyle.zone(kind).acadAngle, `зона ${kind} штрихуется не своим углом`);
  }
  assert.strictEqual(new Set(['setback', 'protectionZone', 'fireBreak', 'sanitaryZone'].map(angleOf)).size, 4,
    'под одним углом две зоны сливаются, и двойное ограничение перестаёт читаться');
});

test('чертёж: DXF и мост AutoCAD получают одни и те же параметры штриховки', () => {
  const { spec, text } = buildText({ variant: variantFixture() });
  const dxfHatches = entitiesOf(text).filter((e) => e.type === 'HATCH');
  // кольцевые зоны уходят в мост отдельной командой — считаем обе
  const HATCH_METHODS = new Set(['create_hatch', 'create_hatch_holes']);
  const commands = acadBridge.toCommands(spec).filter((c) => HATCH_METHODS.has(c.method));
  assert.strictEqual(commands.length, dxfHatches.length, 'два пути выгрузки дают разное число штриховок');

  commands.forEach((c, i) => {
    const h = dxfHatches[i];
    assert.strictEqual(c.params.pattern, tag(h, 2), 'образцы расходятся');
    assert.strictEqual(c.params.layer, tag(h, 8));
    if (c.params.pattern === 'SOLID') return;
    assert.strictEqual(c.params.angle_deg, Number(tag(h, 52)), 'углы в DWG и DXF расходятся');
    assert.strictEqual(c.params.scale, Number(tag(h, 41)), 'шаг в DWG и DXF расходится');
  });

  // отверстия уходят и в мост: иначе DWG заливает кольцо целиком
  const setback = commands.find((c) => c.params.layer === planSpec.ZONE_LAYER_NAMES.setback);
  assert.strictEqual(setback.method, 'create_hatch_holes', 'кольцо рисуется командой с отверстиями');
  assert.strictEqual(setback.fallback, 'create_hatch', 'у старого моста должен быть путь отката');
  assert.strictEqual(setback.params.holes.length, 1);
  assert.ok(setback.params.holes[0].every((p) => Number.isFinite(p.x) && Number.isFinite(p.y)));
});

/* ---------------- нечисловые координаты ---------------- */

test('чертёж: нечисловая координата не превращается в точку (0, 0)', () => {
  const layers = [{ name: 'AI_ГРАНИЦЫ_ЗУ', color: 7, linetype: 'Continuous' }];
  const bounds = { minX: X, minY: Y, maxX: X + 200, maxY: Y + 150 };
  const broken = { type: 'polyline', layer: 'AI_ГРАНИЦЫ_ЗУ', closed: true, points: [[X, Y], [NaN, Y + 100], [X + 200, Y + 100]] };
  const whole = { type: 'polyline', layer: 'AI_ГРАНИЦЫ_ЗУ', closed: true, points: [[X, Y], [X + 200, Y], [X + 200, Y + 150]] };

  const warnings = [];
  const text = dxfWriter.writeSpec({ units: 'm', layers, bounds, entities: [broken, whole] }, { warnings });
  const drawn = entitiesOf(text);
  assert.strictEqual(drawn.length, 1, 'вырожденная полилиния попала в чертёж');
  assert.strictEqual(warnings.length, 1, 'пропуск сущности обязан быть виден человеку');
  assert.ok(/не является парой чисел/.test(warnings[0]), warnings[0]);
  // ни одной вершины в начале координат: там она дала бы луч в 2200 км
  for (const [code, value] of drawn[0].tags) {
    if (code === 10 || code === 20) assert.notStrictEqual(Number(value), 0);
  }

  // если годного не осталось — честный отказ, а не пустой правдоподобный файл
  assert.throws(
    () => dxfWriter.writeSpec({ units: 'm', layers, bounds, entities: [broken] }, { warnings: [] }),
    (err) => err instanceof dxfWriter.DxfDataError && /Ни одна сущность/.test(err.message),
  );
});

test('чертёж: нечисловые габариты не роняют выгрузку, но попадают в предупреждения', () => {
  const layers = [{ name: 'AI_ГРАНИЦЫ_ЗУ', color: 7, linetype: 'Continuous' }];
  const whole = { type: 'polyline', layer: 'AI_ГРАНИЦЫ_ЗУ', closed: true, points: [[X, Y], [X + 200, Y], [X + 200, Y + 150]] };
  const warnings = [];
  const text = dxfWriter.writeSpec(
    { units: 'm', layers, bounds: { minX: NaN, minY: 0, maxX: 100, maxY: 100 }, entities: [whole] },
    { warnings },
  );
  assert.ok(text.includes('$EXTMIN'));
  assert.ok(warnings.some((w) => /Габариты чертежа/.test(w)), 'подмена габаритов прошла молча');
});

/* ---------------- статус варианта ---------------- */

test('чертёж: статус варианта берётся живой, а не замороженный в метриках', () => {
  const { text } = buildText({ variant: variantFixture('admissible') });
  assert.ok(text.includes('Статус: допустим'), 'в чертёж ушёл устаревший ярлык из metrics');
  assert.ok(!text.includes('требует вашего решения'));

  const pending = buildText({ variant: variantFixture('needs_decision') });
  assert.ok(pending.text.includes('Статус: требует решения пользователя'));

  // неизвестный статус: замороженная подпись остаётся запасным вариантом
  assert.strictEqual(planSpec.variantStatusLabel({ status: 'draft', statusLabel: 'черновик' }), 'черновик');
  assert.strictEqual(planSpec.variantStatusLabel({ status: 'admissible', statusLabel: 'устарело' }), 'допустим');
  assert.strictEqual(planSpec.variantStatusLabel(null), '');
});
