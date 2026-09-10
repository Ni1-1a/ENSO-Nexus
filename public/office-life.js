'use strict';
/**
 * «Режиссёр жизни» зала: поведение сидящих агентов (печатает, читает,
 * пьёт кофе, тянется, звонит, оглядывается), ходоки по проходам, качание
 * растений, пульс световых кромок, пар над чайником, вспышки на мониторах
 * при смене состояния модуля. Данные проекта здесь НЕ выдумываются —
 * оживляется только пластика и декор; строки на экранах приходят из сцены.
 */

import * as THREE from './vendor/three.module.min.js';

const rnd = (a, b) => a + Math.random() * (b - a);

/* ---------- сидящие агенты ---------- */

const SEATED = {
  typing:  { min: 6, max: 14 },
  reading: { min: 5, max: 10 },
  sipping: { min: 3, max: 4.5 },
  stretch: { min: 2.5, max: 3.5 },
  phone:   { min: 6, max: 9 },
  look:    { min: 3, max: 5 },
};

function pickSeated(current, busy) {
  if (busy) return Math.random() < 0.8 ? 'typing' : 'look';
  const pool = ['typing', 'reading', 'reading', 'sipping', 'stretch', 'phone', 'look', 'look'];
  let next = pool[Math.floor(Math.random() * pool.length)];
  if (next === current) next = pool[(pool.indexOf(next) + 3) % pool.length];
  return next;
}

/* ---------- ходоки ---------- */

/**
 * Маршруты задаёт СЦЕНА (`setRoutes`): после перепланировки в кольцо они
 * считаются по радиусу и углу, а прямоугольные проходы прежнего зала исчезли
 * вместе с ним. Здесь остаётся запасной набор на случай, если сцена ничего не
 * передала — иначе ходоки просто не появятся.
 */
const FALLBACK_ROUTES = [[[0, 17], [0, 12]]];

export class LifeDirector {
  constructor() {
    this.agents = new Map();   // module -> { rig, state, until, mug, phone }
    this.walkers = [];         // { rig, route, i, t, pause, speed, mug }
    this.plants = [];          // meshes with userData.sway
    this.strips = [];          // светящиеся кромки
    this.steam = null;         // спрайты пара
    this.flash = new Map();    // module -> until
    this._prevStates = new Map();
    this.time = 0;
    this.heightAt = () => 0;
  }

  addAgent(module, rig, props = {}) {
    this.agents.set(module, { rig, state: 'look', until: rnd(1, 4), props, busy: false });
  }

  /** маршруты-петли по кольцу; задаются сценой из плана здания */
  setRoutes(routes) { this.routes = routes && routes.length ? routes : FALLBACK_ROUTES; }

  addWalker(rig, routeIndex, speed = 0.9) {
    const list = this.routes && this.routes.length ? this.routes : FALLBACK_ROUTES;
    const route = list[routeIndex % list.length];
    const w = { rig, route, i: 0, t: 0, pause: rnd(0, 3), speed, phase: Math.random() * 6 };
    const [x, z] = route[0];
    rig.group.position.set(x, this.heightAt(x, z), z);
    this.walkers.push(w);
    return w;
  }

  /** смена состояний модулей между опросами — вспышка на мониторе агента */
  setModuleStates(modules) {
    if (!modules) return;
    for (const [m, s] of Object.entries(modules)) {
      const prev = this._prevStates.get(m);
      const a = this.agents.get(m);
      if (a) a.busy = s.state === 'run';
      if (prev && prev !== s.state) this.flash.set(m, this.time + 2.5);
      this._prevStates.set(m, s.state);
    }
  }

  update(dt) {
    this.time += dt;
    const t = this.time;

    for (const [, a] of this.agents) this._seated(a, dt, t);
    for (const w of this.walkers) this._walk(w, dt, t);

    for (const m of this.plants) {
      const s = m.userData.sway;
      if (!s) continue;
      m.rotation.z += (Math.sin(t * 0.8 + s.phase) * s.amp - (m.userData.swayLast || 0));
      m.userData.swayLast = Math.sin(t * 0.8 + s.phase) * s.amp;
    }
    for (const s of this.strips) {
      const k = 0.55 + Math.sin(t * 0.6 + (s.userData.phase || 0)) * 0.12;
      if (s.material.opacity !== undefined) s.material.opacity = k;
    }
    if (this.steam) {
      for (const p of this.steam.children) {
        p.position.y += dt * 0.12;
        p.material.opacity -= dt * 0.18;
        p.position.x += Math.sin(t * 2 + p.userData.seed) * dt * 0.02;
        if (p.material.opacity <= 0) { p.position.y = 0; p.material.opacity = 0.35; p.scale.setScalar(rnd(0.6, 1.1)); }
      }
    }
  }

  isFlashing(module) {
    const until = this.flash.get(module);
    return until !== undefined && until > this.time;
  }

  _seated(a, dt, t) {
    const r = a.rig;
    a.until -= dt;
    if (a.until <= 0) {
      a.state = pickSeated(a.state, a.busy);
      const d = SEATED[a.state];
      a.until = rnd(d.min, d.max);
      a.t0 = t;
    }
    const ph = r.phase;
    const breathe = Math.sin(t * 1.3 + ph) * 0.012;
    r.torso.scale.y = 1 + breathe;
    const lerp = (obj, key, target, k = dt * 5) => { obj.rotation[key] += (target - obj.rotation[key]) * Math.min(1, k); };

    switch (a.state) {
      /*
       * Углы пересчитаны от НАСТОЯЩЕЙ геометрии (В13): плечевой сустав на
       * отметке 1.03, плечо 270 мм, предплечье 250 мм, столешница 0.775.
       * Прежние 0.95/0.62 оставляли кисть в воздухе над клавиатурой.
       */
      case 'typing':
        lerp(r.armL.shoulder, 'x', 0.34); lerp(r.armR.shoulder, 'x', 0.34);
        lerp(r.armL.elbow, 'x', 1.29 + Math.sin(t * 14 + ph) * 0.05);
        lerp(r.armR.elbow, 'x', 1.29 + Math.cos(t * 12 + ph * 2) * 0.05, dt * 12);
        lerp(r.head, 'y', Math.sin(t * 0.6 + ph) * 0.08);
        lerp(r.head, 'x', 0.08);
        break;
      case 'reading':
        lerp(r.armL.shoulder, 'x', 0.17); lerp(r.armR.shoulder, 'x', 0.17);
        lerp(r.armL.elbow, 'x', 2.08); lerp(r.armR.elbow, 'x', 2.08);
        lerp(r.head, 'x', 0.32); lerp(r.head, 'y', Math.sin(t * 0.3 + ph) * 0.1);
        break;
      case 'sipping': {
        const k = Math.min(1, (t - a.t0) / 0.8);
        lerp(r.armR.shoulder, 'x', 0.34 + k * 1.33); lerp(r.armR.elbow, 'x', 1.29 + k * 0.98);
        lerp(r.armL.shoulder, 'x', 0.34); lerp(r.armL.elbow, 'x', 1.29);
        lerp(r.head, 'x', -0.15 * k);
        break;
      }
      case 'stretch':
        lerp(r.armL.shoulder, 'x', 2.8); lerp(r.armR.shoulder, 'x', 2.8);
        lerp(r.armL.elbow, 'x', 0.2); lerp(r.armR.elbow, 'x', 0.2);
        lerp(r.head, 'x', -0.35);
        lerp(r.torso, 'x', -0.12);
        break;
      case 'phone':
        lerp(r.armR.shoulder, 'x', 0.9); lerp(r.armR.shoulder, 'z', -0.9); lerp(r.armR.elbow, 'x', 2.5);
        lerp(r.armL.shoulder, 'x', 0.34); lerp(r.armL.elbow, 'x', 1.29);
        lerp(r.head, 'y', 0.4 + Math.sin(t * 0.9) * 0.1); lerp(r.head, 'z', 0.12);
        break;
      default: // look
        lerp(r.armL.shoulder, 'x', 0.30); lerp(r.armR.shoulder, 'x', 0.30);
        lerp(r.armL.elbow, 'x', 1.25); lerp(r.armR.elbow, 'x', 1.25);
        lerp(r.head, 'y', Math.sin(t * 0.35 + ph) * 0.6); lerp(r.head, 'x', 0.02);
    }
    if (a.state !== 'phone') { lerp(r.armR.shoulder, 'z', 0); lerp(r.head, 'z', 0); }
    if (a.state !== 'stretch') lerp(r.torso, 'x', 0);
    if (a.props.mug) a.props.mug.visible = a.state !== 'sipping';
    if (a.props.handMug) a.props.handMug.visible = a.state === 'sipping';
    this._face(a, r, dt, t);
  }

  /**
   * Моргание и речь (В13). Живое лицо — это не мимика ради мимики: с двух
   * метров неподвижные глаза читаются как манекен. Пауза между морганиями
   * 2.5…6 с, само моргание 130 мс; рот двигается, пока агент «говорит».
   */
  _face(a, r, dt, t) {
    if (!r.face) return;
    if (a.blinkAt === undefined) a.blinkAt = t + rnd(1, 5);
    if (t >= a.blinkAt) {
      const k = (t - a.blinkAt) / 0.13;
      if (k >= 1) { r.face.blink(1); a.blinkAt = t + rnd(2.5, 6); }
      else r.face.blink(Math.abs(k * 2 - 1));            // вниз и обратно
    }
    const talking = a.state === 'phone';
    r.face.speak(talking ? Math.max(0, Math.sin(t * 9 + r.phase)) * 0.9 : 0);
  }

  _walk(w, dt, t) {
    const r = w.rig;
    if (w.pause > 0) {
      w.pause -= dt;
      // стоит: оглядывается, ноги ровно
      r.head.rotation.y += (Math.sin(t * 0.5 + w.phase) * 0.5 - r.head.rotation.y) * dt * 3;
      for (const leg of [r.legL, r.legR]) { leg.hip.rotation.x *= 0.9; leg.knee.rotation.x *= 0.9; }
      for (const arm of [r.armL, r.armR]) { arm.shoulder.rotation.x *= 0.9; }
      return;
    }
    const a = w.route[w.i];
    const b = w.route[(w.i + 1) % w.route.length];
    const seg = Math.hypot(b[0] - a[0], b[1] - a[1]);
    w.t += (dt * w.speed) / seg;
    if (w.t >= 1) {
      w.t = 0; w.i = (w.i + 1) % w.route.length;
      if (Math.random() < 0.35) w.pause = rnd(1.5, 5);
    }
    const x = a[0] + (b[0] - a[0]) * w.t;
    const z = a[1] + (b[1] - a[1]) * w.t;
    // высота сглаживается: кромка яруса — ступенька, а не прыжок
    const targetY = this.heightAt(x, z);
    const curY = r.group.position.y;
    r.group.position.set(x, curY + (targetY - curY) * Math.min(1, dt * 6), z);
    // лицо модели смотрит в −z, поэтому к направлению хода добавляется π
    const yaw = Math.atan2(b[0] - a[0], b[1] - a[1]) + Math.PI;
    r.group.rotation.y += ((yaw - r.group.rotation.y + Math.PI * 3) % (Math.PI * 2) - Math.PI) * Math.min(1, dt * 6);
    // шаг
    const s = Math.sin(t * 6.5 + w.phase);
    r.legL.hip.rotation.x = s * 0.55;
    r.legR.hip.rotation.x = -s * 0.55;
    r.legL.knee.rotation.x = -Math.max(0, -s) * 0.9;
    r.legR.knee.rotation.x = -Math.max(0, s) * 0.9;
    r.armL.shoulder.rotation.x = s * 0.4;
    r.armR.shoulder.rotation.x = w.mug ? 0.9 : -s * 0.4;
    r.armR.elbow.rotation.x = w.mug ? 1.3 : 0.2;
    r.hips.position.y = 0.92 + Math.abs(Math.cos(t * 6.5 + w.phase)) * 0.025;
    r.head.rotation.y *= 0.95;
  }
}

/** пар над чайником: несколько мягких спрайтов */
export function makeSteam() {
  const g = new THREE.Group();
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 64;
  const c = canvas.getContext('2d');
  const grad = c.createRadialGradient(32, 32, 2, 32, 32, 30);
  grad.addColorStop(0, 'rgba(255,255,255,.9)'); grad.addColorStop(1, 'rgba(255,255,255,0)');
  c.fillStyle = grad; c.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(canvas);
  for (let i = 0; i < 5; i++) {
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, opacity: 0.35 - i * 0.05, depthWrite: false }));
    sp.scale.setScalar(0.12);
    sp.position.y = i * 0.05;
    sp.userData.seed = i * 1.7;
    g.add(sp);
  }
  return g;
}
