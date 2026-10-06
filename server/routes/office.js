'use strict';

/**
 * Маршруты «Виртуального офиса» (/api/office/*).
 *
 * Вид демонстрационный: сцена и карточки открыты и гостю (optionalUser),
 * чат зовёт модель через общий адаптер и подчиняется тем же правилам доступа
 * к облаку, что и модули. Записи — только в свою базу office.db.
 */

const express = require('express');
const { optionalUser, logErrorResponses } = require('../middleware');
const office = require('../services/office');

const router = express.Router();
router.use(logErrorResponses);

// только Host: клиентский X-Forwarded-Host обходил разделение доменов (аудит 09.09.2026)
const hostOf = (req) => String(req.headers.host || '').split(':')[0].toLowerCase();

router.get('/scene', optionalUser, async (req, res, next) => {
  try {
    const data = await office.sceneData({ projectId: String(req.query.project || ''), user: req.user || null, host: hostOf(req) });
    res.json({ ok: true, ...data });
  } catch (err) { next(err); }
});

router.post('/visit', optionalUser, express.json(), (req, res) => {
  // без Content-Type тела нет вовсе (Express 5): гость без тела — не ошибка сервера
  const body = req.body || {};
  const projectId = typeof body.projectId === 'string' ? body.projectId : '';
  office.recordVisit({ projectId, userName: (req.user && req.user.name) || '', host: hostOf(req) });
  res.json({ ok: true });
});

router.get('/agent/:module', optionalUser, (req, res, next) => {
  try {
    res.json({ ok: true, ...office.agentCard({ module: req.params.module, projectId: String(req.query.project || ''), user: req.user || null }) });
  } catch (err) { next(err); }
});

router.get('/chat', optionalUser, (req, res, next) => {
  try {
    const kind = String(req.query.kind || 'concierge');
    res.json({ ok: true, messages: office.chatHistory({ kind, projectId: String(req.query.project || '') }) });
  } catch (err) { next(err); }
});

router.post('/chat', optionalUser, express.json(), async (req, res, next) => {
  try {
    const { kind = 'concierge', projectId = '', message = '', provider = '', model = '' } = req.body || {};
    if ([kind, projectId, message, provider, model].some((v) => typeof v !== 'string')) {
      return res.status(422).json({ error: 'Текстовые поля должны быть строками' });
    }
    const out = await office.chat({ kind, projectId, message, provider, model, user: req.user || null, host: hostOf(req) });
    res.json({ ok: true, ...out });
  } catch (err) { next(err); }
});

router.get('/kb-docs', optionalUser, (req, res, next) => {
  try {
    // нормативы базы знаний: имена корешков библиотеки; данных проекта здесь нет
    res.json({ ok: true, docs: office.kbDocs() });
  } catch (err) { next(err); }
});

router.get('/doc-thumb/:fileId', optionalUser, async (req, res, next) => {
  try {
    const p = await office.docThumb({ fileId: req.params.fileId, projectId: String(req.query.project || ''), user: req.user || null });
    res.sendFile(p);
  } catch (err) { next(err); }
});

/**
 * В3: результаты бенчмарка кадров с клиента (`?bench=1`, Safari без
 * автоматизации). Хранятся в data/office-perf.json, последние 50 прогонов;
 * тело — только числа и короткие строки, ничего не исполняется.
 */
const fs = require('fs');
const path = require('path');
const config = require('../config');
const PERF_FILE = () => path.join(config.dataDir, 'office-perf.json');
function readPerf() { try { return JSON.parse(fs.readFileSync(PERF_FILE(), 'utf8')); } catch { return []; } }
router.post('/perf', express.json({ limit: '256kb' }), (req, res) => {
  const b = req.body || {};
  if (!Array.isArray(b.points) || !b.points.length || b.points.length > 50) return res.status(400).json({ error: 'нужен список точек маршрута' });
  const clean = {
    at: new Date().toISOString(), ua: String(b.ua || '').slice(0, 200), screen: Array.isArray(b.screen) ? b.screen.slice(0, 3).map(Number) : [],
    visible: b.visible === true, href: String(b.href || '').slice(0, 200), seconds: Number(b.seconds) || 0,
    worstFpsP95: Number(b.worstFpsP95) || 0, maxDrawCalls: Number(b.maxDrawCalls) || 0,
    points: b.points.map((p) => ({ id: String(p.id || '').slice(0, 40), fps: Number(p.fps) || 0, fpsP95: Number(p.fpsP95) || 0, msP50: Number(p.msP50) || 0, msP95: Number(p.msP95) || 0, drawCalls: Number(p.drawCalls) || 0, triangles: Number(p.triangles) || 0, textureMB: Number(p.textureMB) || 0 })),
  };
  const list = readPerf().concat([clean]).slice(-50);
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.writeFileSync(PERF_FILE(), JSON.stringify(list, null, 1));
  res.json({ ok: true, stored: list.length });
});
router.get('/perf', (req, res) => { res.json({ runs: readPerf() }); });

module.exports = { router };
