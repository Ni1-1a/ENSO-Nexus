'use strict';
/**
 * Модуль «Вопрос по нормам» — седьмой модуль проекта (решение владельца
 * 07.10.2026 по разбору ArmetaCAD, ENSO-Nexus/Развитие/2026-10-07 — ArmetaCAD.md):
 * вопрос к базе знаний из любого проекта, ответ со ссылками на документ и
 * пункт, у каждой ссылки — статус от КОДА (services/ntd-cite.js). Базы знаний —
 * обе с выбором («Общая база» / «Верифицировано»), корпус нормоконтроля
 * (PostgreSQL + pgvector) подключается по отметке.
 *
 * Устройство — как у «Анализа ТЗ»: таблица в основной SQLite вне TTL сессий,
 * ответ готовится в фоне (queued → running → done | failed, клиент опрашивает),
 * обращение к модели — через служебную сессию проекта и adapter.structuredCall.
 * Служебная сессия своя У КАЖДОГО ЧЕЛОВЕКА (как в обсуждении фрагмента): гейт
 * облака и «чей расход» решают по sessions.user_id.
 *
 * Правило платформы здесь выглядит так: поиск по базе делает код (kb.search),
 * модель отвечает ТОЛЬКО по найденным выдержкам, а каждую её ссылку код
 * сверяет с выдержкой — документ, пункт, дословная цитата. Выдержек нет —
 * модель не вызывается вовсе: без материала она может только выдумать.
 */
const crypto = require('node:crypto');
const { db, now } = require('../db');
const config = require('../config');
const projects = require('./projects');
const kb = require('./kb');
const ntdCite = require('./ntd-cite');

db.exec(`
CREATE TABLE IF NOT EXISTS ntd_questions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL DEFAULT '',
  question TEXT NOT NULL,
  kb TEXT NOT NULL DEFAULT 'main',          -- main | verified
  corpus INTEGER NOT NULL DEFAULT 0,        -- 1 — подключён корпус нормоконтроля
  status TEXT NOT NULL DEFAULT 'queued',    -- queued | running | done | failed
  progress TEXT NOT NULL DEFAULT '',
  error_text TEXT NOT NULL DEFAULT '',
  provider TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  excerpts_json TEXT NOT NULL DEFAULT '[]', -- что ушло модели: по номерам сверяются ссылки
  result_json TEXT,
  created_by TEXT NOT NULL DEFAULT '',
  created_by_name TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_ntd_questions_project ON ntd_questions(project_id, deleted_at, created_at);
`);

const MAX_QUESTION = 2000;
const KB_TOP = 8;        // выдержек из базы знаний
const CORPUS_TOP = 4;    // выдержек из корпуса нормоконтроля
const MAX_TOKENS = 6000;
const SERVICE_TITLE = 'Вопрос по нормам';
const PROJECT_ID_RE = /^[\w-]{1,64}$/;
// один повтор и только на транспортную ошибку (правило датасета и ТЗ)
const TRANSPORT_RE = /terminated|ECONNRESET|ECONNREFUSED|ETIMEDOUT|timeout|socket hang up|network|обрыв|aborted|fetch failed/i;

/** Схема ответа модели: текст, нашёлся ли ответ, ссылки, недостающее, аномалии. */
const ANSWER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['answer', 'found', 'citations', 'missing', 'anomalies'],
  properties: {
    answer: { type: 'string', description: 'Ответ по-русски; после каждого утверждения — номер выдержки [n]' },
    found: { type: 'boolean', description: 'true — выдержек хватило для ответа; false — в базе ответа нет' },
    citations: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['n', 'doc', 'clause', 'quote', 'claim'],
        properties: {
          n: { type: ['integer', 'null'], description: 'Номер выдержки или null' },
          doc: { type: 'string', description: 'Обозначение документа дословно как в выдержке' },
          clause: { type: ['string', 'null'], description: 'Номер пункта как в выдержке' },
          quote: { type: 'string', description: 'Дословная цитата из выдержки, до 40 слов' },
          claim: { type: 'string', description: 'Какое утверждение ответа подтверждает' },
        },
      },
    },
    missing: { type: 'array', items: { type: 'string' } },
    anomalies: { type: 'array', items: { type: 'string' } },
  },
};

// вызов модели идёт только через adapter.structuredCall; в тестах подменяется _setCallFn
let overrideCallFn = null;
function _setCallFn(fn) { overrideCallFn = fn; }

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

const clip = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
const userName = (user) => (user ? `${user.lastName || ''} ${user.firstName || ''}`.trim() : '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function plural(n, one, few, many) {
  const m10 = n % 10; const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return `${n} ${one}`;
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return `${n} ${few}`;
  return `${n} ${many}`;
}

/**
 * Служебная сессия проекта для обращения к модели — своя у каждого человека
 * (гейт облака и «чей расход» решают по sessions.user_id, см. fragment-chat.js).
 */
function ensureServiceSession(projectId, uid, host) {
  const pid = projectId || projects.LEGACY_ID;
  const originHost = String(host || '').toLowerCase();
  const row = db.prepare("SELECT id FROM sessions WHERE project_id = ? AND status = 'service' AND title = ? AND user_id = ? LIMIT 1")
    .get(pid, SERVICE_TITLE, uid || '');
  if (row) {
    db.prepare('UPDATE sessions SET origin_host = ?, updated_at = ? WHERE id = ?').run(originHost, now(), row.id);
    return row.id;
  }
  const id = crypto.randomUUID();
  db.prepare(`INSERT INTO sessions (id, token, token_hash, status, device_id, user_id, prompt_version, origin_host, title, project_id, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, '', crypto.createHash('sha256').update(crypto.randomBytes(32)).digest('hex'), 'service', '',
      uid || '', config.promptVersion, originHost, SERVICE_TITLE, pid, now(), now());
  return id;
}

/** Проект вопроса: пусто — «Ранние работы», не по форме — 400, чужой или удалённый — 404. */
function resolveProject(raw, user) {
  if (raw != null && typeof raw !== 'string') throw httpError(400, 'Некорректный идентификатор проекта');
  const s = String(raw == null ? '' : raw).trim();
  if (!s) { projects.ensureLegacy(); return projects.LEGACY_ID; }
  if (!PROJECT_ID_RE.test(s)) throw httpError(400, 'Некорректный идентификатор проекта');
  const access = projects.accessTo(s, user);
  if (!access.see) throw httpError(404, 'Проект не найден');
  if (access.deleted) throw httpError(404, 'Проект не найден');
  return s;
}

/* ---------------- корпус нормоконтроля ---------------- */

/**
 * Доступен ли корпус НТД модуля «Нормоконтроль» (pgvector). Отказ запоминается
 * на полминуты, как у сводки проектов: иначе каждый открытый экран ждал бы
 * таймаут подключения заново.
 */
const CORPUS_DOWN_MS = 30_000;
const CORPUS_TTL_MS = 60_000;
let corpusDownUntil = 0;
let corpusCache = null;

async function corpusInfo() {
  if (Date.now() < corpusDownUntil) return { available: false, reason: 'база нормоконтроля недоступна', docs: [] };
  if (corpusCache && Date.now() - corpusCache.at < CORPUS_TTL_MS) return corpusCache.value;
  try {
    const ndb = require('./normo/db');
    await ndb.migrate();
    const r = await ndb.query(
      `SELECT d.code, count(c.doc_id)::int AS chunks FROM ntd_docs d
         LEFT JOIN ntd_chunks c ON c.doc_id = d.id GROUP BY d.code ORDER BY d.code`);
    const docs = r.rows.filter((x) => x.chunks > 0).map((x) => ({ code: x.code, chunks: x.chunks }));
    const value = {
      available: docs.length > 0,
      reason: docs.length ? '' : 'корпус пуст — загрузите его (server/services/normo/ntd-corpus.js load)',
      docs,
    };
    corpusCache = { at: Date.now(), value };
    corpusDownUntil = 0;
    return value;
  } catch (err) {
    corpusDownUntil = Date.now() + CORPUS_DOWN_MS;
    return { available: false, reason: `база нормоконтроля недоступна: ${err.message}`, docs: [] };
  }
}

/** Для тестов: забыть, что корпус был недоступен. */
function _resetCorpus() { corpusDownUntil = 0; corpusCache = null; }

/* ---------------- вопросы ---------------- */

function rowById(id) {
  return db.prepare('SELECT * FROM ntd_questions WHERE id = ?').get(id) || null;
}

function toView(r, full) {
  let result = null;
  try { result = r.result_json ? JSON.parse(r.result_json) : null; } catch { result = null; }
  const out = {
    id: r.id,
    projectId: r.project_id,
    question: r.question,
    kb: r.kb,
    corpus: !!r.corpus,
    status: r.status,
    progress: r.progress || '',
    error: r.error_text || '',
    provider: r.provider,
    model: r.model,
    createdBy: r.created_by,
    createdByName: r.created_by_name,
    createdAt: r.created_at,
    finishedAt: r.finished_at || null,
    found: result ? !!result.found : null,
    counts: result ? result.counts || null : null,
  };
  if (full) {
    out.result = result;
    try { out.excerpts = JSON.parse(r.excerpts_json || '[]'); } catch { out.excerpts = []; }
  }
  return out;
}

function view(id) {
  const r = rowById(id);
  if (!r) throw httpError(404, 'Вопрос не найден');
  return toView(r, true);
}

/** Отказ по правилу записи модуля: чужой проект — 404, чужая запись на правку — 403. */
function denial(row, user, opts = {}) {
  return projects.entityDenial(row, user, { notFound: 'Вопрос не найден', ...opts });
}

/** Вопрос по ссылке — читает тот, кто видит проект. */
function get(id, user) {
  const r = rowById(id);
  const d = denial(r, user);
  if (d) throw httpError(d.status, d.error);
  if (r.deleted_at) throw httpError(404, 'Вопрос не найден');
  return toView(r, true);
}

/** Задать вопрос: запись заводится здесь, ответ готовит start(). */
function create({ projectId = '', question, kbId = '', corpus = false, user = null }) {
  if (question != null && typeof question !== 'string') throw httpError(400, 'Поле question должно быть строкой');
  const text = clip(question, MAX_QUESTION + 1);
  if (!text) throw httpError(422, 'Задайте вопрос — искать нечего');
  if (text.length > MAX_QUESTION) throw httpError(422, `Вопрос длиннее ${MAX_QUESTION} знаков — сократите его`);
  if (!config.kbBases.length) throw httpError(503, 'База знаний не подключена: задайте KB_DIR на сервере');
  if (kbId != null && typeof kbId !== 'string') throw httpError(400, 'Поле kb должно быть строкой');
  const base = kbId ? String(kbId) : (config.kbBases.find((b) => b.id === 'main') || config.kbBases[0]).id;
  if (!config.kbBases.some((b) => b.id === base)) throw httpError(400, `Неизвестная база знаний: ${base}`);
  if (corpus !== undefined && corpus !== null && typeof corpus !== 'boolean') throw httpError(400, 'Поле corpus должно быть true или false');
  const pid = resolveProject(projectId, user);
  // нейросеть — ТОЛЬКО проектная, тело запроса её не задаёт (решение владельца 10.09.2026)
  const ai = projects.aiChoice(pid);
  if (!ai.provider) throw httpError(422, 'У проекта не выбрана нейросеть. Откройте «Свойства проекта» на главной и выберите её.');
  const id = crypto.randomUUID();
  db.prepare(`INSERT INTO ntd_questions
      (id, project_id, question, kb, corpus, status, provider, model, created_by, created_by_name, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, pid, text, base, corpus ? 1 : 0, 'queued', ai.provider, ai.model || '',
      (user && user.id) || '', userName(user), now(), now());
  projects.touch(pid);
  return toView(rowById(id), true);
}

/** Вопросы проекта (или всех видимых проектов), новые сверху. */
function list({ projectId = '', user = null, limit = 50 } = {}) {
  const pid = projects.filterId(projectId, user);
  const n = Math.max(1, Math.min(200, limit));
  let rows;
  if (pid) {
    rows = db.prepare('SELECT * FROM ntd_questions WHERE project_id = ? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT ?').all(pid, n);
  } else {
    rows = projects.onlyVisible(
      db.prepare('SELECT * FROM ntd_questions WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT ?').all(n * 4), user,
    ).slice(0, n);
  }
  return rows.map((r) => toView(r, false));
}

/** Мягкое удаление: автор вопроса или владелец проекта. */
function remove(id, user) {
  const r = rowById(id);
  const d = denial(r, user, { write: true });
  if (d) throw httpError(d.status, d.error);
  if (r.deleted_at) throw httpError(404, 'Вопрос не найден');
  db.prepare('UPDATE ntd_questions SET deleted_at = ?, updated_at = ? WHERE id = ?').run(now(), now(), id);
  return true;
}

function setProgress(id, progress) {
  db.prepare("UPDATE ntd_questions SET status = 'running', progress = ?, updated_at = ? WHERE id = ?").run(progress, now(), id);
}

/* ---------------- поиск ---------------- */

/**
 * Выдержки для модели: сначала база знаний, затем (по отметке) корпус
 * нормоконтроля. Режим поиска по базе (по смыслу / по словам) запоминается —
 * человек должен видеть, что эмбеддинги были выгружены, а не гадать, почему
 * выдержки не о том.
 */
async function retrieve(row) {
  const meta = {};
  const found = await kb.search(row.question, KB_TOP, row.kb, meta);
  const base = config.kbBases.find((b) => b.id === row.kb);
  const excerpts = found.map((f, i) => ({ n: i + 1, doc: f.doc, clause: f.clause || '', text: f.text, source: 'kb' }));
  const search = {
    kb: row.kb,
    kbLabel: base ? base.label : row.kb,
    mode: meta.mode || 'none',
    kbCount: found.length,
    corpus: row.corpus ? 'ok' : 'off',
    corpusCount: 0,
    corpusNote: '',
  };
  if (row.corpus) {
    try {
      const corpus = require('./normo/ntd-corpus');
      const rows = await corpus.search(row.question, { limit: CORPUS_TOP });
      for (const r of rows) {
        excerpts.push({
          n: excerpts.length + 1,
          doc: r.code,
          clause: r.clause && r.clause !== '0' ? String(r.clause) : '',
          text: r.body,
          source: 'corpus',
        });
      }
      search.corpusCount = rows.length;
    } catch (err) {
      search.corpus = 'unavailable';
      search.corpusNote = String(err.message || err).slice(0, 300);
    }
  }
  return { excerpts, search };
}

/* ---------------- ответ ---------------- */

/**
 * Разбор ответа модели + сверка кодом. Ничего не выбрасывается: ссылка без
 * подтверждения остаётся в списке со статусом и причиной, документ, названный
 * в тексте без записи в citations, попадает в uncited, а [n] без записи — в dangling.
 */
function normalizeResult(parsed, excerpts, search) {
  const strArr = (v) => (Array.isArray(v) ? v.map((x) => clip(x, 500)).filter(Boolean).slice(0, 20) : []);
  const answer = clip(parsed.answer, 20000);
  const citations = ntdCite.verifyCitations(Array.isArray(parsed.citations) ? parsed.citations.slice(0, 40) : [], excerpts);
  const uncited = ntdCite.refsInText(answer, excerpts)
    .filter((r) => !citations.some((c) => ntdCite.sameDoc(c.doc, r.code)));
  const mentioned = [...answer.matchAll(/\[(\d{1,2})\]/g)].map((m) => Number(m[1]));
  const dangling = [...new Set(mentioned.filter((n) => !citations.some((c) => c.excerpt === n || c.n === n)))];
  const notes = [];
  let found = typeof parsed.found === 'boolean' ? parsed.found : citations.length > 0;
  if (found && !citations.length) {
    found = false;
    notes.push('Модель сочла, что ответ есть, но ни одной ссылки на выдержку не дала — ответ понижен до «в базе не найдено»');
  }
  if (dangling.length) notes.push(`В тексте есть ссылки [${dangling.join('], [')}] без записи в списке ссылок`);
  if (uncited.length) notes.push(`В тексте названы документы без ссылки на выдержку: ${uncited.map((u) => u.code).join(', ')}`);
  const counts = ntdCite.summarize(citations);
  if (citations.length && !counts.confirmed) notes.push('Ни одна ссылка не подтверждена выдержкой дословно — проверьте ответ по документам');
  return {
    answer,
    found,
    citations,
    counts,
    missing: strArr(parsed.missing),
    anomalies: strArr(parsed.anomalies),
    uncited,
    dangling,
    notes,
    search,
    modelCalled: true,
  };
}

const running = new Set();

/**
 * Запись в SQLite с повтором на «database is locked»: пока идёт переиндексация
 * базы знаний из другого процесса (npm run kb:index), запись может упереться
 * в чужую блокировку — и вопрос навсегда оставался «идёт» (стенд 07.10.2026).
 */
async function writeWithRetry(fn, attempts = 6) {
  for (let i = 1; ; i += 1) {
    try { return fn(); } catch (err) {
      if (i >= attempts || !/locked|busy/i.test(String(err && err.message))) throw err;
      await sleep(250 * i);
    }
  }
}

/** Полный прогон вопроса: поиск → модель → сверка. Ошибки — в строку вопроса, наружу не летят. */
async function run(id, { callFn = null, host = '' } = {}) {
  const row = rowById(id);
  if (!row) return;
  const adapter = require('./claude/adapter');
  const prompts = require('./prompts');
  const call = callFn || overrideCallFn || adapter.structuredCall;
  try {
    await writeWithRetry(() => setProgress(id, 'поиск в базе знаний…'));
    const { excerpts, search } = await retrieve(row);
    await writeWithRetry(() => db.prepare('UPDATE ntd_questions SET excerpts_json = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(excerpts), now(), id));
    const project = row.project_id ? projects.byIdAny(row.project_id) : null;
    let result;
    if (!excerpts.length) {
      // без выдержек модель не зовём: ей не на что опереться, а бюджет проекта — не бесплатный
      const where = [`в базе «${search.kbLabel}»`, search.corpus === 'ok' ? 'и в корпусе нормоконтроля' : '']
        .filter(Boolean).join(' ');
      result = {
        answer: `В базе знаний по этому вопросу ничего не найдено (поиск ${where}${search.mode === 'keyword' ? ', по словам' : ''}). ` +
          'Модель не вызывалась: без выдержек ей не на что опереться. Переформулируйте вопрос ближе к тексту нормы или проверьте документ вне платформы.',
        found: false,
        citations: [],
        counts: ntdCite.summarize([]),
        missing: [`Выдержек не найдено ${where}${search.corpus === 'unavailable' ? ` (корпус нормоконтроля недоступен: ${search.corpusNote})` : ''}`],
        anomalies: [],
        uncited: [],
        dangling: [],
        notes: [],
        search,
        modelCalled: false,
      };
    } else {
      await writeWithRetry(() => setProgress(id, `ответ модели по ${plural(excerpts.length, 'выдержке', 'выдержкам', 'выдержкам')}…`));
      const sessionId = ensureServiceSession(row.project_id, row.created_by, host);
      // лимиты проекта считаются как везде
      adapter.checkBudget(db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId));
      const route = { provider: row.provider, model: row.model || '' };
      // ограду вопрос закрыть не должен: иначе текст с тройной кавычкой подделал бы служебные строки
      const fenced = (v) => String(v).replace(/"{3,}/g, '""');
      const content = [
        project ? `ПРОЕКТ: ${project.name}${project.full_name ? ` — ${project.full_name}` : ''}${project.stage ? `, стадия ${project.stage}` : ''}` : '',
        `ВОПРОС:\n"""\n${fenced(row.question)}\n"""`,
        `<knowledge_base>\n${ntdCite.formatExcerpts(excerpts, { title: `Выдержки из базы знаний «${search.kbLabel}»` })}\n</knowledge_base>`,
      ].filter(Boolean).join('\n\n');
      const args = {
        system: prompts.load('ntd-ask'),
        messages: [{ role: 'user', content }],
        sessionId,
        route,
        schema: ANSWER_SCHEMA,
        schemaName: 'ntd_answer',
        maxTokens: MAX_TOKENS,
      };
      let out;
      try {
        out = await call(args);
      } catch (err) {
        if (!TRANSPORT_RE.test(String(err && err.message))) throw err;
        await writeWithRetry(() => setProgress(id, 'обрыв связи — повтор…'));
        await sleep(2000);
        out = await call(args);
      }
      if (out.truncated) throw new Error('Ответ модели оборван лимитом токенов — задайте вопрос короче или выберите модель с большим окном');
      const parsed = adapter.tryParse(out.text || '');
      if (!parsed || typeof parsed !== 'object') throw new Error('Модель вернула неразбираемый ответ — повторите вопрос');
      result = normalizeResult(parsed, excerpts, search);
    }
    await writeWithRetry(() => db.prepare(`UPDATE ntd_questions SET status = 'done', progress = '', result_json = ?, finished_at = ?, updated_at = ? WHERE id = ?`)
      .run(JSON.stringify(result), now(), now(), id));
  } catch (err) {
    const text = String((err && err.message) || err).slice(0, 2000);
    try {
      await writeWithRetry(() => db.prepare(`UPDATE ntd_questions SET status = 'failed', progress = '', error_text = ?, finished_at = ?, updated_at = ? WHERE id = ?`)
        .run(text, now(), now(), id));
    } catch (err2) {
      // даже отметку об ошибке не записать — хотя бы сказать об этом в журнале
      console.error(`[ntd] вопрос ${id} упал (${text}) и не отмечен: ${err2.message}`);
    }
  } finally {
    running.delete(id);
  }
}

/** Запуск в фоне: маршрут отвечает 202 сразу, клиент опрашивает вопрос. */
function start(id, opts = {}) {
  if (running.has(id)) return false;
  running.add(id);
  setImmediate(() => run(id, opts).catch((err) => console.error('[ntd] вопрос упал:', err.message)));
  return true;
}

/** Вопросы, прерванные перезапуском, помечаются ошибкой при первом обращении к модулю. */
function recoverInterrupted() {
  const r = db.prepare(`UPDATE ntd_questions SET status = 'failed', progress = '',
      error_text = 'Ответ прерван перезапуском сервера — задайте вопрос ещё раз.',
      finished_at = ?, updated_at = ? WHERE status IN ('queued','running')`).run(now(), now());
  if (r.changes) console.log(`[ntd/recovery] прерванных вопросов: ${r.changes}`);
}

/* ---------------- сводка для проекта ---------------- */

/** Строка состояния модуля в сводке проекта (projects.summarize). */
function summary(projectId) {
  const row = db.prepare('SELECT count(*) AS n, max(created_at) AS at FROM ntd_questions WHERE project_id = ? AND deleted_at IS NULL')
    .get(projectId);
  if (!row || !row.n) return { state: 'none', count: 0, line: 'Не задавался' };
  const last = db.prepare('SELECT status, result_json FROM ntd_questions WHERE project_id = ? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1')
    .get(projectId);
  const n = plural(row.n, 'вопрос', 'вопроса', 'вопросов');
  if (last.status === 'queued' || last.status === 'running') return { state: 'run', count: row.n, line: `${n} · идёт ответ`, at: row.at };
  if (last.status === 'failed') return { state: 'bad', count: row.n, line: `${n} · последний упал`, at: row.at };
  let found = null;
  try { found = JSON.parse(last.result_json || '{}').found; } catch { found = null; }
  if (found === false) return { state: 'warn', count: row.n, line: `${n} · последний: в базе ответа нет`, at: row.at };
  return { state: 'ok', count: row.n, line: `${n} · последний отвечен`, at: row.at };
}

module.exports = {
  MAX_QUESTION, KB_TOP, CORPUS_TOP, MAX_TOKENS, SERVICE_TITLE, ANSWER_SCHEMA,
  create, start, run, get, view, list, remove, summary, corpusInfo, recoverInterrupted,
  retrieve, normalizeResult, _setCallFn, _resetCorpus,
};
