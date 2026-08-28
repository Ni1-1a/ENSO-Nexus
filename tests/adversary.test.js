'use strict';
/**
 * Промежуточный проверяющий (adversary) перед отправкой ответа пользователю.
 *
 * Живой прогон с моделью здесь не выполняется — проверяются контракты, на
 * которых держится встройка: строгость схемы вердикта (правила локальных
 * движков и strict-режима), выключатели, подстановка замечаний в задание
 * доработки и то, что сбой проверки не съедает ответ.
 */
const test = require('node:test');
const assert = require('node:assert');

process.env.AI_PROVIDER = process.env.AI_PROVIDER || 'mock';

const adversary = require('../server/services/claude/adversary');
const config = require('../server/config');

test('adversary: схема вердикта строгая — required перечисляет все ключи, объекты закрыты', () => {
  const walk = (node, where) => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'object' || node.properties) {
      assert.strictEqual(node.additionalProperties, false, `${where}: additionalProperties должен быть false`);
      const props = Object.keys(node.properties || {});
      assert.deepStrictEqual(
        [...(node.required || [])].sort(), [...props].sort(),
        `${where}: required обязан перечислять ВСЕ ключи properties (правило strict-режима)`,
      );
      for (const [k, v] of Object.entries(node.properties || {})) walk(v, `${where}.${k}`);
    }
    if (node.items) walk(node.items, `${where}[]`);
  };
  walk(adversary.REVIEW_SCHEMA, 'REVIEW_SCHEMA');
});

test('adversary: в mock-режиме и для демо-маршрута проверка выключена', () => {
  assert.strictEqual(config.aiMode, 'mock', 'тесты обязаны идти в mock-режиме');
  assert.strictEqual(adversary.enabled({ provider: 'lmstudio' }), false, 'mock-режим: проверять нечем');
  assert.strictEqual(adversary.enabled({ provider: 'demo' }), false);
  assert.strictEqual(adversary.enabled(null), false);
});

test('adversary: review при выключенной проверке возвращает null, не трогая модель', async () => {
  const out = await adversary.review('no-such-session', {
    userText: 'вопрос', draft: 'ответ', route: { provider: 'demo' },
  });
  assert.strictEqual(out, null);
});

test('adversary: замечания подставляются в задание доработки без остатка {{issues}}', () => {
  const issues = [
    { kind: 'факт', text: 'Площадь участка в ответе 3800 м², в фактах 3700,18 м²', quote: '3800 м²' },
    { kind: 'норматив', text: 'Пункт СП назван без источника в данных', quote: null },
  ];
  const text = adversary.reviseInstruction(issues);
  assert.ok(text.includes('3700,18'), 'текст замечания должен войти в задание');
  assert.ok(text.includes('[факт]') && text.includes('[норматив]'), 'вид замечания виден в списке');
  assert.ok(text.includes('«3800 м²»'), 'цитата места должна войти в задание');
  assert.ok(!text.includes('{{'), 'в готовом задании не должно остаться подстановок');
});

test('adversary: текст данных результата анализа собирается из фактов, вопросов и предупреждений', () => {
  const text = adversary.analysisFactsText({
    status: 'completed',
    facts: [{ key: 'plot.area_m2', value: '3700,18', source: 'ГПЗУ, с. 1' }],
    questions: [{ text: 'Какая этажность?' }],
    warnings: ['Площадь по чертежу расходится с ГПЗУ'],
    conflicts: [], assumptions: ['Единицы чертежа приняты метрами'],
  });
  assert.ok(text.includes('plot.area_m2 = 3700,18'));
  assert.ok(text.includes('Какая этажность?'));
  assert.ok(text.includes('расходится с ГПЗУ'));
  assert.ok(text.includes('приняты метрами'));
  assert.ok(text.includes('Статус анализа: completed'));
});

test('adversary: reviewBeforeSend отдаёт исходный черновик, если проверяющий упал', async () => {
  const pipeline = require('../server/services/pipeline');
  // маршрут демо — проверка выключена, черновик проходит насквозь без вызова модели
  const out = await pipeline.reviewBeforeSend('no-such-session', {
    userText: 'в', draft: 'черновик', route: { provider: 'demo' }, signal: null,
    revise: async () => { throw new Error('сюда доходить нельзя'); },
  });
  assert.strictEqual(out, 'черновик');
});

test('adversary: пустой черновик на проверку не отправляется', async () => {
  const pipeline = require('../server/services/pipeline');
  const out = await pipeline.reviewBeforeSend('no-such-session', {
    userText: 'в', draft: '', route: { provider: 'lmstudio' }, signal: null,
    revise: async () => 'не должно вызываться',
  });
  assert.strictEqual(out, '');
});
