'use strict';
/**
 * Трёхмерный зал «Виртуального офиса»: архитектура, люди, мониторы,
 * центральный экран и стол-голограмма с участком.
 *
 * Персонажи и мебель — процедурные лоу-поли из примитивов: никакой внешней
 * геометрии, весь вид держится на палитре платформы (бумага + тушь +
 * терракота). Все тексты сцены рисуются на canvas-текстурах.
 */

import * as THREE from './vendor/three.module.min.js';
import { OrbitControls } from './vendor/OrbitControls.js';

/* палитра платформы: светлая и тёмная (тёплый графит) */
const PAL = {
  light: {
    bg: 0xf3efe6, floor: 0xe9e2d4, wall: 0xf6f2e9, ceiling: 0xfdfbf4,
    accent: 0xb95740, ink: 0x26211b, muted: 0x6f665a,
    desk: 0xf1ebdf, deskEdge: 0xd8d0c0, chair: 0xfaf7ef,
    screenOff: 0x1d232c, glassWall: 0xdfe7ec,
    hemi: 0.95, sun: 0.85, monitorGlow: 0.35, lamps: 0,
  },
  dark: {
    bg: 0x201c17, floor: 0x2a251e, wall: 0x272219, ceiling: 0x191612,
    accent: 0xd0715a, ink: 0xefe9dd, muted: 0x9a8f80,
    desk: 0x332d24, deskEdge: 0x453d30, chair: 0x3a342a,
    screenOff: 0x11151b, glassWall: 0x1c2126,
    hemi: 0.28, sun: 0.12, monitorGlow: 0.9, lamps: 1,
  },
};

const MODULES = ['tz', 'site', 'doc', 'normo', 'gge', 'akty'];
const STATE_COLORS = { ok: '#4f7d58', warn: '#b07e36', bad: '#a93e2c', run: '#4a6b8a', none: '#8b8375', off: '#8b8375' };

/* виды камеры */
const VIEWS = {
  lobby:  { pos: [0, 1.65, 18.2], tgt: [0, 1.4, 12.5] },
  // зал — изнутри (z < 11): за перегородкой камера попадала внутрь перемычки проёма
  hall:   { pos: [0, 6.8, 9.6], tgt: [0, 1.2, -4.0] },
  screen: { pos: [0, 3.2, 1.5], tgt: [0, 3.2, -10.8] },
  table:  { pos: [1.8, 3.0, -2.6], tgt: [0, 1.0, -5.0] },
};

export class OfficeScene {
  constructor(canvas, { dark = false, reducedMotion = false, mobile = false } = {}) {
    this.canvas = canvas;
    this.dark = dark;
    this.reducedMotion = reducedMotion;
    this.mobile = mobile;
    this.pal = dark ? PAL.dark : PAL.light;

    this.pickables = [];
    this.people = new Map();     // module -> person rig
    this.monitors = new Map();   // module -> {canvas, ctx, texture, material}
    this.typing = new Map();     // module -> bool
    this.itemAnchors = new Map();// kind -> {group, camPos, camTgt}
    this.onPick = null;          // (info) => {}
    this.onTypingTick = null;    // (module) => {} для звука клавиш
    this._tween = null;
    this._fly = null;
    this._time = 0;
    this._sceneData = null;
    this._geomHash = '';
    this._thumbImages = new Map();

    this._init();
    this._build();
  }

  /* ================= базовая инициализация ================= */

  _init() {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: !this.mobile, alpha: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, this.mobile ? 1.5 : 2));
    this.renderer.setSize(w, h, false);
    this.renderer.shadowMap.enabled = !this.mobile;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(this.pal.bg);
    this.scene.fog = new THREE.Fog(this.pal.bg, 30, 60);

    this.camera = new THREE.PerspectiveCamera(55, w / h, 0.1, 120);
    this.camera.position.set(...VIEWS.lobby.pos);

    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.target.set(...VIEWS.lobby.tgt);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.maxPolarAngle = Math.PI * 0.495;
    this.controls.minDistance = 0.6;
    this.controls.maxDistance = 34;
    this.controls.update();

    this.hemi = new THREE.HemisphereLight(0xfffaf0, 0x8a7f6e, this.pal.hemi);
    this.scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight(0xfff2dd, this.pal.sun);
    this.sun.position.set(14, 18, 8);
    if (!this.mobile) {
      this.sun.castShadow = true;
      this.sun.shadow.mapSize.set(1024, 1024);
      this.sun.shadow.camera.left = -20; this.sun.shadow.camera.right = 20;
      this.sun.shadow.camera.top = 20; this.sun.shadow.camera.bottom = -20;
    }
    this.scene.add(this.sun);

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
    const w = this.canvas.parentElement ? this.canvas.parentElement.clientWidth || window.innerWidth : window.innerWidth;
    const h = window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
  }

  _mat(color, opts = {}) {
    return new THREE.MeshLambertMaterial({ color, ...opts });
  }

  _box(w, h, d, color, opts) {
    return new THREE.Mesh(new THREE.BoxGeometry(w, h, d), this._mat(color, opts));
  }

  _pickable(mesh, info) {
    mesh.traverse ? mesh.traverse((m) => { m.userData.pick = info; }) : (mesh.userData.pick = info);
    this.pickables.push(mesh);
  }

  _canvasTexture(w, h) {
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const texture = new THREE.CanvasTexture(canvas);
    texture.anisotropy = 4;
    texture.colorSpace = THREE.SRGBColorSpace;
    return { canvas, ctx: canvas.getContext('2d'), texture };
  }

  /* ================= архитектура ================= */

  _build() {
    const p = this.pal;

    // пол: зал (z −11…11) + лобби (z 11…21)
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(32, 34), this._mat(p.floor));
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(0, 0, 4);
    floor.receiveShadow = true;
    floor.name = 'floor';
    this.scene.add(floor);
    this._floor = floor;

    // ковровая дорожка к экрану
    const carpet = new THREE.Mesh(new THREE.PlaneGeometry(3.4, 20), this._mat(p.accent, { transparent: true, opacity: 0.12 }));
    carpet.rotation.x = -Math.PI / 2;
    carpet.position.set(0, 0.005, 1);
    this.scene.add(carpet);

    // стены
    const wallMat = this._mat(p.wall);
    const mkWall = (w, h, x, y, z, ry = 0) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), wallMat);
      m.position.set(x, y, z); m.rotation.y = ry;
      this.scene.add(m);
      return m;
    };
    this._walls = [
      mkWall(32, 8, 0, 4, -11.2),                 // северная, за экраном
      mkWall(32, 8, 0, 4, 21, Math.PI),           // южная, за лобби
      mkWall(34, 8, -16, 4, 4, Math.PI / 2),      // западная
      mkWall(34, 8, 16, 4, 4, -Math.PI / 2),      // восточная
    ];

    // перегородка лобби/зал с проёмом
    const partMat = this._mat(p.wall);
    for (const [w, x] of [[12.4, -9.8], [12.4, 9.8]]) {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, 8), partMat);
      m.position.set(x, 4, 11); this.scene.add(m);
      const m2 = m.clone(); m2.rotation.y = Math.PI; m2.position.z = 11.01; this.scene.add(m2);
    }
    const lintel = this._box(7.2, 2.4, 0.3, p.wall);
    lintel.position.set(0, 6.8, 11);
    this.scene.add(lintel);

    // световые линии потолка — фирменная деталь зала с фото
    const stripMat = new THREE.MeshBasicMaterial({ color: 0xfff6e8 });
    this._strips = [];
    for (let i = 0; i < 5; i++) {
      const s = new THREE.Mesh(new THREE.PlaneGeometry(0.25, 26), stripMat);
      s.rotation.x = Math.PI / 2;
      s.position.set(-8 + i * 4, 7.6, 2);
      this.scene.add(s);
      this._strips.push(s);
    }

    // окна: светящиеся панели на боковых стенах
    this._windows = [];
    const winMat = new THREE.MeshBasicMaterial({ color: 0xeaf2f6 });
    for (const sx of [-15.9, 15.9]) {
      for (let i = 0; i < 4; i++) {
        const m = new THREE.Mesh(new THREE.PlaneGeometry(4.6, 3.2), winMat);
        m.position.set(sx, 4.2, -6 + i * 5);
        m.rotation.y = sx < 0 ? Math.PI / 2 : -Math.PI / 2;
        this.scene.add(m);
        this._windows.push(m);
      }
    }

    this._buildScreen();
    this._buildTable();
    this._buildDesks();
    this._buildLobby();
    this._buildLounge();
    this._buildWallProps();
  }

  /* ---------- центральный экран ---------- */

  _buildScreen() {
    const { canvas, ctx, texture } = this._canvasTexture(2048, 704);
    this.screenCtx = ctx; this.screenCanvas = canvas; this.screenTexture = texture;

    // изнутри цилиндра текстура зеркалится — U разворачивается repeat.x = -1
    texture.wrapS = THREE.RepeatWrapping;
    texture.repeat.x = -1;
    const geo = new THREE.CylinderGeometry(13, 13, 5.4, 48, 1, true, Math.PI - 0.62, 1.24);
    const mat = new THREE.MeshBasicMaterial({ map: texture, side: THREE.BackSide, toneMapped: false });
    const screen = new THREE.Mesh(geo, mat);
    screen.position.set(0, 3.4, 2.2);
    this.scene.add(screen);
    this._pickable(screen, { kind: 'screen' });

    // подложка за экраном: строго позади дуги (её центр на z = −10.8),
    // иначе плита закрывает середину изогнутого полотна
    const frame = this._box(17.4, 6, 0.3, this.pal.screenOff);
    frame.position.set(0, 3.4, -11.0);
    this.scene.add(frame);
    this._screenFrame = frame;

    this._drawScreen(null);
  }

  _drawScreen(data) {
    const c = this.screenCtx;
    const W = this.screenCanvas.width;
    const H = this.screenCanvas.height;
    const night = this.dark;
    c.fillStyle = night ? '#101720' : '#14202e';
    c.fillRect(0, 0, W, H);

    const panel = (x, y, w, h) => {
      c.fillStyle = 'rgba(255,255,255,.06)';
      c.beginPath(); c.roundRect(x, y, w, h, 14); c.fill();
      c.strokeStyle = 'rgba(255,255,255,.12)'; c.stroke();
    };

    c.textBaseline = 'top';

    if (!data || !data.project) {
      c.fillStyle = '#f3efe6';
      c.font = '600 84px Georgia, serif';
      c.textAlign = 'center';
      c.fillText('ENSO-Engineering', W / 2, H / 2 - 110);
      c.font = '42px -apple-system, sans-serif';
      c.fillStyle = 'rgba(243,239,230,.75)';
      c.fillText('Enso-nexus · платформа анализа исходных данных', W / 2, H / 2 + 6);
      c.font = '30px -apple-system, sans-serif';
      c.fillStyle = 'rgba(243,239,230,.5)';
      c.fillText(data ? 'Выберите проект в лобби — сводка появится здесь' : 'Соединение с платформой…', W / 2, H / 2 + 76);
      c.textAlign = 'left';
      this.screenTexture.needsUpdate = true;
      return;
    }

    // шапка
    c.textAlign = 'left';
    c.fillStyle = '#f3efe6';
    c.font = '600 44px Georgia, serif';
    c.fillText(data.project.name, 40, 26);
    c.font = '24px -apple-system, sans-serif';
    c.fillStyle = 'rgba(243,239,230,.6)';
    const sub = [data.project.client, data.project.stage].filter(Boolean).join(' · ');
    if (sub) c.fillText(sub, 40, 82);

    // слева: сводка модулей
    const names = window.OfficeData.moduleNames;
    panel(30, 130, 560, 540);
    let y = 156;
    for (const m of MODULES) {
      const s = (data.modules && data.modules[m]) || { state: 'none', line: 'нет данных' };
      c.fillStyle = STATE_COLORS[s.state] || STATE_COLORS.none;
      c.beginPath(); c.arc(66, y + 18, 10, 0, Math.PI * 2); c.fill();
      c.fillStyle = '#f3efe6';
      c.font = '600 26px -apple-system, sans-serif';
      c.fillText(names[m], 92, y);
      c.font = '20px -apple-system, sans-serif';
      c.fillStyle = 'rgba(243,239,230,.65)';
      c.fillText(this._clip(c, s.line || '', 470), 92, y + 32);
      y += 88;
    }

    // центр: план участка
    panel(620, 130, 800, 540);
    this._drawPlanOnScreen(c, 620, 130, 800, 540, data.geometry);

    // справа: деньги и расход
    panel(1450, 130, 568, 540);
    c.fillStyle = '#f3efe6';
    c.font = '600 26px -apple-system, sans-serif';
    c.fillText('Расход за 30 дней', 1482, 156);
    if (data.stats) {
      c.font = '600 64px Georgia, serif';
      c.fillStyle = '#f3efe6';
      c.fillText(`$${(data.stats.costUsd || 0).toFixed(2)}`, 1482, 196);
      c.font = '22px -apple-system, sans-serif';
      c.fillStyle = 'rgba(243,239,230,.65)';
      c.fillText(`${data.stats.requests} обращений · ${Math.round(data.stats.tokens / 1000)}k токенов`, 1482, 272);
      // мини-гистограмма по дням
      const days = data.stats.byDay || [];
      const bw = 520 / Math.max(days.length, 1);
      const maxC = Math.max(...days.map((d) => d.costUsd), 0.01);
      for (let i = 0; i < days.length; i++) {
        const bh = Math.max(3, (days[i].costUsd / maxC) * 90);
        c.fillStyle = 'rgba(208,113,90,.85)';
        c.fillRect(1482 + i * bw, 400 - bh, Math.max(2, bw - 4), bh);
      }
    }
    c.font = '600 26px -apple-system, sans-serif';
    c.fillStyle = '#f3efe6';
    c.fillText('Счета моделей', 1482, 430);
    let by = 470;
    for (const b of (data.balances || []).slice(0, 4)) {
      c.font = '22px -apple-system, sans-serif';
      c.fillStyle = 'rgba(243,239,230,.85)';
      const val = b.availableUsd === null ? '—' : `$${Number(b.availableUsd).toFixed(2)}`;
      c.fillText(this._clip(c, b.label, 330), 1482, by);
      c.textAlign = 'right';
      c.fillText(val, 1994, by);
      c.textAlign = 'left';
      by += 40;
    }

    this._drawThumbs(c, data);
    this.screenTexture.needsUpdate = true;
  }

  _clip(c, text, w) {
    let t = String(text);
    if (c.measureText(t).width <= w) return t;
    while (t.length > 2 && c.measureText(t + '…').width > w) t = t.slice(0, -1);
    return t + '…';
  }

  /** миниатюры документов проекта — нижняя кромка центральной панели */
  _drawThumbs(c, data) {
    const docs = (data.docs || []).slice(0, 8);
    let x = 640;
    for (const d of docs) {
      const img = this._thumbImages.get(d.id);
      const bw = 88, bh = 62;
      const yy = 596;
      c.fillStyle = 'rgba(255,255,255,.08)';
      c.beginPath(); c.roundRect(x, yy, bw, bh, 6); c.fill();
      if (img && img.complete && img.naturalWidth) {
        try { c.drawImage(img, x + 3, yy + 3, bw - 6, bh - 6); } catch { /* картинка битая */ }
      } else {
        c.fillStyle = 'rgba(243,239,230,.5)';
        c.font = '600 18px -apple-system, sans-serif';
        c.textAlign = 'center';
        c.fillText(d.ext.toUpperCase().slice(0, 4), x + bw / 2, yy + 22);
        c.textAlign = 'left';
        if (d.ext === 'pdf' && data.project) this._loadThumb(d.id, data.project.id);
      }
      x += bw + 10;
    }
  }

  _loadThumb(fileId, projectId) {
    if (this._thumbImages.has(fileId)) return;
    const img = new Image();
    this._thumbImages.set(fileId, img);
    img.onload = () => { if (this._sceneData) this._drawScreen(this._sceneData); };
    img.src = `/api/office/doc-thumb/${fileId}?project=${encodeURIComponent(projectId)}`;
  }

  /** план участка на канве: участок, зоны штриховкой ZoneStyle, пятно */
  _drawPlanOnScreen(c, px, py, pw, ph, geometry) {
    c.save();
    c.beginPath(); c.rect(px, py, pw, ph); c.clip();
    if (!geometry || !geometry.parcel) {
      c.fillStyle = 'rgba(243,239,230,.45)';
      c.font = '26px -apple-system, sans-serif';
      c.textAlign = 'center';
      c.fillText('План участка появится после разбора чертежа', px + pw / 2, py + ph / 2 - 10);
      c.textAlign = 'left';
      c.restore();
      return;
    }
    const pts = geometry.parcel.geometry.points || [];
    const all = [...pts];
    for (const z of geometry.zones || []) this._collectPoints(z.geometry, all);
    const bb = this._bbox(all);
    const pad = 46;
    const scale = Math.min((pw - pad * 2) / (bb.w || 1), (ph - pad * 2 - 60) / (bb.h || 1));
    const tx = (x) => px + pad + (x - bb.minX) * scale;
    const ty = (y) => py + ph - pad - (y - bb.minY) * scale;

    const drawPoly = (points, close = true) => {
      c.beginPath();
      points.forEach(([x, y], i) => (i ? c.lineTo(tx(x), ty(y)) : c.moveTo(tx(x), ty(y))));
      if (close) c.closePath();
    };

    // зоны — штриховкой в цветах ZoneStyle
    for (const z of geometry.zones || []) {
      const st = window.ZoneStyle.zone(z.kind);
      for (const poly of this._polysOf(z.geometry)) {
        drawPoly(poly);
        c.save(); c.clip();
        c.strokeStyle = st.color; c.lineWidth = 1.4; c.globalAlpha = 0.75;
        const step = Math.max(6, st.spacing);
        const ang = (st.angle * Math.PI) / 180;
        const diag = Math.hypot(pw, ph);
        for (let d = -diag; d < diag; d += step) {
          c.beginPath();
          c.moveTo(px + pw / 2 + Math.cos(ang) * -diag - Math.sin(ang) * d, py + ph / 2 + Math.sin(ang) * -diag + Math.cos(ang) * d);
          c.lineTo(px + pw / 2 + Math.cos(ang) * diag - Math.sin(ang) * d, py + ph / 2 + Math.sin(ang) * diag + Math.cos(ang) * d);
          c.stroke();
        }
        c.restore();
        drawPoly(poly);
        c.strokeStyle = st.color; c.globalAlpha = 0.9; c.lineWidth = 1.6; c.stroke();
        c.globalAlpha = 1;
      }
    }

    // участок
    drawPoly(pts);
    c.strokeStyle = '#f3efe6'; c.lineWidth = 3; c.stroke();

    // выбранный вариант пятна
    const v = this._selectedVariant(geometry);
    if (v && v.footprint) {
      for (const poly of this._polysOf(v.footprint)) {
        drawPoly(poly);
        c.fillStyle = 'rgba(126,176,138,.4)'; c.fill();
        c.strokeStyle = '#7eb08a'; c.lineWidth = 2.4; c.stroke();
      }
    }
    c.fillStyle = 'rgba(243,239,230,.8)';
    c.font = '22px -apple-system, sans-serif';
    c.fillText(`Участок ${geometry.parcel.areaM2 ? geometry.parcel.areaM2 + ' м²' : ''} · зон: ${(geometry.zones || []).length}`, px + 24, py + 18);
    c.restore();
  }

  _collectPoints(g, out) {
    for (const poly of this._polysOf(g)) for (const p of poly) out.push(p);
  }

  _polysOf(g) {
    if (!g) return [];
    if (g.type === 'multipolygon') return (g.polygons || []).map((p) => p.points || []);
    if (g.points) return [g.points];
    if (Array.isArray(g)) return [g];
    return [];
  }

  _bbox(points) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [x, y] of points) {
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    if (!Number.isFinite(minX)) { minX = 0; minY = 0; maxX = 1; maxY = 1; }
    return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
  }

  _selectedVariant(geometry) {
    if (!geometry || !geometry.run || !geometry.run.variants) return null;
    const wanted = this._variantId
      ? geometry.run.variants.find((v) => v.id === this._variantId)
      : null;
    return wanted || geometry.run.variants.find((v) => v.selected) || geometry.run.variants[0] || null;
  }

  /* ---------- стол с участком ---------- */

  _buildTable() {
    const p = this.pal;
    const g = new THREE.Group();
    g.position.set(0, 0, -5);

    const top = this._box(3.4, 0.12, 2.4, 0x2c2620);
    top.position.y = 0.92;
    top.castShadow = true;
    g.add(top);
    const rim = this._box(3.5, 0.05, 2.5, p.accent);
    rim.position.y = 0.99;
    g.add(rim);
    for (const [sx, sz] of [[-1.5, -1.0], [1.5, -1.0], [-1.5, 1.0], [1.5, 1.0]]) {
      const leg = this._box(0.12, 0.9, 0.12, 0x3a332a);
      leg.position.set(sx, 0.45, sz);
      g.add(leg);
    }

    this.tableHolo = new THREE.Group();
    this.tableHolo.position.set(0, 1.02, 0);
    g.add(this.tableHolo);

    this.scene.add(g);
    this._tableGroup = g;
    this._pickable(g, { kind: 'table' });
    this.itemAnchors.set('table', { group: g, camPos: [1.6, 2.6, -3.2], camTgt: [0, 1.1, -5] });
    this._drawTablePlaceholder();
  }

  _drawTablePlaceholder() {
    this.tableHolo.clear();
    const plate = new THREE.Mesh(new THREE.PlaneGeometry(3.0, 2.0), this._mat(0x223140, { transparent: true, opacity: 0.9 }));
    plate.rotation.x = -Math.PI / 2;
    plate.position.y = 0.005;
    this.tableHolo.add(plate);
    const { canvas, ctx, texture } = this._canvasTexture(512, 340);
    ctx.fillStyle = '#223140'; ctx.fillRect(0, 0, 512, 340);
    ctx.fillStyle = 'rgba(243,239,230,.75)';
    ctx.font = '600 30px Georgia, serif'; ctx.textAlign = 'center';
    ctx.fillText('Стол проекта', 256, 140);
    ctx.font = '20px -apple-system, sans-serif';
    ctx.fillStyle = 'rgba(243,239,230,.5)';
    ctx.fillText('план появится после разбора чертежа', 256, 185);
    plate.material = new THREE.MeshBasicMaterial({ map: texture, transparent: true, opacity: 0.96 });
  }

  /** участок + зоны + здание на столе; вызывается при смене геометрии/варианта */
  setTableGeometry(geometry, variantId = '') {
    this._variantId = variantId || this._variantId;
    if (!geometry || !geometry.parcel) { this._drawTablePlaceholder(); return; }
    const hash = JSON.stringify([geometry.parcel.areaM2, (geometry.zones || []).length,
      geometry.run && geometry.run.createdAt, this._variantId]);
    if (hash === this._geomHash) return;
    this._geomHash = hash;

    this.tableHolo.clear();

    const pts = geometry.parcel.geometry.points || [];
    const bb = this._bbox(pts);
    const scale = Math.min(2.9 / (bb.w || 1), 1.9 / (bb.h || 1));
    const cx = (bb.minX + bb.maxX) / 2;
    const cy = (bb.minY + bb.maxY) / 2;
    const map = ([x, y]) => [(x - cx) * scale, -(y - cy) * scale];

    const shapeOf = (poly) => {
      const s = new THREE.Shape();
      poly.forEach((pt, i) => {
        const [x, z] = map(pt);
        if (i) s.lineTo(x, z); else s.moveTo(x, z);
      });
      s.closePath();
      return s;
    };

    // подложка-«бумага» участка
    const parcelShape = shapeOf(pts);
    const parcelMesh = new THREE.Mesh(
      new THREE.ExtrudeGeometry(parcelShape, { depth: 0.02, bevelEnabled: false }),
      this._mat(this.dark ? 0x3d4a3f : 0xdde7d9),
    );
    parcelMesh.rotation.x = -Math.PI / 2;
    parcelMesh.position.y = 0.0;
    this.tableHolo.add(parcelMesh);
    const outline = new THREE.LineLoop(
      new THREE.BufferGeometry().setFromPoints(pts.map((pt) => {
        const [x, z] = map(pt);
        return new THREE.Vector3(x, 0.035, z);
      })),
      new THREE.LineBasicMaterial({ color: this.pal.ink }),
    );
    this.tableHolo.add(outline);

    // зоны: полупрозрачные призмы в цветах ZoneStyle
    for (const z of (geometry.zones || []).slice(0, 40)) {
      const st = window.ZoneStyle.zone(z.kind);
      const color = new THREE.Color(st.color);
      for (const poly of this._polysOf(z.geometry)) {
        if (poly.length < 3) continue;
        try {
          const zone = new THREE.Mesh(
            new THREE.ExtrudeGeometry(shapeOf(poly), { depth: 0.16, bevelEnabled: false }),
            new THREE.MeshLambertMaterial({ color, transparent: true, opacity: 0.28, depthWrite: false }),
          );
          zone.rotation.x = -Math.PI / 2;
          zone.position.y = 0.02;
          zone.userData.pick = { kind: 'zone', id: z.id, label: z.label, zone: z };
          this.tableHolo.add(zone);
        } catch { /* дырявый полигон — пропуск одной зоны не роняет стол */ }
      }
    }

    // здание выбранного варианта: этажи растут по одному
    const v = this._selectedVariant(geometry);
    if (v && v.footprint) {
      const floors = Math.max(1, Math.round(v.floors || 1));
      this._buildingFloors = [];
      for (const poly of this._polysOf(v.footprint)) {
        if (poly.length < 3) continue;
        for (let f = 0; f < floors; f++) {
          try {
            const floor = new THREE.Mesh(
              new THREE.ExtrudeGeometry(shapeOf(poly), { depth: 0.11, bevelEnabled: false }),
              this._mat(f === floors - 1 ? 0xf1ebdf : 0xe4dccb),
            );
            floor.rotation.x = -Math.PI / 2;
            floor.position.y = 0.03 + f * 0.115;
            floor.scale.set(1, 0.001, 1);
            floor.userData.pick = { kind: 'building', variant: v };
            floor.castShadow = true;
            this.tableHolo.add(floor);
            this._buildingFloors.push({ mesh: floor, delay: 0.35 + f * 0.45 });
          } catch { /* сложный контур */ }
        }
      }
      this._buildStart = this._time;
    }
  }

  /* ---------- столы агентов ---------- */

  _deskPositions() {
    // амфитеатр: 4 дуги к экрану, 30 столов, свободная рассадка со сдвигами
    const rows = [
      { z: -1.2, count: 6, r: 12.5 },
      { z: 1.8, count: 7, r: 15.5 },
      { z: 4.8, count: 8, r: 18.5 },
      { z: 7.8, count: 9, r: 21.5 },
    ];
    const out = [];
    const rnd = this._seeded(7);
    rows.forEach((row, ri) => {
      for (let i = 0; i < row.count; i++) {
        const t = (i + 0.5) / row.count - 0.5;
        const ang = t * 1.15;
        const x = Math.sin(ang) * row.r * 1.05 + (rnd() - 0.5) * 0.5;
        const z = row.z + (1 - Math.cos(ang)) * row.r * 0.35 + (rnd() - 0.5) * 0.45;
        // монитор (локальная −z) смотрит на экран в точке (0, −14)
        const yaw = Math.atan2(x, z + 14) + (rnd() - 0.5) * 0.12;
        out.push({ x, z, yaw, row: ri, col: i });
      }
    });
    return out;
  }

  _seeded(seed) {
    let s = seed;
    return () => {
      s = (s * 16807) % 2147483647;
      return (s - 1) / 2147483646;
    };
  }

  _buildDesks() {
    const p = this.pal;
    const positions = this._deskPositions();
    const personas = window.OfficeData.personas;

    // модуль → номер стола (ряд/место из данных персон)
    const deskOf = {};
    for (const [mod, cfg] of Object.entries(personas)) {
      const found = positions.findIndex((d) => d.row === cfg.deskRow && d.col === cfg.deskCol);
      deskOf[mod] = found >= 0 ? found : Object.keys(deskOf).length;
    }

    this._desks = [];
    positions.forEach((pos, i) => {
      const mod = Object.keys(deskOf).find((m) => deskOf[m] === i) || null;
      const desk = this._makeDesk(pos, mod);
      this._desks.push(desk);
    });
  }

  _makeDesk(pos, module) {
    const p = this.pal;
    const g = new THREE.Group();
    g.position.set(pos.x, 0, pos.z);
    g.rotation.y = pos.yaw; // монитором к экрану, креслом к залу

    // столешница со скруглением (белая, как на фото)
    const top = this._box(1.7, 0.06, 0.8, p.desk);
    top.position.y = 0.74;
    top.castShadow = true;
    g.add(top);
    const edge = this._box(1.7, 0.02, 0.8, p.deskEdge);
    edge.position.y = 0.705;
    g.add(edge);
    const base = this._box(0.5, 0.7, 0.5, p.deskEdge);
    base.position.set(0, 0.35, 0.05);
    g.add(base);

    // перегородка-экран между столами
    const divider = this._box(1.7, 0.35, 0.03, p.chair, { transparent: true, opacity: 0.8 });
    divider.position.set(0, 0.95, -0.42);
    g.add(divider);

    // изогнутый ультраширокий монитор
    const mon = this._makeMonitor(module);
    mon.position.set(0, 1.02, -0.22);
    g.add(mon);

    // клавиатура MX Keys и мышь MX Master
    const kb = this._box(0.42, 0.015, 0.13, 0x3a3a3c);
    kb.position.set(-0.05, 0.78, 0.12);
    g.add(kb);
    const mouse = new THREE.Mesh(new THREE.SphereGeometry(0.035, 10, 8), this._mat(0x2e2e30));
    mouse.scale.set(1, 0.55, 1.4);
    mouse.position.set(0.32, 0.785, 0.14);
    g.add(mouse);

    // терракотовый блокнот ENSO + ручка + карандаш Perfect Pencil
    const pad = this._box(0.15, 0.012, 0.21, p.accent);
    pad.position.set(-0.55, 0.78, 0.1);
    pad.rotation.y = 0.2;
    g.add(pad);
    const pen = new THREE.Mesh(new THREE.CylinderGeometry(0.005, 0.005, 0.14, 6), this._mat(0x26211b));
    pen.rotation.z = Math.PI / 2; pen.rotation.y = 0.5;
    pen.position.set(-0.52, 0.79, 0.24);
    g.add(pen);
    const pencil = new THREE.Mesh(new THREE.CylinderGeometry(0.004, 0.004, 0.16, 6), this._mat(0xc0c0c4));
    pencil.rotation.z = Math.PI / 2; pencil.rotation.y = -0.3;
    pencil.position.set(-0.6, 0.79, 0.28);
    g.add(pencil);

    // кресло
    const chair = new THREE.Group();
    const seat = this._box(0.5, 0.08, 0.48, p.chair);
    seat.position.y = 0.45;
    chair.add(seat);
    const back = this._box(0.48, 0.55, 0.07, p.chair);
    back.position.set(0, 0.78, 0.25);
    chair.add(back);
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.4, 8), this._mat(0x9a948a));
    pole.position.y = 0.22;
    chair.add(pole);
    chair.position.set(0, 0, 0.55);
    g.add(chair);

    let person = null;
    if (module) {
      const cfg = window.OfficeData.personas[module];
      person = this._makePerson(cfg);
      person.group.position.set(0, 0, 0.45);
      g.add(person.group);
      this.people.set(module, person);
      this._pickable(g, { kind: 'agent', module });
    } else {
      this._pickable(g, { kind: 'desk' });
    }

    this.scene.add(g);
    g.updateMatrixWorld(true);

    if (module) {
      const camPos = g.localToWorld(new THREE.Vector3(0, 1.75, -1.9));
      const camTgt = g.localToWorld(new THREE.Vector3(0, 1.0, 0.4));
      this.itemAnchors.set(`agent:${module}`, {
        group: g,
        camPos: [camPos.x, camPos.y, camPos.z],
        camTgt: [camTgt.x, camTgt.y, camTgt.z],
      });
      const cfg = window.OfficeData.personas[module];
      // настольные фишки; кульман, макет и нивелир стоят у стен и якорятся там
      if (['cube', 'chess', 'go'].includes(cfg.item)) this._placeItemAnchor(cfg.item, g);
    }
    return { group: g, module, person };
  }

  _makeMonitor(module) {
    const g = new THREE.Group();
    // Odyssey G9 «51»: сильно изогнутая панель 32:9
    const geo = new THREE.CylinderGeometry(0.8, 0.8, 0.34, 24, 1, true, Math.PI - 0.55, 1.1);
    let mat;
    if (module) {
      const mc = this._canvasTexture(768, 256);
      mc.texture.wrapS = THREE.RepeatWrapping;
      mc.texture.repeat.x = -1;
      this.monitors.set(module, mc);
      this._drawMonitor(module, null);
      mat = new THREE.MeshBasicMaterial({ map: mc.texture, side: THREE.BackSide, toneMapped: false });
    } else {
      mat = new THREE.MeshLambertMaterial({ color: this.pal.screenOff, side: THREE.BackSide });
    }
    const panel = new THREE.Mesh(geo, mat);
    panel.position.z = 0.72;
    g.add(panel);
    // задняя стенка корпуса: изнутри рисуется экран, снаружи — тёмный пластик,
    // иначе спереди монитор прозрачен
    const shell = new THREE.Mesh(
      new THREE.CylinderGeometry(0.81, 0.81, 0.35, 24, 1, true, Math.PI - 0.55, 1.1),
      this._mat(0x2e2e30),
    );
    shell.position.z = 0.72;
    g.add(shell);
    const stand = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.03, 0.24, 8), this._mat(0x2e2e30));
    stand.position.y = -0.18;
    g.add(stand);
    const foot = this._box(0.3, 0.02, 0.18, 0x2e2e30);
    foot.position.y = -0.3;
    g.add(foot);
    g.position.y = 0.3;
    return g;
  }

  /** монитор агента: имя роли + последние строки журнала или сводки */
  _drawMonitor(module, data) {
    const mc = this.monitors.get(module);
    if (!mc) return;
    const c = mc.ctx;
    const W = mc.canvas.width, H = mc.canvas.height;
    c.fillStyle = '#182230';
    c.fillRect(0, 0, W, H);
    c.fillStyle = 'rgba(208,113,90,.9)';
    c.fillRect(0, 0, W, 8);
    const names = window.OfficeData.moduleNames;
    c.fillStyle = '#f3efe6';
    c.font = '600 30px -apple-system, sans-serif';
    c.textBaseline = 'top';
    c.fillText(names[module] || module, 24, 24);

    const lines = [];
    if (data) {
      if (module === 'site' && data.journal && data.journal.length) {
        for (const e of data.journal.slice(-4)) lines.push(`${e.stage}: ${e.detail || ''}`);
      } else if (data.modules && data.modules[module]) {
        lines.push(data.modules[module].line || '');
        if (data.modules[module].at) lines.push(new Date(data.modules[module].at).toLocaleString('ru-RU'));
      }
      if (module === 'site' && data.progress && data.progress.label) {
        lines.unshift(`▸ ${data.progress.label}`);
      }
    }
    if (!lines.length) lines.push('ожидание задач…');
    c.font = '22px ui-monospace, monospace';
    let y = 76;
    for (const line of lines.slice(0, 5)) {
      c.fillStyle = line.startsWith('▸') ? '#d0715a' : 'rgba(243,239,230,.75)';
      c.fillText(this._clip(c, line, W - 48), 24, y);
      y += 34;
    }
    mc.texture.needsUpdate = true;
  }

  /* ---------- человечки ---------- */

  _makePerson(cfg) {
    const g = new THREE.Group();
    const polo = this.pal.accent;
    const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.16, 0.28, 4, 10), this._mat(polo));
    torso.position.y = 0.78;
    torso.castShadow = true;
    g.add(torso);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.11, 14, 12), this._mat(cfg.skin));
    head.position.y = 1.14;
    g.add(head);
    const hair = new THREE.Mesh(
      new THREE.SphereGeometry(0.115, 14, 10, 0, Math.PI * 2, 0, Math.PI * 0.55),
      this._mat(cfg.hair),
    );
    hair.position.y = 1.16;
    g.add(hair);
    if (cfg.glasses) {
      const gl = this._box(0.16, 0.03, 0.02, 0x26211b);
      gl.position.set(0, 1.14, -0.1);
      g.add(gl);
    }
    const mkArm = (side) => {
      const arm = new THREE.Group();
      const upper = new THREE.Mesh(new THREE.CapsuleGeometry(0.045, 0.3, 3, 8), this._mat(polo));
      upper.position.y = -0.15;
      arm.add(upper);
      const hand = new THREE.Mesh(new THREE.SphereGeometry(0.05, 8, 8), this._mat(cfg.skin));
      hand.position.y = -0.34;
      arm.add(hand);
      arm.position.set(0.2 * side, 0.95, -0.02);
      arm.rotation.x = -1.05;
      arm.rotation.z = -0.25 * side;
      g.add(arm);
      return arm;
    };
    const armL = mkArm(-1);
    const armR = mkArm(1);
    const legs = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.12, 0.4), this._mat(0x35302a));
    legs.position.set(0, 0.5, -0.15);
    g.add(legs);
    return { group: g, head, torso, armL, armR, phase: Math.random() * Math.PI * 2 };
  }

  /* ---------- лобби ---------- */

  _buildLobby() {
    const p = this.pal;

    // стойка секретаря
    const g = new THREE.Group();
    g.position.set(0, 0, 14.5);
    const counter = this._box(3.2, 1.05, 0.8, p.desk);
    counter.position.y = 0.53;
    counter.castShadow = true;
    g.add(counter);
    const counterTop = this._box(3.3, 0.05, 0.9, p.accent);
    counterTop.position.y = 1.08;
    g.add(counterTop);

    // секретарь стоит за стойкой
    const cfg = { hair: 0x4b3222, skin: 0xf0cdaa, glasses: false };
    const s = this._makePerson(cfg);
    s.group.position.set(0, 0.28, -0.75);
    s.group.scale.set(1.05, 1.05, 1.05);
    g.add(s.group);
    this.secretary = s;
    this.scene.add(g);
    this._pickable(g, { kind: 'secretary' });
    this.itemAnchors.set('secretary', { group: g, camPos: [0, 1.7, 16.9], camTgt: [0, 1.35, 14.2] });

    // вывеска: ENSO-Engineering / Enso-nexus
    const sign = this._canvasTexture(1024, 300);
    const sc = sign.ctx;
    sc.fillStyle = this.dark ? '#191612' : '#fdfbf4';
    sc.fillRect(0, 0, 1024, 300);
    sc.fillStyle = this.dark ? '#d0715a' : '#b95740';
    sc.font = '600 92px Georgia, serif';
    sc.textAlign = 'center';
    sc.fillText('ENSO-Engineering', 512, 82);
    sc.fillStyle = this.dark ? '#efe9dd' : '#26211b';
    sc.font = '48px -apple-system, sans-serif';
    sc.fillText('Enso-nexus · виртуальный офис', 512, 198);
    const signMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(6.4, 1.9),
      new THREE.MeshBasicMaterial({ map: sign.texture, toneMapped: false }),
    );
    signMesh.position.set(0, 4.4, 20.9);
    signMesh.rotation.y = Math.PI;
    this.scene.add(signMesh);

    // таблички-«сертификаты» на стенах лобби
    (window.OfficeData.plaques || []).forEach((pl, i) => {
      const t = this._canvasTexture(512, 360);
      const c = t.ctx;
      c.fillStyle = this.dark ? '#2a251e' : '#fdfbf4';
      c.fillRect(0, 0, 512, 360);
      c.strokeStyle = this.dark ? '#d0715a' : '#b95740';
      c.lineWidth = 10;
      c.strokeRect(18, 18, 476, 324);
      c.fillStyle = this.dark ? '#efe9dd' : '#26211b';
      c.font = '600 84px Georgia, serif';
      c.textAlign = 'center';
      c.fillText(pl.title, 256, 150);
      c.font = '30px -apple-system, sans-serif';
      c.fillStyle = this.dark ? '#9a8f80' : '#6f665a';
      this._wrapText(c, pl.sub, 256, 220, 430, 38);
      const side = i < 3 ? -1 : 1;
      const m = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 1.15), new THREE.MeshBasicMaterial({ map: t.texture, toneMapped: false }));
      m.position.set(side * 15.85, 2.6, 13.2 + (i % 3) * 2.6);
      m.rotation.y = side < 0 ? Math.PI / 2 : -Math.PI / 2;
      this.scene.add(m);
      this._pickable(m, { kind: 'plaque', index: i });
    });

    // диваны ожидания
    for (const sx of [-4.5, 4.5]) {
      const sofa = this._box(2.2, 0.5, 0.9, p.accent, { transparent: true, opacity: 0.92 });
      sofa.position.set(sx, 0.25, 17.5);
      this.scene.add(sofa);
      const back = this._box(2.2, 0.5, 0.18, p.accent, { transparent: true, opacity: 0.92 });
      back.position.set(sx, 0.7, 17.9);
      this.scene.add(back);
    }
  }

  _wrapText(c, text, x, y, maxW, lh) {
    const words = String(text).split(' ');
    let line = '';
    for (const w of words) {
      if (c.measureText(line + w).width > maxW && line) {
        c.fillText(line.trim(), x, y);
        y += lh;
        line = w + ' ';
      } else line += w + ' ';
    }
    c.fillText(line.trim(), x, y);
  }

  /* ---------- чайная зона и настенные предметы ---------- */

  _buildLounge() {
    const p = this.pal;
    const g = new THREE.Group();
    g.position.set(12.5, 0, 6.5);

    const table = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.7, 0.06, 20), this._mat(0x6b4f35));
    table.position.y = 0.55;
    g.add(table);
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.09, 0.55, 10), this._mat(0x4a3625));
    leg.position.y = 0.27;
    g.add(leg);

    // чайник и пиалы
    const potBody = new THREE.Mesh(new THREE.SphereGeometry(0.11, 14, 10), this._mat(0x7a4a33));
    potBody.scale.y = 0.8;
    potBody.position.set(0, 0.66, 0);
    g.add(potBody);
    const spout = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.03, 0.16, 8), this._mat(0x7a4a33));
    spout.rotation.z = 1.0;
    spout.position.set(0.14, 0.68, 0);
    g.add(spout);
    this.teapot = potBody;
    for (let i = 0; i < 4; i++) {
      const cup = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.028, 0.035, 10), this._mat(0xf1ebdf));
      cup.position.set(Math.cos(i * 1.6) * 0.32, 0.6, Math.sin(i * 1.6) * 0.32);
      g.add(cup);
    }

    // мастер чаепития
    const tm = this._makePerson({ hair: 0x1d1a17, skin: 0xd9a878, glasses: false });
    tm.group.position.set(0, 0, 0.95);
    tm.group.rotation.y = Math.PI;
    g.add(tm.group);
    this.teaMaster = tm;

    // табуреты
    for (const a of [-0.9, 2.2, 4.0]) {
      const st = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.25, 0.45, 12), this._mat(p.chair));
      st.position.set(Math.cos(a) * 1.1, 0.22, Math.sin(a) * 1.1);
      g.add(st);
    }

    this.scene.add(g);
    this._pickable(g, { kind: 'item', item: 'tea' });
    this.itemAnchors.set('tea', { group: g, camPos: [10.6, 1.7, 4.8], camTgt: [12.5, 0.8, 6.5] });
  }

  _buildWallProps() {
    const p = this.pal;

    // кульман с чертежом у западной стены
    const g = new THREE.Group();
    g.position.set(-13.2, 0, 3);
    g.rotation.y = Math.PI / 2.4;
    const board = this._box(1.7, 1.2, 0.05, 0xf6f2e9);
    board.position.set(0, 1.45, 0);
    board.rotation.x = -0.25;
    g.add(board);
    const drawing = this._canvasTexture(512, 360);
    this._drawBlueprint(drawing.ctx);
    const sheet = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 1.0), new THREE.MeshBasicMaterial({ map: drawing.texture, toneMapped: false }));
    sheet.position.set(0, 1.46, 0.033);
    sheet.rotation.x = -0.25;
    g.add(sheet);
    this._blueprintCtx = drawing;
    for (const sx of [-0.6, 0.6]) {
      const legF = this._box(0.06, 1.8, 0.06, 0x8b8375);
      legF.position.set(sx, 0.9, 0.25);
      legF.rotation.x = 0.2;
      g.add(legF);
      const legB = this._box(0.06, 1.8, 0.06, 0x8b8375);
      legB.position.set(sx, 0.9, -0.25);
      legB.rotation.x = -0.2;
      g.add(legB);
    }
    this.scene.add(g);
    this._pickable(g, { kind: 'item', item: 'drafting' });
    this.itemAnchors.set('drafting', { group: g, camPos: [-11.2, 1.8, 4.6], camTgt: [-13.2, 1.4, 3] });

    // полка с макетом АВИВАК-2 у восточной стены
    const shelf = new THREE.Group();
    shelf.position.set(13.4, 0, -2.5);
    shelf.rotation.y = -Math.PI / 2;
    const plinth = this._box(1.3, 0.9, 0.7, p.deskEdge);
    plinth.position.y = 0.45;
    shelf.add(plinth);
    const modelBase = this._box(1.1, 0.04, 0.55, 0xdde7d9);
    modelBase.position.y = 0.93;
    shelf.add(modelBase);
    // ступенчатый корпус: память о «двухэтажка проходит ступенчатой формой»
    const b1 = this._box(0.5, 0.18, 0.3, 0xf1ebdf); b1.position.set(-0.15, 1.0, 0); shelf.add(b1);
    const b2 = this._box(0.3, 0.36, 0.3, 0xf1ebdf); b2.position.set(0.23, 1.09, 0); shelf.add(b2);
    const glass = this._box(1.15, 0.5, 0.6, p.glassWall, { transparent: true, opacity: 0.25 });
    glass.position.y = 1.18;
    shelf.add(glass);
    this.scene.add(shelf);
    this._pickable(shelf, { kind: 'item', item: 'model' });
    this.itemAnchors.set('model', { group: shelf, camPos: [11.4, 1.6, -1.2], camTgt: [13.4, 1.0, -2.5] });

    // нивелир на штативе рядом с кульманом
    const level = new THREE.Group();
    level.position.set(-12.6, 0, 6.2);
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2;
      const tleg = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.03, 1.3, 6), this._mat(0xb07e36));
      tleg.position.set(Math.cos(a) * 0.3, 0.6, Math.sin(a) * 0.3);
      tleg.rotation.z = Math.cos(a) * 0.35;
      tleg.rotation.x = -Math.sin(a) * 0.35;
      level.add(tleg);
    }
    const dev = this._box(0.3, 0.12, 0.12, 0x35302a);
    dev.position.y = 1.32;
    level.add(dev);
    const lens = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.34, 10), this._mat(0x26211b));
    lens.rotation.z = Math.PI / 2;
    dev.add(lens);
    this.scene.add(level);
    this._pickable(level, { kind: 'item', item: 'level' });
    this.itemAnchors.set('level', { group: level, camPos: [-10.8, 1.6, 7.6], camTgt: [-12.6, 1.2, 6.2] });
  }

  _drawBlueprint(c) {
    c.fillStyle = '#fdfbf4';
    c.fillRect(0, 0, 512, 360);
    c.strokeStyle = '#26211b'; c.lineWidth = 2;
    c.strokeRect(14, 14, 484, 332);
    c.strokeRect(340, 290, 158, 56); // штамп
    c.strokeStyle = '#b95740'; c.lineWidth = 2.5;
    c.strokeRect(90, 80, 240, 160);
    c.strokeStyle = '#4a6b8a'; c.lineWidth = 1.5;
    c.beginPath(); c.moveTo(60, 300); c.lineTo(440, 60); c.stroke();
    c.beginPath(); c.moveTo(60, 60); c.lineTo(200, 300); c.stroke();
    c.fillStyle = '#26211b'; c.font = '16px ui-monospace, monospace';
    c.fillText('ГПЗУ · М 1:500', 350, 322);
  }

  _placeItemAnchor(item, deskGroup) {
    // якорь для фишки на столе: сам предмет строит модуль игр
    const holder = new THREE.Group();
    holder.position.set(0.62, 0.77, 0.3);
    deskGroup.add(holder);
    deskGroup.updateMatrixWorld(true);
    const world = new THREE.Vector3();
    holder.getWorldPosition(world);
    // камера сбоку от стола, над краем: за креслом она упиралась в спинку
    const camPos = deskGroup.localToWorld(new THREE.Vector3(1.25, 1.3, 0.75));
    this.itemAnchors.set(item, {
      group: holder,
      camPos: [camPos.x, camPos.y, camPos.z],
      camTgt: [world.x, world.y + 0.08, world.z],
    });
    this._pickable(holder, { kind: 'item', item });
  }

  /* ================= данные сцены ================= */

  setSceneData(data) {
    this._sceneData = data;
    for (const m of MODULES) {
      this._drawMonitor(m, data);
      const state = data.modules && data.modules[m] ? data.modules[m].state : 'none';
      const running = state === 'run' || (m === 'site' && data.progress);
      this.typing.set(m, !!running);
    }
    this._drawScreen(data);
    if (data.geometry) this.setTableGeometry(data.geometry);
  }

  setVariant(variantId) {
    this._geomHash = '';
    if (this._sceneData && this._sceneData.geometry) this.setTableGeometry(this._sceneData.geometry, variantId);
  }

  /* ================= камера ================= */

  goTo(view, ms = 1400) {
    const v = VIEWS[view];
    if (!v) return;
    this._tweenTo(new THREE.Vector3(...v.pos), new THREE.Vector3(...v.tgt), this.reducedMotion ? 0 : ms);
  }

  focusAnchor(kind, ms = 1100) {
    const a = this.itemAnchors.get(kind);
    if (!a) return;
    this._tweenTo(new THREE.Vector3(...a.camPos), new THREE.Vector3(...a.camTgt), this.reducedMotion ? 0 : ms);
  }

  _tweenTo(pos, tgt, ms) {
    if (ms <= 0) {
      // мгновенный переход отменяет и незавершённый твин, и пролёт
      this._tween = null;
      if (this._fly) { const f = this._fly; this._fly = null; f.resolve(); }
      this.camera.position.copy(pos);
      this.controls.target.copy(tgt);
      this.controls.update();
      return;
    }
    this._tween = {
      p0: this.camera.position.clone(), p1: pos,
      t0: this.controls.target.clone(), t1: tgt,
      start: this._time, ms,
    };
  }

  /** пролёт лобби → зал; resolve по завершении или пропуску */
  flythrough() {
    if (this.reducedMotion) {
      this.goTo('hall', 0);
      return Promise.resolve();
    }
    // сквозь проём на уровне глаз, затем подъём над залом
    const path = new THREE.CatmullRomCurve3([
      new THREE.Vector3(0, 1.65, 19.5),
      new THREE.Vector3(0.6, 1.7, 15.5),
      new THREE.Vector3(-0.3, 1.9, 11.4),
      new THREE.Vector3(0, 3.2, 8.2),
      new THREE.Vector3(0, 5.6, 8.9),
      new THREE.Vector3(...VIEWS.hall.pos),
    ]);
    const look = new THREE.CatmullRomCurve3([
      new THREE.Vector3(0, 1.4, 14.5),
      new THREE.Vector3(0, 1.4, 11),
      new THREE.Vector3(0, 1.8, 4),
      new THREE.Vector3(0, 1.6, -2),
      new THREE.Vector3(0, 1.4, -3),
      new THREE.Vector3(...VIEWS.hall.tgt),
    ]);
    return new Promise((resolve) => {
      this._fly = { path, look, start: this._time, ms: 6500, resolve };
    });
  }

  skipFlythrough() {
    if (!this._fly) return;
    const f = this._fly;
    this._fly = null;
    this.goTo('hall', 0);
    f.resolve();
  }

  /* ================= кадр ================= */

  update(dt) {
    this._time += dt;
    const t = this._time;

    // пролёт
    if (this._fly) {
      const f = this._fly;
      const k = Math.min(1, (t - f.start) * 1000 / f.ms);
      const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
      this.camera.position.copy(f.path.getPoint(e));
      this.controls.target.copy(f.look.getPoint(e));
      if (k >= 1) { this._fly = null; f.resolve(); }
    }

    // твин камеры
    if (this._tween) {
      const w = this._tween;
      const k = Math.min(1, (t - w.start) * 1000 / w.ms);
      const e = 1 - Math.pow(1 - k, 3);
      this.camera.position.lerpVectors(w.p0, w.p1, e);
      this.controls.target.lerpVectors(w.t0, w.t1, e);
      if (k >= 1) this._tween = null;
    }

    // люди: дыхание, повороты головы, печать
    if (!this.reducedMotion) {
      for (const [mod, person] of this.people) {
        const ph = person.phase;
        person.torso.scale.y = 1 + Math.sin(t * 1.4 + ph) * 0.012;
        const typing = this.typing.get(mod);
        if (typing) {
          person.armL.rotation.x = -1.05 + Math.sin(t * 13 + ph) * 0.07;
          person.armR.rotation.x = -1.05 + Math.cos(t * 11 + ph * 2) * 0.07;
          person.head.rotation.y = Math.sin(t * 0.7 + ph) * 0.08;
          if (this.onTypingTick && Math.random() < dt * 6) this.onTypingTick(mod);
        } else {
          // спит/читает: голова опущена, изредка оглядывается
          person.armL.rotation.x = -0.75;
          person.armR.rotation.x = -0.75;
          person.head.rotation.y = Math.sin(t * 0.25 + ph) * 0.45;
          person.head.rotation.x = 0.16 + Math.sin(t * 0.5 + ph) * 0.04;
        }
      }
      if (this.secretary) {
        this.secretary.torso.scale.y = 1 + Math.sin(t * 1.3) * 0.015;
        this.secretary.head.rotation.y = Math.sin(t * 0.4) * 0.3;
        if (this._wave && t < this._wave) {
          this.secretary.armR.rotation.x = -2.4 + Math.sin(t * 8) * 0.35;
        } else {
          this.secretary.armR.rotation.x = -0.6;
        }
        this.secretary.armL.rotation.x = -0.6;
      }
      if (this.teaMaster) {
        this.teaMaster.head.rotation.x = 0.2;
        const pour = (Math.sin(t * 0.5) + 1) / 2;
        if (this.teapot) this.teapot.rotation.z = pour > 0.85 ? -(pour - 0.85) * 3 : 0;
        this.teaMaster.armR.rotation.x = pour > 0.85 ? -1.5 : -0.9;
      }
      // рост здания на столе
      if (this._buildingFloors) {
        for (const f of this._buildingFloors) {
          const k = Math.min(1, Math.max(0, (t - this._buildStart - f.delay) / 0.6));
          const e = 1 - Math.pow(1 - k, 3);
          f.mesh.scale.y = Math.max(0.001, e);
        }
      }
    }

    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  wave(seconds = 2.5) { this._wave = this._time + seconds; }

  /* ================= клик ================= */

  _pick(e) {
    const rect = this.canvas.getBoundingClientRect();
    this._pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this._pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this._pointer, this.camera);
    const hits = this.raycaster.intersectObjects(this.pickables, true);
    for (const h of hits) {
      let o = h.object;
      while (o) {
        if (o.userData && o.userData.pick) {
          if (this.onPick) this.onPick(o.userData.pick, h);
          return;
        }
        o = o.parent;
      }
    }
  }

  /* ================= тема ================= */

  setTheme(dark) {
    if (this.dark === dark) return;
    this.dark = dark;
    this.pal = dark ? PAL.dark : PAL.light;
    const p = this.pal;
    this.scene.background.set(p.bg);
    this.scene.fog.color.set(p.bg);
    this.hemi.intensity = p.hemi;
    this.sun.intensity = p.sun;
    this._floor.material.color.set(p.floor);
    for (const w of this._walls) w.material.color.set(p.wall);
    for (const w of this._windows) w.material.color.set(dark ? 0x1b2a38 : 0xeaf2f6);
    for (const s of this._strips) s.material.color.set(dark ? 0x86695a : 0xfff6e8);
    if (this._sceneData) this._drawScreen(this._sceneData);
  }
}
