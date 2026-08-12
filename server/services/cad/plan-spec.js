'use strict';
/**
 * Спецификация чертежа генплана — независимое от формата описание того,
 * что должно оказаться в файле: слои, полилинии, штриховки, подписи.
 *
 * Зачем отдельный слой абстракции: один и тот же чертёж уходит двумя путями —
 * в DXF, который пишет сервер сам, и в AutoCAD через мост, который строит
 * настоящие сущности и сохраняет DWG. Если бы каждый путь собирал геометрию
 * самостоятельно, файлы разъезжались бы уже на второй правке.
 *
 * Координаты — метры в системе чертежа, ровно те же, что в SiteGeometry.
 * Никакого масштабирования здесь нет: пересчёт единиц — забота формата.
 */
const ZoneStyle = require('../../../public/zone-style.js');
const G = require('../geometry/site-geometry');
const RR = require('../geometry/restriction-rules');

// Имена и цвета слоёв исходной обстановки берутся из общего перечня
// (geometry/layers.js) — того же, по которому разбирается чужой DWG и по которому
// человек переназначает объекты. Пока список был свой, объект, переназначенный
// в «Рельеф», уезжал в чертёж слоем «прочие объекты»: переназначение до файла
// просто не доходило.
const taxonomy = require('../geometry/layers');

/** Пунктиром чертятся линии регулирования — так их отличают от контуров. */
const DASHED = new Set(['redLine', 'buildLine']);

/**
 * Слой чертежа для объекта — по его ТИПУ, а не по массиву, в котором он лежит.
 * fallback нужен для геометрии, пришедшей не из разбора (готовые модели в тестах
 * и во внешних вызовах): у неё поля type может не быть, но смысл массива известен.
 */
function layerForObject(obj, fallbackType) {
  const t = taxonomy.get((obj && obj.type) || fallbackType);
  if (!t) return LAYERS.existingObjects;
  return { name: t.dxf, color: t.color, linetype: DASHED.has(t.id) ? 'DASHED' : 'Continuous' };
}

/** Смысл массива плана — на случай объекта без собственного типа. */
const BUCKET_FALLBACK = {
  redLines: 'redLine', utilities: 'utility', buildings: 'building', existingObjects: 'existingObject',
};

/** Слои чертежа. Префикс AI_ отделяет построенное приложением от исходной съёмки. */
const LAYERS = {
  existingObjects: { name: 'AI_ПРОЧИЕ_ОБЪЕКТЫ', color: 9, linetype: 'Continuous' },
  buildable: { name: 'AI_ДОПУСТИМАЯ_ТЕРРИТОРИЯ', color: 92, linetype: 'Continuous' },
  // Запретная зона отдельным слоем: объединение всех ограничений одним контуром.
  // По зонам поштучно ответ «куда нельзя» приходится собирать глазами, а этот
  // слой отвечает сразу — его и печатают на схеме планировочных ограничений.
  forbidden: { name: 'AI_ЗАПРЕТНАЯ_ЗОНА', color: 14, linetype: 'Continuous' },
  footprint: { name: 'AI_ПЯТНО_ЗАСТРОЙКИ', color: 3, linetype: 'Continuous' },
  labels: { name: 'AI_ПОДПИСИ', color: 7, linetype: 'Continuous' },
  tep: { name: 'AI_ТЭП', color: 7, linetype: 'Continuous' },
};

/** Слой зоны ограничения — свой на каждый тип: их и включают, и печатают отдельно. */
const ZONE_LAYER_NAMES = {
  setback: 'AI_ЗОНА_ОТСТУПЫ',
  protectionZone: 'AI_ЗОНА_ОХРАННЫЕ',
  fireBreak: 'AI_ЗОНА_ПОЖ_РАЗРЫВЫ',
  sanitaryZone: 'AI_ЗОНА_СЗЗ',
  buildLine: 'AI_ЗОНА_РЕГ_ЗАСТРОЙКИ',
  easement: 'AI_ЗОНА_СЕРВИТУТЫ',
  heightLimit: 'AI_ЗОНА_ВЫСОТА',
  coverageLimit: 'AI_ЗОНА_ПРОЦЕНТ_ЗАСТРОЙКИ',
  other: 'AI_ЗОНА_ПРОЧИЕ',
};

function zoneLayer(kind) {
  const key = ZONE_LAYER_NAMES[kind] ? kind : 'other';
  return { name: ZONE_LAYER_NAMES[key], color: ZoneStyle.zone(key).aci, linetype: 'Continuous' };
}

const round = (n) => Math.round(n * 1000) / 1000;

/** Кольца полигона: внешнее плюс отверстия. Мультиполигон разворачивается в список. */
function ringsOf(geometry) {
  if (!geometry) return [];
  if (geometry.type === 'multipolygon') {
    return (geometry.polygons || []).flatMap((p) => [
      { points: p.points, hole: false },
      ...(p.holes || []).map((h) => ({ points: h, hole: true })),
    ]);
  }
  if (geometry.type === 'polygon') {
    return [
      { points: geometry.points, hole: false },
      ...(geometry.holes || []).map((h) => ({ points: h, hole: true })),
    ];
  }
  return [{ points: geometry.points, hole: false, open: true }];
}

/**
 * Полигоны геометрии: внешнее кольцо со СВОИМИ отверстиями.
 *
 * Штриховке мало плоского списка колец: залить нужно кольцо минус его дырки,
 * иначе зона отступа (а это кольцо вдоль границы) закрашивается на весь
 * участок, а сплошная зелёная заливка допустимой территории ложится поверх
 * запретной зоны — то есть чертёж показывает разрешённым то, что запрещено.
 */
function polygonsOf(geometry) {
  if (!geometry) return [];
  const ring = (points) => (Array.isArray(points) ? points : []);
  if (geometry.type === 'multipolygon') {
    return (geometry.polygons || []).map((p) => ({
      points: ring(p.points),
      holes: (p.holes || []).map(ring).filter((h) => h.length >= 3),
    })).filter((p) => p.points.length >= 3);
  }
  if (geometry.type === 'polygon') {
    const outer = ring(geometry.points);
    if (outer.length < 3) return [];
    return [{ points: outer, holes: (geometry.holes || []).map(ring).filter((h) => h.length >= 3) }];
  }
  return [];
}

/**
 * Параметры штриховки — единственный источник и для DXF, и для моста AutoCAD.
 *
 * Оба пути обязаны получить одни и те же угол и шаг: раньше DXF писал угол 0
 * и масштаб 1 для всех зон, а в AutoCAD уходили настоящие — файлы одного
 * комплекта расходились ровно там, где plan-spec заводился их сближать.
 */
function hatchParams(e) {
  if (!e || e.solid) return { pattern: 'SOLID', angle: 0, scale: 1 };
  return {
    pattern: e.pattern || 'ANSI31',
    angle: Number.isFinite(e.angle) ? e.angle : 0,
    scale: Math.max(0.05, Number.isFinite(e.spacing) ? e.spacing : 1),
  };
}

/**
 * Подпись статуса варианта берётся из ЖИВОГО статуса, а не из ярлыка,
 * замороженного в metrics при генерации: решение по мероприятию принимается
 * позже, и чертёж иначе утверждает «требует решения» там, где PDF того же
 * комплекта уже печатает «допустим».
 *
 * Замороженный `statusLabel` остаётся запасным вариантом — на случай статуса,
 * которого нет в этом перечне.
 */
const VARIANT_STATUS_LABELS = {
  admissible: 'допустим',
  needs_decision: 'требует решения пользователя',
  violations: 'есть нарушения',
  rejected: 'отклонён решением пользователя',
};

function variantStatusLabel(variant) {
  if (!variant) return '';
  return VARIANT_STATUS_LABELS[variant.status] || variant.statusLabel || variant.status || '';
}

/**
 * Шаг штриховки подбирается от размера участка: постоянный шаг в метрах
 * на участке в гектар даёт сплошную заливку, а на маленьком — одну линию.
 */
function hatchSpacing(bounds) {
  if (!bounds || !Number.isFinite(bounds.minX)) return 2;
  const diag = Math.hypot(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY);
  return Math.max(0.8, Math.min(5, diag / 90));
}

/**
 * Полная спецификация чертежа.
 *
 * @param {object} site       SiteGeometry с ограничениями и допустимой территорией
 * @param {object} opts.variant  выбранный вариант посадки (может отсутствовать)
 * @param {object} opts.buildable допустимая территория
 * @param {string} opts.title  название проекта для подписи
 */
function build(site, { variant = null, buildable = null, title = '', subtitle = '' } = {}) {
  const layers = [];
  const entities = [];
  const seenLayers = new Set();
  const addLayer = (l) => {
    if (seenLayers.has(l.name)) return l.name;
    seenLayers.add(l.name);
    layers.push(l);
    return l.name;
  };

  const bounds = site.drawingBounds || null;
  const spacing = hatchSpacing(bounds);
  const textH = bounds ? Math.max(0.6, Math.hypot(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY) / 110) : 1;

  const addGeometry = (geometry, layerName, { closedOverride = null } = {}) => {
    for (const ring of ringsOf(geometry)) {
      if (!ring.points || ring.points.length < 2) continue;
      entities.push({
        type: 'polyline',
        layer: layerName,
        closed: closedOverride === null ? !ring.open : closedOverride,
        points: ring.points.map(([x, y]) => [round(x), round(y)]),
      });
    }
  };

  // ── исходная обстановка ───────────────────────────────────────────────
  if (site.parcel) {
    addGeometry(site.parcel.geometry, addLayer(layerForObject(site.parcel, 'parcel')));
  }
  // слой — по типу КАЖДОГО объекта: рельеф уходит в AI_РЕЛЬЕФ, стоянка —
  // в AI_СТОЯНКИ, и правка человека доезжает до файла
  for (const key of ['redLines', 'utilities', 'buildings', 'existingObjects']) {
    for (const obj of site[key] || []) {
      addGeometry(obj.geometry, addLayer(layerForObject(obj, BUCKET_FALLBACK[key])));
    }
  }

  // ── допустимая территория: сплошная пастельная заливка ────────────────
  const area = buildable || site.buildable;
  if (area && area.geometry) {
    const name = addLayer(LAYERS.buildable);
    for (const ring of ringsOf(area.geometry)) {
      if (!ring.points || ring.points.length < 3) continue;
      entities.push({ type: 'polyline', layer: name, closed: true, points: ring.points.map(([x, y]) => [round(x), round(y)]) });
    }
    for (const poly of polygonsOf(area.geometry)) {
      entities.push({
        type: 'hatch', layer: name, solid: true, pattern: 'SOLID',
        boundary: poly.points.map(([x, y]) => [round(x), round(y)]),
        // отверстия остаются незакрашенными: под ними лежит запретная зона
        holes: poly.holes.map((h) => h.map(([x, y]) => [round(x), round(y)])),
      });
    }
  }

  // ── запретная зона: контур объединения всех ограничений ───────────────
  if (area && area.forbidden && area.forbidden.geometry) {
    const name = addLayer(LAYERS.forbidden);
    for (const ring of ringsOf(area.forbidden.geometry)) {
      if (!ring.points || ring.points.length < 3) continue;
      entities.push({
        type: 'polyline', layer: name, closed: true,
        points: ring.points.map(([x, y]) => [round(x), round(y)]),
      });
    }
  }

  /*
   * ── зоны ограничений: штриховка своего угла и цвета на своём слое ─────
   *
   * Когда зон много, в чертёж идут ОБЪЕДИНЕНИЯ по правилу, а не каждая зона
   * отдельно. Причина та же, что на экране: слой из семнадцати колодцев
   * канализации давал семнадцать почти совпадающих окружностей и столько же
   * штриховок поверх друг друга. Слой чертежа при этом не меняется — он
   * выбирается по типу ограничения, а тип у всей группы один.
   *
   * Экспликация и ведомость перечисляют зоны ПОШТУЧНО по-прежнему: свернулась
   * краска, а не перечень.
   */
  const zoneGroups = site.zoneGroups || [];
  const foldZones = ZoneStyle.shouldFold((site.restrictions || []).length, zoneGroups.length);
  const zoneShapes = foldZones
    ? zoneGroups.map((g) => ({ kind: g.kind, geometry: g.geometry }))
    : (site.restrictions || []).map((z) => ({ kind: (z.properties && z.properties.kind) || 'other', geometry: z.geometry }));
  for (const zone of zoneShapes) {
    const kind = zone.kind || 'other';
    const style = ZoneStyle.zone(kind);
    const name = addLayer(zoneLayer(kind));
    for (const ring of ringsOf(zone.geometry)) {
      if (!ring.points || ring.points.length < 3) continue;
      entities.push({
        type: 'polyline', layer: name, closed: true,
        points: ring.points.map(([x, y]) => [round(x), round(y)]),
      });
    }
    for (const poly of polygonsOf(zone.geometry)) {
      entities.push({
        type: 'hatch',
        layer: name,
        solid: false,
        pattern: style.acadPattern,
        angle: style.acadAngle,
        // шаг штриховки в метрах чертежа: наложение двух зон читается
        // как наложение двух штриховок под разными углами
        spacing: round(spacing * style.acadScale),
        boundary: poly.points.map(([x, y]) => [round(x), round(y)]),
        // зона отступа — кольцо: без вычета отверстия она закрашивала
        // весь участок и читалась как «строить нельзя нигде»
        holes: poly.holes.map((h) => h.map(([x, y]) => [round(x), round(y)])),
      });
    }
  }

  // ── пятно застройки выбранного варианта ───────────────────────────────
  if (variant && variant.footprint) {
    const name = addLayer(LAYERS.footprint);
    const points = variant.footprint.points.map(([x, y]) => [round(x), round(y)]);
    entities.push({ type: 'polyline', layer: name, closed: true, points, width: round(textH * 0.12) });
    entities.push({
      type: 'hatch', layer: name, solid: false, pattern: 'ANSI31',
      angle: 45, spacing: round(spacing * 0.9), boundary: points,
    });
    const c = centroid(points);
    const m = variant.metrics || {};
    entities.push({
      type: 'text', layer: addLayer(LAYERS.labels), point: c, height: textH,
      text: `Вариант ${variant.number}: ${m.shapeLabel || ''} ${m.areaM2 || ''} м²`.replace(/\s+/g, ' ').trim(),
      align: 'center',
    });
  }

  // ── экспликация и штамп ───────────────────────────────────────────────
  if (bounds) {
    const labelLayer = addLayer(LAYERS.labels);
    const tepLayer = addLayer(LAYERS.tep);
    const left = bounds.minX;
    let y = bounds.minY - textH * 3;
    const line = (text, layer = tepLayer, size = textH) => {
      entities.push({ type: 'text', layer, point: [round(left), round(y)], height: round(size), text });
      y -= size * 1.9;
    };
    if (title) line(title, labelLayer, textH * 1.6);
    if (subtitle) line(subtitle, labelLayer, textH * 0.9);
    y -= textH;
    line('ЭКСПЛИКАЦИЯ ЗОН');
    for (const zone of dedupeZones(site.restrictions || [])) {
      line(`  ${ZONE_LAYER_NAMES[zone.kind] || zone.kind} — ${RR.KIND_LABELS[zone.kind] || zone.kind}, ` +
        `${zone.areaM2} м², ${zone.count} шт.`);
    }
    /*
     * Перечень объектов, которые эти зоны и порождают.
     *
     * Экспликация по типам отвечает, ЧТО за зона; чтобы решить, что с ней
     * делать, нужен объект: снять охранную зону можно только выносом сети,
     * противопожарный разрыв — только сносом корпуса. Сортировка по отнятой
     * площади: сверху то, что стоит участку дороже всего.
     */
    const bySource = zonesBySource(site.restrictions || []);
    if (bySource.length) {
      y -= textH * 0.5;
      line('  ОТ КАКИХ ОБЪЕКТОВ:');
      for (const s of bySource.slice(0, 20)) {
        line(`    ${s.label} — ${s.kinds.join(', ')}, ${Math.round(s.areaM2)} м²`);
      }
      if (bySource.length > 20) line(`    …и ещё ${bySource.length - 20} объектов`);
    }
    if (area && area.forbidden) {
      line(`  ${LAYERS.forbidden.name} — запретная зона (объединение ограничений), `
        + `${area.forbidden.areaM2} м², ${area.forbidden.sharePercent}% участка`);
    }
    if (area) line(`  ${LAYERS.buildable.name} — потенциально допустимая территория, ${area.areaM2} м²`);
    if (variant) {
      const m = variant.metrics || {};
      y -= textH;
      line('ТЭП ВАРИАНТА');
      line(`  Площадь застройки: ${m.areaM2} м²`);
      line(`  Габарит: ${m.width} × ${m.length} м, конфигурация: ${m.shapeLabel || 'прямоугольник'}`);
      if (m.floors) line(`  Этажность: ${m.floors}`);
      line(`  Поворот: ${m.rotationDeg}°`);
      line(`  Статус: ${variantStatusLabel(variant)}`);
      for (const t of m.tep || []) line(`  ${t.name}: ${t.value} ${t.unit}`);
    }
    y -= textH;
    line('Построено Enso-nexus. Допустимая территория — аналитический результат,', labelLayer, textH * 0.8);
    line('а не разрешённое пятно застройки. Проверьте основания перед выпуском.', labelLayer, textH * 0.8);
  }

  return {
    units: 'm',
    layers,
    entities,
    bounds: extendBounds(bounds, entities),
    coordinateSystem: (site.coordinateSystem && site.coordinateSystem.name) || '',
  };
}

/** Сводка по типам зон для экспликации: суммарная площадь и число контуров. */
function dedupeZones(restrictions) {
  const map = new Map();
  for (const z of restrictions) {
    const kind = (z.properties && z.properties.kind) || 'other';
    const cur = map.get(kind) || { kind, areaM2: 0, count: 0 };
    cur.areaM2 += Number(z.properties && z.properties.areaM2) || 0;
    cur.count += 1;
    map.set(kind, cur);
  }
  return [...map.values()].map((z) => ({ ...z, areaM2: Math.round(z.areaM2) }));
}

/**
 * Зоны, сгруппированные по ОБЪЕКТУ отсчёта: имя, какие ограничения он даёт
 * и сколько метров участка отнимает. Один объект может давать несколько зон
 * (охранную и противопожарную) — в перечне он остаётся одной строкой.
 */
function zonesBySource(restrictions) {
  const map = new Map();
  for (const z of restrictions) {
    const p = z.properties || {};
    const key = String(p.sourceObjectId || p.sourceLabel || p.ruleId || z.id);
    const cur = map.get(key) || { label: p.sourceLabel || 'объект не назван', kinds: new Set(), areaM2: 0 };
    cur.areaM2 += Number(p.areaM2) || 0;
    cur.kinds.add(RR.KIND_LABELS[p.kind] || p.kind || 'ограничение');
    map.set(key, cur);
  }
  return [...map.values()]
    .map((s) => ({ ...s, kinds: [...s.kinds] }))
    .sort((a, b) => b.areaM2 - a.areaM2);
}

function centroid(points) {
  const b = G.bounds(points);
  return [round((b.minX + b.maxX) / 2), round((b.minY + b.maxY) / 2)];
}

/** Габариты чертежа с учётом вынесенного вниз штампа — иначе он окажется за EXTMIN. */
function extendBounds(bounds, entities) {
  let minX = bounds ? bounds.minX : Infinity;
  let minY = bounds ? bounds.minY : Infinity;
  let maxX = bounds ? bounds.maxX : -Infinity;
  let maxY = bounds ? bounds.maxY : -Infinity;
  for (const e of entities) {
    const pts = e.type === 'text' ? [e.point] : (e.points || e.boundary || []);
    for (const [x, y] of pts) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  if (!Number.isFinite(minX)) return null;
  return { minX: round(minX), minY: round(minY), maxX: round(maxX), maxY: round(maxY) };
}

module.exports = {
  build, LAYERS, ZONE_LAYER_NAMES, zoneLayer, ringsOf, polygonsOf,
  hatchSpacing, hatchParams, dedupeZones, variantStatusLabel, VARIANT_STATUS_LABELS,
};
