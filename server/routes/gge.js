'use strict';
/**
 * REST вкладки «Входной контроль ГГЭ»: реквизитно-форматная проверка комплекта
 * перед подачей. Полностью детерминированно, stateless, моделей нет: отказ
 * в приёме — это реквизиты, подписи и формат, их ловит код (приём Д7).
 */
const path = require('path');
const express = require('express');
const multer = require('multer');
const config = require('../config');
const { rateLimit, userAuth, requestSizeLimit } = require('../middleware');
const check = require('../services/gge/check');
const projects = require('../services/projects');

const router = express.Router();
router.use(rateLimit(config.rateLimitGeneral, 'gge'));
router.use(userAuth);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 90 * 1024 * 1024, files: 40 },
});

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function decodeName(file) {
  const { sanitizeFilename } = require('../services/validation');
  return sanitizeFilename(Buffer.from(String(file.originalname), 'latin1').toString('utf8'));
}

/** Развилки по датам — без файлов, чистый расчёт. */
router.post('/forks', express.json(), (req, res) => {
  const { taskDate, fgisDate } = req.body || {};
  res.json(check.dateForks({ taskDate, fgisDate }));
});

/**
 * Полная проверка комплекта: файлы + эталонные реквизиты (поле fields —
 * JSON-строка {«Название объекта»: «…», …}) + даты развилок.
 */
router.post('/check',
  rateLimit(config.rateLimitExpensive, 'gge-check'), requestSizeLimit(config.uploadTotalBytes), upload.any(),
  wrap(async (req, res) => {
    const files = (req.files || []).map((f) => ({
      name: decodeName(f),
      size: f.size,
      buffer: f.buffer,
    }));
    if (!files.length) return res.status(400).json({ error: 'Нужен хотя бы один файл комплекта (multipart-поле files)' });

    let fields = {};
    try { fields = req.body.fields ? JSON.parse(req.body.fields) : {}; } catch {
      return res.status(400).json({ error: 'Поле fields должно быть JSON-объектом «реквизит → эталонное значение»' });
    }
    // массив, null и число — валидный JSON, но не карта реквизитов
    if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
      return res.status(400).json({ error: 'Поле fields должно быть JSON-объектом «реквизит → эталонное значение»' });
    }

    const filenames = check.checkFilenames(files);
    const textLayers = await check.checkTextLayers(files);

    // тексты для сверки реквизитов: PDF — из проверки слоя, DOCX/TXT — извлечь
    const memory = require('../services/claude/memory');
    const docs = [];
    for (const f of files) {
      const ext = path.extname(f.name).toLowerCase();
      const fromPdf = textLayers.find((t) => t.file === f.name && t.text !== undefined);
      if (fromPdf) { docs.push({ name: f.name, text: fromPdf.text }); continue; }
      if (ext === '.docx') {
        const os = require('os');
        const fs = require('fs');
        // своя временная папка: в общем /tmp предсказуемое имя — гонка с символической ссылкой
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gge-'));
        const tmp = path.join(dir, 'doc.docx');
        fs.writeFileSync(tmp, f.buffer);
        try { docs.push({ name: f.name, text: memory.extractDocxText(tmp) || '' }); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
      } else if (['.txt', '.md'].includes(ext)) {
        docs.push({ name: f.name, text: f.buffer.toString('utf8') });
      }
    }
    const requisites = Object.keys(fields).length ? check.checkRequisites(fields, docs) : [];

    const forks = check.dateForks({ taskDate: req.body.taskDate, fgisDate: req.body.fgisDate });

    // ?project=<id> — проект платформы помнит дату и размер последнего прогона
    const pid = projects.normId(req.query.project);
    if (pid) projects.mark(pid, 'gge', `файлов: ${files.length}`, req.user);

    // текст в ответ не возвращается — только вердикты
    for (const t of textLayers) delete t.text;

    res.json({
      filenames,
      textLayers,
      requisites,
      forks,
      summary: {
        files: files.length,
        filename_problems: filenames.filter((r) => !r.ok).length,
        scan_pdfs: textLayers.filter((r) => r.ok === false).length,
        requisite_problems: requisites.filter((r) => !r.ok).length,
        forks_missing: forks.missing.length,
      },
      notes: [
        'Проверка покрывает реквизитно-форматную механику; содержание разделов она не оценивает.',
        'Сверка реквизитов работает по извлечённым текстам: скан без текстового слоя в сверке не участвует (он же помечен выше).',
      ],
    });
  }));

module.exports = { router };
