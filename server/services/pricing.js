'use strict';
/**
 * Тарифы облачных моделей, USD за 1 млн токенов.
 * Anthropic — из справочника Claude API (актуализировано 2026-08-05):
 *   кэш ephemeral 5 мин: запись 1.25× от входной цены, чтение 0.1×.
 *   У claude-sonnet-5 действует интро-цена $2/$10 до 31.08.2026 — считаем
 *   по постоянному тарифу $3/$15 (оценка сверху).
 * OpenAI — из открытых сводок (2026-08); при подключении ключа сверить
 * с платформой. Кэш-поля OpenAI не заведены (наш OpenAI-путь их не шлёт).
 * Локальные модели (LM Studio/Ollama) и демо-режим бесплатны.
 *
 * ПОРЯДОК ЗДЕСЬ — ЧАСТЬ ТАРИФА. priceFor/costUsd берут ПЕРВОЕ совпадение, поэтому
 * частное правило обязано стоять выше общего: `/^gpt-5[.-]4/` ниже `/^gpt-5/` —
 * это молча недостижимое правило и неверный ценник в интерфейсе и в cost_usd.
 * Так и случилось с gpt-5.4 и gpt-5.4-nano. Перекрытия ловит автоматический тест
 * (tests/fix-providers.test.js): он строит образец имени по каждому регэкспу и
 * требует, чтобы образец попадал именно в своё правило.
 */
const PRICES = [
  // Anthropic
  { match: /^claude-(fable|mythos)/, input: 10.0, output: 50.0, cacheWrite: 12.5, cacheRead: 1.0 },
  { match: /^claude-opus/, input: 5.0, output: 25.0, cacheWrite: 6.25, cacheRead: 0.5 },
  { match: /^claude-sonnet/, input: 3.0, output: 15.0, cacheWrite: 3.75, cacheRead: 0.3 },
  { match: /^claude-haiku/, input: 1.0, output: 5.0, cacheWrite: 1.25, cacheRead: 0.1 },
  // OpenAI (GPT-5.6 семейство — GA 09.07.2026; Terra подешевела 30.07.2026 с $2.5/$15).
  // ID моделей OpenAI пишутся через точку (gpt-5.6-terra); регэкспы терпимы к обоим вариантам.
  { match: /^gpt-5[.-]6-sol/, input: 5.0, output: 30.0 },
  { match: /^gpt-5[.-]6-terra/, input: 2.0, output: 12.0 },
  { match: /^gpt-5[.-]6-luna/, input: 0.2, output: 1.2 },
  { match: /^gpt-5[.-]5-pro/, input: 30.0, output: 180.0 },
  { match: /^gpt-5[.-]5/, input: 5.0, output: 30.0 },
  // 5.4-pro: официально $30/$180 (сообщения о $15/$90 — сторонние агрегаторы; считаем оценкой сверху)
  { match: /^gpt-5[.-]4-pro/, input: 30.0, output: 180.0 },
  { match: /^gpt-5[.-]4-mini/, input: 0.75, output: 4.5 },
  { match: /^gpt-5[.-]4-nano/, input: 0.2, output: 1.25 },
  { match: /^gpt-5[.-]4/, input: 2.5, output: 15.0 },
  // Промежуточные поколения GPT-5.0–5.3 (сводки 2026-08; 5.3 — по Codex-варианту,
  // 5.2-pro — оценка по gpt-5-pro до появления официальной цены)
  { match: /^gpt-5[.-]3/, input: 1.75, output: 14.0 },
  { match: /^gpt-5[.-]2-pro/, input: 15.0, output: 120.0 },
  { match: /^gpt-5[.-]2/, input: 0.875, output: 7.0 },
  { match: /^gpt-5[.-]1/, input: 1.25, output: 10.0 },
  { match: /^gpt-5-pro/, input: 15.0, output: 120.0 },
  { match: /^gpt-5-mini/, input: 0.25, output: 2.0 },
  { match: /^gpt-5-nano/, input: 0.05, output: 0.4 },
  { match: /^gpt-5/, input: 1.25, output: 10.0 }, // gpt-5, gpt-5-chat-latest

  // Старые семейства OpenAI (справочные цены, сводки 2026-08): порядок важен —
  // более специфичные регэкспы выше общих
  { match: /^gpt-4[.-]1-mini/, input: 0.4, output: 1.6 },
  { match: /^gpt-4[.-]1-nano/, input: 0.1, output: 0.4 },
  { match: /^gpt-4[.-]1/, input: 2.0, output: 8.0 },
  { match: /^chatgpt-4o/, input: 5.0, output: 15.0 },
  { match: /^gpt-4o-mini/, input: 0.15, output: 0.6 },
  { match: /^gpt-4o/, input: 2.5, output: 10.0 },
  { match: /^gpt-4-turbo/, input: 10.0, output: 30.0 },
  { match: /^gpt-4/, input: 30.0, output: 60.0 },
  { match: /^gpt-3[.-]5/, input: 0.5, output: 1.5 },
  { match: /^o1-mini/, input: 1.1, output: 4.4 },
  { match: /^o1/, input: 15.0, output: 60.0 },
  { match: /^o3-mini/, input: 1.1, output: 4.4 },
  { match: /^o3/, input: 2.0, output: 8.0 },
  { match: /^o4-mini/, input: 1.1, output: 4.4 },
  // Kimi (Moonshot AI), сводки 2026-08: K3 $3/$15, K2.7-Code и K2.6 $0.95/$4, K2.5 $0.6/$3
  { match: /^kimi-k3/, input: 3.0, output: 15.0 },
  { match: /^kimi-k2[.-]7/, input: 0.95, output: 4.0 },
  { match: /^kimi-k2[.-]6/, input: 0.95, output: 4.0 },
  { match: /^kimi-k2[.-]5/, input: 0.6, output: 3.0 },
  { match: /^kimi-latest/, input: 0.6, output: 3.0 },
  { match: /^kimi-k2/, input: 0.6, output: 2.5 },
];

// gemini здесь тоже платный: тарифов в справочнике нет, поэтому интерфейс честно
// предупредит, что расход не попадёт в счётчик — придумывать расценки нельзя.
// GigaChat и YandexGPT тарифицируются в рублях — в долларовый справочник их
// цены не заносятся, расход по ним считает кабинет провайдера.
const PAID_PROVIDERS = new Set(['claude', 'chatgpt', 'kimi', 'gemini', 'gigachat', 'yandexgpt']);

/** Тариф модели {input, output} в USD за 1 млн токенов, либо null. */
function priceFor(model) {
  const p = PRICES.find((x) => x.match.test(model || ''));
  return p ? { input: p.input, output: p.output } : null;
}

/**
 * Стоимость одного запроса в USD по usage-полям ответа.
 * usage: { input_tokens, output_tokens, cache_creation_input_tokens?, cache_read_input_tokens? }
 */
function costUsd(provider, model, usage = {}) {
  if (!PAID_PROVIDERS.has(provider)) return 0;
  const p = PRICES.find((x) => x.match.test(model || ''));
  if (!p) return 0;
  return (
    (usage.input_tokens || 0) * p.input +
    (usage.output_tokens || 0) * p.output +
    (usage.cache_creation_input_tokens || 0) * (p.cacheWrite || p.input) +
    (usage.cache_read_input_tokens || 0) * (p.cacheRead || p.input)
  ) / 1e6;
}

module.exports = { costUsd, priceFor, PRICES };
