'use strict';
/**
 * Аудит сцены офиса (В1): что висит в воздухе, что сидит внутри другого
 * предмета, работоспособность экстерьера — по зонам.
 *
 * Глазами такое не ищут — на скриншотах видно три случая, а в сцене их
 * десятки. Модуль подключается к собранной сцене и печатает таблицу, тем же
 * кодом пользуются автотесты (`tests/office.test.js` через headless Chromium).
 *
 * ЗОНЫ. Каждый предмет несёт `userData.zone` (ставится через `P.unit`):
 *   workplace  — Интерьер → Рабочие места: стол, кресло, человек, монитор,
 *                Mac Studio, клавиатура, мышь; сюда же эргономика
 *   furnishing — Интерьер → Наполнение: мебель, растения, развеска, книги,
 *                игры, макеты, машины
 *   exterior   — Экстерьер → Работоспособность: оболочка, фасад, проёмы,
 *                лестничные ядра, павильоны, кровли, окружение
 * Предмет = ближайший предок с `userData.unit` (его части — родня, они друг
 * друга не «пересекают»); меш без такого предка — предмет сам по себе.
 *
 * ПЕРЕСЕЧЕНИЯ. Прежний аудит сравнивал осевые коробки и ловил только
 * пересечение в 35 % меньшего предмета: мелкое не видел, у повёрнутых
 * предметов врал. Теперь — повёрнутые коробки (OBB) с разделяющими осями
 * (15 осей) и порогом по правилу 1: проникновение больше 2 мм. Для
 * предметов не коробчатой формы (цилиндры, сферы, профили) после OBB идёт
 * точная проверка «сетка против сетки» — треугольник против треугольника
 * по разделяющим осям, с потолком числа пар (иначе остаётся вердикт OBB с
 * пометкой «приближённо»). Широкая фаза — сетка ячеек 2 м по осевым
 * коробкам: предметов в сцене тысячи, попарно их не перебрать.
 *
 * Помеченное `userData.airborne` (через `P.air`) аудит парящих пропускает:
 * светильники, вывески, картины, лучи, стены — висят по замыслу.
 *
 * Модуль без импортов three: `THREE` передаётся снаружи, чтобы тест мог
 * подключить файл динамическим `import()` и подсунуть свою заглушку.
 */

const DEFAULT_TOL = 0.02;     // парящие: зазор до опоры
const GAP_MM = 2;             // правило 1: зазор не меньше 2 мм
const PENETRATION = GAP_MM / 1000;
const CELL = 2.0;             // ячейка широкой фазы, м
const TRI_PAIR_CAP = 60000;   // потолок пар треугольников на пару предметов
export const ZONES = ['workplace', 'furnishing', 'exterior'];
export const ZONE_TITLES = { workplace: 'Интерьер → Рабочие места', furnishing: 'Интерьер → Наполнение', exterior: 'Экстерьер → Работоспособность', unzoned: 'без зоны' };

/* ---------------- принадлежность ---------------- */

/** Оболочки окружения (небо, панорама) и всё с userData.auditSkip — не предметы: внутри них вся сцена. */
function isShell(o) {
  let p = o;
  while (p) { if (p.userData && p.userData.auditSkip) return true; p = p.parent; }
  const m = o.material;
  return !!(m && !Array.isArray(m) && m.side === 1 /* BackSide */);
}

/**
 * Что проверяется. `airborne` выводит предмет только из проверки ПАРЯЩИХ:
 * пересечения считаются всем, иначе пометка «висит по замыслу» снимала бы и
 * проверку на столкновения — так кольца ядра реактора уходили на три метра в
 * пол ямы незамеченными (круг 3 аудита В1).
 */
function isAudited(o, { airborne = false } = {}) {
  if (!o.isMesh && !o.isInstancedMesh) return false;
  if (isShell(o)) return false;
  if (airborne) return true;
  let p = o;
  while (p) {
    if (p.userData && p.userData.airborne) return false;
    p = p.parent;
  }
  return true;
}

export function labelOf(o) {
  let p = o, path = [];
  while (p && path.length < 3) {
    if (p.name) path.unshift(p.name);
    p = p.parent;
  }
  return path.join('/') || (o.geometry && o.geometry.type) || 'mesh';
}

/**
 * Предмет — ближайший предок с userData.unit, иначе самый верхний предок под
 * сценой или под контейнером (`userData.container`: оболочка, крылья,
 * окружение — их дети считаются отдельными предметами, а не одним целым).
 */
export function unitOf(o, mode = 'overlap') {
  let p = o;
  let top = o;
  while (p) {
    if (p.userData && p.userData.unit) return p;
    const parent = p.parent;
    const container = parent && parent.userData && parent.userData.container;
    // container: true — дети отдельные предметы в обеих проверках; 'floating' — только в проверке парящих
    const splits = container === true || (container === 'floating' && mode === 'floating');
    if (!parent || p.isScene || parent.isScene || splits) { top = p; break; }
    p = parent;
  }
  return top;
}

/** Зона — ближайший предок с userData.zone; нет — «unzoned». */
export function zoneOf(o) {
  let p = o;
  while (p) {
    if (p.userData && p.userData.zone) return p.userData.zone;
    p = p.parent;
  }
  return 'unzoned';
}

function unitName(o, mode = 'overlap') {
  const u = unitOf(o, mode);
  if (u.userData && u.userData.unit) return u.userData.unit;
  if (u.name) return u.name;
  // безымянная группа: имя первой именованной детали
  let found = '';
  u.traverse((c) => { if (!found && c.name) found = c.name; });
  return found || labelOf(o);
}

/** Родня: деталь внутри своего же предмета опорой и пересечением не считается. */
function isKin(a, b, mode = 'overlap') {
  const ua = unitOf(a, mode), ub = unitOf(b, mode);
  if (ua === ub) return true;
  let p = a; while (p) { if (p === b) return true; p = p.parent; }
  p = b; while (p) { if (p === a) return true; p = p.parent; }
  return false;
}

/* ---------------- парящие ---------------- */

/**
 * Висящие предметы: под низом предмета нет ни пола, ни другого предмета.
 * Опорой считается ЛЮБАЯ геометрия под центром низа — пол, крыша,
 * столешница, полка, кресло (первый прогон по полу давал 3024 строки).
 *
 * @param {object} THREE      модуль three (Box3/Vector3)
 * @param {object} root       корень сцены
 * @param {Function} floorAt  (x, z, y) → отметка пола
 */
export function auditFloating(THREE, root, floorAt, { tol = DEFAULT_TOL, minSize = 0.03 } = {}) {
  root.updateMatrixWorld(true);
  // опора — любая геометрия, включая помеченную airborne (плита второго этажа, кровля): на ней стоят
  const supports = [];
  root.traverse((o) => {
    if (!(o.isMesh || o.isInstancedMesh) || isShell(o)) return;
    const b = new THREE.Box3().setFromObject(o);
    if (!Number.isFinite(b.min.y) || !Number.isFinite(b.min.x)) return;
    supports.push({ obj: o, b });
  });
  // предмет — целиком (unitOf): части человека или стола друг над другом не «висят»
  const units = new Map();
  root.traverse((o) => {
    if (!isAudited(o)) return;
    const u = unitOf(o, 'floating');
    const b = new THREE.Box3().setFromObject(o);
    if (!Number.isFinite(b.min.y) || !Number.isFinite(b.min.x)) return;
    const size = Math.max(b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z);
    if (size < minSize) return;                    // мелочь вроде кнопок и швов
    if (!units.has(u)) units.set(u, { unit: u, b: b.clone(), lowest: o });
    else { const e = units.get(u); if (b.min.y < e.b.min.y) e.lowest = o; e.b.union(b); }
  });
  const out = [];
  for (const it of units.values()) {
    const { b, unit } = it;
    const cx = (b.min.x + b.max.x) / 2, cz = (b.min.z + b.max.z) / 2;
    // низ предмета опирается хоть где-то: центр и восемь точек по контуру подошвы
    // (дуга ряда амфитеатра касается пола не в центре своей коробки)
    const pts = [[cx, cz]];
    for (const fx of [0.1, 0.5, 0.9]) for (const fz of [0.1, 0.5, 0.9]) {
      if (fx === 0.5 && fz === 0.5) continue;
      pts.push([b.min.x + (b.max.x - b.min.x) * fx, b.min.z + (b.max.z - b.min.z) * fz]);
    }
    let support = -Infinity;
    for (const [px, pz] of pts) {
      let sp = floorAt(px, pz, b.min.y);
      for (const other of supports) {
        if (isKin(unit, other.obj, 'floating')) continue;
        const ob = other.b;
        if (px < ob.min.x || px > ob.max.x || pz < ob.min.z || pz > ob.max.z) continue;
        // верх опоры под низом предмета — или низ предмета уже внутри опоры (стоит в ней, заведён)
        if (ob.max.y <= b.min.y + tol && ob.max.y > sp) sp = ob.max.y;
        else if (ob.min.y - tol <= b.min.y && b.min.y <= ob.max.y + tol) sp = Math.max(sp, b.min.y);
      }
      if (sp > support) support = sp;
    }
    const gap = b.min.y - support;
    if (gap > tol) {
      out.push({ зона: zoneOf(unit), предмет: unitName(unit, 'floating'), деталь: labelOf(it.lowest), зазор: +gap.toFixed(3), x: +cx.toFixed(2), z: +cz.toFixed(2), низ: +b.min.y.toFixed(3) });
    }
  }
  return out.sort((a, b2) => b2.зазор - a.зазор);
}

/* ---------------- повёрнутые коробки и разделяющие оси ---------------- */

/** OBB меша (или экземпляра InstancedMesh) из локального бокса геометрии и мировой матрицы. */
function obbOf(THREE, geometry, matrixWorld) {
  if (!geometry.boundingBox) geometry.computeBoundingBox();
  const bb = geometry.boundingBox;
  const c = new THREE.Vector3().addVectors(bb.min, bb.max).multiplyScalar(0.5).applyMatrix4(matrixWorld);
  const half = new THREE.Vector3().subVectors(bb.max, bb.min).multiplyScalar(0.5);
  const m = matrixWorld;
  const ax = [new THREE.Vector3(m.elements[0], m.elements[1], m.elements[2]), new THREE.Vector3(m.elements[4], m.elements[5], m.elements[6]), new THREE.Vector3(m.elements[8], m.elements[9], m.elements[10])];
  const hs = [half.x * ax[0].length(), half.y * ax[1].length(), half.z * ax[2].length()];
  for (const a of ax) { const l = a.length(); if (l > 1e-12) a.divideScalar(l); }
  // осевая коробка для широкой фазы
  const aabb = new THREE.Box3();
  const corner = new THREE.Vector3();
  for (let i = 0; i < 8; i++) {
    corner.copy(c);
    corner.addScaledVector(ax[0], (i & 1 ? 1 : -1) * hs[0]);
    corner.addScaledVector(ax[1], (i & 2 ? 1 : -1) * hs[1]);
    corner.addScaledVector(ax[2], (i & 4 ? 1 : -1) * hs[2]);
    aabb.expandByPoint(corner);
  }
  return { c, ax, hs, aabb, vol: 8 * hs[0] * hs[1] * hs[2] };
}

/**
 * Разделяющие оси двух OBB: наименьшее проникновение по 15 осям (0 — не
 * пересекаются). Коробки ужаты на половину допуска каждая: касание и
 * вход меньше 2 мм пересечением не считаются.
 */
export function obbPenetration(THREE, A, B, tol = PENETRATION) {
  const d = new THREE.Vector3().subVectors(B.c, A.c);
  const axes = [...A.ax, ...B.ax];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    const cr = new THREE.Vector3().crossVectors(A.ax[i], B.ax[j]);
    if (cr.lengthSq() > 1e-10) axes.push(cr.normalize());
  }
  let minPen = Infinity;
  for (const L of axes) {
    const ra = A.hs[0] * Math.abs(L.dot(A.ax[0])) + A.hs[1] * Math.abs(L.dot(A.ax[1])) + A.hs[2] * Math.abs(L.dot(A.ax[2]));
    const rb = B.hs[0] * Math.abs(L.dot(B.ax[0])) + B.hs[1] * Math.abs(L.dot(B.ax[1])) + B.hs[2] * Math.abs(L.dot(B.ax[2]));
    const pen = ra + rb - Math.abs(d.dot(L)) - tol;
    if (pen <= 0) return 0;
    if (pen < minPen) minPen = pen;
  }
  return minPen;
}

/* ---------------- треугольник против треугольника ---------------- */

/** Проекция набора точек на ось: [min, max]. */
function project(points, axis) {
  let lo = Infinity, hi = -Infinity;
  for (const p of points) { const v = p.dot(axis); if (v < lo) lo = v; if (v > hi) hi = v; }
  return [lo, hi];
}

/** Пересекаются ли два треугольника в мировых координатах (разделяющие оси: 2 нормали + 9 рёберных). */
export function trianglesIntersect(THREE, t1, t2, tol = PENETRATION) {
  const axes = [];
  const e1 = [new THREE.Vector3().subVectors(t1[1], t1[0]), new THREE.Vector3().subVectors(t1[2], t1[1]), new THREE.Vector3().subVectors(t1[0], t1[2])];
  const e2 = [new THREE.Vector3().subVectors(t2[1], t2[0]), new THREE.Vector3().subVectors(t2[2], t2[1]), new THREE.Vector3().subVectors(t2[0], t2[2])];
  const n1 = new THREE.Vector3().crossVectors(e1[0], e1[1]);
  const n2 = new THREE.Vector3().crossVectors(e2[0], e2[1]);
  if (n1.lengthSq() < 1e-14 || n2.lengthSq() < 1e-14) return false;   // вырожденный
  axes.push(n1.normalize(), n2.normalize());
  for (const a of e1) for (const b of e2) { const c = new THREE.Vector3().crossVectors(a, b); if (c.lengthSq() > 1e-12) axes.push(c.normalize()); }
  for (const L of axes) {
    const [a0, a1] = project(t1, L);
    const [b0, b1] = project(t2, L);
    if (a1 - b0 <= tol || b1 - a0 <= tol) return false;
  }
  return true;
}

/** Треугольники меша в мировых координатах (для InstancedMesh — экземпляра с данной матрицей), с коробкой каждого. */
const triCache = new WeakMap();
function worldTriangles(THREE, geometry, matrixWorld, cacheKey) {
  const cached = cacheKey ? triCache.get(cacheKey) : null;
  if (cached && cached.matrix.equals(matrixWorld)) return cached.tris;
  const pos = geometry.attributes.position;
  if (!pos) return [];
  const idx = geometry.index;
  const n = idx ? idx.count : pos.count;
  const out = [];
  const v = () => new THREE.Vector3();
  for (let i = 0; i + 2 < n; i += 3) {
    const a = idx ? idx.getX(i) : i, b = idx ? idx.getX(i + 1) : i + 1, c = idx ? idx.getX(i + 2) : i + 2;
    const t = [v().fromBufferAttribute(pos, a).applyMatrix4(matrixWorld), v().fromBufferAttribute(pos, b).applyMatrix4(matrixWorld), v().fromBufferAttribute(pos, c).applyMatrix4(matrixWorld)];
    t.box = new THREE.Box3().setFromPoints(t);
    out.push(t);
  }
  if (cacheKey) triCache.set(cacheKey, { matrix: matrixWorld.clone(), tris: out });
  return out;
}

const BOXY = /^(Box|RoundedBox|Plane)Geometry$/;

/**
 * Точная проверка пары: есть ли пара пересекающихся треугольников. Сначала
 * берутся только треугольники, чьи коробки заходят в коробку чужого OBB —
 * у плиты кольца тысячи треугольников, рядом с креслом из них единицы. null —
 * пар всё равно слишком много (вердикт остаётся по OBB с пометкой).
 */
function meshesIntersect(THREE, a, b) {
  const ta = worldTriangles(THREE, a.geometry, a.matrix, a.obj.isInstancedMesh ? null : a.obj);
  const tb = worldTriangles(THREE, b.geometry, b.matrix, b.obj.isInstancedMesh ? null : b.obj);
  // отбор по общей зоне: сначала коробками предметов, потом — коробкой того,
  // что осталось у соседа (кольцо бортика × дуга носика: общие коробки велики,
  // а настоящие треугольники далеко друг от друга)
  let za = b.obb.aabb, zb = a.obb.aabb;
  let na = ta.filter((t) => t.box.intersectsBox(za));
  let nb = tb.filter((t) => t.box.intersectsBox(zb));
  for (let pass = 0; pass < 3 && na.length && nb.length; pass++) {
    const ua = new THREE.Box3(); for (const t of na) ua.union(t.box);
    const ub = new THREE.Box3(); for (const t of nb) ub.union(t.box);
    const n2 = na.filter((t) => t.box.intersectsBox(ub));
    const m2 = nb.filter((t) => t.box.intersectsBox(ua));
    if (n2.length === na.length && m2.length === nb.length) break;
    na = n2; nb = m2;
  }
  if (!na.length || !nb.length) return false;
  // сетка по треугольникам соседа: пара проверяется только в общих ячейках
  const cell = 0.25;
  const grid = new Map();
  const key = (x, y, z) => `${x},${y},${z}`;
  const cells = (box) => [Math.floor(box.min.x / cell), Math.floor(box.min.y / cell), Math.floor(box.min.z / cell), Math.floor(box.max.x / cell), Math.floor(box.max.y / cell), Math.floor(box.max.z / cell)];
  for (const t of nb) {
    const [x0, y0, z0, x1, y1, z1] = cells(t.box);
    if ((x1 - x0 + 1) * (y1 - y0 + 1) * (z1 - z0 + 1) > 4096) { grid.clear(); break; }   // гигантский треугольник — обычный перебор
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) {
      const k = key(x, y, z); const arr = grid.get(k); if (arr) arr.push(t); else grid.set(k, [t]);
    }
  }
  let pairs = 0;
  if (grid.size) {
    for (const t1 of na) {
      const [x0, y0, z0, x1, y1, z1] = cells(t1.box);
      const seen = new Set();
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) {
        const arr = grid.get(key(x, y, z)); if (!arr) continue;
        for (const t2 of arr) {
          if (seen.has(t2)) continue; seen.add(t2);
          if (!t1.box.intersectsBox(t2.box)) continue;
          if (++pairs > TRI_PAIR_CAP) return null;
          if (trianglesIntersect(THREE, t1, t2)) return true;
        }
      }
    }
    return false;
  }
  if (na.length * nb.length > TRI_PAIR_CAP) return null;
  for (const t1 of na) {
    for (const t2 of nb) {
      if (!t1.box.intersectsBox(t2.box)) continue;
      if (trianglesIntersect(THREE, t1, t2)) return true;
    }
  }
  return false;
}

/* ---------------- пересечения ---------------- */

/**
 * Предмет в предмете. items — список мешей (по умолчанию все аудируемые
 * меши корня, включая экземпляры InstancedMesh). Возвращает строки с зоной,
 * предметами, глубиной проникновения (мм) и способом проверки.
 *
 * @param {object} THREE
 * @param {object} root
 * @param {object} opts { exceptions: [{a: RegExp|string, b, why}], minSize }
 */
export function auditOverlaps(THREE, root, { exceptions = [], minSize = 0.02, items = null } = {}) {
  root.updateMatrixWorld(true);
  const list = [];
  const add = (o, matrix, label) => {
    if (!o.geometry) return;
    const ob = obbOf(THREE, o.geometry, matrix);
    const size = Math.max(ob.hs[0], ob.hs[1], ob.hs[2]) * 2;
    if (!Number.isFinite(size) || size < minSize) return;
    list.push({ obj: o, geometry: o.geometry, matrix, obb: ob, label, boxy: BOXY.test(o.geometry.type) });
  };
  const source = items || [];
  if (!items) root.traverse((o) => { if (isAudited(o, { airborne: true })) source.push(o); });
  const tmp = new THREE.Matrix4();
  for (const o of source) {
    if (o.isInstancedMesh) {
      const n = Math.min(o.count, 4000);
      for (let i = 0; i < n; i++) {
        o.getMatrixAt(i, tmp);
        add(o, new THREE.Matrix4().multiplyMatrices(o.matrixWorld, tmp), `${labelOf(o)}#${i}`);
      }
    } else if (o.isMesh) add(o, o.matrixWorld, labelOf(o));
  }
  // широкая фаза: сетка ячеек по осевым коробкам
  const grid = new Map();
  const key = (x, y, z) => `${x},${y},${z}`;
  list.forEach((e, idx) => {
    const { min, max } = e.obb.aabb;
    for (let x = Math.floor(min.x / CELL); x <= Math.floor(max.x / CELL); x++)
      for (let y = Math.floor(min.y / CELL); y <= Math.floor(max.y / CELL); y++)
        for (let z = Math.floor(min.z / CELL); z <= Math.floor(max.z / CELL); z++) {
          const k = key(x, y, z);
          if (!grid.has(k)) grid.set(k, []);
          grid.get(k).push(idx);
        }
  });
  const seen = new Set();
  const out = [];
  const excepted = [];
  const matches = (rule, na, nb) => {
    const m = (pat, s) => (pat instanceof RegExp ? pat.test(s) : (typeof pat === 'string' ? s.includes(pat) : true));
    return (m(rule.a, na) && m(rule.b, nb)) || (m(rule.a, nb) && m(rule.b, na));
  };
  for (const bucket of grid.values()) {
    for (let i = 0; i < bucket.length; i++) {
      for (let j = i + 1; j < bucket.length; j++) {
        const ia = Math.min(bucket[i], bucket[j]), ib = Math.max(bucket[i], bucket[j]);
        const pk = ia * 1e6 + ib;
        if (seen.has(pk)) continue;
        seen.add(pk);
        const a = list[ia], b = list[ib];
        if (a.obj === b.obj && a.obj.isInstancedMesh) continue;   // экземпляры одного инстанса — родня
        if (isKin(a.obj, b.obj)) continue;
        if (!a.obb.aabb.intersectsBox(b.obb.aabb)) continue;
        const pen = obbPenetration(THREE, a.obb, b.obb);
        if (pen <= 0) continue;
        let method = 'OBB';
        if (!(a.boxy && b.boxy)) {
          const hit = meshesIntersect(THREE, a, b);
          if (hit === false) continue;
          method = hit === null ? 'OBB (приближённо: слишком много треугольников)' : 'сетка';
        }
        const na = unitName(a.obj), nb = unitName(b.obj);
        const row = {
          зона: zoneOf(a.obj) === zoneOf(b.obj) ? zoneOf(a.obj) : `${zoneOf(a.obj)}+${zoneOf(b.obj)}`,
          первый: na, второй: nb, детали: `${a.label} × ${b.label}`,
          проникновение_мм: +(pen * 1000).toFixed(1), способ: method,
          x: +a.obb.c.x.toFixed(2), y: +a.obb.c.y.toFixed(2), z: +a.obb.c.z.toFixed(2),
        };
        const rule = exceptions.find((r) => matches(r, `${na}|${a.label}`, `${nb}|${b.label}`));
        if (rule) { excepted.push({ ...row, причина: rule.why }); continue; }
        out.push(row);
      }
    }
  }
  out.sort((p, q) => q.проникновение_мм - p.проникновение_мм);
  return Object.assign(out, { excepted });
}

/* ---------------- экстерьер: работоспособность ---------------- */

/**
 * Проверки экстерьера по плану здания: каждый проём достижим снаружи по
 * проходимой поверхности (под точкой перед проёмом есть земля и перед ним
 * ничего не стоит), кровли павильонов ниже низа окон второго этажа, сквозь
 * стекло ничего не проходит (пары с окном в списке пересечений), снаружи
 * ничего не висит (парящие в зоне exterior).
 *
 * @param plan  { RING, OPENINGS, PAVILIONS, pt, openingHalfAngle }
 */
export function auditExterior(THREE, root, plan, { floating = [], overlaps = [], exceptions = [] } = {}) {
  root.updateMatrixWorld(true);
  const out = [];
  const ray = new THREE.Raycaster();
  const meshes = [];
  root.traverse((o) => { if (o.isMesh && o.visible) meshes.push(o); });
  const down = new THREE.Vector3(0, -1, 0);
  for (const o of plan.OPENINGS) {
    const q = plan.pt(plan.RING.rOut + 1.2, o.at);
    ray.set(new THREE.Vector3(q.x, 6, q.z), down);
    const hits = ray.intersectObjects(meshes, false);
    const ground = hits.find((h) => h.point.y < 0.6);
    if (!ground) out.push({ зона: 'exterior', проверка: 'проём достижим снаружи', предмет: o.name, что: 'под точкой в 1,2 м перед проёмом нет поверхности', x: +q.x.toFixed(2), z: +q.z.toFixed(2) });
    else if (ground.point.y > 0.35) out.push({ зона: 'exterior', проверка: 'проём достижим снаружи', предмет: o.name, что: `перед проёмом поверхность на ${ground.point.y.toFixed(2)} м — ступень выше 0,35 м`, x: +q.x.toFixed(2), z: +q.z.toFixed(2) });
    // перед проёмом на высоте человека ничего не стоит: луч от проёма наружу
    const dir = new THREE.Vector3(Math.sin(o.at), 0, Math.cos(o.at));
    const from = plan.pt(plan.RING.rOut + 0.2, o.at);
    ray.set(new THREE.Vector3(from.x, 1.2, from.z), dir);
    ray.far = 2.5;
    const block = ray.intersectObjects(meshes, false).find((h) => !/газон|земл|ground/i.test(labelOf(h.object)));
    if (block) out.push({ зона: 'exterior', проверка: 'дверь не перекрыта', предмет: o.name, что: `в ${block.distance.toFixed(2)} м перед проёмом стоит «${labelOf(block.object)}»`, x: +from.x.toFixed(2), z: +from.z.toFixed(2) });
    ray.far = Infinity;
  }
  // кровли павильонов ниже низа окон второго этажа
  const sill2 = plan.RING.floor2 + 0.95;
  root.traverse((o) => {
    if (!o.isMesh || !/кровля павильона/i.test(o.name)) return;
    const b = new THREE.Box3().setFromObject(o);
    if (b.max.y > sill2 + 0.001) out.push({ зона: 'exterior', проверка: 'кровля ниже низа окон', предмет: labelOf(o), что: `верх кровли ${b.max.y.toFixed(2)} м выше низа окон второго этажа ${sill2.toFixed(2)} м`, x: +((b.min.x + b.max.x) / 2).toFixed(2), z: +((b.min.z + b.max.z) / 2).toFixed(2) });
  });
  // сквозь стекло ничего не проходит
  for (const r of overlaps) {
    if (/окно|стекл/i.test(r.первый) !== /окно|стекл/i.test(r.второй)) out.push({ зона: 'exterior', проверка: 'сквозь стекло ничего не проходит', предмет: `${r.первый} × ${r.второй}`, что: `проникновение ${r.проникновение_мм} мм`, x: r.x, z: r.z });
  }
  // снаружи ничего не висит
  for (const f of floating) if (f.зона === 'exterior') out.push({ зона: 'exterior', проверка: 'снаружи ничего не висит', предмет: f.предмет, что: `зазор ${f.зазор} м`, x: f.x, z: f.z });
  const kept = [];
  const excepted = [];
  for (const row of out) {
    const rule = exceptions.find((r) => (r.check ? r.check === row.проверка : true) && (r.pattern instanceof RegExp ? r.pattern.test(row.предмет) : String(row.предмет).includes(r.pattern)));
    if (rule) excepted.push({ ...row, причина: rule.why }); else kept.push(row);
  }
  return Object.assign(kept, { excepted });
}

/* ---------------- сводка по зонам ---------------- */

/** Полный аудит: парящие + пересечения + экстерьер, сгруппировано по зонам. */
export function auditAll(THREE, root, floorAt, plan, { exceptions = [], airborneOk = [], exteriorOk = [] } = {}) {
  const floatingAll = auditFloating(THREE, root, floorAt);
  const floating = floatingAll.filter((f) => !airborneOk.some((r) => (r.pattern instanceof RegExp ? r.pattern.test(`${f.предмет}|${f.деталь}`) : `${f.предмет}|${f.деталь}`.includes(r.pattern))));
  const floatingExcepted = floatingAll.length - floating.length;
  const overlaps = auditOverlaps(THREE, root, { exceptions });
  const exterior = plan ? auditExterior(THREE, root, plan, { floating, overlaps, exceptions: exteriorOk }) : [];
  const zones = {};
  for (const z of [...ZONES, 'unzoned']) zones[z] = { floating: [], overlaps: [], exterior: [] };
  const zoneKey = (z) => (zones[z] ? z : (String(z).split('+').find((k) => zones[k]) || 'unzoned'));
  for (const f of floating) zones[zoneKey(f.зона)].floating.push(f);
  for (const o of overlaps) zones[zoneKey(o.зона)].overlaps.push(o);
  for (const e of exterior) zones.exterior.exterior.push(e);
  const counts = {};
  let total = 0;
  for (const [z, v] of Object.entries(zones)) {
    counts[z] = { floating: v.floating.length, overlaps: v.overlaps.length, exterior: v.exterior.length };
    total += v.floating.length + v.overlaps.length + v.exterior.length;
  }
  return { total, counts, zones, excepted: { overlaps: overlaps.excepted.length, floating: floatingExcepted, exterior: exterior.excepted ? exterior.excepted.length : 0 } };
}

/** Печать таблицы в консоль браузера — для ручного прогона. */
export function report(rows, title) {
  // eslint-disable-next-line no-console
  console.log(`${title}: ${rows.length}`);
  // eslint-disable-next-line no-console
  if (rows.length) console.table(rows.slice(0, 80));
  return rows;
}
