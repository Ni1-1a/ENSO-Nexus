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

  /**
   * ЗАПРЕТНАЯ ЗОНА — объединение всех ограничений, сплошной подложкой ПОД краской.
   *
   * Штриховки отвечают на вопрос «из-за чего нельзя»: у каждой свой объект и свой
   * цвет. Но на первый вопрос — «куда нельзя вообще» — они отвечают плохо: там,
   * где зоны накладываются, полосы спорят друг с другом, а разрыв между двумя
   * штриховками читается как просвет, хотя запрещено и там. Поэтому под всей
   * краской лежит одна сплошная подложка: сначала видно запрет целиком, потом —
   * чей он.
   */
  const FORBIDDEN = { color: '#a4402f', fill: 'rgba(164, 64, 47, .14)', aci: 14 };

  const KINDS = Object.keys(ZONES);

  function zone(kind) {
    return ZONES[kind] || ZONES.other;
  }

  /* ---------------- цвет на каждый объект-источник ---------------- */

  /**
   * Цвет по номеру объекта. Шаг по кругу оттенков — золотой угол (137,508°):
   * при любом числе зон соседние по номеру цвета оказываются далеко друг от
   * друга, и на площадке с полусотней ограничений список не превращается
   * в пятьдесят оттенков одного синего.
   *
   * Насыщенность и светлота держатся в диапазоне бумажной палитры проекта:
   * тушь по бумаге, а не неон. Светлота слегка гуляет по циклу из трёх — так
   * соседние цвета различимы и в чёрно-белой печати.
   */
  function paletteColor(index) {
    const i = Math.max(0, Math.floor(Number(index) || 0));
    const hue = Math.round((i * 137.508) % 360);
    const sat = 38 + (i % 2) * 12;
    const light = 36 + (i % 3) * 6;
    return `hsl(${hue} ${sat}% ${light}%)`;
  }

  /**
   * Раздать цвета зонам плана — по ОБЪЕКТУ, от которого зона отсчитана.
   *
   * Две зоны от одного объекта (охранная зона и противопожарный разрыв от того
   * же корпуса) получают ОДИН цвет и разный угол штриховки: цвет отвечает за
   * «кто», угол — за «что». Порядок обхода устойчив (тип, затем имя объекта),
   * поэтому пересчёт зон не перекрашивает план заново.
   *
   * @param {Array} restrictions зоны из движка ограничений
   * @returns {{byZone: Object, sources: Array}} цвет на id зоны и перечень источников
   */
  function assignColors(restrictions) {
    const list = (restrictions || []).filter(Boolean);
    const keyOf = (z) => {
      const p = z.properties || {};
      return String(p.sourceObjectId || p.sourceLabel || p.ruleId || z.id || '');
    };
    const order = [...list].sort((a, b) => {
      const pa = a.properties || {}; const pb = b.properties || {};
      return String(pa.sourceLabel || '').localeCompare(String(pb.sourceLabel || ''), 'ru')
        || String(pa.kind || '').localeCompare(String(pb.kind || ''))
        || String(keyOf(a)).localeCompare(String(keyOf(b)));
    });

    const colorByKey = new Map();
    const sources = [];
    for (const z of order) {
      const key = keyOf(z);
      if (colorByKey.has(key)) continue;
      const color = paletteColor(colorByKey.size);
      colorByKey.set(key, color);
      const p = z.properties || {};
      sources.push({
        key,
        color,
        label: p.sourceLabel || KIND_FALLBACK_LABEL,
        layer: p.sourceLayer || '',
        objectId: p.sourceObjectId || '',
      });
    }

    const byZone = {};
    for (const z of list) {
      const key = keyOf(z);
      const p = z.properties || {};
      byZone[z.id] = {
        key,
        color: colorByKey.get(key) || zone(p.kind).color,
        kind: p.kind || 'other',
        angle: zone(p.kind).angle,
        spacing: zone(p.kind).spacing,
        label: p.sourceLabel || '',
        kindLabel: zone(p.kind).label,
        areaM2: p.areaM2 || null,
      };
    }
    return { byZone, sources };
  }

  const KIND_FALLBACK_LABEL = 'объект не назван';

  /** Идентификатор образца штриховки конкретной зоны — по зоне, а не по типу. */
  function zonePatternId(prefix, zoneId) {
    return `${prefix}z-${String(zoneId).replace(/[^a-zA-Z0-9_-]/g, '')}`;
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

  /** Образец штриховки конкретной зоны: угол от типа ограничения, цвет от объекта. */
  function zonePatternSvg(zoneId, { color, angle, spacing }, prefix, scale = 1) {
    const k = Number.isFinite(scale) && scale > 0 ? scale : 1;
    const s = r4((spacing || 7) * k);
    const w = r4(HATCH_STROKE * k);
    return `<pattern id="${zonePatternId(prefix, zoneId)}" width="${s}" height="${s}" ` +
      `data-spacing="${spacing || 7}" ` +
      `patternTransform="rotate(${angle || 0})" patternUnits="userSpaceOnUse">` +
      `<line x1="0" y1="0" x2="0" y2="${s}" stroke="${color}" stroke-width="${w}" opacity=".9"/>` +
      '</pattern>';
  }

  /**
   * Блок `<defs>` со всеми образцами. Вставляется один раз в каждый SVG,
   * где рисуются зоны: и во вьювер, и в миниатюру, и в серверный рендер.
   *
   * Образцы по ТИПАМ остаются: ими рисуются легенда и всё, что не привязано
   * к конкретной зоне. Образцы по ЗОНАМ добавляются, когда список зон известен.
   */
  function defs(prefix = 'zh-', scale = 1, restrictions = null) {
    const byKind = KINDS.map((k) => patternSvg(k, prefix, scale)).join('');
    if (!restrictions || !restrictions.length) return `<defs>${byKind}</defs>`;
    const { byZone } = assignColors(restrictions);
    const byId = restrictions
      .map((z) => (byZone[z.id] ? zonePatternSvg(z.id, byZone[z.id], prefix, scale) : ''))
      .join('');
    return `<defs>${byKind}${byId}</defs>`;
  }

  /** Заливка конкретной зоны — ссылка на её собственный образец. */
  function zoneFillById(zoneId, prefix = 'zh-') {
    return `url(#${zonePatternId(prefix, zoneId)})`;
  }

  /**
   * Пересчёт уже вставленных образцов под новый масштаб — для вьювера:
   * при зуме меняется только viewBox, и пересобирать всю сцену ради штриховки
   * нельзя (потеряются выделения и подсказки).
   */
  function rescaleDefs(svgEl, prefix, scale) {
    if (!svgEl || !svgEl.querySelectorAll) return;
    const k = Number.isFinite(scale) && scale > 0 ? scale : 1;
    const apply = (p, spacing) => {
      const s = r4(spacing * k);
      p.setAttribute('width', s);
      p.setAttribute('height', s);
      const line = p.firstElementChild;
      if (line) {
        line.setAttribute('y2', s);
        line.setAttribute('stroke-width', r4(HATCH_STROKE * k));
      }
    };
    for (const kind of KINDS) {
      const p = svgEl.querySelector(`#${prefix}${kind}`);
      if (p) apply(p, zone(kind).spacing);
    }
    // образцы отдельных зон: их шаг задан тем же типом ограничения
    for (const p of svgEl.querySelectorAll(`pattern[id^="${prefix}z-"]`)) {
      const line = p.firstElementChild;
      const spacing = Number(p.dataset && p.dataset.spacing) || 7;
      if (line) apply(p, spacing);
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

  /** Готовый inline-стиль контура КОНКРЕТНОЙ зоны: цвет от объекта-источника. */
  function zoneStyleById(zoneId, assignment, prefix = 'zh-') {
    const a = (assignment && assignment.byZone && assignment.byZone[zoneId]) || null;
    if (!a) return zoneStyle('other', prefix);
    return `fill:${zoneFillById(zoneId, prefix)};stroke:${a.color};stroke-width:1.3;stroke-opacity:.9`;
  }

  return {
    ZONES, KINDS, BUILDABLE, FOOTPRINT, FORBIDDEN,
    zone, defs, fill, zoneStyle, patternSvg, rescaleDefs, unitsPerPixel,
    assignColors, paletteColor, zonePatternId, zonePatternSvg, zoneFillById, zoneStyleById,
  };
}));
