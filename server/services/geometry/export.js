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
const RR = require('./restriction-rules');

/** Статус берётся живой из записи варианта: решения могли быть приняты позже. */
const VARIANT_STATUS = {
  admissible: 'допустим',
  needs_decision: 'требует решения пользователя',
  violations: 'есть нарушения',
  rejected: 'отклонён решением пользователя',
};
function statusLabel(variant) {
  return VARIANT_STATUS[variant.status] || variant.statusLabel || variant.status;
}

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

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
    highlight: pts ? 'footprint' : 'selection',
    frame,
  });
}

/** Многостраничная HTML-вёрстка комплекта — из неё печатается PDF. */
function buildHtml({ session, site, variant, restrictions, buildable, annotations }) {
  const m = (variant && variant.metrics) || {};
  const rows = (list, cols) => list.map((r) => `<tr>${cols.map((c) => `<td>${esc(c(r))}</td>`).join('')}</tr>`).join('');

  const actions = (variant && variant.actions) || [];
  const tep = m.tep || [];

  return `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<title>Комплект по выбранному варианту</title>
<style>
  @page { size: A4; margin: 16mm 14mm; }
  body { font: 11pt/1.5 -apple-system, "Helvetica Neue", Arial, sans-serif; color: #23201c; }
  h1 { font-size: 20pt; margin: 0 0 4pt; }
  h2 { font-size: 13pt; margin: 18pt 0 6pt; border-bottom: 1px solid #d8d0c0; padding-bottom: 3pt; }
  .sub { color: #6f665a; margin: 0 0 12pt; }
  table { width: 100%; border-collapse: collapse; margin: 6pt 0; font-size: 10pt; }
  th, td { text-align: left; padding: 4pt 6pt; border-bottom: 1px solid #e6e0d4; vertical-align: top; }
  th { color: #6f665a; font-weight: 600; }
  .plan { margin: 10pt 0; }
  .plan svg { width: 100%; height: auto; border: 1px solid #d8d0c0; }
  .warn { color: #a93e2c; }
  .muted { color: #857b6e; }
  .page-break { page-break-before: always; }
  ul { margin: 4pt 0 4pt 16pt; padding: 0; }
</style></head><body>

<h1>${esc(session.title || 'Проект без названия')}</h1>
<p class="sub">Комплект по выбранному варианту посадки · Enso-nexus · ${esc(new Date(now()).toLocaleString('ru-RU'))}</p>

<div class="plan">${planSvg(site, variant)}</div>

<h2>Параметры варианта</h2>
${variant ? `<table>
  <tr><th>Номер варианта</th><td>${esc(variant.number)}</td></tr>
  <tr><th>Площадь застройки</th><td>${esc(m.areaM2)} м²</td></tr>
  <tr><th>Габариты</th><td>${esc(m.width)} × ${esc(m.length)} м</td></tr>
  <tr><th>Поворот</th><td>${esc(m.rotationDeg)}°</td></tr>
  <tr><th>Этажность</th><td>${m.floors ? esc(m.floors) : '<span class="muted">не задана</span>'}</td></tr>
  <tr><th>Затронуто объектов</th><td>${esc(m.affectedCount || 0)}</td></tr>
  <tr><th>Статус</th><td>${esc(statusLabel(variant))}</td></tr>
</table>` : '<p class="warn">Вариант не выбран.</p>'}

<h2>Ограничения, учтённые в расчёте</h2>
${restrictions.length ? `<table>
  <tr><th>Тип</th><th>Площадь</th><th>Статус</th><th>Основание</th></tr>
  ${rows(restrictions, [
    (r) => RR.KIND_LABELS[r.properties.kind] || r.properties.kind,
    (r) => `${r.properties.areaM2} м²`,
    (r) => r.properties.statusLabel || '',
    (r) => r.provenance.basis || '—',
  ])}
</table>` : '<p class="muted">Зоны ограничений не рассчитывались.</p>'}

${buildable ? `<p>Потенциально допустимая территория: <b>${esc(buildable.areaM2)} м²</b>
(${esc(buildable.sharePercent)}% участка). ${esc(buildable.note)}</p>` : ''}

<h2>Мероприятия</h2>
${actions.length ? `<table>
  <tr><th>Мероприятие</th><th>Объём</th><th>Класс объекта</th><th>Решение</th></tr>
  ${rows(actions, [
    (a) => a.title,
    (a) => (Number.isFinite(a.volume) ? `${a.volume} ${a.unit}` : '—'),
    (a) => require('./critical-objects').LABELS[a.classification] || a.classification || '—',
    (a) => (a.requiresDecision ? (a.decision === 'allow' ? 'разрешено' : a.decision === 'forbid' ? 'запрещено' : 'ТРЕБУЕТ РЕШЕНИЯ') : '—'),
  ])}
</table>` : '<p class="muted">Мероприятия не требуются: вариант не затрагивает существующие объекты.</p>'}

${tep.length ? `<h2>Объёмы (ТЭП мероприятий)</h2><table>
  <tr><th>Показатель</th><th>Значение</th><th>Единица</th></tr>
  ${rows(tep, [(t) => t.name, (t) => t.value, (t) => t.unit])}
</table>` : ''}

<div class="page-break"></div>
<h2>Предупреждения</h2>
${(variant && variant.warnings && variant.warnings.length) || site.warnings.length
    ? `<ul>${[...((variant && variant.warnings) || []), ...site.warnings.map((w) => w.message)]
      .map((w) => `<li class="warn">${esc(w)}</li>`).join('')}</ul>`
    : '<p class="muted">Предупреждений нет.</p>'}

<h2>Исходные основания</h2>
<table>
  <tr><th>Объект</th><th>Источник</th><th>Способ</th><th>Уверенность</th></tr>
  ${rows(G.allObjects(site).slice(0, 60), [
    (o) => `${o.type}${o.properties.kind ? ` (${o.properties.kind})` : ''}`,
    (o) => `${o.provenance.sourceFile || '—'}${o.provenance.sourceLayer ? ` · ${o.provenance.sourceLayer}` : ''}`,
    (o) => o.provenance.extractionMethod,
    (o) => `${Math.round((o.provenance.confidence || 0) * 100)}%`,
  ])}
</table>

${annotations.length ? `<h2>Выделения и комментарии</h2><table>
  <tr><th>Комментарий</th><th>Автор</th><th>Статус</th></tr>
  ${rows(annotations, [(a) => a.comment || '—', (a) => a.author || '—', (a) => a.status])}
</table>` : ''}

<p class="muted" style="margin-top:18pt">Документ сформирован автоматически. Потенциально допустимая
территория — аналитический результат, а не разрешённое пятно застройки.</p>
</body></html>`;
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
  const html = buildHtml({ session, site, variant, restrictions, buildable, annotations });
  const created = [];
  const notes = [];

  const pdf = await render.htmlToPdf(html);
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

module.exports = { buildPackage, buildHtml, planSvg, saveResult };
