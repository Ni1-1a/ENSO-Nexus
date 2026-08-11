'use strict';
/**
 * Safe mock mode — used ONLY when ANTHROPIC_API_KEY is absent.
 * Every mock answer is explicitly labeled as demo output; it never
 * pretends to be a real normative analysis.
 */
const { db } = require('../../db');

const MOCK_NOTICE = '⚠️ **Демонстрационный режим.** AI-ключ не настроен на сервере, ответ сформирован тестовой заглушкой и НЕ является реальным анализом документов.';

function runAnalysis(sessionId, ctx, instruction) {
  const files = db.prepare('SELECT original_name, ext, size FROM files WHERE session_id = ?').all(sessionId);
  const answered = db.prepare("SELECT COUNT(*) AS c FROM questions WHERE session_id = ? AND status = 'answered'").get(sessionId).c;
  const pending = db.prepare("SELECT COUNT(*) AS c FROM questions WHERE session_id = ? AND status = 'pending'").get(sessionId).c;
  const closed = db.prepare("SELECT COUNT(*) AS c FROM questions WHERE session_id = ? AND status = 'closed'").get(sessionId).c;

  // First run: ask a clarifying question. After an answer (or skip) arrives: complete.
  if (answered === 0 && pending === 0 && closed === 0) {
    return {
      status: 'needs_clarification',
      message: `${MOCK_NOTICE}\n\nПолучено файлов: ${files.length}. Для продолжения демонстрационного сценария ответьте на уточняющий вопрос.`,
      questions: [
        { text: 'Укажите требуемую этажность здания и площадь застройки (м²).', why: 'Демо-вопрос: в реальном режиме эти параметры блокируют шаг 8 (посадка здания).', options: ['2 этажа, ~800 м²', '3 этажа, ~1200 м²', '5 этажей, ~2000 м²'] },
      ],
      facts: files.map((f, i) => ({ key: `demo.file.${i + 1}`, value: `${f.original_name} (${Math.round(f.size / 1024)} КБ)`, source: 'метаданные загрузки' })),
      warnings: ['Демо-режим: содержимое документов не анализировалось.'],
      conflicts: [], assumptions: [], report_markdown: '', geometry: [], tep: [],
    };
  }
  if (pending > 0) {
    return {
      status: 'needs_clarification',
      message: `${MOCK_NOTICE}\n\nЕсть неотвеченные вопросы — ответьте на них, чтобы продолжить.`,
      questions: [], facts: [], warnings: [], conflicts: [], assumptions: [], report_markdown: '', geometry: [], tep: [],
    };
  }
  const answers = db.prepare("SELECT text, answer FROM questions WHERE session_id = ? AND status = 'answered'").all(sessionId);
  return {
    status: 'completed',
    message: `${MOCK_NOTICE}\n\nДемонстрационный прогон завершён: сформирован тестовый отчёт и эскизный DXF. В боевом режиме здесь будет полный анализ исходных данных с нормативными ссылками.`,
    questions: [],
    facts: [{ key: 'demo.answer', value: answers.map((a) => a.answer).join('; ').slice(0, 300), source: 'ответ пользователя' }],
    warnings: ['Демо-режим: все числа в отчёте условные.'],
    conflicts: [],
    assumptions: ['Демо-режим: анализ документов не выполнялся.'],
    report_markdown: [
      '# ОТЧЁТ (демонстрационный режим)',
      '', MOCK_NOTICE, '',
      '## Исходные данные',
      ...files.map((f) => `- ${f.original_name}`),
      '', '## Ответы пользователя',
      ...answers.map((a) => `- ${a.text} — **${a.answer}**`),
      '', '## Что было бы дальше',
      'В боевом режиме сервис выполняет полный разбор исходных данных и формирует отчёт с ТЭП и нормативными ссылками.',
    ].join('\n'),
    geometry: [
      { layer: 'AI_ГРАНИЦЫ_ЗУ', color: 3, closed: true, points: [[0, 0], [120, 0], [95, 85], [0, 60]] },
      { layer: 'AI_ПЯТНО_ЗАСТРОЙКИ', color: 1, closed: true, points: [[15, 12], [85, 12], [70, 55], [15, 45]] },
    ],
    tep: [
      { name: 'Площадь участка (демо)', value: '3700', unit: 'м²' },
      { name: 'Пятно застройки (демо)', value: '1400', unit: 'м²' },
    ],
  };
}

function summarize(ctx) {
  return `Демо-резюме (${new Date().toISOString()}): в сессии ${ctx.messagesTotal} сообщений. ` +
    'Полная история хранится в базе данных.';
}

module.exports = { runAnalysis, summarize, MOCK_NOTICE };
