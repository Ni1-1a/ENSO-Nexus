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

  /*
   * Уточнение «ЛЭП 10 кВ» не совпало ни с одним слоем чертежа (там водопровод).
   * Прежде движок строил зону ОТ ВСЕГО ТИПА — от всех сетей участка разом. На
   * боевом прогоне 2026-08-12 это раздуло охранную зону с 1068 до 2788 м² и
   * убило посадку по правилу, которое к этим сетям не относится. Правило,
   * объект отсчёта которого не опознан, применять не к чему.
   */
  const res = engine.build(site, rulesFrom([lepRule]));
  assert.strictEqual(res.restrictions.length, 0, 'зона от чужих объектов не строится');
  assert.strictEqual(res.unresolved.length, 1, 'потеря не молчаливая — правило в unresolved');
  assert.match(res.unresolved[0].reason, /ЛЭП 10 кВ/, 'сказано, какое уточнение не совпало');
  assert.match(res.unresolved[0].reason, /ВОДОПРОВОД/, 'и какие слои на участке есть');
  // допустимой территорией остаётся весь участок — и это помечено как подозрительное
  assert.ok(res.warnings.some((w) => w.code === 'no-restrictions'));
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
  // payload уезжает в поток структурным клонированием, и всё, что движок дописал
  // в свою копию site, умирает вместе с потоком — наружу это обязано вернуться
  assert.ok(res.warnings.some((w) => w.code === 'no-restrictions'),
    `предупреждения не вернулись из потока: ${JSON.stringify(res.warnings)}`);
  assert.strictEqual(res.unresolved.length, 1, 'причина непостроенной зоны переживает поток');
  assert.match(res.unresolved[0].reason, /не совпало ни с одним слоем/);
});

test('движок: нулевая площадь участка не превращается в NaN', () => {
  const site = cadGeom.fromDxf(writeDxf([
    { layer: 'Границы ЗУ', closed: true, points: [[0, 0], [50, 0], [100, 0]] },
  ]), { fileName: 'вырожденный.dxf' });
  // правило БЕЗ уточнения: проверяем вырожденный участок, а не подбор объекта
  const res = engine.build(site, rulesFrom([{ ...lepRule, targetHint: '' }]));

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
  // здесь уточнение СОВПАДАЕТ со слоем «Сети ЛЭП 10кВ» — зона строится
  const good = engine.build(ok, rulesFrom([{ ...lepRule, targetHint: 'ЛЭП 10кВ' }]));
  assert.strictEqual(good.restrictions.length, 1, 'совпавшее уточнение обязано дать зону');
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

  assert.strictEqual(OE.keyOf(second.big, 'existingObjects'), key, 'ключ строится по файлу, слою и отпечатку геометрии');
  const res = OE.applyTo(second.site, [{ objectKey: key, patch: { type: 'parcel' } }]);
  assert.strictEqual(res.applied, 1, 'правка нашла свой объект после переразбора');
  assert.strictEqual(second.site.parcel.id, 'existingObject-999');

  // без provenance ключ держится на одном отпечатке геометрии — и этого хватает
  const bare = G.makeObject({
    type: 'existingObject', points: [[0, 0], [1, 0], [1, 1]], closed: true,
    provenance: { extractionMethod: 'computed' },
  });
  assert.match(OE.keyOf(bare, 'existingObjects'), /^g:\|\|#/);
});

test('правки объектов: правка одного здания не расползается на однотипные соседние', () => {
  const OE = require('../server/services/geometry/object-edits');
  const G = require('../server/services/geometry/site-geometry');
  // Тридцать три здания одного слоя, снятые одинаковой сущностью, — ровно случай
  // «МСК-47_Горбунки»: прежний ключ (файл|слой|сущность) был у них общий, и пометка
  // одного здания сносимым помечала весь чертёж.
  const site = G.createSiteGeometry();
  const houses = [];
  for (let i = 0; i < 33; i++) {
    const x = i * 20;
    const o = G.makeObject({
      type: 'building', points: [[x, 0], [x + 10, 0], [x + 10, 12], [x, 12]], closed: true,
      provenance: {
        extractionMethod: 'cad-vector', sourceFile: 'МСК-47_Горбунки.dwg', sourceFileId: 'f1',
        sourceLayer: '03_Здания и строения', sourceEntity: 'замкнутая полилиния', confidence: 0.8,
      },
    });
    site.buildings.push(o);
    houses.push(o);
  }
  const keys = new Set(houses.map((o) => OE.keyOf(o, 'buildings')));
  assert.strictEqual(keys.size, 33, 'у каждого контура свой ключ');
  const legacy = new Set(houses.map((o) => OE.legacyKeyOf(o, 'buildings')));
  assert.strictEqual(legacy.size, 1, 'прежний ключ был один на всех — это и был дефект');

  const res = OE.applyTo(site, [{ objectKey: OE.keyOf(houses[7], 'buildings'), patch: { relocation: 'move', comment: 'демонтаж' } }]);
  assert.strictEqual(res.applied, 1, 'правка применилась ровно к одному зданию');
  assert.strictEqual(site.buildings[7].properties.relocation, 'move');
  assert.strictEqual(site.buildings.filter((o) => o.properties.relocation === 'move').length, 1,
    'у остальных тридцати двух статус не изменился');
});

test('правки объектов: правка прежнего образца не применяется, если её ключ неоднозначен', () => {
  const OE = require('../server/services/geometry/object-edits');
  const G = require('../server/services/geometry/site-geometry');
  const site = G.createSiteGeometry();
  const mk = (x) => G.makeObject({
    type: 'building', points: [[x, 0], [x + 10, 0], [x + 10, 10], [x, 10]], closed: true,
    provenance: {
      extractionMethod: 'cad-vector', sourceFile: 'т.dwg', sourceFileId: 'f1',
      sourceLayer: '03_Здания и строения', sourceEntity: 'замкнутая полилиния', confidence: 0.8,
    },
  });
  const a = mk(0); const b = mk(50);
  site.buildings.push(a, b);

  const res = OE.applyTo(site, [{ objectKey: OE.legacyKeyOf(a, 'buildings'), patch: { relocation: 'move' } }]);
  assert.strictEqual(res.applied, 0, 'неоднозначная старая правка не применяется ни к одному объекту');
  assert.ok(res.legacySkipped >= 1);
  assert.ok(site.warnings.some((w) => w.code === 'edits-legacy-ambiguous'), 'человеку сказано, что правку надо переставить');

  // единственный объект с таким ключом — старую правку применяем, ничего не теряя
  const solo = G.createSiteGeometry();
  const only = mk(0);
  solo.buildings.push(only);
  const res2 = OE.applyTo(solo, [{ objectKey: OE.legacyKeyOf(only, 'buildings'), patch: { relocation: 'keep' } }]);
  assert.strictEqual(res2.applied, 1);
  assert.strictEqual(solo.buildings[0].properties.relocation, 'keep');
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
  assert.throws(() => OE.normalizePatch({ relocation: 'может быть' }), /Недопустимое решение/);
  // снос — отдельное решение, а не «перенос» с припиской в комментарии:
  // снесённое здание не даёт противопожарных разрывов, перенесённое требует мероприятия
  assert.deepStrictEqual(OE.normalizePatch({ relocation: 'demolish' }), { relocation: 'demolish' });
  assert.strictEqual(OE.RELOCATION_LABELS.demolish, 'сносится (демонтаж)');
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

/* ================= границы участка по координатам из документа ================= */

/**
 * Настоящие числа с первой страницы «ГПЗУ.pdf» проекта в Горбунках.
 * Колонка «X» — 422 xxx (север), колонка «Y» — 2195 xxx (восток);
 * в чертеже те же числа стоят наоборот. Площадь по документу — 3700 +/- 43 м².
 */
const GPZU_POINTS = [
  { label: '1', first: 422352.83, second: 2195897.76 },
  { label: '2', first: 422308.62, second: 2195954.01 },
  { label: '3', first: 422286.62, second: 2195973.10 },
  { label: '4', first: 422288.36, second: 2195974.18 },
  { label: '5', first: 422322.63, second: 2195984.16 },
  { label: '6', first: 422369.92, second: 2195992.21 },
];
const GPZU_META = {
  declaredAreaM2: 3700, areaToleranceM2: 43, cadastralNumber: '47:14:0402001:7',
  coordinateSystem: 'МСК-47', firstColumnMeans: 'X',
  sourceDocument: 'ГПЗУ.pdf', sourcePage: 'стр. 1', confidence: 0.95,
};

/** Габариты настоящей топосъёмки МСК-47_Горбунки. */
const TOPO_BOUNDS = { minX: 2195874.16, minY: 422259.47, maxX: 2196005.6, maxY: 422387.49 };

test('границы ЗУ из документа: полигон по поворотным точкам сходится с заявленной площадью', () => {
  const PS = require('../server/services/geometry/parcel-source');
  const site = require('../server/services/geometry/site-geometry').createSiteGeometry();
  site.drawingBounds = { ...TOPO_BOUNDS };

  const built = PS.build({ points: GPZU_POINTS, meta: GPZU_META }, site);
  assert.strictEqual(built.ok, true, `сборка обязана удаться: ${built.errors.join(' ')}`);
  assert.strictEqual(built.points.length, 6);
  assert.ok(Math.abs(built.areaM2 - 3700) <= 43,
    `площадь ${built.areaM2} м² обязана уложиться в 3700 +/- 43 м² по ГПЗУ`);
  assert.match(built.report.areaCheck, /^сходится/);
  assert.strictEqual(built.errors.length, 0);
});

test('границы ЗУ из документа: порядок осей определяется по чертежу, а не по вере', () => {
  const PS = require('../server/services/geometry/parcel-source');
  const site = require('../server/services/geometry/site-geometry').createSiteGeometry();
  site.drawingBounds = { ...TOPO_BOUNDS };

  // ЕГРН пишет X на север, чертёж — X по горизонтали: колонки обязаны переставиться
  const asIs = PS.build({ points: GPZU_POINTS, meta: GPZU_META }, site);
  assert.strictEqual(asIs.orientation, 'swapped');
  for (const [x, y] of asIs.points) {
    assert.ok(x >= TOPO_BOUNDS.minX && x <= TOPO_BOUNDS.maxX, `X ${x} обязан лежать в габаритах чертежа`);
    assert.ok(y >= TOPO_BOUNDS.minY && y <= TOPO_BOUNDS.maxY, `Y ${y} обязан лежать в габаритах чертежа`);
  }

  // тот же участок с колонками, набранными наоборот, обязан лечь ТУДА ЖЕ
  const flipped = GPZU_POINTS.map((p) => ({ label: p.label, first: p.second, second: p.first }));
  const other = PS.build({ points: flipped, meta: { ...GPZU_META, firstColumnMeans: 'Y' } }, site);
  assert.strictEqual(other.orientation, 'direct');
  assert.deepStrictEqual(other.points, asIs.points, 'положение участка не зависит от порядка колонок в документе');
});

test('границы ЗУ из документа: расхождение с заявленной площадью — отказ, а не молчаливая подстановка', () => {
  const PS = require('../server/services/geometry/parcel-source');
  const site = require('../server/services/geometry/site-geometry').createSiteGeometry();
  site.drawingBounds = { ...TOPO_BOUNDS };

  // одна цифра прочитана неверно — контур перестаёт быть тем участком
  const broken = GPZU_POINTS.map((p, i) => (i === 2 ? { ...p, first: p.first - 30 } : p));
  const built = PS.build({ points: broken, meta: GPZU_META }, site);
  assert.strictEqual(built.ok, false, 'по неверно прочитанным координатам граница не строится');
  assert.match(built.errors.join(' '), /расходится с заявленной/);
});

test('границы ЗУ из документа: подменяют разобранный контур, но не уничтожают его', async () => {
  const PS = require('../server/services/geometry/parcel-source');
  const G = require('../server/services/geometry/site-geometry');
  const { db, now } = require('../server/db');
  const SID = `parcelsrc-${Math.random().toString(36).slice(2)}`;
  db.prepare('INSERT INTO sessions (id, token, status, created_at, updated_at, title) VALUES (?,?,?,?,?,?)')
    .run(SID, 'tok', 'idle', now(), now(), 'Горбунки');

  const site = G.createSiteGeometry();
  site.drawingBounds = { ...TOPO_BOUNDS };
  // ровно то, что разбор берёт за участок на настоящей топосъёмке: покрытие 72 м²
  site.parcel = G.makeObject({
    type: 'parcel', closed: true,
    points: [[2195900, 422300], [2195908, 422300], [2195908, 422309], [2195900, 422309]],
    provenance: {
      extractionMethod: 'cad-vector', sourceFile: 'МСК-47_Горбунки.dwg', sourceFileId: 'f1',
      sourceLayer: '10_Границы покрытий и угодий', sourceEntity: 'замкнутая полилиния',
      confidence: 0.6, reason: 'слой назван границей (без уточнения)',
    },
  });
  site.warnings.push({ code: 'parcel-doubtful', message: 'контур занимает 0.2% площади чертежа' });
  const wrongId = site.parcel.id;

  PS.save(SID, { points: GPZU_POINTS, meta: GPZU_META });
  const res = PS.applyTo(SID, site);

  assert.strictEqual(res.applied, true);
  assert.ok(Math.abs(site.parcel.properties.areaM2 - 3700) <= 43, 'участком стал контур по ГПЗУ');
  assert.strictEqual(site.parcel.provenance.extractionMethod, 'document-stated');
  assert.strictEqual(site.parcel.properties.cadastralNumber, '47:14:0402001:7');
  assert.ok(site.existingObjects.some((o) => o.id === wrongId && o.properties.demotedFromParcel),
    'прежний контур сохранён в плане, а не выброшен');
  assert.ok(!site.warnings.some((w) => w.code === 'parcel-doubtful'),
    'предупреждение о ненадёжном контуре снято: граница больше не из чертежа');
  assert.ok(site.warnings.some((w) => w.code === 'parcel-from-document'),
    'откуда взялась граница — сказано вслух');

  assert.strictEqual(PS.remove(SID), true);
});

test('границы ЗУ из документа: правка человека сильнее документа', () => {
  const PS = require('../server/services/geometry/parcel-source');
  assert.strictEqual(typeof PS.drawingParcelIsDoubtful, 'function');
  const G = require('../server/services/geometry/site-geometry');
  const site = G.createSiteGeometry();
  assert.strictEqual(PS.drawingParcelIsDoubtful(site), true, 'участка нет — документ нужен');
  site.parcel = G.makeObject({
    type: 'parcel', points: [[0, 0], [60, 0], [60, 60], [0, 60]], closed: true,
    provenance: {
      extractionMethod: 'cad-vector', sourceFile: 'a.dwg', sourceLayer: 'Границы ЗУ',
      sourceEntity: 'замкнутая полилиния', confidence: 0.85,
    },
  });
  assert.strictEqual(PS.drawingParcelIsDoubtful(site), false, 'уверенно распознанный контур документа не требует');
});

/* ================= «посадки нет» → что именно сделать ================= */

test('посадка: отказ несёт посчитанные мероприятия, а не три глагола без чисел', () => {
  const G = require('../server/services/geometry/site-geometry');
  const RE = require('../server/services/geometry/restriction-engine');
  const RR = require('../server/services/geometry/restriction-rules');
  const P = require('../server/services/geometry/placement-engine');

  // прямоугольный участок 100 × 40 = 4000 м² и ЛЭП вдоль длинной стороны
  const site = G.createSiteGeometry();
  site.parcel = G.makeObject({
    type: 'parcel', points: [[0, 0], [100, 0], [100, 40], [0, 40]], closed: true,
    provenance: {
      extractionMethod: 'cad-vector', sourceFile: 'т.dwg', sourceLayer: 'Границы ЗУ',
      sourceEntity: 'замкнутая полилиния', confidence: 0.85,
    },
  });
  site.utilities.push(G.makeObject({
    type: 'utility', points: [[0, 34], [100, 34]], closed: false,
    provenance: {
      extractionMethod: 'cad-vector', sourceFile: 'т.dwg', sourceLayer: 'ЛЭП 10 кВ',
      sourceEntity: 'полилиния', confidence: 0.8,
    },
  }));
  const rules = [
    { kind: 'protectionZone', operation: 'bufferOutward', targetSelector: 'utility', targetHint: 'ЛЭП',
      value: 10, unit: 'м', basis: 'ПП РФ № 160, п. 8', sourceDocument: 'НТД', confidence: 0.9 },
  ].map((r, i) => RR.normalizeRule(r, i).rule).filter(Boolean);
  const built = RE.build(site, rules);
  site.restrictions = built.restrictions;
  site.buildable = built.buildable;

  // двухэтажное здание с пятном 2600 м²: свободного места меньше
  const res = P.generate(site, site.buildable, { areaM2: 2600, floors: 2, allowReshape: true, allowRotate: true });
  assert.strictEqual(res.candidates.length, 0);
  assert.ok(res.relief, 'отказ обязан нести разбор мероприятий');

  const kinds = res.relief.measures.map((m) => m.kind);
  assert.ok(kinds.includes('floors'), 'этажность обязана быть посчитана, а не предложена словом');
  assert.ok(kinds.includes('restriction'), 'снятие ограничения обязано быть в списке');

  const floors = res.relief.measures.find((m) => m.kind === 'floors');
  assert.ok(floors.to > floors.from, 'этажей должно стать больше');
  // общая площадь сохраняется: 2600 × 2 этажа = 5200 м², их и раскладываем
  assert.strictEqual(floors.totalM2, 5200);
  assert.ok(Math.abs(floors.footprintM2 - 5200 / floors.to) < 0.02, 'пятно = общая площадь ÷ новую этажность');
  assert.ok(floors.footprintM2 <= res.relief.availableM2, 'предложенное пятно обязано помещаться');

  const zone = res.relief.measures.find((m) => m.kind === 'restriction');
  assert.ok(zone.gainM2 > 0, 'сказано, сколько метров вернёт снятие зоны');
  assert.strictEqual(zone.afterM2, Math.round((res.relief.availableM2 + zone.gainM2) * 100) / 100);
  assert.match(zone.text, /выносом сети/, 'сказано, ЧЕМ снимается охранная зона, а не только что её можно снять');

  // текст для человека собирается из тех же чисел
  assert.match(res.reason, /Что можно сделать/);
  assert.match(res.reason, new RegExp(String(floors.to)));
});

test('посадка: снятие зоны оценивается по приросту территории, а не по её собственной площади', () => {
  const G = require('../server/services/geometry/site-geometry');
  const relief = require('../server/services/geometry/placement-relief');

  const parcel = { type: 'polygon', closed: true, points: [[0, 0], [100, 0], [100, 100], [0, 100]] };
  const mk = (pts, kind, id) => ({
    id, type: 'restriction',
    geometry: { type: 'polygon', closed: true, points: pts },
    properties: { kind, valueM: 10, targets: [{ id: 'u1', layer: 'ЛЭП 10 кВ' }] },
    provenance: { basis: 'ПП РФ № 160' },
  });
  // большая зона и маленькая ЦЕЛИКОМ ВНУТРИ неё: снятие маленькой не даёт ничего
  const big = mk([[0, 0], [60, 0], [60, 100], [0, 100]], 'protectionZone', 'z-big');
  const inner = mk([[10, 10], [30, 10], [30, 30], [10, 30]], 'fireBreak', 'z-inner');

  const gains = relief.gainsByZone(parcel, [big, inner]);
  const byId = Object.fromEntries(gains.map((g) => [g.zoneId, g]));
  assert.ok(byId['z-big'], 'внешняя зона освобождает территорию');
  // 60 × 100 = 6000 м² собственной площади, но 20 × 20 = 400 м² внутри неё
  // по-прежнему заняты противопожарным разрывом. Освободится 5600, и обещать
  // человеку 6000 нельзя: он планирует посадку по этому числу.
  assert.ok(Math.abs(byId['z-big'].gainM2 - 5600) < 1,
    `прирост обязан быть 5600 м², а не 6000 м² собственной площади зоны; получено ${byId['z-big'].gainM2}`);
  assert.strictEqual(byId['z-inner'], undefined,
    'зона, спрятанная внутри другой, при снятии не даёт ни метра — обещать её площадь нельзя');
});

test('ограничения: от объекта под снос разрывы не считаются — решение доходит до геометрии', () => {
  const G = require('../server/services/geometry/site-geometry');
  const RE = require('../server/services/geometry/restriction-engine');
  const RR = require('../server/services/geometry/restriction-rules');

  const mkSite = (relocation) => {
    const site = G.createSiteGeometry();
    site.parcel = G.makeObject({
      type: 'parcel', points: [[0, 0], [100, 0], [100, 100], [0, 100]], closed: true,
      provenance: {
        extractionMethod: 'cad-vector', sourceFile: 'т.dwg', sourceLayer: 'Границы ЗУ',
        sourceEntity: 'замкнутая полилиния', confidence: 0.85,
      },
    });
    const shed = G.makeObject({
      type: 'building', points: [[40, 40], [60, 40], [60, 60], [40, 60]], closed: true,
      provenance: {
        extractionMethod: 'cad-vector', sourceFile: 'т.dwg', sourceLayer: '03_Здания и строения',
        sourceEntity: 'замкнутая полилиния', confidence: 0.8,
      },
    });
    if (relocation) shed.properties = { ...shed.properties, relocation };
    site.buildings.push(shed);
    return site;
  };
  const rules = [{
    kind: 'fireBreak', operation: 'bufferOutward', targetSelector: 'building', targetHint: '',
    value: 12, unit: 'м', basis: 'СП 4.13130, табл. 3', sourceDocument: 'НТД',
    sourceClause: 'табл. 3', quote: '12 м', confidence: 0.9,
  }].map((r, i) => RR.normalizeRule(r, i).rule).filter(Boolean);

  const kept = RE.build(mkSite('keep'), rules);
  assert.strictEqual(kept.restrictions.length, 1, 'сохраняемое здание даёт противопожарный разрыв');

  const gone = RE.build(mkSite('demolish'), rules);
  assert.strictEqual(gone.restrictions.length, 0,
    'от здания, которого не будет, разрыв не нормируется — иначе снос не освобождает место');
  assert.ok(gone.buildable.areaM2 > kept.buildable.areaM2,
    `снос обязан увеличить допустимую территорию: было ${kept.buildable.areaM2}, стало ${gone.buildable.areaM2}`);
  assert.ok(gone.warnings.some((w) => w.code === 'objects-excluded'),
    'исключение объектов проговаривается вслух — иначе пропавший разрыв необъясним');

  // «не решено» — не повод считать объект снесённым
  const undecided = RE.build(mkSite('undecided'), rules);
  assert.strictEqual(undecided.restrictions.length, 1, 'пока решения нет, объект считается существующим');
});

test('посадка: нереальная этажность не предлагается как мероприятие', () => {
  const relief = require('../server/services/geometry/placement-relief');
  // 1790 м² в два этажа при 250 м² свободных требуют пятнадцати этажей —
  // для производственного корпуса это не решение, и предлагать его нечестно
  const absurd = relief.floorsMeasure(1790, 2, 250);
  assert.strictEqual(absurd.unreasonable, true);
  assert.match(absurd.text, /Одной этажностью задача не решается/);
  assert.ok(!/Поднять этажность/.test(absurd.text), 'совета «поднять до 15 этажей» быть не должно');

  // а три этажа вместо двух — нормальное мероприятие
  const sane = relief.floorsMeasure(1790, 2, 1739);
  assert.strictEqual(sane.to, 3);
  assert.ok(!sane.unreasonable);
  assert.match(sane.text, /Поднять этажность с 2 до 3/);
});

test('ограничения: зона на весь участок не обнуляет допустимую территорию молча', () => {
  const G = require('../server/services/geometry/site-geometry');
  const RE = require('../server/services/geometry/restriction-engine');
  const RR = require('../server/services/geometry/restriction-rules');

  const site = G.createSiteGeometry();
  site.parcel = G.makeObject({
    type: 'parcel', points: [[0, 0], [100, 0], [100, 100], [0, 100]], closed: true,
    provenance: {
      extractionMethod: 'cad-vector', sourceFile: 'т.dwg', sourceLayer: 'Границы ЗУ',
      sourceEntity: 'замкнутая полилиния', confidence: 0.85,
    },
  });
  // СЗЗ 500 м от границы участка накрывает его целиком — так на Горбунках и вышло
  // (plot.zone_sanitary_protection = 3700 при участке 3700 м²)
  const rules = [{
    kind: 'sanitaryZone', operation: 'bufferOutward', targetSelector: 'parcelBoundary', targetHint: '',
    value: 500, unit: 'м', basis: 'СанПиН 2.2.1/2.1.1.1200-03', sourceDocument: 'ГПЗУ.pdf',
    sourceClause: 'разд. 4', quote: 'СЗЗ', confidence: 0.9,
  }].map((r, i) => RR.normalizeRule(r, i).rule).filter(Boolean);

  const built = RE.build(site, rules);
  assert.strictEqual(built.restrictions.length, 1, 'зона строится и остаётся на плане');
  assert.strictEqual(built.restrictions[0].properties.wholeParcel, true, 'помечена как накрывающая участок');
  assert.ok(built.buildable.areaM2 > 9000,
    `территория не должна обнуляться: получено ${built.buildable.areaM2} м² из 10000`);
  assert.ok(built.warnings.some((w) => w.code === 'zone-covers-parcel'),
    'решение проговаривается вслух — молча вычесть или молча не вычесть одинаково недопустимо');
});

test('ограничения: пустой список зон не выглядит успешным расчётом', () => {
  const G = require('../server/services/geometry/site-geometry');
  const RE = require('../server/services/geometry/restriction-engine');

  const site = G.createSiteGeometry();
  site.parcel = G.makeObject({
    type: 'parcel', points: [[0, 0], [100, 0], [100, 100], [0, 100]], closed: true,
    provenance: {
      extractionMethod: 'document-stated', sourceFile: 'ГПЗУ.pdf',
      sourceEntity: 'таблица координат', confidence: 0.9,
    },
  });

  // модель не отдала ни одного правила — на боевом прогоне так и было
  const built = RE.build(site, []);
  assert.strictEqual(built.restrictions.length, 0);
  assert.strictEqual(built.buildable.areaM2, 10000, 'территория считается, но она равна всему участку');
  assert.ok(built.warnings.some((w) => w.code === 'no-restrictions'),
    'пустой список ограничений обязан выглядеть подозрительно: иначе здание сядет на участок, '
    + 'где по документам семь охранных зон');
});

test('ограничения: отступ по ГПЗУ выводится из факта без модели', () => {
  const RE = require('../server/services/geometry/restriction-extract');
  const RR = require('../server/services/geometry/restriction-rules');
  const G = require('../server/services/geometry/site-geometry');
  const ENG = require('../server/services/geometry/restriction-engine');

  // факты ровно из боевого прогона на Горбунках
  const facts = [
    { key: 'plot.setback_m', value: '3 м', source: 'ГПЗУ.pdf' },
    { key: 'plot.max_height_m', value: '20 м', source: 'ГПЗУ.pdf' },
    { key: 'plot.max_occupancy_percent', value: '80%', source: 'ГПЗУ.pdf' },
    { key: 'object.area_m2', value: 'не более 3580 м²', source: 'ТЗ' },
  ];
  const raw = RE.rawRulesFromFacts(facts);
  assert.strictEqual(raw.length, 1, 'выводится только однозначное: отступ, а не высота и не процент');
  // выведенное складывается с найденным моделью, не задваивая одинаковое
  const asRule = RR.normalizeRule(raw[0], 0).rule;
  assert.strictEqual(RE.mergeRules([], [asRule]).length, 1);
  assert.strictEqual(RE.mergeRules([asRule], [asRule]).length, 1,
    'тот же отступ из двух источников — одна зона, а не две поверх друг друга');
  assert.strictEqual(raw[0].kind, 'setback');
  assert.strictEqual(raw[0].value, 3);
  assert.strictEqual(raw[0].operation, 'bufferInward');

  // правило проходит те же проверки, что и извлечённое моделью, и строит зону
  const rule = RR.normalizeRule(raw[0], 0).rule;
  assert.ok(rule, 'выведенное правило обязано проходить нормализацию');

  const site = G.createSiteGeometry();
  site.parcel = G.makeObject({
    type: 'parcel', points: [[0, 0], [100, 0], [100, 100], [0, 100]], closed: true,
    provenance: {
      extractionMethod: 'document-stated', sourceFile: 'ГПЗУ.pdf',
      sourceEntity: 'таблица координат', confidence: 0.9,
    },
  });
  const built = ENG.build(site, [rule]);
  assert.strictEqual(built.restrictions.length, 1);
  // отступ 3 м по периметру квадрата 100×100 срезает 100² − 94² = 1164 м²
  assert.ok(Math.abs(built.buildable.areaM2 - 8836) < 1,
    `допустимая территория обязана быть 8836 м², получено ${built.buildable.areaM2}`);
  assert.ok(!built.warnings.some((w) => w.code === 'no-restrictions'),
    'список ограничений больше не пуст — и предупреждения о пустоте быть не должно');
});

test('границы ЗУ из документа: повторное наложение не плодит двойников участка', () => {
  const PS = require('../server/services/geometry/parcel-source');
  const G = require('../server/services/geometry/site-geometry');
  const { db, now } = require('../server/db');
  const SID = `parcel-twice-${Math.random().toString(36).slice(2)}`;
  db.prepare('INSERT INTO sessions (id, token, status, created_at, updated_at, title) VALUES (?,?,?,?,?,?)')
    .run(SID, 'tok', 'idle', now(), now(), 'Горбунки');

  const site = G.createSiteGeometry();
  site.drawingBounds = { ...TOPO_BOUNDS };
  site.parcel = G.makeObject({
    type: 'parcel', closed: true,
    points: [[2195900, 422300], [2195908, 422300], [2195908, 422309], [2195900, 422309]],
    provenance: {
      extractionMethod: 'cad-vector', sourceFile: 'МСК-47_Горбунки.dwg', sourceFileId: 'f1',
      sourceLayer: '10_Границы покрытий и угодий', sourceEntity: 'замкнутая полилиния', confidence: 0.6,
    },
  });
  PS.save(SID, { points: GPZU_POINTS, meta: GPZU_META });

  const first = PS.applyTo(SID, site);
  assert.strictEqual(first.applied, true);
  const afterFirst = site.existingObjects.length;
  const parcelId = site.parcel.id;

  // ensurePlan зовётся на каждом шаге, а этап зон ещё и сохраняет план обратно
  const second = PS.applyTo(SID, site);
  assert.strictEqual(second.alreadyApplied, true, 'повтор обязан быть пустышкой');
  assert.strictEqual(site.parcel.id, parcelId, 'участок остался тем же объектом');
  assert.strictEqual(site.existingObjects.length, afterFirst,
    'двойник участка на 3700 м² не должен добавляться в «прочие объекты» на каждом проходе');
  assert.strictEqual(site.warnings.filter((w) => w.code === 'parcel-from-document').length, 1,
    'в карточке согласования сообщение о границах из документа должно быть одно');

  PS.remove(SID);
});

/* ============ имя, данное человеком линии, доходит до зон ============ */

test('ограничения: зона строится от линии, НАЗВАННОЙ человеком, а не только по слою', () => {
  const G = require('../server/services/geometry/site-geometry');
  const RE = require('../server/services/geometry/restriction-engine');
  const RR = require('../server/services/geometry/restriction-rules');

  const site = G.createSiteGeometry();
  site.parcel = G.makeObject({
    type: 'parcel', points: [[0, 0], [200, 0], [200, 200], [0, 200]], closed: true,
    provenance: {
      extractionMethod: 'document-stated', sourceFile: 'ГПЗУ.pdf',
      sourceEntity: 'таблица координат', confidence: 0.9,
    },
  });
  // на топосъёмке слой называется обезличенно — киловольты в нём не указаны
  const mkLine = (y, label) => {
    const o = G.makeObject({
      type: 'utility', points: [[0, y], [200, y]], closed: false,
      provenance: {
        extractionMethod: 'cad-vector', sourceFile: 'т.dwg',
        sourceLayer: '07_Объекты электропередачи', sourceEntity: 'полилиния', confidence: 0.8,
      },
    });
    if (label) o.properties = { ...o.properties, userLabel: label, userEdited: true };
    return o;
  };
  const vl10 = mkLine(50, 'ВЛ-10 кВ');
  const svyaz = mkLine(150, 'Кабель связи');
  site.utilities.push(vl10, svyaz);

  const rule = RR.normalizeRule({
    kind: 'protectionZone', operation: 'bufferOutward', targetSelector: 'utility',
    targetHint: 'ВЛ-10 кВ', value: 10, unit: 'м', basis: 'ПП РФ № 160, п. 8',
    sourceDocument: 'ГПЗУ.pdf', sourceClause: 'п. 8', quote: '10 м', confidence: 0.9,
  }, 0).rule;

  const built = RE.build(site, [rule]);
  assert.strictEqual(built.restrictions.length, 1);
  // зона обязана быть ОТ ОДНОЙ линии: 200 м × 20 м = 4000 м², а не от обеих
  assert.ok(Math.abs(built.restrictions[0].properties.areaM2 - 4000) < 50,
    `зона ${built.restrictions[0].properties.areaM2} м² — должна быть ~4000 м² от одной названной линии`);
  assert.ok(!built.warnings.some((w) => w.code === 'target-hint-missed'),
    'уточнение совпало с подписью человека — «построено от всех объектов типа» тут неуместно');

  /*
   * Без подписи уточнение «ВЛ-10 кВ» не совпадает ни со слоем, ни с именем —
   * и зона НЕ строится вовсе. Прежде она строилась от обеих линий разом, и на
   * боевом чертеже такое правило накрывало все одиннадцать слоёв сетей.
   * Подпись человека — единственный способ различить линии одного слоя, и
   * платформа прямо об этом и просит в причине.
   */
  const bare = G.createSiteGeometry();
  bare.parcel = site.parcel;
  bare.utilities.push(mkLine(50), mkLine(150));
  const wide = RE.build(bare, [rule]);
  assert.strictEqual(wide.restrictions.length, 0, 'зона от чужих объектов не строится');
  assert.match(wide.unresolved[0].reason, /Подпишите нужную линию/,
    'человеку сказано, чем закрыть потерю');
});

test('ограничения: имя линии переживает переразбор чертежа и пересчёт зон', () => {
  const G = require('../server/services/geometry/site-geometry');
  const OE = require('../server/services/geometry/object-edits');
  const RE = require('../server/services/geometry/restriction-engine');
  const RR = require('../server/services/geometry/restriction-rules');

  /** Тот же чертёж, разобранный заново: идентификаторы объектов выданы другие. */
  const parse = (idSuffix) => {
    const site = G.createSiteGeometry();
    site.parcel = G.makeObject({
      type: 'parcel', points: [[0, 0], [200, 0], [200, 200], [0, 200]], closed: true,
      provenance: {
        extractionMethod: 'cad-vector', sourceFile: 'т.dwg', sourceLayer: 'Границы ЗУ',
        sourceEntity: 'замкнутая полилиния', confidence: 0.85,
      },
    });
    for (const [y, n] of [[50, 'a'], [150, 'b']]) {
      const o = G.makeObject({
        type: 'utility', points: [[0, y], [200, y]], closed: false,
        provenance: {
          extractionMethod: 'cad-vector', sourceFile: 'т.dwg', sourceFileId: 'f1',
          sourceLayer: '07_Объекты электропередачи', sourceEntity: 'полилиния', confidence: 0.8,
        },
      });
      o.id = `utility-${n}-${idSuffix}`; // разбор нумерует по порядку и меняет id
      site.utilities.push(o);
    }
    return site;
  };

  const first = parse('run1');
  const edit = { objectKey: OE.keyOf(first.utilities[0], 'utilities'), patch: { label: 'ВЛ-10 кВ' } };

  // ПЕРЕРАЗБОР: другой экземпляр плана, другие id
  const second = parse('run2');
  assert.notStrictEqual(second.utilities[0].id, first.utilities[0].id);
  const applied = OE.applyTo(second, [edit]);
  assert.strictEqual(applied.applied, 1, 'имя нашло свою линию после переразбора');
  assert.strictEqual(second.utilities[0].properties.userLabel, 'ВЛ-10 кВ');
  assert.strictEqual(second.utilities[1].properties.userLabel, undefined,
    'соседняя линия того же слоя осталась безымянной');

  // ПЕРЕСЧЁТ ЗОН по этому же плану: правило находит линию по имени
  const rule = RR.normalizeRule({
    kind: 'protectionZone', operation: 'bufferOutward', targetSelector: 'utility',
    targetHint: 'ВЛ-10 кВ', value: 10, unit: 'м', basis: 'ПП РФ № 160, п. 8',
    sourceDocument: 'ГПЗУ.pdf', sourceClause: 'п. 8', quote: '10 м', confidence: 0.9,
  }, 0).rule;
  const built = RE.build(second, [rule]);
  assert.ok(Math.abs(built.restrictions[0].properties.areaM2 - 4000) < 50,
    'после переразбора и пересчёта зона по-прежнему от одной названной линии');
});

test('слои: сети настоящей топосъёмки опознаются, а не падают в «прочее»', () => {
  const L = require('../server/services/geometry/layers');
  /*
   * Слои взяты из МСК-47_Горбунки по классификатору топосъёмки. «07_Объекты
   * электропередачи» не опознавался НИКАК и уходил в «прочие объекты» — а это
   * ЛЭП, охранная зона которой на этой площадке решает всё: правило с
   * targetSelector «utility» её просто не находило.
   */
  const ожидание = {
    '07_Объекты электропередачи': 'utility',
    '34_Трубопроводы спецназначения': 'utility',
    '43_Футляры и каналы': 'utility',
    '35_Телефон': 'utility',
    '30_Канализация': 'utility',
    '33_Газопровод': 'utility',
    '11_Гидрография': 'water',
    '08_Поребрики': 'road',
    '13_Растительность': 'landscaping',
    '03_Здания и строения': 'building',
    '12_Рельеф': 'relief',
    '14_Ограждения': 'fence',
    '45_Номера колодцев': 'utilityStructure',
  };
  for (const [layer, type] of Object.entries(ожидание)) {
    const c = L.classify(layer);
    assert.ok(c, `слой «${layer}» обязан опознаваться, иначе его геометрия не участвует в ограничениях`);
    assert.strictEqual(c.type, type, `«${layer}» → ${c.type}, ожидалось ${type}`);
  }
  // рамка листа остаётся неопознанной намеренно: это оформление, а не местность
  assert.strictEqual(L.classify('18_Зарамочное оформление'), null);
});

test('опись участка: слои сворачиваются, а подписи человека идут первыми', () => {
  const G = require('../server/services/geometry/site-geometry');
  const RE = require('../server/services/geometry/restriction-extract');

  const site = G.createSiteGeometry();
  site.parcel = G.makeObject({
    type: 'parcel', points: [[0, 0], [100, 0], [100, 100], [0, 100]], closed: true,
    provenance: {
      extractionMethod: 'document-stated', sourceFile: 'ГПЗУ.pdf',
      sourceEntity: 'таблица координат', confidence: 0.9,
    },
  });
  for (let i = 0; i < 20; i++) {
    site.utilities.push(G.makeObject({
      type: 'utility', points: [[0, i], [50, i]], closed: false,
      provenance: {
        extractionMethod: 'cad-vector', sourceFile: 'т.dwg',
        sourceLayer: '30_Канализация', sourceEntity: 'полилиния', confidence: 0.8,
      },
    }));
  }
  const named = G.makeObject({
    type: 'utility', points: [[0, 80], [100, 80]], closed: false,
    provenance: {
      extractionMethod: 'cad-vector', sourceFile: 'т.dwg',
      sourceLayer: '07_Объекты электропередачи', sourceEntity: 'полилиния', confidence: 0.8,
    },
  });
  named.properties = { ...named.properties, userLabel: 'ВЛ-10 кВ' };
  site.utilities.push(named);

  const inv = RE.inventory(site);
  assert.match(inv, /НАЗВАНО ЧЕЛОВЕКОМ: «ВЛ-10 кВ»/, 'подпись человека обязана быть видна модели');
  assert.match(inv, /слой «30_Канализация» — 20 шт/, 'однотипные объекты слоя сворачиваются в строку');
  assert.ok(inv.length < 1200, `опись ${inv.length} символов — двадцать одинаковых строк съедали бы промпт`);
  // границы из документа не должны выглядеть как «слой null»
  assert.ok(!/слой «null»/.test(inv));
  assert.match(inv, /из документа «ГПЗУ.pdf»/);
});

/* ================= шаг 5: противопожарные разрывы ================= */

test('шаг 5: пожарные характеристики разбираются по виду обозначения, а не по имени ключа', () => {
  const RE = require('../server/services/geometry/restriction-extract');

  /*
   * Имена ключей модель придумывает сама и путает: на прогоне 2026-08-12
   * `object.fire_class = Ф5.1` — это класс ФУНКЦИОНАЛЬНОЙ опасности, а по имени
   * он неотличим от конструктивного, и «Ф5.1» уезжало в столбец таблицы 3
   * СП 4.13130, где стоят С0…С3. Обозначения при этом ни с чем не спутать.
   */
  const a = RE.fireFactsOf([
    { key: 'object.fire_class', value: 'Ф5.1 (производственное)' },
    { key: 'object.fire_degree', value: 'IV' },
  ]);
  assert.strictEqual(a.degree, 'IV');
  assert.strictEqual(a.functional, 'Ф5.1');
  assert.strictEqual(a.structural, '', 'конструктивного класса в этих фактах нет — выдумывать нечего');

  const b = RE.fireFactsOf([
    { key: 'object.constructive_fire_hazard_class', value: 'С0' },
    { key: 'object.fire_hazard_category', value: 'В' },
    { key: 'object.fire_hazard_level', value: 'Ф5.1' },
    { key: 'object.fire_resistance_class', value: 'IV' },
  ]);
  assert.deepStrictEqual(
    { d: b.degree, s: b.structural, f: b.functional, c: b.category },
    { d: 'IV', s: 'С0', f: 'Ф5.1', c: 'В' },
  );

  // всё одной строкой — из каждого поля берётся своё обозначение, а не вся фраза
  const c = RE.fireFactsOf([{ key: 'object.fire', value: 'IV степень огнестойкости, класс С0, категория В, Ф5.1' }]);
  assert.deepStrictEqual(
    { d: c.degree, s: c.structural, f: c.functional, c: c.category },
    { d: 'IV', s: 'С0', f: 'Ф5.1', c: 'В' },
  );

  // нет пожарных данных — нет и блока: пустой блок сбивал бы модель с толку
  assert.strictEqual(RE.fireFactsOf([{ key: 'object.floors', value: '2' }]).text, '');
});

test('шаг 5: разрыв строится от существующих строений и режет допустимую территорию', () => {
  const G = require('../server/services/geometry/site-geometry');
  const RE = require('../server/services/geometry/restriction-engine');
  const RR = require('../server/services/geometry/restriction-rules');

  const site = G.createSiteGeometry();
  site.parcel = G.makeObject({
    type: 'parcel', points: [[0, 0], [100, 0], [100, 100], [0, 100]], closed: true,
    provenance: {
      extractionMethod: 'document-stated', sourceFile: 'ГПЗУ.pdf',
      sourceEntity: 'таблица координат', confidence: 0.9,
    },
  });
  // соседнее строение ВНЕ участка — именно от таких считается разрыв
  site.buildings.push(G.makeObject({
    type: 'building', points: [[110, 40], [130, 40], [130, 60], [110, 60]], closed: true,
    provenance: {
      extractionMethod: 'cad-vector', sourceFile: 'т.dwg', sourceLayer: '03_Здания и строения',
      sourceEntity: 'замкнутая полилиния', confidence: 0.8,
    },
  }));

  const rule = RR.normalizeRule({
    kind: 'fireBreak', operation: 'bufferOutward', targetSelector: 'building',
    targetHint: '03_Здания и строения', value: 12, unit: 'м',
    basis: 'СП 4.13130.2013, табл. 3', sourceDocument: 'НТД', sourceClause: 'табл. 3',
    quote: 'IV степень огнестойкости классов C1, C2 и C3 — 12 м', confidence: 0.85,
  }, 0).rule;
  assert.ok(rule, 'правило противопожарного разрыва обязано проходить нормализацию');
  assert.strictEqual(rule.kind, 'fireBreak');

  const built = RE.build(site, [rule]);
  assert.strictEqual(built.restrictions.length, 1);
  // буфер 12 м от строения за границей заходит на участок полосой 2 м × 44 м
  assert.ok(built.buildable.areaM2 < 10000 && built.buildable.areaM2 > 9800,
    `разрыв обязан срезать угол участка, получено ${built.buildable.areaM2} м²`);

  // а снесённое строение разрыва не даёт — решение шага 2 доходит до шага 5
  const gone = G.createSiteGeometry();
  gone.parcel = site.parcel;
  const doomed = { ...site.buildings[0] };
  doomed.properties = { ...doomed.properties, relocation: 'demolish' };
  gone.buildings.push(doomed);
  const after = RE.build(gone, [rule]);
  assert.strictEqual(after.restrictions.length, 0);
  assert.strictEqual(after.buildable.areaM2, 10000, 'после сноса участок свободен целиком');
});

/* ================= решение человека доходит до ПЯТНА, а не только до зон ================= */

/**
 * Здание под снос держало пятно застройки.
 *
 * Зоны считались один раз по кнопке и складывались прямо в запись плана,
 * а подбор вариантов, посадка, чертёж и отчёт читали `site.buildable` оттуда.
 * Пометил строение «сносится» — зоны на экране остались прежними, потому что
 * пересчёта не было: на боевом комплекте допустимая территория держалась на
 * 633 м² вместо 1487, и посадка не находилась.
 */
test('зоны: решение о сносе пересчитывает пятно без повторного обращения к модели', async (t) => {
  const os = require('os'); const pathMod = require('path'); const crypto = require('crypto');
  const dir = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'fixgeo-zones-'));
  process.env.DATA_DIR = dir;
  const { db, now } = require('../server/db');
  const zones = require('../server/services/geometry/zones');
  const objectEdits = require('../server/services/geometry/object-edits');
  const sid = crypto.randomUUID();
  db.prepare('INSERT INTO sessions (id, token, status, created_at, updated_at) VALUES (?,?,?,?,?)')
    .run(sid, `tok-${sid}`, 'active', now(), now());
  t.after(() => {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(sid);
    db.prepare('DELETE FROM plan_zones WHERE session_id = ?').run(sid);
    db.prepare('DELETE FROM plan_object_edits WHERE session_id = ?').run(sid);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const p = pathMod.join(dir, 'площадка.dxf');
  fs.writeFileSync(p, writeDxf([
    { layer: 'Границы ЗУ', closed: true, points: [[0, 0], [100, 0], [100, 100], [0, 100]] },
    { layer: '03_Здания и строения', closed: true, points: [[40, 40], [60, 40], [60, 60], [40, 60]] },
  ]));
  db.prepare('INSERT INTO files (id, session_id, original_name, stored_path, ext, size, created_at) VALUES (?,?,?,?,?,?,?)')
    .run(crypto.randomUUID(), sid, 'площадка.dxf', p, 'dxf', fs.statSync(p).size, now());

  const rule = RR.normalizeRule({
    kind: 'fireBreak', operation: 'bufferOutward', targetSelector: 'building', targetHint: '',
    value: 12, unit: 'м', basis: 'СП 4.13130.2013, табл. 1', sourceDocument: 'НТД',
    sourceClause: 'табл. 1', quote: '12 м', confidence: 0.85,
  }, 0).rule;

  // 1. считаем зоны один раз — ровно то, что делает маршрут /plan/restrictions
  const first = await planSvc.ensurePlan(sid);
  const built = engine.build(first.site, [rule]);
  zones.save(sid, first.planId, { rules: [rule], built });
  const before = built.buildable.areaM2;
  assert.ok(before < 9000, `разрыв обязан съесть часть участка, получено ${before} м²`);

  // 2. человек помечает строение «сносится» — и НЕ нажимает пересчёт
  const raw = await planSvc.ensurePlan(sid, { raw: true });
  const target = raw.site.buildings[0];
  assert.ok(target, 'здание должно быть разобрано');
  objectEdits.save(sid, {
    planId: raw.planId, objectId: target.id, layer: 'buildings', object: target,
    patch: { relocation: 'demolish' },
  });

  // 3. следующий же запрос плана обязан отдать пересчитанное пятно
  const after = await planSvc.ensurePlan(sid);
  assert.strictEqual(after.site.buildable.areaM2, 10000,
    'снесённое строение разрыва не даёт — участок свободен целиком');
  assert.ok(after.site.warnings.some((w) => w.code === 'zones-recomputed'),
    'о пересчёте зон сказано вслух');

  // 4. отмена решения возвращает прежнее пятно
  objectEdits.remove(sid, objectEdits.keyOf(target, 'buildings'));
  const reverted = await planSvc.ensurePlan(sid);
  assert.strictEqual(reverted.site.buildable.areaM2, before,
    'отмена правки возвращает расчёт к исходному');

  // 5. в таблице планов остаётся ЧИСТЫЙ разбор: зоны туда не попадают
  const stored = JSON.parse(db.prepare('SELECT geometry FROM plans WHERE id = ?').get(first.planId).geometry);
  assert.ok(!(stored.restrictions || []).length, 'зоны в записи плана не хранятся');
  assert.ok(!stored.buildable, 'допустимая территория в записи плана не хранится');
});

/**
 * Правка типа меняет геометрию (ломаная → полигон), а вместе с ней менялся
 * отпечаток, из которого строится ключ правки. Правка переставала находить
 * свой объект: «Отменить правку» слала несуществующий ключ, а повторная правка
 * заводила вторую запись вместо дополнения первой.
 */
test('правки: смена типа не уводит ключ правки от объекта', () => {
  const objectEdits = require('../server/services/geometry/object-edits');
  const site = G.createSiteGeometry();
  const ring = [[0, 0], [50, 0], [50, 40], [0, 40], [0, 0]];
  site.utilities.push(G.makeObject({
    type: 'utility', points: ring, closed: false,
    properties: { closedRing: true, lengthM: 180 },
    provenance: {
      extractionMethod: 'cad-vector', sourceFile: 'т.dxf', sourceLayer: '33_Газопровод',
      sourceEntity: 'замкнутая полилиния', confidence: 0.8,
    },
  }));
  const keyBefore = objectEdits.keyOf(site.utilities[0], 'utilities');

  objectEdits.applyTo(site, [{
    objectKey: keyBefore, layer: 'utilities', patch: { type: 'parcel', label: 'Участок' },
  }]);
  assert.ok(site.parcel, 'контур назначен участком');
  assert.strictEqual(site.parcel.geometry.type, 'polygon', 'кольцо стало полигоном');
  assert.strictEqual(objectEdits.keyOf(site.parcel, 'parcel'), keyBefore,
    'ключ правки после пересборки геометрии обязан остаться прежним');
});

/**
 * Пустое имя слоя совпадало с ЛЮБЫМ уточнением: `needle.includes('')` истинно
 * всегда. Граница участка, перенесённая из ГПЗУ (слоя у неё нет), попадала
 * под каждое правило подряд — охранная зона газопровода строилась вокруг всего
 * участка.
 */
test('движок: объект без имени слоя не совпадает с уточнением правила', () => {
  const site = G.createSiteGeometry();
  site.parcel = G.makeObject({
    type: 'parcel', points: [[0, 0], [100, 0], [100, 100], [0, 100]], closed: true,
    provenance: {
      extractionMethod: 'document-stated', sourceFile: 'ГПЗУ.pdf',
      sourceEntity: 'таблица координат', confidence: 0.9,
    },
  });
  const rule = RR.normalizeRule({
    kind: 'protectionZone', operation: 'bufferOutward', targetSelector: 'layer',
    targetHint: '33_Газопровод', value: 4, unit: 'м',
    basis: 'ПП РФ № 878, п. 7', sourceDocument: 'ГПЗУ.pdf', sourceClause: 'п. 7',
    quote: '4 м', confidence: 0.85,
  }, 0).rule;

  const res = engine.resolveTargets(site, rule);
  assert.ok(!res.narrowed, 'граница участка без слоя уточнению не соответствует');
  assert.ok(res.hintMissed, 'несовпавшее уточнение обязано быть названо');
  const built = engine.build(site, [rule]);
  assert.strictEqual(built.restrictions.length, 0, 'зона от чужого объекта не строится');
  assert.strictEqual(built.buildable.areaM2, 10000, 'участок остаётся свободным');
});

/**
 * У каждой зоны — свой объект отсчёта и свой цвет, а под краской лежит
 * запретная зона: объединение всех ограничений одним контуром.
 */
test('зоны: одна зона на объект, свой цвет и общая запретная подложка', () => {
  const ZoneStyle = require('../public/zone-style.js');
  const site = G.createSiteGeometry();
  site.parcel = G.makeObject({
    type: 'parcel', points: [[0, 0], [200, 0], [200, 200], [0, 200]], closed: true,
    provenance: { extractionMethod: 'cad-vector', sourceFile: 'т.dxf', sourceLayer: 'Границы ЗУ', sourceEntity: 'полилиния', confidence: 0.8 },
  });
  for (const [i, x] of [20, 120].entries()) {
    site.buildings.push(G.makeObject({
      type: 'building', points: [[x, 20], [x + 20, 20], [x + 20, 40], [x, 40]], closed: true,
      properties: { userLabel: `Корпус ${i + 1}` },
      provenance: { extractionMethod: 'cad-vector', sourceFile: 'т.dxf', sourceLayer: '03_Здания и строения', sourceEntity: 'полилиния', confidence: 0.8 },
    }));
  }
  const rule = RR.normalizeRule({
    kind: 'fireBreak', operation: 'bufferOutward', targetSelector: 'building', targetHint: '',
    value: 10, unit: 'м', basis: 'СП 4.13130.2013, табл. 1', sourceDocument: 'НТД',
    sourceClause: 'табл. 1', quote: '10 м', confidence: 0.85,
  }, 0).rule;

  const built = engine.build(site, [rule]);
  assert.strictEqual(built.restrictions.length, 2, 'на каждый корпус — своя зона');
  const labels = built.restrictions.map((r) => r.properties.sourceLabel).sort();
  assert.deepStrictEqual(labels, ['Корпус 1', 'Корпус 2'], 'зона названа именем своего объекта');

  const colors = ZoneStyle.assignColors(built.restrictions);
  const used = built.restrictions.map((r) => colors.byZone[r.id].color);
  assert.strictEqual(new Set(used).size, 2, 'у двух объектов два разных цвета');

  const f = built.buildable.forbidden;
  assert.ok(f && f.geometry, 'запретная зона отдаётся отдельной геометрией');
  assert.strictEqual(f.zoneCount, 2);
  // запретная плюс допустимая = участок, до сотых
  assert.ok(Math.abs(f.areaM2 + built.buildable.areaM2 - 40000) < 1,
    `${f.areaM2} + ${built.buildable.areaM2} должно давать 40000 м²`);
});

test('посадка: здание под снос не считается воздействием варианта, но остаётся в ТЭП', () => {
  const G = require('../server/services/geometry/site-geometry');
  const P = require('../server/services/geometry/placement-engine');
  const V = require('../server/services/geometry/variants');

  /*
   * Пятно ставится поверх существующего здания. Пока решения нет — это
   * воздействие варианта. После «сносится» здания на площадке не будет, и
   * воздействием оно быть перестаёт: платформа не должна уводить пятно от
   * того, что сама же и сносит. Мероприятие при этом остаётся — объём
   * демонтажа настоящая работа и обязан попасть в ТЭП.
   */
  const мир = (relocation) => {
    const site = G.createSiteGeometry();
    site.parcel = G.makeObject({
      type: 'parcel', points: [[0, 0], [60, 0], [60, 60], [0, 60]], closed: true,
      provenance: {
        extractionMethod: 'document-stated', sourceFile: 'ГПЗУ.pdf',
        sourceEntity: 'таблица координат', confidence: 0.9,
      },
    });
    const дом = G.makeObject({
      type: 'building', points: [[20, 20], [40, 20], [40, 40], [20, 40]], closed: true,
      provenance: {
        extractionMethod: 'cad-vector', sourceFile: 'т.dwg', sourceLayer: '03_Здания и строения',
        sourceEntity: 'замкнутая полилиния', confidence: 0.8,
      },
    });
    if (relocation) дом.properties = { ...дом.properties, relocation };
    site.buildings.push(дом);
    site.buildable = { geometry: site.parcel.geometry, areaM2: 3600, sharePercent: 100 };
    return site;
  };

  const без = мир('undecided');
  const c1 = P.generate(без, без.buildable, { areaM2: 1600, floors: 1, allowReshape: false, allowRotate: false }).candidates[0];
  assert.strictEqual(c1.affected.length, 1, 'пока решения нет, здание — воздействие варианта');
  assert.strictEqual(c1.removed.length, 0);

  const снос = мир('demolish');
  const g = P.generate(снос, снос.buildable, { areaM2: 1600, floors: 1, allowReshape: false, allowRotate: false });
  const c2 = g.candidates[0];
  assert.strictEqual(c2.affected.length, 0, 'здания, которого не будет, вариант не задевает');
  assert.strictEqual(c2.removed.length, 1, 'но оно не потеряно — уходит в отдельный список');
  assert.strictEqual(c2.removed[0].decided, 'demolish');

  const { variants } = V.build(снос, g.candidates, { criterion: 'maxArea' });
  const v = variants[0];
  assert.strictEqual(v.metrics.affectedCount, 0, 'в метриках варианта воздействия нет');
  assert.strictEqual(v.metrics.removedCount, 1, 'а снос показан отдельно');
  assert.strictEqual(v.metrics.removedAreaM2, 400, 'с площадью — она нужна для объёма демонтажа');
  assert.strictEqual(v.status, 'admissible', 'решение уже принято — спрашивать заново незачем');
  assert.ok((v.actions || []).some((a) => a.decided === 'demolish'),
    'мероприятие по сносу остаётся: объём демонтажа обязан попасть в ТЭП');
});
