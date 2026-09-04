'use strict';
/**
 * БД модуля «Нормоконтроль» — собственный PostgreSQL + pgvector, отдельный от
 * SQLite приложения (решение Этапа 2, согласовано 24.08.2026). Подключение —
 * NORMO_DATABASE_URL; по умолчанию локальный brew-инстанс на порту 5433
 * (5432 занят системным PostgreSQL 18 без pgvector).
 */
const fs = require('fs');
const path = require('path');
const pg = require('pg');
const config = require('../../config');

const { Pool } = pg;
// DATE (oid 1082) — строкой как есть: pg по умолчанию делает из неё Date в
// местной зоне, и date_started «2026-08-01» уезжало клиенту как
// «2026-07-31T21:00:00.000Z». Дата без времени временем и не является.
pg.types.setTypeParser(1082, (v) => v);

let pool = null;

function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: config.normoDatabaseUrl,
      max: 10,
      // Модуль не должен вешать HTTP при упавшей БД: быстрый отказ + внятная ошибка.
      connectionTimeoutMillis: 5000,
    });
    pool.on('error', (err) => console.error('[normo/db] пул:', err.message));
  }
  return pool;
}

async function query(text, params) {
  return getPool().query(text, params);
}

/** Транзакция: fn получает клиент, ошибка откатывает. */
async function tx(fn) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* соединение могло умереть */ }
    throw err;
  } finally {
    client.release();
  }
}

// Один общий promise: параллельные первые запросы к модулю не должны наперегонки
// выполнять CREATE EXTENSION/CREATE TABLE (гонка давала 23505 и 500-ку клиенту).
let migration = null;
async function migrate() {
  if (!migration) {
    const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
    migration = query(sql).catch((err) => { migration = null; throw err; });
  }
  return migration;
}

async function health() {
  const r = await query(
    "SELECT current_database() AS db, (SELECT extversion FROM pg_extension WHERE extname='vector') AS pgvector",
  );
  return r.rows[0];
}

async function close() {
  if (pool) { await pool.end(); pool = null; migration = null; }
}

module.exports = { query, tx, migrate, health, close, getPool };
