'use strict';
/**
 * REST модуля «Нормоконтроль». Монтируется в app.js под /api/normo.
 * Проект модуля: нормоконтроль/README.md (Этапы 1–2 согласованы 24.08.2026).
 *
 * Все маршруты — за userAuth (одобренный человек платформы). Данные — в
 * собственном PostgreSQL (services/normo/db.js), файлы — в NORMO_DATA_DIR.
 */
const express = require('express');
const multer = require('multer');
const config = require('../config');
const { rateLimit, userAuth } = require('../middleware');
const db = require('../services/normo/db');
const store = require('../services/normo/store');
const rules = require('../services/normo/rules');
const checks = require('../services/normo/checks/run');

const router = express.Router();
router.use(rateLimit(config.rateLimitGeneral, 'normo'));
router.use(userAuth);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 90 * 1024 * 1024, files: 40 }, // предел 783/пр — 80 МБ, даём запас: превышение ловит правило, а не транспорт
});

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// multer отдаёт originalname в latin1 — кириллица без перекодировки превращается
// в кракозябры (тот же приём, что в routes/api.js платформы)
function decodeUploads(files) {
  const { sanitizeFilename } = require('../services/validation');
  return (files || []).map((f) => ({
    ...f,
    originalname: sanitizeFilename(Buffer.from(String(f.originalname), 'latin1').toString('utf8')),
  }));
}

// Схема БД разворачивается лениво при первом запросе к модулю: старт приложения
// не должен падать из-за недоступного PostgreSQL, пока модулем никто не пользуется.
let recovered = false;
router.use(wrap(async (req, res, next) => {
  await db.migrate();
  if (!recovered) { recovered = true; await checks.recoverInterrupted(); }
  next();
}));

/* ---------------- служебное ---------------- */

router.get('/health', wrap(async (req, res) => {
  const dbInfo = await db.health();
  const catalog = rules.load();
  res.json({
    db: dbInfo,
    rules: { files: catalog.files, count: catalog.rules.length, hash: catalog.rulesHash },
  });
}));

router.get('/catalog/rules', wrap(async (req, res) => {
  const catalog = rules.load();
  let list = catalog.rules;
  if (req.query.applies_to) {
    list = list.filter((r) => r.applies_to.includes('все') || r.applies_to.includes(req.query.applies_to));
  }
  if (req.query.severity) list = list.filter((r) => r.severity === req.query.severity);
  res.json({ hash: catalog.rulesHash, count: list.length, rules: list });
}));

/* ---------------- проекты (сценарий 1) ---------------- */

router.post('/projects', wrap(async (req, res) => {
  const { name, customer, stage, objectKind, dateStarted, localOnly } = req.body || {};
  if (!name || !stage || !dateStarted) {
    return res.status(400).json({ error: 'Нужны name, stage (П/Р/П+Р) и dateStarted (дата начала разработки)' });
  }
  const project = await store.createProject({
    name, customer, stage, objectKind, dateStarted, localOnly,
    owner: req.user ? req.user.id : null,
  });
  res.status(201).json({ project: await store.getProject(project.id) });
}));

router.get('/projects', wrap(async (req, res) => {
  res.json({ projects: await store.listProjects() });
}));

router.get('/projects/:id', wrap(async (req, res) => {
  const project = await store.getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Проект не найден' });
  res.json({ project });
}));

router.put('/projects/:id/sections', wrap(async (req, res) => {
  const list = (req.body || {}).sections;
  if (!Array.isArray(list) || !list.length) {
    return res.status(400).json({ error: 'Нужен непустой массив sections [{code, name, …}]' });
  }
  res.json({ sections: await store.setSections(req.params.id, list) });
}));

/* ---------------- версии разделов (сценарий 3) ---------------- */

router.post('/projects/:id/sections/:code/versions',
  rateLimit(config.rateLimitExpensive, 'normo-upload'), upload.array('files', 40),
  wrap(async (req, res) => {
    if (!req.files || !req.files.length) {
      return res.status(400).json({ error: 'Нужен хотя бы один файл (multipart-поле files)' });
    }
    const stage = (req.body.stage || '').trim();
    if (!['П', 'Р'].includes(stage)) {
      return res.status(400).json({ error: 'Нужна стадия версии: П или Р (поле stage)' });
    }
    const { version, files, section } = await store.addVersion(
      req.params.id, req.params.code, decodeUploads(req.files),
      { stage, author: req.body.author, uploadedBy: req.user ? req.user.id : null, note: req.body.note },
    );
    // Загрузка запускает анализ сама (сценарий 3) — но ошибка анализа не отменяет
    // загрузку: версия уже создана, прогон можно повторить отдельным запросом.
    let check = null;
    try {
      check = await checks.runDocumentCheck(version.id, {
        llm: config.normoLlmEnabled,
        startedBy: req.user ? req.user.id : null,
      });
    } catch (err) {
      check = { error: err.message };
    }
    res.status(201).json({
      version, files: files.map((f) => ({ id: f.id, name: f.original_name, size: Number(f.size_bytes) })),
      section: { code: section.code, name: section.name },
      check: check && check.run
        ? { runId: check.run.id, status: check.run.status, cached: check.cached }
        : check,
    });
  }));

router.get('/sections/:sid/versions', wrap(async (req, res) => {
  res.json({ versions: await store.listVersions(req.params.sid) });
}));

router.get('/versions/:vid', wrap(async (req, res) => {
  const version = await store.getVersion(req.params.vid);
  if (!version) return res.status(404).json({ error: 'Версия не найдена' });
  res.json({ version });
}));

/* ---------------- проверки (сценарий 4) ---------------- */

router.post('/versions/:vid/check',
  rateLimit(config.rateLimitExpensive, 'normo-check'),
  wrap(async (req, res) => {
    const result = await checks.runDocumentCheck(req.params.vid, {
      force: !!(req.body || {}).force,
      llm: config.normoLlmEnabled,
      startedBy: req.user ? req.user.id : null,
    });
    res.json({ runId: result.run.id, status: result.run.status, cached: result.cached });
  }));

router.get('/runs/:rid', wrap(async (req, res) => {
  const run = await checks.getRun(req.params.rid);
  if (!run) return res.status(404).json({ error: 'Прогон не найден' });
  res.json({ run });
}));

router.get('/versions/:vid/findings', wrap(async (req, res) => {
  const clauses = ['version_id = $1'];
  const args = [req.params.vid];
  if (req.query.status) { args.push(req.query.status); clauses.push(`status = $${args.length}`); }
  if (req.query.severity) { args.push(req.query.severity); clauses.push(`severity = $${args.length}`); }
  const r = await db.query(
    `SELECT * FROM findings WHERE ${clauses.join(' AND ')}
     ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'major' THEN 1 WHEN 'minor' THEN 2 ELSE 3 END, rule_id`,
    args);
  res.json({ findings: r.rows });
}));

/* ---------------- исходные данные и требования (сценарий 2) ---------------- */

router.post('/projects/:id/input-data',
  rateLimit(config.rateLimitExpensive, 'normo-input'), upload.array('files', 20),
  wrap(async (req, res) => {
    if (!req.files || !req.files.length) {
      return res.status(400).json({ error: 'Нужен хотя бы один файл (multipart-поле files)' });
    }
    const kind = (req.body.kind || '').trim();
    const allowed = ['ТЗ', 'ТУ', 'ГПЗУ', 'изыскания', 'задание_смежника', 'прочее'];
    if (!allowed.includes(kind)) {
      return res.status(400).json({ error: `Нужен kind из: ${allowed.join(', ')}` });
    }
    const title = (req.body.title || req.files[0].originalname).trim();
    const inputSvc = require('../services/normo/input-data');
    const { input } = await inputSvc.addInputData(req.params.id, kind, title, decodeUploads(req.files),
      { uploadedBy: req.user ? req.user.id : null });
    // извлечение требований — асинхронно: локальная модель работает минуты
    let extraction = 'queued';
    if (config.normoLlmEnabled) {
      inputSvc.extractRequirements(input.id).then(
        (r) => console.log(`[normo/input] ИД ${input.id}: требований ${r.extracted} (не сверено: ${r.unverified})`),
        (err) => console.error(`[normo/input] ИД ${input.id}: ${err.message}`),
      );
    } else {
      extraction = 'off';
    }
    res.status(201).json({ input, extraction });
  }));

router.get('/projects/:id/input-data', wrap(async (req, res) => {
  res.json({ inputData: await require('../services/normo/input-data').listInputData(req.params.id) });
}));

router.get('/projects/:id/requirements', wrap(async (req, res) => {
  res.json({
    requirements: await require('../services/normo/input-data')
      .listRequirements(req.params.id, { status: req.query.status }),
  });
}));

router.get('/projects/:id/traceability', wrap(async (req, res) => {
  res.json({ traceability: await require('../services/normo/input-data').traceability(req.params.id) });
}));

router.get('/projects/:id/uncovered', wrap(async (req, res) => {
  res.json({ requirements: await require('../services/normo/complex').uncoveredRequirements(req.params.id) });
}));

/* ---------------- комплексная проверка (сценарий 5) ---------------- */

router.post('/projects/:id/check-complex',
  rateLimit(config.rateLimitExpensive, 'normo-complex'),
  wrap(async (req, res) => {
    const result = await require('../services/normo/complex').runComplexCheck(req.params.id, {
      llm: config.normoLlmEnabled,
      startedBy: req.user ? req.user.id : null,
    });
    res.json({ runId: result.run.id, status: result.run.status, cached: result.cached });
  }));

router.get('/projects/:id/findings', wrap(async (req, res) => {
  const args = [req.params.id];
  let scopeFilter = '';
  if (req.query.scope) { args.push(req.query.scope); scopeFilter = `AND r.scope = $${args.length}`; }
  const rows = await db.query(
    `SELECT f.*, r.scope FROM findings f JOIN analysis_runs r ON r.id = f.run_id
     WHERE r.project_id = $1 ${scopeFilter}
     ORDER BY CASE f.severity WHEN 'critical' THEN 0 WHEN 'major' THEN 1 WHEN 'minor' THEN 2 ELSE 3 END, f.rule_id`,
    args);
  res.json({ findings: rows.rows });
}));

/* ---------------- диффы и impact (сценарий 7) ---------------- */

router.get('/sections/:sid/diff', wrap(async (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'Нужны параметры from и to (id версий)' });
  const diffSvc = require('../services/normo/diff');
  const diff = await diffSvc.buildDiff(from, to);
  if (String(diff.section_id) !== String(req.params.sid)) {
    return res.status(400).json({ error: 'Версии не принадлежат этому разделу' });
  }
  res.json({ diff });
}));

router.get('/diffs/:did/impact', wrap(async (req, res) => {
  const diffSvc = require('../services/normo/diff');
  const impact = await diffSvc.computeImpact(req.params.did);
  res.json(impact);
}));

router.get('/diffs/:did', wrap(async (req, res) => {
  const diff = await require('../services/normo/diff').getDiff(req.params.did);
  if (!diff) return res.status(404).json({ error: 'Дифф не найден' });
  res.json({ diff });
}));

router.patch('/impact/:iid', wrap(async (req, res) => {
  const allowed = ['needs_recheck', 'not_propagated', 'propagated', 'dismissed'];
  const { status, note } = req.body || {};
  if (!allowed.includes(status)) {
    return res.status(400).json({ error: `Недопустимый status; допустимо: ${allowed.join(', ')}` });
  }
  const r = await db.query(
    `UPDATE impact_links SET status = $1, note = coalesce($2, note), updated_by = $3, updated_at = now()
     WHERE id = $4 RETURNING *`,
    [status, note || null, req.user ? req.user.id : null, req.params.iid]);
  if (!r.rows.length) return res.status(404).json({ error: 'Impact-связь не найдена' });
  res.json({ link: r.rows[0] });
}));

/* ---------------- заключения (сценарий 6) ---------------- */

router.post('/versions/:vid/reports',
  rateLimit(config.rateLimitExpensive, 'normo-report'),
  wrap(async (req, res) => {
    const body = req.body || {};
    const reviewer = (body.reviewer || (req.user && `${req.user.lastName || ''} ${req.user.firstName || ''}`.trim())) || 'нормоконтролёр';
    // Итоговые вердикты модуль не выставляет сам (П41) — только из решения человека
    const toBool = (x) => (x === true || x === false ? x : null);
    const { project, version, lastRun, payload } = await require('../services/normo/report-payload')
      .buildPayload(req.params.vid, {
        reviewer,
        verdictCompliant: toBool(body.verdictCompliant),
        verdictApproved: toBool(body.verdictApproved),
      });
    const docx = require('../services/normo/report').renderConclusion(payload);
    const fileRow = await require('../services/normo/store').saveFile(
      docx,
      `Заключение нормоконтроля ${version.section_code} v${version.version_no}.docx`,
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      req.user ? req.user.id : null,
    );
    const r = await db.query(
      `INSERT INTO reports (project_id, scope, version_id, run_id, reviewer, checked_at,
         verdict_compliant, verdict_approved, form_payload, docx_file)
       VALUES ($1,'document',$2,$3,$4, now()::date, $5,$6,$7,$8) RETURNING *`,
      [project.id, version.id, lastRun ? lastRun.id : null, reviewer,
        toBool(body.verdictCompliant), toBool(body.verdictApproved),
        JSON.stringify(payload), fileRow.id]);
    res.status(201).json({ report: r.rows[0] });
  }));

router.get('/reports/:rid', wrap(async (req, res) => {
  const r = await db.query('SELECT * FROM reports WHERE id = $1', [req.params.rid]);
  if (!r.rows.length) return res.status(404).json({ error: 'Заключение не найдено' });
  res.json({ report: r.rows[0] });
}));

router.get('/reports/:rid/file', wrap(async (req, res) => {
  const r = await db.query('SELECT * FROM reports WHERE id = $1', [req.params.rid]);
  if (!r.rows.length) return res.status(404).json({ error: 'Заключение не найдено' });
  const report = r.rows[0];
  if ((req.query.format || 'docx') === 'json') {
    res.setHeader('Content-Disposition', 'attachment; filename="conclusion.json"');
    return res.json(report.form_payload);
  }
  const f = await db.query('SELECT * FROM files WHERE id = $1', [report.docx_file]);
  if (!f.rows.length) return res.status(404).json({ error: 'Файл заключения не найден' });
  const store = require('../services/normo/store');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  res.setHeader('Content-Disposition',
    `attachment; filename*=UTF-8''${encodeURIComponent(f.rows[0].original_name)}`);
  res.sendFile(store.filePath(f.rows[0]));
}));

router.patch('/findings/:fid', wrap(async (req, res) => {
  const { status, verification } = req.body || {};
  const allowedStatus = ['open', 'fixed', 'rejected', 'accepted_with_deviation'];
  const allowedVerification = ['human_confirmed', 'human_rejected'];
  if (status && !allowedStatus.includes(status)) {
    return res.status(400).json({ error: `Недопустимый status; допустимо: ${allowedStatus.join(', ')}` });
  }
  if (verification && !allowedVerification.includes(verification)) {
    return res.status(400).json({ error: 'Человек может поставить только human_confirmed или human_rejected' });
  }
  if (!status && !verification) return res.status(400).json({ error: 'Нечего менять' });
  const sets = [];
  const args = [];
  if (status) { args.push(status); sets.push(`status = $${args.length}`); }
  if (verification) { args.push(verification); sets.push(`verification = $${args.length}`); }
  args.push(req.params.fid);
  const r = await db.query(
    `UPDATE findings SET ${sets.join(', ')} WHERE id = $${args.length} RETURNING *`, args);
  if (!r.rows.length) return res.status(404).json({ error: 'Замечание не найдено' });
  res.json({ finding: r.rows[0] });
}));

module.exports = { router };
