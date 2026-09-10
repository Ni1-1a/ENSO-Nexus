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
import * as P from './office-props.js';

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
  ringN: [-15.4, 15.4, -10.6, -7.4],
  ringS: [-15.4, 15.4, 7.6, 10.6],
  stairMain: [2.6, 5.6, 12.6, 19.8],
  stairBridge: [2.6, 5.6, 10.4, 12.6],
  library: [16.6, 25.4, 11.6, 20.4],
  libraryBridge: [15.3, 16.7, 13.0, 15.2],
};
const inRect = (x, z, r) => x > r[0] && x < r[1] && z > r[2] && z < r[3];

const FIRST = ['hall', 'lobby', 'door', 'meeting', 'meetingDoor', 'garage', 'garageDoor', 'reactorBalcony', 'reactorDoor'];
const SECOND = ['ringW', 'ringE', 'ringN', 'ringS', 'library', 'libraryBridge'];

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
export function stoneMaterial(repeat = 6) {
  if (!_stone) _stone = stoneTexture();
  const t = _stone.clone(); t.needsUpdate = true; t.repeat.set(repeat, repeat);
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
function label(text, sub = '', w = 0.9, dark = false) {
  const { texture } = P.canvasTexture(768, 256, (c) => {
    c.fillStyle = dark ? '#0f0f10' : '#fdfbf4'; c.fillRect(0, 0, 768, 256);
    c.fillStyle = '#b95740'; c.fillRect(0, 0, 768, 10);
    c.fillStyle = dark ? '#ffffff' : '#26211b'; c.font = '600 60px Georgia, serif'; c.textBaseline = 'top';
    c.fillText(text, 36, 40);
    c.fillStyle = dark ? 'rgba(255,255,255,.6)' : '#6f665a'; c.font = '30px -apple-system, sans-serif';
    c.fillText(sub, 36, 150);
  });
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, w / 3), new THREE.MeshBasicMaterial({ map: texture, toneMapped: false }));
  return m;
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
  const railLen = Math.hypot(len, yTo - yFrom);
  const midY = (yFrom + yTo) / 2 + 0.5;
  const glass = new THREE.Mesh(new THREE.PlaneGeometry(railLen, 1.0), appleGlass(0.14));
  const rail = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, railLen, 10), P.MAT.chrome());
  if (axis === 'z') {
    const x = railSide > 0 ? x1 : x0;
    glass.position.set(x, midY, (z0 + z1) / 2); glass.rotation.y = Math.PI / 2; glass.rotation.x = Math.atan2(yTo - yFrom, len);
    rail.position.set(x, midY + 0.5, (z0 + z1) / 2); rail.rotation.x = Math.PI / 2 - Math.atan2(yTo - yFrom, len);
  } else {
    const z = railSide > 0 ? z1 : z0;
    glass.position.set((x0 + x1) / 2, midY, z); glass.rotation.z = -Math.atan2(yTo - yFrom, len);
    rail.position.set((x0 + x1) / 2, midY + 0.5, z); rail.rotation.z = Math.PI / 2 + Math.atan2(yTo - yFrom, len);
  }
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
  // стёкла — тёмная полоса кабины
  if (glassTo > glassFrom) {
    const gl = box(glassTo - glassFrom, 0.32, width + 0.02, new THREE.MeshPhysicalMaterial({ color: 0x1c2a33, roughness: 0.05, metalness: 0.4, transparent: true, opacity: 0.85 }), (glassFrom + glassTo) / 2, glassY, 0);
    g.add(gl);
  }
  return g;
}

function wheel(r = 0.33, w = 0.24) {
  const g = new THREE.Group();
  const tire = new THREE.Mesh(new THREE.CylinderGeometry(r, r, w, 24), new THREE.MeshStandardMaterial({ color: 0x15151a, roughness: 0.9 }));
  tire.rotation.x = Math.PI / 2;
  g.add(tire);
  const rim = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.62, r * 0.62, w + 0.01, 16), P.MAT.chrome());
  rim.rotation.x = Math.PI / 2;
  g.add(rim);
  for (let i = 0; i < 5; i++) {
    const spoke = box(r * 0.5, 0.04, 0.03, P.MAT.brushed());
    spoke.position.set(Math.cos((i / 5) * Math.PI * 2) * r * 0.28, Math.sin((i / 5) * Math.PI * 2) * r * 0.28, w / 2 + 0.005);
    spoke.rotation.z = (i / 5) * Math.PI * 2;
    g.add(spoke);
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
  const sand = new THREE.Mesh(new THREE.PlaneGeometry(x1 - x0, z1 - z0), new THREE.MeshStandardMaterial({ color: 0xc9b98a, roughness: 1 }));
  sand.rotation.x = -Math.PI / 2; sand.position.set((x0 + x1) / 2, y0 + 0.01, (z0 + z1) / 2);
  g.add(sand);
  // каустика — анимированная канва на дне
  const caustic = P.canvasTexture(512, 512, (c) => { c.fillStyle = '#000'; c.fillRect(0, 0, 512, 512); });
  caustic.texture.wrapS = caustic.texture.wrapT = THREE.RepeatWrapping; caustic.texture.repeat.set(4, 3);
  const cmesh = new THREE.Mesh(new THREE.PlaneGeometry(x1 - x0, z1 - z0), new THREE.MeshBasicMaterial({ map: caustic.texture, transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false }));
  cmesh.rotation.x = -Math.PI / 2; cmesh.position.set((x0 + x1) / 2, y0 + 0.02, (z0 + z1) / 2);
  g.add(cmesh);
  // камни и водоросли
  for (let i = 0; i < 14; i++) {
    const r = 0.3 + Math.random() * 0.7;
    const rock = new THREE.Mesh(new THREE.IcosahedronGeometry(r, 1), new THREE.MeshStandardMaterial({ color: 0x4b5a66, roughness: 0.95 }));
    rock.position.set(x0 + 1 + Math.random() * (x1 - x0 - 2), y0 + r * 0.5, z0 + 1 + Math.random() * (z1 - z0 - 2));
    rock.scale.y = 0.6; g.add(rock);
  }
  const kelp = [];
  for (let i = 0; i < 26; i++) {
    const h = 1.5 + Math.random() * 3;
    const k = new THREE.Mesh(new THREE.PlaneGeometry(0.25, h, 1, 6), new THREE.MeshStandardMaterial({ color: 0x2f7a4a, roughness: 0.8, side: THREE.DoubleSide, transparent: true, opacity: 0.9 }));
    k.position.set(x0 + 0.8 + Math.random() * (x1 - x0 - 1.6), y0 + h / 2, z0 + 0.6 + Math.random() * (z1 - z0 - 1.2));
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
  // вода: голубая толща (без transmission — она дорогая на такой коробке) + тонирующий слой у стекла
  const water = new THREE.Mesh(new THREE.BoxGeometry(x1 - x0 - 0.1, y1 - y0 - 0.3, z1 - z0 - 0.1), new THREE.MeshPhysicalMaterial({ color: 0x1f6f9a, transparent: true, opacity: 0.42, roughness: 0.15, metalness: 0, side: THREE.BackSide, depthWrite: false }));
  water.position.set((x0 + x1) / 2, (y0 + y1) / 2 - 0.15, (z0 + z1) / 2);
  g.add(water);
  // поверхность воды и крыша над бассейном — сквозь него не должен быть виден сад
  const surface = new THREE.Mesh(new THREE.PlaneGeometry(x1 - x0, z1 - z0), new THREE.MeshPhysicalMaterial({ color: 0x9fd8ff, transparent: true, opacity: 0.55, roughness: 0.05, metalness: 0.1, side: THREE.DoubleSide }));
  surface.rotation.x = -Math.PI / 2; surface.position.set((x0 + x1) / 2, y1 - 0.12, (z0 + z1) / 2); g.add(surface);
  g.add(box(x1 - x0 + 0.4, 0.25, z1 - z0 + 0.4, stoneMaterial(3), (x0 + x1) / 2, y1 + 0.3, (z0 + z1) / 2));
  const lobbyBand = new THREE.Mesh(new THREE.PlaneGeometry(z1 - z0 + 0.4, 9 - y1), stoneMaterial(4));
  lobbyBand.position.set(x1 + 0.1, (y1 + 9) / 2, (z0 + z1) / 2); lobbyBand.rotation.y = Math.PI / 2; g.add(lobbyBand);
  // лучи света сверху
  for (let i = 0; i < 8; i++) {
    const ray = new THREE.Mesh(new THREE.PlaneGeometry(0.8, y1 - y0 - 0.4), new THREE.MeshBasicMaterial({ color: 0x9fd8ff, transparent: true, opacity: 0.07, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
    ray.position.set(x0 + 1.5 + i * 1.6, (y0 + y1) / 2, z0 + 2 + (i % 3) * 2.5);
    ray.rotation.y = 0.3 + i * 0.2; ray.rotation.z = 0.08;
    g.add(ray);
  }
  // стекло со стороны лобби и рама
  const glass = new THREE.Mesh(new THREE.PlaneGeometry(z1 - z0, y1 - y0), new THREE.MeshPhysicalMaterial({ color: 0xcfe6f2, transparent: true, opacity: 0.18, roughness: 0.02, metalness: 0.05, side: THREE.DoubleSide }));
  glass.position.set(x1, (y0 + y1) / 2, (z0 + z1) / 2); glass.rotation.y = Math.PI / 2;
  g.add(glass);
  const frameMat = P.MAT.graphite();
  for (const yy of [y0 + 0.07, y1 - 0.07]) g.add(box(0.12, 0.14, z1 - z0 + 0.2, frameMat, x1 + 0.02, yy, (z0 + z1) / 2));
  const ledA = box(0.03, 0.03, z1 - z0, new THREE.MeshBasicMaterial({ color: 0x9fd8ff, transparent: true, opacity: 0.8 }), x1 + 0.06, y1 + 0.02, (z0 + z1) / 2);
  g.add(ledA); ctx.life.strips.push(ledA);
  // синий свет из аквариума в лобби
  const glow = new THREE.PointLight(0x7fc4ff, 1.6, 12, 1.6); glow.position.set(x1 + 1.5, y0 + 3, (z0 + z1) / 2); g.add(glow);
  // обитатели
  const fauna = [];
  const whale = bigAnimal('whale'); g.add(whale); fauna.push({ obj: whale, cx: -23.2, cz: 16, rx: 4.4, rz: 2.6, y: 4.2, speed: 0.12, phase: 0, kind: 'whale' });
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
      for (const k of kelp) k.rotation.z = Math.sin(t * 0.7 + k.userData.phase) * 0.12;
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
  tvMesh.position.set(x1 - 0.12, LEVEL + 2.0, 16.3); tvMesh.rotation.y = -Math.PI / 2; g.add(tvMesh);
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
    const l = new THREE.PointLight(0xfff0dd, 1.3, 11, 1.6); l.position.set(x0 + 3 + i * 4, LEVEL + 4.2, (z0 + z1) / 2); g.add(l);
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
    bush.position.set(x0 + 2 + Math.random() * (x1 - x0 - 4), CEIL + 0.06 + r * 0.55, z0 + 2 + Math.random() * (z1 - z0 - 4));
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
  for (const r of [ROOMS.ringW, ROOMS.ringE, ROOMS.ringN, ROOMS.ringS]) {
    const w = r[1] - r[0], d = r[3] - r[2];
    const slab = rbox(w, 0.24, d, slabMat, 0.02);
    slab.position.set((r[0] + r[1]) / 2, FLOOR2 - 0.12, (r[2] + r[3]) / 2);
    slab.castShadow = true; slab.receiveShadow = true; g.add(slab);
    const top = new THREE.Mesh(new THREE.PlaneGeometry(w, d), woodFloor);
    top.rotation.x = -Math.PI / 2; top.position.set((r[0] + r[1]) / 2, FLOOR2 + 0.004, (r[2] + r[3]) / 2); top.receiveShadow = true; g.add(top);
    const led = box(w, 0.03, 0.03, new THREE.MeshBasicMaterial({ color: 0xfff3e6, transparent: true, opacity: 0.7 }),
      (r[0] + r[1]) / 2, FLOOR2 - 0.27, r === ROOMS.ringN ? r[3] : r[2]);
    g.add(led); ctx.life.strips.push(led);
  }
  // парапет по внутреннему контуру кольца: цельное стекло, тонкий поручень
  const inner = [
    { axis: 'z', at: ROOMS.ringW[1], from: ROOMS.ringN[3], to: ROOMS.ringS[2] },
    { axis: 'z', at: ROOMS.ringE[0], from: ROOMS.ringN[3], to: ROOMS.ringS[2] },
    { axis: 'x', at: ROOMS.ringN[3], from: ROOMS.ringW[1], to: ROOMS.ringE[0] },
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
    [-6.0, -9.0, 0], [6.0, -9.0, 0], [-6.0, 9.0, Math.PI], [6.0, 9.0, Math.PI],
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
  for (const [px, pz] of [[-14.6, -9.4], [-14.6, 9.4], [14.6, -9.4], [14.6, 9.4], [-9.0, -9.4], [9.0, -9.4]]) {
    const pl = (px + pz) % 2 === 0 ? P.makeMonstera(1.0) : P.makeFicus(1.1);
    pl.position.set(px, FLOOR2, pz); g.add(pl); ctx.life.plants.push(pl);
    ctx.blockers.push({ x: px, z: pz, r: 0.5, above: 3 });
  }
  // кофейная точка на северной стороне кольца
  const bar = rbox(2.6, 0.95, 0.7, stoneMaterial(2), 0.03); bar.position.set(0, FLOOR2 + 0.48, -9.2); g.add(bar);
  const barTop = rbox(2.7, 0.06, 0.78, P.MAT.walnut(), 0.02); barTop.position.set(0, FLOOR2 + 0.98, -9.2); g.add(barTop);
  for (let i = 0; i < 4; i++) { const mug = P.makeMug(); mug.position.set(-0.9 + i * 0.35, FLOOR2 + 1.01, -9.3); g.add(mug); }
  ctx.blockers.push({ x0: -1.4, x1: 1.4, z0: -9.6, z1: -8.8, above: 3 });

  scene.add(g);
  ctx.pickable(bar, { kind: 'room', id: 'lounge' });
  ctx.itemAnchors.set('lounge', { group: g, camPos: [-13.4, FLOOR2 + 1.7, 6.2], camTgt: [-15.7, FLOOR2 + 1.6, -2.0], walk: [-13.6, 3.6], look: [-15.9, -1], floorY: FLOOR2 });
  return { update() {} };
}

/* ================= наружное окружение: сад, лес, река, водопад ================= */

function drawOutside(c, w, h, night) {
  const sky = c.createLinearGradient(0, 0, 0, h);
  if (night) { sky.addColorStop(0, '#080f1e'); sky.addColorStop(0.6, '#16283f'); sky.addColorStop(1, '#28405c'); }
  else { sky.addColorStop(0, '#8dbfe0'); sky.addColorStop(0.55, '#cfe3ee'); sky.addColorStop(1, '#eef0e2'); }
  c.fillStyle = sky; c.fillRect(0, 0, w, h);
  if (!night) {
    c.fillStyle = 'rgba(255,255,255,.5)';
    for (let i = 0; i < 9; i++) { const x = (i * 613) % w, y = h * 0.1 + (i % 3) * 44; c.beginPath(); c.ellipse(x, y, 130 + i * 18, 26 + (i % 2) * 10, 0, 0, 7); c.fill(); }
  } else {
    c.fillStyle = 'rgba(255,255,255,.85)';
    for (let i = 0; i < 200; i++) c.fillRect((i * 397) % w, (i * 131) % (h * 0.42), 2, 2);
  }
  const horizon = h * 0.44;
  c.fillStyle = night ? '#1b2b3d' : '#9fb6c2';
  c.beginPath(); c.moveTo(0, horizon);
  for (let x = 0; x <= w; x += 60) c.lineTo(x, horizon - 60 - Math.sin(x * 0.004) * 70 - ((x * 37) % 40));
  c.lineTo(w, horizon); c.closePath(); c.fill();

  // штаб-квартира-кольцо среди леса — отсылка к Apple Park
  const rcx = w * 0.5, rcy = horizon + 44, rOut = w * 0.155, rIn = rOut * 0.72;
  c.save();
  c.beginPath();
  c.ellipse(rcx, rcy, rOut, rOut * 0.26, 0, 0, Math.PI * 2);
  c.ellipse(rcx, rcy, rIn, rIn * 0.26, 0, 0, Math.PI * 2, true);
  c.fillStyle = night ? 'rgba(120,170,210,.32)' : 'rgba(228,238,244,.92)'; c.fill();
  c.strokeStyle = night ? 'rgba(160,210,245,.6)' : 'rgba(120,140,155,.5)'; c.lineWidth = 3; c.stroke();
  c.strokeStyle = night ? 'rgba(255,225,170,.6)' : 'rgba(140,160,175,.4)'; c.lineWidth = 2;
  for (let a = 0; a < Math.PI * 2; a += 0.055) {
    const x1 = rcx + Math.cos(a) * rIn, y1 = rcy + Math.sin(a) * rIn * 0.26;
    const x2 = rcx + Math.cos(a) * rOut, y2 = rcy + Math.sin(a) * rOut * 0.26;
    c.beginPath(); c.moveTo(x1, y1 - 15); c.lineTo(x2, y2 - 15); c.stroke();
  }
  c.fillStyle = night ? 'rgba(90,140,180,.5)' : 'rgba(208,222,230,.95)';
  c.beginPath(); c.ellipse(rcx, rcy - 15, rOut, rOut * 0.26, 0, Math.PI, 0); c.fill();
  c.restore();
  c.fillStyle = night ? '#122a1c' : '#5f9b62';
  c.beginPath(); c.ellipse(rcx, rcy, rIn * 0.9, rIn * 0.23, 0, 0, Math.PI * 2); c.fill();

  // лес двумя планами
  const forest = (y, scale, color) => {
    c.fillStyle = color;
    for (let x = -40; x < w + 40; x += 26 * scale) {
      const th = (70 + ((x * 53) % 62)) * scale;
      c.beginPath(); c.moveTo(x, y); c.lineTo(x + 13 * scale, y - th); c.lineTo(x + 26 * scale, y); c.closePath(); c.fill();
    }
  };
  forest(horizon + 28, 0.85, night ? '#0f2318' : '#3f6b47');
  forest(horizon + 66, 1.2, night ? '#0c1c13' : '#356040');

  // река с водопадом
  const riverTop = horizon + 104;
  c.fillStyle = night ? '#0d2233' : '#4a86a8';
  c.beginPath();
  c.moveTo(0, h); c.lineTo(0, riverTop + 130);
  c.bezierCurveTo(w * 0.25, riverTop + 64, w * 0.4, riverTop + 30, w * 0.5, riverTop);
  c.bezierCurveTo(w * 0.6, riverTop + 30, w * 0.75, riverTop + 64, w, riverTop + 130);
  c.lineTo(w, h); c.closePath(); c.fill();
  c.fillStyle = night ? '#16202a' : '#7d8a91';
  c.beginPath();
  c.moveTo(w * 0.34, riverTop + 36); c.lineTo(w * 0.44, riverTop + 6); c.lineTo(w * 0.56, riverTop + 6); c.lineTo(w * 0.66, riverTop + 36);
  c.lineTo(w * 0.66, riverTop + 104); c.lineTo(w * 0.34, riverTop + 104); c.closePath(); c.fill();
  const fall = c.createLinearGradient(0, riverTop, 0, riverTop + 104);
  fall.addColorStop(0, night ? 'rgba(190,225,245,.85)' : 'rgba(255,255,255,.95)');
  fall.addColorStop(1, night ? 'rgba(140,190,220,.4)' : 'rgba(225,240,248,.62)');
  c.fillStyle = fall; c.fillRect(w * 0.45, riverTop + 6, w * 0.1, 100);
  c.fillStyle = night ? 'rgba(190,225,245,.35)' : 'rgba(255,255,255,.6)';
  for (let i = 0; i < 28; i++) { c.beginPath(); c.arc(w * 0.5 + (Math.random() - 0.5) * w * 0.12, riverTop + 100 + Math.random() * 24, 4 + Math.random() * 12, 0, 7); c.fill(); }
  c.fillStyle = night ? '#0f1c14' : '#4f7d58';
  c.beginPath(); c.moveTo(0, riverTop + 128); c.bezierCurveTo(w * 0.22, riverTop + 78, w * 0.36, riverTop + 48, w * 0.44, riverTop + 24); c.lineTo(0, riverTop + 24); c.closePath(); c.fill();
  c.beginPath(); c.moveTo(w, riverTop + 128); c.bezierCurveTo(w * 0.78, riverTop + 78, w * 0.64, riverTop + 48, w * 0.56, riverTop + 24); c.lineTo(w, riverTop + 24); c.closePath(); c.fill();

  // сад на переднем плане: газон, дорожка, кроны, скамьи
  c.fillStyle = night ? '#0b1710' : '#59894f';
  c.fillRect(0, h * 0.84, w, h * 0.16);
  c.strokeStyle = night ? 'rgba(190,180,150,.25)' : 'rgba(232,226,208,.85)'; c.lineWidth = 26; c.lineCap = 'round';
  c.beginPath(); c.moveTo(-20, h * 0.97); c.bezierCurveTo(w * 0.3, h * 0.9, w * 0.6, h * 0.95, w + 20, h * 0.87); c.stroke();
  for (let i = 0; i < 30; i++) {
    const x = (i * 271) % w, y = h * 0.845 + ((i * 53) % Math.round(h * 0.12));
    c.fillStyle = night ? '#12281a' : ['#3f6b47', '#4f8a52', '#6aa35c'][i % 3];
    c.beginPath(); c.arc(x, y, 24 + (i % 4) * 12, 0, Math.PI * 2); c.fill();
    if (!night && i % 5 === 0) { c.fillStyle = '#6b4a33'; c.fillRect(x - 3, y, 6, 22); }
  }
  if (night) { c.fillStyle = 'rgba(255,214,150,.55)'; for (let i = 0; i < 26; i++) { c.beginPath(); c.arc((i * 331) % w, h * 0.9 + ((i * 71) % 60), 3, 0, 7); c.fill(); } }
}

function buildOutside(scene) {
  const day = P.canvasTexture(4096, 1536, (c, w, h) => drawOutside(c, w, h, false));
  const night = P.canvasTexture(4096, 1536, (c, w, h) => drawOutside(c, w, h, true));
  const planes = [];
  for (const side of [-1, 1]) {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(120, 46), new THREE.MeshBasicMaterial({ map: day.texture, toneMapped: false }));
    m.position.set(side * 58, 15, 4); m.rotation.y = side < 0 ? Math.PI / 2 : -Math.PI / 2;
    scene.add(m); planes.push(m);
  }
  for (const [z, ry] of [[-52, 0], [58, Math.PI]]) {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(120, 46), new THREE.MeshBasicMaterial({ map: day.texture, toneMapped: false }));
    m.position.set(0, 15, z); m.rotation.y = ry;
    scene.add(m); planes.push(m);
  }
  return { setDark(dark) { for (const m of planes) { m.material.map = dark ? night.texture : day.texture; m.material.needsUpdate = true; } }, update() {} };
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
