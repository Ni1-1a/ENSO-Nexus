'use strict';
/**
 * REST модуля «Проверка документа» (+ «Замена оборудования A → B»).
 * Монтируется в app.js под /api/doccheck; все маршруты — за userAuth.
 *
 * Главное отличие от «Анализа ТЗ»: после загрузки документа прогон стартует
 * САМ (решение владельца, пункт 1: «система определяет, что за объект, и
 * запускает нужный промпт»). Человек остаётся сильнее автоматики: тип и
 * промпт можно поменять в карточке и перезапустить.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const platformProjects = require('../services/projects');
const multer = require('multer');
const config = require('../config');
const { rateLimit, userAuth, requestSizeLimit } = require('../middleware');
const store = require('../services/doccheck/store');
const ab = require('../services/doccheck/ab');
const doclib = require('../services/doclib');

const router = express.Router();
router.use(rateLimit(config.rateLimitGeneral, 'doccheck'));
router.use(userAuth);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 40 * 1024 * 1024, files: 1 },
});

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const bigJson = express.json({ limit: '2mb' });
// общий парсер приложения этот роутер обходит — JSON разбирается здесь, до 2 МБ
router.use(bigJson);

function decodeName(file) {
  const { sanitizeFilename } = require('../services/validation');
  return sanitizeFilename(Buffer.from(String(file.originalname), 'latin1').toString('utf8'));
}

let recovered = false;
router.use((req, res, next) => {
  if (!recovered) {
    recovered = true;
    store.recoverInterrupted();
    ab.recoverInterrupted();
  }
  next();
});

/**
 * Гейт «свои проекты» для проверки и сравнения (решение владельца 02.09.2026,
 * закрыто 04.09.2026): запись из чужого проекта для человека не существует —
 * 404; запись видимого проекта, но не своя и не владельца платформы, читается,
 * а правится — 403. Когда вернулось false, ответ уже записан в res.
 */
function allowed(row, req, res, { write = false, notFound = 'Проверка не найдена' } = {}) {
  const denied = platformProjects.entityDenial(row, req.user, { write, notFound });
  if (denied) { res.status(denied.status).json({ error: denied.error }); return false; }
  return true;
}
const AB_NOT_FOUND = 'Сравнение не найдено';

/** Проверка, которой принадлежит прогон, — и мягко удалённая: прогоны остаются читаемыми. */
function checkForRun(run, req, res, opts) {
  return allowed(store.checkRowAny(run.check_id), req, res, opts);
}

/** Значение в тексте ошибки: null и пустая строка — «не указан», а не «null». */
const shown = (v) => (v === null || v === undefined || v === '' ? 'не указан' : String(v));

/** Текст и имя из тела — строки: объект раньше сохранялся как «[object Object]». */
function badStrings(body, res, fields = ['text', 'name']) {
  for (const f of fields) {
    if (body[f] !== undefined && body[f] !== null && typeof body[f] !== 'string') {
      res.status(400).json({ error: `Поле ${f} должно быть строкой` });
      return true;
    }
  }
  return false;
}

/* ---------------- справочное ---------------- */

router.get('/meta', (req, res) => {
  res.json({ types: doclib.meta() });
});

/* ---------------- извлечение текста файла (общее) ---------------- */

async function extractUpload(req, res) {
  if (!req.file) { res.status(400).json({ error: 'Нужен файл (multipart-поле file)' }); return null; }
  const name = decodeName(req.file);
  const ext = path.extname(name).toLowerCase().replace('.', '');
  if (!['docx', 'pdf', 'txt', 'md', 'xml'].includes(ext)) {
    res.status(422).json({ error: `Формат .${ext || '?'} не принимается: нужен DOCX, PDF с текстовым слоем, TXT, MD или XML (график MS Project)` });
    return null;
  }
  // подделка под PDF/DOCX ловится по magic-байтам ДО разбора: иначе она
  // выглядела как «скан без текстового слоя» — и совет был не тот
  if (ext === 'pdf' || ext === 'docx') {
    const magic = require('../services/validation').checkMagic(ext, req.file.buffer);
    if (!magic.ok) { res.status(422).json({ error: magic.reason }); return null; }
  }
  const dir = path.join(config.dataDir, 'doccheck');
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
    res.status(422).json({
      error: ext === 'pdf'
        ? 'В PDF нет текстового слоя (скан). Распознавание сканов здесь не выполняется — вставьте текст вручную.'
        : 'Не удалось извлечь текст из файла',
    });
    return null;
  }
  const tooBig = require('../services/validation').docSizeError(text);
  if (tooBig) { res.status(422).json({ error: tooBig }); return null; }
  return { name, text, note };
}

/* ---------------- проверки документов ---------------- */

router.post('/checks', bigJson, wrap(async (req, res) => {
  const { name, provider, model, projectId } = req.body || {};
  // как в PATCH: объект и число в name/provider/model — 400, а не «[object Object]» в базе
  if (badStrings(req.body || {}, res, ['name', 'provider', 'model'])) return;
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Нужно имя проверки (name)' });
  if (provider) {
    const check = await require('../services/providers')
      .validateChoice(String(provider), model ? String(model) : '', req.user, req.hostname);
    if (!check.ok) return res.status(400).json({ error: check.error });
  }
  const check = store.createCheck({
    name: String(name).trim().slice(0, 200),
    provider: provider ? String(provider) : '',
    model: model ? String(model) : '',
    user: req.user,
    // пусто — «Ранние работы», чужой или удалённый проект — 404 (общее правило модулей)
    projectId: platformProjects.resolveProjectId(projectId, req.user).id,
  });
  platformProjects.touch(check.project_id);
  res.status(201).json({ check });
}));

router.get('/checks', wrap(async (req, res) => {
  const projectId = platformProjects.filterId(req.query.project, req.user);
  const rows = store.listChecks({ projectId });
  // без ?project= — только проверки из видимых, не удалённых проектов платформы
  res.json({ checks: projectId ? rows : platformProjects.onlyVisible(rows, req.user) });
}));

router.get('/checks/:id', wrap(async (req, res) => {
  const check = store.checkById(req.params.id);
  if (!allowed(check, req, res)) return;
  res.json({
    check: { ...check, document_text: undefined, document_chars: check.document_text.length },
    runs: store.listRuns(check.id),
  });
}));

router.patch('/checks/:id', bigJson, wrap(async (req, res) => {
  const { name, provider, model, chosen_type: chosenType, chosen_prompt_id: chosenPromptId } = req.body || {};
  const found = store.checkById(req.params.id);
  if (!allowed(found, req, res, { write: true })) return;
  if (badStrings(req.body || {}, res, ['name', 'provider', 'model', 'chosen_type', 'chosen_prompt_id'])) return;
  // проверка ПОСЛЕ trim: null раньше становился именем «null», пробелы — пустым именем
  if (name !== undefined && !String(name ?? '').trim()) {
    return res.status(400).json({ error: 'Название не может быть пустым' });
  }
  if (provider !== undefined && provider !== '') {
    const check = await require('../services/providers')
      .validateChoice(String(provider), model ? String(model) : '', req.user, req.hostname);
    if (!check.ok) return res.status(400).json({ error: check.error });
  }
  if (chosenType !== undefined && chosenType !== '' && !doclib.DOC_TYPES.includes(chosenType)) {
    return res.status(400).json({ error: `Неизвестный тип документа: ${shown(chosenType)}` });
  }
  // ТЗ здесь не прогоняется — у него свой модуль с чек-листами и вердиктом
  if (chosenType === 'tz') return res.status(400).json({ error: 'ТЗ проверяется в модуле „Анализ ТЗ“' });
  // промпт — только из маршрута своего типа (карта ROUTES + альтернативы): прогон
  // всё равно взял бы умолчание, а человек думал бы, что выбрал другую проверку
  if (chosenPromptId !== undefined && chosenPromptId !== '' && chosenPromptId !== null) {
    const type = (chosenType !== undefined ? chosenType : found.chosen_type) || found.detected_type;
    const route = doclib.ROUTES[type];
    if (!route) return res.status(400).json({ error: 'Сначала укажите тип документа (chosen_type) — промпт выбирается по нему' });
    const allowed = [route.promptId, ...route.alternatives];
    if (!allowed.includes(String(chosenPromptId))) {
      return res.status(400).json({ error: `Промпт «${chosenPromptId}» не относится к типу «${route.label}»; допустимо: ${allowed.join(', ')}` });
    }
  }
  const check = store.updateCheck(req.params.id, {
    name: name !== undefined ? String(name).trim().slice(0, 200) : undefined,
    ai_provider: provider !== undefined ? String(provider) : undefined,
    ai_model: model !== undefined ? String(model) : undefined,
    chosen_type: chosenType,
    // снятый тип («») снимает и выбранный промпт: он относился к прежнему типу;
    // null — тоже «снять», а не строка «null» в базе
    chosen_prompt_id: chosenPromptId === null || (chosenType === '' && chosenPromptId === undefined) ? '' : chosenPromptId,
  });
  res.json({ check: { ...check, document_text: undefined, document_chars: check.document_text.length } });
}));

router.delete('/checks/:id', wrap(async (req, res) => {
  if (!allowed(store.checkById(req.params.id), req, res, { write: true })) return;
  store.deleteCheck(req.params.id);
  res.json({ ok: true });
}));

/* ---------------- документ и автозапуск ---------------- */

/**
 * Запуск прогона. Возвращает { runId } или null, если прогон уже идёт.
 * Ошибки конвейера уходят в строку прогона, не в HTTP.
 */
function startRun(check, req) {
  const running = store.listRuns(check.id).find((r) => ['queued', 'running'].includes(r.status));
  if (running) return null;
  const run = store.createRun(check, req.user);
  const host = String(req.hostname || '').toLowerCase();
  setImmediate(async () => {
    try {
      store.setRunStatus(run.id, 'running', { progress: 'подготовка…' });
      await require('../services/doccheck/analyze').runCheck(run.id, { host });
    } catch (err) {
      console.error(`[doccheck] прогон ${run.id}: ${err.message}`);
      store.setRunStatus(run.id, 'failed', { error: err.message });
    }
  });
  return run.id;
}

router.put('/checks/:id/document', bigJson, wrap(async (req, res) => {
  if (!allowed(store.checkById(req.params.id), req, res, { write: true })) return;
  if (badStrings(req.body || {}, res)) return;
  const text = String((req.body || {}).text || '').trim();
  if (!text) return res.status(400).json({ error: 'Пустой текст документа' });
  const tooBig = require('../services/validation').docSizeError(text);
  if (tooBig) return res.status(422).json({ error: tooBig });
  const check = store.setDocument(req.params.id, {
    text,
    name: String((req.body || {}).name || 'вставленный текст').slice(0, 200),
    note: '',
  });
  const runId = startRun(check, req);
  res.json({
    document: { name: check.document_name, chars: check.document_text.length },
    runId,
  });
}));

router.post('/checks/:id/document/file',
  rateLimit(config.rateLimitExpensive, 'doccheck-upload'), requestSizeLimit(config.uploadTotalBytes), upload.single('file'),
  wrap(async (req, res) => {
    const found = store.checkById(req.params.id);
    if (!allowed(found, req, res, { write: true })) return;
    const extracted = await extractUpload(req, res);
    if (!extracted) return;
    const check = store.setDocument(found.id, extracted);
    const runId = startRun(check, req);
    res.status(201).json({
      document: { name: check.document_name, chars: check.document_text.length, note: extracted.note },
      runId,
    });
  }));

router.post('/checks/:id/analyze',
  rateLimit(config.rateLimitExpensive, 'doccheck-analyze'), bigJson,
  wrap(async (req, res) => {
    const check = store.checkById(req.params.id);
    if (!allowed(check, req, res, { write: true })) return;
    if (!check.document_text.trim()) {
      return res.status(422).json({ error: 'Нет текста документа — загрузите файл или вставьте текст' });
    }
    const runId = startRun(check, req);
    if (!runId) {
      const running = store.listRuns(check.id).find((r) => ['queued', 'running'].includes(r.status));
      return res.status(409).json({ error: 'Прогон уже идёт', runId: running && running.id });
    }
    res.status(202).json({ runId, status: 'queued' });
  }));

router.get('/runs/:rid', wrap(async (req, res) => {
  const run = store.runById(req.params.rid);
  if (!run) return res.status(404).json({ error: 'Прогон не найден' });
  if (!checkForRun(run, req, res)) return;
  res.json({ run });
}));

router.post('/runs/:rid/findings/:fid/decision', bigJson, wrap(async (req, res) => {
  const run = store.runById(req.params.rid);
  if (!run) return res.status(404).json({ error: 'Прогон не найден' });
  if (!checkForRun(run, req, res, { write: true })) return;
  const decision = (req.body || {}).decision ?? null;
  const saved = store.setDecision(req.params.rid, req.params.fid, decision, req.user);
  res.json({ findingId: req.params.fid, decision: saved });
}));

router.get('/runs/:rid/export.xlsx', wrap(async (req, res) => {
  const run = store.runById(req.params.rid);
  if (!run) return res.status(404).json({ error: 'Прогон не найден' });
  if (!checkForRun(run, req, res)) return;
  if (run.status !== 'done' || !run.result) {
    return res.status(409).json({ error: 'Прогон ещё не завершён — экспортировать нечего' });
  }
  const buf = require('../services/doccheck/export').findingsXlsx(run);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent('Проверка документа.xlsx')}`);
  res.send(buf);
}));

/* ---------------- замена оборудования A → B ---------------- */

router.post('/ab', bigJson, wrap(async (req, res) => {
  const { name, provider, model, projectId } = req.body || {};
  if (badStrings(req.body || {}, res, ['name', 'provider', 'model'])) return;
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Нужно имя сравнения (name)' });
  if (provider) {
    const check = await require('../services/providers')
      .validateChoice(String(provider), model ? String(model) : '', req.user, req.hostname);
    if (!check.ok) return res.status(400).json({ error: check.error });
  }
  const row = ab.createAb({
    name: String(name).trim().slice(0, 200),
    provider: provider ? String(provider) : '',
    model: model ? String(model) : '',
    user: req.user,
    // пусто — «Ранние работы», чужой или удалённый проект — 404 (общее правило модулей)
    projectId: platformProjects.resolveProjectId(projectId, req.user).id,
  });
  platformProjects.touch(row.project_id);
  res.status(201).json({ ab: row });
}));

router.get('/ab', wrap(async (req, res) => {
  const projectId = platformProjects.filterId(req.query.project, req.user);
  const rows = ab.listAb({ projectId });
  // без ?project= — только сравнения из видимых, не удалённых проектов платформы
  res.json({ list: projectId ? rows : platformProjects.onlyVisible(rows, req.user) });
}));

router.get('/ab/:id', wrap(async (req, res) => {
  const row = ab.abById(req.params.id);
  if (!allowed(row, req, res, { notFound: AB_NOT_FOUND })) return;
  res.json({ ab: row });
}));

router.patch('/ab/:id', bigJson, wrap(async (req, res) => {
  const row = ab.abById(req.params.id);
  if (!allowed(row, req, res, { write: true, notFound: AB_NOT_FOUND })) return;
  if (badStrings(req.body || {}, res, ['name', 'provider', 'model'])) return;
  const { name, provider, model } = req.body || {};
  // проверка ПОСЛЕ trim: null раньше становился именем «null», пробелы — пустым именем
  if (name !== undefined && !String(name ?? '').trim()) {
    return res.status(400).json({ error: 'Название не может быть пустым' });
  }
  if (provider !== undefined && provider !== '') {
    const check = await require('../services/providers')
      .validateChoice(String(provider), model ? String(model) : '', req.user, req.hostname);
    if (!check.ok) return res.status(400).json({ error: check.error });
  }
  const sets = [];
  const args = [];
  if (name !== undefined) { sets.push('name = ?'); args.push(String(name).trim().slice(0, 200)); }
  if (provider !== undefined) { sets.push('ai_provider = ?'); args.push(String(provider)); }
  if (model !== undefined) { sets.push('ai_model = ?'); args.push(String(model)); }
  if (sets.length) {
    sets.push('updated_at = ?');
    args.push(new Date().toISOString(), req.params.id);
    ab.abById(req.params.id); // существование уже проверено выше
    store.db.prepare(`UPDATE doccheck_ab SET ${sets.join(', ')} WHERE id = ?`).run(...args);
  }
  res.json({ ab: ab.abById(req.params.id) });
}));

router.delete('/ab/:id', wrap(async (req, res) => {
  if (!allowed(ab.abById(req.params.id), req, res, { write: true, notFound: AB_NOT_FOUND })) return;
  ab.deleteAb(req.params.id);
  res.json({ ok: true });
}));

router.put('/ab/:id/docs/:kind', bigJson, wrap(async (req, res) => {
  if (!allowed(ab.abById(req.params.id), req, res, { write: true, notFound: AB_NOT_FOUND })) return;
  if (badStrings(req.body || {}, res)) return;
  const text = String((req.body || {}).text || '').trim();
  if (!text) return res.status(400).json({ error: 'Пустой текст' });
  const row = ab.appendDoc(req.params.id, req.params.kind, {
    name: String((req.body || {}).name || 'вставленный текст').slice(0, 200),
    text,
  });
  res.json({ ab: row });
}));

router.post('/ab/:id/docs/:kind/file',
  rateLimit(config.rateLimitExpensive, 'doccheck-ab-upload'), requestSizeLimit(config.uploadTotalBytes), upload.single('file'),
  wrap(async (req, res) => {
    const found = ab.abById(req.params.id);
    if (!allowed(found, req, res, { write: true, notFound: AB_NOT_FOUND })) return;
    const extracted = await extractUpload(req, res);
    if (!extracted) return;
    const row = ab.appendDoc(found.id, req.params.kind, extracted);
    res.status(201).json({ ab: row, note: extracted.note });
  }));

router.delete('/ab/:id/docs/:kind', wrap(async (req, res) => {
  if (!allowed(ab.abById(req.params.id), req, res, { write: true, notFound: AB_NOT_FOUND })) return;
  res.json({ ab: ab.clearDocs(req.params.id, req.params.kind) });
}));

router.post('/ab/:id/run',
  rateLimit(config.rateLimitExpensive, 'doccheck-ab-run'), bigJson,
  wrap(async (req, res) => {
    const row = ab.abById(req.params.id);
    if (!allowed(row, req, res, { write: true, notFound: AB_NOT_FOUND })) return;
    if (row.status === 'running') return res.status(409).json({ error: 'Сравнение уже идёт' });
    // чего не хватает — говорим сразу (422), как в «Анализе ТЗ», а не роняем
    // сравнение в failed через опрос
    const notReady = ab.runPrecheck(row);
    if (notReady) return res.status(422).json({ error: notReady });
    const host = String(req.hostname || '').toLowerCase();
    ab.setStatus(row.id, 'running', { progress: 'подготовка…', error: '' });
    setImmediate(async () => {
      try {
        await ab.runCompare(row.id, { host });
      } catch (err) {
        console.error(`[doccheck-ab] сравнение ${row.id}: ${err.message}`);
        ab.setStatus(row.id, 'failed', { error: err.message });
      }
    });
    res.status(202).json({ status: 'running' });
  }));

router.post('/ab/:id/rows/:rowId/decision', bigJson, wrap(async (req, res) => {
  if (!allowed(ab.abById(req.params.id), req, res, { write: true, notFound: AB_NOT_FOUND })) return;
  const { decision = null, comment = '' } = req.body || {};
  const saved = ab.setRowDecision(req.params.id, req.params.rowId, { decision, comment }, req.user);
  res.json({ rowId: req.params.rowId, decision: saved });
}));

router.get('/ab/:id/export.xlsx', wrap(async (req, res) => {
  const row = ab.abById(req.params.id);
  if (!allowed(row, req, res, { notFound: AB_NOT_FOUND })) return;
  if (row.status !== 'done' || !row.result) {
    return res.status(409).json({ error: 'Сравнение ещё не завершено — экспортировать нечего' });
  }
  const buf = ab.protocolXlsx(row);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent('Протокол сравнения A-B.xlsx')}`);
  res.send(buf);
}));

module.exports = { router };
