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

export const LEVEL = 1.02;   // фойе, лобби и крылья
export const MEZZ = 4.4;     // антресоль библиотеки

/* прямоугольники проходимости: [x0, x1, z0, z1] */
export const ROOMS = {
  hall: [-15.4, 15.4, -9.6, 10.7],
  lobby: [-15.4, 15.4, 11.3, 20.6],
  door: [-4.4, 4.4, 10.4, 11.6],
  meeting: [16.6, 25.4, 11.6, 20.4],
  meetingDoor: [15.3, 16.7, 13.0, 15.2],
  garage: [16.6, 33.4, -10.2, 7.4],
  garageDoor: [15.3, 16.7, -1.2, 1.6],
  reactor: [-33.4, -16.6, -10.2, 7.4],
  reactorDoor: [-16.7, -15.3, -1.2, 1.6],
  stair: [16.6, 18.4, 12.6, 19.6],
  mezz: [18.4, 25.4, 11.6, 20.4],
  mezzLanding: [16.6, 18.4, 19.6, 20.4],
};
const inRect = (x, z, r) => x > r[0] && x < r[1] && z > r[2] && z < r[3];

export function insideWalkable(x, z) {
  for (const k of ['hall', 'lobby', 'door', 'meeting', 'meetingDoor', 'garage', 'garageDoor', 'reactor', 'reactorDoor', 'mezzLanding']) {
    if (inRect(x, z, ROOMS[k])) return true;
  }
  return false;
}

/** высота пола с учётом этажа: из кандидатов берётся ближайший к прежнему полу */
export function floorHeight(x, z, prevY, base) {
  const cands = [base(x, z)];
  if (inRect(x, z, ROOMS.stair)) {
    const t = Math.max(0, Math.min(1, (z - ROOMS.stair[2]) / (ROOMS.stair[3] - ROOMS.stair[2])));
    cands.push(LEVEL + t * (MEZZ - LEVEL));
  }
  if (inRect(x, z, ROOMS.mezz) || inRect(x, z, ROOMS.mezzLanding)) cands.push(MEZZ);
  // из досягаемых (в пределах ступени 0.45 м) берётся самый высокий — так по лестнице
  // поднимаются, а не идут «под ней»; недосягаемые не рассматриваются
  const reach = cands.filter((c) => Math.abs(c - prevY) < 0.45);
  if (reach.length) return Math.max(...reach);
  return cands.reduce((best, c) => (Math.abs(c - prevY) < Math.abs(best - prevY) ? c : best), cands[0]);
}

/* ================= общие помощники ================= */

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
  // стенки бассейна тёмно-синие, дно песок
  const wallMat = new THREE.MeshStandardMaterial({ color: 0x0f2a3d, roughness: 0.9 });
  g.add(box(0.2, y1 - y0, z1 - z0, wallMat, x0, (y0 + y1) / 2, (z0 + z1) / 2));
  g.add(box(x1 - x0, y1 - y0, 0.2, wallMat, (x0 + x1) / 2, (y0 + y1) / 2, z0));
  g.add(box(x1 - x0, y1 - y0, 0.2, wallMat, (x0 + x1) / 2, (y0 + y1) / 2, z1));
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
  // вода: голубая толща (без transmission — она дорогая на такой коробке) + тонирующий слой у стекла
  const water = new THREE.Mesh(new THREE.BoxGeometry(x1 - x0 - 0.1, y1 - y0 - 0.3, z1 - z0 - 0.1), new THREE.MeshPhysicalMaterial({ color: 0x1f6f9a, transparent: true, opacity: 0.42, roughness: 0.15, metalness: 0, side: THREE.BackSide, depthWrite: false }));
  water.position.set((x0 + x1) / 2, (y0 + y1) / 2 - 0.15, (z0 + z1) / 2);
  g.add(water);
  const tint = new THREE.Mesh(new THREE.PlaneGeometry(z1 - z0, y1 - y0), new THREE.MeshBasicMaterial({ color: 0x2a7fa8, transparent: true, opacity: 0.3, depthWrite: false, side: THREE.DoubleSide }));
  tint.position.set(x1 - 0.25, (y0 + y1) / 2, (z0 + z1) / 2); tint.rotation.y = Math.PI / 2; g.add(tint);
  // поверхность воды и крыша над бассейном — сквозь него не должен быть виден сад
  const surface = new THREE.Mesh(new THREE.PlaneGeometry(x1 - x0, z1 - z0), new THREE.MeshPhysicalMaterial({ color: 0x9fd8ff, transparent: true, opacity: 0.55, roughness: 0.05, metalness: 0.1, side: THREE.DoubleSide }));
  surface.rotation.x = -Math.PI / 2; surface.position.set((x0 + x1) / 2, y1 - 0.12, (z0 + z1) / 2); g.add(surface);
  g.add(box(x1 - x0 + 0.4, 0.3, z1 - z0 + 0.4, new THREE.MeshStandardMaterial({ color: 0x0b1a26, roughness: 0.9 }), (x0 + x1) / 2, y1 + 0.35, (z0 + z1) / 2));
  g.add(box(x1 - x0 + 0.4, 9 - y1, 0.3, wallMat, (x0 + x1) / 2, (y1 + 9) / 2, z1 + 0.1));
  g.add(box(x1 - x0 + 0.4, 9 - y1, 0.3, wallMat, (x0 + x1) / 2, (y1 + 9) / 2, z0 - 0.1));
  g.add(box(0.3, 9 - y1, z1 - z0 + 0.4, wallMat, x0 - 0.1, (y1 + 9) / 2, (z0 + z1) / 2));
  const lobbyBand = new THREE.Mesh(new THREE.PlaneGeometry(z1 - z0 + 0.4, 9 - y1), new THREE.MeshStandardMaterial({ color: 0xf3efe6, roughness: 0.95 }));
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
  g.add(box(0.16, 0.25, z1 - z0 + 0.3, frameMat, x1 + 0.02, y1 + 0.1, (z0 + z1) / 2));
  g.add(box(0.16, 0.25, z1 - z0 + 0.3, frameMat, x1 + 0.02, y0 + 0.1, (z0 + z1) / 2));
  for (const zz of [z0, z1]) g.add(box(0.16, y1 - y0 + 0.4, 0.14, frameMat, x1 + 0.02, (y0 + y1) / 2, zz));
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
  const wallMat = new THREE.MeshStandardMaterial({ color: 0xf3efe6, roughness: 0.95 });
  // пол переговорной, антресоль библиотеки, наружные стены, крыша
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(x1 - x0, z1 - z0), new THREE.MeshStandardMaterial({ color: 0x5a5f66, roughness: 0.9 }));
  floor.rotation.x = -Math.PI / 2; floor.position.set((x0 + x1) / 2, LEVEL + 0.002, (z0 + z1) / 2); floor.receiveShadow = true; g.add(floor);
  g.add(box(0.2, 9, z1 - z0, wallMat, x1, 4.5, (z0 + z1) / 2));
  g.add(box(x1 - x0, 9, 0.2, wallMat, (x0 + x1) / 2, 4.5, z1));
  g.add(box(x1 - x0, 9, 0.2, wallMat, (x0 + x1) / 2, 4.5, z0));
  const roof = new THREE.Mesh(new THREE.PlaneGeometry(x1 - x0, z1 - z0), new THREE.MeshStandardMaterial({ color: 0xe4dfd5, roughness: 0.9 }));
  roof.rotation.x = Math.PI / 2; roof.position.set((x0 + x1) / 2, 7.6, (z0 + z1) / 2); g.add(roof);
  // стеклянная стена к лобби с дверным проёмом
  const glassMat = new THREE.MeshPhysicalMaterial({ color: 0xdde8ee, transparent: true, opacity: 0.16, roughness: 0.04, metalness: 0.1, side: THREE.DoubleSide, depthWrite: false });
  for (const [za, zb] of [[z0, 13.0], [15.2, z1]]) {
    const pane = new THREE.Mesh(new THREE.PlaneGeometry(zb - za, 6.5), glassMat);
    pane.position.set(x0, LEVEL + 3.25, (za + zb) / 2); pane.rotation.y = Math.PI / 2; g.add(pane);
  }
  const lintel = box(0.16, 2.3, 2.2, P.MAT.graphite(), x0, LEVEL + 5.4, 14.1); g.add(lintel);
  for (const zz of [z0, 13.0, 15.2, z1]) g.add(box(0.12, 6.6, 0.12, P.MAT.graphite(), x0, LEVEL + 3.3, zz));
  // антресоль: плита с вырезом под лестницу
  const slabMat = new THREE.MeshStandardMaterial({ color: 0xece6da, roughness: 0.6 });
  const slabA = rbox(x1 - ROOMS.mezz[0], 0.22, z1 - z0, slabMat, 0.02); slabA.position.set((ROOMS.mezz[0] + x1) / 2, MEZZ - 0.11, (z0 + z1) / 2); g.add(slabA);
  const slabB = rbox(ROOMS.mezz[0] - x0, 0.22, z1 - ROOMS.stair[3], slabMat, 0.02); slabB.position.set((x0 + ROOMS.mezz[0]) / 2, MEZZ - 0.11, (ROOMS.stair[3] + z1) / 2); g.add(slabB);
  const slabC = rbox(ROOMS.mezz[0] - x0, 0.22, ROOMS.stair[2] - z0, slabMat, 0.02); slabC.position.set((x0 + ROOMS.mezz[0]) / 2, MEZZ - 0.11, (z0 + ROOMS.stair[2]) / 2); g.add(slabC);
  // лестница: 20 ступеней вдоль z
  const steps = 20, run = (ROOMS.stair[3] - ROOMS.stair[2]) / steps, rise = (MEZZ - LEVEL) / steps;
  const stepMat = new THREE.MeshStandardMaterial({ color: 0x2b2622, roughness: 0.6 });
  for (let i = 0; i < steps; i++) {
    const st = box(ROOMS.stair[1] - ROOMS.stair[0] - 0.1, rise, run + 0.02, stepMat, (ROOMS.stair[0] + ROOMS.stair[1]) / 2, LEVEL + rise * (i + 0.5), ROOMS.stair[2] + run * (i + 0.5));
    st.receiveShadow = true; g.add(st);
  }
  const rail = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, Math.hypot(ROOMS.stair[3] - ROOMS.stair[2], MEZZ - LEVEL), 8), P.MAT.chrome());
  rail.position.set(ROOMS.stair[1] + 0.05, (LEVEL + MEZZ) / 2 + 0.9, (ROOMS.stair[2] + ROOMS.stair[3]) / 2);
  rail.rotation.x = -Math.atan2(MEZZ - LEVEL, ROOMS.stair[3] - ROOMS.stair[2]) + Math.PI / 2; g.add(rail);
  for (let i = 0; i <= 6; i++) {
    const zz = ROOMS.stair[2] + i * (ROOMS.stair[3] - ROOMS.stair[2]) / 6;
    const h = LEVEL + (zz - ROOMS.stair[2]) / (ROOMS.stair[3] - ROOMS.stair[2]) * (MEZZ - LEVEL);
    g.add(box(0.03, 0.9, 0.03, P.MAT.graphite(), ROOMS.stair[1] + 0.05, h + 0.45, zz));
  }
  // ограждение антресоли вдоль лестничного проёма и лобби
  const balMat = new THREE.MeshPhysicalMaterial({ color: 0xdde8ee, transparent: true, opacity: 0.2, roughness: 0.05, side: THREE.DoubleSide, depthWrite: false });
  const bal1 = new THREE.Mesh(new THREE.PlaneGeometry(ROOMS.stair[3] - ROOMS.stair[2] - 0.3, 1.0), balMat);
  bal1.position.set(ROOMS.mezz[0], MEZZ + 0.5, (ROOMS.stair[2] + ROOMS.stair[3]) / 2); bal1.rotation.y = Math.PI / 2; g.add(bal1);
  const bal2 = new THREE.Mesh(new THREE.PlaneGeometry(ROOMS.stair[3] - ROOMS.stair[2] - 0.3, 0.3), balMat);
  bal2.position.set(ROOMS.mezz[0], MEZZ + 0.5, (ROOMS.stair[2] + ROOMS.stair[3]) / 2); g.add(bal2);
  g.add(box(0.03, 0.03, ROOMS.stair[3] - ROOMS.stair[2], P.MAT.chrome(), ROOMS.mezz[0], MEZZ + 1.02, (ROOMS.stair[2] + ROOMS.stair[3]) / 2));

  // ---- переговорная: стол на 12, экран, растения ----
  const table = rbox(6.0, 0.08, 1.6, new THREE.MeshPhysicalMaterial({ color: 0x5a3f2c, roughness: 0.35, clearcoat: 0.4 }), 0.03);
  table.position.set(21, LEVEL + 0.75, 16.3); table.castShadow = true; g.add(table);
  for (const dx of [-2.2, 2.2]) g.add(box(0.1, 0.72, 1.2, P.MAT.graphite(), 21 + dx, LEVEL + 0.36, 16.3));
  const tableShadow = P.makeContactShadow(7, 3, 0.35); tableShadow.position.set(21, LEVEL + 0.006, 16.3); g.add(tableShadow);
  // поворот кресла = поворот человека: спинка кресла в +z, лицо человека в −z
  const seats = [];
  for (let i = 0; i < 5; i++) { seats.push([18.7 + i * 1.15, 15.2, Math.PI]); seats.push([18.7 + i * 1.15, 17.4, 0]); }
  seats.push([17.7, 16.3, -Math.PI / 2]); seats.push([24.3, 16.3, Math.PI / 2]);
  const looks = [{ hair: 0x2a1f18, skin: 0xe3b78f }, { hair: 0xb99867, skin: 0xf2d4b3, female: true }, { hair: 0x4a4a4a, skin: 0xc98e62, glasses: true }];
  seats.forEach(([sx, sz, ry], i) => {
    const ch = P.makeChair(); ch.position.set(sx, LEVEL, sz); ch.rotation.y = ry; g.add(ch);
    if (i < 3) {
      const p = P.makePerson({ ...looks[i], polo: ctx.brand.poloHex || 0xb95740 });
      p.group.position.set(sx, LEVEL, sz); p.group.rotation.y = ry; g.add(p.group);
      ctx.life.addAgent(`meeting${i}`, p, {});
      const fx = -Math.sin(ry), fz = -Math.cos(ry); // куда смотрит человек
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
  const light1 = new THREE.PointLight(0xfff0dd, 1.2, 9, 1.8); light1.position.set(21, LEVEL + 3.6, 16.3); g.add(light1);
  const mLabel = label('Переговорная', '12 мест · стекло · экран', 1.2); mLabel.position.set(x0 + 0.05, LEVEL + 2.3, 12.2); mLabel.rotation.y = -Math.PI / 2; g.add(mLabel);

  // ---- библиотека на антресоли ----
  const shelfMat = P.MAT.walnut();
  const bookGeo = new THREE.BoxGeometry(0.035, 0.24, 0.16);
  const bookMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85 });
  const books = new THREE.InstancedMesh(bookGeo, bookMat, 720);
  const bm = new THREE.Matrix4(); const bc = new THREE.Color(); let bi = 0;
  const palette = [0xb95740, 0x26211b, 0x4a6b8a, 0x4f7d58, 0xb07e36, 0xf3efe6, 0x7a5aa8, 0xa93e2c];
  const shelfAt = (cx, cz, ry, w) => {
    const sh = new THREE.Group();
    sh.add(box(w, 2.4, 0.05, shelfMat, 0, 1.2, -0.14));
    for (const sx of [-w / 2 + 0.025, w / 2 - 0.025]) sh.add(box(0.05, 2.4, 0.32, shelfMat, sx, 1.2, 0));
    for (let r = 0; r < 6; r++) sh.add(box(w - 0.06, 0.025, 0.3, new THREE.MeshStandardMaterial({ color: 0x8b6a4a }), 0, 0.2 + r * 0.46, 0));
    sh.position.set(cx, MEZZ, cz); sh.rotation.y = ry;
    g.add(sh);
    for (let r = 0; r < 5; r++) {
      let x = -w / 2 + 0.08;
      while (x < w / 2 - 0.08 && bi < 720) {
        const h = 0.18 + Math.random() * 0.1, wdt = 0.03 + Math.random() * 0.03;
        bm.makeScale(wdt / 0.035, h / 0.24, 1);
        const local = new THREE.Vector3(x, 0.2 + r * 0.46 + h / 2 + 0.012, 0.02);
        local.applyAxisAngle(new THREE.Vector3(0, 1, 0), ry).add(new THREE.Vector3(cx, MEZZ, cz));
        bm.setPosition(local);
        const rot = new THREE.Matrix4().makeRotationY(ry);
        bm.multiplyMatrices(new THREE.Matrix4().makeTranslation(local.x, local.y, local.z), new THREE.Matrix4().multiplyMatrices(rot, new THREE.Matrix4().makeScale(wdt / 0.035, h / 0.24, 1)));
        books.setMatrixAt(bi, bm);
        books.setColorAt(bi, bc.set(palette[Math.floor(Math.random() * palette.length)]));
        bi += 1; x += wdt + 0.006;
      }
    }
  };
  shelfAt(x1 - 0.2, 14.0, -Math.PI / 2, 4.6);
  shelfAt(x1 - 0.2, 18.8, -Math.PI / 2, 3.4);
  shelfAt(22.2, z1 - 0.2, Math.PI, 5.6);
  books.count = bi; books.instanceMatrix.needsUpdate = true;
  g.add(books);
  // читальные столы, лампы, читатель
  for (const [tx, tz] of [[20.5, 14.3], [20.5, 18.2]]) {
    const t = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.7, 0.05, 28), new THREE.MeshPhysicalMaterial({ color: 0x5a3f2c, roughness: 0.35, clearcoat: 0.4 }));
    t.position.set(tx, MEZZ + 0.74, tz); g.add(t);
    g.add(box(0.08, 0.72, 0.08, P.MAT.graphite(), tx, MEZZ + 0.36, tz));
    const lampArm = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 0.5, 8), P.MAT.brushed()); lampArm.position.set(tx + 0.4, MEZZ + 1.0, tz); g.add(lampArm);
    const shade = new THREE.Mesh(new THREE.ConeGeometry(0.14, 0.16, 16, 1, true), new THREE.MeshStandardMaterial({ color: 0x4f7d58, side: THREE.DoubleSide })); shade.position.set(tx + 0.4, MEZZ + 1.3, tz); g.add(shade);
    const lamp = new THREE.PointLight(0xffe4b8, 0.8, 3, 2); lamp.position.set(tx + 0.4, MEZZ + 1.2, tz); g.add(lamp);
    for (const a of [0.8, 2.4]) { const ch = P.makeChair(); ch.position.set(tx + Math.cos(a) * 1.0, MEZZ, tz + Math.sin(a) * 1.0); ch.rotation.y = -a + Math.PI / 2; g.add(ch); }
    const shadow = P.makeContactShadow(2.6, 2.6, 0.3); shadow.position.set(tx, MEZZ + 0.006, tz); g.add(shadow);
  }
  const reader = P.makePerson({ hair: 0x8a3b2a, skin: 0xf0cdaa, female: true, polo: ctx.brand.poloHex || 0xb95740 });
  reader.group.position.set(20.5 + Math.cos(0.8) * 1.0, MEZZ, 14.3 + Math.sin(0.8) * 1.0); reader.group.rotation.y = -0.8 + Math.PI / 2 + Math.PI;
  g.add(reader.group); ctx.life.addAgent('reader', reader, {});
  const carpet = new THREE.Mesh(new THREE.PlaneGeometry(6.4, 8.6), new THREE.MeshStandardMaterial({ color: 0x8a3b2a, roughness: 1, transparent: true, opacity: 0.55 }));
  carpet.rotation.x = -Math.PI / 2; carpet.position.set(22, MEZZ + 0.004, 16); g.add(carpet);
  const libLabel = label('Библиотека', 'второй этаж · читальные столы', 1.3); libLabel.position.set(ROOMS.mezz[0] + 0.02, MEZZ + 2.2, 13.2); libLabel.rotation.y = -Math.PI / 2; g.add(libLabel);
  const light2 = new THREE.PointLight(0xfff0dd, 1.0, 10, 1.8); light2.position.set(22, MEZZ + 2.8, 16); g.add(light2);

  scene.add(g);
  ctx.pickable(table, { kind: 'room', id: 'meeting' });
  ctx.pickable(books, { kind: 'room', id: 'library' });
  ctx.itemAnchors.set('meeting', { group: g, camPos: [14.4, LEVEL + 2.2, 17.4], camTgt: [22.5, LEVEL + 0.9, 16.2], walk: [17.6, 14.1], look: [21, 16.3] });
  ctx.itemAnchors.set('library', { group: g, camPos: [17.2, MEZZ + 1.7, 20.1], camTgt: [23.5, MEZZ + 0.9, 14.5], walk: [18.9, 19.9], look: [23, 15.5], floorY: MEZZ });
  ctx.blockers.push({ x0: 17.9, x1: 24.1, z0: 15.4, z1: 17.2, below: 3 });
  ctx.blockers.push({ x0: x1 - 0.6, x1: x1, z0: z0, z1: z1 });
  ctx.blockers.push({ x0: 19.6, x1: 21.4, z0: 13.4, z1: 15.2, above: 3 });
  ctx.blockers.push({ x0: 19.6, x1: 21.4, z0: 17.3, z1: 19.1, above: 3 });
  return { update() {} };
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

function buildReactor(scene, ctx) {
  const [x0, x1, z0, z1] = [-34, -16.2, -11.2, 8];
  const g = new THREE.Group();
  const cx = -25.2, cz = -1.6;
  const wallMat = new THREE.MeshStandardMaterial({ color: 0x14161a, roughness: 0.95 });
  const floorTex = P.canvasTexture(512, 512, (c) => {
    c.fillStyle = '#1b1e24'; c.fillRect(0, 0, 512, 512);
    c.strokeStyle = 'rgba(120,190,255,.18)'; c.lineWidth = 2;
    for (let i = 0; i <= 8; i++) { c.beginPath(); c.moveTo(i * 64, 0); c.lineTo(i * 64, 512); c.stroke(); c.beginPath(); c.moveTo(0, i * 64); c.lineTo(512, i * 64); c.stroke(); }
  });
  floorTex.texture.wrapS = floorTex.texture.wrapT = THREE.RepeatWrapping; floorTex.texture.repeat.set(6, 6);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(x1 - x0, z1 - z0), new THREE.MeshStandardMaterial({ map: floorTex.texture, roughness: 0.4, metalness: 0.3 }));
  floor.rotation.x = -Math.PI / 2; floor.position.set((x0 + x1) / 2, LEVEL + 0.002, (z0 + z1) / 2); g.add(floor);
  g.add(box(0.2, 8, z1 - z0, wallMat, x0, LEVEL + 4, (z0 + z1) / 2));
  g.add(box(x1 - x0, 8, 0.2, wallMat, (x0 + x1) / 2, LEVEL + 4, z0));
  g.add(box(x1 - x0, 8, 0.2, wallMat, (x0 + x1) / 2, LEVEL + 4, z1));
  const roof = new THREE.Mesh(new THREE.PlaneGeometry(x1 - x0, z1 - z0), wallMat);
  roof.rotation.x = Math.PI / 2; roof.position.set((x0 + x1) / 2, LEVEL + 7.2, (z0 + z1) / 2); g.add(roof);
  // приямок с ограждением
  const pit = new THREE.Mesh(new THREE.CylinderGeometry(4.2, 4.2, 1.4, 48, 1, true), new THREE.MeshStandardMaterial({ color: 0x0c0f14, roughness: 0.6, side: THREE.BackSide }));
  pit.position.set(cx, LEVEL - 0.7, cz); g.add(pit);
  const pitFloor = new THREE.Mesh(new THREE.CircleGeometry(4.2, 48), new THREE.MeshStandardMaterial({ color: 0x0a0d12, roughness: 0.5, metalness: 0.4 }));
  pitFloor.rotation.x = -Math.PI / 2; pitFloor.position.set(cx, LEVEL - 1.4, cz); g.add(pitFloor);
  const railRing = new THREE.Mesh(new THREE.TorusGeometry(4.35, 0.03, 8, 64), P.MAT.chrome());
  railRing.rotation.x = Math.PI / 2; railRing.position.set(cx, LEVEL + 1.05, cz); g.add(railRing);
  for (let i = 0; i < 24; i++) { const a = (i / 24) * Math.PI * 2; g.add(box(0.04, 1.05, 0.04, P.MAT.graphite(), cx + Math.cos(a) * 4.35, LEVEL + 0.52, cz + Math.sin(a) * 4.35)); }
  // ядро: светящаяся сфера, каркас, кольца, лучи
  const coreMat = new THREE.MeshStandardMaterial({ color: 0x6fc4f5, emissive: 0x2f9fe8, emissiveIntensity: 1.5, roughness: 0.2 });
  const core = new THREE.Mesh(new THREE.SphereGeometry(1.5, 32, 24), coreMat); core.position.set(cx, LEVEL + 2.2, cz); g.add(core);
  const cage = new THREE.Mesh(new THREE.IcosahedronGeometry(1.9, 1), new THREE.MeshBasicMaterial({ color: 0xbfe6ff, wireframe: true, transparent: true, opacity: 0.35 })); cage.position.copy(core.position); g.add(cage);
  const rings = [];
  [[2.5, 0.4, 0], [3.1, -0.5, 0.6], [3.7, 0.2, -0.8]].forEach(([r, rx, rz]) => {
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
  const glowDisc = new THREE.Mesh(new THREE.CircleGeometry(4.0, 48), new THREE.MeshBasicMaterial({ color: 0x3fa8ff, transparent: true, opacity: 0.25, blending: THREE.AdditiveBlending, depthWrite: false }));
  glowDisc.rotation.x = -Math.PI / 2; glowDisc.position.set(cx, LEVEL - 1.38, cz); g.add(glowDisc);
  // трубопроводы к потолку
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 4.2, 12), P.MAT.brushed());
    pipe.position.set(cx + Math.cos(a) * 1.2, LEVEL + 5.0, cz + Math.sin(a) * 1.2); g.add(pipe);
    const flange = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.1, 12), P.MAT.graphite()); flange.position.set(cx + Math.cos(a) * 1.2, LEVEL + 3.6, cz + Math.sin(a) * 1.2); g.add(flange);
  }
  const l1 = new THREE.PointLight(0x5fbfff, 3.5, 22, 1.5); l1.position.set(cx, LEVEL + 2.4, cz); g.add(l1);
  const l2 = new THREE.PointLight(0x2f6fbf, 1.2, 14, 1.5); l2.position.set(cx, LEVEL + 6.2, cz); g.add(l2);
  // пульт с экраном состояния (макет — надпись об этом прямо на экране)
  const console_ = new THREE.Group();
  const consoleBody = rbox(3.2, 0.9, 0.8, P.MAT.graphite(), 0.03); consoleBody.position.y = LEVEL + 0.45; console_.add(consoleBody);
  const scr = P.canvasTexture(1024, 384, () => {});
  const scrMesh = new THREE.Mesh(new THREE.PlaneGeometry(2.8, 1.05), new THREE.MeshBasicMaterial({ map: scr.texture, toneMapped: false }));
  scrMesh.position.set(0, LEVEL + 1.35, -0.2); scrMesh.rotation.x = -0.35; console_.add(scrMesh);
  console_.position.set(cx, 0, cz + 5.8); g.add(console_);
  const sign = label('Реактор · макет', 'как в павильоне «Атом» на ВДНХ', 1.3, true); sign.position.set(x1 - 0.14, LEVEL + 2.4, 5.4); sign.rotation.y = -Math.PI / 2; g.add(sign);
  scene.add(g);
  ctx.pickable(core, { kind: 'reactor' }); ctx.pickable(console_, { kind: 'reactor' });
  ctx.itemAnchors.set('reactor', { group: g, camPos: [-18.6, LEVEL + 2.2, 4.4], camTgt: [cx, LEVEL + 2.0, cz], walk: [-19.2, 4.6], look: [cx, cz] });
  ctx.blockers.push({ x: cx, z: cz, r: 4.7 });
  ctx.blockers.push({ x0: cx - 1.7, x1: cx + 1.7, z0: cz + 5.3, z1: cz + 6.3 });
  return {
    update(dt, t) {
      rings[0].rotation.y += dt * 0.5; rings[1].rotation.x += dt * 0.35; rings[2].rotation.z += dt * 0.42;
      cage.rotation.y -= dt * 0.15;
      rays.rotation.y += dt * 0.08;
      const pulse = 0.85 + Math.sin(t * 1.6) * 0.15;
      coreMat.emissiveIntensity = 1.5 * pulse; l1.intensity = 3.5 * pulse;
      for (const r of rays.children) r.material.opacity = 0.06 + Math.sin(t * 2 + r.rotation.y * 3) * 0.03;
      if (!this._acc) this._acc = 0;
      this._acc += dt;
      if (this._acc > 0.5) {
        this._acc = 0;
        const c = scr.ctx;
        c.fillStyle = '#06111c'; c.fillRect(0, 0, 1024, 384);
        c.fillStyle = '#7fd0ff'; c.font = '600 44px ui-monospace, monospace'; c.textBaseline = 'top';
        c.fillText('МАКЕТ · ДЕМОНСТРАЦИОННЫЙ КОНТУР', 40, 30);
        c.fillStyle = 'rgba(191,230,255,.8)'; c.font = '36px ui-monospace, monospace';
        c.fillText(`пульс ядра ${(pulse * 100).toFixed(0)} %   кольца 3/3   свет ${(l1.intensity).toFixed(1)}`, 40, 110);
        c.fillText(`t = ${t.toFixed(1)} c   темп. условная 300 K   мощность 0 МВт`, 40, 170);
        c.fillStyle = 'rgba(191,230,255,.5)'; c.font = '28px -apple-system, sans-serif';
        c.fillText('Экспонат воспроизводит образ, а не физику: делить здесь нечего.', 40, 300);
        scr.texture.needsUpdate = true;
      }
    },
  };
}

/* ================= сад за окнами ================= */

function drawGardens(c, w, h, night) {
  const sky = c.createLinearGradient(0, 0, 0, h);
  if (night) { sky.addColorStop(0, '#0a1020'); sky.addColorStop(0.7, '#1a2a44'); sky.addColorStop(1, '#2b3a55'); }
  else { sky.addColorStop(0, '#9fc9e6'); sky.addColorStop(0.65, '#dbe9f0'); sky.addColorStop(1, '#f2e8d8'); }
  c.fillStyle = sky; c.fillRect(0, 0, w, h);
  // дальний город
  c.fillStyle = night ? 'rgba(40,55,80,.9)' : 'rgba(120,140,160,.35)';
  for (let x = 0; x < w; x += 70) { const bh = 80 + ((x * 7919) % 260); c.fillRect(x, h * 0.62 - bh, 52, bh); if (night) { c.fillStyle = 'rgba(255,230,160,.35)'; for (let y = h * 0.62 - bh + 10; y < h * 0.62; y += 22) c.fillRect(x + 8 + (y % 3) * 12, y, 6, 8); c.fillStyle = 'rgba(40,55,80,.9)'; } }
  // купола
  const dome = (dx, dw, dh) => {
    c.save(); c.translate(dx, h * 0.62);
    const gr = c.createLinearGradient(0, -dh, 0, 0);
    gr.addColorStop(0, night ? 'rgba(120,180,230,.35)' : 'rgba(255,255,255,.55)'); gr.addColorStop(1, night ? 'rgba(60,110,170,.35)' : 'rgba(200,225,240,.45)');
    c.fillStyle = gr; c.beginPath(); c.ellipse(0, 0, dw, dh, 0, Math.PI, 0); c.fill();
    c.strokeStyle = night ? 'rgba(190,220,255,.35)' : 'rgba(80,110,140,.35)'; c.lineWidth = 2;
    for (let i = -4; i <= 4; i++) { c.beginPath(); c.ellipse(0, 0, Math.abs(i) * dw / 4.5 + 4, dh, 0, Math.PI, 0); c.stroke(); }
    for (let i = 1; i < 4; i++) { c.beginPath(); c.ellipse(0, 0, dw, dh * i / 4, 0, Math.PI, 0); c.stroke(); }
    c.restore();
  };
  dome(w * 0.22, 420, 260); dome(w * 0.78, 360, 230);
  // супердеревья
  const tree = (tx, th, tw) => {
    const top = h * 0.62 - th;
    c.fillStyle = night ? '#3a2f3f' : '#7a5a6a';
    c.beginPath(); c.moveTo(tx - tw * 0.18, h * 0.64); c.lineTo(tx + tw * 0.18, h * 0.64); c.lineTo(tx + tw * 0.08, top + 40); c.lineTo(tx - tw * 0.08, top + 40); c.closePath(); c.fill();
    c.strokeStyle = night ? 'rgba(255,120,200,.75)' : 'rgba(110,80,110,.8)'; c.lineWidth = 4;
    for (let i = 0; i < 9; i++) { const a = -Math.PI * 0.95 + (i / 8) * Math.PI * 0.9; c.beginPath(); c.moveTo(tx, top + 60); c.quadraticCurveTo(tx + Math.cos(a) * tw * 0.4, top + 10, tx + Math.cos(a) * tw * 0.6, top - 10 + Math.abs(Math.sin(a)) * 30); c.stroke(); }
    c.fillStyle = night ? 'rgba(255,120,200,.28)' : 'rgba(96,160,96,.45)';
    c.beginPath(); c.ellipse(tx, top + 8, tw * 0.62, 34, 0, 0, Math.PI * 2); c.fill();
    if (night) { c.fillStyle = 'rgba(255,200,240,.9)'; for (let i = 0; i < 12; i++) { c.beginPath(); c.arc(tx + (Math.random() - 0.5) * tw, top + 8 + (Math.random() - 0.5) * 40, 3, 0, 7); c.fill(); } }
  };
  [0.08, 0.15, 0.35, 0.44, 0.52, 0.63, 0.88, 0.95].forEach((k, i) => tree(w * k, 360 + (i % 3) * 120, 220 + (i % 2) * 90));
  // связующие мостики
  c.strokeStyle = night ? 'rgba(255,160,220,.5)' : 'rgba(90,70,90,.5)'; c.lineWidth = 6;
  c.beginPath(); c.moveTo(w * 0.35, h * 0.62 - 420); c.quadraticCurveTo(w * 0.44, h * 0.62 - 470, w * 0.52, h * 0.62 - 440); c.stroke();
  // зелень на переднем плане
  c.fillStyle = night ? '#16261c' : '#4f7d58';
  for (let x = 0; x < w; x += 90) { c.beginPath(); c.arc(x + 45, h * 0.66, 70 + (x % 4) * 15, 0, Math.PI * 2); c.fill(); }
  c.fillStyle = night ? '#101a14' : '#3e6b47'; c.fillRect(0, h * 0.7, w, h * 0.3);
}

function buildGardens(scene, ctx) {
  const day = P.canvasTexture(4096, 1536, (c, w, h) => drawGardens(c, w, h, false));
  const night = P.canvasTexture(4096, 1536, (c, w, h) => drawGardens(c, w, h, true));
  const planes = [];
  for (const side of [-1, 1]) {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(90, 34), new THREE.MeshBasicMaterial({ map: day.texture, toneMapped: false }));
    m.position.set(side * 52, 12, 4); m.rotation.y = side < 0 ? Math.PI / 2 : -Math.PI / 2;
    scene.add(m); planes.push(m);
  }
  return { setDark(dark) { for (const m of planes) { m.material.map = dark ? night.texture : day.texture; m.material.needsUpdate = true; } }, update() {} };
}

/* ================= сборка ================= */

export function buildWings(scene, ctx) {
  const parts = [buildAquarium(scene, ctx), buildMeetingAndLibrary(scene, ctx), buildGarage(scene, ctx), buildReactor(scene, ctx)];
  const gardens = buildGardens(scene, ctx);
  parts.push(gardens);
  return {
    update(dt, t) { for (const p of parts) p.update(dt, t); },
    setDark(dark) { gardens.setDark(dark); },
  };
}
