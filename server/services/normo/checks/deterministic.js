'use strict';
/**
 * Реализации детерминированных проверок. Реестр по id правила: движок прогона
 * выполняет те правила, у которых здесь есть реализация; остальные deterministic-
 * правила честно уходят в журнал прогона со skip_reason — молчаливых пропусков нет.
 *
 * Каждая реализация получает контекст версии и возвращает список находок:
 *   { location, docQuote?, wording?, fixHint? } — severity/ntd берутся из правила.
 * Пустой список = проверка прошла.
 */
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const store = require('../store');

const execFileP = promisify(execFile);

const MB = 1024 * 1024;

async function pdfPages(absPath) {
  try {
    const { stdout } = await execFileP('pdfinfo', [absPath]);
    const m = stdout.match(/^Pages:\s+(\d+)/m);
    return m ? parseInt(m[1], 10) : 0;
  } catch { return 0; }
}

/** Текст «на страницу» ниже порога — признак растрового скана. */
const TEXT_PER_PAGE_MIN = 120;

const impl = {
  // 783/пр п.4 «а», «в», «г»: без сканирования, поиск и копирование текста
  'COM-EDOC-006': async (ctx) => {
    const findings = [];
    for (const f of ctx.files) {
      if (path.extname(f.original_name).toLowerCase() !== '.pdf') continue;
      const pages = await pdfPages(store.filePath(f));
      const text = (await store.extractText(f)).trim();
      if (pages > 0 && text.length / pages < TEXT_PER_PAGE_MIN) {
        findings.push({
          location: { file: f.original_name, pages },
          docQuote: null,
          detail: `извлечено ${text.length} символов текста на ${pages} стр. — текстового слоя нет`,
        });
      }
    }
    return findings;
  },

  // 783/пр п.4 «д», «е», п.5: имя файла «Раздел ПД N…», размер ≤ 80 МБ
  'COM-EDOC-007': async (ctx) => {
    const findings = [];
    for (const f of ctx.files) {
      const problems = [];
      if (Number(f.size_bytes) > 80 * MB) {
        problems.push(`размер ${(f.size_bytes / MB).toFixed(1)} МБ превышает 80 МБ`);
      }
      if (!/раздел\s+ПД|подраздел\s+ПД/iu.test(f.original_name)) {
        problems.push('в названии файла нет слов «Раздел ПД N» / «подраздел ПД N»');
      }
      if (problems.length) {
        findings.push({ location: { file: f.original_name }, detail: problems.join('; ') });
      }
    }
    return findings;
  },

  // ГОСТ 21.002-2014 табл.1 п.1г: единая система обозначений. Частичная реализация:
  // обозначение документа, встречающееся в основных надписях (колонтитулы + поля
  // DOCPROPERTY «Код проекта»/«Раздел» СПДС-шаблонов), обязано быть одним и тем же —
  // ловит рассинхрон штампов формы 5 (титул) и формы 6 (последующие листы).
  // ВАЖНО: \b в JS не работает с кириллицей — только lookaround (см. CLAUDE.md).
  'COM-ID-001': async (ctx) => {
    const findings = [];
    const code = ctx.section.code;
    // обозначение: компоненты через дефис/тире, допускаются пробелы вокруг тире
    const desigRe = /(?<![A-ZА-ЯЁ0-9.])[A-ZА-ЯЁ][A-ZА-ЯЁ0-9.]{1,}(?:\s*[-–]\s*[A-ZА-ЯЁ0-9.]+)+(?![A-ZА-ЯЁ0-9.])/gu;
    const hasCode = new RegExp(`[-–]\\s*${code}(?![А-ЯЁA-Z0-9])`, 'u');
    for (const f of ctx.files) {
      if (path.extname(f.original_name).toLowerCase() !== '.docx') continue;
      const { properties, stampParagraphs } = store.docxStampData(store.filePath(f));
      const found = new Map(); // нормализованное обозначение → где встретилось
      const add = (raw, place) => {
        const norm = raw.replace(/\s+/g, '').replace(/–/g, '-');
        if (!found.has(norm)) found.set(norm, place);
      };
      if (properties['Код проекта'] && properties['Раздел']) {
        add(`${properties['Код проекта']}-${properties['Раздел']}`, 'свойства документа (поля штампа)');
      }
      for (const p of stampParagraphs) {
        for (const m of p.text.match(desigRe) || []) {
          if (hasCode.test(m)) add(m, p.part);
        }
      }
      if (found.size > 1) {
        const list = [...found.entries()].map(([d, place]) => `${d} (${place})`);
        findings.push({
          location: { file: f.original_name, place: 'основные надписи' },
          docQuote: [...found.keys()].join(' ↔ '),
          detail: `в основных надписях одного документа разные обозначения: ${list.join('; ')}`,
        });
      }
    }
    return findings;
  },

  // ГОСТ Р 21.101-2020 п.4.1.2: обозначение раздела содержит шифр по прил. Б
  'COM-ID-002': async (ctx) => {
    const findings = [];
    const code = ctx.section.code;
    const after = `(?![А-ЯЁA-Z0-9])`;
    for (const f of ctx.files) {
      const ext = path.extname(f.original_name).toLowerCase();
      if (!['.pdf', '.docx'].includes(ext)) continue;
      const inName = new RegExp(`[-–_ ]${code}${after}`, 'u').test(f.original_name);
      const text = await store.extractText(f);
      let inDoc = new RegExp(`[-–]\\s*${code}${after}`, 'u').test(text);
      if (!inDoc && ext === '.docx') {
        // СПДС-шаблоны держат шифр в свойстве «Раздел», в тексте его может не быть
        const { properties } = store.docxStampData(store.filePath(f));
        inDoc = properties['Раздел'] === code;
      }
      if (!inName && !inDoc) {
        findings.push({
          location: { file: f.original_name },
          detail: `ни в имени файла, ни в обозначениях внутри документа нет шифра раздела «${code}»`,
        });
      }
    }
    return findings;
  },

  // 783/пр п.2: ЛСР — машиночитаемый XML
  'SM-001': async (ctx) => {
    const xmls = ctx.files.filter((f) => path.extname(f.original_name).toLowerCase() === '.xml');
    if (!xmls.length) {
      return [{
        location: { file: '(комплект раздела)' },
        detail: 'в составе раздела СМ нет ни одного XML-файла локального сметного расчёта',
      }];
    }
    const findings = [];
    for (const f of xmls) {
      const text = await store.extractText(f);
      const root = (text.match(/<\s*([A-Za-z_][\w-]*)/) || [])[1] || '';
      if (!/estimate/i.test(root)) {
        findings.push({
          location: { file: f.original_name },
          docQuote: root ? `<${root}>` : null,
          detail: `корневой элемент «${root || '(не разобран)'}» не похож на схему LocalEstimate`,
        });
      }
    }
    return findings;
  },

  // XSD LocalEstimate: GUID расчёта
  'SM-002': async (ctx) => {
    const findings = [];
    const guidRe = /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/;
    for (const f of ctx.files) {
      if (path.extname(f.original_name).toLowerCase() !== '.xml') continue;
      const text = await store.extractText(f);
      if (!/estimate/i.test((text.match(/<\s*([A-Za-z_][\w-]*)/) || [])[1] || '')) continue;
      if (!guidRe.test(text)) {
        findings.push({
          location: { file: f.original_name },
          detail: 'в ЛСР не найден глобальный идентификатор расчёта в формате GUID (тип TGuid)',
        });
      }
    }
    return findings;
  },
};

module.exports = {
  // Версия набора реализаций входит в ключ кэша прогона: изменение кода проверок
  // обязано перепроверять уже загруженные версии, иначе кэш заморозит старое поведение.
  VERSION: 3,
  has: (ruleId) => Object.prototype.hasOwnProperty.call(impl, ruleId),
  run: (ruleId, ctx) => impl[ruleId](ctx),
  implementedIds: () => Object.keys(impl),
};
