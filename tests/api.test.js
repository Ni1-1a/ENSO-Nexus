'use strict';
/* API tests: run against a real app instance in mock AI mode on an ephemeral port. */
const os = require('os');
const path = require('path');
const fs = require('fs');
process.env.DATA_DIR = path.join(os.tmpdir(), `pilot1-api-${process.pid}`);
process.env.ANTHROPIC_API_KEY = '';
process.env.RATE_LIMIT_GENERAL = '1000';
process.env.RATE_LIMIT_EXPENSIVE = '1000';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { createApp } = require('../server/app');

let server, base;

before(async () => {
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server.close();
  fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
});

const api = async (p, opts = {}) => {
  const res = await fetch(base + p, opts);
  let body = null;
  try { body = await res.clone().json(); } catch { body = await res.text(); }
  return { status: res.status, body, res };
};
const auth = (s) => ({ Authorization: `Bearer ${s.token}` });
const uploadForm = (files) => {
  const fd = new FormData();
  for (const [name, content, type] of files) fd.append('files', new File([content], name, { type }));
  return fd;
};
async function createSession() {
  const { status, body } = await api('/api/sessions', { method: 'POST' });
  assert.strictEqual(status, 201);
  return body;
}
async function waitJob(s, target, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { body } = await api(`/api/sessions/${s.id}/status`, { headers: auth(s) });
    if (target.includes(body.jobStatus)) return body.jobStatus;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`job did not reach ${target}`);
}

test('health reports mode and limits', async () => {
  const { status, body } = await api('/api/health');
  assert.strictEqual(status, 200);
  assert.strictEqual(body.aiMode, 'mock');
  assert.ok(body.limits.maxFiles > 0);
});

test('session lifecycle: create → get → delete; wrong token rejected', async () => {
  const s = await createSession();
  const ok = await api(`/api/sessions/${s.id}`, { headers: auth(s) });
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(ok.body.jobStatus, 'idle');

  const badToken = await api(`/api/sessions/${s.id}`, { headers: { Authorization: 'Bearer deadbeef' } });
  assert.strictEqual(badToken.status, 404);
  const noToken = await api(`/api/sessions/${s.id}`);
  assert.strictEqual(noToken.status, 404);

  const del = await api(`/api/sessions/${s.id}`, { method: 'DELETE', headers: auth(s) });
  assert.strictEqual(del.status, 200);
  const gone = await api(`/api/sessions/${s.id}`, { headers: auth(s) });
  assert.strictEqual(gone.status, 404);
});

test('uploads: single, multiple, unsupported, oversized, delete', async () => {
  const s = await createSession();

  const one = await api(`/api/sessions/${s.id}/files`, { method: 'POST', headers: auth(s), body: uploadForm([['ГПЗУ.pdf', '%PDF-1.4 data', 'application/pdf']]) });
  assert.strictEqual(one.status, 200);
  assert.strictEqual(one.body.uploaded.length, 1);

  const multi = await api(`/api/sessions/${s.id}/files`, { method: 'POST', headers: auth(s), body: uploadForm([['ТЗ.txt', 'задание', 'text/plain'], ['данные.json', '{"a":1}', 'application/json']]) });
  assert.strictEqual(multi.body.uploaded.length, 2);

  const bad = await api(`/api/sessions/${s.id}/files`, { method: 'POST', headers: auth(s), body: uploadForm([['virus.exe', 'MZ', 'application/octet-stream']]) });
  assert.strictEqual(bad.status, 400);
  assert.match(bad.body.errors[0].error, /не поддерживается/);

  const fakePdf = await api(`/api/sessions/${s.id}/files`, { method: 'POST', headers: auth(s), body: uploadForm([['fake.pdf', 'MZ not a pdf', 'application/pdf']]) });
  assert.strictEqual(fakePdf.status, 400);
  assert.match(fakePdf.body.errors[0].error, /не является PDF/);

  const big = await api(`/api/sessions/${s.id}/files`, { method: 'POST', headers: auth(s), body: uploadForm([['big.txt', 'x'.repeat(26 * 1024 * 1024), 'text/plain']]) });
  assert.ok(big.status === 400 || big.status === 413);

  const view = await api(`/api/sessions/${s.id}`, { headers: auth(s) });
  assert.strictEqual(view.body.files.length, 3);
  const fileId = view.body.files[0].id;
  const del = await api(`/api/sessions/${s.id}/files/${fileId}`, { method: 'DELETE', headers: auth(s) });
  assert.strictEqual(del.status, 200);
  const view2 = await api(`/api/sessions/${s.id}`, { headers: auth(s) });
  assert.strictEqual(view2.body.files.length, 2);
});

test('comment is stored and returned', async () => {
  const s = await createSession();
  const set = await api(`/api/sessions/${s.id}/comment`, {
    method: 'POST', headers: { ...auth(s), 'Content-Type': 'application/json' },
    body: JSON.stringify({ comment: 'ТХ отсутствует' }),
  });
  assert.strictEqual(set.status, 200);
  const view = await api(`/api/sessions/${s.id}`, { headers: auth(s) });
  assert.strictEqual(view.body.comment, 'ТХ отсутствует');
});

test('processing requires files; empty message rejected', async () => {
  const s = await createSession();
  const p = await api(`/api/sessions/${s.id}/process`, { method: 'POST', headers: { ...auth(s), 'Content-Type': 'application/json' }, body: '{}' });
  assert.strictEqual(p.status, 400);
  const m = await api(`/api/sessions/${s.id}/messages`, { method: 'POST', headers: { ...auth(s), 'Content-Type': 'application/json' }, body: JSON.stringify({ text: '' }) });
  assert.strictEqual(m.status, 400);
});

test('full pipeline: process → question → answer → completed → results → download', async () => {
  const s = await createSession();
  await api(`/api/sessions/${s.id}/files`, { method: 'POST', headers: auth(s), body: uploadForm([['ГПЗУ.pdf', '%PDF-1.4', 'application/pdf']]) });

  const p = await api(`/api/sessions/${s.id}/process`, { method: 'POST', headers: { ...auth(s), 'Content-Type': 'application/json' }, body: '{}' });
  assert.strictEqual(p.status, 202);
  await waitJob(s, ['needs_clarification']);

  const view = await api(`/api/sessions/${s.id}`, { headers: auth(s) });
  const q = view.body.questions.find((x) => x.status === 'pending');
  assert.ok(q, 'clarifying question present');
  assert.ok(view.body.events.some((e) => e.stage.includes('уточнение')));

  const ans = await api(`/api/sessions/${s.id}/questions/${q.id}/answer`, {
    method: 'POST', headers: { ...auth(s), 'Content-Type': 'application/json' },
    body: JSON.stringify({ answer: '2 этажа, 1790 м²' }),
  });
  assert.strictEqual(ans.status, 200);
  assert.strictEqual(ans.body.continued, true);
  await waitJob(s, ['completed']);

  const results = await api(`/api/sessions/${s.id}/results`, { headers: auth(s) });
  const names = results.body.results.map((r) => r.filename);
  assert.ok(names.includes('ОТЧЁТ.md'));
  assert.ok(names.includes('результаты.zip'));
  for (const r of results.body.results) assert.ok(r.size > 0, `${r.filename} is not empty`);

  const zip = results.body.results.find((r) => r.format === 'zip');
  const dl = await fetch(`${base}/api/sessions/${s.id}/results/${zip.id}/download`, { headers: auth(s) });
  assert.strictEqual(dl.status, 200);
  const buf = Buffer.from(await dl.arrayBuffer());
  assert.strictEqual(buf.subarray(0, 2).toString(), 'PK');

  // repeated processing start is allowed after completion (idempotent re-run)
  const again = await api(`/api/sessions/${s.id}/process`, { method: 'POST', headers: { ...auth(s), 'Content-Type': 'application/json' }, body: '{}' });
  assert.strictEqual(again.status, 202);
  await waitJob(s, ['completed', 'needs_clarification', 'failed']);
});

test('two sessions are fully isolated', async () => {
  const a = await createSession();
  const b = await createSession();
  await api(`/api/sessions/${a.id}/files`, { method: 'POST', headers: auth(a), body: uploadForm([['secret-a.txt', 'данные A', 'text/plain']]) });

  // B cannot read A's session with its own token
  const cross = await api(`/api/sessions/${a.id}`, { headers: auth(b) });
  assert.strictEqual(cross.status, 404);

  const viewB = await api(`/api/sessions/${b.id}`, { headers: auth(b) });
  assert.strictEqual(viewB.body.files.length, 0);

  // B cannot download A's results by guessing ids
  const fake = await api(`/api/sessions/${b.id}/results/00000000-0000-0000-0000-000000000000/download`, { headers: auth(b) });
  assert.strictEqual(fake.status, 404);
});

test('unknown routes and malformed ids return structured errors', async () => {
  const nf = await api('/api/nope');
  assert.strictEqual(nf.status, 404);
  assert.ok(nf.body.error);
  const badId = await api('/api/sessions/../etc/passwd', { headers: { Authorization: 'Bearer x' } });
  assert.ok([400, 404].includes(badId.status));
  // error body never contains a stack trace
  assert.ok(!JSON.stringify(nf.body).includes('at '));
});

test('message length limit enforced', async () => {
  const s = await createSession();
  await api(`/api/sessions/${s.id}/files`, { method: 'POST', headers: auth(s), body: uploadForm([['a.txt', 'x', 'text/plain']]) });
  const long = await api(`/api/sessions/${s.id}/messages`, {
    method: 'POST', headers: { ...auth(s), 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'x'.repeat(5000) }),
  });
  assert.strictEqual(long.status, 400);
});
