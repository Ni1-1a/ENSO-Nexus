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

const AI_ERROR_LOG = path.join(__dirname, '..', '..', '..', 'logs', 'ai-errors.log');

/** Каждая ошибка AI-сервера пишется с полной причиной: в консоль и в logs/ai-errors.log. */
function logAiError(info) {
  console.error('[local-ai]', info.status || '', String(info.detail || info.message || '').slice(0, 500));
  try {
    fs.appendFileSync(AI_ERROR_LOG, JSON.stringify({ at: new Date().toISOString(), ...info }) + '\n');
  } catch { /* журнал не должен ронять обработку */ }
}

/** Человеческое объяснение ошибки локального AI-сервера по телу ответа. */
function humanizeLocalError(status, detail) {
  let msg = '';
  try { const j = JSON.parse(detail); msg = j.error?.message || (typeof j.error === 'string' ? j.error : ''); } catch {}
  msg = String(msg || detail || '');
  if (/unload/i.test(msg)) {
    return 'Локальная модель была выгружена из памяти (нехватка RAM или конкурирующая задача). Повторите попытку — модель будет загружена заново.';
  }
  if (/failed to load|startup was aborted|insufficient|out of memory/i.test(msg)) {
    return 'Не удалось загрузить выбранную модель — вероятно, ей не хватает памяти. Выберите модель поменьше или повторите позже.';
  }
  return `Локальный AI-сервер вернул ошибку ${status}${msg ? `: ${msg.slice(0, 200)}` : ''}. Повторите попытку.`;
}

/** Модель, которая фактически будет использована для маршрута (для шапки и журнала). */
function resolveModel(route) {
  if (route.provider === 'claude') return config.anthropicModel;
  if (route.provider === 'chatgpt') return route.model || config.openaiModel;
  if (route.provider === 'lmstudio') return route.model || config.localAiModel;
  if (route.provider === 'ollama') return route.model || '';
  return 'demo';
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

function checkBudget(session) {
  if (session.ai_requests >= config.maxAiRequestsPerSession) {
    throw new BudgetExceededError('Достигнут лимит AI-запросов для этой сессии.');
  }
  if (session.input_tokens + session.output_tokens >= config.maxTokensPerSession) {
    throw new BudgetExceededError('Достигнут лимит токенов для этой сессии.');
  }
}

function recordUsage(sessionId, usage) {
  const input = usage?.input_tokens || 0;
  const output = usage?.output_tokens || 0;
  db.prepare(
    'UPDATE sessions SET ai_requests = ai_requests + 1, input_tokens = input_tokens + ?, output_tokens = output_tokens + ?, updated_at = ? WHERE id = ?',
  ).run(input, output, now(), sessionId);
  console.log(`[tokens] session=${sessionId} in=${input} out=${output}`);
}

/** Действующий провайдер сессии: выбор пользователя, иначе глобальный режим сервера. */
function effectiveProvider(session) {
  if (session && session.ai_provider) return { provider: session.ai_provider, model: session.ai_model || '' };
  return { provider: config.aiMode === 'live' ? 'claude' : config.aiMode === 'local' ? 'lmstudio' : 'demo', model: '' };
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
  if (!config.anthropicApiKey) throw new AiUnavailableError('Claude не настроен: нужен ANTHROPIC_API_KEY на сервере.');
  progress.set(sessionId, {
    phase: 'generating', model: config.anthropicModel, provider: 'claude',
    label: `Claude (${config.anthropicModel}) анализирует материалы…`,
  });
  const response = await client().messages.create({
    model: config.anthropicModel,
    max_tokens: config.anthropicMaxTokens,
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
    output_config: { format: { type: 'json_schema', schema: RESPONSE_SCHEMA } },
    messages,
  }, signal ? { signal } : undefined);
  recordUsage(sessionId, response.usage);
  if (response.stop_reason === 'refusal') {
    throw new AiUnavailableError('Модель отклонила запрос по соображениям безопасности.');
  }
  const text = response.content.find((b) => b.type === 'text')?.text || '';
  return { text, truncated: response.stop_reason === 'max_tokens' };
}

/** Правило компактности для локальных моделей — от фактического бюджета ответа. */
function compactRule(maxTokens) {
  return `\n\nЖёсткий бюджет ответа — ${Math.max(1000, maxTokens - 2000)} токенов, обрезанный JSON недопустим. Пиши компактно: ` +
    'report_markdown — не длиннее ~1200 слов (только существенное по шагам), message — 3–6 предложений, ' +
    'facts — не более 20, без повторов.';
}

/** OpenAI-compatible local server (LM Studio). Content blocks are flattened to text. */
function flattenForLocal(content) {
  if (typeof content === 'string') return content;
  return content.map((b) => {
    if (b.type === 'text') return b.text;
    if (b.type === 'document') return `[PDF-документ «${b.title || 'без имени'}» — передан отдельно текстом]`;
    if (b.type === 'image') return '[изображение — в локальном режиме не анализируется]';
    return '';
  }).join('\n\n');
}

/* ---------- бюджет контекста: промпт + ответ должны помещаться в окно модели ---------- */
/**
 * Замер 2026-08-05: чистый русский текст в токенизаторе Qwen ≈ 2,5 симв/токен,
 * но реальный промпт (system + JSON + markdown + числа) показал 2,04 — берём 2,0
 * с запасом. Фактическое соотношение печатается в лог после каждого ответа.
 */
const CHARS_PER_TOKEN = 2.0;

function messagesChars(messages) {
  return messages.reduce((s, m) => s + (typeof m.content === 'string' ? m.content.length : 0), 0);
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
    const head = String(m.content).slice(0, 30);
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
    const kb = messages.find((m) => kindOf(m) === 'kb');
    if (kb && kb.content.length > 8000) {
      kb.content = kb.content.slice(0, 8000) + '\n…[выдержки сокращены по лимиту контекста]\n</knowledge_base>';
      notes.push('сокращены выдержки базы знаний');
    }
  }

  // 3) тексты документов (усечение с конца, последние документы страдают первыми)
  if (over() > 0) {
    const docs = messages.find((m) => kindOf(m) === 'docs');
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
    const st = messages.find((m) => kindOf(m) === 'state');
    if (st && st.content.length > 6000) {
      st.content = st.content.slice(0, 6000) + '\n…[состояние сокращено]\n</session_state>';
      notes.push('сокращено состояние сессии');
    }
  }
  return notes;
}

/** Чтение SSE-потока /chat/completions; onToken(count) — для живого прогресса. */
async function readSseStream(res, onToken) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '', text = '', usage = null, finish = null, tokens = 0;
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
      if (delta) { text += delta; tokens++; onToken(tokens); }
      if (choice?.finish_reason) finish = choice.finish_reason;
      if (obj.usage) usage = obj.usage;
    }
  }
  return { text, usage, truncated: finish === 'length' };
}

async function callOpenAiCompat({ system, messages, sessionId, baseUrl, apiKey = '', model, provider = '', jsonSchema = true, maxTokens, stream = true, attempt = 1, logTrimEvent = true, signal = null }) {
  const modelId = model || config.localAiModel;
  const isLmStudio = baseUrl === config.localAiBaseUrl;
  const providerId = provider || (isLmStudio ? 'lmstudio' : 'openai-compat');

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
  let effMaxTokens = maxTokens || config.localAiMaxTokens;
  if (ctxTokens && ctxTokens - effMaxTokens - reserveTokens < ctxTokens / 4) {
    effMaxTokens = Math.max(1024, ctxTokens - reserveTokens - Math.ceil(ctxTokens / 4));
  }

  const body = {
    model: modelId,
    max_tokens: effMaxTokens,
    temperature: 0.2,
    messages: [
      { role: 'system', content: jsonSchema ? system + compactRule(effMaxTokens) : system },
      ...messages.map((m) => ({ role: m.role, content: flattenForLocal(m.content) })),
    ],
  };
  if (stream) {
    body.stream = true;
    body.stream_options = { include_usage: true };
  }
  if (jsonSchema) {
    body.response_format = {
      type: 'json_schema',
      json_schema: { name: 'genplan_analysis', strict: true, schema: RESPONSE_SCHEMA },
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

  progress.set(sessionId, {
    phase: 'waiting_model', model: modelId, provider: providerId,
    label: `Запрос отправлен — модель ${modelId} обрабатывает контекст…`, tokensOut: 0,
  });

  // пока запрос выполняется, модель числится занятой — её нельзя вытеснять из памяти
  if (isLmStudio) modelManager.acquireUse(modelId);
  try {

  let res;
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const fetchSignal = signal
    ? AbortSignal.any([AbortSignal.timeout(config.localAiTimeoutMs), signal])
    : AbortSignal.timeout(config.localAiTimeoutMs);
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
    if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      throw new AiUnavailableError(`AI-сервер (${host}) не ответил за ${Math.round(config.localAiTimeoutMs / 60000)} мин — вероятно, занят другой задачей. Повторите позже.`);
    }
    throw new AiUnavailableError(`AI-сервер (${host}) недоступен. Убедитесь, что он запущен, и повторите.`);
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    logAiError({ where: 'chat/completions', status: res.status, model: modelId, baseUrl, attempt, detail: detail.slice(0, 2000) });
    // модель выгружена/не найдена — загружаем через менеджер и повторяем
    if (/unload|not loaded|no models? loaded|model.*not found|failed to load/i.test(detail) && attempt <= 2) {
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
      return callOpenAiCompat({ system, messages, sessionId, baseUrl, apiKey, model, provider: providerId, jsonSchema, maxTokens, stream, attempt: attempt + 1, logTrimEvent: false, signal });
    }
    // сервер не понял параметры стриминга — повтор без стриминга
    if (stream && /stream/i.test(detail)) {
      return callOpenAiCompat({ system, messages, sessionId, baseUrl, apiKey, model, provider: providerId, jsonSchema, maxTokens, stream: false, attempt, logTrimEvent: false, signal });
    }
    // некоторые модели не принимают json_schema — один повтор в режиме «просто JSON»
    if (jsonSchema && /json_schema|response_format|structured/i.test(detail)) {
      return callOpenAiCompat({
        system: system + '\n\nОтвечай ТОЛЬКО валидным JSON строго по описанной схеме, без пояснений вокруг.',
        messages, sessionId, baseUrl, apiKey, model, provider: providerId, jsonSchema: false, maxTokens, stream, logTrimEvent: false, signal,
      });
    }
    throw new AiUnavailableError(humanizeLocalError(res.status, detail));
  }

  let text, usage, truncated;
  if (stream) {
    ({ text, usage, truncated } = await readSseStream(res, (tokens) => {
      progress.set(sessionId, {
        phase: 'generating', model: modelId,
        label: `Модель ${modelId} генерирует ответ…`, tokensOut: tokens,
      });
    }).catch((err) => {
      if (signal && signal.aborted) {
        throw Object.assign(new Error('Обработка прервана'), { name: 'AbortError' });
      }
      if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
        throw new AiUnavailableError(`Модель не успела завершить ответ за ${Math.round(config.localAiTimeoutMs / 60000)} мин. Повторите или упростите задачу.`);
      }
      throw err;
    }));
  } else {
    const data = await res.json();
    const choice = data.choices && data.choices[0];
    text = choice?.message?.content || '';
    truncated = choice?.finish_reason === 'length';
    usage = data.usage;
  }
  recordUsage(sessionId, {
    input_tokens: usage?.prompt_tokens || 0,
    output_tokens: usage?.completion_tokens || 0,
  });
  if (isLmStudio && usage?.prompt_tokens) {
    // калибровка оценки CHARS_PER_TOKEN по фактическому расходу токенов
    const sentChars = messagesChars(body.messages);
    console.log(`[local-ai] калибровка: ${(sentChars / usage.prompt_tokens).toFixed(2)} симв/токен (промпт ${usage.prompt_tokens} ток., ${Math.round(sentChars / 1000)} тыс. симв.)`);
  }
  return { text, truncated };

  } finally {
    if (isLmStudio) modelManager.releaseUse(modelId);
  }
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
  const session0 = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
  const docProvider = route.provider === 'claude' ? 'anthropic' : 'local';
  progress.set(sessionId, {
    phase: 'preparing', provider: route.provider, model: resolveModel(route),
    label: 'Подготовка контекста: документы, факты, история диалога', tokensOut: 0,
  });

  // «Изучение документации»: графика и сканы распознаются vision-моделью до анализа
  if (docProvider === 'local' && route.provider !== 'demo') {
    try {
      const done = await require('../doc-vision').extractGraphics(sessionId, {
        signal,
        onProgress: (label) => progress.set(sessionId, {
          phase: 'reading_docs', label, model: config.localAiOcrModel, provider: route.provider,
        }),
      });
      if (done.pages) {
        try {
          db.prepare('INSERT INTO events (session_id, stage, detail, level, created_at) VALUES (?,?,?,?,?)')
            .run(sessionId, 'Документация изучена vision-моделью',
              `файлов: ${done.files}, страниц: ${done.pages}`, 'info', now());
        } catch { /* журнал не критичен */ }
      }
    } catch (err) {
      if (signal && signal.aborted) throw err;
      console.warn('[doc-vision]', err.message);
      try {
        db.prepare('INSERT INTO events (session_id, stage, detail, level, created_at) VALUES (?,?,?,?,?)')
          .run(sessionId, 'Изучение графики не удалось', String(err.message || '').slice(0, 200), 'warn', now());
      } catch { /* журнал не критичен */ }
    }
  }

  const ctx = await buildContext(sessionId, docProvider);
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

  if (ctx.docBlocks.length) messages.push({ role: 'user', content: ctx.docBlocks });
  for (const m of ctx.history) messages.push(m);
  messages.push({ role: 'user', content: instruction });

  let out;
  try {
    out = await callModel({ system: SYSTEM_PROMPT, messages, sessionId, route, signal });
  } catch (err) {
    throw wrapApiError(err);
  }

  progress.set(sessionId, { phase: 'validating', label: 'Проверка структуры ответа модели…' });
  let parsed = tryParse(out.text);
  let check = validateResponse(parsed);
  if (!check.ok) {
    // limited retry: truncation gets a "be compact" correction, everything else — a schema correction
    progress.set(sessionId, { phase: 'validating', label: 'Ответ не прошёл проверку схемы — уточняющий повторный запрос…' });
    const session2 = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
    checkBudget(session2);
    const correction = out.truncated
      ? 'Твой предыдущий ответ был обрезан по лимиту токенов и JSON не завершился. Сформируй ответ заново, значительно компактнее: report_markdown — не длиннее ~800 слов, message — 3–5 предложений, facts — только ключевые. Верни полный валидный JSON.'
      : `Твой предыдущий ответ не прошёл валидацию схемы (${check.error}). Верни корректный JSON строго по схеме.`;
    messages.push({ role: 'assistant', content: out.text.slice(0, 6000) || '(пустой ответ)' });
    messages.push({ role: 'user', content: correction });
    try {
      out = await callModel({ system: SYSTEM_PROMPT, messages, sessionId, route, signal });
    } catch (err) {
      throw wrapApiError(err);
    }
    parsed = tryParse(out.text);
    check = validateResponse(parsed);
    if (!check.ok) {
      throw new AiUnavailableError(out.truncated
        ? 'Ответ модели дважды превысил лимит токенов. Попробуйте ещё раз или разбейте задачу: попросите краткий отчёт.'
        : 'Модель вернула некорректный ответ. Попробуйте повторить обработку.');
    }
  }
  return check.value;
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
  const provider = config.aiMode === 'local' ? 'local' : 'anthropic';
  const ctx = await buildContext(sessionId, provider);
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
      const response = await client().messages.create({
        model: config.anthropicModel,
        max_tokens: 2000,
        system,
        messages: [{ role: 'user', content: userText }],
      });
      recordUsage(sessionId, response.usage);
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

module.exports = { runAnalysis, analyzeOnce, effectiveProvider, resolveModel, maybeCompact, BudgetExceededError, AiUnavailableError, tryParse };
