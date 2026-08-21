'use strict';
/**
 * Люди платформы: файл `users.json` в папке проекта.
 *
 * Почему файл, а не таблица. Владелец должен уметь открыть список, увидеть,
 * кто просится, поставить `"approved": true` и переключить режим регистрации
 * со свободной на «по одобрению» — без интерфейса и без SQL. Если правдой
 * сделать SQLite, а файл — выгрузкой, ручная правка теряется при первой же
 * записи. Поэтому правда о ЛЮДЯХ живёт в файле, а правда о ПРОЕКТАХ остаётся
 * в SQLite; связывает их одна колонка `sessions.user_id`.
 *
 * Файл лежит в корне проекта, а НЕ в `public/`: эта папка раздаётся статикой,
 * и список с фамилиями и адресами уехал бы в интернет одним GET.
 *
 * Вход по «Фамилия Имя» без пароля — осознанное решение владельца. Отсюда
 * обязательные компенсации, которые держит этот модуль:
 *  - существующие имена не перечисляются наружу ни одним ответом;
 *  - токен в файле хранится только хэшем: утечка файла не даёт войти;
 *  - у человека хранятся ПОСЛЕДНИЕ адреса, а не вся история посещений;
 *  - число записей ограничено, иначе свободная регистрация раздувает файл.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const net = require('net');
const config = require('../config');

const MAX_USERS = 500;
const MAX_IPS_PER_USER = 3;
const NAME_MAX = 60;
/**
 * Разрешены только кириллица и латиница, пробел, дефис и апостроф.
 * `\p{L}` намеренно НЕ используется: под него подходят и переключатели
 * направления письма, и невидимые знаки — такое имя видно в списке иначе,
 * чем оно записано в файле, и владелец одобрит не того человека.
 */
const NAME_RE = /^[A-Za-zА-Яа-яЁё][A-Za-zА-Яа-яЁё \-']{0,59}$/;

let cache = null;      // разобранное содержимое файла
let cacheMtimeMs = 0;  // отпечаток файла на момент чтения

const emptyStore = () => ({
  registration: 'free',
  comment: 'registration: free — вход сразу после регистрации; approval — сначала поставьте approved: true нужному человеку. '
    + 'cloudAi: true — разрешить человеку облачные модели (Claude, ChatGPT, Kimi, Gemini); без него доступны только локальные',
  updatedAt: new Date().toISOString(),
  users: [],
});

function filePath() { return config.usersFile; }

/* ---------------- чтение и запись ---------------- */

function readFileIfChanged() {
  const file = filePath();
  let stat = null;
  try { stat = fs.statSync(file); } catch { /* файла нет — создадим при первой записи */ }
  if (!stat) {
    if (!cache) cache = emptyStore();
    return cache;
  }
  if (cache && stat.mtimeMs === cacheMtimeMs) return cache;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    cache = normalizeStore(parsed);
    cacheMtimeMs = stat.mtimeMs;
  } catch (err) {
    // Битый файл НЕ перезаписывается: это единственная копия списка людей.
    // Работаем на прежнем разобранном состоянии и говорим об этом в лог.
    console.error('[users] файл не разобран, правка не применена:', err.message);
    if (!cache) cache = emptyStore();
  }
  return cache;
}

/** Приведение к ожидаемой форме: ручная правка не должна ронять сервер. */
function normalizeStore(raw) {
  const store = emptyStore();
  if (raw && typeof raw === 'object') {
    store.registration = raw.registration === 'approval' ? 'approval' : 'free';
    if (typeof raw.comment === 'string') store.comment = raw.comment;
    if (typeof raw.updatedAt === 'string') store.updatedAt = raw.updatedAt;
    if (Array.isArray(raw.users)) {
      store.users = raw.users.filter((u) => u && typeof u === 'object').map((u) => ({
        lastName: String(u.lastName || '').slice(0, NAME_MAX),
        firstName: String(u.firstName || '').slice(0, NAME_MAX),
        approved: u.approved === true,
        // Облачные модели (Claude, ChatGPT, Kimi, Gemini) — только по явному
        // разрешению владельца: их условия запрещают открывать доступ к сервису
        // другим людям. Умолчание — false, и оно обязано быть именно таким:
        // забытое поле не имеет права означать «можно». См. ai/cloud-access.js.
        cloudAi: u.cloudAi === true,
        // Владелец платформы: видит расход всех людей, деньги на счетах
        // провайдеров и вносит пополнения. Умолчание false по той же причине,
        // что и у cloudAi: забытое поле не имеет права означать «можно».
        owner: u.owner === true,
        // Допуск к чужой статистике без прочих прав владельца. Право отдельное:
        // разрешение тратить деньги и разрешение видеть, кто их тратит, —
        // разные вещи.
        statsAll: u.statsAll === true,
        note: String(u.note || '').slice(0, 200),
        id: String(u.id || `u_${crypto.randomBytes(8).toString('hex')}`),
        createdAt: String(u.createdAt || new Date().toISOString()),
        lastSeenAt: String(u.lastSeenAt || ''),
        lastIps: Array.isArray(u.lastIps) ? u.lastIps.map(String).slice(-MAX_IPS_PER_USER) : [],
        devices: Array.isArray(u.devices) ? u.devices.map(String).slice(-MAX_IPS_PER_USER) : [],
        tokenHash: String(u.tokenHash || ''),
      })).filter((u) => u.lastName && u.firstName);
    }
  }
  return store;
}

/**
 * Запись через временный файл и переименование: обрыв на середине не оставит
 * список людей обрезанным. Отступы сохраняются — файл читают глазами.
 */
function save(store) {
  store.updatedAt = new Date().toISOString();
  const file = filePath();
  const tmp = `${file}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
  cache = store;
  try { cacheMtimeMs = fs.statSync(file).mtimeMs; } catch { cacheMtimeMs = 0; }
}

/**
 * Изменение состава людей. Перед записью файл перечитывается: владелец мог
 * править его руками прямо сейчас, и затирать эту правку нельзя.
 */
function mutate(fn) {
  const store = readFileIfChanged();
  const result = fn(store);
  save(store);
  return result;
}

/* ---------------- имена ---------------- */

/** Сравнение имён: регистр и лишние пробелы значения не имеют, «ё» = «е». */
function normName(s) {
  // NFC обязателен: «Иванов» в составном и разложенном виде — разные строки,
  // и один и тот же человек завёлся бы дважды
  return String(s || '').normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase().replace(/ё/g, 'е');
}

function cleanName(s) {
  return String(s || '').normalize('NFC').trim().replace(/\s+/g, ' ').slice(0, NAME_MAX);
}

function validNames(lastName, firstName) {
  const last = cleanName(lastName);
  const first = cleanName(firstName);
  if (!NAME_RE.test(last) || !NAME_RE.test(first)) return null;
  return { lastName: last, firstName: first };
}

/**
 * Адрес пишем, только если это действительно адрес: за прокси значение
 * приходит из заголовка и управляется клиентом, а журнал посещений владелец
 * читает как факт.
 */
function cleanIp(ip) {
  const s = String(ip || '').replace(/^::ffff:/, '');
  return net.isIP(s) ? s : '';
}

/* ---------------- поиск и вход ---------------- */

function state() {
  const store = readFileIfChanged();
  return {
    registration: store.registration,
    total: store.users.length,
    pending: store.users.filter((u) => !u.approved).length,
  };
}

function find(lastName, firstName) {
  const store = readFileIfChanged();
  const ln = normName(lastName);
  const fn = normName(firstName);
  return store.users.find((u) => normName(u.lastName) === ln && normName(u.firstName) === fn) || null;
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

/** Человек по токену. Токен в файле лежит хэшем — сравнение по нему же. */
function byToken(token) {
  if (!token || String(token).length < 32) return null;
  const store = readFileIfChanged();
  const hash = hashToken(token);
  return store.users.find((u) => u.tokenHash && u.tokenHash === hash) || null;
}

/**
 * Человек по идентификатору. Нужен там, где токена на руках нет: у проекта
 * хранится `user_id`, и по нему решается доступ к облачным моделям.
 */
function byId(id) {
  if (!id) return null;
  const store = readFileIfChanged();
  return store.users.find((u) => u.id === String(id)) || null;
}

function publicUser(u) {
  return u && {
    id: u.id,
    lastName: u.lastName,
    firstName: u.firstName,
    approved: u.approved,
    // интерфейсу нужно знать, показывать ли облачные модели вообще
    cloudAi: u.cloudAi === true,
    // владелец платформы: видит расход всех и деньги на счетах провайдеров
    owner: u.owner === true,
    // допущен к чужой статистике без прочих прав владельца
    statsAll: u.statsAll === true,
  };
}

/** Все записи — для переключателя людей на вкладке «Статистика». */
function list() {
  return readFileIfChanged().users.slice();
}

/**
 * Может ли человек смотреть чужую статистику.
 *
 * Право отдельное от cloudAi: разрешение тратить деньги и разрешение видеть,
 * кто их тратит, — разные вещи, и связывать их значит выдать первое вместе
 * со вторым по недосмотру.
 */
function canSeeAllStats(u) {
  return !!(u && u.approved && (u.owner === true || u.statsAll === true));
}

/** Последние адреса и устройства — без истории: хранится ровно то, что нужно. */
function touch(userId, { ip = '', deviceId = '' } = {}) {
  mutate((store) => {
    const u = store.users.find((x) => x.id === userId);
    if (!u) return null;
    u.lastSeenAt = new Date().toISOString();
    const addr = cleanIp(ip);
    if (addr) u.lastIps = [...u.lastIps.filter((x) => x !== addr), addr].slice(-MAX_IPS_PER_USER);
    if (deviceId) {
      u.devices = [...u.devices.filter((x) => x !== deviceId), deviceId].slice(-MAX_IPS_PER_USER);
    }
    return u;
  });
}

/**
 * Вход или регистрация — одной дверью.
 *
 * Ответ намеренно НЕ различает «такого человека нет» и «он есть, но не
 * одобрен»: иначе форма входа превращается в проверялку, кто зарегистрирован
 * на платформе. Наружу уходит либо токен, либо «ждите одобрения».
 *
 * @returns {{status:'active'|'pending'|'invalid', token?:string, user?:object}}
 */
function enter({ lastName, firstName, ip = '', deviceId = '' }) {
  const names = validNames(lastName, firstName);
  if (!names) return { status: 'invalid' };

  return mutate((store) => {
    let user = store.users.find(
      (u) => normName(u.lastName) === normName(names.lastName)
        && normName(u.firstName) === normName(names.firstName),
    );

    if (!user) {
      if (store.users.length >= MAX_USERS) return { status: 'pending' }; // тихий предел: список не раздуваем
      user = {
        lastName: names.lastName,
        firstName: names.firstName,
        // свободная регистрация — сразу впускаем; «по одобрению» — ждём владельца
        approved: store.registration === 'free',
        // облако новому человеку не открывается никогда: только руками владельца
        cloudAi: false,
        note: '',
        id: `u_${crypto.randomBytes(8).toString('hex')}`,
        createdAt: new Date().toISOString(),
        lastSeenAt: '',
        lastIps: [],
        devices: [],
        tokenHash: '',
      };
      store.users.push(user);
    }

    user.lastSeenAt = new Date().toISOString();
    const addr = cleanIp(ip);
    if (addr) user.lastIps = [...user.lastIps.filter((x) => x !== addr), addr].slice(-MAX_IPS_PER_USER);
    if (deviceId) user.devices = [...user.devices.filter((x) => x !== deviceId), deviceId].slice(-MAX_IPS_PER_USER);

    if (!user.approved) return { status: 'pending', user: publicUser(user) };

    // токен выдаётся новый на каждый вход: старый перестаёт работать
    const token = crypto.randomBytes(32).toString('hex');
    user.tokenHash = hashToken(token);
    return { status: 'active', token, user: publicUser(user) };
  });
}

/** Выход: токен обнуляется, файл остаётся. */
function logout(token) {
  const u = byToken(token);
  if (!u) return false;
  mutate((store) => {
    const found = store.users.find((x) => x.id === u.id);
    if (found) found.tokenHash = '';
  });
  return true;
}

/** Создание файла при первом старте — чтобы владелец сразу его увидел. */
function init() {
  const file = filePath();
  if (!fs.existsSync(file)) {
    save(emptyStore());
    console.log(`[users] создан файл пользователей: ${file}`);
  } else {
    readFileIfChanged();
  }
  const s = state();
  console.log(`[users] регистрация: ${s.registration === 'free' ? 'свободная' : 'по одобрению'} · людей: ${s.total}` +
    (s.pending ? ` · ждут одобрения: ${s.pending}` : ''));
}

module.exports = {
  init, state, enter, logout, byToken, byId, find, touch, publicUser, list, canSeeAllStats,
  normName, cleanName, validNames, hashToken,
  MAX_USERS, NAME_MAX,
  _readFileIfChanged: readFileIfChanged,
};
