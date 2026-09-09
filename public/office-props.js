'use strict';
/**
 * Фабрика предметов зала: столы-капсулы, мониторы, клавиатуры, мыши, кресла,
 * люди с суставами, растения, постеры, мелочи на столах.
 *
 * Всё процедурное: примитивы + RoundedBox + канвы. Пропорции — по золотому
 * сечению (φ = 1.618): рамы постеров, столешницы, экраны.
 */

import * as THREE from './vendor/three.module.min.js';
import { RoundedBoxGeometry } from './vendor/RoundedBoxGeometry.js';
import { mergeGeometries } from './vendor/BufferGeometryUtils.js';

export const PHI = 1.618;

/* ---------- материалы ---------- */

export function std(color, opts = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.02, ...opts });
}

export const MAT = {
  white: () => std(0xf6f2ea, { roughness: 0.45 }),
  whiteGloss: () => new THREE.MeshPhysicalMaterial({ color: 0xfaf7f1, roughness: 0.35, metalness: 0.02, clearcoat: 0.4, clearcoatRoughness: 0.2 }),
  ink: () => std(0x26211b, { roughness: 0.6, metalness: 0.05 }),
  black: () => std(0x1c1b1a, { roughness: 0.5 }),
  blackGloss: () => std(0x141414, { roughness: 0.2, metalness: 0.3 }),
  graphite: () => std(0x2e2e30, { roughness: 0.55, metalness: 0.1 }),
  chrome: () => std(0xd8d8dc, { roughness: 0.18, metalness: 0.9 }),
  brushed: () => std(0xb9b9be, { roughness: 0.4, metalness: 0.8 }),
  terracotta: () => std(0xb95740, { roughness: 0.55 }),
  walnut: () => std(0x5a3f2c, { roughness: 0.5 }),
  leaf: () => std(0x3e7a4a, { roughness: 0.7, side: THREE.DoubleSide }),
  leafDark: () => std(0x2f5f3a, { roughness: 0.75, side: THREE.DoubleSide }),
  pot: () => std(0xefe9dd, { roughness: 0.6 }),
  glass: () => new THREE.MeshPhysicalMaterial({ color: 0xdfe9ee, transmission: 0.55, roughness: 0.08, thickness: 0.02, transparent: true, opacity: 0.55 }),
};

/* ---------- канва ---------- */

export function canvasTexture(w, h, draw) {
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  draw(ctx, w, h);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  return { canvas, ctx, texture };
}

/** паркет: доски с тёплым дубом и лёгким шумом */
export function woodTexture(size = 1024) {
  const { texture } = canvasTexture(size, size, (c) => {
    c.fillStyle = '#c9ad84';
    c.fillRect(0, 0, size, size);
    const rows = 12;
    const h = size / rows;
    for (let r = 0; r < rows; r++) {
      const off = (r % 2) * size * 0.37;
      for (let k = -1; k < 3; k++) {
        const x = off + k * size * 0.5;
        const w = size * 0.5 - 4;
        const tone = 190 + Math.round(Math.random() * 28);
        c.fillStyle = `rgb(${tone},${tone - 30},${tone - 68})`;
        c.fillRect(x, r * h + 1, w, h - 2);
        // волокна
        c.strokeStyle = 'rgba(90,60,30,.10)';
        for (let i = 0; i < 6; i++) {
          c.beginPath();
          const y = r * h + 4 + Math.random() * (h - 8);
          c.moveTo(x, y); c.bezierCurveTo(x + w * 0.3, y + 3, x + w * 0.6, y - 3, x + w, y + 1);
          c.stroke();
        }
      }
    }
  });
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(6, 6);
  return texture;
}

/* ---------- стол-капсула ---------- */

/**
 * Белый стол с закруглённой столешницей, изогнутым экраном-перегородкой и
 * тумбой — как на фото. Ширина 1.7 = φ × глубина 1.05.
 */
export function makeDeskPod() {
  const g = new THREE.Group();
  const top = new THREE.Mesh(new RoundedBoxGeometry(1.7, 0.05, 0.9, 4, 0.03), MAT.whiteGloss());
  top.position.y = 0.745;
  top.castShadow = true; top.receiveShadow = true;
  g.add(top);
  const under = new THREE.Mesh(new RoundedBoxGeometry(1.6, 0.03, 0.8, 2, 0.01), std(0xe6dfd2));
  under.position.y = 0.705;
  g.add(under);
  // тумба
  const base = new THREE.Mesh(new RoundedBoxGeometry(0.52, 0.68, 0.5, 3, 0.03), MAT.white());
  base.position.set(0.45, 0.34, 0.05);
  base.castShadow = true;
  g.add(base);
  const drawer = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.012, 0.01), MAT.brushed());
  drawer.position.set(0.45, 0.5, 0.31);
  g.add(drawer);
  const legMat = MAT.brushed();
  for (const sx of [-0.7, -0.2]) {
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.7, 10), legMat);
    leg.position.set(sx, 0.35, -0.25);
    g.add(leg);
    const leg2 = leg.clone(); leg2.position.z = 0.28; g.add(leg2);
  }
  // изогнутая перегородка (белая, матовая) с тонкой световой полосой
  const panel = new THREE.Mesh(
    new THREE.CylinderGeometry(1.15, 1.15, 0.42, 20, 1, true, Math.PI - 0.8, 1.6),
    std(0xf4efe6, { side: THREE.DoubleSide, roughness: 0.5 }),
  );
  panel.position.set(0, 0.95, 0.6);
  g.add(panel);
  const strip = new THREE.Mesh(
    new THREE.CylinderGeometry(1.152, 1.152, 0.012, 20, 1, true, Math.PI - 0.8, 1.6),
    new THREE.MeshBasicMaterial({ color: 0xfff3e6, side: THREE.DoubleSide }),
  );
  strip.position.set(0, 1.17, 0.6);
  g.add(strip);
  strip.userData.ledStrip = true;
  return g;
}

/* ---------- монитор 32:9 ---------- */

export function makeMonitor({ texture = null, off = 0x0e1218 } = {}) {
  const g = new THREE.Group();
  const R = 0.8;
  const arc = 1.08;
  // корпус
  const shell = new THREE.Mesh(
    new THREE.CylinderGeometry(R + 0.012, R + 0.012, 0.36, 24, 1, true, Math.PI - arc / 2, arc),
    MAT.graphite(),
  );
  g.add(shell);
  // рамка
  const bezel = new THREE.Mesh(
    new THREE.CylinderGeometry(R + 0.002, R + 0.002, 0.355, 24, 1, true, Math.PI - arc / 2, arc),
    new THREE.MeshStandardMaterial({ color: 0x0a0a0c, roughness: 0.3, side: THREE.BackSide }),
  );
  g.add(bezel);
  // панель
  let mat;
  if (texture) {
    texture.wrapS = THREE.RepeatWrapping; texture.repeat.x = -1;
    mat = new THREE.MeshBasicMaterial({ map: texture, side: THREE.BackSide, toneMapped: false });
  } else {
    mat = new THREE.MeshStandardMaterial({ color: off, roughness: 0.15, metalness: 0.2, side: THREE.BackSide });
  }
  const panel = new THREE.Mesh(
    new THREE.CylinderGeometry(R, R, 0.335, 24, 1, true, Math.PI - arc / 2 + 0.02, arc - 0.04),
    mat,
  );
  g.add(panel);
  // подсветка сзади (ambient light bar)
  const glow = new THREE.Mesh(
    new THREE.CylinderGeometry(R + 0.02, R + 0.02, 0.02, 24, 1, true, Math.PI - arc / 2 + 0.1, arc - 0.2),
    new THREE.MeshBasicMaterial({ color: 0xb95740, transparent: true, opacity: 0.5 }),
  );
  glow.position.y = -0.19;
  g.add(glow);
  // стойка и подошва
  const neck = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.26, 0.04), MAT.graphite());
  neck.position.set(0, -0.3, -R + 0.03);
  g.add(neck);
  const foot = new THREE.Mesh(new RoundedBoxGeometry(0.42, 0.018, 0.22, 2, 0.008), MAT.graphite());
  foot.position.set(0, -0.43, -R + 0.08);
  g.add(foot);
  g.position.set(0, 0, 0);
  g.userData.panel = panel;
  return g;
}

/* ---------- клавиатура MX Keys ---------- */

const KEY_ROWS = [
  [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
  [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2],
  [1.5, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1.5],
  [1.8, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2.2],
  [2.3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2.7],
  [1.2, 1.2, 1.2, 6.2, 1.2, 1.2, 1.2, 1.2],
];

export function makeKeyboard() {
  const g = new THREE.Group();
  const w = 0.43, d = 0.135;
  const slab = new THREE.Mesh(new RoundedBoxGeometry(w, 0.012, d, 2, 0.004), MAT.graphite());
  slab.position.y = 0.006;
  slab.rotation.x = -0.03;
  g.add(slab);
  const keyGeo = new RoundedBoxGeometry(0.0155, 0.004, 0.0155, 1, 0.002);
  const keyMat = new THREE.MeshStandardMaterial({ color: 0x3a3a3d, roughness: 0.6, emissive: 0xffffff, emissiveIntensity: 0.06 });
  let count = 0;
  for (const r of KEY_ROWS) count += r.length;
  const inst = new THREE.InstancedMesh(keyGeo, keyMat, count);
  const m = new THREE.Matrix4();
  const unit = 0.0185;
  let i = 0;
  KEY_ROWS.forEach((row, ri) => {
    let x = -w / 2 + 0.014;
    const z = -d / 2 + 0.014 + ri * unit;
    for (const kw of row) {
      const kx = x + (kw * unit) / 2 - unit / 2;
      m.makeScale(kw * 0.95, 1, 1);
      m.setPosition(kx, 0.014, z);
      inst.setMatrixAt(i++, m);
      x += kw * unit;
    }
  });
  inst.instanceMatrix.needsUpdate = true;
  g.add(inst);
  return g;
}

/* ---------- мышь MX Master ---------- */

export function makeMouse() {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.SphereGeometry(0.036, 18, 14), MAT.graphite());
  body.scale.set(0.9, 0.55, 1.5);
  body.position.y = 0.02;
  g.add(body);
  const thumb = new THREE.Mesh(new THREE.SphereGeometry(0.02, 12, 10), MAT.graphite());
  thumb.scale.set(1.2, 0.5, 1.4);
  thumb.position.set(-0.035, 0.012, 0.005);
  g.add(thumb);
  const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, 0.008, 12), MAT.brushed());
  wheel.rotation.z = Math.PI / 2;
  wheel.position.set(0, 0.041, -0.018);
  g.add(wheel);
  return g;
}

/* ---------- кресло ---------- */

export function makeChair() {
  const g = new THREE.Group();
  const shellMat = MAT.whiteGloss();
  const seat = new THREE.Mesh(new RoundedBoxGeometry(0.5, 0.07, 0.48, 3, 0.03), shellMat);
  seat.position.y = 0.46;
  seat.castShadow = true;
  g.add(seat);
  const back = new THREE.Mesh(
    new THREE.CylinderGeometry(0.34, 0.34, 0.58, 24, 1, true, Math.PI - 0.75, 1.5),
    std(0xf6f2ea, { side: THREE.DoubleSide, roughness: 0.4 }),
  );
  back.position.set(0, 0.8, 0.28);
  g.add(back);
  const cushion = new THREE.Mesh(new RoundedBoxGeometry(0.42, 0.04, 0.4, 2, 0.02), std(0xd8cfbf, { roughness: 0.8 }));
  cushion.position.y = 0.5;
  g.add(cushion);
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.03, 0.34, 10), MAT.chrome());
  pole.position.y = 0.26;
  g.add(pole);
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.02, 0.04), MAT.chrome());
    arm.position.set(Math.cos(a) * 0.15, 0.06, Math.sin(a) * 0.15);
    arm.rotation.y = -a;
    g.add(arm);
    const wheel = new THREE.Mesh(new THREE.SphereGeometry(0.03, 10, 8), MAT.black());
    wheel.position.set(Math.cos(a) * 0.29, 0.03, Math.sin(a) * 0.29);
    g.add(wheel);
  }
  return g;
}

/* ---------- мелочи на столе ---------- */

export function makeMug(ringColor = 0xb95740) {
  const g = new THREE.Group();
  const cup = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.034, 0.095, 18, 1, true), std(0xfaf7f0, { side: THREE.DoubleSide, roughness: 0.35 }));
  cup.position.y = 0.0475;
  g.add(cup);
  const bottom = new THREE.Mesh(new THREE.CircleGeometry(0.034, 18), std(0xfaf7f0));
  bottom.rotation.x = -Math.PI / 2; bottom.position.y = 0.001;
  g.add(bottom);
  const coffee = new THREE.Mesh(new THREE.CircleGeometry(0.037, 18), std(0x3b2418, { roughness: 0.2 }));
  coffee.rotation.x = -Math.PI / 2; coffee.position.y = 0.08;
  g.add(coffee);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.041, 0.004, 8, 24), std(ringColor));
  ring.rotation.x = Math.PI / 2; ring.position.y = 0.09;
  g.add(ring);
  const handle = new THREE.Mesh(new THREE.TorusGeometry(0.022, 0.006, 8, 16, Math.PI), std(0xfaf7f0));
  handle.position.set(0.045, 0.05, 0);
  handle.rotation.y = Math.PI / 2; handle.rotation.z = -Math.PI / 2;
  g.add(handle);
  return g;
}

export function makeNotebook(color = 0xb95740) {
  const g = new THREE.Group();
  const book = new THREE.Mesh(new RoundedBoxGeometry(0.15, 0.014, 0.21, 2, 0.004), std(color, { roughness: 0.7 }));
  book.position.y = 0.007;
  g.add(book);
  const band = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.016, 0.21), MAT.black());
  band.position.set(0.05, 0.007, 0);
  g.add(band);
  // тиснение ENSO
  const { texture } = canvasTexture(256, 128, (c) => {
    c.clearRect(0, 0, 256, 128);
    c.fillStyle = 'rgba(0,0,0,.28)';
    c.font = '600 44px Georgia, serif'; c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillText('ENSO', 128, 64);
  });
  const emboss = new THREE.Mesh(new THREE.PlaneGeometry(0.1, 0.05), new THREE.MeshBasicMaterial({ map: texture, transparent: true }));
  emboss.rotation.x = -Math.PI / 2;
  emboss.position.set(-0.01, 0.0145, 0.02);
  g.add(emboss);
  return g;
}

export function makePen() {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.0045, 0.0045, 0.14, 8), MAT.blackGloss());
  body.rotation.z = Math.PI / 2;
  g.add(body);
  const clip = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.002, 0.003), MAT.chrome());
  clip.position.set(0.04, 0.005, 0);
  g.add(clip);
  const tip = new THREE.Mesh(new THREE.ConeGeometry(0.0045, 0.012, 8), MAT.chrome());
  tip.rotation.z = Math.PI / 2; tip.position.x = -0.075;
  g.add(tip);
  return g;
}

/** Perfect Pencil: карандаш с серебряным колпачком-удлинителем */
export function makePerfectPencil() {
  const g = new THREE.Group();
  const wood = new THREE.Mesh(new THREE.CylinderGeometry(0.0038, 0.0038, 0.1, 6), std(0x8b5a2b));
  wood.rotation.z = Math.PI / 2;
  g.add(wood);
  const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.0046, 0.0046, 0.06, 10), MAT.chrome());
  cap.rotation.z = Math.PI / 2; cap.position.x = 0.075;
  g.add(cap);
  const tip = new THREE.Mesh(new THREE.ConeGeometry(0.0038, 0.014, 8), std(0xd9b88c));
  tip.rotation.z = Math.PI / 2; tip.position.x = -0.057;
  g.add(tip);
  return g;
}

export function makePhone() {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new RoundedBoxGeometry(0.07, 0.008, 0.145, 2, 0.006), MAT.blackGloss());
  body.position.y = 0.004;
  g.add(body);
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.062, 0.135), new THREE.MeshBasicMaterial({ color: 0x0b0d10 }));
  screen.rotation.x = -Math.PI / 2; screen.position.y = 0.0085;
  g.add(screen);
  g.userData.screen = screen;
  return g;
}

/* ---------- растения ---------- */

function leafShape(len, wid, holes = false) {
  const s = new THREE.Shape();
  s.moveTo(0, 0);
  s.bezierCurveTo(wid * 0.9, len * 0.15, wid, len * 0.7, 0, len);
  s.bezierCurveTo(-wid, len * 0.7, -wid * 0.9, len * 0.15, 0, 0);
  if (holes) {
    for (const [hx, hy, r] of [[wid * 0.35, len * 0.45, wid * 0.16], [-wid * 0.3, len * 0.6, wid * 0.13], [wid * 0.2, len * 0.75, wid * 0.1]]) {
      const h = new THREE.Path();
      h.absellipse(hx, hy, r, r * 1.6, 0, Math.PI * 2, true);
      s.holes.push(h);
    }
  }
  return s;
}

/** монстера в белом горшке; листья — ShapeGeometry с прорезями */
export function makeMonstera(scale = 1) {
  const g = new THREE.Group();
  const pot = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.17, 0.42, 24), MAT.pot());
  pot.position.y = 0.21;
  pot.castShadow = true;
  g.add(pot);
  const soil = new THREE.Mesh(new THREE.CircleGeometry(0.2, 24), std(0x3a2b1f, { roughness: 1 }));
  soil.rotation.x = -Math.PI / 2; soil.position.y = 0.41;
  g.add(soil);
  const leaves = new THREE.Group();
  const geo = new THREE.ShapeGeometry(leafShape(0.42, 0.17, true), 12);
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2 + 0.3;
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.012, 0.6 + (i % 3) * 0.15, 6), MAT.leafDark());
    const h = 0.6 + (i % 3) * 0.15;
    stem.position.set(Math.cos(a) * 0.05, 0.41 + h / 2, Math.sin(a) * 0.05);
    stem.rotation.z = Math.cos(a) * 0.35;
    stem.rotation.x = -Math.sin(a) * 0.35;
    leaves.add(stem);
    const leaf = new THREE.Mesh(geo, i % 2 ? MAT.leaf() : MAT.leafDark());
    leaf.position.set(Math.cos(a) * 0.28, 0.41 + h * 0.92, Math.sin(a) * 0.28);
    leaf.rotation.y = -a + Math.PI / 2;
    leaf.rotation.x = -0.9 - (i % 2) * 0.25;
    leaf.userData.sway = { phase: i * 0.9, amp: 0.05 };
    leaves.add(leaf);
  }
  g.add(leaves);
  g.userData.leaves = leaves;
  g.scale.setScalar(scale);
  finishPlant(g, 0.05);
  return g;
}

/** фикус: изогнутый ствол и крона из 60 инстансов-икосаэдров трёх оттенков */
export function makeFicus(scale = 1) {
  const g = new THREE.Group();
  const pot = new THREE.Mesh(new THREE.CylinderGeometry(0.19, 0.15, 0.36, 20), new THREE.MeshPhysicalMaterial({ color: 0xf3efe6, roughness: 0.5, clearcoat: 0.5 }));
  pot.position.y = 0.18;
  g.add(pot);
  const band = new THREE.Mesh(new THREE.CylinderGeometry(0.192, 0.192, 0.03, 20), std(0xb95740));
  band.position.y = 0.3; g.add(band);
  const curve = new THREE.CatmullRomCurve3([new THREE.Vector3(0, 0.34, 0), new THREE.Vector3(0.04, 0.7, 0.02), new THREE.Vector3(-0.03, 1.0, -0.03), new THREE.Vector3(0.02, 1.25, 0.02)]);
  const trunk = new THREE.Mesh(new THREE.TubeGeometry(curve, 12, 0.025, 7, false), std(0x6b4a33, { roughness: 0.9 }));
  g.add(trunk);
  const cols = [0x3f6b3b, 0x4e7a4a, 0x6a9a5c];
  const geo = new THREE.IcosahedronGeometry(0.11, 1);
  const inst = new THREE.InstancedMesh(geo, std(0x4e7a4a, { roughness: 0.85 }), 60);
  const m = new THREE.Matrix4(); const col = new THREE.Color();
  for (let i = 0; i < 60; i++) {
    const a = i * 2.399, rr = 0.1 + Math.random() * 0.3, y = 0.95 + Math.random() * 0.55;
    const sc = 0.6 + Math.random() * 0.8;
    m.makeScale(sc, sc * 0.9, sc);
    m.setPosition(Math.cos(a) * rr, y, Math.sin(a) * rr);
    inst.setMatrixAt(i, m);
    inst.setColorAt(i, col.set(cols[i % 3]));
  }
  inst.instanceMatrix.needsUpdate = true;
  inst.userData.keep = true;
  g.add(inst);
  g.scale.setScalar(scale);
  g.userData.sway = { phase: Math.random() * 6, amp: 0.02 };
  return g;
}

/** свисающий потос для перил галереи */
export function makeTrailingPlant(length = 1.2) {
  const g = new THREE.Group();
  const pot = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.1, 0.16, 16), MAT.pot());
  g.add(pot);
  const geo = new THREE.ShapeGeometry(leafShape(0.09, 0.05), 6);
  for (let v = 0; v < 3; v++) {
    const vine = new THREE.Group();
    const ang = v * 2.1;
    for (let i = 0; i < 9; i++) {
      const leaf = new THREE.Mesh(geo, i % 2 ? MAT.leaf() : MAT.leafDark());
      const t = i / 9;
      leaf.position.set(Math.cos(ang) * (0.08 + t * 0.12), -t * length, Math.sin(ang) * (0.08 + t * 0.12));
      leaf.rotation.set(Math.PI / 2 + (i % 2) * 0.5, ang + i * 0.7, 0);
      leaf.userData.sway = { phase: i + v, amp: 0.08 };
      vine.add(leaf);
    }
    g.add(vine);
  }
  finishPlant(g, 0.06);
  return g;
}

/**
 * Растение после сборки: десятки листьев → по одному мешу на материал,
 * качание переносится на всю крону (userData.sway на группе). Слитые меши
 * помечаются keep, чтобы слияние стола их не поглотило.
 */
function finishPlant(g, amp) {
  g.traverse((m) => { delete m.userData.sway; });
  mergeStatic(g);
  g.traverse((m) => { if (m.isMesh) m.userData.keep = true; });
  g.userData.sway = { phase: Math.random() * 6, amp };
  return g;
}

/* ---------- контактная тень ---------- */

let _shadowTex = null;
/** мягкое тёмное пятно под предметом: радиальный градиент, без записи глубины */
export function makeContactShadow(w, d, opacity = 0.35) {
  if (!_shadowTex) {
    _shadowTex = canvasTexture(128, 128, (c) => {
      const g = c.createRadialGradient(64, 64, 6, 64, 64, 62);
      g.addColorStop(0, 'rgba(38,33,27,1)'); g.addColorStop(1, 'rgba(38,33,27,0)');
      c.fillStyle = g; c.fillRect(0, 0, 128, 128);
    }).texture;
  }
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d), new THREE.MeshBasicMaterial({ map: _shadowTex, transparent: true, opacity, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 }));
  m.rotation.x = -Math.PI / 2;
  m.position.y = 0.006;
  m.userData.keep = true;
  return m;
}

/* ---------- постеры ---------- */

/** серия «Механика»: чёрный фон, красная рама, белая линейная графика */
export function drawMechanicalPoster(c, w, h, kind) {
  c.fillStyle = '#0b0b0c';
  c.fillRect(0, 0, w, h);
  c.strokeStyle = '#c8362a'; c.lineWidth = w * 0.018;
  c.strokeRect(w * 0.035, h * 0.035, w * 0.93, h * 0.93);
  c.strokeStyle = 'rgba(200,54,42,.35)'; c.lineWidth = 2;
  c.strokeRect(w * 0.06, h * 0.06, w * 0.88, h * 0.88);
  // композиция: центр предмета — в точке золотого сечения
  const cx = w * 0.618, cy = h * 0.382;
  c.strokeStyle = '#f3efe6'; c.lineWidth = w * 0.006; c.lineCap = 'round';
  const gear = (x, y, r, teeth, rot = 0) => {
    c.beginPath();
    for (let i = 0; i < teeth * 2; i++) {
      const a = rot + (i / (teeth * 2)) * Math.PI * 2;
      const rr = i % 2 ? r : r * 1.16;
      const px = x + Math.cos(a) * rr, py = y + Math.sin(a) * rr;
      if (i) c.lineTo(px, py); else c.moveTo(px, py);
    }
    c.closePath(); c.stroke();
    c.beginPath(); c.arc(x, y, r * 0.55, 0, Math.PI * 2); c.stroke();
    c.beginPath(); c.arc(x, y, r * 0.14, 0, Math.PI * 2); c.stroke();
    for (let i = 0; i < 6; i++) {
      const a = rot + (i / 6) * Math.PI * 2;
      c.beginPath(); c.moveTo(x + Math.cos(a) * r * 0.16, y + Math.sin(a) * r * 0.16);
      c.lineTo(x + Math.cos(a) * r * 0.52, y + Math.sin(a) * r * 0.52); c.stroke();
    }
  };
  if (kind === 'gears') {
    gear(cx, cy, w * 0.17, 14);
    gear(cx - w * 0.29, cy + h * 0.16, w * 0.1, 9, 0.2);
    gear(cx + w * 0.08, cy + h * 0.27, w * 0.07, 7, 0.4);
  } else if (kind === 'bearing') {
    for (const r of [0.27, 0.22, 0.13, 0.08]) { c.beginPath(); c.arc(cx, cy + h * 0.1, w * r, 0, Math.PI * 2); c.stroke(); }
    for (let i = 0; i < 11; i++) {
      const a = (i / 11) * Math.PI * 2;
      c.beginPath(); c.arc(cx + Math.cos(a) * w * 0.175, cy + h * 0.1 + Math.sin(a) * w * 0.175, w * 0.04, 0, Math.PI * 2); c.stroke();
    }
  } else if (kind === 'turbine') {
    for (let i = 0; i < 9; i++) {
      const a = (i / 9) * Math.PI * 2;
      c.beginPath();
      c.moveTo(cx + Math.cos(a) * w * 0.06, cy + h * 0.1 + Math.sin(a) * w * 0.06);
      c.quadraticCurveTo(cx + Math.cos(a + 0.5) * w * 0.2, cy + h * 0.1 + Math.sin(a + 0.5) * w * 0.2, cx + Math.cos(a + 0.9) * w * 0.3, cy + h * 0.1 + Math.sin(a + 0.9) * w * 0.3);
      c.stroke();
    }
    c.beginPath(); c.arc(cx, cy + h * 0.1, w * 0.06, 0, Math.PI * 2); c.stroke();
  } else {
    // клапан в разрезе
    c.strokeRect(cx - w * 0.2, cy - h * 0.05, w * 0.4, h * 0.22);
    c.beginPath(); c.moveTo(cx, cy - h * 0.05); c.lineTo(cx, cy - h * 0.2); c.stroke();
    c.beginPath(); c.arc(cx, cy - h * 0.22, w * 0.07, 0, Math.PI * 2); c.stroke();
    c.beginPath(); c.moveTo(cx - w * 0.2, cy + h * 0.06); c.lineTo(cx + w * 0.2, cy + h * 0.06); c.stroke();
    for (let i = -3; i <= 3; i++) { c.beginPath(); c.moveTo(cx + i * w * 0.05, cy + h * 0.06); c.lineTo(cx + i * w * 0.05 + w * 0.03, cy + h * 0.17); c.stroke(); }
  }
  // подписи: номер серии и название — типографика внизу слева (φ-отступ)
  c.fillStyle = '#f3efe6';
  c.font = `600 ${Math.round(w * 0.055)}px -apple-system, "Helvetica Neue", sans-serif`;
  c.textAlign = 'left'; c.textBaseline = 'alphabetic';
  const titles = { gears: 'ЗУБЧАТАЯ ПЕРЕДАЧА', bearing: 'РАДИАЛЬНЫЙ ПОДШИПНИК', turbine: 'РАБОЧЕЕ КОЛЕСО', valve: 'ЗАПОРНЫЙ КЛАПАН' };
  c.fillText(titles[kind] || kind.toUpperCase(), w * 0.1, h * 0.82);
  c.fillStyle = '#c8362a';
  c.font = `${Math.round(w * 0.034)}px ui-monospace, monospace`;
  c.fillText(`ENSO-ENGINEERING · МЕХАНИКА ${({ gears: '01', bearing: '02', turbine: '03', valve: '04' })[kind] || ''}`, w * 0.1, h * 0.88);
}

/** серия «Кодекс»: сепия, коричневая тушь, зеркальные подписи в духе Леонардо */
export function drawCodexPoster(c, w, h, kind) {
  const grad = c.createLinearGradient(0, 0, w, h);
  grad.addColorStop(0, '#e8d9b5'); grad.addColorStop(1, '#d9c497');
  c.fillStyle = grad; c.fillRect(0, 0, w, h);
  // пятна старой бумаги
  for (let i = 0; i < 40; i++) {
    c.fillStyle = `rgba(120,80,30,${0.02 + Math.random() * 0.04})`;
    c.beginPath(); c.arc(Math.random() * w, Math.random() * h, 10 + Math.random() * 60, 0, Math.PI * 2); c.fill();
  }
  c.strokeStyle = '#5b3a1e'; c.lineWidth = w * 0.004; c.lineCap = 'round'; c.lineJoin = 'round';
  const cx = w * 0.382, cy = h * 0.5;
  if (kind === 'crane') {
    c.beginPath(); c.moveTo(w * 0.15, h * 0.8); c.lineTo(w * 0.15, h * 0.25); c.lineTo(w * 0.62, h * 0.4); c.stroke();
    c.beginPath(); c.moveTo(w * 0.15, h * 0.5); c.lineTo(w * 0.45, h * 0.36); c.stroke();
    c.beginPath(); c.moveTo(w * 0.62, h * 0.4); c.lineTo(w * 0.62, h * 0.62); c.stroke();
    c.strokeRect(w * 0.56, h * 0.62, w * 0.12, h * 0.1);
    c.beginPath(); c.arc(w * 0.15, h * 0.8, w * 0.06, 0, Math.PI * 2); c.stroke();
    c.beginPath(); c.arc(w * 0.15, h * 0.8, w * 0.02, 0, Math.PI * 2); c.stroke();
  } else if (kind === 'arch') {
    c.beginPath(); c.arc(cx + w * 0.1, cy + h * 0.1, w * 0.26, Math.PI, 0); c.stroke();
    c.beginPath(); c.arc(cx + w * 0.1, cy + h * 0.1, w * 0.19, Math.PI, 0); c.stroke();
    for (let i = 0; i <= 8; i++) {
      const a = Math.PI + (i / 8) * Math.PI;
      c.beginPath(); c.moveTo(cx + w * 0.1 + Math.cos(a) * w * 0.19, cy + h * 0.1 + Math.sin(a) * w * 0.19);
      c.lineTo(cx + w * 0.1 + Math.cos(a) * w * 0.26, cy + h * 0.1 + Math.sin(a) * w * 0.26); c.stroke();
    }
    c.beginPath(); c.moveTo(cx - w * 0.16, cy + h * 0.1); c.lineTo(cx - w * 0.16, cy + h * 0.32); c.moveTo(cx + w * 0.36, cy + h * 0.1); c.lineTo(cx + w * 0.36, cy + h * 0.32); c.stroke();
  } else {
    // зубчатая пара с червяком
    const gear = (x, y, r, n) => {
      c.beginPath();
      for (let i = 0; i < n * 2; i++) {
        const a = (i / (n * 2)) * Math.PI * 2; const rr = i % 2 ? r : r * 1.14;
        const px = x + Math.cos(a) * rr, py = y + Math.sin(a) * rr; if (i) c.lineTo(px, py); else c.moveTo(px, py);
      }
      c.closePath(); c.stroke();
      c.beginPath(); c.arc(x, y, r * 0.2, 0, Math.PI * 2); c.stroke();
    };
    gear(cx, cy, w * 0.16, 12); gear(cx + w * 0.34, cy - h * 0.08, w * 0.11, 8);
    for (let i = 0; i < 7; i++) { c.beginPath(); c.ellipse(cx + w * 0.2, cy + h * 0.25 + i * h * 0.03, w * 0.08, h * 0.012, 0, 0, Math.PI * 2); c.stroke(); }
  }
  // зеркальные заметки — как в тетрадях Леонардо
  c.save();
  c.translate(w, 0); c.scale(-1, 1);
  c.fillStyle = 'rgba(80,50,20,.75)';
  c.font = `italic ${Math.round(w * 0.028)}px Georgia, serif`;
  const notes = { crane: ['подъёмный кран с противовесом', 'усилие плеча — как φ к единице'], arch: ['арка держит сама себя', 'два слабых, сложенные, дают одно сильное'], gear: ['червяк и колесо', 'один оборот — один зуб'] };
  (notes[kind] || ['']).forEach((t, i) => c.fillText(t, w * 0.08, h * 0.12 + i * h * 0.05));
  c.restore();
  c.fillStyle = 'rgba(80,50,20,.6)';
  c.font = `${Math.round(w * 0.026)}px Georgia, serif`;
  c.textAlign = 'right';
  c.fillText(`Кодекс ENSO · лист ${({ crane: 'I', arch: 'II', gear: 'III' })[kind] || ''}`, w * 0.92, h * 0.93);
}

/**
 * Рама постера в пропорции φ: ширина w, высота w × φ (портрет).
 * frame: 'red' — тонкая красная металлическая, 'walnut' — дерево.
 */
export function makePoster({ width = 0.8, draw, frame = 'red', pickInfo = null } = {}) {
  const height = width * PHI;
  const g = new THREE.Group();
  const { texture } = canvasTexture(512, Math.round(512 * PHI), draw);
  const art = new THREE.Mesh(new THREE.PlaneGeometry(width, height), new THREE.MeshBasicMaterial({ map: texture, toneMapped: false }));
  art.position.z = 0.012;
  g.add(art);
  const fmat = frame === 'red' ? std(0xa93e2c, { roughness: 0.35, metalness: 0.4 }) : MAT.walnut();
  const t = 0.03;
  for (const [x, y, w2, h2] of [[0, height / 2 + t / 2, width + t * 2, t], [0, -height / 2 - t / 2, width + t * 2, t], [-width / 2 - t / 2, 0, t, height], [width / 2 + t / 2, 0, t, height]]) {
    const bar = new THREE.Mesh(new THREE.BoxGeometry(w2, h2, 0.03), fmat);
    bar.position.set(x, y, 0.005);
    g.add(bar);
  }
  const back = new THREE.Mesh(new THREE.PlaneGeometry(width + t * 2, height + t * 2), std(0x111111));
  back.position.z = -0.01;
  g.add(back);
  if (pickInfo) g.traverse((m) => { m.userData.pick = pickInfo; });
  return g;
}

/* ---------- люди ---------- */

/**
 * Человек с суставами: шея, плечи, локти, бёдра, колени.
 * Возвращает риг с именованными узлами для анимации.
 */
export function makePerson({ skin = 0xe8c39e, hair = 0x3a2a20, glasses = false, polo = 0xb95740, trousers = 0x2b2622, female = false, standing = false } = {}) {
  const g = new THREE.Group();
  const skinMat = std(skin, { roughness: 0.65 });
  const poloMat = new THREE.MeshPhysicalMaterial({ color: polo, roughness: 0.85, sheen: 0.6, sheenColor: new THREE.Color(0xe8a58c), sheenRoughness: 0.8 });
  const pantMat = std(trousers, { roughness: 0.85 });

  const hips = new THREE.Group();
  hips.position.y = standing ? 0.92 : 0.5;
  g.add(hips);

  // торс
  const torso = new THREE.Mesh(new RoundedBoxGeometry(female ? 0.3 : 0.36, 0.5, 0.2, 4, 0.08), poloMat);
  torso.position.y = 0.3;
  torso.castShadow = true;
  hips.add(torso);
  const collar = new THREE.Mesh(new THREE.TorusGeometry(0.075, 0.018, 8, 20), poloMat);
  collar.rotation.x = Math.PI / 2; collar.position.y = 0.56;
  hips.add(collar);
  const buttons = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.12, 0.01), std(0xf3efe6));
  buttons.position.set(0, 0.47, -0.105);
  hips.add(buttons);

  // шея и голова
  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.05, 0.08, 10), skinMat);
  neck.position.y = 0.58;
  hips.add(neck);
  const head = new THREE.Group();
  head.position.y = 0.63;
  hips.add(head);
  const skull = new THREE.Mesh(new THREE.SphereGeometry(0.105, 18, 14), skinMat);
  skull.scale.set(0.92, 1.08, 0.95);
  skull.position.y = 0.1;
  head.add(skull);
  const hairMesh = new THREE.Mesh(
    new THREE.SphereGeometry(0.109, 18, 12, 0, Math.PI * 2, 0, female ? Math.PI * 0.72 : Math.PI * 0.5),
    std(hair, { roughness: 0.9 }),
  );
  hairMesh.scale.set(0.95, 1.05, 0.98);
  hairMesh.position.y = 0.115;
  head.add(hairMesh);
  if (female) {
    const tail = new THREE.Mesh(new THREE.CapsuleGeometry(0.03, 0.14, 4, 8), std(hair, { roughness: 0.9 }));
    tail.position.set(0, 0.0, 0.11); tail.rotation.x = 0.35;
    head.add(tail);
  }
  const eyeMat = std(0x1c1b1a);
  for (const sx of [-0.035, 0.035]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.011, 8, 8), eyeMat);
    eye.position.set(sx, 0.11, -0.092);
    head.add(eye);
  }
  if (glasses) {
    const gl = new THREE.Group();
    for (const sx of [-0.035, 0.035]) {
      const rim = new THREE.Mesh(new THREE.TorusGeometry(0.02, 0.003, 6, 16), MAT.black());
      rim.position.set(sx, 0.11, -0.1);
      gl.add(rim);
    }
    const bridge = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.003, 0.003), MAT.black());
    bridge.position.set(0, 0.11, -0.1);
    gl.add(bridge);
    head.add(gl);
  }

  // руки: плечо → локоть → кисть
  const mkArm = (side) => {
    const shoulder = new THREE.Group();
    shoulder.position.set(side * (female ? 0.19 : 0.22), 0.5, 0);
    hips.add(shoulder);
    const upper = new THREE.Mesh(new THREE.CapsuleGeometry(0.045, 0.22, 4, 8), poloMat);
    upper.position.y = -0.14;
    shoulder.add(upper);
    const elbow = new THREE.Group();
    elbow.position.y = -0.27;
    shoulder.add(elbow);
    const fore = new THREE.Mesh(new THREE.CapsuleGeometry(0.038, 0.2, 4, 8), skinMat);
    fore.position.y = -0.12;
    elbow.add(fore);
    const hand = new THREE.Mesh(new THREE.SphereGeometry(0.045, 10, 8), skinMat);
    hand.scale.set(0.8, 0.5, 1.1);
    hand.position.y = -0.25;
    elbow.add(hand);
    return { shoulder, elbow, hand };
  };
  const armL = mkArm(-1);
  const armR = mkArm(1);

  // ноги: бедро → колено → стопа
  const mkLeg = (side) => {
    const hip = new THREE.Group();
    hip.position.set(side * 0.1, 0.02, 0);
    hips.add(hip);
    const thigh = new THREE.Mesh(new THREE.CapsuleGeometry(0.065, 0.3, 4, 8), pantMat);
    thigh.position.y = -0.18;
    hip.add(thigh);
    const knee = new THREE.Group();
    knee.position.y = -0.36;
    hip.add(knee);
    const shin = new THREE.Mesh(new THREE.CapsuleGeometry(0.055, 0.32, 4, 8), pantMat);
    shin.position.y = -0.19;
    knee.add(shin);
    const shoe = new THREE.Mesh(new RoundedBoxGeometry(0.1, 0.06, 0.24, 2, 0.02), MAT.black());
    shoe.position.set(0, -0.4, -0.05);
    knee.add(shoe);
    return { hip, knee };
  };
  const legL = mkLeg(-1);
  const legR = mkLeg(1);

  if (standing) {
    armL.shoulder.rotation.x = 0.1; armR.shoulder.rotation.x = 0.1;
  } else {
    // сидя: бёдра вперёд, колени вниз
    legL.hip.rotation.x = -Math.PI / 2 + 0.15; legR.hip.rotation.x = -Math.PI / 2 + 0.15;
    legL.knee.rotation.x = Math.PI / 2 - 0.2; legR.knee.rotation.x = Math.PI / 2 - 0.2;
    armL.shoulder.rotation.x = -0.9; armR.shoulder.rotation.x = -0.9;
    armL.elbow.rotation.x = -0.9; armR.elbow.rotation.x = -0.9;
  }

  return { group: g, hips, head, torso, armL, armR, legL, legR, phase: Math.random() * Math.PI * 2, standing };
}


/* ---------- слияние статики ---------- */

/**
 * Склеивает все обычные меши группы с одинаковым материалом в один: стол с
 * креслом и мелочами превращается из ~40 вызовов отрисовки в 6–8.
 * Пропускает InstancedMesh, канвы-экраны и всё с userData.keep.
 */
export function mergeStatic(group) {
  group.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(group.matrixWorld).invert();
  const byMat = new Map();
  const remove = [];
  group.traverse((m) => {
    if (!m.isMesh || m.isInstancedMesh || m.userData.keep || (m.material && m.material.map) || Array.isArray(m.material)) return;
    // ключ — по свойствам материала, а не по uuid: каждый предмет создаёт свой
    // экземпляр, и по uuid ничего бы не склеилось
    const mt = m.material;
    const key = [mt.type, mt.color && mt.color.getHex(), mt.roughness, mt.metalness, mt.side, mt.transparent, mt.opacity,
      mt.emissive && mt.emissive.getHex(), mt.emissiveIntensity, mt.transmission].join('|');
    if (!byMat.has(key)) byMat.set(key, { material: mt, geos: [], meshes: [] });
    byMat.get(key).meshes.push(m);
    const g = m.geometry.clone();
    g.applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, m.matrixWorld));
    // индексные и неиндексные геометрии не склеиваются: приводим к неиндексным
    byMat.get(key).geos.push(g.index ? g.toNonIndexed() : g);
    remove.push(m);
  });
  for (const m of remove) m.parent.remove(m);
  for (const { material, geos, meshes } of byMat.values()) {
    // у геометрий должен совпадать набор атрибутов (position/normal/uv)
    const clean = geos.map((g) => { for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(k)) g.deleteAttribute(k); if (!g.attributes.uv) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2)); return g; });
    let merged = null;
    try { merged = mergeGeometries(clean, false); } catch (e) { merged = null; }
    if (!merged) {
      // геометрия не должна пропадать молча: возвращаем исходные меши на место
      console.warn('[office] слияние не удалось для материала', material.type, geos.map((g) => Object.keys(g.attributes).join('+')));
      for (const m of meshes) m.parent ? null : group.add(m);
      continue;
    }
    const mesh = new THREE.Mesh(merged, material);
    mesh.castShadow = true; mesh.receiveShadow = true;
    group.add(mesh);
  }
  return group;
}
