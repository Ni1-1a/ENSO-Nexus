'use strict';
/**
 * Рендер заключения нормоконтроля: шаблон «нормоконтроль/templates/conclusion.docx»
 * (исходная форма с плейсхолдерами {{...}}, эталон структуры — templates/conclusion.md)
 * плюс данные прогона → готовый .docx.
 *
 * Функция чистая: кроме чтения шаблона не трогает ни БД, ни файловую систему.
 */
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const config = require('../../config');

const CHECKED = '☒';
const UNCHECKED = '☐';

/** Реквизиты и дата подписи: плейсхолдер ↔ поле payload один в один. */
const TEXT_FIELDS = new Set([
  'project_name', 'stage', 'section', 'contractor',
  'author', 'check_date', 'reviewer', 'sign_date',
]);

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function lines(list) {
  if (!Array.isArray(list)) return [];
  return list.map((s) => String(s).trim()).filter((s) => s !== '');
}

/** ☒/☐ по трёхзначному value: true — «Да», false — «Нет», null — оба пустые. */
function checkboxMark(value, side) {
  if (side === 'da') return value === true ? CHECKED : UNCHECKED;
  return value === false ? CHECKED : UNCHECKED;
}

/**
 * Блок-список ({{findings}} / {{recommendations}}): пустой список — текст образца
 * («Не выявлены.» / «Нет.») в исходном параграфе; иначе — параграф на строку,
 * копия параграфа-плейсхолдера с номером в тексте («1. …», «2. …»).
 */
function renderListBlock(xml, placeholder, items, emptyText) {
  const at = xml.indexOf(placeholder);
  if (at === -1) throw new Error(`В шаблоне заключения нет ${placeholder}`);
  const start = xml.lastIndexOf('<w:p ', at);
  const end = xml.indexOf('</w:p>', at) + '</w:p>'.length;
  const para = xml.slice(start, end);
  if (!items.length) {
    return xml.slice(0, start)
      + para.replace(placeholder, () => xmlEscape(emptyText))
      + xml.slice(end);
  }
  const rendered = items.map((line, i) => para
    // paraId обязан быть уникальным на документ — у копий он опускается
    .replace(/ w14:paraId="[^"]*"/, '')
    .replace(/ w14:textId="[^"]*"/, '')
    // номер идёт текстом, нумерация Word задвоила бы его («1. 1. …»)
    .replace(/<w:numPr>.*?<\/w:numPr>/, '<w:ind w:left="360"/>')
    .replace(placeholder, () => `${i + 1}. ${xmlEscape(line)}`));
  return xml.slice(0, start) + rendered.join('') + xml.slice(end);
}

/**
 * @param {object} payload — { project_name, stage, section, contractor, author,
 *   check_date, reviewer, checks: {id: {value: true|false|null, note}},
 *   findings: [строки], recommendations: [строки],
 *   verdict_compliant, verdict_approved, sign_date }
 * @returns {Buffer} готовый .docx
 */
function renderConclusion(payload) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('renderConclusion: нет данных для заключения');
  }
  const templatePath = path.join(config.normoKbDir, 'templates', 'conclusion.docx');
  if (!fs.existsSync(templatePath)) {
    throw new Error(`Шаблон заключения не найден: ${templatePath}`);
  }
  const zip = new AdmZip(templatePath);
  const entry = zip.getEntry('word/document.xml');
  if (!entry) throw new Error(`В шаблоне нет word/document.xml: ${templatePath}`);
  let xml = entry.getData().toString('utf8');

  const checks = payload.checks || {};
  xml = xml.replace(/\{\{([a-z_]+(?::[a-z0-9_]+){0,2})\}\}/g, (whole, token) => {
    // блоки-списки подставляются последними: в их строках {{…}} — просто текст
    if (token === 'findings' || token === 'recommendations') return whole;
    const [kind, id, side] = token.split(':');
    if (kind === 'chk') {
      const value = (id === 'verdict_compliant' || id === 'verdict_approved')
        ? payload[id]
        : (checks[id] ? checks[id].value : null);
      return checkboxMark(value, side);
    }
    if (kind === 'note') {
      return xmlEscape(checks[id] && checks[id].note != null ? checks[id].note : '');
    }
    if (TEXT_FIELDS.has(token)) {
      return xmlEscape(payload[token] == null ? '' : payload[token]);
    }
    throw new Error(`Неизвестный плейсхолдер шаблона заключения: ${whole}`);
  });

  xml = renderListBlock(xml, '{{findings}}', lines(payload.findings), 'Не выявлены.');
  xml = renderListBlock(xml, '{{recommendations}}', lines(payload.recommendations), 'Нет.');

  zip.updateFile('word/document.xml', Buffer.from(xml, 'utf8'));
  return zip.toBuffer();
}

module.exports = { renderConclusion };
