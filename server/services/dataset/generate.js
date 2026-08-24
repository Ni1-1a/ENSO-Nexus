'use strict';
/**
 * Генерация черновиков пар «вопрос → эталонный ответ».
 *
 * Правила (ТЗ модуля):
 *  - только элементы kind='text'; таблицы размечает человек — модели склонны
 *    сворачивать столбцы (замер 2026-08-20: YandexGPT свернул 6 столбцов в 3);
 *  - только элементы БЕЗ живых пар: у переиспользованного элемента пары уже
 *    есть, и дубли ему не нужны;
 *  - черновик получает status='draft' и prompt_version из настроек модуля;
 *  - непригодный ответ пару НЕ создаёт: элемент остаётся «без пары», причина
 *    уходит в лог. Ретрай один и только на транспортную ошибку — непригодный,
 *    но доехавший ответ повторным прогоном лучше не становится;
 *  - падение одного элемента не останавливает остальные.
 *
 * Вызов модели — ТОЛЬКО через adapter.structuredCall: свои HTTP-клиенты
 * модулю не положены. callFn подменяется в тестах.
 */
const config = require('../../config');
const store = require('./store');

const PAIR_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['question', 'answer'],
  properties: {
    question: { type: 'string', description: 'Вопрос по фрагменту, законченное предложение со знаком «?»' },
    answer: { type: 'string', description: 'Эталонный ответ по фрагменту, своими словами, не копия фрагмента' },
  },
};

const CONCURRENCY = 2; // LM Studio держит один слот — шире очередь только копит таймауты

// Подмена вызова модели для тестов: живой LM Studio в тестовом прогоне
// недопустима (минуты на загрузку весов и десятки гигабайт памяти).
let overrideCallFn = null;
function _setCallFn(fn) { overrideCallFn = fn; }

/**
 * Пригодность ответа модели. Возвращает null (пригоден) или причину строкой.
 * Условия — дословно из ТЗ модуля.
 */
function unfitReason(parsed, elementContent) {
  if (!parsed || typeof parsed !== 'object') return 'ответ не разобран в ожидаемую структуру';
  const q = typeof parsed.question === 'string' ? parsed.question.trim() : '';
  const a = typeof parsed.answer === 'string' ? parsed.answer.trim() : '';
  if (!q) return 'пустой вопрос';
  if (!a) return 'пустой ответ';
  if (!q.endsWith('?') && q.length < 10) return 'вопрос без знака «?» и короче 10 символов';
  if (store.normalizeText(a) === store.normalizeText(elementContent)) return 'ответ дословно повторяет текст элемента';
  return null;
}

/** Элементы документа, которым нужен черновик: текстовые и без живых пар. */
function targetsOf(documentId) {
  return store.db.prepare(`
    SELECT e.id, e.content FROM dataset_document_elements l
    JOIN dataset_elements e ON e.id = l.element_id
    WHERE l.document_id = ? AND e.kind = 'text'
      AND NOT EXISTS (SELECT 1 FROM dataset_pairs p WHERE p.element_id = e.id AND p.deleted_at IS NULL)
    ORDER BY l.order_index`).all(documentId);
}

/**
 * Черновики для всех подходящих элементов документа.
 * @returns {{created:number, unfit:number, failed:number, total:number}}
 */
async function generateForDocument(documentId, { callFn = null, onProgress = () => {}, signal = null } = {}) {
  const adapter = require('../claude/adapter');
  const call = callFn || overrideCallFn || adapter.structuredCall;
  const doc = store.docById(documentId);
  if (!doc) throw store.httpError(404, 'Документ не найден');
  const settings = store.settingsGet();
  if (!settings.gen_prompt.trim()) throw store.httpError(500, 'Промпт генерации пуст — заполните его в настройках модуля');
  const route = { provider: settings.ai_provider, model: settings.ai_model };
  const sessionId = require('./ingest').ensureServiceSession(doc, null);

  const targets = targetsOf(documentId);
  const stats = { created: 0, unfit: 0, failed: 0, total: targets.length };
  let cursor = 0;

  const worker = async () => {
    for (;;) {
      if (signal && signal.aborted) return;
      const idx = cursor++;
      if (idx >= targets.length) return;
      const target = targets[idx];
      onProgress(`черновики пар: ${Math.min(idx + 1, targets.length)} из ${targets.length}`);
      let out = null;
      // один ретрай — только на упавший вызов (таймаут, обрыв), по ТЗ модуля
      for (let attempt = 1; attempt <= 2 && !out; attempt++) {
        try {
          out = await call({
            system: settings.gen_prompt,
            messages: [{ role: 'user', content: target.content }],
            sessionId, route, signal,
            schema: PAIR_SCHEMA,
            schemaName: 'dataset_pair',
            maxTokens: config.localAiMaxTokens,
          });
        } catch (err) {
          if (signal && signal.aborted) return;
          if (attempt === 2) {
            stats.failed++;
            console.warn(`[dataset] генерация пары не удалась (элемент ${target.id}): ${err.message}`);
          }
        }
      }
      if (!out) continue;
      const parsed = adapter.tryParse(out.text || '');
      const reason = unfitReason(parsed, target.content);
      if (reason) {
        // пара не создаётся, элемент остаётся no_pairs — это видно в списке
        stats.unfit++;
        console.warn(`[dataset] непригодный ответ модели (элемент ${target.id}): ${reason}`);
        continue;
      }
      try {
        store.createPair({
          elementId: target.id,
          question: parsed.question,
          answer: parsed.answer,
          origin: 'auto',
          promptVersion: settings.gen_prompt_version,
          actor: `auto:${route.model || route.provider}`,
        });
        stats.created++;
      } catch (err) {
        stats.failed++;
        console.warn(`[dataset] черновик не сохранён (элемент ${target.id}): ${err.message}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, targets.length || 1) }, worker));
  return stats;
}

module.exports = { generateForDocument, unfitReason, targetsOf, PAIR_SCHEMA, _setCallFn };
