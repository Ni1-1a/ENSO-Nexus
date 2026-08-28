'use strict';
const crypto = require('crypto');
const config = require('../config');
const { db, now } = require('../db');
const adapter = require('./claude/adapter');
const { materializeOutputs } = require('./outputs');
const busyFlag = require('./busy-flag');
const progress = require('./progress');
const stages = require('./stages');
const prompts = require('./prompts');

const runningJobs = new Set();
/** sessionId → AbortController выполняющейся задачи (для «Прервать обработку»). */
const jobAborts = new Map();

/** Прерывает выполняющуюся задачу сессии. Возвращает false, если прерывать нечего. */
function cancelJob(sessionId) {
  const controller = jobAborts.get(sessionId);
  if (!controller) return false;
  logEvent(sessionId, 'Получена команда «Прервать обработку»', '', 'warn');
  controller.abort();
  return true;
}

function isAbort(err, signal) {
  return (signal && signal.aborted) || (err && (err.name === 'AbortError' || err.code === 'ABORT_ERR'));
}

/**
 * Проект могли удалить, пока задача выполнялась, — это штатное действие
 * человека, а не авария. Запись в журнал и в ленту по исчезнувшей сессии
 * молча пропускается: иначе INSERT падает на внешнем ключе, исключение летит
 * из catch-ветки, и всё, что стоит в коде после записи, уже не выполняется.
 */
function sessionAlive(sessionId) {
  return !!db.prepare('SELECT 1 AS ok FROM sessions WHERE id = ?').get(sessionId);
}

/** Пропускать ли запись: сессии больше нет либо она исчезла между проверкой и вставкой. */
function isGoneError(err) {
  return err && (err.errcode === 787 || /FOREIGN KEY/i.test(String(err.message)));
}

function logEvent(sessionId, stage, detail = '', level = 'info') {
  if (!sessionAlive(sessionId)) return false;
  try {
    db.prepare('INSERT INTO events (session_id, stage, detail, level, created_at) VALUES (?,?,?,?,?)')
      .run(sessionId, stage, detail, level, now());
    return true;
  } catch (err) {
    if (isGoneError(err)) return false;
    throw err;
  }
}

function setJobStatus(sessionId, status) {
  db.prepare('UPDATE sessions SET job_status = ?, updated_at = ? WHERE id = ?').run(status, now(), sessionId);
}

/**
 * Реплика в ленту.
 *
 * `fromJob` помечает сообщения, которые пишет САМА задача (анализ, этап,
 * сравнение): её отчёт и её сообщение об ошибке появляются сами по себе и на
 * вопрос человека не отвечают. Без этой пометки сообщение «анализ упал»
 * засчитывалось за ответ, и вопрос, заданный во время анализа, исчезал
 * из очереди навсегда.
 */
function addMessage(sessionId, role, kind, content, { fromJob = false } = {}) {
  if (!sessionAlive(sessionId)) return false;
  try {
    // колонка thread_id осталась в схеме от удалённых чатов-тредов: пишется значением по умолчанию
    db.prepare('INSERT INTO messages (id, session_id, role, kind, content, from_job, created_at) VALUES (?,?,?,?,?,?,?)')
      .run(crypto.randomUUID(), sessionId, role, kind, content, fromJob ? 1 : 0, now());
    return true;
  } catch (err) {
    if (isGoneError(err)) return false;
    throw err;
  }
}

/**
 * Проверка черновика ответа перед отправкой пользователю (claude/adversary.js).
 *
 * Порядок: проверить черновик → при вердикте «revise» один раз доработать
 * функцией `revise(issues)` → отправить лучшее из полученного. Любой сбой
 * проверки или доработки — событие в журнале и ИСХОДНЫЙ черновик: проверка не
 * имеет права ни съесть ответ, ни подменить его молча. Прерывание пользователем
 * летит наружу как обычно.
 */
async function reviewBeforeSend(sessionId, { userText, draft, route, signal, revise, factsText = null, what = 'ответа' }) {
  const adversary = require('./claude/adversary');
  if (!adversary.enabled(route) || !(draft || '').trim()) return draft;
  try {
    logEvent(sessionId, `Проверка ${what} перед отправкой`);
    const review = await adversary.review(sessionId, { userText, draft, factsText, route, signal });
    if (!review) return draft;
    if (review.verdict === 'ok') {
      logEvent(sessionId, `Проверка ${what}: можно отправлять`,
        review.issues.length ? `замечаний вне вердикта: ${review.issues.length}` : '');
      return draft;
    }
    logEvent(sessionId, `Проверка ${what}: нужна доработка`, adversary.issuesText(review.issues).slice(0, 1500), 'warn');
    const revised = ((await revise(review.issues)) || '').trim();
    if (!revised) {
      logEvent(sessionId, `Проверка ${what}: доработка не удалась — отправлен исходный ответ`, '', 'warn');
      return draft;
    }
    logEvent(sessionId, `Проверка ${what}: отправлен доработанный ответ`);
    return revised;
  } catch (err) {
    if (isAbort(err, signal)) throw err;
    logEvent(sessionId, `Проверка ${what} не удалась — отправлен исходный ответ`, err.message, 'warn');
    return draft;
  }
}

function applyModelResult(sessionId, result) {
  for (const f of result.facts) {
    db.prepare(
      'INSERT INTO facts (id, session_id, key, value, source, created_at) VALUES (?,?,?,?,?,?) ' +
      'ON CONFLICT(session_id, key) DO UPDATE SET value = excluded.value, source = excluded.source',
    ).run(crypto.randomUUID(), sessionId, f.key, f.value, f.source, now());
  }
  for (const q of result.questions) {
    const dup = db.prepare('SELECT id FROM questions WHERE session_id = ? AND text = ?').get(sessionId, q.text);
    if (!dup) {
      db.prepare('INSERT INTO questions (id, session_id, text, why, options, status, created_at) VALUES (?,?,?,?,?,?,?)')
        .run(crypto.randomUUID(), sessionId, q.text, q.why, JSON.stringify(q.options || []), 'pending', now());
    }
  }
  addMessage(sessionId, 'assistant', 'result', result.message, { fromJob: true });
}

/**
 * Async processing job. Statuses are real: every stage is written to the events
 * log before/after the actual work happens.
 */
async function startProcessing(sessionId, { instruction, extraInstruction = '' } = {}) {
  const session = db.prepare("SELECT * FROM sessions WHERE id = ? AND status = 'active'").get(sessionId);
  if (!session) throw Object.assign(new Error('Сессия не найдена'), { status: 404 });
  // человек нажал кнопку — его действие важнее реплики в диалоге
  await claimSlot(sessionId);
  try {
    if (runningJobs.has(sessionId)) {
      throw Object.assign(new Error('Обработка уже выполняется'), { status: 409 });
    }
    if (freeSlots(sessionId) <= 0) {
      throw Object.assign(new Error('Сервер занят: превышен лимит одновременных задач. Повторите через минуту.'), { status: 429 });
    }
    const filesCount = db.prepare('SELECT COUNT(*) AS c FROM files WHERE session_id = ?').get(sessionId).c;
    if (filesCount === 0) {
      throw Object.assign(new Error('Сначала загрузите хотя бы один файл исходных данных'), { status: 400 });
    }

    runningJobs.add(sessionId);
    const controller = new AbortController();
    jobAborts.set(sessionId, controller);
    // этап, на который работа вернётся, если анализ упадёт или будет прерван
    const prevStage = stages.get(sessionId);
    stages.set(sessionId, 'analysis');
    setJobStatus(sessionId, 'queued');
    logEvent(sessionId, 'Задача поставлена в очередь');

    runJob(sessionId, instruction, controller.signal, extraInstruction, prevStage).catch((err) => {
      console.error('[pipeline] unexpected error:', err);
    });
  } finally {
    releaseClaim(sessionId);
  }
}

async function runJob(sessionId, instruction, signal, extraInstruction = '', prevStage = '') {
  busyFlag.acquire(); // OCR-очередь базы знаний приостанавливается, пока идёт анализ
  // после анализа работа продолжается сама: объекты, зоны и схема на согласование.
  // Запуск следующего этапа откладывается до освобождения слота очереди —
  // иначе он сразу упрётся в «обработка уже выполняется».
  let advanceToZones = false;
  try {
    setJobStatus(sessionId, 'running');
    logEvent(sessionId, 'Проверка исходных данных');
    // подпись берётся из ДЕЙСТВУЮЩЕГО маршрута сессии, а не из глобального режима:
    // в mock-режиме сервера проект может работать на настоящей (платной) модели
    const routeNow = adapter.effectiveProvider(db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId));
    const isDemo = routeNow.provider === 'demo';
    logEvent(sessionId, `Выполняется анализ (${isDemo ? 'демо-режим' : 'AI-модель'})`,
      isDemo ? '' : `${routeNow.provider}: ${adapter.resolveModel(routeNow)}`);

    const result = await adapter.runAnalysis(sessionId, {
      instruction: (instruction || prompts.load('tasks/analysis-run'))
        + (extraInstruction ? `\n\nДополнительное задание пользователя к этому прогону:\n${extraInstruction}` : ''),
      signal,
    });

    // сообщение анализа проверяется ДО записи в ленту; report_markdown и факты
    // не трогаются — проверяющий сверяет резюме с данными самого результата
    {
      const adversary = require('./claude/adversary');
      result.message = await reviewBeforeSend(sessionId, {
        userText: instruction || prompts.load('tasks/analysis-run'),
        draft: result.message,
        factsText: adversary.analysisFactsText(result),
        route: routeNow, signal, what: 'итога анализа',
        revise: (issues) => adversary.rewrite(sessionId, {
          draft: result.message, issues, factsText: adversary.analysisFactsText(result), route: routeNow, signal,
        }),
      });
    }

    applyModelResult(sessionId, result);

    if (result.status === 'needs_clarification') {
      logEvent(sessionId, 'Требуется уточнение', `${result.questions.length} вопрос(ов)`);
      stages.set(sessionId, 'questions');
      setJobStatus(sessionId, 'needs_clarification');
    } else if (result.status === 'completed') {
      logEvent(sessionId, 'Формируются выходные документы');
      progress.set(sessionId, { phase: 'saving', label: 'Формирование выходных документов…' });
      const files = await materializeOutputs(sessionId, result);
      logEvent(sessionId, 'Анализ завершён', `Сформировано файлов: ${files.length}`);
      setJobStatus(sessionId, 'completed');
      // есть чертежи — работа идёт дальше сама: объекты, зоны, схема на согласование
      advanceToZones = hasCadFiles(sessionId);
      if (!advanceToZones) stages.set(sessionId, 'done');
    } else {
      logEvent(sessionId, 'Анализ невозможен', result.message.slice(0, 300), 'warn');
      setJobStatus(sessionId, 'failed');
      // работа не выполнена — «Анализ исходных данных» в шапке висеть не должен
      stages.settle(sessionId, prevStage);
    }

    await adapter.maybeCompact(sessionId);
  } catch (err) {
    if (isAbort(err, signal)) {
      logEvent(sessionId, 'Обработка прервана', 'по команде пользователя', 'warn');
      addMessage(sessionId, 'assistant', 'error',
        'Обработка прервана по вашей команде. Данные сессии сохранены — можно запустить анализ заново.',
        { fromJob: true });
      setJobStatus(sessionId, 'failed');
      stages.settle(sessionId, prevStage);
    } else {
      const userMessage = (err instanceof adapter.BudgetExceededError || err instanceof adapter.AiUnavailableError)
        ? err.message
        : 'Внутренняя ошибка обработки. Данные сессии сохранены — повторите попытку.';
      logEvent(sessionId, 'Произошла ошибка', userMessage, 'error');
      addMessage(sessionId, 'assistant', 'error', userMessage, { fromJob: true });
      setJobStatus(sessionId, 'failed');
      // этап возвращается к тому, на котором человек стоял: рабочий этап без
      // задачи заставляет клиента опрашивать сервер вечно
      stages.settle(sessionId, prevStage);
      if (!(err instanceof adapter.BudgetExceededError || err instanceof adapter.AiUnavailableError)) {
        console.error('[pipeline]', err); // full stack goes to server logs only
      }
    }
  } finally {
    releaseSlot(sessionId);
  }
  if (advanceToZones) {
    startZonesStage(sessionId).catch((err) => {
      logEvent(sessionId, 'Этап зон не запустился', err.message, 'warn');
    });
  }
}

/** Есть ли в проекте чертежи: без них геометрию участка строить не из чего. */
function hasCadFiles(sessionId) {
  const row = db.prepare("SELECT COUNT(*) AS c FROM files WHERE session_id = ? AND lower(ext) IN ('dwg','dxf')")
    .get(sessionId);
  return row.c > 0;
}

/* ---------------- этапы: зоны → согласование → варианты → чертёж ---------------- */

/**
 * Общая обёртка для этапных задач. Делит с анализом и чатом ту же очередь и
 * тот же механизм прерывания: два тяжёлых расчёта одновременно положили бы
 * и LM Studio, и HTTP.
 */
async function runStageJob(sessionId, { label, stage, work }) {
  const session = db.prepare("SELECT * FROM sessions WHERE id = ? AND status = 'active'").get(sessionId);
  if (!session) throw Object.assign(new Error('Сессия не найдена'), { status: 404 });
  await claimSlot(sessionId); // согласование важнее ответа помощника
  let prevStage = '';
  const controller = new AbortController();
  try {
    if (runningJobs.has(sessionId)) throw Object.assign(new Error('Обработка уже выполняется'), { status: 409 });
    if (freeSlots(sessionId) <= 0) {
      throw Object.assign(new Error('Сервер занят: превышен лимит одновременных задач. Повторите через минуту.'), { status: 429 });
    }

    runningJobs.add(sessionId);
    jobAborts.set(sessionId, controller);
    prevStage = stages.get(sessionId);
    stages.set(sessionId, stage);
    setJobStatus(sessionId, 'running');
    logEvent(sessionId, label);
  } finally {
    releaseClaim(sessionId);
  }

  (async () => {
    busyFlag.acquire();
    try {
      await work(controller.signal);
    } catch (err) {
      if (isAbort(err, controller.signal)) {
        logEvent(sessionId, `${label}: прервано`, 'по команде пользователя', 'warn');
        addMessage(sessionId, 'assistant', 'error', 'Этап прерван по вашей команде — можно запустить заново.',
          { fromJob: true });
        setJobStatus(sessionId, 'failed');
        stages.settle(sessionId, prevStage);
      } else {
        // причину, которую человек может исправить сам, показываем как есть
        const known = err.expected || err.status === 400
          || err instanceof adapter.BudgetExceededError || err instanceof adapter.AiUnavailableError;
        const message = known ? err.message : 'Внутренняя ошибка этапа. Данные проекта сохранены — повторите попытку.';
        logEvent(sessionId, `${label}: ошибка`, message, 'error');
        addMessage(sessionId, 'assistant', 'error', message, { fromJob: true });
        setJobStatus(sessionId, 'failed');
        // этап возвращается туда, откуда его запустили: иначе в шапке навсегда
        // остаётся работа, которой нет
        stages.settle(sessionId, prevStage);
        if (!known) console.error('[stage]', err);
      }
    } finally {
      releaseSlot(sessionId);
    }
  })();
}

/**
 * Этап 3: объекты участка, запретные зоны, пятно допустимой территории.
 * Заканчивается карточкой согласования в ленте — дальше ждём человека.
 */
async function startZonesStage(sessionId) {
  return runStageJob(sessionId, {
    label: 'Определение объектов и запретных зон',
    stage: 'zones',
    work: async (signal) => {
      const planSvc = require('./geometry/plan');
      const extract = require('./geometry/restriction-extract');
      const queue = require('./geometry/queue');
      const adapter2 = require('./claude/adapter');

      const parcelSource = require('./geometry/parcel-source');

      progress.set(sessionId, { phase: 'zones', label: 'Разбор чертежей и поиск объектов…' });
      let { planId, site } = await planSvc.ensurePlan(sessionId);

      const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
      const route = adapter2.effectiveProvider(session);

      /*
       * Границы ЗУ из документа — до всего остального и ВСЕГДА.
       *
       * Раньше документ спрашивали, только если контур из чертежа выглядел
       * сомнительным. Условие обманчиво: чертёж отдаёт правдоподобный контур и
       * тогда, когда участка в нём нет вовсе. В «МСК-47_Горбунки.dwg» границ ЗУ
       * нет ни на одном слое, а самым похожим оказался контур покрытия 72,39 м²
       * при 3700 м² по ГПЗУ — уверенный, замкнутый, «надёжный». Пятно, зоны и
       * посадка считались по чужой территории, а человек читал «здание не
       * помещается» вместо «разобран не тот участок».
       *
       * Поэтому источник истины — ГПЗУ: перечень координат характерных точек
       * ведётся для ЕГРН, а чертёж рисуют. Контур из чертежа не пропадает —
       * applyTo оставляет его в плане существующим объектом, и расхождение
       * видно в карточке согласования.
       *
       * Модель спрашивается один раз на проект: результат лежит в
       * plan_parcel_source и переиспользуется на всех последующих этапах.
       */
      if (!parcelSource.get(sessionId)) {
        progress.set(sessionId, { phase: 'zones', label: 'Ищу координаты характерных точек границы участка в документах…' });
        try {
          const found = await parcelSource.extract(sessionId, { site, route, signal });
          if (found.found) {
            ({ planId, site } = await planSvc.ensurePlan(sessionId)); // перечитываем с применённой границей
            logEvent(sessionId, 'Границы участка взяты из документа',
              `${found.points.length} характерных точек, «${found.meta.sourceDocument || 'документ'}»`
              + (found.meta.cadastralNumber ? `, ЗУ ${found.meta.cadastralNumber}` : ''));
          } else {
            // Теперь документ спрашивается всегда, и «таблицы нет» — обычный
            // исход для комплекта без ГПЗУ. Тревожным он остаётся только там,
            // где и чертёж границ не дал: тогда работать не от чего.
            logEvent(sessionId, 'Координат границы участка в документах нет',
              found.note || (site.parcel ? 'Границы взяты из чертежа.' : ''),
              site.parcel ? 'info' : 'warn');
          }
        } catch (err) {
          if (isAbort(err, signal)) throw err;
          logEvent(sessionId, 'Границы участка из документов не прочитаны', err.message, 'warn');
        }
      }

      if (!site.parcel) {
        throw Object.assign(new Error(
          'Границы участка не определены: в чертежах их нет, и в документах не нашлось таблицы координат '
          + 'характерных точек. Строить зоны не от чего — загрузите план границ (DWG/DXF) или ГПЗУ '
          + 'с перечнем координат.'), { expected: true });
      }

      progress.set(sessionId, { phase: 'zones', label: 'Извлечение ограничений из документов…' });
      // Объекты участка — чистая геометрия и модели не требуют. Если модель
      // недоступна, схема всё равно строится и уходит на согласование: пустой
      // список зон с честной причиной полезнее, чем упавший этап.
      let extracted = { rules: [], conflicts: [], missingData: [], stats: {} };
      const extractionNotes = [];
      try {
        extracted = await extract.extract(sessionId, {
          site, route, signal,
          extraInstruction: stages.notesInstruction(sessionId, 'zones'),
        });
      } catch (err) {
        if (isAbort(err, signal)) throw err;
        const known = err instanceof adapter2.AiUnavailableError || err instanceof adapter2.BudgetExceededError;
        if (!known) console.error('[stage:zones] извлечение ограничений', err);
        extractionNotes.push(`Ограничения из документов не извлечены: ${known ? err.message : 'ошибка обращения к модели'}`);
        logEvent(sessionId, 'Ограничения не извлечены', extractionNotes[0], 'warn');
      }

      /*
       * Правила, выведенные из фактов приложением, складываются с найденными
       * моделью — и делается это ПОСЛЕ catch, а не внутри извлечения.
       *
       * На боевом прогоне модель на комплекте из трёх документов возвращала
       * мусор, извлечение падало целиком, и вместе с ним пропадал отступ 3 м
       * по ГПЗУ — хотя он лежал в фактах отдельной строкой и никакой модели
       * для своего построения не требует. Зон выходило ноль, допустимой
       * территорией — весь участок, и здание садилось куда угодно.
       */
      const derivedRules = extract.rulesFromFacts(sessionId);
      const allRules = extract.mergeRules(extracted.rules, derivedRules);
      if (allRules.length > extracted.rules.length) {
        logEvent(sessionId, 'Правила выведены из фактов без модели',
          `добавлено ${allRules.length - extracted.rules.length}: ${derivedRules.map((r) => `${r.kind} ${r.valueM} м`).join(', ')}`);
      }

      progress.set(sessionId, { phase: 'zones', label: 'Построение зон и допустимой территории…' });
      const built = await queue.run('restrictions', { site, rules: allRules });
      // зоны и правила — в plan_zones, а не поверх чистого разбора в plans:
      // иначе решение человека о сносе не доходит до пятна (geometry/zones.js)
      require('./geometry/zones').save(sessionId, planId, { rules: allRules, built });
      site.restrictions = built.restrictions;
      site.buildable = built.buildable;

      logEvent(sessionId, 'Зоны построены',
        `зон ${built.restrictions.length}, не построено ${built.unresolved.length}`);

      // Сверка площади участка с документами и предупреждения разбора чертежа
      // попадают в ту же карточку: согласовывать схему, не увидев «участок
      // распознан неверно», — значит согласовать чужую территорию.
      const dataWarnings = [];
      const mismatch = stages.parcelAreaMismatch(sessionId, site);
      if (mismatch) {
        dataWarnings.push(mismatch);
        logEvent(sessionId, 'Площадь участка расходится с документами', mismatch, 'warn');
      }
      for (const w of [...(site.warnings || []), ...(built.warnings || [])]) {
        const text = typeof w === 'string' ? w : w && w.message;
        if (text && !dataWarnings.includes(text)) dataWarnings.push(text);
      }

      // Что человек может указать сам и сколько метров это вернёт. Всё это есть
      // и в причинах непостроенных зон, но россыпью — а разница между «286 м²
      // свободно» и «1582 м²» пряталась в одной строке про несовпавшее уточнение.
      const hints = stages.manualHints(site, built);
      if (hints.length) {
        logEvent(sessionId, 'Схеме нужны указания человека',
          hints.map((h) => h.kind).join(', '));
      }

      stages.addCard(sessionId, 'zones', {
        planId,
        manualHints: hints,
        zones: stages.zonesSummary(site),
        // и вторая сводка — по ОБЪЕКТАМ: решение принимается не по типу зоны,
        // а по конкретной линии или корпусу, которые её порождают
        sources: stages.zonesBySource(site),
        buildable: built.buildable
          ? {
            areaM2: built.buildable.areaM2,
            sharePercent: built.buildable.sharePercent,
            forbidden: built.buildable.forbidden
              ? { areaM2: built.buildable.forbidden.areaM2, sharePercent: built.buildable.forbidden.sharePercent }
              : null,
          }
          : null,
        unresolved: built.unresolved.map((u) => ({ kind: u.kind, reason: u.reason })),
        conflicts: (extracted.conflicts || []).map((c) => c.message || String(c)),
        missingData: [...dataWarnings, ...extractionNotes, ...(extracted.missingData || [])],
      });
      stages.set(sessionId, 'zones_review');
      setJobStatus(sessionId, 'awaiting_approval');
      logEvent(sessionId, 'Схема зон отправлена на согласование');
    },
  });
}

/** Этап 5: четыре варианта посадки. Заканчивается карточкой выбора. */
async function startVariantsStage(sessionId, requirements) {
  return runStageJob(sessionId, {
    label: 'Генерация вариантов посадки',
    stage: 'variants',
    work: async () => {
      const planSvc = require('./geometry/plan');
      const queue = require('./geometry/queue');
      const V = require('./geometry/variants');
      const runs = require('./geometry/placement-runs');

      progress.set(sessionId, { phase: 'variants', label: 'Перебор форм и положений корпуса…' });
      const { planId, site } = await planSvc.ensurePlan(sessionId);
      const gen = await queue.run('placement', {
        site, buildable: site.buildable || null, requirements, options: { limit: 400 },
      });
      if (gen.errors.length) throw Object.assign(new Error(gen.errors.join(' ')), { expected: true });
      if (!gen.candidates.length) {
        // Движок посадки уже посчитал, сколько нужно и сколько свободно, —
        // его текст называет числа, а общая фраза заставляла гадать.
        throw Object.assign(new Error(gen.reason
          || 'Ни одно здание требуемой площади не помещается в допустимую территорию. ' +
             'Уменьшите площадь застройки, увеличьте этажность или снимите часть ограничений.'),
        { expected: true });
      }

      const { variants, notes: buildNotes } = V.build(site, gen.candidates, { criterion: 'maxArea' });
      const runId = runs.saveRun(sessionId, {
        planId, requirements, criterion: 'maxArea', variants,
        stats: { перебрано: gen.tried, найдено: gen.total, отобрано: variants.length },
      });
      logEvent(sessionId, 'Сгенерированы варианты посадки',
        `вариантов ${variants.length}, кандидатов ${gen.total}`);

      stages.addCard(sessionId, 'variants', {
        runId, requirements, notes: buildNotes,
        forms: variants.map((v) => v.metrics.shapeLabel),
      });
      stages.set(sessionId, 'variants_review');
      setJobStatus(sessionId, 'awaiting_approval');
    },
  });
}

/** Этап 7: чертёж по согласованному варианту — DXF всегда, DWG по возможности. */
async function startDrawingStage(sessionId) {
  return runStageJob(sessionId, {
    label: 'Сборка чертежа',
    stage: 'drawing',
    work: async (signal) => {
      const planSvc = require('./geometry/plan');
      const runs = require('./geometry/placement-runs');
      const exportSvc = require('./geometry/export');
      const annotations = require('./geometry/annotations');

      const variant = runs.selected(sessionId);
      if (!variant) throw Object.assign(new Error('Вариант не выбран — чертить нечего.'), { expected: true });

      progress.set(sessionId, { phase: 'drawing', label: 'Сборка комплекта и чертежа…' });
      const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
      const { planId, site } = await planSvc.ensurePlan(sessionId);
      const { created, notes: drawingNotes } = await exportSvc.buildPackage(sessionId, {
        session, site, variant,
        restrictions: site.restrictions || [],
        buildable: site.buildable || null,
        annotations: annotations.list(sessionId, planId),
        signal,
      });
      for (const note of drawingNotes) logEvent(sessionId, 'Выгрузка чертежа', note, 'warn');

      stages.addCard(sessionId, 'drawing', {
        variantNumber: variant.number,
        files: created.map((c) => ({ id: c.id, filename: c.filename, format: c.format, size: c.size })),
        notes: drawingNotes,
      });
      stages.set(sessionId, 'done');
      setJobStatus(sessionId, 'completed');
      logEvent(sessionId, 'Задача завершена', `файлов ${created.length}`);
    },
  });
}

/* ---------------- свободный диалог ---------------- */

/** Сессии, где прямо сейчас готовится ответ помощника (не тяжёлая задача). */
const chatJobs = new Set();
/** Чаты, прерванные ради действия пользователя: вопрос остаётся в очереди. */
const preempted = new Set();
/**
 * Сессии, у которых слот ЗАБРОНИРОВАН под действие человека: анализ,
 * согласование этапа, сравнение моделей.
 *
 * Без брони вытеснение диалога отменялось само собой: preemptChat прерывал
 * ответ помощника, освобождение слота тут же запускало разбор очереди,
 * очередь видела тот же неотвеченный вопрос и занимала слот снова — действие
 * человека ждало 5 с и получало 409, а к модели уходил ещё один оплаченный
 * запрос. Пока бронь висит, очередь диалога эту сессию не трогает.
 */
const slotClaims = new Set();

function isChatBusy(sessionId) { return chatJobs.has(sessionId); }

/** Сколько слотов реально свободно. Бронь под действие человека занята так же, как задача. */
function freeSlots(exceptSessionId = '') {
  let claims = slotClaims.size;
  if (exceptSessionId && slotClaims.has(exceptSessionId)) claims -= 1; // свою же бронь не считаем
  return config.maxConcurrentJobs - runningJobs.size - claims;
}

/** Забронировать слот под действие человека и вытеснить ответ помощника. */
async function claimSlot(sessionId) {
  slotClaims.add(sessionId);
  try {
    await preemptChat(sessionId);
  } catch (err) {
    slotClaims.delete(sessionId);
    throw err;
  }
}

function releaseClaim(sessionId) { slotClaims.delete(sessionId); }

/**
 * Реплики помощника, которые считаются ОТВЕТОМ человеку.
 *
 * `result` и `card` — это выдача анализа и карточки согласования: они
 * появляются сами по себе и на заданный вопрос не отвечают. Считать их
 * ответом нельзя — иначе очередь «разбирается» ровно в тот момент, когда
 * задача её и наполнила, и вопрос теряется навсегда.
 */
const REPLY_KINDS = new Set(['chat', 'error']);

/**
 * Сообщения пользователя, на которые ещё нет ответа — всё, что он написал
 * после последней РЕПЛИКИ помощника.
 *
 * Очередь выводится из самой ленты, а не хранится в памяти процесса: иначе
 * перезапуск сервера съедал бы вопрос, заданный во время анализа.
 */
function pendingChatText(sessionId) {
  const rows = db.prepare(
    // rowid вторым ключом: в демо-режиме ответ пишется в ту же миллисекунду,
    // что и вопрос, и по одному created_at порядок строк непредсказуем
    'SELECT role, kind, content, from_job FROM messages WHERE session_id = ? ORDER BY created_at, rowid',
  ).all(sessionId);
  const out = [];
  for (let i = rows.length - 1; i >= 0; i--) {
    const m = rows[i];
    // сообщение самой задачи («анализ упал», «обработка прервана») ответом
    // не считается: иначе вопрос, заданный во время анализа, теряется молча
    if (m.role === 'assistant' && REPLY_KINDS.has(m.kind) && !m.from_job) break;
    if (m.role === 'user' && m.kind === 'chat') out.unshift(m.content);
  }
  return out;
}

function pendingChatCount(sessionId) { return pendingChatText(sessionId).length; }

/**
 * Принять сообщение в чат независимо от занятости.
 *
 * Писать можно всегда — сообщение уже лежит в ленте. Но обращение к модели
 * идёт по очереди: локальная LM Studio держит один слот, и параллельный
 * вызов кладёт и её, и HTTP. Занято — ответим сразу после текущего этапа.
 *
 * @returns {{queued: boolean}} queued=true — ответ придёт позже
 */
function enqueueChat(sessionId) {
  if (runningJobs.has(sessionId) || slotClaims.has(sessionId) || freeSlots() <= 0) {
    logEvent(sessionId, 'Диалог: вопрос принят в очередь', 'ответ — после текущего этапа');
    return { queued: true };
  }
  // в модель уходит вся накопившаяся очередь, а не только последняя реплика:
  // ответ закрывает их все, и потерять предыдущие вопросы нельзя
  startPendingChat(sessionId);
  return { queued: false };
}

/** Запуск ответа на всю накопившуюся очередь сессии. */
function startPendingChat(sessionId) {
  // слот забронирован под действие человека — вопрос ждёт своей очереди
  if (slotClaims.has(sessionId)) return false;
  const pending = pendingChatText(sessionId);
  if (!pending.length) return false;
  // несколько реплик подряд уходят одним обращением: три отдельных запроса
  // к модели ради трёх строк — пустая трата слота и токенов
  startChat(sessionId, pending.join('\n')).catch((err) => {
    console.error('[chat] ответ не начался:', err.message);
    // ошибка тоже реплика помощника: без неё очередь пыталась бы вечно
    addMessage(sessionId, 'assistant', 'error', err.message);
  });
  return true;
}

/**
 * Разбор очереди по ВСЕМ проектам, а не только по своему.
 *
 * Лимит одновременных задач общий на сервер, поэтому вопрос мог не получить
 * ответа из-за чужой задачи. Если разбирать только свою сессию, у неё больше
 * не случится события «слот освободился», и вопрос повиснет навсегда.
 */
function drainPendingChats() {
  if (freeSlots() <= 0) return;
  const rows = db.prepare(
    "SELECT id FROM sessions WHERE status = 'active' ORDER BY updated_at DESC LIMIT 200",
  ).all();
  for (const { id } of rows) {
    if (freeSlots() <= 0) break;
    if (runningJobs.has(id) || slotClaims.has(id)) continue;
    startPendingChat(id);
  }
}

/**
 * Слот освобождён. Разбор очереди отложен на следующий тик: продолжение
 * этапа (startZonesStage) обязано занять слот раньше отложенного чата,
 * иначе анализ будет ждать ответа на «а что там с ЛЭП?».
 */
function releaseSlot(sessionId) {
  runningJobs.delete(sessionId);
  jobAborts.delete(sessionId);
  progress.clear(sessionId);
  busyFlag.release();
  setImmediate(drainPendingChats);
}

/**
 * Уступить слот тяжёлой задаче: если его держит ответ помощника, прервать его.
 *
 * Человек нажал кнопку — его действие важнее реплики в диалоге. Прерванный
 * вопрос НЕ помечается отвеченным и остаётся в очереди: на него ответят,
 * когда этап закончится.
 *
 * Вызывать только через `claimSlot`: без брони освободившийся слот тут же
 * забирает разбор очереди с тем же самым вопросом, и ожидание истекает впустую.
 */
async function preemptChat(sessionId, { timeoutMs = 5000 } = {}) {
  if (!chatJobs.has(sessionId)) return false;
  const controller = jobAborts.get(sessionId);
  if (!controller) return false;
  preempted.add(sessionId);
  logEvent(sessionId, 'Диалог отложен', 'слот отдан действию пользователя');
  controller.abort();
  const until = Date.now() + timeoutMs;
  while (runningJobs.has(sessionId) && Date.now() < until) {
    await new Promise((r) => setTimeout(r, 50));
  }
  return true;
}

/**
 * Свободный чат: обычный ответ модели без 12-шагового пайплайна, без требования
 * файлов и без выходных документов.
 *
 * `job_status` чат НЕ трогает: этим статусом живут карточка прогресса, виджет
 * уточняющих вопросов и точка проекта в сайдбаре. Обычный ответ помощника
 * не должен выглядеть как запущенный многоминутный анализ и тем более гасить
 * кнопки согласования. Занятость чата отдаётся отдельным признаком.
 */
async function startChat(sessionId, text) {
  const session = db.prepare("SELECT * FROM sessions WHERE id = ? AND status = 'active'").get(sessionId);
  if (!session) throw Object.assign(new Error('Сессия не найдена'), { status: 404 });
  if (runningJobs.has(sessionId) || slotClaims.has(sessionId)) {
    throw Object.assign(new Error('Обработка уже выполняется'), { status: 409 });
  }
  if (freeSlots() <= 0) {
    throw Object.assign(new Error('Сервер занят: превышен лимит одновременных задач. Повторите через минуту.'), { status: 429 });
  }

  runningJobs.add(sessionId);
  chatJobs.add(sessionId);
  const controller = new AbortController();
  jobAborts.set(sessionId, controller);
  logEvent(sessionId, 'Диалог: вопрос принят');

  runChat(sessionId, text, controller.signal).catch((err) => {
    console.error('[chat] unexpected error:', err);
  });
}

async function runChat(sessionId, text, signal) {
  const adapter2 = require('./claude/adapter');
  busyFlag.acquire(); // локальные модели: OCR-очередь ждёт, пока идёт ответ
  try {
    const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
    const route = adapter2.effectiveProvider(session);
    const reply = await adapter2.chatOnce(sessionId, { text, route, signal });
    const final = await reviewBeforeSend(sessionId, {
      userText: text, draft: reply, route, signal,
      revise: (issues) => adapter2.chatOnce(sessionId, { text, route, signal, revision: { draft: reply, issues } }),
    });
    addMessage(sessionId, 'assistant', 'chat', final);
    logEvent(sessionId, 'Диалог: ответ получен');
    await adapter2.maybeCompact(sessionId);
  } catch (err) {
    if (isAbort(err, signal)) {
      // прервано ради действия пользователя — вопрос остаётся в очереди,
      // поэтому реплики помощника здесь быть не должно
      if (preempted.has(sessionId)) logEvent(sessionId, 'Диалог: ответ отложен', 'вопрос остался в очереди');
      else {
        logEvent(sessionId, 'Диалог прерван', 'по команде пользователя', 'warn');
        addMessage(sessionId, 'assistant', 'error', 'Ответ прерван по вашей команде.');
      }
    } else {
      const userMessage = (err instanceof adapter.BudgetExceededError || err instanceof adapter.AiUnavailableError)
        ? err.message
        : 'Не удалось получить ответ. Повторите попытку.';
      logEvent(sessionId, 'Диалог: ошибка', userMessage, 'error');
      addMessage(sessionId, 'assistant', 'error', userMessage);
      if (!(err instanceof adapter.BudgetExceededError || err instanceof adapter.AiUnavailableError)) {
        console.error('[chat]', err);
      }
    }
  } finally {
    chatJobs.delete(sessionId);
    preempted.delete(sessionId);
    releaseSlot(sessionId);
  }
}

/* ---------------- сравнение моделей ---------------- */

function fmtRoute(r) { return r.model ? `${r.provider}: ${r.model}` : r.provider; }

/**
 * Сравнительный прогон: один и тот же анализ выполняется каждой из выбранных
 * моделей ПОСЛЕДОВАТЕЛЬНО (локальные модели делят один LM Studio), результаты
 * не изменяют факты/вопросы сессии — формируется файл сравнения и сводка в чат.
 */
async function startComparison(sessionId, routes, instruction) {
  const session = db.prepare("SELECT * FROM sessions WHERE id = ? AND status = 'active'").get(sessionId);
  if (!session) throw Object.assign(new Error('Сессия не найдена'), { status: 404 });
  await claimSlot(sessionId);
  try {
    if (runningJobs.has(sessionId)) throw Object.assign(new Error('Обработка уже выполняется'), { status: 409 });
    if (freeSlots(sessionId) <= 0) {
      throw Object.assign(new Error('Сервер занят: превышен лимит одновременных задач.'), { status: 429 });
    }
    const filesCount = db.prepare('SELECT COUNT(*) AS c FROM files WHERE session_id = ?').get(sessionId).c;
    if (filesCount === 0) throw Object.assign(new Error('Сначала загрузите хотя бы один файл исходных данных'), { status: 400 });

    runningJobs.add(sessionId);
    const controller = new AbortController();
    jobAborts.set(sessionId, controller);
    setJobStatus(sessionId, 'queued');
    logEvent(sessionId, 'Сравнение моделей поставлено в очередь', routes.map(fmtRoute).join(' · '));
    runComparison(sessionId, routes, instruction, controller.signal).catch((err) => console.error('[compare]', err));
  } finally {
    releaseClaim(sessionId);
  }
}

async function runComparison(sessionId, routes, instruction, signal) {
  busyFlag.acquire();
  const adapter2 = require('./claude/adapter');
  const { saveResult } = require('./outputs');
  const task = instruction || prompts.load('tasks/compare-run');
  const runs = [];
  let aborted = false;
  try {
    setJobStatus(sessionId, 'running');
    for (let i = 0; i < routes.length; i++) {
      const route = routes[i];
      logEvent(sessionId, `Сравнение: модель ${i + 1}/${routes.length}`, fmtRoute(route));
      const before = db.prepare('SELECT input_tokens + output_tokens AS t FROM sessions WHERE id = ?').get(sessionId).t;
      const t0 = Date.now();
      try {
        const result = await adapter2.analyzeOnce(sessionId, { instruction: task, route, signal });
        const tokens = db.prepare('SELECT input_tokens + output_tokens AS t FROM sessions WHERE id = ?').get(sessionId).t - before;
        runs.push({ route, ok: true, result, seconds: Math.round((Date.now() - t0) / 1000), tokens });
        logEvent(sessionId, `Сравнение: ${fmtRoute(route)} — готово`, `${runs[i].seconds} с`);
      } catch (err) {
        if (isAbort(err, signal)) {
          aborted = true;
          logEvent(sessionId, 'Сравнение прервано', 'по команде пользователя', 'warn');
          break;
        }
        runs.push({ route, ok: false, error: err.message, seconds: Math.round((Date.now() - t0) / 1000), tokens: 0 });
        logEvent(sessionId, `Сравнение: ${fmtRoute(route)} — ошибка`, err.message, 'warn');
      }
    }

    if (aborted) {
      if (runs.length) {
        saveResult(sessionId, 'СРАВНЕНИЕ-МОДЕЛЕЙ.md', 'Сравнительный прогон моделей (прерван)', 'md',
          buildComparisonMd(runs, task) + '\n\n---\n\n**Сравнение прервано пользователем** — выполнено ' +
          `${runs.length} из ${routes.length} моделей.`);
      }
      addMessage(sessionId, 'assistant', 'error',
        `Сравнение прервано по вашей команде. Успело выполниться: ${runs.length} из ${routes.length} моделей.`,
        { fromJob: true });
      setJobStatus(sessionId, 'failed');
      return;
    }

    const md = buildComparisonMd(runs, task);
    saveResult(sessionId, 'СРАВНЕНИЕ-МОДЕЛЕЙ.md', 'Сравнительный прогон моделей', 'md', md);

    const okRuns = runs.filter((r) => r.ok);
    const summary = ['## Сравнение моделей завершено', '',
      '| Модель | Статус | Время | Токены | Фактов | Вопросов |', '|---|---|---|---|---|---|',
      ...runs.map((r) => r.ok
        ? `| ${fmtRoute(r.route)} | ${r.result.status} | ${r.seconds} с | ${r.tokens} | ${r.result.facts.length} | ${r.result.questions.length} |`
        : `| ${fmtRoute(r.route)} | ошибка | ${r.seconds} с | — | — | — |`),
      '', okRuns.length ? 'Полные ответы каждой модели — в файле **СРАВНЕНИЕ-МОДЕЛЕЙ.md** (блок «Результаты»).' : 'Ни одна модель не ответила успешно.',
    ].join('\n');
    addMessage(sessionId, 'assistant', 'result', summary, { fromJob: true });
    logEvent(sessionId, 'Сравнение завершено', `успешно: ${okRuns.length}/${routes.length}`);
    setJobStatus(sessionId, okRuns.length ? 'completed' : 'failed');
  } catch (err) {
    logEvent(sessionId, 'Произошла ошибка сравнения', err.message, 'error');
    setJobStatus(sessionId, 'failed');
  } finally {
    releaseSlot(sessionId);
  }
}

function buildComparisonMd(runs, task) {
  const parts = ['# Сравнительный прогон моделей', '', `Задание: ${task}`, '', 'Дата: ' + now(), '',
    '| Модель | Статус | Время | Токены | Фактов | Вопросов | Предупреждений |', '|---|---|---|---|---|---|---|',
    ...runs.map((r) => r.ok
      ? `| ${fmtRoute(r.route)} | ${r.result.status} | ${r.seconds} с | ${r.tokens} | ${r.result.facts.length} | ${r.result.questions.length} | ${r.result.warnings.length} |`
      : `| ${fmtRoute(r.route)} | ОШИБКА: ${r.error} | ${r.seconds} с | — | — | — | — |`)];
  for (const r of runs) {
    parts.push('', '---', '', `## ${fmtRoute(r.route)}`);
    if (!r.ok) { parts.push('', `Ошибка: ${r.error}`); continue; }
    parts.push('', `**Статус:** ${r.result.status}`, '', '### Ответ', '', r.result.message);
    if (r.result.questions.length) parts.push('', '### Вопросы', ...r.result.questions.map((q) => `- ${q.text}`));
    if (r.result.facts.length) parts.push('', '### Факты', ...r.result.facts.map((f) => `- ${f.key} = ${f.value} (${f.source})`));
    if (r.result.tep.length) parts.push('', '### ТЭП', ...r.result.tep.map((t) => `- ${t.name}: ${t.value} ${t.unit}`));
    if (r.result.report_markdown) parts.push('', '### Отчёт', '', r.result.report_markdown);
  }
  return parts.join('\n');
}

module.exports = {
  startProcessing, startChat, startComparison, cancelJob, logEvent, addMessage, runningJobs, reviewBeforeSend,
  startZonesStage, startVariantsStage, startDrawingStage,
  enqueueChat, drainPendingChats, pendingChatText, pendingChatCount, isChatBusy, preemptChat,
  claimSlot, releaseClaim, slotClaims,
};
