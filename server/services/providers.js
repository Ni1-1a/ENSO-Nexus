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

/** Инфо для облачных моделей: тариф за 1 млн токенов (для пикера в UI). */
function cloudModelsInfo(models) {
  return models.map((id) => ({ id, price: pricing.priceFor(id) }));
}

let cache = null;
let cacheAt = 0;

async function probeOpenAiCompat(baseUrl, apiKey = '') {
  try {
    const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
    const res = await fetch(`${baseUrl}/models`, { headers, signal: AbortSignal.timeout(apiKey ? 6000 : 2500) });
    if (!res.ok) return null;
    const data = await res.json();
    return (data.data || []).map((m) => m.id).filter((id) => !/embed/i.test(id));
  } catch { return null; }
}

async function listProviders() {
  if (cache && Date.now() - cacheAt < 15000) return cache;
  const [lmModels, ollamaModels, openaiModels, kimiModels, geminiModels] = await Promise.all([
    probeOpenAiCompat(config.localAiBaseUrl),
    probeOpenAiCompat(config.ollamaBaseUrl),
    listCloudModels('chatgpt', config.openaiBaseUrl, config.openaiApiKey, OPENAI_MODELS, /^(gpt-|o\d)/),
    listCloudModels('kimi', config.kimiBaseUrl, config.kimiApiKey, KIMI_MODELS, /^(kimi|moonshot)/),
    // список Gemini берётся только из API аккаунта: имена моделей не зашиты в код
    require('./ai/gemini').listModels().catch(() => []),
  ]);

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
        note: f.note,
        loaded: loadedKeys.has(id),
        context: mm.desiredContext(id),
        sizeGb: f.sizeBytes ? +(f.sizeBytes / 1024 ** 3).toFixed(1) : null,
      };
    }));
  }

  const providers = [
    {
      id: 'claude', label: 'Claude (Anthropic)',
      available: !!config.anthropicApiKey,
      models: withDefaultFirst(ANTHROPIC_MODELS, config.anthropicModel),
      modelsInfo: cloudModelsInfo(withDefaultFirst(ANTHROPIC_MODELS, config.anthropicModel)),
      note: config.anthropicApiKey ? '' : 'нужен ANTHROPIC_API_KEY на сервере',
    },
    {
      id: 'chatgpt', label: 'ChatGPT (OpenAI)',
      available: !!config.openaiApiKey,
      models: withDefaultFirst(openaiModels, config.openaiModel),
      modelsInfo: cloudModelsInfo(withDefaultFirst(openaiModels, config.openaiModel)),
      note: config.openaiApiKey ? '' : 'нужен OPENAI_API_KEY на сервере',
    },
    {
      id: 'kimi', label: 'Kimi (Moonshot AI)',
      available: !!config.kimiApiKey,
      models: withDefaultFirst(kimiModels, config.kimiModel),
      modelsInfo: cloudModelsInfo(withDefaultFirst(kimiModels, config.kimiModel)),
      note: config.kimiApiKey ? '' : 'нужен KIMI_API_KEY на сервере',
    },
    {
      id: 'gemini', label: 'Gemini (Google)',
      available: !!(config.geminiApiKey && geminiModels.length),
      models: withDefaultFirst(geminiModels, config.geminiModel).filter(Boolean),
      modelsInfo: cloudModelsInfo(withDefaultFirst(geminiModels, config.geminiModel).filter(Boolean)),
      note: !config.geminiApiKey ? 'нужен GEMINI_API_KEY на сервере'
        : (geminiModels.length ? '' : 'ключ задан, но список моделей не получен — проверьте доступ'),
    },
    {
      id: 'lmstudio', label: 'LM Studio (локально)',
      available: !!(lmModels && lmModels.length),
      models: lmModels || [],
      modelsInfo: lmModelsInfo,
      note: lmModels ? '' : 'LM Studio не запущен',
    },
    {
      id: 'ollama', label: 'Ollama (локально)',
      available: !!(ollamaModels && ollamaModels.length),
      models: ollamaModels || [],
      note: ollamaModels === null ? 'Ollama не запущен' : (ollamaModels.length ? '' : 'нет чат-моделей: ollama pull <модель>'),
    },
    { id: 'demo', label: 'Демо-режим (без AI)', available: true, models: ['demo'], note: 'тестовая заглушка' },
  ];
  // возможности каждого провайдера — интерфейс и пайплайн смотрят на них, а не на бренд
  for (const p of providers) p.capabilities = registry.capabilities(p.id, p.models[0] || '');
  cache = providers;
  cacheAt = Date.now();
  return providers;
}

/** Пометка недоступности для того, кому облако закрыто. */
const CLOUD_CLOSED_NOTE = 'доступно только владельцу платформы — выберите локальную модель';

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
async function listProvidersFor(user) {
  const all = await listProviders();
  if (cloudAccess.userAllowed(user)) return all;
  return all.map((p) => (cloudAccess.isCloud(p.id)
    ? { ...p, available: false, note: CLOUD_CLOSED_NOTE }
    : p));
}

/** Проверка выбора пользователя; возвращает {ok} или {ok:false, error}. */
async function validateChoice(providerId, model, user = null) {
  const providers = await listProvidersFor(user);
  const p = providers.find((x) => x.id === providerId);
  if (!p) return { ok: false, error: 'Неизвестный провайдер' };
  if (!p.available) return { ok: false, error: `«${p.label}» недоступен: ${p.note}` };
  if (model && p.models.length && !p.models.includes(model)) {
    return { ok: false, error: `Модель «${model}» недоступна у провайдера «${p.label}»` };
  }
  if (model && p.modelsInfo) {
    const info = p.modelsInfo.find((m) => m.id === model);
    // feasible есть только у локальных моделей; облачные (с тарифом) не ограничены памятью
    if (info && info.feasible === false) {
      return { ok: false, error: `Модель «${model}» ${info.note} — выберите модель поменьше` };
    }
  }
  return { ok: true, provider: p };
}

module.exports = { listProviders, listProvidersFor, validateChoice, CLOUD_CLOSED_NOTE };
