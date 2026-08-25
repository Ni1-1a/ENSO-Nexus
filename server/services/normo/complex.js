'use strict';
/**
 * Комплексный (междисциплинарный) нормоконтроль — сценарий 5.
 *
 * Слои:
 *  1. Детерминированный: состав разделов (CS-COMP-001/002 — обязательные разделы
 *     без актуальной версии) — кодом по составу проекта.
 *  2. Покрытие требований ТЗ/ИД: локальная модель ищет след каждого требования
 *     в тексте каждого раздела, цитата-доказательство сверяется кодом; требования
 *     без покрытия — отдельный список (выход сценария 5 по ТЗ).
 *  3. Остальные cross_section-правила: LLM по паре «текст раздела × правило»
 *     пока не выполняется — журналируется с причиной (очередь Этапа 3).
 */
const crypto = require('crypto');
const config = require('../../config');
const adapter = require('../claude/adapter');
const prompts = require('../prompts');
const db = require('./db');
const store = require('./store');
const rulesCatalog = require('./rules');
const inputData = require('./input-data');
const verify = require('./checks/verify');
const { ensureServiceSession } = require('./checks/llm');

const COVERAGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['coverage'],
  properties: {
    coverage: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['req_id', 'status', 'evidence_quote'],
        properties: {
          req_id: { type: 'string' },
          status: { type: 'string', enum: ['covered', 'partial', 'contradicts', 'absent'] },
          evidence_quote: { type: 'string' },
        },
      },
    },
  },
};

async function currentVersions(projectId) {
  const r = await db.query(
    `SELECT v.*, s.code AS section_code, s.name AS section_name, s.required, s.id AS section_id
     FROM sections s LEFT JOIN section_versions v ON v.section_id = s.id AND v.is_current
     WHERE s.project_id = $1 ORDER BY s.sort_order`, [projectId]);
  return r.rows;
}

async function runComplexCheck(projectId, { llm = true, wait = false, startedBy = null } = {}) {
  const project = await store.getProject(projectId);
  if (!project) { const e = new Error('Проект не найден'); e.status = 404; throw e; }
  const catalog = rulesCatalog.load();
  const rows = await currentVersions(projectId);
  const reqs = await inputData.listRequirements(projectId);

  const stateHash = crypto.createHash('sha256').update(JSON.stringify({
    versions: rows.map((r) => [r.section_code, r.content_hash || null]),
    reqs: reqs.map((q) => q.id),
    rules: catalog.rulesHash,
    llm: !!llm,
  })).digest('hex');

  const existing = await db.query(
    "SELECT * FROM analysis_runs WHERE cache_key = $1 AND status IN ('done','running','queued')",
    [`complex:${stateHash}`]);
  if (existing.rows.length) return { run: existing.rows[0], cached: true };

  const inserted = await db.query(
    `INSERT INTO analysis_runs (project_id, scope, rules_hash, params, cache_key, status, started_at)
     VALUES ($1,'complex',$2,$3,$4,'running', now())
     ON CONFLICT (cache_key) DO NOTHING RETURNING *`,
    [projectId, catalog.rulesHash,
      JSON.stringify({ llm: llm ? 'lmstudio' : 'off', local_only: project.local_only, started_by: startedBy }),
      `complex:${stateHash}`]);
  if (!inserted.rows.length) {
    const race = await db.query('SELECT * FROM analysis_runs WHERE cache_key = $1', [`complex:${stateHash}`]);
    return { run: race.rows[0], cached: true };
  }
  const run = inserted.rows[0];
  const work = processComplex(run, { project, rows, reqs, llm })
    .catch(async (err) => {
      console.error(`[normo/complex] прогон ${run.id}:`, err.message);
      await db.query(
        "UPDATE analysis_runs SET status='failed', finished_at=now(), error=$2 WHERE id=$1",
        [run.id, err.message.slice(0, 1000)]).catch(() => {});
    });
  if (wait) {
    await work;
    const fresh = await db.query('SELECT * FROM analysis_runs WHERE id = $1', [run.id]);
    return { run: fresh.rows[0], cached: false };
  }
  return { run, cached: false };
}

async function processComplex(run, { project, rows, reqs, llm }) {
  const rules = rulesCatalog.forCrossSection(project.stage === 'Р' ? 'Р' : 'П');
  const journal = new Map();
  const addJournal = (id, outcome, skipReason = null) => journal.set(id, { outcome, skipReason });

  // 1. Состав разделов: обязательные без актуальной версии
  const compRuleId = project.object_kind === 'линейный' ? 'CS-COMP-002' : 'CS-COMP-001';
  const compRule = rulesCatalog.get(compRuleId);
  const missing = rows.filter((r) => r.required && !r.id);
  if (compRule) {
    if (missing.length) {
      addJournal(compRuleId, 'finding');
      await db.query(
        `INSERT INTO findings (run_id, version_id, rule_id, rule_hash, origin, severity, verification,
           location, ntd, ntd_clause, wording, fix_hint, codes)
         VALUES ($1,NULL,$2,$3,'deterministic',$4,'auto',$5,$6,$7,$8,$9,$10)`,
        [run.id, compRule.id, compRule.hash, compRule.severity,
          JSON.stringify({ file: '(комплект проекта)', place: 'состав разделов' }),
          compRule.source.ntd, String(compRule.source.clause),
          `${compRule.wording} [нет загруженных версий обязательных разделов: ${missing.map((m) => m.section_code).join(', ')}]`,
          compRule.fix_hint || null, JSON.stringify(compRule.codes || {})]);
    } else {
      addJournal(compRuleId, 'ok');
    }
  }

  // 2. Покрытие требований по разделам
  let uncovered = [];
  if (reqs.length && llm) {
    const sessionId = await ensureServiceSession(project);
    const versionsWithText = [];
    for (const r of rows.filter((x) => x.id)) {
      const files = (await db.query(
        `SELECT f.* FROM section_version_files vf JOIN files f ON f.id = vf.file_id WHERE vf.version_id = $1`,
        [r.id])).rows;
      let text = '';
      for (const f of files) text += `${(await store.extractText(f)).trim()}\n`;
      if (text.trim()) versionsWithText.push({ ...r, text: text.slice(0, 40000) });
    }
    const reqList = reqs.slice(0, 80); // потолок v1 — журналируется ниже
    for (const v of versionsWithText) {
      // разделу показываются только адресованные ему требования (+ безадресные)
      const relevant = reqList.filter((q) => !q.addressee_codes.length
        || q.addressee_codes.some((c) => v.section_code.startsWith(c) || c.startsWith(v.section_code)));
      if (!relevant.length) continue;
      const listBlock = relevant.map((q) => `[${q.id}] (${q.source_clause || 'пункт не указан'}) ${q.text}`).join('\n');
      try {
        const res = await adapter.structuredCall({
          system: prompts.load('normo-coverage', { section_code: v.section_code, section_name: v.section_name }),
          messages: [{
            role: 'user',
            content: `ТРЕБОВАНИЯ (${relevant.length}):\n${listBlock}\n\nТЕКСТ РАЗДЕЛА ${v.section_code}:\n\n${v.text}`,
          }],
          sessionId,
          route: { provider: 'lmstudio', model: config.localAiModel },
          schema: COVERAGE_SCHEMA,
          schemaName: 'normo_coverage',
          maxTokens: 5000,
        });
        const parsed = adapter.tryParse(res.text);
        for (const c of (parsed && parsed.coverage) || []) {
          const req = relevant.find((q) => String(q.id) === String(c.req_id).replace(/\D/g, ''));
          if (!req || c.status === 'absent') continue;
          // покрытие засчитывается только с дословной цитатой из текста раздела
          if (!verify.quoteInText(c.evidence_quote, v.text)) continue;
          await db.query(
            `INSERT INTO requirement_coverage (requirement_id, version_id, status, evidence_quote, confirmed_by, run_id)
             VALUES ($1,$2,$3,$4,'llm',$5)
             ON CONFLICT (requirement_id, version_id) DO UPDATE
               SET status = EXCLUDED.status, evidence_quote = EXCLUDED.evidence_quote, run_id = EXCLUDED.run_id`,
            [req.id, v.id, c.status, c.evidence_quote, run.id]);
        }
      } catch (err) {
        console.warn(`[normo/complex] покрытие ${v.section_code}: ${err.message}`);
      }
    }
    // пересчёт статусов требований
    for (const q of reqList) {
      const cov = await db.query(
        'SELECT status FROM requirement_coverage WHERE requirement_id = $1', [q.id]);
      let status = 'not_covered';
      if (cov.rows.some((c) => c.status === 'contradicts')) status = 'conflict';
      else if (cov.rows.some((c) => c.status === 'covered')) status = 'covered';
      else if (cov.rows.some((c) => c.status === 'partial')) status = 'partial';
      await db.query('UPDATE requirements SET status = $2 WHERE id = $1', [q.id, status]);
      if (status === 'not_covered') uncovered.push(q.id);
    }
  }

  // 3. Остальные cross_section-правила — честный журнал
  for (const rule of rules) {
    if (journal.has(rule.id)) continue;
    if (rule.auto === 'manual') addJournal(rule.id, 'skipped', 'ручная проверка — выполняется нормоконтролёром');
    else if (rule.auto === 'deterministic') addJournal(rule.id, 'skipped', 'реализация проверки ещё не подключена (очередь Этапа 3)');
    else addJournal(rule.id, 'skipped', llm ? 'межраздельные LLM-сверки в очереди Этапа 3' : 'LLM-проверки отключены');
  }
  for (const [ruleId, j] of journal) {
    await db.query(
      `INSERT INTO run_rules (run_id, rule_id, outcome, skip_reason) VALUES ($1,$2,$3,$4)
       ON CONFLICT (run_id, rule_id) DO UPDATE SET outcome = EXCLUDED.outcome`,
      [run.id, ruleId, j.outcome, j.skipReason]);
  }

  await db.query("UPDATE analysis_runs SET status='done', finished_at=now() WHERE id=$1", [run.id]);
}

async function uncoveredRequirements(projectId) {
  const r = await db.query(
    `SELECT q.* FROM requirements q JOIN input_data i ON i.id = q.input_id
     WHERE i.project_id = $1 AND i.is_current AND q.status IN ('not_covered','conflict')
     ORDER BY q.input_id, q.seq`, [projectId]);
  return r.rows;
}

module.exports = { runComplexCheck, uncoveredRequirements, currentVersions };
