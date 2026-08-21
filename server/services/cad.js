'use strict';
/**
 * Разбор CAD-чертежей (DWG/DXF) для контекста модели.
 *
 * DWG сначала конвертируется в DXF утилитой dwg2dxf (GNU LibreDWG,
 * `brew install libredwg`), DXF разбирается напрямую. Вместо сырого дампа
 * (60 тыс. символов заголовков) модель получает компактную выжимку:
 * габариты и единицы, слои, состав объектов, блоки и все текстовые надписи.
 * Выжимка кэшируется рядом с файлом (<файл>.cad.md).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileP = promisify(execFile);

const DWG2DXF_CANDIDATES = ['/opt/homebrew/bin/dwg2dxf', '/usr/local/bin/dwg2dxf'];

function findConverter() {
  for (const p of DWG2DXF_CANDIDATES) {
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch { /* следующий кандидат */ }
  }
  return 'dwg2dxf'; // надежда на PATH
}

/** DWG → текст DXF. Бросает понятную ошибку, если конвертер не установлен. */
async function convertDwgToDxf(dwgPath) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cad-'));
  try {
    // dwg2dxf капризен к абсолютным путям в -o: работаем в tmp с относительными именами
    fs.copyFileSync(dwgPath, path.join(tmp, 'in.dwg'));
    try {
      await execFileP(findConverter(), ['in.dwg'], {
        cwd: tmp, timeout: 180000, maxBuffer: 16 * 1024 * 1024,
      });
    } catch (err) {
      if (err.code === 'ENOENT') {
        throw new Error('конвертер DWG не установлен — выполните: brew install libredwg');
      }
      // dwg2dxf возвращает ненулевой код и на предупреждениях — важен только результат
      if (!fs.existsSync(path.join(tmp, 'in.dxf'))) {
        throw new Error(`dwg2dxf не смог прочитать файл: ${String(err.stderr || err.message).slice(0, 200)}`);
      }
    }
    const out = path.join(tmp, 'in.dxf');
    if (!fs.existsSync(out)) throw new Error('dwg2dxf завершился без результата');
    return fs.readFileSync(out, 'utf8');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/* ---------------- разбор DXF ---------------- */
// Единицы чертежа — единой таблицей из геометрической модели: два независимых
// списка кодов INSUNITS уже разъезжались (выжимка писала «код 7», а модель
// принимала километры за метры).
const units = require('./geometry/site-geometry');

/** Число сегментов на полную окружность при аппроксимации дуг. */
const ARC_SEGMENTS = 72;
/** Допуск сшивки отрезков в цепочку, в единицах чертежа. */
const STITCH_TOL_DIGITS = 6;

/**
 * Точка вставки надписи: код 10, а при выравнивании не по левому краю — код 11.
 * Нулевая точка 10 у выровненного текста — не «начало координат», а «не задано».
 */
function textAnchor(e) {
  const alt = e.p11 && Number.isFinite(e.p11[0]) ? e.p11 : null;
  const base = e.pts && e.pts[0] && Number.isFinite(e.pts[0][0]) ? e.pts[0] : null;
  if (base && (base[0] !== 0 || base[1] !== 0)) return base;
  if (alt && (alt[0] !== 0 || alt[1] !== 0)) return alt;
  return base || alt || null;
}

/** Снимает базовое MTEXT-форматирование: {\f...;текст}, \P (перевод строки) и т.п. */
function cleanMtext(s) {
  return s
    .replace(/\\P/g, ' ')
    .replace(/\\[fFcChHtTqQwWaA][^;]*;/g, '')
    .replace(/[{}]/g, '')
    .replace(/\\\\/g, '\\')
    .trim();
}

/** Дуга окружности ломаной: центр, радиус, углы в градусах (против часовой). */
function arcPoints(cx, cy, r, startDeg, endDeg) {
  let sweep = endDeg - startDeg;
  while (sweep <= 0) sweep += 360;
  const n = Math.max(2, Math.ceil((Math.abs(sweep) / 360) * ARC_SEGMENTS));
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const a = ((startDeg + (sweep * i) / n) * Math.PI) / 180;
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return pts;
}

/** Окружность замкнутой ломаной. */
function circlePoints(cx, cy, r) {
  const pts = [];
  for (let i = 0; i < ARC_SEGMENTS; i++) {
    const a = (i / ARC_SEGMENTS) * 2 * Math.PI;
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return pts;
}

/**
 * Сшивка отрезков LINE в цепочки по слоям.
 *
 * Граница участка, нарисованная четырьмя отрезками, — обычное дело для выгрузок
 * из геодезического ПО. Пока каждый LINE оставался сам по себе, участок такого
 * чертежа не определялся вовсе. Соединяются только точно совпадающие концы
 * (округление до 1e-6 единицы чертежа): «дотягивать» разрывы догадками нельзя —
 * так рождается контур, которого в чертеже нет.
 */
function stitchSegments(segments) {
  const key = (p) => `${p[0].toFixed(STITCH_TOL_DIGITS)},${p[1].toFixed(STITCH_TOL_DIGITS)}`;
  const byLayer = new Map();
  for (const s of segments) {
    if (!byLayer.has(s.layer)) byLayer.set(s.layer, []);
    byLayer.get(s.layer).push(s);
  }

  const out = [];
  for (const [layer, list] of byLayer) {
    const used = new Array(list.length).fill(false);
    const index = new Map(); // ключ точки → номера отрезков
    list.forEach((s, i) => {
      for (const p of [s.a, s.b]) {
        const k = key(p);
        if (!index.has(k)) index.set(k, []);
        index.get(k).push(i);
      }
    });

    const nextFrom = (k, skip) => {
      const cand = (index.get(k) || []).filter((i) => !used[i] && i !== skip);
      return cand.length === 1 ? cand[0] : -1; // развилка направление не задаёт
    };

    for (let i = 0; i < list.length; i++) {
      if (used[i]) continue;
      used[i] = true;
      const chain = [list[i].a, list[i].b];
      // вперёд
      for (;;) {
        const j = nextFrom(key(chain[chain.length - 1]), -1);
        if (j < 0) break;
        used[j] = true;
        const seg = list[j];
        chain.push(key(seg.a) === key(chain[chain.length - 1]) ? seg.b : seg.a);
      }
      // назад
      for (;;) {
        const j = nextFrom(key(chain[0]), -1);
        if (j < 0) break;
        used[j] = true;
        const seg = list[j];
        chain.unshift(key(seg.b) === key(chain[0]) ? seg.a : seg.b);
      }
      const closed = chain.length > 3 && key(chain[0]) === key(chain[chain.length - 1]);
      out.push({
        layer,
        closed,
        points: closed ? chain.slice(0, -1) : chain,
        source: chain.length > 2 ? 'LINE (сшитая цепочка)' : 'LINE',
      });
    }
  }
  return out;
}

/**
 * Разбор текста DXF: пары (код группы, значение) построчно.
 *
 * Что важно помимо очевидного:
 *  - код группы 67 = 1 означает пространство ЛИСТА. Рамка и штамп — не объекты
 *    местности; попадая в геометрию, они превращались в «существующие объекты»
 *    площадью 250 000 м² и уводили габариты плана на два миллиона метров.
 *    Сущности листа считаются отдельно и в геометрию не идут.
 *  - геометрия — это не только полилинии. LINE, ARC, CIRCLE и SOLID приводятся
 *    к тому же виду {layer, closed, points}, отрезки предварительно сшиваются
 *    в цепочки. Иначе граница участка из четырёх отрезков давала пустую модель.
 *
 * Возвращает { header, layers, entities, paperEntities, texts, inserts,
 *              polylines, blockEntities }.
 */
function parseDxf(text) {
  const lines = text.split(/\r?\n/);
  const header = {};
  const layerTable = [];
  const entities = new Map();      // тип → количество, модельное пространство
  const paperEntities = new Map(); // тип → количество, пространство листа
  const blockEntities = new Map(); // тип → количество внутри определений блоков
  const texts = [];                // {value, layer, at:[x,y]|null} — координата нужна подписям сетки
  const inserts = new Map();       // имя блока → количество
  const polylines = [];            // {layer, closed, points: [[x,y],…], source}
  const segments = [];             // LINE до сшивки

  let section = '';
  let headerVar = '';
  let current = '';            // тип текущей сущности
  let inLayerRecord = false;
  let ent = null;              // накапливаемая сущность секции ENTITIES
  let seqPoly = null;          // старая POLYLINE + VERTEX…SEQEND

  const newEntity = (type) => ({
    type, layer: '', paper: false, closed: false,
    pts: [], pendingX: null, p11: null, x11: null, p12: null, x12: null, p13: null, x13: null,
    radius: null, a50: null, a51: null, textParts: [], name: '',
  });

  /** Завершение сущности: пересчёт в геометрию и учёт в счётчиках. */
  const flushEntity = () => {
    const e = ent;
    ent = null;
    if (!e) return;
    if (e.type !== 'VERTEX' && e.type !== 'SEQEND') {
      (e.paper ? paperEntities : entities).set(e.type, ((e.paper ? paperEntities : entities).get(e.type) || 0) + 1);
    } else {
      entities.set(e.type, (entities.get(e.type) || 0) + 1);
    }

    if (e.type === 'VERTEX') {
      if (seqPoly && e.pts.length) seqPoly.points.push(e.pts[0]);
      return;
    }
    if (e.paper) return; // рамка, штамп, видовые экраны — не геометрия местности

    /*
     * Точка вставки надписи сохраняется вместе с текстом.
     *
     * Без неё подпись «2195850» — просто строка в списке надписей, а с ней это
     * ПОДПИСЬ КРЕСТА координатной сетки: она стоит у своей линии, и по ней
     * чертёж привязывается к системе координат (geometry/grid-crosses.js).
     * Раньше координата отбрасывалась, и порядок осей приходилось угадывать
     * по тому, попадает ли контур в габариты чертежа.
     *
     * Для TEXT точка вставки — код 10; при выравнивании не по левому краю
     * AutoCAD дублирует её в код 11, поэтому берём вторую, если она есть:
     * у выровненного по центру текста код 10 бывает нулевым.
     */
    if (e.type === 'TEXT') {
      // однострочный TEXT не размечен: снимать с него MTEXT-форматирование нельзя,
      // иначе из подписи «{кв. 12}» пропадут скобки
      const v = e.textParts.join('').trim();
      if (v) texts.push({ value: v, layer: e.layer, at: textAnchor(e) });
      return;
    }
    if (e.type === 'MTEXT') {
      const v = cleanMtext(e.textParts.join(''));
      if (v) texts.push({ value: v, layer: e.layer, at: textAnchor(e) });
      return;
    }
    if (e.type === 'INSERT') {
      if (e.name) inserts.set(e.name, (inserts.get(e.name) || 0) + 1);
      return;
    }
    if (e.type === 'LWPOLYLINE') {
      if (e.pts.length >= 2) polylines.push({ layer: e.layer, closed: e.closed, points: e.pts, source: 'LWPOLYLINE' });
      return;
    }
    if (e.type === 'LINE') {
      if (e.pts.length && e.p11) segments.push({ layer: e.layer, a: e.pts[0], b: e.p11 });
      return;
    }
    if (e.type === 'CIRCLE') {
      if (e.pts.length && e.radius > 0) {
        polylines.push({ layer: e.layer, closed: true, points: circlePoints(e.pts[0][0], e.pts[0][1], e.radius), source: 'CIRCLE' });
      }
      return;
    }
    if (e.type === 'ARC') {
      if (e.pts.length && e.radius > 0 && Number.isFinite(e.a50) && Number.isFinite(e.a51)) {
        polylines.push({ layer: e.layer, closed: false, points: arcPoints(e.pts[0][0], e.pts[0][1], e.radius, e.a50, e.a51), source: 'ARC' });
      }
      return;
    }
    if (e.type === 'SOLID' || e.type === 'TRACE') {
      // вершины SOLID идут в порядке 1,2,4,3 — «бабочка», если брать подряд
      const corners = [e.pts[0], e.p11, e.p13, e.p12].filter(Boolean);
      const uniq = [];
      for (const c of corners) {
        if (!uniq.some((u) => u[0] === c[0] && u[1] === c[1])) uniq.push(c);
      }
      if (uniq.length >= 3) polylines.push({ layer: e.layer, closed: true, points: uniq, source: e.type });
    }
  };

  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = lines[i].trim();
    const value = lines[i + 1].trim();

    if (code === '2' && (value === 'HEADER' || value === 'TABLES' || value === 'ENTITIES' ||
        value === 'BLOCKS' || value === 'OBJECTS' || value === 'CLASSES')) {
      // имя секции следует сразу за "0 SECTION"
      if (current === 'SECTION') { section = value; continue; }
    }

    if (code === '9' && section === 'HEADER') { headerVar = value; continue; }
    if (section === 'HEADER' && headerVar) {
      if (code === '10' || code === '20') header[`${headerVar}.${code}`] = parseFloat(value);
      else if (code === '70') header[headerVar] = parseInt(value, 10);
      continue;
    }

    if (code === '0') {
      flushEntity();
      if (value === 'SEQEND' && seqPoly) {
        if (seqPoly.points.length >= 2) polylines.push(seqPoly);
        seqPoly = null;
      }
      current = value;
      inLayerRecord = section === 'TABLES' && value === 'LAYER';
      if (section === 'BLOCKS' && value !== 'SECTION' && value !== 'ENDSEC') {
        blockEntities.set(value, (blockEntities.get(value) || 0) + 1);
      }
      if (section === 'ENTITIES' && value !== 'SECTION' && value !== 'ENDSEC') {
        ent = newEntity(value);
        if (value === 'POLYLINE') seqPoly = { layer: '', closed: false, points: [], source: 'POLYLINE' };
      }
      if (value === 'ENDSEC') { section = ''; seqPoly = null; }
      continue;
    }
    if (inLayerRecord && code === '2') { layerTable.push(value); continue; }
    if (section !== 'ENTITIES' || !ent) continue;

    switch (code) {
      case '8':
        ent.layer = value;
        if (ent.type === 'POLYLINE' && seqPoly) seqPoly.layer = value;
        break;
      case '67':
        ent.paper = parseInt(value, 10) === 1;
        if (ent.type === 'POLYLINE' && seqPoly && ent.paper) seqPoly = null; // лист: цепочку не собираем
        break;
      case '70':
        if (ent.type === 'LWPOLYLINE') ent.closed = (parseInt(value, 10) & 1) === 1;
        else if (ent.type === 'POLYLINE' && seqPoly) seqPoly.closed = (parseInt(value, 10) & 1) === 1;
        break;
      case '1':
      case '3':
        if (ent.type === 'TEXT' || ent.type === 'MTEXT') ent.textParts.push(value);
        break;
      case '2':
        if (ent.type === 'INSERT') ent.name = value;
        break;
      case '10': ent.pendingX = parseFloat(value); break;
      case '20':
        if (ent.pendingX !== null) { ent.pts.push([ent.pendingX, parseFloat(value)]); ent.pendingX = null; }
        break;
      case '11': ent.x11 = parseFloat(value); break;
      case '21': if (ent.x11 !== null) { ent.p11 = [ent.x11, parseFloat(value)]; ent.x11 = null; } break;
      case '12': ent.x12 = parseFloat(value); break;
      case '22': if (ent.x12 !== null) { ent.p12 = [ent.x12, parseFloat(value)]; ent.x12 = null; } break;
      case '13': ent.x13 = parseFloat(value); break;
      case '23': if (ent.x13 !== null) { ent.p13 = [ent.x13, parseFloat(value)]; ent.x13 = null; } break;
      case '40': if (ent.type === 'CIRCLE' || ent.type === 'ARC') ent.radius = parseFloat(value); break;
      case '50': if (ent.type === 'ARC') ent.a50 = parseFloat(value); break;
      case '51': if (ent.type === 'ARC') ent.a51 = parseFloat(value); break;
      default: break;
    }
  }
  flushEntity();
  if (seqPoly && seqPoly.points.length >= 2) polylines.push(seqPoly);

  polylines.push(...stitchSegments(segments));
  return { header, layers: layerTable, entities, paperEntities, texts, inserts, polylines, blockEntities };
}

/* ---------------- геометрия контуров ---------------- */
/** Слои, чья геометрия интересна для посадки: здания, границы, участки, красные линии. */
const CONTOUR_LAYER_RE = /(здани|строени|границ|застро|участ|кадастр|красн\S*\s*лини|ограждени|забор|контур|benchmark|boundary|building)/i;

function polyArea(points) {
  let s = 0;
  for (let i = 0; i < points.length; i++) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[(i + 1) % points.length];
    s += x1 * y2 - x2 * y1;
  }
  return Math.abs(s) / 2;
}

function polyPerimeter(points, closed) {
  let p = 0;
  const n = closed ? points.length : points.length - 1;
  for (let i = 0; i < n; i++) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[(i + 1) % points.length];
    p += Math.hypot(x2 - x1, y2 - y1);
  }
  return p;
}

const fmtN = (n) => (Math.round(n * 100) / 100).toLocaleString('ru-RU');
const fmtPt = ([x, y]) => `(${(Math.round(x * 100) / 100)}, ${(Math.round(y * 100) / 100)})`;

const GEOM_MAX_POLYS = 30;   // контуров в выжимке
const GEOM_MAX_VERTS = 40;   // вершин на контур
const GEOM_MAX_CHARS = 12000;

/**
 * Раздел «контуры и границы»: координаты полилиний со слоёв зданий/границ.
 *
 * Площади и длины пересчитываются в МЕТРЫ и подписываются единицами. Раньше
 * они уходили модели прямо в единицах чертежа: у миллиметрового чертежа
 * участок 30 000 × 50 000 подавался как «площадь ≈ 1 500 000 000» без единиц,
 * при том что геометрический движок для того же файла честно считал 1500 м².
 */
function contoursSection(polylines, unit) {
  let picked = polylines.filter((p) => CONTOUR_LAYER_RE.test(p.layer));
  let title = 'Контуры и границы (слои зданий/границ)';
  if (!picked.length) {
    // подходящих слоёв нет — берём крупнейшие замкнутые контуры как вероятные здания/границы
    picked = polylines.filter((p) => p.closed && p.points.length >= 3);
    title = 'Крупнейшие замкнутые контуры (слои зданий/границ не найдены)';
  }
  if (!picked.length) return '';

  const s = unit.scale;
  const ranked = picked
    .map((p) => ({ ...p, area: p.closed ? polyArea(p.points) * s * s : 0, perim: polyPerimeter(p.points, p.closed) * s }))
    .sort((a, b) => b.area - a.area || b.perim - a.perim)
    .slice(0, GEOM_MAX_POLYS);

  const lines = [];
  for (const p of ranked) {
    const verts = p.points.slice(0, GEOM_MAX_VERTS).map(fmtPt).join(' → ');
    const more = p.points.length > GEOM_MAX_VERTS ? ` …ещё ${p.points.length - GEOM_MAX_VERTS} вершин` : '';
    const metrics = p.closed
      ? `замкнутый, ${p.points.length} вершин, площадь ≈ ${fmtN(p.area)} м², периметр ≈ ${fmtN(p.perim)} м`
      : `разомкнутый, ${p.points.length} вершин, длина ≈ ${fmtN(p.perim)} м`;
    const from = p.source && p.source !== 'LWPOLYLINE' ? ` (из ${p.source})` : '';
    lines.push(`- [${p.layer || 'без слоя'}]${from} ${metrics}: ${verts}${more}`);
  }
  const skipped = picked.length - ranked.length;
  if (skipped > 0) lines.push(`(ещё ${skipped} контуров пропущено — показаны крупнейшие)`);
  const head = `${title} — площади и длины в метрах, координаты вершин в единицах чертежа (${unit.label})`;
  return `${head}:\n${lines.join('\n')}`.slice(0, GEOM_MAX_CHARS);
}

/**
 * Похожи ли координаты чертежа на государственную/местную систему.
 * Раньше фраза про МСК приписывалась любому чертежу, включая план 40 × 30 м
 * от начала координат, — и модель строила на этом привязку.
 */
const MSK_MIN_COORD_M = 100000; // МСК-координаты имеют порядок сотен тысяч метров

function looksLikeMsk(x1, y1, x2, y2, scale) {
  const vals = [x1, y1, x2, y2].filter(Number.isFinite).map((v) => Math.abs(v * scale));
  if (!vals.length) return false;
  return Math.max(...vals) >= MSK_MIN_COORD_M;
}

/** Компактная Markdown-выжимка чертежа для контекста модели. */
function summarizeDxf(dxfText, name, maxChars = 32000) {
  const { header, layers, entities, paperEntities, texts, inserts, polylines, blockEntities } = parseDxf(dxfText);
  const parts = [`## Выжимка из CAD-чертежа «${name}»`];

  const x1 = header['$EXTMIN.10'], y1 = header['$EXTMIN.20'];
  const x2 = header['$EXTMAX.10'], y2 = header['$EXTMAX.20'];
  const unit = units.unitInfo(header.$INSUNITS);
  const s = unit.scale;
  if ([x1, y1, x2, y2].every(Number.isFinite)) {
    const msk = looksLikeMsk(x1, y1, x2, y2, s)
      ? ' Координаты такого порядка обычно означают государственную/местную систему координат (МСК).'
      : ' Координаты малы по величине — это, скорее всего, локальная (условная) система координат, а не МСК.';
    parts.push(`Габариты чертежа: X ${fmtN(x1)}…${fmtN(x2)}, Y ${fmtN(y1)}…${fmtN(y2)} ` +
      `(≈ ${fmtN((x2 - x1) * s)} × ${fmtN((y2 - y1) * s)} м, единицы чертежа: ${unit.label}).${msk}`);
  } else {
    parts.push(`Единицы чертежа: ${unit.label}.`);
  }
  if (unit.assumed) {
    parts.push(unit.code === null || unit.code === 0
      ? `ВНИМАНИЕ: единицы измерения в чертеже не заданы (${unit.code === null ? '$INSUNITS отсутствует' : '$INSUNITS=0'}). ` +
        'Все размеры ниже посчитаны в предположении, что чертёж в метрах.'
      : `ВНИМАНИЕ: код единиц $INSUNITS=${unit.code} не распознан. ` +
        'Все размеры ниже посчитаны в предположении, что чертёж в метрах.');
  }

  if (layers.length) parts.push(`Слои (${layers.length}): ${layers.join('; ')}`);

  if (entities.size) {
    const ent = [...entities.entries()].sort((a, b) => b[1] - a[1])
      .map(([t, n]) => `${t} ×${n}`).join(', ');
    parts.push(`Объекты модельного пространства: ${ent}`);
  }

  if (paperEntities && paperEntities.size) {
    const total = [...paperEntities.values()].reduce((a, b) => a + b, 0);
    const ent = [...paperEntities.entries()].sort((a, b) => b[1] - a[1])
      .map(([t, n]) => `${t} ×${n}`).join(', ');
    parts.push(`Оформление листа (${total} сущностей: ${ent}) — рамка, штамп и видовые экраны. ` +
      'В геометрию местности не входит и в контурах ниже не участвует.');
  }

  if (inserts.size) {
    const total = [...inserts.values()].reduce((a, b) => a + b, 0);
    const top = [...inserts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)
      .map(([t, n]) => (n > 1 ? `${t} ×${n}` : t)).join(', ');
    parts.push(`Вставки блоков (условные знаки), всего ${total}: ${top}${inserts.size > 25 ? '…' : ''}. ` +
      'Содержимое блоков не разбирается — геометрия внутри них в модель участка не попадает.');
  }

  if (blockEntities && blockEntities.size) {
    const inner = [...blockEntities.entries()]
      .filter(([t]) => t !== 'BLOCK' && t !== 'ENDBLK')
      .sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t} ×${n}`).join(', ');
    if (inner) parts.push(`Внутри определений блоков: ${inner} (не разобрано).`);
  }

  const contours = contoursSection(polylines, unit);
  if (contours) parts.push(contours);

  if (texts.length) {
    // одинаковые надписи схлопываются со счётчиком; порядок — по частоте
    const freq = new Map();
    for (const t of texts) freq.set(t.value, (freq.get(t.value) || 0) + 1);
    const list = [...freq.entries()].sort((a, b) => b[1] - a[1])
      .map(([v, n]) => (n > 1 ? `«${v}» ×${n}` : `«${v}»`));
    parts.push(`Надписи на чертеже (${texts.length}, уникальных ${freq.size}):\n` + list.join(', '));
  }

  if (!layers.length && !entities.size && !texts.length) {
    parts.push('(структура DXF не распознана — возможно, файл повреждён или пуст)');
  }
  return parts.join('\n\n').slice(0, maxChars);
}

/**
 * Выжимка CAD-файла с кэшем рядом с файлом. ext: 'dwg' | 'dxf'.
 * Бросает ошибку с человекочитаемой причиной — вызывающий решает, чем заменить.
 */
/**
 * Отметка версии разбора внутри файла кэша.
 *
 * Имя файла остаётся прежним (`.cad.v2.md`): его удаляет маршрут при удалении
 * чертежа, и переименование оставило бы мусор на диске. Зато выжимка, снятая
 * прежним разбором, больше не годится — в ней площади в единицах чертежа,
 * сущности листа и фраза про МСК на локальном плане. Кэш без нужной отметки
 * пересобирается, а сама отметка модели не показывается.
 */
const SUMMARY_VERSION = 3;
const SUMMARY_STAMP = `<!-- cad-summary v${SUMMARY_VERSION} -->`;

async function extractCad(storedPath, ext, originalName) {
  const cachePath = storedPath + '.cad.v2.md';
  try {
    const cached = fs.readFileSync(cachePath, 'utf8');
    if (cached.startsWith(SUMMARY_STAMP)) return cached.slice(SUMMARY_STAMP.length).replace(/^\n/, '');
  } catch { /* кэша нет — разбираем заново */ }
  const dxfText = ext === 'dwg' ? await convertDwgToDxf(storedPath) : fs.readFileSync(storedPath, 'utf8');
  const md = summarizeDxf(dxfText, originalName);
  try { fs.writeFileSync(cachePath, `${SUMMARY_STAMP}\n${md}`); } catch { /* кэш вторичен */ }
  return md;
}

module.exports = { extractCad, parseDxf, summarizeDxf, convertDwgToDxf };
