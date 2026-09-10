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

/**
 * Б3. Поручень обязан идти ПО МАРШУ. Ошибка была в знаке: для оси z брался
 * `π/2 − atan2(...)`, и труба поднималась в сторону +z, тогда как марш
 * поднимается в −z. Проверяем обе оси и оба знака railSide: направление оси
 * трубы должно совпадать по знаку с направлением подъёма марша, а её длина —
 * перекрывать марш с заходом за крайние ступени.
 */
test('офис: поручень лестницы направлен по маршу (обе оси, оба борта)', async () => {
  const geom = await import(new URL('../public/office-geom.mjs', `file://${__filename}`));
  const cross = (a, b) => Math.hypot(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
  const norm = (v) => Math.hypot(v.x, v.y, v.z);
  const cases = [
    { axis: 'z', yFrom: 1.02, yTo: 5.2, len: 7.8 },     // главная лестница, вверх к −z
    { axis: 'z', yFrom: 5.2, yTo: 1.02, len: 7.8 },     // тот же марш вниз
    { axis: 'x', yFrom: -1.9, yTo: 1.02, len: 6.4 },    // реакторная, вверх к −x
    { axis: 'x', yFrom: 1.02, yTo: -1.9, len: 6.4 },
    { axis: 'z', yFrom: 0, yTo: 3.2, len: -5.4 },       // марш, заданный в обратном порядке
  ];
  for (const c of cases) {
    const pose = geom.railPose(c);
    const rail = geom.railDirection({ axis: c.axis, angle: pose.angle });
    const flight = geom.flightDirection(c);
    const sin = cross(rail, flight) / (norm(rail) * norm(flight));
    assert.ok(sin < 1e-9, `${c.axis} ${c.yTo > c.yFrom ? 'вверх' : 'вниз'}: труба под углом к маршу (sin=${sin.toFixed(4)})`);
    assert.ok(pose.length > norm(flight), 'поручень короче марша: нет захода за крайние ступени');
    assert.ok(Math.abs(pose.midY - ((c.yFrom + c.yTo) / 2 + 0.9)) < 1e-9, 'поручень не на 900 мм над носками');
  }
  // прежняя формула (знак уклона наоборот) обязана этот тест ронять
  for (const c of cases.slice(0, 3)) {
    const slope = Math.atan2(c.yTo - c.yFrom, c.len);
    const wrong = c.axis === 'z' ? Math.PI / 2 - slope : Math.PI / 2 + slope;
    const rail = geom.railDirection({ axis: c.axis, angle: wrong });
    const flight = geom.flightDirection(c);
    const sin = cross(rail, flight) / (norm(rail) * norm(flight));
    assert.ok(sin > 1e-6, `${c.axis}: тест не отличает верный знак уклона от прежнего`);
  }
});

/**
 * В10. Постеры расставлялись каждой серией по своей формуле: «Механика» при
 * i = 2 попадала на z 1.7, то есть в проём крыла и на его косяк, а «Кодекс»
 * на том же x — поверх неё. Проверяем общий список мест: ни один постер не
 * пересекается с проёмом и ни с одним соседом по той же стене.
 */
test('офис: постеры не садятся на проём и друг на друга', async () => {
  const { slotFree, slotRect } = await import(new URL('../public/office-geom.mjs', `file://${__filename}`));
  const OPENINGS = [[-2.2, 2.6]];
  const placed = [];
  const asked = [
    { along: -9.4, width: 1.15 }, { along: -6.2, width: 1.15 },
    { along: 1.7, width: 1.15 },                       // прежняя координата — прямо в проёме
    { along: 4.6, width: 1.15 }, { along: 4.9, width: 1.15 },  // впритык к предыдущему
    { along: 7.8, width: 1.15 }, { along: -4.0, width: 0.8 },
  ];
  const taken = [];
  for (const a of asked) {
    if (!slotFree(placed, OPENINGS, a.along, a.width)) continue;
    placed.push(a); taken.push(a);
  }
  assert.ok(!taken.some((a) => a.along === 1.7), 'постер повешен в проёме крыла');
  assert.ok(!taken.some((a) => a.along === 4.9), 'два постера встали внахлёст');
  for (const a of taken) {
    const [a0, a1] = slotRect(a.along, a.width);
    for (const [o0, o1] of OPENINGS) {
      assert.ok(a1 <= o0 || a0 >= o1, `постер на ${a.along} пересекает проём`);
    }
    for (const b of taken) {
      if (b === a) continue;
      const [b0, b1] = slotRect(b.along, b.width);
      assert.ok(a1 <= b0 || a0 >= b1, `постеры на ${a.along} и ${b.along} пересекаются`);
    }
  }
  assert.ok(taken.length >= 5, 'развеска отбросила слишком много мест');
});
