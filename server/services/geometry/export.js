'use strict';
/**
 * Выгрузка комплекта по выбранному варианту (ТЗ, п. 38, 54).
 *
 * PDF формируется сервером — это прямое требование. Вёрстка идёт HTML-страницей
 * и печатается headless-браузером: так в PDF остаётся живой текст, а не картинка,
 * и таблицы с перечнями верстаются сами.
 *
 * Растровая схема отдаётся отдельным PNG для вставки в письма и презентации.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../../config');
const { db, now } = require('../../db');
const render = require('../render');
const cadDrawing = require('../cad/drawing');
const selection = require('./selection');
const G = require('./site-geometry');

/**
 * Схема участка с наложенным пятном выбранного варианта.
 *
 * Кадр строится по УЧАСТКУ, а не по пятну: от генплана ждут участок целиком
 * с посадкой на нём, а не крупный план здания посреди пустого поля.
 */
function planSvg(site, variant, { width = 1000, height = 700 } = {}) {
  const pts = variant ? variant.footprint.points : null;
  const b = (site.parcel && G.bounds(site.parcel.geometry.points))
    || site.drawingBounds
    || (pts ? G.bounds(pts) : null);
  if (!b) return '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>';

  const frame = [[b.minX, b.minY], [b.maxX, b.minY], [b.maxX, b.maxY], [b.minX, b.maxY]];
  return selection.cropSvg(site, pts || frame, {
    width, height, marginRatio: 0.08,
    // без варианта подсвечивать нечего: рамка по габаритам участка на схеме
    // ограничений читалась бы как ещё один объект чертежа
    highlight: pts ? 'footprint' : 'none',
    frame,
  });
}

/**
 * Схема ограничений БЕЗ пятна: её место — в разделе планировочных ограничений.
 * Кадр тот же, что у схемы посадки, чтобы две картинки читались как пара.
 */
function zonesSvg(site, opts = {}) {
  return planSvg(site, null, opts);
}

/**
 * Сохранение файла результата в существующую систему результатов сессии.
 *
 * Имя файла постоянное, поэтому повторная сборка ПЕРЕЗАПИСЫВАЕТ файл на диске.
 * Значит и запись должна обновляться, а не добавляться: раньше в панели
 * результатов копились дубли с одинаковыми именами, и показанный размер
 * относился к уже перезаписанному файлу. Идентификатор сохраняется — ссылка
 * на скачивание, выданная раньше, продолжает работать.
 */
function saveResult(sessionId, filename, title, format, buffer) {
  const dir = path.join(config.dataDir, 'outputs', sessionId);
  fs.mkdirSync(dir, { recursive: true });
  const stored = path.join(dir, filename);
  fs.writeFileSync(stored, buffer);
  const prev = db.prepare('SELECT id FROM results WHERE session_id = ? AND filename = ? AND stored_path = ?')
    .get(sessionId, filename, stored);
  if (prev) {
    db.prepare('UPDATE results SET title = ?, format = ?, size = ?, created_at = ? WHERE id = ?')
      .run(title, format, buffer.length, now(), prev.id);
    return { id: prev.id, filename, title, format, size: buffer.length };
  }
  const id = crypto.randomUUID();
  db.prepare('INSERT INTO results (id, session_id, filename, title, format, size, stored_path, created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(id, sessionId, filename, title, format, buffer.length, stored, now());
  return { id, filename, title, format, size: buffer.length };
}

/**
 * Комплект по выбранному варианту: PDF, растровая схема и чертёж.
 *
 * Чертёж — то, ради чего всё и затевалось: DXF пишется всегда, DWG строит
 * AutoCAD через мост (см. services/cad/drawing.js). Если чертёж не собрался,
 * комплект всё равно выпускается, а причина уходит в `notes` и в интерфейс —
 * молча отдавать неполный комплект нельзя.
 *
 * @returns {{created: Array, notes: string[]}}
 */
async function buildPackage(sessionId, { session, site, variant, restrictions, buildable, annotations, signal = null }) {
  const created = [];
  const notes = [];

  /*
   * Комплект верстается как проектный материал (services/geometry/report.js):
   * титул с реквизитами, нумерованные разделы, две схемы с легендой, ведомости
   * с основаниями, колонтитул с номером листа. Прежняя вёрстка укладывалась
   * в один экран таблиц без титула, без исходных данных, без легенды и без
   * нумерации страниц — подшить и вынести на согласование такое нельзя.
   */
  const report = require('./report');
  const date = new Date(now()).toLocaleString('ru-RU', { dateStyle: 'long', timeStyle: 'short' });
  const files = db.prepare('SELECT original_name, ext, size FROM files WHERE session_id = ? ORDER BY created_at')
    .all(sessionId);
  // перечень непостроенных зон и атрибутивных ограничений (высота, процент
  // застройки) живёт в записи расчёта, а не в геометрии плана
  const zonesRecord = require('./zones').latest(sessionId);
  const zoneData = (zonesRecord && zonesRecord.zones) || {};

  const html = report.buildHtml({
    session, site, variant, restrictions: restrictions || [], buildable,
    annotations: annotations || [], files, date,
    attributes: zoneData.attributes || [],
    unresolved: zoneData.unresolved || [],
    zonesSvg: zonesSvg(site, { width: 1000, height: 620 }),
    variantSvg: planSvg(site, variant, { width: 1000, height: 620 }),
  });

  const pdf = await render.htmlToPdf(html, { footer: report.footerTemplate(session, date) });
  created.push(saveResult(sessionId, 'КОМПЛЕКТ-вариант.pdf', 'Комплект по выбранному варианту', 'pdf', pdf));

  const png = await render.svgToPng(planSvg(site, variant, { width: 1400, height: 950 }), { width: 1400, height: 950, scale: 1.5 });
  created.push(saveResult(sessionId, 'СХЕМА-вариант.png', 'Схема выбранного варианта', 'png', png));

  try {
    const dir = fs.mkdtempSync(path.join(config.dataDir, 'cad-'));
    const drawing = await cadDrawing.buildDrawing(site, {
      variant, buildable, title: session.title || 'Проект без названия',
      subtitle: `Enso-nexus · ${new Date(now()).toLocaleDateString('ru-RU')}`,
      dir, signal,
    });
    notes.push(...drawing.notes);
    created.push(saveResult(sessionId, path.basename(drawing.dxfPath),
      'Чертёж генплана: слои, зоны штриховкой, пятно застройки', 'dxf',
      fs.readFileSync(drawing.dxfPath)));
    if (drawing.dwgPath) {
      created.push(saveResult(sessionId, path.basename(drawing.dwgPath),
        drawing.dwgSource === 'autocad'
          ? 'Чертёж генплана в DWG (создан AutoCAD — готов к работе)'
          : 'Чертёж генплана в DWG (собран конвертером — проверьте слои)',
        'dwg', fs.readFileSync(drawing.dwgPath)));
    }
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    if (err && err.name === 'AbortError') throw err;
    notes.push(`Чертёж не сформирован: ${err.message}`);
  }

  return { created, notes };
}

// buildHtml переехал в services/geometry/report.js — там вёрстка комплекта целиком.
// Имя оставлено прежним: на него ссылаются вызывающие и тесты.
module.exports = { buildPackage, buildHtml: require('./report').buildHtml, planSvg, zonesSvg, saveResult };
