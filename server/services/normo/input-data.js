'use strict';
/**
 * Исходные данные (ИД) и требования — сценарий 2.
 *
 * Загрузка ТЗ/ТУ/ГПЗУ → извлечение атомарных требований локальной моделью.
 * Требование — ДОСЛОВНАЯ выдержка (П13/П14): каждая сверяется с текстом документа
 * кодом; не найденная дословно не попадает в матрицу молча — пишется с пометкой
 * [не сверено дословно] в семантическом поиске не участвует, решает человек.
 */
const config = require('../../config');
const adapter = require('../claude/adapter');
const prompts = require('../prompts');
const db = require('./db');
const store = require('./store');
const corpus = require('./ntd-corpus');
const verify = require('./checks/verify');
const { ensureServiceSession } = require('./checks/llm');

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['requirements'],
  properties: {
    requirements: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['text', 'source_clause', 'addressee_codes'],
        properties: {
          text: { type: 'string' },
          source_clause: { type: 'string' },
          addressee_codes: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
};

async function addInputData(projectId, kind, title, uploads, { uploadedBy } = {}) {
  const project = await store.getProject(projectId);
  if (!project) { const e = new Error('Проект не найден'); e.status = 404; throw e; }
  const fileRows = [];
  for (const up of uploads) {
    fileRows.push(await store.saveFile(up.buffer, up.originalname, up.mimetype, uploadedBy));
  }
  return db.tx(async (client) => {
    await client.query(
      'UPDATE input_data SET is_current = FALSE WHERE project_id = $1 AND kind = $2 AND title = $3 AND is_current',
      [projectId, kind, title]);
    const prev = await client.query(
      'SELECT coalesce(max(version_no),0) AS n FROM input_data WHERE project_id = $1 AND kind = $2 AND title = $3',
      [projectId, kind, title]);
    const r = await client.query(
      `INSERT INTO input_data (project_id, kind, title, version_no) VALUES ($1,$2,$3,$4) RETURNING *`,
      [projectId, kind, title, prev.rows[0].n + 1]);
    for (const f of fileRows) {
      await client.query('INSERT INTO input_data_files (input_id, file_id) VALUES ($1,$2)', [r.rows[0].id, f.id]);
    }
    return { input: r.rows[0], files: fileRows, project };
  });
}

/** Извлечение требований из ИД (LLM + дословная сверка кодом). Асинхронно от HTTP. */
async function extractRequirements(inputId) {
  const input = (await db.query('SELECT * FROM input_data WHERE id = $1', [inputId])).rows[0];
  if (!input) { const e = new Error('ИД не найдены'); e.status = 404; throw e; }
  const project = (await db.query('SELECT * FROM projects WHERE id = $1', [input.project_id])).rows[0];
  const files = (await db.query(
    `SELECT f.* FROM input_data_files l JOIN files f ON f.id = l.file_id WHERE l.input_id = $1`,
    [inputId])).rows;

  let doc = '';
  for (const f of files) {
    const t = (await store.extractText(f)).trim();
    if (t) doc += `### Файл: ${f.original_name}\n${t}\n\n`;
  }
  if (!doc.trim()) return { extracted: 0, unverified: 0, note: 'текст из файлов не извлечён' };
  const truncated = doc.length > 60000;
  if (truncated) doc = doc.slice(0, 60000);

  const sessionId = await ensureServiceSession(project);
  const res = await adapter.structuredCall({
    system: prompts.load('normo-extract-requirements', { kind: input.kind, title: input.title }),
    messages: [{ role: 'user', content: `ТЕКСТ ДОКУМЕНТА:\n\n${doc}` }],
    sessionId,
    route: { provider: 'lmstudio', model: config.localAiModel },
    schema: SCHEMA,
    schemaName: 'normo_requirements',
    maxTokens: 6000,
  });
  const parsed = adapter.tryParse(res.text);
  if (!parsed || !Array.isArray(parsed.requirements)) {
    throw new Error('модель вернула неразборный список требований');
  }

  await db.query('DELETE FROM requirements WHERE input_id = $1', [inputId]);
  let seq = 0;
  let unverified = 0;
  for (const r of parsed.requirements) {
    if (!r.text || r.text.trim().length < 10) continue;
    seq++;
    const verbatim = verify.quoteInText(r.text, doc);
    if (!verbatim) unverified++;
    let embedding = null;
    try {
      [embedding] = await corpus.embed([r.text.slice(0, 2000)]);
    } catch { /* без вектора: семантический поиск по этому требованию недоступен */ }
    await db.query(
      `INSERT INTO requirements (input_id, seq, text, source_doc, source_clause, addressee_codes, status, embedding)
       VALUES ($1,$2,$3,$4,$5,$6,'new',$7)`,
      [inputId, seq,
        verbatim ? r.text : `${r.text} [не сверено дословно — проверить вручную]`,
        `${input.kind}: ${input.title}`,
        (r.source_clause || '').slice(0, 100) || null,
        (r.addressee_codes || []).filter((c) => /^[А-ЯЁ0-9.]{1,8}$/u.test(c)),
        embedding ? `[${embedding.join(',')}]` : null]);
  }
  return { extracted: seq, unverified, truncated };
}

async function listInputData(projectId) {
  const r = await db.query(
    `SELECT i.*,
       (SELECT count(*) FROM requirements q WHERE q.input_id = i.id) AS requirements_count
     FROM input_data i WHERE i.project_id = $1 ORDER BY i.id DESC`, [projectId]);
  return r.rows;
}

async function listRequirements(projectId, { status } = {}) {
  const args = [projectId];
  let filter = '';
  if (status) { args.push(status); filter = `AND q.status = $${args.length}`; }
  const r = await db.query(
    `SELECT q.* FROM requirements q JOIN input_data i ON i.id = q.input_id
     WHERE i.project_id = $1 AND i.is_current ${filter} ORDER BY q.input_id, q.seq`, args);
  return r.rows;
}

/** Матрица трассируемости: требование → покрытия по версиям разделов. */
async function traceability(projectId) {
  const reqs = await listRequirements(projectId);
  const cov = await db.query(
    `SELECT rc.*, v.section_id, s.code AS section_code, v.version_no
     FROM requirement_coverage rc
     JOIN section_versions v ON v.id = rc.version_id
     JOIN sections s ON s.id = v.section_id
     WHERE s.project_id = $1`, [projectId]);
  const byReq = new Map();
  for (const c of cov.rows) {
    if (!byReq.has(c.requirement_id)) byReq.set(c.requirement_id, []);
    byReq.get(c.requirement_id).push(c);
  }
  return reqs.map((q) => ({ ...q, coverage: byReq.get(q.id) || [] }));
}

module.exports = { addInputData, extractRequirements, listInputData, listRequirements, traceability, SCHEMA };
