'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const AdmZip = require('adm-zip');
const config = require('../config');
const { db, now } = require('../db');

function outputsDir(sessionId) {
  const dir = path.join(config.dataDir, 'outputs', sessionId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Папка постоянного архива для текущего прогона: <ARCHIVE_DIR>/<дата_время>_<сессия8>.
 * Файлы одного прогона попадают в одну папку (метка с точностью до минуты).
 */
function archiveRunDir(sessionId) {
  const stamp = new Date(Date.now() - new Date().getTimezoneOffset() * 60000)
    .toISOString().slice(0, 16).replace('T', '_').replace(':', '-'); // 2026-08-06_15-42 (локальное время)
  const dir = path.join(config.archiveDir, `${stamp}_${sessionId.slice(0, 8)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Справка о прогоне — пишется один раз на папку архива. */
function writeRunInfo(dir, sessionId) {
  const infoPath = path.join(dir, '_о-прогоне.txt');
  if (fs.existsSync(infoPath)) return;
  let aiLine = '';
  try {
    const adapter = require('./claude/adapter');
    const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
    const route = adapter.effectiveProvider(session);
    aiLine = `Нейросеть: ${route.provider} · ${adapter.resolveModel(route)}\n`;
  } catch { /* справка не критична */ }
  const files = db.prepare('SELECT original_name, size FROM files WHERE session_id = ? ORDER BY created_at').all(sessionId);
  fs.writeFileSync(infoPath,
    `Сессия: ${sessionId}\nДата: ${now()}\n${aiLine}` +
    (files.length ? `Исходные данные:\n${files.map((f) => `  - ${f.original_name} (${Math.round(f.size / 1024)} КБ)`).join('\n')}\n` : ''));
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
  // постоянный архив всех прогонов: копия файла + справка (ошибка архива не роняет анализ)
  try {
    const adir = archiveRunDir(sessionId);
    fs.copyFileSync(storedPath, path.join(adir, filename));
    writeRunInfo(adir, sessionId);
  } catch (err) { console.warn('[archive]', err.message); }
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

  // Чертежа здесь больше нет. Поле geometry[] модели — это ИЗВЛЕЧЁННЫЕ данные
  // с provenance, а не рисунок: файл, собранный из него, открывался пустым.
  // Настоящий генплан со штриховками зон и пятном застройки собирается из
  // геометрической модели участка на этапе выгрузки (services/cad/drawing.js).
  const extracted = (result.geometry || []).filter((g) => g && g.points && g.points.length >= 2);
  if (extracted.length) {
    created.push(saveResult(sessionId, 'извлечённые-контуры.json',
      'Контуры, найденные моделью в документах (с указанием источника)', 'json',
      JSON.stringify({ generated_at: now(), note: 'Не чертёж: это то, что модель нашла в документах. ' +
        'Инженерная геометрия строится движком ограничений.', contours: extracted }, null, 2)));
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
