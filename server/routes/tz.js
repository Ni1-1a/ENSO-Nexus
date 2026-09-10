'use strict';
/**
 * REST модуля «Анализ ТЗ». Монтируется в app.js под /api/tz.
 *
 * Все маршруты — за userAuth (одобренный человек платформы); модуль открыт всем
 * вошедшим (решение владельца, 2026-08-27). Данные — в основной SQLite
 * (services/tz/store.js), обращения к моделям — через служебную сессию и
 * adapter.structuredCall, как в модуле «Датасет».
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const platformProjects = require('../services/projects');
const multer = require('multer');
const config = require('../config');
const { rateLimit, userAuth, requestSizeLimit } = require('../middleware');
const store = require('../services/tz/store');
const checklists = require('../services/tz/checklists');

const router = express.Router();
router.use(rateLimit(config.rateLimitGeneral, 'tz'));
router.use(userAuth);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 40 * 1024 * 1024, files: 1 },
});

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// текст ТЗ больше общего лимита JSON платформы (256 КБ) — свой разбор тела.
// Лимит считается от DOC_CHAR_LIMIT: кириллица в JSON занимает до 3 байт на знак
// (2 в UTF-8 + экранирование), и при «2mb» потолок в 1,5 млн знаков был
// недостижим — вставка обрывалась на миллионе безликим 413 (аудит 09.09.2026)
const bigJson = express.json({ limit: `${Math.max(2, Math.ceil((require('../config').docCharLimit * 3.5) / 1048576))}mb` });
// общий парсер приложения этот роутер обходит — JSON разбирается здесь, до 2 МБ
router.use(bigJson);

// multer отдаёт originalname в latin1 — кириллица без перекодировки превращается
// в кракозябры (тот же приём, что в routes/api.js платформы)
function decodeName(file) {
  const { sanitizeFilename } = require('../services/validation');
  return sanitizeFilename(Buffer.from(String(file.originalname), 'latin1').toString('utf8'));
}

/**
 * Гейт «свои проекты» для задания ТЗ (решение владельца 02.09.2026, закрыто
 * 04.09.2026): задание из чужого проекта для человека не существует — 404;
 * задание видимого проекта, но не своё и не владельца платформы, читать
 * можно, править нельзя — 403. Ответ в res уже записан, когда вернулось false.
 */
function allowed(project, req, res, { write = false } = {}) {
  const denied = platformProjects.entityDenial(project, req.user, { write, notFound: 'Проект не найден' });
  if (denied) { res.status(denied.status).json({ error: denied.error }); return false; }
  return true;
}

/** Задание по id для гейта — включая мягко удалённое: прогоны остаются читаемыми. */
function projectForRun(run, req, res, opts) {
  const project = store.projectRowAny(run.project_id);
  return allowed(project, req, res, opts);
}

/** Значение в тексте ошибки: null и пустая строка — «не указан», а не «null». */
const shown = (v) => (v === null || v === undefined || v === '' ? 'не указан' : String(v));

/**
 * Строковые поля тела — только строки (null и отсутствие допустимы): объект
 * и число раньше на POST записывались как «[object Object]» и «5», хотя PATCH
 * их отвергал. Когда вернулось true, ответ 400 уже записан в res.
 */
function badStrings(body, res, fields) {
  for (const f of fields) {
    if (body[f] !== undefined && body[f] !== null && typeof body[f] !== 'string') {
      res.status(400).json({ error: `Поле ${f} должно быть строкой` });
      return true;
    }
  }
  return false;
}

/** Описание объекта — плоский объект не больше 20 000 символов; массив и строка — не описание. */
function badObject(object, res) {
  if (object === undefined || object === null) return false;
  if (typeof object !== 'object' || Array.isArray(object)) {
    res.status(400).json({ error: 'Поле object должно быть объектом' });
    return true;
  }
  if (JSON.stringify(object).length > 20000) {
    res.status(400).json({ error: 'Описание объекта слишком большое (предел 20 000 символов)' });
    return true;
  }
  return false;
}

// прерванные перезапуском прогоны помечаются ошибкой при первом обращении к модулю
let recovered = false;
router.use((req, res, next) => {
  if (!recovered) { recovered = true; store.recoverInterrupted(); }
  next();
});

/* ---------------- справочное ---------------- */

router.get('/meta', (req, res) => {
  res.json({
    checklists: checklists.meta(),
    severities: checklists.SEVERITIES,
    itemStatuses: checklists.ITEM_STATUSES,
  });
});

/* ---------------- проекты ---------------- */

router.post('/projects', bigJson, wrap(async (req, res) => {
  const { name, checklist, provider, model, object, projectId } = req.body || {};
  if (badStrings(req.body || {}, res, ['name', 'provider', 'model', 'checklist'])) return;
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Нужно имя проекта (name)' });
  if (badObject(object, res)) return;
  const checklistId = checklist || 'production';
  if (!checklists.CHECKLISTS[checklistId]) {
    return res.status(400).json({ error: `Неизвестный чек-лист: ${shown(checklistId)}` });
  }
  if (provider) {
    const check = await require('../services/providers')
      .validateChoice(String(provider), model ? String(model) : '', req.user, req.hostname);
    if (!check.ok) return res.status(400).json({ error: check.error });
  }
  // нейросеть задания = нейросеть проекта платформы; тело её больше не задаёт
  const pid = platformProjects.resolveProjectId(projectId, req.user).id;
  const inherited = platformProjects.aiChoice(pid);
  const project = store.createProject({
    name: String(name).trim().slice(0, 200),
    checklist: checklistId,
    provider: provider ? String(provider) : inherited.provider,
    model: provider ? (model ? String(model) : '') : inherited.model,
    object: object && typeof object === 'object' ? object : {},
    user: req.user,
    // пусто — «Ранние работы», чужой или удалённый проект — 404 (общее правило модулей)
    projectId: pid,
  });
  platformProjects.touch(project.project_id);
  // как в GET: текст документа и сырой object_json в ответ не уходят (object — разобранный)
  res.status(201).json({ project: { ...project, document_text: undefined, object_json: undefined, document_chars: 0 } });
}));

router.get('/projects', wrap(async (req, res) => {
  const projectId = platformProjects.filterId(req.query.project, req.user);
  const rows = store.listProjects({ projectId });
  // без ?project= — только задания из видимых, не удалённых проектов платформы
  res.json({ projects: projectId ? rows : platformProjects.onlyVisible(rows, req.user) });
}));

router.get('/projects/:id', wrap(async (req, res) => {
  const project = store.projectById(req.params.id);
  if (!allowed(project, req, res)) return;
  res.json({
    project: { ...project, document_text: undefined, object_json: undefined, document_chars: project.document_text.length },
    runs: store.listRuns(project.id),
  });
}));

router.get('/projects/:id/document', wrap(async (req, res) => {
  const project = store.projectById(req.params.id);
  if (!allowed(project, req, res)) return;
  res.json({ name: project.document_name, note: project.document_note, text: project.document_text });
}));

router.patch('/projects/:id', bigJson, wrap(async (req, res) => {
  if (!allowed(store.projectById(req.params.id), req, res, { write: true })) return;
  const { name, checklist, provider, model, object } = req.body || {};
  // имя, модель, провайдер и чек-лист — строки: число и объект раньше записывались
  // как «5» и «[object Object]», а массив ['production'] проходил проверку
  // по ключу и падал 500-кой на записи в SQLite (третий круг 04.09.2026)
  if (badStrings(req.body || {}, res, ['name', 'provider', 'model', 'checklist'])) return;
  if (badObject(object, res)) return;
  // проверка ПОСЛЕ trim: null раньше становился именем «null», пробелы — пустым именем
  if (name !== undefined && !String(name ?? '').trim()) {
    return res.status(400).json({ error: 'Название не может быть пустым' });
  }
  if (checklist !== undefined && !checklists.CHECKLISTS[checklist]) {
    return res.status(400).json({ error: `Неизвестный чек-лист: ${shown(checklist)}` });
  }
  if (provider !== undefined && provider !== '') {
    const check = await require('../services/providers')
      .validateChoice(String(provider), model ? String(model) : '', req.user, req.hostname);
    if (!check.ok) return res.status(400).json({ error: check.error });
  }
  const project = store.updateProject(req.params.id, {
    name: name !== undefined ? String(name).trim().slice(0, 200) : undefined,
    checklist,
    provider: provider !== undefined ? String(provider) : undefined,
    model: model !== undefined ? String(model) : undefined,
    object: object && typeof object === 'object' ? object : undefined,
  });
  res.json({ project: { ...project, document_text: undefined, object_json: undefined } });
}));

router.delete('/projects/:id', wrap(async (req, res) => {
  if (!allowed(store.projectById(req.params.id), req, res, { write: true })) return;
  store.deleteProject(req.params.id);
  res.json({ ok: true });
}));

/* ---------------- документ ТЗ ---------------- */

/** Вставка текста ТЗ руками (основной путь, работает всегда). */
router.put('/projects/:id/document', bigJson, wrap(async (req, res) => {
  if (!allowed(store.projectById(req.params.id), req, res, { write: true })) return;
  const body = req.body || {};
  // текст и имя — строки: объект раньше сохранялся как «[object Object]»
  if (body.text !== undefined && body.text !== null && typeof body.text !== 'string') {
    return res.status(400).json({ error: 'Поле text должно быть строкой' });
  }
  if (body.name !== undefined && body.name !== null && typeof body.name !== 'string') {
    return res.status(400).json({ error: 'Поле name должно быть строкой' });
  }
  const text = String(body.text || '').trim();
  if (!text) return res.status(400).json({ error: 'Пустой текст ТЗ' });
  const tooBig = require('../services/validation').docSizeError(text);
  if (tooBig) return res.status(422).json({ error: tooBig });
  const project = store.setDocument(req.params.id, {
    text,
    name: String(body.name || 'вставленный текст').slice(0, 200),
    note: '',
  });
  res.json({ document: { name: project.document_name, chars: project.document_text.length } });
}));

/**
 * Загрузка файла ТЗ: DOCX, PDF с текстовым слоем, TXT/MD. Сканы без текстового
 * слоя в v1 не распознаются — честный отказ, не молчаливый пустой текст.
 */
router.post('/projects/:id/document/file',
  rateLimit(config.rateLimitExpensive, 'tz-upload'), requestSizeLimit(config.uploadTotalBytes), upload.single('file'),
  wrap(async (req, res) => {
    const project = store.projectById(req.params.id);
    if (!allowed(project, req, res, { write: true })) return;
    if (!req.file) return res.status(400).json({ error: 'Нужен файл (multipart-поле file)' });
    const name = decodeName(req.file);
    const ext = path.extname(name).toLowerCase().replace('.', '');
    if (!['docx', 'pdf', 'txt', 'md'].includes(ext)) {
      return res.status(422).json({ error: `Формат .${ext || '?'} не принимается: нужен DOCX, PDF с текстовым слоем, TXT или MD` });
    }
    // подделка под PDF/DOCX ловится по magic-байтам ДО разбора: иначе она
    // выглядела как «скан без текстового слоя» — и совет был не тот
    if (ext === 'pdf' || ext === 'docx') {
      const magic = require('../services/validation').checkMagic(ext, req.file.buffer);
      if (!magic.ok) return res.status(422).json({ error: magic.reason });
    }
    // файл сохраняется рядом с данными модуля — происхождение текста должно прослеживаться
    const dir = path.join(config.dataDir, 'tz', project.id);
    fs.mkdirSync(dir, { recursive: true });
    const storedPath = path.join(dir, `${crypto.randomUUID()}_${name}`);
    fs.writeFileSync(storedPath, req.file.buffer);

    const memory = require('../services/claude/memory');
    let text = '';
    let note = '';
    if (ext === 'docx') text = memory.extractDocxText(storedPath);
    else if (ext === 'pdf') text = await memory.extractPdfText(storedPath, 4_000_000, { mark: false });
    else text = memory.readTextFile(storedPath).text;
    text = String(text || '').trim();
    if (ext === 'pdf' && text && text.length < 200) {
      note = 'текстовый слой PDF почти пуст — вероятно, это скан; проверьте текст глазами';
    }
    if (!text) {
      return res.status(422).json({
        error: ext === 'pdf'
          ? 'В PDF нет текстового слоя (скан). В этой версии распознавание сканов не выполняется — вставьте текст ТЗ вручную.'
          : 'Не удалось извлечь текст из файла',
      });
    }
    const tooBig = require('../services/validation').docSizeError(text);
    if (tooBig) return res.status(422).json({ error: tooBig });
    const updated = store.setDocument(project.id, { text, name, note });
    res.status(201).json({
      document: { name: updated.document_name, chars: updated.document_text.length, note },
    });
  }));

/* ---------------- прогоны анализа ---------------- */

router.post('/projects/:id/analyze',
  rateLimit(config.rateLimitExpensive, 'tz-analyze'), bigJson,
  wrap(async (req, res) => {
    const project = store.projectById(req.params.id);
    if (!allowed(project, req, res, { write: true })) return;
    if (!project.document_text.trim()) {
      return res.status(422).json({ error: 'В проекте нет текста ТЗ — загрузите документ или вставьте текст' });
    }
    /*
     * Нейросеть берётся у ПРОЕКТА ПЛАТФОРМЫ — один выбор на все модули
     * (решение владельца 10.09.2026, пикер из модуля убран). Выбор проекта
     * СИЛЬНЕЕ старого выбора задания: иначе задание, заведённое до правки,
     * навсегда оставалось бы на прежней модели, а сменить её из интерфейса
     * уже негде — ровно это и упиралось в «Claude не настроен» на прогоне.
     * Свой выбор задания остаётся запасным: у проекта нейросети может не быть.
     */
    const projectAi = platformProjects.aiChoice(project.project_id);
    if (projectAi.provider && projectAi.provider !== project.ai_provider) {
      store.updateProject(project.id, { provider: projectAi.provider, model: projectAi.model });
      project.ai_provider = projectAi.provider;
      project.ai_model = projectAi.model;
    }
    if (!project.ai_provider) {
      return res.status(422).json({
        error: 'У проекта не выбрана нейросеть. Откройте «Свойства проекта» на главной и выберите её — она общая для всех модулей.',
      });
    }
    // Доступность провайдера здесь заново не проверяется: выбор валидировался при
    // сохранении, а настоящий запрет стоит на дне адаптера (правило платформы) —
    // недоступное облако честно уронит прогон с внятной причиной.
    const running = store.listRuns(project.id).find((r) => ['queued', 'running'].includes(r.status));
    if (running) return res.status(409).json({ error: 'Прогон уже идёт', runId: running.id });

    const run = store.createRun(project, req.user);
    const host = String(req.hostname || '').toLowerCase();
    setImmediate(async () => {
      try {
        store.setRunStatus(run.id, 'running', { progress: 'подготовка…' });
        await require('../services/tz/analyze').runAnalysis(run.id, { host });
      } catch (err) {
        console.error(`[tz] прогон ${run.id}: ${err.message}`);
        store.setRunStatus(run.id, 'failed', { error: err.message });
      }
    });
    res.status(202).json({ runId: run.id, status: 'queued' });
  }));

router.get('/runs/:rid', wrap(async (req, res) => {
  const run = store.runById(req.params.rid);
  if (!run) return res.status(404).json({ error: 'Прогон не найден' });
  if (!projectForRun(run, req, res)) return;
  res.json({ run });
}));

/* ---------------- решения по находкам ---------------- */

router.post('/runs/:rid/findings/:fid/decision', bigJson, wrap(async (req, res) => {
  const run = store.runById(req.params.rid);
  if (!run) return res.status(404).json({ error: 'Прогон не найден' });
  if (!projectForRun(run, req, res, { write: true })) return;
  const decision = (req.body || {}).decision ?? null;
  const saved = store.setDecision(req.params.rid, req.params.fid, decision, req.user);
  res.json({ findingId: req.params.fid, decision: saved });
}));

/* ---------------- экспорт ---------------- */

function loadDoneRun(rid, req, res) {
  const run = store.runById(rid);
  if (!run) { res.status(404).json({ error: 'Прогон не найден' }); return null; }
  if (!projectForRun(run, req, res)) return null;
  if (run.status !== 'done' || !run.result) {
    res.status(409).json({ error: 'Прогон ещё не завершён — экспортировать нечего' });
    return null;
  }
  return run;
}

/* ---------------- предложения по заполнению и правки (10.09.2026) ---------------- */

/**
 * Модель предлагает формулировки по ОДНОМУ замечанию. Ответ — варианты; выбор
 * человека сохраняется отдельным маршрутом, свой текст он может написать сам.
 */
router.post('/runs/:rid/findings/:fid/suggest',
  rateLimit(config.rateLimitExpensive, 'tz-suggest'),
  wrap(async (req, res) => {
    const run = store.runById(req.params.rid);
    if (!run) return res.status(404).json({ error: 'Прогон не найден' });
    if (!projectForRun(run, req, res, { write: true })) return;
    try {
      const fix = await require('../services/tz/analyze')
        .suggestFix(run.id, req.params.fid, { host: String(req.hostname || '').toLowerCase() });
      res.json({ fix });
    } catch (err) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      // недоступная модель — состояние сервиса, а не наша ошибка
      return res.status(503).json({ error: err.message });
    }
  }));

/** Выбранная (или написанная) формулировка. Пустой текст снимает правку. */
router.put('/runs/:rid/findings/:fid/fix', wrap(async (req, res) => {
  const run = store.runById(req.params.rid);
  if (!run) return res.status(404).json({ error: 'Прогон не найден' });
  if (!projectForRun(run, req, res, { write: true })) return;
  const body = req.body || {};
  if (badStrings(body, res, ['text', 'kind'])) return;
  if (!store.findingOf(run, req.params.fid)) {
    return res.status(404).json({ error: 'Замечание не найдено в этом прогоне' });
  }
  const fix = store.saveFix(run.id, req.params.fid, { text: body.text, kind: body.kind, user: req.user });
  res.json({ fix });
}));

/** Все правки прогона — клиенту одним запросом вместе с отчётом. */
router.get('/runs/:rid/fixes', wrap(async (req, res) => {
  const run = store.runById(req.params.rid);
  if (!run) return res.status(404).json({ error: 'Прогон не найден' });
  if (!projectForRun(run, req, res)) return;
  res.json({ fixes: store.listFixes(run.id) });
}));

/**
 * Исправленная редакция ТЗ: исходный текст + принятые формулировки.
 * ?apply=1 — записать её документом проекта (следующая проверка пойдёт по ней).
 */
router.post('/runs/:rid/revision', wrap(async (req, res) => {
  const run = store.runById(req.params.rid, { withText: true });
  if (!run) return res.status(404).json({ error: 'Прогон не найден' });
  const project = store.projectById(run.project_id);
  if (!allowed(project, req, res, { write: true })) return;
  const fixes = store.listFixes(run.id);
  const revision = require('../services/tz/revision')
    .build(run.document_text, (run.result && run.result.findings) || [], fixes, run.checklist || project.checklist);
  if (!revision.applied) {
    return res.status(422).json({ error: 'Нет ни одной принятой формулировки — выберите или напишите хотя бы одну' });
  }
  const apply = String(req.query.apply || '') === '1';
  if (apply) {
    store.setDocument(project.id, {
      text: revision.text,
      name: `${project.document_name || 'ТЗ'} (редакция по проверке)`,
      note: `собрано платформой ${new Date().toLocaleDateString('ru-RU')}: принято формулировок ${revision.applied}`,
    });
  }
  res.json({ applied: revision.applied, chars: revision.text.length, placement: revision.byFinding, applied_to_project: apply });
}));

/** Готовое ТЗ с принятыми правками — DOCX. */
router.get('/runs/:rid/revision.docx', wrap(async (req, res) => {
  const run = store.runById(req.params.rid, { withText: true });
  if (!run) return res.status(404).json({ error: 'Прогон не найден' });
  const project = store.projectById(run.project_id);
  if (!allowed(project, req, res)) return;
  const fixes = store.listFixes(run.id);
  const revision = require('../services/tz/revision')
    .build(run.document_text, (run.result && run.result.findings) || [], fixes, run.checklist || project.checklist);
  const buf = require('../services/tz/export').revisionDocx({ project, run, revision });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`ТЗ ${project.name} (редакция).docx`)}`);
  res.send(buf);
}));

router.get('/runs/:rid/export.xlsx', wrap(async (req, res) => {
  const run = loadDoneRun(req.params.rid, req, res);
  if (!run) return;
  const buf = require('../services/tz/export').findingsXlsx(run);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent('Реестр замечаний ТЗ.xlsx')}`);
  res.send(buf);
}));

router.get('/runs/:rid/export.docx', wrap(async (req, res) => {
  const run = loadDoneRun(req.params.rid, req, res);
  if (!run) return;
  const project = store.projectById(run.project_id) || { name: 'Проект удалён' };
  const buf = require('../services/tz/export').reportDocx(run, project);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent('Заключение по проверке ТЗ.docx')}`);
  res.send(buf);
}));

module.exports = { router };
