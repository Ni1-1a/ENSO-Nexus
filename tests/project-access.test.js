'use strict';
/**
 * Гейт «свои проекты» на записях модулей (второй круг проверки, 04.09.2026):
 * задание ТЗ, проверка документа, сравнение A→B и их прогоны берутся не по
 * одному id, а с проверкой проекта — чужое для человека не существует (404),
 * чужое в общем проекте «Ранние работы» читается, но правится только автором
 * записи или владельцем платформы (403). Отдельно: отметки прогонов ставит
 * тот, кто вправе править проект; владелец платформы видит все сессии чужого
 * проекта и может взять их токен; явный projectId 'legacy' — только владельцу;
 * служебные сессии модулей не держат открытого токена; мелочи проверки тела.
 */
const os = require('os');
const path = require('path');
const fs = require('fs');
process.env.DATA_DIR = path.join(os.tmpdir(), `pilot1-access-${process.pid}`);
process.env.ANTHROPIC_API_KEY = '';
process.env.USERS_FILE = path.join(os.tmpdir(), `pilot1-access-users-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
process.env.RATE_LIMIT_GENERAL = '1000';
process.env.RATE_LIMIT_EXPENSIVE = '1000';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { createApp } = require('../server/app');
const { db } = require('../server/db');
const projects = require('../server/services/projects');
const tzStore = require('../server/services/tz/store');
const dcStore = require('../server/services/doccheck/store');
const ab = require('../server/services/doccheck/ab');

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
  return body.token || '';
}
const asUser = (token) => ({ 'X-User-Token': token });
const json = (obj, token) => ({
  headers: { 'Content-Type': 'application/json', ...asUser(token) },
  body: JSON.stringify(obj),
});

/** Владелец платформы — отметка owner в users.json; файл перечитывается по mtime. */
async function makeOwner(lastName) {
  const users = JSON.parse(fs.readFileSync(process.env.USERS_FILE, 'utf8'));
  users.users.find((u) => u.lastName === lastName).owner = true;
  await new Promise((r) => setTimeout(r, 20));
  fs.writeFileSync(process.env.USERS_FILE, JSON.stringify(users));
  await new Promise((r) => setTimeout(r, 20));
}

const FOREIGN = /чужая запись/;
let first = ''; let second = ''; let owner = '';
let myProject = '';
let tzId = ''; let dcId = ''; let abId = '';

test('доступ: заготовка — три человека, проект первого и записи модулей в нём', async () => {
  first = await login('Первов', 'Автор');
  second = await login('Второв', 'Сосед');
  owner = await login('Хозяинов', 'Платформы');
  await makeOwner('Хозяинов');
  const p = await api('/api/projects', { method: 'POST', ...json({ name: 'Проект первого' }, first) });
  assert.strictEqual(p.status, 201);
  myProject = p.body.project.id;
  const tz = await api('/api/tz/projects', { method: 'POST', ...json({ name: 'ЗнП первого', checklist: 'production', projectId: myProject }, first) });
  assert.strictEqual(tz.status, 201, JSON.stringify(tz.body));
  tzId = tz.body.project.id;
  // в ответе на создание нет ни текста документа, ни сырого object_json (как в GET)
  assert.ok(!('document_text' in tz.body.project) || tz.body.project.document_text === undefined);
  assert.strictEqual(tz.body.project.object_json, undefined);
  assert.deepStrictEqual(tz.body.project.object, {});
  const dc = await api('/api/doccheck/checks', { method: 'POST', ...json({ name: 'Проверка первого', projectId: myProject }, first) });
  assert.strictEqual(dc.status, 201, JSON.stringify(dc.body));
  dcId = dc.body.check.id;
  const cmp = await api('/api/doccheck/ab', { method: 'POST', ...json({ name: 'Сравнение первого', projectId: myProject }, first) });
  assert.strictEqual(cmp.status, 201, JSON.stringify(cmp.body));
  abId = cmp.body.ab.id;
  // текст документа — чтобы были прогоны для проверки доступа к ним
  const doc = await api(`/api/tz/projects/${tzId}/document`, { method: 'PUT', ...json({ text: 'Задание на проектирование цеха', name: 'тз.txt' }, first) });
  assert.strictEqual(doc.status, 200, JSON.stringify(doc.body));
});

test('доступ: второй человек не читает и не правит задание ТЗ, проверку, сравнение и прогоны первого — 404', async () => {
  const run = tzStore.createRun(tzStore.projectById(tzId), null);
  const dcRun = dcStore.createRun(dcStore.checkById(dcId), null);
  const reads = [
    `/api/tz/projects/${tzId}`, `/api/tz/projects/${tzId}/document`, `/api/tz/runs/${run.id}`,
    `/api/tz/runs/${run.id}/export.xlsx`, `/api/tz/runs/${run.id}/export.docx`,
    `/api/doccheck/checks/${dcId}`, `/api/doccheck/runs/${dcRun.id}`, `/api/doccheck/runs/${dcRun.id}/export.xlsx`,
    `/api/doccheck/ab/${abId}`, `/api/doccheck/ab/${abId}/export.xlsx`,
  ];
  for (const url of reads) {
    const r = await api(url, { headers: asUser(second) });
    assert.strictEqual(r.status, 404, `${url}: ${r.status} ${JSON.stringify(r.body)}`);
  }
  const writes = [
    ['PATCH', `/api/tz/projects/${tzId}`, { name: 'Захват' }],
    ['DELETE', `/api/tz/projects/${tzId}`],
    ['PUT', `/api/tz/projects/${tzId}/document`, { text: 'чужой текст' }],
    ['POST', `/api/tz/projects/${tzId}/analyze`, {}],
    ['POST', `/api/tz/runs/${run.id}/findings/x/decision`, { decision: 'accepted' }],
    ['PATCH', `/api/doccheck/checks/${dcId}`, { name: 'Захват' }],
    ['DELETE', `/api/doccheck/checks/${dcId}`],
    ['PUT', `/api/doccheck/checks/${dcId}/document`, { text: 'чужой текст' }],
    ['POST', `/api/doccheck/checks/${dcId}/analyze`, {}],
    ['POST', `/api/doccheck/runs/${dcRun.id}/findings/x/decision`, { decision: 'accepted' }],
    ['PATCH', `/api/doccheck/ab/${abId}`, { name: 'Захват' }],
    ['DELETE', `/api/doccheck/ab/${abId}`],
    ['PUT', `/api/doccheck/ab/${abId}/docs/a`, { text: 'чужой текст' }],
    ['DELETE', `/api/doccheck/ab/${abId}/docs/a`],
    ['POST', `/api/doccheck/ab/${abId}/run`, {}],
    ['POST', `/api/doccheck/ab/${abId}/rows/x/decision`, { decision: 'ПОДТВЕРЖДЕНО' }],
  ];
  for (const [method, url, body] of writes) {
    const r = await api(url, body ? { method, ...json(body, second) } : { method, headers: asUser(second) });
    assert.strictEqual(r.status, 404, `${method} ${url}: ${r.status} ${JSON.stringify(r.body)}`);
  }
  // файлы — тоже
  const fd = new FormData();
  fd.append('file', new Blob(['текст']), 'x.txt');
  const up = await api(`/api/tz/projects/${tzId}/document/file`, { method: 'POST', headers: asUser(second), body: fd });
  assert.strictEqual(up.status, 404, JSON.stringify(up.body));
  const fd2 = new FormData();
  fd2.append('file', new Blob(['текст']), 'x.txt');
  const upDc = await api(`/api/doccheck/checks/${dcId}/document/file`, { method: 'POST', headers: asUser(second), body: fd2 });
  assert.strictEqual(upDc.status, 404, JSON.stringify(upDc.body));
  // записи целы: автор читает и правит
  assert.strictEqual((await api(`/api/tz/projects/${tzId}`, { headers: asUser(first) })).status, 200);
  assert.strictEqual((await api(`/api/tz/projects/${tzId}`, { method: 'PATCH', ...json({ name: 'ЗнП первого (П)' }, first) })).status, 200);
  assert.strictEqual((await api(`/api/doccheck/checks/${dcId}`, { headers: asUser(first) })).status, 200);
  assert.strictEqual((await api(`/api/doccheck/ab/${abId}`, { headers: asUser(first) })).status, 200);
  // владелец платформы видит и правит всё
  assert.strictEqual((await api(`/api/tz/projects/${tzId}`, { headers: asUser(owner) })).status, 200);
  assert.strictEqual((await api(`/api/doccheck/checks/${dcId}`, { method: 'PATCH', ...json({ name: 'Правка владельца' }, owner) })).status, 200);
  // общие списки соседа не содержат чужого
  assert.ok(!(await api('/api/tz/projects', { headers: asUser(second) })).body.projects.some((p) => p.id === tzId));
  assert.ok(!(await api('/api/doccheck/checks', { headers: asUser(second) })).body.checks.some((c) => c.id === dcId));
  assert.ok(!(await api('/api/doccheck/ab', { headers: asUser(second) })).body.list.some((c) => c.id === abId));
  // а у владельца платформы — содержат
  assert.ok((await api('/api/tz/projects', { headers: asUser(owner) })).body.projects.some((p) => p.id === tzId));
});

test('доступ: в «Ранних работах» чужая запись читается, а правится только автором или владельцем — 403', async () => {
  // записи без projectId — «Ранние работы»; кто завёл, тот и правит
  const tz = await api('/api/tz/projects', { method: 'POST', ...json({ name: 'Раннее ЗнП первого', checklist: 'production' }, first) });
  assert.strictEqual(tz.status, 201, JSON.stringify(tz.body));
  assert.strictEqual(tz.body.project.project_id, projects.LEGACY_ID);
  const dc = await api('/api/doccheck/checks', { method: 'POST', ...json({ name: 'Ранняя проверка первого' }, first) });
  const cmp = await api('/api/doccheck/ab', { method: 'POST', ...json({ name: 'Раннее сравнение первого' }, first) });
  const legacyTz = tz.body.project.id; const legacyDc = dc.body.check.id; const legacyAb = cmp.body.ab.id;

  // сосед читает
  assert.strictEqual((await api(`/api/tz/projects/${legacyTz}`, { headers: asUser(second) })).status, 200);
  assert.strictEqual((await api(`/api/doccheck/checks/${legacyDc}`, { headers: asUser(second) })).status, 200);
  assert.strictEqual((await api(`/api/doccheck/ab/${legacyAb}`, { headers: asUser(second) })).status, 200);
  assert.ok((await api('/api/tz/projects', { headers: asUser(second) })).body.projects.some((p) => p.id === legacyTz));
  // но не правит
  const denied = [
    ['PATCH', `/api/tz/projects/${legacyTz}`, { name: 'Захват' }],
    ['DELETE', `/api/tz/projects/${legacyTz}`],
    ['PUT', `/api/tz/projects/${legacyTz}/document`, { text: 'чужой текст' }],
    ['PATCH', `/api/doccheck/checks/${legacyDc}`, { name: 'Захват' }],
    ['PUT', `/api/doccheck/checks/${legacyDc}/document`, { text: 'чужой текст' }],
    ['DELETE', `/api/doccheck/checks/${legacyDc}`],
    ['PATCH', `/api/doccheck/ab/${legacyAb}`, { name: 'Захват' }],
    ['PUT', `/api/doccheck/ab/${legacyAb}/docs/b`, { text: 'чужой текст' }],
    ['DELETE', `/api/doccheck/ab/${legacyAb}`],
  ];
  for (const [method, url, body] of denied) {
    const r = await api(url, body ? { method, ...json(body, second) } : { method, headers: asUser(second) });
    assert.strictEqual(r.status, 403, `${method} ${url}: ${r.status} ${JSON.stringify(r.body)}`);
    assert.match(r.body.error, FOREIGN, url);
  }
  // автор и владелец платформы — правят
  assert.strictEqual((await api(`/api/tz/projects/${legacyTz}`, { method: 'PATCH', ...json({ name: 'Своё' }, first) })).status, 200);
  assert.strictEqual((await api(`/api/doccheck/checks/${legacyDc}`, { method: 'PATCH', ...json({ name: 'Своё' }, first) })).status, 200);
  assert.strictEqual((await api(`/api/doccheck/ab/${legacyAb}`, { method: 'PATCH', ...json({ name: 'Своё' }, first) })).status, 200);
  assert.strictEqual((await api(`/api/tz/projects/${legacyTz}`, { method: 'PATCH', ...json({ name: 'Правка владельца' }, owner) })).status, 200);
  // своя ранняя запись соседа — ему же и править
  const own = await api('/api/tz/projects', { method: 'POST', ...json({ name: 'Раннее ЗнП соседа', checklist: 'production' }, second) });
  assert.strictEqual((await api(`/api/tz/projects/${own.body.project.id}`, { method: 'PATCH', ...json({ name: 'Моё' }, second) })).status, 200);
  assert.strictEqual((await api(`/api/tz/projects/${own.body.project.id}`, { method: 'PATCH', ...json({ name: 'Не моё' }, first) })).status, 403);
});

test('доступ: явный projectId «legacy» — только владельцу платформы, пустой — по-прежнему «Ранние работы»', async () => {
  for (const [url, body] of [
    ['/api/tz/projects', { name: 'В ранние', checklist: 'production' }],
    ['/api/doccheck/checks', { name: 'В ранние' }],
    ['/api/doccheck/ab', { name: 'В ранние' }],
    ['/api/sessions', { deviceId: 'device-access-test-0001' }],
  ]) {
    const r = await api(url, { method: 'POST', ...json({ ...body, projectId: 'legacy' }, second) });
    assert.strictEqual(r.status, 403, `${url}: ${r.status} ${JSON.stringify(r.body)}`);
    assert.match(r.body.error, /Ранние работы.*владелец платформы/, url);
    const empty = await api(url, { method: 'POST', ...json({ ...body, projectId: '' }, second) });
    assert.strictEqual(empty.status, 201, `${url}: ${empty.status} ${JSON.stringify(empty.body)}`);
    const asOwner = await api(url, { method: 'POST', ...json({ ...body, projectId: 'legacy' }, owner) });
    assert.strictEqual(asOwner.status, 201, `${url} (владелец): ${asOwner.status} ${JSON.stringify(asOwner.body)}`);
  }
});

test('отметки прогонов (акты, ГГЭ): чужой проект — 404, «Ранние работы» не владельцем — 403, свой — ставится', async () => {
  projects.ensureLegacy();
  const gge = (token, pid) => {
    const fd = new FormData();
    fd.append('files', new Blob(['Название объекта: Цех'], { type: 'text/plain' }), 'Раздел ПД 1 ПЗ.txt');
    return api(`/api/gge/check?project=${pid}`, { method: 'POST', headers: asUser(token), body: fd });
  };
  const akty = (token, pid) => api(`/api/akty/generate?project=${pid}`, { method: 'POST', headers: asUser(token), body: new FormData() });
  const marks = (token, pid, module) => api(`/api/projects/${pid}/marks`, { method: 'POST', ...json({ module }, token) });

  // чужой проект — 404 у всех трёх маршрутов
  for (const r of [await gge(second, myProject), await akty(second, myProject), await marks(second, myProject, 'gge')]) {
    assert.strictEqual(r.status, 404, JSON.stringify(r.body));
    assert.match(r.body.error, /Проект не найден/);
  }
  // «Ранние работы» не владельцем — 403
  for (const r of [await gge(second, 'legacy'), await akty(second, 'legacy'), await marks(second, 'legacy', 'akty')]) {
    assert.strictEqual(r.status, 403, JSON.stringify(r.body));
  }
  // несуществующий — 404, кривой — 400
  assert.strictEqual((await gge(first, 'no-such-project')).status, 404);
  assert.strictEqual((await gge(first, encodeURIComponent('абв'))).status, 400);
  // свой — отметка стоит; владелец платформы ставит и в «Ранние работы»
  const ok = await gge(first, myProject);
  assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
  const p = await api(`/api/projects/${myProject}`, { headers: asUser(first) });
  assert.strictEqual(p.body.project.summary.gge.state, 'ok');
  assert.strictEqual((await marks(first, myProject, 'akty')).status, 200);
  assert.strictEqual((await marks(owner, 'legacy', 'akty')).status, 200);
  assert.strictEqual((await gge(owner, 'legacy')).status, 200);
  // отметка не ставится мимо проверки: у соседа проект без отметок
  const mine = await api('/api/projects', { method: 'POST', ...json({ name: 'Проект соседа' }, second) });
  assert.strictEqual((await gge(first, mine.body.project.id)).status, 404);
  assert.strictEqual((await api(`/api/projects/${mine.body.project.id}`, { headers: asUser(second) })).body.project.summary.gge.state, 'none');
});

test('владелец платформы видит все сессии чужого проекта и может взять токен любой', async () => {
  const DEVICE = 'device-access-owner-0001';
  const s1 = await api('/api/sessions', { method: 'POST', ...json({ deviceId: DEVICE, projectId: myProject }, first) });
  assert.strictEqual(s1.status, 201);
  // сосед проект не видит — 404 и на списке
  const asSecond = await api(`/api/devices/${DEVICE}/sessions?project=${myProject}`, { headers: asUser(second) });
  assert.strictEqual(asSecond.status, 404);
  // владелец видит сессию первого в его проекте
  const asOwner = await api(`/api/devices/${DEVICE}/sessions?project=${myProject}`, { headers: asUser(owner) });
  assert.strictEqual(asOwner.status, 200, JSON.stringify(asOwner.body));
  assert.ok(asOwner.body.sessions.some((s) => s.id === s1.body.id), 'владелец не видит чужую сессию проекта');
  assert.ok(asOwner.body.sessions.every((s) => !('token' in s)));
  // без ?project= список по-прежнему свой: чужие сессии в него не попадают
  const ownList = await api(`/api/devices/${DEVICE}/sessions`, { headers: asUser(owner) });
  assert.ok(!ownList.body.sessions.some((s) => s.id === s1.body.id));
  // токен чужой сессии: соседу 403, владельцу — новый токен, и он работает
  assert.strictEqual((await api(`/api/sessions/${s1.body.id}/token`, { method: 'POST', ...json({}, second) })).status, 403);
  const tok = await api(`/api/sessions/${s1.body.id}/token`, { method: 'POST', ...json({}, owner) });
  assert.strictEqual(tok.status, 200, JSON.stringify(tok.body));
  const view = await api(`/api/sessions/${s1.body.id}`, { headers: { Authorization: `Bearer ${tok.body.token}`, ...asUser(owner) } });
  assert.strictEqual(view.status, 200);
  // хозяин сессии не переписан на владельца
  const userId = db.prepare('SELECT user_id FROM sessions WHERE id = ?').get(s1.body.id).user_id;
  assert.notStrictEqual(userId, '');
  assert.notStrictEqual(userId, JSON.parse(fs.readFileSync(process.env.USERS_FILE, 'utf8')).users.find((u) => u.lastName === 'Хозяинов').id);
});

test('служебные сессии модулей не держат открытого токена: в базе только хеш', async () => {
  const tz = tzStore.projectById(tzId);
  tzStore.ensureServiceSession(tz, null, 'localhost');
  const check = dcStore.checkById(dcId);
  dcStore.ensureServiceSession(check, null, 'localhost');
  const cmp = ab.abById(abId);
  ab.ensureServiceSession(cmp, null, 'localhost');
  const ingest = require('../server/services/dataset/ingest');
  const dsStore = require('../server/services/dataset/store');
  const doc = dsStore.createDocument({
    filename: 'тест.txt', fileSha: 'a'.repeat(64), format: 'txt', mime: 'text/plain', size: 1,
    storedPath: path.join(process.env.DATA_DIR, 'x.txt'), user: null,
  });
  ingest.ensureServiceSession(doc, null, 'localhost');
  const service = db.prepare("SELECT id, token, token_hash FROM sessions WHERE status = 'service'").all();
  assert.ok(service.length >= 4, `служебных сессий: ${service.length}`);
  for (const row of service) {
    assert.strictEqual(row.token, '', `служебная сессия ${row.id} держит открытый токен`);
    assert.match(row.token_hash, /^[0-9a-f]{64}$/, `у служебной сессии ${row.id} нет хеша`);
  }
  assert.strictEqual(db.prepare("SELECT count(*) AS n FROM sessions WHERE token <> '' AND token_hash = ''").get().n, 0);
});

test('мелочи: «не указан» вместо null, нестроки в теле — 400, снятый тип снимает промпт, лимиты в /health', async () => {
  const badTz = await api(`/api/tz/projects/${tzId}`, { method: 'PATCH', ...json({ checklist: null }, first) });
  assert.strictEqual(badTz.status, 400);
  assert.match(badTz.body.error, /Неизвестный чек-лист: не указан/);
  const badType = await api(`/api/doccheck/checks/${dcId}`, { method: 'PATCH', ...json({ chosen_type: null }, first) });
  assert.strictEqual(badType.status, 400);
  assert.match(badType.body.error, /Неизвестный тип документа: не указан/);

  for (const [url, body] of [
    [`/api/tz/projects/${tzId}/document`, { text: { a: 1 } }],
    [`/api/tz/projects/${tzId}/document`, { text: 'ок', name: ['x'] }],
    [`/api/doccheck/checks/${dcId}/document`, { text: 42 }],
    [`/api/doccheck/ab/${abId}/docs/a`, { text: { a: 1 } }],
  ]) {
    const r = await api(url, { method: 'PUT', ...json(body, first) });
    assert.strictEqual(r.status, 400, `${url}: ${r.status} ${JSON.stringify(r.body)}`);
    assert.match(r.body.error, /должно быть строкой/);
  }
  for (const [url] of [[`/api/tz/projects/${tzId}`], [`/api/doccheck/checks/${dcId}`], [`/api/doccheck/ab/${abId}`]]) {
    const r = await api(url, { method: 'PATCH', ...json({ name: { a: 1 } }, first) });
    assert.strictEqual(r.status, 400, `${url}: ${r.status} ${JSON.stringify(r.body)}`);
    assert.match(r.body.error, /строкой/);
  }
  // документ ТЗ не тронут объектом
  const doc = await api(`/api/tz/projects/${tzId}/document`, { headers: asUser(first) });
  assert.strictEqual(doc.body.text, 'Задание на проектирование цеха');

  // выбранный тип со своим промптом; снятие типа («») снимает и промпт
  const doclib = require('../server/services/doclib');
  const type = Object.keys(doclib.ROUTES).find((t) => t !== 'tz');
  const set = await api(`/api/doccheck/checks/${dcId}`, {
    method: 'PATCH', ...json({ chosen_type: type, chosen_prompt_id: doclib.ROUTES[type].promptId }, first),
  });
  assert.strictEqual(set.status, 200, JSON.stringify(set.body));
  assert.strictEqual(set.body.check.chosen_prompt_id, doclib.ROUTES[type].promptId);
  const unset = await api(`/api/doccheck/checks/${dcId}`, { method: 'PATCH', ...json({ chosen_type: '' }, first) });
  assert.strictEqual(unset.status, 200, JSON.stringify(unset.body));
  assert.strictEqual(unset.body.check.chosen_type, '');
  assert.strictEqual(unset.body.check.chosen_prompt_id, '');

  const health = await api('/api/health');
  assert.strictEqual(health.status, 200);
  assert.ok(health.body.limits.uploadTotalMb > 0);
  assert.ok(health.body.limits.zipEntryMb > 0);
  assert.ok(health.body.limits.docCharLimit > 0);
});
