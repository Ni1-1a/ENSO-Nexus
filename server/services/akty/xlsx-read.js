'use strict';
/**
 * Минимальное чтение XLSX: первый лист → массив строк-объектов по заголовкам.
 *
 * Зависимостей на xlsx-библиотеки в проекте нет намеренно; файл — zip с XML,
 * его читает adm-zip (тот же приём, что запись xlsx в tz/export.js, только
 * в обратную сторону). Поддержано ровно то, что нужно реестрам конвейера:
 * sharedStrings, inline-строки, числа и даты (серийные числа Excel).
 *
 * Разбор XML — регулярками по well-formed OOXML. Это осознанный компромисс:
 * файлы приходят из Excel/LibreOffice и корректны; на некорректном XML разбор
 * честно вернёт меньше ячеек, а валидатор заголовков скажет об этом человеку.
 */
const AdmZip = require('adm-zip');

function unescapeXml(s) {
  return String(s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&');
}

function textOf(xmlFragment) {
  // конкатенация всех <t>…</t> внутри фрагмента (rich text дробит строку на runs)
  let out = '';
  const re = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g;
  let m;
  while ((m = re.exec(xmlFragment)) !== null) out += unescapeXml(m[1]);
  return out;
}

function colIndex(ref) {
  // "BC12" → 54 (0-based колонка)
  let n = 0;
  for (const ch of ref) {
    const c = ch.charCodeAt(0);
    if (c >= 65 && c <= 90) n = n * 26 + (c - 64);
    else break;
  }
  return n - 1;
}

/** Серийная дата Excel → «ДД.ММ.ГГГГ»; не дата — исходное число строкой. */
function serialToDate(num) {
  if (!Number.isFinite(num) || num < 20000 || num > 80000) return null;
  const ms = Math.round((num - 25569) * 86400 * 1000);
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  const p = (x) => String(x).padStart(2, '0');
  return `${p(d.getUTCDate())}.${p(d.getUTCMonth() + 1)}.${d.getUTCFullYear()}`;
}

/**
 * buffer XLSX → { headers: [..], rows: [{<заголовок>: строка}], rowCount }.
 * Первая непустая строка листа считается заголовками. Даты приводятся к
 * «ДД.ММ.ГГГГ» только когда колонка похожа на дату (в заголовке есть «дата»).
 */
function readTable(buffer) {
  let zip;
  try { zip = new AdmZip(buffer); } catch { throw new Error('Файл не читается как XLSX (не zip-контейнер)'); }
  const sheetEntry = zip.getEntry('xl/worksheets/sheet1.xml');
  if (!sheetEntry) throw new Error('В XLSX нет первого листа (xl/worksheets/sheet1.xml)');
  const shared = [];
  const sharedEntry = zip.getEntry('xl/sharedStrings.xml');
  if (sharedEntry) {
    const xml = sharedEntry.getData().toString('utf8');
    const re = /<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g;
    let m;
    while ((m = re.exec(xml)) !== null) shared.push(textOf(m[1]));
  }

  const sheetXml = sheetEntry.getData().toString('utf8');
  const rawRows = [];
  const rowRe = /<row(?:\s[^>]*)?>([\s\S]*?)<\/row>/g;
  let rm;
  while ((rm = rowRe.exec(sheetXml)) !== null) {
    const cells = [];
    const cellRe = /<c\s([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let cm;
    while ((cm = cellRe.exec(rm[1])) !== null) {
      const attrs = cm[1];
      const inner = cm[2] || '';
      const refM = /r="([A-Z]+)\d+"/.exec(attrs);
      const typeM = /t="([a-z]+)"/i.exec(attrs);
      const col = refM ? colIndex(refM[1]) : cells.length;
      const type = typeM ? typeM[1] : '';
      let value = '';
      if (type === 's') {
        const v = /<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/.exec(inner);
        value = v ? (shared[Number(unescapeXml(v[1]))] ?? '') : '';
      } else if (type === 'inlineStr') {
        value = textOf(inner);
      } else if (type === 'str') {
        const v = /<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/.exec(inner);
        value = v ? unescapeXml(v[1]) : '';
      } else {
        const v = /<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/.exec(inner);
        value = v ? unescapeXml(v[1]) : '';
      }
      cells[col] = String(value).trim();
      cells.length = Math.max(cells.length, col + 1);
    }
    rawRows.push(cells);
  }

  const headerIdx = rawRows.findIndex((r) => r && r.some((c) => c));
  if (headerIdx === -1) throw new Error('Лист пуст — нет ни одной заполненной строки');
  const headers = rawRows[headerIdx].map((h, i) => (h || `Колонка ${i + 1}`));

  const rows = [];
  for (const raw of rawRows.slice(headerIdx + 1)) {
    if (!raw || !raw.some((c) => c)) continue;
    const row = {};
    headers.forEach((hname, i) => {
      let v = raw[i] === undefined ? '' : String(raw[i]);
      if (v && /дата/i.test(hname) && /^\d+(\.\d+)?$/.test(v)) {
        const asDate = serialToDate(Number(v));
        if (asDate) v = asDate;
      }
      row[hname] = v;
    });
    rows.push(row);
  }
  return { headers, rows, rowCount: rows.length };
}

module.exports = { readTable, serialToDate };
