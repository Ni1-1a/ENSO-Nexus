'use strict';
/**
 * Маршруты обсуждения выделенного фрагмента (/api/fragment-chat/*).
 *
 * Общие для всей платформы: любой модуль шлёт сюда выделенный текст, окружение
 * и место, а получает разговор о нём. Вход обязателен — обращение тратит
 * бюджет проекта; правила доступа к проекту проверяет служба.
 */
const express = require('express');
const { userAuth, logErrorResponses, rateLimit } = require('../middleware');
const config = require('../config');
const fragmentChat = require('../services/fragment-chat');

const router = express.Router();
router.use(logErrorResponses);
router.use(rateLimit(config.rateLimitGeneral, 'fragment-chat'));

// только Host: клиентский X-Forwarded-Host обходил разделение доменов
const hostOf = (req) => String(req.headers.host || '').split(':')[0].toLowerCase();

const strings = (obj, keys) => keys.every((k) => obj[k] === undefined || typeof obj[k] === 'string');

/** Открыть обсуждение фрагмента (или вернуть уже открытое по тому же месту). */
router.post('/threads', userAuth, express.json({ limit: '256kb' }), (req, res, next) => {
  try {
    const b = req.body || {};
    if (!strings(b, ['projectId', 'module', 'entityId', 'anchor', 'fragment', 'context'])) {
      return res.status(422).json({ error: 'Текстовые поля должны быть строками' });
    }
    res.json({ ok: true, thread: fragmentChat.openThread({ ...b, user: req.user }) });
  } catch (err) { next(err); }
});

/** Обсуждения этого места — чтобы вернуться к прежнему разговору. */
router.get('/threads', userAuth, (req, res, next) => {
  try {
    res.json({
      ok: true,
      threads: fragmentChat.listThreads({
        projectId: String(req.query.project || ''),
        module: String(req.query.module || ''),
        entityId: String(req.query.entity || ''),
        user: req.user,
      }),
    });
  } catch (err) { next(err); }
});

router.get('/threads/:id', userAuth, (req, res, next) => {
  try {
    res.json({ ok: true, thread: fragmentChat.threadFor(req.params.id, req.user) });
  } catch (err) { next(err); }
});

/*
 * Реплика — самое дорогое здесь действие: обращение к модели за счёт проекта.
 * Поэтому свой ограничитель частоты, а нейросеть берётся у проекта и телом
 * запроса не задаётся (решение владельца 10.09.2026).
 */
router.post('/threads/:id/messages', userAuth,
  rateLimit(config.rateLimitExpensive, 'fragment-chat-reply'),
  express.json({ limit: '64kb' }), async (req, res, next) => {
    try {
      const b = req.body || {};
      if (!strings(b, ['message'])) {
        return res.status(422).json({ error: 'Текстовые поля должны быть строками' });
      }
      const out = await fragmentChat.reply({
        threadId: req.params.id,
        message: b.message || '',
        user: req.user,
        host: hostOf(req),
      });
      res.json({ ok: true, ...out });
    } catch (err) { next(err); }
  });

module.exports = { router };
