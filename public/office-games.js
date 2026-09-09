'use strict';
/**
 * Игровые предметы зала: кубик Рубика (эмулятор + солвер Коцембы из
 * vendor/cube.js), шахматы (правила — chess.js, играет встроенный минимакс,
 * вид — деревянная 3D-доска в духе маковских «Шахмат») и го 9×9 со слабым
 * ботом. Вся логика — в браузере, облако не нужно.
 */

import * as THREE from './vendor/three.module.min.js';
import { Chess } from './vendor/chess.esm.js';

/* ================= кубик Рубика ================= */

const CUBE_COLORS = { U: 0xf3efe6, D: 0xe8c14a, F: 0x4f7d58, B: 0x4a6b8a, R: 0xb95740, L: 0xb07e36 };
const CUBE_FACES = ['U', 'D', 'F', 'B', 'R', 'L'];

export class RubikApp {
  constructor(anchor, scenePickables) {
    this.group = new THREE.Group();
    anchor.add(this.group);
    this.cube = new window.Cube(); // собранное состояние
    this.queue = [];
    this.animating = null;
    this.solution = [];
    this.solutionAt = 0;
    this.onState = null;
    this._solverReady = false;
    this._build(scenePickables);
  }

  _build(pickables) {
    const size = 0.0185;
    const gap = 0.0012;
    const step = size + gap;
    this.cubies = [];
    for (let x = -1; x <= 1; x++) {
      for (let y = -1; y <= 1; y++) {
        for (let z = -1; z <= 1; z++) {
          const mats = [
            new THREE.MeshLambertMaterial({ color: x === 1 ? CUBE_COLORS.R : 0x2a2622 }),
            new THREE.MeshLambertMaterial({ color: x === -1 ? CUBE_COLORS.L : 0x2a2622 }),
            new THREE.MeshLambertMaterial({ color: y === 1 ? CUBE_COLORS.U : 0x2a2622 }),
            new THREE.MeshLambertMaterial({ color: y === -1 ? CUBE_COLORS.D : 0x2a2622 }),
            new THREE.MeshLambertMaterial({ color: z === 1 ? CUBE_COLORS.F : 0x2a2622 }),
            new THREE.MeshLambertMaterial({ color: z === -1 ? CUBE_COLORS.B : 0x2a2622 }),
          ];
          const m = new THREE.Mesh(new THREE.BoxGeometry(size, size, size), mats);
          m.position.set(x * step, y * step, z * step);
          m.userData.cubie = [x, y, z];
          this.group.add(m);
          this.cubies.push(m);
        }
      }
    }
    this.group.position.y = 0.04;
    this.group.rotation.y = 0.6;
    const holder = new THREE.Mesh(
      new THREE.CylinderGeometry(0.045, 0.055, 0.012, 16),
      new THREE.MeshLambertMaterial({ color: 0x3a332a }),
    );
    holder.position.y = -0.036;
    this.group.add(holder);
    pickables.push(this.group);
    this.group.traverse((m) => { m.userData.pick = { kind: 'item', item: 'cube' }; });
  }

  /** очередь ходов вида "R", "U'", "F2" */
  enqueue(moves) {
    for (const mv of String(moves).trim().split(/\s+/)) if (mv) this.queue.push(mv);
  }

  scramble() {
    this.cube = window.Cube.random();
    this.solution = []; this.solutionAt = 0;
    // визуально применяем случайную последовательность мгновенно нельзя —
    // состояние кубика уже случайное, поэтому пересобираем стикеры по asString
    this._syncStickers();
    this._notify();
  }

  reset() {
    this.cube = new window.Cube();
    this.solution = []; this.solutionAt = 0;
    this._syncStickers();
    this._notify();
  }

  async solve() {
    if (this.cube.isSolved()) { this.solution = []; this.solutionAt = 0; this._notify(); return ''; }
    if (!this._solverReady) {
      await new Promise((r) => setTimeout(r, 30)); // дать интерфейсу показать «думаю»
      window.Cube.initSolver();
      this._solverReady = true;
    }
    const sol = this.cube.solve();
    this.solution = sol.trim() ? sol.trim().split(/\s+/) : [];
    this.solutionAt = 0;
    this._notify();
    return sol;
  }

  stepNext() {
    if (this.solutionAt >= this.solution.length) return false;
    const mv = this.solution[this.solutionAt++];
    this.cube.move(mv);
    this.enqueue(mv);
    this._notify();
    return true;
  }

  manual(mv) {
    this.cube.move(mv);
    this.solution = []; this.solutionAt = 0;
    this.enqueue(mv);
    this._notify();
  }

  _notify() { if (this.onState) this.onState(this); }

  /** повернуть меши по состоянию из cubejs (после scramble/reset) */
  _syncStickers() {
    // проще пересоздать стикеры по строке состояния
    const s = this.cube.asString(); // 54 символа: U9 R9 F9 D9 L9 B9
    const face = (i) => s[i];
    const colorOf = (ch) => CUBE_COLORS[ch] || 0x2a2622;
    // раскладка asString: индексы каждой грани идут построчно сверху-слева
    const grids = {
      U: (r, c) => [c - 1, 1, r - 1],
      R: (r, c) => [1, 1 - r, 1 - c],
      F: (r, c) => [c - 1, 1 - r, 1],
      D: (r, c) => [c - 1, -1, 1 - r],
      L: (r, c) => [-1, 1 - r, c - 1],
      B: (r, c) => [1 - c, 1 - r, -1],
    };
    const faceIndex = { U: 0, R: 1, F: 2, D: 3, L: 4, B: 5 };
    const matIndexOf = { R: 0, L: 1, U: 2, D: 3, F: 4, B: 5 };
    // сброс поворотов кубиков
    for (const m of this.cubies) {
      m.rotation.set(0, 0, 0);
      const [x, y, z] = m.userData.cubie;
      const size = 0.0185 + 0.0012;
      m.position.set(x * size, y * size, z * size);
      for (const mat of m.material) mat.color.set(0x2a2622);
    }
    for (const f of CUBE_FACES) {
      for (let r = 0; r < 3; r++) {
        for (let c = 0; c < 3; c++) {
          const ch = face(faceIndex[f] * 9 + r * 3 + c);
          const [x, y, z] = grids[f](r, c);
          const cubie = this.cubies.find((m) => {
            const [cx, cy, cz] = m.userData.cubie;
            return cx === x && cy === y && cz === z;
          });
          if (cubie) cubie.material[matIndexOf[f]].color.set(colorOf(ch));
        }
      }
    }
  }

  update(dt) {
    if (this.animating) {
      const a = this.animating;
      a.k = Math.min(1, a.k + dt / 0.28);
      const e = 1 - Math.pow(1 - a.k, 3);
      a.pivot.rotation[a.axis] = a.dir * e * a.angle;
      if (a.k >= 1) {
        // запечь поворот
        a.pivot.updateMatrixWorld();
        for (const m of [...a.pivot.children]) {
          this.group.attach(m);
          m.position.set(
            Math.round(m.position.x / a.step) * a.step,
            Math.round(m.position.y / a.step) * a.step,
            Math.round(m.position.z / a.step) * a.step,
          );
          m.userData.cubie = [
            Math.round(m.position.x / a.step),
            Math.round(m.position.y / a.step),
            Math.round(m.position.z / a.step),
          ];
        }
        this.group.remove(a.pivot);
        this.animating = null;
      }
      return;
    }
    const mv = this.queue.shift();
    if (!mv) return;
    const face = mv[0];
    const prime = mv.includes("'");
    const dbl = mv.includes('2');
    const AXIS = { U: ['y', 1], D: ['y', -1], R: ['x', 1], L: ['x', -1], F: ['z', 1], B: ['z', -1] };
    const [axis, sign] = AXIS[face] || ['y', 1];
    const step = 0.0185 + 0.0012;
    const pivot = new THREE.Group();
    this.group.add(pivot);
    for (const m of [...this.cubies]) {
      const v = { x: m.userData.cubie[0], y: m.userData.cubie[1], z: m.userData.cubie[2] };
      if (v[axis] === sign) pivot.attach(m);
    }
    this.animating = {
      pivot, axis, step,
      dir: (prime ? 1 : -1) * sign,
      angle: dbl ? Math.PI : Math.PI / 2,
      k: 0,
    };
  }
}

/* ================= шахматы ================= */

const PIECE_H = { p: 0.045, n: 0.06, b: 0.065, r: 0.055, q: 0.08, k: 0.09 };
const PIECE_VALUE = { p: 100, n: 305, b: 320, r: 500, q: 950, k: 0 };

export class ChessApp {
  constructor(anchor, pickables) {
    this.group = new THREE.Group();
    anchor.add(this.group);
    this.chess = new Chess();
    this.mode = 'play';       // play | replay
    this.replay = null;       // {game, at, chess}
    this.selected = null;
    this.busy = false;
    this.onState = null;
    this._sq = 0.034;
    this._build(pickables);
    this._syncPieces();
  }

  _build(pickables) {
    const sq = this._sq;
    const frame = new THREE.Mesh(
      new THREE.BoxGeometry(sq * 8 + 0.05, 0.022, sq * 8 + 0.05),
      new THREE.MeshLambertMaterial({ color: 0x5d4430 }),
    );
    frame.position.y = 0.011;
    this.group.add(frame);
    this.squares = [];
    for (let r = 0; r < 8; r++) {
      for (let f = 0; f < 8; f++) {
        const dark = (r + f) % 2 === 1;
        const m = new THREE.Mesh(
          new THREE.BoxGeometry(sq, 0.006, sq),
          new THREE.MeshLambertMaterial({ color: dark ? 0x8a6a48 : 0xe9d9b8 }),
        );
        m.position.set((f - 3.5) * sq, 0.025, (3.5 - r) * sq);
        m.userData.pick = { kind: 'chess-square', square: 'abcdefgh'[f] + (r + 1) };
        m.userData.baseColor = dark ? 0x8a6a48 : 0xe9d9b8;
        this.group.add(m);
        this.squares.push(m);
        pickables.push(m);
      }
    }
    this.piecesGroup = new THREE.Group();
    this.group.add(this.piecesGroup);
    this.group.rotation.y = -0.35;
    pickables.push(frame);
    frame.userData.pick = { kind: 'item', item: 'chess' };
  }

  _mkPiece(type, color) {
    const g = new THREE.Group();
    const mat = new THREE.MeshLambertMaterial({ color: color === 'w' ? 0xdccbaa : 0x4a382a });
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.011, 0.013, 0.008, 10), mat);
    g.add(base);
    const h = PIECE_H[type];
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.004, 0.01, h * 0.7, 8), mat);
    body.position.y = h * 0.38;
    g.add(body);
    let cap;
    switch (type) {
      case 'p': cap = new THREE.Mesh(new THREE.SphereGeometry(0.008, 8, 8), mat); break;
      case 'r': cap = new THREE.Mesh(new THREE.CylinderGeometry(0.009, 0.009, 0.012, 8), mat); break;
      case 'n': cap = new THREE.Mesh(new THREE.ConeGeometry(0.009, 0.02, 6), mat); cap.rotation.z = 0.7; break;
      case 'b': cap = new THREE.Mesh(new THREE.ConeGeometry(0.008, 0.018, 8), mat); break;
      case 'q': {
        cap = new THREE.Group();
        const s = new THREE.Mesh(new THREE.SphereGeometry(0.008, 8, 8), mat); cap.add(s);
        const cr = new THREE.Mesh(new THREE.CylinderGeometry(0.009, 0.006, 0.008, 8), mat); cr.position.y = 0.01; cap.add(cr);
        break;
      }
      case 'k': {
        cap = new THREE.Group();
        const s = new THREE.Mesh(new THREE.SphereGeometry(0.007, 8, 8), mat); cap.add(s);
        const v = new THREE.Mesh(new THREE.BoxGeometry(0.0035, 0.014, 0.0035), mat); v.position.y = 0.014; cap.add(v);
        const hbar = new THREE.Mesh(new THREE.BoxGeometry(0.01, 0.0035, 0.0035), mat); hbar.position.y = 0.016; cap.add(hbar);
        break;
      }
      default: cap = new THREE.Mesh(new THREE.SphereGeometry(0.007, 8, 8), mat);
    }
    cap.position.y = h * 0.78;
    g.add(cap);
    return g;
  }

  _syncPieces() {
    this.piecesGroup.clear();
    const sq = this._sq;
    const src = this.mode === 'replay' ? this.replay.chess : this.chess;
    for (const row of src.board()) {
      for (const cell of row) {
        if (!cell) continue;
        const f = cell.square.charCodeAt(0) - 97;
        const r = Number(cell.square[1]) - 1;
        const p = this._mkPiece(cell.type, cell.color);
        p.position.set((f - 3.5) * sq, 0.03, (3.5 - r) * sq);
        this.piecesGroup.add(p);
      }
    }
  }

  _highlight(squares) {
    for (const m of this.squares) m.material.color.set(m.userData.baseColor);
    for (const s of squares) {
      const m = this.squares.find((x) => x.userData.pick.square === s);
      if (m) m.material.color.set(0xb95740);
    }
  }

  clickSquare(square) {
    if (this.mode !== 'play' || this.busy) return;
    if (this.selected) {
      const mv = this.chess.moves({ square: this.selected, verbose: true }).find((m) => m.to === square);
      if (mv) {
        this.chess.move({ from: mv.from, to: mv.to, promotion: 'q' });
        this.selected = null;
        this._highlight([]);
        this._syncPieces();
        this._notify();
        if (!this.chess.isGameOver()) this._engineMove();
        return;
      }
    }
    const piece = this.chess.get(square);
    if (piece && piece.color === 'w' && this.chess.turn() === 'w') {
      this.selected = square;
      this._highlight([square, ...this.chess.moves({ square, verbose: true }).map((m) => m.to)]);
    } else {
      this.selected = null;
      this._highlight([]);
    }
  }

  async _engineMove() {
    this.busy = true;
    this._notify();
    await new Promise((r) => setTimeout(r, 350));
    const mv = this._bestMove(this.chess, 2);
    if (mv) this.chess.move(mv);
    this.busy = false;
    this._syncPieces();
    this._notify();
  }

  /** негамакс с материальной оценкой — уровень «крепкий любитель за чаем» */
  _bestMove(chess, depth) {
    const moves = chess.moves({ verbose: true });
    if (!moves.length) return null;
    let best = null;
    let bestScore = -Infinity;
    for (const mv of this._ordered(moves)) {
      chess.move(mv);
      const score = -this._negamax(chess, depth - 1, -Infinity, Infinity);
      chess.undo();
      const jitter = Math.random() * 8;
      if (score + jitter > bestScore) { bestScore = score + jitter; best = mv; }
    }
    return best;
  }

  _ordered(moves) {
    return moves.slice().sort((a, b) => (b.captured ? PIECE_VALUE[b.captured] : 0) - (a.captured ? PIECE_VALUE[a.captured] : 0));
  }

  _negamax(chess, depth, alpha, beta) {
    if (chess.isCheckmate()) return -100000;
    if (chess.isDraw() || chess.isStalemate()) return 0;
    if (depth <= 0) return this._eval(chess);
    let best = -Infinity;
    for (const mv of this._ordered(chess.moves({ verbose: true }))) {
      chess.move(mv);
      const s = -this._negamax(chess, depth - 1, -beta, -alpha);
      chess.undo();
      if (s > best) best = s;
      if (best > alpha) alpha = best;
      if (alpha >= beta) break;
    }
    return best;
  }

  _eval(chess) {
    let score = 0;
    for (const row of chess.board()) {
      for (const cell of row) {
        if (!cell) continue;
        const v = PIECE_VALUE[cell.type];
        score += cell.color === chess.turn() ? v : -v;
      }
    }
    // подвижность — лёгкая добавка
    score += chess.moves().length * 2;
    return score;
  }

  newGame() {
    this.chess = new Chess();
    this.mode = 'play';
    this.replay = null;
    this.selected = null;
    this._highlight([]);
    this._syncPieces();
    this._notify();
  }

  undo() {
    if (this.mode !== 'play') return;
    this.chess.undo(); this.chess.undo();
    this._syncPieces();
    this._notify();
  }

  startReplay(game) {
    this.mode = 'replay';
    this.replay = { game, at: 0, chess: new Chess() };
    this._highlight([]);
    this._syncPieces();
    this._notify();
  }

  replayStep(dir) {
    if (this.mode !== 'replay') return;
    const r = this.replay;
    if (dir > 0 && r.at < r.game.moves.length) {
      r.chess.move(r.game.moves[r.at]);
      r.at += 1;
    } else if (dir < 0 && r.at > 0) {
      r.chess.undo();
      r.at -= 1;
    }
    this._syncPieces();
    this._notify();
  }

  status() {
    if (this.mode === 'replay') {
      const r = this.replay;
      return `${r.game.title}: ход ${r.at} из ${r.game.moves.length}`;
    }
    const c = this.chess;
    if (c.isCheckmate()) return c.turn() === 'w' ? 'Мат. Движок победил — реванш?' : 'Мат! Вы обыграли движок.';
    if (c.isStalemate()) return 'Пат — ничья.';
    if (c.isDraw()) return 'Ничья.';
    if (this.busy) return 'Движок думает…';
    return c.turn() === 'w' ? 'Ваш ход — вы белыми.' : 'Ход движка…';
  }

  _notify() { if (this.onState) this.onState(this); }
}

/* ================= го 9×9 ================= */

export class GoApp {
  constructor(anchor, pickables) {
    this.group = new THREE.Group();
    anchor.add(this.group);
    this.N = 9;
    this.board = Array(81).fill(0); // 0 пусто, 1 чёрные (человек), 2 белые (бот)
    this.captures = { black: 0, white: 0 };
    this.lastBoard = '';
    this.finished = false;
    this.onState = null;
    this._cell = 0.03;
    this._build(pickables);
  }

  _build(pickables) {
    const N = this.N, cell = this._cell;
    const size = cell * (N - 1);
    const board = new THREE.Mesh(
      new THREE.BoxGeometry(size + 0.06, 0.03, size + 0.06),
      new THREE.MeshLambertMaterial({ color: 0xd9b06a }),
    );
    board.position.y = 0.015;
    this.group.add(board);
    // линии сетки
    const lineMat = new THREE.LineBasicMaterial({ color: 0x4a382a });
    for (let i = 0; i < N; i++) {
      const o = -size / 2 + i * cell;
      const g1 = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(-size / 2, 0.032, o), new THREE.Vector3(size / 2, 0.032, o)]);
      const g2 = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(o, 0.032, -size / 2), new THREE.Vector3(o, 0.032, size / 2)]);
      this.group.add(new THREE.Line(g1, lineMat), new THREE.Line(g2, lineMat));
    }
    // невидимые «клетки» для кликов
    this.cells = [];
    for (let i = 0; i < N * N; i++) {
      const x = i % N, y = Math.floor(i / N);
      const m = new THREE.Mesh(
        new THREE.BoxGeometry(cell * 0.95, 0.004, cell * 0.95),
        new THREE.MeshBasicMaterial({ visible: false }),
      );
      m.position.set(-size / 2 + x * cell, 0.034, -size / 2 + y * cell);
      m.userData.pick = { kind: 'go-point', index: i };
      this.group.add(m);
      this.cells.push(m);
      pickables.push(m);
    }
    this.stonesGroup = new THREE.Group();
    this.group.add(this.stonesGroup);
    board.userData.pick = { kind: 'item', item: 'go' };
    pickables.push(board);
  }

  _syncStones() {
    this.stonesGroup.clear();
    const N = this.N, cell = this._cell, size = cell * (N - 1);
    for (let i = 0; i < N * N; i++) {
      if (!this.board[i]) continue;
      const x = i % N, y = Math.floor(i / N);
      const stone = new THREE.Mesh(
        new THREE.SphereGeometry(cell * 0.46, 12, 10),
        new THREE.MeshLambertMaterial({ color: this.board[i] === 1 ? 0x26211b : 0xf3efe6 }),
      );
      stone.scale.y = 0.55;
      stone.position.set(-size / 2 + x * cell, 0.042, -size / 2 + y * cell);
      this.stonesGroup.add(stone);
    }
  }

  _neighbors(i) {
    const N = this.N, x = i % N, y = Math.floor(i / N);
    const out = [];
    if (x > 0) out.push(i - 1);
    if (x < N - 1) out.push(i + 1);
    if (y > 0) out.push(i - N);
    if (y < N - 1) out.push(i + N);
    return out;
  }

  _groupOf(i, board) {
    const color = board[i];
    const seen = new Set([i]);
    const stack = [i];
    const liberties = new Set();
    while (stack.length) {
      const cur = stack.pop();
      for (const n of this._neighbors(cur)) {
        if (board[n] === 0) liberties.add(n);
        else if (board[n] === color && !seen.has(n)) { seen.add(n); stack.push(n); }
      }
    }
    return { stones: seen, liberties };
  }

  _tryMove(i, color, board = this.board) {
    if (board[i] !== 0) return null;
    const next = board.slice();
    next[i] = color;
    const enemy = color === 1 ? 2 : 1;
    let captured = 0;
    for (const n of this._neighbors(i)) {
      if (next[n] === enemy) {
        const grp = this._groupOf(n, next);
        if (grp.liberties.size === 0) {
          for (const s of grp.stones) { next[s] = 0; captured += 1; }
        }
      }
    }
    const own = this._groupOf(i, next);
    if (own.liberties.size === 0) return null; // самоубийство
    const key = next.join('');
    if (key === this.lastBoard) return null;   // простое ко
    return { next, captured, key };
  }

  play(i) {
    if (this.finished) return false;
    const res = this._tryMove(i, 1);
    if (!res) return false;
    this.lastBoard = this.board.join('');
    this.board = res.next;
    this.captures.black += res.captured;
    this._syncStones();
    this._notify();
    setTimeout(() => this._botMove(), 420);
    return true;
  }

  pass() {
    if (this.finished) return;
    this.finished = true;
    this._notify();
  }

  _botMove() {
    if (this.finished) return;
    const candidates = [];
    for (let i = 0; i < 81; i++) {
      const res = this._tryMove(i, 2);
      if (!res) continue;
      let score = res.captured * 40 + Math.random() * 6;
      // спасение своих групп в атари
      for (const n of this._neighbors(i)) {
        if (this.board[n] === 2) {
          const grp = this._groupOf(n, this.board);
          if (grp.liberties.size === 1) score += 30;
        }
        if (this.board[n] === 1) score += 4;
      }
      const own = this._groupOf(i, res.next);
      if (own.liberties.size === 1) score -= 35; // самоатари
      const x = i % 9, y = Math.floor(i / 9);
      score += 3 - (Math.abs(x - 4) + Math.abs(y - 4)) * 0.4;
      candidates.push({ i, res, score });
    }
    if (!candidates.length) { this.finished = true; this._notify(); return; }
    candidates.sort((a, b) => b.score - a.score);
    const pick = candidates[0];
    this.lastBoard = this.board.join('');
    this.board = pick.res.next;
    this.captures.white += pick.res.captured;
    this._syncStones();
    this._notify();
  }

  newGame() {
    this.board = Array(81).fill(0);
    this.captures = { black: 0, white: 0 };
    this.lastBoard = '';
    this.finished = false;
    this._syncStones();
    this._notify();
  }

  /** грубый счёт: камни + однотонные пустые области */
  score() {
    const owner = Array(81).fill(0);
    let black = 0, white = 0;
    for (let i = 0; i < 81; i++) {
      if (this.board[i] === 1) black += 1;
      if (this.board[i] === 2) white += 1;
    }
    const seen = new Set();
    for (let i = 0; i < 81; i++) {
      if (this.board[i] !== 0 || seen.has(i)) continue;
      const region = new Set([i]);
      const stack = [i];
      const touch = new Set();
      while (stack.length) {
        const cur = stack.pop();
        for (const n of this._neighbors(cur)) {
          if (this.board[n] === 0 && !region.has(n)) { region.add(n); stack.push(n); }
          if (this.board[n] !== 0) touch.add(this.board[n]);
        }
      }
      for (const s of region) seen.add(s);
      if (touch.size === 1) {
        if (touch.has(1)) black += region.size; else white += region.size;
      }
    }
    return { black, white: white + 6.5 };
  }

  status() {
    if (this.finished) {
      const s = this.score();
      const lead = s.black > s.white ? `чёрные впереди на ${(s.black - s.white).toFixed(1)}` : `белые впереди на ${(s.white - s.black).toFixed(1)}`;
      return `Игра окончена. Примерный счёт: чёрные ${s.black} — белые ${s.white} (коми 6,5): ${lead}.`;
    }
    return `Вы чёрными. Пленных: у вас ${this.captures.black}, у бота ${this.captures.white}.`;
  }

  _notify() { if (this.onState) this.onState(this); }
}
