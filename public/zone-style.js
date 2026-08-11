'use strict';
/**
 * Оформление зон ограничений — единственный источник правды.
 *
 * Один и тот же набор цветов, углов и штриховок используют: вьювер плана,
 * миниатюры вариантов, серверный рендер PNG/PDF и выгрузка в DXF. Иначе на
 * экране одна картинка, в отчёте другая, а в чертеже третья — и разговаривать
 * о «фиолетовой зоне» становится невозможно.
 *
 * Зоны рисуются ШТРИХОВКОЙ, а не заливкой, специально: у штриховки прозрачный
 * фон, поэтому две наложенные зоны показывают обе штриховки сразу, и видно,
 * что ограничение здесь двойное. Заливка бы просто перекрыла нижнюю зону.
 *
 * Допустимая территория — единственная сплошная заливка (пастельно-зелёная):
 * это не ограничение, а результат, и он обязан читаться с первого взгляда.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ZoneStyle = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  /**
   * Цвет, угол штриховки и имя образца AutoCAD для каждого типа ограничения.
   * Углы намеренно разведены: две зоны под одним углом сливаются в одну сетку,
   * и наложение перестаёт читаться.
   */
  const ZONES = {
    setback: {
      label: 'отступ от границ',
      color: '#b95740', angle: 45, spacing: 7,
      acadPattern: 'ANSI31', acadAngle: 45, acadScale: 1.5, aci: 12,
    },
    protectionZone: {
      label: 'охранная зона',
      color: '#3f6f9c', angle: 135, spacing: 7,
      acadPattern: 'ANSI31', acadAngle: 135, acadScale: 1.5, aci: 150,
    },
    fireBreak: {
      label: 'противопожарный разрыв',
      color: '#c4581c', angle: 90, spacing: 6,
      acadPattern: 'ANSI32', acadAngle: 90, acadScale: 1.2, aci: 30,
    },
    sanitaryZone: {
      label: 'санитарно-защитная зона',
      color: '#7a5aa8', angle: 0, spacing: 8,
      acadPattern: 'ANSI33', acadAngle: 0, acadScale: 1.6, aci: 200,
    },
    buildLine: {
      label: 'линия регулирования застройки',
      color: '#a8802c', angle: 60, spacing: 8,
      acadPattern: 'ANSI31', acadAngle: 60, acadScale: 2, aci: 42,
    },
    easement: {
      label: 'сервитут или обременение',
      color: '#2f7d6a', angle: 120, spacing: 8,
      acadPattern: 'ANSI37', acadAngle: 120, acadScale: 1.4, aci: 84,
    },
    heightLimit: {
      label: 'предельная высота',
      color: '#8a7f70', angle: 30, spacing: 9,
      acadPattern: 'ANSI31', acadAngle: 30, acadScale: 2, aci: 8,
    },
    coverageLimit: {
      label: 'процент застройки',
      color: '#8a7f70', angle: 150, spacing: 9,
      acadPattern: 'ANSI31', acadAngle: 150, acadScale: 2, aci: 8,
    },
    other: {
      label: 'прочее ограничение',
      color: '#7d7365', angle: 15, spacing: 8,
      acadPattern: 'ANSI31', acadAngle: 15, acadScale: 1.8, aci: 9,
    },
  };

  /** Пастельно-зелёная заливка допустимой территории — результат, а не запрет. */
  const BUILDABLE = { color: '#6f9e78', fill: 'rgba(126, 176, 138, .30)', aci: 92 };

  /** Пятно застройки выбранного варианта — плотнее допустимой зоны. */
  const FOOTPRINT = { color: '#3f6f4c', fill: 'rgba(79, 125, 88, .45)', aci: 3 };

  const KINDS = Object.keys(ZONES);

  function zone(kind) {
    return ZONES[kind] || ZONES.other;
  }

  /** Толщина линии штриховки в пикселях — одна на все образцы. */
  const HATCH_STROKE = 1.4;

  /** Округление до 4 знаков: длинные хвосты раздувают SVG без пользы. */
  const r4 = (n) => Math.round(n * 10000) / 10000;

  /**
   * Множитель «единиц пользовательской системы на один пиксель экрана».
   * Шаг штриховки задан в ПИКСЕЛЯХ, а система координат SVG — в метрах плана,
   * поэтому шаг переводится в метры этим множителем. Без перевода шаг был бы
   * жёстко привязан к метрам: на участке 50 м — четыре толстые полосы,
   * на 2000 м — сплошной блёклый фон, а при зуме штриховка «дышала».
   */
  function unitsPerPixel(viewSpan, pixelSpan) {
    const span = Number(viewSpan);
    const px = Number(pixelSpan);
    if (!(span > 0) || !(px > 0)) return 1;
    return span / px;
  }

  /**
   * Один образец штриховки: только линии, фон прозрачный.
   * `scale` — сколько единиц системы координат приходится на пиксель экрана
   * (см. `unitsPerPixel`). При scale = 1 образец совпадает с прежним, поэтому
   * вызовы без второго аргумента — в том числе серверный рендер PNG/PDF —
   * работают ровно как раньше.
   */
  function patternSvg(kind, prefix, scale = 1) {
    const z = zone(kind);
    const k = Number.isFinite(scale) && scale > 0 ? scale : 1;
    const s = r4(z.spacing * k);
    const w = r4(HATCH_STROKE * k);
    return `<pattern id="${prefix}${kind}" width="${s}" height="${s}" ` +
      `patternTransform="rotate(${z.angle})" patternUnits="userSpaceOnUse">` +
      `<line x1="0" y1="0" x2="0" y2="${s}" stroke="${z.color}" stroke-width="${w}" opacity=".85"/>` +
      '</pattern>';
  }

  /**
   * Блок `<defs>` со всеми образцами. Вставляется один раз в каждый SVG,
   * где рисуются зоны: и во вьювер, и в миниатюру, и в серверный рендер.
   */
  function defs(prefix = 'zh-', scale = 1) {
    return `<defs>${KINDS.map((k) => patternSvg(k, prefix, scale)).join('')}</defs>`;
  }

  /**
   * Пересчёт уже вставленных образцов под новый масштаб — для вьювера:
   * при зуме меняется только viewBox, и пересобирать всю сцену ради штриховки
   * нельзя (потеряются выделения и подсказки).
   */
  function rescaleDefs(svgEl, prefix, scale) {
    if (!svgEl || !svgEl.querySelectorAll) return;
    const k = Number.isFinite(scale) && scale > 0 ? scale : 1;
    for (const kind of KINDS) {
      const p = svgEl.querySelector(`#${prefix}${kind}`);
      if (!p) continue;
      const s = r4(zone(kind).spacing * k);
      p.setAttribute('width', s);
      p.setAttribute('height', s);
      const line = p.firstElementChild;
      if (line) {
        line.setAttribute('y2', s);
        line.setAttribute('stroke-width', r4(HATCH_STROKE * k));
      }
    }
  }

  /** Заливка зоны — ссылка на образец штриховки. */
  function fill(kind, prefix = 'zh-') {
    return `url(#${prefix}${ZONES[kind] ? kind : 'other'})`;
  }

  /** Готовый inline-стиль контура зоны для серверного рендера. */
  function zoneStyle(kind, prefix = 'zh-') {
    const z = zone(kind);
    return `fill:${fill(kind, prefix)};stroke:${z.color};stroke-width:1.3;stroke-opacity:.9`;
  }

  return {
    ZONES, KINDS, BUILDABLE, FOOTPRINT,
    zone, defs, fill, zoneStyle, patternSvg, rescaleDefs, unitsPerPixel,
  };
}));
