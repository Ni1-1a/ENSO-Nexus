'use strict';

/** JSON schema for structured model output. Validated server-side before use. */
const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['needs_clarification', 'completed', 'failed'] },
    message: { type: 'string' },
    questions: {
      type: 'array',
      items: {
        type: 'object',
        properties: { text: { type: 'string' }, why: { type: 'string' } },
        required: ['text', 'why'],
        additionalProperties: false,
      },
    },
    facts: {
      type: 'array',
      items: {
        type: 'object',
        properties: { key: { type: 'string' }, value: { type: 'string' }, source: { type: 'string' } },
        required: ['key', 'value', 'source'],
        additionalProperties: false,
      },
    },
    warnings: { type: 'array', items: { type: 'string' } },
    conflicts: { type: 'array', items: { type: 'string' } },
    assumptions: { type: 'array', items: { type: 'string' } },
    report_markdown: { type: 'string' },
    geometry: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          layer: { type: 'string' },
          color: { type: 'integer' },
          closed: { type: 'boolean' },
          points: { type: 'array', items: { type: 'array', items: { type: 'number' } } },
        },
        required: ['layer', 'points'],
        additionalProperties: false,
      },
    },
    tep: {
      type: 'array',
      items: {
        type: 'object',
        properties: { name: { type: 'string' }, value: { type: 'string' }, unit: { type: 'string' } },
        required: ['name', 'value', 'unit'],
        additionalProperties: false,
      },
    },
  },
  required: ['status', 'message', 'questions', 'facts', 'warnings', 'conflicts', 'assumptions', 'report_markdown', 'geometry', 'tep'],
  additionalProperties: false,
};

/** Validate + normalize a model response object. Returns {ok, value|error}. */
function validateResponse(raw) {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'not an object' };
  const v = {};
  if (!['needs_clarification', 'completed', 'failed'].includes(raw.status)) {
    return { ok: false, error: `bad status: ${raw.status}` };
  }
  v.status = raw.status;
  if (typeof raw.message !== 'string' || !raw.message.trim()) return { ok: false, error: 'empty message' };
  v.message = raw.message;
  const arr = (x) => (Array.isArray(x) ? x : []);
  v.questions = arr(raw.questions).filter((q) => q && typeof q.text === 'string' && q.text.trim())
    .map((q) => ({ text: q.text.trim(), why: typeof q.why === 'string' ? q.why : '' }));
  v.facts = arr(raw.facts).filter((f) => f && typeof f.key === 'string' && f.key.trim())
    .map((f) => ({ key: f.key.trim(), value: String(f.value ?? '').trim(), source: String(f.source ?? '').trim() }))
    .filter((f) => /[\p{L}\p{N}]/u.test(f.value)); // drop artifacts like "}, " from weaker models
  v.warnings = arr(raw.warnings).map(String);
  v.conflicts = arr(raw.conflicts).map(String);
  v.assumptions = arr(raw.assumptions).map(String);
  v.report_markdown = typeof raw.report_markdown === 'string' ? raw.report_markdown : '';
  v.geometry = arr(raw.geometry).filter(
    (g) => g && typeof g.layer === 'string' && Array.isArray(g.points) && g.points.length >= 2 &&
      g.points.every((p) => Array.isArray(p) && p.length >= 2 && p.every((n) => Number.isFinite(n))),
  );
  v.tep = arr(raw.tep).filter((t) => t && typeof t.name === 'string')
    .map((t) => ({ name: t.name, value: String(t.value ?? ''), unit: String(t.unit ?? '') }));
  if (v.status === 'needs_clarification' && v.questions.length === 0) {
    return { ok: false, error: 'needs_clarification without questions' };
  }
  return { ok: true, value: v };
}

module.exports = { RESPONSE_SCHEMA, validateResponse };
