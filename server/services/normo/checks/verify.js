'use strict';
/**
 * Верификатор LLM-находок — детерминированный код, не модель (правило Этапа 3):
 * замечание выдаётся как подтверждённое только если
 *   1) цитата из проверяемого документа дословно находится в его тексте, и
 *   2) названный пункт НТД существует в корпусе, и цитата пункта находится в его теле.
 * Всё, что не подтверждено, живёт со статусом needs_human и причинами — находка
 * не выбрасывается и не выдаётся за проверенную (П43/П44 согласованного обзора).
 */
const corpus = require('../ntd-corpus');

const MIN_QUOTE = 12;

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

function quoteInText(quote, text) {
  const q = normalize(quote);
  if (q.length < MIN_QUOTE) return false;
  return normalize(text).includes(q);
}

/**
 * @returns {ok, verification: 'auto'|'needs_human', reasons: string[]}
 */
async function verifyFinding({ docText, docQuote, ntd, ntdClause, ntdQuote }) {
  const reasons = [];

  if (!docQuote || normalize(docQuote).length < MIN_QUOTE) {
    reasons.push('нет содержательной цитаты из проверяемого документа');
  } else if (!quoteInText(docQuote, docText)) {
    reasons.push('цитата не найдена в тексте проверяемого документа дословно');
  }

  if (!ntd || !ntdClause) {
    reasons.push('не назван документ НТД или номер пункта');
  } else {
    const { doc, chunks } = await corpus.findClause(ntd, ntdClause);
    if (!doc) {
      reasons.push(`документа «${ntd}» нет в корпусе НТД — пункт не проверить`);
    } else if (!chunks.length) {
      reasons.push(`пункт ${ntdClause} не найден в корпусе документа ${doc.code}`);
    } else if (!ntdQuote || normalize(ntdQuote).length < MIN_QUOTE) {
      reasons.push('нет дословной цитаты пункта НТД');
    } else if (!chunks.some((c) => quoteInText(ntdQuote, c.body))) {
      reasons.push(`цитата пункта не совпадает с текстом ${doc.code} п.${ntdClause} в корпусе`);
    }
  }

  return { ok: reasons.length === 0, verification: reasons.length ? 'needs_human' : 'auto', reasons };
}

module.exports = { verifyFinding, quoteInText, normalize };
