'use strict';
/**
 * Viewer плана участка: собственный SVG на ванильном JS.
 *
 * Тяжёлая GIS-библиотека сюда не тащится намеренно (ТЗ, п. 30): всё нужное —
 * масштабирование, панорамирование, слои, подсказки, привязка DOM-элемента к
 * идентификатору объекта — SVG умеет сам.
 *
 * Координаты внутри — мировые, в метрах, ровно те же, что в SiteGeometry.
 * Масштаб и сдвиг живут ТОЛЬКО в viewBox, поэтому ни зум, ни панорамирование
 * не меняют координат объектов. Это понадобится на следующем этапе, когда
 * выделение области надо будет сохранять в координатах плана, а не экрана.
 *
 * Ось Y в чертеже смотрит вверх, в SVG — вниз, поэтому содержимое
 * отражается через scale(1,-1), а не пересчитывается по точкам.
 */
(function () {
  const NS = 'http://www.w3.org/2000/svg';

  /** Слои плана (ТЗ, п. 32): порядок задаёт и порядок отрисовки. */
  const LAYERS = [
    { id: 'buildable', label: 'Допустимая зона', on: true },
    { id: 'restrictions', label: 'Ограничения', on: true },
    { id: 'parcel', label: 'Участок', on: true },
    { id: 'redLines', label: 'Красные линии', on: true },
    { id: 'utilities', label: 'Инженерные сети', on: true },
    { id: 'buildings', label: 'Существующая застройка', on: true },
    { id: 'existingObjects', label: 'Прочие объекты', on: true },
    { id: 'annotations', label: 'Выделения и комментарии', on: true },
  ];

  const state = {
    plan: null,
    run: null,           // последний запуск генерации вариантов
    planId: null,        // версия плана: к ней привязываются аннотации (ТЗ, п. 74)
    version: null,
    annotations: [],
    objectEdits: [],     // правки свойств объектов человеком (server: object-edits.js)
    picked: null,        // объект с открытой панелью свойств: {id, layer}
    multi: [],           // выбранные с Shift: правка применяется ко всем сразу
    hoverEl: null,       // подсвеченный курсором путь — держим ссылку, а не ищем заново
    selecting: false,    // включён режим «Выделить область»
    pending: null,       // рамка, которую тянут прямо сейчас (мировые координаты)
    api: null,
    session: null,
    view: null,          // {minX, minY, width, height} — мировые координаты
    visible: new Set(LAYERS.filter((l) => l.on).map((l) => l.id)),
    svg: null,
    root: null,
    drag: null,
  };

  const el = (id) => document.getElementById(id);

  /* ---------------- геометрия объекта → path ---------------- */

  function ringToPath(points, close) {
    if (!points || !points.length) return '';
    const d = points.map(([x, y], i) => `${i ? 'L' : 'M'}${round(x)} ${round(y)}`).join(' ');
    return close ? `${d} Z` : d;
  }

  function geometryToPath(g) {
    if (!g) return '';
    if (g.type === 'multipolygon') {
      return (g.polygons || []).map((p) =>
        [ringToPath(p.points, true), ...(p.holes || []).map((h) => ringToPath(h, true))].join(' ')).join(' ');
    }
    if (g.type === 'polygon') {
      return [ringToPath(g.points, true), ...(g.holes || []).map((h) => ringToPath(h, true))].join(' ');
    }
    return ringToPath(g.points, false);
  }

  const round = (n) => Math.round(n * 1000) / 1000;

  /* ---------------- сборка сцены ---------------- */

  function objectsOfLayer(plan, layerId) {
    if (!plan) return [];
    if (layerId === 'parcel') return plan.parcel ? [plan.parcel] : [];
    if (layerId === 'buildable') {
      const b = plan.buildable;
      return b && b.geometry ? [{ id: 'buildable', type: 'buildable', geometry: b.geometry, properties: { areaM2: b.areaM2, note: b.note } }] : [];
    }
    if (layerId === 'annotations') {
      return state.annotations.map((a) => ({
        id: a.id,
        type: 'annotation',
        geometry: { type: a.geometryType === 'point' ? 'point' : 'polygon', closed: true, points: a.geometry.points },
        properties: { comment: a.comment, status: a.status, stale: a.stale, author: a.author, createdAt: a.createdAt },
      }));
    }
    return plan[layerId] || [];
  }

  function draw() {
    const svg = state.svg;
    // образцы штриховок зон — общие с миниатюрами, отчётом и чертежом;
    // шаг задаётся в пикселях экрана и обновляется при каждом зуме
    svg.innerHTML = window.ZoneStyle.defs('zh-', hatchScale());
    const root = document.createElementNS(NS, 'g');
    root.setAttribute('transform', 'scale(1,-1)'); // ось Y чертежа смотрит вверх
    svg.appendChild(root);
    state.root = root;

    for (const layer of LAYERS) {
      const g = document.createElementNS(NS, 'g');
      g.setAttribute('class', `vw-layer vw-${layer.id}`);
      g.dataset.layer = layer.id;
      if (!state.visible.has(layer.id)) g.setAttribute('display', 'none');
      for (const obj of objectsOfLayer(state.plan, layer.id)) {
        const path = document.createElementNS(NS, 'path');
        path.setAttribute('d', geometryToPath(obj.geometry));
        // незамкнутую линию SVG при заливке домыкает сам — заливку таким запрещаем
        const open = obj.geometry && obj.geometry.type === 'polyline';
        path.setAttribute('class', open ? 'vw-shape vw-open' : 'vw-shape');
        path.dataset.objectId = obj.id;        // привязка DOM ↔ смысловой идентификатор
        path.dataset.layer = layer.id;
        if (obj.properties && obj.properties.kind) path.dataset.kind = obj.properties.kind;
        // исправленный человеком объект виден и без наведения
        if (obj.properties && obj.properties.userEdited) path.classList.add('vw-edited');
        if ((state.picked && state.picked.id === obj.id)
          || state.multi.some((m) => m.id === obj.id)) path.classList.add('vw-picked');
        // зоны — штриховкой своего цвета и угла: наложение зон читается как
        // наложение штриховок, а не как «верхняя перекрыла нижнюю»
        if (layer.id === 'restrictions' && !open) {
          const z = window.ZoneStyle.zone(obj.properties && obj.properties.kind);
          path.style.fill = window.ZoneStyle.fill(obj.properties && obj.properties.kind, 'zh-');
          path.style.stroke = z.color;
        }
        if (layer.id === 'buildable') {
          path.style.fill = window.ZoneStyle.BUILDABLE.fill;
          path.style.stroke = window.ZoneStyle.BUILDABLE.color;
        }
        g.appendChild(path);
      }
      root.appendChild(g);
    }
    applyView();
    updateStrokeScale();
  }

  function applyView() {
    const v = state.view;
    if (!v) return;
    // отражение по Y учтено сдвигом окна просмотра
    state.svg.setAttribute('viewBox', `${v.minX} ${-(v.minY + v.height)} ${v.width} ${v.height}`);
  }

  /**
   * Толщина линий задаётся в мировых единицах, поэтому при зуме её надо
   * пересчитывать — иначе на общем плане линии исчезают, а вблизи становятся
   * бетонными плитами.
   */
  function updateStrokeScale() {
    if (!state.view || !state.svg) return;
    const px = state.view.width / Math.max(1, state.svg.clientWidth || 800);
    state.svg.style.setProperty('--vw-stroke', `${px * 1.6}`);
    state.svg.style.setProperty('--vw-stroke-thin', `${px}`);
    // штриховка зон живёт по тем же правилам, что и линии: шаг задан в
    // пикселях экрана. Иначе при зуме зоны превращались в толстые бруски,
    // а на большом участке — в сплошной блёклый фон
    window.ZoneStyle.rescaleDefs(state.svg, 'zh-', px);
  }

  /** Масштаб штриховки для текущего вида: единиц плана на пиксель экрана. */
  function hatchScale() {
    if (!state.view || !state.svg) return 1;
    return window.ZoneStyle.unitsPerPixel(state.view.width, state.svg.clientWidth || 800);
  }

  /* ---------------- масштаб и сдвиг ---------------- */

  function boundsOfPlan(plan) {
    const b = plan && plan.drawingBounds;
    if (!b || !Number.isFinite(b.minX)) return null;
    return b;
  }

  /** Габариты кольца точек. */
  function boundsOfPoints(points) {
    if (!points || points.length < 2) return null;
    let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
    for (const [x, y] of points) {
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
    return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null;
  }

  /**
   * Кадр показа: участок, если он найден, иначе весь чертёж.
   * Топосъёмка охватывает квартал, участок — его малую часть; кадрировать по
   * чертежу значит показывать пустое поле.
   */
  function frameBounds(plan) {
    const parcel = plan && plan.parcel && plan.parcel.geometry && plan.parcel.geometry.points;
    return boundsOfPoints(parcel) || boundsOfPlan(plan);
  }

  function fit() {
    const b = frameBounds(state.plan);
    if (!b) return;
    const w = Math.max(b.maxX - b.minX, 1);
    const h = Math.max(b.maxY - b.minY, 1);
    const pad = Math.max(w, h) * 0.06;
    const box = state.svg.getBoundingClientRect();
    const aspect = (box.width || 800) / (box.height || 500);
    let width = w + pad * 2;
    let height = h + pad * 2;
    // вписываем с сохранением пропорций экрана, иначе план растягивается
    if (width / height > aspect) height = width / aspect;
    else width = height * aspect;
    state.view = {
      minX: (b.minX + b.maxX) / 2 - width / 2,
      minY: (b.minY + b.maxY) / 2 - height / 2,
      width, height,
    };
    applyView();
    updateStrokeScale();
  }

  function zoomAt(factor, clientX, clientY) {
    const v = state.view;
    if (!v) return;
    const box = state.svg.getBoundingClientRect();
    const fx = box.width ? (clientX - box.left) / box.width : 0.5;
    const fy = box.height ? (clientY - box.top) / box.height : 0.5;
    const worldX = v.minX + v.width * fx;
    const worldY = v.minY + v.height * (1 - fy);   // экран вниз, мир вверх
    const width = clamp(v.width * factor, 0.5, 1e7);
    const height = width * (v.height / v.width);
    state.view = {
      width, height,
      minX: worldX - width * fx,
      minY: worldY - height * (1 - fy),
    };
    applyView();
    updateStrokeScale();
  }

  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

  /* ---------------- подсказки ---------------- */

  function describe(objectId, layerId) {
    const obj = objectsOfLayer(state.plan, layerId).find((o) => o.id === objectId);
    if (!obj) return '';
    const p = obj.properties || {};
    const lines = [];
    if (layerId === 'buildable') {
      lines.push(`Потенциально допустимая территория: ${p.areaM2} м²`);
      if (p.note) lines.push(p.note);
      return lines.join('\n');
    }
    if (layerId === 'annotations') {
      lines.push(p.comment ? `«${p.comment}»` : 'Выделение без комментария');
      if (p.author) lines.push(`автор: ${p.author}`);
      if (p.stale) lines.push('сделано на прежней версии плана — проверьте привязку');
      lines.push('клик — изменить или удалить');
      return lines.join('\n');
    }
    lines.push(p.userLabel || LAYER_TITLES[layerId] || obj.type);
    // правка человека идёт первой строкой: если объект переопределён, всё
    // остальное описание относится уже к исправленному типу
    if (p.userEdited) {
      lines.push(p.parserType ? `исправлено человеком (разбор считал: ${p.parserType})` : 'свойства исправлены человеком');
    }
    if (p.relocation && p.relocation !== 'undecided') {
      lines.push(p.relocation === 'move' ? 'решение: переносится' : 'решение: остаётся на месте');
    }
    if (p.userComment) lines.push(`«${p.userComment}»`);
    if (p.kind) lines.push(`тип: ${p.kind}${p.statusLabel ? ` · ${p.statusLabel}` : ''}`);
    if (p.areaM2) lines.push(`площадь: ${p.areaM2} м²`);
    if (p.perimeterM) lines.push(`периметр: ${p.perimeterM} м`);
    if (p.lengthM) lines.push(`длина: ${p.lengthM} м`);
    const pr = obj.provenance;
    if (pr) {
      if (pr.basis) lines.push(`основание: ${pr.basis}`);
      if (pr.sourceFile) lines.push(`источник: ${pr.sourceFile}${pr.sourceLayer ? ` · слой «${pr.sourceLayer}»` : ''}`);
      if (pr.reason) lines.push(pr.reason);
      lines.push(`уверенность: ${Math.round((pr.confidence || 0) * 100)}%`);
    }
    lines.push('клик — свойства и правка');
    return lines.join('\n');
  }

  const LAYER_TITLES = {
    parcel: 'Границы участка', buildings: 'Здание', redLines: 'Красная линия',
    utilities: 'Инженерная сеть', existingObjects: 'Существующий объект',
    restrictions: 'Зона ограничения', buildable: 'Допустимая территория',
  };

  function showTip(text, clientX, clientY) {
    const tip = el('vw-tip');
    if (!text) { tip.hidden = true; return; }
    tip.textContent = text;
    tip.hidden = false;
    const box = el('vw-stage').getBoundingClientRect();
    const w = tip.offsetWidth, h = tip.offsetHeight;
    let left = clientX - box.left + 14;
    let top = clientY - box.top + 14;
    if (left + w > box.width) left = Math.max(4, clientX - box.left - w - 14);
    if (top + h > box.height) top = Math.max(4, clientY - box.top - h - 14);
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
  }

  /* ---------------- слои ---------------- */

  function renderLayerToggles() {
    const box = el('vw-layers');
    box.innerHTML = '';
    for (const layer of LAYERS) {
      const count = objectsOfLayer(state.plan, layer.id).length;
      const label = document.createElement('label');
      label.className = 'vw-layer-toggle' + (count ? '' : ' empty');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = state.visible.has(layer.id);
      cb.disabled = !count;
      cb.addEventListener('change', () => {
        if (cb.checked) state.visible.add(layer.id); else state.visible.delete(layer.id);
        const g = state.root && state.root.querySelector(`[data-layer="${layer.id}"]`);
        if (g) g.setAttribute('display', cb.checked ? 'inline' : 'none');
      });
      const swatch = document.createElement('span');
      swatch.className = `vw-swatch vw-sw-${layer.id}`;
      label.append(cb, swatch, document.createTextNode(`${layer.label} (${count})`));
      box.appendChild(label);
    }
  }

  /* ---------------- загрузка ---------------- */

  async function load(api, session) {
    state.api = api;
    state.session = session;
    const stage = el('vw-stage');
    const empty = el('vw-empty');
    if (!session) {
      state.plan = null;
      empty.hidden = false;
      empty.textContent = 'Сначала создайте проект и загрузите чертёж.';
      stage.hidden = true;
      renderLayerToggles();
      return;
    }
    el('vw-status').textContent = 'Разбор чертежей…';
    try {
      const data = await api(`/sessions/${session.id}/plan`);
      state.plan = data.plan;
      state.planId = data.planId;
      state.version = data.version;
      state.annotations = data.annotations || [];
      state.objectEdits = data.objectEdits || [];
      if (data.layers) fillTypeSelect(data.layers);
      const hasGeometry = boundsOfPlan(state.plan);
      empty.hidden = !!hasGeometry;
      stage.hidden = !hasGeometry;
      if (!hasGeometry) {
        empty.textContent = (state.plan.warnings[0] && state.plan.warnings[0].message)
          || 'Геометрия не найдена: загрузите чертёж DWG или DXF.';
      } else {
        draw();
        fit();
      }
      renderLayerToggles();
      renderWarnings();
      el('vw-status').textContent = `Версия плана ${data.version} · ${summaryLine(data.summary)}`;
    } catch (err) {
      el('vw-status').textContent = `Не удалось построить план: ${err.message}`;
      stage.hidden = true;
      empty.hidden = false;
      empty.textContent = err.message;
    }
  }

  /**
   * Единицы чертежа приходят строкой. Если в файле нет INSUNITS, сервер иногда
   * отдаёт «код undefined (принято: метры)» — показывать такое человеку нельзя
   * и класть в аннотацию тоже: клиент приводит это к честной формулировке.
   * (Саму подстановку чинит серверная часть, здесь — устойчивость.)
   */
  function unitsLabel(raw) {
    const s = String(raw == null ? '' : raw).trim();
    if (!s) return 'не заданы (принято: метры)';
    if (/^код\s+(undefined|null|nan)\b/i.test(s)) return 'не заданы (принято: метры)';
    return s;
  }

  function summaryLine(s) {
    if (!s) return '';
    return `Участок: ${s['участок']} · зданий: ${s['зданий']} · сетей: ${s['инженерныхСетей']} · ` +
      `красных линий: ${s['красныхЛиний']} · единицы: ${unitsLabel(s['единицы'])}`;
  }

  function renderWarnings() {
    const box = el('vw-warnings');
    const list = (state.plan && state.plan.warnings) || [];
    box.innerHTML = '';
    box.hidden = !list.length;
    for (const w of list.slice(0, 6)) {
      const li = document.createElement('li');
      li.textContent = w.message;
      box.appendChild(li);
    }
  }

  /* ---------------- миниатюра плана ---------------- */

  /**
   * Префикс образцов штриховки для миниатюры.
   * Общий префикс «th-» давал одинаковые id в одном документе, а `url(#th-…)`
   * браузер разрешает по ПЕРВОМУ совпадению — все схемы в ленте брали
   * штриховку первой карточки вместе с её масштабом, и участок 2000 м выходил
   * сплошной заливкой. Ключ считается от масштаба: одинаковый масштаб — один
   * набор образцов (делить его безопасно), разный — свой. Ключ детерминирован,
   * иначе разметка менялась бы на каждом опросе ленты и та мигала бы.
   */
  function thumbPrefix(scale) {
    return `th${String(scale).replace(/[^0-9]/g, '_')}-`;
  }

  /**
   * Миниатюра участка для карточек в ленте диалога: те же цвета и штриховки,
   * что и в полноэкранном плане. Отдельного кода отрисовки для карточек нет
   * намеренно — иначе схема в чате начнёт расходиться с планом.
   */
  function thumbSvg(opts) {
    const o = opts || {};
    const plan = o.plan || state.plan;
    if (!plan) return '';
    const ZS = window.ZoneStyle;

    // Кадр берётся по участку, а не по всему чертежу: топосъёмка тянется на
    // сотни метров, и участок в таком кадре — пятно меньше пикселя. Именно
    // так карточка и выходила пустым белым листом.
    const b = frameBounds(plan);
    if (!b || !Number.isFinite(b.minX)) return '';
    const w = Math.max(b.maxX - b.minX, 1);
    const h = Math.max(b.maxY - b.minY, 1);
    const pad = Math.max(w, h) * 0.08;
    const span = w + pad * 2;
    // Миниатюра не зумится, но участки бывают и 50 м, и 2 км: шаг штриховки
    // в метрах давал на маленьком участке четыре толстые полосы, а на большом —
    // сплошной блёклый фон. Считаем от размера отрисовки в пикселях: миниатюры
    // в ленте — от 96 (карточка варианта) до 190 (лист схемы).
    const scale = Math.round(ZS.unitsPerPixel(span, o.pxWidth || 150) * 1000) / 1000;
    const prefix = thumbPrefix(scale);

    const parts = [];
    const add = (geom, style) => {
      const d = geometryToPath(geom);
      if (d) parts.push(`<path d="${d}" style="${style}" vector-effect="non-scaling-stroke"/>`);
    };
    const bu = plan.buildable;
    if (bu && bu.geometry) add(bu.geometry, `fill:${ZS.BUILDABLE.fill};stroke:${ZS.BUILDABLE.color};stroke-width:1`);
    for (const z of plan.restrictions || []) {
      add(z.geometry, ZS.zoneStyle(z.properties && z.properties.kind, prefix));
    }
    if (plan.parcel) add(plan.parcel.geometry, 'fill:none;stroke:currentColor;stroke-width:1.6');
    for (const u of plan.utilities || []) add(u.geometry, 'fill:none;stroke:#a8802c;stroke-width:1');
    for (const bl of plan.buildings || []) add(bl.geometry, 'fill:#4a6b8a44;stroke:#4a6b8a;stroke-width:1');
    if (o.footprint) add(o.footprint, `fill:${ZS.FOOTPRINT.fill};stroke:${ZS.FOOTPRINT.color};stroke-width:2`);

    return `<svg class="${o.className || 'vw-mini'}" viewBox="${b.minX - pad} ${-(b.maxY + pad)} ${span} ${h + pad * 2}" ` +
      'preserveAspectRatio="xMidYMid meet" role="img" aria-label="Схема участка">' +
      ZS.defs(prefix, scale) + `<g transform="scale(1,-1)">${parts.join('')}</g></svg>`;
  }

  /* ---------------- инициализация ---------------- */

  function init() {
    state.svg = el('vw-svg');
    const stage = el('vw-stage');

    /**
     * Панель свойств лежит ВНУТРИ сцены, и её события сцене не принадлежат.
     * Без этой проверки нажатие на «Сохранить» начинало тащить план: сцена
     * забирала указатель себе (setPointerCapture), и кнопка клика не получала.
     * Колесо над панелью по той же причине зумило план вместо прокрутки списка.
     */
    const inPanel = (e) => !!(e.target.closest && e.target.closest('#vw-props'));

    stage.addEventListener('wheel', (e) => {
      if (inPanel(e)) return;
      e.preventDefault();
      zoomAt(e.deltaY > 0 ? 1.12 : 1 / 1.12, e.clientX, e.clientY);
    }, { passive: false });

    stage.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || inPanel(e)) return;
      if (state.selecting) {
        // рамка сразу переводится в мировые координаты: экранные нигде не хранятся
        state.pending = { from: toWorld(e), to: toWorld(e) };
        try { stage.setPointerCapture(e.pointerId); } catch { /* захват необязателен */ }
        drawPending();
        return;
      }
      state.drag = { x: e.clientX, y: e.clientY, view: { ...state.view } };
      try { stage.setPointerCapture(e.pointerId); } catch { /* захват необязателен */ }
      stage.classList.add('dragging');
    });
    stage.addEventListener('pointermove', (e) => {
      if (state.pending) {
        state.pending.to = toWorld(e);
        drawPending();
        return;
      }
      if (state.drag) {
        const box = state.svg.getBoundingClientRect();
        const dx = (e.clientX - state.drag.x) / (box.width || 1) * state.drag.view.width;
        const dy = (e.clientY - state.drag.y) / (box.height || 1) * state.drag.view.height;
        state.view = { ...state.drag.view, minX: state.drag.view.minX - dx, minY: state.drag.view.minY + dy };
        applyView();
        return;
      }
      const target = shapeAt(e.clientX, e.clientY);
      setHover(target);
      if (target) showTip(describe(target.dataset.objectId, target.dataset.layer), e.clientX, e.clientY);
      else showTip('');
    });
    const endDrag = (e) => {
      if (state.pending) {
        const { from, to } = state.pending;
        state.pending = null;
        try { stage.releasePointerCapture(e.pointerId); } catch { /* уже отпущен */ }
        finishSelection(from, to);
        return;
      }
      if (!state.drag) return;
      state.drag = null;
      stage.classList.remove('dragging');
      try { stage.releasePointerCapture(e.pointerId); } catch { /* уже отпущен */ }
    };
    stage.addEventListener('pointerup', endDrag);
    stage.addEventListener('pointercancel', endDrag);
    stage.addEventListener('pointerleave', () => { showTip(''); setHover(null); });

    stage.addEventListener('click', (e) => {
      if (state.selecting) return;
      const shape = shapeAt(e.clientX, e.clientY);
      if (!shape) return;
      // выделения человека открывают свой диалог, объекты чертежа — панель свойств
      if (shape.dataset.layer === 'annotations') { editAnnotation(shape.dataset.objectId); return; }
      // Shift — набрать пачку: несколько «строений», которые на деле рельеф,
      // переназначаются одной правкой, а не пятью подряд
      if (e.shiftKey) toggleMulti(shape.dataset.objectId, shape.dataset.layer);
      else openProps(shape.dataset.objectId, shape.dataset.layer);
    });

    el('vw-props-close').addEventListener('click', closeProps);
    el('vw-props-form').addEventListener('submit', saveProps);
    el('vw-prop-reset').addEventListener('click', resetProps);

    el('vw-select').addEventListener('click', () => setSelecting(!state.selecting));
    el('vw-restrictions').addEventListener('click', computeRestrictions);
    el('vw-export').addEventListener('click', exportDrawing);

    el('vw-zoom-in').addEventListener('click', () => zoomCenter(1 / 1.25));
    el('vw-zoom-out').addEventListener('click', () => zoomCenter(1.25));
    el('vw-fit').addEventListener('click', fit);
    el('vw-reset').addEventListener('click', fit);
    window.addEventListener('resize', () => { updateStrokeScale(); });
  }

  /* ---------------- объект под курсором и его свойства ---------------- */

  /**
   * Объект под курсором — САМЫЙ МЕЛКИЙ из лежащих в этой точке.
   *
   * Слои рисуются по порядку, и крупная заливка (площадка, покрытие) ложится
   * поверх тонких линий: до сети под ней курсором было не добраться вообще —
   * все события забирала заливка. Побеждает наименьшая габаритная площадь:
   * линия ЛЭП поверх площадки выбирается, площадка целиком — когда курсор
   * не над линией.
   */
  function shapeAt(clientX, clientY) {
    const stack = document.elementsFromPoint(clientX, clientY);
    // панель свойств и подсказка перекрывают план — сквозь них не целимся
    for (const n of stack) {
      if (n.closest && (n.closest('#vw-props') || n.closest('#vw-tip'))) return null;
      if (n.classList && n.classList.contains('vw-shape')) break;
    }
    let best = null;
    let bestArea = Infinity;
    for (const n of stack) {
      if (!n.classList || !n.classList.contains('vw-shape')) continue;
      let area = Infinity;
      try {
        const b = n.getBBox();
        area = Math.max(0.001, b.width) * Math.max(0.001, b.height);
      } catch { /* у пути нет геометрии — пусть проигрывает */ }
      if (area < bestArea) { bestArea = area; best = n; }
    }
    return best;
  }

  /** Подсветка объекта ЦЕЛИКОМ: у линии чертежа не видно, где она кончается. */
  function setHover(elm) {
    if (state.hoverEl === elm) return;
    if (state.hoverEl) state.hoverEl.classList.remove('vw-hover');
    state.hoverEl = elm && elm.dataset.layer !== 'annotations' ? elm : null;
    if (state.hoverEl) state.hoverEl.classList.add('vw-hover');
  }

  /** Подписи типов приходят с сервера вместе с перечнем слоёв; здесь только расчётные. */
  const TYPE_LABELS = { restriction: 'Зона ограничения', buildable: 'Допустимая территория' };

  /**
   * Список слоёв в выпадающем — с сервера. Сгруппирован так же, как в чертеже:
   * границы, строения, инженерия, транспорт, ландшафт, прочее.
   */
  function fillTypeSelect(groups) {
    const sel = el('vw-prop-type');
    if (sel.dataset.filled === '1') return;
    for (const g of groups) {
      const og = document.createElement('optgroup');
      og.label = g.group;
      for (const item of g.items) {
        const o = document.createElement('option');
        o.value = item.id;
        o.textContent = item.label;
        o.title = `слой чертежа: ${item.dxf}`;
        og.appendChild(o);
        TYPE_LABELS[item.id] = item.label;
      }
      sel.appendChild(og);
    }
    sel.dataset.filled = '1';
  }
  const RELOCATION_LABELS = { undecided: 'не решено', keep: 'остаётся на месте', move: 'переносится' };

  /** Правка этого объекта, если она есть: ищем по id текущей версии плана. */
  function editOf(objectId) {
    return state.objectEdits.find((e) => e.objectId === objectId) || null;
  }

  function fact(dl, term, value) {
    if (value === undefined || value === null || value === '') return;
    const dt = document.createElement('dt'); dt.textContent = term;
    const dd = document.createElement('dd'); dd.textContent = value;
    dl.append(dt, dd);
  }

  /**
   * Панель свойств. Показывает и то, что увидел разбор (слой чертежа, способ,
   * уверенность), и то, что сказал человек: без первого нельзя понять, почему
   * объект опознан неверно, без второго — что уже исправлено.
   */
  /** Shift-клик: добавить объект в пачку или убрать из неё. */
  function toggleMulti(objectId, layer) {
    const i = state.multi.findIndex((m) => m.id === objectId);
    if (i >= 0) state.multi.splice(i, 1);
    else state.multi.push({ id: objectId, layer });
    state.picked = null;
    if (!state.multi.length) { closeProps(); return; }
    openBatchProps();
  }

  /**
   * Панель для пачки объектов. Свойства у них разные, показывать их нечего —
   * показывается состав пачки и общая правка: чем они являются на самом деле,
   * переносятся ли, общий комментарий.
   */
  function openBatchProps() {
    el('vw-props-title').textContent = `Выбрано объектов: ${state.multi.length}`;
    const dl = el('vw-props-facts');
    dl.innerHTML = '';
    const byLayer = new Map();
    for (const m of state.multi) byLayer.set(m.layer, (byLayer.get(m.layer) || 0) + 1);
    for (const [layer, n] of byLayer) fact(dl, LAYER_TITLES[layer] || layer, `${n} шт.`);
    fact(dl, 'Как набрать', 'Shift + клик по объекту добавляет или убирает его');
    el('vw-prop-type').value = '';
    el('vw-prop-label').value = '';
    el('vw-prop-relocation').value = 'undecided';
    el('vw-prop-comment').value = '';
    el('vw-prop-reset').hidden = true;
    el('vw-props-note').textContent = 'Правка применится ко ВСЕМ выбранным объектам.';
    el('vw-props').hidden = false;
    draw();
  }

  function openProps(objectId, layer) {
    const obj = objectsOfLayer(state.plan, layer).find((o) => o.id === objectId);
    if (!obj) return;
    state.multi = [];
    state.picked = { id: objectId, layer };
    const p = obj.properties || {};
    const pr = obj.provenance || {};
    const edit = editOf(objectId);

    el('vw-props-title').textContent = p.userLabel || TYPE_LABELS[obj.type] || LAYER_TITLES[layer] || 'Объект';

    const dl = el('vw-props-facts');
    dl.innerHTML = '';
    fact(dl, 'Тип', TYPE_LABELS[obj.type] || obj.type);
    if (p.parserType) fact(dl, 'Разбор считал', TYPE_LABELS[p.parserType] || p.parserType);
    fact(dl, 'Площадь', p.areaM2 ? `${p.areaM2} м²` : '');
    fact(dl, 'Длина', p.lengthM ? `${p.lengthM} м` : '');
    fact(dl, 'Периметр', p.perimeterM ? `${p.perimeterM} м` : '');
    fact(dl, 'Вершин', p.vertices);
    fact(dl, 'Слой чертежа', pr.sourceLayer);
    fact(dl, 'Файл', pr.sourceFile);
    fact(dl, 'Сущность', pr.sourceEntity);
    fact(dl, 'Способ', pr.extractionMethod);
    if (typeof pr.confidence === 'number') fact(dl, 'Уверенность', `${Math.round(pr.confidence * 100)}%`);
    fact(dl, 'Почему так', pr.reason);
    if (p.relocation) fact(dl, 'Перенос', RELOCATION_LABELS[p.relocation]);
    if (p.userComment) fact(dl, 'Комментарий', p.userComment);
    if (p.demotedFromParcel) fact(dl, 'Внимание', 'этот контур раньше считался границей участка');

    el('vw-prop-type').value = (edit && edit.patch.type) || '';
    el('vw-prop-label').value = (edit && edit.patch.label) || p.userLabel || '';
    el('vw-prop-relocation').value = (edit && edit.patch.relocation) || p.relocation || 'undecided';
    el('vw-prop-comment').value = (edit && edit.patch.comment) || p.userComment || '';
    el('vw-prop-reset').hidden = !edit;
    el('vw-props-note').textContent = edit
      ? 'Правка сохранена и применена к плану. Она же уходит в выгрузку для дообучения модели.'
      : 'Правка применится к плану и попадёт в выгрузку для дообучения модели.';
    el('vw-props').hidden = false;
    draw();
  }

  function closeProps() {
    state.picked = null;
    state.multi = [];
    el('vw-props').hidden = true;
    draw();
  }

  /** Перечитать план, не теряя текущий масштаб и сдвиг: правка не должна сбрасывать вид. */
  async function reloadKeepingView() {
    const view = state.view ? { ...state.view } : null;
    await load(state.api, state.session);
    if (view) { state.view = view; applyView(); updateStrokeScale(); }
  }

  async function saveProps(e) {
    e.preventDefault();
    if (!state.session) return;
    if (state.multi.length) { await saveBatch(); return; }
    if (!state.picked) return;
    const patch = {
      type: el('vw-prop-type').value,
      label: el('vw-prop-label').value.trim(),
      relocation: el('vw-prop-relocation').value,
      comment: el('vw-prop-comment').value.trim(),
      author: localStorage.getItem('enso-author') || '',
    };
    const btn = el('vw-prop-save');
    btn.disabled = true;
    try {
      await state.api(`/sessions/${state.session.id}/plan/objects/${encodeURIComponent(state.picked.id)}`, {
        method: 'POST', json: patch,
      });
      const picked = { ...state.picked };
      await reloadKeepingView();
      // после смены типа объект переезжает в другой слой — открываем его заново там,
      // где он теперь лежит, иначе панель показывала бы вчерашнее состояние
      const found = findAnyLayer(picked.id);
      if (found) openProps(found.id, found.layer); else closeProps();
      window.appToast('Свойства объекта сохранены');
    } catch (err) {
      window.appToast(err.message, 'error');
    } finally {
      btn.disabled = false;
    }
  }

  /**
   * Пачка: одна и та же правка на все выбранные объекты.
   *
   * Запросы идут ПОСЛЕДОВАТЕЛЬНО и по одному: сервер на каждой правке заново
   * собирает план, и десяток параллельных запросов просто выстроился бы в ту же
   * очередь, но с риском получить полусохранённое состояние при обрыве.
   * Неудача одного объекта не отменяет остальных — о ней говорится числом.
   */
  async function saveBatch() {
    const patch = {
      type: el('vw-prop-type').value,
      label: el('vw-prop-label').value.trim(),
      relocation: el('vw-prop-relocation').value,
      comment: el('vw-prop-comment').value.trim(),
      author: localStorage.getItem('enso-author') || '',
    };
    if (!patch.type && !patch.label && !patch.comment && patch.relocation === 'undecided') {
      window.appToast('Нечего применять: выберите тип, перенос или впишите комментарий', 'error');
      return;
    }
    const btn = el('vw-prop-save');
    btn.disabled = true;
    const total = state.multi.length;
    let done = 0;
    const failed = [];
    for (const m of state.multi) {
      el('vw-props-note').textContent = `Применяю: ${done + 1} из ${total}…`;
      try {
        await state.api(`/sessions/${state.session.id}/plan/objects/${encodeURIComponent(m.id)}`, {
          method: 'POST', json: patch,
        });
        done++;
      } catch (err) { failed.push(err.message); }
    }
    btn.disabled = false;
    await reloadKeepingView();
    closeProps();
    window.appToast(failed.length
      ? `Применено к ${done} из ${total}; не удалось: ${failed.length} (${failed[0]})`
      : `Применено к ${done} объектам`, failed.length ? 'error' : undefined);
  }

  /** Где сейчас лежит объект: после правки типа он мог сменить слой. */
  function findAnyLayer(objectId) {
    for (const layer of LAYERS) {
      const found = objectsOfLayer(state.plan, layer.id).find((o) => o.id === objectId);
      if (found) return { id: objectId, layer: layer.id };
    }
    return null;
  }

  async function resetProps() {
    const edit = state.picked && editOf(state.picked.id);
    if (!edit) return;
    try {
      await state.api(`/sessions/${state.session.id}/plan/objects/${encodeURIComponent(edit.objectKey)}`, { method: 'DELETE' });
      await reloadKeepingView();
      closeProps();
      window.appToast('Правка отменена — вернулось то, что определил разбор');
    } catch (err) { window.appToast(err.message, 'error'); }
  }

  /* ---------------- выделение области (ТЗ, п. 33–36) ---------------- */

  /** Экранное событие → точка плана. Вся математика — в geo-transform.js. */
  function toWorld(e) {
    const box = state.svg.getBoundingClientRect();
    return window.GeoTransform.screenToWorld(
      e.clientX - box.left, e.clientY - box.top, state.view, { width: box.width, height: box.height },
    );
  }

  function setSelecting(on) {
    state.selecting = on;
    el('vw-select').classList.toggle('active', on);
    el('vw-stage').classList.toggle('selecting', on);
    el('vw-select').textContent = on ? 'Отменить выделение' : 'Выделить область';
    if (!on) { state.pending = null; drawPending(); }
  }

  /** Рамка в процессе — рисуется тем же слоем, что и сохранённые выделения. */
  function drawPending() {
    let g = state.root && state.root.querySelector('.vw-pending');
    if (!state.pending) { if (g) g.remove(); return; }
    const pts = window.GeoTransform.rectFromPoints(state.pending.from, state.pending.to);
    if (!g) {
      g = document.createElementNS(NS, 'path');
      g.setAttribute('class', 'vw-pending');
      state.root.appendChild(g);
    }
    g.setAttribute('d', ringToPath(pts, true));
  }

  async function finishSelection(from, to) {
    drawPending();
    const pts = window.GeoTransform.rectFromPoints(from, to);
    const area = window.GeoTransform.areaOf(pts);
    if (area < 1) { setSelecting(false); return; }  // случайный клик, а не рамка

    const res = await window.appDialog({
      title: 'Выделенная область',
      message: `Площадь выделения ${Math.round(area)} м². Координаты сохраняются в системе плана.`,
      fields: [
        { key: 'comment', label: 'Комментарий или вопрос', value: '', placeholder: 'Например: почему здесь нельзя строить?', maxLength: 1000 },
        { key: 'author', label: 'Кто выделил', value: localStorage.getItem('enso-author') || '', maxLength: 120 },
      ],
      confirmText: 'Сохранить',
    });
    setSelecting(false);
    if (res === null) return;
    if (res.author) localStorage.setItem('enso-author', res.author);
    try {
      const created = await state.api(`/sessions/${state.session.id}/annotations`, {
        method: 'POST',
        json: {
          planId: state.planId,
          geometry: { points: pts },
          geometryType: 'rect',
          comment: res.comment || '',
          author: res.author || '',
          // в выделение уходит человеческая формулировка единиц, а не «код undefined»
          coordinateSystem: unitsLabel(state.plan && state.plan.coordinateSystem
            && state.plan.coordinateSystem.sourceUnits),
        },
      });
      state.annotations.push(created);
      draw();
      renderLayerToggles();
      window.appToast('Выделение сохранено');
    } catch (err) {
      window.appToast(err.message, 'error');
    }
  }

  async function editAnnotation(id) {
    const a = state.annotations.find((x) => x.id === id);
    if (!a) return;
    const res = await window.appDialog({
      title: 'Выделение на плане',
      message: (a.stale ? 'Сделано на прежней версии плана — проверьте, что оно всё ещё на месте.\n' : '')
        + 'Заполните «Вопрос», чтобы спросить модель об этой области — она получит и картинку, и объекты внутри рамки.',
      fields: [
        { key: 'comment', label: 'Комментарий', value: a.comment || '', maxLength: 1000 },
        { key: 'question', label: 'Вопрос модели по этой области', value: '', placeholder: 'Например: что мешает построить здесь?', maxLength: 2000 },
      ],
      confirmText: 'Сохранить',
      cancelText: 'Закрыть',
      // подсказка слоя обещает удаление — значит, оно должно быть здесь,
      // а не только в removeAnnotation, до которой из интерфейса не дойти
      extraText: 'Удалить выделение',
    });
    if (res === null) return;
    if (res === 'extra') { await removeAnnotation(id); return; }
    try {
      if ((res.comment || '') !== (a.comment || '')) {
        const updated = await state.api(`/sessions/${state.session.id}/annotations/${id}`, {
          method: 'POST', json: { comment: res.comment },
        });
        Object.assign(a, updated);
        draw();
      }
      if ((res.question || '').trim()) await askAboutSelection(a, res.question.trim());
      else window.appToast('Сохранено');
    } catch (err) { window.appToast(err.message, 'error'); }
  }

  /** Вопрос модели по области: контекст собирает сервер (ТЗ, п. 34). */
  async function askAboutSelection(a, question) {
    el('vw-status').textContent = 'Модель отвечает по выделенной области…';
    try {
      const res = await state.api(`/sessions/${state.session.id}/annotations/${a.id}/ask`, {
        method: 'POST', json: { question },
      });
      a.status = 'answered';
      a.linkedMessageId = res.answerMessageId || '';
      draw();
      const c = res.context || {};
      el('vw-status').textContent =
        `Ответ записан в ленту проекта · в контекст ушло: объектов ${c['объектовВОбласти']}, ` +
        `ограничений ${c['ограниченийВОбласти']}, файлов ${c['файловПроекта']}, фактов ${c['фактов']}` +
        `${c['изображениеПриложено'] ? ', плюс изображение области' : ' (без изображения: модель не видит картинки)'}`;
      await window.appDialog({
        title: 'Ответ по выделенной области',
        message: res.answer,
        confirmText: 'Понятно', cancelText: 'Закрыть',
      });
    } catch (err) {
      el('vw-status').textContent = `Не удалось получить ответ: ${err.message}`;
      window.appToast(err.message, 'error');
    }
  }

  /**
   * Выгрузка чертежа с объектами по слоям — не дожидаясь выбора варианта.
   *
   * Скачивается то, что видно на плане СЕЙЧАС, вместе с переназначениями:
   * контур, названный участком, уходит в AI_ГРАНИЦЫ_ЗУ, а не в слой газопровода.
   * Формат не подменяется молча: что пришло — DWG или DXF — сказано и в имени
   * файла, и в сообщении.
   */
  async function exportDrawing() {
    if (!state.session) return;
    const btn = el('vw-export');
    btn.disabled = true;
    el('vw-status').textContent = 'Собираю чертёж по слоям…';
    try {
      const res = await fetch(`/api/sessions/${state.session.id}/plan/drawing`, {
        headers: window.appAuthHeaders(state.session.token),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error((data && data.error) || `Не удалось собрать чертёж (${res.status})`);
      }
      const format = (res.headers.get('X-Drawing-Format') || 'dxf').toUpperCase();
      const layers = res.headers.get('X-Drawing-Layers') || '?';
      const name = fileNameFrom(res.headers.get('Content-Disposition'))
        || `План участка по слоям.${format.toLowerCase()}`;
      window.appSaveBlob(await res.blob(), name);
      el('vw-status').textContent = `Скачан ${format}: слоёв ${layers}`;
      window.appToast(format === 'DWG'
        ? `Скачан DWG (собран конвертером), слоёв: ${layers}`
        : `Скачан DXF, слоёв: ${layers}. DWG собрать не удалось — AutoCAD откроет DXF штатно.`);
    } catch (err) {
      el('vw-status').textContent = `Чертёж не собран: ${err.message}`;
      window.appToast(err.message, 'error');
    } finally {
      btn.disabled = false;
    }
  }

  /** Имя файла из Content-Disposition: сервер шлёт его в filename*=UTF-8''… */
  function fileNameFrom(header) {
    if (!header) return '';
    const m = /filename\*=UTF-8''([^;]+)/i.exec(header);
    if (m) { try { return decodeURIComponent(m[1]); } catch { return ''; } }
    const plain = /filename="?([^";]+)"?/i.exec(header);
    return plain ? plain[1] : '';
  }

  /** Расчёт зон ограничений: правила от модели + детерминированная геометрия. */
  async function computeRestrictions() {
    if (!state.session) return;
    const btn = el('vw-restrictions');
    btn.disabled = true;
    el('vw-status').textContent = 'Извлечение ограничений из документов и построение зон…';
    try {
      const res = await state.api(`/sessions/${state.session.id}/plan/restrictions`, { method: 'POST', json: {} });
      state.plan.restrictions = res.restrictions || [];
      state.plan.buildable = res.buildable || null;
      draw();
      renderLayerToggles();
      const b = res.buildable;
      el('vw-status').textContent = `Зон построено: ${res.restrictions.length}` +
        (res.unresolved.length ? `, не построено: ${res.unresolved.length}` : '') +
        (b ? ` · допустимо ${b.areaM2} м² (${b.sharePercent}%)` : '');
      const extra = [
        ...res.unresolved.map((u) => `Не построено «${u.kind}»: ${u.reason}`),
        ...res.conflicts.map((c) => c.message),
        ...res.missingData.map((m) => `Не хватает: ${m}`),
      ];
      if (extra.length) {
        const box = el('vw-warnings');
        box.hidden = false;
        for (const line of extra.slice(0, 8)) {
          const li = document.createElement('li');
          li.textContent = line;
          box.appendChild(li);
        }
      }
    } catch (err) {
      el('vw-status').textContent = `Ограничения не рассчитаны: ${err.message}`;
      window.appToast(err.message, 'error');
    } finally {
      btn.disabled = false;
    }
  }

  async function removeAnnotation(id) {
    const ok = await window.appDialog({
      title: 'Удалить выделение?', message: 'Комментарий будет удалён вместе с областью.',
      confirmText: 'Удалить', danger: true,
    });
    if (ok === null) return;
    try {
      await state.api(`/sessions/${state.session.id}/annotations/${id}`, { method: 'DELETE' });
      state.annotations = state.annotations.filter((x) => x.id !== id);
      draw();
      renderLayerToggles();
    } catch (err) { window.appToast(err.message, 'error'); }
  }

  function zoomCenter(factor) {
    const box = state.svg.getBoundingClientRect();
    zoomAt(factor, box.left + box.width / 2, box.top + box.height / 2);
  }

  /* ---------------- полноэкранный режим ---------------- */

  /**
   * План разворачивается поверх диалога. Размеры вьюпорта у скрытого окна
   * нулевые, поэтому вписывание участка делается ПОСЛЕ показа — иначе
   * первый кадр приезжает с пустым viewBox.
   */
  async function open(api, session) {
    const modal = el('plan-modal');
    modal.hidden = false;
    document.body.classList.add('modal-open');
    if (api) await load(api, session);
    requestAnimationFrame(() => { fit(); updateStrokeScale(); });
  }

  function close() {
    el('plan-modal').hidden = true;
    document.body.classList.remove('modal-open');
    if (state.selecting) setSelecting(false);
  }

  function isOpen() { return !el('plan-modal').hidden; }

  // публичный интерфейс для app.js
  window.PlanViewer = {
    init, load, fit, open, close, isOpen, thumbSvg,
    setSelecting, removeAnnotation, computeRestrictions,
    get state() { return state; },
  };
})();
