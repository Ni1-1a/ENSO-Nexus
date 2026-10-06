'use strict';
/**
 * Модель сложенного листа (Б2): сколько слоёв бумаги даёт лист W×H, сложенный
 * до А4 для брошюрования в том.
 *
 * Схема — ГОСТ 2.501-2013, приложение Г, таблица Г.2 «Складывание для
 * непосредственного брошюрования» (проверено по рисункам приложения,
 * ru.wikisource.org/wiki/ГОСТ_2.501—2013; та же схема в ГОСТ 2.501-88,
 * приложение 1, таблица 2). Правила приложения: Г.1 — сначала сгибы вдоль
 * линий, перпендикулярных основной надписи, потом параллельных; Г.2 — основная
 * надпись остаётся на лицевой стороне.
 *
 * Что на рисунках Г.2 (ширина — сторона вдоль основной надписи):
 *   А0 1189×841: 210 | a/2 | a/2 | 190 | 190 | 190 | 190, a = остаток (219);
 *                строки 297 | 297 | остаток; угол срезан сгибом 105 (линия 2)
 *   А1 841×594:  210 | a/2 | a/2 | 190 | 190, a = 251; строки 297 | 297
 *   А1 594×841:  210 | a/2 | a/2, a = 384; строки 297 | 297 | 247
 *   А2 594×420:  210 | a/2 | a/2, a = 384; строки 297 | 123
 *   А2 420×594:  105 | 125 | 190; строки 297 | 297
 *   А3 420×297:  105 | 125 | 190 (одна строка)
 *   А3 297×420:  105 | 190; строки 297 | 123
 * Лицевая панель с основной надписью — 190 мм; панель с полем подшивки —
 * 210 мм (у А3/А2-вертикального — 105), поле подшивки 20 мм остаётся в ОДИН
 * слой: только его и прокалывают, иначе лист не развернуть. Уголок верхних
 * строк отгибается по диагонали (линия 2), чтобы поле подшивки нижней строки
 * осталось свободным.
 *
 * Отсюда две разные величины: НАИБОЛЬШЕЕ число слоёв (толщина блока на
 * внешней кромке) и число слоёв В ЗОНЕ ПОДШИВКИ (что прокалывает пружина).
 * Разница даёт клин, который компенсируют вкладыши (binding.js).
 *
 * Чистая геометрия: ни файлов, ни моделей.
 */

const DEFAULTS = Object.freeze({
  front: 190,      // лицевая панель с основной надписью
  back: 210,       // панель с полем подшивки (полная ширина А4)
  margin: 20,      // поле подшивки
  shimMax: 195,    // предел ширины компенсирующих панелей a/2 (ГОСТ допускает 192 у А2)
  rowH: 297,       // высота панели по второй оси
  minRow: 50,      // остаток тоньше — отдельной строкой не складывают
  diagonal: true,  // уголок верхних строк отгибается (линия 2 на схемах ГОСТ)
  tolerance: 3,    // допуск совпадения с А4
});

const A4 = Object.freeze({ short: 210, long: 297 });

function round1(n) { return Math.round(n * 10) / 10; }

/**
 * Разбивка ширины на панели по схеме Г.2. Возвращает панели слева направо с
 * ролями: back (подшивка), shim (a/2), panel (190), front (лицевая).
 */
function columnsFor(W, o) {
  if (W <= o.back + o.tolerance) {
    return { scheme: 'single', cols: [{ w: W, role: 'front' }], shim: 0 };
  }
  // полная схема: 210 | a/2 | a/2 | 190 × k — нужна ширина хотя бы на 210 + 2·190
  if (W >= o.back + 2 * o.front) {
    let k = 0;
    let a = W - o.back;
    while (a / 2 > o.shimMax) { k += 1; a = W - o.back - o.front * k; }
    const cols = [{ w: o.back, role: 'back' }, { w: a / 2, role: 'shim' }, { w: a / 2, role: k ? 'shim' : 'front' }];
    for (let i = 0; i < k; i++) cols.push({ w: o.front, role: i === k - 1 ? 'front' : 'panel' });
    return { scheme: 'gost', cols, shim: a / 2, k };
  }
  // короткая схема (А3, А2 вертикальный): 105 | остаток | 190
  const bind = Math.min(105, W - o.front);
  const middle = W - o.front - bind;
  const cols = [{ w: bind, role: 'bind' }];
  if (middle >= 5) cols.push({ w: middle, role: 'middle' });
  cols.push({ w: o.front, role: 'front' });
  return { scheme: 'short', cols, shim: 0 };
}

/** Строки по второй оси: 297 от основной надписи, остаток сверху. */
function rowsFor(H, o) {
  if (H <= o.rowH + o.tolerance) return [H];
  let n = Math.ceil((H - o.tolerance) / o.rowH);
  let rest = H - o.rowH * (n - 1);
  if (rest < o.minRow && n > 1) { n -= 1; rest = H - o.rowH * (n - 1); }
  const rows = new Array(n - 1).fill(o.rowH);
  rows.push(round1(rest));
  return rows;
}

/**
 * Профиль толщины поперёк сложенного пакета (u от кромки подшивки, мм):
 * отрезки с числом слоёв в одной строке. Умножается на число строк.
 */
function profileFor(colsInfo, o) {
  const { scheme, cols, shim } = colsInfo;
  const W = cols.reduce((s, c) => s + c.w, 0);
  if (scheme === 'single') return [{ from: 0, to: W, layers: 1 }];
  if (scheme === 'gost') {
    const k = cols.filter((c) => c.role === 'panel' || (c.role === 'front' && c.w === o.front)).length;
    const edge = o.back - shim;            // где начинаются панели a/2
    const inner = Math.min(o.margin, edge); // поле подшивки: один слой
    const segs = [{ from: 0, to: inner, layers: 1 }];
    if (edge > inner) segs.push({ from: inner, to: edge, layers: 1 + k });
    segs.push({ from: edge, to: o.back, layers: 1 + k + 2 });
    return segs.filter((s) => s.to > s.from);
  }
  // короткая схема: панель подшивки 105 лежит сзади, остаток и лицевая — впереди
  const bind = cols[0].w;
  const middle = cols.find((c) => c.role === 'middle');
  const packet = o.margin + o.front;
  const segs = [{ from: 0, to: o.margin, layers: 1 }];
  if (middle) {
    const mEnd = o.margin + middle.w;
    segs.push({ from: o.margin, to: Math.min(mEnd, bind), layers: 3 });
    if (bind < mEnd) segs.push({ from: bind, to: mEnd, layers: 2 });
    if (mEnd < packet) segs.push({ from: mEnd, to: packet, layers: bind > mEnd ? 2 : 1 });
  } else {
    segs.push({ from: o.margin, to: Math.min(bind, packet), layers: 2 });
    if (bind < packet) segs.push({ from: bind, to: packet, layers: 1 });
  }
  return segs.filter((s) => s.to > s.from);
}

/**
 * Сложенный лист. short/long — стороны в мм; title: 'long' — основная надпись
 * вдоль длинной стороны (альбом, как на чертежах), 'short' — вдоль короткой
 * (вертикальный лист). По умолчанию альбом: так лежат все большие форматы.
 *
 * @returns {{ width, height, scheme, columns, rows, profile, maxLayers, bindingLayers,
 *            cornerExtra, areaA4, packet }}
 */
function foldSheet(short, long, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const portrait = o.title === 'short';
  const W = portrait ? Math.min(short, long) : Math.max(short, long);
  const H = portrait ? Math.max(short, long) : Math.min(short, long);
  // лист, помещающийся в А4 (А4, А5, Letter), не складывают вовсе
  // допуск шире обычного: Letter 216×279 в том идёт как есть, его не складывают
  const fitTol = Math.max(o.tolerance, 8);
  const fitsA4 = Math.min(short, long) <= A4.short + fitTol && Math.max(short, long) <= A4.long + fitTol;
  const ci = fitsA4 ? { scheme: 'single', cols: [{ w: W, role: 'front' }], shim: 0 } : columnsFor(W, o);
  const rows = fitsA4 ? [H] : rowsFor(H, o);
  const r = rows.length;
  const prof = profileFor(ci, o);
  const colMax = Math.max(...prof.map((s) => s.layers));
  const hasBinding = ci.scheme !== 'single';
  const diagonal = hasBinding && o.diagonal && r > 1;
  // без отгиба уголка поля подшивки всех строк ложатся друг на друга
  const bindingLayers = ci.scheme === 'single' ? r : (diagonal ? 1 : r);
  return {
    width: W, height: H, scheme: ci.scheme,
    columns: ci.cols.map((c) => ({ w: round1(c.w), role: c.role })),
    rows: rows.slice(),
    profile: prof.map((s) => ({ from: round1(s.from), to: round1(s.to), layers: s.layers * r })),
    maxLayers: colMax * r,
    bindingLayers,
    cornerExtra: diagonal ? r - 1 : 0,
    areaA4: round1((short * long) / (A4.short * A4.long)),
    packet: { w: Math.min(W, o.back), h: Math.min(H, o.rowH) },
  };
}

/* ---------------- пресеты коэффициентов ---------------- */

/** Прикидка из задания (панели 210+105…, без загиба): слоёв по ширине × строк. */
function estimateLayers(short, long) {
  const W = Math.max(short, long), H = Math.min(short, long);
  if (Math.min(short, long) <= 213 && W <= 300) return 1;
  // 420 → 3 (210+105+105), 594 → 3 (210+192+192), 841 → 5 (210+4×157,75), 1189 → 7 (210+6×163,2)
  const cols = W <= 213 ? 1 : (W < 800 ? 3 : (W < 1000 ? 5 : 7));
  const rows = H <= 300 ? 1 : Math.ceil((H - 3) / 297);
  return cols * rows;
}

/**
 * Число слоёв по выбранному пресету. presets: 'gost' — модель выше; 'owner' —
 * таблица владельца (А3 3, А2 7, А1 11, А0 23) с запасным ГОСТ для прочих
 * размеров; 'estimate' — прикидка; 'custom' — своя таблица.
 */
function layersBy(preset, short, long, { table = {}, format = '' } = {}) {
  const g = foldSheet(short, long);
  if (preset === 'owner' || preset === 'custom') {
    const t = table[format];
    if (Number.isFinite(t) && t > 0) return { max: t, binding: g.bindingLayers, source: preset };
    return { max: g.maxLayers, binding: g.bindingLayers, source: 'gost' };
  }
  if (preset === 'estimate') return { max: estimateLayers(short, long), binding: g.bindingLayers, source: 'estimate' };
  return { max: g.maxLayers, binding: g.bindingLayers, source: 'gost' };
}

/** Сводная таблица по основным форматам: ГОСТ, прикидка, владелец, по площади. */
function compareTable(formats, ownerTable) {
  return Object.entries(formats).map(([name, [s, l]]) => {
    const g = foldSheet(s, l);
    return {
      format: name, size: `${l}×${s}`,
      columns: g.columns.map((c) => c.w), rows: g.rows.length,
      gost: g.maxLayers, gostBinding: g.bindingLayers, gostCorner: g.cornerExtra,
      estimate: estimateLayers(s, l), owner: ownerTable[name] ?? null, area: g.areaA4,
    };
  });
}

/* ---------------- схема SVG ---------------- */

/**
 * Схема складывания: линии сгиба с порядком, поле подшивки с отверстиями,
 * основная надпись, диагональ уголка. Масштаб подбирается под ширину картинки.
 */
function schemeSvg(short, long, opts = {}) {
  const f = foldSheet(short, long, opts);
  const o = { ...DEFAULTS, ...opts };
  const W = f.width, H = f.height;
  const pxW = opts.pxWidth || 360;
  const k = (pxW - 60) / Math.max(W, 1);
  const pxH = Math.round(H * k + 70);
  const x0 = 30, y0 = 20;
  const X = (mm) => round1(x0 + mm * k);
  const Y = (mm) => round1(y0 + (H - mm) * k);
  const el = [];
  el.push(`<rect x="${X(0)}" y="${Y(H)}" width="${round1(W * k)}" height="${round1(H * k)}" fill="#fffdf7" stroke="#26211b" stroke-width="2"/>`);
  // вертикальные сгибы — от лицевой панели (справа) к полю подшивки
  let n = 0;
  const xs = [];
  let acc = 0;
  for (const c of f.columns) { acc += c.w; xs.push(acc); }
  xs.pop();
  const order = [];
  for (let i = xs.length - 1; i >= 0; i--) order.push(xs[i]);
  for (const x of order) {
    n += 1;
    el.push(`<line x1="${X(x)}" y1="${Y(0)}" x2="${X(x)}" y2="${Y(H)}" stroke="#26211b" stroke-width="1.2" stroke-dasharray="6 4"/>`);
    el.push(`<text x="${X(x) + 3}" y="${Y(H * 0.55)}" font-size="12" fill="#26211b">${n}</text>`);
  }
  // горизонтальные сгибы — от надписи вверх
  let hAcc = 0;
  for (let i = 0; i < f.rows.length - 1; i++) {
    hAcc += f.rows[i];
    n += 1;
    el.push(`<line x1="${X(0)}" y1="${Y(hAcc)}" x2="${X(W)}" y2="${Y(hAcc)}" stroke="#26211b" stroke-width="1.2" stroke-dasharray="6 4"/>`);
    el.push(`<text x="${X(W) - 14}" y="${Y(hAcc) - 4}" font-size="12" fill="#26211b">${n}</text>`);
  }
  // уголок: диагональ от верхней кромки (105) к полю подшивки по линии первой строки
  if (f.cornerExtra > 0) {
    n += 1;
    el.push(`<line x1="${X(105)}" y1="${Y(H)}" x2="${X(0)}" y2="${Y(f.rows[0])}" stroke="#b95740" stroke-width="1.2" stroke-dasharray="4 3"/>`);
    el.push(`<text x="${X(8)}" y="${Y(H) + 14}" font-size="12" fill="#b95740">${n}</text>`);
  }
  if (f.scheme !== 'single') {
    // поле подшивки и отверстия
    el.push(`<rect x="${X(0)}" y="${Y(f.rows[0])}" width="${round1(o.margin * k)}" height="${round1(f.rows[0] * k)}" fill="#b95740" fill-opacity="0.12"/>`);
    for (const yy of [f.rows[0] * 0.3, f.rows[0] * 0.7]) el.push(`<circle cx="${X(12)}" cy="${Y(yy)}" r="3" fill="#26211b"/>`);
  }
  // основная надпись 185×55 в правом нижнем углу
  const tbW = Math.min(185, W - 10), tbH = Math.min(55, H - 10);
  el.push(`<rect x="${X(W - 5 - tbW)}" y="${Y(5 + tbH)}" width="${round1(tbW * k)}" height="${round1(tbH * k)}" fill="none" stroke="#26211b" stroke-width="1.5"/>`);
  // размеры панелей
  acc = 0;
  for (const c of f.columns) {
    el.push(`<text x="${X(acc + c.w / 2)}" y="${Y(0) + 16}" font-size="11" text-anchor="middle" fill="#5a534a">${c.w}</text>`);
    acc += c.w;
  }
  hAcc = 0;
  for (const r of f.rows) {
    el.push(`<text x="${X(W) + 6}" y="${Y(hAcc + r / 2) + 4}" font-size="11" fill="#5a534a">${r}</text>`);
    hAcc += r;
  }
  el.push(`<text x="${x0}" y="${pxH - 8}" font-size="11" fill="#5a534a">${W}×${H} мм · слоёв: до ${f.maxLayers}, в зоне подшивки ${f.bindingLayers} · ГОСТ 2.501-2013, табл. Г.2</text>`);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${pxW + 40} ${pxH}" width="${pxW + 40}" height="${pxH}" font-family="-apple-system, Helvetica, Arial, sans-serif">${el.join('')}</svg>`;
}

module.exports = { DEFAULTS, foldSheet, columnsFor, rowsFor, estimateLayers, layersBy, compareTable, schemeSvg };
