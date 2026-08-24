'use strict';
/**
 * Обмен ключа авторизации GigaChat на access_token.
 *
 * У Сбера авторизация двухступенчатая: в .env живёт постоянный ключ
 * авторизации (он же Basic), а к API ходит короткоживущий access_token —
 * по паспорту 30 минут. Токен кэшируется до истечения с минутой запаса,
 * параллельные вызовы ждут ОДИН обмен, а не устраивают каждый свой:
 * одновременный анализ и реплика в чате иначе жгли бы лимит OAuth вдвое.
 *
 * TLS: сертификат у *.sberbank.ru выдан НУЦ Минцифры, в комплекте Node его
 * нет. Без NODE_EXTRA_CA_CERTS с российским корневым сертификатом обмен
 * падает на проверке цепочки — ошибка называет это прямо, потому что
 * «fetch failed» не подсказывает человеку ничего.
 */
const crypto = require('crypto');
const config = require('../../config');

let cached = { token: '', expiresAt: 0 };
let inflight = null;

/** Коды Node, за которыми стоит недоверенная цепочка сертификатов. */
const TLS_CODES = new Set([
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_GET_ISSUER_CERT', 'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT', 'CERT_UNTRUSTED',
]);

/** Настоящий код ошибки: fetch в Node прячет его в цепочке err.cause. */
function rootCode(err) {
  const seen = new Set();
  let e = err;
  while (e && typeof e === 'object' && !seen.has(e)) {
    seen.add(e);
    if (e.code) return e.code;
    e = e.cause;
  }
  return '';
}

async function exchange() {
  let res;
  try {
    res = await fetch(config.gigachatOauthUrl, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${config.gigachatAuthKey}`,
        RqUID: crypto.randomUUID(), // обязательный заголовок Сбера: идентификатор запроса
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: `scope=${encodeURIComponent(config.gigachatScope)}`,
      signal: AbortSignal.timeout(10000),
    });
  } catch (err) {
    const code = rootCode(err);
    if (TLS_CODES.has(code)) {
      throw new Error(`сертификат GigaChat не признан (${code}). У API сертификат НУЦ Минцифры: `
        + 'задайте процессу платформы NODE_EXTRA_CA_CERTS с российским корневым сертификатом.');
    }
    throw new Error(`обмен ключа на токен не удался (${code || err.message}).`);
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    if (res.status === 401) {
      throw new Error('ключ авторизации не принят (401) — проверьте GIGACHAT_AUTH_KEY и GIGACHAT_SCOPE в .env.');
    }
    throw new Error(`обмен ключа на токен вернул HTTP ${res.status}${detail ? `: ${detail.slice(0, 160)}` : ''}.`);
  }
  const data = await res.json().catch(() => ({}));
  if (!data.access_token) throw new Error('в ответе OAuth нет access_token — проверьте GIGACHAT_OAUTH_URL.');
  // expires_at приходит миллисекундами эпохи; минута запаса — на дорогу запроса.
  // Поле не пришло — считаем паспортные 30 минут от текущего момента.
  const expiresAt = Number(data.expires_at) || (Date.now() + 30 * 60000);
  cached = { token: data.access_token, expiresAt: expiresAt - 60000 };
  return cached.token;
}

/** Действующий access_token: из кэша либо свежим обменом. */
async function accessToken() {
  if (!config.gigachatAuthKey) throw new Error('нужен GIGACHAT_AUTH_KEY на сервере.');
  if (cached.token && Date.now() < cached.expiresAt) return cached.token;
  if (!inflight) inflight = exchange().finally(() => { inflight = null; });
  return inflight;
}

module.exports = { accessToken };
