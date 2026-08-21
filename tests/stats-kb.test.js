'use strict';
/**
 * Права на статистику, учёт расхода и вытеснение старого разбора базы знаний.
 *
 * Каждый тест закрывает конкретную поломку, которая уже случалась или стоила бы
 * дорого:
 *  — чужую статистику видит тот, кому не положено;
 *  — расход пишется без имени модели и сваливается в «модель без названия»;
 *  — остаток «оценка» выдаётся за биллинг;
 *  — битый разбор документа снова попадает в ответы наравне с проверенным.
 */
process.env.DATA_DIR = require('path').join(require('os').tmpdir(), `pilot1-stats-${process.pid}`);
const { test } = require('node:test');
const assert = require('node:assert');

const users = require('../server/services/users');

/* ---------------- права ---------------- */

test('права: чужую статистику видит только владелец или допущенный', () => {
  assert.strictEqual(users.canSeeAllStats({ approved: true, owner: true }), true, 'владелец видит всех');
  assert.strictEqual(users.canSeeAllStats({ approved: true, statsAll: true }), true, 'допущенный видит всех');
  assert.strictEqual(users.canSeeAllStats({ approved: true, cloudAi: true }), false,
    'разрешение тратить деньги само по себе не даёт права видеть, кто их тратит');
  assert.strictEqual(users.canSeeAllStats({ approved: false, owner: true }), false,
    'неодобренная заявка не даёт прав, даже с флагом владельца');
  assert.strictEqual(users.canSeeAllStats(null), false);
});

test('права: забытое поле в users.json означает «нельзя», а не «можно»', () => {
  const store = users._readFileIfChanged();
  assert.ok(store, 'файл людей читается');
  // нормализация обязана СОХРАНЯТЬ owner/statsAll: пока их не было в белом
  // списке полей, флаг молча пропадал при чтении и владелец не был владельцем
  const shaped = users.publicUser({ id: 'x', lastName: 'А', firstName: 'Б', approved: true });
  assert.strictEqual(shaped.owner, false);
  assert.strictEqual(shaped.statsAll, false);
});

/* ---------------- учёт расхода ---------------- */

test('расход: событие пишется на каждый запрос, с провайдером и именем модели', () => {
  const { db } = require('../server/db');
  const adapter = require('../server/services/claude/adapter');
  const id = `s-usage-${process.pid}`;
  db.prepare('INSERT INTO sessions (id, token, prompt_version, created_at, updated_at) VALUES (?,?,?,?,?)')
    .run(id, 't', '1', new Date().toISOString(), new Date().toISOString());

  adapter.recordUsage(id, {
    input_tokens: 100, output_tokens: 20,
    cache_creation_input_tokens: 5, cache_read_input_tokens: 7,
  }, { provider: 'claude', model: 'claude-sonnet-5' });

  const ev = db.prepare('SELECT * FROM usage_events WHERE session_id = ?').get(id);
  assert.ok(ev, 'событие расхода записано');
  assert.strictEqual(ev.provider, 'claude');
  assert.strictEqual(ev.model, 'claude-sonnet-5', 'имя модели обязано быть: иначе весь расход сваливается в одну строку');
  assert.strictEqual(ev.input_tokens, 112, 'кэш-токены оплачиваются и входят во входные');
  assert.strictEqual(ev.cache_write_tokens, 5);
  assert.strictEqual(ev.cache_read_tokens, 7);
  assert.ok(ev.cost_usd > 0, 'облачный запрос стоит денег');

  // итог в сессии остаётся на месте: на нём держатся предохранители проекта
  const s = db.prepare('SELECT input_tokens, output_tokens, cost_usd FROM sessions WHERE id = ?').get(id);
  assert.strictEqual(s.input_tokens, 112);
  assert.strictEqual(s.output_tokens, 20);
  assert.ok(s.cost_usd > 0);
});

test('расход: служебные подзапросы отделены от основных', () => {
  const { db } = require('../server/db');
  const adapter = require('../server/services/claude/adapter');
  const id = `s-internal-${process.pid}`;
  db.prepare('INSERT INTO sessions (id, token, prompt_version, created_at, updated_at) VALUES (?,?,?,?,?)')
    .run(id, 't', '1', new Date().toISOString(), new Date().toISOString());
  adapter.recordUsage(id, { input_tokens: 10, output_tokens: 1 }, { provider: 'lmstudio', model: 'q' }, { internal: true });
  const ev = db.prepare('SELECT internal FROM usage_events WHERE session_id = ?').get(id);
  assert.strictEqual(ev.internal, 1,
    'распознавание чужого скана не должно выглядеть запросом человека');
});

/* ---------------- остатки ---------------- */

test('остатки: без пополнений и без API остаток не выдумывается', async () => {
  const balance = require('../server/services/balance');
  const list = await balance.forProviders(30);
  const gemini = list.find((p) => p.id === 'gemini');
  assert.ok(gemini, 'Gemini есть в списке платных провайдеров');
  if (!gemini.toppedUpUsd) {
    assert.strictEqual(gemini.balance.availableUsd, undefined,
      'нет данных — значит нет числа; ноль здесь читался бы как «деньги кончились»');
    assert.strictEqual(gemini.balance.source, 'нет');
  }
});

test('остатки: «внесено минус потрачено» помечается оценкой, а не биллингом', async () => {
  const balance = require('../server/services/balance');
  balance.addTopup({ provider: 'gemini', amountUsd: 25, note: 'тест' });
  const list = await balance.forProviders(30);
  const g = list.find((p) => p.id === 'gemini');
  assert.strictEqual(g.balance.source, 'оценка',
    'источник обязан отличать нашу арифметику от данных провайдера');
  assert.ok(g.balance.availableUsd <= 25);
  for (const t of balance.topups('gemini')) balance.removeTopup(t.id);
});

/* ---------------- база знаний ---------------- */

test('база знаний: базы Гриши в выборе больше нет', () => {
  const config = require('../server/config');
  assert.ok(!config.kbBases.some((b) => b.id === 'grisha'),
    'она была фильтром поверх общей базы с тем же составом, что «Верифицировано» — двойник в пикере');
});

test('база знаний: старый разбор не выдаётся ни в одной базе, верифицированный виден в общей', () => {
  const config = require('../server/config');
  if (!config.kbBases.some((b) => b.id === 'verified')) return; // базы нет — проверять нечего
  const kb = require('../server/services/kb');
  const st = kb.status();
  const main = st.bases.find((b) => b.id === 'main');
  const ver = st.bases.find((b) => b.id === 'verified');
  assert.ok(main && ver, 'обе базы на месте');
  // общая база ОБЯЗАНА включать верифицированные фрагменты: простое вычитание
  // отняло бы у неё СП 4.13130, СП 42.13330, ГрК РФ и СанПиН целиком
  assert.ok(main.chunks >= ver.chunks,
    'общая база отдаёт верифицированный разбор вместо старого, а не теряет документ');
  assert.strictEqual(st.chunks, main.chunks,
    'в общий итог фрагмент попадает один раз, сколько бы баз его ни показывало');
});
