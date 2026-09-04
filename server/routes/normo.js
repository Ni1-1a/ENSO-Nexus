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
const { rateLimit, userAuth, requestSizeLimit } = require('../middleware');
const db = require('../services/normo/db');
const store = require('../services/normo/store');
const platformProjects = require('../services/projects');
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

/*
 * Все идентификаторы модуля — BIGINT-ключи PostgreSQL. Нечисловое или
 * переполненное значение раньше уезжало в запрос как есть и оборачивалось
 * 500-кой («invalid input syntax for type bigint», «out of range»).
 * Допустимо целое 1…2^53 — дальше JavaScript теряет точность.
 */
const ID_MAX = 2 ** 53;
function validId(v) {
  const s = String(v == null ? '' : v).trim();
  if (!/^\d{1,16}$/.test(s)) return null;
  const n = Number(s);
  return n >= 1 && n <= ID_MAX ? s : null;
}
/** Какой объект стоит за параметром маршрута — для гейта принадлежности проекту. */
const PARAM_KIND = { id: 'project', sid: 'section', vid: 'version', rid: null, fid: 'finding', did: 'diff', iid: 'impact' };
for (const name of ['id', 'sid', 'vid', 'rid', 'fid', 'did', 'iid']) {
  router.param(name, (req, res, next, value) => {
    if (validId(value) === null) return res.status(400).json({ error: 'Некорректный идентификатор' });
    // «свои проекты» (решение владельца 02.09.2026): объект чужого проекта для
    // человека не существует — 404, а не 403, чтобы не подтверждать его наличие.
    // Комплекты без проекта платформы считаются «Ранними работами» (общие).
    const kind = PARAM_KIND[name];
    if (!kind) return next();
    store.platformProjectOf(kind, value).then((pid) => {
      if (pid === undefined) return next(); // объекта нет — маршрут сам ответит своим «не найдено»
      const project = platformProjects.byId(pid || platformProjects.LEGACY_ID);
      if (!project || !platformProjects.canSee(project, req.user)) return res.status(404).json({ error: 'Не найдено' });
      next();
    }).catch(next);
  });
}

/** Тот же гейт «свои проекты» для маршрутов, где :rid значит то прогон, то заключение. */
async function visible(req, kind, id) {
  const pid = await store.platformProjectOf(kind, id);
  if (pid === undefined) return false;
  const project = platformProjects.byId(pid || platformProjects.LEGACY_ID);
  return !!project && platformProjects.canSee(project, req.user);
}

const STAGES = ['П', 'Р', 'П+Р'];
const OBJECT_KINDS = ['производственный', 'непроизводственный', 'линейный'];
/** YYYY-MM-DD и настоящая дата: «2026-02-30» раньше падало в PostgreSQL DateTimeParseError. */
function isoDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

// файлы, которым в комплекте проектной документации делать нечего
const BLOCKED_EXT = new Set(['exe', 'dll', 'bat', 'sh', 'cmd', 'js', 'msi', 'dmg', 'pkg', 'app', 'scr', 'jar', 'com']);
/** Ошибка по составу файлов версии или null: исполняемые и подделки под PDF/DOCX. */
function uploadsError(uploads) {
  const { extOf, checkMagic } = require('../services/validation');
  for (const f of uploads) {
    const ext = extOf(f.originalname);
    if (BLOCKED_EXT.has(ext)) {
      return `Файл «${f.originalname}» не принимается: исполняемые файлы (.${ext}) в комплект не входят`;
    }
    if (ext === 'pdf' || ext === 'docx') {
      const magic = checkMagic(ext, f.buffer);
      if (!magic.ok) return `${f.originalname}: ${magic.reason}`;
    }
  }
  return null;
}

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
  if (!recovered) {
    recovered = true;
    await checks.recoverInterrupted();
    // проекты, заведённые до проектов платформы, видны через «Ранние работы»
    if (await store.hasLegacy()) platformProjects.ensureLegacy();
  }
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
  const { name, customer, stage, objectKind, dateStarted, localOnly, platformProjectId } = req.body || {};
  if (!name || !stage || !dateStarted) {
    return res.status(400).json({ error: 'Нужны name, stage (П/Р/П+Р) и dateStarted (дата начала разработки)' });
  }
  // Проверки на границе HTTP: раньше всё это ловили CHECK-ограничения и разбор
  // даты в PostgreSQL — и человек получал 500 без объяснения
  if (typeof name !== 'string' || !name.trim()) return res.status(400).json({ error: 'name должно быть непустой строкой' });
  if (customer != null && typeof customer !== 'string') return res.status(400).json({ error: 'customer должно быть строкой' });
  if (!STAGES.includes(stage)) return res.status(400).json({ error: `stage: допустимо ${STAGES.join(', ')}` });
  if (objectKind != null && objectKind !== '' && !OBJECT_KINDS.includes(objectKind)) {
    return res.status(400).json({ error: `objectKind: допустимо ${OBJECT_KINDS.join(', ')}` });
  }
  if (!isoDate(dateStarted)) return res.status(400).json({ error: 'dateStarted: дата в формате YYYY-MM-DD' });
  if (localOnly != null && typeof localOnly !== 'boolean') return res.status(400).json({ error: 'localOnly: true или false' });
  const project = await store.createProject({
    name: name.trim(), customer, stage, objectKind: objectKind || undefined, dateStarted, localOnly,
    owner: req.user ? req.user.id : null,
    // пусто — «Ранние работы», чужой или удалённый проект платформы — 404
    platformProjectId: platformProjects.resolveProjectId(platformProjectId, req.user).id,
  });
  platformProjects.touch(project.platform_project_id);
  res.status(201).json({ project: await store.getProject(project.id) });
}));

router.get('/projects', wrap(async (req, res) => {
  const all = await store.listProjects({ platformProjectId: platformProjects.filterId(req.query.project, req.user) });
  // и без фильтра — только комплекты из своих проектов платформы («Ранние работы» общие)
  const projects = all.filter((p) => {
    const project = platformProjects.byId(p.platform_project_id || platformProjects.LEGACY_ID);
    return !!project && platformProjects.canSee(project, req.user);
  });
  res.json({ projects });
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
  const bad = list.find((s) => !s || typeof s !== 'object'
    || typeof s.code !== 'string' || !s.code.trim() || typeof s.name !== 'string' || !s.name.trim());
  if (bad) return res.status(400).json({ error: 'У каждого раздела нужны code (шифр) и name — непустые строки' });
  // чужой проект — 404, раздел с загруженными версиями — 409: это store
  res.json({ sections: await store.setSections(req.params.id, list) });
}));

/* ---------------- версии разделов (сценарий 3) ---------------- */

router.post('/projects/:id/sections/:code/versions',
  rateLimit(config.rateLimitExpensive, 'normo-upload'), requestSizeLimit(config.uploadTotalBytes), upload.array('files', 40),
  wrap(async (req, res) => {
    if (!req.files || !req.files.length) {
      return res.status(400).json({ error: 'Нужен хотя бы один файл (multipart-поле files)' });
    }
    const stage = (req.body.stage || '').trim();
    if (!['П', 'Р'].includes(stage)) {
      return res.status(400).json({ error: 'Нужна стадия версии: П или Р (поле stage)' });
    }
    const uploads = decodeUploads(req.files);
    // исполняемые файлы и подделки под PDF/DOCX отвергаются ДО записи версии
    const rejected = uploadsError(uploads);
    if (rejected) return res.status(422).json({ error: rejected });
    const { version, files, section } = await store.addVersion(
      req.params.id, req.params.code, uploads,
      { stage, author: String(req.body.author || '').slice(0, 200), uploadedBy: req.user ? req.user.id : null, note: String(req.body.note || '').slice(0, 2000) },
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
  if (!(await visible(req, 'run', req.params.rid))) return res.status(404).json({ error: 'Прогон не найден' });
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
  rateLimit(config.rateLimitExpensive, 'normo-input'), requestSizeLimit(config.uploadTotalBytes), upload.array('files', 20),
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
  if (validId(from) === null || validId(to) === null) {
    return res.status(400).json({ error: 'Некорректный идентификатор версии (from/to)' });
  }
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
    [status, note ? String(note).slice(0, 2000) : null, req.user ? req.user.id : null, req.params.iid]);
  if (!r.rows.length) return res.status(404).json({ error: 'Impact-связь не найдена' });
  res.json({ link: r.rows[0] });
}));

/* ---------------- заключения (сценарий 6) ---------------- */

router.post('/versions/:vid/reports',
  rateLimit(config.rateLimitExpensive, 'normo-report'),
  wrap(async (req, res) => {
    const body = req.body || {};
    const reviewer = (String(body.reviewer || '').slice(0, 200) || (req.user && `${req.user.lastName || ''} ${req.user.firstName || ''}`.trim())) || 'нормоконтролёр';
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
  if (!(await visible(req, 'report', req.params.rid))) return res.status(404).json({ error: 'Заключение не найдено' });
  const r = await db.query('SELECT * FROM reports WHERE id = $1', [req.params.rid]);
  if (!r.rows.length) return res.status(404).json({ error: 'Заключение не найдено' });
  res.json({ report: r.rows[0] });
}));

router.get('/reports/:rid/file', wrap(async (req, res) => {
  if (!(await visible(req, 'report', req.params.rid))) return res.status(404).json({ error: 'Заключение не найдено' });
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
