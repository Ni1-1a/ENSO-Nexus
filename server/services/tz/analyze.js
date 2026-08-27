'use strict';
/**
 * Конвейер анализа ТЗ: три структурных прохода модели + детерминированная сборка.
 *
 *   1. classify     — тип объекта, финансирование, ОПО, экспертиза (короткий текст);
 *   2. completeness — матрица полноты по чек-листу состава;
 *   3. findings     — дефекты формулировок, противоречия, нормативные ссылки, ИРД.
 *
 * Дальше работает КОД, не модель (правило платформы):
 *   - находки полноты выводятся из матрицы детерминированно, с реквизитами
 *     источника из checklists.js — модель реквизиты не сочиняет;
 *   - дедупликация и вердикт — dedup.js (спека v1.1, правки 3–4);
 *   - находки категории «нормативная_база» принудительно needs_human: true —
 *     в v1 модуль НЕ проверяет статус НПА по внешним источникам, и отчёт
 *     всегда несёт пометку «нормативная актуальность не проверялась».
 *
 * Вызов модели — ТОЛЬКО через adapter.structuredCall (свои HTTP-клиенты модулю
 * не положены); callFn подменяется в тестах через _setCallFn.
 */
const config = require('../../config');
const prompts = require('../prompts');
const store = require('./store');
const checklists = require('./checklists');
const { dedupe, verdict } = require('./dedup');

// Потолок текста ЗнП, уходящего модели за один проход. Обрезка честно
// проговаривается в unverified — молча урезанный документ выглядит проверенным.
const ANALYZE_CHAR_LIMIT = 180_000;

let overrideCallFn = null;
function _setCallFn(fn) { overrideCallFn = fn; }

/* ---------------- схемы структурных ответов ----------------
 * Правило платформы: в каждом объекте required перечисляет ВСЕ ключи properties,
 * необязательность — союз с null (для локальных движков адаптер сам переписывает
 * союз в anyOf). */

const CLASSIFY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['checklist', 'object_kind', 'funding', 'work_kind', 'is_opo', 'is_unique_48_1',
    'expertise', 'is_repeat_expertise', 'region', 'cadastral', 'notes'],
  properties: {
    checklist: { type: 'string', enum: ['production', 'housing', 'другое'] },
    object_kind: { type: 'string', description: 'Короткое описание объекта своими словами' },
    funding: { type: 'string', enum: ['бюджет', 'внебюджет', 'смешанное', 'неизвестно'] },
    work_kind: { type: 'string', enum: ['строительство', 'реконструкция', 'капремонт', 'снос', 'неизвестно'] },
    is_opo: { type: ['boolean', 'null'] },
    is_unique_48_1: { type: ['boolean', 'null'] },
    expertise: { type: 'string', enum: ['государственная', 'негосударственная', 'не требуется', 'неизвестно'] },
    is_repeat_expertise: { type: ['boolean', 'null'] },
    region: { type: ['string', 'null'] },
    cadastral: { type: ['string', 'null'] },
    notes: { type: 'string' },
  },
};

function completenessSchema(checklist) {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['items'],
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'status', 'znp_ref', 'note'],
          properties: {
            id: { type: 'string', enum: checklist.items.map((i) => i.id) },
            status: { type: 'string', enum: checklists.ITEM_STATUSES },
            znp_ref: { type: ['string', 'null'] },
            note: { type: 'string' },
          },
        },
      },
    },
  };
}

const FINDINGS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['severity', 'category', 'znp_ref', 'quote', 'problem', 'consequence', 'proposed_text', 'needs_human'],
        properties: {
          severity: { type: 'string', enum: checklists.SEVERITIES },
          category: { type: 'string', enum: ['формулировка', 'противоречие', 'нормативная_база', 'ИРД'] },
          znp_ref: { type: 'string', description: 'Пункт/раздел ЗнП или короткий ориентир' },
          quote: { type: ['string', 'null'], description: 'Дословная цитата дефектного места' },
          problem: { type: 'string' },
          consequence: {
            type: 'string',
            enum: ['отказ в приёме', 'отрицательное заключение', 'переделка ПД', 'удорожание', 'срыв срока'],
          },
          proposed_text: { type: ['string', 'null'] },
          needs_human: { type: 'boolean' },
        },
      },
    },
  },
};

/* ---------------- сборка входа ---------------- */

function documentForModel(text) {
  const truncated = text.length > ANALYZE_CHAR_LIMIT;
  return {
    text: truncated ? text.slice(0, ANALYZE_CHAR_LIMIT) : text,
    truncated,
  };
}

function checklistItemsText(checklist) {
  return checklist.items.map((i) => `- ${i.id}: ${i.label}`).join('\n');
}

function objectSummary(cls, projectObject) {
  const parts = [];
  const val = (x, fallback = 'неизвестно') => (x === null || x === undefined || x === '' ? fallback : x);
  parts.push(`объект: ${val(cls.object_kind, '—')}`);
  parts.push(`вид работ: ${val(projectObject.work_kind || cls.work_kind)}`);
  parts.push(`финансирование: ${val(projectObject.funding || cls.funding)}`);
  parts.push(`ОПО: ${cls.is_opo === true ? 'да' : cls.is_opo === false ? 'нет' : 'неизвестно'}`);
  parts.push(`экспертиза: ${val(cls.expertise)}`);
  if (cls.region) parts.push(`регион: ${cls.region}`);
  if (cls.cadastral) parts.push(`КН: ${cls.cadastral}`);
  return parts.join('; ');
}

/* ---------------- детерминированные находки полноты ---------------- */

function completenessFindings(matrix, checklist, funding) {
  const out = [];
  const byId = new Map(checklist.items.map((i) => [i.id, i]));
  for (const row of matrix) {
    const item = byId.get(row.item_id);
    if (!item) continue;
    const severity = checklists.missingSeverity(item, row.status, funding);
    if (!severity) continue;
    out.push({
      severity,
      category: 'полнота',
      znp_ref: row.status === 'НЕТ' ? 'отсутствует' : (row.znp_ref || 'отсутствует'),
      quote: null,
      problem: row.status === 'НЕТ'
        ? `В ЗнП нет пункта: ${item.label}${row.note ? ` (${row.note})` : ''}`
        : `Пункт раскрыт неполно: ${item.label}${row.note ? ` (${row.note})` : ''}`,
      requirement_source: checklists.findingSource(item, funding),
      consequence: severity === 'БЛОКЕР' ? 'отказ в приёме' : 'переделка ПД',
      proposed_text: null,
      needs_human: false,
      checklist_item: item.id,
    });
  }
  return out;
}

/* ---------------- конвейер ---------------- */

/**
 * Полный прогон анализа для записи tz_runs. Пишет прогресс в строку прогона,
 * результат — в result_json. Ошибки наружу: вызывающий переводит прогон в failed.
 */
async function runAnalysis(runId, { callFn = null, host = '' } = {}) {
  const adapter = require('../claude/adapter');
  const call = callFn || overrideCallFn || adapter.structuredCall;

  const run = store.runById(runId, { withText: true });
  if (!run) throw store.httpError(404, 'Прогон не найден');
  const project = store.projectById(run.project_id);
  if (!project) throw store.httpError(404, 'Проект не найден');
  if (!run.document_text.trim()) throw store.httpError(422, 'В проекте нет текста ЗнП — загрузите документ');
  if (!run.provider) throw store.httpError(422, 'Не выбрана модель для анализа');

  const route = { provider: run.provider, model: run.model };
  const sessionId = store.ensureServiceSession(project, null, host);
  const doc = documentForModel(run.document_text);
  const unverified = [];
  if (doc.truncated) {
    unverified.push({
      what: `Текст ЗнП обрезан до ${ANALYZE_CHAR_LIMIT.toLocaleString('ru-RU')} символов из ${run.document_text.length.toLocaleString('ru-RU')}`,
      why: 'потолок контекста одного прохода — хвост документа не проверялся',
    });
  }
  unverified.push({
    what: 'Актуальность нормативных документов, названных в ЗнП, и региональные данные площадки',
    why: 'в этой версии модуль работает без внешних источников — статусы НПА и параметры площадки не сверялись',
  });

  // Один ретрай и только на транспортную ошибку (правило датасета): обрыв
  // потока через реле тайлнета — штатное событие, а не повод ронять прогон.
  // Содержательная ошибка (отказ провайдера, кончился бюджет) не повторяется.
  const TRANSPORT_RE = /terminated|ECONNRESET|ECONNREFUSED|ETIMEDOUT|timeout|socket hang up|network|обрыв|aborted|fetch failed/i;
  const callWithRetry = async (args, stage) => {
    try {
      return await call(args);
    } catch (err) {
      if (!TRANSPORT_RE.test(String(err && err.message))) throw err;
      store.setRunProgress(runId, `обрыв связи на шаге «${stage}» — повтор…`);
      await new Promise((r) => setTimeout(r, 2000));
      return call(args);
    }
  };

  const parse = (out, stage) => {
    if (out.truncated) {
      throw new Error(`Ответ модели на шаге «${stage}» оборван лимитом токенов — повторите прогон или выберите модель с большим окном`);
    }
    const parsed = adapter.tryParse(out.text || '');
    if (!parsed) throw new Error(`Модель вернула неразбираемый ответ на шаге «${stage}»`);
    return parsed;
  };

  // 1. Классификация
  store.setRunProgress(runId, 'классификация объекта (1/3)…');
  const clsOut = await callWithRetry({
    system: prompts.load('tz-classify'),
    messages: [{ role: 'user', content: `Текст задания на проектирование:\n\n${doc.text}` }],
    sessionId, route, schema: CLASSIFY_SCHEMA, schemaName: 'tz_classify', maxTokens: 8000,
  }, 'классификация');
  const cls = parse(clsOut, 'классификация');

  // Чек-лист: выбор человека в проекте сильнее догадки модели
  const checklistId = project.checklist && checklists.CHECKLISTS[project.checklist]
    ? project.checklist
    : (checklists.CHECKLISTS[cls.checklist] ? cls.checklist : 'production');
  if (cls.checklist === 'другое') {
    unverified.push({
      what: `Тип объекта не входит в пилотный охват (модель определила: ${cls.object_kind || 'другое'})`,
      why: `применён чек-лист «${checklists.get(checklistId).label}» — отраслевые пункты других типов не проверялись`,
    });
  }
  const checklist = checklists.get(checklistId);
  const funding = (project.object && project.object.funding) || cls.funding || 'неизвестно';

  // 2. Полнота по чек-листу
  store.setRunProgress(runId, 'полнота состава по чек-листу (2/3)…');
  const compOut = await callWithRetry({
    system: prompts.load('tz-completeness', {
      checklistLabel: checklist.label,
      checklistSection: checklist.section,
      checklistItems: checklistItemsText(checklist),
    }),
    messages: [{ role: 'user', content: `Текст задания на проектирование:\n\n${doc.text}` }],
    sessionId, route, schema: completenessSchema(checklist), schemaName: 'tz_completeness', maxTokens: 24000,
  }, 'полнота');
  const comp = parse(compOut, 'полнота');

  // Матрица собирается по ЧЕК-ЛИСТУ, а не по ответу: пропущенный моделью пункт —
  // это НЕТ ДАННЫХ (требует проверки), а не молчаливое «всё есть».
  const byId = new Map((Array.isArray(comp.items) ? comp.items : []).map((r) => [r.id, r]));
  const matrix = checklist.items.map((item) => {
    const row = byId.get(item.id);
    return {
      item_id: item.id,
      item: item.label,
      status: row && checklists.ITEM_STATUSES.includes(row.status) ? row.status : 'НЕТ',
      znp_ref: row ? (row.znp_ref || null) : null,
      note: row ? (row.note || '') : 'модель не вернула оценку пункта — статус требует проверки человеком',
      source: `${item.source.doc}, ${item.source.clause}`,
      form307: item.form307 || null,
    };
  });

  // 3. Дефекты формулировок, противоречия, ссылки, ИРД
  store.setRunProgress(runId, 'формулировки, противоречия, ссылки (3/3)…');
  const findOut = await callWithRetry({
    system: prompts.load('tz-findings', { objectSummary: objectSummary(cls, project.object || {}) }),
    messages: [{ role: 'user', content: `Текст задания на проектирование:\n\n${doc.text}` }],
    sessionId, route, schema: FINDINGS_SCHEMA, schemaName: 'tz_findings', maxTokens: 32000,
  }, 'дефекты');
  const found = parse(findOut, 'дефекты');

  const modelFindings = (Array.isArray(found.findings) ? found.findings : [])
    .filter((f) => f && f.problem && f.znp_ref)
    .map((f) => ({
      ...f,
      // статус НПА в v1 не сверяется с внешним источником — только человек
      needs_human: f.category === 'нормативная_база' ? true : !!f.needs_human,
      requirement_source: null,
    }));

  // Детерминированная сборка: полнота из матрицы + находки модели → дедуп → вердикт
  store.setRunProgress(runId, 'сборка отчёта…');
  const findings = dedupe([
    ...completenessFindings(matrix, checklist, funding),
    ...modelFindings,
  ]);

  const result = {
    generated_at: new Date().toISOString(),
    norm_check_mode: 'offline',
    norm_check_note: 'Нормативная актуальность не проверялась: прогон без внешних источников (A5/A6 спеки отключены в этой версии).',
    object: {
      name: project.name,
      kind: cls.object_kind || '',
      checklist: checklistId,
      checklist_label: checklist.label,
      funding,
      work_kind: (project.object && project.object.work_kind) || cls.work_kind || 'неизвестно',
      is_opo: cls.is_opo,
      is_unique_48_1: cls.is_unique_48_1,
      expertise: cls.expertise || 'неизвестно',
      is_repeat_expertise: cls.is_repeat_expertise,
      region: cls.region || (project.object && project.object.region) || null,
      cadastral: cls.cadastral || (project.object && project.object.cadastral) || null,
      classifier_notes: cls.notes || '',
    },
    verdict: verdict(findings, matrix),
    findings,
    checklist_matrix: matrix,
    unverified,
  };

  store.setRunStatus(runId, 'done', { progress: 'готово', result });
  return result;
}

module.exports = { runAnalysis, _setCallFn, ANALYZE_CHAR_LIMIT, CLASSIFY_SCHEMA, FINDINGS_SCHEMA, completenessSchema, completenessFindings };
