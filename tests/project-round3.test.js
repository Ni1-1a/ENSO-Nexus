'use strict';
/**
 * Третий круг проверки REST (04.09.2026): регрессии кругов 1–2 и пограничные значения.
 *  - сессия мягко удалённого проекта: S+U-маршруты — 404 «Проект не найден» ВСЕМ,
 *    включая хозяина сессии (раньше ветка «своя сессия» стояла раньше проверки
 *    удаления, и хозяин продолжал писать в удалённый проект); чтение по токену и
 *    выдача токена остаются;
 *  - текстовые поля сессии — только строки: ['x'] раньше уходило в ленту как «x»,
 *    {a:1} — как «[object Object]» и попадало в промпт модели; aiProvider ['demo']
 *    сходил за «demo», title 5 давал «Нет изменений»;
 *  - вход: массив в фамилии/имени — 400 invalid, а не склейка в строку;
 *  - границы участка: points — только пары конечных чисел, meta — объект;
 *  - PATCH задания ТЗ с массивом в checklist — 400, а не 500 из SQLite;
 *  - битое percent-кодирование в пути — 400 по-русски, а не фраза роутера;
 *  - страница 404 отдаётся с Cache-Control: no-cache, как остальная статика.
 */
const os = require('os');
const path = require('path');
const fs = require('fs');
process.env.DATA_DIR = path.join(os.tmpdir(), `pilot1-round3-${process.pid}`);
process.env.ANTHROPIC_API_KEY = '';
process.env.AI_PROVIDER = 'mock';
process.env.USERS_FILE = path.join(os.tmpdir(), `pilot1-round3-users-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
process.env.RATE_LIMIT_GENERAL = '1000';
process.env.RATE_LIMIT_EXPENSIVE = '1000';
process.env.RATE_LIMIT_AUTH = '1000';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { createApp } = require('../server/app');
const { db } = require('../server/db');

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

let author = '';
let owner = '';

test('круг 3: заготовка — автор и владелец платформы', async () => {
  author = await login('Третьев', 'Автор');
  owner = await login('Третьев', 'Владелец');
  await makeOwner('Третьев');
  // makeOwner пометил первого «Третьева» — автора; владельцем должен быть второй
  const users = JSON.parse(fs.readFileSync(process.env.USERS_FILE, 'utf8'));
  for (const u of users.users) u.owner = u.firstName === 'Владелец';
  await new Promise((r) => setTimeout(r, 20));
  fs.writeFileSync(process.env.USERS_FILE, JSON.stringify(users));
  await new Promise((r) => setTimeout(r, 20));
  const me = await api('/api/auth/me', { headers: asUser(owner) });
  assert.strictEqual(me.body.user.owner, true);
  assert.strictEqual((await api('/api/auth/me', { headers: asUser(author) })).body.user.owner, false);
});

test('круг 3: сессия удалённого проекта — S+U 404 «Проект не найден» всем, чтение и токен остаются', async () => {
  const p = await api('/api/projects', { method: 'POST', ...json({ name: 'На удаление (сессия)' }, author) });
  const pid = p.body.project.id;
  const s = await api('/api/sessions', { method: 'POST', ...json({ projectId: pid, deviceId: 'device-round3-0001' }, author) });
  assert.strictEqual(s.status, 201);
  const sid = s.body.id;
  let token = s.body.token;
  assert.strictEqual((await api(`/api/sessions/${sid}/comment`, { method: 'POST', ...sessionJson({ comment: 'до удаления' }, token, author) })).status, 200);
  assert.strictEqual((await api(`/api/projects/${pid}`, { method: 'DELETE', headers: asUser(author) })).status, 200);

  // чтение по токену — 200
  const view = await api(`/api/sessions/${sid}`, { headers: { Authorization: `Bearer ${token}` } });
  assert.strictEqual(view.status, 200);
  assert.strictEqual(view.body.comment, 'до удаления');
  // хозяин сессии, он же автор проекта, и владелец платформы — 404 на любой правке
  for (const who of [author, owner]) {
    for (const [url, body] of [
      [`/api/sessions/${sid}/comment`, { comment: 'после' }],
      [`/api/sessions/${sid}/settings`, { title: 'x' }],
      [`/api/sessions/${sid}/messages`, { text: 'x' }],
    ]) {
      const r = await api(url, { method: 'POST', ...sessionJson(body, token, who) });
      assert.strictEqual(r.status, 404, `${url} → ${r.status} ${JSON.stringify(r.body)}`);
      assert.strictEqual(r.body.error, 'Проект не найден');
    }
    const del = await api(`/api/sessions/${sid}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}`, ...asUser(who) } });
    assert.strictEqual(del.status, 404);
  }
  // комментарий не изменился
  assert.strictEqual((await api(`/api/sessions/${sid}`, { headers: { Authorization: `Bearer ${token}` } })).body.comment, 'до удаления');
  // токен выдаётся (чтение по прямой ссылке живо), а правка с ним — всё равно 404
  const tok = await api(`/api/sessions/${sid}/token`, { method: 'POST', ...json({}, author) });
  assert.strictEqual(tok.status, 200);
  token = tok.body.token;
  assert.strictEqual((await api(`/api/sessions/${sid}`, { headers: { Authorization: `Bearer ${token}` } })).status, 200);
  assert.strictEqual((await api(`/api/sessions/${sid}/comment`, { method: 'POST', ...sessionJson({ comment: 'x' }, token, author) })).status, 404);
});

test('круг 3: текстовые поля сессии — только строки, «[object Object]» до ленты не доходит', async () => {
  const s = await api('/api/sessions', { method: 'POST', ...json({ deviceId: 'device-round3-0002' }, author) });
  const sid = s.body.id;
  const token = s.body.token;
  const cases = [
    ['/messages', { text: ['x'] }, 'text'],
    ['/messages', { text: { a: 1 } }, 'text'],
    ['/messages', { text: 5 }, 'text'],
    ['/settings', { aiProvider: ['demo'] }, 'aiProvider'],
    ['/settings', { aiProvider: 'demo', aiModel: { a: 1 } }, 'aiModel'],
    ['/settings', { title: 5 }, 'title'],
    ['/settings', { kbChoice: ['main'] }, 'kbChoice'],
    ['/process', { instruction: ['x'] }, 'instruction'],
    ['/questions/q1/answer', { answer: { a: 1 } }, 'answer'],
    ['/stages/zones/revise', { note: ['x'] }, 'note'],
    ['/stages/variants/revise', { note: { a: 1 } }, 'note'],
    ['/annotations/a1/ask', { question: { a: 1 } }, 'question'],
  ];
  for (const [suffix, body, field] of cases) {
    const r = await api(`/api/sessions/${sid}${suffix}`, { method: 'POST', ...sessionJson(body, token, author) });
    assert.strictEqual(r.status, 400, `${suffix} ${JSON.stringify(body)} → ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.error, `Поле ${field} должно быть строкой`);
  }
  const messages = db.prepare('SELECT content FROM messages WHERE session_id = ?').all(sid);
  assert.deepStrictEqual(messages, [], 'нестроковые сообщения попали в ленту');
  assert.strictEqual((db.prepare('SELECT ai_provider FROM sessions WHERE id = ?').get(sid) || {}).ai_provider, '');
  // строки по-прежнему принимаются
  assert.strictEqual((await api(`/api/sessions/${sid}/messages`, { method: 'POST', ...sessionJson({ text: 'привет' }, token, author) })).status, 202);
  assert.strictEqual((await api(`/api/sessions/${sid}/settings`, { method: 'POST', ...sessionJson({ aiProvider: 'demo', title: 'Имя' }, token, author) })).status, 200);
});

test('круг 3: вход — массив и объект вместо фамилии/имени отклоняются как invalid', async () => {
  for (const body of [
    { lastName: ['Иванов'], firstName: 'Пётр' },
    { lastName: 'Иванов', firstName: { a: 1 } },
    { lastName: 5, firstName: 'Пётр' },
  ]) {
    const r = await api('/api/auth/enter', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.strictEqual(r.status, 400, JSON.stringify(body));
    assert.strictEqual(r.body.status, 'invalid');
  }
  // и такой человек в файле не появился
  const users = JSON.parse(fs.readFileSync(process.env.USERS_FILE, 'utf8'));
  assert.ok(!users.users.some((u) => u.lastName === 'Иванов'), 'массив в фамилии завёл человека');
});

test('круг 3: границы участка — points только пары конечных чисел, meta — объект', async () => {
  const s = await api('/api/sessions', { method: 'POST', ...json({ deviceId: 'device-round3-0003' }, author) });
  const sid = s.body.id;
  const token = s.body.token;
  for (const points of [[1, 2, 3], [['a', 'b'], [1, 2], [3, 4]], [[0, 0], [1, 1]], [[0, 0, 0], [1, 1, 1], [2, 2, 2]], [[0, 0], [1, 1], [Infinity, 1]], 'x']) {
    const r = await api(`/api/sessions/${sid}/plan/parcel-source`, { method: 'POST', ...sessionJson({ points }, token, author) });
    assert.strictEqual(r.status, 400, `${JSON.stringify(points)} → ${r.status} ${JSON.stringify(r.body)}`);
    assert.match(r.body.error, /points/);
  }
  const meta = await api(`/api/sessions/${sid}/plan/parcel-source`, { method: 'POST', ...sessionJson({ points: [[0, 0], [10, 0], [10, 10]], meta: [] }, token, author) });
  assert.strictEqual(meta.status, 400);
  assert.match(meta.body.error, /meta/);
  // ничего не сохранилось
  assert.strictEqual((await api(`/api/sessions/${sid}/plan/parcel-source`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}`, ...asUser(author) } })).status, 404);
  const ok = await api(`/api/sessions/${sid}/plan/parcel-source`, { method: 'POST', ...sessionJson({ points: [[0, 0], [10, 0], [10, 10]] }, token, author) });
  assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
  assert.deepStrictEqual(ok.body.source.points, [[0, 0], [10, 0], [10, 10]]);
});

test('круг 3: PATCH задания ТЗ с массивом в checklist — 400, а не 500 из SQLite', async () => {
  const tz = await api('/api/tz/projects', { method: 'POST', ...json({ name: 'Типы' }, author) });
  const tid = tz.body.project.id;
  for (const checklist of [['production'], { a: 1 }, 5]) {
    const r = await api(`/api/tz/projects/${tid}`, { method: 'PATCH', ...json({ checklist }, author) });
    assert.strictEqual(r.status, 400, `${JSON.stringify(checklist)} → ${r.status} ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.error, 'Поле checklist должно быть строкой');
  }
  assert.strictEqual((await api(`/api/tz/projects/${tid}`, { headers: asUser(author) })).body.project.checklist, 'production');
  const ok = await api(`/api/tz/projects/${tid}`, { method: 'PATCH', ...json({ checklist: 'housing' }, author) });
  assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));

});

test('круг 3: битое percent-кодирование в пути — 400 по-русски; страница 404 — no-cache', async () => {
  const r = await api('/api/sessions/%E0', { headers: { Authorization: 'Bearer x', ...asUser(author) } });
  assert.strictEqual(r.status, 400, JSON.stringify(r.body));
  assert.match(r.body.error, /percent-кодирование/);
  assert.ok(!/Failed to decode/.test(r.body.error));
  assert.strictEqual(r.res.headers.get('content-security-policy') ? 1 : 0, 1, 'заголовки безопасности на ответе роутера');
  const page = await api('/nope', { headers: { Accept: 'text/html' } });
  assert.strictEqual(page.status, 404);
  assert.match(page.res.headers.get('content-type') || '', /text\/html/);
  assert.strictEqual(page.res.headers.get('cache-control'), 'no-cache');
});
