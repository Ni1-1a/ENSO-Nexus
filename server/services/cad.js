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
const INSUNITS_LABELS = {
  0: 'не заданы', 1: 'дюймы', 2: 'футы', 4: 'миллиметры', 5: 'сантиметры', 6: 'метры',
};

/** Снимает базовое MTEXT-форматирование: {\f...;текст}, \P (перевод строки) и т.п. */
function cleanMtext(s) {
  return s
    .replace(/\\P/g, ' ')
    .replace(/\\[fFcChHtTqQwWaA][^;]*;/g, '')
    .replace(/[{}]/g, '')
    .replace(/\\\\/g, '\\')
    .trim();
}

/**
 * Разбор текста DXF: пары (код группы, значение) построчно.
 * Возвращает { header, layers, entities, texts, inserts, polylines }.
 */
function parseDxf(text) {
  const lines = text.split(/\r?\n/);
  const header = {};
  const layerTable = [];
  const entities = new Map();  // тип → количество (только секция ENTITIES)
  const texts = [];            // {value, layer}
  const inserts = new Map();   // имя блока → количество
  const polylines = [];        // {layer, closed, points: [[x,y],…]}

  let section = '';
  let headerVar = '';
  let current = '';            // тип текущей сущности
  let currentLayer = '';
  let inLayerRecord = false;
  let mtextParts = [];
  let poly = null;             // накапливаемая LWPOLYLINE
  let seqPoly = null;          // старая POLYLINE + VERTEX…SEQEND
  let pendingX = null;

  const flushText = () => {
    if (current === 'MTEXT' && mtextParts.length) {
      const value = cleanMtext(mtextParts.join(''));
      if (value) texts.push({ value, layer: currentLayer });
    }
    mtextParts = [];
  };
  const flushPoly = () => {
    if (poly && poly.points.length >= 2) polylines.push(poly);
    poly = null;
    pendingX = null;
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
      flushText();
      flushPoly();
      if (value === 'SEQEND' && seqPoly) {
        if (seqPoly.points.length >= 2) polylines.push(seqPoly);
        seqPoly = null;
      }
      current = value;
      currentLayer = '';
      inLayerRecord = section === 'TABLES' && value === 'LAYER';
      if (section === 'ENTITIES' && value !== 'SECTION' && value !== 'ENDSEC') {
        entities.set(value, (entities.get(value) || 0) + 1);
        if (value === 'LWPOLYLINE') poly = { layer: '', closed: false, points: [] };
        if (value === 'POLYLINE') seqPoly = { layer: '', closed: false, points: [] };
      }
      if (value === 'ENDSEC') { section = ''; seqPoly = null; }
      continue;
    }
    if (inLayerRecord && code === '2') { layerTable.push(value); continue; }
    if (section !== 'ENTITIES') continue;

    if (code === '8') {
      currentLayer = value;
      if (current === 'LWPOLYLINE' && poly) poly.layer = value;
      if (current === 'POLYLINE' && seqPoly) seqPoly.layer = value;
    } else if (code === '1' && current === 'TEXT') { if (value) texts.push({ value, layer: currentLayer }); }
    else if ((code === '1' || code === '3') && current === 'MTEXT') mtextParts.push(value);
    else if (code === '2' && current === 'INSERT') inserts.set(value, (inserts.get(value) || 0) + 1);
    else if (current === 'LWPOLYLINE' && poly) {
      if (code === '70') poly.closed = (parseInt(value, 10) & 1) === 1;
      else if (code === '10') pendingX = parseFloat(value);
      else if (code === '20' && pendingX !== null) { poly.points.push([pendingX, parseFloat(value)]); pendingX = null; }
    } else if (current === 'POLYLINE' && seqPoly && code === '70') {
      seqPoly.closed = (parseInt(value, 10) & 1) === 1;
    } else if (current === 'VERTEX' && seqPoly) {
      if (code === '10') pendingX = parseFloat(value);
      else if (code === '20' && pendingX !== null) { seqPoly.points.push([pendingX, parseFloat(value)]); pendingX = null; }
    }
  }
  flushText();
  flushPoly();
  return { header, layers: layerTable, entities, texts, inserts, polylines };
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

/** Раздел «контуры и границы»: координаты полилиний со слоёв зданий/границ. */
function contoursSection(polylines) {
  let picked = polylines.filter((p) => CONTOUR_LAYER_RE.test(p.layer));
  let title = 'Контуры и границы (слои зданий/границ)';
  if (!picked.length) {
    // подходящих слоёв нет — берём крупнейшие замкнутые контуры как вероятные здания/границы
    picked = polylines.filter((p) => p.closed && p.points.length >= 3);
    title = 'Крупнейшие замкнутые контуры (слои зданий/границ не найдены)';
  }
  if (!picked.length) return '';

  const ranked = picked
    .map((p) => ({ ...p, area: p.closed ? polyArea(p.points) : 0, perim: polyPerimeter(p.points, p.closed) }))
    .sort((a, b) => b.area - a.area || b.perim - a.perim)
    .slice(0, GEOM_MAX_POLYS);

  const lines = [];
  for (const p of ranked) {
    const verts = p.points.slice(0, GEOM_MAX_VERTS).map(fmtPt).join(' → ');
    const more = p.points.length > GEOM_MAX_VERTS ? ` …ещё ${p.points.length - GEOM_MAX_VERTS} вершин` : '';
    const metrics = p.closed
      ? `замкнутый, ${p.points.length} вершин, площадь ≈ ${fmtN(p.area)}, периметр ≈ ${fmtN(p.perim)}`
      : `разомкнутый, ${p.points.length} вершин, длина ≈ ${fmtN(p.perim)}`;
    lines.push(`- [${p.layer || 'без слоя'}] ${metrics}: ${verts}${more}`);
  }
  const skipped = picked.length - ranked.length;
  if (skipped > 0) lines.push(`(ещё ${skipped} контуров пропущено — показаны крупнейшие)`);
  return `${title} — координаты в единицах чертежа:\n${lines.join('\n')}`.slice(0, GEOM_MAX_CHARS);
}

/** Компактная Markdown-выжимка чертежа для контекста модели. */
function summarizeDxf(dxfText, name, maxChars = 32000) {
  const { header, layers, entities, texts, inserts, polylines } = parseDxf(dxfText);
  const parts = [`## Выжимка из CAD-чертежа «${name}»`];

  const x1 = header['$EXTMIN.10'], y1 = header['$EXTMIN.20'];
  const x2 = header['$EXTMAX.10'], y2 = header['$EXTMAX.20'];
  const units = INSUNITS_LABELS[header.$INSUNITS] || `код ${header.$INSUNITS}`;
  if ([x1, y1, x2, y2].every(Number.isFinite)) {
    parts.push(`Габариты чертежа: X ${fmtN(x1)}…${fmtN(x2)}, Y ${fmtN(y1)}…${fmtN(y2)} ` +
      `(≈ ${fmtN(x2 - x1)} × ${fmtN(y2 - y1)}, единицы: ${units}). ` +
      'Крупные значения координат обычно означают государственную/местную систему координат (МСК).');
  } else if (header.$INSUNITS !== undefined) {
    parts.push(`Единицы чертежа: ${units}.`);
  }

  if (layers.length) parts.push(`Слои (${layers.length}): ${layers.join('; ')}`);

  if (entities.size) {
    const ent = [...entities.entries()].sort((a, b) => b[1] - a[1])
      .map(([t, n]) => `${t} ×${n}`).join(', ');
    parts.push(`Объекты: ${ent}`);
  }

  if (inserts.size) {
    const top = [...inserts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)
      .map(([t, n]) => (n > 1 ? `${t} ×${n}` : t)).join(', ');
    parts.push(`Вставки блоков (условные знаки): ${top}${inserts.size > 25 ? '…' : ''}`);
  }

  const contours = contoursSection(polylines);
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
async function extractCad(storedPath, ext, originalName) {
  const cachePath = storedPath + '.cad.v2.md'; // v2: добавлены координаты контуров
  if (fs.existsSync(cachePath)) return fs.readFileSync(cachePath, 'utf8');
  const dxfText = ext === 'dwg' ? await convertDwgToDxf(storedPath) : fs.readFileSync(storedPath, 'utf8');
  const md = summarizeDxf(dxfText, originalName);
  try { fs.writeFileSync(cachePath, md); } catch { /* кэш вторичен */ }
  return md;
}

module.exports = { extractCad, parseDxf, summarizeDxf, convertDwgToDxf };
