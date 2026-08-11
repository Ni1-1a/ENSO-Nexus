'use strict';
/**
 * Провайдеры, тарифы, схемы строгого вывода и разбор документов.
 *
 * Тесты закрывают дефекты, найденные аудитом 2026-08-09: картинки, не доходившие
 * до ChatGPT/Kimi; ошибки облака под подписью «Локальный AI-сервер»; тихая
 * подмена неизвестного провайдера; недостижимые тарифы; кэширование СБОЯ
 * распознавания как содержимого документа.
 *
 * Ни одного обращения к настоящим моделям здесь нет: облачные провайдеры
 * подменяются локальным поддельным OpenAI-совместимым сервером, а маршрут
 * lmstudio в сетевых пробах не используется намеренно — он дёргает CLI `lms`
 * и менял бы состояние LM Studio владельца.
 */
const os = require('os');
const path = require('path');
const fs = require('fs');
const http = require('http');

process.env.DATA_DIR = path.join(os.tmpdir(), `pilot1-fixprov-${process.pid}`);
// Проверяются маршруты и разбор ответов, а не политика доступа к облаку:
// сессии здесь без хозяина, а таким облако закрыто (services/ai/cloud-access.js).
// Сама политика — в tests/cloud-access.test.js.
process.env.CLOUD_AI_OPEN = '1';

const { test, before, after } = require('node:test');
const assert = require('node:assert');

/* ---------------- поддельный OpenAI-совместимый сервер ---------------- */

let server = null;
let baseUrl = '';
/** Что отвечать на следующий запрос: {status} — ошибка, иначе обычный ответ. */
let scenario = { text: '{"ok":1}' };
/**
 * Отдельный сценарий для ЛОКАЛЬНОГО пути (/lm…): распознавание умеет падать на
 * выбранной модели и подхватываться локальной, и различить эти два ответа
 * одним общим сценарием нельзя. null — отвечать как всем.
 */
let scenarioLm = null;
let requests = [];

function startFakeServer() {
  return new Promise((resolve) => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(body); } catch { /* тело не JSON */ }
        requests.push({ url: req.url, auth: req.headers.authorization || '', body: parsed });
        const sc = req.url.startsWith('/lm') && scenarioLm ? scenarioLm : scenario;
        if (sc.status) {
          res.writeHead(sc.status, { 'Content-Type': 'application/json' });
          return res.end(sc.body !== undefined ? sc.body : JSON.stringify({ error: { message: sc.message || 'boom' } }));
        }
        const text = sc.text !== undefined ? sc.text : '{"ok":1}';
        const finish = sc.finish || 'stop';
        if (parsed && parsed.stream) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
          send({ choices: [{ delta: sc.reasoningOnly ? { reasoning_content: 'мысли' } : { content: text } }] });
          send({ choices: [{ delta: {}, finish_reason: finish }] });
          send({ usage: { prompt_tokens: 100, completion_tokens: 100 } });
          res.write('data: [DONE]\n\n');
          return res.end();
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          choices: [{ message: { content: text }, finish_reason: finish }],
          usage: { prompt_tokens: 100, completion_tokens: 100 },
        }));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
      resolve();
    });
  });
}

let adapter, db, now, pricing, registry, memory, docVision, validation, config;
const SID = 'fix-providers-session';

/**
 * Менеджер моделей запускает CLI `lms` и грузит модели в LM Studio владельца.
 * Тестам он не нужен и вреден: прогон выгружал бы чужие модели и ждал минуты.
 * Адрес локального сервера тоже намеренно отличается от облачных (другой путь) —
 * иначе адаптер принял бы облачный маршрут за LM Studio.
 */
function stubModelManager() {
  const p = require.resolve('../server/services/model-manager');
  require.cache[p] = {
    id: p, filename: p, loaded: true, exports: {
      ensureLoaded: async () => {}, acquireUse: () => {}, releaseUse: () => {},
      desiredContext: () => 32768, listLoaded: async () => [],
      feasibility: async () => ({ feasible: true, note: '' }),
    },
  };
}

before(async () => {
  await startFakeServer();
  // конфигурация читается один раз при загрузке модуля — задаём её до require
  process.env.OPENAI_BASE_URL = baseUrl;
  process.env.KIMI_BASE_URL = baseUrl;
  process.env.OLLAMA_BASE_URL = baseUrl;
  process.env.LOCAL_AI_BASE_URL = baseUrl.replace('/v1', '/lm'); // vision-путь doc-vision
  process.env.OPENAI_API_KEY = 'sk-test-fake-key';
  process.env.KIMI_API_KEY = 'sk-kimi-fake-key';
  process.env.ANTHROPIC_API_KEY = '';
  process.env.LOCAL_AI_TIMEOUT = '5000';

  stubModelManager();
  adapter = require('../server/services/claude/adapter');
  pricing = require('../server/services/pricing');
  registry = require('../server/services/ai/registry');
  memory = require('../server/services/claude/memory');
  docVision = require('../server/services/doc-vision');
  validation = require('../server/services/validation');
  config = require('../server/config');
  ({ db, now } = require('../server/db'));
});

after(() => { if (server) server.close(); });

function resetSession() {
  db.prepare('DELETE FROM events WHERE session_id = ?').run(SID);
  db.prepare('DELETE FROM files WHERE session_id = ?').run(SID);
  db.prepare('DELETE FROM sessions WHERE id = ?').run(SID);
  db.prepare('INSERT INTO sessions (id, token, status, created_at, updated_at) VALUES (?,?,?,?,?)')
    .run(SID, 'tok', 'idle', now(), now());
  requests = [];
}
const session = () => db.prepare('SELECT ai_requests, input_tokens, output_tokens FROM sessions WHERE id = ?').get(SID);
const chatRequests = () => requests.filter((r) => r.url.includes('chat/completions'));

/* ================= схемы строгого структурного вывода ================= */

/**
 * Рекурсивный обходчик строгого режима OpenAI-совместимых API.
 *
 * Прежний обходчик в tests/unit.test.js видел только узлы с литеральным
 * `type: 'object'` и не заходил ни в `anyOf`, ни в нуллабельные объекты
 * (`type: ['object','null']`), ни в `$defs`, и не знал про запрещённые в строгом
 * режиме ключевые слова. Пять заведомо невалидных схем он считал чистыми.
 *
 * Правила строгого режима:
 *  1) у каждого объекта `required` перечисляет ВСЕ ключи `properties`;
 *  2) `additionalProperties: false` обязателен;
 *  3) в `required` не может быть ключа, которого нет в `properties`;
 *  4) валидаторы значений (minLength, pattern, format, minimum, minItems…)
 *     не поддерживаются и приводят к отказу от схемы целиком.
 */
const FORBIDDEN_KEYWORDS = [
  'minLength', 'maxLength', 'pattern', 'format', 'minimum', 'maximum',
  'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf',
  'minItems', 'maxItems', 'uniqueItems', 'minProperties', 'maxProperties',
  'patternProperties', 'default', 'contains', 'if', 'then', 'else', 'not',
];

function strictViolations(schema, name = 'root') {
  const bad = [];
  const seen = new Set();

  const typesOf = (node) => (Array.isArray(node.type) ? node.type : node.type ? [node.type] : []);
  // объект узнаётся и по типу-массиву, и по одному наличию properties
  const looksLikeObject = (node) => typesOf(node).includes('object') || !!node.properties;

  const walk = (node, p) => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return;
    if (seen.has(node)) return; // защита от циклов через $defs
    seen.add(node);

    for (const kw of FORBIDDEN_KEYWORDS) {
      if (Object.prototype.hasOwnProperty.call(node, kw)) {
        bad.push(`${p}: ключевое слово «${kw}» не поддерживается строгим режимом`);
      }
    }

    if (looksLikeObject(node)) {
      const props = Object.keys(node.properties || {});
      const req = Array.isArray(node.required) ? node.required : [];
      const missing = props.filter((k) => !req.includes(k));
      if (missing.length) bad.push(`${p}: не в required — ${missing.join(', ')}`);
      const extra = req.filter((k) => !props.includes(k));
      if (extra.length) bad.push(`${p}: в required есть ключи без properties — ${extra.join(', ')}`);
      if (node.additionalProperties !== false) bad.push(`${p}: нет additionalProperties: false`);
      for (const k of props) walk(node.properties[k], `${p}.${k}`);
    }

    if (node.items) {
      if (Array.isArray(node.items)) node.items.forEach((it, i) => walk(it, `${p}[${i}]`));
      else walk(node.items, `${p}[]`);
    }
    for (const branch of ['anyOf', 'oneOf', 'allOf']) {
      if (Array.isArray(node[branch])) node[branch].forEach((b, i) => walk(b, `${p}.${branch}[${i}]`));
    }
    for (const bag of ['$defs', 'definitions']) {
      if (node[bag] && typeof node[bag] === 'object') {
        for (const k of Object.keys(node[bag])) walk(node[bag][k], `${p}.${bag}.${k}`);
      }
    }
  };
  walk(schema, name);
  return bad;
}

test('схемы: обходчик строгого режима ловит нарушения, которые прежний пропускал', () => {
  // A) объект без литерального type: 'object'
  assert.ok(strictViolations({ properties: { a: { type: 'string' } }, required: ['a'] }).length,
    'объект без type должен проверяться');
  // B) нуллабельный объект
  assert.ok(strictViolations({
    type: 'object', additionalProperties: false, required: ['x'],
    properties: { x: { type: ['object', 'null'], properties: { y: { type: 'string' } } } },
  }).length, 'нуллабельный объект должен обходиться');
  // C) ветка anyOf
  assert.ok(strictViolations({
    anyOf: [{ type: 'object', properties: { a: { type: 'string' } }, required: [], additionalProperties: false }],
  }).length, 'anyOf должен обходиться');
  // D) неподдерживаемые ключевые слова
  assert.ok(strictViolations({
    type: 'object', additionalProperties: false, required: ['a'],
    properties: { a: { type: 'string', minLength: 3, pattern: '^x' } },
  }).length >= 2, 'minLength и pattern должны отвергаться');
  // E) ключ в required без properties
  assert.match(strictViolations({
    type: 'object', additionalProperties: false, required: ['a', 'b'], properties: { a: { type: 'string' } },
  }).join(' '), /без properties/);
  // корректная схема нарушений не даёт
  assert.deepStrictEqual(strictViolations({
    type: 'object', additionalProperties: false, required: ['a', 'b'],
    properties: { a: { type: 'string' }, b: { type: ['integer', 'null'] } },
  }), []);
});

test('схемы: все схемы структурного вывода проекта проходят строгий режим', () => {
  const schemas = {
    RESPONSE_SCHEMA: require('../server/services/claude/schema').RESPONSE_SCHEMA,
    RULES_SCHEMA: require('../server/services/geometry/restriction-rules').RULES_SCHEMA,
  };
  for (const [name, schema] of Object.entries(schemas)) {
    assert.deepStrictEqual(strictViolations(schema, name), [],
      `${name} не пройдёт строгий структурный вывод — провайдер отвергнет её целиком`);
  }
});

/* ================= тарифы ================= */

/** Образец имени модели по регэкспу правила: ^ убираем, [.-] → «.», (a|b) → a. */
function sampleFor(re) {
  return re.source.replace(/^\^/, '').replace(/\[\.\-\]/g, '.').replace(/\(([^)|]+)(\|[^)]*)?\)/g, '$1');
}

test('тарифы: ни одно правило не перекрыто более общим выше по списку', () => {
  const overlaps = [];
  pricing.PRICES.forEach((rule, i) => {
    const s = sampleFor(rule.match);
    assert.ok(rule.match.test(s), `образец «${s}» не подходит своему правилу ${rule.match}`);
    const first = pricing.PRICES.findIndex((r) => r.match.test(s));
    if (first !== i) {
      overlaps.push(`#${i} ${rule.match} недостижимо: «${s}» перехватывает #${first} ${pricing.PRICES[first].match}`);
    }
  });
  assert.deepStrictEqual(overlaps, [], 'правило от частного к общему — иначе ценник врёт молча');
});

test('тарифы: семейство gpt-5.4 считается по своим ставкам, а не по общему gpt-5', () => {
  assert.deepStrictEqual(pricing.priceFor('gpt-5.4'), { input: 2.5, output: 15.0 });
  assert.deepStrictEqual(pricing.priceFor('gpt-5.4-nano'), { input: 0.2, output: 1.25 });
  assert.deepStrictEqual(pricing.priceFor('gpt-5.4-mini'), { input: 0.75, output: 4.5 });
  assert.deepStrictEqual(pricing.priceFor('gpt-5.4-pro'), { input: 30.0, output: 180.0 });
  assert.deepStrictEqual(pricing.priceFor('gpt-5'), { input: 1.25, output: 10.0 });
});

/* ================= картинки ================= */

test('картинки: модель со зрением получает image_url с data:URL, а не пометку', () => {
  const content = [
    { type: 'text', text: 'что на схеме?' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAB' } },
  ];
  for (const [provider, model] of [['chatgpt', 'gpt-5.6-terra'], ['kimi', 'kimi-k2.6'], ['lmstudio', 'qwen/qwen3-vl-30b']]) {
    assert.ok(registry.supports({ provider, model }, 'vision'), `${provider}/${model} обязан уметь зрение по реестру`);
    const out = adapter.toOpenAiContent(content, true);
    assert.ok(Array.isArray(out), 'содержимое обязано стать массивом частей');
    assert.strictEqual(out[0].type, 'text');
    assert.strictEqual(out[1].type, 'image_url');
    assert.strictEqual(out[1].image_url.url, 'data:image/png;base64,AAAB');
  }
});

test('картинки: текстовая модель получает честную пометку, а не молчание', () => {
  const out = adapter.toOpenAiContent([
    { type: 'text', text: 'что на схеме?' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAB' } },
  ], false);
  assert.strictEqual(typeof out, 'string');
  assert.match(out, /изображение не передано/);
  assert.ok(!out.includes('AAAB'), 'base64 в текст уходить не должен');
  // реестр обязан подтверждать, что зрения у текстовой локальной модели нет
  assert.strictEqual(registry.supports({ provider: 'lmstudio', model: 'qwen/qwen3-coder-30b' }, 'vision'), false);
});

test('картинки: изображение реально уходит в тело запроса ChatGPT', async () => {
  resetSession();
  scenario = { text: 'ответ' };
  await adapter.plainCall({
    system: 'сис', sessionId: SID, route: { provider: 'chatgpt', model: 'gpt-5.6-terra' },
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'что на схеме?' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAB' } },
      ],
    }],
  });
  const sent = chatRequests()[0].body.messages[1].content;
  assert.ok(Array.isArray(sent), 'в API ушёл плоский текст вместо частей');
  assert.strictEqual(sent.find((p) => p.type === 'image_url').image_url.url, 'data:image/png;base64,AAAB');
});

/* ================= ошибки провайдеров ================= */

test('ошибки: подпись — по фактическому провайдеру, а не «Локальный AI-сервер»', () => {
  const m = adapter.humanizeProviderError('chatgpt', 500, '{"error":{"message":"boom"}}');
  assert.match(m, /ChatGPT \(OpenAI\)/);
  assert.ok(!/Локальный AI-сервер/.test(m));
  assert.match(adapter.humanizeProviderError('kimi', 500, '{}'), /Kimi \(Moonshot AI\)/);
  assert.match(adapter.humanizeProviderError('gemini', 500, '{}'), /Gemini \(Google\)/);
  assert.match(adapter.humanizeProviderError('ollama', 500, '{}'), /Ollama/);
});

test('ошибки: 401, 402, 429 и 5xx звучат по-разному и советуют разное', () => {
  const auth = adapter.humanizeProviderError('chatgpt', 401, '{"error":{"message":"Incorrect API key"}}');
  assert.match(auth, /не принял ключ/);
  assert.match(auth, /OPENAI_API_KEY/);
  assert.match(auth, /Повтор не поможет/);

  const money = adapter.humanizeProviderError('kimi', 402, '{"error":{"message":"Insufficient balance"}}');
  assert.match(money, /средства|квота/);

  const rate = adapter.humanizeProviderError('chatgpt', 429, '{"error":{"message":"Rate limit reached"}}');
  assert.match(rate, /частоту запросов/);
  assert.match(rate, /Подождите/);

  const srv = adapter.humanizeProviderError('chatgpt', 503, '{}');
  assert.match(srv, /на его стороне/);

  // тексты обязаны отличаться друг от друга — иначе 401 не отличить от 500
  const all = [auth, money, rate, srv];
  assert.strictEqual(new Set(all).size, all.length);
});

test('ошибки: ключ провайдера не утекает в текст для человека', () => {
  const leak = 'Echo: Authorization: Bearer sk-proj-A1b2C3d4E5f6G7h8; key AIzaSyD-EXAMPLEKEY1234567';
  const msg = adapter.humanizeProviderError('chatgpt', 400, JSON.stringify({ error: { message: leak } }));
  assert.ok(!/sk-proj-A1b2/.test(msg), 'ключ OpenAI утёк в сообщение');
  assert.ok(!/AIzaSyD-EXAMPLEKEY/.test(msg), 'ключ Google утёк в сообщение');
  assert.match(msg, /ключ скрыт/);
});

test('ошибки: локальному серверу по-прежнему объясняют про память и выгрузку', () => {
  assert.match(adapter.humanizeProviderError('lmstudio', 400, '{"error":{"message":"Model was unloaded"}}'), /выгружена из памяти/);
  assert.match(adapter.humanizeProviderError('lmstudio', 400, '{"error":{"message":"insufficient system resources"}}'), /не хватает памяти/);
});

test('ошибки: живой 401 от провайдера доходит до пользователя разобранным', async () => {
  resetSession();
  scenario = { status: 401, message: 'Incorrect API key provided: sk-test-fake-key' };
  await assert.rejects(
    () => adapter.plainCall({ system: 'с', sessionId: SID, route: { provider: 'chatgpt', model: 'gpt-5.6-terra' }, messages: [{ role: 'user', content: 'привет' }] }),
    (err) => {
      assert.match(err.message, /ChatGPT \(OpenAI\) не принял ключ доступа \(401\)/);
      assert.ok(!/sk-test-fake-key/.test(err.message), 'ключ не должен возвращаться пользователю');
      return true;
    },
  );
  assert.strictEqual(chatRequests().length, 1, '401 не лечится повтором — лишних запросов быть не должно');
});

/* ================= подмена провайдера ================= */

test('маршрутизация: неизвестный провайдер — явная ошибка, запрос никуда не уходит', async () => {
  for (const provider of ['bogus', '', undefined]) {
    for (const call of ['plainCall', 'structuredCall']) {
      resetSession();
      scenario = { text: '{"ok":1}' };
      const args = {
        system: 'с', sessionId: SID, route: { provider, model: 'm' },
        messages: [{ role: 'user', content: 'привет' }],
        schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
      };
      await assert.rejects(() => adapter[call](args), /Неизвестный AI-провайдер/,
        `${call} с provider="${provider}" обязан падать, а не уходить в LM Studio`);
      assert.strictEqual(chatRequests().length, 0, 'ни одного запроса к модели быть не должно');
    }
  }
});

test('маршрутизация: неизвестный провайдер в анализе не уходит в Claude', async () => {
  resetSession();
  await assert.rejects(
    () => adapter.analyzeOnce(SID, { instruction: 'проанализируй', route: { provider: 'bogus', model: 'm' } }),
    (err) => {
      assert.match(err.message, /Неизвестный AI-провайдер «bogus»/);
      assert.ok(!/ANTHROPIC_API_KEY/.test(err.message), 'маршрут ушёл в ветку Claude');
      return true;
    },
  );
});

test('маршрутизация: демо-режим не грузит локальную модель втихую', async () => {
  resetSession();
  scenario = { text: 'ответ' };
  await assert.rejects(
    () => adapter.plainCall({ system: 'с', sessionId: SID, route: { provider: 'demo', model: 'demo' }, messages: [{ role: 'user', content: 'привет' }] }),
    /Демо-режим/,
  );
  assert.strictEqual(chatRequests().length, 0, 'демо-режим обещает «без AI» — запросов быть не может');
});

test('маршрутизация: известные провайдеры перечислены и совпадают с реестром', () => {
  for (const p of registry.listRegistry()) {
    assert.ok(adapter.ROUTABLE_PROVIDERS.has(p.id), `провайдер ${p.id} есть в реестре, но не маршрутизируется`);
  }
});

/* ================= бюджет запросов ================= */

test('бюджет: неудачный анализ тратит не больше четырёх обращений к модели', async () => {
  resetSession();
  scenario = { text: 'это не JSON', finish: 'length' }; // ответ обрезан и не проходит схему
  await assert.rejects(
    () => adapter.analyzeOnce(SID, { instruction: 'проанализируй', route: { provider: 'chatgpt', model: 'gpt-5.6-terra' } }),
    (err) => {
      assert.match(err.message, /Потрачено обращений к модели: 4 из 4/);
      return true;
    },
  );
  assert.strictEqual(chatRequests().length, adapter.MAX_ANALYSIS_CALLS,
    'раньше один неудачный анализ съедал 6 платных вызовов из 25 на сессию');
  assert.strictEqual(session().ai_requests, adapter.MAX_ANALYSIS_CALLS, 'каждый вызов обязан быть учтён в бюджете сессии');
});

test('бюджет: кэш-токены Anthropic попадают во входные токены сессии', () => {
  resetSession();
  adapter.recordUsage(SID, {
    input_tokens: 1000, output_tokens: 500,
    cache_creation_input_tokens: 4000, cache_read_input_tokens: 20000,
  }, { provider: 'claude', model: 'claude-opus-5' });
  const s = session();
  assert.strictEqual(s.input_tokens, 25000, 'кэш оплачивается — значит и в лимит токенов сессии входит');
  assert.strictEqual(s.output_tokens, 500);
});

/* ================= подсказки про .env ================= */

test('подсказки: переменная бюджета ответа зависит от провайдера', () => {
  assert.strictEqual(adapter.maxTokensEnv('kimi'), 'KIMI_MAX_TOKENS');
  assert.strictEqual(adapter.maxTokensEnv('chatgpt'), 'OPENAI_MAX_TOKENS');
  assert.strictEqual(adapter.maxTokensEnv('gemini'), 'GEMINI_MAX_TOKENS');
  assert.strictEqual(adapter.maxTokensEnv('claude'), 'ANTHROPIC_MAX_TOKENS');
  assert.strictEqual(adapter.maxTokensEnv('lmstudio'), 'LOCAL_AI_MAX_TOKENS');
});

test('подсказки: при обрыве на размышлениях облаку советуют его переменную', async () => {
  resetSession();
  scenario = { reasoningOnly: true, finish: 'length' };
  const reply = await adapter.chatOnce(SID, { text: 'привет', route: { provider: 'kimi', model: 'kimi-k3' } });
  assert.match(reply, /KIMI_MAX_TOKENS/);
  assert.ok(!/LOCAL_AI_MAX_TOKENS/.test(reply), 'совет про локальную переменную на облачном маршруте бесполезен');
});

/* ================= документы: обрезка, кодировка, форматы ================= */

test('документы: обрезанный текст помечен, а не обрывается молча', () => {
  const long = 'а'.repeat(1000);
  const out = memory.cut(long, 100);
  assert.match(out, /ОБРЕЗАН/);
  assert.match(out, /показано 100 из 1000 символов/);
  assert.strictEqual(memory.cut('короткий', 100), 'короткий', 'короткий текст пометки не получает');
});

test('документы: текст в Windows-1251 читается, а не превращается в кракозябры', () => {
  const cp1251 = Buffer.from([...'Площадь участка 1500 м2'].map((ch) => {
    const c = ch.codePointAt(0);
    if (c < 128) return c;
    if (c >= 0x410 && c <= 0x44f) return c - 0x410 + 0xc0;
    return 0x3f;
  }));
  const got = memory.decodeText(cp1251);
  assert.strictEqual(got.text, 'Площадь участка 1500 м2');
  assert.strictEqual(got.encoding, 'windows-1251');
  // UTF-8 и BOM не ломаются
  assert.strictEqual(memory.decodeText(Buffer.from('Площадь 1500 м2', 'utf8')).text, 'Площадь 1500 м2');
  assert.strictEqual(memory.decodeText(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('ГПЗУ', 'utf8')])).text, 'ГПЗУ');
});

test('документы: DOCX проверяется по содержимому, а не по двум байтам PK', () => {
  const fakeZip = Buffer.from('PK\x03\x04 это обычный zip, а не документ Word');
  assert.strictEqual(validation.checkMagic('docx', fakeZip).ok, false);
  assert.match(validation.checkMagic('docx', fakeZip).reason, /не является документом Word/);
  const xlsx = Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.from('xl/workbook.xml')]);
  assert.match(validation.checkMagic('docx', xlsx).reason, /Excel/);
  const docx = Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.from('word/document.xml')]);
  assert.strictEqual(validation.checkMagic('docx', docx).ok, true);
});

test('документы: файл с именем ровно «.txt» принимается, а не объявляется чужим форматом', () => {
  assert.strictEqual(validation.sanitizeFilename('.txt'), 'file.txt');
  assert.strictEqual(validation.sanitizeFilename('...txt'), 'file.txt');
  assert.strictEqual(validation.extOf(validation.sanitizeFilename('.txt')), 'txt');
  const check = validation.validateUpload(
    { originalName: validation.sanitizeFilename('.txt'), buffer: Buffer.from('участок 1500 м2') }, [],
  );
  assert.strictEqual(check.ok, true, '.txt — поддерживаемый формат, проблема была в имени');
  // скрытым файл при этом не становится
  assert.ok(!validation.sanitizeFilename('.env').startsWith('.'));
});

/* ================= документы: распознавание ================= */

const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

function addFile(name, ext, buf) {
  const dir = path.join(process.env.DATA_DIR, 'fixprov');
  fs.mkdirSync(dir, { recursive: true });
  const stored = path.join(dir, `${Math.random().toString(36).slice(2)}.${ext}`);
  fs.writeFileSync(stored, buf);
  db.prepare('INSERT INTO files (id, session_id, original_name, stored_path, size, ext, mime, created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(`f-${Math.random().toString(36).slice(2)}`, SID, name, stored, buf.length, ext, '', now());
  return stored;
}

test('распознавание: сбой vision НЕ кэшируется как содержимое документа', async () => {
  resetSession();
  const stored = addFile('Схема.png', 'png', PNG_1x1);
  scenario = { status: 500, message: 'fetch failed' };

  const first = await docVision.extractGraphics(SID, {});
  assert.strictEqual(first.pages, 0);
  assert.deepStrictEqual(first.failed, ['Схема.png']);
  assert.strictEqual(fs.existsSync(stored + '.vision.md'), false,
    'текст ошибки не имеет права стать «содержимым документа» навсегда');
  const ev = db.prepare("SELECT stage, detail FROM events WHERE session_id = ? AND level = 'warn'").all(SID);
  assert.ok(ev.some((e) => /Не удалось распознать файл/.test(e.stage)), 'журнал обязан знать о провале');

  // модель узнаёт, что картинка до неё не дошла
  const { blocks } = await memory.buildDocumentBlocks(SID, 'extracted');
  assert.match(blocks[0].text, /НЕ передано модели|НЕ учтено/);

  // vision-модель поднялась — распознавание повторяется само, файл переливать не надо
  scenario = { text: 'ГПЗУ, участок 1500 м2' };
  const second = await docVision.extractGraphics(SID, {});
  assert.strictEqual(second.pages, 1);
  assert.deepStrictEqual(second.failed, []);
  assert.ok(fs.existsSync(stored + '.vision.md'));

  // валидный кэш повторно не распознаётся
  const third = await docVision.extractGraphics(SID, {});
  assert.strictEqual(third.files, 0);

  const after = await memory.buildDocumentBlocks(SID, 'extracted');
  assert.match(after.blocks[0].text, /ГПЗУ, участок 1500 м2/);
  assert.ok(!/enso-vision/.test(after.blocks[0].text), 'служебная сводка кэша модели не нужна');
});

test('распознавание ведёт ВЫБРАННАЯ модель, а не локальная', async () => {
  resetSession();
  const stored = addFile('ГПЗУ.png', 'png', PNG_1x1);
  scenario = { text: 'ГПЗУ: участок 3700 м2' };
  scenarioLm = { status: 500, message: 'локальную модель звать было не за чем' };

  const res = await docVision.extractGraphics(SID, { route: { provider: 'chatgpt', model: 'gpt-5.6-sol' } });
  assert.strictEqual(res.pages, 1);
  assert.deepStrictEqual(res.by, ['chatgpt/gpt-5.6-sol'], 'скан обязан читать выбранный провайдер');
  assert.strictEqual(res.fellBack, false);

  const calls = chatRequests();
  assert.strictEqual(calls.length, 1);
  assert.ok(calls[0].url.startsWith('/v1'), `страница ушла не туда: ${calls[0].url}`);
  assert.strictEqual(calls[0].body.model, 'gpt-5.6-sol');
  // картинка уходит НАСТОЯЩЕЙ частью image_url, а не пометкой «изображение не передано»
  const parts = calls[0].body.messages[1].content;
  assert.ok(Array.isArray(parts) && parts.some((p) => p.type === 'image_url'), 'страница обязана дойти картинкой');

  assert.match(fs.readFileSync(stored + '.vision.md', 'utf8'), /ГПЗУ: участок 3700 м2/);
  scenarioLm = null;
});

test('распознавание: служебные запросы не выбирают лимит проекта', async () => {
  resetSession();
  addFile('ГПЗУ.png', 'png', PNG_1x1);
  scenario = { text: 'ГПЗУ' };

  await docVision.extractGraphics(SID, { route: { provider: 'chatgpt', model: 'gpt-5.6-sol' } });

  const s = db.prepare('SELECT ai_requests, ai_subrequests, input_tokens, cost_usd FROM sessions WHERE id = ?').get(SID);
  // предохранитель заводился против бесконечного цикла, а не против собственных
  // документов проекта: скан на 17 страниц выбирал лимит в 25 штук до начала анализа
  assert.strictEqual(s.ai_requests, 0, 'страница документа — не запрос человека');
  assert.strictEqual(s.ai_subrequests, 1, 'но и потеряться служебный запрос не имеет права');
  assert.ok(s.input_tokens > 0, 'токены считаются как у любого другого запроса');
  assert.ok(s.cost_usd > 0, 'деньги тоже: распознавание облаком платное');
});

test('распознавание: локальная модель подключается, когда выбранная слепая', async () => {
  resetSession();
  addFile('Схема.png', 'png', PNG_1x1);
  scenario = { text: 'схема планировочной организации' };

  // текстовая локальная модель зрения не умеет — распознаёт vision-модель из LOCAL_AI_OCR_MODEL
  const res = await docVision.extractGraphics(SID, { route: { provider: 'lmstudio', model: 'qwen/qwen3-coder-30b' } });
  assert.strictEqual(res.pages, 1);
  assert.deepStrictEqual(res.by, [`lmstudio/${config.localAiOcrModel}`]);

  const calls = chatRequests();
  assert.strictEqual(calls.length, 1);
  assert.ok(calls[0].url.startsWith('/lm'), `распознавать должна была локальная модель: ${calls[0].url}`);
  assert.strictEqual(calls[0].body.model, config.localAiOcrModel);
});

test('распознавание: отказ выбранной модели подхватывает локальная, и это видно', async () => {
  resetSession();
  const stored = addFile('ГПЗУ.png', 'png', PNG_1x1);
  scenario = { status: 500, message: 'облако недоступно' };
  scenarioLm = { text: 'распознано локально: участок 3700 м2' };

  const res = await docVision.extractGraphics(SID, { route: { provider: 'chatgpt', model: 'gpt-5.6-sol' } });
  assert.strictEqual(res.pages, 1, 'страница обязана быть распознана несмотря на отказ облака');
  assert.strictEqual(res.fellBack, true);
  assert.deepStrictEqual(res.by, [`lmstudio/${config.localAiOcrModel}`]);

  const calls = chatRequests();
  assert.ok(calls[0].url.startsWith('/v1'), 'сначала пробуем выбранную модель');
  assert.ok(calls[1].url.startsWith('/lm'), 'и только потом локальную');

  const md = fs.readFileSync(stored + '.vision.md', 'utf8');
  assert.match(md, /распознано локально: участок 3700 м2/);
  // подмена распознавателя не имеет права быть незаметной
  assert.match(md, /локальная модель/);
  scenarioLm = null;
});

test('распознавание: исчерпанный бюджет останавливает, а не уводит в локальную модель', async () => {
  resetSession();
  addFile('ГПЗУ.png', 'png', PNG_1x1);
  db.prepare('UPDATE sessions SET ai_requests = ? WHERE id = ?').run(config.maxAiRequestsPerSession, SID);
  scenario = { text: 'не должно быть запрошено' };
  scenarioLm = { text: 'локальная тоже не должна' };

  await assert.rejects(
    () => docVision.extractGraphics(SID, { route: { provider: 'chatgpt', model: 'gpt-5.6-sol' } }),
    (err) => err instanceof adapter.BudgetExceededError,
    'лимит проекта — это стоп, а не повод распознавать бесплатно и молча',
  );
  assert.strictEqual(chatRequests().length, 0, 'ни одного оплачиваемого запроса сверх лимита');
  scenarioLm = null;
});

test('распознавание: решение «скан или текст» принимается по странице, а не по файлу', () => {
  // реальный случай: у ТЗ на 22 страницы текстовый слой есть везде, кроме 1 и 22
  const pages = ['', 'текст '.repeat(200), 'текст '.repeat(200), '   \n  '];
  assert.deepStrictEqual(docVision.pagesNeedingOcr(pages), [1, 4]);
  // файл целиком текстовый — распознавать нечего
  assert.deepStrictEqual(docVision.pagesNeedingOcr(['текст '.repeat(200), 'текст '.repeat(200)]), []);
  // файл целиком скан
  assert.deepStrictEqual(docVision.pagesNeedingOcr(['', '', '']), [1, 2, 3]);
});

test('распознавание: кэш с несостоявшимися страницами обновляется, целый — нет', () => {
  const dir = path.join(process.env.DATA_DIR, 'fixprov');
  fs.mkdirSync(dir, { recursive: true });
  const f = { stored_path: path.join(dir, `cache-${Math.random().toString(36).slice(2)}`) };

  fs.writeFileSync(f.stored_path + '.vision.md',
    '<!-- страница 1 -->\nтекст\n<!--enso-vision:{"complete":true,"failed":[]}-->');
  assert.strictEqual(docVision.cacheNeedsWork(docVision.readVisionCache(f)), false);

  fs.writeFileSync(f.stored_path + '.vision.md',
    '<!-- страница 1 -->\nтекст\n<!--enso-vision:{"complete":false,"failed":[2]}-->');
  assert.strictEqual(docVision.cacheNeedsWork(docVision.readVisionCache(f)), true);

  // кэш старого образца с осевшим текстом ошибки тоже подлежит перезаписи
  fs.writeFileSync(f.stored_path + '.vision.md', '(страница 1 не распозналась: fetch failed)');
  assert.strictEqual(docVision.cacheNeedsWork(docVision.readVisionCache(f)), true);

  fs.rmSync(f.stored_path + '.vision.md', { force: true });
  assert.strictEqual(docVision.cacheNeedsWork(docVision.readVisionCache(f)), true);
});

test('документы: файл сверх потолка вложения не исчезает молча', async () => {
  resetSession();
  // Картинка заведомо нечитаемого формата: путь уменьшения (headless-браузер)
  // в тесте не поднимаем, проверяем главное — файл не пропал из контекста.
  addFile('Огромный_скан.png', 'png', Buffer.alloc(6 * 1024 * 1024, 0xff));
  const { blocks, manifest } = await memory.buildDocumentBlocks(SID, 'native');
  assert.strictEqual(manifest.length, 1);
  assert.ok(blocks.length >= 1, 'раньше файл был только в манифесте — модель о нём не знала');
  const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  assert.match(text, /Огромный_скан\.png/);
  assert.match(text, /больше потолка вложения/);
  assert.match(text, /НЕ учтено/);
});

test('документы: размер картинки читается из заголовка — для уменьшения без сторонних библиотек', () => {
  assert.deepStrictEqual(memory.imageSize(PNG_1x1), { width: 1, height: 1 });
  // JPEG: SOI + APP0 + SOF0 с размерами 40×30
  const jpeg = Buffer.from([
    0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x1e, 0x00, 0x28,
    0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
  ]);
  assert.deepStrictEqual(memory.imageSize(jpeg), { width: 40, height: 30 });
  assert.strictEqual(memory.imageSize(Buffer.alloc(64, 0xff)), null);
});

/* ------------------------------------------------------------------------- *
 * Схемы для локальных движков: LM Studio и Ollama строят из схемы грамматику
 * и союз типов не понимают. Проверено вживую на qwen3-coder-30b 2026-08-09:
 * `{"type":["integer","null"]}` → HTTP 400 «ValueError: 'type' must be a
 * string», а человек видит «Модель вернула некорректный ответ».
 * ------------------------------------------------------------------------- */

test('схемы: союз типов переписывается в anyOf — иначе локальная модель отвергает схему целиком', () => {
  const { unionTypesToAnyOf, isLocalGrammarEngine } = require('../server/services/claude/adapter');
  const { RESPONSE_SCHEMA } = require('../server/services/claude/schema');
  const { RULES_SCHEMA } = require('../server/services/geometry/restriction-rules');

  assert.ok(isLocalGrammarEngine('lmstudio'), 'LM Studio — локальный движок грамматик');
  assert.ok(isLocalGrammarEngine('ollama'), 'Ollama — локальный движок грамматик');
  assert.ok(!isLocalGrammarEngine('chatgpt'), 'ChatGPT союз типов принимает, переписывать нечего');
  assert.ok(!isLocalGrammarEngine('kimi'), 'Kimi союз типов принимает');

  const unions = (node, found = []) => {
    if (Array.isArray(node)) { for (const n of node) unions(n, found); return found; }
    if (!node || typeof node !== 'object') return found;
    if (Array.isArray(node.type)) found.push(node.type.join('|'));
    for (const v of Object.values(node)) unions(v, found);
    return found;
  };

  for (const [name, schema] of [['RESPONSE_SCHEMA', RESPONSE_SCHEMA], ['RULES_SCHEMA', RULES_SCHEMA]]) {
    const out = unionTypesToAnyOf(schema);
    assert.strictEqual(unions(out).length, 0, `${name}: после переписывания союзов типов не остаётся`);
    assert.deepStrictEqual(unions(schema).length > 0, name === 'RESPONSE_SCHEMA',
      `${name}: исходная схема — та, ради которой переписывание и сделано`);
  }

  const src = { type: 'object', additionalProperties: false, required: ['a', 'b'],
    properties: { a: { type: ['integer', 'null'] }, b: { type: 'string' } } };
  const out = unionTypesToAnyOf(src);
  assert.deepStrictEqual(out.properties.a, { anyOf: [{ type: 'integer' }, { type: 'null' }] },
    'необязательное поле выражается anyOf');
  assert.deepStrictEqual(out.properties.b, { type: 'string' }, 'обычный тип не трогается');
  assert.deepStrictEqual(out.required, ['a', 'b'], 'строгий режим требует все ключи в required');
  assert.deepStrictEqual(src.properties.a, { type: ['integer', 'null'] }, 'исходная схема не портится');
});
