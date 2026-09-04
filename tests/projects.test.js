'use strict';
/**
 * Проекты платформы: единица работы, внутри которой живут модули.
 * Проверяется: доступ только за входом; создание и список со сводкой по
 * шести модулям; привязка сессии посадки, проверки ТЗ и проверки документа
 * к проекту и фильтр списков по ?project=; правка, отметки прогонов,
 * мягкое удаление; переезд ранних записей в «Ранние работы».
 */
const os = require('os');
const path = require('path');
const fs = require('fs');
process.env.DATA_DIR = path.join(os.tmpdir(), `pilot1-projects-${process.pid}`);
process.env.ANTHROPIC_API_KEY = '';
process.env.USERS_FILE = path.join(os.tmpdir(), `pilot1-projects-users-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
process.env.RATE_LIMIT_GENERAL = '1000';
process.env.RATE_LIMIT_EXPENSIVE = '1000';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { createApp } = require('../server/app');
const projects = require('../server/services/projects');
const tzStore = require('../server/services/tz/store');

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

let userToken = '';
async function login(lastName = 'Проверяющий', firstName = 'Тест') {
  const { body } = await api('/api/auth/enter', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lastName, firstName }),
  });
  return body.token || '';
}
const asUser = (token = userToken) => ({ 'X-User-Token': token });
const json = (obj, token = userToken) => ({
  headers: { 'Content-Type': 'application/json', ...asUser(token) },
  body: JSON.stringify(obj),
});

const DEVICE = 'device-projects-test-0001';
let projectId = '';

test('проекты: без входа — 401', async () => {
  const r = await api('/api/projects');
  assert.strictEqual(r.status, 401);
});

test('проекты: создание и список со сводкой по шести модулям', async () => {
  userToken = await login();
  const bad = await api('/api/projects', { method: 'POST', ...json({ name: '   ' }) });
  assert.strictEqual(bad.status, 400);

  const r = await api('/api/projects', {
    method: 'POST',
    ...json({ name: 'АВИВАК-2', fullName: 'Цех культуральных и эмбриональных вакцин', client: 'ООО «НПП «АВИВАК»', stage: 'П' }),
  });
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  projectId = r.body.project.id;
  assert.strictEqual(r.body.project.name, 'АВИВАК-2');
  assert.strictEqual(r.body.project.created_by_name, 'Проверяющий Тест');
  const s = r.body.project.summary;
  for (const key of ['tz', 'site', 'doc', 'normo', 'gge', 'akty']) {
    assert.ok(s[key], `в сводке нет модуля ${key}`);
    assert.ok(typeof s[key].line === 'string' && s[key].line, `у ${key} нет строки состояния`);
  }
  assert.strictEqual(s.tz.state, 'none');
  assert.strictEqual(s.site.state, 'none');
  // база нормоконтроля в тесте недоступна — сводка честно говорит «off», а не падает
  assert.ok(['off', 'none'].includes(s.normo.state));

  const list = await api('/api/projects', { headers: asUser() });
  assert.strictEqual(list.status, 200);
  assert.ok(list.body.projects.some((p) => p.id === projectId && p.summary));
});

test('проекты: сессия посадки, проверка ТЗ и проверка документа привязываются и фильтруются', async () => {
  // сессия посадки с проектом
  const s1 = await api('/api/sessions', { method: 'POST', ...json({ deviceId: DEVICE, projectId }) });
  assert.strictEqual(s1.status, 201);
  // сессия без проекта
  const s2 = await api('/api/sessions', { method: 'POST', ...json({ deviceId: DEVICE }) });
  assert.strictEqual(s2.status, 201);

  const all = await api(`/api/devices/${DEVICE}/sessions`, { headers: asUser() });
  assert.strictEqual(all.body.sessions.length, 2);
  const mine = await api(`/api/devices/${DEVICE}/sessions?project=${projectId}`, { headers: asUser() });
  assert.deepStrictEqual(mine.body.sessions.map((s) => s.id), [s1.body.id]);

  // проверка ТЗ
  const tz1 = await api('/api/tz/projects', { method: 'POST', ...json({ name: 'ЗнП цеха', checklist: 'production', projectId }) });
  assert.strictEqual(tz1.status, 201, JSON.stringify(tz1.body));
  assert.strictEqual(tz1.body.project.project_id, projectId);
  const tz2 = await api('/api/tz/projects', { method: 'POST', ...json({ name: 'Чужое ЗнП', checklist: 'production' }) });
  assert.strictEqual(tz2.status, 201);
  const tzList = await api(`/api/tz/projects?project=${projectId}`, { headers: asUser() });
  assert.deepStrictEqual(tzList.body.projects.map((p) => p.id), [tz1.body.project.id]);
  const tzAll = await api('/api/tz/projects', { headers: asUser() });
  assert.strictEqual(tzAll.body.projects.length, 2);

  // проверка документа и сравнение A→B
  const dc = await api('/api/doccheck/checks', { method: 'POST', ...json({ name: 'АР, том 3', projectId }) });
  assert.strictEqual(dc.status, 201, JSON.stringify(dc.body));
  assert.strictEqual(dc.body.check.project_id, projectId);
  const ab = await api('/api/doccheck/ab', { method: 'POST', ...json({ name: 'Насос A→B', projectId }) });
  assert.strictEqual(ab.status, 201, JSON.stringify(ab.body));
  const dcOther = await api('/api/doccheck/checks', { headers: asUser() });
  const dcMine = await api(`/api/doccheck/checks?project=${projectId}`, { headers: asUser() });
  assert.strictEqual(dcOther.body.checks.length, 1);
  assert.strictEqual(dcMine.body.checks.length, 1);
  const abNone = await api('/api/doccheck/ab?project=nope', { headers: asUser() });
  assert.strictEqual(abNone.body.list.length, 0);

  // сводка проекта видит всё привязанное
  const p = await api(`/api/projects/${projectId}`, { headers: asUser() });
  assert.strictEqual(p.status, 200);
  assert.strictEqual(p.body.project.summary.site.count, 1);
  assert.strictEqual(p.body.project.summary.tz.count, 1);
  assert.strictEqual(p.body.project.summary.doc.count, 2);
  // без единого прогона — «none · без прогона», как у ТЗ, а не «ok»
  assert.strictEqual(p.body.project.summary.doc.state, 'none');
  assert.match(p.body.project.summary.doc.line, /1 проверка · 1 сравнение · без прогона/);
});

test('проекты: правка, отметки прогонов и мягкое удаление', async () => {
  const bad = await api(`/api/projects/${projectId}`, { method: 'PATCH', ...json({ name: '' }) });
  assert.strictEqual(bad.status, 400);
  const ren = await api(`/api/projects/${projectId}`, { method: 'PATCH', ...json({ name: 'АВИВАК-2 (П)', stage: 'П+Р' }) });
  assert.strictEqual(ren.status, 200);
  assert.strictEqual(ren.body.project.name, 'АВИВАК-2 (П)');
  assert.strictEqual(ren.body.project.stage, 'П+Р');

  const m0 = await api(`/api/projects/${projectId}/marks`, { method: 'POST', ...json({ module: 'чужой' }) });
  assert.strictEqual(m0.status, 400);
  const m1 = await api(`/api/projects/${projectId}/marks`, { method: 'POST', ...json({ module: 'gge', note: 'файлов: 7' }) });
  assert.strictEqual(m1.status, 200);
  const p = await api(`/api/projects/${projectId}`, { headers: asUser() });
  assert.strictEqual(p.body.project.summary.gge.state, 'ok');
  assert.match(p.body.project.summary.gge.line, /Последний прогон \d\d\.\d\d\.\d{4} · файлов: 7/);
  assert.strictEqual(p.body.project.summary.akty.state, 'none');

  const del = await api(`/api/projects/${projectId}`, { method: 'DELETE', headers: asUser() });
  assert.strictEqual(del.status, 200);
  const gone = await api(`/api/projects/${projectId}`, { headers: asUser() });
  assert.strictEqual(gone.status, 404);
  const again = await api(`/api/projects/${projectId}`, { method: 'DELETE', headers: asUser() });
  assert.strictEqual(again.status, 404);
  // задания удалённого проекта уходят из списков — и из фильтра, и из общего —
  // но по прямой ссылке остаются читаемыми (мягкое удаление)
  const tzOfDeleted = tzStore.listProjects({ projectId }).map((t) => t.id);
  assert.ok(tzOfDeleted.length >= 1, 'у удалённого проекта должно быть задание');
  const filtered = await api(`/api/tz/projects?project=${projectId}`, { headers: asUser() });
  assert.strictEqual(filtered.status, 404, JSON.stringify(filtered.body));
  const tzAll = await api('/api/tz/projects', { headers: asUser() });
  assert.strictEqual(tzAll.status, 200);
  assert.ok(!tzAll.body.projects.some((t) => tzOfDeleted.includes(t.id)), 'задание удалённого проекта в общем списке');
  assert.ok(tzAll.body.projects.length >= 1, 'задания живых проектов остались');
  const direct = await api(`/api/tz/projects/${tzOfDeleted[0]}`, { headers: asUser() });
  assert.strictEqual(direct.status, 200, 'по прямой ссылке задание удалённого проекта читается');
  const dcAll = await api('/api/doccheck/checks', { headers: asUser() });
  assert.ok(!dcAll.body.checks.some((c) => c.project_id === projectId), 'проверка удалённого проекта в общем списке');
  const abAll = await api('/api/doccheck/ab', { headers: asUser() });
  assert.ok(!abAll.body.list.some((c) => c.project_id === projectId), 'сравнение удалённого проекта в общем списке');
});

test('проекты: записи без проекта переезжают в «Ранние работы», повторно — ничего', async () => {
  // новое правило: без проекта запись сразу пишется в «Ранние работы» (как у нормоконтроля)
  const orphan = tzStore.createProject({ name: 'Старая проверка', checklist: 'production', object: {}, user: null });
  assert.strictEqual(orphan.project_id, projects.LEGACY_ID);
  // старые записи с пустым project_id (до появления проектов) по-прежнему переезжают при старте
  require('../server/db').db.prepare("UPDATE tz_projects SET project_id = '' WHERE id = ?").run(orphan.id);
  assert.strictEqual(tzStore.projectById(orphan.id).project_id, '');
  const moved = projects.migrateLegacy();
  assert.ok(moved >= 1, `переехало записей: ${moved}`);
  assert.strictEqual(tzStore.projectById(orphan.id).project_id, projects.LEGACY_ID);
  const legacy = projects.byId(projects.LEGACY_ID);
  assert.ok(legacy && legacy.name === 'Ранние работы');
  assert.strictEqual(projects.migrateLegacy(), 0);

  const list = await api(`/api/tz/projects?project=${projects.LEGACY_ID}`, { headers: asUser() });
  assert.ok(list.body.projects.some((p) => p.id === orphan.id));
  const p = await api(`/api/projects/${projects.LEGACY_ID}`, { headers: asUser() });
  assert.strictEqual(p.status, 200);
  assert.ok(p.body.project.summary.tz.count >= 1);
});

test('проекты: привязка — несуществующий или удалённый проект отвергается 404, кривой — 400, пустой уходит в «Ранние работы»', async () => {
  const { db } = require('../server/db');
  const ghost = 'no-such-project';
  const cases = [
    ['/api/sessions', { deviceId: DEVICE }],
    ['/api/tz/projects', { name: 'ЗнП', checklist: 'production' }],
    ['/api/doccheck/checks', { name: 'Проверка' }],
    ['/api/doccheck/ab', { name: 'Сравнение' }],
  ];
  for (const [url, body] of cases) {
    const r = await api(url, { method: 'POST', ...json({ ...body, projectId: ghost }) });
    assert.strictEqual(r.status, 404, `${url}: ${r.status} ${JSON.stringify(r.body)}`);
    assert.match(r.body.error, /Проект не найден/, url);
    const crooked = await api(url, { method: 'POST', ...json({ ...body, projectId: 'абв' }) });
    assert.strictEqual(crooked.status, 400, `${url}: ${crooked.status} ${JSON.stringify(crooked.body)}`);
  }
  // мягко удалённый проект — тоже 404
  const created = await api('/api/projects', { method: 'POST', ...json({ name: 'На удаление' }) });
  const deletedId = created.body.project.id;
  await api(`/api/projects/${deletedId}`, { method: 'DELETE', headers: asUser() });
  const gone = await api('/api/sessions', { method: 'POST', ...json({ deviceId: DEVICE, projectId: deletedId }) });
  assert.strictEqual(gone.status, 404, JSON.stringify(gone.body));

  // без projectId — «Ранние работы», и сам проект заведён на платформе
  const s = await api('/api/sessions', { method: 'POST', ...json({ deviceId: DEVICE }) });
  assert.strictEqual(s.status, 201);
  assert.strictEqual(db.prepare('SELECT project_id FROM sessions WHERE id = ?').get(s.body.id).project_id, projects.LEGACY_ID);
  const tz = await api('/api/tz/projects', { method: 'POST', ...json({ name: 'ЗнП без проекта', checklist: 'production' }) });
  assert.strictEqual(tz.body.project.project_id, projects.LEGACY_ID);
  const dc = await api('/api/doccheck/checks', { method: 'POST', ...json({ name: 'Проверка без проекта' }) });
  assert.strictEqual(dc.body.check.project_id, projects.LEGACY_ID);
  const ab = await api('/api/doccheck/ab', { method: 'POST', ...json({ name: 'Сравнение без проекта' }) });
  assert.strictEqual(ab.body.ab.project_id, projects.LEGACY_ID);
  assert.ok(projects.byId(projects.LEGACY_ID), 'проект «Ранние работы» не заведён');
});

test('проекты: невалидный ?project= в списках — 400, а не молчаливые «все записи»', async () => {
  const bad = encodeURIComponent('абв');
  for (const url of [`/api/devices/${DEVICE}/sessions`, '/api/tz/projects', '/api/doccheck/checks', '/api/doccheck/ab']) {
    const r = await api(`${url}?project=${bad}`, { headers: asUser() });
    assert.strictEqual(r.status, 400, `${url}: ${r.status} ${JSON.stringify(r.body)}`);
    assert.match(r.body.error, /Некорректный идентификатор проекта/, url);
  }
});

test('проекты: PATCH с пустым именем (null, пробелы) — 400, нестроковые поля — 400', async () => {
  const created = await api('/api/projects', { method: 'POST', ...json({ name: 'Правка полей' }) });
  const id = created.body.project.id;
  for (const name of [null, '   ', '']) {
    const r = await api(`/api/projects/${id}`, { method: 'PATCH', ...json({ name }) });
    assert.strictEqual(r.status, 400, `name=${JSON.stringify(name)}: ${r.status}`);
    assert.match(r.body.error, /не может быть пустым/);
  }
  for (const patch of [{ client: 5 }, { note: ['x'] }, { stage: { a: 1 } }, { fullName: true }, { name: 7 }]) {
    const r = await api(`/api/projects/${id}`, { method: 'PATCH', ...json(patch) });
    assert.strictEqual(r.status, 400, `${JSON.stringify(patch)}: ${r.status} ${JSON.stringify(r.body)}`);
    assert.match(r.body.error, /строкой/);
  }
  const create = await api('/api/projects', { method: 'POST', ...json({ name: 'X', stage: 7 }) });
  assert.strictEqual(create.status, 400, JSON.stringify(create.body));
  const createNum = await api('/api/projects', { method: 'POST', ...json({ name: 42 }) });
  assert.strictEqual(createNum.status, 400, JSON.stringify(createNum.body));
  // имя не тронуто
  const p = await api(`/api/projects/${id}`, { headers: asUser() });
  assert.strictEqual(p.body.project.name, 'Правка полей');
});

test('проекты: отметки только у модулей без хранения (gge, akty)', async () => {
  const created = await api('/api/projects', { method: 'POST', ...json({ name: 'Отметки' }) });
  const id = created.body.project.id;
  for (const module of ['tz', 'site', 'doc', 'normo']) {
    const r = await api(`/api/projects/${id}/marks`, { method: 'POST', ...json({ module }) });
    assert.strictEqual(r.status, 400, `${module}: ${r.status}`);
    assert.match(r.body.error, /без хранения \(gge, akty\)/);
  }
  const ok = await api(`/api/projects/${id}/marks`, { method: 'POST', ...json({ module: 'akty', note: 'актов: 3' }) });
  assert.strictEqual(ok.status, 200);
});

test('проекты: «Ранние работы» удалить нельзя, переименовать — можно', async () => {
  projects.ensureLegacy();
  const del = await api(`/api/projects/${projects.LEGACY_ID}`, { method: 'DELETE', headers: asUser() });
  assert.strictEqual(del.status, 400, JSON.stringify(del.body));
  assert.match(del.body.error, /Ранние работы/);
  assert.ok(projects.byId(projects.LEGACY_ID), 'проект пропал');
  // общий приёмник переименовывает только владелец платформы
  const denied = await api(`/api/projects/${projects.LEGACY_ID}`, { method: 'PATCH', ...json({ name: 'Ранние работы (архив)' }) });
  assert.strictEqual(denied.status, 403);
  const users = JSON.parse(fs.readFileSync(process.env.USERS_FILE, 'utf8'));
  users.users.find((u) => u.lastName === 'Проверяющий').owner = true;
  await new Promise((r) => setTimeout(r, 20));
  fs.writeFileSync(process.env.USERS_FILE, JSON.stringify(users));
  await new Promise((r) => setTimeout(r, 20));
  const ren = await api(`/api/projects/${projects.LEGACY_ID}`, { method: 'PATCH', ...json({ name: 'Ранние работы (архив)' }) });
  assert.strictEqual(ren.status, 200, JSON.stringify(ren.body));
  assert.strictEqual(ren.body.project.name, 'Ранние работы (архив)');
});

test('проекты: недоступная база нормоконтроля не опрашивается заново 30 секунд', async () => {
  const normoStore = require('../server/services/normo/store');
  const orig = normoStore.summaryByPlatform;
  let calls = 0;
  projects._resetNormoDown();
  normoStore.summaryByPlatform = async () => { calls += 1; throw new Error('ECONNREFUSED 127.0.0.1:5433'); };
  try {
    const first = await projects.summarize(['p1']);
    assert.strictEqual(first.p1.normo.state, 'off');
    assert.strictEqual(calls, 1);
    // база «ожила», но в окне 30 с к ней не ходят — ответ по-прежнему «недоступна»
    normoStore.summaryByPlatform = async () => { calls += 1; return {}; };
    const second = await projects.summarize(['p1']);
    assert.strictEqual(second.p1.normo.state, 'off');
    assert.strictEqual(calls, 1, 'в окне недоступности база опрошена повторно');
    // окно истекло — запрос уходит и сводка честная
    projects._resetNormoDown();
    const third = await projects.summarize(['p1']);
    assert.strictEqual(third.p1.normo.state, 'none');
    assert.strictEqual(calls, 2);
  } finally {
    normoStore.summaryByPlatform = orig;
    projects._resetNormoDown();
  }
});

/* ================= у каждого свой набор проектов (решение владельца 02.09.2026) ================= */

test('проекты: чужой проект не виден, не правится и не принимает записи; владелец видит всё', async () => {
  const mine = await api('/api/projects', { method: 'POST', ...json({ name: 'Свой проект' }) });
  assert.strictEqual(mine.status, 201);
  const myId = mine.body.project.id;
  assert.strictEqual(mine.body.project.can_edit, true);

  const other = await login('Соседов', 'Второй');
  // в списке соседа своего проекта первого человека нет, «Ранние работы» — общие, без правки
  const list = await api('/api/projects', { headers: asUser(other) });
  assert.ok(!list.body.projects.some((p) => p.id === myId), 'чужой проект в списке');
  const legacy = list.body.projects.find((p) => p.id === projects.LEGACY_ID);
  assert.ok(legacy && legacy.can_edit === false, '«Ранние работы» читаются всеми, правятся владельцем');
  // напрямую — как несуществующий
  assert.strictEqual((await api(`/api/projects/${myId}`, { headers: asUser(other) })).status, 404);
  assert.strictEqual((await api(`/api/projects/${myId}`, { method: 'PATCH', ...json({ name: 'Захвачен' }, other) })).status, 404);
  assert.strictEqual((await api(`/api/projects/${myId}`, { method: 'DELETE', headers: asUser(other) })).status, 404);
  // и завести в нём задание или сессию нельзя — ответ тот же 404: существование
  // чужого проекта не подтверждается ни одним маршрутом (единое правило 04.09.2026)
  const tz = await api('/api/tz/projects', { method: 'POST', ...json({ name: 'Чужое', checklist: 'production', projectId: myId }, other) });
  assert.strictEqual(tz.status, 404, JSON.stringify(tz.body));
  assert.match(tz.body.error, /Проект не найден/);
  const sess = await api('/api/sessions', { method: 'POST', ...json({ deviceId: 'device-other-000001', projectId: myId }, other) });
  assert.strictEqual(sess.status, 404);
  const filtered = await api(`/api/tz/projects?project=${myId}`, { headers: asUser(other) });
  assert.strictEqual(filtered.status, 404, JSON.stringify(filtered.body));
  assert.match(filtered.body.error, /Проект не найден/);
  // общий проект править нельзя, читать можно
  assert.strictEqual((await api(`/api/projects/${projects.LEGACY_ID}`, { method: 'PATCH', ...json({ name: 'x' }, other) })).status, 403);
  assert.strictEqual((await api(`/api/projects/${projects.LEGACY_ID}`, { headers: asUser(other) })).status, 200);

  // владелец платформы (owner в users.json) видит и правит всё
  const users = JSON.parse(fs.readFileSync(process.env.USERS_FILE, 'utf8'));
  const me = users.users.find((u) => u.lastName === 'Соседов');
  me.owner = true;
  await new Promise((r) => setTimeout(r, 20));
  fs.writeFileSync(process.env.USERS_FILE, JSON.stringify(users));
  await new Promise((r) => setTimeout(r, 20));
  const asOwner = await api('/api/projects', { headers: asUser(other) });
  assert.ok(asOwner.body.projects.some((p) => p.id === myId && p.can_edit === true), 'владелец видит чужой проект и может править');
  assert.strictEqual((await api(`/api/projects/${myId}`, { method: 'PATCH', ...json({ note: 'владелец был здесь' }, other) })).status, 200);
});
