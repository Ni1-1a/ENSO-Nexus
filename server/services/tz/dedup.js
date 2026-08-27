'use strict';
/**
 * Детерминированная часть анализа ТЗ: дедупликация находок, вердикт, готовность.
 *
 * Правило платформы то же, что в геометрии: модель ИНТЕРПРЕТИРУЕТ, код СЧИТАЕТ.
 * Пороги вердикта и слияние дубликатов — арифметика, ей модель не нужна
 * (спека proverka-znp.md v1.1, правки 3–4). Функции чистые — тестируются без
 * сервера и без модели.
 */
const { SEVERITIES } = require('./checklists');

const SEVERITY_RANK = Object.fromEntries(SEVERITIES.map((s, i) => [s, i])); // меньше — серьёзнее

/** Нормализация для ключа слияния: регистр, пробелы, пунктуация не различают дефект. */
function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[«»"'.,;:()\[\]–—-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Ключ слияния: пункт ЗнП + суть дефекта (спека v1.1, правка 4). */
function findingKey(f) {
  return `${normalize(f.znp_ref)}|${normalize(f.problem).slice(0, 80)}`;
}

/**
 * Дедупликация: находки об одном пункте и одном дефекте сливаются в одну.
 * Объединённая находка получает максимальную severity исходных и все их
 * источники. Порядок на выходе стабилен: по severity, затем по znp_ref.
 */
function dedupe(findings) {
  const map = new Map();
  for (const f of findings) {
    const key = findingKey(f);
    const prev = map.get(key);
    if (!prev) {
      map.set(key, { ...f, sources: f.requirement_source ? [f.requirement_source] : [] });
      continue;
    }
    if ((SEVERITY_RANK[f.severity] ?? 99) < (SEVERITY_RANK[prev.severity] ?? 99)) {
      prev.severity = f.severity;
      prev.consequence = f.consequence || prev.consequence;
    }
    if (f.requirement_source) prev.sources.push(f.requirement_source);
    if (!prev.quote && f.quote) prev.quote = f.quote;
    if (!prev.proposed_text && f.proposed_text) prev.proposed_text = f.proposed_text;
    prev.needs_human = prev.needs_human || !!f.needs_human;
  }
  const out = [...map.values()].map((f) => {
    // источники тоже дедуплицируются — по документу и пункту
    const seen = new Set();
    f.sources = (f.sources || []).filter((s) => {
      const k = `${s && s.doc}|${s && s.clause}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    f.requirement_source = f.sources[0] || null;
    return f;
  });
  out.sort((a, b) => (SEVERITY_RANK[a.severity] ?? 99) - (SEVERITY_RANK[b.severity] ?? 99)
    || String(a.znp_ref).localeCompare(String(b.znp_ref), 'ru'));
  out.forEach((f, i) => { f.id = `F-${String(i + 1).padStart(3, '0')}`; });
  return out;
}

/**
 * Вердикт по дедуплицированным находкам (спека v1.1, правка 3):
 *   ≥1 БЛОКЕР → «не готово к выдаче»;
 *   0 БЛОКЕР и ≥1 СУЩЕСТВЕННО → «условно готово»;
 *   иначе → «готово».
 */
function verdict(findings, matrix) {
  const blocking = findings.filter((f) => f.severity === 'БЛОКЕР').length;
  const major = findings.filter((f) => f.severity === 'СУЩЕСТВЕННО').length;
  const status = blocking ? 'не готово к выдаче' : major ? 'условно готово' : 'готово';
  return {
    readiness_percent: readiness(matrix),
    blocking_count: blocking,
    status,
    top_risks: findings.slice(0, 3).map((f) => `${f.severity}: ${f.problem}`.slice(0, 200)),
  };
}

/** Готовность: доля пунктов чек-листа ЕСТЬ; НЕПРИМЕНИМО — вне знаменателя. */
function readiness(matrix) {
  const counted = (matrix || []).filter((m) => m.status !== 'НЕПРИМЕНИМО');
  if (!counted.length) return 0;
  const have = counted.filter((m) => m.status === 'ЕСТЬ').length;
  return Math.round((have / counted.length) * 100);
}

module.exports = { dedupe, verdict, readiness, findingKey, normalize, SEVERITY_RANK };
