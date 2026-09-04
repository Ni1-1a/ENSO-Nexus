'use strict';
/* Модуль «Анализ ТЗ»: чек-листы, дедуп и вердикт, маршруты, прогон с
 * подменённой моделью, решения по находкам, экспорт XLSX/DOCX.
 * Живой сервер на эфемерном порту — по образцу tests/dataset.test.js;
 * вызов модели подменён (_setCallFn): живая модель тестам не нужна. */
const os = require('os');
const path = require('path');
const fs = require('fs');
process.env.DATA_DIR = path.join(os.tmpdir(), `pilot1-tz-${process.pid}`);
process.env.ANTHROPIC_API_KEY = '';
process.env.USERS_FILE = path.join(os.tmpdir(), `pilot1-tz-users-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
process.env.RATE_LIMIT_GENERAL = '1000';
process.env.RATE_LIMIT_EXPENSIVE = '1000';
// потолок текста документа — маленький, чтобы проверить 422 без мегабайтных тел
process.env.DOC_CHAR_LIMIT = '100000';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const AdmZip = require('adm-zip');
const { createApp } = require('../server/app');
const checklists = require('../server/services/tz/checklists');
const { dedupe, verdict, readiness } = require('../server/services/tz/dedup');
const analyze = require('../server/services/tz/analyze');
const tzStore = require('../server/services/tz/store');

let server, base;

before(async () => {
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server.close();
  fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
  fs.rmSync(process.env.USERS_FILE, { force: true });
});

const api = async (p, opts = {}) => {
  const res = await fetch(base + p, opts);
  let body = null;
  try { body = await res.clone().json(); } catch { body = await res.text(); }
  return { status: res.status, body, res };
};

let userToken = '';
async function login(lastName = 'Проверяющий', firstName = 'Тест') {
  const { body } = await api('/api/auth/enter', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lastName, firstName }),
  });
  return body.token || '';
}
const asUser = (token = userToken) => ({ 'X-User-Token': token });
const json = (obj, token = userToken) => ({
  headers: { 'Content-Type': 'application/json', ...asUser(token) },
  body: JSON.stringify(obj),
});

/* ---------------- чек-листы: целостность данных ---------------- */

test('чек-листы: оба пилотных типа на месте, id уникальны, источники заполнены', () => {
  const meta = checklists.meta();
  assert.deepStrictEqual(meta.map((c) => c.id).sort(), ['housing', 'production']);
  for (const { id } of meta) {
    const list = checklists.get(id).items;
    const ids = list.map((i) => i.id);
    assert.strictEqual(new Set(ids).size, ids.length, `${id}: id пунктов не уникальны`);
    for (const item of list) {
      assert.ok(item.label && item.source && item.source.doc && item.source.clause,
        `${id}/${item.id}: пункт без источника`);
      assert.match(item.source.status, /утратил силу/, `${id}/${item.id}: статус МР № 357 обязан быть проговорён`);
    }
  }
});

test('чек-листы: серьёзность отсутствия — блокер только для бюджета с пунктом формы 307/пр', () => {
  const item = checklists.get('production').items.find((i) => i.id === 'cost');
  assert.strictEqual(checklists.missingSeverity(item, 'НЕТ', 'бюджет'), 'БЛОКЕР');
  assert.strictEqual(checklists.missingSeverity(item, 'НЕТ', 'внебюджет'), 'СУЩЕСТВЕННО'); // key: true
  assert.strictEqual(checklists.missingSeverity(item, 'НЕПОЛНО', 'бюджет'), 'СУЩЕСТВЕННО');
  assert.strictEqual(checklists.missingSeverity(item, 'ЕСТЬ', 'бюджет'), null);
  const minor = checklists.get('production').items.find((i) => !i.key && i.form307);
  assert.strictEqual(checklists.missingSeverity(minor, 'НЕТ', 'внебюджет'), 'ЗАМЕЧАНИЕ');
  // источник для бюджетного объекта — действующая форма 307/пр, не мёртвый приказ
  assert.match(checklists.findingSource(item, 'бюджет').doc, /307\/пр/);
  assert.match(checklists.findingSource(item, 'внебюджет').doc, /357/);
});

/* ---------------- дедуп и вердикт (спека v1.1) ---------------- */

test('дедуп: один пункт и одна суть сливаются, severity — максимальная, источники объединяются', () => {
  const merged = dedupe([
    { severity: 'ЗАМЕЧАНИЕ', category: 'полнота', znp_ref: 'п. 2.4', problem: 'Нет мощности производства', requirement_source: { doc: 'A', clause: '1' } },
    { severity: 'СУЩЕСТВЕННО', category: 'формулировка', znp_ref: 'п. 2.4.', problem: 'нет мощности производства', requirement_source: { doc: 'B', clause: '2' } },
    { severity: 'ЗАМЕЧАНИЕ', category: 'формулировка', znp_ref: 'п. 3.1', problem: 'Другой дефект', requirement_source: null },
  ]);
  assert.strictEqual(merged.length, 2);
  const first = merged.find((f) => f.znp_ref === 'п. 2.4');
  assert.strictEqual(first.severity, 'СУЩЕСТВЕННО');
  assert.strictEqual(first.sources.length, 2);
  assert.match(merged[0].id, /^F-001$/);
});

test('вердикт: пороги v1.1 — блокер сильнее всего, одно СУЩЕСТВЕННО не даёт «готово»', () => {
  const matrix = [
    { status: 'ЕСТЬ' }, { status: 'ЕСТЬ' }, { status: 'НЕТ' }, { status: 'НЕПРИМЕНИМО' },
  ];
  assert.strictEqual(readiness(matrix), 67); // 2 из 3, НЕПРИМЕНИМО вне знаменателя
  assert.strictEqual(verdict([{ severity: 'БЛОКЕР', problem: 'x' }], matrix).status, 'не готово к выдаче');
  assert.strictEqual(verdict([{ severity: 'СУЩЕСТВЕННО', problem: 'x' }], matrix).status, 'условно готово');
  assert.strictEqual(verdict([{ severity: 'ЗАМЕЧАНИЕ', problem: 'x' }], matrix).status, 'готово');
  assert.strictEqual(verdict([], matrix).status, 'готово');
});

/* ---------------- маршруты ---------------- */

test('анализ ТЗ: без входа доступа нет', async () => {
  const r = await api('/api/tz/projects');
  assert.strictEqual(r.status, 401);
});

test('анализ ТЗ: meta отдаёт чек-листы и шкалу серьёзности', async () => {
  userToken = await login();
  assert.ok(userToken, 'вход не выдал токен');
  const r = await api('/api/tz/meta', { headers: asUser() });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.body.severities, ['БЛОКЕР', 'СУЩЕСТВЕННО', 'ЗАМЕЧАНИЕ', 'РЕКОМЕНДАЦИЯ']);
  assert.strictEqual(r.body.checklists.length, 2);
});

test('анализ ТЗ: проект создаётся, неизвестный чек-лист отвергается', async () => {
  const bad = await api('/api/tz/projects', { method: 'POST', ...json({ name: 'x', checklist: 'linear' }) });
  assert.strictEqual(bad.status, 400);
  const r = await api('/api/tz/projects', { method: 'POST', ...json({ name: 'Цех вакцин (тест)', checklist: 'production' }) });
  assert.strictEqual(r.status, 201);
  assert.strictEqual(r.body.project.checklist, 'production');
});

let projectId = '';

test('анализ ТЗ: текст ЗнП сохраняется, пустой отвергается', async () => {
  const created = await api('/api/tz/projects', { method: 'POST', ...json({ name: 'Прогон (тест)', checklist: 'production' }) });
  projectId = created.body.project.id;
  const empty = await api(`/api/tz/projects/${projectId}/document`, { method: 'PUT', ...json({ text: '   ' }) });
  assert.strictEqual(empty.status, 400);
  const ok = await api(`/api/tz/projects/${projectId}/document`, {
    method: 'PUT',
    ...json({ text: '1. Объект: цех. 2. Мощность: уточняется. 3. Стоимость: по смете.', name: 'тестовое ТЗ' }),
  });
  assert.strictEqual(ok.status, 200);
  assert.ok(ok.body.document.chars > 10);
});

test('анализ ТЗ: прогон без модели — честный 422', async () => {
  const r = await api(`/api/tz/projects/${projectId}/analyze`, { method: 'POST', ...json({}) });
  assert.strictEqual(r.status, 422);
});

/* Подменённая модель: классификация → полнота → находки. Возвращает по схеме шага. */
function fakeModel({ schemaName }) {
  if (schemaName === 'tz_classify') {
    return {
      text: JSON.stringify({
        checklist: 'production', object_kind: 'цех вакцин', funding: 'внебюджет',
        work_kind: 'строительство', is_opo: null, is_unique_48_1: false,
        expertise: 'негосударственная', is_repeat_expertise: null,
        region: 'Ленинградская область', cadastral: '47:14:0402001:7', notes: '',
      }),
    };
  }
  if (schemaName === 'tz_completeness') {
    const items = checklists.get('production').items.map((i, idx) => ({
      id: i.id,
      status: i.id === 'name' ? 'ЕСТЬ' : i.id === 'tep' ? 'НЕПОЛНО' : idx % 2 ? 'НЕТ' : 'ЕСТЬ',
      znp_ref: i.id === 'name' ? 'п. 1' : i.id === 'tep' ? 'п. 2' : null,
      note: '',
    }));
    return { text: JSON.stringify({ items }) };
  }
  return {
    text: JSON.stringify({
      findings: [
        {
          severity: 'СУЩЕСТВЕННО', category: 'формулировка', znp_ref: 'п. 2',
          quote: 'Мощность: уточняется', problem: 'Требование мощности непроверяемо: нет числа и единицы измерения',
          consequence: 'переделка ПД', proposed_text: 'Указать мощность в дозах/год', needs_human: false,
        },
        {
          severity: 'ЗАМЕЧАНИЕ', category: 'нормативная_база', znp_ref: 'п. 3',
          quote: 'по смете', problem: 'Ссылка на смету без реквизитов документа',
          consequence: 'срыв срока', proposed_text: null, needs_human: false,
        },
      ],
    }),
  };
}

test('анализ ТЗ: полный прогон с подменённой моделью — вердикт, матрица, дедуп, пометка офлайна', async () => {
  analyze._setCallFn(async (args) => fakeModel(args));
  try {
    // модель ставится напрямую в хранилище: validateChoice в тестовом окружении
    // честно скажет «LM Studio недоступен», а прогон идёт через подменённый вызов
    tzStore.updateProject(projectId, { provider: 'lmstudio', model: 'test-model' });
    const started = await api(`/api/tz/projects/${projectId}/analyze`, { method: 'POST', ...json({}) });
    assert.strictEqual(started.status, 202);
    const runId = started.body.runId;

    let run = null;
    for (let i = 0; i < 200; i++) {
      const r = await api(`/api/tz/runs/${runId}`, { headers: asUser() });
      run = r.body.run;
      if (['done', 'failed'].includes(run.status)) break;
      await new Promise((res) => setTimeout(res, 25));
    }
    assert.strictEqual(run.status, 'done', `прогон не завершился: ${run && run.error_text}`);
    const result = run.result;
    // матрица собрана по чек-листу целиком
    assert.strictEqual(result.checklist_matrix.length, checklists.get('production').items.length);
    // НЕПОЛНО у ключевого пункта ТЭП дало СУЩЕСТВЕННО-находку полноты
    const tep = result.findings.find((f) => f.category === 'полнота' && /ТЭП/.test(f.problem));
    assert.ok(tep, 'находка полноты по ТЭП не собрана');
    assert.strictEqual(tep.severity, 'СУЩЕСТВЕННО');
    // источник находки полноты — реквизиты из данных, не из модели
    assert.match(tep.requirement_source.doc, /357/);
    // нормативная_база принудительно needs_human: статус НПА в v1 не сверяется
    const norm = result.findings.find((f) => f.category === 'нормативная_база');
    assert.strictEqual(norm.needs_human, true);
    // вердикт по порогам: есть СУЩЕСТВЕННО, блокеров нет → «условно готово»
    assert.strictEqual(result.verdict.status, 'условно готово');
    assert.strictEqual(result.verdict.blocking_count, 0);
    // офлайн-режим проговорён и в результате, и в «не удалось проверить»
    assert.match(result.norm_check_note, /не проверялась/);
    assert.ok(result.unverified.some((u) => /внешних источников/.test(u.why)));
  } finally {
    analyze._setCallFn(null);
  }
});

test('анализ ТЗ: решение по находке ставит человек, ФИО пишет сервер; экспорт отдаёт живые XLSX и DOCX', async () => {
  const project = await api(`/api/tz/projects/${projectId}`, { headers: asUser() });
  const runId = project.body.runs[0].id;
  const run = (await api(`/api/tz/runs/${runId}`, { headers: asUser() })).body.run;
  const fid = run.result.findings[0].id;

  const bad = await api(`/api/tz/runs/${runId}/findings/${fid}/decision`, { method: 'POST', ...json({ decision: 'чужое' }) });
  assert.strictEqual(bad.status, 400);
  const set = await api(`/api/tz/runs/${runId}/findings/${fid}/decision`, { method: 'POST', ...json({ decision: 'accepted' }) });
  assert.strictEqual(set.status, 200);
  assert.strictEqual(set.body.decision.decision, 'accepted');
  assert.match(set.body.decision.by, /Проверяющий/);

  const xlsx = await fetch(`${base}/api/tz/runs/${runId}/export.xlsx`, { headers: asUser() });
  assert.strictEqual(xlsx.status, 200);
  const xbuf = Buffer.from(await xlsx.arrayBuffer());
  assert.strictEqual(xbuf.slice(0, 2).toString(), 'PK', 'XLSX не является zip-контейнером');
  const xzip = new AdmZip(xbuf);
  const sheet = xzip.getEntry('xl/worksheets/sheet1.xml').getData().toString('utf8');
  assert.match(sheet, /Реестр|Серьёзность/u);
  assert.ok(sheet.includes(fid), 'в реестре нет находки');
  assert.match(sheet, /принято/, 'решение человека не попало в реестр');

  const docx = await fetch(`${base}/api/tz/runs/${runId}/export.docx`, { headers: asUser() });
  assert.strictEqual(docx.status, 200);
  const dbuf = Buffer.from(await docx.arrayBuffer());
  const dzip = new AdmZip(dbuf);
  const doc = dzip.getEntry('word/document.xml').getData().toString('utf8');
  assert.match(doc, /Заключение по результатам проверки/);
  assert.match(doc, /условно готово/);
  assert.match(doc, /не проверялась/, 'офлайн-пометка обязана быть в DOCX');
});

test('анализ ТЗ: упавший прогон без результата не роняет список прогонов', async () => {
  // регресс боевого бага: json_extract('') бросал «malformed JSON», и карточка
  // проекта с любым failed-прогоном отвечала 500
  const project = tzStore.projectById(projectId);
  const failed = tzStore.createRun(project, null);
  tzStore.setRunStatus(failed.id, 'failed', { error: 'terminated (тест)' });
  const r = await api(`/api/tz/projects/${projectId}`, { headers: asUser() });
  assert.strictEqual(r.status, 200);
  const row = r.body.runs.find((x) => x.id === failed.id);
  assert.ok(row, 'упавший прогон пропал из списка');
  assert.strictEqual(row.verdict_status, null);
});

test('анализ ТЗ: удаление проекта мягкое — прогон остаётся читаемым', async () => {
  const created = await api('/api/tz/projects', { method: 'POST', ...json({ name: 'На удаление', checklist: 'housing' }) });
  const id = created.body.project.id;
  const del = await api(`/api/tz/projects/${id}`, { method: 'DELETE', headers: asUser() });
  assert.strictEqual(del.status, 200);
  const gone = await api(`/api/tz/projects/${id}`, { headers: asUser() });
  assert.strictEqual(gone.status, 404);
  // прогон первого проекта по-прежнему открывается
  const project = await api(`/api/tz/projects/${projectId}`, { headers: asUser() });
  const runId = project.body.runs[0].id;
  const run = await api(`/api/tz/runs/${runId}`, { headers: asUser() });
  assert.strictEqual(run.status, 200);
});

/* ---------------- границы входа ---------------- */

function fileForm(name, content, type = 'application/octet-stream') {
  const fd = new FormData();
  fd.append('file', new File([content], name, { type }));
  return fd;
}

test('анализ ТЗ: документ больше потолка — 422 с числами, текстом и файлом', async () => {
  const created = await api('/api/tz/projects', { method: 'POST', ...json({ name: 'Большой (тест)', checklist: 'production' }) });
  const id = created.body.project.id;
  const big = 'x'.repeat(100001);
  const text = await api(`/api/tz/projects/${id}/document`, { method: 'PUT', ...json({ text: big, name: 'big.txt' }) });
  assert.strictEqual(text.status, 422, JSON.stringify(text.body).slice(0, 200));
  assert.match(text.body.error, /слишком большой: 100001 символов при пределе 100000/);
  const file = await api(`/api/tz/projects/${id}/document/file`, {
    method: 'POST', headers: asUser(), body: fileForm('big.txt', big, 'text/plain'),
  });
  assert.strictEqual(file.status, 422, JSON.stringify(file.body).slice(0, 200));
  assert.match(file.body.error, /слишком большой/);
  // документ не сохранён
  const p = await api(`/api/tz/projects/${id}`, { headers: asUser() });
  assert.strictEqual(p.body.project.document_chars, 0);
});

test('анализ ТЗ: PATCH с пустым именем — 400, имя не тронуто', async () => {
  const created = await api('/api/tz/projects', { method: 'POST', ...json({ name: 'Имя (тест)', checklist: 'production' }) });
  const id = created.body.project.id;
  for (const name of [null, '   ', '']) {
    const r = await api(`/api/tz/projects/${id}`, { method: 'PATCH', ...json({ name }) });
    assert.strictEqual(r.status, 400, `name=${JSON.stringify(name)}: ${r.status} ${JSON.stringify(r.body)}`);
    assert.match(r.body.error, /не может быть пустым/);
  }
  const p = await api(`/api/tz/projects/${id}`, { headers: asUser() });
  assert.strictEqual(p.body.project.name, 'Имя (тест)');
});

test('анализ ТЗ: подделка под PDF/DOCX — 422 «не является», а не «скан»', async () => {
  const created = await api('/api/tz/projects', { method: 'POST', ...json({ name: 'Подделка (тест)', checklist: 'production' }) });
  const id = created.body.project.id;
  const pdf = await api(`/api/tz/projects/${id}/document/file`, {
    method: 'POST', headers: asUser(), body: fileForm('тз.pdf', 'MZ это не pdf', 'application/pdf'),
  });
  assert.strictEqual(pdf.status, 422, JSON.stringify(pdf.body));
  assert.match(pdf.body.error, /не является PDF/);
  assert.doesNotMatch(pdf.body.error, /скан/);
  const docx = await api(`/api/tz/projects/${id}/document/file`, {
    method: 'POST', headers: asUser(), body: fileForm('тз.docx', 'просто текст', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
  });
  assert.strictEqual(docx.status, 422, JSON.stringify(docx.body));
  assert.match(docx.body.error, /DOCX|Word/);
});
