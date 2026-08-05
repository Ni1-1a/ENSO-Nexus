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
 * Возвращает { header, layers, entities, texts, inserts }.
 */
function parseDxf(text) {
  const lines = text.split(/\r?\n/);
  const header = {};
  const layerTable = [];
  const entities = new Map();  // тип → количество (только секция ENTITIES)
  const texts = [];            // {value, layer}
  const inserts = new Map();   // имя блока → количество

  let section = '';
  let headerVar = '';
  let current = '';            // тип текущей сущности
  let currentLayer = '';
  let inLayerRecord = false;
  let mtextParts = [];

  const flushText = () => {
    if (current === 'MTEXT' && mtextParts.length) {
      const value = cleanMtext(mtextParts.join(''));
      if (value) texts.push({ value, layer: currentLayer });
    }
    mtextParts = [];
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
      current = value;
      currentLayer = '';
      inLayerRecord = section === 'TABLES' && value === 'LAYER';
      if (section === 'ENTITIES' && value !== 'SECTION' && value !== 'ENDSEC') {
        entities.set(value, (entities.get(value) || 0) + 1);
      }
      if (value === 'ENDSEC') section = '';
      continue;
    }
    if (inLayerRecord && code === '2') { layerTable.push(value); continue; }
    if (section !== 'ENTITIES') continue;

    if (code === '8') currentLayer = value;
    else if (code === '1' && current === 'TEXT') { if (value) texts.push({ value, layer: currentLayer }); }
    else if ((code === '1' || code === '3') && current === 'MTEXT') mtextParts.push(value);
    else if (code === '2' && current === 'INSERT') inserts.set(value, (inserts.get(value) || 0) + 1);
  }
  flushText();
  return { header, layers: layerTable, entities, texts, inserts };
}

const fmtN = (n) => (Math.round(n * 100) / 100).toLocaleString('ru-RU');

/** Компактная Markdown-выжимка чертежа для контекста модели. */
function summarizeDxf(dxfText, name, maxChars = 20000) {
  const { header, layers, entities, texts, inserts } = parseDxf(dxfText);
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
  const cachePath = storedPath + '.cad.md';
  if (fs.existsSync(cachePath)) return fs.readFileSync(cachePath, 'utf8');
  const dxfText = ext === 'dwg' ? await convertDwgToDxf(storedPath) : fs.readFileSync(storedPath, 'utf8');
  const md = summarizeDxf(dxfText, originalName);
  try { fs.writeFileSync(cachePath, md); } catch { /* кэш вторичен */ }
  return md;
}

module.exports = { extractCad, parseDxf, summarizeDxf, convertDwgToDxf };
