'use strict';
/**
 * Выгрузка чертежа генплана: DXF всегда, DWG — если есть чем его создать.
 *
 * Порядок выбран так, чтобы выгрузка никогда не заканчивалась ничем:
 *   1. DXF пишет сервер — он получается всегда и открывается в AutoCAD штатно;
 *   2. DWG строит AutoCAD через мост — это основной путь, файл настоящий;
 *   3. если AutoCAD закрыт, DWG собирается конвертером LibreDWG, и в названии
 *      файла честно написано, чем он получен.
 *
 * Пустой или битый файл в «Результаты» не кладётся ни при каком раскладе:
 * если DWG не получился, остаётся DXF и понятная причина в отчёте о выгрузке.
 */
const fs = require('fs');
const path = require('path');
const config = require('../../config');
const planSpec = require('./plan-spec');
const dxfWriter = require('./dxf-writer');
const bridge = require('./acad-bridge');

/**
 * Имя файла без символов, на которых спотыкаются файловые системы и AutoCAD.
 * Расширение исходника отбрасывается: название проекта часто равно имени
 * загруженного файла, и иначе получается «ГЕНПЛАН участок.dxf.dxf».
 */
function safeName(name) {
  return String(name || 'генплан')
    .replace(/\.(dwg|dxf|pdf|docx?|txt|md|json|csv|png|jpe?g)$/i, '')
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80) || 'генплан';
}

/**
 * Собрать чертёж по выбранному варианту.
 *
 * @param {object}  site       SiteGeometry с ограничениями
 * @param {object}  opts.variant   выбранный вариант посадки
 * @param {object}  opts.buildable допустимая территория
 * @param {string}  opts.title     название проекта
 * @param {string}  opts.dir       куда писать файлы
 * @returns {{spec, dxfPath, dwgPath, dwgSource, notes: string[]}}
 */
/**
 * @param {boolean} [opts.acad] пробовать ли AutoCAD. Для быстрой выгрузки из
 *   вьювера — false: мост ждёт ответа AutoCAD до 90 секунд и требует разрешения
 *   в «Универсальном доступе», а кнопка обязана отдавать файл сразу. Конвертер
 *   LibreDWG справляется с той же геометрией и никого не спрашивает.
 */
async function buildDrawing(site, {
  variant = null, buildable = null, title = '', subtitle = '', dir, signal = null, onStep = null, acad = true,
} = {}) {
  const spec = planSpec.build(site, { variant, buildable, title, subtitle });
  const notes = [];

  if (!spec.entities.length) {
    throw Object.assign(
      new Error('В модели участка нет геометрии: чертёж строить не из чего. Загрузите DWG или DXF с топосъёмкой.'),
      { status: 400 },
    );
  }

  fs.mkdirSync(dir, { recursive: true });
  const base = safeName(title ? `ГЕНПЛАН ${title}` : 'ГЕНПЛАН');
  const dxfPath = path.join(dir, `${base}.dxf`);
  // файл пишется БАЙТАМИ в кодовой странице, объявленной в $DWGCODEPAGE:
  // UTF-8 в DXF версии AC1015 не предусмотрен, и кириллица в именах слоёв
  // и подписях превращалась у получателя в мусор
  const dxfWarnings = [];
  fs.writeFileSync(dxfPath, dxfWriter.writeSpecBuffer(spec, { warnings: dxfWarnings }));
  for (const w of dxfWarnings) notes.push(`DXF: ${w}`);

  let dwgPath = null;
  let dwgSource = null;

  const probe = acad ? await bridge.probe() : { available: false, reason: 'AutoCAD не опрашивался: быстрая выгрузка идёт конвертером.' };
  if (probe.available) {
    try {
      const target = path.join(dir, `${base}.dwg`);
      const res = await bridge.exportDwg(spec, target, { signal, onStep });
      dwgPath = res.path;
      dwgSource = 'autocad';
      for (const w of res.warnings) notes.push(`AutoCAD: ${w}`);
    } catch (err) {
      if (err && err.name === 'AbortError') throw err;
      notes.push(`DWG через AutoCAD не получился: ${err.message}`);
    }
  } else {
    notes.push(probe.reason);
  }

  if (!dwgPath && config.acad.allowConverterFallback) {
    try {
      const target = path.join(dir, `${base} (конвертер).dwg`);
      await bridge.convertDxfToDwg(dxfPath, target);
      dwgPath = target;
      dwgSource = 'converter';
      notes.push('DWG собран конвертером LibreDWG, а не AutoCAD: проверьте имена слоёв после открытия. ' +
        'Полноценный файл получится, если открыть AutoCAD с загруженным мостом и повторить выгрузку.');
    } catch (err) {
      notes.push(`Конвертер тоже не справился: ${err.message}`);
    }
  }

  if (!dwgPath) {
    notes.push('Выгружен только DXF. AutoCAD открывает его штатно: «Файл → Открыть», ' +
      'затем «Сохранить как» → DWG, если нужен именно этот формат.');
  }

  return { spec, dxfPath, dwgPath, dwgSource, notes };
}

module.exports = { buildDrawing, safeName };
