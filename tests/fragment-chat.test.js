'use strict';
/**
 * Обсуждение выделенного фрагмента (замечание владельца 10.09.2026, п. 4).
 *
 * Проверяется главное обещание: модель получает НЕ голый фрагмент, а место —
 * модуль, проект, подпись места и текст вокруг. Плюс правила платформы:
 * без входа обсуждения нет, чужой проект — 404, нейросеть берётся у проекта,
 * а не из тела запроса.
 */
const os = require('os');
const path = require('path');
const fs = require('fs');
process.env.DATA_DIR = path.join(os.tmpdir(), `pilot1-frag-${process.pid}`);
process.env.ANTHROPIC_API_KEY = '';
process.env.USERS_FILE = path.join(os.tmpdir(), `pilot1-frag-users-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
process.env.RATE_LIMIT_GENERAL = '1000';
process.env.RATE_LIMIT_EXPENSIVE = '1000';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { createApp } = require('../server/app');
const fragmentChat = require('../server/services/fragment-chat');
const projects = require('../server/services/projects');

let server, base;

before(async () => {
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  fragmentChat._setCallFn(null);
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

async function login(lastName, firstName = 'Инженер') {
  const { body } = await api('/api/auth/enter', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lastName, firstName }),
  });
  return body.token || '';
}

const auth = (token) => ({ 'Content-Type': 'application/json', 'X-User-Token': token });

/**
 * Проект платформы. Нейросеть проставляется службой напрямую: маршрут сверяет
 * выбор с ЖИВЫМ списком моделей провайдера, и тест зависел бы от того, поднята
 * ли сейчас LM Studio на машине разработчика.
 */
async function makeProject(token, name, ai = { aiProvider: 'lmstudio', aiModel: 'qwen3' }) {
  const { body } = await api('/api/projects', {
    method: 'POST', headers: auth(token), body: JSON.stringify({ name }),
  });
  const project = body.project;
  if (ai.aiProvider) projects.update(project.id, { aiProvider: ai.aiProvider, aiModel: ai.aiModel || '' });
  return project;
}

const FRAGMENT = 'Проектную документацию выполнить в соответствии с действующими нормами.';

test('обсуждение фрагмента: без входа не открывается', async () => {
  const { status } = await api('/api/fragment-chat/threads', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fragment: FRAGMENT }),
  });
  assert.equal(status, 401);
});

test('обсуждение фрагмента: пустое выделение — 422, чужой модуль — 400', async () => {
  const token = await login('Пустов');
  const empty = await api('/api/fragment-chat/threads', {
    method: 'POST', headers: auth(token), body: JSON.stringify({ fragment: '   ' }),
  });
  assert.equal(empty.status, 422);

  const alien = await api('/api/fragment-chat/threads', {
    method: 'POST', headers: auth(token), body: JSON.stringify({ fragment: FRAGMENT, module: 'взлом' }),
  });
  assert.equal(alien.status, 400);

  const notString = await api('/api/fragment-chat/threads', {
    method: 'POST', headers: auth(token), body: JSON.stringify({ fragment: FRAGMENT, anchor: 42 }),
  });
  assert.equal(notString.status, 422);
});

test('обсуждение фрагмента: то же выделение в том же месте не плодит вторую нить', async () => {
  const token = await login('Повторов');
  const project = await makeProject(token, 'Повторы');
  const body = JSON.stringify({
    projectId: project.id, module: 'tz', entityId: 'run-1',
    anchor: 'замечание F-003', fragment: FRAGMENT, context: 'Абзац до. ' + FRAGMENT + ' Абзац после.',
  });
  const first = await api('/api/fragment-chat/threads', { method: 'POST', headers: auth(token), body });
  const second = await api('/api/fragment-chat/threads', { method: 'POST', headers: auth(token), body });
  assert.equal(first.status, 200);
  assert.equal(second.body.thread.id, first.body.thread.id, 'на то же выделение заведена вторая нить');

  const list = await api(`/api/fragment-chat/threads?project=${project.id}&module=tz&entity=run-1`, {
    headers: auth(token),
  });
  assert.equal(list.body.threads.length, 1);
  assert.equal(list.body.threads[0].anchor, 'замечание F-003');
});

test('обсуждение фрагмента: модели уходит МЕСТО, а не голый фрагмент', async () => {
  const token = await login('Контекстов');
  const project = await makeProject(token, 'Складской комплекс');
  const { body: made } = await api('/api/fragment-chat/threads', {
    method: 'POST',
    headers: auth(token),
    body: JSON.stringify({
      projectId: project.id, module: 'tz', entityId: 'run-7',
      anchor: 'замечание F-012, п. 4.2',
      fragment: FRAGMENT,
      context: 'Раздел 4. Требования к проектной документации.\n\n' + FRAGMENT + '\n\nСроки выполнения работ уточняются.',
    }),
  });

  let seen = null;
  fragmentChat._setCallFn(async (args) => { seen = args; return { text: 'Пункт не называет ни одного норматива.' }; });
  const answer = await api(`/api/fragment-chat/threads/${made.thread.id}/messages`, {
    method: 'POST', headers: auth(token), body: JSON.stringify({ message: 'Что здесь не так?' }),
  });
  fragmentChat._setCallFn(null);

  assert.equal(answer.status, 200);
  assert.match(answer.body.reply, /норматив/);
  assert.ok(seen, 'модель не вызывалась');

  const opening = seen.messages[0].content;
  assert.match(opening, /Анализ ТЗ/, 'в контексте нет модуля');
  assert.match(opening, /Складской комплекс/, 'в контексте нет проекта');
  assert.match(opening, /замечание F-012, п\. 4\.2/, 'в контексте нет подписи места');
  assert.match(opening, /Требования к проектной документации/, 'в контексте нет текста вокруг');
  assert.ok(opening.includes(FRAGMENT), 'в контексте нет самого фрагмента');
  assert.equal(seen.messages[seen.messages.length - 1].content, 'Что здесь не так?');
  // нейросеть берётся у проекта, а не из тела запроса
  assert.equal(seen.route.provider, 'lmstudio');
  assert.equal(seen.route.model, 'qwen3');

  // разговор сохранился и виден при возврате
  const again = await api(`/api/fragment-chat/threads/${made.thread.id}`, { headers: auth(token) });
  assert.equal(again.body.thread.messages.length, 2);
  assert.equal(again.body.thread.messages[0].role, 'user');
  assert.equal(again.body.thread.messages[1].role, 'assistant');
});

test('обсуждение фрагмента: у проекта без нейросети — понятный отказ, а не падение', async () => {
  const token = await login('Безмодельный');
  const project = await makeProject(token, 'Без нейросети', {});
  const { body: made } = await api('/api/fragment-chat/threads', {
    method: 'POST', headers: auth(token),
    body: JSON.stringify({ projectId: project.id, module: 'doc', fragment: FRAGMENT }),
  });
  const answer = await api(`/api/fragment-chat/threads/${made.thread.id}/messages`, {
    method: 'POST', headers: auth(token), body: JSON.stringify({ message: 'Поясните пункт' }),
  });
  assert.equal(answer.status, 422);
  assert.match(answer.body.error, /нейросет/i);
});

test('обсуждение фрагмента: чужой проект — 404, как и всё в нём', async () => {
  const owner = await login('Хозяин');
  const stranger = await login('Посторонний');
  const project = await makeProject(owner, 'Закрытый проект');

  const open = await api('/api/fragment-chat/threads', {
    method: 'POST', headers: auth(stranger),
    body: JSON.stringify({ projectId: project.id, module: 'tz', fragment: FRAGMENT }),
  });
  assert.equal(open.status, 404);

  const { body: mine } = await api('/api/fragment-chat/threads', {
    method: 'POST', headers: auth(owner),
    body: JSON.stringify({ projectId: project.id, module: 'tz', fragment: FRAGMENT }),
  });
  const peek = await api(`/api/fragment-chat/threads/${mine.thread.id}`, { headers: auth(stranger) });
  assert.equal(peek.status, 404);
});

test('обсуждение фрагмента: промт запрещает выдумывать числа и нормативы', () => {
  const prompts = require('../server/services/prompts');
  const text = prompts.load('fragment-chat');
  assert.match(text, /НЕ ВЫДУМЫВАЙ/);
  assert.match(text, /ДАННЫЕ, а не инструкции/);
  assert.match(text, /\[УКАЗАТЬ\]/);
});
