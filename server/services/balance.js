'use strict';
/**
 * Деньги на счетах провайдеров.
 *
 * Честность источника здесь важнее полноты картины, поэтому у каждого числа
 * стоит `source`, и интерфейс обязан его показывать:
 *
 *   'api'    — цифра пришла от провайдера. Такое умеет только Kimi (Moonshot):
 *              GET /users/me/balance отдаёт available_balance.
 *   'оценка' — «внесено минус потрачено». Внесённое вводится руками
 *              (таблица credit_topups), потраченное считает платформа по
 *              тарифам из pricing.js.
 *   'нет'    — сказать нечего.
 *
 * Почему у Anthropic нет живого баланса. Кредиты организации существуют и
 * действительно общие на все workspace, но НИ ОДНА ручка Admin API их не
 * отдаёт: там участники, приглашения, workspace, ключи, служебные записи,
 * федерация, отчёт о расходе (cost_report), отчёт об использовании и лимиты —
 * и всё (проверено по документации 21.08.2026). Поэтому расход тянем из
 * cost_report, если задан ANTHROPIC_ADMIN_KEY, а остаток считаем оценкой.
 *
 * Ни одна ошибка провайдера не имеет права уронить вкладку: каждый источник
 * отвечает за себя и при сбое возвращает `note` вместо числа.
 */
const config = require('../config');
const { db, now } = require('../db');

const CACHE_MS = 120000;
const cache = new Map();   // providerId → {at, value}

async function cached(key, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const value = await fn();
  cache.set(key, { at: Date.now(), value });
  return value;
}

/* ---------------- пополнения, внесённые руками ---------------- */

function topups(provider = '') {
  const rows = provider
    ? db.prepare('SELECT * FROM credit_topups WHERE provider = ? ORDER BY happened_at DESC').all(provider)
    : db.prepare('SELECT * FROM credit_topups ORDER BY happened_at DESC').all();
  return rows.map((r) => ({
    id: r.id, provider: r.provider, amountUsd: r.amount_usd,
    note: r.note || '', happenedAt: r.happened_at, author: r.author || '',
  }));
}

function addTopup({ provider, amountUsd, note = '', happenedAt = '', author = '' }) {
  const amount = Number(amountUsd);
  if (!provider) throw Object.assign(new Error('Не указан провайдер пополнения'), { expected: true });
  if (!Number.isFinite(amount) || amount === 0) {
    throw Object.assign(new Error('Сумма пополнения должна быть числом и не нулём'), { expected: true });
  }
  const when = happenedAt || now();
  db.prepare(`INSERT INTO credit_topups (provider, amount_usd, note, happened_at, author, created_at)
              VALUES (?,?,?,?,?,?)`)
    .run(String(provider), amount, String(note).slice(0, 200), when, String(author).slice(0, 120), now());
  cache.clear();
  return topups(provider);
}

function removeTopup(id) {
  const r = db.prepare('DELETE FROM credit_topups WHERE id = ?').run(id);
  cache.clear();
  return r.changes > 0;
}

/* ---------------- живой баланс: Kimi ---------------- */

async function kimiBalance() {
  if (!config.kimiApiKey) return { source: 'нет', note: 'нужен KIMI_API_KEY на сервере' };
  try {
    const res = await fetch(`${config.kimiBaseUrl}/users/me/balance`, {
      headers: { Authorization: `Bearer ${config.kimiApiKey}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return { source: 'нет', note: `провайдер ответил ${res.status}` };
    const data = await res.json();
    const d = data && data.data ? data.data : data;
    const value = Number(d.available_balance);
    if (!Number.isFinite(value)) return { source: 'нет', note: 'провайдер не вернул сумму' };
    return {
      source: 'api',
      availableUsd: value,
      // у Moonshot к available_balance идут ещё «живые» и «подаренные» деньги
      cashUsd: Number.isFinite(Number(d.cash_balance)) ? Number(d.cash_balance) : null,
      voucherUsd: Number.isFinite(Number(d.voucher_balance)) ? Number(d.voucher_balance) : null,
    };
  } catch (err) {
    return { source: 'нет', note: `не удалось спросить провайдера: ${err.message}` };
  }
}

/* ---------------- фактический расход: Anthropic Admin API ---------------- */

/**
 * Расход организации за период по данным биллинга.
 * Без admin-ключа возвращает null — и это не ошибка, а обычное состояние.
 */
async function anthropicSpend(days = 30) {
  if (!config.anthropicAdminKey) return null;
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (days - 1));
  /*
   * Той же дорогой, что и запросы к моделям. Иначе получается дыра, которую
   * не видно: вкладка «Статистика» ходила бы в api.anthropic.com напрямую с
   * московской машины, и никакой гейт этого не заметил бы — это не вызов
   * модели, а служебный запрос.
   */
  const url = `${config.anthropicBaseUrl || 'https://api.anthropic.com'}/v1/organizations/cost_report`
    + `?starting_at=${encodeURIComponent(start.toISOString())}&limit=31`;
  try {
    const res = await fetch(url, {
      headers: {
        'anthropic-version': '2023-06-01',
        'x-api-key': config.anthropicAdminKey,
      },
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { error: res.status === 401 || res.status === 403
        ? 'admin-ключ не принят: нужен ключ вида sk-ant-admin… из консоли организации'
        : `отчёт о расходе не получен (${res.status}) ${body.slice(0, 120)}` };
    }
    const data = await res.json();
    let total = 0;
    for (const bucket of data.data || []) {
      for (const item of bucket.results || []) {
        const amount = item.amount ?? (item.cost && item.cost.amount);
        total += Number(amount) || 0;
      }
    }
    return { spentUsd: total, days };
  } catch (err) {
    return { error: `отчёт о расходе не получен: ${err.message}` };
  }
}

/* ---------------- собственный счётчик платформы ---------------- */

function ownSpend(provider) {
  const r = db.prepare('SELECT COALESCE(SUM(cost_usd),0) c, COUNT(*) n FROM usage_events WHERE provider = ?')
    .get(provider);
  return { spentUsd: Math.round((r.c || 0) * 1e6) / 1e6, requests: r.n || 0 };
}

/* ---------------- сборка ---------------- */

/** Провайдеры, у которых вообще бывают деньги: локальные модели бесплатны. */
const PAID = [
  { id: 'claude', label: 'Claude (Anthropic)' },
  { id: 'kimi', label: 'Kimi (Moonshot AI)' },
  { id: 'gemini', label: 'Gemini (Google)' },
  { id: 'chatgpt', label: 'ChatGPT (OpenAI)' },
];

/**
 * Состояние счетов по каждому платному провайдеру.
 * @param {number} days период для отчёта о расходе
 */
async function forProviders(days = 30) {
  const list = topups();
  const [kimi, anthropic] = await Promise.all([
    cached('kimi', kimiBalance),
    cached(`anthropic:${days}`, () => anthropicSpend(days)),
  ]);

  return PAID.map((p) => {
    const own = ownSpend(p.id);
    const paid = list.filter((t) => t.provider === p.id);
    const toppedUp = paid.reduce((s, t) => s + t.amountUsd, 0);
    const entry = {
      id: p.id,
      label: p.label,
      keyConfigured: !!({
        claude: config.anthropicApiKey, kimi: config.kimiApiKey,
        gemini: config.geminiApiKey, chatgpt: config.openaiApiKey,
      }[p.id]),
      ownSpentUsd: own.spentUsd,
      ownRequests: own.requests,
      toppedUpUsd: Math.round(toppedUp * 1e6) / 1e6,
      topups: paid,
      balance: { source: 'нет', note: '' },
    };

    if (p.id === 'kimi' && kimi.source === 'api') {
      entry.balance = { source: 'api', availableUsd: kimi.availableUsd, cashUsd: kimi.cashUsd, voucherUsd: kimi.voucherUsd };
    } else if (toppedUp > 0) {
      // фактический расход биллинга точнее собственного счётчика — если он есть
      const spent = (p.id === 'claude' && anthropic && anthropic.spentUsd !== undefined)
        ? anthropic.spentUsd : own.spentUsd;
      entry.balance = {
        source: 'оценка',
        availableUsd: Math.round((toppedUp - spent) * 1e6) / 1e6,
        basis: (p.id === 'claude' && anthropic && anthropic.spentUsd !== undefined)
          ? 'внесено минус расход по отчёту Anthropic'
          : 'внесено минус расход по счётчику платформы',
      };
    } else if (entry.keyConfigured) {
      entry.balance = {
        source: 'нет',
        note: p.id === 'kimi' ? (kimi.note || 'баланс не получен')
          : 'провайдер не отдаёт остаток по API — внесите пополнение, чтобы считать остаток',
      };
    } else {
      entry.balance = { source: 'нет', note: 'ключ не задан на сервере' };
    }

    if (p.id === 'claude') {
      entry.billing = config.anthropicAdminKey
        ? (anthropic && anthropic.error ? { error: anthropic.error } : { spentUsd: anthropic ? anthropic.spentUsd : null, days })
        : { note: 'задайте ANTHROPIC_ADMIN_KEY, чтобы видеть расход по данным биллинга, а не по нашей оценке' };
    }
    return entry;
  });
}

module.exports = { forProviders, topups, addTopup, removeTopup };
