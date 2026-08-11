/**
 * Преобразование «экран ↔ координаты плана» (ТЗ, п. 35).
 *
 * Живёт отдельным модулем по двум причинам. Во-первых, это единственное место,
 * где экранные пиксели встречаются с мировыми метрами, и ошибка здесь отравит
 * всё: выделения уедут, аннотации перестанут совпадать с объектами. Во-вторых,
 * так математику можно прогнать тестами в Node, не поднимая браузер.
 *
 * Инвариант, который проверяется тестом: зум и панорамирование НЕ меняют
 * мировых координат. Аннотация, поставленная на общем плане, при увеличении
 * в сто раз остаётся на том же месте участка.
 *
 * Система координат: мир — метры, ось Y вверх (как в чертеже);
 * экран — пиксели, ось Y вниз. Отсюда переворот по Y в обе стороны.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.GeoTransform = api;
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /**
   * Точка экрана → точка плана.
   * @param {number} px,py   координаты относительно ЛЕВОГО ВЕРХНЕГО угла холста
   * @param {object} view    {minX, minY, width, height} — окно просмотра в метрах
   * @param {object} box     {width, height} — размер холста в пикселях
   */
  function screenToWorld(px, py, view, box) {
    const w = box.width || 1;
    const h = box.height || 1;
    return [
      view.minX + (px / w) * view.width,
      view.minY + (1 - py / h) * view.height,   // экран вниз, мир вверх
    ];
  }

  /** Точка плана → точка экрана (для отрисовки уже сохранённых аннотаций). */
  function worldToScreen(x, y, view, box) {
    const w = box.width || 1;
    const h = box.height || 1;
    return [
      ((x - view.minX) / view.width) * w,
      (1 - (y - view.minY) / view.height) * h,
    ];
  }

  /**
   * Прямоугольник по двум мировым точкам, приведённый к обходу против часовой
   * стрелки. Порядок вершин важен: движок геометрии и экспорт ожидают
   * предсказуемый обход, а тянуть рамку пользователь может в любую сторону.
   */
  function rectFromPoints(a, b) {
    const minX = Math.min(a[0], b[0]);
    const maxX = Math.max(a[0], b[0]);
    const minY = Math.min(a[1], b[1]);
    const maxY = Math.max(a[1], b[1]);
    return [[minX, minY], [maxX, minY], [maxX, maxY], [minX, maxY]];
  }

  /** Габариты набора точек — нужны и для проверки попадания, и для превью. */
  function boundsOf(points) {
    if (!points || !points.length) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [x, y] of points) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
    return { minX, minY, maxX, maxY };
  }

  /** Пересекаются ли габариты — быстрый отбор объектов внутри выделения. */
  function boundsIntersect(a, b) {
    if (!a || !b) return false;
    return a.minX <= b.maxX && b.minX <= a.maxX && a.minY <= b.maxY && b.minY <= a.maxY;
  }

  /** Площадь выделения в м² — по ней видно, осмысленна ли рамка. */
  function areaOf(points) {
    if (!points || points.length < 3) return 0;
    let s = 0;
    for (let i = 0; i < points.length; i++) {
      const [x1, y1] = points[i];
      const [x2, y2] = points[(i + 1) % points.length];
      s += x1 * y2 - x2 * y1;
    }
    return Math.abs(s) / 2;
  }

  return { screenToWorld, worldToScreen, rectFromPoints, boundsOf, boundsIntersect, areaOf };
}));
