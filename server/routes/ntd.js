'use strict';
/**
 * Маршруты модуля «Вопрос по нормам» (/api/ntd/*). Все — за userAuth: вопрос
 * тратит бюджет проекта. Нейросеть берётся у проекта, тело запроса её не задаёт.
 */
const express = require('express');
const { userAuth, logErrorResponses, rateLimit } = require('../middleware');
const config = require('../config');
const ntdAsk = require('../services/ntd-ask');

const router = express.Router();
router.use(logErrorResponses);
router.use(rateLimit(config.rateLimitGeneral, 'ntd'));
router.use(userAuth);

// только Host: клиентский X-Forwarded-Host обходил разделение доменов
const hostOf = (req) => String(req.headers.host || '').split(':')[0].toLowerCase();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// вопросы, прерванные перезапуском, помечаются ошибкой при первом обращении к модулю
let recovered = false;
router.use((req, res, next) => {
  if (!recovered) { recovered = true; ntdAsk.recoverInterrupted(); }
  next();
});

/** Справочное: базы знаний, состояние индекса, доступность корпуса нормоконтроля. */
router.get('/meta', wrap(async (req, res) => {
  let kbStatus = { enabled: false };
  try { kbStatus = require('../services/kb').status(); } catch { /* базы нет */ }
  res.json({
    ok: true,
    bases: config.kbBases.map((b) => ({ id: b.id, label: b.label })),
    kb: kbStatus,
    corpus: await ntdAsk.corpusInfo(),
    maxQuestion: ntdAsk.MAX_QUESTION,
  });
}));

/** Вопросы проекта: ?project=<id>; без него — вопросы всех видимых проектов. */
router.get('/questions', (req, res, next) => {
  try {
    res.json({ ok: true, questions: ntdAsk.list({ projectId: req.query.project, user: req.user }) });
  } catch (err) { next(err); }
});

/*
 * Задать вопрос — самое дорогое действие модуля: обращение к модели за счёт
 * проекта. Свой ограничитель частоты; ответ готовится в фоне — 202 и опрос.
 */
router.post('/questions', rateLimit(config.rateLimitExpensive, 'ntd-ask'), express.json({ limit: '64kb' }), (req, res, next) => {
  try {
    const b = req.body || {};
    const question = ntdAsk.create({
      projectId: b.projectId,
      question: b.question,
      kbId: b.kb,
      corpus: b.corpus,
      user: req.user,
    });
    ntdAsk.start(question.id, { host: hostOf(req) });
    res.status(202).json({ ok: true, question });
  } catch (err) { next(err); }
});

router.get('/questions/:id', (req, res, next) => {
  try {
    res.json({ ok: true, question: ntdAsk.get(req.params.id, req.user) });
  } catch (err) { next(err); }
});

router.delete('/questions/:id', (req, res, next) => {
  try {
    ntdAsk.remove(req.params.id, req.user);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = { router };
