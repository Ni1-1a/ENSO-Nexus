'use strict';
/**
 * Корпус НТД модуля «Нормоконтроль»: структурное чанкование текстов стандартов
 * по иерархии пунктов + эмбеддинги в pgvector (гибридный поиск: tsvector + вектор).
 *
 * Тексты-источники: нормоконтроль/_raw/ocr/*.txt (OCR и pdftotext Этапов 0–3).
 * Эмбеддинги — LM Studio /v1/embeddings, модель KB_EMBEDDING_MODEL (dim 1024).
 * Чанк без вектора не пишется вовсе — схема держит NOT NULL, а загрузчик падает
 * с ошибкой, если эмбеддинг не получен (урок «тихой» переиндексации базы знаний).
 *
 * CLI: node server/services/normo/ntd-corpus.js load  — загрузка стандартного набора.
 */
const fs = require('fs');
const path = require('path');
const config = require('../../config');
const db = require('./db');

/** Стандартный набор корпуса: код → файл текста. Дополняется по мере добора. */
const CORPUS = [
  { code: 'ГОСТ Р 21.101-2020', file: 'ГОСТ Р 21.101-2020__ocr.txt', system: 'СПДС', edition: '2020', note: 'OCR 69 стр.' },
  { code: 'ГОСТ 21.002-2014', file: 'ГОСТ 21.002-2014__text.txt', system: 'СПДС', edition: '2014' },
  { code: 'ГОСТ 21.501-2018', file: 'ГОСТ 21.501-2018__ocr.txt', system: 'СПДС', edition: '2018', note: 'OCR' },
  { code: 'ГОСТ Р 21.618-2023', file: 'ГОСТ Р 21.618-2023__ocr.txt', system: 'СПДС', edition: '2023', note: 'OCR' },
  { code: 'ГОСТ Р 7.0.97-2016', file: 'ГОСТ Р 7.0.97-2016__ocr.txt', system: 'СИБИД', edition: '2016', note: 'OCR' },
  { code: 'ГОСТ Р 7.0.8-2013', file: 'ГОСТ Р 7.0.8-2013__ocr.txt', system: 'СИБИД', edition: '2013', note: 'OCR' },
  { code: 'Приказ Минстроя России от 12.05.2017 № 783/пр', file: 'Приказ 783пр__text.txt', system: 'НПА', edition: '2017' },
];

const CHUNK_MAX = 1600;

/**
 * Разбор текста стандарта на пункты. Начало пункта — строка вида «5.4.3 Текст…»;
 * приложения — «Приложение Х». Маркеры страниц OCR («===== [стр. N/M] =====»)
 * выбрасываются. До первого пункта — преамбула (clause «0»).
 */
function parseClauses(text) {
  // «5.4.3 Текст» (ГОСТ) и «4. Текст» (НПА — номер с точкой)
  const clauseRe = /^\s{0,8}(\d{1,2}(?:\.\d{1,3}){0,4})\.?\s+(?=[А-ЯЁA-Z«])/u;
  const annexRe = /^\s{0,8}Приложение\s+([А-ЯЁ])\b/u;
  const out = [];
  let current = { clause: '0', lines: [] };
  const push = () => {
    const body = current.lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    if (body) out.push({ clause: current.clause, body });
  };
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (/^=====\s*\[стр\./.test(line.trim())) continue;
    const annex = line.match(annexRe);
    const m = line.match(clauseRe);
    if (annex) {
      push();
      current = { clause: `прил. ${annex[1]}`, lines: [line.trim()] };
    } else if (m) {
      push();
      current = { clause: m[1], lines: [line.trim()] };
    } else {
      current.lines.push(line);
    }
  }
  push();
  return out;
}

function splitChunks(body) {
  if (body.length <= CHUNK_MAX) return [body];
  const parts = [];
  let buf = '';
  for (const para of body.split(/\n\n+/)) {
    if (buf && buf.length + para.length > CHUNK_MAX) { parts.push(buf.trim()); buf = ''; }
    buf += (buf ? '\n\n' : '') + para;
    // одиночный сверхдлинный абзац режем жёстко
    while (buf.length > CHUNK_MAX * 1.5) { parts.push(buf.slice(0, CHUNK_MAX)); buf = buf.slice(CHUNK_MAX); }
  }
  if (buf.trim()) parts.push(buf.trim());
  return parts;
}

async function embed(texts) {
  const res = await fetch(`${config.localAiBaseUrl}/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: config.kbEmbeddingModel, input: texts }),
  });
  if (!res.ok) throw new Error(`эмбеддинги: HTTP ${res.status} от ${config.localAiBaseUrl}`);
  const data = await res.json();
  const vectors = (data.data || []).map((d) => d.embedding);
  if (vectors.length !== texts.length || vectors.some((v) => !Array.isArray(v) || v.length !== 1024)) {
    throw new Error(`эмбеддинги: получено ${vectors.length}/${texts.length}, размерность обязана быть 1024`);
  }
  return vectors;
}

function toVectorLiteral(v) {
  return `[${v.join(',')}]`;
}

async function loadDocument({ code, file, system, edition, title, note }) {
  const abs = path.join(config.normoKbDir, '_raw', 'ocr', file);
  const text = fs.readFileSync(abs, 'utf8');
  const clauses = parseClauses(text);
  await db.migrate();

  const batch = [];
  // Номер пункта в тексте встречается не один раз: «5.4.3» может стоять и в
  // оглавлении, и в теле, а «1»/«2» — ещё и как номера в перечислениях. chunk_no
  // считается СКВОЗНЫМ по каждому номеру пункта, иначе ON CONFLICT молча затирает
  // одно вхождение другим (так терялась треть корпуса), и поиск пункта отдаёт
  // случайный обрывок вместо требования. Все вхождения хранятся, findClause
  // возвращает их вместе — верификатор ищет цитату по любому из них.
  const perClause = new Map();
  for (const c of clauses) {
    const parent = c.clause.includes('.') ? c.clause.split('.').slice(0, -1).join('.') : null;
    for (const body of splitChunks(c.body)) {
      const chunkNo = perClause.get(c.clause) || 0;
      perClause.set(c.clause, chunkNo + 1);
      batch.push({ clause: c.clause, parent, body, chunkNo });
    }
  }

  // Эмбеддинги считаются ДО единой транзакции записи: обрыв LM Studio на середине
  // не должен оставлять документ без чанков. Прежний порядок (сначала DELETE,
  // потом эмбеддинги) при падении модели стирал корпус документа целиком.
  for (let i = 0; i < batch.length; i += 32) {
    const slice = batch.slice(i, i + 32);
    const vectors = await embed(slice.map((b) => b.body));
    slice.forEach((b, j) => { b.vector = toVectorLiteral(vectors[j]); });
  }

  const docId = await db.tx(async (client) => {
    const doc = await client.query(
      `INSERT INTO ntd_docs (code, title, edition, system, status, role, source)
       VALUES ($1,$2,$3,$4,'действует (по корпусу)',$5,'корпус')
       ON CONFLICT (code) DO UPDATE SET title = EXCLUDED.title, updated_at = now()
       RETURNING id`,
      [code, title || code, edition || null, system || null, note || null]);
    const id = doc.rows[0].id;
    await client.query('DELETE FROM ntd_chunks WHERE doc_id = $1', [id]);
    for (const b of batch) {
      await client.query(
        `INSERT INTO ntd_chunks (doc_id, clause, parent, body, chunk_no, embedding)
         VALUES ($1,$2,$3,$4,$5,$6::vector)`,
        [id, b.clause, b.parent, b.body, b.chunkNo, b.vector]);
    }
    // Сколько собрали, столько и должно лечь: расхождение означает потерю чанков
    // на конфликте ключа — откатываем целиком, молчать об этом нельзя.
    const stored = await client.query(
      'SELECT count(*)::int AS n FROM ntd_chunks WHERE doc_id = $1', [id]);
    if (stored.rows[0].n !== batch.length) {
      throw new Error(`${code}: собрано ${batch.length} чанков, в базе ${stored.rows[0].n}`);
    }
    return id;
  });

  return { docId, clauses: clauses.length, chunks: batch.length };
}

async function loadAll() {
  const results = [];
  for (const item of CORPUS) {
    const r = await loadDocument(item);
    results.push({ code: item.code, ...r });
    console.log(`[ntd-corpus] ${item.code}: пунктов ${r.clauses}, чанков ${r.chunks}`);
  }
  return results;
}

/** Нормализация кода документа для сопоставления «как назвала модель» ↔ реестр. */
function normalizeCode(code) {
  return String(code || '').replace(/\s+/g, '').replace(/[«»"]/g, '').toUpperCase()
    .replace(/ГОСТР/, 'ГОСТ Р ').replace(/^ГОСТ(?![ Р])/, 'ГОСТ ');
}

async function findDoc(codeLike) {
  const all = await db.query('SELECT id, code FROM ntd_docs');
  const want = normalizeCode(codeLike);
  for (const row of all.rows) {
    const have = normalizeCode(row.code);
    if (have === want || want.includes(have) || have.includes(want)) return row;
  }
  return null;
}

async function findClause(codeLike, clause) {
  const doc = await findDoc(codeLike);
  if (!doc) return { doc: null, chunks: [] };
  const cl = String(clause).trim().replace(/^п\.?\s*/i, '');
  const r = await db.query(
    'SELECT clause, body, chunk_no FROM ntd_chunks WHERE doc_id = $1 AND clause = $2 ORDER BY chunk_no',
    [doc.id, cl]);
  return { doc, chunks: r.rows };
}

/** Гибридный поиск по корпусу: полнотекст + вектор, для подсказок LLM-агентам. */
async function search(query, { limit = 5, docCode = null } = {}) {
  const [vector] = await embed([query]);
  const args = [toVectorLiteral(vector), limit];
  let docFilter = '';
  if (docCode) {
    const doc = await findDoc(docCode);
    if (doc) { args.push(doc.id); docFilter = `AND c.doc_id = $${args.length}`; }
  }
  const r = await db.query(
    `SELECT d.code, c.clause, c.body, 1 - (c.embedding <=> $1::vector) AS score
     FROM ntd_chunks c JOIN ntd_docs d ON d.id = c.doc_id
     WHERE TRUE ${docFilter}
     ORDER BY c.embedding <=> $1::vector LIMIT $2`, args);
  return r.rows;
}

module.exports = { parseClauses, splitChunks, embed, loadDocument, loadAll, findDoc, findClause, search, CORPUS };

if (require.main === module) {
  const cmd = process.argv[2];
  if (cmd === 'load') {
    loadAll().then((r) => {
      console.log('готово:', r.map((x) => `${x.code}: ${x.chunks}`).join('; '));
      return db.close();
    }).catch((e) => { console.error(e); process.exit(1); });
  } else {
    console.log('использование: node ntd-corpus.js load');
  }
}
