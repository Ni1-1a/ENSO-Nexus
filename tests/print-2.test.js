'use strict';
/**
 * «Разбор PDF по форматам», доработка 06.10.2026: сортировка и разбивка НС
 * (А1), физические и приведённые листы (А2), парк принтеров и планировщик
 * (А3), тома и деление пакетов (А4), скачивание по билету и ZIP (А5),
 * переплёт (А6), модель сложенного листа (Б2), нормоконтроль тома (Б3).
 * PDF для тестов пишутся руками; текстовый слой — Type1 Helvetica с
 * Differences на afii-имена кириллицы: pdftotext отдаёт «Листов» и «Формат»
 * без встроенного шрифта.
 */
const os = require('os');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
process.env.DATA_DIR = path.join(os.tmpdir(), `pilot1-print2-${process.pid}`);
process.env.ANTHROPIC_API_KEY = '';
process.env.USERS_FILE = path.join(os.tmpdir(), `pilot1-print2-users-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
process.env.RATE_LIMIT_GENERAL = '1000';
process.env.RATE_LIMIT_EXPENSIVE = '1000';
process.env.PRINT_CHUNK_BYTES = '4000';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { createApp } = require('../server/app');
const formats = require('../server/services/print/formats');
const poppler = require('../server/services/print/pdfinfo');
const printers = require('../server/services/print/printers');
const volumes = require('../server/services/print/volumes');
const fold = require('../server/services/print/fold');
const binding = require('../server/services/print/binding');
const tomeCheck = require('../server/services/print/tome-check');
const { streamZip } = require('../server/services/print/zipstream');
const users = require('../server/services/users');

let server, base, popplerOk = false;

before(async () => {
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const tools = await poppler.available();
  popplerOk = tools.pdfinfo && tools.qpdf;
});
after(() => {
  server.close();
  fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
  fs.rmSync(process.env.USERS_FILE, { force: true });
});

const MM = 72 / 25.4;
const pt = (mm) => Math.round(mm * MM * 100) / 100;

/* ---------- PDF с текстовым слоем (кириллица через Differences) ---------- */

const CYR = { Л: 'afii10029', и: 'afii10074', с: 'afii10083', т: 'afii10084', о: 'afii10080', в: 'afii10067', Ф: 'afii10038', р: 'afii10082', м: 'afii10078', а: 'afii10065', А: 'afii10017', х: 'afii10093' };
const CHARS = Object.keys(CYR);
function encText(s) {
  return [...s].map((ch) => {
    const i = CHARS.indexOf(ch);
    const c = i < 0 ? ch.charCodeAt(0) : 128 + i;
    return c < 128 && /[A-Za-z0-9 ]/.test(ch) ? ch : `\\${c.toString(8).padStart(3, '0')}`;
  }).join('');
}

/**
 * Многостраничный PDF: [{ w, h (мм), rotate?, text?: [[x, y, строка]] }]. Балласт в
 * шапке — чтобы файл резался на несколько кусков (4000 байт).
 */
function makePdf(pages, pad = 9000) {
  const objs = [];
  const add = (body) => { objs.push(body); return objs.length; };
  add('<< /Type /Catalog /Pages 2 0 R >>');
  add('PAGES');
  const diffs = CHARS.map((ch, i) => `${128 + i} /${CYR[ch]}`).join(' ');
  const font = add(`<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding << /Type /Encoding /Differences [ ${diffs} ] >> >>`);
  const kids = [];
  for (const p of pages) {
    const content = (p.text || []).map(([x, y, s]) => `BT /F1 10 Tf ${pt(x)} ${pt(y)} Td (${encText(s)}) Tj ET`).join('\n');
    const c = add(`<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`);
    let dict = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pt(p.w)} ${pt(p.h)}] /Contents ${c} 0 R /Resources << /Font << /F1 ${font} 0 R >> >>`;
    if (p.rotate) dict += ` /Rotate ${p.rotate}`;
    dict += ' >>';
    kids.push(`${add(dict)} 0 R`);
  }
  objs[1] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pages.length} >>`;
  let out = `%PDF-1.4\n%\xe2\xe3\xcf\xd3\n%${'x'.repeat(pad)}\n`;
  const offsets = [];
  objs.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

/** Основная надпись: «Лист | Листов» с числами под ними и «Формат Ах» под рамкой. */
const titleBlock = (w, h, sheets, fmt) => [[w - 60, 30, 'Лист'], [w - 35, 30, 'Листов'], [w - 58, 22, '1'], [w - 30, 22, String(sheets)], [w - 95, 8, 'Формат'], [w - 80, 8, fmt]];
const formatOnly = (w, fmt) => [[w - 95, 8, 'Формат'], [w - 80, 8, fmt]];

/* ---------- REST ---------- */

const api = async (p, opts = {}) => {
  const res = await fetch(base + p, opts);
  let body = null;
  try { body = await res.clone().json(); } catch { body = await res.text(); }
  return { status: res.status, body, res };
};
async function login(lastName, firstName) {
  const { body } = await api('/api/auth/enter', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lastName, firstName }),
  });
  return body.token;
}
const H = (token, extra) => ({ 'X-User-Token': token, ...(extra || {}) });
const J = (token) => H(token, { 'Content-Type': 'application/json' });

async function uploadPdf(token, jobId, name, buf) {
  const { status, body } = await api(`/api/print/jobs/${jobId}/files`, { method: 'POST', headers: J(token), body: JSON.stringify({ name, size: buf.length }) });
  assert.strictEqual(status, 201, JSON.stringify(body));
  const file = body.file;
  for (let n = 0; n < file.chunks; n += 1) {
    const chunk = buf.subarray(n * file.chunkSize, Math.min(buf.length, (n + 1) * file.chunkSize));
    const r = await api(`/api/print/jobs/${jobId}/files/${file.id}/chunks/${n}`, { method: 'PUT', headers: H(token, { 'Content-Type': 'application/octet-stream' }), body: chunk });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  }
  return file;
}
async function waitDone(token, jobId) {
  for (let i = 0; i < 400; i += 1) {
    const { body } = await api(`/api/print/jobs/${jobId}`, { headers: H(token) });
    if (body.job.status !== 'running') return body.job;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('разбор не закончился');
}
async function runJob(token, settings, files) {
  const job = (await api('/api/print/jobs', { method: 'POST', headers: H(token) })).body.job;
  for (const [name, buf] of files) await uploadPdf(token, job.id, name, buf);
  const run = await api(`/api/print/jobs/${job.id}/run`, { method: 'POST', headers: J(token), body: JSON.stringify(settings) });
  assert.strictEqual(run.status, 202, JSON.stringify(run.body));
  const done = await waitDone(token, job.id);
  assert.strictEqual(done.status, 'done', done.error);
  return done;
}

/* ================= А1: порядок НС по ширине носителя, сортировка, разбивка ================= */

test('А1: НС-корзины идут по ширине носителя — листы, потом рулоны 297…960 вместе с плюсовыми', () => {
  const order = formats.bucketOrder();
  const nc = order.filter((b) => b.startsWith('НС '));
  assert.deepStrictEqual(nc, ['НС А4', 'НС А3', 'НС А3+', 'НС А2', 'НС А2+', 'НС А1', 'НС А1+', 'НС А0', 'НС А0+', 'НС 96']);
  assert.ok(order.indexOf('96') > order.indexOf('А0+') && order.indexOf('96') < order.indexOf('А4х3'), 'рулон 96 стоит после плюсовых и до кратных');
  assert.strictEqual(order[order.length - 1], formats.REVIEW_BUCKET);
  const widths = formats.carrierOrder().map((c) => c.width);
  assert.deepStrictEqual(widths, [210, 297, 297, 329, 420, 440, 594, 620, 841, 914, 960]);
});

test('А1: внутри НС-пакета — короткая сторона, потом отрез, потом файл и страница; стандарт и «по томам» — файл и страница', () => {
  const st = formats.defaults();
  const mk = (s, l, src, page) => ({ source: src, page, short: s, long: l, ...formats.classify(s, l, st) });
  const nc = [mk(297, 1500, '02', 1), mk(250, 1000, '01', 3), mk(297, 630, '03', 1), mk(297, 630, '01', 2)];
  const sortedNc = nc.slice().sort((a, b) => formats.compareRecords(a, b));
  assert.deepStrictEqual(sortedNc.map((r) => `${r.short}×${r.long} ${r.source}:${r.page}`), ['250×1000 01:3', '297×630 01:2', '297×630 03:1', '297×1500 02:1']);
  const byTome = nc.slice().sort((a, b) => formats.compareRecords(a, b, { byTome: true }));
  assert.deepStrictEqual(byTome.map((r) => `${r.source}:${r.page}`), ['01:2', '01:3', '02:1', '03:1']);
  const std = [mk(210, 297, '02', 1), mk(210, 297, '01', 9), mk(210, 297, '01', 10)];
  assert.deepStrictEqual(std.sort((a, b) => formats.compareRecords(a, b)).map((r) => `${r.source}:${r.page}`), ['01:9', '01:10', '02:1']);
});

test('А1: разбивка по размерам округляется до мм, склеивается в пределах допуска и идёт по ширине, потом по длине', () => {
  const recs = [{ short: 297.3, long: 841.2 }, { short: 297, long: 630 }, { short: 296.8, long: 841 }, { short: 250, long: 1000 }, { short: 297, long: 632.5 }];
  const sizes = formats.sizeBreakdown(recs, 3);
  assert.deepStrictEqual(sizes.map((s) => [s.label, s.count]), [['250×1000', 1], ['297×630', 2], ['297×841', 2]]);
  // без допуска 632,5 — отдельный размер
  assert.strictEqual(formats.sizeBreakdown(recs, 0).length, 4);
});

/* ================= А2: физические и приведённые листы ================= */

test('А2: физические листы А4/А3 считаются по носителю, приведённые — по площади с округлением НС вверх', () => {
  const st = formats.defaults();
  const mk = (s, l) => ({ source: 'a', page: 1, short: s, long: l, ...formats.classify(s, l, st) });
  const recs = [mk(210, 297), mk(210, 297), mk(148, 210), mk(200, 280), mk(297, 420), mk(297, 350), mk(594, 841), mk(700, 900), mk(1100, 1600)];
  const sum = formats.summarize(recs, { tolerance: 3 });
  assert.deepStrictEqual(sum.physical, { sheetsA4: 4, sheetsA3: 2 });
  // 1 + 1 + 0,5 + 1 (0,9 → 1) + 2 + 2 (1,67 → 2) + 8 + 11 (10,1 → 11); лист «требует решения» не считается
  assert.strictEqual(sum.reduced.a4, 26.5);
  assert.strictEqual(sum.reduced.a4Gost, 12.5);
  assert.strictEqual(sum.reduced.a4Nc, 14);
  assert.strictEqual(formats.reducedOf(mk(841, 1189)).a4, 16);
  assert.strictEqual(formats.reducedOf(mk(841, 1189)).a3, 8);
  const nc = sum.buckets.find((b) => b.bucket === 'НС А0');
  assert.deepStrictEqual(nc.sizes.map((s) => s.label), ['700×900']);
  assert.ok(sum.buckets.find((b) => b.bucket === 'А4').sizes.length === 0, 'у стандартной корзины разбивки по размерам нет');
});

/* ================= Б2: модель сложенного листа ================= */

test('Б2: схема ГОСТ 2.501-2013 Г.2 — панели, строки, слои и зона подшивки по форматам', () => {
  const g = (s, l) => fold.foldSheet(s, l);
  assert.deepStrictEqual([g(210, 297).maxLayers, g(148, 210).maxLayers, g(216, 279).maxLayers], [1, 1, 1], 'лист, помещающийся в А4, не складывают');
  const a3 = g(297, 420);
  assert.deepStrictEqual([a3.columns.map((c) => c.w), a3.rows, a3.maxLayers, a3.bindingLayers, a3.cornerExtra], [[105, 125, 190], [297], 3, 1, 0]);
  const a2 = g(420, 594);
  assert.deepStrictEqual([a2.columns.map((c) => c.w), a2.rows, a2.maxLayers, a2.bindingLayers, a2.cornerExtra], [[210, 192, 192], [297, 123], 6, 1, 1]);
  const a1 = g(594, 841);
  assert.deepStrictEqual([a1.columns.map((c) => c.w), a1.rows, a1.maxLayers, a1.bindingLayers, a1.cornerExtra], [[210, 125.5, 125.5, 190, 190], [297, 297], 10, 1, 1]);
  const a0 = g(841, 1189);
  assert.deepStrictEqual([a0.columns.map((c) => c.w), a0.rows, a0.maxLayers, a0.bindingLayers, a0.cornerExtra], [[210, 109.5, 109.5, 190, 190, 190, 190], [297, 297, 247], 21, 1, 2]);
  // профиль толщины: у кромки подшивки один слой на строку, дальше растёт
  assert.deepStrictEqual(a0.profile.map((p) => p.layers), [3, 15, 21]);
  // нестандарт и кратные считаются той же геометрией
  assert.strictEqual(g(594, 920).maxLayers, 10);
  assert.strictEqual(g(297, 630).maxLayers, 4);
  // без отгиба уголка поля подшивки всех строк ложатся друг на друга
  assert.strictEqual(fold.foldSheet(841, 1189, { diagonal: false }).bindingLayers, 3);
  // пресеты: владелец = ГОСТ + уголок (7, 11, 23), прикидка без загиба
  const table = fold.compareTable(formats.park.basic, binding.consumables.fold.presets.owner.table);
  const row = (f) => table.find((r) => r.format === f);
  for (const [f, gost, corner, owner, est] of [['А3', 3, 0, 3, 3], ['А2', 6, 1, 7, 6], ['А1', 10, 1, 11, 10], ['А0', 21, 2, 23, 21]]) {
    assert.deepStrictEqual([row(f).gost, row(f).gostCorner, row(f).owner, row(f).estimate], [gost, corner, owner, est], f);
    assert.strictEqual(row(f).gost + row(f).gostCorner, row(f).owner, `${f}: таблица владельца — это ГОСТ плюс уголок`);
  }
  assert.strictEqual(fold.layersBy('owner', 841, 1189, { table: binding.consumables.fold.presets.owner.table, format: 'А0' }).max, 23);
  assert.strictEqual(fold.layersBy('owner', 594, 920, { table: binding.consumables.fold.presets.owner.table, format: '' }).max, 10, 'у НС владельческой цифры нет — считается ГОСТ');
  const svg = fold.schemeSvg(841, 1189);
  assert.match(svg, /^<svg /);
  assert.match(svg, /1189×841 мм/);
});

/* ================= А6: переплёт ================= */

test('А6: толщина блока, пружина по таблице поставщика, деление на книги, закупка с копиями и запасом', () => {
  const st = binding.normalize({ copies: 2, binding: 'plastic', inserts: true, reservePct: 10 });
  const rec = (s, l, format) => ({ kind: format ? 'ГОСТ' : 'НС', format: format || '-', short: s, long: l });
  const recs = [...new Array(40).fill(0).map(() => rec(210, 297, 'А4')), ...new Array(5).fill(0).map(() => rec(594, 841, 'А1')), rec(841, 1189, 'А0')];
  const t = binding.tomeBinding({ fileId: 'f00000001', title: '01 АР', name: '01.pdf' }, recs, st);
  assert.strictEqual(t.layersMax, 40 + 50 + 21);
  assert.strictEqual(t.layersSpine, 46);
  assert.strictEqual(t.thicknessMaxMm, 11.1);
  assert.strictEqual(t.blockMm, 11.7);            // + обложка 0,18 + подложка 0,4
  assert.strictEqual(t.spring.diameterMm, 16);    // 117 листов-эквивалентов: 14 мм вмещает до 110, 16 мм — до 130
  assert.strictEqual(t.insertsPerBook, Math.ceil((11.1 - 4.6) / 0.4));
  const purchase = binding.purchase([t], st);
  assert.strictEqual(purchase.books, 2);
  assert.deepStrictEqual(purchase.springs.map((s) => [s.diameterMm, s.count, s.withReserve]), [[t.spring.diameterMm, 2, 3]]);
  assert.strictEqual(purchase.covers.withReserve, 3);
  assert.strictEqual(purchase.inserts.count, t.insertsPerBook * 2);
  // слишком толстый блок — деление на книги
  const big = new Array(200).fill(0).map(() => rec(841, 1189, 'А0'));
  const tb = binding.tomeBinding({ fileId: 'f00000002', title: 'big', name: 'b.pdf' }, big, binding.normalize({ binding: 'wire21' }));
  assert.ok(tb.books >= 2 && /разделить том/.test(tb.note), tb.note);
  assert.ok(tb.spring && tb.spring.diameterMm <= 32);
  // пресет владельца меняет слои
  const owner = binding.tomeBinding({ fileId: 'f00000003', title: 'o', name: 'o.pdf' }, [rec(841, 1189, 'А0')], binding.normalize({ foldPreset: 'owner' }));
  assert.strictEqual(owner.layersMax, 23);
  assert.throws(() => binding.normalize({ binding: 'glue' }), /plastic, wire31/);
  assert.throws(() => binding.normalize({ copies: 1000 }), /0 до 999/);
  assert.strictEqual(binding.normalize({ binding: 'folder' }).binding, 'folder');
  assert.strictEqual(binding.tomeBinding({ fileId: 'f00000004', title: 'f', name: 'f.pdf' }, recs, binding.normalize({ binding: 'folder' })).spring, null);
});

/* ================= А3: планировщик ================= */

const laser = { id: 'laser', name: 'Лазерный А4', type: 'sheet', enabled: true, factor: 1, uncertaintyPct: 10,
  sheet: { maxSheet: 'А4', duplex: true, color: false, ppmA4: { mono: 40, color: null }, ppmA3: { mono: null, color: null }, ipmDuplexA4: 34 },
  overhead: { warmupSec: 0, firstPageSec: 6, ripSecPerMb: 0, ripSecPerSheet: 0, cutSec: 0, rollChangeSec: 0 } };
const mfu = { id: 'mfu', name: 'МФУ А3', type: 'sheet', enabled: true, factor: 1, uncertaintyPct: 10,
  sheet: { maxSheet: 'А3', duplex: true, color: true, ppmA4: { mono: 35, color: 35 }, ppmA3: { mono: 17, color: 17 }, ipmDuplexA4: 35 },
  overhead: { warmupSec: 18, firstPageSec: 6, ripSecPerMb: 0, ripSecPerSheet: 0, cutSec: 0, rollChangeSec: 0 } };
const plotter = { id: 'plot', name: 'Плоттер 36″', type: 'roll', enabled: true, factor: 1, uncertaintyPct: 30,
  roll: { holders: 1, maxWidthMm: 914, loaded: [841], stock: [594, 841], modes: { draft: { secPerA1: 20 }, normal: null, best: null }, defaultMode: 'draft' },
  overhead: { warmupSec: 60, firstPageSec: 0, ripSecPerMb: 0, ripSecPerSheet: 0, cutSec: 0, rollChangeSec: 120 } };
const unit = (id, carrierKind, carrierBucket, rollWidth, pages, cuts, copies = 1) => ({ id, label: id, carrierKind, carrierBucket, rollWidth, pages, bytes: 0, cuts, copies });

test('А3: совместимость — лист помещается, рулон заряжен или на полке; скорость из паспорта; протяжка 594/t', () => {
  assert.strictEqual(printers.compatible(laser, unit('a3', 'sheet', 'А3', 0, 1, [])).ok, false, 'А3 на А4-принтер не помещается');
  assert.strictEqual(printers.compatible(mfu, unit('a4', 'sheet', 'А4', 0, 1, [])).ok, true);
  assert.strictEqual(printers.compatible(plotter, unit('a4', 'sheet', 'А4', 0, 1, [])).ok, false);
  assert.deepStrictEqual(printers.compatible(plotter, unit('a1', 'roll', 'А1', 594, 1, [841])), { ok: true, change: true });
  assert.deepStrictEqual(printers.compatible(plotter, unit('a0', 'roll', 'А0', 841, 1, [1189])), { ok: true, change: false });
  assert.match(printers.compatible(plotter, unit('96', 'roll', '96', 960, 1, [1400])).why, /шире/);
  assert.match(printers.compatible(plotter, unit('a2', 'roll', 'А2', 420, 1, [594])).why, /не заряжен/);
  // 40 стр/мин → 1,5 с на лист: 100 листов = 150 с + первая страница 6
  assert.strictEqual(Math.round(printers.duration(laser, unit('a4', 'sheet', 'А4', 0, 100, [])).sec), 156);
  // А1 поперёк на 841: 20 с на 594 мм протяжки → 29,7 мм/с; отрез 1189 мм → 40 с
  assert.strictEqual(Math.round(printers.duration(plotter, unit('a0', 'roll', 'А0', 841, 1, [1189])).sec), 40);
  assert.strictEqual(Math.round(printers.feedSpeed({ a1PerHour: 180 }) * 10) / 10, 29.7);
  // копии умножают объём
  assert.strictEqual(Math.round(printers.duration(laser, unit('a4', 'sheet', 'А4', 0, 100, [], 3)).sec), 456);
  // коэффициент калибровки
  assert.strictEqual(Math.round(printers.duration({ ...laser, factor: 1.5 }, unit('a4', 'sheet', 'А4', 0, 100, [])).sec), 234);
});

test('А3: LPT — корзину, которую берёт только один принтер, он и получает; смена рулона стоит времени; вилка ±', () => {
  const units = [unit('А4', 'sheet', 'А4', 0, 400, []), unit('А3', 'sheet', 'А3', 0, 100, []), unit('А1', 'roll', 'А1', 594, 10, new Array(10).fill(841)), unit('А0', 'roll', 'А0', 841, 10, new Array(10).fill(1189)), unit('96', 'roll', '96', 960, 1, [1400])];
  const plan = printers.schedule(units, [laser, mfu, plotter], { mode: 'normal' });
  const q = Object.fromEntries(plan.queues.map((x) => [x.printer.id, x]));
  assert.deepStrictEqual(q.mfu.queue.map((i) => i.unit), ['А3'], 'А3 печатает только МФУ');
  assert.deepStrictEqual(q.laser.queue.map((i) => i.unit), ['А4'], 'А4 ушёл на свободный лазерный, а не в хвост МФУ');
  assert.deepStrictEqual(q.plot.queue.map((i) => i.unit), ['А0', 'А1'], 'сначала заряженный рулон 841, потом смена на 594');
  assert.strictEqual(q.plot.queue[0].rollChangeSec, 0);
  assert.strictEqual(q.plot.queue[1].rollChangeSec, 120);
  assert.strictEqual(q.plot.queue[0].warmupSec, 60, 'прогрев один раз, у первого задания');
  assert.strictEqual(q.plot.rollChanges, 1);
  assert.strictEqual(plan.skipped.length, 1);
  assert.match(plan.skipped[0].why, /960/);
  assert.strictEqual(plan.makespanSec, Math.max(...plan.queues.map((x) => x.totalSec)));
  assert.ok(plan.lowSec < plan.makespanSec && plan.highSec > plan.makespanSec);
  assert.strictEqual(plan.machineSec, plan.queues.reduce((s, x) => s + x.totalSec, 0));
  // нет режима «обычный» в паспорте — берётся существующий, задание помечено режимом draft
  assert.strictEqual(q.plot.queue[0].mode, 'draft');
  // дуплекс: А4 на лазерном идёт по скорости изобр/мин, если включён
  const dup = printers.schedule([unit('А4', 'sheet', 'А4', 0, 340, [])], [laser], { duplex: true });
  assert.strictEqual(dup.queues[0].queue[0].parts.print, 600);
});

test('А3: парк — пресеты с источниками, общий парк правит владелец, личный свой; калибровка скользящим средним', async () => {
  for (const p of printers.presets) {
    assert.ok(p.source && /^https?:\/\//.test(p.source.url), `${p.id}: у пресета нет ссылки на паспорт`);
    assert.ok(p.source.note.length > 20, `${p.id}: нет строки паспорта`);
    assert.doesNotThrow(() => printers.validatePrinter(p, { preset: true }));
  }
  assert.throws(() => printers.validatePrinter({ id: 'xx', name: 'x', type: 'roll', roll: { holders: 1, maxWidthMm: 914, loaded: [], stock: [], modes: { draft: null } } }), /паспортн/);
  const token = await login('Печатников', 'Парк');
  const list = await api('/api/print/printers', { headers: H(token) });
  assert.strictEqual(list.status, 200);
  assert.strictEqual(list.body.printers.length, printers.presets.length, 'пустой парк офиса заполняется пресетами');
  assert.ok(list.body.printers.every((p) => p.scope === 'office'));
  // не владелец: общий парк не правит, личный — да
  const denied = await api('/api/print/printers', { method: 'POST', headers: J(token), body: JSON.stringify({ presetId: 'hp-designjet-t650-36', scope: 'office' }) });
  assert.strictEqual(denied.status, 403);
  const mine = await api('/api/print/printers', { method: 'POST', headers: J(token), body: JSON.stringify({ presetId: 'hp-designjet-t650-36', scope: 'personal', name: 'Мой плоттер' }) });
  assert.strictEqual(mine.status, 201, JSON.stringify(mine.body));
  assert.strictEqual(mine.body.printer.scope, 'personal');
  const pid = mine.body.printer.id;
  const upd = await api(`/api/print/printers/${pid}`, { method: 'PUT', headers: J(token), body: JSON.stringify({ ...mine.body.printer, roll: { ...mine.body.printer.roll, loaded: [594] } }) });
  assert.strictEqual(upd.status, 200, JSON.stringify(upd.body));
  assert.deepStrictEqual(upd.body.printer.roll.loaded, [594]);
  const cal = await api(`/api/print/printers/${pid}/calibrate`, { method: 'POST', headers: J(token), body: JSON.stringify({ estimatedSec: 1000, actualSec: 1200 }) });
  assert.strictEqual(cal.status, 200);
  assert.strictEqual(cal.body.printer.factor, 1.2);
  const cal2 = await api(`/api/print/printers/${pid}/calibrate`, { method: 'POST', headers: J(token), body: JSON.stringify({ estimatedSec: 1200, actualSec: 1200 }) });
  // отношение 1,0 при коэффициенте 1,2 → «сырое» 1,2; новое = 1,2·0,7 + 1,2·0,3 = 1,2
  assert.strictEqual(cal2.body.printer.factor, 1.2);
  assert.strictEqual(cal2.body.printer.history.length, 2);
  const officeDenied = await api(`/api/print/printers/${list.body.printers[0].id}/calibrate`, { method: 'POST', headers: J(token), body: JSON.stringify({ estimatedSec: 10, actualSec: 10 }) });
  assert.strictEqual(officeDenied.status, 403);
  assert.strictEqual((await api(`/api/print/printers/${pid}`, { method: 'DELETE', headers: H(token) })).status, 200);
  assert.strictEqual((await api('/api/print/printers', { headers: H(token) })).body.printers.length, printers.presets.length);
  // владелец правит общий парк
  const ownerToken = await login('Владелец', 'Парка');
  const me = users.byToken(ownerToken);
  // флаг владельца ставится руками в users.json — так же, как на проде; модуль перечитывает файл по времени правки
  const store = JSON.parse(fs.readFileSync(process.env.USERS_FILE, 'utf8'));
  store.users.find((x) => x.id === me.id).owner = true;
  fs.writeFileSync(process.env.USERS_FILE, JSON.stringify(store));
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(process.env.USERS_FILE, later, later);
  const office = await api('/api/print/printers', { method: 'POST', headers: J(ownerToken), body: JSON.stringify({ presetId: 'kyocera-taskalfa-3554ci', scope: 'office' }) });
  assert.strictEqual(office.status, 201, JSON.stringify(office.body));
  assert.strictEqual(office.body.printer.scope, 'office');
  assert.strictEqual((await api('/api/print/printers', { headers: H(token) })).body.printers.length, printers.presets.length + 1, 'общий парк виден всем');
});

/* ================= А4: тома, деление, карта сборки ================= */

test('А4: марка и номер тома из имени файла; имена пакетов; части', () => {
  const t = (n) => volumes.tomeOf({ id: 'f00000001', name: n });
  assert.deepStrictEqual([t('05_ЭНСО-21072023-Р-АР3_изм.0.pdf').mark, t('05_ЭНСО-21072023-Р-АР3_изм.0.pdf').num, t('05_ЭНСО-21072023-Р-АР3_изм.0.pdf').title], ['АР3', '05', '05 АР3']);
  assert.strictEqual(t('33_ЭНСО-21072023-Р-ОС.изм.0.pdf').mark, 'ОС');
  assert.strictEqual(t('15_ЭНСО–21072023-Р-ЭОМ_изм.1.pdf').mark, 'ЭОМ');
  assert.strictEqual(t('06_ЭНСО-21072023-Р-КЖ0_изм.4.pdf').mark, 'КЖ0');
  const bad = t('Чертежи.pdf');
  assert.strictEqual(bad.recognized, false);
  assert.strictEqual(bad.title, 'Чертежи');
  assert.strictEqual(volumes.packageName('А4', t('05_ЭНСО-21072023-Р-АР3_изм.0.pdf')), '05_АР3__А4.pdf');
  assert.strictEqual(volumes.packageName('НС А1', t('05_ЭНСО-21072023-Р-АР3_изм.0.pdf')), '05_АР3__НС_А1.pdf');
  assert.strictEqual(volumes.packageName('НС А3', t('05_ЭНСО-21072023-Р-АР3_изм.0.pdf'), { carrierSuffix: 'рулон297' }), '05_АР3__НС_А3_рулон297.pdf');
  assert.strictEqual(volumes.packageName('А4', null), 'ПАКЕТ_А4.pdf');
  assert.strictEqual(volumes.packageName('А4', bad), 'Чертежи__А4.pdf');
  assert.strictEqual(volumes.partName('05_АР3__А4.pdf', 2, 3), '05_АР3__А4__часть2из3.pdf');
});

test('А4: деление по пределу — двоичный поиск по страницам, лист больше предела — отдельным пакетом', async () => {
  let calls = 0;
  const measure = async (start, count) => { calls += 1; return count * 100; };
  const parts = await volumes.splitPlan(10, { maxBytes: 350, maxPages: 0 }, measure);
  assert.deepStrictEqual(parts.map((p) => [p.start, p.count, p.oversize]), [[0, 3, false], [3, 3, false], [6, 3, false], [9, 1, false]]);
  assert.ok(calls <= 14, `слишком много сборок: ${calls}`);
  const byPages = await volumes.splitPlan(7, { maxBytes: 0, maxPages: 3 }, measure);
  assert.deepStrictEqual(byPages.map((p) => p.count), [3, 3, 1]);
  const both = await volumes.splitPlan(10, { maxBytes: 250, maxPages: 3 }, measure);
  assert.deepStrictEqual(both.map((p) => p.count), [2, 2, 2, 2, 2]);
  // одна страница весит 500 при пределе 350 — отдельный пакет с пометкой
  const sizes = [100, 500, 100];
  const heavy = await volumes.splitPlan(3, { maxBytes: 350, maxPages: 0 }, async (s, c) => sizes.slice(s, s + c).reduce((a, b) => a + b, 0));
  assert.deepStrictEqual(heavy.map((p) => [p.count, p.oversize]), [[1, false], [1, true], [1, false]]);
});

test('А4 (REST): «по томам» — пакеты 01_АР__А4.pdf, части по страницам, карта сборки CSV и HTML по билету, записи сшиты', async (t) => {
  if (!popplerOk) { t.skip('poppler или qpdf не установлены'); return; }
  const token = await login('Томов', 'Тест');
  const a = makePdf([{ w: 210, h: 297 }, { w: 420, h: 297 }, { w: 210, h: 297 }, { w: 210, h: 297 }, { w: 841, h: 594 }]);
  const b = makePdf([{ w: 210, h: 297 }, { w: 594, h: 420 }]);
  const done = await runJob(token, { grouping: 'tomes', maxPackagePages: 2 }, [['01_ЭНСО-Р-АР_изм.1.pdf', a], ['02_ЭНСО-Р-КЖ1_изм.0.pdf', b]]);
  assert.strictEqual(done.summary.grouping, 'tomes');
  assert.strictEqual(done.tomes.length, 2);
  assert.deepStrictEqual(done.tomes.map((x) => x.title), ['01 АР', '02 КЖ1']);
  const names = done.packages.map((p) => p.file);
  assert.deepStrictEqual(names, ['01_АР__А4__часть1из2.pdf', '01_АР__А4__часть2из2.pdf', '01_АР__А3.pdf', '01_АР__А1.pdf', '02_КЖ1__А4.pdf', '02_КЖ1__А2.pdf']);
  assert.strictEqual(done.summary.parts, 2);
  const p1 = done.packages[0];
  assert.deepStrictEqual([p1.pages, p1.part, p1.tome.title, p1.carrierKind, p1.carrierBucket], [2, { index: 1, total: 2 }, '01 АР', 'sheet', 'А4']);
  assert.strictEqual(done.packages[3].cutMm, 841);
  // записи: страницы тома 1, 3, 4 (А4) → части 1из2 (стр. 1, 3) и 2из2 (стр. 4), без перестановки
  const recs = (await api(`/api/print/jobs/${done.id}?records=1`, { headers: H(token) })).body.records;
  const a4 = recs.filter((r) => r.source.startsWith('01') && r.bucket === 'А4').map((r) => [r.page, r.package, r.packagePage]);
  assert.deepStrictEqual(a4, [[1, '01_АР__А4__часть1из2.pdf', 1], [3, '01_АР__А4__часть1из2.pdf', 2], [4, '01_АР__А4__часть2из2.pdf', 1]]);
  const tk = (await api(`/api/print/jobs/${done.id}/tickets`, { method: 'POST', headers: H(token) })).body;
  assert.ok(tk.reports['карта_сборки.csv'] && tk.reports['карта_сборки.html'] && tk.reports['_ОТЧЁТ.csv'] && tk.reports['_ОТЧЁТ.json']);
  const csv = await fetch(base + tk.reports['карта_сборки.csv'].download);
  assert.strictEqual(csv.status, 200);
  assert.match(csv.headers.get('content-disposition'), /attachment; filename="[^"]*"; filename\*=UTF-8''%D0%BA%D0%B0%D1%80%D1%82%D0%B0_/);
  const text = Buffer.from(await csv.arrayBuffer()).toString('utf8').replace(/^﻿/, '');
  const lines = text.trim().split('\r\n');
  assert.strictEqual(lines[0], 'Том;Файл;Лист тома;Формат;Размер, мм;Пакет;Стр. в пакете;Корзина;Носитель');
  assert.strictEqual(lines.length, 1 + 7);
  assert.match(lines[2], /^01 АР;01_ЭНСО-Р-АР_изм\.1\.pdf;2;А3;420×297;01_АР__А3\.pdf;1;А3;/);
  const html = await fetch(base + tk.reports['карта_сборки.html'].url);
  assert.match(html.headers.get('content-type'), /text\/html/);
  assert.match(html.headers.get('content-disposition'), /^inline/);
  assert.match(await html.text(), /<h2>01 АР/);
  // пакет-часть открывается и содержит ровно свои страницы
  const part2 = await fetch(base + tk.packages.find((p) => p.file === '01_АР__А4__часть2из2.pdf').url);
  assert.strictEqual(part2.status, 200);
  const tmp = path.join(os.tmpdir(), `print2-part-${process.pid}.pdf`);
  fs.writeFileSync(tmp, Buffer.from(await part2.arrayBuffer()));
  assert.strictEqual((await poppler.inspect(tmp)).total, 1);
  fs.rmSync(tmp, { force: true });
  // целого пакета, который делили, на диске нет — место не удваивается
  const jobs = require('../server/services/print/jobs');
  const pkgDir = path.join(jobs.jobDir({ userKey: fs.readdirSync(path.join(process.env.DATA_DIR, 'print')).find((d) => fs.existsSync(path.join(process.env.DATA_DIR, 'print', d, done.id))), id: done.id }), 'packages');
  assert.ok(!fs.existsSync(path.join(pkgDir, '01_АР__А4.pdf')));
  assert.strictEqual(fs.readdirSync(pkgDir).length, 6);
});

test('А4 (REST): смешанная корзина — «НС А3» листом и рулоном — два пакета с суффиксом носителя', async (t) => {
  if (!popplerOk) { t.skip('poppler или qpdf не установлены'); return; }
  const token = await login('Смешанов', 'Тест');
  const done = await runJob(token, { grouping: 'buckets' }, [['01.pdf', makePdf([{ w: 350, h: 297 }, { w: 297, h: 1500 }, { w: 630, h: 297 }])]]);
  assert.deepStrictEqual(done.packages.map((p) => [p.file, p.pages, p.carrierKind, p.rollWidth]), [['ПАКЕТ_НС_А3_лист.pdf', 1, 'sheet', 0], ['ПАКЕТ_НС_А3_рулон297.pdf', 2, 'roll', 297]]);
  const b = done.summary.buckets.find((x) => x.bucket === 'НС А3');
  assert.strictEqual(b.carriers.length, 2);
  // 350×297 записан как короткая 297 × длинная 350 — в разбивке он первый
  assert.deepStrictEqual(b.sizes.map((s) => s.label), ['297×350', '297×630', '297×1500']);
});

/* ================= А5: скачивание по билету и ZIP ================= */

function parseZipCentral(buf) {
  // конец центрального каталога → записи
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd -= 1;
  assert.ok(eocd >= 0, 'нет EOCD');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let i = 0; i < count; i += 1) {
    assert.strictEqual(buf.readUInt32LE(off), 0x02014b50);
    const method = buf.readUInt16LE(off + 10);
    const crc = buf.readUInt32LE(off + 16);
    const size = buf.readUInt32LE(off + 24);
    const nameLen = buf.readUInt16LE(off + 28), extraLen = buf.readUInt16LE(off + 30), commentLen = buf.readUInt16LE(off + 32);
    const local = buf.readUInt32LE(off + 42);
    const name = buf.subarray(off + 46, off + 46 + nameLen).toString('utf8');
    entries.push({ name, method, crc, size, local });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

test('А5: ZIP без сжатия пишется потоком, читается стандартным разархиватором, байты файлов целы', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'print-zip-'));
  const big = Buffer.alloc(3 * 1024 * 1024 + 7);
  for (let i = 0; i < big.length; i += 4096) big[i] = i & 255;
  fs.writeFileSync(path.join(dir, 'a.pdf'), big);
  const small = Buffer.from('привет;мир\r\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'b.csv'), small);
  const chunks = [];
  const { Writable } = require('stream');
  const sink = new Writable({ write(c, e, cb) { chunks.push(Buffer.from(c)); cb(); } });
  const r = await streamZip(sink, [{ name: 'ПАКЕТ_А4.pdf', path: path.join(dir, 'a.pdf'), size: big.length }, { name: 'карта_сборки.csv', path: path.join(dir, 'b.csv'), size: small.length }]);
  const zip = Buffer.concat(chunks);
  assert.strictEqual(r.entries, 2);
  assert.strictEqual(zip.length, r.bytes);
  const entries = parseZipCentral(zip);
  assert.deepStrictEqual(entries.map((e) => [e.name, e.method, e.size]), [['ПАКЕТ_А4.pdf', 0, big.length], ['карта_сборки.csv', 0, small.length]]);
  const zlib = require('zlib');
  assert.strictEqual(entries[0].crc, zlib.crc32(big));
  // данные лежат сразу за локальным заголовком, байт в байт
  const e = entries[0];
  const nameLen = zip.readUInt16LE(e.local + 26), extraLen = zip.readUInt16LE(e.local + 28);
  const data = zip.subarray(e.local + 30 + nameLen + extraLen, e.local + 30 + nameLen + extraLen + big.length);
  assert.ok(data.equals(big));
  // системный unzip, если есть, тоже доволен
  const zipPath = path.join(dir, 't.zip');
  fs.writeFileSync(zipPath, zip);
  await new Promise((res) => execFile('unzip', ['-t', zipPath], (err, stdout) => {
    if (!err) assert.match(String(stdout), /No errors detected/);
    res();
  }));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('А5 (REST): «?dl=1» отдаёт вложение с кириллическим именем, отчёты и ZIP — по билету без входа', async (t) => {
  if (!popplerOk) { t.skip('poppler или qpdf не установлены'); return; }
  const token = await login('Скачивалов', 'Тест');
  const done = await runJob(token, {}, [['01_АР.pdf', makePdf([{ w: 210, h: 297 }, { w: 841, h: 594 }])]]);
  const tk = (await api(`/api/print/jobs/${done.id}/tickets`, { method: 'POST', headers: H(token) })).body;
  const pkg = tk.packages.find((p) => p.bucket === 'А1');
  assert.match(pkg.download, /\?dl=1$/);
  const inline = await fetch(base + pkg.url);
  assert.match(inline.headers.get('content-disposition'), /^inline; filename="[^"]*"; filename\*=UTF-8''%D0%9F%D0%90%D0%9A%D0%95%D0%A2_%D0%901\.pdf$/);
  const dl = await fetch(base + pkg.download);
  assert.strictEqual(dl.status, 200);
  assert.match(dl.headers.get('content-disposition'), /^attachment; filename="[^"]*\.pdf"; filename\*=UTF-8''%D0%9F%D0%90%D0%9A%D0%95%D0%A2_%D0%901\.pdf$/);
  assert.strictEqual(dl.headers.get('content-type'), 'application/pdf');
  assert.strictEqual(dl.headers.get('cache-control'), 'private, no-store');
  const csv = await fetch(base + tk.reports['_ОТЧЁТ.csv'].download);
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  assert.match(csv.headers.get('content-disposition'), /^attachment/);
  const js = await fetch(base + tk.reports['_ОТЧЁТ.json'].url);
  assert.strictEqual((await js.json()).pages.length, 2);
  assert.ok(tk.zip.endsWith('/all.zip'));
  const zipRes = await fetch(base + tk.zip);
  assert.strictEqual(zipRes.status, 200);
  assert.strictEqual(zipRes.headers.get('content-type'), 'application/zip');
  assert.match(zipRes.headers.get('content-disposition'), /^attachment; filename="[^"]*\.zip"; filename\*=UTF-8''/);
  const zip = Buffer.from(await zipRes.arrayBuffer());
  const names = parseZipCentral(zip).map((e) => e.name).sort();
  assert.deepStrictEqual(names, ['_ОТЧЁТ.csv', 'ПАКЕТ_А1.pdf', 'ПАКЕТ_А4.pdf'].sort());
  const sum = done.packages.reduce((s, p) => s + p.bytes, 0);
  assert.ok(zip.length > sum, 'архив не меньше суммы пакетов — без сжатия');
  // чужой билет — 404 на всё
  assert.strictEqual((await fetch(`${base}/api/print/p/${'0'.repeat(48)}/all.zip`)).status, 404);
  assert.strictEqual((await fetch(`${base}/api/print/p/${tk.ticket}/${encodeURIComponent('нет.pdf')}?dl=1`)).status, 404);
});

/* ================= А6 (REST) и А3 (REST): переплёт и время по разбору ================= */

test('А6+А3 (REST): переплёт по томам с правкой экземпляров, расчёт времени по пакетам, пропущенные с причиной', async (t) => {
  if (!popplerOk) { t.skip('poppler или qpdf не установлены'); return; }
  const token = await login('Переплётов', 'Тест');
  const done = await runJob(token, { grouping: 'tomes' }, [
    ['01_ЭНСО-Р-АР_изм.0.pdf', makePdf([{ w: 210, h: 297 }, { w: 594, h: 841 }, { w: 841, h: 1189 }])],
    ['02_ЭНСО-Р-КЖ1_изм.0.pdf', makePdf([{ w: 210, h: 297 }, { w: 1100, h: 1600 }])],
  ]);
  const fileId = done.tomes[1].fileId;
  const bd = await api(`/api/print/jobs/${done.id}/binding`, { method: 'POST', headers: J(token), body: JSON.stringify({ copies: 2, binding: 'plastic', perTome: { [fileId]: 5 } }) });
  assert.strictEqual(bd.status, 200, JSON.stringify(bd.body));
  assert.deepStrictEqual(bd.body.tomes.map((x) => [x.tome.title, x.sheets, x.copies, x.layersMax]), [['01 АР', 3, 2, 1 + 10 + 21], ['02 КЖ1', 2, 5, 1]]);
  assert.strictEqual(bd.body.purchase.books, 7);
  assert.strictEqual((await api(`/api/print/jobs/${done.id}`, { headers: H(token) })).body.job.binding.settings.copies, 2, 'настройки переплёта запомнены в разборе');
  const bad = await api(`/api/print/jobs/${done.id}/binding`, { method: 'POST', headers: J(token), body: JSON.stringify({ binding: 'glue' }) });
  assert.strictEqual(bad.status, 400);
  const sc = await api(`/api/print/jobs/${done.id}/schedule`, { method: 'POST', headers: J(token), body: JSON.stringify({ mode: 'draft' }) });
  assert.strictEqual(sc.status, 200, JSON.stringify(sc.body));
  assert.strictEqual(sc.body.copies, 2, 'экземпляры берутся из переплёта');
  const items = sc.body.queues.flatMap((q) => q.queue.map((i) => [i.unit, i.copies]));
  assert.ok(items.some(([u, c]) => u === '02_КЖ1__А4.pdf' && c === 5), 'поправка экземпляров тома дошла до расчёта времени');
  assert.ok(items.some(([u]) => u === '01_АР__А0.pdf'));
  assert.strictEqual(sc.body.skipped.length, 1, 'лист «требует решения» не распределяется');
  assert.match(sc.body.skipped[0].label, /ТРЕБУЕТ_РЕШЕНИЯ/);
  assert.ok(sc.body.makespanSec > 0 && sc.body.highSec >= sc.body.makespanSec);
});

/* ================= Б3: нормоконтроль тома ================= */

test('Б3: текстовый слой — «Листов» под заголовком и «Формат А3» справа от слова', async (t) => {
  if (!popplerOk) { t.skip('poppler не установлен'); return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'print-tc-'));
  const file = path.join(dir, 't.pdf');
  fs.writeFileSync(file, makePdf([{ w: 210, h: 297, text: titleBlock(210, 297, 3, 'А4') }, { w: 420, h: 297, text: formatOnly(420, 'A3') }, { w: 420, h: 297 }]));
  const xml = await new Promise((res, rej) => execFile(tomeCheck.PDFTOTEXT, ['-bbox', file, '-'], { maxBuffer: 1e7 }, (err, out) => (err ? rej(err) : res(out))));
  const pages = tomeCheck.parseBbox(xml);
  assert.strictEqual(pages.length, 3);
  assert.deepStrictEqual(tomeCheck.readTitleBlock(pages[0]), { sheetNo: { base: 1, sub: null, raw: '1' }, claimedSheets: 3, hasSheetsHeader: true, formatLabel: 'А4', hasText: true });
  assert.deepStrictEqual(tomeCheck.parseSheetNo('3.1'), { base: 3, sub: 1, raw: '3.1' });
  assert.deepStrictEqual(tomeCheck.parseSheetNo('3а'), { base: 3, sub: 'а', raw: '3а' });
  assert.deepStrictEqual(tomeCheck.readTitleBlock(pages[1]), { sheetNo: null, claimedSheets: null, hasSheetsHeader: false, formatLabel: 'А3', hasText: true }, 'латинская A приводится к кириллице');
  assert.deepStrictEqual(tomeCheck.readTitleBlock(pages[2]), { sheetNo: null, claimedSheets: null, hasSheetsHeader: false, formatLabel: '', hasText: false });
  // документы внутри файла — по графе «Лист»: 1 начинает, 2, 3 продолжают; шаблон с «Листов» на каждом листе не дробится
  const no = (raw) => tomeCheck.parseSheetNo(raw);
  const seq = [{ sheetNo: no('1'), claimedSheets: 10 }, { sheetNo: no('2'), claimedSheets: 10 }, { sheetNo: no('2.1'), claimedSheets: 10 }, { sheetNo: no('3'), claimedSheets: 10 }, { sheetNo: no('1'), claimedSheets: 1 }, { sheetNo: no('1'), claimedSheets: null, hasSheetsHeader: true }, { sheetNo: no('3'), claimedSheets: null }];
  const docs = tomeCheck.segmentDocuments(seq.map((x, i) => ({ page: i + 1 })), (r) => ({ hasText: true, hasSheetsHeader: true, ...seq[r.page - 1] }));
  assert.deepStrictEqual(docs.map((d) => [d.firstPage, d.pages.length, d.claimed, d.gaps.length]), [[1, 4, 10, 0], [5, 1, 1, 0], [6, 2, null, 1]], 'добавленный лист 2.1 продолжает документ, скачок 1 → 3 — разрыв нумерации');
  assert.strictEqual(tomeCheck.normFormat('А4х3'), 'А4х3');
  assert.strictEqual(tomeCheck.normFormat('A4x3'), 'А4х3');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Б3 (REST): Н1–Н5 на синтетике — объём, «Листов», «Формат», нестандарт, переплёт; скан — «не проверено»', async (t) => {
  if (!popplerOk) { t.skip('poppler или qpdf не установлены'); return; }
  const token = await login('Нормоконтролёров', 'Тест');
  // том 1: «Листов 3» и три страницы — сходится; второй лист подписан А4, а по факту А3 (Н3); третий — НС (Н4)
  const t1 = makePdf([{ w: 210, h: 297, text: titleBlock(210, 297, 3, 'А4') }, { w: 420, h: 297, text: formatOnly(420, 'А4') }, { w: 300, h: 500 }]);
  // том 2: «Листов 5», а страниц две (Н2)
  const t2 = makePdf([{ w: 210, h: 297, text: titleBlock(210, 297, 5, 'А4') }, { w: 210, h: 297, text: formatOnly(210, 'А4') }]);
  // том 3: без текстового слоя — не проверено
  const t3 = makePdf([{ w: 210, h: 297 }, { w: 210, h: 297 }]);
  // том 4: 40 листов А0 — больше 300 слоёв по модели (Н1), пружина не вмещает (Н5)
  const t4 = makePdf(new Array(16).fill(0).map(() => ({ w: 841, h: 1189 })), 500);
  const done = await runJob(token, { grouping: 'tomes' }, [['01_Р-АР_изм.0.pdf', t1], ['02_Р-КЖ_изм.0.pdf', t2], ['03_Р-ОВ_изм.0.pdf', t3], ['04_Р-ТХ_изм.0.pdf', t4]]);
  await api(`/api/print/jobs/${done.id}/binding`, { method: 'POST', headers: J(token), body: JSON.stringify({ binding: 'wire31' }) });
  const res = await api(`/api/print/jobs/${done.id}/tome-check`, { method: 'POST', headers: H(token) });
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  const r = res.body;
  assert.strictEqual(r.tomes.length, 4);
  const checks = (title) => r.findings.filter((f) => f.location.tome === title).map((f) => f.codes.check).sort();
  assert.deepStrictEqual(checks('01 АР'), ['Н3', 'Н4']);
  assert.deepStrictEqual(checks('02 КЖ'), ['Н2']);
  assert.deepStrictEqual(checks('03 ОВ'), ['Н2']);
  assert.deepStrictEqual(checks('04 ТХ'), ['Н1', 'Н2', 'Н5'], 'у растрового тома объём и переплёт считаются, «Листов» — не проверено');
  const n2 = r.findings.find((f) => f.codes.check === 'Н2' && f.location.tome === '02 КЖ');
  assert.deepStrictEqual([n2.codes.found, n2.codes.expected, n2.severity, n2.verification, n2.ntd, n2.ntd_clause], [5, 2, 'major', 'needs_human', 'ГОСТ Р 21.101-2020', 'приложение Ж (графа 8)']);
  assert.match(n2.wording, /указано 5, а в документе 2 л\./);
  assert.match(n2.ntd_quote, /графе 8 - общее количество листов/);
  const scan = r.findings.find((f) => f.location.tome === '03 ОВ');
  assert.strictEqual(scan.codes.reason, 'no_text_layer');
  assert.match(scan.wording, /нет текстового слоя/);
  const n3 = r.findings.find((f) => f.codes.check === 'Н3');
  assert.deepStrictEqual([n3.location.page, n3.codes.found, n3.codes.expected, n3.doc_quote], [2, 'А4', 'А3', 'Формат А4']);
  const n1 = r.findings.find((f) => f.codes.check === 'Н1');
  assert.deepStrictEqual([n1.rule_id, n1.ntd_clause, n1.codes.found], ['COM-CMP-009', '8.1.3', 16 * 21]);
  assert.match(n1.ntd_quote, /не более 300 листов формата А4/);
  const n5 = r.findings.find((f) => f.codes.check === 'Н5');
  assert.match(n5.wording, /толще самой большой пружины/);
  // формат модуля «Нормоконтроль»: обязательные поля у каждого замечания
  for (const f of r.findings) {
    for (const k of ['rule_id', 'origin', 'severity', 'verification', 'location', 'ntd', 'wording']) assert.ok(f[k] !== undefined && f[k] !== '', `${f.rule_id}: нет ${k}`);
    assert.ok(['critical', 'major', 'minor', 'remark'].includes(f.severity));
    assert.ok(['auto', 'needs_human'].includes(f.verification));
    assert.strictEqual(f.origin, 'deterministic');
  }
  assert.strictEqual(r.tomes.find((x) => x.tome.title === '01 АР').claimed[0].actual, 3);
  assert.strictEqual((await api(`/api/print/jobs/${done.id}`, { headers: H(token) })).body.job.tomeCheck.summary.findings, r.summary.findings, 'результат проверки запомнен в разборе');
});
