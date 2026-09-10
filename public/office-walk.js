'use strict';
/**
 * Ходьба от первого лица: WASD / стрелки, Shift — бег, мышь — взгляд
 * (Pointer Lock), на телефоне — левый джойстик и правая половина экрана
 * для взгляда. Высота глаз идёт по полу помещения (heightAt с учётом
 * этажа: лестница и антресоль), за стены выйти нельзя (inside), столы,
 * стойки и машины не проходятся (blocked).
 */

import * as THREE from './vendor/three.module.min.js';

const EYE = 1.65;

export class WalkRig {
  constructor(camera, dom, { heightAt = () => 0, blocked = () => false, inside = null, bounds = { minX: -15, maxX: 15, minZ: -10, maxZ: 20 } } = {}) {
    this.camera = camera;
    this.dom = dom;
    this.heightAt = heightAt;   // (x, z, prevFloorY) → высота пола
    this.blocked = blocked;
    this.inside = inside || ((x, z) => x > bounds.minX && x < bounds.maxX && z > bounds.minZ && z < bounds.maxZ);
    this.enabled = false;
    this.locked = false;
    this.keys = new Set();
    this.euler = new THREE.Euler(0, 0, 0, 'YXZ');
    this.vel = new THREE.Vector3();
    this.bobT = 0;
    this.floorY = 0;
    this.joy = { x: 0, y: 0, active: false };
    this.onLockChange = null;
    this.onStep = null;
    this._stepAcc = 0;

    this._onKey = (e) => {
      if (!this.enabled) return;
      const tag = (e.target && e.target.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      const code = e.code;
      if (e.type === 'keydown') this.keys.add(code); else this.keys.delete(code);
      if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(code)) e.preventDefault();
    };
    this._onMouse = (e) => {
      if (!this.enabled || !this.locked) return;
      this.euler.setFromQuaternion(this.camera.quaternion);
      this.euler.y -= e.movementX * 0.0022;
      this.euler.x -= e.movementY * 0.0022;
      this.euler.x = Math.max(-1.3, Math.min(1.3, this.euler.x));
      this.camera.quaternion.setFromEuler(this.euler);
    };
    this._onLock = () => {
      this.locked = document.pointerLockElement === this.dom;
      if (this.onLockChange) this.onLockChange(this.locked);
    };
    this._touches = new Map();
    this._onTouchStart = (e) => {
      if (!this.enabled) return;
      for (const t of e.changedTouches) {
        const half = t.clientX < window.innerWidth / 2 ? 'move' : 'look';
        this._touches.set(t.identifier, { half, x0: t.clientX, y0: t.clientY, x: t.clientX, y: t.clientY });
      }
    };
    this._onTouchMove = (e) => {
      if (!this.enabled) return;
      for (const t of e.changedTouches) {
        const rec = this._touches.get(t.identifier);
        if (!rec) continue;
        if (rec.half === 'look') {
          const dx = t.clientX - rec.x, dy = t.clientY - rec.y;
          this.euler.setFromQuaternion(this.camera.quaternion);
          this.euler.y -= dx * 0.004;
          this.euler.x = Math.max(-1.3, Math.min(1.3, this.euler.x - dy * 0.004));
          this.camera.quaternion.setFromEuler(this.euler);
        } else {
          this.joy.x = Math.max(-1, Math.min(1, (t.clientX - rec.x0) / 60));
          this.joy.y = Math.max(-1, Math.min(1, (t.clientY - rec.y0) / 60));
          this.joy.active = true;
        }
        rec.x = t.clientX; rec.y = t.clientY;
      }
      e.preventDefault();
    };
    this._onTouchEnd = (e) => {
      for (const t of e.changedTouches) {
        const rec = this._touches.get(t.identifier);
        if (rec && rec.half === 'move') { this.joy.x = 0; this.joy.y = 0; this.joy.active = false; }
        this._touches.delete(t.identifier);
      }
    };
  }

  enable(pos, lookAt) {
    this.enabled = true;
    if (pos) this.teleport(pos, lookAt);
    document.addEventListener('keydown', this._onKey);
    document.addEventListener('keyup', this._onKey);
    document.addEventListener('mousemove', this._onMouse);
    document.addEventListener('pointerlockchange', this._onLock);
    this.dom.addEventListener('touchstart', this._onTouchStart, { passive: true });
    this.dom.addEventListener('touchmove', this._onTouchMove, { passive: false });
    this.dom.addEventListener('touchend', this._onTouchEnd);
    this.dom.addEventListener('touchcancel', this._onTouchEnd);
  }

  disable() {
    this.enabled = false;
    this.keys.clear();
    if (this.locked) document.exitPointerLock();
    document.removeEventListener('keydown', this._onKey);
    document.removeEventListener('keyup', this._onKey);
    document.removeEventListener('mousemove', this._onMouse);
    document.removeEventListener('pointerlockchange', this._onLock);
    this.dom.removeEventListener('touchstart', this._onTouchStart);
    this.dom.removeEventListener('touchmove', this._onTouchMove);
    this.dom.removeEventListener('touchend', this._onTouchEnd);
    this.dom.removeEventListener('touchcancel', this._onTouchEnd);
  }

  lock() {
    if (!this.enabled) return;
    try { this.dom.requestPointerLock(); } catch { /* телефон — замка нет, взгляд по касанию */ }
  }

  teleport(pos, lookAt, floorY = null) {
    const p = new THREE.Vector3(...pos);
    this.floorY = floorY === null ? this.heightAt(p.x, p.z, p.y || 0) : floorY;
    p.y = this.floorY + EYE;
    this.camera.position.copy(p);
    if (lookAt) {
      const target = new THREE.Vector3(...lookAt);
      target.y = p.y;
      this.camera.lookAt(target);
    }
  }

  update(dt) {
    if (!this.enabled) return;
    const k = this.keys;
    let fwd = 0, side = 0;
    if (k.has('KeyW') || k.has('ArrowUp')) fwd += 1;
    if (k.has('KeyS') || k.has('ArrowDown')) fwd -= 1;
    if (k.has('KeyD') || k.has('ArrowRight')) side += 1;
    if (k.has('KeyA') || k.has('ArrowLeft')) side -= 1;
    if (this.joy.active) { fwd -= this.joy.y; side += this.joy.x; }
    const run = k.has('ShiftLeft') || k.has('ShiftRight');
    const speed = (run ? 3.6 : 1.9);
    const len = Math.hypot(fwd, side) || 1;
    fwd /= len; side /= len;

    const dir = new THREE.Vector3();
    this.camera.getWorldDirection(dir);
    dir.y = 0; dir.normalize();
    const right = new THREE.Vector3().crossVectors(dir, new THREE.Vector3(0, 1, 0));
    const target = new THREE.Vector3().addScaledVector(dir, fwd * speed).addScaledVector(right, side * speed);
    this.vel.lerp(target, Math.min(1, dt * 9));

    const p = this.camera.position;
    const nx = p.x + this.vel.x * dt;
    const nz = p.z + this.vel.z * dt;
    // шаг допустим, если точка внутри помещений, не в препятствии и пол не выше
    // подъёма ступени (0.45 м): так лестница проходится, а антресоль с пола — нет
    const ok = (x, z) => {
      if (!this.inside(x, z) || this.blocked(x, z)) return false;
      const h = this.heightAt(x, z, this.floorY);
      return Math.abs(h - this.floorY) < 0.45;
    };
    if (ok(nx, nz)) { p.x = nx; p.z = nz; }
    else if (ok(nx, p.z)) { p.x = nx; this.vel.z = 0; }
    else if (ok(p.x, nz)) { p.z = nz; this.vel.x = 0; }
    else { this.vel.set(0, 0, 0); }

    const moving = this.vel.length() > 0.15;
    if (moving) {
      this.bobT += dt * (run ? 11 : 7.5);
      this._stepAcc += dt;
      if (this._stepAcc > (run ? 0.32 : 0.5)) { this._stepAcc = 0; if (this.onStep) this.onStep(); }
    }
    const bob = moving ? Math.sin(this.bobT) * 0.028 : 0;
    this.floorY = this.heightAt(p.x, p.z, this.floorY);
    const eyeY = this.floorY + EYE + bob;
    p.y += (eyeY - p.y) * Math.min(1, dt * 10);
  }
}
