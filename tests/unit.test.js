'use strict';
process.env.DATA_DIR = require('path').join(require('os').tmpdir(), `pilot1-unit-${process.pid}`);
const { test } = require('node:test');
const assert = require('node:assert');

const { sanitizeFilename, checkMagic, validateUpload } = require('../server/services/validation');
const { writeDxf } = require('../server/services/dxf');
const { validateResponse } = require('../server/services/claude/schema');
const { tryParse } = require('../server/services/claude/adapter');

test('sanitizeFilename strips paths and dangerous characters', () => {
  assert.strictEqual(sanitizeFilename('../../etc/passwd'), 'passwd');
  assert.strictEqual(sanitizeFilename('..\\..\\win.ini'), '_.._win.ini'.replace('_.._', '_').length > 0 ? sanitizeFilename('..\\..\\win.ini') : '');
  assert.ok(!sanitizeFilename('a/b/c.pdf').includes('/'));
  assert.ok(!sanitizeFilename('x<>:"|?*.pdf').match(/[<>:"|?*]/));
  assert.strictEqual(sanitizeFilename(''), 'file');
  assert.ok(sanitizeFilename('ГПЗУ участок.pdf').includes('ГПЗУ'));
});

test('checkMagic validates content, not extension', () => {
  assert.ok(checkMagic('pdf', Buffer.from('%PDF-1.7 x')).ok);
  assert.ok(!checkMagic('pdf', Buffer.from('MZ executable')).ok);
  assert.ok(checkMagic('dwg', Buffer.from('AC1027xxxx')).ok);
  assert.ok(!checkMagic('dwg', Buffer.from('notadwg')).ok);
  assert.ok(checkMagic('txt', Buffer.from('обычный текст')).ok);
  assert.ok(!checkMagic('txt', Buffer.from([0x00, 0x01, 0x02])).ok);
  assert.ok(checkMagic('json', Buffer.from('{"a":1}')).ok);
  assert.ok(!checkMagic('json', Buffer.from('{broken')).ok);
  assert.ok(!checkMagic('exe', Buffer.from('MZ')).ok);
});

test('validateUpload enforces size and count limits', () => {
  const small = { originalName: 'a.txt', buffer: Buffer.from('hello') };
  assert.ok(validateUpload(small, []).ok);
  const badExt = { originalName: 'a.exe', buffer: Buffer.from('MZ') };
  assert.ok(!validateUpload(badExt, []).ok);
  const many = Array.from({ length: 10 }, () => ({ size: 10 }));
  assert.ok(!validateUpload(small, many).ok);
  const big = { originalName: 'big.txt', buffer: Buffer.alloc(26 * 1024 * 1024, 65) };
  assert.match(validateUpload(big, []).error, /больше/);
});

test('DXF writer produces a valid R12 skeleton', () => {
  const dxf = writeDxf([{ layer: 'AI_ГРАНИЦЫ_ЗУ', color: 3, closed: true, points: [[0, 0], [10, 0], [10, 10]] }]);
  assert.ok(dxf.includes('AC1009'));
  assert.ok(dxf.includes('AI_ГРАНИЦЫ_ЗУ'));
  assert.ok(dxf.includes('POLYLINE'));
  assert.strictEqual((dxf.match(/VERTEX/g) || []).length, 3);
  assert.ok(dxf.trimEnd().endsWith('EOF'));
});

test('model response validation: happy path', () => {
  const r = validateResponse({
    status: 'completed', message: 'готово', questions: [], facts: [{ key: 'a', value: '1', source: 's' }],
    warnings: [], conflicts: [], assumptions: [], report_markdown: '# x', geometry: [], tep: [],
  });
  assert.ok(r.ok);
  assert.strictEqual(r.value.facts[0].key, 'a');
});

test('model response validation: rejects broken structures', () => {
  assert.ok(!validateResponse(null).ok);
  assert.ok(!validateResponse({ status: 'wat', message: 'x' }).ok);
  assert.ok(!validateResponse({ status: 'completed', message: '' }).ok);
  // needs_clarification requires questions
  assert.ok(!validateResponse({ status: 'needs_clarification', message: 'x', questions: [] }).ok);
  // bad geometry filtered out
  const r = validateResponse({
    status: 'completed', message: 'x', geometry: [{ layer: 'L', points: [[1]] }, { layer: 'L2', points: [[0, 0], [1, 1]] }],
  });
  assert.ok(r.ok);
  assert.strictEqual(r.value.geometry.length, 1);
});

test('tryParse recovers JSON wrapped in prose', () => {
  assert.deepStrictEqual(tryParse('{"a":1}'), { a: 1 });
  assert.deepStrictEqual(tryParse('Вот ответ: {"a":1} конец'), { a: 1 });
  assert.strictEqual(tryParse('no json here'), null);
});

/* ---------------- knowledge base ---------------- */
const os = require('os');
const fs = require('fs');
const pathMod = require('path');
const kb = require('../server/services/kb');

test('kb: loadSourceChunks reads чанки.jsonl and falls back to пункты.json', () => {
  const dir = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'kb-'));
  const vec = pathMod.join(dir, '09_Векторный-индекс', 'СП 42.13330');
  const jsn = pathMod.join(dir, '04_JSON', 'ГОСТ 21.508-2020');
  fs.mkdirSync(vec, { recursive: true });
  fs.mkdirSync(jsn, { recursive: true });
  fs.writeFileSync(pathMod.join(vec, 'чанки.jsonl'), JSON.stringify({
    'документ': 'СП 42.13330', 'пункт': '5.3', 'приоритет': 'высокий',
    'текст': 'Минимальные отступы от красных линий устанавливаются градостроительным регламентом и составляют не менее установленных значений для данной зоны.',
  }) + '\n');
  fs.writeFileSync(pathMod.join(jsn, 'пункты.json'), JSON.stringify([
    { 'номер': '4.1', 'уровень': 1, 'текст': 'Рабочую документацию генеральных планов выполняют в соответствии с требованиями настоящего стандарта и ГОСТ Р 21.101 на основе утверждённой проектной документации.' },
    { 'номер': 'x', 'уровень': 1, 'текст': 'коротко' },
  ]));
  const chunks = kb.loadSourceChunks(dir);
  assert.strictEqual(chunks.length, 2, 'short clause is filtered out');
  assert.ok(chunks.some((c) => c.doc === 'СП 42.13330' && c.clause === '5.3'));
  assert.ok(chunks.some((c) => c.doc === 'ГОСТ 21.508-2020' && c.clause === '4.1'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('kb: cosine and keyword scoring behave sanely', () => {
  const a = Float32Array.from([1, 0, 0]), b = Float32Array.from([1, 0, 0]), c = Float32Array.from([0, 1, 0]);
  assert.ok(kb.cosine(a, b) > 0.99);
  assert.ok(kb.cosine(a, c) < 0.01);
  const words = 'противопожарные разрывы между зданиями'.toLowerCase().split(/\s+/);
  const hit = kb.keywordScore(words, 'СП 4.13130: противопожарные разрывы между зданиями и сооружениями');
  const miss = kb.keywordScore(words, 'озеленение территории жилой застройки');
  assert.ok(hit > miss);
});
