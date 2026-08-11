'use strict';
/**
 * Простой писатель DXF R12 (AC1009): таблица слоёв и полилинии.
 *
 * Используется там, где нужен минимальный обмен геометрией: подготовка входных
 * данных в тестах и черновая выгрузка контуров. Полноценный чертёж генплана —
 * со штриховками зон, подписями и ТЭП — пишет `services/cad/dxf-writer.js`
 * в формате AC1015: в R12 сущности HATCH попросту нет.
 *
 * Тонкости R12, без которых файл не открывается:
 *  - у POLYLINE обязательны нулевые 10/20/30, иначе AutoCAD считает entity битой;
 *  - тип линии, названный в слое (код 6), обязан быть определён в таблице LTYPE;
 *  - у SEQEND должен быть тот же слой, что у полилинии.
 */
function dxfEscape(s) {
  return String(s).replace(/[\r\n]/g, ' ');
}

function writeDxf(layers) {
  const L = [];
  const push = (code, value) => { L.push(String(code), String(value)); };

  push(0, 'SECTION'); push(2, 'HEADER');
  push(9, '$ACADVER'); push(1, 'AC1009');
  // $INSUNITS здесь намеренно не пишется: единицы задаёт тот, кто готовит данные,
  // а разбор при их отсутствии принимает метры и ставит предупреждение
  push(0, 'ENDSEC');

  push(0, 'SECTION'); push(2, 'TABLES');
  // без определения CONTINUOUS ссылка из слоя повисает и файл считается битым
  push(0, 'TABLE'); push(2, 'LTYPE'); push(70, 1);
  push(0, 'LTYPE'); push(2, 'CONTINUOUS'); push(70, 0);
  push(3, 'Solid line'); push(72, 65); push(73, 0); push(40, '0.0');
  push(0, 'ENDTAB');

  push(0, 'TABLE'); push(2, 'LAYER'); push(70, layers.length + 1);
  push(0, 'LAYER'); push(2, '0'); push(70, 0); push(62, 7); push(6, 'CONTINUOUS');
  for (const layer of layers) {
    push(0, 'LAYER'); push(2, dxfEscape(layer.layer)); push(70, 0);
    push(62, Number.isInteger(layer.color) ? layer.color : 7); push(6, 'CONTINUOUS');
  }
  push(0, 'ENDTAB'); push(0, 'ENDSEC');

  push(0, 'SECTION'); push(2, 'ENTITIES');
  for (const layer of layers) {
    push(0, 'POLYLINE'); push(8, dxfEscape(layer.layer)); push(66, 1);
    push(10, '0.0'); push(20, '0.0'); push(30, '0.0');
    push(70, layer.closed ? 1 : 0);
    for (const [x, y] of layer.points) {
      push(0, 'VERTEX'); push(8, dxfEscape(layer.layer));
      push(10, x.toFixed(3)); push(20, y.toFixed(3)); push(30, '0.0');
    }
    push(0, 'SEQEND'); push(8, dxfEscape(layer.layer));
  }
  push(0, 'ENDSEC');
  push(0, 'EOF');
  return L.join('\n') + '\n';
}

module.exports = { writeDxf };
