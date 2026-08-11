'use strict';
/**
 * Что сделать, когда здание не помещается.
 *
 * Прежде движок в этом случае отвечал одной фразой: «Здание не помещается:
 * нужно 1700 м² застройки, а свободно от ограничений всего 72.39 м². Уменьшите
 * площадь застройки, поднимите этажность или пересмотрите ограничения». Три
 * совета без единого числа: насколько уменьшить, до скольких этажей поднять,
 * какое ограничение пересматривать — человек должен был выяснить сам.
 *
 * Между тем всё это считается. Здесь и считается:
 *   — сколько этажей нужно, чтобы пятно уложилось в свободное место;
 *   — какое пятно вообще влезает на эту площадку;
 *   — сколько квадратных метров вернёт снятие КАЖДОГО ограничения по
 *     отдельности (допустимая территория пересчитывается без него).
 *
 * Ни одного обращения к модели: те же входные данные дают тот же ответ. Модель
 * может пересказать эти числа словами, но придумать их права не имеет —
 * снятие охранной зоны ВЛ-10 кВ стоит денег и согласований, и цифра, на
 * которую человек будет опираться, обязана быть посчитанной.
 */
const jts = require('./jts');
const G = require('./site-geometry');
const RR = require('./restriction-rules');

/** Мельче этого прирост территории не стоит упоминания: шум округления. */
const MIN_GAIN_M2 = 5;

/**
 * ЧЕМ снимается ограничение каждого типа — и снимается ли вообще.
 *
 * Освободить метры и получить право их застроить — разные вещи. Отступ по ГПЗУ
 * «снять» нельзя: это внесение изменений в градостроительный план, а не решение
 * проектировщика. Охранная зона ЛЭП снимается выносом линии — дорого, долго, но
 * выполнимо силами проекта. Без этой пометки список мероприятий предлагал бы
 * «убрать отступ 3 м» так же буднично, как «поднять этажность», а это неправда.
 */
const HOW_TO_LIFT = {
  setback: 'снимается только внесением изменений в ГПЗУ — решением проектировщика отступ не отменяется',
  buildLine: 'снимается только изменением документации по планировке территории',
  protectionZone: 'снимается выносом сети из пятна застройки: проект переустройства и согласование с владельцем сети',
  fireBreak: 'снимается сносом соседнего объекта либо повышением степени огнестойкости — расстояние пересчитывается по СП 4.13130',
  sanitaryZone: 'снимается изменением класса опасности производства или проектом сокращения СЗЗ с расчётом рассеивания',
  easement: 'снимается прекращением сервитута — решение правообладателя, не проектировщика',
  heightLimit: 'не геометрическое ограничение: снимается изменением ГПЗУ',
  coverageLimit: 'не геометрическое ограничение: снимается изменением ГПЗУ',
};
/** Больше этого числа мероприятий список перестаёт читаться. */
const MAX_MEASURES = 8;
/**
 * Выше этой этажности совет «поднять этажность» перестаёт быть советом.
 * Производственный корпус, склад, цех — это один-четыре этажа; предлагать
 * пятнадцать значит признаваться, что мероприятие подобрано арифметикой,
 * а не инженерией. Порог намеренно щедрый: пять этажей ещё бывают.
 */
const MAX_REASONABLE_FLOORS = 5;

const round = (n) => G.round(n, 2);

/**
 * Короткая подпись зоны для списка мероприятий: величина и от чего отсчитана.
 * Слой берётся у объекта, от которого зона построена, — «10 м от ЛЭП» человек
 * узнаёт на плане, а «bufferOutward по правилу r-3» не узнаёт никто.
 */
function shortLabel(props) {
  const bits = [];
  if (props.valueM) bits.push(`${props.valueM} м`);
  const layers = [...new Set((props.targets || []).map((t) => t.layer).filter(Boolean))];
  if (layers.length) bits.push(`от «${layers.slice(0, 2).join('», «')}»${layers.length > 2 ? ` и ещё ${layers.length - 2}` : ''}`);
  return bits.join(' ');
}

/**
 * Насколько выросла бы допустимая территория без каждой из зон.
 *
 * Считается ЧЕСТНО: территория пересобирается без одной зоны, а не берётся её
 * собственная площадь. Разница принципиальна — зоны накладываются друг на друга,
 * и охранная зона, целиком лежащая внутри противопожарного разрыва, не даёт
 * при снятии ни одного метра. Собственная площадь обещала бы сотни.
 */
function gainsByZone(parcelGeom, restrictions) {
  const parcel = jts.toJts(parcelGeom);
  if (!parcel) return [];
  const zones = restrictions
    .map((z) => ({ z, geom: jts.toJts(z.geometry) }))
    .filter((x) => x.geom);
  if (!zones.length) return [];

  const baseline = jts.difference(parcel, jts.union(zones.map((x) => x.geom)));
  const baseArea = baseline ? jts.area(baseline) : 0;

  const out = [];
  for (let i = 0; i < zones.length; i++) {
    const rest = zones.filter((_, j) => j !== i).map((x) => x.geom);
    const without = rest.length ? jts.difference(parcel, jts.union(rest)) : parcel;
    const gain = (without ? jts.area(without) : 0) - baseArea;
    if (gain < MIN_GAIN_M2) continue;
    const p = zones[i].z.properties || {};
    const pr = zones[i].z.provenance || {};
    out.push({
      zoneId: zones[i].z.id,
      kind: p.kind || 'other',
      kindLabel: RR.KIND_LABELS[p.kind] || 'ограничение',
      // Короткая подпись «10 м от слоя ЛЭП», а не полное объяснение правила:
      // provenance.reason — это разбор для журнала, в списке мероприятий он
      // занимает три строки и топит собой само мероприятие.
      label: shortLabel(p),
      basis: pr.basis || p.basis || '',
      gainM2: round(gain),
      status: p.statusLabel || '',
    });
  }
  return out.sort((a, b) => b.gainM2 - a.gainM2);
}

/**
 * Сколько этажей нужно, чтобы требуемая общая площадь уложилась в свободное место.
 *
 * Считается от ОБЩЕЙ площади объекта (пятно × заданная этажность): именно она
 * задана техническим заданием и не меняется от того, как здание разложено по
 * этажам. Пятно — производная. На проекте в Горбунках это и оказалось решением:
 * 3580 м² общей площади при двух этажах требуют пятна 1790 м², при трёх — 1193 м².
 */
function floorsMeasure(neededFootprintM2, floors, availableM2) {
  if (!(neededFootprintM2 > 0) || !(availableM2 > 0)) return null;
  const known = floors > 0 ? floors : 1;
  const totalM2 = neededFootprintM2 * known;
  const need = Math.ceil(totalM2 / availableM2);
  if (need <= known) return null; // этажность не помогает: место и так есть

  /*
   * Этажность — не безразмерная ручка.
   *
   * Арифметика охотно предлагает пятнадцать этажей там, где свободных метров
   * почти не осталось, — и такой совет дискредитирует весь список: цех вакцин
   * пятнадцатиэтажным не бывает. Выше потолка мероприятие не предлагается, а
   * называется тем, чем является: одной этажностью задача не решается,
   * надо снимать ограничения.
   */
  if (need > MAX_REASONABLE_FLOORS) {
    return {
      kind: 'floors',
      from: known,
      to: need,
      unreasonable: true,
      totalM2: round(totalM2),
      footprintM2: round(totalM2 / need),
      text: `Одной этажностью задача не решается: чтобы уложить ${round(totalM2)} м² общей площади `
        + `в свободные ${round(availableM2)} м², понадобилось бы ${need} этажей — для такого объекта это не вариант. `
        + 'Сокращать надо ограничения либо саму программу объекта.',
    };
  }
  const newFootprint = round(totalM2 / need);
  return {
    kind: 'floors',
    from: known,
    to: need,
    totalM2: round(totalM2),
    footprintM2: newFootprint,
    text: `Поднять этажность с ${known} до ${need}: общая площадь ${round(totalM2)} м² останется прежней, `
      + `а пятно застройки уменьшится с ${round(neededFootprintM2)} до ${newFootprint} м² — `
      + `это уже помещается в свободные ${round(availableM2)} м². `
      + 'Этажность выше требует проверки по СП 2.13130 (площадь пожарного отсека и степень огнестойкости).',
  };
}

/** На сколько придётся урезать пятно, если этажность менять нельзя. */
function shrinkMeasure(neededFootprintM2, availableM2) {
  if (!(neededFootprintM2 > availableM2) || !(availableM2 > 0)) return null;
  const cut = round(neededFootprintM2 - availableM2);
  const share = Math.round((cut / neededFootprintM2) * 100);
  return {
    kind: 'shrink',
    fromM2: round(neededFootprintM2),
    toM2: round(availableM2),
    text: `Уменьшить площадь застройки с ${round(neededFootprintM2)} до ${round(availableM2)} м² `
      + `(на ${cut} м², то есть на ${share} %) — при неизменных этажности и ограничениях это предельное пятно. `
      + 'Общая площадь объекта при этом сократится: проверьте, выполняется ли задание.',
  };
}

/**
 * Полный разбор «почему не поместилось и что с этим делать».
 *
 * @param {object} site         план участка (нужны parcel и restrictions)
 * @param {object} buildable    допустимая территория ({geometry, areaM2})
 * @param {object} req          нормализованные требования {areaM2, floors}
 * @param {object} [opts]       {maxCandidateAreaM2} — самое крупное пятно, которое
 *                              удалось разместить при переборе (0, если ни одного)
 */
function analyse(site, buildable, req, { maxCandidateAreaM2 = 0 } = {}) {
  const availableM2 = buildable && buildable.geometry
    ? round(jts.area(jts.toJts(buildable.geometry)))
    : 0;
  const neededM2 = req.areaM2 || (req.width && req.length ? round(req.width * req.length) : 0);
  const measures = [];

  const floorsFix = floorsMeasure(neededM2, req.floors, availableM2);
  if (floorsFix) measures.push(floorsFix);

  const shrink = shrinkMeasure(neededM2, availableM2);
  if (shrink) measures.push(shrink);

  /*
   * Территории хватает, а положения нет — площадка узкая или разрезана.
   * Это отдельный диагноз: здание уменьшать незачем, надо менять форму.
   */
  if (neededM2 && availableM2 >= neededM2) {
    measures.push({
      kind: 'shape',
      text: `Свободной площади достаточно (${availableM2} м² против ${neededM2} м² застройки), но ни одно `
        + 'положение не уместилось целиком: территория узкая или разрезана зонами на куски. '
        + (maxCandidateAreaM2 > 0
          ? `Самое крупное пятно, которое удалось вписать, — ${round(maxCandidateAreaM2)} м². `
          : '')
        + 'Помогут Г-, Т- или П-образная форма корпуса и другие пропорции — прямоугольник в такую площадку не ложится.',
    });
  }

  const gains = site && site.parcel ? gainsByZone(site.parcel.geometry, site.restrictions || []) : [];
  for (const g of gains.slice(0, MAX_MEASURES - measures.length)) {
    const after = round(availableM2 + g.gainM2);
    const enough = neededM2 > 0 && after >= neededM2;
    measures.push({
      kind: 'restriction',
      zoneId: g.zoneId,
      gainM2: g.gainM2,
      afterM2: after,
      solvesAlone: enough,
      how: HOW_TO_LIFT[g.kind] || '',
      text: `Снять ограничение «${g.kindLabel}${g.label ? `: ${g.label}` : ''}»`
        + (g.basis ? ` (${g.basis})` : '')
        + ` — освободится ${g.gainM2} м², свободная территория станет ${after} м²`
        + (enough ? ' — этого уже достаточно для посадки без других изменений.' : '.')
        + (HOW_TO_LIFT[g.kind] ? ` Как: ${HOW_TO_LIFT[g.kind]}.` : '')
        + (g.status ? ` Статус ограничения: ${g.status.toLowerCase()}.` : ''),
    });
  }

  // Пара «этажность + снятие самого дорогого ограничения» — то, чем такие
  // площадки и решаются на практике: по отдельности не хватает, вместе хватает.
  const topGain = gains[0];
  if (!measures.some((m) => m.solvesAlone) && floorsFix && !floorsFix.unreasonable && topGain) {
    const after = round(availableM2 + topGain.gainM2);
    if (after >= floorsFix.footprintM2) {
      measures.unshift({
        kind: 'combo',
        text: `Связка решает задачу: ${floorsFix.to} этажа (пятно ${floorsFix.footprintM2} м²) `
          + `плюс снятие ограничения «${topGain.kindLabel}${topGain.label ? `: ${topGain.label}` : ''}» `
          + `(+${topGain.gainM2} м², итого ${after} м² свободных). По отдельности ни одно из этих `
          + 'изменений посадку не открывает.',
      });
    }
  }

  return {
    availableM2,
    neededM2,
    floors: req.floors || null,
    measures: measures.slice(0, MAX_MEASURES),
    zoneGains: gains.slice(0, MAX_MEASURES),
  };
}

/** Текст для ленты и карточки: причина плюс пронумерованные мероприятия. */
function toText(reason, relief) {
  if (!relief || !relief.measures.length) return reason;
  const lines = relief.measures.map((m, i) => `${i + 1}. ${m.text}`);
  return `${reason}\n\nЧто можно сделать (числа посчитаны по этой площадке, не оценка):\n${lines.join('\n')}`;
}

module.exports = { analyse, toText, gainsByZone, floorsMeasure, shrinkMeasure, shortLabel, HOW_TO_LIFT, MIN_GAIN_M2 };
