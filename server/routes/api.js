'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const config = require('../config');
const { db, now } = require('../db');
const { sanitizeFilename, validateUpload } = require('../services/validation');
const pipeline = require('../services/pipeline');
const { rateLimit, sessionAuth } = require('../middleware');

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxFileSizeBytes + 1024, files: 5 },
});

const generalLimit = rateLimit(config.rateLimitGeneral);
const expensiveLimit = rateLimit(config.rateLimitExpensive);
router.use(generalLimit);

/* ---------- health ---------- */
router.get('/health', async (req, res) => {
  let kb = { enabled: false };
  let providers = [];
  try { kb = require('../services/kb').status(); } catch {}
  try { providers = await require('../services/providers').listProviders(); } catch {}
  res.json({
    ok: true,
    kb,
    providers,
    kbBases: config.kbBases.map((b) => ({ id: b.id, label: b.label })),
    aiMode: config.aiMode,
    model: config.aiMode === 'live' ? config.anthropicModel
      : config.aiMode === 'local' ? config.localAiModel : null,
    promptVersion: config.promptVersion,
    limits: {
      maxFileSizeMb: Math.round(config.maxFileSizeBytes / 1048576),
      maxTotalUploadMb: Math.round(config.maxTotalUploadBytes / 1048576),
      maxFiles: config.maxFilesPerSession,
      allowedExtensions: config.allowedExtensions,
      maxMessageLength: config.maxMessageLength,
      sessionTtlHours: config.sessionTtlHours,
    },
  });
});

/* ---------- sessions ---------- */
router.post('/sessions', expensiveLimit, (req, res) => {
  const id = crypto.randomUUID();
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (id, token, prompt_version, created_at, updated_at) VALUES (?,?,?,?,?)')
    .run(id, token, config.promptVersion, now(), now());
  pipeline.logEvent(id, 'Сессия создана');
  res.status(201).json({ id, token });
});

function sessionView(session) {
  const files = db.prepare('SELECT id, original_name AS name, size, ext, created_at FROM files WHERE session_id = ? ORDER BY created_at').all(session.id);
  const messages = db.prepare('SELECT id, role, kind, content, created_at FROM messages WHERE session_id = ? ORDER BY created_at').all(session.id);
  const questions = db.prepare('SELECT id, text, why, status, answer, created_at FROM questions WHERE session_id = ? ORDER BY created_at').all(session.id);
  const events = db.prepare('SELECT stage, detail, level, created_at FROM events WHERE session_id = ? ORDER BY id DESC LIMIT 50').all(session.id).reverse();
  const results = db.prepare('SELECT id, filename, title, format, size, created_at FROM results WHERE session_id = ? ORDER BY created_at').all(session.id);
  const facts = db.prepare('SELECT key, value, source FROM facts WHERE session_id = ? ORDER BY created_at').all(session.id);
  return {
    id: session.id,
    jobStatus: session.job_status,
    comment: session.comment,
    settings: {
      aiProvider: session.ai_provider || '',
      aiModel: session.ai_model || '',
      kbChoice: session.kb_choice || 'main',
    },
    aiRequests: session.ai_requests,
    createdAt: session.created_at,
    updatedAt: session.updated_at,
    files, messages, questions, events, results, facts,
  };
}

router.get('/sessions/:id', sessionAuth, (req, res) => {
  res.json(sessionView(req.session));
});

router.get('/sessions/:id/status', sessionAuth, (req, res) => {
  const events = db.prepare('SELECT stage, detail, level, created_at FROM events WHERE session_id = ? ORDER BY id DESC LIMIT 50').all(req.session.id).reverse();
  res.json({ jobStatus: req.session.job_status, events });
});

router.get('/sessions/:id/messages', sessionAuth, (req, res) => {
  const messages = db.prepare('SELECT id, role, kind, content, created_at FROM messages WHERE session_id = ? ORDER BY created_at').all(req.session.id);
  res.json({ messages });
});

router.delete('/sessions/:id', sessionAuth, (req, res) => {
  deleteSessionData(req.session.id);
  res.json({ ok: true });
});

function deleteSessionData(sessionId) {
  for (const table of ['files', 'results']) {
    const rows = db.prepare(`SELECT stored_path FROM ${table} WHERE session_id = ?`).all(sessionId);
    for (const r of rows) { try { fs.unlinkSync(r.stored_path); } catch {} }
  }
  for (const dir of [path.join(config.dataDir, 'uploads', sessionId), path.join(config.dataDir, 'outputs', sessionId)]) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
  db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId); // cascades to child tables
}

/* ---------- files ---------- */
router.post('/sessions/:id/files', sessionAuth, expensiveLimit, upload.array('files', 5), (req, res) => {
  const uploaded = [];
  const errors = [];
  const incoming = req.files || [];
  if (!incoming.length) return res.status(400).json({ error: 'Файлы не переданы' });

  for (const f of incoming) {
    const originalName = sanitizeFilename(Buffer.from(f.originalname, 'latin1').toString('utf8'));
    const existing = db.prepare('SELECT size FROM files WHERE session_id = ?').all(req.session.id);
    const check = validateUpload({ originalName, buffer: f.buffer }, existing);
    if (!check.ok) { errors.push({ name: originalName, error: check.error }); continue; }

    const id = crypto.randomUUID();
    const dir = path.join(config.dataDir, 'uploads', req.session.id);
    fs.mkdirSync(dir, { recursive: true });
    const storedPath = path.join(dir, `${id}_${originalName}`);
    // path traversal guard: resolved path must stay inside the session dir
    if (!path.resolve(storedPath).startsWith(path.resolve(dir) + path.sep)) {
      errors.push({ name: originalName, error: 'Недопустимое имя файла' });
      continue;
    }
    fs.writeFileSync(storedPath, f.buffer);
    db.prepare('INSERT INTO files (id, session_id, original_name, stored_path, size, ext, mime, created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(id, req.session.id, originalName, storedPath, f.buffer.length, check.ext, f.mimetype || '', now());
    uploaded.push({ id, name: originalName, size: f.buffer.length, ext: check.ext });
  }
  if (uploaded.length) {
    pipeline.logEvent(req.session.id, 'Файлы загружены', uploaded.map((u) => u.name).join(', '));
  }
  const status = uploaded.length ? 200 : 400;
  res.status(status).json({ uploaded, errors });
});

router.delete('/sessions/:id/files/:fileId', sessionAuth, (req, res) => {
  const row = db.prepare('SELECT * FROM files WHERE id = ? AND session_id = ?').get(req.params.fileId, req.session.id);
  if (!row) return res.status(404).json({ error: 'Файл не найден' });
  try { fs.unlinkSync(row.stored_path); } catch {}
  db.prepare('DELETE FROM files WHERE id = ?').run(row.id);
  pipeline.logEvent(req.session.id, 'Файл удалён', row.original_name);
  res.json({ ok: true });
});

/* ---------- settings: нейросеть и база знаний ---------- */
router.post('/sessions/:id/settings', sessionAuth, express.json(), async (req, res, next) => {
  try {
    const { aiProvider, aiModel, kbChoice } = req.body || {};
    const updates = {};
    if (aiProvider !== undefined) {
      if (aiProvider === '') {
        updates.ai_provider = ''; updates.ai_model = '';
      } else {
        const check = await require('../services/providers').validateChoice(String(aiProvider), aiModel ? String(aiModel) : '');
        if (!check.ok) return res.status(400).json({ error: check.error });
        updates.ai_provider = String(aiProvider);
        updates.ai_model = aiModel ? String(aiModel) : '';
      }
    }
    if (kbChoice !== undefined) {
      if (!config.kbBases.some((b) => b.id === kbChoice)) {
        return res.status(400).json({ error: 'Неизвестная база знаний' });
      }
      updates.kb_choice = String(kbChoice);
    }
    if (!Object.keys(updates).length) return res.status(400).json({ error: 'Нет изменений' });
    const sets = Object.keys(updates).map((k) => `${k} = ?`).join(', ');
    db.prepare(`UPDATE sessions SET ${sets}, updated_at = ? WHERE id = ?`)
      .run(...Object.values(updates), now(), req.session.id);
    pipeline.logEvent(req.session.id, 'Настройки анализа изменены',
      [updates.ai_provider !== undefined ? `нейросеть: ${updates.ai_provider || 'по умолчанию'}${updates.ai_model ? ` (${updates.ai_model})` : ''}` : '',
       updates.kb_choice ? `база: ${updates.kb_choice}` : ''].filter(Boolean).join(', '));
    res.json({ ok: true });
  } catch (err) { next(err); }
});

/* ---------- comment / messages ---------- */
router.post('/sessions/:id/comment', sessionAuth, express.json(), (req, res) => {
  const text = String(req.body?.comment ?? '').slice(0, config.maxMessageLength);
  db.prepare('UPDATE sessions SET comment = ?, updated_at = ? WHERE id = ?').run(text, now(), req.session.id);
  if (text) pipeline.addMessage(req.session.id, 'user', 'comment', text);
  res.json({ ok: true });
});

router.post('/sessions/:id/messages', sessionAuth, expensiveLimit, express.json(), (req, res, next) => {
  const text = String(req.body?.text ?? '').trim();
  if (!text) return res.status(400).json({ error: 'Пустое сообщение' });
  if (text.length > config.maxMessageLength) {
    return res.status(400).json({ error: `Сообщение длиннее ${config.maxMessageLength} символов` });
  }
  pipeline.addMessage(req.session.id, 'user', 'chat', text);
  Promise.resolve(pipeline.startProcessing(req.session.id, { instruction: text })).then(
    () => res.status(202).json({ ok: true, jobStatus: 'queued' }),
    (err) => next(err),
  );
});

/* ---------- processing ---------- */
router.post('/sessions/:id/process', sessionAuth, expensiveLimit, express.json(), (req, res, next) => {
  Promise.resolve(pipeline.startProcessing(req.session.id, {})).then(
    () => res.status(202).json({ ok: true, jobStatus: 'queued' }),
    (err) => next(err),
  );
});

/* ---------- clarifying questions ---------- */
router.post('/sessions/:id/questions/:qid/answer', sessionAuth, expensiveLimit, express.json(), (req, res, next) => {
  const answer = String(req.body?.answer ?? '').trim();
  if (!answer) return res.status(400).json({ error: 'Пустой ответ' });
  if (answer.length > config.maxMessageLength) {
    return res.status(400).json({ error: `Ответ длиннее ${config.maxMessageLength} символов` });
  }
  const q = db.prepare('SELECT * FROM questions WHERE id = ? AND session_id = ?').get(req.params.qid, req.session.id);
  if (!q) return res.status(404).json({ error: 'Вопрос не найден' });
  db.prepare("UPDATE questions SET status = 'answered', answer = ?, answered_at = ? WHERE id = ?").run(answer, now(), q.id);
  pipeline.addMessage(req.session.id, 'user', 'answer', `${q.text} — ${answer}`);
  pipeline.logEvent(req.session.id, 'Получен ответ на уточняющий вопрос');

  const pending = db.prepare("SELECT COUNT(*) AS c FROM questions WHERE session_id = ? AND status = 'pending'").get(req.session.id).c;
  const continueNow = req.body?.continue !== false && pending === 0;
  if (continueNow) {
    Promise.resolve(pipeline.startProcessing(req.session.id, {
      instruction: 'Пользователь ответил на уточняющие вопросы (см. память сессии). Продолжи обработку с учётом ответов.',
    })).then(
      () => res.json({ ok: true, continued: true, pending }),
      (err) => next(err),
    );
  } else {
    res.json({ ok: true, continued: false, pending });
  }
});

/* ---------- results ---------- */
router.get('/sessions/:id/results', sessionAuth, (req, res) => {
  const results = db.prepare('SELECT id, filename, title, format, size, created_at FROM results WHERE session_id = ? ORDER BY created_at').all(req.session.id);
  res.json({ results });
});

router.get('/sessions/:id/results/:resultId/download', sessionAuth, (req, res) => {
  const row = db.prepare('SELECT * FROM results WHERE id = ? AND session_id = ?').get(req.params.resultId, req.session.id);
  if (!row) return res.status(404).json({ error: 'Файл не найден' });
  const base = path.resolve(config.dataDir, 'outputs', req.session.id);
  const resolved = path.resolve(row.stored_path);
  if (!resolved.startsWith(base + path.sep)) return res.status(403).json({ error: 'Доступ запрещён' });
  res.download(resolved, row.filename);
});

module.exports = { router, deleteSessionData };
