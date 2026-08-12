'use strict';
/**
 * План участка сессии: сборка SiteGeometry из всех CAD-файлов сессии.
 *
 * Разбор чертежа детерминирован и не требует модели, поэтому план строится
 * по запросу и кэшируется рядом с файлом (<файл>.plan.json). Модель здесь не
 * участвует вообще — это чистая геометрия.
 */
const fs = require('fs');
const crypto = require('crypto');
const { db, now } = require('../../db');
const cadGeom = require('./cad-geometry');
const G = require('./site-geometry');

const CAD_EXT = new Set(['dxf', 'dwg']);

/**
 * Версия разбора чертежа. Увеличивается при ЛЮБОМ изменении в разборе DXF:
 * кэш и сохранённые планы, снятые прежним разбором, содержат уже неверную
 * геометрию (например, рамку листа в составе существующих объектов), и молча
 * отдавать их нельзя. Входит и в имя кэша по содержимому, и в отпечаток набора
 * чертежей — чтобы сохранённый план пересчитался следующей версией, а старая
 * осталась нетронутой вместе со своими аннотациями (ТЗ, п. 74).
 */
const PARSER_VERSION = 4;

/** Кэш разбора одного файла: разбирать чертёж на каждый запрос viewer'а незачем. */
async function siteForFile(file) {
  const cachePath = `${file.stored_path}.plan.json`;
  try {
    const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    if (cached && cached.parserVersion === PARSER_VERSION && cached.site && cached.site.version === 1) {
      return cached.site;
    }
  } catch { /* кэша нет или он битый — разбираем заново */ }

  const site = await cadGeom.fromFile(file.stored_path, file.ext, {
    fileId: file.id, fileName: file.original_name,
  });
  try { fs.writeFileSync(cachePath, JSON.stringify({ parserVersion: PARSER_VERSION, site })); } catch { /* кэш необязателен */ }
  return site;
}

/**
 * Объединение чертежей сессии в один план. Несколько файлов складываются в одну
 * модель: топосъёмка даёт рельеф и сети, отдельный чертёж — границы участка.
 * Участком становится самый крупный контур из всех — так же, как внутри одного файла.
 */
async function buildForSession(sessionId) {
  const files = db.prepare('SELECT * FROM files WHERE session_id = ? ORDER BY created_at').all(sessionId)
    .filter((f) => CAD_EXT.has(String(f.ext).toLowerCase()));

  const plan = G.createSiteGeometry();
  if (!files.length) {
    plan.warnings.push({
      code: 'no-cad',
      message: 'В проекте нет чертежей DWG или DXF — геометрию участка строить не из чего. ' +
        'Загрузите топосъёмку или план границ.',
    });
    return plan;
  }

  const placed = []; // {name, bounds} — для проверки, что чертежи в одной системе
  for (const file of files) {
    let part;
    try {
      part = await siteForFile(file);
    } catch (err) {
      plan.warnings.push({ code: 'cad-failed', message: `Чертёж «${file.original_name}» разобрать не удалось: ${err.message}` });
      continue;
    }
    // единицы берём от первого удачно разобранного чертежа
    if (plan.coordinateSystem.sourceUnits === 'не определены') {
      plan.coordinateSystem = { ...part.coordinateSystem };
    }
    plan.sourceReferences.push(...part.sourceReferences);
    G.mergeWarnings(plan.warnings, part.warnings);
    if (part.drawingBounds) placed.push({ name: file.original_name, bounds: part.drawingBounds });
    if (part.parcel) G.addObject(plan, part.parcel);
    for (const key of ['buildings', 'redLines', 'existingObjects', 'utilities']) {
      for (const o of part[key]) plan[key].push(o);
    }
  }

  G.mergeWarnings(plan.warnings, coordinateMismatchWarnings(placed));
  G.recomputeBounds(plan);
  return plan;
}

/** Во сколько раз расстояние между чертежами должно превысить их размер, чтобы считать системы разными. */
const CRS_GAP_FACTOR = 5;

/**
 * Проверка совместимости систем координат у чертежей одной сессии.
 *
 * Топосъёмка в МСК-47 и рабочий план в локальных координатах складывались
 * в один план молча: здание оказывалось в двух тысячах километров от участка,
 * а план выглядел исправным. Строго определить систему координат по DXF нельзя
 * (в файле её попросту нет), поэтому проверяется наблюдаемое: если габариты
 * чертежей разнесены на порядок больше собственного размера — это разные системы.
 */
function coordinateMismatchWarnings(placed) {
  if (placed.length < 2) return [];
  const out = [];
  const centre = (b) => [(b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2];
  const diag = (b) => Math.hypot(b.maxX - b.minX, b.maxY - b.minY);
  const fmt = (b) => `X ${G.round(b.minX, 1)}…${G.round(b.maxX, 1)}, Y ${G.round(b.minY, 1)}…${G.round(b.maxY, 1)}`;

  for (let i = 0; i < placed.length; i++) {
    for (let j = i + 1; j < placed.length; j++) {
      const a = placed[i]; const b = placed[j];
      const ca = centre(a.bounds); const cb = centre(b.bounds);
      const gap = Math.hypot(ca[0] - cb[0], ca[1] - cb[1]);
      const size = Math.max(diag(a.bounds), diag(b.bounds), 1);
      if (gap <= size * CRS_GAP_FACTOR) continue;
      out.push({
        code: 'crs-mismatch',
        message: `Чертежи «${a.name}» и «${b.name}» разнесены на ${G.round(gap, 0)} м при собственном размере ` +
          `около ${G.round(size, 0)} м — почти наверняка они выполнены в разных системах координат. ` +
          `«${a.name}»: ${fmt(a.bounds)}; «${b.name}»: ${fmt(b.bounds)}. ` +
          'Объединять их в один план нельзя: пересечения, расстояния и посадка будут посчитаны по заведомо ложной геометрии. ' +
          'Приведите чертежи к одной системе координат перед расчётом.',
      });
    }
  }
  return out;
}

/** Сброс кэша разбора: вызывается при удалении или замене файлов сессии. */
function invalidate(storedPath) {
  try { fs.unlinkSync(`${storedPath}.plan.json`); } catch { /* кэша могло не быть */ }
}

/**
 * Отпечаток набора чертежей: если он не изменился, план тот же и новую версию
 * заводить незачем. Берём идентификатор, размер и время правки — переименование
 * файла геометрию не меняет, а замена содержимого меняет.
 */
function sourceHash(sessionId) {
  const files = db.prepare('SELECT id, stored_path, size FROM files WHERE session_id = ? ORDER BY id').all(sessionId)
    .filter((f) => {
      const ext = String(f.stored_path).split('.').pop().toLowerCase();
      return CAD_EXT.has(ext);
    });
  const parts = files.map((f) => {
    let mtime = 0;
    try { mtime = Math.round(fs.statSync(f.stored_path).mtimeMs); } catch { /* файла нет */ }
    return `${f.id}:${f.size}:${mtime}`;
  });
  // версия разбора — часть отпечатка: изменился разбор — изменился и план
  return crypto.createHash('sha256').update(`parser=${PARSER_VERSION}|${parts.join('|')}`).digest('hex').slice(0, 32);
}

/**
 * Актуальная версия плана сессии. Если чертежи не менялись — возвращается
 * сохранённая версия вместе с её id, к которому привязаны аннотации.
 * Изменились — заводится следующая версия, старая остаётся нетронутой.
 */
/**
 * Правки человека накладываются ЗДЕСЬ, а не у каждого потребителя.
 *
 * Раньше их применял только маршрут показа плана — и получалось, что во вьювере
 * границей участка был назначенный человеком контур, а «Рассчитать ограничения»,
 * подбор вариантов, выгрузка и анализ строили план заново и брали прежнюю догадку
 * разбора: пересчёт давал те же границы, что и в первый раз.
 *
 * В таблицу plans пишется ЧИСТЫЙ разбор: версия плана отражает чертежи, а не
 * мнение человека о них. Правки живут отдельно и накладываются на каждый выдаваемый
 * экземпляр — поэтому их можно отменить, не переразбирая чертёж.
 */
function applyUserEdits(sessionId, site) {
  // Порядок здесь значим. Сначала граница из документа (ГПЗУ, выписка ЕГРН):
  // в топосъёмке контура участка может не быть вовсе, и тогда границей
  // становится случайный контур покрытия. Затем правки человека — за ним
  // последнее слово: назначил участком другой контур, значит им и будет.
  try {
    const parcelSource = require('./parcel-source');
    parcelSource.applyTo(sessionId, site);
  } catch (err) {
    console.warn('[plan] граница из документа не применена:', err.message);
  }
  try {
    const oe = require('./object-edits');
    const edits = oe.list(sessionId);
    if (edits.length) oe.applyTo(site, edits);
  } catch (err) {
    console.warn('[plan] правки объектов не применены:', err.message);
  }
  return site;
}

/**
 * @param {object} [opts.raw] вернуть ЧИСТЫЙ разбор, без правок человека. Нужно
 *   ровно в одном месте — когда сохраняется новая правка: обучающий пример обязан
 *   хранить догадку разбора, а не её же, исправленную прошлой правкой.
 */
async function ensurePlan(sessionId, { raw = false } = {}) {
  const hash = sourceHash(sessionId);
  const existing = db.prepare('SELECT * FROM plans WHERE session_id = ? AND source_hash = ? ORDER BY version DESC LIMIT 1')
    .get(sessionId, hash);
  if (existing) {
    const site = JSON.parse(existing.geometry);
    if (raw) return { planId: existing.id, version: existing.version, isNew: false, site };
    return {
      planId: existing.id, version: existing.version, isNew: false,
      site: withZones(sessionId, existing.id, applyUserEdits(sessionId, site)),
    };
  }

  const site = await buildForSession(sessionId);
  const last = db.prepare('SELECT MAX(version) AS v FROM plans WHERE session_id = ?').get(sessionId);
  const version = (last && last.v ? last.v : 0) + 1;
  const id = crypto.randomUUID();
  // сохраняется чистый разбор — до наложения правок
  db.prepare('INSERT INTO plans (id, session_id, version, source_hash, geometry, coordinate_system, created_at) VALUES (?,?,?,?,?,?,?)')
    .run(id, sessionId, version, hash, JSON.stringify(site), site.coordinateSystem.sourceUnits || '', now());
  if (raw) return { planId: id, version, isNew: true, site };
  return { planId: id, version, isNew: true, site: withZones(sessionId, id, applyUserEdits(sessionId, site)) };
}

/**
 * Зоны ограничений прикладываются ЗДЕСЬ — и пересчитываются, если правки
 * человека изменились с прошлого расчёта.
 *
 * Пока зоны жили внутри `plans.geometry`, они замерзали на момент нажатия
 * «Рассчитать ограничения». Человек помечал строение под снос, шёл за
 * вариантами посадки — и получал пятно, посчитанное ДО его решения: подбор
 * вариантов, посадка, чертёж и отчёт все до одного читают `site.buildable`
 * из плана. На боевом комплекте это стоило 1094 м² допустимой территории
 * и всех четырёх вариантов сразу.
 *
 * Пересчёт детерминирован и модель не зовёт (см. geometry/zones.js).
 */
function withZones(sessionId, planId, site) {
  try {
    require('./zones').attach(sessionId, planId, site);
  } catch (err) {
    console.warn('[plan] зоны не приложены:', err.message);
  }
  return site;
}

module.exports = {
  buildForSession, siteForFile, invalidate, ensurePlan, sourceHash, coordinateMismatchWarnings,
  applyUserEdits,
};
