'use strict';
/**
 * Placement Engine (ТЗ, п. 40–42).
 *
 * Генерирует реальные пятна застройки и проверяет их. Модель сюда не заглядывает:
 * её дело — стратегии и смыслы, координаты считает код. Одни и те же требования
 * на одной и той же геометрии дают тот же результат.
 *
 * Что проверяется у каждого кандидата (ТЗ, п. 42):
 * выход за участок, пересечения с существующими объектами, попадание в зоны
 * ограничений, площадь, габариты, ориентация. Нарушения не скрываются: кандидат
 * с нарушением возвращается помеченным, а не выбрасывается — решение за человеком.
 */
const jts = require('./jts');
const G = require('./site-geometry');
const shapes = require('./shapes');

/** Углы поворота пробуются не наугад: здание обычно ставят вдоль границ участка. */
const EXTRA_ANGLES = [0, 90];
const MAX_ANGLES = 6;

/** Соотношения сторон габарита, когда задана только площадь. */
const ASPECT_RATIOS = [1, 1.5, 2.2, 3];

/** Проходы по сетке: грубый и уплотнённый. Второй включается, только если
 *  форма не нашла ни одного положения — см. цикл в generate. */
const GRID_PASSES = [30, 70];
const GRID_STEPS = 30;        // узлов сетки по длинной стороне (совместимость)
const MAX_CANDIDATES = 1200;  // потолок перебора НА ФОРМУ: движок обязан отвечать быстро
const PER_SHAPE_KEEP = 24;    // сколько удачных пятен запоминать на форму

/* ---------------- требования к зданию ---------------- */

/**
 * Приведение пользовательских требований. Возвращает {req, errors}.
 * Противоречивые требования не «поправляются» молча — о них говорится прямо.
 */
function normalizeRequirements(raw = {}) {
  const errors = [];
  const num = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null);

  const req = {
    areaM2: num(raw.areaM2),
    width: num(raw.width),
    length: num(raw.length),
    floors: num(raw.floors),
    minWidth: num(raw.minWidth),
    maxWidth: num(raw.maxWidth),
    minLength: num(raw.minLength),
    maxLength: num(raw.maxLength),
    orientationDeg: Number.isFinite(Number(raw.orientationDeg)) ? Number(raw.orientationDeg) : null,
    allowRotate: raw.allowRotate !== false,
    allowReshape: raw.allowReshape !== false,
    notes: String(raw.notes || '').slice(0, 2000),
  };

  if (!req.areaM2 && !(req.width && req.length)) {
    errors.push('Не задана ни площадь застройки, ни габариты здания — генерировать нечего.');
  }
  if (req.width && req.length && req.areaM2) {
    const implied = req.width * req.length;
    if (Math.abs(implied - req.areaM2) / req.areaM2 > 0.02) {
      errors.push(`Габариты ${req.width}×${req.length} дают ${Math.round(implied)} м², ` +
        `а требуемая площадь — ${req.areaM2} м². Уточните, что важнее.`);
    }
  }
  if (req.minWidth && req.maxWidth && req.minWidth > req.maxWidth) errors.push('Минимальная ширина больше максимальной.');
  if (req.minLength && req.maxLength && req.minLength > req.maxLength) errors.push('Минимальная длина больше максимальной.');
  return { req, errors };
}

/**
 * Варианты «форма + габарит»: заданные пользователем плюс, если разрешено
 * менять форму, производные по всем формам из shapes.js.
 *
 * Габарит подбирается так, чтобы совпала площадь ФИГУРЫ. У Г-образного корпуса
 * габарит на треть больше площади застройки — считать их одним числом нельзя.
 */
function dimensionVariants(req) {
  const out = [];
  const push = (shape, w, l, reshaped) => {
    if (!(w > 0 && l > 0)) return;
    if (req.minWidth && w < req.minWidth) return;
    if (req.maxWidth && w > req.maxWidth) return;
    if (req.minLength && l < req.minLength) return;
    if (req.maxLength && l > req.maxLength) return;
    const key = `${shape}:${w.toFixed(2)}x${l.toFixed(2)}`;
    if (out.some((v) => v.key === key)) return;
    out.push({ key, shape, width: round(w), length: round(l), reshaped });
  };

  // Заданы конкретные габариты — это коробка пользователя, форму не выдумываем.
  if (req.width && req.length) {
    push('rect', req.width, req.length, false);
    if (req.allowRotate) push('rect', req.length, req.width, false); // та же форма, другая ориентация
  }
  if (req.areaM2 && req.allowReshape) {
    for (const id of shapes.ids()) {
      for (const k of ASPECT_RATIOS) {
        const box = shapes.boxFor(id, req.areaM2, k);
        if (box) push(id, box.width, box.length, true);
        // вытянутость поперёк: у несимметричных форм это другое пятно
        const flipped = shapes.boxFor(id, req.areaM2, 1 / k);
        if (k !== 1 && flipped) push(id, flipped.width, flipped.length, true);
      }
    }
  }
  // площадь без права менять форму: квадрат как единственный честный вариант
  if (!out.length && req.areaM2) {
    const side = Math.sqrt(req.areaM2);
    push('rect', side, side, true);
  }
  return out;
}

const round = (n) => Math.round(n * 100) / 100;
const rad = (deg) => (deg * Math.PI) / 180;

/**
 * Прямоугольник по центру, габаритам и углу поворота (против часовой стрелки).
 * `origin` — начало локальной системы: сантиметровое округление считается
 * от него, а не от абсолютной величины координаты (см. shapes.footprint).
 */
function rectFootprint(cx, cy, width, length, angleDeg, origin = null) {
  const a = rad(angleDeg);
  const ca = Math.cos(a); const sa = Math.sin(a);
  const hw = width / 2; const hl = length / 2;
  const ox = origin ? origin[0] : 0;
  const oy = origin ? origin[1] : 0;
  return [[-hw, -hl], [hw, -hl], [hw, hl], [-hw, hl]]
    .map(([x, y]) => [round(cx + x * ca - y * sa) + ox, round(cy + x * sa + y * ca) + oy]);
}

/** Пятно любой формы: прямоугольник строится прежним кодом, остальное — shapes.js. */
function shapeFootprint(shape, cx, cy, width, length, angleDeg, origin = null) {
  if (!shape || shape === 'rect') return rectFootprint(cx, cy, width, length, angleDeg, origin);
  return shapes.footprint(shape, cx, cy, width, length, angleDeg, origin);
}

/** Углы поворота: направления сторон участка плюс ортогональные. */
/** Направления сторон контура, длиннее порога: короткие срезы углов не в счёт. */
function edgeAngles(points, minLen = 3) {
  const out = [];
  if (!points) return out;
  for (let i = 0; i < points.length; i++) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[(i + 1) % points.length];
    const len = Math.hypot(x2 - x1, y2 - y1);
    if (len < minLen) continue;
    out.push({ angle: normAngle((Math.atan2(y2 - y1, x2 - x1) * 180) / Math.PI), len });
  }
  return out;
}

/**
 * Углы поворота: стороны ДОПУСТИМОЙ ТЕРРИТОРИИ, потом стороны участка,
 * потом ортогональные.
 *
 * Раньше брались только стороны участка — и на треугольной площадке в Горбунках
 * (участок 3700 м², допустимая территория 2919 м² после отступа) ни одно
 * положение не находилось: чтобы вписаться в треугольник, пятно обязано идти
 * вдоль ЕГО сторон, а они не совпадают со сторонами участка. Длинные стороны
 * идут первыми: вдоль них помещается больше.
 */
function candidateAngles(site, req, buildableGeometry = null) {
  if (req.orientationDeg !== null && !req.allowRotate) return [normAngle(req.orientationDeg)];
  const angles = [];
  const push = (a) => { if (!angles.includes(a)) angles.push(a); };
  if (req.orientationDeg !== null) push(normAngle(req.orientationDeg));
  if (req.allowRotate) {
    const fromArea = edgeAngles(buildableGeometry && buildableGeometry.points).sort((a, b) => b.len - a.len);
    for (const e of fromArea) push(e.angle);
    for (const e of edgeAngles(site.parcel && site.parcel.geometry.points)) push(e.angle);
  }
  for (const a of EXTRA_ANGLES) push(a);
  return angles.slice(0, MAX_ANGLES);
}

/**
 * Точка внутри контура (лучевой алгоритм, с учётом отверстий).
 *
 * Нужна как ДЕШЁВЫЙ отсев узлов сетки: сетка строится по габариту допустимой
 * территории, а территория занимает лишь часть этого габарита — у треугольника
 * меньше половины. Раньше бюджет перебора уходил на узлы за её пределами:
 * пятно там строилось, переводилось в JTS и только потом отбрасывалось.
 */
function pointInRing(ring, x, y) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function pointInGeometry(geometry, x, y) {
  if (!geometry) return true; // не знаем формы — не отсеиваем
  const polys = geometry.type === 'multipolygon'
    ? (geometry.polygons || [])
    : [{ points: geometry.points || [], holes: geometry.holes || [] }];
  for (const p of polys) {
    if (!pointInRing(p.points, x, y)) continue;
    if ((p.holes || []).some((h) => pointInRing(h, x, y))) continue;
    return true;
  }
  return false;
}

function normAngle(deg) {
  let a = deg % 180;
  if (a < 0) a += 180;
  return round(a);
}

/* ---------------- проверка кандидата ---------------- */

/**
 * Полная проверка пятна. Возвращает нарушения (делают вариант недопустимым)
 * и замечания (не запрещают, но требуют внимания).
 */
function validate(site, footprintPoints, req, ctx = {}) {
  const violations = [];
  const warnings = [];
  const geom = { type: 'polygon', closed: true, points: footprintPoints };
  const fp = jts.toJts(geom);
  // Пустая после починки геометрия ничему не within(), и раньше это давало
  // бессмысленное «пятно выходит за границы участка на 0 м²» вместо честного
  // «пятно выродилось». Площадь тоже считается по JTS, а не шнурованием:
  // на самопересекающемся пятне шнурование выдаёт 0 при ненулевой фигуре.
  if (!fp || fp.isEmpty() || !(jts.area(fp) > 0)) {
    return {
      violations: [{ code: 'degenerate', message: 'Пятно выродилось (нулевая площадь) — проверять нечего' }],
      warnings: [], affected: [], removed: [], areaM2: 0,
    };
  }
  const areaM2 = round(jts.area(fp));

  // выход за границы участка
  const parcel = ctx.parcelJts || (site.parcel ? jts.toJts(site.parcel.geometry) : null);
  if (parcel) {
    if (!fp.within(parcel)) {
      const outside = jts.difference(fp, parcel);
      violations.push({
        code: 'outside-parcel',
        message: `Пятно выходит за границы участка на ${round(jts.area(outside) || 0)} м²`,
      });
    }
  } else {
    warnings.push({ code: 'no-parcel', message: 'Границы участка не определены — выход за участок не проверен' });
  }

  // попадание в зоны ограничений
  for (const z of site.restrictions || []) {
    const zg = jts.toJts(z.geometry);
    if (!zg || !jts.overlaps(fp, zg)) continue;   // вырожденная зона проверке не мешает
    const overlap = round(jts.area(fp.intersection(zg)));
    violations.push({
      code: 'restriction-overlap',
      message: `Пересечение с зоной «${z.properties.kind}» — ${overlap} м² (${z.properties.statusLabel || ''})`,
      restrictionId: z.id,
      overlapM2: overlap,
    });
  }

  /*
   * Пересечения с существующими объектами — это мероприятия (ТЗ, п. 47).
   *
   * ВОЗДЕЙСТВИЕМ варианта считается только то, что на площадке ОСТАНЕТСЯ.
   * Здание, уже назначенное человеком под снос, попадает в отдельный список
   * `removed`: мероприятие по нему остаётся (объём демонтажа — настоящая работа
   * и обязан попасть в ТЭП), но воздействием этого пятна оно не является —
   * его убирают с площадки в любом случае, где бы здание ни встало.
   *
   * Пока снесённые считались задетыми, платформа выбирала пятно, обходящее
   * здание, которого уже не будет: на боевом плане Горбунков из 15 «задетых»
   * объектов варианта 1 двое были под снос, и от них варианты и уворачивались.
   * Отбор по наименьшему воздействию и подбор непохожих вариантов шли по
   * заведомо ложному числу.
   */
  const affected = [];
  const removed = [];
  for (const key of ['buildings', 'existingObjects', 'utilities']) {
    for (const obj of site[key] || []) {
      const og = jts.toJts(obj.geometry);
      if (!og) continue;
      const hit = obj.geometry.type === 'polyline'
        ? fp.intersects(og)
        : jts.overlaps(fp, og);
      if (!hit) continue;
      const decided = (obj.properties && obj.properties.relocation) || '';
      const rec = {
        id: obj.id,
        layer: key,
        sourceLayer: obj.provenance.sourceLayer,
        areaM2: obj.properties.areaM2 || null,
        lengthM: obj.properties.lengthM || null,
        decided: decided === 'demolish' || decided === 'move' ? decided : '',
      };
      (rec.decided ? removed : affected).push(rec);
    }
  }

  // площадь и габариты относительно требований
  if (req.areaM2) {
    const diff = (areaM2 - req.areaM2) / req.areaM2;
    if (Math.abs(diff) > 0.02) {
      const rec = { code: 'area-mismatch', message: `Площадь ${areaM2} м² вместо требуемых ${req.areaM2} м² (${diff > 0 ? '+' : ''}${Math.round(diff * 100)}%)` };
      (req.allowReshape ? warnings : violations).push(rec);
    }
  }
  return { violations, warnings, affected, removed, areaM2 };
}

/* ---------------- генерация ---------------- */

/**
 * Кандидаты посадки внутри допустимой территории.
 * @param {object} site      SiteGeometry (с ограничениями, если они посчитаны)
 * @param {object} buildable результат движка ограничений (может быть null)
 * @param {object} rawReq    требования пользователя
 */
function generate(site, buildable, rawReq, { limit = 24 } = {}) {
  const { req, errors } = normalizeRequirements(rawReq);
  if (errors.length) return { candidates: [], errors, tried: 0, warnings: [] };

  const area = buildable && buildable.geometry ? jts.toJts(buildable.geometry)
    : (site.parcel ? jts.toJts(site.parcel.geometry) : null);
  if (!area) {
    return {
      candidates: [],
      errors: ['Нет ни допустимой территории, ни границ участка — размещать не в чем.'],
      tried: 0, warnings: [],
    };
  }

  // Вырожденная территория: пустой конверт JTS отдаёт перевёрнутые границы,
  // цикл перебора не делает ни одной итерации, и наружу уходит «мест нет» —
  // неотличимо от честного «здание не влезло». Различать важно: в одном случае
  // человек уменьшает здание, в другом — чинит чертёж.
  const b = boundsOfJts(area);
  if (!(jts.area(area) > 0) || !(b.maxX > b.minX) || !(b.maxY > b.minY)) {
    return {
      candidates: [],
      errors: ['Геометрия территории для посадки вырождена: нулевая площадь. ' +
        'Скорее всего, за границы участка принят неверный или самопересекающийся контур чертежа — ' +
        'проверьте разбор участка, требования к зданию здесь ни при чём.'],
      tried: 0,
      warnings: [{
        code: 'placement-area-degenerate',
        message: 'Посадка не выполнялась: площадь допустимой территории равна нулю.',
      }],
    };
  }

  const parcelJts = site.parcel ? jts.toJts(site.parcel.geometry) : null;
  const variants = dimensionVariants(req);
  if (!variants.length) {
    return {
      candidates: [],
      errors: ['Требования к габаритам противоречивы: ни один вариант размеров не подходит.'],
      tried: 0, warnings: [],
    };
  }
  const areaGeometry = buildable && buildable.geometry
    ? buildable.geometry
    : (site.parcel ? site.parcel.geometry : null);
  const angles = candidateAngles(site, req, areaGeometry);

  // Перебор идёт в ЛОКАЛЬНОЙ системе от начала территории: в МСК-47 координаты
  // порядка 2 200 000, и округление до сантиметра от абсолютной величины
  // сдвигало вершины ровно настолько, чтобы отбор четырёх вариантов давал
  // другой набор форм для того же по сути участка.
  const origin = [round(b.minX), round(b.minY)];
  const localMinX = b.minX - origin[0];
  const localMinY = b.minY - origin[1];
  const localMaxX = b.maxX - origin[0];
  const localMaxY = b.maxY - origin[1];

  const stepX = Math.max((b.maxX - b.minX) / GRID_STEPS, 0.5);
  const stepY = Math.max((b.maxY - b.minY) / GRID_STEPS, 0.5);

  // Бюджет перебора считается ПО ФОРМАМ, а не общий: иначе прямоугольник
  // с его удачными пропорциями съедает весь лимит, и Г-образная форма до
  // проверки не доходит — а именно она часто и есть единственная посадка.
  const byShape = new Map();
  for (const v of variants) {
    if (!byShape.has(v.shape)) byShape.set(v.shape, []);
    byShape.get(v.shape).push(v);
  }

  /**
   * Узлы сетки — ТОЛЬКО внутри допустимой территории.
   *
   * Сетка строится по габариту, а территория занимает лишь его часть: у
   * треугольной площадки в Горбунках — 2919 м² из габарита 86 × 76 = 6536 м²,
   * то есть больше половины узлов заведомо мимо. Раньше бюджет уходил на них:
   * пятно строилось, переводилось в JTS и только потом отбрасывалось.
   */
  const makeSpots = (steps) => {
    const sx = Math.max((b.maxX - b.minX) / steps, 0.5);
    const sy = Math.max((b.maxY - b.minY) / steps, 0.5);
    const out = [];
    for (let cx = localMinX; cx <= localMaxX; cx += sx) {
      for (let cy = localMinY; cy <= localMaxY; cy += sy) {
        if (pointInGeometry(areaGeometry, cx + origin[0], cy + origin[1])) out.push([cx, cy]);
      }
    }
    return out;
  };

  const found = [];
  let tried = 0;
  for (const [shape, list] of byShape) {
    const shapeFound = [];
    /*
     * Два прохода по сетке. Сначала грубая; если форма не нашла НИ ОДНОГО
     * положения — вдвое частая по той же территории.
     *
     * Частить сразу дорого и незачем: на просторной площадке хватает грубой.
     * Не частить вовсе — значит отвечать «мест нет» там, где место есть, но
     * узкое: на треугольнике в Горбунках 1790 м² в 2919 м² свободных с шагом
     * 2,5 м не ловились ни в одном узле.
     */
    for (const steps of GRID_PASSES) {
      const spots = makeSpots(steps);
      if (!spots.length) continue;

      // Сочетания «габарит × поворот × узел сетки». Раньше они перебирались
      // подряд и упирались в потолок бюджета на левом краю участка: на реальной
      // площадке в Горбунках здание 200 м² помещалось в правой её половине,
      // а движок туда просто не доходил и отвечал «мест нет». Теперь сочетания
      // берутся с равномерным шагом — бюджет тот же, но покрывает ВЕСЬ участок.
      const combos = [];
      for (const v of list) {
        for (const angle of angles) {
          for (const [cx, cy] of spots) combos.push([v, angle, cx, cy]);
        }
      }
      const stride = Math.max(1, Math.ceil(combos.length / MAX_CANDIDATES));
      for (let i = 0; i < combos.length && shapeFound.length < PER_SHAPE_KEEP; i += stride) {
        const [v, angle, cx, cy] = combos[i];
        tried++;
        const pts = shapeFootprint(shape, cx, cy, v.width, v.length, angle, origin);
        const fp = jts.toJts({ type: 'polygon', closed: true, points: pts });
        // быстрый отсев: пятно обязано целиком лежать в допустимой территории
        if (!fp || !fp.within(area)) continue;
        const check = validate(site, pts, req, { parcelJts });
        shapeFound.push({
          footprint: { type: 'polygon', closed: true, points: pts },
          shape,
          shapeLabel: shapes.label(shape),
          shapeNote: shapes.note(shape),
          width: v.width,
          length: v.length,
          rotationDeg: angle,
          reshaped: v.reshaped,
          center: [round(cx) + origin[0], round(cy) + origin[1]],
          areaM2: check.areaM2,
          floors: req.floors,
          violations: check.violations,
          warnings: check.warnings,
          affected: check.affected,
          removed: check.removed,
          admissible: check.violations.length === 0,
        });
      }
      if (shapeFound.length) break; // грубой сетки хватило — частить незачем
    }
    found.push(...shapeFound);
  }

  // сортировка: сначала допустимые, потом крупные, потом ближе к центру территории
  const centre = [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2];
  found.sort((p, q) =>
    (q.admissible - p.admissible)
    || (q.areaM2 - p.areaM2)
    || (dist(p.center, centre) - dist(q.center, centre)));

  // Пустая выдача без объяснения читается как «система сломалась». Здесь уже
  // известны обе величины, которые всё решают: сколько нужно и сколько есть.
  // Это НЕ ошибка требований (errors остаётся пустым — так его читает вызывающий
  // код), а причина отсутствия мест: она уходит в warnings и в поле reason.
  if (!found.length) {
    const availableM2 = round(jts.area(area));
    const neededM2 = req.areaM2 || (req.width && req.length ? round(req.width * req.length) : 0);
    const tight = neededM2 && availableM2 < neededM2;
    const reason = tight
      ? `Здание не помещается: нужно ${neededM2} м² застройки, а свободно от ограничений ` +
        `всего ${availableM2} м².`
      : `Свободной площади хватает (${availableM2} м² против ${neededM2 || '?'} м² застройки), ` +
        'но ни одно положение здания не уместилось целиком в допустимую территорию.';

    /*
     * Одного «не помещается» мало.
     *
     * Раньше здесь стоял совет из трёх глаголов без единого числа: «уменьшите
     * площадь, поднимите этажность или пересмотрите ограничения». Насколько
     * уменьшить, до скольких этажей поднять и какое из ограничений
     * пересматривать — человек выяснял сам, а посчитать это может только код:
     * он один знает, сколько метров вернёт снятие каждой зоны. Мероприятия
     * считаются детерминированно (geometry/placement-relief.js) и уходят в тот
     * же ответ — и в reason, и отдельным полем для карточки.
     */
    let relief = null;
    try {
      // считаем по ТОЙ ЖЕ территории, по которой шёл перебор: зон могло не быть
      // вовсе, и тогда допустимая территория — это сам участок
      const territory = buildable && buildable.geometry ? buildable
        : (site.parcel ? { geometry: site.parcel.geometry } : null);
      relief = require('./placement-relief').analyse(site, territory, req);
    } catch (err) {
      // мероприятия — надстройка: их отсутствие не должно ронять ответ движка
      console.warn('[placement] мероприятия не посчитаны:', err.message);
    }
    const full = relief ? require('./placement-relief').toText(reason, relief) : reason;
    return {
      candidates: [],
      errors: [],
      reason: full,
      relief,
      tried,
      total: 0,
      warnings: [{ code: 'placement-empty', message: full }],
    };
  }

  // В выдачу попадают ВСЕ формы по очереди, а не только лучшая: иначе список
  // кандидатов состоит из одного прямоугольника, сдвинутого на метр, и отбирать
  // из него различающиеся варианты не из чего.
  return { candidates: interleaveByShape(found, limit), errors: [], tried, total: found.length, warnings: [] };
}

/** Круговой обход групп «форма + габарит»: каждая форма получает место в выдаче. */
function interleaveByShape(candidates, limit) {
  const groups = new Map();
  for (const c of candidates) {
    const key = `${c.shape || 'rect'}:${c.width}x${c.length}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }
  const lists = [...groups.values()];
  const out = [];
  for (let i = 0; out.length < limit; i++) {
    let added = false;
    for (const list of lists) {
      if (i >= list.length) continue;
      out.push(list[i]);
      added = true;
      if (out.length >= limit) break;
    }
    if (!added) break;
  }
  return out;
}

function dist(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1]); }

function boundsOfJts(geom) {
  const env = geom.getEnvelopeInternal();
  return { minX: env.getMinX(), minY: env.getMinY(), maxX: env.getMaxX(), maxY: env.getMaxY() };
}

module.exports = {
  generate, validate, interleaveByShape, normalizeRequirements, dimensionVariants,
  rectFootprint, shapeFootprint, candidateAngles, boundsOfJts, SHAPES: shapes.SHAPES,
};
