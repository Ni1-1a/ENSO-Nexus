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

function lms(args, timeoutMs = 30000) {
  const bin = findLms();
  if (!bin) return Promise.reject(new Error('CLI `lms` не найден — управление моделями недоступно'));
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`lms ${args[0]}: ${(stderr || err.message).slice(0, 300)}`));
      else resolve(stdout);
    });
  });
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
 * Помещается ли модель в память в одиночку (веса + KV желаемого контекста).
 * Возвращает {feasible, note, sizeBytes}.
 */
async function feasibility(modelId) {
  let size = 0;
  try { size = (await listDownloaded()).get(modelId) || 0; } catch { /* нет lms — не оцениваем */ }
  if (!size) return { feasible: true, note: '', sizeBytes: 0 };
  const need = size + kvBytes(modelId, desiredContext(modelId));
  const gb = (n) => (n / 1024 ** 3).toFixed(1);
  if (need > MEMORY_BUDGET_BYTES) {
    return {
      feasible: false, sizeBytes: size,
      note: `не помещается в память: нужно ~${gb(need)} ГБ при доступных ~${gb(MEMORY_BUDGET_BYTES)} ГБ`,
    };
  }
  if (need > MEMORY_BUDGET_BYTES * 0.85) {
    return { feasible: true, sizeBytes: size, note: `займёт почти всю память (~${gb(need)} ГБ) — другие модели будут выгружены` };
  }
  return { feasible: true, sizeBytes: size, note: '' };
}

/** Сериализация ensureLoaded: параллельные вызовы не должны спорить за память. */
let ensureChain = Promise.resolve();

/**
 * Гарантирует, что модель загружена с нужным контекстом. При нехватке памяти
 * осознанно выгружает другие LLM (embedding-модели не трогает).
 * onProgress(text) — человеко-читаемые статусы для журнала/индикатора.
 */
function ensureLoaded(modelId, { onProgress = () => {} } = {}) {
  const run = async () => {
    if (!findLms()) return { ok: true, managed: false }; // нет CLI — надеемся на JIT
    const wantCtx = desiredContext(modelId);
    let loaded;
    try { loaded = await listLoaded(); } catch { return { ok: true, managed: false }; }

    const target = loaded.find((m) => m.modelKey === modelId && m.type !== 'embedding');
    if (target && target.contextLength >= wantCtx && target.contextLength <= wantCtx * 4) {
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
    const residentCost = (m) => m.sizeBytes + kvBytes(m.modelKey, m.contextLength || 4096);

    // освобождаем память: выгружаем самые крупные LLM, пока не поместимся
    const evictable = loaded.filter((m) => m.type !== 'embedding').sort((a, b) => residentCost(b) - residentCost(a));
    let residentTotal = loaded.reduce((s, m) => s + residentCost(m), 0);
    for (const m of evictable) {
      if (residentTotal + need <= MEMORY_BUDGET_BYTES) break;
      onProgress(`Выгружается модель ${m.modelKey} — освобождаю память`);
      try { await lms(['unload', m.identifier], 60000); residentTotal -= residentCost(m); } catch (err) {
        console.warn('[model-manager] unload failed:', err.message);
      }
    }

    onProgress(`Загружается модель ${modelId} (контекст ${wantCtx.toLocaleString('ru-RU')} токенов)…`);
    const t0 = Date.now();
    await lms(['load', modelId, '--context-length', String(wantCtx), '--ttl', '7200', '-y'], 240000);
    onProgress(`Модель ${modelId} загружена за ${Math.round((Date.now() - t0) / 1000)} с`);
    return { ok: true, managed: true, loadedNow: true };
  };
  // цепочка: одновременные ensureLoaded выполняются последовательно
  const result = ensureChain.then(run, run);
  ensureChain = result.catch(() => {});
  return result;
}

module.exports = { ensureLoaded, feasibility, desiredContext, listLoaded, MEMORY_BUDGET_BYTES };
