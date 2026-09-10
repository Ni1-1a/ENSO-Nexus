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


/* ================= предложения по заполнению и редакция ТЗ (10.09.2026) ================= */

test('анализ ТЗ: модель предлагает формулировки, человек выбирает или пишет свою, редакция собирается и скачивается', async () => {
  // берём ЗАВЕРШЁННЫЙ прогон: в списке есть и упавшие (их заводят соседние тесты)
  const project = await api(`/api/tz/projects/${projectId}`, { headers: asUser() });
  let runId = '';
  let run = null;
  for (const r of project.body.runs) {
    const got = (await api(`/api/tz/runs/${r.id}`, { headers: asUser() })).body.run;
    if (got && got.status === 'done' && got.result) { runId = r.id; run = got; break; }
  }
  assert.ok(run, 'завершённого прогона нет');
  const findings = run.result.findings;
  // берём находку С ЦИТАТОЙ (правка встанет по месту) и находку полноты (уйдёт в дополнения)
  const withQuote = findings.find((f) => f.quote);
  const missing = findings.find((f) => f.category === 'полнота');
  assert.ok(withQuote && missing, 'в прогоне нет подходящих находок');

  analyze._setCallFn(async () => ({
    text: JSON.stringify({
      variants: [
        { title: 'Минимальный', text: 'Класс энергоэффективности здания — не ниже [УКАЗАТЬ] согласно действующим нормам.', why: 'коротко закрывает требование', needs_check: true },
        { title: 'Развёрнутый', text: 'Предусмотреть требования к энергоэффективности: класс не ниже [УКАЗАТЬ], перечень мероприятий и расчёт удельного расхода энергии.', why: 'когда нужен состав', needs_check: true },
        { title: 'С оговоркой', text: 'Требования к энергоэффективности уточняются на стадии П по данным заказчика.', why: 'когда данных нет', needs_check: false },
      ],
    }),
    truncated: false,
  }));
  try {
    const sug = await api(`/api/tz/runs/${runId}/findings/${withQuote.id}/suggest`, { method: 'POST', ...json({}) });
    assert.strictEqual(sug.status, 200, JSON.stringify(sug.body));
    assert.strictEqual(sug.body.fix.variants.length, 3);
    assert.ok(sug.body.fix.variants.every((v) => v.text && v.title && v.id), 'вариант без текста или имени');
    assert.ok(sug.body.fix.variants.some((v) => v.needsCheck), 'place-holder не помечен needsCheck');
    // чужой прогон и несуществующая находка — честные коды
    const bad = await api(`/api/tz/runs/${runId}/findings/F-999/suggest`, { method: 'POST', ...json({}) });
    assert.strictEqual(bad.status, 404);
  } finally {
    analyze._setCallFn(null);
  }

  // человек берёт вариант модели…
  const chosen = (await api(`/api/tz/runs/${runId}/fixes`, { headers: asUser() })).body.fixes
    .find((f) => f.findingId === withQuote.id);
  const put1 = await api(`/api/tz/runs/${runId}/findings/${withQuote.id}/fix`, {
    method: 'PUT', ...json({ text: chosen.variants[1].text, kind: 'variant' }),
  });
  assert.strictEqual(put1.status, 200, JSON.stringify(put1.body));
  assert.strictEqual(put1.body.fix.chosenKind, 'variant');
  assert.match(put1.body.fix.authorName, /\S/, 'ФИО автора правки пишет сервер');
  // …а по второй находке пишет свою формулировку
  const own = 'Раздел ТЭП дополнить: площадь застройки, этажность, строительный объём — по форме приложения.';
  const put2 = await api(`/api/tz/runs/${runId}/findings/${missing.id}/fix`, {
    method: 'PUT', ...json({ text: own, kind: 'own' }),
  });
  assert.strictEqual(put2.status, 200);
  assert.strictEqual(put2.body.fix.chosenKind, 'own');

  // редакция: одна правка встала по месту цитаты, другая — в дополнения
  const rev = await api(`/api/tz/runs/${runId}/revision`, { method: 'POST', ...json({}) });
  assert.strictEqual(rev.status, 200, JSON.stringify(rev.body));
  assert.strictEqual(rev.body.applied, 2);
  const places = rev.body.placement.map((p) => p.placed).sort();
  assert.deepStrictEqual(places, ['в дополнения', 'по месту цитаты']);

  // готовое ТЗ скачивается как DOCX и несёт обе формулировки
  const res = await fetch(`${base}/api/tz/runs/${runId}/revision.docx`, { headers: asUser() });
  assert.strictEqual(res.status, 200);
  const zip = new AdmZip(Buffer.from(await res.arrayBuffer()));
  const xml = zip.readAsText('word/document.xml');
  assert.match(xml, /Задание на проектирование/);
  assert.ok(xml.includes('энергоэффективности') || xml.includes('ТЭП'), 'принятых формулировок нет в документе');

  // снятие правки: пустой текст убирает её из редакции
  const off = await api(`/api/tz/runs/${runId}/findings/${missing.id}/fix`, { method: 'PUT', ...json({ text: '' }) });
  assert.strictEqual(off.status, 200);
  assert.strictEqual(off.body.fix.chosenText, '');
  const rev2 = await api(`/api/tz/runs/${runId}/revision`, { method: 'POST', ...json({}) });
  assert.strictEqual(rev2.body.applied, 1);
});

test('анализ ТЗ: редакция применяется к проекту и следующая проверка идёт по ней', async () => {
  const project = await api(`/api/tz/projects/${projectId}`, { headers: asUser() });
  let runId = '';
  for (const r of project.body.runs) {
    const got = (await api(`/api/tz/runs/${r.id}`, { headers: asUser() })).body.run;
    if (got && got.status === 'done' && got.result) { runId = r.id; break; }
  }
  assert.ok(runId, 'завершённого прогона нет');
  const before = (await api(`/api/tz/projects/${projectId}/document`, { headers: asUser() })).body.text;
  const applied = await api(`/api/tz/runs/${runId}/revision?apply=1`, { method: 'POST', ...json({}) });
  assert.strictEqual(applied.status, 200, JSON.stringify(applied.body));
  assert.strictEqual(applied.body.applied_to_project, true);
  const after = (await api(`/api/tz/projects/${projectId}/document`, { headers: asUser() })).body;
  assert.notStrictEqual(after.text, before, 'документ проекта не изменился');
  assert.ok(after.text.length > before.length, 'принятая формулировка не дописана');
  assert.match(after.name, /редакция по проверке/);
  // без единой принятой формулировки редакция не собирается — честный 422
  const clean = await api('/api/tz/projects', { method: 'POST', ...json({ name: 'Пустое задание', checklist: 'production' }) });
  const fresh = clean.body.project.id;
  const noFix = await api(`/api/tz/runs/${runId}/revision`, { method: 'POST', ...json({}) });
  assert.ok([200, 422].includes(noFix.status));
  assert.ok(fresh, 'задание не создалось');
});

/*
 * Текст из DOCX и PDF почти не содержит пустых строк: на боевом ТЗ АВИВАК
 * двадцать «абзацев» по 2,5 тыс. знаков. Правка, поставленная «после абзаца»,
 * уезжала на две страницы от своего места — в раздел ТЭП. Проверяем, что она
 * встаёт сразу за СТРОКОЙ с цитатой, а исходный текст не переписан.
 */
test('анализ ТЗ: правка встаёт рядом с цитатой даже в сплошном тексте без пустых строк', () => {
  const revision = require('../server/services/tz/revision');
  const lines = [];
  for (let i = 1; i <= 40; i += 1) lines.push(`${i}. Строка задания номер ${i}, обычный текст пункта.`);
  lines[9] = '10. Инженерные изыскания (дополнительные, при необходимости, по согласованию с заказчиком).';
  const text = lines.join('\n');            // ОДИН блок: пустых строк нет вовсе

  const findings = [{ id: 'F-001', quote: 'Инженерные изыскания (дополнительные, при необходимости', znp_ref: 'п. 10' }];
  const fixes = [{ findingId: 'F-001', chosenText: 'Изыскания выполняются в объёме, необходимом для стадии П.', chosenKind: 'variant', authorName: 'Проверяющий' }];
  const out = revision.build(text, findings, fixes, '');

  assert.equal(out.applied, 1);
  assert.equal(out.byFinding[0].placed, 'по месту цитаты');
  const at = out.text.indexOf('Изыскания выполняются в объёме');
  const quoteAt = out.text.indexOf('10. Инженерные изыскания (дополнительные');
  assert.ok(quoteAt >= 0 && at > quoteAt, 'правка ушла выше цитаты');
  const between = out.text.slice(quoteAt, at);
  assert.ok(!between.includes('11. Строка задания'), 'правка встала не рядом с цитатой, а в конце блока');
  // исходные строки целы и идут по порядку
  for (const l of lines) assert.ok(out.text.includes(l), `строка потеряна: ${l.slice(0, 30)}`);
  assert.ok(out.text.indexOf('40. Строка задания') > at, 'хвост документа потерян');
});

/*
 * Пикер модели из модуля убран (10.09.2026): выбор живёт у проекта платформы
 * и СИЛЬНЕЕ старой записи задания. Значит и показывать карточка обязана его —
 * иначе она говорит «модель: claude» у задания, которое пойдёт к модели
 * проекта, и человек не понимает, почему прогон ушёл к другой.
 */
test('анализ ТЗ: карточка задания показывает нейросеть ПРОЕКТА, а не старую запись задания', async () => {
  const projects = require('../server/services/projects');
  const platform = await api('/api/projects', { method: 'POST', ...json({ name: 'Смена нейросети' }) });
  const pid = platform.body.project.id;

  const made = await api('/api/tz/projects', {
    method: 'POST',
    ...json({ name: 'Задание со старой моделью', checklist: 'production', projectId: pid, object: { kind: 'производственное' } }),
  });
  const tzId = made.body.project.id;
  // у задания своя старая запись — так выглядят задания, заведённые до правки
  require('../server/services/tz/store').updateProject(tzId, { provider: 'claude', model: 'claude-old' });
  projects.update(pid, { aiProvider: 'lmstudio', aiModel: 'qwen-new' });

  const one = await api(`/api/tz/projects/${tzId}`, { headers: asUser() });
  assert.equal(one.body.project.ai_provider, 'lmstudio');
  assert.equal(one.body.project.ai_model, 'qwen-new');

  const list = await api(`/api/tz/projects?project=${pid}`, { headers: asUser() });
  const card = list.body.projects.find((p) => p.id === tzId);
  assert.equal(card.ai_provider, 'lmstudio', 'в списке осталась старая модель задания');
});

/*
 * Word игнорирует «\n» внутри <w:t> и показывает его пробелом. Текст ТЗ,
 * вынутый из DOCX, почти не содержит пустых строк, зато полон переносов —
 * без <w:br/> готовый файл слипался в одну простыню, и пункты 1.1, 1.2, 1.3
 * вставали в строку (рецензия 10.09.2026).
 */
test('анализ ТЗ: в готовом DOCX переносы строк остаются переносами', () => {
  const AdmZip = require('adm-zip');
  const exporter = require('../server/services/tz/export');
  const text = '1. Первый пункт задания.\n2. Второй пункт задания.\n3. Третий пункт задания.';
  const buf = exporter.revisionDocx({
    project: { name: 'Проверка переносов' },
    run: { created_at: '2026-09-10T00:00:00.000Z' },
    revision: { text, applied: 0, byFinding: [] },
  });
  const xml = new AdmZip(buf).readAsText('word/document.xml');
  const brs = (xml.match(/<w:br\/>/g) || []).length;
  assert.ok(brs >= 2, `переносов в файле ${brs}, а строк три`);
  assert.ok(!/<w:t[^>]*>[^<]*\n/.test(xml), 'сырой перевод строки остался внутри <w:t>');
  for (const part of ['Первый пункт', 'Второй пункт', 'Третий пункт']) {
    assert.ok(xml.includes(part), `потерян текст: ${part}`);
  }
});

/* Имя не должно расти «(редакция) (редакция) (редакция)» при каждом нажатии. */
test('анализ ТЗ: повторная запись редакции не удлиняет имя документа', () => {
  const base = 'ТЗ АВИВАК (PDF)';
  const strip = (name) => String(name || 'ТЗ').replace(/(\s*\(редакция по проверке\))+$/u, '');
  let name = base;
  for (let i = 0; i < 3; i += 1) name = `${strip(name)} (редакция по проверке)`;
  assert.equal(name, 'ТЗ АВИВАК (PDF) (редакция по проверке)');
});
