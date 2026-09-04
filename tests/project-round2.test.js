'use strict';
/**
 * Второй круг проверки REST (04.09.2026): что нашёл чёрный ящик после первого.
 *  - типы полей на создании записей модулей: объект и число в name/provider/model
 *    раньше становились «[object Object]» и «5» (PATCH их отвергал, POST — нет);
 *    massив в module отметки сходил за «gge», объект в note — за «[object Object]»;
 *    массив в projectId приводился к строке; chosen_prompt_id: null — к «null»;
 *  - запись мягко удалённого проекта читается по прямой ссылке, но правка в нём —
 *    404 «Проект не найден» (правило «всё в удалённом проекте — 404»);
 *  - сессии: список без ?project= не показывает сессии удалённого проекта (как
 *    задания и проверки); автор проекта видит ВСЕ сессии своего проекта (в том
 *    числе заведённые владельцем платформы) и может взять их токен — список
 *    сходится со сводкой; S+U-маршруты открыты хозяину сессии, автору проекта и
 *    владельцу платформы (sessionOwner), а не только хозяину;
 *  - служебные сессии модулей получают project_id записи сразу: с пустым они
 *    при каждом перезапуске «переезжали» в «Ранние работы», и migrateLegacy
 *    переставал быть повторно пустым.
 */
const os = require('os');
const path = require('path');
const fs = require('fs');
process.env.DATA_DIR = path.join(os.tmpdir(), `pilot1-round2-${process.pid}`);
process.env.ANTHROPIC_API_KEY = '';
process.env.AI_PROVIDER = 'mock';
process.env.USERS_FILE = path.join(os.tmpdir(), `pilot1-round2-users-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
process.env.RATE_LIMIT_GENERAL = '1000';
process.env.RATE_LIMIT_EXPENSIVE = '1000';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { createApp } = require('../server/app');
const { db } = require('../server/db');
const projects = require('../server/services/projects');

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
const sessionJson = (obj, sessionToken, userToken) => ({
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${sessionToken}`, ...asUser(userToken) },
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

let author = ''; let neighbour = ''; let owner = '';
let myProject = '';

test('круг 2: заготовка — три человека и проект автора', async () => {
  author = await login('Авторов', 'Проекта');
  neighbour = await login('Соседов', 'Чужой');
  owner = await login('Владельцев', 'Платформы');
  await makeOwner('Владельцев');
  const p = await api('/api/projects', { method: 'POST', ...json({ name: 'Проект автора' }, author) });
  assert.strictEqual(p.status, 201);
  myProject = p.body.project.id;
});

test('круг 2: нестроки в полях создания и отметок — 400, а не «[object Object]» в базе', async () => {
  const cases = [
    ['/api/tz/projects', { name: { a: 1 } }],
    ['/api/tz/projects', { name: 'x', model: { a: 1 } }],
    ['/api/tz/projects', { name: 'x', provider: 5 }],
    ['/api/tz/projects', { name: 'x', object: [1, 2] }],
    ['/api/tz/projects', { name: 'x', object: { big: 'x'.repeat(25000) } }],
    ['/api/tz/projects', { name: 'x', projectId: ['a'] }],
    ['/api/doccheck/checks', { name: { a: 1 } }],
    ['/api/doccheck/checks', { name: 'x', provider: 5 }],
    ['/api/doccheck/ab', { name: 7 }],
    ['/api/doccheck/ab', { name: 'x', model: ['m'] }],
    ['/api/sessions', { projectId: { a: 1 } }],
    [`/api/projects/${myProject}/marks`, { module: ['gge'] }],
    [`/api/projects/${myProject}/marks`, { module: 'gge', note: { a: 1 } }],
  ];
  for (const [url, body] of cases) {
    const r = await api(url, { method: 'POST', ...json(body, author) });
    assert.strictEqual(r.status, 400, `${url} ${JSON.stringify(body)} → ${r.status} ${JSON.stringify(r.body)}`);
  }
  // null и пустой projectId по-прежнему — «Ранние работы» (владелец), note: null — допустимо
  const okNull = await api('/api/tz/projects', { method: 'POST', ...json({ name: 'x', projectId: null, object: null }, owner) });
  assert.strictEqual(okNull.status, 201, JSON.stringify(okNull.body));
  assert.strictEqual(okNull.body.project.project_id, 'legacy');
  const mark = await api(`/api/projects/${myProject}/marks`, { method: 'POST', ...json({ module: 'gge', note: null }, author) });
  assert.strictEqual(mark.status, 200);
  // ?project= дважды — массив, а не идентификатор
  const twice = await api('/api/tz/projects?project=a&project=b', { headers: asUser(author) });
  assert.strictEqual(twice.status, 400);
  // PATCH проверки: chosen_prompt_id: null снимает промпт, а не пишет строку «null»
  const chk = await api('/api/doccheck/checks', { method: 'POST', ...json({ name: 'Проверка', projectId: myProject }, author) });
  assert.strictEqual(chk.status, 201);
  const cleared = await api(`/api/doccheck/checks/${chk.body.check.id}`, { method: 'PATCH', ...json({ chosen_prompt_id: null }, author) });
  assert.strictEqual(cleared.status, 200, JSON.stringify(cleared.body));
  assert.strictEqual(cleared.body.check.chosen_prompt_id, '');
  const badModel = await api(`/api/doccheck/checks/${chk.body.check.id}`, { method: 'PATCH', ...json({ model: ['x'] }, author) });
  assert.strictEqual(badModel.status, 400);
});

test('круг 2: запись удалённого проекта читается по прямой ссылке, но не правится — 404', async () => {
  const p = await api('/api/projects', { method: 'POST', ...json({ name: 'На удаление' }, author) });
  const pid = p.body.project.id;
  const tz = await api('/api/tz/projects', { method: 'POST', ...json({ name: 'ЗнП', projectId: pid }, author) });
  const dc = await api('/api/doccheck/checks', { method: 'POST', ...json({ name: 'Проверка', projectId: pid }, author) });
  const cmp = await api('/api/doccheck/ab', { method: 'POST', ...json({ name: 'Сравнение', projectId: pid }, author) });
  const s = await api('/api/sessions', { method: 'POST', ...json({ projectId: pid, deviceId: 'device-round2-0001' }, author) });
  assert.strictEqual(s.status, 201);
  assert.strictEqual((await api(`/api/projects/${pid}`, { method: 'DELETE', headers: asUser(author) })).status, 200);

  // чтение — 200
  for (const url of [`/api/tz/projects/${tz.body.project.id}`, `/api/doccheck/checks/${dc.body.check.id}`, `/api/doccheck/ab/${cmp.body.ab.id}`]) {
    assert.strictEqual((await api(url, { headers: asUser(author) })).status, 200, url);
  }
  // правка — 404 «Проект не найден» (и автору, и владельцу платформы)
  const writes = [
    [`/api/tz/projects/${tz.body.project.id}`, 'PATCH', { name: 'x' }],
    [`/api/tz/projects/${tz.body.project.id}/document`, 'PUT', { text: 'x' }],
    [`/api/tz/projects/${tz.body.project.id}/analyze`, 'POST', {}],
    [`/api/tz/projects/${tz.body.project.id}`, 'DELETE', null],
    [`/api/doccheck/checks/${dc.body.check.id}`, 'PATCH', { name: 'x' }],
    [`/api/doccheck/checks/${dc.body.check.id}/document`, 'PUT', { text: 'x' }],
    [`/api/doccheck/ab/${cmp.body.ab.id}/docs/a`, 'PUT', { text: 'x' }],
    [`/api/doccheck/ab/${cmp.body.ab.id}`, 'DELETE', null],
  ];
  for (const who of [author, owner]) {
    for (const [url, method, body] of writes) {
      const r = await api(url, { method, ...(body ? json(body, who) : { headers: asUser(who) }) });
      assert.strictEqual(r.status, 404, `${method} ${url} → ${r.status} ${JSON.stringify(r.body)}`);
      assert.match(r.body.error, /Проект не найден/);
    }
  }
  // сессия удалённого проекта уходит из общего списка (как задания и проверки из своих)
  const list = await api('/api/devices/device-round2-0001/sessions', { headers: asUser(author) });
  assert.strictEqual(list.status, 200);
  assert.ok(!list.body.sessions.some((x) => x.id === s.body.id), 'сессия удалённого проекта в общем списке');
  // а по токену жива (мягкое удаление)
  const view = await api(`/api/sessions/${s.body.id}`, { headers: { Authorization: `Bearer ${s.body.token}` } });
  assert.strictEqual(view.status, 200);
  // S+U в удалённом проекте — 404 «Проект не найден», как правка любой записи модуля
  // (третий круг 04.09.2026: раньше 403, а хозяин сессии и вовсе проходил)
  const set = await api(`/api/sessions/${s.body.id}/settings`, { method: 'POST', ...sessionJson({ title: 'x' }, s.body.token, owner) });
  assert.strictEqual(set.status, 404);
  assert.match(set.body.error, /Проект не найден/);
});

test('круг 2: автор проекта видит все сессии своего проекта и правит их; список сходится со сводкой', async () => {
  const DEVICE = 'device-round2-0002';
  const mine = await api('/api/sessions', { method: 'POST', ...json({ projectId: myProject, deviceId: DEVICE }, author) });
  const byOwner = await api('/api/sessions', { method: 'POST', ...json({ projectId: myProject, deviceId: 'device-round2-owner' }, owner) });
  assert.strictEqual(mine.status, 201);
  assert.strictEqual(byOwner.status, 201);

  const list = await api(`/api/devices/${DEVICE}/sessions?project=${myProject}`, { headers: asUser(author) });
  assert.strictEqual(list.status, 200);
  assert.ok(list.body.sessions.some((x) => x.id === byOwner.body.id), 'автор не видит сессию владельца в своём проекте');
  const summary = (await api(`/api/projects/${myProject}`, { headers: asUser(author) })).body.project.summary.site;
  assert.strictEqual(list.body.sessions.length, summary.count, 'список сессий проекта расходится со сводкой');
  // без ?project= — по-прежнему только свои
  const own = await api(`/api/devices/${DEVICE}/sessions`, { headers: asUser(author) });
  assert.ok(!own.body.sessions.some((x) => x.id === byOwner.body.id));

  // токен сессии владельца — автору проекта можно, соседу нет; хозяин не переписывается
  assert.strictEqual((await api(`/api/sessions/${byOwner.body.id}/token`, { method: 'POST', ...json({}, neighbour) })).status, 403);
  const tok = await api(`/api/sessions/${byOwner.body.id}/token`, { method: 'POST', ...json({}, author) });
  assert.strictEqual(tok.status, 200, JSON.stringify(tok.body));
  const ownerId = JSON.parse(fs.readFileSync(process.env.USERS_FILE, 'utf8')).users.find((u) => u.lastName === 'Владельцев').id;
  assert.strictEqual(db.prepare('SELECT user_id FROM sessions WHERE id = ?').get(byOwner.body.id).user_id, ownerId);

  // S+U: хозяин, автор проекта и владелец платформы — да; сосед с верным токеном — нет
  const set = (who, token) => api(`/api/sessions/${byOwner.body.id}/settings`, { method: 'POST', ...sessionJson({ title: 'Сессия' }, token, who) });
  assert.strictEqual((await set(author, tok.body.token)).status, 200);
  assert.strictEqual((await set(owner, tok.body.token)).status, 200);
  assert.strictEqual((await set(neighbour, tok.body.token)).status, 403);
  // и наоборот: владелец платформы правит сессию автора
  const mineTok = await api(`/api/sessions/${mine.body.id}/token`, { method: 'POST', ...json({}, owner) });
  assert.strictEqual(mineTok.status, 200);
  const asOwner = await api(`/api/sessions/${mine.body.id}/settings`, { method: 'POST', ...sessionJson({ title: 'Правка владельца' }, mineTok.body.token, owner) });
  assert.strictEqual(asOwner.status, 200, JSON.stringify(asOwner.body));

  // «Ранние работы»: чужая сессия там автору не открывается — правит их владелец
  const legacy = await api('/api/sessions', { method: 'POST', ...json({ deviceId: 'device-round2-nb' }, neighbour) });
  assert.strictEqual(legacy.status, 201);
  assert.strictEqual((await api(`/api/sessions/${legacy.body.id}/token`, { method: 'POST', ...json({}, author) })).status, 403);
  assert.strictEqual((await api(`/api/sessions/${legacy.body.id}/token`, { method: 'POST', ...json({}, owner) })).status, 200);
});

test('круг 2: служебные сессии модулей получают project_id записи, и migrateLegacy повторно — ничего', async () => {
  const tz = await api('/api/tz/projects', { method: 'POST', ...json({ name: 'ЗнП служебная', projectId: myProject, provider: 'demo', model: 'demo' }, author) });
  assert.strictEqual(tz.status, 201, JSON.stringify(tz.body));
  assert.strictEqual((await api(`/api/tz/projects/${tz.body.project.id}/document`, { method: 'PUT', ...json({ text: 'Задание на проектирование' }, author) })).status, 200);
  const run = await api(`/api/tz/projects/${tz.body.project.id}/analyze`, { method: 'POST', ...json({}, author) });
  assert.strictEqual(run.status, 202, JSON.stringify(run.body));
  const dc = await api('/api/doccheck/checks', { method: 'POST', ...json({ name: 'Проверка служебная', projectId: myProject }, author) });
  assert.strictEqual((await api(`/api/doccheck/checks/${dc.body.check.id}/document`, { method: 'PUT', ...json({ text: 'Пояснительная записка' }, author) })).status, 200);
  // прогон в demo-режиме падает сразу, служебная сессия заводится до вызова модели
  let tzSid = ''; let dcSid = '';
  for (let i = 0; i < 100 && !(tzSid && dcSid); i++) {
    tzSid = db.prepare('SELECT service_session_id AS s FROM tz_projects WHERE id = ?').get(tz.body.project.id).s;
    dcSid = db.prepare('SELECT service_session_id AS s FROM doccheck_checks WHERE id = ?').get(dc.body.check.id).s;
    await new Promise((r) => setTimeout(r, 30));
  }
  assert.ok(tzSid && dcSid, 'служебные сессии не заведены');
  for (const sid of [tzSid, dcSid]) {
    const row = db.prepare('SELECT project_id, status FROM sessions WHERE id = ?').get(sid);
    assert.strictEqual(row.status, 'service');
    assert.strictEqual(row.project_id, myProject);
  }
  assert.strictEqual(db.prepare("SELECT count(*) AS n FROM sessions WHERE project_id = ''").get().n, 0);
  // «перезапуск»: переезд в «Ранние работы» ничего не находит
  assert.strictEqual(projects.migrateLegacy(), 0);
  // служебные сессии не считаются сессиями посадки ни в сводке, ни в списке
  const summary = (await api(`/api/projects/${myProject}`, { headers: asUser(author) })).body.project.summary.site;
  const list = await api(`/api/devices/device-round2-0002/sessions?project=${myProject}`, { headers: asUser(author) });
  assert.strictEqual(list.body.sessions.length, summary.count);
  assert.ok(list.body.sessions.every((s) => !/^(Анализ ТЗ|Проверка документа):/.test(s.title || '')));
});
