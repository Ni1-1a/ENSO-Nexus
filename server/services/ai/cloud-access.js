'use strict';
/**
 * Кому на платформе разрешены ОБЛАЧНЫЕ модели и под каким идентификатором
 * уходят их запросы.
 *
 * Зачем это вообще. Условия OpenAI, Anthropic и Google ограничивают не только
 * то, откуда обращается владелец ключа, но и то, КОМУ он открывает доступ:
 * «accessing or offering access to our services outside of the countries and
 * territories listed» — про предоставление доступа сказано отдельной строкой.
 * Платформа отдаёт наружу один ключ на всех, и раньше любой вошедший человек
 * тратил его из любой точки мира. Аккаунт OpenAI за это деактивировали
 * 2026-08-10 (org и user отдельными письмами).
 *
 * Поэтому правило простое: облако — только тем, кому владелец поставил
 * `"cloudAi": true` в `users.json`. Остальные работают на моделях, поднятых
 * на самом сервере (LM Studio, Ollama) — они ничьих условий не нарушают.
 *
 * Проверка живёт ЗДЕСЬ и вызывается на дне адаптера, у самого вызова модели,
 * а не только в интерфейсе и не только при выборе в «Настройках». Выбор
 * провайдера хранится в сессии и переживает смену правил, а тело запроса
 * подставляется клиентом — гейт, который стоит выше, обходится подстановкой
 * `provider` в запросе.
 *
 * `safety_identifier` — вторая половина той же истории. OpenAI просит
 * приложения с несколькими конечными пользователями помечать запросы стабильным
 * идентификатором человека: тогда срабатывание политики привязывается к нему,
 * а не ко всей организации. Отправлять сюда ФИО нельзя — уходит хэш.
 */
const crypto = require('crypto');
const config = require('../../config');
const { db } = require('../../db');

/** Провайдеры, которые обращаются к чужому сервису по нашему ключу. */
const CLOUD_PROVIDERS = new Set(['claude', 'chatgpt', 'kimi', 'gemini']);

/** Текст отказа — один на все места, чтобы человек везде читал одно и то же. */
const DENY_MESSAGE =
  'Облачные модели на этой платформе доступны только владельцу: условия провайдеров '
  + 'запрещают открывать доступ к их сервисам другим людям. Выберите в «Настройках» '
  + 'локальную модель — она работает на сервере платформы и доступна всем.';

function isCloud(providerId) {
  return CLOUD_PROVIDERS.has(String(providerId || ''));
}

/** Владелец проекта по его идентификатору; пусто — проект заведён до входа. */
function ownerOf(sessionId) {
  if (!sessionId) return '';
  try {
    const row = db.prepare('SELECT user_id FROM sessions WHERE id = ?').get(sessionId);
    return row && row.user_id ? String(row.user_id) : '';
  } catch {
    return ''; // отсутствие строки не должно ронять вызов — это отказ, а не сбой
  }
}

/** Разрешено ли облако конкретному человеку (объект из `users.json`). */
function userAllowed(user) {
  if (config.cloudAiOpen) return true;
  return !!(user && user.approved && user.cloudAi === true);
}

/**
 * Разрешено ли облако для проекта.
 *
 * Проект без хозяина (заведён до появления входа) облако НЕ получает: с токеном
 * такого проекта работает кто угодно, и «только владельцу» перестало бы быть
 * правдой. Отключается это одним способом — `CLOUD_AI_OPEN=1`, и он же
 * возвращает прежнее поведение целиком.
 */
function allowedForSession(sessionId) {
  if (config.cloudAiOpen) return true;
  const ownerId = ownerOf(sessionId);
  if (!ownerId) return false;
  return userAllowed(require('../users').byId(ownerId));
}

/**
 * Стабильный обезличенный идентификатор конечного пользователя для провайдера.
 *
 * Считается от человека, а не от проекта: у одного человека проектов много,
 * и склеивать их в разные «пользователи» на стороне провайдера незачем.
 * Проект без хозяина помечается своим идентификатором — лучше, чем ничего.
 */
function safetyIdentifier(sessionId) {
  const ownerId = ownerOf(sessionId);
  const base = ownerId ? `user:${ownerId}` : (sessionId ? `session:${sessionId}` : '');
  if (!base) return '';
  return `enso-${crypto.createHash('sha256').update(base).digest('hex').slice(0, 24)}`;
}

module.exports = {
  CLOUD_PROVIDERS, DENY_MESSAGE,
  isCloud, userAllowed, allowedForSession, safetyIdentifier, ownerOf,
};
