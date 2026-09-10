'use strict';
/**
 * Исправленная редакция ТЗ: исходный текст + принятые формулировки.
 *
 * Правило то же, что у чертежа: собирает КОД, а не модель. Модель предложила
 * текст пункта (prompts/tz-suggest.md), человек его выбрал или переписал —
 * дальше платформа только раскладывает принятое по документу и честно
 * помечает, что и откуда взялось.
 *
 * Как вставляется правка:
 *  - замечание указывает цитату (`quote`), и она найдена в тексте — правка
 *    идёт СРАЗУ ПОСЛЕ абзаца с цитатой, пометкой «уточнение по замечанию»;
 *  - цитаты нет или она не нашлась (пункт вообще отсутствует) — правка уходит
 *    в раздел «Дополнения по результатам проверки» в конце документа.
 * Исходные абзацы не переписываются: экспертиза сверяет редакции, и молча
 * подменённый текст — худшее, что может сделать платформа.
 */
const checklists = require('./checklists');

const HEAD = 'ДОПОЛНЕНИЯ ПО РЕЗУЛЬТАТАМ ПРОВЕРКИ ТЗ';

/** Нормализация для поиска цитаты: пробелы, кавычки и тире у всех разные. */
function norm(s) {
  return String(s || '')
    .replace(/[«»""„"]/g, '"')
    .replace(/[–—−]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Абзацы документа: блок, отделённый пустой строкой. */
function paragraphs(text) {
  const parts = String(text || '').split(/\n{2,}/);
  return parts.map((p, i) => ({ i, text: p }));
}

/**
 * Куда встанет каждая правка.
 *
 * Ищем не только АБЗАЦ с цитатой, но и СТРОКУ в нём. Текст, вынутый из DOCX
 * и PDF, почти не содержит пустых строк: на боевом ТЗ АВИВАК двадцать «абзацев»
 * по 2,5 тыс. знаков каждый, и правка, поставленная «после абзаца», уезжала за
 * две страницы от своего места — в раздел технико-экономических показателей.
 * Поэтому вставка идёт сразу за строкой с цитатой, а блок разрывается на этом
 * месте. Сам текст при этом не переписывается: добавляется только пустая строка.
 *
 * @returns {{paras, inline: Map<номер абзаца, Array<{item, line}>>, tail}}
 */
function place(text, items) {
  const paras = paragraphs(text);
  const normParas = paras.map((p) => norm(p.text));
  const inline = new Map();
  const tail = [];
  for (const item of items) {
    const q = norm(item.quote || '');
    /*
     * Запасной ключ — начало цитаты: модель иногда обрезает хвост фразы. Но
     * берётся он ТОЛЬКО когда встречается в документе один раз. Для русского
     * техтекста 40 знаков — это «требования к проектной документации», и по
     * первому совпадению правка вставала бы в чужой пункт.
     */
    const head = q.length > 40 ? q.slice(0, 40) : '';
    const unique = head && normParas.filter((p) => p.includes(head)).length === 1;
    let at = -1;
    if (q && q.length >= 12) {
      at = normParas.findIndex((p) => p.includes(q));
      if (at < 0 && unique) at = normParas.findIndex((p) => p.includes(head));
    }
    if (at < 0) { tail.push(item); continue; }
    const lines = paras[at].text.split('\n');
    let line = lines.findIndex((l) => norm(l).includes(q));
    if (line < 0 && head) line = lines.findIndex((l) => norm(l).includes(head));
    // цитата разорвана переносами строк — ставим в конец блока, как раньше
    if (line < 0) line = lines.length - 1;
    if (!inline.has(at)) inline.set(at, []);
    inline.get(at).push({ item, line });
  }
  return { paras, inline, tail };
}

/** Подпись правки: пункт состава и основание — чтобы в документе было видно, откуда она. */
function label(item, checklistId) {
  const list = checklists.CHECKLISTS[checklistId];
  const ci = list && item.checklist_item ? list.items.find((x) => x.id === item.checklist_item) : null;
  return [ci ? ci.label : (item.znp_ref || 'замечание'), item.requirement_source || ''].filter(Boolean).join(', ');
}

/**
 * Исправленная редакция.
 * @param {string} text        исходный текст ТЗ
 * @param {Array}  findings    находки прогона
 * @param {Array}  fixes       правки: [{findingId, chosenText, chosenKind, authorName}]
 * @param {string} checklistId чек-лист прогона (для подписи пункта состава)
 * @returns {{text, applied, byFinding}}
 */
function build(text, findings, fixes, checklistId = '') {
  const chosen = new Map((fixes || []).filter((f) => f.chosenText).map((f) => [f.findingId, f]));
  const items = (findings || [])
    .filter((f) => chosen.has(f.id))
    .map((f) => ({ ...f, fix: chosen.get(f.id) }));
  if (!items.length) return { text: String(text || ''), applied: 0, byFinding: [] };

  const { paras, inline, tail } = place(text, items);
  const placedIds = new Set();
  const out = [];
  for (const p of paras) {
    const here = inline.get(p.i) || [];
    if (!here.length) { out.push(p.text); continue; }
    // вставки внутри блока: собираем его заново, разрывая после нужных строк
    const byLine = new Map();
    for (const { item, line } of here) {
      if (!byLine.has(line)) byLine.set(line, []);
      byLine.get(line).push(item);
      placedIds.add(item.id);
    }
    const lines = p.text.split('\n');
    let chunk = [];
    lines.forEach((l, n) => {
      chunk.push(l);
      const items2 = byLine.get(n);
      if (!items2) return;
      out.push(chunk.join('\n'));
      chunk = [];
      for (const item of items2) {
        out.push(`${item.fix.chosenText.trim()}\n\n(уточнение по замечанию ${item.id}: ${label(item, checklistId)})`);
      }
    });
    if (chunk.length) out.push(chunk.join('\n'));
  }
  if (tail.length) {
    out.push(`${HEAD}\n\nЭти пункты добавлены по замечаниям проверки. Нумерация — сквозная в пределах раздела.`);
    tail.forEach((item, n) => {
      out.push(`${n + 1}. ${item.fix.chosenText.trim()}\n\n(по замечанию ${item.id}: ${label(item, checklistId)})`);
    });
  }
  return {
    text: out.join('\n\n'),
    applied: items.length,
    byFinding: items.map((item) => ({
      id: item.id,
      placed: placedIds.has(item.id) ? 'по месту цитаты' : 'в дополнения',
      author: item.fix.authorName || '',
      kind: item.fix.chosenKind || '',
    })),
  };
}

module.exports = { build, HEAD };
