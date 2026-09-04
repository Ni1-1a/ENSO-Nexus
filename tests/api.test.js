'use strict';
/* API tests: run against a real app instance in mock AI mode on an ephemeral port. */
const os = require('os');
const path = require('path');
const fs = require('fs');
process.env.DATA_DIR = path.join(os.tmpdir(), `pilot1-api-${process.pid}`);
process.env.ANTHROPIC_API_KEY = '';
process.env.USERS_FILE = path.join(os.tmpdir(), `pilot1-users-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
process.env.RATE_LIMIT_GENERAL = '1000';
process.env.RATE_LIMIT_EXPENSIVE = '1000';
// Здесь проверяется всё, кроме политики доступа к облаку: тесты работают с
// проектами без хозяина, а им облако закрыто (services/ai/cloud-access.js).
// Сама политика проверяется отдельно — tests/cloud-access.test.js.
process.env.CLOUD_AI_OPEN = '1';

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
});

const api = async (p, opts = {}) => {
  const res = await fetch(base + p, opts);
  let body = null;
  try { body = await res.clone().json(); } catch { body = await res.text(); }
  return { status: res.status, body, res };
};
// К проекту с хозяином посторонний не допускается даже с токеном проекта,
// поэтому в запросах идут оба ключа: токен проекта и токен человека.
const auth = (s) => ({ Authorization: `Bearer ${s.token}`, ...asUser() });

/** Вход на платформу: проекты заводит только вошедший человек. */
let userToken = '';
async function login(lastName = 'Тестов', firstName = 'Пробный') {
  const { body } = await api('/api/auth/enter', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lastName, firstName }),
  });
  return body.token || '';
}
const asUser = () => (userToken ? { 'X-User-Token': userToken } : {});
const uploadForm = (files) => {
  const fd = new FormData();
  for (const [name, content, type] of files) fd.append('files', new File([content], name, { type }));
  return fd;
};
async function createSession() {
  if (!userToken) userToken = await login();
  const { status, body } = await api('/api/sessions', { method: 'POST', headers: asUser() });
  assert.strictEqual(status, 201);
  return body;
}
async function waitJob(s, target, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { body } = await api(`/api/sessions/${s.id}/status`, { headers: auth(s) });
    if (target.includes(body.jobStatus)) return body.jobStatus;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`job did not reach ${target}`);
}

test('health reports mode and limits', async () => {
  const { status, body } = await api('/api/health');
  assert.strictEqual(status, 200);
  assert.strictEqual(body.aiMode, 'mock');
  assert.ok(body.limits.maxFiles > 0);
});

test('session lifecycle: create → get → delete; wrong token rejected', async () => {
  const s = await createSession();
  const ok = await api(`/api/sessions/${s.id}`, { headers: auth(s) });
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(ok.body.jobStatus, 'idle');

  const badToken = await api(`/api/sessions/${s.id}`, { headers: { Authorization: 'Bearer deadbeef' } });
  assert.strictEqual(badToken.status, 404);
  const noToken = await api(`/api/sessions/${s.id}`);
  assert.strictEqual(noToken.status, 404);

  const del = await api(`/api/sessions/${s.id}`, { method: 'DELETE', headers: auth(s) });
  assert.strictEqual(del.status, 200);
  const gone = await api(`/api/sessions/${s.id}`, { headers: auth(s) });
  assert.strictEqual(gone.status, 404);
});

test('uploads: single, multiple, unsupported, oversized, delete', async () => {
  const s = await createSession();

  const one = await api(`/api/sessions/${s.id}/files`, { method: 'POST', headers: auth(s), body: uploadForm([['ГПЗУ.pdf', '%PDF-1.4 data', 'application/pdf']]) });
  assert.strictEqual(one.status, 200);
  assert.strictEqual(one.body.uploaded.length, 1);

  const multi = await api(`/api/sessions/${s.id}/files`, { method: 'POST', headers: auth(s), body: uploadForm([['ТЗ.txt', 'задание', 'text/plain'], ['данные.json', '{"a":1}', 'application/json']]) });
  assert.strictEqual(multi.body.uploaded.length, 2);

  const bad = await api(`/api/sessions/${s.id}/files`, { method: 'POST', headers: auth(s), body: uploadForm([['virus.exe', 'MZ', 'application/octet-stream']]) });
  assert.strictEqual(bad.status, 400);
  assert.match(bad.body.errors[0].error, /не поддерживается/);

  const fakePdf = await api(`/api/sessions/${s.id}/files`, { method: 'POST', headers: auth(s), body: uploadForm([['fake.pdf', 'MZ not a pdf', 'application/pdf']]) });
  assert.strictEqual(fakePdf.status, 400);
  assert.match(fakePdf.body.errors[0].error, /не является PDF/);

  const big = await api(`/api/sessions/${s.id}/files`, { method: 'POST', headers: auth(s), body: uploadForm([['big.txt', 'x'.repeat(26 * 1024 * 1024), 'text/plain']]) });
  assert.ok(big.status === 400 || big.status === 413);

  const view = await api(`/api/sessions/${s.id}`, { headers: auth(s) });
  assert.strictEqual(view.body.files.length, 3);
  const fileId = view.body.files[0].id;
  const del = await api(`/api/sessions/${s.id}/files/${fileId}`, { method: 'DELETE', headers: auth(s) });
  assert.strictEqual(del.status, 200);
  const view2 = await api(`/api/sessions/${s.id}`, { headers: auth(s) });
  assert.strictEqual(view2.body.files.length, 2);
});

test('comment is stored and returned', async () => {
  const s = await createSession();
  const set = await api(`/api/sessions/${s.id}/comment`, {
    method: 'POST', headers: { ...auth(s), 'Content-Type': 'application/json' },
    body: JSON.stringify({ comment: 'ТХ отсутствует' }),
  });
  assert.strictEqual(set.status, 200);
  const view = await api(`/api/sessions/${s.id}`, { headers: auth(s) });
  assert.strictEqual(view.body.comment, 'ТХ отсутствует');
});

test('processing requires files; empty message rejected', async () => {
  const s = await createSession();
  const p = await api(`/api/sessions/${s.id}/process`, { method: 'POST', headers: { ...auth(s), 'Content-Type': 'application/json' }, body: '{}' });
  assert.strictEqual(p.status, 400);
  const m = await api(`/api/sessions/${s.id}/messages`, { method: 'POST', headers: { ...auth(s), 'Content-Type': 'application/json' }, body: JSON.stringify({ text: '' }) });
  assert.strictEqual(m.status, 400);
});

test('full pipeline: process → question → answer → completed → results → download', async () => {
  const s = await createSession();
  await api(`/api/sessions/${s.id}/files`, { method: 'POST', headers: auth(s), body: uploadForm([['ГПЗУ.pdf', '%PDF-1.4', 'application/pdf']]) });

  const p = await api(`/api/sessions/${s.id}/process`, { method: 'POST', headers: { ...auth(s), 'Content-Type': 'application/json' }, body: '{}' });
  assert.strictEqual(p.status, 202);
  await waitJob(s, ['needs_clarification']);

  const view = await api(`/api/sessions/${s.id}`, { headers: auth(s) });
  const q = view.body.questions.find((x) => x.status === 'pending');
  assert.ok(q, 'clarifying question present');
  assert.ok(view.body.events.some((e) => e.stage.includes('уточнение')));

  const ans = await api(`/api/sessions/${s.id}/questions/${q.id}/answer`, {
    method: 'POST', headers: { ...auth(s), 'Content-Type': 'application/json' },
    body: JSON.stringify({ answer: '2 этажа, 1790 м²' }),
  });
  assert.strictEqual(ans.status, 200);
  assert.strictEqual(ans.body.continued, true);
  await waitJob(s, ['completed']);

  const results = await api(`/api/sessions/${s.id}/results`, { headers: auth(s) });
  const names = results.body.results.map((r) => r.filename);
  assert.ok(names.includes('ОТЧЁТ.md'));
  assert.ok(names.includes('результаты.zip'));
  for (const r of results.body.results) assert.ok(r.size > 0, `${r.filename} is not empty`);

  const zip = results.body.results.find((r) => r.format === 'zip');
  const dl = await fetch(`${base}/api/sessions/${s.id}/results/${zip.id}/download`, { headers: auth(s) });
  assert.strictEqual(dl.status, 200);
  const buf = Buffer.from(await dl.arrayBuffer());
  assert.strictEqual(buf.subarray(0, 2).toString(), 'PK');

  // repeated processing start is allowed after completion (idempotent re-run)
  const again = await api(`/api/sessions/${s.id}/process`, { method: 'POST', headers: { ...auth(s), 'Content-Type': 'application/json' }, body: '{}' });
  assert.strictEqual(again.status, 202);
  await waitJob(s, ['completed', 'needs_clarification', 'failed']);
});

test('two sessions are fully isolated', async () => {
  const a = await createSession();
  const b = await createSession();
  await api(`/api/sessions/${a.id}/files`, { method: 'POST', headers: auth(a), body: uploadForm([['secret-a.txt', 'данные A', 'text/plain']]) });

  // B cannot read A's session with its own token
  const cross = await api(`/api/sessions/${a.id}`, { headers: auth(b) });
  assert.strictEqual(cross.status, 404);

  const viewB = await api(`/api/sessions/${b.id}`, { headers: auth(b) });
  assert.strictEqual(viewB.body.files.length, 0);

  // B cannot download A's results by guessing ids
  const fake = await api(`/api/sessions/${b.id}/results/00000000-0000-0000-0000-000000000000/download`, { headers: auth(b) });
  assert.strictEqual(fake.status, 404);
});

test('unknown routes and malformed ids return structured errors', async () => {
  const nf = await api('/api/nope');
  assert.strictEqual(nf.status, 404);
  assert.ok(nf.body.error);
  const badId = await api('/api/sessions/../etc/passwd', { headers: { Authorization: 'Bearer x' } });
  assert.ok([400, 404].includes(badId.status));
  // error body never contains a stack trace
  assert.ok(!JSON.stringify(nf.body).includes('at '));
});

test('message length limit enforced', async () => {
  const s = await createSession();
  await api(`/api/sessions/${s.id}/files`, { method: 'POST', headers: auth(s), body: uploadForm([['a.txt', 'x', 'text/plain']]) });
  const long = await api(`/api/sessions/${s.id}/messages`, {
    method: 'POST', headers: { ...auth(s), 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'x'.repeat(5000) }),
  });
  assert.strictEqual(long.status, 400);
});

test('settings: провайдер и база знаний per session', async () => {
  const s = await createSession();
  // demo всегда доступен
  const ok = await api(`/api/sessions/${s.id}/settings`, {
    method: 'POST', headers: { ...auth(s), 'Content-Type': 'application/json' },
    body: JSON.stringify({ aiProvider: 'demo', aiModel: 'demo' }),
  });
  assert.strictEqual(ok.status, 200);
  // неизвестный провайдер и недоступный ChatGPT (без ключа) отклоняются
  const bad = await api(`/api/sessions/${s.id}/settings`, {
    method: 'POST', headers: { ...auth(s), 'Content-Type': 'application/json' },
    body: JSON.stringify({ aiProvider: 'skynet' }),
  });
  assert.strictEqual(bad.status, 400);
  const noKey = await api(`/api/sessions/${s.id}/settings`, {
    method: 'POST', headers: { ...auth(s), 'Content-Type': 'application/json' },
    body: JSON.stringify({ aiProvider: 'chatgpt' }),
  });
  assert.strictEqual(noKey.status, 400);
  assert.match(noKey.body.error, /OPENAI_API_KEY/);
  // неизвестная база отклоняется; выбор сохраняется в сессии
  const badKb = await api(`/api/sessions/${s.id}/settings`, {
    method: 'POST', headers: { ...auth(s), 'Content-Type': 'application/json' },
    body: JSON.stringify({ kbChoice: 'nope' }),
  });
  assert.strictEqual(badKb.status, 400);
  const view = await api(`/api/sessions/${s.id}`, { headers: auth(s) });
  assert.strictEqual(view.body.settings.aiProvider, 'demo');
});

test('compare: валидация и прогон по двум моделям (demo)', async () => {
  const s = await createSession();
  const HJ = { ...auth(s), 'Content-Type': 'application/json' };
  // до загрузки файлов и с 1 моделью — отказ
  const one = await api(`/api/sessions/${s.id}/compare`, { method: 'POST', headers: HJ, body: JSON.stringify({ models: [{ provider: 'demo' }] }) });
  assert.strictEqual(one.status, 400);
  await api(`/api/sessions/${s.id}/files`, { method: 'POST', headers: auth(s), body: uploadForm([['ТЗ.txt', 'задание: склад', 'text/plain']]) });
  const badProv = await api(`/api/sessions/${s.id}/compare`, { method: 'POST', headers: HJ, body: JSON.stringify({ models: [{ provider: 'demo' }, { provider: 'skynet' }] }) });
  assert.strictEqual(badProv.status, 400);
  // два прогона demo — механика сравнения от начала до конца
  const go = await api(`/api/sessions/${s.id}/compare`, { method: 'POST', headers: HJ, body: JSON.stringify({ models: [{ provider: 'demo', model: 'demo' }, { provider: 'demo', model: 'demo' }] }) });
  assert.strictEqual(go.status, 202);
  await waitJob(s, ['completed', 'failed']);
  const view = await api(`/api/sessions/${s.id}`, { headers: auth(s) });
  assert.strictEqual(view.body.jobStatus, 'completed');
  const cmp = view.body.results.find((r) => r.filename === 'СРАВНЕНИЕ-МОДЕЛЕЙ.md');
  assert.ok(cmp, 'файл сравнения создан');
  const dl = await fetch(`${base}/api/sessions/${s.id}/results/${cmp.id}/download`, { headers: auth(s) });
  const text = await dl.text();
  assert.ok(text.includes('Сравнительный прогон'));
  assert.ok((text.match(/## demo/g) || []).length === 2, 'обе модели в файле');
  // сводка в чате
  assert.ok(view.body.messages.some((m) => m.content.includes('Сравнение моделей завершено')));
  // факты/вопросы сессии сравнением не затронуты
  assert.strictEqual(view.body.questions.length, 0);
});

test('чат: писать можно и во время работы — сообщение встаёт в очередь, а не отбивается', async () => {
  const pipeline = require('../server/services/pipeline');
  const s = await createSession();
  const send = (text) => api(`/api/sessions/${s.id}/messages`, {
    method: 'POST', headers: { ...auth(s), 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });

  // занятость имитируем тем же множеством, которым её отмечает сам конвейер
  pipeline.runningJobs.add(s.id);
  try {
    const busy = await send('а что с охранной зоной ЛЭП?');
    assert.strictEqual(busy.status, 202, 'во время работы сообщение обязано приниматься, а не отбиваться 409');
    assert.strictEqual(busy.body.queued, true, 'ответ придёт после освобождения слота');

    const second = await send('и ещё про пожарный проезд');
    assert.strictEqual(second.status, 202);

    // обе реплики уже в ленте — человек видит, что его услышали
    const view = await api(`/api/sessions/${s.id}`, { headers: auth(s) });
    const mine = view.body.messages.filter((m) => m.role === 'user');
    assert.strictEqual(mine.length, 2);

    // и обе стоят в очереди на ответ
    const pending = pipeline.pendingChatText(s.id);
    assert.deepStrictEqual(pending, ['а что с охранной зоной ЛЭП?', 'и ещё про пожарный проезд']);
  } finally {
    pipeline.runningJobs.delete(s.id);
  }
});

test('чат: до первого анализа написанное закрепляется как указание к данным', async () => {
  const s = await createSession();
  // указанием к данным считается написанное, когда данные уже загружены
  await api(`/api/sessions/${s.id}/files`, {
    method: 'POST', headers: auth(s),
    body: uploadForm([['ГПЗУ.pdf', '%PDF-1.4', 'application/pdf']]),
  });
  await api(`/api/sessions/${s.id}/messages`, {
    method: 'POST', headers: { ...auth(s), 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'этажность до 3, ТХ отсутствует' }),
  });
  const view = await api(`/api/sessions/${s.id}`, { headers: auth(s) });
  assert.match(view.body.comment, /этажность до 3/,
    'до запуска анализа реплика обязана попасть в закреплённый комментарий к данным');

  // повтор той же мысли комментарий не удваивает
  await api(`/api/sessions/${s.id}/messages`, {
    method: 'POST', headers: { ...auth(s), 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'этажность до 3, ТХ отсутствует' }),
  });
  const view2 = await api(`/api/sessions/${s.id}`, { headers: auth(s) });
  assert.strictEqual(view2.body.comment.match(/этажность до 3/g).length, 1);
});

test('чат: карточка этапа и отчёт анализа НЕ считаются ответом на вопрос', async () => {
  const pipeline = require('../server/services/pipeline');
  const stages = require('../server/services/stages');
  const s = await createSession();

  pipeline.runningJobs.add(s.id);
  await api(`/api/sessions/${s.id}/messages`, {
    method: 'POST', headers: { ...auth(s), 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'а что с охранной зоной?' }),
  });
  // задача заканчивается своей выдачей: отчётом анализа и карточкой согласования.
  // Ни то, ни другое не отвечает на заданный вопрос — очередь обязана уцелеть.
  pipeline.addMessage(s.id, 'assistant', 'result', 'Анализ завершён');
  stages.addCard(s.id, 'zones', { zones: [] });
  try {
    assert.deepStrictEqual(pipeline.pendingChatText(s.id), ['а что с охранной зоной?'],
      'выдача задачи не должна съедать вопрос человека');
  } finally {
    pipeline.runningJobs.delete(s.id);
  }
});

test('чат: реплика помощника закрывает очередь, ошибка — тоже', async () => {
  const pipeline = require('../server/services/pipeline');
  const s = await createSession();
  pipeline.runningJobs.add(s.id);
  try {
    await api(`/api/sessions/${s.id}/messages`, {
      method: 'POST', headers: { ...auth(s), 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'первый вопрос' }),
    });
    pipeline.addMessage(s.id, 'assistant', 'chat', 'вот ответ');
    assert.deepStrictEqual(pipeline.pendingChatText(s.id), []);

    await api(`/api/sessions/${s.id}/messages`, {
      method: 'POST', headers: { ...auth(s), 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'второй вопрос' }),
    });
    assert.deepStrictEqual(pipeline.pendingChatText(s.id), ['второй вопрос']);
    // ошибка тоже реплика: иначе очередь пыталась бы отвечать вечно
    pipeline.addMessage(s.id, 'assistant', 'error', 'не получилось');
    assert.deepStrictEqual(pipeline.pendingChatText(s.id), []);
  } finally {
    pipeline.runningJobs.delete(s.id);
  }
});

test('чат: отложенные вопросы получают ответ после освобождения слота', async () => {
  const pipeline = require('../server/services/pipeline');
  const s = await createSession();
  pipeline.runningJobs.add(s.id);
  for (const text of ['вопрос один', 'вопрос два']) {
    await api(`/api/sessions/${s.id}/messages`, {
      method: 'POST', headers: { ...auth(s), 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
  }
  // так заканчивается настоящая задача — карточкой, а не ответом человеку
  pipeline.addMessage(s.id, 'assistant', 'result', 'Анализ завершён');
  assert.strictEqual(pipeline.pendingChatText(s.id).length, 2, 'оба вопроса ждут ответа');

  pipeline.runningJobs.delete(s.id);
  pipeline.drainPendingChats();
  for (let i = 0; i < 80 && pipeline.pendingChatText(s.id).length; i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.strictEqual(pipeline.pendingChatText(s.id).length, 0, 'вопросы остались без ответа');
  const view = await api(`/api/sessions/${s.id}`, { headers: auth(s) });
  const replies = view.body.messages.filter((m) => m.role === 'assistant' && m.kind === 'chat');
  assert.strictEqual(replies.length, 1, 'два вопроса подряд закрываются одним ответом, а не двумя');
});

test('чат: очередь разбирается и когда слот держала ЧУЖАЯ сессия', async () => {
  const pipeline = require('../server/services/pipeline');
  const mine = await createSession();
  const foreign = [];
  // слоты общие на сервер: занимаем их все чужими проектами. Своей задачи
  // у mine нет, значит и события «слот освободился» в этой сессии не будет
  const config = require('../server/config');
  for (let i = 0; i < config.maxConcurrentJobs; i++) foreign.push(await createSession());
  for (const f of foreign) pipeline.runningJobs.add(f.id);
  await api(`/api/sessions/${mine.id}/messages`, {
    method: 'POST', headers: { ...auth(mine), 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'вопрос при занятом чужой задачей слоте' }),
  });
  assert.strictEqual(pipeline.pendingChatText(mine.id).length, 1);

  for (const f of foreign) pipeline.runningJobs.delete(f.id);
  pipeline.drainPendingChats();
  for (let i = 0; i < 80 && pipeline.pendingChatText(mine.id).length; i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.strictEqual(pipeline.pendingChatText(mine.id).length, 0,
    'разбор очереди обязан быть общим, а не только внутри своей сессии');
});

test('чат: ответ помощника не выдаёт себя за анализ и не гасит согласование', async () => {
  const s = await createSession();
  const before = await api(`/api/sessions/${s.id}`, { headers: auth(s) });
  assert.strictEqual(before.body.chatBusy, false);
  assert.strictEqual(before.body.pendingChats, 0);

  await api(`/api/sessions/${s.id}/messages`, {
    method: 'POST', headers: { ...auth(s), 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'привет' }),
  });
  // job_status чат не трогает: по нему живут карточка прогресса, виджет
  // уточняющих вопросов и точка проекта в сайдбаре
  for (let i = 0; i < 60; i++) {
    const v = await api(`/api/sessions/${s.id}`, { headers: auth(s) });
    assert.ok(!['queued', 'running'].includes(v.body.jobStatus),
      `чат поднял job_status в ${v.body.jobStatus}`);
    if (v.body.messages.some((m) => m.role === 'assistant')) break;
    await new Promise((r) => setTimeout(r, 100));
  }
});

test('чат: «привет» до загрузки файлов не уходит в указания к данным', async () => {
  const s = await createSession();
  await api(`/api/sessions/${s.id}/messages`, {
    method: 'POST', headers: { ...auth(s), 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'привет, как дела' }),
  });
  const view = await api(`/api/sessions/${s.id}`, { headers: auth(s) });
  assert.strictEqual(view.body.comment || '', '',
    'болтовня до загрузки данных не должна попадать в промпт анализа');
});

test('чат: закреплённое указание режется по целым строкам, а не посреди слова', async () => {
  const s = await createSession();
  await api(`/api/sessions/${s.id}/files`, {
    method: 'POST', headers: auth(s),
    body: uploadForm([['ГПЗУ.pdf', '%PDF-1.4', 'application/pdf']]),
  });
  for (let i = 0; i < 6; i++) {
    await api(`/api/sessions/${s.id}/messages`, {
      method: 'POST', headers: { ...auth(s), 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: `указание номер ${i} ` + 'ы'.repeat(900) }),
    });
  }
  const view = await api(`/api/sessions/${s.id}`, { headers: auth(s) });
  const lines = view.body.comment.split('\n');
  assert.ok(view.body.comment.length <= 4000);
  // уцелевшие строки целы: обрезка выбрасывает самые старые целиком
  for (const l of lines) assert.match(l, /^указание номер \d /);
  assert.ok(lines.length < 6, 'самые старые указания должны были вытесниться');
});

test('проект: удаление и переименование требуют оба ключа — проекта и человека', async () => {
  const s = await createSession();

  // без токена человека защищённый маршрут обязан отказать, а не сделать вид
  const noUser = await api(`/api/sessions/${s.id}`, {
    method: 'DELETE', headers: { Authorization: `Bearer ${s.token}` },
  });
  assert.strictEqual(noUser.status, 403, 'без токена человека удаление недопустимо');
  const alive = await api(`/api/sessions/${s.id}`, { headers: auth(s) });
  assert.strictEqual(alive.status, 200, 'проект не должен исчезнуть после отказа');

  // переименование с обоими ключами работает
  const renamed = await api(`/api/sessions/${s.id}/settings`, {
    method: 'POST', headers: { ...auth(s), 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Новое название' }),
  });
  assert.strictEqual(renamed.status, 200);
  const view = await api(`/api/sessions/${s.id}`, { headers: auth(s) });
  assert.strictEqual(view.body.title, 'Новое название');

  // и удаление с обоими ключами действительно удаляет
  const del = await api(`/api/sessions/${s.id}`, { method: 'DELETE', headers: auth(s) });
  assert.strictEqual(del.status, 200);
  const gone = await api(`/api/sessions/${s.id}`, { headers: auth(s) });
  assert.strictEqual(gone.status, 404, 'проект обязан исчезнуть');
});

test('уточнения: после потолка кругов анализ обязан выпустить отчёт, а не спрашивать снова', async () => {
  const config = require('../server/config');
  const { db } = require('../server/db');
  const s = await createSession();
  await api(`/api/sessions/${s.id}/files`, {
    method: 'POST', headers: auth(s),
    body: uploadForm([['ГПЗУ.pdf', '%PDF-1.4', 'application/pdf']]),
  });

  // набиваем историю уточнений до потолка
  const { randomUUID } = require('crypto');
  for (let i = 0; i < config.maxClarificationAnswers; i++) {
    db.prepare('INSERT INTO questions (id, session_id, text, why, status, answer, created_at, answered_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(randomUUID(), s.id, `старый вопрос ${i}`, '', 'answered', 'ответ', new Date().toISOString(), new Date().toISOString());
  }
  const qid = randomUUID();
  db.prepare('INSERT INTO questions (id, session_id, text, why, status, created_at) VALUES (?,?,?,?,?,?)')
    .run(qid, s.id, 'последний вопрос', '', 'pending', new Date().toISOString());

  const res = await api(`/api/sessions/${s.id}/questions/${qid}/answer`, {
    method: 'POST', headers: { ...auth(s), 'Content-Type': 'application/json' },
    body: JSON.stringify({ answer: 'последний ответ' }),
  });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.continued, true);

  // в журнале должна остаться отметка, что уточнения исчерпаны
  for (let i = 0; i < 40; i++) {
    const ev = db.prepare("SELECT COUNT(*) AS c FROM events WHERE session_id = ? AND stage = 'Уточнения исчерпаны'").get(s.id).c;
    if (ev > 0) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.fail('после потолка кругов не выставлено требование выпустить отчёт');
});

test('комментарий к области плана уходит репликой в ленту проекта', async () => {
  const s = await createSession();
  // чертёж нужен, чтобы у проекта появилась версия плана: аннотация к ней привязана
  const dxf = ['0', 'SECTION', '2', 'ENTITIES', '0', 'LWPOLYLINE', '8', 'Границы ЗУ', '90', '4', '70', '1',
    '10', '0', '20', '0', '10', '60', '20', '0', '10', '60', '20', '40', '10', '0', '20', '40',
    '0', 'ENDSEC', '0', 'EOF'].join('\n');
  await api(`/api/sessions/${s.id}/files`, { method: 'POST', headers: auth(s), body: uploadForm([['план.dxf', dxf, 'application/dxf']]) });
  const plan = await api(`/api/sessions/${s.id}/plan`, { headers: auth(s) });
  assert.strictEqual(plan.status, 200);

  const before = await api(`/api/sessions/${s.id}/messages`, { headers: auth(s) });
  const countBefore = (before.body.messages || before.body || []).length;

  const created = await api(`/api/sessions/${s.id}/annotations`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...auth(s) },
    body: JSON.stringify({
      planId: plan.body.planId, geometryType: 'rect',
      geometry: { points: [[10, 10], [30, 10], [30, 25], [10, 25]] },
      comment: 'Здесь углубление, строить нельзя', author: 'Никита',
    }),
  });
  assert.strictEqual(created.status, 201);

  const after = await api(`/api/sessions/${s.id}/messages`, { headers: auth(s) });
  const list = after.body.messages || after.body || [];
  assert.strictEqual(list.length, countBefore + 1, 'комментарий обязан появиться в ленте, а не только на плане');
  const msg = list[list.length - 1];
  assert.match(msg.content, /Здесь углубление, строить нельзя/);
  assert.match(msg.content, /X 10…30/, 'место названо координатами — иначе через неделю не найти');
  assert.match(msg.content, /Никита/);
});

test('чертёж по слоям выгружается сразу после разбора, с правками человека', async () => {
  const s = await createSession();
  // контур участка лежит на слое газопровода — разбор примет его за сеть,
  // как в настоящем МСК-47_Горбунки
  const dxf = ['0', 'SECTION', '2', 'ENTITIES',
    '0', 'LWPOLYLINE', '8', '33_Газопровод', '90', '4', '70', '1',
    '10', '0', '20', '0', '10', '70', '20', '0', '10', '70', '20', '55', '10', '0', '20', '55',
    '0', 'LWPOLYLINE', '8', '20_Здания', '90', '4', '70', '1',
    '10', '10', '20', '10', '10', '30', '20', '10', '10', '30', '20', '25', '10', '10', '20', '25',
    '0', 'ENDSEC', '0', 'EOF'].join('\n');
  await api(`/api/sessions/${s.id}/files`, {
    method: 'POST', headers: auth(s), body: uploadForm([['топо.dxf', dxf, 'application/dxf']]),
  });

  // до правки: контур на слое газопровода — инженерная сеть
  const plan = await api(`/api/sessions/${s.id}/plan`, { headers: auth(s) });
  assert.strictEqual(plan.status, 200);
  const line = plan.body.plan.utilities[0];
  assert.ok(line, 'контур с газопровода разобран как сеть');

  // бинарный ответ читаем напрямую: общий помощник api() уже прочитал бы тело текстом
  const before = await fetch(`${base}/api/sessions/${s.id}/plan/drawing`, { headers: auth(s) });
  assert.strictEqual(before.status, 200);
  assert.ok(['dwg', 'dxf'].includes(before.headers.get('X-Drawing-Format')));
  assert.ok((await before.arrayBuffer()).byteLength > 0, 'файл не пустой');

  // человек говорит: это граница участка
  const saved = await api(`/api/sessions/${s.id}/plan/objects/${encodeURIComponent(line.id)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...auth(s) },
    body: JSON.stringify({ type: 'parcel', label: 'ЗУ по ГПЗУ' }),
  });
  assert.strictEqual(saved.status, 200);

  // в чертеже контур обязан оказаться в слое границ участка, а не сетей
  const after = await fetch(`${base}/api/sessions/${s.id}/plan/drawing?format=dxf`, { headers: auth(s) });
  assert.strictEqual(after.status, 200);
  // DXF пишется байтами в CP1251 — читать его UTF-8 значит получить мусор вместо имён слоёв
  const text = new TextDecoder('windows-1251').decode(await after.arrayBuffer());
  assert.match(text, /AI_ГРАНИЦЫ_ЗУ/, 'переназначенный контур ушёл в слой границ участка');
  assert.match(text, /AI_ЗДАНИЯ_КАПИТАЛЬНЫЕ/, 'здание — в своём слое');
  assert.ok(!/\n\s*8\nAI_СЕТИ\n/.test(text), 'в слое сетей контура больше нет — правка доехала до файла');
});

/* ---------------- границы входа ---------------- */

test('границы участка: пустое тело без точек и документов — 400; недоступная модель — 503, не 500', async () => {
  const s = await createSession();
  const empty = await api(`/api/sessions/${s.id}/plan/parcel-source`, {
    method: 'POST', headers: { ...auth(s), 'Content-Type': 'application/json' }, body: '{}',
  });
  assert.strictEqual(empty.status, 400, JSON.stringify(empty.body));
  assert.match(empty.body.error, /points.*ГПЗУ/);
  // документ есть — ветка «по документу» законна, но модель в mock-режиме недоступна: 503 с причиной
  const up = await api(`/api/sessions/${s.id}/files`, { method: 'POST', headers: auth(s), body: uploadForm([['ГПЗУ.txt', 'Таблица координат: 1) 100 200', 'text/plain']]) });
  assert.strictEqual(up.status, 200);
  const byDoc = await api(`/api/sessions/${s.id}/plan/parcel-source`, {
    method: 'POST', headers: { ...auth(s), 'Content-Type': 'application/json' }, body: '{}',
  });
  assert.strictEqual(byDoc.status, 503, JSON.stringify(byDoc.body));
  assert.match(byDoc.body.error, /Демо-режим/);
  // точки от человека — модель не нужна, работает и без документов
  const s2 = await createSession();
  const manual = await api(`/api/sessions/${s2.id}/plan/parcel-source`, {
    method: 'POST', headers: { ...auth(s2), 'Content-Type': 'application/json' },
    body: JSON.stringify({ points: [[0, 0], [100, 0], [100, 100], [0, 100]] }),
  });
  assert.strictEqual(manual.status, 200, JSON.stringify(manual.body));
  assert.strictEqual(manual.body.by, 'user');
});

test('загрузка: неожиданное поле файла — 400 с подсказкой, а не 413', async () => {
  const s = await createSession();
  const fd = new FormData();
  fd.append('file', new File(['задание'], 'ТЗ.txt', { type: 'text/plain' }));
  const r = await api(`/api/sessions/${s.id}/files`, { method: 'POST', headers: auth(s), body: fd });
  assert.strictEqual(r.status, 400, JSON.stringify(r.body));
  assert.match(r.body.error, /Неожиданное поле файла.*files\/file/);
});

test('комментарий: нестроковое значение — 400', async () => {
  const s = await createSession();
  for (const comment of [5, { a: 1 }, ['x'], true]) {
    const r = await api(`/api/sessions/${s.id}/comment`, {
      method: 'POST', headers: { ...auth(s), 'Content-Type': 'application/json' }, body: JSON.stringify({ comment }),
    });
    assert.strictEqual(r.status, 400, `comment=${JSON.stringify(comment)}: ${r.status}`);
    assert.match(r.body.error, /строкой/);
  }
  const clear = await api(`/api/sessions/${s.id}/comment`, {
    method: 'POST', headers: { ...auth(s), 'Content-Type': 'application/json' }, body: JSON.stringify({ comment: null }),
  });
  assert.strictEqual(clear.status, 200);
});

test('статистика: ?days отрицательный или не число — 400 «days: целое от 0»', async () => {
  if (!userToken) userToken = await login();
  for (const days of ['-1', 'abc', '1.5']) {
    const r = await api(`/api/stats/overview?days=${days}`, { headers: asUser() });
    assert.strictEqual(r.status, 400, `days=${days}: ${r.status} ${JSON.stringify(r.body)}`);
    assert.match(r.body.error, /days: целое от 0/);
  }
  for (const days of ['0', '7', '400']) {
    const r = await api(`/api/stats/overview?days=${days}`, { headers: asUser() });
    assert.strictEqual(r.status, 200, `days=${days}: ${r.status} ${JSON.stringify(r.body)}`);
  }
  const dflt = await api('/api/stats/overview', { headers: asUser() });
  assert.strictEqual(dflt.status, 200);
});

test('критическая инфраструктура: запись без классификации — «Не указана классификация объекта»', async () => {
  if (!userToken) userToken = await login();
  const r = await api('/api/critical-objects', {
    method: 'POST', headers: { ...asUser(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ sourceLayer: 'Слой без класса', validatedBy: 'Иван Петров' }),
  });
  assert.strictEqual(r.status, 400, JSON.stringify(r.body));
  assert.strictEqual(r.body.error, 'Не указана классификация объекта');
  const wrong = await api('/api/critical-objects', {
    method: 'POST', headers: { ...asUser(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ sourceLayer: 'Слой без класса', classification: 'выдумка', validatedBy: 'Иван Петров' }),
  });
  assert.strictEqual(wrong.status, 400);
  assert.match(wrong.body.error, /Неизвестная классификация: выдумка/);
});

test('критическая инфраструктура: список только вошедшим, подпись подтвердившего — из входа, а не из тела', async () => {
  if (!userToken) userToken = await login();
  assert.strictEqual((await api('/api/critical-objects')).status, 401);
  assert.strictEqual((await api('/api/cad/status')).status, 401);
  const listed = await api('/api/critical-objects', { headers: asUser() });
  assert.strictEqual(listed.status, 200);
  const saved = await api('/api/critical-objects', {
    method: 'POST', headers: { ...asUser(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ sourceLayer: 'Слой подписи', classification: 'critical', validatedBy: 'Самозванец Ложный' }),
  });
  assert.strictEqual(saved.status, 201, JSON.stringify(saved.body));
  const row = (saved.body.object || saved.body);
  assert.ok(!JSON.stringify(saved.body).includes('Самозванец'), 'подпись из тела не должна сохраняться');
  assert.ok(JSON.stringify(saved.body).includes('Тестов'), `подпись обязана быть ФИО вошедшего: ${JSON.stringify(row).slice(0, 200)}`);
});

test('заголовки безопасности: HSTS, Permissions-Policy, CSP без inline; 404-страница без инлайн-скрипта', async () => {
  const res = await fetch(`${base}/api/health`);
  assert.strictEqual(res.headers.get('strict-transport-security'), 'max-age=31536000; includeSubDomains');
  assert.match(res.headers.get('permissions-policy') || '', /camera=\(\)/);
  assert.match(res.headers.get('content-security-policy') || '', /script-src 'self'/);
  const page = await fetch(`${base}/no-such-page`, { headers: { Accept: 'text/html' } });
  assert.strictEqual(page.status, 404);
  const html = await page.text();
  assert.ok(!/<script>/.test(html), 'инлайн-скрипт на 404-странице режется CSP');
  assert.match(html, /error-pages\/app-404\.js/);
  const js = await fetch(`${base}/error-pages/app-404.js`);
  assert.strictEqual(js.status, 200);
});
