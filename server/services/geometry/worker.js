'use strict';
/**
 * Рабочий поток геометрии. Здесь исполняются задачи, которые считаются секундами:
 * перебор пятен застройки, булевы операции над сотнями полигонов.
 *
 * Node однопоточный, и такой расчёт в основном потоке останавливает весь HTTP —
 * пользователь видит зависший интерфейс, хотя «просто считаются варианты».
 */
const { parentPort } = require('worker_threads');

/**
 * Предупреждения обязаны ВОЗВРАЩАТЬСЯ, а не оседать в site.
 *
 * payload уезжает в поток структурным клонированием: движок мутирует свою копию
 * site, и всё, что он туда дописал, умирает вместе с потоком. Так молча пропадало
 * «уточнение не совпало ни с одним слоем» — зона строилась от чужого объекта,
 * и по ней потом сажали здание. Поэтому наружу отдаётся и то, что движок вернул
 * сам, и то, что он успел добавить в свою копию site.
 */
function runWithWarnings(site, fn) {
  const G = require('./site-geometry');
  const before = ((site && site.warnings) || []).length;
  const result = fn();
  const added = ((site && site.warnings) || []).slice(before);
  return { ...result, warnings: G.mergeWarnings([...(result.warnings || [])], added) };
}

const TASKS = {
  /** Генерация кандидатов посадки. */
  placement({ site, buildable, requirements, options }) {
    return runWithWarnings(site, () =>
      require('./placement-engine').generate(site, buildable, requirements, options || {}));
  },
  /** Построение зон ограничений по готовым правилам. */
  restrictions({ site, rules }) {
    return runWithWarnings(site, () => require('./restriction-engine').build(site, rules));
  },
};

parentPort.on('message', (msg) => {
  const { id, task, payload } = msg || {};
  try {
    const fn = TASKS[task];
    if (!fn) throw new Error(`Неизвестная задача геометрии: ${task}`);
    parentPort.postMessage({ id, ok: true, result: fn(payload) });
  } catch (err) {
    parentPort.postMessage({ id, ok: false, error: String((err && err.message) || err) });
  }
});
