'use strict';
/**
 * Индексация нормативной базы: node --env-file-if-exists=.env scripts/kb-index.js
 * Требует KB_DIR в окружении и (для векторов) запущенный LM Studio с эмбеддинг-моделью.
 */
process.chdir(require('path').join(__dirname, '..'));
const kb = require('../server/services/kb');

kb.reindex({ log: console.log })
  .then((stats) => {
    console.log('Итог:', JSON.stringify(stats));
    process.exit(0);
  })
  .catch((err) => {
    console.error('Ошибка индексации:', err.message);
    process.exit(1);
  });
