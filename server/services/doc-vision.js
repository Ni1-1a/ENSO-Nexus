'use strict';
/**
 * «Изучение документации»: последовательный vision-проход по графике сессии.
 *
 * PNG/JPG и PDF-сканы (без текстового слоя) распознаются vision-моделью LM Studio
 * постранично ДО текстового анализа; результат кэшируется в <stored_path>.vision.md
 * и попадает в контекст текстовой модели (см. claude/memory.js). Так «локальная
 * связка» использует лучшую модель для каждого типа содержимого.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { promisify } = require('util');
const config = require('../config');
const { db, now } = require('../db');
const modelManager = require('./model-manager');
const { extractPdfText } = require('./claude/memory');

const execFileP = promisify(execFile);

const POPPLER_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', ''];
function popplerBin(name) {
  for (const dir of POPPLER_DIRS) {
    const p = dir ? path.join(dir, name) : name;
    try { if (dir) fs.accessSync(p, fs.constants.X_OK); return p; } catch { /* следующий кандидат */ }
  }
  return name;
}

const VISION_PROMPT =
  'Перед тобой страница или изображение из проектной/нормативной документации. ' +
  'Если это текстовая страница или скан — расшифруй её в Markdown максимально дословно: ' +
  'все таблицы строго Markdown-таблицами, сохраняй номера пунктов и заголовки «Таблица N». ' +
  'Если это чертёж, генплан, схема или фотография — систематически опиши содержимое: ' +
  'назначение документа, изображённые объекты и здания, все подписи и надписи, размеры и ' +
  'расстояния, оси, экспликации и таблицы (в Markdown), условные обозначения. ' +
  'Не добавляй выводов и комментариев от себя — только содержимое. Язык — русский.';

function abortError() {
  return Object.assign(new Error('Обработка прервана'), { name: 'AbortError' });
}

async function pdfPageCount(pdfPath, signal) {
  try {
    const { stdout } = await execFileP(popplerBin('pdfinfo'), [pdfPath], { timeout: 20000, signal });
    const m = String(stdout).match(/^Pages:\s+(\d+)/m);
    return m ? parseInt(m[1], 10) : 1;
  } catch { return 1; }
}

async function renderPdfPage(pdfPath, page, signal, dpi = 150) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'docvision-'));
  try {
    await execFileP(popplerBin('pdftoppm'),
      ['-f', String(page), '-l', String(page), '-r', String(dpi), '-png', pdfPath, path.join(tmp, 'p')],
      { timeout: 60000, signal });
    const file = fs.readdirSync(tmp).find((f) => f.endsWith('.png'));
    return file ? fs.readFileSync(path.join(tmp, file)) : null;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function visionOnce(imageBuf, mime, { signal, onProgress }, attempt = 1) {
  const timeout = AbortSignal.timeout(config.localAiTimeoutMs);
  modelManager.acquireUse(config.localAiOcrModel);
  let res;
  try {
    res = await fetch(`${config.localAiBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: config.localAiOcrModel,
        max_tokens: 4000,
        temperature: 0,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: VISION_PROMPT },
            { type: 'image_url', image_url: { url: `data:${mime};base64,${imageBuf.toString('base64')}` } },
          ],
        }],
      }),
      signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
    }).catch((err) => {
      if (signal && signal.aborted) throw abortError();
      throw err;
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 300);
      if (/unload|not loaded|no models? loaded|failed to load/i.test(detail) && attempt <= 2) {
        if (signal && signal.aborted) throw abortError();
        await modelManager.ensureLoaded(config.localAiOcrModel, { onProgress, signal }).catch(() => {});
        return visionOnce(imageBuf, mime, { signal, onProgress }, attempt + 1);
      }
      throw new Error(`vision-модель вернула ошибку ${res.status}: ${detail}`);
    }
    const data = await res.json();
    const choice = data.choices?.[0];
    let text = choice?.message?.content || '';
    if (choice?.finish_reason === 'length') {
      text += '\n\n(расшифровка обрезана по лимиту токенов — нижняя часть страницы могла не распознаться)';
    }
    return text;
  } finally {
    modelManager.releaseUse(config.localAiOcrModel);
  }
}

/**
 * Изучает графику сессии (изображения и PDF-сканы) vision-моделью.
 * Возвращает { files, pages } — сколько файлов/страниц распознано в этот раз
 * (уже закэшированные пропускаются).
 */
async function extractGraphics(sessionId, { signal = null, onProgress = () => {} } = {}) {
  const files = db.prepare('SELECT * FROM files WHERE session_id = ? ORDER BY created_at').all(sessionId);
  const targets = [];
  for (const f of files) {
    const cachePath = f.stored_path + '.vision.md';
    let cached = false;
    try { cached = fs.statSync(cachePath).size > 0; } catch { /* кэша нет */ }
    if (cached) continue;
    if (['png', 'jpg', 'jpeg'].includes(f.ext)) {
      targets.push({ f, kind: 'image' });
    } else if (f.ext === 'pdf') {
      const text = await extractPdfText(f.stored_path, 4000);
      if (!text || text.trim().length < 200) targets.push({ f, kind: 'scan' }); // скан без текстового слоя
    }
  }
  if (!targets.length) return { files: 0, pages: 0 };

  onProgress(`Изучение документации: графических файлов — ${targets.length}`);
  if (signal && signal.aborted) throw abortError();
  await modelManager.ensureLoaded(config.localAiOcrModel, { onProgress, signal });

  let pagesDone = 0;
  const failed = [];
  for (const { f, kind } of targets) {
    if (signal && signal.aborted) throw abortError();
    // ошибки одного файла не должны лишать модель остальных документов
    try {
      const parts = [];
      if (kind === 'image') {
        onProgress(`Изучение документации: ${f.original_name}`);
        const mime = f.ext === 'png' ? 'image/png' : 'image/jpeg';
        parts.push(await visionOnce(fs.readFileSync(f.stored_path), mime, { signal, onProgress }));
        pagesDone++;
      } else {
        const total = await pdfPageCount(f.stored_path, signal);
        const cap = Math.min(total, config.visionMaxPages);
        for (let p = 1; p <= cap; p++) {
          if (signal && signal.aborted) throw abortError();
          onProgress(`Изучение документации: ${f.original_name} — стр. ${p}/${cap}`);
          try {
            const png = await renderPdfPage(f.stored_path, p, signal);
            if (!png) continue;
            parts.push(`\n\n<!-- страница ${p} -->\n` + await visionOnce(png, 'image/png', { signal, onProgress }));
            pagesDone++;
          } catch (err) {
            if (err.name === 'AbortError' || (signal && signal.aborted)) throw err;
            parts.push(`\n\n(страница ${p} не распозналась: ${String(err.message || '').slice(0, 120)})`);
          }
        }
        if (total > cap) parts.push(`\n\n(распознаны первые ${cap} из ${total} страниц скана)`);
      }
      const content = parts.join('').trim();
      if (content) fs.writeFileSync(f.stored_path + '.vision.md', content);
    } catch (err) {
      if (err.name === 'AbortError' || (signal && signal.aborted)) throw err;
      failed.push(f.original_name);
      console.warn('[doc-vision]', f.original_name, err.message);
      try {
        db.prepare('INSERT INTO events (session_id, stage, detail, level, created_at) VALUES (?,?,?,?,?)')
          .run(sessionId, 'Не удалось распознать файл', `${f.original_name}: ${String(err.message || '').slice(0, 150)}`, 'warn', now());
      } catch { /* журнал не критичен */ }
    }
  }
  return { files: targets.length, pages: pagesDone, failed };
}

module.exports = { extractGraphics };
