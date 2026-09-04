'use strict';
/**
 * Хранилище модуля «Нормоконтроль»: файлы, проекты, состав разделов, версии.
 *
 * Файлы лежат в NORMO_DATA_DIR/files/<sha[:2]>/<sha> и дедуплицируются по sha256;
 * извлечённый текст кэшируется в NORMO_DATA_DIR/text/<sha>.txt — детерминированные
 * проверки и LLM читают одно и то же, а повторный анализ не парсит документ заново.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');
const AdmZip = require('adm-zip');
const yaml = require('js-yaml');
const config = require('../../config');
const zipGuard = require('../zip-guard');
const db = require('./db');

const execFileP = promisify(execFile);

function dataDir(...parts) {
  const dir = path.join(config.normoDataDir, ...parts);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/* ---------------- файлы ---------------- */

async function saveFile(buffer, originalName, mime, uploadedBy) {
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  const existing = await db.query('SELECT * FROM files WHERE sha256 = $1', [sha256]);
  if (existing.rows.length) return existing.rows[0];
  const rel = path.join('files', sha256.slice(0, 2), sha256);
  const abs = path.join(dataDir('files', sha256.slice(0, 2)), sha256);
  fs.writeFileSync(abs, buffer);
  const r = await db.query(
    `INSERT INTO files (sha256, path, size_bytes, mime, original_name, uploaded_by)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [sha256, rel, buffer.length, mime || null, originalName, uploadedBy || null],
  );
  return r.rows[0];
}

function filePath(fileRow) {
  return path.join(config.normoDataDir, fileRow.path);
}

function decodeXml(s) {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}

/**
 * Текст docx-части по параграфам — ТОЛЬКО из ранов <w:t>. Снимать все теги подряд
 * нельзя: координаты текстбоксов (<wp:posOffset>) — это текстовые узлы, они
 * приклеиваются к соседним словам и ломают границы обозначений в штампах.
 */
function xmlParagraphs(xml) {
  const out = [];
  for (const chunk of xml.split('</w:p>')) {
    const text = [...chunk.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((m) => decodeXml(m[1])).join('');
    if (text.trim()) out.push(text);
  }
  return out;
}

function docxText(absPath) {
  const zip = new AdmZip(absPath);
  const parts = [];
  for (const entry of zip.getEntries()) {
    if (/^word\/(document|header\d+|footer\d+)\.xml$/.test(entry.entryName)) {
      // размер записи проверяется ДО распаковки: zip-бомба — 422, а не гигабайтная строка
      const xml = zipGuard.entryData(entry, 'DOCX').toString('utf8');
      parts.push(`===== ${entry.entryName} =====\n${xmlParagraphs(xml).join('\n')}`);
    }
  }
  return parts.join('\n');
}

/**
 * Данные штампов docx: пользовательские свойства документа (СПДС-шаблоны собирают
 * обозначение полями DOCPROPERTY из «Код проекта» + «Раздел») и текст колонтитулов
 * с сохранением границ параграфов (обозначение может быть разбито по ранам).
 */
function docxStampData(absPath) {
  const zip = new AdmZip(absPath);
  const properties = {};
  const custom = zip.getEntry('docProps/custom.xml');
  if (custom) {
    const xml = zipGuard.entryData(custom, 'DOCX').toString('utf8');
    for (const m of xml.matchAll(/<property[^>]*name="([^"]+)"[^>]*>\s*<vt:lpwstr>([^<]*)<\/vt:lpwstr>/g)) {
      properties[m[1]] = m[2];
    }
  }
  const stampParagraphs = [];
  for (const entry of zip.getEntries()) {
    if (!/^word\/(header|footer)\d+\.xml$/.test(entry.entryName)) continue;
    const xml = zipGuard.entryData(entry, 'DOCX').toString('utf8');
    // текст по параграфам только из ранов <w:t>: «SEC-AVI-2023» + «-» + «АР»
    // из трёх ранов собирается обратно, а координаты текстбоксов не подмешиваются
    for (const text of xmlParagraphs(xml)) {
      stampParagraphs.push({ part: entry.entryName.replace('word/', ''), text: text.trim() });
    }
  }
  return { properties, stampParagraphs };
}

/**
 * Текст файла для проверок. Пустая строка — честный результат «текста нет»
 * (например, растровый PDF): проверка текстового слоя на этом и строится.
 */
const TEXT_VERSION = 2; // менять при изменении логики извлечения: кэш обязан пересобраться

async function extractText(fileRow) {
  const cachePath = path.join(dataDir('text'), `${fileRow.sha256}.v${TEXT_VERSION}.txt`);
  if (fs.existsSync(cachePath)) return fs.readFileSync(cachePath, 'utf8');
  const abs = filePath(fileRow);
  const ext = path.extname(fileRow.original_name).toLowerCase();
  let text = '';
  try {
    if (ext === '.pdf') {
      const { stdout } = await execFileP('pdftotext', ['-layout', '-enc', 'UTF-8', abs, '-'],
        { maxBuffer: 64 * 1024 * 1024 });
      text = stdout;
    } else if (ext === '.docx') {
      text = docxText(abs);
    } else if (['.xml', '.txt', '.md', '.gge'].includes(ext)) {
      text = fs.readFileSync(abs, 'utf8');
    }
    // .dwg и прочие бинарные: текст не извлекается, это фиксируется журналом проверки
  } catch (err) {
    text = '';
    console.warn(`[normo/store] текст не извлечён из ${fileRow.original_name}: ${err.message}`);
  }
  fs.writeFileSync(cachePath, text);
  return text;
}

/* ---------------- проекты и состав ---------------- */

let sectionDefaultsCache = null;
function sectionDefaults() {
  if (!sectionDefaultsCache) {
    const doc = yaml.load(fs.readFileSync(
      path.join(config.normoKbDir, 'knowledge', 'sections.yaml'), 'utf8'));
    sectionDefaultsCache = (doc.pd_ciphers_gost.ciphers || [])
      .filter((c) => c.stage === 'ПД')
      .map((c, i) => ({ code: c.cipher, name: c.name, required: true, required_basis: c.source, sort_order: i }));
  }
  return sectionDefaultsCache;
}

async function createProject({ name, customer, stage, objectKind, dateStarted, localOnly, owner, platformProjectId }) {
  return db.tx(async (client) => {
    const p = await client.query(
      `INSERT INTO projects (name, customer, stage, object_kind, date_started, local_only, owner_user, platform_project_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [name, customer || null, stage, objectKind || 'непроизводственный', dateStarted, !!localOnly, owner || null,
        platformProjectId || 'legacy'],
    );
    const project = p.rows[0];
    for (const s of sectionDefaults()) {
      await client.query(
        `INSERT INTO sections (project_id, code, name, required, required_basis, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [project.id, s.code, s.name, s.required, s.required_basis, s.sort_order],
      );
    }
    return project;
  });
}

/** platformProjectId — только проекты этого проекта платформы; пусто — все. */
async function listProjects({ platformProjectId = '' } = {}) {
  const r = await db.query(
    `SELECT p.*,
       (SELECT count(*) FROM sections s WHERE s.project_id = p.id) AS sections_count,
       (SELECT count(*) FROM findings f
          JOIN section_versions v ON v.id = f.version_id AND v.is_current
          JOIN sections s ON s.id = v.section_id
        WHERE s.project_id = p.id AND f.status = 'open') AS open_findings
     FROM projects p WHERE archived_at IS NULL AND ($1 = '' OR p.platform_project_id = $1)
     ORDER BY p.id DESC`, [platformProjectId || '']);
  return r.rows;
}

/**
 * Сводка для проектов платформы: сколько проектов нормоконтроля, разделов и
 * открытых замечаний; at — последняя загрузка версии или заведение комплекта.
 */
async function summaryByPlatform(ids) {
  if (!ids.length) return {};
  // сводку зовут с маршрута проектов — схема модуля к этому моменту могла ещё не развернуться
  await db.migrate();
  const r = await db.query(
    `SELECT p.platform_project_id AS pid, count(*)::int AS projects,
       coalesce(sum((SELECT count(*) FROM sections s WHERE s.project_id = p.id)), 0)::int AS sections,
       coalesce(sum((SELECT count(*) FROM section_versions v JOIN sections s ON s.id = v.section_id
          WHERE s.project_id = p.id)), 0)::int AS versions,
       coalesce(sum((SELECT count(*) FROM findings f
          JOIN section_versions v ON v.id = f.version_id AND v.is_current
          JOIN sections s ON s.id = v.section_id
        WHERE s.project_id = p.id AND f.status = 'open')), 0)::int AS open_findings,
       max(greatest(p.created_at, (SELECT max(v.uploaded_at) FROM section_versions v
          JOIN sections s ON s.id = v.section_id WHERE s.project_id = p.id))) AS at
     FROM projects p WHERE p.archived_at IS NULL AND p.platform_project_id = ANY($1)
     GROUP BY p.platform_project_id`, [ids]);
  const out = {};
  for (const row of r.rows) out[row.pid] = row;
  return out;
}

/**
 * Проект платформы и автор комплекта, которым принадлежит объект нормоконтроля —
 * по числовому id любого уровня. Нужен гейту «свои проекты»: версии, прогоны,
 * отчёты, замечания и сдвиги нумеруются подряд и раньше открывались перебором.
 * accessOf → undefined — объекта нет; { pid, owner, archived }: pid null — комплект без
 * проекта (до проектов), owner — owner_user комплекта (правит его в «Ранних работах»),
 * archived — комплект в архиве (мягко удалён).
 */
const OWNER_SQL = {
  project: 'SELECT p.platform_project_id AS pid, p.owner_user AS owner, p.archived_at AS archived FROM projects p WHERE p.id = $1',
  section: 'SELECT p.platform_project_id AS pid, p.owner_user AS owner, p.archived_at AS archived FROM sections s JOIN projects p ON p.id = s.project_id WHERE s.id = $1',
  version: `SELECT p.platform_project_id AS pid, p.owner_user AS owner, p.archived_at AS archived FROM section_versions v
            JOIN sections s ON s.id = v.section_id JOIN projects p ON p.id = s.project_id WHERE v.id = $1`,
  run: 'SELECT p.platform_project_id AS pid, p.owner_user AS owner, p.archived_at AS archived FROM analysis_runs r JOIN projects p ON p.id = r.project_id WHERE r.id = $1',
  finding: `SELECT p.platform_project_id AS pid, p.owner_user AS owner, p.archived_at AS archived FROM findings f
            JOIN analysis_runs r ON r.id = f.run_id JOIN projects p ON p.id = r.project_id WHERE f.id = $1`,
  report: 'SELECT p.platform_project_id AS pid, p.owner_user AS owner, p.archived_at AS archived FROM reports rp JOIN projects p ON p.id = rp.project_id WHERE rp.id = $1',
  diff: `SELECT p.platform_project_id AS pid, p.owner_user AS owner, p.archived_at AS archived FROM diffs d
         JOIN sections s ON s.id = d.section_id JOIN projects p ON p.id = s.project_id WHERE d.id = $1`,
  impact: `SELECT p.platform_project_id AS pid, p.owner_user AS owner, p.archived_at AS archived FROM impact_links il JOIN diffs d ON d.id = il.diff_id
           JOIN sections s ON s.id = d.section_id JOIN projects p ON p.id = s.project_id WHERE il.id = $1`,
};
async function accessOf(kind, id) {
  const sql = OWNER_SQL[kind];
  if (!sql) throw new Error(`accessOf: неизвестный вид ${kind}`);
  const r = await db.query(sql, [id]);
  if (!r.rows.length) return undefined;
  // archived — комплект мягко удалён (archived_at): гейт правки отвечает 404
  return { pid: r.rows[0].pid || null, owner: r.rows[0].owner || '', archived: !!r.rows[0].archived };
}
async function platformProjectOf(kind, id) {
  const a = await accessOf(kind, id);
  return a === undefined ? undefined : a.pid;
}

/** Есть ли проекты, доставшиеся «Ранним работам»: тогда этот проект должен существовать на платформе. */
async function hasLegacy() {
  await db.migrate();
  const r = await db.query("SELECT 1 FROM projects WHERE platform_project_id = 'legacy' AND archived_at IS NULL LIMIT 1");
  return r.rows.length > 0;
}

/** Мягкое удаление комплекта: archived_at; версии и замечания остаются читаемыми по прямой ссылке.
 *  Возвращает false, если комплекта нет или он уже в архиве. */
async function archiveProject(id) {
  const r = await db.query('UPDATE projects SET archived_at = now() WHERE id = $1 AND archived_at IS NULL RETURNING id', [id]);
  return r.rows.length > 0;
}

async function getProject(id) {
  const p = await db.query('SELECT * FROM projects WHERE id = $1', [id]);
  if (!p.rows.length) return null;
  const sections = await db.query(
    `SELECT s.*,
       v.id AS current_version_id, v.version_no AS current_version_no, v.uploaded_at AS current_uploaded_at,
       (SELECT count(*) FROM findings f WHERE f.version_id = v.id AND f.status = 'open') AS open_findings
     FROM sections s
     LEFT JOIN section_versions v ON v.section_id = s.id AND v.is_current
     WHERE s.project_id = $1 ORDER BY s.sort_order, s.code`, [id]);
  return { ...p.rows[0], sections: sections.rows };
}

async function setSections(projectId, list) {
  return db.tx(async (client) => {
    const project = await client.query('SELECT 1 FROM projects WHERE id = $1', [projectId]);
    if (!project.rows.length) {
      const err = new Error('Проект не найден'); err.status = 404; throw err;
    }
    const have = await client.query(
      `SELECT s.code, EXISTS (SELECT 1 FROM section_versions v WHERE v.section_id = s.id) AS has_versions
       FROM sections s WHERE s.project_id = $1 ORDER BY s.sort_order, s.code`, [projectId]);
    const keep = new Set(list.map((s) => s.code));
    // Раздел с загруженными версиями из состава не выкидывается: каскад унёс бы
    // версии, замечания и заключения. Сначала человеку показывается, что мешает.
    const blocked = have.rows.filter((row) => !keep.has(row.code) && row.has_versions).map((row) => row.code);
    if (blocked.length) {
      const err = new Error(`Нельзя убрать разделы с загруженными версиями: ${blocked.join(', ')}`);
      err.status = 409; throw err;
    }
    for (const row of have.rows) {
      if (!keep.has(row.code)) {
        await client.query('DELETE FROM sections WHERE project_id = $1 AND code = $2', [projectId, row.code]);
      }
    }
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      // required_basis без поля в запросе у существующего раздела не трогается:
      // клиент шлёт состав без оснований, и они обнулялись при каждом сохранении
      const basisGiven = s.required_basis !== undefined;
      await client.query(
        `INSERT INTO sections (project_id, code, name, required, required_basis, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (project_id, code) DO UPDATE
           SET name = EXCLUDED.name, required = EXCLUDED.required,
               required_basis = CASE WHEN $7 THEN EXCLUDED.required_basis ELSE sections.required_basis END,
               sort_order = EXCLUDED.sort_order`,
        [projectId, s.code, s.name, s.required !== false, s.required_basis || null, i, basisGiven],
      );
    }
    const r = await client.query(
      'SELECT * FROM sections WHERE project_id = $1 ORDER BY sort_order', [projectId]);
    return r.rows;
  });
}

/* ---------------- версии разделов ---------------- */

async function addVersion(projectId, code, uploads, { stage, author, uploadedBy, note }) {
  const sec = await db.query(
    'SELECT * FROM sections WHERE project_id = $1 AND code = $2', [projectId, code]);
  if (!sec.rows.length) {
    const err = new Error(`Раздела «${code}» нет в составе проекта`); err.status = 404; throw err;
  }
  const section = sec.rows[0];

  const fileRows = [];
  for (const up of uploads) {
    fileRows.push(await saveFile(up.buffer, up.originalname, up.mimetype, uploadedBy));
  }
  // Хэш содержимого версии — по отсортированным хэшам файлов: тот же комплект
  // файлов при повторной загрузке даёт тот же content_hash (ключ идемпотентности).
  const contentHash = crypto.createHash('sha256')
    .update(fileRows.map((f) => f.sha256).sort().join('|'))
    .digest('hex');

  return db.tx(async (client) => {
    // Строка раздела блокируется на время транзакции: две параллельные загрузки
    // в один раздел иначе читали одинаковый max(version_no) и вторая падала на
    // UNIQUE (section_id, version_no) 500-кой (третий круг 04.09.2026)
    await client.query('SELECT id FROM sections WHERE id = $1 FOR UPDATE', [section.id]);
    const prev = await client.query(
      'SELECT coalesce(max(version_no), 0) AS n FROM section_versions WHERE section_id = $1',
      [section.id]);
    await client.query(
      'UPDATE section_versions SET is_current = FALSE WHERE section_id = $1 AND is_current',
      [section.id]);
    const v = await client.query(
      `INSERT INTO section_versions (section_id, version_no, stage, author, uploaded_by, content_hash, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [section.id, prev.rows[0].n + 1, stage, author || null, uploadedBy || null, contentHash, note || null],
    );
    for (const f of fileRows) {
      await client.query(
        'INSERT INTO section_version_files (version_id, file_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
        [v.rows[0].id, f.id]);
    }
    return { version: v.rows[0], files: fileRows, section };
  });
}

async function getVersion(versionId) {
  const v = await db.query(
    `SELECT v.*, s.code AS section_code, s.name AS section_name, s.project_id
     FROM section_versions v JOIN sections s ON s.id = v.section_id
     WHERE v.id = $1`, [versionId]);
  if (!v.rows.length) return null;
  const files = await db.query(
    `SELECT f.* FROM section_version_files vf JOIN files f ON f.id = vf.file_id
     WHERE vf.version_id = $1 ORDER BY f.original_name`, [versionId]);
  return { ...v.rows[0], files: files.rows };
}

async function listVersions(sectionId) {
  const r = await db.query(
    `SELECT v.*,
       (SELECT count(*) FROM findings f WHERE f.version_id = v.id AND f.status = 'open') AS open_findings
     FROM section_versions v WHERE v.section_id = $1 ORDER BY v.version_no DESC`, [sectionId]);
  return r.rows;
}

module.exports = {
  dataDir, saveFile, filePath, extractText, docxStampData, sectionDefaults,
  createProject, listProjects, getProject, archiveProject, setSections, summaryByPlatform, hasLegacy, platformProjectOf, accessOf,
  addVersion, getVersion, listVersions,
};
