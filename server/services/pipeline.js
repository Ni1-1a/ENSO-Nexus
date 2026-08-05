'use strict';
const crypto = require('crypto');
const config = require('../config');
const { db, now } = require('../db');
const adapter = require('./claude/adapter');
const { materializeOutputs } = require('./outputs');
const busyFlag = require('./busy-flag');
const progress = require('./progress');

const runningJobs = new Set();
/** sessionId → AbortController выполняющейся задачи (для «Прервать обработку»). */
const jobAborts = new Map();

/** Прерывает выполняющуюся задачу сессии. Возвращает false, если прерывать нечего. */
function cancelJob(sessionId) {
  const controller = jobAborts.get(sessionId);
  if (!controller) return false;
  logEvent(sessionId, 'Получена команда «Прервать обработку»', '', 'warn');
  controller.abort();
  return true;
}

function isAbort(err, signal) {
  return (signal && signal.aborted) || (err && (err.name === 'AbortError' || err.code === 'ABORT_ERR'));
}

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
  const controller = new AbortController();
  jobAborts.set(sessionId, controller);
  setJobStatus(sessionId, 'queued');
  logEvent(sessionId, 'Задача поставлена в очередь');

  runJob(sessionId, instruction, controller.signal).catch((err) => {
    console.error('[pipeline] unexpected error:', err);
  });
}

async function runJob(sessionId, instruction, signal) {
  busyFlag.acquire(); // OCR-очередь базы знаний приостанавливается, пока идёт анализ
  try {
    setJobStatus(sessionId, 'running');
    logEvent(sessionId, 'Проверка исходных данных');
    logEvent(sessionId, `Выполняется анализ (${config.aiMode === 'mock' ? 'демо-режим' : 'AI-модель'})`);

    const result = await adapter.runAnalysis(sessionId, {
      instruction: instruction ||
        'Проанализируй загруженные материалы по методике 12 шагов. Извлеки факты, определи ограничения, ' +
        'при нехватке данных задай уточняющие вопросы, при достаточности данных сформируй итоговый отчёт.',
      signal,
    });

    applyModelResult(sessionId, result);

    if (result.status === 'needs_clarification') {
      logEvent(sessionId, 'Требуется уточнение', `${result.questions.length} вопрос(ов)`);
      setJobStatus(sessionId, 'needs_clarification');
    } else if (result.status === 'completed') {
      logEvent(sessionId, 'Формируются выходные документы');
      progress.set(sessionId, { phase: 'saving', label: 'Формирование выходных документов…' });
      const files = await materializeOutputs(sessionId, result);
      logEvent(sessionId, 'Задача завершена', `Сформировано файлов: ${files.length}`);
      setJobStatus(sessionId, 'completed');
    } else {
      logEvent(sessionId, 'Анализ невозможен', result.message.slice(0, 300), 'warn');
      setJobStatus(sessionId, 'failed');
    }

    await adapter.maybeCompact(sessionId);
  } catch (err) {
    if (isAbort(err, signal)) {
      logEvent(sessionId, 'Обработка прервана', 'по команде пользователя', 'warn');
      addMessage(sessionId, 'assistant', 'error',
        'Обработка прервана по вашей команде. Данные сессии сохранены — можно запустить анализ заново.');
      setJobStatus(sessionId, 'failed');
    } else {
      const userMessage = (err instanceof adapter.BudgetExceededError || err instanceof adapter.AiUnavailableError)
        ? err.message
        : 'Внутренняя ошибка обработки. Данные сессии сохранены — повторите попытку.';
      logEvent(sessionId, 'Произошла ошибка', userMessage, 'error');
      addMessage(sessionId, 'assistant', 'error', userMessage);
      setJobStatus(sessionId, 'failed');
      if (!(err instanceof adapter.BudgetExceededError || err instanceof adapter.AiUnavailableError)) {
        console.error('[pipeline]', err); // full stack goes to server logs only
      }
    }
  } finally {
    runningJobs.delete(sessionId);
    jobAborts.delete(sessionId);
    progress.clear(sessionId);
    busyFlag.release();
  }
}

/* ---------------- сравнение моделей ---------------- */

function fmtRoute(r) { return r.model ? `${r.provider}: ${r.model}` : r.provider; }

/**
 * Сравнительный прогон: один и тот же анализ выполняется каждой из выбранных
 * моделей ПОСЛЕДОВАТЕЛЬНО (локальные модели делят один LM Studio), результаты
 * не изменяют факты/вопросы сессии — формируется файл сравнения и сводка в чат.
 */
async function startComparison(sessionId, routes, instruction) {
  const session = db.prepare("SELECT * FROM sessions WHERE id = ? AND status = 'active'").get(sessionId);
  if (!session) throw Object.assign(new Error('Сессия не найдена'), { status: 404 });
  if (runningJobs.has(sessionId)) throw Object.assign(new Error('Обработка уже выполняется'), { status: 409 });
  if (runningJobs.size >= config.maxConcurrentJobs) {
    throw Object.assign(new Error('Сервер занят: превышен лимит одновременных задач.'), { status: 429 });
  }
  const filesCount = db.prepare('SELECT COUNT(*) AS c FROM files WHERE session_id = ?').get(sessionId).c;
  if (filesCount === 0) throw Object.assign(new Error('Сначала загрузите хотя бы один файл исходных данных'), { status: 400 });

  runningJobs.add(sessionId);
  const controller = new AbortController();
  jobAborts.set(sessionId, controller);
  setJobStatus(sessionId, 'queued');
  logEvent(sessionId, 'Сравнение моделей поставлено в очередь', routes.map(fmtRoute).join(' · '));
  runComparison(sessionId, routes, instruction, controller.signal).catch((err) => console.error('[compare]', err));
}

async function runComparison(sessionId, routes, instruction, signal) {
  busyFlag.acquire();
  const adapter2 = require('./claude/adapter');
  const { saveResult } = require('./outputs');
  const task = instruction ||
    'Проанализируй загруженные материалы по методике 12 шагов: извлеки факты, определи ограничения, ' +
    'сформируй краткий отчёт. Если данных не хватает — перечисли вопросы, но всё равно верни status=completed с тем, что удалось установить.';
  const runs = [];
  let aborted = false;
  try {
    setJobStatus(sessionId, 'running');
    for (let i = 0; i < routes.length; i++) {
      const route = routes[i];
      logEvent(sessionId, `Сравнение: модель ${i + 1}/${routes.length}`, fmtRoute(route));
      const before = db.prepare('SELECT input_tokens + output_tokens AS t FROM sessions WHERE id = ?').get(sessionId).t;
      const t0 = Date.now();
      try {
        const result = await adapter2.analyzeOnce(sessionId, { instruction: task, route, signal });
        const tokens = db.prepare('SELECT input_tokens + output_tokens AS t FROM sessions WHERE id = ?').get(sessionId).t - before;
        runs.push({ route, ok: true, result, seconds: Math.round((Date.now() - t0) / 1000), tokens });
        logEvent(sessionId, `Сравнение: ${fmtRoute(route)} — готово`, `${runs[i].seconds} с`);
      } catch (err) {
        if (isAbort(err, signal)) {
          aborted = true;
          logEvent(sessionId, 'Сравнение прервано', 'по команде пользователя', 'warn');
          break;
        }
        runs.push({ route, ok: false, error: err.message, seconds: Math.round((Date.now() - t0) / 1000), tokens: 0 });
        logEvent(sessionId, `Сравнение: ${fmtRoute(route)} — ошибка`, err.message, 'warn');
      }
    }

    if (aborted) {
      if (runs.length) {
        saveResult(sessionId, 'СРАВНЕНИЕ-МОДЕЛЕЙ.md', 'Сравнительный прогон моделей (прерван)', 'md',
          buildComparisonMd(runs, task) + '\n\n---\n\n**Сравнение прервано пользователем** — выполнено ' +
          `${runs.length} из ${routes.length} моделей.`);
      }
      addMessage(sessionId, 'assistant', 'error',
        `Сравнение прервано по вашей команде. Успело выполниться: ${runs.length} из ${routes.length} моделей.`);
      setJobStatus(sessionId, 'failed');
      return;
    }

    const md = buildComparisonMd(runs, task);
    saveResult(sessionId, 'СРАВНЕНИЕ-МОДЕЛЕЙ.md', 'Сравнительный прогон моделей', 'md', md);

    const okRuns = runs.filter((r) => r.ok);
    const summary = ['## Сравнение моделей завершено', '',
      '| Модель | Статус | Время | Токены | Фактов | Вопросов |', '|---|---|---|---|---|---|',
      ...runs.map((r) => r.ok
        ? `| ${fmtRoute(r.route)} | ${r.result.status} | ${r.seconds} с | ${r.tokens} | ${r.result.facts.length} | ${r.result.questions.length} |`
        : `| ${fmtRoute(r.route)} | ошибка | ${r.seconds} с | — | — | — |`),
      '', okRuns.length ? 'Полные ответы каждой модели — в файле **СРАВНЕНИЕ-МОДЕЛЕЙ.md** (блок «Результаты»).' : 'Ни одна модель не ответила успешно.',
    ].join('\n');
    addMessage(sessionId, 'assistant', 'result', summary);
    logEvent(sessionId, 'Сравнение завершено', `успешно: ${okRuns.length}/${routes.length}`);
    setJobStatus(sessionId, okRuns.length ? 'completed' : 'failed');
  } catch (err) {
    logEvent(sessionId, 'Произошла ошибка сравнения', err.message, 'error');
    setJobStatus(sessionId, 'failed');
  } finally {
    runningJobs.delete(sessionId);
    jobAborts.delete(sessionId);
    progress.clear(sessionId);
    busyFlag.release();
  }
}

function buildComparisonMd(runs, task) {
  const parts = ['# Сравнительный прогон моделей', '', `Задание: ${task}`, '', 'Дата: ' + now(), '',
    '| Модель | Статус | Время | Токены | Фактов | Вопросов | Предупреждений |', '|---|---|---|---|---|---|---|',
    ...runs.map((r) => r.ok
      ? `| ${fmtRoute(r.route)} | ${r.result.status} | ${r.seconds} с | ${r.tokens} | ${r.result.facts.length} | ${r.result.questions.length} | ${r.result.warnings.length} |`
      : `| ${fmtRoute(r.route)} | ОШИБКА: ${r.error} | ${r.seconds} с | — | — | — | — |`)];
  for (const r of runs) {
    parts.push('', '---', '', `## ${fmtRoute(r.route)}`);
    if (!r.ok) { parts.push('', `Ошибка: ${r.error}`); continue; }
    parts.push('', `**Статус:** ${r.result.status}`, '', '### Ответ', '', r.result.message);
    if (r.result.questions.length) parts.push('', '### Вопросы', ...r.result.questions.map((q) => `- ${q.text}`));
    if (r.result.facts.length) parts.push('', '### Факты', ...r.result.facts.map((f) => `- ${f.key} = ${f.value} (${f.source})`));
    if (r.result.tep.length) parts.push('', '### ТЭП', ...r.result.tep.map((t) => `- ${t.name}: ${t.value} ${t.unit}`));
    if (r.result.report_markdown) parts.push('', '### Отчёт', '', r.result.report_markdown);
  }
  return parts.join('\n');
}

module.exports = { startProcessing, startComparison, cancelJob, logEvent, addMessage, runningJobs };
