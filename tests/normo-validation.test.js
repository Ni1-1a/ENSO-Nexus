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
// порог записи zip уменьшен до 1 МБ: docx-бомба в тесте — 2 МБ пробелов, сжатых в килобайты
process.env.ZIP_ENTRY_MB = '1';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { Client } = require('pg');
const AdmZip = require('adm-zip');

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

/** DOCX с одним параграфом заданного текста (или бомба — параграф из bodyChars пробелов). */
function docx(text, bodyChars = 0) {
  const zip = new AdmZip();
  zip.addFile('[Content_Types].xml', Buffer.from('<Types/>'));
  zip.addFile('word/document.xml', Buffer.from(
    '<w:document xmlns:w="w"><w:body><w:p><w:r><w:t>' + text + '</w:t></w:r></w:p>'
    + (bodyChars ? '<w:p><w:r><w:t>' + ' '.repeat(bodyChars) + '</w:t></w:r></w:p>' : '')
    + '</w:body></w:document>', 'utf8'));
  return zip.toBuffer();
}
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** Прогон асинхронный: ждём done/failed опросом, как это делает клиент. */
async function waitRun(runId) {
  for (let i = 0; i < 200; i++) {
    const { body } = await api(`/api/normo/runs/${runId}`, { headers: asUser() });
    if (['done', 'failed'].includes(body.run.status)) return body.run;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`прогон ${runId} не завершился за отведённое время`);
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
  // DATE отдаётся строкой как есть: раньше pg делал из неё Date в местной зоне,
  // и «2026-08-01» уезжало клиентом как «2026-07-31T21:00:00.000Z»
  assert.strictEqual(ok.body.project.date_started, '2026-08-01');
  projectId = ok.body.project.id;
  const got = await api(`/api/normo/projects/${projectId}`, { headers: asUser() });
  assert.strictEqual(got.body.project.date_started, '2026-08-01');
  const list = await api('/api/normo/projects', { headers: asUser() });
  assert.strictEqual(list.body.projects.find((p) => p.id === projectId).date_started, '2026-08-01');
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

test('версии: docx-бомба (запись больше ZIP_ENTRY_MB) — 422 до записи версии', async (t) => {
  if (!available) return t.skip(unavailableReason);
  const bomb = docx('Пояснительная записка', 2 * 1024 * 1024);
  assert.ok(bomb.length < 200 * 1024, `бомба обязана быть маленькой в сжатом виде: ${bomb.length}`);
  const r = await api(`/api/normo/projects/${projectId}/sections/ПЗ/versions`, {
    method: 'POST', headers: asUser(),
    body: form([['Раздел ПД 1 ПЗ.docx', bomb, DOCX_MIME]]),
  });
  assert.strictEqual(r.status, 422, JSON.stringify(r.body));
  assert.match(r.body.error, /слишком велико при распаковке/);
  const p = await api(`/api/normo/projects/${projectId}`, { headers: asUser() });
  assert.strictEqual(p.body.project.sections.find((s) => s.code === 'ПЗ').current_version_id, null, 'версия с бомбой заведена');
  // обычный docx в пределах порога принимается
  const ok = await api(`/api/normo/projects/${projectId}/sections/ПЗ/versions`, {
    method: 'POST', headers: asUser(),
    body: form([['Раздел ПД 1 ПЗ.docx', docx('Пояснительная записка. Обозначение SEC-1-ПЗ'), DOCX_MIME]]),
  });
  assert.strictEqual(ok.status, 201, JSON.stringify(ok.body));
  await waitRun(ok.body.check.runId);
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
  // чужой проект в фильтре — 404, как и напрямую: его существование не подтверждается
  assert.strictEqual((await api(`/api/normo/projects?project=${pp.body.project.id}`, { headers: asOther })).status, 404);
  const list = await api('/api/normo/projects', { headers: asOther });
  assert.ok(!list.body.projects.some((p) => p.id === np.id), 'чужой комплект в общем списке');
  // и не правится — тоже 404, а не 403: существование не подтверждается
  const put = await api(`/api/normo/projects/${np.id}/sections`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', ...asOther },
    body: JSON.stringify({ sections: [{ code: 'ПЗ', name: 'Захват' }] }),
  });
  assert.strictEqual(put.status, 404, JSON.stringify(put.body));
  // свой человек видит
  assert.strictEqual((await api(`/api/normo/projects/${np.id}`, { headers: asUser() })).status, 200);
  assert.strictEqual((await api(`/api/normo/sections/${sid}/versions`, { headers: asUser() })).status, 200);
});

test('«Ранние работы»: чужой комплект читается, а правится только автором комплекта или владельцем — 403', async (t) => {
  if (!available) return t.skip(unavailableReason);
  const other = (await api('/api/auth/enter', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lastName: 'Чужаков', firstName: 'Нормо' }),
  })).body.token;
  const asOther = { 'X-User-Token': other };
  const jsonOther = (obj) => ({ headers: { 'Content-Type': 'application/json', ...asOther }, body: JSON.stringify(obj) });
  // комплект projectId заведён Нормоконтролёровым без проекта платформы — «Ранние работы»
  const p = await api(`/api/normo/projects/${projectId}`, { headers: asOther });
  assert.strictEqual(p.status, 200, 'общий комплект читается всеми');
  assert.strictEqual(p.body.project.platform_project_id, 'legacy');
  const sm = p.body.project.sections.find((s) => s.code === 'СМ');
  const findings = await api(`/api/normo/versions/${sm.current_version_id}/findings`, { headers: asOther });
  assert.strictEqual(findings.status, 200);
  const fid = findings.body.findings[0].id;
  assert.ok(fid, 'у СМ обязано быть замечание SM-001');
  const denied = [
    ['PUT', `/api/normo/projects/${projectId}/sections`, { sections: [{ code: 'СМ', name: 'x' }, { code: 'ПЗ', name: 'y' }] }],
    ['POST', `/api/normo/versions/${sm.current_version_id}/check`, { force: true }],
    ['POST', `/api/normo/versions/${sm.current_version_id}/reports`, {}],
    ['PATCH', `/api/normo/findings/${fid}`, { status: 'fixed' }],
    ['POST', `/api/normo/projects/${projectId}/check-complex`, {}],
  ];
  for (const [method, url, body] of denied) {
    const r = await api(url, { method, ...jsonOther(body) });
    assert.strictEqual(r.status, 403, `${method} ${url}: ${r.status} ${JSON.stringify(r.body)}`);
    assert.match(r.body.error, /чужая запись/, url);
  }
  const up = await api(`/api/normo/projects/${projectId}/sections/ПЗ/versions`, {
    method: 'POST', headers: asOther, body: form([['Раздел ПД 1 ПЗ.txt', 'текст', 'text/plain']]),
  });
  assert.strictEqual(up.status, 403, JSON.stringify(up.body));
  // замечание не тронуто, а автор комплекта правит
  const still = await api(`/api/normo/versions/${sm.current_version_id}/findings`, { headers: asUser() });
  assert.strictEqual(still.body.findings.find((f) => f.id === fid).status, 'open');
  const mine = await api(`/api/normo/findings/${fid}`, { method: 'PATCH', ...json({ verification: 'human_confirmed' }) });
  assert.strictEqual(mine.status, 200, JSON.stringify(mine.body));
  // свой ранний комплект соседа — правит он сам
  const own = await api('/api/normo/projects', { method: 'POST', ...jsonOther({ ...GOOD, name: 'Комплект соседа' }) });
  assert.strictEqual(own.status, 201, JSON.stringify(own.body));
  const ownPut = await api(`/api/normo/projects/${own.body.project.id}/sections`, {
    method: 'PUT', ...jsonOther({ sections: [{ code: 'ПЗ', name: 'Пояснительная записка' }] }),
  });
  assert.strictEqual(ownPut.status, 200, JSON.stringify(ownPut.body));
  const notMine = await api(`/api/normo/projects/${own.body.project.id}/sections`, {
    method: 'PUT', ...json({ sections: [{ code: 'ПЗ', name: 'Чужая правка' }] }),
  });
  assert.strictEqual(notMine.status, 403);
});

/* ================= повторная загрузка того же файла и состав разделов ================= */

test('состав разделов: required_basis у существующего раздела не обнуляется, если поле не передано', async (t) => {
  if (!available) return t.skip(unavailableReason);
  const created = await api('/api/normo/projects', { method: 'POST', ...json({ ...GOOD, name: 'Основания разделов' }) });
  assert.strictEqual(created.status, 201, JSON.stringify(created.body));
  const np = created.body.project;
  const pz = np.sections.find((s) => s.code === 'ПЗ');
  assert.ok(pz.required_basis, 'у раздела из состава по умолчанию есть основание');
  const same = await api(`/api/normo/projects/${np.id}/sections`, {
    method: 'PUT', ...json({ sections: [{ code: 'ПЗ', name: 'Пояснительная записка (переименована)' }, { code: 'АР', name: 'Архитектурные решения' }] }),
  });
  assert.strictEqual(same.status, 200, JSON.stringify(same.body));
  const kept = same.body.sections.find((s) => s.code === 'ПЗ');
  assert.strictEqual(kept.required_basis, pz.required_basis, 'основание обнулилось без поля в запросе');
  assert.strictEqual(kept.name, 'Пояснительная записка (переименована)');
  const changed = await api(`/api/normo/projects/${np.id}/sections`, {
    method: 'PUT', ...json({ sections: [{ code: 'ПЗ', name: 'ПЗ', required_basis: 'ТЗ п. 1.2' }, { code: 'АР', name: 'АР', required_basis: null }] }),
  });
  assert.strictEqual(changed.body.sections.find((s) => s.code === 'ПЗ').required_basis, 'ТЗ п. 1.2');
  assert.strictEqual(changed.body.sections.find((s) => s.code === 'АР').required_basis, null, 'явный null — снимает основание');
});

test('повторная загрузка того же docx: у новой версии свой прогон и те же замечания, сводка и заключение их видят', async (t) => {
  if (!available) return t.skip(unavailableReason);
  const pp = await api('/api/projects', { method: 'POST', ...json({ name: 'Кэш нормоконтроля' }) });
  const pid = pp.body.project.id;
  const created = await api('/api/normo/projects', { method: 'POST', ...json({ ...GOOD, name: 'Кэш', platformProjectId: pid }) });
  assert.strictEqual(created.status, 201, JSON.stringify(created.body));
  const np = created.body.project;
  // в имени и тексте нет шифра раздела — COM-ID-002 даёт замечание, COM-EDOC-007 доволен именем
  const file = ['Раздел ПД 1 записка.docx', docx('Пояснительная записка без обозначения'), DOCX_MIME];
  const up1 = await api(`/api/normo/projects/${np.id}/sections/ПЗ/versions`, { method: 'POST', headers: asUser(), body: form([file]) });
  assert.strictEqual(up1.status, 201, JSON.stringify(up1.body));
  assert.strictEqual(up1.body.check.cached, false);
  const run1 = await waitRun(up1.body.check.runId);
  assert.strictEqual(run1.status, 'done');
  const v1 = up1.body.version.id;
  const n1 = run1.findings.length;
  assert.ok(n1 >= 1, 'у первой версии обязано быть хотя бы одно замечание');
  assert.ok(run1.findings.some((f) => f.rule_id === 'COM-ID-002'), 'нет COM-ID-002');

  const up2 = await api(`/api/normo/projects/${np.id}/sections/ПЗ/versions`, { method: 'POST', headers: asUser(), body: form([file]) });
  assert.strictEqual(up2.status, 201, JSON.stringify(up2.body));
  const v2 = up2.body.version.id;
  assert.strictEqual(up2.body.version.version_no, 2);
  assert.strictEqual(up2.body.version.content_hash, up1.body.version.content_hash);
  assert.strictEqual(up2.body.check.cached, true, 'то же содержимое — из кэша');
  assert.notStrictEqual(up2.body.check.runId, up1.body.check.runId, 'у новой версии свой прогон, а не прогон старой');
  const run2 = await waitRun(up2.body.check.runId);
  assert.strictEqual(run2.status, 'done');
  assert.strictEqual(String(run2.version_id), String(v2));
  assert.strictEqual(run2.findings.length, n1, 'замечания не перенесены на новую версию');
  assert.ok(run2.journal.length >= run1.journal.length, 'журнал не перенесён');
  assert.ok(run2.findings.every((f) => f.status === 'open'));
  // у обеих версий замечания видны
  const f1 = await api(`/api/normo/versions/${v1}/findings`, { headers: asUser() });
  const f2 = await api(`/api/normo/versions/${v2}/findings`, { headers: asUser() });
  assert.strictEqual(f1.body.findings.filter((f) => f.status === 'open').length, n1);
  assert.strictEqual(f2.body.findings.length, n1);
  assert.ok(f2.body.findings.every((f) => f.predecessor_id), 'копия не связана с замечанием предыдущей версии');
  // повторный запуск проверки новой версии — тот же её прогон
  const again = await api(`/api/normo/versions/${v2}/check`, { method: 'POST', ...json({}) });
  assert.strictEqual(again.body.cached, true);
  assert.strictEqual(String(again.body.runId), String(run2.id));
  // сводка проекта платформы считает открытые замечания текущей версии и знает дату
  const store = require('../server/services/normo/store');
  const summary = await store.summaryByPlatform([pid]);
  assert.strictEqual(summary[pid].open_findings, n1);
  assert.ok(summary[pid].at, 'в сводке нет даты последней загрузки');
  const platform = await api(`/api/projects/${pid}`, { headers: asUser() });
  assert.strictEqual(platform.body.project.summary.normo.state, 'warn');
  assert.match(platform.body.project.summary.normo.line, /открыт/);
  assert.ok(platform.body.project.summary.normo.at);
  // заключение по второй версии видит прогон, а не «не проверялось»
  const { lastRun, payload } = await require('../server/services/normo/report-payload').buildPayload(v2, {});
  assert.ok(lastRun && String(lastRun.version_id) === String(v2), 'заключение второй версии не видит прогона');
  assert.ok(Object.values(payload.checks).some((c) => c.value !== null), 'все показатели «не проверялось»');
  assert.strictEqual(payload.findings.length, n1);
  // force — настоящий новый прогон второй версии
  const forced = await api(`/api/normo/versions/${v2}/check`, { method: 'POST', ...json({ force: true }) });
  assert.strictEqual(forced.body.cached, false);
  assert.notStrictEqual(String(forced.body.runId), String(run2.id));
  const run3 = await waitRun(forced.body.runId);
  assert.strictEqual(run3.findings.length, n1);
});

test('заключение: подпись нормоконтролёра — только по вошедшему, значение из тела игнорируется', async (t) => {
  if (!available) return t.skip(unavailableReason);
  const p = await api(`/api/normo/projects/${projectId}`, { headers: asUser() });
  const sm = p.body.project.sections.find((s) => s.code === 'СМ');
  const created = await api(`/api/normo/versions/${sm.current_version_id}/reports`, {
    method: 'POST', ...json({ reviewer: 'Подставной Хакер', verdictCompliant: false }),
  });
  assert.strictEqual(created.status, 201, JSON.stringify(created.body));
  assert.strictEqual(created.body.report.reviewer, 'Нормоконтролёров Тест');
  assert.strictEqual(created.body.report.form_payload.reviewer, 'Нормоконтролёров Тест');
  assert.match(created.body.report.checked_at, /^\d{4}-\d{2}-\d{2}$/, 'DATE заключения — строкой');
});

test('комплект удалённого проекта платформы читается по прямой ссылке, но не правится — 404 (круг 2, 04.09.2026)', async (t) => {
  if (!available) return t.skip(unavailableReason);
  const platform = await api('/api/projects', { method: 'POST', ...json({ name: 'На удаление (нормоконтроль)' }) });
  assert.strictEqual(platform.status, 201, JSON.stringify(platform.body));
  const pid = platform.body.project.id;
  const created = await api('/api/normo/projects', { method: 'POST', ...json({ ...GOOD, name: 'Комплект удалённого', platformProjectId: pid }) });
  assert.strictEqual(created.status, 201, JSON.stringify(created.body));
  const nid = created.body.project.id;
  assert.strictEqual((await api(`/api/projects/${pid}`, { method: 'DELETE', headers: asUser() })).status, 200);
  // чтение — 200, из списков комплект ушёл
  assert.strictEqual((await api(`/api/normo/projects/${nid}`, { headers: asUser() })).status, 200);
  const list = await api('/api/normo/projects', { headers: asUser() });
  assert.ok(!list.body.projects.some((p) => String(p.id) === String(nid)), 'комплект удалённого проекта в общем списке');
  // правка — 404 «Проект не найден»: состав, версия, новый комплект в том же проекте
  const sections = await api(`/api/normo/projects/${nid}/sections`, { method: 'PUT', ...json({ sections: [{ code: 'ПЗ', name: 'ПЗ' }] }) });
  assert.strictEqual(sections.status, 404, JSON.stringify(sections.body));
  assert.match(sections.body.error, /Проект не найден/);
  const version = await api(`/api/normo/projects/${nid}/sections/ПЗ/versions`, {
    method: 'POST', headers: asUser(), body: form([['Раздел ПД 1 ПЗ.txt', 'Пояснительная записка', 'text/plain']]),
  });
  assert.strictEqual(version.status, 404, JSON.stringify(version.body));
  const again = await api('/api/normo/projects', { method: 'POST', ...json({ ...GOOD, platformProjectId: pid }) });
  assert.strictEqual(again.status, 404);
});

test('удаление комплекта — мягкое: из списка и сводки уходит, по ссылке читается, повторно 404 (круг 2, 04.09.2026)', async (t) => {
  if (!available) return t.skip(unavailableReason);
  const platform = await api('/api/projects', { method: 'POST', ...json({ name: 'Проект с удаляемым комплектом' }) });
  assert.strictEqual(platform.status, 201, JSON.stringify(platform.body));
  const pid = platform.body.project.id;
  const created = await api('/api/normo/projects', { method: 'POST', ...json({ ...GOOD, name: 'Комплект на удаление', platformProjectId: pid }) });
  assert.strictEqual(created.status, 201, JSON.stringify(created.body));
  const nid = created.body.project.id;
  const before = await api('/api/projects', { headers: asUser() });
  const summaryBefore = before.body.projects.find((p) => p.id === pid).summary.normo;
  assert.strictEqual(summaryBefore.count, 1, 'сводка до удаления считает комплект');
  assert.strictEqual(summaryBefore.state, 'none', 'комплект без версий — «без прогона», а не зелёный ok');
  assert.match(summaryBefore.line, /без прогона/);
  const del = await api(`/api/normo/projects/${nid}`, { method: 'DELETE', headers: asUser() });
  assert.strictEqual(del.status, 200, JSON.stringify(del.body));
  assert.strictEqual((await api(`/api/normo/projects/${nid}`, { method: 'DELETE', headers: asUser() })).status, 404, 'повторное удаление');
  assert.strictEqual((await api(`/api/normo/projects/${nid}`, { headers: asUser() })).status, 200, 'прямая ссылка читается');
  const list = await api(`/api/normo/projects?project=${pid}`, { headers: asUser() });
  assert.ok(!list.body.projects.some((p) => String(p.id) === String(nid)), 'удалённый комплект в списке');
  const after = await api('/api/projects', { headers: asUser() });
  assert.strictEqual(after.body.projects.find((p) => p.id === pid).summary.normo.count, 0, 'сводка после удаления');
  assert.strictEqual((await api('/api/normo/projects/999999999', { method: 'DELETE', headers: asUser() })).status, 404);
});

/* ---------------- третий круг (04.09.2026) ---------------- */

test('круг 3: архивный комплект читается, но не правится — 404 «Комплект не найден» на любой записи', async (t) => {
  if (!available) return t.skip(unavailableReason);
  const created = await api('/api/normo/projects', { method: 'POST', ...json({ ...GOOD, name: 'Архив: правка' }) });
  assert.strictEqual(created.status, 201, JSON.stringify(created.body));
  const nid = created.body.project.id;
  const v = await api(`/api/normo/projects/${nid}/sections/ПЗ/versions`, {
    method: 'POST', headers: asUser(), body: form([['Раздел ПД 1 ПЗ.txt', 'Пояснительная записка', 'text/plain']]),
  });
  assert.strictEqual(v.status, 201, JSON.stringify(v.body));
  const vid = v.body.version.id;
  await waitRun(v.body.check.runId);
  assert.strictEqual((await api(`/api/normo/projects/${nid}`, { method: 'DELETE', headers: asUser() })).status, 200);
  // чтение — 200
  for (const url of [`/api/normo/projects/${nid}`, `/api/normo/versions/${vid}`, `/api/normo/versions/${vid}/findings`]) {
    assert.strictEqual((await api(url, { headers: asUser() })).status, 200, url);
  }
  // запись — 404: раньше версия грузилась в архивный комплект, и он жил невидимкой
  const writes = [
    () => api(`/api/normo/projects/${nid}/sections/ПЗ/versions`, { method: 'POST', headers: asUser(), body: form([['Раздел ПД 1 ПЗ.txt', 'ещё версия', 'text/plain']]) }),
    () => api(`/api/normo/projects/${nid}/sections`, { method: 'PUT', ...json({ sections: [{ code: 'ПЗ', name: 'x' }] }) }),
    () => api(`/api/normo/versions/${vid}/check`, { method: 'POST', ...json({ force: true }) }),
    () => api(`/api/normo/versions/${vid}/reports`, { method: 'POST', ...json({}) }),
    () => api(`/api/normo/projects/${nid}/input-data`, { method: 'POST', headers: asUser(), body: form([['ТЗ.txt', 'задание', 'text/plain']], { kind: 'ТЗ' }) }),
  ];
  for (const w of writes) {
    const r = await w();
    assert.strictEqual(r.status, 404, JSON.stringify(r.body));
    assert.strictEqual(r.body.error, 'Комплект не найден');
  }
  const versions = await api(`/api/normo/sections/${v.body.version.section_id}/versions`, { headers: asUser() });
  assert.strictEqual(versions.body.versions.length, 1, 'в архивный комплект добавилась версия');
});

test('круг 3: упавший прогон не считается кэшем — повторная проверка запускается заново, force не дублирует замечания', async (t) => {
  if (!available) return t.skip(unavailableReason);
  const created = await api('/api/normo/projects', { method: 'POST', ...json({ ...GOOD, name: 'Повтор после сбоя' }) });
  const nid = created.body.project.id;
  const v = await api(`/api/normo/projects/${nid}/sections/ПЗ/versions`, {
    method: 'POST', headers: asUser(), body: form([['Раздел ПД 1 ПЗ.txt', 'Пояснительная записка', 'text/plain']]),
  });
  assert.strictEqual(v.status, 201, JSON.stringify(v.body));
  const vid = v.body.version.id;
  const first = await waitRun(v.body.check.runId);
  assert.strictEqual(first.status, 'done');
  const openBefore = (await api(`/api/normo/versions/${vid}/findings?status=open`, { headers: asUser() })).body.findings.length;
  // прогон прерван (так его помечает recoverInterrupted после перезапуска)
  const db = require('../server/services/normo/db');
  await db.query("UPDATE analysis_runs SET status = 'failed', error = 'прерван перезапуском' WHERE id = $1", [first.id]);
  // раньше INSERT натыкался на тот же cache_key и отдавал упавший прогон как cached: true
  const again = await api(`/api/normo/versions/${vid}/check`, { method: 'POST', ...json({}) });
  assert.strictEqual(again.status, 200, JSON.stringify(again.body));
  assert.strictEqual(again.body.cached, false, 'упавший прогон выдан за кэш');
  assert.notStrictEqual(String(again.body.runId), String(first.id));
  const retried = await waitRun(again.body.runId);
  assert.strictEqual(retried.status, 'done');
  // готовый повтор — теперь кэш
  const cached = await api(`/api/normo/versions/${vid}/check`, { method: 'POST', ...json({}) });
  assert.strictEqual(cached.body.cached, true);
  assert.strictEqual(String(cached.body.runId), String(retried.id));
  // force даёт новый прогон, но у версии по-прежнему один комплект замечаний
  const forced = await api(`/api/normo/versions/${vid}/check`, { method: 'POST', ...json({ force: true }) });
  assert.strictEqual(forced.body.cached, false);
  const forcedRun = await waitRun(forced.body.runId);
  assert.strictEqual(forcedRun.status, 'done');
  const open = (await api(`/api/normo/versions/${vid}/findings?status=open`, { headers: asUser() })).body.findings;
  assert.strictEqual(open.length, openBefore, 'force удвоил открытые замечания версии');
  assert.ok(open.every((f) => String(f.run_id) === String(forcedRun.id)), 'замечания не перешли к новому прогону');
  assert.strictEqual(forcedRun.findings.length, openBefore);
});

test('круг 3: NUL-байт в строках не роняет PostgreSQL — вырезается; фильтры списков вне перечня — 400', async (t) => {
  if (!available) return t.skip(unavailableReason);
  const NUL = String.fromCharCode(0);
  const created = await api('/api/normo/projects', { method: 'POST', ...json({ ...GOOD, name: `Имя${NUL}с нулём`, customer: `Заказчик${NUL}` }) });
  assert.strictEqual(created.status, 201, JSON.stringify(created.body));
  assert.strictEqual(created.body.project.name, 'Имяс нулём');
  assert.strictEqual(created.body.project.customer, 'Заказчик');
  const nid = created.body.project.id;
  const sections = await api(`/api/normo/projects/${nid}/sections`, { method: 'PUT', ...json({ sections: [{ code: 'ПЗ', name: `ПЗ${NUL}` }] }) });
  assert.strictEqual(sections.status, 200, JSON.stringify(sections.body));
  assert.strictEqual(sections.body.sections[0].name, 'ПЗ');
  const v = await api(`/api/normo/projects/${nid}/sections/ПЗ/versions`, {
    method: 'POST', headers: asUser(), body: form([['Раздел ПД 1 ПЗ.txt', 'Пояснительная записка', 'text/plain']], { note: `прим${NUL}ечание`, author: `Автор${NUL}` }),
  });
  assert.strictEqual(v.status, 201, JSON.stringify(v.body));
  assert.strictEqual(v.body.version.note, 'примечание');
  assert.strictEqual(v.body.version.author, 'Автор');
  const vid = v.body.version.id;
  const input = await api(`/api/normo/projects/${nid}/input-data`, {
    method: 'POST', headers: asUser(), body: form([['ТЗ.txt', 'задание', 'text/plain']], { kind: 'ТЗ', title: `ТЗ${NUL}` }),
  });
  assert.strictEqual(input.status, 201, JSON.stringify(input.body));
  assert.strictEqual(input.body.input.title, 'ТЗ');
  // фильтры — только из перечня: NUL и произвольное слово раньше уходили в запрос и давали 500
  for (const [url, re] of [
    [`/api/normo/versions/${vid}/findings?status=%00`, /status: допустимо/],
    [`/api/normo/versions/${vid}/findings?status=zzz`, /status: допустимо/],
    [`/api/normo/versions/${vid}/findings?severity=%00`, /severity: допустимо/],
    [`/api/normo/projects/${nid}/findings?scope=%00`, /scope: допустимо/],
    [`/api/normo/projects/${nid}/requirements?status=%00`, /status: допустимо/],
  ]) {
    const r = await api(url, { headers: asUser() });
    assert.strictEqual(r.status, 400, `${url}: ${r.status} ${JSON.stringify(r.body)}`);
    assert.match(r.body.error, re);
  }
  assert.strictEqual((await api(`/api/normo/versions/${vid}/findings?status=open&severity=major`, { headers: asUser() })).status, 200);
  assert.strictEqual((await api(`/api/normo/projects/${nid}/findings?scope=document`, { headers: asUser() })).status, 200);
});

test('круг 3: параллельные загрузки в один раздел — все 201, номера версий подряд, текущая одна', async (t) => {
  if (!available) return t.skip(unavailableReason);
  const created = await api('/api/normo/projects', { method: 'POST', ...json({ ...GOOD, name: 'Гонка версий' }) });
  const nid = created.body.project.id;
  const results = await Promise.all([1, 2, 3].map((i) => api(`/api/normo/projects/${nid}/sections/ПЗ/versions`, {
    method: 'POST', headers: asUser(), body: form([['Раздел ПД 1 ПЗ.txt', `Пояснительная записка ${i}`, 'text/plain']]),
  })));
  for (const r of results) assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  const numbers = results.map((r) => r.body.version.version_no).sort();
  assert.deepStrictEqual(numbers, [1, 2, 3]);
  const versions = await api(`/api/normo/sections/${results[0].body.version.section_id}/versions`, { headers: asUser() });
  assert.strictEqual(versions.body.versions.length, 3);
  assert.strictEqual(versions.body.versions.filter((x) => x.is_current).length, 1);
  assert.strictEqual(versions.body.versions.find((x) => x.is_current).version_no, 3);
});

test('круг 3: пустой файл, исполняемое в исходных данных, длинный и повторный шифр, вердикт не булев — 422/400', async (t) => {
  if (!available) return t.skip(unavailableReason);
  const created = await api('/api/normo/projects', { method: 'POST', ...json({ ...GOOD, name: 'x'.repeat(500), customer: 'y'.repeat(500) }) });
  assert.strictEqual(created.status, 201, JSON.stringify(created.body));
  assert.strictEqual(created.body.project.name.length, 200, 'имя комплекта не ограничено');
  assert.strictEqual(created.body.project.customer.length, 200);
  const nid = created.body.project.id;
  const empty = await api(`/api/normo/projects/${nid}/sections/ПЗ/versions`, {
    method: 'POST', headers: asUser(), body: form([['Раздел ПД 1 ПЗ.txt', '', 'text/plain']]),
  });
  assert.strictEqual(empty.status, 422, JSON.stringify(empty.body));
  assert.match(empty.body.error, /пуст/);
  const exe = await api(`/api/normo/projects/${nid}/input-data`, {
    method: 'POST', headers: asUser(), body: form([['ТЗ.exe', 'MZ', 'application/octet-stream']], { kind: 'ТЗ' }),
  });
  assert.strictEqual(exe.status, 422, JSON.stringify(exe.body));
  assert.match(exe.body.error, /исполняемые/);
  const long = await api(`/api/normo/projects/${nid}/sections`, { method: 'PUT', ...json({ sections: [{ code: 'x'.repeat(65), name: 'y' }] }) });
  assert.strictEqual(long.status, 400, JSON.stringify(long.body));
  assert.match(long.body.error, /длиннее 64/);
  const dup = await api(`/api/normo/projects/${nid}/sections`, { method: 'PUT', ...json({ sections: [{ code: 'ПЗ', name: 'a' }, { code: 'ПЗ', name: 'b' }] }) });
  assert.strictEqual(dup.status, 400, JSON.stringify(dup.body));
  assert.match(dup.body.error, /повторяется/);
  const v = await api(`/api/normo/projects/${nid}/sections/ПЗ/versions`, {
    method: 'POST', headers: asUser(), body: form([['Раздел ПД 1 ПЗ.txt', 'Пояснительная записка', 'text/plain']]),
  });
  assert.strictEqual(v.status, 201, JSON.stringify(v.body));
  const junk = await api(`/api/normo/versions/${v.body.version.id}/reports`, { method: 'POST', ...json({ verdictCompliant: 'да' }) });
  assert.strictEqual(junk.status, 400, JSON.stringify(junk.body));
  assert.match(junk.body.error, /verdictCompliant/);
  const ok = await api(`/api/normo/versions/${v.body.version.id}/reports`, { method: 'POST', ...json({ verdictCompliant: true, verdictApproved: null }) });
  assert.strictEqual(ok.status, 201, JSON.stringify(ok.body));
  assert.strictEqual(ok.body.report.verdict_compliant, true);
  assert.strictEqual(ok.body.report.verdict_approved, null);
});
