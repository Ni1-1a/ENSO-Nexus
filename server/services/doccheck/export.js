'use strict';
/**
 * Экспорт результатов «Проверки документа»: XLSX-реестр находок + перечень
 * ссылок на НТД вторым листом. Сборка adm-zip'ом, как в tz/export.js.
 */
const AdmZip = require('adm-zip');

const esc = (v) => String(v == null ? '' : v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  // eslint-disable-next-line no-control-regex
  .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, ' ');

const DECISION_LABEL = { accepted: 'принято', rejected: 'отклонено' };

const FINDING_COLS = [
  { label: '№', width: 8 }, { label: 'Что не так', width: 46 }, { label: 'Где', width: 24 },
  { label: 'Цитата', width: 36 }, { label: 'Стандарт', width: 20 }, { label: 'Пункт', width: 12 },
  { label: 'Уверенность в пункте', width: 16 }, { label: 'Действие', width: 12 },
  { label: 'Тип', width: 18 }, { label: 'Решение', width: 12 }, { label: 'Кем / когда', width: 22 },
];

const REF_COLS = [
  { label: 'Шифр', width: 26 }, { label: 'Упоминаний', width: 12 }, { label: 'Статус по реестру', width: 26 },
  { label: 'Название по реестру', width: 50 }, { label: 'Первое место (строка)', width: 50 },
];

const colLetter = (i) => {
  let s = '';
  for (let n = i; n >= 0; n = Math.floor(n / 26) - 1) { s = String.fromCharCode(65 + (n % 26)) + s; }
  return s;
};

const cell = (ref, text, styleId) =>
  `<c r="${ref}" s="${styleId}" t="inlineStr"><is><t xml:space="preserve">${esc(text)}</t></is></c>`;

function sheetXml(cols, rows) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<cols>${cols.map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${c.width}" customWidth="1"/>`).join('')}</cols>
<sheetData>${rows.join('')}</sheetData>
</worksheet>`;
}

function rowsFor(cols, dataRows) {
  const out = [`<row r="1">${cols.map((c, i) => cell(`${colLetter(i)}1`, c.label, 1)).join('')}</row>`];
  dataRows.forEach((values, idx) => {
    const r = idx + 2;
    out.push(`<row r="${r}">${values.map((v, i) => cell(`${colLetter(i)}${r}`, v, 2)).join('')}</row>`);
  });
  return out;
}

/** XLSX по прогону проверки: лист находок + лист ссылок на НТД. */
function findingsXlsx(run) {
  const result = run.result || {};
  const findings = result.findings || [];
  const refs = result.ntd_refs || [];

  const findingRows = rowsFor(FINDING_COLS, findings.map((f) => {
    const d = (run.decisions || {})[f.id];
    return [
      f.id, f.what, f.where || '', f.quote || '', f.standard || '', f.clause || '',
      f.clause ? (f.clause_confidence || '') : '', f.action || '', f.kind || '',
      d ? (DECISION_LABEL[d.decision] || d.decision) : '',
      d ? `${d.by || ''} ${String(d.at || '').slice(0, 10)}`.trim() : '',
    ];
  }));

  const refRows = rowsFor(REF_COLS, refs.map((ref) => [
    ref.code, String(ref.count), ref.verdict || '',
    ref.registry ? ref.registry.title : '',
    ref.places && ref.places[0] ? `${ref.places[0].line}: ${ref.places[0].text}` : '',
  ]));

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

  const zip = new AdmZip();
  zip.addFile('[Content_Types].xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`, 'utf8'));
  zip.addFile('_rels/.rels', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`, 'utf8'));
  zip.addFile('xl/workbook.xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="Находки" sheetId="1" r:id="rId1"/><sheet name="Ссылки на НТД" sheetId="2" r:id="rId2"/></sheets></workbook>`, 'utf8'));
  zip.addFile('xl/_rels/workbook.xml.rels', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`, 'utf8'));
  zip.addFile('xl/styles.xml', Buffer.from(styles, 'utf8'));
  zip.addFile('xl/worksheets/sheet1.xml', Buffer.from(sheetXml(FINDING_COLS, findingRows), 'utf8'));
  zip.addFile('xl/worksheets/sheet2.xml', Buffer.from(sheetXml(REF_COLS, refRows), 'utf8'));
  return zip.toBuffer();
}

module.exports = { findingsXlsx };
