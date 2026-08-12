'use strict';
/**
 * Управление локальными моделями LM Studio через CLI `lms`.
 *
 * Зачем: на 48 ГБ RAM две 30B-модели (чат + vision-OCR) одновременно не помещаются
 * (веса 17,2 + 18,3 ГБ + KV-кэш > лимита Metal ~36 ГБ). JIT-загрузка LM Studio
 * при этом молча выгружала «чужую» модель — отсюда ошибки 400 «Model unloaded».
 * Здесь загрузка явная: нужный контекст, освобождение памяти осознанное, с событиями.
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const config = require('../config');

const LMS_CANDIDATES = [
  path.join(os.homedir(), '.cache', 'lm-studio', 'bin', 'lms'),
  '/opt/homebrew/bin/lms',
  '/usr/local/bin/lms',
];

/** Бюджет резидентной памяти под модели: ~72% RAM (лимит wired-памяти Metal ≈ 75%). */
const MEMORY_BUDGET_BYTES = Math.round(os.totalmem() * 0.72);

/**
 * Профили моделей: цена KV-кэша (КиБ на токен, f16) и — только там, где нужен
 * СВОЙ потолок — желаемый контекст.
 *
 * Цену KV приходится держать здесь: её никто не отдаёт, она считается из
 * архитектуры (слои × KV-головы × размерность × 2 × f16). А вот максимум
 * контекста больше НЕ выдумывается: его знает сама LM Studio, и профиль,
 * который его дублировал, врал. qwen3-coder-30b держит 262 144 токена,
 * gemma-4-31b столько же, llama-3.3-70b — 131 072; в рукописном списке у них
 * стояло 16 384 и 8 192, а модель без профиля вообще получала «по умолчанию»
 * 16 384 независимо от своих возможностей.
 *
 * Общий практический потолок — `LOCAL_AI_CONTEXT`. Он не про возможности
 * модели, а про эту машину: замер владельца от 2026-08-05 (M3 Max, 48 ГБ) —
 * при 131 072 модель грузится и работает, но prefill полного окна больше
 * девяти минут, а свободная память сжимается до мегабайтов. Поэтому окно
 * зажимается сознательно, и в интерфейсе теперь видно, чем именно.
 */
const MODEL_PROFILES = [
  { match: /qwen3-coder-30b/i, kvPerTokenKiB: 96 },
  { match: /qwen3-vl-30b/i, context: () => config.localAiOcrContext, kvPerTokenKiB: 96 },
  // 8B dense: 36 слоёв × 8 KV-голов × 128 dim × 2 (K+V) × f16 = 144 КиБ/ток
  { match: /qwen3-vl-8b/i, context: () => config.localAiOcrContext, kvPerTokenKiB: 144 },
  { match: /qwen3\.5-35b/i, kvPerTokenKiB: 96 },
  { match: /gemma-4-31b/i, kvPerTokenKiB: 128 },
  { match: /llama-3\.3-70b/i, kvPerTokenKiB: 320 },
  { match: /llama-3\.1-8b/i, kvPerTokenKiB: 128 },
];
const DEFAULT_PROFILE = { kvPerTokenKiB: 96 };

function profileFor(modelId) {
  return MODEL_PROFILES.find((p) => p.match.test(modelId)) || DEFAULT_PROFILE;
}

/**
 * Желаемый контекст: свой потолок профиля (vision-модели), иначе максимум самой
 * модели, зажатый практическим потолком машины.
 *
 * @param {number} modelMax  паспортный максимум из LM Studio (0 — неизвестен)
 */
function desiredContext(modelId, modelMax = 0) {
  const p = profileFor(modelId);
  if (p.context) return p.context();
  const ceiling = config.localAiContext;
  if (!modelMax) return ceiling;          // паспорт неизвестен — держимся потолка машины
  return Math.min(modelMax, ceiling);
}

function kvBytes(modelId, contextTokens) {
  return profileFor(modelId).kvPerTokenKiB * 1024 * contextTokens;
}

let lmsPath = null;
function findLms() {
  if (lmsPath) return lmsPath;
  lmsPath = LMS_CANDIDATES.find((p) => { try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; } }) || null;
  return lmsPath;
}

function lms(args, timeoutMs = 30000, signal) {
  const bin = findLms();
  if (!bin) return Promise.reject(new Error('CLI `lms` не найден — управление моделями недоступно'));
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, signal }, (err, stdout, stderr) => {
      if (err) reject(err.name === 'AbortError' ? err : new Error(`lms ${args[0]}: ${(stderr || err.message).slice(0, 300)}`));
      else resolve(stdout);
    });
  });
}

/* ---------- учёт активных запросов: занятые модели нельзя вытеснять ---------- */
const activeUse = new Map(); // modelKey → счётчик выполняющихся запросов

function acquireUse(modelId) {
  activeUse.set(modelId, (activeUse.get(modelId) || 0) + 1);
}
function releaseUse(modelId) {
  const n = (activeUse.get(modelId) || 1) - 1;
  if (n <= 0) activeUse.delete(modelId); else activeUse.set(modelId, n);
}
function isBusy(m) {
  // наш счётчик + live-статус LM Studio (стриминг чужих клиентов тоже виден)
  return (activeUse.get(m.modelKey) || 0) > 0 || m.status !== 'idle' || m.queued > 0;
}

/** Загруженные сейчас модели: [{identifier, modelKey, sizeBytes, contextLength, type}] */
async function listLoaded() {
  const out = await lms(['ps', '--json']);
  const rows = JSON.parse(out || '[]');
  return rows.map((r) => ({
    identifier: r.identifier,
    modelKey: r.modelKey || r.path || r.identifier,
    sizeBytes: r.sizeBytes || 0,
    contextLength: r.contextLength || 0,
    type: r.type || 'llm',
    status: r.status || 'idle',
    queued: r.queued || 0,
  }));
}

let dlCache = null, dlCacheAt = 0;
/**
 * Скачанные модели (кэш 5 мин): размер весов и СОБСТВЕННЫЙ максимум контекста модели.
 *
 * `maxContextLength` берётся у самой LM Studio, а не из нашего списка: qwen3-coder-30b
 * держит 262 144 токена, gemma-4-31b столько же, llama-3.3-70b — 131 072. Пока это
 * знание жило в рукописных профилях, модель без профиля получала 16 384 «по
 * умолчанию» независимо от того, что она умеет, а в интерфейсе стояло голое число
 * без пояснения, откуда оно и почему меньше заявленного в LM Studio.
 */
async function listDownloaded() {
  if (dlCache && Date.now() - dlCacheAt < 300000) return dlCache;
  const out = await lms(['ls', '--json']);
  const rows = JSON.parse(out || '[]');
  dlCache = new Map(rows.map((r) => [r.modelKey || r.path, {
    sizeBytes: r.sizeBytes || 0,
    maxContextLength: r.maxContextLength || 0,
    vision: !!r.vision,
  }]));
  dlCacheAt = Date.now();
  return dlCache;
}

/** Размер весов модели в байтах (0 — модель не скачана или lms недоступен). */
async function sizeOf(modelId) {
  try { return ((await listDownloaded()).get(modelId) || {}).sizeBytes || 0; } catch { return 0; }
}

/** Максимум контекста, который держит сама модель (0 — неизвестно). */
async function modelMaxContext(modelId) {
  try { return ((await listDownloaded()).get(modelId) || {}).maxContextLength || 0; } catch { return 0; }
}

/**
 * Ниже этого контекста грузить модель бессмысленно: в 4 тыс. токенов не влезет
 * даже системный промпт с одним документом.
 */
const MIN_CONTEXT = 4096;

/**
 * Наибольший контекст, при котором модель ещё укладывается в бюджет памяти.
 * Возвращает 0, если не укладывается даже при минимальном.
 *
 * `modelMax` — то, что модель держит по паспорту LM Studio. Просить больше
 * бессмысленно: загрузка просто не удастся.
 */
function fittingContext(modelId, sizeBytes, modelMax = 0) {
  const want = desiredContext(modelId, modelMax);
  const perToken = profileFor(modelId).kvPerTokenKiB * 1024;
  const free = MEMORY_BUDGET_BYTES - sizeBytes;
  if (free <= 0) return 0;
  const max = Math.floor(free / perToken);
  if (max >= want) return want;
  if (max < MIN_CONTEXT) return 0;
  // округляем вниз до 1024 — LM Studio любит круглые размеры
  return Math.floor(max / 1024) * 1024;
}

/**
 * Оценка загрузки модели в память: веса + KV-кэш.
 *
 * Здесь НЕ запрещают. Прежняя проверка возвращала feasible:false, и выбор
 * llama-3.3-70b отклонялся с «выберите модель поменьше» — человек не мог даже
 * попробовать. Решение, рисковать ли своей памятью, принимает владелец машины;
 * дело платформы — честно сказать, чем это кончится, и подобрать контекст
 * поменьше, если модель влезает только так.
 *
 * @returns {{feasible: boolean, heavy: boolean, note: string, sizeBytes: number,
 *            fitContext: number, wantContext: number}}
 *   feasible — можно ли пытаться (теперь всегда true при известном размере);
 *   heavy    — не укладывается в бюджет даже с минимальным контекстом.
 */
async function feasibility(modelId) {
  let size = 0;
  let modelMax = 0;
  try {
    const info = (await listDownloaded()).get(modelId) || {};
    size = info.sizeBytes || 0;
    modelMax = info.maxContextLength || 0;
  } catch { /* нет lms — не оцениваем */ }
  const want = desiredContext(modelId, modelMax);
  if (!size) return { feasible: true, heavy: false, note: '', sizeBytes: 0, fitContext: want, wantContext: want, modelMaxContext: modelMax };

  const gb = (n) => (n / 1024 ** 3).toFixed(1);
  const need = size + kvBytes(modelId, want);
  const fit = fittingContext(modelId, size, modelMax);

  if (fit === 0) {
    // веса сами по себе больше бюджета — контекстом делу не помочь
    return {
      feasible: true, heavy: true, sizeBytes: size, fitContext: MIN_CONTEXT, wantContext: want, modelMaxContext: modelMax,
      note: `тяжёлая для этой машины: одни веса ~${gb(size)} ГБ при бюджете ~${gb(MEMORY_BUDGET_BYTES)} ГБ. `
        + 'Загрузка будет долгой, а часть весов уйдёт в подкачку — ответы замедлятся в разы. '
        + 'Запустить можно, но для работы лучше взять модель поменьше',
    };
  }
  if (fit < want) {
    return {
      feasible: true, heavy: false, sizeBytes: size, fitContext: fit, wantContext: want, modelMaxContext: modelMax,
      note: `контекст будет уменьшен до ${fit.toLocaleString('ru-RU')} токенов вместо ${want.toLocaleString('ru-RU')}: `
        + `с полным нужно ~${gb(need)} ГБ при доступных ~${gb(MEMORY_BUDGET_BYTES)} ГБ. `
        + 'Длинные документы придётся резать на части',
    };
  }
  if (need > MEMORY_BUDGET_BYTES * 0.85) {
    return {
      feasible: true, heavy: false, sizeBytes: size, fitContext: fit, wantContext: want, modelMaxContext: modelMax,
      note: `займёт почти всю память (~${gb(need)} ГБ) — другие модели будут выгружены`,
    };
  }
  return { feasible: true, heavy: false, sizeBytes: size, fitContext: fit, wantContext: want, modelMaxContext: modelMax, note: '' };
}

/**
 * Выгрузить модель, когда её работа закончена.
 *
 * Вторая половина поочерёдной работы: мало загрузить одну модель за раз, надо
 * ещё и освободить память сразу после её этапа, а не держать 30 ГБ занятыми до
 * следующей загрузки. Распознавание сканов кончилось — vision-модель уходит,
 * и чат-модель грузится в пустую память, а не выталкивает соседку.
 *
 * Занятую модель НЕ трогаем: параллельная задача получила бы «Model unloaded»
 * на середине ответа. Отказ выгрузки — не ошибка этапа: работа уже сделана.
 */
async function unload(modelId, { onProgress = () => {} } = {}) {
  if (!findLms() || !modelId) return { ok: false, reason: 'нет CLI lms' };
  let loaded;
  try { loaded = await listLoaded(); } catch { return { ok: false, reason: 'состояние LM Studio недоступно' }; }
  const target = loaded.find((m) => m.modelKey === modelId && m.type !== 'embedding');
  if (!target) return { ok: true, alreadyFree: true };
  if (isBusy(target)) return { ok: false, reason: 'модель обслуживает запрос' };
  try {
    await lms(['unload', target.identifier], 60000);
    onProgress(`Модель ${modelId} выгружена — память свободна`);
    return { ok: true, unloaded: true };
  } catch (err) {
    console.warn('[model-manager] unload failed:', err.message);
    return { ok: false, reason: err.message };
  }
}

/** Сериализация ensureLoaded: параллельные вызовы не должны спорить за память. */
let ensureChain = Promise.resolve();

/**
 * Гарантирует, что модель загружена с нужным контекстом. При нехватке памяти
 * осознанно выгружает другие LLM (embedding-модели не трогает).
 * onProgress(text) — человеко-читаемые статусы для журнала/индикатора.
 */
function ensureLoaded(modelId, { onProgress = () => {}, signal = null } = {}) {
  const run = async () => {
    if (signal && signal.aborted) throw Object.assign(new Error('Обработка прервана'), { name: 'AbortError' });
    if (!findLms()) return { ok: true, managed: false }; // нет CLI — надеемся на JIT

    /*
     * Контекст подбирается под фактическую память, а не берётся из профиля слепо.
     *
     * Раньше платформа просто отказывала: «Модель не помещается в память — выберите
     * модель поменьше», и llama-3.3-70b нельзя было даже попробовать. Теперь модель,
     * которая не влезает с полным контекстом, грузится с урезанным, а та, что не
     * влезает вовсе, всё равно запускается — с честным предупреждением в журнале.
     * Решение о том, рисковать ли своей памятью, принимает владелец машины.
     */
    const fit = await feasibility(modelId).catch(() => null);
    const wantCtx = fit && fit.fitContext ? fit.fitContext : desiredContext(modelId);
    if (fit && fit.note) onProgress(`Модель ${modelId}: ${fit.note}`);

    let loaded;
    try { loaded = await listLoaded(); } catch { return { ok: true, managed: false }; }

    const target = loaded.find((m) => m.modelKey === modelId && m.type !== 'embedding');
    // «уже загружена корректно» = контекст не меньше нужного И веса + KV фактического
    // контекста укладываются в бюджет памяти (262144 по умолчанию — не укладываются)
    if (target && target.contextLength >= wantCtx &&
        target.sizeBytes + kvBytes(modelId, target.contextLength) <= MEMORY_BUDGET_BYTES) {
      return { ok: true, managed: true, alreadyLoaded: true };
    }
    if (target) {
      // загружена, но с неподходящим контекстом (например, 262144 по умолчанию) — перезагружаем
      onProgress(`Модель ${modelId} перезагружается с контекстом ${wantCtx.toLocaleString('ru-RU')} токенов`);
      try { await lms(['unload', target.identifier], 60000); } catch { /* уже выгружена */ }
      loaded = loaded.filter((m) => m !== target);
    }

    const size = await sizeOf(modelId);
    const need = size + kvBytes(modelId, wantCtx);
    // embedding-модели KV-кэш почти не тратят — не завышаем их вес при вытеснении
    const residentCost = (m) => m.sizeBytes + (m.type === 'embedding' ? 0 : kvBytes(m.modelKey, m.contextLength || 4096));

    /*
     * ПООЧЕРЁДНАЯ РАБОТА: перед загрузкой выгружается всё остальное.
     *
     * Раньше модели вытеснялись только по нехватке памяти — «пока не поместимся».
     * Держать их рядом имело смысл, пока чат-модель была на 16 ГБ, а распознавание
     * вела 5-гигабайтная vl-8b: обе жили в бюджете и переключаться было незачем.
     * С переходом на qwen3.5-35b-a3b (20,6 ГБ весов плюс 9 ГБ KV) свободных
     * остаётся 5 ГБ, и любое соседство означает работу впритык: система начинает
     * сжимать память, а часть весов уходит в подкачку — ответы замедляются в разы.
     *
     * Поэтому теперь одна модель за раз: загрузилась → отработала → выгрузилась.
     * Каждой достаётся ВЕСЬ бюджет, а не остаток от соседа, и контекст считается
     * честно (fittingContext и так считает «в одиночку»). Плата — перезагрузка
     * на переключении, но она случается дважды за анализ, а не на каждой странице:
     * распознавание идёт одним блоком по всем страницам, потом работает чат-модель.
     *
     * Модель, обслуживающую ЧУЖОЙ запрос прямо сейчас (наш счётчик или live-статус
     * LM Studio), не трогаем ни при каких условиях — иначе та задача получит
     * «Model unloaded» на середине. Embedding-модели тоже: они нужны вперемежку
     * с чатом для поиска по базе знаний и почти не занимают память.
     */
    const exclusive = config.localAiExclusive;
    const evictable = loaded
      .filter((m) => m.type !== 'embedding' && !isBusy(m))
      .sort((a, b) => residentCost(b) - residentCost(a));
    let residentTotal = loaded.reduce((s, m) => s + residentCost(m), 0);
    for (const m of evictable) {
      if (!exclusive && residentTotal + need <= MEMORY_BUDGET_BYTES) break;
      if (signal && signal.aborted) throw Object.assign(new Error('Обработка прервана'), { name: 'AbortError' });
      onProgress(exclusive
        ? `Выгружается модель ${m.modelKey} — работаем по одной`
        : `Выгружается модель ${m.modelKey} — освобождаю память`);
      try { await lms(['unload', m.identifier], 60000); residentTotal -= residentCost(m); } catch (err) {
        console.warn('[model-manager] unload failed:', err.message);
      }
    }
    if (residentTotal + need > MEMORY_BUDGET_BYTES) {
      console.warn(`[model-manager] память занята активными моделями (~${((residentTotal + need) / 1024 ** 3).toFixed(1)} ГиБ) — загрузка ${modelId} может не удаться`);
      onProgress('Память занята активными моделями — жду завершения их запросов…');
    }

    if (signal && signal.aborted) throw Object.assign(new Error('Обработка прервана'), { name: 'AbortError' });
    onProgress(`Загружается модель ${modelId} (контекст ${wantCtx.toLocaleString('ru-RU')} токенов)…`);
    const t0 = Date.now();
    // Тяжёлая модель читается с диска минутами: 70B-веса — это 35 ГБ, и на
    // фиксированных четырёх минутах загрузка обрывалась по таймауту, а выглядело
    // это как «модель не запускается». Минута на каждые 8 ГБ, но не меньше четырёх.
    const loadTimeout = Math.max(240000, Math.ceil(size / (8 * 1024 ** 3)) * 60000);
    try {
      await lms(['load', modelId, '--context-length', String(wantCtx), '--ttl', '7200', '-y'], loadTimeout, signal || undefined);
    } catch (err) {
      if (err.name === 'AbortError' || wantCtx <= MIN_CONTEXT) throw err;
      // не влезла даже с подобранным контекстом — пробуем минимальный, прежде чем сдаться
      onProgress(`Не удалось загрузить с контекстом ${wantCtx.toLocaleString('ru-RU')} — повторяю с минимальным (${MIN_CONTEXT.toLocaleString('ru-RU')})`);
      await lms(['load', modelId, '--context-length', String(MIN_CONTEXT), '--ttl', '7200', '-y'], loadTimeout, signal || undefined);
    }
    onProgress(`Модель ${modelId} загружена за ${Math.round((Date.now() - t0) / 1000)} с`);
    return { ok: true, managed: true, loadedNow: true };
  };
  // цепочка: одновременные ensureLoaded выполняются последовательно
  const result = ensureChain.then(run, run);
  ensureChain = result.catch(() => {});
  return result;
}

module.exports = {
  ensureLoaded, unload, feasibility, desiredContext, fittingContext, listLoaded, sizeOf, modelMaxContext,
  acquireUse, releaseUse, MEMORY_BUDGET_BYTES, MIN_CONTEXT,
};
