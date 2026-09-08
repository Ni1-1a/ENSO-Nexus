'use strict';
/**
 * «Виртуальный офис»: сцена открыта и гостю (без чужих проектных данных),
 * своя база office.db в стороне от боевой, карточки агентов с настоящими
 * промтами, валидация чата — и проигрываемость вшитых шахматных партий:
 * каждая партия с ходами обязана легально доигрываться до конца в chess.js,
 * иначе показ на доске сломается на живом прогоне.
 */
const os = require('os');
const path = require('path');
const fs = require('fs');
process.env.DATA_DIR = path.join(os.tmpdir(), `pilot1-office-${process.pid}`);
process.env.ANTHROPIC_API_KEY = '';
process.env.USERS_FILE = path.join(os.tmpdir(), `pilot1-office-users-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
process.env.RATE_LIMIT_GENERAL = '1000';
process.env.RATE_LIMIT_EXPENSIVE = '1000';

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

const api = async (p, opts = {}) => {
  const res = await fetch(base + p, opts);
  let body = null;
  try { body = await res.clone().json(); } catch { body = await res.text(); }
  return { status: res.status, body };
};

async function login(lastName = 'Офисный', firstName = 'Гид') {
  const { body } = await api('/api/auth/enter', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lastName, firstName }),
  });
  return body.token || '';
}

/** office-data.js — браузерный файл; исполняется с подставленным window */
function loadOfficeData() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'office-data.js'), 'utf8');
  const sandbox = {};
  new Function('window', src)(sandbox);
  return sandbox.OfficeData;
}

test('офис: вшитые шахматные партии легально доигрываются до конца', () => {
  const { Chess } = require('chess.js');
  const data = loadOfficeData();
  const replayable = data.chessGames.filter((g) => g.moves);
  assert.ok(replayable.length >= 5, 'проигрываемых партий подозрительно мало');
  for (const game of replayable) {
    const chess = new Chess();
    for (const mv of game.moves) {
      assert.doesNotThrow(() => chess.move(mv), `${game.title}: нелегальный ход «${mv}»`);
    }
    // знаменитые партии из базы кончаются матом — это же проверяет запись
    assert.ok(chess.isCheckmate(), `${game.title}: запись не дошла до мата`);
  }
});

test('офис: у каждой персоны — модуль, имя и существующие промты', () => {
  const office = require('../server/services/office');
  const prompts = require('../server/services/prompts');
  const modules = office.PERSONAS.map((p) => p.module).sort().join(',');
  assert.equal(modules, 'akty,doc,gge,normo,site,tz');
  for (const p of office.PERSONAS) {
    assert.ok(p.name && p.role && p.blurb, `персона ${p.module} не заполнена`);
    for (const name of p.prompts) {
      assert.ok(prompts.load(name).length > 30, `промт ${name} персоны ${p.module} пуст`);
    }
  }
});

test('офис: сцена без проекта открыта гостю и не отдаёт проектных данных', async () => {
  const { status, body } = await api('/api/office/scene');
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.project, null);
  assert.equal(body.modules, null);
  assert.deepEqual(body.journal, []);
  assert.deepEqual(body.docs, []);
  assert.equal(body.geometry, null);
  assert.ok(body.personas.agents.length === 6);
  assert.ok(body.personas.secretary.name);
});

test('офис: чужой проект гостю — 404, свой вошедшему — сводка шести модулей', async () => {
  const token = await login();
  const created = await api('/api/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-User-Token': token },
    body: JSON.stringify({ name: 'Витрина' }),
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.project.id;

  const guest = await api(`/api/office/scene?project=${id}`);
  assert.equal(guest.status, 404);

  const own = await api(`/api/office/scene?project=${id}`, { headers: { 'X-User-Token': token } });
  assert.equal(own.status, 200);
  assert.equal(own.body.project.name, 'Витрина');
  for (const m of ['tz', 'site', 'doc', 'normo', 'gge', 'akty']) {
    assert.ok(own.body.modules[m] && typeof own.body.modules[m].line === 'string', `нет сводки модуля ${m}`);
  }
});

test('офис: карточка агента отдаёт промты роли, неизвестный агент — 404', async () => {
  const { status, body } = await api('/api/office/agent/site');
  assert.equal(status, 200);
  assert.equal(body.persona.module, 'site');
  assert.ok(body.promptFiles.length >= 2, 'у геометра должны быть открытые промты');
  assert.ok(body.promptFiles[0].excerpt.length > 30);

  const missing = await api('/api/office/agent/buhgalter');
  assert.equal(missing.status, 404);
});

test('офис: чат валидирует собеседника и пустые сообщения до похода к модели', async () => {
  const bad = await api('/api/office/chat', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'agent:buhgalter', message: 'привет' }),
  });
  assert.equal(bad.status, 400);

  const empty = await api('/api/office/chat', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'concierge', message: '   ' }),
  });
  assert.equal(empty.status, 422);

  const notStrings = await api('/api/office/chat', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'concierge', message: { evil: 1 } }),
  });
  assert.equal(notStrings.status, 422);
});

test('офис: история чата пуста и доступна, неизвестный kind — 400', async () => {
  const ok = await api('/api/office/chat?kind=concierge');
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body.messages, []);

  const bad = await api('/api/office/chat?kind=hacker');
  assert.equal(bad.status, 400);
});

test('офис: посещение пишется в office.db, боевая база остаётся нетронутой', async () => {
  const before = fs.statSync(path.join(process.env.DATA_DIR, 'app.db')).mtimeMs;
  const res = await api('/api/office/visit', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId: '' }),
  });
  assert.equal(res.status, 200);
  assert.ok(fs.existsSync(path.join(process.env.DATA_DIR, 'office.db')), 'office.db не создана');
  const after = fs.statSync(path.join(process.env.DATA_DIR, 'app.db')).mtimeMs;
  assert.equal(before, after, 'посещение зала тронуло боевую базу');
});

test('офис: миниатюра несуществующего файла — 404', async () => {
  const { status } = await api('/api/office/doc-thumb/no-such-file');
  assert.equal(status, 404);
});
