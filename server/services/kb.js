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

const MAX_CHUNK_CHARS = 1400;
const MIN_CHUNK_CHARS = 80;

/* ---------------- загрузка исходных чанков из KB_DIR ---------------- */
function cleanText(t) {
  return String(t || '').replace(/\s+/g, ' ').trim();
}

function loadSourceChunks(kbDir) {
  const chunks = [];
  const vecDir = path.join(kbDir, '09_Векторный-индекс');
  const jsonDir = path.join(kbDir, '04_JSON');
  const seenDocs = new Set();

  if (fs.existsSync(vecDir)) {
    for (const doc of fs.readdirSync(vecDir)) {
      const f = path.join(vecDir, doc, 'чанки.jsonl');
      if (!fs.existsSync(f) || fs.statSync(f).size === 0) continue;
      const lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);
      let added = 0;
      for (const line of lines) {
        try {
          const c = JSON.parse(line);
          const text = cleanText(c['текст']);
          if (text.length < MIN_CHUNK_CHARS) continue;
          chunks.push({
            doc: cleanText(c['документ']) || doc,
            clause: cleanText(c['пункт']),
            priority: cleanText(c['приоритет']),
            text: text.slice(0, MAX_CHUNK_CHARS),
          });
          added++;
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

/* ---------------- эмбеддинги через LM Studio ---------------- */
async function embed(texts) {
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

/** Полная (пере)индексация базы. Возвращает статистику. */
async function reindex({ log = () => {} } = {}) {
  if (!config.kbDir) throw new Error('KB_DIR не задан');
  const chunks = loadSourceChunks(config.kbDir);
  log(`Чанков к индексации: ${chunks.length}`);
  db.exec('DELETE FROM kb_chunks');
  const insert = db.prepare('INSERT INTO kb_chunks (doc, clause, text, priority, embedding) VALUES (?,?,?,?,?)');

  let embedded = 0, failed = false;
  const BATCH = 32;
  for (let i = 0; i < chunks.length && !failed; i += BATCH) {
    const batch = chunks.slice(i, i + BATCH);
    try {
      const vecs = await embed(batch.map((c) => `${c.doc} п.${c.clause}: ${c.text}`.slice(0, MAX_CHUNK_CHARS)));
      batch.forEach((c, j) => insert.run(c.doc, c.clause, c.text, c.priority, toBlob(vecs[j])));
      embedded += batch.length;
      if ((i / BATCH) % 20 === 0) log(`…${embedded}/${chunks.length}`);
    } catch (err) {
      log(`Эмбеддинги недоступны (${err.message}) — сохраняю без векторов (поиск по словам)`);
      failed = true;
      for (const c of chunks.slice(i)) insert.run(c.doc, c.clause, c.text, c.priority, null);
    }
  }
  db.prepare('INSERT INTO kb_meta (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run('indexed_at', now());
  invalidateCache();
  const stats = status();
  log(`Готово: ${stats.chunks} чанков, ${stats.docs} документов, векторов: ${stats.withVectors}`);
  return stats;
}

function status() {
  const chunks = db.prepare('SELECT COUNT(*) c FROM kb_chunks').get().c;
  const docs = db.prepare('SELECT COUNT(DISTINCT doc) c FROM kb_chunks').get().c;
  const withVectors = db.prepare('SELECT COUNT(*) c FROM kb_chunks WHERE embedding IS NOT NULL').get().c;
  const indexedAt = db.prepare("SELECT value FROM kb_meta WHERE key = 'indexed_at'").get()?.value || null;
  return { enabled: !!config.kbDir, chunks, docs, withVectors, indexedAt };
}

/* ---------------- поиск ---------------- */
let cache = null;
let cacheIndexedAt = null;
function invalidateCache() { cache = null; cacheIndexedAt = null; }
function loadCache() {
  // кэш автоматически перечитывается после переиндексации (в т.ч. из другого процесса)
  const indexedAt = db.prepare("SELECT value FROM kb_meta WHERE key = 'indexed_at'").get()?.value || null;
  if (cache && indexedAt === cacheIndexedAt) return cache;
  const rows = db.prepare('SELECT id, doc, clause, text, priority, embedding FROM kb_chunks').all();
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

/** Топ-K релевантных чанков для запроса. Никогда не бросает — при сбое вернёт []. */
async function search(query, k = config.kbTopK) {
  try {
    const rows = loadCache();
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
async function excerptsFor(query) {
  const found = await search(query);
  if (!found.length) return '';
  return '## Выдержки из нормативной базы (справочно; цитируй с шифром и пунктом)\n' +
    found.map((f) => `- [${f.doc}${f.clause ? `, п. ${f.clause}` : ''}] ${f.text.slice(0, 700)}`).join('\n');
}

module.exports = { reindex, search, status, excerptsFor, loadSourceChunks, cosine, keywordScore };
