'use strict';
/**
 * «Замена оборудования A → B» (решение владельца от 27.08.2026, пункт 2).
 *
 * Механика — Excel-протокол канала (пост 358) и его лист «Промпт»
 * (`библиотека-промптов/obshchie/dop-zamena-a-b-protokol.md`, приём Д6):
 * модель НЕ решает, допустима ли замена, — она готовит проверяемую таблицу.
 * У каждого значения B — источник и страница; отсутствие данных — честное
 * «НЕТ ДАННЫХ», а не «вероятно соответствует»; вердикта «аналог подходит»
 * в ответе нет и быть не может — это подгоняет таблицу под вывод.
 * Решение по каждой строке ставит ИНЖЕНЕР; ФИО и дату пишет сервер.
 *
 * Хранение — в основной SQLite по образцу tz/store.js; модель зовётся через
 * служебную сессию и adapter.structuredCall.
 */
const crypto = require('crypto');
const AdmZip = require('adm-zip');
const config = require('../../config');
const { db, now } = require('../../db');
const prompts = require('../prompts');
const storeCommon = require('./store');

db.exec(`
CREATE TABLE IF NOT EXISTS doccheck_ab (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  ai_provider TEXT NOT NULL DEFAULT '',
  ai_model TEXT NOT NULL DEFAULT '',
  req_text TEXT NOT NULL DEFAULT '',
  req_names TEXT NOT NULL DEFAULT '',
  a_text TEXT NOT NULL DEFAULT '',
  a_names TEXT NOT NULL DEFAULT '',
  b_text TEXT NOT NULL DEFAULT '',
  b_names TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft',
  progress TEXT NOT NULL DEFAULT '',
  error_text TEXT NOT NULL DEFAULT '',
  result_json TEXT NOT NULL DEFAULT '',
  service_session_id TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL DEFAULT '',
  created_by_name TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT NOT NULL DEFAULT '',
  deleted_at TEXT
);
CREATE TABLE IF NOT EXISTS doccheck_ab_decisions (
  ab_id TEXT NOT NULL,
  row_id TEXT NOT NULL,
  decision TEXT NOT NULL DEFAULT '',
  comment TEXT NOT NULL DEFAULT '',
  decided_by TEXT NOT NULL DEFAULT '',
  decided_by_name TEXT NOT NULL DEFAULT '',
  decided_at TEXT NOT NULL,
  PRIMARY KEY (ab_id, row_id)
);
`);
// проект платформы, в котором живёт сравнение (services/projects.js, 2026-09-02)
try { db.exec("ALTER TABLE doccheck_ab ADD COLUMN project_id TEXT NOT NULL DEFAULT ''"); } catch { /* колонка уже есть */ }

const { httpError, userName } = storeCommon;

const AB_STATUSES = ['ПОДТВЕРЖДЕНО', 'ТРЕБУЕТ ПРОВЕРКИ', 'НЕ СООТВЕТСТВУЕТ', 'НЕТ ДАННЫХ'];
const AB_CATEGORIES = ['Рабочий режим', 'Электрика', 'Присоединения', 'Геометрия', 'Материалы',
  'Комплектность', 'Условия применения', 'Документы', 'Эксплуатация', 'Прочее'];

const AB_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['rows', 'missing_params', 'supplier_questions', 'affected_sections', 'priority_rows'],
  properties: {
    rows: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['category', 'param', 'requirement', 'value_a', 'value_b', 'unit', 'source_b', 'page_b', 'status', 'risk'],
        properties: {
          category: { type: 'string', enum: AB_CATEGORIES },
          param: { type: 'string' },
          requirement: { type: ['string', 'null'], description: 'Требование проекта/ТЗ; null — требование не сформулировано' },
          value_a: { type: ['string', 'null'] },
          value_b: { type: ['string', 'null'] },
          unit: { type: ['string', 'null'] },
          source_b: { type: ['string', 'null'], description: 'Имя документа, откуда взято значение B' },
          page_b: { type: ['string', 'null'], description: 'Страница/лист источника B' },
          status: { type: 'string', enum: AB_STATUSES },
          risk: { type: ['string', 'null'], description: 'Возможное последствие: расчёт / геометрия / ЭО / автоматика / монтаж / комплектность / эксплуатация' },
        },
      },
    },
    missing_params: { type: 'array', items: { type: 'string' } },
    supplier_questions: { type: 'array', items: { type: 'string' } },
    affected_sections: { type: 'array', items: { type: 'string' } },
    priority_rows: { type: 'array', items: { type: 'string' }, description: 'Параметры, которые инженер проверяет в первую очередь' },
  },
};

/* ---------------- хранение ---------------- */

function createAb({ name, provider, model, user, projectId }) {
  const id = crypto.randomUUID();
  db.prepare(`INSERT INTO doccheck_ab (id, name, ai_provider, ai_model, project_id, created_by, created_by_name, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(id, name, provider || '', model || '', projectId || 'legacy', (user && user.id) || '', userName(user), now(), now());
  return abById(id);
}

function abById(id, { withText = false } = {}) {
  const row = db.prepare('SELECT * FROM doccheck_ab WHERE id = ? AND deleted_at IS NULL').get(id);
  if (!row) return null;
  let result = null;
  try { result = row.result_json ? JSON.parse(row.result_json) : null; } catch { result = null; }
  const decisions = {};
  for (const d of db.prepare('SELECT * FROM doccheck_ab_decisions WHERE ab_id = ?').all(id)) {
    decisions[d.row_id] = { decision: d.decision, comment: d.comment, by: d.decided_by_name, at: d.decided_at };
  }
  const out = {
    ...row, result, decisions,
    req_chars: row.req_text.length, a_chars: row.a_text.length, b_chars: row.b_text.length,
  };
  if (!withText) { delete out.req_text; delete out.a_text; delete out.b_text; }
  delete out.result_json;
  return out;
}

/** ?project=<id платформы> — только сравнения этого проекта; пусто — все. */
function listAb({ projectId = '' } = {}) {
  return db.prepare(`SELECT id, name, ai_provider, ai_model, status, error_text, project_id,
      length(req_text) AS req_chars, length(a_text) AS a_chars, length(b_text) AS b_chars,
      req_names, a_names, b_names, created_by_name, created_at, updated_at, finished_at,
      json_extract(nullif(result_json, ''), '$.summary') AS summary_json
      FROM doccheck_ab WHERE deleted_at IS NULL AND (? = '' OR project_id = ?)
      ORDER BY updated_at DESC`).all(projectId, projectId)
    .map((r) => {
      let summary = null;
      try { summary = r.summary_json ? JSON.parse(r.summary_json) : null; } catch { summary = null; }
      return { ...r, summary, summary_json: undefined };
    });
}

const DOC_KINDS = { req: 'req', a: 'a', b: 'b' };

function appendDoc(id, kind, { name, text }) {
  if (!DOC_KINDS[kind]) throw httpError(400, 'kind должен быть req, a или b');
  const row = db.prepare('SELECT req_text, req_names, a_text, a_names, b_text, b_names FROM doccheck_ab WHERE id = ? AND deleted_at IS NULL').get(id);
  if (!row) throw httpError(404, 'Сравнение не найдено');
  const textCol = `${kind}_text`;
  const namesCol = `${kind}_names`;
  const joined = row[textCol]
    ? `${row[textCol]}\n\n===== Документ: ${name} =====\n\n${text}`
    : `===== Документ: ${name} =====\n\n${text}`;
  // потолок — на блок целиком: документы дописываются друг к другу
  const tooBig = require('../validation').docSizeError(joined);
  if (tooBig) throw httpError(422, tooBig);
  const names = row[namesCol] ? `${row[namesCol]}; ${name}` : name;
  db.prepare(`UPDATE doccheck_ab SET ${textCol} = ?, ${namesCol} = ?, updated_at = ? WHERE id = ?`)
    .run(joined, names, now(), id);
  return abById(id);
}

function clearDocs(id, kind) {
  if (!DOC_KINDS[kind]) throw httpError(400, 'kind должен быть req, a или b');
  const r = db.prepare(`UPDATE doccheck_ab SET ${kind}_text = '', ${kind}_names = '', updated_at = ? WHERE id = ? AND deleted_at IS NULL`)
    .run(now(), id);
  if (!r.changes) throw httpError(404, 'Сравнение не найдено');
  return abById(id);
}

function deleteAb(id) {
  const r = db.prepare('UPDATE doccheck_ab SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL').run(now(), id);
  if (!r.changes) throw httpError(404, 'Сравнение не найдено');
}

function setStatus(id, status, { progress, error, result } = {}) {
  const sets = ['status = ?', 'updated_at = ?'];
  const args = [status, now()];
  if (progress !== undefined) { sets.push('progress = ?'); args.push(progress); }
  if (error !== undefined) { sets.push('error_text = ?'); args.push(error); }
  if (result !== undefined) { sets.push('result_json = ?'); args.push(JSON.stringify(result)); }
  if (status === 'done' || status === 'failed') { sets.push('finished_at = ?'); args.push(now()); }
  args.push(id);
  db.prepare(`UPDATE doccheck_ab SET ${sets.join(', ')} WHERE id = ?`).run(...args);
}

function recoverInterrupted() {
  const r = db.prepare(`UPDATE doccheck_ab SET status = 'failed',
      error_text = 'Сравнение прервано перезапуском сервера — запустите повторно.',
      finished_at = ? WHERE status = 'running'`).run(now());
  if (r.changes) console.log(`[doccheck-ab/recovery] прерванных сравнений: ${r.changes}`);
}

function ensureServiceSession(ab, user, host = '') {
  if (ab.service_session_id) {
    const row = db.prepare('SELECT id, origin_host FROM sessions WHERE id = ?').get(ab.service_session_id);
    if (row) {
      if (host && row.origin_host !== host) {
        db.prepare('UPDATE sessions SET origin_host = ? WHERE id = ?').run(host, row.id);
      }
      return ab.service_session_id;
    }
  }
  const id = crypto.randomUUID();
  db.prepare(`INSERT INTO sessions (id, token, status, device_id, user_id, prompt_version, origin_host, title, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
    id, crypto.randomBytes(32).toString('hex'), 'service', '',
    (user && user.id) || ab.created_by || '', config.promptVersion, host,
    `Замена A→B: ${ab.name}`.slice(0, 60), now(), now());
  db.prepare('UPDATE doccheck_ab SET service_session_id = ? WHERE id = ?').run(id, ab.id);
  return id;
}

/** Решение инженера по строке протокола; ФИО и дату пишет сервер. */
function setRowDecision(abId, rowId, { decision, comment }, user) {
  const ab = abById(abId);
  if (!ab) throw httpError(404, 'Сравнение не найдено');
  const known = ((ab.result && ab.result.rows) || []).some((r) => r.id === rowId);
  if (!known) throw httpError(404, 'Строка не найдена в протоколе');
  if (decision === null || decision === '') {
    db.prepare('DELETE FROM doccheck_ab_decisions WHERE ab_id = ? AND row_id = ?').run(abId, rowId);
    return null;
  }
  if (!AB_STATUSES.includes(decision)) {
    throw httpError(400, `Решение инженера — один из статусов протокола: ${AB_STATUSES.join(' / ')} (или null — снять)`);
  }
  db.prepare(`INSERT INTO doccheck_ab_decisions (ab_id, row_id, decision, comment, decided_by, decided_by_name, decided_at)
      VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(ab_id, row_id) DO UPDATE SET decision = excluded.decision, comment = excluded.comment,
        decided_by = excluded.decided_by, decided_by_name = excluded.decided_by_name, decided_at = excluded.decided_at`)
    .run(abId, rowId, decision, String(comment || '').slice(0, 500), (user && user.id) || '', userName(user), now());
  return { decision, comment: String(comment || '').slice(0, 500), by: userName(user), at: now() };
}

/* ---------------- прогон ---------------- */

const AB_CHAR_LIMIT = 60_000; // на каждый из трёх блоков входа

let overrideCallFn = null;
function _setCallFn(fn) { overrideCallFn = fn; }

const TRANSPORT_RE = /terminated|ECONNRESET|ECONNREFUSED|ETIMEDOUT|timeout|socket hang up|network|обрыв|aborted|fetch failed/i;

/**
 * Чего не хватает для запуска: текст ошибки или null. Зовётся и маршрутом ДО
 * постановки в фон (честный 422), и самим прогоном — правило одно на двоих.
 * Достаточно строки списка: a_chars/b_chars считаются по length, как и trim
 * непустого текста (документ дописывается с заголовком, пустым он не бывает).
 */
function runPrecheck(ab) {
  const has = (kind) => (typeof ab[`${kind}_text`] === 'string' ? ab[`${kind}_text`].trim().length > 0 : ab[`${kind}_chars`] > 0);
  if (!has('a') || !has('b')) return 'Нужны документы обеих моделей: A (проектная) и B (предлагаемая)';
  if (!ab.ai_provider) return 'Не выбрана модель — укажите её в карточке сравнения';
  return null;
}

async function runCompare(abId, { callFn = null, host = '' } = {}) {
  const adapter = require('../claude/adapter');
  const call = callFn || overrideCallFn || adapter.structuredCall;

  const ab = abById(abId, { withText: true });
  if (!ab) throw httpError(404, 'Сравнение не найдено');
  const notReady = runPrecheck(ab);
  if (notReady) throw httpError(422, notReady);

  const route = { provider: ab.ai_provider, model: ab.ai_model };
  const sessionId = ensureServiceSession(ab, null, host);

  const cut = (t) => (t.length > AB_CHAR_LIMIT ? t.slice(0, AB_CHAR_LIMIT) : t);
  const truncated = [ab.req_text, ab.a_text, ab.b_text].some((t) => t.length > AB_CHAR_LIMIT);

  const parts = [];
  parts.push(`1) ТРЕБОВАНИЯ ПРОЕКТА / ТЗ${ab.req_names ? ` (${ab.req_names})` : ''}:\n\n${ab.req_text.trim() ? cut(ab.req_text) : '— требования отдельным документом не переданы: бери обязательные требования из документов модели A и помечай строки без требования —'}`);
  parts.push(`2) ДОКУМЕНТЫ ПРОЕКТНОЙ МОДЕЛИ A${ab.a_names ? ` (${ab.a_names})` : ''}:\n\n${cut(ab.a_text)}`);
  parts.push(`3) ДОКУМЕНТЫ ПРЕДЛАГАЕМОЙ МОДЕЛИ B${ab.b_names ? ` (${ab.b_names})` : ''}:\n\n${cut(ab.b_text)}`);

  setStatus(abId, 'running', { progress: 'модель собирает протокол…', error: '' });
  let out;
  try {
    out = await call({
      system: prompts.load('doccheck-ab'),
      messages: [{ role: 'user', content: parts.join('\n\n──────────\n\n') }],
      sessionId, route, schema: AB_SCHEMA, schemaName: 'doccheck_ab', maxTokens: 24000,
    });
  } catch (err) {
    if (!TRANSPORT_RE.test(String(err && err.message))) throw err;
    setStatus(abId, 'running', { progress: 'обрыв связи — повтор…' });
    await new Promise((r) => setTimeout(r, 2000));
    out = await call({
      system: prompts.load('doccheck-ab'),
      messages: [{ role: 'user', content: parts.join('\n\n──────────\n\n') }],
      sessionId, route, schema: AB_SCHEMA, schemaName: 'doccheck_ab', maxTokens: 24000,
    });
  }
  if (out.truncated) throw new Error('Ответ модели оборван лимитом токенов — сократите документы или выберите модель с большим окном');
  const parsed = adapter.tryParse(out.text || '');
  if (!parsed) throw new Error('Модель вернула неразбираемый ответ');

  const rows = (Array.isArray(parsed.rows) ? parsed.rows : [])
    .filter((r) => r && r.param)
    .map((r, i) => ({
      id: `R-${String(i + 1).padStart(3, '0')}`,
      ...r,
      // «источник или НЕТ ДАННЫХ»: значение B без источника не считается подтверждённым
      status: (r.value_b && !r.source_b && r.status === 'ПОДТВЕРЖДЕНО') ? 'ТРЕБУЕТ ПРОВЕРКИ' : r.status,
      no_source: !!(r.value_b && !r.source_b),
    }));

  const counts = {};
  for (const s of AB_STATUSES) counts[s] = rows.filter((r) => r.status === s).length;

  const result = {
    generated_at: new Date().toISOString(),
    rows,
    missing_params: (parsed.missing_params || []).slice(0, 30),
    supplier_questions: (parsed.supplier_questions || []).slice(0, 30),
    affected_sections: (parsed.affected_sections || []).slice(0, 30),
    priority_rows: (parsed.priority_rows || []).slice(0, 30),
    summary: { rows_count: rows.length, ...counts },
    unverified: [
      {
        what: 'Протокол готовит сравнение, но не заменяет решения',
        why: 'вердикт о допустимости замены в ответе запрещён намеренно — решение по каждой строке ставит инженер с правом подписи',
      },
      ...(truncated ? [{
        what: 'Часть документов обрезана потолком контекста',
        why: `каждый блок входа ограничен ${AB_CHAR_LIMIT.toLocaleString('ru-RU')} символами — проверьте хвосты документов вручную`,
      }] : []),
    ],
  };
  setStatus(abId, 'done', { progress: 'готово', result });
  return result;
}

/* ---------------- экспорт xlsx по форме протокола ---------------- */

const esc = (v) => String(v == null ? '' : v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  // eslint-disable-next-line no-control-regex
  .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, ' ');

const AB_COLS = [
  { label: 'Категория', width: 18 }, { label: 'Параметр', width: 26 },
  { label: 'Требование проекта', width: 22 }, { label: 'Модель A', width: 16 },
  { label: 'Модель B', width: 16 }, { label: 'Ед.', width: 8 },
  { label: 'Источник B', width: 22 }, { label: 'Стр./лист', width: 10 },
  { label: 'Статус', width: 18 }, { label: 'Комментарий / риск', width: 40 },
  { label: 'Решение инженера', width: 18 }, { label: 'Кем / когда', width: 22 },
];

const colLetter = (i) => {
  let s = '';
  for (let n = i; n >= 0; n = Math.floor(n / 26) - 1) { s = String.fromCharCode(65 + (n % 26)) + s; }
  return s;
};

const cellXml = (ref, text, styleId) =>
  `<c r="${ref}" s="${styleId}" t="inlineStr"><is><t xml:space="preserve">${esc(text)}</t></is></c>`;

function protocolXlsx(ab) {
  const result = ab.result || {};
  const rows = result.rows || [];
  const lines = [];
  lines.push(`<row r="1">${AB_COLS.map((c, i) => cellXml(`${colLetter(i)}1`, c.label, 1)).join('')}</row>`);
  let r = 1;
  for (const row of rows) {
    r += 1;
    const d = (ab.decisions || {})[row.id];
    const values = [
      row.category, row.param, row.requirement || '', row.value_a || '', row.value_b || '',
      row.unit || '', row.source_b || (row.value_b ? 'НЕТ ИСТОЧНИКА' : ''), row.page_b || '',
      row.status, row.risk || '',
      d ? d.decision + (d.comment ? ` — ${d.comment}` : '') : '',
      d ? `${d.by || ''} ${String(d.at || '').slice(0, 10)}`.trim() : '',
    ];
    lines.push(`<row r="${r}">${values.map((v, i) => cellXml(`${colLetter(i)}${r}`, v, 2)).join('')}</row>`);
  }
  const block = (title, items) => {
    r += 2;
    lines.push(`<row r="${r}">${cellXml(`A${r}`, title, 1)}</row>`);
    for (const it of items || []) {
      r += 1;
      lines.push(`<row r="${r}">${cellXml(`A${r}`, `— ${it}`, 2)}</row>`);
    }
  };
  block('Каких параметров не хватает', result.missing_params);
  block('Вопросы производителю / поставщику', result.supplier_questions);
  block('Затронутые смежные разделы', result.affected_sections);
  block('Проверить в первую очередь', result.priority_rows);

  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<cols>${AB_COLS.map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${c.width}" customWidth="1"/>`).join('')}</cols>
<sheetData>${lines.join('')}</sheetData>
</worksheet>`;

  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="2"><font><sz val="10"/><name val="Calibri"/></font><font><b/><sz val="10"/><name val="Calibri"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFEFEBE0"/></patternFill></fill></fills>
<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border>
<border><left style="thin"><color rgb="FFBFB8A8"/></left><right style="thin"><color rgb="FFBFB8A8"/></right><top style="thin"><color rgb="FFBFB8A8"/></top><bottom style="thin"><color rgb="FFBFB8A8"/></bottom><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="3">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
</cellXfs>
</styleSheet>`;

  const zip = new AdmZip();
  zip.addFile('[Content_Types].xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`, 'utf8'));
  zip.addFile('_rels/.rels', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`, 'utf8'));
  zip.addFile('xl/workbook.xml', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="Протокол A→B" sheetId="1" r:id="rId1"/></sheets></workbook>`, 'utf8'));
  zip.addFile('xl/_rels/workbook.xml.rels', Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`, 'utf8'));
  zip.addFile('xl/styles.xml', Buffer.from(styles, 'utf8'));
  zip.addFile('xl/worksheets/sheet1.xml', Buffer.from(sheet, 'utf8'));
  return zip.toBuffer();
}

module.exports = {
  AB_STATUSES, AB_CATEGORIES, AB_SCHEMA, AB_CHAR_LIMIT,
  createAb, abById, listAb, appendDoc, clearDocs, deleteAb, setStatus, recoverInterrupted,
  setRowDecision, runCompare, runPrecheck, protocolXlsx, _setCallFn,
};
