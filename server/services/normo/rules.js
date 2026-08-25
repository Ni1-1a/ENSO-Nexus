'use strict';
/**
 * Каталог правил нормоконтроля. Источник истины — YAML-файлы «нормоконтроль/rules/»;
 * БД правила не хранит, воспроизводимость прогонов дают rulesHash (весь каталог)
 * и ruleHash (снимок конкретного правила) в analysis_runs/findings.
 *
 * Жёсткое правило Этапа 1: правило без source.ntd + source.clause не принимается —
 * загрузчик его отбрасывает с ошибкой, а не пропускает молча.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const yaml = require('js-yaml');
const config = require('../../config');

const SEVERITIES = new Set(['critical', 'major', 'minor', 'remark']);
const AUTOS = new Set(['llm', 'deterministic', 'manual']);
const SCOPES = new Set(['document', 'cross_section']);

let cache = null; // { rules, byId, rulesHash, files, loadedAt, mtimeKey }

function rulesDir() {
  return path.join(config.normoKbDir, 'rules');
}

function mtimeKey(dir) {
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.yaml'))
    .sort()
    .map((f) => {
      const st = fs.statSync(path.join(dir, f));
      return `${f}:${st.size}:${st.mtimeMs}`;
    })
    .join('|');
}

function validateRule(rule, file) {
  const где = `${file} → ${rule && rule.id ? rule.id : JSON.stringify(rule).slice(0, 60)}`;
  if (!rule || typeof rule !== 'object') throw new Error(`Правило не объект: ${где}`);
  for (const field of ['id', 'title', 'scope', 'severity', 'auto', 'wording']) {
    if (!rule[field]) throw new Error(`У правила нет поля «${field}»: ${где}`);
  }
  if (!SCOPES.has(rule.scope)) throw new Error(`Недопустимый scope «${rule.scope}»: ${где}`);
  if (!SEVERITIES.has(rule.severity)) throw new Error(`Недопустимая severity «${rule.severity}»: ${где}`);
  if (!AUTOS.has(rule.auto)) throw new Error(`Недопустимый auto «${rule.auto}»: ${где}`);
  if (!rule.source || !rule.source.ntd || !rule.source.clause) {
    throw new Error(`Правило без source.ntd+clause не принимается: ${где}`);
  }
  if (!rule.check || !rule.check.type || !rule.check.description) {
    throw new Error(`У правила нет check.type/description: ${где}`);
  }
  if (!Array.isArray(rule.applies_to) || !rule.applies_to.length) {
    throw new Error(`applies_to пуст: ${где}`);
  }
}

function ruleHash(rule) {
  return crypto.createHash('sha256').update(JSON.stringify(rule)).digest('hex').slice(0, 16);
}

/** Загрузка каталога; кэш сбрасывается по mtime файлов — правку подхватит следующий прогон. */
function load() {
  const dir = rulesDir();
  const key = mtimeKey(dir);
  if (cache && cache.mtimeKey === key) return cache;

  const rules = [];
  const byId = new Map();
  const files = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.yaml')).sort()) {
    const list = yaml.load(fs.readFileSync(path.join(dir, f), 'utf8'));
    if (!Array.isArray(list)) throw new Error(`Файл правил не список: ${f}`);
    for (const rule of list) {
      validateRule(rule, f);
      if (byId.has(rule.id)) throw new Error(`Дубль id правила «${rule.id}» (${f} и ${byId.get(rule.id).file})`);
      const entry = { ...rule, file: f, hash: ruleHash(rule) };
      byId.set(rule.id, entry);
      rules.push(entry);
    }
    files.push(f);
  }
  const rulesHash = crypto.createHash('sha256')
    .update(rules.map((r) => `${r.id}:${r.hash}`).join('|'))
    .digest('hex').slice(0, 16);
  cache = { rules, byId, rulesHash, files, loadedAt: new Date().toISOString(), mtimeKey: key };
  return cache;
}

/**
 * Правила для документного прогона раздела: common (applies_to «все») + свой шифр.
 * cross_section-правила в документный прогон не входят.
 */
function forSection(code, stage) {
  const { rules } = load();
  return rules.filter((r) => r.scope === 'document'
    && (r.applies_to.includes('все') || r.applies_to.includes(code))
    && (!stage || !Array.isArray(r.stage) || r.stage.includes(stage)));
}

function forCrossSection(stage) {
  const { rules } = load();
  return rules.filter((r) => r.scope === 'cross_section'
    && (!stage || !Array.isArray(r.stage) || r.stage.includes(stage)));
}

function get(id) {
  return load().byId.get(id) || null;
}

module.exports = { load, forSection, forCrossSection, get, ruleHash };
