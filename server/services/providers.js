'use strict';
/**
 * Реестр AI-провайдеров для выбора в интерфейсе.
 * Доступность и списки моделей определяются автоматически (кэш 15 с).
 */
const config = require('../config');
const pricing = require('./pricing');
const registry = require('./ai/registry');
const cloudAccess = require('./ai/cloud-access');

/** Актуальные модели Anthropic (справочник Claude API, 2026-08). */
const ANTHROPIC_MODELS = [
  'claude-opus-5', 'claude-fable-5', 'claude-sonnet-5', 'claude-opus-4-8',
  'claude-opus-4-7', 'claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5',
];
/**
 * Актуальные модели OpenAI (2026-08) — запасной список на случай, когда
 * /models с ключом недоступен; при рабочем ключе список берётся из API.
 */
const OPENAI_MODELS = [
  'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna',
  'gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.4-nano',
];

/** Актуальные модели Kimi / Moonshot AI (сводки 2026-08) — запасной список без ключа. */
const KIMI_MODELS = ['kimi-k3', 'kimi-k2.7-code', 'kimi-k2.6', 'kimi-k2.5', 'kimi-latest'];

/**
 * Модели GigaChat — запасной список: при рабочем ключе берётся из /models.
 * Семейство GigaChat-2 (справочник Сбера на момент подключения); проба с
 * живым ключом заменит список сама.
 */
const GIGACHAT_MODELS = ['GigaChat-2-Max', 'GigaChat-2-Pro', 'GigaChat-2'];

/**
 * Модели YandexGPT. Список статический: OpenAI-совместимый слой Yandex Cloud
 * своих моделей не перечисляет, а полный URI собирается из каталога владельца
 * (gpt://<folder>/<модель>) уже в адаптере — здесь только короткие имена.
 */
const YANDEX_MODELS = ['yandexgpt/latest', 'yandexgpt-lite/latest'];

/** Не-чатовые модели облачных провайдеров, которые не показываем в пикере. */
const CLOUD_EXCLUDE = /embed|whisper|tts|audio|realtime|image|dall-e|moderation|transcribe|codex|davinci|babbage|instruct|search|vision-preview/i;

const cloudListCache = new Map(); // providerId → {at, models}

/** Список чат-моделей облачного провайдера по ключу (кэш 10 мин); при ошибке — статический. */
async function listCloudModels(providerId, baseUrl, apiKey, fallback, includeRe) {
  if (!apiKey) return fallback;
  const cached = cloudListCache.get(providerId);
  if (cached && Date.now() - cached.at < 600000) return cached.models;
  const ids = await probeOpenAiCompat(baseUrl, apiKey);
  let models = fallback;
  if (ids && ids.length) {
    let chat = ids.filter((id) => includeRe.test(id) && !CLOUD_EXCLUDE.test(id));
    // датированные снапшоты (…-2026-04-23) прячем, если есть базовый id — меньше шума
    const set = new Set(chat);
    chat = chat.filter((id) => {
      const base = id.replace(/-20\d{2}-\d{2}-\d{2}$/, '');
      return base === id || !set.has(base);
    });
    // с известным тарифом — выше; внутри групп новые (по алфавиту в обратном порядке) — выше
    chat.sort((a, b) => (!!pricing.priceFor(b) - !!pricing.priceFor(a)) || b.localeCompare(a));
    if (chat.length) models = chat;
  }
  cloudListCache.set(providerId, { at: Date.now(), models });
  return models;
}

function withDefaultFirst(list, def) {
  return def && !list.includes(def) ? [def, ...list] : [def, ...list.filter((m) => m !== def)];
}

/**
 * Инфо для облачных моделей: тариф за 1 млн токенов и описание — что это за
 * модель и для какой работы её брать. Без описания список моделей — это набор
 * идентификаторов, по которому выбрать нельзя.
 */
function cloudModelsInfo(providerId, models) {
  return models.map((id) => ({ id, price: pricing.priceFor(id), about: registry.describe(providerId, id) }));
}

let cache = null;
let cacheAt = 0;

async function probeOpenAiCompat(baseUrl, apiKey = '') {
  try {
    const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
    // сюда приходят только облачные: без ключа listCloudModels до пробы не доходит
    const res = await fetch(`${baseUrl}/models`, { headers, signal: AbortSignal.timeout(6000) });
    if (!res.ok) return null;
    const data = await res.json();
    return (data.data || []).map((m) => m.id).filter((id) => !/embed/i.test(id));
  } catch { return null; }
}

/* ---------------- проба локального сервера моделей ---------------- */

const LOCAL_PROBE_TIMEOUT = 2500;

/**
 * Почему локальный сервер не ответил — человеческим языком.
 *
 * Раньше любая неудача пробы превращалась в одну надпись «LM Studio не
 * запущен», и она уводила не туда: 2026-08-21 LM Studio на маке работала, шлюз
 * работал, а платформа на VPS ходит к ним через Tailscale, который поднят не
 * был. Человек по подсказке перезапускал LM Studio — то есть чинил единственное
 * звено, которое было исправно. «Не запущен», «адрес недостижим» и «шлюз не
 * пустил» — три разные поломки, и лечатся они в трёх разных местах.
 *
 * fetch в Node прячет настоящую ошибку в err.cause — код берём оттуда.
 */
function errCode(err) {
  const seen = new Set();
  let e = err;
  while (e && typeof e === 'object' && !seen.has(e)) {
    seen.add(e);
    if (e.code) return e.code;
    // fetch к адресу с несколькими A-записями кладёт настоящие ошибки в AggregateError
    if (Array.isArray(e.errors) && e.errors.length) { e = e.errors[0]; continue; }
    e = e.cause;
  }
  return '';
}

function localFailReason(err) {
  const name = (err && err.name) || '';
  if (name === 'TimeoutError' || name === 'AbortError') {
    // молчание в трубку не различает «нет маршрута» и «машина занята» —
    // честнее перечислить, что проверить, чем назвать одну причину наугад
    return { note: `не ответил за ${(LOCAL_PROBE_TIMEOUT / 1000).toFixed(1).replace('.', ',')} с`,
      fix: 'Проверьте: машина с моделями включена, канал до неё поднят (Tailscale или локальная сеть), шлюз запущен.' };
  }
  const code = errCode(err);
  if (code === 'ECONNREFUSED') {
    return { note: 'соединение отклонено — сервер моделей не запущен',
      fix: 'Запустите LM Studio и шлюз на маке («Запустить ИИ на маке»).' };
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return { note: 'имя адреса не разрешается', fix: 'Проверьте LOCAL_AI_BASE_URL на сервере платформы.' };
  }
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH' || code === 'ETIMEDOUT') {
    return { note: 'адрес недостижим — нет сети до машины с моделями',
      fix: 'Проверьте канал до неё: Tailscale поднят, адрес не сменился.' };
  }
  if (code === 'ECONNRESET' || code === 'EPIPE') {
    return { note: 'соединение оборвано на полуслове', fix: 'Проверьте шлюз на маке и его журнал.' };
  }
  return { note: `нет ответа (${(err && err.message) || 'причина неизвестна'})`,
    fix: 'Проверьте LOCAL_AI_BASE_URL на сервере платформы и что сервер моделей запущен.' };
}

/**
 * Список моделей локального сервера + причина отказа, если не вышло.
 * Возвращает models: null — не достучались вовсе, [] — ответил, но моделей нет.
 */
async function probeLocal(baseUrl) {
  try {
    const res = await fetch(`${baseUrl}/models`, { signal: AbortSignal.timeout(LOCAL_PROBE_TIMEOUT) });
    if (res.status === 401 || res.status === 403) {
      return { models: null, note: `отвечает, но не пускает (HTTP ${res.status})`,
        fix: 'Шлюз требует ключ: добавьте адрес сервера платформы в allow шлюза на маке.' };
    }
    if (!res.ok) return { models: null, note: `ответил HTTP ${res.status}`, fix: '' };
    const data = await res.json();
    const models = (data.data || []).map((m) => m.id).filter((id) => !/embed/i.test(id));
    if (!models.length) {
      return { models: [], note: 'отвечает, но ни одной чат-модели не отдаёт',
        fix: 'Загрузите модель в LM Studio.' };
    }
    return { models, note: '', fix: '' };
  } catch (err) {
    return { models: null, ...localFailReason(err) };
  }
}

/** Выключенные владельцем (AI_DISABLED_PROVIDERS) не существуют ни для кого. */
function enabledOnly(list) { return list.filter((p) => !config.aiDisabledProviders.has(p.id)); }

async function listProviders() {
  if (cache && Date.now() - cacheAt < 15000) return enabledOnly(cache);
  const [lm, openaiModels, kimiModels, geminiModels, gigachatModels] = await Promise.all([
    probeLocal(config.localAiBaseUrl),
    listCloudModels('chatgpt', config.openaiBaseUrl, config.openaiApiKey, OPENAI_MODELS, /^(gpt-|o\d)/),
    listCloudModels('kimi', config.kimiBaseUrl, config.kimiApiKey, KIMI_MODELS, /^(kimi|moonshot)/),
    // список Gemini берётся только из API аккаунта: имена моделей не зашиты в код
    require('./ai/gemini').listModels().catch(() => []),
    (async () => {
      // /models у Сбера требует access_token: ключ авторизации меняется на него
      // отдельным запросом. Любой сбой обмена — статический список, а не отказ.
      const token = config.gigachatAuthKey
        ? await require('./ai/gigachat').accessToken().catch(() => '') : '';
      return listCloudModels('gigachat', config.gigachatBaseUrl, token, GIGACHAT_MODELS, /gigachat/i);
    })(),
  ]);
  const lmModels = lm.models;

  // Для локальных моделей — оценка: помещается ли модель в память машины
  let lmModelsInfo = [];
  if (lmModels && lmModels.length) {
    const mm = require('./model-manager');
    let loadedKeys = new Set();
    try { loadedKeys = new Set((await mm.listLoaded()).map((m) => m.modelKey)); } catch {}
    lmModelsInfo = await Promise.all(lmModels.map(async (id) => {
      const f = await mm.feasibility(id).catch(() => ({ feasible: true, note: '' }));
      return {
        id,
        feasible: f.feasible,
        heavy: !!f.heavy,
        note: f.note,
        loaded: loadedKeys.has(id),
        // показываем контекст, с которым модель РЕАЛЬНО загрузится на этой машине,
        // а не желаемый по профилю: иначе подпись обещает то, чего не будет
        context: f.fitContext || mm.desiredContext(id),
        wantContext: f.wantContext || mm.desiredContext(id),
        // паспортный максимум самой модели: в LM Studio человек видит именно его,
        // и расхождение с нашим числом надо объяснять, а не прятать
        modelMaxContext: f.modelMaxContext || 0,
        sizeGb: f.sizeBytes ? +(f.sizeBytes / 1024 ** 3).toFixed(1) : null,
        about: registry.describe('lmstudio', id),
      };
    }));
  }

  const providers = [
    {
      id: 'claude', label: 'Claude (Anthropic)',
      available: !!config.anthropicApiKey,
      models: withDefaultFirst(ANTHROPIC_MODELS, config.anthropicModel),
      modelsInfo: cloudModelsInfo('claude', withDefaultFirst(ANTHROPIC_MODELS, config.anthropicModel)),
      note: config.anthropicApiKey ? '' : 'нужен ANTHROPIC_API_KEY на сервере',
    },
    {
      id: 'chatgpt', label: 'ChatGPT (OpenAI)',
      available: !!config.openaiApiKey,
      models: withDefaultFirst(openaiModels, config.openaiModel),
      modelsInfo: cloudModelsInfo('chatgpt', withDefaultFirst(openaiModels, config.openaiModel)),
      note: config.openaiApiKey ? '' : 'нужен OPENAI_API_KEY на сервере',
    },
    {
      id: 'kimi', label: 'Kimi (Moonshot AI)',
      available: !!config.kimiApiKey,
      models: withDefaultFirst(kimiModels, config.kimiModel),
      modelsInfo: cloudModelsInfo('kimi', withDefaultFirst(kimiModels, config.kimiModel)),
      note: config.kimiApiKey ? '' : 'нужен KIMI_API_KEY на сервере',
    },
    {
      id: 'gemini', label: 'Gemini (Google)',
      available: !!(config.geminiApiKey && geminiModels.length),
      models: withDefaultFirst(geminiModels, config.geminiModel).filter(Boolean),
      modelsInfo: cloudModelsInfo('gemini', withDefaultFirst(geminiModels, config.geminiModel).filter(Boolean)),
      note: !config.geminiApiKey ? 'нужен GEMINI_API_KEY на сервере'
        : (geminiModels.length ? '' : 'ключ задан, но список моделей не получен — проверьте доступ'),
    },
    {
      id: 'gigachat', label: 'GigaChat (Сбер)',
      available: !!config.gigachatAuthKey,
      models: withDefaultFirst(gigachatModels, config.gigachatModel),
      modelsInfo: cloudModelsInfo('gigachat', withDefaultFirst(gigachatModels, config.gigachatModel)),
      note: config.gigachatAuthKey ? '' : 'нужен GIGACHAT_AUTH_KEY на сервере',
    },
    {
      id: 'yandexgpt', label: 'YandexGPT (Яндекс)',
      available: !!(config.yandexApiKey && config.yandexFolderId),
      models: withDefaultFirst(YANDEX_MODELS, config.yandexModel),
      modelsInfo: cloudModelsInfo('yandexgpt', withDefaultFirst(YANDEX_MODELS, config.yandexModel)),
      note: (config.yandexApiKey && config.yandexFolderId)
        ? '' : 'нужны YANDEX_API_KEY и YANDEX_FOLDER_ID на сервере',
    },
    {
      id: 'lmstudio', label: 'LM Studio (локально)',
      available: !!(lmModels && lmModels.length),
      models: lmModels || [],
      modelsInfo: lmModelsInfo,
      // note — что именно не так, fix — что с этим делать, endpoint — куда стучались.
      // Адрес срезается для неавторизованных в listProvidersFor: /health отвечает
      // и анониму, а внутренний адрес мака ему знать незачем.
      note: lm.note, fix: lm.fix, endpoint: config.localAiBaseUrl,
    },
    {
      id: 'demo', label: 'Демо-режим (без AI)', available: true, models: ['demo'],
      modelsInfo: [{ id: 'demo', about: registry.describe('demo', 'demo') }],
      note: 'тестовая заглушка',
    },
  ];
  // возможности каждого провайдера — интерфейс и пайплайн смотрят на них, а не на бренд
  for (const p of providers) p.capabilities = registry.capabilities(p.id, p.models[0] || '');
  cache = providers;
  cacheAt = Date.now();
  return enabledOnly(providers);
}

/** Пометка недоступности для того, кому облако закрыто. */
const CLOUD_CLOSED_NOTE = 'доступно только владельцу платформы — выберите локальную модель';

/**
 * Та же пометка, но с названием открытых всем провайдеров, когда они есть:
 * «выберите Kimi (открыт всем) или локальную модель» — человек видит замену,
 * а не только запрет. Западная тройка сюда не попадает (OWNER_ONLY).
 */
function cloudClosedNote() {
  const open = cloudAccess.openProviders().map((id) => cloudAccess.PROVIDER_LABELS[id] || id);
  if (!open.length) return CLOUD_CLOSED_NOTE;
  return `доступно только владельцу платформы — выберите ${open.join(', ')} `
    + `(${open.length === 1 ? 'открыт' : 'открыты'} всем) или локальную модель`;
}

/**
 * Список провайдеров для КОНКРЕТНОГО человека.
 *
 * Сам список (какие модели у ключа вообще есть) общий и кэшируется, а вот
 * доступность облачных зависит от того, кто спрашивает: условия провайдеров
 * запрещают открывать доступ к их сервисам посторонним. Показывать людям
 * модели, которыми они всё равно не смогут воспользоваться, — значит обещать
 * то, чего нет, поэтому облачные помечаются недоступными прямо в пикере.
 * Это удобство; настоящий запрет стоит на дне адаптера (ai/cloud-access.js).
 */
async function listProvidersFor(user, host = '') {
  const all = await listProviders();
  // Доступ считается по каждому провайдеру отдельно: владелец может открыть
  // один сервис всем и оставить остальные себе. Общая проверка «пускать ли в
  // облако вообще» здесь больше не годится.
  return all
    /*
     * Провайдер, привязанный к другому имени платформы, здесь НЕ ПОКАЗЫВАЕТСЯ
     * вовсе (решение владельца, 2026-08-24). Раньше он висел серым с пометкой
     * «работает на enso-nexus.com», но на закрытом адресе эти модели не
     * работают НИ У КОГО — строка в пикере ничего не предлагала и только
     * удлиняла список. Настоящий запрет остаётся на дне адаптера: выбор,
     * сохранённый в проекте, переживает смену правил, и такому выбору отказ
     * по-прежнему называет адрес (см. validateChoice и adapter).
     */
    .filter((p) => !cloudAccess.isCloud(p.id) || cloudAccess.hostAllowed(host, p.id))
    .map((p) => {
      // адрес локального сервера — только вошедшим: /health открыт и анониму.
      // При выключенном входе (REQUIRE_LOGIN=0) прятать не от кого — там открыто всё.
      if (!cloudAccess.isCloud(p.id)) {
        return (user || !config.requireLogin) ? p : { ...p, endpoint: undefined };
      }
      // сначала ключ, потом доступ: провайдер без ключа на сервере недоступен
      // всем, и его пометка «нужен ключ» точнее, чем «только по отметке»
      if (!p.available) return p;
      return cloudAccess.userAllowed(user, p.id)
        ? p
        : { ...p, available: false, note: cloudClosedNote() };
    });
}

/** Проверка выбора пользователя; возвращает {ok} или {ok:false, error}. */
async function validateChoice(providerId, model, user = null, host = '') {
  const providers = await listProvidersFor(user, host);
  const p = providers.find((x) => x.id === providerId);
  if (!p && config.aiDisabledProviders.has(String(providerId || '').toLowerCase())) {
    return { ok: false, error: `Провайдер «${providerId}» отключён владельцем платформы — выберите другую модель` };
  }
  if (!p) {
    // Провайдер существует, но на этом имени платформы спрятан из списка —
    // причина отказа адрес, а не опечатка в идентификаторе: «неизвестный
    // провайдер» про сохранённый в проекте Claude читался бы как поломка.
    const существует = (await listProviders()).some((x) => x.id === providerId);
    return { ok: false, error: существует ? cloudAccess.hostDenyMessage() : 'Неизвестный провайдер' };
  }
  if (!p.available) return { ok: false, error: `«${p.label}» недоступен: ${p.note}` };
  if (model && p.models.length && !p.models.includes(model)) {
    return { ok: false, error: `Модель «${model}» недоступна у провайдера «${p.label}»` };
  }
  /*
   * Нехватка памяти под локальную модель — НЕ повод запретить выбор.
   *
   * Раньше здесь стоял отказ: «Модель не помещается в память — выберите модель
   * поменьше», и llama-3.3-70b нельзя было даже попробовать. Решение, рисковать
   * ли своей машиной, принимает её владелец; платформа обязана предупредить, а не
   * решать за него. Контекст под фактическую память подбирает model-manager,
   * и предупреждение уходит в ответ отдельным полем — интерфейс покажет его
   * подписью под списком моделей.
   */
  const info = model && p.modelsInfo ? p.modelsInfo.find((m) => m.id === model) : null;
  return { ok: true, provider: p, warning: (info && info.heavy && info.note) ? info.note : '' };
}

module.exports = { listProviders, listProvidersFor, validateChoice, probeLocal, CLOUD_CLOSED_NOTE, cloudClosedNote };
