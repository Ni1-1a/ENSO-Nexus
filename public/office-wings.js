'use strict';
/**
 * Крылья здания и внешний мир витрины: аквариум-стена лобби, переговорная на
 * 12 человек с библиотекой на антресоли, гараж с разобранными машинами и
 * мотоциклами, зал-макет реактора (как в павильоне «Атом»), сад за окнами в
 * духе Gardens by the Bay. Здесь же — план проходимости (insideWalkable) и
 * пол с этажами (floorHeight) для ходьбы.
 *
 * Всё процедурное: силуэты машин — боковой профиль, выдавленный на ширину.
 */

import * as THREE from './vendor/three.module.min.js';
import { RoundedBoxGeometry } from './vendor/RoundedBoxGeometry.js';
import * as P from './office-props.js?v=5';
import { railPose } from './office-geom.mjs?v=5';

export const LEVEL = 1.02;    // первый этаж: лобби, фойе, крылья
export const FLOOR2 = 5.2;    // кольцевой лаундж и библиотека — вровень с низом окон
export const PIT = -1.9;      // дно зала реактора
export const MEZZ = FLOOR2;   // старое имя антресоли: библиотека переехала на второй этаж

/* прямоугольники проходимости: [x0, x1, z0, z1] */
export const ROOMS = {
  hall: [-15.4, 15.4, -9.6, 10.7],
  lobby: [-15.4, 15.4, 11.3, 20.6],
  door: [-6.0, 6.0, 10.2, 11.8],
  meeting: [16.6, 25.4, 11.6, 20.4],
  meetingDoor: [15.3, 16.7, 13.0, 15.2],
  garage: [16.6, 33.4, -10.2, 7.4],
  garageDoor: [15.3, 16.7, -1.2, 1.6],
  // зал реактора: балкон входа на уровне 1, лестница вниз, дно на PIT
  reactorBalcony: [-21.0, -15.3, -3.6, 3.9],
  reactorStair: [-23.6, -21.0, -1.2, 3.6],
  reactorFloor: [-33.4, -21.0, -10.2, 7.4],
  reactorDoor: [-16.7, -15.3, -1.2, 1.6],
  // второй этаж: кольцо вокруг зала
  ringW: [-15.4, -11.9, -10.6, 10.6],
  ringE: [11.9, 15.4, -10.6, 10.6],
  ringN: [-15.4, -9.0, -10.6, -7.4],
  ringN2: [9.0, 15.4, -10.6, -7.4],
  ringS: [-15.4, 15.4, 7.6, 10.6],
  stairMain: [2.6, 5.6, 12.6, 19.8],
  stairBridge: [2.6, 5.6, 10.4, 12.6],
  library: [16.6, 25.4, 11.6, 20.4],
  libraryBridge: [15.3, 16.7, 13.0, 15.2],
};
const inRect = (x, z, r) => x > r[0] && x < r[1] && z > r[2] && z < r[3];

const FIRST = ['hall', 'lobby', 'door', 'meeting', 'meetingDoor', 'garage', 'garageDoor', 'reactorBalcony', 'reactorDoor'];
const SECOND = ['ringW', 'ringE', 'ringN', 'ringN2', 'ringS', 'library', 'libraryBridge'];

export function insideWalkable(x, z) {
  for (const k of [...FIRST, ...SECOND, 'reactorStair', 'reactorFloor', 'stairMain', 'stairBridge']) {
    if (inRect(x, z, ROOMS[k])) return true;
  }
  return false;
}

/**
 * Высота пола: собираются кандидаты этой точки (первый этаж, лестницы, второй
 * этаж, дно реактора) и берётся САМЫЙ ВЫСОКИЙ из достижимых (шаг ≤ 0.45 м) —
 * так лестница поднимает, а под неё не подлезешь.
 */
export function floorHeight(x, z, prevY, base) {
  const cands = [];
  if (FIRST.some((k) => inRect(x, z, ROOMS[k]))) cands.push(base(x, z));
  if (inRect(x, z, ROOMS.reactorFloor)) cands.push(PIT);
  if (inRect(x, z, ROOMS.reactorStair)) {
    const t = Math.max(0, Math.min(1, (ROOMS.reactorStair[1] - x) / (ROOMS.reactorStair[1] - ROOMS.reactorStair[0])));
    cands.push(LEVEL + t * (PIT - LEVEL));
  }
  if (inRect(x, z, ROOMS.stairMain)) {
    const t = Math.max(0, Math.min(1, (ROOMS.stairMain[3] - z) / (ROOMS.stairMain[3] - ROOMS.stairMain[2])));
    cands.push(LEVEL + t * (FLOOR2 - LEVEL));
  }
  if (SECOND.some((k) => inRect(x, z, ROOMS[k])) || inRect(x, z, ROOMS.stairBridge)) cands.push(FLOOR2);
  if (!cands.length) cands.push(base(x, z));
  const reach = cands.filter((c) => Math.abs(c - prevY) < 0.45);
  if (reach.length) return Math.max(...reach);
  return cands.reduce((best, c) => (Math.abs(c - prevY) < Math.abs(best - prevY) ? c : best), cands[0]);
}

/* ================= общие помощники ================= */

/** светлый камень Apple Park: крупные плиты со швами и лёгким крапом */
function stoneTexture(size = 1024) {
  const { texture } = P.canvasTexture(size, size, (c) => {
    c.fillStyle = '#e8e3d9'; c.fillRect(0, 0, size, size);
    const tile = size / 4;
    for (let r = 0; r < 4; r++) for (let col = 0; col < 4; col++) { c.fillStyle = `hsl(40, 14%, ${89 + Math.random() * 4}%)`; c.fillRect(col * tile + 2, r * tile + 2, tile - 4, tile - 4); }
    for (let i = 0; i < 5200; i++) { c.fillStyle = `rgba(120,110,95,${0.02 + Math.random() * 0.05})`; c.beginPath(); c.arc(Math.random() * size, Math.random() * size, 0.6 + Math.random() * 1.8, 0, 7); c.fill(); }
    c.strokeStyle = 'rgba(120,110,95,.22)'; c.lineWidth = 2;
    for (let i = 0; i <= 4; i++) { c.beginPath(); c.moveTo(i * tile, 0); c.lineTo(i * tile, size); c.stroke(); c.beginPath(); c.moveTo(0, i * tile); c.lineTo(size, i * tile); c.stroke(); }
  });
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  return texture;
}
let _stone = null;
/**
 * Камень по размеру грани: `stoneMaterial(wM, hM)` считает repeat от метров
 * (512 пикс/м). Прежняя сигнатура с числом повторов оставлена совместимой:
 * одно число трактуется как размер квадратной грани в метрах.
 */
export function stoneMaterial(wM = 6, hM = null) {
  if (!_stone) _stone = stoneTexture();
  const t = P.tiled(_stone, wM, hM === null ? wM : hM);
  return new THREE.MeshStandardMaterial({ map: t, bumpMap: t, bumpScale: 0.012, roughness: 0.62, metalness: 0.02 });
}
/** цельное стекло Apple Park: почти без цвета и без рам */
export function appleGlass(opacity = 0.12) {
  return new THREE.MeshPhysicalMaterial({ color: 0xeaf2f6, transparent: true, opacity, roughness: 0.03, metalness: 0.1, side: THREE.DoubleSide, depthWrite: false });
}

function box(w, h, d, mat, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  return m;
}
function rbox(w, h, d, mat, r = 0.03) {
  return new THREE.Mesh(new RoundedBoxGeometry(w, h, d, 3, r), mat);
}
/**
 * Вывеска — ПРЕДМЕТ, а не наклейка (В11). Раньше это была одна плоскость с
 * `fillText` кеглем 60 на канве 768: «Библиотека нормативов» не влезала и
 * обрезалась по краю, а плашка висела в воздухе без корпуса и тени.
 * Теперь: корпус 25 мм, лицо на 2 мм перед корпусом (правило зазора),
 * кромка бренда, контактная тень, канва не ниже 512 пикс/м, кегль
 * подбирается `measureText` и не мельче 1/12 высоты плашки.
 */
function label(text, sub = '', w = 0.9, dark = false) {
  const h = w / 3;
  const cw = Math.max(1024, Math.round(w * 640 / 64) * 64);
  const ch = Math.round(cw / 3);
  const pad = Math.round(cw * 0.045);
  const { texture } = P.canvasTexture(cw, ch, (c) => {
    c.fillStyle = dark ? '#0f0f10' : '#fdfbf4'; c.fillRect(0, 0, cw, ch);
    c.fillStyle = '#b95740'; c.fillRect(0, 0, cw, Math.round(ch * 0.04));
    c.textBaseline = 'top';
    const room = cw - pad * 2;
    const minTitle = ch / 12;                       // нижний предел кегля
    let ts = Math.round(ch * (sub ? 0.30 : 0.38));
    c.font = `600 ${ts}px Georgia, serif`;
    while (c.measureText(text).width > room && ts > minTitle) {
      ts -= 2; c.font = `600 ${ts}px Georgia, serif`;
    }
    // не влезло даже минимальным — переносим по словам, а не режем по краю
    const lines = [];
    if (c.measureText(text).width > room) {
      let line = '';
      for (const word of String(text).split(' ')) {
        const probe = line ? line + ' ' + word : word;
        if (c.measureText(probe).width > room && line) { lines.push(line); line = word; } else line = probe;
      }
      lines.push(line);
    } else lines.push(text);
    c.fillStyle = dark ? '#ffffff' : '#26211b';
    lines.slice(0, 2).forEach((ln, i) => c.fillText(ln, pad, ch * 0.16 + i * ts * 1.12));
    if (sub) {
      let ss = Math.round(ch * 0.13);
      c.font = `${ss}px -apple-system, sans-serif`;
      while (c.measureText(sub).width > room && ss > ch / 20) { ss -= 2; c.font = `${ss}px -apple-system, sans-serif`; }
      c.fillStyle = dark ? 'rgba(255,255,255,.62)' : '#6f665a';
      c.fillText(sub, pad, ch - ss * 1.5);
    }
  });
  const g = new THREE.Group();
  const body = box(w, h, 0.025, dark ? P.MAT.graphite() : P.MAT.white(), 0, 0, 0.0125);
  body.castShadow = true; g.add(body);
  const face = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: texture, toneMapped: false }));
  face.position.z = 0.027;                          // 2 мм перед лицом корпуса
  g.add(face);
  const shade = new THREE.Mesh(new THREE.PlaneGeometry(w * 1.12, h * 1.3), new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.16, depthWrite: false }));
  shade.position.set(0, -h * 0.06, 0.001); g.add(shade);
  return g;
}

/** лестница: каменные ступени + цельное стеклянное ограждение */
function stairs({ x0, x1, z0, z1, yFrom, yTo, steps = 22, axis = 'z', railSide = 1 }) {
  const g = new THREE.Group();
  const stepMat = stoneMaterial(2);
  const rise = (yTo - yFrom) / steps;
  const w = axis === 'z' ? x1 - x0 : z1 - z0;
  const len = axis === 'z' ? z1 - z0 : x1 - x0;
  const run = len / steps;
  for (let i = 0; i < steps; i++) {
    const st = axis === 'z'
      ? box(w - 0.06, Math.abs(rise) + 0.02, run + 0.02, stepMat, (x0 + x1) / 2, yFrom + rise * (i + 0.5), z1 - run * (i + 0.5))
      : box(run + 0.02, Math.abs(rise) + 0.02, w - 0.06, stepMat, x1 - run * (i + 0.5), yFrom + rise * (i + 0.5), (z0 + z1) / 2);
    st.receiveShadow = true; st.castShadow = true;
    g.add(st);
  }
  // Поручень идёт ПО МАРШУ; знак уклона и длина считаются в office-geom.js,
  // и тот же расчёт проверяет юнит-тест (Б3).
  const pose = railPose({ axis, yFrom, yTo, len });
  const slope = pose.slope;
  const railLen = pose.length;
  const midY = pose.midY;
  const glass = new THREE.Mesh(new THREE.PlaneGeometry(railLen - 0.6, 0.9), appleGlass(0.14));
  const rail = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, railLen, 12), P.MAT.chrome());
  const posts = new THREE.Group();
  const nPosts = Math.max(2, Math.round(len / 1.2));
  if (axis === 'z') {
    const x = railSide > 0 ? x1 : x0;
    glass.position.set(x, midY - 0.45, (z0 + z1) / 2); glass.rotation.y = Math.PI / 2; glass.rotation.x = slope;
    rail.position.set(x, midY, (z0 + z1) / 2); rail.rotation[pose.key] = pose.angle;
    for (let i = 0; i <= nPosts; i++) {
      const t = i / nPosts;
      const z = z1 - len * t, y = yFrom + (yTo - yFrom) * t;
      posts.add(box(0.03, 0.9, 0.03, P.MAT.graphite(), x, y + 0.45, z));
    }
  } else {
    const z = railSide > 0 ? z1 : z0;
    glass.position.set((x0 + x1) / 2, midY - 0.45, z); glass.rotation.z = slope;
    rail.position.set((x0 + x1) / 2, midY, z); rail.rotation[pose.key] = pose.angle;
    for (let i = 0; i <= nPosts; i++) {
      const t = i / nPosts;
      const x = x1 - len * t, y = yFrom + (yTo - yFrom) * t;
      posts.add(box(0.03, 0.9, 0.03, P.MAT.graphite(), x, y + 0.45, z));
    }
  }
  g.add(posts);
  g.add(glass, rail);
  return g;
}

/* ================= машины и мотоциклы ================= */

/** профиль сбоку → корпус: точки [x вдоль длины, y высота], x от кормы к носу */
function carBody(profile, width, color, { glassFrom = 0, glassTo = 0, glassY = 0, metal = false } = {}) {
  const g = new THREE.Group();
  const shape = new THREE.Shape();
  profile.forEach(([x, y], i) => (i ? shape.lineTo(x, y) : shape.moveTo(x, y)));
  shape.closePath();
  const body = new THREE.Mesh(
    new THREE.ExtrudeGeometry(shape, { depth: width, bevelEnabled: true, bevelThickness: 0.06, bevelSize: 0.06, bevelSegments: 3 }),
    new THREE.MeshPhysicalMaterial({ color, roughness: 0.25, metalness: metal ? 0.65 : 0.1, clearcoat: 1, clearcoatRoughness: 0.08 }),
  );
  body.position.z = -width / 2;
  body.castShadow = true;
  g.add(body);
  // хромированные бампера и молдинг по борту: без них силуэт читается клином
  const chrome = P.MAT.chrome();
  const xs = profile.map((p) => p[0]);
  const xMin = Math.min(...xs), xMax = Math.max(...xs);
  for (const [bx, by] of [[xMax - 0.06, 0.52], [xMin + 0.06, 0.5]]) {
    const bumper = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.09, width + 0.06), chrome);
    bumper.position.set(bx, by, 0); g.add(bumper);
  }
  for (const sz of [-1, 1]) {
    const mold = new THREE.Mesh(new THREE.BoxGeometry(xMax - xMin - 0.5, 0.035, 0.025), chrome);
    mold.position.set((xMin + xMax) / 2, 0.62, sz * (width / 2 + 0.01)); g.add(mold);
  }
  // стёкла — тёмная полоса кабины
  if (glassTo > glassFrom) {
    const gl = box(glassTo - glassFrom, 0.32, width + 0.02, new THREE.MeshPhysicalMaterial({ color: 0x1c2a33, roughness: 0.05, metalness: 0.4, transparent: true, opacity: 0.85 }), (glassFrom + glassTo) / 2, glassY, 0);
    g.add(gl);
  }
  return g;
}

/** колесо: покрышка с плечом, диск с ободом, спицы с двух сторон, тормозной диск (К15) */
function wheel(r = 0.33, w = 0.24) {
  const g = new THREE.Group();
  const rubber = new THREE.MeshStandardMaterial({ color: 0x15151a, roughness: 0.92 });
  const tire = new THREE.Mesh(new THREE.CylinderGeometry(r, r, w * 0.72, 28), rubber);
  tire.rotation.x = Math.PI / 2; tire.castShadow = true; g.add(tire);
  // плечи покрышки — иначе колесо читается плоским кружком
  for (const sz of [-1, 1]) {
    const sh = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.94, r * 0.86, w * 0.14, 24), rubber);
    sh.rotation.x = Math.PI / 2; sh.position.z = sz * (w * 0.43); g.add(sh);
  }
  const disc = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.55, r * 0.55, w * 0.3, 20), new THREE.MeshStandardMaterial({ color: 0x6b6b70, roughness: 0.45, metalness: 0.7 }));
  disc.rotation.x = Math.PI / 2; g.add(disc);
  for (const sz of [-1, 1]) {
    const rim = new THREE.Mesh(new THREE.TorusGeometry(r * 0.66, 0.022, 6, 24), P.MAT.chrome());
    rim.position.z = sz * (w / 2 - 0.01); g.add(rim);
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.16, r * 0.16, 0.03, 12), P.MAT.chrome());
    hub.rotation.x = Math.PI / 2; hub.position.z = sz * (w / 2 + 0.005); g.add(hub);
    for (let i = 0; i < 5; i++) {
      const spoke = box(r * 0.56, 0.045, 0.028, P.MAT.brushed());
      const a = (i / 5) * Math.PI * 2 + (sz > 0 ? 0 : 0.3);
      spoke.position.set(Math.cos(a) * r * 0.3, Math.sin(a) * r * 0.3, sz * (w / 2 + 0.004));
      spoke.rotation.z = a;
      g.add(spoke);
    }
  }
  return g;
}

function engineBlock() {
  const g = new THREE.Group();
  g.add(box(0.7, 0.45, 0.6, P.MAT.graphite()));
  for (let i = 0; i < 4; i++) {
    const cyl = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.2, 12), P.MAT.brushed());
    cyl.position.set(-0.24 + i * 0.16, 0.32, 0.1);
    g.add(cyl);
  }
  const head = box(0.66, 0.08, 0.3, P.MAT.chrome(), 0, 0.28, -0.1);
  g.add(head);
  return g;
}

const CARS = {
  gto: {
    name: 'Ferrari 250 GTO', year: '1962', color: 0xc8202a, width: 1.68, wheelR: 0.34, wheelBase: [-1.25, 1.35],
    profile: [[-2.15, 0.25], [-2.15, 0.62], [-1.7, 0.92], [-1.0, 1.18], [-0.35, 1.22], [0.45, 1.05], [0.85, 0.92], [2.05, 0.82], [2.2, 0.52], [2.2, 0.25], [1.7, 0.18], [-1.7, 0.18]],
    glass: { from: -0.9, to: 0.4, y: 1.03 }, lifted: 0.85, wheelsOff: true, hoodOff: true,
  },
  sl300: {
    name: 'Mercedes-Benz 300 SL', year: '1959', color: 0xb8bcc2, metal: true, width: 1.8, wheelR: 0.35, wheelBase: [-1.2, 1.3],
    profile: [[-2.25, 0.3], [-2.25, 0.72], [-1.6, 0.95], [-0.95, 1.05], [-0.7, 1.32], [0.55, 1.34], [0.8, 1.05], [2.1, 0.98], [2.25, 0.55], [2.25, 0.3], [1.8, 0.2], [-1.8, 0.2]],
    glass: { from: -0.7, to: 0.6, y: 1.15 }, gullwing: true, wheelsOff: false, jack: true,
  },
  p918: {
    name: 'Porsche 918 Spyder', year: '2014', color: 0xf3f0ea, width: 1.94, wheelR: 0.36, wheelBase: [-1.35, 1.35],
    profile: [[-2.3, 0.28], [-2.3, 0.7], [-1.8, 0.92], [-1.1, 1.0], [-0.55, 1.15], [0.6, 1.16], [1.0, 0.92], [2.15, 0.72], [2.3, 0.42], [2.3, 0.28], [1.9, 0.17], [-1.9, 0.17]],
    glass: { from: -0.5, to: 0.75, y: 1.0 }, wheelsOff: false, engineOpen: true,
  },
};

export function makeCar(id) {
  const c = CARS[id];
  const g = new THREE.Group();
  const lift = c.lifted || 0;
  const body = carBody(c.profile, c.width, c.color, { ...(c.glass ? { glassFrom: c.glass.from, glassTo: c.glass.to, glassY: c.glass.y } : {}), metal: !!c.metal });
  body.position.y = lift;
  g.add(body);
  // фары и фонари
  for (const s of [-1, 1]) {
    g.add(box(0.06, 0.12, 0.22, new THREE.MeshBasicMaterial({ color: 0xfff4d6 }), c.profile[c.profile.length - 3][0] + 0.02, lift + 0.62, s * (c.width / 2 - 0.25)));
    g.add(box(0.06, 0.1, 0.2, new THREE.MeshBasicMaterial({ color: 0xc8202a }), c.profile[0][0] - 0.02, lift + 0.55, s * (c.width / 2 - 0.25)));
  }
  // колёса: на месте или снятые рядом
  const wheelsOff = c.wheelsOff;
  c.wheelBase.forEach((wx, i) => {
    for (const s of [-1, 1]) {
      if (wheelsOff) {
        const w = wheel(c.wheelR);
        w.rotation.z = Math.PI / 2; w.rotation.y = 0.3 * s;
        w.position.set(wx + (i ? 0.6 : -0.6), c.wheelR * 0.12 + 0.12, s * (c.width / 2 + 0.9));
        w.rotation.x = Math.PI / 2 * 0.9; // лежит
        g.add(w);
      } else if (c.jack && i === 0 && s === -1) {
        const w = wheel(c.wheelR); w.position.set(wx - 0.5, c.wheelR, s * (c.width / 2 + 0.7)); w.rotation.y = 0.5; g.add(w);
        const jack = box(0.3, 0.2, 0.2, P.MAT.terracotta(), wx, 0.1, s * (c.width / 2 - 0.3)); g.add(jack);
      } else {
        const w = wheel(c.wheelR); w.position.set(wx, lift + c.wheelR, s * (c.width / 2 - 0.02)); g.add(w);
      }
    }
  });
  if (wheelsOff) {
    // подъёмник: две стойки и лапы
    for (const s of [-1, 1]) {
      const post = box(0.3, 2.6, 0.3, P.MAT.graphite(), 0, 1.3, s * (c.width / 2 + 0.55)); g.add(post);
      for (const wx of [-1.1, 1.1]) g.add(box(1.0, 0.1, 0.16, P.MAT.brushed(), wx, lift - 0.02, s * (c.width / 2 - 0.2)));
    }
  }
  if (c.hoodOff) {
    // капот снят и стоит у стойки, двигатель открыт
    const eng = engineBlock(); eng.position.set(1.35, lift + 0.55, 0); g.add(eng);
    const hood = box(1.2, 0.04, c.width - 0.2, new THREE.MeshPhysicalMaterial({ color: c.color, roughness: 0.25, clearcoat: 1 }), -3.0, 0.7, 0.4); hood.rotation.z = 1.2; g.add(hood);
  }
  if (c.engineOpen) {
    const eng = engineBlock(); eng.position.set(-1.2, lift + 0.7, 0); g.add(eng);
    const cover = box(1.0, 0.04, c.width - 0.3, new THREE.MeshPhysicalMaterial({ color: c.color, roughness: 0.25, clearcoat: 1 }), -1.4, 1.35, 0); cover.rotation.z = -0.5; g.add(cover);
  }
  if (c.gullwing) {
    for (const s of [-1, 1]) {
      const door = new THREE.Mesh(new RoundedBoxGeometry(1.25, 0.04, 1.0, 2, 0.02), new THREE.MeshPhysicalMaterial({ color: c.color, roughness: 0.25, metalness: 0.65, clearcoat: 1 }));
      door.position.set(0, lift + 1.36 + 0.4, s * 0.62);
      door.rotation.x = -s * 1.15;
      g.add(door);
    }
  }
  g.add(P.makeContactShadow(c.profile[c.profile.length - 3][0] - c.profile[0][0] + 1.2, c.width + 1.4, 0.4));
  g.userData.spec = c;
  return g;
}

const BIKES = {
  r1300gs: { name: 'BMW R 1300 GS', year: '2024', color: 0x2f6bb5, boxer: true, screen: true, tall: true, wheelR: 0.36, frontOff: true },
  vrod: { name: 'Harley-Davidson V-Rod', year: '2010', color: 0x141414, boxer: false, screen: false, tall: false, wheelR: 0.3, frontOff: false },
};

export function makeBike(id) {
  const b = BIKES[id];
  const g = new THREE.Group();
  const paint = new THREE.MeshPhysicalMaterial({ color: b.color, roughness: 0.3, clearcoat: 0.8 });
  const L = b.tall ? 2.2 : 2.45;
  const seatH = b.tall ? 0.85 : 0.68;
  // колёса
  const rear = wheel(b.wheelR, 0.18); rear.position.set(-L / 2 + 0.3, b.wheelR, 0); g.add(rear);
  if (b.frontOff) {
    const front = wheel(b.wheelR, 0.14); front.position.set(L / 2 + 0.4, b.wheelR * 0.5, 0.6); front.rotation.x = 1.3; g.add(front);
    // вилка на стойке
    const stand = box(0.5, 0.2, 0.5, P.MAT.terracotta(), L / 2 - 0.2, 0.1, 0); g.add(stand);
  } else {
    const front = wheel(b.wheelR, 0.14); front.position.set(L / 2 - 0.3, b.wheelR, 0); g.add(front);
  }
  // рама и бак
  const frame = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, L * 0.55, 8), P.MAT.graphite());
  frame.rotation.z = Math.PI / 2 - 0.2; frame.position.set(0, seatH - 0.15, 0); g.add(frame);
  const tank = new THREE.Mesh(new THREE.SphereGeometry(0.28, 16, 12), paint);
  tank.scale.set(1.5, 0.75, 1); tank.position.set(0.2, seatH + 0.05, 0); g.add(tank);
  const seat = rbox(0.8, 0.12, 0.34, new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.9 })); seat.position.set(-0.45, seatH + 0.02, 0); g.add(seat);
  // двигатель
  if (b.boxer) {
    g.add(box(0.5, 0.4, 0.4, P.MAT.graphite(), 0.1, seatH - 0.45, 0));
    for (const s of [-1, 1]) {
      const cyl = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.12, 0.3, 12), P.MAT.brushed());
      cyl.rotation.x = Math.PI / 2; cyl.position.set(0.15, seatH - 0.45, s * 0.38); g.add(cyl);
    }
  } else {
    g.add(box(0.55, 0.45, 0.4, P.MAT.brushed(), 0.05, seatH - 0.4, 0));
    for (const dx of [-0.1, 0.18]) { const cyl = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.28, 12), P.MAT.graphite()); cyl.position.set(dx, seatH - 0.15, 0); cyl.rotation.z = dx < 0 ? 0.5 : -0.3; g.add(cyl); }
  }
  // руль и ветровое стекло
  const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 0.8, 8), P.MAT.brushed());
  bar.rotation.x = Math.PI / 2; bar.position.set(L / 2 - 0.45, seatH + 0.35, 0); g.add(bar);
  const fork = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.8, 8), P.MAT.chrome());
  fork.rotation.z = 0.45; fork.position.set(L / 2 - 0.4, seatH - 0.1, 0); g.add(fork);
  if (b.screen) {
    const scr = new THREE.Mesh(new THREE.PlaneGeometry(0.42, 0.4), new THREE.MeshPhysicalMaterial({ color: 0xdfe9ee, transparent: true, opacity: 0.35, roughness: 0.05 }));
    scr.position.set(L / 2 - 0.4, seatH + 0.62, 0); scr.rotation.y = Math.PI / 2; scr.rotation.x = -0.4; g.add(scr);
    g.add(box(0.3, 0.2, 0.9, paint, L / 2 - 0.55, seatH + 0.15, 0));
  }
  // глушитель и стенд
  const exhaust = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.06, 0.9, 10), P.MAT.chrome());
  exhaust.rotation.z = Math.PI / 2 - 0.1; exhaust.position.set(-0.5, 0.35, 0.25); g.add(exhaust);
  g.add(box(0.6, 0.06, 0.4, P.MAT.terracotta(), -L / 2 + 0.3, 0.03, 0));
  g.add(P.makeContactShadow(L + 0.8, 1.4, 0.4));
  g.userData.spec = b;
  return g;
}

/* ================= рыбы ================= */

function fishGeometry(len = 0.18) {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.SphereGeometry(len * 0.5, 10, 8), new THREE.MeshStandardMaterial({ color: 0xf0b545, roughness: 0.5, metalness: 0.3 }));
  body.scale.set(1, 0.55, 0.35);
  g.add(body);
  const tail = new THREE.Mesh(new THREE.ConeGeometry(len * 0.22, len * 0.4, 3), body.material);
  tail.rotation.z = Math.PI / 2; tail.position.x = -len * 0.6;
  g.add(tail);
  return g;
}

function bigAnimal(kind) {
  const g = new THREE.Group();
  let color = 0x6c7a86, belly = 0xdde4ea, L = 3, H = 0.7;
  if (kind === 'whale') { color = 0x4f5f6e; belly = 0xc9d3da; L = 5.4; H = 1.25; }
  if (kind === 'orca') { color = 0x111214; belly = 0xffffff; L = 3.8; H = 0.95; }
  if (kind === 'shark') { color = 0x7a8a94; belly = 0xe6ecef; L = 2.6; H = 0.6; }
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.45, metalness: 0.05 });
  // корпус: передняя половина — эллипсоид, хвостовая — сужающийся конус (иначе выходит дирижабль)
  const body = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 14), mat);
  body.scale.set(L * 0.3, H / 2, H / 2 * 0.9);
  body.position.x = L * 0.15;
  g.add(body);
  const rear = new THREE.Mesh(new THREE.ConeGeometry(H / 2 * 0.98, L * 0.62, 16), mat);
  rear.rotation.z = Math.PI / 2; rear.position.x = L * 0.15 - L * 0.31; rear.scale.z = 0.9;
  g.add(rear);
  const bellyM = new THREE.Mesh(new THREE.SphereGeometry(0.98, 16, 12), new THREE.MeshStandardMaterial({ color: belly, roughness: 0.5 }));
  bellyM.scale.set(L * 0.28, H / 2 * 0.7, H / 2 * 0.86); bellyM.position.set(L * 0.15, -H * 0.12, 0);
  g.add(bellyM);
  // хвост, спинной плавник, грудные
  const tail = new THREE.Group();
  const fluke = new THREE.Mesh(new THREE.ConeGeometry(H * 0.5, L * 0.18, 3), mat);
  fluke.rotation.z = -Math.PI / 2;              // остриё внутрь корпуса, лопасти наружу
  if (kind === 'shark') fluke.rotation.x = Math.PI / 2;
  fluke.position.x = -L * 0.06;
  fluke.scale.x = 0.35;
  tail.add(fluke);
  tail.position.x = -L * 0.42;
  g.add(tail);
  const dorsal = new THREE.Mesh(new THREE.ConeGeometry(L * 0.06, H * (kind === 'orca' ? 1.1 : 0.6), 3), mat);
  dorsal.position.set(-L * 0.02, H / 2 + (kind === 'orca' ? 0.5 : 0.18), 0);
  dorsal.rotation.y = Math.PI / 2;
  g.add(dorsal);
  for (const s of [-1, 1]) {
    const fin = new THREE.Mesh(new THREE.ConeGeometry(L * 0.05, L * 0.16, 3), mat);
    fin.rotation.z = Math.PI / 2; fin.rotation.x = s * 1.1;
    fin.position.set(L * 0.12, -H * 0.15, s * H * 0.38);
    g.add(fin);
  }
  if (kind === 'orca') {
    for (const s of [-1, 1]) {
      const patch = new THREE.Mesh(new THREE.SphereGeometry(0.16, 10, 8), new THREE.MeshStandardMaterial({ color: 0xffffff }));
      patch.scale.set(1.6, 0.6, 0.5); patch.position.set(L * 0.3, H * 0.22, s * H * 0.42);
      g.add(patch);
    }
  }
  g.userData.tail = tail;
  g.userData.len = L;
  return g;
}

/* ================= крыло: аквариум ================= */

function buildAquarium(scene, ctx) {
  const x0 = -30, x1 = -16.2, z0 = 11.0, z1 = 20.9, y0 = LEVEL, y1 = 6.3;  // z0 вплотную к перегородке лобби: иначе в щель виден сад
  const g = new THREE.Group();
  // задняя и боковые стенки — стекло: сквозь бассейн виден сад за окнами
  const sand = new THREE.Mesh(new THREE.PlaneGeometry(x1 - x0, z1 - z0), new THREE.MeshStandardMaterial({ color: 0x9a9279, roughness: 1 }));
  sand.rotation.x = -Math.PI / 2; sand.position.set((x0 + x1) / 2, y0 + 0.01, (z0 + z1) / 2);
  g.add(sand);
  // каустика — анимированная канва на дне
  const caustic = P.canvasTexture(512, 512, (c) => { c.fillStyle = '#000'; c.fillRect(0, 0, 512, 512); });
  caustic.texture.wrapS = caustic.texture.wrapT = THREE.RepeatWrapping; caustic.texture.repeat.set(4, 3);
  const cmesh = new THREE.Mesh(new THREE.PlaneGeometry(x1 - x0, z1 - z0), new THREE.MeshBasicMaterial({ map: caustic.texture, transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false }));
  cmesh.rotation.x = -Math.PI / 2; cmesh.position.set((x0 + x1) / 2, y0 + 0.02, (z0 + z1) / 2);
  cmesh.renderOrder = 1; g.add(cmesh);
  // камни и водоросли
  for (let i = 0; i < 14; i++) {
    const r = 0.3 + Math.random() * 0.7;
    // валун, а не правильный многогранник: вершины разбросаны шумом (В9)
    const geo = new THREE.IcosahedronGeometry(r, 2);
    const pa = geo.attributes.position;
    for (let v = 0; v < pa.count; v++) {
      const vx = pa.getX(v), vy = pa.getY(v), vz = pa.getZ(v);
      const n = 1 + (Math.sin(vx * 7.3 + i) + Math.cos(vy * 6.1 - i) + Math.sin(vz * 5.7 + i * 2)) * 0.055;
      pa.setXYZ(v, vx * n, vy * n, vz * n);
    }
    geo.computeVertexNormals();
    const rock = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0x4b5a66, roughness: 0.52, metalness: 0.06 }));
    rock.position.set(x0 + 1 + Math.random() * (x1 - x0 - 2), y0 + r * 0.5, z0 + 1 + Math.random() * (z1 - z0 - 2));
    rock.scale.y = 0.6; rock.rotation.y = Math.random() * 3; g.add(rock);
  }
  const kelp = [];
  const KELP_COLORS = [0x2f7a4a, 0x46925a, 0x1f5c3e];
  for (let i = 0; i < 26; i++) {
    const h = 1.5 + Math.random() * 3;
    // лента по кривой, а не прямая палка: изгиб задан контрольными точками
    const bend = (Math.random() - 0.5) * 0.9;
    const curve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(bend * 0.3, h * 0.35, bend * 0.2),
      new THREE.Vector3(bend * 0.8, h * 0.72, bend * 0.5),
      new THREE.Vector3(bend * 1.3, h, bend * 0.9),
    ]);
    const k = new THREE.Mesh(new THREE.TubeGeometry(curve, 10, 0.055, 4, false),
      new THREE.MeshStandardMaterial({ color: KELP_COLORS[i % 3], roughness: 0.78, side: THREE.DoubleSide, transparent: true, opacity: 0.92 }));
    k.scale.set(2.2, 1, 0.5);                      // сплющена в лист
    k.position.set(x0 + 0.8 + Math.random() * (x1 - x0 - 1.6), y0 + 0.02, z0 + 0.6 + Math.random() * (z1 - z0 - 1.2));
    k.rotation.y = Math.random() * Math.PI;
    k.userData.phase = Math.random() * 6;
    g.add(k); kelp.push(k);
  }
  const backGlass = new THREE.Mesh(new THREE.PlaneGeometry(z1 - z0, y1 - y0), appleGlass(0.08));
  backGlass.position.set(x0, (y0 + y1) / 2, (z0 + z1) / 2); backGlass.rotation.y = Math.PI / 2; g.add(backGlass);
  for (const zz of [z0, z1]) {
    const side = new THREE.Mesh(new THREE.PlaneGeometry(x1 - x0, y1 - y0), appleGlass(0.1));
    side.position.set((x0 + x1) / 2, (y0 + y1) / 2, zz); g.add(side);
  }
  // Толща воды: цвет ИДЁТ ПО ГЛУБИНЕ (#1F6F9A у поверхности → #12354E у дна),
  // а не одна ровная заливка. Плюс слои дымки параллельно стеклу: дальняя
  // стенка размывается, рыба на глубине мягче, чем у стекла (В9).
  const depthTex = P.canvasTexture(8, 256, (c, w, h) => {
    const grad = c.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, '#1f6f9a'); grad.addColorStop(0.55, '#17557a'); grad.addColorStop(1, '#12354e');
    c.fillStyle = grad; c.fillRect(0, 0, w, h);
  }).texture;
  const water = new THREE.Mesh(new THREE.BoxGeometry(x1 - x0 - 0.1, y1 - y0 - 0.3, z1 - z0 - 0.1), new THREE.MeshBasicMaterial({ map: depthTex, transparent: true, opacity: 0.46, side: THREE.BackSide, depthWrite: false, toneMapped: false }));
  water.position.set((x0 + x1) / 2, (y0 + y1) / 2 - 0.15, (z0 + z1) / 2);
  water.renderOrder = 5; g.add(water);
  const hazeMat = [];
  for (let i = 1; i <= 9; i++) {
    const hx = x1 - 0.4 - (i / 10) * (x1 - x0 - 0.8);
    const m = new THREE.MeshBasicMaterial({ color: 0x14496c, transparent: true, opacity: 0.085, depthWrite: false, side: THREE.DoubleSide, toneMapped: false });
    const plate = new THREE.Mesh(new THREE.PlaneGeometry(z1 - z0 - 0.1, y1 - y0 - 0.3), m);
    plate.position.set(hx, (y0 + y1) / 2 - 0.15, (z0 + z1) / 2); plate.rotation.y = Math.PI / 2;
    plate.renderOrder = 6; g.add(plate); hazeMat.push(m);
  }
  // пузыри: спрайты всплывают и лопаются у поверхности
  const bubbleTex = P.canvasTexture(64, 64, (c) => {
    const grd = c.createRadialGradient(32, 32, 2, 32, 32, 30);
    grd.addColorStop(0, 'rgba(255,255,255,.9)'); grd.addColorStop(0.6, 'rgba(200,235,255,.35)'); grd.addColorStop(1, 'rgba(200,235,255,0)');
    c.fillStyle = grd; c.beginPath(); c.arc(32, 32, 30, 0, 7); c.fill();
  }).texture;
  const bubbles = [];
  for (let i = 0; i < 26; i++) {
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: bubbleTex, transparent: true, depthWrite: false, opacity: 0.7 }));
    const r = 0.02 + Math.random() * 0.045;
    sp.scale.setScalar(r * 2);
    sp.position.set(x0 + 1 + Math.random() * (x1 - x0 - 2), y0 + Math.random() * (y1 - y0 - 0.6), z0 + 1 + Math.random() * (z1 - z0 - 2));
    sp.renderOrder = 7; g.add(sp);
    bubbles.push({ obj: sp, v: 0.25 + Math.random() * 0.4, r });
  }
  // поверхность воды и крыша над бассейном — сквозь него не должен быть виден сад
  const surface = new THREE.Mesh(new THREE.PlaneGeometry(x1 - x0, z1 - z0), new THREE.MeshPhysicalMaterial({ color: 0x9fd8ff, transparent: true, opacity: 0.55, roughness: 0.05, metalness: 0.1, side: THREE.DoubleSide }));
  surface.rotation.x = -Math.PI / 2; surface.position.set((x0 + x1) / 2, y1 - 0.12, (z0 + z1) / 2); surface.renderOrder = 8; g.add(surface);
  g.add(box(x1 - x0 + 0.4, 0.25, z1 - z0 + 0.4, stoneMaterial(3), (x0 + x1) / 2, y1 + 0.3, (z0 + z1) / 2));
  const lobbyBand = new THREE.Mesh(new THREE.PlaneGeometry(z1 - z0 + 0.4, 9 - y1), stoneMaterial(4));
  lobbyBand.position.set(x1 + 0.1, (y1 + 9) / 2, (z0 + z1) / 2); lobbyBand.rotation.y = Math.PI / 2; g.add(lobbyBand);
  // лучи света сверху
  for (let i = 0; i < 8; i++) {
    const ray = new THREE.Mesh(new THREE.PlaneGeometry(0.8, y1 - y0 - 0.4), new THREE.MeshBasicMaterial({ color: 0x9fd8ff, transparent: true, opacity: 0.07, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
    ray.position.set(x0 + 1.5 + i * 1.6, (y0 + y1) / 2, z0 + 2 + (i % 3) * 2.5);
    ray.rotation.y = 0.3 + i * 0.2; ray.rotation.z = 0.08;
    ray.renderOrder = 7; g.add(ray);
  }
  // стекло со стороны лобби и рама
  const glass = new THREE.Mesh(new THREE.PlaneGeometry(z1 - z0, y1 - y0), new THREE.MeshPhysicalMaterial({ color: 0xcfe6f2, transparent: true, opacity: 0.18, roughness: 0.02, metalness: 0.05, side: THREE.DoubleSide }));
  glass.position.set(x1, (y0 + y1) / 2, (z0 + z1) / 2); glass.rotation.y = Math.PI / 2;
  glass.renderOrder = 9; g.add(glass);
  const frameMat = P.MAT.graphite();
  for (const yy of [y0 + 0.07, y1 - 0.07]) g.add(box(0.12, 0.14, z1 - z0 + 0.2, frameMat, x1 + 0.02, yy, (z0 + z1) / 2));
  const ledA = box(0.03, 0.03, z1 - z0, new THREE.MeshBasicMaterial({ color: 0x9fd8ff, transparent: true, opacity: 0.8 }), x1 + 0.06, y1 + 0.02, (z0 + z1) / 2);
  g.add(ledA); ctx.life.strips.push(ledA);
  // синий свет из аквариума в лобби
  const glow = new THREE.PointLight(0x7fc4ff, 1.6, 12, 1.6); glow.position.set(x1 + 1.5, y0 + 3, (z0 + z1) / 2); g.add(glow);
  // обитатели
  const fauna = [];
  const whale = bigAnimal('whale'); whale.scale.setScalar(0.72); g.add(whale); fauna.push({ obj: whale, cx: -23.2, cz: 16, rx: 4.4, rz: 2.6, y: 4.2, speed: 0.12, phase: 0, kind: 'whale' });
  const orca = bigAnimal('orca'); g.add(orca); fauna.push({ obj: orca, cx: -23.0, cz: 16, rx: 4.8, rz: 3.0, y: 2.9, speed: -0.2, phase: 2.2, kind: 'orca' });
  const shark = bigAnimal('shark'); g.add(shark); fauna.push({ obj: shark, cx: -22.8, cz: 16.1, rx: 4.2, rz: 2.6, y: 2.1, speed: 0.28, phase: 4.1, kind: 'shark' });
  const schools = [];
  const fishGeo = fishGeometry(0.18);
  for (let s = 0; s < 3; s++) {
    const inst = new THREE.Group();
    const members = [];
    for (let i = 0; i < 24; i++) {
      const f = fishGeo.clone();
      f.traverse((m) => { if (m.isMesh) m.material = new THREE.MeshStandardMaterial({ color: [0xf0b545, 0x5ec8ff, 0xf3efe6][s], roughness: 0.5, metalness: 0.3 }); });
      inst.add(f);
      members.push({ obj: f, ox: (Math.random() - 0.5) * 1.6, oy: (Math.random() - 0.5) * 0.8, oz: (Math.random() - 0.5) * 1.2, ph: Math.random() * 6 });
    }
    g.add(inst);
    schools.push({ members, cx: -23 + (s - 1) * 2, cz: 16 + (s - 1) * 1.5, rx: 3.5 + s, rz: 2.4, y: 2.2 + s * 1.1, speed: 0.35 + s * 0.1, phase: s * 2 });
  }
  scene.add(g);
  ctx.pickable(glass, { kind: 'aquarium' });
  ctx.itemAnchors.set('aquarium', { group: g, camPos: [-6.4, LEVEL + 2.2, 16], camTgt: [-17, LEVEL + 2.9, 16], walk: [-9.5, 16], look: [-20, 16] });
  ctx.blockers.push({ x0: x0 - 1, x1: x1 + 0.3, z0: z0 - 1, z1: z1 + 1 });
  return {
    update(dt, t) {
      // каустика: бегущие блики
      const c = caustic.ctx;
      c.fillStyle = 'rgba(0,0,0,.35)'; c.fillRect(0, 0, 512, 512);
      c.strokeStyle = 'rgba(160,220,255,.5)'; c.lineWidth = 2;
      for (let i = 0; i < 18; i++) {
        c.beginPath();
        const y = (i * 29 + t * 22) % 512;
        for (let x = 0; x <= 512; x += 16) c.lineTo(x, y + Math.sin(x * 0.03 + t * 1.7 + i) * 14);
        c.stroke();
      }
      caustic.texture.needsUpdate = true;
      caustic.texture.offset.x += dt * 0.03;                 // каустика ползёт (В9)
      caustic.texture.offset.y += dt * 0.012;
      for (const k of kelp) {
        k.rotation.z = Math.sin(t * 0.7 + k.userData.phase) * 0.12;
        k.rotation.x = Math.cos(t * 0.5 + k.userData.phase) * 0.07;
      }
      for (const b of bubbles) {
        b.obj.position.y += b.v * dt;
        const top = y1 - 0.35;
        if (b.obj.position.y > top) {                        // лопается у поверхности
          b.obj.material.opacity = Math.max(0, b.obj.material.opacity - dt * 4);
          if (b.obj.material.opacity <= 0.01) {
            b.obj.position.set(x0 + 1 + Math.random() * (x1 - x0 - 2), y0 + 0.15, z0 + 1 + Math.random() * (z1 - z0 - 2));
            b.obj.material.opacity = 0.7;
          }
        } else {
          b.obj.position.x += Math.sin(t * 2 + b.v * 9) * dt * 0.05;
        }
      }
      const swim = (o, cx, cz, rx, rz, y, speed, phase, extraY = 0) => {
        const a = t * speed + phase;
        const x = cx + Math.cos(a) * rx, z = cz + Math.sin(a) * rz;
        const dx = -Math.sin(a) * rx * speed, dz = Math.cos(a) * rz * speed;
        o.position.set(x, y + extraY, z);
        o.rotation.y = Math.atan2(dz, dx) === 0 ? 0 : -Math.atan2(dz, dx); // корпус вдоль +x
        o.rotation.z = Math.sin(t * 1.1 + phase) * 0.04;
      };
      for (const f of fauna) {
        swim(f.obj, f.cx, f.cz, f.rx, f.rz, f.y, f.speed, f.phase, Math.sin(t * 0.3 + f.phase) * 0.35);
        if (f.obj.userData.tail) f.obj.userData.tail.rotation.y = Math.sin(t * (f.kind === 'shark' ? 3 : 1.6) + f.phase) * 0.35;
      }
      for (const s of schools) {
        const a = t * s.speed + s.phase;
        const cx = s.cx + Math.cos(a) * s.rx, cz = s.cz + Math.sin(a) * s.rz;
        const dx = -Math.sin(a), dz = Math.cos(a);
        const yaw = -Math.atan2(dz, dx);
        for (const m of s.members) {
          m.obj.position.set(cx + m.ox + Math.sin(t * 2 + m.ph) * 0.08, s.y + m.oy + Math.sin(t * 1.3 + m.ph) * 0.1, cz + m.oz);
          m.obj.rotation.y = yaw + Math.sin(t * 5 + m.ph) * 0.15;
        }
      }
    },
  };
}

/* ================= крыло: переговорная + библиотека ================= */

function buildMeetingAndLibrary(scene, ctx) {
  const [x0, x1, z0, z1] = [16.2, 25.6, 11.2, 20.8];
  const g = new THREE.Group();
  const stone = stoneMaterial(4);
  const floor1 = new THREE.Mesh(new THREE.PlaneGeometry(x1 - x0, z1 - z0), stoneMaterial(5));
  floor1.rotation.x = -Math.PI / 2; floor1.position.set((x0 + x1) / 2, LEVEL + 0.002, (z0 + z1) / 2); floor1.receiveShadow = true; g.add(floor1);
  g.add(box(0.2, 9, z1 - z0, stone, x1, 4.5, (z0 + z1) / 2));
  g.add(box(x1 - x0, 9, 0.2, stone, (x0 + x1) / 2, 4.5, z1));
  g.add(box(x1 - x0, 9, 0.2, stone, (x0 + x1) / 2, 4.5, z0));
  const roof = new THREE.Mesh(new THREE.PlaneGeometry(x1 - x0, z1 - z0), new THREE.MeshStandardMaterial({ color: 0xe4dfd5, roughness: 0.9 }));
  roof.rotation.x = Math.PI / 2; roof.position.set((x0 + x1) / 2, 9, (z0 + z1) / 2); g.add(roof);

  /* ---- первый этаж: переговорная на 12 (лестницы внутри больше нет) ---- */
  for (const [za, zb] of [[z0, 13.0], [15.2, z1]]) {
    const pane = new THREE.Mesh(new THREE.PlaneGeometry(zb - za, FLOOR2 - LEVEL - 0.3), appleGlass(0.12));
    pane.position.set(x0, LEVEL + (FLOOR2 - LEVEL - 0.3) / 2, (za + zb) / 2); pane.rotation.y = Math.PI / 2; g.add(pane);
  }
  g.add(box(0.12, 0.1, z1 - z0, P.MAT.graphite(), x0, FLOOR2 - 0.3, (z0 + z1) / 2));
  const table = rbox(6.0, 0.08, 1.6, new THREE.MeshPhysicalMaterial({ color: 0xd9c9a8, roughness: 0.35, clearcoat: 0.4 }), 0.03);
  table.position.set(21, LEVEL + 0.75, 16.3); table.castShadow = true; g.add(table);
  for (const dx of [-2.2, 2.2]) g.add(box(0.1, 0.72, 1.2, P.MAT.graphite(), 21 + dx, LEVEL + 0.36, 16.3));
  const tableShadow = P.makeContactShadow(7, 3, 0.35); tableShadow.position.set(21, LEVEL + 0.006, 16.3); g.add(tableShadow);
  // поворот кресла = поворот человека: спинка в +z, лицо в −z
  const seats = [];
  for (let i = 0; i < 5; i++) { seats.push([18.7 + i * 1.15, 15.2, Math.PI]); seats.push([18.7 + i * 1.15, 17.4, 0]); }
  seats.push([17.7, 16.3, -Math.PI / 2]); seats.push([24.3, 16.3, Math.PI / 2]);
  const looks = [{ hair: 0x2a1f18, skin: 0xe3b78f }, { hair: 0xb99867, skin: 0xf2d4b3, female: true }, { hair: 0x4a4a4a, skin: 0xc98e62, glasses: true }];
  seats.forEach(([sx, sz, ry], i) => {
    const ch = P.makeChair(); ch.position.set(sx, LEVEL, sz); ch.rotation.y = ry; g.add(ch);
    if (i < 3) {
      const person = P.makePerson({ ...looks[i], polo: ctx.brand.poloHex || 0xb95740 });
      person.group.position.set(sx, LEVEL, sz); person.group.rotation.y = ry; g.add(person.group);
      ctx.life.addAgent(`meeting${i}`, person, {});
      const fx = -Math.sin(ry), fz = -Math.cos(ry);
      const laptop = box(0.3, 0.015, 0.22, P.MAT.brushed(), sx + fx * 0.55, LEVEL + 0.8, sz + fz * 0.55); laptop.rotation.y = ry; g.add(laptop);
      const lid = box(0.3, 0.2, 0.01, P.MAT.brushed(), sx + fx * 0.66, LEVEL + 0.9, sz + fz * 0.66); lid.rotation.y = ry; lid.rotation.x = -0.3; g.add(lid);
    }
  });
  const tv = P.canvasTexture(1024, 576, (c) => {
    c.fillStyle = '#0f0f10'; c.fillRect(0, 0, 1024, 576);
    c.fillStyle = '#fff'; c.font = '600 54px Georgia, serif'; c.textBaseline = 'top'; c.fillText('Переговорная · 12 мест', 48, 44);
    c.fillStyle = 'rgba(255,255,255,.6)'; c.font = '30px -apple-system, sans-serif';
    ['1. Посадка АВИВАК-2: вариант 3.1', '2. Нормоконтроль раздела АР', '3. Комплект для ГГЭ', '4. Сроки актов АОСР'].forEach((l, i) => c.fillText(l, 48, 150 + i * 62));
    c.fillStyle = '#b95740'; c.fillRect(48, 128, 6, 260);
  });
  const tvMesh = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 1.46), new THREE.MeshBasicMaterial({ map: tv.texture, toneMapped: false }));
  // полотно ПЕРЕД корпусом: при x1−0.12 оно оказывалось внутри графитовой плиты
  tvMesh.position.set(x1 - 0.155, LEVEL + 2.0, 16.3); tvMesh.rotation.y = -Math.PI / 2; g.add(tvMesh);
  g.add(box(0.06, 1.6, 2.75, P.MAT.graphite(), x1 - 0.1, LEVEL + 2.0, 16.3));
  const pl = P.makeMonstera(1.0); pl.position.set(x1 - 0.9, LEVEL, z1 - 0.9); g.add(pl); ctx.life.plants.push(pl);
  const l1 = new THREE.PointLight(0xfff0dd, 1.2, 9, 1.8); l1.position.set(21, LEVEL + 3.6, 16.3); g.add(l1);
  const mLabel = label('Переговорная', '12 мест · экран повестки', 1.2); mLabel.position.set(x0 + 0.05, LEVEL + 2.6, 12.2); mLabel.rotation.y = -Math.PI / 2; g.add(mLabel);

  /* ---- второй этаж: библиотека нормативов (отдельная комната) ---- */
  const slab = rbox(x1 - x0, 0.24, z1 - z0, new THREE.MeshStandardMaterial({ color: 0xece6da, roughness: 0.6 }), 0.02);
  slab.position.set((x0 + x1) / 2, FLOOR2 - 0.12, (z0 + z1) / 2); g.add(slab);
  const libTex = P.woodTexture(); libTex.repeat.set(3, 3);
  const libFloor = new THREE.Mesh(new THREE.PlaneGeometry(x1 - x0, z1 - z0), new THREE.MeshStandardMaterial({ map: libTex, bumpMap: libTex, bumpScale: 0.005, roughness: 0.35 }));
  libFloor.rotation.x = -Math.PI / 2; libFloor.position.set((x0 + x1) / 2, FLOOR2 + 0.004, (z0 + z1) / 2); libFloor.receiveShadow = true; g.add(libFloor);
  // стеклянная стена библиотеки к переходу, проём двери 13.0…15.2
  for (const [za, zb] of [[z0, 13.0], [15.2, z1]]) {
    const pane = new THREE.Mesh(new THREE.PlaneGeometry(zb - za, 3.4), appleGlass(0.12));
    pane.position.set(x0, FLOOR2 + 1.7, (za + zb) / 2); pane.rotation.y = Math.PI / 2; g.add(pane);
  }

  const shelves = [];
  const spineGroup = new THREE.Group();
  g.add(spineGroup);
  const mkShelf = (cx, cz, ry, w) => {
    const sh = new THREE.Group();
    sh.add(box(w, 2.3, 0.05, P.MAT.walnut(), 0, 1.15, -0.19));
    for (const sx of [-w / 2 + 0.03, w / 2 - 0.03]) sh.add(box(0.06, 2.3, 0.42, P.MAT.walnut(), sx, 1.15, 0));
    for (let r = 0; r < 5; r++) sh.add(box(w - 0.06, 0.035, 0.4, new THREE.MeshStandardMaterial({ color: 0xb08d63, roughness: 0.7 }), 0, 0.3 + r * 0.5, 0));
    sh.position.set(cx, FLOOR2, cz); sh.rotation.y = ry;
    g.add(sh);
    shelves.push({ cx, cz, ry, w });
  };
  mkShelf(x1 - 0.22, 14.6, -Math.PI / 2, 3.2);
  mkShelf(x1 - 0.22, 18.6, -Math.PI / 2, 3.2);
  mkShelf(21.4, z1 - 0.22, Math.PI, 3.6);

  for (const [tx, tz] of [[19.4, 14.4], [19.4, 18.4]]) {
    const t = new THREE.Mesh(new THREE.CylinderGeometry(0.72, 0.72, 0.05, 28), new THREE.MeshPhysicalMaterial({ color: 0xd9c9a8, roughness: 0.35, clearcoat: 0.4 }));
    t.position.set(tx, FLOOR2 + 0.74, tz); g.add(t);
    g.add(box(0.08, 0.72, 0.08, P.MAT.graphite(), tx, FLOOR2 + 0.36, tz));
    const shade = new THREE.Mesh(new THREE.ConeGeometry(0.14, 0.16, 16, 1, true), new THREE.MeshStandardMaterial({ color: 0x2f5f3a, side: THREE.DoubleSide }));
    shade.position.set(tx + 0.4, FLOOR2 + 1.3, tz); g.add(shade);
    g.add(box(0.02, 0.5, 0.02, P.MAT.brushed(), tx + 0.4, FLOOR2 + 1.05, tz));
    const lamp = new THREE.PointLight(0xffe4b8, 0.9, 3.5, 2); lamp.position.set(tx + 0.4, FLOOR2 + 1.2, tz); g.add(lamp);
    for (const a of [0.8, 2.4]) { const ch = P.makeChair(); ch.position.set(tx + Math.cos(a) * 1.05, FLOOR2, tz + Math.sin(a) * 1.05); ch.rotation.y = -a - Math.PI / 2; g.add(ch); }
    const shadow = P.makeContactShadow(2.8, 2.8, 0.3); shadow.position.set(tx, FLOOR2 + 0.006, tz); g.add(shadow);
  }
  const reader = P.makePerson({ hair: 0x8a3b2a, skin: 0xf0cdaa, female: true, polo: ctx.brand.poloHex || 0xb95740 });
  reader.group.position.set(19.4 + Math.cos(0.8) * 1.05, FLOOR2, 14.4 + Math.sin(0.8) * 1.05);
  reader.group.rotation.y = -0.8 - Math.PI / 2;
  g.add(reader.group); ctx.life.addAgent('reader', reader, {});
  const libLabel = label('Библиотека нормативов', 'корешок = документ базы знаний', 1.5);
  libLabel.position.set(x0 + 0.05, FLOOR2 + 2.5, 14.1); libLabel.rotation.y = -Math.PI / 2; g.add(libLabel);
  const l2 = new THREE.PointLight(0xfff0dd, 1.1, 12, 1.8); l2.position.set(21, FLOOR2 + 2.6, 16); g.add(l2);

  scene.add(g);
  ctx.pickable(table, { kind: 'room', id: 'meeting' });
  ctx.itemAnchors.set('meeting', { group: g, camPos: [14.4, LEVEL + 2.2, 17.4], camTgt: [22.5, LEVEL + 0.9, 16.2], walk: [17.6, 14.1], look: [21, 16.3] });
  ctx.itemAnchors.set('library', { group: g, camPos: [17.0, FLOOR2 + 1.7, 16.2], camTgt: [24.5, FLOOR2 + 1.2, 16.2], walk: [17.4, 14.1], look: [24, 16.2], floorY: FLOOR2 });
  ctx.blockers.push({ x0: 17.9, x1: 24.1, z0: 15.4, z1: 17.2, below: 3 });
  ctx.blockers.push({ x0: x1 - 0.7, x1, z0, z1, above: 3 });
  ctx.blockers.push({ x0, x1, z0: z1 - 0.7, z1, above: 3 });
  ctx.blockers.push({ x0, x1, z0, z1: z0 + 0.7, above: 3 });
  ctx.blockers.push({ x: 19.4, z: 14.4, r: 1.5, above: 3 });
  ctx.blockers.push({ x: 19.4, z: 18.4, r: 1.5, above: 3 });

  /** корешки — НАСТОЯЩИЕ документы базы знаний (/api/office/kb-docs) */
  function setBooks(docs) {
    spineGroup.clear();
    if (!docs || !docs.length) return;
    const palette = [0xb95740, 0x26211b, 0x4a6b8a, 0x4f7d58, 0xb07e36, 0x7a5aa8, 0xa93e2c, 0x5a3f2c];
    // книги раскладываются равномерно по полкам; остаток полки занимают архивные
    // короба — они не притворяются нормативами, книга здесь всегда документ базы
    const rows = shelves.length * 4;
    const perRow = Math.ceil(docs.length / rows);
    const boxMat = new THREE.MeshStandardMaterial({ color: 0xcfc4ad, roughness: 0.95 });
    let di = 0;
    for (const sh of shelves) {
      for (let r = 0; r < 4; r++) {
        const stop = Math.min(docs.length, di + perRow);
        let off = -sh.w / 2 + 0.12;
        while (off < sh.w / 2 - 0.2 && di < stop) {
          const doc = docs[di];
          // толщина корешка — по числу фрагментов документа в базе
          const wdt = Math.max(0.055, Math.min(0.13, 0.05 + doc.chunks / 700));
          const hgt = 0.3 + Math.min(0.12, doc.chunks / 1200);
          const color = palette[di % palette.length];
          const spine = new THREE.Group();
          spine.add(box(wdt, hgt, 0.36, new THREE.MeshStandardMaterial({ color, roughness: 0.8 })));
          const { texture } = P.canvasTexture(512, 64, (c) => {
            c.fillStyle = `#${color.toString(16).padStart(6, '0')}`; c.fillRect(0, 0, 512, 64);
            c.fillStyle = 'rgba(255,255,255,.94)'; c.font = '600 34px -apple-system, sans-serif'; c.textBaseline = 'middle';
            let name = doc.name;
            if (c.measureText(name).width > 470) { while (name.length > 4 && c.measureText(name + '…').width > 470) name = name.slice(0, -1); name += '…'; }
            c.fillText(name, 14, 34);
          });
          const face = new THREE.Mesh(new THREE.PlaneGeometry(hgt * 0.94, wdt * 0.92), new THREE.MeshBasicMaterial({ map: texture, toneMapped: false }));
          face.position.z = 0.181; face.rotation.z = Math.PI / 2;
          spine.add(face);
          const local = new THREE.Vector3(off + wdt / 2, 0.3 + r * 0.5 + hgt / 2 + 0.02, 0.02);
          local.applyAxisAngle(new THREE.Vector3(0, 1, 0), sh.ry).add(new THREE.Vector3(sh.cx, FLOOR2, sh.cz));
          spine.position.copy(local);
          spine.rotation.y = sh.ry;
          spine.userData.pick = { kind: 'book', name: doc.name, chunks: doc.chunks, bases: doc.bases };
          spine.traverse((m) => { m.userData.pick = spine.userData.pick; });
          spineGroup.add(spine);
          ctx.pickables.push(spine);
          off += wdt + 0.012;
          di += 1;
        }
        // хвост полки — короба
        while (off < sh.w / 2 - 0.24) {
          const bw = 0.22 + Math.random() * 0.1;
          const bx = new THREE.Mesh(new THREE.BoxGeometry(bw, 0.3, 0.34), boxMat);
          const lp = new THREE.Vector3(off + bw / 2, 0.3 + r * 0.5 + 0.17, 0.0);
          lp.applyAxisAngle(new THREE.Vector3(0, 1, 0), sh.ry).add(new THREE.Vector3(sh.cx, FLOOR2, sh.cz));
          bx.position.copy(lp); bx.rotation.y = sh.ry;
          spineGroup.add(bx);
          off += bw + 0.02;
        }
      }
    }
  }

  return { update() {}, setBooks };
}

/* ================= крыло: гараж ================= */

function buildGarage(scene, ctx) {
  const [x0, x1, z0, z1] = [16.2, 34, -11.2, 8];
  const g = new THREE.Group();
  const floorTex = P.canvasTexture(1024, 1024, (c) => {
    c.fillStyle = '#2b2b30'; c.fillRect(0, 0, 1024, 1024);
    c.strokeStyle = 'rgba(255,255,255,.07)'; c.lineWidth = 3;
    for (let i = 0; i <= 8; i++) { c.beginPath(); c.moveTo(i * 128, 0); c.lineTo(i * 128, 1024); c.stroke(); c.beginPath(); c.moveTo(0, i * 128); c.lineTo(1024, i * 128); c.stroke(); }
    c.fillStyle = 'rgba(185,87,64,.5)'; c.fillRect(0, 500, 1024, 24);
  });
  floorTex.texture.wrapS = floorTex.texture.wrapT = THREE.RepeatWrapping; floorTex.texture.repeat.set(4, 4);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(x1 - x0, z1 - z0), new THREE.MeshStandardMaterial({ map: floorTex.texture, roughness: 0.28, metalness: 0.1 }));
  floor.rotation.x = -Math.PI / 2; floor.position.set((x0 + x1) / 2, LEVEL + 0.002, (z0 + z1) / 2); floor.receiveShadow = true; g.add(floor);
  const wallMat = new THREE.MeshStandardMaterial({ color: 0x3a3a3f, roughness: 0.9 });
  g.add(box(0.2, 7, z1 - z0, wallMat, x1, LEVEL + 3.5, (z0 + z1) / 2));
  g.add(box(x1 - x0, 7, 0.2, wallMat, (x0 + x1) / 2, LEVEL + 3.5, z0));
  g.add(box(x1 - x0, 7, 0.2, wallMat, (x0 + x1) / 2, LEVEL + 3.5, z1));
  const roof = new THREE.Mesh(new THREE.PlaneGeometry(x1 - x0, z1 - z0), new THREE.MeshStandardMaterial({ color: 0x1f1f23, roughness: 0.9 }));
  roof.rotation.x = Math.PI / 2; roof.position.set((x0 + x1) / 2, LEVEL + 4.6, (z0 + z1) / 2); g.add(roof);
  // световые линии на потолке и лампы
  for (let i = 0; i < 4; i++) {
    const strip = new THREE.Mesh(new THREE.PlaneGeometry(0.2, z1 - z0 - 2), new THREE.MeshBasicMaterial({ color: 0xfff6e8 }));
    strip.rotation.x = Math.PI / 2; strip.position.set(x0 + 3 + i * 4, LEVEL + 4.58, (z0 + z1) / 2); g.add(strip);
    const l = new THREE.PointLight(0xfff0dd, 1.8, 14, 1.5); l.position.set(x0 + 3 + i * 4, LEVEL + 4.2, (z0 + z1) / 2); g.add(l);
  }
  // Акцентный свет на каждую машину: общего потолочного не хватало —
  // интерьер выходил ровно-серым, и кузова читались плоскими пятнами (К15).
  for (const [sx, sz] of [[21.5, -6.2], [28.5, -5.0], [21.5, 3.2], [28.6, 2.0], [31.0, 5.2]]) {
    const spot = new THREE.SpotLight(0xfff4e2, 3.0, 13, 0.75, 0.72, 1.5);
    spot.position.set(sx + 1.2, LEVEL + 4.3, sz - 0.8);
    spot.target.position.set(sx, LEVEL + 0.5, sz);
    g.add(spot); g.add(spot.target);
    const can = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.14, 0.2, 12), P.MAT.graphite());
    can.position.set(sx + 1.2, LEVEL + 4.42, sz - 0.8); g.add(can);
  }
  // холодная подсветка стен: отделяет кузов от фона
  for (const zz of [z0 + 3, (z0 + z1) / 2, z1 - 3]) {
    const rim = new THREE.PointLight(0x7fa8c8, 0.7, 9, 2);
    rim.position.set(x1 - 0.8, LEVEL + 2.6, zz); g.add(rim);
  }
  // машины
  const gto = makeCar('gto'); gto.position.set(21.5, LEVEL, -6.2); gto.rotation.y = 0.25; g.add(gto);
  const sl = makeCar('sl300'); sl.position.set(28.5, LEVEL, -5.0); sl.rotation.y = -0.4; g.add(sl);
  const p918 = makeCar('p918'); p918.position.set(21.5, LEVEL, 3.2); p918.rotation.y = Math.PI - 0.2; g.add(p918);
  const gs = makeBike('r1300gs'); gs.position.set(28.6, LEVEL, 2.0); gs.rotation.y = Math.PI / 2 + 0.3; g.add(gs);
  const vrod = makeBike('vrod'); vrod.position.set(31.0, LEVEL, 5.2); vrod.rotation.y = Math.PI / 2 - 0.5; g.add(vrod);
  for (const [obj, id, lx, lz] of [[gto, 'gto', 21.5, -8.9], [sl, 'sl300', 28.5, -8.6], [p918, 'p918', 21.5, 6.6], [gs, 'r1300gs', 27.2, 5.2], [vrod, 'vrod', 32.4, 7.3]]) {
    ctx.pickable(obj, { kind: 'vehicle', id });
    const spec = obj.userData.spec;
    const lb = label(spec.name, spec.year, 1.2, true); lb.position.set(lx, LEVEL + 0.9, lz); lb.rotation.y = lz > 0 ? Math.PI : 0; g.add(lb);
    g.add(box(0.05, 0.9, 0.05, P.MAT.graphite(), lx, LEVEL + 0.45, lz));
  }
  // верстак, инструментальные шкафы, стеллаж с шинами
  g.add(box(3.0, 0.06, 0.8, P.MAT.brushed(), x1 - 1.6, LEVEL + 0.9, -1.5));
  for (const dx of [-1.3, 1.3]) g.add(box(0.08, 0.88, 0.7, P.MAT.graphite(), x1 - 1.6 + dx, LEVEL + 0.44, -1.5));
  for (let i = 0; i < 3; i++) {
    const cab = rbox(0.9, 1.1, 0.5, new THREE.MeshPhysicalMaterial({ color: 0xa93e2c, roughness: 0.3, clearcoat: 0.6 }), 0.02);
    cab.position.set(x1 - 1.6 + (i - 1) * 1.0, LEVEL + 0.55, 0.8); g.add(cab);
    for (let d = 0; d < 4; d++) g.add(box(0.7, 0.02, 0.04, P.MAT.chrome(), x1 - 1.6 + (i - 1) * 1.0, LEVEL + 0.2 + d * 0.25, 0.55));
  }
  const rack = new THREE.Group();
  for (let r = 0; r < 3; r++) {
    rack.add(box(2.4, 0.04, 0.6, P.MAT.brushed(), 0, 0.4 + r * 0.9, 0));
    for (let i = 0; i < 3; i++) { const w = wheel(0.33, 0.24); w.position.set(-0.8 + i * 0.8, 0.77 + r * 0.9, 0); w.rotation.y = Math.PI / 2; rack.add(w); }
  }
  for (const dx of [-1.2, 1.2]) rack.add(box(0.06, 2.8, 0.06, P.MAT.graphite(), dx, 1.4, -0.25));
  rack.position.set(x0 + 1.4, LEVEL, z1 - 0.6); g.add(rack);
  // стена инструментов и надпись
  const tools = P.canvasTexture(1024, 512, (c) => {
    c.fillStyle = '#2a2a2f'; c.fillRect(0, 0, 1024, 512);
    c.strokeStyle = 'rgba(255,255,255,.15)'; for (let x = 0; x < 1024; x += 32) for (let y = 0; y < 512; y += 32) { c.beginPath(); c.arc(x + 16, y + 16, 3, 0, 7); c.stroke(); }
    c.strokeStyle = '#d8d8dc'; c.lineWidth = 8; c.lineCap = 'round';
    for (let i = 0; i < 14; i++) { const x = 60 + i * 68; c.beginPath(); c.moveTo(x, 90); c.lineTo(x, 90 + 120 + (i % 3) * 60); c.stroke(); c.beginPath(); c.arc(x, 80, 14 + (i % 2) * 6, 0, 7); c.stroke(); }
    c.fillStyle = '#b95740'; c.font = '600 60px Georgia, serif'; c.fillText('ENSO · МАСТЕРСКАЯ', 60, 430);
  });
  const toolWall = new THREE.Mesh(new THREE.PlaneGeometry(6, 3), new THREE.MeshBasicMaterial({ map: tools.texture, toneMapped: false }));
  toolWall.position.set(x1 - 0.12, LEVEL + 2.4, -6.0); toolWall.rotation.y = -Math.PI / 2; g.add(toolWall);
  // стойка с двигателем на подставке
  const eng = engineBlock(); eng.position.set(x0 + 3.2, LEVEL + 1.0, -9.4); g.add(eng);
  g.add(box(0.8, 0.8, 0.8, P.MAT.graphite(), x0 + 3.2, LEVEL + 0.4, -9.4));
  scene.add(g);
  ctx.itemAnchors.set('garage', { group: g, camPos: [18.0, LEVEL + 2.4, 6.8], camTgt: [27, LEVEL + 0.9, -3.0], walk: [18.2, 0.2], look: [26, -3.5] });
  for (const [cx, cz, w, d] of [[21.5, -6.2, 6.4, 4.6], [28.5, -5.0, 5.4, 4.2], [21.5, 3.2, 6.2, 4.4], [28.6, 2.0, 2.6, 1.6], [31.0, 5.2, 2.8, 1.6], [x1 - 1.6, -1.5, 3.2, 1.2], [x1 - 1.6, 0.8, 3.2, 0.9], [x0 + 1.4, z1 - 0.6, 2.8, 1.0], [x0 + 3.2, -9.4, 1.2, 1.2]]) {
    ctx.blockers.push({ x0: cx - w / 2, x1: cx + w / 2, z0: cz - d / 2, z1: cz + d / 2 });
  }
  return { update() {} };
}

/* ================= крыло: зал-макет реактора ================= */

function drawNppPoster(c, w, h, kind) {
  const sky = c.createLinearGradient(0, 0, 0, h);
  if (kind === 'night') { sky.addColorStop(0, '#0a1626'); sky.addColorStop(1, '#22405c'); }
  else { sky.addColorStop(0, '#8fb8d8'); sky.addColorStop(1, '#dfe9ef'); }
  c.fillStyle = sky; c.fillRect(0, 0, w, h);
  const ground = h * 0.78;
  const tower = (x, tw, th) => {
    c.beginPath();
    c.moveTo(x - tw, ground);
    c.quadraticCurveTo(x - tw * 0.42, ground - th * 0.62, x - tw * 0.55, ground - th);
    c.lineTo(x + tw * 0.55, ground - th);
    c.quadraticCurveTo(x + tw * 0.42, ground - th * 0.62, x + tw, ground);
    c.closePath();
    const gr = c.createLinearGradient(x - tw, 0, x + tw, 0);
    gr.addColorStop(0, kind === 'night' ? '#2c3d4f' : '#b9c3ca');
    gr.addColorStop(0.5, kind === 'night' ? '#44586c' : '#e6ecef');
    gr.addColorStop(1, kind === 'night' ? '#22303e' : '#98a5ad');
    c.fillStyle = gr; c.fill();
    c.fillStyle = kind === 'night' ? 'rgba(180,210,235,.3)' : 'rgba(255,255,255,.75)';
    for (let i = 0; i < 8; i++) { c.beginPath(); c.arc(x + (Math.random() - 0.5) * tw, ground - th - 20 - i * 26, 26 + i * 9, 0, Math.PI * 2); c.fill(); }
  };
  if (kind === 'domes') {
    for (const [x, r] of [[w * 0.32, w * 0.11], [w * 0.6, w * 0.09]]) {
      c.fillStyle = '#cfd8dd'; c.beginPath(); c.arc(x, ground - r * 0.9, r, Math.PI, 0); c.fill();
      c.fillRect(x - r, ground - r * 0.9, r * 2, r * 0.9);
      c.strokeStyle = 'rgba(60,80,95,.5)'; c.lineWidth = 3; c.stroke();
    }
    tower(w * 0.82, w * 0.09, h * 0.4);
  } else {
    tower(w * 0.3, w * 0.13, h * 0.52);
    tower(w * 0.62, w * 0.1, h * 0.4);
    c.fillStyle = kind === 'night' ? '#1b2c3c' : '#a8b4bb';
    c.fillRect(w * 0.05, ground - h * 0.16, w * 0.18, h * 0.16);
  }
  c.fillStyle = kind === 'night' ? '#0d1a12' : '#4f7d58';
  c.fillRect(0, ground, w, h - ground);
  if (kind === 'night') { c.fillStyle = 'rgba(255,220,150,.8)'; for (let i = 0; i < 40; i++) c.fillRect(Math.random() * w, ground - Math.random() * 30, 3, 4); }
  c.strokeStyle = 'rgba(0,0,0,.25)'; c.lineWidth = 8; c.strokeRect(4, 4, w - 8, h - 8);
}

/**
 * Зал реактора занимает уровни 1 и −1: со стороны зала входишь на смотровой
 * балкон и смотришь на ядро СВЕРХУ, потом спускаешься по лестнице к пульту
 * и картинам. Крыша ниже низа окон второго этажа — вид на природу не закрыт.
 */
function buildReactor(scene, ctx) {
  const [x0, x1, z0, z1] = [-34, -16.2, -11.2, 8];
  const g = new THREE.Group();
  const cx = -27.0, cz = -1.6;
  const CEIL = LEVEL + 3.9;
  const wallMat = new THREE.MeshStandardMaterial({ color: 0x14161a, roughness: 0.95 });
  const floorTex = P.canvasTexture(512, 512, (c) => {
    c.fillStyle = '#1b1e24'; c.fillRect(0, 0, 512, 512);
    c.strokeStyle = 'rgba(120,190,255,.18)'; c.lineWidth = 2;
    for (let i = 0; i <= 8; i++) { c.beginPath(); c.moveTo(i * 64, 0); c.lineTo(i * 64, 512); c.stroke(); c.beginPath(); c.moveTo(0, i * 64); c.lineTo(512, i * 64); c.stroke(); }
  });
  floorTex.texture.wrapS = floorTex.texture.wrapT = THREE.RepeatWrapping; floorTex.texture.repeat.set(6, 6);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(x1 - x0, z1 - z0), new THREE.MeshStandardMaterial({ map: floorTex.texture, roughness: 0.4, metalness: 0.3 }));
  floor.rotation.x = -Math.PI / 2; floor.position.set((x0 + x1) / 2, PIT + 0.002, (z0 + z1) / 2); g.add(floor);
  g.add(box(0.2, CEIL - PIT, z1 - z0, wallMat, x0, (PIT + CEIL) / 2, (z0 + z1) / 2));
  g.add(box(x1 - x0, CEIL - PIT, 0.2, wallMat, (x0 + x1) / 2, (PIT + CEIL) / 2, z0));
  g.add(box(x1 - x0, CEIL - PIT, 0.2, wallMat, (x0 + x1) / 2, (PIT + CEIL) / 2, z1));
  const roof = new THREE.Mesh(new THREE.PlaneGeometry(x1 - x0, z1 - z0), wallMat);
  roof.rotation.x = Math.PI / 2; roof.position.set((x0 + x1) / 2, CEIL, (z0 + z1) / 2); g.add(roof);
  const lawn = P.canvasTexture(512, 512, (c) => {
    c.fillStyle = '#5f9b62'; c.fillRect(0, 0, 512, 512);
    for (let i = 0; i < 2600; i++) { c.fillStyle = `hsl(${100 + Math.random() * 25}, ${30 + Math.random() * 20}%, ${28 + Math.random() * 22}%)`; c.fillRect(Math.random() * 512, Math.random() * 512, 3, 6); }
  });
  lawn.texture.wrapS = lawn.texture.wrapT = THREE.RepeatWrapping; lawn.texture.repeat.set(8, 8);
  const roofTop = new THREE.Mesh(new THREE.PlaneGeometry(x1 - x0, z1 - z0), new THREE.MeshStandardMaterial({ map: lawn.texture, roughness: 1 }));
  roofTop.rotation.x = -Math.PI / 2; roofTop.position.set((x0 + x1) / 2, CEIL + 0.06, (z0 + z1) / 2); g.add(roofTop);
  for (let i = 0; i < 16; i++) {
    const r = 0.5 + Math.random() * 0.9;
    const bush = new THREE.Mesh(new THREE.IcosahedronGeometry(r, 1), new THREE.MeshStandardMaterial({ color: [0x3f6b47, 0x4f8a52, 0x6aa35c][i % 3], roughness: 0.9 }));
    bush.position.set(x0 + 2 + Math.random() * (x1 - x0 - 4), CEIL + 0.12 + r * 0.7, z0 + 2 + Math.random() * (z1 - z0 - 4));
    bush.scale.y = 0.7; g.add(bush);
  }

  const B = ROOMS.reactorBalcony;
  const balcony = rbox(B[1] - B[0], 0.22, B[3] - B[2], stoneMaterial(3), 0.02);
  balcony.position.set((B[0] + B[1]) / 2, LEVEL - 0.11, (B[2] + B[3]) / 2); balcony.castShadow = true; g.add(balcony);
  const balGlass = new THREE.Mesh(new THREE.PlaneGeometry(B[3] - B[2], 1.05), appleGlass(0.16));
  balGlass.position.set(B[0], LEVEL + 0.52, (B[2] + B[3]) / 2); balGlass.rotation.y = Math.PI / 2; g.add(balGlass);
  const balRail = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, B[3] - B[2], 10), P.MAT.chrome());
  balRail.position.set(B[0], LEVEL + 1.06, (B[2] + B[3]) / 2); balRail.rotation.x = Math.PI / 2; g.add(balRail);
  const S = ROOMS.reactorStair;
  g.add(stairs({ x0: S[0], x1: S[1], z0: S[2], z1: S[3], yFrom: PIT, yTo: LEVEL, steps: 18, axis: 'x', railSide: -1 }));

  const ring0 = new THREE.Mesh(new THREE.TorusGeometry(4.35, 0.035, 8, 64), P.MAT.chrome());
  ring0.rotation.x = Math.PI / 2; ring0.position.set(cx, PIT + 1.05, cz); g.add(ring0);
  for (let i = 0; i < 24; i++) { const a = (i / 24) * Math.PI * 2; g.add(box(0.04, 1.05, 0.04, P.MAT.graphite(), cx + Math.cos(a) * 4.35, PIT + 0.52, cz + Math.sin(a) * 4.35)); }
  const coreMat = new THREE.MeshStandardMaterial({ color: 0x6fc4f5, emissive: 0x2f9fe8, emissiveIntensity: 1.5, roughness: 0.2 });
  const core = new THREE.Mesh(new THREE.SphereGeometry(1.6, 32, 24), coreMat); core.position.set(cx, PIT + 2.4, cz); g.add(core);
  const cage = new THREE.Mesh(new THREE.IcosahedronGeometry(2.0, 1), new THREE.MeshBasicMaterial({ color: 0xbfe6ff, wireframe: true, transparent: true, opacity: 0.35 })); cage.position.copy(core.position); g.add(cage);
  const rings = [];
  [[2.6, 0.4, 0], [3.2, -0.5, 0.6], [3.8, 0.2, -0.8]].forEach(([r, rx, rz]) => {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(r, 0.07, 10, 90), new THREE.MeshStandardMaterial({ color: 0x8ad0ff, emissive: 0x3fa8ff, emissiveIntensity: 1.4, roughness: 0.3, metalness: 0.4 }));
    ring.position.copy(core.position); ring.rotation.set(rx, 0, rz); g.add(ring); rings.push(ring);
  });
  const rays = new THREE.Group();
  for (let i = 0; i < 28; i++) {
    const ray = new THREE.Mesh(new THREE.PlaneGeometry(0.35, 9), new THREE.MeshBasicMaterial({ color: 0x6fc8ff, transparent: true, opacity: 0.08, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
    const a = (i / 28) * Math.PI * 2;
    ray.position.set(Math.cos(a) * 0.4, 0, Math.sin(a) * 0.4); ray.rotation.y = -a; ray.rotation.z = (i % 2 ? 1 : -1) * 0.12;
    rays.add(ray);
  }
  rays.position.copy(core.position); g.add(rays);
  // восходящие частицы над ядром
  const N = 260;
  const sparkGeo = new THREE.BufferGeometry();
  sparkGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 3), 3));
  const seeds = [];
  for (let i = 0; i < N; i++) seeds.push({ a: Math.random() * 6.28, r: 0.6 + Math.random() * 3.4, y: Math.random(), sp: 0.25 + Math.random() * 0.5 });
  const sparks = new THREE.Points(sparkGeo, new THREE.PointsMaterial({ color: 0x9fe0ff, size: 0.07, transparent: true, opacity: 0.75, depthWrite: false, blending: THREE.AdditiveBlending }));
  g.add(sparks);
  const glowDisc = new THREE.Mesh(new THREE.CircleGeometry(4.2, 48), new THREE.MeshBasicMaterial({ color: 0x3fa8ff, transparent: true, opacity: 0.25, blending: THREE.AdditiveBlending, depthWrite: false }));
  glowDisc.rotation.x = -Math.PI / 2; glowDisc.position.set(cx, PIT + 0.02, cz); g.add(glowDisc);

  // трубопроводы: от ядра к потолку и вдоль стен, с хомутами и вентилями
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const h = CEIL - (PIT + 3.6);
    const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.13, h, 12), P.MAT.brushed());
    pipe.position.set(cx + Math.cos(a) * 1.3, PIT + 3.6 + h / 2, cz + Math.sin(a) * 1.3); g.add(pipe);
    const flange = new THREE.Mesh(new THREE.CylinderGeometry(0.21, 0.21, 0.1, 12), P.MAT.graphite());
    flange.position.set(cx + Math.cos(a) * 1.3, PIT + 3.62, cz + Math.sin(a) * 1.3); g.add(flange);
  }
  const pipeMat = new THREE.MeshStandardMaterial({ color: 0x9aa4ad, roughness: 0.35, metalness: 0.7 });
  const runPipes = (axis, fixed, from, to, ys) => {
    for (const y of ys) {
      const len = to - from;
      const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, len, 12), pipeMat);
      if (axis === 'z') { pipe.rotation.x = Math.PI / 2; pipe.position.set(fixed, y, (from + to) / 2); }
      else { pipe.rotation.z = Math.PI / 2; pipe.position.set((from + to) / 2, y, fixed); }
      g.add(pipe);
      for (let k = 0; k <= 6; k++) {
        const q = from + (len * k) / 6;
        const clamp = new THREE.Mesh(new THREE.TorusGeometry(0.15, 0.025, 8, 16), P.MAT.graphite());
        if (axis === 'z') { clamp.position.set(fixed, y, q); clamp.rotation.y = Math.PI / 2; }
        else { clamp.position.set(q, y, fixed); }
        g.add(clamp);
      }
      const valve = new THREE.Mesh(new THREE.TorusGeometry(0.22, 0.03, 8, 20), new THREE.MeshStandardMaterial({ color: 0xb95740, roughness: 0.4, metalness: 0.5 }));
      if (axis === 'z') { valve.position.set(fixed + 0.2, y, (from + to) / 2 + 2); valve.rotation.y = Math.PI / 2; }
      else { valve.position.set((from + to) / 2 + 2, y, fixed + 0.2); }
      g.add(valve);
    }
  };
  runPipes('z', x0 + 0.35, z0 + 1, z1 - 1, [PIT + 1.2, PIT + 1.6, PIT + 2.1]);
  runPipes('x', z0 + 0.35, x0 + 1, x1 - 3, [PIT + 1.3, PIT + 1.75]);
  runPipes('x', z1 - 0.35, x0 + 1, x1 - 3, [PIT + 1.4, PIT + 1.85, PIT + 2.3]);

  const l1 = new THREE.PointLight(0x5fbfff, 3.5, 26, 1.5); l1.position.set(cx, PIT + 2.6, cz); g.add(l1);
  const l2 = new THREE.PointLight(0x2f6fbf, 1.2, 16, 1.5); l2.position.set(cx, CEIL - 0.6, cz); g.add(l2);

  // картины с атомными станциями и картинная подсветка
  const arts = [
    { kind: 'towers', title: 'Градирни', sub: 'вечерний свет' },
    { kind: 'night', title: 'Ночная смена', sub: 'станция после заката' },
    { kind: 'domes', title: 'Гермооболочки', sub: 'два энергоблока' },
  ];
  arts.forEach((a, i) => {
    const w = 2.4, h = w / 1.5;
    const { texture } = P.canvasTexture(1024, 683, (c, W, H) => drawNppPoster(c, W, H, a.kind));
    const art = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: texture, toneMapped: false }));
    const zz = z0 + 4.5 + i * 4.6;
    art.position.set(x0 + 0.16, PIT + 2.4, zz); art.rotation.y = Math.PI / 2; g.add(art);
    g.add(box(0.06, h + 0.12, w + 0.12, P.MAT.graphite(), x0 + 0.13, PIT + 2.4, zz));
    const capt = label(a.title, a.sub, 0.9, true); capt.position.set(x0 + 0.17, PIT + 1.45, zz); capt.rotation.y = Math.PI / 2; g.add(capt);
    const arm = new THREE.Mesh(new THREE.TorusGeometry(0.26, 0.02, 8, 16, Math.PI / 2), P.MAT.brushed());
    arm.position.set(x0 + 0.2, PIT + 2.4 + h / 2 + 0.1, zz); arm.rotation.y = Math.PI / 2; arm.rotation.z = -Math.PI / 2; g.add(arm);
    const shade = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.09, w * 0.8, 12, 1, true), P.MAT.brushed());
    shade.rotation.z = Math.PI / 2; shade.rotation.y = Math.PI / 2;
    shade.position.set(x0 + 0.48, PIT + 2.4 + h / 2 + 0.32, zz); g.add(shade);
    const spot = new THREE.SpotLight(0xfff2dc, 9, 5, 0.6, 0.5, 1.4);
    spot.position.set(x0 + 0.52, PIT + 2.4 + h / 2 + 0.3, zz);
    spot.target.position.set(x0 + 0.16, PIT + 2.3, zz);
    g.add(spot, spot.target);
    const cone = new THREE.Mesh(new THREE.ConeGeometry(0.5, 1.1, 16, 1, true), new THREE.MeshBasicMaterial({ color: 0xfff0d0, transparent: true, opacity: 0.07, side: THREE.DoubleSide, depthWrite: false }));
    cone.position.set(x0 + 0.34, PIT + 2.95, zz); cone.rotation.z = Math.PI / 2 - 0.5; g.add(cone);
    ctx.pickable(art, { kind: 'art', id: a.kind });
  });

  const console_ = new THREE.Group();
  const consoleBody = rbox(3.2, 0.9, 0.8, P.MAT.graphite(), 0.03); consoleBody.position.y = PIT + 0.45; console_.add(consoleBody);
  const scr = P.canvasTexture(1024, 384, () => {});
  const scrMesh = new THREE.Mesh(new THREE.PlaneGeometry(2.8, 1.05), new THREE.MeshBasicMaterial({ map: scr.texture, toneMapped: false }));
  scrMesh.position.set(0, PIT + 1.35, -0.2); scrMesh.rotation.x = -0.35; console_.add(scrMesh);
  console_.position.set(cx, 0, cz + 6.2); g.add(console_);
  const sign = label('Зал реактора · макет', 'балкон сверху, пульт и картины внизу', 1.4, true);
  sign.position.set(B[0] + 0.1, LEVEL + 2.2, 3.4); sign.rotation.y = Math.PI / 2; g.add(sign);

  scene.add(g);
  ctx.pickable(core, { kind: 'reactor' }); ctx.pickable(console_, { kind: 'reactor' });
  ctx.itemAnchors.set('reactor', { group: g, camPos: [-16.8, LEVEL + 1.9, 2.8], camTgt: [cx, PIT + 2.4, cz], walk: [-17.0, 0.2], look: [cx, cz] });
  ctx.itemAnchors.set('reactor-floor', { group: g, camPos: [cx + 1.2, PIT + 1.9, cz + 7.6], camTgt: [cx, PIT + 2.4, cz], walk: [cx, cz + 6.9], look: [cx, cz], floorY: PIT });
  ctx.blockers.push({ x: cx, z: cz, r: 4.6, above: 0 });
  ctx.blockers.push({ x0: cx - 1.7, x1: cx + 1.7, z0: cz + 5.7, z1: cz + 6.7, above: 0 });
  return {
    update(dt, t) {
      rings[0].rotation.y += dt * 0.5; rings[1].rotation.x += dt * 0.35; rings[2].rotation.z += dt * 0.42;
      cage.rotation.y -= dt * 0.15;
      rays.rotation.y += dt * 0.08;
      const pulse = 0.85 + Math.sin(t * 1.6) * 0.15;
      coreMat.emissiveIntensity = 1.5 * pulse; l1.intensity = 3.5 * pulse;
      for (const r of rays.children) r.material.opacity = 0.06 + Math.sin(t * 2 + r.rotation.y * 3) * 0.03;
      const arr = sparkGeo.attributes.position.array;
      for (let i = 0; i < N; i++) {
        const sd = seeds[i];
        sd.y = (sd.y + dt * sd.sp * 0.12) % 1;
        const a = sd.a + t * 0.2;
        const r = sd.r * (1 - sd.y * 0.35);
        arr[i * 3] = cx + Math.cos(a) * r;
        arr[i * 3 + 1] = PIT + 0.3 + sd.y * (CEIL - PIT - 0.6);
        arr[i * 3 + 2] = cz + Math.sin(a) * r;
      }
      sparkGeo.attributes.position.needsUpdate = true;
      this._acc = (this._acc || 0) + dt;
      if (this._acc > 0.5) {
        this._acc = 0;
        const c = scr.ctx;
        c.fillStyle = '#06111c'; c.fillRect(0, 0, 1024, 384);
        c.fillStyle = '#7fd0ff'; c.font = '600 44px ui-monospace, monospace'; c.textBaseline = 'top';
        c.fillText('МАКЕТ · ДЕМОНСТРАЦИОННЫЙ КОНТУР', 40, 30);
        c.fillStyle = 'rgba(191,230,255,.8)'; c.font = '36px ui-monospace, monospace';
        c.fillText(`пульс ядра ${(pulse * 100).toFixed(0)} %   кольца 3/3   контур замкнут`, 40, 110);
        c.fillText(`t = ${t.toFixed(1)} c   темп. условная 300 K   мощность 0 МВт`, 40, 170);
        c.fillStyle = 'rgba(191,230,255,.5)'; c.font = '28px -apple-system, sans-serif';
        c.fillText('Экспонат воспроизводит образ, а не физику: делить здесь нечего.', 40, 300);
        scr.texture.needsUpdate = true;
      }
    },
  };
}

/* ================= сад за окнами ================= */

/* ================= второй этаж: кольцевой лаундж ================= */

function buildRingLounge(scene, ctx) {
  const g = new THREE.Group();
  const slabMat = new THREE.MeshStandardMaterial({ color: 0xece6da, roughness: 0.6 });
  const woodTex = P.woodTexture(); woodTex.repeat.set(4, 4);
  const woodFloor = new THREE.MeshStandardMaterial({ map: woodTex, bumpMap: woodTex, bumpScale: 0.005, roughness: 0.35, metalness: 0.03 });
  // северный участок разрезан проёмом x −9…9: сплошная плита резала главный экран,
  // а через вырез со второго этажа открывается вид на дашборд
  const RING_PARTS = [ROOMS.ringW, ROOMS.ringE, ROOMS.ringS, ROOMS.ringN, ROOMS.ringN2];
  for (const r of RING_PARTS) {
    const w = r[1] - r[0], d = r[3] - r[2];
    const slab = rbox(w, 0.24, d, slabMat, 0.02);
    slab.position.set((r[0] + r[1]) / 2, FLOOR2 - 0.12, (r[2] + r[3]) / 2);
    slab.castShadow = true; slab.receiveShadow = true; g.add(slab);
    const top = new THREE.Mesh(new THREE.PlaneGeometry(w, d), woodFloor);
    top.rotation.x = -Math.PI / 2; top.position.set((r[0] + r[1]) / 2, FLOOR2 + 0.004, (r[2] + r[3]) / 2); top.receiveShadow = true; g.add(top);
    const led = box(w, 0.03, 0.03, new THREE.MeshBasicMaterial({ color: 0xfff3e6, transparent: true, opacity: 0.7 }),
      (r[0] + r[1]) / 2, FLOOR2 - 0.27, r[2] < -7 ? r[3] : r[2]);
    g.add(led); ctx.life.strips.push(led);
  }
  // парапет по внутреннему контуру кольца: цельное стекло, тонкий поручень
  const inner = [
    { axis: 'z', at: ROOMS.ringW[1], from: ROOMS.ringN[3], to: ROOMS.ringS[2] },
    { axis: 'z', at: ROOMS.ringE[0], from: ROOMS.ringN[3], to: ROOMS.ringS[2] },
    { axis: 'x', at: ROOMS.ringN[3], from: ROOMS.ringW[1], to: -9.0 },
    { axis: 'x', at: ROOMS.ringN[3], from: 9.0, to: ROOMS.ringE[0] },
    { axis: 'x', at: ROOMS.ringS[2], from: ROOMS.ringW[1], to: ROOMS.ringE[0] },
  ];
  for (const p of inner) {
    const len = p.to - p.from, mid = (p.from + p.to) / 2;
    const glass = new THREE.Mesh(new THREE.PlaneGeometry(len, 1.05), appleGlass(0.16));
    const rail = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, len, 10), P.MAT.chrome());
    if (p.axis === 'z') {
      glass.position.set(p.at, FLOOR2 + 0.52, mid); glass.rotation.y = Math.PI / 2;
      rail.position.set(p.at, FLOOR2 + 1.06, mid); rail.rotation.x = Math.PI / 2;
    } else {
      glass.position.set(mid, FLOOR2 + 0.52, p.at);
      rail.position.set(mid, FLOOR2 + 1.06, p.at); rail.rotation.z = Math.PI / 2;
    }
    g.add(glass, rail);
  }
  // парапет по кромке северного выреза — смотровая площадка над экраном
  for (const px of [-9.0, 9.0]) {
    const gl = new THREE.Mesh(new THREE.PlaneGeometry(ROOMS.ringN[3] - ROOMS.ringN[2], 1.05), appleGlass(0.16));
    gl.position.set(px, FLOOR2 + 0.52, (ROOMS.ringN[2] + ROOMS.ringN[3]) / 2); gl.rotation.y = Math.PI / 2; g.add(gl);
    const rl = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, ROOMS.ringN[3] - ROOMS.ringN[2], 10), P.MAT.chrome());
    rl.position.set(px, FLOOR2 + 1.06, (ROOMS.ringN[2] + ROOMS.ringN[3]) / 2); rl.rotation.x = Math.PI / 2; g.add(rl);
  }

  // лестница из фойе на кольцо и подпись
  // лестница стоит в лобби у края проёма и выходит мостиком через проём на кольцо
  const M = ROOMS.stairMain, SB = ROOMS.stairBridge;
  g.add(stairs({ x0: M[0], x1: M[1], z0: M[2], z1: M[3], yFrom: LEVEL, yTo: FLOOR2, steps: 26, axis: 'z', railSide: 1 }));
  const bridge2 = rbox(SB[1] - SB[0], 0.2, SB[3] - SB[2] + 0.4, slabMat, 0.02);
  bridge2.position.set((SB[0] + SB[1]) / 2, FLOOR2 - 0.1, (SB[2] + SB[3]) / 2); g.add(bridge2);
  for (const sx of [SB[0], SB[1]]) {
    const rail = new THREE.Mesh(new THREE.PlaneGeometry(SB[3] - SB[2] + 0.4, 1.05), appleGlass(0.16));
    rail.position.set(sx, FLOOR2 + 0.52, (SB[2] + SB[3]) / 2); rail.rotation.y = Math.PI / 2; g.add(rail);
  }
  const stairLabel = label('Второй этаж', 'лаундж · библиотека', 1.4);
  stairLabel.position.set((M[0] + M[1]) / 2, LEVEL + 2.5, M[3] + 0.05); stairLabel.rotation.y = Math.PI; g.add(stairLabel);
  // мостик к библиотеке над проходом
  const LB = ROOMS.libraryBridge;
  const bridge = rbox(LB[1] - LB[0] + 0.8, 0.2, LB[3] - LB[2], slabMat, 0.02);
  bridge.position.set((LB[0] + LB[1]) / 2, FLOOR2 - 0.1, (LB[2] + LB[3]) / 2); g.add(bridge);

  // мебель лаунджа вдоль окон
  const sofaMat = new THREE.MeshStandardMaterial({ color: 0xd9cdbb, roughness: 0.9 });
  const spots = [
    [-13.6, -6.0, Math.PI / 2], [-13.6, 0.4, Math.PI / 2], [-13.6, 6.6, Math.PI / 2],
    [13.6, -6.0, -Math.PI / 2], [13.6, -1.4, -Math.PI / 2],
    // северная сторона кольца разрезана проёмом x −9…9 (Б5): мебель туда не ставится
    [-12.0, -9.0, 0], [12.0, -9.0, 0], [-6.0, 9.0, Math.PI], [6.0, 9.0, Math.PI],
  ];
  for (const [sx, sz, ry] of spots) {
    const sofa = rbox(2.2, 0.42, 0.9, sofaMat, 0.08); sofa.position.set(sx, FLOOR2 + 0.21, sz); sofa.rotation.y = ry; sofa.castShadow = true; g.add(sofa);
    const back = rbox(2.2, 0.5, 0.2, sofaMat, 0.06);
    back.position.set(sx - Math.sin(ry) * 0.36, FLOOR2 + 0.62, sz - Math.cos(ry) * 0.36); back.rotation.y = ry; g.add(back);
    const tbl = new THREE.Mesh(new THREE.CylinderGeometry(0.36, 0.36, 0.04, 24), P.MAT.walnut());
    tbl.position.set(sx + Math.sin(ry) * 0.95, FLOOR2 + 0.42, sz + Math.cos(ry) * 0.95); g.add(tbl);
    g.add(box(0.05, 0.42, 0.05, P.MAT.chrome(), sx + Math.sin(ry) * 0.95, FLOOR2 + 0.21, sz + Math.cos(ry) * 0.95));
    const sh = P.makeContactShadow(3.2, 2.2, 0.28); sh.position.set(sx, FLOOR2 + 0.006, sz); g.add(sh);
    ctx.blockers.push({ x0: sx - 1.2, x1: sx + 1.2, z0: sz - 0.6, z1: sz + 0.6, above: 3 });
  }
  for (const [px, pz] of [[-14.6, -9.4], [-14.6, 9.4], [14.6, -9.4], [14.6, 9.4], [-10.4, -9.4], [10.4, -9.4]]) {
    const pl = (px + pz) % 2 === 0 ? P.makeMonstera(1.0) : P.makeFicus(1.1);
    pl.position.set(px, FLOOR2, pz); g.add(pl); ctx.life.plants.push(pl);
    ctx.blockers.push({ x: px, z: pz, r: 0.5, above: 3 });
  }
  // кофейная точка на северной стороне кольца
  // кофейная точка переехала на южную сторону: на северной теперь вырез над экраном
  const bar = rbox(2.6, 0.95, 0.7, stoneMaterial(2), 0.03); bar.position.set(0, FLOOR2 + 0.48, 9.2); g.add(bar);
  const barTop = rbox(2.7, 0.06, 0.78, P.MAT.walnut(), 0.02); barTop.position.set(0, FLOOR2 + 0.98, 9.2); g.add(barTop);
  for (let i = 0; i < 4; i++) { const mug = P.makeMug(); mug.position.set(-0.9 + i * 0.35, FLOOR2 + 1.01, 9.3); g.add(mug); }
  ctx.blockers.push({ x0: -1.4, x1: 1.4, z0: 8.8, z1: 9.6, above: 3 });

  scene.add(g);
  ctx.pickable(bar, { kind: 'room', id: 'lounge' });
  ctx.itemAnchors.set('lounge', { group: g, camPos: [-13.4, FLOOR2 + 1.7, 6.2], camTgt: [-15.7, FLOOR2 + 1.6, -2.0], walk: [-13.6, 3.6], look: [-15.9, -1], floorY: FLOOR2 });
  return { update() {} };
}

/* ================= наружное окружение: сад, лес, река, водопад ================= */

/**
 * Дальний план на цилиндре: ТОЛЬКО полоса горизонта, ниже — прозрачно, чтобы
 * читалась настоящая земля, выше — прозрачно, чтобы читалось небо. Три плана
 * с дымкой; силуэты разной высоты, период кратен ширине канвы — на стыке
 * повтора шва нет.
 */
function drawHorizon(c, w, h, night) {
  c.clearRect(0, 0, w, h);
  const HZ = h * 0.78;                       // линия горизонта на уровне глаз
  // дальние холмы: почти растворены в дымке
  const hill = (base, amp, color, period) => {
    c.fillStyle = color;
    c.beginPath(); c.moveTo(0, base);
    for (let x = 0; x <= w; x += 8) {
      const k = (x / w) * Math.PI * 2 * period;
      c.lineTo(x, base - amp * (0.55 + 0.45 * Math.sin(k) * Math.cos(k * 0.5 + 1.1)));
    }
    c.lineTo(w, base); c.closePath(); c.fill();
  };
  hill(HZ - 2, h * 0.075, night ? 'rgba(30,48,70,.75)' : 'rgba(150,175,192,.72)', 3);
  hill(HZ + 1, h * 0.05, night ? 'rgba(22,38,56,.85)' : 'rgba(126,156,150,.8)', 5);
  // два плана леса: силуэты РАЗНОЙ высоты и с разбросом, не гребёнка
  const forest = (base, scale, color, period) => {
    c.fillStyle = color;
    for (let i = 0; i < period; i++) {
      const x = (i / period) * w;
      const step = w / period;
      const th = (0.5 + 0.5 * Math.abs(Math.sin(i * 2.399))) * h * 0.055 * scale;
      const lean = Math.sin(i * 1.7) * step * 0.12;
      c.beginPath();
      c.moveTo(x - step * 0.55, base);
      c.lineTo(x + lean, base - th);
      c.lineTo(x + step * 0.55, base);
      c.closePath(); c.fill();
      if (i % 3 === 0) {                      // подлесок: круглые кроны вперемешку
        c.beginPath(); c.arc(x + step * 0.3, base - th * 0.32, th * 0.3, 0, Math.PI * 2); c.fill();
      }
    }
  };
  forest(HZ + 2, 0.9, night ? '#0d2016' : 'rgba(86,124,96,.92)', 150);
  forest(HZ + 7, 1.35, night ? '#0a1810' : '#3f6b47', 96);
  // дымка у самой земли: стык с настоящим газоном не должен читаться линией
  const haze = c.createLinearGradient(0, HZ - h * 0.02, 0, HZ + h * 0.05);
  haze.addColorStop(0, night ? 'rgba(20,32,48,0)' : 'rgba(214,228,232,0)');
  haze.addColorStop(0.55, night ? 'rgba(20,32,48,.45)' : 'rgba(214,228,232,.5)');
  haze.addColorStop(1, night ? 'rgba(20,32,48,0)' : 'rgba(214,228,232,0)');
  c.fillStyle = haze; c.fillRect(0, HZ - h * 0.02, w, h * 0.07);
}

/** трава: мелкий шум зелени, без видимого рисунка на повторе */
function grassTexture(size = 512) {
  const { texture } = P.canvasTexture(size, size, (c) => {
    c.fillStyle = '#5c7f45'; c.fillRect(0, 0, size, size);
    for (let i = 0; i < 14000; i++) {
      const x = Math.random() * size, y = Math.random() * size;
      const g = 108 + Math.random() * 60;
      c.strokeStyle = `rgba(${Math.round(g * 0.62)},${Math.round(g)},${Math.round(g * 0.5)},.5)`;
      c.lineWidth = 1;
      c.beginPath(); c.moveTo(x, y); c.lineTo(x + (Math.random() - 0.5) * 3, y - 2 - Math.random() * 3); c.stroke();
    }
  });
  return texture;
}

/** небо: градиент зенит → горизонт, отдельный для дня и ночи */
function skyTexture(night) {
  const { texture } = P.canvasTexture(16, 256, (c, w, h) => {
    const g = c.createLinearGradient(0, 0, 0, h);
    if (night) { g.addColorStop(0, '#0a1020'); g.addColorStop(0.62, '#1b2a3f'); g.addColorStop(1, '#33404d'); }
    else { g.addColorStop(0, '#5f93c4'); g.addColorStop(0.55, '#a8c8e2'); g.addColorStop(1, '#dfe8ea'); }
    c.fillStyle = g; c.fillRect(0, 0, w, h);
  });
  return texture;
}

/**
 * Окружение — замкнутая оболочка, а не четыре щита (В8). Небо сферой, земля
 * плоскостью до горизонта, дальний план — цилиндрическая панорама без углов,
 * ближний план — настоящая геометрия: деревья, кусты, дорожка, скамьи. И
 * кольцо штаб-квартиры вынесено из картинки в объём: параллакс отделяет
 * ближний план от дальнего, и «обои» перестают читаться обоями.
 */
function buildOutside(scene) {
  const g = new THREE.Group();
  scene.add(g);

  // --- небо
  const skyDay = skyTexture(false), skyNight = skyTexture(true);
  const sky = new THREE.Mesh(new THREE.SphereGeometry(240, 32, 20), new THREE.MeshBasicMaterial({ map: skyDay, side: THREE.BackSide, toneMapped: false, depthWrite: false, fog: false }));
  sky.position.y = -20; g.add(sky);

  // --- земля до горизонта
  const grass = grassTexture();
  // 460 м газона одной плиткой размывались в кисель: плотность считается от
  // реального размера плоскости (В6), 128 пикс/м при канве 512
  const groundMat = new THREE.MeshStandardMaterial({ map: P.tiled(grass, 460, 460, 128, 512), color: 0xffffff, roughness: 0.95, metalness: 0 });
  /*
   * В газоне ВЫРЕЗАН след здания. Сплошная плоскость на отметке −0.16 резала
   * котлован зала реактора (дно −1.9): с балкона поперёк ядра шла зелёная
   * плита. Отверстие чуть шире наружных граней стен — щели у цоколя нет.
   */
  const shape = new THREE.Shape();
  shape.moveTo(-230, -230); shape.lineTo(230, -230); shape.lineTo(230, 230); shape.lineTo(-230, 230); shape.closePath();
  const hole = new THREE.Path();
  hole.moveTo(-34.1, -11.4); hole.lineTo(34.1, -11.4); hole.lineTo(34.1, 21.2); hole.lineTo(-34.1, 21.2); hole.closePath();
  shape.holes.push(hole);
  const groundGeo = new THREE.ShapeGeometry(shape);
  // ShapeGeometry кладёт UV в мировых единицах — плитка считается тем же правилом
  const gp = groundGeo.attributes.position, guv = groundGeo.attributes.uv;
  for (let i = 0; i < gp.count; i++) guv.setXY(i, gp.getX(i) / 460, gp.getY(i) / 460);
  const ground = new THREE.Mesh(groundGeo, groundMat);
  ground.rotation.x = -Math.PI / 2; ground.position.y = -0.16; ground.receiveShadow = true; g.add(ground);

  // --- дальний план: одна цилиндрическая панорама, углов и стыков нет
  const day = P.canvasTexture(4096, 1024, (c, w, h) => drawHorizon(c, w, h, false));
  const night = P.canvasTexture(4096, 1024, (c, w, h) => drawHorizon(c, w, h, true));
  for (const t of [day.texture, night.texture]) { t.wrapS = THREE.RepeatWrapping; t.repeat.x = 3; }
  const pano = new THREE.Mesh(
    new THREE.CylinderGeometry(96, 96, 46, 96, 1, true),
    new THREE.MeshBasicMaterial({ map: day.texture, side: THREE.BackSide, toneMapped: false, transparent: true, depthWrite: false, fog: false }),
  );
  pano.position.set(0, 15, 4); pano.renderOrder = -1; g.add(pano);

  // --- ближний план: деревья инстансами (ствол + две кроны)
  const N = 22;
  const trunkG = new THREE.CylinderGeometry(0.16, 0.24, 4.2, 6);
  const crownG = new THREE.IcosahedronGeometry(1.9, 1);
  const trunks = new THREE.InstancedMesh(trunkG, P.MAT.walnut(), N);
  const crowns = new THREE.InstancedMesh(crownG, new THREE.MeshStandardMaterial({ color: 0x3e6f3f, roughness: 0.9, flatShading: true }), N * 2);
  trunks.castShadow = true; crowns.castShadow = true;
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), pos = new THREE.Vector3();
  let ci = 0;
  const spots = [];
  for (let i = 0; i < N; i++) {
    // по дуге в 26…44 м от фасада, врассыпную, но не в створе окон
    const a = (i / N) * Math.PI * 2 + (i % 3) * 0.11;
    const r = 26 + ((i * 7) % 19);
    const x = Math.cos(a) * r * 1.35, z = Math.sin(a) * r + 4;
    if (Math.abs(x) < 36 && z > -13 && z < 24) continue;   // не внутри здания
    spots.push([x, z]);
    const hgt = 0.85 + ((i * 13) % 7) / 10;
    pos.set(x, hgt * 2.1 - 0.16, z); sc.set(hgt, hgt, hgt);
    m4.compose(pos, q, sc); trunks.setMatrixAt(i, m4);
    for (let k = 0; k < 2; k++) {
      pos.set(x + (k ? 0.7 : -0.5), hgt * (4.3 + k * 0.9), z + (k ? -0.6 : 0.4));
      sc.setScalar(hgt * (k ? 0.78 : 1));
      m4.compose(pos, q, sc); crowns.setMatrixAt(ci++, m4);
    }
  }
  for (; ci < N * 2; ci++) { m4.compose(pos.set(0, -50, 0), q, sc.setScalar(0.01)); crowns.setMatrixAt(ci, m4); }
  trunks.instanceMatrix.needsUpdate = true; crowns.instanceMatrix.needsUpdate = true;
  g.add(trunks); g.add(crowns);

  // кусты у фасада
  const bushG = new THREE.IcosahedronGeometry(0.9, 1);
  const bushes = new THREE.InstancedMesh(bushG, new THREE.MeshStandardMaterial({ color: 0x4d7c46, roughness: 0.95, flatShading: true }), 34);
  let bi = 0;
  for (let i = 0; i < 34; i++) {
    const side = i < 17 ? -1 : 1;
    const z = -12 + ((i % 17) * 2.3);
    const x = side * (37 + (i % 3) * 0.9);
    pos.set(x, 0.5, z); sc.setScalar(0.7 + ((i * 5) % 6) / 12);
    m4.compose(pos, q, sc); bushes.setMatrixAt(bi++, m4);
  }
  bushes.instanceMatrix.needsUpdate = true; bushes.castShadow = true; g.add(bushes);

  // дорожка вокруг здания + скамьи
  const pathMat = new THREE.MeshStandardMaterial({ color: 0xcfc6b4, roughness: 0.9 });
  for (const side of [-1, 1]) {
    const walk = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 62), pathMat);
    walk.rotation.x = -Math.PI / 2; walk.position.set(side * 40, -0.14, 4); walk.receiveShadow = true; g.add(walk);
  }
  const cross = new THREE.Mesh(new THREE.PlaneGeometry(82, 2.6), pathMat);
  cross.rotation.x = -Math.PI / 2; cross.position.set(0, -0.14, 30); cross.receiveShadow = true; g.add(cross);
  for (const [bx, bz, ry] of [[-40, 12, 0], [-40, -6, 0], [40, 12, Math.PI], [40, -6, Math.PI], [-8, 30, -Math.PI / 2], [8, 30, Math.PI / 2]]) {
    const bench = new THREE.Group();
    const seat = box(1.9, 0.08, 0.5, P.MAT.walnut(), 0, 0.44, 0); seat.castShadow = true; bench.add(seat);
    bench.add(box(1.9, 0.4, 0.06, P.MAT.walnut(), 0, 0.66, -0.22));
    for (const dx of [-0.75, 0.75]) bench.add(box(0.07, 0.44, 0.44, P.MAT.graphite(), dx, 0.22, 0));
    bench.position.set(bx, -0.16, bz); bench.rotation.y = ry; g.add(bench);
  }

  // --- река с водопадом: настоящая вода на земле, а не синий клин на щите
  const waterMat = new THREE.MeshStandardMaterial({ color: 0x3f7ea3, roughness: 0.12, metalness: 0.25, transparent: true, opacity: 0.92 });
  const river = new THREE.Mesh(new THREE.PlaneGeometry(300, 16, 40, 2), waterMat);
  const rp = river.geometry.attributes.position;
  for (let i = 0; i < rp.count; i++) rp.setY(i, rp.getY(i) + Math.sin(rp.getX(i) * 0.035) * 5);  // русло изгибается
  river.geometry.computeVertexNormals();
  river.rotation.x = -Math.PI / 2; river.position.set(0, -0.12, -62); g.add(river);
  // уступ и падающая вода
  const ledge = new THREE.Mesh(new THREE.BoxGeometry(26, 2.4, 7), new THREE.MeshStandardMaterial({ color: 0x8b8578, roughness: 0.95 }));
  ledge.position.set(-46, 1.3, -68); ledge.rotation.y = 0.12; g.add(ledge);
  const fallMat = new THREE.MeshBasicMaterial({ color: 0xeef7fb, transparent: true, opacity: 0.85, side: THREE.DoubleSide, fog: false });
  const fall = new THREE.Mesh(new THREE.PlaneGeometry(9, 2.8), fallMat);
  fall.position.set(-46, 1.26, -64.55); fall.rotation.y = 0.12; g.add(fall);
  const foam = new THREE.Mesh(new THREE.CircleGeometry(5.5, 20), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.5, fog: false }));
  foam.rotation.x = -Math.PI / 2; foam.position.set(-46, -0.08, -63.2); g.add(foam);
  // верхнее русло за уступом
  const upper = new THREE.Mesh(new THREE.PlaneGeometry(60, 14), waterMat);
  upper.rotation.x = -Math.PI / 2; upper.position.set(-62, 2.62, -72); g.add(upper);

  // --- кольцо штаб-квартиры: объём, а не рисунок в лесу
  const ring = new THREE.Group();
  const R = 26, band = 7.2;
  const glassMat = new THREE.MeshPhysicalMaterial({ color: 0x9fc0cf, roughness: 0.08, metalness: 0.2, transparent: true, opacity: 0.78, side: THREE.DoubleSide });
  const outer = new THREE.Mesh(new THREE.CylinderGeometry(R, R, band, 72, 1, true), glassMat);
  const inner = new THREE.Mesh(new THREE.CylinderGeometry(R - 8.5, R - 8.5, band, 64, 1, true), glassMat);
  outer.position.y = band / 2; inner.position.y = band / 2; ring.add(outer); ring.add(inner);
  const roofMat = new THREE.MeshStandardMaterial({ color: 0xe6e3da, roughness: 0.7 });
  const roof = new THREE.Mesh(new THREE.RingGeometry(R - 8.5, R, 72), roofMat);
  roof.rotation.x = -Math.PI / 2; roof.position.y = band + 0.05; ring.add(roof);
  const base = new THREE.Mesh(new THREE.RingGeometry(R - 8.9, R + 0.4, 72), new THREE.MeshStandardMaterial({ color: 0xd7d2c6, roughness: 0.85 }));
  base.rotation.x = -Math.PI / 2; base.position.y = 0.02; ring.add(base);
  // горизонтальные членения этажей — чтобы кольцо читалось зданием, а не трубой
  for (const y of [band / 3, (band * 2) / 3]) {
    const fl = new THREE.Mesh(new THREE.TorusGeometry(R, 0.09, 6, 72), new THREE.MeshStandardMaterial({ color: 0xf1eee6, roughness: 0.6 }));
    fl.rotation.x = Math.PI / 2; fl.position.y = y; ring.add(fl);
  }
  ring.position.set(-32, -0.15, -88); ring.rotation.y = 0.35; g.add(ring);   // за рекой, но ближе дальнего плана

  let fog = null;
  return {
    setDark(dark) {
      sky.material.map = dark ? skyNight : skyDay; sky.material.needsUpdate = true;
      pano.material.map = dark ? night.texture : day.texture; pano.material.needsUpdate = true;
      groundMat.color.setHex(dark ? 0x40506a : 0xffffff);
      roofMat.color.setHex(dark ? 0x7d8ba0 : 0xe6e3da);
    },
    update() { if (fog) fog.needsUpdate = true; },
  };
}

/* ================= сборка ================= */

export function buildWings(scene, ctx) {
  const meeting = buildMeetingAndLibrary(scene, ctx);
  const parts = [buildAquarium(scene, ctx), meeting, buildGarage(scene, ctx), buildReactor(scene, ctx), buildRingLounge(scene, ctx)];
  const outside = buildOutside(scene);
  parts.push(outside);
  return {
    update(dt, t) { for (const p of parts) p.update(dt, t); },
    setDark(dark) { outside.setDark(dark); },
    setBooks(docs) { meeting.setBooks(docs); },
  };
}
