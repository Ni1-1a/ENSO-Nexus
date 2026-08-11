'use strict';
/**
 * CAD parser v2: векторная геометрия чертежа → SiteGeometry.
 *
 * Существующий разбор DXF (services/cad.js) не переписывается — он остаётся
 * источником сущностей и по-прежнему делает текстовую выжимку для модели.
 * Здесь его результат превращается в типизированные объекты с координатами
 * в метрах и происхождением у каждого (ТЗ, п. 21–24).
 *
 * Тип объекта определяется по имени слоя. Это эвристика, и она честно помечена
 * уверенностью: слой распознан — высокая, объект добран по геометрии — низкая.
 * Никаких «магических» объектов без объяснения в модель не попадает.
 */
const cad = require('../cad');
const G = require('./site-geometry');

/**
 * Правила классификации слоёв живут в geometry/layers.js вместе с перечнем
 * слоёв для переназначения и именами слоёв выгружаемого DXF. Здесь остаётся
 * только совместимый вид этого перечня: разбор, правка человеком и чертёж
 * обязаны понимать слои одинаково.
 */
const layerTaxonomy = require('./layers');

const LAYER_RULES = layerTaxonomy.LAYERS.map((l) => ({
  type: l.id, confidence: l.confidence, re: l.match, reason: l.reason,
}));

function classifyLayer(layer) {
  return layerTaxonomy.classify(layer);
}

/** Линейные типы не бывают полигонами, даже если контур замкнут. */
const LINEAR_TYPES = new Set(layerTaxonomy.ASSIGNABLE.filter((l) => l.linear).map((l) => l.id));

/** Правила, по которым слой назван участком (нужны для проверки правдоподобия выбора). */
const PARCEL_RULES = LAYER_RULES.filter((r) => r.type === 'parcel');

/* ---------------- правдоподобие выбранного участка ---------------- */

/** Доля площади чертежа, ниже которой контур на участок не похож. */
const PARCEL_MIN_EXTENT_SHARE = 0.05;
/** Уверенность правила, ниже которой выбор считается догадкой. */
const PARCEL_WEAK_CONFIDENCE = 0.7;
/** Насколько близко должен подойти соперник, чтобы выбор считался спорным. */
const PARCEL_RIVAL_SHARE = 0.5;

const fmtArea = (n) => `${G.round(n, 2)} м²`;

/** Что за сущность чертежа дала контур — это часть происхождения объекта. */
function entityLabel(poly) {
  const src = poly.source && poly.source !== 'LWPOLYLINE' ? poly.source : null;
  if (src) return poly.closed ? `замкнутый контур из ${src}` : `контур из ${src}`;
  return poly.closed ? 'замкнутая полилиния' : 'полилиния';
}

/**
 * Проверка выбора границ участка на правдоподобие.
 *
 * Почему это вообще нужно. На настоящей топосъёмке слой «10_Границы покрытий
 * и угодий» подходит под общее правило «границ…», и участком объявлялся контур
 * покрытия площадью 72 м² при чертеже 203 × 158 м — молча, без единого
 * предупреждения, и это число уходило модели, в ТЭП и в расчёт посадки.
 * Здесь выбор не переигрывается (данных, чтобы решить за человека, нет), но
 * сомнения проговариваются вслух со списком конкурентов.
 *
 * @param {object} site      модель, куда пишется предупреждение
 * @param {Array}  cands     кандидаты {layer, areaM2, confidence, reason, chosen}
 * @param {object|null} extent габариты чертежа в метрах {width, height} или null
 */
function auditParcelChoice(site, cands, extent) {
  const parcel = site.parcel;
  if (!parcel) return;
  const area = parcel.properties.areaM2 || 0;
  const candidates = [...cands].sort((a, b) => b.areaM2 - a.areaM2);
  const doubts = [];

  const extentArea = extent && extent.width > 0 && extent.height > 0 ? extent.width * extent.height : 0;
  if (extentArea > 0 && area / extentArea < PARCEL_MIN_EXTENT_SHARE) {
    doubts.push(`контур занимает ${(100 * area / extentArea).toFixed(1)}% площади чертежа ` +
      `(${G.round(extent.width, 1)} × ${G.round(extent.height, 1)} м) — для границ участка это неправдоподобно мало`);
  }
  if (area <= 0) doubts.push('площадь выбранного контура нулевая');
  if (parcel.properties.selfIntersecting) doubts.push('контур самопересекается');

  const chosenConf = parcel.provenance.confidence;
  if (chosenConf < PARCEL_WEAK_CONFIDENCE) {
    doubts.push(`слой опознан лишь как «${parcel.provenance.reason}» (уверенность ${Math.round(chosenConf * 100)}%)`);
  }

  const rivals = candidates.filter((c) => !c.chosen);
  const close = rivals.filter((c) => area > 0 && c.areaM2 >= area * PARCEL_RIVAL_SHARE);
  if (close.length) {
    doubts.push(`ещё ${close.length} контур(ов) претендуют на роль участка с сопоставимой площадью`);
  }
  if (!doubts.length) return;

  const list = candidates.slice(0, 6)
    .map((c) => `${c.chosen ? '→ ВЫБРАН' : '  отклонён'}: слой «${c.layer}», ${fmtArea(c.areaM2)}` +
      `, уверенность ${Math.round(c.confidence * 100)}% (${c.reason})`)
    .join('\n');
  site.warnings.push({
    code: 'parcel-doubtful',
    message: `Границы участка определены ненадёжно: ${doubts.join('; ')}. ` +
      `Выбран контур площадью ${fmtArea(area)} со слоя «${parcel.provenance.sourceLayer}». ` +
      `Проверьте выбор — от него зависят ТЭП, зоны ограничений и посадка здания.\nКандидаты:\n${list}`,
    candidates: candidates.slice(0, 6).map((c) => ({
      layer: c.layer, areaM2: G.round(c.areaM2, 2), confidence: c.confidence, chosen: !!c.chosen,
    })),
  });
}

/**
 * Разбор DXF в SiteGeometry.
 * @param {string} dxfText  содержимое DXF
 * @param {object} source   {fileId, fileName} — попадает в происхождение каждого объекта
 */
function fromDxf(dxfText, source = {}) {
  const parsed = cad.parseDxf(dxfText);
  const fileName = source.fileName || 'чертёж';
  const site = G.createSiteGeometry({
    sourceReferences: [{
      id: source.fileId || null, kind: 'cad', name: fileName,
      layers: (parsed.layers || []).length, entities: parsed.polylines.length,
    }],
  });

  // единицы чертежа: INSUNITS — то, что даёт разбор заголовка
  const insunits = parsed.header ? parsed.header.$INSUNITS : undefined;
  const u = G.unitInfo(insunits);
  site.coordinateSystem.sourceUnits = u.label;
  site.coordinateSystem.unitScale = u.scale;
  site.coordinateSystem.assumedUnits = !!u.assumed;
  if (u.assumed) {
    // текст обязан совпадать с фактом: «не заданы» и «задан код, которого мы
    // не знаем» — разные беды с разной починкой. Раньше про $INSUNITS=7
    // (километры) говорилось «единицы не заданы», и масштаб уезжал в 10⁶ раз
    site.warnings.push(u.code === null || u.code === 0
      ? {
        code: 'units-assumed',
        message: `В чертеже «${fileName}» единицы измерения не заданы ` +
          `(${u.code === null ? '$INSUNITS отсутствует' : '$INSUNITS=0'}). ` +
          'Координаты приняты за метры — проверьте масштаб перед инженерными расчётами.',
      }
      : {
        code: 'units-unsupported',
        message: `В чертеже «${fileName}» код единиц $INSUNITS=${u.code === null ? 'отсутствует' : u.code} не распознан. ` +
          'Координаты приняты за метры — если чертёж выполнен в других единицах, все площади и расстояния будут неверны.',
      });
  }

  const scale = u.scale;
  const toMeters = (pts) => pts.map(([x, y]) => [x * scale, y * scale]);

  // Пространство листа отфильтровано разбором DXF, но человеку полезно знать,
  // что рамка и штамп в модель не попали, — иначе «пропавшие» контуры ищут зря.
  const paperCount = parsed.paperEntities
    ? [...parsed.paperEntities.values()].reduce((a, b) => a + b, 0) : 0;
  if (paperCount) {
    site.warnings.push({
      code: 'paper-space-skipped',
      message: `В чертеже «${fileName}» ${paperCount} сущностей лежат в пространстве листа ` +
        '(рамка, штамп, видовые экраны). Они исключены из геометрии участка — это оформление, а не местность.',
    });
  }

  const insertCount = parsed.inserts ? [...parsed.inserts.values()].reduce((a, b) => a + b, 0) : 0;
  if (insertCount) {
    site.warnings.push({
      code: 'blocks-not-parsed',
      message: `В чертеже «${fileName}» ${insertCount} вставок блоков (условных знаков) на ${parsed.inserts.size} видов. ` +
        'Содержимое блоков не разбирается: если контуры зданий или сетей собраны в блоки, ' +
        'их геометрии в модели участка нет. Расчленить блоки (EXPLODE) перед выгрузкой.',
    });
  }

  const parcelCandidates = [];
  const unclassified = [];
  for (const poly of parsed.polylines) {
    const rule = classifyLayer(poly.layer);
    let points = toMeters(poly.points);
    if (!rule) { unclassified.push({ poly, points }); continue; }
    const linear = LINEAR_TYPES.has(rule.type);
    const closed = linear ? false : !!poly.closed;
    // Замкнутая красная линия или сеть остаётся ЛОМАНОЙ (буфер вокруг кольца —
    // это не буфер вокруг залитой площадки), но замыкающий сегмент обязан
    // остаться: без него у контура 100×50 периметр выходил 250 м вместо 300.
    if (linear && poly.closed && points.length >= 3) points = [...points, points[0]];
    try {
      const object = G.addObject(site, G.makeObject({
        type: rule.type,
        points,
        closed,
        properties: {
          sourceUnits: u.label,
          ...(linear && poly.closed ? { closedRing: true } : {}),
        },
        provenance: {
          sourceFile: fileName,
          sourceFileId: source.fileId || null,
          sourceLayer: poly.layer || 'без слоя',
          sourceEntity: entityLabel(poly),
          extractionMethod: 'cad-vector',
          confidence: rule.confidence,
          reason: rule.reason,
        },
      }));
      if (rule.type === 'parcel') {
        parcelCandidates.push({
          layer: poly.layer || 'без слоя',
          areaM2: object.properties.areaM2 || 0,
          confidence: rule.confidence,
          reason: rule.reason,
          object,
        });
      }
      if (object.properties.selfIntersecting) {
        site.warnings.push({
          code: 'self-intersecting',
          message: `Контур со слоя «${poly.layer || 'без слоя'}» самопересекается. ` +
            `Площадь ${G.round(object.properties.areaM2, 2)} м² посчитана после автоматической починки контура ` +
            '(buffer 0) — проверьте порядок вершин в чертеже.',
        });
      }
    } catch (err) {
      site.warnings.push({ code: 'skipped-entity', message: `Контур со слоя «${poly.layer}» пропущен: ${err.message}` });
    }
  }

  // Участок не нашёлся по слоям — берём крупнейший замкнутый контур, но честно
  // помечаем низкой уверенностью: это догадка, а не данные чертежа.
  if (!site.parcel && unclassified.length) {
    const candidates = unclassified
      .filter((c) => c.poly.closed && c.points.length >= 3)
      .map((c) => ({ ...c, area: G.polygonAreaChecked(c.points).areaM2 }))
      .sort((a, b) => b.area - a.area);
    if (candidates.length) {
      const best = candidates[0];
      const object = G.addObject(site, G.makeObject({
        type: 'parcel',
        points: best.points,
        closed: true,
        provenance: {
          sourceFile: fileName,
          sourceFileId: source.fileId || null,
          sourceLayer: best.poly.layer || 'без слоя',
          sourceEntity: entityLabel(best.poly),
          extractionMethod: 'cad-vector',
          confidence: 0.35,
          reason: 'слой с границей участка не найден — взят крупнейший замкнутый контур чертежа',
        },
      }));
      parcelCandidates.push({
        layer: best.poly.layer || 'без слоя',
        areaM2: object.properties.areaM2 || 0,
        confidence: 0.35,
        reason: 'крупнейший замкнутый контур чертежа',
        object,
      });
      // соперники по этой же ветке — тоже кандидаты, человеку их надо видеть
      for (const c of candidates.slice(1, 6)) {
        parcelCandidates.push({
          layer: c.poly.layer || 'без слоя',
          areaM2: G.round(c.area, 2),
          confidence: 0.25,
          reason: 'замкнутый контур нераспознанного слоя',
          object: null,
        });
      }
      site.warnings.push({
        code: 'parcel-guessed',
        message: 'Границы участка определены по геометрии, а не по имени слоя. ' +
          'Требуется подтверждение: проверьте контур перед расчётом ограничений.',
      });
      unclassified.splice(unclassified.indexOf(best), 1);
    }
  }

  // остальное нераспознанное сохраняется как есть: потерять геометрию хуже,
  // чем сохранить её с низкой уверенностью и пометкой «тип не определён»
  for (const { poly, points } of unclassified) {
    try {
      G.addObject(site, G.makeObject({
        type: 'existingObject',
        points,
        closed: !!poly.closed,
        properties: { typeResolved: false },
        provenance: {
          sourceFile: fileName,
          sourceFileId: source.fileId || null,
          sourceLayer: poly.layer || 'без слоя',
          sourceEntity: poly.closed ? 'замкнутая полилиния' : 'полилиния',
          extractionMethod: 'cad-vector',
          confidence: 0.25,
          reason: 'слой не опознан — тип объекта не определён',
        },
      }));
    } catch { /* вырожденный контур: одна точка или дубли — молча пропускаем */ }
  }

  G.recomputeBounds(site);

  if (site.parcel) {
    for (const c of parcelCandidates) c.chosen = !!(c.object && c.object.id === site.parcel.id);
    auditParcelChoice(site, parcelCandidates, drawingExtent(parsed.header, scale, site.drawingBounds));
  } else if (parsed.polylines.length) {
    site.warnings.push({
      code: 'parcel-missing',
      message: `В чертеже «${fileName}» границы участка не определены: ни один слой не назван границей ЗУ ` +
        'и ни одного замкнутого контура не нашлось. Расчёт ТЭП, ограничений и посадки без границ невозможен.',
    });
  }
  return site;
}

/**
 * Габариты чертежа в метрах: сначала $EXTMIN/$EXTMAX заголовка, при их
 * отсутствии — фактические габариты разобранной геометрии.
 */
function drawingExtent(header, scale, fallbackBounds) {
  const x1 = header && header['$EXTMIN.10'], y1 = header && header['$EXTMIN.20'];
  const x2 = header && header['$EXTMAX.10'], y2 = header && header['$EXTMAX.20'];
  if ([x1, y1, x2, y2].every(Number.isFinite) && x2 > x1 && y2 > y1) {
    return { width: (x2 - x1) * scale, height: (y2 - y1) * scale };
  }
  if (fallbackBounds) {
    return { width: fallbackBounds.maxX - fallbackBounds.minX, height: fallbackBounds.maxY - fallbackBounds.minY };
  }
  return null;
}

/** Разбор файла с диска: DWG предварительно конвертируется в DXF. */
async function fromFile(storedPath, ext, source = {}) {
  const fs = require('fs');
  const dxfText = String(ext).toLowerCase() === 'dwg'
    ? await cad.convertDwgToDxf(storedPath)
    : fs.readFileSync(storedPath, 'utf8');
  return fromDxf(dxfText, source);
}

module.exports = { fromDxf, fromFile, classifyLayer, LAYER_RULES, PARCEL_RULES, auditParcelChoice };
