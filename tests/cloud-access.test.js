'use strict';
/**
 * Доступ к облачным моделям и пометка конечного пользователя.
 *
 * Что здесь закрывается. Условия OpenAI, Anthropic и Google запрещают не только
 * пользоваться сервисом из неподдерживаемого региона, но и ОТКРЫВАТЬ к нему
 * доступ другим людям. Платформа отдаёт один ключ на всех вошедших — за это
 * аккаунт OpenAI деактивировали 2026-08-10. Поэтому:
 *  - облако доступно только людям с `"cloudAi": true` в users.json;
 *  - запрет стоит НА ДНЕ адаптера, а не только в интерфейсе: выбор провайдера
 *    хранится в сессии и переживает смену правил, а `provider` подставляется
 *    клиентом в тело запроса;
 *  - каждый запрос к OpenAI помечен `safety_identifier`, к Anthropic —
 *    `metadata.user_id`, чтобы срабатывание политики привязывалось к человеку,
 *    а не ко всей организации;
 *  - в идентификатор не уходят ни ФИО, ни идентификатор человека в открытом виде.
 *
 * Настоящие модели не вызываются: облачные адреса указывают на поддельный
 * OpenAI-совместимый сервер, поднятый здесь же.
 */
const os = require('os');
const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');

process.env.DATA_DIR = path.join(os.tmpdir(), `pilot1-cloudacc-${process.pid}`);
process.env.USERS_FILE = path.join(os.tmpdir(), `pilot1-cloudacc-users-${process.pid}.json`);
process.env.ANTHROPIC_API_KEY = '';
process.env.LOCAL_AI_TIMEOUT = '5000';
// политика включена: именно она здесь и проверяется
delete process.env.CLOUD_AI_OPEN;

const { test, before, after } = require('node:test');
const assert = require('node:assert');

let server = null;
let baseUrl = '';
let requests = [];

function startFakeServer() {
  return new Promise((resolve) => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(body); } catch { /* тело не JSON */ }
        requests.push({ url: req.url, body: parsed, auth: req.headers.authorization || '' });
        // обмен ключа GigaChat: OAuth-точка отвечает токеном, а не completions
        if (req.url.includes('/oauth')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ access_token: 'giga-test-token', expires_at: Date.now() + 1800000 }));
        }
        // адаптер по умолчанию просит стриминг — отвечаем тем же, иначе текст
        // приходит пустым и тест ловит не то, что проверяет
        if (parsed && parsed.stream) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
          send({ choices: [{ delta: { content: 'ответ' } }] });
          send({ choices: [{ delta: {}, finish_reason: 'stop' }] });
          send({ usage: { prompt_tokens: 10, completion_tokens: 10 } });
          res.write('data: [DONE]\n\n');
          return res.end();
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          choices: [{ message: { content: 'ответ' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 10 },
        }));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
      resolve();
    });
  });
}

/** Менеджер моделей запускает CLI `lms` и трогает LM Studio владельца — не здесь. */
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

let adapter, users, cloudAccess, providers, db, now;

/** Человек в users.json с нужным флагом; возвращает его id. */
function makeUser(lastName, firstName, cloudAi) {
  const res = users.enter({ lastName, firstName });
  assert.strictEqual(res.status, 'active', 'человек должен войти свободной регистрацией');
  const store = JSON.parse(fs.readFileSync(process.env.USERS_FILE, 'utf8'));
  const rec = store.users.find((u) => u.id === res.user.id);
  rec.cloudAi = cloudAi;
  fs.writeFileSync(process.env.USERS_FILE, JSON.stringify(store, null, 2));
  return res.user.id;
}

/** Проект, принадлежащий человеку (или ничей, если userId пустой). */
function makeSession(userId) {
  const id = `cloud-${crypto.randomBytes(6).toString('hex')}`;
  db.prepare('INSERT INTO sessions (id, token, user_id, status, created_at, updated_at) VALUES (?,?,?,?,?,?)')
    .run(id, 'tok', userId || '', 'idle', now(), now());
  return id;
}

before(async () => {
  await startFakeServer();
  process.env.OPENAI_BASE_URL = baseUrl;
  process.env.KIMI_BASE_URL = baseUrl;
  process.env.OPENAI_API_KEY = 'sk-test-fake-key';
  process.env.KIMI_API_KEY = 'sk-kimi-fake-key';
  // российские облака ходят на тот же поддельный сервер; OAuth Сбера — на /oauth
  process.env.GIGACHAT_AUTH_KEY = 'giga-fake-auth-key';
  process.env.GIGACHAT_BASE_URL = baseUrl;
  process.env.GIGACHAT_OAUTH_URL = baseUrl.replace('/v1', '/oauth');
  process.env.YANDEX_API_KEY = 'ya-fake-key';
  process.env.YANDEX_FOLDER_ID = 'b1g-test-folder';
  process.env.YANDEX_BASE_URL = baseUrl;
  process.env.LOCAL_AI_BASE_URL = baseUrl.replace('/v1', '/lm');

  stubModelManager();
  adapter = require('../server/services/claude/adapter');
  users = require('../server/services/users');
  cloudAccess = require('../server/services/ai/cloud-access');
  providers = require('../server/services/providers');
  ({ db, now } = require('../server/db'));
});

after(() => {
  if (server) server.close();
  fs.rmSync(process.env.USERS_FILE, { force: true });
});

/* ================= сам запрет ================= */

test('облако закрыто человеку без cloudAi — и запрос никуда не уходит', async () => {
  const sid = makeSession(makeUser('Тестов', 'Пётр', false));
  requests = [];
  for (const provider of ['chatgpt', 'kimi']) {
    await assert.rejects(
      () => adapter.plainCall({
        system: 'с', sessionId: sid, route: { provider, model: 'gpt-5.6-terra' },
        messages: [{ role: 'user', content: 'привет' }],
      }),
      (err) => {
        assert.ok(err instanceof adapter.AiUnavailableError, 'отказ обязан быть понятной ошибкой, а не 500');
        assert.match(err.message, /только владельцу/);
        return true;
      },
      `${provider} обязан быть закрыт человеку без разрешения`,
    );
  }
  assert.strictEqual(requests.length, 0, 'ни одного обращения к облаку быть не должно');
});

test('облако открыто человеку с cloudAi', async () => {
  const sid = makeSession(makeUser('Владельцев', 'Никита', true));
  requests = [];
  const out = await adapter.plainCall({
    system: 'с', sessionId: sid, route: { provider: 'chatgpt', model: 'gpt-5.6-terra' },
    messages: [{ role: 'user', content: 'привет' }],
  });
  assert.strictEqual(out.text, 'ответ');
  assert.strictEqual(requests.length, 1, 'разрешённый человек обязан дойти до модели');
});

test('проект без хозяина облако не получает: с его токеном работает кто угодно', async () => {
  const sid = makeSession('');
  requests = [];
  await assert.rejects(
    () => adapter.plainCall({
      system: 'с', sessionId: sid, route: { provider: 'chatgpt', model: 'gpt-5.6-terra' },
      messages: [{ role: 'user', content: 'привет' }],
    }),
    /только владельцу/,
  );
  assert.strictEqual(requests.length, 0);
});

test('локальные модели остаются доступны всем — иначе платформа перестаёт работать', async () => {
  const sid = makeSession(makeUser('Локалев', 'Иван', false));
  requests = [];
  const out = await adapter.plainCall({
    system: 'с', sessionId: sid, route: { provider: 'lmstudio', model: 'qwen/qwen3-coder-30b' },
    messages: [{ role: 'user', content: 'привет' }],
  });
  assert.strictEqual(out.text, 'ответ');
  assert.strictEqual(requests.length, 1, 'локальная модель обязана работать без всяких разрешений');
});

test('запрет действует и на структурный вызов, и на анализ — не только на чат', async () => {
  const sid = makeSession(makeUser('Схемов', 'Олег', false));
  requests = [];
  const schema = { type: 'object', properties: {}, required: [], additionalProperties: false };
  await assert.rejects(
    () => adapter.structuredCall({
      system: 'с', sessionId: sid, route: { provider: 'chatgpt', model: 'gpt-5.6-terra' },
      messages: [{ role: 'user', content: 'привет' }], schema,
    }),
    /только владельцу/,
  );
  await assert.rejects(
    () => adapter.analyzeOnce(sid, { instruction: 'разбери', route: { provider: 'chatgpt', model: 'gpt-5.6-terra' } }),
    /только владельцу/,
  );
  assert.strictEqual(requests.length, 0, 'ни один путь к модели не имеет права обойти запрет');
});

test('маршрут по умолчанию не уводит закрытого человека в облако', () => {
  const denied = makeSession(makeUser('Умолчаний', 'Павел', false));
  const allowed = makeSession(makeUser('Разрешённый', 'Артём', true));
  const row = (id) => db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
  // сессия без явного выбора: config.aiMode здесь не 'live' (ключа Anthropic нет),
  // но проверяем главное — облачного умолчания у закрытого человека не бывает
  assert.strictEqual(cloudAccess.allowedForSession(denied), false);
  assert.strictEqual(cloudAccess.allowedForSession(allowed), true);
  assert.ok(!cloudAccess.isCloud(adapter.effectiveProvider(row(denied)).provider),
    'человеку без разрешения умолчание обязано быть локальным');
});

/* ================= пикер ================= */

test('пикер: облачные провайдеры помечены недоступными для закрытого человека', async () => {
  const closed = { id: 'u1', approved: true, cloudAi: false };
  const open = { id: 'u2', approved: true, cloudAi: true };
  const forOpen = await providers.listProvidersFor(open);
  const forClosed = await providers.listProvidersFor(closed);
  for (const p of forClosed) {
    if (cloudAccess.isCloud(p.id)) {
      assert.strictEqual(p.available, false, `${p.id} не имеет права быть доступным`);
      // сначала ключ, потом доступ: у провайдера без ключа на сервере пометка
      // «нужен ключ» (он закрыт всем), у остальных — «только по отметке»
      const keyed = forOpen.find((x) => x.id === p.id).available;
      if (keyed) assert.strictEqual(p.note, providers.cloudClosedNote());
      else assert.match(p.note, /нужен .*на сервере/, `${p.id}: ${p.note}`);
    }
  }
  assert.match(forClosed.find((p) => p.id === 'claude').note, /ANTHROPIC_API_KEY/, 'без ключа причина — ключ, а не отметка');
  const lm = forClosed.find((p) => p.id === 'lmstudio');
  assert.ok(lm, 'локальный провайдер обязан остаться в списке');

  const gpt = forOpen.find((p) => p.id === 'chatgpt');
  assert.strictEqual(gpt.available, true, 'владельцу список не режется');

  // аноним (ручка /health отвечает и без токена) облака не видит
  const forAnon = await providers.listProvidersFor(null);
  assert.strictEqual(forAnon.find((p) => p.id === 'chatgpt').available, false);
});

test('пикер: выбор облачного провайдера отклоняется на сервере, а не только в интерфейсе', async () => {
  const closed = { id: 'u1', approved: true, cloudAi: false };
  const check = await providers.validateChoice('chatgpt', 'gpt-5.6-terra', closed);
  assert.strictEqual(check.ok, false);
  assert.match(check.error, /только владельцу/);
  const okCheck = await providers.validateChoice('chatgpt', 'gpt-5.6-terra', { id: 'u2', approved: true, cloudAi: true });
  assert.strictEqual(okCheck.ok, true);
});

/* ================= пометка конечного пользователя ================= */

test('safety_identifier уходит в тело запроса к OpenAI и не содержит ничего личного', async () => {
  const userId = makeUser('Помеченный', 'Сергей', true);
  const sid = makeSession(userId);
  requests = [];
  await adapter.plainCall({
    system: 'с', sessionId: sid, route: { provider: 'chatgpt', model: 'gpt-5.6-terra' },
    messages: [{ role: 'user', content: 'привет' }],
  });
  const sent = requests[0].body;
  assert.ok(sent.safety_identifier, 'запрос к OpenAI обязан называть конечного пользователя');
  assert.match(sent.safety_identifier, /^enso-[0-9a-f]{24}$/);
  const raw = JSON.stringify(sent);
  assert.ok(!raw.includes('Помеченный'), 'ФИО не имеет права уходить провайдеру');
  assert.ok(!raw.includes(userId), 'идентификатор человека уходит только хэшем');
});

test('идентификатор стабилен для человека и различает разных людей', () => {
  const a = makeUser('Первый', 'Иван', true);
  const b = makeUser('Второй', 'Пётр', true);
  const a1 = makeSession(a);
  const a2 = makeSession(a);
  const b1 = makeSession(b);
  assert.strictEqual(cloudAccess.safetyIdentifier(a1), cloudAccess.safetyIdentifier(a2),
    'у одного человека разные проекты — один идентификатор');
  assert.notStrictEqual(cloudAccess.safetyIdentifier(a1), cloudAccess.safetyIdentifier(b1),
    'разные люди обязаны различаться');
  assert.strictEqual(cloudAccess.safetyIdentifier(''), '', 'без проекта идентификатора нет');
});

test('Kimi и локальные модели поля safety_identifier не получают — его нет в их контракте', async () => {
  const sid = makeSession(makeUser('Кимов', 'Роман', true));
  requests = [];
  await adapter.plainCall({
    system: 'с', sessionId: sid, route: { provider: 'kimi', model: 'kimi-k2.6' },
    messages: [{ role: 'user', content: 'привет' }],
  });
  await adapter.plainCall({
    system: 'с', sessionId: sid, route: { provider: 'lmstudio', model: 'qwen/qwen3-coder-30b' },
    messages: [{ role: 'user', content: 'привет' }],
  });
  assert.strictEqual(requests.length, 2);
  for (const r of requests) {
    assert.strictEqual(r.body.safety_identifier, undefined,
      'неизвестное поле в чужом контракте — повод для 400 на ровном месте');
  }
});

/* ================= выключатель ================= */

test('CLOUD_AI_OPEN=1 возвращает прежнее поведение целиком', () => {
  const config = require('../server/config');
  const sid = makeSession(makeUser('Закрытов', 'Глеб', false));
  assert.strictEqual(cloudAccess.allowedForSession(sid), false);
  config.cloudAiOpen = true;
  try {
    assert.strictEqual(cloudAccess.allowedForSession(sid), true, 'выключатель обязан открывать облако всем');
    assert.strictEqual(cloudAccess.userAllowed(null), true);
  } finally {
    config.cloudAiOpen = false;
  }
  assert.strictEqual(cloudAccess.allowedForSession(sid), false, 'и возвращать запрет обратно');
});

/* ================= доступ по каждому провайдеру отдельно ================= */

/*
 * Решение владельца 2026-08-20: «Kimi всем, остальные только мне». Гейт
 * `cloudAi` — всё или ничего, поэтому появился белый список
 * CLOUD_AI_OPEN_PROVIDERS. Здесь закрывается главное: открытие ОДНОГО сервиса
 * не должно приоткрывать соседние, и на дне адаптера правило то же, что в пикере.
 */
function сОткрытымKimi(fn) {
  const config = require('../server/config');
  const было = config.cloudAiOpenProviders;
  config.cloudAiOpenProviders = new Set(['kimi']);
  try { return fn(); } finally { config.cloudAiOpenProviders = было; }
}

test('открытый Kimi доступен всем вошедшим, остальное облако — только владельцу', () => {
  const сотрудник = makeUser('Открытов', 'Пётр', false);
  const владелец = makeUser('Владельцев', 'Иван', true);
  сОткрытымKimi(() => {
    const u = require('../server/services/users');
    assert.strictEqual(cloudAccess.userAllowed(u.byId(сотрудник), 'kimi'), true, 'Kimi открыт всем');
    assert.strictEqual(cloudAccess.userAllowed(u.byId(сотрудник), 'claude'), false, 'Claude остаётся владельцу');
    assert.strictEqual(cloudAccess.userAllowed(u.byId(сотрудник), 'gemini'), false);
    assert.strictEqual(cloudAccess.userAllowed(u.byId(владелец), 'claude'), true, 'у владельца доступ ко всему');
  });
});

test('открытие одного провайдера не открывает соседние на дне адаптера', async () => {
  const sid = makeSession(makeUser('Соседов', 'Кирилл', false));
  await сОткрытымKimi(async () => {
    // Kimi проходит
    requests = [];
    await adapter.plainCall({
      system: 'с', sessionId: sid, route: { provider: 'kimi', model: 'kimi-k2.6' },
      messages: [{ role: 'user', content: 'привет' }],
    });
    assert.strictEqual(requests.length, 1, 'Kimi обязан дойти до провайдера');

    // ChatGPT — нет, и отказ приходит ДО обращения к сети.
    // Провайдер взят настроенный: у Claude в тестовой среде нет ключа, и он
    // отказал бы раньше гейта — тест проверял бы не то, что заявлено.
    requests = [];
    await assert.rejects(
      adapter.plainCall({
        system: 'с', sessionId: sid, route: { provider: 'chatgpt', model: 'gpt-5.6-terra' },
        messages: [{ role: 'user', content: 'привет' }],
      }),
      (err) => /только владельцу/.test(err.message),
      'ChatGPT обязан отказать человеку без отметки',
    );
    assert.strictEqual(requests.length, 0, 'до провайдера запрос доходить не должен');
  });
});

test('в отказе названо, чем можно воспользоваться вместо', () => {
  сОткрытымKimi(() => {
    const текст = cloudAccess.denyMessage('claude');
    assert.match(текст, /Claude/, 'человек должен понять, какой именно модели ему отказали');
    assert.match(текст, /Kimi/, 'и увидеть открытую замену, а не только запрет');
    assert.match(текст, /локальную модель/);
  });
});

/*
 * Западная тройка в «доступны всем» не бывает (OWNER_ONLY), что бы ни стояло в
 * CLOUD_AI_OPEN_PROVIDERS: на VPS список перечислял все шесть, и отказ по Claude
 * советовал «выберите Claude — доступен всем». Пометка пикера тоже называет
 * открытых, когда они есть.
 */
test('отказ и пометка пикера не называют западную тройку открытой всем', async () => {
  const config = require('../server/config');
  const было = config.cloudAiOpenProviders;
  config.cloudAiOpenProviders = new Set(['claude', 'kimi']);
  try {
    const текст = cloudAccess.denyMessage('claude');
    assert.match(текст, /^Claude на этой платформе/, 'название отказанной модели — в начале');
    assert.ok(!/Выберите[^.]*Claude/.test(текст), `Claude предложен как замена: ${текст}`);
    assert.match(текст, /Выберите[^.]*Kimi/, 'Kimi открыт списком — он и есть замена');
    assert.deepStrictEqual(cloudAccess.openProviders(), ['kimi']);
    const note = providers.cloudClosedNote();
    assert.match(note, /Kimi/);
    assert.match(note, /открыт всем/);
    assert.ok(!note.includes('Claude'));
    // без открытых — прежняя короткая пометка
    config.cloudAiOpenProviders = new Set(['claude']);
    assert.strictEqual(providers.cloudClosedNote(), providers.CLOUD_CLOSED_NOTE);
    assert.match(cloudAccess.denyMessage('gemini'), /локальную модель — она доступна всем/);
  } finally {
    config.cloudAiOpenProviders = было;
  }
});

/*
 * Решение владельца 02.09.2026: западную тройку списком открыть нельзя вовсе.
 * На VPS CLOUD_AI_OPEN_PROVIDERS перечислял все шесть провайдеров, и отметка
 * cloudAi у людей ничего не решала — Claude, ChatGPT и Gemini тратил любой
 * вошедший. Теперь список действует только на Kimi, GigaChat и YandexGPT.
 */
test('западная тройка не открывается списком — только отметкой cloudAi или владельцу', () => {
  const config = require('../server/config');
  const было = config.cloudAiOpenProviders;
  config.cloudAiOpenProviders = new Set(['claude', 'chatgpt', 'gemini', 'kimi', 'gigachat', 'yandexgpt']);
  try {
    const u = require('../server/services/users');
    const сотрудник = makeUser('Списочный', 'Артём', false);
    const отмеченный = makeUser('Отмеченный', 'Глеб', true);
    for (const p of ['claude', 'chatgpt', 'gemini']) {
      assert.strictEqual(cloudAccess.openToEveryone(p), false, `${p} списком не открывается`);
      assert.strictEqual(cloudAccess.userAllowed(u.byId(сотрудник), p), false, `${p} закрыт без отметки`);
      assert.strictEqual(cloudAccess.userAllowed(u.byId(отмеченный), p), true, `${p} открыт по отметке`);
    }
    for (const p of ['kimi', 'gigachat', 'yandexgpt']) {
      assert.strictEqual(cloudAccess.userAllowed(u.byId(сотрудник), p), true, `${p} по списку открыт всем`);
    }
    // владелец платформы — без отметки
    assert.strictEqual(cloudAccess.userAllowed({ id: 'o', approved: true, owner: true }, 'claude'), true);
  } finally { config.cloudAiOpenProviders = было; }
});

test('пустой список не открывает никого', () => {
  const config = require('../server/config');
  const было = config.cloudAiOpenProviders;
  config.cloudAiOpenProviders = new Set();
  try {
    const u = require('../server/services/users');
    const сотрудник = makeUser('Забытов', 'Семён', false);
    assert.strictEqual(cloudAccess.userAllowed(u.byId(сотрудник), 'kimi'), false,
      'забытая переменная обязана означать «никому», а не «всем»');
  } finally { config.cloudAiOpenProviders = было; }
});

/* ================= облако живёт только на одном имени платформы ================= */

/*
 * У платформы два адреса: `.com` и `.ru`. Решение владельца — облачные модели
 * предлагать только на `.com`. Проверяется то же, что и у остальных запретов:
 * что он стоит на ДНЕ адаптера, а не только в пикере, и что забытая переменная
 * означает «ограничения нет», а не «выключить облако везде».
 */
async function наИмени(имена, fn) {
  const config = require('../server/config');
  const было = config.cloudAiHosts;
  config.cloudAiHosts = new Set(имена);
  // именно await, а не return: без него finally возвращает список на место
  // раньше, чем колбэк дойдёт до первой проверки, и тест меряет не то
  try { return await fn(); } finally { config.cloudAiHosts = было; }
}

/** Проект, заведённый на конкретном имени платформы. */
function makeSessionOn(userId, host) {
  const sid = makeSession(userId);
  db.prepare('UPDATE sessions SET origin_host = ? WHERE id = ?').run(host, sid);
  return sid;
}

test('пустой список имён ничего не ограничивает', async () => {
  await наИмени([], () => {
    assert.strictEqual(cloudAccess.hostAllowed('enso-nexus.ru'), true);
    assert.strictEqual(cloudAccess.hostAllowed(''), true,
      'забытая переменная не имеет права выключить облако на всех адресах сразу');
  });
});

test('имя платформы решает раньше человека: на закрытом адресе облака нет и у владельца', async () => {
  await наИмени(['enso-nexus.com'], () => {
    const владелец = makeUser('Домов', 'Никита', true);
    assert.strictEqual(cloudAccess.allowedForSession(makeSessionOn(владелец, 'enso-nexus.com')), true);
    assert.strictEqual(cloudAccess.allowedForSession(makeSessionOn(владелец, 'enso-nexus.ru')), false,
      'на .ru облако закрыто даже владельцу');
    assert.strictEqual(cloudAccess.allowedForSession(makeSessionOn(владелец, 'app.enso-nexus.ru')), false);
  });
});

test('порт и регистр в адресе не открывают закрытое имя и не закрывают открытое', async () => {
  await наИмени(['enso-nexus.com'], () => {
    assert.strictEqual(cloudAccess.hostAllowed('ENSO-Nexus.COM:443'), true);
    assert.strictEqual(cloudAccess.hostAllowed('enso-nexus.ru:443'), false);
  });
});

test('проект, который ещё ни разу не открывали, облака не получает', async () => {
  await наИмени(['enso-nexus.com'], () => {
    const владелец = makeUser('Безымянов', 'Пётр', true);
    assert.strictEqual(cloudAccess.allowedForSession(makeSessionOn(владелец, '')), false,
      'пустое имя — не повод считать, что пришли с разрешённого адреса');
  });
});

test('запрет по имени стоит на дне адаптера, а не только в пикере', async () => {
  const владелец = makeUser('Днищев', 'Илья', true);
  const sid = makeSessionOn(владелец, 'enso-nexus.ru');
  requests = [];
  await наИмени(['enso-nexus.com'], async () => {
    await assert.rejects(
      () => adapter.plainCall({
        system: 'с', sessionId: sid, route: { provider: 'chatgpt', model: 'gpt-5.6-terra' },
        messages: [{ role: 'user', content: 'привет' }],
      }),
      (err) => {
        assert.ok(err instanceof adapter.AiUnavailableError);
        assert.match(err.message, /enso-nexus\.com/,
          'причина отказа — адрес, а не права: «только владельцу» здесь читалось бы как поломка');
        return true;
      },
    );
  });
  assert.strictEqual(requests.length, 0, 'с закрытого адреса к провайдеру не должно уйти ничего');
});

test('пикер на закрытом адресе привязанную модель не показывает вовсе', async () => {
  const владелец = makeUser('Пикеров', 'Глеб', true);
  const u = require('../server/services/users');
  // Проверяем на ChatGPT: ключ у него в этих тестах задан, значит пропасть из
  // списка он может ТОЛЬКО из-за адреса. У Claude ключа нет вовсе, и его
  // отсутствие ничего бы не доказывало.
  const list = await наИмени(['enso-nexus.com'],
    () => providers.listProvidersFor(u.byId(владелец), 'enso-nexus.ru'));
  assert.strictEqual(list.find((p) => p.id === 'chatgpt'), undefined,
    'модель, которая здесь не работает ни у кого, не показывается и серым (решение владельца, 2026-08-24)');

  const наСвоёмИмени = await наИмени(['enso-nexus.com'],
    () => providers.listProvidersFor(u.byId(владелец), 'enso-nexus.com'));
  assert.strictEqual(наСвоёмИмени.find((p) => p.id === 'chatgpt').available, true,
    'на разрешённом имени владелец обязан видеть облако');
  assert.strictEqual(наСвоёмИмени.find((p) => p.id === 'demo').available, true,
    'необлачные маршруты адресом не ограничиваются');
});

test('выбор спрятанной модели отклоняется с адресом, а не «неизвестным провайдером»', async () => {
  const владелец = makeUser('Выборов', 'Ян', true);
  const u = require('../server/services/users');
  // Сохранённый в проекте выбор переживает смену правил и приходит с закрытого
  // адреса: человеку называется адрес, где модель работает, — «неизвестный
  // провайдер» про вчерашний ChatGPT читался бы как поломка.
  const res = await наИмени(['enso-nexus.com'],
    () => providers.validateChoice('chatgpt', '', u.byId(владелец), 'enso-nexus.ru'));
  assert.strictEqual(res.ok, false);
  assert.match(res.error, /enso-nexus\.com/, 'причина отказа — адрес');

  const опечатка = await наИмени(['enso-nexus.com'],
    () => providers.validateChoice('нет-такого', '', u.byId(владелец), 'enso-nexus.ru'));
  assert.strictEqual(опечатка.ok, false);
  assert.match(опечатка.error, /Неизвестный провайдер/,
    'несуществующий идентификатор — по-прежнему «неизвестный провайдер»');
});

/*
 * Разделение доменов неравномерное: западная тройка (Claude, ChatGPT, Gemini)
 * привязана к `.com` списком CLOUD_AI_HOSTS_PROVIDERS, а облака, доступные из
 * России (Kimi, GigaChat, YandexGPT), работают с любого адреса. Пустой список
 * провайдеров обязан вести себя по-старому — привязывать всех облачных.
 */
async function соПривязкой(имена, провайдеры, fn) {
  const config = require('../server/config');
  const былиИмена = config.cloudAiHosts;
  const былиПровайдеры = config.cloudAiHostsProviders;
  config.cloudAiHosts = new Set(имена);
  config.cloudAiHostsProviders = new Set(провайдеры);
  try { return await fn(); } finally {
    config.cloudAiHosts = былиИмена;
    config.cloudAiHostsProviders = былиПровайдеры;
  }
}

test('привязка касается только перечисленных: облака, доступные из России, живут и на .ru', async () => {
  await соПривязкой(['enso-nexus.com'], ['claude', 'chatgpt', 'gemini'], () => {
    for (const западный of ['claude', 'chatgpt', 'gemini']) {
      assert.strictEqual(cloudAccess.hostAllowed('enso-nexus.ru', западный), false, `${западный} на .ru закрыт`);
      assert.strictEqual(cloudAccess.hostAllowed('enso-nexus.com', западный), true, `${западный} на .com открыт`);
    }
    for (const доступный of ['kimi', 'gigachat', 'yandexgpt']) {
      assert.strictEqual(cloudAccess.hostAllowed('enso-nexus.ru', доступный), true, `${доступный} работает и на .ru`);
    }
  });
});

test('пустой список провайдеров привязывает всех облачных — прежнее поведение', async () => {
  await соПривязкой(['enso-nexus.com'], [], () => {
    assert.strictEqual(cloudAccess.hostAllowed('enso-nexus.ru', 'kimi'), false,
      'сужение привязки — осознанное действие владельца, а не следствие забытой переменной');
  });
});

test('на .ru владелец работает с российским облаком, а западное закрыто даже ему', async () => {
  const владелец = makeUser('Разделов', 'Никита', true);
  await соПривязкой(['enso-nexus.com'], ['claude', 'chatgpt', 'gemini'], () => {
    const sid = makeSessionOn(владелец, 'enso-nexus.ru');
    assert.strictEqual(cloudAccess.allowedForSession(sid, 'claude'), false, 'Claude на .ru закрыт даже владельцу');
    assert.strictEqual(cloudAccess.allowedForSession(sid, 'gigachat'), true, 'GigaChat на .ru работает');
    assert.strictEqual(cloudAccess.allowedForSession(sid, 'yandexgpt'), true, 'YandexGPT на .ru работает');
    assert.strictEqual(cloudAccess.allowedForSession(sid, 'kimi'), true, 'Kimi на .ru работает');
  });
});

test('пикер на .ru: западной тройки нет в списке даже серым, российские облака доступны', async () => {
  const владелец = makeUser('Адресов', 'Матвей', true);
  const u = require('../server/services/users');
  const list = await соПривязкой(['enso-nexus.com'], ['claude', 'chatgpt', 'gemini'],
    () => providers.listProvidersFor(u.byId(владелец), 'enso-nexus.ru'));
  for (const западный of ['claude', 'chatgpt', 'gemini']) {
    assert.strictEqual(list.find((x) => x.id === западный), undefined,
      `${западный} на .ru не работает ни у кого — в списке его нет вовсе`);
  }
  for (const российский of ['gigachat', 'yandexgpt', 'kimi']) {
    const p = list.find((x) => x.id === российский);
    assert.strictEqual(p.available, true, `${российский} на .ru доступен владельцу`);
  }
});

test('GigaChat: постоянный ключ меняется на токен, к API уходит Bearer токена', async () => {
  const sid = makeSession(makeUser('Обменов', 'Пётр', true));
  // кэш токена сбрасывается вместе с модулем: обмен обязан пройти в этом тесте
  delete require.cache[require.resolve('../server/services/ai/gigachat')];
  requests = [];
  const out = await adapter.plainCall({
    system: 'с', sessionId: sid, route: { provider: 'gigachat', model: 'GigaChat-2' },
    messages: [{ role: 'user', content: 'привет' }],
  });
  assert.strictEqual(out.text, 'ответ');
  const oauth = requests.find((r) => r.url.includes('/oauth'));
  assert.ok(oauth, 'обмен ключа на токен обязан пройти через OAuth-точку');
  assert.strictEqual(oauth.auth, 'Basic giga-fake-auth-key');
  const chat = requests.find((r) => r.url.includes('/chat/completions'));
  assert.strictEqual(chat.auth, 'Bearer giga-test-token',
    'к API уходит короткоживущий токен, а не постоянный ключ');
});

test('GigaChat закрыт постороннему ещё до обмена ключа на токен', async () => {
  const посторонний = makeUser('Стороннев', 'Ким', false);
  const sid = makeSession(посторонний);
  delete require.cache[require.resolve('../server/services/ai/gigachat')];
  requests = [];
  await assert.rejects(
    () => adapter.plainCall({
      system: 'с', sessionId: sid, route: { provider: 'gigachat', model: 'GigaChat-2' },
      messages: [{ role: 'user', content: 'привет' }],
    }),
    (err) => err instanceof adapter.AiUnavailableError,
  );
  assert.strictEqual(requests.length, 0, 'наружу — включая OAuth Сбера — не должно уйти ничего');
});

test('короткое имя модели Яндекса дополняется каталогом до полного URI', async () => {
  const sid = makeSession(makeUser('Каталогов', 'Ян', true));
  requests = [];
  await adapter.plainCall({
    system: 'с', sessionId: sid, route: { provider: 'yandexgpt', model: 'yandexgpt/latest' },
    messages: [{ role: 'user', content: 'привет' }],
  });
  const тело = requests.at(-1).body;
  assert.strictEqual(тело.model, 'gpt://b1g-test-folder/yandexgpt/latest',
    'Яндекс принимает только полный URI: короткое имя дополняется каталогом владельца');
});

test('Kimi помечает конечного человека полем user', async () => {
  const sid = makeSession(makeUser('Меткин', 'Олег', false));
  await сОткрытымKimi(async () => {
    requests = [];
    await adapter.plainCall({
      system: 'с', sessionId: sid, route: { provider: 'kimi', model: 'kimi-k2.6' },
      messages: [{ role: 'user', content: 'привет' }],
    });
    const тело = requests[0].body;
    assert.ok(тело.user, 'один ключ на пятерых обязан различать людей на стороне провайдера');
    assert.match(тело.user, /^enso-[0-9a-f]{24}$/, 'уходит хэш, а не имя');
    assert.ok(!/Меткин|Олег/.test(JSON.stringify(тело)), 'ФИО в запрос попадать не должно');
  });
});
