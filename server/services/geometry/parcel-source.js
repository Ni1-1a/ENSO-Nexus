'use strict';
/**
 * Границы земельного участка по ПОВОРОТНЫМ ТОЧКАМ из документа.
 *
 * Зачем это вообще понадобилось. Платформа брала границы ЗУ только из чертежа,
 * и на боевом комплекте (Горбунки) это провалилось начисто: в топосъёмке
 * «МСК-47_Горбунки.dwg» контура участка НЕТ ни на одном слое. Самое крупное,
 * что похоже на границу, — контур покрытия 72,39 м² со слоя «10_Границы
 * покрытий и угодий»; следующий по величине замкнутый контур — рамка листа
 * 7784 м². Участком становилось покрытие, и дальше всё считалось безупречно и
 * впустую: пятно допустимой застройки выходило 72 м² при потребных 1700, а
 * человек читал «здание не помещается» вместо «участок разобран не тот».
 *
 * При этом координаты участка есть — в ГПЗУ, на первой же странице, таблицей
 * характерных точек. Шесть строк дают полигон 3700,18 м² при заявленных
 * «3700 +/- 43 кв.м». Ровно это здесь и делается.
 *
 * Разделение ответственности не нарушается:
 *   модель ЧИТАЕТ числа из документа и переносит их с provenance;
 *   код СОБИРАЕТ полигон, определяет порядок осей, считает площадь и сверяет её
 *   с заявленной. Ни одного решения о геометрии модель не принимает.
 *
 * Порядок осей — не мелочь. В ЕГРН и ГПЗУ X — это северное направление
 * (422 xxx в МСК-47), Y — восточное (2195 xxx). В чертеже те же числа стоят
 * наоборот: X по горизонтали = 2195 xxx. Площадь при перестановке осей не
 * меняется (она инвариант), поэтому различать порядок по площади нельзя —
 * различаем по тому, какая раскладка попадает в габариты чертежа.
 */
const { db, now } = require('../../db');
const G = require('./site-geometry');
const adapter = require('../claude/adapter');
const { buildDocumentBlocks } = require('../claude/memory');
const registry = require('../ai/registry');
const progress = require('../progress');

/* ---------------- схема структурного ответа ---------------- */

/**
 * Строгий режим OpenAI-совместимых API требует, чтобы `required` перечислял ВСЕ
 * ключи `properties`; необязательность выражается пустой строкой или нулём, а не
 * отсутствием поля. Локальные движки вдобавок не понимают союз типов — здесь
 * союзов и нет намеренно.
 */
const PARCEL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['found', 'points', 'declaredAreaM2', 'areaToleranceM2', 'cadastralNumber',
    'coordinateSystem', 'firstColumnMeans', 'sourceDocument', 'sourcePage', 'quote', 'confidence', 'note'],
  properties: {
    found: { type: 'boolean', description: 'Найдена ли в документах таблица координат характерных точек границы участка' },
    points: {
      type: 'array',
      description: 'Характерные точки границы В ТОМ ЖЕ ПОРЯДКЕ, в каком они перечислены в документе. Порядок обхода менять нельзя.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['label', 'first', 'second'],
        properties: {
          label: { type: 'string', description: 'Обозначение точки из документа: «1», «н1» и т. п.' },
          first: { type: 'number', description: 'Число из ПЕРВОЙ координатной колонки таблицы, как напечатано' },
          second: { type: 'number', description: 'Число из ВТОРОЙ координатной колонки таблицы, как напечатано' },
        },
      },
    },
    declaredAreaM2: { type: 'number', description: 'Площадь участка, заявленная в документе, м². 0 — если не указана.' },
    areaToleranceM2: { type: 'number', description: 'Допуск площади из документа («3700 +/- 43») в м². 0 — если не указан.' },
    cadastralNumber: { type: 'string', description: 'Кадастровый номер участка. Пусто, если не указан.' },
    coordinateSystem: { type: 'string', description: 'Название системы координат из документа (МСК-47, зона 2 и т. п.). Пусто, если не названа.' },
    firstColumnMeans: {
      type: 'string',
      enum: ['X', 'Y', 'unknown'],
      description: 'Чем озаглавлена ПЕРВАЯ координатная колонка таблицы: X, Y или неизвестно',
    },
    sourceDocument: { type: 'string', description: 'Имя файла, откуда взята таблица' },
    sourcePage: { type: 'string', description: 'Страница или пункт документа' },
    quote: { type: 'string', description: 'Дословный заголовок таблицы или строка с площадью, до 300 знаков' },
    confidence: { type: 'number', description: 'Уверенность 0…1' },
    note: { type: 'string', description: 'Что помешало или что важно знать. Пусто, если всё чисто.' },
  },
};

const SYSTEM = `Ты — специалист по кадастру. Твоя единственная задача — ПЕРЕНЕСТИ из документов
таблицу координат характерных (поворотных) точек границы земельного участка.

Где искать: градостроительный план земельного участка (ГПЗУ), раздел «Описание границ
земельного участка» — «Перечень координат характерных точек в системе координат,
используемой для ведения Единого государственного реестра недвижимости»; выписка ЕГРН,
раздел с описанием местоположения границ.

ЖЕЛЕЗНЫЕ ПРАВИЛА:
1. Числа переносятся ДОСЛОВНО, со всеми знаками после запятой. Ты переписчик, а не счетовод:
   не округляй, не пересчитывай, не переставляй колонки местами. В поле first — число из
   первой координатной колонки, в second — из второй, ровно как в таблице.
2. Порядок строк сохраняется как в документе: это порядок обхода контура, и от него
   зависит, получится полигон или самопересекающаяся «бабочка».
3. Ничего не выдумывай. Нет таблицы координат — верни found=false и пустой список.
   Выдуманная граница участка хуже отсутствующей: по ней посадят здание.
4. Площадь участка и кадастровый номер бери из документа, а НЕ из своего расчёта по точкам.
   Их сверит приложение — расхождение и есть признак ошибки распознавания.
5. firstColumnMeans — то, чем колонка озаглавлена в таблице (буква X или Y), а не твоя
   догадка о том, что это значит географически.

Полигон, площадь и порядок осей считает приложение. Тебе их выдавать не нужно и нельзя.`;

/* ---------------- сборка полигона (детерминированно) ---------------- */

/** Замкнут ли контур сам на себя — тогда хвостовая точка лишняя. */
function dropClosingPoint(points) {
  if (points.length < 4) return points;
  const [fx, fy] = points[0];
  const [lx, ly] = points[points.length - 1];
  return Math.hypot(fx - lx, fy - ly) <= 0.02 ? points.slice(0, -1) : points;
}

/** Насколько контур выходит за габариты чертежа: 0 — целиком внутри. */
function outsideShare(points, bounds) {
  if (!bounds) return null;
  const out = points.filter(([x, y]) =>
    x < bounds.minX || x > bounds.maxX || y < bounds.minY || y > bounds.maxY).length;
  return out / points.length;
}

/**
 * Раскладка координат по осям чертежа.
 *
 * Проверяются обе: «как напечатано» и «колонки местами». Площадь при
 * перестановке не меняется, поэтому решает попадание в габариты чертежа,
 * а при их отсутствии — заголовок колонки из документа (ЕГРН: X — север).
 */
function orientations(raw, drawingBounds) {
  const direct = raw.map((p) => [p.first, p.second]);
  const swapped = raw.map((p) => [p.second, p.first]);
  return [
    { id: 'direct', points: direct, label: 'колонки как напечатаны (первая → X чертежа)' },
    { id: 'swapped', points: swapped, label: 'колонки переставлены (первая → Y чертежа)' },
  ].map((o) => ({ ...o, outside: outsideShare(o.points, drawingBounds) }));
}

/**
 * Собрать полигон участка из перенесённых точек.
 *
 * @param {object} record  {points, meta} — то, что прочла модель
 * @param {object} site    план, в габариты которого контур должен лечь (может быть без геометрии)
 * @returns {{ok: boolean, points?: Array, areaM2?: number, orientation?: string,
 *            warnings: Array<string>, errors: Array<string>, report: object}}
 */
function build(record, site = null) {
  const warnings = [];
  const errors = [];
  const meta = record.meta || {};
  const raw = (record.points || [])
    .map((p) => ({ label: String(p.label ?? ''), first: Number(p.first), second: Number(p.second) }))
    .filter((p) => Number.isFinite(p.first) && Number.isFinite(p.second));

  if (raw.length < 3) {
    errors.push(`Точек границы получено ${raw.length} — полигон строить не из чего (нужно не меньше трёх).`);
    return { ok: false, warnings, errors, report: { pointCount: raw.length } };
  }

  const bounds = site && site.drawingBounds ? site.drawingBounds : null;
  const variants = orientations(raw, bounds);

  // Выбор раскладки: сначала попадание в чертёж, при равенстве — заголовок колонки.
  let chosen = null;
  const fits = variants.filter((v) => v.outside !== null && v.outside === 0);
  if (fits.length === 1) {
    chosen = fits[0];
  } else if (fits.length === 2) {
    // обе укладываются — чертёж не различает; верим заголовку таблицы
    chosen = variants.find((v) => v.id === (meta.firstColumnMeans === 'Y' ? 'direct' : 'swapped')) || variants[1];
    warnings.push('Обе раскладки координат попадают в габариты чертежа — порядок осей выбран по заголовку ' +
      `колонки в документе («${meta.firstColumnMeans || 'не указан'}»). Проверьте положение участка на плане.`);
  } else if (bounds) {
    const best = [...variants].sort((a, b) => a.outside - b.outside)[0];
    chosen = best;
    warnings.push(`Ни одна раскладка координат не укладывается в габариты чертежа целиком: ` +
      `лучшая («${best.label}») выносит за них ${Math.round(best.outside * 100)}% точек. ` +
      'Вероятно, чертёж и документ выполнены в разных системах координат — проверьте систему в штампе топосъёмки.');
  } else {
    // чертежа нет — сравнивать не с чем; порядок берётся из заголовка колонки
    chosen = variants.find((v) => v.id === (meta.firstColumnMeans === 'Y' ? 'direct' : 'swapped')) || variants[1];
    warnings.push('Чертежа для сверки нет — порядок осей принят по заголовку колонки в документе.');
  }

  const points = dropClosingPoint(G.cleanPoints(chosen.points, true));
  if (points.length < 3) {
    errors.push('После удаления повторяющихся вершин осталось меньше трёх точек — контур вырожден.');
    return { ok: false, warnings, errors, report: { pointCount: raw.length } };
  }

  const checked = G.polygonAreaChecked(points);
  const areaM2 = G.round(checked.areaM2, 2);
  if (!(areaM2 > 0)) {
    errors.push('Площадь контура, собранного по точкам, нулевая — точки лежат на одной прямой или продублированы.');
    return { ok: false, warnings, errors, report: { pointCount: raw.length } };
  }
  if (checked.selfIntersecting) {
    warnings.push('Контур по точкам документа самопересекается: скорее всего, строки таблицы прочитаны не в том ' +
      `порядке. Площадь ${areaM2} м² посчитана после автоматической починки — сверьте её с документом.`);
  }

  // Сверка с заявленной площадью — главная проверка правильности переноса.
  const declared = Number(meta.declaredAreaM2) || 0;
  const tolerance = Number(meta.areaToleranceM2) || 0;
  let areaCheck = 'нет заявленной площади для сверки';
  if (declared > 0) {
    const delta = Math.abs(areaM2 - declared);
    // допуск из документа, иначе 0,5 % — предел, при котором ещё можно говорить
    // о той же границе, а не о другой (см. методику, шаг 1)
    const limit = tolerance > 0 ? tolerance : Math.max(declared * 0.005, 1);
    if (delta <= limit) {
      areaCheck = `сходится: ${areaM2} м² против заявленных ${declared} м² (расхождение ${G.round(delta, 2)} м² при допуске ${G.round(limit, 2)} м²)`;
    } else {
      areaCheck = `НЕ сходится: ${areaM2} м² против заявленных ${declared} м² (расхождение ${G.round(delta, 2)} м² при допуске ${G.round(limit, 2)} м²)`;
      errors.push(`Площадь контура по точкам (${areaM2} м²) расходится с заявленной в документе (${declared} м²) ` +
        `на ${G.round(delta, 2)} м² при допуске ${G.round(limit, 2)} м². Координаты прочитаны неверно либо ` +
        'таблица относится к другому участку — граница по ним не строится.');
      return { ok: false, warnings, errors, report: { areaM2, declared, tolerance, areaCheck, pointCount: points.length } };
    }
  } else {
    warnings.push(`Площадь участка в документе не названа — сверить контур ${areaM2} м² не с чем.`);
  }

  return {
    ok: true,
    points,
    areaM2,
    orientation: chosen.id,
    orientationLabel: chosen.label,
    warnings,
    errors,
    report: {
      areaM2, declared, tolerance, areaCheck,
      pointCount: points.length,
      orientation: chosen.label,
      cadastralNumber: meta.cadastralNumber || '',
      coordinateSystem: meta.coordinateSystem || '',
      sourceDocument: meta.sourceDocument || '',
      sourcePage: meta.sourcePage || '',
    },
  };
}

/** Объект участка из собранного контура — с честным происхождением. */
function toParcelObject(built, meta) {
  const src = meta.sourceDocument || 'документ';
  const where = meta.sourcePage ? `, ${meta.sourcePage}` : '';
  return G.makeObject({
    type: 'parcel',
    points: built.points,
    closed: true,
    properties: {
      fromDocument: true,
      cadastralNumber: meta.cadastralNumber || '',
      declaredAreaM2: Number(meta.declaredAreaM2) || null,
      coordinateSystemName: meta.coordinateSystem || '',
      axisOrder: built.orientationLabel,
    },
    provenance: {
      sourceFile: src,
      sourceFileId: meta.sourceFileId || null,
      sourceLayer: null,
      sourceEntity: `таблица координат характерных точек (${built.points.length} точек)`,
      extractionMethod: 'document-stated',
      confidence: Math.min(0.95, Math.max(0.5, Number(meta.confidence) || 0.9)),
      reason: `границы перенесены из документа «${src}»${where}; ${built.report.areaCheck}`,
      basis: meta.cadastralNumber ? `ЗУ ${meta.cadastralNumber}` : null,
    },
  });
}

/* ---------------- хранение ---------------- */

function get(sessionId) {
  const row = db.prepare('SELECT * FROM plan_parcel_source WHERE session_id = ?').get(sessionId);
  if (!row) return null;
  try {
    return {
      sessionId: row.session_id,
      points: JSON.parse(row.points) || [],
      meta: JSON.parse(row.meta) || {},
      author: row.author || '',
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  } catch { return null; }
}

function save(sessionId, { points, meta, author = '' }) {
  const ts = now();
  const exists = db.prepare('SELECT session_id FROM plan_parcel_source WHERE session_id = ?').get(sessionId);
  if (exists) {
    db.prepare('UPDATE plan_parcel_source SET points = ?, meta = ?, author = ?, updated_at = ? WHERE session_id = ?')
      .run(JSON.stringify(points), JSON.stringify(meta), String(author).slice(0, 120), ts, sessionId);
  } else {
    db.prepare('INSERT INTO plan_parcel_source (session_id, points, meta, author, created_at, updated_at) VALUES (?,?,?,?,?,?)')
      .run(sessionId, JSON.stringify(points), JSON.stringify(meta), String(author).slice(0, 120), ts, ts);
  }
  return get(sessionId);
}

function remove(sessionId) {
  const r = db.prepare('DELETE FROM plan_parcel_source WHERE session_id = ?').run(sessionId);
  return r.changes > 0;
}

/* ---------------- применение к плану ---------------- */

/**
 * Подставить границу из документа в план.
 *
 * Прежний контур не выбрасывается: он остаётся объектом плана с пометкой
 * `demotedFromParcel`. Исправление не имеет права уничтожать геометрию —
 * ровно то же правило действует для правок человека.
 *
 * Правки человека накладываются ПОСЛЕ этого, и потому последнее слово остаётся
 * за ним: назначил участком другой контур — им участок и станет.
 */
function applyTo(sessionId, site) {
  const record = get(sessionId);
  if (!record || !record.points || !record.points.length) return { applied: false };

  /*
   * Повторное наложение НИЧЕГО не делает.
   *
   * `ensurePlan` вызывается на каждом шаге, а этап зон ещё и сохраняет
   * получившийся план обратно в таблицу. Без этой проверки следующий вызов
   * подставлял границу поверх уже подставленной: настоящий участок уезжал в
   * «прочие объекты» с пометкой demotedFromParcel, рядом появлялся его двойник,
   * и в карточке согласования дважды стояло «границы взяты из документа», причём
   * второй раз — «прежний контур (3700.18 м², слой «null»)». Каждый проход
   * добавлял в план лишний полигон на 3700 м².
   */
  if (site.parcel && site.parcel.properties && site.parcel.properties.fromDocument
      && site.parcel.provenance && site.parcel.provenance.extractionMethod === 'document-stated') {
    return { applied: true, alreadyApplied: true };
  }

  const built = build(record, site);
  site.warnings = site.warnings || [];
  if (!built.ok) {
    site.warnings.push({
      code: 'parcel-document-failed',
      message: 'Границы участка из документа не построены: ' + built.errors.join(' ')
        + (built.warnings.length ? ' ' + built.warnings.join(' ') : ''),
    });
    return { applied: false, built };
  }

  const parcel = toParcelObject(built, record.meta || {});
  const prev = site.parcel;
  if (prev && prev.id !== parcel.id) {
    prev.properties = { ...prev.properties, demotedFromParcel: true, type: prev.type };
    prev.type = 'existingObject';
    site.existingObjects.push(prev);
  }
  site.parcel = parcel;

  // Предупреждение о ненадёжном выборе контура из чертежа больше не про что:
  // границу мы взяли не из чертежа. Оставлять его — значит пугать зря.
  site.warnings = site.warnings.filter((w) => !['parcel-doubtful', 'parcel-guessed', 'parcel-missing'].includes(w.code));
  for (const w of built.warnings) {
    site.warnings.push({ code: 'parcel-document-note', message: w });
  }
  const meta = record.meta || {};
  site.warnings.push({
    code: 'parcel-from-document',
    message: `Границы участка взяты не из чертежа, а из документа «${meta.sourceDocument || 'исходные данные'}»`
      + `${meta.sourcePage ? ` (${meta.sourcePage})` : ''}: ${built.points.length} характерных точек, `
      + `площадь ${built.areaM2} м², ${built.report.areaCheck}. Порядок осей — ${built.orientationLabel}.`
      + (prev ? ` Прежний контур (${prev.properties.areaM2} м², слой «${prev.provenance.sourceLayer}») сохранён в плане как существующий объект.` : ''),
  });

  G.recomputeBounds(site);
  return { applied: true, built, parcel };
}

/* ---------------- извлечение моделью ---------------- */

/**
 * Прочитать таблицу координат из документов сессии и сохранить её.
 * Геометрия здесь не строится — только перенос чисел с происхождением.
 */
async function extract(sessionId, { route, signal = null, author = '' } = {}) {
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
  adapter.checkBudget(session);

  progress.set(sessionId, {
    phase: 'preparing', provider: route.provider, model: adapter.resolveModel(route),
    label: 'Поиск координат характерных точек границы участка…',
  });

  /*
   * Сканы обязаны быть распознаны ДО того, как документы уйдут текстом.
   *
   * ГПЗУ — это скан с пустым текстовым слоем: без «изучения документации»
   * модель получает пустоту и честно отвечает «таблицы координат нет», хотя
   * таблица стоит на первой же странице. Проверено живым прогоном: без этого
   * вызова qwen3-vl-30b возвращал found=false за 17 секунд. Повторный вызов
   * ничего не стоит — распознанные страницы лежат в кэше.
   */
  await adapter.ensureDocumentsStudied(sessionId, { route, signal });

  const { blocks, manifest } = await buildDocumentBlocks(sessionId, registry.documentMode(route));
  const messages = [];
  if (manifest.length) messages.push({ role: 'user', content: `<uploaded_files>\n${manifest.join('\n')}\n</uploaded_files>` });
  if (blocks.length) messages.push({ role: 'user', content: blocks });
  messages.push({
    role: 'user',
    content: 'Найди в этих документах таблицу координат характерных точек границы земельного участка '
      + 'и перенеси её числа в JSON по схеме. Ничего не считай и не округляй. '
      + 'Таблицы нет — верни found=false.',
  });

  progress.set(sessionId, {
    phase: 'generating', provider: route.provider, model: adapter.resolveModel(route),
    label: 'Модель переносит координаты границы участка…',
  });

  const out = await adapter.structuredCall({
    system: SYSTEM,
    messages,
    sessionId,
    route,
    signal,
    schema: PARCEL_SCHEMA,
    schemaName: 'parcel_points',
  });

  const parsed = adapter.tryParse(out.text || '');
  if (!parsed) {
    throw new adapter.AiUnavailableError(out.truncated
      ? 'Ответ модели с координатами границы обрезан по лимиту токенов.'
      : 'Модель вернула неразбираемый ответ при переносе координат границы участка.');
  }
  if (!parsed.found || !Array.isArray(parsed.points) || parsed.points.length < 3) {
    return { found: false, note: parsed.note || 'Таблицы координат характерных точек в документах не найдено.' };
  }

  const meta = {
    declaredAreaM2: Number(parsed.declaredAreaM2) || 0,
    areaToleranceM2: Number(parsed.areaToleranceM2) || 0,
    cadastralNumber: String(parsed.cadastralNumber || '').slice(0, 60),
    coordinateSystem: String(parsed.coordinateSystem || '').slice(0, 120),
    firstColumnMeans: ['X', 'Y'].includes(parsed.firstColumnMeans) ? parsed.firstColumnMeans : 'unknown',
    sourceDocument: String(parsed.sourceDocument || '').slice(0, 200),
    sourcePage: String(parsed.sourcePage || '').slice(0, 60),
    quote: String(parsed.quote || '').slice(0, 300),
    confidence: Number(parsed.confidence) || 0.8,
    note: String(parsed.note || '').slice(0, 500),
    extractedAt: now(),
    extractedBy: adapter.resolveModel(route),
  };
  const points = parsed.points.slice(0, 200).map((p) => ({
    label: String(p.label ?? '').slice(0, 16),
    first: Number(p.first),
    second: Number(p.second),
  })).filter((p) => Number.isFinite(p.first) && Number.isFinite(p.second));

  save(sessionId, { points, meta, author });
  return { found: true, points, meta };
}

/** Признак того, что границы из чертежа брать нельзя и нужен документ. */
function drawingParcelIsDoubtful(site) {
  if (!site) return true;
  if (!site.parcel) return true;
  const codes = new Set((site.warnings || []).map((w) => w && w.code));
  return codes.has('parcel-doubtful') || codes.has('parcel-guessed') || codes.has('parcel-missing');
}

module.exports = {
  PARCEL_SCHEMA, SYSTEM,
  build, toParcelObject, applyTo, extract, drawingParcelIsDoubtful,
  get, save, remove,
  // для тестов
  orientations, dropClosingPoint,
};
