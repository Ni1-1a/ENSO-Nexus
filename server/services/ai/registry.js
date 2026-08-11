'use strict';
/**
 * Реестр AI-провайдеров и моделей: возможности (capabilities) и лимиты.
 *
 * Единственное место, где записано, что умеет конкретная модель. Пайплайн и
 * интерфейс спрашивают возможности, а не бренд: вместо «если Claude — отправить
 * PDF» пишется «если провайдер умеет pdf — отправить PDF». Благодаря этому новый
 * провайдер подключается добавлением записи сюда, без правок бизнес-логики.
 *
 * Возможности намеренно консервативны: неизвестная модель считается умеющей
 * только текст. Лучше лишний раз извлечь текст самим, чем отправить PDF модели,
 * которая его не прочитает, и получить пустой анализ.
 */
const config = require('../../config');

/** Полный набор признаков (ТЗ, п. 57). */
const CAPABILITY_KEYS = [
  'text', 'vision', 'pdf', 'streaming', 'structuredOutput',
  'tools', 'reasoning', 'fileUpload', 'embeddings',
];

const NONE = Object.freeze(CAPABILITY_KEYS.reduce((a, k) => ({ ...a, [k]: false }), {}));

function caps(on) {
  return Object.freeze({ ...NONE, text: true, ...on });
}

/**
 * Базовые возможности провайдера. Поле kind говорит, каким адаптером
 * пользоваться: anthropic (свой SDK), openai-compat (общий REST), demo.
 */
const PROVIDERS = {
  claude: {
    id: 'claude',
    label: 'Claude (Anthropic)',
    kind: 'anthropic',
    cloud: true,
    keyEnv: 'ANTHROPIC_API_KEY',
    caps: caps({ vision: true, pdf: true, streaming: true, structuredOutput: true, tools: true, reasoning: true }),
    maxOutputTokens: () => config.anthropicMaxTokens,
    defaultModel: () => config.anthropicModel,
  },
  chatgpt: {
    id: 'chatgpt',
    label: 'ChatGPT (OpenAI)',
    kind: 'openai-compat',
    cloud: true,
    keyEnv: 'OPENAI_API_KEY',
    caps: caps({ vision: true, streaming: true, structuredOutput: true, tools: true, reasoning: true, fileUpload: true }),
    maxOutputTokens: () => config.openaiMaxTokens,
    defaultModel: () => config.openaiModel,
  },
  kimi: {
    id: 'kimi',
    label: 'Kimi (Moonshot AI)',
    kind: 'openai-compat',
    cloud: true,
    keyEnv: 'KIMI_API_KEY',
    caps: caps({ vision: true, streaming: true, structuredOutput: true, tools: true }),
    maxOutputTokens: () => config.kimiMaxTokens,
    defaultModel: () => config.kimiModel,
  },
  gemini: {
    id: 'gemini',
    label: 'Gemini (Google)',
    kind: 'gemini',
    cloud: true,
    keyEnv: 'GEMINI_API_KEY',
    // Gemini читает PDF и изображения сам — документы уходят вложениями
    caps: caps({
      vision: true, pdf: true, streaming: true, structuredOutput: true,
      tools: true, reasoning: true, fileUpload: true, embeddings: true,
    }),
    maxOutputTokens: () => config.geminiMaxTokens,
    defaultModel: () => config.geminiModel,
  },
  lmstudio: {
    id: 'lmstudio',
    label: 'LM Studio (локально)',
    kind: 'openai-compat',
    cloud: false,
    caps: caps({ streaming: true, structuredOutput: true, embeddings: true }),
    maxOutputTokens: () => config.localAiMaxTokens,
    defaultModel: () => config.localAiModel,
  },
  ollama: {
    id: 'ollama',
    label: 'Ollama (локально)',
    kind: 'openai-compat',
    cloud: false,
    // json_schema Ollama принимает через OpenAI-совместимый слой — так работает и сейчас
    caps: caps({ streaming: true, structuredOutput: true }),
    maxOutputTokens: () => config.localAiMaxTokens,
    defaultModel: () => '',
  },
  'openai-compat': {
    id: 'openai-compat',
    label: 'OpenAI-совместимый сервер',
    kind: 'openai-compat',
    cloud: false,
    caps: caps({ streaming: true, structuredOutput: true }),
    maxOutputTokens: () => config.localAiMaxTokens,
    defaultModel: () => '',
  },
  demo: {
    id: 'demo',
    label: 'Демо-режим (без AI)',
    kind: 'demo',
    cloud: false,
    caps: caps({}),
    maxOutputTokens: () => 0,
    defaultModel: () => 'demo',
  },
};

/**
 * Уточнения по конкретным моделям: срабатывает первое совпадение.
 * Здесь живут исключения из базовых возможностей провайдера.
 */
const MODEL_RULES = [
  // Anthropic: у haiku потолок ответа вдвое ниже остальных
  { provider: 'claude', match: /haiku/i, limits: { maxOutputTokens: 64000 } },

  // Локальные: зрение есть только у vision-моделей, их и зовём для OCR
  { provider: 'lmstudio', match: /-vl|vision|llava|qwen2?-?vl/i, on: { vision: true } },
  // «Мыслящие» локальные модели тратят бюджет ответа на размышления
  { provider: 'lmstudio', match: /qwq|-r1|reason|think/i, on: { reasoning: true } },

  // Kimi K2+: размышления внутри того же лимита выходных токенов
  { provider: 'kimi', match: /^kimi-(k[3-9]|latest)/i, on: { reasoning: true } },

  // OpenAI: nano/mini дешевле, но лимит ответа тот же; отдельных правил не нужно
];

/** Возможности пары «провайдер + модель». Неизвестный провайдер — только текст. */
function capabilities(provider, model = '') {
  const p = PROVIDERS[provider];
  if (!p) return NONE;
  let result = { ...p.caps };
  for (const rule of MODEL_RULES) {
    if (rule.provider === provider && rule.match.test(model || '') && rule.on) {
      result = { ...result, ...rule.on };
    }
  }
  return Object.freeze(result);
}

/** Короткая проверка одной возможности: supports(route, 'pdf'). */
function supports(route, capability) {
  if (!route || !route.provider) return false;
  return !!capabilities(route.provider, route.model)[capability];
}

/** Потолок выходных токенов для маршрута с учётом модельных исключений. */
function maxOutputTokens(route) {
  const p = PROVIDERS[route && route.provider];
  if (!p) return 0;
  const base = p.maxOutputTokens();
  for (const rule of MODEL_RULES) {
    if (rule.provider === route.provider && rule.match.test(route.model || '') && rule.limits) {
      return Math.min(base, rule.limits.maxOutputTokens);
    }
  }
  return base;
}

/**
 * Как подавать документы этому маршруту:
 *  'native'    — PDF и картинки уходят вложениями, модель читает их сама;
 *  'extracted' — PDF разбирается текстом, сканы и картинки идут через VLM-OCR.
 * Решает не бренд, а наличие обеих возможностей: чтения PDF и зрения.
 */
function documentMode(route) {
  return supports(route, 'pdf') && supports(route, 'vision') ? 'native' : 'extracted';
}

/** Метаданные провайдера (label, kind, облачный ли, какой ключ нужен). */
function providerMeta(provider) {
  const p = PROVIDERS[provider];
  if (!p) return null;
  const { id, label, kind, cloud, keyEnv } = p;
  return { id, label, kind, cloud: !!cloud, keyEnv: keyEnv || '' };
}

/** Модель по умолчанию для провайдера (когда в сессии выбран только провайдер). */
function defaultModel(provider) {
  const p = PROVIDERS[provider];
  return p ? p.defaultModel() : '';
}

/** Все известные провайдеры с возможностями — для /api/health и интерфейса. */
function listRegistry() {
  return Object.keys(PROVIDERS).map((id) => ({
    ...providerMeta(id),
    capabilities: capabilities(id, defaultModel(id)),
  }));
}

module.exports = {
  CAPABILITY_KEYS,
  capabilities,
  supports,
  maxOutputTokens,
  documentMode,
  providerMeta,
  defaultModel,
  listRegistry,
};
