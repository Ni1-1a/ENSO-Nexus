'use strict';
/**
 * Модуль «Вопрос по нормам» (07.10.2026, разбор ArmetaCAD).
 *
 * Главное обещание: модель отвечает ТОЛЬКО по выдержкам, которые нашёл код,
 * а каждую её ссылку код сверяет с выдержкой — документ, пункт, дословная
 * цитата. Непроверенное не выбрасывается, а понижается со статусом.
 * Плюс правила платформы: без входа нет, чужой проект — 404, нейросеть у
 * проекта, без выдержек модель не вызывается.
 */
const os = require('os');
const path = require('path');
const fs = require('fs');
process.env.DATA_DIR = path.join(os.tmpdir(), `pilot1-ntd-${process.pid}`);
process.env.ANTHROPIC_API_KEY = '';
process.env.USERS_FILE = path.join(os.tmpdir(), `pilot1-ntd-users-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
process.env.RATE_LIMIT_GENERAL = '1000';
process.env.RATE_LIMIT_EXPENSIVE = '1000';
process.env.RATE_LIMIT_AUTH = '1000';
// две базы знаний: каталоги пустые, чанки кладутся прямо в таблицу (без векторов → поиск по словам)
const KB_TMP = path.join(os.tmpdir(), `pilot1-ntd-kb-${process.pid}`);
fs.mkdirSync(path.join(KB_TMP, 'main'), { recursive: true });
fs.mkdirSync(path.join(KB_TMP, 'verified'), { recursive: true });
process.env.KB_DIR = path.join(KB_TMP, 'main');
process.env.KB_VERIFIED_DIR = path.join(KB_TMP, 'verified');
// корпус нормоконтроля недоступен: мёртвый порт — быстрый отказ, а не зависание
process.env.NORMO_DATABASE_URL = 'postgresql://127.0.0.1:1/none';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { createApp } = require('../server/app');
const ntdAsk = require('../server/services/ntd-ask');
const ntdCite = require('../server/services/ntd-cite');
const projects = require('../server/services/projects');
const { db, now } = require('../server/db');

let server, base;

const CHUNKS = [
  {
    doc: 'СП 4.13130.2013', clause: '4.3',
    text: 'Противопожарные расстояния между жилыми и общественными зданиями, а также между жилыми, общественными зданиями и вспомогательными зданиями и сооружениями производственного, складского и технического назначения принимаются не менее 6 м для зданий I и II степеней огнестойкости и класса конструктивной пожарной опасности С0.',
  },
  {
    doc: 'СП 42.13330.2016', clause: '7.1',
    text: 'Расстояния между жилыми зданиями, жилыми и общественными, а также производственными зданиями следует принимать на основе расчётов инсоляции и освещённости в соответствии с требованиями раздела 14, нормами освещённости, а также в соответствии с противопожарными требованиями.',
  },
  {
    doc: 'ГОСТ 21.508-2020', clause: '5.2',
    text: 'На генеральном плане наносят и указывают строительную геодезическую сетку или заменяющие её разбивочный базис, красные линии, проектируемые объекты капитального строительства и въезды на территорию.',
  },
];

function seedKb() {
  const ins = db.prepare("INSERT INTO kb_chunks (doc, clause, text, priority, embedding, kb) VALUES (?,?,?,?,NULL,'main')");
  for (const c of CHUNKS) ins.run(c.doc, c.clause, c.text, '');
  db.prepare("INSERT INTO kb_meta (key, value) VALUES ('indexed_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(now());
}

before(async () => {
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  seedKb();
});
after(() => {
  ntdAsk._setCallFn(null);
  server.close();
  fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
  fs.rmSync(KB_TMP, { recursive: true, force: true });
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

/** Проект платформы; нейросеть — службой напрямую (маршрут сверяет выбор с живой LM Studio). */
async function makeProject(token, name, ai = { aiProvider: 'lmstudio', aiModel: 'qwen3' }) {
  const { body } = await api('/api/projects', { method: 'POST', headers: auth(token), body: JSON.stringify({ name }) });
  const project = body.project;
  assert.ok(project, `проект не создан: ${JSON.stringify(body).slice(0, 200)}`);
  if (ai.aiProvider) projects.update(project.id, { aiProvider: ai.aiProvider, aiModel: ai.aiModel || '' });
  return project;
}

async function ask(token, projectId, question, extra = {}) {
  return api('/api/ntd/questions', {
    method: 'POST', headers: auth(token), body: JSON.stringify({ projectId, question, ...extra }),
  });
}

async function waitDone(token, id) {
  let q = null;
  for (let i = 0; i < 400; i++) {
    const r = await api(`/api/ntd/questions/${id}`, { headers: auth(token) });
    q = r.body.question;
    if (q && ['done', 'failed'].includes(q.status)) return q;
    await new Promise((res) => setTimeout(res, 20));
  }
  return q;
}

/** Номер выдержки по документу — из блока, который реально ушёл модели. */
function excerptNo(content, doc) {
  const m = new RegExp(`\\[(\\d+)\\] ${doc.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).exec(content);
  return m ? Number(m[1]) : null;
}

const QUESTION = 'Какое противопожарное расстояние между зданиями I и II степеней огнестойкости?';

test('вопрос по нормам: без входа — 401', async () => {
  const r = await api('/api/ntd/questions', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: QUESTION }),
  });
  assert.equal(r.status, 401);
  assert.equal((await api('/api/ntd/meta')).status, 401);
});

test('вопрос по нормам: справочное — обе базы, корпус честно недоступен', async () => {
  const token = await login('Справочный');
  const r = await api('/api/ntd/meta', { headers: auth(token) });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.bases.map((b) => b.id), ['main', 'verified']);
  assert.equal(r.body.corpus.available, false);
  assert.match(r.body.corpus.reason, /недоступна/);
  assert.equal(r.body.maxQuestion, 2000);
  assert.ok(r.body.kb.chunks >= CHUNKS.length);
});

test('вопрос по нормам: пустой вопрос — 422, чужая база — 400, corpus не булев — 400, проект без нейросети — 422', async () => {
  const token = await login('Проверяющий');
  const project = await makeProject(token, 'Проверки входа');
  assert.equal((await ask(token, project.id, '   ')).status, 422);
  assert.equal((await ask(token, project.id, 'x'.repeat(2001))).status, 422);
  assert.equal((await ask(token, project.id, QUESTION, { kb: 'grisha' })).status, 400);
  assert.equal((await ask(token, project.id, QUESTION, { corpus: 'да' })).status, 400);
  assert.equal((await ask(token, project.id, 42)).status, 400);
  const none = await makeProject(token, 'Без нейросети', {});
  const r = await ask(token, none.id, QUESTION);
  assert.equal(r.status, 422);
  assert.match(r.body.error, /нейросет/i);
});

test('вопрос по нормам: выдержки уходят модели, ссылки сверяются кодом — четыре статуса', async () => {
  const token = await login('Нормативов');
  const project = await makeProject(token, 'Склад готовой продукции');
  let seen = null;
  ntdAsk._setCallFn(async (args) => {
    seen = args;
    const content = args.messages[0].content;
    const n1 = excerptNo(content, 'СП 4.13130.2013');
    const n2 = excerptNo(content, 'СП 42.13330.2016');
    return {
      text: JSON.stringify({
        answer: `Не менее 6 м для зданий I и II степеней огнестойкости [${n1}]. Расстояния принимают с учётом инсоляции [${n2}]. Состав генплана — по ГОСТ 21.508-2020, а оформление — по СП 1.13130.2020 [9].`,
        found: true,
        citations: [
          { n: n1, doc: 'СП 4.13130.2013', clause: 'п. 4.3', quote: 'не менее 6 м для зданий I и II степеней огнестойкости', claim: 'минимальное расстояние' },
          { n: n2, doc: 'СП 42.13330.2016', clause: '7.9', quote: 'на основе расчётов инсоляции и освещённости', claim: 'расчёт инсоляции' },
          { n: null, doc: 'ГОСТ Р 21.101-2020', clause: '4.1', quote: 'цитата, которой в выдержках нет', claim: 'оформление' },
          { n: null, doc: 'СН РК 2.02-01-2011', clause: null, quote: '', claim: 'нормы Казахстана' },
        ],
        missing: ['Степень огнестойкости складского здания по проекту'],
        anomalies: [],
      }),
    };
  });
  const r = await ask(token, project.id, QUESTION, { kb: 'main' });
  assert.equal(r.status, 202, JSON.stringify(r.body));
  assert.equal(r.body.question.status, 'queued');
  const q = await waitDone(token, r.body.question.id);
  ntdAsk._setCallFn(null);
  assert.equal(q.status, 'done', `вопрос не отвечен: ${q && q.error}`);

  // модели ушли вопрос и пронумерованные выдержки, нейросеть — проектная
  assert.ok(seen, 'модель не вызывалась');
  const content = seen.messages[0].content;
  assert.match(content, /<knowledge_base>/);
  assert.match(content, /ВОПРОС:/);
  assert.match(content, /Склад готовой продукции/);
  assert.match(content, /\[\d+\] СП 4\.13130\.2013, п\. 4\.3/);
  assert.ok(!content.includes('ГОСТ 21.508-2020'), 'выдержка не по вопросу ушла модели');
  assert.equal(seen.route.provider, 'lmstudio');
  assert.equal(seen.route.model, 'qwen3');
  assert.equal(seen.schemaName, 'ntd_answer');
  assert.ok(seen.schema && seen.schema.required.includes('citations'));

  const res = q.result;
  assert.equal(res.found, true);
  assert.equal(res.modelCalled, true);
  assert.equal(res.search.mode, 'keyword');
  assert.equal(res.search.corpus, 'off');
  const by = (doc) => res.citations.find((c) => c.doc === doc);
  assert.equal(by('СП 4.13130.2013').status, 'confirmed');
  assert.equal(by('СП 42.13330.2016').status, 'partial', 'пункт 7.9 не сходится с выдержкой 7.1 — это «сверить»');
  assert.match(by('СП 42.13330.2016').note, /7\.9/);
  assert.equal(by('ГОСТ Р 21.101-2020').status, 'registry');
  assert.equal(by('СН РК 2.02-01-2011').status, 'unknown');
  assert.deepEqual(res.counts, { confirmed: 1, partial: 1, registry: 1, unknown: 1 });
  // документы, названные в тексте без записи в citations, и [9] без записи — замечания кода
  assert.ok(res.uncited.some((u) => u.code === 'СП 1.13130.2020'), JSON.stringify(res.uncited));
  assert.ok(res.uncited.some((u) => u.code === 'ГОСТ 21.508-2020'));
  assert.deepEqual(res.dangling, [9]);
  assert.ok(res.notes.some((n) => /\[9\]/.test(n)));
  assert.deepEqual(res.missing, ['Степень огнестойкости складского здания по проекту']);
  assert.ok(q.excerpts.length === 2 && q.excerpts.every((e) => e.n && e.doc && e.text));

  // список проекта и сводка
  const list = await api(`/api/ntd/questions?project=${project.id}`, { headers: auth(token) });
  assert.equal(list.body.questions.length, 1);
  assert.equal(list.body.questions[0].counts.confirmed, 1);
  assert.equal(list.body.questions[0].result, undefined, 'в списке полного результата нет');
  const p = await api(`/api/projects/${project.id}`, { headers: auth(token) });
  assert.equal(p.body.project.summary.ntd.state, 'ok');
  assert.match(p.body.project.summary.ntd.line, /1 вопрос/);
});

test('вопрос по нормам: без выдержек модель не вызывается, ответ честный', async () => {
  const token = await login('Пустотин');
  const project = await makeProject(token, 'Без выдержек');
  ntdAsk._setCallFn(async () => { throw new Error('модель не должна была вызываться'); });
  const r = await ask(token, project.id, 'Флюгегехаймен квазимодо тринадцатый?');
  const q = await waitDone(token, r.body.question.id);
  ntdAsk._setCallFn(null);
  assert.equal(q.status, 'done', q && q.error);
  assert.equal(q.result.found, false);
  assert.equal(q.result.modelCalled, false);
  assert.match(q.result.answer, /ничего не найдено/);
  assert.equal(q.result.citations.length, 0);
  const p = await api(`/api/projects/${project.id}`, { headers: auth(token) });
  assert.equal(p.body.project.summary.ntd.state, 'warn');
});

test('вопрос по нормам: «ответ есть» без единой ссылки понижается до «не найдено»', async () => {
  const token = await login('Голословный');
  const project = await makeProject(token, 'Понижение');
  ntdAsk._setCallFn(async () => ({ text: JSON.stringify({ answer: 'Шесть метров, точно помню.', found: true, citations: [], missing: [], anomalies: [] }) }));
  const r = await ask(token, project.id, QUESTION);
  const q = await waitDone(token, r.body.question.id);
  ntdAsk._setCallFn(null);
  assert.equal(q.status, 'done');
  assert.equal(q.result.found, false);
  assert.ok(q.result.notes.some((n) => /ни одной ссылки/.test(n)), JSON.stringify(q.result.notes));
});

test('вопрос по нормам: неразбираемый и оборванный ответ — failed с причиной, а не 500', async () => {
  const token = await login('Обрывов');
  const project = await makeProject(token, 'Обрывы');
  ntdAsk._setCallFn(async () => ({ text: 'это не JSON' }));
  let q = await waitDone(token, (await ask(token, project.id, QUESTION)).body.question.id);
  assert.equal(q.status, 'failed');
  assert.match(q.error, /неразбираем/);
  ntdAsk._setCallFn(async () => ({ text: '{"answer":"', truncated: true }));
  q = await waitDone(token, (await ask(token, project.id, QUESTION)).body.question.id);
  ntdAsk._setCallFn(null);
  assert.equal(q.status, 'failed');
  assert.match(q.error, /оборван/);
  const p = await api(`/api/projects/${project.id}`, { headers: auth(token) });
  assert.equal(p.body.project.summary.ntd.state, 'bad');
});

test('вопрос по нормам: нейросеть телом запроса не подменить, чужой проект — 404, удаляет автор', async () => {
  const owner = await login('Хозяин');
  const stranger = await login('Посторонний');
  const project = await makeProject(owner, 'Закрытый проект');
  let seen = null;
  ntdAsk._setCallFn(async (args) => { seen = args; return { text: JSON.stringify({ answer: 'ответ', found: false, citations: [], missing: [], anomalies: [] }) }; });
  const r = await ask(owner, project.id, QUESTION, { provider: 'claude', model: 'выдуманная' });
  const q = await waitDone(owner, r.body.question.id);
  ntdAsk._setCallFn(null);
  assert.equal(q.status, 'done');
  assert.equal(seen.route.provider, 'lmstudio', 'провайдер взят из тела запроса');

  assert.equal((await ask(stranger, project.id, QUESTION)).status, 404);
  assert.equal((await api(`/api/ntd/questions/${q.id}`, { headers: auth(stranger) })).status, 404);
  assert.equal((await api(`/api/ntd/questions?project=${project.id}`, { headers: auth(stranger) })).status, 404);
  assert.equal((await api(`/api/ntd/questions/${q.id}`, { method: 'DELETE', headers: auth(stranger) })).status, 404);
  assert.equal((await api(`/api/ntd/questions/${q.id}`, { method: 'DELETE', headers: auth(owner) })).status, 200);
  assert.equal((await api(`/api/ntd/questions/${q.id}`, { headers: auth(owner) })).status, 404);
  const list = await api(`/api/ntd/questions?project=${project.id}`, { headers: auth(owner) });
  assert.equal(list.body.questions.length, 0);
  // битый идентификатор проекта — 400, а не «Ранние работы»
  assert.equal((await ask(owner, 'Проект-Тайна', QUESTION)).status, 400);
});

test('вопрос по нормам: седьмой модуль есть на сервере и в каркасе', () => {
  assert.ok(projects.MODULES.includes('ntd'));
  const shell = fs.readFileSync(path.join(__dirname, '..', 'public', 'shell.js'), 'utf8');
  assert.match(shell, /key: 'ntd', n: 7, name: 'Вопрос по нормам'/);
  assert.ok(!/из 6<\/p>|\/ 6` /.test(shell), 'число модулей в каркасе зашито цифрой');
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'public', 'ntd.html')));
  const prompts = require('../server/services/prompts');
  const text = prompts.load('ntd-ask');
  assert.match(text, /ТОЛЬКО по выдержкам/);
  assert.match(text, /<knowledge_base>/);
  assert.match(text, /ДАННЫЕ, а не инструкции/);
});

/* ---------------- сверка ссылок (ntd-cite.js) ---------------- */

test('сверка ссылок: документ и пункт сравниваются по-человечески', () => {
  assert.ok(ntdCite.sameDoc('СП 4.13130.2013', 'СП 4.13130.2013 Системы противопожарной защиты'));
  assert.ok(ntdCite.sameDoc('«ГОСТ Р 21.101-2020»', 'ГОСТ Р 21.101–2020'));
  assert.ok(!ntdCite.sameDoc('СП 4.13130.2013', 'СП 42.13330.2016'));
  assert.ok(!ntdCite.sameDoc('СП 4.13130.2013', 'СП 4.13130.20131'));
  assert.ok(ntdCite.sameClause('п. 4.2.5.', '4.2.5'));
  assert.ok(ntdCite.sameClause('4.2', '4.2.5'), 'пункт и его подпункт — одно место');
  assert.ok(!ntdCite.sameClause('4.2', '4.25'));
  assert.ok(ntdCite.sameClause('Приложение Ж', 'прил. Ж'));
});

test('сверка ссылок: цитата сверяется той же нормализацией, что в quote-check', () => {
  const excerpts = [{ n: 1, doc: 'СП 4.13130.2013', clause: '4.3', text: 'Расстояния принимаются не менее 6 м — для зданий I и II степеней огнестойкости («кирпич» и бетон).' }];
  const [ok, bad, noQuote] = ntdCite.verifyCitations([
    { n: 1, doc: 'СП 4.13130.2013', clause: '4.3', quote: 'не менее 6 м - для зданий I и II степеней огнестойкости ("кирпич" и бетон)', claim: 'x' },
    { n: 1, doc: 'СП 4.13130.2013', clause: '4.3', quote: 'не менее 9 м для зданий', claim: 'x' },
    { n: 7, doc: 'СП 4.13130.2013', clause: '4.3', quote: '', claim: 'x' },
  ], excerpts);
  assert.equal(ok.status, 'confirmed');
  assert.equal(ok.excerpt, 1);
  assert.equal(bad.status, 'partial');
  assert.match(bad.note, /не найдена/);
  // номер [7] врёт, но документ и пункт сходятся с [1] — ссылка привязана к ней, цитаты нет
  assert.equal(noQuote.excerpt, 1);
  assert.equal(noQuote.status, 'partial');
  assert.match(noQuote.note, /нет содержательной цитаты/);
});

test('сверка ссылок: нормативы в свободном тексте — из выдержки, из реестра или ниоткуда', () => {
  const excerpts = [{ n: 1, doc: 'СП 4.13130.2013', clause: '4.3', text: 'текст' }];
  const refs = ntdCite.refsInText('По СП 4.13130.2013 и ГОСТ Р 21.101-2020, а также СП 999.13330.2099.', excerpts);
  const by = (code) => refs.find((r) => r.code === code);
  assert.equal(by('СП 4.13130.2013').status, 'excerpt');
  assert.equal(by('ГОСТ Р 21.101-2020').status, 'registry');
  assert.equal(by('СП 999.13330.2099').status, 'unknown');
  const block = ntdCite.formatExcerpts(excerpts);
  assert.match(block, /\[1\] СП 4\.13130\.2013, п\. 4\.3\ntекст|\[1\] СП 4\.13130\.2013, п\. 4\.3\nтекст/);
});
