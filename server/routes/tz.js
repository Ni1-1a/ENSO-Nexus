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
const multer = require('multer');
const config = require('../config');
const { rateLimit, userAuth } = require('../middleware');
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

// текст ЗнП больше общего лимита JSON платформы (256 КБ) — свой разбор тела
const bigJson = express.json({ limit: '2mb' });

// multer отдаёт originalname в latin1 — кириллица без перекодировки превращается
// в кракозябры (тот же приём, что в routes/api.js платформы)
function decodeName(file) {
  const { sanitizeFilename } = require('../services/validation');
  return sanitizeFilename(Buffer.from(String(file.originalname), 'latin1').toString('utf8'));
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
  const { name, checklist, provider, model, object } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Нужно имя проекта (name)' });
  const checklistId = checklist || 'production';
  if (!checklists.CHECKLISTS[checklistId]) {
    return res.status(400).json({ error: `Неизвестный чек-лист: ${checklistId}` });
  }
  if (provider) {
    const check = await require('../services/providers')
      .validateChoice(String(provider), model ? String(model) : '', req.user, req.hostname);
    if (!check.ok) return res.status(400).json({ error: check.error });
  }
  const project = store.createProject({
    name: String(name).trim().slice(0, 200),
    checklist: checklistId,
    provider: provider ? String(provider) : '',
    model: model ? String(model) : '',
    object: object && typeof object === 'object' ? object : {},
    user: req.user,
  });
  res.status(201).json({ project });
}));

router.get('/projects', (req, res) => {
  res.json({ projects: store.listProjects() });
});

router.get('/projects/:id', wrap(async (req, res) => {
  const project = store.projectById(req.params.id);
  if (!project) return res.status(404).json({ error: 'Проект не найден' });
  res.json({
    project: { ...project, document_text: undefined, document_chars: project.document_text.length },
    runs: store.listRuns(project.id),
  });
}));

router.get('/projects/:id/document', wrap(async (req, res) => {
  const project = store.projectById(req.params.id);
  if (!project) return res.status(404).json({ error: 'Проект не найден' });
  res.json({ name: project.document_name, note: project.document_note, text: project.document_text });
}));

router.patch('/projects/:id', bigJson, wrap(async (req, res) => {
  const { name, checklist, provider, model, object } = req.body || {};
  if (checklist !== undefined && !checklists.CHECKLISTS[checklist]) {
    return res.status(400).json({ error: `Неизвестный чек-лист: ${checklist}` });
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
  res.json({ project: { ...project, document_text: undefined } });
}));

router.delete('/projects/:id', wrap(async (req, res) => {
  store.deleteProject(req.params.id);
  res.json({ ok: true });
}));

/* ---------------- документ ЗнП ---------------- */

/** Вставка текста ЗнП руками (основной путь, работает всегда). */
router.put('/projects/:id/document', bigJson, wrap(async (req, res) => {
  const text = String((req.body || {}).text || '').trim();
  if (!text) return res.status(400).json({ error: 'Пустой текст ЗнП' });
  const project = store.setDocument(req.params.id, {
    text,
    name: String((req.body || {}).name || 'вставленный текст').slice(0, 200),
    note: '',
  });
  res.json({ document: { name: project.document_name, chars: project.document_text.length } });
}));

/**
 * Загрузка файла ЗнП: DOCX, PDF с текстовым слоем, TXT/MD. Сканы без текстового
 * слоя в v1 не распознаются — честный отказ, не молчаливый пустой текст.
 */
router.post('/projects/:id/document/file',
  rateLimit(config.rateLimitExpensive, 'tz-upload'), upload.single('file'),
  wrap(async (req, res) => {
    const project = store.projectById(req.params.id);
    if (!project) return res.status(404).json({ error: 'Проект не найден' });
    if (!req.file) return res.status(400).json({ error: 'Нужен файл (multipart-поле file)' });
    const name = decodeName(req.file);
    const ext = path.extname(name).toLowerCase().replace('.', '');
    if (!['docx', 'pdf', 'txt', 'md'].includes(ext)) {
      return res.status(422).json({ error: `Формат .${ext || '?'} не принимается: нужен DOCX, PDF с текстовым слоем, TXT или MD` });
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
          ? 'В PDF нет текстового слоя (скан). В этой версии распознавание сканов не выполняется — вставьте текст ЗнП вручную.'
          : 'Не удалось извлечь текст из файла',
      });
    }
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
    if (!project) return res.status(404).json({ error: 'Проект не найден' });
    if (!project.document_text.trim()) {
      return res.status(422).json({ error: 'В проекте нет текста ЗнП — загрузите документ или вставьте текст' });
    }
    if (!project.ai_provider) {
      return res.status(422).json({ error: 'Не выбрана модель — укажите её в настройках проекта' });
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
  res.json({ run });
}));

/* ---------------- решения по находкам ---------------- */

router.post('/runs/:rid/findings/:fid/decision', bigJson, wrap(async (req, res) => {
  const decision = (req.body || {}).decision ?? null;
  const saved = store.setDecision(req.params.rid, req.params.fid, decision, req.user);
  res.json({ findingId: req.params.fid, decision: saved });
}));

/* ---------------- экспорт ---------------- */

function loadDoneRun(rid, res) {
  const run = store.runById(rid);
  if (!run) { res.status(404).json({ error: 'Прогон не найден' }); return null; }
  if (run.status !== 'done' || !run.result) {
    res.status(409).json({ error: 'Прогон ещё не завершён — экспортировать нечего' });
    return null;
  }
  return run;
}

router.get('/runs/:rid/export.xlsx', wrap(async (req, res) => {
  const run = loadDoneRun(req.params.rid, res);
  if (!run) return;
  const buf = require('../services/tz/export').findingsXlsx(run);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent('Реестр замечаний ТЗ.xlsx')}`);
  res.send(buf);
}));

router.get('/runs/:rid/export.docx', wrap(async (req, res) => {
  const run = loadDoneRun(req.params.rid, res);
  if (!run) return;
  const project = store.projectById(run.project_id) || { name: 'Проект удалён' };
  const buf = require('../services/tz/export').reportDocx(run, project);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent('Заключение по проверке ТЗ.docx')}`);
  res.send(buf);
}));

module.exports = { router };
