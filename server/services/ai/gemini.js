'use strict';
/**
 * Адаптер Google Gemini на официальном @google/genai.
 *
 * Отдельный от OpenAI-совместимого слоя намеренно (ТЗ, п. 58): у Gemini свой
 * формат сообщений (contents/parts), своя подача документов (inlineData вместо
 * ссылок) и свои размышления (parts с флагом thought). Специфика заперта здесь —
 * наружу выдаётся тот же контракт, что и у остальных адаптеров:
 *   { text, reasoning, truncated }
 *
 * Ключ живёт только на сервере и никогда не попадает ни в ответы API, ни в логи.
 */
const config = require('../../config');

let _client = null;
let _clientKey = '';

function client() {
  if (!config.geminiApiKey) {
    const err = new Error('Gemini не настроен: нужен GEMINI_API_KEY на сервере.');
    err.code = 'auth';
    throw err;
  }
  if (!_client || _clientKey !== config.geminiApiKey) {
    const { GoogleGenAI } = require('@google/genai');
    const opts = { apiKey: config.geminiApiKey };
    if (config.geminiBaseUrl) opts.httpOptions = { baseUrl: config.geminiBaseUrl };
    _client = new GoogleGenAI(opts);
    _clientKey = config.geminiApiKey;
  }
  return _client;
}

/* ---------------- перевод внутреннего формата в contents/parts ---------------- */

/**
 * Блоки приложения → parts Gemini. Документы и картинки уходят как inlineData:
 * File API нужен только для больших и переиспользуемых файлов (ТЗ, п. 66),
 * в анализе одной сессии он лишний круг сетевых запросов.
 */
function toParts(content) {
  if (typeof content === 'string') {
    return content.trim() ? [{ text: content }] : [];
  }
  const parts = [];
  for (const b of content || []) {
    if (b.type === 'text' && b.text && b.text.trim()) {
      parts.push({ text: b.text });
    } else if ((b.type === 'document' || b.type === 'image') && b.source && b.source.data) {
      parts.push({
        inlineData: {
          mimeType: b.source.media_type || (b.type === 'document' ? 'application/pdf' : 'image/png'),
          data: b.source.data,
        },
      });
    }
  }
  return parts;
}

/** Сообщения приложения → contents Gemini (assistant → model, пустые выброшены). */
function toContents(messages) {
  const out = [];
  for (const m of messages || []) {
    const parts = toParts(m.content);
    if (!parts.length) continue; // пустые сообщения Gemini отклоняет так же, как Moonshot
    out.push({ role: m.role === 'assistant' ? 'model' : 'user', parts });
  }
  return out;
}

/* ---------------- ошибки провайдера, приведённые к общему виду ---------------- */

/**
 * Человеческое объяснение вместо сырой ошибки SDK (ТЗ, п. 69).
 * Возвращает { kind, message } — kind нужен вызывающему для решения, что делать.
 */
function humanizeError(err) {
  if (err && (err.name === 'AbortError' || err.code === 'ABORT_ERR')) {
    return { kind: 'cancelled', message: 'Обработка прервана' };
  }
  const status = err && (err.status || err.code);
  const raw = String((err && err.message) || '');
  // ключ не должен утечь в текст ошибки ни при каких обстоятельствах
  const detail = raw.replace(/AIza[0-9A-Za-z_\-]{10,}/g, '«ключ скрыт»').slice(0, 300);

  if (err && err.code === 'auth') return { kind: 'auth', message: raw };
  if (status === 401 || status === 403 || /API key|PERMISSION_DENIED|UNAUTHENTICATED/i.test(detail)) {
    return { kind: 'auth', message: 'Gemini отклонил ключ: проверьте GEMINI_API_KEY на сервере и права доступа.' };
  }
  if (status === 429 || /RESOURCE_EXHAUSTED|quota|rate limit/i.test(detail)) {
    return { kind: 'rate_limit', message: 'Gemini временно ограничил частоту запросов (квота исчерпана). Повторите через несколько минут.' };
  }
  if (/token count|exceeds the maximum|input is too long|context length/i.test(detail)) {
    return { kind: 'context_limit', message: 'Материалы не помещаются в контекст модели Gemini. Уберите часть файлов или выберите модель с большим окном.' };
  }
  if (/mime|unsupported file|INVALID_ARGUMENT.*(file|media)/i.test(detail)) {
    return { kind: 'unsupported_format', message: `Gemini не принял формат вложения: ${detail}` };
  }
  if (status === 404 || /not found|is not supported/i.test(detail)) {
    return { kind: 'unavailable', message: `Модель Gemini недоступна: ${detail}` };
  }
  if (status >= 500 || /fetch failed|ECONNREFUSED|ENOTFOUND|timeout/i.test(detail)) {
    return { kind: 'unavailable', message: 'Сервис Gemini сейчас недоступен. Повторите попытку позже.' };
  }
  return { kind: 'error', message: `Gemini вернул ошибку${status ? ` ${status}` : ''}: ${detail}` };
}

/* ---------------- список моделей и выбор по умолчанию ---------------- */

let listCache = { at: 0, models: [] };

/**
 * Модели аккаунта из API (кэш 10 мин). Список не зашит в код: новая версия
 * Gemini появляется в интерфейсе сама, без правок приложения (ТЗ, п. 61).
 */
async function listModels() {
  if (!config.geminiApiKey) return [];
  if (Date.now() - listCache.at < 600000 && listCache.models.length) return listCache.models;
  try {
    const pager = await client().models.list();
    const ids = [];
    for await (const m of pager) {
      const id = String(m.name || '').replace(/^models\//, '');
      const actions = m.supportedActions || m.supportedGenerationMethods || [];
      const chat = !actions.length || actions.includes('generateContent');
      if (id && chat && !/embedding|aqa|imagen|veo|tts|native-audio/i.test(id)) ids.push(id);
    }
    // свежие поколения выше: сортировка по убыванию строки даёт нужный порядок
    ids.sort((a, b) => b.localeCompare(a, 'en'));
    if (ids.length) listCache = { at: Date.now(), models: ids };
    return listCache.models;
  } catch {
    return listCache.models; // список недоступен — не роняем выбор провайдера
  }
}

/** Модель для запроса: выбранная в сессии → из .env → первая из списка аккаунта. */
async function resolveModel(model) {
  if (model) return model;
  if (config.geminiModel) return config.geminiModel;
  const models = await listModels();
  if (!models.length) {
    const err = new Error('Не удалось определить модель Gemini: задайте GEMINI_MODEL в .env.');
    err.code = 'auth';
    throw err;
  }
  return models[0];
}

/* ---------------- собственно вызов ---------------- */

/**
 * Один запрос к Gemini. Контракт совпадает с остальными адаптерами.
 * jsonSchema — JSON Schema ответа (строгий разбор) либо null для свободного текста.
 * onProgress(tokens, thinking) вызывается по мере генерации.
 * onUsage({input_tokens, output_tokens}) — для учёта расхода вызывающим.
 */
async function generate({
  system, messages, model, jsonSchema = null, maxTokens,
  signal = null, onProgress = null, onUsage = null,
}) {
  const modelId = await resolveModel(model);
  const contents = toContents(messages);

  const cfg = {
    maxOutputTokens: maxTokens || config.geminiMaxTokens,
    temperature: 0.2,
  };
  if (system) cfg.systemInstruction = system;
  if (signal) cfg.abortSignal = signal;
  if (jsonSchema) {
    cfg.responseMimeType = 'application/json';
    cfg.responseJsonSchema = jsonSchema;
  }

  let text = '', reasoning = '', finish = null, usage = null, chunks = 0;
  try {
    let stream;
    try {
      stream = await client().models.generateContentStream({ model: modelId, contents, config: cfg });
    } catch (err) {
      // Gemini придирчив к JSON Schema (ограничения на $ref, required и т.п.).
      // Схему не отбрасываем молча: просим JSON без схемы и валидируем ответ сами —
      // это честнее, чем уронить анализ из-за неподдержанного ключевого слова.
      if (!cfg.responseJsonSchema || !/schema|INVALID_ARGUMENT/i.test(String(err && err.message))) throw err;
      console.warn('[gemini] схема ответа не принята, повтор без неё:', String(err.message).slice(0, 200));
      delete cfg.responseJsonSchema;
      cfg.systemInstruction = `${cfg.systemInstruction || ''}\n\nОтвет верни строго одним JSON-объектом по схеме, описанной выше, без пояснений и без markdown-обёртки.`.trim();
      stream = await client().models.generateContentStream({ model: modelId, contents, config: cfg });
    }
    for await (const chunk of stream) {
      const cand = (chunk.candidates || [])[0];
      for (const part of (cand && cand.content && cand.content.parts) || []) {
        if (!part.text) continue;
        // размышления приходят теми же parts с флагом thought — в ответ они не идут,
        // иначе ломается разбор JSON, но бюджет выходных токенов тратят
        if (part.thought) reasoning += part.text;
        else text += part.text;
        chunks++;
        if (onProgress) onProgress(chunks, !!part.thought);
      }
      if (cand && cand.finishReason) finish = cand.finishReason;
      if (chunk.usageMetadata) usage = chunk.usageMetadata;
    }
  } catch (err) {
    const info = humanizeError(err);
    if (info.kind === 'cancelled') throw Object.assign(new Error(info.message), { name: 'AbortError' });
    throw Object.assign(new Error(info.message), { geminiKind: info.kind, status: err && err.status });
  }

  if (onUsage && usage) {
    onUsage({
      input_tokens: usage.promptTokenCount || 0,
      // мысли тарифицируются как вывод — считаем их вместе с ответом
      output_tokens: (usage.candidatesTokenCount || 0) + (usage.thoughtsTokenCount || 0),
    });
  }

  return { text, reasoning, truncated: finish === 'MAX_TOKENS' };
}

module.exports = { generate, listModels, resolveModel, humanizeError, toContents, toParts };
