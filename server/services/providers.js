'use strict';
/**
 * Реестр AI-провайдеров для выбора в интерфейсе.
 * Доступность и списки моделей определяются автоматически (кэш 15 с).
 */
const config = require('../config');

let cache = null;
let cacheAt = 0;

async function probeOpenAiCompat(baseUrl) {
  try {
    const res = await fetch(`${baseUrl}/models`, { signal: AbortSignal.timeout(2500) });
    if (!res.ok) return null;
    const data = await res.json();
    return (data.data || []).map((m) => m.id).filter((id) => !/embed/i.test(id));
  } catch { return null; }
}

async function listProviders() {
  if (cache && Date.now() - cacheAt < 15000) return cache;
  const [lmModels, ollamaModels] = await Promise.all([
    probeOpenAiCompat(config.localAiBaseUrl),
    probeOpenAiCompat(config.ollamaBaseUrl),
  ]);

  // Для локальных моделей — оценка: помещается ли модель в память машины
  let lmModelsInfo = [];
  if (lmModels && lmModels.length) {
    const mm = require('./model-manager');
    let loadedKeys = new Set();
    try { loadedKeys = new Set((await mm.listLoaded()).map((m) => m.modelKey)); } catch {}
    lmModelsInfo = await Promise.all(lmModels.map(async (id) => {
      const f = await mm.feasibility(id).catch(() => ({ feasible: true, note: '' }));
      return {
        id,
        feasible: f.feasible,
        note: f.note,
        loaded: loadedKeys.has(id),
        context: mm.desiredContext(id),
        sizeGb: f.sizeBytes ? +(f.sizeBytes / 1024 ** 3).toFixed(1) : null,
      };
    }));
  }

  const providers = [
    {
      id: 'claude', label: 'Claude (Anthropic)',
      available: !!config.anthropicApiKey,
      models: [config.anthropicModel],
      note: config.anthropicApiKey ? '' : 'нужен ANTHROPIC_API_KEY на сервере',
    },
    {
      id: 'chatgpt', label: 'ChatGPT (OpenAI)',
      available: !!config.openaiApiKey,
      models: [config.openaiModel],
      note: config.openaiApiKey ? '' : 'нужен OPENAI_API_KEY на сервере',
    },
    {
      id: 'lmstudio', label: 'Локальные модели (LM Studio)',
      available: !!(lmModels && lmModels.length),
      models: lmModels || [],
      modelsInfo: lmModelsInfo,
      note: lmModels ? '' : 'LM Studio не запущен',
    },
    {
      id: 'ollama', label: 'Ollama (локально)',
      available: !!(ollamaModels && ollamaModels.length),
      models: ollamaModels || [],
      note: ollamaModels === null ? 'Ollama не запущен' : (ollamaModels.length ? '' : 'нет чат-моделей: ollama pull <модель>'),
    },
    { id: 'demo', label: 'Демо-режим (без AI)', available: true, models: ['demo'], note: 'тестовая заглушка' },
  ];
  cache = providers;
  cacheAt = Date.now();
  return providers;
}

/** Проверка выбора пользователя; возвращает {ok} или {ok:false, error}. */
async function validateChoice(providerId, model) {
  const providers = await listProviders();
  const p = providers.find((x) => x.id === providerId);
  if (!p) return { ok: false, error: 'Неизвестный провайдер' };
  if (!p.available) return { ok: false, error: `«${p.label}» недоступен: ${p.note}` };
  if (model && p.models.length && !p.models.includes(model)) {
    return { ok: false, error: `Модель «${model}» недоступна у провайдера «${p.label}»` };
  }
  if (model && p.modelsInfo) {
    const info = p.modelsInfo.find((m) => m.id === model);
    if (info && !info.feasible) {
      return { ok: false, error: `Модель «${model}» ${info.note} — выберите модель поменьше` };
    }
  }
  return { ok: true, provider: p };
}

module.exports = { listProviders, validateChoice };
