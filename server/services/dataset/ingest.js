'use strict';
/**
 * Приём документа в датасет: извлечение текста → нарезка → элементы.
 *
 * Текст извлекается ТЕМИ ЖЕ средствами, что и в анализе (claude/memory.js,
 * cad.js, doc-vision.js), нарезка — штатным чанкером базы знаний
 * (kb.splitChunk). Поверх чанкера модуль только:
 *  - делит текст на блоки (абзацы; подряд идущие строки «|…|» — один блок
 *    таблицы), потому что чанкер писан для ОДНОГО чанка, а не целого документа;
 *  - склеивает соседние куски до потолка элемента («гибрид», решение владельца
 *    2026-08-24): чанкер даёт куски ≤1400 символов, а элемент датасета может
 *    быть до 4000 токенов;
 *  - отбрасывает служебные строки (номера страниц, линейки) и коротыши <50 симв.
 *
 * OCR сканов идёт через СЛУЖЕБНУЮ СЕССИЮ платформы (status='service'):
 * весь стек адаптера — гейты, учёт расхода, кэш распознавания — работает без
 * единой правки. Сессия смертна (TTL), датасет — нет: текст элементов ложится
 * в таблицы модуля при обработке, и смерть сессии ему безразлична.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../../config');
const { db, now } = require('../../db');
const store = require('./store');
const kb = require('../kb');
const { CHARS_PER_TOKEN } = require('../claude/adapter');

const ELEMENT_MAX_TOKENS = 4000;
const ELEMENT_MAX_CHARS = Math.floor(ELEMENT_MAX_TOKENS * CHARS_PER_TOKEN);
const ELEMENT_MIN_CHARS = 50;
// извлечённый текст не режем лимитом анализа (45 тыс.): датасету нужен весь документ
const EXTRACT_CHAR_LIMIT = 4_000_000;

/* ---------------- служебная сессия ---------------- */

/**
 * Служебная сессия датасета: status='service', поэтому в списках проектов её
 * нет и токеном её не открыть, но recordUsage, облачный гейт и doc-vision
 * видят обычную строку sessions. TTL её со временем удалит — тогда заводится
 * новая: элементы уже в таблицах модуля, а расход пишется в момент вызова.
 */
function ensureServiceSession(doc, user, host = '') {
  if (doc.service_session_id) {
    const row = db.prepare('SELECT id FROM sessions WHERE id = ?').get(doc.service_session_id);
    if (row) return doc.service_session_id;
  }
  const id = crypto.randomUUID();
  db.prepare(`INSERT INTO sessions (id, token, status, device_id, user_id, prompt_version, origin_host, title, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
    id, crypto.randomBytes(32).toString('hex'), 'service', '',
    (user && user.id) || doc.uploaded_by || '', config.promptVersion, host,
    `Датасет: ${doc.filename}`.slice(0, 60), now(), now());
  db.prepare('UPDATE dataset_documents SET service_session_id = ? WHERE id = ?').run(id, doc.id);
  return id;
}

/** Копия файла в каталоге сессии + строка files — столько, сколько нужно doc-vision. */
function ensureSessionFile(doc, sessionId) {
  const existing = db.prepare('SELECT * FROM files WHERE session_id = ?').all(sessionId)
    .find((f) => f.original_name === doc.filename);
  if (existing && fs.existsSync(existing.stored_path)) return existing;
  const dir = path.join(config.dataDir, 'uploads', sessionId);
  fs.mkdirSync(dir, { recursive: true });
  const id = crypto.randomUUID();
  const storedPath = path.join(dir, `${id}_${doc.filename}`);
  fs.copyFileSync(doc.stored_path, storedPath);
  db.prepare('INSERT INTO files (id, session_id, original_name, stored_path, size, ext, mime, created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(id, sessionId, doc.filename, storedPath, doc.size, doc.format, doc.mime || '', now());
  return db.prepare('SELECT * FROM files WHERE id = ?').get(id);
}

/** Кэш распознавания vision-моделью — как его читает memory.js. */
function visionText(storedPath) {
  try {
    return fs.readFileSync(`${storedPath}.vision.md`, 'utf8')
      .replace(/\n?<!--enso-vision:[\s\S]*?-->\s*$/, '').trim();
  } catch { return ''; }
}

/* ---------------- извлечение текста ---------------- */

/**
 * Текст документа — теми же экстракторами, что у анализа. Скан распознаётся
 * vision-моделью только когда текстового слоя нет: OCR долгий и платный.
 * Возвращает { text, note } — note уходит в прогресс документа.
 */
async function extractText(doc, { route, onProgress = () => {} } = {}) {
  const memory = require('../claude/memory');
  const ext = doc.format;
  if (['txt', 'md', 'json', 'csv'].includes(ext)) {
    return { text: memory.readTextFile(doc.stored_path).text, note: '' };
  }
  if (ext === 'docx') {
    const text = memory.extractDocxText(doc.stored_path);
    if (!text.trim()) throw store.httpError(422, 'Текст DOCX извлечь не удалось');
    return { text, note: '' };
  }
  if (ext === 'dwg' || ext === 'dxf') {
    // выжимка CAD (слои, надписи, контуры) — единственное текстовое представление чертежа
    const text = await require('../cad').extractCad(doc.stored_path, ext, doc.filename);
    return { text, note: 'выжимка из CAD-чертежа' };
  }
  if (ext === 'pdf' || ['png', 'jpg', 'jpeg'].includes(ext)) {
    let text = '';
    if (ext === 'pdf') text = await memory.extractPdfText(doc.stored_path, EXTRACT_CHAR_LIMIT, { mark: false });
    const goodText = text && text.trim().length >= 200;
    let vision = '';
    if (!goodText) {
      // скан: распознаём через служебную сессию, кэш ложится рядом с копией файла
      const sessionId = ensureServiceSession(doc, null);
      const file = ensureSessionFile(doc, sessionId);
      onProgress('распознавание скана vision-моделью…');
      await require('../doc-vision').extractGraphics(sessionId, {
        route,
        onProgress: (label) => onProgress(label),
      });
      vision = visionText(file.stored_path);
    }
    const combined = [goodText ? text : '', vision].filter(Boolean).join('\n\n');
    if (!combined.trim() && text.trim()) return { text, note: 'текстовый слой почти пуст, распознать скан не удалось' };
    if (!combined.trim()) throw store.httpError(422, 'Не удалось извлечь текст: ни текстового слоя, ни распознавания');
    return { text: combined, note: vision ? 'часть страниц распознана vision-моделью' : '' };
  }
  throw store.httpError(422, `Формат .${ext} в датасет не принимается`);
}

/* ---------------- нарезка ---------------- */

/** Строка служебная: номер страницы, колонтитул-линейка, форм-фид. */
function isServiceLine(line) {
  const t = line.trim();
  if (!t) return true;
  if (/^[-—–_=.·*\s]+$/.test(t)) return true; // линейки и точечные отбивки
  // номера страниц: «стр. 5», «лист 3», «5 из 40», «7/12», «- 7 -», «—12—»
  if (/^[-—–_=.\s]*((стр(аница)?|лист|page)\.?\s*)?\d{1,4}(\s*(из|of|\/)\s*\d{1,4})?[-—–_=.\s]*$/i.test(t)) return true;
  return false;
}

/**
 * Текст → блоки. Абзац кончается пустой строкой; подряд идущие строки «|…|» —
 * один блок таблицы (иначе чанкер, писанный для одного чанка, приклеит шапку
 * ПЕРВОЙ таблицы документа ко всем следующим кускам).
 */
function splitBlocks(text) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').replace(/\f/g, '\n').split('\n');
  const blocks = [];
  let cur = [];
  let curTable = false;
  let curOffset = 0;
  let offset = 0;
  const flush = () => {
    const body = cur.join('\n').trim();
    if (body) blocks.push({ text: body, table: curTable, offset: curOffset });
    cur = [];
  };
  for (const line of lines) {
    const isTable = /^\s*\|/.test(line);
    const blank = !line.trim();
    if (blank) { flush(); }
    else if (isServiceLine(line)) { /* колонтитулы и номера страниц в элементы не попадают */ }
    else {
      if (cur.length && curTable !== isTable) flush();
      if (!cur.length) { curTable = isTable; curOffset = offset; }
      cur.push(line);
    }
    offset += line.length + 1;
  }
  flush();
  return blocks;
}

/** Первая строка таблицы — шапка (как считает и сам чанкер). */
function tableHeader(block) {
  const tableLines = block.split('\n').filter((l) => l.trim().startsWith('|'));
  return tableLines.length >= 2 ? tableLines[0] : null;
}

/**
 * Куски чанкера → части таблицы не больше потолка элемента.
 * Чанкер повторяет шапку в каждом куске; при склейке кусков в одну часть
 * повторы шапки убираются, а на границе частей шапка остаётся — каждая часть
 * читается как самостоятельная таблица.
 */
function packTableParts(pieces, header, maxChars) {
  const parts = [];
  let cur = '';
  for (const piece of pieces) {
    let body = piece;
    if (cur && header && body.startsWith(`${header}\n`)) body = body.slice(header.length + 1);
    if (cur && cur.length + body.length + 1 > maxChars) {
      parts.push(cur);
      cur = piece; // новая часть начинается с куска чанкера — шапка в нём уже есть
    } else {
      cur = cur ? `${cur}\n${body}` : piece;
    }
  }
  if (cur) parts.push(cur);
  return parts;
}

/** Текстовые куски → элементы не больше потолка (склейка соседних абзацев). */
function packTextParts(chunks, maxChars) {
  const parts = [];
  let cur = '';
  for (const chunk of chunks) {
    if (cur && cur.length + chunk.length + 2 > maxChars) { parts.push(cur); cur = chunk; }
    else cur = cur ? `${cur}\n\n${chunk}` : chunk;
  }
  if (cur) parts.push(cur);
  return parts;
}

/** Краткое описание элемента для «Истории». */
function describeElement(content, kind, docFilename) {
  if (kind === 'table') {
    const header = tableHeader(content);
    const cells = header ? header.split('|').map((c) => c.trim()).filter(Boolean).slice(0, 3).join(', ') : '';
    return cells ? `таблица: ${cells}`.slice(0, 120) : 'таблица';
  }
  const m = content.match(/^(\d+(?:\.\d+)+)[.)]?\s/);
  if (m) return `пункт ${m[1]}`;
  const firstLine = content.split('\n', 1)[0];
  return firstLine.slice(0, 100) + (firstLine.length > 100 ? '…' : '');
}

/**
 * Нарезка извлечённого текста на элементы.
 * Возвращает [{content, kind, offset}] — валидные, отфильтрованные, ≤ потолка.
 */
function chunkText(text) {
  const out = [];
  const pendingText = []; // текстовые куски, ждущие склейки; таблица склейку прерывает
  let pendingOffset = -1;
  const flushText = () => {
    if (!pendingText.length) return;
    for (const part of packTextParts(pendingText, ELEMENT_MAX_CHARS)) {
      out.push({ content: part, kind: 'text', offset: pendingOffset });
    }
    pendingText.length = 0;
    pendingOffset = -1;
  };
  for (const block of splitBlocks(text)) {
    if (block.table) {
      flushText();
      // таблица целиком, если помещается; иначе — строго по строкам, шапка в каждой части
      const parts = block.text.length <= ELEMENT_MAX_CHARS
        ? [block.text]
        : packTableParts(kb.splitChunk(block.text), tableHeader(block.text), ELEMENT_MAX_CHARS);
      for (const part of parts) out.push({ content: part, kind: 'table', offset: block.offset });
    } else {
      // сверхдлинный абзац сначала режет чанкер (по строкам), потом куски склеиваются
      const chunks = block.text.length > kb.MAX_CHUNK_CHARS ? kb.splitChunk(block.text) : [block.text];
      if (pendingOffset < 0) pendingOffset = block.offset;
      pendingText.push(...chunks);
    }
  }
  flushText();
  return out.filter((e) => e.content.trim().length >= ELEMENT_MIN_CHARS);
}

/* ---------------- обработка документа ---------------- */

const running = new Set(); // документы, обрабатываемые прямо сейчас

/**
 * Полный цикл: текст → элементы → черновики пар. Работает в фоне, прогресс
 * пишется в строку документа. Падение — честный статус failed с причиной.
 */
async function processDocument(docId, { generate = true } = {}) {
  if (running.has(docId)) return;
  running.add(docId);
  try {
    const doc = store.docById(docId);
    if (!doc) return;
    const settings = store.settingsGet();
    const route = { provider: settings.ai_provider, model: settings.ai_model };
    store.setDocStatus(docId, 'chunking', { error: '', progress: 'извлечение текста…' });

    const { text, note } = await extractText(doc, {
      route,
      onProgress: (label) => store.setDocProgress(docId, label),
    });
    store.setDocProgress(docId, 'нарезка на элементы…');
    const elements = chunkText(text);
    if (!elements.length) {
      throw store.httpError(422, 'После нарезки не осталось ни одного элемента: документ короче 50 символов или состоит из служебного текста');
    }

    let fresh = 0, reused = 0;
    elements.forEach((e, i) => {
      const { element, existed } = store.upsertElement({
        content: e.content,
        kind: e.kind,
        descr: describeElement(e.content, e.kind, doc.filename),
        tokenCount: Math.ceil(e.content.length / CHARS_PER_TOKEN),
      });
      // существующий элемент переиспользуется: связка новая, пары — прежние
      store.linkElement(docId, element.id, i, { offset: e.offset });
      store.recomputeStates(element.id);
      if (existed) reused++; else fresh++;
    });
    const noteText = [note, `элементов: ${elements.length}${reused ? ` (${reused} совпали с уже загруженными)` : ''}`]
      .filter(Boolean).join('; ');

    if (generate) {
      store.setDocStatus(docId, 'generating', { progress: noteText });
      const gen = await require('./generate').generateForDocument(docId, {
        onProgress: (label) => store.setDocProgress(docId, `${noteText}; ${label}`),
      });
      store.setDocStatus(docId, 'ready', {
        progress: `${noteText}; черновиков: ${gen.created}${gen.unfit ? `, непригодных ответов: ${gen.unfit}` : ''}${gen.failed ? `, ошибок генерации: ${gen.failed}` : ''}`,
      });
    } else {
      store.setDocStatus(docId, 'ready', { progress: noteText });
    }
  } catch (err) {
    console.warn(`[dataset] обработка документа ${docId} не удалась:`, err.message);
    store.setDocStatus(docId, 'failed', { error: err.message });
  } finally {
    running.delete(docId);
  }
}

module.exports = {
  processDocument, chunkText, splitBlocks, isServiceLine, describeElement,
  ensureServiceSession, ensureSessionFile, extractText,
  ELEMENT_MAX_CHARS, ELEMENT_MIN_CHARS, ELEMENT_MAX_TOKENS,
  _running: running,
};
