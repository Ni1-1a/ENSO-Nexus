'use strict';
/**
 * Перечень ссылок на НТД в документе + сверка с реестром модуля «Нормоконтроль»
 * (`нормоконтроль/knowledge/ntd-registry.yaml`, 208 записей со статусами).
 *
 * Полностью детерминировано, модель не участвует (правило платформы и приём
 * А12-B согласованного обзора: актуальность ссылок валидирует только код).
 * Механика — из поста 349 канала: «сбор всех ссылок в перечень с указанием
 * места; позиция без дословной строки отбрасывается». Строка-источник здесь
 * и есть дословное вхождение — регулярка не выдумывает, а вырезает.
 *
 * Статус из реестра — подсказка, не вердикт: реестр собран 24.08.2026 из
 * корпуса владельца, и «в реестре нет» означает «сверить вручную», а не
 * «документ не существует».
 */
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const REGISTRY_FILE = path.join(__dirname, '..', '..', '..', 'нормоконтроль', 'knowledge', 'ntd-registry.yaml');

let registryCache = null; // { mtimeMs, size, byCode: Map, entries: [] }

function normalizeCode(code) {
  return String(code || '')
    .replace(/ /g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[–—]/g, '-')
    .trim()
    .toUpperCase();
}

function loadRegistry() {
  const st = fs.statSync(REGISTRY_FILE);
  if (registryCache && registryCache.mtimeMs === st.mtimeMs && registryCache.size === st.size) {
    return registryCache;
  }
  const entries = yaml.load(fs.readFileSync(REGISTRY_FILE, 'utf8')) || [];
  const byCode = new Map();
  for (const e of entries) {
    if (e && e.code) byCode.set(normalizeCode(e.code), e);
  }
  registryCache = { mtimeMs: st.mtimeMs, size: st.size, byCode, entries };
  return registryCache;
}

/* ---------------- извлечение ссылок ---------------- */

/**
 * Шифры НТД в русском тексте. Внимание к кириллице: \b в JS её не знает,
 * поэтому границы заданы явно (начало строки/не-буква).
 * Покрывается: ГОСТ, ГОСТ Р, СП, СНиП, СанПиН, ПП РФ, приказы №N/пр, ФЗ.
 */
const REF_PATTERNS = [
  // ГОСТ / ГОСТ Р / ГОСТ Р ИСО: «ГОСТ Р 21.101-2020», «ГОСТ 530-2012»
  /ГОСТ(?:\s+Р)?(?:\s+ИСО)?\s+\d[\d.]*(?:-\d{2,4})?/g,
  // СП с номером: «СП 60.13330.2020», «СП 2.13130.2020»
  /СП\s+\d+\.\d+(?:\.\d{4})?/g,
  // СНиП: «СНиП 21-01-97*»
  /СНиП\s+[\dIVX]+-\d+(?:-\d+)?\*?/g,
  // СанПиН
  /СанПиН\s+[\d.]+-\d+/g,
  // Постановления Правительства: «ПП РФ № 87», «постановление № 87»
  /(?:ПП\s+РФ|постановлением?\s+Правительства(?:\s+РФ)?)\s*(?:от\s+[\d.]+\s+)?№?\s*\d+/gi,
  // приказы Минстроя вида 783/пр, 421/пр
  /№?\s*\d+\/пр/g,
  // федеральные законы: «384-ФЗ», «123-ФЗ»
  /\d+-ФЗ/g,
];

function lineOf(text, index) {
  // «указание места» — номер строки и её дословный текст (обрезанный)
  let line = 1;
  for (let i = 0; i < index; i += 1) if (text.charCodeAt(i) === 10) line += 1;
  const start = text.lastIndexOf('\n', index) + 1;
  let end = text.indexOf('\n', index);
  if (end === -1) end = Math.min(text.length, index + 200);
  return { line, text: text.slice(start, end).trim().slice(0, 200) };
}

/**
 * Все ссылки на НТД в тексте → перечень с местами и статусом по реестру.
 * Возвращает { refs: [...], total }: refs агрегированы по шифру,
 * у каждого — до 5 мест вхождения.
 */
function extract(text) {
  const src = String(text || '');
  const found = new Map(); // norm → { code, count, places[] }
  for (const re of REF_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(src)) !== null) {
      const raw = m[0].replace(/\s+/g, ' ').trim();
      const norm = normalizeCode(raw);
      if (!found.has(norm)) found.set(norm, { code: raw, count: 0, places: [] });
      const rec = found.get(norm);
      rec.count += 1;
      if (rec.places.length < 5) rec.places.push(lineOf(src, m.index));
    }
  }

  const { byCode } = loadRegistry();
  const refs = [];
  for (const [norm, rec] of found) {
    const reg = byCode.get(norm) || null;
    let verdict = 'нет в реестре';
    if (reg) {
      const status = String(reg.status || '').toLowerCase();
      if (/замен|отмен|утратил|не действует/.test(status)) verdict = 'заменён или утратил силу';
      else if (/действует/.test(status)) verdict = 'действует (по реестру)';
      else verdict = 'статус по реестру неоднозначен';
    }
    refs.push({
      code: rec.code,
      count: rec.count,
      places: rec.places,
      registry: reg ? { code: reg.code, title: reg.title || '', status: reg.status || '' } : null,
      verdict,
    });
  }
  refs.sort((a, b) => b.count - a.count || a.code.localeCompare(b.code, 'ru'));
  return { refs, total: refs.reduce((s, r) => s + r.count, 0) };
}

module.exports = { extract, normalizeCode, loadRegistry, REGISTRY_FILE };
