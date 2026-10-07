'use strict';
/**
 * Граф происхождения — общее ядро для сервера и браузера.
 *
 * Здесь нет ни базы, ни DOM: только словарь типов узлов, порядок колонок и
 * чистые обходы графа (цепочка «откуда это», окрестность узла). Сервер
 * собирает узлы и рёбра из таблиц (services/geometry/provenance-graph.js),
 * клиент рисует их (provenance.js) — а считают оба одним и тем же кодом,
 * иначе панель «Откуда это» и вид «Связи» разошлись бы в ответах.
 *
 * Узел: { id: 'тип:ключ', type, kind, label, sub, props, orphan?, why? }.
 * Ребро: { from, to, rel } — направление «причина → следствие»: документ →
 * факт → правило → зона → допустимая территория → вариант → мероприятие →
 * решение. Указания человека (замечание, правка, решение) стоят в своей
 * колонке, но ребро от них тоже идёт к следствию.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ProvenanceCore = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  /** Колонки графа — слева направо, по ходу работы над проектом. */
  const NODE_TYPES = [
    { id: 'file', label: 'Документы и чертежи', one: 'документ' },
    { id: 'fact', label: 'Факты анализа', one: 'факт' },
    { id: 'human', label: 'Указания человека', one: 'указание' },
    { id: 'rule', label: 'Правила ограничений', one: 'правило' },
    { id: 'object', label: 'Объекты участка', one: 'объект' },
    { id: 'zone', label: 'Зоны ограничений', one: 'зона' },
    { id: 'buildable', label: 'Допустимая территория', one: 'территория' },
    { id: 'variant', label: 'Варианты посадки', one: 'вариант' },
    { id: 'action', label: 'Мероприятия', one: 'мероприятие' },
    { id: 'result', label: 'Комплект', one: 'файл' },
  ];
  const TYPE_INDEX = Object.fromEntries(NODE_TYPES.map((t, i) => [t.id, i]));

  /** Подтипы — для подписи и цвета узла. */
  const KIND_LABELS = {
    drawing: 'чертёж', document: 'документ', fact: 'факт',
    note: 'замечание к этапу', edit: 'правка объекта', decision: 'решение по мероприятию',
    annotation: 'пометка на плане', parcelSource: 'границы из документа',
    rule: 'правило', derived: 'правило из факта', unresolved: 'правило без зоны',
    object: 'объект', parcel: 'границы участка', zone: 'зона', group: 'зоны правила',
    buildable: 'допустимая территория', run: 'подбор вариантов', variant: 'вариант',
    action: 'мероприятие', result: 'файл комплекта',
  };

  /** Подписи рёбер: как читать стрелку. */
  const REL_LABELS = {
    source: 'источник', derives: 'выведено из', builds: 'построено по', from: 'построено от',
    forms: 'образует', recomputes: 'пересчитано после', places: 'размещено в', requires: 'требует',
    affects: 'затрагивает', decides: 'решено', edits: 'исправлено', notes: 'учтено при расчёте',
    marks: 'помечено', produces: 'выгружено по', analysis: 'разобрано из', selected: 'выбрано',
  };

  function nodeId(type, key) { return `${type}:${key}`; }

  function typeOf(id) { return String(id || '').split(':')[0]; }

  function typeIndex(type) { return TYPE_INDEX[type] ?? NODE_TYPES.length; }

  /** Индексы для быстрых обходов: по id, входящие и исходящие рёбра. */
  function index(graph) {
    const byId = new Map();
    for (const n of graph.nodes || []) byId.set(n.id, n);
    const out = new Map();
    const inn = new Map();
    for (const e of graph.edges || []) {
      if (!byId.has(e.from) || !byId.has(e.to)) continue;
      if (!out.has(e.from)) out.set(e.from, []);
      if (!inn.has(e.to)) inn.set(e.to, []);
      out.get(e.from).push(e);
      inn.get(e.to).push(e);
    }
    return { byId, out, inn };
  }

  /** Число связей узла — то самое «links: N» на карточке. */
  function degree(graph, id, idx) {
    const ix = idx || index(graph);
    return (ix.out.get(id) || []).length + (ix.inn.get(id) || []).length;
  }

  /**
   * Цепочка «откуда это»: все предки узла (по рёбрам против стрелки) и
   * ближайшие следствия (по стрелке, на `down` шагов).
   *
   * Предки отдаются отсортированными по колонке — так цепочка читается как
   * документ → факт → правило → объект → зона → территория → вариант —
   * а внутри колонки по подписи. Возвращаются и рёбра между собранными узлами.
   */
  function chain(graph, id, { down = 1, up = 64 } = {}) {
    const ix = index(graph);
    const node = ix.byId.get(id);
    if (!node) return null;
    const anc = new Map();
    const stack = [[id, 0]];
    while (stack.length) {
      const [cur, depth] = stack.pop();
      if (depth >= up) continue;
      for (const e of ix.inn.get(cur) || []) {
        if (e.from === id || anc.has(e.from)) continue;
        anc.set(e.from, depth + 1);
        stack.push([e.from, depth + 1]);
      }
    }
    const desc = new Map();
    const q = [[id, 0]];
    while (q.length) {
      const [cur, depth] = q.shift();
      if (depth >= down) continue;
      for (const e of ix.out.get(cur) || []) {
        if (e.to === id || desc.has(e.to) || anc.has(e.to)) continue;
        desc.set(e.to, depth + 1);
        q.push([e.to, depth + 1]);
      }
    }
    const sortNodes = (ids) => ids.map((k) => ix.byId.get(k)).filter(Boolean)
      .sort((a, b) => typeIndex(a.type) - typeIndex(b.type) || String(a.label).localeCompare(String(b.label), 'ru'));
    const keep = new Set([id, ...anc.keys(), ...desc.keys()]);
    return {
      node,
      ancestors: sortNodes([...anc.keys()]),
      descendants: sortNodes([...desc.keys()]),
      edges: (graph.edges || []).filter((e) => keep.has(e.from) && keep.has(e.to)),
      links: degree(graph, id, ix),
    };
  }

  /** Окрестность узла без учёта направления — для «только соседи выбранного». */
  function neighborhood(graph, id, depth = 2) {
    const ix = index(graph);
    if (!ix.byId.has(id)) return new Set();
    const seen = new Set([id]);
    let frontier = [id];
    for (let d = 0; d < depth && frontier.length; d++) {
      const next = [];
      for (const cur of frontier) {
        for (const e of ix.out.get(cur) || []) if (!seen.has(e.to)) { seen.add(e.to); next.push(e.to); }
        for (const e of ix.inn.get(cur) || []) if (!seen.has(e.from)) { seen.add(e.from); next.push(e.from); }
      }
      frontier = next;
    }
    return seen;
  }

  /**
   * Свернуть зоны одного правила в один узел: на боевом чертеже одно правило
   * даёт десятки зон, и по отдельности они нечитаемы. Рёбра переносятся на
   * группу и схлопываются, число зон уходит в подпись.
   */
  function foldZones(graph) {
    const groups = new Map();
    const zoneToGroup = new Map();
    for (const n of graph.nodes) {
      if (n.type !== 'zone' || !n.props || !n.props.groupId) continue;
      const gid = nodeId('zone', n.props.groupId);
      zoneToGroup.set(n.id, gid);
      if (!groups.has(gid)) {
        groups.set(gid, {
          id: gid, type: 'zone', kind: 'group',
          label: n.props.groupLabel || n.label, sub: '',
          props: { groupId: n.props.groupId, zoneIds: [], ruleId: n.props.ruleId, areaM2: 0 },
          orphan: false,
        });
      }
      const g = groups.get(gid);
      g.props.zoneIds.push(n.props.objectId || n.id);
      g.props.areaM2 += Number(n.props.areaM2) || 0;
      if (n.orphan) { g.orphan = true; g.why = n.why; }
    }
    if (!groups.size) return graph;
    for (const g of groups.values()) {
      g.sub = `зон: ${g.props.zoneIds.length} · ${Math.round(g.props.areaM2)} м²`;
      g.props.areaM2 = Math.round(g.props.areaM2 * 100) / 100;
    }
    const nodes = graph.nodes.filter((n) => !zoneToGroup.has(n.id)).concat([...groups.values()]);
    const seen = new Set();
    const edges = [];
    for (const e of graph.edges) {
      const from = zoneToGroup.get(e.from) || e.from;
      const to = zoneToGroup.get(e.to) || e.to;
      const key = `${from}>${to}>${e.rel}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ ...e, from, to });
    }
    return { ...graph, nodes, edges, folded: true };
  }

  return {
    NODE_TYPES, TYPE_INDEX, KIND_LABELS, REL_LABELS,
    nodeId, typeOf, typeIndex, index, degree, chain, neighborhood, foldZones,
  };
}));
