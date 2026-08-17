'use strict';
/**
 * Сколько прогонов сейчас в очереди или выполняется — печатает одно число.
 *
 * Нужен скриптам остановки и перезапуска: они прерывают идущий анализ, и
 * спросить об этом надо ДО того, как процесс убит. Тот же запрос делает
 * «Перезапустить сервер.command» на маке.
 *
 * Запускать из корня проекта:  node --env-file-if-exists=.env win\scripts\busy-count.js
 */
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data');
try {
  const db = new DatabaseSync(path.join(dataDir, 'app.db'), { readOnly: true });
  const row = db.prepare("SELECT COUNT(*) c FROM sessions WHERE job_status IN ('queued','running')").get();
  console.log(row ? row.c : 0);
} catch {
  console.log(0); // базы нет или занята — считаем, что прерывать нечего
}
