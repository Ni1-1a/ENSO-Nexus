'use strict';
/* Дифф версий раздела и impact-анализ (сценарий 7): юниты diffTexts без БД +
 * интеграция через store и services/normo/diff. База — СВОЯ (enso_normo_test_diff),
 * чтобы не мешать параллельному tests/normo.test.js. PostgreSQL модуля
 * (127.0.0.1:5433) недоступен — интеграционные тесты пропускаются с причиной. */
const os = require('os');
const path = require('path');
const fs = require('fs');
// env — ДО require сервера/конфига (config.js читает process.env при загрузке)
process.env.DATA_DIR = path.join(os.tmpdir(), `pilot1-normo-diff-${process.pid}`);
process.env.NORMO_DATA_DIR = path.join(os.tmpdir(), `pilot1-normo-diff-files-${process.pid}`);
process.env.NORMO_DATABASE_URL = process.env.NORMO_DIFF_TEST_DATABASE_URL
  || 'postgresql://127.0.0.1:5433/enso_normo_test_diff';
process.env.ANTHROPIC_API_KEY = '';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { Client } = require('pg');

const db = require('../server/services/normo/db');
const store = require('../server/services/normo/store');
const { diffTexts, buildDiff, computeImpact, getDiff } = require('../server/services/normo/diff');

/* ---------------- diffTexts: юниты без БД ---------------- */

test('diffTexts: добавленный абзац с номером в новой версии', () => {
  assert.deepStrictEqual(
    diffTexts('Первый.\nВторой.', 'Первый.\nВторой.\nТретий.'),
    [{ kind: 'added', locus: { para: 3 }, summary: 'Третий.', newText: 'Третий.' }]);
});

test('diffTexts: удалённый абзац помнит номер в старой версии', () => {
  assert.deepStrictEqual(
    diffTexts('Первый.\nВторой.\nТретий.', 'Первый.\nТретий.'),
    [{ kind: 'removed', locus: { para: 2 }, summary: 'Второй.', oldText: 'Второй.' }]);
});

test('diffTexts: removed+added на одной позиции схлопываются в changed', () => {
  assert.deepStrictEqual(
    diffTexts('Первый.\nВторой.\nТретий.', 'Первый.\nДругой второй.\nТретий.'),
    [{
      kind: 'changed', locus: { para: 2 }, summary: 'Другой второй.',
      oldText: 'Второй.', newText: 'Другой второй.',
    }]);
});

test('diffTexts: неравные пачки — пары в changed, остаток остаётся removed', () => {
  assert.deepStrictEqual(
    diffTexts('А.\nБ.\nВ.\nГ.', 'А.\nХ.\nГ.'),
    [
      { kind: 'changed', locus: { para: 2 }, summary: 'Х.', oldText: 'Б.', newText: 'Х.' },
      { kind: 'removed', locus: { para: 3 }, summary: 'В.', oldText: 'В.' },
    ]);
});

test('diffTexts: пустые тексты', () => {
  assert.deepStrictEqual(diffTexts('', ''), []);
  assert.deepStrictEqual(diffTexts('', 'Абзац.'),
    [{ kind: 'added', locus: { para: 1 }, summary: 'Абзац.', newText: 'Абзац.' }]);
  assert.deepStrictEqual(diffTexts('Абзац.', ''),
    [{ kind: 'removed', locus: { para: 1 }, summary: 'Абзац.', oldText: 'Абзац.' }]);
});

test('diffTexts: трим и пустые строки-разделители не создают изменений', () => {
  assert.deepStrictEqual(diffTexts('  Первый.  \r\n\n\nВторой.', 'Первый.\nВторой.\n'), []);
});

test('diffTexts: summary обрезается до 160 символов, полный текст не теряется', () => {
  const long = 'Д'.repeat(500);
  const items = diffTexts('Старый.', long);
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, 'changed');
  assert.equal(items[0].summary.length, 160);
  assert.ok(items[0].summary.endsWith('…'), 'обрезка не помечена многоточием');
  assert.equal(items[0].newText, long);
});

/* ---------------- интеграция: своя база enso_normo_test_diff ---------------- */

let available = true;
let unavailableReason = '';

/** Тестовая база пересоздаётся начисто при каждом прогоне. */
async function recreateTestDb() {
  const admin = new Client({
    connectionString: 'postgresql://127.0.0.1:5433/postgres',
    connectionTimeoutMillis: 3000,
  });
  await admin.connect();
  try {
    await admin.query('DROP DATABASE IF EXISTS enso_normo_test_diff');
    await admin.query('CREATE DATABASE enso_normo_test_diff');
  } finally {
    await admin.end();
  }
}

before(async () => {
  try {
    await recreateTestDb();
    await db.migrate();
  } catch (err) {
    available = false;
    unavailableReason = `PostgreSQL модуля недоступен (${err.message}) — прогоните brew services start postgresql@17`;
  }
});

after(async () => {
  try { await db.close(); } catch { /* не поднялась */ }
  fs.rmSync(process.env.NORMO_DATA_DIR, { recursive: true, force: true });
  fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
});

const POYASN = 'Раздел ПД 3 АР пояснение.txt';
const VEDOM = 'Раздел ПД 3 АР ведомость.txt';
const UZLY = 'Раздел ПД 3 АР узлы.txt';

const upload = (name, content) => ({
  buffer: Buffer.from(content, 'utf8'), originalname: name, mimetype: 'text/plain',
});

async function insertRun(projectId, versionId) {
  const r = await db.query(
    `INSERT INTO analysis_runs (project_id, version_id, scope, rules_hash, params, cache_key, status)
     VALUES ($1,$2,'document','testhash','{}',$3,'done') RETURNING id`,
    [projectId, versionId, `test-${Math.random().toString(36).slice(2)}`]);
  return r.rows[0].id;
}

async function insertFinding(runId, versionId, { ruleId, status = 'open', location = {} }) {
  const r = await db.query(
    `INSERT INTO findings (run_id, version_id, rule_id, rule_hash, origin, severity, status, location, ntd, wording)
     VALUES ($1,$2,$3,'testhash','deterministic','major',$4,$5,'ГОСТ 21.1101-2013','тестовое замечание')
     RETURNING id`,
    [runId, versionId, ruleId, status, JSON.stringify(location)]);
  return r.rows[0].id;
}

let project, arSection, pzSection, v1, v2, pzVersion, diffRow;
let reqTouched, reqNoLoc;

test('buildDiff: изменения по файлам и абзацам двух версий АР', async (t) => {
  if (!available) return t.skip(unavailableReason);
  project = await store.createProject({ name: 'Диффовый цех', stage: 'П', dateStarted: '2026-08-01' });
  const full = await store.getProject(project.id);
  arSection = full.sections.find((s) => s.code === 'АР');
  pzSection = full.sections.find((s) => s.code === 'ПЗ');
  assert.ok(arSection && pzSection, 'в составе по умолчанию нет АР/ПЗ');

  v1 = (await store.addVersion(project.id, 'АР', [
    upload(POYASN, 'Общие данные.\nВысота этажа 3,3 м.\nКровля плоская.'),
    upload(VEDOM, 'Ведомость отделки.\nПомещение 101 — краска.'),
  ], { stage: 'П' })).version;
  v2 = (await store.addVersion(project.id, 'АР', [
    upload(POYASN, 'Общие данные.\nВысота этажа 3,6 м.\nКровля плоская.\nДобавлен раздел о витражах.'),
    upload(UZLY, 'Узлы примыкания кровли.'),
  ], { stage: 'П' })).version;

  diffRow = await buildDiff(v1.id, v2.id);
  assert.equal(String(diffRow.section_id), String(arSection.id));
  assert.equal(String(diffRow.from_version), String(v1.id));
  assert.equal(String(diffRow.to_version), String(v2.id));
  const items = diffRow.items;

  const changed = items.find((i) => i.kind === 'changed' && i.locus.file === POYASN);
  assert.ok(changed, `изменённый абзац пояснения не найден: ${JSON.stringify(items)}`);
  assert.equal(changed.locus.para, 2);
  assert.equal(changed.oldText, 'Высота этажа 3,3 м.');
  assert.equal(changed.newText, 'Высота этажа 3,6 м.');
  assert.equal(changed.summary, 'Высота этажа 3,6 м.');

  const addedPara = items.find((i) => i.kind === 'added' && i.locus.file === POYASN);
  assert.ok(addedPara, 'добавленный абзац не найден');
  assert.equal(addedPara.locus.para, 4);
  assert.equal(addedPara.newText, 'Добавлен раздел о витражах.');

  const removedFile = items.find((i) => i.kind === 'removed' && i.locus.file === VEDOM);
  assert.ok(removedFile, 'исключённый файл не отмечен removed');
  assert.equal(removedFile.locus.para, undefined, 'у файлового item не должно быть para');

  const addedFile = items.find((i) => i.kind === 'added' && i.locus.file === UZLY);
  assert.ok(addedFile, 'новый файл не отмечен added');
  assert.equal(addedFile.locus.para, undefined);
});

test('buildDiff повторно отдаёт ту же запись (UNIQUE по паре версий)', async (t) => {
  if (!available) return t.skip(unavailableReason);
  const again = await buildDiff(v1.id, v2.id);
  assert.equal(String(again.id), String(diffRow.id), 'повторный дифф завёл вторую запись');
  assert.deepStrictEqual(again.items, diffRow.items);
});

test('buildDiff: версии разных разделов — ошибка со status=400', async (t) => {
  if (!available) return t.skip(unavailableReason);
  pzVersion = (await store.addVersion(project.id, 'ПЗ', [
    upload('Раздел ПД 1 ПЗ.txt', 'Пояснительная записка.'),
  ], { stage: 'П' })).version;
  await assert.rejects(() => buildDiff(v1.id, pzVersion.id), (err) => {
    assert.equal(err.status, 400);
    assert.match(err.message, /раздел/i);
    return true;
  });
});

test('computeImpact: замечания, требования и смежные разделы', async (t) => {
  if (!available) return t.skip(unavailableReason);
  const runId = await insertRun(project.id, v1.id);
  // замечания старой версии: open и fixed по затронутому файлу — в перепроверку,
  // чужой файл и rejected — нет
  const fOpen = await insertFinding(runId, v1.id, { ruleId: 'AR-001', location: { file: POYASN } });
  const fFixed = await insertFinding(runId, v1.id, { ruleId: 'AR-002', status: 'fixed', location: { file: POYASN } });
  await insertFinding(runId, v1.id, { ruleId: 'AR-003', location: { file: 'непричастный.txt' } });
  await insertFinding(runId, v1.id, { ruleId: 'AR-004', status: 'rejected', location: { file: POYASN } });

  // требования: покрытие затронутым файлом, покрытие без location (консервативно),
  // покрытие незатронутым файлом — мимо
  const input = await db.query(
    `INSERT INTO input_data (project_id, kind, title) VALUES ($1,'ТЗ','Задание на проектирование') RETURNING id`,
    [project.id]);
  const inputId = input.rows[0].id;
  const addReq = async (seq) => (await db.query(
    `INSERT INTO requirements (input_id, seq, text, source_doc) VALUES ($1,$2,$3,'ТЗ') RETURNING id`,
    [inputId, seq, `Требование №${seq}`])).rows[0].id;
  const cover = (reqId, location) => db.query(
    `INSERT INTO requirement_coverage (requirement_id, version_id, status, evidence_quote, location, confirmed_by)
     VALUES ($1,$2,'covered','цитата',$3,'llm')`,
    [reqId, v1.id, location ? JSON.stringify(location) : null]);
  reqTouched = await addReq(1);
  await cover(reqTouched, { file: POYASN });
  reqNoLoc = await addReq(2);
  await cover(reqNoLoc, null);
  const reqOther = await addReq(3);
  await cover(reqOther, { file: 'непричастный.txt' });

  // смежные разделы: у ПЗ открытое межраздельное CS-замечание на актуальной
  // версии — not_propagated; CS-замечание самого АР и обычное замечание СМ — мимо
  await insertFinding(runId, pzVersion.id, { ruleId: 'CS-001' });
  await insertFinding(runId, v2.id, { ruleId: 'CS-002' });
  const sm = await store.addVersion(project.id, 'СМ', [
    upload('Раздел ПД 11 смета.txt', 'Смета.'),
  ], { stage: 'П' });
  await insertFinding(runId, sm.version.id, { ruleId: 'SM-001' });

  const impact = await computeImpact(diffRow.id);
  const byType = (type) => impact.links.filter((l) => l.target_type === type);

  const findingIds = byType('finding').map((l) => String(l.target_id)).sort();
  assert.deepStrictEqual(findingIds, [String(fOpen), String(fFixed)].sort(),
    'в перепроверку должны попасть ровно open и fixed по затронутому файлу');
  for (const l of byType('finding')) assert.equal(l.status, 'needs_recheck');

  const reqIds = byType('requirement').map((l) => String(l.target_id)).sort();
  assert.deepStrictEqual(reqIds, [String(reqTouched), String(reqNoLoc)].sort(),
    'затронуты покрытие по файлу и покрытие без location');
  for (const l of byType('requirement')) assert.equal(l.status, 'needs_recheck');

  const secLinks = byType('section');
  assert.equal(secLinks.length, 1, `section-ссылок ${secLinks.length}, ожидалась одна (ПЗ)`);
  assert.equal(String(secLinks[0].target_id), String(pzSection.id));
  assert.equal(secLinks[0].status, 'not_propagated');
  assert.match(secLinks[0].note, /не перепроверялась после изменения раздела АР/);

  assert.equal(impact.created, impact.links.length);
  assert.equal(impact.created, 5);
});

test('computeImpact идемпотентен: повтор не плодит ссылок', async (t) => {
  if (!available) return t.skip(unavailableReason);
  const again = await computeImpact(diffRow.id);
  assert.equal(again.created, 0, 'повторный impact создал дубли');
  assert.equal(again.links.length, 5);
});

test('getDiff: дифф вместе со ссылками; несуществующий — null', async (t) => {
  if (!available) return t.skip(unavailableReason);
  const full = await getDiff(diffRow.id);
  assert.equal(String(full.id), String(diffRow.id));
  assert.ok(Array.isArray(full.items) && full.items.length >= 4);
  assert.equal(full.links.length, 5);
  assert.equal(await getDiff(999999), null);
});
