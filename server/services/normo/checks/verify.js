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
// Сверка цитаты с текстом документа — общая на платформу (services/quote-check.js):
// тем же кодом и теми же формулировками пользуются «Анализ ТЗ» и «Проверка документа».
const { MIN_QUOTE, normalize, quoteInText, checkQuote } = require('../../quote-check');

/**
 * @returns {ok, verification: 'auto'|'needs_human', reasons: string[]}
 */
async function verifyFinding({ docText, docQuote, ntd, ntdClause, ntdQuote }) {
  const reasons = [];

  const docCheck = checkQuote(docQuote, docText);
  if (docCheck.reason) reasons.push(docCheck.reason);

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
