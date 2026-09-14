'use strict';
/**
 * Внешние инструменты «Разбора PDF по форматам»: pdfinfo (poppler) читает боксы
 * и /Rotate каждой страницы, qpdf собирает пакет корзины из страниц разных
 * файлов. Всё через execFile, не через shell: имена с кириллицей и пробелами
 * уходят аргументами как есть.
 *
 * Почему qpdf, а не pdfseparate + pdfunite (проверено на РД 14.09.2026):
 * pdfseparate пишет каждую страницу отдельным документом со ВСЕМИ ресурсами,
 * до которых она дотягивается, а в PDF из AutoCAD словарь ресурсов общий на
 * весь файл — 163 страницы файла в 45 МБ превратились в 7,4 ГБ, комплект в
 * 654 МБ дал 9 ГБ страниц ещё до склейки. qpdf --pages копирует объекты один
 * раз на источник, --remove-unreferenced-resources=yes оставляет странице
 * только то, на что ссылается её содержимое: пакет А4 из 468 страниц — 46 МБ
 * за 1,4 с. Вектор, шрифты, слои и /Rotate переносятся как есть, без рендера.
 */
const { execFile } = require('child_process');
const path = require('path');

const PDFINFO = process.env.PDFINFO_BIN || 'pdfinfo';
const QPDF = process.env.QPDF_BIN || 'qpdf';
const PAGE_CAP = 100000; // -l больше числа страниц pdfinfo просто обрезает

function run(bin, args, { timeout = 15 * 60 * 1000, maxBuffer = 64 * 1024 * 1024 } = {}) {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout, maxBuffer, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, err, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

/** Понятная причина по stderr: пароль, порча, отсутствие бинарника. */
function reasonOf(res) {
  if (res.err && res.err.code === 'ENOENT') return `не найден ${res.err.path || 'инструмент'} — установите poppler-utils и qpdf`;
  const s = res.stderr || '';
  if (/Incorrect password|invalid password|Encrypted/i.test(s)) return 'защищён паролем';
  if (/Couldn't (find|read)|Syntax Error|May not be a PDF file|Document stream is empty|not a PDF file|unable to find trailer/i.test(s)) {
    return 'файл повреждён или это не PDF';
  }
  if (res.err && res.err.killed) return 'превышено время обработки';
  const line = s.split('\n').map((l) => l.trim()).find((l) => l && !/^WARNING:/.test(l)) || s.split('\n').map((l) => l.trim()).find(Boolean);
  return line ? line.slice(0, 200) : `инструмент завершился с кодом ${res.code}`;
}

/**
 * Страницы файла: { index, rotate, boxes: { mediabox, cropbox, bleedbox, trimbox, artbox } }
 * (боксы — [x0, y0, x1, y1] в пунктах). Шифрованный файл poppler открывает с
 * пустым паролем сам; если не вышло — ошибка «защищён паролем».
 */
async function inspect(file) {
  const res = await run(PDFINFO, ['-box', '-f', '1', '-l', String(PAGE_CAP), file], { timeout: 120 * 1000 });
  if (res.code !== 0) throw new Error(reasonOf(res));
  const pages = new Map();
  let total = 0;
  let encrypted = false;
  for (const line of res.stdout.split('\n')) {
    let m = /^Pages:\s+(\d+)/.exec(line);
    if (m) { total = Number(m[1]); continue; }
    m = /^Encrypted:\s+(yes|no)/.exec(line);
    if (m) { encrypted = m[1] === 'yes'; continue; }
    m = /^Page\s+(\d+)\s+rot:\s+(-?\d+)/.exec(line);
    if (m) { page(pages, m[1]).rotate = Number(m[2]); continue; }
    m = /^Page\s+(\d+)\s+(MediaBox|CropBox|BleedBox|TrimBox|ArtBox):\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)/.exec(line);
    if (m) page(pages, m[1]).boxes[m[2].toLowerCase()] = [Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])];
  }
  if (!total) throw new Error('pdfinfo не сообщил число страниц — файл повреждён или это не PDF');
  const list = [...pages.values()].sort((a, b) => a.index - b.index);
  if (list.length !== total) {
    throw new Error(`pdfinfo описал ${list.length} страниц из ${total} — файл повреждён`);
  }
  // exit 0 с «Syntax Error» в stderr — poppler восстановил таблицу объектов сам:
  // страницы прочитаны, но их число у обрезанного файла может отличаться от исходного
  // (в РД 26_ГСН: pdfinfo 19, pypdf 21) — оператор должен это видеть
  const damaged = /Syntax Error/i.test(res.stderr);
  return { pages: list, total, encrypted, damaged };
}

function page(map, idx) {
  const i = Number(idx);
  if (!map.has(i)) map.set(i, { index: i, rotate: 0, boxes: {} });
  return map.get(i);
}

/** Список страниц qpdf: 1,2,3,7,9,10 → «1-3,7,9-10». */
function rangeSpec(pages) {
  const sorted = [...new Set(pages.map(Number))].sort((a, b) => a - b);
  const out = [];
  let start = null;
  let prev = null;
  for (const n of sorted) {
    if (start === null) { start = n; prev = n; continue; }
    if (n === prev + 1) { prev = n; continue; }
    out.push(start === prev ? String(start) : `${start}-${prev}`);
    start = n; prev = n;
  }
  if (start !== null) out.push(start === prev ? String(start) : `${start}-${prev}`);
  return out.join(',');
}

/**
 * Пакет корзины: parts = [{ file, pages: [номера] }] в нужном порядке → out.
 * Страницы идут в порядке частей, внутри части — по возрастанию номера.
 * Возвращает предупреждения qpdf (повреждённый, но восстановленный файл —
 * оператору полезно знать), без дублей и без путей.
 */
async function assemble(parts, out) {
  const live = parts.filter((p) => p.pages && p.pages.length);
  if (!live.length) throw new Error('пакет без страниц');
  const args = ['--empty', '--warning-exit-0', '--remove-unreferenced-resources=yes', '--pages'];
  for (const p of live) args.push(p.file, rangeSpec(p.pages));
  args.push('--', out);
  const res = await run(QPDF, args);
  if (res.code !== 0) throw new Error(reasonOf(res));
  const warnings = new Set();
  for (const line of res.stderr.split('\n')) {
    const m = /^WARNING:\s*(.+?):\s*(.+)$/.exec(line.trim());
    if (m) warnings.add(`${path.basename(m[1].split(' (')[0])}: ${m[2]}`);
  }
  return { warnings: [...warnings] };
}

/** Что есть на машине: pdfinfo нужен для анализа, qpdf — для пакетов. */
async function available() {
  const [pi, qp] = await Promise.all([run(PDFINFO, ['-v'], { timeout: 5000 }), run(QPDF, ['--version'], { timeout: 5000 })]);
  const ok = (r) => !(r.err && r.err.code === 'ENOENT');
  return { pdfinfo: ok(pi), qpdf: ok(qp) };
}

module.exports = { inspect, assemble, rangeSpec, available, reasonOf, PDFINFO, QPDF };
