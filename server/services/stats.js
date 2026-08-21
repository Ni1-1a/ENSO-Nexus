'use strict';
/**
 * Расход на модели: сводки для вкладки «Статистика».
 *
 * Источник — таблица usage_events: строка на каждое обращение к модели
 * (см. claude/adapter.js, recordUsage). Итоги в самой сессии сюда не годятся:
 * из суммы нельзя достать ни график по дням, ни разбивку по моделям.
 *
 * ВАЖНО про глубину истории. События пишутся с момента появления таблицы;
 * всё, что случилось раньше, существует только суммами в сессиях. Поэтому
 * рядом с любым периодом отдаётся `since` — дата первого события, — и
 * интерфейс обязан её показывать. Молчаливый график, который начинается
 * с середины, читается как «до этого не работали», а это неправда.
 */
const { db } = require('../db');
const users = require('./users');
const config = require('../config');

/** День в местном часовом поясе сервера: ISO-строка режет по UTC и сдвигает сутки. */
function localDay(iso) {
  const d = new Date(iso);
  const tz = d.getTimezoneOffset() * 60000;
  return new Date(d.getTime() - tz).toISOString().slice(0, 10);
}

function periodStart(days) {
  if (!days || days <= 0) return null;
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - (days - 1));
  return d.toISOString();
}

/**
 * Условие выборки. `userId` пустой — расход всех, включая проекты без хозяина
 * (заведённые до входа по имени). Это осознанно: владельцу нужен весь счёт,
 * а не только та его часть, которую удалось привязать к человеку.
 */
function where({ userId = '', days = 30 } = {}) {
  const clauses = [];
  const args = [];
  const from = periodStart(days);
  if (from) { clauses.push('created_at >= ?'); args.push(from); }
  if (userId) { clauses.push('user_id = ?'); args.push(userId); }
  return { sql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', args };
}

const num = (v) => Math.round((Number(v) || 0) * 1e6) / 1e6;

/** Сводка расхода. Возвращает готовые к показу ряды, без сырых строк событий. */
function overview({ userId = '', days = 30 } = {}) {
  const w = where({ userId, days });

  const totals = db.prepare(`
    SELECT COUNT(*) requests,
           SUM(internal = 0) mainRequests,
           SUM(internal = 1) internalRequests,
           COALESCE(SUM(input_tokens), 0) inputTokens,
           COALESCE(SUM(output_tokens), 0) outputTokens,
           COALESCE(SUM(cache_write_tokens), 0) cacheWriteTokens,
           COALESCE(SUM(cache_read_tokens), 0) cacheReadTokens,
           COALESCE(SUM(cost_usd), 0) costUsd,
           COUNT(DISTINCT session_id) projects
    FROM usage_events ${w.sql}`).get(...w.args);

  const byDayRows = db.prepare(`
    SELECT created_at, input_tokens i, output_tokens o, cost_usd c
    FROM usage_events ${w.sql}`).all(...w.args);
  const dayMap = new Map();
  for (const r of byDayRows) {
    const day = localDay(r.created_at);
    const cur = dayMap.get(day) || { day, requests: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
    cur.requests += 1;
    cur.inputTokens += r.i;
    cur.outputTokens += r.o;
    cur.costUsd += r.c;
    dayMap.set(day, cur);
  }
  // дни без единого запроса тоже нужны: иначе столбики «съезжаются» и неделя
  // с одним рабочим днём выглядит такой же плотной, как рабочая неделя
  const byDay = [];
  const from = periodStart(days);
  if (from) {
    for (let d = new Date(from); d <= new Date(); d.setDate(d.getDate() + 1)) {
      const key = localDay(d.toISOString());
      byDay.push(dayMap.get(key) || { day: key, requests: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 });
    }
  } else {
    byDay.push(...[...dayMap.values()].sort((a, b) => a.day.localeCompare(b.day)));
  }

  const byModel = db.prepare(`
    SELECT provider, model,
           COUNT(*) requests,
           COALESCE(SUM(input_tokens), 0) inputTokens,
           COALESCE(SUM(output_tokens), 0) outputTokens,
           COALESCE(SUM(cost_usd), 0) costUsd
    FROM usage_events ${w.sql}
    GROUP BY provider, model
    ORDER BY costUsd DESC, requests DESC`).all(...w.args);

  const byProvider = db.prepare(`
    SELECT provider,
           COUNT(*) requests,
           COALESCE(SUM(input_tokens + output_tokens), 0) tokens,
           COALESCE(SUM(cost_usd), 0) costUsd
    FROM usage_events ${w.sql}
    GROUP BY provider
    ORDER BY costUsd DESC, requests DESC`).all(...w.args);

  const byProject = db.prepare(`
    SELECT e.session_id id,
           COALESCE(NULLIF(s.title, ''), 'без названия') title,
           COUNT(*) requests,
           COALESCE(SUM(e.input_tokens + e.output_tokens), 0) tokens,
           COALESCE(SUM(e.cost_usd), 0) costUsd,
           MAX(e.created_at) lastAt
    FROM usage_events e LEFT JOIN sessions s ON s.id = e.session_id
    ${w.sql ? w.sql.replace(/created_at/g, 'e.created_at').replace(/user_id/g, 'e.user_id') : ''}
    GROUP BY e.session_id
    ORDER BY costUsd DESC, requests DESC
    LIMIT 20`).all(...w.args);

  const wAll = where({ days });
  const byUser = db.prepare(`
    SELECT user_id id,
           COUNT(*) requests,
           COALESCE(SUM(input_tokens + output_tokens), 0) tokens,
           COALESCE(SUM(cost_usd), 0) costUsd
    FROM usage_events ${wAll.sql}
    GROUP BY user_id
    ORDER BY costUsd DESC, requests DESC`).all(...wAll.args)
    .map((r) => {
      const u = r.id ? users.byId(r.id) : null;
      return {
        id: r.id || '',
        name: u ? `${u.lastName} ${u.firstName}`.trim() : (r.id ? 'удалённая запись' : 'без входа (старые проекты)'),
        requests: r.requests, tokens: r.tokens, costUsd: num(r.costUsd),
      };
    });

  const firstEvent = db.prepare('SELECT MIN(created_at) m FROM usage_events').get().m || null;

  return {
    period: { days: days || 0, from: from || firstEvent, to: new Date().toISOString() },
    since: firstEvent,          // с какого момента вообще есть события
    totals: {
      requests: totals.requests || 0,
      mainRequests: totals.mainRequests || 0,
      internalRequests: totals.internalRequests || 0,
      inputTokens: totals.inputTokens || 0,
      outputTokens: totals.outputTokens || 0,
      cacheWriteTokens: totals.cacheWriteTokens || 0,
      cacheReadTokens: totals.cacheReadTokens || 0,
      costUsd: num(totals.costUsd),
      projects: totals.projects || 0,
      avgCostPerRequest: totals.requests ? num(totals.costUsd / totals.requests) : 0,
      avgTokensPerRequest: totals.requests
        ? Math.round((totals.inputTokens + totals.outputTokens) / totals.requests) : 0,
    },
    byDay,
    byModel: byModel.map((r) => ({ ...r, costUsd: num(r.costUsd) })),
    byProvider: byProvider.map((r) => ({ ...r, costUsd: num(r.costUsd) })),
    byProject: byProject.map((r) => ({ ...r, costUsd: num(r.costUsd) })),
    byUser,
    limits: {
      maxAiRequestsPerSession: config.maxAiRequestsPerSession,
      maxTokensPerSession: config.maxTokensPerSession,
    },
  };
}

/**
 * Люди для переключателя.
 *
 * Здесь именно ВСЕ одобренные, а не только те, у кого уже есть расход: пустая
 * статистика человека — тоже ответ, и её надо иметь возможность посмотреть.
 */
function people() {
  const spend = new Map(
    db.prepare('SELECT user_id id, COALESCE(SUM(cost_usd),0) c, COUNT(*) n FROM usage_events GROUP BY user_id')
      .all().map((r) => [r.id || '', r]),
  );
  const list = users.list().filter((u) => u.approved).map((u) => {
    const s = spend.get(u.id) || { c: 0, n: 0 };
    return {
      id: u.id,
      name: `${u.lastName} ${u.firstName}`.trim(),
      cloudAi: u.cloudAi === true,
      requests: s.n,
      costUsd: num(s.c),
    };
  });
  // проекты, заведённые до входа по имени, хозяина не имеют — но их расход
  // реален, и прятать его нельзя
  const orphan = spend.get('');
  if (orphan && orphan.n) {
    list.push({ id: '', name: 'без входа (старые проекты)', cloudAi: false, requests: orphan.n, costUsd: num(orphan.c) });
  }
  return list.sort((a, b) => b.costUsd - a.costUsd || a.name.localeCompare(b.name));
}

module.exports = { overview, people, localDay };
