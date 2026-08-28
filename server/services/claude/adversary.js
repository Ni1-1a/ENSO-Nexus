'use strict';
/**
 * Промежуточный проверяющий (adversary) ответов помощника.
 *
 * Перед отправкой пользователю черновик ответа уходит ТОЙ ЖЕ модели с ролью
 * проверяющего: найти противоречия фактам сессии, выдуманные основания и уход
 * от вопроса. Вердикт «revise» возвращает черновик автору на ОДНУ доработку;
 * второго круга нет намеренно — безнадёжный ответ честнее отдать с пометкой
 * в журнале, чем гонять модель по кругу за деньги пользователя.
 *
 * Проверка — служебное обращение (internal): счётчик запросов проекта она не
 * расходует, токены и деньги учитываются как у всех. Модель берётся та же, что
 * дала ответ: на локальном маршруте это избавляет от перезагрузки весов, а на
 * облачном — от сюрприза «ответила одна модель, проверила другая».
 *
 * Сбой проверяющего не имеет права съесть ответ: вызывающий код ловит ошибку,
 * пишет событие в журнал и отправляет исходный черновик. Молчаливой подмены
 * ответа тоже нет: и проверка, и доработка видны в журнале событий сессии.
 */
const config = require('../../config');
const { db } = require('../../db');
const prompts = require('../prompts');

/**
 * Схема вердикта. Правила строгого режима (см. CLAUDE.md): в каждом объекте
 * required перечисляет ВСЕ ключи properties, необязательность — допуском null;
 * союз типов для локальных движков переписывает adapter.unionTypesToAnyOf.
 */
const REVIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'issues'],
  properties: {
    verdict: { type: 'string', enum: ['ok', 'revise'] },
    issues: {
      type: 'array',
      maxItems: 8,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'text', 'quote'],
        properties: {
          kind: { type: 'string', enum: ['вопрос', 'факт', 'норматив', 'уверенность', 'язык', 'прочее'] },
          text: { type: 'string' },
          quote: { type: ['string', 'null'] },
        },
      },
    },
  },
};

/** Работает ли проверка для этого маршрута. Демо и mock отвечают без модели — проверять нечем. */
function enabled(route) {
  if (!config.adversaryReview) return false;
  if (config.aiMode === 'mock') return false;
  if (!route || !route.provider || route.provider === 'demo') return false;
  return true;
}

/** Достоверные данные сессии для проверки: факты и ответы человека, без тяжёлых документов. */
function sessionFactsText(sessionId) {
  const parts = [];
  const session = db.prepare('SELECT comment FROM sessions WHERE id = ?').get(sessionId);
  if (session && session.comment) parts.push(`## Комментарий пользователя к исходным данным\n${session.comment}`);
  const facts = db.prepare('SELECT key, value, source FROM facts WHERE session_id = ? ORDER BY created_at LIMIT 120').all(sessionId);
  if (facts.length) {
    parts.push('## Извлечённые факты\n' + facts.map((f) => `- ${f.key} = ${f.value} (${f.source})`).join('\n'));
  }
  const answered = db.prepare(
    "SELECT text, answer FROM questions WHERE session_id = ? AND (status = 'answered' OR (answer IS NOT NULL AND answer != '')) ORDER BY created_at",
  ).all(sessionId);
  if (answered.length) {
    parts.push('## Ответы пользователя на уточняющие вопросы\n' +
      answered.map((q) => `- Вопрос: ${q.text}\n  Ответ: ${q.answer}`).join('\n'));
  }
  return parts.join('\n\n');
}

/** Достоверные данные из РЕЗУЛЬТАТА анализа: сообщение обязано им соответствовать. */
function analysisFactsText(result) {
  const parts = [`Статус анализа: ${result.status}`];
  if (result.facts && result.facts.length) {
    parts.push('## Факты результата\n' + result.facts.map((f) => `- ${f.key} = ${f.value} (${f.source})`).join('\n'));
  }
  if (result.questions && result.questions.length) {
    parts.push('## Заданные пользователю вопросы\n' + result.questions.map((q) => `- ${q.text}`).join('\n'));
  }
  if (result.warnings && result.warnings.length) parts.push('## Предупреждения\n' + result.warnings.map((w) => `- ${w}`).join('\n'));
  if (result.conflicts && result.conflicts.length) parts.push('## Противоречия в данных\n' + result.conflicts.map((c) => `- ${c}`).join('\n'));
  if (result.assumptions && result.assumptions.length) parts.push('## Принятые допущения\n' + result.assumptions.map((a) => `- ${a}`).join('\n'));
  return parts.join('\n\n');
}

/**
 * Проверка черновика. Возвращает { verdict: 'ok'|'revise', issues: [...] }
 * либо null, если проверка для маршрута выключена. Ошибки модели летят наружу —
 * решение «отдать исходный черновик» принимает вызывающий код, у него журнал.
 */
async function review(sessionId, { userText, draft, factsText = null, route, signal = null }) {
  if (!enabled(route)) return null;
  const adapter = require('./adapter'); // поздний require: adapter ↔ adversary
  const state = factsText !== null ? factsText : sessionFactsText(sessionId);
  const content = [
    state ? `<session_facts>\n${state}\n</session_facts>` : '<session_facts>\n(фактов в сессии ещё нет)\n</session_facts>',
    `<user_question>\n${userText}\n</user_question>`,
    `<draft_reply>\n${draft}\n</draft_reply>`,
  ].join('\n\n');

  const out = await adapter.structuredCall({
    system: prompts.load('adversary-review'),
    messages: [{ role: 'user', content }],
    sessionId, route, signal,
    schema: REVIEW_SCHEMA, schemaName: 'adversary_review',
    internal: true,
  });
  const parsed = adapter.tryParse(out.text || '');
  if (!parsed || (parsed.verdict !== 'ok' && parsed.verdict !== 'revise')) {
    // непригодный вердикт — это отказ проверки, а не «ok»: пусть решает вызывающий код
    throw new Error('Проверяющий вернул нечитаемый вердикт');
  }
  const issues = (Array.isArray(parsed.issues) ? parsed.issues : [])
    .filter((i) => i && typeof i.text === 'string' && i.text.trim())
    .slice(0, 8)
    .map((i) => ({ kind: i.kind || 'прочее', text: i.text.trim(), quote: i.quote || null }));
  // «revise» без единого замечания дорабатывать не по чему — считается «ok»
  return { verdict: parsed.verdict === 'revise' && issues.length ? 'revise' : 'ok', issues };
}

/** Замечания одной строкой — для журнала и для подстановки в задание доработки. */
function issuesText(issues) {
  return issues.map((i, n) => `${n + 1}. [${i.kind}] ${i.text}${i.quote ? ` (место: «${i.quote}»)` : ''}`).join('\n');
}

/** Текст задания на доработку — дописывается в диалог после черновика (чат, вопрос по области). */
function reviseInstruction(issues) {
  return prompts.load('tasks/adversary-revise', { issues: issuesText(issues) });
}

/**
 * Переписывание сообщения анализа по замечаниям — отдельным вызовом, потому что
 * пересобирать полный контекст анализа ради правки резюме и дорого, и не нужно:
 * достоверные данные результата уже лежат в самом result.
 */
async function rewrite(sessionId, { draft, issues, factsText, route, signal = null }) {
  const adapter = require('./adapter');
  const content = [
    `<session_facts>\n${factsText || '(данных нет)'}\n</session_facts>`,
    `<draft_reply>\n${draft}\n</draft_reply>`,
    `<review_issues>\n${issuesText(issues)}\n</review_issues>`,
  ].join('\n\n');
  const out = await adapter.plainCall({
    system: prompts.load('adversary-rewrite'),
    messages: [{ role: 'user', content }],
    sessionId, route, signal, internal: true,
  });
  return (out.text || '').trim();
}

module.exports = { REVIEW_SCHEMA, enabled, review, rewrite, reviseInstruction, issuesText, sessionFactsText, analysisFactsText };
