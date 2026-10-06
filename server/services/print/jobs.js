'use strict';
/**
 * «Разбор PDF по форматам» — хранилище разборов и конвейер.
 *
 * Разбор (job) — папка data/print/<человек>/<id>/: job.json (состояние),
 * src/ (загруженные PDF, собираются из кусков — через Cloudflare тело запроса
 * больше 100 МБ не проходит, а один файл РД весит 268 МБ), packages/ (PDF на
 * корзину или на корзину тома — их оператор открывает во вкладке, печатает или
 * скачивает), records.json и report.csv (строка на каждый лист), в режиме «по
 * томам» — карта сборки (карта_сборки.csv / .html).
 *
 * У человека живёт ОДИН разбор: новый стирает предыдущий (решение владельца
 * 14.09.2026), всё старше PRINT_TTL_HOURS чистит sweep(). Пакеты и отчёты
 * отдаются во вкладку и на скачивание по короткоживущему билету (ticket):
 * вкладка открывается адресом, заголовок X-User-Token в неё не передать.
 *
 * Конвейер детерминированный: pdfinfo → классификация → qpdf. Сбой на одном
 * файле не прерывает разбор — он уходит в problems. Деление пакета по пределу
 * (А4): размер куска заранее не известен (ресурсы у страниц общие), поэтому
 * кандидат собирается qpdf и меряется, двоичным поиском по числу страниц;
 * целый пакет, который пришлось делить, не сохраняется — место не удваивается.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../../config');
const formats = require('./formats');
const poppler = require('./pdfinfo');
const volumes = require('./volumes');
const { sanitizeFilename } = require('../validation');

const ID_RE = /^[a-f0-9]{24}$/;
const FILE_ID_RE = /^f[a-f0-9]{8}$/;
const live = new Map();      // id → job в работе (в памяти, чтобы отдавать прогресс без чтения диска)
const tickets = new Map();   // ticket → { jobId, userId, exp }

const REPORT_FILES = Object.freeze({
  '_ОТЧЁТ.csv': { kind: 'csv' },
  '_ОТЧЁТ.json': { kind: 'json' },
  'карта_сборки.csv': { kind: 'mapcsv' },
  'карта_сборки.html': { kind: 'maphtml' },
});

const now = () => new Date().toISOString();
const rootDir = () => path.join(config.dataDir, 'print');
const userKey = (user) => String(user.id).replace(/[^\w.-]/g, '_');
const userDir = (user) => path.join(rootDir(), userKey(user));
const jobDir = (job) => path.join(rootDir(), job.userKey, job.id);

function save(job) {
  job.updatedAt = now();
  const dir = jobDir(job);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `job.json.${process.pid}.tmp`);
  const { promise: _p, ...plain } = job;
  fs.writeFileSync(tmp, JSON.stringify(plain, null, 2));
  fs.renameSync(tmp, path.join(dir, 'job.json'));
  return job;
}

function readJob(dir) {
  try {
    const job = JSON.parse(fs.readFileSync(path.join(dir, 'job.json'), 'utf8'));
    return job && ID_RE.test(String(job.id)) ? job : null;
  } catch { return null; }
}

/** Что уходит наружу: без служебных полей и без внутренних путей. */
function publicView(job) {
  const { userKey: _k, cancelRequested: _c, promise: _p, ...rest } = job;
  return {
    ...rest,
    files: (job.files || []).map((f) => ({
      id: f.id, name: f.name, size: f.size, chunks: f.chunks, chunkSize: f.chunkSize,
      received: (f.received || []).filter(Boolean).length, complete: !!f.complete, pages: f.pages || 0, problem: f.problem || '',
    })),
  };
}

/* ---------------- разборы ---------------- */

function listJobs(user) {
  const dir = userDir(user);
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    if (!ID_RE.test(name)) continue;
    const job = live.get(name) || readJob(path.join(dir, name));
    if (job && job.userId === String(user.id)) out.push(job);
  }
  return out.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

function currentJob(user) {
  return listJobs(user)[0] || null;
}

function getJob(user, id) {
  if (!ID_RE.test(String(id))) return null;
  const job = live.get(id) || readJob(path.join(userDir(user), String(id)));
  return job && job.userId === String(user.id) ? job : null;
}

function deleteJob(job) {
  if (live.has(job.id)) live.get(job.id).cancelRequested = true;
  live.delete(job.id);
  for (const [t, v] of tickets) if (v.jobId === job.id) tickets.delete(t);
  fs.rmSync(jobDir(job), { recursive: true, force: true });
}

/** Новый разбор человека; прежние его разборы удаляются (один разбор на человека). */
function createJob(user) {
  for (const old of listJobs(user)) deleteJob(old);
  const job = {
    id: crypto.randomBytes(12).toString('hex'),
    userId: String(user.id),
    userKey: userKey(user),
    userName: [user.lastName, user.firstName].filter(Boolean).join(' ') || String(user.name || ''),
    createdAt: now(), updatedAt: now(),
    status: 'new',
    settings: formats.defaults(),
    files: [],
    progress: { phase: '', done: 0, total: 0, label: '' },
    problems: [],
    packages: [],
    tomes: [],
    summary: null,
    binding: null,
    schedule: null,
    error: '',
  };
  fs.mkdirSync(path.join(jobDir(job), 'src'), { recursive: true });
  return save(job);
}

/* ---------------- файлы кусками ---------------- */

const editable = (job) => ['new', 'done', 'error', 'cancelled', 'interrupted'].includes(job.status);

function addFile(job, { name, size }) {
  if (!editable(job)) throw httpError(409, 'Разбор идёт — дождитесь окончания или остановите его');
  const clean = sanitizeFilename(Buffer.from(String(name || ''), 'utf8').toString('utf8'));
  if (!/\.pdf$/i.test(clean)) throw httpError(400, `«${clean}»: принимаются только PDF`);
  const bytes = Number(size);
  if (!Number.isInteger(bytes) || bytes <= 0) throw httpError(400, `«${clean}»: размер файла должен быть целым числом байт`);
  if (bytes > config.printMaxFileBytes) {
    throw httpError(413, `«${clean}»: ${mb(bytes)} МБ при пределе ${mb(config.printMaxFileBytes)} МБ на файл`);
  }
  const total = job.files.reduce((s, f) => s + f.size, 0) + bytes;
  if (total > config.printMaxTotalBytes) {
    throw httpError(413, `Комплект ${mb(total)} МБ превышает предел ${mb(config.printMaxTotalBytes)} МБ на разбор`);
  }
  if (job.files.length >= config.printMaxFiles) throw httpError(413, `Не больше ${config.printMaxFiles} файлов в разборе`);
  // исходник + пакеты ≈ 2× размера файла; на VPS 40 ГБ, но запас всё равно проверяется
  const free = freeBytes(rootDir());
  if (free !== null && free - bytes * 2 < config.printMinFreeBytes) {
    throw httpError(507, `На сервере мало места: свободно ${mb(free)} МБ, для «${clean}» нужно около ${mb(bytes * 2 + config.printMinFreeBytes)} МБ — удалите старый разбор или подождите уборки`);
  }
  if (job.files.some((f) => f.name === clean)) throw httpError(409, `«${clean}» уже есть в разборе`);
  const chunkSize = config.printChunkBytes;
  const chunks = Math.ceil(bytes / chunkSize);
  const file = {
    id: `f${crypto.randomBytes(4).toString('hex')}`,
    name: clean, size: bytes, chunkSize, chunks,
    received: new Array(chunks).fill(false), complete: false, pages: 0, problem: '',
  };
  fs.writeFileSync(srcPath(job, file), Buffer.alloc(0));
  job.files.push(file);
  resetResult(job);
  save(job);
  return file;
}

function srcPath(job, file) { return path.join(jobDir(job), 'src', `${file.id}.pdf`); }

function findFile(job, fileId) {
  if (!FILE_ID_RE.test(String(fileId))) return null;
  return job.files.find((f) => f.id === fileId) || null;
}

/** Кусок n пишется по смещению n·chunkSize: повтор и перестановка кусков безвредны. */
function writeChunk(job, fileId, n, buf) {
  if (!editable(job)) throw httpError(409, 'Разбор идёт — дождитесь окончания или остановите его');
  const file = findFile(job, fileId);
  if (!file) throw httpError(404, 'Файл не найден в разборе');
  const idx = Number(n);
  if (!Number.isInteger(idx) || idx < 0 || idx >= file.chunks) throw httpError(400, `Кусок ${n} вне диапазона 0…${file.chunks - 1}`);
  const expected = idx < file.chunks - 1 ? file.chunkSize : file.size - idx * file.chunkSize;
  if (!Buffer.isBuffer(buf) || buf.length !== expected) {
    throw httpError(400, `Кусок ${idx} файла «${file.name}»: ожидалось ${expected} байт, получено ${buf ? buf.length : 0}`);
  }
  const fd = fs.openSync(srcPath(job, file), 'r+');
  try { fs.writeSync(fd, buf, 0, buf.length, idx * file.chunkSize); } finally { fs.closeSync(fd); }
  file.received[idx] = true;
  file.complete = file.received.every(Boolean) && fs.statSync(srcPath(job, file)).size === file.size;
  resetResult(job);
  save(job);
  return file;
}

function removeFile(job, fileId) {
  if (!editable(job)) throw httpError(409, 'Разбор идёт — дождитесь окончания или остановите его');
  const file = findFile(job, fileId);
  if (!file) throw httpError(404, 'Файл не найден в разборе');
  fs.rmSync(srcPath(job, file), { force: true });
  job.files = job.files.filter((f) => f.id !== fileId);
  resetResult(job);
  save(job);
}

/** Состав файлов изменился — прежний результат больше не про этот комплект. */
function resetResult(job) {
  if (job.status === 'new') return;
  job.status = 'new';
  job.summary = null;
  job.packages = [];
  job.tomes = [];
  job.binding = null;
  job.schedule = null;
  job.problems = [];
  job.error = '';
  job.progress = { phase: '', done: 0, total: 0, label: '' };
  fs.rmSync(path.join(jobDir(job), 'packages'), { recursive: true, force: true });
  fs.rmSync(path.join(jobDir(job), 'pages'), { recursive: true, force: true });
  for (const name of ['records.json', 'report.csv', 'карта_сборки.csv', 'карта_сборки.html']) fs.rmSync(path.join(jobDir(job), name), { force: true });
  for (const [t, v] of tickets) if (v.jobId === job.id) tickets.delete(t);
}

/* ---------------- конвейер ---------------- */

/** Запуск: настройки проверены, все файлы дособраны; сама работа идёт в фоне. */
function start(job, rawSettings) {
  if (!editable(job)) throw httpError(409, 'Разбор уже идёт');
  if (!job.files.length) throw httpError(400, 'Добавьте хотя бы один PDF');
  const pending = job.files.filter((f) => !f.complete);
  if (pending.length) throw httpError(409, `Не дозагружены: ${pending.map((f) => f.name).join(', ')}`);
  let settings;
  try { settings = formats.normalizeSettings(rawSettings); } catch (err) { throw httpError(400, err.message); }
  resetResult(job);
  job.settings = settings;
  job.status = 'running';
  job.cancelRequested = false;
  job.startedAt = now();
  job.finishedAt = '';
  job.progress = { phase: 'analyze', done: 0, total: job.files.length, label: '' };
  live.set(job.id, job);
  save(job);
  job.promise = runPipeline(job).catch((err) => {
    if (err instanceof Cancelled) {
      // остановка — не ошибка: исходники остаются, пакеты не собираются
      job.status = 'cancelled';
      job.error = '';
      job.packages = [];
      job.summary = null;
      fs.rmSync(path.join(jobDir(job), 'packages'), { recursive: true, force: true });
    } else {
      job.status = 'error';
      job.error = err.message || String(err);
    }
  }).finally(() => {
    job.finishedAt = now();
    fs.rmSync(path.join(jobDir(job), 'pages'), { recursive: true, force: true });
    live.delete(job.id);
    delete job.promise;
    save(job);
  });
  return job;
}

function cancel(job) {
  if (job.status !== 'running') return job;
  job.cancelRequested = true;
  return job;
}

class Cancelled extends Error {}
const checkCancel = (job) => { if (job.cancelRequested) throw new Cancelled('остановлено'); };

/** Ключ носителя внутри корзины: «НС А3» бывает и листом А3, и рулоном 297 — это разные устройства. */
const carrierKey = (r) => `${r.carrierKind || ''}:${r.carrierBucket || ''}:${r.rollWidth || 0}`;

async function runPipeline(job) {
  const dir = jobDir(job);
  const st = job.settings;
  const files = job.files.slice().sort((a, b) => a.name.localeCompare(b.name, 'ru', { numeric: true }));
  const records = [];
  const problems = [];
  job.problems = problems;
  const byTome = st.grouping === 'tomes';

  // 1. Анализ: pdfinfo → габариты → класс и корзина
  job.progress = { phase: 'analyze', done: 0, total: files.length, label: '' };
  for (const [i, file] of files.entries()) {
    checkCancel(job);
    job.progress.label = file.name;
    save(job);
    let info;
    try {
      info = await poppler.inspect(srcPath(job, file));
    } catch (err) {
      file.problem = `${err.message} — пропущен`;
      problems.push(`${file.name}: ${file.problem}`);
      job.progress.done = i + 1;
      continue;
    }
    file.pages = info.total;
    file.problem = '';
    if (info.damaged) {
      problems.push(`предупреждение: ${file.name} повреждён — poppler восстановил ${info.total} стр., число может отличаться от исходного; проверьте пакет глазами`);
    }
    const stem = file.name.replace(/\.pdf$/i, '');
    for (const p of info.pages) {
      let size;
      try {
        size = formats.pageSizeMm(p.boxes, p.rotate, st.box);
      } catch (err) {
        problems.push(`${file.name} стр.${p.index}: ${err.message}`);
        continue;
      }
      const short = Math.min(size.width, size.height);
      const long = Math.max(size.width, size.height);
      const c = formats.classify(short, long, st);
      records.push({
        fileId: file.id, source: file.name, page: p.index,
        width: size.width, height: size.height, short, long, rotate: size.rotate, box: size.box,
        kind: c.kind, format: c.format, bucket: c.bucket, carrier: c.carrier, rollWidth: c.rollWidth, cut: c.cut,
        carrierKind: c.carrierKind, carrierBucket: c.carrierBucket, carrierWidth: c.carrierWidth,
        sheet: formats.sheetName(stem, p.index, c.format, size.width, size.height),
        package: '', packagePage: 0, note: c.note,
      });
    }
    job.progress.done = i + 1;
  }
  job.tomes = files.filter((f) => !f.problem).map((f) => volumes.tomeOf(f));

  // 2. Группы пакетов: корзина (+ носитель, если в корзине их два) и, по режиму, том
  const carriersByBucket = new Map();
  for (const r of records) {
    if (!carriersByBucket.has(r.bucket)) carriersByBucket.set(r.bucket, new Set());
    carriersByBucket.get(r.bucket).add(carrierKey(r));
  }
  const groups = new Map();
  for (const r of records) {
    const mixed = carriersByBucket.get(r.bucket).size > 1;
    const key = `${byTome ? r.fileId : ''}|${r.bucket}|${mixed ? carrierKey(r) : ''}`;
    if (!groups.has(key)) {
      groups.set(key, {
        bucket: r.bucket, fileId: byTome ? r.fileId : '', rows: [],
        carrierKind: r.carrierKind, carrierBucket: r.carrierBucket, rollWidth: r.rollWidth, carrier: r.carrier,
        carrierSuffix: mixed ? (r.carrierKind === 'roll' ? `рулон${r.rollWidth}` : 'лист') : '',
      });
    }
    groups.get(key).rows.push(r);
  }
  const bucketRank = new Map(formats.bucketOrder().map((b, i) => [b, i]));
  const ordered = [...groups.values()].sort((a, b) => {
    if (byTome) {
      const fa = files.findIndex((f) => f.id === a.fileId), fb = files.findIndex((f) => f.id === b.fileId);
      if (fa !== fb) return fa - fb;
    }
    return (bucketRank.get(a.bucket) ?? 999) - (bucketRank.get(b.bucket) ?? 999) || (a.rollWidth - b.rollWidth);
  });

  // 3. Пакеты: qpdf копирует страницы из исходников напрямую (без растеризации)
  const packages = [];
  if (!st.scanOnly && records.length) {
    const tools = await poppler.available();
    if (!tools.qpdf) {
      problems.push('qpdf не установлен — пакеты не собраны, есть только анализ и отчёт');
    } else {
      const pkgDir = path.join(dir, 'packages');
      fs.mkdirSync(pkgDir, { recursive: true });
      job.progress = { phase: 'merge', done: 0, total: ordered.length, label: '' };
      // файлы, уже помеченные при анализе, второй раз (от qpdf) не помечаем
      const seenWarnings = new Set(problems.map((x) => (/^предупреждение: (.+?) повреждён/.exec(x) || [])[1]).filter(Boolean));
      const limits = { maxBytes: st.maxPackageMb > 0 ? st.maxPackageMb * 1048576 : 0, maxPages: st.maxPackagePages > 0 ? st.maxPackagePages : 0 };
      for (const [i, g] of ordered.entries()) {
        checkCancel(job);
        const tome = byTome ? job.tomes.find((t) => t.fileId === g.fileId) : null;
        const baseName = volumes.packageName(g.bucket, tome, { carrierSuffix: g.carrierSuffix });
        job.progress.label = baseName.replace(/\.pdf$/i, '');
        save(job);
        const rows = g.rows.sort((a, b) => formats.compareRecords(a, b, { byTome }));
        const partsOf = (start, count) => {
          const parts = [];
          for (const r of rows.slice(start, start + count)) {
            const file = files.find((f) => f.id === r.fileId);
            const last = parts[parts.length - 1];
            if (last && last.fileId === r.fileId) last.pages.push(r.page);
            else parts.push({ fileId: r.fileId, file: srcPath(job, file), pages: [r.page] });
          }
          return parts;
        };
        try {
          let plan;
          if (limits.maxBytes || limits.maxPages) {
            plan = await volumes.splitPlan(rows.length, limits, async (start, count) => {
              checkCancel(job);
              return poppler.measure(partsOf(start, count), { tmpDir: config.printTmpDir });
            });
          } else plan = [{ start: 0, count: rows.length, oversize: false }];
          const total = plan.length;
          for (const [k, part] of plan.entries()) {
            checkCancel(job);
            const fileName = total > 1 ? volumes.partName(baseName, k + 1, total) : baseName;
            const out = path.join(pkgDir, fileName);
            const { warnings, bytes } = await poppler.assemble(partsOf(part.start, part.count), out, { tmpDir: config.printTmpDir });
            const slice = rows.slice(part.start, part.start + part.count);
            slice.forEach((r, idx) => { r.package = fileName; r.packagePage = idx + 1; });
            packages.push({
              bucket: g.bucket, file: fileName, pages: slice.length, bytes,
              carrier: g.carrier, carrierKind: g.carrierKind, carrierBucket: g.carrierBucket, rollWidth: g.rollWidth,
              cutMm: slice.reduce((s, r) => s + (r.rollWidth ? r.cut : 0), 0),
              tome: tome ? { fileId: tome.fileId, title: tome.title, name: tome.name } : null,
              part: total > 1 ? { index: k + 1, total } : null,
              oversize: !!part.oversize,
            });
            if (part.oversize) {
              const r0 = slice[0];
              problems.push(`предупреждение: лист ${r0.source} стр.${r0.page} сам по себе больше предела пакета (${mb(bytes)} МБ) — выведен отдельным пакетом «${fileName}»`);
            }
            noteWarnings(warnings, files, seenWarnings, problems);
          }
        } catch (err) {
          if (err instanceof Cancelled) throw err;
          problems.push(`Пакет «${baseName}»: ${err.message}`);
        }
        job.progress.done = i + 1;
      }
    }
  }

  // 4. Отчёты и сводка
  fs.writeFileSync(path.join(dir, 'records.json'), JSON.stringify(records));
  fs.writeFileSync(path.join(dir, 'report.csv'), formats.toCsv(records));
  if (byTome) {
    const map = volumes.assemblyMap(job.tomes, records);
    fs.writeFileSync(path.join(dir, 'карта_сборки.csv'), volumes.assemblyCsv(map));
    fs.writeFileSync(path.join(dir, 'карта_сборки.html'), volumes.assemblyHtml(map, { title: `Карта сборки томов · ${job.userName}` }));
  }
  job.packages = packages;
  job.summary = formats.summarize(records, { tolerance: st.tolerance });
  job.summary.files = files.length;
  job.summary.filesWithProblems = files.filter((f) => f.problem).length;
  job.summary.sourceBytes = files.reduce((s, f) => s + f.size, 0);
  job.summary.packageBytes = packages.reduce((s, p) => s + p.bytes, 0);
  job.summary.grouping = st.grouping;
  job.summary.tomes = byTome ? job.tomes.length : 0;
  job.summary.parts = packages.filter((p) => p.part).length;
  job.progress = { phase: 'done', done: job.progress.total, total: job.progress.total, label: '' };
  job.status = 'done';
}

/** qpdf пишет имена временных файлов src/<id>.pdf — оператору нужна одна строка с именем исходника. */
function noteWarnings(warnings, files, seenWarnings, problems) {
  const byFile = new Map();
  for (const w of warnings) {
    const m = /^([^:]+):\s*(.*)$/.exec(w);
    const base = m ? m[1] : '';
    const name = (files.find((f) => `${f.id}.pdf` === base) || { name: base || 'файл' }).name;
    if (!byFile.has(name)) byFile.set(name, []);
    byFile.get(name).push(m ? m[2] : w);
  }
  for (const [name, msgs] of byFile) {
    if (seenWarnings.has(name)) continue;
    seenWarnings.add(name);
    const damaged = msgs.some((x) => /damaged|reconstruct|startxref/i.test(x));
    problems.push(damaged
      ? `предупреждение: ${name} повреждён (${msgs[0]}) — qpdf восстановил его при сборке, проверьте пакет глазами`
      : `предупреждение: ${name}: ${msgs.slice(0, 2).join('; ')}`);
  }
}

/* ---------------- результаты ---------------- */

function records(job) {
  try { return JSON.parse(fs.readFileSync(path.join(jobDir(job), 'records.json'), 'utf8')); } catch { return []; }
}

function reportCsvPath(job) { return path.join(jobDir(job), 'report.csv'); }

/** Путь файла отчёта по имени из REPORT_FILES; null — такого отчёта у разбора нет. */
function reportPath(job, name) {
  const spec = REPORT_FILES[name];
  if (!spec || job.status !== 'done') return null;
  const file = { csv: 'report.csv', mapcsv: 'карта_сборки.csv', maphtml: 'карта_сборки.html' }[spec.kind];
  if (!file) return null;
  const abs = path.join(jobDir(job), file);
  return fs.existsSync(abs) ? { abs, kind: spec.kind, name } : null;
}

function reportJson(job) {
  return {
    generated: now(),
    app: 'Enso-nexus · Разбор PDF по форматам',
    job: job.id, user: job.userName, settings: job.settings,
    summary: job.summary, packages: job.packages, tomes: job.tomes, problems: job.problems,
    binding: job.binding, schedule: job.schedule,
    pages: records(job),
  };
}

/** Путь пакета: имя проверяется по списку разбора — никаких путей из запроса. */
function packagePath(job, fileName) {
  const pkg = (job.packages || []).find((p) => p.file === fileName);
  if (!pkg) return null;
  const abs = path.join(jobDir(job), 'packages', pkg.file);
  return fs.existsSync(abs) ? { abs, pkg } : null;
}

/** Записи ZIP «скачать всё»: пакеты и отчёты, которые есть на диске. */
function zipEntries(job) {
  const out = [];
  for (const p of job.packages || []) {
    const found = packagePath(job, p.file);
    if (!found) continue;
    const st = fs.statSync(found.abs);
    out.push({ name: p.file, path: found.abs, size: st.size, mtime: st.mtime });
  }
  for (const name of Object.keys(REPORT_FILES)) {
    const r = reportPath(job, name);
    if (!r) continue;
    const st = fs.statSync(r.abs);
    out.push({ name, path: r.abs, size: st.size, mtime: st.mtime });
  }
  return out;
}

/* ---------------- билеты на вкладку ---------------- */

function issueTicket(job) {
  const ticket = crypto.randomBytes(24).toString('hex');
  const exp = Date.now() + config.printTicketMinutes * 60 * 1000;
  tickets.set(ticket, { jobId: job.id, userId: job.userId, userKey: job.userKey, exp });
  for (const [t, v] of tickets) if (v.exp < Date.now()) tickets.delete(t);
  return { ticket, expiresAt: new Date(exp).toISOString() };
}

function jobByTicket(ticket) {
  const v = tickets.get(String(ticket));
  if (!v) return null;
  if (v.exp < Date.now()) { tickets.delete(ticket); return null; }
  const job = live.get(v.jobId) || readJob(path.join(rootDir(), v.userKey, v.jobId));
  return job && job.userId === v.userId ? job : null;
}

/* ---------------- уборка ---------------- */

/**
 * Старше PRINT_TTL_HOURS — удалить; «running» после перезапуска сервера — это
 * прерванный разбор: процесс poppler погиб вместе с node.
 */
function sweep(ttlHours = config.printTtlHours) {
  const root = rootDir();
  if (!fs.existsSync(root)) return { removed: 0, interrupted: 0 };
  const cutoff = Date.now() - ttlHours * 3600 * 1000;
  let removed = 0;
  let interrupted = 0;
  for (const u of fs.readdirSync(root)) {
    const udir = path.join(root, u);
    let stat;
    try { stat = fs.statSync(udir); } catch { continue; }
    if (!stat.isDirectory()) continue;
    for (const name of fs.readdirSync(udir)) {
      const dir = path.join(udir, name);
      if (!ID_RE.test(name)) continue;
      const job = readJob(dir);
      if (!job) { fs.rmSync(dir, { recursive: true, force: true }); removed += 1; continue; }
      if (ttlHours > 0 && Date.parse(job.updatedAt || job.createdAt || 0) < cutoff) {
        deleteJob(job); removed += 1; continue;
      }
      if (job.status === 'running' && !live.has(job.id)) {
        job.status = 'interrupted';
        job.error = 'Сервер перезапустился во время разбора — запустите разбор заново';
        job.userKey = u;
        fs.rmSync(path.join(dir, 'pages'), { recursive: true, force: true });
        save(job);
        interrupted += 1;
      }
    }
    // в папке человека живут и его личные принтеры — пустой считается папка без разборов и без них
    if (!fs.readdirSync(udir).length) fs.rmSync(udir, { recursive: true, force: true });
  }
  return { removed, interrupted };
}

let sweepTimer = null;
function startSweep(intervalMinutes = config.cleanupIntervalMinutes) {
  try { sweep(); } catch (err) { console.error('[print] уборка:', err.message); }
  if (sweepTimer) return sweepTimer;
  sweepTimer = setInterval(() => {
    try {
      const r = sweep();
      if (r.removed) console.log(`[print] удалено разборов по сроку: ${r.removed}`);
    } catch (err) { console.error('[print] уборка:', err.message); }
  }, Math.max(1, intervalMinutes) * 60 * 1000);
  sweepTimer.unref();
  return sweepTimer;
}

/** Свободное место на томе с разборами; null — узнать не удалось (не мешаем). */
function freeBytes(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const st = fs.statfsSync(dir);
    return Number(st.bavail) * Number(st.bsize);
  } catch { return null; }
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function mb(bytes) { return Math.round(bytes / 1048576); }

module.exports = {
  createJob, currentJob, getJob, listJobs, deleteJob, publicView, save,
  addFile, writeChunk, removeFile, findFile, srcPath,
  start, cancel, records, reportCsvPath, reportPath, reportJson, packagePath, zipEntries, REPORT_FILES,
  issueTicket, jobByTicket, sweep, startSweep, Cancelled, jobDir,
};
