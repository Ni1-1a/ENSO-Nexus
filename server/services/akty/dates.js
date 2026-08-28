'use strict';
/**
 * Сверка дат актов освидетельствования с записями общего журнала работ
 * (пост 294 канала; приём А18-A: задача целиком алгоритмическая — код, не LLM).
 *
 * Вход — два реестра (XLSX через xlsx-read): акты (номер, вид работ, дата)
 * и журнал (дата записи, содержание). Сопоставление — по совпадению
 * формулировок вида работ (нормализованные слова, доля общих ≥ 0.5);
 * это эвристика, и отчёт честно делит строки на сопоставленные и нет —
 * несопоставленный акт не означает отсутствие записи.
 *
 * Конфликт: запись о выполнении ПОЗЖЕ даты акта (акт подписан раньше, чем
 * работа записана в журнале) либо записи не нашлось вовсе.
 */

function parseDate(value) {
  const s = String(value || '').trim();
  let m = /^(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{2,4})/.exec(s);
  if (m) {
    const year = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    const d = new Date(Date.UTC(year, Number(m[2]) - 1, Number(m[1])));
    return Number.isNaN(d.getTime()) ? null : d;
  }
  m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (m) {
    const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

const fmtDate = (d) => (d ? `${String(d.getUTCDate()).padStart(2, '0')}.${String(d.getUTCMonth() + 1).padStart(2, '0')}.${d.getUTCFullYear()}` : '');

/** Колонка по ключевым словам заголовка; нет — null (не угадывать молча). */
function findColumn(headers, patterns) {
  for (const p of patterns) {
    const hit = headers.find((hd) => hd.toLowerCase().includes(p));
    if (hit) return hit;
  }
  return null;
}

function words(text) {
  return String(text || '').toLowerCase()
    .replace(/ё/g, 'е')
    .split(/[^a-zа-я0-9]+/u)
    .filter((w) => w.length >= 3);
}

function similarity(a, b) {
  const wa = new Set(words(a));
  const wb = new Set(words(b));
  if (!wa.size || !wb.size) return 0;
  let common = 0;
  for (const w of wa) if (wb.has(w)) common += 1;
  return common / Math.min(wa.size, wb.size);
}

const MATCH_THRESHOLD = 0.5;

/**
 * actsTable, journalTable — результат xlsx-read.readTable.
 * Возвращает { rows, unmatchedJournal, columns, warnings }.
 */
function compare(actsTable, journalTable) {
  const warnings = [];
  const actNoCol = findColumn(actsTable.headers, ['номер', '№']);
  const actDateCol = findColumn(actsTable.headers, ['дата']);
  const actWorkCol = findColumn(actsTable.headers, ['вид работ', 'работ', 'наименование']);
  const jrnDateCol = findColumn(journalTable.headers, ['дата']);
  const jrnTextCol = findColumn(journalTable.headers, ['содержан', 'работ', 'наименование', 'запись']);

  if (!actDateCol || !actWorkCol) {
    throw new Error(`В реестре актов не найдены колонки даты и вида работ (заголовки: ${actsTable.headers.join(', ')})`);
  }
  if (!jrnDateCol || !jrnTextCol) {
    throw new Error(`В журнале не найдены колонки даты и содержания записи (заголовки: ${journalTable.headers.join(', ')})`);
  }
  if (!actNoCol) warnings.push('Колонка номера акта не найдена — акты нумеруются по порядку строк');

  const journal = journalTable.rows.map((r, i) => ({
    index: i,
    date: parseDate(r[jrnDateCol]),
    text: r[jrnTextCol],
    used: false,
  }));

  const rows = actsTable.rows.map((r, i) => {
    const actDate = parseDate(r[actDateCol]);
    const work = r[actWorkCol];
    // лучшая по похожести запись журнала; при равной похожести — ближайшая по дате
    let best = null;
    let bestScore = 0;
    for (const j of journal) {
      const score = similarity(work, j.text);
      if (score < MATCH_THRESHOLD) continue;
      const better = score > bestScore
        || (score === bestScore && best && actDate && j.date
          && Math.abs(j.date - actDate) < Math.abs(best.date - actDate));
      if (!best || better) { best = j; bestScore = score; }
    }
    if (best) best.used = true;

    let conflict = null;
    let daysDiff = null;
    if (!actDate) conflict = 'дата акта не разобрана';
    else if (!best) conflict = 'запись в журнале не найдена (по совпадению формулировок)';
    else if (!best.date) conflict = 'дата записи журнала не разобрана';
    else {
      daysDiff = Math.round((best.date - actDate) / 86400000);
      conflict = daysDiff > 0 ? `запись позже акта на ${daysDiff} дн.` : null;
    }

    return {
      act_no: actNoCol ? (r[actNoCol] || String(i + 1)) : String(i + 1),
      work,
      act_date: fmtDate(actDate) || String(r[actDateCol] || ''),
      journal_date: best ? (fmtDate(best.date) || String(best.text || '').slice(0, 40)) : '',
      journal_text: best ? String(best.text || '').slice(0, 200) : '',
      match_score: best ? Number(bestScore.toFixed(2)) : 0,
      days_diff: daysDiff,
      conflict,
    };
  });

  const unmatchedJournal = journal.filter((j) => !j.used && j.text)
    .map((j) => ({ date: fmtDate(j.date), text: String(j.text).slice(0, 200) }));

  return {
    rows,
    conflicts: rows.filter((r) => r.conflict).length,
    unmatchedJournal,
    columns: { actNoCol, actDateCol, actWorkCol, jrnDateCol, jrnTextCol },
    warnings: [
      ...warnings,
      'Сопоставление акт↔журнал — по совпадению формулировок: строки без пары проверяются вручную',
      'Сверяется только то, что есть в выгрузках: пропущенная запись — пропущенный конфликт',
    ],
  };
}

module.exports = { compare, parseDate, similarity, findColumn };
