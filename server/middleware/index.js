'use strict';
const crypto = require('crypto');
const path = require('path');
const config = require('../config');
const { db } = require('../db');

/* ---------- rate limiting (in-memory sliding window per IP) ---------- */
const buckets = new Map();

const TOO_MANY = 'Слишком много запросов. Подождите минуту и повторите.';

/** Адрес TCP-соединения. Заголовками не подделывается — в отличие от req.ip. */
function peerAddress(req) {
  return (req.socket && req.socket.remoteAddress) || req.ip || '-';
}

/** Одно ведро скользящего окна. true — лимит исчерпан. */
function hit(key, limit) {
  const nowMs = Date.now();
  let bucket = buckets.get(key);
  if (!bucket) { bucket = []; buckets.set(key, bucket); }
  while (bucket.length && nowMs - bucket[0] > config.rateLimitWindowMs) bucket.shift();
  if (bucket.length >= limit) return true;
  bucket.push(nowMs);
  return false;
}

/**
 * Ограничитель частоты. Имя обязательно: ключ вида «ip|лимит» склеивал разные
 * лимитеры с одинаковым числом в одно ведро, и обычные запросы молча съедали
 * бюджет попыток входа.
 *
 * Считается ДВА ведра:
 *  - по посетителю (`req.ip`, за cloudflared это адрес из заголовка) — честное
 *    разделение бюджета между людьми;
 *  - по адресу TCP-соединения — потолок, который заголовком не обходится.
 *    Без него подстановка X-Forwarded-For заводила новое ведро на каждый
 *    придуманный адрес, и перебор имён на входе становился безлимитным.
 */
function rateLimit(limit, name = 'general', { peerFactor = config.rateLimitPeerFactor } = {}) {
  const peerLimit = Math.max(limit, Math.round(limit * Math.max(1, peerFactor)));
  return (req, res, next) => {
    const peer = peerAddress(req);
    const visitorExceeded = hit(`${name}|${req.ip}|${limit}`, limit);
    // потолок соединения считается ВСЕГДА: иначе его обходят, чередуя запросы
    // с подставленным заголовком и без него
    const peerExceeded = hit(`${name}|peer|${peer}|${peerLimit}`, peerLimit);
    if (visitorExceeded || peerExceeded) {
      return res.status(429).json({ error: TOO_MANY });
    }
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

/* ---------- вход по «Фамилия Имя»: токен человека в заголовке ---------- */

/**
 * Опознание человека по токену. Токен приходит отдельным заголовком, а не в
 * Authorization: там уже живёт токен проекта, и смешивать два разных ключа
 * в одном месте — верный способ однажды подставить не тот.
 */
const USER_TOKEN_RE = /^[0-9a-f]{64}$/;

function optionalUser(req, res, next) {
  const token = String(req.headers['x-user-token'] || '');
  // пустой и усечённый токен отвергаются ДО поиска: иначе любая ошибка в
  // сравнении хэшей превращается во вход под первым попавшимся человеком
  req.userToken = USER_TOKEN_RE.test(token) ? token : '';
  req.user = req.userToken ? require('../services/users').byToken(req.userToken) : null;
  next();
}

/**
 * Владелец проекта. Токен проекта — по-прежнему доказательство права на него,
 * но если у проекта есть хозяин, посторонний с этим токеном не должен тратить
 * деньги владельца на модели и рушить его данные.
 */
function sessionOwner(req, res, next) {
  // опознание идёт всегда: даже с выключенным входом обработчику нужно знать,
  // кто именно подписывает решение по мероприятию
  optionalUser(req, res, () => {
    if (!config.requireLogin) return next();
    const owner = req.session && req.session.user_id;
    if (!owner) return next();                       // проект заведён до входа — хозяина нет
    if (req.user && req.user.approved && req.user.id === owner) return next();
    return res.status(403).json({ error: 'Это чужой проект — войдите под своим именем', needLogin: !req.user });
  });
}

/** Дальше пускаем только одобренного человека. */
function userAuth(req, res, next) {
  if (!config.requireLogin) return next();
  optionalUser(req, res, () => {
    if (!req.user) return res.status(401).json({ error: 'Нужно войти на платформу', needLogin: true });
    if (!req.user.approved) {
      return res.status(403).json({ error: 'Заявка ещё не одобрена владельцем платформы', status: 'pending' });
    }
    next();
  });
}

/* ---------- security headers + errors ---------- */
function securityHeaders(req, res, next) {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy':
      "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
      "font-src https://fonts.gstatic.com; img-src 'self' data:; script-src 'self'; connect-src 'self'; " +
      // токены лежат в localStorage, поэтому цена любого инжекта высока:
      // закрываем подмену базового URL, отправку формы наружу и вставку в чужой фрейм
      "base-uri 'self'; form-action 'self'; object-src 'none'; frame-ancestors 'none'",
  });
  next();
}

// Same-origin app: no cross-origin API access is required, so none is granted.
function cors(req, res, next) {
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
}

/**
 * Переход браузера или запрос программы?
 *
 * От этого зависит вид ответа: человеку с опечаткой в адресе нужна страница
 * в оформлении платформы, а клиентскому коду — прежний JSON. Ошибиться в другую
 * сторону нельзя: HTML вместо JSON молча ломает обработку ошибок в интерфейсе.
 */
function wantsHtml(req) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  if (req.path.startsWith('/api/')) return false;
  const accept = String(req.headers.accept || '');
  return accept.includes('text/html');
}

const ERROR_PAGES = path.join(__dirname, '..', '..', 'public', 'error-pages');

function notFound(req, res) {
  if (wantsHtml(req)) {
    return res.status(404).sendFile(path.join(ERROR_PAGES, 'app-404.html'), (err) => {
      if (err && !res.headersSent) res.status(404).json({ error: 'Не найдено' });
    });
  }
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
  // Ошибку разбора наружу дословно отдавать нельзя: это техническая фраза
  // парсера на английском вместе с куском присланного тела. Пишем по-русски,
  // как и все прочие ответы, а подробности оставляем в серверном логе.
  if (err.type === 'entity.parse.failed' || err.type === 'entity.verify.failed'
      || (err.status === 400 && err instanceof SyntaxError && 'body' in err)) {
    console.warn(`[body] ${req.method} ${req.originalUrl} — ${err.message}`);
    return res.status(400).json({ error: 'Тело запроса не разобрано: ожидается корректный JSON.' });
  }
  if (err.type === 'charset.unsupported' || err.type === 'encoding.unsupported') {
    return res.status(400).json({ error: 'Неподдерживаемая кодировка тела запроса' });
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

module.exports = {
  optionalUser, userAuth, sessionOwner, rateLimit, sessionAuth, securityHeaders, cors, notFound, logErrorResponses, errorHandler };
