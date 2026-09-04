'use strict';
/**
 * Конвейер актов (АОСР): таблица данных × шаблон DOCX → пачка черновиков
 * (решение владельца от 27.08.2026, пункт 3; механика — Пособие ПТО, гл. 8–10).
 *
 * МОДЕЛЬ ЗДЕСЬ НЕ УЧАСТВУЕТ. Акты «под копирку» отличаются только данными,
 * и подстановка данных в шаблон — детерминированная операция (правило
 * платформы и приём Д5). ФИО и реквизиты не покидают контур вовсе.
 *
 * Правила конвейера из пособия:
 *   - плейсхолдер {{Имя колонки}} в шаблоне заменяется значением строки реестра;
 *   - пустая ячейка → в тексте акта остаётся «{НЕТ ДАННЫХ}», а строка попадает
 *     в отчёт пропусков — молча выдумывать значения нельзя;
 *   - плейсхолдер, которому нет колонки в реестре, — ошибка шаблона, о ней
 *     говорится до генерации, а не после пятидесяти пустых актов.
 *
 * Word дробит текст {{...}} на несколько runs — плейсхолдер ищется с XML-тегами
 * внутри и заменяется целиком (тот же приём, что в normo/report.js).
 */
const AdmZip = require('adm-zip');
const zipGuard = require('../zip-guard');

const escXml = (v) => String(v == null ? '' : v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  // eslint-disable-next-line no-control-regex
  .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, ' ');

// {{ключ}} допускает разрывы XML-тегами внутри (Word дробит runs)
const PLACEHOLDER_RE = /\{(?:<[^>]+>)*\{((?:[^{}<]|<[^>]+>)+?)\}(?:<[^>]+>)*\}/g;

function keyOf(rawInner) {
  return rawInner.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * Текст ошибки чтения шаблона по-русски. adm-zip на не-zip и битом архиве
 * бросает английскую фразу («Invalid or unsupported zip format…»), и она
 * уходила человеку как есть; zip-бомба (422 из zip-guard) и наши сообщения
 * проходят без изменений.
 */
function docxError(err) {
  if (err && (err.status === 422 || /[А-Яа-яЁё]/.test(String(err.message)))) return err.message;
  return 'Файл не читается как DOCX (не zip-контейнер)';
}

/** Zip шаблона; ошибка чтения архива сразу по-русски. */
function openDocx(templateBuffer) {
  try { return new AdmZip(templateBuffer); } catch { throw new Error('Файл не читается как DOCX (не zip-контейнер)'); }
}

/** Плейсхолдеры шаблона: уникальные ключи в порядке появления. */
function templateKeys(templateBuffer) {
  const zip = openDocx(templateBuffer);
  const entry = zip.getEntry('word/document.xml');
  if (!entry) throw new Error('Файл не читается как DOCX (нет word/document.xml)');
  const xml = zipGuard.entryData(entry, 'Шаблон DOCX').toString('utf8');
  const keys = [];
  let m;
  PLACEHOLDER_RE.lastIndex = 0;
  while ((m = PLACEHOLDER_RE.exec(xml)) !== null) {
    const key = keyOf(m[1]);
    if (key && !keys.includes(key)) keys.push(key);
  }
  return keys;
}

function fillTemplate(templateBuffer, values) {
  const zip = openDocx(templateBuffer);
  const entry = zip.getEntry('word/document.xml');
  const xml = zipGuard.entryData(entry, 'Шаблон DOCX').toString('utf8');
  const missing = [];
  const replaced = xml.replace(PLACEHOLDER_RE, (whole, inner) => {
    const key = keyOf(inner);
    const value = values[key];
    if (value === undefined || value === '') {
      missing.push(key);
      return escXml('{НЕТ ДАННЫХ}');
    }
    return escXml(value);
  });
  zip.updateFile('word/document.xml', Buffer.from(replaced, 'utf8'));
  return { buffer: zip.toBuffer(), missing };
}

/** Имя файла акта: номер из строки реестра или порядковый. */
function actFileName(row, index) {
  const no = row['Номер акта'] || row['№ акта'] || row['Номер'] || row['№'] || '';
  const safe = String(no).replace(/[\\/:*?"<>|]/g, '-').trim();
  return safe ? `АОСР ${safe}.docx` : `АОСР ${String(index + 1).padStart(3, '0')}.docx`;
}

/**
 * Пачка актов: { zip: Buffer, report } — report перечисляет пропуски по
 * каждому акту и сводку. Ошибка шаблона (нет ни одного плейсхолдера или
 * плейсхолдеры не совпадают с колонками) — исключение ДО генерации.
 */
function generateBatch(templateBuffer, table) {
  const keys = templateKeys(templateBuffer);
  if (!keys.length) {
    throw new Error('В шаблоне нет ни одного плейсхолдера {{Имя колонки}} — подставлять нечего');
  }
  const unknown = keys.filter((k) => !table.headers.includes(k));
  if (unknown.length === keys.length) {
    throw new Error(`Ни один плейсхолдер шаблона не совпал с колонками реестра. В шаблоне: ${keys.join(', ')}. В реестре: ${table.headers.join(', ')}`);
  }
  if (!table.rows.length) throw new Error('В реестре нет ни одной строки данных');

  const out = new AdmZip();
  const acts = [];
  table.rows.forEach((row, i) => {
    const { buffer, missing } = fillTemplate(templateBuffer, row);
    const name = actFileName(row, i);
    out.addFile(name, buffer);
    acts.push({ name, missing });
  });

  const withGaps = acts.filter((a) => a.missing.length);
  const reportLines = [
    'Конвейер актов — отчёт о генерации',
    `Актов сгенерировано: ${acts.length}`,
    `Плейсхолдеров в шаблоне: ${keys.length} (${keys.join(', ')})`,
    unknown.length ? `Плейсхолдеры без колонки в реестре (везде «{НЕТ ДАННЫХ}»): ${unknown.join(', ')}` : null,
    withGaps.length ? `Актов с пропусками данных: ${withGaps.length}` : 'Пропусков данных нет.',
    ...withGaps.map((a) => `— ${a.name}: нет данных для ${a.missing.join(', ')}`),
    '',
    'Каждый черновик обязан быть проверен инженером до подписи: ни одна цифра',
    'не считается верной только потому, что её подставил конвейер.',
  ].filter((l) => l !== null);
  out.addFile('ОТЧЁТ-пропуски.txt', Buffer.from(reportLines.join('\n'), 'utf8'));

  return {
    zip: out.toBuffer(),
    report: {
      total: acts.length,
      keys,
      unknownKeys: unknown,
      withGaps: withGaps.map((a) => ({ name: a.name, missing: a.missing })),
    },
  };
}

module.exports = { generateBatch, templateKeys, fillTemplate, docxError, PLACEHOLDER_RE };
