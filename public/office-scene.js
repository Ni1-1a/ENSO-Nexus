'use strict';
/**
 * Трёхмерный зал «Виртуального офиса», итерация 2: амфитеатр из четырёх
 * ярусов со светящимися кромками, боковые галереи со стеклом и растениями,
 * зеркальный паркет фойе, изогнутый экран, стол-голограмма, лобби с
 * мосс-стеной, постеры двух серий, люди с суставами и ходоки, ходьба от
 * первого лица.
 *
 * Пропорции — по золотому сечению: зал 34×21 (≈φ), экран делится 0.382/0.618,
 * рамы постеров 1:φ, радиусы ярусов растут шагом 3.2 м.
 */

import * as THREE from './vendor/three.module.min.js';
import { OrbitControls } from './vendor/OrbitControls.js';
import { RoomEnvironment } from './vendor/RoomEnvironment.js';
import { Reflector } from './vendor/Reflector.js';
import { RoundedBoxGeometry } from './vendor/RoundedBoxGeometry.js';
import { RectAreaLightUniformsLib } from './vendor/RectAreaLightUniformsLib.js';
import * as P from './office-props.js?v=5';
import { LifeDirector, makeSteam } from './office-life.js?v=5';
import { WalkRig } from './office-walk.js?v=5';
import { buildWings, insideWalkable, floorHeight, stoneMaterial, LEVEL as WING_LEVEL, FLOOR2 } from './office-wings.js?v=5';
import { slotFree } from './office-geom.mjs?v=5';

/* палитра платформы + бренд (BRAND задаётся в office-data.js) */
const PAL = {
  light: {
    bg: 0xf1ede4, wall: 0xf3efe6, ceiling: 0xe4dfd5, tier: 0xe8e0d0, tierEdge: 0x26211b,
    hemi: 0.9, sun: 1.1, spots: 0, window: 0xe9f1f6, strip: 0xfff4e6, ledStrength: 0.8,
  },
  dark: {
    bg: 0x1a1714, wall: 0x241f1a, ceiling: 0x14110d, tier: 0x2a241d, tierEdge: 0x1a1613,
    hemi: 0.22, sun: 0.1, spots: 1, window: 0x1b2a3a, strip: 0x8a6a55, ledStrength: 1.6,
  },
};

const MODULES = ['tz', 'site', 'doc', 'normo', 'gge', 'akty'];
const STATE_COLORS = { ok: '#4f7d58', warn: '#b07e36', bad: '#a93e2c', run: '#4a6b8a', none: '#8b8375', off: '#8b8375' };

/* фокус амфитеатра — точка за экраном; ярусы — кольца вокруг неё */
const FOCUS = { x: 0, z: -14 };
const TIERS = [
  { r0: 7.5, r1: 10.7, y: 0.0, count: 6 },
  { r0: 10.7, r1: 13.9, y: 0.34, count: 7 },
  { r0: 13.9, r1: 17.1, y: 0.68, count: 8 },
  { r0: 17.1, r1: 20.3, y: 1.02, count: 9 },
];
const CONCOURSE_Y = 1.02;

/* виды камеры (обзор) и точки телепорта (ходьба) */
const VIEWS = {
  lobby:  { pos: [0, 2.7, 19.6], tgt: [0, 2.3, 12.5], walk: [0, 18.6], look: [0, 12] },
  hall:   { pos: [0, 7.6, 4.0], tgt: [0, 2.0, -7.6], walk: [0, 8.6], look: [0, -8] },
  screen: { pos: [0, 3.9, 3.8], tgt: [0, 3.5, -11], walk: [0, -5.6], look: [0, -11] },
  table:  { pos: [1.5, 2.7, -6.4], tgt: [0, 1.15, -8.6], walk: [1.3, -6.6], look: [0, -8.6] },
};

export function heightAt(x, z) {
  const d = Math.hypot(x - FOCUS.x, z - FOCUS.z);
  for (let i = TIERS.length - 1; i >= 0; i--) if (d >= TIERS[i].r0) return TIERS[i].y;
  return 0;
}

export class OfficeScene {
  constructor(canvas, { dark = false, reducedMotion = false, mobile = false } = {}) {
    this.canvas = canvas;
    this.dark = dark;
    this.reducedMotion = reducedMotion;
    this.mobile = mobile;
    this.pal = dark ? PAL.dark : PAL.light;
    this.brand = (window.OfficeData && window.OfficeData.brand) || { primary: '#b95740', ink: '#26211b', paper: '#f3efe6', name: 'ENSO-Engineering' };

    this.pickables = [];
    this.people = new Map();
    this.monitors = new Map();
    this.itemAnchors = new Map();
    this.onPick = null;
    this.onTypingTick = null;
    this.life = new LifeDirector();
    this.life.heightAt = heightAt;
    this._tween = null;
    this._fly = null;
    this._time = 0;
    this._sceneData = null;
    this._geomHash = '';
    this._thumbImages = new Map();
    this._screenMode = 'plan';
    this._screenModeAt = 0;
    this._blockers = [];
    this._desks = [];
    this.walkMode = false;

    this._init();
    this._build();
  }

  /* ================= инициализация ================= */

  _init() {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: !this.mobile, alpha: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, this.mobile ? 1.5 : 2));
    this.renderer.setSize(w, h, false);
    this.renderer.shadowMap.enabled = !this.mobile;
    // В three 0.185 PCFSoftShadowMap объявлен устаревшим и молча подменяется
    // на PCFShadowMap — ставим его явно, а мягкость кромки даёт shadow.radius
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = this.dark ? 0.9 : 1.05;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    P.setMaxAnisotropy(this.renderer.capabilities.getMaxAnisotropy());

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(this.pal.bg);
    // дымка отодвинута за габарит участка: при 34…70 м окружение целиком уходило
    // в цвет фона и сад читался плоской заливкой (В8)
    this.scene.fog = new THREE.Fog(this.pal.bg, 70, 300);
    // окружение для отражений на стекле, металле и паркете
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();

    this.camera = new THREE.PerspectiveCamera(48, w / h, 0.08, 420);
    this.camera.position.set(...VIEWS.lobby.pos);

    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.target.set(...VIEWS.lobby.tgt);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.maxPolarAngle = Math.PI * 0.49;
    this.controls.minDistance = 0.5;
    this.controls.maxDistance = 30;
    // панорамирование уводило target вместе с камерой наружу здания
    this.controls.enablePan = false;
    this.controls.update();

    this.walk = new WalkRig(this.camera, this.canvas, {
      heightAt: (x, z, prevY) => floorHeight(x, z, prevY === undefined ? heightAt(x, z) : prevY, heightAt),
      blocked: (x, z, floorY) => this._blocked(x, z, floorY),
      inside: insideWalkable,
    });

    this.hemi = new THREE.HemisphereLight(0xfff8ee, 0x7a7062, this.pal.hemi);
    this.scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight(0xfff1de, this.pal.sun);
    this.sun.position.set(-18, 16, 6);
    if (!this.mobile) {
      this.sun.castShadow = true;
      // фрустум накрывает ВСЁ здание: при ±24 правая граница резала переговорную,
      // и тень обрывалась прямой линией прямо на паркете
      this.sun.shadow.mapSize.set(4096, 4096);
      this.sun.shadow.camera.left = -36; this.sun.shadow.camera.right = 36;
      this.sun.shadow.camera.top = 36; this.sun.shadow.camera.bottom = -36;
      this.sun.shadow.bias = -0.0002;
      this.sun.shadow.normalBias = 0.03;
      this.sun.shadow.camera.near = 1; this.sun.shadow.camera.far = 90;
      this.sun.shadow.radius = 2.5;
      this.sun.shadow.camera.updateProjectionMatrix();
    }
    this.sun.target.position.set(0, 0, 2);
    this.scene.add(this.sun, this.sun.target);
    RectAreaLightUniformsLib.init();
    // ночные споты над сценой и ярусами
    this._spots = [];
    for (const [x, z] of [[-6, -6], [6, -6], [-6, 4], [6, 4], [0, 14], [0, -2]]) {
      const s = new THREE.SpotLight(0xffd9b8, 0, 26, 0.7, 0.6, 1.2);
      s.position.set(x, 7.8, z);
      s.target.position.set(x, 0, z);
      this.scene.add(s, s.target);
      this._spots.push(s);
    }

    this.raycaster = new THREE.Raycaster();
    this._pointer = new THREE.Vector2();
    this._down = null;
    this.canvas.addEventListener('pointerdown', (e) => { this._down = [e.clientX, e.clientY]; });
    this.canvas.addEventListener('pointerup', (e) => {
      if (!this._down) return;
      const moved = Math.hypot(e.clientX - this._down[0], e.clientY - this._down[1]);
      this._down = null;
      if (moved < 7) this._pick(e);
    });
    window.addEventListener('resize', () => this.resize());
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
  }

  _pickable(obj, info) {
    obj.traverse((m) => { m.userData.pick = info; });
    this.pickables.push(obj);
  }

  _blocked(x, z, floorY = 0) {
    for (const b of this._blockers) {
      // below/above — препятствие только на своём этаже (стол переговорной не мешает на антресоли)
      if (b.below !== undefined && floorY >= b.below) continue;
      if (b.above !== undefined && floorY < b.above) continue;
      if (b.r !== undefined) { if (Math.hypot(x - b.x, z - b.z) < b.r) return true; }
      else if (x > b.x0 && x < b.x1 && z > b.z0 && z < b.z1) return true;
    }
    return false;
  }

  /* ================= архитектура ================= */

  _build() {
    this._buildFloorsAndTiers();
    this._buildWallsAndCeiling();
    this._buildScreen();
    this._buildTable();
    this._buildDesks();
    this._buildLobby();
    this._buildLounge();
    this._buildWallProps();
    this._buildPostersAndPlants();
    this._buildWalkers();
    this.wings = buildWings(this.scene, {
      life: this.life, pickables: this.pickables, blockers: this._blockers, itemAnchors: this.itemAnchors,
      brand: this.brand, pickable: (obj, info) => this._pickable(obj, info),
    });
    this.wings.setDark(this.dark);
  }

  _buildFloorsAndTiers() {
    const p = this.pal;
    this._wood = P.woodTexture();

    /*
     * ПОДОСНОВА ЗАЛА. Ярусы — секторы кольца в 1.9 рад: за их углами пола нет
     * вовсе, и после того, как снаружи появилась настоящая земля (В8), в этих
     * прорехах стал виден газон. Плита закрывает весь след здания.
     */
    const base = new THREE.Mesh(new THREE.PlaneGeometry(32, 32.2), stoneMaterial(32, 32.2));
    base.rotation.x = -Math.PI / 2;
    base.position.set(0, -0.05, 4.9);
    base.receiveShadow = true;
    this.scene.add(base);

    // сцена перед ярусами (уровень 0) — матовый паркет
    const stage = new THREE.Mesh(new THREE.PlaneGeometry(32, 8), stoneMaterial(32, 8));
    stage.rotation.x = -Math.PI / 2;
    stage.position.set(0, 0, -7.4);
    stage.receiveShadow = true;
    this.scene.add(stage);

    // ярусы: кольцевые сектора вокруг фокуса, светящаяся кромка на ступени
    this._tierMeshes = [];
    this._ledStrips = [];
    TIERS.forEach((t, i) => {
      const ring = new THREE.RingGeometry(t.r0, t.r1, 96, 1, Math.PI / 2 - 0.95, 1.9);
      const woodRing = P.tiled(this._wood, (t.r0 + t.r1) * 0.95, t.r1 - t.r0, 256);
      const mesh = new THREE.Mesh(ring, new THREE.MeshStandardMaterial({ map: woodRing, bumpMap: woodRing, bumpScale: 0.006, roughness: 0.4, metalness: 0.03 }));
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.set(FOCUS.x, t.y + 0.001, FOCUS.z);
      mesh.receiveShadow = true;
      this.scene.add(mesh);
      this._tierMeshes.push(mesh);
      if (t.y > 0) {
        // подступёнок
        const riser = new THREE.Mesh(
          new THREE.CylinderGeometry(t.r0, t.r0, t.y - TIERS[i - 1].y, 96, 1, true, Math.PI / 2 - 0.95 + Math.PI, 1.9),
          new THREE.MeshStandardMaterial({ color: p.tierEdge, roughness: 0.5, side: THREE.DoubleSide }),
        );
        riser.position.set(FOCUS.x, (t.y + TIERS[i - 1].y) / 2, FOCUS.z);
        riser.rotation.y = Math.PI;
        this.scene.add(riser);
        this._tierMeshes.push(riser);
        // световая кромка ступени — фирменная деталь
        const led = new THREE.Mesh(
          new THREE.TorusGeometry(t.r0, 0.018, 8, 160, 1.9),
          new THREE.MeshBasicMaterial({ color: p.strip, transparent: true, opacity: 0.7 }),
        );
        led.rotation.x = -Math.PI / 2;
        led.rotation.z = Math.PI / 2 - 0.95;
        led.position.set(FOCUS.x, t.y + 0.012, FOCUS.z);
        led.userData.phase = i * 1.3;
        this.scene.add(led);
        this._ledStrips.push(led);
        this.life.strips.push(led);
      }
    });

    // центральный проход со ступенями между ярусами
    for (let i = 1; i < TIERS.length; i++) {
      const rise = TIERS[i].y - TIERS[i - 1].y;
      for (let s = 0; s < 3; s++) {
        const woodStep = P.tiled(this._wood, 2.4, 0.34, 256);
        const step = new THREE.Mesh(new THREE.BoxGeometry(2.4, rise / 3, 0.34), new THREE.MeshStandardMaterial({ map: woodStep, bumpMap: woodStep, bumpScale: 0.006, roughness: 0.4 }));
        const r = TIERS[i].r0 - 0.5 + s * 0.34;
        step.position.set(0, TIERS[i - 1].y + (rise / 3) * (s + 0.5), FOCUS.z + r);
        step.receiveShadow = true;
        this.scene.add(step);
      }
    }

    // верхнее фойе и лобби — зеркальный паркет: Reflector под полупрозрачным деревом
    const concourseZ0 = FOCUS.z + TIERS[3].r1; // 6.3
    const concourse = new THREE.PlaneGeometry(32, 21 - concourseZ0);
    if (!this.mobile) {
      const mirror = new Reflector(concourse, {
        clipBias: 0.003, textureWidth: 1024, textureHeight: 1024, color: 0x9a8f80,
      });
      mirror.rotation.x = -Math.PI / 2;
      mirror.position.set(0, CONCOURSE_Y - 0.004, (concourseZ0 + 21) / 2);
      this.scene.add(mirror);
      this._mirror = mirror;
    }
    const stoneMat = stoneMaterial(32, 21 - concourseZ0);
    stoneMat.transparent = !this.mobile; stoneMat.opacity = this.mobile ? 1 : 0.82;
    const gloss = new THREE.Mesh(concourse, stoneMat);
    gloss.rotation.x = -Math.PI / 2;
    gloss.position.set(0, CONCOURSE_Y, (concourseZ0 + 21) / 2);
    gloss.receiveShadow = true;
    this.scene.add(gloss);
    this._concourse = gloss;

    // фронтальный подступёнок фойе к третьему ярусу закрыт кольцом яруса 3;
    // боковые зоны ниже фойе — пол уровня 1.02 уже кольцом покрыт (r1 = 20.3)
    // ковровая дорожка к столу
    const carpet = new THREE.Mesh(new THREE.PlaneGeometry(2.2, 4.5), new THREE.MeshStandardMaterial({ color: 0xb95740, roughness: 0.95, transparent: true, opacity: 0.35 }));
    carpet.rotation.x = -Math.PI / 2;
    carpet.position.set(0, 0.004, -5.2);
    this.scene.add(carpet);
  }

  _buildWallsAndCeiling() {
    const p = this.pal;
    const wallMat = stoneMaterial(32, 9);
    this._wallMat = wallMat;
    /**
     * Стена — ОБЪЁМ толщиной 300 мм, а не плоскость: у плоскости нормаль смотрит
     * в одну сторону, и из крыла зал просвечивал насквозь, а в проёме была
     * бумага нулевой толщины. Толщина видна в каждом проёме.
     */
    const WALL_T = 0.3;
    const mk = (w, h, x, y, z, ry = 0) => {
      const geo = new THREE.BoxGeometry(w, h, WALL_T);
      const m = new THREE.Mesh(geo, wallMat);
      m.position.set(x, y, z); m.rotation.y = ry;
      m.receiveShadow = true; m.castShadow = true;
      this.scene.add(m);
      return m;
    };
    mk(32, 9, 0, 4.5, -11.2);
    mk(32, 9, 0, 4.5, 21, Math.PI);
    // боковые стены зала — до подоконника, с проёмами (z −1.2…1.6) в зал реактора и гараж;
    // в лобби по бокам стен нет: там стекло аквариума и переговорной (office-wings.js)
    for (const side of [-1, 1]) {
      const x = side * 16, ry = side < 0 ? Math.PI / 2 : -Math.PI / 2;
      mk(10, 5.2, x, 2.6, -6.2, ry);          // z −11.2…−1.2, до подоконника
      mk(9.4, 5.2, x, 2.6, 6.3, ry);          // z 1.6…11
      mk(2.8, 0.8, x, 4.8, 0.2, ry);          // перемычка над проёмом
      mk(22.2, 0.6, x, 8.7, -0.1, ry);        // полоса над окнами
      /*
       * Обкладка проёма СТОИТ ПРОУДЬ стены и заходит в неё: при ширине ровно
       * 0.3 её боковые грани совпадали с гранями стены, а тыльная — с торцом
       * у проёма, и косяк рябил зубчатой лесенкой (правило 1: зазор 2 мм).
       */
      const jamb = P.MAT.ink();
      // ВЫСОТЫ ПРОЁМА: перемычка стоит на 4.4…5.2, значит верх проёма — 4.4,
      // а пол крыла — WING_LEVEL. Прежние отметки прибавляли WING_LEVEL к обеим
      // границам, и обкладка с вывеской уезжали на метр выше проёма — на
      // второй этаж, в лаундж.
      const OP_TOP = 4.4, OP_BOT = WING_LEVEL;
      for (const zz of [-1.2, 1.6]) {
        const j = new THREE.Mesh(new THREE.BoxGeometry(0.31, OP_TOP - OP_BOT, 0.12), jamb);
        j.position.set(x, (OP_TOP + OP_BOT) / 2, zz + (zz < 0 ? 0.055 : -0.055));
        this.scene.add(j);
      }
      const head = new THREE.Mesh(new THREE.BoxGeometry(0.31, 0.12, 2.9), jamb); head.position.set(x, OP_TOP - 0.06, 0.2); this.scene.add(head);
      const led = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.03, 2.7), new THREE.MeshBasicMaterial({ color: p.strip, transparent: true, opacity: 0.8 })); led.position.set(x - side * 0.12, OP_TOP - 0.18, 0.2); this.scene.add(led); this.life.strips.push(led);
      // 1024×256 на 1.8 м = 568 пикс/м: на 512×128 надпись мылилась
      const text = side < 0 ? 'ЗАЛ РЕАКТОРА' : 'МАСТЕРСКАЯ';
      const doorSign = P.canvasTexture(1024, 256, (c) => {
        c.fillStyle = '#26211b'; c.fillRect(0, 0, 1024, 256);
        c.fillStyle = '#b95740'; c.fillRect(0, 0, 1024, 8);
        c.fillStyle = '#f3efe6'; c.textAlign = 'center'; c.textBaseline = 'middle';
        let size = 92;
        do { c.font = `600 ${size}px -apple-system, sans-serif`; size -= 4; } while (c.measureText(text).width > 952 && size > 30);
        c.fillText(text, 512, 134);
      });
      const dsBody = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.45, 0.05), P.MAT.graphite());
      dsBody.position.set(x - side * 0.24, OP_TOP + 0.34, 0.2); dsBody.rotation.y = ry; this.scene.add(dsBody);
      const ds = new THREE.Mesh(new THREE.PlaneGeometry(1.76, 0.44), new THREE.MeshBasicMaterial({ map: doorSign.texture, toneMapped: false }));
      ds.position.set(x - side * 0.27, OP_TOP + 0.34, 0.2); ds.rotation.y = ry; this.scene.add(ds);
      for (const dz of [-0.7, 0.7]) {
        const bracket = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 0.24, 8), P.MAT.brushed());
        bracket.rotation.z = Math.PI / 2; bracket.rotation.y = ry;
        bracket.position.set(x - side * 0.13, OP_TOP + 0.34, 0.2 + dz); this.scene.add(bracket);
      }
    }
    // плинтусы тушью по периметру фойе и сцены
    const skirt = P.MAT.ink();
    for (const [w, h, x, y, z] of [[32, 0.1, 0, CONCOURSE_Y + 0.05, 20.95], [0.1, 0.1, -15.95, CONCOURSE_Y + 0.05, 13.5], [0.1, 0.1, 15.95, CONCOURSE_Y + 0.05, 13.5]]) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w === 0.1 ? 0.1 : w, h, w === 0.1 ? 15 : 0.1), skirt);
      m.position.set(x, y, z); this.scene.add(m);
    }
    // стена за экраном — тёмная подложка тушью и акустические ламели чуть светлее:
    // без подложки просветы между ламелями читались белым «штрих-кодом»
    const backing = new THREE.Mesh(new THREE.BoxGeometry(32, 9, 0.12), new THREE.MeshStandardMaterial({ color: 0x1c1916, roughness: 0.9 }));
    backing.position.set(0, 4.5, -11.18); backing.receiveShadow = true; this.scene.add(backing);
    const lam = new THREE.InstancedMesh(new THREE.BoxGeometry(0.06, 8.6, 0.07), new THREE.MeshStandardMaterial({ color: 0x3a342d, roughness: 0.7 }), 200);
    const lm = new THREE.Matrix4();
    for (let i = 0; i < 200; i++) { lm.makeTranslation(-15.9 + i * 0.16, 4.3, -11.1); lam.setMatrixAt(i, lm); }
    lam.instanceMatrix.needsUpdate = true;
    this.scene.add(lam);

    // перегородка лобби с широким проёмом и перемычкой
    for (const [w, x] of [[10.0, -11.0], [10.0, 11.0]]) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, 9, 0.3), wallMat);
      m.position.set(x, 4.5, 11);
      this.scene.add(m);
      this._blockers.push({ x0: x - w / 2, x1: x + w / 2, z0: 10.7, z1: 11.3 });
    }
    const lintel = new THREE.Mesh(new THREE.BoxGeometry(12.2, 2.2, 0.3), wallMat);
    lintel.position.set(0, 7.9, 11);
    this.scene.add(lintel);
    // портал проёма — тёмная рамка с подсветкой
    const portal = new THREE.Mesh(new THREE.BoxGeometry(12.4, 0.12, 0.36), P.MAT.graphite());
    portal.position.set(0, 6.75, 11);
    this.scene.add(portal);
    const portalLed = new THREE.Mesh(new THREE.BoxGeometry(12.0, 0.02, 0.02), new THREE.MeshBasicMaterial({ color: p.strip, transparent: true, opacity: 0.8 }));
    portalLed.position.set(0, 6.68, 11.2);
    this.scene.add(portalLed);
    this.life.strips.push(portalLed);

    // потолок и радиальные световые линии, сходящиеся к экрану
    const ceil = new THREE.Mesh(new THREE.PlaneGeometry(32, 34), new THREE.MeshStandardMaterial({ color: p.ceiling, roughness: 0.9 }));
    ceil.rotation.x = Math.PI / 2;
    ceil.position.set(0, 9, 4);
    this.scene.add(ceil);
    this._ceil = ceil;
    this._strips = [];
    const stripMat = new THREE.MeshBasicMaterial({ color: p.strip });
    for (let i = -4; i <= 4; i++) {
      const ang = i * 0.13;
      const len = 30;
      const s = new THREE.Mesh(new THREE.PlaneGeometry(0.16, len), stripMat);
      s.rotation.x = Math.PI / 2;
      s.rotation.z = -ang;
      s.position.set(Math.sin(ang) * len * 0.5, 8.97, -11 + Math.cos(ang) * len * 0.5);
      this.scene.add(s);
      this._strips.push(s);
    }
    // встроенные споты
    const spotMat = new THREE.MeshBasicMaterial({ color: 0xfff7ea });
    for (let x = -12; x <= 12; x += 4) {
      for (let z = -8; z <= 18; z += 4) {
        const d = new THREE.Mesh(new THREE.CircleGeometry(0.14, 16), spotMat);
        d.rotation.x = Math.PI / 2;
        d.position.set(x, 8.98, z);
        this.scene.add(d);
      }
    }

    // окна над галереями
    // окна над крыльями: стеклянная лента 5.2…8.4 м, за ней — сад (office-wings.buildGardens)
    this._windows = [];
    const winMat = new THREE.MeshPhysicalMaterial({ color: 0xdfeaf2, transmission: 0.92, thickness: 0.02, roughness: 0.03, ior: 1.45, transparent: true, side: THREE.DoubleSide });
    for (const sx of [-15.95, 15.95]) {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(21, 3.2), winMat);
      m.position.set(sx, 6.8, -0.6);
      m.rotation.y = sx < 0 ? Math.PI / 2 : -Math.PI / 2;
      this.scene.add(m);
      this._windows.push(m);
      for (let i = 0; i <= 6; i++) {
        const mullion = new THREE.Mesh(new THREE.BoxGeometry(0.08, 3.3, 0.08), P.MAT.graphite());
        mullion.position.set(sx, 6.8, -11 + i * 3.5);
        this.scene.add(mullion);
      }
      const sill = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.1, 21), P.MAT.graphite()); sill.position.set(sx, 5.15, -0.6); this.scene.add(sill);
    }
  }

  /* галереи заменены кольцевым лаунджем второго этажа — office-wings.buildRingLounge */

  /* ---------- центральный экран ---------- */

  _buildScreen() {
    const { canvas, ctx, texture } = P.canvasTexture(2560, 880, () => {});
    this.screenCtx = ctx; this.screenCanvas = canvas; this.screenTexture = texture;
    texture.wrapS = THREE.RepeatWrapping; texture.repeat.x = -1;
    const R = 13, arc = 1.36;
    const geo = new THREE.CylinderGeometry(R, R, 6.2, 64, 1, true, Math.PI - arc / 2, arc);
    const screen = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: texture, side: THREE.BackSide, toneMapped: false }));
    screen.position.set(0, 3.7, 2.2);
    this.scene.add(screen);
    this._pickable(screen, { kind: 'screen' });
    // корпус и световая кромка
    const shell = new THREE.Mesh(new THREE.CylinderGeometry(R + 0.06, R + 0.06, 6.5, 64, 1, true, Math.PI - arc / 2 - 0.01, arc + 0.02), P.MAT.graphite());
    shell.position.set(0, 3.7, 2.2);
    this.scene.add(shell);
    for (const y of [0.55, 6.85]) {
      const led = new THREE.Mesh(new THREE.CylinderGeometry(R + 0.07, R + 0.07, 0.03, 64, 1, true, Math.PI - arc / 2, arc), new THREE.MeshBasicMaterial({ color: 0xff8a66, transparent: true, opacity: 0.8, side: THREE.DoubleSide }));
      led.position.set(0, y, 2.2);
      this.scene.add(led);
      this.life.strips.push(led);
    }
    this._blockers.push({ x0: -9, x1: 9, z0: -11.3, z1: -8.3 });
    // свет экрана на первые ряды: три площадных источника вдоль дуги
    this._screenLights = [];
    for (const [x, ry] of [[-5.2, 0.42], [0, 0], [5.2, -0.42]]) {
      const l = new THREE.RectAreaLight(0xcfe0ff, 3.2, 5.4, 5.6);
      l.position.set(x, 3.7, -10.2 + Math.abs(x) * 0.12);
      l.rotation.set(-0.25, Math.PI + ry, 0);
      this.scene.add(l);
      this._screenLights.push(l);
    }
    this._drawScreen(null);
  }

  setScreenMode(mode) {
    if (this._screenMode === mode) return;
    this._screenMode = mode;
    this._screenModeAt = this._time;
    if (this._sceneData) this._drawScreen(this._sceneData);
  }

  _drawScreen(data) {
    const c = this.screenCtx;
    const W = this.screenCanvas.width, H = this.screenCanvas.height;
    const brand = this.brand;
    // фон: глубокий графит с мягким градиентом
    // палитра сайта ENSO-Engineering: чёрный фон, белый текст, серые панели
    const bg = c.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, '#141414'); bg.addColorStop(1, '#0a0a0b');
    c.fillStyle = bg; c.fillRect(0, 0, W, H);
    // сетка-подложка
    c.strokeStyle = 'rgba(255,255,255,.035)'; c.lineWidth = 1;
    for (let x = 0; x < W; x += 80) { c.beginPath(); c.moveTo(x, 0); c.lineTo(x, H); c.stroke(); }
    for (let y = 0; y < H; y += 80) { c.beginPath(); c.moveTo(0, y); c.lineTo(W, y); c.stroke(); }

    const panel = (x, y, w, h, title) => {
      c.fillStyle = 'rgba(255,255,255,.05)';
      c.beginPath(); c.roundRect(x, y, w, h, 18); c.fill();
      c.strokeStyle = 'rgba(255,255,255,.12)'; c.lineWidth = 2; c.stroke();
      c.fillStyle = '#ffffff'; c.fillRect(x + 22, y + 20, 6, 34);
      c.fillStyle = 'rgba(255,255,255,.92)';
      c.font = '600 30px -apple-system, "Helvetica Neue", sans-serif';
      c.textAlign = 'left'; c.textBaseline = 'top';
      c.fillText(title, x + 42, y + 20);
    };
    c.textBaseline = 'top';

    // шапка: логотип компании (SVG с сайта) или имя, проект, часы
    if (this._logoImg) c.drawImage(this._logoImg, 48, 30, 190, 70);
    else { c.fillStyle = 'rgba(255,255,255,.6)'; c.font = '600 26px -apple-system, sans-serif'; c.fillText(brand.name.toUpperCase(), 48, 26); }
    c.fillStyle = '#ffffff';
    c.font = '600 60px Georgia, "New York", serif';
    c.fillText(data && data.project ? data.project.name : 'Enso-nexus', 270, 40);
    c.textAlign = 'right';
    c.font = '500 44px ui-monospace, Menlo, monospace';
    c.fillStyle = 'rgba(243,239,230,.8)';
    c.fillText(new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }), W - 48, 40);
    c.font = '26px -apple-system, sans-serif';
    c.fillStyle = 'rgba(243,239,230,.5)';
    c.fillText(new Date().toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' }), W - 48, 96);
    c.textAlign = 'left';

    if (!data || !data.project) {
      c.fillStyle = 'rgba(243,239,230,.8)';
      c.font = '600 96px Georgia, serif'; c.textAlign = 'center';
      c.fillText(brand.name, W / 2, H / 2 - 100);
      c.font = '40px -apple-system, sans-serif'; c.fillStyle = 'rgba(243,239,230,.6)';
      c.fillText(data ? 'Выберите проект в лобби — сводка появится здесь' : 'Соединение с платформой…', W / 2, H / 2 + 20);
      c.textAlign = 'left';
      this.screenTexture.needsUpdate = true;
      return;
    }

    // сетка по золотому сечению: левая колонка 0.382, центр 0.618 от остатка
    const top = 150, bottom = H - 40, gap = 28;
    const leftW = Math.round((W - gap * 4) * 0.28);
    const rightW = Math.round((W - gap * 4) * 0.24);
    const midW = W - gap * 4 - leftW - rightW;
    const lx = gap, mx = gap * 2 + leftW, rx = gap * 3 + leftW + midW;
    const ph = bottom - top;

    // слева: модули
    panel(lx, top, leftW, ph, 'Модули проекта');
    const names = window.OfficeData.moduleNames;
    let y = top + 84;
    for (const m of MODULES) {
      const s = (data.modules && data.modules[m]) || { state: 'none', line: 'нет данных' };
      c.fillStyle = STATE_COLORS[s.state] || STATE_COLORS.none;
      c.beginPath(); c.arc(lx + 46, y + 22, 11, 0, Math.PI * 2); c.fill();
      if (s.state === 'run') { c.strokeStyle = STATE_COLORS.run; c.lineWidth = 3; c.beginPath(); c.arc(lx + 46, y + 22, 18 + Math.sin(this._time * 4) * 3, 0, Math.PI * 2); c.stroke(); }
      c.fillStyle = '#f3efe6'; c.font = '600 30px -apple-system, sans-serif';
      c.fillText(names[m], lx + 76, y);
      c.fillStyle = 'rgba(243,239,230,.6)'; c.font = '24px -apple-system, sans-serif';
      c.fillText(this._clip(c, s.line || '', leftW - 100), lx + 76, y + 38);
      y += 104;
    }

    // центр: режимы plan / kpi / docs
    const mode = this._screenMode;
    if (mode === 'plan') {
      panel(mx, top, midW, ph, 'План участка');
      this._drawPlanOnScreen(c, mx + 20, top + 70, midW - 40, ph - 90, data.geometry);
    } else if (mode === 'kpi') {
      panel(mx, top, midW, ph, 'Платформа за 30 дней');
      if (data.stats) {
        c.fillStyle = '#f3efe6'; c.font = '600 150px Georgia, serif';
        c.fillText(`${data.stats.requests}`, mx + 40, top + 90);
        c.font = '30px -apple-system, sans-serif'; c.fillStyle = 'rgba(243,239,230,.6)';
        c.fillText('обращений к моделям', mx + 44, top + 250);
        c.fillStyle = '#f3efe6'; c.font = '600 110px Georgia, serif';
        c.fillText(`${Math.round(data.stats.tokens / 1000)}k`, mx + 40, top + 320);
        c.font = '30px -apple-system, sans-serif'; c.fillStyle = 'rgba(243,239,230,.6)';
        c.fillText('токенов обработано', mx + 44, top + 440);
        // провайдеры
        let by = top + 90;
        for (const pr of (data.stats.byProvider || []).slice(0, 5)) {
          c.fillStyle = 'rgba(243,239,230,.85)'; c.font = '26px -apple-system, sans-serif';
          c.fillText(this._clip(c, pr.provider || pr.id || '', 260), mx + midW - 460, by);
          const wbar = Math.max(6, (pr.requests / Math.max(1, data.stats.requests)) * 300);
          c.fillStyle = 'rgba(255,255,255,.7)'; c.fillRect(mx + midW - 460, by + 36, wbar, 10);
          c.fillStyle = 'rgba(243,239,230,.5)'; c.font = '22px ui-monospace, monospace';
          c.fillText(`${pr.requests}`, mx + midW - 140, by + 30);
          by += 78;
        }
      }
    } else {
      panel(mx, top, midW, ph, 'Документы проекта');
      const docs = (data.docs || []).slice(0, 8);
      if (!docs.length) { c.fillStyle = 'rgba(243,239,230,.5)'; c.font = '30px -apple-system, sans-serif'; c.fillText('Файлы появятся после загрузки в модуль «Посадка здания»', mx + 40, top + 100); }
      docs.forEach((d, i) => {
        const col = i % 4, row = Math.floor(i / 4);
        const x = mx + 30 + col * ((midW - 60) / 4), yy = top + 80 + row * 300;
        const bw = (midW - 60) / 4 - 20, bh = 250;
        c.fillStyle = 'rgba(255,255,255,.07)'; c.beginPath(); c.roundRect(x, yy, bw, bh, 12); c.fill();
        const img = this._thumbImages.get(d.id);
        if (img && img.complete && img.naturalWidth) { try { c.drawImage(img, x + 10, yy + 10, bw - 20, bh - 70); } catch { /* битая */ } }
        else if (d.ext === 'pdf') this._loadThumb(d.id, data.project.id);
        else { c.fillStyle = 'rgba(243,239,230,.5)'; c.font = '600 40px -apple-system, sans-serif'; c.textAlign = 'center'; c.fillText(d.ext.toUpperCase().slice(0, 4), x + bw / 2, yy + 80); c.textAlign = 'left'; }
        c.fillStyle = 'rgba(243,239,230,.85)'; c.font = '22px -apple-system, sans-serif';
        c.fillText(this._clip(c, d.name, bw - 20), x + 10, yy + bh - 50);
      });
    }

    // справа: деньги и счета
    panel(rx, top, rightW, ph, 'Расход и счета');
    if (data.stats) {
      c.fillStyle = '#f3efe6'; c.font = '600 84px Georgia, serif';
      c.fillText(`$${(data.stats.costUsd || 0).toFixed(2)}`, rx + 30, top + 84);
      c.font = '24px -apple-system, sans-serif'; c.fillStyle = 'rgba(243,239,230,.6)';
      c.fillText(`за ${data.stats.days} дней · ${data.stats.requests} обращений`, rx + 32, top + 178);
      const days = data.stats.byDay || [];
      const bw = (rightW - 60) / Math.max(days.length, 1);
      const maxC = Math.max(...days.map((d) => d.costUsd), 0.01);
      for (let i = 0; i < days.length; i++) {
        const bh = Math.max(4, (days[i].costUsd / maxC) * 110);
        c.fillStyle = i === days.length - 1 ? '#ffffff' : 'rgba(255,255,255,.45)';
        c.beginPath(); c.roundRect(rx + 30 + i * bw, top + 340 - bh, Math.max(3, bw - 5), bh, 3); c.fill();
      }
    }
    c.fillStyle = 'rgba(243,239,230,.9)'; c.font = '600 28px -apple-system, sans-serif';
    c.fillText('Счета моделей', rx + 30, top + 380);
    let by = top + 428;
    for (const b of (data.balances || []).slice(0, 4)) {
      c.font = '26px -apple-system, sans-serif'; c.fillStyle = 'rgba(243,239,230,.85)';
      c.fillText(this._clip(c, b.label, rightW - 220), rx + 30, by);
      c.textAlign = 'right';
      c.font = '500 26px ui-monospace, monospace';
      c.fillText(b.availableUsd === null ? '—' : `$${Number(b.availableUsd).toFixed(2)}`, rx + rightW - 30, by);
      c.textAlign = 'left';
      by += 50;
    }
    // уведомление: смена состояния модуля — плашка терракотой в шапке
    for (const m of MODULES) {
      if (!this.life.isFlashing(m)) continue;
      const text = `${names[m]}: ${(data.modules && data.modules[m] && data.modules[m].line) || 'обновление'}`;
      c.font = '600 28px -apple-system, sans-serif';
      const tw = c.measureText(text).width + 70;
      c.fillStyle = brand.primary; c.beginPath(); c.roundRect(W / 2 - tw / 2, 92, tw, 48, 24); c.fill();
      c.fillStyle = '#fff'; c.textAlign = 'center'; c.fillText(text, W / 2, 102); c.textAlign = 'left';
      break;
    }
    // индикатор режима
    c.fillStyle = 'rgba(243,239,230,.35)'; c.font = '22px -apple-system, sans-serif';
    c.fillText(['план', 'платформа', 'документы'][['plan', 'kpi', 'docs'].indexOf(mode)] || '', mx + 30, bottom - 36);
    this.screenTexture.needsUpdate = true;
  }

  _clip(c, text, w) {
    let t = String(text);
    if (c.measureText(t).width <= w) return t;
    while (t.length > 2 && c.measureText(t + '…').width > w) t = t.slice(0, -1);
    return t + '…';
  }

  _loadThumb(fileId, projectId) {
    if (this._thumbImages.has(fileId)) return;
    const img = new Image();
    this._thumbImages.set(fileId, img);
    img.onload = () => { if (this._sceneData) this._drawScreen(this._sceneData); };
    img.src = `/api/office/doc-thumb/${fileId}?project=${encodeURIComponent(projectId)}`;
  }

  _drawPlanOnScreen(c, px, py, pw, ph, geometry) {
    c.save();
    c.beginPath(); c.rect(px, py, pw, ph); c.clip();
    if (!geometry || !geometry.parcel) {
      c.fillStyle = 'rgba(243,239,230,.45)'; c.font = '30px -apple-system, sans-serif'; c.textAlign = 'center';
      c.fillText('План участка появится после разбора чертежа', px + pw / 2, py + ph / 2 - 10);
      c.textAlign = 'left'; c.restore(); return;
    }
    const pts = geometry.parcel.geometry.points || [];
    const all = [...pts];
    for (const z of geometry.zones || []) this._collectPoints(z.geometry, all);
    const bb = this._bbox(all);
    const pad = 60;
    const scale = Math.min((pw - pad * 2) / (bb.w || 1), (ph - pad * 2 - 50) / (bb.h || 1));
    const tx = (x) => px + pad + (x - bb.minX) * scale;
    const ty = (y) => py + ph - pad - (y - bb.minY) * scale;
    const drawPoly = (points) => { c.beginPath(); points.forEach(([x, y], i) => (i ? c.lineTo(tx(x), ty(y)) : c.moveTo(tx(x), ty(y)))); c.closePath(); };
    for (const z of geometry.zones || []) {
      const st = window.ZoneStyle.zone(z.kind);
      for (const poly of this._polysOf(z.geometry)) {
        drawPoly(poly); c.save(); c.clip();
        c.strokeStyle = st.color; c.lineWidth = 1.6; c.globalAlpha = 0.8;
        const step = Math.max(8, st.spacing * 1.3), ang = (st.angle * Math.PI) / 180, diag = Math.hypot(pw, ph);
        for (let d = -diag; d < diag; d += step) {
          c.beginPath();
          c.moveTo(px + pw / 2 + Math.cos(ang) * -diag - Math.sin(ang) * d, py + ph / 2 + Math.sin(ang) * -diag + Math.cos(ang) * d);
          c.lineTo(px + pw / 2 + Math.cos(ang) * diag - Math.sin(ang) * d, py + ph / 2 + Math.sin(ang) * diag + Math.cos(ang) * d);
          c.stroke();
        }
        c.restore();
        drawPoly(poly); c.strokeStyle = st.color; c.globalAlpha = 0.95; c.lineWidth = 2; c.stroke(); c.globalAlpha = 1;
      }
    }
    if (geometry.buildable && geometry.buildable.geometry) {
      for (const poly of this._polysOf(geometry.buildable.geometry)) { drawPoly(poly); c.fillStyle = 'rgba(126,176,138,.12)'; c.fill(); c.setLineDash([10, 8]); c.strokeStyle = '#7eb08a'; c.lineWidth = 2; c.stroke(); c.setLineDash([]); }
    }
    drawPoly(pts); c.strokeStyle = '#f3efe6'; c.lineWidth = 4; c.stroke();
    const v = this._selectedVariant(geometry);
    if (v && v.footprint) {
      for (const poly of this._polysOf(v.footprint)) {
        drawPoly(poly); c.fillStyle = 'rgba(126,176,138,.45)'; c.fill();
        c.strokeStyle = '#a7d9b3'; c.lineWidth = 3 + Math.sin(this._time * 3) * 1; c.stroke();
      }
    }
    c.fillStyle = 'rgba(243,239,230,.85)'; c.font = '26px -apple-system, sans-serif';
    c.fillText(`Участок ${geometry.parcel.areaM2 ? geometry.parcel.areaM2 + ' м²' : ''} · зон ${(geometry.zones || []).length}${v ? ` · вариант №${v.number}, ${v.floors} эт.` : ''}`, px + 16, py + 10);
    c.restore();
  }

  _collectPoints(g, out) { for (const poly of this._polysOf(g)) for (const p of poly) out.push(p); }
  _polysOf(g) {
    if (!g) return [];
    if (g.type === 'multipolygon') return (g.polygons || []).map((p) => p.points || []);
    if (g.points) return [g.points];
    if (Array.isArray(g)) return [g];
    return [];
  }
  _bbox(points) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [x, y] of points) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
    if (!Number.isFinite(minX)) { minX = 0; minY = 0; maxX = 1; maxY = 1; }
    return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
  }
  _selectedVariant(geometry) {
    if (!geometry || !geometry.run || !geometry.run.variants) return null;
    const wanted = this._variantId ? geometry.run.variants.find((v) => v.id === this._variantId) : null;
    return wanted || geometry.run.variants.find((v) => v.selected) || geometry.run.variants[0] || null;
  }

  /* ---------- стол с участком ---------- */

  _buildTable() {
    const g = new THREE.Group();
    g.position.set(0, 0, -8.6);
    const rim = new THREE.Mesh(new RoundedBoxGeometry(3.72, 0.08, 2.62, 3, 0.03), new THREE.MeshStandardMaterial({ color: 0xb95740, roughness: 0.4, metalness: 0.3 }));
    rim.position.y = 0.93;
    g.add(rim);
    const top = new THREE.Mesh(new RoundedBoxGeometry(3.5, 0.06, 2.4, 3, 0.02), new THREE.MeshStandardMaterial({ color: 0x1d1a17, roughness: 0.22, metalness: 0.25 }));
    top.position.y = 0.995;
    top.castShadow = true; top.receiveShadow = true;
    g.add(top);
    const led = new THREE.Mesh(new THREE.BoxGeometry(3.62, 0.015, 2.52), new THREE.MeshBasicMaterial({ color: 0xff9a7a, transparent: true, opacity: 0.6 }));
    led.position.y = 0.885;
    g.add(led);
    this.life.strips.push(led);
    const pedestal = new THREE.Mesh(new RoundedBoxGeometry(2.2, 0.86, 1.2, 3, 0.05), P.MAT.graphite());
    pedestal.position.y = 0.43;
    g.add(pedestal);
    g.add(P.makeContactShadow(4.6, 3.4, 0.4));
    this.tableHolo = new THREE.Group();
    this.tableHolo.position.set(0, 1.03, 0);
    g.add(this.tableHolo);
    this.scene.add(g);
    this._tableGroup = g;
    this._pickable(g, { kind: 'table' });
    this._blockers.push({ x0: -2.1, x1: 2.1, z0: -10.1, z1: -7.1 });
    this.itemAnchors.set('table', { group: g, camPos: [1.5, 2.5, -6.6], camTgt: [0, 1.15, -8.6] });
    this._drawTablePlaceholder();
  }

  _drawTablePlaceholder() {
    this.tableHolo.clear();
    const { texture } = P.canvasTexture(512, 340, (ctx) => {
      ctx.fillStyle = '#1c2a38'; ctx.fillRect(0, 0, 512, 340);
      ctx.strokeStyle = 'rgba(255,255,255,.08)'; for (let i = 0; i < 512; i += 32) { ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, 340); ctx.stroke(); ctx.beginPath(); ctx.moveTo(0, i); ctx.lineTo(512, i); ctx.stroke(); }
      ctx.fillStyle = 'rgba(243,239,230,.8)'; ctx.font = '600 32px Georgia, serif'; ctx.textAlign = 'center';
      ctx.fillText('Стол проекта', 256, 150);
      ctx.font = '20px -apple-system, sans-serif'; ctx.fillStyle = 'rgba(243,239,230,.5)';
      ctx.fillText('план появится после разбора чертежа', 256, 195);
    });
    const plate = new THREE.Mesh(new THREE.PlaneGeometry(3.1, 2.05), new THREE.MeshBasicMaterial({ map: texture }));
    plate.rotation.x = -Math.PI / 2; plate.position.y = 0.004;
    this.tableHolo.add(plate);
  }

  setTableGeometry(geometry, variantId = '') {
    this._variantId = variantId || this._variantId;
    if (!geometry || !geometry.parcel) { this._drawTablePlaceholder(); return; }
    const hash = JSON.stringify([geometry.parcel.areaM2, (geometry.zones || []).length, geometry.run && geometry.run.createdAt, this._variantId]);
    if (hash === this._geomHash) return;
    this._geomHash = hash;
    this.tableHolo.clear();
    const pts = geometry.parcel.geometry.points || [];
    const bb = this._bbox(pts);
    const scale = Math.min(3.0 / (bb.w || 1), 1.95 / (bb.h || 1));
    const cx = (bb.minX + bb.maxX) / 2, cy = (bb.minY + bb.maxY) / 2;
    const map = ([x, y]) => [(x - cx) * scale, -(y - cy) * scale];
    const shapeOf = (poly) => { const s = new THREE.Shape(); poly.forEach((pt, i) => { const [x, z] = map(pt); if (i) s.lineTo(x, z); else s.moveTo(x, z); }); s.closePath(); return s; };

    const parcelMesh = new THREE.Mesh(new THREE.ExtrudeGeometry(shapeOf(pts), { depth: 0.025, bevelEnabled: false }), new THREE.MeshStandardMaterial({ color: this.dark ? 0x3d4a3f : 0xdfe8d8, roughness: 0.6 }));
    parcelMesh.rotation.x = -Math.PI / 2; parcelMesh.receiveShadow = true;
    this.tableHolo.add(parcelMesh);
    const outline = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts.map((pt) => { const [x, z] = map(pt); return new THREE.Vector3(x, 0.04, z); })), new THREE.LineBasicMaterial({ color: 0x26211b }));
    this.tableHolo.add(outline);
    if (geometry.buildable && geometry.buildable.geometry) {
      for (const poly of this._polysOf(geometry.buildable.geometry)) {
        if (poly.length < 3) continue;
        try {
          const b = new THREE.Mesh(new THREE.ShapeGeometry(shapeOf(poly)), new THREE.MeshBasicMaterial({ color: 0x7eb08a, transparent: true, opacity: 0.18, side: THREE.DoubleSide }));
          b.rotation.x = -Math.PI / 2; b.position.y = 0.032; this.tableHolo.add(b);
        } catch { /* контур */ }
      }
    }
    for (const z of (geometry.zones || []).slice(0, 40)) {
      const st = window.ZoneStyle.zone(z.kind);
      for (const poly of this._polysOf(z.geometry)) {
        if (poly.length < 3) continue;
        try {
          const zone = new THREE.Mesh(new THREE.ExtrudeGeometry(shapeOf(poly), { depth: 0.18, bevelEnabled: false }), new THREE.MeshPhysicalMaterial({ color: new THREE.Color(st.color), transparent: true, opacity: 0.26, roughness: 0.2, transmission: 0.2, depthWrite: false }));
          zone.rotation.x = -Math.PI / 2; zone.position.y = 0.03;
          zone.userData.pick = { kind: 'zone', id: z.id, label: z.label, zone: z };
          this.tableHolo.add(zone);
          const edge = new THREE.LineSegments(new THREE.EdgesGeometry(zone.geometry), new THREE.LineBasicMaterial({ color: new THREE.Color(st.color), transparent: true, opacity: 0.7 }));
          edge.rotation.x = -Math.PI / 2; edge.position.y = 0.03;
          this.tableHolo.add(edge);
        } catch { /* дырявый полигон */ }
      }
    }
    const v = this._selectedVariant(geometry);
    if (v && v.footprint) {
      const floors = Math.max(1, Math.round(v.floors || 1));
      this._buildingFloors = [];
      for (const poly of this._polysOf(v.footprint)) {
        if (poly.length < 3) continue;
        for (let f = 0; f < floors; f++) {
          try {
            const floor = new THREE.Mesh(new THREE.ExtrudeGeometry(shapeOf(poly), { depth: 0.12, bevelEnabled: true, bevelThickness: 0.004, bevelSize: 0.004, bevelSegments: 1 }), new THREE.MeshStandardMaterial({ color: f === floors - 1 ? 0xf3efe6 : 0xe6dfd0, roughness: 0.5 }));
            floor.rotation.x = -Math.PI / 2; floor.position.y = 0.04 + f * 0.125;
            floor.scale.set(1, 0.001, 1);
            floor.castShadow = true;
            floor.userData.pick = { kind: 'building', variant: v };
            this.tableHolo.add(floor);
            // окна-полосы на этаже
            this._buildingFloors.push({ mesh: floor, delay: 0.3 + f * 0.4 });
          } catch { /* сложный контур */ }
        }
      }
      this._buildStart = this._time;
    }
  }

  /* ---------- столы амфитеатра ---------- */

  _deskPositions() {
    const out = [];
    const rnd = this._seeded(11);
    TIERS.forEach((t, ri) => {
      const r = (t.r0 + t.r1) / 2 + 0.2;
      const span = 1.28 - ri * 0.04;
      for (let i = 0; i < t.count; i++) {
        let a = ((i + 0.5) / t.count - 0.5) * span + (rnd() - 0.5) * 0.04;
        // центральный проход к экрану свободен: столы отодвигаются от оси на 0.12 рад
        a += (a >= 0 ? 1 : -1) * 0.12;
        const x = FOCUS.x + Math.sin(a) * r + (rnd() - 0.5) * 0.3;
        const z = FOCUS.z + Math.cos(a) * r;
        out.push({ x, z, y: t.y, yaw: Math.atan2(x - FOCUS.x, z - FOCUS.z) + (rnd() - 0.5) * 0.1, row: ri, col: i });
      }
    });
    return out;
  }

  _seeded(seed) { let s = seed; return () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; }; }

  _buildDesks() {
    const positions = this._deskPositions();
    const personas = window.OfficeData.personas;
    const deskOf = {};
    for (const [mod, cfg] of Object.entries(personas)) {
      const found = positions.findIndex((d) => d.row === cfg.deskRow && d.col === cfg.deskCol);
      deskOf[mod] = found >= 0 ? found : Object.keys(deskOf).length;
    }
    // общий «спящий» экран для незанятых мониторов
    this._idle = P.canvasTexture(768, 256, () => {});
    this._idle.texture.wrapS = THREE.RepeatWrapping; this._idle.texture.repeat.x = -1;
    this._drawIdle();
    positions.forEach((pos, i) => {
      const mod = Object.keys(deskOf).find((m) => deskOf[m] === i) || null;
      this._desks.push(this._makeDesk(pos, mod, i));
    });
  }

  _drawIdle() {
    const { ctx: c, canvas, texture } = this._idle;
    const W = canvas.width, H = canvas.height;
    c.fillStyle = '#0d1117'; c.fillRect(0, 0, W, H);
    const t = this._time;
    const x = (Math.sin(t * 0.25) * 0.5 + 0.5) * (W - 260) + 20;
    const y = (Math.cos(t * 0.19) * 0.5 + 0.5) * (H - 90) + 20;
    c.fillStyle = 'rgba(243,239,230,.55)'; c.font = '600 44px Georgia, serif'; c.textBaseline = 'top';
    c.fillText('ENSO', x, y);
    c.fillStyle = 'rgba(208,113,90,.8)'; c.font = '18px -apple-system, sans-serif';
    c.fillText('nexus · ' + new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }), x + 2, y + 50);
    texture.needsUpdate = true;
  }

  _makeDesk(pos, module, index) {
    const g = P.makeDeskPod();
    g.position.set(pos.x, pos.y, pos.z);
    g.rotation.y = pos.yaw;
    let mc = null;
    if (module) {
      mc = P.canvasTexture(1024, 342, () => {});
      this.monitors.set(module, mc);
    }
    const mon = P.makeMonitor({ texture: module ? mc.texture : this._idle.texture });
    mon.position.set(0, 1.2, 0.42); // ось группы — у человека, панель (−R) над задней третью стола, подошва на столешнице
    g.add(mon);
    const kb = P.makeKeyboard(); kb.position.set(-0.08, 0.775, 0.14); g.add(kb);
    const mouse = P.makeMouse(); mouse.position.set(0.28, 0.775, 0.16); g.add(mouse);
    const nb = P.makeNotebook(); nb.position.set(-0.56, 0.775, 0.1); nb.rotation.y = 0.2; g.add(nb);
    const pen = P.makePen(); pen.position.set(-0.55, 0.78, 0.26); pen.rotation.y = 0.4; g.add(pen);
    const pencil = P.makePerfectPencil(); pencil.position.set(-0.6, 0.78, 0.31); pencil.rotation.y = -0.2; g.add(pencil);
    const mug = P.makeMug(); mug.position.set(0.62, 0.775, -0.05); g.add(mug);
    mug.traverse((m) => { m.userData.keep = true; });
    if (index % 3 === 0) { const ph = P.makePhone(); ph.position.set(0.5, 0.775, 0.26); ph.rotation.y = -0.3; g.add(ph); }
    if (index % 4 === 1) { const pl = P.makeFicus(0.28); pl.position.set(-0.72, 0.775, -0.2); g.add(pl); pl.traverse((m) => { if (m.userData.sway) { this.life.plants.push(m); m.userData.keep = true; } }); }
    const chair = P.makeChair(); chair.position.set(0, 0, 0.62); g.add(chair);
    const cs = P.makeContactShadow(2.6, 1.7, 0.32); cs.position.set(0.05, 0.006, 0.2); g.add(cs);
    // ~40 мешей стола → несколько по материалам; человек добавляется после
    P.mergeStatic(g);

    let person = null;
    if (module) {
      const cfg = window.OfficeData.personas[module];
      person = P.makePerson({ skin: cfg.skin, hair: cfg.hair, glasses: cfg.glasses, female: !!cfg.female, polo: this.brand.poloHex || 0xb95740 });
      person.group.position.set(0, 0, 0.46);   // спина у спинки кресла (внутренняя дуга — z 0.56)
      g.add(person.group);
      this.people.set(module, person);
      const handMug = P.makeMug(); handMug.scale.setScalar(0.9); handMug.visible = false;
      person.armR.elbow.add(handMug); handMug.position.set(0, -0.28, -0.02);
      this.life.addAgent(module, person, { mug, handMug });
      this._pickable(g, { kind: 'agent', module });
    } else {
      this._pickable(g, { kind: 'desk' });
    }
    this.scene.add(g);
    g.updateMatrixWorld(true);
    this._blockers.push({ x: pos.x, z: pos.z, r: 1.0 });
    if (module) {
      const camPos = g.localToWorld(new THREE.Vector3(1.35, 1.75, 1.35));
      const camTgt = g.localToWorld(new THREE.Vector3(-0.1, 1.05, -0.1));
      this.itemAnchors.set(`agent:${module}`, { group: g, camPos: camPos.toArray(), camTgt: camTgt.toArray(), walk: g.localToWorld(new THREE.Vector3(1.4, 0, 1.4)), look: camTgt });
      const cfg = window.OfficeData.personas[module];
      if (['cube', 'chess', 'go'].includes(cfg.item)) this._placeItemAnchor(cfg.item, g);
    }
    return { group: g, module, person, pos };
  }

  _placeItemAnchor(item, deskGroup) {
    const holder = new THREE.Group();
    holder.position.set(0.55, 0.775, 0.34);
    deskGroup.add(holder);
    deskGroup.updateMatrixWorld(true);
    const world = new THREE.Vector3(); holder.getWorldPosition(world);
    const camPos = deskGroup.localToWorld(new THREE.Vector3(1.2, 1.3, 0.8));
    this.itemAnchors.set(item, { group: holder, camPos: camPos.toArray(), camTgt: [world.x, world.y + 0.08, world.z], walk: deskGroup.localToWorld(new THREE.Vector3(1.3, 0, 0.9)), look: world });
    this._pickable(holder, { kind: 'item', item });
  }

  /** монитор агента: живой дашборд модуля — данные настоящие, пластика живая */
  _drawMonitor(module, data) {
    const mc = this.monitors.get(module);
    if (!mc) return;
    const c = mc.ctx, W = mc.canvas.width, H = mc.canvas.height;
    const t = this._time;
    const brand = this.brand;
    c.fillStyle = '#0f1520'; c.fillRect(0, 0, W, H);
    // верхняя полоса бренда
    c.fillStyle = brand.primary; c.fillRect(0, 0, W, 10);
    c.fillStyle = 'rgba(243,239,230,.55)'; c.font = '600 20px -apple-system, sans-serif'; c.textBaseline = 'top';
    c.fillText(brand.name.toUpperCase() + ' · ENSO-NEXUS', 28, 24);
    c.textAlign = 'right';
    c.fillStyle = 'rgba(243,239,230,.7)'; c.font = '500 22px ui-monospace, monospace';
    c.fillText(new Date().toLocaleTimeString('ru-RU'), W - 28, 22);
    c.textAlign = 'left';
    const names = window.OfficeData.moduleNames;
    c.fillStyle = '#f3efe6'; c.font = '600 40px -apple-system, sans-serif';
    c.fillText(names[module] || module, 28, 56);
    const s = data && data.modules ? data.modules[module] : null;
    // статус
    c.fillStyle = STATE_COLORS[(s && s.state) || 'none'];
    c.beginPath(); c.arc(44, 128, 9, 0, Math.PI * 2); c.fill();
    c.fillStyle = 'rgba(243,239,230,.85)'; c.font = '24px -apple-system, sans-serif';
    c.fillText(this._clip(c, s ? s.line : 'проект не выбран', 540), 64, 116);
    // левая колонка: журнал / строки
    const lines = [];
    if (data) {
      if (module === 'site' && data.journal && data.journal.length) for (const e of data.journal.slice(-5)) lines.push(`${new Date(e.at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}  ${e.stage}: ${e.detail || ''}`);
      else if (s && s.at) lines.push(`последний прогон: ${new Date(s.at).toLocaleString('ru-RU')}`);
      if (module === 'site' && data.progress && data.progress.label) lines.unshift(`▸ ${data.progress.label}`);
    }
    if (!lines.length) lines.push('очередь пуста — мониторинг');
    c.font = '19px ui-monospace, Menlo, monospace';
    let y = 160;
    for (const line of lines.slice(0, 5)) {
      c.fillStyle = line.startsWith('▸') ? brand.primary : 'rgba(243,239,230,.7)';
      c.fillText(this._clip(c, line, 600), 28, y);
      y += 28;
    }
    // мигающий курсор
    if (Math.floor(t * 2) % 2 === 0) { c.fillStyle = brand.primary; c.fillRect(28, y + 2, 12, 20); }
    // правая колонка: пульс платформы по дням (настоящие данные)
    const days = (data && data.stats && data.stats.byDay) || [];
    c.fillStyle = 'rgba(243,239,230,.5)'; c.font = '18px -apple-system, sans-serif';
    c.fillText('обращения по дням', 680, 116);
    const maxR = Math.max(1, ...days.map((d) => d.requests));
    c.strokeStyle = brand.primary; c.lineWidth = 2.5; c.beginPath();
    days.forEach((d, i) => {
      const x = 680 + (i / Math.max(1, days.length - 1)) * 300;
      const yy = 250 - (d.requests / maxR) * 90;
      if (i) c.lineTo(x, yy); else c.moveTo(x, yy);
    });
    c.stroke();
    // бегущая точка — «живой» сигнал
    const k = (t * 0.15) % 1;
    c.fillStyle = '#f3efe6'; c.beginPath(); c.arc(680 + k * 300, 250 - Math.abs(Math.sin(k * 9)) * 40, 4, 0, Math.PI * 2); c.fill();
    c.fillStyle = 'rgba(243,239,230,.35)'; c.font = '16px -apple-system, sans-serif';
    c.fillText('мониторинг · ' + (s && s.state === 'run' ? 'ИДЁТ ПРОГОН' : 'ожидание задач'), 680, 268);
    // вспышка при смене состояния
    if (this.life.isFlashing(module)) { c.fillStyle = `rgba(208,113,90,${0.15 + Math.sin(t * 10) * 0.1})`; c.fillRect(0, 0, W, H); }
    mc.texture.needsUpdate = true;
  }

  /* ---------- лобби ---------- */

  _buildLobby() {
    const y0 = CONCOURSE_Y;
    // стойка
    const g = new THREE.Group();
    g.position.set(0, y0, 14.6);
    const counter = new THREE.Mesh(new RoundedBoxGeometry(3.6, 1.08, 0.9, 4, 0.08), P.MAT.white());
    counter.position.y = 0.54; counter.castShadow = true;
    g.add(counter);
    // фасад — деревянные ламели с шагом 0.06
    const slats = new THREE.InstancedMesh(new THREE.BoxGeometry(0.04, 1.0, 0.03), P.std(0xc9ad84, { roughness: 0.6 }), 58);
    const sm = new THREE.Matrix4(); const scol = new THREE.Color();
    for (let i = 0; i < 58; i++) { sm.makeTranslation(-1.71 + i * 0.06, 0.54, 0.46); slats.setMatrixAt(i, sm); slats.setColorAt(i, scol.setHSL(0.09, 0.35, 0.6 + (Math.random() - 0.5) * 0.08)); }
    slats.instanceMatrix.needsUpdate = true;
    g.add(slats);
    const counterTop = new THREE.Mesh(new RoundedBoxGeometry(3.7, 0.05, 1.0, 2, 0.015), new THREE.MeshPhysicalMaterial({ color: 0x26211b, roughness: 0.3, clearcoat: 0.3 }));
    counterTop.position.y = 1.11;
    g.add(counterTop);
    const edge = new THREE.Mesh(new THREE.BoxGeometry(3.72, 0.02, 1.02), P.MAT.terracotta());
    edge.position.y = 1.075; g.add(edge);
    for (let i = 0; i < 4; i++) { const sheet = new THREE.Mesh(new THREE.BoxGeometry(0.21, 0.003, 0.297), P.std(0xf3efe6, { roughness: 0.9 })); sheet.position.set(-1.2 + i * 0.01, 1.14 + i * 0.003, 0.1 + i * 0.008); sheet.rotation.y = i * 0.05; g.add(sheet); }
    const bell = new THREE.Mesh(new THREE.SphereGeometry(0.05, 16, 12, 0, Math.PI * 2, 0, Math.PI / 2), P.MAT.chrome()); bell.position.set(1.3, 1.135, 0.15); g.add(bell);
    const cs = P.makeContactShadow(4.4, 1.6, 0.35); cs.position.set(0, 0.006, 0); g.add(cs);
    const counterLed = new THREE.Mesh(new THREE.BoxGeometry(3.5, 0.02, 0.02), new THREE.MeshBasicMaterial({ color: 0xfff1e0, transparent: true, opacity: 0.75 }));
    counterLed.position.set(0, 0.12, 0.46);
    g.add(counterLed); this.life.strips.push(counterLed);
    const logo = P.canvasTexture(512, 160, (c) => { c.clearRect(0, 0, 512, 160); c.fillStyle = 'rgba(38,33,27,.85)'; c.font = '600 92px Georgia, serif'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText('ENSO', 256, 80); });
    const logoMesh = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.28), new THREE.MeshBasicMaterial({ map: logo.texture, transparent: true }));
    logoMesh.position.set(0, 0.6, 0.48);
    g.add(logoMesh);
    // секретарь стоит за стойкой
    const s = P.makePerson({ hair: 0x4b3222, skin: 0xf0cdaa, female: true, standing: true, polo: this.brand.poloHex || 0xb95740 });
    s.group.position.set(0, 0, -0.85);
    s.group.rotation.y = Math.PI; // лицо модели смотрит в −z, гость входит с +z
    g.add(s.group);
    this.secretary = s;
    // монитор секретаря и телефон
    const smon = P.makeMonitor({ texture: this._idle.texture }); smon.scale.setScalar(0.6); smon.position.set(-0.9, 1.37, -0.55); smon.rotation.y = Math.PI; g.add(smon);
    const ph = P.makePhone(); ph.position.set(0.8, 1.15, -0.1); g.add(ph);
    this.scene.add(g);
    this._pickable(g, { kind: 'secretary' });
    this._blockers.push({ x0: -1.9, x1: 1.9, z0: 14.0, z1: 15.7 });
    this.itemAnchors.set('secretary', { group: g, camPos: [0, y0 + 1.7, 17.2], camTgt: [0, y0 + 1.4, 14.2], walk: [0, 17.0], look: [0, 14.2] });

    /*
     * МОСС-СТЕНА — ПОДУШКИ ГЕОМЕТРИЕЙ (К17). Плоский короб с bumpScale 0.03
     * рельефа не давал: с двух метров панель читалась зелёным прямоугольником.
     * Теперь это подложка + инстансы полусфер пяти оттенков ягеля разного
     * размера, как в настоящей стабилизированной стене.
     */
    const MOSS_TONES = [0x3f7a48, 0x568a4e, 0x2f5a3a, 0x6d9a5a, 0x476b3f];
    for (const sx of [-7.4, 7.4]) {
      const backing = new THREE.Mesh(new THREE.BoxGeometry(3.6, 5.2, 0.1), new THREE.MeshStandardMaterial({ color: 0x24361f, roughness: 1 }));
      backing.position.set(sx, y0 + 2.7, 20.86);
      this.scene.add(backing);
      const cushionG = new THREE.SphereGeometry(1, 8, 6);
      MOSS_TONES.forEach((tone, ti) => {
        const per = 150;
        const inst = new THREE.InstancedMesh(cushionG, new THREE.MeshStandardMaterial({ color: tone, roughness: 1, flatShading: true }), per);
        const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), pos = new THREE.Vector3();
        for (let i = 0; i < per; i++) {
          const r = 0.09 + Math.random() * 0.17;
          pos.set(sx - 1.72 + Math.random() * 3.44, y0 + 0.18 + Math.random() * 5.04, 20.81 - Math.random() * 0.06);
          q.setFromEuler(new THREE.Euler(Math.random() * 3, Math.random() * 3, Math.random() * 3));
          sc.set(r, r * (0.7 + Math.random() * 0.5), r * (0.55 + Math.random() * 0.3));
          m4.compose(pos, q, sc); inst.setMatrixAt(i, m4);
        }
        inst.instanceMatrix.needsUpdate = true;
        inst.castShadow = ti < 2;
        this.scene.add(inst);
      });
    }
    const lacquer = new THREE.Mesh(new THREE.BoxGeometry(10.6, 5.2, 0.18), new THREE.MeshStandardMaterial({ color: 0x0f0f10, roughness: 0.18, metalness: 0.25 }));
    lacquer.position.set(0, y0 + 2.7, 20.86);
    this.scene.add(lacquer);
    const sign = P.canvasTexture(1600, 640, (c) => this._drawBrandSign(c, null));
    this._brandSign = sign;
    const signMesh = new THREE.Mesh(new THREE.PlaneGeometry(8.0, 3.2), new THREE.MeshBasicMaterial({ map: sign.texture, transparent: true, toneMapped: false }));
    signMesh.position.set(0, y0 + 2.9, 20.75); signMesh.rotation.y = Math.PI;
    this.scene.add(signMesh);
    if (this.brand.logoUrl) {
      const img = new Image();
      img.onload = () => { this._logoImg = img; this._drawBrandSign(sign.ctx, img); sign.texture.needsUpdate = true; if (this._sceneData) this._drawScreen(this._sceneData); };
      img.src = this.brand.logoUrl;
    }
    const signLed = new THREE.Mesh(new THREE.BoxGeometry(10.4, 0.03, 0.03), new THREE.MeshBasicMaterial({ color: 0xfff1e0, transparent: true, opacity: 0.8 }));
    signLed.position.set(0, y0 + 5.32, 20.72); this.scene.add(signLed); this.life.strips.push(signLed);
    // направления деятельности — тонкая полоса над проёмом со стороны лобби
    const dirs = (this.brand.directions || []).join('   ·   ');
    const strip = P.canvasTexture(2048, 128, (c) => {
      c.clearRect(0, 0, 2048, 128);
      c.fillStyle = 'rgba(243,239,230,.85)'; c.font = '500 44px -apple-system, "Helvetica Neue", sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle';
      c.fillText(dirs, 1024, 64);
    });
    const stripMesh = new THREE.Mesh(new THREE.PlaneGeometry(9.0, 0.56), new THREE.MeshBasicMaterial({ map: strip.texture, transparent: true, toneMapped: false }));
    stripMesh.position.set(0, 7.35, 11.18); // на перемычке проёма, лицом в лобби
    this.scene.add(stripMesh);

    // таблички с двойной рамой
    (window.OfficeData.plaques || []).forEach((pl, i) => {
      const t = P.canvasTexture(512, 360, (c) => {
        c.fillStyle = this.dark ? '#2a251e' : '#fdfbf4'; c.fillRect(0, 0, 512, 360);
        c.strokeStyle = this.brand.primary; c.lineWidth = 8; c.strokeRect(16, 16, 480, 328);
        c.strokeStyle = 'rgba(0,0,0,.18)'; c.lineWidth = 2; c.strokeRect(32, 32, 448, 296);
        c.fillStyle = this.dark ? '#efe9dd' : '#26211b'; c.font = '600 88px Georgia, serif'; c.textAlign = 'center'; c.textBaseline = 'alphabetic';
        c.fillText(pl.title, 256, 170);
        c.font = '30px -apple-system, sans-serif'; c.fillStyle = this.dark ? '#9a8f80' : '#6f665a';
        this._wrapText(c, pl.sub, 256, 232, 400, 38);
      });
      // на перегородке лобби по обе стороны проёма, лицом к входящему (боковые стены лобби — стекло крыльев)
      const side = i < 3 ? -1 : 1;
      const m = new THREE.Group();
      // полотно ВПЕРЕДИ рамы: при равных z грани спорили и полотно проступало рябью
      const art = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 1.05), new THREE.MeshBasicMaterial({ map: t.texture, toneMapped: false }));
      art.position.z = 0.033; m.add(art);
      // рама из четырёх брусков по контуру, за полотном — паспарту, а не глухой короб
      const fmat = P.MAT.walnut();
      const back = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 1.05), P.std(0xf3efe6, { roughness: 0.9 }));
      back.position.z = 0.028; m.add(back);
      for (const [bw, bh, bx, by] of [[1.62, 0.06, 0, 0.555], [1.62, 0.06, 0, -0.555], [0.06, 1.17, -0.78, 0], [0.06, 1.17, 0.78, 0]]) {
        const bar = new THREE.Mesh(new THREE.BoxGeometry(bw, bh, 0.05), fmat);
        bar.position.set(bx, by, 0.02); m.add(bar);
      }
      const lamp = new THREE.PointLight(0xfff0dd, 0.35, 2.4, 2); lamp.position.set(0, 0.75, 0.35); m.add(lamp);
      m.position.set(side * (7.0 + (i % 3) * 2.4), y0 + 2.2, 11.2);
      this.scene.add(m);
      this._pickable(m, { kind: 'plaque', index: i });
    });

    // диваны и растения лобби
    for (const sx of [-8.6, 8.6]) {
      const sofa = new THREE.Mesh(new RoundedBoxGeometry(2.4, 0.5, 0.95, 3, 0.1), P.MAT.terracotta());
      sofa.position.set(sx, y0 + 0.25, 17.8); sofa.castShadow = true; this.scene.add(sofa);
      const back = new THREE.Mesh(new RoundedBoxGeometry(2.4, 0.55, 0.2, 3, 0.08), P.MAT.terracotta());
      back.position.set(sx, y0 + 0.75, 18.2); this.scene.add(back);
      this._blockers.push({ x0: sx - 1.3, x1: sx + 1.3, z0: 17.2, z1: 18.4 });
      const table = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.4, 0.04, 24), P.MAT.walnut());
      table.position.set(sx, y0 + 0.42, 16.6); this.scene.add(table);
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.4, 8), P.MAT.chrome());
      leg.position.set(sx, y0 + 0.2, 16.6); this.scene.add(leg);
    }
    for (const [x, z] of [[-8.5, 19.5], [8.5, 19.5], [-3.2, 12.2], [3.2, 12.2]]) {
      const pl = P.makeMonstera(1.1); pl.position.set(x, y0, z); this.scene.add(pl);
      pl.traverse((m) => { if (m.userData.sway) this.life.plants.push(m); });
      this._blockers.push({ x: x, z: z, r: 0.5 });
    }
  }

  /* ---------- чайная зона ---------- */

  _buildLounge() {
    const y0 = CONCOURSE_Y;
    const g = new THREE.Group();
    g.position.set(12.4, y0, 8.2);
    const table = new THREE.Mesh(new THREE.CylinderGeometry(0.75, 0.75, 0.05, 32), P.MAT.walnut());
    table.position.y = 0.55; table.castShadow = true; g.add(table);
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.1, 0.55, 12), P.MAT.walnut()); leg.position.y = 0.27; g.add(leg);
    const tray = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.34, 0.02, 24), new THREE.MeshStandardMaterial({ color: 0x4a3625, roughness: 0.3 })); tray.position.y = 0.585; g.add(tray);
    const potBody = new THREE.Mesh(new THREE.SphereGeometry(0.11, 18, 14), new THREE.MeshStandardMaterial({ color: 0x7a4a33, roughness: 0.35 }));
    potBody.scale.y = 0.8; potBody.position.set(0, 0.68, 0); g.add(potBody);
    const spout = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.03, 0.16, 8), new THREE.MeshStandardMaterial({ color: 0x7a4a33 })); spout.rotation.z = 1.0; spout.position.set(0.14, 0.7, 0); g.add(spout);
    const knob = new THREE.Mesh(new THREE.SphereGeometry(0.02, 8, 8), P.MAT.walnut()); knob.position.set(0, 0.78, 0); g.add(knob);
    this.teapot = potBody;
    for (let i = 0; i < 5; i++) {
      const cup = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.028, 0.035, 12, 1, true), new THREE.MeshStandardMaterial({ color: 0xf1ebdf, side: THREE.DoubleSide, roughness: 0.3 }));
      cup.position.set(Math.cos(i * 1.26) * 0.28, 0.6, Math.sin(i * 1.26) * 0.28); g.add(cup);
    }
    const steam = makeSteam(); steam.position.set(0.16, 0.78, 0); g.add(steam); this.life.steam = steam;
    const tm = P.makePerson({ hair: 0x1d1a17, skin: 0xd9a878, polo: this.brand.poloHex || 0xb95740 });
    tm.group.position.set(0, 0, 1.05); g.add(tm.group); // лицом к столу (−z)
    this.teaMaster = tm;
    for (const a of [-0.9, 2.2, 4.0]) {
      const st = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.25, 0.45, 16), P.MAT.white());
      st.position.set(Math.cos(a) * 1.15, 0.22, Math.sin(a) * 1.15); g.add(st);
    }
    const pl = P.makeFicus(1.2); pl.position.set(1.9, 0, -0.6); g.add(pl); pl.traverse((m) => { if (m.userData.sway) this.life.plants.push(m); });
    this.scene.add(g);
    this._pickable(g, { kind: 'item', item: 'tea' });
    this._blockers.push({ x: 12.4, z: 8.2, r: 1.0 });
    this.itemAnchors.set('tea', { group: g, camPos: [10.4, y0 + 1.7, 6.5], camTgt: [12.4, y0 + 0.8, 8.2], walk: [10.6, 6.8], look: [12.4, 8.2] });
  }

  /* ---------- кульман, макет, нивелир ---------- */

  _buildWallProps() {
    const y0 = CONCOURSE_Y;
    const g = new THREE.Group();
    g.position.set(-13.0, y0, 4.2);
    g.rotation.y = Math.PI / 2.3;
    const board = new THREE.Mesh(new RoundedBoxGeometry(1.7, 1.2, 0.05, 2, 0.01), P.MAT.white());
    board.position.set(0, 1.45, 0); board.rotation.x = -0.28; g.add(board);
    const drawing = P.canvasTexture(1024, 720, (c) => this._drawBlueprint(c));
    const sheet = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 1.0), new THREE.MeshBasicMaterial({ map: drawing.texture, toneMapped: false }));
    sheet.position.set(0, 1.46, 0.033); sheet.rotation.x = -0.28; g.add(sheet);
    const ruler = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.03, 0.02), P.MAT.brushed()); ruler.position.set(0, 1.25, 0.06); ruler.rotation.x = -0.28; g.add(ruler);
    // рейсшина с кареткой на направляющей, угольник, зажимы, лоток с карандашами, табурет
    const rail = new THREE.Mesh(new THREE.BoxGeometry(0.05, 1.18, 0.03), P.MAT.brushed()); rail.position.set(-0.86, 1.45, 0.05); rail.rotation.x = -0.28; g.add(rail);
    const carriage = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.14, 0.06), P.MAT.graphite()); carriage.position.set(-0.86, 1.62, 0.07); carriage.rotation.x = -0.28; g.add(carriage);
    const tsq = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.025, 0.02), P.MAT.brushed()); tsq.position.set(-0.05, 1.62, 0.075); tsq.rotation.x = -0.28; g.add(tsq);
    const setsq = new THREE.Mesh(new THREE.ShapeGeometry((() => { const sh = new THREE.Shape(); sh.moveTo(0, 0); sh.lineTo(0.32, 0); sh.lineTo(0, 0.24); sh.closePath(); return sh; })()), new THREE.MeshPhysicalMaterial({ color: 0xe3b96a, transparent: true, opacity: 0.55, roughness: 0.1, side: THREE.DoubleSide }));
    setsq.position.set(0.25, 1.3, 0.05); setsq.rotation.x = -0.28; g.add(setsq);
    for (const sx of [-0.62, 0.62]) { const clip = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.05, 0.03), P.MAT.black()); clip.position.set(sx, 1.98, 0.05); clip.rotation.x = -0.28; g.add(clip); }
    const tray = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.04, 0.09), P.MAT.walnut()); tray.position.set(0.35, 0.82, 0.24); g.add(tray);
    for (let i = 0; i < 5; i++) { const pen = i % 2 ? P.makePen() : P.makePerfectPencil(); pen.position.set(0.15 + i * 0.09, 0.85, 0.24); pen.rotation.y = Math.PI / 2 + (Math.random() - 0.5) * 0.3; g.add(pen); }
    const stool = new THREE.Mesh(new THREE.CylinderGeometry(0.19, 0.19, 0.06, 20), P.MAT.walnut()); stool.position.set(0.2, 0.7, 0.85); g.add(stool);
    const stoolPole = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.68, 8), P.MAT.chrome()); stoolPole.position.set(0.2, 0.36, 0.85); g.add(stoolPole);
    const stoolBase = new THREE.Mesh(new THREE.TorusGeometry(0.22, 0.02, 8, 24), P.MAT.chrome()); stoolBase.rotation.x = Math.PI / 2; stoolBase.position.set(0.2, 0.03, 0.85); g.add(stoolBase);
    g.add(P.makeContactShadow(2.2, 1.6, 0.35));
    for (const sx of [-0.6, 0.6]) {
      for (const [z, rx] of [[0.25, 0.2], [-0.25, -0.2]]) {
        const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 1.8, 8), P.MAT.brushed());
        leg.position.set(sx, 0.9, z); leg.rotation.x = rx; g.add(leg);
      }
    }
    const lamp = new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.16, 16, 1, true), P.MAT.graphite()); lamp.position.set(0.6, 2.2, -0.2); lamp.rotation.x = 0.6; g.add(lamp);
    const lampLight = new THREE.PointLight(0xffe2c0, 0.6, 3, 2); lampLight.position.set(0.6, 2.1, -0.1); g.add(lampLight);
    this.scene.add(g);
    this._pickable(g, { kind: 'item', item: 'drafting' });
    this._blockers.push({ x: -13.0, z: 4.2, r: 1.1 });
    this.itemAnchors.set('drafting', { group: g, camPos: [-11.0, y0 + 1.8, 5.6], camTgt: [-13.0, y0 + 1.4, 4.2], walk: [-11.2, 5.5], look: [-13, 4.2] });

    // макет на подиуме под стеклом
    const shelf = new THREE.Group();
    shelf.position.set(13.6, y0, -2.0);
    shelf.rotation.y = -Math.PI / 2;
    const plinth = new THREE.Mesh(new RoundedBoxGeometry(1.4, 0.95, 0.8, 3, 0.03), P.MAT.white()); plinth.position.y = 0.475; plinth.castShadow = true; shelf.add(plinth);
    const modelBase = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.03, 0.6), new THREE.MeshStandardMaterial({ color: 0xdde7d9 })); modelBase.position.y = 0.965; shelf.add(modelBase);
    const b1 = new THREE.Mesh(new RoundedBoxGeometry(0.55, 0.18, 0.32, 2, 0.01), P.MAT.white()); b1.position.set(-0.15, 1.07, 0); shelf.add(b1);
    const b2 = new THREE.Mesh(new RoundedBoxGeometry(0.32, 0.36, 0.32, 2, 0.01), P.MAT.white()); b2.position.set(0.25, 1.16, 0); shelf.add(b2);
    for (let i = 0; i < 6; i++) { const tree = new THREE.Mesh(new THREE.SphereGeometry(0.03, 8, 6), P.MAT.leaf()); tree.position.set(-0.5 + i * 0.2, 1.0, 0.25); shelf.add(tree); }
    const glass = new THREE.Mesh(new THREE.BoxGeometry(1.24, 0.5, 0.64), P.MAT.glass()); glass.position.y = 1.22; shelf.add(glass);
    const label = P.canvasTexture(512, 128, (c) => { c.fillStyle = '#fdfbf4'; c.fillRect(0, 0, 512, 128); c.fillStyle = '#26211b'; c.font = '600 40px Georgia, serif'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText('АВИВАК-2 · М 1:500', 256, 64); });
    const labelMesh = new THREE.Mesh(new THREE.PlaneGeometry(0.6, 0.15), new THREE.MeshBasicMaterial({ map: label.texture })); labelMesh.position.set(0, 0.7, 0.41); shelf.add(labelMesh);
    this.scene.add(shelf);
    this._pickable(shelf, { kind: 'item', item: 'model' });
    this._blockers.push({ x: 13.6, z: -2.0, r: 0.9 });
    this.itemAnchors.set('model', { group: shelf, camPos: [11.6, y0 + 1.6, -0.8], camTgt: [13.6, y0 + 1.1, -2.0], walk: [11.8, -0.9], look: [13.6, -2.0] });

    // нивелир на штативе
    const level = new THREE.Group();
    level.position.set(-12.4, y0, 7.6);
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2;
      const tleg = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.028, 1.35, 8), new THREE.MeshStandardMaterial({ color: 0xc99a3e, roughness: 0.5 }));
      tleg.position.set(Math.cos(a) * 0.3, 0.62, Math.sin(a) * 0.3); tleg.rotation.z = Math.cos(a) * 0.36; tleg.rotation.x = -Math.sin(a) * 0.36; level.add(tleg);
    }
    const head = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.05, 16), P.MAT.graphite()); head.position.y = 1.3; level.add(head);
    const dev = new THREE.Mesh(new RoundedBoxGeometry(0.3, 0.12, 0.12, 2, 0.02), new THREE.MeshStandardMaterial({ color: 0xd8b64a, roughness: 0.4 })); dev.position.y = 1.38; level.add(dev);
    const lens = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.36, 12), P.MAT.black()); lens.rotation.z = Math.PI / 2; dev.add(lens);
    this.scene.add(level);
    this._pickable(level, { kind: 'item', item: 'level' });
    this._blockers.push({ x: -12.4, z: 7.6, r: 0.5 });
    this.itemAnchors.set('level', { group: level, camPos: [-10.6, y0 + 1.6, 9.0], camTgt: [-12.4, y0 + 1.3, 7.6], walk: [-10.8, 9], look: [-12.4, 7.6] });
  }

  _drawBlueprint(c) {
    c.fillStyle = '#fdfbf4'; c.fillRect(0, 0, 1024, 720);
    c.strokeStyle = '#26211b'; c.lineWidth = 3; c.strokeRect(28, 28, 968, 664);
    c.strokeRect(680, 580, 316, 112);
    c.strokeStyle = 'rgba(38,33,27,.25)'; c.lineWidth = 1;
    for (let x = 60; x < 1000; x += 40) { c.beginPath(); c.moveTo(x, 40); c.lineTo(x, 680); c.stroke(); }
    for (let y = 60; y < 680; y += 40) { c.beginPath(); c.moveTo(40, y); c.lineTo(980, y); c.stroke(); }
    c.strokeStyle = '#b95740'; c.lineWidth = 4;
    c.beginPath(); c.moveTo(200, 160); c.lineTo(520, 140); c.lineTo(560, 380); c.lineTo(360, 470); c.lineTo(180, 400); c.closePath(); c.stroke();
    c.strokeStyle = '#4a6b8a'; c.lineWidth = 2.5; c.strokeRect(260, 230, 220, 110);
    c.strokeStyle = '#3f6f9c'; c.setLineDash([12, 8]); c.beginPath(); c.moveTo(120, 520); c.lineTo(620, 90); c.stroke(); c.setLineDash([]);
    c.fillStyle = '#26211b'; c.font = '600 26px ui-monospace, monospace';
    c.fillText('ГПЗУ · участок 47:14:0402001:7', 700, 620);
    c.font = '20px ui-monospace, monospace'; c.fillText('М 1:500 · МСК-47', 700, 660);
  }

  /* ---------- постеры и растения зала ---------- */

  _buildPostersAndPlants() {
    // серия «Механика» — на стенах под галереями, φ-рамы, красная рама
    /**
     * Развеска — через общий список занятых мест на стене. Раньше каждая серия
     * считала свои координаты своей формулой: постер налезал на косяк проёма,
     * на соседний постер и висел над пустотой проёма в крыло.
     */
    // проёмы в крылья: z −1.2…1.6 плюс по 1 м запаса на косяк и импост
    const OPENINGS = [[-2.2, 2.6]];
    const walls = new Map();          // x стены → занятые места вдоль неё
    const slots = (x) => { if (!walls.has(x)) walls.set(x, []); return walls.get(x); };
    const free = (x, z, w) => slotFree(slots(x), OPENINGS, z, w);
    const place = (x, z, w) => { slots(x).push({ along: z, width: w }); };
    this._wallSlots = walls;          // для проверок: что и где висит
    const mech = ['gears', 'bearing', 'turbine', 'valve'];
    for (const side of [-1, 1]) {
      // Внутренняя грань стены после Б1 лежит на x = ±15.85 (короб 300 мм по
      // оси ±16): постер на 15.88 оказывался ВНУТРИ стены и не был виден.
      const x = side * 15.80;
      let placed = 0;
      for (const z of [-9.4, -6.2, 4.6, 7.8, 10.2]) {
        if (placed >= mech.length || !free(x, z, 1.15)) continue;
        const kind = mech[placed];
        const poster = P.makePoster({ width: 1.15, frame: 'red', draw: (c, w, h) => P.drawMechanicalPoster(c, w, h, kind), pickInfo: { kind: 'poster', series: 'mech', id: kind } });
        poster.position.set(x, heightAt(side * 15.5, z) + 1.62, z);
        poster.rotation.y = side < 0 ? Math.PI / 2 : -Math.PI / 2;
        this.scene.add(poster);
        place(x, z, 1.15);
        // бра над постером: корпус со скрытой лампой, мягкий свет без пережога кромки
        const sconce = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.08, 0.14), P.MAT.graphite());
        sconce.position.set(x - side * 0.16, heightAt(side * 15.5, z) + 2.85, z); this.scene.add(sconce);
        const spot = new THREE.PointLight(0xfff0dd, 0.4, 4.5, 2);
        spot.position.set(x - side * 0.45, heightAt(side * 15.5, z) + 2.7, z); this.scene.add(spot);
        placed += 1;
      }
    }
    const codex = ['crane', 'arch', 'gear'];
    codex.forEach((kind, i) => {
      const poster = P.makePoster({ width: 0.8, frame: 'walnut', draw: (c, w, h) => P.drawCodexPoster(c, w, h, kind), pickInfo: { kind: 'poster', series: 'codex', id: kind } });
      if (i < 2) { poster.position.set(-6.4 + i * 12.8, CONCOURSE_Y + 2.2, 20.86); poster.rotation.y = Math.PI; }
      else {
        const x = -15.80, z = -4.0;
        if (!free(x, z, 0.8)) return;
        poster.position.set(x, heightAt(-15.5, z) + 1.62, z); poster.rotation.y = Math.PI / 2; place(x, z, 0.8);
      }
      this.scene.add(poster);
    });
    // растения у экрана и по углам
    for (const [x, z, kind] of [[-9.5, -9.6, 'monstera'], [9.5, -9.6, 'monstera'], [-14.5, -9.5, 'ficus'], [14.5, -9.5, 'ficus'], [-14.6, 10.2, 'ficus'], [14.6, 10.2, 'ficus']]) {
      const pl = kind === 'monstera' ? P.makeMonstera(1.2) : P.makeFicus(1.3);
      pl.position.set(x, heightAt(x, z), z);
      this.scene.add(pl);
      const cs = P.makeContactShadow(1.2, 1.2, 0.3); cs.position.set(x, heightAt(x, z) + 0.006, z); this.scene.add(cs);
      pl.traverse((m) => { if (m.userData.sway) this.life.plants.push(m); });
      this._blockers.push({ x, z, r: 0.5 });
    }
    // настенные часы над проёмом
    const clock = P.canvasTexture(256, 256, () => {});
    this._clock = clock;
    const clockMesh = new THREE.Mesh(new THREE.CircleGeometry(0.45, 40), new THREE.MeshBasicMaterial({ map: clock.texture }));
    clockMesh.position.set(0, 8.2, 10.82); clockMesh.rotation.y = Math.PI;
    this.scene.add(clockMesh);
    this._drawClock();
  }

  _drawClock() {
    const { ctx: c, texture } = this._clock;
    c.fillStyle = '#fdfbf4'; c.beginPath(); c.arc(128, 128, 128, 0, Math.PI * 2); c.fill();
    c.strokeStyle = '#26211b'; c.lineWidth = 6; c.beginPath(); c.arc(128, 128, 122, 0, Math.PI * 2); c.stroke();
    for (let i = 0; i < 12; i++) { const a = (i / 12) * Math.PI * 2; c.lineWidth = i % 3 ? 3 : 6; c.beginPath(); c.moveTo(128 + Math.cos(a) * 100, 128 + Math.sin(a) * 100); c.lineTo(128 + Math.cos(a) * 112, 128 + Math.sin(a) * 112); c.stroke(); }
    const d = new Date();
    const h = ((d.getHours() % 12) + d.getMinutes() / 60) / 12 * Math.PI * 2 - Math.PI / 2;
    const m = (d.getMinutes() + d.getSeconds() / 60) / 60 * Math.PI * 2 - Math.PI / 2;
    c.strokeStyle = '#26211b'; c.lineWidth = 8; c.beginPath(); c.moveTo(128, 128); c.lineTo(128 + Math.cos(h) * 60, 128 + Math.sin(h) * 60); c.stroke();
    c.lineWidth = 5; c.beginPath(); c.moveTo(128, 128); c.lineTo(128 + Math.cos(m) * 92, 128 + Math.sin(m) * 92); c.stroke();
    c.fillStyle = '#b95740'; c.beginPath(); c.arc(128, 128, 7, 0, Math.PI * 2); c.fill();
    texture.needsUpdate = true;
  }

  /* ---------- ходоки ---------- */

  _buildWalkers() {
    const looks = [
      { hair: 0x2a1f18, skin: 0xe3b78f, mug: true },
      { hair: 0xb99867, skin: 0xf2d4b3, female: true },
      { hair: 0x1d1a17, skin: 0xc98e62, glasses: true },
      { hair: 0x5a4632, skin: 0xe8c39e, female: true, mug: true },
    ];
    looks.forEach((l, i) => {
      const rig = P.makePerson({ ...l, standing: true, polo: this.brand.poloHex || 0xb95740 });
      this.scene.add(rig.group);
      const w = this.life.addWalker(rig, i, 0.8 + i * 0.08);
      if (l.mug) { const mug = P.makeMug(); mug.scale.setScalar(0.9); rig.armR.elbow.add(mug); mug.position.set(0, -0.28, -0.03); w.mug = true; }
      this._pickable(rig.group, { kind: 'walker', index: i });
    });
  }

  /* ================= данные ================= */

  /** корешки библиотеки — документы базы знаний платформы */
  setBooks(docs) { if (this.wings) this.wings.setBooks(docs); }

  setSceneData(data) {
    this._sceneData = data;
    // на кульмане — настоящий план проекта, как только он пришёл
    if (data.geometry && data.geometry.parcel && this._blueprintCtx && !this._blueprintDrawn) {
      this._blueprintDrawn = true;
      const c = this._blueprintCtx.ctx;
      this._drawBlueprint(c);
      this._drawPlanOnScreen(c, 60, 60, 600, 500, data.geometry);
      this._blueprintCtx.texture.needsUpdate = true;
    }
    this.life.setModuleStates(data.modules);
    for (const m of MODULES) this._drawMonitor(m, data);
    this._drawScreen(data);
    if (data.geometry) this.setTableGeometry(data.geometry);
  }

  setVariant(variantId) {
    this._geomHash = '';
    if (this._sceneData && this._sceneData.geometry) this.setTableGeometry(this._sceneData.geometry, variantId);
  }

  /* ================= камера и ходьба ================= */

  setWalk(on) {
    if (this.walkMode === on) return;
    this.walkMode = on;
    if (on) {
      this.controls.enabled = false;
      const p = this.camera.position;
      this.walk.enable([p.x, 0, p.z], [this.controls.target.x, 0, this.controls.target.z]);
    } else {
      this.walk.disable();
      this.controls.enabled = true;
      this.controls.target.copy(this.camera.position).add(this.camera.getWorldDirection(new THREE.Vector3()).multiplyScalar(4));
      this.controls.update();
    }
  }

  goTo(view, ms = 1400) {
    const v = VIEWS[view];
    if (!v) return;
    if (this.walkMode) { this.walk.teleport([v.walk[0], 0, v.walk[1]], [v.look[0], 0, v.look[1]], null); return; }
    this._tweenTo(new THREE.Vector3(...v.pos), new THREE.Vector3(...v.tgt), this.reducedMotion ? 0 : ms);
  }

  focusAnchor(kind, ms = 1100) {
    const a = this.itemAnchors.get(kind);
    if (!a) return;
    if (this.walkMode) {
      const w = a.walk;
      const wx = w.x !== undefined ? w.x : w[0], wz = w.z !== undefined ? w.z : w[1];
      const l = a.look;
      const lx = l.x !== undefined ? l.x : l[0], lz = l.z !== undefined ? l.z : l[1];
      this.walk.teleport([wx, 0, wz], [lx, 0, lz], a.floorY === undefined ? null : a.floorY);
      return;
    }
    this._tweenTo(new THREE.Vector3(...a.camPos), new THREE.Vector3(...a.camTgt), this.reducedMotion ? 0 : ms);
  }

  _tweenTo(pos, tgt, ms) {
    if (ms <= 0) {
      this._tween = null;
      if (this._fly) { const f = this._fly; this._fly = null; f.resolve(); }
      this.camera.position.copy(pos); this.controls.target.copy(tgt); this.controls.update();
      return;
    }
    this._tween = { p0: this.camera.position.clone(), p1: pos, t0: this.controls.target.clone(), t1: tgt, start: this._time, ms };
  }

  flythrough() {
    if (this.reducedMotion || this.walkMode) { this.goTo('hall', 0); return Promise.resolve(); }
    const y = CONCOURSE_Y;
    const path = new THREE.CatmullRomCurve3([
      new THREE.Vector3(0, y + 1.65, 19.8), new THREE.Vector3(0.6, y + 1.7, 15.8), new THREE.Vector3(-0.3, y + 1.9, 11.4),
      new THREE.Vector3(0, y + 2.4, 8.6), new THREE.Vector3(0, 5.2, 8.4), new THREE.Vector3(...VIEWS.hall.pos),
    ]);
    const look = new THREE.CatmullRomCurve3([
      new THREE.Vector3(0, y + 1.4, 14.5), new THREE.Vector3(0, y + 1.4, 11), new THREE.Vector3(0, y + 1.5, 4),
      new THREE.Vector3(0, 2.2, -4), new THREE.Vector3(0, 2, -6), new THREE.Vector3(...VIEWS.hall.tgt),
    ]);
    return new Promise((resolve) => { this._fly = { path, look, start: this._time, ms: 7000, resolve }; });
  }

  skipFlythrough() {
    if (!this._fly) return;
    const f = this._fly; this._fly = null;
    this.goTo('hall', 0); f.resolve();
  }

  /* ================= кадр ================= */

  update(dt) {
    this._time += dt;
    const t = this._time;
    if (this._fly) {
      const f = this._fly;
      const k = Math.min(1, (t - f.start) * 1000 / f.ms);
      const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
      this.camera.position.copy(f.path.getPoint(e)); this.controls.target.copy(f.look.getPoint(e));
      if (k >= 1) { this._fly = null; f.resolve(); }
    }
    if (this._tween) {
      const w = this._tween;
      const k = Math.min(1, (t - w.start) * 1000 / w.ms);
      const e = 1 - Math.pow(1 - k, 3);
      this.camera.position.lerpVectors(w.p0, w.p1, e); this.controls.target.lerpVectors(w.t0, w.t1, e);
      if (k >= 1) this._tween = null;
    }

    if (!this.reducedMotion) {
      this.life.update(dt);
      if (this.secretary) {
        const s = this.secretary;
        s.torso.scale.y = 1 + Math.sin(t * 1.3) * 0.012;
        s.head.rotation.y += (Math.sin(t * 0.4) * 0.35 - s.head.rotation.y) * dt * 2;
        const wave = this._wave && t < this._wave;
        s.armR.shoulder.rotation.x += ((wave ? 2.5 : 0.12) - s.armR.shoulder.rotation.x) * dt * 6;
        s.armR.elbow.rotation.x += ((wave ? 0.5 + Math.sin(t * 9) * 0.35 : 0.15) - s.armR.elbow.rotation.x) * dt * 8;
        s.armL.shoulder.rotation.x += (0.12 - s.armL.shoulder.rotation.x) * dt * 4;
      }
      if (this.teaMaster) {
        const pour = (Math.sin(t * 0.45) + 1) / 2;
        const pouring = pour > 0.82;
        if (this.teapot) this.teapot.rotation.z += ((pouring ? -(pour - 0.82) * 3.5 : 0) - this.teapot.rotation.z) * dt * 5;
        this.teaMaster.armR.shoulder.rotation.x += ((pouring ? 1.25 : 0.8) - this.teaMaster.armR.shoulder.rotation.x) * dt * 4;
        this.teaMaster.armR.elbow.rotation.x += ((pouring ? 0.55 : 0.95) - this.teaMaster.armR.elbow.rotation.x) * dt * 4;
        this.teaMaster.head.rotation.x = 0.25;
        this.teaMaster.torso.scale.y = 1 + Math.sin(t * 1.1) * 0.012;
      }
      if (this._buildingFloors) {
        for (const f of this._buildingFloors) {
          const k = Math.min(1, Math.max(0, (t - this._buildStart - f.delay) / 0.6));
          f.mesh.scale.y = Math.max(0.001, 1 - Math.pow(1 - k, 3));
        }
      }
      // печать: звук клавиш у занятых агентов
      for (const [mod, a] of this.life.agents) {
        if (a.state === 'typing' && this.onTypingTick && Math.random() < dt * 5) this.onTypingTick(mod);
      }
    }

    // периодические перерисовки канв (недорого): мониторы раз в 0.5 с, экран раз в 1 с, часы раз в 10 с
    this._acc = (this._acc || 0) + dt;
    if (this._acc > 0.5) {
      this._acc = 0;
      this._drawIdle();
      if (this._sceneData) for (const m of MODULES) this._drawMonitor(m, this._sceneData);
      this._tick = (this._tick || 0) + 1;
      if (this._tick % 2 === 0) this._drawScreen(this._sceneData);
      if (this._tick % 20 === 0) this._drawClock();
      if (this._sceneData && this._sceneData.project && t - this._screenModeAt > 25) {
        const modes = ['plan', 'kpi', 'docs'];
        this.setScreenMode(modes[(modes.indexOf(this._screenMode) + 1) % modes.length]);
      }
    }

    if (this.wings) this.wings.update(dt, t);
    if (this.walkMode) this.walk.update(dt); else { this.controls.update(); this._clampCamera(); }
    // зеркальный паркет — второй проход рендера; нужен только когда камера в фойе/лобби
    if (this._mirror) this._mirror.visible = this.camera.position.z > 5.5;
    this.renderer.render(this.scene, this.camera);
  }

  wave(seconds = 2.5) { this._wave = this._time + seconds; }

  /**
   * Оболочка здания: за неё камера обзора не выходит ни при каком повороте.
   * Габарит по X — от зала реактора (−34) до гаража (+34), по Z — от стены за
   * экраном (−11) до лобби (+21); плюс 2 м воздуха, чтобы стены не резали кадр.
   */
  _clampCamera() {
    const p = this.camera.position;
    p.x = Math.max(-35.5, Math.min(35.5, p.x));
    p.z = Math.max(-12.5, Math.min(22.5, p.z));
    p.y = Math.max(0.4, Math.min(14, p.y));
    const t = this.controls.target;
    t.x = Math.max(-34, Math.min(34, t.x));
    t.z = Math.max(-11, Math.min(21, t.z));
    t.y = Math.max(-2, Math.min(12, t.y));
  }

  /* ================= клик и наведение ================= */

  _pick(e) {
    if (this.walkMode && this.walk.locked) { this.pickCenter(); return; }
    const rect = this.canvas.getBoundingClientRect();
    this._pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this._pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    this._raycastPick(this._pointer);
  }

  pickCenter() { this._raycastPick(new THREE.Vector2(0, 0)); }

  _raycastPick(ndc) {
    this.raycaster.setFromCamera(ndc, this.camera);
    const info = this._hit();
    if (info && this.onPick) this.onPick(info);
  }

  /** что под прицелом — для подписи в режиме ходьбы */
  hoverCenter() {
    this.raycaster.setFromCamera(new THREE.Vector2(0, 0), this.camera);
    return this._hit(9);
  }

  _hit(maxDist = Infinity) {
    const hits = this.raycaster.intersectObjects(this.pickables, true);
    for (const h of hits) {
      if (h.distance > maxDist) return null;
      let o = h.object;
      while (o) { if (o.userData && o.userData.pick) return o.userData.pick; o = o.parent; }
    }
    return null;
  }

  /* ================= тема ================= */

  setTheme(dark) {
    if (this.dark === dark) return;
    this.dark = dark;
    this.pal = dark ? PAL.dark : PAL.light;
    const p = this.pal;
    this.scene.background.set(p.bg); this.scene.fog.color.set(p.bg);
    this.hemi.intensity = p.hemi; this.sun.intensity = p.sun;
    this.renderer.toneMappingExposure = dark ? 0.9 : 1.05;
    this._wallMat.color.set(dark ? 0x8a8378 : 0xffffff);
    this._ceil.material.color.set(p.ceiling);
    for (const w of this._windows) w.material.color.set(p.window);
    for (const s of this._strips) s.material.color.set(p.strip);
    for (const s of this._spots) s.intensity = p.spots * 60;
    if (this.wings) this.wings.setDark(dark);
    if (this._sceneData) this._drawScreen(this._sceneData);
  }

  /** вывеска бренда: белый логотип с сайта (или текст), слоган, подпись платформы */
  _drawBrandSign(c, logoImg) {
    const W = 1600, H = 640;
    c.clearRect(0, 0, W, H);
    if (logoImg) {
      const lw = 620, lh = lw * (28 / 76);
      c.drawImage(logoImg, (W - lw) / 2, 120, lw, lh);
    } else {
      c.fillStyle = '#ffffff'; c.font = '700 190px "Helvetica Neue", Arial, sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle';
      c.fillText('ENSO', W / 2, 220);
    }
    c.textAlign = 'center'; c.textBaseline = 'middle';
    if (!logoImg) {
      // подпись нужна только текстовому варианту: в SVG слово ENGINEERING уже есть
      c.fillStyle = 'rgba(255,255,255,.55)'; c.font = '500 34px -apple-system, "Helvetica Neue", sans-serif';
      c.fillText((this.brand.name || 'ENSO-Engineering').toUpperCase(), W / 2, 395);
    }
    c.fillStyle = '#ffffff'; c.font = '600 60px Georgia, "New York", serif';
    c.fillText(this.brand.slogan || 'Давайте созидать вместе', W / 2, 480);
    c.fillStyle = 'rgba(255,255,255,.5)'; c.font = '32px -apple-system, sans-serif';
    c.fillText('Enso-nexus · виртуальный офис', W / 2, 560);
  }

  _wrapText(c, text, x, y, maxW, lh) {
    const words = String(text).split(' ');
    let line = '';
    for (const w of words) {
      if (c.measureText(line + w).width > maxW && line) { c.fillText(line.trim(), x, y); y += lh; line = w + ' '; }
      else line += w + ' ';
    }
    c.fillText(line.trim(), x, y);
  }
}
