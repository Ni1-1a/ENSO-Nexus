'use strict';
/**
 * Тома, пакеты и карта сборки (А4) — чистые функции без файлов.
 *
 * Том = исходный файл. Марка и номер (АР1, КЖ0, ОВ2, ЭОМ…) берутся из имени
 * регулярным выражением — последний токен перед «_изм.N»/«.изм.N» и «.pdf»;
 * если не распозналось, заголовком тома остаётся имя файла.
 */
const path = require('path');

// 05_ЭНСО-21072023-Р-АР3_изм.0.pdf → АР3; 33_ЭНСО-…-ОС.изм.0.pdf → ОС; 15_ЭНСО–…-Р-ЭОМ_изм.1.pdf → ЭОМ
const MARK_RE = /[-_–—.\s]([А-ЯЁA-Z]{1,6}\d{0,3}(?:\.\d{1,2})?)(?:[._\s-]*изм\.?\s*\d+)?\s*\.pdf$/iu;
const NUM_RE = /^(\d{1,3})[_\s.-]/;

function tomeOf(file) {
  const name = String(file.name || '');
  const stem = name.replace(/\.pdf$/i, '');
  const mark = MARK_RE.exec(name);
  const num = NUM_RE.exec(name);
  const recognized = !!mark;
  return {
    fileId: file.id, name, stem,
    num: num ? num[1] : '',
    mark: recognized ? mark[1].toUpperCase() : '',
    title: recognized ? `${num ? `${num[1]} ` : ''}${mark[1].toUpperCase()}` : stem,
    recognized,
  };
}

function safeName(s) {
  return String(s).replace(/[\x00-\x1f<>:"/\\|?*]/g, '_').replace(/\s+/g, ' ').trim();
}

/** Имя пакета: корзины — ПАКЕТ_А4.pdf; тома — 05_АР3__А4.pdf (НС — 05_АР3__НС_А1.pdf). */
function packageName(bucket, tome, { carrierSuffix = '' } = {}) {
  const b = safeName(bucket.replace(/^_/, '').replace(/\s+/g, '_'));
  const suffix = carrierSuffix ? `_${safeName(carrierSuffix)}` : '';
  if (!tome) return `ПАКЕТ_${b}${suffix}.pdf`;
  const head = tome.recognized ? `${tome.num ? `${tome.num}_` : ''}${tome.mark}` : tome.stem;
  return `${safeName(head).slice(0, 80)}__${b}${suffix}.pdf`;
}

function partName(fileName, index, total) {
  return fileName.replace(/\.pdf$/i, `__часть${index}из${total}.pdf`);
}

/**
 * План деления по страницам: функция measure(n) собирает кандидата из первых n
 * ещё не уложенных страниц и возвращает его размер в байтах. Двоичный поиск по
 * числу страниц: размер куска заранее не известен (ресурсы общие), собирать по
 * разу на страницу слишком дорого. Возвращает список длин частей.
 *
 * @param {number} total       страниц в пакете
 * @param {object} limits      { maxBytes, maxPages } (0 — без ограничения)
 * @param {Function} measure   async (start, count) → bytes
 */
async function splitPlan(total, limits, measure) {
  const maxPages = limits.maxPages > 0 ? limits.maxPages : total;
  const maxBytes = limits.maxBytes > 0 ? limits.maxBytes : Infinity;
  const parts = [];
  let start = 0;
  while (start < total) {
    const cap = Math.min(maxPages, total - start);
    let lo = 1, hi = cap, best = 0, bestBytes = 0;
    // сначала проверяем «всё влезает» — это самый частый случай и один сбор
    const whole = await measure(start, cap);
    if (whole <= maxBytes) { best = cap; bestBytes = whole; } else {
      hi = cap - 1;
      while (lo <= hi) {
        const mid = Math.ceil((lo + hi) / 2);
        const bytes = await measure(start, mid);
        if (bytes <= maxBytes) { best = mid; bestBytes = bytes; lo = mid + 1; } else hi = mid - 1;
      }
    }
    if (best === 0) {
      // один лист сам по себе больше предела — отдельным пакетом с предупреждением
      const bytes = await measure(start, 1);
      parts.push({ start, count: 1, bytes, oversize: true });
      start += 1;
      continue;
    }
    parts.push({ start, count: best, bytes: bestBytes, oversize: false });
    start += best;
  }
  return parts;
}

/**
 * Карта сборки тома: лист тома N → пакет X, страница Y, носитель Z. Строится из
 * записей разбора (у каждой есть package и packagePage).
 */
function assemblyMap(tomes, records) {
  const byFile = new Map();
  for (const r of records) {
    if (!byFile.has(r.fileId)) byFile.set(r.fileId, []);
    byFile.get(r.fileId).push(r);
  }
  return tomes.map((t) => ({
    tome: t,
    rows: (byFile.get(t.fileId) || []).sort((a, b) => a.page - b.page).map((r) => ({
      sheet: r.page, format: r.format === '-' ? 'НС' : r.format, size: `${Math.round(r.width)}×${Math.round(r.height)}`,
      package: r.package || '', packagePage: r.packagePage || 0, carrier: r.carrier, bucket: r.bucket,
    })),
  }));
}

function csvCell(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function assemblyCsv(map) {
  const rows = [['Том', 'Файл', 'Лист тома', 'Формат', 'Размер, мм', 'Пакет', 'Стр. в пакете', 'Корзина', 'Носитель'].map(csvCell).join(';')];
  for (const t of map) {
    for (const r of t.rows) rows.push([t.tome.title, t.tome.name, r.sheet, r.format, r.size, r.package, r.packagePage, r.bucket, r.carrier].map(csvCell).join(';'));
  }
  return `﻿${rows.join('\r\n')}\r\n`;
}

function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

/** Печатная карта сборки: по тому — таблица, разрыв страницы между томами. */
function assemblyHtml(map, { title = 'Карта сборки томов', generated = new Date() } = {}) {
  const blocks = map.map((t) => `
<section class="tome">
  <h2>${esc(t.tome.title)} <small>${esc(t.tome.name)} · ${t.rows.length} л.</small></h2>
  <table>
    <thead><tr><th>Лист</th><th>Формат</th><th>Размер, мм</th><th>Пакет</th><th>Стр.</th><th>Носитель</th></tr></thead>
    <tbody>${t.rows.map((r) => `<tr><td>${r.sheet}</td><td>${esc(r.format)}</td><td>${esc(r.size)}</td><td>${esc(r.package.replace(/\.pdf$/i, ''))}</td><td>${r.packagePage || '—'}</td><td>${esc(r.carrier)}</td></tr>`).join('')}</tbody>
  </table>
</section>`).join('\n');
  return `<!DOCTYPE html>
<html lang="ru"><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>
  body { font: 12px/1.4 -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; color: #26211b; margin: 20px; }
  h1 { font-size: 18px; margin: 0 0 4px; } .meta { color: #6b6457; margin-bottom: 16px; }
  h2 { font-size: 14px; margin: 18px 0 6px; } h2 small { font-weight: normal; color: #6b6457; }
  table { border-collapse: collapse; width: 100%; } th, td { border: 1px solid #d8d0c0; padding: 3px 6px; text-align: left; }
  th { background: #f3efe6; } .tome { page-break-inside: avoid; } .tome + .tome { page-break-before: always; }
  @media print { body { margin: 10mm; } }
</style></head><body>
<h1>${esc(title)}</h1>
<div class="meta">Enso-nexus · Разбор PDF по форматам · ${esc(generated.toLocaleString('ru-RU'))}. Листы с разных принтеров собираются в исходном порядке тома.</div>
${blocks}
</body></html>`;
}

module.exports = { tomeOf, packageName, partName, splitPlan, assemblyMap, assemblyCsv, assemblyHtml, MARK_RE };
