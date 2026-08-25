'use strict';
/* Рендер заключения нормоконтроля: юнит-тесты чистой функции renderConclusion,
 * без БД и сервера. Текст из результата извлекается распаковкой adm-zip и
 * снятием тегов только из <w:t> — textutil есть не на каждой машине. */
const { test } = require('node:test');
const assert = require('node:assert');
const AdmZip = require('adm-zip');
const { renderConclusion } = require('../server/services/normo/report');

const CHECK_IDS = [
  's1_sections', 's1_title', 's1_sheets_gost', 's1_ntd_actual',
  's2_no_contradictions', 's2_grammar', 's2_terminology', 's2_data_actual',
  's3_scale', 's3_layers', 's3_spec_full', 's3_explication', 's3_isometry',
  's4_cross_sections', 's4_duplicates',
];

function fullPayload() {
  const checks = {};
  for (const id of CHECK_IDS) checks[id] = { value: true, note: '' };
  checks.s1_title = { value: false, note: 'см. замечание 1' };
  checks.s1_sheets_gost = { value: null, note: '' };
  return {
    project_name: '«Цех культуральных и эмбриональных вакцин» на территории ООО «НПП «АВИВАК»',
    stage: 'Р',
    section: 'ОВ — Отопление, вентиляция и кондиционирование',
    contractor: 'ЭНСО-Инжиниринг',
    author: 'Иванова А.А.',
    check_date: '24.08.2026',
    reviewer: 'Ельчищев Н.М.',
    checks,
    findings: [
      'Лист 3: отсутствует подпись нормоконтролёра в основной надписи',
      'Лист 7: не указан масштаб',
      'Ссылка на отменённый СНиП 2.04.05-91',
    ],
    recommendations: ['Перейти на актуальный шаблон основной надписи'],
    verdict_compliant: true,
    verdict_approved: false,
    sign_date: '25.08.2026',
  };
}

function docXml(buf) {
  const zip = new AdmZip(buf);
  const entry = zip.getEntry('word/document.xml');
  assert.ok(entry, 'в архиве нет word/document.xml');
  return entry.getData().toString('utf8');
}

function unescapeXml(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&amp;/g, '&');
}

/** Тексты параграфов по порядку (ячейка таблицы — свой параграф). */
function paragraphs(xml) {
  return xml.split('</w:p>')
    .map((seg) => [...seg.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)]
      .map((m) => unescapeXml(m[1])).join(''))
    .filter((t) => t !== '');
}

function assertBalanced(xml) {
  const stack = [];
  const re = /<(\/?)([A-Za-z0-9:._-]+)(?:"[^"]*"|'[^']*'|[^"'>])*?(\/?)>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    if (m[1]) assert.strictEqual(stack.pop(), m[2], `несбалансированный </${m[2]}>`);
    else if (!m[3]) stack.push(m[2]);
  }
  assert.deepStrictEqual(stack, [], 'остались незакрытые теги');
}

/** Индекс параграфа с точным текстом; порядок обязан расти от prev. */
function indexAfter(paras, text, prev) {
  const i = paras.indexOf(text, prev + 1);
  assert.ok(i > prev, `нет параграфа «${text}» после позиции ${prev}`);
  return i;
}

test('заполненный payload: значения, блоки 1–7 по порядку, ГОСТ исправлен, плейсхолдеров нет', () => {
  const payload = fullPayload();
  const xml = docXml(renderConclusion(payload));
  const paras = paragraphs(xml);
  const all = paras.join('\n');

  for (const value of [payload.project_name, payload.section, payload.contractor,
    payload.author, payload.reviewer]) {
    assert.ok(all.includes(value), `нет значения «${value}»`);
  }
  assert.ok(all.includes(`Стадия (П/Р): ${payload.stage}`));
  assert.ok(all.includes(`Дата проверки: ${payload.check_date}`));
  assert.ok(all.includes(`Дата: ${payload.sign_date}`));

  let at = -1;
  for (const heading of [
    '1. Общая информация',
    '2. Проверка структуры и оформления документации',
    '3. Проверка текстовой части',
    '4. Проверка графической части',
    '5. Согласованность разделов',
    '6. Итоговые замечания',
    '7. Заключение нормоконтролёра',
  ]) at = indexAfter(paras, heading, at);

  assert.ok(all.includes('Оформление листов по ГОСТ Р 21.101-2020'));
  assert.ok(!xml.includes('21.110-2013'), 'опечатка источника пролезла в рендер');
  assert.ok(!xml.includes('{{'), 'остались неподставленные плейсхолдеры');
});

test('findings из 3 строк: все три в тексте, нумерация «1.»–«3.» по порядку', () => {
  const payload = fullPayload();
  const paras = paragraphs(docXml(renderConclusion(payload)));
  let at = paras.indexOf('Замечания:');
  assert.ok(at !== -1);
  payload.findings.forEach((line, i) => {
    at = indexAfter(paras, `${i + 1}. ${line}`, at);
  });
  at = indexAfter(paras, 'Рекомендации:', at);
  indexAfter(paras, `1. ${payload.recommendations[0]}`, at);
});

test('пустые findings и recommendations: «Не выявлены.» и «Нет.» как в исходнике', () => {
  const payload = { ...fullPayload(), findings: [], recommendations: [] };
  const paras = paragraphs(docXml(renderConclusion(payload)));
  const at = indexAfter(paras, 'Не выявлены.', paras.indexOf('Замечания:'));
  indexAfter(paras, 'Нет.', at);
});

test('чекбоксы таблиц: true — ☒ раньше ☐, false — наоборот, null — оба ☐', () => {
  const paras = paragraphs(docXml(renderConclusion(fullPayload())));

  // s1_sections: value=true → «Да» отмечен
  let i = paras.indexOf('Наличие всех обязательных разделов');
  assert.ok(i !== -1);
  assert.deepStrictEqual(paras.slice(i + 1, i + 3), ['☒', '☐']);

  // s1_title: value=false → «Нет» отмечен, примечание на месте
  i = paras.indexOf('Корректность оформления титульных листов');
  assert.deepStrictEqual(paras.slice(i + 1, i + 4), ['☐', '☒', 'см. замечание 1']);

  // s1_sheets_gost: value=null → оба пустые
  i = paras.indexOf('Оформление листов по ГОСТ Р 21.101-2020');
  assert.deepStrictEqual(paras.slice(i + 1, i + 3), ['☐', '☐']);
});

test('вердикты: пунктуация исходника «☐ Да ☐Нет» с нужной галочкой', () => {
  const paras = paragraphs(docXml(renderConclusion(fullPayload())));
  assert.ok(paras.includes('Документация соответствует требованиям: ☒ Да ☐Нет'));
  assert.ok(paras.includes('Документация допущена к выпуску: ☐ Да ☒Нет'));
});

test('результат — валидный zip, word/document.xml сбалансирован, спецсимволы эскейпированы', () => {
  const payload = fullPayload();
  payload.section = 'АР & "Конструктив" <М 1:100>';
  payload.findings = ['Значение <5 & >3, см. "приложение"'];
  const buf = renderConclusion(payload);

  const xml = docXml(buf); // adm-zip открыл архив и нашёл документ
  assertBalanced(xml);
  const all = paragraphs(xml).join('\n');
  assert.ok(all.includes('АР & "Конструктив" <М 1:100>'));
  assert.ok(all.includes('1. Значение <5 & >3, см. "приложение"'));
});
