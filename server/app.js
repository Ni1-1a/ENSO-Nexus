'use strict';
const path = require('path');
const express = require('express');
const config = require('./config');
const { db, now } = require('./db');
const { securityHeaders, cors, notFound, errorHandler } = require('./middleware');
const { router: apiRouter, deleteSessionData } = require('./routes/api');

function createApp() {
  const app = express();
  app.set('trust proxy', 1); // behind Render/railway proxy: correct req.ip for rate limiting
  app.disable('x-powered-by');
  app.use(securityHeaders);
  app.use(cors);
  app.use(express.json({ limit: '256kb' }));
  app.use('/api', apiRouter);
  app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: '1h', index: 'index.html' }));
  app.use(notFound);
  app.use(errorHandler);
  return app;
}

/** TTL cleanup: expired sessions and their files are removed automatically. */
function startCleanup() {
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
