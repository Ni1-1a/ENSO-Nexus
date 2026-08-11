'use strict';
/*
 * Починка серверной части: очередь и вытеснение диалога, границы доступа,
 * привязка выбранного варианта к прогону, сброс этапа, ограничитель частоты.
 *
 * Половина этих дефектов в демо-режиме не видна: заглушка отвечает мгновенно,
 * и гонка «человек нажал кнопку, пока помощник отвечает» не воспроизводится.
 * Поэтому здесь поднимается СВОЙ OpenAI-совместимый сервер с управляемой
 * задержкой и управляемым сбоем, и сессия переводится на него.
 */
const os = require('os');
const path = require('path');
const fs = require('fs');
const http = require('http');

process.env.DATA_DIR = path.join(os.tmpdir(), `pilot1-fix-${process.pid}`);
process.env.USERS_FILE = path.join(os.tmpdir(), `pilot1-fix-users-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
process.env.ANTHROPIC_API_KEY = '';
process.env.RATE_LIMIT_GENERAL = '1000';
process.env.RATE_LIMIT_EXPENSIVE = '1000';
process.env.RATE_LIMIT_AUTH = '1000';
process.env.ACAD_ENABLED = '0';

const { test, before, after } = require('node:test');
const assert = require('node:assert');

/* ---------------- поддельная модель ---------------- */
/** Задержка ответа, режимы сбоя и счётчик обращений — переключаются из тестов. */
const fake = { delayMs: 0, failAnalysis: false, calls: 0 };

const ANALYSIS = {
  status: 'completed',
  message: 'Разбор выполнен.',
  facts: [{ key: 'building_area', value: '1200 м²', source: 'ТЗ' }],
  questions: [], tep: [], warnings: [], assumptions: [], geometry: [],
  report_markdown: '# Отчёт',
};
const RULES = {
  rules: [{
    kind: 'protectionZone', operation: 'bufferOutward', targetSelector: 'utility',
    targetHint: 'ЛЭП', value: 10, unit: 'м', condition: '', appliesTo: 'newBuilding',
    basis: 'ПП РФ № 160, п. 8', sourceDocument: 'Топо.dxf', sourceClause: 'п. 8',
    quote: 'охранная зона 10 м от оси ВЛ', confidence: 0.8, note: '',
  }],
  missingData: [],
};

function startFakeModel() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if (req.url.startsWith('/v1/models')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ data: [{ id: 'slow-model' }] }));
        }
        fake.calls += 1;
        const isAnalysis = /"facts"/.test(body);
        const isRules = /restriction_rules/.test(body);
        let aborted = false;
        res.on('close', () => { if (!res.writableEnded) aborted = true; });
        setTimeout(() => {
          if (aborted || res.writableEnded) return;
          if (isAnalysis && fake.failAnalysis) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: { message: 'поддельный сбой модели' } }));
          }
          const content = isRules ? JSON.stringify(RULES)
            : isAnalysis ? JSON.stringify(ANALYSIS) : 'Ответ помощника.';
          const usage = { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 };
          let stream = false;
          try { stream = !!JSON.parse(body).stream; } catch { /* не JSON — считаем обычным ответом */ }
          if (stream) {
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
            send({ object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] });
            send({ object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content } }] });
            send({ object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage });
            res.write('data: [DONE]\n\n');
            return res.end();
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage,
          }));
        }, fake.delayMs);
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

let modelSrv, server, base, app, pipeline, stages, config, db;

before(async () => {
  modelSrv = await startFakeModel();
  // адрес поддельной модели обязан попасть в конфиг ДО первого require('../server/config')
  process.env.OLLAMA_BASE_URL = `http://127.0.0.1:${modelSrv.address().port}/v1`;
  app = require('../server/app');
  pipeline = require('../server/services/pipeline');
  stages = require('../server/services/stages');
  config = require('../server/config');
  db = require('../server/db').db;
  server = app.createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  server.close();
  modelSrv.close();
  try { await require('../server/services/render').close(); } catch { /* браузер не поднимался */ }
  fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
  fs.rmSync(process.env.USERS_FILE, { force: true });
});

/* ---------------- помощники ---------------- */
const api = async (p, opts = {}) => {
  const t0 = Date.now();
  const res = await fetch(base + p, opts);
  let body = null;
  try { body = await res.clone().json(); } catch { body = await res.text(); }
  return { status: res.status, body, ms: Date.now() - t0 };
};
const J = (h = {}) => ({ 'Content-Type': 'application/json', ...h });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function login(lastName, firstName) {
  const { body } = await api('/api/auth/enter', {
    method: 'POST', headers: J(), body: JSON.stringify({ lastName, firstName }),
  });
  return body.token || '';
}
let ownerToken = '';
const asOwner = () => ({ 'X-User-Token': ownerToken });
const auth = (s) => ({ Authorization: `Bearer ${s.token}`, ...asOwner() });

async function createSession() {
  if (!ownerToken) ownerToken = await login('Хозяинов', 'Пётр');
  const { status, body } = await api('/api/sessions', { method: 'POST', headers: asOwner() });
  assert.strictEqual(status, 201);
  return body;
}
async function upload(s, name, content, type = 'text/plain') {
  const fd = new FormData();
  fd.append('files', new File([content], name, { type }));
  const res = await fetch(`${base}/api/sessions/${s.id}/files`, { method: 'POST', headers: auth(s), body: fd });
  return res.status;
}
/** Перевод проекта на поддельную модель: только так видны гонки очереди. */
async function useFakeModel(s) {
  const r = await api(`/api/sessions/${s.id}/settings`, {
    method: 'POST', headers: J(auth(s)), body: JSON.stringify({ aiProvider: 'ollama', aiModel: 'slow-model' }),
  });
  assert.strictEqual(r.status, 200, `провайдер не выбран: ${JSON.stringify(r.body)}`);
}
const send = (s, text) => api(`/api/sessions/${s.id}/messages`, {
  method: 'POST', headers: J(auth(s)), body: JSON.stringify({ text }),
});
async function waitJob(s, target, timeoutMs = 20000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const { body } = await api(`/api/sessions/${s.id}`, { headers: auth(s) });
    if (target.includes(body.jobStatus)) return body;
    await sleep(150);
  }
  throw new Error(`задача не дошла до ${target}`);
}
/** Чертёж с участком и двумя сетями: сети дают мероприятия, требующие решения. */
function siteDxf() {
  return require('../server/services/dxf').writeDxf([
    { layer: 'ГРАНИЦЫ ЗУ', closed: true, points: [[0, 0], [200, 0], [200, 150], [0, 150]] },
    { layer: 'СЕТИ ВОДОПРОВОД', closed: false, points: [[20, 0], [20, 150]] },
    { layer: 'СЕТИ ЛЭП 10кВ', closed: false, points: [[0, 100], [200, 100]] },
    { layer: 'ЗДАНИЕ СУЩЕСТВУЮЩЕЕ', closed: true, points: [[160, 10], [190, 10], [190, 40], [160, 40]] },
  ]);
}

/* ================= 1. вытеснение диалога действием человека ================= */

test('анализ запускается сразу, пока помощник отвечает, а не ждёт 5 с и не отбивается 409', async () => {
  const s = await createSession();
  await upload(s, 'ТЗ.txt', 'задание: склад 1200 м²');
  await useFakeModel(s);
  fake.delayMs = 2000; // ответ помощника занимает слот на 2 с
  try {
    const chat = await send(s, 'а что с охранной зоной ЛЭП?');
    assert.strictEqual(chat.status, 202);
    assert.strictEqual(chat.body.queued, false, 'слот свободен — помощник отвечает сразу');
    await sleep(300); // помощник уже в модели

    const started = await api(`/api/sessions/${s.id}/process`, { method: 'POST', headers: J(auth(s)), body: '{}' });
    assert.strictEqual(started.status, 202, `анализ обязан стартовать: ${JSON.stringify(started.body)}`);
    assert.ok(started.ms < 1500, `действие человека ждало ${started.ms} мс — вытеснение не сработало`);

    // прерванный вопрос НЕ помечается отвеченным: на него ответят после анализа
    assert.deepStrictEqual(pipeline.pendingChatText(s.id), ['а что с охранной зоной ЛЭП?']);
    await waitJob(s, ['completed', 'needs_clarification', 'failed']);
  } finally {
    fake.delayMs = 0;
  }
});

test('очередь диалога не забирает слот, забронированный под действие человека', async () => {
  const s = await createSession();
  pipeline.runningJobs.add(s.id);
  await send(s, 'вопрос в очередь');
  pipeline.runningJobs.delete(s.id);

  await pipeline.claimSlot(s.id); // так бронирует слот startProcessing
  try {
    pipeline.drainPendingChats();
    await sleep(150);
    assert.deepStrictEqual(pipeline.pendingChatText(s.id), ['вопрос в очередь'],
      'разбор очереди отменил бы вытеснение: слот занят чужим вопросом');
    // и сообщение, отправленное в этот момент, честно встаёт в очередь
    const during = await send(s, 'и ещё один');
    assert.strictEqual(during.body.queued, true);
  } finally {
    pipeline.releaseClaim(s.id);
  }
});

/* ================= 2. вопрос во время упавшего анализа ================= */

test('сообщение самой задачи не считается ответом на вопрос человека', async () => {
  const s = await createSession();
  pipeline.runningJobs.add(s.id);
  try {
    await send(s, 'ВОПРОС во время анализа');
    // так пишет о себе упавший анализ
    pipeline.addMessage(s.id, 'assistant', 'error', 'Внутренняя ошибка обработки.', { fromJob: true });
    assert.deepStrictEqual(pipeline.pendingChatText(s.id), ['ВОПРОС во время анализа'],
      'ошибка анализа съела вопрос человека');
    // а ошибка самого диалога очередь закрывает — иначе она пыталась бы вечно
    pipeline.addMessage(s.id, 'assistant', 'error', 'Не удалось получить ответ.');
    assert.deepStrictEqual(pipeline.pendingChatText(s.id), []);
  } finally {
    pipeline.runningJobs.delete(s.id);
  }
});

test('вопрос, заданный во время анализа, получает ответ и после падения анализа', async () => {
  const s = await createSession();
  await upload(s, 'ТЗ.txt', 'задание: склад');
  await useFakeModel(s);
  fake.failAnalysis = true;
  fake.delayMs = 700;
  try {
    const p = await api(`/api/sessions/${s.id}/process`, { method: 'POST', headers: J(auth(s)), body: '{}' });
    assert.strictEqual(p.status, 202);
    await sleep(200);
    const q = await send(s, 'ВОПРОС-А: где границы участка?');
    assert.strictEqual(q.body.queued, true);

    await waitJob(s, ['failed']);
    for (let i = 0; i < 80 && pipeline.pendingChatText(s.id).length; i++) await sleep(150);

    const view = await api(`/api/sessions/${s.id}`, { headers: auth(s) });
    const replies = view.body.messages.filter((m) => m.role === 'assistant' && m.kind === 'chat');
    assert.strictEqual(replies.length, 1, 'на заданный во время анализа вопрос никто не ответил');
    assert.strictEqual(view.body.pendingChats, 0);
  } finally {
    fake.failAnalysis = false;
    fake.delayMs = 0;
  }
});

/* ================= 6. этап после падения и отмены ================= */

test('этап не остаётся рабочим после падения анализа', async () => {
  const s = await createSession();
  await upload(s, 'ТЗ.txt', 'задание');
  await useFakeModel(s);
  fake.failAnalysis = true;
  try {
    await api(`/api/sessions/${s.id}/process`, { method: 'POST', headers: J(auth(s)), body: '{}' });
    const view = await waitJob(s, ['failed']);
    assert.ok(!stages.WORKING_STAGES.includes(view.stage),
      `этап остался рабочим (${view.stage}) — клиент будет опрашивать сервер вечно`);
  } finally {
    fake.failAnalysis = false;
  }
});

test('этап не остаётся рабочим после кнопки «Прервать обработку»', async () => {
  const s = await createSession();
  await upload(s, 'ТЗ.txt', 'задание');
  await useFakeModel(s);
  fake.delayMs = 3000;
  try {
    await api(`/api/sessions/${s.id}/process`, { method: 'POST', headers: J(auth(s)), body: '{}' });
    await sleep(300);
    const cancel = await api(`/api/sessions/${s.id}/cancel`, { method: 'POST', headers: J(auth(s)), body: '{}' });
    assert.strictEqual(cancel.status, 200);
    const view = await waitJob(s, ['failed']);
    assert.ok(!stages.WORKING_STAGES.includes(view.stage), `этап остался рабочим: ${view.stage}`);
  } finally {
    fake.delayMs = 0;
  }
});

test('восстановление после перезапуска возвращает этап к последней карточке', () => {
  const s = db.prepare("SELECT id FROM sessions ORDER BY created_at LIMIT 1").get();
  stages.set(s.id, 'variants');
  stages.addCard(s.id, 'zones', { zones: [] });
  stages.settle(s.id);
  assert.strictEqual(stages.get(s.id), 'zones_review',
    'после обрыва работа обязана вернуться к тому, что человек согласовывал');
  stages.set(s.id, 'analysis');
  assert.strictEqual(stages.settle(s.id, 'questions'), 'questions');
});

/* ================= 10. честная подпись режима ================= */

test('журнал не называет демо-режимом прогон на настоящей модели', async () => {
  const s = await createSession();
  await upload(s, 'ТЗ.txt', 'задание');
  await useFakeModel(s);
  await api(`/api/sessions/${s.id}/process`, { method: 'POST', headers: J(auth(s)), body: '{}' });
  const view = await waitJob(s, ['completed', 'needs_clarification', 'failed']);
  const started = view.events.find((e) => e.stage.startsWith('Выполняется анализ'));
  assert.ok(started, 'события о запуске анализа нет');
  assert.ok(!/демо-режим/.test(started.stage), `на платной модели в журнале «${started.stage}»`);
  assert.match(started.detail, /ollama/, 'в журнале не видно, какая модель работала');
});

/* ================= 3 и 9. границы доступа ================= */

test('посторонний с токеном проекта не тратит деньги владельца и не рвёт его работу', async () => {
  const s = await createSession();
  await upload(s, 'ТЗ.txt', 'задание');
  const strangerToken = await login('Чужов', 'Пришлый');
  const stranger = { Authorization: `Bearer ${s.token}`, 'X-User-Token': strangerToken };
  const tokenOnly = { Authorization: `Bearer ${s.token}` };

  const probes = [
    ['POST', `/api/sessions/${s.id}/settings`, { aiProvider: 'demo' }],
    ['POST', `/api/sessions/${s.id}/settings`, { title: 'ЗАХВАЧЕНО' }],
    ['POST', `/api/sessions/${s.id}/comment`, { comment: 'чужой текст в промпт' }],
    ['POST', `/api/sessions/${s.id}/cancel`, {}],
    ['DELETE', `/api/sessions/${s.id}/workplan`, null],
    ['POST', `/api/sessions/${s.id}/annotations`, { planId: 'x', geometryType: 'rect', geometry: {} }],
    ['POST', `/api/sessions/${s.id}/questions/00000000-0000-0000-0000-000000000000/answer`, { answer: '3 этажа' }],
    ['POST', `/api/sessions/${s.id}/questions/00000000-0000-0000-0000-000000000000/skip`, {}],
    ['POST', `/api/sessions/${s.id}/plan/actions/нет-такого`, { decision: 'allow', decidedBy: 'Чужов' }],
    ['POST', `/api/sessions/${s.id}/plan/variants/нет-такого/select`, {}],
  ];
  for (const [method, url, body] of probes) {
    for (const headers of [stranger, tokenOnly]) {
      const r = await api(url, { method, headers: J(headers), body: body ? JSON.stringify(body) : undefined });
      assert.strictEqual(r.status, 403, `${method} ${url} пустил постороннего: ${r.status} ${JSON.stringify(r.body)}`);
    }
  }
  // владелец после этого видит свой проект нетронутым
  const view = await api(`/api/sessions/${s.id}`, { headers: auth(s) });
  assert.strictEqual(view.body.comment || '', '');
  assert.notStrictEqual(view.body.title, 'ЗАХВАЧЕНО');
});

/* ================= 4 и 5. варианты, прогоны и решения ================= */

test('выбор варианта привязан к последнему прогону, а решения принимаются вместе с выбором', async () => {
  const s = await createSession();
  await upload(s, 'Топо.dxf', siteDxf(), 'application/dxf');
  const runs = require('../server/services/geometry/placement-runs');
  const generate = () => api(`/api/sessions/${s.id}/plan/variants`, {
    method: 'POST', headers: J(auth(s)), body: JSON.stringify({ requirements: { areaM2: 6000, floors: 3 } }),
  });

  const run1 = await generate();
  assert.strictEqual(run1.status, 200, JSON.stringify(run1.body));
  // вариант 1 по решению владельца всегда без воздействия на критические объекты,
  // решения требуют варианты 2–4 — их и берём
  const first = run1.body.variants.find((v) => v.pendingDecisions > 0);
  assert.ok(first, 'на этом участке хотя бы один вариант обязан требовать решения по сетям');

  // без решений выбрать нельзя — тупик, из-за которого работа и вставала
  const refused = await api(`/api/sessions/${s.id}/plan/variants/${first.id}/select`, {
    method: 'POST', headers: J(auth(s)), body: '{}',
  });
  assert.strictEqual(refused.status, 409);

  // решения принимаются тем же запросом, подпись берётся у вошедшего человека
  const decisions = first.actions.filter((a) => a.requiresDecision && !a.decision)
    .map((a) => ({ actionId: a.id, decision: 'allow' }));
  const picked = await api(`/api/sessions/${s.id}/plan/variants/${first.id}/select`, {
    method: 'POST', headers: J(auth(s)), body: JSON.stringify({ decisions }),
  });
  assert.strictEqual(picked.status, 200, JSON.stringify(picked.body));
  assert.strictEqual(picked.body.status, 'admissible');
  assert.strictEqual(picked.body.statusLabel, 'допустим', 'подпись статуса обязана быть живой');
  assert.match(picked.body.actions[0].note, /Хозяинов Пётр/, 'решение обязано быть подписано');

  // «переделать»: новый прогон, в нём выбранных нет
  const run2 = await generate();
  assert.notStrictEqual(run2.body.runId, run1.body.runId);
  assert.strictEqual(runs.selected(s.id), null,
    'выбор из прошлого прогона больше не считается выбором — иначе чертёж соберётся по нему');

  const approveBlind = await api(`/api/sessions/${s.id}/stages/variants/approve`, {
    method: 'POST', headers: J(auth(s)), body: '{}',
  });
  assert.strictEqual(approveBlind.status, 400);
  assert.strictEqual(approveBlind.body.runId, run2.body.runId);

  // согласование вместе с вариантом и решениями по нему — путь не встаёт в тупик
  const target = run2.body.variants.find((v) => v.pendingDecisions > 0);
  const withDecisions = target.actions.filter((a) => a.requiresDecision && !a.decision)
    .map((a) => ({ actionId: a.id, decision: 'allow' }));
  const approve = await api(`/api/sessions/${s.id}/stages/variants/approve`, {
    method: 'POST', headers: J(auth(s)),
    body: JSON.stringify({ variantId: target.id, decisions: withDecisions }),
  });
  assert.strictEqual(approve.status, 200, JSON.stringify(approve.body));
  assert.strictEqual(approve.body.variant, target.number);
  const chosen = runs.selected(s.id);
  assert.strictEqual(chosen.runId, run2.body.runId, 'чертёж собирается по варианту ТЕКУЩЕГО прогона');
  await waitJob(s, ['completed', 'failed'], 60000);
});

test('решение по чужому мероприятию к варианту не применяется', async () => {
  const s = await createSession();
  await upload(s, 'Топо.dxf', siteDxf(), 'application/dxf');
  const run = await api(`/api/sessions/${s.id}/plan/variants`, {
    method: 'POST', headers: J(auth(s)), body: JSON.stringify({ requirements: { areaM2: 6000, floors: 3 } }),
  });
  const [a, b] = run.body.variants;
  const foreign = b.actions.find((x) => x.requiresDecision);
  const r = await api(`/api/sessions/${s.id}/plan/variants/${a.id}/select`, {
    method: 'POST', headers: J(auth(s)), body: JSON.stringify({ decisions: [{ actionId: foreign.id, decision: 'allow' }] }),
  });
  assert.strictEqual(r.status, 404);
  assert.match(r.body.error, /не относится к варианту/);
});

/* ================= 8. повторная сборка комплекта ================= */

test('повторная сборка комплекта обновляет запись, а не плодит дубли', () => {
  const exportSvc = require('../server/services/geometry/export');
  const sessionId = db.prepare('SELECT id FROM sessions ORDER BY created_at LIMIT 1').get().id;
  const first = exportSvc.saveResult(sessionId, 'КОМПЛЕКТ-проба.pdf', 'Комплект', 'pdf', Buffer.from('первый'));
  const second = exportSvc.saveResult(sessionId, 'КОМПЛЕКТ-проба.pdf', 'Комплект', 'pdf', Buffer.from('второй, длиннее'));
  const rows = db.prepare('SELECT * FROM results WHERE session_id = ? AND filename = ?')
    .all(sessionId, 'КОМПЛЕКТ-проба.pdf');
  assert.strictEqual(rows.length, 1, 'файл перезаписан — запись обязана быть одна');
  assert.strictEqual(second.id, first.id, 'выданная раньше ссылка на скачивание обязана работать');
  assert.strictEqual(rows[0].size, fs.statSync(rows[0].stored_path).size, 'размер в базе разошёлся с файлом');
});

/* ================= 15. предупреждения в ответе ================= */

test('предупреждения разбора чертежа доходят до клиента вместе с зонами', async () => {
  const s = await createSession();
  await upload(s, 'Топо.dxf', siteDxf(), 'application/dxf');
  await useFakeModel(s);
  const r = await api(`/api/sessions/${s.id}/plan/restrictions`, { method: 'POST', headers: J(auth(s)), body: '{}' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body).slice(0, 200));
  assert.ok(Array.isArray(r.body.warnings), 'поле warnings обязано быть в ответе');
  assert.ok(r.body.warnings.some((w) => w.code === 'units-assumed'),
    'предупреждение «единицы не заданы, приняты метры» потеряно — а оно меняет весь масштаб');
});

/* ================= 11, 12, 13, 14. мелочи, которые видит человек ================= */

test('удаление проекта во время работы не роняет обработку в лог', async () => {
  const s = await createSession();
  await upload(s, 'ТЗ.txt', 'задание');
  await useFakeModel(s);
  fake.delayMs = 1500;
  try {
    await api(`/api/sessions/${s.id}/process`, { method: 'POST', headers: J(auth(s)), body: '{}' });
    await sleep(300);
    const del = await api(`/api/sessions/${s.id}`, { method: 'DELETE', headers: auth(s) });
    assert.strictEqual(del.status, 200);
    // записи по исчезнувшей сессии молча пропускаются, а не падают на внешнем ключе
    assert.strictEqual(pipeline.logEvent(s.id, 'проба'), false);
    assert.strictEqual(pipeline.addMessage(s.id, 'assistant', 'chat', 'проба'), false);
    await sleep(400);
    // слот освобождён: следующая задача стартует нормально
    const next = await createSession();
    await upload(next, 'ТЗ.txt', 'задание');
    const p = await api(`/api/sessions/${next.id}/process`, { method: 'POST', headers: J(auth(next)), body: '{}' });
    assert.strictEqual(p.status, 202);
    await waitJob(next, ['completed', 'needs_clarification', 'failed']);
  } finally {
    fake.delayMs = 0;
  }
});

test('ошибка разбора JSON не отдаёт клиенту фразу парсера и кусок тела', async () => {
  const s = await createSession();
  for (const body of ['"строка"', '{"text": ', 'null']) {
    const r = await api(`/api/sessions/${s.id}/messages`, { method: 'POST', headers: J(auth(s)), body });
    assert.strictEqual(r.status, 400);
    assert.match(r.body.error, /^[А-Яа-я]/, `наружу ушла английская фраза: ${r.body.error}`);
    assert.ok(!/JSON input|is not valid JSON|Unexpected token/.test(r.body.error));
    assert.ok(!r.body.error.includes('строка'), 'в ответе эхо присланного тела');
  }
});

test('после удаления файла на диске не остаётся его разобранная выжимка', async () => {
  const s = await createSession();
  await upload(s, 'Топо.dxf', siteDxf(), 'application/dxf');
  const file = db.prepare('SELECT * FROM files WHERE session_id = ?').get(s.id);
  // так кэширует разбор services/cad.js и распознавание doc-vision.js
  for (const suffix of ['.cad.v2.md', '.vision.md']) {
    fs.writeFileSync(file.stored_path + suffix, 'слои, габариты и все надписи чертежа');
  }
  const del = await api(`/api/sessions/${s.id}/files/${file.id}`, { method: 'DELETE', headers: auth(s) });
  assert.strictEqual(del.status, 200);
  for (const suffix of ['', '.cad.v2.md', '.vision.md']) {
    assert.ok(!fs.existsSync(file.stored_path + suffix), `на диске остался ${suffix || 'сам файл'}`);
  }
});

test('проект нельзя переименовать в пустую строку', async () => {
  const s = await createSession();
  await api(`/api/sessions/${s.id}/settings`, {
    method: 'POST', headers: J(auth(s)), body: JSON.stringify({ title: 'Складской корпус' }),
  });
  const empty = await api(`/api/sessions/${s.id}/settings`, {
    method: 'POST', headers: J(auth(s)), body: JSON.stringify({ title: '   ' }),
  });
  assert.strictEqual(empty.status, 400);
  const view = await api(`/api/sessions/${s.id}`, { headers: auth(s) });
  assert.strictEqual(view.body.title, 'Складской корпус', 'название стёрлось, а вернуть его нечем');
});

/* ================= 7. ограничитель попыток входа ================= */

test('подставленный X-Forwarded-For не делает перебор безлимитным', async () => {
  const express = require('express');
  const { rateLimit } = require('../server/middleware');
  assert.notStrictEqual(config.trustProxy, 1,
    'trust proxy = 1 значит «верить любому, кто прислал заголовок»');

  const probe = express();
  probe.set('trust proxy', config.trustProxy);
  // имя лимитера своё: вёдра общие на процесс, чужие бюджеты трогать нельзя
  probe.get('/probe', rateLimit(3, 'проба-входа', { peerFactor: 5 }), (req, res) => res.json({ ip: req.ip }));
  const srv = probe.listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  const url = `http://127.0.0.1:${srv.address().port}/probe`;
  try {
    const plain = [];
    for (let i = 0; i < 5; i++) plain.push((await fetch(url)).status);
    assert.deepStrictEqual(plain, [200, 200, 200, 429, 429], 'лимит на посетителя сломан');

    const spoofed = [];
    for (let i = 0; i < 40; i++) {
      spoofed.push((await fetch(url, { headers: { 'X-Forwarded-For': `203.0.113.${i}` } })).status);
    }
    assert.ok(spoofed.includes(429),
      'заголовок заводит новое ведро на каждый придуманный адрес — перебор имён ничем не ограничен');
    assert.ok(spoofed.filter((x) => x === 200).length <= 15, 'потолок на соединение не держит');
  } finally {
    srv.close();
  }
});

/* ------------------------------------------------------------------------- *
 * Страница 404 самой платформы. Человеку с опечаткой в адресе нужна страница
 * в оформлении платформы, программе — прежний JSON. Ошибка в другую сторону
 * молча ломает разбор ошибок в интерфейсе, поэтому проверяются оба случая.
 * ------------------------------------------------------------------------- */

test('404: переход браузера получает страницу в оформлении платформы, а запрос программы — JSON', async () => {
  const html = await fetch(`${base}/старая-ссылка`, { headers: { Accept: 'text/html' } });
  assert.strictEqual(html.status, 404, 'код ответа остаётся 404');
  assert.match(html.headers.get('content-type') || '', /text\/html/, 'браузеру отдаётся HTML');
  const body = await html.text();
  assert.match(body, /Такой страницы здесь нет/, 'страница платформы, а не текст сервера');
  assert.match(body, /Вернуться на платформу/, 'есть дорога назад');

  const json = await fetch(`${base}/api/нет-такого-маршрута`);
  assert.strictEqual(json.status, 404);
  assert.deepStrictEqual(await json.json(), { error: 'Не найдено' }, 'API отвечает прежним JSON');

  const plain = await fetch(`${base}/старая-ссылка`);
  assert.deepStrictEqual(await plain.json(), { error: 'Не найдено' }, 'без Accept: text/html — тоже JSON');
});

/* ------------------------------------------------------------------------- *
 * Сверка площади участка с документами. Самая дорогая ошибка исходных данных:
 * в ГПЗУ участок 3700 м², в топосъёмке за его границу принят контур 72 м².
 * Дальше всё считается верно и всё бесполезно.
 * ------------------------------------------------------------------------- */

test('данные: расхождение площади участка с документами видно ДО согласования схемы', async () => {
  const s = await createSession();
  const put = (k, v) => db.prepare('INSERT INTO facts (session_id, key, value, created_at) VALUES (?,?,?,?)')
    .run(s.id, k, v, new Date().toISOString());
  put('plot.area_m2', '3700');
  put('building.area_m2', '1200');

  const warn = stages.parcelAreaMismatch(s.id, { parcel: { properties: { areaM2: 72.39 } } });
  assert.ok(warn, 'расхождение в 51 раз обязано быть замечено');
  assert.match(warn, /3700/, 'названа площадь из документов');
  assert.match(warn, /72/, 'названа площадь разобранного контура');
  assert.match(warn, /не тот контур/, 'сказано, в чём причина');

  assert.strictEqual(stages.parcelAreaMismatch(s.id, { parcel: { properties: { areaM2: 3650 } } }), null,
    'расхождение в пределах точности оцифровки предупреждением не считается');
  assert.strictEqual(stages.parcelAreaMismatch(s.id, {}), null, 'без участка сверять нечего');

  const other = await createSession();
  db.prepare('INSERT INTO facts (session_id, key, value, created_at) VALUES (?,?,?,?)')
    .run(other.id, 'building.area_m2', '1200', new Date().toISOString());
  assert.strictEqual(stages.parcelAreaMismatch(other.id, { parcel: { properties: { areaM2: 72 } } }), null,
    'площадь застройки — про здание, за площадь участка её принимать нельзя');
});
