'use strict';
/**
 * Сверка ссылок на нормы в ответе модели с выдержками базы знаний — ОДНА на
 * платформу: модуль «Вопрос по нормам» и обсуждение выделенного фрагмента.
 *
 * Правило платформы: модель интерпретирует, код проверяет. Ссылка «[шифр,
 * п. N]» засчитывается подтверждённой только когда она указывает на выдержку,
 * которую модель и получила: тот же документ, тот же пункт, а цитата дословно
 * (нормализация — общая, из quote-check.js) лежит в тексте этой выдержки.
 * Всё остальное НЕ выбрасывается, а понижается со статусом и причиной —
 * непроверенное не должно выглядеть проверенным (то же правило, что у цитат
 * в нормоконтроле, ТЗ и проверке документа).
 *
 * Статусы ссылки (поле status):
 *   confirmed — выдержка найдена, документ, пункт и цитата сходятся;
 *   partial   — документ в выдержках есть, но пункт или цитата не сходятся — сверить;
 *   registry  — в выдержках документа нет, но шифр есть в реестре НТД — сверить вручную;
 *   unknown   — ни в выдержках, ни в реестре: источник не подтверждён.
 *
 * Реестр (нормоконтроль/knowledge/ntd-registry.yaml) — подсказка, не вердикт:
 * «нет в реестре» значит «сверить вручную», а не «документа не существует».
 */
const quoteCheck = require('./quote-check');
const ntdRefs = require('./doccheck/ntd-refs');

const LABEL = {
  confirmed: 'подтверждено выдержкой',
  partial: 'выдержка есть, пункт или цитата не сходятся — сверить',
  registry: 'в реестре НТД есть, выдержки нет — сверить вручную',
  unknown: 'не найдено ни в выдержках, ни в реестре',
};

/** Ссылка в свободном тексте (без записи citations): откуда она. */
const REF_LABEL = {
  excerpt: 'документ есть в выдержках',
  registry: 'в реестре НТД есть, в выдержках нет',
  unknown: 'не найдено ни в выдержках, ни в реестре',
};

const MAX_EXCERPT_CHARS = 1400;

/** Обозначение документа для сравнения: регистр, пробелы, тире, кавычки, «п.»-хвосты. */
function normCode(code) {
  return ntdRefs.normalizeCode(String(code || '').replace(/[«»"„“”]/g, ' '))
    .replace(/\s*,\s*(П|ПУНКТ|ПП)\.?\s*[\d.]+.*$/i, '') // «СП 4.13130.2013, п. 6.1.1» → только документ
    .replace(/\s+/g, ' ')
    .trim();
}

/** Один и тот же документ: равенство или вхождение (документ базы может нести пояснение в имени). */
function sameDoc(a, b) {
  const na = normCode(a); const nb = normCode(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const short = na.length <= nb.length ? na : nb;
  const long = na.length <= nb.length ? nb : na;
  if (short.length < 5) return false;
  // граница слова: «СП 4.13130.2013» не должен совпасть с «СП 4.13130.2013-БИС» через цифру
  const at = long.indexOf(short);
  if (at < 0) return false;
  const after = long[at + short.length];
  return after === undefined || !/[\dA-ZА-ЯЁ]/i.test(after);
}

/** Номер пункта для сравнения: «п. 4.2.5.» → «4.2.5», «Приложение Ж» → «прил. ж». */
function normClause(clause) {
  return String(clause || '')
    .toLowerCase()
    .replace(/^\s*(?:пп?\.|пункт)\s*/i, '')
    .replace(/^\s*п\s+(?=\d)/i, '')
    .replace(/^\s*приложение\s+/i, 'прил. ')
    .replace(/\s+/g, ' ')
    .replace(/[.\s]+$/g, '')
    .trim();
}

/** Пункт сходится: тот же или один вложен в другой по границе точки («4.2» ↔ «4.2.5»). */
function sameClause(a, b) {
  const na = normClause(a); const nb = normClause(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  return na.startsWith(`${nb}.`) || nb.startsWith(`${na}.`);
}

/**
 * Блок выдержек для модели: пронумерованные, с документом и пунктом — по
 * номеру модель ссылается, по номеру код сверяет. Формат один для модуля
 * «Вопрос по нормам» и обсуждения фрагмента.
 */
function formatExcerpts(excerpts, { title = 'Выдержки из базы знаний' } = {}) {
  if (!excerpts.length) return '';
  const lines = [`## ${title} (справочно; нормативы называй только отсюда, со ссылкой [n], шифром и пунктом)`];
  for (const e of excerpts) {
    lines.push('', `[${e.n}] ${e.doc}${e.clause ? `, п. ${e.clause}` : ''}${e.source === 'corpus' ? ' (корпус нормоконтроля)' : ''}`,
      String(e.text || '').slice(0, MAX_EXCERPT_CHARS));
  }
  return lines.join('\n');
}

/** Статус шифра по реестру НТД или null, если его там нет. */
function registryEntry(code) {
  const norm = ntdRefs.normalizeCode(normCode(code));
  if (!norm) return null;
  try {
    const reg = ntdRefs.loadRegistry().byCode.get(norm) || null;
    return reg ? { code: reg.code, title: reg.title || '', status: reg.status || '' } : null;
  } catch {
    return null; // реестр недоступен — это «не подтверждено», а не сбой
  }
}

/**
 * Сверка записей citations[] модели с выдержками.
 * @param {Array<{n, doc, clause, quote, claim}>} citations
 * @param {Array<{n, doc, clause, text}>} excerpts — те самые, что ушли модели
 * @returns ссылки с полями status, label, note, excerpt (номер) и registry
 */
function verifyCitations(citations, excerpts) {
  const out = [];
  for (const raw of Array.isArray(citations) ? citations : []) {
    const c = {
      n: Number.isInteger(raw && raw.n) ? raw.n : null,
      doc: String((raw && raw.doc) || '').trim(),
      clause: raw && raw.clause != null ? String(raw.clause).trim() : '',
      quote: String((raw && raw.quote) || '').trim(),
      claim: String((raw && raw.claim) || '').trim(),
    };
    let ex = c.n != null ? excerpts.find((e) => e.n === c.n) || null : null;
    // номер указывает на выдержку про другой документ — номеру не верим, ищем по документу
    if (ex && c.doc && !sameDoc(c.doc, ex.doc)) ex = null;
    if (!ex && c.doc) {
      ex = excerpts.find((e) => sameDoc(c.doc, e.doc) && c.clause && sameClause(c.clause, e.clause))
        || (c.quote ? excerpts.find((e) => sameDoc(c.doc, e.doc) && quoteCheck.quoteInText(c.quote, e.text)) : null)
        || null;
    }
    const notes = [];
    let status;
    if (ex) {
      const clauseOk = !c.clause || !ex.clause || sameClause(c.clause, ex.clause);
      const quoteState = quoteCheck.checkQuote(c.quote, ex.text);
      if (!clauseOk) notes.push(`пункт «${c.clause}» не сходится с выдержкой [${ex.n}] (п. ${ex.clause})`);
      if (quoteState.status !== 'verbatim') notes.push(quoteState.reason.replace('проверяемого документа', 'выдержки'));
      status = clauseOk && quoteState.status === 'verbatim' ? 'confirmed' : 'partial';
      if (!c.doc) c.doc = ex.doc;
    } else if (c.doc && excerpts.some((e) => sameDoc(c.doc, e.doc))) {
      status = 'partial';
      notes.push(c.clause ? `пункт «${c.clause}» в выдержках этого документа не найден` : 'выдержка с такой цитатой не найдена');
    } else {
      const reg = registryEntry(c.doc);
      status = reg ? 'registry' : 'unknown';
      if (reg) notes.push(`по реестру: ${reg.status || 'статус не указан'}`);
      c.registry = reg;
    }
    out.push({ ...c, excerpt: ex ? ex.n : null, status, label: LABEL[status], note: notes.join('; ') || null });
  }
  return out;
}

/**
 * Шифры НТД, названные в свободном тексте ответа, и откуда каждый: из
 * выдержек, из реестра или ниоткуда. Перечень строит код (ntd-refs.extract),
 * модель не участвует.
 */
function refsInText(text, excerpts) {
  const { refs } = ntdRefs.extract(String(text || ''));
  return refs.map((r) => {
    const inExcerpts = excerpts.some((e) => sameDoc(r.code, e.doc));
    const status = inExcerpts ? 'excerpt' : r.registry ? 'registry' : 'unknown';
    return { code: r.code, count: r.count, status, label: REF_LABEL[status], registry: r.registry, verdict: r.verdict };
  });
}

/** Сводка по статусам — для карточки вопроса и строки сводки проекта. */
function summarize(citations) {
  const counts = { confirmed: 0, partial: 0, registry: 0, unknown: 0 };
  for (const c of citations || []) if (counts[c.status] !== undefined) counts[c.status] += 1;
  return counts;
}

module.exports = {
  LABEL, REF_LABEL, MAX_EXCERPT_CHARS,
  normCode, sameDoc, normClause, sameClause, formatExcerpts, registryEntry,
  verifyCitations, refsInText, summarize,
};
