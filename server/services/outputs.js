'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const AdmZip = require('adm-zip');
const config = require('../config');
const { db, now } = require('../db');
const { writeDxf } = require('./dxf');

function outputsDir(sessionId) {
  const dir = path.join(config.dataDir, 'outputs', sessionId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function saveResult(sessionId, filename, title, format, content) {
  const dir = outputsDir(sessionId);
  const id = crypto.randomUUID();
  const storedPath = path.join(dir, `${id}_${filename}`);
  fs.writeFileSync(storedPath, content);
  const size = fs.statSync(storedPath).size;
  db.prepare(
    'INSERT INTO results (id, session_id, filename, title, format, size, stored_path, created_at) VALUES (?,?,?,?,?,?,?,?)',
  ).run(id, sessionId, filename, title, format, size, storedPath, now());
  return { id, filename, title, format, size };
}

/** Materialize output files from a validated `completed` model response. */
async function materializeOutputs(sessionId, result) {
  // wipe previous results of this session (re-runs replace outputs)
  const old = db.prepare('SELECT stored_path FROM results WHERE session_id = ?').all(sessionId);
  for (const r of old) { try { fs.unlinkSync(r.stored_path); } catch {} }
  db.prepare('DELETE FROM results WHERE session_id = ?').run(sessionId);

  const created = [];

  const reportBody = result.report_markdown && result.report_markdown.trim()
    ? result.report_markdown
    : `# Отчёт\n\n${result.message}`;
  created.push(saveResult(sessionId, 'ОТЧЁТ.md', 'Итоговый текстовый отчёт', 'md', reportBody));

  const dataJson = {
    generated_at: now(),
    prompt_version: config.promptVersion,
    status: result.status,
    facts: result.facts,
    warnings: result.warnings,
    conflicts: result.conflicts,
    assumptions: result.assumptions,
    tep: result.tep,
  };
  created.push(saveResult(sessionId, 'session-data.json', 'Извлечённые факты, ТЭП и ограничения', 'json', JSON.stringify(dataJson, null, 2)));

  if (result.geometry && result.geometry.length) {
    const dxf = writeDxf(result.geometry);
    created.push(saveResult(sessionId, 'генплан-эскиз.dxf', 'Эскизный чертёж (слои ограничений)', 'dxf', dxf));
  }

  if (created.length > 1) {
    const zipPath = await buildZip(sessionId, created);
    const size = fs.statSync(zipPath).size;
    const id = crypto.randomUUID();
    db.prepare(
      'INSERT INTO results (id, session_id, filename, title, format, size, stored_path, created_at) VALUES (?,?,?,?,?,?,?,?)',
    ).run(id, sessionId, 'результаты.zip', 'Все результаты одним архивом', 'zip', size, zipPath, now());
    created.push({ id, filename: 'результаты.zip', title: 'Все результаты одним архивом', format: 'zip', size });
  }
  return created;
}

async function buildZip(sessionId, items) {
  const dir = outputsDir(sessionId);
  const zipPath = path.join(dir, `${crypto.randomUUID()}_results.zip`);
  const zip = new AdmZip();
  for (const item of items) {
    const row = db.prepare('SELECT stored_path FROM results WHERE id = ?').get(item.id);
    if (row) zip.addFile(item.filename, fs.readFileSync(row.stored_path));
  }
  zip.writeZip(zipPath);
  return zipPath;
}

module.exports = { materializeOutputs, saveResult };
