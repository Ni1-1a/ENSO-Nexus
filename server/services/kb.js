'use strict';
/**
 * Нормативная база знаний (RAG).
 *
 * Источники (KB_DIR = ENSO-Nexus/Knowledge-Base):
 *  - 09_Векторный-индекс/<Документ>/чанки.jsonl — готовые чанки {документ, пункт, текст, приоритет};
 *  - 04_JSON/<Документ>/пункты.json — фолбэк для документов с пустыми чанками: {номер, уровень, текст}.
 *
 * Индекс: таблица kb_chunks в основной SQLite, эмбеддинги — LM Studio /v1/embeddings.
 * Поиск: косинус по памяти (Float32Array). Без эмбеддингов — деградация до поиска по словам.
 */
const fs = require('fs');
const path = require('path');
const config = require('../config');
const { db, now } = require('../db');

db.exec(`
CREATE TABLE IF NOT EXISTS kb_chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc TEXT NOT NULL,
  clause TEXT DEFAULT '',
  text TEXT NOT NULL,
  priority TEXT DEFAULT '',
  embedding BLOB
);
CREATE TABLE IF NOT EXISTS kb_meta (key TEXT PRIMARY KEY, value TEXT);
`);
try { db.exec("ALTER TABLE kb_chunks ADD COLUMN kb TEXT DEFAULT 'main'"); } catch { /* уже есть */ }

const MAX_CHUNK_CHARS = 1400;
const MIN_CHUNK_CHARS = 80;

/**
 * Длинный чанк делим, а не обрезаем.
 *
 * Обрезка молча уносит хвост, и это опаснее, чем кажется: в нормативной таблице
 * последняя строка — такое же требование, как первая, а чаще всего нужна именно
 * она («V степень огнестойкости» стоит внизу). Остальные ветки загрузки чанков
 * давно делят по кускам; структурированная почему-то одна обрезала.
 *
 * У таблицы делим по строкам и повторяем шапку в каждом куске: кусок таблицы
 * без шапки — это столбик чисел без смысла.
 */
function splitChunk(text) {
  if (text.length <= MAX_CHUNK_CHARS) return [text];
  const lines = text.split('\n');
  const tableLines = lines.filter((l) => l.trim().startsWith('|'));
  const header = tableLines.length >= 2 ? tableLines[0] : null;
  const pieces = [];
  let current = [];
  let length = 0;
  const start = () => {
    current = pieces.length && header ? [header] : [];
    length = current.length ? header.length + 1 : 0;
  };
  const flush = () => { if (current.length) { pieces.push(current.join('\n')); start(); } };
  start();
  for (const line of lines) {
    if (line.length + 1 > MAX_CHUNK_CHARS) {
      // строка сама длиннее предела — режем по знакам, иначе она пропадёт целиком
      flush();
      for (let i = 0; i < line.length; i += MAX_CHUNK_CHARS) pieces.push(line.slice(i, i + MAX_CHUNK_CHARS));
      start();
      continue;
    }
    if (length + line.length + 1 > MAX_CHUNK_CHARS && current.length) flush();
    current.push(line);
    length += line.length + 1;
  }
  if (current.length) pieces.push(current.join('\n'));
  // кусок из одной повторённой шапки смысла не несёт
  return pieces.filter((p) => p.trim().length >= MIN_CHUNK_CHARS && p !== header);
}

/* ---------------- загрузка исходных чанков из KB_DIR ---------------- */
function cleanText(t) {
  return String(t || '').replace(/\s+/g, ' ').trim();
}

/**
 * То же, но с сохранением переводов строк.
 *
 * Для названия документа и номера пункта переносы не нужны, а для текста чанка
 * нужны: таблица размечена по строкам, и если склеить их в одну, получится
 * лента «| 6 | 8 | 8 | 10 | 8 | 10 | ...», в которой не видно, где кончается
 * строка про I степень огнестойкости и начинается про II.
 */
function cleanChunkText(t) {
  return String(t || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[^\S\n]+/g, ' ')
    .split('\n')
    .map((l) => l.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function loadSourceChunks(kbDir) {
  const chunks = [];
  const vecDir = path.join(kbDir, '09_Векторный-индекс');
  const jsonDir = path.join(kbDir, '04_JSON');
  const seenDocs = new Set();

  // произвольные .md/.txt в корне и подпапках базы (кроме служебных 0*_/1*_) —
  // основной формат для «живых» баз вроде базы с отметками Гриши
  const walkLoose = (dir, depth = 0) => {
    if (!fs.existsSync(dir) || depth > 2) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith('.') || /^\d+_/.test(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walkLoose(p, depth + 1); continue; }
      if (!/\.(md|txt)$/i.test(e.name) || e.name === 'README.md') continue;
      const text = cleanText(fs.readFileSync(p, 'utf8'));
      const doc = e.name.replace(/\.(md|txt)$/i, '');
      for (let i = 0; i < text.length; i += MAX_CHUNK_CHARS) {
        const piece = text.slice(i, i + MAX_CHUNK_CHARS);
        if (piece.length >= MIN_CHUNK_CHARS) chunks.push({ doc, clause: '', priority: 'отметка', text: piece });
      }
    }
  };
  // в структурированной базе (есть 04_JSON/09_Векторный-индекс) свободные файлы не индексируем — там кураторская структура
  const structured = fs.existsSync(vecDir) || fs.existsSync(jsonDir);
  if (!structured) walkLoose(kbDir);

  if (fs.existsSync(vecDir)) {
    for (const doc of fs.readdirSync(vecDir)) {
      const f = path.join(vecDir, doc, 'чанки.jsonl');
      if (!fs.existsSync(f) || fs.statSync(f).size === 0) continue;
      const lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);
      let added = 0;
      for (const line of lines) {
        try {
          const c = JSON.parse(line);
          const text = cleanChunkText(c['текст']);
          if (text.length < MIN_CHUNK_CHARS) continue;
          const meta = {
            doc: cleanText(c['документ']) || doc,
            clause: cleanText(c['пункт']),
            priority: cleanText(c['приоритет']),
          };
          for (const piece of splitChunk(text)) {
            chunks.push({ ...meta, text: piece });
            added++;
          }
        } catch { /* пропускаем битые строки */ }
      }
      if (added > 0) seenDocs.add(doc);
    }
  }

  if (fs.existsSync(jsonDir)) {
    for (const doc of fs.readdirSync(jsonDir)) {
      if (seenDocs.has(doc)) continue;
      const f = path.join(jsonDir, doc, 'пункты.json');
      if (!fs.existsSync(f)) continue;
      try {
        const items = JSON.parse(fs.readFileSync(f, 'utf8'));
        for (const p of Array.isArray(items) ? items : []) {
          const text = cleanText(p['текст']);
          if (text.length < MIN_CHUNK_CHARS) continue;
          for (let i = 0; i < text.length; i += MAX_CHUNK_CHARS) {
            chunks.push({
              doc,
              clause: cleanText(p['номер']),
              priority: '',
              text: text.slice(i, i + MAX_CHUNK_CHARS),
            });
          }
        }
      } catch { /* документ без валидного JSON */ }
    }
  }
  return chunks;
}

/* ---------------- верифицированный разбор вытесняет старый ---------------- */
/** Нормализация имени документа: регистр и разделители не должны разводить пары. */
function normDoc(s) {
  return String(s).toLowerCase().replace(/[/\\]/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Документы, разобранные верифицированно, — по каталогу базы, а не по индексу.
 *
 * Источником служит сам каталог: индекс может быть собран до того, как база
 * пополнилась, и тогда старая копия документа снова полезет в ответы. Список
 * читается один раз за запуск — каталог за время работы сервера не меняется.
 */
let verifiedDocsCache = null;
function verifiedDocs() {
  if (verifiedDocsCache) return verifiedDocsCache;
  const docs = new Set();
  const base = config.kbBases.find((b) => b.id === 'verified');
  if (base) {
    for (const sub of ['09_Векторный-индекс', '04_JSON']) {
      const dir = path.join(base.dir, sub);
      if (!fs.existsSync(dir)) continue;
      for (const name of fs.readdirSync(dir)) {
        if (!name.startsWith('.')) docs.add(normDoc(name));
      }
    }
  }
  verifiedDocsCache = docs;
  return docs;
}

/**
 * Принадлежит ли чанк базе.
 *
 * Тринадцать документов лежали в индексе ДВАЖДЫ: старым разбором регулярными
 * выражениями в общей базе и верифицированным разбором рядом. Регэкспы на этих
 * же документах и рассыпались — пункты 3.13–3.19 внутри текста 3.12.1, числа из
 * таблицы в роли номеров пунктов, сорок таблиц при нуле пунктов. Пока обе копии
 * лежат рядом, поиск с равной вероятностью цитирует битую, и пометки об этом в
 * ответе не будет.
 *
 * Поэтому здесь ЗАМЕЩЕНИЕ, а не вычитание: старый разбор этих документов не
 * выдаётся никогда, но общая база отдаёт вместо него верифицированный. Простое
 * вычитание проверялось и оказалось хуже — общая база теряла СП 4.13130,
 * СП 42.13330, ГрК РФ и СанПиН 1200-03 целиком, то есть ровно те документы,
 * ради которых её и спрашивают.
 *
 * Смысл выбора после этого такой:
 *   «Общая база»    — все 53 документа, лучший разбор из имеющихся;
 *   «Верифицировано» — только 13, зато каждый пересчитан по исходнику.
 *
 * Файлы и строки индекса целы: изменена только выдача.
 */
function rowInBase(r, kbId) {
  const kb = r.kb || 'main';
  if (kbId === 'main') {
    if (kb === 'verified') return true;                        // замена старому разбору
    return kb === 'main' && !verifiedDocs().has(normDoc(r.doc)); // вытесненный старый разбор — мимо
  }
  return kb === kbId;
}

/* ---------------- эмбеддинги через LM Studio ---------------- */

/**
 * Очередь запросов к эмбеддингам: строго по одному.
 *
 * LM Studio загружает модель «по требованию» и на КАЖДЫЙ параллельный запрос
 * поднимает ОТДЕЛЬНЫЙ экземпляр. Несколько проектов, ищущих по базе знаний
 * одновременно, за час набивают память двумя десятками копий одной и той же
 * модели (проверено: 20 экземпляров по 639 МБ — 12,8 ГБ), после чего рабочая
 * модель уже не помещается и анализ падает с «insufficient system resources».
 * Поиск по базе — операция быстрая, очередь на ней не заметна.
 */
let embedChain = Promise.resolve();
async function embed(texts) {
  const run = embedChain.then(() => embedOnce(texts), () => embedOnce(texts));
  // цепочка не должна рваться от чужой ошибки — иначе следующий запрос уйдёт мимо очереди
  embedChain = run.then(() => {}, () => {});
  return run;
}

async function embedOnce(texts) {
  const res = await fetch(`${config.localAiBaseUrl}/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: config.kbEmbeddingModel, input: texts }),
    signal: AbortSignal.timeout(120000),
  });
  if (!res.ok) throw new Error(`embeddings HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return data.data.map((d) => Float32Array.from(d.embedding));
}

function toBlob(vec) { return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength); }
function fromBlob(buf) { return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4); }

/** Полная (пере)индексация всех подключённых баз. Возвращает статистику. */
async function reindex({ log = () => {} } = {}) {
  if (!config.kbBases.length) throw new Error('KB_DIR не задан');
  const chunks = [];
  for (const base of config.kbBases) {
    let baseChunks = fs.existsSync(base.dir) ? loadSourceChunks(base.dir) : [];
    if (base.id === 'main') {
      // документы, разобранные верифицированно, в общую базу больше не кладём:
      // иначе следующая сборка вернёт в индекс те самые дубли
      const before = baseChunks.length;
      baseChunks = baseChunks.filter((c) => !verifiedDocs().has(normDoc(c.doc)));
      const dropped = before - baseChunks.length;
      if (dropped) log(`База «${base.label}»: ${dropped} чанков пропущено — эти документы разобраны верифицированно`);
    }
    for (const c of baseChunks) c.kb = base.id;
    log(`База «${base.label}»: ${baseChunks.length} чанков`);
    chunks.push(...baseChunks);
  }
  log(`Чанков к индексации: ${chunks.length}`);
  db.exec('DELETE FROM kb_chunks');
  const insert = db.prepare('INSERT INTO kb_chunks (doc, clause, text, priority, embedding, kb) VALUES (?,?,?,?,?,?)');

  let embedded = 0, failed = false;
  const BATCH = 32;
  for (let i = 0; i < chunks.length && !failed; i += BATCH) {
    const batch = chunks.slice(i, i + BATCH);
    let vecs = null;
    for (let attempt = 1; attempt <= 4 && !vecs; attempt++) {
      try {
        vecs = await embed(batch.map((c) => `${c.doc} п.${c.clause}: ${c.text}`.slice(0, MAX_CHUNK_CHARS)));
      } catch (err) {
        if (attempt === 4) {
          log(`Эмбеддинги недоступны после ${attempt} попыток (${err.message}) — сохраняю без векторов (поиск по словам)`);
          failed = true;
        } else {
          log(`…повтор ${attempt} (эмбеддинги: ${err.message})`);
          await new Promise((r) => setTimeout(r, attempt * 15000)); // LM Studio мог быть занят другой задачей
        }
      }
    }
    if (vecs) {
      batch.forEach((c, j) => insert.run(c.doc, c.clause, c.text, c.priority, toBlob(vecs[j]), c.kb || 'main'));
      embedded += batch.length;
      if ((i / BATCH) % 20 === 0) log(`…${embedded}/${chunks.length}`);
    } else {
      for (const c of chunks.slice(i)) insert.run(c.doc, c.clause, c.text, c.priority, null, c.kb || 'main');
    }
  }
  db.prepare('INSERT INTO kb_meta (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run('indexed_at', now());
  invalidateCache();
  const stats = status();
  log(`Готово: ${stats.chunks} чанков, ${stats.docs} документов, векторов: ${stats.withVectors}`);
  return stats;
}

/**
 * Состояние индекса.
 *
 * Числа считаются по ТЕМ ЖЕ правилам, по которым идёт поиск: вытесненные
 * старые копии не входят ни в общий счётчик, ни в счётчик базы. Иначе в
 * пикере стояло бы «Общая база (9571 фрагм.)» при том, что две с половиной
 * тысячи из них поиску недоступны, — цифра, которой нельзя верить.
 */
function status() {
  const indexedAt = db.prepare("SELECT value FROM kb_meta WHERE key = 'indexed_at'").get()?.value || null;
  const live = new Set(config.kbBases.map((b) => b.id));
  const rows = db.prepare('SELECT kb, doc, COUNT(*) c, SUM(embedding IS NOT NULL) v FROM kb_chunks GROUP BY kb, doc').all();

  const perBase = new Map(config.kbBases.map((b) => [b.id, 0]));
  const docs = new Set();
  let chunks = 0;
  let withVectors = 0;
  for (const row of rows) {
    const kb = row.kb || 'main';
    // строку могут показывать сразу две базы (верифицированный разбор виден и в
    // общей) — в счётчик каждой она идёт, в общий итог только один раз
    for (const b of config.kbBases) if (rowInBase(row, b.id)) perBase.set(b.id, perBase.get(b.id) + row.c);
    // строки исчезнувших баз и вытесненный старый разбор не считаем нигде
    if (!live.has(kb) || !config.kbBases.some((b) => rowInBase(row, b.id))) continue;
    docs.add(normDoc(row.doc));
    chunks += row.c;
    withVectors += row.v || 0;
  }

  const bases = config.kbBases.map((b) => ({ id: b.id, label: b.label, chunks: perBase.get(b.id) || 0 }));
  return { enabled: !!config.kbBases.length, chunks, docs: docs.size, withVectors, indexedAt, bases };
}

/* ---------------- поиск ---------------- */
let cache = null;
let cacheIndexedAt = null;
function invalidateCache() { cache = null; cacheIndexedAt = null; }
function loadCache() {
  // кэш автоматически перечитывается после переиндексации (в т.ч. из другого процесса)
  const indexedAt = db.prepare("SELECT value FROM kb_meta WHERE key = 'indexed_at'").get()?.value || null;
  if (cache && indexedAt === cacheIndexedAt) return cache;
  const rows = db.prepare('SELECT id, doc, clause, text, priority, embedding, kb FROM kb_chunks').all();
  cache = rows.map((r) => ({ ...r, vec: r.embedding ? fromBlob(r.embedding) : null, embedding: undefined }));
  cacheIndexedAt = indexedAt;
  return cache;
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

function keywordScore(queryWords, text) {
  const lower = text.toLowerCase();
  let score = 0;
  for (const w of queryWords) if (w.length > 3 && lower.includes(w)) score++;
  return score / (queryWords.length || 1);
}

/** Топ-K релевантных чанков для запроса (в выбранной базе). Никогда не бросает — при сбое вернёт []. */
async function search(query, k = config.kbTopK, kbId = 'main') {
  try {
    const rows = loadCache().filter((r) => rowInBase(r, kbId));
    if (!rows.length || !query.trim()) return [];
    const withVec = rows.filter((r) => r.vec);
    let scored;
    if (withVec.length > rows.length / 2) {
      try {
        const [qv] = await embed([query.slice(0, 2000)]);
        scored = withVec.map((r) => ({ r, s: cosine(qv, r.vec) }));
      } catch { scored = null; }
    }
    if (!scored) {
      const words = query.toLowerCase().split(/[^a-zа-яё0-9.]+/).filter(Boolean);
      scored = rows.map((r) => ({ r, s: keywordScore(words, `${r.doc} ${r.clause} ${r.text}`) }));
    }
    return scored.sort((x, y) => y.s - x.s).slice(0, k)
      .filter((x) => x.s > 0)
      .map((x) => ({ doc: x.r.doc, clause: x.r.clause, text: x.r.text }));
  } catch (err) {
    console.warn('[kb] search failed:', err.message);
    return [];
  }
}

/** Блок выдержек для контекста модели. */
async function excerptsFor(query, kbId = 'main') {
  const found = await search(query, config.kbTopK, kbId);
  if (!found.length) return '';
  const base = config.kbBases.find((b) => b.id === kbId);
  return `## Выдержки из базы знаний «${base ? base.label : kbId}» (справочно; цитируй с шифром и пунктом)\n` +
    found.map((f) => `- [${f.doc}${f.clause ? `, п. ${f.clause}` : ''}] ${f.text.slice(0, 700)}`).join('\n');
}

// splitChunk открыт для модуля «Датасет»: он режет свои элементы ТЕМ ЖЕ
// механизмом, что и база знаний (таблицы — по строкам, с повтором шапки)
module.exports = { reindex, search, status, excerptsFor, loadSourceChunks, splitChunk, cosine, keywordScore, MAX_CHUNK_CHARS, MIN_CHUNK_CHARS };
