'use strict';
/**
 * По-документный анализ («каждый документ — отдельный запрос»): объёмные
 * документы конспектируются моделью по одному, конспект кэшируется рядом с
 * файлом (<файл>.digest.md). Итоговый анализ получает конспекты вместо полных
 * текстов — так обходятся лимиты контекста и выходных токенов модели.
 */
const fs = require('fs');
const prompts = require('./prompts');

module.exports = { ensureDigests };

// мелкие документы не конспектируем — они идут в контекст целиком без потерь
const MIN_CHARS = 3000;
// конспект намеренно компактный: это карта документа, а не пересказ
const DIGEST_MAX_TOKENS = 3000;

function digestPath(f) { return f.stored_path + '.digest.md'; }

/**
 * Конспект годен, пока он новее исходников. Распознавание страниц может
 * дополниться позже (сбой vision больше не кэшируется навсегда, см. doc-vision):
 * если кэш распознавания обновился, старый конспект описывает уже не тот
 * документ — и переписать его надо, иначе неполнота останется навсегда.
 */
function digestIsFresh(f) {
  let made;
  try { made = fs.statSync(digestPath(f)).mtimeMs; } catch { return false; }
  for (const src of [f.stored_path, f.stored_path + '.vision.md']) {
    try { if (fs.statSync(src).mtimeMs > made) return false; } catch { /* источника нет — не мешает */ }
  }
  return true;
}

/** Объём содержимого: длина текстов; native-PDF/изображения считаем большими. */
function blocksSize(blocks) {
  return blocks.reduce((s, b) => s + (b.type === 'text' ? b.text.length : 200000), 0);
}

/**
 * Гарантирует конспекты для всех объёмных документов сессии (по одному запросу
 * на документ, с кэшем). Возвращает { files, made }.
 */
async function ensureDigests(sessionId, { route, signal, onProgress }) {
  const adapter = require('./claude/adapter');
  const { buildDocumentBlocks } = require('./claude/memory');
  const { db } = require('../db');
  const files = db.prepare('SELECT * FROM files WHERE session_id = ? ORDER BY created_at').all(sessionId);
  const docMode = require('./ai/registry').documentMode(route);
  let made = 0;
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    if (signal && signal.aborted) throw Object.assign(new Error('Обработка прервана'), { name: 'AbortError' });
    if (digestIsFresh(f)) continue;
    const { blocks } = await buildDocumentBlocks(sessionId, docMode, { onlyFileId: f.id, useDigest: false });
    if (!blocks.length || blocksSize(blocks) < MIN_CHARS) continue;

    const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
    adapter.checkBudget(session);
    if (onProgress) onProgress(`Документ ${i + 1}/${files.length}: «${f.original_name}» — отдельный запрос-конспект`);
    const out = await adapter.plainCall({
      system: prompts.load('doc-digest'),
      messages: [
        { role: 'user', content: blocks },
        { role: 'user', content: `Составь конспект документа «${f.original_name}».` },
      ],
      sessionId, route, signal, maxTokens: DIGEST_MAX_TOKENS,
      internal: true, // конспект документа — служебный запрос, см. adapter.checkBudget
    });
    const text = (out.text || '').trim();
    if (text) {
      fs.writeFileSync(digestPath(f), text);
      made++;
    }
  }
  return { files: files.length, made };
}
