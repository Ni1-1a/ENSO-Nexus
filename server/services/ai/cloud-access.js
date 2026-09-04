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
const CLOUD_PROVIDERS = new Set(['claude', 'chatgpt', 'kimi', 'gemini', 'gigachat', 'yandexgpt']);

/** Человеческие имена провайдеров для текста отказа. */
const PROVIDER_LABELS = {
  claude: 'Claude', chatgpt: 'ChatGPT', kimi: 'Kimi', gemini: 'Gemini',
  gigachat: 'GigaChat', yandexgpt: 'YandexGPT',
};

function isCloud(providerId) {
  return CLOUD_PROVIDERS.has(String(providerId || ''));
}

/**
 * Открыт ли провайдер всем вошедшим (список из CLOUD_AI_OPEN_PROVIDERS).
 *
 * Владелец может открыть один сервис и оставить закрытыми остальные: у разных
 * провайдеров разные условия и разная цена ошибки. Открытие — осознанное
 * действие: список белый, пустая переменная не открывает ничего.
 */
/**
 * Западная тройка открытию «всем» не подлежит (решение владельца 02.09.2026):
 * именно её условия про «предоставление доступа» стоили аккаунта OpenAI, и на
 * VPS список CLOUD_AI_OPEN_PROVIDERS со всеми шестью провайдерами обнулял
 * отметку cloudAi у людей. Claude, ChatGPT и Gemini — только по отметке
 * человека (или владельцу), что бы ни стояло в списке.
 */
const OWNER_ONLY = new Set(['claude', 'chatgpt', 'gemini']);

function openToEveryone(providerId) {
  const id = String(providerId || '').toLowerCase();
  if (OWNER_ONLY.has(id)) return false;
  return config.cloudAiOpenProviders.has(id);
}

/** Имя из адреса без порта и регистра: `Enso-Nexus.COM:443` → `enso-nexus.com`. */
function normHost(host) {
  return String(host || '').toLowerCase().split(':')[0].trim();
}

/**
 * Предлагается ли провайдер на этом имени платформы.
 *
 * У платформы два адреса, и западное облако живёт только на одном из них.
 * Пустой список имён означает «ограничения нет»: иначе забытая переменная
 * молча выключила бы облачные модели на всех адресах сразу, и это выглядело
 * бы как поломка.
 *
 * Привязка не обязана быть общей на всё облако: CLOUD_AI_HOSTS_PROVIDERS
 * перечисляет, КОГО именно она касается. Claude, ChatGPT и Gemini живут
 * только на именах из списка, а Kimi, GigaChat и YandexGPT из России
 * доступны — им имя не преграда. Вызов без провайдера отвечает за всю
 * привязку целиком: так спрашивают места, где провайдер ещё не выбран.
 */
function hostAllowed(host, providerId = '') {
  if (!config.cloudAiHosts.size) return true;
  if (providerId && config.cloudAiHostsProviders.size
    && !config.cloudAiHostsProviders.has(String(providerId).toLowerCase())) {
    return true;
  }
  return config.cloudAiHosts.has(normHost(host));
}

/** Имя, с которого работают в проекте; пусто — проект ещё ни разу не открывали. */
function hostOf(sessionId) {
  if (!sessionId) return '';
  try {
    const row = db.prepare('SELECT origin_host FROM sessions WHERE id = ?').get(sessionId);
    return row && row.origin_host ? String(row.origin_host) : '';
  } catch {
    return ''; // колонки может не быть на старой базе — это отказ, а не сбой
  }
}

/** Отказ по имени платформы: человек тут ни при чём, дело в адресе. */
function hostDenyMessage() {
  const [first] = [...config.cloudAiHosts];
  return first
    ? `Эта модель работает только на ${first} — на этом адресе доступны локальные и работающие из России облачные модели.`
    : 'Эта модель на этом адресе платформы недоступна — выберите другую в «Настройках».';
}

/** Текст отказа: называет и то, чем человек может воспользоваться вместо. */
function denyMessage(providerId) {
  const имя = PROVIDER_LABELS[providerId] || 'Эта облачная модель';
  const открытые = [...config.cloudAiOpenProviders]
    .map((id) => PROVIDER_LABELS[id] || id).join(', ');
  return `${имя} на этой платформе доступна только владельцу: условия провайдера `
    + 'запрещают открывать доступ к их сервису другим людям. '
    + (открытые
      ? `Выберите в «Настройках» ${открытые} или локальную модель — они доступны всем.`
      : 'Выберите в «Настройках» локальную модель — она доступна всем.');
}

/** Общий текст — для мест, где конкретный провайдер неизвестен. */
const DENY_MESSAGE = denyMessage('');

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

/**
 * Разрешено ли облако конкретному человеку (объект из `users.json`).
 * @param {object} user
 * @param {string} [providerId] — если провайдер открыт всем, отметка не нужна
 */
function userAllowed(user, providerId) {
  if (config.cloudAiOpen) return true;
  if (providerId && openToEveryone(providerId)) return !!(user && user.approved);
  // владелец платформы отметки не ждёт: ключи его
  return !!(user && user.approved && (user.cloudAi === true || user.owner === true));
}

/**
 * Разрешено ли облако для проекта.
 *
 * Проект без хозяина (заведён до появления входа) облако НЕ получает: с токеном
 * такого проекта работает кто угодно, и «только владельцу» перестало бы быть
 * правдой. Отключается это одним способом — `CLOUD_AI_OPEN=1`, и он же
 * возвращает прежнее поведение целиком.
 */
function allowedForSession(sessionId, providerId) {
  if (config.cloudAiOpen) return true;
  /*
   * Имя платформы решает раньше человека: на закрытом адресе привязанного
   * провайдера нет ни у кого, включая владельца. Проект, который ещё ни разу
   * не открывали, имени не имеет — и привязанного облака не получает: пустое
   * поле не повод считать, что пришли с разрешённого адреса. Имя записывается
   * при первом же обращении к проекту, поэтому до вызова модели дело доходит
   * уже с заполненным полем.
   */
  if (!hostAllowed(hostOf(sessionId), providerId)) return false;
  const ownerId = ownerOf(sessionId);
  if (!ownerId) return false;
  return userAllowed(require('../users').byId(ownerId), providerId);
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
  CLOUD_PROVIDERS, OWNER_ONLY, DENY_MESSAGE, PROVIDER_LABELS,
  isCloud, openToEveryone, denyMessage, userAllowed, allowedForSession, safetyIdentifier, ownerOf,
  normHost, hostAllowed, hostOf, hostDenyMessage,
};
