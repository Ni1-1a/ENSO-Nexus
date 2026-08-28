'use strict';
/**
 * REST вкладки «Акты (АОСР)»: детерминированный конвейер черновиков актов
 * и сверка дат акт↔журнал. Модели не вызываются, ничего не хранится —
 * оба маршрута stateless: файлы пришли, результат ушёл.
 */
const express = require('express');
const multer = require('multer');
const config = require('../config');
const { rateLimit, userAuth } = require('../middleware');
const xlsxRead = require('../services/akty/xlsx-read');
const generate = require('../services/akty/generate');
const dates = require('../services/akty/dates');

const router = express.Router();
router.use(rateLimit(config.rateLimitGeneral, 'akty'));
router.use(userAuth);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 40 * 1024 * 1024, files: 2 },
});

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function fileByField(req, field) {
  return (req.files || []).find((f) => f.fieldname === field) || null;
}

/** Разбор реестра: показать человеку колонки и первые строки ДО генерации. */
router.post('/registry/preview', upload.any(), wrap(async (req, res) => {
  const reg = fileByField(req, 'registry');
  if (!reg) return res.status(400).json({ error: 'Нужен файл реестра (multipart-поле registry, XLSX)' });
  let table;
  try { table = xlsxRead.readTable(reg.buffer); } catch (err) {
    return res.status(422).json({ error: `Реестр не разобран: ${err.message}` });
  }
  res.json({
    headers: table.headers,
    rowCount: table.rowCount,
    sample: table.rows.slice(0, 5),
  });
}));

/** Плейсхолдеры шаблона: сверка с колонками до генерации. */
router.post('/template/preview', upload.any(), wrap(async (req, res) => {
  const tpl = fileByField(req, 'template');
  if (!tpl) return res.status(400).json({ error: 'Нужен файл шаблона (multipart-поле template, DOCX)' });
  try {
    res.json({ keys: generate.templateKeys(tpl.buffer) });
  } catch (err) {
    res.status(422).json({ error: `Шаблон не разобран: ${err.message}` });
  }
}));

/** Пачка актов: реестр + шаблон → zip черновиков + отчёт о пропусках. */
router.post('/generate',
  rateLimit(config.rateLimitExpensive, 'akty-generate'), upload.any(),
  wrap(async (req, res) => {
    const reg = fileByField(req, 'registry');
    const tpl = fileByField(req, 'template');
    if (!reg || !tpl) {
      return res.status(400).json({ error: 'Нужны два файла: registry (XLSX-реестр) и template (DOCX-шаблон с {{плейсхолдерами}})' });
    }
    let table;
    try { table = xlsxRead.readTable(reg.buffer); } catch (err) {
      return res.status(422).json({ error: `Реестр не разобран: ${err.message}` });
    }
    let out;
    try { out = generate.generateBatch(tpl.buffer, table); } catch (err) {
      return res.status(422).json({ error: err.message });
    }
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent('Черновики актов.zip')}`);
    res.setHeader('X-Akty-Report', encodeURIComponent(JSON.stringify(out.report)));
    res.send(out.zip);
  }));

/** Сверка дат: реестр актов + журнал → таблица конфликтов (JSON). */
router.post('/dates',
  rateLimit(config.rateLimitExpensive, 'akty-dates'), upload.any(),
  wrap(async (req, res) => {
    const acts = fileByField(req, 'acts');
    const journal = fileByField(req, 'journal');
    if (!acts || !journal) {
      return res.status(400).json({ error: 'Нужны два файла: acts (XLSX-реестр актов) и journal (XLSX-выгрузка журнала)' });
    }
    let actsTable;
    let journalTable;
    try { actsTable = xlsxRead.readTable(acts.buffer); } catch (err) {
      return res.status(422).json({ error: `Реестр актов не разобран: ${err.message}` });
    }
    try { journalTable = xlsxRead.readTable(journal.buffer); } catch (err) {
      return res.status(422).json({ error: `Журнал не разобран: ${err.message}` });
    }
    try {
      res.json(dates.compare(actsTable, journalTable));
    } catch (err) {
      res.status(422).json({ error: err.message });
    }
  }));

module.exports = { router };
