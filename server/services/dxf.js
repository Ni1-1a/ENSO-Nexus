'use strict';
/**
 * Minimal DXF (AC1009/R12 ASCII) writer: LAYER table + LWPOLYLINE-style POLYLINE entities.
 * R12 is readable by AutoCAD, LibreCAD, ODA viewers.
 */
function dxfEscape(s) {
  return String(s).replace(/[\r\n]/g, ' ');
}

function writeDxf(layers) {
  const L = [];
  const push = (code, value) => { L.push(String(code), String(value)); };

  push(0, 'SECTION'); push(2, 'HEADER');
  push(9, '$ACADVER'); push(1, 'AC1009');
  push(0, 'ENDSEC');

  push(0, 'SECTION'); push(2, 'TABLES');
  push(0, 'TABLE'); push(2, 'LAYER'); push(70, layers.length);
  for (const layer of layers) {
    push(0, 'LAYER'); push(2, dxfEscape(layer.layer)); push(70, 0);
    push(62, Number.isInteger(layer.color) ? layer.color : 7); push(6, 'CONTINUOUS');
  }
  push(0, 'ENDTAB'); push(0, 'ENDSEC');

  push(0, 'SECTION'); push(2, 'ENTITIES');
  for (const layer of layers) {
    push(0, 'POLYLINE'); push(8, dxfEscape(layer.layer)); push(66, 1);
    push(70, layer.closed ? 1 : 0);
    for (const [x, y] of layer.points) {
      push(0, 'VERTEX'); push(8, dxfEscape(layer.layer));
      push(10, x.toFixed(3)); push(20, y.toFixed(3)); push(30, '0.0');
    }
    push(0, 'SEQEND');
  }
  push(0, 'ENDSEC');
  push(0, 'EOF');
  return L.join('\n') + '\n';
}

module.exports = { writeDxf };
