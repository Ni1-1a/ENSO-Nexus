'use strict';
/**
 * Сверка цитат модели с текстом документа — ОДНА на всю платформу.
 *
 * Правило платформы: модель интерпретирует, код проверяет. Цитата, которую
 * модель назвала «дословной», засчитывается только если она дословно (после
 * нормализации кавычек, тире, ё, регистра и пробелов) находится в тексте
 * проверяемого документа. Находка с ненайденной или пустой цитатой НЕ
 * выбрасывается — она идёт человеку с пометкой `needs_human` и причиной,
 * чтобы непроверенное не выглядело проверенным (правило нормоконтроля,
 * normo/checks/verify.js; с 07.10.2026 то же — в «Анализе ТЗ» и «Проверке
 * документа»).
 *
 * Поля, которые получает находка (одинаковые во всех модулях):
 *   quote_check — 'verbatim' | 'not_found' | 'missing';
 *   quote_note  — причина для человека или null, если цитата найдена;
 *   needs_human — становится true, если цитата не найдена или её нет.
 *
 * Возврат неподтверждённой находки автору (07.10.2026, решение владельца: до
 * двух кругов, `QUOTE_RETRY_ROUNDS`). Находка, которую сверка не подтвердила,
 * возвращается ТОЙ ЖЕ модели в том же диалоге (`retryUnverified`): дать точную
 * цитату, снять находку или оставить без цитаты с объяснением. Статус меняет
 * только повторная сверка кодом; снятые и оставленные без цитаты находки не
 * удаляются — они идут человеку с причиной модели. Итог круга — в поле
 *   quote_retry — 'confirmed' | 'withdrawn' | 'kept' | 'unconfirmed' | 'unanswered'
 * и в сводке `retryStats` (для «не удалось проверить» и журнала прогона).
 * Сбой повтора (обрыв, неразборный ответ) прогон не роняет: находки остаются
 * как были, сбой записывается в сводку.
 */
const config = require('../config');

const MIN_QUOTE = 12;

const REASON = {
  missing: 'нет содержательной цитаты из проверяемого документа',
  not_found: 'цитата не найдена в тексте проверяемого документа дословно',
};

const LABEL = {
  verbatim: 'найдена дословно',
  not_found: 'не найдена дословно',
  missing: 'нет цитаты',
};

/** Нормализация для сравнения цитат: кавычки/тире/ё/регистр/пробелы. */
function normalize(s) {
  return String(s || '')
    .replace(/[«»„“”"]/g, '"')
    .replace(/[–—−]/g, '-')
    .replace(/[её]/gi, 'е')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Цитата содержательна (не короче MIN_QUOTE после нормализации) и есть в тексте дословно. */
function quoteInText(quote, text) {
  const q = normalize(quote);
  if (q.length < MIN_QUOTE) return false;
  return normalize(text).includes(q);
}

/**
 * @returns {{status: 'verbatim'|'not_found'|'missing', reason: string|null}}
 */
function checkQuote(quote, text) {
  if (!quote || normalize(quote).length < MIN_QUOTE) return { status: 'missing', reason: REASON.missing };
  if (!quoteInText(quote, text)) return { status: 'not_found', reason: REASON.not_found };
  return { status: 'verbatim', reason: null };
}

/**
 * Пометить находку модели результатом сверки. Возвращает новый объект:
 * quote_check, quote_note и needs_human (не снимается, только ставится).
 */
function markQuote(finding, text) {
  const { status, reason } = checkQuote(finding.quote, text);
  return {
    ...finding,
    quote_check: status,
    quote_note: reason,
    needs_human: !!finding.needs_human || status !== 'verbatim',
  };
}

/** Сводка для блока «не удалось проверить»: сколько находок с цитатой не прошли сверку. */
function unverifiedSummary(findings) {
  const notFound = findings.filter((f) => f.quote_check === 'not_found').length;
  const missing = findings.filter((f) => f.quote_check === 'missing').length;
  if (!notFound && !missing) return null;
  const parts = [];
  if (notFound) parts.push(`${notFound} — цитата не найдена в тексте дословно`);
  if (missing) parts.push(`${missing} — без цитаты`);
  return {
    what: `Находки модели без дословного подтверждения в документе: ${parts.join(', ')}`,
    why: 'цитата сверяется кодом с текстом документа; такие находки помечены «нужна проверка человеком» и не выброшены',
  };
}

/* ---------------- возврат находки модели-автору ---------------- */

const RETRY_DECISIONS = ['quote', 'withdraw', 'keep'];

const RETRY_LABEL = {
  confirmed: 'подтверждена дословной цитатой после повторного запроса',
  withdrawn: 'снята моделью при повторном запросе',
  kept: 'оставлена моделью без цитаты',
  unconfirmed: 'не подтверждена и после повторного запроса',
  unanswered: 'модель не ответила на повторный запрос',
};

/** Схема ответа на повтор — одна на все модули; required перечисляет все ключи, необязательное — союз с null. */
const RETRY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['answers'],
  properties: {
    answers: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['ref', 'decision', 'quote', 'ntd_quote', 'reason'],
        properties: {
          ref: { type: 'string' },
          decision: { type: 'string', enum: RETRY_DECISIONS },
          quote: { type: ['string', 'null'] },
          ntd_quote: { type: ['string', 'null'] },
          reason: { type: 'string' },
        },
      },
    },
  },
};

/** Ссылка на находку в списке для модели: её id, иначе порядковый номер. */
function retryRef(finding, index) {
  return finding.id ? String(finding.id) : `R-${index + 1}`;
}

/** Находка ждёт повтора по умолчанию, если цитата сверкой не подтверждена и повтора по ней ещё не было. */
function defaultPending(f) {
  if (!f.quote_check || f.quote_check === 'verbatim') return null;
  return f.quote_note || REASON[f.quote_check] || 'цитата не подтверждена';
}

/** Применение ответа по умолчанию (ТЗ, проверка документа): новая цитата — повторная сверка тем же кодом. */
function defaultApply({ finding, answer, text, baseNeedsHuman, index }) {
  const base = baseNeedsHuman ? !!baseNeedsHuman(finding, index) : false;
  return markQuote({ ...finding, quote: answer.quote, needs_human: base }, text);
}

/** Причина модели для человека: не длиннее 600 знаков, обрезка по границе слова, не посреди него. */
function clipReason(text, max = 600) {
  const t = String(text || '').trim().replace(/\s+/g, ' ');
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const at = cut.lastIndexOf(' ');
  return `${(at > max / 2 ? cut.slice(0, at) : cut).replace(/[\s,;:]+$/, '')}…`;
}

/** Итог повтора одной строкой для интерфейса и выгрузок. */
function retryNote(outcome, round) {
  return `${RETRY_LABEL[outcome] || outcome}${round ? ` (круг ${round})` : ''}`;
}

function emptyStats() {
  return { rounds: 0, returned: 0, confirmed: 0, withdrawn: 0, kept: 0, unconfirmed: 0, unanswered: 0, calls: 0, error: null };
}

/**
 * Вернуть неподтверждённые находки модели-автору — до `rounds` кругов.
 *
 * @param findings  находки модуля (порядок сохраняется; возвращается новый массив)
 * @param text      полный текст проверяемого документа (для сверки по умолчанию)
 * @param call      async (tail, schema) → объект ответа или null; tail — хвост
 *                  диалога: задание повтора и, на втором круге, предыдущий обмен.
 *                  Модуль сам подставляет свой system и исходный диалог.
 * @param pending   (f) → причина возврата или null (по умолчанию — сверка цитаты)
 * @param describe  (f) → короткий текст находки для списка (что и где)
 * @param apply     async ({finding, answer, text, baseNeedsHuman, index}) → обновлённая находка
 * @param baseNeedsHuman (f, index) → нужна ли проверка человеком БЕЗ учёта цитаты
 * @param onRound   (round, count) — прогресс для человека
 * @returns {{ findings, stats }}
 */
async function retryUnverified({
  findings, text, call, rounds = config.quoteRetryRounds,
  pending = defaultPending, describe, apply = defaultApply, baseNeedsHuman = null,
  onRound = null, prompts = require('./prompts'),
}) {
  const stats = emptyStats();
  const out = findings.slice();
  if (!rounds || !call) return { findings: out, stats };

  // кто ждёт повтора: индекс → причина; закрытые решением модели (withdraw/keep) выбывают
  const open = new Map();
  out.forEach((f, i) => { const why = pending(f); if (why) open.set(i, why); });
  stats.returned = open.size;
  if (!open.size) return { findings: out, stats };

  const tail = [];
  for (let round = 1; round <= rounds && open.size; round++) {
    stats.rounds = round;
    if (onRound) onRound(round, open.size);
    const issues = [...open.entries()].map(([i, why], n) => {
      const f = out[i];
      const what = describe ? describe(f) : (f.what || f.problem || f.wording || '');
      const quote = f.quote || f.docQuote || null;
      return `${n + 1}. ref: ${retryRef(f, i)} — ${what}; твоя цитата: ${quote ? `«${quote}»` : 'нет'}; причина: ${why}`
        + (round > 1 ? ' (повторно)' : '');
    }).join('\n');
    tail.push({ role: 'user', content: prompts.load('tasks/quote-retry', { issues }) });

    let parsed = null;
    try {
      stats.calls += 1;
      parsed = await call(tail, RETRY_SCHEMA);
    } catch (err) {
      stats.error = `круг ${round}: ${String(err && err.message || err).slice(0, 300)}`;
      break;
    }
    if (!parsed || !Array.isArray(parsed.answers)) {
      stats.error = `круг ${round}: модель вернула неразборный ответ`;
      break;
    }
    tail.push({ role: 'assistant', content: JSON.stringify(parsed) });

    const byRef = new Map();
    for (const a of parsed.answers) {
      if (a && typeof a.ref === 'string' && !byRef.has(a.ref.trim())) byRef.set(a.ref.trim(), a);
    }
    for (const [i, why] of [...open.entries()]) {
      const f = out[i];
      const a = byRef.get(retryRef(f, i));
      if (!a || !RETRY_DECISIONS.includes(a.decision)) continue; // без ответа — ждёт следующего круга
      const reason = clipReason(a.reason);
      if (a.decision === 'withdraw') {
        out[i] = {
          ...f, quote_retry: 'withdrawn', quote_retry_rounds: round, needs_human: true,
          quote_retry_note: retryNote('withdrawn', round),
          quote_note: `${RETRY_LABEL.withdrawn}${reason ? `: ${reason}` : ''}`,
        };
        open.delete(i);
        stats.withdrawn += 1;
        continue;
      }
      if (a.decision === 'keep') {
        out[i] = {
          ...f, quote_retry: 'kept', quote_retry_rounds: round, needs_human: true,
          quote_retry_note: retryNote('kept', round),
          quote_note: `${RETRY_LABEL.kept}${reason ? `: ${reason}` : ''}; ${why}`,
        };
        open.delete(i);
        stats.kept += 1;
        continue;
      }
      const updated = await apply({ finding: f, answer: a, text, baseNeedsHuman, index: i });
      const again = pending(updated);
      if (!again) {
        out[i] = { ...updated, quote_retry: 'confirmed', quote_retry_rounds: round, quote_retry_note: retryNote('confirmed', round) };
        open.delete(i);
        stats.confirmed += 1;
      } else {
        out[i] = { ...updated, quote_retry: 'unconfirmed', quote_retry_rounds: round, quote_retry_note: retryNote('unconfirmed', round) };
        open.set(i, again);
      }
    }
  }
  // что осталось открытым после всех кругов — не подтверждено или без ответа
  for (const [i] of open) {
    const f = out[i];
    if (f.quote_retry === 'unconfirmed') {
      out[i] = { ...f, quote_note: f.quote_note ? `${f.quote_note}; ${RETRY_LABEL.unconfirmed}` : RETRY_LABEL.unconfirmed };
      stats.unconfirmed += 1;
    } else {
      out[i] = { ...f, quote_retry: 'unanswered', quote_retry_rounds: stats.rounds, quote_retry_note: retryNote('unanswered', stats.rounds) };
      stats.unanswered += 1;
    }
  }
  return { findings: out, stats };
}

/** Строка сводки повтора для «не удалось проверить» и журнала; null, если повтора не было. */
function retrySummary(stats) {
  if (!stats || !stats.returned) return null;
  const parts = [
    stats.confirmed ? `подтверждено ${stats.confirmed}` : null,
    stats.withdrawn ? `снято моделью ${stats.withdrawn}` : null,
    stats.kept ? `оставлено без цитаты ${stats.kept}` : null,
    stats.unconfirmed ? `не подтверждено ${stats.unconfirmed}` : null,
    stats.unanswered ? `без ответа ${stats.unanswered}` : null,
  ].filter(Boolean);
  const what = `Повторный запрос модели по ${stats.returned} находкам без дословной цитаты`
    + ` (кругов: ${stats.rounds}): ${parts.join(', ') || 'ответа нет'}`
    + (stats.error ? `; сбой повтора — ${stats.error}` : '');
  return {
    what,
    why: 'цитата сверяется кодом с текстом документа; статус менялся только по итогу повторной сверки, '
      + 'снятые, оставленные без цитаты и неподтверждённые находки остались на ручной проверке',
  };
}

module.exports = {
  MIN_QUOTE, REASON, LABEL, normalize, quoteInText, checkQuote, markQuote, unverifiedSummary,
  RETRY_SCHEMA, RETRY_LABEL, RETRY_DECISIONS, retryRef, retryNote, retryUnverified, retrySummary,
};
