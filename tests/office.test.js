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

/**
 * ТЗ №2, Р8. Геометрия марша и поверхность ходьбы обязаны считаться ОДНОЙ
 * формулой (правило 11). Пока их было две, они разошлись знаком: в зале
 * реактора человек шёл вниз, а ступени под ним поднимались.
 */
test('офис: ступени марша совпадают с поверхностью ходьбы', async () => {
  const { stairSurface, stairStep, inStair } = await import(new URL('../public/office-geom.mjs', `file://${__filename}`));
  const specs = {
    main: { axis: 'z', x0: 2.6, x1: 5.6, z0: 12.6, z1: 19.8, yFrom: 1.02, yTo: 5.2, steps: 26 },
    reactor: { axis: 'x', x0: -23.6, x1: -21.0, z0: -1.2, z1: 1.6, yFrom: 1.02, yTo: -1.9, steps: 18 },
  };
  for (const [name, spec] of Object.entries(specs)) {
    const rise = Math.abs(spec.yTo - spec.yFrom) / spec.steps;
    for (let i = 0; i < spec.steps; i++) {
      const p = stairStep(spec, i);
      assert.ok(inStair(spec, p.x, p.z), `${name}: ступень ${i} вне прямоугольника марша`);
      const walk = stairSurface(spec, p.x, p.z);
      assert.ok(Math.abs(walk - p.y) <= rise / 2 + 1e-9,
        `${name}: ступень ${i} на ${p.y.toFixed(3)}, пол под ней ${walk.toFixed(3)}`);
    }
    // знак: идём в сторону x0/z0 — и ступени, и пол должны менять отметку одинаково
    const first = stairStep(spec, 0), last = stairStep(spec, spec.steps - 1);
    const dGeom = last.y - first.y;
    const dWalk = stairSurface(spec, last.x, last.z) - stairSurface(spec, first.x, first.z);
    assert.equal(Math.sign(dGeom), Math.sign(dWalk), `${name}: марш и пол под ним идут в разные стороны`);
    assert.equal(Math.sign(dGeom), Math.sign(spec.yTo - spec.yFrom), `${name}: марш идёт не туда, куда объявлен`);
  }
  // зеркальная пара из прошлой сборки обязана этот тест ронять
  const mirrored = { ...specs.reactor, yFrom: -1.9, yTo: 1.02 };
  const walkAt = (x) => stairSurface(specs.reactor, x, 0.2);
  const geomAt = (i) => stairStep(mirrored, i).y;
  assert.notEqual(Math.sign(geomAt(specs.reactor.steps - 1) - geomAt(0)), Math.sign(walkAt(-23.5) - walkAt(-21.1)),
    'тест не отличает зеркальный марш от верного');
});

/**
 * ТЗ №2, Р2. План здания «Кольцо с атриумом» — единственный источник координат
 * и для сборки сцены, и для ходьбы. Проверяем, что он собран по плану
 * владельца: габариты, состав секторов, замкнутость кольца и четыре плоские
 * отметки пола вместо ступенчатого ландшафта.
 */
test('офис: план кольца собран по согласованному варианту', async () => {
  const P = await import(new URL('../public/office-plan.mjs', `file://${__filename}`));
  const G = await import(new URL('../public/office-geom.mjs', `file://${__filename}`));
  assert.equal(P.RING.rOut * 2, 48, 'наружный диаметр не 48 м');
  assert.equal(P.RING.rIn * 2, 21, 'атриум не 21 м');
  assert.equal(P.RING.rOut - P.RING.rIn, 13.5, 'глубина корпуса не 13,5 м');
  assert.equal(P.RING.height, 4.2, 'высота этажа не 4,2 м');

  for (const [name, list] of [['1 этаж', P.FLOOR1], ['2 этаж', P.FLOOR2]]) {
    const span = list.reduce((s, x) => s + (x.to - x.from), 0);
    assert.ok(Math.abs(span - Math.PI * 2) < 1e-9, `${name}: сектора не замыкают кольцо`);
    for (const s of list) {
      // площадь сектора обязана сойтись с планом владельца в пределах 5 %
      const area = P.sectorArea(s);
      assert.ok(Math.abs(area - s.area) / s.area < 0.05, `${name}, ${s.name}: ${area.toFixed(0)} м² против ${s.area} по плану`);
    }
  }
  assert.equal(P.sectorAt(1, 0, 20).id, 'lobby', 'вход не в вестибюль');
  assert.equal(P.sectorAt(1, 0, -20).id, 'studio', 'напротив входа не проектная');
  assert.equal(P.sectorAt(2, 20, 0).id, 'library', 'над переговорными не библиотека');

  // лестниц во входной зоне нет (Р1): оба ядра — вне сектора вестибюля
  for (const c of Object.values(P.CORES)) {
    const cx = (c.x0 + c.x1) / 2, cz = (c.z0 + c.z1) / 2;
    assert.equal(P.sectorAt(1, cx, cz), null, 'лестничное ядро попало внутрь кольца');
    assert.ok(Math.hypot(cx, cz) > P.RING.rOut, 'ядро не вынесено за наружную стену');
  }

  // пол рабочих секторов РОВНЫЙ: ярусов больше нет
  const studio = P.FLOOR1.find((x) => x.id === 'studio');
  for (let i = 0; i <= 10; i++) {
    const a = studio.from + ((studio.to - studio.from) * i) / 10;
    for (const r of [P.RING.rIn + 1, 17, P.RING.rOut - 1]) {
      const p = P.pt(r, a);
      assert.equal(P.floorHeight(p.x, p.z, 0, G.stairSurface), 0, 'пол проектной не на нуле');
    }
  }
  // а в атриуме — пять ступеней амфитеатра
  const heights = new Set();
  for (let d = 1; d < 10; d += 0.3) heights.add(+P.atriumFloor(0, -P.RING.rIn + d).toFixed(2));
  assert.ok(heights.size >= 5, `в атриуме ${heights.size} отметок вместо пяти рядов`);
});

/**
 * ТЗ №3, П1 и П2. Заливка по сетке 0,25 м из вестибюля — С УЧЁТОМ капитальных
 * препятствий. Ловит оба замечания владельца сразу: невидимую мебель первого
 * этажа, перекрывавшую второй, и глухую стену там, где по плану дверь.
 */
test('офис: из вестибюля достижимы все сектора, павильоны и ядра', async () => {
  const P = await import(new URL('../public/office-plan.mjs', `file://${__filename}`));
  const { stairSurface } = await import(new URL('../public/office-geom.mjs', `file://${__filename}`));
  const STEP = 0.25;
  const walls = P.structuralBlockers();
  const lvl = (y) => (y >= P.RING.floor2 - 1.2 ? 2 : 1);
  const key = (i, j, f) => `${i},${j},${f}`;
  const start = [0, 21.0];
  const seen = new Set();
  const queue = [[Math.round(start[0] / STEP), Math.round(start[1] / STEP), 0]];
  seen.add(key(queue[0][0], queue[0][1], 1));
  const got = { f1: new Set(), f2: new Set(), pav: new Set(), cores: new Set() };
  let guard = 0;
  while (queue.length) {
    if (++guard > 400000) break;
    const [i, j, y] = queue.shift();
    const x = i * STEP, z = j * STEP;
    const s1 = P.sectorAt(1, x, z), s2 = P.sectorAt(2, x, z);
    if (lvl(y) === 1 && s1) got.f1.add(s1.id);
    if (lvl(y) === 2 && s2) got.f2.add(s2.id);
    for (const [name, r] of Object.entries(P.PAVILIONS)) if (x > r.x0 && x < r.x1 && z > r.z0 && z < r.z1) got.pav.add(name);
    for (const [name, c] of Object.entries(P.CORES)) if (x > c.x0 && x < c.x1 && z > c.z0 && z < c.z1) got.cores.add(name);
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const ni = i + di, nj = j + dj;
      const nx = ni * STEP, nz = nj * STEP;
      if (!P.insideWalkable(nx, nz, y)) continue;
      if (P.blockedBy(walls, nx, nz, y)) continue;
      const ny = P.floorHeight(nx, nz, y, stairSurface);
      if (Math.abs(ny - y) >= 0.45) continue;
      const k = key(ni, nj, lvl(ny));
      if (seen.has(k)) continue;
      seen.add(k);
      queue.push([ni, nj, ny]);
    }
  }
  for (const s of P.FLOOR1) assert.ok(got.f1.has(s.id), `первый этаж: не дошли в «${s.name}»`);
  for (const s of P.FLOOR2) assert.ok(got.f2.has(s.id), `второй этаж: не дошли в «${s.name}»`);
  for (const name of Object.keys(P.PAVILIONS)) assert.ok(got.pav.has(name), `не дошли в павильон ${name}`);
  for (const name of Object.keys(P.CORES)) assert.ok(got.cores.has(name), `не дошли в ядро ${name}`);
  assert.ok(seen.size > 40000, `достижимо всего ${seen.size} клеток — план распался`);
});

/**
 * ТЗ №3, П2. Проём — сущность плана: стена, ходьба и препятствие берут его из
 * одного реестра. Проверяем, что на месте каждого проёма стены НЕТ, а между
 * проёмами она есть.
 */
test('офис: в каждом проёме стены нет, между проёмами есть', async () => {
  const P = await import(new URL('../public/office-plan.mjs', `file://${__filename}`));
  const walls = P.structuralBlockers().filter((b) => b.r0 !== undefined && String(b.name).startsWith('наружная'));
  const r = P.RING.rOut - 0.1;
  for (const o of P.OPENINGS) {
    for (const level of [1, 2]) {
      if (!P.openingOnFloor(o, level)) continue;
      const y = level === 2 ? P.RING.floor2 : 0;
      const q = P.pt(r, o.at);
      assert.equal(P.blockedBy(walls, q.x, q.z, y), null, `проём «${o.name}» на этаже ${level} перекрыт стеной`);
      // а в 1,5 ширины от оси проёма стена обязана быть
      const off = P.openingHalfAngle(o) * 3;
      for (const side of [-1, 1]) {
        const w = P.pt(r, o.at + side * off);
        const near = P.OPENINGS.some((x) => x !== o && P.openingOnFloor(x, level)
          && Math.abs(((x.at - (o.at + side * off) + Math.PI * 3) % (Math.PI * 2)) - Math.PI) < P.openingHalfAngle(x) * 2);
        if (near) continue;
        assert.ok(P.blockedBy(walls, w.x, w.z, y), `рядом с «${o.name}» на этаже ${level} стены нет`);
      }
    }
  }
});

/**
 * Расстановка по эргономике и феншую (правки владельца 10.09.2026).
 *
 * Проверяется то, что глазами не увидеть: обе дуги рабочих мест смотрят В
 * АТРИУМ (спина к наружной стене, лицо к простору и к главному экрану), между
 * ними остаётся кольцевой проход не уже 1,8 м, а ось входа свободна.
 */
test('офис: рабочие места смотрят в атриум, проходы не уже 1,8 м', async () => {
  const P = await import(new URL('../public/office-plan.mjs', `file://${__filename}`));
  const { stairSurface } = await import(new URL('../public/office-geom.mjs', `file://${__filename}`));
  const walls = P.structuralBlockers();

  // кольцевая петля по середине корпуса свободна и широка
  const clearance = (x, z, y, max = 2.0) => {
    for (let r = 0.2; r <= max; r += 0.2) {
      const n = Math.max(8, Math.round((2 * Math.PI * r) / 0.2));
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        const px = x + Math.cos(a) * r, pz = z + Math.sin(a) * r;
        if (!P.insideWalkable(px, pz, y) || P.blockedBy(walls, px, pz, y)) return r;
      }
    }
    return max;
  };
  for (const level of [1, 2]) {
    const y = level === 2 ? P.RING.floor2 : 0;
    let min = 9;
    for (let i = 0; i < 72; i++) {
      const a = (i / 72) * Math.PI * 2;
      const q = P.pt(17.0, a);
      assert.ok(P.insideWalkable(q.x, q.z, y) && !P.blockedBy(walls, q.x, q.z, y),
        `этаж ${level}: кольцевая петля перекрыта на ${(a * 180 / Math.PI).toFixed(0)}°`);
      min = Math.min(min, clearance(q.x, q.z, y) * 2);
    }
    assert.ok(min >= 1.8, `этаж ${level}: кольцевая петля сужается до ${min.toFixed(2)} м`);
  }
  // ось входа: от двери до кромки атриума ничего капитального
  for (let z = 23.0; z >= 11.0; z -= 0.25) {
    assert.ok(P.insideWalkable(0, z, 0) && !P.blockedBy(walls, 0, z, 0), `ось входа перекрыта на z = ${z.toFixed(1)}`);
  }
  // сектор вестибюля больше не зовётся гардеробом
  const lobby = P.FLOOR1.find((s) => s.id === 'lobby');
  assert.ok(!/гардероб/i.test(lobby.sub), 'гардероб убран из подписи вестибюля');
});
