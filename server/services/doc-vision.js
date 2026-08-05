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
const { execFileSync } = require('child_process');
const config = require('../config');
const { db } = require('../db');
const modelManager = require('./model-manager');
const { extractPdfText } = require('./claude/memory');

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

function pdfPageCount(pdfPath) {
  try {
    const out = execFileSync(popplerBin('pdfinfo'), [pdfPath], { timeout: 20000 }).toString();
    const m = out.match(/^Pages:\s+(\d+)/m);
    return m ? parseInt(m[1], 10) : 1;
  } catch { return 1; }
}

function renderPdfPage(pdfPath, page, dpi = 150) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'docvision-'));
  try {
    execFileSync(popplerBin('pdftoppm'),
      ['-f', String(page), '-l', String(page), '-r', String(dpi), '-png', pdfPath, path.join(tmp, 'p')],
      { timeout: 60000 });
    const file = fs.readdirSync(tmp).find((f) => f.endsWith('.png'));
    return file ? fs.readFileSync(path.join(tmp, file)) : null;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function visionOnce(imageBuf, mime, { signal, onProgress }, attempt = 1) {
  const timeout = AbortSignal.timeout(config.localAiTimeoutMs);
  const res = await fetch(`${config.localAiBaseUrl}/chat/completions`, {
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
      await modelManager.ensureLoaded(config.localAiOcrModel, { onProgress }).catch(() => {});
      return visionOnce(imageBuf, mime, { signal, onProgress }, attempt + 1);
    }
    throw new Error(`vision-модель вернула ошибку ${res.status}: ${detail}`);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
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
  await modelManager.ensureLoaded(config.localAiOcrModel, { onProgress });

  let pagesDone = 0;
  for (const { f, kind } of targets) {
    if (signal && signal.aborted) throw abortError();
    const parts = [];
    if (kind === 'image') {
      onProgress(`Изучение документации: ${f.original_name}`);
      const mime = f.ext === 'png' ? 'image/png' : 'image/jpeg';
      parts.push(await visionOnce(fs.readFileSync(f.stored_path), mime, { signal, onProgress }));
      pagesDone++;
    } else {
      const total = pdfPageCount(f.stored_path);
      const cap = Math.min(total, config.visionMaxPages);
      for (let p = 1; p <= cap; p++) {
        if (signal && signal.aborted) throw abortError();
        onProgress(`Изучение документации: ${f.original_name} — стр. ${p}/${cap}`);
        const png = renderPdfPage(f.stored_path, p);
        if (!png) continue;
        parts.push(`\n\n<!-- страница ${p} -->\n` + await visionOnce(png, 'image/png', { signal, onProgress }));
        pagesDone++;
      }
      if (total > cap) parts.push(`\n\n(распознаны первые ${cap} из ${total} страниц скана)`);
    }
    const content = parts.join('').trim();
    if (content) fs.writeFileSync(f.stored_path + '.vision.md', content);
  }
  return { files: targets.length, pages: pagesDone };
}

module.exports = { extractGraphics };
