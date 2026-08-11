'use strict';
/**
 * Очередь геометрических расчётов, отдельная от очереди AI-задач (ТЗ, п. 76).
 *
 * Две очереди, а не одна, по простой причине: долгая генерация вариантов не должна
 * занимать слот у чата, а чат не должен мешать расчёту. Разные ресурсы — разные
 * лимиты: AI упирается в модель, геометрия в процессор.
 *
 * Поток создаётся на задачу и умирает вместе с ней. Пул с переиспользованием
 * сложнее и здесь не окупается: запуск потока ~30 мс против секунд самого расчёта.
 */
const path = require('path');
const os = require('os');

const WORKER = path.join(__dirname, 'worker.js');
const MAX_PARALLEL = Math.max(1, Math.min(4, (os.cpus() || { length: 4 }).length - 2));
const TASK_TIMEOUT_MS = 5 * 60 * 1000;

let running = 0;
const waiting = [];
let seq = 0;

function pump() {
  while (running < MAX_PARALLEL && waiting.length) {
    const job = waiting.shift();
    running++;
    execute(job).finally(() => { running--; pump(); });
  }
}

function execute({ task, payload, resolve, reject, signal }) {
  return new Promise((done) => {
    const { Worker } = require('worker_threads');
    const id = ++seq;
    let worker;
    let finished = false;

    const finish = (fn, arg) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (worker) worker.terminate().catch(() => {});
      fn(arg);
      done();
    };

    const timer = setTimeout(
      () => finish(reject, new Error(`Геометрический расчёт «${task}» не уложился в ${TASK_TIMEOUT_MS / 60000} мин`)),
      TASK_TIMEOUT_MS,
    );

    if (signal) {
      if (signal.aborted) return finish(reject, Object.assign(new Error('Расчёт прерван'), { name: 'AbortError' }));
      signal.addEventListener('abort', () => finish(reject, Object.assign(new Error('Расчёт прерван'), { name: 'AbortError' })), { once: true });
    }

    try {
      worker = new Worker(WORKER);
    } catch (err) {
      return finish(reject, err);
    }
    worker.on('message', (msg) => {
      if (!msg || msg.id !== id) return;
      if (msg.ok) finish(resolve, msg.result);
      else finish(reject, new Error(msg.error));
    });
    worker.on('error', (err) => finish(reject, err));
    worker.on('exit', (code) => {
      if (!finished && code !== 0) finish(reject, new Error(`Поток геометрии завершился с кодом ${code}`));
    });
    worker.postMessage({ id, task, payload });
  });
}

/**
 * Поставить задачу в очередь геометрии.
 * @param {string} task     'placement' | 'restrictions'
 * @param {object} payload  простые данные (клонируются в поток)
 * @param {object} opts     {signal}
 */
function run(task, payload, { signal = null } = {}) {
  return new Promise((resolve, reject) => {
    waiting.push({ task, payload, resolve, reject, signal });
    pump();
  });
}

/** Состояние очереди — для журнала и диагностики. */
function stats() {
  return { выполняется: running, вОчереди: waiting.length, лимит: MAX_PARALLEL };
}

module.exports = { run, stats, MAX_PARALLEL };
