'use strict';
const fs = require('fs');
const AdmZip = require('adm-zip');
const config = require('../../config');
const { db } = require('../../db');

const MAX_TEXT_DOC_CHARS = 60000;
// потолок вложения PDF у Anthropic; больше — не помещается в один запрос
const MAX_PDF_BYTES = 20 * 1024 * 1024;
// потолок вложения-картинки; больше — уменьшаем сами (см. shrinkImage)
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
// сторона, до которой ужимается слишком большая картинка (рекомендация Anthropic — 1568 px)
const SHRINK_MAX_SIDE = 1568;

/**
 * Обрезка текста с ЧЕСТНОЙ пометкой. Молчаливое `.slice()` было хуже потери
 * данных: документ выглядел целым, обрывался на полуслове, и модель делала
 * вывод «в ТЗ такого требования нет».
 */
function cut(text, limit, what = 'Текст документа') {
  const s = String(text || '');
  if (s.length <= limit) return s;
  return s.slice(0, limit) +
    `\n\n[⚠ ${what} ОБРЕЗАН по лимиту контекста: показано ${limit} из ${s.length} символов ` +
    `(${Math.round((limit / s.length) * 100)} %). Конец документа модели не передан — ` +
    'выводы «в документе этого нет» делать нельзя.]';
}

/**
 * Чтение текстового файла с определением кодировки.
 *
 * В российской проектной практике txt/csv в Windows-1251 — обычное дело, а
 * `readFileSync(path,'utf8')` превращал кириллицу в U+FFFD: модель получала
 * «??????? ??????? 1500 ?2» вместо требований, и заметить это по интерфейсу
 * было невозможно.
 */
function decodeText(buf) {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { text: buf.subarray(3).toString('utf8'), encoding: 'utf-8 (BOM)' };
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return { text: new TextDecoder('utf-16le').decode(buf.subarray(2)), encoding: 'utf-16le' };
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    return { text: new TextDecoder('utf-16be').decode(buf.subarray(2)), encoding: 'utf-16be' };
  }
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(buf), encoding: 'utf-8' };
  } catch {
    // не UTF-8: для кириллицы это почти всегда Windows-1251, реже KOI8-R
    for (const enc of ['windows-1251', 'koi8-r']) {
      try {
        const text = new TextDecoder(enc).decode(buf);
        if (!text.includes('�')) return { text, encoding: enc };
      } catch { /* декодер недоступен — следующий кандидат */ }
    }
    return { text: buf.toString('latin1'), encoding: 'latin1 (кодировку определить не удалось)' };
  }
}

function readTextFile(filePath) {
  return decodeText(fs.readFileSync(filePath));
}

function extractDocxText(filePath) {
  let entry;
  try {
    const zip = new AdmZip(filePath);
    entry = zip.getEntry('word/document.xml');
  } catch {
    return '';
  }
  if (!entry) return '';
  // размер проверяется ДО распаковки и не глотается: zip-бомба — это 422, а не «пустой текст»
  const data = require('../zip-guard').entryData(entry, 'DOCX');
  try {
    const xml = data.toString('utf8');
    return cut(xml
      .replace(/<w:p[ >]/g, '\n<')
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/\n{3,}/g, '\n\n')
      .trim(), MAX_TEXT_DOC_CHARS, 'Текст DOCX');
  } catch {
    return '';
  }
}

/**
 * Извлечение текстового слоя PDF (для моделей, которые не читают PDF сами).
 * mark=false — когда текст нужен только как признак «слой есть», а не для модели.
 */
async function extractPdfText(filePath, charLimit, { mark = true } = {}) {
  try {
    const pdfParse = require('pdf-parse');
    const data = await pdfParse(fs.readFileSync(filePath));
    const text = (data.text || '').replace(/\n{3,}/g, '\n\n').trim();
    return mark ? cut(text, charLimit, 'Текстовый слой PDF') : text.slice(0, charLimit);
  } catch {
    return '';
  }
}

/**
 * Уменьшение слишком большой картинки: она перерисовывается в SVG уже
 * существующим headless-браузером (services/render.js), поэтому отдельной
 * графической библиотеки не требуется, а браузер переиспользуется.
 * Возвращает { data, media_type } либо null, если ужать не вышло.
 */
async function shrinkImage(filePath, mediaType) {
  const buf = fs.readFileSync(filePath);
  const size = imageSize(buf);
  if (!size) return null;
  const k = Math.min(1, SHRINK_MAX_SIDE / Math.max(size.width, size.height));
  const w = Math.max(1, Math.round(size.width * k));
  const h = Math.max(1, Math.round(size.height * k));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
    `<image x="0" y="0" width="${w}" height="${h}" xlink:href="data:${mediaType};base64,${buf.toString('base64')}"/></svg>`;
  const png = await require('../render').svgToPng(svg, { width: w, height: h, scale: 1 });
  if (!png || png.length >= buf.length || png.length > MAX_IMAGE_BYTES) return null;
  return { data: png.toString('base64'), media_type: 'image/png', width: w, height: h };
}

/**
 * Постраничная растеризация PDF, который не влезает во вложение.
 * Модель, умеющая зрение, увидит настоящие страницы, а не одну строку текстового
 * слоя: для скана это единственный способ вообще донести содержимое.
 * Ограничено и числом страниц, и суммарным объёмом — иначе вместо 21 МБ PDF
 * уедут 60 МБ картинок.
 */
async function rasterizePdf(filePath, { maxPages = 20, maxBytes = 10 * 1024 * 1024, dpi = 150 } = {}) {
  const dv = require('../doc-vision'); // ленивый require: doc-vision сам зависит от memory
  let total;
  try { total = await dv.pdfPageCount(filePath, null); } catch { return null; }
  const pages = [];
  let bytes = 0;
  for (let p = 1; p <= Math.min(total, maxPages); p++) {
    let png;
    try { png = await dv.renderPdfPage(filePath, p, null, dpi); } catch { break; }
    if (!png || bytes + png.length > maxBytes) break;
    bytes += png.length;
    pages.push(png);
  }
  return pages.length ? { pages, total } : null;
}

/** Размер PNG/JPEG по заголовку — без внешних зависимостей. */
function imageSize(buf) {
  if (buf.length > 24 && buf[0] === 0x89 && buf.toString('latin1', 1, 4) === 'PNG') {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1];
      // SOF0…SOF15, кроме маркеров без размеров (C4, C8, CC)
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      }
      i += 2 + buf.readUInt16BE(i + 2);
    }
  }
  return null;
}

const mb = (bytes) => (bytes / 1048576).toFixed(1);

/**
 * Build content blocks describing session documents (untrusted data, clearly fenced).
 * mode 'native':    PDFs go as native document blocks, images as image blocks.
 * mode 'extracted': PDFs go as extracted text (scan without text layer -> honest note),
 *                   картинки — через кэш VLM-OCR.
 * Режим выбирает не бренд модели, а её возможности — см. services/ai/registry.js.
 */
async function buildDocumentBlocks(sessionId, mode = 'native', { onlyFileId = null, useDigest = true } = {}) {
  // 'anthropic'/'local' — исторические имена режимов, поддерживаются как синонимы
  const native = mode === 'native' || mode === 'anthropic';
  let files = db.prepare('SELECT * FROM files WHERE session_id = ? ORDER BY created_at').all(sessionId);
  if (onlyFileId) files = files.filter((f) => f.id === onlyFileId);
  const blocks = [];
  const manifest = [];
  // кэш «изучения документации»: распознанный vision-моделью текст (см. services/doc-vision.js).
  // Последняя строка кэша — служебная сводка в HTML-комментарии, модели она не нужна.
  const visionText = (f) => {
    try {
      const t = fs.readFileSync(f.stored_path + '.vision.md', 'utf8')
        .replace(/\n?<!--enso-vision:[\s\S]*?-->\s*$/, '').trim();
      return t ? cut(t, config.localAiDocCharLimit, 'Распознанный vision-моделью текст') : '';
    } catch { return ''; }
  };
  // кэш по-документного анализа: конспект, сделанный отдельным запросом (services/doc-digest.js)
  const digestText = (f) => {
    try {
      const t = fs.readFileSync(f.stored_path + '.digest.md', 'utf8').trim();
      return t ? cut(t, config.localAiDocCharLimit, 'Конспект документа') : '';
    } catch { return ''; }
  };
  for (const f of files) {
    manifest.push(`- ${f.original_name} (${f.ext}, ${Math.round(f.size / 1024)} КБ)`);
    try {
      if (useDigest) {
        const digest = digestText(f);
        if (digest) {
          blocks.push({
            type: 'text',
            text: `<uploaded_document name="${f.original_name}" untrusted="true" источник="конспект документа (по-документный анализ отдельным запросом)">\n${digest}\n</uploaded_document>`,
          });
          continue;
        }
      }
      if (f.ext === 'pdf' && !native) {
        const text = await extractPdfText(f.stored_path, config.localAiDocCharLimit);
        const goodText = text && text.trim().length >= 200;
        const vision = visionText(f);
        // Приоритет: текстовый слой → распознавание → короткий текст → заглушка.
        // Смешанный PDF (часть страниц — скан, часть — текст) отдаётся ОБОИМИ
        // источниками: раньше при наличии текстового слоя распознанные страницы
        // просто выбрасывались, и шапка ТЗ пропадала бесследно.
        let body; let source = '';
        if (goodText && vision) {
          body = `${text}\n\n---\n## Страницы без текстового слоя, распознанные vision-моделью\n${vision}`;
          source = ' источник="текстовый слой + распознавание сканированных страниц"';
        } else if (goodText) {
          body = text;
        } else if (vision) {
          body = vision;
          source = ' источник="распознано vision-моделью"';
        } else if (text) {
          // текстового слоя почти нет и распознать не удалось — молчать нельзя
          body = `(⚠ Текстовый слой PDF почти пуст (${text.trim().length} симв.) — это скан, и распознать его не удалось. ` +
            'Ниже всё, что извлеклось; основное содержимое документа в анализе НЕ учтено.)\n\n' + text;
        } else {
          body = '(⚠ PDF без текстового слоя — скан; распознать содержимое не удалось. В анализе файл НЕ учтён, учитывай только метаданные.)';
        }
        blocks.push({
          type: 'text',
          text: `<uploaded_document name="${f.original_name}" untrusted="true"${source}>\n${body}\n</uploaded_document>`,
        });
      } else if (['png', 'jpg', 'jpeg'].includes(f.ext) && !native) {
        const vision = visionText(f);
        blocks.push({
          type: 'text',
          text: vision
            ? `<uploaded_document name="${f.original_name}" untrusted="true" источник="изображение, распознано vision-моделью">\n${vision}\n</uploaded_document>`
            // молчать нельзя: раньше нераспознанная картинка исчезала из контекста,
            // и модель отвечала так, будто файла не существует
            : `<uploaded_document name="${f.original_name}" untrusted="true" источник="изображение, НЕ передано модели">\n` +
              '(⚠ Изображение не передано: выбранная модель не умеет работать с картинками, а распознать его vision-моделью не удалось. ' +
              'Содержимое этого файла в анализе НЕ учтено.)\n</uploaded_document>',
        });
      } else if (f.ext === 'pdf' && f.size <= MAX_PDF_BYTES) {
        const data = fs.readFileSync(f.stored_path).toString('base64');
        blocks.push({
          type: 'document',
          source: { type: 'base64', media_type: 'application/pdf', data },
          title: f.original_name,
        });
      } else if (f.ext === 'pdf') {
        // PDF крупнее потолка вложения (загрузка принимает до 25 МБ, а вложением
        // уходит не больше 20 МБ). Раньше такой файл просто не попадал в blocks —
        // ни ошибки, ни пометки. Теперь он доходит: страницами-картинками, а
        // если растеризовать не вышло — текстом, и всегда с честной пометкой.
        const text = await extractPdfText(f.stored_path, config.localAiDocCharLimit);
        const vision = visionText(f);
        let raster = null;
        try { raster = await rasterizePdf(f.stored_path); } catch (err) {
          console.warn('[memory] растеризовать крупный PDF не удалось:', err.message);
        }
        const head = `(⚠ Файл ${mb(f.size)} МБ — больше потолка вложения ${mb(MAX_PDF_BYTES)} МБ, поэтому сам PDF модели не передан.`;
        const body = [text, vision && `## Распознано vision-моделью\n${vision}`].filter(Boolean).join('\n\n---\n');
        if (raster) {
          blocks.push({
            type: 'text',
            text: `<uploaded_document name="${f.original_name}" untrusted="true" источник="крупный PDF, страницы приложены картинками">\n` +
              `${head} Ниже приложены его страницы в виде изображений: ${raster.pages.length} из ${raster.total}` +
              `${raster.pages.length < raster.total ? ' — остальные не поместились в лимит запроса' : ''}.)\n\n` +
              (body || '(Текстового слоя у файла нет — смотри приложенные страницы.)') +
              '\n</uploaded_document>',
          });
          for (const png of raster.pages) {
            blocks.push({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: png.toString('base64') } });
          }
        } else {
          blocks.push({
            type: 'text',
            text: `<uploaded_document name="${f.original_name}" untrusted="true" источник="крупный PDF, передан текстом">\n` +
              `${head} Ниже — извлечённое из него содержимое; иллюстрации и вёрстка потеряны.)\n\n` +
              (body || '(⚠ Извлечь содержимое не удалось: ни текстового слоя, ни распознавания. Файл в анализе НЕ учтён.)') +
              '\n</uploaded_document>',
          });
        }
      } else if (f.ext === 'dwg' || f.ext === 'dxf') {
        // CAD-чертёж: компактная выжимка (слои, надписи, блоки, габариты) вместо
        // сырого дампа; DWG предварительно конвертируется в DXF (dwg2dxf)
        let summary = '';
        try {
          summary = await require('../cad').extractCad(f.stored_path, f.ext, f.original_name);
        } catch (err) {
          // DXF из AutoCAD часто в Windows-1251 — читаем с определением кодировки
          summary = f.ext === 'dxf'
            ? cut(readTextFile(f.stored_path).text, MAX_TEXT_DOC_CHARS, 'Сырой DXF')
            : `(разобрать DWG не удалось: ${String(err.message || '').slice(0, 150)})`;
        }
        blocks.push({
          type: 'text',
          text: `<uploaded_document name="${f.original_name}" untrusted="true" источник="выжимка из CAD-чертежа">\n${summary}\n</uploaded_document>`,
        });
      } else if (['txt', 'md', 'json', 'csv'].includes(f.ext)) {
        const { text, encoding } = readTextFile(f.stored_path);
        const encNote = /utf-8$/.test(encoding) ? '' : ` кодировка="${encoding}"`;
        blocks.push({
          type: 'text',
          text: `<uploaded_document name="${f.original_name}" untrusted="true"${encNote}>\n${cut(text, MAX_TEXT_DOC_CHARS)}\n</uploaded_document>`,
        });
      } else if (f.ext === 'docx') {
        const text = extractDocxText(f.stored_path);
        blocks.push({
          type: 'text',
          text: `<uploaded_document name="${f.original_name}" untrusted="true">\n${text || '(⚠ Текст DOCX извлечь не удалось — файл в анализе НЕ учтён.)'}\n</uploaded_document>`,
        });
      } else if (['png', 'jpg', 'jpeg'].includes(f.ext) && native) {
        const media = f.ext === 'png' ? 'image/png' : 'image/jpeg';
        if (f.size <= MAX_IMAGE_BYTES) {
          blocks.push({
            type: 'image',
            source: { type: 'base64', media_type: media, data: fs.readFileSync(f.stored_path).toString('base64') },
          });
        } else {
          // Картинка больше потолка вложения: сначала пробуем ужать её сами
          // (раньше файл молча исчезал из контекста — ни ошибки, ни пометки).
          let small = null;
          try { small = await shrinkImage(f.stored_path, media); } catch (err) {
            console.warn('[memory] уменьшить изображение не удалось:', err.message);
          }
          if (small) {
            blocks.push({
              type: 'text',
              text: `<uploaded_document name="${f.original_name}" untrusted="true" источник="изображение, уменьшено">\n` +
                `(Файл ${mb(f.size)} МБ больше потолка вложения ${mb(MAX_IMAGE_BYTES)} МБ — передан уменьшенной копией ${small.width}×${small.height}. ` +
                'Мелкие подписи могли стать нечитаемыми.)\n</uploaded_document>',
            });
            blocks.push({ type: 'image', source: { type: 'base64', media_type: small.media_type, data: small.data } });
          } else {
            blocks.push({
              type: 'text',
              text: `<uploaded_document name="${f.original_name}" untrusted="true" источник="изображение, НЕ передано модели">\n` +
                `(⚠ Изображение ${mb(f.size)} МБ больше потолка вложения ${mb(MAX_IMAGE_BYTES)} МБ, и уменьшить его не удалось. ` +
                'Содержимое файла в анализе НЕ учтено — сохраните картинку меньшего размера и загрузите заново.)\n</uploaded_document>',
            });
          }
        }
      }
      // oversized files: metadata only (already in manifest)
    } catch (err) {
      // Файл нечитаем — но молчать нельзя: в манифесте он есть, и модель решит,
      // что просто не нашла в нём нужного.
      blocks.push({
        type: 'text',
        text: `<uploaded_document name="${f.original_name}" untrusted="true" источник="прочитать не удалось">\n` +
          `(⚠ Файл не прочитан: ${String(err && err.message || '').slice(0, 150)}. В анализе НЕ учтён.)\n</uploaded_document>`,
      });
    }
  }
  return { blocks, manifest };
}

/**
 * Working context for the model:
 *  full history lives in SQLite; the model gets summary + facts + Q&A + recent messages + documents.
 */
/**
 * Пометки человека на плане: выделенные области с комментариями и исправленные
 * свойства объектов.
 *
 * Это самые достоверные сведения из всех, что есть у модели: их дал человек,
 * глядя на чертёж. Поэтому в промпте они идут отдельным разделом с прямым
 * указанием, что они важнее догадок разбора, — иначе модель снова напишет, что
 * границей участка является контур покрытия 72 м², хотя человек уже исправил.
 *
 * Координаты области приводятся в системе плана: без них «здесь нельзя строить»
 * не привязано ни к чему.
 */
function planNotesText(sessionId) {
  const G = require('../geometry/site-geometry');
  const parts = [];

  let annotations = [];
  try { annotations = require('../geometry/annotations').list(sessionId); } catch { /* таблицы может не быть */ }
  const withComment = annotations.filter((a) => (a.comment || '').trim());
  if (withComment.length) {
    const lines = withComment.map((a) => {
      const pts = (a.geometry && a.geometry.points) || [];
      const b = pts.length ? G.bounds(pts) : null;
      const area = pts.length >= 3 ? Math.round(G.polygonArea(pts)) : 0;
      const where = b
        ? `область X ${Math.round(b.minX)}…${Math.round(b.maxX)}, Y ${Math.round(b.minY)}…${Math.round(b.maxY)}` +
          (area ? `, ≈${area} м²` : '')
        : 'область без координат';
      return `- [${where}] ${a.comment.trim()}${a.author ? ` (${a.author})` : ''}`;
    });
    parts.push('## Пометки человека на плане участка\n' +
      'Это указания заказчика по конкретным местам чертежа. Учитывай их в анализе и ссылайся на них.\n' +
      lines.join('\n'));
  }

  let edits = [];
  try { edits = require('../geometry/object-edits').list(sessionId); } catch { /* таблицы может не быть */ }
  if (edits.length) {
    const layers = require('../geometry/layers');
    const nameOf = (id) => (layers.get(id) ? layers.get(id).label : id);
    const rel = { keep: 'остаётся на месте', move: 'переносится', undecided: 'решение не принято' };
    const lines = edits.map((e) => {
      const p = e.patch || {};
      const src = e.parser || {};
      const bits = [];
      if (p.type) bits.push(`это ${nameOf(p.type)}, а НЕ ${nameOf(src.type)} (так решил разбор чертежа)`);
      if (p.label) bits.push(`назначение: ${p.label}`);
      if (p.relocation) bits.push(rel[p.relocation] || p.relocation);
      if (p.comment) bits.push(`комментарий: ${p.comment}`);
      return `- Объект со слоя «${src.sourceLayer || '—'}» (${src.geometry && src.geometry.areaM2 ? `${src.geometry.areaM2} м²` : 'линейный'}): ` +
        bits.join('; ');
    });
    parts.push('## Исправления объектов плана, сделанные человеком\n' +
      'Разбор чертежа определяет тип объекта по имени слоя и ошибается. Ниже — что человек ИСПРАВИЛ, ' +
      'глядя на план. Эти сведения ВАЖНЕЕ того, что говорит разбор: опирайся на них, а не на исходную догадку.\n' +
      lines.join('\n'));
  }

  return parts.join('\n\n');
}

async function buildContext(sessionId, mode = 'native') {
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
  const facts = db.prepare('SELECT key, value, source FROM facts WHERE session_id = ? ORDER BY created_at').all(sessionId);
  const questions = db.prepare('SELECT text, why, status, answer FROM questions WHERE session_id = ? ORDER BY created_at').all(sessionId);
  const allMessages = db.prepare(
    "SELECT role, kind, content, created_at FROM messages WHERE session_id = ? AND kind != 'error' ORDER BY created_at",
  ).all(sessionId);
  const recent = allMessages.slice(-config.recentMessagesInContext);

  const { blocks: docBlocks, manifest } = await buildDocumentBlocks(sessionId, mode);

  const stateParts = [];
  if (session.summary) stateParts.push(`## Резюме предыдущей части диалога\n${session.summary}`);
  if (session.comment) stateParts.push(`## Комментарий пользователя к исходным данным\n${session.comment}`);
  if (manifest.length) stateParts.push(`## Загруженные файлы\n${manifest.join('\n')}`);
  if (facts.length) {
    stateParts.push('## Ранее извлечённые факты\n' + facts.map((f) => `- ${f.key} = ${f.value} (${f.source})`).join('\n'));
  }
  const answered = questions.filter((q) => q.status === 'answered' || q.answer);
  if (answered.length) {
    stateParts.push('## Ответы пользователя на уточняющие вопросы\n' +
      answered.map((q) => `- Вопрос: ${q.text}\n  Ответ: ${q.answer}`).join('\n'));
  }
  const pending = questions.filter((q) => q.status === 'pending');
  if (pending.length) {
    stateParts.push('## Вопросы, ещё ожидающие ответа (не задавай их повторно)\n' + pending.map((q) => `- ${q.text}`).join('\n'));
  }

  // Пометки на плане и правки объектов — САМЫЕ достоверные сведения в контексте:
  // это сказал человек, глядя на чертёж. Без них выходило «написал комментарий,
  // запустил анализ — ничего не изменилось»: пометки жили только на плане.
  const planNotes = planNotesText(sessionId);
  if (planNotes) stateParts.push(planNotes);

  const history = recent.map((m) => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: m.kind === 'comment' ? `[Комментарий к данным] ${m.content}` :
      m.kind === 'answer' ? `[Ответ на уточняющий вопрос] ${m.content}` : m.content,
  }));

  return { session, stateText: stateParts.join('\n\n'), docBlocks, history, messagesTotal: allMessages.length };
}

module.exports = {
  buildContext, planNotesText, buildDocumentBlocks, extractDocxText, extractPdfText,
  decodeText, readTextFile, cut, imageSize,
  MAX_TEXT_DOC_CHARS, MAX_PDF_BYTES, MAX_IMAGE_BYTES,
};
