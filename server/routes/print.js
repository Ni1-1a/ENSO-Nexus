'use strict';
/**
 * REST вкладки «Разбор PDF по форматам»: комплект PDF → листы по корзинам
 * носителей (лист принтера или рулон плоттера) → пакет на корзину, который
 * оператор открывает во вкладке и печатает. Детерминированно, моделей нет.
 *
 * Файлы идут кусками (PUT …/chunks/:n, тело — application/octet-stream):
 * через Cloudflare тело запроса больше 100 МБ не проходит. Пакет во вкладку
 * отдаётся по билету (GET /p/:ticket/:file) без заголовка входа — адрес
 * вкладки заголовок не несёт; билет короткоживущий и привязан к разбору.
 */
const express = require('express');
const config = require('../config');
const { rateLimit, userAuth, requestSizeLimit } = require('../middleware');
const jobs = require('../services/print/jobs');
const formats = require('../services/print/formats');
const poppler = require('../services/print/pdfinfo');

const router = express.Router();
router.use(rateLimit(config.rateLimitGeneral, 'print'));

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** Ошибки хранилища несут статус; всё остальное — в общий обработчик. */
function fail(res, next, err) {
  if (err && err.status) return res.status(err.status).json({ error: err.message });
  return next(err);
}

/* ---------------- пакет во вкладку: по билету, без входа ---------------- */

router.get('/p/:ticket/:file', (req, res, next) => {
  const job = jobs.jobByTicket(req.params.ticket);
  if (!job) return res.status(404).json({ error: 'Ссылка на пакет устарела — откройте пакет заново со страницы разбора' });
  const found = jobs.packagePath(job, req.params.file);
  if (!found) return res.status(404).json({ error: 'Пакет не найден' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="package.pdf"; filename*=UTF-8''${encodeURIComponent(found.pkg.file)}`);
  res.setHeader('Cache-Control', 'private, no-store');
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
    limits: {
      chunkBytes: config.printChunkBytes, maxFileBytes: config.printMaxFileBytes,
      maxTotalBytes: config.printMaxTotalBytes, maxFiles: config.printMaxFiles,
      ttlHours: config.printTtlHours, ticketMinutes: config.printTicketMinutes,
    },
    // pdfinfo нужен для анализа, qpdf — для пакетов; клиент предупреждает о нехватке до загрузки
    tools: await poppler.available(),
  });
}));

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
  res.setHeader('Content-Disposition', `attachment; filename="report.csv"; filename*=UTF-8''${encodeURIComponent('_ОТЧЁТ.csv')}`);
  res.sendFile(jobs.reportCsvPath(req.job), { dotfiles: 'deny' }, (err) => { if (err && !res.headersSent) next(err); });
});

router.get('/jobs/:id/report.json', load, (req, res) => {
  if (!needDone(req, res)) return;
  res.setHeader('Content-Disposition', `attachment; filename="report.json"; filename*=UTF-8''${encodeURIComponent('_ОТЧЁТ.json')}`);
  res.json(jobs.reportJson(req.job));
});

router.post('/jobs/:id/tickets', load, (req, res) => {
  if (!needDone(req, res)) return;
  const t = jobs.issueTicket(req.job);
  res.json({
    ...t,
    packages: req.job.packages.map((p) => ({ ...p, url: `/api/print/p/${t.ticket}/${encodeURIComponent(p.file)}` })),
  });
});

module.exports = { router };
