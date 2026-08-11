'use strict';
/**
 * «Изучение документации»: последовательный vision-проход по графике сессии.
 *
 * PNG/JPG и PDF-сканы (без текстового слоя) распознаются постранично ДО текстового
 * анализа; результат кэшируется в <stored_path>.vision.md и попадает в контекст
 * текстовой модели (см. claude/memory.js).
 *
 * КТО РАСПОЗНАЁТ (решение владельца, 2026-08-09): выбранная в проекте модель, если
 * она умеет зрение по реестру возможностей. Локальная vision-модель LM Studio —
 * только когда распознавания иначе НЕТ: выбранная модель слепая, отказала или
 * вернула пустую расшифровку. Раньше сканы всегда уходили в локальную модель, даже
 * когда проект вёл ChatGPT, и качество распознавания ГПЗУ определялось не выбором
 * человека, а переменной LOCAL_AI_OCR_MODEL.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { promisify } = require('util');
const config = require('../config');
const { db, now } = require('../db');
const modelManager = require('./model-manager');
const registry = require('./ai/registry');
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

/** Бюджет ответа на одну страницу: расшифровка плотной страницы ТЗ в него укладывается. */
const VISION_MAX_TOKENS = 4000;

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

/**
 * Прерывание и исчерпанный бюджет проекта — это СТОП, а не «страница не
 * распозналась»: помечать их как сбой страницы значит гнать оставшиеся шестнадцать
 * страниц в заведомо отказывающую модель и записать в журнал вымышленную причину.
 */
function isStopError(err, signal) {
  if (err.name === 'AbortError' || (signal && signal.aborted)) return true;
  return err instanceof require('./claude/adapter').BudgetExceededError;
}

/**
 * execFile принимает AbortSignal либо undefined; `signal: null` он отвергает
 * с TypeError. Один вызов extractGraphics без signal ломал из-за этого весь
 * OCR: pdfinfo падал, счёт страниц молча становился 1, и от 17-страничного
 * скана распознавалась ровно первая страница.
 */
function execOpts(signal, timeout, extra = {}) {
  return signal ? { timeout, signal, ...extra } : { timeout, ...extra };
}

/** Число страниц PDF. Бросает, если pdfinfo не отработал, — врать про «1 страницу» нельзя. */
async function pdfPageCount(pdfPath, signal) {
  const { stdout } = await execFileP(popplerBin('pdfinfo'), [pdfPath], execOpts(signal, 20000));
  const m = String(stdout).match(/^Pages:\s+(\d+)/m);
  if (!m) throw new Error('pdfinfo не сообщил число страниц');
  return parseInt(m[1], 10);
}

/**
 * Текстовый слой ПОСТРАНИЧНО (один вызов pdftotext, страницы разделены \f).
 * Решение «скан или текст» обязано приниматься по странице, а не по файлу:
 * в реальном ТЗ первая страница — картинка, остальные 21 — текст, и по сумме
 * символов файл выглядел текстовым, а шапка задания терялась целиком.
 */
async function pdfPagesText(pdfPath, signal) {
  const { stdout } = await execFileP(
    popplerBin('pdftotext'), ['-layout', pdfPath, '-'],
    execOpts(signal, 120000, { maxBuffer: 64 * 1024 * 1024 }),
  );
  const pages = String(stdout).split('\f');
  if (pages.length && !pages[pages.length - 1].trim()) pages.pop(); // хвостовой \f
  return pages;
}

async function renderPdfPage(pdfPath, page, signal, dpi = 150) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'docvision-'));
  try {
    await execFileP(popplerBin('pdftoppm'),
      ['-f', String(page), '-l', String(page), '-r', String(dpi), '-png', pdfPath, path.join(tmp, 'p')],
      execOpts(signal, 60000));
    const file = fs.readdirSync(tmp).find((f) => f.endsWith('.png'));
    return file ? fs.readFileSync(path.join(tmp, file)) : null;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/* ---------------- кэш распознавания ---------------- */

/**
 * Кэш живёт в <файл>.vision.md; служебная сводка приписана последней строкой
 * HTML-комментарием (её снимает claude/memory.js). Отдельного файла нет
 * намеренно: удаление документа чистит ровно один спутник.
 *
 * Главное правило: НЕУДАЧА РАСПОЗНАВАНИЯ В КЭШ НЕ ПОПАДАЕТ. Раньше временно
 * недоступная LM Studio превращала ГПЗУ в «документ» с текстом «(страница 1 не
 * распозналась: fetch failed)», кэш считался валидным по одному условию size>0,
 * и повтор не запускался никогда — файл приходилось удалять и грузить заново.
 */
const META_RE = /\n?<!--enso-vision:(\{[\s\S]*?\})-->\s*$/;
const PAGE_RE = /<!-- страница (\d+) -->/g;

function cachePath(f) { return f.stored_path + '.vision.md'; }

function readVisionCache(f) {
  let raw = '';
  try { raw = fs.readFileSync(cachePath(f), 'utf8'); } catch { return { pages: new Map(), meta: null, exists: false }; }
  const m = raw.match(META_RE);
  let meta = null;
  if (m) { try { meta = JSON.parse(m[1]); } catch { meta = null; } raw = raw.slice(0, m.index); }
  // разбор по страницам: нужен для дораспознавания только недостающих
  const pages = new Map();
  const marks = [...raw.matchAll(PAGE_RE)];
  if (marks.length) {
    marks.forEach((mk, i) => {
      const from = mk.index + mk[0].length;
      const to = i + 1 < marks.length ? marks[i + 1].index : raw.length;
      pages.set(parseInt(mk[1], 10), raw.slice(from, to).trim());
    });
  } else if (raw.trim()) {
    pages.set(1, raw.trim());
  }
  return { pages, meta, exists: true, legacyText: raw };
}

/** Нужно ли (до)распознавать файл: кэша нет или в прошлый раз были СБОИ. */
function cacheNeedsWork(cache) {
  if (!cache.exists) return true;
  if (!cache.meta) {
    // кэш старого образца: в нём мог осесть текст ошибки — тогда распознаём заново
    return /не распозналась|не распозналось/.test(cache.legacyText || '');
  }
  return !!(cache.meta.failed && cache.meta.failed.length);
}

function writeVisionCache(f, pages, meta, notes) {
  const ordered = [...pages.entries()].filter(([, t]) => t && t.trim()).sort((a, b) => a[0] - b[0]);
  if (!ordered.length) return false; // распознавать было нечего — кэш не создаём
  const single = ordered.length === 1 && meta.kind === 'image';
  const body = single
    ? ordered[0][1].trim()
    : ordered.map(([p, t]) => `<!-- страница ${p} -->\n${t.trim()}`).join('\n\n');
  const tail = notes.length ? `\n\n${notes.join('\n')}` : '';
  fs.writeFileSync(cachePath(f), `${body}${tail}\n<!--enso-vision:${JSON.stringify(meta)}-->`);
  return true;
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

/* ---------------- кто распознаёт страницу ---------------- */

function modelKey(who) { return `${who.provider}/${who.model}`; }

/** Распознавание страницы ВЫБРАННОЙ моделью проекта — тем же путём, что и весь остальной диалог. */
async function recognizeViaRoute(imageBuf, mime, { sessionId, route, signal, label }) {
  const adapter = require('./claude/adapter');
  // бюджет проверяется перед КАЖДОЙ страницей: скан на 17 страниц — это 17 оплачиваемых запросов
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
  if (session) adapter.checkBudget(session);
  const out = await adapter.plainCall({
    system: VISION_PROMPT,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mime, data: imageBuf.toString('base64') } },
        { type: 'text', text: 'Расшифруй эту страницу по правилам выше.' },
      ],
    }],
    sessionId, route, signal, maxTokens: VISION_MAX_TOKENS,
    // шаг индикатора остаётся «Изучение документации», а не «Генерация ответа»
    progressStep: label ? { phase: 'reading_docs', label } : null,
    // страница документа — служебный запрос: токены и деньги считаются, лимит
    // запросов проекта не расходуется (иначе скан на 17 страниц съедает его целиком)
    internal: true,
  });
  let text = String(out.text || '').trim();
  // пустая расшифровка — это НЕ распознавание: пусть подхватывает локальная модель
  if (!text) throw new Error('модель вернула пустую расшифровку');
  if (out.truncated) {
    text += '\n\n(расшифровка обрезана по лимиту токенов — нижняя часть страницы могла не распознаться)';
  }
  return text;
}

/**
 * Распознаватель на один прогон: ведёт выбранная модель, локальная подхватывает.
 *
 * Две неудачи подряд переводят прогон целиком на локальную модель: если у облака
 * кончился ключ или бюджет, семнадцать заведомо безнадёжных запросов — это только
 * потерянные минуты. Прерывание и исчерпанный бюджет проекта не подменяются
 * локальным распознаванием вообще: это не «нет распознавания», а стоп-сигнал.
 */
function makeRecognizer({ sessionId, route, signal, onProgress }) {
  const local = { kind: 'local', provider: 'lmstudio', model: config.localAiOcrModel };
  const canSee = !!(route && route.provider && route.provider !== 'demo' && registry.supports(route, 'vision'));
  const primary = canSee
    ? { kind: 'route', provider: route.provider, model: require('./claude/adapter').resolveModel(route) }
    : local;

  let localLoaded = false;
  let misses = 0;
  let degraded = false;
  const reasons = [];

  async function runLocal(imageBuf, mime, label) {
    // модель грузится в LM Studio только когда она действительно нужна: при
    // выбранном облаке прогрев локальной vision-модели — это чистая трата минут
    if (!localLoaded) {
      await modelManager.ensureLoaded(config.localAiOcrModel, { onProgress: (t) => onProgress(t, local), signal });
      localLoaded = true;
    }
    if (label) onProgress(label, local);
    const text = await visionOnce(imageBuf, mime, { signal, onProgress: (t) => onProgress(t, local) });
    if (!String(text || '').trim()) throw new Error('локальная vision-модель вернула пустую расшифровку');
    return { text, by: local };
  }

  return {
    primary,
    reasons,
    /** Кем будет распознана следующая страница — для честной подписи в индикаторе. */
    next() { return primary.kind === 'route' && !degraded ? primary : local; },
    async run(imageBuf, mime, label) {
      if (primary.kind === 'local' || degraded) return runLocal(imageBuf, mime, label);
      try {
        const text = await recognizeViaRoute(imageBuf, mime, { sessionId, route, signal, label });
        misses = 0;
        return { text, by: primary };
      } catch (err) {
        if (isStopError(err, signal)) throw err;
        misses++;
        reasons.push(String(err.message || '').slice(0, 150));
        console.warn('[doc-vision] выбранная модель не распознала страницу:', err.message);
        if (misses >= 2) degraded = true;
        return runLocal(imageBuf, mime, label);
      }
    },
  };
}

/**
 * Изучает графику сессии (изображения и PDF-сканы) vision-моделью.
 * Возвращает { files, pages } — сколько файлов/страниц распознано в этот раз
 * (уже закэшированные пропускаются).
 */
async function extractGraphics(sessionId, { route = null, signal = null, onProgress = () => {} } = {}) {
  const files = db.prepare('SELECT * FROM files WHERE session_id = ? ORDER BY created_at').all(sessionId);
  const targets = [];
  for (const f of files) {
    const cache = readVisionCache(f);
    if (!cacheNeedsWork(cache)) continue;
    if (['png', 'jpg', 'jpeg'].includes(f.ext)) {
      targets.push({ f, kind: 'image', cache, pages: [1], totalPages: 1, capped: false });
    } else if (f.ext === 'pdf') {
      const plan = await planPdfPages(f, cache, signal);
      if (plan && plan.pages.length) targets.push({ f, kind: 'scan', cache, ...plan });
    }
  }
  if (!targets.length) return { files: 0, pages: 0, failed: [], by: [] };

  const rec = makeRecognizer({ sessionId, route, signal, onProgress });
  onProgress(`Изучение документации: графических файлов — ${targets.length}`, rec.next());
  if (signal && signal.aborted) throw abortError();

  let pagesDone = 0;
  const failed = [];
  const partial = [];
  const usedAll = new Set();
  for (const t of targets) {
    const { f, kind, cache } = t;
    if (signal && signal.aborted) throw abortError();
    // ошибки одного файла не должны лишать модель остальных документов
    const pages = new Map(cache.pages); // уже распознанное с прошлого раза сохраняем
    const failedPages = [];
    // чем распознан файл — вместе с тем, что было распознано в прошлые прогоны
    const usedHere = new Set((cache.meta && cache.meta.by) || []);
    const remember = (by) => { usedHere.add(modelKey(by)); usedAll.add(modelKey(by)); };
    try {
      if (kind === 'image') {
        const label = `Изучение документации: ${f.original_name}`;
        onProgress(label, rec.next());
        const mime = f.ext === 'png' ? 'image/png' : 'image/jpeg';
        const r = await rec.run(fs.readFileSync(f.stored_path), mime, label);
        pages.set(1, r.text);
        remember(r.by);
        pagesDone++;
      } else {
        let i = 0;
        for (const p of t.pages) {
          if (signal && signal.aborted) throw abortError();
          i++;
          const label = `Изучение документации: ${f.original_name} — страница ${p} (${i} из ${t.pages.length})`;
          onProgress(label, rec.next());
          try {
            const png = await renderPdfPage(f.stored_path, p, signal);
            if (!png) throw new Error('страница не отрисовалась в PNG');
            const r = await rec.run(png, 'image/png', label);
            pages.set(p, r.text);
            remember(r.by);
            pagesDone++;
          } catch (err) {
            if (isStopError(err, signal)) throw err;
            // текст ошибки НЕ становится содержимым страницы — страница остаётся нераспознанной
            failedPages.push({ page: p, reason: String(err.message || '').slice(0, 120) });
            console.warn('[doc-vision]', f.original_name, `стр. ${p}:`, err.message);
          }
        }
      }
    } catch (err) {
      if (isStopError(err, signal)) throw err;
      failedPages.push({ page: 0, reason: String(err.message || '').slice(0, 150) });
      console.warn('[doc-vision]', f.original_name, err.message);
    }

    const notes = [];
    if (failedPages.length) {
      notes.push(`(⚠ Не распознаны страницы: ${failedPages.map((x) => x.page || '—').join(', ')} — ` +
        `${failedPages[0].reason}. Их содержимое в этот текст НЕ вошло; при следующем запуске распознавание повторится.)`);
    }
    if (t.capped) {
      notes.push(`(Распознано ${t.pages.length} страниц из ${t.needTotal} нуждавшихся в распознавании — ` +
        `предел VISION_MAX_PAGES=${config.visionMaxPages}.)`);
    }
    // Подмена распознавателя не имеет права остаться незаметной: качество расшифровки
    // у локальной 8B-модели и у выбранного облака разное, и человек должен знать,
    // чем на самом деле прочитан его скан.
    if (rec.primary.kind === 'route' && usedHere.has(modelKey({ provider: 'lmstudio', model: config.localAiOcrModel }))) {
      notes.push(`(⚠ Часть страниц распознала локальная модель ${config.localAiOcrModel}: ` +
        `выбранная модель ${modelKey(rec.primary)} не справилась — ${rec.reasons[0] || 'причина не определена'}.)`);
    }
    const meta = {
      v: 1, kind, at: new Date().toISOString(),
      totalPages: t.totalPages || pages.size,
      recognized: [...pages.keys()].sort((a, b) => a - b),
      failed: failedPages.map((x) => x.page),
      capped: !!t.capped,
      complete: !failedPages.length && !t.capped,
      by: [...usedHere],
    };
    const wrote = writeVisionCache(f, pages, meta, notes);

    if (!wrote || !pages.size) {
      // распознать не удалось ВООБЩЕ — кэша не создаём (иначе ошибка навсегда
      // становится «содержимым документа»), пишем честное событие в журнал
      failed.push(f.original_name);
      try {
        db.prepare('INSERT INTO events (session_id, stage, detail, level, created_at) VALUES (?,?,?,?,?)')
          .run(sessionId, 'Не удалось распознать файл',
            `${f.original_name}: ${(failedPages[0] && failedPages[0].reason) || 'причина не определена'} — результат НЕ закэширован, попытка повторится`,
            'warn', now());
      } catch { /* журнал не критичен */ }
    } else if (failedPages.length) {
      partial.push(f.original_name);
      try {
        db.prepare('INSERT INTO events (session_id, stage, detail, level, created_at) VALUES (?,?,?,?,?)')
          .run(sessionId, 'Файл распознан частично',
            `${f.original_name}: не распознаны страницы ${failedPages.map((x) => x.page || '—').join(', ')} (${failedPages[0].reason})`,
            'warn', now());
      } catch { /* журнал не критичен */ }
    }
  }
  return {
    files: targets.length, pages: pagesDone, failed, partial,
    by: [...usedAll],
    primary: modelKey(rec.primary),
    fellBack: rec.primary.kind === 'route' && usedAll.has(modelKey({ provider: 'lmstudio', model: config.localAiOcrModel })),
  };
}

/**
 * Какие страницы PDF отдать на OCR. Решение постраничное: страница без
 * текстового слоя — скан, даже если весь остальной файл текстовый.
 */
const PAGE_TEXT_MIN = 100; // символов на странице, ниже которых считаем её сканом

/** Номера страниц (с единицы), у которых текстового слоя фактически нет. */
function pagesNeedingOcr(pageTexts, min = PAGE_TEXT_MIN) {
  return (pageTexts || [])
    .map((t, i) => ({ p: i + 1, len: String(t || '').replace(/\s/g, '').length }))
    .filter((x) => x.len < min)
    .map((x) => x.p);
}

async function planPdfPages(f, cache, signal) {
  let pageTexts = null;
  try {
    pageTexts = await pdfPagesText(f.stored_path, signal);
  } catch (err) {
    if (err.name === 'AbortError' || (signal && signal.aborted)) throw err;
    console.warn('[doc-vision] pdftotext недоступен, решаю по файлу целиком:', err.message);
  }

  let need = [];
  let totalPages = 0;
  if (pageTexts && pageTexts.length) {
    totalPages = pageTexts.length;
    need = pagesNeedingOcr(pageTexts);
  } else {
    // запасной путь без poppler: старое решение по всему файлу
    const text = await extractPdfText(f.stored_path, 4000, { mark: false });
    if (text && text.trim().length >= 200) return null;
    try { totalPages = await pdfPageCount(f.stored_path, signal); } catch { totalPages = 1; }
    need = Array.from({ length: totalPages }, (_, i) => i + 1);
  }

  const already = new Set(cache.pages.keys());
  const rest = need.filter((p) => !already.has(p));
  const capped = rest.length > config.visionMaxPages;
  return {
    pages: rest.slice(0, config.visionMaxPages),
    needTotal: need.length,
    totalPages,
    capped,
  };
}

module.exports = {
  extractGraphics, readVisionCache, cacheNeedsWork,
  pdfPagesText, pdfPageCount, renderPdfPage, pagesNeedingOcr,
};
