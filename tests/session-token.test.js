'use strict';
/**
 * Токены сессий посадки хранятся хешем (аудит безопасности 02.09.2026):
 * список сессий токенов не отдаёт, свой токен выдаётся по запросу (новый —
 * старый отзывается), чужую сессию так не открыть, а строки со старым
 * открытым токеном переводятся на хеш миграцией и продолжают работать.
 */
const os = require('os');
const path = require('path');
const fs = require('fs');
process.env.DATA_DIR = path.join(os.tmpdir(), `pilot1-sesstok-${process.pid}`);
process.env.ANTHROPIC_API_KEY = '';
process.env.USERS_FILE = path.join(os.tmpdir(), `pilot1-sesstok-users-${process.pid}.json`);
process.env.RATE_LIMIT_GENERAL = '1000';
process.env.RATE_LIMIT_EXPENSIVE = '1000';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { createApp } = require('../server/app');
const { db, hashToken, migrateSessionTokens } = require('../server/db');

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
  return { status: res.status, body };
};
async function login(lastName, firstName) {
  const { body } = await api('/api/auth/enter', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lastName, firstName }) });
  return body.token;
}
const json = (obj, token) => ({ headers: { 'Content-Type': 'application/json', 'X-User-Token': token }, body: JSON.stringify(obj) });
const DEVICE = 'device-token-test-000001';

test('в базе лежит хеш, а не токен; список сессий токенов не отдаёт', async () => {
  const me = await login('Хешов', 'Первый');
  const created = await api('/api/sessions', { method: 'POST', ...json({ deviceId: DEVICE }, me) });
  assert.strictEqual(created.status, 201);
  const { id, token } = created.body;
  const row = db.prepare('SELECT token, token_hash FROM sessions WHERE id = ?').get(id);
  assert.strictEqual(row.token, '', 'открытого токена в базе быть не должно');
  assert.strictEqual(row.token_hash, hashToken(token));
  const list = await api(`/api/devices/${DEVICE}/sessions`, { headers: { 'X-User-Token': me } });
  assert.ok(list.body.sessions.length >= 1);
  assert.ok(list.body.sessions.every((s) => !('token' in s)), 'в списке не должно быть токенов');
  // сам токен работает
  const view = await api(`/api/sessions/${id}`, { headers: { Authorization: `Bearer ${token}`, 'X-User-Token': me } });
  assert.strictEqual(view.status, 200);
});

test('свой токен выдаётся по запросу и отзывает прежний; чужую сессию так не открыть', async () => {
  const me = await login('Хешов', 'Второй');
  const other = await login('Чужаков', 'Третий');
  const created = await api('/api/sessions', { method: 'POST', ...json({ deviceId: DEVICE }, me) });
  const { id, token } = created.body;
  const stranger = await api(`/api/sessions/${id}/token`, { method: 'POST', ...json({ deviceId: DEVICE }, other) });
  assert.strictEqual(stranger.status, 403);
  const mine = await api(`/api/sessions/${id}/token`, { method: 'POST', ...json({ deviceId: DEVICE }, me) });
  assert.strictEqual(mine.status, 200, JSON.stringify(mine.body));
  assert.notStrictEqual(mine.body.token, token);
  const old = await api(`/api/sessions/${id}`, { headers: { Authorization: `Bearer ${token}`, 'X-User-Token': me } });
  assert.strictEqual(old.status, 404, 'прежний токен обязан быть отозван');
  const fresh = await api(`/api/sessions/${id}`, { headers: { Authorization: `Bearer ${mine.body.token}`, 'X-User-Token': me } });
  assert.strictEqual(fresh.status, 200);
  assert.strictEqual((await api('/api/sessions/nope/token', { method: 'POST', ...json({}, me) })).status, 400);
});

test('сессии со старым открытым токеном переводятся на хеш и продолжают работать', async () => {
  const me = await login('Хешов', 'Четвёртый');
  const id = crypto.randomUUID();
  const plain = crypto.randomBytes(32).toString('hex');
  const userId = JSON.parse(fs.readFileSync(process.env.USERS_FILE, 'utf8')).users.find((u) => u.firstName === 'Четвёртый').id;
  db.prepare("INSERT INTO sessions (id, token, device_id, user_id, prompt_version, created_at, updated_at) VALUES (?,?,?,?,?,?,?)")
    .run(id, plain, DEVICE, userId, '1.4.0', new Date().toISOString(), new Date().toISOString());
  assert.strictEqual(migrateSessionTokens(), 1);
  assert.strictEqual(migrateSessionTokens(), 0, 'повторный запуск ничего не трогает');
  const row = db.prepare('SELECT token, token_hash FROM sessions WHERE id = ?').get(id);
  assert.strictEqual(row.token, '');
  assert.strictEqual(row.token_hash, hashToken(plain));
  const view = await api(`/api/sessions/${id}`, { headers: { Authorization: `Bearer ${plain}`, 'X-User-Token': me } });
  assert.strictEqual(view.status, 200, 'прежний токен из браузера человека должен работать после миграции');
});
