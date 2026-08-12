'use strict';
/**
 * Вёрстка комплекта по выбранному варианту.
 *
 * Комплект — это документ, который человек распечатает, подошьёт и понесёт на
 * согласование. Поэтому здесь не «страница с таблицами», а обычный проектный
 * материал: титул с реквизитами, нумерованные разделы, схемы с легендой,
 * ведомости с основаниями и колонтитул с номером листа.
 *
 * Всё, что печатается, берётся из ЖИВОЙ модели: площади — из геометрии,
 * статусы — из записей, цвета зон — из того же `ZoneStyle`, которым план
 * нарисован на экране. Замороженная на момент сохранения подпись врёт: решение
 * по мероприятию могло быть принято позже, а зоны — пересчитаны после правки.
 *
 * PDF печатается из этой разметки headless-браузером (services/render.js), и в
 * файле остаётся живой текст, а не картинка: его можно искать и копировать.
 */
const G = require('./site-geometry');
const RR = require('./restriction-rules');
const ZoneStyle = require('../../../public/zone-style.js');
const critical = require('./critical-objects');

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const num = (n, digits = 2) => (Number.isFinite(Number(n))
  ? Number(n).toLocaleString('ru-RU', { minimumFractionDigits: 0, maximumFractionDigits: digits })
  : '—');

const VARIANT_STATUS = {
  admissible: 'допустим',
  needs_decision: 'требует решения пользователя',
  violations: 'есть нарушения',
  rejected: 'отклонён решением пользователя',
};

const RELOCATION_LABELS = {
  undecided: 'решение не принято', keep: 'сохраняется',
  move: 'переносится', demolish: 'сносится (демонтаж)',
};

function statusLabel(variant) {
  if (!variant) return '—';
  return VARIANT_STATUS[variant.status] || variant.statusLabel || variant.status || '—';
}

/* ---------------- мелкие блоки вёрстки ---------------- */

/** Таблица «показатель → значение»: ей набраны все реквизитные блоки. */
function facts(rows) {
  const body = rows.filter(Boolean)
    .map(([k, v]) => `<tr><th>${esc(k)}</th><td>${v == null ? '<span class="muted">не указано</span>' : v}</td></tr>`)
    .join('');
  return `<table class="facts">${body}</table>`;
}

function table(head, rows, { className = '' } = {}) {
  if (!rows.length) return '';
  const th = head.map((h) => `<th>${esc(h)}</th>`).join('');
  const tr = rows.map((cells) => `<tr>${cells.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('');
  return `<table class="${className}"><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table>`;
}

/** Квадратик цвета зоны — тот же цвет, что и на схеме рядом. */
function chip(color) {
  return `<span class="chip" style="background:${esc(color)}"></span>`;
}

function note(text) {
  return `<p class="note">${esc(text)}</p>`;
}

function missing(text) {
  return `<p class="muted">${esc(text)}</p>`;
}

/* ---------------- разделы ---------------- */

/**
 * Сводка по объектам, порождающим ограничения.
 *
 * Она же строится в интерфейсе и в чертеже — правило одно на всех: цвет
 * принадлежит ОБЪЕКТУ, угол штриховки — типу ограничения. Иначе разговор
 * «синяя зона» между экраном, отчётом и чертежом не состоится.
 */
function sourcesOf(restrictions) {
  const assign = ZoneStyle.assignColors(restrictions || []);
  const map = new Map();
  for (const z of restrictions || []) {
    const a = assign.byZone[z.id];
    if (!a) continue;
    const p = z.properties || {};
    const cur = map.get(a.key) || {
      color: a.color,
      label: p.sourceLabel || 'объект не назван',
      layer: p.sourceLayer || '',
      kinds: new Map(),
      areaM2: 0,
    };
    cur.areaM2 += Number(p.areaM2) || 0;
    const kindKey = RR.KIND_LABELS[p.kind] || p.kind || 'ограничение';
    const prev = cur.kinds.get(kindKey) || { valueM: p.valueM, count: 0 };
    prev.count += 1;
    cur.kinds.set(kindKey, prev);
    map.set(a.key, cur);
  }
  return [...map.values()]
    .map((s) => ({ ...s, kinds: [...s.kinds.entries()] }))
    .sort((a, b) => b.areaM2 - a.areaM2);
}

/** Раздел 1. Титул и реквизиты. */
function titleBlock({ session, site, variant, date }) {
  const parcel = site.parcel;
  const p = (parcel && parcel.properties) || {};
  const src = (parcel && parcel.provenance) || {};
  return `
<section class="title-page">
  <p class="brand">Enso-nexus · автоматизированная посадка объекта на земельный участок</p>
  <h1>${esc(session.title || 'Проект без названия')}</h1>
  <p class="subtitle">Комплект материалов по выбранному варианту размещения</p>
  <h2>1. Общие сведения</h2>
  ${facts([
    ['Земельный участок', p.cadastralNumber ? esc(p.cadastralNumber) : null],
    ['Площадь участка', parcel ? `${num(p.areaM2)} м²` : null],
    ['Границы участка приняты по', src.sourceFile
      ? `${esc(src.sourceFile)}${src.sourceEntity ? `, ${esc(src.sourceEntity)}` : ''}`
      : (src.sourceLayer ? `чертежу, слой «${esc(src.sourceLayer)}»` : null)],
    ['Система координат', p.coordinateSystemName
      ? esc(p.coordinateSystemName)
      : esc(site.coordinateSystem && site.coordinateSystem.sourceUnits)],
    ['Выбранный вариант', variant ? `№ ${esc(variant.number)} — ${esc(statusLabel(variant))}` : null],
    ['Дата формирования', esc(date)],
  ])}
  <p class="disclaimer">Документ сформирован автоматически по исходным данным проекта.
  Потенциально допустимая территория — аналитический результат расчёта по учтённым
  ограничениям, а не разрешённое пятно застройки. Перед выпуском проверьте основания,
  перечисленные в разделе 3.</p>
</section>`;
}

/** Раздел 2. Исходные данные. */
function sourceDataSection({ site, files }) {
  const docs = (files || []).map((f) => [
    esc(f.original_name || f.name || ''),
    esc(String(f.ext || '').toUpperCase()),
    f.size ? `${num(Math.round(f.size / 1024), 0)} КБ` : '—',
  ]);
  const cs = site.coordinateSystem || {};
  const parcel = site.parcel;
  const pp = (parcel && parcel.properties) || {};

  const declared = Number(pp.declaredAreaM2) || 0;
  const measured = Number(pp.areaM2) || 0;
  let areaCheck = null;
  if (declared > 0 && measured > 0) {
    const delta = Math.abs(declared - measured);
    areaCheck = `${num(measured)} м² по контуру против ${num(declared)} м² по документу `
      + `(расхождение ${num(delta)} м²)`;
  }

  return `
<section>
  <h2>2. Исходные данные</h2>
  ${docs.length
    ? table(['Файл', 'Формат', 'Размер'], docs, { className: 'wide' })
    : missing('Список исходных файлов недоступен.')}
  ${facts([
    ['Единицы чертежа', esc(cs.sourceUnits || 'не заданы (приняты метры)')],
    ['Объектов в модели', String(G.allObjects(site).length)],
    ['Зданий и строений', String((site.buildings || []).length)],
    ['Инженерных сетей', String((site.utilities || []).length)],
    ['Красных линий', String((site.redLines || []).length)],
    ['Прочих объектов', String((site.existingObjects || []).length)],
    areaCheck ? ['Сверка площади участка', esc(areaCheck)] : null,
  ])}
</section>`;
}

/** Раздел 3. Схема планировочных ограничений: рисунок, легенда, ведомость. */
function restrictionsSection({ svg, restrictions, zoneGroups = [], buildable, attributes, unresolved }) {
  const sources = sourcesOf(restrictions);
  /*
   * Легенда обязана совпадать со СХЕМОЙ.
   *
   * Когда зон много, схема рисуется свёрнутой — одна штриховка на правило
   * (та же `ZoneStyle.shouldFold`, что на экране и в чертеже). Легенда по
   * объектам в этом случае врала бы цветом: под схемой семь штриховок,
   * а в подписи десять объектов с другими оттенками. Перечень объектов
   * никуда не девается — он в ведомости 3.2, полный.
   */
  const folded = ZoneStyle.shouldFold((restrictions || []).length, (zoneGroups || []).length);
  const groupStyles = folded ? ZoneStyle.assignGroupStyles(zoneGroups) : [];

  /*
   * В легенду идут не все объекты, а десять самых дорогих по отнятой площади.
   *
   * На боевой площадке ограничения даёт семь десятков объектов, и полный
   * перечень под схемой занимает две страницы мелкой сыпи — читать его никто
   * не станет. Полный список — ведомость 3.2, там ему и место; легенда под
   * схемой отвечает на вопрос «что здесь главное».
   */
  const LEGEND_LIMIT = 10;
  const tail = '<span class="legend-item"><span class="chip chip-forbidden"></span>'
    + '<span>запретная зона — сплошная подложка под штриховкой</span></span>'
    + '<span class="legend-item"><span class="chip chip-buildable"></span>'
    + '<span>потенциально допустимая территория</span></span></div>';
  let legend = '';
  if (folded && groupStyles.length) {
    legend = `<div class="legend">${groupStyles.map((g) => `<span class="legend-item">${chip(g.color)}<span>${
      esc(g.label)} — ${num(g.areaM2)} м²${g.status && g.status !== 'confirmed' ? ' (требует проверки)' : ''
    }</span></span>`).join('')}<span class="legend-item"><span class="chip chip-more"></span><span>всего зон ${
      (restrictions || []).length}, по объектам — ведомость 3.2</span></span>${tail}`;
  } else if (sources.length) {
    const shown = sources.slice(0, LEGEND_LIMIT);
    const rest = sources.length - shown.length;
    legend = `<div class="legend">${
      shown.map((s) => `<span class="legend-item">${chip(s.color)}<span>${esc(s.label)} — ${
        esc(s.kinds.map(([k, v]) => `${k}${v.valueM ? ` ${num(v.valueM, 1)} м` : ''}`).join(', '))
      }, ${num(s.areaM2)} м²</span></span>`).join('')
    }${rest > 0
      ? `<span class="legend-item"><span class="chip chip-more"></span><span>и ещё ${rest} объект(ов) — полностью в ведомости 3.2</span></span>`
      : ''}${tail}`;
  }

  // сводка по типам: сколько зон каждого вида и на какую площадь
  const byKind = new Map();
  for (const r of restrictions || []) {
    const p = r.properties;
    const cur = byKind.get(p.kind) || { kind: p.kind, count: 0, areaM2: 0, statuses: new Set() };
    cur.count += 1;
    cur.areaM2 += Number(p.areaM2) || 0;
    if (p.statusLabel) cur.statuses.add(p.statusLabel);
    byKind.set(p.kind, cur);
  }
  const kindRows = [...byKind.values()]
    .sort((a, b) => b.areaM2 - a.areaM2)
    .map((k) => [
      esc(RR.KIND_LABELS[k.kind] || k.kind),
      String(k.count),
      `${num(k.areaM2)} м²`,
      esc([...k.statuses].join(', ')),
    ]);

  const assign = ZoneStyle.assignColors(restrictions || []);
  const rows = (restrictions || [])
    .slice()
    .sort((a, b) => (Number(b.properties.areaM2) || 0) - (Number(a.properties.areaM2) || 0))
    .map((r) => {
      const p = r.properties;
      const a = assign.byZone[r.id];
      return [
        `${chip(a ? a.color : '#888')} ${esc(p.sourceLabel || '—')}`,
        esc(RR.KIND_LABELS[p.kind] || p.kind),
        p.valueM ? `${num(p.valueM, 1)} м` : '—',
        `${num(p.areaM2)} м²`,
        esc(p.statusLabel || ''),
        esc((r.provenance && r.provenance.basis) || '—'),
      ];
    });

  const attrRows = (attributes || []).map((a) => [
    esc(RR.KIND_LABELS[a.kind] || a.kind),
    `${esc(a.value)} ${esc(a.unit || '')}`,
    esc(a.basis || '—'),
    esc(RR.STATUS_LABELS[a.status] || a.status || ''),
  ]);

  const unresolvedRows = (unresolved || []).map((u) => [
    esc(RR.KIND_LABELS[u.kind] || u.kind),
    esc(u.reason || ''),
  ]);

  const f = buildable && buildable.forbidden;
  return `
<section>
  <h2>3. Планировочные ограничения</h2>
  <figure class="plan">${svg}
    <figcaption>Схема планировочных ограничений. Цвет штриховки — объект, от которого
    отсчитано ограничение; угол штриховки — тип ограничения; сплошная подложка — запретная
    зона, объединение всех ограничений.</figcaption>
  </figure>
  ${legend}

  <h3>3.1. Сводка по типам ограничений</h3>
  ${kindRows.length
    ? table(['Тип ограничения', 'Зон', 'Суммарная площадь', 'Статусы'], kindRows, { className: 'wide' })
      + note('Площади зон складываются с наложением и в сумме превышают участок: одно и то же '
        + 'место может быть закрыто и охранной зоной, и противопожарным разрывом. '
        + 'Сколько запрещено на самом деле — в балансе территории (3.3).')
    : missing('Зоны ограничений не рассчитывались. Согласовывать посадку по такой схеме нельзя.')}

  <h3>3.2. Ведомость зон по объектам отсчёта</h3>
  ${note('Одна строка — одна зона от одного объекта. Цвет строки совпадает с цветом '
    + 'штриховки на схеме. Снять ограничение можно только действием с этим объектом: '
    + 'охранную зону — выносом сети, противопожарный разрыв — сносом или переносом строения.')}
  ${rows.length
    ? table(['Объект отсчёта', 'Ограничение', 'Величина', 'Площадь в ЗУ', 'Статус', 'Основание'], rows, { className: 'wide zones' })
    : missing('Зон не построено.')}

  <h3>3.3. Баланс территории</h3>
  ${buildable ? facts([
    ['Площадь участка', `${num(buildable.areaM2 + (f ? f.areaM2 : 0))} м²`],
    ['Запрещено ограничениями', f ? `<b>${num(f.areaM2)} м²</b> (${num(f.sharePercent, 1)}%), объединение ${f.zoneCount} зон` : null],
    ['Потенциально допустимо под застройку', `<b>${num(buildable.areaM2)} м²</b> (${num(buildable.sharePercent, 1)}% участка)`],
  ]) : missing('Допустимая территория не рассчитана.')}
  ${buildable && buildable.note ? note(buildable.note) : ''}

  ${attrRows.length ? `<h3>3.4. Ограничения без геометрии</h3>
  ${note('Высота и процент застройки зоной не становятся: они проверяются по параметрам здания, а не по месту.')}
  ${table(['Показатель', 'Значение', 'Основание', 'Статус'], attrRows, { className: 'wide' })}` : ''}

  ${unresolvedRows.length ? `<h3>3.${attrRows.length ? 5 : 4}. Ограничения, зона по которым не построена</h3>
  ${note('Ограничение осталось в перечне, но в допустимую территорию не вошло. Пока причина не устранена, расчёт неполон.')}
  ${table(['Тип', 'Почему не построено'], unresolvedRows, { className: 'wide' })}` : ''}
</section>`;
}

/** Раздел 4. Решения человека по существующим объектам — они меняют геометрию. */
function decisionsSection({ site }) {
  const decided = G.allObjects(site).filter((o) => o.properties
    && o.properties.relocation && o.properties.relocation !== 'undecided');
  if (!decided.length) return '';
  const rows = decided.map((o) => [
    esc(o.properties.userLabel || o.provenance.sourceLayer || o.type),
    esc(o.provenance.sourceLayer || '—'),
    o.properties.areaM2 ? `${num(o.properties.areaM2)} м²`
      : (o.properties.lengthM ? `${num(o.properties.lengthM)} м` : '—'),
    esc(RELOCATION_LABELS[o.properties.relocation] || o.properties.relocation),
  ]);
  const gone = decided.filter((o) => ['demolish', 'move'].includes(o.properties.relocation));
  return `
<section>
  <h2>4. Решения по существующим объектам</h2>
  ${note('Решение о сносе или переносе принято человеком на плане и учтено в расчёте: '
    + 'объект, которого на площадке не будет, зон ограничений не порождает, и место под ним '
    + 'входит в допустимую территорию. Объём демонтажа и переноса учтён в мероприятиях.')}
  ${table(['Объект', 'Слой чертежа', 'Размер', 'Решение'], rows, { className: 'wide' })}
  ${gone.length ? `<p>Убирается с площадки: <b>${gone.length}</b> объект(ов), суммарно
  ${num(gone.reduce((s, o) => s + (Number(o.properties.areaM2) || 0), 0))} м².</p>` : ''}
</section>`;
}

/** Раздел 5. Выбранный вариант: схема, параметры, ТЭП. */
function variantSection({ svg, variant, index }) {
  if (!variant) {
    return `<section><h2>${index}. Выбранный вариант</h2>
    ${missing('Вариант размещения не выбран — комплект сформирован без посадки.')}</section>`;
  }
  const m = variant.metrics || {};
  const tep = m.tep || [];
  return `
<section class="break-before">
  <h2>${index}. Выбранный вариант размещения</h2>
  <figure class="plan">${svg}
    <figcaption>Вариант № ${esc(variant.number)}: пятно застройки на фоне участка,
    ограничений и допустимой территории.</figcaption>
  </figure>
  ${facts([
    ['Номер варианта', esc(variant.number)],
    ['Конфигурация пятна', esc(m.shapeLabel || 'прямоугольник')],
    ['Площадь застройки', `<b>${num(m.areaM2)} м²</b>`],
    ['Габарит', `${num(m.width)} × ${num(m.length)} м`],
    ['Поворот относительно осей чертежа', `${num(m.rotationDeg, 1)}°`],
    ['Этажность', m.floors ? String(m.floors) : null],
    ['Общая площадь (пятно × этажность)', m.floors ? `${num(m.areaM2 * m.floors)} м²` : null],
    ['Затронуто существующих объектов', String(m.affectedCount || 0)],
    ['Статус варианта', esc(statusLabel(variant))],
  ])}
  ${m.shapeNote ? note(m.shapeNote) : ''}
  ${tep.length ? `<h3>${index}.1. Технико-экономические показатели мероприятий</h3>
  ${table(['Показатель', 'Значение', 'Единица'],
    tep.map((t) => [esc(t.name), num(t.value), esc(t.unit)]), { className: 'wide' })}
  ${note('Объёмы посчитаны геометрически. Стоимость в комплект не входит: расценки платформа не выдумывает.')}` : ''}
</section>`;
}

/** Раздел 6. Мероприятия. */
function actionsSection({ variant, index }) {
  const actions = (variant && variant.actions) || [];
  if (!actions.length) {
    return `<section><h2>${index}. Мероприятия</h2>
    ${missing('Мероприятия не требуются: вариант не затрагивает существующие объекты.')}</section>`;
  }
  const rows = actions.map((a) => [
    esc(a.title || a.kind),
    Number.isFinite(a.volume) ? `${num(a.volume)} ${esc(a.unit || '')}` : '—',
    esc(critical.LABELS[a.classification] || a.classification || '—'),
    a.requiresDecision
      ? (a.decision === 'allow' ? 'разрешено' : a.decision === 'forbid'
        ? '<b class="warn">запрещено</b>' : '<b class="warn">ТРЕБУЕТ РЕШЕНИЯ</b>')
      : (a.decided ? esc(a.note || 'решение принято на плане') : '—'),
    esc(a.basis || a.note || ''),
  ]);
  const undecided = actions.filter((a) => a.requiresDecision && !a.decision).length;
  return `
<section>
  <h2>${index}. Мероприятия по существующим объектам</h2>
  ${table(['Мероприятие', 'Объём', 'Класс объекта', 'Решение', 'Основание или примечание'], rows, { className: 'wide' })}
  ${undecided ? `<p class="warn">Без решения: ${undecided}. Пока они не приняты, вариант допустимым не считается.</p>` : ''}
</section>`;
}

/** Раздел 7. Предупреждения — всё, что расчёт считает сомнительным. */
function warningsSection({ site, variant, index }) {
  const list = [];
  for (const w of site.warnings || []) list.push(typeof w === 'string' ? w : (w && w.message));
  for (const w of (variant && variant.warnings) || []) list.push(typeof w === 'string' ? w : (w && w.message));
  const uniq = [...new Set(list.filter(Boolean))];
  return `
<section>
  <h2>${index}. Предупреждения и что требует проверки</h2>
  ${uniq.length
    ? `<ol class="warnings">${uniq.map((w) => `<li>${esc(w)}</li>`).join('')}</ol>`
    : missing('Предупреждений нет.')}
</section>`;
}

/** Раздел 8. Происхождение геометрии — по нему проверяют расчёт. */
function provenanceSection({ site, index }) {
  const objects = G.allObjects(site).filter((o) => o.type !== 'restriction');
  const byLayer = new Map();
  for (const o of objects) {
    const key = `${o.provenance.sourceFile || '—'}|${o.provenance.sourceLayer || '—'}|${o.type}`;
    const cur = byLayer.get(key) || {
      file: o.provenance.sourceFile || '—',
      layer: o.provenance.sourceLayer || '—',
      type: o.type,
      count: 0,
      method: o.provenance.extractionMethod,
      confidence: 0,
      edited: 0,
    };
    cur.count += 1;
    cur.confidence = Math.max(cur.confidence, Number(o.provenance.confidence) || 0);
    if (o.properties && o.properties.userEdited) cur.edited += 1;
    byLayer.set(key, cur);
  }
  // тип печатается по-русски: `building` и `utilityStructure` в проектном
  // документе выглядят внутренностями программы, а не сведениями об объекте
  const layers = require('./layers');
  const typeLabel = (id) => (layers.get(id) ? layers.get(id).label : id);
  const rows = [...byLayer.values()]
    .sort((a, b) => b.count - a.count)
    .map((r) => [
      esc(r.layer), esc(typeLabel(r.type)), String(r.count),
      esc(r.method), `${Math.round(r.confidence * 100)}%`,
      r.edited ? `${r.edited}` : '—',
    ]);
  return `
<section class="break-before">
  <h2>${index}. Происхождение геометрии</h2>
  ${note('Для каждого объекта модели прослеживается источник: файл, слой чертежа, способ '
    + 'распознавания и уверенность. Столбец «исправлено» — сколько объектов слоя переопределил человек.')}
  ${table(['Слой чертежа', 'Тип в модели', 'Объектов', 'Способ', 'Уверенность', 'Исправлено'], rows, { className: 'wide' })}
</section>`;
}

/** Раздел 9. Выделения и комментарии человека к плану. */
function annotationsSection({ annotations, index }) {
  if (!annotations || !annotations.length) return '';
  const rows = annotations.map((a) => [
    esc(a.comment || '—'), esc(a.author || '—'), esc(a.status || ''),
  ]);
  return `
<section>
  <h2>${index}. Выделения и комментарии к плану</h2>
  ${table(['Комментарий', 'Автор', 'Статус'], rows, { className: 'wide' })}
</section>`;
}

/* ---------------- стиль ---------------- */

const STYLE = `
  :root {
    --ink: #23201c;
    --ink-2: #4a443c;
    --ink-3: #7c7469;
    --rule: #d8d0c0;
    --rule-soft: #ece6da;
    --accent: #b95740;
    --warn: #a93e2c;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font: 10pt/1.5 "Helvetica Neue", Helvetica, Arial, sans-serif;
    color: var(--ink);
    -webkit-print-color-adjust: exact; print-color-adjust: exact;
  }
  section { page-break-inside: auto; }
  .break-before { page-break-before: always; }

  h1 { font-size: 22pt; line-height: 1.2; margin: 0 0 6pt; font-weight: 600; letter-spacing: -.01em; }
  h2 {
    font-size: 13pt; margin: 20pt 0 8pt; font-weight: 600;
    padding-bottom: 4pt; border-bottom: 1.2pt solid var(--ink);
    page-break-after: avoid;
  }
  h3 { font-size: 10.5pt; margin: 14pt 0 5pt; font-weight: 600; color: var(--ink-2); page-break-after: avoid; }
  p { margin: 0 0 7pt; }

  .title-page { padding-bottom: 8pt; }
  .brand { font-size: 8.5pt; letter-spacing: .08em; text-transform: uppercase; color: var(--accent); margin: 0 0 14pt; }
  .subtitle { font-size: 11pt; color: var(--ink-3); margin: 0 0 16pt; }
  .disclaimer {
    margin-top: 16pt; padding: 8pt 10pt; font-size: 9pt; color: var(--ink-2);
    border-left: 2pt solid var(--accent); background: #faf7f1;
  }

  table { width: 100%; border-collapse: collapse; margin: 6pt 0 10pt; font-size: 9pt; }
  th, td { text-align: left; padding: 4.5pt 7pt; vertical-align: top; border-bottom: .6pt solid var(--rule-soft); }
  thead th {
    font-size: 8pt; text-transform: uppercase; letter-spacing: .04em;
    color: var(--ink-3); border-bottom: 1pt solid var(--rule); font-weight: 600;
  }
  thead { display: table-header-group; }  /* шапка повторяется на каждой странице */
  tr { page-break-inside: avoid; }
  table.facts th { width: 42%; font-weight: 500; color: var(--ink-3); }
  table.wide td:first-child { max-width: 34%; }
  /* Ведомость зон: колонки заданы явно, иначе заголовок «Площадь в ЗУ»
     переносится по одному слову и занимает четыре строки. */
  table.zones th:nth-child(1), table.zones td:nth-child(1) { width: 30%; }
  table.zones th:nth-child(2), table.zones td:nth-child(2) { width: 17%; }
  table.zones th:nth-child(3), table.zones td:nth-child(3) { width: 9%; white-space: nowrap; }
  table.zones th:nth-child(4), table.zones td:nth-child(4) { width: 12%; white-space: nowrap; }
  table.zones th:nth-child(5), table.zones td:nth-child(5) { width: 14%; }

  figure.plan { margin: 10pt 0 12pt; page-break-inside: avoid; }
  figure.plan svg { width: 100%; height: auto; border: .8pt solid var(--rule); display: block; }
  figcaption { font-size: 8.5pt; color: var(--ink-3); margin-top: 5pt; }

  .legend { display: flex; flex-wrap: wrap; gap: 4pt 14pt; margin: 0 0 10pt; font-size: 8.5pt; }
  .legend-item { display: flex; align-items: baseline; gap: 5pt; max-width: 48%; }
  .chip {
    display: inline-block; width: 9pt; height: 9pt; border-radius: 1.5pt;
    flex: 0 0 auto; transform: translateY(1pt); border: .5pt solid rgba(0,0,0,.25);
  }
  .chip-forbidden { background: rgba(164,64,47,.30); border-color: #a4402f; }
  .chip-buildable { background: rgba(126,176,138,.45); border-color: #6f9e78; }
  .chip-more { background: repeating-linear-gradient(45deg,#bdb5a6 0 1.2pt,transparent 1.2pt 3.5pt); border-color: #bdb5a6; }

  .note { font-size: 8.5pt; color: var(--ink-2); margin: 4pt 0 8pt; padding-left: 8pt; border-left: 1.5pt solid var(--rule); }
  .muted { color: var(--ink-3); }
  .warn { color: var(--warn); }
  ol.warnings { margin: 4pt 0 8pt 16pt; padding: 0; font-size: 9pt; }
  ol.warnings li { margin-bottom: 4pt; }
`;

/** Колонтитул печатается браузером: номер листа в HTML взять неоткуда. */
function footerTemplate(session, date) {
  const style = 'font-size:7pt;color:#7c7469;width:100%;padding:0 12mm;'
    + 'display:flex;justify-content:space-between;font-family:Helvetica,Arial,sans-serif';
  return `<div style="${style}">`
    + `<span>${esc(session.title || 'Проект')} · Enso-nexus · ${esc(date)}</span>`
    + '<span>лист <span class="pageNumber"></span> из <span class="totalPages"></span></span>'
    + '</div>';
}

/**
 * Полная разметка комплекта.
 *
 * @param {object} opts.session      запись проекта
 * @param {object} opts.site         план с ограничениями и допустимой территорией
 * @param {object} opts.variant      выбранный вариант (может отсутствовать)
 * @param {Array}  opts.restrictions зоны ограничений
 * @param {object} opts.buildable    допустимая территория с запретной зоной
 * @param {Array}  opts.annotations  выделения и комментарии
 * @param {Array}  opts.files        исходные файлы проекта
 * @param {string} opts.zonesSvg     схема планировочных ограничений
 * @param {string} opts.variantSvg   схема посадки выбранного варианта
 */
function buildHtml(opts) {
  const {
    session, site, variant, restrictions = [], zoneGroups = [], buildable = null,
    annotations = [], files = [], attributes = [], unresolved = [],
    zonesSvg = '', variantSvg = '', date,
  } = opts;

  const decisions = decisionsSection({ site });
  // разделы нумеруются подряд, а не «как получилось»: раздел решений
  // появляется только там, где решения приняты
  let n = decisions ? 5 : 4;
  const variantHtml = variantSection({ svg: variantSvg, variant, index: n });
  const actionsHtml = actionsSection({ variant, index: (n += 1) });
  const warningsHtml = warningsSection({ site, variant, index: (n += 1) });
  const provenanceHtml = provenanceSection({ site, index: (n += 1) });
  const annotationsHtml = annotationsSection({ annotations, index: (n += 1) });

  return `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<title>${esc(session.title || 'Комплект')} — комплект по выбранному варианту</title>
<style>${STYLE}</style></head><body>
${titleBlock({ session, site, variant, date })}
${sourceDataSection({ site, files })}
${restrictionsSection({ svg: zonesSvg, restrictions, zoneGroups, buildable, attributes, unresolved })}
${decisions}
${variantHtml}
${actionsHtml}
${warningsHtml}
${provenanceHtml}
${annotationsHtml}
</body></html>`;
}

module.exports = { buildHtml, footerTemplate, sourcesOf, statusLabel, STYLE };
