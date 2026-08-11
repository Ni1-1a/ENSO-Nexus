'use strict';
/**
 * Запись спецификации чертежа в DXF версии AC1015 (AutoCAD 2000).
 *
 * Почему именно AC1015, а не R12: в R12 нет сущности HATCH, а без штриховок
 * зоны ограничений в чертеже неразличимы — ровно та претензия, из-за которой
 * этот writer и появился. AC1015 открывают все версии AutoCAD с 2000 года,
 * BricsCAD, nanoCAD, LibreCAD и просмотрщики ODA.
 *
 * Чего здесь намеренно нет: попытки записать DWG. Закрытый формат без
 * лицензионной библиотеки не пишется, а конвертер libredwg на этой машине
 * уродует имена слоёв (проверено: «AI_ГРАНИЦЫ_ЗУ» превращается в «A»).
 * DWG получается из этого же чертежа через AutoCAD — см. acad-bridge.js.
 *
 * Каждая штриховка сопровождается замкнутой полилинией контура: если чужой
 * просмотрщик не осилит HATCH, геометрия зоны всё равно останется в файле.
 *
 * Кодировка: файл пишется в CP1251 и объявляет её через $DWGCODEPAGE.
 * Для версий до AC1021 в DXF нет UTF-8: читатель обязан взять кодовую страницу
 * из $DWGCODEPAGE (по умолчанию ANSI_1252), поэтому UTF-8-байты кириллицы
 * превращались в «AI_Ð“Ð Ð�Ð�Ð˜Ð¦Ð«_Ð—Ð£». Путь с экранированием \U+XXXX
 * не выбран сознательно: он спасает подписи, но НЕ имена слоёв — слой
 * «AI_ГРАНИЦЫ_ЗУ» так не назвать, а по именам слоёв чертёж и разбирают.
 */
const planSpec = require('./plan-spec');

/** Единицы чертежа: 6 = метры ($INSUNITS). Модель участка тоже в метрах. */
const INSUNITS_METERS = 6;

/** Кодовая страница файла: русский AutoCAD пишет чертежи именно в ней. */
const DWGCODEPAGE = 'ANSI_1251';

/**
 * Верхняя половина CP1251 (байты 0x80…0xFF) — сверено с кодеком cp1251.
 * Байт 0x98 в CP1251 не определён, поэтому в таблице стоит заглушка.
 * Своя таблица, а не зависимость: iconv в проекте нет, встроенного cp1251
 * в Node тоже нет, а ради ста символов тянуть пакет незачем.
 */
const CP1251_HIGH =
  'ЂЃ‚ѓ„…†‡€‰Љ‹ЊЌЋЏђ‘’“”•–—�™љ›њќћџ ЎўЈ¤Ґ¦§Ё©Є«¬­®Ї'
  + '°±Ііґµ¶·ё№є»јЅѕї'
  + 'АБВГДЕЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ'
  + 'абвгдежзийклмнопрстуфхцчшщъыьэюя';

const CP1251_MAP = (() => {
  const map = new Map();
  for (let i = 0; i < CP1251_HIGH.length; i++) {
    const ch = CP1251_HIGH[i];
    if (ch === '�') continue;          // неопределённый байт 0x98
    map.set(ch, 0x80 + i);
  }
  return map;
})();

/** Влезает ли символ в кодовую страницу файла. */
function inCodepage(ch) {
  return ch.charCodeAt(0) < 0x80 || CP1251_MAP.has(ch);
}

/**
 * Символы вне CP1251 (², ×, ✓ и прочее) записываются последовательностью
 * \U+XXXX — так же поступает сам AutoCAD, и он же разворачивает её обратно
 * при открытии. Для имён слоёв это не годится, но в именах слоёв проекта
 * ничего, кроме кириллицы, латиницы и подчёркиваний, нет.
 */
function toCodepageText(s) {
  let out = '';
  for (const ch of String(s)) {
    if (inCodepage(ch)) { out += ch; continue; }
    const cp = ch.codePointAt(0);
    out += cp <= 0xffff ? `\\U+${cp.toString(16).toUpperCase().padStart(4, '0')}` : '?';
  }
  return out;
}

/** Текст DXF → байты файла. Всё непредставимое уже заменено toCodepageText. */
function encodeDxf(text) {
  const bytes = [];
  for (const ch of String(text)) {
    const code = ch.charCodeAt(0);
    if (code < 0x80) { bytes.push(code); continue; }
    const byte = CP1251_MAP.get(ch);
    if (byte !== undefined) { bytes.push(byte); continue; }
    for (const c of toCodepageText(ch)) bytes.push(c.charCodeAt(0) & 0x7f);
  }
  return Buffer.from(bytes);
}

/** Данные, при которых честный DXF не получается: молча рисовать вместо них нельзя. */
class DxfDataError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DxfDataError';
  }
}

/** Штриховки описываются своими линиями, а не именем образца из acad.pat:
 *  так файл самодостаточен и не зависит от того, какие .pat есть у получателя. */
function hatchDefinitionLine(angleDeg, spacing) {
  return { angle: angleDeg, baseX: 0, baseY: 0, offsetX: 0, offsetY: spacing };
}

function esc(s) {
  return toCodepageText(String(s == null ? '' : s).replace(/[\r\n]+/g, ' '));
}

class DxfBuilder {
  constructor() {
    this.out = [];
    this.handle = 0x100;
  }

  /** Пара «код — значение». Числа с плавающей точкой пишутся с точкой всегда. */
  p(code, value) {
    this.out.push(String(code), typeof value === 'number' && !Number.isInteger(value)
      ? value.toFixed(6) : String(value));
    return this;
  }

  /**
   * Координата: DXF не прощает «1e+21» — только десятичная запись.
   *
   * Нечисловое значение здесь не заменяется нулём. Координаты бывают в МСК,
   * и вершина, уехавшая в (0, 0), даёт луч в два миллиона метров через весь
   * чертёж и рушит EXTMIN/EXTMAX — по счётчикам сущностей это не заметить.
   * Лучше честный отказ, чем правдоподобный неверный чертёж.
   */
  pf(code, value) {
    if (!Number.isFinite(value)) {
      throw new DxfDataError(
        `Координата не число (код ${code}, значение ${JSON.stringify(value)}). `
        + 'Чертёж с такой вершиной был бы неверным: проверьте геометрию модели участка.',
      );
    }
    this.out.push(String(code), value.toFixed(6));
    return this;
  }

  next() {
    this.handle += 1;
    return this.handle.toString(16).toUpperCase();
  }

  text() {
    return `${this.out.join('\n')}\n`;
  }
}

/* ---------------- служебные секции ---------------- */

function header(b, spec, handSeed, warnings) {
  const raw = spec.bounds || {};
  const finite = ['minX', 'minY', 'maxX', 'maxY'].every((k) => Number.isFinite(raw[k]));
  if (!finite && spec.bounds) {
    warnings.push('Габариты чертежа заданы нечислами — в $EXTMIN/$EXTMAX записан условный квадрат 100×100. '
      + 'Проверьте геометрию: масштаб при открытии окажется неверным.');
  }
  const bounds = finite ? raw : { minX: 0, minY: 0, maxX: 100, maxY: 100 };
  b.p(0, 'SECTION').p(2, 'HEADER');
  b.p(9, '$ACADVER').p(1, 'AC1015');
  // кодовая страница файла: без неё читатель берёт ANSI_1252 и кириллица гибнет
  b.p(9, '$DWGCODEPAGE').p(3, DWGCODEPAGE);
  b.p(9, '$HANDSEED').p(5, handSeed);
  b.p(9, '$INSUNITS').p(70, INSUNITS_METERS);
  b.p(9, '$MEASUREMENT').p(70, 1);           // метрическая система
  b.p(9, '$LUNITS').p(70, 2);
  b.p(9, '$LUPREC').p(70, 3);
  b.p(9, '$INSBASE').pf(10, 0).pf(20, 0).pf(30, 0);
  b.p(9, '$EXTMIN').pf(10, bounds.minX).pf(20, bounds.minY).pf(30, 0);
  b.p(9, '$EXTMAX').pf(10, bounds.maxX).pf(20, bounds.maxY).pf(30, 0);
  b.p(9, '$LIMMIN').pf(10, bounds.minX).pf(20, bounds.minY);
  b.p(9, '$LIMMAX').pf(10, bounds.maxX).pf(20, bounds.maxY);
  b.p(9, '$LTSCALE').pf(40, 1);
  b.p(9, '$CELTYPE').p(6, 'ByLayer');
  b.p(9, '$CLAYER').p(8, '0');
  b.p(9, '$TEXTSTYLE').p(7, 'Standard');
  b.p(0, 'ENDSEC');
}

function tableStart(b, name, count) {
  b.p(0, 'TABLE').p(2, name).p(5, b.next()).p(100, 'AcDbSymbolTable').p(70, count);
}

function ltypeTable(b) {
  const owner = b.next();
  b.p(0, 'TABLE').p(2, 'LTYPE').p(5, owner).p(100, 'AcDbSymbolTable').p(70, 4);
  const simple = (name, descr) => {
    b.p(0, 'LTYPE').p(5, b.next()).p(330, owner)
      .p(100, 'AcDbSymbolTableRecord').p(100, 'AcDbLinetypeTableRecord')
      .p(2, name).p(70, 0).p(3, descr).p(72, 65).p(73, 0).pf(40, 0);
  };
  simple('ByBlock', '');
  simple('ByLayer', '');
  simple('Continuous', 'Solid line');
  // штриховая линия задаётся в МЕТРАХ: на генплане штрих в 2,5 мм не виден
  b.p(0, 'LTYPE').p(5, b.next()).p(330, owner)
    .p(100, 'AcDbSymbolTableRecord').p(100, 'AcDbLinetypeTableRecord')
    .p(2, 'DASHED').p(70, 0).p(3, '__ __ __ __ __ __').p(72, 65).p(73, 2).pf(40, 3)
    .pf(49, 2).p(74, 0).pf(49, -1).p(74, 0);
  b.p(0, 'ENDTAB');
}

function layerTable(b, layers) {
  const owner = b.next();
  b.p(0, 'TABLE').p(2, 'LAYER').p(5, owner).p(100, 'AcDbSymbolTable').p(70, layers.length + 1);
  const record = (name, color, ltype) => {
    b.p(0, 'LAYER').p(5, b.next()).p(330, owner)
      .p(100, 'AcDbSymbolTableRecord').p(100, 'AcDbLayerTableRecord')
      .p(2, esc(name)).p(70, 0).p(62, color).p(6, ltype)
      .p(370, -3);                   // толщина линии — по умолчанию
    // ссылку на стиль печати (390) не пишем: она указывала бы на объект,
    // которого в этом файле нет, и читатели ругаются на висячий handle
  };
  record('0', 7, 'Continuous');
  for (const l of layers) record(l.name, clampColor(l.color), l.linetype || 'Continuous');
  b.p(0, 'ENDTAB');
}

function clampColor(c) {
  const n = Number(c);
  if (!Number.isFinite(n)) return 7;
  return Math.min(255, Math.max(1, Math.round(n)));
}

function styleTable(b) {
  const owner = b.next();
  b.p(0, 'TABLE').p(2, 'STYLE').p(5, owner).p(100, 'AcDbSymbolTable').p(70, 1);
  b.p(0, 'STYLE').p(5, b.next()).p(330, owner)
    .p(100, 'AcDbSymbolTableRecord').p(100, 'AcDbTextStyleTableRecord')
    .p(2, 'Standard').p(70, 0).pf(40, 0).pf(41, 1).pf(50, 0).p(71, 0).pf(42, 2.5)
    .p(3, 'txt').p(4, '');
  b.p(0, 'ENDTAB');
}

function simpleTable(b, name) {
  tableStart(b, name, 0);
  b.p(0, 'ENDTAB');
}

function appidTable(b) {
  const owner = b.next();
  b.p(0, 'TABLE').p(2, 'APPID').p(5, owner).p(100, 'AcDbSymbolTable').p(70, 1);
  b.p(0, 'APPID').p(5, b.next()).p(330, owner)
    .p(100, 'AcDbSymbolTableRecord').p(100, 'AcDbRegAppTableRecord').p(2, 'ACAD').p(70, 0);
  b.p(0, 'ENDTAB');
}

function dimstyleTable(b) {
  const owner = b.next();
  b.p(0, 'TABLE').p(2, 'DIMSTYLE').p(5, owner).p(100, 'AcDbSymbolTable').p(70, 1).p(100, 'AcDbDimStyleTable').p(71, 0);
  b.p(0, 'DIMSTYLE').p(105, b.next()).p(330, owner)
    .p(100, 'AcDbSymbolTableRecord').p(100, 'AcDbDimStyleTableRecord')
    .p(2, 'Standard').p(70, 0);
  b.p(0, 'ENDTAB');
}

/** Записи блоков: модельное и листовое пространство обязаны существовать. */
function blockRecordTable(b, handles) {
  const owner = b.next();
  b.p(0, 'TABLE').p(2, 'BLOCK_RECORD').p(5, owner).p(100, 'AcDbSymbolTable').p(70, 2);
  for (const [name, handle] of [['*Model_Space', handles.modelSpace], ['*Paper_Space', handles.paperSpace]]) {
    b.p(0, 'BLOCK_RECORD').p(5, handle).p(330, owner)
      .p(100, 'AcDbSymbolTableRecord').p(100, 'AcDbBlockTableRecord')
      .p(2, name).p(70, 0).p(280, 1).p(281, 0);
  }
  b.p(0, 'ENDTAB');
}

function blocksSection(b, handles) {
  b.p(0, 'SECTION').p(2, 'BLOCKS');
  for (const [name, recordHandle] of [['*Model_Space', handles.modelSpace], ['*Paper_Space', handles.paperSpace]]) {
    b.p(0, 'BLOCK').p(5, b.next()).p(330, recordHandle)
      .p(100, 'AcDbEntity').p(8, '0').p(100, 'AcDbBlockBegin')
      .p(2, name).p(70, 0).pf(10, 0).pf(20, 0).pf(30, 0).p(3, name).p(1, '');
    b.p(0, 'ENDBLK').p(5, b.next()).p(330, recordHandle)
      .p(100, 'AcDbEntity').p(8, '0').p(100, 'AcDbBlockEnd');
  }
  b.p(0, 'ENDSEC');
}

function objectsSection(b) {
  const root = b.next();
  const group = b.next();
  b.p(0, 'SECTION').p(2, 'OBJECTS');
  b.p(0, 'DICTIONARY').p(5, root).p(100, 'AcDbDictionary').p(281, 1)
    .p(3, 'ACAD_GROUP').p(350, group);
  b.p(0, 'DICTIONARY').p(5, group).p(330, root).p(100, 'AcDbDictionary').p(281, 1);
  b.p(0, 'ENDSEC');
}

/* ---------------- сущности ---------------- */

function entityHead(b, type, layer, msp) {
  b.p(0, type).p(5, b.next()).p(330, msp).p(100, 'AcDbEntity').p(8, esc(layer || '0'));
}

function polyline(b, e, msp) {
  entityHead(b, 'LWPOLYLINE', e.layer, msp);
  b.p(100, 'AcDbPolyline').p(90, e.points.length).p(70, e.closed ? 1 : 0).pf(43, e.width || 0);
  for (const [x, y] of e.points) b.pf(10, x).pf(20, y);
}

function text(b, e, msp) {
  entityHead(b, 'TEXT', e.layer, msp);
  b.p(100, 'AcDbText')
    .pf(10, e.point[0]).pf(20, e.point[1]).pf(30, 0)
    .pf(40, e.height || 1)
    .p(1, esc(e.text))
    .pf(50, e.rotation || 0)
    .p(7, 'Standard')
    .p(72, e.align === 'center' ? 1 : 0);
  if (e.align === 'center') b.pf(11, e.point[0]).pf(21, e.point[1]).pf(31, 0);
  b.p(100, 'AcDbText').p(73, 0);
}

/**
 * Пути границы штриховки: внешнее кольцо плюс отверстия полигона.
 *
 * Флаг 92: бит 1 — внешний путь, бит 2 — путь задан полилинией. У отверстия
 * бита «внешний» нет, и при стиле 75 = 0 («нечётность») оно вычитается из
 * заливки. Без этого зона отступа (кольцо) закрашивалась целиком и читалась
 * как «строить нельзя нигде», а зелёная заливка допустимой территории ложилась
 * поверх охранной зоны.
 */
function hatchPaths(e) {
  const holes = (e.holes || []).filter((h) => Array.isArray(h) && h.length >= 3);
  return [
    { points: e.boundary, flags: 3 },
    ...holes.map((points) => ({ points, flags: 2 })),
  ];
}

/**
 * Штриховка с собственным описанием образца.
 *
 * Заливка (SOLID) и линейная штриховка различаются флагом 70 и наличием блока
 * описания образца. Контур передаётся полилинейными путями: у зон ограничений
 * это замкнутые кольца, разбирать рёбра по одному незачем.
 *
 * Угол (52) и шаг (41) проставляются настоящие, а тип образца объявлен
 * пользовательским (76 = 0): образец описан здесь же своими линиями, поэтому
 * файл не зависит от acad.pat получателя, а читатель, берущий угол из 52,
 * рисует зоны под разными углами — иначе наложение двух ограничений
 * переставало читаться. Те же числа уходят в AutoCAD через мост.
 */
function hatch(b, e, msp) {
  const params = planSpec.hatchParams(e);
  const paths = hatchPaths(e);
  entityHead(b, 'HATCH', e.layer, msp);
  b.p(100, 'AcDbHatch')
    .pf(10, 0).pf(20, 0).pf(30, 0)
    .pf(210, 0).pf(220, 0).pf(230, 1)
    .p(2, params.pattern)
    .p(70, e.solid ? 1 : 0)
    .p(71, 0)          // не ассоциативная: контур живёт отдельной полилинией
    .p(91, paths.length);
  for (const path of paths) {
    b.p(92, path.flags).p(72, 0).p(73, 1).p(93, path.points.length);
    for (const [x, y] of path.points) b.pf(10, x).pf(20, y);
    b.p(97, 0);
  }
  b.p(75, 0)           // «нечётность» — стандартный стиль, он и даёт дырки
    .p(76, e.solid ? 1 : 0);   // образец описан здесь же, значит пользовательский
  if (!e.solid) {
    const def = hatchDefinitionLine(params.angle, params.scale);
    b.pf(52, params.angle).pf(41, params.scale).p(77, 0).p(78, 1);
    b.pf(53, def.angle).pf(43, def.baseX).pf(44, def.baseY).pf(45, def.offsetX).pf(46, def.offsetY).p(79, 0);
  }
  b.pf(47, 0.01);
  b.p(98, 0);
}

/* ---------------- сборка ---------------- */

/** Все координаты сущности — по ним решается, можно ли её вообще писать. */
function entityPoints(e) {
  if (e.type === 'text') return e.point ? [e.point] : [];
  if (e.type === 'hatch') {
    return [...(e.boundary || []), ...(e.holes || []).flatMap((h) => h || [])];
  }
  return e.points || [];
}

/** Первая негодная вершина сущности либо null. */
function badPoint(e) {
  for (const p of entityPoints(e)) {
    if (!Array.isArray(p) || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) return p;
  }
  return null;
}

const ENTITY_LABELS = { polyline: 'полилиния', text: 'подпись', hatch: 'штриховка' };

/**
 * Спецификация → текст DXF.
 *
 * @param {object} spec результат plan-spec.build
 * @param {object} opts.warnings массив, куда складываются предупреждения выгрузки
 * @returns {string}
 */
function writeSpec(spec, { warnings = [] } = {}) {
  // Заголовок пишется последним: в нём стоит $HANDSEED, а он обязан быть
  // больше любого выданного handle — иначе читатель сообщает о висячих
  // ссылках, а AutoCAD выдаёт новым объектам уже занятые номера.
  const b = new DxfBuilder();

  // на записи блоков ссылаются все сущности (330), поэтому их номера
  // выдаются один раз и переиспользуются в трёх местах файла
  const handles = { modelSpace: null, paperSpace: null };

  b.p(0, 'SECTION').p(2, 'TABLES');
  simpleTable(b, 'VPORT');
  ltypeTable(b);
  layerTable(b, spec.layers || []);
  styleTable(b);
  simpleTable(b, 'VIEW');
  simpleTable(b, 'UCS');
  appidTable(b);
  dimstyleTable(b);
  handles.modelSpace = b.next();
  handles.paperSpace = b.next();
  blockRecordTable(b, handles);
  b.p(0, 'ENDSEC');

  blocksSection(b, handles);

  b.p(0, 'SECTION').p(2, 'ENTITIES');
  let written = 0;
  for (const e of spec.entities || []) {
    // сущность с негодной вершиной не пишется вовсе: одна такая точка уводит
    // габариты чертежа в начало координат, а по счётчикам это незаметно
    const bad = badPoint(e);
    if (bad) {
      warnings.push(`Пропущена сущность (${ENTITY_LABELS[e.type] || e.type}, слой ${e.layer || '0'}): `
        + `вершина ${JSON.stringify(bad)} не является парой чисел. Эта часть чертежа не выгружена.`);
      continue;
    }
    if (e.type === 'polyline' && e.points && e.points.length >= 2) polyline(b, e, handles.modelSpace);
    else if (e.type === 'text' && e.point) text(b, e, handles.modelSpace);
    else if (e.type === 'hatch' && e.boundary && e.boundary.length >= 3) hatch(b, e, handles.modelSpace);
    else continue;
    written += 1;
  }
  b.p(0, 'ENDSEC');

  if (!written && (spec.entities || []).length) {
    throw new DxfDataError('Ни одна сущность чертежа не пригодна к записи: во всех вершинах нечисловые '
      + 'координаты. Выгружать пустой DXF нельзя — это выглядело бы как исправный чертёж.');
  }

  objectsSection(b);
  b.p(0, 'EOF');

  const head = new DxfBuilder();
  header(head, spec, (b.handle + 16).toString(16).toUpperCase(), warnings);
  return head.text() + b.text();
}

/**
 * Спецификация → байты файла DXF в кодовой странице ANSI_1251.
 * Именно это пишется на диск: строка в UTF-8 нарушила бы объявленный
 * $DWGCODEPAGE, и кириллица снова превратилась бы в мусор.
 */
function writeSpecBuffer(spec, opts = {}) {
  return encodeDxf(writeSpec(spec, opts));
}

module.exports = {
  writeSpec, writeSpecBuffer, encodeDxf, toCodepageText, hatchPaths,
  INSUNITS_METERS, DWGCODEPAGE, clampColor, DxfDataError,
};
