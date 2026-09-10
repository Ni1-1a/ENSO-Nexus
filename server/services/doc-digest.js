'use strict';
/**
 * По-документный анализ («каждый документ — отдельный запрос»): объёмные
 * документы конспектируются моделью по одному, конспект кэшируется рядом с
 * файлом (<файл>.digest.md). Итоговый анализ получает конспекты вместо полных
 * текстов — так обходятся лимиты контекста и выходных токенов модели.
 */
const fs = require('fs');
const config = require('../config');
const prompts = require('./prompts');

module.exports = { ensureDigests };

// мелкие документы не конспектируем — они идут в контекст целиком без потерь
const MIN_CHARS = 3000;
// конспект намеренно компактный: это карта документа, а не пересказ
const DIGEST_MAX_TOKENS = 3000;
// запас на размышления думающей модели при повторе конспекта
const REASONING_ALLOWANCE = 5000;
// память о неудачных конспектах: файл + маршрут → когда не вышло; два часа
const recentFailures = new Map();
const FAILURE_MEMORY_MS = 2 * 60 * 60 * 1000;

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
  let skippedNoted = false;
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    if (signal && signal.aborted) throw Object.assign(new Error('Обработка прервана'), { name: 'AbortError' });
    if (digestIsFresh(f)) continue;
    const { blocks } = await buildDocumentBlocks(sessionId, docMode, { onlyFileId: f.id, useDigest: false });
    if (!blocks.length || blocksSize(blocks) < MIN_CHARS) continue;

    // неудача помнится на время: иначе каждый повтор анализа снова гонял бы
    // многоминутный запрос-конспект, который уже вернул пустоту
    const routeKey = `${route.provider}|${route.model || ''}`;
    const failKey = `${f.id}|${routeKey}`;
    const failedAt = recentFailures.get(failKey) || 0;
    if (Date.now() - failedAt < FAILURE_MEMORY_MS) continue;
    /*
     * Модель, ушедшая в размышления на первом документе, уйдёт в них и на
     * остальных: живой прогон 09.09.2026 — три документа по семь минут, ноль
     * конспектов. Дальше по этой модели документы не конспектируются два часа,
     * и об этом сказано один раз.
     */
    const routeFailedAt = recentFailures.get(routeKey) || 0;
    if (Date.now() - routeFailedAt < FAILURE_MEMORY_MS) {
      if (!skippedNoted) {
        skippedNoted = true;
        try {
          db.prepare('INSERT INTO events (session_id, stage, detail, level, created_at) VALUES (?,?,?,?,?)')
            .run(sessionId, 'Конспекты документов пропущены',
              `модель ${route.provider}${route.model ? ` (${route.model})` : ''} на этом прогоне уходит в размышления вместо конспекта — `
              + 'остальные документы уйдут в анализ полным текстом в пределах окна модели (два часа повторных попыток не будет).',
              'warn', new Date().toISOString());
        } catch { /* журнал не критичен */ }
      }
      continue;
    }

    const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
    adapter.checkBudget(session);
    if (onProgress) onProgress(`Документ ${i + 1}/${files.length}: «${f.original_name}» — отдельный запрос-конспект`);
    const ask = (maxTokens) => adapter.plainCall({
      system: prompts.load('doc-digest'),
      messages: [
        { role: 'user', content: blocks },
        { role: 'user', content: `Составь конспект документа «${f.original_name}».` },
      ],
      sessionId, route, signal, maxTokens,
      internal: true, // конспект документа — служебный запрос, см. adapter.checkBudget
      noThink: true,  // размышления не нужны: у думающей модели они съедали весь ответ
    });
    const started = Date.now();
    let out = await ask(DIGEST_MAX_TOKENS);
    const elapsedMs = Date.now() - started;
    let text = (out.text || '').trim();
    let skippedRetry = '';
    /*
     * Пустой текст при непустых размышлениях — модель додумала до лимита и
     * ничего не написала (qwen3.8 на VPS, 09.09.2026: ни одного конспекта за
     * два прогона, и ни строки в журнале). Выключить размышления у MLX-сборки
     * нельзя (`enable_thinking=false` она не слышит — живой прогон 09.09.2026),
     * остаётся один повтор с бюджетом, куда помещаются и размышления, и конспект.
     *
     * Но повтор стоит времени: 27B-модель на маке отдаёт ~10 токенов в секунду,
     * и бюджет 11 000 токенов не укладывался в LOCAL_AI_TIMEOUT — пятнадцать минут
     * впустую. Поэтому перед повтором время оценивается по скорости первого
     * вызова, и заведомо не успевающий повтор не делается вовсе.
     */
    if (!text && (out.reasoning || '').trim()) {
      const bigger = DIGEST_MAX_TOKENS + REASONING_ALLOWANCE;
      const produced = Math.max(1, Math.round(((out.reasoning || '').length + (out.text || '').length) / 3));
      const tokensPerSec = produced / Math.max(1, elapsedMs / 1000);
      const timeoutMs = require('./ai/cloud-access').isCloud(route.provider)
        ? Math.max(config.localAiTimeoutMs, 1800000) : config.localAiTimeoutMs;
      const predictedMs = elapsedMs * 0.35 + (bigger / tokensPerSec) * 1000;
      if (predictedMs < timeoutMs * 0.85) {
        if (onProgress) onProgress(`Документ ${i + 1}/${files.length}: модель ушла в размышления — повтор с большим бюджетом ответа`);
        out = await ask(bigger);
        text = (out.text || '').trim();
      } else {
        skippedRetry = ` (повтор с бюджетом ${bigger} токенов занял бы ~${Math.round(predictedMs / 60000)} мин при лимите ${Math.round(timeoutMs / 60000)} мин — не делался)`;
      }
    }
    if (text) {
      fs.writeFileSync(digestPath(f), text);
      made++;
    } else {
      recentFailures.set(failKey, Date.now());
      // пустота из-за размышлений — свойство модели, а не документа
      if ((out.reasoning || '').trim()) recentFailures.set(routeKey, Date.now());
      try {
        db.prepare('INSERT INTO events (session_id, stage, detail, level, created_at) VALUES (?,?,?,?,?)')
          .run(sessionId, 'Конспект документа не составлен',
            `«${f.original_name}»: модель ${route.provider}${route.model ? ` (${route.model})` : ''} вернула пустой текст`
            + ((out.reasoning || '').trim() ? ' — весь ответ ушёл в размышления' : '') + skippedRetry
            + '. Документ уйдёт в анализ полным текстом в пределах окна модели.',
            'warn', new Date().toISOString());
      } catch { /* журнал не критичен */ }
    }
  }
  return { files: files.length, made };
}

