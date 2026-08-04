'use strict';
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const config = require('./config');

fs.mkdirSync(config.dataDir, { recursive: true });
fs.mkdirSync(path.join(config.dataDir, 'uploads'), { recursive: true });
fs.mkdirSync(path.join(config.dataDir, 'outputs'), { recursive: true });

const db = new DatabaseSync(path.join(config.dataDir, 'app.db'));
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  token TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',           -- active | deleted
  job_status TEXT NOT NULL DEFAULT 'idle',         -- idle | queued | running | needs_clarification | completed | failed
  comment TEXT DEFAULT '',
  summary TEXT DEFAULT '',                         -- rolling conversation summary (memory)
  prompt_version TEXT,
  ai_requests INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL,                              -- user | assistant | system
  kind TEXT NOT NULL DEFAULT 'chat',               -- chat | comment | answer | result | error
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, created_at);
CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  original_name TEXT NOT NULL,
  stored_path TEXT NOT NULL,
  size INTEGER NOT NULL,
  ext TEXT NOT NULL,
  mime TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS questions (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  why TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',          -- pending | answered | needs_followup | closed
  answer TEXT,
  created_at TEXT NOT NULL,
  answered_at TEXT
);
CREATE TABLE IF NOT EXISTS facts (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  source TEXT DEFAULT '',
  created_at TEXT NOT NULL,
  UNIQUE(session_id, key)
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  stage TEXT NOT NULL,
  detail TEXT DEFAULT '',
  level TEXT NOT NULL DEFAULT 'info',              -- info | warn | error
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS results (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  title TEXT DEFAULT '',
  format TEXT NOT NULL,
  size INTEGER NOT NULL,
  stored_path TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`);

// лёгкие миграции: добавление колонок в существующие таблицы
for (const sql of [
  "ALTER TABLE sessions ADD COLUMN ai_provider TEXT DEFAULT ''",
  "ALTER TABLE sessions ADD COLUMN ai_model TEXT DEFAULT ''",
  "ALTER TABLE sessions ADD COLUMN kb_choice TEXT DEFAULT 'main'",
]) {
  try { db.exec(sql); } catch { /* колонка уже есть */ }
}

const now = () => new Date().toISOString();

module.exports = { db, now };
