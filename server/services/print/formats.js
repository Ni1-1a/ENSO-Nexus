'use strict';
/**
 * «Разбор PDF по форматам» — таблицы и чистые функции классификации.
 *
 * Лист = одна страница PDF. Габариты берутся из бокса страницы с учётом
 * /Rotate, приводятся к паре (короткая, длинная) и сравниваются с таблицами
 * ГОСТ 2.301-68 в пределах допуска: основной формат → кратный → плюсовой →
 * нестандарт (НС). Порядок обязателен: плюсовые проверяются последними, иначе
 * при большом допуске А3+ перехватит честный кратный лист.
 *
 * Носитель выбирается по КОРОТКОЙ стороне: она должна поместиться в лист
 * принтера или в ширину рулона; длинная сторона задаёт отрез и на выбор рулона
 * не влияет. Так стандартный А2 уходит на рулон 420, а лист 250×1000 — на рулон
 * 297 с отрезом 1000, а не на А0 по признаку длины.
 *
 * Таблицы форматов и парк носителей — park.json рядом (PRINT_PARK_FILE —
 * другой файл): состав рулонов меняется, код от этого не правится.
 * Моделей здесь нет и быть не должно: это чистая геометрия.
 */
const fs = require('fs');
const path = require('path');

const PT_TO_MM = 25.4 / 72;
const REVIEW_BUCKET = '_ТРЕБУЕТ_РЕШЕНИЯ';
const BOXES = { crop: ['cropbox', 'mediabox'], media: ['mediabox'], trim: ['trimbox', 'cropbox', 'mediabox'], art: ['artbox', 'cropbox', 'mediabox'] };

function isPair(v) {
  return Array.isArray(v) && v.length === 2 && v.every((n) => Number.isFinite(n) && n > 0) && v[0] <= v[1];
}

/** park.json проверяется при загрузке: кривая таблица роняет сервер сразу, а не первый прогон. */
function loadPark(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const key of ['basic', 'multiple', 'plus']) {
    if (!raw[key] || typeof raw[key] !== 'object') throw new Error(`park.json: нет таблицы «${key}»`);
    for (const [name, pair] of Object.entries(raw[key])) {
      if (!isPair(pair)) throw new Error(`park.json: формат «${name}» должен быть парой [короткая, длинная] в мм`);
    }
  }
  for (const key of ['sheets', 'rolls', 'plusRolls']) {
    if (!Array.isArray(raw[key])) throw new Error(`park.json: «${key}» должен быть списком`);
    for (const item of raw[key]) {
      if (!item || typeof item.bucket !== 'string' || !Number.isFinite(item.width) || item.width <= 0) {
        throw new Error(`park.json: запись «${key}» без bucket или width`);
      }
      if (key === 'sheets' && !(Number.isFinite(item.length) && item.length >= item.width)) {
        throw new Error(`park.json: лист «${item.bucket}» без length`);
      }
    }
  }
  if (!raw.rolls.length) throw new Error('park.json: нужен хотя бы один рулон');
  return {
    basic: raw.basic, multiple: raw.multiple, plus: raw.plus,
    sheets: raw.sheets.map((s) => ({ ...s })),
    rolls: raw.rolls.map((r) => ({ ...r })),
    plusRolls: raw.plusRolls.map((r) => ({ ...r })),
  };
}

const PARK_FILE = process.env.PRINT_PARK_FILE || path.join(__dirname, 'park.json');
const park = loadPark(PARK_FILE);

/* ---------------- настройки прогона ---------------- */

function defaults() {
  return { tolerance: 3, box: 'crop', scanOnly: false, multiplesOwn: false, plusOwn: true, plusRolls: false };
}

/**
 * Настройки из запроса: допуск 0…20 мм, бокс из четырёх, флаги — булевы.
 * Что не распознано — дефолт; заведомо кривое значение — ошибка с текстом.
 */
function normalizeSettings(raw) {
  const st = defaults();
  const src = raw && typeof raw === 'object' ? raw : {};
  if (src.tolerance !== undefined && src.tolerance !== null && src.tolerance !== '') {
    const t = Number(src.tolerance);
    if (!Number.isFinite(t) || t < 0 || t > 20) throw new Error('Допуск — число от 0 до 20 мм');
    st.tolerance = t;
  }
  if (src.box !== undefined && src.box !== null && src.box !== '') {
    if (!BOXES[src.box]) throw new Error('Бокс страницы: crop, media, trim или art');
    st.box = src.box;
  }
  for (const flag of ['scanOnly', 'multiplesOwn', 'plusOwn', 'plusRolls']) {
    if (src[flag] !== undefined) st[flag] = src[flag] === true || src[flag] === 'true' || src[flag] === 1 || src[flag] === '1';
  }
  return st;
}

/** Рулоны прогона: базовые плюс плюсовые по флагу, по возрастанию ширины. */
function rollsFor(st) {
  const rolls = park.rolls.concat(st && st.plusRolls ? park.plusRolls : []);
  return rolls.slice().sort((a, b) => a.width - b.width);
}

/* ---------------- геометрия ---------------- */

/**
 * Габариты листа в мм по боксам страницы (x0 y0 x1 y1 в пунктах) и /Rotate.
 * Порядок боксов — по настройке (по умолчанию CropBox, при его отсутствии или
 * нулевых размерах — MediaBox). При /Rotate 90 и 270 ширина и высота меняются
 * местами: без этого альбомные листы классифицируются неверно.
 */
function pageSizeMm(boxes, rotate, boxPref = 'crop') {
  const order = BOXES[boxPref] || BOXES.crop;
  let used = null;
  let w = 0;
  let h = 0;
  for (const name of order) {
    const b = boxes && boxes[name];
    if (!Array.isArray(b) || b.length !== 4) continue;
    const bw = Math.abs(b[2] - b[0]);
    const bh = Math.abs(b[3] - b[1]);
    if (bw > 0 && bh > 0) { used = name; w = bw; h = bh; break; }
  }
  if (!used) throw new Error('не удалось прочитать габариты страницы (боксы пустые или нулевые)');
  w *= PT_TO_MM;
  h *= PT_TO_MM;
  const rot = ((Number(rotate) || 0) % 360 + 360) % 360;
  if (rot === 90 || rot === 270) [w, h] = [h, w];
  return { width: round2(w), height: round2(h), rotate: rot, box: used };
}

function round2(n) { return Math.round(n * 100) / 100; }
function round1(n) { return Math.round(n * 10) / 10; }

function matchTable(short, long, table, tol) {
  for (const [name, [s, l]] of Object.entries(table)) {
    if (Math.abs(short - s) <= tol && Math.abs(long - l) <= tol) return name;
  }
  return null;
}

/** Носитель по короткой стороне: сначала листы принтера, потом рулоны по возрастанию. */
function pickCarrier(short, long, tol, rolls) {
  for (const s of park.sheets) {
    if (short <= s.width + tol && long <= s.length + tol) {
      return { bucket: s.bucket, desc: s.desc, rollWidth: 0, cut: 0 };
    }
  }
  for (const r of rolls) {
    if (short <= r.width + tol) return { bucket: r.bucket, desc: r.desc, rollWidth: r.width, cut: round1(long) };
  }
  return null;
}

/**
 * Класс, формат и корзина листа.
 * kind: ГОСТ | ГОСТ кратный | А+ | НС | ОШИБКА (короткая сторона шире всех рулонов).
 */
function classify(short, long, settings) {
  const st = { ...defaults(), ...(settings || {}) };
  const tol = st.tolerance;
  const rolls = rollsFor(st);

  const basic = matchTable(short, long, park.basic, tol);
  const mult = basic ? null : matchTable(short, long, park.multiple, tol);
  const plus = basic || mult ? null : matchTable(short, long, park.plus, tol);

  const carrier = pickCarrier(short, long, tol, rolls);
  if (!carrier) {
    const maxW = Math.max(...rolls.map((r) => r.width));
    return {
      kind: 'ОШИБКА', format: basic || mult || plus || '-', bucket: REVIEW_BUCKET,
      carrier: 'Не помещается ни в один рулон', rollWidth: 0, cut: 0,
      note: `Короткая сторона больше ${maxW} мм — раскрой или масштабирование`,
    };
  }
  const base = { carrier: carrier.desc, rollWidth: carrier.rollWidth, cut: carrier.cut };
  if (basic) return { kind: 'ГОСТ', format: basic, bucket: basic, ...base, note: '' };
  if (mult) {
    return {
      kind: 'ГОСТ кратный', format: mult, bucket: st.multiplesOwn ? mult : `НС ${carrier.bucket}`, ...base,
      note: 'Кратный формат ГОСТ 2.301-68 — печать только на рулоне',
    };
  }
  if (plus) {
    return {
      kind: 'А+', format: plus, bucket: st.plusOwn ? plus : `НС ${carrier.bucket}`, ...base,
      note: 'Плюсовой формат: A-ряд с припуском, обрез после печати',
    };
  }
  return { kind: 'НС', format: '-', bucket: `НС ${carrier.bucket}`, ...base, note: '' };
}

/* ---------------- сводка и отчёты ---------------- */

/** Порядок корзин на экране: от малого к большому, стандарт раньше нестандарта. */
function bucketOrder() {
  const base = Object.keys(park.basic).sort((a, b) => park.basic[a][0] - park.basic[b][0]);
  const withPlus = [];
  for (const b of base) {
    withPlus.push(b);
    if (park.plus[`${b}+`]) withPlus.push(`${b}+`);
  }
  const rollBuckets = park.rolls.concat(park.plusRolls).slice().sort((a, b) => a.width - b.width).map((r) => r.bucket);
  const order = withPlus.slice();
  for (const r of rollBuckets) if (!order.includes(r)) order.push(r);
  const mult = Object.keys(park.multiple);
  const nc = [];
  for (const s of park.sheets) nc.push(`НС ${s.bucket}`);
  for (const r of rollBuckets) if (!nc.includes(`НС ${r}`)) nc.push(`НС ${r}`);
  return order.concat(mult, nc, [REVIEW_BUCKET]);
}

function sortBuckets(names) {
  const order = bucketOrder();
  const rank = (n) => { const i = order.indexOf(n); return i < 0 ? order.length : i; };
  return names.slice().sort((a, b) => rank(a) - rank(b) || a.localeCompare(b, 'ru'));
}

/** Сводка по корзинам и расход рулонов в погонных метрах (без полей и отходов). */
function summarize(records) {
  const buckets = new Map();
  const rolls = {};
  for (const r of records) {
    const b = buckets.get(r.bucket) || { bucket: r.bucket, count: 0, carrier: r.carrier, rollWidth: r.rollWidth, cutMm: 0, formats: {} };
    b.count += 1;
    b.cutMm += r.rollWidth ? r.cut : 0;
    b.formats[r.format === '-' ? 'НС' : r.format] = (b.formats[r.format === '-' ? 'НС' : r.format] || 0) + 1;
    buckets.set(r.bucket, b);
    if (r.rollWidth) rolls[r.rollWidth] = (rolls[r.rollWidth] || 0) + r.cut;
  }
  const list = sortBuckets([...buckets.keys()]).map((name) => {
    const b = buckets.get(name);
    return { ...b, meters: Math.round(b.cutMm / 100) / 10 };
  });
  const rollMeters = Object.keys(rolls).map(Number).sort((a, b) => a - b)
    .map((w) => ({ width: w, meters: Math.round(rolls[w] / 100) / 10 }));
  return { pages: records.length, buckets: list, rollMeters };
}

const CSV_HEAD = ['Исходный файл', 'Стр.', 'Ширина, мм', 'Высота, мм', 'Короткая', 'Длинная', 'Rotate', 'Box',
  'Класс', 'Формат', 'Папка', 'Носитель', 'Рулон, мм', 'Отрез, мм', 'Пакет', 'Стр. в пакете', 'Лист', 'Примечание'];

function csvCell(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** CSV: разделитель «;», UTF-8 с BOM — открывается в Excel без диалога кодировок. */
function toCsv(records) {
  const rows = [CSV_HEAD.map(csvCell).join(';')];
  for (const r of records) {
    rows.push([r.source, r.page, r.width, r.height, r.short, r.long, r.rotate, r.box, r.kind, r.format, r.bucket,
      r.carrier, r.rollWidth || '', r.rollWidth ? r.cut : '', r.package || '', r.packagePage || '', r.sheet, r.note]
      .map(csvCell).join(';'));
  }
  return `﻿${rows.join('\r\n')}\r\n`;
}

/** Имя листа по ТЗ 8.2: {файл}__стр{NNN}__{формат}__{ШxВ}мм — возврат к исходнику без открытия. */
function sheetName(stem, page, format, width, height) {
  const label = format && format !== '-' ? format : 'НС';
  return `${stem}__стр${String(page).padStart(3, '0')}__${label}__${Math.round(width)}x${Math.round(height)}мм`;
}

module.exports = {
  PT_TO_MM, REVIEW_BUCKET, park, PARK_FILE,
  defaults, normalizeSettings, rollsFor, pageSizeMm, classify, pickCarrier, matchTable,
  bucketOrder, sortBuckets, summarize, toCsv, sheetName, loadPark,
};
