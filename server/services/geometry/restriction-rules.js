'use strict';
/**
 * Правила ограничений: то, что модель извлекает из документов и нормативов.
 *
 * Ключевой принцип (ТЗ, п. 26): модель формулирует ПРАВИЛО, а не рисует зону.
 * «Охранная зона 10 м от оси ЛЭП» — правило. Полигон по нему строит движок
 * ограничений детерминированно. Поэтому здесь нет ни одной координаты.
 *
 * Всё, что можно проверить арифметикой, проверяется здесь же, без модели:
 * приведение единиц, поиск противоречий, назначение статуса.
 */

/** Типы ограничений. Список расширяем — новый тип не ломает структуру. */
const RESTRICTION_KINDS = [
  'setback',        // отступ от границы участка или красной линии
  'protectionZone', // охранная зона объекта (ЛЭП, газопровод, водопровод)
  'fireBreak',      // противопожарный разрыв
  'sanitaryZone',   // санитарно-защитная зона
  'buildLine',      // линия регулирования застройки
  'easement',       // сервитут, обременение
  'heightLimit',    // предельная высота
  'coverageLimit',  // процент застройки
  'other',
];

/**
 * Как правило превращается в геометрию. Движок ограничений умеет ровно это —
 * поэтому модель обязана выбрать одну из операций, а не описать её словами.
 */
const OPERATIONS = [
  'bufferOutward',  // полоса наружу от объекта: охранные зоны, разрывы
  'bufferInward',   // отступ внутрь от границы участка
  'attribute',      // не геометрия: высота, процент застройки
];

/** От чего отсчитывается ограничение. */
const TARGET_SELECTORS = [
  'parcelBoundary', 'redLine', 'building', 'utility',
  'existingObject', 'road', 'layer', 'objectId', 'unknown',
];

/** Статусы (ТЗ, п. 28). Назначаются детерминированно, моделью не задаются. */
const STATUSES = {
  CONFIRMED: 'confirmed',       // подтверждено документом с точной ссылкой
  HIGH: 'high',                 // вычислено с высокой уверенностью
  NEEDS_REVIEW: 'needs_review', // требует проверки человеком
  CONFLICT: 'conflict',         // противоречит другому правилу
  INSUFFICIENT: 'insufficient', // данных не хватает, геометрию не построить
};

/** Русские названия типов — то, что видит пользователь в отчёте и интерфейсе. */
const KIND_LABELS = {
  setback: 'отступ от границ',
  protectionZone: 'охранная зона',
  fireBreak: 'противопожарный разрыв',
  sanitaryZone: 'санитарно-защитная зона',
  buildLine: 'линия регулирования застройки',
  easement: 'сервитут или обременение',
  heightLimit: 'предельная высота',
  coverageLimit: 'процент застройки',
  other: 'прочее ограничение',
};

const STATUS_LABELS = {
  confirmed: 'подтверждено документом',
  high: 'высокая уверенность',
  needs_review: 'требует проверки',
  conflict: 'конфликт правил',
  insufficient: 'недостаточно данных',
};

/** Единицы длины → метры. Проценты и этажи длиной не являются. */
const LENGTH_UNITS = { m: 1, м: 1, метр: 1, метров: 1, cm: 0.01, см: 0.01, mm: 0.001, мм: 0.001, km: 1000, км: 1000 };

/**
 * JSON Schema для структурного ответа модели.
 * Намеренно строгая: пустые перечисления и свободный текст вместо enum —
 * прямой путь к правилу, которое движок не сможет исполнить.
 */
/**
 * Строгий структурный вывод у OpenAI-совместимых API требует, чтобы `required`
 * перечислял ВСЕ ключи объекта; необязательность выражается допуском null.
 * Иначе провайдер отвергает схему целиком, ещё до генерации, и ответ приходит
 * прозой — это и выглядело как «Модель вернула некорректный ответ».
 */
const RULES_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['rules', 'missingData'],
  properties: {
    rules: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'operation', 'targetSelector', 'targetHint', 'value', 'unit', 'condition',
          'appliesTo', 'basis', 'sourceDocument', 'sourceClause', 'quote', 'confidence', 'note'],
        properties: {
          kind: { type: 'string', enum: RESTRICTION_KINDS },
          operation: { type: 'string', enum: OPERATIONS },
          targetSelector: { type: 'string', enum: TARGET_SELECTORS },
          targetHint: { type: 'string', description: 'Уточнение объекта: имя слоя, тип сети, название. Пусто, если не требуется.' },
          value: { type: 'number', description: 'Числовая величина ограничения' },
          unit: { type: 'string', description: 'Единица: м, см, %, этажей' },
          condition: { type: 'string', description: 'Направление или условие применения. Пусто, если безусловно.' },
          appliesTo: { type: 'string', enum: ['newBuilding', 'anyBuilding', 'site', 'utility'] },
          basis: { type: 'string', description: 'Норматив с пунктом: «СП 4.13130.2013, таблица 4.1»' },
          sourceDocument: { type: 'string', description: 'Имя документа, откуда взято' },
          sourceClause: { type: 'string', description: 'Пункт или фрагмент документа' },
          quote: { type: 'string', description: 'Дословная цитата-основание, до 300 знаков' },
          confidence: { type: 'number', description: 'Уверенность 0…1' },
          note: { type: 'string' },
        },
      },
    },
    missingData: {
      type: 'array',
      description: 'Чего не хватило, чтобы сформулировать ограничение',
      items: { type: 'string' },
    },
  },
};

/* ---------------- нормализация ---------------- */

/**
 * Приведение сырого правила от модели к машинно-исполнимому виду.
 * Возвращает { rule } либо { rejected, reason } — молча отбрасывать нельзя,
 * пользователь должен видеть, что именно не удалось применить.
 */
function normalizeRule(raw, index = 0) {
  const reject = (reason) => ({ rejected: { raw, reason } });
  if (!raw || typeof raw !== 'object') return reject('правило не является объектом');

  const kind = RESTRICTION_KINDS.includes(raw.kind) ? raw.kind : 'other';
  const operation = OPERATIONS.includes(raw.operation) ? raw.operation : null;
  if (!operation) return reject(`неизвестная операция «${raw.operation}»`);

  const value = Number(raw.value);
  if (!Number.isFinite(value)) return reject('величина не число');
  if (value < 0) return reject('отрицательная величина ограничения');

  const unitRaw = String(raw.unit || '').trim().toLowerCase();
  let valueM = null, unit = unitRaw;
  if (operation === 'attribute') {
    // высота и процент застройки геометрией не становятся — оставляем как есть
    unit = unitRaw || '%';
  } else {
    const scale = LENGTH_UNITS[unitRaw];
    if (!scale) return reject(`единица «${raw.unit}» не является длиной, а операция геометрическая`);
    valueM = value * scale;
    unit = 'м';
    if (valueM > 1000) return reject(`величина ${valueM} м неправдоподобна для зоны ограничения`);
    if (valueM === 0) return reject('нулевая зона ограничения ничего не ограничивает');
  }

  const selector = TARGET_SELECTORS.includes(raw.targetSelector) ? raw.targetSelector : 'unknown';

  return {
    rule: {
      id: `rule-${index + 1}`,
      kind,
      operation,
      target: { selector, hint: String(raw.targetHint || '').trim() },
      value,
      unit,
      valueM,                                   // null для атрибутивных ограничений
      condition: String(raw.condition || '').trim(),
      appliesTo: raw.appliesTo || 'newBuilding',
      basis: String(raw.basis || '').trim(),
      source: {
        document: String(raw.sourceDocument || '').trim(),
        clause: String(raw.sourceClause || '').trim(),
        quote: String(raw.quote || '').trim().slice(0, 300),
      },
      confidence: Math.max(0, Math.min(1, Number(raw.confidence) || 0)),
      note: String(raw.note || '').trim(),
      status: null,                             // назначается ниже, моделью не задаётся
      statusReason: '',
    },
  };
}

/* ---------------- конфликты ---------------- */

/**
 * Два правила конфликтуют, если ограничивают одно и то же разными числами.
 * Разные величины от одного объекта — это либо ошибка извлечения, либо
 * действительно разные требования; в обоих случаях решать должен человек.
 */
function detectConflicts(rules) {
  const groups = new Map();
  for (const r of rules) {
    if (r.operation === 'attribute') continue;
    const key = `${r.kind}|${r.target.selector}|${r.target.hint.toLowerCase()}|${r.appliesTo}|${r.condition.toLowerCase()}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const conflicts = [];
  for (const [, group] of groups) {
    if (group.length < 2) continue;
    const values = [...new Set(group.map((r) => r.valueM))];
    if (values.length < 2) continue;
    const strictest = Math.max(...values);
    for (const r of group) {
      r.status = STATUSES.CONFLICT;
      const others = values.filter((v) => v !== r.valueM);
      r.statusReason = r.valueM === strictest
        ? `самое строгое из противоречащих правил (другие требуют ${others.join(', ')} м)`
        : `другое правило требует ${strictest} м вместо ${r.valueM} м от того же объекта`;
    }
    conflicts.push({
      kind: group[0].kind,
      target: group[0].target,
      values: values.sort((a, b) => a - b),
      strictestM: strictest,
      ruleIds: group.map((r) => r.id),
      message: `Для «${group[0].kind}» от одного объекта извлечены разные величины: ` +
        `${values.join(' и ')} м. Строже — ${strictest} м. Требуется решение.`,
    });
  }
  return conflicts;
}

/* ---------------- статусы ---------------- */

/**
 * Статус назначается по фактам, а не по самоощущению модели (ТЗ, п. 28):
 * есть точная ссылка на пункт и цитата — подтверждено; известен объект отсчёта
 * и уверенность высокая — высокая; объект неизвестен — данных не хватает.
 */
function assignStatus(rule) {
  if (rule.status === STATUSES.CONFLICT) return rule; // конфликт важнее прочего

  const hasBasis = !!rule.basis;
  const hasClause = !!rule.source.clause || !!rule.source.quote;
  const knownTarget = rule.target.selector !== 'unknown';

  if (!knownTarget && rule.operation !== 'attribute') {
    rule.status = STATUSES.INSUFFICIENT;
    rule.statusReason = 'не определён объект, от которого отсчитывается ограничение — геометрию построить нельзя';
  } else if (hasBasis && hasClause && rule.confidence >= 0.75) {
    rule.status = STATUSES.CONFIRMED;
    rule.statusReason = `основание указано: ${rule.basis}`;
  } else if (rule.confidence >= 0.6 && hasBasis) {
    rule.status = STATUSES.HIGH;
    rule.statusReason = 'основание указано, но без точной ссылки на пункт';
  } else {
    rule.status = STATUSES.NEEDS_REVIEW;
    rule.statusReason = hasBasis
      ? 'низкая уверенность извлечения'
      : 'не указано нормативное основание';
  }
  return rule;
}

/**
 * Полная обработка ответа модели: нормализация → конфликты → статусы.
 * Ничего не выбрасывает молча: отклонённые правила возвращаются с причиной.
 */
function processExtraction(raw) {
  const list = Array.isArray(raw && raw.rules) ? raw.rules : [];
  const rules = [];
  const rejected = [];
  list.forEach((item, i) => {
    const res = normalizeRule(item, i);
    if (res.rule) rules.push(res.rule);
    else rejected.push(res.rejected);
  });

  const conflicts = detectConflicts(rules);
  for (const r of rules) assignStatus(r);

  return {
    rules,
    rejected,
    conflicts,
    // мелкие модели любят зациклиться и выдать один и тот же пункт двадцать раз —
    // чистим дубли, иначе список нечитаем
    missingData: dedupe(Array.isArray(raw && raw.missingData) ? raw.missingData.map(String) : []).slice(0, 20),
    stats: {
      всего: rules.length,
      подтверждено: rules.filter((r) => r.status === STATUSES.CONFIRMED).length,
      высокаяУверенность: rules.filter((r) => r.status === STATUSES.HIGH).length,
      требуютПроверки: rules.filter((r) => r.status === STATUSES.NEEDS_REVIEW).length,
      конфликтов: rules.filter((r) => r.status === STATUSES.CONFLICT).length,
      недостаточноДанных: rules.filter((r) => r.status === STATUSES.INSUFFICIENT).length,
      отклонено: rejected.length,
    },
  };
}

/** Человеческое объяснение правила — то, что видит пользователь рядом с зоной. */
function dedupe(list) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const key = item.trim().toLowerCase().replace(/\s+/g, ' ');
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item.trim());
  }
  return out;
}

function explainRule(rule) {
  const parts = [];
  parts.push(`${rule.valueM !== null ? `${rule.valueM} м` : `${rule.value} ${rule.unit}`}`);
  parts.push(`от: ${TARGET_LABELS[rule.target.selector] || rule.target.selector}${rule.target.hint ? ` (${rule.target.hint})` : ''}`);
  if (rule.condition) parts.push(`условие: ${rule.condition}`);
  if (rule.basis) parts.push(`основание: ${rule.basis}`);
  if (rule.source.document) parts.push(`документ: ${rule.source.document}${rule.source.clause ? `, ${rule.source.clause}` : ''}`);
  parts.push(`статус: ${STATUS_LABELS[rule.status] || rule.status}${rule.statusReason ? ` (${rule.statusReason})` : ''}`);
  return parts.join(' → ');
}

const TARGET_LABELS = {
  parcelBoundary: 'границы участка',
  redLine: 'красной линии',
  building: 'здания',
  utility: 'инженерной сети',
  existingObject: 'существующего объекта',
  road: 'дороги',
  layer: 'объектов слоя',
  objectId: 'конкретного объекта',
  unknown: 'объект не определён',
};

module.exports = {
  RESTRICTION_KINDS, OPERATIONS, TARGET_SELECTORS, STATUSES, STATUS_LABELS, KIND_LABELS, TARGET_LABELS,
  RULES_SCHEMA, normalizeRule, detectConflicts, assignStatus, processExtraction, explainRule,
};
