'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { parseDxf, summarizeDxf } = require('../server/services/cad');

/** Мини-DXF: HEADER с габаритами, таблица слоёв, сущности, секция OBJECTS-мусора. */
const pairs = [
  '0', 'SECTION', '2', 'HEADER',
  '9', '$EXTMIN', '10', '100.5', '20', '200.25',
  '9', '$EXTMAX', '10', '300.5', '20', '400.25',
  '9', '$INSUNITS', '70', '6',
  '0', 'ENDSEC',
  '0', 'SECTION', '2', 'TABLES',
  '0', 'TABLE', '2', 'LAYER',
  '0', 'LAYER', '2', '03_Здания и строения',
  '0', 'LAYER', '2', '11_Гидрография',
  '0', 'ENDTAB', '0', 'ENDSEC',
  '0', 'SECTION', '2', 'ENTITIES',
  '0', 'TEXT', '8', '03_Здания и строения', '1', 'бет. плиты',
  '0', 'TEXT', '8', '03_Здания и строения', '1', 'бет. плиты',
  '0', 'MTEXT', '8', '11_Гидрография', '1', '{\\fArial;отметка \\P132.45}',
  // замкнутый квадрат 10×10 на слое зданий
  '0', 'LWPOLYLINE', '8', '03_Здания и строения', '90', '4', '70', '1',
  '10', '100', '20', '200', '10', '110', '20', '200', '10', '110', '20', '210', '10', '100', '20', '210',
  // разомкнутая линия на постороннем слое — в контуры не попадает
  '0', 'LWPOLYLINE', '8', '12_Рельеф', '90', '2', '70', '0', '10', '0', '20', '0', '10', '5', '20', '5',
  '0', 'INSERT', '2', 'дерево', '8', '0',
  '0', 'INSERT', '2', 'дерево', '8', '0',
  '0', 'ENDSEC',
  '0', 'SECTION', '2', 'OBJECTS',
  '0', 'DICTIONARY',
  '0', 'ENDSEC',
  '0', 'EOF',
];
const DXF = pairs.join('\n');

test('parseDxf: слои, сущности, надписи, блоки, габариты', () => {
  const r = parseDxf(DXF);
  assert.deepStrictEqual(r.layers, ['03_Здания и строения', '11_Гидрография']);
  assert.strictEqual(r.entities.get('TEXT'), 2);
  assert.strictEqual(r.entities.get('LWPOLYLINE'), 2);
  assert.strictEqual(r.entities.get('INSERT'), 2);
  // геометрия: замкнутый квадрат со слоя зданий с координатами вершин
  assert.strictEqual(r.polylines.length, 2);
  const sq = r.polylines.find((p) => p.layer === '03_Здания и строения');
  assert.ok(sq && sq.closed);
  assert.deepStrictEqual(sq.points, [[100, 200], [110, 200], [110, 210], [100, 210]]);
  // OBJECTS-секция не считается сущностями чертежа
  assert.strictEqual(r.entities.has('DICTIONARY'), false);
  assert.strictEqual(r.inserts.get('дерево'), 2);
  const values = r.texts.map((t) => t.value);
  assert.ok(values.includes('бет. плиты'));
  // MTEXT очищен от форматирования, \P заменён пробелом
  assert.ok(values.some((v) => v.includes('отметка') && v.includes('132.45') && !v.includes('\\f')));
  assert.strictEqual(r.header['$EXTMIN.10'], 100.5);
  assert.strictEqual(r.header.$INSUNITS, 6);
});

test('summarizeDxf: выжимка содержит ключевые сведения и укладывается в лимит', () => {
  const md = summarizeDxf(DXF, 'план.dxf');
  assert.ok(md.includes('план.dxf'));
  assert.ok(md.includes('метры'));
  assert.ok(md.includes('03_Здания и строения'));
  assert.ok(md.includes('«бет. плиты» ×2'));
  assert.ok(md.includes('дерево ×2'));
  // контуры: квадрат зданий с площадью 100 и периметром 40, координаты вершин на месте
  assert.ok(md.includes('Контуры и границы'));
  assert.ok(md.includes('площадь ≈ 100'));
  assert.ok(md.includes('периметр ≈ 40'));
  assert.ok(md.includes('(100, 200)'));
  // разомкнутая линия рельефа в контуры не попала
  assert.ok(!md.includes('12_Рельеф]'));
  assert.ok(md.length <= 32000);
});

test('summarizeDxf: пустой/битый DXF даёт честную пометку', () => {
  const md = summarizeDxf('не dxf вовсе', 'мусор.dxf');
  assert.ok(md.includes('не распознана'));
});
