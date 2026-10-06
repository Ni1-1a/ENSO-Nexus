'use strict';
/**
 * REST вкладки «Разбор PDF по форматам»: комплект PDF → листы по корзинам
 * носителей (лист принтера или рулон плоттера) → пакет на корзину (или на
 * корзину тома), который оператор открывает во вкладке, печатает или
 * скачивает. Детерминированно, моделей нет.
 *
 * Файлы идут кусками (PUT …/chunks/:n, тело — application/octet-stream):
 * через Cloudflare тело запроса больше 100 МБ не проходит. Пакет и отчёты
 * отдаются по билету (GET /p/:ticket/:file) без заголовка входа — адрес
 * вкладки заголовок не несёт; билет короткоживущий и привязан к разбору.
 * «?dl=1» — то же, но вложением с кириллическим именем; «all.zip» — все
 * пакеты и отчёты одним потоком без сжатия (А5).
 *
 * Парк принтеров (А3): общий парк офиса правит владелец, личные принтеры —
 * каждый свои; расчёт времени и калибровка — по текущему разбору.
 */
const express = require('express');
const config = require('../config');
const { rateLimit, userAuth, requestSizeLimit } = require('../middleware');
const jobs = require('../services/print/jobs');
const formats = require('../services/print/formats');
const poppler = require('../services/print/pdfinfo');
const printers = require('../services/print/printers');
const binding = require('../services/print/binding');
const fold = require('../services/print/fold');
const { streamZip } = require('../services/print/zipstream');
const tomeCheck = require('../services/print/tome-check');

const router = express.Router();
router.use(rateLimit(config.rateLimitGeneral, 'print'));

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** Ошибки хранилища несут статус; всё остальное — в общий обработчик. */
function fail(res, next, err) {
  if (err && err.status) return res.status(err.status).json({ error: err.message });
  return next(err);
}

/** Content-Disposition с кириллическим именем: ASCII-запасное плюс filename* по RFC 5987. */
function disposition(kind, name) {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '');
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/* ---------------- по билету, без входа: пакеты, отчёты, ZIP ---------------- */

const TICKET_ERR = 'Ссылка устарела — откройте пакет заново со страницы разбора';

router.get('/p/:ticket/all.zip', (req, res, next) => {
  const job = jobs.jobByTicket(req.params.ticket);
  if (!job) return res.status(404).json({ error: TICKET_ERR });
  const entries = jobs.zipEntries(job);
  if (!entries.length) return res.status(404).json({ error: 'В разборе нет пакетов' });
  const name = `Разбор_${(job.userName || 'печать').replace(/\s+/g, '_')}_${job.id.slice(0, 6)}.zip`;
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', disposition('attachment', name));
  res.setHeader('Cache-Control', 'private, no-store');
  // размер известен только после прохода (дескрипторы данных) — Content-Length нет, идёт chunked
  streamZip(res, entries).catch((err) => {
    if (!res.headersSent) next(err);
    else console.warn('[print] zip прерван:', err.message);
  });
});

router.get('/p/:ticket/:file', (req, res, next) => {
  const job = jobs.jobByTicket(req.params.ticket);
  if (!job) return res.status(404).json({ error: TICKET_ERR });
  const dl = String(req.query.dl) === '1';
  const name = req.params.file;
  res.setHeader('Cache-Control', 'private, no-store');
  // отчёты по билету: CSV, JSON, карта сборки — ссылкой, а не blob'ом (Safari, А5)
  if (jobs.REPORT_FILES[name]) {
    if (name === '_ОТЧЁТ.json') {
      res.setHeader('Content-Disposition', disposition(dl ? 'attachment' : 'inline', name));
      return res.json(jobs.reportJson(job));
    }
    const r = jobs.reportPath(job, name);
    if (!r) return res.status(404).json({ error: 'Такого отчёта у разбора нет' });
    res.setHeader('Content-Type', r.kind === 'maphtml' ? 'text/html; charset=utf-8' : 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', disposition(dl || r.kind !== 'maphtml' ? 'attachment' : 'inline', name));
    return res.sendFile(r.abs, { dotfiles: 'deny' }, (err) => { if (err && !res.headersSent) next(err); });
  }
  const found = jobs.packagePath(job, name);
  if (!found) return res.status(404).json({ error: 'Пакет не найден' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', disposition(dl ? 'attachment' : 'inline', found.pkg.file));
  // sendFile умеет Range: просмотрщик PDF в браузере читает большой пакет частями
  res.sendFile(found.abs, { dotfiles: 'deny' }, (err) => { if (err && !res.headersSent) next(err); });
});

/* ---------------- всё остальное — только вошедшему ---------------- */

router.use(userAuth);

function load(req, res, next) {
  const job = jobs.getJob(req.user, req.params.id);
  if (!job) return res.status(404).json({ error: 'Разбор не найден — возможно, его стёр новый разбор или срок хранения вышел' });
  req.job = job;
  next();
}

router.get('/park', wrap(async (req, res) => {
  res.json({
    park: formats.park,
    defaults: formats.defaults(),
    bindingDefaults: binding.defaults(),
    bindings: binding.BINDINGS.map((id) => ({ id, title: binding.BINDING_TITLES[id] })),
    limits: {
      chunkBytes: config.printChunkBytes, maxFileBytes: config.printMaxFileBytes,
      maxTotalBytes: config.printMaxTotalBytes, maxFiles: config.printMaxFiles,
      ttlHours: config.printTtlHours, ticketMinutes: config.printTicketMinutes,
    },
    owner: req.user.owner === true,
    // pdfinfo нужен для анализа, qpdf — для пакетов, pdftotext — для проверок тома; клиент предупреждает о нехватке до загрузки
    tools: { ...(await poppler.available()), pdftotext: await tomeCheck.available() },
  });
}));

/* ---------------- парк принтеров (А3) ---------------- */

router.get('/printers', (req, res) => {
  printers.ensureOfficeDefaults();
  res.json({ printers: printers.listFor(req.user), presets: printers.presets, owner: req.user.owner === true, modes: printers.MODES, modeTitles: printers.MODE_TITLES });
});

router.post('/printers', (req, res, next) => {
  try { res.status(201).json({ printer: printers.add(req.user, req.body || {}) }); } catch (err) { fail(res, next, err); }
});

router.put('/printers/:pid', (req, res, next) => {
  try { res.json({ printer: printers.update(req.user, req.params.pid, req.body || {}) }); } catch (err) { fail(res, next, err); }
});

router.delete('/printers/:pid', (req, res, next) => {
  try { printers.remove(req.user, req.params.pid); res.json({ ok: true }); } catch (err) { fail(res, next, err); }
});

router.post('/printers/:pid/calibrate', (req, res, next) => {
  try { res.json({ printer: printers.calibrate(req.user, req.params.pid, req.body || {}) }); } catch (err) { fail(res, next, err); }
});

/* ---------------- модель складывания (Б2) ---------------- */

router.get('/fold', (req, res) => {
  const table = binding.foldComparison(formats.park.basic);
  const svg = {};
  for (const [name, [s, l]] of Object.entries(formats.park.basic)) svg[name] = fold.schemeSvg(s, l, { pxWidth: 320 });
  res.json({ table, svg, presets: binding.consumables.fold.presets, defaultPreset: binding.consumables.fold.default, sources: {
    gost: 'ГОСТ 2.501-2013, приложение Г, таблица Г.2 (ru.wikisource.org/wiki/ГОСТ_2.501—2013); ГОСТ 2.501-88, приложение 1, таблица 2',
  } });
});

router.get('/fold/scheme', (req, res) => {
  const s = Number(req.query.short), l = Number(req.query.long);
  if (!(s > 0 && l > 0 && s <= 5000 && l <= 5000)) return res.status(400).json({ error: 'short и long — стороны листа в мм' });
  res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
  res.send(fold.schemeSvg(Math.min(s, l), Math.max(s, l), { pxWidth: 320, title: req.query.title === 'short' ? 'short' : 'long' }));
});

/* ---------------- разборы ---------------- */

router.get('/jobs', (req, res) => {
  const job = jobs.currentJob(req.user);
  res.json({ job: job ? jobs.publicView(job) : null });
});

router.post('/jobs', (req, res) => {
  res.status(201).json({ job: jobs.publicView(jobs.createJob(req.user)) });
});

router.get('/jobs/:id', load, (req, res) => {
  const out = { job: jobs.publicView(req.job) };
  if (String(req.query.records) === '1' && req.job.status === 'done') out.records = jobs.records(req.job);
  res.json(out);
});

router.delete('/jobs/:id', load, (req, res) => {
  jobs.deleteJob(req.job);
  res.json({ ok: true });
});

router.post('/jobs/:id/files', load, (req, res, next) => {
  try {
    const file = jobs.addFile(req.job, req.body || {});
    res.status(201).json({ file: jobs.publicView(req.job).files.find((f) => f.id === file.id) });
  } catch (err) { fail(res, next, err); }
});

router.put('/jobs/:id/files/:fid/chunks/:n', load,
  requestSizeLimit(config.printChunkBytes + 1024),
  express.raw({ type: () => true, limit: config.printChunkBytes + 1024 }),
  (req, res, next) => {
    try {
      const file = jobs.writeChunk(req.job, req.params.fid, req.params.n, req.body);
      res.json({ file: jobs.publicView(req.job).files.find((f) => f.id === file.id) });
    } catch (err) { fail(res, next, err); }
  });

router.delete('/jobs/:id/files/:fid', load, (req, res, next) => {
  try {
    jobs.removeFile(req.job, req.params.fid);
    res.json({ job: jobs.publicView(req.job) });
  } catch (err) { fail(res, next, err); }
});

router.post('/jobs/:id/run', load, rateLimit(config.rateLimitExpensive, 'print-run'), (req, res, next) => {
  try {
    jobs.start(req.job, req.body || {});
    res.status(202).json({ job: jobs.publicView(req.job) });
  } catch (err) { fail(res, next, err); }
});

router.post('/jobs/:id/cancel', load, (req, res) => {
  res.json({ job: jobs.publicView(jobs.cancel(req.job)) });
});

function needDone(req, res) {
  if (req.job.status !== 'done') { res.status(409).json({ error: 'Отчёт появится, когда разбор закончится' }); return false; }
  return true;
}

router.get('/jobs/:id/report.csv', load, (req, res, next) => {
  if (!needDone(req, res)) return;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', disposition('attachment', '_ОТЧЁТ.csv'));
  res.sendFile(jobs.reportCsvPath(req.job), { dotfiles: 'deny' }, (err) => { if (err && !res.headersSent) next(err); });
});

router.get('/jobs/:id/report.json', load, (req, res) => {
  if (!needDone(req, res)) return;
  res.setHeader('Content-Disposition', disposition('attachment', '_ОТЧЁТ.json'));
  res.json(jobs.reportJson(req.job));
});

/** Билет: адреса пакетов, отчётов и ZIP — во вкладку (inline) и на скачивание (dl=1). */
router.post('/jobs/:id/tickets', load, (req, res) => {
  if (!needDone(req, res)) return;
  const t = jobs.issueTicket(req.job);
  const base = `/api/print/p/${t.ticket}/`;
  const reports = {};
  for (const name of Object.keys(jobs.REPORT_FILES)) {
    if (name === '_ОТЧЁТ.json' || jobs.reportPath(req.job, name)) reports[name] = { url: base + encodeURIComponent(name), download: `${base}${encodeURIComponent(name)}?dl=1` };
  }
  res.json({
    ...t,
    packages: req.job.packages.map((p) => ({ ...p, url: base + encodeURIComponent(p.file), download: `${base}${encodeURIComponent(p.file)}?dl=1` })),
    reports,
    zip: req.job.packages.length ? `${base}all.zip` : '',
  });
});

/* ---------------- переплёт (А6) и время печати (А3) ---------------- */

/** Экземпляры и переплёт: расчёт по томам и закупка; настройки запоминаются в разборе. */
router.post('/jobs/:id/binding', load, (req, res, next) => {
  if (!needDone(req, res)) return;
  let st;
  try { st = binding.normalize(req.body || {}); } catch (err) { return res.status(400).json({ error: err.message }); }
  try {
    const recs = jobs.records(req.job);
    const tomes = (req.job.tomes || []).map((t) => binding.tomeBinding(t, recs.filter((r) => r.fileId === t.fileId), st));
    const result = { settings: st, tomes, purchase: binding.purchase(tomes, st), at: new Date().toISOString() };
    req.job.binding = result;
    jobs.save(req.job);
    res.json(result);
  } catch (err) { fail(res, next, err); }
});

/** Расчёт времени: пакеты разбора × копии → очереди принтеров парка. */
router.post('/jobs/:id/schedule', load, (req, res, next) => {
  if (!needDone(req, res)) return;
  const body = req.body || {};
  const mode = printers.MODES.includes(body.mode) ? body.mode : 'normal';
  const duplex = body.duplex === true || body.duplex === 'true';
  const copies = Math.max(1, Math.min(999, Math.round(Number(body.copies)) || ((req.job.binding && req.job.binding.settings.copies) || 1)));
  const perTome = (req.job.binding && req.job.binding.settings.perTome) || {};
  const ids = Array.isArray(body.printerIds) ? new Set(body.printerIds.map(String)) : null;
  try {
    printers.ensureOfficeDefaults();
    const park = printers.listFor(req.user).filter((p) => !ids || ids.has(p.id));
    const units = req.job.packages.map((p) => ({
      id: p.file, label: p.file.replace(/\.pdf$/i, ''), carrierKind: p.carrierKind, carrierBucket: p.carrierBucket, rollWidth: p.rollWidth,
      pages: p.pages, bytes: p.bytes, cuts: p.cutMm ? [p.cutMm] : [], color: false,
      copies: p.tome && Number.isFinite(perTome[p.tome.fileId]) ? perTome[p.tome.fileId] : copies,
    }));
    const plan = printers.schedule(units, park, { mode, duplex });
    const result = { ...plan, copies, at: new Date().toISOString(), printers: park.map((p) => ({ id: p.id, name: p.name, type: p.type, scope: p.scope })) };
    req.job.schedule = result;
    jobs.save(req.job);
    res.json(result);
  } catch (err) { fail(res, next, err); }
});

/* ---------------- нормоконтроль тома (Б3) ---------------- */

router.post('/jobs/:id/tome-check', load, rateLimit(config.rateLimitExpensive, 'print-check'), wrap(async (req, res) => {
  if (!needDone(req, res)) return;
  const result = await tomeCheck.run(req.job, jobs.records(req.job), { srcPath: (file) => jobs.srcPath(req.job, file) });
  req.job.tomeCheck = result;
  jobs.save(req.job);
  res.json(result);
}));

module.exports = { router };
