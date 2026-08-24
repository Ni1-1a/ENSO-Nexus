'use strict';
/**
 * Экспорт валидированных пар в JSONL для LoRA-дообучения.
 *
 * В файл попадают ТОЛЬКО пары status='validated' без deleted_at — весь
 * валидированный набор, а не текущая выборка «Истории»: фильтры UI на экспорт
 * не влияют по ТЗ модуля.
 *
 * Формат строки-пары:
 *   {"messages":[{"role":"system",...},{"role":"user","<элемент>\n\n<вопрос>"},{"role":"assistant","<ответ>"}]}
 *
 * Первая строка файла — СЛУЖЕБНАЯ (решение владельца 2026-08-24): в ней
 * версия системного промпта и параметры разбиения. Перед обучением её нужно
 * отбросить (`tail -n +2`); поле "meta" отличает её от пар однозначно.
 * Дата экспорта в мету НЕ пишется намеренно: она есть в имени файла, а
 * повторный экспорт тех же данных обязан давать те же байты — это проверяемо
 * тестом и обещано приёмкой.
 *
 * Разбиение train/valid — 90/10 ПО ЭЛЕМЕНТАМ: все пары одного элемента
 * попадают в одну часть, иначе ответы по тому же фрагменту утекают из train
 * в valid. Перемешивание — mulberry32 от seed из настроек: воспроизводимо.
 */
const crypto = require('crypto');
const config = require('../../config');
const store = require('./store');
const prompts = require('../prompts');

/** Детерминированный ГПСЧ: одинаковый seed — одинаковая последовательность. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Валидированные пары в детерминированном порядке:
 * документ (первая связка элемента) → order_index → id пары.
 * Элемент из двух документов выгружается ОДИН раз — по первому вхождению.
 */
function validatedRows() {
  return store.db.prepare(`
    SELECT p.id AS pair_id, p.question, p.answer, e.id AS element_id, e.content, e.content_hash
    FROM dataset_pairs p
    JOIN dataset_elements e ON e.id = p.element_id
    LEFT JOIN dataset_document_elements l ON l.element_id = e.id AND l.document_id = (
      SELECT l2.document_id FROM dataset_document_elements l2
      JOIN dataset_documents d2 ON d2.id = l2.document_id
      WHERE l2.element_id = e.id ORDER BY d2.uploaded_at, d2.id LIMIT 1)
    LEFT JOIN dataset_documents d ON d.id = l.document_id
    WHERE p.status = 'validated' AND p.deleted_at IS NULL
    ORDER BY d.uploaded_at, d.id, l.order_index, p.id`).all();
}

function pairLine(systemText, row) {
  return JSON.stringify({
    messages: [
      { role: 'system', content: systemText },
      { role: 'user', content: `${row.content}\n\n${row.question}` },
      { role: 'assistant', content: row.answer },
    ],
  });
}

function metaLine({ pairs, part = null, seed = null, promptSha }) {
  const meta = {
    format: 'enso-nexus-dataset',
    version: 1,
    system_prompt: 'prompts/dataset-system.md',
    system_prompt_sha256: promptSha,
    platform_prompt_version: config.promptVersion,
    pairs,
  };
  if (part) meta.part = part;
  if (seed !== null) meta.seed = seed;
  return JSON.stringify({ meta });
}

function fileStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

/** Единый файл: служебная строка + все валидированные пары. UTF-8 без BOM, LF. */
function buildExport() {
  const rows = validatedRows();
  if (!rows.length) throw store.httpError(400, 'Валидированных пар нет — экспортировать нечего');
  const systemText = prompts.load('dataset-system');
  const promptSha = crypto.createHash('sha256').update(systemText, 'utf8').digest('hex').slice(0, 16);
  const lines = [metaLine({ pairs: rows.length, promptSha })];
  for (const row of rows) lines.push(pairLine(systemText, row));
  return {
    filename: `enso-dataset-${fileStamp()}.jsonl`,
    buffer: Buffer.from(`${lines.join('\n')}\n`, 'utf8'),
    pairs: rows.length,
  };
}

/**
 * Разбиение train/valid по элементам. Элементы сортируются по content_hash —
 * порядок не зависит ни от времени загрузки, ни от id, — затем перемешиваются
 * mulberry32(seed) и делятся 90/10 (в valid не меньше одного элемента, если
 * их хотя бы два).
 */
function splitElements(rows, seed) {
  const byElement = new Map();
  for (const row of rows) {
    if (!byElement.has(row.element_id)) byElement.set(row.element_id, row.content_hash);
  }
  const hashes = [...new Set(byElement.values())].sort();
  const rng = mulberry32(seed);
  for (let i = hashes.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [hashes[i], hashes[j]] = [hashes[j], hashes[i]];
  }
  const validCount = hashes.length >= 2 ? Math.max(1, Math.round(hashes.length * 0.1)) : 0;
  return new Set(hashes.slice(0, validCount)); // content_hash элементов, уходящих в valid
}

/** Экспорт с разбиением: zip с train.jsonl и valid.jsonl. */
function buildSplitExport() {
  const rows = validatedRows();
  if (!rows.length) throw store.httpError(400, 'Валидированных пар нет — экспортировать нечего');
  const seed = parseInt(store.settingsGet().seed, 10) || 42;
  const systemText = prompts.load('dataset-system');
  const promptSha = crypto.createHash('sha256').update(systemText, 'utf8').digest('hex').slice(0, 16);
  const validSet = splitElements(rows, seed);
  const parts = { train: [], valid: [] };
  for (const row of rows) parts[validSet.has(row.content_hash) ? 'valid' : 'train'].push(row);

  const AdmZip = require('adm-zip');
  const zip = new AdmZip();
  for (const name of ['train', 'valid']) {
    const lines = [metaLine({ pairs: parts[name].length, part: name, seed, promptSha })];
    for (const row of parts[name]) lines.push(pairLine(systemText, row));
    zip.addFile(`${name}.jsonl`, Buffer.from(`${lines.join('\n')}\n`, 'utf8'));
  }
  // отметки времени в zip фиксируются: повторный экспорт с тем же seed обязан
  // давать байт в байт тот же архив
  for (const entry of zip.getEntries()) entry.header.time = new Date(Date.UTC(2026, 0, 1));
  return {
    filename: `enso-dataset-${fileStamp()}-split.zip`,
    buffer: zip.toBuffer(),
    pairs: rows.length,
    train: parts.train.length,
    valid: parts.valid.length,
    seed,
  };
}

module.exports = { buildExport, buildSplitExport, validatedRows, splitElements, mulberry32, pairLine, metaLine };
