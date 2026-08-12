'use strict';
/**
 * Restriction Engine (ТЗ, п. 27, 29).
 *
 * Принимает геометрию участка, существующие объекты и структурированные правила —
 * возвращает реальные полигоны зон ограничения, потенциально допустимую территорию,
 * происхождение каждой зоны, конфликты и список того, что построить не удалось.
 *
 * Здесь нет ни одного обращения к модели. Всё считается детерминированно: одни и
 * те же правила на одной и той же геометрии дают тот же результат до миллиметра.
 * В этом и смысл разделения — правило формулирует модель, зону строит код.
 */
const G = require('./site-geometry');
const jts = require('./jts');
const RR = require('./restriction-rules');

/**
 * Объект, которого на площадке не будет, ограничений не даёт.
 *
 * Шаг «Существующие объекты» — это решение о сносе и сохранении, и оно обязано
 * доходить до геометрии. Снесённое здание не даёт противопожарного разрыва:
 * разрыв нормируется между СУЩЕСТВУЮЩИМИ объектами, а не между новым зданием и
 * тем, что уже разобрано. На боевом комплекте это решало задачу целиком —
 * пять строений под снос давали двенадцатиметровые разрывы вокруг себя и
 * съедали ту самую территорию, на которой их место и освобождается.
 *
 * Границы участка и красные линии решением человека не отменяются: от них
 * считается отступ, и «снести границу» бессмысленно.
 */
function willBeGone(obj) {
  const rel = obj && obj.properties && obj.properties.relocation;
  if (rel !== 'demolish' && rel !== 'move') return false;
  return obj.type !== 'parcel' && obj.type !== 'redLine' && obj.type !== 'buildLine';
}

/** Какие объекты участка соответствуют селектору правила. */
function resolveTargets(site, rule) {
  const { selector, hint } = rule.target;
  const all = {
    parcelBoundary: site.parcel ? [site.parcel] : [],
    redLine: site.redLines,
    building: site.buildings,
    utility: site.utilities,
    existingObject: site.existingObjects,
    road: site.existingObjects,
    layer: G.allObjects(site),
    objectId: G.allObjects(site),
    unknown: [],
  }[selector] || [];
  const byType = all.filter((o) => !willBeGone(o));

  if (!hint) return { targets: byType, narrowed: false };

  const needle = hint.toLowerCase();
  if (selector === 'objectId') {
    const exact = byType.filter((o) => o.id === hint);
    if (exact.length) return { targets: exact, narrowed: true };
  }

  /*
   * Уточнение ищется и по ИМЕНИ, КОТОРОЕ ДАЛ ЧЕЛОВЕК, а не только по слою чертежа.
   *
   * На топосъёмке слои называются «07_Объекты электропередачи» — по такому имени
   * не разобрать, десять там киловольт или сто десять, а от этого зависит ширина
   * охранной зоны. Человек, глядя на план, подписывает линию «ВЛ-10 кВ» — и это
   * ровно то уточнение, которое стоит в правиле. Пока сопоставление шло только по
   * слою, подпись никуда не влияла: правило «10 м от ВЛ-10 кВ» не находило
   * названную линию и строило зону от ВСЕХ сетей участка либо не строило вовсе.
   *
   * Имя человека проверяется ПЕРВЫМ: он видел чертёж, разбор — только имя слоя.
   */
  const named = byType.filter((o) => {
    const label = String((o.properties && (o.properties.userLabel || o.properties.label)) || '').toLowerCase();
    return label && (label.includes(needle) || needle.includes(label));
  });
  if (named.length) return { targets: named, narrowed: true, byUserLabel: true };

  // уточнение по имени слоя: «Сети ЛЭП 10кВ» должно найти именно свой слой,
  // а не все сети участка
  const matched = byType.filter((o) => String(o.provenance.sourceLayer || '').toLowerCase().includes(needle)
    || needle.includes(String(o.provenance.sourceLayer || '').toLowerCase()));
  if (matched.length) return { targets: matched, narrowed: true };

  // уточнение не совпало ни с одним слоем — берём весь тип, но отмечаем это
  return { targets: byType, narrowed: false, hintMissed: true };
}

/**
 * Построение зоны по одному правилу.
 * Возвращает { geom } либо { unresolved: причина } — почему зону построить нельзя.
 */
function buildZone(site, rule, parcelJts) {
  if (rule.operation === 'attribute') {
    return { unresolved: 'ограничение не геометрическое (высота, процент застройки)' };
  }
  if (rule.status === RR.STATUSES.INSUFFICIENT) {
    return { unresolved: rule.statusReason || 'недостаточно данных для построения' };
  }

  const { targets, hintMissed } = resolveTargets(site, rule);
  if (!targets.length) {
    return { unresolved: `на участке нет объектов, от которых считается ограничение (${rule.target.selector})` };
  }

  /*
   * Уточнение не совпало ни с одним слоем — правило НЕ применяется к целому типу.
   *
   * Живой прогон 2026-08-12: модель написала правдоподобное, но несуществующее
   * имя слоя — «Сети ЛЭП 10кВ», тогда как на чертеже слой зовётся «07_Объекты
   * электропередачи». Движок совпадения не нашёл и построил охранную зону 10 м
   * ОТ ВСЕХ одиннадцати слоёв сетей разом: канализации, теплосети, телефона.
   * Зона выросла с 1068 до 2788 м², допустимая территория упала с 1457 до 565,
   * и посадка перестала находиться — по правилу, которое к этим сетям
   * не относится.
   *
   * Правило, объект отсчёта которого опознать не удалось, — это правило,
   * которое применять НЕ К ЧЕМУ. Оно уходит в unresolved с причиной и списком
   * слоёв, какие на участке есть: так человек видит и потерю, и чем её закрыть.
   * Молча строить от всего типа хуже, чем не строить вовсе: зона от чужих
   * объектов выглядит как расчёт и убивает посадку.
   */
  if (hintMissed) {
    const have = [...new Set(targets.map((t) => t.provenance.sourceLayer).filter(Boolean))];
    return {
      unresolved: `уточнение «${rule.target.hint}» не совпало ни с одним слоем участка. `
        + `Есть слои: ${have.slice(0, 8).join(', ')}${have.length > 8 ? ` и ещё ${have.length - 8}` : ''}. `
        + 'Зона не построена: от всех объектов типа сразу считать нельзя — это ограничение от чужих объектов. '
        + 'Подпишите нужную линию на плане либо поправьте уточнение в правиле.',
    };
  }

  if (rule.operation === 'bufferInward') {
    // отступ внутрь имеет смысл только от замкнутого контура — участка или квартала
    const closed = targets.filter((t) => t.geometry.type === 'polygon');
    if (!closed.length) return { unresolved: 'отступ внутрь требует замкнутого контура' };
    const rings = closed.map((t) => jts.insetRing(t.geometry, rule.valueM));
    return { geom: jts.union(rings), targets: closed, hintMissed };
  }

  // bufferOutward: полоса вокруг каждого объекта, затем объединение
  const zones = targets.map((t) => jts.bufferOutward(t.geometry, rule.valueM));
  return { geom: jts.union(zones), targets, hintMissed };
}

/**
 * Основной расчёт.
 * @param {object} site   SiteGeometry
 * @param {Array}  rules  правила после processExtraction
 * @returns {object} зоны, допустимая территория, конфликты, нерешённое
 */
function build(site, rules) {
  const parcelJts = site.parcel ? jts.toJts(site.parcel.geometry) : null;
  const restrictions = [];
  const unresolved = [];
  const attributes = [];
  // Предупреждения собираются в СВОЙ список и возвращаются наружу.
  // Раньше они только дописывались в site.warnings, а боевой путь идёт через
  // worker: payload уезжает туда структурным клонированием, мутация site назад
  // не возвращается, и «зона построена от чужого объекта» терялась целиком.
  const warnings = [];

  // Решение человека о сносе и переносе меняет геометрию ограничений, и молчать
  // об этом нельзя: человек должен видеть, ПОЧЕМУ разрыв, который он ожидал
  // увидеть, отсутствует. Это же число попадает в мероприятия и в ТЭП.
  const gone = G.allObjects(site).filter(willBeGone);
  if (gone.length) {
    const byDecision = { demolish: [], move: [] };
    for (const o of gone) byDecision[o.properties.relocation].push(o);
    const area = (list) => G.round(list.reduce((s, o) => s + (o.properties.areaM2 || 0), 0), 2);
    const parts = [];
    if (byDecision.demolish.length) parts.push(`под снос ${byDecision.demolish.length} шт. (${area(byDecision.demolish)} м²)`);
    if (byDecision.move.length) parts.push(`под перенос ${byDecision.move.length} шт. (${area(byDecision.move)} м²)`);
    warnings.push({
      code: 'objects-excluded',
      message: `Зоны ограничений не строятся от объектов, которых на площадке не будет: ${parts.join(', ')}. `
        + 'Противопожарные разрывы и охранные зоны от них не считаются — место под ними освобождается. '
        + 'Если решение о сносе ещё не принято, верните объекту статус «не решено» на плане.',
    });
  }

  for (const rule of rules) {
    if (rule.operation === 'attribute') {
      attributes.push({
        ruleId: rule.id, kind: rule.kind, value: rule.value, unit: rule.unit,
        basis: rule.basis, status: rule.status, explain: RR.explainRule(rule),
      });
      continue;
    }

    const res = buildZone(site, rule, parcelJts);
    if (!res.geom) {
      unresolved.push({ ruleId: rule.id, kind: rule.kind, reason: res.unresolved || 'зона не построена', rule });
      continue;
    }

    // Зона за пределами участка проектировщику не нужна: отсекаем границей.
    // Исходная (неотсечённая) площадь сохраняется — по ней видно, какая часть
    // зоны выходит за участок.
    const fullArea = jts.area(res.geom);
    const clipped = parcelJts ? jts.intersection(res.geom, parcelJts) : res.geom;
    if (!clipped) {
      unresolved.push({
        ruleId: rule.id, kind: rule.kind,
        reason: 'зона целиком за пределами участка — на посадку не влияет', rule,
      });
      continue;
    }

    const geometry = jts.fromJts(clipped);
    const object = G.makeObject({
      type: 'restriction',
      geometry,
      properties: {
        kind: rule.kind,
        ruleId: rule.id,
        valueM: rule.valueM,
        status: rule.status,
        statusLabel: RR.STATUS_LABELS[rule.status] || rule.status,
        areaOutsideParcelM2: G.round(Math.max(0, fullArea - jts.area(clipped)), 2),
        targets: (res.targets || []).map((t) => ({ id: t.id, layer: t.provenance.sourceLayer })),
      },
      provenance: {
        extractionMethod: 'computed',
        confidence: rule.confidence,
        basis: rule.basis || null,
        sourceFile: (rule.source && rule.source.document) || null,
        reason: `${RR.explainRule(rule)}; зона построена буфером ${rule.valueM} м и отсечена границей участка`,
      },
    });
    restrictions.push(object);
  }

  /*
   * Ноль зон — это НЕ «ограничений нет».
   *
   * Допустимая территория выходит равной всему участку, и результат выглядит
   * успешным: 3700 м² свободно, посадка находится, четыре варианта готовы.
   * Между тем на площадке 54 инженерные сети и 46 строений, и хотя бы отступ
   * по ГПЗУ там есть всегда. Так и вышло на боевом прогоне: извлечение
   * ограничений не разобралось, зон построили ноль, и здание село на участок,
   * где по документам живут семь охранных зон. Пустой результат обязан
   * выглядеть подозрительно, а не безупречно.
   */
  if (!restrictions.length && parcelJts) {
    warnings.push({
      code: 'no-restrictions',
      message: 'Не построено НИ ОДНОЙ зоны ограничений, поэтому допустимой территорией считается весь участок. '
        + 'Это почти всегда значит, что ограничения не извлеклись, а не что их нет: минимальный отступ есть '
        + 'в любом ГПЗУ, а на площадке с инженерными сетями — ещё и охранные зоны. '
        + 'Посадку по такой схеме согласовывать нельзя: сначала разберитесь, почему список пуст.',
    });
  }

  const buildable = computeBuildable(site, parcelJts, restrictions, warnings);

  // site мутируется по-прежнему: в основном потоке этим пользуются экспорт и
  // карточки. Слияние без дублей — чтобы повторный расчёт не размножал текст.
  if (!Array.isArray(site.warnings)) site.warnings = [];
  G.mergeWarnings(site.warnings, warnings);

  return {
    restrictions,
    buildable,
    attributes,
    unresolved,
    warnings,
    stats: {
      зонПостроено: restrictions.length,
      неПостроено: unresolved.length,
      атрибутивныхОграничений: attributes.length,
      допустимаяПлощадь: buildable ? buildable.areaM2 : null,
      // доля от участка без участка не считается: раньше здесь появлялась
      // строка «NaN%» — деление на нулевую площадь вырожденного контура
      доляОтУчастка: buildable && buildable.sharePercent !== null ? `${buildable.sharePercent}%` : null,
    },
  };
}

/**
 * Потенциально допустимая территория (ТЗ, п. 29):
 * граница участка минус запрещённые зоны.
 *
 * Это АНАЛИТИЧЕСКИЙ результат, а не разрешённое пятно застройки. Поэтому здесь
 * же перечисляется, на каких правилах он построен и что в расчёт не вошло:
 * пользователь должен видеть, чего не хватает, а не только красивую цифру.
 */
function computeBuildable(site, parcelJts, restrictions, warnings = []) {
  if (!parcelJts) return null;

  // Вырожденный участок (схлопнувшаяся или коллинеарная полилиния из чертежа)
  // раньше давал деление на ноль: sharePercent = NaN, в статистике «NaN%»,
  // а подпись бодро сообщала, что все правила подтверждены документами.
  const parcelArea = jts.area(parcelJts);
  if (!(parcelArea > 0)) {
    // Отдаётся null — то же, что и при полном отсутствии участка. Возвращать
    // объект с нулями нельзя: он выглядит как выполненный расчёт и уносит
    // в отчёт бодрую подпись «все учтённые правила подтверждены документами»
    // при развалившейся геометрии. Причина уходит предупреждением.
    warnings.push({
      code: 'parcel-degenerate',
      message: 'Границы участка вырождены: площадь контура равна нулю. ' +
        'Допустимая территория и её доля не рассчитаны — сначала нужно понять, ' +
        'какой контур чертежа принят за границы участка, и починить его.',
    });
    return null;
  }

  /*
   * Зона, накрывшая участок целиком, из вычитания ИСКЛЮЧАЕТСЯ.
   *
   * На Горбунках анализ извлёк `plot.zone_sanitary_protection = 3700` и
   * `plot.zone_airport_pulkovo = 3700` — участок целиком лежит внутри СЗЗ и
   * приаэродромной территории Пулкова. Это РЕЖИМ, а не запрет застройки:
   * приаэродромная зона ограничивает высоту, СЗЗ запрещает жильё и детские
   * учреждения, но не производственный корпус. Вычесть такую зону — значит
   * получить ноль свободной территории и ответить «здание не помещается»
   * там, где строить можно.
   *
   * Решение за человеком, поэтому зона не исчезает: она остаётся на плане и
   * в перечне, но площадь не отнимает, а предупреждение говорит об этом прямо.
   * Молча вычесть или молча не вычесть — одинаково недопустимо.
   */
  const WHOLE_PARCEL_SHARE = 0.98;
  const covering = [];
  const cutting = [];
  for (const r of restrictions) {
    const g = jts.toJts(r.geometry);
    if (!g) continue;
    const inter = jts.intersection(g, parcelJts);
    const share = inter ? jts.area(inter) / parcelArea : 0;
    if (share >= WHOLE_PARCEL_SHARE) {
      r.properties.wholeParcel = true;
      covering.push(r);
    } else cutting.push(g);
  }
  if (covering.length) {
    const names = covering.map((r) => RR.KIND_LABELS[r.properties.kind] || r.properties.kind);
    warnings.push({
      code: 'zone-covers-parcel',
      message: `Зона «${names.join('», «')}» накрывает участок целиком. Из допустимой территории она НЕ вычтена: `
        + 'зона на весь участок — это, как правило, режим (приаэродромная территория, СЗЗ, зона подтопления), '
        + 'а не запрет застройки. Вычесть её значило бы ответить «места нет» там, где строить можно. '
        + 'Проверьте по документу, что именно она запрещает: если застройку — участок под этот объект не годится, '
        + 'и это отдельный вывод, а не результат расчёта.',
    });
  }

  const zones = cutting;
  const forbidden = jts.union(zones);
  const free = forbidden ? jts.difference(parcelJts, forbidden) : parcelJts;
  if (!free) {
    return {
      status: 'analytical',
      geometry: null,
      areaM2: 0,
      sharePercent: 0,
      basedOn: restrictions.map((r) => r.properties.ruleId),
      note: 'Свободной территории не осталось: ограничения перекрывают участок целиком.',
    };
  }
  const freeArea = jts.area(free);
  const needsReview = restrictions.filter((r) => r.properties.status !== RR.STATUSES.CONFIRMED);
  return {
    status: 'analytical',
    geometry: jts.fromJts(free),
    areaM2: G.round(freeArea, 2),
    sharePercent: G.round((freeArea / parcelArea) * 100, 1),
    basedOn: restrictions.map((r) => r.properties.ruleId),
    uncertainRules: needsReview.map((r) => ({ ruleId: r.properties.ruleId, status: r.properties.status })),
    note: 'Потенциально допустимая территория по учтённым ограничениям. ' +
      'Это аналитический результат, а не разрешённое пятно застройки: ' +
      (needsReview.length
        ? `${needsReview.length} из ${restrictions.length} зон построены по неподтверждённым правилам.`
        : 'все учтённые правила подтверждены документами, но перечень ограничений может быть неполным.'),
  };
}

module.exports = { build, buildZone, resolveTargets, computeBuildable };
