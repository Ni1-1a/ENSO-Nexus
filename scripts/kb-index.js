'use strict';
/**
 * Индексация нормативной базы: node --env-file-if-exists=.env scripts/kb-index.js
 * Требует KB_DIR в окружении и (для векторов) запущенный LM Studio с эмбеддинг-моделью.
 *
 * --missing — не переиндексировать, а дозаполнить векторы у чанков, оставшихся без них
 * (после «тихой деградации»: индекс собран, пока эмбеддинги были недоступны).
 * KB_EMBED_TIMEOUT_MS и KB_EMBED_RETRIES в окружении — терпение к занятой LM Studio.
 */
process.chdir(require('path').join(__dirname, '..'));
const kb = require('../server/services/kb');

const missingOnly = process.argv.includes('--missing');
(missingOnly ? kb.embedMissing({ log: console.log }) : kb.reindex({ log: console.log }))
  .then((stats) => {
    console.log('Итог:', JSON.stringify(stats));
    process.exit(0);
  })
  .catch((err) => {
    console.error('Ошибка индексации:', err.message);
    process.exit(1);
  });
