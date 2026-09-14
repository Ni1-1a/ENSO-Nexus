'use strict';
/**
 * Вкладка «Разбор PDF по форматам»: классификация по ГОСТ 2.301-68 (таблица
 * приёмки ТЗ §12 + А5 из РД), геометрия по боксам и /Rotate, разбор poppler,
 * загрузка кусками, конвейер до пакетов, билеты на вкладку, срок хранения.
 * PDF для тестов пишутся руками: страницы с MediaBox/CropBox/Rotate и пустым
 * содержимым — poppler их читает, режет и склеивает как настоящие.
 */
const os = require('os');
const path = require('path');
const fs = require('fs');
process.env.DATA_DIR = path.join(os.tmpdir(), `pilot1-print-${process.pid}`);
process.env.ANTHROPIC_API_KEY = '';
process.env.USERS_FILE = path.join(os.tmpdir(), `pilot1-print-users-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
process.env.RATE_LIMIT_GENERAL = '1000';
process.env.RATE_LIMIT_EXPENSIVE = '1000';
process.env.PRINT_CHUNK_BYTES = '1000';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { createApp } = require('../server/app');
const formats = require('../server/services/print/formats');
const poppler = require('../server/services/print/pdfinfo');
const jobs = require('../server/services/print/jobs');

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

/**
 * Минимальный многостраничный PDF: [{ w, h (мм), rotate?, crop? [мм] }].
 * Комментарий-балласт в шапке делает файл больше одного куска (1000 байт):
 * так проверяется сборка из нескольких кусков, а не один PUT.
 */
function makePdf(pages, pad = 2500) {
  const objs = [];
  const add = (body) => { objs.push(body); return objs.length; };
  add('<< /Type /Catalog /Pages 2 0 R >>');
  add('PAGES');
  const kids = [];
  for (const p of pages) {
    const c = add('<< /Length 0 >>\nstream\n\nendstream');
    let dict = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pt(p.w)} ${pt(p.h)}] /Contents ${c} 0 R /Resources << >>`;
    if (p.crop) dict += ` /CropBox [${p.crop.map(pt).join(' ')}]`;
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

/* ================= классификация: таблица приёмки ТЗ §12 ================= */

test('приёмка ТЗ §12: 21 лист ложится в ожидаемые корзины и носители', () => {
  const cases = [
    [210, 297, 'ГОСТ', 'А4', 'А4', 0],
    [420, 297, 'ГОСТ', 'А3', 'А3', 0],           // альбом — ориентация не влияет
    [594, 420, 'ГОСТ', 'А2', 'А2', 420],
    [841, 594, 'ГОСТ', 'А1', 'А1', 594],
    [1189, 841, 'ГОСТ', 'А0', 'А0', 841],
    [630, 297, 'ГОСТ кратный', 'А4х3', 'НС А3', 297],
    [1189, 420, 'ГОСТ кратный', 'А3х4', 'НС А2', 420],
    [200, 280, 'НС', '-', 'НС А4', 0],
    [350, 297, 'НС', '-', 'НС А3', 0],
    [297, 1500, 'НС', '-', 'НС А3', 297],
    [500, 400, 'НС', '-', 'НС А2', 420],
    [700, 900, 'НС', '-', 'НС А0', 841],
    [950, 1400, 'НС', '-', 'НС 96', 960],
    [1100, 1600, 'ОШИБКА', '-', '_ТРЕБУЕТ_РЕШЕНИЯ', 0],
    [841.89, 1189.2, 'ГОСТ', 'А0', 'А0', 841],
    [330, 240, 'А+', 'А4+', 'А4+', 0],
    [483, 329, 'А+', 'А3+', 'А3+', 420],
    [625, 440, 'А+', 'А2+', 'А2+', 594],
    [880, 620, 'А+', 'А1+', 'А1+', 841],
    [1292, 914, 'А+', 'А0+', 'А0+', 960],
  ];
  for (const [w, hh, kind, format, bucket, roll] of cases) {
    const short = Math.min(w, hh);
    const long = Math.max(w, hh);
    const c = formats.classify(short, long, formats.defaults());
    assert.strictEqual(c.kind, kind, `${w}×${hh}: класс`);
    assert.strictEqual(c.format, format, `${w}×${hh}: формат`);
    assert.strictEqual(c.bucket, bucket, `${w}×${hh}: корзина`);
    assert.strictEqual(c.rollWidth, roll, `${w}×${hh}: рулон`);
    if (roll) assert.strictEqual(c.cut, Math.round(long * 10) / 10, `${w}×${hh}: отрез = длинная сторона`);
  }
  // лист 297 с /Rotate 90 — тот же А4 (проверяется в геометрии ниже), лист 3 таблицы
  assert.strictEqual(formats.classify(Math.min(297, 210), Math.max(297, 210), formats.defaults()).format, 'А4');
});

test('А5 из РД — формат ГОСТ, корзина «А5», печать на листе А4; 594×920 и 297×594 — НС по короткой стороне', () => {
  const a5 = formats.classify(148, 210, formats.defaults());
  assert.deepStrictEqual([a5.kind, a5.format, a5.bucket, a5.rollWidth], ['ГОСТ', 'А5', 'А5', 0]);
  assert.match(a5.carrier, /лист А4/);
  const long1 = formats.classify(594, 920, formats.defaults());
  assert.deepStrictEqual([long1.kind, long1.bucket, long1.rollWidth, long1.cut], ['НС', 'НС А1', 594, 920]);
  const half = formats.classify(297, 594, formats.defaults());
  assert.deepStrictEqual([half.kind, half.bucket, half.rollWidth], ['НС', 'НС А3', 297]);
  // Letter 216×279 шире 210 — по правилу короткой стороны уходит на лист А3
  assert.strictEqual(formats.classify(216, 279, formats.defaults()).bucket, 'НС А3');
});

test('плюсовые рулоны и флаги папок: А3+ → 329 при plusRolls, кратные и плюсовые — в корзины НС по флагам', () => {
  const st = { ...formats.defaults(), plusRolls: true };
  assert.strictEqual(formats.classify(329, 483, st).rollWidth, 329);
  assert.strictEqual(formats.classify(440, 625, st).rollWidth, 440);
  assert.strictEqual(formats.classify(620, 880, st).rollWidth, 620);
  assert.strictEqual(formats.classify(914, 1292, st).rollWidth, 914);
  // стандартный А2 при плюсовых рулонах по-прежнему на 420, а не на 440
  assert.strictEqual(formats.classify(420, 594, st).rollWidth, 420);
  // НС 330 мм при плюсовых рулонах ложится на 329 (в допуске), корзина «НС А3+»
  assert.strictEqual(formats.classify(330, 700, st).bucket, 'НС А3+');
  assert.strictEqual(formats.classify(297, 630, { ...formats.defaults(), multiplesOwn: true }).bucket, 'А4х3');
  assert.strictEqual(formats.classify(329, 483, { ...formats.defaults(), plusOwn: false }).bucket, 'НС А2');
});

test('допуск и порядок проверки: за пределом допуска — НС; плюсовые проверяются после кратных', () => {
  assert.strictEqual(formats.classify(210, 301, { ...formats.defaults(), tolerance: 3 }).kind, 'НС');
  assert.strictEqual(formats.classify(210, 301, { ...formats.defaults(), tolerance: 5 }).format, 'А4');
  // 297×630 при допуске 20 совпадает и с А4х3, и (по короткой стороне) не с А3+ — кратный побеждает
  assert.strictEqual(formats.classify(297, 630, { ...formats.defaults(), tolerance: 20 }).kind, 'ГОСТ кратный');
});

test('настройки прогона: дефолты, строки-флаги, отказ на кривых значениях', () => {
  assert.deepStrictEqual(formats.normalizeSettings({}), formats.defaults());
  const st = formats.normalizeSettings({ tolerance: '2.5', box: 'media', scanOnly: 'true', plusOwn: false, plusRolls: 1 });
  assert.deepStrictEqual(st, { tolerance: 2.5, box: 'media', scanOnly: true, multiplesOwn: false, plusOwn: false, plusRolls: true });
  assert.throws(() => formats.normalizeSettings({ tolerance: 50 }), /0 до 20/);
  assert.throws(() => formats.normalizeSettings({ box: 'bleed' }), /crop, media, trim или art/);
});

test('сводка: корзины по порядку, метры по рулонам, CSV с BOM и «;»', () => {
  const st = formats.defaults();
  const mk = (s, l, src, page) => {
    const c = formats.classify(s, l, st);
    return { source: src, page, width: s, height: l, short: s, long: l, rotate: 0, box: 'cropbox', ...c, sheet: formats.sheetName(src, page, c.format, s, l), package: '', packagePage: 0 };
  };
  const recs = [mk(594, 841, 'a', 1), mk(210, 297, 'a', 2), mk(297, 1500, 'b', 1), mk(594, 841, 'b', 2)];
  const sum = formats.summarize(recs);
  assert.deepStrictEqual(sum.buckets.map((b) => b.bucket), ['А4', 'А1', 'НС А3']);
  assert.strictEqual(sum.buckets[1].count, 2);
  assert.deepStrictEqual(sum.rollMeters, [{ width: 297, meters: 1.5 }, { width: 594, meters: 1.7 }]);
  const csv = formats.toCsv(recs);
  assert.ok(csv.startsWith('﻿Исходный файл;Стр.;'));
  assert.match(csv, /\r\na;1;594;841;594;841;0;cropbox;ГОСТ;А1;А1;Плоттер, рулон 594 мм \(А2\/1\);594;841;;;a__стр001__А1__594x841мм;\r\n/);
});

/* ================= геометрия по боксам ================= */

test('габариты: /Rotate 90 меняет стороны, CropBox раньше MediaBox, нулевой бокс пропускается', () => {
  const boxes = { mediabox: [0, 0, pt(297), pt(210)], cropbox: [0, 0, pt(297), pt(210)] };
  const plain = formats.pageSizeMm(boxes, 0, 'crop');
  assert.deepStrictEqual([Math.round(plain.width), Math.round(plain.height), plain.box], [297, 210, 'cropbox']);
  const rot = formats.pageSizeMm(boxes, 90, 'crop');
  assert.deepStrictEqual([Math.round(rot.width), Math.round(rot.height)], [210, 297]);
  assert.strictEqual(formats.pageSizeMm(boxes, 270, 'crop').rotate, 270);
  assert.strictEqual(formats.pageSizeMm(boxes, -90, 'crop').rotate, 270);
  const withMargins = { mediabox: [0, 0, pt(224), pt(308)], cropbox: [pt(7), pt(5.5), pt(217), pt(302.5)] };
  assert.strictEqual(Math.round(formats.pageSizeMm(withMargins, 0, 'crop').width), 210);
  assert.strictEqual(Math.round(formats.pageSizeMm(withMargins, 0, 'media').width), 224);
  const zeroCrop = { mediabox: [0, 0, pt(210), pt(297)], cropbox: [0, 0, 0, 0] };
  assert.strictEqual(formats.pageSizeMm(zeroCrop, 0, 'crop').box, 'mediabox');
  assert.throws(() => formats.pageSizeMm({ mediabox: [0, 0, 0, 0] }, 0, 'crop'), /габариты/);
});

test('pdfinfo: страницы с боксами и /Rotate читаются, порча — понятная ошибка', async (t) => {
  if (!popplerOk) { t.skip('poppler или qpdf не установлены'); return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'print-pdf-'));
  const file = path.join(dir, 'к.pdf');
  fs.writeFileSync(file, makePdf([{ w: 210, h: 297 }, { w: 297, h: 210, rotate: 90 }, { w: 224, h: 308, crop: [7, 5.5, 217, 302.5] }]));
  const info = await poppler.inspect(file);
  assert.strictEqual(info.total, 3);
  assert.strictEqual(info.pages[1].rotate, 90);
  assert.strictEqual(Math.round(info.pages[2].boxes.cropbox[2] - info.pages[2].boxes.cropbox[0]), Math.round(pt(210)));
  fs.writeFileSync(path.join(dir, 'bad.pdf'), '%PDF-1.4 мусор');
  await assert.rejects(poppler.inspect(path.join(dir, 'bad.pdf')), /повреждён|не PDF/);
  fs.rmSync(dir, { recursive: true, force: true });
});

/* ================= REST: кусками до пакетов ================= */

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

async function uploadPdf(token, jobId, name, buf) {
  const { status, body } = await api(`/api/print/jobs/${jobId}/files`, {
    method: 'POST', headers: H(token, { 'Content-Type': 'application/json' }), body: JSON.stringify({ name, size: buf.length }),
  });
  assert.strictEqual(status, 201, JSON.stringify(body));
  const file = body.file;
  for (let n = 0; n < file.chunks; n += 1) {
    const chunk = buf.subarray(n * file.chunkSize, Math.min(buf.length, (n + 1) * file.chunkSize));
    const r = await api(`/api/print/jobs/${jobId}/files/${file.id}/chunks/${n}`, {
      method: 'PUT', headers: H(token, { 'Content-Type': 'application/octet-stream' }), body: chunk,
    });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    if (n === file.chunks - 1) assert.strictEqual(r.body.file.complete, true);
  }
  return file;
}

async function waitDone(token, jobId) {
  for (let i = 0; i < 200; i += 1) {
    const { body } = await api(`/api/print/jobs/${jobId}`, { headers: H(token) });
    if (body.job.status !== 'running') return body.job;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('разбор не закончился');
}

test('без входа — 401; парк отдаёт таблицы и лимиты', async () => {
  assert.strictEqual((await api('/api/print/park')).status, 401);
  const token = await login('Печатников', 'Тест');
  const { status, body } = await api('/api/print/park', { headers: H(token) });
  assert.strictEqual(status, 200);
  assert.deepStrictEqual(body.park.basic['А5'], [148, 210]);
  assert.strictEqual(body.limits.chunkBytes, 1000);
  assert.strictEqual(body.defaults.tolerance, 3);
  assert.strictEqual(typeof body.tools.qpdf, 'boolean');
});

test('qpdf: список страниц сворачивается в диапазоны', () => {
  assert.strictEqual(poppler.rangeSpec([3, 1, 2, 7, 10, 9, 9]), '1-3,7,9-10');
  assert.strictEqual(poppler.rangeSpec([5]), '5');
});

test('загрузка кусками: неверный размер куска — 400, повтор куска безвреден, чужой разбор — 404', async () => {
  const token = await login('Кусков', 'Тест');
  const { status, body } = await api('/api/print/jobs', { method: 'POST', headers: H(token) });
  assert.strictEqual(status, 201);
  const job = body.job;
  const buf = makePdf([{ w: 210, h: 297 }]);
  assert.ok(buf.length > 1000, 'файл должен резаться минимум на два куска');

  const notPdf = await api(`/api/print/jobs/${job.id}/files`, {
    method: 'POST', headers: H(token, { 'Content-Type': 'application/json' }), body: JSON.stringify({ name: 'схема.dwg', size: 10 }),
  });
  assert.strictEqual(notPdf.status, 400);

  const add = await api(`/api/print/jobs/${job.id}/files`, {
    method: 'POST', headers: H(token, { 'Content-Type': 'application/json' }), body: JSON.stringify({ name: 'лист.pdf', size: buf.length }),
  });
  const file = add.body.file;
  const short = await api(`/api/print/jobs/${job.id}/files/${file.id}/chunks/0`, {
    method: 'PUT', headers: H(token, { 'Content-Type': 'application/octet-stream' }), body: buf.subarray(0, 10),
  });
  assert.strictEqual(short.status, 400);
  assert.match(short.body.error, /ожидалось 1000 байт/);
  const out = await api(`/api/print/jobs/${job.id}/files/${file.id}/chunks/9`, {
    method: 'PUT', headers: H(token, { 'Content-Type': 'application/octet-stream' }), body: buf.subarray(0, 1000),
  });
  assert.strictEqual(out.status, 400);
  // не хватает кусков — запуск отказывает по имени файла
  const early = await api(`/api/print/jobs/${job.id}/run`, { method: 'POST', headers: H(token, { 'Content-Type': 'application/json' }), body: '{}' });
  assert.strictEqual(early.status, 409);
  assert.match(early.body.error, /лист\.pdf/);

  for (let n = 0; n < file.chunks; n += 1) {
    const chunk = buf.subarray(n * 1000, Math.min(buf.length, (n + 1) * 1000));
    const r = await api(`/api/print/jobs/${job.id}/files/${file.id}/chunks/${n}`, {
      method: 'PUT', headers: H(token, { 'Content-Type': 'application/octet-stream' }), body: chunk,
    });
    assert.strictEqual(r.status, 200);
  }
  // повтор первого куска — файл остаётся целым и собранным
  const again = await api(`/api/print/jobs/${job.id}/files/${file.id}/chunks/0`, {
    method: 'PUT', headers: H(token, { 'Content-Type': 'application/octet-stream' }), body: buf.subarray(0, 1000),
  });
  assert.strictEqual(again.body.file.complete, true);
  const stored = fs.readFileSync(path.join(process.env.DATA_DIR, 'print', fs.readdirSync(path.join(process.env.DATA_DIR, 'print')).find((d) => fs.existsSync(path.join(process.env.DATA_DIR, 'print', d, job.id))), job.id, 'src', `${file.id}.pdf`));
  assert.ok(stored.equals(buf), 'собранный файл байт в байт равен исходному');

  const other = await login('Чужой', 'Человек');
  assert.strictEqual((await api(`/api/print/jobs/${job.id}`, { headers: H(other) })).status, 404);
  assert.strictEqual((await api(`/api/print/jobs/${job.id}/files/${file.id}/chunks/0`, {
    method: 'PUT', headers: H(other, { 'Content-Type': 'application/octet-stream' }), body: buf.subarray(0, 1000),
  })).status, 404);
});

test('конвейер: два файла → корзины, пакеты по порядку, билет открывает PDF, отчёты, все листы', async (t) => {
  if (!popplerOk) { t.skip('poppler или qpdf не установлены'); return; }
  const token = await login('Конвейеров', 'Тест');
  const job = (await api('/api/print/jobs', { method: 'POST', headers: H(token) })).body.job;
  // файл «02»: А4, А3 альбом, А1; файл «01»: А4 с /Rotate 90, кратный А4х3, НС 250×1000, А5, широкий лист
  await uploadPdf(token, job.id, '02_КЖ.pdf', makePdf([{ w: 210, h: 297 }, { w: 420, h: 297 }, { w: 841, h: 594 }]));
  await uploadPdf(token, job.id, '01_АР.pdf', makePdf([{ w: 297, h: 210, rotate: 90 }, { w: 630, h: 297 }, { w: 250, h: 1000 }, { w: 148, h: 210 }, { w: 1100, h: 1600 }]));
  await uploadPdf(token, job.id, '03_битый.pdf', Buffer.from('%PDF-1.4 это не документ, а мусор для проверки устойчивости'));

  const run = await api(`/api/print/jobs/${job.id}/run`, {
    method: 'POST', headers: H(token, { 'Content-Type': 'application/json' }), body: JSON.stringify({ tolerance: 3 }),
  });
  assert.strictEqual(run.status, 202, JSON.stringify(run.body));
  const done = await waitDone(token, job.id);
  assert.strictEqual(done.status, 'done', done.error);
  assert.strictEqual(done.summary.pages, 8);
  assert.strictEqual(done.summary.files, 3);
  assert.strictEqual(done.problems.length, 1);
  assert.match(done.problems[0], /03_битый\.pdf/);
  const buckets = Object.fromEntries(done.summary.buckets.map((b) => [b.bucket, b]));
  assert.strictEqual(buckets['А4'].count, 2, 'А4 из обоих файлов, включая повёрнутый');
  assert.strictEqual(buckets['А5'].count, 1);
  assert.strictEqual(buckets['А3'].count, 1);
  assert.strictEqual(buckets['А1'].count, 1);
  assert.strictEqual(buckets['НС А3'].count, 2, 'кратный А4х3 и 250×1000 — на рулон 297');
  assert.strictEqual(buckets['_ТРЕБУЕТ_РЕШЕНИЯ'].count, 1);
  assert.deepStrictEqual(done.summary.rollMeters.map((r) => r.width), [297, 594]);
  assert.strictEqual(done.summary.rollMeters[0].meters, 1.6, '630 + 1000 мм отреза на рулоне 297');
  assert.strictEqual(done.packages.length, 6);
  const a4 = done.packages.find((p) => p.bucket === 'А4');
  assert.strictEqual(a4.pages, 2);
  assert.strictEqual(a4.file, 'ПАКЕТ_А4.pdf');

  // записи: порядок в пакете — файл по имени (01 раньше 02), потом страница
  const withRecords = (await api(`/api/print/jobs/${job.id}?records=1`, { headers: H(token) })).body;
  const a4rows = withRecords.records.filter((r) => r.bucket === 'А4').sort((a, b) => a.packagePage - b.packagePage);
  assert.deepStrictEqual(a4rows.map((r) => [r.source, r.page, r.packagePage]), [['01_АР.pdf', 1, 1], ['02_КЖ.pdf', 1, 2]]);
  assert.strictEqual(a4rows[0].rotate, 90);
  assert.strictEqual(a4rows[0].sheet, '01_АР__стр001__А4__210x297мм');

  // билет: пакет отдаётся во вкладку без заголовка входа, чужой билет — 404
  const tk = (await api(`/api/print/jobs/${job.id}/tickets`, { method: 'POST', headers: H(token) })).body;
  assert.ok(/^[a-f0-9]{48}$/.test(tk.ticket));
  const pkgUrl = tk.packages.find((p) => p.bucket === 'НС А3').url;
  const pdf = await fetch(base + pkgUrl);
  assert.strictEqual(pdf.status, 200);
  assert.strictEqual(pdf.headers.get('content-type'), 'application/pdf');
  assert.match(pdf.headers.get('content-disposition'), /^inline;/);
  const bytes = Buffer.from(await pdf.arrayBuffer());
  assert.ok(bytes.subarray(0, 5).toString() === '%PDF-');
  const tmp = path.join(os.tmpdir(), `print-pkg-${process.pid}.pdf`);
  fs.writeFileSync(tmp, bytes);
  assert.strictEqual((await poppler.inspect(tmp)).total, 2);
  fs.rmSync(tmp, { force: true });
  assert.strictEqual((await fetch(`${base}/api/print/p/${'0'.repeat(48)}/${encodeURIComponent('ПАКЕТ_А4.pdf')}`)).status, 404);
  assert.strictEqual((await fetch(`${base}/api/print/p/${tk.ticket}/..%2Fjob.json`)).status, 404);

  // отчёты
  const csv = await fetch(`${base}/api/print/jobs/${job.id}/report.csv`, { headers: H(token) });
  assert.strictEqual(csv.status, 200);
  // fetch().text() срезает BOM — проверяем байты
  const raw = Buffer.from(await csv.arrayBuffer());
  assert.deepStrictEqual([...raw.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'CSV начинается с BOM — Excel откроет без диалога кодировок');
  const text = raw.toString('utf8').replace(/^\ufeff/, '');
  assert.ok(text.startsWith('Исходный файл;'));
  assert.strictEqual(text.trim().split('\r\n').length, 9, 'заголовок + 8 листов');
  const js = (await api(`/api/print/jobs/${job.id}/report.json`, { headers: H(token) })).body;
  assert.strictEqual(js.pages.length, 8);
  assert.strictEqual(js.settings.tolerance, 3);

  // текущий разбор человека — этот; новый разбор стирает его вместе с пакетами
  assert.strictEqual((await api('/api/print/jobs', { headers: H(token) })).body.job.id, job.id);
  const fresh = (await api('/api/print/jobs', { method: 'POST', headers: H(token) })).body.job;
  assert.notStrictEqual(fresh.id, job.id);
  assert.strictEqual((await api(`/api/print/jobs/${job.id}`, { headers: H(token) })).status, 404);
  assert.strictEqual((await fetch(base + pkgUrl)).status, 404, 'билет старого разбора мёртв');
});

test('только анализ: корзины есть, пакетов нет; смена состава сбрасывает результат', async (t) => {
  if (!popplerOk) { t.skip('poppler или qpdf не установлены'); return; }
  const token = await login('Аналитиков', 'Тест');
  const job = (await api('/api/print/jobs', { method: 'POST', headers: H(token) })).body.job;
  await uploadPdf(token, job.id, 'а.pdf', makePdf([{ w: 594, h: 420 }]));
  const run = await api(`/api/print/jobs/${job.id}/run`, {
    method: 'POST', headers: H(token, { 'Content-Type': 'application/json' }), body: JSON.stringify({ scanOnly: true }),
  });
  assert.strictEqual(run.status, 202);
  const done = await waitDone(token, job.id);
  assert.strictEqual(done.status, 'done');
  assert.strictEqual(done.summary.buckets[0].bucket, 'А2');
  assert.deepStrictEqual(done.packages, []);
  assert.strictEqual((await api(`/api/print/jobs/${job.id}/tickets`, { method: 'POST', headers: H(token) })).body.packages.length, 0);
  await uploadPdf(token, job.id, 'б.pdf', makePdf([{ w: 210, h: 297 }]));
  const after = (await api(`/api/print/jobs/${job.id}`, { headers: H(token) })).body.job;
  assert.strictEqual(after.status, 'new');
  assert.strictEqual(after.summary, null);
  assert.strictEqual((await api(`/api/print/jobs/${job.id}/report.csv`, { headers: H(token) })).status, 409);
});

test('место на диске: при нехватке файл не принимается — 507 с числами', () => {
  const config = require('../server/config');
  const user = { id: 'u_disk', lastName: 'Дисков', firstName: 'Тест' };
  const job = jobs.createJob(user);
  const saved = config.printMinFreeBytes;
  config.printMinFreeBytes = Number.MAX_SAFE_INTEGER; // любой свободный объём меньше порога
  try {
    assert.throws(() => jobs.addFile(job, { name: 'а.pdf', size: 1000 }), (err) => err.status === 507 && /мало места/.test(err.message));
  } finally { config.printMinFreeBytes = saved; }
  assert.strictEqual(jobs.addFile(job, { name: 'а.pdf', size: 1000 }).chunks, 1);
  jobs.deleteJob(job);
});

test('уборка: старый разбор удаляется по сроку, «running» после перезапуска помечается прерванным', () => {
  const user = { id: 'u_sweep', lastName: 'Уборкин', firstName: 'Тест' };
  const old = jobs.createJob(user);
  const dir = path.join(process.env.DATA_DIR, 'print', 'u_sweep', old.id);
  const stale = JSON.parse(fs.readFileSync(path.join(dir, 'job.json'), 'utf8'));
  stale.updatedAt = new Date(Date.now() - 30 * 3600 * 1000).toISOString();
  fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify(stale));
  assert.strictEqual(jobs.sweep(24).removed, 1);
  assert.ok(!fs.existsSync(dir));

  const user2 = { id: 'u_int', lastName: 'Прерванов', firstName: 'Тест' };
  const running = jobs.createJob(user2);
  const dir2 = path.join(process.env.DATA_DIR, 'print', 'u_int', running.id);
  const j = JSON.parse(fs.readFileSync(path.join(dir2, 'job.json'), 'utf8'));
  j.status = 'running';
  fs.writeFileSync(path.join(dir2, 'job.json'), JSON.stringify(j));
  assert.strictEqual(jobs.sweep(24).interrupted, 1);
  assert.strictEqual(jobs.getJob(user2, running.id).status, 'interrupted');
  jobs.deleteJob(jobs.getJob(user2, running.id));
});

/* ================= разметка ================= */

test('страница print.html — отдельная вкладка: вход, свои стили, без каркаса проектов; дверь на главной', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'print.html'), 'utf8');
  assert.match(html, /<body data-page="print">/);
  assert.match(html, /id="auth-screen"/);
  assert.match(html, /auth\.js\?v=\d+/);
  assert.match(html, /print\.js\?v=\d+/);
  assert.match(html, /print\.css\?v=\d+/);
  assert.ok(!/shell\.js/.test(html), 'вкладка живёт вне каркаса проектов, как виртуальный офис');
  for (const id of ['pr-dz', 'pr-input-dir', 'pr-tol', 'pr-box', 'pr-scan', 'pr-mult', 'pr-plus', 'pr-plus-rolls', 'pr-run', 'pr-buckets', 'pr-rolls', 'pr-csv', 'pr-json']) {
    assert.ok(html.includes(`id="${id}"`), `нет элемента ${id}`);
  }
  const styles = /styles\.css\?v=(\d+)/.exec(fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8'))[1];
  assert.ok(html.includes(`styles.css?v=${styles}`), 'версия styles.css на вкладке та же, что на главной');

  const hub = fs.readFileSync(path.join(__dirname, '..', 'public', 'hub.js'), 'utf8');
  assert.match(hub, /id="print-door" href="print\.html"/);
  const index = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.ok(Number(/hub\.js\?v=(\d+)/.exec(index)[1]) >= 10, 'hub.js правился — версия должна вырасти');

  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'print.js'), 'utf8');
  assert.match(js, /chunks\/\$\{n\}/, 'загрузка кусками');
  assert.match(js, /window\.open\(''/, 'окно пакета открывается в обработчике клика, до запроса билета');
});
