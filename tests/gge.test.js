'use strict';
/* Вкладка «Входной контроль ГГЭ»: имена по 783/пр, посимвольная сверка
 * реквизитов, развилки по датам. Детерминировано, моделей нет. */
const os = require('os');
const path = require('path');
const fs = require('fs');
process.env.DATA_DIR = path.join(os.tmpdir(), `pilot1-gge-${process.pid}`);
process.env.ANTHROPIC_API_KEY = '';
process.env.USERS_FILE = path.join(os.tmpdir(), `pilot1-gge-users-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
process.env.RATE_LIMIT_GENERAL = '1000';
process.env.RATE_LIMIT_EXPENSIVE = '1000';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { createApp } = require('../server/app');
const check = require('../server/services/gge/check');

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

/* ---------------- имена файлов по 783/пр ---------------- */

test('имена файлов: «Раздел ПД N» обязателен, потолок 80 МБ', () => {
  const rows = check.checkFilenames([
    { name: 'Раздел ПД 5 Конструктивные решения.pdf', size: 10 * 1024 * 1024 },
    { name: 'КР-финал-v7.pdf', size: 10 * 1024 * 1024 },
    { name: 'Раздел ПД 1.pdf', size: 90 * 1024 * 1024 },
  ]);
  assert.strictEqual(rows[0].ok, true);
  assert.strictEqual(rows[1].ok, false);
  assert.match(rows[1].problems[0], /Раздел ПД/);
  assert.strictEqual(rows[2].ok, false);
  assert.match(rows[2].problems[0], /80 МБ/);
});

/* ---------------- посимвольная сверка реквизитов ---------------- */

test('реквизиты: точно / с отличиями / похожая строка с местом расхождения / не найдено', () => {
  const docs = [
    { name: 'ПЗ.txt', text: 'Объект: «Цех по производству вакцин»\nЗастройщик: ООО  "СтройИнвест"\nИНН 4707012345' },
    { name: 'смета.txt', text: 'Локальная смета.\nОбъект: «Цех по производству вакцины»' },
  ];
  const out = check.checkRequisites({
    'Название объекта': 'Объект: «Цех по производству вакцин»',
    'Застройщик': 'Застройщик: ООО «СтройИнвест»',
    'ИНН': 'ИНН 4707099999',
  }, docs);
  const byField = Object.fromEntries(out.map((r) => [r.field, r]));

  // точное вхождение в ПЗ
  assert.strictEqual(byField['Название объекта'].docs[0].status, 'точно');
  // в смете — «вакцины» вместо «вакцин»: похожая строка, место расхождения названо
  const inSmeta = byField['Название объекта'].docs[1];
  assert.strictEqual(inSmeta.status, 'похожая строка');
  assert.match(inSmeta.detail, /расхождение с \d+-го символа/);
  assert.strictEqual(byField['Название объекта'].ok, false);

  // двойной пробел и кавычки-лапки: «с отличиями», не «точно»
  assert.strictEqual(byField['Застройщик'].docs[0].status, 'с отличиями');
  // чужой ИНН не найден
  assert.strictEqual(byField['ИНН'].docs[1].status, 'не найдено');
});

/* ---------------- развилки по датам ---------------- */

test('развилки: правила регламента выводятся сравнением дат, недостающее названо', () => {
  const out = check.dateForks({ taskDate: '15.03.2024', fgisDate: '01.01.2024' });
  const byRule = Object.fromEntries(out.rules.map((r) => [r.rule, r]));
  assert.strictEqual(byRule['Редакция ПП 87 и XML Раздела 1'].applies, true);
  assert.strictEqual(byRule['Назначение по 928/пр'].applies, true);
  assert.strictEqual(byRule['Задание в формате XML'].applies, false); // до 08.07.2025
  assert.ok(byRule['Метод определения стоимости: РИМ'], 'задание позже ФГИС ЦС — РИМ');
  assert.match(byRule['Назначение по 928/пр'].explanation, /15\.03\.2024 ≥ 02\.03\.2023/);
  assert.deepStrictEqual(out.missing, []);

  const early = check.dateForks({ taskDate: '01.05.2022' });
  assert.strictEqual(early.rules.find((r) => r.rule.includes('ПП 87')).applies, false);
  assert.match(early.missing[0], /ФГИС ЦС/);

  const none = check.dateForks({});
  assert.match(none.missing[0], /дата утверждения задания/);
});

/* ---------------- маршрут ---------------- */

test('ггэ: полный check через HTTP — сводка, реквизиты и развилки вместе', async () => {
  const noAuth = await fetch(`${base}/api/gge/forks`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  });
  assert.strictEqual(noAuth.status, 401);

  const enter = await fetch(`${base}/api/auth/enter`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lastName: 'ГИП', firstName: 'Тест' }),
  });
  const token = (await enter.json()).token;

  const fd = new FormData();
  fd.append('files', new Blob([Buffer.from('Объект: «Цех вакцин». Застройщик: ООО «СтройИнвест»')]), 'Раздел ПД 1 Пояснительная записка.txt');
  fd.append('files', new Blob([Buffer.from('Объект: «Цех вакцины»')]), 'смета-без-имени-по-783.txt');
  fd.append('fields', JSON.stringify({ 'Название объекта': 'Объект: «Цех вакцин»' }));
  fd.append('taskDate', '15.03.2024');
  fd.append('fgisDate', '01.01.2024');

  const res = await fetch(`${base}/api/gge/check`, {
    method: 'POST', headers: { 'X-User-Token': token }, body: fd,
  });
  assert.strictEqual(res.status, 200);
  const data = await res.json();
  assert.strictEqual(data.summary.files, 2);
  assert.strictEqual(data.summary.filename_problems, 1);
  assert.strictEqual(data.summary.requisite_problems, 1); // в смете «вакцины»
  const req = data.requisites[0];
  assert.strictEqual(req.docs.find((d) => /Раздел ПД 1/.test(d.file)).status, 'точно');
  assert.ok(data.forks.rules.length >= 3);
  assert.ok(data.notes.some((n) => /содержание разделов/.test(n)));
});

test('ггэ: fields — только объект «реквизит → значение»: массив, null и строка отвергаются 400', async () => {
  const enter = await fetch(`${base}/api/auth/enter`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lastName: 'ГИП', firstName: 'Тест' }),
  });
  const token = (await enter.json()).token;
  for (const fields of ['[1,2]', 'null', '"строка"', '42']) {
    const fd = new FormData();
    fd.append('files', new Blob([Buffer.from('Объект')]), 'Раздел ПД 1 ПЗ.txt');
    fd.append('fields', fields);
    const res = await fetch(`${base}/api/gge/check`, { method: 'POST', headers: { 'X-User-Token': token }, body: fd });
    assert.strictEqual(res.status, 400, `fields=${fields}: ${res.status}`);
    const body = await res.json();
    assert.match(body.error, /fields.*JSON-объектом/);
  }
});
