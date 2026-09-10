'use strict';
/**
 * «Виртуальный офис», планировка «Кольцо с атриумом» (ТЗ №2, Р2).
 *
 * Наружный Ø 48 м, атриум Ø 21 м, два этажа по 4,2 м, два павильона и два
 * лестничных ядра. Числа плана — в `office-plan.mjs`, оболочка — в
 * `office-ring.js`; здесь свет, экран, стол-голограмма, рабочие места, люди,
 * развеска и кадровый цикл.
 *
 * Амфитеатр уехал в атриум: пол рабочих секторов стал ровным, и вместе с
 * ступенчатым ландшафтом ушли парящие доски прохода, тёмная лента подступёнка
 * и невидимый пол за пределами сектора яруса (Н6 ТЗ №2).
 */

import * as THREE from './vendor/three.module.min.js';
import { RoomEnvironment } from './vendor/RoomEnvironment.js';
import { RoundedBoxGeometry } from './vendor/RoundedBoxGeometry.js';
import { RectAreaLightUniformsLib } from './vendor/RectAreaLightUniformsLib.js';
import * as P from './office-props.js?v=7';
import { LifeDirector, makeSteam } from './office-life.js?v=7';
import { WalkRig } from './office-walk.js?v=7';
import { buildWings } from './office-wings.js?v=7';
import { slotFree, stairSurface } from './office-geom.mjs?v=7';
import { buildShell, buildAtrium, buildPavilionShell, stoneMat, TONE } from './office-ring.js?v=7';
import {
  RING, FLOOR1, FLOOR2 as SECT2, PAVILIONS, CORES, ATRIUM,
  insideWalkable, floorHeight as planFloor, pt, sectorAt,
} from './office-plan.mjs?v=7';

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

/** короб с позицией — короткая запись, которой полна сборка */
function box2(w, h, d, mat, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  return m;
}
const STATE_COLORS = { ok: '#4f7d58', warn: '#b07e36', bad: '#a93e2c', run: '#4a6b8a', none: '#8b8375', off: '#8b8375' };

/* середина кольца — по ней идёт маршрут-петля и стоят рабочие места */
const RMID = (RING.rIn + RING.rOut) / 2;

/* виды камеры (обзор) и точки телепорта (ходьба) */
/*
 * Р6 ТЗ №2: режим «Обзор» удалён целиком — зал показывается ТОЛЬКО от первого
 * лица. У вида остаются лишь точка, куда встать, и точка, куда смотреть;
 * орбитальная камера, твины и облёт ушли вместе с `OrbitControls`.
 *
 * Заодно исчезла ошибка переключения: `setWalk()` брал позицию орбитальной
 * камеры и телепортировал ходока в неё, а если камера стояла за стеной, ходок
 * попадал «не туда». Этого пути больше нет.
 */
const VIEWS = {
  lobby:  { walk: [0, 21.0], look: [0, 12] },        // вестибюль, лицом к атриуму
  hall:   { walk: [0, 8.0], look: [0, -6] },         // кромка атриума с юга
  screen: { walk: [0, -2.0], look: [0, -10.5] },     // амфитеатр перед экраном
  table:  { walk: [2.6, 6.4], look: [0, 4.4] },      // стол-голограмма в атриуме
};

export function heightAt(x, z) {
  return planFloor(x, z, 0, stairSurface);
}

export class OfficeScene {
  constructor(canvas, { dark = false, reducedMotion = false, mobile = false } = {}) {
    this.canvas = canvas;
    this.dark = dark;
    this.THREE = THREE;                     // для office-audit.mjs: он без своего импорта three
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
    this._tour = null;
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
    /*
     * Р5.3. На ретине devicePixelRatio = 2 — вчетверо больше пикселей, чем нужно
     * для этой сцены. Потолок 1.5; переключатель качества («?hq=1») поднимает
     * его обратно, когда картинка важнее кадров.
     */
    const hq = new URLSearchParams(location.search).get('hq') === '1';
    this.pixelRatioCap = this.mobile ? 1.25 : (hq ? 2 : 1.5);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, this.pixelRatioCap));
    this.renderer.setSize(w, h, false);
    this.renderer.shadowMap.enabled = !this.mobile;
    // В three 0.185 PCFSoftShadowMap объявлен устаревшим и молча подменяется
    // на PCFShadowMap — ставим его явно, а мягкость кромки даёт shadow.radius
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    /*
     * Р5.1. Солнце неподвижно, а карта теней 4096² пересчитывалась КАЖДЫЙ кадр:
     * вся сцена рендерилась в глубину второй раз 60 раз в секунду. Обновляем
     * руками — один раз после сборки и при смене день/ночь.
     */
    this.renderer.shadowMap.autoUpdate = false;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = this.dark ? 0.9 : 1.05;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    // Н5: без сглаживания квантования на градиентах картин проступает дизеринг
    this.renderer.dithering = true;
    P.setMaxAnisotropy(this.renderer.capabilities.getMaxAnisotropy());

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(this.pal.bg);
    // Р5.5: габарит здания после перепланировки ≤ 80 м — дальность и дымка
    // подтянуты под него, дальний план всё равно за окном
    this.scene.fog = new THREE.Fog(this.pal.bg, 60, 160);
    // окружение для отражений на стекле, металле и паркете
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();

    this.camera = new THREE.PerspectiveCamera(48, w / h, 0.08, 200);
    this.camera.position.set(VIEWS.lobby.walk[0], 1.65, VIEWS.lobby.walk[1]);



    this.walk = new WalkRig(this.camera, this.canvas, {
      heightAt: (x, z, prevY) => planFloor(x, z, prevY === undefined ? 0 : prevY, stairSurface),
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
      this.sun.shadow.camera.left = -50; this.sun.shadow.camera.right = 50;
      this.sun.shadow.camera.top = 50; this.sun.shadow.camera.bottom = -50;
      this.sun.shadow.bias = -0.0002;
      this.sun.shadow.normalBias = 0.03;
      this.sun.shadow.camera.near = 1; this.sun.shadow.camera.far = 130;
      this.sun.shadow.radius = 2.5;
      this.sun.shadow.camera.updateProjectionMatrix();
    }
    this.sun.target.position.set(0, 0, 2);
    this.scene.add(this.sun, this.sun.target);
    RectAreaLightUniformsLib.init();
    // ночные споты над сценой и ярусами
    this._spots = [];
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      const x = Math.sin(a) * RMID, z = Math.cos(a) * RMID;
      const s = new THREE.SpotLight(0xffd9b8, 0, 26, 0.7, 0.6, 1.2);
      s.position.set(x, RING.height - 0.4, z);
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

  /** отметка пола в точке с учётом этажа — общая для ходьбы, расстановки и аудита */
  heightAt(x, z, prevY) {
    return planFloor(x, z, prevY === undefined ? 0 : prevY, stairSurface);
  }

  /* ================= архитектура ================= */

  _build() {
    this._buildShell();
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
    this.refreshShadows();
  }

  /** Р5.1: единственное место, где карта теней пересчитывается. */
  refreshShadows() {
    this.renderer.shadowMap.needsUpdate = true;
  }

  /**
   * Оболочка и атриум. Ярусов, подступёнков, ступеней прохода и «фойе» больше
   * нет: пол кольца — одна плита на отметку с мировой развёрткой (Р4), сад с
   * пятью рядами амфитеатра живёт в атриуме (Р2, Н6).
   */
  _buildShell() {
    const p = this.pal;
    this._windows = [];
    this.shell = buildShell(this.scene, { windows: this._windows, wallMat: null, windowMat: null });
    this._wallMat = this.shell.wallMat;
    this._ceil = { material: { color: { set() {} } } };     // тема больше не красит потолок зала
    this.atrium = buildAtrium(this.scene, {});
    for (const t of this.atrium.trees) this._blockers.push({ x: t.x, z: t.z, r: t.r });
    this._strips = [];

    // павильоны: оболочки строятся здесь, наполнение — в office-wings.js
    this.pavilions = {
      reactor: buildPavilionShell(this.scene, PAVILIONS.reactor),
      workshop: buildPavilionShell(this.scene, PAVILIONS.workshop),
    };

    // подсветка кольца: линия по кромке атриума на обоих этажах
    for (const y of [RING.floor1 + RING.height - 0.35, RING.floor2 + RING.height - 0.35]) {
      const led = new THREE.Mesh(new THREE.TorusGeometry(RING.rIn + 0.5, 0.03, 6, 128), new THREE.MeshBasicMaterial({ color: p.strip, transparent: true, opacity: 0.75 }));
      led.rotation.x = -Math.PI / 2;
      led.position.y = y;
      P.air(led);
      this.scene.add(led);
      this._strips.push(led);
      this.life.strips.push(led);
    }

    // потолочные светильники кольца — один InstancedMesh на этаж (Р5.4)
    const spotMat = new THREE.MeshBasicMaterial({ color: 0xfff7ea });
    for (const y of [RING.floor1 + RING.height - 0.12, RING.floor2 + RING.height - 0.12]) {
      const rows = [RING.rIn + 3.2, RMID, RING.rOut - 3.4];
      const per = 36;
      const inst = new THREE.InstancedMesh(new THREE.CircleGeometry(0.16, 14), spotMat, rows.length * per);
      const m4 = new THREE.Matrix4(), q = new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI / 2, 0, 0)), sc = new THREE.Vector3(1, 1, 1);
      let i = 0;
      for (const r of rows) {
        for (let k = 0; k < per; k++) {
          const a = (k / per) * Math.PI * 2;
          m4.compose(new THREE.Vector3(Math.sin(a) * r, y, Math.cos(a) * r), q, sc);
          inst.setMatrixAt(i++, m4);
        }
      }
      inst.instanceMatrix.needsUpdate = true;
      P.air(inst, 'светильники');
      this.scene.add(inst);
    }

    // солнце светит в атриум сверху — свет ставится по габариту кольца
    this.sun.position.set(22, 34, 18);
    this.sun.target.position.set(0, 0, 0);
  }

  /**
   * Главный экран стоит на СЕВЕРНОЙ кромке атриума и смотрит на амфитеатр.
   * Виден с обоих этажей и из вестибюля через атриум — ради этого амфитеатр
   * в атриум и переехал.
   */
  _buildScreen() {
    const { canvas, ctx, texture } = P.canvasTexture(2560, 880, () => {});
    this.screenCtx = ctx; this.screenCanvas = canvas; this.screenTexture = texture;
    texture.wrapS = THREE.RepeatWrapping; texture.repeat.x = -1;
    // экран стоит ВНУТРИ атриума: на rIn + 1.4 он оказывался за кромкой, в
    // секторе проектной, и читался висящим перед рабочими местами
    const R = RING.rIn - 0.8, arc = ATRIUM.screen.width / R;
    const H = ATRIUM.screen.height;
    const yc = ATRIUM.screen.y + H / 2;
    const geo = new THREE.CylinderGeometry(R, R, H, 64, 1, true, Math.PI - arc / 2, arc);
    const screen = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: texture, side: THREE.BackSide, toneMapped: false }));
    screen.position.set(0, yc, 0);
    P.air(screen, 'главный экран');
    this.scene.add(screen);
    this._pickable(screen, { kind: 'screen' });
    const shell = new THREE.Mesh(new THREE.CylinderGeometry(R + 0.07, R + 0.07, H + 0.32, 64, 1, true, Math.PI - arc / 2 - 0.012, arc + 0.024), P.MAT.graphite());
    shell.position.set(0, yc, 0);
    P.air(shell);
    this.scene.add(shell);
    for (const y of [yc - H / 2 - 0.15, yc + H / 2 + 0.15]) {
      const led = new THREE.Mesh(new THREE.CylinderGeometry(R + 0.08, R + 0.08, 0.03, 64, 1, true, Math.PI - arc / 2, arc), new THREE.MeshBasicMaterial({ color: 0xff8a66, transparent: true, opacity: 0.8, side: THREE.DoubleSide }));
      led.position.set(0, y, 0);
      P.air(led);
      this.scene.add(led);
      this.life.strips.push(led);
    }
    // опоры экрана — он не висит: две стойки в пол атриума
    for (const sx of [-ATRIUM.screen.width / 2 + 0.6, ATRIUM.screen.width / 2 - 0.6]) {
      const zz = -Math.sqrt(Math.max(0.01, R * R - sx * sx));
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.11, yc - H / 2, 10), P.MAT.graphite());
      post.position.set(sx, (yc - H / 2) / 2, zz + 0.12);
      post.castShadow = true;
      this.scene.add(post);
    }
    this._blockers.push({ x0: -7, x1: 7, z0: -RING.rIn - 0.2, z1: -RING.rIn + 2.0 });
    this._screenLights = [];
    for (const [x, ry] of [[-4.4, 0.32], [0, 0], [4.4, -0.32]]) {
      const l = new THREE.RectAreaLight(0xcfe0ff, 2.6, 5.0, H);
      l.position.set(x, yc, -RING.rIn + 1.0);
      l.rotation.set(-0.18, ry, 0);
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

  /** Стол-голограмма — в атриуме, на ровном газоне перед амфитеатром. */
  _buildTable() {
    const g = new THREE.Group();
    g.position.set(0, 0, 5.2);
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
    this._blockers.push({ x0: -2.1, x1: 2.1, z0: 3.7, z1: 6.7 });
    this.itemAnchors.set('table', { group: g, camPos: [2.6, 2.5, 7.2], camTgt: [0, 1.15, 5.2], walk: [2.6, 7.4], look: [0, 5.2] });
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

  /**
   * 24 рабочих места в секторе «Проектная» — ДВУМЯ ДУГАМИ по плану: внутренняя
   * дуга лицом к атриуму, наружная лицом к окну. Пол сектора ровный, все места
   * на одной отметке — ярусов больше нет.
   */
  _deskPositions() {
    const out = [];
    const rnd = this._seeded(11);
    const sect = FLOOR1.find((x) => x.id === 'studio');
    const pad = 0.14;                                   // отступ от перегородок
    const arcs = [
      { r: RING.rIn + 3.4, face: 1, n: 12 },            // ближе к атриуму, лицом наружу
      { r: RING.rOut - 4.2, face: -1, n: 12 },          // у окна, лицом в атриум
    ];
    arcs.forEach((arc, ri) => {
      for (let i = 0; i < arc.n; i++) {
        const t = (i + 0.5) / arc.n;
        const a = sect.from + pad + t * ((sect.to - sect.from) - pad * 2);
        const x = Math.sin(a) * arc.r + (rnd() - 0.5) * 0.16;
        const z = Math.cos(a) * arc.r;
        // монитор смотрит от человека: yaw задаёт, куда развёрнут стол
        const yaw = arc.face > 0 ? a + Math.PI : a;
        out.push({ x, z, y: RING.floor1, yaw: yaw + (rnd() - 0.5) * 0.05, row: ri, col: i });
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

  /**
   * Точка в кольце: радиус и угол вместо x/z. `yaw` — куда развёрнут предмет,
   * если его «лицо» должно смотреть к центру (`face: 'in'`) или наружу.
   */
  _at(r, deg, { face = 'in', side = 0 } = {}) {
    const a = deg * Math.PI / 180;
    const px = Math.sin(a) * r + Math.cos(a) * side;
    const pz = Math.cos(a) * r - Math.sin(a) * side;
    return { x: px, z: pz, a, yaw: face === 'in' ? a : a + Math.PI };
  }

  /**
   * ВЕСТИБЮЛЬ — сектор φ −20…20°, вход с юга. Лестницы здесь нет (Р1): оба
   * марша стоят в ядрах на юго-востоке и северо-западе, и вошедший видит
   * атриум, а не подъём.
   */
  _buildLobby() {
    const sect = FLOOR1.find((x) => x.id === 'lobby');
    const y0 = RING.floor1;

    /* --- входной портал в наружной стене --- */
    const doorW = 4.2;
    const dr = RING.rOut - RING.wallT / 2;
    const portal = new THREE.Mesh(
      new THREE.CylinderGeometry(dr + 0.2, dr + 0.2, 3.3, 32, 1, true, -doorW / dr / 2, doorW / dr),
      P.MAT.graphite(),
    );
    portal.position.y = 1.65;
    P.air(portal, 'входной портал');
    this.scene.add(portal);
    for (const sx of [-1, 1]) {
      const leaf = new THREE.Mesh(new THREE.PlaneGeometry(doorW / 2 - 0.1, 2.9), new THREE.MeshPhysicalMaterial({
        color: 0xeaf2f6, transparent: true, opacity: 0.2, roughness: 0.04, metalness: 0.1, side: THREE.DoubleSide,
      }));
      leaf.position.set(sx * doorW / 4, 1.45, dr - 0.1);
      P.air(leaf);
      this.scene.add(leaf);
    }
    const mat = new THREE.Mesh(new THREE.PlaneGeometry(doorW + 1.2, 2.2), P.std(0x3a352c, { roughness: 0.95 }));
    mat.rotation.x = -Math.PI / 2;
    mat.position.set(0, y0 + 0.012, dr - 1.4);
    this.scene.add(mat);

    /* --- приём: стойка вдоль западной перегородки сектора --- */
    const seat = this._at(17.2, -16.0, { side: 1.1 });
    const g = new THREE.Group();
    g.position.set(seat.x, y0, seat.z);
    g.rotation.y = seat.a + Math.PI / 2;
    const counter = new THREE.Mesh(new RoundedBoxGeometry(3.6, 1.08, 0.9, 4, 0.08), P.MAT.white());
    counter.position.y = 0.54; counter.castShadow = true;
    g.add(counter);
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
    P.air(logoMesh);
    g.add(logoMesh);
    const s = P.makePerson({ hair: 0x4b3222, skin: 0xf0cdaa, female: true, standing: true, polo: this.brand.poloHex || 0xb95740 });
    s.group.position.set(0, 0, -0.85);
    s.group.rotation.y = Math.PI;                 // лицо модели смотрит в −z
    g.add(s.group);
    this.secretary = s;
    const smon = P.makeMonitor({ texture: this._idle.texture }); smon.scale.setScalar(0.6); smon.position.set(-0.9, 1.37, -0.55); smon.rotation.y = Math.PI; g.add(smon);
    const ph = P.makePhone(); ph.position.set(0.8, 1.15, -0.1); g.add(ph);
    this.scene.add(g);
    this._pickable(g, { kind: 'secretary' });
    this._blockers.push({ x: seat.x, z: seat.z, r: 2.1 });
    const front = this._at(17.2, -16.0, { side: 3.0 });
    this.itemAnchors.set('secretary', { group: g, camPos: [front.x, y0 + 1.7, front.z], camTgt: [seat.x, y0 + 1.4, seat.z], walk: [front.x, front.z], look: [seat.x, seat.z] });

    /*
     * Н2 ТЗ №2. Фриз направлений: шесть строк склеивались в одну и рисовались
     * кеглем 44 на канве 2048 БЕЗ measureText — строка выходила ~2900 пикселей
     * и обрезалась по краям («…сть · Переработка отходов · Укрепление грунтов
     * · Социальная инфрастр»). Цвет был кремовым по кремовому камню, контраст
     * около 1,1 : 1. Теперь кегль подбирается, строка при нужде делится на две,
     * цвет — тушь по светлому камню.
     */
    const dirs = (this.brand.directions || []).map((d) => String(d).trim()).filter(Boolean);
    if (dirs.length) {
      const CW = 2048, CH = 256;
      const frieze = P.canvasTexture(CW, CH, (c) => {
        c.clearRect(0, 0, CW, CH);
        c.fillStyle = '#6f665a'; c.textAlign = 'center'; c.textBaseline = 'middle';
        const room = CW - 96;
        const fit = (line, max) => {
          let size = max;
          c.font = `500 ${size}px -apple-system, "Helvetica Neue", sans-serif`;
          while (c.measureText(line).width > room && size > 26) { size -= 2; c.font = `500 ${size}px -apple-system, "Helvetica Neue", sans-serif`; }
          return size;
        };
        const one = dirs.join('   ·   ');
        if (fit(one, 92) > 44) { c.fillText(one, CW / 2, CH / 2); return; }
        const half = Math.ceil(dirs.length / 2);
        const a1 = dirs.slice(0, half).join('   ·   ');
        const a2 = dirs.slice(half).join('   ·   ');
        const s1 = fit(a1, 88); c.fillText(a1, CW / 2, CH * 0.32);
        const s2 = fit(a2, 88); c.fillText(a2, CW / 2, CH * 0.72);
        void s1; void s2;
      });
      const fq = this._at(RING.rOut - RING.wallT - 0.1, 0, {});
      const friezeMesh = new THREE.Mesh(new THREE.PlaneGeometry(10.0, 1.25), new THREE.MeshBasicMaterial({ map: frieze.texture, transparent: true, toneMapped: false }));
      friezeMesh.position.set(fq.x, y0 + 3.4, fq.z);
      friezeMesh.rotation.y = fq.a + Math.PI;
      P.air(friezeMesh, 'фриз направлений');
      this.scene.add(friezeMesh);
    }

    /* --- фирменная стена и мосс-панели: дуга по наружной стене за приёмом --- */
    const bw = this._brandWall(-19.95, y0);
    this.scene.add(bw);

    /* --- гардероб вдоль восточной перегородки --- */
    const wr = this._at(17.0, 15.5, { side: -1.0 });
    const rack = new THREE.Group();
    rack.position.set(wr.x, y0, wr.z);
    rack.rotation.y = wr.a - Math.PI / 2;
    rack.add(box2(3.2, 0.06, 0.6, P.MAT.walnut(), 0, 2.05, 0));
    for (const sx of [-1.5, 1.5]) rack.add(box2(0.06, 2.05, 0.06, P.MAT.brushed(), sx, 1.02, 0));
    const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 3.1, 8), P.MAT.chrome());
    bar.rotation.z = Math.PI / 2; bar.position.y = 1.72;
    P.air(bar);
    rack.add(bar);
    for (let i = 0; i < 7; i++) {
      const coat = new THREE.Mesh(new RoundedBoxGeometry(0.12, 0.9, 0.26, 2, 0.04), P.std([0x3a4a5a, 0x2b2622, 0x5a3f2c][i % 3], { roughness: 0.9 }));
      coat.position.set(-1.25 + i * 0.42, 1.2, 0.04);
      P.air(coat);
      rack.add(coat);
    }
    this.scene.add(rack);
    this._blockers.push({ x: wr.x, z: wr.z, r: 1.6 });

    /* --- таблички: на наружной стене по обе стороны от входа --- */
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
      /*
       * Таблички висят на НАРУЖНОЙ стене по обе стороны от входа. На кромке
       * атриума шесть рам выстраивались забором и закрывали сад; на боковых
       * границах сектора — перекрывали фирменную стену за стойкой приёма.
       */
      const side = i < 3 ? -1 : 1;
      const deg = side * (8.5 + (i % 3) * 4.4);
      const q = this._at(RING.rOut - RING.wallT - 0.12, deg, {});
      const m = new THREE.Group();
      const art = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 1.05), new THREE.MeshBasicMaterial({ map: t.texture, toneMapped: false }));
      art.position.z = 0.033; m.add(art);
      const fmat = P.MAT.walnut();
      const back = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 1.05), P.std(0xf3efe6, { roughness: 0.9 }));
      back.position.z = 0.028; m.add(back);
      for (const [bw2, bh, bx, by] of [[1.62, 0.06, 0, 0.555], [1.62, 0.06, 0, -0.555], [0.06, 1.17, -0.78, 0], [0.06, 1.17, 0.78, 0]]) {
        const barm = new THREE.Mesh(new THREE.BoxGeometry(bw2, bh, 0.05), fmat);
        barm.position.set(bx, by, 0.02); m.add(barm);
      }
      const lamp = new THREE.PointLight(0xfff0dd, 0.35, 2.4, 2); lamp.position.set(0, 0.75, 0.35); m.add(lamp);
      m.position.set(q.x, y0 + 2.05, q.z);
      m.rotation.y = q.a + Math.PI;              // лицом внутрь вестибюля
      P.air(m, `табличка ${i + 1}`);
      P.air(art); P.air(back);
      this.scene.add(m);
      this._pickable(m, { kind: 'plaque', index: i });
    });

    /* --- диваны и растения --- */
    for (const deg of [-13.5, 13.5]) {
      const q = this._at(20.4, deg, {});
      const sofa = new THREE.Mesh(new RoundedBoxGeometry(2.4, 0.5, 0.95, 3, 0.1), P.MAT.terracotta());
      sofa.position.set(q.x, y0 + 0.25, q.z); sofa.rotation.y = q.a; sofa.castShadow = true; this.scene.add(sofa);
      const back = new THREE.Mesh(new RoundedBoxGeometry(2.4, 0.55, 0.2, 3, 0.08), P.MAT.terracotta());
      const bq = this._at(20.85, deg, {});
      back.position.set(bq.x, y0 + 0.75, bq.z); back.rotation.y = q.a; this.scene.add(back);
      this._blockers.push({ x: q.x, z: q.z, r: 1.4 });
      const tq = this._at(19.0, deg, {});
      const table = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.4, 0.04, 24), P.MAT.walnut());
      table.position.set(tq.x, y0 + 0.42, tq.z); this.scene.add(table);
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.4, 8), P.MAT.chrome());
      leg.position.set(tq.x, y0 + 0.2, tq.z); this.scene.add(leg);
    }
    for (const deg of [-18, 18, -6, 6]) {
      const q = this._at(deg % 12 === 0 ? 12.6 : 22.2, deg, {});
      const pl = P.makeMonstera(1.1); pl.position.set(q.x, y0, q.z); this.scene.add(pl);
      pl.traverse((m) => { if (m.userData.sway) this.life.plants.push(m); });
      this._blockers.push({ x: q.x, z: q.z, r: 0.5 });
    }
  }

  /**
   * Фирменная стена стоит на ЗАПАДНОЙ границе вестибюля — плоской перегородке
   * сектора, прямо за стойкой приёма. На наружной дуге она перекрывала фриз
   * над входом и лезла в кадр зелёным квадратом посреди вида на атриум.
   *
   * Чёрный лак с логотипом и слоганом, по бокам мосс-панели подушками пяти
   * оттенков (К17 ТЗ №1): плоский короб с `bumpScale` рельефа не давал.
   */
  _brandWall(deg, y0) {
    const g = new THREE.Group();
    const a = deg * Math.PI / 180;
    // точка на перегородке: радиус вдоль неё, смещение внутрь сектора
    const on = (r, side) => ({ x: Math.sin(a) * r + Math.cos(a) * side, z: Math.cos(a) * r - Math.sin(a) * side });
    const face = a + Math.PI / 2;            // лицом внутрь сектора

    const lac = new THREE.Mesh(new THREE.BoxGeometry(7.2, 3.3, 0.18), new THREE.MeshStandardMaterial({ color: 0x0f0f10, roughness: 0.18, metalness: 0.25 }));
    const c = on(17.0, 0.12);
    lac.position.set(c.x, y0 + 1.65, c.z); lac.rotation.y = face;
    P.air(lac, 'фирменная стена');
    g.add(lac);
    const sign = P.canvasTexture(1600, 640, (cc) => this._drawBrandSign(cc, null));
    this._brandSign = sign;
    const sc = on(17.0, 0.23);
    const signMesh = new THREE.Mesh(new THREE.PlaneGeometry(6.6, 2.64), new THREE.MeshBasicMaterial({ map: sign.texture, transparent: true, toneMapped: false }));
    signMesh.position.set(sc.x, y0 + 1.8, sc.z);
    signMesh.rotation.y = face;
    P.air(signMesh);
    g.add(signMesh);
    if (this.brand.logoUrl) {
      const img = new Image();
      img.onload = () => { this._logoImg = img; this._drawBrandSign(sign.ctx, img); sign.texture.needsUpdate = true; if (this._sceneData) this._drawScreen(this._sceneData); };
      img.src = this.brand.logoUrl;
    }
    const MOSS_TONES = [0x3f7a48, 0x568a4e, 0x2f5a3a, 0x6d9a5a, 0x476b3f];
    const cushionG = new THREE.SphereGeometry(1, 8, 6);
    for (const r0 of [12.6, 21.4]) {
      const b0 = on(r0, 0.12);
      const backing = new THREE.Mesh(new THREE.BoxGeometry(2.8, 3.3, 0.1), new THREE.MeshStandardMaterial({ color: 0x24361f, roughness: 1 }));
      backing.position.set(b0.x, y0 + 1.65, b0.z); backing.rotation.y = face;
      P.air(backing, 'мосс-стена');
      g.add(backing);
      MOSS_TONES.forEach((tone, ti) => {
        const per = 100;
        const inst = new THREE.InstancedMesh(cushionG, new THREE.MeshStandardMaterial({ color: tone, roughness: 1, flatShading: true }), per);
        const m4 = new THREE.Matrix4(), qq = new THREE.Quaternion(), scv = new THREE.Vector3(), pos = new THREE.Vector3();
        for (let i = 0; i < per; i++) {
          const rr = 0.09 + Math.random() * 0.15;
          const pp = on(r0 + (Math.random() - 0.5) * 2.6, 0.2 + Math.random() * 0.05);
          pos.set(pp.x, y0 + 0.2 + Math.random() * 2.9, pp.z);
          qq.setFromEuler(new THREE.Euler(Math.random() * 3, Math.random() * 3, Math.random() * 3));
          scv.set(rr, rr * (0.7 + Math.random() * 0.5), rr * (0.55 + Math.random() * 0.3));
          m4.compose(pos, qq, scv); inst.setMatrixAt(i, m4);
        }
        inst.instanceMatrix.needsUpdate = true;
        inst.castShadow = ti < 2;
        P.air(inst);
        g.add(inst);
      });
    }
    return g;
  }

  /* ---------- чайная зона ---------- */

  /** Чайная — свой сектор кольца на юго-западе, по плану «Чайная и переход». */
  _buildLounge() {
    const y0 = RING.floor1;
    const q = this._at(17.4, 322, {});
    const g = new THREE.Group();
    g.position.set(q.x, y0, q.z);
    g.rotation.y = q.a;
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
    this._blockers.push({ x: q.x, z: q.z, r: 1.3 });
    const w = this._at(14.6, 322, {});
    this.itemAnchors.set('tea', { group: g, camPos: [w.x, y0 + 1.7, w.z], camTgt: [q.x, y0 + 0.8, q.z], walk: [w.x, w.z], look: [q.x, q.z] });
  }

  /* ---------- кульман, макет, нивелир ---------- */

  /** Кульман, макет и нивелир расставлены по секторам кольца. */
  _buildWallProps() {
    const y0 = RING.floor1;
    const qd = this._at(RING.rOut - 3.2, 205, {});     // кульман — в проектной у окна
    const g = new THREE.Group();
    g.position.set(qd.x, y0, qd.z);
    g.rotation.y = qd.a;
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
    this._blockers.push({ x: qd.x, z: qd.z, r: 1.1 });
    const wd = this._at(RING.rOut - 5.4, 205, {});
    this.itemAnchors.set('drafting', { group: g, camPos: [wd.x, y0 + 1.8, wd.z], camTgt: [qd.x, y0 + 1.4, qd.z], walk: [wd.x, wd.z], look: [qd.x, qd.z] });

    // макет на подиуме под стеклом
    const qm = this._at(RING.rIn + 2.2, 8, {});        // макет — в вестибюле у кромки атриума
    const shelf = new THREE.Group();
    shelf.position.set(qm.x, y0, qm.z);
    shelf.rotation.y = qm.a + Math.PI;
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
    this._blockers.push({ x: qm.x, z: qm.z, r: 0.9 });
    const wm = this._at(RING.rIn + 4.4, 8, {});
    this.itemAnchors.set('model', { group: shelf, camPos: [wm.x, y0 + 1.6, wm.z], camTgt: [qm.x, y0 + 1.1, qm.z], walk: [wm.x, wm.z], look: [qm.x, qm.z] });

    // нивелир на штативе
    const ql = this._at(RING.rOut - 3.0, 128, {});     // нивелир — на входе в проектную
    const level = new THREE.Group();
    level.position.set(ql.x, y0, ql.z);
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
    this._blockers.push({ x: ql.x, z: ql.z, r: 0.5 });
    const wl = this._at(RING.rOut - 5.2, 128, {});
    this.itemAnchors.set('level', { group: level, camPos: [wl.x, y0 + 1.6, wl.z], camTgt: [ql.x, y0 + 1.3, ql.z], walk: [wl.x, wl.z], look: [ql.x, ql.z] });
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

  /**
   * Развеска на наружной стене кольца — через общий список мест (В10 ТЗ №1):
   * место занимается по УГЛУ вдоль стены, проёмами считаются вход и переходы
   * в павильоны. Постер вешается только на глухой простенок.
   */
  _buildPostersAndPlants() {
    const y0 = RING.floor1;
    const r = RING.rOut - RING.wallT - 0.06;
    // проёмы по углу (в градусах): вход, переход в зал реактора, переход в мастерскую
    const OPENINGS = [[-9, 9], [258, 272], [308, 322]];
    const taken = [];
    const wDeg = (w) => (w / r) * 180 / Math.PI;      // ширина предмета в градусах
    const free = (deg, w) => slotFree(taken, OPENINGS.map(([f, t]) => [f, t]), deg, wDeg(w), 2.2)
      && slotFree(taken, OPENINGS.map(([f, t]) => [f - 360, t - 360]), deg, wDeg(w), 2.2);
    const place = (deg, w) => taken.push({ along: deg, width: wDeg(w) });
    this._wallSlots = taken;

    const mech = ['gears', 'bearing', 'turbine', 'valve'];
    let mi = 0;
    for (const deg of [30, 46, 76, 96, 124, 150, 176, 202, 228, 246]) {
      if (mi >= mech.length || !free(deg, 1.15)) continue;
      const kind = mech[mi];
      const q = this._at(r, deg, {});
      const poster = P.makePoster({ width: 1.15, frame: 'red', draw: (c, w, h) => P.drawMechanicalPoster(c, w, h, kind), pickInfo: { kind: 'poster', series: 'mech', id: kind } });
      poster.position.set(q.x, y0 + 1.72, q.z);
      poster.rotation.y = q.a;
      P.air(poster, `постер ${kind}`);
      this.scene.add(poster);
      place(deg, 1.15);
      // бра: корпус на 200 мм выше постера, свет 0.4 — кромку рамы не пережигает (К16)
      const sq = this._at(r - 0.16, deg, {});
      const sconce = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.08, 0.14), P.MAT.graphite());
      sconce.position.set(sq.x, y0 + 3.05, sq.z); sconce.rotation.y = q.a;
      P.air(sconce);
      this.scene.add(sconce);
      const lq = this._at(r - 0.45, deg, {});
      const spot = new THREE.PointLight(0xfff0dd, 0.4, 4.5, 2);
      spot.position.set(lq.x, y0 + 2.9, lq.z);
      this.scene.add(spot);
      mi += 1;
    }
    const codex = ['crane', 'arch', 'gear'];
    let ci = 0;
    for (const deg of [340, 350, 20, 60, 110, 200, 236]) {
      if (ci >= codex.length || !free(deg, 0.8)) continue;
      const kind = codex[ci];
      const q = this._at(r, deg, {});
      const poster = P.makePoster({ width: 0.8, frame: 'walnut', draw: (c, w, h) => P.drawCodexPoster(c, w, h, kind), pickInfo: { kind: 'poster', series: 'codex', id: kind } });
      poster.position.set(q.x, y0 + 1.68, q.z);
      poster.rotation.y = q.a;
      P.air(poster, `кодекс ${kind}`);
      this.scene.add(poster);
      place(deg, 0.8);
      ci += 1;
    }

    // растения по кромке атриума на обоих этажах
    for (const [deg, kind, floor] of [[42, 'ficus', 1], [88, 'monstera', 1], [140, 'ficus', 1], [196, 'monstera', 1], [244, 'ficus', 1], [300, 'monstera', 1], [70, 'ficus', 2], [160, 'monstera', 2], [250, 'ficus', 2], [330, 'monstera', 2]]) {
      const q = this._at(RING.rIn + 1.3, deg, {});
      const y = floor === 2 ? RING.floor2 : RING.floor1;
      const pl = kind === 'monstera' ? P.makeMonstera(1.2) : P.makeFicus(1.3);
      pl.position.set(q.x, y, q.z);
      this.scene.add(pl);
      const cs = P.makeContactShadow(1.2, 1.2, 0.3); cs.position.set(q.x, y + 0.006, q.z); this.scene.add(cs);
      pl.traverse((m) => { if (m.userData.sway) this.life.plants.push(m); });
      this._blockers.push({ x: q.x, z: q.z, r: 0.5, above: floor === 2 ? 3 : undefined });
    }

    // часы — над входом со стороны вестибюля
    const clock = P.canvasTexture(256, 256, () => {});
    this._clock = clock;
    const cq = this._at(RING.rOut - RING.wallT - 0.08, 0, {});
    const clockMesh = new THREE.Mesh(new THREE.CircleGeometry(0.45, 40), new THREE.MeshBasicMaterial({ map: clock.texture }));
    clockMesh.position.set(cq.x, y0 + 3.55, cq.z);
    clockMesh.rotation.y = cq.a;
    P.air(clockMesh, 'часы');
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

  /**
   * Ходоки идут ПО ПЕТЛЕ кольца — тупиков в плане нет, поэтому и маршрут
   * замкнутый. Четыре маршрута отличаются радиусом и стартовой четвертью,
   * чтобы люди не шли колонной.
   */
  _ringRoutes() {
    const out = [];
    for (let k = 0; k < 4; k++) {
      const r = RING.rIn + 2.6 + k * 2.4;
      const pts = [];
      const n = 24;
      for (let i = 0; i < n; i++) {
        const a = ((i / n) + k * 0.25) * Math.PI * 2;
        pts.push([Math.sin(a) * r, Math.cos(a) * r]);
      }
      out.push(pts);
    }
    return out;
  }

  _buildWalkers() {
    this.life.setRoutes(this._ringRoutes());
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

  /** ходьба включена всегда; метод оставлен ради совместимости вызовов */
  setWalk(on = true) {
    if (!on) return;
    if (!this.walkMode) {
      this.walkMode = true;
      const v = VIEWS.lobby;
      this.walk.enable([v.walk[0], 0, v.walk[1]], [v.look[0], 0, v.look[1]]);
    }
  }

  goTo(view) {
    const v = VIEWS[view];
    if (!v) return;
    this.walk.teleport([v.walk[0], 0, v.walk[1]], [v.look[0], 0, v.look[1]], null, view);
  }

  focusAnchor(kind) {
    const a = this.itemAnchors.get(kind);
    if (!a) return;
    const w = a.walk, l = a.look;
    const wx = w.x !== undefined ? w.x : w[0], wz = w.z !== undefined ? w.z : w[1];
    const lx = l.x !== undefined ? l.x : l[0], lz = l.z !== undefined ? l.z : l[1];
    this.walk.teleport([wx, 0, wz], [lx, 0, lz], a.floorY === undefined ? null : a.floorY, kind);
  }

  /**
   * Стартовый облёт заменён проходом ПО МАРШРУТУ в режиме ходьбы: камеры
   * обзора больше нет, а планировку логичнее показывать оттуда, откуда по ней
   * ходят. Прерывается первым же нажатием клавиши движения.
   */
  flythrough() {
    if (this.reducedMotion) { this.goTo('hall'); return Promise.resolve(); }
    const route = [
      [0, 18.6], [0, 15.0], [0, 12.2], [0, 9.0], [0, 4.0], [0, -1.0], [0, -5.0],
    ];
    return new Promise((resolve) => { this._tour = { route, i: 0, t: 0, resolve }; });
  }

  skipFlythrough() {
    if (!this._tour) return;
    const f = this._tour; this._tour = null;
    this.goTo('hall'); f.resolve();
  }

  /* ================= кадр ================= */

  update(dt) {
    this._time += dt;
    const t = this._time;
    if (this._tour) {
      const f = this._tour;
      f.t += dt * 0.42;
      while (f.t >= 1 && f.i < f.route.length - 2) { f.t -= 1; f.i += 1; }
      const a = f.route[f.i], b = f.route[Math.min(f.i + 1, f.route.length - 1)];
      const k = Math.min(1, f.t);
      const x = a[0] + (b[0] - a[0]) * k, z = a[1] + (b[1] - a[1]) * k;
      const look = f.route[f.route.length - 1];
      this.walk.teleport([x, 0, z], [look[0], 0, look[1] - 4], null);
      if (f.i >= f.route.length - 2 && k >= 1) { this._tour = null; f.resolve(); }
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
    if (!this._tour) this.walk.update(dt);
    this.renderer.render(this.scene, this.camera);
  }

  wave(seconds = 2.5) { this._wave = this._time + seconds; }

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
    this.refreshShadows();                       // солнце сменило силу — карта устарела
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
