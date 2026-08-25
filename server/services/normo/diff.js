'use strict';
/**
 * Дифф версий раздела и impact-анализ (сценарий 7 модуля «Нормоконтроль»).
 *
 * Дифф считается по абзацам извлечённого текста (store.extractText). Абзац —
 * непустая строка после трима: extractText отдаёт docx по параграфу на строку,
 * и группировка по пустым строкам склеила бы весь docx в один абзац; пустые
 * строки служат только разделителями и в нумерацию абзацев не входят.
 *
 * Идемпотентность: diffs UNIQUE(section_id, from_version, to_version) —
 * повторный buildDiff отдаёт существующую запись, не пересчитывая; computeImpact
 * не дублирует impact_links (одна ссылка на цель в пределах диффа).
 *
 * Роуты добавляются отдельно (server/routes/normo.js), здесь только сервис.
 */
const db = require('./db');
const store = require('./store');

const SUMMARY_MAX = 160;

/** Обрезка текста для поля summary: итог не длиннее 160 символов. */
function clip(text) {
  return text.length <= SUMMARY_MAX ? text : `${text.slice(0, SUMMARY_MAX - 1)}…`;
}

/** Нормализация: трим каждой строки, пустые строки — разделители абзацев. */
function splitParagraphs(text) {
  return String(text == null ? '' : text)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * Потолок таблицы LCS (~64 МБ Uint32). Правки версий обычно локальны, и после
 * среза общих головы и хвоста середина мала; переписанный целиком гигантский
 * документ сопоставляется позиционно — грубее, но без гигабайтной таблицы.
 */
const LCS_CELLS_MAX = 16_000_000;

/**
 * ЧИСТОЕ сравнение двух текстов по абзацам (LCS, без внешних зависимостей).
 *
 * Возвращает список изменений:
 *   { kind: 'added'|'removed'|'changed',
 *     locus: { para: номер абзаца в новой версии (для removed — в старой), с 1 },
 *     summary: обрезка текста до 160 символов,
 *     oldText?, newText? }
 * Соседние removed+added на одной позиции схлопываются в changed (попарно,
 * остаток пачки остаётся removed/added). Совпадающие тексты дают [].
 */
function diffTexts(oldText, newText) {
  const a = splitParagraphs(oldText);
  const b = splitParagraphs(newText);

  // Общие голова и хвост срезаются заранее: LCS строится только по середине.
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tailA = a.length;
  let tailB = b.length;
  while (tailA > head && tailB > head && a[tailA - 1] === b[tailB - 1]) { tailA--; tailB--; }

  const n = tailA - head;
  const m = tailB - head;

  // ops по середине в прямом порядке: same | removed(ai) | added(bi)
  const ops = [];
  if ((n + 1) * (m + 1) <= LCS_CELLS_MAX) {
    const width = m + 1;
    const L = new Uint32Array((n + 1) * width);
    for (let i = 1; i <= n; i++) {
      for (let j = 1; j <= m; j++) {
        L[i * width + j] = a[head + i - 1] === b[head + j - 1]
          ? L[(i - 1) * width + (j - 1)] + 1
          : Math.max(L[(i - 1) * width + j], L[i * width + (j - 1)]);
      }
    }
    let i = n;
    let j = m;
    while (i > 0 || j > 0) {
      if (i > 0 && j > 0 && a[head + i - 1] === b[head + j - 1]) {
        ops.push({ kind: 'same' }); i--; j--;
      } else if (i > 0 && (j === 0 || L[(i - 1) * width + j] >= L[i * width + (j - 1)])) {
        ops.push({ kind: 'removed', ai: head + i - 1 }); i--;
      } else {
        ops.push({ kind: 'added', bi: head + j - 1 }); j--;
      }
    }
    ops.reverse();
  } else {
    const pairs = Math.min(n, m);
    for (let k = 0; k < pairs; k++) {
      if (a[head + k] === b[head + k]) { ops.push({ kind: 'same' }); continue; }
      ops.push({ kind: 'removed', ai: head + k });
      ops.push({ kind: 'added', bi: head + k });
    }
    for (let k = pairs; k < n; k++) ops.push({ kind: 'removed', ai: head + k });
    for (let k = pairs; k < m; k++) ops.push({ kind: 'added', bi: head + k });
  }

  // Схлопывание: внутри одного разрыва (между same) removed и added идут парами
  // в changed, непарный остаток остаётся removed/added.
  const items = [];
  let removedRun = [];
  let addedRun = [];
  const flush = () => {
    const pairs = Math.min(removedRun.length, addedRun.length);
    for (let k = 0; k < pairs; k++) {
      items.push({
        kind: 'changed',
        locus: { para: addedRun[k].para },
        summary: clip(addedRun[k].text),
        oldText: removedRun[k].text,
        newText: addedRun[k].text,
      });
    }
    for (let k = pairs; k < removedRun.length; k++) {
      items.push({
        kind: 'removed',
        locus: { para: removedRun[k].para },
        summary: clip(removedRun[k].text),
        oldText: removedRun[k].text,
      });
    }
    for (let k = pairs; k < addedRun.length; k++) {
      items.push({
        kind: 'added',
        locus: { para: addedRun[k].para },
        summary: clip(addedRun[k].text),
        newText: addedRun[k].text,
      });
    }
    removedRun = [];
    addedRun = [];
  };
  for (const op of ops) {
    if (op.kind === 'same') flush();
    else if (op.kind === 'removed') removedRun.push({ para: op.ai + 1, text: a[op.ai] });
    else addedRun.push({ para: op.bi + 1, text: b[op.bi] });
  }
  flush();
  return items;
}

/**
 * Дифф двух версий ОДНОГО раздела; результат пишется в таблицу diffs.
 *
 * Файлы сопоставляются по original_name: только в старой версии — 'removed'
 * с locus {file}, только в новой — 'added'; у пары с разным содержимым текст
 * сравнивается diffTexts, изменения получают locus {file, para}. Пара с тем же
 * sha256 не перечитывается вовсе.
 *
 * Повторный вызов (UNIQUE по section_id + from_version + to_version) отдаёт
 * существующую запись. Возвращает строку diffs.
 */
async function buildDiff(fromVersionId, toVersionId) {
  const from = await store.getVersion(fromVersionId);
  const to = await store.getVersion(toVersionId);
  if (!from || !to) {
    const e = new Error('Версия не найдена'); e.status = 404; throw e;
  }
  if (String(from.section_id) !== String(to.section_id)) {
    const e = new Error(
      `Версии из разных разделов (${from.section_code} и ${to.section_code}) — дифф считается внутри одного раздела`);
    e.status = 400; throw e;
  }

  const fromByName = new Map(from.files.map((f) => [f.original_name, f]));
  const toByName = new Map(to.files.map((f) => [f.original_name, f]));

  const items = [];
  for (const name of fromByName.keys()) {
    if (!toByName.has(name)) {
      items.push({ kind: 'removed', locus: { file: name }, summary: clip(`файл исключён из версии: ${name}`) });
    }
  }
  for (const name of toByName.keys()) {
    if (!fromByName.has(name)) {
      items.push({ kind: 'added', locus: { file: name }, summary: clip(`новый файл: ${name}`) });
    }
  }
  for (const [name, oldFile] of fromByName) {
    const newFile = toByName.get(name);
    if (!newFile || newFile.sha256 === oldFile.sha256) continue;
    const textItems = diffTexts(await store.extractText(oldFile), await store.extractText(newFile));
    for (const it of textItems) {
      items.push({ ...it, locus: { file: name, para: it.locus.para } });
    }
    if (!textItems.length) {
      // sha256 разные, а абзацы совпали: бинарный файл без текста или правка
      // форматирования. Молча выдать «изменений нет» нельзя — файл-то другой.
      items.push({
        kind: 'changed',
        locus: { file: name },
        summary: clip(`файл изменён, но текст по абзацам совпадает (бинарные данные или форматирование): ${name}`),
      });
    }
  }

  const inserted = await db.query(
    `INSERT INTO diffs (section_id, from_version, to_version, items)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (section_id, from_version, to_version) DO NOTHING
     RETURNING *`,
    [from.section_id, fromVersionId, toVersionId, JSON.stringify(items)]);
  if (inserted.rows.length) return inserted.rows[0];
  // повтор или гонка: дифф уже посчитан — отдаётся существующая запись
  const existing = await db.query(
    'SELECT * FROM diffs WHERE section_id = $1 AND from_version = $2 AND to_version = $3',
    [from.section_id, fromVersionId, toVersionId]);
  return existing.rows[0];
}

async function linksOf(diffId) {
  const r = await db.query('SELECT * FROM impact_links WHERE diff_id = $1 ORDER BY id', [diffId]);
  return r.rows;
}

/**
 * Impact-анализ диффа: что изменение раздела затрагивает. Идемпотентен —
 * существующая ссылка (diff_id + target_type + target_id) не заводится второй раз.
 *
 * - finding: замечания СТАРОЙ версии (open/fixed), чей location->>'file' затронут
 *   диффом, — needs_recheck: и «открытое», и «устранённое» подтверждались на
 *   прежнем тексте файла.
 * - requirement: требования с покрытием на старой версии, чей файл покрытия
 *   затронут; покрытие без location затронуто консервативно — неизвестно, каким
 *   файлом оно доказано.
 * - section: ДРУГИЕ разделы проекта с открытыми межраздельными замечаниями
 *   (rule_id LIKE 'CS-%') на актуальных версиях — not_propagated: сигнал, что
 *   межраздельная проверка не перепроверялась и изменение могло не дойти до смежных.
 *
 * Возвращает { links: все ссылки диффа, created: сколько добавлено этим вызовом }.
 */
async function computeImpact(diffId) {
  const d = await db.query('SELECT * FROM diffs WHERE id = $1', [diffId]);
  if (!d.rows.length) {
    const e = new Error('Дифф не найден'); e.status = 404; throw e;
  }
  const diff = d.rows[0];
  const items = Array.isArray(diff.items) ? diff.items : [];
  if (!items.length) {
    // версии не различаются — влиять нечему
    return { links: await linksOf(diffId), created: 0 };
  }

  // файл → индекс первого затронувшего его item (для impact_links.item_index)
  const fileItem = new Map();
  items.forEach((it, idx) => {
    const file = it.locus && it.locus.file;
    if (file && !fileItem.has(file)) fileItem.set(file, idx);
  });
  const files = [...fileItem.keys()];

  const have = new Set((await linksOf(diffId)).map((l) => `${l.target_type}|${l.target_id}`));
  let created = 0;
  const add = async (itemIndex, targetType, targetId, status, note) => {
    const key = `${targetType}|${targetId}`;
    if (have.has(key)) return;
    have.add(key);
    await db.query(
      `INSERT INTO impact_links (diff_id, item_index, target_type, target_id, status, note)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [diffId, itemIndex, targetType, targetId, status, note]);
    created++;
  };

  const findings = await db.query(
    `SELECT id, location->>'file' AS file FROM findings
     WHERE version_id = $1 AND status IN ('open','fixed')
       AND location->>'file' = ANY($2::text[])
     ORDER BY id`,
    [diff.from_version, files]);
  for (const f of findings.rows) {
    await add(fileItem.get(f.file), 'finding', f.id, 'needs_recheck',
      `замечание опиралось на файл «${f.file}», изменённый в новой версии`);
  }

  const coverage = await db.query(
    `SELECT requirement_id, location->>'file' AS file FROM requirement_coverage
     WHERE version_id = $1
       AND (location IS NULL OR location->>'file' IS NULL OR location->>'file' = ANY($2::text[]))
     ORDER BY requirement_id`,
    [diff.from_version, files]);
  for (const rc of coverage.rows) {
    const idx = rc.file != null && fileItem.has(rc.file) ? fileItem.get(rc.file) : 0;
    await add(idx, 'requirement', rc.requirement_id, 'needs_recheck',
      rc.file
        ? `покрытие подтверждалось файлом «${rc.file}», изменённым в новой версии`
        : 'у покрытия нет location — считается затронутым консервативно');
  }

  const sec = await db.query('SELECT * FROM sections WHERE id = $1', [diff.section_id]);
  const section = sec.rows[0];
  const cross = await db.query(
    `SELECT DISTINCT s.id, s.code FROM sections s
     JOIN section_versions v ON v.section_id = s.id AND v.is_current
     JOIN findings f ON f.version_id = v.id
     WHERE s.project_id = $1 AND s.id <> $2
       AND f.status = 'open' AND f.rule_id LIKE 'CS-%'
     ORDER BY s.code`,
    [section.project_id, section.id]);
  for (const s of cross.rows) {
    await add(0, 'section', s.id, 'not_propagated',
      `межраздельная проверка не перепроверялась после изменения раздела ${section.code}`);
  }

  return { links: await linksOf(diffId), created };
}

/** Дифф вместе со ссылками impact-анализа; null, если диффа нет. */
async function getDiff(diffId) {
  const d = await db.query('SELECT * FROM diffs WHERE id = $1', [diffId]);
  if (!d.rows.length) return null;
  return { ...d.rows[0], links: await linksOf(diffId) };
}

module.exports = { diffTexts, buildDiff, computeImpact, getDiff };
