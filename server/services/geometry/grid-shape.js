'use strict';
/**
 * Пятно застройки ПО СЕТКЕ КОЛОНН: ортогональный контур из ячеек.
 *
 * Решение владельца (08–09.09.2026, правила К1–К14 ред. 1.1): здание собирается
 * из ячеек сетки колонн, все углы прямые, углов — как можно меньше. Готовые
 * Г/Т/П-формы этого не гарантируют: на клиновидной площадке они не помещаются
 * вовсе, а помещались треугольник и трапеция — фигуры, которые зданием не
 * являются.
 *
 * Как ищется контур (в каждой сетке — свой поворот и свой сдвиг ячеек):
 *  1. ПРЯМОУГОЛЬНИК из a×b ячеек (4 угла). Не влезает ровно — прямоугольник
 *     с вырезом в углу (Г, 6 углов) или с двумя вырезами (Т/П/Z, 8 углов):
 *     перебираются все положения, проверка по префиксным суммам.
 *  2. Не нашлось — РОСТ БЛОКАМИ k×k от затравки: каждый следующий блок тот,
 *     с которым у контура меньше всего углов; хвост перебора снимается ужатием.
 *  3. Тесная территория (объединение блоков ненамного больше здания) — УЖАТИЕ
 *     от полного покрытия: снимается по ячейке с наименьшим приростом углов.
 *
 * Что гарантируется:
 *  - каждая ячейка целиком внутри допустимой территории (с запасом на
 *    сантиметровое округление вершин), значит и контур;
 *  - минимальная ширина корпуса: контур — объединение блоков k×k (при шаге 6 м
 *    и ширине 12 м — блок 2×2), «хвостов» шириной в одну ячейку не бывает;
 *  - площадь совпадает с требуемой с точностью до сантиметрового округления
 *    вершин: шаг сетки подгоняется под целое число ячеек (50 × 5,98 м = 1790 м²);
 *  - контур односвязный, без дыр и без касаний по диагонали.
 *
 * Координаты считает только код, модель сюда не заглядывает (ТЗ, п. 42).
 */
const jts = require('./jts');

const DEFAULT_CELL_M = 6;          // шаг колонн по умолчанию (К8)
const DEFAULT_MIN_WIDTH_M = 12;    // корпус не уже двух ячеек
const MAX_SEEDS = 16;              // затравок роста на одну сетку
const PHASES = [0, 0.25, 0.5, 0.75]; // сдвиг сетки внутри ячейки, по каждой оси
const MAX_CELLS = 6000;            // потолок ячеек в габарите: движок обязан отвечать быстро
const MAX_ASPECT = 3.5;            // вытянутее этого корпус не предлагается (как у готовых форм)
const SHRINK_RATIO = 4;            // ужатие только на тесной территории: покрытие ≤ 4 × здание
const MAX_CONFIGS = 400;           // конфигураций вырезов на габарит: дальше перебор не окупается
const MAX_CORNERS = 16;            // контур с большим числом углов — лестница, а не корпус
const CELL_EPS = 0.008;            // запас у границы: округление вершин до сантиметра
/*
 * Потолок РАБОТЫ на один поворот, а не времени: результат не должен зависеть
 * от того, насколько занята машина. С привязкой к часам на медленном сервере
 * из шести контуров Горбунков пропадали оба шестиугольных, и понять почему
 * было нечем (рецензия круга 3). Единица — одна проба «положение × вырез»
 * или один шаг роста по блокам.
 */
const MAX_WORK = 2500000;

const rad = (d) => (d * Math.PI) / 180;
const round2 = (n) => Math.round(n * 100) / 100;

/* ---------------- углы ---------------- */

/** Кольцо без подряд идущих дублей и без замыкающей точки: иначе угол в дубле теряется. */
function cleanRing(points) {
  const out = [];
  for (const p of Array.isArray(points) ? points : []) {
    if (!Array.isArray(p) || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) return null;
    const last = out[out.length - 1];
    if (last && Math.abs(last[0] - p[0]) < 1e-9 && Math.abs(last[1] - p[1]) < 1e-9) continue;
    out.push(p);
  }
  if (out.length > 1) {
    const [fx, fy] = out[0]; const [lx, ly] = out[out.length - 1];
    if (Math.abs(fx - lx) < 1e-9 && Math.abs(fy - ly) < 1e-9) out.pop();
  }
  return out;
}

/**
 * Число углов у многоугольника: вершины, в которых направление обхода
 * меняется больше чем на 1°. Коллинеарные точки и дубли углами не считаются.
 */
function cornerCount(points) {
  const ring = cleanRing(points);
  if (!ring) return 0;
  const n = ring.length;
  if (n < 3) return n;
  let corners = 0;
  for (let i = 0; i < n; i++) {
    const p = ring[(i - 1 + n) % n]; const q = ring[i]; const r = ring[(i + 1) % n];
    const ax = q[0] - p[0]; const ay = q[1] - p[1];
    const bx = r[0] - q[0]; const by = r[1] - q[1];
    const la = Math.hypot(ax, ay); const lb = Math.hypot(bx, by);
    if (!la || !lb) continue;
    const sin = Math.abs(ax * by - ay * bx) / (la * lb);
    if (sin > 0.0175 || ax * bx + ay * by < 0) corners++;
  }
  return corners;
}

/** Все ли углы прямые (с допуском 1°). Кривой вход — не прямоугольный. */
function isOrthogonal(points) {
  const ring = cleanRing(points);
  if (!ring || ring.length < 4) return false;
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const p = ring[(i - 1 + n) % n]; const q = ring[i]; const r = ring[(i + 1) % n];
    const ax = q[0] - p[0]; const ay = q[1] - p[1];
    const bx = r[0] - q[0]; const by = r[1] - q[1];
    const la = Math.hypot(ax, ay); const lb = Math.hypot(bx, by);
    if (!la || !lb) continue;
    const cos = Math.abs(ax * bx + ay * by) / (la * lb);
    if (!Number.isFinite(cos) || (cos > 0.0175 && cos < 0.9998)) return false;
  }
  return true;
}

/* ---------------- точка в контуре (дешёвый отсев) ---------------- */

function pointInRing(ring, x, y) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]; const [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function pointInGeometry(geometry, x, y) {
  if (!geometry) return false;
  const polys = geometry.type === 'multipolygon'
    ? (geometry.polygons || [])
    : [{ points: geometry.points || [], holes: geometry.holes || [] }];
  for (const p of polys) {
    if (!pointInRing(p.points || [], x, y)) continue;
    if ((p.holes || []).some((h) => pointInRing(h, x, y))) continue;
    return true;
  }
  return false;
}

/* ---------------- сетка ---------------- */

/**
 * Сетка ячеек шага s в повёрнутой системе. inside — какие ячейки целиком внутри
 * территории. Проверка в два шага: все четыре вершины внутри (лучевой тест,
 * дёшево), а у ячеек на краю — ещё и JSTS с запасом EPS_M: иначе на сотнях
 * ячеек участка в 300 м проверка занимала десятки секунд.
 */
/**
 * Пересекает ли отрезок прямоугольник (алгоритм Лианга — Барски). Всё в
 * локальных координатах сетки, где ячейки параллельны осям.
 */
function segmentHitsRect(x1, y1, x2, y2, rx1, ry1, rx2, ry2) {
  let t0 = 0; let t1 = 1;
  const dx = x2 - x1; const dy = y2 - y1;
  for (const [p, q] of [[-dx, x1 - rx1], [dx, rx2 - x1], [-dy, y1 - ry1], [dy, ry2 - y1]]) {
    if (p === 0) { if (q < 0) return false; continue; }
    const r = q / p;
    if (p < 0) { if (r > t1) return false; if (r > t0) t0 = r; }
    else { if (r < t0) return false; if (r < t1) t1 = r; }
  }
  return true;
}

/**
 * Сетка ячеек шага s в повёрнутой системе. `inside` — ячейки, лежащие в
 * территории ЦЕЛИКОМ.
 *
 * Считается без JSTS, двумя дешёвыми проверками:
 *  1. центр ячейки внутри территории — строчной развёрткой (для каждой строки
 *     находятся пересечения всех колец с горизонталью, дальше правило чётности);
 *  2. ни один отрезок границы (внешние кольца, дыры, все доли) не заходит
 *     внутрь ячейки, ужатой на полмиллиметра.
 * Вместе это и есть «ячейка целиком внутри»: граница её не режет, а центр внутри.
 *
 * Прежняя проверка звала JSTS на каждую краевую ячейку — на площадке с двумя
 * десятками дыр от существующих объектов это 20 тыс. вызовов на угол поворота
 * и 20 секунд на прогон (круг 3).
 */
function buildGrid(geometry, { u0, v0, umax, vmax, s, toLocal }) {
  const nu = Math.ceil((umax - u0) / s);
  const nv = Math.ceil((vmax - v0) / s);
  if (!(nu > 0 && nv > 0)) return null;
  if (nu * nv > MAX_CELLS * 4) return { tooBig: nu * nv };

  // кольца территории в локальных координатах сетки
  const polys = geometry.type === 'multipolygon' ? (geometry.polygons || [])
    : [{ points: geometry.points || [], holes: geometry.holes || [] }];
  const rings = [];
  for (const poly of polys) {
    for (const ring of [poly.points || [], ...(poly.holes || [])]) {
      if (!ring || ring.length < 3) continue;
      rings.push(ring.map(toLocal));
    }
  }
  if (!rings.length) return null;

  // 1. центры ячеек: строчная развёртка по правилу чётности (дыры учитываются сами)
  const inside = new Uint8Array(nu * nv);
  let count = 0;
  const xs = [];
  for (let j = 0; j < nv; j++) {
    const y = v0 + (j + 0.5) * s;
    xs.length = 0;
    for (const ring of rings) {
      for (let i = 0; i < ring.length; i++) {
        const [x1, y1] = ring[i];
        const [x2, y2] = ring[(i + 1) % ring.length];
        if ((y1 > y) === (y2 > y)) continue;
        xs.push(x1 + ((y - y1) / (y2 - y1)) * (x2 - x1));
      }
    }
    if (xs.length < 2) continue;
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const from = Math.ceil((xs[k] - u0) / s - 0.5);
      const to = Math.floor((xs[k + 1] - u0) / s - 0.5);
      for (let i = Math.max(0, from); i <= Math.min(nu - 1, to); i++) {
        if (!inside[i * nv + j]) { inside[i * nv + j] = 1; count++; }
      }
    }
  }
  if (!count) return null;
  if (count > MAX_CELLS) return { tooBig: count };

  // 2. ячейки, которые режет граница: кандидаты набираются проходом по рёбрам,
  //    каждый кандидат проверяется точно — отрезок против ужатой ячейки
  /*
   * Ячейка проверяется РАСШИРЕННОЙ на 8 мм: вершины готового контура
   * округляются до сантиметра (смещение до 7,1 мм), и без запаса пятно
   * вылезало за территорию — на П-образном участке под углом до 0,12 м².
   * Чтобы запас не съел ряд ячеек вдоль прямой границы, сама решётка сдвинута
   * внутрь на те же 8 мм (см. вызов buildGrid): ячейка у края начинается в
   * 8 мм от границы, а расширенная ровно её касается — касание допустимо.
   */
  const eps = CELL_EPS;
  const drop = (i, j) => { if (inside[i * nv + j]) { inside[i * nv + j] = 0; count--; } };
  for (const ring of rings) {
    for (let r = 0; r < ring.length; r++) {
      const [x1, y1] = ring[r];
      const [x2, y2] = ring[(r + 1) % ring.length];
      const steps = Math.max(1, Math.ceil(Math.hypot(x2 - x1, y2 - y1) / (s / 2)));
      for (let t = 0; t <= steps; t++) {
        const px = x1 + ((x2 - x1) * t) / steps;
        const py = y1 + ((y2 - y1) * t) / steps;
        const ci = Math.floor((px - u0) / s); const cj = Math.floor((py - v0) / s);
        for (let di = -1; di <= 1; di++) {
          for (let dj = -1; dj <= 1; dj++) {
            const i = ci + di; const j = cj + dj;
            if (i < 0 || j < 0 || i >= nu || j >= nv || !inside[i * nv + j]) continue;
            const rx1 = u0 + i * s - eps; const ry1 = v0 + j * s - eps;
            const rx2 = u0 + (i + 1) * s + eps; const ry2 = v0 + (j + 1) * s + eps;
            if (segmentHitsRect(x1, y1, x2, y2, rx1, ry1, rx2, ry2)) drop(i, j);
          }
        }
      }
    }
  }
  if (!count) return null;

  // префиксные суммы: число ячеек внутри в любом прямоугольнике за O(1)
  const pref = new Int32Array((nu + 1) * (nv + 1));
  for (let i = 0; i < nu; i++) {
    for (let j = 0; j < nv; j++) {
      pref[(i + 1) * (nv + 1) + (j + 1)] = inside[i * nv + j] + pref[i * (nv + 1) + (j + 1)]
        + pref[(i + 1) * (nv + 1) + j] - pref[i * (nv + 1) + j];
    }
  }
  const rectCount = (i, j, a, b) => pref[(i + a) * (nv + 1) + (j + b)] - pref[i * (nv + 1) + (j + b)]
    - pref[(i + a) * (nv + 1) + j] + pref[i * (nv + 1) + j];
  return { nu, nv, inside, count, u0, v0, s, rectCount };
}

/* ---------------- углы на сетке ---------------- */

/** Углы в вершине сетки по четырём ячейкам вокруг; diagonal — недопустимое касание. */
function cornersAtVertex(filled, grid, vx, vy, override) {
  const { nu, nv } = grid;
  const has = (i, j) => {
    if (i < 0 || j < 0 || i >= nu || j >= nv) return false;
    if (override && override.i === i && override.j === j) return override.value === 1;
    return filled[i * nv + j] === 1;
  };
  const a = has(vx - 1, vy - 1); const b = has(vx, vy - 1);
  const c = has(vx - 1, vy); const d = has(vx, vy);
  const n = a + b + c + d;
  if (n === 1 || n === 3) return { corners: 1, diagonal: false };
  if (n === 2) {
    const diagonal = (a && d) || (b && c);
    return { corners: diagonal ? 2 : 0, diagonal };
  }
  return { corners: 0, diagonal: false };
}

/** Прирост числа углов, если ячейке (i, j) присвоить value; null — касание по диагонали. */
function cornerDelta(filled, grid, i, j, value) {
  let before = 0; let after = 0;
  for (const [vx, vy] of [[i, j], [i + 1, j], [i, j + 1], [i + 1, j + 1]]) {
    before += cornersAtVertex(filled, grid, vx, vy, null).corners;
    const a = cornersAtVertex(filled, grid, vx, vy, { i, j, value });
    if (a.diagonal) return null;
    after += a.corners;
  }
  return after - before;
}

/** Всего углов у набора ячеек; NaN — есть касание по диагонали. */
function totalCorners(filled, grid) {
  const { nu, nv } = grid;
  let total = 0;
  for (let vx = 0; vx <= nu; vx++) {
    for (let vy = 0; vy <= nv; vy++) {
      const c = cornersAtVertex(filled, grid, vx, vy, null);
      if (c.diagonal) return NaN;
      total += c.corners;
    }
  }
  return total;
}

/* ---------------- прямоугольник с вырезами ---------------- */

/**
 * Факторизации числа: все пары (r, c) с r·c = n в заданных пределах.
 */
function factorPairs(n, maxR, maxC) {
  const out = [];
  for (let r = 1; r <= Math.min(n, maxR); r++) {
    if (n % r) continue;
    const c = n / r;
    if (c <= maxC) out.push([r, c]);
  }
  return out;
}

/**
 * Прямоугольники a×b ячеек (a·b ≥ cells) с вырезами в углах на a·b − cells ячеек.
 * Вырез — тоже прямоугольник, не тоньше k и не уже k оставшегося корпуса, поэтому
 * минимальная ширина сохраняется. Один вырез — Г (6 углов), два — Т/П/Z (8).
 * Возвращает наборы ячеек с числом углов.
 */
function rectangles(grid, { cells, k, limit, work }) {
  const { nu, nv, inside, rectCount } = grid;
  const out = [];
  const idx = (i, j) => i * nv + j;
  const cap = Math.max(6, limit * 3);        // фигур на габарит — больше отбор всё равно не берёт
  const total = cap * 4;                     // фигур всего: без потолка на поле 350×350 выходило 136 тысяч

  /*
   * Габариты a×b: не только ближайший к площади, но и заметно больший — Г-корпус
   * из двух рукавов по три ячейки это прямоугольник 13×12 минус вырез 10×9, то
   * есть перебор ещё 90 ячеек. Вырез (или два) не больше самой площади, и
   * его должно быть чем вырезать: (a−k)(b−k) ≥ over.
   */
  const dims = [];
  for (let a = k; a <= nu; a++) {
    for (let b = Math.ceil(cells / a); b <= nv; b++) {
      const over = a * b - cells;
      // у Г-корпуса с тонкими рукавами вырез втрое больше самой площади (13×13 − 2·(13+13−2))
      if (over > 3 * cells) break;
      if (b < k) continue;
      if (Math.max(a, b) / Math.min(a, b) > MAX_ASPECT) continue;
      if (over > 0 && (a - k) * (b - k) < over) continue;
      dims.push([a, b, over]);
    }
  }
  dims.sort((p, q) => p[2] - q[2] || p[0] * p[1] - q[0] * q[1]); // без выреза — первыми: у них 4 угла

  /** Начало выреза в координатах сетки: corner 0 нижн.-лев., 1 нижн.-прав., 2 верхн.-прав., 3 верхн.-лев. */
  const notchAt = (corner, r, c, i, j, a, b) => [corner === 0 || corner === 1 ? i : i + a - r, corner === 0 || corner === 3 ? j : j + b - c];
  const disjoint = (n1, n2) => n1[0] + n1[2] <= n2[0] || n2[0] + n2[2] <= n1[0] || n1[1] + n1[3] <= n2[1] || n2[1] + n2[3] <= n1[1];

  let rects4 = 0; // прямоугольников без выреза: лучше четырёх углов не бывает — дальше искать незачем
  let shapes6 = 0; // Г-контуров: габариты идут по росту выреза, и после них лучше шести не найти
  /*
   * Потолок проб «положение × конфигурация выреза»: на территории, изрезанной
   * дырами от существующих объектов, ни один габарит не складывается целиком,
   * и перебор сотен габаритов уходил в десятки секунд впустую (круг 3).
   */
  for (const [a, b, over] of dims) {
    if (work.left <= 0) break;
    if (rects4 >= cap) break;
    if (over > 0 && rects4 === 0 && shapes6 >= cap) break;
    // конфигурации вырезов: [ [corner, r, c], ... ]
    const configs = [];
    if (over === 0) configs.push([]);
    else {
      for (const [r, c] of factorPairs(over, a - k, b - k)) for (let corner = 0; corner < 4; corner++) configs.push([[corner, r, c]]);
      if ((!configs.length || over >= 2) && shapes6 < cap) {
        for (let n1 = 1; n1 <= over - n1 && configs.length < MAX_CONFIGS; n1++) {
          const n2 = over - n1;
          for (const [r1, c1] of factorPairs(n1, a - k, b - k)) {
            for (const [r2, c2] of factorPairs(n2, a - k, b - k)) {
              for (let c = 0; c < 4; c++) {
                for (let d = c + 1; d < 4; d++) {
                  const sameBottom = (c === 0 && d === 1); const sameTop = (c === 2 && d === 3);
                  const sameLeft = (c === 0 && d === 3); const sameRight = (c === 1 && d === 2);
                  if ((sameBottom || sameTop) && b - c1 - c2 < k) continue;
                  if ((sameLeft || sameRight) && a - r1 - r2 < k) continue;
                  // вырезы в противоположных углах не должны пересекаться
                  const n1r = [...notchAt(c, r1, c1, 0, 0, a, b), r1, c1];
                  const n2r = [...notchAt(d, r2, c2, 0, 0, a, b), r2, c2];
                  if (!disjoint(n1r, n2r)) continue;
                  configs.push([[c, r1, c1], [d, r2, c2]]);
                }
              }
            }
          }
        }
      }
    }
    if (!configs.length) continue;
    const cfgCorners = (cfg) => 4 + 2 * cfg.length;
    // положения — с шагом: на большом поле годных положений тысячи, а нужны десятки, разбросанные по площадке
    const positions = (nu - a + 1) * (nv - b + 1);
    const stride = Math.max(1, Math.ceil(Math.sqrt(positions / cap)));
    let added = 0;
    for (let i = 0; i + a <= nu && added < cap; i += stride) {
      for (let j = 0; j + b <= nv && added < cap; j += stride) {
        const insideRect = rectCount(i, j, a, b);
        if (a * b - insideRect > over) continue;
        for (const cfg of configs) {
          if (--work.left <= 0) break;
          // фигура = прямоугольник минус вырезы; все её ячейки внутри ⇔ сумма по префиксным суммам равна числу ячеек
          let insideShape = insideRect;
          for (const [corner, r, c] of cfg) {
            const [ni, nj] = notchAt(corner, r, c, i, j, a, b);
            insideShape -= rectCount(ni, nj, r, c);
          }
          if (insideShape !== cells) continue;
          const filled = new Uint8Array(nu * nv);
          for (let x = 0; x < a; x++) {
            for (let y = 0; y < b; y++) {
              let cut = false;
              for (const [corner, r, c] of cfg) {
                const inR = corner === 0 || corner === 1 ? x < r : x >= a - r;
                const inC = corner === 0 || corner === 3 ? y < c : y >= b - c;
                if (inR && inC) { cut = true; break; }
              }
              if (!cut) filled[idx(i + x, j + y)] = 1;
            }
          }
          out.push({ filled, corners: cfgCorners(cfg), key: `r${a}x${b}@${i},${j}:${cfg.map((c) => c.join('.')).join('|')}` });
          added++;
          if (!cfg.length) rects4++;
          else if (cfg.length === 1) shapes6++;
          break; // одно положение — одна фигура
        }
      }
    }
  }
  // лучшие по числу углов — первыми; хвост с большим числом углов отбрасывается:
  // габариты с малым перебором идут раньше, но дают Т/Z с восемью углами, а Г
  // с шестью живёт в габарите с большим вырезом (рукава 3 ячейки: 13×12 − 10×9)
  out.sort((p, q) => p.corners - q.corners);
  return out.slice(0, total);
}

/* ---------------- рост блоками и ужатие ---------------- */

/**
 * Рост от начального блока: единица роста — блок k×k, делящий грань или ячейку
 * с уже собранным. Выбирается блок, с которым углов меньше всего; вытянутость
 * сверх MAX_ASPECT штрафуется как два лишних угла, иначе жадный рост тянет
 * полосу шириной в один блок. Перебор в последнем блоке снимается ужатием.
 */
function grow(grid, seed, { cells, k, blocks, work }) {
  const { nu, nv } = grid;
  const idx = (i, j) => i * nv + j;
  const filled = new Uint8Array(nu * nv);
  let count = 0;
  let imin = seed[0]; let imax = seed[0] + k - 1; let jmin = seed[1]; let jmax = seed[1] + k - 1;
  const fillBlock = (bi, bj) => {
    for (let x = bi; x < bi + k; x++) for (let y = bj; y < bj + k; y++) if (!filled[idx(x, y)]) { filled[idx(x, y)] = 1; count++; }
    imin = Math.min(imin, bi); imax = Math.max(imax, bi + k - 1); jmin = Math.min(jmin, bj); jmax = Math.max(jmax, bj + k - 1);
  };
  fillBlock(seed[0], seed[1]);
  if (count > cells) return null;
  const cu = seed[0] + k / 2; const cv = seed[1] + k / 2;
  const touches = (bi, bj) => {
    for (let x = bi; x < bi + k; x++) {
      for (let y = bj; y < bj + k; y++) {
        if (filled[idx(x, y)]) return true;
        for (const [a, b] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]) {
          if (a >= 0 && b >= 0 && a < nu && b < nv && filled[idx(a, b)]) return true;
        }
      }
    }
    return false;
  };
  while (count < cells) {
    // шаг роста стоит перебора всех блоков-кандидатов — так он и списывается
    work.left -= blocks.length;
    if (work.left <= 0) return null; // изрезанная территория: рост не должен съедать прогон
    let best = null;
    for (const [bi, bj] of blocks) {
      let fresh = 0;
      for (let x = bi; x < bi + k; x++) for (let y = bj; y < bj + k; y++) if (!filled[idx(x, y)]) fresh++;
      if (!fresh || !touches(bi, bj)) continue;
      const over = Math.max(0, count + fresh - cells);
      if (over >= k) continue;
      const trial = filled.slice();
      for (let x = bi; x < bi + k; x++) for (let y = bj; y < bj + k; y++) trial[idx(x, y)] = 1;
      const corners = totalCorners(trial, grid);
      // лестница с десятками углов зданием не станет — не тратим на неё шаги
      if (!Number.isFinite(corners) || corners > MAX_CORNERS) continue;
      const w = Math.max(imax, bi + k - 1) - Math.min(imin, bi) + 1;
      const h = Math.max(jmax, bj + k - 1) - Math.min(jmin, bj) + 1;
      const stretched = Math.max(w, h) / Math.min(w, h) > MAX_ASPECT ? 2 : 0;
      const far = (bi + k / 2 - cu) ** 2 + (bj + k / 2 - cv) ** 2;
      const score = [over > 0 ? 1 : 0, corners + stretched, -fresh, far];
      if (!best || lexLess(score, best.score)) best = { bi, bj, score };
    }
    if (!best) return null;
    fillBlock(best.bi, best.bj);
  }
  return count > cells ? trimTo(filled, grid, { cells, k, count }) : filled;
}

function lexLess(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] < b[i]) return true;
    if (a[i] > b[i]) return false;
  }
  return false;
}

/** Все ли соседи ячейки остаются в полных блоках k×k. */
function neighboursInBlocks(filled, grid, i, j, k) {
  const { nu, nv } = grid;
  const idx = (x, y) => x * nv + y;
  const inBlock = (ci, cj) => {
    for (let bi = ci - k + 1; bi <= ci; bi++) {
      for (let bj = cj - k + 1; bj <= cj; bj++) {
        if (bi < 0 || bj < 0 || bi + k > nu || bj + k > nv) continue;
        let whole = true;
        for (let x = bi; x < bi + k && whole; x++) for (let y = bj; y < bj + k; y++) if (!filled[idx(x, y)]) { whole = false; break; }
        if (whole) return true;
      }
    }
    return false;
  };
  // снятая ячейка ломает все блоки, её содержащие, — судьба ячеек в окне (2k−1)²,
  // восьми соседей хватало только при k = 2 (рецензия круга 2)
  for (let x = i - k + 1; x <= i + k - 1; x++) {
    for (let y = j - k + 1; y <= j + k - 1; y++) {
      if ((x === i && y === j) || x < 0 || y < 0 || x >= nu || y >= nv || !filled[idx(x, y)]) continue;
      if (!inBlock(x, y)) return false;
    }
  }
  return true;
}

function isConnected(filled, grid, count) {
  const { nu, nv } = grid;
  let start = -1;
  for (let c = 0; c < filled.length; c++) if (filled[c]) { start = c; break; }
  if (start < 0) return false;
  const seen = new Uint8Array(filled.length);
  const stack = [start]; seen[start] = 1; let n = 0;
  while (stack.length) {
    const c = stack.pop(); n++;
    const i = Math.floor(c / nv); const j = c % nv;
    for (const [x, y] of [[i - 1, j], [i + 1, j], [i, j - 1], [i, j + 1]]) {
      if (x < 0 || y < 0 || x >= nu || y >= nv) continue;
      const d = x * nv + y;
      if (filled[d] && !seen[d]) { seen[d] = 1; stack.push(d); }
    }
  }
  return n === count;
}

/**
 * Снять лишние ячейки до нужного числа: по одной, ту, без которой углов меньше
 * всего; связность и минимальная ширина проверяются у претендента на ход.
 */
function trimTo(filled, grid, { cells, k, count }) {
  const { nu, nv } = grid;
  while (count > cells) {
    let best = null;
    for (let c = 0; c < filled.length; c++) {
      if (!filled[c]) continue;
      const i = Math.floor(c / nv); const j = c % nv;
      let neigh = 0;
      for (const [x, y] of [[i - 1, j], [i + 1, j], [i, j - 1], [i, j + 1]]) {
        if (x >= 0 && y >= 0 && x < nu && y < nv && filled[x * nv + y]) neigh++;
      }
      if (neigh === 4) continue; // внутренняя ячейка: убирать — дыра
      const delta = cornerDelta(filled, grid, i, j, 0);
      if (delta === null) continue;
      const score = [delta, neigh];
      if (best && !lexLess(score, best.score)) continue;
      filled[c] = 0; count--;
      const ok = neighboursInBlocks(filled, grid, i, j, k) && isConnected(filled, grid, count);
      filled[c] = 1; count++;
      if (ok) best = { c, score };
    }
    if (!best) return null;
    filled[best.c] = 0; count--;
  }
  return filled;
}

/**
 * Ужатие от полного покрытия: со ВСЕХ ячеек, из которых складываются полные
 * блоки k×k, к нужному числу. Нужно на тесной территории (клин): рост от
 * затравки там упирается в границы, а ужатие снимает лишнее со ступеней.
 */
function shrink(grid, { cells, k, blocks }) {
  const { nu, nv } = grid;
  const filled = new Uint8Array(nu * nv);
  let count = 0;
  for (const [bi, bj] of blocks) {
    for (let x = bi; x < bi + k; x++) for (let y = bj; y < bj + k; y++) if (!filled[x * nv + y]) { filled[x * nv + y] = 1; count++; }
  }
  if (count < cells || count > SHRINK_RATIO * cells) return null;
  if (!isConnected(filled, grid, count)) return null;
  return trimTo(filled, grid, { cells, k, count });
}

/* ---------------- контур ---------------- */

/** Обход границы: направленные рёбра против часовой стрелки → одно кольцо вершин сетки. */
function traceBoundary(filled, grid) {
  const { nu, nv } = grid;
  const has = (i, j) => i >= 0 && j >= 0 && i < nu && j < nv && filled[i * nv + j] === 1;
  const edges = new Map();
  let total = 0;
  const put = (from, to) => { edges.set(`${from[0]},${from[1]}`, to); total++; };
  for (let i = 0; i < nu; i++) {
    for (let j = 0; j < nv; j++) {
      if (!has(i, j)) continue;
      if (!has(i, j - 1)) put([i, j], [i + 1, j]);
      if (!has(i + 1, j)) put([i + 1, j], [i + 1, j + 1]);
      if (!has(i, j + 1)) put([i + 1, j + 1], [i, j + 1]);
      if (!has(i - 1, j)) put([i, j + 1], [i, j]);
    }
  }
  if (!edges.size || edges.size !== total) return null; // две дуги из одной вершины — касание
  const start = edges.keys().next().value;
  const ring = [];
  let cur = start;
  for (let guard = 0; guard <= total; guard++) {
    const [x, y] = cur.split(',').map(Number);
    ring.push([x, y]);
    const next = edges.get(cur);
    if (!next) return null;
    cur = `${next[0]},${next[1]}`;
    if (cur === start) break;
  }
  if (ring.length !== total) return null; // несколько колец: дыра внутри контура
  const out = [];
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const p = ring[(i - 1 + n) % n]; const q = ring[i]; const r = ring[(i + 1) % n];
    const straight = (q[0] - p[0]) * (r[1] - q[1]) - (q[1] - p[1]) * (r[0] - q[0]) === 0;
    if (!straight) out.push(q);
  }
  return out;
}

/** Нет ли перешейков уже минимальной ширины: буфер внутрь на полширины — один непустой полигон. */
function neckOk(points, minWidthM) {
  try {
    const poly = jts.toJts({ type: 'polygon', closed: true, points });
    if (!poly) return false;
    const inner = poly.buffer(-(minWidthM / 2 - 0.05));
    return !!inner && !inner.isEmpty() && inner.getNumGeometries() === 1;
  } catch { return false; }
}

function perimeterOf(points) {
  let s = 0;
  for (let i = 0; i < points.length; i++) {
    const [x1, y1] = points[i]; const [x2, y2] = points[(i + 1) % points.length];
    s += Math.hypot(x2 - x1, y2 - y1);
  }
  return s;
}

/**
 * Отбор n фигур: сначала все с наименьшим числом углов (с разбросом по
 * площадке — чтобы четыре варианта не стояли в трёх метрах друг от друга),
 * потом следующие по числу углов.
 */
function pickSpread(list, n) {
  if (list.length <= n) return [...list].sort((p, q) => p.corners - q.corners || p.perimeterM - q.perimeterM);
  const groups = new Map();
  for (const c of list) { if (!groups.has(c.corners)) groups.set(c.corners, []); groups.get(c.corners).push(c); }
  const picked = [];
  for (const corners of [...groups.keys()].sort((a, b) => a - b)) {
    const pool = groups.get(corners).sort((p, q) => p.perimeterM - q.perimeterM);
    if (picked.length >= n) break;
    const chosen = [pool[0]];
    while (chosen.length < Math.min(pool.length, n - picked.length)) {
      let best = null; let bestD = -1;
      for (const c of pool) {
        if (chosen.includes(c)) continue;
        let minD = Infinity;
        for (const p of chosen) minD = Math.min(minD, Math.hypot(c.center[0] - p.center[0], c.center[1] - p.center[1]));
        // расстояния сравниваются с точностью до сантиметра, а ничья решается
        // положением: в МСК-47 (координаты 2 200 000) хвост плавающей точки
        // делал «равноудалённые» контуры неравными, и тот же участок в разных
        // системах координат давал разный последний вариант
        minD = Math.round(minD * 100) / 100;
        const closer = minD > bestD
          || (minD === bestD && best
            && (c.center[0] < best.center[0]
              || (c.center[0] === best.center[0] && c.center[1] < best.center[1])));
        if (closer) { bestD = minD; best = c; }
      }
      if (!best) break;
      chosen.push(best);
    }
    picked.push(...chosen);
  }
  return picked.slice(0, n);
}

/**
 * Пятна по сетке внутри территории при заданном повороте.
 * @param {object} area      JSTS-геометрия допустимой территории
 * @param {object} o.geometry наша геометрия той же территории (polygon/multipolygon) — для дешёвого отсева
 * @param {number} o.areaM2  требуемая площадь застройки
 * @param {number} o.angleDeg направление оси сетки (против часовой)
 * @param {number} o.cellM   шаг колонн, м
 * @param {number} o.minWidthM минимальная ширина корпуса, м
 * @param {Array}  o.origin  начало локальной системы (округление от него, см. shapes.footprint)
 * @param {Array}  o.notes   сюда пишется, почему сетка пропущена (слишком велика и т. п.)
 * @returns {Array<{points, corners, cells, cellM, width, length, perimeterM, center, rotationDeg, method}>}
 */
function generate(area, {
  areaM2, angleDeg = 0, cellM = DEFAULT_CELL_M, minWidthM = DEFAULT_MIN_WIDTH_M, origin = null, limit = 8,
  geometry = null, notes = null, stats = null,
} = {}) {
  if (!area || !(areaM2 > 0)) return [];
  const step = cellM > 0 ? cellM : DEFAULT_CELL_M;
  const cells = Math.max(1, Math.round(areaM2 / (step * step)));
  const s = Math.sqrt(areaM2 / cells);
  // k — от НОМИНАЛЬНОГО шага: при 50 ячейках шаг 5,98 м, и 12 / 5,98 = 2,006 дал бы
  // блок 3×3 (18 м) вместо 2×2 — здания до 300 м² не строились бы вовсе
  const k = Math.max(1, Math.ceil((minWidthM > 0 ? minWidthM : DEFAULT_MIN_WIDTH_M) / step - 1e-9));
  if (cells < k * k) return [];

  const geom = geometry || jts.fromJts(area);
  const a = rad(angleDeg); const ca = Math.cos(a); const sa = Math.sin(a);
  const [ox, oy] = origin || [0, 0];
  /*
   * Локальные координаты округляются до десятой доли миллиметра. В МСК-47
   * координаты порядка 2 200 000, и разность даёт хвост 1e-10: тот же участок
   * в МСК и в локальной системе давал ячейкам у самой границы разный ответ,
   * а за ним — другой набор вариантов (ТЗ требует обратного).
   */
  const r4 = (n) => Math.round(n * 1000) / 1000; // до миллиметра: буферы JSTS в МСК дают хвост в микронах
  const toLocal = ([x, y]) => [r4((x - ox) * ca + (y - oy) * sa), r4(-(x - ox) * sa + (y - oy) * ca)];
  const toWorld = ([u, v]) => [ox + u * ca - v * sa, oy + u * sa + v * ca];

  let umin = Infinity; let umax = -Infinity; let vmin = Infinity; let vmax = -Infinity;
  for (const c of area.getCoordinates()) {
    const [u, v] = toLocal([c.x, c.y]);
    if (u < umin) umin = u; if (u > umax) umax = u;
    if (v < vmin) vmin = v; if (v > vmax) vmax = v;
  }
  if (!(umax > umin && vmax > vmin)) return [];

  const seen = new Set();
  const out = [];
  let perfect = false;
  const work = { left: MAX_WORK };
  for (const pu of PHASES) {
    if (work.left <= 0) break;
    for (const pv of PHASES) {
      if (perfect || work.left <= 0) break;
      /*
       * Решётка привязана к сантиметровому якорю, а не к самому `umin`:
       * буферы JSTS в МСК-47 дают вершины с хвостом в микронах, и тот же
       * участок в разных системах координат сдвигал сетку на доли миллиметра —
       * а с ней и весь набор вариантов (ТЗ требует одинакового результата).
       * Сдвиг внутрь чуть больше запаса проверки: иначе расширенная ячейка
       * первого ряда КАСАЕТСЯ границы, а касание Лианг — Барски считает
       * пересечением, и ряд у прямой границы теряется.
       */
      const anchorU = Math.round(umin * 100) / 100;
      const anchorV = Math.round(vmin * 100) / 100;
      const grid = buildGrid(geom, { u0: anchorU + CELL_EPS * 1.5 - s * pu, v0: anchorV + CELL_EPS * 1.5 - s * pv, umax, vmax, s, toLocal });
      if (!grid) continue;
      if (grid.tooBig) {
        if (notes && !notes.length) {
          notes.push(`контур по сетке колонн не строился: территория в габарите даёт ${grid.tooBig.toLocaleString('ru-RU')} ячеек `
            + `по ${round2(s)} м при потолке ${MAX_CELLS.toLocaleString('ru-RU')} — предлагаются готовые формы`);
        }
        return [];
      }
      const { nu, nv, inside } = grid;
      const blockOk = (bi, bj) => {
        if (bi < 0 || bj < 0 || bi + k > nu || bj + k > nv) return false;
        for (let x = bi; x < bi + k; x++) for (let y = bj; y < bj + k; y++) if (!inside[x * nv + y]) return false;
        return true;
      };
      const blocks = [];
      for (let i = 0; i + k <= nu; i++) for (let j = 0; j + k <= nv; j++) if (blockOk(i, j)) blocks.push([i, j]);
      if (!blocks.length) continue;
      // потолок площади по сетке: наибольшая связная часть объединения полных блоков —
      // в отказе «не помещается» это главное число («по сетке здесь не больше N м²»)
      if (stats) {
        const ceiling = largestComponent(blocks, nu, nv, k) * s * s;
        if (!(stats.ceilingM2 >= ceiling)) stats.ceilingM2 = Math.round(ceiling * 100) / 100;
      }

      const found = [];
      // 1. прямоугольник и прямоугольник с вырезами
      for (const r of rectangles(grid, { cells, k, limit, work })) found.push({ ...r, method: 'rect' });
      // 2. рост блоками — когда прямоугольного решения нет
      if (!found.length) {
        const stride = Math.max(1, Math.ceil(blocks.length / MAX_SEEDS));
        for (let b = 0; b < blocks.length; b += stride) {
          if (work.left <= 0) break;
          const filled = grow(grid, blocks[b], { cells, k, blocks, work });
          if (filled) found.push({ filled, corners: totalCorners(filled, grid), method: 'grow', key: `g${b}` });
        }
      }
      // 3. ужатие от полного покрытия — на тесной территории
      if (!found.length || found.every((f) => f.corners > 8)) {
        const filled = shrink(grid, { cells, k, blocks });
        if (filled) found.push({ filled, corners: totalCorners(filled, grid), method: 'shrink', key: 'shrink' });
      }

      for (const f of found) {
        if (!(f.corners <= MAX_CORNERS)) continue;
        const key = `${f.key}@${pu},${pv}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const ring = traceBoundary(f.filled, grid);
        if (!ring) continue;
        let imin = Infinity; let imax = -Infinity; let jmin = Infinity; let jmax = -Infinity;
        let su = 0; let sv = 0;
        for (let i = 0; i < nu; i++) {
          for (let j = 0; j < nv; j++) {
            if (!f.filled[i * nv + j]) continue;
            if (i < imin) imin = i; if (i > imax) imax = i;
            if (j < jmin) jmin = j; if (j > jmax) jmax = j;
            su += grid.u0 + (i + 0.5) * s; sv += grid.v0 + (j + 0.5) * s;
          }
        }
        const points = ring.map(([vx, vy]) => {
          const [x, y] = toWorld([grid.u0 + vx * s, grid.v0 + vy * s]);
          return [round2(x - ox) + ox, round2(y - oy) + oy];
        });
        const centre = toWorld([su / cells, sv / cells]);
        const corners = ring.length;
        out.push({
          points, corners, cells, cellM: round2(s), method: f.method,
          width: round2((imax - imin + 1) * s),
          length: round2((jmax - jmin + 1) * s),
          perimeterM: round2(perimeterOf(points)),
          center: [round2(centre[0] - ox) + ox, round2(centre[1] - oy) + oy],
          rotationDeg: angleDeg,
        });
        if (corners === 4) perfect = true;
      }
    }
    if (perfect) break;
  }
  // блок, «повешенный» на угол корпуса общей ячейкой, правило блоков k×k проходит
  // буквально, но проход между корпусами выходит уже минимальной ширины: буфер
  // внутрь на полширины обязан оставить ОДИН непустой контур. Проверка — JTS,
  // поэтому только у отобранных, с добором взамен отброшенных
  const picked = pickSpread(out, limit * 2).filter((c) => neckOk(c.points, k * s));
  return picked.slice(0, limit);
}

/** Наибольшая связная часть объединения полных блоков k×k, в ячейках. */
function largestComponent(blocks, nu, nv, k) {
  const filled = new Uint8Array(nu * nv);
  for (const [bi, bj] of blocks) for (let x = bi; x < bi + k; x++) for (let y = bj; y < bj + k; y++) filled[x * nv + y] = 1;
  const seen = new Uint8Array(nu * nv);
  let best = 0;
  for (let c = 0; c < filled.length; c++) {
    if (!filled[c] || seen[c]) continue;
    let n = 0; const stack = [c]; seen[c] = 1;
    while (stack.length) {
      const cur = stack.pop(); n++;
      const i = Math.floor(cur / nv); const j = cur % nv;
      for (const [x, y] of [[i - 1, j], [i + 1, j], [i, j - 1], [i, j + 1]]) {
        if (x < 0 || y < 0 || x >= nu || y >= nv) continue;
        const d = x * nv + y;
        if (filled[d] && !seen[d]) { seen[d] = 1; stack.push(d); }
      }
    }
    if (n > best) best = n;
  }
  return best;
}

module.exports = {
  generate, cornerCount, isOrthogonal, DEFAULT_CELL_M, DEFAULT_MIN_WIDTH_M, MAX_CELLS,
  // открыто для тестов
  cleanRing, factorPairs,
};
