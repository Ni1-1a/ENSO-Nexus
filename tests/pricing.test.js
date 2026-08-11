'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { costUsd } = require('../server/services/pricing');

test('pricing: claude-opus-5 — вход, выход и кэш-токены', () => {
  const c = costUsd('claude', 'claude-opus-5', {
    input_tokens: 1000,
    output_tokens: 2000,
    cache_creation_input_tokens: 10000,
    cache_read_input_tokens: 100000,
  });
  // 1000×$5 + 2000×$25 + 10000×$6.25 + 100000×$0.50 за 1 млн = $0.1675
  assert.ok(Math.abs(c - 0.1675) < 1e-9, `получено ${c}`);
});

test('pricing: локальные модели и демо бесплатны', () => {
  assert.strictEqual(costUsd('lmstudio', 'qwen/qwen3-coder-30b', { input_tokens: 1e6, output_tokens: 1e6 }), 0);
  assert.strictEqual(costUsd('ollama', 'gemma3:12b', { input_tokens: 1e6 }), 0);
  assert.strictEqual(costUsd('demo', 'demo', { input_tokens: 100 }), 0);
});

test('pricing: модель без тарифа — 0, а не NaN', () => {
  assert.strictEqual(costUsd('chatgpt', 'gpt-99-experimental', { input_tokens: 1000 }), 0);
  assert.strictEqual(costUsd('claude', undefined, { input_tokens: 1000 }), 0);
});

test('pricing: промежуточные и старые семейства OpenAI имеют тариф', () => {
  // gpt-5.2 раньше была примером «без тарифа» — теперь тариф есть ($0.875/1М вход)
  assert.ok(Math.abs(costUsd('chatgpt', 'gpt-5.2', { input_tokens: 1000 }) - 0.000875) < 1e-9);
  assert.ok(costUsd('chatgpt', 'gpt-4o', { input_tokens: 1e6 }) > 0);
  assert.ok(costUsd('kimi', 'kimi-k2.6', { input_tokens: 1e6 }) > 0);
});
