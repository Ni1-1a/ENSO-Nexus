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

/**
 * NUL-байт в строке PostgreSQL не принимает («invalid byte sequence for
 * encoding UTF8: 0x00») — любое имя, примечание или фильтр с таким байтом раньше
 * оборачивались 500-кой (третий круг 04.09.2026). Байт вырезается из всех строк
 * тела (JSON — здесь, поля multipart — после multer), а фильтры запросов
 * сверяются со списками допустимых значений на своих маршрутах.
 */
function stripNul(value, depth = 0) {
  if (typeof value === 'string') return value.replace(/\u0000/g, '');
  if (!value || typeof value !== 'object' || depth > 10) return value;
  if (Array.isArray(value)) { for (let i = 0; i < value.length; i++) value[i] = stripNul(value[i], depth + 1); return value; }
  for (const k of Object.keys(value)) value[k] = stripNul(value[k], depth + 1);
  return value;
}
function cleanBody(req, res, next) {
  if (req.body && typeof req.body === 'object') stripNul(req.body);
  next();
}
router.use(cleanBody);

const FINDING_STATUSES = ['open', 'fixed', 'rejected', 'accepted_with_deviation'];
const SEVERITIES = ['critical', 'major', 'minor', 'remark'];
const RUN_SCOPES = ['document', 'complex', 'ingest_id', 'diff', 'impact'];
const REQUIREMENT_STATUSES = ['new', 'covered', 'partial', 'not_covered', 'conflict', 'dropped'];
/** Фильтр списка — одно из допустимых значений либо пусто; иначе текст ошибки. */
function badFilter(value, allowed, name) {
  if (value === undefined || value === '') return null;
  if (typeof value !== 'string' || !allowed.includes(value)) return `${name}: допустимо ${allowed.join(', ')}`;
  return null;
}

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
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
for (const name of ['id', 'sid', 'vid', 'rid', 'fid', 'did', 'iid']) {
  router.param(name, (req, res, next, value) => {
    if (validId(value) === null) return res.status(400).json({ error: 'Некорректный идентификатор' });
    // «свои проекты» (решение владельца 02.09.2026): объект чужого проекта для
    // человека не существует — 404, а не 403, чтобы не подтверждать его наличие.
    // Комплекты без проекта платформы считаются «Ранними работами» (общие).
    // Правка (PATCH/PUT/POST/DELETE) — владельцу проекта платформы или автору
    // комплекта (owner_user): в «Ранних работах» чужой комплект читается, но
    // не правится — 403 (закрыто 04.09.2026).
    const kind = PARAM_KIND[name];
    if (!kind) return next();
    store.accessOf(kind, value).then((access) => {
      if (access === undefined) return next(); // объекта нет — маршрут сам ответит своим «не найдено»
      const project = platformProjects.byIdAny(access.pid || platformProjects.LEGACY_ID)
        || (access.pid ? null : platformProjects.ensureLegacy());
      if (!project || !platformProjects.canSee(project, req.user)) return res.status(404).json({ error: 'Не найдено' });
      if (!READ_METHODS.has(req.method)) {
        // в мягко удалённом проекте платформы читают по прямой ссылке, но не правят:
        // всё в удалённом проекте — 404 (правило 02.09.2026, как у tz/doccheck)
        if (project.deleted_at) return res.status(404).json({ error: 'Проект не найден' });
        // мягко удалённый комплект (archived_at) — то же правило: читается по
        // ссылке, а новая версия, состав, прогон, заключение и правка замечания —
        // 404 (третий круг 04.09.2026: раньше в архивный комплект грузились версии,
        // и он жил дальше невидимкой — вне списка и сводки)
        if (access.archived) return res.status(404).json({ error: 'Комплект не найден' });
        const own = !!(access.owner && req.user && access.owner === req.user.id);
        if (!platformProjects.canEdit(project, req.user) && !own) {
          return res.status(403).json({ error: platformProjects.FOREIGN_EDIT });
        }
      }
      next();
    }).catch(next);
  });
}

/** Тот же гейт «свои проекты» для маршрутов, где :rid значит то прогон, то заключение. */
async function visible(req, kind, id) {
  const pid = await store.platformProjectOf(kind, id);
  if (pid === undefined) return false;
  const project = platformProjects.byIdAny(pid || platformProjects.LEGACY_ID);
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
    // пустой файл версией не становится: проверять в нём нечего (третий круг 04.09.2026)
    if (!f.buffer || !f.buffer.length) return `Файл «${f.originalname}» пуст`;
    if (ext === 'pdf' || ext === 'docx') {
      const magic = checkMagic(ext, f.buffer);
      if (!magic.ok) return `${f.originalname}: ${magic.reason}`;
    }
    // zip-бомба в docx отвергается ДО записи версии (422), а не глотается при
    // извлечении текста как «текста нет»
    if (ext === 'docx') {
      try { require('../services/zip-guard').checkArchive(f.buffer, `${f.originalname}`); } catch (err) {
        if (err.status === 422) return err.message;
        throw err;
      }
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
    // потолки как у остальных модулей (200): имя на 5000 символов уходило в базу целиком
    name: name.trim().slice(0, 200), customer: customer == null ? customer : customer.slice(0, 200),
    stage, objectKind: objectKind || undefined, dateStarted, localOnly,
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

// Удаление комплекта — мягкое (archived_at): из списков и сводки он уходит, версии и
// замечания остаются читаемыми по прямой ссылке. Права — гейт router.param (правка).
router.delete('/projects/:id', wrap(async (req, res) => {
  const ok = await store.archiveProject(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Комплект не найден' });
  res.json({ ok: true });
}));

router.put('/projects/:id/sections', wrap(async (req, res) => {
  const list = (req.body || {}).sections;
  if (!Array.isArray(list) || !list.length) {
    return res.status(400).json({ error: 'Нужен непустой массив sections [{code, name, …}]' });
  }
  const bad = list.find((s) => !s || typeof s !== 'object'
    || typeof s.code !== 'string' || !s.code.trim() || typeof s.name !== 'string' || !s.name.trim());
  if (bad) return res.status(400).json({ error: 'У каждого раздела нужны code (шифр) и name — непустые строки' });
  // шифр живёт в адресе (/sections/:code/versions) — резать его молча нельзя, только отказ
  const longCode = list.find((s) => s.code.trim().length > 64);
  if (longCode) return res.status(400).json({ error: `Шифр раздела длиннее 64 символов: «${longCode.code.trim().slice(0, 64)}…»` });
  // два одинаковых шифра в одном составе — ошибка формы, а не «побеждает последний»
  const codes = list.map((s) => s.code.trim());
  const dup = codes.find((c, i) => codes.indexOf(c) !== i);
  if (dup) return res.status(400).json({ error: `Шифр раздела повторяется: ${dup}` });
  const cleaned = list.map((s) => ({
    ...s, code: s.code.trim(), name: s.name.trim().slice(0, 300),
    required_basis: s.required_basis == null ? s.required_basis : String(s.required_basis).slice(0, 500),
  }));
  // чужой проект — 404, раздел с загруженными версиями — 409: это store
  res.json({ sections: await store.setSections(req.params.id, cleaned) });
}));

/* ---------------- версии разделов (сценарий 3) ---------------- */

router.post('/projects/:id/sections/:code/versions',
  rateLimit(config.rateLimitExpensive, 'normo-upload'), requestSizeLimit(config.uploadTotalBytes), upload.array('files', 40), cleanBody,
  wrap(async (req, res) => {
    if (!req.files || !req.files.length) {
      return res.status(400).json({ error: 'Нужен хотя бы один файл (multipart-поле files)' });
    }
    const stage = String(req.body.stage || '').trim();
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
  const bad = badFilter(req.query.status, FINDING_STATUSES, 'status') || badFilter(req.query.severity, SEVERITIES, 'severity');
  if (bad) return res.status(400).json({ error: bad });
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
  rateLimit(config.rateLimitExpensive, 'normo-input'), requestSizeLimit(config.uploadTotalBytes), upload.array('files', 20), cleanBody,
  wrap(async (req, res) => {
    if (!req.files || !req.files.length) {
      return res.status(400).json({ error: 'Нужен хотя бы один файл (multipart-поле files)' });
    }
    const kind = String(req.body.kind || '').trim();
    const allowed = ['ТЗ', 'ТУ', 'ГПЗУ', 'изыскания', 'задание_смежника', 'прочее'];
    if (!allowed.includes(kind)) {
      return res.status(400).json({ error: `Нужен kind из: ${allowed.join(', ')}` });
    }
    const uploads = decodeUploads(req.files);
    // те же правила, что у версий разделов: исполняемые, пустые и подделки — 422
    const rejected = uploadsError(uploads);
    if (rejected) return res.status(422).json({ error: rejected });
    const title = String(req.body.title || uploads[0].originalname).trim().slice(0, 300) || uploads[0].originalname;
    const inputSvc = require('../services/normo/input-data');
    const { input } = await inputSvc.addInputData(req.params.id, kind, title, uploads,
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
  const bad = badFilter(req.query.status, REQUIREMENT_STATUSES, 'status');
  if (bad) return res.status(400).json({ error: bad });
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
  const bad = badFilter(req.query.scope, RUN_SCOPES, 'scope');
  if (bad) return res.status(400).json({ error: bad });
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
    // подпись нормоконтролёра — только по вошедшему: значение из тела игнорируется
    // (правило датасета: ФИО пишет сервер, а не клиент)
    const reviewer = (req.user && `${req.user.lastName || ''} ${req.user.firstName || ''}`.trim()) || 'нормоконтролёр';
    // Итоговые вердикты модуль не выставляет сам (П41) — только из решения человека:
    // true, false или null/пусто; «да» и 1 раньше молча превращались в «не решено»
    for (const key of ['verdictCompliant', 'verdictApproved']) {
      if (body[key] !== undefined && body[key] !== null && typeof body[key] !== 'boolean') {
        return res.status(400).json({ error: `${key}: true, false или null` });
      }
    }
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
