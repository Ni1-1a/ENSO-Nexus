'use strict';
/**
 * Замечания владельца 09.09.2026:
 *  1. сокращение контекста — долго и по многу раз;
 *  2. правка объекта на промежуточном шаге ничего не показывает;
 *  3. здание рисуется треугольником — нужны прямые углы и минимум углов;
 *  4. после согласования варианта здание не попадает на план.
 * Каждый тест закрывает конкретную поломку из этого списка.
 */
const os = require('os');
const path = require('path');
const fs = require('fs');
process.env.DATA_DIR = path.join(os.tmpdir(), `pilot1-remarks-${process.pid}`);
process.env.ANTHROPIC_API_KEY = '';
process.env.USERS_FILE = path.join(os.tmpdir(), `pilot1-remarks-users-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
process.env.RATE_LIMIT_GENERAL = '1000';
process.env.RATE_LIMIT_EXPENSIVE = '1000';
process.env.CLOUD_AI_OPEN = '1';

const { test, before, after } = require('node:test');
const assert = require('node:assert');

const G = require('../server/services/geometry/site-geometry');
const jts = require('../server/services/geometry/jts');
const SH = require('../server/services/geometry/shapes');
const GS = require('../server/services/geometry/grid-shape');
const P = require('../server/services/geometry/placement-engine');
const V = require('../server/services/geometry/variants');

/* ================= 3. прямые углы, минимум углов ================= */

test('формы: треугольник и трапеция больше не предлагаются, подписи старых запусков живы', () => {
  const ids = SH.ids();
  assert.ok(!ids.includes('triangle') && !ids.includes('trapezoid'), `в переборе остались косые формы: ${ids}`);
  for (const id of ids) {
    const box = SH.boxFor(id, 900, 1.4);
    const pts = SH.footprint(id, 0, 0, box.width, box.length, 0);
    assert.ok(GS.isOrthogonal(pts), `${id}: у формы есть непрямые углы`);
  }
  assert.strictEqual(SH.label('triangle'), 'треугольная');
  assert.strictEqual(SH.label('grid'), 'по сетке колонн');
});

test('углы: счётчик не считает коллинеарные вершины, прямоугольность распознаётся', () => {
  assert.strictEqual(GS.cornerCount([[0, 0], [5, 0], [10, 0], [10, 10], [0, 10]]), 4);
  assert.strictEqual(GS.cornerCount([[0, 0], [10, 0], [10, 4], [4, 4], [4, 10], [0, 10]]), 6);
  assert.strictEqual(GS.cornerCount([[0, 0], [10, 0], [5, 8]]), 3);
  assert.ok(GS.isOrthogonal([[0, 0], [10, 0], [10, 4], [4, 4], [4, 10], [0, 10]]));
  assert.ok(!GS.isOrthogonal([[0, 0], [10, 0], [5, 8]]));
  // поворот прямоугольника прямоугольность не отнимает
  assert.ok(GS.isOrthogonal(P.rectFootprint(50, 40, 20, 10, 37)));
});

test('сетка колонн: в клине строится контур ровно требуемой площади из ячеек, все углы прямые', () => {
  const tri = [[0, 0], [96, 22], [30, 78]];
  const area = jts.toJts({ type: 'polygon', closed: true, points: tri });
  const res = GS.generate(area, { areaM2: 1790, angleDeg: 12.9, origin: [0, 0] });
  assert.ok(res.length > 0, 'контур по сетке обязан найтись: 3400 м² клина под 1790 м² застройки');
  const best = res[0];
  assert.ok(Math.abs(G.polygonArea(best.points) - 1790) < 1, `площадь ${G.polygonArea(best.points)} вместо 1790`);
  assert.ok(GS.isOrthogonal(best.points), 'есть непрямые углы');
  assert.strictEqual(best.corners, GS.cornerCount(best.points));
  assert.ok(best.corners >= 4 && best.corners <= 16, `углов ${best.corners}`);
  const fp = jts.toJts({ type: 'polygon', closed: true, points: best.points });
  assert.ok(fp.within(area), 'контур обязан лежать внутри территории целиком');
  // минимальная ширина: ни одной ступени уже двух ячеек (сторона ≥ 2 × шаг)
  assert.ok(best.width >= 2 * best.cellM - 0.01 && best.length >= 2 * best.cellM - 0.01);
  // выдача упорядочена по числу углов
  for (let i = 1; i < res.length; i++) assert.ok(res[i].corners >= res[i - 1].corners);
});

test('посадка: на треугольной площадке все кандидаты — с прямыми углами, первым идёт контур с меньшим числом углов', () => {
  const tri = [[0, 0], [96, 22], [30, 78]];
  const site = G.createSiteGeometry();
  site.parcel = G.makeObject({
    type: 'parcel', points: [[-5, -5], [105, -5], [105, 85], [-5, 85]], closed: true,
    provenance: { extractionMethod: 'user', confidence: 1 },
  });
  const buildable = { geometry: { type: 'polygon', closed: true, points: tri }, areaM2: Math.round(G.polygonArea(tri)) };
  const res = P.generate(site, buildable, { areaM2: 1790, floors: 2, allowReshape: true, allowRotate: true }, { limit: 60 });
  assert.ok(res.candidates.length > 0, `посадка обязана найтись: ${res.reason || '—'}`);
  for (const c of res.candidates) {
    assert.ok(c.shape !== 'triangle' && c.shape !== 'trapezoid', `косая форма в выдаче: ${c.shape}`);
    assert.ok(c.orthogonal, `${c.shape}: непрямые углы у кандидата`);
    assert.ok(Number.isFinite(c.corners) && c.corners >= 4, 'у кандидата нет числа углов');
    assert.ok(Math.abs(c.areaM2 - 1790) / 1790 < 0.02, `площадь ${c.areaM2} съехала от 1790`);
  }
  const admissible = res.candidates.filter((c) => c.admissible);
  assert.ok(admissible.length > 0, 'хотя бы один кандидат без нарушений');
  const fewest = Math.min(...admissible.map((c) => c.corners));
  assert.strictEqual(admissible[0].corners, fewest, 'первым идёт кандидат с наименьшим числом углов');
  const { variants } = V.build(site, res.candidates, { criterion: 'maxArea' });
  assert.ok(variants.length >= 1);
  assert.strictEqual(variants[0].metrics.corners, fewest, 'вариант 1 — с наименьшим числом углов');
  assert.strictEqual(variants[0].metrics.orthogonal, true);
});

test('отбор: при равной площади вариант с меньшим числом углов идёт раньше', () => {
  const mk = (corners, areaM2) => ({ areaM2, corners, affected: [], footprint: { points: [] } });
  const ranked = V.rank([mk(8, 1000), mk(4, 999), mk(6, 1001)], 'maxArea');
  assert.deepStrictEqual(ranked.map((c) => c.corners), [4, 6, 8]);
  // заметно большая площадь по-прежнему важнее формы (критерий «максимальная площадь»)
  const big = V.rank([mk(4, 900), mk(8, 1000)], 'maxArea');
  assert.strictEqual(big[0].corners, 8);
});

/* ================= 1. сокращение контекста ================= */

const adapter = require('../server/services/claude/adapter');

test('бюджет документов делится по справедливости: маленькие целиком, большие поровну', () => {
  assert.deepStrictEqual(adapter.fairLimits([100, 5000, 96000, 300], 10000), [100, 4800, 4800, 300]);
  assert.deepStrictEqual(adapter.fairLimits([100, 200], 10000), [100, 200]);
  const blocks = [
    { type: 'text', text: `<uploaded_document name="ГПЗУ">${'г'.repeat(96000)}</uploaded_document>` },
    { type: 'text', text: `<uploaded_document name="ТЗ">${'т'.repeat(6000)}</uploaded_document>` },
    { type: 'text', text: `<uploaded_document name="уточнения">${'у'.repeat(900)}</uploaded_document>` },
  ];
  const fitted = adapter.fitDocumentBlocks(blocks, 30000);
  assert.strictEqual(fitted[1].text, blocks[1].text, 'маленький документ не тронут');
  assert.strictEqual(fitted[2].text, blocks[2].text);
  assert.ok(fitted[0].text.length < 30000, 'большой ужат под бюджет');
  assert.match(fitted[0].text, /ОБРЕЗАН по лимиту контекста/, 'усечение честно помечено');
  assert.match(fitted[0].text, /<\/uploaded_document>\s*$/, 'закрывающий тег на месте');
  // строковая склейка режется по тем же правилам: страдает не последний документ, а самый большой
  const joined = blocks.map((b) => b.text).join('\n\n');
  const cut = adapter.fitDocumentsText(joined, 30000);
  assert.ok(cut.includes('у'.repeat(900)), 'последний маленький документ пережил усечение целиком');
  assert.ok(cut.length <= 31000);
});

test('усечение промпта режет документы, а не только их хвост: последний документ остаётся', () => {
  const docs = `<uploaded_document name="A">${'a'.repeat(40000)}</uploaded_document>\n\n`
    + `<uploaded_document name="B">${'b'.repeat(1000)}</uploaded_document>`;
  const messages = [
    { role: 'system', content: 'система' },
    { role: 'user', content: `<session_state>\n${'s'.repeat(500)}\n</session_state>` },
    { role: 'user', content: docs },
    { role: 'user', content: 'инструкция' },
  ];
  const notes = adapter.trimToBudget(messages, 20000);
  assert.ok(notes.some((n) => /документов ужаты/.test(n)), `нет пометки об ужатии: ${notes}`);
  assert.ok(messages[2].content.includes('b'.repeat(1000)), 'документ B выжил целиком');
  assert.ok(messages[2].content.length < 22000);
});

test('резюме диалога составляется по накоплению новых сообщений, а не после каждого', async () => {
  const { db, now } = require('../server/db');
  const config = require('../server/config');
  const crypto = require('crypto');
  const sid = crypto.randomUUID();
  db.prepare('INSERT INTO sessions (id, token, status, created_at, updated_at) VALUES (?,?,?,?,?)').run(sid, 'tok-' + sid, 'idle', now(), now());
  const add = (n) => {
    for (let i = 0; i < n; i++) {
      db.prepare('INSERT INTO messages (id, session_id, role, kind, content, created_at) VALUES (?,?,?,?,?,?)')
        .run(crypto.randomUUID(), sid, 'user', 'chat', `сообщение ${i}`, now());
    }
  };
  add(config.compactAfterMessages);
  await adapter.maybeCompact(sid);
  const first = db.prepare('SELECT summary_msg_count, summary FROM sessions WHERE id = ?').get(sid);
  assert.strictEqual(first.summary_msg_count, config.compactAfterMessages, 'после порога резюме составлено и отмечено число сообщений');
  add(3);
  await adapter.maybeCompact(sid);
  const second = db.prepare('SELECT summary_msg_count FROM sessions WHERE id = ?').get(sid);
  assert.strictEqual(second.summary_msg_count, config.compactAfterMessages, 'три новых сообщения — резюме НЕ пересоставляется');
  add(config.compactAfterMessages);
  await adapter.maybeCompact(sid);
  const third = db.prepare('SELECT summary_msg_count FROM sessions WHERE id = ?').get(sid);
  assert.strictEqual(third.summary_msg_count, config.compactAfterMessages * 2 + 3, 'накопилась ещё порция — резюме обновлено');
});

/* ================= 2 и 4. правка видна сразу, здание на плане ================= */

const { createApp } = require('../server/app');
let server; let base; let userToken = '';
before(async () => {
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server.close();
  fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
});
const api = async (p, opts = {}) => {
  const res = await fetch(base + p, opts);
  let body = null;
  try { body = await res.clone().json(); } catch { body = await res.text(); }
  return { status: res.status, body, res };
};
const asUser = () => (userToken ? { 'X-User-Token': userToken } : {});
const auth = (s) => ({ Authorization: `Bearer ${s.token}`, ...asUser() });
async function login() {
  const { body } = await api('/api/auth/enter', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lastName: 'Тестов', firstName: 'Пробный' }),
  });
  return body.token || '';
}
async function createSession() {
  if (!userToken) userToken = await login();
  const { status, body } = await api('/api/sessions', { method: 'POST', headers: asUser() });
  assert.strictEqual(status, 201);
  return body;
}
const uploadForm = (files) => {
  const fd = new FormData();
  for (const [name, content, type] of files) fd.append('files', new File([content], name, { type }));
  return fd;
};
/** Участок 90×70 с одним зданием: разбор кладёт его в существующую застройку. */
const SITE_DXF = ['0', 'SECTION', '2', 'ENTITIES',
  '0', 'LWPOLYLINE', '8', 'Границы ЗУ', '90', '4', '70', '1',
  '10', '0', '20', '0', '10', '90', '20', '0', '10', '90', '20', '70', '10', '0', '20', '70',
  '0', 'LWPOLYLINE', '8', '20_Здания', '90', '4', '70', '1',
  '10', '70', '20', '50', '10', '85', '20', '50', '10', '85', '20', '65', '10', '70', '20', '65',
  '0', 'ENDSEC', '0', 'EOF'].join('\n');

test('план отдаёт этап и выбранный вариант; правка объекта возвращает её последствия', async () => {
  const s = await createSession();
  await api(`/api/sessions/${s.id}/files`, { method: 'POST', headers: auth(s), body: uploadForm([['топо.dxf', SITE_DXF, 'application/dxf']]) });
  const plan = await api(`/api/sessions/${s.id}/plan`, { headers: auth(s) });
  assert.strictEqual(plan.status, 200);
  assert.strictEqual(plan.body.variant, null, 'вариантов ещё нет — поле честно пустое');
  assert.strictEqual(plan.body.stage, 'idle');
  const building = plan.body.plan.buildings[0];
  assert.ok(building, 'здание разобрано');

  // человек говорит: это сооружение сетей — и получает в ответ, что произошло
  const saved = await api(`/api/sessions/${s.id}/plan/objects/${encodeURIComponent(building.id)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...auth(s) },
    body: JSON.stringify({ type: 'utilityStructure', relocation: 'keep' }),
  });
  assert.strictEqual(saved.status, 200, JSON.stringify(saved.body));
  const eff = saved.body.effect;
  assert.ok(eff, 'в ответе есть последствия правки');
  assert.strictEqual(eff.layer, 'utilities', 'объект переехал в слой сетей');
  assert.strictEqual(eff.type, 'utilityStructure');
  assert.match(eff.typeLabel, /Сооружения сетей/);
  assert.strictEqual(eff.dxfLayer, 'AI_СЕТИ_СООРУЖЕНИЯ');
  assert.strictEqual(eff.zonesRecomputed, false, 'зон ещё не считали — пересчитывать нечего');

  // живая сводка зон отвечает и до расчёта — честным «не посчитано»
  const summary = await api(`/api/sessions/${s.id}/stages/zones/summary`, { headers: auth(s) });
  assert.strictEqual(summary.status, 200, JSON.stringify(summary.body));
  assert.strictEqual(summary.body.computed, false);
  assert.ok(Array.isArray(summary.body.manualHints));
});

test('выбранный вариант приходит с планом, попадает в чертёж по слоям и устаревает после правки', async () => {
  const s = await createSession();
  await api(`/api/sessions/${s.id}/files`, { method: 'POST', headers: auth(s), body: uploadForm([['топо.dxf', SITE_DXF, 'application/dxf']]) });
  const gen = await api(`/api/sessions/${s.id}/plan/variants`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...auth(s) },
    body: JSON.stringify({ requirements: { areaM2: 600, floors: 2 } }),
  });
  assert.strictEqual(gen.status, 200, JSON.stringify(gen.body));
  const run = await api(`/api/sessions/${s.id}/plan/variants`, { headers: auth(s) });
  assert.ok(run.body.variants.length >= 1, 'варианты найдены');
  assert.strictEqual(run.body.stale, false, 'свежий запуск не устарел');
  for (const v of run.body.variants) {
    assert.ok(Number.isFinite(v.metrics.corners), 'у варианта есть число углов');
    assert.ok(GS.isOrthogonal(v.footprint.points), `вариант ${v.number}: непрямые углы`);
  }
  const first = run.body.variants.find((v) => v.status === 'admissible') || run.body.variants[0];
  const sel = await api(`/api/sessions/${s.id}/plan/variants/${first.id}/select`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...auth(s) }, body: '{}',
  });
  assert.strictEqual(sel.status, 200, JSON.stringify(sel.body));

  // план знает выбранный вариант: здание рисуется на плане, а не только в карточке
  const plan = await api(`/api/sessions/${s.id}/plan`, { headers: auth(s) });
  assert.ok(plan.body.variant, 'выбранный вариант отдан вместе с планом');
  assert.strictEqual(plan.body.variant.number, first.number);
  assert.strictEqual(plan.body.variant.approved, false, 'выбран, но ещё не согласован');
  assert.ok(Array.isArray(plan.body.variant.footprint.points) && plan.body.variant.footprint.points.length >= 4);

  // чертёж по слоям — с пятном
  const dxfRes = await fetch(`${base}/api/sessions/${s.id}/plan/drawing?format=dxf`, { headers: auth(s) });
  assert.strictEqual(dxfRes.status, 200);
  const text = new TextDecoder('windows-1251').decode(await dxfRes.arrayBuffer());
  assert.match(text, /AI_ПЯТНО_ЗАСТРОЙКИ/, 'выбранное пятно ушло в чертёж по слоям');

  // правка объекта после подбора — запуск устарел
  const building = plan.body.plan.buildings[0];
  await new Promise((r) => setTimeout(r, 1100)); // порог устаревания — секунда
  const saved = await api(`/api/sessions/${s.id}/plan/objects/${encodeURIComponent(building.id)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...auth(s) },
    body: JSON.stringify({ relocation: 'demolish' }),
  });
  assert.strictEqual(saved.status, 200, JSON.stringify(saved.body));
  const after = await api(`/api/sessions/${s.id}/plan/variants`, { headers: auth(s) });
  assert.strictEqual(after.body.stale, true, 'после правки план изменился — варианты помечены устаревшими');
});

/* ================= 1. конспект документа у думающей модели ================= */

test('конспект: пустой ответ с размышлениями → повтор с большим бюджетом; повторная неудача — событие в журнале, без третьей попытки', async () => {
  const { db, now } = require('../server/db');
  const crypto = require('crypto');
  const digest = require('../server/services/doc-digest');
  const sid = crypto.randomUUID();
  db.prepare('INSERT INTO sessions (id, token, status, created_at, updated_at) VALUES (?,?,?,?,?)').run(sid, 'tok-' + sid, 'idle', now(), now());
  const dir = path.join(process.env.DATA_DIR, 'uploads', sid);
  fs.mkdirSync(dir, { recursive: true });
  const stored = path.join(dir, 'tz.txt');
  fs.writeFileSync(stored, 'Техническое задание. '.repeat(400)); // > MIN_CHARS
  db.prepare('INSERT INTO files (id, session_id, original_name, stored_path, size, ext, mime, created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(crypto.randomUUID(), sid, 'ТЗ.txt', stored, fs.statSync(stored).size, 'txt', 'text/plain', now());

  const calls = [];
  const original = adapter.plainCall;
  try {
    // 1) первый вызов — только размышления, второй — конспект
    adapter.plainCall = async (opts) => {
      calls.push(opts.maxTokens);
      if (calls.length === 1) return { text: '', truncated: true, reasoning: 'думаю '.repeat(500) };
      return { text: '# Конспект ТЗ\nПлощадь застройки 1790 м².', truncated: false, reasoning: '' };
    };
    const route = { provider: 'lmstudio', model: 'qwen/qwen3.8-27b' };
    const r1 = await digest.ensureDigests(sid, { route, signal: null, onProgress: () => {} });
    assert.strictEqual(r1.made, 1, 'конспект составлен со второй попытки');
    assert.strictEqual(calls.length, 2);
    assert.ok(calls[1] > calls[0], 'повтор идёт с большим бюджетом ответа');
    assert.ok(calls.every((m) => Number.isFinite(m)));
    assert.match(fs.readFileSync(stored + '.digest.md', 'utf8'), /Конспект ТЗ/);

    // 2) конспект устарел (исходник новее) и оба вызова пустые — событие и память неудачи
    fs.unlinkSync(stored + '.digest.md');
    calls.length = 0;
    adapter.plainCall = async (opts) => { calls.push(opts.maxTokens); return { text: '', truncated: true, reasoning: 'думаю '.repeat(500) }; };
    const r2 = await digest.ensureDigests(sid, { route, signal: null, onProgress: () => {} });
    assert.strictEqual(r2.made, 0);
    assert.strictEqual(calls.length, 2, 'ровно две попытки, не больше');
    const ev = db.prepare("SELECT detail FROM events WHERE session_id = ? AND stage = 'Конспект документа не составлен'").all(sid);
    assert.strictEqual(ev.length, 1, 'об отказе сказано в журнале один раз');
    assert.match(ev[0].detail, /размышления/);
    // 3) третий прогон подряд не гоняет модель заново: неудача помнится
    calls.length = 0;
    const r3 = await digest.ensureDigests(sid, { route, signal: null, onProgress: () => {} });
    assert.strictEqual(r3.made, 0);
    assert.strictEqual(calls.length, 0, 'после неудачи многоминутный запрос не повторяется на каждом прогоне');
  } finally {
    adapter.plainCall = original;
  }
});


/* ================= круг 1: находки рецензии, API и геометрии ================= */

test('сетка колонн: прямоугольник, Г-форма, коридор, мультиполигон и дыра — контур находится, а не только на клине', () => {
  const rect = (x, y, w, h) => [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
  const cases = [
    ['квадрат 60×60 под 900', { type: 'polygon', closed: true, points: rect(0, 0, 60, 60) }, 900, 4],
    ['П-территория 6000 под 1790', { type: 'polygon', closed: true, points: [[0, 0], [100, 0], [100, 80], [70, 80], [70, 30], [30, 30], [30, 80], [0, 80]] }, 1790, 4],
    // Г-территория с рукавами 20 м (три ячейки по 6 м): прямоугольник 2376 м² не встаёт, Г-контур 13×12 − 10×9 ячеек — да
    ['Г-территория 20 м под 2376', { type: 'polygon', closed: true, points: [[0, 0], [100, 0], [100, 20], [20, 20], [20, 80], [0, 80]] }, 2376, 6],
    ['коридор 25×200 под 1800', { type: 'polygon', closed: true, points: rect(0, 0, 200, 25) }, 1800, 4],
    ['две доли 60×40 под 900', { type: 'multipolygon', polygons: [{ points: rect(0, 0, 60, 40), holes: [] }, { points: rect(100, 0, 60, 40), holes: [] }] }, 900, 4],
    ['с дырой 100×80−30×30 под 3000', { type: 'polygon', closed: true, points: rect(0, 0, 100, 80), holes: [rect(35, 25, 30, 30)] }, 3000, 6],
  ];
  for (const [name, geom, areaM2, bestCorners] of cases) {
    const area = jts.toJts(geom);
    const t0 = Date.now();
    const res = GS.generate(area, { areaM2, angleDeg: 0, origin: [0, 0], geometry: geom, limit: 6 });
    const ms = Date.now() - t0;
    assert.ok(res.length > 0, `${name}: контур по сетке обязан найтись`);
    assert.ok(ms < 3000, `${name}: ${ms} мс — слишком долго`);
    assert.strictEqual(res[0].corners, bestCorners, `${name}: лучший контур ${res[0].corners} углов вместо ${bestCorners}`);
    for (const r of res) {
      assert.ok(GS.isOrthogonal(r.points), `${name}: непрямые углы`);
      assert.ok(Math.abs(G.polygonArea(r.points) - areaM2) < Math.max(2, areaM2 * 0.001), `${name}: площадь ${G.polygonArea(r.points)}`);
      assert.ok(jts.toJts({ type: 'polygon', closed: true, points: r.points }).within(area), `${name}: контур вышел за территорию`);
      // минимальная ширина: буфер внутрь почти на ячейку не рвёт и не убивает фигуру
      const inner = jts.toJts({ type: 'polygon', closed: true, points: r.points }).buffer(-(r.cellM - 0.1));
      assert.ok(!inner.isEmpty() && inner.getNumGeometries() === 1, `${name}: есть перешеек или полоса уже двух ячеек`);
    }
  }
  // огромный участок: сетка честно пропускается с пометкой, а не молчит
  const notes = [];
  const big = GS.generate(jts.toJts({ type: 'polygon', closed: true, points: rect(0, 0, 600, 600) }), { areaM2: 1790, angleDeg: 0, origin: [0, 0], notes });
  assert.strictEqual(big.length, 0);
  assert.ok(notes.length === 1 && /не строился/.test(notes[0]), 'пропуск сетки объяснён');
});

test('углы: дубли и замыкающая точка не меняют счёт, NaN — не прямоугольник; k считается от номинального шага', () => {
  assert.strictEqual(GS.cornerCount([[0, 0], [10, 0], [10, 0], [10, 10], [0, 10], [0, 0]]), 4);
  assert.strictEqual(GS.cornerCount([[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]), 4);
  assert.ok(!GS.isOrthogonal([[0, 0], [NaN, 0], [10, 10], [0, 10]]));
  assert.ok(!GS.isOrthogonal([[1, 1], [1, 1], [1, 1], [1, 1]]));
  // 1790 м² → 50 ячеек по 5,983 м: блок обязан остаться 2×2 (11,97 м), а не 3×3
  const wedge = { type: 'polygon', closed: true, points: [[0, 0], [96, 22], [30, 78]] };
  const res = GS.generate(jts.toJts(wedge), { areaM2: 1790, angleDeg: 12.9, origin: [0, 0], geometry: wedge });
  assert.ok(res.length > 0);
  assert.ok(res.every((r) => r.cellM < 6 && r.cellM > 5.9));
});

test('посадка: заданная коробка не обрастает формами, поворот-пожелание даёт замечание, а не молчание', () => {
  const site = G.createSiteGeometry();
  site.parcel = G.makeObject({
    type: 'parcel', points: [[0, 0], [120, 0], [120, 90], [0, 90]], closed: true,
    provenance: { extractionMethod: 'user', confidence: 1 },
  });
  const box = P.generate(site, null, { width: 30, length: 40, areaM2: 1200, floors: 2 }, { limit: 60 });
  assert.ok(box.candidates.length >= 4, `коробка 30×40 обязана найти хотя бы четыре положения, нашла ${box.candidates.length}`);
  assert.ok(box.candidates.every((c) => c.shape === 'rect'), 'при заданных габаритах и площади форма не выдумывается');
  const turned = P.generate(site, null, { areaM2: 900, floors: 1, orientationDeg: 45, allowRotate: true }, { limit: 40 });
  assert.ok(turned.candidates.length > 0);
  const off = turned.candidates.filter((c) => c.angleDiff > 2);
  assert.ok(off.every((c) => c.warnings.some((w) => w.code === 'orientation')), 'кандидат с другим поворотом несёт замечание');
  const first = turned.candidates[0];
  assert.ok(first.angleDiff <= 2 || first.corners < Math.min(...turned.candidates.map((c) => c.corners)),
    'первым идёт кандидат с заданным поворотом (при равном числе углов)');
});

test('API: подтверждение чужого проекта, битая форма, тело без Content-Type и нестроки — честные 400/404, не 500', async () => {
  const s = await createSession();
  await api(`/api/sessions/${s.id}/files`, { method: 'POST', headers: auth(s), body: uploadForm([['топо.dxf', SITE_DXF, 'application/dxf']]) });
  // несуществующий проект в фильтре — тот же 404, что и чужой
  const nope = await api('/api/tz/projects?project=00000000-0000-4000-8000-000000000000', { headers: asUser() });
  assert.strictEqual(nope.status, 404, JSON.stringify(nope.body));
  // управляющий символ в имени файла: 400 по-русски, без стека
  const badName = 'bad' + String.fromCharCode(1) + 'name.txt';
  const raw = await fetch(`${base}/api/sessions/${s.id}/files`, {
    method: 'POST', headers: { ...auth(s), 'Content-Type': 'multipart/form-data; boundary=xx' },
    body: `--xx\r\nContent-Disposition: form-data; name="files"; filename="${badName}"\r\nContent-Type: text/plain\r\n\r\nabc\r\n--xx--\r\n`,
  });
  assert.strictEqual(raw.status, 400);
  // офис без тела
  const visit = await api('/api/office/visit', { method: 'POST' });
  assert.strictEqual(visit.status, 200, JSON.stringify(visit.body));
  // нестроки
  const plan = await api(`/api/sessions/${s.id}/plan`, { headers: auth(s) });
  const building = plan.body.plan.buildings[0];
  const badEdit = await api(`/api/sessions/${s.id}/plan/objects/${encodeURIComponent(building.id)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...auth(s) }, body: JSON.stringify({ label: { a: 1 } }),
  });
  assert.strictEqual(badEdit.status, 400);
  const badAnn = await api(`/api/sessions/${s.id}/annotations`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...auth(s) },
    body: JSON.stringify({ planId: plan.body.planId, geometryType: 'polygon', geometry: { points: [[0, 0], [1, 0], [1, 1]] }, comment: { a: 1 } }),
  });
  assert.strictEqual(badAnn.status, 400);
  const wrongPlan = await api(`/api/sessions/${s.id}/annotations`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...auth(s) },
    body: JSON.stringify({ planId: 'nope', geometryType: 'polygon', geometry: { points: [[0, 0], [1, 0], [1, 1]] }, comment: 'x' }),
  });
  assert.strictEqual(wrongPlan.status, 400, 'чужая версия плана не принимается');
  // вырожденные точки участка
  const flat = await api(`/api/sessions/${s.id}/plan/parcel-source`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...auth(s) }, body: JSON.stringify({ points: [[0, 0], [1, 0], [2, 0]] }),
  });
  assert.strictEqual(flat.status, 400);
  assert.match(flat.body.error, /площадь/);
  const huge = await api(`/api/sessions/${s.id}/plan/parcel-source`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...auth(s) }, body: JSON.stringify({ points: [[1e308, 0], [0, 1e308], [1e308, 1e308]] }),
  });
  assert.strictEqual(huge.status, 400);
  // сводка базы знаний для /api/health кэширована: два вызова подряд — один и тот же объект
  const kb = require('../server/services/kb');
  assert.strictEqual(kb.status(), kb.status(), 'сводка базы знаний не пересчитывается на каждый вызов');
  const health = await api('/api/health');
  assert.strictEqual(health.status, 200);
});


/* ================= круг 2: рецензия — граница, тонкие зоны, время ================= */

test('сетка колонн: ряд у прямой границы не теряется, тонкая полоса и дыра видны, большой участок считается быстро', () => {
  const rect = (x, y, w, h) => [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
  const gen = (geom, areaM2, extra = {}) => GS.generate(jts.toJts(geom), { areaM2, angleDeg: 0, origin: [0, 0], geometry: geom, limit: 6, ...extra });
  // корпус 12 м входит в полосу 13 м, квадрат 60×60 под 1790 — прямоугольник, а не Г
  const corridor = gen({ type: 'polygon', closed: true, points: rect(0, 0, 200, 13) }, 1800);
  assert.ok(corridor.length > 0 && corridor[0].corners === 4, `коридор 13 м: ${corridor.length} фигур, углов ${corridor[0] && corridor[0].corners}`);
  const square = gen({ type: 'polygon', closed: true, points: rect(0, 0, 60, 60) }, 1790);
  assert.ok(square.length > 0 && square[0].corners === 4, `квадрат 60×60 под 1790: углов ${square[0] && square[0].corners}`);
  // полоса зоны тоньше ячейки между рядами вершин и дыра меньше ячейки — контур не идёт поперёк
  const strip = { type: 'multipolygon', polygons: [{ points: rect(0, 0, 100, 40.2), holes: [] }, { points: rect(0, 41.8, 100, 38.2), holes: [] }] };
  for (const r of gen(strip, 900)) {
    assert.ok(jts.toJts({ type: 'polygon', closed: true, points: r.points }).within(jts.toJts(strip).buffer(0.002)), 'контур лёг поперёк полосы тоньше ячейки');
  }
  const holed = { type: 'polygon', closed: true, points: rect(0, 0, 100, 80), holes: [rect(50.5, 40.5, 3, 3)] };
  for (const r of gen(holed, 900)) {
    assert.ok(jts.toJts({ type: 'polygon', closed: true, points: r.points }).within(jts.toJts(holed).buffer(0.002)), 'контур накрыл дыру меньше ячейки');
  }
  // крупное здание на просторной площадке — доли секунды, а не десятки
  const t0 = Date.now();
  const big = gen({ type: 'polygon', closed: true, points: rect(0, 0, 350, 350) }, 20000);
  assert.ok(big.length > 0);
  assert.ok(Date.now() - t0 < 1500, `350×350 под 20 000 м²: ${Date.now() - t0} мс`);
  // клин 600 м: ячеек в габарите много, внутри — меньше потолка, сетка не пропускается
  const notes = [];
  const wedge = gen({ type: 'polygon', closed: true, points: [[0, 0], [600, 0], [0, 400]] }, 1790, { notes });
  assert.ok(wedge.length > 0, `клин 600 м: сетка пропущена (${notes[0] || 'без пометки'})`);
});

test('посадка: пятно вплотную к границе — без фантомных «выход на 0 м²» и «пересечение 0 м²»', () => {
  const site = G.createSiteGeometry();
  site.parcel = G.makeObject({
    type: 'parcel', points: [[2195900, 422300], [2195960, 422300], [2195960, 422340], [2195900, 422340]], closed: true,
    provenance: { extractionMethod: 'user', confidence: 1 },
  });
  // зона вплотную к пятну: общее ребро y = 422320 — касание, не пересечение
  site.restrictions = [{ id: 'z1', type: 'restriction', geometry: { type: 'polygon', closed: true, points: [[2195900, 422320], [2195960, 422320], [2195960, 422340], [2195900, 422340]] }, properties: { kind: 'setback', areaM2: 1200 }, provenance: {} }];
  const res = P.validate(site, [[2195900, 422300], [2195960, 422300], [2195960, 422320], [2195900, 422320]], { areaM2: 1200, allowReshape: true });
  assert.deepStrictEqual(res.violations, [], `касание границ дало нарушения: ${JSON.stringify(res.violations)}`);
});


/* ================= круг 3: границы по точкам, время, сверка дат ================= */

test('границы участка по точкам человека строятся: пары [x, y] — тот же участок, что из ГПЗУ', async () => {
  const parcelSource = require('../server/services/geometry/parcel-source');
  // настоящие поворотные точки ГПЗУ Горбунков, введённые человеком парами [x, y] чертежа
  const pts = [[2195897.76, 422352.83], [2195954.01, 422308.62], [2195973.10, 422286.62],
    [2195974.18, 422288.36], [2195984.16, 422322.63], [2195992.21, 422369.92]];
  const built = parcelSource.build({ points: pts, meta: { sourceDocument: 'введено вручную' } }, null);
  assert.ok(built.ok, `полигон не построен: ${built.errors.join(' ')}`);
  assert.ok(Math.abs(built.areaM2 - 3700) < 60, `площадь ${built.areaM2} м² вместо ≈3700`);
  assert.strictEqual(built.points.length, 6);
  // тот же участок из документа (колонки таблицы) — та же площадь
  const asDoc = pts.map(([x, y], i) => ({ label: String(i + 1), first: y, second: x }));
  const fromDoc = parcelSource.build({ points: asDoc, meta: { firstColumnMeans: 'X' } }, null);
  assert.ok(fromDoc.ok && Math.abs(fromDoc.areaM2 - built.areaM2) < 1, 'ручной ввод и документ дают разные участки');

  // и через маршрут: план получает участок, а не контур покрытия
  const s = await createSession();
  await api(`/api/sessions/${s.id}/files`, { method: 'POST', headers: auth(s), body: uploadForm([['топо.dxf', SITE_DXF, 'application/dxf']]) });
  const saved = await api(`/api/sessions/${s.id}/plan/parcel-source`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...auth(s) },
    body: JSON.stringify({ points: [[0, 0], [90, 0], [90, 70], [0, 70]] }),
  });
  assert.strictEqual(saved.status, 200, JSON.stringify(saved.body));
  const plan = await api(`/api/sessions/${s.id}/plan`, { headers: auth(s) });
  assert.ok(plan.body.plan.parcel, 'участок не подставлен в план');
  assert.ok(Math.abs(plan.body.plan.parcel.properties.areaM2 - 6300) < 5,
    `площадь участка ${plan.body.plan.parcel.properties.areaM2} м² вместо 6300 — точки человека не доехали`);
});

test('посадка: изрезанная дырами площадка и полоса под углом считаются за секунды, а не минуты', () => {
  const rect = (x, y, w, h) => [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
  let holed = jts.toJts({ type: 'polygon', closed: true, points: rect(0, 0, 350, 350) });
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let i = 0; i < 20; i++) {
    const w = 8 + rnd() * 20; const h = 8 + rnd() * 20; const x = 10 + rnd() * 300; const y = 10 + rnd() * 300;
    holed = holed.difference(jts.toJts({ type: 'polygon', closed: true, points: rect(x, y, w, h) }));
  }
  const geom = jts.fromJts(holed);
  const site = G.createSiteGeometry();
  site.parcel = G.makeObject({
    type: 'parcel', points: rect(-50, -50, 500, 500), closed: true,
    provenance: { extractionMethod: 'user', confidence: 1 },
  });
  for (const areaM2 of [600, 20000]) {
    const t0 = Date.now();
    const res = P.generate(site, { geometry: geom, areaM2: Math.round(jts.area(holed)) }, { areaM2, floors: 1 }, { limit: 100 });
    const ms = Date.now() - t0;
    assert.ok(ms < 8000, `площадка с 20 дырами под ${areaM2} м²: ${ms} мс`);
    for (const c of res.candidates) {
      assert.ok(jts.toJts({ type: 'polygon', closed: true, points: c.footprint.points }).within(holed.buffer(0.01)),
        `кандидат вышел за изрезанную территорию (${c.shape})`);
    }
  }
});

test('акты: сверка дат 5000 × 5000 укладывается в секунды и совпадает с полным перебором', () => {
  const D = require('../server/services/akty/dates');
  const WORKS = ['Устройство монолитной плиты', 'Армирование стены подвала', 'Бетонирование колонн',
    'Монтаж кирпичной кладки', 'Гидроизоляция фундамента', 'Устройство отмостки'];
  const mk = (n, headers, gen) => ({ headers, rows: Array.from({ length: n }, (_, i) => gen(i)), rowCount: n });
  const N = 5000;
  const acts = mk(N, ['Номер', 'Вид работ', 'Дата'], (i) => ({ Номер: String(i + 1), 'Вид работ': `${WORKS[i % WORKS.length]} на участке ${i % 97} захватка ${i % 53}`, Дата: `0${1 + (i % 9)}.05.2026` }));
  const jrn = mk(N, ['Дата', 'Содержание работ'], (i) => ({ Дата: `0${1 + (i % 9)}.05.2026`, 'Содержание работ': `${WORKS[i % WORKS.length]} на участке ${i % 97} захватка ${i % 53}` }));
  const t0 = Date.now();
  const res = D.compare(acts, jrn);
  const ms = Date.now() - t0;
  assert.ok(ms < 6000, `сверка 5000 × 5000: ${ms} мс — событийный цикл стоит слишком долго`);
  assert.strictEqual(res.rows.filter((r) => r.match_score > 0).length, N, 'пары потеряны индексом');
  // точность: на малом объёме индекс обязан совпасть с полным перебором
  const n2 = 200;
  const a2 = mk(n2, ['Номер', 'Вид работ', 'Дата'], (i) => ({ Номер: String(i + 1), 'Вид работ': `${WORKS[i % WORKS.length]} участок ${i % 17}`, Дата: '05.05.2026' }));
  const j2 = mk(n2, ['Дата', 'Содержание работ'], (i) => ({ Дата: '05.05.2026', 'Содержание работ': `${WORKS[(i + 3) % WORKS.length]} участок ${i % 17}` }));
  const viaIndex = D.compare(a2, j2).rows.filter((r) => r.match_score > 0).length;
  let brute = 0;
  for (const r of a2.rows) {
    let best = 0;
    for (const j of j2.rows) { const sc = D.similarity(r['Вид работ'], j['Содержание работ']); if (sc > best) best = sc; }
    if (best >= 0.5) brute++;
  }
  assert.strictEqual(viaIndex, brute, 'индекс по редким словам теряет пары, которые находит полный перебор');
});


test('сетка колонн: контуры строго внутри территории и не зависят от скорости машины', () => {
  const rot = (pts, d) => { const a = (d * Math.PI) / 180; return pts.map(([x, y]) => [x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a)]); };
  const cases = [
    ['клин @0', { type: 'polygon', closed: true, points: [[0, 0], [96, 22], [30, 78]] }, 1790, 0],
    ['П @33', { type: 'polygon', closed: true, points: rot([[0, 0], [100, 0], [100, 80], [70, 80], [70, 30], [30, 30], [30, 80], [0, 80]], 33) }, 1790, 33],
    ['МСК клин', { type: 'polygon', closed: true, points: [[2195904.9, 422351.1], [2195988.5, 422366.2], [2195981.2, 422323.3], [2195972.2, 422292.2], [2195956.3, 422310.6], [2195955.9, 422311]] }, 1790, 80.34],
  ];
  for (const [name, geom, areaM2, angleDeg] of cases) {
    const area = jts.toJts(geom);
    const origin = name === 'МСК клин' ? [2195904.9, 422292.2] : [0, 0];
    const res = GS.generate(area, { areaM2, angleDeg, origin, geometry: geom, limit: 6 });
    assert.ok(res.length > 0, `${name}: контуров нет`);
    for (const r of res) {
      // строго внутри, без допуска: вершины уже округлены до сантиметра
      const fp = jts.toJts({ type: 'polygon', closed: true, points: r.points });
      assert.ok(fp.within(area), `${name}: контур вышел за территорию на ${(jts.area(fp.difference(area)) * 10000).toFixed(2)} см²`);
    }
  }
  // бюджет считается работой, а не часами: занятая машина не меняет ответ
  const geom = { type: 'polygon', closed: true, points: [[0, 0], [96, 22], [30, 78]] };
  const area = jts.toJts(geom);
  const key = () => GS.generate(area, { areaM2: 1790, angleDeg: 12.9, origin: [0, 0], geometry: geom, limit: 6 })
    .map((r) => `${r.corners}:${r.points[0].join(',')}`).join('|');
  const first = key();
  const until = Date.now() + 250;
  while (Date.now() < until) { /* занимаем поток, как сосед по очереди геометрии */ }
  assert.strictEqual(key(), first, 'результат зависит от загрузки машины');
});
