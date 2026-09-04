'use strict';
/**
 * «Порядок работы» — порядок анализа документации и подготовки ответа.
 *
 * ЭТОТ ФАЙЛ — ЕДИНСТВЕННЫЙ ИСТОЧНИК ПРАВДЫ О ШАГАХ. Список отсюда уходит и
 * в настройки («Этапы»), и в промпт модели блоком <workplan> — всегда, а не
 * только когда человек загрузил свой файл. Прежде стандартный порядок был
 * записан ещё и в системном промпте, своим перечнем; списки разошлись — в
 * настройках четырнадцать шагов (0…13), в промпте двенадцать, — и на вопрос
 * «по какой методике работает платформа» ответа не было ни у кого.
 *
 * Пользователь может скачать действующий порядок как Excel и загрузить свой.
 *
 * Excel читается/пишется без внешних библиотек: xlsx — это zip с XML (adm-zip).
 * Формат листа: колонки A=№, B=Этап, C=Содержание, D=Нормативная база/результат.
 */
const AdmZip = require('adm-zip');
const zipGuard = require('./zip-guard');

const DEFAULT_NAME = 'Стандартный порядок работы';

const DEFAULT_STEPS = [
  { n: '0', title: 'Классификация документов', detail: 'Определить тип каждого документа (ТЗ / ТХ / ГПЗУ / топосъёмка / прочее), извлечь ключевые параметры с источниками', norms: 'внутренний регламент Enso-nexus' },
  { n: '1', title: 'Границы ЗУ и красные линии', detail: 'Границы земельного участка, красные линии, поворотные точки', norms: 'ГрК РФ ст. 11, 43; СП 42.13330 п. 5.1–5.2' },
  { n: '2', title: 'Существующие объекты', detail: 'Снос / сохранение существующих объектов на участке', norms: 'ГрК РФ ст. 51' },
  { n: '3', title: 'Градостроительные отступы', detail: 'Минимальные отступы от границ ЗУ и красных линий', norms: 'ГПЗУ; СП 42.13330 п. 5.3' },
  { n: '4', title: 'Охранные зоны сетей', detail: 'Охранные зоны инженерных коммуникаций (ЛЭП, газ, тепло, вода)', norms: 'ПП РФ №160, №1021, №878' },
  { n: '5', title: 'Противопожарные разрывы', detail: 'Разрывы между зданиями по степени огнестойкости', norms: 'ФЗ-123 ст. 69; СП 4.13130 п. 6.1.2, табл. 3' },
  { n: '6', title: 'Санитарные разрывы и СЗЗ', detail: 'Санитарно-защитные зоны и санитарные разрывы', norms: 'СанПиН 2.2.1/2.1.1.1200-03; СанПиН 1.2.3685-21' },
  { n: '7', title: 'Пятно допустимой застройки', detail: 'Синтез: пересечение ограничений шагов 1–6', norms: 'результат шагов 1–6' },
  { n: '8', title: 'Варианты посадки здания', detail: 'Размещение здания в пятне, этажность/площадь отсека', norms: 'СП 56.13330; СП 2.13130 табл. 6.1' },
  { n: '9', title: 'Пожарные проезды', detail: 'Ширина ≥3,5 м при высоте ≤13 м; ≥4,2 м при 13–46 м', norms: 'СП 4.13130 разд. 8' },
  { n: '10', title: 'Пешеходные связи и МГН', detail: 'Пешеходная доступность, маломобильные группы населения', norms: 'СП 59.13330' },
  { n: '11', title: 'Стоянки и благоустройство', detail: 'Машино-места, озеленение, площадки', norms: 'СП 42.13330 п. 5.21–5.22; местные ПЗЗ' },
  { n: '12', title: 'Оформление чертежа', detail: 'Правила оформления генплана', norms: 'ГОСТ 21.508-2020; ГОСТ Р 21.101-2020' },
  { n: '13', title: 'Итоговый отчёт', detail: 'Отчёт по шагам, ТЭП, DXF-эскиз, открытые вопросы и допущения', norms: 'формат ответа сервиса' },
];

/* ---------------- xlsx: запись ---------------- */

const xmlEsc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function sheetXml(steps) {
  const header = ['№', 'Этап', 'Содержание', 'Нормативная база / результат'];
  const rows = [header, ...steps.map((s) => [s.n, s.title, s.detail || '', s.norms || ''])];
  const cols = ['A', 'B', 'C', 'D'];
  const rowsXml = rows.map((cells, ri) =>
    `<row r="${ri + 1}">` + cells.map((v, ci) =>
      `<c r="${cols[ci]}${ri + 1}" t="inlineStr"${ri === 0 ? ' s="1"' : ''}><is><t xml:space="preserve">${xmlEsc(v)}</t></is></c>`,
    ).join('') + '</row>',
  ).join('');
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<cols><col min="1" max="1" width="6" customWidth="1"/><col min="2" max="2" width="34" customWidth="1"/>' +
    '<col min="3" max="3" width="58" customWidth="1"/><col min="4" max="4" width="44" customWidth="1"/></cols>' +
    `<sheetData>${rowsXml}</sheetData></worksheet>`;
}

/** Собирает xlsx-файл пайплайна (Buffer). */
function buildXlsx(steps) {
  const zip = new AdmZip();
  const add = (p, s) => zip.addFile(p, Buffer.from(s, 'utf8'));
  add('[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
    '</Types>');
  add('_rels/.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
    '</Relationships>');
  add('xl/workbook.xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    '<sheets><sheet name="Порядок работы" sheetId="1" r:id="rId1"/></sheets></workbook>');
  add('xl/_rels/workbook.xml.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
    '</Relationships>');
  add('xl/styles.xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
    '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
    '<borders count="1"><border/></borders>' +
    '<cellStyleXfs count="1"><xf/></cellStyleXfs>' +
    '<cellXfs count="2"><xf/><xf fontId="1" applyFont="1"/></cellXfs>' +
    '</styleSheet>');
  add('xl/worksheets/sheet1.xml', sheetXml(steps));
  return zip.toBuffer();
}

/* ---------------- xlsx: чтение ---------------- */

const unEsc = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d)).replace(/&amp;/g, '&');
const stripTags = (s) => unEsc(s.replace(/<[^>]+>/g, ''));

/**
 * Разбирает первый лист xlsx в шаги пайплайна.
 * Возвращает { ok, steps } либо { ok: false, error, status? }: у zip-бомбы
 * (запись больше ZIP_ENTRY_MB, zip-guard) status 422 — маршрут отдаёт его как есть.
 */
function parseXlsx(buffer) {
  let zip;
  try { zip = new AdmZip(buffer); } catch { return { ok: false, error: 'Файл не похож на Excel (.xlsx)' }; }
  try { return parseXlsxEntries(zip); } catch (err) {
    if (err.status === 422) return { ok: false, status: 422, error: err.message };
    throw err;
  }
}

function parseXlsxEntries(zip) {
  const sheetEntry = zip.getEntries()
    .filter((e) => /^xl\/worksheets\/sheet\d+\.xml$/.test(e.entryName))
    .sort((a, b) => a.entryName.localeCompare(b.entryName))[0];
  if (!sheetEntry) return { ok: false, error: 'В файле не найден лист Excel' };

  const shared = [];
  const ss = zip.getEntry('xl/sharedStrings.xml');
  if (ss) {
    const xml = zipGuard.entryData(ss, 'Excel').toString('utf8');
    for (const m of xml.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
      const texts = [...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => unEsc(t[1]));
      shared.push(texts.join(''));
    }
  }

  const xml = zipGuard.entryData(sheetEntry, 'Excel').toString('utf8');
  const rows = [];
  for (const rm of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = {};
    for (const cm of rm[1].matchAll(/<c[^>]*?r="([A-Z]+)\d+"([^>]*)>([\s\S]*?)<\/c>/g)) {
      const col = cm[1];
      const attrs = cm[2];
      const body = cm[3];
      let value = '';
      const t = (attrs.match(/t="([^"]+)"/) || [])[1] || '';
      if (t === 's') {
        const idx = +((body.match(/<v>(\d+)<\/v>/) || [])[1] ?? -1);
        value = shared[idx] || '';
      } else if (t === 'inlineStr') {
        value = stripTags((body.match(/<is>([\s\S]*?)<\/is>/) || [, ''])[1]);
      } else {
        value = unEsc((body.match(/<v>([\s\S]*?)<\/v>/) || [, ''])[1]);
      }
      cells[col] = value.trim();
    }
    rows.push(cells);
  }

  const steps = [];
  for (const r of rows) {
    const a = r.A || '', b = r.B || '', c = r.C || '', d = r.D || '';
    if (!b && !c) continue;
    // строка заголовка
    if (/^(№|номер|шаг|этап|step)/i.test(a) || /^(этап|шаг|название|step|title)/i.test(b)) continue;
    const title = (b || c).slice(0, 200);
    if (title.length < 3) continue;
    steps.push({
      n: (a || String(steps.length + 1)).slice(0, 8),
      title,
      detail: (b ? c : '').slice(0, 500),
      norms: d.slice(0, 300),
    });
    if (steps.length >= 40) break;
  }
  if (steps.length < 2) {
    return { ok: false, error: 'Не удалось прочитать шаги: нужен лист с колонками «№ | Этап | Содержание | Нормативная база» и минимум двумя шагами' };
  }
  return { ok: true, steps };
}

/* ---------------- применение ---------------- */

/** Пайплайн сессии: пользовательский (из sessions.workplan) либо стандартный. */
function forSession(session) {
  try {
    if (session && session.workplan) {
      const wp = JSON.parse(session.workplan);
      if (wp && Array.isArray(wp.steps) && wp.steps.length >= 2) {
        return { name: wp.name || 'Пользовательский порядок работы', steps: wp.steps, isDefault: false };
      }
    }
  } catch { /* битый JSON — используем стандартный */ }
  return { name: DEFAULT_NAME, steps: DEFAULT_STEPS, isDefault: true };
}

/**
 * Текст блока <workplan> для промпта анализа.
 *
 * Блок уходит ВСЕГДА — и со стандартным порядком, и с загруженным. Раньше его
 * посылали только для пользовательского файла, а стандартный порядок был зашит
 * в системный промпт отдельным списком из двенадцати пунктов. Списков стало два,
 * они разошлись (в настройках — четырнадцать шагов, от 0 до 13), и на вопрос
 * «по какой методике работает платформа» честного ответа не было. Теперь список
 * один: тот, что человек видит в настройках, тот и уходит модели.
 */
function promptText(wp) {
  const lines = wp.steps.map((s) =>
    `${s.n}. ${s.title}${s.detail ? ` — ${s.detail}` : ''}${s.norms ? ` [${s.norms}]` : ''}`);
  const head = wp.isDefault
    ? `Порядок работы платформы («${wp.name}», шагов: ${wp.steps.length}). `
    : `Пользователь загрузил собственный порядок анализа («${wp.name}», шагов: ${wp.steps.length}). `;
  return head +
    'Выполняй разбор СТРОГО по этим шагам и в этом порядке. ' +
    'Разделы report_markdown — по этим шагам, с их номерами и названиями. ' +
    'Формат ответа (JSON-схема) не меняется.\n' + lines.join('\n');
}

module.exports = { DEFAULT_NAME, DEFAULT_STEPS, buildXlsx, parseXlsx, forSession, promptText };
