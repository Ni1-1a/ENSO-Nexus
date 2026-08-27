'use strict';
/**
 * Экспорт результатов анализа ТЗ: XLSX-реестр замечаний и DOCX-заключение.
 *
 * Оба формата — zip-контейнеры с XML внутри, собираются adm-zip'ом без внешних
 * библиотек (тот же приём, что чтение DOCX в claude/memory.js и рендер
 * заключения в normo/report.js). Строки — inline: sharedStrings не нужен,
 * файл самодостаточен. Функции чистые: вход — результат прогона, выход — Buffer.
 */
const AdmZip = require('adm-zip');

const esc = (v) => String(v == null ? '' : v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  // управляющие символы недопустимы в XML 1.0 и ломают файл целиком
  // eslint-disable-next-line no-control-regex
  .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, ' ');

const DECISION_LABEL = { accepted: 'принято', rejected: 'отклонено' };

function sourceText(f) {
  const list = (f.sources && f.sources.length ? f.sources : (f.requirement_source ? [f.requirement_source] : []));
  return list.map((s) => [s.doc, s.clause, s.status ? `(${s.status})` : ''].filter(Boolean).join(', ')).join('; ');
}

/* ================= XLSX ================= */

const XLSX_COLS = [
  { label: '№', width: 8 },
  { label: 'Серьёзность', width: 16 },
  { label: 'Категория', width: 18 },
  { label: 'Пункт ЗнП', width: 22 },
  { label: 'Цитата', width: 40 },
  { label: 'Дефект', width: 52 },
  { label: 'Источник требования', width: 46 },
  { label: 'Последствие', width: 22 },
  { label: 'Предлагаемая формулировка', width: 52 },
  { label: 'Решение', width: 14 },
  { label: 'Кем / когда', width: 24 },
];

function cell(ref, text, styleId) {
  return `<c r="${ref}" s="${styleId}" t="inlineStr"><is><t xml:space="preserve">${esc(text)}</t></is></c>`;
}

const colLetter = (i) => {
  let s = '';
  for (let n = i; n >= 0; n = Math.floor(n / 26) - 1) { s = String.fromCharCode(65 + (n % 26)) + s; }
  return s;
};

/** XLSX-реестр замечаний по прогону: находки построчно, решения ГИПа живые. */
function findingsXlsx(run) {
  const result = run.result || {};
  const findings = result.findings || [];
  const rows = [];
  rows.push(`<row r="1">${XLSX_COLS.map((c, i) => cell(`${colLetter(i)}1`, c.label, 1)).join('')}</row>`);
  findings.forEach((f, idx) => {
    const r = idx + 2;
    const d = (run.decisions || {})[f.id];
    const values = [
      f.id, f.severity, f.category, f.znp_ref, f.quote || '', f.problem,
      sourceText(f), f.consequence || '', f.proposed_text || '',
      d ? (DECISION_LABEL[d.decision] || d.decision) : '',
      d ? `${d.by || ''} ${String(d.at || '').slice(0, 10)}`.trim() : '',
    ];
    rows.push(`<row r="${r}">${values.map((v, i) => cell(`${colLetter(i)}${r}`, v, 2)).join('')}</row>`);
  });

  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<cols>${XLSX_COLS.map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${c.width}" customWidth="1"/>`).join('')}</cols>
<sheetData>${rows.join('')}</sheetData>
</worksheet>`;

  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="2"><font><sz val="10"/><name val="Calibri"/></font><font><b/><sz val="10"/><name val="Calibri"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFEFEBE0"/></patternFill></fill></fills>
<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border>
<border><left style="thin"><color rgb="FFBFB8A8"/></left><right style="thin"><color rgb="FFBFB8A8"/></right><top style="thin"><color rgb="FFBFB8A8"/></top><bottom style="thin"><color rgb="FFBFB8A8"/></bottom><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="3">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
</cellXfs>
</styleSheet>`;

  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="Реестр замечаний" sheetId="1" r:id="rId1"/></sheets></workbook>`;

  const zip = new AdmZip();
  zip.addFile('[Content_Types].xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`, 'utf8'));
  zip.addFile('_rels/.rels', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`, 'utf8'));
  zip.addFile('xl/workbook.xml', Buffer.from(workbook, 'utf8'));
  zip.addFile('xl/_rels/workbook.xml.rels', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`, 'utf8'));
  zip.addFile('xl/styles.xml', Buffer.from(styles, 'utf8'));
  zip.addFile('xl/worksheets/sheet1.xml', Buffer.from(sheet, 'utf8'));
  return zip.toBuffer();
}

/* ================= DOCX ================= */

function run_(text, { bold = false } = {}) {
  return `<w:r><w:rPr>${bold ? '<w:b/>' : ''}</w:rPr><w:t xml:space="preserve">${esc(text)}</w:t></w:r>`;
}

function para(text, { bold = false, size = null, before = 0, after = 120 } = {}) {
  const sz = size ? `<w:sz w:val="${size * 2}"/><w:szCs w:val="${size * 2}"/>` : '';
  return `<w:p><w:pPr><w:spacing w:before="${before}" w:after="${after}"/></w:pPr>`
    + `<w:r><w:rPr>${bold ? '<w:b/>' : ''}${sz}</w:rPr><w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p>`;
}

const heading = (text, size = 14) => para(text, { bold: true, size, before: 260, after: 140 });

/** Абзац из нескольких прогонов: жирная метка + обычный текст. */
function labeled(label, text) {
  return `<w:p><w:pPr><w:spacing w:after="60"/></w:pPr>${run_(label + ' ', { bold: true })}${run_(text)}</w:p>`;
}

function tableXml(headerCells, rows, widths) {
  const total = widths.reduce((a, b) => a + b, 0);
  const tcPr = (w) => `<w:tcPr><w:tcW w:w="${w}" w:type="dxa"/><w:tcBorders>`
    + '<w:top w:val="single" w:sz="4" w:color="BFB8A8"/><w:left w:val="single" w:sz="4" w:color="BFB8A8"/>'
    + '<w:bottom w:val="single" w:sz="4" w:color="BFB8A8"/><w:right w:val="single" w:sz="4" w:color="BFB8A8"/>'
    + '</w:tcBorders></w:tcPr>';
  const cellXml = (text, w, bold) => `<w:tc>${tcPr(w)}<w:p><w:pPr><w:spacing w:after="0"/></w:pPr>`
    + `<w:r><w:rPr>${bold ? '<w:b/>' : ''}<w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr><w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p></w:tc>`;
  const rowXml = (cells, bold = false) => `<w:tr>${cells.map((c, i) => cellXml(c, widths[i], bold)).join('')}</w:tr>`;
  return `<w:tbl><w:tblPr><w:tblW w:w="${total}" w:type="dxa"/><w:tblLayout w:type="fixed"/></w:tblPr>`
    + rowXml(headerCells, true) + rows.map((r) => rowXml(r)).join('') + '</w:tbl>' + para('', { after: 60 });
}

/** DOCX-заключение по прогону — шаблон отчёта из спеки proverka-znp.md, §5. */
function reportDocx(run, project) {
  const result = run.result || {};
  const v = result.verdict || {};
  const object = result.object || {};
  const findings = result.findings || [];
  const decisions = run.decisions || {};
  const bySeverity = (s) => findings.filter((f) => f.severity === s);

  const body = [];
  body.push(para('Заключение по результатам проверки задания на проектирование', { bold: true, size: 16, after: 200 }));
  body.push(labeled('Объект:', `${project.name}${object.kind ? ` — ${object.kind}` : ''}`));
  body.push(labeled('Чек-лист состава:', `${object.checklist_label || ''} · финансирование: ${object.funding || 'неизвестно'} · вид работ: ${object.work_kind || 'неизвестно'}`));
  if (object.region || object.cadastral) {
    body.push(labeled('Площадка:', [object.region, object.cadastral && `КН ${object.cadastral}`].filter(Boolean).join(', ')));
  }
  body.push(labeled('Проверено:', `${String(run.finished_at || run.created_at).slice(0, 10)} · модель: ${run.provider}${run.model ? ` (${run.model})` : ''}`));
  body.push(para(result.norm_check_note || '', { after: 200 }));

  body.push(heading('1. Вердикт'));
  body.push(labeled('Готовность:', `${v.readiness_percent ?? 0} % · блокирующих: ${v.blocking_count ?? 0} · статус: ${v.status || '—'}`));
  if ((v.top_risks || []).length) {
    body.push(para('Главные риски:', { bold: true, after: 40 }));
    for (const r of v.top_risks) body.push(para(`— ${r}`, { after: 40 }));
  }

  body.push(heading('2. Сводка находок'));
  const sevCounts = ['БЛОКЕР', 'СУЩЕСТВЕННО', 'ЗАМЕЧАНИЕ', 'РЕКОМЕНДАЦИЯ'].map((s) => [s, bySeverity(s).length]);
  body.push(tableXml(['Серьёзность', 'Находок'], sevCounts.map(([s, n]) => [s, String(n)]), [3200, 1600]));

  const sections = [
    ['3. Блокирующие замечания', 'БЛОКЕР'],
    ['4. Существенные замечания', 'СУЩЕСТВЕННО'],
    ['5. Замечания', 'ЗАМЕЧАНИЕ'],
    ['6. Рекомендации', 'РЕКОМЕНДАЦИЯ'],
  ];
  for (const [title, sev] of sections) {
    const list = bySeverity(sev);
    body.push(heading(title));
    if (!list.length) { body.push(para('Нет.')); continue; }
    for (const f of list) {
      const d = decisions[f.id];
      body.push(para(`${f.id} · ${f.category} · ${f.znp_ref}`, { bold: true, before: 160, after: 40 }));
      if (f.quote) body.push(labeled('Цитата:', `«${f.quote}»`));
      body.push(labeled('Дефект:', f.problem));
      const src = sourceText(f);
      if (src) body.push(labeled('Источник требования:', src));
      if (f.consequence) body.push(labeled('Последствие:', f.consequence));
      if (f.proposed_text) body.push(labeled('Предлагаемая формулировка:', f.proposed_text));
      if (f.needs_human) body.push(labeled('Внимание:', 'находка требует проверки человеком'));
      if (d) body.push(labeled('Решение:', `${DECISION_LABEL[d.decision] || d.decision} — ${d.by || ''} ${String(d.at || '').slice(0, 10)}`));
    }
  }

  body.push(heading('7. Матрица полноты по чек-листу'));
  body.push(tableXml(
    ['Пункт состава ЗнП', 'Статус', 'Где в ЗнП', 'Комментарий'],
    (result.checklist_matrix || []).map((m) => [m.item, m.status, m.znp_ref || '—', m.note || '']),
    [4200, 1200, 1800, 2800],
  ));

  body.push(heading('8. Не удалось проверить'));
  const unv = result.unverified || [];
  if (!unv.length) body.push(para('Нет.'));
  for (const u of unv) body.push(para(`— ${u.what} (${u.why})`, { after: 60 }));

  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml">
<w:body>${body.join('')}
<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="850" w:bottom="1134" w:left="1418"/></w:sectPr>
</w:body></w:document>`;

  const zip = new AdmZip();
  zip.addFile('[Content_Types].xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`, 'utf8'));
  zip.addFile('_rels/.rels', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`, 'utf8'));
  zip.addFile('word/_rels/document.xml.rels', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`, 'utf8'));
  zip.addFile('word/styles.xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/><w:sz w:val="20"/><w:szCs w:val="20"/></w:rPr></w:rPrDefault></w:docDefaults>
</w:styles>`, 'utf8'));
  zip.addFile('word/document.xml', Buffer.from(documentXml, 'utf8'));
  return zip.toBuffer();
}

module.exports = { findingsXlsx, reportDocx };
