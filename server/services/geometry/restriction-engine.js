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

/** Какие объекты участка соответствуют селектору правила. */
function resolveTargets(site, rule) {
  const { selector, hint } = rule.target;
  const byType = {
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

  if (!hint) return { targets: byType, narrowed: false };

  const needle = hint.toLowerCase();
  if (selector === 'objectId') {
    const exact = byType.filter((o) => o.id === hint);
    if (exact.length) return { targets: exact, narrowed: true };
  }
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
        ...(res.hintMissed ? { hintMissed: rule.target.hint } : {}),
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
    if (res.hintMissed) {
      warnings.push({
        code: 'target-hint-missed',
        message: `Уточнение «${rule.target.hint}» не совпало ни с одним слоем — ` +
          `ограничение построено от всех объектов типа «${rule.target.selector}». Проверьте.`,
      });
    }
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

  const zones = restrictions.map((r) => jts.toJts(r.geometry));
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
