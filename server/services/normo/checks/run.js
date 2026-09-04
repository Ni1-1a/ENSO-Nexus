'use strict';
/**
 * Оркестрация документного прогона нормоконтроля (сценарий 4).
 *
 * Идемпотентность: cache_key = sha256(content_hash версии + rulesHash каталога +
 * параметры прогона). Повторный запуск той же версии при том же каталоге отдаёт
 * готовый прогон, не выполняя проверки заново (force=true перезапускает явно).
 *
 * Тот же файл, загруженный НОВОЙ версией (тот же content_hash), проверки тоже
 * не выполняет — но получает СВОЙ прогон с cached=true: копия журнала и
 * замечаний готового прогона того же раздела и стадии переносится на новую
 * версию (04.09.2026). Раньше повторная загрузка отдавала прогон старой версии,
 * замечания оставались на ней, и новая версия выглядела «чистой»: сводка
 * говорила «открытых замечаний нет», заключение — «не проверялось».
 *
 * Выполнение асинхронное: HTTP-запрос получает runId сразу, детерминированные
 * проверки занимают миллисекунды, LLM-проверки — минуты на локальной модели;
 * клиент опрашивает GET /runs/:id. Для тестов есть { wait: true }.
 *
 * Журналирование: КАЖДОЕ правило выборки попадает в run_rules — outcome
 * ok / finding / skipped(+reason) / error. Молчаливых пропусков нет (ТЗ Этапа 3).
 *
 * Пересчёт статусов предыдущей версии (сценарий 7, автоматическая часть):
 * открытые замечания предыдущей версии сопоставляются с новыми по
 * (rule_id + файл из location): совпало — новое наследует predecessor_id,
 * не совпало (и правило реально выполнялось) — старое помечается fixed.
 */
const crypto = require('crypto');
const db = require('../db');
const rulesCatalog = require('../rules');
const store = require('../store');
const deterministic = require('./deterministic');

function cacheKey(contentHash, rulesHash, params) {
  return crypto.createHash('sha256')
    .update([contentHash, rulesHash, JSON.stringify(params)].join('|'))
    .digest('hex');
}

function locationFingerprint(location) {
  return (location && (location.file || location.place)) || '';
}

/** Прогоны, прерванные перезапуском сервера, честно помечаются ошибкой. */
async function recoverInterrupted() {
  const r = await db.query(
    `UPDATE analysis_runs SET status = 'failed', finished_at = now(),
       error = 'прогон прерван перезапуском сервера — запустите проверку повторно'
     WHERE status IN ('queued','running') AND started_at < now() - interval '30 minutes'
     RETURNING id`);
  if (r.rows.length) console.log(`[normo/run] восстановление: прервано прогонов — ${r.rows.length}`);
}

async function runDocumentCheck(versionId, { force = false, llm = true, wait = false, startedBy = null } = {}) {
  const version = await store.getVersion(versionId);
  if (!version) { const e = new Error('Версия не найдена'); e.status = 404; throw e; }
  const project = await store.getProject(version.project_id);
  const catalog = rulesCatalog.load();
  const rules = rulesCatalog.forSection(version.section_code, version.stage);

  const params = {
    engine: `deterministic-v${deterministic.VERSION}`,
    llm: llm ? `lmstudio-v${require('./llm').VERSION}` : 'off',
    local_only: project.local_only,
    started_by: startedBy,
  };
  const key = cacheKey(version.content_hash, catalog.rulesHash, {
    engine: params.engine, llm: params.llm, local_only: params.local_only,
  });
  // ключ прогона — свой у каждой версии: у двух версий с одним содержимым
  // по одному прогону у каждой (старые прогоны несут ключ без суффикса)
  const ownKey = `${key}:v${versionId}`;

  // свои прогоны версии — с ключом версии и его продолжениями (:force:, :retry:);
  // старые прогоны несут ключ без суффикса. Последний — первым.
  const existing = await db.query(
    `SELECT * FROM analysis_runs WHERE version_id = $1 AND (cache_key = $2 OR cache_key LIKE $3)
       AND status IN ('done','running','queued') ORDER BY id DESC`, [versionId, key, `${ownKey}%`]);
  if (existing.rows.length && !force) {
    return { run: existing.rows[0], cached: true };
  }
  if (existing.rows.length && force) {
    params.forced_at = new Date().toISOString();
  }
  // Упавший (или отменённый) прогон под тем же ключом повторному запуску не
  // мешает: раньше INSERT … ON CONFLICT DO NOTHING натыкался на него и отдавал
  // ЕГО как cached: true — «запустите проверку повторно» после перезапуска
  // сервера не работало никогда, ни с force, ни без (третий круг 04.09.2026)
  const dead = existing.rows.length ? { rows: [] } : await db.query(
    `SELECT 1 FROM analysis_runs WHERE cache_key = $1 AND status IN ('failed','cancelled')`, [ownKey]);
  const finalKey = existing.rows.length && force ? `${ownKey}:force:${Date.now()}`
    : dead.rows.length ? `${ownKey}:retry:${Date.now()}` : ownKey;

  if (!force) {
    // готовый прогон того же содержимого у другой версии этого раздела и стадии —
    // переносится копией, проверки заново не выполняются
    const donor = await db.query(
      `SELECT r.* FROM analysis_runs r JOIN section_versions v ON v.id = r.version_id
       WHERE (r.cache_key = $1 OR r.cache_key LIKE $2) AND r.status = 'done' AND r.version_id <> $3
         AND v.section_id = $4 AND v.stage = $5
       ORDER BY r.finished_at DESC LIMIT 1`,
      [key, `${key}:v%`, versionId, version.section_id, version.stage]);
    if (donor.rows.length) {
      const run = await cloneRun(donor.rows[0], version, { ...params, cached_from: donor.rows[0].id }, ownKey);
      return { run, cached: true };
    }
  }

  const inserted = await db.query(
    `INSERT INTO analysis_runs (project_id, version_id, scope, rules_hash, params, cache_key, status, started_at)
     VALUES ($1,$2,'document',$3,$4,$5,'running', now())
     ON CONFLICT (cache_key) DO NOTHING RETURNING *`,
    [version.project_id, versionId, catalog.rulesHash, JSON.stringify(params), finalKey]);
  if (!inserted.rows.length) {
    const race = await db.query('SELECT * FROM analysis_runs WHERE cache_key = $1', [finalKey]);
    return { run: race.rows[0], cached: true };
  }
  const run = inserted.rows[0];

  const work = processRun(run, { version, project, rules, llm })
    .catch(async (err) => {
      console.error(`[normo/run] прогон ${run.id}:`, err.message);
      await db.query(
        "UPDATE analysis_runs SET status = 'failed', finished_at = now(), error = $2 WHERE id = $1",
        [run.id, err.message.slice(0, 1000)]).catch(() => {});
    });
  if (wait) {
    await work;
    const fresh = await db.query('SELECT * FROM analysis_runs WHERE id = $1', [run.id]);
    return { run: fresh.rows[0], cached: false };
  }
  return { run, cached: false };
}

/**
 * Прогон-копия для новой версии с тем же содержимым: журнал и замечания
 * готового прогона переносятся на неё (status open — как у исходных при
 * создании), а связь с предыдущей версией считается тем же правилом, что и у
 * настоящего прогона: совпавшие замечания наследуют predecessor_id, несовпавшие
 * при выполненном правиле закрываются как fixed. Так замечания видны у ОБЕИХ
 * версий, а не только у первой.
 */
async function cloneRun(donor, version, params, cacheKeyValue) {
  const inserted = await db.query(
    `INSERT INTO analysis_runs (project_id, version_id, scope, rules_hash, params, cache_key, status, started_at, finished_at)
     VALUES ($1,$2,'document',$3,$4,$5,'done', now(), now())
     ON CONFLICT (cache_key) DO NOTHING RETURNING *`,
    [version.project_id, version.id, donor.rules_hash, JSON.stringify(params), cacheKeyValue]);
  if (!inserted.rows.length) {
    const race = await db.query('SELECT * FROM analysis_runs WHERE cache_key = $1', [cacheKeyValue]);
    return race.rows[0];
  }
  const run = inserted.rows[0];
  await db.query(
    `INSERT INTO run_rules (run_id, rule_id, outcome, skip_reason, duration_ms)
     SELECT $1, rule_id, outcome, skip_reason, 0 FROM run_rules WHERE run_id = $2
     ON CONFLICT DO NOTHING`, [run.id, donor.id]);

  const prev = await db.query(
    `SELECT f.* FROM findings f
     JOIN section_versions v ON v.id = f.version_id
     WHERE v.section_id = (SELECT section_id FROM section_versions WHERE id = $1)
       AND v.version_no = (SELECT version_no - 1 FROM section_versions WHERE id = $1)
       AND f.status = 'open'`, [version.id]);
  const prevByKey = new Map();
  for (const p of prev.rows) prevByKey.set(`${p.rule_id}|${locationFingerprint(p.location)}`, p);
  const matchedPrev = new Set();

  const source = await db.query('SELECT * FROM findings WHERE run_id = $1 ORDER BY id', [donor.id]);
  for (const f of source.rows) {
    const predecessor = prevByKey.get(`${f.rule_id}|${locationFingerprint(f.location)}`) || null;
    if (predecessor) matchedPrev.add(predecessor.id);
    await db.query(
      `INSERT INTO findings (run_id, version_id, rule_id, rule_hash, origin, severity, verification,
         location, doc_quote, ntd, ntd_clause, ntd_quote, wording, fix_hint, confidence, codes, predecessor_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
      [run.id, version.id, f.rule_id, f.rule_hash, f.origin, f.severity, f.verification,
        JSON.stringify(f.location), f.doc_quote, f.ntd, f.ntd_clause, f.ntd_quote,
        f.wording, f.fix_hint, f.confidence, JSON.stringify(f.codes || {}), predecessor ? predecessor.id : null]);
  }
  const executed = new Set((await db.query(
    "SELECT rule_id FROM run_rules WHERE run_id = $1 AND outcome IN ('ok','finding')", [donor.id])).rows.map((r) => r.rule_id));
  for (const p of prev.rows) {
    if (!matchedPrev.has(p.id) && executed.has(p.rule_id)) {
      await db.query("UPDATE findings SET status = 'fixed' WHERE id = $1", [p.id]);
    }
  }
  return run;
}

async function processRun(run, { version, project, rules, llm }) {
  const ctx = {
    version,
    section: { code: version.section_code, name: version.section_name },
    files: version.files,
    project,
  };
  const newFindings = [];
  const journal = new Map(); // rule_id → {outcome, skipReason, durationMs}

  // 1. Детерминированный слой
  for (const rule of rules) {
    const t0 = Date.now();
    let outcome = 'skipped';
    let skipReason = null;
    try {
      if (rule.auto === 'deterministic' && deterministic.has(rule.id)) {
        const found = await deterministic.run(rule.id, ctx);
        outcome = found.length ? 'finding' : 'ok';
        for (const f of found) {
          newFindings.push({ rule, origin: 'deterministic', verification: 'auto', ...f });
        }
      } else if (rule.auto === 'deterministic') {
        skipReason = 'реализация проверки ещё не подключена (очередь Этапа 3)';
      } else if (rule.auto === 'llm') {
        skipReason = llm ? null : 'LLM-проверки отключены в этом прогоне';
        if (skipReason) journal.set(rule.id, { outcome, skipReason, durationMs: 0 });
        continue; // llm-слой заполнит журнал сам
      } else {
        skipReason = 'ручная проверка — выполняется нормоконтролёром';
      }
    } catch (err) {
      outcome = 'error';
      skipReason = err.message.slice(0, 500);
    }
    journal.set(rule.id, { outcome, skipReason, durationMs: Date.now() - t0 });
  }

  // 2. LLM-слой (локальная модель, минуты — потому прогон и асинхронный)
  if (llm) {
    const llmRules = rules.filter((r) => r.auto === 'llm');
    const t0 = Date.now();
    const llmRunner = require('./llm');
    const { findings, journal: llmJournal } = await llmRunner.runLlmRules({
      project, version, files: version.files, rules: llmRules,
    });
    const per = llmRules.length ? Math.round((Date.now() - t0) / llmRules.length) : 0;
    for (const r of llmRules) {
      const j = llmJournal.get(r.id) || { outcome: 'skipped', skipReason: 'правило не дошло до модели' };
      journal.set(r.id, { ...j, durationMs: per });
    }
    newFindings.push(...findings);
  }

  // 3. Журнал в БД
  for (const [ruleId, j] of journal) {
    await db.query(
      `INSERT INTO run_rules (run_id, rule_id, outcome, skip_reason, duration_ms)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (run_id, rule_id) DO UPDATE
         SET outcome = EXCLUDED.outcome, skip_reason = EXCLUDED.skip_reason`,
      [run.id, ruleId, j.outcome, j.skipReason, j.durationMs || 0]);
  }

  // 4. Замечания + пересчёт статусов предыдущей версии
  const prev = await db.query(
    `SELECT f.* FROM findings f
     JOIN section_versions v ON v.id = f.version_id
     WHERE v.section_id = (SELECT section_id FROM section_versions WHERE id = $1)
       AND v.version_no = (SELECT version_no - 1 FROM section_versions WHERE id = $1)
       AND f.status = 'open'`, [version.id]);
  const prevByKey = new Map();
  for (const p of prev.rows) prevByKey.set(`${p.rule_id}|${locationFingerprint(p.location)}`, p);

  // Повторный прогон ТОЙ ЖЕ версии (force, повтор после сбоя) её прежние
  // замечания не дублирует: совпавшее по правилу и месту остаётся одной строкой —
  // со статусом и решением человека — и переходит к новому прогону; открытое,
  // которое новый прогон при выполненном правиле не нашёл, закрывается как fixed.
  // Раньше каждый force добавлял версии второй комплект открытых замечаний, и
  // сводка проекта считала их дважды (третий круг 04.09.2026).
  const same = await db.query(
    `SELECT * FROM findings WHERE version_id = $1 AND run_id <> $2 AND status <> 'fixed' ORDER BY id`,
    [version.id, run.id]);
  const sameByKey = new Map();
  for (const s of same.rows) sameByKey.set(`${s.rule_id}|${locationFingerprint(s.location)}`, s);
  const matchedSame = new Set();

  const matchedPrev = new Set();
  for (const nf of newFindings) {
    const fp = `${nf.rule.id}|${locationFingerprint(nf.location)}`;
    const predecessor = prevByKey.get(fp) || null;
    if (predecessor) matchedPrev.add(predecessor.id);
    const kept = sameByKey.get(fp);
    if (kept && !matchedSame.has(kept.id)) {
      matchedSame.add(kept.id);
      await db.query('UPDATE findings SET run_id = $1 WHERE id = $2', [run.id, kept.id]);
      continue;
    }
    const wording = nf.wordingOverride || (nf.detail ? `${nf.rule.wording} [${nf.detail}]` : nf.rule.wording);
    await db.query(
      `INSERT INTO findings (run_id, version_id, rule_id, rule_hash, origin, severity, verification,
         location, doc_quote, ntd, ntd_clause, ntd_quote, wording, fix_hint, confidence, codes, predecessor_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
      [run.id, version.id, nf.rule.id, nf.rule.hash, nf.origin, nf.rule.severity,
        nf.verification || 'auto',
        JSON.stringify(nf.location), nf.docQuote || null,
        nf.rule.source.ntd, String(nf.rule.source.clause), nf.ntdQuote || null,
        wording, nf.rule.fix_hint || null, nf.confidence ?? null,
        JSON.stringify(nf.rule.codes || {}), predecessor ? predecessor.id : null]);
  }

  const executed = new Set([...journal.entries()]
    .filter(([, j]) => j.outcome === 'ok' || j.outcome === 'finding')
    .map(([id]) => id));
  for (const p of prev.rows) {
    if (!matchedPrev.has(p.id) && executed.has(p.rule_id)) {
      await db.query("UPDATE findings SET status = 'fixed' WHERE id = $1", [p.id]);
    }
  }
  for (const s of same.rows) {
    if (!matchedSame.has(s.id) && s.status === 'open' && executed.has(s.rule_id)) {
      await db.query("UPDATE findings SET status = 'fixed' WHERE id = $1", [s.id]);
    }
  }

  await db.query(
    "UPDATE analysis_runs SET status = 'done', finished_at = now() WHERE id = $1", [run.id]);
}

async function getRun(runId) {
  const r = await db.query('SELECT * FROM analysis_runs WHERE id = $1', [runId]);
  if (!r.rows.length) return null;
  const journal = await db.query(
    'SELECT rule_id, outcome, skip_reason, duration_ms FROM run_rules WHERE run_id = $1 ORDER BY rule_id',
    [runId]);
  const findings = await db.query(
    'SELECT * FROM findings WHERE run_id = $1 ORDER BY severity, rule_id', [runId]);
  return { ...r.rows[0], journal: journal.rows, findings: findings.rows };
}

module.exports = { runDocumentCheck, getRun, recoverInterrupted };
