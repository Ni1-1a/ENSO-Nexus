'use strict';
/**
 * Права на файлы с личными данными и резервная копия (аудит 02.09.2026):
 * папка данных 700, app.db и users.json 600; scripts/backup.sh собирает копию
 * во временную папку без Postgres.
 */
const os = require('os');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
process.env.DATA_DIR = path.join(os.tmpdir(), `pilot1-perms-${process.pid}`);
process.env.ANTHROPIC_API_KEY = '';
process.env.USERS_FILE = path.join(os.tmpdir(), `pilot1-perms-users-${process.pid}.json`);
process.env.RATE_LIMIT_GENERAL = '1000';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { createApp } = require('../server/app');

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
const mode = (p) => fs.statSync(p).mode & 0o777;

test('папка данных 700, база и файл людей 600', async () => {
  if (process.platform === 'win32') return;
  assert.strictEqual(mode(process.env.DATA_DIR), 0o700);
  assert.strictEqual(mode(path.join(process.env.DATA_DIR, 'app.db')), 0o600);
  const res = await fetch(`${base}/api/auth/enter`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lastName: 'Правов', firstName: 'Файл' }),
  });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(mode(process.env.USERS_FILE), 0o600, 'users.json после записи');
});

test('scripts/backup.sh собирает копию базы и файла людей (без Postgres)', () => {
  const backupDir = path.join(os.tmpdir(), `pilot1-backups-${process.pid}`);
  const out = execFileSync('bash', [path.join(__dirname, '..', 'scripts', 'backup.sh')], {
    env: { ...process.env, BACKUP_DIR: backupDir, SKIP_PG: '1' }, encoding: 'utf8',
  });
  assert.match(out, /Копия готова/);
  const dirs = fs.readdirSync(backupDir);
  assert.strictEqual(dirs.length, 1);
  const dest = path.join(backupDir, dirs[0]);
  assert.ok(fs.existsSync(path.join(dest, 'app.db')), 'копия app.db');
  assert.ok(fs.existsSync(path.join(dest, 'users.json')), 'копия users.json');
  assert.ok(fs.existsSync(path.join(dest, 'data-files.tgz')), 'архив uploads/outputs');
  assert.strictEqual(mode(path.join(dest, 'app.db')), 0o600);
  // копия — настоящая база: открывается и содержит таблицу сессий
  const { DatabaseSync } = require('node:sqlite');
  const copy = new DatabaseSync(path.join(dest, 'app.db'), { readOnly: true });
  assert.ok(copy.prepare("SELECT name FROM sqlite_master WHERE name = 'sessions'").get());
  copy.close();
  fs.rmSync(backupDir, { recursive: true, force: true });
});
