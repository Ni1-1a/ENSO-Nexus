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
 * Профили моделей: желаемый контекст и цена KV-кэша (КиБ на токен, f16).
 * Контекст подобран так, чтобы модель + KV гарантированно помещались в бюджет
 * в одиночку; см. отчёт по настройке контекста.
 */
const MODEL_PROFILES = [
  { match: /qwen3-coder-30b/i, context: () => config.localAiContext, kvPerTokenKiB: 96 },
  { match: /qwen3-vl-30b/i, context: () => config.localAiOcrContext, kvPerTokenKiB: 96 },
  // 8B dense: 36 слоёв × 8 KV-голов × 128 dim × 2 (K+V) × f16 = 144 КиБ/ток
  { match: /qwen3-vl-8b/i, context: () => config.localAiOcrContext, kvPerTokenKiB: 144 },
  { match: /qwen3\.5-35b/i, context: () => 32768, kvPerTokenKiB: 96 },
  { match: /gemma-4-31b/i, context: () => 16384, kvPerTokenKiB: 128 },
  { match: /llama-3\.3-70b/i, context: () => 8192, kvPerTokenKiB: 320 },
  { match: /llama-3\.1-8b/i, context: () => 32768, kvPerTokenKiB: 128 },
];
const DEFAULT_PROFILE = { context: () => 16384, kvPerTokenKiB: 96 };

function profileFor(modelId) {
  return MODEL_PROFILES.find((p) => p.match.test(modelId)) || DEFAULT_PROFILE;
}

function desiredContext(modelId) { return profileFor(modelId).context(); }

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
/** Скачанные модели: Map(modelKey -> sizeBytes). Кэш 5 мин. */
async function listDownloaded() {
  if (dlCache && Date.now() - dlCacheAt < 300000) return dlCache;
  const out = await lms(['ls', '--json']);
  const rows = JSON.parse(out || '[]');
  dlCache = new Map(rows.map((r) => [r.modelKey || r.path, r.sizeBytes || 0]));
  dlCacheAt = Date.now();
  return dlCache;
}

/**
 * Ниже этого контекста грузить модель бессмысленно: в 4 тыс. токенов не влезет
 * даже системный промпт с одним документом.
 */
const MIN_CONTEXT = 4096;

/**
 * Наибольший контекст, при котором модель ещё укладывается в бюджет памяти.
 * Возвращает 0, если не укладывается даже при минимальном.
 */
function fittingContext(modelId, sizeBytes) {
  const want = desiredContext(modelId);
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
  try { size = (await listDownloaded()).get(modelId) || 0; } catch { /* нет lms — не оцениваем */ }
  const want = desiredContext(modelId);
  if (!size) return { feasible: true, heavy: false, note: '', sizeBytes: 0, fitContext: want, wantContext: want };

  const gb = (n) => (n / 1024 ** 3).toFixed(1);
  const need = size + kvBytes(modelId, want);
  const fit = fittingContext(modelId, size);

  if (fit === 0) {
    // веса сами по себе больше бюджета — контекстом делу не помочь
    return {
      feasible: true, heavy: true, sizeBytes: size, fitContext: MIN_CONTEXT, wantContext: want,
      note: `тяжёлая для этой машины: одни веса ~${gb(size)} ГБ при бюджете ~${gb(MEMORY_BUDGET_BYTES)} ГБ. `
        + 'Загрузка будет долгой, а часть весов уйдёт в подкачку — ответы замедлятся в разы. '
        + 'Запустить можно, но для работы лучше взять модель поменьше',
    };
  }
  if (fit < want) {
    return {
      feasible: true, heavy: false, sizeBytes: size, fitContext: fit, wantContext: want,
      note: `контекст будет уменьшен до ${fit.toLocaleString('ru-RU')} токенов вместо ${want.toLocaleString('ru-RU')}: `
        + `с полным нужно ~${gb(need)} ГБ при доступных ~${gb(MEMORY_BUDGET_BYTES)} ГБ. `
        + 'Длинные документы придётся резать на части',
    };
  }
  if (need > MEMORY_BUDGET_BYTES * 0.85) {
    return {
      feasible: true, heavy: false, sizeBytes: size, fitContext: fit, wantContext: want,
      note: `займёт почти всю память (~${gb(need)} ГБ) — другие модели будут выгружены`,
    };
  }
  return { feasible: true, heavy: false, sizeBytes: size, fitContext: fit, wantContext: want, note: '' };
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

    let size = 0;
    try { size = (await listDownloaded()).get(modelId) || 0; } catch {}
    const need = size + kvBytes(modelId, wantCtx);
    // embedding-модели KV-кэш почти не тратят — не завышаем их вес при вытеснении
    const residentCost = (m) => m.sizeBytes + (m.type === 'embedding' ? 0 : kvBytes(m.modelKey, m.contextLength || 4096));

    // освобождаем память: выгружаем самые крупные ПРОСТАИВАЮЩИЕ LLM, пока не поместимся.
    // Модель, которая прямо сейчас обслуживает запрос (наш счётчик или live-статус
    // LM Studio), вытеснять нельзя — иначе чужая задача получит «Model unloaded».
    const evictable = loaded
      .filter((m) => m.type !== 'embedding' && !isBusy(m))
      .sort((a, b) => residentCost(b) - residentCost(a));
    let residentTotal = loaded.reduce((s, m) => s + residentCost(m), 0);
    for (const m of evictable) {
      if (residentTotal + need <= MEMORY_BUDGET_BYTES) break;
      if (signal && signal.aborted) throw Object.assign(new Error('Обработка прервана'), { name: 'AbortError' });
      onProgress(`Выгружается модель ${m.modelKey} — освобождаю память`);
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
  ensureLoaded, feasibility, desiredContext, fittingContext, listLoaded,
  acquireUse, releaseUse, MEMORY_BUDGET_BYTES, MIN_CONTEXT,
};
