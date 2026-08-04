'use strict';
const fs = require('fs');
const path = require('path');
const config = require('../../config');
const { db, now } = require('../../db');
const { RESPONSE_SCHEMA, validateResponse } = require('./schema');
const { buildContext } = require('./memory');
const mock = require('./mock');

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

async function callModel({ system, messages, sessionId }) {
  if (config.aiMode === 'local') return callLocalModel({ system, messages, sessionId });
  const response = await client().messages.create({
    model: config.anthropicModel,
    max_tokens: config.anthropicMaxTokens,
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
    output_config: { format: { type: 'json_schema', schema: RESPONSE_SCHEMA } },
    messages,
  });
  recordUsage(sessionId, response.usage);
  if (response.stop_reason === 'refusal') {
    throw new AiUnavailableError('Модель отклонила запрос по соображениям безопасности.');
  }
  const text = response.content.find((b) => b.type === 'text')?.text || '';
  return text;
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

async function callLocalModel({ system, messages, sessionId, jsonSchema = true, maxTokens }) {
  const body = {
    model: config.localAiModel,
    max_tokens: maxTokens || config.localAiMaxTokens,
    temperature: 0.2,
    messages: [
      { role: 'system', content: system },
      ...messages.map((m) => ({ role: m.role, content: flattenForLocal(m.content) })),
    ],
  };
  if (jsonSchema) {
    body.response_format = {
      type: 'json_schema',
      json_schema: { name: 'genplan_analysis', strict: true, schema: RESPONSE_SCHEMA },
    };
  }
  let res;
  try {
    res = await fetch(`${config.localAiBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(config.anthropicRequestTimeoutMs),
    });
  } catch (err) {
    throw new AiUnavailableError('Локальный AI-сервер (LM Studio) недоступен. Убедитесь, что он запущен, и повторите.');
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    // some local models reject json_schema — one retry in plain-JSON mode
    if (jsonSchema && /json_schema|response_format|structured/i.test(detail)) {
      return callLocalModel({
        system: system + '\n\nОтвечай ТОЛЬКО валидным JSON строго по описанной схеме, без пояснений вокруг.',
        messages, sessionId, jsonSchema: false, maxTokens,
      });
    }
    console.error('[local-ai]', res.status, detail.slice(0, 500));
    throw new AiUnavailableError(`Локальный AI-сервер вернул ошибку (${res.status}). Повторите попытку.`);
  }
  const data = await res.json();
  recordUsage(sessionId, {
    input_tokens: data.usage?.prompt_tokens || 0,
    output_tokens: data.usage?.completion_tokens || 0,
  });
  return data.choices?.[0]?.message?.content || '';
}

/**
 * One analysis step. Builds the working context, calls Claude (or the mock),
 * validates the structured answer, retries once on invalid structure.
 */
async function runAnalysis(sessionId, { instruction }) {
  const provider = config.aiMode === 'local' ? 'local' : 'anthropic';
  const ctx = await buildContext(sessionId, provider);
  checkBudget(ctx.session);

  if (config.aiMode === 'mock') {
    return mock.runAnalysis(sessionId, ctx, instruction);
  }

  const messages = [];
  if (ctx.stateText) messages.push({ role: 'user', content: `<session_state>\n${ctx.stateText}\n</session_state>` });
  if (ctx.docBlocks.length) messages.push({ role: 'user', content: ctx.docBlocks });
  for (const m of ctx.history) messages.push(m);
  messages.push({ role: 'user', content: instruction });

  let text;
  try {
    text = await callModel({ system: SYSTEM_PROMPT, messages, sessionId });
  } catch (err) {
    throw wrapApiError(err);
  }

  let parsed = tryParse(text);
  let check = validateResponse(parsed);
  if (!check.ok) {
    // limited retry: ask the model to fix its structure
    const session2 = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
    checkBudget(session2);
    messages.push({ role: 'assistant', content: text.slice(0, 8000) });
    messages.push({ role: 'user', content: `Твой предыдущий ответ не прошёл валидацию схемы (${check.error}). Верни корректный JSON строго по схеме.` });
    try {
      text = await callModel({ system: SYSTEM_PROMPT, messages, sessionId });
    } catch (err) {
      throw wrapApiError(err);
    }
    parsed = tryParse(text);
    check = validateResponse(parsed);
    if (!check.ok) {
      throw new AiUnavailableError('Модель вернула некорректный ответ. Попробуйте повторить обработку.');
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
    const userText = `${ctx.stateText}\n\nПоследние сообщения:\n${ctx.history.map((m) => `${m.role}: ${typeof m.content === 'string' ? m.content : '[документы]'}`).join('\n').slice(0, 30000)}`;
    let summary = '';
    if (config.aiMode === 'local') {
      summary = await callLocalModel({
        system, messages: [{ role: 'user', content: userText }], sessionId, jsonSchema: false, maxTokens: 1500,
      });
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
    return new AiUnavailableError(`AI-сервис временно недоступен (${err.status || '5xx'}). Повторите попытку позже.`);
  }
  return err;
}

module.exports = { runAnalysis, maybeCompact, BudgetExceededError, AiUnavailableError, tryParse };
