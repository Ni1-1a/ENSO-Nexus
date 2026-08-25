'use strict';
/**
 * Сборка payload заключения из находок прогона (templates/conclusion-mapping.md).
 *
 * Логика галочек: «Да» — группа правил проверялась и открытых замечаний нет;
 * «Нет» — есть открытые; null (оба ☐ пустые) — группа в прогоне не проверялась,
 * что честно проговаривается в примечании. Итоговые вердикты МОДУЛЬ НЕ СТАВИТ
 * (П41: запрет автоматического вердикта) — их значения приходят от нормоконтролёра.
 */
const db = require('./db');

/** Показатель формы → какие правила его закрывают (по префиксам каталога). */
const GROUPS = {
  s1_sections: (id) => id.startsWith('COM-CMP-') || id.startsWith('CS-COMP-'),
  s1_title: (id) => ['COM-CMP-009', 'COM-CMP-010'].includes(id),
  s1_sheets_gost: (id) => id.startsWith('COM-TL-') || id.startsWith('COM-OF-')
    || id.startsWith('COM-ID-') || id.startsWith('COM-GEN-'),
  s1_ntd_actual: (id) => id.startsWith('COM-REF-') || id.startsWith('CS-NTD-'),
  s2_no_contradictions: (id) => id.startsWith('COM-TXT-1'), // смысловые текстовые
  s2_grammar: () => false,                                   // правил нет — не проверяется
  s2_terminology: (id) => id.startsWith('COM-TXT-'),
  s2_data_actual: (id) => id.startsWith('COM-REF-'),
  s3_scale: (id) => id.startsWith('COM-GR-'),
  s3_layers: () => false,
  s3_spec_full: (id) => id.startsWith('COM-SPEC-'),
  s3_explication: () => false,
  s3_isometry: () => false,
  s4_cross_sections: (id) => id.startsWith('CS-CONS-') || id.startsWith('CS-BIM-'),
  s4_duplicates: (id) => id.startsWith('CS-CONS-'),
};

function fmtDate(d) {
  const dt = d ? new Date(d) : new Date();
  return dt.toLocaleDateString('ru-RU');
}

/**
 * @param versionId версия раздела
 * @param opts { reviewer, verdictCompliant, verdictApproved } — от человека
 */
async function buildPayload(versionId, opts = {}) {
  const v = await db.query(
    `SELECT v.*, s.code AS section_code, s.name AS section_name, s.project_id
     FROM section_versions v JOIN sections s ON s.id = v.section_id WHERE v.id = $1`, [versionId]);
  if (!v.rows.length) { const e = new Error('Версия не найдена'); e.status = 404; throw e; }
  const version = v.rows[0];
  const p = await db.query('SELECT * FROM projects WHERE id = $1', [version.project_id]);
  const project = p.rows[0];

  const run = await db.query(
    `SELECT * FROM analysis_runs WHERE version_id = $1 AND status = 'done'
     ORDER BY finished_at DESC LIMIT 1`, [versionId]);
  const lastRun = run.rows[0] || null;
  const journal = lastRun
    ? (await db.query('SELECT rule_id, outcome FROM run_rules WHERE run_id = $1', [lastRun.id])).rows
    : [];
  const findings = (await db.query(
    `SELECT * FROM findings WHERE version_id = $1
     ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'major' THEN 1 WHEN 'minor' THEN 2 ELSE 3 END, rule_id`,
    [versionId])).rows;
  const open = findings.filter((f) => f.status === 'open' && f.verification !== 'human_rejected');

  const checks = {};
  for (const [key, match] of Object.entries(GROUPS)) {
    const executed = journal.filter((j) => match(j.rule_id) && ['ok', 'finding'].includes(j.outcome));
    const bad = open.filter((f) => match(f.rule_id) && f.severity !== 'remark');
    if (!executed.length) {
      checks[key] = { value: null, note: 'не проверялось в этом прогоне' };
    } else if (bad.length) {
      checks[key] = { value: false, note: `замечаний: ${bad.length}` };
    } else {
      checks[key] = { value: true, note: `правил проверено: ${executed.length}` };
    }
  }

  const findingLines = open.filter((f) => f.severity !== 'remark').map((f) => {
    const loc = f.location || {};
    const место = [loc.file, loc.hint || loc.place].filter(Boolean).join(', ');
    const верка = f.verification === 'needs_human' ? ' [требует проверки человеком]' : '';
    return `${f.wording} (${f.ntd}${f.ntd_clause ? `, п. ${f.ntd_clause}` : ''};${место ? ` ${место}` : ''})${верка}`;
  });
  const recommendationLines = open.filter((f) => f.severity === 'remark').map((f) =>
    `${f.wording} (${f.ntd}${f.ntd_clause ? `, п. ${f.ntd_clause}` : ''})`);

  return {
    project, version, lastRun,
    payload: {
      project_name: [project.name, project.customer].filter(Boolean).join(' — '),
      stage: version.stage,
      section: `${version.section_code} — ${version.section_name}`,
      contractor: 'ЭНСО-Инжиниринг',
      author: version.author || '',
      check_date: fmtDate(lastRun ? lastRun.finished_at : null),
      reviewer: opts.reviewer || '',
      checks,
      findings: findingLines,
      recommendations: recommendationLines,
      verdict_compliant: opts.verdictCompliant ?? null,
      verdict_approved: opts.verdictApproved ?? null,
      sign_date: fmtDate(null),
    },
  };
}

module.exports = { buildPayload, GROUPS };
