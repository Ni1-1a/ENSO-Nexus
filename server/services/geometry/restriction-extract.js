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

const SYSTEM = `Ты — инженер-градостроитель. Твоя задача — СОПОСТАВИТЬ то, что нарисовано
на топосъёмке, с тем, что названо ограничением в документах, и выдать правило на каждую пару.

Работа устроена так. В блоке <site_inventory> перечислено, что РЕАЛЬНО есть на чертеже:
слои, их состав, длины и площади, а также подписи, которые дал объектам человек, — они
точнее имён слоёв и важнее их. В документах (ГПЗУ, ТЗ) названо, какие охранные зоны,
ЗОУИТ и разрывы на этом участке действуют. Твоё дело — связать одно с другим:

  слой «07_Объекты электропередачи» + «охранная зона ВЛ 10 кВ» из ГПЗУ
      → правило: 10 м от объектов этого слоя, основание ПП РФ № 160 п. 8

Иди по КАЖДОМУ инженерному слою из описи и спрашивай себя: какая охранная зона у этой
сети? Названа ли она в документах? Есть ли она в выдержках нормативной базы? Газопровод,
теплосеть, водопровод, канализация, кабель связи, ЛЭП — у каждого своя зона и свой
норматив, и одинаковой ширины у них не бывает. Слой, для которого зону найти не удалось,
запиши в missingData поимённо: «для слоя X охранная зона в документах не названа».

targetHint пиши так, чтобы приложение нашло объект: точное имя слоя из описи либо точную
подпись человека. Выдуманное уточнение не найдёт ничего, и ограничение потеряется.

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

/**
 * Правила, которые выводятся из фактов БЕЗ модели.
 *
 * Минимальный отступ от границ участка есть в любом ГПЗУ, и на боевом прогоне
 * он честно лежал в фактах — `plot.setback_m = 3 м`. А зон при этом строилось
 * ноль: локальная 30B-модель на комплекте из трёх документов возвращала то
 * пустой список, то мусор, и допустимой территорией оказывался весь участок.
 *
 * Здесь нет никакой интерпретации: отступ — это число из документа и буфер
 * внутрь от границы, то есть ровно та работа, которую и должен делать код.
 * Такие правила складываются с извлечёнными моделью, а не заменяют их.
 *
 * Расширять этот список надо осторожно: сюда попадает только то, что выражено
 * ОДНОЗНАЧНО. Охранные зоны сюда не годятся — в фактах у них площадь, а правилу
 * нужно расстояние, и вывести одно из другого нельзя.
 */
const DERIVABLE = [
  {
    match: (key) => /setback|отступ/.test(key) && !/застро|building/.test(key),
    build: (value, fact) => ({
      kind: 'setback',
      operation: 'bufferInward',
      targetSelector: 'parcelBoundary',
      targetHint: '',
      value,
      unit: 'м',
      basis: 'ГПЗУ: минимальный отступ от границ земельного участка',
      sourceDocument: fact.source || 'ГПЗУ',
      sourceClause: `факт ${fact.key}`,
      quote: `${fact.key} = ${fact.value}`,
      confidence: 0.9,
      note: 'правило выведено приложением из факта, а не сформулировано моделью',
    }),
  },
];

/** Число из значения факта: «3 м» → 3. Неправдоподобное отбрасывается движком правил. */
function factNumber(raw) {
  const m = String(raw).replace(/ /g, ' ').match(/(\d[\d\s]*(?:[.,]\d+)?)/);
  if (!m) return null;
  const n = Number(m[1].replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Сырые правила из фактов сессии — до нормализации. */
function rawRulesFromFacts(facts) {
  const out = [];
  for (const f of facts) {
    const key = String(f.key).toLowerCase();
    for (const d of DERIVABLE) {
      if (!d.match(key)) continue;
      const n = factNumber(f.value);
      if (n === null) continue;
      out.push(d.build(n, f));
      break;
    }
  }
  return out;
}

/**
 * Готовые правила из фактов проекта — БЕЗ обращения к модели.
 *
 * Вызывается ОТДЕЛЬНО от `extract`, и это принципиально: модель на большом
 * комплекте может вернуть мусор и уронить извлечение целиком, а отступ по ГПЗУ
 * от этого никуда не девается. Пока вывод из фактов жил внутри `extract`, он
 * терялся вместе с неудачным вызовом — и зон снова строилось ноль.
 */
function rulesFromFacts(sessionId) {
  const facts = db.prepare('SELECT key, value, source FROM facts WHERE session_id = ?').all(sessionId);
  const raw = rawRulesFromFacts(facts);
  if (!raw.length) return [];
  return raw.map((r, i) => rules.normalizeRule(r, i)).map((x) => x.rule).filter(Boolean);
}

/**
 * Сложить правила модели с выведенными из фактов, не задваивая одинаковые.
 * Ключ — тип, объект отсчёта и величина: два разных источника одного и того же
 * отступа дают одну зону, а не две одинаковых поверх друг друга.
 */
function mergeRules(fromModel = [], derived = []) {
  const key = (r) => `${r.kind}|${r.target && r.target.selector}|${r.valueM ?? r.value}`;
  const seen = new Set(fromModel.map(key));
  return [...fromModel, ...derived.filter((r) => !seen.has(key(r)))];
}

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
    // границы могут прийти не из чертежа, а из таблицы координат ГПЗУ — тогда
    // слоя у них нет, и «слой null» в описи только сбивает модель с толку
    const src = site.parcel.provenance.sourceLayer
      ? `слой «${site.parcel.provenance.sourceLayer}»`
      : `из документа «${site.parcel.provenance.sourceFile || 'ГПЗУ'}» по координатам характерных точек`;
    lines.push(`- Границы участка: площадь ${site.parcel.properties.areaM2} м², ` +
      `периметр ${site.parcel.properties.perimeterM} м (${src}, ` +
      `уверенность ${Math.round(site.parcel.provenance.confidence * 100)}%)`);
  } else {
    lines.push('- Границы участка: НЕ ОПРЕДЕЛЕНЫ');
  }
  /*
   * Опись объектов ОДНОГО СЛОЯ сворачивается в строку, а имя от человека
   * показывается отдельно и первым.
   *
   * Две причины. Первая: на настоящей топосъёмке 54 сети и 46 строений, и
   * перечисление их по одному съедало половину промпта одинаковыми строками
   * («слой 30_Канализация, длина 12 м» пятнадцать раз подряд) — модели от этого
   * ни холодно ни жарко, а место кончалось. Вторая и главная: слой чертежа
   * называется «07_Объекты электропередачи», и по нему не понять, десять там
   * киловольт или сто десять. Человек, глядя на план, подписывает линию
   * «ВЛ-10 кВ» — и именно эта подпись позволяет связать её с охранной зоной
   * из ГПЗУ. Раньше подписи в опись не попадали вовсе.
   */
  const group = (title, arr, unit) => {
    if (!arr.length) return;
    const named = arr.filter((o) => o.properties && o.properties.userLabel);
    const byLayer = new Map();
    for (const o of arr) {
      if (o.properties && o.properties.userLabel) continue; // названные идут отдельным списком
      const key = o.provenance.sourceLayer || 'без слоя';
      const cur = byLayer.get(key) || { n: 0, total: 0 };
      cur.n += 1;
      cur.total += Number(unit === 'м²' ? o.properties.areaM2 : o.properties.lengthM) || 0;
      byLayer.set(key, cur);
    }
    lines.push(`- ${title} (${arr.length}):`);
    for (const o of named) {
      const p = o.properties;
      const size = unit === 'м²' ? `${p.areaM2} м²` : `${p.lengthM} м`;
      lines.push(`  · НАЗВАНО ЧЕЛОВЕКОМ: «${p.userLabel}» — слой чертежа «${o.provenance.sourceLayer}», ${size}`
        + `${p.relocation === 'demolish' ? ', под снос' : ''}${p.relocation === 'move' ? ', под перенос' : ''}`
        + `${p.userComment ? `; комментарий: ${p.userComment}` : ''}`);
    }
    for (const [layer, v] of [...byLayer.entries()].sort((a, b) => b[1].total - a[1].total).slice(0, 25)) {
      lines.push(`  · слой «${layer}» — ${v.n} шт., всего ${Math.round(v.total)} ${unit}`);
    }
    if (byLayer.size > 25) lines.push(`  · …ещё слоёв: ${byLayer.size - 25}`);
  };
  group('Здания и сооружения', site.buildings, 'м²');
  group('Красные линии', site.redLines, 'м');
  group('Инженерные сети', site.utilities, 'м');
  group('Прочие существующие объекты', site.existingObjects, 'м²');

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

  /*
   * Задание формулируется ОТ ОПИСИ, а не «извлеки всё».
   *
   * Перечисленные поимённо слои превращают расплывчатое «найди ограничения» в
   * конечный список вопросов: для этого слоя зона есть? а для этого? Локальные
   * модели на общей формулировке возвращали пустой список даже там, где в ГПЗУ
   * зоны названы прямым текстом.
   */
  const utilityLayers = [...new Set((site && site.utilities || [])
    .map((o) => (o.properties && o.properties.userLabel) || o.provenance.sourceLayer)
    .filter(Boolean))];
  const checklist = utilityLayers.length
    ? '\n\nПройди по КАЖДОМУ инженерному слою участка и реши, какая у него охранная зона:\n'
      + utilityLayers.slice(0, 30).map((l) => `- ${l}`).join('\n')
      + '\nПо слою, для которого зону найти не удалось, напиши это в missingData поимённо.'
    : '';

  messages.push({
    role: 'user',
    content: 'Сопоставь объекты участка из описи с ограничениями, названными в документах, '
      + 'и выдай правило на каждую пару. Верни строго JSON по схеме. '
      + 'Помни: правило, а не координаты. Чего не хватает — в missingData.'
      + checklist + extraInstruction,
  });

  progress.set(sessionId, {
    phase: 'generating', provider: route.provider, model: adapter.resolveModel(route),
    label: 'Модель извлекает ограничения из документов…',
  });

  const call = (msgs) => adapter.structuredCall({
    system: SYSTEM,
    messages: msgs,
    sessionId,
    route,
    signal,
    schema: rules.RULES_SCHEMA,
    schemaName: 'restriction_rules',
  });

  let out = await call(messages);
  let parsed = adapter.tryParse(out.text || '');

  /*
   * Не разобралось — повторяем БЕЗ полных текстов документов.
   *
   * Живой прогон на Горбунках: комплект из ГПЗУ, ТЗ и топосъёмки вместе с описью
   * участка (46 зданий, 54 сети, 98 прочих объектов), фактами и выдержками базы
   * знаний не помещается в 32 тыс. токенов локальной модели. Промпт усекался,
   * модель отвечала мусором, и наружу шло «Ограничения не извлечены» — зон ноль,
   * допустимая территория 100 % участка, посадка на неограниченной площадке.
   *
   * Для формулировки правил полные тексты и не нужны: нужны опись объектов,
   * факты (в них названы все семь охранных зон) и нормативы из базы знаний.
   * Документы — это подтверждение, и ради него терять ограничения нельзя.
   */
  if (!parsed) {
    const lean = messages.filter((m) => typeof m.content === 'string');
    if (lean.length && lean.length < messages.length) {
      progress.set(sessionId, {
        phase: 'generating',
        label: 'Ответ не разобран — повторяю без полных текстов документов…',
      });
      out = await call([
        ...lean,
        {
          role: 'user',
          content: 'Полные тексты документов в этот запрос не вошли — они не помещаются в твой контекст. '
            + 'Опирайся на опись объектов участка, извлечённые факты и выдержки нормативной базы выше. '
            + 'Верни строго JSON по схеме, без пояснений вокруг него.',
        },
      ]);
      parsed = adapter.tryParse(out.text || '');
    }
  }

  if (!parsed) {
    throw new adapter.AiUnavailableError(
      out.truncated
        ? 'Ответ модели с ограничениями обрезан по лимиту токенов даже после повтора без текстов документов. '
          + 'Возьмите модель с бо́льшим окном контекста.'
        : 'Модель вернула неразбираемый ответ при извлечении ограничений — ни с документами, ни без них. '
          + 'Чаще всего это признак того, что модель мала для такого комплекта.',
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

module.exports = { extract, inventory, hintsInDocuments, rawRulesFromFacts, rulesFromFacts, mergeRules, factNumber, SYSTEM };
