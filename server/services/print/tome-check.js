'use strict';
/**
 * Нормоконтроль тома (Б3, версия 1): детерминированные проверки собранного
 * комплекта без нейросети. Замечания — в формате модуля «Нормоконтроль»
 * (таблица findings: rule_id, severity, origin, verification, location,
 * doc_quote, ntd, ntd_clause, ntd_quote, wording, fix_hint, codes), чтобы их
 * можно было передать туда как есть. Второго движка правил здесь нет: номера
 * пунктов и формулировки — из каталога нормоконтроля и базы нормативов
 * (ГОСТ Р 21.101-2020 по Knowledge-Base/12_VLM-OCR, правило COM-CMP-009).
 *
 * Текстовый слой читается pdftotext -bbox из ПАКЕТОВ разбора (копии qpdf без
 * словаря Info): на исходнике 05_АР3 из РД pdftotext падает на словаре Info
 * (std::out_of_range), а на копии qpdf работает. Лист пакета сопоставляется
 * с листом тома по records (package, packagePage). Если текстового слоя нет
 * (скан) — честное «не проверено — нет текстового слоя», догадок нет.
 */
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const formats = require('./formats');
const binding = require('./binding');
const fold = require('./fold');

const PDFTOTEXT = process.env.PDFTOTEXT_BIN || 'pdftotext';
const VOLUME_LIMIT_A4 = 300;   // ГОСТ Р 21.101-2020, п. 8.1.3

/** Источники пунктов — проверены по тексту стандарта (OCR-страницы базы знаний), не по памяти. */
const NTD = {
  volume: { ntd: 'ГОСТ Р 21.101-2020', clause: '8.1.3', quote: 'Количество листов, включаемых в том, определяют из необходимости обеспечения удобства работы, как правило, не более 300 листов формата А4 или эквивалентного количества листов других форматов.', rule: 'COM-CMP-009' },
  sheets: { ntd: 'ГОСТ Р 21.101-2020', clause: 'приложение Ж (графа 8)', quote: 'в графе 8 - общее количество листов документа. Графу заполняют только на первом листе;', rule: 'PRN-TB-008' },
  numbering: { ntd: 'ГОСТ Р 21.101-2020', clause: '4.2.5', quote: 'Нумерация листов каждого документа основного комплекта рабочих чертежей должна быть сквозной в пределах документа.', rule: 'COM-ID-004' },
  sheetsChange: { ntd: 'ГОСТ Р 21.101-2020', clause: '7.3.10', quote: 'При изменении общего количества листов документа на его первом листе в основной надписи вносят соответствующие исправления в графу "Листов".', rule: 'COM-CHG-011' },
  format: { ntd: 'ГОСТ Р 21.101-2020', clause: 'приложение Ж (графа 26)', quote: 'в графе 26 - обозначение формата листа по ГОСТ 2.301. Для электронного документа указывают формат листа, на котором изображение будет соответствовать установленному масштабу;', rule: 'PRN-TB-026' },
  formatsGost: { ntd: 'ГОСТ 2.301-68', clause: 'таблица 1 (основные форматы)', quote: '', rule: 'PRN-FMT-001' },
  bindingTech: { ntd: '', clause: '', quote: '', rule: 'PRN-BIND-001' },
};

function run(bin, args, { timeout = 10 * 60 * 1000, maxBuffer = 512 * 1024 * 1024 } = {}) {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout, maxBuffer, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, err, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

async function available() {
  const r = await run(PDFTOTEXT, ['-v'], { timeout: 5000 });
  return !(r.err && r.err.code === 'ENOENT');
}

/* ---------------- текстовый слой ---------------- */

function unescapeXml(s) {
  return s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

/** pdftotext -bbox → [{ width, height, words: [{ x0, y0, x1, y1, t }] }] по страницам. */
function parseBbox(xml) {
  const pages = [];
  const pageRe = /<page width="([\d.]+)" height="([\d.]+)">([\s\S]*?)<\/page>/g;
  const wordRe = /<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([^<]*)<\/word>/g;
  let m;
  while ((m = pageRe.exec(xml))) {
    const words = [];
    let w;
    while ((w = wordRe.exec(m[3]))) words.push({ x0: +w[1], y0: +w[2], x1: +w[3], y1: +w[4], t: unescapeXml(w[5]) });
    pages.push({ width: +m[1], height: +m[2], words });
  }
  return pages;
}

/** Текстовый слой файла постранично; null — pdftotext не справился (причина в reason). */
async function textLayer(file) {
  const res = await run(PDFTOTEXT, ['-bbox', file, '-']);
  if (res.code !== 0) {
    const line = res.stderr.split('\n').map((l) => l.trim()).find(Boolean) || `код ${res.code}`;
    return { pages: null, reason: line.slice(0, 160) };
  }
  return { pages: parseBbox(res.stdout), reason: '' };
}

/* ---------------- разбор основной надписи ---------------- */

const FORMAT_WORD = /^(?:[АA])(\d)(?:[хx×]\s*(\d+))?$/i;
const INT_WORD = /^\d{1,4}$/;
// номер листа бывает «3.1» или «3а» — добавленный лист (ГОСТ Р 21.101-2020, п. 7.3.9)
const SHEET_NO_WORD = /^(\d{1,4})(?:\.(\d{1,2})|([а-яё]))?$/i;

/** Нормализация подписи формата: латинская A → кириллическая А, «х» → «х». */
function normFormat(s) {
  const m = FORMAT_WORD.exec(String(s).replace(/\s+/g, ''));
  if (!m) return '';
  return `А${m[1]}${m[2] ? `х${m[2]}` : ''}`;
}

/** Число под заголовком графы: стоит ниже слова в его колонке (у шрифтов без метрик ширина слова нулевая — окно не уже 3 высот). */
function numberBelow(words, h, re = INT_WORD) {
  const hh = h.y1 - h.y0;
  const right = Math.max(h.x1, h.x0 + hh * 3);
  const below = words.filter((w) => re.test(w.t) && w.y0 > h.y0 + hh * 0.5 && w.y0 < h.y1 + hh * 3.5
    && (w.x0 + w.x1) / 2 >= h.x0 - hh && (w.x0 + w.x1) / 2 <= right + hh);
  if (!below.length) return null;
  const t = below.sort((a, b) => a.y0 - b.y0)[0].t;
  return re === INT_WORD ? Number(t) : t;
}

/** Номер листа «3», «3.1», «3а» → { base, sub } (sub — добавленный лист после базового). */
function parseSheetNo(t) {
  const m = SHEET_NO_WORD.exec(String(t));
  if (!m) return null;
  return { base: Number(m[1]), sub: m[2] !== undefined ? Number(m[2]) : (m[3] ? m[3].toLowerCase() : null), raw: t };
}

/**
 * Что написано в основной надписи страницы: номер листа (графа 7, число под
 * «Лист» рядом с «Листов»), заявленное число листов (графа 8, число под
 * «Листов») и подпись формата («Формат А3» под рамкой). Берётся самый нижний
 * заголовок «Листов» — основная надпись внизу справа; «Лист» в ведомостях
 * (шапки таблиц) стоит выше и далеко от «Листов», он не считается.
 */
function readTitleBlock(page) {
  const words = page.words;
  const out = { sheetNo: null, claimedSheets: null, hasSheetsHeader: false, formatLabel: '', hasText: words.length > 0 };
  const sheetsHeads = words.filter((w) => /^Листов[:.]?$/i.test(w.t)).sort((a, b) => b.y0 - a.y0);
  for (const h of sheetsHeads) {
    out.hasSheetsHeader = true;
    const hh = h.y1 - h.y0;
    const n = numberBelow(words, h);
    // «Лист» той же строки слева от «Листов» — графа 7
    const lead = words.filter((w) => /^Лист[:.]?$/i.test(w.t) && Math.abs(w.y0 - h.y0) < hh && w.x1 <= h.x0 + 1 && w.x0 > h.x0 - hh * 8)
      .sort((a, b) => b.x0 - a.x0)[0];
    const sheetNo = lead ? parseSheetNo(numberBelow(words, lead, SHEET_NO_WORD)) : null;
    if (n !== null || sheetNo !== null) { out.claimedSheets = n; out.sheetNo = sheetNo; break; }
  }
  if (out.sheetNo === null) {
    // последующие листы (форма 6): графа «Лист» без «Листов» — нижний правый угол, число под словом
    const cands = words.filter((w) => /^Лист[:.]?$/i.test(w.t) && w.y0 > page.height * 0.7 && w.x0 > page.width * 0.45)
      .map((h) => ({ h, n: parseSheetNo(numberBelow(words, h, SHEET_NO_WORD)) })).filter((x) => x.n !== null)
      .sort((a, b) => b.h.y0 - a.h.y0);
    if (cands.length) out.sheetNo = cands[0].n;
  }
  const fmtHeads = words.filter((w) => /^Формат[:.]?$/i.test(w.t)).sort((a, b) => b.y0 - a.y0);
  for (const h of fmtHeads) {
    const hh = h.y1 - h.y0;
    const right = words.filter((w) => w !== h && Math.abs(w.y0 - h.y0) < hh && w.x0 >= h.x1 - 1 && w.x0 < h.x1 + hh * 6)
      .sort((a, b) => a.x0 - b.x0);
    const label = right.map((w) => normFormat(w.t)).find(Boolean) || '';
    if (label) { out.formatLabel = label; break; }
  }
  if (!out.formatLabel) {
    // «ФорматА3» одним словом
    const joined = words.find((w) => /^Формат[АA]\d/i.test(w.t));
    if (joined) out.formatLabel = normFormat(joined.t.replace(/^Формат/i, ''));
  }
  return out;
}

/**
 * Документы внутри файла тома по графе «Лист»: лист с номером 1 начинает
 * документ, следующие номера его продолжают, листы без номера (обложка,
 * титул, продолжение без надписи) идут к текущему. В шаблонах ЭНСО графа
 * «Листов» заполнена на каждом листе — считать каждый такой лист началом
 * документа нельзя (на РД это давало 10 ложных замечаний на том).
 */
function segmentDocuments(rows, titleOf) {
  const docs = [];
  let cur = null;
  for (const r of rows) {
    const tb = titleOf(r) || { sheetNo: null, claimedSheets: null, hasSheetsHeader: false, hasText: false };
    const no = tb.sheetNo && typeof tb.sheetNo === 'object' ? tb.sheetNo : (Number.isFinite(tb.sheetNo) ? { base: tb.sheetNo, sub: null, raw: String(tb.sheetNo) } : null);
    // новый документ: лист 1; или лист 1.1 после документа, в котором листов уже столько, сколько заявлено (титул на один лист)
    const complete = cur && cur.claimed !== null && cur.pages.length >= cur.claimed;
    const starts = (no && no.base === 1 && (no.sub === null || complete)) || (!cur && (no !== null || tb.claimedSheets !== null));
    if (starts) {
      cur = { firstPage: r.page, claimed: tb.claimedSheets, claimedLater: null, hasHeader: tb.hasSheetsHeader, pages: [], leads: [], gaps: [] };
      docs.push(cur);
    }
    if (!cur) { cur = { firstPage: r.page, claimed: null, claimedLater: null, hasHeader: false, pages: [], leads: [], gaps: [], noTitle: true }; docs.push(cur); }
    cur.pages.push(r.page);
    if (no) {
      const last = cur.leads.length ? cur.leads[cur.leads.length - 1] : 0;
      // допустимо: следующий номер, тот же номер с добавкой (3 → 3.1 → 3.2), после добавки — следующий базовый
      const ok = !cur.leads.length || no.base === last + 1 || (no.base === last && no.sub !== null);
      if (!ok) cur.gaps.push({ page: r.page, from: last, to: no.raw });
      cur.leads.push(no.base);
    }
    if (cur.claimed === null && tb.claimedSheets !== null) cur.claimedLater = cur.claimedLater ?? tb.claimedSheets;
  }
  return docs;
}

/* ---------------- замечания ---------------- */

function finding({ rule, severity = 'minor', verification = 'auto', file, page, sheet, quote = '', ntdKey, wording, fix = '', codes = {} }) {
  const src = NTD[ntdKey] || NTD.bindingTech;
  return {
    rule_id: rule || src.rule, origin: 'deterministic', severity, verification,
    location: { file, page: page || null, sheet: sheet || null },
    doc_quote: quote || null,
    ntd: src.ntd || 'технологическое требование (конфиг расходников)', ntd_clause: src.clause || null, ntd_quote: src.quote || null,
    wording, fix_hint: fix || null, confidence: null, codes,
  };
}

/**
 * Прогон проверок Н1–Н5 по готовому разбору.
 * @param job        разбор (packages, tomes, settings, binding)
 * @param records    записи листов
 * @param opts.srcPath (file) → путь исходника (запасной путь чтения текста)
 */
async function run_(job, records, { srcPath, packageDir } = {}) {
  const out = { at: new Date().toISOString(), findings: [], tomes: [], notes: [], textPages: 0, textMissing: 0 };
  const tomes = job.tomes && job.tomes.length ? job.tomes : (job.files || []).map((f) => ({ fileId: f.id, name: f.name, title: f.name.replace(/\.pdf$/i, ''), recognized: false }));
  const byFile = new Map();
  for (const r of records) { if (!byFile.has(r.fileId)) byFile.set(r.fileId, []); byFile.get(r.fileId).push(r); }

  // 1. Текстовый слой — из пакетов (qpdf-копии без словаря Info), лист пакета → лист тома
  const titleByKey = new Map();   // `${fileId}:${page}` → readTitleBlock
  const pkgDir = packageDir || path.join(require('./jobs').jobDir(job), 'packages');
  const byPackage = new Map();
  for (const r of records) { if (r.package) { if (!byPackage.has(r.package)) byPackage.set(r.package, []); byPackage.get(r.package).push(r); } }
  const unreadable = [];
  for (const p of job.packages || []) {
    const abs = path.join(pkgDir, p.file);
    if (!fs.existsSync(abs)) continue;
    const { pages, reason } = await textLayer(abs);
    if (!pages) { unreadable.push(`${p.file}: ${reason}`); continue; }
    for (const r of byPackage.get(p.file) || []) {
      const pg = pages[r.packagePage - 1];
      if (!pg) continue;
      const tb = readTitleBlock(pg);
      titleByKey.set(`${r.fileId}:${r.page}`, tb);
      if (tb.hasText) out.textPages += 1; else out.textMissing += 1;
    }
  }
  // листы, не попавшие в пакеты (только анализ) — читаем исходник; упал — так и пишем
  const missing = records.filter((r) => !titleByKey.has(`${r.fileId}:${r.page}`));
  if (missing.length && srcPath) {
    const files = new Set(missing.map((r) => r.fileId));
    for (const fileId of files) {
      const f = (job.files || []).find((x) => x.id === fileId);
      if (!f) continue;
      const { pages, reason } = await textLayer(srcPath(f));
      if (!pages) { unreadable.push(`${f.name}: ${reason}`); continue; }
      for (const r of missing.filter((x) => x.fileId === fileId)) {
        const pg = pages[r.page - 1];
        if (!pg) continue;
        const tb = readTitleBlock(pg);
        titleByKey.set(`${r.fileId}:${r.page}`, tb);
        if (tb.hasText) out.textPages += 1; else out.textMissing += 1;
      }
    }
  }
  for (const u of unreadable) out.notes.push(`текстовый слой не прочитан — ${u}`);

  const st = job.binding ? job.binding.settings : binding.defaults();

  for (const tome of tomes) {
    const rows = (byFile.get(tome.fileId) || []).sort((a, b) => a.page - b.page);
    if (!rows.length) continue;
    const t = { tome, sheets: rows.length, a4ByArea: 0, layersMax: 0, layersSpine: 0, claimed: [], nonStandard: [], textMissing: 0, findings: [] };
    const push = (f) => { f.location.tome = tome.title; t.findings.push(f); out.findings.push(f); };

    // Н1. Объём тома: приведённые листы по модели Б2 (слои) и по площади против 300 А4
    for (const r of rows) {
      if (r.kind === 'ОШИБКА') continue;
      const L = binding.sheetLayers(r, st);
      t.layersMax += L.max; t.layersSpine += L.binding;
      t.a4ByArea += formats.reducedOf(r).a4;
    }
    t.a4ByArea = Math.round(t.a4ByArea * 10) / 10;
    if (t.layersMax > VOLUME_LIMIT_A4) {
      push(finding({
        ntdKey: 'volume', severity: 'minor', file: tome.name,
        wording: `Объём тома «${tome.title}» — ${t.layersMax} слоёв А4 по модели складывания (${t.sheets} л., по площади ${t.a4ByArea} А4) — превышает рекомендуемые 300 листов формата А4 (ГОСТ Р 21.101-2020, п. 8.1.3).`,
        fix: 'Разделить том на части (книги) и указать на обложках номер части и общее число частей (п. 8.1.7).',
        codes: { check: 'Н1', found: t.layersMax, expected: VOLUME_LIMIT_A4, a4ByArea: t.a4ByArea, sheets: t.sheets },
      }));
    }

    // Н2. Число листов: графа «Листов» первого листа документа против фактического числа листов документа
    let textMissing = 0;
    for (const r of rows) { const tb = titleByKey.get(`${r.fileId}:${r.page}`); if (tb && !tb.hasText) textMissing += 1; }
    t.textMissing = textMissing;
    if (textMissing === rows.length) {
      t.notes = [`не проверено — нет текстового слоя (${rows.length} л.)`];
      push(finding({
        rule: 'PRN-TB-008', ntdKey: 'sheets', severity: 'remark', verification: 'needs_human', file: tome.name,
        wording: `Том «${tome.title}»: графы «Листов» и «Формат» не проверены — у листов нет текстового слоя (скан или растр).`,
        fix: 'Проверить основную надпись глазами или распознать текст.',
        codes: { check: 'Н2', status: 'not_checked', reason: 'no_text_layer' },
      }));
    } else {
      const docs = segmentDocuments(rows, (r) => titleByKey.get(`${r.fileId}:${r.page}`));
      let anyClaimed = false;
      for (const d of docs) {
        if (d.noTitle) continue;
        const actual = d.pages.length;
        const claimed = d.claimed !== null ? d.claimed : d.claimedLater;
        const fromLater = d.claimed === null && d.claimedLater !== null;
        t.claimed.push({ page: d.firstPage, claimed, actual, leads: d.leads.length, fromLater });
        if (claimed === null) {
          if (d.hasHeader && actual > 1) {
            push(finding({
              ntdKey: 'sheets', severity: 'minor', verification: 'needs_human', file: tome.name, page: d.firstPage, sheet: d.firstPage,
              wording: `Лист ${d.firstPage} тома «${tome.title}»: графа «Листов» первого листа документа не заполнена, в документе ${actual} л. (ГОСТ Р 21.101-2020, приложение Ж, графа 8).`,
              fix: 'Заполнить графу «Листов» на первом листе документа.',
              codes: { check: 'Н2', found: null, expected: actual, firstPage: d.firstPage },
            }));
          }
          continue;
        }
        anyClaimed = true;
        if (claimed !== actual) {
          push(finding({
            ntdKey: 'sheets', severity: 'major', verification: 'needs_human', file: tome.name, page: d.firstPage, sheet: d.firstPage,
            quote: `Листов: ${claimed}`,
            wording: `Лист ${d.firstPage} тома «${tome.title}»: в графе «Листов» указано ${claimed}${fromLater ? ' (на последующих листах; на первом графа пуста)' : ''}, а в документе ${actual} л. (листы ${d.firstPage}–${d.pages[d.pages.length - 1]} файла) (ГОСТ Р 21.101-2020, приложение Ж, графа 8; п. 7.3.10).`,
            fix: 'Сверить число листов документа с графой «Листов» первого листа; при изменении состава исправить графу (п. 7.3.10). Границы документа определены по графе «Лист» (номер 1 — начало), при нескольких документах в файле проверить глазами.',
            codes: { check: 'Н2', found: claimed, expected: actual, firstPage: d.firstPage },
          }));
        }
        for (const g of d.gaps) {
          push(finding({
            rule: 'COM-ID-004', ntdKey: 'numbering', severity: 'minor', verification: 'needs_human', file: tome.name, page: g.page, sheet: g.page,
            quote: `Лист ${g.to}`,
            wording: `Лист ${g.page} тома «${tome.title}»: номер листа в основной надписи ${g.to} после ${g.from} — нумерация листов документа не сквозная (ГОСТ Р 21.101-2020, п. 4.2.5).`,
            fix: 'Проверить порядок листов в файле и нумерацию в графе «Лист».',
            codes: { check: 'Н2', kind: 'numbering', found: g.to, expected: g.from + 1, page: g.page },
          }));
        }
      }
      if (!anyClaimed) out.notes.push(`том «${tome.title}»: графа «Листов» с числом не найдена в текстовом слое`);
    }

    // Н3. Подпись формата под рамкой против измеренного формата
    for (const r of rows) {
      const tb = titleByKey.get(`${r.fileId}:${r.page}`);
      if (!tb || !tb.formatLabel) continue;
      const measured = r.kind === 'ГОСТ' ? r.format : (r.kind === 'ГОСТ кратный' ? r.format : '');
      if (!measured) {
        push(finding({
          ntdKey: 'format', severity: 'minor', verification: 'needs_human', file: tome.name, page: r.page, sheet: r.page,
          quote: `Формат ${tb.formatLabel}`,
          wording: `Лист ${r.page} тома «${tome.title}»: подписан «Формат ${tb.formatLabel}», а по геометрии страницы лист нестандартный ${Math.round(r.width)}×${Math.round(r.height)} мм (${r.carrier}).`,
          fix: 'Привести размер листа к подписанному формату или исправить подпись (ГОСТ Р 21.101-2020, приложение Ж, графа 26).',
          codes: { check: 'Н3', found: tb.formatLabel, expected: `НС ${Math.round(r.short)}×${Math.round(r.long)}` },
        }));
      } else if (tb.formatLabel !== measured) {
        push(finding({
          ntdKey: 'format', severity: 'minor', file: tome.name, page: r.page, sheet: r.page,
          quote: `Формат ${tb.formatLabel}`,
          wording: `Лист ${r.page} тома «${tome.title}»: подписан «Формат ${tb.formatLabel}», а измеренный формат листа — ${measured} (${Math.round(r.width)}×${Math.round(r.height)} мм).`,
          fix: 'Исправить обозначение формата в графе 26 или размер листа (ГОСТ Р 21.101-2020, приложение Ж).',
          codes: { check: 'Н3', found: tb.formatLabel, expected: measured },
        }));
      }
    }

    // Н4. Нестандартные листы — предупреждение со списком размеров
    const nc = rows.filter((r) => r.kind === 'НС' || r.kind === 'ОШИБКА');
    if (nc.length) {
      const sizes = formats.sizeBreakdown(nc, job.settings ? job.settings.tolerance : 3);
      t.nonStandard = sizes;
      push(finding({
        ntdKey: 'formatsGost', severity: 'remark', verification: 'needs_human', file: tome.name,
        wording: `Том «${tome.title}»: ${nc.length} нестандартных листов (${sizes.map((s) => `${s.label} — ${s.count}`).join(', ')}); форматы по ГОСТ 2.301-68 — А0…А4 и кратные.`,
        fix: 'Проверить, оправдан ли нестандарт (развёртки, генплан); при печати такие листы уходят на рулон по короткой стороне. Номер пункта ГОСТ 2.301-68 по тексту стандарта не сверен — базы нормативов на него нет.',
        codes: { check: 'Н4', count: nc.length, sizes },
      }));
    }

    // Н5. Переплёт: толщина блока против вместимости пружины (по расчёту А6)
    const bt = job.binding && job.binding.tomes ? job.binding.tomes.find((x) => x.tome.fileId === tome.fileId) : null;
    if (bt && bt.springKind !== 'folder') {
      if (!bt.spring || bt.books > 1) {
        push(finding({
          ntdKey: 'bindingTech', severity: 'remark', file: tome.name,
          wording: `Том «${tome.title}»: блок ${bt.blockMm} мм толще самой большой пружины (${bt.springTitle}) — ${bt.note || 'разделить на книги'}.`,
          fix: `Разделить том на ${bt.books} книги или выбрать другой тип переплёта.`,
          codes: { check: 'Н5', blockMm: bt.blockMm, books: bt.books },
        }));
      }
    }
    out.tomes.push(t);
  }
  out.summary = {
    tomes: out.tomes.length, findings: out.findings.length,
    bySeverity: out.findings.reduce((acc, f) => { acc[f.severity] = (acc[f.severity] || 0) + 1; return acc; }, {}),
    byCheck: out.findings.reduce((acc, f) => { const k = (f.codes && f.codes.check) || '?'; acc[k] = (acc[k] || 0) + 1; return acc; }, {}),
  };
  return out;
}

module.exports = { run: run_, available, parseBbox, readTitleBlock, segmentDocuments, parseSheetNo, normFormat, NTD, VOLUME_LIMIT_A4, PDFTOTEXT, fold };
