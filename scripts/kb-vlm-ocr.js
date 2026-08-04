'use strict';
/**
 * VLM-OCR проблемных документов базы знаний.
 *
 * Рендерит страницы PDF (pdftoppm) и распознаёт их vision-моделью LM Studio
 * (qwen3-vl) в Markdown с настоящими таблицами. Результат:
 *   - KB_DIR/12_VLM-OCR/<Документ>/p<NNN>.md — постраничный текст;
 *   - чанки с приоритетом "высокий (VLM)" добавляются в
 *     KB_DIR/09_Векторный-индекс/<Документ>/чанки.jsonl (старый файл — в .bak).
 *
 * Запуск: node --env-file-if-exists=.env scripts/kb-vlm-ocr.js \
 *   --doc "СП 4.13130.2013" --pdf "/путь/к.pdf" --pages 30-36,193-196 [--dpi 170]
 * После всех документов: npm run kb:index
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
process.chdir(path.join(__dirname, '..'));
const config = require('../server/config');

function parseArgs() {
  const a = process.argv.slice(2);
  const get = (k) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : null; };
  const doc = get('--doc'), pdf = get('--pdf'), pages = get('--pages');
  const dpi = parseInt(get('--dpi') || '170', 10);
  if (!doc || !pdf || !pages) {
    console.error('Нужно: --doc <имя> --pdf <путь> --pages 30-36,193-196'); process.exit(2);
  }
  const list = [];
  for (const part of pages.split(',')) {
    const [from, to] = part.split('-').map(Number);
    for (let p = from; p <= (to || from); p++) list.push(p);
  }
  return { doc, pdf, pages: list, dpi };
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

const OCR_PROMPT =
  'Расшифруй эту страницу российского нормативного документа в Markdown максимально дословно. Требования: ' +
  '1) ВСЕ таблицы — строго в формате Markdown-таблиц с шапкой и разделителем, сохраняя объединённые смыслы ячеек словами; ' +
  '2) сохраняй номера пунктов (например 6.1.2) и заголовки «Таблица N — …»; ' +
  '3) сноски и примечания — после таблицы; 4) колонтитулы и номера страниц опусти; ' +
  '5) не добавляй никаких комментариев от себя — только содержимое страницы. Язык — русский.';

async function ocrPage(png) {
  const res = await fetch(`${config.localAiBaseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: config.localAiModel,
      max_tokens: 6000,
      temperature: 0,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: OCR_PROMPT },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${png.toString('base64')}` } },
        ],
      }],
    }),
    signal: AbortSignal.timeout(600000),
  });
  if (!res.ok) throw new Error(`VLM HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
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
  const { doc, pdf, pages, dpi } = parseArgs();
  if (!config.kbDir) { console.error('KB_DIR не задан'); process.exit(2); }
  const outDir = path.join(config.kbDir, '12_VLM-OCR', doc);
  fs.mkdirSync(outDir, { recursive: true });
  const allChunks = [];

  for (const page of pages) {
    const t0 = Date.now();
    const png = renderPage(pdf, page, dpi);
    let { text, truncated } = await ocrPage(png);
    if (truncated) console.log(`  ! стр. ${page}: ответ упёрся в лимит, текст может быть неполным`);
    fs.writeFileSync(path.join(outDir, `p${String(page).padStart(3, '0')}.md`), text);
    const chunks = chunkPage(doc, page, text);
    allChunks.push(...chunks);
    console.log(`стр. ${page}: ${text.length} симв., чанков ${chunks.length}, ${(Date.now() - t0) / 1000 | 0} с`);
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
