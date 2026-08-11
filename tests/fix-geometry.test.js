'use strict';
/**
 * Разбор чертежа и геометрия: дефекты, найденные аудитом (отчёты dir2/dir4).
 *
 * Каждый тест закрывает конкретную поломку, а не «проверяет модуль вообще».
 * Общий смысл всех до одного: молчаливая неправда хуже отказа. Участок,
 * определённый неверно, обязан сопровождаться предупреждением; вырожденная
 * геометрия обязана называться вырожденной, а не превращаться в «мест нет»;
 * число без единиц измерения в модель не уходит.
 */
process.env.DATA_DIR = require('path').join(require('os').tmpdir(), `pilot1-fixgeo-${process.pid}`);
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');

const cad = require('../server/services/cad');
const cadGeom = require('../server/services/geometry/cad-geometry');
const G = require('../server/services/geometry/site-geometry');
const jts = require('../server/services/geometry/jts');
const engine = require('../server/services/geometry/restriction-engine');
const RR = require('../server/services/geometry/restriction-rules');
const P = require('../server/services/geometry/placement-engine');
const planSvc = require('../server/services/geometry/plan');
const { writeDxf } = require('../server/services/dxf');

/* ---------------- вспомогательное: сборка DXF из «сырых» пар кодов ---------------- */

/** DXF с произвольными сущностями: нужен там, где writeDxf умеет только полилинии. */
function rawDxf(entityPairs, { insunits, extent } = {}) {
  const L = ['0', 'SECTION', '2', 'HEADER'];
  if (insunits !== undefined) L.push('9', '$INSUNITS', '70', String(insunits));
  if (extent) {
    L.push('9', '$EXTMIN', '10', String(extent[0]), '20', String(extent[1]));
    L.push('9', '$EXTMAX', '10', String(extent[2]), '20', String(extent[3]));
  }
  L.push('0', 'ENDSEC', '0', 'SECTION', '2', 'ENTITIES', ...entityPairs, '0', 'ENDSEC', '0', 'EOF');
  return L.join('\n');
}

const eLine = (layer, x1, y1, x2, y2, paper) => [
  '0', 'LINE', '8', layer, ...(paper ? ['67', '1'] : []),
  '10', String(x1), '20', String(y1), '11', String(x2), '21', String(y2),
];
const eLw = (layer, pts, closed, paper) => [
  '0', 'LWPOLYLINE', '8', layer, ...(paper ? ['67', '1'] : []),
  '90', String(pts.length), '70', closed ? '1' : '0',
  ...pts.flatMap(([x, y]) => ['10', String(x), '20', String(y)]),
];

const codes = (site) => site.warnings.map((w) => w.code);
const findWarning = (site, code) => site.warnings.find((w) => w.code === code);

/* ---------------- разбор чертежа ---------------- */

test('чертёж: сущности пространства листа не становятся объектами местности', () => {
  // рамка листа заведомо больше участка — раньше именно она объявлялась
  // «существующим объектом» и уводила габариты плана на порядки
  const dxf = rawDxf([
    ...eLw('Границы ЗУ', [[0, 0], [40, 0], [40, 30], [0, 30]], true),
    ...eLw('18_Зарамочное оформление', [[0, 0], [841000, 0], [841000, 594000], [0, 594000]], true, true),
    ...eLine('0', 0, 0, 841000, 594000, true),
  ], { insunits: 6, extent: [0, 0, 40, 30] });

  const parsed = cad.parseDxf(dxf);
  assert.strictEqual(parsed.polylines.length, 1, 'в геометрию попала только сущность модельного пространства');
  assert.strictEqual(parsed.paperEntities.get('LWPOLYLINE'), 1);
  assert.strictEqual(parsed.paperEntities.get('LINE'), 1);

  const site = cadGeom.fromDxf(dxf, { fileName: 'лист.dxf' });
  assert.strictEqual(site.parcel.properties.areaM2, 1200);
  assert.strictEqual(site.existingObjects.length, 0, 'рамка и штамп в модель не попадают');
  assert.deepStrictEqual(site.drawingBounds, { minX: 0, minY: 0, maxX: 40, maxY: 30 });
  assert.ok(codes(site).includes('paper-space-skipped'), 'исключение оформления обязано быть названо');
});

test('чертёж: граница участка из четырёх отрезков собирается в замкнутый контур', () => {
  const dxf = rawDxf([
    ...eLine('Границы ЗУ', 0, 0, 40, 0),
    ...eLine('Границы ЗУ', 40, 0, 40, 30),
    ...eLine('Границы ЗУ', 40, 30, 0, 30),
    ...eLine('Границы ЗУ', 0, 30, 0, 0),
  ], { insunits: 6, extent: [0, 0, 40, 30] });

  const site = cadGeom.fromDxf(dxf, { fileName: 'отрезки.dxf' });
  assert.ok(site.parcel, 'участок из отрезков обязан определяться');
  assert.strictEqual(site.parcel.properties.areaM2, 1200);
  assert.strictEqual(site.parcel.properties.perimeterM, 140);
  assert.match(site.parcel.provenance.sourceEntity, /LINE/, 'происхождение называет исходную сущность');
});

test('чертёж: разорванная цепочка отрезков не домыкается догадкой', () => {
  // третьего отрезка нет — контур незамкнут, и выдумывать его нельзя
  const dxf = rawDxf([
    ...eLine('Границы ЗУ', 0, 0, 40, 0),
    ...eLine('Границы ЗУ', 40, 0, 40, 30),
  ], { insunits: 6 });
  const site = cadGeom.fromDxf(dxf, { fileName: 'разрыв.dxf' });
  assert.ok(site.parcel);
  assert.strictEqual(site.parcel.geometry.closed, false, 'незамкнутая цепочка полигоном не притворяется');
  assert.strictEqual(site.parcel.properties.lengthM, 70);
});

test('чертёж: окружность и дуга становятся геометрией, а не пропадают', () => {
  const circle = rawDxf(['0', 'CIRCLE', '8', 'Здания существующие', '10', '50', '20', '50', '40', '10'], { insunits: 6 });
  const s1 = cadGeom.fromDxf(circle, { fileName: 'круг.dxf' });
  assert.strictEqual(s1.buildings.length, 1, 'CIRCLE обязан дать объект');
  // ломаная из 72 сегментов чуть меньше круга — это аппроксимация, а не ошибка
  assert.ok(Math.abs(s1.buildings[0].properties.areaM2 - Math.PI * 100) < 1,
    `площадь ${s1.buildings[0].properties.areaM2} вместо ≈314.16`);

  const arc = rawDxf(['0', 'ARC', '8', 'Красные линии', '10', '0', '20', '0', '40', '100', '50', '0', '51', '90'], { insunits: 6 });
  const s2 = cadGeom.fromDxf(arc, { fileName: 'дуга.dxf' });
  assert.strictEqual(s2.redLines.length, 1, 'ARC обязан дать объект');
  assert.ok(Math.abs(s2.redLines[0].properties.lengthM - (Math.PI * 100) / 2) < 1,
    `длина ${s2.redLines[0].properties.lengthM} вместо ≈157.08`);
});

test('чертёж: о неразобранных блоках сообщается прямо', () => {
  const dxf = rawDxf([
    ...eLw('Границы ЗУ', [[0, 0], [40, 0], [40, 30], [0, 30]], true),
    '0', 'INSERT', '2', 'дерево', '8', '0',
    '0', 'INSERT', '2', 'дерево', '8', '0',
    '0', 'INSERT', '2', 'колодец', '8', '0',
  ], { insunits: 6 });
  const site = cadGeom.fromDxf(dxf, { fileName: 'блоки.dxf' });
  const w = findWarning(site, 'blocks-not-parsed');
  assert.ok(w, 'вставки блоков обязаны быть названы');
  assert.match(w.message, /3 вставок блоков/);
  assert.match(w.message, /на 2 видов/);
});

test('чертёж: сомнительные границы участка сопровождаются списком кандидатов', () => {
  // слой «Границы покрытий» подходит под общее правило «границ…», а контур
  // на нём — мелкая обводка покрытия: ровно случай реальной топосъёмки
  const dxf = rawDxf([
    ...eLw('10_Границы покрытий и угодий', [[10, 10], [16, 10], [16, 22], [10, 22]], true),
    ...eLw('10_Границы покрытий и угодий', [[30, 30], [34, 30], [34, 38], [30, 38]], true),
  ], { insunits: 6, extent: [0, 0, 200, 160] });

  const site = cadGeom.fromDxf(dxf, { fileName: 'топо.dxf' });
  assert.strictEqual(site.parcel.properties.areaM2, 72, 'выбор не переигрывается — переигрывать его нечем');
  const w = findWarning(site, 'parcel-doubtful');
  assert.ok(w, 'молчаливое «участок 72 м²» — главный дефект отчёта dir4');
  assert.match(w.message, /неправдоподобно мало/);
  assert.match(w.message, /уверенность 60%/);
  assert.ok(Array.isArray(w.candidates) && w.candidates.length >= 2, 'кандидаты перечислены машиночитаемо');
  assert.strictEqual(w.candidates.filter((c) => c.chosen).length, 1);
  assert.match(w.message, /Кандидаты:/);
});

test('чертёж: правдоподобный участок предупреждения не поднимает', () => {
  const dxf = rawDxf([
    ...eLw('Границы ЗУ', [[0, 0], [100, 0], [100, 80], [0, 80]], true),
    ...eLw('Здания существующие', [[10, 10], [30, 10], [30, 25], [10, 25]], true),
  ], { insunits: 6, extent: [0, 0, 100, 80] });
  const site = cadGeom.fromDxf(dxf, { fileName: 'норма.dxf' });
  assert.strictEqual(site.parcel.properties.areaM2, 8000);
  assert.ok(!codes(site).includes('parcel-doubtful'), `лишнее предупреждение: ${JSON.stringify(site.warnings)}`);
  assert.deepStrictEqual(codes(site), [], 'на здоровом чертеже предупреждений быть не должно');
});

test('чертёж: самопересекающийся контур получает настоящую площадь и предупреждение', () => {
  // типичная ошибка оцифровки: две вершины переставлены местами
  const bowtie = [[0, 0], [100, 0], [0, 50], [100, 50]];
  assert.strictEqual(G.polygonArea(bowtie), 0, 'шнурование на «бабочке» гасит знаки — это и был источник нуля');
  assert.strictEqual(G.polygonAreaChecked(bowtie).selfIntersecting, true);
  assert.ok(G.polygonAreaChecked(bowtie).areaM2 > 0);

  const dxf = writeDxf([
    { layer: 'Границы ЗУ', closed: true, points: bowtie },
    { layer: 'Границы покрытий', closed: true, points: [[200, 200], [205, 200], [205, 205], [200, 205]] },
  ]);
  const site = cadGeom.fromDxf(dxf, { fileName: 'бабочка.dxf' });
  assert.match(site.parcel.provenance.sourceLayer, /Границы ЗУ/,
    'битый настоящий участок не должен проигрывать случайному квадратику 25 м²');
  assert.ok(site.parcel.properties.areaM2 > 1000, `площадь ${site.parcel.properties.areaM2}`);
  assert.strictEqual(site.parcel.properties.selfIntersecting, true);
  assert.ok(codes(site).includes('self-intersecting'));
});

/* ---------------- единицы измерения ---------------- */

test('единицы: километры и прочие коды INSUNITS пересчитываются, а не принимаются за метры', () => {
  assert.strictEqual(G.unitInfo(7).scale, 1000, 'километры');
  assert.strictEqual(G.unitInfo(3).scale, 1609.344, 'мили');
  assert.strictEqual(G.unitInfo(14).scale, 0.1, 'дециметры');
  assert.strictEqual(G.unitInfo(7).assumed, false, 'известный код — не допущение');

  const dxf = writeDxf([{ layer: 'Границы ЗУ', closed: true, points: [[0, 0], [0.03, 0], [0.03, 0.05], [0, 0.05]] }])
    .replace('9\n$ACADVER\n1\nAC1009\n', '9\n$ACADVER\n1\nAC1009\n9\n$INSUNITS\n70\n7\n');
  const site = cadGeom.fromDxf(dxf, { fileName: 'км.dxf' });
  assert.strictEqual(site.parcel.properties.areaM2, 1500, 'участок 0,03 × 0,05 км — это 1500 м²');
  assert.strictEqual(site.coordinateSystem.assumedUnits, false);
  assert.deepStrictEqual(codes(site), [], 'единицы заданы и поддержаны — предупреждать не о чем');
});

test('единицы: непонятный код признаётся непонятным, а не «не заданным»', () => {
  const dxf = writeDxf([{ layer: 'Границы ЗУ', closed: true, points: [[0, 0], [30, 0], [30, 50], [0, 50]] }])
    .replace('9\n$ACADVER\n1\nAC1009\n', '9\n$ACADVER\n1\nAC1009\n9\n$INSUNITS\n70\n42\n');
  const site = cadGeom.fromDxf(dxf, { fileName: 'код42.dxf' });
  const w = findWarning(site, 'units-unsupported');
  assert.ok(w, 'нераспознанный код обязан иметь свой код предупреждения');
  assert.match(w.message, /\$INSUNITS=42 не распознан/);
  assert.ok(!/не заданы/.test(w.message), 'текст не должен врать: единицы заданы, просто не поддержаны');
});

test('единицы: строка «код undefined» в модель и в базу не уходит', () => {
  // writeDxf намеренно не пишет $INSUNITS — это штатный случай
  const site = cadGeom.fromDxf(writeDxf([{ layer: 'Границы ЗУ', closed: true, points: [[0, 0], [10, 0], [10, 10], [0, 10]] }]),
    { fileName: 'без-единиц.dxf' });
  assert.strictEqual(site.coordinateSystem.sourceUnits, 'не заданы (принято: метры)');
  assert.ok(!site.coordinateSystem.sourceUnits.includes('undefined'));
  assert.ok(codes(site).includes('units-assumed'));
});

/* ---------------- выжимка для модели ---------------- */

test('выжимка: площади и длины пересчитаны в метры и подписаны единицами', () => {
  const dxf = writeDxf([{ layer: 'Границы ЗУ', closed: true, points: [[0, 0], [30000, 0], [30000, 50000], [0, 50000]] }])
    .replace('9\n$ACADVER\n1\nAC1009\n', '9\n$ACADVER\n1\nAC1009\n9\n$INSUNITS\n70\n4\n');
  const md = cad.summarizeDxf(dxf, 'мм.dxf');
  // toLocaleString('ru-RU') разделяет разряды неразрывным пробелом — сравниваем по образцу
  assert.match(md, /площадь ≈ 1\s500 м²/, `в выжимке нет площади в метрах:\n${md}`);
  assert.match(md, /периметр ≈ 160 м/);
  assert.ok(!/1\s500\s000\s000/.test(md), 'площадь в единицах чертежа модели не показывается');
  assert.ok(md.includes('миллиметры'), 'единицы чертежа названы явно');
});

test('выжимка: про МСК говорится только при крупных координатах', () => {
  const local = cad.summarizeDxf(rawDxf(eLw('Границы ЗУ', [[0, 0], [40, 0], [40, 30], [0, 30]], true),
    { insunits: 6, extent: [0, 0, 40, 30] }), 'локальный.dxf');
  assert.ok(!/означают государственную/.test(local), 'фраза про МСК не должна приписываться плану 40 × 30 м');
  assert.match(local, /локальная \(условная\) система координат/);

  const msk = cad.summarizeDxf(rawDxf(eLw('Границы ЗУ', [[2195900, 422300], [2195940, 422300], [2195940, 422330], [2195900, 422330]], true),
    { insunits: 6, extent: [2195900, 422300, 2195940, 422330] }), 'мск.dxf');
  assert.match(msk, /государственную\/местную систему координат \(МСК\)/);
});

/* ---------------- линейные объекты ---------------- */

test('чертёж: замкнутая линия на слое красных линий сохраняет замыкающий сегмент', () => {
  const dxf = writeDxf([{ layer: 'Красные линии', closed: true, points: [[0, 0], [100, 0], [100, 50], [0, 50]] }]);
  const site = cadGeom.fromDxf(dxf, { fileName: 'красные.dxf' });
  const rl = site.redLines[0];
  assert.strictEqual(rl.properties.lengthM, 300, 'периметр 100×50 — это 300 м, а не 250');
  assert.strictEqual(rl.geometry.type, 'polyline', 'красная линия полигоном не становится');
  assert.strictEqual(rl.properties.closedRing, true);
  assert.deepStrictEqual(rl.geometry.points[0], rl.geometry.points[rl.geometry.points.length - 1],
    'замыкающая вершина присутствует явно');
});

/* ---------------- сборка плана из нескольких чертежей ---------------- */

test('план: чертежи в разных системах координат объединять нельзя', () => {
  const warnings = planSvc.coordinateMismatchWarnings([
    { name: 'топо_мск.dxf', bounds: { minX: 2195900, minY: 422300, maxX: 2196000, maxY: 422400 } },
    { name: 'план_локальный.dxf', bounds: { minX: 0, minY: 0, maxX: 30, maxY: 20 } },
  ]);
  assert.strictEqual(warnings.length, 1);
  assert.strictEqual(warnings[0].code, 'crs-mismatch');
  assert.match(warnings[0].message, /топо_мск\.dxf/);
  assert.match(warnings[0].message, /план_локальный\.dxf/);
  assert.match(warnings[0].message, /разных системах координат/);

  // два чертежа одной площадки предупреждения не поднимают
  assert.deepStrictEqual(planSvc.coordinateMismatchWarnings([
    { name: 'а.dxf', bounds: { minX: 0, minY: 0, maxX: 100, maxY: 80 } },
    { name: 'б.dxf', bounds: { minX: 10, minY: 10, maxX: 90, maxY: 70 } },
  ]), []);
});

test('план: сессия из двух несовместимых чертежей получает предупреждение', async (t) => {
  const os = require('os'); const pathMod = require('path'); const crypto = require('crypto');
  const dir = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'fixgeo-plan-'));
  process.env.DATA_DIR = dir;
  const { db, now } = require('../server/db');
  const sid = crypto.randomUUID();
  db.prepare('INSERT INTO sessions (id, token, status, created_at, updated_at) VALUES (?,?,?,?,?)')
    .run(sid, `tok-${sid}`, 'active', now(), now());
  t.after(() => {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(sid);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const write = (name, layers) => {
    const p = pathMod.join(dir, name);
    fs.writeFileSync(p, writeDxf(layers));
    db.prepare('INSERT INTO files (id, session_id, original_name, stored_path, ext, size, created_at) VALUES (?,?,?,?,?,?,?)')
      .run(crypto.randomUUID(), sid, name, p, 'dxf', fs.statSync(p).size, now());
  };
  write('топо_мск.dxf', [{ layer: 'Границы ЗУ', closed: true, points: [[2195900, 422300], [2196000, 422300], [2196000, 422400], [2195900, 422400]] }]);
  write('план_локальный.dxf', [{ layer: 'Здания существующие', closed: true, points: [[0, 0], [30, 0], [30, 20], [0, 20]] }]);

  const site = await planSvc.buildForSession(sid);
  assert.ok(site.warnings.some((w) => w.code === 'crs-mismatch'),
    `здание в 2200 км от участка обязано быть замечено: ${JSON.stringify(site.warnings.map((w) => w.code))}`);
});

test('план: кэш прежнего разбора не отдаётся как готовая геометрия', async (t) => {
  const os = require('os'); const pathMod = require('path'); const crypto = require('crypto');
  const dir = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'fixgeo-cache-'));
  process.env.DATA_DIR = dir;
  const { db, now } = require('../server/db');
  const sid = crypto.randomUUID();
  db.prepare('INSERT INTO sessions (id, token, status, created_at, updated_at) VALUES (?,?,?,?,?)')
    .run(sid, `tok-${sid}`, 'active', now(), now());
  t.after(() => {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(sid);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const p = pathMod.join(dir, 'у.dxf');
  fs.writeFileSync(p, writeDxf([{ layer: 'Границы ЗУ', closed: true, points: [[0, 0], [100, 0], [100, 80], [0, 80]] }]));
  const fileId = crypto.randomUUID();
  db.prepare('INSERT INTO files (id, session_id, original_name, stored_path, ext, size, created_at) VALUES (?,?,?,?,?,?,?)')
    .run(fileId, sid, 'у.dxf', p, 'dxf', fs.statSync(p).size, now());

  // кэш прежнего формата: голая модель с чужой (заведомо неверной) площадью
  fs.writeFileSync(`${p}.plan.json`, JSON.stringify({
    ...G.createSiteGeometry(), version: 1, parcel: { properties: { areaM2: 999999 } },
  }));

  const site = await planSvc.siteForFile(db.prepare('SELECT * FROM files WHERE id = ?').get(fileId));
  assert.strictEqual(site.parcel.properties.areaM2, 8000,
    'старый кэш обязан быть пересобран: геометрия из него уже неверна');
  const written = JSON.parse(fs.readFileSync(`${p}.plan.json`, 'utf8'));
  assert.ok(written.parserVersion >= 2, 'новый кэш помечен версией разбора');
});

/* ---------------- движок ограничений ---------------- */

const rulesFrom = (list) => RR.processExtraction({ rules: list }).rules;
const lepRule = {
  kind: 'protectionZone', operation: 'bufferOutward', targetSelector: 'utility', targetHint: 'ЛЭП 10 кВ',
  value: 10, unit: 'м', basis: 'ПП РФ № 160, п. 8', sourceDocument: 'ГПЗУ.pdf', sourceClause: '3.4',
  quote: '10 метров', confidence: 0.9, appliesTo: 'newBuilding',
};

test('движок: предупреждение о несовпавшем уточнении возвращается наружу', () => {
  const site = cadGeom.fromDxf(writeDxf([
    { layer: 'Границы ЗУ', closed: true, points: [[0, 0], [100, 0], [100, 80], [0, 80]] },
    { layer: 'ВОДОПРОВОД', closed: false, points: [[0, 40], [100, 40]] },
  ]), { fileName: 'вода.dxf' });

  const res = engine.build(site, rulesFrom([lepRule]));
  assert.ok(Array.isArray(res.warnings), 'движок обязан возвращать warnings, а не только мутировать site');
  assert.strictEqual(res.warnings.length, 1);
  assert.strictEqual(res.warnings[0].code, 'target-hint-missed');
  assert.match(res.warnings[0].message, /ЛЭП 10 кВ/);
  // site по-прежнему мутируется — этим пользуются отчёт и карточки
  assert.ok(site.warnings.some((w) => w.code === 'target-hint-missed'));
  // повторный расчёт того же не удваивает текст
  engine.build(site, rulesFrom([lepRule]));
  assert.strictEqual(site.warnings.filter((w) => w.code === 'target-hint-missed').length, 1);
});

test('очередь: предупреждения переживают worker-поток', async () => {
  const queue = require('../server/services/geometry/queue');
  const site = cadGeom.fromDxf(writeDxf([
    { layer: 'Границы ЗУ', closed: true, points: [[0, 0], [100, 0], [100, 80], [0, 80]] },
    { layer: 'ВОДОПРОВОД', closed: false, points: [[0, 40], [100, 40]] },
  ]), { fileName: 'вода.dxf' });

  const res = await queue.run('restrictions', { site, rules: rulesFrom([lepRule]) });
  assert.ok(Object.prototype.hasOwnProperty.call(res, 'warnings'),
    'результат задачи обязан нести warnings: мутация site в поток не возвращается');
  assert.ok(res.warnings.some((w) => w.code === 'target-hint-missed'),
    `зона построена от чужого объекта, а предупреждения нет: ${JSON.stringify(res.warnings)}`);
  assert.strictEqual(res.restrictions.length, 1, 'сама зона при этом строится');
});

test('движок: нулевая площадь участка не превращается в NaN', () => {
  const site = cadGeom.fromDxf(writeDxf([
    { layer: 'Границы ЗУ', closed: true, points: [[0, 0], [50, 0], [100, 0]] },
  ]), { fileName: 'вырожденный.dxf' });
  const res = engine.build(site, rulesFrom([lepRule]));

  assert.strictEqual(res.buildable, null,
    'расчёт по нулевому участку не выполняется — объект с нулями выглядел бы выполненным расчётом');
  assert.strictEqual(res.stats['доляОтУчастка'], null, 'строка «NaN%» в статистику не уходит');
  assert.strictEqual(res.stats['допустимаяПлощадь'], null);
  const w = res.warnings.find((x) => x.code === 'parcel-degenerate');
  assert.ok(w, 'причина обязана быть названа');
  assert.match(w.message, /вырожден/);

  // тот же расчёт на здоровом участке долю считает как раньше
  const ok = cadGeom.fromDxf(writeDxf([
    { layer: 'Границы ЗУ', closed: true, points: [[0, 0], [100, 0], [100, 80], [0, 80]] },
    { layer: 'Сети ЛЭП 10кВ', closed: false, points: [[0, 60], [100, 60]] },
  ]), { fileName: 'норма.dxf' });
  const good = engine.build(ok, rulesFrom([lepRule]));
  assert.ok(good.buildable.sharePercent > 0 && good.buildable.sharePercent < 100);
  assert.match(good.stats['доляОтУчастка'], /^\d+(\.\d+)?%$/);
});

/* ---------------- движок посадки ---------------- */

test('посадка: вырожденный участок — это ошибка разбора, а не «мест нет»', () => {
  const site = cadGeom.fromDxf(writeDxf([
    { layer: 'Границы ЗУ', closed: true, points: [[0, 0], [50, 0], [100, 0]] },
  ]), { fileName: 'вырожденный.dxf' });

  const res = P.generate(site, null, { areaM2: 200 });
  assert.strictEqual(res.candidates.length, 0);
  assert.strictEqual(res.errors.length, 1, 'пустой список без причины неотличим от «здание не влезло»');
  assert.match(res.errors[0], /вырождена/);
  assert.match(res.errors[0], /требования к зданию здесь ни при чём/);
  assert.ok(res.warnings.some((w) => w.code === 'placement-area-degenerate'));
});

test('посадка: «мест нет» по-прежнему остаётся пустым списком без ошибок', () => {
  const site = cadGeom.fromDxf(writeDxf([
    { layer: 'Границы ЗУ', closed: true, points: [[0, 0], [100, 0], [100, 80], [0, 80]] },
  ]), { fileName: 'тесно.dxf' });
  const res = P.generate(site, null, { areaM2: 90000 }, { limit: 5 });
  assert.strictEqual(res.candidates.length, 0);
  assert.deepStrictEqual(res.errors, [], 'отсутствие места — не ошибка требований');
  assert.ok(res.tried > 0, 'перебор выполнялся');
});

test('посадка: вырожденное пятно не порождает выход за границы «на 0 м²»', () => {
  const site = cadGeom.fromDxf(writeDxf([
    { layer: 'Границы ЗУ', closed: true, points: [[0, 0], [100, 0], [100, 80], [0, 80]] },
  ]), { fileName: 'участок.dxf' });
  const req = P.normalizeRequirements({ areaM2: 100 }).req;

  const flat = P.validate(site, [[10, 10], [20, 10], [30, 10]], req);
  assert.deepStrictEqual(flat.violations.map((v) => v.code), ['degenerate'],
    'пятно целиком внутри участка не может «выходить за границы»');
  assert.strictEqual(flat.areaM2, 0);

  // самопересекающееся пятно имеет площадь после починки, а не ноль
  const bowtie = P.validate(site, [[10, 10], [30, 30], [30, 10], [10, 30]], req);
  assert.ok(bowtie.areaM2 > 0, `площадь ${bowtie.areaM2}: шнурование давало 0 при ненулевой фигуре`);
});

test('посадка: набор вариантов не зависит от начала координат чертежа', () => {
  const V = require('../server/services/geometry/variants');
  const setback = {
    kind: 'setback', operation: 'bufferInward', targetSelector: 'parcelBoundary', targetHint: '',
    value: 5, unit: 'м', basis: 'ГПЗУ, п. 2.1', sourceDocument: 'ГПЗУ.pdf', sourceClause: '2.1',
    quote: 'отступ 5 м', confidence: 0.9, appliesTo: 'newBuilding',
  };
  const run = (dx, dy) => {
    const shift = (pts) => pts.map(([x, y]) => [x + dx, y + dy]);
    const site = cadGeom.fromDxf(writeDxf([
      { layer: 'Границы ЗУ', closed: true, points: shift([[0, 0], [200, 0], [200, 150], [0, 150]]) },
      { layer: 'Сети ЛЭП 10кВ', closed: false, points: shift([[0, 100], [200, 100]]) },
    ]), { fileName: 'посадка.dxf' });
    const built = engine.build(site, rulesFrom([lepRule, setback]));
    site.restrictions = built.restrictions;
    const gen = P.generate(site, built.buildable, { areaM2: 900 }, { limit: 40 });
    const variants = V.build(site, gen.candidates, {}).variants;
    return {
      tried: gen.tried,
      total: gen.total,
      shapes: variants.map((v) => v.metrics.shape),
      // пятна сравниваются в локальной системе: абсолютные координаты обязаны отличаться
      local: gen.candidates.slice(0, 6).map((c) => c.footprint.points
        .map(([x, y]) => [Math.round((x - dx) * 100) / 100, Math.round((y - dy) * 100) / 100])),
    };
  };
  const local = run(0, 0);
  const msk = run(2200000, 420000);
  assert.deepStrictEqual(msk.shapes, local.shapes,
    'тот же участок в МСК-47 и в локальной системе обязан давать те же конфигурации');
  assert.strictEqual(msk.tried, local.tried);
  assert.strictEqual(msk.total, local.total);
  assert.deepStrictEqual(msk.local, local.local, 'пятна должны совпадать с точностью до переноса');
});

/* ---------------- базовая геометрия ---------------- */

test('геометрия: пересчёт габаритов переживает мультиполигон', () => {
  const site = G.createSiteGeometry();
  site.restrictions.push(G.makeObject({
    type: 'restriction',
    geometry: {
      type: 'multipolygon',
      polygons: [
        { points: [[0, 0], [10, 0], [10, 10], [0, 10]], holes: [[[2, 2], [4, 2], [4, 4], [2, 4]]] },
        { points: [[50, 50], [60, 50], [60, 60]], holes: [] },
      ],
    },
    provenance: { extractionMethod: 'computed', confidence: 0.9 },
  }));
  assert.deepStrictEqual(G.recomputeBounds(site), { minX: 0, minY: 0, maxX: 60, maxY: 60 });

  // полигон с отверстием тоже не должен ронять расчёт
  const holed = G.createSiteGeometry();
  holed.restrictions.push(G.makeObject({
    type: 'restriction',
    geometry: { type: 'polygon', closed: true, points: [[0, 0], [20, 0], [20, 20], [0, 20]], holes: [[[5, 5], [10, 5], [10, 10], [5, 10]]] },
    provenance: { extractionMethod: 'computed', confidence: 0.9 },
  }));
  assert.deepStrictEqual(G.recomputeBounds(holed), { minX: 0, minY: 0, maxX: 20, maxY: 20 });
});

test('геометрия: вырожденное для JTS отбрасывается, а не роняет расчёт', () => {
  assert.strictEqual(jts.toJts({ type: 'polyline', points: [[0, 0]] }), null, 'линия из одной точки');
  assert.strictEqual(jts.toJts({ type: 'polyline' }), null, 'геометрия без points');
  assert.strictEqual(jts.toJts({ type: 'polyline', points: [] }), null, 'пустой список точек');
  assert.strictEqual(jts.toJts(null), null);

  // нечисловая координата отбрасывается, а не превращается в NaN-площадь
  const line = jts.toJts({ type: 'polyline', points: [[0, 0], [NaN, 5], [10, 10]] });
  assert.ok(line, 'две годные точки — годная линия');
  assert.strictEqual(line.getNumPoints(), 2);
  const poly = jts.toJts({ type: 'polygon', closed: true, points: [[0, 0], [10, 0], [10, 10], [undefined, 3]] });
  assert.ok(poly && Number.isFinite(jts.area(poly)), 'площадь не должна становиться NaN');
});

test('геометрия: слияние предупреждений не плодит дубли', () => {
  const list = [{ code: 'a', message: 'раз' }];
  G.mergeWarnings(list, [{ code: 'a', message: 'раз' }, { code: 'b', message: 'два' }]);
  assert.deepStrictEqual(list.map((w) => w.code), ['a', 'b']);
});

/* ------------------------------------------------------------------------- *
 * Перебор посадки обязан покрывать ВЕСЬ участок. На реальной площадке в
 * Горбунках здание 200 м² помещалось в правой половине участка, а движок
 * упирался в потолок бюджета на левом краю и отвечал «мест нет».
 * ------------------------------------------------------------------------- */

test('посадка: перебор доходит до дальнего края участка, а не упирается в бюджет на ближнем', () => {
  const G = require('../server/services/geometry/site-geometry');
  const P = require('../server/services/geometry/placement-engine');

  // Участок 100×40. Свободна ТОЛЬКО дальняя правая четверть — при переборе
  // подряд бюджет кончался задолго до неё.
  const site = G.createSiteGeometry();
  const parcel = [[0, 0], [100, 0], [100, 40], [0, 40]];
  site.parcel = G.makeObject({
    type: 'parcel', name: 'ЗУ', points: parcel, closed: true,
    provenance: { extractionMethod: 'user', confidence: 1 },
  });
  const corner = [[75, 5], [97, 5], [97, 35], [75, 35]];
  const buildable = { geometry: { type: 'polygon', closed: true, points: corner }, areaM2: 660 };

  const res = P.generate(site, buildable, { areaM2: 300, floors: 1 });
  assert.ok(res.candidates.length > 0, 'посадка в дальнем углу обязана находиться');
  for (const c of res.candidates) {
    assert.ok(c.center[0] > 50, `пятно должно лежать в правой части, а центр ${c.center[0]}`);
  }
  assert.strictEqual(res.errors.length, 0, 'это не ошибка требований');
});

test('посадка: «мест нет» называет числа, а не оставляет гадать', () => {
  const G = require('../server/services/geometry/site-geometry');
  const P = require('../server/services/geometry/placement-engine');
  const site = G.createSiteGeometry();
  const parcel = [[0, 0], [40, 0], [40, 30], [0, 30]];
  site.parcel = G.makeObject({
    type: 'parcel', name: 'ЗУ', points: parcel, closed: true,
    provenance: { extractionMethod: 'user', confidence: 1 },
  });
  const buildable = { geometry: { type: 'polygon', closed: true, points: parcel }, areaM2: 1200 };

  const res = P.generate(site, buildable, { areaM2: 9000, floors: 1 });
  assert.strictEqual(res.candidates.length, 0);
  assert.strictEqual(res.errors.length, 0, 'отсутствие места — не ошибка требований');
  assert.match(res.reason, /9000/, 'сказано, сколько нужно');
  assert.match(res.reason, /1200/, 'сказано, сколько свободно');
  assert.ok(res.warnings.some((w) => w.code === 'placement-empty'), 'есть машиночитаемое предупреждение');
});

/* ================= правки свойств объектов человеком ================= */

/** План с двумя контурами: маленький принят разбором за участок, большой — нет. */
function planWithMisreadParcel() {
  const G = require('../server/services/geometry/site-geometry');
  const site = G.createSiteGeometry();
  const small = G.makeObject({
    type: 'parcel', points: [[0, 0], [8, 0], [8, 9], [0, 9]], closed: true,
    provenance: {
      extractionMethod: 'cad-vector', sourceFile: 'МСК-47.dwg', sourceFileId: 'f1',
      sourceLayer: '10_Границы покрытий и угодий', sourceEntity: 'A1', confidence: 0.6,
    },
  });
  const big = G.makeObject({
    type: 'existingObject', points: [[0, 0], [70, 0], [70, 55], [0, 55]], closed: true,
    provenance: {
      extractionMethod: 'cad-vector', sourceFile: 'МСК-47.dwg', sourceFileId: 'f1',
      sourceLayer: '10_Границы покрытий и угодий', sourceEntity: 'B2', confidence: 0.3,
    },
  });
  site.parcel = small;
  site.existingObjects.push(big);
  return { site, small, big };
}

test('правки объектов: назначенный человеком контур становится границей участка', () => {
  const OE = require('../server/services/geometry/object-edits');
  const { site, small, big } = planWithMisreadParcel();

  const edits = [{ objectKey: OE.keyOf(big, 'existingObjects'), patch: { type: 'parcel', label: 'ЗУ по ГПЗУ' } }];
  const res = OE.applyTo(site, edits);

  assert.strictEqual(res.parcelReplaced, true);
  assert.strictEqual(site.parcel.id, big.id, 'границей стал контур, выбранный человеком');
  assert.strictEqual(site.parcel.properties.areaM2, 3850, 'площадь считается по нему же');
  assert.strictEqual(site.parcel.properties.userLabel, 'ЗУ по ГПЗУ');
  assert.strictEqual(site.parcel.properties.parserType, 'existingObject', 'догадка разбора сохранена, а не затёрта');
  // прежний контур не исчезает: удалять геометрию из-за исправления нельзя
  assert.ok(site.existingObjects.some((o) => o.id === small.id && o.properties.demotedFromParcel));
  assert.ok(site.warnings.some((w) => w.code === 'parcel-user'));
});

test('правки объектов: ключ переживает переразбор чертежа (id меняются, слой и сущность — нет)', () => {
  const OE = require('../server/services/geometry/object-edits');
  const G = require('../server/services/geometry/site-geometry');
  const first = planWithMisreadParcel();
  const key = OE.keyOf(first.big, 'existingObjects');

  // тот же чертёж разобран заново: идентификаторы выданы другие
  const second = planWithMisreadParcel();
  second.big.id = 'existingObject-999';
  assert.notStrictEqual(second.big.id, first.big.id);

  assert.strictEqual(OE.keyOf(second.big, 'existingObjects'), key, 'ключ строится по файлу, слою и сущности');
  const res = OE.applyTo(second.site, [{ objectKey: key, patch: { type: 'parcel' } }]);
  assert.strictEqual(res.applied, 1, 'правка нашла свой объект после переразбора');
  assert.strictEqual(second.site.parcel.id, 'existingObject-999');

  // без provenance ключ падает на слой+id — хуже, но не пусто
  const bare = G.makeObject({
    type: 'existingObject', points: [[0, 0], [1, 0], [1, 1]], closed: true,
    provenance: { extractionMethod: 'computed' },
  });
  assert.match(OE.keyOf(bare, 'existingObjects'), /^o:existingObjects\|/);
});

test('правки объектов: решение о переносе и выгрузка для дообучения', () => {
  const OE = require('../server/services/geometry/object-edits');
  const { db, now } = require('../server/db');
  const SID = `edits-${Math.random().toString(36).slice(2)}`;
  db.prepare('INSERT INTO sessions (id, token, status, created_at, updated_at, title) VALUES (?,?,?,?,?,?)')
    .run(SID, 'tok', 'idle', now(), now(), 'Горбунки');
  const { site, big } = planWithMisreadParcel();

  const saved = OE.save(SID, {
    planId: 'p1', objectId: big.id, layer: 'existingObjects', object: big,
    patch: { type: 'parcel', relocation: 'move', comment: 'переносится по ТУ' }, author: 'Никита',
  });
  assert.strictEqual(saved.patch.relocation, 'move');

  // повторная правка ДОПОЛНЯЕТ прежнюю, а не заводит второй противоречивый пример
  OE.save(SID, { planId: 'p1', objectId: big.id, layer: 'existingObjects', object: big, patch: { label: 'ЗУ по ГПЗУ' } });
  const all = OE.list(SID);
  assert.strictEqual(all.length, 1);
  assert.strictEqual(all[0].patch.type, 'parcel');
  assert.strictEqual(all[0].patch.label, 'ЗУ по ГПЗУ');

  OE.applyTo(site, all);
  assert.strictEqual(site.parcel.properties.relocation, 'move');

  // выгрузка: вход примера — то, что видел разбор, ответ — то, что сказал человек
  const line = JSON.parse(OE.exportJsonl(SID));
  assert.strictEqual(line.parser.sourceLayer, '10_Границы покрытий и угодий');
  assert.strictEqual(line.parser.type, 'existingObject');
  assert.strictEqual(line.parser.confidence, 0.3);
  assert.strictEqual(line.human.type, 'parcel');
  assert.strictEqual(line.project, 'Горбунки');

  // мусор в правку не проходит
  assert.throws(() => OE.normalizePatch({ type: 'chair' }), /Недопустимый тип/);
  assert.throws(() => OE.normalizePatch({ relocation: 'может быть' }), /переносе/);
  assert.throws(() => OE.normalizePatch({}), /пустая/);

  assert.strictEqual(OE.remove(SID, all[0].objectKey), true);
  assert.strictEqual(OE.list(SID).length, 0);
});

test('пометки на плане попадают в контекст анализа, а не остаются на картинке', () => {
  const { db, now } = require('../server/db');
  const memory = require('../server/services/claude/memory');
  const OE = require('../server/services/geometry/object-edits');
  const AN = require('../server/services/geometry/annotations');
  const SID = `notes-${Math.random().toString(36).slice(2)}`;
  db.prepare('INSERT INTO sessions (id, token, status, created_at, updated_at) VALUES (?,?,?,?,?)')
    .run(SID, 'tok', 'idle', now(), now());
  db.prepare('INSERT INTO plans (id, session_id, version, source_hash, geometry, created_at) VALUES (?,?,?,?,?,?)')
    .run('pl-1', SID, 1, 'hash', '{}', String(now()));

  AN.create(SID, {
    planId: 'pl-1', geometryType: 'rect',
    geometry: { points: [[10, 10], [30, 10], [30, 25], [10, 25]] },
    comment: 'Здесь углубление, строить нельзя', author: 'Никита',
  });
  const { big } = planWithMisreadParcel();
  OE.save(SID, {
    planId: 'pl-1', objectId: big.id, layer: 'existingObjects', object: big,
    patch: { type: 'parcel', comment: 'граница по ГПЗУ' },
  });

  const text = memory.planNotesText(SID);
  // где — обязательная часть: «строить нельзя» без координат ни к чему не привязано
  assert.match(text, /Пометки человека на плане/);
  assert.match(text, /X 10…30/);
  assert.match(text, /300 м²/);
  assert.match(text, /Здесь углубление, строить нельзя/);
  // правка объекта: и что человек сказал, и что до этого думал разбор
  assert.match(text, /Исправления объектов плана/);
  assert.match(text, /Границы земельного участка/);
  assert.match(text, /Прочие существующие объекты/);
  assert.match(text, /10_Границы покрытий и угодий/);
  assert.match(text, /ВАЖНЕЕ/, 'модели сказано, чему верить при расхождении');
});

test('правки объектов видит ВЕСЬ расчёт, а не только показ плана', async () => {
  const os = require('os'); const pathMod = require('path'); const crypto = require('crypto');
  const { db, now } = require('../server/db');
  const planSvc = require('../server/services/geometry/plan');
  const OE = require('../server/services/geometry/object-edits');
  const SID = `applyall-${Math.random().toString(36).slice(2)}`;
  db.prepare('INSERT INTO sessions (id, token, status, created_at, updated_at) VALUES (?,?,?,?,?)')
    .run(SID, 'tok', 'idle', now(), now());

  // чертёж: мелкая обводка покрытия (её разбор примет за участок) и настоящий контур
  const dxf = rawDxf([
    ...eLw('10_Границы покрытий и угодий', [[10, 10], [16, 10], [16, 22], [10, 22]], true),
    ...eLw('33_Газопровод', [[0, 0], [90, 0], [90, 70], [0, 70]], true),
  ], { insunits: 6, extent: [0, 0, 200, 160] });
  const dir = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'applyall-'));
  const stored = pathMod.join(dir, 'план.dxf');
  fs.writeFileSync(stored, dxf);
  db.prepare('INSERT INTO files (id, session_id, original_name, stored_path, size, ext, mime, created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(crypto.randomUUID(), SID, 'план.dxf', stored, fs.statSync(stored).size, 'dxf', '', now());

  const before = await planSvc.ensurePlan(SID);
  assert.strictEqual(before.site.parcel.properties.areaM2, 72, 'разбор принял за участок обводку покрытия');
  const real = before.site.utilities.find((o) => o.provenance.sourceLayer === '33_Газопровод');
  assert.ok(real, 'настоящий контур разобран как сеть — ровно случай из проекта');

  OE.save(SID, {
    planId: before.planId, objectId: real.id, layer: 'utilities', object: real,
    patch: { type: 'parcel', label: 'ЗУ по ГПЗУ' },
  });

  // ГЛАВНОЕ: правку видит ensurePlan, а значит и пересчёт ограничений, и посадка,
  // и выгрузка, и анализ — все они строят план через него
  const after = await planSvc.ensurePlan(SID);
  assert.strictEqual(after.site.parcel.properties.areaM2, 6300, 'границей стал контур, назначенный человеком');
  assert.strictEqual(after.site.parcel.properties.userLabel, 'ЗУ по ГПЗУ');
  assert.ok(after.site.warnings.some((w) => w.code === 'parcel-user'));

  // а снимок для обучающего примера по-прежнему берётся с чистого разбора
  const raw = await planSvc.ensurePlan(SID, { raw: true });
  assert.strictEqual(raw.site.parcel.properties.areaM2, 72, 'raw обязан отдавать догадку разбора');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('правки объектов: контур с несомкнутыми на 5 см концами становится полигоном с площадью', () => {
  const OE = require('../server/services/geometry/object-edits');
  const G = require('../server/services/geometry/site-geometry');
  const site = G.createSiteGeometry();
  // настоящий случай Горбунков: контур участка лежит на слое газопровода,
  // разобран ломаной, а его концы разошлись на 5 см при длине 280 м
  const ring = [[0, 0], [70, 0], [70, 55], [0, 55], [0.03, 0.04]];
  const line = G.makeObject({
    type: 'utility', points: ring, closed: false,
    provenance: {
      extractionMethod: 'cad-vector', sourceFile: 'МСК-47.dwg', sourceFileId: 'f1',
      sourceLayer: '33_Газопровод', sourceEntity: 'D9', confidence: 0.8,
    },
  });
  site.utilities.push(line);

  OE.applyTo(site, [{ objectKey: OE.keyOf(line, 'utilities'), patch: { type: 'parcel' } }]);

  assert.ok(site.parcel, 'назначенный участком контур обязан стать участком');
  assert.strictEqual(site.parcel.geometry.type, 'polygon', 'ломаная-кольцо пересобирается в полигон');
  assert.strictEqual(site.parcel.properties.areaM2, 3850, 'у участка обязана быть площадь: на ней стоят ТЭП, зоны и посадка');
  assert.strictEqual(site.parcel.properties.vertices, 4, 'хвостовая точка в 5 см от первой отброшена');
  assert.strictEqual(site.parcel.properties.lengthM, undefined, 'длина ломаной у полигона не остаётся');

  // а вот ОТКРЫТУЮ линию замыкать нельзя — площадь была бы выдумана
  const open = G.makeObject({
    type: 'utility', points: [[0, 0], [50, 0], [50, 30]], closed: false,
    provenance: { extractionMethod: 'cad-vector', sourceFile: 'МСК-47.dwg', sourceFileId: 'f1', sourceLayer: '33_Газопровод', sourceEntity: 'D10', confidence: 0.8 },
  });
  const site2 = G.createSiteGeometry();
  site2.utilities.push(open);
  OE.applyTo(site2, [{ objectKey: OE.keyOf(open, 'utilities'), patch: { type: 'parcel' } }]);
  assert.strictEqual(site2.parcel.geometry.type, 'polyline', 'открытая линия полигоном не притворяется');
  assert.strictEqual(site2.parcel.properties.areaM2, undefined, 'площадь не выдумывается');
});

test('требования: общая площадь здания не выдаётся за площадь застройки', () => {
  const { db, now } = require('../server/db');
  const stages = require('../server/services/stages');
  const mk = (facts) => {
    const SID = `req-${Math.random().toString(36).slice(2)}`;
    db.prepare('INSERT INTO sessions (id, token, status, created_at, updated_at) VALUES (?,?,?,?,?)')
      .run(SID, 'tok', 'idle', now(), now());
    for (const [k, v] of facts) {
      db.prepare('INSERT INTO facts (id, session_id, key, value, source, created_at) VALUES (?,?,?,?,?,?)')
        .run(`${SID}-${k}`, SID, k, String(v), 'тест', now());
    }
    return SID;
  };

  // Настоящий случай Горбунков: в фактах только ОБЩАЯ площадь и этажность.
  // Прежнее правило брало 3580 м² как пятно застройки — 97 % участка в 3700 м²,
  // и посадка честно не находилась ни в одном положении.
  const a = stages.requirementsFromFacts(mk([['object.total_area_m2', 'Не более 3580'], ['object.floors', 2]]));
  assert.strictEqual(a.areaM2, 1790, 'пятно = общая площадь ÷ этажность');
  assert.strictEqual(a.floors, 2);
  assert.match(a.assumption, /3580/, 'допущение проговаривается, а не прячется');
  assert.ok(a.sources.some((s) => /÷ 2 эт/.test(s)), 'допущение видно в источниках требования');

  // Явно заданное пятно застройки побеждает общую площадь
  const b = stages.requirementsFromFacts(mk([
    ['object.total_area_m2', 3580], ['object.floors', 2], ['object.building_footprint', 'Площадь застройки 1200'],
  ]));
  assert.strictEqual(b.areaM2, 1200);
  assert.strictEqual(b.assumption, undefined, 'делить было не нужно — допущения нет');

  // Общая площадь без этажности пятном не становится: делить не на что,
  // а выдумывать этажность нельзя — платформа обязана спросить
  const c = stages.requirementsFromFacts(mk([['object.total_area_m2', 3580]]));
  assert.strictEqual(c, null, 'без этажности требование не собирается');
});

test('посадка: на треугольной площадке пятно находится, а не объявляется невозможным', () => {
  const G = require('../server/services/geometry/site-geometry');
  const P = require('../server/services/geometry/placement-engine');
  // Треугольник, повёрнутый относительно осей — форма реальной площадки
  // в Горбунках. Прямоугольник в него не вписывается (у треугольника предел
  // ~50 % площади), а вписанный треугольник — вписывается, но только вдоль
  // СВОИХ сторон: по осям и по сторонам участка ни одно положение не ловилось.
  const tri = [[0, 0], [96, 22], [30, 78]];
  const site = G.createSiteGeometry();
  site.parcel = G.makeObject({
    type: 'parcel', points: [[-5, -5], [105, -5], [105, 85], [-5, 85]], closed: true,
    provenance: { extractionMethod: 'user', confidence: 1 },
  });
  const buildable = {
    geometry: { type: 'polygon', closed: true, points: tri },
    areaM2: Math.round(G.polygonArea(tri)),
  };
  assert.ok(buildable.areaM2 > 2800 && buildable.areaM2 < 3600, `площадь площадки ${buildable.areaM2}`);
  // 1790 м² — 52 % треугольника: прямоугольником в него не вписаться
  // (у треугольника предел вписанного прямоугольника ~50 % площади)

  const res = P.generate(site, buildable, { areaM2: 1790, floors: 2, allowReshape: true, allowRotate: true });
  assert.ok(res.candidates.length > 0,
    `посадка обязана найтись: ${buildable.areaM2} м² свободно под 1790 м² застройки. Причина отказа: ${res.reason || '—'}`);
  const top = res.candidates[0];
  assert.ok(top.areaM2 >= 1700, `площадь пятна ${top.areaM2} м² — не должна съезжать от требуемой`);
  assert.strictEqual(top.violations.length, 0, 'найденное пятно обязано быть без нарушений');

  // угол берётся от стороны САМОЙ площадки, а не от осей участка
  const edges = [];
  for (let i = 0; i < tri.length; i++) {
    const [x1, y1] = tri[i]; const [x2, y2] = tri[(i + 1) % tri.length];
    let a = ((Math.atan2(y2 - y1, x2 - x1) * 180) / Math.PI) % 180;
    if (a < 0) a += 180;
    edges.push(Math.round(a));
  }
  assert.ok(edges.some((a) => Math.abs(a - top.rotationDeg) < 2),
    `поворот ${top.rotationDeg}° обязан совпасть с одной из сторон площадки (${edges.join(', ')})`);
});
