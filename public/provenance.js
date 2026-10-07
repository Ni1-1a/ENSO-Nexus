'use strict';
/**
 * Происхождение на экране: панель «Откуда это», вид «Связи», ссылки журнала.
 *
 * Три входа в одни и те же данные (`/api/sessions/:id/provenance/*`):
 *  - панель «Откуда это» в свойствах объекта во вьювере: цепочка
 *    документ → факт → правило → объект → зона → территория → вариант → решение
 *    для того, по чему кликнули; каждая ступень — кнопка;
 *  - вид «Связи» поверх плана: граф колонками по типу (SVG руками, без
 *    библиотек), по умолчанию — только соседи выбранного узла до второй
 *    степени, карточка узла с числом связей, поиск, свёртка зон по правилам;
 *  - ссылки в «Журнале этапов»: событие несёт `ref` и `cause`, кнопка ведёт
 *    на план (объект, зона, вариант) или в граф (правило, факт, документ).
 *
 * Граф запрашивается у сервера живым и кэшируется до смены плана
 * (`enso:plan-changed`) или сессии — своего хранилища у него нет.
 * Раскладка детерминированная: колонка — тип узла, строка — порядок внутри
 * колонки по подписи. Никакой физики: один и тот же проект всегда выглядит
 * одинаково, и узел можно найти глазами второй раз.
 */
(function () {
  const Core = window.ProvenanceCore;
  const NS = 'http://www.w3.org/2000/svg';
  const el = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const state = {
    api: null,
    session: null,
    graph: null,        // граф сессии (как пришёл с сервера)
    loading: null,      // обещание загрузки, чтобы не тянуть граф дважды
    shown: null,        // граф, который сейчас нарисован (свёрнутый или полный)
    selected: '',       // выбранный узел в виде «Связи»
    ego: true,          // показывать только окрестность выбранного
    fold: true,         // свернуть зоны по правилам
    query: '',          // строка поиска
    layout: null,       // {positions: Map(id → {x, y, w, h}), width, height}
    view: null,         // viewBox графа
    drag: null,
    originFor: '',      // узел, для которого открыта панель «Откуда это»
  };

  /* ---------------- данные ---------------- */

  function init({ api }) {
    state.api = api;
    window.addEventListener('enso:plan-changed', () => invalidate());
  }

  function setSession(session) {
    if (!session || !state.session || session.id !== state.session.id) invalidate();
    state.session = session;
  }

  function invalidate() {
    state.graph = null;
    state.loading = null;
    state.shown = null;
    state.layout = null;
  }

  async function loadGraph({ include = '' } = {}) {
    if (state.graph && !include) return state.graph;
    if (!state.loading || include) {
      const q = include ? `?include=${encodeURIComponent(include)}` : '';
      state.loading = state.api(`/sessions/${state.session.id}/provenance/graph${q}`)
        .then((g) => { state.graph = g; return g; })
        .finally(() => { state.loading = null; });
    }
    return state.loading;
  }

  /** Узел графа по объекту вьювера: слой и id → id узла (сервер знает те же соответствия). */
  function nodeIdFor(objectId, layer) {
    if (!objectId) return '';
    if (layer === 'restrictions') return `zone:${objectId}`;
    if (layer === 'buildable' || layer === 'forbidden') return 'buildable:plan';
    if (layer === 'footprint') return 'variant:selected';
    if (layer === 'annotations') return `object:${objectId}`;
    return `object:${objectId}`;
  }

  /** Ссылка журнала → id узла графа. */
  function nodeIdOfRef(ref) {
    if (!ref || !ref.type || !ref.id) return '';
    if (ref.type === 'annotation') return `object:${ref.id}`;
    if (ref.type === 'card' || ref.type === 'person') return '';
    return `${ref.type}:${ref.id}`;
  }

  const TYPE_LABEL = Object.fromEntries((Core.NODE_TYPES || []).map((t) => [t.id, t.one]));
  const kindLabel = (n) => Core.KIND_LABELS[n.kind] || TYPE_LABEL[n.type] || n.type;

  /* ---------------- панель «Откуда это» ---------------- */

  /**
   * Показать происхождение объекта в панели свойств вьювера.
   * Пустой блок не рисуется: если у сессии нет графа (план без чертежа),
   * панель просто не появляется.
   */
  async function showFor(objectId, layer) {
    const box = el('vw-origin');
    if (!box || !state.session) return;
    const nodeId = nodeIdFor(objectId, layer);
    if (!nodeId) { box.hidden = true; return; }
    state.originFor = nodeId;
    box.hidden = false;
    box.innerHTML = '<h4 class="vw-origin-title">Откуда это</h4><p class="vw-origin-note">Собираю цепочку происхождения…</p>';
    try {
      const data = await state.api(`/sessions/${state.session.id}/provenance/of/${encodeURIComponent(nodeId)}`);
      if (state.originFor !== nodeId) return; // человек уже кликнул по другому объекту
      box.innerHTML = originHtml(data);
    } catch (err) {
      if (state.originFor !== nodeId) return;
      box.innerHTML = `<h4 class="vw-origin-title">Откуда это</h4><p class="vw-origin-note">${esc(err.message)}</p>`;
    }
  }

  function clearOrigin() {
    state.originFor = '';
    const box = el('vw-origin');
    if (box) { box.hidden = true; box.innerHTML = ''; }
  }

  function nodeButton(n, { current = false } = {}) {
    const cls = `vw-origin-node${current ? ' current' : ''}${n.orphan ? ' orphan' : ''}`;
    return `<button type="button" class="${cls}" data-prov-node="${esc(n.id)}" title="${esc(n.sub || '')}">
      <span class="vw-origin-kind">${esc(kindLabel(n))}</span>
      <span class="vw-origin-label">${esc(n.label)}</span>
      ${n.sub ? `<span class="vw-origin-sub">${esc(n.sub)}</span>` : ''}
    </button>`;
  }

  /** Цепочка ступенями: по колонке на тип, от документа к решению. */
  function originHtml(data) {
    const steps = [];
    const groups = new Map();
    for (const n of data.ancestors || []) {
      if (!groups.has(n.type)) groups.set(n.type, []);
      groups.get(n.type).push(n);
    }
    for (const t of Core.NODE_TYPES) {
      const list = groups.get(t.id);
      if (!list) continue;
      steps.push(`<li class="vw-origin-step"><span class="vw-origin-type">${esc(t.label)}</span>${list.map((n) => nodeButton(n)).join('')}</li>`);
    }
    const here = `<li class="vw-origin-step here"><span class="vw-origin-type">${esc(TYPE_LABEL[data.node.type] || data.node.type)}</span>${nodeButton(data.node, { current: true })}</li>`;
    const after = (data.descendants || []).length
      ? `<li class="vw-origin-step after"><span class="vw-origin-type">что из этого следует</span>${data.descendants.map((n) => nodeButton(n)).join('')}</li>`
      : '';
    const missing = (data.missing || []).length
      ? `<p class="vw-origin-missing">Происхождение не записано: ${data.missing.map((m) => `${esc(m.label)} — ${esc(m.why)}`).join('; ')}.</p>`
      : '';
    const empty = !(data.ancestors || []).length && !(data.missing || []).length
      ? '<p class="vw-origin-note">Предков у этой сущности в графе нет: она исходная (документ, чертёж) или её источник не записан.</p>'
      : '';
    return `<h4 class="vw-origin-title">Откуда это <span class="vw-origin-links">связей: ${data.links || 0}</span></h4>
      <ol class="vw-origin-chain">${steps.join('')}${here}${after}</ol>${missing}${empty}
      <p class="vw-origin-foot"><button type="button" class="btn btn-quiet btn-sm" data-prov-graph="${esc(data.node.id)}">Показать в графе связей</button></p>`;
  }

  /* ---------------- переходы ---------------- */

  /**
   * Перейти к узлу: объект, зона, вариант — показать на плане и открыть его
   * «Откуда это»; остальное — открыть граф с этим узлом.
   */
  async function focusNode(nodeId) {
    if (!nodeId) return;
    const g = await loadGraph().catch(() => null);
    const node = g && g.nodes.find((n) => n.id === nodeId);
    const viewer = window.PlanViewer;
    if (node && node.props && node.props.objectId && viewer && viewer.focusObject(node.props.objectId, node.props.layer)) return;
    openGraph({ focus: nodeId });
  }

  /* ---------------- вид «Связи» ---------------- */

  async function openGraph({ focus = '' } = {}) {
    const panel = el('vw-graph');
    if (!panel || !state.session) return;
    panel.hidden = false;
    el('vw-graph-stats').textContent = 'Собираю граф…';
    let g;
    try {
      g = await loadGraph();
    } catch (err) {
      el('vw-graph-stats').textContent = `Граф не собран: ${err.message}`;
      return;
    }
    if (focus) state.selected = focus;
    // объект, который ни в чём не участвует, добавляется в граф по запросу
    if (focus && focus.startsWith('object:') && !g.nodes.some((n) => n.id === focus)) {
      try { g = await loadGraph({ include: focus.slice(7) }); } catch { /* останемся на общем графе */ }
    }
    if (state.selected && !g.nodes.some((n) => n.id === state.selected)) {
      // ссылка могла указывать на псевдоузел (выбранный вариант, объект-зона)
      const alt = g.nodes.find((n) => n.props && (`object:${n.props.objectId}` === state.selected || (state.selected === 'variant:selected' && n.props.selected)));
      state.selected = alt ? alt.id : '';
    }
    if (!state.selected) {
      const first = g.nodes.find((n) => n.type === 'buildable') || g.nodes.find((n) => n.type === 'variant') || g.nodes[0];
      state.selected = first ? first.id : '';
    }
    renderGraph();
  }

  function closeGraph() {
    const panel = el('vw-graph');
    if (panel) panel.hidden = true;
  }

  /** Что рисовать: свёрнутый по правилам граф, обрезанный до окрестности и поиска. */
  function visibleGraph() {
    const base = state.fold ? Core.foldZones(state.graph) : state.graph;
    let keep = null;
    if (state.ego && state.selected) {
      const sel = selectedIn(base);
      keep = sel ? Core.neighborhood(base, sel, 2) : null;
    }
    const q = state.query.trim().toLowerCase();
    const nodes = base.nodes.filter((n) => (!keep || keep.has(n.id)) && (!q || `${n.label} ${n.sub}`.toLowerCase().includes(q)));
    const ids = new Set(nodes.map((n) => n.id));
    return { ...base, nodes, edges: base.edges.filter((e) => ids.has(e.from) && ids.has(e.to)) };
  }

  /** Выбранный узел в свёрнутом графе: зона → её группа. */
  function selectedIn(base) {
    if (!state.selected) return '';
    if (base.nodes.some((n) => n.id === state.selected)) return state.selected;
    if (state.selected.startsWith('zone:')) {
      const z = state.graph.nodes.find((n) => n.id === state.selected);
      const gid = z && z.props && z.props.groupId ? `zone:${z.props.groupId}` : '';
      if (gid && base.nodes.some((n) => n.id === gid)) return gid;
    }
    return '';
  }

  const NODE_W = 196;
  const NODE_H = 44;
  const COL_GAP = 70;
  const SUB_GAP = 12;
  const ROW_GAP = 10;
  const PAD = 24;
  /*
   * Длинная колонка режется на подколонки: 44 объекта одним столбцом делали граф
   * высотой в полсотни строк, и вписывание в экран превращало подписи в пыль.
   */
  const MAX_ROWS = 14;

  /** Раскладка колонками: x — тип (с подколонками), y — порядок по подписи внутри типа. */
  function layout(g) {
    const columns = Core.NODE_TYPES.map((t) => ({ type: t, nodes: g.nodes.filter((n) => n.type === t.id) })).filter((c) => c.nodes.length);
    const positions = new Map();
    let x = PAD;
    let maxH = 0;
    for (const c of columns) {
      c.nodes.sort((a, b) => (Number(a.props && a.props.number) || 0) - (Number(b.props && b.props.number) || 0)
        || String(a.label).localeCompare(String(b.label), 'ru'));
      const subs = Math.max(1, Math.ceil(c.nodes.length / MAX_ROWS));
      const rows = Math.ceil(c.nodes.length / subs);
      c.nodes.forEach((n, i) => {
        const sub = Math.floor(i / rows);
        const row = i % rows;
        positions.set(n.id, { x: x + sub * (NODE_W + SUB_GAP), y: PAD + 28 + row * (NODE_H + ROW_GAP), w: NODE_W, h: NODE_H });
      });
      c.x = x;
      maxH = Math.max(maxH, PAD + 28 + rows * (NODE_H + ROW_GAP));
      x += subs * (NODE_W + SUB_GAP) - SUB_GAP + COL_GAP;
    }
    return { positions, columns, width: x - COL_GAP + PAD, height: maxH + PAD };
  }

  function edgePath(a, b) {
    const x1 = a.x + a.w; const y1 = a.y + a.h / 2;
    const x2 = b.x; const y2 = b.y + b.h / 2;
    const dx = Math.max(30, (x2 - x1) / 2);
    return `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`;
  }

  function renderGraph() {
    const svg = el('vw-graph-svg');
    if (!svg || !state.graph) return;
    const g = visibleGraph();
    state.shown = g;
    const L = layout(g);
    state.layout = L;
    const ix = Core.index(g);
    const sel = selectedIn(g);
    const near = sel ? Core.neighborhood(g, sel, 1) : null;

    svg.innerHTML = '';
    const defs = document.createElementNS(NS, 'defs');
    defs.innerHTML = '<marker id="pg-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L8,4 L0,8 z"/></marker>';
    svg.appendChild(defs);

    const root = document.createElementNS(NS, 'g');
    root.setAttribute('class', 'pg-root');
    svg.appendChild(root);

    for (const c of L.columns) {
      const t = document.createElementNS(NS, 'text');
      t.setAttribute('x', c.x);
      t.setAttribute('y', PAD + 12);
      t.setAttribute('class', 'pg-column');
      t.textContent = `${c.type.label} · ${c.nodes.length}`;
      root.appendChild(t);
    }
    for (const e of g.edges) {
      const a = L.positions.get(e.from); const b = L.positions.get(e.to);
      if (!a || !b) continue;
      const p = document.createElementNS(NS, 'path');
      p.setAttribute('d', edgePath(a, b));
      const hot = sel && (e.from === sel || e.to === sel);
      p.setAttribute('class', `pg-edge${hot ? ' hot' : ''}${near && !near.has(e.from) && !near.has(e.to) ? ' far' : ''}`);
      p.setAttribute('marker-end', 'url(#pg-arrow)');
      const title = document.createElementNS(NS, 'title');
      title.textContent = Core.REL_LABELS[e.rel] || e.rel;
      p.appendChild(title);
      root.appendChild(p);
    }
    for (const n of g.nodes) {
      const pos = L.positions.get(n.id);
      const grp = document.createElementNS(NS, 'g');
      grp.setAttribute('class', `pg-node pg-${n.type}${n.id === sel ? ' selected' : ''}${n.orphan ? ' orphan' : ''}${near && !near.has(n.id) ? ' dim' : ''}`);
      grp.setAttribute('transform', `translate(${pos.x},${pos.y})`);
      grp.dataset.id = n.id;
      const r = document.createElementNS(NS, 'rect');
      r.setAttribute('width', pos.w); r.setAttribute('height', pos.h); r.setAttribute('rx', 9);
      grp.appendChild(r);
      const kind = document.createElementNS(NS, 'text');
      kind.setAttribute('x', 10); kind.setAttribute('y', 15); kind.setAttribute('class', 'pg-kind');
      kind.textContent = `${kindLabel(n)} · ${Core.degree(g, n.id, ix)}`;
      grp.appendChild(kind);
      const label = document.createElementNS(NS, 'text');
      label.setAttribute('x', 10); label.setAttribute('y', 33); label.setAttribute('class', 'pg-label');
      label.textContent = n.label.length > 30 ? `${n.label.slice(0, 29)}…` : n.label;
      grp.appendChild(label);
      const title = document.createElementNS(NS, 'title');
      title.textContent = `${n.label}${n.sub ? `\n${n.sub}` : ''}${n.orphan ? `\n⚠ ${n.why || 'происхождение не записано'}` : ''}`;
      grp.appendChild(title);
      root.appendChild(grp);
    }

    if (!state.view || state.view.reset) {
      const box = svg.getBoundingClientRect();
      const aspect = (box.width || 900) / (box.height || 500);
      let width = L.width; let height = L.height;
      if (width / height > aspect) height = width / aspect; else width = height * aspect;
      state.view = { minX: 0, minY: 0, width, height };
    }
    applyView();
    renderCard(sel);
    const s = state.graph.stats || {};
    const cov = s.coverage || {};
    const covLine = ['zone', 'rule', 'variant', 'object'].filter((t) => cov[t] && cov[t].total)
      .map((t) => `${TYPE_LABEL[t]}: ${cov[t].linked}/${cov[t].total}`).join(' · ');
    el('vw-graph-stats').textContent = `Узлов ${g.nodes.length} из ${state.graph.nodes.length}, связей ${g.edges.length} из ${state.graph.edges.length}`
      + (s.missing ? ` · без происхождения: ${s.missing}` : '') + (covLine ? ` · с источником — ${covLine}` : '')
      + (s.builtMs != null ? ` · собран за ${s.builtMs} мс` : '');
  }

  function applyView() {
    const svg = el('vw-graph-svg');
    const v = state.view;
    if (!svg || !v) return;
    svg.setAttribute('viewBox', `${v.minX} ${v.minY} ${v.width} ${v.height}`);
  }

  function zoomAt(factor, clientX, clientY) {
    const svg = el('vw-graph-svg');
    const box = svg.getBoundingClientRect();
    const v = state.view;
    const px = v.minX + ((clientX - box.left) / (box.width || 1)) * v.width;
    const py = v.minY + ((clientY - box.top) / (box.height || 1)) * v.height;
    const width = Math.max(200, Math.min(20000, v.width * factor));
    const height = width * (v.height / v.width);
    state.view = { minX: px - (px - v.minX) * (width / v.width), minY: py - (py - v.minY) * (height / v.height), width, height };
    applyView();
  }

  function renderCard(id) {
    const card = el('vw-graph-card');
    if (!card) return;
    const g = state.shown;
    const n = g && g.nodes.find((x) => x.id === id);
    if (!n) { card.hidden = true; card.innerHTML = ''; return; }
    const ix = Core.index(g);
    const ins = (ix.inn.get(id) || []).map((e) => ({ e, n: g.nodes.find((x) => x.id === e.from) })).filter((x) => x.n);
    const outs = (ix.out.get(id) || []).map((e) => ({ e, n: g.nodes.find((x) => x.id === e.to) })).filter((x) => x.n);
    const row = ({ e, n: m }) => `<li><button type="button" class="vw-origin-node" data-graph-node="${esc(m.id)}" title="${esc(m.sub || '')}">
        <span class="vw-origin-kind">${esc(Core.REL_LABELS[e.rel] || e.rel)} · ${esc(kindLabel(m))}</span>
        <span class="vw-origin-label">${esc(m.label)}</span></button></li>`;
    // на плане можно показать объект, зону, территорию, пятно — и группу зон целиком
    const canPlan = n.props && (n.props.objectId || (Array.isArray(n.props.zoneIds) && n.props.zoneIds.length));
    card.hidden = false;
    card.innerHTML = `
      <div class="vw-graph-card-head"><span class="vw-origin-kind">${esc(kindLabel(n))} · связей: ${Core.degree(g, id, ix)}</span>
        <button type="button" class="icon-btn" id="vw-graph-card-close" aria-label="Закрыть карточку">×</button></div>
      <h4>${esc(n.label)}</h4>
      ${n.sub ? `<p class="vw-graph-card-sub">${esc(n.sub)}</p>` : ''}
      ${n.props && n.props.explain ? `<p class="vw-graph-card-sub">${esc(n.props.explain)}</p>` : ''}
      ${n.props && n.props.quote ? `<p class="vw-graph-card-quote">«${esc(n.props.quote)}»</p>` : ''}
      ${n.props && n.props.text ? `<p class="vw-graph-card-quote">«${esc(n.props.text)}»</p>` : ''}
      ${n.orphan ? `<p class="vw-origin-missing">${esc(n.why || 'происхождение не записано')}</p>` : ''}
      ${ins.length ? `<p class="vw-graph-card-h">Откуда</p><ul class="vw-graph-card-list">${ins.map(row).join('')}</ul>` : ''}
      ${outs.length ? `<p class="vw-graph-card-h">Что следует</p><ul class="vw-graph-card-list">${outs.map(row).join('')}</ul>` : ''}
      <p class="vw-graph-card-foot">
        ${canPlan ? `<button type="button" class="btn btn-quiet btn-sm" data-graph-plan="${esc(n.id)}">Показать на плане</button>` : ''}
      </p>`;
  }

  function select(id) {
    state.selected = id;
    state.view = { ...(state.view || {}), reset: !state.ego ? false : true };
    renderGraph();
  }

  function wireGraph() {
    const panel = el('vw-graph');
    const svg = el('vw-graph-svg');
    if (!panel || !svg) return;
    el('vw-graph-close').addEventListener('click', closeGraph);
    el('vw-graph-ego').addEventListener('change', (e) => { state.ego = e.target.checked; state.view = { reset: true }; renderGraph(); });
    el('vw-graph-fold').addEventListener('change', (e) => { state.fold = e.target.checked; state.view = { reset: true }; renderGraph(); });
    el('vw-graph-search').addEventListener('input', (e) => { state.query = e.target.value; state.view = { reset: true }; renderGraph(); });
    el('vw-graph-fit').addEventListener('click', () => { state.view = { reset: true }; renderGraph(); });

    svg.addEventListener('click', (e) => {
      const node = e.target.closest('.pg-node');
      if (!node) return;
      select(node.dataset.id);
    });
    svg.addEventListener('wheel', (e) => {
      e.preventDefault();
      zoomAt(e.deltaY > 0 ? 1.12 : 1 / 1.12, e.clientX, e.clientY);
    }, { passive: false });
    svg.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target.closest('.pg-node')) return;
      state.drag = { x: e.clientX, y: e.clientY, view: { ...state.view } };
      try { svg.setPointerCapture(e.pointerId); } catch { /* захват необязателен */ }
    });
    svg.addEventListener('pointermove', (e) => {
      if (!state.drag) return;
      const box = svg.getBoundingClientRect();
      const dx = (e.clientX - state.drag.x) / (box.width || 1) * state.drag.view.width;
      const dy = (e.clientY - state.drag.y) / (box.height || 1) * state.drag.view.height;
      state.view = { ...state.drag.view, minX: state.drag.view.minX - dx, minY: state.drag.view.minY - dy };
      applyView();
    });
    const end = (e) => { state.drag = null; try { svg.releasePointerCapture(e.pointerId); } catch { /* уже отпущен */ } };
    svg.addEventListener('pointerup', end);
    svg.addEventListener('pointercancel', end);

    panel.addEventListener('click', (e) => {
      if (e.target.closest('#vw-graph-card-close')) { renderCard(''); return; }
      const go = e.target.closest('[data-graph-node]');
      if (go) { select(go.dataset.graphNode); return; }
      const plan = e.target.closest('[data-graph-plan]');
      if (plan) {
        const n = state.shown && state.shown.nodes.find((x) => x.id === plan.dataset.graphPlan);
        if (n && window.PlanViewer) {
          closeGraph();
          // группа зон — показать все её зоны
          const ids = n.kind === 'group' ? n.props.zoneIds : [n.props.objectId];
          window.PlanViewer.focusObjects(ids, n.props.layer || 'restrictions');
        }
      }
    });
  }

  /* ---------------- ссылки журнала ---------------- */

  /** HTML ссылок события: кнопки по `ref`, причина — серой строкой. */
  function eventLinksHtml(ev) {
    const refs = Array.isArray(ev.ref) ? ev.ref : [];
    const chips = refs.slice(0, 6).map((r) => {
      const id = nodeIdOfRef(r);
      const label = r.label || `${r.type} ${r.id}`;
      return id
        ? `<button type="button" class="ev-ref" data-prov-node="${esc(id)}" title="Открыть на плане или в графе связей">${esc(label)}</button>`
        : `<span class="ev-ref plain">${esc(label)}</span>`;
    }).join('');
    const more = refs.length > 6 ? `<span class="ev-ref plain">и ещё ${refs.length - 6}</span>` : '';
    const cause = ev.cause
      ? `<span class="ev-cause">← ${esc(ev.cause.type === 'person' ? ev.cause.label : (ev.cause.label || ev.cause.type))}</span>`
      : '';
    return chips || cause ? `<span class="ev-links">${chips}${more}${cause}</span>` : '';
  }

  /* ---------------- сборка ---------------- */

  document.addEventListener('DOMContentLoaded', () => {
    wireGraph();
    document.body.addEventListener('click', (e) => {
      const jump = e.target.closest('[data-prov-node]');
      if (jump) {
        e.preventDefault();
        const id = jump.dataset.provNode;
        if (window.PlanViewer && !window.PlanViewer.isOpen() && window.appOpenPlan) window.appOpenPlan({ node: id });
        else focusNode(id);
        return;
      }
      const toGraph = e.target.closest('[data-prov-graph]');
      if (toGraph) { e.preventDefault(); openGraph({ focus: toGraph.dataset.provGraph }); }
    });
  });

  window.Provenance = {
    init, setSession, invalidate, showFor, clearOrigin, focusNode, openGraph, closeGraph, eventLinksHtml, nodeIdFor,
    get state() { return state; },
  };
})();
