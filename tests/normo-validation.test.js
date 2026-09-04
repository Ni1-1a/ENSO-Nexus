'use strict';
/* Модуль «Нормоконтроль»: проверки входа на границе HTTP — идентификаторы,
 * поля проекта, состав разделов, файлы версий, привязка к проекту платформы.
 * Каждый случай раньше оборачивался 500 из PostgreSQL (invalid input syntax,
 * out of range, CHECK, DateTimeParseError) — теперь это честные 400/404/409/422.
 * База — СВОЯ (enso_normo_test_validation): файлы node --test идут параллельно,
 * а normo.test.js пересоздаёт enso_normo_test под собой. */
const os = require('os');
const path = require('path');
const fs = require('fs');
process.env.DATA_DIR = path.join(os.tmpdir(), `pilot1-normo-valid-${process.pid}`);
process.env.NORMO_DATA_DIR = path.join(os.tmpdir(), `pilot1-normo-valid-files-${process.pid}`);
process.env.NORMO_DATABASE_URL = process.env.NORMO_VALIDATION_TEST_DATABASE_URL
  || 'postgresql://127.0.0.1:5433/enso_normo_test_validation';
process.env.ANTHROPIC_API_KEY = '';
process.env.USERS_FILE = path.join(os.tmpdir(), `pilot1-normo-valid-users-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
process.env.RATE_LIMIT_GENERAL = '1000';
process.env.RATE_LIMIT_EXPENSIVE = '1000';
process.env.NORMO_LLM = '0';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { Client } = require('pg');

let available = true;
let unavailableReason = '';
let server, base;

async function recreateTestDb() {
  const admin = new Client({ connectionString: 'postgresql://127.0.0.1:5433/postgres', connectionTimeoutMillis: 3000 });
  await admin.connect();
  try {
    await admin.query('DROP DATABASE IF EXISTS enso_normo_test_validation');
    await admin.query('CREATE DATABASE enso_normo_test_validation');
  } finally {
    await admin.end();
  }
}

before(async () => {
  try {
    await recreateTestDb();
  } catch (err) {
    available = false;
    unavailableReason = `PostgreSQL модуля недоступен (${err.message}) — прогоните brew services start postgresql@17`;
    return;
  }
  const { createApp } = require('../server/app');
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) server.close();
  try { await require('../server/services/normo/db').close(); } catch { /* не поднялась */ }
  fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
  fs.rmSync(process.env.NORMO_DATA_DIR, { recursive: true, force: true });
  fs.rmSync(process.env.USERS_FILE, { force: true });
});

const api = async (p, opts = {}) => {
  const res = await fetch(base + p, opts);
  let body = null;
  try { body = await res.clone().json(); } catch { body = await res.text(); }
  return { status: res.status, body };
};

let userToken = '';
async function login() {
  const { body } = await api('/api/auth/enter', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lastName: 'Нормоконтролёров', firstName: 'Тест' }),
  });
  return body.token || '';
}
const asUser = () => ({ 'X-User-Token': userToken });
const json = (obj) => ({
  headers: { 'Content-Type': 'application/json', ...asUser() },
  body: JSON.stringify(obj),
});

function form(files, extra = {}) {
  const fd = new FormData();
  for (const [name, content, type] of files) {
    fd.append('files', new File([content], name, { type }));
  }
  for (const [k, v] of Object.entries({ stage: 'П', ...extra })) fd.append(k, v);
  return fd;
}

const GOOD = { name: 'Цех (валидация)', stage: 'П', dateStarted: '2026-08-01', objectKind: 'производственный' };
let projectId = null;

test('идентификаторы: нечисловые и переполненные — 400, а не 500 из PostgreSQL', async (t) => {
  if (!available) return t.skip(unavailableReason);
  userToken = await login();
  const cases = [
    ['GET', '/api/normo/projects/abc'],
    ['GET', '/api/normo/projects/99999999999999999999'],
    ['GET', '/api/normo/projects/0'],
    ['GET', '/api/normo/projects/-1'],
    ['GET', '/api/normo/projects/1.5'],
    ['PUT', '/api/normo/projects/abc/sections'],
    ['GET', '/api/normo/sections/abc/versions'],
    ['GET', '/api/normo/versions/x'],
    ['POST', '/api/normo/versions/x/check'],
    ['GET', '/api/normo/runs/1e3'],
    ['GET', '/api/normo/versions/abc/findings'],
    ['PATCH', '/api/normo/findings/abc'],
    ['GET', '/api/normo/diffs/abc'],
    ['GET', '/api/normo/diffs/abc/impact'],
    ['PATCH', '/api/normo/impact/abc'],
    ['GET', '/api/normo/reports/abc'],
    ['GET', '/api/normo/reports/abc/file'],
    ['GET', '/api/normo/projects/abc/input-data'],
    ['GET', '/api/normo/projects/abc/findings'],
  ];
  for (const [method, url] of cases) {
    const r = await api(url, method === 'GET'
      ? { headers: asUser() }
      : { method, ...json({ status: 'fixed', sections: [{ code: 'ПЗ', name: 'x' }] }) });
    assert.strictEqual(r.status, 400, `${method} ${url}: ${r.status} ${JSON.stringify(r.body)}`);
    assert.match(r.body.error, /Некорректный идентификатор/, `${method} ${url}`);
  }
  // дифф: from/to — тоже идентификаторы
  const diff = await api('/api/normo/sections/1/diff?from=a&to=b', { headers: asUser() });
  assert.strictEqual(diff.status, 400, JSON.stringify(diff.body));
  assert.match(diff.body.error, /Некорректный идентификатор/);
  // а нормальный, но несуществующий номер — честный 404
  const missing = await api('/api/normo/projects/424242', { headers: asUser() });
  assert.strictEqual(missing.status, 404);
});

test('проект: недопустимые stage/objectKind/dateStarted/localOnly и нестроковые поля — 400 с перечнем', async (t) => {
  if (!available) return t.skip(unavailableReason);
  const bad = async (patch, re) => {
    const r = await api('/api/normo/projects', { method: 'POST', ...json({ ...GOOD, ...patch }) });
    assert.strictEqual(r.status, 400, `${JSON.stringify(patch)}: ${r.status} ${JSON.stringify(r.body)}`);
    assert.match(r.body.error, re, JSON.stringify(patch));
  };
  await bad({ stage: 'ПД' }, /П, Р, П\+Р/);
  await bad({ objectKind: 'жилой' }, /производственный, непроизводственный, линейный/);
  await bad({ dateStarted: '01.08.2026' }, /YYYY-MM-DD/);
  await bad({ dateStarted: '2026-02-30' }, /YYYY-MM-DD|дата/);
  await bad({ dateStarted: 'вчера' }, /YYYY-MM-DD/);
  await bad({ localOnly: 'да' }, /localOnly.*true|false/);
  await bad({ name: 123 }, /name/);
  await bad({ customer: { a: 1 } }, /customer/);

  const ok = await api('/api/normo/projects', { method: 'POST', ...json({ ...GOOD, localOnly: true, customer: 'ООО «Тест»' }) });
  assert.strictEqual(ok.status, 201, JSON.stringify(ok.body));
  assert.strictEqual(ok.body.project.local_only, true);
  assert.strictEqual(ok.body.project.object_kind, 'производственный');
  projectId = ok.body.project.id;
});

test('состав разделов: чужой проект — 404, элемент без code/name — 400, раздел с версиями не убирается — 409', async (t) => {
  if (!available) return t.skip(unavailableReason);
  const missing = await api('/api/normo/projects/424242/sections', {
    method: 'PUT', ...json({ sections: [{ code: 'ПЗ', name: 'Пояснительная записка' }] }),
  });
  assert.strictEqual(missing.status, 404, JSON.stringify(missing.body));

  const noName = await api(`/api/normo/projects/${projectId}/sections`, {
    method: 'PUT', ...json({ sections: [{ code: 'ПЗ' }] }),
  });
  assert.strictEqual(noName.status, 400, JSON.stringify(noName.body));
  const noCode = await api(`/api/normo/projects/${projectId}/sections`, {
    method: 'PUT', ...json({ sections: [{ name: 'Без шифра' }, 'строка'] }),
  });
  assert.strictEqual(noCode.status, 400, JSON.stringify(noCode.body));

  // у СМ появляется версия — теперь этот раздел из состава не выкинуть
  const up = await api(`/api/normo/projects/${projectId}/sections/СМ/versions`, {
    method: 'POST', headers: asUser(),
    body: form([['Раздел ПД 11 ЛСР-01.xml', '<?xml version="1.0"?><Смета/>', 'application/xml']]),
  });
  assert.strictEqual(up.status, 201, JSON.stringify(up.body));
  const drop = await api(`/api/normo/projects/${projectId}/sections`, {
    method: 'PUT', ...json({ sections: [{ code: 'ПЗ', name: 'Пояснительная записка' }] }),
  });
  assert.strictEqual(drop.status, 409, JSON.stringify(drop.body));
  assert.match(drop.body.error, /СМ/);
  // состав не тронут: СМ на месте
  const still = await api(`/api/normo/projects/${projectId}`, { headers: asUser() });
  assert.ok(still.body.project.sections.some((s) => s.code === 'СМ'));

  const keep = await api(`/api/normo/projects/${projectId}/sections`, {
    method: 'PUT', ...json({ sections: [{ code: 'СМ', name: 'Смета' }, { code: 'ПЗ', name: 'Пояснительная записка' }] }),
  });
  assert.strictEqual(keep.status, 200, JSON.stringify(keep.body));
  assert.deepStrictEqual(keep.body.sections.map((s) => s.code), ['СМ', 'ПЗ']);
});

test('версии: исполняемые файлы и подделки под PDF/DOCX — 422, версия не заводится', async (t) => {
  if (!available) return t.skip(unavailableReason);
  const exe = await api(`/api/normo/projects/${projectId}/sections/ПЗ/versions`, {
    method: 'POST', headers: asUser(),
    body: form([['Раздел ПД 1 ПЗ.exe', 'MZ  ', 'application/octet-stream']]),
  });
  assert.strictEqual(exe.status, 422, JSON.stringify(exe.body));
  assert.match(exe.body.error, /\.exe/);
  const sh = await api(`/api/normo/projects/${projectId}/sections/ПЗ/versions`, {
    method: 'POST', headers: asUser(),
    body: form([['Раздел ПД 1 ПЗ.pdf', '%PDF-1.4 ok', 'application/pdf'], ['run.sh', '#!/bin/sh', 'text/plain']]),
  });
  assert.strictEqual(sh.status, 422, JSON.stringify(sh.body));
  const fakePdf = await api(`/api/normo/projects/${projectId}/sections/ПЗ/versions`, {
    method: 'POST', headers: asUser(),
    body: form([['Раздел ПД 1 ПЗ.pdf', 'MZ это не pdf', 'application/pdf']]),
  });
  assert.strictEqual(fakePdf.status, 422, JSON.stringify(fakePdf.body));
  assert.match(fakePdf.body.error, /не является PDF/);
  const fakeDocx = await api(`/api/normo/projects/${projectId}/sections/ПЗ/versions`, {
    method: 'POST', headers: asUser(),
    body: form([['Раздел ПД 1 ПЗ.docx', 'просто текст', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document']]),
  });
  assert.strictEqual(fakeDocx.status, 422, JSON.stringify(fakeDocx.body));
  assert.match(fakeDocx.body.error, /DOCX|Word/);
  // ни одна из попыток не завела версию у ПЗ
  const p = await api(`/api/normo/projects/${projectId}`, { headers: asUser() });
  const pz = p.body.project.sections.find((s) => s.code === 'ПЗ');
  assert.strictEqual(pz.current_version_id, null);
});

test('привязка к проекту платформы: несуществующий или удалённый — 404, пустой — «Ранние работы», кривой ?project= — 400', async (t) => {
  if (!available) return t.skip(unavailableReason);
  const ghost = await api('/api/normo/projects', { method: 'POST', ...json({ ...GOOD, platformProjectId: 'no-such-project' }) });
  assert.strictEqual(ghost.status, 404, JSON.stringify(ghost.body));
  assert.match(ghost.body.error, /Проект не найден/);
  const crooked = await api('/api/normo/projects', { method: 'POST', ...json({ ...GOOD, platformProjectId: 'абв' }) });
  assert.strictEqual(crooked.status, 400, JSON.stringify(crooked.body));

  const legacy = await api('/api/normo/projects', { method: 'POST', ...json(GOOD) });
  assert.strictEqual(legacy.status, 201, JSON.stringify(legacy.body));
  assert.strictEqual(legacy.body.project.platform_project_id, 'legacy');
  const early = await api('/api/projects/legacy', { headers: asUser() });
  assert.strictEqual(early.status, 200, 'проект «Ранние работы» обязан существовать на платформе');

  const created = await api('/api/projects', { method: 'POST', ...json({ name: 'Платформенный (валидация)' }) });
  assert.strictEqual(created.status, 201);
  const pid = created.body.project.id;
  const bound = await api('/api/normo/projects', { method: 'POST', ...json({ ...GOOD, platformProjectId: pid }) });
  assert.strictEqual(bound.status, 201, JSON.stringify(bound.body));
  assert.strictEqual(bound.body.project.platform_project_id, pid);
  const list = await api(`/api/normo/projects?project=${pid}`, { headers: asUser() });
  assert.deepStrictEqual(list.body.projects.map((p) => p.id), [bound.body.project.id]);
  const badList = await api(`/api/normo/projects?project=${encodeURIComponent('абв')}`, { headers: asUser() });
  assert.strictEqual(badList.status, 400, JSON.stringify(badList.body));
  assert.match(badList.body.error, /Некорректный идентификатор проекта/);

  const del = await api(`/api/projects/${pid}`, { method: 'DELETE', headers: asUser() });
  assert.strictEqual(del.status, 200);
  const afterDelete = await api('/api/normo/projects', { method: 'POST', ...json({ ...GOOD, platformProjectId: pid }) });
  assert.strictEqual(afterDelete.status, 404, JSON.stringify(afterDelete.body));
});

/* ================= свои проекты и внутри нормоконтроля (решение владельца 02.09.2026) ================= */

test('комплект чужого проекта платформы не открывается ни по одному числовому id', async (t) => {
  if (!available) return t.skip(unavailableReason);
  if (!userToken) userToken = await login();
  // проект платформы первого человека и комплект в нём
  const pp = await api('/api/projects', { method: 'POST', ...json({ name: 'Свой для нормо' }) });
  assert.strictEqual(pp.status, 201, JSON.stringify(pp.body));
  const created = await api('/api/normo/projects', { method: 'POST', ...json({ ...GOOD, name: 'Комплект в своём проекте', platformProjectId: pp.body.project.id }) });
  assert.strictEqual(created.status, 201, JSON.stringify(created.body));
  const np = created.body.project;
  const sid = np.sections[0].id;

  // второй человек
  const other = (await api('/api/auth/enter', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lastName: 'Чужаков', firstName: 'Нормо' }),
  })).body.token;
  const asOther = { 'X-User-Token': other };
  assert.strictEqual((await api(`/api/normo/projects/${np.id}`, { headers: asOther })).status, 404);
  assert.strictEqual((await api(`/api/normo/sections/${sid}/versions`, { headers: asOther })).status, 404);
  assert.strictEqual((await api(`/api/normo/projects?project=${pp.body.project.id}`, { headers: asOther })).status, 403);
  const list = await api('/api/normo/projects', { headers: asOther });
  assert.ok(!list.body.projects.some((p) => p.id === np.id), 'чужой комплект в общем списке');
  // свой человек видит
  assert.strictEqual((await api(`/api/normo/projects/${np.id}`, { headers: asUser() })).status, 200);
  assert.strictEqual((await api(`/api/normo/sections/${sid}/versions`, { headers: asUser() })).status, 200);
});
