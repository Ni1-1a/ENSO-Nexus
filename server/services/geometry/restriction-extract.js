'use strict';
/**
 * Извлечение ограничений из документов (ТЗ, п. 25–26).
 *
 * Модель получает опись объектов участка и сами документы, а возвращает ПРАВИЛА:
 * тип, объект отсчёта, величину, единицу, условие, основание, источник, уверенность.
 * Координат она не видит и не выдаёт — их считает движок ограничений.
 *
 * Опись намеренно без координат: модели незачем знать, где вершина полилинии.
 * Ей нужно знать, что на участке есть ЛЭП со слоя «Сети ЛЭП 10кВ» — и найти
 * в нормативах, какая у неё охранная зона.
 */
const adapter = require('../claude/adapter');
const { buildDocumentBlocks } = require('../claude/memory');
const registry = require('../ai/registry');
const rules = require('./restriction-rules');
const progress = require('../progress');
const { db } = require('../../db');

const SYSTEM = `Ты — инженер-градостроитель. Твоя задача — извлечь из документов и нормативов
ОГРАНИЧЕНИЯ, действующие на земельном участке.

ГЛАВНОЕ ПРАВИЛО: ты формулируешь ПРАВИЛО, а не рисуешь зону.
Правильно: «охранная зона 10 м от оси ЛЭП, основание — ПП РФ № 160, п. 8».
Неправильно: перечислять координаты полигона. Координаты и полигоны считает
геометрический движок приложения, тебе их выдавать запрещено.

Для каждого ограничения укажи:
- kind — тип ограничения;
- operation — bufferOutward (полоса наружу от объекта), bufferInward (отступ внутрь
  от границы участка) или attribute (не геометрия: высота, процент застройки);
- targetSelector — от чего отсчитывается; targetHint — уточнение (имя слоя, тип сети);
- value и unit — величину и единицу ровно так, как в нормативе;
- condition — направление или условие, если оно есть;
- basis — норматив с пунктом или таблицей;
- sourceDocument, sourceClause, quote — откуда именно взято, с дословной цитатой;
- confidence — насколько ты уверен (0…1).

ЗАПРЕЩЕНО придумывать нормативы, пункты и цитаты. Если величина в документах не
названа и в базе знаний её нет — не выдумывай правило, а запиши недостающее в
missingData. Отсутствующее ограничение честнее выдуманного: по выдуманному
построят зону и посадят здание.

Не дублируй одно ограничение несколькими правилами. Если для одного объекта в
разных документах разные величины — выдай оба правила с их источниками,
приложение само пометит это конфликтом. В missingData тоже не повторяйся:
каждый пункт пишется один раз.

ВАЖНО: если величина НАЗВАНА в документе — обязательно выдай по ней правило.
В missingData попадает только то, чего в документах действительно нет.

Пример правильного правила для фразы «охранная зона ВЛ 10 кВ — 10 метров по обе
стороны от крайних проводов (ПП РФ № 160, п. 8)», когда на участке есть слой
«Сети ЛЭП 10кВ»:
{"kind":"protectionZone","operation":"bufferOutward","targetSelector":"utility",
 "targetHint":"Сети ЛЭП 10кВ","value":10,"unit":"м","condition":"по обе стороны",
 "appliesTo":"newBuilding","basis":"ПП РФ № 160, п. 8","sourceDocument":"ГПЗУ.txt",
 "sourceClause":"3.4","quote":"Охранная зона ВЛ 10 кВ составляет 10 метров","confidence":0.9}

Пример для предельной высоты 20 м: operation "attribute", kind "heightLimit",
targetSelector "unknown", unit "м".`;

/**
 * Формулировки, за которыми почти всегда стоит ограничение. Нужны не для того,
 * чтобы что-то придумать за модель, а чтобы поймать её молчание: если в документах
 * такое есть, а правил ноль — это подозрительно, и стоит переспросить.
 */
const HINT_PATTERNS = [
  { re: /охранн\w*\s+зон\w*/gi, label: 'охранная зона' },
  // ключи фактов приходят латиницей («plot.area_ohrannaya_lip») — по-русски
  // такое не ловится, а именно в них на боевом прогоне и жили все семь зон
  { re: /ohrann\w*/gi, label: 'охранная зона (в фактах)' },
  { re: /zone_flood|подтоплен/gi, label: 'зона подтопления' },
  { re: /санитарн\w*[- ]защитн\w*\s+зон\w*|\bсзз\b/gi, label: 'санитарно-защитная зона' },
  { re: /противопожарн\w*\s+(разрыв|расстояни)\w*/gi, label: 'противопожарный разрыв' },
  { re: /минимальн\w*\s+отступ\w*|отступ\w*\s+от\s+границ/gi, label: 'отступ от границ' },
  { re: /красн\w*\s+лини\w*/gi, label: 'красная линия' },
  { re: /предельн\w*\s+(высот|количество\s+этаж)\w*/gi, label: 'предельная высота' },
  { re: /процент\w*\s+застройки|коэффициент\s+застройки/gi, label: 'процент застройки' },
  { re: /зоуит|сервитут|обременени\w*/gi, label: 'ЗОУИТ или обременение' },
];

/** Какие признаки ограничений встречаются в переданных документах. */
function hintsInDocuments(text) {
  const found = [];
  for (const { re, label } of HINT_PATTERNS) {
    const m = String(text).match(re);
    if (m && m.length) found.push(`${label} (${m.length} упом.)`);
  }
  return found;
}

/** Опись объектов участка для модели: типы, слои, размеры. Без координат. */
function inventory(site) {
  if (!site) return 'Геометрия участка не разобрана.';
  const lines = [];
  if (site.parcel) {
    lines.push(`- Границы участка: площадь ${site.parcel.properties.areaM2} м², ` +
      `периметр ${site.parcel.properties.perimeterM} м (слой «${site.parcel.provenance.sourceLayer}», ` +
      `уверенность ${Math.round(site.parcel.provenance.confidence * 100)}%)`);
  } else {
    lines.push('- Границы участка: НЕ ОПРЕДЕЛЕНЫ');
  }
  const group = (title, arr, fmt) => {
    if (!arr.length) return;
    lines.push(`- ${title} (${arr.length}):`);
    for (const o of arr.slice(0, 40)) lines.push(`  · ${fmt(o)}`);
    if (arr.length > 40) lines.push(`  · …ещё ${arr.length - 40}`);
  };
  group('Здания и сооружения', site.buildings,
    (o) => `слой «${o.provenance.sourceLayer}», площадь ${o.properties.areaM2} м²`);
  group('Красные линии', site.redLines,
    (o) => `слой «${o.provenance.sourceLayer}», длина ${o.properties.lengthM} м`);
  group('Инженерные сети', site.utilities,
    (o) => `слой «${o.provenance.sourceLayer}», длина ${o.properties.lengthM} м`);
  group('Прочие существующие объекты', site.existingObjects,
    (o) => `слой «${o.provenance.sourceLayer}»${o.properties.areaM2 ? `, площадь ${o.properties.areaM2} м²` : ''}` +
      `${o.properties.typeResolved === false ? ' — тип не определён' : ''}`);

  if (site.warnings.length) {
    lines.push('- Предупреждения разбора чертежа:');
    for (const w of site.warnings) lines.push(`  · ${w.message}`);
  }
  return lines.join('\n');
}

/**
 * Один проход извлечения.
 * @param {string} sessionId
 * @param {object} opts {site, route, signal}
 * @returns результат processExtraction + сырой ответ модели
 */
async function extract(sessionId, { site, route, signal = null, extraInstruction = '' }) {
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
  adapter.checkBudget(session);

  progress.set(sessionId, {
    phase: 'preparing', provider: route.provider, model: adapter.resolveModel(route),
    label: 'Подготовка документов для извлечения ограничений…',
  });

  const docMode = registry.documentMode(route);
  const { blocks, manifest } = await buildDocumentBlocks(sessionId, docMode);

  const messages = [];
  messages.push({ role: 'user', content: `<site_inventory>\n${inventory(site)}\n</site_inventory>` });

  /*
   * Факты анализа уходят в извлечение ограничений.
   *
   * Живой прогон на Горбунках: анализ нашёл `plot.area_ohrannaya_lip = 1058`,
   * `..._teploset = 300`, `..._kanalizaciya = 479` и ещё четыре — то есть
   * охранные зоны в документах названы прямо. А извлечение ограничений,
   * работавшее с теми же документами, вернуло НОЛЬ правил, и допустимая
   * территория вышла в 100 % участка. Модель уже сделала половину работы;
   * не показать ей собственную находку — значит заставить искать заново по
   * конспекту, где строчка про зону могла и не уцелеть.
   */
  const factRows = db.prepare('SELECT key, value, source FROM facts WHERE session_id = ? ORDER BY key').all(sessionId);
  if (factRows.length) {
    const lines = factRows.map((f) => `- ${f.key} = ${f.value}${f.source ? ` [${f.source}]` : ''}`);
    messages.push({
      role: 'user',
      content: '<extracted_facts>\nФакты, уже извлечённые из этих документов на предыдущем шаге. '
        + 'Если среди них есть охранная зона, разрыв, отступ или ЗОУИТ — по КАЖДОМУ обязано быть правило. '
        + 'Величины бери из документа или из базы знаний, а не из этих чисел: здесь площади зон, '
        + 'а правилу нужен отступ в метрах.\n' + lines.join('\n') + '\n</extracted_facts>',
    });
  }

  if (manifest.length) {
    messages.push({ role: 'user', content: `<uploaded_files>\n${manifest.join('\n')}\n</uploaded_files>` });
  }
  if (blocks.length) messages.push({ role: 'user', content: blocks });

  // выдержки из базы знаний по фактически найденным объектам
  try {
    progress.set(sessionId, { phase: 'retrieving', label: 'Поиск нормативов по найденным объектам…' });
    const kb = require('../kb');
    const query = [
      'охранная зона санитарный разрыв противопожарное расстояние отступ от границы',
      ...(site ? site.utilities.map((u) => u.provenance.sourceLayer) : []),
      ...(site ? site.buildings.map((b) => b.provenance.sourceLayer) : []),
    ].join(' ').slice(0, 1500);
    const excerpts = await kb.excerptsFor(query, (session && session.kb_choice) || 'main');
    if (excerpts) messages.push({ role: 'user', content: `<knowledge_base>\n${excerpts}\n</knowledge_base>` });
  } catch (err) {
    console.warn('[restrictions] выдержки базы знаний пропущены:', err.message);
  }

  messages.push({
    role: 'user',
    content: 'Извлеки все ограничения, действующие на этом участке. Верни строго JSON по схеме. ' +
      'Помни: правило, а не координаты. Чего не хватает — в missingData.' + extraInstruction,
  });

  progress.set(sessionId, {
    phase: 'generating', provider: route.provider, model: adapter.resolveModel(route),
    label: 'Модель извлекает ограничения из документов…',
  });

  const out = await adapter.structuredCall({
    system: SYSTEM,
    messages,
    sessionId,
    route,
    signal,
    schema: rules.RULES_SCHEMA,
    schemaName: 'restriction_rules',
  });

  let parsed = adapter.tryParse(out.text || '');
  if (!parsed) {
    throw new adapter.AiUnavailableError(
      out.truncated
        ? 'Ответ модели с ограничениями обрезан по лимиту токенов. Повторите или уменьшите объём документов.'
        : 'Модель вернула неразбираемый ответ при извлечении ограничений.',
    );
  }

  // Пусто, хотя в документах явно есть формулировки ограничений — переспрашиваем
  // один раз, прямо называя найденное. Мелкие модели часто «сдаются» на первом
  // проходе, но по конкретной наводке отвечают.
  //
  // Наводки ищутся и в ФАКТАХ тоже: на Горбунках конспект документов до
  // извлечения дошёл без слова «охранная», а в фактах их было семь штук —
  // и молчание модели выглядело законным «ограничений нет».
  const docText = blocks.map((b) => b.text || '').join('\n')
    + '\n' + factRows.map((f) => `${f.key} ${f.value}`).join('\n');
  const hints = hintsInDocuments(docText);
  if ((!parsed.rules || !parsed.rules.length) && hints.length) {
    progress.set(sessionId, { phase: 'generating', label: 'Ограничений не найдено — уточняющий повторный запрос…' });
    const retry = await adapter.structuredCall({
      system: SYSTEM,
      messages: [
        ...messages,
        { role: 'assistant', content: JSON.stringify(parsed) },
        {
          role: 'user',
          content: 'Ты вернул пустой список, но в переданных документах встречаются формулировки: '
            + hints.join('; ') + '. Перечитай документы и выдай правило по КАЖДОЙ найденной величине. '
            + 'Если какая-то величина в тексте не названа числом — только тогда запиши её в missingData.',
        },
      ],
      sessionId, route, signal,
      schema: rules.RULES_SCHEMA,
      schemaName: 'restriction_rules',
    });
    const second = adapter.tryParse(retry.text || '');
    if (second && Array.isArray(second.rules) && second.rules.length) parsed = second;
  }

  const result = rules.processExtraction(parsed);
  // Молчание модели не должно выглядеть как «ограничений нет».
  if (!result.rules.length && hints.length) {
    result.missingData.unshift(
      'Модель не извлекла ни одного ограничения, хотя в документах встречаются: ' + hints.join('; ')
      + '. Проверьте документы вручную или выберите более сильную модель.',
    );
  }
  progress.set(sessionId, {
    phase: 'validating',
    label: `Ограничений извлечено: ${result.stats.всего}, требуют проверки: ${result.stats.требуютПроверки}`,
  });
  return result;
}

module.exports = { extract, inventory, hintsInDocuments, SYSTEM };
