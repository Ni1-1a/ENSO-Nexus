'use strict';
/**
 * Переплёт тома (А6): листы тома → слои с учётом сложенных листов (fold.js) →
 * толщина блока → диаметр пружины по таблице поставщика → закупка с копиями и
 * запасом. Детерминированно, моделей нет.
 *
 * Две толщины у одного блока (Б2): наибольшая (на внешней кромке, где лежат
 * все панели сложенного листа) и в зоне подшивки (один слой на лист по ГОСТ).
 * Пружина выбирается по НАИБОЛЬШЕЙ — иначе блок не закроется; разница —
 * клин, его компенсируют вкладыши в корешок (если включены).
 */
const fs = require('fs');
const path = require('path');
const fold = require('./fold');

const FILE = process.env.PRINT_CONSUMABLES_FILE || path.join(__dirname, 'consumables.json');
const BINDINGS = ['plastic', 'wire31', 'wire21', 'thermo', 'folder'];
const BINDING_TITLES = { plastic: 'пластиковая пружина', wire31: 'металлическая пружина 3:1', wire21: 'металлическая пружина 2:1', thermo: 'термопереплёт', folder: 'без переплёта (папка)' };

/** consumables.json проверяется при загрузке, как park.json: кривой конфиг роняет сервер сразу. */
function loadConsumables(file = FILE) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const num = (v, name) => { if (!Number.isFinite(v) || v <= 0) throw new Error(`consumables.json: «${name}» должно быть положительным числом`); return v; };
  num(raw.paper && raw.paper.gsm, 'paper.gsm');
  num(raw.paper && raw.paper.mmPerGsm, 'paper.mmPerGsm');
  num(raw.cover && raw.cover.thicknessMm, 'cover.thicknessMm');
  num(raw.backing && raw.backing.thicknessMm, 'backing.thicknessMm');
  num(raw.insert && raw.insert.thicknessMm, 'insert.thicknessMm');
  if (!Number.isFinite(raw.reservePct) || raw.reservePct < 0) throw new Error('consumables.json: reservePct — число ≥ 0');
  if (!raw.springs || typeof raw.springs !== 'object') throw new Error('consumables.json: нет таблиц пружин');
  for (const [key, sp] of Object.entries(raw.springs)) {
    if (!Array.isArray(sp.table) || !sp.table.length) throw new Error(`consumables.json: у пружины «${key}» пустая таблица`);
    let prev = 0;
    for (const row of sp.table) {
      num(row.diameterMm, `${key}.diameterMm`); num(row.sheets, `${key}.sheets`);
      if (row.sheets < prev) throw new Error(`consumables.json: таблица «${key}» должна идти по возрастанию листов`);
      prev = row.sheets;
    }
    if (typeof sp.source !== 'string') throw new Error(`consumables.json: у пружины «${key}» нет source`);
  }
  if (!raw.fold || !raw.fold.presets || !raw.fold.presets[raw.fold.default]) throw new Error('consumables.json: fold.default должен указывать на существующий пресет');
  return raw;
}

const consumables = loadConsumables(FILE);

/* ---------------- настройки переплёта ---------------- */

function defaults() {
  return {
    copies: 1, binding: 'plastic', gsm: consumables.paper.gsm,
    coverMm: consumables.cover.thicknessMm, backingMm: consumables.backing.thicknessMm,
    inserts: consumables.insert.enabled, insertMm: consumables.insert.thicknessMm,
    reservePct: consumables.reservePct, foldPreset: consumables.fold.default, foldTable: {},
    perTome: {},   // { 'f1a2b3c4': copies } — поправка числа экземпляров по тому
  };
}

function normalize(raw) {
  const st = defaults();
  const src = raw && typeof raw === 'object' ? raw : {};
  const numIn = (v, lo, hi, name) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < lo || n > hi) throw new Error(`${name}: число от ${lo} до ${hi}`);
    return n;
  };
  if (src.copies !== undefined && src.copies !== '') st.copies = Math.round(numIn(src.copies, 0, 999, 'Число экземпляров'));
  if (src.binding !== undefined && src.binding !== '') {
    if (!BINDINGS.includes(src.binding)) throw new Error('Тип переплёта: plastic, wire31, wire21, thermo или folder');
    st.binding = src.binding;
  }
  if (src.gsm !== undefined && src.gsm !== '') st.gsm = numIn(src.gsm, 40, 400, 'Плотность бумаги, г/м²');
  if (src.coverMm !== undefined && src.coverMm !== '') st.coverMm = numIn(src.coverMm, 0, 2, 'Толщина обложки, мм');
  if (src.backingMm !== undefined && src.backingMm !== '') st.backingMm = numIn(src.backingMm, 0, 3, 'Толщина подложки, мм');
  if (src.insertMm !== undefined && src.insertMm !== '') st.insertMm = numIn(src.insertMm, 0.05, 3, 'Толщина вкладыша, мм');
  if (src.inserts !== undefined) st.inserts = src.inserts === true || src.inserts === 'true' || src.inserts === 1 || src.inserts === '1';
  if (src.reservePct !== undefined && src.reservePct !== '') st.reservePct = numIn(src.reservePct, 0, 100, 'Запас, %');
  if (src.foldPreset !== undefined && src.foldPreset !== '') {
    if (!consumables.fold.presets[src.foldPreset] && src.foldPreset !== 'custom') throw new Error('Пресет складывания: gost, owner, estimate или custom');
    st.foldPreset = src.foldPreset;
  }
  if (src.foldTable && typeof src.foldTable === 'object') {
    for (const [k, v] of Object.entries(src.foldTable)) {
      const n = Number(v);
      if (!/^[А-ЯA-Z]\d$/i.test(k) || !Number.isFinite(n) || n < 1 || n > 200) throw new Error(`Таблица слоёв: «${k}» = ${v} — формат и число 1…200`);
      st.foldTable[k] = Math.round(n);
    }
  }
  if (src.perTome && typeof src.perTome === 'object') {
    for (const [k, v] of Object.entries(src.perTome)) {
      if (!/^f[a-f0-9]{8}$/.test(k)) continue;
      st.perTome[k] = Math.round(numIn(v, 0, 999, `Экземпляров тома ${k}`));
    }
  }
  return st;
}

/** Таблица слоёв действующего пресета: ГОСТ считается, остальные — из конфига плюс правки. */
function foldTableFor(st) {
  const preset = consumables.fold.presets[st.foldPreset];
  return { ...((preset && preset.table) || {}), ...(st.foldTable || {}) };
}

/* ---------------- расчёт ---------------- */

/** Слои одного листа: наибольшее и в зоне подшивки. */
function sheetLayers(rec, st) {
  const table = foldTableFor(st);
  const preset = st.foldPreset === 'gost' ? 'gost' : (st.foldPreset === 'estimate' ? 'estimate' : 'custom');
  return fold.layersBy(preset, rec.short, rec.long, { table, format: rec.kind === 'ГОСТ' ? rec.format : '' });
}

/** Пружина по толщине блока: первая строка таблицы, которая вмещает; null — блок толще самой большой. */
function pickSpring(kind, blockMm, sheetMm) {
  const sp = consumables.springs[kind];
  if (!sp) return { spring: null, max: null, table: null };
  const sheetsEq = blockMm / sheetMm;
  const row = sp.table.find((r) => (Number.isFinite(r.blockMm) ? blockMm <= r.blockMm : sheetsEq <= r.sheets));
  const last = sp.table[sp.table.length - 1];
  return { spring: row || null, max: last, table: sp, sheetsEq: Math.round(sheetsEq) };
}

/**
 * Переплёт одного тома. records — листы тома (записи разбора); st — настройки.
 */
function tomeBinding(tome, records, st) {
  const sheetMm = st.gsm * consumables.paper.mmPerGsm;
  let layersMax = 0;
  let layersSpine = 0;
  const byFormat = {};
  for (const r of records) {
    if (r.kind === 'ОШИБКА') continue;
    const L = sheetLayers(r, st);
    layersMax += L.max;
    layersSpine += L.binding;
    const key = r.kind === 'ГОСТ' ? r.format : `НС ${Math.round(r.short)}×${Math.round(r.long)}`;
    byFormat[key] = byFormat[key] || { count: 0, layers: 0, perSheet: L.max, binding: L.binding };
    byFormat[key].count += 1; byFormat[key].layers += L.max;
  }
  const copies = Number.isFinite(st.perTome[tome.fileId]) ? st.perTome[tome.fileId] : st.copies;
  const thicknessMax = layersMax * sheetMm;
  const thicknessSpine = layersSpine * sheetMm;
  const wedgeMm = Math.max(0, thicknessMax - thicknessSpine);
  const insertsPerBook = st.inserts ? Math.ceil(wedgeMm / st.insertMm) : 0;
  const extras = st.coverMm + st.backingMm;
  const blockMm = thicknessMax + extras;
  const r1 = (n) => Math.round(n * 10) / 10;
  const out = {
    tome: { fileId: tome.fileId, title: tome.title, name: tome.name },
    sheets: records.length, copies, byFormat,
    layersMax, layersSpine, sheetMm: Math.round(sheetMm * 1000) / 1000,
    thicknessMaxMm: r1(thicknessMax), thicknessSpineMm: r1(thicknessSpine), wedgeMm: r1(wedgeMm),
    blockMm: r1(blockMm), insertsPerBook, books: 1, spring: null, springKind: st.binding, springTitle: BINDING_TITLES[st.binding],
    note: '',
  };
  if (st.binding === 'folder') { out.note = 'без переплёта — пружина и обложка не нужны'; return out; }
  const pick = pickSpring(st.binding, blockMm, sheetMm);
  if (!pick.table) return out;
  if (pick.spring) {
    out.spring = { diameterMm: pick.spring.diameterMm, inch: pick.spring.inch || '', sheets: pick.spring.sheets, blockMm: pick.spring.blockMm || null };
  } else {
    // блок толще самой большой пружины — делим том на книги поровну
    const maxBlock = Number.isFinite(pick.max.blockMm) ? pick.max.blockMm : pick.max.sheets * sheetMm;
    const books = Math.max(2, Math.ceil(thicknessMax / Math.max(0.1, maxBlock - extras)));
    const perBook = thicknessMax / books + extras;
    const p2 = pickSpring(st.binding, perBook, sheetMm);
    out.books = books;
    out.spring = p2.spring ? { diameterMm: p2.spring.diameterMm, inch: p2.spring.inch || '', sheets: p2.spring.sheets, blockMm: p2.spring.blockMm || null } : null;
    out.blockPerBookMm = r1(perBook);
    out.note = `блок ${r1(blockMm)} мм толще самой большой пружины (${pick.max.diameterMm} мм) — предлагается разделить том на ${books} книги по ≈${r1(perBook)} мм`;
  }
  if (pick.table.verify) out.verify = pick.table.verify;
  return out;
}

/** Закупка по всем томам: пружины по диаметру, обложки, подложки, вкладыши — с копиями и запасом. */
function purchase(tomes, st) {
  const k = 1 + st.reservePct / 100;
  const springs = {};
  let covers = 0, backings = 0, inserts = 0, books = 0;
  for (const t of tomes) {
    if (!t.copies) continue;
    const n = t.books * t.copies;
    if (st.binding !== 'folder') {
      books += n; covers += n; backings += n; inserts += t.insertsPerBook * n;
      if (t.spring) {
        const key = `${t.spring.diameterMm}`;
        springs[key] = springs[key] || { diameterMm: t.spring.diameterMm, inch: t.spring.inch, count: 0 };
        springs[key].count += n;
      }
    }
  }
  const up = (n) => Math.ceil(n * k - 1e-9);
  return {
    reservePct: st.reservePct, binding: st.binding, bindingTitle: BINDING_TITLES[st.binding],
    books,
    springs: Object.values(springs).sort((a, b) => a.diameterMm - b.diameterMm).map((s) => ({ ...s, withReserve: up(s.count) })),
    covers: { count: covers, withReserve: up(covers) },
    backings: { count: backings, withReserve: up(backings) },
    inserts: st.inserts ? { count: inserts, withReserve: up(inserts), thicknessMm: st.insertMm } : null,
  };
}

/** Сравнительная таблица коэффициентов для отчёта (Б2). */
function foldComparison(basic) {
  const ownerTable = consumables.fold.presets.owner.table;
  return fold.compareTable(basic, ownerTable);
}

module.exports = {
  consumables, loadConsumables, BINDINGS, BINDING_TITLES,
  defaults, normalize, foldTableFor, sheetLayers, pickSpring, tomeBinding, purchase, foldComparison,
};
