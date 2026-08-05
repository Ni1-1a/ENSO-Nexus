'use strict';
/**
 * Флаг «идёт интерактивный анализ» для фоновых задач (OCR-очередь базы знаний).
 * Пока файл существует и свежий (< 2 мин), очередь OCR приостанавливается между
 * страницами и не конкурирует с пользователем за LM Studio.
 */
const fs = require('fs');
const path = require('path');

const FLAG_PATH = path.join(__dirname, '..', '..', 'logs', 'interactive.lock');
const TOUCH_INTERVAL_MS = 30000;

let holders = 0;
let timer = null;

function touch() {
  try {
    fs.mkdirSync(path.dirname(FLAG_PATH), { recursive: true });
    fs.writeFileSync(FLAG_PATH, String(process.pid));
  } catch { /* не критично */ }
}

function acquire() {
  holders++;
  touch();
  if (!timer) {
    timer = setInterval(touch, TOUCH_INTERVAL_MS);
    timer.unref();
  }
}

function release() {
  holders = Math.max(0, holders - 1);
  if (holders === 0) {
    if (timer) { clearInterval(timer); timer = null; }
    try { fs.unlinkSync(FLAG_PATH); } catch { /* уже удалён */ }
  }
}

module.exports = { acquire, release, FLAG_PATH };
