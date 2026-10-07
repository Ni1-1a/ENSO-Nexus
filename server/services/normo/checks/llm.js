'use strict';
/**
 * LLM-проверки нормоконтроля (auto: llm) через adapter.structuredCall платформы.
 *
 * Принципы (согласованный обзор техник, Этап 0-Б):
 * - модель работает ТОЛЬКО по приложенному тексту документа и приложенным выдержкам
 *   пунктов НТД из корпуса (П46: реквизиты в промпт попадают только сверенными);
 * - правило, чей пункт отсутствует в корпусе НТД, НЕ отдаётся модели вовсе —
 *   уходит в журнал прогона со skip_reason (честный пропуск вместо галлюцинации);
 * - каждая находка проходит детерминированный верификатор цитат (verify.js);
 *   неподтверждённая — вставляется с verification=needs_human, не выбрасывается;
 * - находка, которую верификатор не подтвердил из-за цитаты (нет цитаты, не найдена
 *   дословно, цитата пункта НТД не совпала), возвращается той же модели в том же
 *   диалоге — до QUOTE_RETRY_ROUNDS кругов (services/quote-check.js, 07.10.2026):
 *   статус меняет только повторная проверка verify.js; снятые моделью и
 *   оставленные без цитаты находки идут человеку с её причиной. Причины, которые
 *   модель исправить не может (пункта нет в корпусе, «правило двух адресов»),
 *   не возвращаются. Итог повтора — в params.llm_retry прогона;
 * - провайдер локальный (lmstudio): работает и при local_only; облачный маршрут —
 *   отдельным решением позже.
 */
const crypto = require('crypto');
const appDb = require('../../../db');
const config = require('../../../config');
const adapter = require('../../claude/adapter');
const prompts = require('../../prompts');
const corpus = require('../ntd-corpus');
const store = require('../store');
const verify = require('./verify');
const quoteCheck = require('../../quote-check');
const db = require('../db');

// Версия LLM-слоя входит в ключ кэша прогона (как deterministic.VERSION):
// изменение фильтров/промпта обязано перепроверять уже загруженные версии.
const VERSION = 5;

const BATCH = 4;
const DOC_TEXT_CAP = 48000;
const MAX_TOKENS = 8000;

const COMPACT_HINT = 'ОТВЕЧАЙ ПРЕДЕЛЬНО КОМПАКТНО: только самые значимые находки, '
  + 'wording до 200 символов, цитаты до 150 символов, без повторов.';

/** Обрыв соединения до модели — не ошибка правила: такие вызовы повторяются. */
function transient(err) {
  return /оборвал|terminated|ECONNRESET|socket hang up|fetch failed|timeout|ETIMEDOUT/i
    .test(err && err.message ? err.message : '');
}

async function withRetry(fn, attempts = 3) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      if (!transient(err) || i === attempts - 1) throw err;
      await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
    }
  }
  throw last;
}

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['findings', 'unchecked'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['rule_id', 'quote', 'ntd', 'clause', 'ntd_quote', 'location_file', 'location_hint', 'wording', 'confidence'],
        properties: {
          rule_id: { type: 'string' },
          quote: { type: 'string' },
          ntd: { type: 'string' },
          clause: { type: 'string' },
          ntd_quote: { type: 'string' },
          location_file: { type: 'string' },
          location_hint: { type: 'string' },
          wording: { type: 'string' },
          confidence: { type: 'number' },
        },
      },
    },
    unchecked: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['rule_id', 'reason'],
        properties: { rule_id: { type: 'string' }, reason: { type: 'string' } },
      },
    },
  },
};

// Модель отчитывается о СООТВЕТСТВИИ находкой — это не находка
const COMPLIANCE_RE = /соответствует требовани|нарушений не выявлено|выполняется корректно/iu;
// «Правило двух адресов» (А19): находка об ОТСУТСТВИИ чего-либо цитатой не доказывается
const ABSENCE_RE = /не указан|отсутству|не представлен|не приведен|не содержит|нет сведений/iu;
// Причины верификатора, которые модель может снять, дав точную цитату (возврат автору);
// всё остальное — пункта нет в корпусе, не назван пункт, правило двух адресов — не возвращается
const RETRYABLE_RE = /^(нет содержательной цитаты из проверяемого документа|цитата не найдена в тексте проверяемого документа дословно|нет дословной цитаты пункта НТД|цитата пункта не совпадает)/u;

function retryable(reasons) {
  return reasons.length && reasons.every((r) => RETRYABLE_RE.test(r)) ? reasons.slice() : [];
}

/** Верификация находки по правилу: цитаты — кодом, НТД и пункт — из правила, не из ответа модели. */
async function verifyRule({ doc, rule, docQuote, ntdQuote, wording }) {
  const check = await verify.verifyFinding({
    docText: doc,
    docQuote,
    ntd: rule.source.ntd,
    ntdClause: String(rule.source.clause),
    ntdQuote,
  });
  // Находка об отсутствии не выбрасывается, но всегда идёт человеку.
  if (check.ok && ABSENCE_RE.test(wording || '')) {
    check.ok = false;
    check.verification = 'needs_human';
    check.reasons.push('вопрос полноты: отсутствие не доказывается цитатой (правило двух адресов)');
  }
  return check;
}

function detailOf(check, truncated) {
  return check.ok
    ? (truncated ? 'проверено по обрезанному тексту' : null)
    : `не подтверждено верификатором: ${check.reasons.join('; ')}`;
}

/** Итог повтора — в detail находки (в БД он уходит хвостом wording). */
function retryDetail(f, truncated) {
  switch (f.quote_retry) {
    case 'confirmed':
      return [`подтверждено верификатором после повторного запроса (круг ${f.quote_retry_rounds})`,
        truncated ? 'проверено по обрезанному тексту' : null].filter(Boolean).join('; ');
    case 'withdrawn':
    case 'kept':
      return f.quote_note;
    case 'unconfirmed':
    case 'unanswered':
      return `${f.detail}; ${quoteCheck.RETRY_LABEL[f.quote_retry]}`;
    default:
      return f.detail;
  }
}

function addStats(total, part) {
  for (const k of Object.keys(part)) {
    if (k === 'error') { if (part.error) total.error = total.error ? `${total.error}; ${part.error}` : part.error; }
    else if (k === 'rounds') total.rounds = Math.max(total.rounds, part.rounds);
    else total[k] += part[k];
  }
}

/** Служебная сессия платформы для учёта токенов модуля (по образцу модуля «Датасет»). */
async function ensureServiceSession(project) {
  const existing = await db.query(
    'SELECT service_session_id FROM projects WHERE id = $1', [project.id]);
  const sid = existing.rows[0] && existing.rows[0].service_session_id;
  if (sid && appDb.db.prepare('SELECT id FROM sessions WHERE id = ?').get(sid)) return sid;
  const id = crypto.randomUUID();
  appDb.db.prepare(`INSERT INTO sessions (id, token, token_hash, status, device_id, user_id, prompt_version, origin_host, title, project_id, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    // открытого токена нет: служебную сессию по токену не открывают, в базе — только хеш случайного;
    // project_id — проект платформы комплекта, иначе migrateLegacy уводит её в «Ранние работы»
    id, '', crypto.createHash('sha256').update(crypto.randomBytes(32)).digest('hex'), 'service', '',
    project.owner_user || '', config.promptVersion, '',
    `Нормоконтроль: ${project.name}`.slice(0, 60), project.platform_project_id || 'legacy', appDb.now(), appDb.now());
  await db.query('UPDATE projects SET service_session_id = $1 WHERE id = $2', [id, project.id]);
  return id;
}

async function buildDocText(files) {
  const parts = [];
  for (const f of files) {
    const text = (await store.extractText(f)).trim();
    if (text) parts.push(`### Файл: ${f.original_name}\n${text}`);
  }
  let doc = parts.join('\n\n');
  let truncated = false;
  if (doc.length > DOC_TEXT_CAP) {
    doc = doc.slice(0, DOC_TEXT_CAP);
    truncated = true;
    doc += '\n\n[ТЕКСТ ОБРЕЗАН: документ длиннее лимита контекста — проверка выполнена по началу документа]';
  }
  return { doc, truncated };
}

/**
 * Прогон LLM-правил. Возвращает { findings: [...], journal: Map(ruleId → {outcome, skipReason}),
 * retry: сводка возврата находок автору (returned = 0, если возвращать было нечего) }.
 */
async function runLlmRules({ project, version, files, rules }) {
  const journal = new Map();
  const findings = [];
  const retry = { rounds: 0, returned: 0, confirmed: 0, withdrawn: 0, kept: 0, unconfirmed: 0, unanswered: 0, calls: 0, error: null };
  if (!rules.length) return { findings, journal, retry };

  const { doc, truncated } = await buildDocText(files);
  if (!doc.trim()) {
    for (const r of rules) {
      journal.set(r.id, { outcome: 'skipped', skipReason: 'из файлов версии не извлечён текст — смысловая проверка невозможна' });
    }
    return { findings, journal, retry };
  }

  // Правило без текста пункта в корпусе НТД модели не отдаётся
  const grounded = [];
  for (const r of rules) {
    const { doc: ntdDoc, chunks } = await corpus.findClause(r.source.ntd, r.source.clause);
    if (!ntdDoc || !chunks.length) {
      journal.set(r.id, {
        outcome: 'skipped',
        skipReason: `текст ${r.source.ntd} п.${r.source.clause} отсутствует в корпусе НТД (добор — Техэксперт)`,
      });
    } else {
      grounded.push({ rule: r, ntdText: chunks.map((c) => c.body).join('\n').slice(0, 2200) });
    }
  }

  const sessionId = await ensureServiceSession(project);
  const system = prompts.load('normo-check', {
    section_code: version.section_code,
    section_name: version.section_name,
    stage: version.stage,
  });
  const route = { provider: 'lmstudio', model: config.localAiModel };

  for (let i = 0; i < grounded.length; i += BATCH) {
    const batch = grounded.slice(i, i + BATCH);
    const rulesBlock = batch.map(({ rule, ntdText }) => [
      `— id: ${rule.id}`,
      `  требование: ${rule.title}. ${rule.check.description}`,
      `  НТД: ${rule.source.ntd}, пункт ${rule.source.clause}`,
      `  текст пункта:\n${ntdText.split('\n').map((l) => `    ${l}`).join('\n')}`,
    ].join('\n')).join('\n\n');

    const user = `ПРАВИЛА ПРОВЕРКИ (${batch.length}):\n\n${rulesBlock}\n\n`
      + `ТЕКСТ ДОКУМЕНТА:\n\n${doc}`;

    let parsed = null;
    let raw = '';
    try {
      const call = (extra) => adapter.structuredCall({
        system: extra ? `${system}\n\n${extra}` : system,
        messages: [{ role: 'user', content: user }],
        sessionId,
        route,
        schema: SCHEMA,
        schemaName: 'normo_findings',
        maxTokens: MAX_TOKENS,
      });
      // Соединение до модели может оборваться на середине ответа: на VPS запрос
      // идёт через шлюз мака по DERP-реле, и длинная генерация рвётся. Это не
      // ошибка правила — повторяем, компактный ответ рвётся заметно реже.
      let res = await withRetry(() => call(null));
      parsed = adapter.tryParse(res.text);
      raw = res.text || '';
      if (!parsed || res.truncated) {
        res = await withRetry(() => call(COMPACT_HINT));
        const again = adapter.tryParse(res.text);
        if (again) { parsed = again; raw = res.text || ''; }
      }
    } catch (err) {
      for (const { rule } of batch) {
        journal.set(rule.id, { outcome: 'error', skipReason: `LLM: ${err.message}`.slice(0, 400) });
      }
      continue;
    }
    if (!parsed || !Array.isArray(parsed.findings)) {
      for (const { rule } of batch) {
        journal.set(rule.id, { outcome: 'error', skipReason: 'модель вернула неразборный ответ' });
      }
      continue;
    }

    const batchIds = new Set(batch.map((b) => b.rule.id));
    for (const { rule } of batch) journal.set(rule.id, { outcome: 'ok', skipReason: null });
    for (const u of parsed.unchecked || []) {
      if (batchIds.has(u.rule_id)) {
        journal.set(u.rule_id, { outcome: 'skipped', skipReason: `модель: ${String(u.reason).slice(0, 300)}` });
      }
    }
    const batchFindings = [];
    for (const f of parsed.findings) {
      const entry = batch.find((b) => b.rule.id === f.rule_id);
      if (!entry) continue; // находка по чужому правилу не принимается
      const rule = entry.rule;
      if (COMPLIANCE_RE.test(f.wording || '') && !/не соответствует/iu.test(f.wording || '')) continue;
      // НТД и пункт — из правила, не из ответа модели
      const check = await verifyRule({ doc, rule, docQuote: f.quote, ntdQuote: f.ntd_quote, wording: f.wording });
      journal.set(rule.id, { outcome: 'finding', skipReason: null });
      batchFindings.push({
        rule,
        origin: 'llm',
        verification: check.verification,
        location: {
          file: f.location_file || (files[0] && files[0].original_name) || '',
          hint: f.location_hint || '',
        },
        docQuote: f.quote || null,
        ntdQuote: f.ntd_quote || null,
        confidence: Math.max(0, Math.min(1, Number(f.confidence) || 0)),
        detail: detailOf(check, truncated),
        wordingOverride: f.wording && f.wording.length > 20 ? f.wording : null,
        modelWording: f.wording || '',
        retryReasons: retryable(check.reasons),
      });
    }

    // Возврат автору: находки, не подтверждённые из-за цитаты, уходят той же
    // модели в том же диалоге (правила + документ → её ответ → задание повтора).
    // Статус меняет только verify.js; сбой повтора прогон не роняет.
    const pending = (f) => (f.verification === 'needs_human' && f.retryReasons.length ? f.retryReasons.join('; ') : null);
    if (config.quoteRetryRounds && batchFindings.some(pending)) {
      const { findings: retried, stats } = await quoteCheck.retryUnverified({
        findings: batchFindings,
        text: doc,
        pending,
        describe: (f) => `правило ${f.rule.id} (${f.rule.source.ntd} п.${f.rule.source.clause}): `
          + `${f.wordingOverride || f.rule.wording}${f.ntdQuote ? `; твоя цитата пункта НТД: «${f.ntdQuote}»` : ''}`,
        apply: async ({ finding, answer }) => {
          const docQuote = answer.quote || finding.docQuote;
          const ntdQuote = answer.ntd_quote || finding.ntdQuote;
          const check = await verifyRule({ doc, rule: finding.rule, docQuote, ntdQuote, wording: finding.modelWording });
          return {
            ...finding, docQuote, ntdQuote,
            verification: check.verification,
            detail: detailOf(check, truncated),
            retryReasons: retryable(check.reasons),
          };
        },
        call: async (tail, schema) => {
          const res = await withRetry(() => adapter.structuredCall({
            system,
            messages: [{ role: 'user', content: user }, { role: 'assistant', content: raw }, ...tail],
            sessionId,
            route,
            schema,
            schemaName: 'quote_retry',
            maxTokens: MAX_TOKENS,
            internal: true, // служебное обращение: токены считает, счётчик запросов не расходует
          }));
          return adapter.tryParse(res.text);
        },
      });
      for (const f of retried) f.detail = retryDetail(f, truncated);
      addStats(retry, stats);
      findings.push(...retried);
    } else {
      findings.push(...batchFindings);
    }
  }
  return { findings, journal, retry };
}

module.exports = { runLlmRules, SCHEMA, ensureServiceSession, VERSION };
