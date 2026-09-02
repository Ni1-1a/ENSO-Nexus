'use strict';
/*
 * fetch для обращений к моделям. У встроенного fetch Node есть СВОЙ лимит
 * ожидания заголовков ответа — 300 с (undici headersTimeout), и он срабатывает
 * независимо от нашего AbortSignal.timeout: платформа готова ждать облако
 * 30 минут, а undici рвёт соединение на пятой с UND_ERR_HEADERS_TIMEOUT.
 * Размышляющая kimi-k3 на тяжёлом запросе молчит до первого байта дольше
 * пяти минут (в журнале шлюза — успешные ответы по 7–12 минут), локальный
 * OCR без стрима тоже бывает медленнее (замер 385 с на vl-8b). Деньги при
 * таком обрыве уже потрачены: провайдер ответ довозит, но его никто не ждёт.
 *
 * Здесь оба встроенных таймаута выключены; единственный лимит времени —
 * AbortSignal вызывающего кода, поэтому он обязателен.
 */
const { fetch: undiciFetch, Agent } = require('undici');

const patientDispatcher = new Agent({ headersTimeout: 0, bodyTimeout: 0 });

function patientFetch(url, init = {}) {
  if (!init.signal) throw new Error('patientFetch: нужен signal — без него запрос вообще без таймаута');
  return undiciFetch(url, { ...init, dispatcher: patientDispatcher });
}

module.exports = { patientFetch };
