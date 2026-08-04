'use strict';
const crypto = require('crypto');
const config = require('../config');
const { db, now } = require('../db');
const adapter = require('./claude/adapter');
const { materializeOutputs } = require('./outputs');

const runningJobs = new Set();

function logEvent(sessionId, stage, detail = '', level = 'info') {
  db.prepare('INSERT INTO events (session_id, stage, detail, level, created_at) VALUES (?,?,?,?,?)')
    .run(sessionId, stage, detail, level, now());
}

function setJobStatus(sessionId, status) {
  db.prepare('UPDATE sessions SET job_status = ?, updated_at = ? WHERE id = ?').run(status, now(), sessionId);
}

function addMessage(sessionId, role, kind, content) {
  db.prepare('INSERT INTO messages (id, session_id, role, kind, content, created_at) VALUES (?,?,?,?,?,?)')
    .run(crypto.randomUUID(), sessionId, role, kind, content, now());
}

function applyModelResult(sessionId, result) {
  for (const f of result.facts) {
    db.prepare(
      'INSERT INTO facts (id, session_id, key, value, source, created_at) VALUES (?,?,?,?,?,?) ' +
      'ON CONFLICT(session_id, key) DO UPDATE SET value = excluded.value, source = excluded.source',
    ).run(crypto.randomUUID(), sessionId, f.key, f.value, f.source, now());
  }
  for (const q of result.questions) {
    const dup = db.prepare('SELECT id FROM questions WHERE session_id = ? AND text = ?').get(sessionId, q.text);
    if (!dup) {
      db.prepare('INSERT INTO questions (id, session_id, text, why, status, created_at) VALUES (?,?,?,?,?,?)')
        .run(crypto.randomUUID(), sessionId, q.text, q.why, 'pending', now());
    }
  }
  addMessage(sessionId, 'assistant', 'result', result.message);
}

/**
 * Async processing job. Statuses are real: every stage is written to the events
 * log before/after the actual work happens.
 */
async function startProcessing(sessionId, { instruction }) {
  const session = db.prepare("SELECT * FROM sessions WHERE id = ? AND status = 'active'").get(sessionId);
  if (!session) throw Object.assign(new Error('Сессия не найдена'), { status: 404 });
  if (runningJobs.has(sessionId)) {
    throw Object.assign(new Error('Обработка уже выполняется'), { status: 409 });
  }
  if (runningJobs.size >= config.maxConcurrentJobs) {
    throw Object.assign(new Error('Сервер занят: превышен лимит одновременных задач. Повторите через минуту.'), { status: 429 });
  }
  const filesCount = db.prepare('SELECT COUNT(*) AS c FROM files WHERE session_id = ?').get(sessionId).c;
  if (filesCount === 0) {
    throw Object.assign(new Error('Сначала загрузите хотя бы один файл исходных данных'), { status: 400 });
  }

  runningJobs.add(sessionId);
  setJobStatus(sessionId, 'queued');
  logEvent(sessionId, 'Задача поставлена в очередь');

  runJob(sessionId, instruction).catch((err) => {
    console.error('[pipeline] unexpected error:', err);
  });
}

async function runJob(sessionId, instruction) {
  try {
    setJobStatus(sessionId, 'running');
    logEvent(sessionId, 'Проверка исходных данных');
    logEvent(sessionId, `Выполняется анализ (${config.aiMode === 'mock' ? 'демо-режим' : 'AI-модель'})`);

    const result = await adapter.runAnalysis(sessionId, {
      instruction: instruction ||
        'Проанализируй загруженные материалы по методике 12 шагов. Извлеки факты, определи ограничения, ' +
        'при нехватке данных задай уточняющие вопросы, при достаточности данных сформируй итоговый отчёт.',
    });

    applyModelResult(sessionId, result);

    if (result.status === 'needs_clarification') {
      logEvent(sessionId, 'Требуется уточнение', `${result.questions.length} вопрос(ов)`);
      setJobStatus(sessionId, 'needs_clarification');
    } else if (result.status === 'completed') {
      logEvent(sessionId, 'Формируются выходные документы');
      const files = await materializeOutputs(sessionId, result);
      logEvent(sessionId, 'Задача завершена', `Сформировано файлов: ${files.length}`);
      setJobStatus(sessionId, 'completed');
    } else {
      logEvent(sessionId, 'Анализ невозможен', result.message.slice(0, 300), 'warn');
      setJobStatus(sessionId, 'failed');
    }

    await adapter.maybeCompact(sessionId);
  } catch (err) {
    const userMessage = (err instanceof adapter.BudgetExceededError || err instanceof adapter.AiUnavailableError)
      ? err.message
      : 'Внутренняя ошибка обработки. Данные сессии сохранены — повторите попытку.';
    logEvent(sessionId, 'Произошла ошибка', userMessage, 'error');
    addMessage(sessionId, 'assistant', 'error', userMessage);
    setJobStatus(sessionId, 'failed');
    if (!(err instanceof adapter.BudgetExceededError || err instanceof adapter.AiUnavailableError)) {
      console.error('[pipeline]', err); // full stack goes to server logs only
    }
  } finally {
    runningJobs.delete(sessionId);
  }
}

module.exports = { startProcessing, logEvent, addMessage, runningJobs };
