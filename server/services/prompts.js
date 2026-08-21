'use strict';
/**
 * Тексты промтов живут в `prompts/*.md`, а не в коде.
 *
 * Правило простое: в файле лежит ТОЛЬКО текст, который уходит модели, слово в
 * слово. Никаких заголовков «что это за файл» — они уехали бы в промт вместе с
 * остальным. Пояснения, какой файл где применяется, — в `prompts/README.md`.
 *
 * Файл перечитывается, когда у него изменились время правки или размер: правка
 * промта применяется к следующему прогону без перезапуска сервера. Это ровно тот
 * сценарий, ради которого промты и вынесены — человек правит формулировку и
 * сразу проверяет её на живой сессии.
 *
 * Подстановки пишутся как {{имя}} и передаются вторым аргументом. Промт без
 * подстановок читается как есть.
 */
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', '..', 'prompts');

/** имя → { text, mtimeMs, size } */
const cache = new Map();

function file(name) {
  return path.join(DIR, `${name}.md`);
}

/**
 * Текст промта. Отсутствующий или пустой файл — это остановка с внятной
 * причиной, а не молчаливый пустой system: молча уехавший промт превращает
 * анализ в свободную болтовню модели, и по результату этого не видно.
 */
function load(name, vars = null) {
  const filePath = file(name);
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    throw new Error(`Промт не найден: prompts/${name}.md`);
  }

  const hit = cache.get(name);
  let text;
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) {
    text = hit.text;
  } else {
    text = fs.readFileSync(filePath, 'utf8').trim();
    if (!text) throw new Error(`Промт пуст: prompts/${name}.md`);
    cache.set(name, { text, mtimeMs: stat.mtimeMs, size: stat.size });
  }

  if (!vars) return text;
  return text.replace(/\{\{(\w+)\}\}/g, (whole, key) =>
    (Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : whole));
}

/** Все промты проекта: имена без расширения, включая `tasks/…`. */
function names() {
  const out = [];
  const walk = (dir, prefix) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isDirectory()) walk(path.join(dir, entry.name), `${prefix}${entry.name}/`);
      else if (entry.name.endsWith('.md') && entry.name !== 'README.md') out.push(prefix + entry.name.slice(0, -3));
    }
  };
  walk(DIR, '');
  return out;
}

module.exports = { load, names, DIR };
