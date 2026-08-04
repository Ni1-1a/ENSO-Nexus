'use strict';
/**
 * End-to-end smoke test: walks the entire user journey against a running app
 * (static page + API), exactly as the browser client does.
 */
const os = require('os');
const path = require('path');
const fs = require('fs');
process.env.DATA_DIR = path.join(os.tmpdir(), `pilot1-e2e-${process.pid}`);
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

test('e2e smoke: page → session → upload → comment → process → Q&A → result → download → restore → delete', async () => {
  // 1. new user opens the page
  const page = await fetch(base + '/');
  assert.strictEqual(page.status, 200);
  const html = await page.text();
  assert.ok(html.includes('ENSO Nexus'));
  assert.ok((await fetch(base + '/app.js')).ok);
  assert.ok((await fetch(base + '/styles.css')).ok);

  // 2. client reads health/limits
  const health = await (await fetch(base + '/api/health')).json();
  assert.strictEqual(health.aiMode, 'mock'); // honest mock mode is reported to the UI

  // 3. create session
  const s = await (await fetch(base + '/api/sessions', { method: 'POST' })).json();
  const H = { Authorization: `Bearer ${s.token}` };
  const HJ = { ...H, 'Content-Type': 'application/json' };

  // 4. upload files
  const fd = new FormData();
  fd.append('files', new File(['%PDF-1.4 гпзу'], 'ГПЗУ.pdf', { type: 'application/pdf' }));
  fd.append('files', new File(['ТЗ: цех, 2 этажа'], 'ТЗ.txt', { type: 'text/plain' }));
  const up = await (await fetch(`${base}/api/sessions/${s.id}/files`, { method: 'POST', headers: H, body: fd })).json();
  assert.strictEqual(up.uploaded.length, 2);

  // 5. comment + start processing
  await fetch(`${base}/api/sessions/${s.id}/comment`, { method: 'POST', headers: HJ, body: JSON.stringify({ comment: 'ТХ отсутствует' }) });
  const proc = await fetch(`${base}/api/sessions/${s.id}/process`, { method: 'POST', headers: HJ, body: '{}' });
  assert.strictEqual(proc.status, 202);

  // 6. wait for clarifying question
  let view;
  for (let i = 0; i < 50; i++) {
    view = await (await fetch(`${base}/api/sessions/${s.id}`, { headers: H })).json();
    if (view.jobStatus === 'needs_clarification') break;
    await new Promise((r) => setTimeout(r, 200));
  }
  assert.strictEqual(view.jobStatus, 'needs_clarification');
  const q = view.questions.find((x) => x.status === 'pending');
  assert.ok(q);

  // 7. "page refresh mid-work": re-fetch the whole session with stored credentials
  const restored = await (await fetch(`${base}/api/sessions/${s.id}`, { headers: H })).json();
  assert.strictEqual(restored.messages.length, view.messages.length);
  assert.ok(restored.files.length === 2);

  // 8. answer → processing continues → completed
  const ans = await (await fetch(`${base}/api/sessions/${s.id}/questions/${q.id}/answer`, {
    method: 'POST', headers: HJ, body: JSON.stringify({ answer: '3 этажа, 1193 м²' }),
  })).json();
  assert.strictEqual(ans.continued, true);
  for (let i = 0; i < 50; i++) {
    view = await (await fetch(`${base}/api/sessions/${s.id}`, { headers: H })).json();
    if (view.jobStatus === 'completed') break;
    await new Promise((r) => setTimeout(r, 200));
  }
  assert.strictEqual(view.jobStatus, 'completed');

  // 9. results exist, are non-empty, and download correctly
  assert.ok(view.results.length >= 3);
  const report = view.results.find((r) => r.filename === 'ОТЧЁТ.md');
  const dxf = view.results.find((r) => r.format === 'dxf');
  const zip = view.results.find((r) => r.format === 'zip');
  assert.ok(report && dxf && zip);
  const reportText = await (await fetch(`${base}/api/sessions/${s.id}/results/${report.id}/download`, { headers: H })).text();
  assert.ok(reportText.includes('ОТЧЁТ'));
  const dxfText = await (await fetch(`${base}/api/sessions/${s.id}/results/${dxf.id}/download`, { headers: H })).text();
  assert.ok(dxfText.includes('POLYLINE'));

  // 10. dialogue history persisted server-side
  const msgs = await (await fetch(`${base}/api/sessions/${s.id}/messages`, { headers: H })).json();
  assert.ok(msgs.messages.some((m) => m.role === 'assistant'));
  assert.ok(msgs.messages.some((m) => m.kind === 'answer'));

  // 11. delete session and verify data is gone
  await fetch(`${base}/api/sessions/${s.id}`, { method: 'DELETE', headers: H });
  const gone = await fetch(`${base}/api/sessions/${s.id}`, { headers: H });
  assert.strictEqual(gone.status, 404);
  const uploads = path.join(process.env.DATA_DIR, 'uploads', s.id);
  assert.ok(!fs.existsSync(uploads), 'uploaded files are removed from disk');
});
