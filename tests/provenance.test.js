'use strict';
/**
 * Происхождение (07.10.2026): структурный журнал, граф связей сессии посадки,
 * цепочка «откуда это», сквозная нумерация правил при слиянии.
 *
 * Сборка графа проверяется на синтетической площадке без базы (assemble —
 * чистая функция), журнал и маршруты — через настоящий сервер в mock-режиме.
 */
const os = require('os');
const path = require('path');
const fs = require('fs');
process.env.DATA_DIR = path.join(os.tmpdir(), `pilot1-prov-${process.pid}`);
process.env.ANTHROPIC_API_KEY = '';
process.env.USERS_FILE = path.join(os.tmpdir(), `pilot1-prov-users-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
process.env.RATE_LIMIT_GENERAL = '1000';
process.env.RATE_LIMIT_EXPENSIVE = '1000';
process.env.CLOUD_AI_OPEN = '1';

const { test, before, after } = require('node:test');
const assert = require('node:assert');

const core = require('../public/provenance-core.js');
const graphSvc = require('../server/services/geometry/provenance-graph');
const cadGeom = require('../server/services/geometry/cad-geometry');
const engine = require('../server/services/geometry/restriction-engine');
const RR = require('../server/services/geometry/restriction-rules');
const RE = require('../server/services/geometry/restriction-extract');
const P = require('../server/services/geometry/placement-engine');
const V = require('../server/services/geometry/variants');
const { writeDxf } = require('../server/services/dxf');

/* ================= синтетическая площадка ================= */

const parcel = { layer: 'Границы ЗУ', closed: true, points: [[0, 0], [120, 0], [120, 80], [0, 80]] };
const lep = { layer: 'ЛЭП 10 кВ', closed: false, points: [[0, 70], [120, 70]] };
const shed = { layer: 'Здания и строения', closed: true, points: [[100, 10], [115, 10], [115, 25], [100, 25]] };

const files = [
  { id: 'f-dwg', original_name: 'площадка.dxf', ext: 'dxf', size: 1000, created_at: '2026-10-07T08:00:00.000Z' },
  { id: 'f-gpzu', original_name: 'ГПЗУ.pdf', ext: 'pdf', size: 2000, created_at: '2026-10-07T08:00:00.000Z' },
];
const facts = [
  { key: 'parcel.min_setback_m', value: '3', source: 'ГПЗУ' },
  { key: 'object.footprint_area_m2', value: '600', source: 'ГПЗУ, стр. 2' },
  { key: 'object.floors', value: '2', source: 'ТЗ' },
];

function siteWithZones() {
  const site = cadGeom.fromDxf(writeDxf([parcel, lep, shed]), { fileName: 'площадка.dxf', fileId: 'f-dwg' });
  const fromModel = [{
    kind: 'protectionZone', operation: 'bufferOutward', targetSelector: 'utility', targetHint: 'ЛЭП',
    value: 10, unit: 'м', condition: '', appliesTo: 'newBuilding', basis: 'ПП РФ № 160, п. 8',
    sourceDocument: 'ГПЗУ.pdf', sourceClause: 'раздел 2', quote: 'охранная зона ВЛ 10 кВ — 10 м', confidence: 0.9, note: '',
  }].map((r, i) => RR.normalizeRule(r, i).rule);
  for (const r of fromModel) RR.assignStatus(r);
  const derived = RE.rawRulesFromFacts(facts).map((r, i) => RR.normalizeRule(r, i).rule).filter(Boolean);
  for (const r of derived) RR.assignStatus(r);
  const rules = RE.mergeRules(fromModel, derived);
  const built = engine.build(site, rules);
  site.restrictions = built.restrictions;
  site.zoneGroups = built.zoneGroups || [];
  site.buildable = built.buildable;
  return { site, rules, built };
}

function runFor(site, { floors = 2 } = {}) {
  const gen = P.generate(site, site.buildable, { areaM2: 600, floors }, { limit: 80 });
  const { variants } = V.build(site, gen.candidates, { criterion: 'maxArea' });
  assert.ok(variants.length >= 1, 'на площадке обязан найтись хотя бы один вариант');
  const run = {
    id: 'run-1', planId: 'plan-1', requirements: { areaM2: 600, floors }, criterion: 'maxArea',
    stats: { перебрано: gen.tried }, createdAt: '2026-10-07T10:00:00.000Z',
    variants: variants.map((v, i) => ({
      id: `v-${i + 1}`, runId: 'run-1', number: v.number, footprint: v.footprint, metrics: v.metrics,
      status: v.status, statusLabel: v.statusLabel, selected: i === 0,
      actions: v.actions.map((a, j) => ({
        id: `a-${i + 1}-${j + 1}`, kind: a.kind, objectId: a.objectId, title: a.title, volume: a.volume, unit: a.unit,
        classification: a.classification, requiresDecision: a.requiresDecision, decision: j === 0 ? 'allow' : '',
        note: j === 0 ? 'решение принял Тестов Пробный (2026-10-07T10:05:00.000Z)' : '',
      })),
    })),
  };
  return run;
}

test('слияние правил: правило из факта не повторяет id правила модели', () => {
  const model = [{
    kind: 'protectionZone', operation: 'bufferOutward', targetSelector: 'utility', targetHint: 'ЛЭП',
    value: 10, unit: 'м', confidence: 0.9, basis: 'ПП 160', sourceDocument: 'ГПЗУ', sourceClause: '', quote: '',
    condition: '', appliesTo: 'newBuilding', note: '',
  }].map((r, i) => RR.normalizeRule(r, i).rule);
  const derived = RE.rawRulesFromFacts([{ key: 'parcel.min_setback_m', value: '3', source: 'ГПЗУ' }]).map((r, i) => RR.normalizeRule(r, i).rule);
  assert.strictEqual(derived[0].id, 'rule-1', 'выведенное правило нумеруется с нуля — это и было источником коллизии');
  const merged = RE.mergeRules(model, derived);
  assert.deepStrictEqual(merged.map((r) => r.id), ['rule-1', 'rule-2']);
  assert.strictEqual(new Set(merged.map((r) => r.id)).size, merged.length, 'идентификаторы после слияния уникальны');
  // без правил модели нумерация выведенных не трогается
  assert.deepStrictEqual(RE.mergeRules([], derived).map((r) => r.id), ['rule-1']);
  // дубль по смыслу по-прежнему не удваивается
  assert.strictEqual(RE.mergeRules(derived, derived).length, 1);
});

test('граф: документ → факт → правило → объект → зона → территория → подбор → вариант → мероприятие → решение', () => {
  const { site, rules, built } = siteWithZones();
  assert.ok(site.restrictions.length >= 2, `ожидались зоны от ЛЭП и отступ: ${site.restrictions.length}`);
  const run = runFor(site);
  const g = graphSvc.assemble({
    files, facts, site, rules, unresolved: built.unresolved, zonesAt: '2026-10-07T09:00:00.000Z',
    run, requirementFacts: ['object.footprint_area_m2 = 600', 'object.floors = 2'],
    notes: [
      { id: 'n1', stage: 'zones', note: 'ЛЭП считать 10 кВ', created_at: '2026-10-07T08:30:00.000Z' },
      { id: 'n2', stage: 'variants', note: 'ближе к дороге', created_at: '2026-10-07T09:30:00.000Z' },
      { id: 'n3', stage: 'variants', note: 'после подбора — не учтено', created_at: '2026-10-07T11:00:00.000Z' },
    ],
    edits: [], annotations: [], annotationHits: {}, parcelSource: null,
    results: [{ id: 'r1', filename: 'ОТЧЁТ.md', title: 'отчёт', format: 'md', created_at: '2026-10-07T08:10:00.000Z' },
      { id: 'r2', filename: 'чертёж.dxf', title: 'чертёж', format: 'dxf', created_at: '2026-10-07T12:00:00.000Z' }],
  });
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const has = (from, to, rel) => g.edges.some((e) => e.from === from && e.to === to && (!rel || e.rel === rel));

  // документы и факты
  assert.ok(has('file:f-gpzu', 'fact:parcel.min_setback_m', 'source'), 'факт «ГПЗУ» привязан к файлу ГПЗУ.pdf по имени');
  assert.ok(has('file:f-gpzu', 'fact:object.footprint_area_m2', 'source'), 'источник «ГПЗУ, стр. 2» тоже опознан');
  assert.ok(byId.get('fact:object.floors').orphan, 'факт из «ТЗ» без файла помечен: документ не найден');

  // правила: модельное — от документа, выведенное — от факта; идентификаторы сквозные
  const modelRule = g.nodes.find((n) => n.type === 'rule' && n.kind === 'rule');
  const derivedRule = g.nodes.find((n) => n.type === 'rule' && n.kind === 'derived');
  assert.ok(modelRule && derivedRule, 'оба правила в графе');
  assert.ok(has('file:f-gpzu', modelRule.id, 'source'));
  assert.ok(has('fact:parcel.min_setback_m', derivedRule.id, 'derives'));
  assert.notStrictEqual(modelRule.id, derivedRule.id);

  // зоны: от правила и от объекта отсчёта, все образуют территорию
  const zones = g.nodes.filter((n) => n.type === 'zone');
  assert.strictEqual(zones.length, site.restrictions.length);
  for (const z of zones) {
    assert.ok(!z.orphan, `зона без происхождения: ${z.label} — ${z.why}`);
    assert.ok(g.edges.some((e) => e.to === z.id && e.rel === 'builds'), `у зоны нет правила: ${z.label}`);
    assert.ok(g.edges.some((e) => e.to === z.id && e.rel === 'from'), `у зоны нет объекта отсчёта: ${z.label}`);
    assert.ok(has(z.id, 'buildable:plan', 'forms'));
  }
  const lepZone = zones.find((n) => /ЛЭП/.test(n.label));
  assert.ok(lepZone, 'зона от ЛЭП названа по объекту');
  const lepObject = g.edges.find((e) => e.to === lepZone.id && e.rel === 'from').from;
  assert.ok(has('file:f-dwg', lepObject, 'source'), 'объект ЛЭП привязан к чертежу по sourceFileId');

  // замечания: учтённое при расчёте — связано, более позднее — нет
  assert.ok(has('human:note-n1', 'buildable:plan', 'notes'));
  assert.ok(has('human:note-n2', 'variant:run-run-1', 'notes'));
  assert.ok(!g.edges.some((e) => e.from === 'human:note-n3'), 'замечание после подбора к нему не привязывается');

  // подбор, варианты, мероприятия, решение, комплект
  assert.ok(has('buildable:plan', 'variant:run-run-1', 'places'));
  assert.ok(has('fact:object.footprint_area_m2', 'variant:run-run-1', 'requires'), 'требования взяты из факта');
  assert.ok(has('variant:run-run-1', 'variant:v-1', 'places'));
  const selected = byId.get('variant:v-1');
  assert.strictEqual(selected.props.selected, true);
  assert.strictEqual(selected.props.objectId, 'footprint', 'выбранный вариант показывается на плане пятном');
  const actions = g.nodes.filter((n) => n.type === 'action');
  if (actions.length) {
    const a = actions[0];
    assert.ok(g.edges.some((e) => e.to === a.id && e.rel === 'requires'));
    assert.ok(g.edges.some((e) => e.from === a.id && e.rel === 'affects'), 'мероприятие ведёт к задетому объекту');
    const decided = actions.find((n) => n.props.decision);
    if (decided) assert.ok(has(`human:decision-${decided.props.actionId}`, decided.id, 'decides'));
  }
  assert.ok(has('variant:v-1', 'result:r2', 'produces'), 'чертёж после выбора — от выбранного варианта');
  assert.ok(has('file:f-dwg', 'result:r1', 'analysis'), 'отчёт анализа — от исходных документов');

  // статистика честная: число без происхождения совпадает со списком
  assert.strictEqual(g.stats.missing, g.missing.length);
  assert.strictEqual(g.stats.coverage.zone.linked, zones.length);
  assert.ok(g.stats.objectsInGraph <= g.stats.objectsOnPlan, 'в граф попадают только задействованные объекты');
});

test('цепочка «откуда это»: предки по колонкам, следствия на шаг, зоны сворачиваются по правилам', () => {
  const { site, rules, built } = siteWithZones();
  const run = runFor(site);
  const g = graphSvc.assemble({ files, facts, site, rules, unresolved: built.unresolved, zonesAt: '2026-10-07T09:00:00.000Z', run, results: [] });
  const zone = g.nodes.find((n) => n.type === 'zone' && /ЛЭП/.test(n.label));
  const chain = core.chain(g, zone.id, { down: 1 });
  const types = chain.ancestors.map((n) => n.type);
  assert.deepStrictEqual([...new Set(types)], ['file', 'rule', 'object'], `порядок предков по колонкам: ${types}`);
  assert.ok(chain.ancestors.some((n) => n.id === 'file:f-gpzu'), 'документ — в начале цепочки');
  assert.deepStrictEqual(chain.descendants.map((n) => n.id), ['buildable:plan'], 'следствие зоны на один шаг — территория');
  assert.ok(chain.links >= 3);
  assert.strictEqual(core.chain(g, 'zone:нет-такой'), null);

  // от варианта вверх — до документа через территорию, зоны, правила и факты
  const up = core.chain(g, 'variant:v-1', { down: 1 });
  const upTypes = new Set(up.ancestors.map((n) => n.type));
  for (const t of ['file', 'fact', 'rule', 'object', 'zone', 'buildable', 'variant']) assert.ok(upTypes.has(t), `в предках варианта нет колонки ${t}`);

  // окрестность и свёртка
  const near = core.neighborhood(g, zone.id, 1);
  assert.ok(near.has('buildable:plan') && near.size < g.nodes.length);
  const folded = core.foldZones(g);
  const groups = folded.nodes.filter((n) => n.type === 'zone');
  assert.ok(groups.every((n) => n.kind === 'group'));
  assert.ok(groups.length < g.nodes.filter((n) => n.type === 'zone').length || groups.length === rules.length);
  assert.ok(folded.edges.every((e) => folded.nodes.some((n) => n.id === e.from) && folded.nodes.some((n) => n.id === e.to)), 'после свёртки рёбра целы');
  const grp = groups.find((n) => n.props.ruleId === zone.props.ruleId);
  assert.ok(grp && grp.props.zoneIds.includes(zone.props.objectId));
  assert.strictEqual(graphSvc.resolveNodeId(g, `zone:${grp.props.groupId}`), zone.id, 'ссылка на группу разрешается в одну из её зон');
  assert.strictEqual(graphSvc.resolveNodeId(g, 'variant:selected'), 'variant:v-1');
  assert.strictEqual(graphSvc.resolveNodeId(g, `object:${zone.props.objectId}`), zone.id, 'объект вьювера со слоя зон — узел зоны');
  assert.strictEqual(graphSvc.resolveNodeId(g, 'object:buildable'), 'buildable:plan');
});

test('граф: зона без правила в последнем расчёте и объект без файла помечаются, а не пропадают', () => {
  const { site, rules, built } = siteWithZones();
  const g = graphSvc.assemble({ files: [], facts: [], site, rules: rules.slice(0, 1), unresolved: built.unresolved, run: null, results: [] });
  const orphans = g.nodes.filter((n) => n.type === 'zone' && n.orphan);
  assert.ok(orphans.length >= 1, 'зона отступа ссылается на правило, которого в переданном списке нет');
  assert.match(orphans[0].why, /не найдено в последнем расчёте/);
  const objects = g.nodes.filter((n) => n.type === 'object');
  assert.ok(objects.length && objects.every((n) => n.orphan && /не найден среди файлов/.test(n.why)), 'файлов сессии нет — у объектов честная причина');
  assert.ok(g.missing.every((m) => m.why));
});

/* ================= сервер: журнал и маршруты ================= */

let server, base, userToken = '';
before(async () => {
  const { createApp } = require('../server/app');
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server.close();
  fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
});

const api = async (p, opts = {}) => {
  const res = await fetch(base + p, opts);
  let body = null;
  try { body = await res.clone().json(); } catch { body = await res.text(); }
  return { status: res.status, body };
};
const asUser = () => (userToken ? { 'X-User-Token': userToken } : {});
const auth = (s) => ({ Authorization: `Bearer ${s.token}`, ...asUser() });
async function login() {
  const { body } = await api('/api/auth/enter', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lastName: 'Тестов', firstName: 'Пробный' }),
  });
  return body.token || '';
}
async function createSession() {
  if (!userToken) userToken = await login();
  const { status, body } = await api('/api/sessions', { method: 'POST', headers: asUser() });
  assert.strictEqual(status, 201);
  return body;
}
async function uploadDxf(s) {
  const fd = new FormData();
  fd.append('files', new File([writeDxf([parcel, lep, shed])], 'площадка.dxf', { type: 'application/dxf' }));
  const { status, body } = await api(`/api/sessions/${s.id}/files`, { method: 'POST', headers: auth(s), body: fd });
  assert.ok(status === 200 || status === 201, `загрузка чертежа: ${status} ${JSON.stringify(body)}`);
}

test('журнал: событие со ссылками и причиной читается структурно, старое событие — без них', async () => {
  const journal = require('../server/services/journal');
  const { db, now } = require('../server/db');
  const s = await createSession();
  const before0 = journal.stats(s.id).total; // создание сессии уже пишет событие
  // «старое» событие — прямой INSERT без новых колонок, как писал весь код до 07.10.2026
  db.prepare('INSERT INTO events (session_id, stage, detail, level, created_at) VALUES (?,?,?,?,?)').run(s.id, 'Старое событие', '', 'info', now());
  assert.ok(journal.logEvent(s.id, 'Зоны построены', 'зон 2', 'info', {
    ref: [journal.ref('rule', 'rule-1', 'охранная зона 10 м'), journal.ref('rule', 'rule-1', 'дубль'), null, journal.ref('buildable', 'plan', 'территория'), { type: 'bad' }],
    cause: journal.ref('human', 'note-1', 'замечание: ЛЭП 10 кВ'),
  }));
  assert.ok(journal.logEvent(s.id, 'Без ссылок'));
  const list = journal.list(s.id, { limit: 3 });
  assert.strictEqual(list[0].stage, 'Без ссылок');
  assert.deepStrictEqual(list[0].ref, []);
  assert.strictEqual(list[0].cause, null);
  const ev = list[1];
  assert.strictEqual(ev.stage, 'Зоны построены');
  assert.deepStrictEqual(ev.ref.map((r) => `${r.type}:${r.id}`), ['rule:rule-1', 'buildable:plan'], 'дубли и мусор отброшены');
  assert.strictEqual(ev.cause.id, 'note-1');
  assert.strictEqual(list[2].stage, 'Старое событие');
  assert.deepStrictEqual(list[2].ref, [], 'старая строка читается пустыми ссылками');
  const st = journal.stats(s.id);
  assert.deepStrictEqual(st, { total: before0 + 3, withRef: 1, withCause: 1 });
  // в выдаче сессии события несут те же поля
  const view = await api(`/api/sessions/${s.id}`, { headers: auth(s) });
  const got = view.body.events.find((e) => e.stage === 'Зоны построены');
  assert.ok(Array.isArray(got.ref) && got.ref.length === 2 && got.cause && got.cause.type === 'human');
  const j = await api(`/api/sessions/${s.id}/journal?limit=2`, { headers: auth(s) });
  assert.strictEqual(j.body.events.length, 2);
  assert.strictEqual(j.body.stats.total, before0 + 3);
  assert.strictEqual(journal.logEvent('00000000-0000-0000-0000-000000000000', 'в никуда'), false, 'исчезнувшая сессия — молчаливый пропуск');
});

test('маршруты: правка объекта и выделение дают события со ссылками, граф и «откуда это» отвечают по живому плану', async () => {
  const s = await createSession();
  await uploadDxf(s);
  const plan = await api(`/api/sessions/${s.id}/plan`, { headers: auth(s) });
  assert.strictEqual(plan.status, 200);
  const lepObj = plan.body.plan.utilities.find((o) => /ЛЭП/.test(o.provenance.sourceLayer));
  assert.ok(lepObj, 'ЛЭП разобрана как сеть');

  // правка объекта → событие ссылается на объект и правку, причина — человек
  const edit = await api(`/api/sessions/${s.id}/plan/objects/${lepObj.id}`, {
    method: 'POST', headers: { ...auth(s), 'Content-Type': 'application/json' }, body: JSON.stringify({ label: 'ВЛ-10 кВ' }),
  });
  assert.strictEqual(edit.status, 200);
  const ann = await api(`/api/sessions/${s.id}/annotations`, {
    method: 'POST', headers: { ...auth(s), 'Content-Type': 'application/json' },
    body: JSON.stringify({ planId: plan.body.planId, geometry: { points: [[0, 60], [120, 60], [120, 80], [0, 80]] }, geometryType: 'rect', comment: 'линия под охранную зону' }),
  });
  assert.strictEqual(ann.status, 201, JSON.stringify(ann.body));

  const view = await api(`/api/sessions/${s.id}`, { headers: auth(s) });
  const edited = view.body.events.find((e) => e.stage === 'Свойства объекта плана исправлены');
  assert.ok(edited, 'событие правки есть');
  assert.deepStrictEqual(edited.ref.map((r) => r.type), ['object', 'human']);
  assert.strictEqual(edited.ref[0].id, lepObj.id);
  assert.strictEqual(edited.cause.type, 'person');
  assert.match(edited.cause.label, /Тестов/);
  const marked = view.body.events.find((e) => e.stage === 'Добавлено выделение на плане');
  assert.strictEqual(marked.ref[0].type, 'annotation');
  assert.strictEqual(marked.ref[0].id, ann.body.id);

  // граф по живым таблицам: чертёж, объект ЛЭП, правка, пометка с объектами внутри
  const graph = await api(`/api/sessions/${s.id}/provenance/graph`, { headers: auth(s) });
  assert.strictEqual(graph.status, 200);
  const g = graph.body;
  assert.ok(g.nodes.some((n) => n.id === `object:${lepObj.id}` && /ВЛ-10 кВ/.test(n.label)), 'объект назван подписью человека');
  assert.ok(g.edges.some((e) => e.from === `human:edit-${edit.body.id}` && e.to === `object:${lepObj.id}` && e.rel === 'edits'));
  assert.ok(g.edges.some((e) => e.from === `human:annotation-${ann.body.id}` && e.to === `object:${lepObj.id}` && e.rel === 'marks'), 'пометка ведёт к объектам внутри рамки');
  assert.ok(g.edges.some((e) => e.from === 'file:' + plan.body.plan.utilities[0].provenance.sourceFileId && e.to === `object:${lepObj.id}`), 'объект привязан к чертежу');
  assert.ok(Number.isFinite(g.stats.builtMs));

  // «откуда это» по объекту вьювера и по псевдоузлу
  const of = await api(`/api/sessions/${s.id}/provenance/of/${encodeURIComponent(`object:${lepObj.id}`)}`, { headers: auth(s) });
  assert.strictEqual(of.status, 200);
  assert.strictEqual(of.body.node.id, `object:${lepObj.id}`);
  assert.ok(of.body.ancestors.some((n) => n.type === 'file'));
  assert.ok(of.body.descendants.length === 0 || of.body.descendants.every((n) => n.type !== 'file'));
  // объект, который ни в чём не участвует, в общий граф не входит, но «откуда это» у него есть
  const shedObj = plan.body.plan.buildings[0];
  assert.ok(!g.nodes.some((n) => n.id === `object:${shedObj.id}`), 'незадействованный сарай в общем графе лишний');
  const ofShed = await api(`/api/sessions/${s.id}/provenance/of/${encodeURIComponent(`object:${shedObj.id}`)}`, { headers: auth(s) });
  assert.strictEqual(ofShed.status, 200);
  assert.ok(ofShed.body.ancestors.some((n) => n.type === 'file'), 'у сарая есть чертёж-источник');
  const withShed = await api(`/api/sessions/${s.id}/provenance/graph?include=${shedObj.id}`, { headers: auth(s) });
  assert.ok(withShed.body.nodes.some((n) => n.id === `object:${shedObj.id}`), '?include= добавляет объект в граф');
  const missing = await api(`/api/sessions/${s.id}/provenance/of/zone:none`, { headers: auth(s) });
  assert.strictEqual(missing.status, 404);
  assert.match(missing.body.error, /не найден/);

  // чужой токен — как у плана: 404 без подтверждения существования
  const stranger = await api(`/api/sessions/${s.id}/provenance/graph`, { headers: { Authorization: 'Bearer wrong', ...asUser() } });
  assert.strictEqual(stranger.status, 404);
  const badId = await api('/api/sessions/not-a-uuid/provenance/graph', { headers: asUser() });
  assert.strictEqual(badId.status, 400);
});
