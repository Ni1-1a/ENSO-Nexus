'use strict';
/* Модуль «Нормоконтроль»: каталог правил, проекты, версии, детерминированный
 * прогон, идемпотентность по cache_key, пересчёт статусов при новой версии,
 * CHECK-ограничение на LLM-замечания без цитат.
 * Живой сервер на эфемерном порту — по образцу tests/dataset.test.js.
 * Нужен PostgreSQL модуля (порт 5433); если он недоступен, тесты пропускаются
 * с внятной причиной, а не падают. */
const os = require('os');
const path = require('path');
const fs = require('fs');
process.env.DATA_DIR = path.join(os.tmpdir(), `pilot1-normo-${process.pid}`);
process.env.NORMO_DATA_DIR = path.join(os.tmpdir(), `pilot1-normo-files-${process.pid}`);
process.env.NORMO_DATABASE_URL = process.env.NORMO_TEST_DATABASE_URL
  || 'postgresql://127.0.0.1:5433/enso_normo_test';
process.env.ANTHROPIC_API_KEY = '';
process.env.USERS_FILE = path.join(os.tmpdir(), `pilot1-normo-users-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
process.env.RATE_LIMIT_GENERAL = '1000';
process.env.RATE_LIMIT_EXPENSIVE = '1000';
process.env.NORMO_LLM = '0'; // тестам живая модель не нужна: детерминированный слой

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { Client } = require('pg');

let available = true;
let unavailableReason = '';
let server, base;

/** Тестовая база пересоздаётся начисто при каждом прогоне. */
async function recreateTestDb() {
  const admin = new Client({ connectionString: 'postgresql://127.0.0.1:5433/postgres', connectionTimeoutMillis: 3000 });
  await admin.connect();
  try {
    await admin.query('DROP DATABASE IF EXISTS enso_normo_test');
    await admin.query('CREATE DATABASE enso_normo_test');
  } finally {
    await admin.end();
  }
}

before(async () => {
  try {
    await recreateTestDb();
  } catch (err) {
    available = false;
    unavailableReason = `PostgreSQL модуля недоступен (${err.message}) — прогоните brew services start postgresql@17`;
    return;
  }
  const { createApp } = require('../server/app');
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) server.close();
  try { await require('../server/services/normo/db').close(); } catch { /* не поднялась */ }
  fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
  fs.rmSync(process.env.NORMO_DATA_DIR, { recursive: true, force: true });
  fs.rmSync(process.env.USERS_FILE, { force: true });
});

const api = async (p, opts = {}) => {
  const res = await fetch(base + p, opts);
  let body = null;
  try { body = await res.clone().json(); } catch { body = await res.text(); }
  return { status: res.status, body };
};

let userToken = '';
async function login() {
  const { body } = await api('/api/auth/enter', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lastName: 'Нормоконтролёров', firstName: 'Тест' }),
  });
  return body.token || '';
}
const asUser = () => ({ 'X-User-Token': userToken });
const json = (obj) => ({
  headers: { 'Content-Type': 'application/json', ...asUser() },
  body: JSON.stringify(obj),
});

/** Минимальный одностраничный PDF без текстового слоя (poppler чинит xref сам). */
const BLANK_PDF = Buffer.from(
  '%PDF-1.4\n'
  + '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n'
  + '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n'
  + '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj\n'
  + 'trailer<</Root 1 0 R/Size 4>>\n%%EOF\n', 'latin1');

const GUID = '12345678-1234-1234-1234-1234567890ab';
const BAD_LSR = '<?xml version="1.0" encoding="UTF-8"?><Смета><Позиция/></Смета>';
const GOOD_LSR = `<?xml version="1.0" encoding="UTF-8"?><LocalEstimate><Guid>${GUID}</Guid></LocalEstimate>`;

function form(files, extra = {}) {
  const fd = new FormData();
  for (const [name, content, type] of files) {
    fd.append('files', new File([content], name, { type }));
  }
  for (const [k, v] of Object.entries({ stage: 'П', ...extra })) fd.append(k, v);
  return fd;
}

let projectId = null;
let smSectionId = null;
let smV1 = null;

/** Прогон асинхронный: ждём done/failed опросом, как это делает клиент. */
async function waitRun(runId) {
  for (let i = 0; i < 200; i++) {
    const { body } = await api(`/api/normo/runs/${runId}`, { headers: asUser() });
    if (['done', 'failed'].includes(body.run.status)) return body.run;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`прогон ${runId} не завершился за отведённое время`);
}

test('health: БД, pgvector и каталог правил живые', async (t) => {
  if (!available) return t.skip(unavailableReason);
  userToken = await login();
  const { status, body } = await api('/api/normo/health', { headers: asUser() });
  assert.equal(status, 200);
  assert.ok(body.db.pgvector, 'pgvector не установлен в тестовой базе');
  assert.ok(body.rules.count >= 170, `в каталоге ожидалось ≥170 правил, есть ${body.rules.count}`);
});

test('проект создаётся с предзаполненным составом разделов', async (t) => {
  if (!available) return t.skip(unavailableReason);
  const { status, body } = await api('/api/normo/projects', {
    method: 'POST',
    ...json({ name: 'Тестовый цех', stage: 'П', dateStarted: '2026-08-01', objectKind: 'производственный' }),
  });
  assert.equal(status, 201);
  projectId = body.project.id;
  const codes = body.project.sections.map((s) => s.code);
  assert.ok(codes.includes('ПЗ') && codes.includes('АР') && codes.includes('СМ'),
    `в составе нет базовых шифров: ${codes.join(',')}`);
  smSectionId = body.project.sections.find((s) => s.code === 'СМ').id;
});

test('сценарии 3+4: загрузка версии СМ запускает прогон, SM-001 ловит не-XML смету', async (t) => {
  if (!available) return t.skip(unavailableReason);
  const up = await api(`/api/normo/projects/${projectId}/sections/СМ/versions`, {
    method: 'POST', headers: asUser(),
    body: form([['Раздел ПД 11 ЛСР-01.xml', BAD_LSR, 'application/xml']]),
  });
  assert.equal(up.status, 201, JSON.stringify(up.body));
  assert.equal(up.body.version.is_current, true);
  assert.ok(up.body.check.runId, 'прогон не запустился при загрузке');
  smV1 = up.body.version.id;

  const run = await waitRun(up.body.check.runId);
  assert.equal(run.status, 'done');
  // журнал: каждое правило выборки учтено, молчаливых пропусков нет
  assert.ok(run.journal.length >= 100, 'журнал правил подозрительно короткий');
  const sm1 = run.journal.find((r) => r.rule_id === 'SM-001');
  assert.equal(sm1.outcome, 'finding');
  const finding = run.findings.find((f) => f.rule_id === 'SM-001');
  assert.ok(finding, 'находки SM-001 нет');
  assert.equal(finding.severity, 'critical');
  assert.equal(finding.ntd, 'Приказ Минстроя России от 12.05.2017 № 783/пр');
  // пропущенные детерминированные правила стоят в журнале с причиной
  const skipped = run.journal.filter((r) => r.outcome === 'skipped' && r.skip_reason);
  assert.ok(skipped.length > 0, 'у пропущенных правил нет причин');
});

test('идемпотентность: повторный запуск той же версии отдаёт кэшированный прогон', async (t) => {
  if (!available) return t.skip(unavailableReason);
  const again = await api(`/api/normo/versions/${smV1}/check`, { method: 'POST', ...json({}) });
  assert.equal(again.status, 200);
  assert.equal(again.body.cached, true, 'повторный прогон не взялся из кэша');
});

test('сценарий 7 (авточасть): новая версия с исправленной сметой закрывает старое замечание', async (t) => {
  if (!available) return t.skip(unavailableReason);
  const up2 = await api(`/api/normo/projects/${projectId}/sections/СМ/versions`, {
    method: 'POST', headers: asUser(),
    body: form([['Раздел ПД 11 ЛСР-01.xml', GOOD_LSR, 'application/xml']]),
  });
  assert.equal(up2.status, 201, JSON.stringify(up2.body));
  assert.equal(up2.body.version.version_no, 2);
  await waitRun(up2.body.check.runId);

  // старая версия перестала быть актуальной
  const versions = await api(`/api/normo/sections/${smSectionId}/versions`, { headers: asUser() });
  const v1 = versions.body.versions.find((v) => v.version_no === 1);
  const v2 = versions.body.versions.find((v) => v.version_no === 2);
  assert.equal(v1.is_current, false);
  assert.equal(v2.is_current, true);

  // замечание SM-001 первой версии автоматически стало fixed
  const oldFindings = await api(`/api/normo/versions/${smV1}/findings`, { headers: asUser() });
  const oldSm = oldFindings.body.findings.find((f) => f.rule_id === 'SM-001');
  assert.equal(oldSm.status, 'fixed', 'статус замечания предыдущей версии не пересчитан');

  // в новой версии SM-001 прошло
  const run2 = await waitRun(up2.body.check.runId);
  assert.equal(run2.journal.find((r) => r.rule_id === 'SM-001').outcome, 'ok');
});

test('COM-EDOC-006: растровый PDF без текстового слоя — critical-замечание', async (t) => {
  if (!available) return t.skip(unavailableReason);
  const up = await api(`/api/normo/projects/${projectId}/sections/АР/versions`, {
    method: 'POST', headers: asUser(),
    body: form([['Раздел ПД 3-АР планы.pdf', BLANK_PDF, 'application/pdf']]),
  });
  assert.equal(up.status, 201, JSON.stringify(up.body));
  const run = await waitRun(up.body.check.runId);
  const f = run.findings.find((x) => x.rule_id === 'COM-EDOC-006');
  assert.ok(f, 'скан без текстового слоя не пойман');
  assert.equal(f.severity, 'critical');
  assert.equal(f.origin, 'deterministic');
});

test('схема БД: LLM-замечание без цитат не проходит иначе как needs_human', async (t) => {
  if (!available) return t.skip(unavailableReason);
  const db = require('../server/services/normo/db');
  const run = await db.query('SELECT id FROM analysis_runs LIMIT 1');
  const insert = (verification) => db.query(
    `INSERT INTO findings (run_id, version_id, rule_id, rule_hash, origin, severity, location,
       ntd, wording, verification)
     VALUES ($1,$2,'COM-TL-003','testhash','llm','major','{}','ГОСТ 21.002-2014','тест',$3)`,
    [run.rows[0].id, smV1, verification]);
  await assert.rejects(() => insert('auto'), /check|findings/i,
    'LLM-замечание без цитат прошло с verification=auto — CHECK не работает');
  await insert('needs_human'); // а с честным needs_human — проходит
});

test('сценарий 6: заключение рендерится в .docx и скачивается', async (t) => {
  if (!available) return t.skip(unavailableReason);
  const created = await api(`/api/normo/versions/${smV1}/reports`, {
    method: 'POST', ...json({ verdictCompliant: false, verdictApproved: false }),
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const rid = created.body.report.id;
  assert.equal(created.body.report.scope, 'document');

  const file = await fetch(`${base}/api/normo/reports/${rid}/file`, { headers: asUser() });
  assert.equal(file.status, 200);
  const buf = Buffer.from(await file.arrayBuffer());
  assert.equal(buf.slice(0, 2).toString(), 'PK', 'ответ не похож на docx (zip)');
  // внутри документа — раздел и формулировка замечания SM-001
  const AdmZip = require('adm-zip');
  const xml = new AdmZip(buf).getEntry('word/document.xml').getData().toString('utf8');
  assert.ok(xml.includes('СМ'), 'в заключении нет шифра раздела');
  assert.ok(!xml.includes('{{'), 'в заключении остались незаполненные плейсхолдеры');

  const asJson = await api(`/api/normo/reports/${rid}/file?format=json`, { headers: asUser() });
  assert.equal(asJson.status, 200);
  assert.ok(asJson.body.checks, 'json-выгрузка без блока checks');
});

test('сценарий 2: требования извлекаются, дословность сверяется кодом (модель подменена)', async (t) => {
  if (!available) return t.skip(unavailableReason);
  const ТЗ = 'Техническое задание.\n3.1 Предусмотреть локальные очистные сооружения производительностью не менее 5 куб.м в сутки.\n3.2 Высота цеха не менее 6 метров.';
  const up = await api(`/api/normo/projects/${projectId}/input-data`, {
    method: 'POST', headers: asUser(),
    body: (() => {
      const fd = new FormData();
      fd.append('files', new File([ТЗ], 'ТЗ.txt', { type: 'text/plain' }));
      fd.append('kind', 'ТЗ'); fd.append('title', 'ТЗ на проектирование');
      return fd;
    })(),
  });
  assert.equal(up.status, 201, JSON.stringify(up.body));
  assert.equal(up.body.extraction, 'off'); // NORMO_LLM=0 — маршрут честно говорит об этом

  // сервис извлечения — с подменённой моделью (как в тестах датасета)
  const adapter = require('../server/services/claude/adapter');
  const origCall = adapter.structuredCall;
  adapter.structuredCall = async () => ({
    text: JSON.stringify({
      requirements: [
        { text: 'Предусмотреть локальные очистные сооружения производительностью не менее 5 куб.м в сутки.', source_clause: '3.1', addressee_codes: ['ИОС'] },
        { text: 'Стены выкрасить в зелёный цвет', source_clause: '9.9', addressee_codes: ['АР'] }, // выдумка модели
      ],
    }),
  });
  try {
    const inputSvc = require('../server/services/normo/input-data');
    const r = await inputSvc.extractRequirements(up.body.input.id);
    assert.equal(r.extracted, 2);
    assert.equal(r.unverified, 1, 'выдуманное требование должно быть помечено как не сверенное');
  } finally {
    adapter.structuredCall = origCall;
  }
  const reqs = await api(`/api/normo/projects/${projectId}/requirements`, { headers: asUser() });
  assert.equal(reqs.body.requirements.length, 2);
  const fake = reqs.body.requirements.find((q) => q.source_clause === '9.9');
  assert.ok(fake.text.includes('[не сверено дословно'), 'пометка о недословности не выставлена');
});

test('сценарий 5: комплексная проверка — состав и непокрытые требования (модель подменена)', async (t) => {
  if (!available) return t.skip(unavailableReason);
  const adapter = require('../server/services/claude/adapter');
  const origCall = adapter.structuredCall;
  adapter.structuredCall = async () => ({ text: JSON.stringify({ coverage: [] }) });
  try {
    const complex = require('../server/services/normo/complex');
    const { run } = await complex.runComplexCheck(projectId, { llm: true, wait: true });
    assert.equal(run.status, 'done');
    const findings = await api(`/api/normo/projects/${projectId}/findings?scope=complex`, { headers: asUser() });
    const comp = findings.body.findings.find((f) => f.rule_id === 'CS-COMP-001');
    assert.ok(comp, 'нет находки о неполном составе (загружены только СМ и АР из 13 разделов)');
    assert.equal(comp.severity, 'critical');
    const uncovered = await api(`/api/normo/projects/${projectId}/uncovered`, { headers: asUser() });
    assert.equal(uncovered.body.requirements.length, 2, 'оба требования должны быть непокрыты (coverage пуст)');
  } finally {
    adapter.structuredCall = origCall;
  }
});

test('сценарий 7: дифф двух версий СМ и impact доступны по HTTP', async (t) => {
  if (!available) return t.skip(unavailableReason);
  const versions = await api(`/api/normo/sections/${smSectionId}/versions`, { headers: asUser() });
  const v1 = versions.body.versions.find((v) => v.version_no === 1);
  const v2 = versions.body.versions.find((v) => v.version_no === 2);
  const diff = await api(`/api/normo/sections/${smSectionId}/diff?from=${v1.id}&to=${v2.id}`, { headers: asUser() });
  assert.equal(diff.status, 200, JSON.stringify(diff.body));
  assert.ok(diff.body.diff.items.length >= 1, 'изменение XML не попало в дифф');
  const impact = await api(`/api/normo/diffs/${diff.body.diff.id}/impact`, { headers: asUser() });
  assert.equal(impact.status, 200);
  const findingLink = impact.body.links.find((l) => l.target_type === 'finding');
  assert.ok(findingLink, 'замечание старой версии не попало под перепроверку');
  assert.equal(findingLink.status, 'needs_recheck');
});

test('чужого не пускаем: без токена платформы модуль отвечает 401', async (t) => {
  if (!available) return t.skip(unavailableReason);
  const { status } = await api('/api/normo/projects');
  assert.equal(status, 401);
});
