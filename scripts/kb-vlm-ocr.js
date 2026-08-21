'use strict';
/**
 * VLM-OCR проблемных документов базы знаний.
 *
 * Рендерит страницы PDF (pdftoppm) и распознаёт их vision-моделью в Markdown
 * с настоящими таблицами. Результат:
 *   - KB_DIR/12_VLM-OCR/<Документ>/p<NNN>.md — постраничный текст;
 *   - чанки с приоритетом "высокий (VLM)" добавляются в
 *     KB_DIR/09_Векторный-индекс/<Документ>/чанки.jsonl (старый файл — в .bak).
 *
 * Транспорта два, выбор через --provider:
 *   claude    — Anthropic API, по умолчанию claude-sonnet-5. Страницы идут
 *               параллельно (--concurrency), локальная память не занята.
 *   lmstudio  — прежний путь через qwen3-vl. Строго последовательно и с
 *               автопаузой: LM Studio держит один слот, и параллельный вызов
 *               выбивает модель из памяти на середине очереди.
 *
 * Сессионный adapter.plainCall сюда не подходит намеренно: он привязан к
 * проекту (бюджет, счётчики в sessions, гейт облачного доступа), а это
 * пакетная обработка базы знаний, у которой проекта нет.
 *
 * Запуск: node --env-file-if-exists=.env scripts/kb-vlm-ocr.js \
 *   --doc "СП 4.13130.2013" --pdf "/путь/к.pdf" --pages 30-36,193-196 \
 *   [--provider claude] [--model claude-sonnet-5] [--concurrency 4] [--dpi 170]
 * После всех документов: npm run kb:index
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
process.chdir(path.join(__dirname, '..'));
const config = require('../server/config');
const prompts = require('../server/services/prompts');

function parseArgs() {
  const a = process.argv.slice(2);
  const get = (k) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : null; };
  const doc = get('--doc'), pdf = get('--pdf'), pages = get('--pages');
  const dpi = parseInt(get('--dpi') || '170', 10);
  const provider = (get('--provider') || 'claude').toLowerCase();
  const model = get('--model') || (provider === 'claude' ? 'claude-sonnet-5' : config.localAiOcrModel);
  // у LM Studio один слот: параллель там не ускоряет, а выбивает модель из памяти
  const concurrency = provider === 'claude' ? Math.max(1, parseInt(get('--concurrency') || '4', 10)) : 1;
  if (!doc || !pdf || !pages) {
    console.error('Нужно: --doc <имя> --pdf <путь> --pages 30-36,193-196'); process.exit(2);
  }
  if (!['claude', 'lmstudio'].includes(provider)) {
    console.error(`Неизвестный --provider «${provider}»: доступны claude, lmstudio`); process.exit(2);
  }
  if (provider === 'claude' && !config.anthropicApiKey) {
    console.error('Нужен ANTHROPIC_API_KEY в .env (или --provider lmstudio)'); process.exit(2);
  }
  const list = [];
  for (const part of pages.split(',')) {
    const [from, to] = part.split('-').map(Number);
    for (let p = from; p <= (to || from); p++) list.push(p);
  }
  return { doc, pdf, pages: list, dpi, provider, model, concurrency };
}

function renderPage(pdf, page, dpi) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vlmocr-'));
  const prefix = path.join(tmp, 'p');
  execFileSync('pdftoppm', ['-f', String(page), '-l', String(page), '-r', String(dpi), '-png', pdf, prefix]);
  const file = fs.readdirSync(tmp).find((f) => f.endsWith('.png'));
  const buf = fs.readFileSync(path.join(tmp, file));
  fs.rmSync(tmp, { recursive: true, force: true });
  return buf;
}

/**
 * Автопауза: пока сервер выполняет интерактивный анализ (logs/interactive.lock
 * свежее 2 минут), очередь не трогает LM Studio — иначе модели вытесняют друг
 * друга из памяти и пользователь получает ошибки 400 «Model unloaded».
 */
const INTERACTIVE_LOCK = path.join('logs', 'interactive.lock');
async function waitWhileInteractive() {
  let announced = false;
  for (;;) {
    let fresh = false;
    try {
      const age = Date.now() - fs.statSync(INTERACTIVE_LOCK).mtimeMs;
      fresh = age < 120000;
    } catch { /* флага нет */ }
    if (!fresh) {
      if (announced) console.log('  автопауза снята — пользовательский анализ завершён, продолжаю');
      return;
    }
    if (!announced) { console.log('  автопауза: идёт пользовательский анализ — очередь ждёт…'); announced = true; }
    await new Promise((r) => setTimeout(r, 10000));
  }
}

/**
 * Правила расшифровки. Пункты 6–8 добавлены под разбивку базы знаний: структура
 * документа собирается ИЗ ЭТОГО текста, поэтому номер пункта, граница приложения
 * и содержимое ячейки с рисунком обязаны быть в нём различимы. Прежний парсер
 * читал слой pdftotext, и оттуда приходило «п. 20 = 20 июня 2022 года».
 */

/** Расшифровка страницы через Anthropic API — пакетный путь, без сессии и бюджета проекта. */
let _anthropic = null;
async function ocrPageClaude(png, model) {
  if (!_anthropic) {
    const Anthropic = require('@anthropic-ai/sdk');
    _anthropic = new Anthropic({
      apiKey: config.anthropicApiKey,
      timeout: config.anthropicRequestTimeoutMs,
      maxRetries: config.anthropicMaxRetries, // 429 и 5xx SDK повторяет сам
    });
  }
  const res = await _anthropic.messages.create({
    model,
    max_tokens: 8000,
    // temperature не задаём: Sonnet 5 отвечает на неё 400 «deprecated for this model»
    system: prompts.load('kb-ocr'),
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png.toString('base64') } },
        { type: 'text', text: 'Расшифруй эту страницу по правилам выше.' },
      ],
    }],
  });
  return {
    text: res.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim(),
    truncated: res.stop_reason === 'max_tokens',
    usage: res.usage || {},
  };
}

async function ocrPage(png, attempt = 1) {
  const res = await fetch(`${config.localAiBaseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: config.localAiOcrModel,
      max_tokens: 6000,
      temperature: 0,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: prompts.load('kb-ocr') },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${png.toString('base64')}` } },
        ],
      }],
    }),
    signal: AbortSignal.timeout(600000),
  });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 200);
    if (/unload|not loaded|no models? loaded/i.test(detail) && attempt <= 4) {
      console.log(`  модель выгружена — повтор ${attempt}/4 (явная загрузка)`);
      await waitWhileInteractive();
      try {
        await require('../server/services/model-manager').ensureLoaded(config.localAiOcrModel, {
          onProgress: (t) => console.log(`  ${t}`),
        });
      } catch { await new Promise((r) => setTimeout(r, attempt * 20000)); }
      return ocrPage(png, attempt + 1);
    }
    throw new Error(`VLM HTTP ${res.status}: ${detail}`);
  }
  const data = await res.json();
  return {
    text: data.choices?.[0]?.message?.content || '',
    truncated: data.choices?.[0]?.finish_reason === 'length',
    tokens: data.usage?.completion_tokens || 0,
  };
}

/** Разбивка страницы на чанки по пунктам и таблицам; крупные куски режутся по ~1300 симв. */
function chunkPage(doc, page, md) {
  const parts = md.split(/(?=^#{0,3}\s*(?:\d+\.\d+(?:\.\d+)*\s|Таблица\s+\d))/m).filter((s) => s.trim().length > 60);
  const chunks = [];
  for (const part of parts.length ? parts : [md]) {
    const clauseMatch = part.match(/^#{0,3}\s*(\d+(?:\.\d+)+)/) || part.match(/^#{0,3}\s*Таблица\s+([\d.]+)/i);
    const clause = clauseMatch ? (part.trimStart().toLowerCase().startsWith('#') || /^таблица/i.test(part.trim()) ? `табл. ${clauseMatch[1]}` : clauseMatch[1]) : `стр. ${page}`;
    const text = part.replace(/\s+\n/g, '\n').trim();
    for (let i = 0; i < text.length; i += 1300) {
      chunks.push({
        'чанк_id': `${doc} VLM p${page}-${chunks.length + 1}`,
        'документ': doc,
        'пункт': /^таблица/i.test(part.trim()) ? `табл. ${clauseMatch ? clauseMatch[1] : ''}`.trim() : clause,
        'страница': page,
        'текст': text.slice(i, i + 1300 + 200), // перекрытие 200 симв. для таблиц
        'приоритет': 'высокий (VLM)',
        'источник': 'vlm-ocr',
      });
    }
  }
  return chunks;
}

(async () => {
  const { doc, pdf, pages, dpi, provider, model, concurrency } = parseArgs();
  if (!config.kbDir) { console.error('KB_DIR не задан'); process.exit(2); }
  if (provider === 'lmstudio') {
    // vision-модель загружается явно, с умеренным контекстом (странице OCR больше не нужно)
    try {
      await require('../server/services/model-manager').ensureLoaded(model, {
        onProgress: (t) => console.log(`  ${t}`),
      });
    } catch (err) { console.log(`  (модель загрузится по запросу: ${err.message})`); }
  }
  const outDir = path.join(config.kbDir, '12_VLM-OCR', doc);
  fs.mkdirSync(outDir, { recursive: true });
  const allChunks = [];

  const todo = pages.filter((page) => {
    const f = path.join(outDir, `p${String(page).padStart(3, '0')}.md`);
    return !(fs.existsSync(f) && fs.statSync(f).size > 0);
  });
  const skipped = pages.length - todo.length;
  console.log(`${doc}: ${todo.length} стр. к распознаванию${skipped ? `, ${skipped} уже готовы` : ''} — ${provider}/${model}${concurrency > 1 ? `, по ${concurrency} параллельно` : ''}`);

  const totals = { input: 0, output: 0, cost: 0, failed: [] };
  let done = 0;

  async function processPage(page) {
    const outFile = path.join(outDir, `p${String(page).padStart(3, '0')}.md`);
    // автопауза только для локального пути: облако с LM Studio за память не спорит
    if (provider === 'lmstudio') await waitWhileInteractive();
    const t0 = Date.now();
    const png = renderPage(pdf, page, dpi);
    const { text, truncated, usage } = provider === 'claude'
      ? await ocrPageClaude(png, model)
      : await ocrPage(png);
    if (truncated) console.log(`  ! стр. ${page}: ответ упёрся в лимит, текст может быть неполным`);
    fs.writeFileSync(outFile, text);
    if (usage) {
      totals.input += (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0);
      totals.output += usage.output_tokens || 0;
      totals.cost += require('../server/services/pricing').costUsd(provider, model, usage);
    }
    done += 1;
    console.log(`стр. ${page}: ${text.length} симв., ${(Date.now() - t0) / 1000 | 0} с  [${done}/${todo.length}]`);
  }

  // Пул воркеров вместо Promise.all по всему списку: на документе в 400 страниц
  // разом улетело бы 400 запросов, и API ответил бы лимитом, а не расшифровкой.
  const queue = todo.slice();
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    for (;;) {
      const page = queue.shift();
      if (page === undefined) return;
      try {
        await processPage(page);
      } catch (err) {
        // одна страница не должна ронять прогон: остальные распознаются,
        // а недостающие подберёт следующий запуск — он идемпотентен
        totals.failed.push(page);
        console.error(`  !! стр. ${page}: ${err.message}`);
      }
    }
  }));

  if (totals.failed.length) {
    console.error(`не распозналось страниц: ${totals.failed.length} (${totals.failed.slice(0, 20).join(', ')}) — повторный запуск возьмёт только их`);
  }
  if (totals.cost) {
    console.log(`токены: вход ${totals.input}, выход ${totals.output}; стоимость $${totals.cost.toFixed(2)}`);
  }

  // чанки пересобираются из ВСЕХ распознанных страниц документа — запуск идемпотентен
  for (const f of fs.readdirSync(outDir).filter((n) => /^p\d+\.md$/.test(n)).sort()) {
    const page = parseInt(f.slice(1), 10);
    const text = fs.readFileSync(path.join(outDir, f), 'utf8');
    if (text.trim()) allChunks.push(...chunkPage(doc, page, text));
  }

  // добавляем чанки в векторный индекс базы (с резервной копией)
  const vecDir = path.join(config.kbDir, '09_Векторный-индекс', doc);
  fs.mkdirSync(vecDir, { recursive: true });
  const jsonl = path.join(vecDir, 'чанки.jsonl');
  if (fs.existsSync(jsonl) && !fs.existsSync(jsonl + '.bak')) fs.copyFileSync(jsonl, jsonl + '.bak');
  const existing = fs.existsSync(jsonl)
    ? fs.readFileSync(jsonl, 'utf8').split('\n').filter((l) => l && !l.includes('"vlm-ocr"'))
    : [];
  const lines = existing.concat(allChunks.map((c) => JSON.stringify(c)));
  fs.writeFileSync(jsonl, lines.join('\n') + '\n');
  console.log(`Готово: ${doc} — ${allChunks.length} VLM-чанков добавлено в чанки.jsonl (${lines.length} всего). Теперь: npm run kb:index`);
})().catch((err) => { console.error('Ошибка:', err.message); process.exit(1); });
