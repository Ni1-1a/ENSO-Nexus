'use strict';
const fs = require('fs');
const path = require('path');
const config = require('../../config');
const { db, now } = require('../../db');
const { RESPONSE_SCHEMA, validateResponse } = require('./schema');
const { buildContext } = require('./memory');
const mock = require('./mock');
const modelManager = require('../model-manager');
const progress = require('../progress');
const registry = require('../ai/registry');
const cloudAccess = require('../ai/cloud-access');

const AI_ERROR_LOG = path.join(__dirname, '..', '..', '..', 'logs', 'ai-errors.log');

/** Каждая ошибка AI-сервера пишется с полной причиной: в консоль и в logs/ai-errors.log. */
function logAiError(info) {
  console.error('[local-ai]', info.status || '', String(info.detail || info.message || '').slice(0, 500));
  try {
    fs.appendFileSync(AI_ERROR_LOG, JSON.stringify({ at: new Date().toISOString(), ...info }) + '\n');
  } catch { /* журнал не должен ронять обработку */ }
}

/** Провайдеры, которые крутятся на машине владельца, а не в облаке. */
const LOCAL_PROVIDERS = new Set(['lmstudio', 'ollama', 'openai-compat']);
/** Маршруты, которые адаптер умеет исполнять. Всё остальное — явная ошибка, а не подмена. */
const ROUTABLE_PROVIDERS = new Set(['claude', 'chatgpt', 'kimi', 'gemini', 'lmstudio', 'ollama', 'openai-compat', 'demo']);

/** Человеческое имя провайдера для сообщений (берётся из реестра, а не зашито). */
function providerLabel(providerId) {
  const meta = registry.providerMeta(providerId);
  return (meta && meta.label) || `провайдер «${providerId || 'не выбран'}»`;
}

/** Переменная .env с ключом провайдера — чтобы совет при 401 указывал на нужную строку. */
function providerKeyEnv(providerId) {
  const meta = registry.providerMeta(providerId);
  return (meta && meta.keyEnv) || '';
}

/**
 * Переменная .env, задающая бюджет ВЫХОДНЫХ токенов маршрута. Совет «увеличьте
 * LOCAL_AI_MAX_TOKENS» на облачной модели не меняет ничего: у каждого провайдера
 * своя переменная (config.js).
 */
function maxTokensEnv(providerId) {
  if (providerId === 'claude') return 'ANTHROPIC_MAX_TOKENS';
  if (providerId === 'chatgpt') return 'OPENAI_MAX_TOKENS';
  if (providerId === 'kimi') return 'KIMI_MAX_TOKENS';
  if (providerId === 'gemini') return 'GEMINI_MAX_TOKENS';
  if (LOCAL_PROVIDERS.has(providerId)) return 'LOCAL_AI_MAX_TOKENS';
  return '';
}

/**
 * Секреты из ответа стороннего сервера не должны попасть ни человеку в ленту,
 * ни в журнал: сервер, отдающий эхом заголовки запроса, иначе вернул бы наш
 * же ключ прямо в текст ошибки.
 */
function redactSecrets(text) {
  return String(text || '')
    .replace(/\b(?:sk|rk|pk|sess)-[A-Za-z0-9_\-*]{4,}/g, '«ключ скрыт»')
    .replace(/\bAIza[0-9A-Za-z_\-]{10,}/g, '«ключ скрыт»')
    .replace(/\bBearer\s+[A-Za-z0-9._\-]{8,}/gi, 'Bearer «ключ скрыт»')
    .replace(/("?(?:api[_-]?key|authorization|x-api-key)"?\s*[:=]\s*)"?[^"\s,}]{6,}/gi, '$1«ключ скрыт»');
}

/**
 * Человеческое объяснение ошибки провайдера по коду и телу ответа.
 * Подпись — по ФАКТИЧЕСКОМУ провайдеру маршрута (раньше всем, включая ChatGPT и
 * Kimi, отвечал «Локальный AI-сервер»), а совет — разный: 401 повтором не
 * лечится, 429 лечится паузой, 5xx — вообще не на нашей стороне.
 */
function humanizeProviderError(providerId, status, detail) {
  const label = providerLabel(providerId);
  const local = LOCAL_PROVIDERS.has(providerId);
  let msg = '';
  try {
    const j = JSON.parse(detail);
    msg = j.error?.message || (typeof j.error === 'string' ? j.error : '') || j.message || '';
  } catch { /* тело не JSON — берём как есть */ }
  msg = redactSecrets(String(msg || detail || '')).replace(/\s+/g, ' ').trim();
  const tail = msg ? ` Ответ сервера: ${msg.slice(0, 200)}` : '';

  // локальный сервер моделей падает почти всегда из-за памяти и загрузки модели
  if (local) {
    if (/unload/i.test(msg)) {
      return 'Локальная модель была выгружена из памяти (нехватка RAM или конкурирующая задача). Повторите попытку — модель будет загружена заново.';
    }
    if (/failed to load|startup was aborted|insufficient|out of memory/i.test(msg)) {
      return 'Не удалось загрузить выбранную модель — вероятно, ей не хватает памяти. Выберите модель поменьше или повторите позже.';
    }
  }
  if (status === 401 || status === 403) {
    const env = providerKeyEnv(providerId);
    return `${label} не принял ключ доступа (${status}). Повтор не поможет: проверьте ${env ? `${env} в .env` : 'ключ провайдера'} на сервере` +
      `${status === 403 ? ' и права доступа к выбранной модели' : ''}.${tail}`;
  }
  if (status === 402 || (status < 500 && /insufficient (balance|credit|funds|quota)|billing|exceeded your (current )?quota|out of credit|payment required/i.test(msg))) {
    return `${label}: закончились средства или исчерпана квота аккаунта (${status}). Пополните баланс или дождитесь сброса лимита — до этого запросы проходить не будут.${tail}`;
  }
  if (status === 429) {
    return `${label} ограничил частоту запросов (429). Подождите минуту и повторите; если повторяется постоянно — упёрлись в лимит тарифа.${tail}`;
  }
  if (status === 404) {
    return `${label}: выбранная модель недоступна (404). Выберите другую модель в «Настройках».${tail}`;
  }
  if (status === 400 || status === 422) {
    return `${label} отклонил запрос (${status}).${tail}`;
  }
  if (status >= 500) {
    return `Сервер провайдера — ${label} — вернул ошибку ${status}. Это сбой на его стороне, повторите попытку позже.${tail}`;
  }
  return `${label} вернул ошибку ${status}.${tail} Повторите попытку.`;
}

/** Длительность по-русски: минуты при больших значениях, секунды при малых. */
function humanDuration(ms) {
  return ms >= 60000 ? `${Math.round(ms / 60000)} мин` : `${Math.round(ms / 1000)} с`;
}

/** Явная ошибка вместо тихого ухода на другую (платную!) модель. */
function unknownProviderError(providerId) {
  return new AiUnavailableError(
    `Неизвестный AI-провайдер «${providerId || 'не выбран'}»: запрос никуда не отправлен. ` +
    'Подменять его другой моделью нельзя — выберите провайдера в «Настройках». ' +
    `Известные: ${[...ROUTABLE_PROVIDERS].join(', ')}.`,
  );
}

/** Модель, которая фактически будет использована для маршрута (для шапки и журнала). */
function resolveModel(route) {
  if (!route || !route.provider) return 'не выбрана';
  if (route.provider === 'claude') return route.model || config.anthropicModel;
  if (route.provider === 'chatgpt') return route.model || config.openaiModel;
  if (route.provider === 'kimi') return route.model || config.kimiModel;
  if (route.provider === 'gemini') return route.model || config.geminiModel || 'gemini';
  if (route.provider === 'lmstudio') return route.model || config.localAiModel;
  if (route.provider === 'ollama') return route.model || '';
  if (route.provider === 'demo') return 'demo';
  return route.model || route.provider;
}

const SYSTEM_PROMPT = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'prompts', 'system-prompt.md'), 'utf8');

let _client = null;
function client() {
  if (!_client) {
    const Anthropic = require('@anthropic-ai/sdk');
    _client = new Anthropic({
      apiKey: config.anthropicApiKey,
      timeout: config.anthropicRequestTimeoutMs,
      maxRetries: config.anthropicMaxRetries, // SDK retries 429/5xx/network with exponential backoff
    });
  }
  return _client;
}

class BudgetExceededError extends Error {}
class AiUnavailableError extends Error {}

/**
 * Облако — только тем, кому владелец его разрешил (см. ai/cloud-access.js).
 *
 * Проверка стоит на ДНЕ адаптера, у самого вызова модели, а не только в
 * интерфейсе и не только при выборе провайдера в «Настройках»: выбор хранится
 * в сессии и переживает смену правил, а `provider` подставляется в тело
 * запроса клиентом. Гейт, стоящий выше, обходится одной строкой.
 */
function assertCloudAllowed(providerId, sessionId) {
  if (!cloudAccess.isCloud(providerId)) return;
  if (cloudAccess.allowedForSession(sessionId)) return;
  throw new AiUnavailableError(cloudAccess.DENY_MESSAGE);
}

/**
 * Потолок обращений к модели на ОДИН анализ (основной вызов + дозапросы
 * продолжения + повторы по схеме).
 *
 * Прежние четыре выбирались за один прогон и превращались в тупик: локальная
 * 8B-модель на семнадцатистраничном ГПЗУ упирается в лимит выходных токенов,
 * два дозапроса продолжения и один повтор по схеме съедают потолок — и человек
 * читает «Потрачено обращений к модели: 4 из 4», не получив ничего. Так закончились
 * пять прогонов из десяти в проверке «Интерфейс. Вариант 2».
 *
 * Теперь потолок настраивается и по умолчанию заметно выше, а склейка обрезанного
 * ответа больше не считается «попыткой»: продолжение — это дочитывание одного
 * ответа, а не новая попытка его получить. Деньги держат два настоящих
 * предохранителя — лимит токенов проекта и лимит запросов человека.
 */
const MAX_ANALYSIS_CALLS = config.maxAnalysisCalls;
/** Сколько раз дозапрашивать продолжение обрезанного ответа. */
const MAX_CONTINUATIONS = config.maxContinuations;

/**
 * Предохранитель проекта. Считаются ЗАПРОСЫ ЧЕЛОВЕКА (анализ, реплика в чате,
 * прогон этапа): лимит заводился против бесконечного цикла. Служебные обращения —
 * распознавание страницы, конспект документа — живут в ai_subrequests и лимит не
 * расходуют: их число задано самими документами, а деньги держит лимит токенов.
 * Сообщение называет числа: «достигнут лимит» без них не подсказывает, что делать.
 */
function checkBudget(session) {
  if (session.ai_requests >= config.maxAiRequestsPerSession) {
    throw new BudgetExceededError(
      `Достигнут лимит запросов к модели для этого проекта: ${session.ai_requests} из ${config.maxAiRequestsPerSession}. ` +
      'Продолжить можно в новом проекте или увеличив MAX_AI_REQUESTS_PER_SESSION на сервере.');
  }
  if (session.input_tokens + session.output_tokens >= config.maxTokensPerSession) {
    const used = session.input_tokens + session.output_tokens;
    throw new BudgetExceededError(
      `Достигнут лимит токенов для этого проекта: ${used.toLocaleString('ru-RU')} из ${config.maxTokensPerSession.toLocaleString('ru-RU')}. ` +
      'Продолжить можно в новом проекте или увеличив MAX_TOKENS_PER_SESSION на сервере.');
  }
}

function recordUsage(sessionId, usage, route = {}, { internal = false } = {}) {
  // Кэш-токены Anthropic ОПЛАЧИВАЮТСЯ (запись 1.25×, чтение 0.1× от входной цены)
  // и в usage.input_tokens не входят. Раньше они не попадали в input_tokens
  // сессии, и лимит maxTokensPerSession был мягче заявленного, а «входные
  // токены» в карточке «Статус» расходились со строкой стоимости рядом.
  const input = (usage?.input_tokens || 0)
    + (usage?.cache_creation_input_tokens || 0)
    + (usage?.cache_read_input_tokens || 0);
  const output = usage?.output_tokens || 0;
  // стоимость облачных запросов (включая кэш-токены Anthropic); локальные — 0
  const cost = require('../pricing').costUsd(route.provider, route.model, usage || {});
  // токены и деньги считаются одинаково; врозь идёт только счётчик запросов —
  // предохранитель проекта не должен выбираться распознаванием чужого скана
  const counter = internal ? 'ai_subrequests' : 'ai_requests';
  db.prepare(
    `UPDATE sessions SET ${counter} = ${counter} + 1, input_tokens = input_tokens + ?, output_tokens = output_tokens + ?, cost_usd = cost_usd + ?, updated_at = ? WHERE id = ?`,
  ).run(input, output, cost, now(), sessionId);
  const cached = (usage?.cache_creation_input_tokens || 0) + (usage?.cache_read_input_tokens || 0);
  console.log(`[tokens] session=${sessionId}${internal ? ' (служебный)' : ''} in=${input}${cached ? ` (из них кэш ${cached})` : ''} out=${output}${cost ? ` cost=$${cost.toFixed(4)}` : ''}`);
}

/** Действующий провайдер сессии: выбор пользователя, иначе глобальный режим сервера. */
function effectiveProvider(session) {
  if (session && session.ai_provider) return { provider: session.ai_provider, model: session.ai_model || '' };
  const fallback = config.aiMode === 'live' ? 'claude' : config.aiMode === 'local' ? 'lmstudio' : 'demo';
  // Умолчание не имеет права быть облачным для того, кому облако закрыто.
  // Тихой подмены ВЫБОРА здесь нет: выбора не было — сессия его не хранит,
  // и человек увидит в шапке ровно ту модель, которая будет работать.
  if (cloudAccess.isCloud(fallback) && !cloudAccess.allowedForSession(session && session.id)) {
    return { provider: 'lmstudio', model: '' };
  }
  return { provider: fallback, model: '' };
}

/** Returns { text, truncated } — truncated means the output hit the token cap (JSON likely incomplete). */
async function callModel({ system, messages, sessionId, route, signal }) {
  if (route.provider === 'lmstudio') {
    return callOpenAiCompat({ system, messages, sessionId, baseUrl: config.localAiBaseUrl, model: route.model || config.localAiModel, provider: 'lmstudio', signal });
  }
  if (route.provider === 'ollama') {
    return callOpenAiCompat({ system, messages, sessionId, baseUrl: config.ollamaBaseUrl, model: route.model, provider: 'ollama', signal });
  }
  if (route.provider === 'chatgpt') {
    if (!config.openaiApiKey) throw new AiUnavailableError('ChatGPT не настроен: нужен OPENAI_API_KEY на сервере.');
    return callOpenAiCompat({ system, messages, sessionId, baseUrl: config.openaiBaseUrl, apiKey: config.openaiApiKey, model: route.model || config.openaiModel, provider: 'chatgpt', signal });
  }
  if (route.provider === 'kimi') {
    if (!config.kimiApiKey) throw new AiUnavailableError('Kimi не настроен: нужен KIMI_API_KEY на сервере.');
    return callOpenAiCompat({ system, messages, sessionId, baseUrl: config.kimiBaseUrl, apiKey: config.kimiApiKey, model: route.model || config.kimiModel, provider: 'kimi', signal });
  }
  if (route.provider === 'gemini') {
    return callGemini({ system, messages, sessionId, route, signal, jsonSchema: RESPONSE_SCHEMA });
  }
  if (route.provider === 'openai-compat') {
    return callOpenAiCompat({ system, messages, sessionId, baseUrl: config.localAiBaseUrl, model: route.model, provider: 'openai-compat', signal });
  }
  if (route.provider === 'demo') {
    throw new AiUnavailableError('Демо-режим: обращение к модели недоступно. Выберите модель в «Настройках».');
  }
  // Тихой подмены провайдера нет: неизвестный маршрут раньше молча уходил в Claude
  // (то есть тратил чужие деньги), а в чате и структурных вызовах — в LM Studio.
  if (route.provider !== 'claude') throw unknownProviderError(route.provider);
  if (!config.anthropicApiKey) throw new AiUnavailableError('Claude не настроен: нужен ANTHROPIC_API_KEY на сервере.');
  const claudeModel = route.model || config.anthropicModel; // выбранная в сессии модель Anthropic
  progress.set(sessionId, {
    phase: 'generating', model: claudeModel, provider: 'claude', role: 'analysis',
    label: `Claude (${claudeModel}) анализирует материалы…`,
  });
  // Стриминг: обязателен для больших max_tokens (иначе HTTP-таймаут) и даёт живой прогресс
  const response = await streamClaude({
    sessionId, signal,
    label: `Claude (${claudeModel}) анализирует материалы…`,
    params: {
      model: claudeModel,
      max_tokens: claudeMaxTokens(claudeModel),
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      output_config: { format: { type: 'json_schema', schema: RESPONSE_SCHEMA } },
      messages: sanitizeMessages(messages),
    },
  });
  recordUsage(sessionId, response.usage, { provider: 'claude', model: claudeModel });
  if (response.stop_reason === 'refusal') {
    throw new AiUnavailableError('Модель отклонила запрос по соображениям безопасности.');
  }
  const text = response.content.find((b) => b.type === 'text')?.text || '';
  return { text, truncated: response.stop_reason === 'max_tokens' };
}

/**
 * Gemini через собственный адаптер (services/ai/gemini.js). Наружу — тот же
 * контракт { text, truncated, reasoning }, что и у остальных провайдеров:
 * специфика формата, ошибок и размышлений заперта внутри адаптера (ТЗ, п. 55–58).
 */
async function callGemini({ system, messages, sessionId, route, signal, jsonSchema, maxTokens, internal = false }) {
  const gemini = require('../ai/gemini');
  const modelId = route.model || config.geminiModel || '';
  assertCloudAllowed('gemini', sessionId);
  progress.set(sessionId, {
    phase: 'generating', model: resolveModel(route), provider: 'gemini', role: 'analysis',
    label: `Gemini (${resolveModel(route)}) анализирует материалы…`, tokensOut: 0,
  });
  try {
    return await gemini.generate({
      system,
      messages: sanitizeMessages(messages),
      model: modelId,
      jsonSchema,
      maxTokens: maxTokens || registry.maxOutputTokens({ provider: 'gemini', model: modelId }),
      signal,
      onProgress: (tokens, thinking) => progress.set(sessionId, {
        phase: 'generating', model: resolveModel(route), provider: 'gemini',
        label: thinking ? 'Gemini размышляет…' : 'Gemini генерирует ответ…', tokensOut: tokens,
      }),
      onUsage: (usage) => recordUsage(sessionId, usage, { provider: 'gemini', model: resolveModel(route) }, { internal }),
    });
  } catch (err) {
    if (err && err.name === 'AbortError') throw err;
    logAiError({ where: 'gemini', status: err.status, kind: err.geminiKind, detail: String(err.message || '').slice(0, 1000) });
    throw new AiUnavailableError(err.message);
  }
}

/** Потолок выходных токенов модели Anthropic (исключения — в реестре возможностей). */
function claudeMaxTokens(model) {
  return registry.maxOutputTokens({ provider: 'claude', model });
}

/**
 * Стриминговый запрос к Claude с живым прогрессом (оценка ~3,5 симв/токен для
 * русского текста; точный расход берётся из usage финального сообщения).
 */
async function streamClaude({ params, sessionId, label, signal }) {
  assertCloudAllowed('claude', sessionId);
  // Anthropic просит помечать запросы обезличенным идентификатором конечного
  // пользователя — тогда срабатывание политики привязывается к нему, а не ко
  // всей организации. ФИО сюда не уходит: metadata.user_id — хэш.
  const endUser = cloudAccess.safetyIdentifier(sessionId);
  if (endUser && !params.metadata) params.metadata = { user_id: endUser };
  const stream = client().messages.stream(params, signal ? { signal } : undefined);
  let chars = 0;
  stream.on('text', (delta) => {
    chars += delta.length;
    progress.set(sessionId, {
      phase: 'generating', model: params.model, provider: 'claude',
      label, tokensOut: Math.round(chars / 3.5),
    });
  });
  return stream.finalMessage();
}

/** Правило компактности для локальных моделей — от фактического бюджета ответа. */
function compactRule(maxTokens) {
  return `\n\nЖёсткий бюджет ответа — ${Math.max(1000, maxTokens - 2000)} токенов, обрезанный JSON недопустим. Пиши компактно: ` +
    'report_markdown — не длиннее ~1200 слов (только существенное по шагам), message — 3–6 предложений, ' +
    'facts — не более 20, без повторов.';
}

/**
 * Блоки сообщения → content для OpenAI-совместимого API.
 *
 * Решает не бренд, а возможность зрения из реестра (registry.capabilities):
 * ChatGPT, Kimi и vision-модели LM Studio получают НАСТОЯЩУЮ картинку частью
 * `image_url` с data:URL — ровно так, как её шлёт services/doc-vision.js мимо
 * адаптера. Раньше плоский текст с пометкой «в локальном режиме не
 * анализируется» уходил ВСЕМ, и «вопрос по выделенной области» (ТЗ, п. 34)
 * молча превращался в вопрос без картинки, хотя интерфейс обещал обратное.
 *
 * Текстовая модель получает честную пометку — придумывать за неё нельзя.
 */
/**
 * Локальные движки (LM Studio, Ollama) строят из схемы формальную грамматику
 * и требуют, чтобы `type` был строкой: `{"type":["integer","null"]}` они
 * отвергают целиком — «ValueError: 'type' must be a string», а человек видит
 * «Модель вернула некорректный ответ». Облачные провайдеры такой союз
 * принимают, поэтому схему переписываем ТОЛЬКО для локальных.
 */
function isLocalGrammarEngine(providerId) {
  return providerId === 'lmstudio' || providerId === 'ollama' || providerId === 'local';
}

/** `type: ['integer','null']` → `anyOf: [{type:'integer'},{type:'null'}]` по всей схеме. */
function unionTypesToAnyOf(node) {
  if (Array.isArray(node)) return node.map(unionTypesToAnyOf);
  if (!node || typeof node !== 'object') return node;
  const out = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === 'type' && Array.isArray(value)) continue;
    out[key] = unionTypesToAnyOf(value);
  }
  if (Array.isArray(node.type)) out.anyOf = node.type.map((t) => ({ type: t }));
  return out;
}

function toOpenAiContent(content, vision) {
  if (typeof content === 'string') return content;
  const blocks = content || [];
  const asText = (b) => {
    if (b.type === 'text') return b.text;
    if (b.type === 'document') return `[PDF-документ «${b.title || 'без имени'}» — передан отдельно текстом]`;
    if (b.type === 'image' || b.type === 'image_url') return '[изображение не передано: выбранная модель не умеет работать с изображениями]';
    return '';
  };
  if (!vision) return blocks.map(asText).filter((t) => t && t.trim()).join('\n\n');

  const parts = [];
  for (const b of blocks) {
    if (b.type === 'image' && b.source && b.source.data) {
      const media = b.source.media_type || 'image/png';
      parts.push({ type: 'image_url', image_url: { url: `data:${media};base64,${b.source.data}` } });
    } else if (b.type === 'image_url' && b.image_url) {
      parts.push(b);
    } else {
      const text = asText(b);
      if (text && text.trim()) parts.push({ type: 'text', text });
    }
  }
  // картинок в сообщении не оказалось — не усложняем запрос массивом частей
  if (!parts.some((p) => p.type === 'image_url')) {
    return parts.map((p) => p.text).join('\n\n');
  }
  return parts;
}

const EMPTY_ASSISTANT_TEXT = '(модель не вернула текст)';

/**
 * Пустые сообщения строгие API отклоняют с 400 («the message at position N with
 * role 'assistant' must not be empty» у Moonshot, «text content blocks must be
 * non-empty» у Anthropic). Пустое сообщение пользователя ничего не несёт — его
 * выбрасываем; пустой ответ модели заменяем явной заглушкой, чтобы не сбить
 * чередование ролей. Источники пустоты: ответ рассуждающей модели, целиком
 * ушедший в размышления; сообщение из истории БД; блок-картинка, у которой в
 * локальном режиме нет текстового представления.
 */
function sanitizeMessages(messages) {
  const out = [];
  for (const m of messages) {
    if (typeof m.content === 'string') {
      if (m.content.trim()) out.push(m);
      else if (m.role === 'assistant') out.push({ ...m, content: EMPTY_ASSISTANT_TEXT });
      continue;
    }
    const blocks = (m.content || []).filter((b) => b.type !== 'text' || (b.text && b.text.trim()));
    if (blocks.length) out.push({ ...m, content: blocks });
    else if (m.role === 'assistant') out.push({ ...m, content: EMPTY_ASSISTANT_TEXT });
  }
  return out;
}

/* ---------- бюджет контекста: промпт + ответ должны помещаться в окно модели ---------- */
/**
 * Замер 2026-08-05: чистый русский текст в токенизаторе Qwen ≈ 2,5 симв/токен,
 * но реальный промпт (system + JSON + markdown + числа) показал 2,04 — берём 2,0
 * с запасом. Фактическое соотношение печатается в лог после каждого ответа.
 */
const CHARS_PER_TOKEN = 2.0;

/**
 * Длина содержимого в символах. У сообщения с картинкой content — массив частей;
 * картинка считается по грубой оценке 1500 токенов (иначе бюджет контекста
 * локальной модели врёт ровно на неё).
 */
const IMAGE_CHARS_EST = 3000;
function contentChars(content) {
  if (typeof content === 'string') return content.length;
  return (content || []).reduce(
    (s, b) => s + (b.type === 'text' ? String(b.text || '').length : IMAGE_CHARS_EST), 0,
  );
}

function messagesChars(messages) {
  return messages.reduce((s, m) => s + contentChars(m.content), 0);
}

/**
 * Усекает промпт до budgetChars, жертвуя в порядке важности:
 * старая история диалога → выдержки базы знаний → тексты документов → состояние сессии.
 * System (первое) и текущая инструкция (последнее сообщение) не трогаются.
 * Возвращает человекочитаемый список того, что было сокращено.
 */
function trimToBudget(messages, budgetChars) {
  const notes = [];
  const kindOf = (m) => {
    // у сообщения с картинкой content — массив частей: смотрим первую текстовую
    const head = typeof m.content === 'string'
      ? m.content.slice(0, 30)
      : String(((m.content || []).find((b) => b.type === 'text') || {}).text || '').slice(0, 30);
    if (head.startsWith('<session_state>')) return 'state';
    if (head.startsWith('<knowledge_base>')) return 'kb';
    if (head.startsWith('<uploaded_document')) return 'docs';
    return 'history';
  };
  const over = () => messagesChars(messages) - budgetChars;

  // 1) старые сообщения истории; system, финальная инструкция и последние 4 реплики сохраняются
  let removed = 0;
  while (over() > 0) {
    const history = messages
      .map((m, i) => ({ m, i }))
      .filter(({ m, i }) => i > 0 && i < messages.length - 1 && kindOf(m) === 'history');
    if (history.length <= 4) break;
    messages.splice(history[0].i, 1);
    removed++;
  }
  if (removed) notes.push(`убрано ${removed} старых сообщений истории`);

  // 2) выдержки базы знаний
  if (over() > 0) {
    const kb = messages.find((m) => kindOf(m) === 'kb' && typeof m.content === 'string');
    if (kb && kb.content.length > 8000) {
      kb.content = kb.content.slice(0, 8000) + '\n…[выдержки сокращены по лимиту контекста]\n</knowledge_base>';
      notes.push('сокращены выдержки базы знаний');
    }
  }

  // 3) тексты документов (усечение с конца, последние документы страдают первыми)
  if (over() > 0) {
    const docs = messages.find((m) => kindOf(m) === 'docs' && typeof m.content === 'string');
    if (docs && docs.content.length > 8000) {
      const keep = Math.max(8000, docs.content.length - over());
      if (keep < docs.content.length) {
        docs.content = docs.content.slice(0, keep) + '\n…[тексты документов обрезаны по лимиту контекста модели]';
        notes.push('усечены тексты документов');
      }
    }
  }

  // 4) состояние сессии — крайний случай
  if (over() > 0) {
    const st = messages.find((m) => kindOf(m) === 'state' && typeof m.content === 'string');
    if (st && st.content.length > 6000) {
      st.content = st.content.slice(0, 6000) + '\n…[состояние сокращено]\n</session_state>';
      notes.push('сокращено состояние сессии');
    }
  }
  return notes;
}

/**
 * Чтение SSE-потока /chat/completions; onToken(count, thinking) — для живого прогресса.
 * Размышления рассуждающих моделей (kimi-k3 и подобные) приходят отдельным полем
 * delta.reasoning_content и в text не попадают — иначе они ломают разбор JSON,
 * но считать их надо: они расходуют тот же бюджет выходных токенов.
 */
async function readSseStream(res, onToken) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '', text = '', reasoning = '', usage = null, finish = null, tokens = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      let obj;
      try { obj = JSON.parse(payload); } catch { continue; }
      const choice = obj.choices && obj.choices[0];
      const delta = choice?.delta?.content || '';
      const think = choice?.delta?.reasoning_content || choice?.delta?.reasoning || '';
      if (think) { reasoning += think; tokens++; onToken(tokens, true); }
      if (delta) { text += delta; tokens++; onToken(tokens, false); }
      if (choice?.finish_reason) finish = choice.finish_reason;
      if (obj.usage) usage = obj.usage;
    }
  }
  return { text, reasoning, usage, truncated: finish === 'length' };
}

/** Модели OpenAI, отклонившие параметр reasoning_effort (не отправлять повторно). */
const openaiNoReasoningEffort = new Set();

/**
 * progressStep — подпись шага для индикатора, когда вызов обслуживает НЕ основную
 * генерацию: распознавание страницы у doc-vision длится минуты, и без этого
 * карточка прогресса на каждой странице перескакивала с «Изучение документации»
 * на «Обработка запроса моделью» и обратно — семнадцать раз на один скан.
 */
async function callOpenAiCompat({ system, messages, sessionId, baseUrl, apiKey = '', model, provider = '', jsonSchema = true, maxTokens, stream = true, attempt = 1, logTrimEvent = true, signal = null, progressStep = null, internal = false }) {
  const modelId = model || config.localAiModel;
  const isLmStudio = baseUrl === config.localAiBaseUrl;
  const providerId = provider || (isLmStudio ? 'lmstudio' : 'openai-compat');
  assertCloudAllowed(providerId, sessionId);
  // облачным моделям даём не меньше 30 мин: генерация сотен тысяч токенов долгая
  const isCloud = providerId === 'chatgpt' || providerId === 'kimi';
  const timeoutMs = isCloud ? Math.max(config.localAiTimeoutMs, 1800000) : config.localAiTimeoutMs;

  // Явная загрузка модели с нужным контекстом (вместо непредсказуемого JIT):
  // при нехватке памяти менеджер осознанно выгружает другие модели.
  if (isLmStudio) {
    try {
      await modelManager.ensureLoaded(modelId, {
        signal,
        onProgress: (text) => {
          console.log('[model-manager]', text);
          progress.set(sessionId, { phase: 'loading_model', label: text, model: modelId, provider: 'lmstudio' });
        },
      });
    } catch (err) {
      if (signal && signal.aborted) throw Object.assign(new Error('Обработка прервана'), { name: 'AbortError' });
      console.warn('[model-manager]', err.message); // не фатально: сервер может догрузить JIT
    }
  }

  // Бюджет окна модели: у маленьких окон сначала ужимается ответ (max_tokens),
  // чтобы промпту гарантированно осталось не меньше четверти окна.
  const ctxTokens = isLmStudio ? modelManager.desiredContext(modelId) : 0;
  const reserveTokens = ctxTokens ? Math.max(2048, Math.round(ctxTokens * 0.05)) : 0;
  // бюджет ответа берётся из реестра: у облачных он ограничен потолком провайдера,
  // у локального сервера ниже зажимается под фактическое окно модели
  const modelCaps = registry.capabilities(providerId, modelId);
  let effMaxTokens = maxTokens
    || registry.maxOutputTokens({ provider: providerId, model: modelId })
    || config.localAiMaxTokens;
  if (ctxTokens && ctxTokens - effMaxTokens - reserveTokens < ctxTokens / 4) {
    effMaxTokens = Math.max(1024, ctxTokens - reserveTokens - Math.ceil(ctxTokens / 4));
  }

  // зрение спрашивается у реестра возможностей, а не у бренда провайдера
  const canSeeImages = !!modelCaps.vision;
  const body = {
    model: modelId,
    max_tokens: effMaxTokens,
    temperature: 0.2,
    messages: [
      { role: 'system', content: jsonSchema ? system + compactRule(effMaxTokens) : system },
      ...sanitizeMessages(messages.map((m) => ({ role: m.role, content: toOpenAiContent(m.content, canSeeImages) }))),
    ],
  };
  if (stream) {
    body.stream = true;
    body.stream_options = { include_usage: true };
  }
  // структурный вывод просим только у тех, кто его умеет (ТЗ, п. 57 и 72).
  // jsonSchema: true — схема анализа; {name, schema} — любая другая (правила ограничений и т.п.)
  if (jsonSchema && modelCaps.structuredOutput) {
    const spec = jsonSchema === true
      ? { name: 'genplan_analysis', schema: RESPONSE_SCHEMA }
      : jsonSchema;
    body.response_format = {
      type: 'json_schema',
      json_schema: {
        name: spec.name || 'structured_output',
        strict: true,
        // локальные движки строят грамматику из схемы и союз типов не понимают
        schema: isLocalGrammarEngine(providerId) ? unionTypesToAnyOf(spec.schema) : spec.schema,
      },
    };
  }

  // Бюджет контекста: промпт + max_tokens не должны превышать окно модели,
  // иначе LM Studio вернёт 400 или молча отбросит середину промпта.
  if (isLmStudio) {
    const budgetChars = Math.floor((ctxTokens - effMaxTokens - reserveTokens) * CHARS_PER_TOKEN);
    const beforeChars = messagesChars(body.messages);
    if (beforeChars > budgetChars) {
      const notes = trimToBudget(body.messages, budgetChars);
      const afterChars = messagesChars(body.messages);
      const detail = `${Math.round(beforeChars / 1000)} → ${Math.round(afterChars / 1000)} тыс. символов: ${notes.join('; ') || 'сокращать нечего'}`;
      console.warn(`[local-ai] промпт превышает контекст ${ctxTokens} токенов — ${notes.length ? 'усечён' : 'усечь не удалось'} (${detail})`);
      if (logTrimEvent && notes.length) {
        try {
          db.prepare('INSERT INTO events (session_id, stage, detail, level, created_at) VALUES (?,?,?,?,?)')
            .run(sessionId, 'Материалы сокращены под контекст модели', detail, 'warn', now());
        } catch { /* журнал не должен ронять обработку */ }
      }
    }
    // финальный зажим: ответу — не больше, чем осталось в окне после промпта
    const promptTokensEst = Math.ceil(messagesChars(body.messages) / CHARS_PER_TOKEN);
    const room = ctxTokens - promptTokensEst - reserveTokens;
    if (room < body.max_tokens) {
      body.max_tokens = Math.max(1024, room);
      if (jsonSchema) body.messages[0].content = system + compactRule(body.max_tokens);
    }
  }

  // Kimi K2.6+: temperature фиксирована моделью («only 1 is allowed») — не отправляем
  if (providerId === 'kimi') delete body.temperature;

  // OpenAI: современные модели принимают только max_completion_tokens
  // и температуру по умолчанию (нестандартная возвращает 400).
  // reasoning_effort=low экономит токены размышлений (входят в лимит ответа).
  if (providerId === 'chatgpt') {
    body.max_completion_tokens = body.max_tokens;
    delete body.max_tokens;
    delete body.temperature;
    if (config.openaiReasoningEffort && !openaiNoReasoningEffort.has(modelId)) {
      body.reasoning_effort = config.openaiReasoningEffort;
    }
    // Приложение с несколькими людьми обязано называть провайдеру конечного
    // пользователя: без этого любое срабатывание модерации у любого из них
    // ложится на организацию целиком. Уходит хэш, не ФИО. Поле отправляется
    // только OpenAI: у прочих OpenAI-совместимых его в контракте нет.
    const endUser = cloudAccess.safetyIdentifier(sessionId);
    if (endUser) body.safety_identifier = endUser;
  }

  progress.set(sessionId, {
    phase: progressStep ? progressStep.phase : 'waiting_model',
    model: modelId, provider: providerId,
    // Чем СЕЙЧАС занята показанная модель. Без этого распознавание сканов
    // выглядело как подмена: в журнале «анализ ведёт meta-llama-3.1-8b», а в
    // шапке прогресса — qwen3-vl-8b, потому что слепая модель не читает картинки
    // и страницы уходят локальной vision-модели. Модель не менялась — менялась
    // работа, и теперь это написано.
    role: progressStep ? (progressStep.role || 'ocr') : 'analysis',
    label: progressStep ? progressStep.label : `Запрос отправлен — модель ${modelId} обрабатывает контекст…`,
    tokensOut: 0,
  });

  // пока запрос выполняется, модель числится занятой — её нельзя вытеснять из памяти
  if (isLmStudio) modelManager.acquireUse(modelId);
  try {

  let res;
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const fetchSignal = signal
    ? AbortSignal.any([AbortSignal.timeout(timeoutMs), signal])
    : AbortSignal.timeout(timeoutMs);
  try {
    res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: fetchSignal,
    });
  } catch (err) {
    if (signal && signal.aborted) {
      throw Object.assign(new Error('Обработка прервана'), { name: 'AbortError' });
    }
    const host = baseUrl.replace(/https?:\/\//, '').split('/')[0];
    // «локальность» определяет ПРОВАЙДЕР, а не адрес: облачный провайдер на
    // корпоративном прокси 127.0.0.1 — всё равно облачный
    const isLocal = LOCAL_PROVIDERS.has(providerId);
    const label = providerLabel(providerId);
    const waited = humanDuration(timeoutMs);
    if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      throw new AiUnavailableError(isLocal
        ? `Локальная нейросеть сейчас недоступна: не ответила за ${waited} — вероятно, занята другой задачей. Повторите позже.`
        : `${label} не ответил за ${waited} (${host}). Запрос прерван по таймауту — повторите позже или выберите модель побыстрее.`);
    }
    throw new AiUnavailableError(isLocal
      ? 'Локальная нейросеть сейчас недоступна: сервер моделей (LM Studio/Ollama) не запущен. Запустите его или выберите облачную модель в «Настройках» — и повторите.'
      : `Соединение с ${label} оборвалось (${host}: ${redactSecrets(String(err && err.message || 'сеть недоступна')).slice(0, 120)}). ` +
        'Проверьте доступ в интернет и повторите попытку.');
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    logAiError({ where: 'chat/completions', provider: providerId, status: res.status, model: modelId, baseUrl, attempt, detail: redactSecrets(detail).slice(0, 2000) });
    // Модель выгружена/не найдена — загружаем через менеджер и повторяем.
    // Только для локальных серверов: у облака «model not found» повтором не лечится,
    // а пауза 15 и 30 с превращала мгновенную ошибку в минуту ожидания.
    if (LOCAL_PROVIDERS.has(providerId)
      && /unload|not loaded|no models? loaded|model.*not found|failed to load/i.test(detail) && attempt <= 2) {
      console.warn(`[local-ai] модель недоступна, повтор ${attempt}/2 после явной загрузки`);
      if (signal && signal.aborted) throw Object.assign(new Error('Обработка прервана'), { name: 'AbortError' });
      if (isLmStudio) {
        try {
          await modelManager.ensureLoaded(modelId, {
            signal,
            onProgress: (text) => progress.set(sessionId, { phase: 'loading_model', label: text, model: modelId }),
          });
        } catch (err) {
          if (signal && signal.aborted) throw Object.assign(new Error('Обработка прервана'), { name: 'AbortError' });
          console.warn('[model-manager]', err.message);
        }
      } else {
        await new Promise((r) => setTimeout(r, attempt * 15000));
      }
      return callOpenAiCompat({ system, messages, sessionId, baseUrl, apiKey, model, provider: providerId, jsonSchema, maxTokens, stream, attempt: attempt + 1, logTrimEvent: false, signal, progressStep, internal });
    }
    // запрошенный лимит больше потолка модели — повтор с её собственным потолком
    const capMatch = detail.match(/(?:at most|maximum(?: of)?|<=)\s*(\d{4,})/i);
    if (providerId === 'chatgpt' && /max_(completion_)?tokens/i.test(detail) && capMatch && attempt <= 2) {
      const cap = parseInt(capMatch[1], 10);
      if (cap > 0 && cap < effMaxTokens) {
        console.warn(`[openai] модель ${modelId} поддерживает максимум ${cap} выходных токенов — повтор с этим лимитом`);
        return callOpenAiCompat({ system, messages, sessionId, baseUrl, apiKey, model, provider: providerId, jsonSchema, maxTokens: cap, stream, attempt: attempt + 1, logTrimEvent: false, signal, progressStep, internal });
      }
    }
    // модель не принимает reasoning_effort — запомнить и повторить без него
    if (providerId === 'chatgpt' && /reasoning[._]?effort/i.test(detail) && !openaiNoReasoningEffort.has(modelId)) {
      openaiNoReasoningEffort.add(modelId);
      return callOpenAiCompat({ system, messages, sessionId, baseUrl, apiKey, model, provider: providerId, jsonSchema, maxTokens, stream, attempt, logTrimEvent: false, signal, progressStep, internal });
    }
    // сервер не понял параметры стриминга — повтор без стриминга
    if (stream && /stream/i.test(detail)) {
      return callOpenAiCompat({ system, messages, sessionId, baseUrl, apiKey, model, provider: providerId, jsonSchema, maxTokens, stream: false, attempt, logTrimEvent: false, signal, progressStep, internal });
    }
    // некоторые модели не принимают json_schema — один повтор в режиме «просто JSON»
    if (jsonSchema && /json_schema|response_format|structured/i.test(detail)) {
      return callOpenAiCompat({
        system: system + '\n\nОтвечай ТОЛЬКО валидным JSON строго по описанной схеме, без пояснений вокруг.',
        messages, sessionId, baseUrl, apiKey, model, provider: providerId, jsonSchema: false, maxTokens, stream, logTrimEvent: false, signal, progressStep, internal,
      });
    }
    throw new AiUnavailableError(humanizeProviderError(providerId, res.status, detail));
  }

  let text, reasoning = '', usage, truncated;
  if (stream) {
    ({ text, reasoning, usage, truncated } = await readSseStream(res, (tokens, thinking) => {
      progress.set(sessionId, {
        phase: progressStep ? progressStep.phase : 'generating',
        model: modelId, provider: providerId,
        label: progressStep ? progressStep.label
          : thinking ? `Модель ${modelId} размышляет…` : `Модель ${modelId} генерирует ответ…`,
        tokensOut: tokens,
      });
    }).catch((err) => {
      if (signal && signal.aborted) {
        throw Object.assign(new Error('Обработка прервана'), { name: 'AbortError' });
      }
      if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
        throw new AiUnavailableError(`${providerLabel(providerId)}: модель ${modelId} не успела завершить ответ за ${humanDuration(timeoutMs)}. Повторите или упростите задачу.`);
      }
      throw new AiUnavailableError(`Соединение с ${providerLabel(providerId)} оборвалось на середине ответа: ${redactSecrets(String(err && err.message || '')).slice(0, 120)}. Повторите попытку.`);
    }));
  } else {
    const data = await res.json();
    const choice = data.choices && data.choices[0];
    text = choice?.message?.content || '';
    reasoning = choice?.message?.reasoning_content || '';
    truncated = choice?.finish_reason === 'length';
    usage = data.usage;
  }
  recordUsage(sessionId, {
    input_tokens: usage?.prompt_tokens || 0,
    output_tokens: usage?.completion_tokens || 0,
  }, { provider: providerId, model: modelId }, { internal });
  if (isLmStudio && usage?.prompt_tokens) {
    // калибровка оценки CHARS_PER_TOKEN по фактическому расходу токенов
    const sentChars = messagesChars(body.messages);
    console.log(`[local-ai] калибровка: ${(sentChars / usage.prompt_tokens).toFixed(2)} симв/токен (промпт ${usage.prompt_tokens} ток., ${Math.round(sentChars / 1000)} тыс. симв.)`);
  }
  return { text, truncated, reasoning };

  } finally {
    if (isLmStudio) modelManager.releaseUse(modelId);
  }
}

/**
 * «Изучение документации»: сканы и графика распознаются vision-моделью ДО того,
 * как документы уйдут текстом.
 *
 * Вынесено из runAnalysis отдельной функцией потому, что распознавание нужно не
 * одному анализу. Извлечение координат границы участка (geometry/parcel-source)
 * и извлечение ограничений работают с теми же документами — а на живом прогоне
 * выяснилось, что без этого вызова модель получает ПУСТОЙ текстовый слой скана
 * и честно отвечает «таблицы координат в документе нет», хотя таблица есть на
 * первой же странице. Раньше это скрывал порядок этапов: анализ шёл первым и
 * прогревал кэш распознавания. Прямой вызов маршрута такой гарантии не даёт.
 *
 * Повторный вызов ничего не стоит: doc-vision держит кэш распознанных страниц.
 */
async function ensureDocumentsStudied(sessionId, { route, signal = null, docMode = null } = {}) {
  const mode = docMode || registry.documentMode(route);
  if (mode !== 'extracted' || !route || route.provider === 'demo') return { pages: 0, skipped: true };
  try {
    const done = await require('../doc-vision').extractGraphics(sessionId, {
      signal, route,
      // распознаёт выбранная модель; локальная — только если распознавания нет.
      // Подпись показывает того, кто ведёт ИМЕННО ЭТУ страницу, а не провайдера сессии
      onProgress: (label, by) => progress.set(sessionId, {
        phase: 'reading_docs', label, role: 'ocr',
        model: (by && by.model) || config.localAiOcrModel,
        provider: (by && by.provider) || 'lmstudio',
      }),
    });
    if (done.pages) {
      logRow(sessionId, 'Документация изучена vision-моделью',
        `файлов: ${done.files}, страниц: ${done.pages}; распознавали: ${(done.by || []).join(', ') || '—'}`);
    }
    // переход на локальную модель — отдельная строка журнала: иначе расхождение
    // «в проекте выбран ChatGPT, а скан читал qwen3-vl-8b» видно только по подписи в кэше
    if (done.fellBack) {
      logRow(sessionId, 'Распознавание передано локальной модели',
        `выбранная модель ${done.primary} не справилась со страницами — часть скана прочитала ${config.localAiOcrModel}`,
        'warn');
    }
    // Неудачное распознавание больше не выглядит успехом: раньше событие писалось
    // только при pages>0, поэтому полный провал OCR не оставлял в журнале следа
    // вообще — а его результат («страница не распозналась: fetch failed») уходил
    // модели под шапкой «распознано vision-моделью».
    if (done.failed && done.failed.length) {
      logRow(sessionId, 'Часть документации не распозналась',
        `не удалось: ${done.failed.join(', ')} — эти файлы уйдут модели без распознанного содержимого`,
        'warn');
    }

    /*
     * Распознавание кончилось — модель распознавания уходит из памяти.
     *
     * Это вторая половина поочерёдной работы: мало грузить по одной, надо ещё и
     * освобождать сразу, а не держать занятыми 15 ГБ до следующей загрузки.
     * Чат-модель тогда грузится в пустую память, а не выталкивает соседку —
     * на 48 ГБ разница между «загрузилось» и «ушло в подкачку».
     *
     * Выгружаем ТОЛЬКО ту модель, что действительно вела распознавание, и только
     * если следующей работать не ей: doc-vision возвращает поимённый список в
     * `by` («lmstudio/qwen/qwen3-vl-8b»). Занятую модель model-manager.unload
     * не тронет сам — параллельная задача иначе получит «Model unloaded».
     */
    if (config.localAiExclusive) {
      const next = route.provider === 'lmstudio' ? resolveModel(route) : '';
      const used = [...new Set((done.by || [])
        .filter((s) => String(s).startsWith('lmstudio/'))
        .map((s) => String(s).slice('lmstudio/'.length)))];
      for (const m of used) {
        if (!m || m === next) continue;
        await modelManager.unload(m, {
          onProgress: (text) => progress.set(sessionId, { phase: 'reading_docs', label: text, role: 'ocr' }),
        }).catch(() => {});
      }
    }
    return done;
  } catch (err) {
    // исчерпанный бюджет обязан дойти до человека своим текстом, а не превратиться
    // в «изучение графики не удалось»: теперь распознавание тратит деньги проекта
    if ((signal && signal.aborted) || err instanceof BudgetExceededError) throw err;
    console.warn('[doc-vision]', err.message);
    logRow(sessionId, 'Изучение графики не удалось', String(err.message || '').slice(0, 200), 'warn');
    return { pages: 0, error: err.message };
  }
}

/** Строка журнала проекта. Журнал не критичен: его отказ не роняет работу. */
function logRow(sessionId, stage, detail = '', level = 'info') {
  try {
    db.prepare('INSERT INTO events (session_id, stage, detail, level, created_at) VALUES (?,?,?,?,?)')
      .run(sessionId, stage, detail, level, now());
  } catch { /* журнал не критичен */ }
}

/**
 * One analysis step. Builds the working context, calls Claude (or the mock),
 * validates the structured answer, retries once on invalid structure.
 */
async function runAnalysis(sessionId, { instruction, signal }) {
  const session0 = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
  return analyzeOnce(sessionId, { instruction, route: effectiveProvider(session0), signal });
}

/** Один прогон анализа с явным маршрутом (используется и обычной обработкой, и сравнением моделей). */
async function analyzeOnce(sessionId, { instruction, route, signal }) {
  // неизвестный маршрут отбивается ДО распознавания документов и конспектов:
  // иначе на него тратятся минуты работы, чтобы упасть на последнем шаге
  if (!route || !ROUTABLE_PROVIDERS.has(route.provider)) throw unknownProviderError(route && route.provider);
  const session0 = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
  const docMode = registry.documentMode(route); // 'native' | 'extracted' — по возможностям модели
  progress.set(sessionId, {
    phase: 'preparing', provider: route.provider, model: resolveModel(route),
    label: 'Подготовка контекста: документы, факты, история диалога', tokensOut: 0,
  });

  // «Изучение документации»: графика и сканы распознаются vision-моделью до анализа
  await ensureDocumentsStudied(sessionId, { route, signal, docMode });

  // По-документный анализ: каждый объёмный документ конспектируется ОТДЕЛЬНЫМ
  // запросом (кэш <файл>.digest.md); итоговый запрос получает конспекты вместо
  // полных текстов — это обходит лимиты контекста и выходных токенов модели.
  if (route.provider !== 'demo') {
    try {
      const dg = await require('../doc-digest').ensureDigests(sessionId, {
        route, signal,
        onProgress: (label) => progress.set(sessionId, {
          phase: 'reading_docs', label, model: resolveModel(route), provider: route.provider,
        }),
      });
      if (dg.made) {
        try {
          db.prepare('INSERT INTO events (session_id, stage, detail, level, created_at) VALUES (?,?,?,?,?)')
            .run(sessionId, 'Документы законспектированы по-отдельности',
              `отдельных запросов: ${dg.made} (обход лимита токенов)`, 'info', now());
        } catch { /* журнал не критичен */ }
      }
    } catch (err) {
      if ((signal && signal.aborted) || err instanceof BudgetExceededError) throw err;
      console.warn('[doc-digest]', err.message);
    }
  }

  const ctx = await buildContext(sessionId, docMode);
  checkBudget(ctx.session);

  if (route.provider === 'demo') {
    progress.set(sessionId, { phase: 'generating', label: 'Демо-режим: формирование тестового ответа' });
    return mock.runAnalysis(sessionId, ctx, instruction);
  }

  const messages = [];
  if (ctx.stateText) messages.push({ role: 'user', content: `<session_state>\n${ctx.stateText}\n</session_state>` });

  // RAG: релевантные пункты нормативной базы (если KB_DIR настроен и проиндексирован)
  try {
    progress.set(sessionId, { phase: 'retrieving', label: 'Поиск релевантных пунктов в базе знаний…' });
    const kb = require('../kb');
    const facts = db.prepare('SELECT key, value FROM facts WHERE session_id = ? LIMIT 20').all(sessionId);
    const kbQuery = [
      instruction,
      ctx.session.comment,
      ...facts.map((f) => `${f.key} ${f.value}`),
    ].join(' ').slice(0, 1500);
    const excerpts = await kb.excerptsFor(kbQuery, (session0 && session0.kb_choice) || 'main');
    if (excerpts) messages.push({ role: 'user', content: `<knowledge_base>\n${excerpts}\n</knowledge_base>` });
  } catch (err) {
    console.warn('[kb] excerpts skipped:', err.message);
  }

  /*
   * Порядок работы уходит модели ВСЕГДА — и стандартный, и загруженный человеком.
   *
   * Прежде блок посылался только для своего файла, а стандартный порядок жил
   * отдельным списком в системном промпте. Списки разъехались: в настройках
   * показывалось «стандартные (14)», в промпте стояли двенадцать пунктов, и
   * сообщение в ленте обещало «методику 12 шагов». По какому из трёх списков
   * идёт разбор, было не установить. Источник теперь один — services/workplan.js.
   */
  try {
    const workplan = require('../workplan');
    const wp = workplan.forSession(ctx.session);
    messages.push({ role: 'user', content: `<workplan>\n${workplan.promptText(wp)}\n</workplan>` });
  } catch (err) { console.warn('[workplan]', err.message); }

  if (ctx.docBlocks.length) messages.push({ role: 'user', content: ctx.docBlocks });
  for (const m of ctx.history) messages.push(m);
  messages.push({ role: 'user', content: instruction });

  /*
   * Бюджет обращений на один анализ.
   *
   * Раньше он был один на всё — и склейка обрезанного ответа тратила его
   * наравне с повторными попытками. Локальная 8B-модель упирается в лимит
   * выходных токенов штатно: 1 вызов + 2 продолжения + 1 повтор = 4 из 4, и
   * прогон заканчивался надписью «Потрачено обращений к модели: 4 из 4» вместо
   * отчёта. Так завершились пять прогонов из десяти в проверке «Вариант 2».
   *
   * Касса осталась общей — она обязана быть предсказуемо конечной, иначе
   * безнадёжный прогон уходит в десятки вызовов. Изменились две вещи: потолок
   * задаётся в .env и по умолчанию втрое выше, а каждый следующий повтор требует
   * ответа резко компактнее предыдущего (COMPACT ниже). Одного повтора «сделай
   * короче» модели обычно не хватает, трёх — хватает почти всегда.
   */
  const calls = { left: MAX_ANALYSIS_CALLS, used: 0 };
  const callWithBudget = async (msgs) => {
    if (calls.left <= 0) return null;
    calls.left--; calls.used++;
    try {
      return await callModel({ system: SYSTEM_PROMPT, messages: msgs, sessionId, route, signal });
    } catch (err) {
      throw wrapApiError(err);
    }
  };

  let out = await callWithBudget(messages);
  out = await continueIfTruncated(out, { system: SYSTEM_PROMPT, messages, sessionId, route, signal, calls });

  progress.set(sessionId, { phase: 'validating', label: 'Проверка структуры ответа модели…' });
  let parsed = tryParse(out.text);
  let check = validateResponse(parsed);

  /*
   * Повторы после неудачной проверки. Один повтор — это ставка на удачу: если
   * модель обрезала ответ, ей нужно сказать «короче», и часто со второго раза
   * длина уже укладывается. Поэтому повторов несколько, и каждый следующий
   * требует ответа компактнее предыдущего.
   */
  const COMPACT = [
    'Твой предыдущий ответ был обрезан по лимиту токенов и JSON не завершился. Сформируй ответ заново, значительно компактнее: report_markdown — не длиннее ~800 слов, message — 3–5 предложений, facts — только ключевые. Верни полный валидный JSON.',
    'Ответ снова не поместился. Сократи РЕЗКО: report_markdown — не длиннее ~300 слов и только по существу, message — 2 предложения, facts — не больше 15 самых важных, questions — не больше 3. Верни полный валидный JSON.',
    'Ответ по-прежнему не помещается. Выдай МИНИМАЛЬНЫЙ допустимый ответ: report_markdown — 5–7 строк, message — одно предложение, facts — не больше 8, остальные массивы пустые. Полный валидный JSON и ничего больше.',
  ];
  let retry = 0;
  while (!check.ok && calls.left > 0) {
    progress.set(sessionId, {
      phase: 'validating',
      label: `Ответ не прошёл проверку схемы — повторный запрос (${retry + 1} из ${MAX_ANALYSIS_CALLS - 1})…`,
    });
    const session2 = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
    checkBudget(session2);
    const correction = out.truncated
      ? COMPACT[Math.min(retry, COMPACT.length - 1)]
      : `Твой предыдущий ответ не прошёл валидацию схемы (${check.error}). Верни корректный JSON строго по схеме, без пояснений и без текста вокруг него.`;
    messages.push({ role: 'assistant', content: out.text.slice(0, 6000) || '(пустой ответ)' });
    messages.push({ role: 'user', content: correction });
    out = await callWithBudget(messages);
    if (!out) break; // касса кончилась ровно на этом повторе
    out = await continueIfTruncated(out, { system: SYSTEM_PROMPT, messages, sessionId, route, signal, calls });
    parsed = tryParse(out.text);
    check = validateResponse(parsed);
    retry++;
  }

  if (!check.ok) {
    const spent = `Сделано попыток: ${calls.used} из ${MAX_ANALYSIS_CALLS} (потолок задаётся MAX_ANALYSIS_CALLS в .env).`;
    if (!out.text.trim() && (out.reasoning || '').trim()) {
      const env = maxTokensEnv(route.provider);
      throw new AiUnavailableError(
        `Модель ${resolveModel(route)} израсходовала весь бюджет ответа на размышления и не выдала текст. ` +
        `${env ? `Увеличьте лимит выходных токенов (${env} в .env) или выберите` : 'Выберите'} модель без развёрнутых рассуждений. ${spent}`,
      );
    }
    throw new AiUnavailableError(out.truncated
      ? `Ответ модели не помещается в лимит выходных токенов даже в самом кратком виде. `
        + `Увеличьте ${maxTokensEnv(route.provider) || 'лимит выходных токенов'} в .env или возьмите модель с большим окном. ${spent}`
      : `Модель вернула ответ, который не удалось разобрать по схеме, ни с первой попытки, ни с повторных. `
        + `Чаще всего это признак того, что модель слишком мала для такого объёма документов — попробуйте более сильную. ${spent}`);
  }
  return check.value;
}

/**
 * Обход лимита выходных токенов: если ответ обрезан (stop max_tokens),
 * дозапрашиваем продолжение с места обрыва и склеиваем текст в один.
 *
 * Число дозапросов ограничено и MAX_CONTINUATIONS, и общей кассой обращений на
 * анализ (calls): дозапрос — такой же платный вызов, как основной, и безнадёжный
 * прогон обязан кончаться, а не уходить в десятки запросов.
 */
async function continueIfTruncated(out, { system, messages, sessionId, route, signal, calls = null }) {
  let combined = out;
  if (!combined) return combined;
  for (let i = 0; combined.truncated && i < MAX_CONTINUATIONS; i++) {
    if (calls && calls.left <= 0) break;
    progress.set(sessionId, {
      phase: 'generating', model: resolveModel(route), provider: route.provider,
      label: `Ответ упёрся в лимит токенов — дозапрашиваю продолжение (${i + 1}/${MAX_CONTINUATIONS})…`,
    });
    const session2 = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
    checkBudget(session2);
    // Рассуждающая модель может истратить весь бюджет на размышления и не выдать
    // ни одного символа. Продолжать тогда нечего (и пустое сообщение assistant
    // строгие API отклоняют с 400) — просим ответить сразу, без рассуждений.
    const contMessages = combined.text.trim()
      ? [
        ...messages,
        { role: 'assistant', content: combined.text },
        { role: 'user', content: 'Твой ответ оборван лимитом выходных токенов. ПРОДОЛЖИ его ровно с места обрыва: без повторения уже выданного текста, без преамбул и пояснений — только продолжение.' },
      ]
      : [
        ...messages,
        { role: 'user', content: 'Прошлая попытка целиком ушла на размышления и не дала ни одного символа ответа — весь бюджет выходных токенов был исчерпан. Не рассуждай развёрнуто: сразу выдай итоговый ответ, максимально компактно.' },
      ];
    let cont;
    if (calls) { calls.left--; calls.used++; }
    try {
      cont = await callModel({ system, messages: contMessages, sessionId, route, signal });
    } catch (err) {
      throw wrapApiError(err);
    }
    combined = {
      text: combined.text + cont.text,
      truncated: cont.truncated,
      reasoning: cont.reasoning || combined.reasoning,
    };
  }
  return combined;
}

/**
 * Структурный вызов с ПРОИЗВОЛЬНОЙ JSON-схемой. Нужен всюду, где ответ модели
 * должен быть машинно-разбираемым: правила ограничений, классификация объектов,
 * мероприятия. Возвращает { text, truncated, reasoning } — разбор и валидация
 * остаются за вызывающим, который знает свою схему.
 */
async function structuredCall({ system, messages, sessionId, route, signal, schema, schemaName = 'structured_output', maxTokens }) {
  if (route.provider === 'claude') {
    if (!config.anthropicApiKey) throw new AiUnavailableError('Claude не настроен: нужен ANTHROPIC_API_KEY на сервере.');
    const claudeModel = route.model || config.anthropicModel;
    const response = await streamClaude({
      sessionId, signal,
      label: `Claude (${claudeModel}) готовит структурированный ответ…`,
      params: {
        model: claudeModel,
        max_tokens: Math.min(maxTokens || config.anthropicMaxTokens, claudeMaxTokens(claudeModel)),
        system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
        output_config: { format: { type: 'json_schema', schema } },
        messages: sanitizeMessages(messages),
      },
    });
    recordUsage(sessionId, response.usage, { provider: 'claude', model: claudeModel });
    return {
      text: response.content.find((b) => b.type === 'text')?.text || '',
      truncated: response.stop_reason === 'max_tokens',
    };
  }
  if (route.provider === 'gemini') {
    return callGemini({ system, messages, sessionId, route, signal, jsonSchema: schema, maxTokens });
  }
  const opts = { system, messages, sessionId, jsonSchema: { name: schemaName, schema }, maxTokens, signal };
  if (route.provider === 'chatgpt') {
    if (!config.openaiApiKey) throw new AiUnavailableError('ChatGPT не настроен: нужен OPENAI_API_KEY на сервере.');
    return callOpenAiCompat({ ...opts, baseUrl: config.openaiBaseUrl, apiKey: config.openaiApiKey, model: route.model || config.openaiModel, provider: 'chatgpt' });
  }
  if (route.provider === 'kimi') {
    if (!config.kimiApiKey) throw new AiUnavailableError('Kimi не настроен: нужен KIMI_API_KEY на сервере.');
    return callOpenAiCompat({ ...opts, baseUrl: config.kimiBaseUrl, apiKey: config.kimiApiKey, model: route.model || config.kimiModel, provider: 'kimi' });
  }
  if (route.provider === 'ollama') {
    return callOpenAiCompat({ ...opts, baseUrl: config.ollamaBaseUrl, model: route.model, provider: 'ollama' });
  }
  if (route.provider === 'lmstudio') {
    return callOpenAiCompat({ ...opts, baseUrl: config.localAiBaseUrl, model: route.model || config.localAiModel, provider: 'lmstudio' });
  }
  if (route.provider === 'openai-compat') {
    return callOpenAiCompat({ ...opts, baseUrl: config.localAiBaseUrl, model: route.model, provider: 'openai-compat' });
  }
  if (route.provider === 'demo') {
    throw new AiUnavailableError('Демо-режим: структурированный разбор недоступен без настроенной модели.');
  }
  // неизвестный маршрут раньше молча уходил в LM Studio — теперь это явная ошибка
  throw unknownProviderError(route.provider);
}

/**
 * Обычный текстовый запрос без JSON-схемы (свободный чат, конспекты документов).
 * Возвращает { text, truncated }.
 */
async function plainCall({ system, messages, sessionId, route, signal, maxTokens, progressStep = null, internal = false }) {
  if (route.provider === 'claude') {
    if (!config.anthropicApiKey) throw new AiUnavailableError('Claude не настроен: нужен ANTHROPIC_API_KEY на сервере.');
    const claudeModel = route.model || config.anthropicModel;
    const response = await streamClaude({
      sessionId, signal,
      label: `Claude (${claudeModel}) готовит текст…`,
      params: {
        model: claudeModel,
        max_tokens: Math.min(maxTokens || config.anthropicMaxTokens, claudeMaxTokens(claudeModel)),
        system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
        messages: sanitizeMessages(messages),
      },
    });
    recordUsage(sessionId, response.usage, { provider: 'claude', model: claudeModel }, { internal });
    if (response.stop_reason === 'refusal') {
      throw new AiUnavailableError('Модель отклонила запрос по соображениям безопасности.');
    }
    return {
      text: response.content.find((b) => b.type === 'text')?.text || '',
      truncated: response.stop_reason === 'max_tokens',
    };
  }
  if (route.provider === 'gemini') {
    return callGemini({ system, messages, sessionId, route, signal, jsonSchema: null, maxTokens, internal });
  }
  const opts = { system, messages, sessionId, jsonSchema: false, maxTokens, signal, progressStep, internal };
  if (route.provider === 'chatgpt') {
    if (!config.openaiApiKey) throw new AiUnavailableError('ChatGPT не настроен: нужен OPENAI_API_KEY на сервере.');
    return callOpenAiCompat({ ...opts, baseUrl: config.openaiBaseUrl, apiKey: config.openaiApiKey, model: route.model || config.openaiModel, provider: 'chatgpt' });
  }
  if (route.provider === 'kimi') {
    if (!config.kimiApiKey) throw new AiUnavailableError('Kimi не настроен: нужен KIMI_API_KEY на сервере.');
    return callOpenAiCompat({ ...opts, baseUrl: config.kimiBaseUrl, apiKey: config.kimiApiKey, model: route.model || config.kimiModel, provider: 'kimi' });
  }
  if (route.provider === 'ollama') {
    return callOpenAiCompat({ ...opts, baseUrl: config.ollamaBaseUrl, model: route.model, provider: 'ollama' });
  }
  if (route.provider === 'lmstudio') {
    return callOpenAiCompat({ ...opts, baseUrl: config.localAiBaseUrl, model: route.model || config.localAiModel, provider: 'lmstudio' });
  }
  if (route.provider === 'openai-compat') {
    return callOpenAiCompat({ ...opts, baseUrl: config.localAiBaseUrl, model: route.model, provider: 'openai-compat' });
  }
  // Демо-режим обещает «без AI» — а раньше plainCall (в отличие от structuredCall
  // и chatOnce) молча грузил локальную LM Studio и занимал её единственный слот.
  if (route.provider === 'demo') {
    throw new AiUnavailableError('Демо-режим: обращение к модели недоступно. Выберите модель в «Настройках».');
  }
  throw unknownProviderError(route.provider);
}

/* ---------------- свободный чат (без 12-шагового пайплайна) ---------------- */
const CHAT_SYSTEM =
  'Ты — помощник Enso-nexus по градостроительному проектированию (генплан, посадка зданий на участок, ' +
  'ГОСТ 21.508, СП 42.13330, пожарные и санитарные разрывы). Это СВОБОДНЫЙ ДИАЛОГ: отвечай на вопросы ' +
  'пользователя обычным текстом на русском языке (Markdown), по делу и без воды. НЕ выполняй полный ' +
  '12-шаговый анализ и НЕ возвращай JSON. Опирайся на материалы сессии (документы, факты, историю), ' +
  'когда они относятся к вопросу; можно обсуждать и общие темы. Если пользователю нужен полный анализ ' +
  'с отчётом — предложи нажать «Запустить анализ»: отдельного режима сообщений в интерфейсе нет.';

/**
 * Один ответ в свободном диалоге: обычный текст, без JSON-схемы и выходных
 * документов. Использует контекст сессии (документы, факты, история, база знаний).
 */
async function chatOnce(sessionId, { text, route, signal }) {
  if (!route || !ROUTABLE_PROVIDERS.has(route.provider)) throw unknownProviderError(route && route.provider);
  const session0 = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
  const docMode = registry.documentMode(route);
  progress.set(sessionId, {
    phase: 'preparing', provider: route.provider, model: resolveModel(route),
    label: 'Подготовка контекста диалога…', tokensOut: 0,
  });

  // история диалога проекта целиком; состояние проекта — через session_state
  const ctx = await buildContext(sessionId, docMode);
  checkBudget(ctx.session);

  if (route.provider === 'demo') {
    return 'Демо-режим: свободный диалог недоступен без настроенной AI-модели. ' +
      'Выберите облачную или локальную модель в «Настройках».';
  }

  const messages = [];
  if (ctx.stateText) messages.push({ role: 'user', content: `<session_state>\n${ctx.stateText}\n</session_state>` });
  try {
    progress.set(sessionId, { phase: 'retrieving', label: 'Поиск в базе знаний…' });
    const kb = require('../kb');
    const excerpts = await kb.excerptsFor(text.slice(0, 1500), (session0 && session0.kb_choice) || 'main');
    if (excerpts) messages.push({ role: 'user', content: `<knowledge_base>\n${excerpts}\n</knowledge_base>` });
  } catch (err) {
    console.warn('[kb] chat excerpts skipped:', err.message);
  }
  if (ctx.docBlocks.length) messages.push({ role: 'user', content: ctx.docBlocks });
  for (const m of ctx.history) messages.push(m);
  messages.push({ role: 'user', content: text });

  try {
    // единая точка текстовых вызовов: Claude (стриминг), ChatGPT, Kimi, LM Studio, Ollama
    const out = await plainCall({ system: CHAT_SYSTEM, messages, sessionId, route, signal });
    const reply = (out.text || '').trim();
    if (reply) return reply;
    if ((out.reasoning || '').trim()) {
      const env = maxTokensEnv(route.provider);
      return `Модель ${resolveModel(route)} израсходовала весь бюджет ответа на размышления и не выдала текст. ` +
        `Повторите вопрос покороче, ${env ? `увеличьте лимит выходных токенов (${env} в .env) ` : ''}` +
        'или выберите модель без развёрнутых рассуждений.';
    }
    return '(пустой ответ)';
  } catch (err) {
    throw wrapApiError(err);
  }
}

function tryParse(text) {
  try { return JSON.parse(text); } catch {}
  // structure recovery: extract the outermost JSON object
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(text.slice(start, end + 1)); } catch {}
  }
  return null;
}

/** Compact conversation memory when history grows. Stores rolling summary in the session row. */
async function maybeCompact(sessionId) {
  const count = db.prepare('SELECT COUNT(*) AS c FROM messages WHERE session_id = ?').get(sessionId).c;
  if (count < config.compactAfterMessages) return;
  const ctx = await buildContext(sessionId, config.aiMode === 'local' ? 'extracted' : 'native');
  if (config.aiMode === 'mock') {
    const summary = mock.summarize(ctx);
    db.prepare('UPDATE sessions SET summary = ?, updated_at = ? WHERE id = ?').run(summary, now(), sessionId);
    return;
  }
  try {
    checkBudget(ctx.session);
    const system = 'Сожми диалог в резюме для памяти AI-ассистента по генплану. Сохрани: требования пользователя, ключевые факты и числа с источниками, принятые решения, ответы на вопросы, открытые вопросы. Без воды.';
    let userText = `${ctx.stateText}\n\nПоследние сообщения:\n${ctx.history.map((m) => `${m.role}: ${typeof m.content === 'string' ? m.content : '[документы]'}`).join('\n').slice(0, 30000)}`;
    if (config.aiMode === 'local') {
      // trimToBudget этот формат промпта не режет — укладываем в половину окна модели сами
      const capChars = Math.floor(modelManager.desiredContext(config.localAiModel) * CHARS_PER_TOKEN / 2);
      userText = userText.slice(0, capChars);
    }
    let summary = '';
    if (config.aiMode === 'local') {
      ({ text: summary } = await callOpenAiCompat({
        system, messages: [{ role: 'user', content: userText }], sessionId, baseUrl: config.localAiBaseUrl, jsonSchema: false, maxTokens: 1500,
      }));
    } else {
      // единственный вызов Anthropic мимо streamClaude — проверка и пометка
      // конечного пользователя нужны и здесь
      assertCloudAllowed('claude', sessionId);
      const endUser = cloudAccess.safetyIdentifier(sessionId);
      const response = await client().messages.create({
        model: config.anthropicModel,
        max_tokens: 2000,
        system,
        messages: [{ role: 'user', content: userText }],
        ...(endUser ? { metadata: { user_id: endUser } } : {}),
      });
      recordUsage(sessionId, response.usage, { provider: 'claude', model: config.anthropicModel });
      summary = response.content.find((b) => b.type === 'text')?.text || '';
    }
    if (summary) db.prepare('UPDATE sessions SET summary = ?, updated_at = ? WHERE id = ?').run(summary, now(), sessionId);
  } catch (err) {
    console.warn('[compact] failed:', err.message); // non-fatal: full history is still in DB
  }
}

function wrapApiError(err) {
  if (err instanceof BudgetExceededError || err instanceof AiUnavailableError) return err;
  let Anthropic;
  try { Anthropic = require('@anthropic-ai/sdk'); } catch { return err; }
  if (err instanceof Anthropic.APIError) {
    // полная причина — в консоль и logs/ai-errors.log; раньше тело ошибки Anthropic терялось
    logAiError({ where: 'anthropic', status: err.status, detail: String(err.message || '').slice(0, 2000) });
  }
  if (err instanceof Anthropic.AuthenticationError) {
    return new AiUnavailableError('AI-сервис не настроен (ошибка авторизации). Обратитесь к администратору.');
  }
  if (err instanceof Anthropic.RateLimitError) {
    return new AiUnavailableError('AI-сервис перегружен (rate limit). Повторите попытку через минуту.');
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return new AiUnavailableError('Нет соединения с AI-сервисом. Повторите попытку позже.');
  }
  if (err instanceof Anthropic.APIError) {
    if (err.status === 400) {
      const reason = String(err.message || '').replace(/^\d+\s+/, '').slice(0, 200);
      return new AiUnavailableError(`AI-сервис отклонил запрос (400)${reason ? `: ${reason}` : ''}.`);
    }
    return new AiUnavailableError(`AI-сервис временно недоступен (${err.status || '5xx'}). Повторите попытку позже.`);
  }
  return err;
}

module.exports = {
  structuredCall, runAnalysis, analyzeOnce, chatOnce, plainCall, checkBudget, effectiveProvider, resolveModel, maybeCompact, BudgetExceededError, AiUnavailableError, tryParse,
  // открыто для тестов: поведение, которое обязано оставаться проверяемым
  humanizeProviderError, toOpenAiContent, redactSecrets, maxTokensEnv, providerLabel, recordUsage,
  unionTypesToAnyOf, isLocalGrammarEngine,
  ROUTABLE_PROVIDERS, MAX_ANALYSIS_CALLS, MAX_CONTINUATIONS, ensureDocumentsStudied };
