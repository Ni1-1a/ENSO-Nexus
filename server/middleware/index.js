'use strict';
const crypto = require('crypto');
const config = require('../config');
const { db } = require('../db');

/* ---------- rate limiting (in-memory sliding window per IP) ---------- */
const buckets = new Map();
function rateLimit(limit) {
  return (req, res, next) => {
    const key = `${req.ip}|${limit}`;
    const nowMs = Date.now();
    let bucket = buckets.get(key);
    if (!bucket) { bucket = []; buckets.set(key, bucket); }
    while (bucket.length && nowMs - bucket[0] > config.rateLimitWindowMs) bucket.shift();
    if (bucket.length >= limit) {
      return res.status(429).json({ error: 'Слишком много запросов. Подождите минуту и повторите.' });
    }
    bucket.push(nowMs);
    next();
  };
}
setInterval(() => {
  const cutoff = Date.now() - config.rateLimitWindowMs * 2;
  for (const [k, b] of buckets) if (!b.length || b[b.length - 1] < cutoff) buckets.delete(k);
}, 60000).unref();

/* ---------- session auth: session id in path + bearer token ---------- */
function timingSafeEqual(a, b) {
  const ba = Buffer.from(String(a)), bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function sessionAuth(req, res, next) {
  const id = req.params.id;
  if (!/^[0-9a-f-]{36}$/.test(id || '')) {
    return res.status(400).json({ error: 'Некорректный идентификатор сессии' });
  }
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const session = db.prepare("SELECT * FROM sessions WHERE id = ? AND status = 'active'").get(id);
  if (!session || !token || !timingSafeEqual(session.token, token)) {
    // same answer for "not found" and "wrong token": no session enumeration
    return res.status(404).json({ error: 'Сессия не найдена или токен неверен' });
  }
  req.session = session;
  next();
}

/* ---------- security headers + errors ---------- */
function securityHeaders(req, res, next) {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy':
      "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
      "font-src https://fonts.gstatic.com; img-src 'self' data:; script-src 'self'; connect-src 'self'",
  });
  next();
}

// Same-origin app: no cross-origin API access is required, so none is granted.
function cors(req, res, next) {
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
}

function notFound(req, res) {
  res.status(404).json({ error: 'Не найдено' });
}

/**
 * Каждый ответ 4xx/5xx с телом {error} попадает в серверный лог вместе с маршрутом —
 * причина любой клиентской ошибки (в т.ч. 400) видна без дополнительной отладки.
 */
function logErrorResponses(req, res, next) {
  const json = res.json.bind(res);
  res.json = (body) => {
    if (res.statusCode >= 400 && body && body.error) {
      console.warn(`[http ${res.statusCode}] ${req.method} ${req.originalUrl} — ${body.error}`);
    }
    return json(body);
  };
  next();
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Запрос слишком большой' });
  }
  if (err.name === 'MulterError') {
    const msg = err.code === 'LIMIT_FILE_SIZE' ? 'Файл превышает допустимый размер'
      : err.code === 'LIMIT_FILE_COUNT' ? 'Слишком много файлов за один запрос'
      : 'Ошибка загрузки файла';
    return res.status(413).json({ error: msg });
  }
  const status = err.status || 500;
  if (status >= 500) console.error('[error]', err); // stack traces stay in server logs
  res.status(status).json({ error: status >= 500 ? 'Внутренняя ошибка сервера' : err.message });
}

module.exports = { rateLimit, sessionAuth, securityHeaders, cors, notFound, logErrorResponses, errorHandler };
