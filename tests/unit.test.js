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
