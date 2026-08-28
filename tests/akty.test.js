'use strict';
/* Вкладка «Акты (АОСР)»: чтение XLSX, конвейер черновиков из шаблона,
 * сверка дат акт↔журнал. Всё детерминировано — моделей в тестах нет вовсе. */
const os = require('os');
const path = require('path');
const fs = require('fs');
process.env.DATA_DIR = path.join(os.tmpdir(), `pilot1-akty-${process.pid}`);
process.env.ANTHROPIC_API_KEY = '';
process.env.USERS_FILE = path.join(os.tmpdir(), `pilot1-akty-users-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
process.env.RATE_LIMIT_GENERAL = '1000';
process.env.RATE_LIMIT_EXPENSIVE = '1000';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const AdmZip = require('adm-zip');
const { createApp } = require('../server/app');
const xlsxRead = require('../server/services/akty/xlsx-read');
const generate = require('../server/services/akty/generate');
const dates = require('../server/services/akty/dates');

let server, base;

before(async () => {
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server.close();
  fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
  fs.rmSync(process.env.USERS_FILE, { force: true });
});

/* ---------------- сборка тестовых файлов ---------------- */

const escXml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Мини-XLSX c inline-строками (числа — как числа, чтобы проверить даты). */
function makeXlsx(rows) {
  const colLetter = (i) => String.fromCharCode(65 + i);
  const body = rows.map((cells, ri) =>
    `<row r="${ri + 1}">${cells.map((v, ci) => {
      const ref = `${colLetter(ci)}${ri + 1}`;
      if (typeof v === 'number') return `<c r="${ref}"><v>${v}</v></c>`;
      return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escXml(v)}</t></is></c>`;
    }).join('')}</row>`).join('');
  const zip = new AdmZip();
  zip.addFile('[Content_Types].xml', Buffer.from(`<?xml version="1.0"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>`, 'utf8'));
  zip.addFile('_rels/.rels', Buffer.from(`<?xml version="1.0"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`, 'utf8'));
  zip.addFile('xl/workbook.xml', Buffer.from(`<?xml version="1.0"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="Лист1" sheetId="1" r:id="rId1"/></sheets></workbook>`, 'utf8'));
  zip.addFile('xl/_rels/workbook.xml.rels', Buffer.from(`<?xml version="1.0"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`, 'utf8'));
  zip.addFile('xl/worksheets/sheet1.xml', Buffer.from(`<?xml version="1.0"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`, 'utf8'));
  return zip.toBuffer();
}

/** Мини-DOCX; текст содержит плейсхолдеры, один разорван XML-тегами как в Word. */
function makeDocx(bodyXml) {
  const zip = new AdmZip();
  zip.addFile('[Content_Types].xml', Buffer.from(`<?xml version="1.0"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`, 'utf8'));
  zip.addFile('_rels/.rels', Buffer.from(`<?xml version="1.0"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`, 'utf8'));
  zip.addFile('word/document.xml', Buffer.from(`<?xml version="1.0"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${bodyXml}</w:body></w:document>`, 'utf8'));
  return zip.toBuffer();
}

/* ---------------- чтение XLSX ---------------- */

test('xlsx-read: заголовки, строки, серийные даты Excel', () => {
  const buf = makeXlsx([
    ['Номер акта', 'Вид работ', 'Дата акта'],
    ['АОСР-1', 'Устройство опалубки стен подвала', 46067], // 14.02.2026
    ['АОСР-2', 'Армирование плиты перекрытия', '15.02.2026'],
  ]);
  const table = xlsxRead.readTable(buf);
  assert.deepStrictEqual(table.headers, ['Номер акта', 'Вид работ', 'Дата акта']);
  assert.strictEqual(table.rowCount, 2);
  assert.strictEqual(table.rows[0]['Дата акта'], '14.02.2026', 'серийная дата не преобразована');
  assert.strictEqual(table.rows[1]['Дата акта'], '15.02.2026');
});

test('xlsx-read: не-zip отвергается с внятной ошибкой', () => {
  assert.throws(() => xlsxRead.readTable(Buffer.from('это не xlsx')), /не читается как XLSX/);
});

/* ---------------- конвейер актов ---------------- */

test('конвейер: подстановка в шаблон, разорванный плейсхолдер, {НЕТ ДАННЫХ} и отчёт пропусков', () => {
  // {{Дата акта}} разорван тегами — так Word дробит текст на runs
  const tpl = makeDocx('<w:p><w:r><w:t>Акт № {{Номер акта}} от {</w:t></w:r>'
    + '<w:r><w:t>{Дата акта}</w:t></w:r><w:r><w:t>}. Работы: {{Вид работ}}. Сертификат: {{Сертификат}}</w:t></w:r></w:p>');
  const keys = generate.templateKeys(tpl);
  assert.deepStrictEqual(keys, ['Номер акта', 'Дата акта', 'Вид работ', 'Сертификат']);

  const table = {
    headers: ['Номер акта', 'Вид работ', 'Дата акта'],
    rows: [
      { 'Номер акта': 'АОСР-1', 'Вид работ': 'Опалубка', 'Дата акта': '14.02.2026' },
      { 'Номер акта': 'АОСР-2', 'Вид работ': '', 'Дата акта': '15.02.2026' },
    ],
  };
  const out = generate.generateBatch(tpl, table);
  const zip = new AdmZip(out.zip);
  const names = zip.getEntries().map((e) => e.entryName).sort();
  assert.deepStrictEqual(names, ['АОСР АОСР-1.docx', 'АОСР АОСР-2.docx', 'ОТЧЁТ-пропуски.txt'].sort());

  const act1 = new AdmZip(zip.getEntry('АОСР АОСР-1.docx').getData())
    .getEntry('word/document.xml').getData().toString('utf8');
  assert.match(act1, /Акт № АОСР-1 от 14\.02\.2026/, 'разорванный плейсхолдер не подставлен');
  assert.match(act1, /\{НЕТ ДАННЫХ\}/, 'колонки «Сертификат» нет — обязан быть {НЕТ ДАННЫХ}');

  const report = zip.getEntry('ОТЧЁТ-пропуски.txt').getData().toString('utf8');
  assert.match(report, /Сертификат/, 'плейсхолдер без колонки не назван в отчёте');
  assert.match(report, /АОСР-2\.docx: нет данных для .*Вид работ/, 'пустая ячейка не попала в отчёт');
  assert.strictEqual(out.report.total, 2);
});

test('конвейер: шаблон без плейсхолдеров и несовпадающий шаблон отвергаются до генерации', () => {
  const table = { headers: ['Номер'], rows: [{ 'Номер': '1' }] };
  assert.throws(() => generate.generateBatch(makeDocx('<w:p><w:r><w:t>без полей</w:t></w:r></w:p>'), table),
    /нет ни одного плейсхолдера/);
  assert.throws(() => generate.generateBatch(makeDocx('<w:p><w:r><w:t>{{Чужое поле}}</w:t></w:r></w:p>'), table),
    /Ни один плейсхолдер/);
});

/* ---------------- сверка дат ---------------- */

test('сверка дат: конфликт «запись позже акта», совпадение и ненайденная запись', () => {
  const acts = {
    headers: ['№', 'Вид работ', 'Дата акта'],
    rows: [
      { '№': '1', 'Вид работ': 'Устройство опалубки стен подвала', 'Дата акта': '14.02.2026' },
      { '№': '2', 'Вид работ': 'Армирование плиты перекрытия', 'Дата акта': '20.02.2026' },
      { '№': '3', 'Вид работ': 'Монтаж витражей главного фасада', 'Дата акта': '21.02.2026' },
    ],
  };
  const journal = {
    headers: ['Дата записи', 'Содержание работ'],
    rows: [
      { 'Дата записи': '17.02.2026', 'Содержание работ': 'Выполнялось устройство опалубки стен подвала в осях 1-4' },
      { 'Дата записи': '19.02.2026', 'Содержание работ': 'Армирование плиты перекрытия на отм. +3.300' },
    ],
  };
  const out = dates.compare(acts, journal);
  const byNo = Object.fromEntries(out.rows.map((r) => [r.act_no, r]));
  assert.match(byNo['1'].conflict, /позже акта на 3 дн/);
  assert.strictEqual(byNo['2'].conflict, null, 'запись раньше акта — не конфликт');
  assert.match(byNo['3'].conflict, /не найдена/);
  assert.strictEqual(out.conflicts, 2);
  assert.ok(out.warnings.some((w) => /вручную/.test(w)), 'эвристичность сопоставления обязана быть проговорена');
});

/* ---------------- маршруты ---------------- */

test('акты: без входа доступа нет, полный цикл через HTTP отдаёт zip и отчёт', async () => {
  const noAuth = await fetch(`${base}/api/akty/registry/preview`, { method: 'POST' });
  assert.strictEqual(noAuth.status, 401);

  const enter = await fetch(`${base}/api/auth/enter`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lastName: 'ПТО', firstName: 'Тест' }),
  });
  const token = (await enter.json()).token;

  const registry = makeXlsx([
    ['Номер акта', 'Вид работ', 'Дата акта'],
    ['1', 'Опалубка', '14.02.2026'],
  ]);
  const template = makeDocx('<w:p><w:r><w:t>Акт {{Номер акта}}: {{Вид работ}} от {{Дата акта}}</w:t></w:r></w:p>');

  const fd = new FormData();
  fd.append('registry', new Blob([registry]), 'реестр.xlsx');
  fd.append('template', new Blob([template]), 'шаблон.docx');
  const res = await fetch(`${base}/api/akty/generate`, {
    method: 'POST', headers: { 'X-User-Token': token }, body: fd,
  });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.headers.get('content-type'), 'application/zip');
  const report = JSON.parse(decodeURIComponent(res.headers.get('x-akty-report')));
  assert.strictEqual(report.total, 1);
  const zip = new AdmZip(Buffer.from(await res.arrayBuffer()));
  assert.ok(zip.getEntry('АОСР 1.docx'), 'акта нет в zip');

  // сверка дат через HTTP
  const acts = makeXlsx([['№', 'Вид работ', 'Дата акта'], ['1', 'Опалубка стен', '14.02.2026']]);
  const journal = makeXlsx([['Дата записи', 'Содержание работ'], ['17.02.2026', 'Опалубка стен в осях 1-4']]);
  const fd2 = new FormData();
  fd2.append('acts', new Blob([acts]), 'акты.xlsx');
  fd2.append('journal', new Blob([journal]), 'журнал.xlsx');
  const res2 = await fetch(`${base}/api/akty/dates`, {
    method: 'POST', headers: { 'X-User-Token': token }, body: fd2,
  });
  assert.strictEqual(res2.status, 200);
  const data = await res2.json();
  assert.strictEqual(data.conflicts, 1);
  assert.match(data.rows[0].conflict, /позже акта/);
});
