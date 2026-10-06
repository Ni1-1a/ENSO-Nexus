'use strict';
/**
 * Парк принтеров и расчёт времени печати (А3).
 *
 * Парк хранится на сервере: общий парк офиса — data/print/park-printers.json
 * (правит владелец платформы), личные принтеры — data/print/<человек>/printers.json
 * (каждый свои). localStorage не используется: парк общий на всех устройствах.
 *
 * Расчёт детерминированный. Единица работы — пакет (корзина или пакет тома):
 * носитель, число листов, байты PDF, длины отрезов, копии. Каждый пакет
 * уходит только на совместимый принтер (лист помещается / рулон заряжен или
 * есть на полке), распределение — жадный LPT: самые долгие задания первыми
 * на наименее загруженный совместимый принтер, смена рулона стоит времени.
 * Накладные (прогрев, RIP, отрез) оценочные, поэтому наружу идёт вилка ±,
 * а калибровка по фактическому времени правит коэффициент принтера.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../../config');

const PRESETS_FILE = process.env.PRINT_PRINTERS_PRESETS_FILE || path.join(__dirname, 'printers-presets.json');
const SHEET_RANK = { 'А4': 1, 'А3': 2, 'SRA3': 3 };
const MODES = ['draft', 'normal', 'best'];
const MODE_TITLES = { draft: 'черновой', normal: 'обычный', best: 'наилучший' };
const A1_FEED_MM = 594;      // протяжка на лист А1 поперёк рулона 36″
const A1_AREA_M2 = 0.594 * 0.841;
const ID_RE = /^[a-z0-9][a-z0-9-]{1,60}$/;

/* ---------------- пресеты ---------------- */

function loadPresets(file = PRESETS_FILE) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(raw.presets) || !raw.presets.length) throw new Error('printers-presets.json: нужен список presets');
  for (const p of raw.presets) validatePrinter(p, { preset: true });
  return raw.presets;
}

/** Проверка карточки принтера: что не паспорт — null, но не выдумка. */
function validatePrinter(p, { preset = false } = {}) {
  const fail = (m) => { throw new Error(`Принтер «${(p && p.name) || (p && p.id) || '?'}»: ${m}`); };
  if (!p || typeof p !== 'object') fail('нет карточки');
  if (!ID_RE.test(String(p.id || ''))) fail('id — латиница, цифры и дефис, 2…61 знака');
  if (typeof p.name !== 'string' || !p.name.trim() || p.name.length > 120) fail('нужно имя до 120 знаков');
  if (!['sheet', 'roll'].includes(p.type)) fail('type — sheet или roll');
  const nonneg = (v, name) => { if (v !== null && v !== undefined && !(Number.isFinite(v) && v >= 0)) fail(`${name} — число ≥ 0 или null`); };
  if (p.type === 'sheet') {
    if (!p.sheet || !SHEET_RANK[p.sheet.maxSheet]) fail('sheet.maxSheet — А4, А3 или SRA3');
    for (const k of ['ppmA4', 'ppmA3']) {
      const v = p.sheet[k] || {};
      nonneg(v.mono, `sheet.${k}.mono`); nonneg(v.color, `sheet.${k}.color`);
    }
    if (!(p.sheet.ppmA4 && p.sheet.ppmA4.mono > 0) && !(p.sheet.ppmA4 && p.sheet.ppmA4.color > 0)) fail('нужна скорость А4 (стр/мин)');
  } else {
    const r = p.roll || {};
    if (![1, 2].includes(r.holders)) fail('roll.holders — 1 или 2');
    if (!(Number.isFinite(r.maxWidthMm) && r.maxWidthMm >= 200 && r.maxWidthMm <= 2000)) fail('roll.maxWidthMm — 200…2000');
    if (!Array.isArray(r.loaded) || r.loaded.length > r.holders) fail('roll.loaded — список заряженных ширин, не больше держателей');
    for (const w of r.loaded.concat(r.stock || [])) if (!(Number.isFinite(w) && w > 0 && w <= r.maxWidthMm)) fail(`ширина рулона ${w} вне 0…${r.maxWidthMm}`);
    if (!r.modes || typeof r.modes !== 'object') fail('roll.modes — объект режимов');
    let any = false;
    for (const m of MODES) {
      const v = r.modes[m];
      if (v === null || v === undefined) continue;
      nonneg(v.secPerA1, `${m}.secPerA1`); nonneg(v.a1PerHour, `${m}.a1PerHour`); nonneg(v.m2PerHour, `${m}.m2PerHour`);
      if (feedSpeed(v) > 0) any = true;
    }
    if (!any) fail('нужна хотя бы одна паспортная скорость рулонного режима');
    if (r.defaultMode && !MODES.includes(r.defaultMode)) fail('roll.defaultMode — draft, normal или best');
  }
  const o = p.overhead || {};
  for (const k of ['warmupSec', 'firstPageSec', 'ripSecPerMb', 'ripSecPerSheet', 'cutSec', 'rollChangeSec']) nonneg(o[k], `overhead.${k}`);
  if (p.uncertaintyPct !== undefined && !(Number.isFinite(p.uncertaintyPct) && p.uncertaintyPct >= 0 && p.uncertaintyPct <= 90)) fail('uncertaintyPct — 0…90');
  if (p.factor !== undefined && !(Number.isFinite(p.factor) && p.factor >= 0.2 && p.factor <= 5)) fail('factor — 0,2…5');
  if (preset && (!p.source || typeof p.source.url !== 'string' || !p.source.url || typeof p.source.note !== 'string')) fail('у пресета обязательны source.url и source.note');
  return true;
}

const presets = loadPresets(PRESETS_FILE);

/** Скорость протяжки, мм/с, из любой паспортной записи режима. */
function feedSpeed(mode, rollWidthMm = 914) {
  if (!mode) return 0;
  if (mode.secPerA1 > 0) return A1_FEED_MM / mode.secPerA1;
  if (mode.a1PerHour > 0) return A1_FEED_MM * mode.a1PerHour / 3600;
  if (mode.m2PerHour > 0) return (mode.m2PerHour / 3600) / (rollWidthMm / 1000) * 1000;
  return 0;
}

/* ---------------- хранилище ---------------- */

const officeFile = () => path.join(config.dataDir, 'print', 'park-printers.json');
const userKey = (user) => String(user.id).replace(/[^\w.-]/g, '_');
const personalFile = (user) => path.join(config.dataDir, 'print', userKey(user), 'printers.json');

function readList(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(raw.printers) ? raw.printers : [];
  } catch { return []; }
}

function writeList(file, printers, who) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ printers, updatedAt: new Date().toISOString(), updatedBy: who || '' }, null, 2));
  fs.renameSync(tmp, file);
}

const isOwner = (user) => !!(user && user.owner === true);
const whoIs = (user) => [user.lastName, user.firstName].filter(Boolean).join(' ') || String(user.id);

/** Парк человека: общий парк офиса + его личные принтеры. */
function listFor(user) {
  const office = readList(officeFile()).map((p) => ({ ...p, scope: 'office' }));
  const personal = readList(personalFile(user)).map((p) => ({ ...p, scope: 'personal' }));
  return office.concat(personal);
}

/** Пустой парк офиса заполняется пресетами при первом обращении — чтобы было с чего начать. */
function ensureOfficeDefaults() {
  const file = officeFile();
  if (fs.existsSync(file)) return;
  const printers = presets.map((p) => fromPreset(p.id));
  writeList(file, printers, 'пресеты');
}

function fromPreset(presetId) {
  const p = presets.find((x) => x.id === presetId);
  if (!p) throw httpError(404, 'Пресет не найден');
  const copy = JSON.parse(JSON.stringify(p));
  return { ...copy, presetId: p.id, factor: 1, history: [], enabled: true };
}

/** Новый принтер в парк: scope office — только владелец, personal — свой. */
function add(user, body) {
  const scope = body && body.scope === 'office' ? 'office' : 'personal';
  if (scope === 'office' && !isOwner(user)) throw httpError(403, 'Общий парк офиса правит владелец платформы; добавьте принтер в личный парк');
  let printer;
  if (body && body.presetId) {
    printer = fromPreset(body.presetId);
    printer.id = `${printer.id}-${crypto.randomBytes(2).toString('hex')}`;
    if (body.name) printer.name = String(body.name).slice(0, 120);
  } else {
    printer = sanitize(body);
    printer.id = printer.id || `p-${crypto.randomBytes(4).toString('hex')}`;
  }
  validatePrinter(printer);
  const file = scope === 'office' ? officeFile() : personalFile(user);
  const list = readList(file);
  if (list.some((p) => p.id === printer.id) || listFor(user).some((p) => p.id === printer.id)) throw httpError(409, `Принтер с id «${printer.id}» уже есть`);
  list.push(printer);
  writeList(file, list, whoIs(user));
  return { ...printer, scope };
}

/** Поля карточки из запроса — только известные, без служебных. */
function sanitize(body) {
  const b = body && typeof body === 'object' ? body : {};
  const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
  const out = {
    id: b.id ? String(b.id).toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 61) : '',
    name: String(b.name || '').trim().slice(0, 120), type: b.type,
    overhead: Object.fromEntries(['warmupSec', 'firstPageSec', 'ripSecPerMb', 'ripSecPerSheet', 'cutSec', 'rollChangeSec'].map((k) => [k, num((b.overhead || {})[k]) ?? 0])),
    uncertaintyPct: num(b.uncertaintyPct) ?? 25, factor: num(b.factor) ?? 1, history: Array.isArray(b.history) ? b.history.slice(-50) : [],
    enabled: b.enabled !== false, presetId: b.presetId || '', source: b.source && typeof b.source === 'object' ? { url: String(b.source.url || ''), note: String(b.source.note || '') } : { url: '', note: '' },
  };
  if (b.type === 'sheet') {
    const s = b.sheet || {};
    out.sheet = {
      maxSheet: s.maxSheet, duplex: !!s.duplex, color: !!s.color,
      ppmA4: { mono: num((s.ppmA4 || {}).mono), color: num((s.ppmA4 || {}).color) },
      ppmA3: { mono: num((s.ppmA3 || {}).mono), color: num((s.ppmA3 || {}).color) },
      ipmDuplexA4: num(s.ipmDuplexA4),
    };
  } else if (b.type === 'roll') {
    const r = b.roll || {};
    const modes = {};
    for (const m of MODES) {
      const v = r.modes && r.modes[m];
      modes[m] = v && typeof v === 'object' ? { secPerA1: num(v.secPerA1), a1PerHour: num(v.a1PerHour), m2PerHour: num(v.m2PerHour) } : null;
      if (modes[m] && feedSpeed(modes[m]) <= 0) modes[m] = null;
    }
    out.roll = {
      holders: Number(r.holders) === 2 ? 2 : 1, maxWidthMm: num(r.maxWidthMm),
      loaded: (Array.isArray(r.loaded) ? r.loaded : []).map(Number).filter(Number.isFinite),
      stock: (Array.isArray(r.stock) ? r.stock : []).map(Number).filter(Number.isFinite),
      modes, defaultMode: MODES.includes(r.defaultMode) ? r.defaultMode : undefined,
    };
  }
  return out;
}

function update(user, id, body) {
  const found = locate(user, id);
  if (!found) throw httpError(404, 'Принтер не найден');
  if (found.scope === 'office' && !isOwner(user)) throw httpError(403, 'Общий парк офиса правит владелец платформы');
  const next = sanitize({ ...found.printer, ...body, id: found.printer.id, history: found.printer.history, presetId: found.printer.presetId, source: body.source || found.printer.source });
  next.factor = Number.isFinite(Number(body.factor)) ? Number(body.factor) : found.printer.factor;
  validatePrinter(next);
  found.list[found.index] = next;
  writeList(found.file, found.list, whoIs(user));
  return { ...next, scope: found.scope };
}

function remove(user, id) {
  const found = locate(user, id);
  if (!found) throw httpError(404, 'Принтер не найден');
  if (found.scope === 'office' && !isOwner(user)) throw httpError(403, 'Общий парк офиса правит владелец платформы');
  found.list.splice(found.index, 1);
  writeList(found.file, found.list, whoIs(user));
}

function locate(user, id) {
  for (const [scope, file] of [['office', officeFile()], ['personal', personalFile(user)]]) {
    const list = readList(file);
    const index = list.findIndex((p) => p.id === id);
    if (index >= 0) return { scope, file, list, index, printer: list[index] };
  }
  return null;
}

/**
 * Калибровка: оператор вводит фактическое время — коэффициент принтера
 * пересчитывается скользящим средним (α = 0,3) по отношению факт/оценка.
 * История хранится (последние 50), чтобы было видно, откуда взялся коэффициент.
 */
function calibrate(user, id, { estimatedSec, actualSec, note = '' }) {
  const est = Number(estimatedSec), act = Number(actualSec);
  if (!(est > 0) || !(act > 0)) throw httpError(400, 'Нужны оценочное и фактическое время в секундах, больше нуля');
  const found = locate(user, id);
  if (!found) throw httpError(404, 'Принтер не найден');
  if (found.scope === 'office' && !isOwner(user)) throw httpError(403, 'Калибровку общего парка вносит владелец платформы');
  const p = found.printer;
  const ratio = act / est;
  const prev = Number.isFinite(p.factor) ? p.factor : 1;
  // оценка уже умножена на prev: отношение относится к «сырой» модели
  const rawRatio = ratio * prev;
  const alpha = 0.3;
  const next = Math.min(5, Math.max(0.2, (p.history || []).length ? prev * (1 - alpha) + rawRatio * alpha : rawRatio));
  p.history = (p.history || []).concat([{ at: new Date().toISOString(), by: whoIs(user), estimatedSec: est, actualSec: act, ratio: Math.round(ratio * 1000) / 1000, factorBefore: prev, factorAfter: Math.round(next * 1000) / 1000, note: String(note || '').slice(0, 200) }]).slice(-50);
  p.factor = Math.round(next * 1000) / 1000;
  found.list[found.index] = p;
  writeList(found.file, found.list, whoIs(user));
  return { ...p, scope: found.scope };
}

/* ---------------- расчёт ---------------- */

/** Совместимость: лист помещается в принтер; рулон нужной ширины заряжен или есть на полке. */
function compatible(printer, unit) {
  if (printer.enabled === false) return { ok: false, why: 'выключен' };
  if (unit.carrierKind === 'sheet') {
    if (printer.type !== 'sheet') return { ok: false, why: 'листовой пакет — только листовой принтер' };
    if ((SHEET_RANK[unit.carrierBucket] || 99) > SHEET_RANK[printer.sheet.maxSheet]) return { ok: false, why: `лист ${unit.carrierBucket} больше ${printer.sheet.maxSheet}` };
    const ppm = ppmFor(printer, unit);
    if (!(ppm > 0)) return { ok: false, why: `нет паспортной скорости для ${unit.carrierBucket}${unit.color ? ' в цвете' : ''}` };
    return { ok: true, change: false };
  }
  if (unit.carrierKind === 'roll') {
    if (printer.type !== 'roll') return { ok: false, why: 'рулонный пакет — только плоттер' };
    const w = unit.rollWidth;
    if (w > printer.roll.maxWidthMm) return { ok: false, why: `рулон ${w} шире ${printer.roll.maxWidthMm}` };
    if ((printer.roll.loaded || []).includes(w)) return { ok: true, change: false };
    if ((printer.roll.stock || []).includes(w)) return { ok: true, change: true };
    return { ok: false, why: `рулон ${w} мм не заряжен и его нет на полке` };
  }
  return { ok: false, why: 'носитель не определён' };
}

function ppmFor(printer, unit) {
  const s = printer.sheet;
  const row = unit.carrierBucket === 'А4' ? s.ppmA4 : s.ppmA3;
  const v = unit.color ? (row && row.color) : (row && row.mono);
  if (v > 0) return v;
  // А4 на принтере с паспортной скоростью только для А3 не бывает; обратное — да: А3 печатают на А3-принтере с его скоростью
  return 0;
}

function modeFor(printer, wanted) {
  const r = printer.roll;
  const order = [wanted, r.defaultMode, 'normal', 'draft', 'best'].filter(Boolean);
  for (const m of order) if (r.modes[m] && feedSpeed(r.modes[m]) > 0) return { mode: m, substituted: m !== wanted };
  return { mode: null, substituted: true };
}

/**
 * Длительность пакета на принтере (секунды, «сырая» модель × коэффициент).
 * Листовой: листы × копии × 60/стр·мин + первая страница + RIP.
 * Рулонный: Σ отрезов × копии / протяжка + отрез на лист + первая + RIP.
 */
function duration(printer, unit, opts = {}) {
  const o = printer.overhead || {};
  const copies = Math.max(1, unit.copies || 1);
  const mb = (unit.bytes || 0) / 1048576;
  const parts = { print: 0, rip: (o.ripSecPerMb || 0) * mb + (o.ripSecPerSheet || 0) * unit.pages * copies, first: o.firstPageSec || 0, cut: 0, mode: null };
  if (unit.carrierKind === 'sheet') {
    let ppm = ppmFor(printer, unit);
    let pages = unit.pages * copies;
    if (opts.duplex && printer.sheet.duplex && printer.sheet.ipmDuplexA4 > 0 && unit.carrierBucket === 'А4') { ppm = printer.sheet.ipmDuplexA4; }
    parts.print = pages * 60 / ppm;
  } else {
    const { mode } = modeFor(printer, opts.mode);
    parts.mode = mode;
    const v = feedSpeed(printer.roll.modes[mode], unit.rollWidth);
    const feedMm = (unit.cuts || []).reduce((s, c) => s + c, 0) * copies;
    parts.print = feedMm / v;
    parts.cut = (o.cutSec || 0) * unit.pages * copies;
  }
  const raw = parts.print + parts.rip + parts.first + parts.cut;
  const factor = Number.isFinite(printer.factor) ? printer.factor : 1;
  return { sec: raw * factor, raw, factor, parts };
}

/**
 * Распределение по принтерам: LPT. Возвращает очереди, makespan, суммарное
 * машинное время и вилку ±.
 */
function schedule(units, printers, opts = {}) {
  const live = printers.filter((p) => p.enabled !== false);
  const state = new Map(live.map((p) => [p.id, { printer: p, load: 0, roll: (p.roll && p.roll.loaded ? p.roll.loaded.slice() : []), queue: [], warmed: false, changes: 0 }]));
  const skipped = [];
  // самые долгие первыми: длительность — наименьшая среди совместимых принтеров
  const ranked = units.map((u) => {
    const cands = live.map((p) => ({ p, c: compatible(p, u) })).filter((x) => x.c.ok).map((x) => ({ ...x, d: duration(x.p, u, opts) }));
    return { u, cands, min: cands.length ? Math.min(...cands.map((x) => x.d.sec)) : Infinity };
  }).sort((a, b) => b.min - a.min);
  for (const item of ranked) {
    if (!item.cands.length) {
      const why = live.map((p) => `${p.name}: ${compatible(p, item.u).why}`).join('; ');
      skipped.push({ unit: item.u.id, label: item.u.label, why: why || 'в парке нет принтеров' });
      continue;
    }
    let best = null;
    for (const cand of item.cands) {
      const st = state.get(cand.p.id);
      const o = cand.p.overhead || {};
      const warm = st.warmed ? 0 : (o.warmupSec || 0);
      let change = 0;
      if (item.u.carrierKind === 'roll' && !st.roll.includes(item.u.rollWidth)) change = o.rollChangeSec || 0;
      const finish = st.load + warm + change + cand.d.sec;
      if (!best || finish < best.finish) best = { cand, st, warm, change, finish };
    }
    const { cand, st, warm, change, finish } = best;
    if (item.u.carrierKind === 'roll' && change) {
      // двухрулонный держит второй рулон, однорулонный меняет единственный
      if (st.roll.length < (cand.p.roll.holders || 1)) st.roll.push(item.u.rollWidth);
      else st.roll[st.roll.length - 1] = item.u.rollWidth;
      st.changes += 1;
    }
    st.queue.push({
      unit: item.u.id, label: item.u.label, pages: item.u.pages, copies: item.u.copies || 1,
      start: Math.round(st.load), end: Math.round(finish), sec: Math.round(cand.d.sec), warmupSec: warm, rollChangeSec: change,
      mode: cand.d.parts.mode, parts: Object.fromEntries(Object.entries(cand.d.parts).filter(([k]) => k !== 'mode').map(([k, v]) => [k, Math.round(v)])),
      factor: cand.d.factor,
    });
    st.load = finish;
    st.warmed = true;
  }
  const queues = [...state.values()].map((st) => {
    const u = Number.isFinite(st.printer.uncertaintyPct) ? st.printer.uncertaintyPct / 100 : 0.25;
    return {
      printer: { id: st.printer.id, name: st.printer.name, type: st.printer.type, scope: st.printer.scope || '', factor: st.printer.factor || 1, uncertaintyPct: Math.round(u * 100) },
      totalSec: Math.round(st.load), lowSec: Math.round(st.load * (1 - u)), highSec: Math.round(st.load * (1 + u)),
      rollChanges: st.changes, queue: st.queue,
    };
  });
  const makespan = Math.max(0, ...queues.map((q) => q.totalSec));
  const low = Math.max(0, ...queues.map((q) => q.lowSec));
  const high = Math.max(0, ...queues.map((q) => q.highSec));
  const machine = queues.reduce((s, q) => s + q.totalSec, 0);
  return { makespanSec: makespan, lowSec: low, highSec: high, machineSec: machine, queues, skipped, mode: opts.mode || 'normal', duplex: !!opts.duplex };
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

module.exports = {
  presets, loadPresets, validatePrinter, feedSpeed, MODES, MODE_TITLES, SHEET_RANK,
  listFor, ensureOfficeDefaults, fromPreset, add, update, remove, calibrate,
  compatible, duration, schedule,
};
