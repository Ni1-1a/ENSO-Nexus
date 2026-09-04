'use strict';
/**
 * Потолки загрузок (аудит безопасности 02.09.2026): один запрос с файлами
 * ограничен по Content-Length (UPLOAD_TOTAL_MB), а запись zip внутри docx/xlsx
 * проверяется по заявленному размеру ДО распаковки (ZIP_ENTRY_MB). Пороги в
 * тесте уменьшены до 1 МБ, чтобы не гонять сотни мегабайт.
 */
const os = require('os');
const path = require('path');
const fs = require('fs');
process.env.DATA_DIR = path.join(os.tmpdir(), `pilot1-uplim-${process.pid}`);
process.env.ANTHROPIC_API_KEY = '';
process.env.USERS_FILE = path.join(os.tmpdir(), `pilot1-uplim-users-${process.pid}.json`);
process.env.RATE_LIMIT_GENERAL = '1000';
process.env.RATE_LIMIT_EXPENSIVE = '1000';
process.env.UPLOAD_TOTAL_MB = '1';
process.env.ZIP_ENTRY_MB = '1';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const AdmZip = require('adm-zip');
const { createApp } = require('../server/app');

let server, base, token;
before(async () => {
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const res = await fetch(`${base}/api/auth/enter`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lastName: 'Лимитов', firstName: 'Тест' }),
  });
  token = (await res.json()).token;
});
after(() => {
  server.close();
  fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
  fs.rmSync(process.env.USERS_FILE, { force: true });
});

/** DOCX с document.xml заданного размера: сжимается в разы, как zip-бомба. */
function docx(bodyChars) {
  const zip = new AdmZip();
  const text = '<w:document xmlns:w="w"><w:body><w:p><w:r><w:t>Текст задания</w:t></w:r></w:p>'
    + '<w:p><w:r><w:t>' + ' '.repeat(bodyChars) + '</w:t></w:r></w:p></w:body></w:document>';
  zip.addFile('[Content_Types].xml', Buffer.from('<Types/>'));
  zip.addFile('word/document.xml', Buffer.from(text, 'utf8'));
  return zip.toBuffer();
}

test('запрос больше UPLOAD_TOTAL_MB отбивается по Content-Length до разбора файлов', async () => {
  const fd = new FormData();
  fd.append('files', new Blob([Buffer.alloc(2 * 1024 * 1024, 65)], { type: 'text/plain' }), 'big.txt');
  const res = await fetch(`${base}/api/gge/check`, { method: 'POST', headers: { 'X-User-Token': token }, body: fd });
  assert.strictEqual(res.status, 413);
  const body = await res.json();
  assert.match(body.error, /Слишком большой запрос/);
  assert.match(body.error, /1 МБ/);
});

test('zip-бомба в DOCX: запись больше ZIP_ENTRY_MB не распаковывается — 422', async () => {
  const created = await fetch(`${base}/api/tz/projects`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-User-Token': token },
    body: JSON.stringify({ name: 'Лимиты', checklist: 'production' }),
  });
  const { project } = await created.json();
  const bomb = docx(2 * 1024 * 1024);
  assert.ok(bomb.length < 200 * 1024, `бомба обязана быть маленькой в сжатом виде: ${bomb.length}`);
  const fd = new FormData();
  fd.append('file', new Blob([bomb]), 'bomb.docx');
  const res = await fetch(`${base}/api/tz/projects/${project.id}/document/file`, { method: 'POST', headers: { 'X-User-Token': token }, body: fd });
  const text = await res.text();
  assert.strictEqual(res.status, 422, text);
  assert.match(JSON.parse(text).error, /слишком велико при распаковке/);

  // обычный docx в пределах порога — читается как раньше
  const fd2 = new FormData();
  fd2.append('file', new Blob([docx(100)]), 'ok.docx');
  const ok = await fetch(`${base}/api/tz/projects/${project.id}/document/file`, { method: 'POST', headers: { 'X-User-Token': token }, body: fd2 });
  const okText = await ok.text();
  assert.strictEqual(ok.status, 201, okText);
  assert.match(JSON.parse(okText).document.name, /ok\.docx/);
});

test('шаблон актов: зип-бомба в DOCX даёт 422, а не падение процесса', async () => {
  const fd = new FormData();
  fd.append('template', new Blob([docx(2 * 1024 * 1024)]), 'bomb.docx');
  const res = await fetch(`${base}/api/akty/template/preview`, { method: 'POST', headers: { 'X-User-Token': token }, body: fd });
  assert.strictEqual(res.status, 422, await res.text());
});

test('текст документа ТЗ больше 256 КБ проходит через JSON: у модуля свой парсер до 2 МБ', async () => {
  const created = await fetch(`${base}/api/tz/projects`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-User-Token': token },
    body: JSON.stringify({ name: 'Большой JSON', checklist: 'production' }),
  });
  const { project } = await created.json();
  const text = 'Задание на проектирование. '.repeat(15000); // ≈ 400 КБ
  const res = await fetch(`${base}/api/tz/projects/${project.id}/document`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-User-Token': token },
    body: JSON.stringify({ text, name: 'big.txt' }),
  });
  const body = await res.text();
  assert.strictEqual(res.status, 200, body);
  assert.ok(JSON.parse(body).document.chars > 300000);
});
