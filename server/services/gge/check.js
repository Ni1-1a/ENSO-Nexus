'use strict';
/**
 * Входной контроль комплекта перед подачей в ГГЭ (решение владельца от
 * 27.08.2026, пункт 4; основа — регламент вх. контроля v1.0, пост 244, приём Д7).
 *
 * ВСЁ детерминировано, модель не участвует: отказы в приёме — это реквизиты,
 * подписи и формат, а не инженерия, и их ловит код:
 *   1. имена и размер файлов по 783/пр (та же логика, что COM-EDOC-007
 *      нормоконтроля: «Раздел ПД N…», ≤ 80 МБ);
 *   2. текстовый слой PDF (порог 120 символов/стр. — как COM-EDOC-006);
 *   3. ПОСИМВОЛЬНАЯ сверка реквизитов: эталонные строки (название объекта,
 *      застройщик, ИНН, кадастровый номер, шифр) ищутся в текстах документов;
 *      «похожее, но не то» показывается с местом расхождения — регистр,
 *      пробелы и знаки в реквизитах значимы;
 *   4. «решатель развилок» по датам (extra-gge-s3): применимая редакция ПП 87,
 *      обязательность XML, метод определения стоимости — сравнением дат,
 *      каждое правило объясняется, чужие даты не используются.
 */
const { execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const os = require('os');
const path = require('path');

const execFileP = promisify(execFile);
const MB = 1024 * 1024;
const TEXT_PER_PAGE_MIN = 120;

/* ---------------- 1. имена и размеры по 783/пр ---------------- */

function checkFilenames(files) {
  const rows = [];
  for (const f of files) {
    const problems = [];
    if (f.size > 80 * MB) problems.push(`размер ${(f.size / MB).toFixed(1)} МБ превышает 80 МБ (783/пр п. 5)`);
    if (!/раздел\s+ПД|подраздел\s+ПД/iu.test(f.name)) {
      problems.push('в названии нет слов «Раздел ПД N» / «подраздел ПД N» (783/пр п. 4)');
    }
    rows.push({ file: f.name, ok: !problems.length, problems });
  }
  return rows;
}

/* ---------------- 2. текстовый слой PDF ---------------- */

async function pdfPages(absPath) {
  try {
    const { stdout } = await execFileP('pdfinfo', [absPath]);
    const m = stdout.match(/^Pages:\s+(\d+)/m);
    return m ? parseInt(m[1], 10) : 0;
  } catch { return 0; }
}

async function checkTextLayers(files) {
  const memory = require('../claude/memory');
  const rows = [];
  for (const f of files) {
    if (path.extname(f.name).toLowerCase() !== '.pdf') {
      rows.push({ file: f.name, skipped: 'не PDF' });
      continue;
    }
    const tmp = path.join(os.tmpdir(), `gge-${process.pid}-${Math.random().toString(36).slice(2)}.pdf`);
    fs.writeFileSync(tmp, f.buffer);
    try {
      const pages = await pdfPages(tmp);
      const text = String(await memory.extractPdfText(tmp, 4_000_000, { mark: false }) || '').trim();
      const perPage = pages > 0 ? Math.round(text.length / pages) : text.length;
      rows.push({
        file: f.name,
        pages,
        chars: text.length,
        ok: pages === 0 ? text.length > 0 : perPage >= TEXT_PER_PAGE_MIN,
        detail: pages > 0 && perPage < TEXT_PER_PAGE_MIN
          ? `извлечено ${text.length} символов на ${pages} стр. — текстового слоя нет (скан)`
          : null,
        text,
      });
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  }
  return rows;
}

/* ---------------- 3. посимвольная сверка реквизитов ---------------- */

const normalizeSoft = (s) => String(s).replace(/\s+/g, ' ').replace(/[«»"]/g, '"').replace(/ё/g, 'е').replace(/Ё/g, 'Е').trim();

/** Ближайшая строка текста к эталону: наибольшая доля общих слов. */
function closestLine(needle, text) {
  const needleWords = new Set(normalizeSoft(needle).toLowerCase().split(/[^a-zа-я0-9]+/u).filter((w) => w.length >= 3));
  if (!needleWords.size) return null;
  let best = null;
  let bestScore = 0;
  for (const line of String(text).split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const lineWords = new Set(t.toLowerCase().replace(/ё/g, 'е').split(/[^a-zа-я0-9]+/u).filter((w) => w.length >= 3));
    let common = 0;
    for (const w of needleWords) if (lineWords.has(w)) common += 1;
    const score = common / needleWords.size;
    if (score > bestScore) { best = t; bestScore = score; }
  }
  return bestScore >= 0.5 ? { line: best.slice(0, 300), score: Number(bestScore.toFixed(2)) } : null;
}

/** Первое место расхождения двух строк — для показа «где именно не так». */
function firstDiff(a, b) {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    if (a[i] !== b[i]) return i;
  }
  return a.length === b.length ? -1 : len;
}

/**
 * fields: { 'Название объекта': 'значение', ... } — эталонные реквизиты,
 * docs: [{ name, text }]. Для каждого реквизита в каждом документе:
 * «точно» / «с отличиями» (нормализованное совпало — различие в пробелах,
 * регистре или кавычках, место показано) / «похожая строка» / «не найдено».
 */
function checkRequisites(fields, docs) {
  const out = [];
  for (const [field, etalon] of Object.entries(fields)) {
    const value = String(etalon || '').trim();
    if (!value) continue;
    const perDoc = [];
    for (const doc of docs) {
      const text = String(doc.text || '');
      if (text.includes(value)) {
        perDoc.push({ file: doc.name, status: 'точно' });
        continue;
      }
      const softText = normalizeSoft(text).toLowerCase();
      const softValue = normalizeSoft(value).toLowerCase();
      const softIdx = softText.indexOf(softValue);
      if (softIdx !== -1) {
        perDoc.push({
          file: doc.name,
          status: 'с отличиями',
          detail: 'совпадает с точностью до регистра/пробелов/кавычек — сверьте написание посимвольно',
        });
        continue;
      }
      const near = closestLine(value, text);
      if (near) {
        const diffAt = firstDiff(normalizeSoft(value), normalizeSoft(near.line));
        perDoc.push({
          file: doc.name,
          status: 'похожая строка',
          found: near.line,
          detail: diffAt >= 0
            ? `расхождение с ${diffAt + 1}-го символа: «${normalizeSoft(value).slice(Math.max(0, diffAt - 12), diffAt + 24)}» ↔ «${normalizeSoft(near.line).slice(Math.max(0, diffAt - 12), diffAt + 24)}»`
            : 'строки различаются длиной',
        });
        continue;
      }
      perDoc.push({ file: doc.name, status: 'не найдено' });
    }
    out.push({
      field,
      value,
      docs: perDoc,
      ok: perDoc.every((d) => d.status === 'точно'),
    });
  }
  return out;
}

/* ---------------- 4. развилки по датам ---------------- */

function parseDate(value) {
  const s = String(value || '').trim();
  let m = /^(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{4})$/.exec(s);
  if (m) return new Date(Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1])));
  m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (m) return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return null;
}

const fmt = (d) => `${String(d.getUTCDate()).padStart(2, '0')}.${String(d.getUTCMonth() + 1).padStart(2, '0')}.${d.getUTCFullYear()}`;

/**
 * Правила регламента вх. контроля v1.0 (дословно из extra-gge-s3):
 *   (1) задание с 01.09.2022 — редакция ПП 87 и XML Раздела 1;
 *   (2) с 02.03.2023 — назначение по 928/пр;
 *   (3) с 08.07.2025 — задание в формате XML;
 *   (4) задание позже даты ФГИС ЦС — РИМ, иначе базисный с текущими ценами.
 * Никаких дат, кроме поданных; чего не хватает — сказано прямо.
 */
function dateForks({ taskDate, fgisDate }) {
  const task = parseDate(taskDate);
  const fgis = parseDate(fgisDate);
  const rules = [];
  const missing = [];
  if (!task) {
    missing.push('дата утверждения задания на проектирование (ДД.ММ.ГГГГ)');
  } else {
    const after = (d, m, y) => task >= new Date(Date.UTC(y, m - 1, d));
    rules.push({
      rule: 'Редакция ПП 87 и XML Раздела 1',
      applies: after(1, 9, 2022),
      explanation: `задание от ${fmt(task)} ${after(1, 9, 2022) ? '≥' : '<'} 01.09.2022`,
    });
    rules.push({
      rule: 'Назначение по 928/пр',
      applies: after(2, 3, 2023),
      explanation: `задание от ${fmt(task)} ${after(2, 3, 2023) ? '≥' : '<'} 02.03.2023`,
    });
    rules.push({
      rule: 'Задание в формате XML',
      applies: after(8, 7, 2025),
      explanation: `задание от ${fmt(task)} ${after(8, 7, 2025) ? '≥' : '<'} 08.07.2025`,
    });
    if (!fgis) {
      missing.push('дата размещения данных во ФГИС ЦС по субъекту — без неё метод определения стоимости (РИМ/базисный) не выводится');
    } else {
      const rim = task > fgis;
      rules.push({
        rule: rim ? 'Метод определения стоимости: РИМ' : 'Метод определения стоимости: базисный с текущими ценами',
        applies: true,
        explanation: `задание от ${fmt(task)} ${rim ? 'позже' : 'не позже'} даты ФГИС ЦС ${fmt(fgis)}`,
      });
    }
  }
  return { rules, missing };
}

module.exports = { checkFilenames, checkTextLayers, checkRequisites, dateForks, parseDate, firstDiff };
