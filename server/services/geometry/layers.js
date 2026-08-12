'use strict';
/**
 * Слои плана — ЕДИНЫЙ источник правды для всей платформы.
 *
 * Один и тот же список обслуживает четыре разных места, и раньше каждое знало
 * о слоях своё: разбор DWG угадывал тип по имени слоя (cad-geometry), модель
 * данных хранила свой перечень типов (site-geometry), человек переназначал объект
 * из третьего списка (object-edits), а чертёж писался в слои с четвёртым набором
 * имён (cad/plan-spec). Расхождение между ними и означало «переназначил в ландшафт,
 * а в DWG он остался в сетях».
 *
 * Здесь описано всё сразу: как слой называется по-русски, каким типом объекта
 * становится, по каким словам он узнаётся в чужом чертеже и в какой слой DXF
 * пишется на выгрузке.
 *
 * ВНИМАНИЕ к регуляркам: `\w` и `\b` в JavaScript кириллицу не покрывают.
 * Окончания задаются классом [а-яё], конец слова — просмотром вперёд.
 */

/**
 * Порядок важен: правила проверяются сверху вниз, первое совпадение побеждает.
 * Уточнённые правила стоят выше общих — «Границы ЗУ» опознаётся участком уверенно,
 * а одинокое «Границы» ловится последним правилом и с низкой уверенностью.
 *
 *  id          — тип объекта в модели (site-geometry.OBJECT_TYPES)
 *  label       — как слой называется человеку
 *  group       — раздел в списке переназначения
 *  bucket      — куда объект кладётся в плане (parcel — отдельное поле)
 *  dxf         — слой в выгружаемом чертеже
 *  color       — цвет слоя DXF (индекс ACI)
 *  linear      — линейный тип: не становится полигоном, даже если контур замкнут
 *  match       — по каким именам слоёв узнаётся в чужом чертеже
 *  confidence  — насколько можно верить такому распознаванию
 */
const LAYERS = [
  {
    id: 'parcel', label: 'Границы земельного участка', group: 'Границы',
    bucket: 'parcel', dxf: 'AI_ГРАНИЦЫ_ЗУ', color: 7, linear: false, confidence: 0.85,
    match: /границ[а-яё]*\s*(зу(?![а-яё])|участ|землеп)|кадастр|\bparcel\b|\bsite\b|земельн[а-яё]*\s*участ/i,
    reason: 'слой назван границей земельного участка',
  },
  {
    id: 'buildLine', label: 'Границы застройки (линия регулирования)', group: 'Границы',
    bucket: 'redLines', dxf: 'AI_ЛИНИЯ_ЗАСТРОЙКИ', color: 5, linear: true, confidence: 0.8,
    match: /лини[яи]\s*регулиров|границ[а-яё]*\s*застройк|пятн[оа]\s*застройк|build[\s_-]?line/i,
    reason: 'слой назван границей или линией регулирования застройки',
  },
  {
    id: 'redLine', label: 'Красные линии', group: 'Границы',
    bucket: 'redLines', dxf: 'AI_КРАСНЫЕ_ЛИНИИ', color: 1, linear: true, confidence: 0.85,
    match: /красн[а-яё]*\s*лини|red[\s_-]?line/i,
    reason: 'слой назван красной линией',
  },
  {
    id: 'structure', label: 'Некапитальные сооружения, навесы', group: 'Строения',
    bucket: 'buildings', dxf: 'AI_СООРУЖЕНИЯ_НЕКАПИТАЛЬНЫЕ', color: 34, linear: false, confidence: 0.7,
    match: /навес|некапитальн|временн[а-яё]*\s*сооруж|киоск|павильон|сооружени/i,
    reason: 'слой назван некапитальным сооружением',
  },
  {
    id: 'building', label: 'Капитальные строения', group: 'Строения',
    bucket: 'buildings', dxf: 'AI_ЗДАНИЯ_КАПИТАЛЬНЫЕ', color: 8, linear: false, confidence: 0.8,
    match: /здани|капитальн|корпус|строени|building/i,
    reason: 'слой назван зданием или капитальным строением',
  },
  {
    id: 'utility', label: 'Инженерные сети', group: 'Инженерия',
    bucket: 'utilities', dxf: 'AI_СЕТИ', color: 30, linear: true, confidence: 0.8,
    /*
     * Список расширен по НАСТОЯЩЕЙ топосъёмке (МСК-47_Горбунки, условные знаки
     * по классификатору): «07_Объекты электропередачи», «34_Трубопроводы
     * спецназначения», «43_Футляры и каналы», «35_Телефон» не опознавались
     * НИКАК и падали в «прочие объекты». Из-за этого ЛЭП — сеть, охранная зона
     * которой на этой площадке решает всё, — не находилась правилом с
     * targetSelector: utility, и зона от неё не строилась.
     */
    match: /сет[ие]|кабел|водопровод|канализ|газопровод|газоснаб|теплотрасс|теплосет|лэп|электропередач|электроснаб|электросет|трубопровод|коллектор|дренаж\s*ливн|телефон|телеграф|радиофикац|футляр|лини[яи]\s*связи|utility|network/i,
    reason: 'слой назван инженерной сетью',
  },
  {
    id: 'utilityStructure', label: 'Сооружения сетей: колодцы, опоры, ТП', group: 'Инженерия',
    bucket: 'utilities', dxf: 'AI_СЕТИ_СООРУЖЕНИЯ', color: 32, linear: false, confidence: 0.7,
    match: /колодц|опор[аы]?(?![а-яё])|трансформаторн|\bтп\b|камер[аы]|котельн|насосн/i,
    reason: 'слой назван сооружением инженерных сетей',
  },
  {
    id: 'road', label: 'Дороги и проезды', group: 'Транспорт',
    bucket: 'existingObjects', dxf: 'AI_ДОРОГИ_ПРОЕЗДЫ', color: 253, linear: false, confidence: 0.75,
    // поребрик и бортовой камень — край проезжей части, а не «прочий объект»
    match: /дорог|проезд|проезжая|поребрик|бортов[а-яё]*\s*камен|road|driveway/i,
    reason: 'слой назван дорогой или проездом',
  },
  {
    id: 'parking', label: 'Стоянки и парковки', group: 'Транспорт',
    bucket: 'existingObjects', dxf: 'AI_СТОЯНКИ', color: 252, linear: false, confidence: 0.75,
    match: /парковк|стоянк|машино[\s_-]?мест|parking/i,
    reason: 'слой назван стоянкой',
  },
  {
    id: 'footpath', label: 'Тротуары и пешеходные связи', group: 'Транспорт',
    bucket: 'existingObjects', dxf: 'AI_ТРОТУАРЫ', color: 251, linear: false, confidence: 0.7,
    match: /тротуар|пешеходн|дорожк|footpath|sidewalk/i,
    reason: 'слой назван тротуаром или пешеходной связью',
  },
  {
    id: 'landscaping', label: 'Благоустройство и озеленение', group: 'Ландшафт',
    bucket: 'existingObjects', dxf: 'AI_БЛАГОУСТРОЙСТВО', color: 3, linear: false, confidence: 0.7,
    match: /благоустр|озелен|газон|дерев|кустарн|клумб|растительн|landscap|green/i,
    reason: 'слой назван благоустройством или озеленением',
  },
  {
    id: 'relief', label: 'Рельеф: горизонтали, откосы, углубления, насыпи', group: 'Ландшафт',
    bucket: 'existingObjects', dxf: 'AI_РЕЛЬЕФ', color: 43, linear: true, confidence: 0.7,
    match: /рельеф|горизонтал|отметк|высотн|откос|насып|выемк|углублен|relief|contour/i,
    reason: 'слой назван рельефом',
  },
  {
    id: 'water', label: 'Водные объекты, канавы, дренаж', group: 'Ландшафт',
    bucket: 'existingObjects', dxf: 'AI_ВОДНЫЕ_ОБЪЕКТЫ', color: 4, linear: false, confidence: 0.7,
    // «Гидрография» — как этот слой называется в классификаторе топосъёмки
    match: /водоём|водоем|гидрограф|пруд|озер|рек[аи](?![а-яё])|канав|дренаж|ручей|болот/i,
    reason: 'слой назван водным объектом',
  },
  {
    id: 'fence', label: 'Ограждения и заборы', group: 'Прочее',
    bucket: 'existingObjects', dxf: 'AI_ОГРАЖДЕНИЯ', color: 9, linear: true, confidence: 0.75,
    match: /ограждени|забор|fence/i,
    reason: 'слой назван ограждением',
  },
  {
    id: 'existingObject', label: 'Прочие существующие объекты', group: 'Прочее',
    bucket: 'existingObjects', dxf: 'AI_ПРОЧИЕ_ОБЪЕКТЫ', color: 9, linear: false, confidence: 0.75,
    match: /площадк|прочи[еймх]/i,
    reason: 'слой назван существующим объектом благоустройства',
  },
  // Последнее правило: «Границы» без уточнения. Это может быть что угодно —
  // от участка до границы покрытий, поэтому уверенность низкая, а человек
  // видит в панели свойств честное «слой назван границей (без уточнения)».
  {
    id: 'parcel', label: 'Границы земельного участка', group: 'Границы', weakGuess: true,
    bucket: 'parcel', dxf: 'AI_ГРАНИЦЫ_ЗУ', color: 7, linear: false, confidence: 0.6,
    match: /границ|boundary/i,
    reason: 'слой назван границей (без уточнения)',
  },
];

/** Слои, назначаемые ЧЕЛОВЕКОМ: без дублей и без служебной «слабой догадки». */
const ASSIGNABLE = LAYERS.filter((l, i) => !l.weakGuess && LAYERS.findIndex((x) => x.id === l.id) === i);

const BY_ID = new Map(ASSIGNABLE.map((l) => [l.id, l]));

/** Расчётные слои: их строит движок, человек их не назначает. */
const COMPUTED = {
  restriction: { id: 'restriction', label: 'Зоны ограничений', dxf: 'AI_ЗОНА_ПРОЧИЕ' },
  buildable: { id: 'buildable', label: 'Допустимая территория', dxf: 'AI_ДОПУСТИМАЯ_ТЕРРИТОРИЯ' },
  footprint: { id: 'footprint', label: 'Пятно застройки', dxf: 'AI_ПЯТНО_ЗАСТРОЙКИ' },
};

/** Тип объекта по имени слоя чужого чертежа. null — не опознан. */
function classify(layerName) {
  const name = String(layerName || '');
  for (const l of LAYERS) {
    if (l.match.test(name)) {
      return { type: l.id, confidence: l.confidence, reason: l.reason, linear: !!l.linear };
    }
  }
  return null;
}

const get = (id) => BY_ID.get(id) || null;
const bucketOf = (id) => (BY_ID.get(id) ? BY_ID.get(id).bucket : 'existingObjects');
const dxfNameOf = (id) => (BY_ID.get(id) ? BY_ID.get(id).dxf : 'AI_ПРОЧИЕ_ОБЪЕКТЫ');
const isLinear = (id) => !!(BY_ID.get(id) && BY_ID.get(id).linear);
const ids = () => ASSIGNABLE.map((l) => l.id);

/** Список для интерфейса: сгруппированный, в порядке объявления. */
function forUi() {
  const groups = [];
  for (const l of ASSIGNABLE) {
    let g = groups.find((x) => x.group === l.group);
    if (!g) { g = { group: l.group, items: [] }; groups.push(g); }
    g.items.push({ id: l.id, label: l.label, dxf: l.dxf });
  }
  return groups;
}

module.exports = { LAYERS, ASSIGNABLE, COMPUTED, classify, get, bucketOf, dxfNameOf, isLinear, ids, forUi };
