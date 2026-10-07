'use strict';
/**
 * Граф происхождения сессии посадки (07.10.2026).
 *
 * Платформа записывает, откуда взялась каждая вещь: у объекта плана —
 * `provenance` (файл, слой, способ), у правила — документ и цитата, у зоны —
 * правило и объект отсчёта, у варианта — запуск, у мероприятия — объект и
 * решение человека, у замечания — этап. Но записано это россыпью по таблицам,
 * и ответ «откуда это взялось» приходилось собирать глазами из ленты.
 *
 * Здесь всё это собирается в один граф: узлы — документы, факты, указания
 * человека, правила, объекты, зоны, допустимая территория, варианты,
 * мероприятия, файлы комплекта; рёбра — «причина → следствие». Граф строится
 * из тех же таблиц, что читают план и карточки, при КАЖДОМ запросе и нигде не
 * хранится: иначе он врал бы после первой же правки (правило карточек —
 * «схему, метрики и статусы клиент берёт живыми»).
 *
 * Модели граф не показывается и моделью не объясняется: пояснение узла берётся
 * из полей происхождения, а где их нет — честное «происхождение не записано».
 *
 * `assemble(data)` — чистая сборка из готовых списков (тестируется без базы);
 * `build(sessionId)` — чтение таблиц и вызов `assemble`.
 */
const { db } = require('../../db');
const core = require('../../../public/provenance-core.js');
const RR = require('./restriction-rules');
const G = require('./site-geometry');

const { nodeId } = core;

const STAGE_LABELS = {
  zones: 'схема зон', variants: 'варианты посадки', drawing: 'чертёж', analysis: 'анализ', questions: 'вопросы',
};
const RELOCATION_LABELS = { keep: 'остаётся', move: 'переносится', demolish: 'сносится', undecided: 'не решено' };
const LAYER_TITLES = {
  parcel: 'Границы участка', buildings: 'Здание', redLines: 'Красная линия',
  utilities: 'Инженерная сеть', existingObjects: 'Существующий объект', restrictions: 'Зона ограничения',
};
const DRAWING_EXT = new Set(['dwg', 'dxf']);

const cut = (s, n = 120) => {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const num = (n) => (Number.isFinite(Number(n)) ? Number(n).toLocaleString('ru-RU', { maximumFractionDigits: 2 }) : '');

/** Имя файла без расширения и шума — для сопоставления «источник: ГПЗУ» ↔ «ГПЗУ.pdf». */
function stem(name) {
  return String(name || '').toLowerCase().replace(/\.[a-z0-9]{2,5}$/i, '').replace(/[«»"'()\[\]]/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * Файл сессии, на который ссылается текст (имя документа у факта или правила).
 * Сопоставление по имени без расширения в обе стороны: модель пишет «ГПЗУ»,
 * «ГПЗУ.pdf» или «ГПЗУ участка 47:14:…» — всё это один файл. Нет совпадения —
 * null, и узел остаётся без документа (это видно в графе).
 */
function matchFile(files, text) {
  const t = stem(text);
  if (!t) return null;
  let best = null;
  for (const f of files) {
    const s = stem(f.original_name);
    if (!s) continue;
    if (s === t) return f;
    if ((t.includes(s) || s.includes(t)) && (!best || s.length > stem(best.original_name).length)) best = f;
  }
  return best;
}

function objectLabel(obj, layer) {
  const p = (obj && obj.properties) || {};
  const pr = (obj && obj.provenance) || {};
  if (p.userLabel) return cut(p.userLabel, 80);
  // подпись типа — из общего перечня слоёв (geometry/layers.js), как во вьювере и чертеже:
  // навес со слоя сооружений — «некапитальное сооружение», а не «здание» по корзине
  let typeLabel = '';
  try { const t = require('./layers').get(obj.type); typeLabel = (t && t.label) || ''; } catch { /* перечень недоступен — ниже запас */ }
  const base = typeLabel || LAYER_TITLES[layer] || obj.type;
  const size = p.areaM2 ? `${num(p.areaM2)} м²` : (p.lengthM ? `${num(p.lengthM)} м` : '');
  return cut(`${base}${pr.sourceLayer ? ` · ${pr.sourceLayer}` : ''}${size ? ` · ${size}` : ''}`, 90);
}

/** Объекты плана по слоям интерфейса — тем же разбиением, что рисует вьювер. */
function layeredObjects(site) {
  const out = [];
  if (site.parcel) out.push({ layer: 'parcel', obj: site.parcel });
  for (const layer of ['buildings', 'redLines', 'utilities', 'existingObjects']) {
    for (const obj of site[layer] || []) out.push({ layer, obj });
  }
  return out;
}

/* ---------------- сборка ---------------- */

/**
 * @param {object} data
 *   files        строки таблицы files: {id, original_name, ext, size, created_at}
 *   facts        {key, value, source}
 *   site         план с правками и зонами (plan.ensurePlan)
 *   rules        правила последнего расчёта зон (plan_zones.rules)
 *   unresolved   правила без зоны: {ruleId, kind, reason}
 *   zonesAt      время последнего расчёта зон (ISO) или ''
 *   run          последний запуск вариантов (placement-runs.latestRun) или null
 *   requirementFacts  строки «ключ = значение» фактов, из которых взяты требования
 *   notes        замечания к этапам: {id, stage, note, created_at}
 *   edits        правки объектов: object-edits.list
 *   annotations  пометки на плане: annotations.list
 *   annotationHits  {annotationId: [objectId, …]} — объекты внутри пометки
 *   parcelSource границы из документа: parcel-source.get или null
 *   results      строки таблицы results: {id, filename, title, format, created_at}
 *   extraObjectIds  объекты плана, которые нужны в графе независимо от участия
 *                   (клик по любому контуру во вьювере — «откуда это» и для него)
 */
function assemble(data) {
  const files = data.files || [];
  const facts = data.facts || [];
  const site = data.site || G.createSiteGeometry();
  const rules = data.rules || [];
  const unresolved = data.unresolved || [];
  const run = data.run || null;
  const notes = data.notes || [];
  const edits = data.edits || [];
  const annotations = data.annotations || [];
  const hits = data.annotationHits || {};
  const parcelSource = data.parcelSource || null;
  const results = data.results || [];
  const reqFacts = new Set(data.requirementFacts || []);

  const nodes = new Map();
  const edges = [];
  const edgeKeys = new Set();
  const add = (n) => { if (!nodes.has(n.id)) nodes.set(n.id, { orphan: false, props: {}, sub: '', ...n }); return nodes.get(n.id); };
  const link = (from, to, rel) => {
    if (!from || !to || from === to) return;
    const key = `${from}>${to}>${rel}`;
    if (edgeKeys.has(key)) return;
    edgeKeys.add(key);
    edges.push({ from, to, rel });
  };
  const orphan = (id, why) => { const n = nodes.get(id); if (n) { n.orphan = true; n.why = why; } };

  /* --- документы и чертежи --- */
  for (const f of files) {
    const ext = String(f.ext || '').toLowerCase();
    add({
      id: nodeId('file', f.id), type: 'file', kind: DRAWING_EXT.has(ext) ? 'drawing' : 'document',
      label: cut(f.original_name, 80), sub: `${ext.toUpperCase()}${f.size ? ` · ${num(Math.round(f.size / 1024))} КБ` : ''}`,
      props: { fileId: f.id, ext },
    });
  }

  /* --- факты анализа --- */
  const factByLine = new Map();
  for (const f of facts) {
    const id = nodeId('fact', f.key);
    const line = `${f.key} = ${f.value}`;
    factByLine.set(line, id);
    add({
      id, type: 'fact', kind: 'fact', label: cut(line, 100), sub: f.source ? `источник: ${cut(f.source, 80)}` : '',
      props: { key: f.key, value: String(f.value), source: f.source || '' },
    });
    const file = matchFile(files, f.source);
    if (file) link(nodeId('file', file.id), id, 'source');
    else orphan(id, f.source ? `документ «${cut(f.source, 60)}» не найден среди файлов сессии` : 'источник факта не записан');
  }

  /* --- границы участка из документа --- */
  let parcelSourceId = '';
  if (parcelSource && Array.isArray(parcelSource.points) && parcelSource.points.length) {
    parcelSourceId = nodeId('fact', 'parcel-source');
    const meta = parcelSource.meta || {};
    add({
      id: parcelSourceId, type: 'fact', kind: 'parcelSource',
      label: `Границы участка по ${parcelSource.points.length} характерным точкам`,
      sub: cut([meta.sourceDocument && `документ: ${meta.sourceDocument}`, meta.cadastralNumber && `ЗУ ${meta.cadastralNumber}`,
        parcelSource.author && `внёс: ${parcelSource.author}`].filter(Boolean).join(' · '), 120),
      props: { points: parcelSource.points.length, cadastralNumber: meta.cadastralNumber || '' },
    });
    const file = matchFile(files, meta.sourceDocument);
    if (file) link(nodeId('file', file.id), parcelSourceId, 'source');
    else orphan(parcelSourceId, 'документ с таблицей координат не опознан среди файлов сессии');
  }

  /* --- объекты участка: только те, что в чём-то участвуют --- */
  const layered = layeredObjects(site);
  const byObjectId = new Map(layered.map((x) => [x.obj.id, x]));
  const wanted = new Set();
  if (site.parcel) wanted.add(site.parcel.id);
  for (const z of site.restrictions || []) if (z.properties && z.properties.sourceObjectId) wanted.add(z.properties.sourceObjectId);
  for (const e of edits) if (e.objectId) wanted.add(e.objectId);
  for (const v of (run && run.variants) || []) for (const a of v.actions || []) if (a.objectId) wanted.add(a.objectId);
  for (const ids of Object.values(hits)) for (const id of ids || []) wanted.add(id);
  for (const id of data.extraObjectIds || []) if (byObjectId.has(id)) wanted.add(id);

  const objectNode = (objectId) => {
    const found = byObjectId.get(objectId);
    if (!found) return '';
    const { obj, layer } = found;
    const id = nodeId('object', obj.id);
    if (nodes.has(id)) return id;
    const p = obj.properties || {};
    const pr = obj.provenance || {};
    add({
      id, type: 'object', kind: layer === 'parcel' ? 'parcel' : 'object',
      label: objectLabel(obj, layer),
      sub: cut([pr.sourceLayer && `слой «${pr.sourceLayer}»`, p.relocation && p.relocation !== 'undecided' && RELOCATION_LABELS[p.relocation],
        p.userEdited && 'исправлено человеком'].filter(Boolean).join(' · '), 120),
      props: { objectId: obj.id, layer, sourceLayer: pr.sourceLayer || '', relocation: p.relocation || '', method: pr.extractionMethod || '' },
    });
    const file = (pr.sourceFileId && files.find((f) => f.id === pr.sourceFileId)) || matchFile(files, pr.sourceFile);
    if (file) link(nodeId('file', file.id), id, 'source');
    else if (layer === 'parcel' && parcelSourceId && pr.extractionMethod === 'document-stated') link(parcelSourceId, id, 'derives');
    else if (pr.extractionMethod !== 'user') orphan(id, pr.sourceFile ? `файл «${cut(pr.sourceFile, 60)}» не найден среди файлов сессии` : 'исходный файл объекта не записан');
    return id;
  };
  for (const objectId of wanted) objectNode(objectId);

  /* --- правила ограничений --- */
  const unresolvedById = new Map(unresolved.map((u) => [u.ruleId, u]));
  const ruleIds = new Set();
  for (const r of rules) {
    if (!r || !r.id) continue;
    const id = nodeId('rule', r.id);
    ruleIds.add(r.id);
    const src = r.source || {};
    const quote = String(src.quote || '').trim();
    const derivedFrom = factByLine.get(quote) || '';
    const u = unresolvedById.get(r.id);
    const value = r.valueM !== null && r.valueM !== undefined ? `${num(r.valueM)} м` : `${num(r.value)} ${r.unit || ''}`.trim();
    add({
      id, type: 'rule', kind: u ? 'unresolved' : (derivedFrom ? 'derived' : 'rule'),
      label: cut(`${RR.KIND_LABELS[r.kind] || r.kind} ${value}${r.target && r.target.hint ? ` — ${r.target.hint}` : ''}`, 100),
      sub: cut([r.basis && `основание: ${r.basis}`, src.document && `документ: ${src.document}${src.clause ? `, ${src.clause}` : ''}`,
        RR.STATUS_LABELS[r.status] || r.status].filter(Boolean).join(' · '), 160),
      props: { ruleId: r.id, kind: r.kind, valueM: r.valueM, basis: r.basis || '', status: r.status || '', quote: cut(quote, 300), explain: RR.explainRule(r) },
    });
    if (derivedFrom) link(derivedFrom, id, 'derives');
    const file = matchFile(files, src.document);
    if (file) link(nodeId('file', file.id), id, 'source');
    if (!derivedFrom && !file) {
      orphan(id, src.document ? `документ «${cut(src.document, 60)}» не найден среди файлов сессии` : 'документ-источник правила не записан');
    }
    if (u) { nodes.get(id).why = `зона не построена: ${u.reason}`; }
  }

  /* --- зоны ограничений и допустимая территория --- */
  const buildableId = nodeId('buildable', 'plan');
  const b = site.buildable;
  if (b) {
    add({
      id: buildableId, type: 'buildable', kind: 'buildable',
      label: `Допустимая территория ${num(b.areaM2)} м²`,
      sub: `${b.sharePercent != null ? `${num(b.sharePercent)} % участка` : ''}${b.forbidden ? ` · запретная зона ${num(b.forbidden.areaM2)} м²` : ''}`,
      props: { objectId: 'buildable', layer: 'buildable', areaM2: b.areaM2, sharePercent: b.sharePercent, zoneCount: (site.restrictions || []).length },
    });
    if (site.parcel) link(nodeId('object', site.parcel.id), buildableId, 'forms');
  }
  for (const z of site.restrictions || []) {
    const p = z.properties || {};
    const id = nodeId('zone', z.id);
    const groupLabel = `${RR.KIND_LABELS[p.kind] || p.kind} ${num(p.valueM)} м`;
    add({
      id, type: 'zone', kind: 'zone',
      label: cut(`${groupLabel} от «${p.sourceLabel || 'объект не назван'}»`, 100),
      sub: cut([p.statusLabel, p.areaM2 && `${num(p.areaM2)} м²`].filter(Boolean).join(' · '), 100),
      props: {
        objectId: z.id, layer: 'restrictions', groupId: p.groupId || '', groupLabel, ruleId: p.ruleId || '',
        sourceObjectId: p.sourceObjectId || '', areaM2: p.areaM2, kind: p.kind, basis: (z.provenance && z.provenance.basis) || '',
      },
    });
    const ruleNode = p.ruleId && ruleIds.has(p.ruleId) ? nodeId('rule', p.ruleId) : '';
    if (ruleNode) link(ruleNode, id, 'builds');
    const srcNode = p.sourceObjectId ? objectNode(p.sourceObjectId) : '';
    if (srcNode) link(srcNode, id, 'from');
    if (!ruleNode && !srcNode) orphan(id, 'ни правило, ни объект отсчёта зоны не записаны');
    else if (!ruleNode) orphan(id, p.ruleId ? `правило ${p.ruleId} не найдено в последнем расчёте зон` : 'правило зоны не записано');
    else if (!srcNode) orphan(id, 'объект отсчёта зоны не найден на плане');
    if (b) link(id, buildableId, 'forms');
  }

  /* --- указания человека --- */
  const zonesAt = Date.parse(data.zonesAt || '') || 0;
  const runAt = run ? (Date.parse(run.createdAt || '') || 0) : 0;
  for (const n of notes) {
    const id = nodeId('human', `note-${n.id}`);
    add({
      id, type: 'human', kind: 'note',
      label: `Замечание: ${STAGE_LABELS[n.stage] || n.stage}`, sub: cut(n.note, 200),
      props: { noteId: n.id, stage: n.stage, text: String(n.note || ''), at: n.created_at },
    });
    const at = Date.parse(n.created_at || '') || 0;
    if (n.stage === 'zones' && b && zonesAt && at <= zonesAt) link(id, buildableId, 'notes');
    if (n.stage === 'variants' && run && runAt && at <= runAt) link(id, nodeId('variant', `run-${run.id}`), 'notes');
  }
  for (const e of edits) {
    const id = nodeId('human', `edit-${e.id}`);
    const p = e.patch || {};
    const target = e.objectId ? objectNode(e.objectId) : '';
    add({
      id, type: 'human', kind: 'edit',
      label: cut(`Правка: ${target ? nodes.get(target).label : e.objectKey || 'объект'}`, 90),
      sub: cut([p.type && `тип → ${p.type}`, p.label && `назначение «${p.label}»`, p.relocation && `решение: ${RELOCATION_LABELS[p.relocation] || p.relocation}`,
        p.comment && `«${p.comment}»`, e.author && `— ${e.author}`].filter(Boolean).join(' · '), 160),
      props: { editId: e.id, objectId: e.objectId, patch: p, author: e.author || '', at: e.updatedAt || e.createdAt },
    });
    if (target) link(id, target, 'edits');
    else orphan(id, 'объект правки не найден в текущей версии плана');
    if (b && (p.relocation === 'demolish' || p.relocation === 'move')) link(id, buildableId, 'recomputes');
  }
  for (const a of annotations) {
    if (!String(a.comment || '').trim()) continue;
    const id = nodeId('human', `annotation-${a.id}`);
    add({
      id, type: 'human', kind: 'annotation',
      label: cut(`Пометка: «${a.comment}»`, 90), sub: cut([a.author && `автор: ${a.author}`, a.stale && 'на прежней версии плана'].filter(Boolean).join(' · '), 100),
      props: { annotationId: a.id, objectId: a.id, layer: 'annotations', comment: a.comment, author: a.author || '' },
    });
    for (const objectId of hits[a.id] || []) {
      const target = objectNode(objectId);
      if (target) link(id, target, 'marks');
    }
  }

  /* --- варианты посадки, мероприятия, решения --- */
  if (run) {
    const runNode = nodeId('variant', `run-${run.id}`);
    const criterion = (require('./variants').CRITERIA.find((c) => c.id === run.criterion) || {}).label || run.criterion;
    const stats = run.stats || {};
    const req = run.requirements || {};
    add({
      id: runNode, type: 'variant', kind: 'run',
      label: `Подбор вариантов${run.createdAt ? ` ${new Date(run.createdAt).toLocaleDateString('ru-RU')}` : ''}`,
      sub: cut([criterion && `критерий: ${criterion}`, req.areaM2 && `пятно ${num(req.areaM2)} м²`, req.floors && `${req.floors} эт.`,
        stats['перебрано'] != null && `перебрано ${num(stats['перебрано'])}`].filter(Boolean).join(' · '), 160),
      props: { runId: run.id, criterion: run.criterion, requirements: req, stats },
    });
    if (b) link(buildableId, runNode, 'places');
    for (const line of reqFacts) { const fid = factByLine.get(line); if (fid) link(fid, runNode, 'requires'); }
    for (const v of run.variants || []) {
      const vid = nodeId('variant', v.id);
      const m = v.metrics || {};
      add({
        id: vid, type: 'variant', kind: 'variant',
        label: `Вариант ${v.number} — ${v.statusLabel || v.status}${v.selected ? ' · выбран' : ''}`,
        sub: cut([m.areaM2 && `${num(m.areaM2)} м²`, m.shapeLabel, Number.isFinite(m.rotationDeg) && `поворот ${num(m.rotationDeg)}°`,
          m.access && m.access.label].filter(Boolean).join(' · '), 120),
        props: { variantId: v.id, number: v.number, status: v.status, selected: !!v.selected, objectId: v.selected ? 'footprint' : '', layer: v.selected ? 'footprint' : '', areaM2: m.areaM2 },
      });
      link(runNode, vid, 'places');
      for (const a of v.actions || []) {
        const aid = nodeId('action', a.id);
        add({
          id: aid, type: 'action', kind: 'action',
          label: cut(a.title, 90),
          sub: cut([Number.isFinite(a.volume) && `${num(a.volume)} ${a.unit || ''}`, a.classification && `класс: ${a.classification}`,
            a.requiresDecision && !a.decision && 'ждёт решения'].filter(Boolean).join(' · '), 120),
          props: { actionId: a.id, variantId: v.id, objectId: a.objectId || '', decision: a.decision || '', requiresDecision: !!a.requiresDecision },
        });
        link(vid, aid, 'requires');
        const target = a.objectId ? objectNode(a.objectId) : '';
        if (target) link(aid, target, 'affects');
        else if (a.objectId) orphan(aid, 'задетый объект не найден в текущей версии плана');
        if (a.decision) {
          const did = nodeId('human', `decision-${a.id}`);
          const who = /решение принял (.+?) \(/.exec(String(a.note || ''));
          add({
            id: did, type: 'human', kind: 'decision',
            label: `Решение: ${a.decision === 'allow' ? 'разрешено' : 'запрещено'}`,
            sub: cut(who ? `принял ${who[1]}` : (a.note || ''), 100),
            props: { actionId: a.id, decision: a.decision, decidedBy: who ? who[1] : '' },
          });
          link(did, aid, 'decides');
        }
      }
    }
  }

  /* --- комплект: результаты анализа и чертежа --- */
  const selected = run ? (run.variants || []).find((v) => v.selected) : null;
  for (const r of results) {
    const id = nodeId('result', r.id);
    const at = Date.parse(r.created_at || '') || 0;
    const drawing = /^(dxf|dwg|pdf|png)$/i.test(String(r.format || '')) && selected && runAt && at >= runAt;
    add({
      id, type: 'result', kind: 'result', label: cut(r.filename, 80), sub: cut(r.title || String(r.format || '').toUpperCase(), 100),
      props: { resultId: r.id, format: r.format, filename: r.filename },
    });
    if (drawing) link(nodeId('variant', selected.id), id, 'produces');
    else for (const f of files) link(nodeId('file', f.id), id, 'analysis');
  }

  /* --- итог --- */
  const list = [...nodes.values()];
  const coverage = {};
  for (const t of core.NODE_TYPES) coverage[t.id] = { total: 0, linked: 0 };
  for (const n of list) {
    const c = coverage[n.type] || (coverage[n.type] = { total: 0, linked: 0 });
    c.total += 1;
    if (!n.orphan) c.linked += 1;
  }
  const missing = list.filter((n) => n.orphan).map((n) => ({ id: n.id, type: n.type, label: n.label, why: n.why || 'происхождение не записано' }));
  return {
    nodes: list,
    edges,
    types: core.NODE_TYPES,
    stats: {
      nodes: list.length, edges: edges.length, coverage, missing: missing.length,
      objectsOnPlan: layered.length, objectsInGraph: list.filter((n) => n.type === 'object').length,
    },
    missing,
  };
}

/* ---------------- чтение таблиц ---------------- */

/** Объекты плана внутри каждой пометки — те же, что уходят модели в вопросе по области. */
function annotationHitsOf(site, annotations) {
  const out = {};
  let selection = null;
  for (const a of annotations) {
    if (!String(a.comment || '').trim() || !a.geometry || a.geometryType === 'point') continue;
    try {
      selection = selection || require('./selection');
      out[a.id] = selection.objectsIn(site, a.geometry.points)
        .filter((h) => ['parcel', 'buildings', 'redLines', 'utilities', 'existingObjects'].includes(h.layer))
        .map((h) => h.obj.id);
    } catch { out[a.id] = []; }
  }
  return out;
}

/**
 * Граф сессии по живым таблицам.
 * `includeObjects` — объекты плана, которые нужно добавить, даже если они ни в
 * чём не участвуют: панель «Откуда это» открывается по любому контуру.
 */
async function build(sessionId, { includeObjects = [] } = {}) {
  const planSvc = require('./plan');
  const zonesSvc = require('./zones');
  const runs = require('./placement-runs');
  const annotations = require('./annotations');
  const objectEdits = require('./object-edits');
  const parcelSource = require('./parcel-source');
  const stages = require('../stages');

  const started = Date.now();
  const { planId, version, site } = await planSvc.ensurePlan(sessionId);
  const rec = zonesSvc.get(planId);
  const files = db.prepare('SELECT id, original_name, ext, size, created_at FROM files WHERE session_id = ? ORDER BY created_at').all(sessionId);
  const facts = db.prepare('SELECT key, value, source FROM facts WHERE session_id = ? ORDER BY created_at').all(sessionId);
  const notes = db.prepare('SELECT id, stage, note, created_at FROM stage_notes WHERE session_id = ? ORDER BY created_at').all(sessionId);
  const results = db.prepare('SELECT id, filename, title, format, created_at FROM results WHERE session_id = ? ORDER BY created_at').all(sessionId);
  const annList = annotations.list(sessionId, planId);
  const fromFacts = stages.requirementsFromFacts(sessionId);
  const run = runs.latestRun(sessionId);
  // требования запуска совпали с тем, что даёт разбор фактов, — значит, взяты из них
  const requirementFacts = run && fromFacts && Number(run.requirements && run.requirements.areaM2) === Number(fromFacts.areaM2)
    ? fromFacts.sources : [];

  const graph = assemble({
    files, facts, site,
    rules: rec ? rec.rules : [],
    unresolved: rec && rec.zones ? rec.zones.unresolved || [] : [],
    zonesAt: rec ? rec.updatedAt : '',
    run, requirementFacts, notes,
    edits: objectEdits.list(sessionId),
    annotations: annList,
    annotationHits: annotationHitsOf(site, annList),
    parcelSource: parcelSource.get(sessionId),
    results,
    extraObjectIds: includeObjects,
  });
  graph.planId = planId;
  graph.version = version;
  graph.stats.builtMs = Date.now() - started;
  return graph;
}

/**
 * Узел по ссылке из интерфейса. Вьювер знает объект плана и слой, журнал —
 * ссылку события; оба переводятся в id узла графа здесь, в одном месте.
 * `variant:selected` — выбранный вариант последнего запуска.
 */
function resolveNodeId(graph, raw) {
  const id = String(raw || '').trim();
  if (!id) return '';
  if (graph.nodes.some((n) => n.id === id)) return id;
  if (id === 'variant:selected' || id === 'object:footprint') {
    const v = graph.nodes.find((n) => n.type === 'variant' && n.kind === 'variant' && n.props.selected);
    return v ? v.id : '';
  }
  if (id === 'object:buildable' || id === 'object:forbidden') return graph.nodes.some((n) => n.id === 'buildable:plan') ? 'buildable:plan' : '';
  if (id.startsWith('object:')) {
    const key = id.slice(7);
    const z = graph.nodes.find((n) => n.type === 'zone' && n.props.objectId === key);
    if (z) return z.id;
    const a = graph.nodes.find((n) => n.kind === 'annotation' && n.props.annotationId === key);
    if (a) return a.id;
  }
  if (id.startsWith('zone:')) {
    const key = id.slice(5);
    const g = graph.nodes.find((n) => n.type === 'zone' && n.props.groupId === key);
    if (g) return g.id;
  }
  return '';
}

module.exports = { assemble, build, resolveNodeId, matchFile, annotationHitsOf };
