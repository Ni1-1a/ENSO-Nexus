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
process.env.USERS_FILE = path.join(os.tmpdir(), `pilot1-users-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
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
  assert.ok(html.includes('Enso-nexus'));
  // устаревшие подписи из UI убраны (ТЗ, п. 8–9)
  for (const gone of ['Pilot 1', 'Генплан', '12 шаг', 'методик', 'Скачать Excel']) {
    assert.ok(!html.includes(gone), `в разметке осталось «${gone}»`);
  }
  assert.ok((await fetch(base + '/app.js')).ok);
  assert.ok((await fetch(base + '/styles.css')).ok);

  // 2. client reads health/limits
  const health = await (await fetch(base + '/api/health')).json();
  assert.strictEqual(health.aiMode, 'mock'); // honest mock mode is reported to the UI

  // 3. вход на платформу и создание проекта
  const entered = await (await fetch(base + '/api/auth/enter', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lastName: 'Тестов', firstName: 'Пробный' }),
  })).json();
  assert.strictEqual(entered.status, 'active', 'свободная регистрация впускает сразу');
  const U = { 'X-User-Token': entered.token };
  // без входа проект не заводится
  assert.strictEqual((await fetch(base + '/api/sessions', { method: 'POST' })).status, 401);
  const s = await (await fetch(base + '/api/sessions', { method: 'POST', headers: U })).json();
  const H = { Authorization: `Bearer ${s.token}`, ...U };
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
  const data = view.results.find((r) => r.filename === 'session-data.json');
  const zip = view.results.find((r) => r.format === 'zip');
  assert.ok(report && data && zip);
  // чертежа среди результатов анализа быть не должно: генплан собирается
  // из геометрической модели на выгрузке, а не из ответа модели
  assert.ok(!view.results.some((r) => r.format === 'dxf' || r.format === 'dwg'),
    'анализ больше не выпускает чертёж — раньше он выходил пустым');
  for (const r of view.results) assert.ok(r.size > 0, `пустой файл в результатах: ${r.filename}`);
  const reportText = await (await fetch(`${base}/api/sessions/${s.id}/results/${report.id}/download`, { headers: H })).text();
  assert.ok(reportText.includes('ОТЧЁТ'));
  const dataText = await (await fetch(`${base}/api/sessions/${s.id}/results/${data.id}/download`, { headers: H })).text();
  assert.ok(JSON.parse(dataText).facts, 'файл фактов должен разбираться как JSON');

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
