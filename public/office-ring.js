'use strict';
/**
 * Оболочка здания «Кольцо с атриумом»: полы, наружная стена, парапет атриума,
 * перегородки секторов, лестничные ядра, павильоны и сам атриум с садом и
 * амфитеатром. Числа берутся из `office-plan.mjs`, три градации светлого — из
 * Н1 ТЗ №2.
 *
 * Правила, которые здесь соблюдаются буквально:
 *  - пол одной отметки — ОДИН меш с развёрткой в мировых координатах (Р4);
 *  - стена и плита — объём, а не плоскость (правило 2);
 *  - ступень, парапет и подоконник темнее пола, пол темнее стены (Н1);
 *  - геометрия лестницы и поверхность ходьбы — из одного реестра (правило 11).
 */

import * as THREE from './vendor/three.module.min.js';
import { RoundedBoxGeometry } from './vendor/RoundedBoxGeometry.js';
import * as P from './office-props.js?v=8';
import {
  RING, FLOOR1, FLOOR2, PAVILIONS, CORES, ATRIUM, pt,
  OPENINGS, openingHalfAngle, openingOnFloor, wallGaps, coreLink, structuralBlockers,
} from './office-plan.mjs?v=8';
import { stairStep, railPose } from './office-geom.mjs?v=8';

/* ---------- Н1: три градации светлого ---------- */

export const TONE = {
  wall: 0xf3efe6,     // стена — самый светлый
  floor: 0xe8e3d9,    // пол темнее стены
  detail: 0xdcd5c6,   // ступень, парапет, подоконник — темнее пола
  seam: 0x26211b,     // теневой шов тушью
  glass: 0xbcd4dd,
};

const SEAM = 0.045;    // теневой шов 45 мм

let _stone = null;
function stoneTexture() {
  if (_stone) return _stone;
  const { texture } = P.canvasTexture(1024, 1024, (c, w, h) => {
    c.fillStyle = '#efeae0'; c.fillRect(0, 0, w, h);
    for (let i = 0; i < 5200; i++) {
      const x = Math.random() * w, y = Math.random() * h, r = 1 + Math.random() * 3;
      c.fillStyle = `rgba(${190 + Math.random() * 40},${182 + Math.random() * 40},${168 + Math.random() * 40},.5)`;
      c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fill();
    }
    c.strokeStyle = 'rgba(150,142,128,.20)'; c.lineWidth = 2;
    for (let i = 0; i <= 4; i++) { c.beginPath(); c.moveTo(0, i * 256); c.lineTo(w, i * 256); c.stroke(); c.beginPath(); c.moveTo(i * 256, 0); c.lineTo(i * 256, h); c.stroke(); }
  });
  _stone = texture;
  return _stone;
}

export function stoneMat(tone = TONE.floor, mM = 4) {
  const t = P.tiled(stoneTexture(), mM, mM);
  return new THREE.MeshStandardMaterial({ map: t, color: tone, roughness: 0.55, metalness: 0.03 });
}

/**
 * Р4: развёртка в МИРОВЫХ координатах. Пол кольца — полярная: доска идёт по
 * касательной к окружности, рисунок непрерывен через всё здание и швов между
 * участками нет по определению. Период подобран так, чтобы по окружности
 * укладывалось целое число досок — иначе стык на φ = 0 виден полосой.
 */
function polarUV(geo, { plank = 2.007, across = 0.16 } = {}) {
  const pos = geo.attributes.position;
  const uv = geo.attributes.uv;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    // геометрия строится в плоскости XY и кладётся поворотом — берём обе пары
    const wx = x, wz = geo.userData.flat ? y : z;
    const r = Math.hypot(wx, wz);
    const a = Math.atan2(wx, wz);
    uv.setXY(i, (a * RING.rOut) / plank, r / (plank * across * 12));
  }
  uv.needsUpdate = true;
}

function worldUV(geo, period = 2.0) {
  const pos = geo.attributes.position;
  const uv = geo.attributes.uv;
  for (let i = 0; i < pos.count; i++) uv.setXY(i, pos.getX(i) / period, pos.getY(i) / period);
  uv.needsUpdate = true;
}

/** кольцо как плита толщиной 200 мм: сверху камень, снизу тень */
function ringSlab(rIn, rOut, y, thickness = 0.2, tone = TONE.floor) {
  const shape = new THREE.Shape();
  shape.absarc(0, 0, rOut, 0, Math.PI * 2, false);
  const hole = new THREE.Path();
  hole.absarc(0, 0, rIn, 0, Math.PI * 2, true);
  shape.holes.push(hole);
  const geo = new THREE.ExtrudeGeometry(shape, { depth: thickness, bevelEnabled: false, curveSegments: 96 });
  geo.userData.flat = true;
  polarUV(geo);
  geo.rotateX(-Math.PI / 2);
  geo.translate(0, y, 0);
  const m = new THREE.Mesh(geo, stoneMat(tone, 2));
  m.receiveShadow = true;
  m.name = 'плита';
  return m;
}

/**
 * Угол плана φ (от юга, к востоку) в угол шейпа. `ExtrudeGeometry` строится в
 * плоскости XY и после `rotateX(−π/2)` ложится так: shape +X → мир +X,
 * shape +Y → мир −Z. Значит направление φ = (sin φ, cos φ) в мире отвечает
 * углу шейпа φ − π/2.
 */
const SA = (phi) => phi - Math.PI / 2;

function arcWall(r, from, to, y0, y1, mat, t = RING.wallT, seg = 64) {
  const shape = new THREE.Shape();
  shape.absarc(0, 0, r + t / 2, from, to, false);
  shape.absarc(0, 0, r - t / 2, to, from, true);
  const geo = new THREE.ExtrudeGeometry(shape, { depth: y1 - y0, bevelEnabled: false, curveSegments: seg });
  geo.rotateX(-Math.PI / 2);
  geo.translate(0, y1, 0);
  const m = new THREE.Mesh(geo, mat);
  m.castShadow = true; m.receiveShadow = true;
  return m;
}

function box(w, h, d, mat, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  return m;
}

/* ---------- парапет: одна деталь на 66 погонных метров ---------- */

function parapetArc(r, from, to, y, { glass = true } = {}) {
  const g = new THREE.Group();
  const solid = arcWall(r, from, to, y, y + 0.12, stoneMat(TONE.detail, 2), 0.16, 96);
  g.add(solid);
  if (glass) {
    const gl = arcWall(r, from, to, y + 0.12, y + RING.parapet - 0.04, new THREE.MeshPhysicalMaterial({
      color: 0xeaf2f6, transparent: true, opacity: 0.16, roughness: 0.03, metalness: 0.1, side: THREE.DoubleSide, depthWrite: false,
    }), 0.024, 96);
    P.air(gl);
    g.add(gl);
  }
  const rail = new THREE.Mesh(new THREE.TorusGeometry(r, 0.022, 8, Math.max(24, Math.round((to - from) * 40)), to - from), P.MAT.chrome());
  rail.rotation.x = -Math.PI / 2;
  rail.rotation.z = -from;                       // Torus начинает дугу с +x, план — с +z
  rail.position.y = y + RING.parapet;
  P.air(rail);
  g.add(rail);
  return g;
}

/* ---------- лестница ядра ---------- */

function coreStair(spec) {
  const g = new THREE.Group();
  const stepMat = stoneMat(TONE.detail, 1.5);
  const w = spec.axis === 'z' ? spec.x1 - spec.x0 : spec.z1 - spec.z0;
  const len = spec.axis === 'z' ? spec.z1 - spec.z0 : spec.x1 - spec.x0;
  const rise = (spec.yTo - spec.yFrom) / spec.steps;
  const run = len / spec.steps;
  for (let i = 0; i < spec.steps; i++) {
    const p = stairStep(spec, i);
    const st = spec.axis === 'z'
      ? box(w - 0.06, Math.abs(rise) + 0.02, Math.abs(run) + 0.02, stepMat, p.x, p.y, p.z)
      : box(Math.abs(run) + 0.02, Math.abs(rise) + 0.02, w - 0.06, stepMat, p.x, p.y, p.z);
    st.castShadow = true; st.receiveShadow = true;
    g.add(st);
    // теневой шов по кромке: без него ступень не отличается от ступени (Н1)
    const nos = spec.axis === 'z'
      ? box(w - 0.06, 0.014, SEAM * 0.7, P.MAT.ink(), p.x, p.y + Math.abs(rise) / 2 + 0.005, p.z - Math.sign(run) * Math.abs(run) / 2)
      : box(SEAM * 0.7, 0.014, w - 0.06, P.MAT.ink(), p.x - Math.sign(run) * Math.abs(run) / 2, p.y + Math.abs(rise) / 2 + 0.005, p.z);
    g.add(nos);
  }
  const pose = railPose({ axis: spec.axis, yFrom: spec.yFrom, yTo: spec.yTo, len });
  const rail = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, pose.length, 12), P.MAT.chrome());
  const side = spec.railSide > 0 ? (spec.axis === 'z' ? spec.x1 : spec.z1) : (spec.axis === 'z' ? spec.x0 : spec.z0);
  if (spec.axis === 'z') rail.position.set(side, pose.midY, (spec.z0 + spec.z1) / 2);
  else rail.position.set((spec.x0 + spec.x1) / 2, pose.midY, side);
  rail.rotation[pose.key] = pose.angle;
  P.air(rail);
  g.add(rail);
  for (let i = 0; i <= Math.round(Math.abs(len) / 1.2); i++) {
    const t = i / Math.max(1, Math.round(Math.abs(len) / 1.2));
    const along = (spec.axis === 'z' ? spec.z1 : spec.x1) - len * t;
    const y = spec.yFrom + (spec.yTo - spec.yFrom) * t;
    const post = spec.axis === 'z'
      ? box(0.03, RING.parapet - 0.05, 0.03, P.MAT.graphite(), side, y + (RING.parapet - 0.05) / 2, along)
      : box(0.03, RING.parapet - 0.05, 0.03, P.MAT.graphite(), along, y + (RING.parapet - 0.05) / 2, side);
    P.air(post);
    g.add(post);
  }
  return g;
}

/* ================= сборка ================= */

export function buildShell(scene, ctx) {
  const g = new THREE.Group();
  g.name = 'оболочка';
  scene.add(g);

  /* --- полы: по одному мешу на отметку, развёртка мировая (Р4) --- */
  const slab1 = ringSlab(RING.rIn, RING.rOut, RING.floor1, 0.22);
  g.add(slab1);
  const slab2 = ringSlab(RING.rIn, RING.rOut, RING.floor2, 0.22);
  P.air(slab2, 'плита второго этажа');
  g.add(slab2);

  /* --- наружная стена: объём на два этажа, лента окон на обоих --- */
  const wallMat = stoneMat(TONE.wall, 6);
  ctx.wallMat = wallMat;
  const topY = RING.floor2 + RING.height;
  const glassMat = new THREE.MeshPhysicalMaterial({
    color: 0xdfeaf2, transmission: 0.9, thickness: 0.02, roughness: 0.04, ior: 1.45, transparent: true, side: THREE.DoubleSide,
  });
  ctx.windowMat = glassMat;
  // цоколь, простенок между этажами и парапет кровли — камень; между ними стекло
  const bands = [
    [0, 0.95, wallMat, false],
    [0.95, 3.35, glassMat, true],
    [3.35, RING.floor2 + 0.95, wallMat, false],
    [RING.floor2 + 0.95, RING.floor2 + 3.35, glassMat, true],
    [RING.floor2 + 3.35, topY, wallMat, false],
  ];
  /*
   * П2 ТЗ №3. Стена режется ПО РЕЕСТРУ ПРОЁМОВ: вместо одной дуги на 360° —
   * набор дуг между проёмами плюс перемычка над каждым. Толщина 300 мм в
   * проёме видна — ради этого стену и делали объёмом.
   */
  const rW = RING.rOut - RING.wallT / 2;
  const segFor = (a0, a1) => Math.max(8, Math.round(((a1 - a0) / (Math.PI * 2)) * 128));
  for (const [y0, y1, mat, isGlass] of bands) {
    const level = y0 >= RING.floor2 - 0.1 ? 2 : 1;
    for (const [a0, a1] of wallGaps(level)) {
      const w = arcWall(rW, SA(a0), SA(a1), y0, y1, mat, RING.wallT, segFor(a0, a1));
      if (isGlass) { P.air(w, 'окно'); ctx.windows.push(w); } else P.air(w, 'наружная стена');
      g.add(w);
    }
    // перемычка над проёмом: полоса стены выше его верха
    for (const o of OPENINGS) {
      if (!openingOnFloor(o, level)) continue;
      const base = level === 2 ? RING.floor2 : RING.floor1;
      const top = base + o.height;
      if (top >= y1 - 0.01 || top <= y0 + 0.01) continue;
      const half = openingHalfAngle(o);
      const lint = arcWall(rW, SA(o.at - half), SA(o.at + half), Math.max(y0, top), y1, mat, RING.wallT, 16);
      P.air(lint, `перемычка ${o.name}`);
      g.add(lint);
    }
  }
  /* --- косяки проёмов: четверть стены по краям, тушью --- */
  for (const o of OPENINGS) {
    for (const level of [1, 2]) {
      if (!openingOnFloor(o, level)) continue;
      const base = level === 2 ? RING.floor2 : RING.floor1;
      const half = openingHalfAngle(o);
      for (const side of [-1, 1]) {
        const q = pt(rW, o.at + side * half);
        const jamb = new THREE.Mesh(new THREE.BoxGeometry(RING.wallT - 0.02, o.height, 0.1), P.MAT.ink());
        jamb.position.set(q.x, base + o.height / 2, q.z);
        jamb.rotation.y = o.at + side * half;
        P.air(jamb, `косяк ${o.name}`);
        g.add(jamb);
      }
      const head = arcWall(rW, SA(o.at - half), SA(o.at + half), base + o.height - 0.1, base + o.height, P.MAT.ink(), RING.wallT - 0.02, 16);
      P.air(head, `притолока ${o.name}`);
      g.add(head);
    }
  }
  // подоконник — деталь темнее пола (Н1)
  for (const [y, level] of [[0.95, 1], [RING.floor2 + 0.95, 2]]) {
    for (const [a0, a1] of wallGaps(level)) {
      const sill = arcWall(rW - 0.06, SA(a0), SA(a1), y, y + 0.05, stoneMat(TONE.detail, 2), 0.2, segFor(a0, a1));
      P.air(sill);
      g.add(sill);
    }
  }

  /* --- перекрытие над вторым этажом и стеклянная крыша атриума --- */
  const roof = ringSlab(RING.rIn, RING.rOut, topY, 0.25, TONE.wall);
  P.air(roof, 'кровля');
  g.add(roof);
  const glassRoof = new THREE.Mesh(new THREE.CircleGeometry(RING.rIn + 0.4, 96), new THREE.MeshPhysicalMaterial({
    color: 0xdfeaf2, transmission: 0.86, roughness: 0.06, thickness: 0.02, transparent: true, side: THREE.DoubleSide,
  }));
  glassRoof.rotation.x = -Math.PI / 2;
  glassRoof.position.y = topY + 0.6;
  P.air(glassRoof, 'стеклянная крыша');
  g.add(glassRoof);
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    const beam = new THREE.Mesh(new THREE.BoxGeometry(RING.rIn + 0.4, 0.14, 0.12), P.MAT.brushed());
    beam.position.set(Math.sin(a) * (RING.rIn + 0.4) / 2, topY + 0.66, Math.cos(a) * (RING.rIn + 0.4) / 2);
    beam.rotation.y = a + Math.PI / 2;
    P.air(beam);
    g.add(beam);
  }

  /*
   * П2.4 ТЗ №3. СТЕНЫ СТАНОВЯТСЯ ПРЕПЯТСТВИЯМИ. Раньше `office-ring.js` не
   * регистрировал ни одного: стены было видно, но сквозь них ходили, а
   * единственной преградой была проверка радиуса в `insideWalkable`.
   * Список считается в плане — тем же кодом, которым его проверяет тест.
   */
  for (const b of structuralBlockers()) ctx.block(b);

  /* --- теневой шов в стыке стены и пола: 45 мм тушью (Н1) --- */
  for (const [y, level] of [[RING.floor1, 1], [RING.floor2, 2]]) {
    for (const [a0, a1] of wallGaps(level)) {
      const seam = arcWall(RING.rOut - RING.wallT, SA(a0), SA(a1), y, y + SEAM, P.MAT.ink(), 0.03, segFor(a0, a1));
      P.air(seam);
      g.add(seam);
    }
  }

  /* --- парапет по всему контуру атриума на втором этаже --- */
  g.add(P.air(parapetArc(RING.rIn + 0.12, 0, Math.PI * 2, RING.floor2), 'парапет атриума'));
  // и по кромке первого этажа у сада — низкий борт, чтобы кромка читалась
  const kerb = arcWall(RING.rIn + 0.08, 0, Math.PI * 2, RING.floor1 - 0.02, RING.floor1 + 0.1, stoneMat(TONE.detail, 2), 0.16, 96);
  g.add(kerb);

  /* --- перегородки между секторами: простенки от наружной стены к атриуму --- */
  const partMat = stoneMat(TONE.wall, 4);
  for (const level of [{ list: FLOOR1, y: RING.floor1 }, { list: FLOOR2, y: RING.floor2 }]) {
    for (const s of level.list) {
      const a = s.from;
      const p0 = pt(RING.rIn + 0.2, a), p1 = pt(RING.rOut - RING.wallT, a);
      const len = Math.hypot(p1.x - p0.x, p1.z - p0.z);
      // простенок с проходом: две тумбы по краям, между ними проём 3,2 м
      const gap = 3.2;
      const seg = (len - gap) / 2;
      for (const k of [seg / 2, len - seg / 2]) {
        const cx = p0.x + (p1.x - p0.x) * (k / len);
        const cz = p0.z + (p1.z - p0.z) * (k / len);
        const w = box(0.24, RING.height - 0.3, seg, partMat, cx, level.y + (RING.height - 0.3) / 2, cz);
        w.rotation.y = a;
        w.castShadow = true; w.receiveShadow = true;
        P.air(w, 'простенок');
        g.add(w);
      }
    }
  }

  /* --- лестничные ядра --- */
  for (const c of Object.values(CORES)) {
    const cg = new THREE.Group();
    cg.name = c.name;
    const w = c.x1 - c.x0, d = c.z1 - c.z0;
    const cx = (c.x0 + c.x1) / 2, cz = (c.z0 + c.z1) / 2;
    // пол, стены-коробка и кровля ядра
    const fl = new THREE.Mesh(new THREE.BoxGeometry(w, 0.22, d), stoneMat(TONE.floor, 3));
    fl.position.set(cx, RING.floor1 - 0.11, cz); fl.receiveShadow = true; cg.add(fl);
    /*
     * П2.3 ТЗ №3. У стены ядра со стороны кольца ЕСТЬ ПРОЁМ: раньше это была
     * глухая коробка из четырёх стен, и в ядро, куда по плану ведёт лестница,
     * было не войти.
     */
    const door = c.door;
    for (const side of ['z0', 'z1', 'x0', 'x1']) {
      const vertical = side === 'x0' || side === 'x1';
      const bx = vertical ? c[side] : cx;
      const bz = vertical ? cz : c[side];
      if (side === door.wall) {
        // стена с проёмом: две части по краям плюс перемычка над дверью
        const lo = vertical ? c.z0 : c.x0, hi = vertical ? c.z1 : c.x1;
        for (const [f, t] of [[lo, door.from], [door.to, hi]]) {
          if (t - f < 0.05) continue;
          const len = t - f, mid = (f + t) / 2;
          const wall = vertical ? box(0.24, topY, len, wallMat, bx, topY / 2, mid) : box(len, topY, 0.24, wallMat, mid, topY / 2, bz);
          wall.castShadow = true; wall.receiveShadow = true;
          P.air(wall, 'стена ядра'); cg.add(wall);
        }
        const dl = door.to - door.from, dm = (door.from + door.to) / 2;
        const lint = vertical
          ? box(0.24, topY - door.height, dl, wallMat, bx, door.height + (topY - door.height) / 2, dm)
          : box(dl, topY - door.height, 0.24, wallMat, dm, door.height + (topY - door.height) / 2, bz);
        P.air(lint, 'перемычка ядра'); cg.add(lint);
        // косяки: четверть проёма видна тушью
        for (const q of [door.from, door.to]) {
          const j = vertical ? box(0.26, door.height, 0.1, P.MAT.ink(), bx, door.height / 2, q) : box(0.1, door.height, 0.26, P.MAT.ink(), q, door.height / 2, bz);
          P.air(j, 'косяк ядра'); cg.add(j);
        }
        continue;
      }
      const wall = vertical ? box(0.24, topY, d, wallMat, bx, topY / 2, bz) : box(w, topY, 0.24, wallMat, bx, topY / 2, bz);
      wall.castShadow = true; wall.receiveShadow = true;
      P.air(wall, 'стена ядра');
      cg.add(wall);
    }
    // пол коридора от кольца до ядра
    const L = coreLink(c);
    const lf = new THREE.Mesh(new THREE.BoxGeometry(L.x1 - L.x0, 0.2, L.z1 - L.z0), stoneMat(TONE.floor, 3));
    lf.position.set((L.x0 + L.x1) / 2, RING.floor1 - 0.1, (L.z0 + L.z1) / 2);
    lf.receiveShadow = true; cg.add(lf);
    const top = box(w, 0.22, d, stoneMat(TONE.wall, 3), cx, topY + 0.11, cz);
    P.air(top); cg.add(top);
    cg.add(coreStair(c.stair));
    // площадка второго этажа в ядре
    // площадка второго этажа: полоса перед маршем, по ней возвращаются к двери
    const landZ = c.stair.yFrom > c.stair.yTo ? (c.z0 + c.stair.z0) / 2 : (c.z1 + c.stair.z1) / 2;
    const land = box(w - 0.4, 0.2, Math.abs(c.stair.yFrom > c.stair.yTo ? c.stair.z0 - c.z0 : c.z1 - c.stair.z1) + 0.4, stoneMat(TONE.floor, 2), cx, RING.floor2 - 0.1, landZ);
    P.air(land, 'площадка ядра'); cg.add(land);
    g.add(cg);
  }

  return {
    slab1, slab2, wallMat,
    update() {},
  };
}

/* ================= атриум: сад и амфитеатр ================= */

export function buildAtrium(scene, ctx) {
  const g = new THREE.Group();
  g.name = 'атриум';
  scene.add(g);

  const grassMat = new THREE.MeshStandardMaterial({ color: 0x6d9553, roughness: 0.95 });
  const stepMat = stoneMat(TONE.detail, 2);

  // сад: круглая плита сада, поверх — пять дуг амфитеатра лицом к экрану
  const lawn = new THREE.Mesh(new THREE.CircleGeometry(RING.rIn, 96), grassMat);
  lawn.rotation.x = -Math.PI / 2;
  lawn.position.y = 0.001;
  lawn.receiveShadow = true;
  lawn.name = 'газон атриума';
  g.add(lawn);

  const sz = -RING.rIn;                       // экран на северной кромке атриума
  for (let i = 0; i < ATRIUM.rows; i++) {
    const r0 = ATRIUM.rowR0 + i * ATRIUM.rowDepth;
    const r1 = r0 + ATRIUM.rowDepth;
    const y = i * ATRIUM.rowRise;
    // ряд — кольцевой сектор вокруг экрана, обрезанный кромкой атриума
    /*
     * ExtrudeGeometry строится в плоскости XY и после rotateX(−π/2) ложится
     * так: shape +X → мир +X, shape +Y → мир −Z, выдавливание → мир +Y.
     * Значит дуга ряда, которая должна раскрываться на ЮГ (+z), в плоскости
     * шейпа центрируется на −π/2. С прежним центром 0 ряды смотрели на восток
     * и в кадре не появлялись вовсе.
     */
    const c0 = -Math.PI / 2;
    const shape = new THREE.Shape();
    shape.absarc(0, 0, r1, c0 - 1.15, c0 + 1.15, false);
    shape.absarc(0, 0, r0, c0 + 1.15, c0 - 1.15, true);
    const geo = new THREE.ExtrudeGeometry(shape, { depth: ATRIUM.rowRise + 0.02, bevelEnabled: false, curveSegments: 48 });
    geo.userData.flat = true;
    worldUV(geo, 1.5);
    geo.rotateX(-Math.PI / 2);
    const row = new THREE.Mesh(geo, stepMat);
    // выдавливание идёт ВВЕРХ, поэтому отметка меша — низ, а верх ряда обязан
    // совпасть с `atriumFloor` (правило 11)
    row.position.set(0, y - ATRIUM.rowRise - 0.02, sz);
    row.receiveShadow = true; row.castShadow = true;
    row.name = `ряд ${i + 1}`;
    g.add(row);
    // теневой шов по носку ряда
    const nos = new THREE.Mesh(new THREE.TorusGeometry(r1, 0.018, 6, 64, 2.3), P.MAT.ink());
    nos.rotation.x = -Math.PI / 2;
    nos.rotation.z = c0 - 1.15;                 // порядок XYZ: Rz применяется первым
    nos.position.set(0, y + 0.012, sz);
    P.air(nos);
    g.add(nos);
  }

  // деревья по кромке атриума — сад внутри объёма, а не картинка за стеклом
  const trunkG = new THREE.CylinderGeometry(0.12, 0.18, 4.0, 6);
  const crownG = new THREE.IcosahedronGeometry(1.25, 1);
  const N = 9;
  const trunks = new THREE.InstancedMesh(trunkG, P.MAT.walnut(), N);
  const crowns = new THREE.InstancedMesh(crownG, new THREE.MeshStandardMaterial({ color: 0x477f47, roughness: 0.9, flatShading: true }), N);
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), pos = new THREE.Vector3();
  const spots = [];
  for (let i = 0; i < N; i++) {
    // деревья стоят по КРОМКЕ сада и не заходят в его середину: с прежним
    // r = rIn − 1.5 и высотой кроны 3.4 крона висела ровно на уровне глаз
    const a = (i / N) * Math.PI * 2 + 0.35;
    // ОСЬ ЭКРАНА СВОБОДНА: дерево на φ ≈ 180° закрывало главный экран, ради
    // которого атриум и построен (скриншот 02 круга 3)
    if (Math.abs(Math.PI - a) < 0.55) continue;
    // деревья отодвинуты от кромки атриума: на r = rIn − 1.5 крона висела ровно
    // на уровне глаз того, кто идёт по кольцу
    const r = RING.rIn - 1.4 - (i % 3) * 0.5;
    const x = Math.sin(a) * r, z = Math.cos(a) * r;
    const k = 0.85 + ((i * 7) % 5) / 10;
    pos.set(x, 2.05 * k, z); sc.setScalar(k);
    m4.compose(pos, q, sc); trunks.setMatrixAt(i, m4);
    pos.set(x, 4.9 * k, z); sc.setScalar(k * 1.05);
    m4.compose(pos, q, sc); crowns.setMatrixAt(i, m4);
    spots.push({ x, z, r: 0.6 });
  }
  ctx.treeSpots = spots;
  trunks.instanceMatrix.needsUpdate = true; crowns.instanceMatrix.needsUpdate = true;
  trunks.castShadow = true; crowns.castShadow = true;
  trunks.name = 'деревья атриума';
  crowns.name = 'кроны атриума';
  // крона держится на стволе, но оба — InstancedMesh: их общие коробы аудит
  // сопоставить не может, поэтому крона помечена как навесная по замыслу
  P.air(crowns);
  g.add(trunks); g.add(crowns);

  return { group: g, trees: ctx.treeSpots || [], update() {} };
}

/* ================= павильоны ================= */

export function buildPavilionShell(scene, spec) {
  const g = new THREE.Group();
  g.name = spec.name;
  scene.add(g);
  const w = spec.x1 - spec.x0, d = spec.z1 - spec.z0;
  const cx = (spec.x0 + spec.x1) / 2, cz = (spec.z0 + spec.z1) / 2;
  const wallMat = stoneMat(TONE.wall, 6);

  const fl = new THREE.Mesh(new THREE.BoxGeometry(w, 0.24, d), stoneMat(TONE.floor, 4));
  fl.position.set(cx, spec.floor - 0.12, cz);
  fl.receiveShadow = true;
  fl.name = 'пол павильона';
  g.add(fl);
  for (const [bw, bd, bx, bz] of [[w + 0.5, 0.25, cx, spec.z0], [w + 0.5, 0.25, cx, spec.z1], [0.25, d, spec.x0, cz], [0.25, d, spec.x1, cz]]) {
    const wall = box(bw, spec.ceiling - spec.floor, bd, wallMat, bx, (spec.ceiling + spec.floor) / 2, bz);
    wall.castShadow = true; wall.receiveShadow = true;
    P.air(wall);
    g.add(wall);
  }
  const top = box(w + 0.5, 0.25, d + 0.5, stoneMat(TONE.wall, 4), cx, spec.ceiling + 0.12, cz);
  P.air(top, 'кровля павильона');
  g.add(top);

  // переход из кольца: пол, стены, потолок
  const L = spec.link;
  const lw = L.x1 - L.x0, ld = L.z1 - L.z0;
  const lx = (L.x0 + L.x1) / 2, lz = (L.z0 + L.z1) / 2;
  const lf = new THREE.Mesh(new THREE.BoxGeometry(lw, 0.22, ld), stoneMat(TONE.floor, 3));
  lf.position.set(lx, -0.11, lz); lf.receiveShadow = true; g.add(lf);
  for (const [bw, bd, bx, bz] of [[lw, 0.2, lx, L.z0], [lw, 0.2, lx, L.z1]]) {
    const wall = box(bw, 3.2, bd, wallMat, bx, 1.6, bz);
    P.air(wall); g.add(wall);
  }
  const lt = box(lw, 0.2, ld, stoneMat(TONE.wall, 3), lx, 3.3, lz);
  P.air(lt); g.add(lt);
  /*
   * Свет в переходе: проём в павильон читался чёрным прямоугольником — за ним
   * не было ни одного источника (скриншот 08 круга 3).
   */
  const n = Math.max(2, Math.round(Math.max(lw, ld) / 2.2));
  for (let i = 0; i < n; i++) {
    const t = (i + 0.5) / n;
    const px = lw > ld ? L.x0 + (L.x1 - L.x0) * t : lx;
    const pz = lw > ld ? lz : L.z0 + (L.z1 - L.z0) * t;
    const lamp = new THREE.PointLight(0xfff0dd, 1.4, 7, 1.6);
    lamp.position.set(px, 3.0, pz); g.add(lamp);
    const can = new THREE.Mesh(new THREE.CircleGeometry(0.16, 14), new THREE.MeshBasicMaterial({ color: 0xfff7ea }));
    can.rotation.x = Math.PI / 2; can.position.set(px, 3.18, pz);
    P.air(can); g.add(can);
  }
  return g;
}
