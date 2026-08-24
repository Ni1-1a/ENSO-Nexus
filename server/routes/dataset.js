'use strict';
/**
 * REST модуля «Датасет». Монтируется в app.js под /api/dataset.
 *
 * Все маршруты — за userAuth + datasetAccess. Правила, которые держит слой
 * маршрутов (и проверяют тесты):
 *  - status, validated_by_name и validated_at НЕ принимаются с клиента нигде:
 *    правка знает только question/answer, подтверждение — отдельный маршрут,
 *    ФИО берётся из req.user на сервере;
 *  - удаление пары — только мягкое;
 *  - экспорт отдаёт ВЕСЬ валидированный набор независимо от фильтров UI.
 */
const fs = require('fs');
const path = require('path');
const express = require('express');
const multer = require('multer');
const config = require('../config');
const { rateLimit, userAuth } = require('../middleware');
const { sanitizeFilename, validateUpload } = require('../services/validation');
const store = require('../services/dataset/store');
const { datasetAccess } = require('../services/dataset/access');

const router = express.Router();
router.use(rateLimit(config.rateLimitGeneral, 'dataset'));
router.use(userAuth, datasetAccess);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxFileSizeBytes + 1024, files: 1 },
});

// await, а не Promise.resolve(fn(...)): синхронный throw из обработчика иначе
// уходит мимо catch — прямо в общий errorHandler, теряя поля конфликта
const wrap = (fn) => async (req, res, next) => {
  try {
    await fn(req, res, next);
  } catch (err) {
    // конфликт optimistic lock несёт «кто и когда» — общий errorHandler отдаёт
    // только текст, а клиенту нужны поля, чтобы предложить перечитать пару
    if (err && err.status === 409 && err.updatedAt) {
      return res.status(409).json({ error: err.message, updatedBy: err.updatedBy || '', updatedAt: err.updatedAt });
    }
    next(err);
  }
};

/* ---------------- настройки модуля ---------------- */

router.get('/settings', (req, res) => {
  res.json({ settings: store.settingsGet(), datasetOpen: config.datasetOpen });
});

router.put('/settings', express.json({ limit: '256kb' }), wrap((req, res) => {
  res.json({ settings: store.settingsSet(req.body || {}) });
}));

/* ---------------- документы ---------------- */

router.get('/documents', (req, res) => {
  res.json({ documents: store.listDocuments() });
});

router.post('/documents', rateLimit(config.rateLimitExpensive, 'dataset-upload'), upload.single('file'), wrap(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Файл не передан' });
  const originalName = sanitizeFilename(Buffer.from(req.file.originalname, 'latin1').toString('utf8'));
  // те же форматы, лимит размера и проверка магических байтов, что у платформы;
  // счётчики «файлов в сессии» датасета не касаются — список пустой
  const check = validateUpload({ originalName, buffer: req.file.buffer }, []);
  if (!check.ok) return res.status(400).json({ error: check.error });

  const fileSha = store.sha256(req.file.buffer);
  const existing = store.docBySha(fileSha);
  if (existing) {
    // повторная загрузка не заводит ни второго документа, ни дублей элементов
    return res.json({ document: existing, duplicate: true });
  }

  const id = require('crypto').randomUUID();
  const storedPath = path.join(store.docDir(), `${id}_${originalName}`);
  if (!path.resolve(storedPath).startsWith(path.resolve(store.docDir()) + path.sep)) {
    return res.status(400).json({ error: 'Недопустимое имя файла' });
  }
  fs.writeFileSync(storedPath, req.file.buffer);
  const doc = store.createDocument({
    filename: originalName, fileSha, format: check.ext, mime: req.file.mimetype || '',
    size: req.file.buffer.length, storedPath, user: req.user,
  });
  require('../services/dataset/ingest').ensureServiceSession(doc, req.user,
    String(req.hostname || '').toLowerCase().split(':')[0].trim());
  // обработка фоновая: UI не ждёт ни нарезки, ни генерации
  setImmediate(() => require('../services/dataset/ingest').processDocument(doc.id));
  res.status(201).json({ document: store.docById(doc.id), duplicate: false });
}));

router.get('/documents/:docId', wrap((req, res) => {
  const doc = store.docById(req.params.docId);
  if (!doc) return res.status(404).json({ error: 'Документ не найден' });
  res.json({ document: doc, progress: store.docProgress(doc.id) });
}));

/** Исходный файл — для «ссылки на документ» из «Истории». */
router.get('/documents/:docId/file', wrap((req, res) => {
  const doc = store.docById(req.params.docId);
  if (!doc || !fs.existsSync(doc.stored_path)) return res.status(404).json({ error: 'Файл документа не найден' });
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(doc.filename)}`);
  res.sendFile(path.resolve(doc.stored_path));
}));

/** Перезапуск генерации черновиков (после сбоя или для элементов «без пары»). */
router.post('/documents/:docId/generate', rateLimit(config.rateLimitExpensive, 'dataset-generate'), express.json(), wrap((req, res) => {
  const doc = store.docById(req.params.docId);
  if (!doc) return res.status(404).json({ error: 'Документ не найден' });
  const ingest = require('../services/dataset/ingest');
  if (ingest._running.has(doc.id)) return res.status(409).json({ error: 'Документ уже обрабатывается' });
  store.setDocStatus(doc.id, 'generating', { error: '' });
  setImmediate(async () => {
    try {
      const gen = await require('../services/dataset/generate').generateForDocument(doc.id, {
        onProgress: (label) => store.setDocProgress(doc.id, label),
      });
      store.setDocStatus(doc.id, 'ready', {
        progress: `черновиков: ${gen.created}${gen.unfit ? `, непригодных ответов: ${gen.unfit}` : ''}${gen.failed ? `, ошибок: ${gen.failed}` : ''}${gen.total === 0 ? ' (элементов без пары не осталось)' : ''}`,
      });
    } catch (err) {
      store.setDocStatus(doc.id, 'failed', { error: err.message });
    }
  });
  res.json({ ok: true });
}));

/* ---------------- элементы ---------------- */

router.get('/documents/:docId/elements', wrap((req, res) => {
  const doc = store.docById(req.params.docId);
  if (!doc) return res.status(404).json({ error: 'Документ не найден' });
  const state = ['no_pairs', 'in_progress', 'done', 'deferred'].includes(req.query.state) ? req.query.state : '';
  res.json({ elements: store.elementsOfDocument(doc.id, { state }), progress: store.docProgress(doc.id) });
}));

router.get('/elements/:elementId', wrap((req, res) => {
  const el = store.elementById(req.params.elementId);
  if (!el) return res.status(404).json({ error: 'Элемент не найден' });
  res.json({ element: el, pairs: store.livePairsOf(el.id) });
}));

/** «Пропустить»: связка документ+элемент → deferred; статусы пар не меняются. */
router.post('/documents/:docId/elements/:elementId/defer', express.json(), wrap((req, res) => {
  const on = req.body && req.body.off ? false : true;
  const state = store.deferElement(req.params.docId, req.params.elementId, on);
  res.json({ state });
}));

/* ---------------- пары ---------------- */

/** Ручная пара — всегда pending; статус с клиента не принимается. */
router.post('/elements/:elementId/pairs', express.json({ limit: '256kb' }), wrap((req, res) => {
  const pair = store.createPair({
    elementId: req.params.elementId,
    question: req.body && req.body.question,
    answer: req.body && req.body.answer,
    origin: 'manual',
    actor: store.userName(req.user),
  });
  res.status(201).json({ pair });
}));

router.patch('/pairs/:pairId', express.json({ limit: '256kb' }), wrap((req, res) => {
  const pair = store.editPair(req.params.pairId, {
    question: req.body && req.body.question,
    answer: req.body && req.body.answer,
    actor: store.userName(req.user),
    expectedUpdatedAt: req.body && req.body.expectedUpdatedAt,
  });
  res.json({ pair });
}));

router.post('/pairs/:pairId/validate', express.json(), wrap((req, res) => {
  const pair = store.validatePair(req.params.pairId, {
    user: req.user, // ФИО и дату ставит сервер; тело запроса не читается вовсе
    expectedUpdatedAt: req.body && req.body.expectedUpdatedAt,
  });
  res.json({ pair });
}));

router.post('/pairs/:pairId/reject', express.json(), wrap((req, res) => {
  const pair = store.rejectPair(req.params.pairId, {
    user: req.user,
    expectedUpdatedAt: req.body && req.body.expectedUpdatedAt,
  });
  res.json({ pair });
}));

router.delete('/pairs/:pairId', wrap((req, res) => {
  const pair = store.deletePair(req.params.pairId, { actor: store.userName(req.user) });
  res.json({ pair });
}));

router.post('/pairs/:pairId/restore', express.json(), wrap((req, res) => {
  const pair = store.restorePair(req.params.pairId, { actor: store.userName(req.user) });
  res.json({ pair });
}));

/* ---------------- «История» ---------------- */

router.get('/pairs', wrap((req, res) => {
  res.json(store.history({
    q: String(req.query.q || ''),
    status: ['draft', 'pending', 'validated', 'rejected'].includes(req.query.status) ? req.query.status : '',
    documentId: String(req.query.document || ''),
    validator: String(req.query.validator || ''),
    kind: ['text', 'table'].includes(req.query.kind) ? req.query.kind : '',
    origin: ['auto', 'manual'].includes(req.query.origin) ? req.query.origin : '',
    from: /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.from || '')) ? req.query.from : '',
    to: /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.to || '')) ? req.query.to : '',
    sort: String(req.query.sort || 'updated'),
    page: req.query.page,
    per: req.query.per,
  }));
}));

/* ---------------- экспорт ---------------- */

router.get('/export', wrap((req, res) => {
  const exporter = require('../services/dataset/exporter');
  if (String(req.query.split) === '1') {
    const out = exporter.buildSplitExport();
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${out.filename}"`);
    res.setHeader('X-Dataset-Pairs', String(out.pairs));
    return res.send(out.buffer);
  }
  const out = exporter.buildExport();
  res.setHeader('Content-Type', 'application/jsonl; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${out.filename}"`);
  res.setHeader('X-Dataset-Pairs', String(out.pairs));
  res.send(out.buffer);
}));

module.exports = { router };
