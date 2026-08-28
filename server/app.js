'use strict';
const path = require('path');
const express = require('express');
const config = require('./config');
const { db, now } = require('./db');
const { securityHeaders, cors, notFound, logErrorResponses, errorHandler } = require('./middleware');
const { router: apiRouter, deleteSessionData } = require('./routes/api');

/** Восстановление после рестарта: «зависшие» задачи помечаются ошибкой, сессии разблокируются. */
function recoverInterruptedJobs() {
  const stages = require('./services/stages');
  // рабочий этап без задачи — тоже «зависшая» работа: клиент по нему опрашивает
  // сервер вечно, даже когда job_status уже не queued/running
  const stuck = db.prepare(
    `SELECT id FROM sessions WHERE job_status IN ('queued','running')
        OR stage IN (${stages.WORKING_STAGES.map(() => '?').join(',')})`,
  ).all(...stages.WORKING_STAGES);
  for (const s of stuck) {
    db.prepare("UPDATE sessions SET job_status = 'failed', updated_at = ? WHERE id = ?").run(now(), s.id);
    db.prepare('INSERT INTO events (session_id, stage, detail, level, created_at) VALUES (?,?,?,?,?)')
      .run(s.id, 'Произошла ошибка', 'Обработка была прервана перезапуском сервера — запустите её повторно.', 'error', now());
    // этап возвращается к последней карточке согласования: работа не выполнена
    stages.settle(s.id);
  }
  if (stuck.length) console.log(`[recovery] прерванных задач: ${stuck.length}`);
}

function createApp() {
  require('./services/users').init();
  recoverInterruptedJobs();
  // Вопрос, заданный перед падением процесса, остаётся в ленте без ответа —
  // очередь для того и выведена из ленты, чтобы пережить перезапуск. Разбор
  // откладываем на следующий тик: приложение должно сначала собраться.
  setImmediate(() => {
    try { require('./services/pipeline').drainPendingChats(); } catch (err) {
      console.warn('[recovery] очередь диалога не разобрана:', err.message);
    }
  });
  const app = express();
  // Кому верить в X-Forwarded-For. По умолчанию — только петлевому интерфейсу:
  // сервер слушает 127.0.0.1 и стоит за cloudflared, других хопов нет.
  // `trust proxy = 1` доверял ЛЮБОМУ, кто прислал заголовок, и ограничитель
  // попыток входа обходился одной строкой (см. middleware/index.js).
  app.set('trust proxy', config.trustProxy);
  app.disable('x-powered-by');
  app.use(securityHeaders);
  app.use(cors);
  app.use(express.json({ limit: '256kb' }));
  // модуль «Датасет» — отдельный роутер: свои таблицы, свой доступ, вне сессий
  app.use('/api/dataset', logErrorResponses, require('./routes/dataset').router);
  // модуль «Нормоконтроль» — свой роутер и СВОЯ БД (PostgreSQL + pgvector, порт 5433)
  app.use('/api/normo', logErrorResponses, require('./routes/normo').router);
  // модуль «Анализ ТЗ» — свой роутер, таблицы tz_* в основной SQLite, вне TTL сессий
  app.use('/api/tz', logErrorResponses, require('./routes/tz').router);
  // модуль «Проверка документа» (+ замена A→B) — автоподбор промпта библиотеки
  app.use('/api/doccheck', logErrorResponses, require('./routes/doccheck').router);
  // «Акты (АОСР)» и «Входной контроль ГГЭ» — детерминированные конвейеры без хранения
  app.use('/api/akty', logErrorResponses, require('./routes/akty').router);
  app.use('/api/gge', logErrorResponses, require('./routes/gge').router);
  app.use('/api', logErrorResponses, apiRouter);
  // Cache-Control: no-cache — браузер ОБЯЗАН ревалидировать по ETag (304); без
  // заголовка вступает в силу эвристическое кэширование и правки фронта доходят с опозданием
  app.use(express.static(path.join(__dirname, '..', 'public'), {
    index: 'index.html',
    setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
  }));
  app.use(notFound);
  app.use(errorHandler);
  return app;
}

/** TTL cleanup: expired sessions and their files are removed automatically.
 *  SESSION_TTL_HOURS=0 (или меньше) — хранение бессрочное, очистка отключена. */
function startCleanup() {
  if (config.sessionTtlHours <= 0) {
    console.log('[cleanup] TTL отключён — история хранится бессрочно');
    return null;
  }
  const sweep = () => {
    try {
      const cutoff = new Date(Date.now() - config.sessionTtlHours * 3600 * 1000).toISOString();
      const expired = db.prepare('SELECT id FROM sessions WHERE updated_at < ?').all(cutoff);
      for (const s of expired) deleteSessionData(s.id);
      if (expired.length) console.log(`[cleanup] removed ${expired.length} expired session(s) at ${now()}`);
    } catch (err) {
      console.error('[cleanup]', err);
    }
  };
  const timer = setInterval(sweep, config.cleanupIntervalMinutes * 60 * 1000);
  timer.unref();
  sweep();
  return timer;
}

module.exports = { createApp, startCleanup };
