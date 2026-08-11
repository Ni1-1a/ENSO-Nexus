'use strict';
/* Вход на платформу: регистрация, одобрение, границы доступа. */
const os = require('os');
const path = require('path');
const fs = require('fs');
process.env.DATA_DIR = path.join(os.tmpdir(), `pilot1-auth-${process.pid}`);
process.env.USERS_FILE = path.join(process.env.DATA_DIR, 'users.json');
process.env.ANTHROPIC_API_KEY = '';
process.env.RATE_LIMIT_GENERAL = '1000';
process.env.RATE_LIMIT_EXPENSIVE = '1000';
process.env.RATE_LIMIT_AUTH = '1000';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { createApp } = require('../server/app');
const users = require('../server/services/users');

let server, base;
before(async () => {
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server.close();
  fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
});

const json = async (p, opts = {}) => {
  const res = await fetch(base + p, opts);
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  return { status: res.status, body };
};
const enter = (lastName, firstName) => json('/api/auth/enter', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ lastName, firstName }),
});

function setMode(mode) {
  const store = JSON.parse(fs.readFileSync(process.env.USERS_FILE, 'utf8'));
  store.registration = mode;
  fs.writeFileSync(process.env.USERS_FILE, JSON.stringify(store, null, 2));
}
function approve(lastName) {
  const store = JSON.parse(fs.readFileSync(process.env.USERS_FILE, 'utf8'));
  const u = store.users.find((x) => x.lastName === lastName);
  u.approved = true;
  fs.writeFileSync(process.env.USERS_FILE, JSON.stringify(store, null, 2));
}

test('вход: свободная регистрация впускает сразу и заводит запись в файле', async () => {
  const { status, body } = await enter('Иванов', 'Пётр');
  assert.strictEqual(status, 200);
  assert.strictEqual(body.status, 'active');
  assert.match(body.token, /^[0-9a-f]{64}$/);

  const store = JSON.parse(fs.readFileSync(process.env.USERS_FILE, 'utf8'));
  const u = store.users.find((x) => x.lastName === 'Иванов');
  assert.ok(u && u.approved);
  // в файле лежит ХЭШ, а не сам токен: утечка файла не даёт войти
  assert.ok(!JSON.stringify(store).includes(body.token));
  assert.match(u.tokenHash, /^[0-9a-f]{64}$/);
});

test('вход: то же имя в другом регистре и с лишними пробелами — тот же человек', async () => {
  const first = await enter('Сидоров', 'Иван');
  const again = await enter('  сидоров ', 'ИВАН');
  assert.strictEqual(again.body.status, 'active');
  const store = JSON.parse(fs.readFileSync(process.env.USERS_FILE, 'utf8'));
  assert.strictEqual(store.users.filter((x) => x.lastName.toLowerCase() === 'сидоров').length, 1);
  // новый вход выдаёт новый токен, старый перестаёт работать
  assert.notStrictEqual(first.body.token, again.body.token);
  const old = await json('/api/auth/me', { headers: { 'X-User-Token': first.body.token } });
  assert.strictEqual(old.status, 401);
});

test('вход: имя с посторонними символами отклоняется', async () => {
  for (const bad of ['<script>', 'Иванов‮', '', '  ', '123']) {
    const { body } = await enter(bad, 'Пётр');
    assert.strictEqual(body.status, 'invalid', `принято недопустимое имя «${bad}»`);
  }
});

test('вход: пустой и усечённый токен не пускают', async () => {
  for (const token of ['', 'abc', 'z'.repeat(64), '0'.repeat(63)]) {
    const { status } = await json('/api/auth/me', { headers: { 'X-User-Token': token } });
    assert.strictEqual(status, 401, `токен «${token.slice(0, 8)}…» не должен пускать`);
  }
});

test('вход: без входа проект не заводится', async () => {
  const { status, body } = await json('/api/sessions', { method: 'POST' });
  assert.strictEqual(status, 401);
  assert.strictEqual(body.needLogin, true);
});

test('вход: режим «по одобрению» держит нового человека в заявках', async () => {
  setMode('approval');
  try {
    const { body } = await enter('Неодобренный', 'Гость');
    assert.strictEqual(body.status, 'pending');
    assert.ok(!body.token, 'токен не выдаётся до одобрения');

    // одобрение — ручная правка файла владельцем, как и задумано
    approve('Неодобренный');
    const after = await enter('Неодобренный', 'Гость');
    assert.strictEqual(after.body.status, 'active');
    assert.match(after.body.token, /^[0-9a-f]{64}$/);
  } finally {
    setMode('free');
  }
});

test('вход: чужой проект не открывается даже с его токеном', async () => {
  const a = (await enter('Первый', 'Пользователь')).body;
  const b = (await enter('Второй', 'Пользователь')).body;

  const created = await json('/api/sessions', {
    method: 'POST', headers: { 'X-User-Token': a.token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId: 'device-of-first-user' }),
  });
  const s = created.body;

  // токен проекта у чужого есть (например, подсмотрен), но денег он не потратит
  const spend = await json(`/api/sessions/${s.id}/process`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${s.token}`, 'X-User-Token': b.token, 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.strictEqual(spend.status, 403, 'чужой проект обязан отвечать 403, а не запускать анализ');

  // и в списке проектов второго человека его нет
  const list = await json('/api/devices/device-of-first-user/sessions', { headers: { 'X-User-Token': b.token } });
  assert.strictEqual(list.status, 200);
  assert.ok(!list.body.sessions.some((x) => x.id === s.id), 'чужой проект попал в чужой список');

  // владелец работает как обычно
  const own = await json(`/api/sessions/${s.id}`, {
    headers: { Authorization: `Bearer ${s.token}`, 'X-User-Token': a.token },
  });
  assert.strictEqual(own.status, 200);
});

test('вход: список проектов закрыт для неавторизованных', async () => {
  const { status } = await json('/api/devices/device-of-first-user/sessions');
  assert.strictEqual(status, 401, 'маршрут отдаёт токены проектов — без входа он недопустим');
});

test('вход: битый файл не затирается и не роняет сервер', async () => {
  const before = fs.readFileSync(process.env.USERS_FILE, 'utf8');
  fs.writeFileSync(process.env.USERS_FILE, '{ это не json');
  const st = await json('/api/auth/state');
  assert.strictEqual(st.status, 200, 'сервер обязан пережить битый файл');
  assert.strictEqual(fs.readFileSync(process.env.USERS_FILE, 'utf8'), '{ это не json',
    'битый файл — единственная копия списка людей, перезаписывать его нельзя');
  fs.writeFileSync(process.env.USERS_FILE, before);
});

test('вход: выход обнуляет токен', async () => {
  const { body } = await enter('Выходящий', 'Пользователь');
  const before = await json('/api/auth/me', { headers: { 'X-User-Token': body.token } });
  assert.strictEqual(before.status, 200);
  await json('/api/auth/logout', { method: 'POST', headers: { 'X-User-Token': body.token } });
  const after = await json('/api/auth/me', { headers: { 'X-User-Token': body.token } });
  assert.strictEqual(after.status, 401);
});

test('вход: адрес пишется только если это действительно адрес', () => {
  assert.strictEqual(users.validNames('Иванов', 'Пётр').lastName, 'Иванов');
  assert.strictEqual(users.validNames('Ив', ''), null);
  // подделанный X-Forwarded-For в журнал посещений не попадает
  const store = JSON.parse(fs.readFileSync(process.env.USERS_FILE, 'utf8'));
  for (const u of store.users) {
    for (const ip of u.lastIps) {
      assert.match(ip, /^[0-9a-f.:]+$/i, `в журнал попал не адрес: ${ip}`);
    }
  }
});
