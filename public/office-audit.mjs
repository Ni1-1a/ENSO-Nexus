'use strict';
/**
 * Аудит сцены офиса: что висит в воздухе и что сидит внутри другого предмета.
 *
 * Глазами такое не ищут — на скриншотах видно три случая, а в сцене их
 * десятки. Модуль подключается к собранной сцене и печатает таблицу, тем же
 * кодом пользуются автотесты.
 *
 * Правило пометки: `userData.airborne = true` ставится тому, что висит ПО
 * ЗАМЫСЛУ — светильники, вывески, картины, лучи, рыбы, облака, парапеты,
 * подвесные растения. Всё остальное обязано стоять на полу или на другом
 * предмете.
 *
 * Модуль без импортов three: `THREE` передаётся снаружи, чтобы тест мог
 * подключить файл динамическим `import()` и подсунуть свою заглушку.
 */

/** Предмет считается опёртым, если его низ лежит на полу или на другом предмете. */
const DEFAULT_TOL = 0.02;

function isAudited(o) {
  if (!o.isMesh && !o.isInstancedMesh) return false;
  let p = o;
  while (p) {
    if (p.userData && p.userData.airborne) return false;
    p = p.parent;
  }
  return true;
}

function labelOf(o) {
  let p = o, path = [];
  while (p && path.length < 3) {
    if (p.name) path.unshift(p.name);
    p = p.parent;
  }
  return path.join('/') || (o.geometry && o.geometry.type) || 'mesh';
}

/**
 * Висящие предметы: под низом предмета нет ни пола, ни другого предмета.
 *
 * Опорой считается ЛЮБАЯ геометрия под центром низа — пол, крыша, столешница,
 * полка, кресло. Сравнивать только с полом бессмысленно: кружка на столе и
 * куст на крыше честно «висят» над полом, и настоящие дефекты тонут в этом
 * списке (первый прогон выдал 3024 строки, из них по делу единицы).
 *
 * @param {object} THREE      модуль three (Box3/Vector3)
 * @param {object} root       корень сцены
 * @param {Function} floorAt  (x, z, y) → отметка пола
 */
export function auditFloating(THREE, root, floorAt, { tol = DEFAULT_TOL, minSize = 0.03 } = {}) {
  root.updateMatrixWorld(true);
  const items = [];
  root.traverse((o) => {
    if (!isAudited(o)) return;
    const b = new THREE.Box3().setFromObject(o);
    if (!Number.isFinite(b.min.y) || !Number.isFinite(b.min.x)) return;
    const size = Math.max(b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z);
    if (size < minSize) return;                    // мелочь вроде кнопок и швов
    items.push({ obj: o, b });
  });
  const out = [];
  for (const it of items) {
    const { b, obj } = it;
    const cx = (b.min.x + b.max.x) / 2, cz = (b.min.z + b.max.z) / 2;
    let support = floorAt(cx, cz, b.min.y);
    for (const other of items) {
      if (other === it || isKin(obj, other.obj)) continue;
      const ob = other.b;
      if (cx < ob.min.x || cx > ob.max.x || cz < ob.min.z || cz > ob.max.z) continue;
      if (ob.max.y <= b.min.y + tol && ob.max.y > support) support = ob.max.y;
    }
    const gap = b.min.y - support;
    if (gap > tol) out.push({ предмет: labelOf(obj), зазор: +gap.toFixed(3), x: +cx.toFixed(2), z: +cz.toFixed(2), низ: +b.min.y.toFixed(3) });
  }
  return out.sort((a, b2) => b2.зазор - a.зазор);
}

/** Родня: деталь внутри своего же предмета опорой не считается. */
function isKin(a, b) {
  let p = a; while (p) { if (p === b) return true; p = p.parent; }
  p = b; while (p) { if (p === a) return true; p = p.parent; }
  return false;
}

/**
 * Предмет в предмете: попарное пересечение ограничивающих коробов у соседей.
 * Родство не считается пересечением — деталь внутри своей же группы норма;
 * ищем разные предметы, у которых пересечение занимает заметную долю меньшего.
 */
export function auditOverlaps(THREE, items, { share = 0.35 } = {}) {
  const boxes = items.map((o) => {
    const b = new THREE.Box3().setFromObject(o);
    return { obj: o, b, vol: Math.max(1e-9, (b.max.x - b.min.x) * (b.max.y - b.min.y) * (b.max.z - b.min.z)) };
  }).filter((e) => Number.isFinite(e.vol) && e.vol > 1e-6);
  const out = [];
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], c = boxes[j];
      const dx = Math.min(a.b.max.x, c.b.max.x) - Math.max(a.b.min.x, c.b.min.x);
      const dy = Math.min(a.b.max.y, c.b.max.y) - Math.max(a.b.min.y, c.b.min.y);
      const dz = Math.min(a.b.max.z, c.b.max.z) - Math.max(a.b.min.z, c.b.min.z);
      if (dx <= 0 || dy <= 0 || dz <= 0) continue;
      const inter = dx * dy * dz;
      const k = inter / Math.min(a.vol, c.vol);
      if (k >= share) out.push({ первый: labelOf(a.obj), второй: labelOf(c.obj), доля: +k.toFixed(2), объём: +inter.toFixed(3) });
    }
  }
  return out.sort((a, b) => b.доля - a.доля);
}

/** Печать таблицы в консоль браузера — для ручного прогона. */
export function report(rows, title) {
  // eslint-disable-next-line no-console
  console.log(`${title}: ${rows.length}`);
  // eslint-disable-next-line no-console
  if (rows.length) console.table(rows.slice(0, 80));
  return rows;
}
