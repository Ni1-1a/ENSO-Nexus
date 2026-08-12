'use strict';
/**
 * Этапы работы над проектом и согласование прямо в ленте диалога.
 *
 * Порядок ровно такой, как его ведёт проектировщик:
 *
 *   1. анализ исходных данных            → факты
 *   2. уточняющие вопросы                → ответы человека
 *   3. объекты участка и запретные зоны  → схема
 *   4. СОГЛАСОВАНИЕ схемы в чате         → «согласовано» либо замечания
 *   5. четыре варианта посадки           → карточки вариантов
 *   6. ВЫБОР варианта в чате             → выбран либо «переделать»
 *   7. чертёж                            → DXF и DWG
 *
 * Ключевое отличие от прежнего поведения: между шагами 3–4 и 5–6 система
 * останавливается и ждёт человека. Согласование — не украшение: замечания
 * попадают в промпт следующего прогона, а не просто пишутся в переписку.
 *
 * Карточки согласования — это сообщения ленты с kind='card' и JSON в теле.
 * Клиент рисует по ним схему, метрики и кнопки; сами данные он берёт живыми
 * (план, варианты, результаты), чтобы карточка не устаревала после правок.
 */
const crypto = require('crypto');
const { db, now } = require('../db');
const RR = require('./geometry/restriction-rules');

/** Порядок этапов. Возврат назад возможен: замечания откатывают этап. */
const STAGES = [
  'idle',            // нет данных
  'analysis',        // идёт анализ исходных данных
  'questions',       // ждём ответов на уточняющие вопросы
  'zones',           // строятся объекты и зоны ограничений
  'zones_review',    // схема отправлена на согласование
  'variants',        // генерируются варианты посадки
  'variants_review', // варианты отправлены на выбор
  'drawing',         // собирается чертёж
  'done',
];

const STAGE_LABELS = {
  idle: 'Ожидает исходных данных',
  analysis: 'Анализ исходных данных',
  questions: 'Уточняющие вопросы',
  zones: 'Объекты и запретные зоны',
  zones_review: 'Согласование схемы зон',
  variants: 'Варианты посадки',
  variants_review: 'Выбор варианта',
  drawing: 'Чертёж',
  done: 'Готово',
};

/**
 * Этапы, на которых сервер что-то делает сам. Клиент по ним понимает, что
 * работа идёт, и опрашивает сервер — поэтому «рабочий» этап без выполняющейся
 * задачи оставлять нельзя: вкладка будет опрашивать сервер до закрытия
 * страницы и показывать несуществующую работу.
 */
const WORKING_STAGES = ['analysis', 'zones', 'variants', 'drawing'];

function get(sessionId) {
  const row = db.prepare('SELECT stage FROM sessions WHERE id = ?').get(sessionId);
  return (row && row.stage) || 'idle';
}

function set(sessionId, stage) {
  if (!STAGES.includes(stage)) throw new Error(`Неизвестный этап: ${stage}`);
  db.prepare('UPDATE sessions SET stage = ?, updated_at = ? WHERE id = ?').run(stage, now(), sessionId);
  return stage;
}

/** К какому этапу относится последняя карточка согласования в ленте. */
const CARD_STAGE = { zones: 'zones_review', variants: 'variants_review', drawing: 'done' };

function lastCardStage(sessionId) {
  const rows = db.prepare(
    "SELECT content FROM messages WHERE session_id = ? AND kind = 'card' ORDER BY created_at DESC, rowid DESC LIMIT 10",
  ).all(sessionId);
  for (const r of rows) {
    const card = parseCard(r.content);
    if (card && CARD_STAGE[card.card]) return CARD_STAGE[card.card];
  }
  return 'idle';
}

/**
 * Куда вернуть этап после падения, отмены или перезапуска сервера.
 *
 * Работа не выполнена, значит и этап не наступил. Возвращаемся туда, откуда
 * человек её запустил (`prevStage`), а если это неизвестно — к последней
 * карточке согласования в ленте: именно на неё он и будет смотреть.
 */
function settle(sessionId, prevStage = '') {
  const current = get(sessionId);
  if (!WORKING_STAGES.includes(current)) return current; // этап уже не рабочий — не трогаем
  if (prevStage && STAGES.includes(prevStage) && !WORKING_STAGES.includes(prevStage)) {
    return set(sessionId, prevStage);
  }
  return set(sessionId, lastCardStage(sessionId));
}

/** Замечание к этапу: уходит в промпт следующего прогона этого этапа. */
function addNote(sessionId, stage, note) {
  const text = String(note || '').trim().slice(0, 4000);
  if (!text) return null;
  const id = crypto.randomUUID();
  db.prepare('INSERT INTO stage_notes (id, session_id, stage, note, created_at) VALUES (?,?,?,?,?)')
    .run(id, sessionId, stage, text, now());
  return { id, stage, note: text };
}

function notes(sessionId, stage) {
  return db.prepare('SELECT note, created_at FROM stage_notes WHERE session_id = ? AND stage = ? ORDER BY created_at')
    .all(sessionId, stage).map((r) => r.note);
}

/** Замечания как добавка к заданию модели. Пусто — значит добавки нет. */
function notesInstruction(sessionId, stage) {
  const list = notes(sessionId, stage);
  if (!list.length) return '';
  return '\n\nЗамечания пользователя по этому этапу (учесть обязательно, они важнее общих правил):\n'
    + list.map((n, i) => `${i + 1}. ${n}`).join('\n');
}

/* ---------------- карточки согласования в ленте ---------------- */

/**
 * Карточка — сообщение ленты. В теле только тип и минимум данных: схему,
 * метрики и статусы клиент берёт живыми, иначе карточка врёт после правки.
 */
function addCard(sessionId, card, payload = {}) {
  const id = crypto.randomUUID();
  db.prepare('INSERT INTO messages (id, session_id, role, kind, content, created_at) VALUES (?,?,?,?,?,?)')
    .run(id, sessionId, 'assistant', 'card', JSON.stringify({ card, ...payload }), now());
  return id;
}

/** Разбор тела карточки. Битое тело не роняет ленту — сообщение просто скрывается. */
function parseCard(content) {
  try {
    const data = JSON.parse(content);
    return data && data.card ? data : null;
  } catch { return null; }
}

/* ---------------- требования к зданию из фактов ---------------- */

const NUM = /(\d[\d\s.,]*)/;

function toNumber(raw) {
  if (raw == null) return null;
  const m = String(raw).replace(/ /g, ' ').match(NUM);
  if (!m) return null;
  const n = Number(m[1].replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Площадь участка — для проверки правдоподобия пятна застройки.
 *
 * Берётся из ДОКУМЕНТОВ, а не из разбора чертежа, и в этом весь смысл: в таблице
 * `plans` лежит чистый разбор, а на Горбунках он даёт 72,39 м² вместо 3700 —
 * проверять правдоподобие по такому числу значило бы объявить неправдоподобным
 * любое здание. Порядок источников: заявленная площадь из фактов, затем допуск
 * из таблицы поворотных точек, и только потом разобранный контур.
 *
 * 0 — сверять не с чем (документы ещё не разобраны); проверка тогда молчит.
 */
function parcelAreaOf(sessionId, facts = null) {
  const rows = facts || db.prepare('SELECT key, value FROM facts WHERE session_id = ?').all(sessionId);
  for (const f of rows) {
    const key = String(f.key).toLowerCase();
    const hay = `${key} ${String(f.value).toLowerCase()}`;
    // «площадь застройки» — про здание, а не про участок: сюда её пускать нельзя
    if (!/(plot|parcel|участок|зу)/.test(key) || !/(area|площад)/.test(key)) continue;
    if (/застро|building|охранн|ohrann|zone|зона/.test(hay)) continue;
    const n = toNumber(f.value);
    if (n) return n;
  }
  try {
    const src = require('./geometry/parcel-source').get(sessionId);
    if (src && src.meta && Number(src.meta.declaredAreaM2) > 0) return Number(src.meta.declaredAreaM2);
  } catch { /* сервис может быть недоступен в тестах */ }
  try {
    const row = db.prepare('SELECT geometry FROM plans WHERE session_id = ? ORDER BY version DESC LIMIT 1').get(sessionId);
    if (!row) return 0;
    const site = JSON.parse(row.geometry);
    return (site && site.parcel && Number(site.parcel.properties.areaM2)) || 0;
  } catch { return 0; }
}

/**
 * Требования к зданию, вытащенные из фактов анализа.
 *
 * Требования НЕ выдумываются: если площадь застройки в исходных данных не
 * названа, возвращается null, и система спрашивает человека, а не подставляет
 * «1200 м²» от себя — иначе он получит четыре варианта под чужое здание.
 */
function requirementsFromFacts(sessionId) {
  const facts = db.prepare('SELECT key, value FROM facts WHERE session_id = ?').all(sessionId);
  const found = { areaM2: null, floors: null, width: null, length: null, sources: [] };

  /*
   * Факты о СУЩЕСТВУЮЩЕЙ застройке в требования к новому зданию не годятся.
   *
   * Живой прогон 2026-08-12: модель выдала и `object.total_area_m2 = ≤3580`
   * (проектируемый объект), и `existing_buildings_total_area_m2 = ≈529.62`
   * (то, что уже стоит на участке). Второй факт попался раньше по порядку —
   * и посадка считалась для здания 265 м² вместо 1790. Оба ключа честны;
   * различает их слово «existing», а не порядок в таблице.
   *
   * Поэтому: сначала отбрасываем всё про существующее, а среди оставшегося
   * предпочитаем факты, прямо названные объектом проектирования.
   */
  const EXISTING_RE = /existing|сущест|имеющ|снос|demolish|под\s*снос|соседн/;
  const OBJECT_RE = /^(object|объект|building|здани)/;
  const usable = facts.filter((f) => !EXISTING_RE.test(`${f.key} ${f.value}`.toLowerCase()));
  // факты об объекте проектирования идут первыми, остальные — следом
  const ordered = [
    ...usable.filter((f) => OBJECT_RE.test(String(f.key).toLowerCase())),
    ...usable.filter((f) => !OBJECT_RE.test(String(f.key).toLowerCase())),
  ];

  const pick = (test, cast) => {
    for (const f of ordered) {
      const hay = `${f.key} ${f.value}`.toLowerCase();
      if (!test(f.key.toLowerCase(), hay)) continue;
      const n = cast(f.value);
      if (n !== null) {
        found.sources.push(`${f.key} = ${f.value}`);
        return n;
      }
    }
    return null;
  };

  found.floors = pick(
    (key, hay) => /(floors|этаж)/.test(key) || /этажност/.test(hay),
    toNumber,
  );

  /*
   * ПЛОЩАДЬ ЗАСТРОЙКИ — это пятно на земле, а не сумма этажей.
   *
   * Прежнее правило ловило любой факт, где рядом стоят «объект» и «площадь», и
   * на настоящем проекте в Горбунках брало `object.total_area_m2 = 3580` —
   * общую площадь двухэтажного здания — как площадь застройки. На участке
   * 3700 м² это 97 % застройки: движок честно отвечал «здание не помещается»,
   * хотя пятно нужно вдвое меньше. Теперь одно от другого отличается явно.
   */
  const FOOTPRINT_RE = /площад[а-яё]*\s*застройки|застроенн[а-яё]*\s*площад|пятн[оа]\s*застройки|footprint|built[\s_-]?up/;
  const TOTAL_RE = /общ[а-яё]*\s*площад|суммарн[а-яё]*\s*площад|total[\s_-]?area|floor[\s_-]?area|площад[ьи]\s*(здани|объекта|помещен)/;

  const footprint = pick((key, hay) => FOOTPRINT_RE.test(key) || FOOTPRINT_RE.test(hay), toNumber);
  const totalArea = pick((key, hay) => TOTAL_RE.test(key) || TOTAL_RE.test(hay), toNumber);
  // Неоднозначный факт вроде «building.area_m2»: про здание, про площадь, но
  // какую именно — не сказано. Такой берётся пятном, как и раньше, — но только
  // если он не опознан как общая площадь. Иначе однажды снова получим 97 %
  // застройки и «здание не помещается».
  const genericArea = pick(
    (key, hay) => !TOTAL_RE.test(key) && !TOTAL_RE.test(hay)
      && ((/(building|object|застро|здани)/.test(key) && /(area|площад)/.test(key)) || /площад[ьи]\s+застройки/.test(hay)),
    toNumber,
  );

  /*
   * Неоднозначный факт про площадь здания проверяется НА ПРАВДОПОДОБИЕ.
   *
   * Модель выдала `object.area_m2 = 3580` при `object.floors = 2` — это общая
   * площадь по ТЗ, но ключ не сказал об этом ни слова, и прежнее правило брало
   * число пятном. На участке 3700 м² это 97 % застройки: движок честно отвечал
   * «ни одно положение не уместилось», хотя пятно нужно вдвое меньше. Прошлая
   * починка ловила только явное `total_area_m2` — стоило модели назвать ключ
   * иначе, и грабли возвращались.
   *
   * Проверка геометрическая, а не по имени ключа: пятно, занимающее почти весь
   * участок, пятном не бывает. Плотнее этой доли застройки не бывает даже на
   * промплощадках без отступов, а по ГПЗУ здесь ещё и отступ 3 м по периметру.
   */
  const MAX_PLAUSIBLE_COVERAGE = 0.6;
  const parcelM2 = parcelAreaOf(sessionId, facts);
  const implausible = (v) => parcelM2 > 0 && v > parcelM2 * MAX_PLAUSIBLE_COVERAGE;

  if (footprint) {
    found.areaM2 = footprint;
    // даже явная «площадь застройки» может оказаться опиской — говорим вслух
    if (implausible(footprint)) {
      found.warning = `Площадь застройки ${footprint} м² — это ${Math.round((footprint / parcelM2) * 100)} % участка `
        + `(${Math.round(parcelM2)} м²). Проверьте: обычно столько занимает ОБЩАЯ площадь здания, а не пятно.`;
      found.sources.push(found.warning);
    }
  } else if (genericArea && implausible(genericArea) && found.floors > 1) {
    // почти весь участок при этажности больше одного — это общая площадь
    found.areaM2 = Math.round((genericArea / found.floors) * 100) / 100;
    found.assumption = `Площадь ${genericArea} м² принята за ОБЩУЮ, а не за пятно застройки: пятном она заняла бы `
      + `${Math.round((genericArea / parcelM2) * 100)} % участка (${Math.round(parcelM2)} м²), чего не бывает. `
      + `Пятно = ${genericArea} м² ÷ ${found.floors} эт. = ${found.areaM2} м². `
      + 'Если площадь застройки другая, задайте её прямо.';
    found.sources.push(found.assumption);
  } else if (genericArea) {
    found.areaM2 = genericArea;
  } else if (totalArea && found.floors > 0) {
    // допущение проговаривается вслух: оно уходит в карточку требований,
    // и человек видит, откуда взялось пятно, а не только его величину
    found.areaM2 = Math.round((totalArea / found.floors) * 100) / 100;
    found.assumption = `Площадь застройки не задана: принята как общая площадь ${totalArea} м² ÷ ${found.floors} эт. = ${found.areaM2} м². ` +
      'Если этажи разной площади, задайте пятно застройки прямо.';
    found.sources.push(found.assumption);
  }
  // общая площадь без этажности пятном НЕ становится: делить не на что,
  // а выдумывать этажность нельзя — платформа обязана спросить
  found.width = pick((key) => /(building|здани).*(width|ширин)/.test(key), toNumber);
  found.length = pick((key) => /(building|здани).*(length|длин)/.test(key), toNumber);

  if (!found.areaM2 && !(found.width && found.length)) return null;
  return found;
}

/**
 * Сверка площади участка: что написано в документах против того, что разобрано
 * из чертежа.
 *
 * Это самая частая и самая дорогая ошибка исходных данных: в ГПЗУ участок
 * 3700 м², а в топосъёмке за его границу принят контур покрытия 72 м². Дальше
 * всё считается верно и всё бесполезно — «здание не помещается» вместо
 * «участок разобран неверно». Числа для сверки есть на этом шаге всегда.
 *
 * @returns {string|null} текст предупреждения для карточки согласования
 */
function parcelAreaMismatch(sessionId, site) {
  if (!site || !site.parcel || !site.parcel.properties) return null;
  const geomArea = Number(site.parcel.properties.areaM2);
  if (!Number.isFinite(geomArea) || geomArea <= 0) return null;

  const facts = db.prepare('SELECT key, value FROM facts WHERE session_id = ?').all(sessionId);
  let statedArea = null;
  let source = '';
  for (const f of facts) {
    const key = String(f.key).toLowerCase();
    const hay = `${key} ${String(f.value).toLowerCase()}`;
    const aboutParcel = /(plot|parcel|участок|зу)/.test(key);
    const aboutArea = /(area|площад)/.test(key);
    // площадь застройки — про здание, а не про участок: её сюда пускать нельзя
    if (!aboutParcel || !aboutArea || /застро|building/.test(hay)) continue;
    const n = toNumber(f.value);
    if (n && n > 0) { statedArea = n; source = `${f.key} = ${f.value}`; break; }
  }
  if (!statedArea) return null;

  const ratio = Math.max(statedArea, geomArea) / Math.min(statedArea, geomArea);
  if (ratio < 1.25) return null; // расхождение в пределах точности оцифровки

  return `Площадь участка из документов (${Math.round(statedArea)} м², ${source}) ` +
    `расходится с площадью контура, разобранного из чертежа (${Math.round(geomArea)} м²) ` +
    `в ${ratio.toFixed(1)} раза. Скорее всего, за границу участка принят не тот контур: ` +
    'проверьте схему до согласования — иначе зоны и посадка посчитаны для чужой территории.';
}

/* ---------------- что стоит указать вручную ---------------- */

/**
 * Подсказка в карточку согласования: чего платформа знать не может и что
 * закрывается одним указанием человека на плане.
 *
 * Зачем отдельным списком. Всё это и раньше было в карточке — но россыпью:
 * причина непостроенной зоны в «не построено», решение о сносе не написано
 * нигде, а последствие видно только числом допустимой территории. Живой прогон
 * 2026-08-12: без двух указаний территория выходила 286,6 м² (7,7 % участка),
 * с ними — 1581,66 м² (42,7 %). Разница в пять с половиной раз пряталась в
 * строчке «Не построено «protectionZone»: уточнение не совпало».
 *
 * Каждый пункт несёт ЧИСЛО: сколько метров вернёт указание. Совет без цены
 * человек пролистывает, совет с ценой — выполняет.
 *
 * @param {object} site   план с уже построенными зонами
 * @param {object} built  результат restriction-engine.build
 * @returns {Array<{kind, text, objectIds, gainM2}>}
 */
function manualHints(site, built = {}) {
  const hints = [];
  if (!site) return hints;
  const round = (n) => Math.round(n * 100) / 100;
  // зоны берём из СВЕЖЕГО расчёта: в site могут лежать зоны прошлого прогона,
  // и подсказка считала бы цену по устаревшим числам
  const zones = built.restrictions || site.restrictions || [];

  /*
   * 1. Правило, объект отсчёта которого не опознан. Модель пишет уточнение
   * вроде «Сети ЛЭП 10кВ», а слой на чертеже зовётся «07_Объекты
   * электропередачи» — зона не строится вовсе, и ограничение просто теряется.
   */
  for (const u of built.unresolved || []) {
    if (!/не совпало ни с одним слоем/.test(String(u.reason))) continue;
    const hint = (u.rule && u.rule.target && u.rule.target.hint) || '';
    hints.push({
      kind: 'label-object',
      text: `Подпишите на плане объект, к которому относится «${hint}» — правило «`
        + `${RR.KIND_LABELS[u.kind] || u.kind}» его не нашло, и зона не построена. `
        + 'Клик по линии на плане → «Что это на самом деле» и название.',
      objectIds: [],
      gainM2: null,
    });
  }

  /*
   * 2. Существующие строения без решения о сносе. Пока решения нет, они
   * считаются существующими и дают противопожарные разрывы — а разрыв от
   * здания, которое сносят, съедает то самое место, которое снос освобождает.
   */
  const undecided = (site.buildings || []).filter((b) => {
    const rel = b.properties && b.properties.relocation;
    return !rel || rel === 'undecided';
  });
  const fireZones = zones.filter((z) => z.properties.kind === 'fireBreak');
  if (undecided.length && fireZones.length) {
    const areaM2 = round(fireZones.reduce((s, z) => s + (z.properties.areaM2 || 0), 0));
    hints.push({
      kind: 'demolish-or-keep',
      text: `Решите по существующим строениям: снос или сохранение (${undecided.length} шт. без решения). `
        + `Сейчас они считаются существующими и дают противопожарные разрывы на ${areaM2} м² — `
        + 'разрыв от здания, которое сносят, съедает место, которое снос и освобождает. '
        + 'Клик по строению на плане → «Что с ним делать».',
      objectIds: undecided.slice(0, 40).map((b) => b.id),
      gainM2: areaM2,
    });
  }

  /*
   * 3. Зона, построенная от ВСЕХ объектов слоя, когда их там много. Формально
   * правило исполнено, но охранная зона «от всех сетей» почти всегда означает,
   * что различить их было нечем: у канализации и ЛЭП разная ширина зоны.
   */
  for (const z of zones) {
    const layers = [...new Set((z.properties.targets || []).map((t) => t.layer).filter(Boolean))];
    if (layers.length < 3) continue;
    hints.push({
      kind: 'narrow-target',
      text: `Зона «${RR.KIND_LABELS[z.properties.kind] || z.properties.kind}» ${z.properties.valueM} м `
        + `построена сразу от ${layers.length} слоёв (${layers.slice(0, 3).join(', ')}…) на ${z.properties.areaM2} м². `
        + 'У разных сетей ширина зоны разная — подпишите те линии, к которым правило относится на самом деле.',
      objectIds: [],
      gainM2: z.properties.areaM2,
    });
  }

  /*
   * 4. Границы участка, взятые разбором чертежа с низкой уверенностью. На этом
   * стоит вся арифметика: площади, зоны, посадка.
   */
  const p = site.parcel;
  if (p && p.provenance && p.provenance.extractionMethod === 'cad-vector'
      && (p.provenance.confidence || 0) < 0.7) {
    hints.push({
      kind: 'confirm-parcel',
      text: `Подтвердите границы участка: контур ${p.properties.areaM2} м² взят со слоя `
        + `«${p.provenance.sourceLayer}» с уверенностью ${Math.round((p.provenance.confidence || 0) * 100)} %. `
        + 'На нём стоят все площади, зоны и посадка. Если контур не тот — назначьте участком нужный на плане.',
      objectIds: [p.id],
      gainM2: null,
    });
  }

  return hints;
}

/* ---------------- сводки для карточек ---------------- */


/** Короткая сводка по зонам: что построено, сколько и на каком основании. */
function zonesSummary(site) {
  const byKind = new Map();
  for (const z of site.restrictions || []) {
    const kind = (z.properties && z.properties.kind) || 'other';
    const cur = byKind.get(kind) || { kind, label: RR.KIND_LABELS[kind] || kind, count: 0, areaM2: 0, statuses: new Set() };
    cur.count += 1;
    cur.areaM2 += Number(z.properties && z.properties.areaM2) || 0;
    if (z.properties && z.properties.statusLabel) cur.statuses.add(z.properties.statusLabel);
    byKind.set(kind, cur);
  }
  return [...byKind.values()].map((z) => ({
    kind: z.kind, label: z.label, count: z.count,
    areaM2: Math.round(z.areaM2), statuses: [...z.statuses],
  }));
}

module.exports = {
  STAGES, STAGE_LABELS, WORKING_STAGES,
  get, set, settle, lastCardStage, addNote, notes, notesInstruction,
  addCard, parseCard, requirementsFromFacts, zonesSummary, parcelAreaMismatch, manualHints,
};
