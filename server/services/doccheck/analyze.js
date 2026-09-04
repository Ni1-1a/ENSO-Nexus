'use strict';
/**
 * Конвейер «Проверки документа»: определить, что загружено, и запустить
 * нужный промпт библиотеки (решение владельца от 27.08.2026, пункт 1).
 *
 * Порядок:
 *   1. классификация КОДОМ по маркерам (doclib.classifyByMarkers) — совпал
 *      ровно один тип, значит модель для классификации не нужна вовсе;
 *   2. иначе — структурный проход модели (prompts/doccheck-classify.md);
 *      выбор человека (chosen_type) СИЛЬНЕЕ любой догадки;
 *   3. перечень ссылок на НТД — детерминированно (ntd-refs.js), всегда;
 *   4. профильный промпт библиотеки через adapter.structuredCall: обвязка —
 *      prompts/doccheck-run.md, дословное тело промпта подставляется
 *      как {{task}}; ответ — находки в формате «стандарт отдельно, пункт
 *      отдельно, флаг уверенности» (приём Д4, замер Hermes) с полем
 *      «требуемое действие» (приём Д1: ПРОВЕРИТЬ ≠ ПЕРЕДЕЛАТЬ).
 *
 * Тип «tz» прогоном не проверяется — человека ведут в модуль «Анализ ТЗ»,
 * там проверка полнее. Неопределённый тип — честный итог с перечнем ссылок
 * на НТД и просьбой выбрать тип, а не пустой «успех».
 */
const prompts = require('../prompts');
const doclib = require('../doclib');
const ntdRefs = require('./ntd-refs');
const store = require('./store');

const ANALYZE_CHAR_LIMIT = 160_000;
const CLASSIFY_CHAR_LIMIT = 20_000;

let overrideCallFn = null;
function _setCallFn(fn) { overrideCallFn = fn; }

/* ---------------- схемы структурных ответов ----------------
 * required перечисляет ВСЕ ключи, необязательность — союз с null
 * (правило платформы; локальным движкам адаптер переписывает союз в anyOf). */

const CLASSIFY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['doc_type', 'kind_note', 'confidence', 'evidence'],
  properties: {
    doc_type: { type: 'string', enum: doclib.DOC_TYPES },
    kind_note: { type: 'string', description: 'Короткое описание документа своими словами' },
    confidence: { type: 'string', enum: ['высокая', 'средняя', 'низкая'] },
    evidence: { type: 'string', description: 'Дословная строка документа, по которой определён тип' },
  },
};

const FINDINGS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['findings', 'missing_data', 'notes'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['what', 'where', 'quote', 'standard', 'clause', 'clause_confidence', 'action', 'kind'],
        properties: {
          what: { type: 'string', description: 'Суть находки, кратко' },
          where: { type: 'string', description: 'Раздел / лист / таблица / строка' },
          quote: { type: ['string', 'null'], description: 'Дословная цитата дефектного места' },
          standard: { type: ['string', 'null'], description: 'Обозначение НТД (ГОСТ/СП/ПП) без пункта' },
          clause: { type: ['string', 'null'], description: 'Номер пункта, ТОЛЬКО если уверен' },
          clause_confidence: { type: ['string', 'null'], enum: ['высокая', 'средняя', 'низкая', null] },
          action: { type: 'string', enum: ['исправить', 'проверить', 'нет данных'] },
          kind: {
            type: 'string',
            enum: ['коллизия', 'устаревшая редакция', 'опечатка', 'нет обоснования', 'неполнота', 'прочее'],
          },
        },
      },
    },
    missing_data: { type: 'array', items: { type: 'string' } },
    notes: { type: ['string', 'null'] },
  },
};

/* ---------------- помощники ---------------- */

function documentForModel(text, limit) {
  const truncated = text.length > limit;
  return { text: truncated ? text.slice(0, limit) : text, truncated };
}

const TRANSPORT_RE = /terminated|ECONNRESET|ECONNREFUSED|ETIMEDOUT|timeout|socket hang up|network|обрыв|aborted|fetch failed/i;

/* ---------------- конвейер ---------------- */

async function runCheck(runId, { callFn = null, host = '' } = {}) {
  const adapter = require('../claude/adapter');
  const call = callFn || overrideCallFn || adapter.structuredCall;

  const run = store.runById(runId, { withText: true });
  if (!run) throw store.httpError(404, 'Прогон не найден');
  const check = store.checkById(run.check_id);
  if (!check) throw store.httpError(404, 'Проверка не найдена');
  if (!run.document_text.trim()) throw store.httpError(422, 'Нет текста документа — загрузите файл или вставьте текст');

  const route = { provider: run.provider, model: run.model };
  const sessionId = store.ensureServiceSession(check, null, host);

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

  const unverified = [];

  // 1–2. Классификация: человек → маркеры кода → модель
  store.setRunProgress(runId, 'определение типа документа…');
  let classification;
  if (check.chosen_type) {
    classification = {
      type: check.chosen_type, via: 'человек',
      evidence: '', confidence: 'высокая', kind_note: '',
    };
  } else {
    const det = doclib.classifyByMarkers(check.document_name, run.document_text);
    if (det.type) {
      classification = { type: det.type, via: 'маркеры', evidence: det.evidence, confidence: 'высокая', kind_note: '' };
    } else if (!run.provider) {
      classification = {
        type: 'neizvestno', via: 'маркеры',
        evidence: '', confidence: 'низкая',
        kind_note: det.candidates.length
          ? `маркеры дали несколько типов сразу: ${det.candidates.join(', ')} — без модели не различить`
          : 'маркеры типа не нашли, модель для классификации не выбрана',
      };
    } else {
      const head = documentForModel(run.document_text, CLASSIFY_CHAR_LIMIT);
      const out = await callWithRetry({
        system: prompts.load('doccheck-classify'),
        messages: [{ role: 'user', content: `Имя файла: ${check.document_name || '—'}\n\nНачало документа:\n\n${head.text}` }],
        sessionId, route, schema: CLASSIFY_SCHEMA, schemaName: 'doccheck_classify', maxTokens: 4000,
      }, 'классификация');
      const cls = parse(out, 'классификация');
      classification = {
        type: doclib.DOC_TYPES.includes(cls.doc_type) ? cls.doc_type : 'neizvestno',
        via: 'модель', evidence: cls.evidence || '',
        confidence: cls.confidence || 'низкая', kind_note: cls.kind_note || '',
      };
      if (classification.confidence === 'низкая') {
        unverified.push({
          what: 'Тип документа определён моделью с низкой уверенностью',
          why: 'подтвердите или поменяйте тип в карточке проверки — прогон нужным промптом запустится заново',
        });
      }
    }
    store.setDetected(check.id, { type: classification.type, via: classification.via, evidence: classification.evidence });
  }
  classification.label = doclib.typeLabel(classification.type);

  // 3. Перечень ссылок на НТД — детерминированно, всегда
  store.setRunProgress(runId, 'перечень ссылок на НТД…');
  const refs = ntdRefs.extract(run.document_text);
  unverified.push({
    what: 'Статусы НТД взяты из реестра модуля «Нормоконтроль» (208 записей, собран 24.08.2026)',
    why: 'реестр не покрывает всю нормативную базу; редакции проверяются по официальным источникам',
  });

  // 4. Профильный промпт библиотеки
  let routed = null;
  let findings = [];
  let missingData = [];
  let modelNotes = null;

  const routeDef = doclib.ROUTES[classification.type] || null;
  if (routeDef && !run.provider) {
    // модель не выбрана — это не ошибка прогона: классификация и перечень НТД
    // уже полезны, а профильная проверка честно помечается несделанной
    unverified.push({
      what: `Профильная проверка («${routeDef.label}») не запускалась: модель не выбрана`,
      why: 'выберите нейросеть в карточке проверки и запустите прогон повторно',
    });
  } else if (routeDef) {
    // выбор промпта: человек мог заменить основной на альтернативный
    const promptId = check.chosen_prompt_id
      && (check.chosen_prompt_id === routeDef.promptId || routeDef.alternatives.includes(check.chosen_prompt_id))
      ? check.chosen_prompt_id : routeDef.promptId;
    const entry = doclib.byId(promptId);
    const carcass = routeDef.systemId ? doclib.byId(routeDef.systemId) : null;
    // в провенанс — хеш собранного system-текста (обвязка doccheck-run + каркас +
    // задание), а не только тела библиотечного промпта: правка обвязки видна в прогоне
    const systemText = prompts.load('doccheck-run', { carcass: carcass ? `${carcass.body}\n\n` : '', task: entry.body });
    store.setRunRoute(runId, { docType: classification.type, promptId, promptSha: store.sha256(systemText) });
    store.setRunProgress(runId, `проверка промптом «${entry.title || promptId}»…`);

    // Лесенка усечения: документ, не влезающий в окно локальной модели, адаптер
    // усечь не может (монолитный текст — «сокращать нечего»), и модель отвечает
    // пустотой. Поэтому на неразбираемом ответе прогон повторяется с документом
    // вдвое короче — до предела; каждое усечение честно проговаривается.
    const ladder = [ANALYZE_CHAR_LIMIT, 80_000, 40_000]
      .filter((limit, i, all) => limit < run.document_text.length || i === 0 || all[i - 1] >= run.document_text.length)
      .filter((limit) => limit <= ANALYZE_CHAR_LIMIT);
    let parsed = null;
    let usedLimit = null;
    let lastErr = null;
    for (const limit of ladder) {
      const doc = documentForModel(run.document_text, limit);
      try {
        const out = await callWithRetry({
          system: prompts.load('doccheck-run', {
            carcass: carcass ? `${carcass.body}\n\n` : '',
            task: entry.body,
          }),
          messages: [{ role: 'user', content: `Документ «${check.document_name || check.name}» (тип: ${classification.label}):\n\n${doc.text}` }],
          sessionId, route, schema: FINDINGS_SCHEMA, schemaName: 'doccheck_findings', maxTokens: 24000,
        }, 'проверка');
        parsed = parse(out, 'проверка');
        usedLimit = doc.truncated ? limit : null;
        break;
      } catch (err) {
        lastErr = err;
        if (!/неразбираемый ответ|оборван лимитом/.test(String(err.message)) || limit === ladder[ladder.length - 1]) throw err;
        store.setRunProgress(runId, `документ не поместился в окно модели — повтор с усечением до ${Math.round(limit / 2 / 1000)} тыс. знаков…`);
      }
    }
    if (!parsed) throw lastErr || new Error('Проверка не дала разбираемого ответа');
    if (usedLimit) {
      unverified.push({
        what: `Текст документа обрезан до ${usedLimit.toLocaleString('ru-RU')} символов из ${run.document_text.length.toLocaleString('ru-RU')}`,
        why: 'потолок контекста модели — хвост документа не проверялся; для полного охвата выберите модель с большим окном',
      });
    }

    findings = (Array.isArray(parsed.findings) ? parsed.findings : [])
      .filter((f) => f && f.what)
      .map((f, i) => ({
        id: `D-${String(i + 1).padStart(3, '0')}`,
        ...f,
        // пункт без флага уверенности — это пункт с неизвестной уверенностью,
        // а неизвестная уверенность читается как низкая (Д4)
        clause_confidence: f.clause ? (f.clause_confidence || 'низкая') : null,
        needs_human: !!f.clause || f.action !== 'исправить'
          || f.kind === 'устаревшая редакция' || !f.quote,
      }));
    missingData = Array.isArray(parsed.missing_data) ? parsed.missing_data.slice(0, 20) : [];
    modelNotes = parsed.notes || null;

    routed = {
      prompt_id: promptId,
      prompt_title: entry.title || promptId,
      prompt_source: [entry.source_file, entry.source_post].filter(Boolean).join(' · '),
      system_id: routeDef.systemId || null,
      alternatives: routeDef.alternatives,
    };
    unverified.push({
      what: 'Ссылки модели на пункты НТД — гипотезы, а не факты (у пунктов стоит флаг уверенности)',
      why: 'по замеру Hermes (80+ прогонов) большинство точных пунктов требуют ручной сверки; действующую редакцию проверяет инженер',
    });
  } else if (classification.type === 'tz') {
    unverified.push({
      what: 'Документ похож на задание на проектирование',
      why: doclib.SPECIAL_TYPES.tz.note,
    });
  } else {
    unverified.push({
      what: 'Профильная проверка не запускалась: тип документа не определён',
      why: doclib.SPECIAL_TYPES.neizvestno.note,
    });
  }

  const result = {
    generated_at: new Date().toISOString(),
    classification,
    routed,
    findings,
    missing_data: missingData,
    model_notes: modelNotes,
    ntd_refs: refs.refs,
    summary: {
      findings_count: findings.length,
      ntd_refs_count: refs.refs.length,
      routed: !!routed,
    },
    unverified,
  };

  store.setRunStatus(runId, 'done', { progress: 'готово', result });
  return result;
}

module.exports = { runCheck, _setCallFn, ANALYZE_CHAR_LIMIT, CLASSIFY_SCHEMA, FINDINGS_SCHEMA };
