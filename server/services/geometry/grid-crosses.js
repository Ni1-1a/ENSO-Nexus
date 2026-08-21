'use strict';
/**
 * Привязка чертежа к системе координат ПО КРЕСТАМ координатной сетки.
 *
 * Зачем. Границу участка мы берём из ГПЗУ таблицей характерных точек, а класть
 * её надо в чертёж. Числа в таблице ЕГРН идут парами (X — север, Y — восток),
 * в чертеже те же числа стоят наоборот: по горизонтали 2 195 xxx, по вертикали
 * 422 xxx. Порядок осей раньше выбирался по тому, попадает ли получившийся
 * контур в габариты чертежа. Это догадка, а не измерение: она врёт, когда
 * участок выходит за рамку съёмки, когда обе раскладки попадают в габариты и
 * когда чертёж вычерчен со сдвигом.
 *
 * Как правильно. У топосъёмки есть координатная сетка, и её кресты подписаны:
 * рядом с линией стоит её координата — «2195850», «422400». Подпись стоит У
 * СВОЕЙ линии, а значит её ЗНАЧЕНИЕ совпадает с КООРДИНАТОЙ ЕЁ ПОЛОЖЕНИЯ по
 * той оси, которую она подписывает. Это и есть измерение: сравниваем число в
 * подписи с местом, где она стоит, и получаем, какая ось чертежа что несёт и
 * есть ли сдвиг. Ни слой, ни имя слоя тут не нужны — в чужих чертежах сетка
 * называется как угодно, а бывает и вовсе на слое «0».
 *
 * Что на выходе: `axes` — какая ось чертежа несёт какое семейство координат,
 * `offsetX/offsetY` — сдвиг чертежа относительно системы координат (обычно 0),
 * и `crosses` — сами найденные подписи, чтобы человек мог проверить глазами.
 */

/** Похоже ли число на координату МСК: 6–8 значащих цифр до запятой. */
function looksLikeCoordinate(n) {
  const abs = Math.abs(n);
  return abs >= 10000 && abs < 100000000;
}

/**
 * Разбор подписи в число.
 * Берём только «чистые» числа: подпись сетки — это ровно координата и ничего
 * больше. «24.02» (отметка высоты) отсеется по величине, «2ст.108» — по форме.
 */
function labelValue(text) {
  const s = String(text || '').trim().replace(',', '.').replace(/\s+/g, '');
  if (!/^-?\d{5,8}(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) && looksLikeCoordinate(n) ? n : null;
}

/** Медиана — устойчива к одной криво стоящей подписи, в отличие от среднего. */
function median(xs) {
  const a = [...xs].sort((p, q) => p - q);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

/**
 * Привязка по подписям сетки.
 *
 * @param {Array} texts   надписи чертежа: {value, layer, at:[x,y]}
 * @param {object} bounds габариты чертежа {minX,minY,maxX,maxY}
 * @returns {{
 *   ok: boolean, crosses: Array, offsetX: number, offsetY: number,
 *   axisX: {min:number,max:number}|null, axisY: {min:number,max:number}|null,
 *   note: string
 * }}
 */
function read(texts = [], bounds = null) {
  const empty = { ok: false, crosses: [], offsetX: 0, offsetY: 0, axisX: null, axisY: null, note: '' };
  const labelled = [];
  for (const t of texts) {
    if (!t || !Array.isArray(t.at) || !Number.isFinite(t.at[0]) || !Number.isFinite(t.at[1])) continue;
    const v = labelValue(t.value);
    if (v === null) continue;
    labelled.push({ value: v, layer: t.layer || '', x: t.at[0], y: t.at[1] });
  }
  if (!labelled.length) return { ...empty, note: 'подписей координатной сетки в чертеже нет' };

  /*
   * Каждой подписи — своя ось. Признак — ПОСТОЯНСТВО разности «значение минус
   * положение», а не близость к нулю.
   *
   * Подпись «2195850» стоит у своей вертикальной линии, поэтому её собственная
   * координата X отличается от значения на одну и ту же величину у всех подписей
   * этой оси: на отступ подписи от линии плюс сдвиг чертежа, если он есть. По
   * второй оси разность будет плясать на сотни метров — семейства координат
   * разнесены, и линии внутри семейства идут с шагом сетки.
   *
   * Прежде ось определялась по «разность близка к нулю», и это работало только
   * у чертежа без сдвига: стоило вычертить съёмку в локальных координатах — и
   * ни одна подпись не опознавалась вовсе. Постоянство разности одинаково
   * находит и то и другое, а заодно САМО даёт величину сдвига.
   */
  const CLUSTER_TOL = 2;    // м: разброс внутри одной оси — отступы подписей ставят одинаково
  const NEAR_TOL = 50;      // м: запасной признак, когда подпись на оси всего одна

  /** Наибольшая группа близких значений: {members, center} либо null. */
  const cluster = (items, get) => {
    let best = null;
    for (const anchor of items) {
      const c = get(anchor);
      const members = items.filter((i) => Math.abs(get(i) - c) <= CLUSTER_TOL);
      if (members.length >= 2 && (!best || members.length > best.members.length)) {
        best = { members, center: median(members.map(get)) };
      }
    }
    return best;
  };

  const rx = (l) => l.value - l.x;
  const ry = (l) => l.value - l.y;
  const groupX = cluster(labelled, rx);
  const groupY = cluster(labelled, ry);

  const onX = [];
  const onY = [];
  for (const l of labelled) {
    const inX = groupX && Math.abs(rx(l) - groupX.center) <= CLUSTER_TOL;
    const inY = groupY && Math.abs(ry(l) - groupY.center) <= CLUSTER_TOL;
    // подпись не может подписывать обе оси: оставляем ту, где разность ближе к своей группе
    if (inX && inY) {
      const dX = Math.abs(rx(l) - groupX.center);
      const dY = Math.abs(ry(l) - groupY.center);
      (dX <= dY ? onX : onY).push({ ...l, residual: dX <= dY ? rx(l) : ry(l), axis: dX <= dY ? 'x' : 'y' });
    } else if (inX) onX.push({ ...l, residual: rx(l), axis: 'x' });
    else if (inY) onY.push({ ...l, residual: ry(l), axis: 'y' });
    else {
      // группы не сложилось (подпись на оси одна) — тогда прежний признак близости
      const dx = Math.abs(rx(l));
      const dy = Math.abs(ry(l));
      if (!groupX && dx <= NEAR_TOL && dx < dy) onX.push({ ...l, residual: rx(l), axis: 'x' });
      else if (!groupY && dy <= NEAR_TOL && dy < dx) onY.push({ ...l, residual: ry(l), axis: 'y' });
    }
  }

  const crosses = [...onX, ...onY].sort((a, b) => a.axis.localeCompare(b.axis) || a.value - b.value);
  if (onX.length < 2 && onY.length < 2) {
    return {
      ...empty,
      crosses,
      note: `подписи, похожие на координаты, есть (${labelled.length}), но ни одна не стоит у своей линии `
        + '— привязать чертёж по сетке нельзя',
    };
  }

  /*
   * Сдвиг чертежа. У правильно вычерченной съёмки он нулевой: подпись
   * совпадает с координатой. Ненулевой и одинаковый по всем подписям сдвиг
   * означает, что чертёж вычерчен в локальных координатах, и его надо
   * учитывать. Разнобой означает, что подписи не от сетки, — тогда честнее
   * отказаться, чем сдвигать участок на непонятную величину.
   */
  const rawX = onX.length ? median(onX.map((c) => c.residual)) : 0;
  const rawY = onY.length ? median(onY.map((c) => c.residual)) : 0;
  const spread = (arr, off) => (arr.length ? Math.max(...arr.map((c) => Math.abs(c.residual - off))) : 0);
  const spreadX = spread(onX, rawX);
  const spreadY = spread(onY, rawY);

  /*
   * Отступ подписи — это ещё не сдвиг чертежа.
   *
   * Подпись креста ставят рядом с линией, а не поверх неё: на Горбунках все
   * четыре подписи отстоят ровно на полметра (по X +0,5, по Y −0,5 — текст
   * стоит вниз-влево от креста). Принять эти полметра за сдвиг значит увезти
   * границу участка на полметра в сторону, и никакая проверка этого не поймает:
   * при переносе площадь не меняется, а именно по площади сверяется контур.
   *
   * Поэтому сдвигом считается только то, что отступом подписи быть не может:
   * больше SHIFT_MIN и одинаковое по всем подписям оси. Всё, что меньше, —
   * оформление, и оно обнуляется.
   */
  const SHIFT_MIN = 5;      // м: больше этого подпись от своей линии не отодвигают
  const SHIFT_SPREAD = 1;   // м: разнобой выше этого означает, что подписи не от сетки
  const realShift = (raw, sp) => (Math.abs(raw) > SHIFT_MIN && sp < SHIFT_SPREAD ? raw : 0);
  const offsetX = realShift(rawX, spreadX);
  const offsetY = realShift(rawY, spreadY);
  const standoffX = rawX - offsetX;
  const standoffY = rawY - offsetY;

  const axisX = onX.length ? { min: Math.min(...onX.map((c) => c.value)), max: Math.max(...onX.map((c) => c.value)) } : null;
  const axisY = onY.length ? { min: Math.min(...onY.map((c) => c.value)), max: Math.max(...onY.map((c) => c.value)) } : null;

  const notes = [];
  notes.push(`подписей сетки: по горизонтали ${onX.length}, по вертикали ${onY.length}`);
  if (offsetX || offsetY) {
    notes.push(`чертёж сдвинут относительно системы координат на (${offsetX.toFixed(2)}; ${offsetY.toFixed(2)}) м`);
  } else if (Math.abs(standoffX) > 0.01 || Math.abs(standoffY) > 0.01) {
    notes.push(`подписи отстоят от своих линий на (${standoffX.toFixed(2)}; ${standoffY.toFixed(2)}) м — это оформление, не сдвиг`);
  }
  if (spreadX > SHIFT_SPREAD || spreadY > SHIFT_SPREAD) {
    notes.push(`подписи расходятся между собой (до ${Math.max(spreadX, spreadY).toFixed(2)} м) — сдвиг не применяется`);
  }
  if (bounds && axisX && (axisX.min < bounds.minX - 500 || axisX.max > bounds.maxX + 500)) {
    notes.push('подписи сетки выходят далеко за габариты чертежа — проверьте их глазами');
  }

  return {
    ok: onX.length >= 1 && onY.length >= 1,
    crosses,
    offsetX, offsetY,
    standoffX, standoffY,
    axisX, axisY,
    spreadX, spreadY,
    note: notes.join('; '),
  };
}

/**
 * К какой оси чертежа отнести число из таблицы координат.
 *
 * Решает не «первая колонка или вторая», а «какому семейству координат
 * принадлежит это число»: по подписям сетки известно, что горизонталь чертежа
 * несёт, скажем, 2 195 xxx, а вертикаль — 422 xxx. Число 2 195 897,76 после
 * этого ложится однозначно, как его ни назови в документе.
 *
 * @returns {'x'|'y'|null} null — сетка не даёт ответа для этого числа
 */
function axisFor(grid, value) {
  if (!grid || !grid.ok) return null;
  const near = (range, v) => {
    if (!range) return Infinity;
    const span = Math.max(range.max - range.min, 1);
    // допуск — разброс подписей плюс запас: участок обычно шире сетки на листе
    const pad = Math.max(span * 5, 5000);
    if (v >= range.min - pad && v <= range.max + pad) return 0;
    return Math.min(Math.abs(v - range.min), Math.abs(v - range.max));
  };
  const dx = near(grid.axisX, value - grid.offsetX);
  const dy = near(grid.axisY, value - grid.offsetY);
  if (dx === dy) return null;
  return dx < dy ? 'x' : 'y';
}

module.exports = { read, axisFor, labelValue };
