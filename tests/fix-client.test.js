'use strict';
/**
 * Клиентская часть: разбор разметки, стилей и исходников public/.
 *
 * Браузера в тестах нет, поэтому проверяется то, что проверяется без него:
 * реальные функции модуля оформления зон (он CommonJS и грузится в Node),
 * вырезанная из app.js `syncList` на крошечной заглушке DOM, а всё остальное —
 * по разметке, стилям и наличию обработчиков в исходниках.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const PUBLIC = path.join(__dirname, '..', 'public');
const read = (name) => fs.readFileSync(path.join(PUBLIC, name), 'utf8');

const html = read('index.html');
const css = read('styles.css');
const appJs = read('app.js');
const authJs = read('auth.js');
const viewerJs = read('viewer.js');
const ZoneStyle = require(path.join(PUBLIC, 'zone-style.js'));

/* ================= крошечная заглушка DOM для syncList ================= */
/* Настоящего DOM в Node нет, а проверить хочется именно живую функцию:
   она отвечает за то, какой проект откроется по клику в сайдбаре. */

function parseElement(str) {
  const m = /^\s*<([a-zA-Z]+)([^>]*?)>([\s\S]*)<\/\1>\s*$/.exec(str);
  if (!m) return null;
  const el = makeElement(m[1].toUpperCase());
  const attrRe = /([\w:-]+)="([^"]*)"/g;
  let a;
  while ((a = attrRe.exec(m[2]))) el.setAttribute(a[1], a[2]);
  el.innerHTML = m[3];
  return el;
}

function makeElement(tagName) {
  const attrs = new Map();
  return {
    tagName,
    innerHTML: '',
    children: [],
    get className() { return attrs.get('class') || ''; },
    get attributes() { return [...attrs].map(([name, value]) => ({ name, value })); },
    getAttributeNames() { return [...attrs.keys()]; },
    getAttribute(n) { return attrs.has(n) ? attrs.get(n) : null; },
    setAttribute(n, v) { attrs.set(n, String(v)); },
    removeAttribute(n) { attrs.delete(n); },
    hasAttribute(n) { return attrs.has(n); },
    appendChild(child) { this.children.push(child); return child; },
    removeChild(child) { this.children = this.children.filter((x) => x !== child); return child; },
    get lastElementChild() { return this.children[this.children.length - 1] || null; },
    replaceWith(other) {
      const parent = this.__parent;
      if (parent) parent.children[parent.children.indexOf(this)] = other;
    },
  };
}

/** Контейнер списка: children ведут себя как у настоящего узла. */
function makeList() {
  const el = makeElement('UL');
  const origAppend = el.appendChild.bind(el);
  el.appendChild = (child) => { child.__parent = el; return origAppend(child); };
  return el;
}

/** Вырезает из app.js настоящие syncAttrs + syncList и оживляет их. */
function loadSyncList() {
  const start = appJs.indexOf('function syncAttrs(');
  assert.ok(start > 0, 'в app.js должна быть функция syncAttrs');
  const marker = '\n  el.__items = items;\n  return changed;\n}';
  const end = appJs.indexOf(marker, start);
  assert.ok(end > start, 'в app.js должна быть функция syncList');
  // строку с созданием буферного узла выкидываем: document в Node нет,
  // вместо него в функцию передаётся заглушка
  const code = appJs.slice(start, end + marker.length)
    .replace(/^const listTmp = document\.createElement\('div'\);$/m, '');
  // eslint-disable-next-line no-new-func
  return new Function('listTmp', `${code}\nreturn { syncAttrs, syncList };`)({
    _html: '',
    set innerHTML(v) { this._html = v; this._el = parseElement(v); },
    get innerHTML() { return this._html; },
    get firstElementChild() { return this._el; },
  });
}

const sync = loadSyncList();

const sessItem = (id, title, active) =>
  `<li class="sess-item${active ? ' active' : ''}" data-sess="${id}">` +
  `<span class="sess-title">${title}</span>` +
  `<button class="sess-more" data-more="${id}">⋮</button></li>`;

/* ================= 1. критично: клик по проекту ================= */

test('syncList переносит атрибуты корневого узла: строка проекта не уносит чужой data-sess', () => {
  const list = makeList();
  // сначала список из трёх проектов
  sync.syncList(list, [sessItem('A', 'ПЕРВЫЙ', true), sessItem('B', 'ВТОРОЙ', false), sessItem('C', 'ТРЕТИЙ', false)]);
  assert.deepStrictEqual(list.children.map((li) => li.getAttribute('data-sess')), ['A', 'B', 'C']);

  // сервер отдаёт ORDER BY updated_at DESC — два неактивных проекта поменялись местами
  sync.syncList(list, [sessItem('A', 'ПЕРВЫЙ', true), sessItem('C', 'ТРЕТИЙ', false), sessItem('B', 'ВТОРОЙ', false)]);
  const rows = list.children.map((li) => ({
    title: /<span class="sess-title">([^<]*)<\/span>/.exec(li.innerHTML)[1],
    sess: li.getAttribute('data-sess'),
    more: /data-more="([^"]*)"/.exec(li.innerHTML)[1],
  }));
  assert.deepStrictEqual(rows.map((r) => r.title), ['ПЕРВЫЙ', 'ТРЕТИЙ', 'ВТОРОЙ']);
  for (const r of rows) {
    assert.strictEqual(r.sess, r.more, `строка «${r.title}»: клик и меню «⋮» должны вести в один проект`);
  }
});

test('syncList обновляет класс корневого узла: подсветка активного проекта переезжает', () => {
  const list = makeList();
  sync.syncList(list, [sessItem('A', 'ПЕРВЫЙ', true), sessItem('B', 'ВТОРОЙ', false)]);
  sync.syncList(list, [sessItem('A', 'ПЕРВЫЙ', false), sessItem('B', 'ВТОРОЙ', true)]);
  assert.deepStrictEqual(list.children.map((li) => li.className), ['sess-item', 'sess-item active']);
});

test('syncList удаляет лишние узлы и не трогает неизменившиеся', () => {
  const list = makeList();
  sync.syncList(list, [sessItem('A', 'ПЕРВЫЙ', false), sessItem('B', 'ВТОРОЙ', false)]);
  const first = list.children[0];
  const changed = sync.syncList(list, [sessItem('A', 'ПЕРВЫЙ', false)]);
  assert.strictEqual(list.children.length, 1);
  assert.strictEqual(list.children[0], first, 'неизменившийся узел не должен пересоздаваться');
  assert.strictEqual(changed, true);
});

/* ================= 2. плашки-предупреждения ================= */

test('все три плашки лежат в одном контейнере #banners и идут стопкой', () => {
  const box = /<div id="banners"[\s\S]*?<\/div>\s*<\/div>/.exec(html);
  assert.ok(box, 'в разметке должен быть контейнер #banners');
  for (const id of ['offline-banner', 'local-ai-banner', 'mock-banner']) {
    assert.ok(box[0].includes(`id="${id}"`), `плашка ${id} должна лежать внутри #banners`);
  }
});

test('плашка перестала быть position: fixed — иначе они ложатся друг на друга', () => {
  const rule = /\.mock-banner\s*\{([^}]*)\}/.exec(css);
  assert.ok(rule, 'правило .mock-banner должно остаться');
  assert.ok(!/position:\s*fixed/.test(rule[1]), '.mock-banner не должна быть fixed — fixed сейчас у контейнера');
  assert.match(css, /\.banners\s*\{[^}]*position:\s*fixed/, 'стопка плашек должна быть закреплена контейнером');
  assert.match(css, /\.banners\s*\{[^}]*flex-direction:\s*column/, 'плашки должны идти столбцом');
});

test('приложение сдвинуто на высоту стопки плашек, и высота считается в app.js', () => {
  assert.match(css, /\.shell\s*\{\s*padding-top:\s*var\(--banners-h/, 'содержимое должно начинаться под плашками');
  assert.match(css, /\.sidebar-toggle\s*\{[^}]*var\(--banners-h/, 'значок панели не должен уходить под плашки');
  assert.ok(!/body:has\(\.mock-banner/.test(css), 'подпорка со сдвигом значка на 46px больше не нужна');
  assert.match(appJs, /setProperty\('--banners-h'/, 'app.js должен выставлять --banners-h');
  assert.match(appJs, /new ResizeObserver\(measureBanners\)/, 'высота стопки должна пересчитываться при изменении');
  // плашки переключаются через setBanner, иначе высота не пересчитается
  assert.ok(!/\$\('(offline|mock|local-ai)-banner'\)\.hidden\s*=/.test(appJs),
    'плашки должны переключаться через setBanner, а не прямым hidden');
});

/* ================= 3. решения по мероприятиям ================= */

test('в карточке вариантов есть кнопки решения по мероприятию', () => {
  assert.match(appJs, /data-decide="\$\{esc\(a\.id\)\}"\s*data-decision="allow"/, 'должна быть кнопка «Разрешить»');
  assert.match(appJs, /data-decision="forbid"/, 'должна быть кнопка «Запретить»');
  assert.match(appJs, /Разрешить</);
  assert.match(appJs, /Запретить</);
});

test('решение уходит на серверный маршрут /plan/actions/:id с decision и decidedBy', () => {
  assert.match(appJs, /\/plan\/actions\/\$\{actionId\}`,\s*\{\s*method:\s*'POST',\s*json:\s*\{\s*decision,\s*decidedBy\s*\}/);
  assert.match(appJs, /decision === 'allow'/);
  assert.match(appJs, /window\.Auth && window\.Auth\.user/, 'решение подписывается именем вошедшего');
});

test('обработчик клика по кнопке решения зарегистрирован', () => {
  assert.match(appJs, /e\.target\.closest\('\[data-decide\]'\)/);
  assert.match(appJs, /await decideAction\(decideBtn\.dataset\.decide, decideBtn\.dataset\.decision\)/);
});

test('кнопки решения лежат вне кнопки варианта: вложенных <button> быть не должно', () => {
  const card = /function variantsCardHtml\([\s\S]*?\n\}/.exec(appJs)[0];
  const openWrap = card.indexOf('<div class="pc-variant-wrap">');
  const openVariant = card.indexOf('<button class="pc-variant');
  const closeVariant = card.indexOf('</button>', openVariant);
  const actions = card.indexOf('${actionsHtml(vv, fresh)}');
  assert.ok(openWrap > -1 && openWrap < openVariant, 'кнопка варианта должна лежать в обёртке');
  assert.ok(actions > closeVariant, 'блок решений должен идти ПОСЛЕ закрытия кнопки варианта');
});

test('подпись статуса варианта берётся из живого поля status, а не из замороженной metrics.statusLabel', () => {
  assert.match(appJs, /const VARIANT_STATUS_LABELS = \{[\s\S]*needs_decision: 'требует вашего решения'/);
  assert.match(appJs, /function variantStatusLabel\(vv\) \{\s*return VARIANT_STATUS_LABELS\[vv\.status\]/);
  const card = /function variantsCardHtml\([\s\S]*?\n\}/.exec(appJs)[0];
  assert.ok(card.includes('esc(statusText)'), 'бейдж должен печатать вычисленную подпись');
  assert.ok(!/esc\(vv\.statusLabel \|\| vv\.status\)/.test(card), 'замороженная подпись из metrics больше не используется');
});

test('меню провайдеров полное, и порядок совпадает с сервером', () => {
  const menu = /const PROVIDER_MENU = \[[\s\S]*?\];/.exec(appJs)[0];
  const ids = [...menu.matchAll(/id: '([\w-]+)'/g)].map((m) => m[1]);
  assert.deepStrictEqual(ids, ['claude', 'chatgpt', 'kimi', 'gemini', 'gigachat', 'yandexgpt', 'lmstudio', 'ollama', 'demo']);
  const server = fs.readFileSync(path.join(__dirname, '..', 'server', 'services', 'providers.js'), 'utf8');
  const serverIds = [...server.matchAll(/id: '([\w-]+)', label:/g)].map((m) => m[1]);
  assert.deepStrictEqual(ids, serverIds, 'порядок пунктов обязан совпадать с серверным списком');
  assert.match(appJs, /const CLOUD_PROVIDERS = \[[^\]]*'gemini'/, 'Gemini — облачный провайдер');
  assert.match(appJs, /const CLOUD_PROVIDERS = \[[^\]]*'gigachat'/, 'GigaChat — облачный провайдер');
  assert.match(appJs, /const CLOUD_PROVIDERS = \[[^\]]*'yandexgpt'/, 'YandexGPT — облачный провайдер');
});

test('пустое название проекта не уходит на сервер молча', () => {
  const fn = /async function renameSession\([\s\S]*?\n\}/.exec(appJs)[0];
  assert.match(fn, /if \(!String\(res\.title \|\| ''\)\.trim\(\)\)/);
  assert.match(fn, /Название проекта не может быть пустым/);
  assert.match(fn, /toast\(err\.message, 'error'\)/, 'ошибку сервера тоже показываем, а не глотаем');
});

test('после отказа «Сначала выберите вариант» запуск перечитывается', () => {
  const fn = /async function stageAction\(act\)[\s\S]*?\n\}/.exec(appJs)[0];
  assert.match(fn, /if \(act\.startsWith\('variants'\)\) \{\s*state\.run = null;/);
});

/* ================= 5. устаревшие карточки согласования ================= */

test('живые кнопки — только у последней карточки своего вида', () => {
  assert.match(appJs, /lastCardAt\[c\.card\] = i/, 'нужно помнить индекс последней карточки каждого вида');
  assert.match(appJs, /cardHtml\(card, lastCardAt\[card\.card\] === i\)/);
  assert.match(appJs, /function cardActionsHtml\(fresh, buttons\)/);
  assert.match(appJs, /if \(!fresh\) return '<p class="pc-stale">/);
  assert.match(css, /\.pc-stale\s*\{/, 'устаревшей карточке нужен свой стиль');
});

/* ================= 6. кнопка «Анализ» ================= */

test('кнопка «Анализ» блокируется синхронно и не даёт второго платного прогона', () => {
  const handler = /\$\('btn-process'\)\.addEventListener\('click'[\s\S]*?\n  \}\);/.exec(appJs)[0];
  assert.match(handler, /if \(state\.processing\) return;/);
  assert.match(handler, /state\.processing = true;/);
  assert.match(handler, /\$\('btn-process'\)\.disabled = true;/);
  assert.match(handler, /state\.processing = false;/);
  assert.match(appJs, /\$\('btn-process'\)\.disabled = !has \|\| !v\.files\.length \|\| state\.processing/);
});

/* ================= 7. пустой запуск вариантов ================= */

test('пустой запуск вариантов не застревает на «Варианты загружаются…»', () => {
  const card = /function variantsCardHtml\([\s\S]*?\n\}/.exec(appJs)[0];
  assert.match(card, /if \(!run \|\| !Array\.isArray\(run\.variants\)\)/, '«загружаются» — только пока данных нет');
  assert.match(card, /if \(!run\.variants\.length\)/, 'у пустого запуска должна быть своя ветка');
  assert.match(card, /Подходящих вариантов посадки не найдено/);
  const empty = card.slice(card.indexOf('if (!run.variants.length)'));
  assert.ok(empty.includes('data-stage-act="variants-revise"'), 'из пустого запуска должен быть выход замечанием');
});

/* ================= 8. текст справки ================= */

test('в справке «Сравнение моделей» экран называется «Этап 1»', () => {
  assert.ok(!/на экране «Анализ»/.test(appJs), 'удалённого экрана «Анализ» в текстах быть не должно');
  assert.match(appJs, /на экране «Этап 1»/);
});

/* ================= 9. deviceId при первом входе ================= */

test('вход отправляет ID устройства, создавая его при первом заходе', () => {
  assert.match(authJs, /function ensureDeviceId\(\)/);
  assert.match(authJs, /const deviceId = ensureDeviceId\(\);/);
  assert.ok(!/localStorage\.getItem\('enso-pilot1-device'\)\s*\|\|\s*''/.test(authJs),
    'пустая строка вместо ID больше не отправляется');
  // ключ обязан совпадать с тем, что читает app.js
  assert.match(authJs, /const DEVICE_KEY = 'enso-pilot1-device';/);
  assert.match(appJs, /const DEVICE_KEY = 'enso-pilot1-device';/);
});

/* ================= 10. горячие клавиши в виджете вопросов ================= */

test('у вариантов ответа есть горячие клавиши 1..9, и номер отделён от текста', () => {
  assert.match(appJs, /data-hotkey="\$\{key\}"/);
  assert.match(appJs, /class="qw-opt-text"/, 'текст варианта должен жить в своём элементе');
  assert.match(appJs, /<span class="qw-num" aria-hidden="true">/, 'номер — это клавиша, читалке он не нужен');
  assert.match(appJs, /if \(!\/\^\[1-9\]\$\/\.test\(e\.key\)\) return;/);
  assert.match(appJs, /w\.querySelector\(`\.qw-opt\[data-hotkey="\$\{e\.key\}"\]`\)/);
  // в поле ввода и при открытом окне цифра остаётся обычным символом
  assert.match(appJs, /t\.tagName === 'INPUT' \|\| t\.tagName === 'TEXTAREA'/);
  assert.match(appJs, /!\$\('dialog-modal'\)\.hidden \|\| !\$\('info-modal'\)\.hidden/);
});

/* ================= 11. удаление выделения на плане ================= */

test('подсказка про удаление выделения подкреплена кнопкой в диалоге', () => {
  assert.match(viewerJs, /клик — изменить или удалить/);
  assert.match(viewerJs, /extraText: 'Удалить выделение'/);
  assert.match(viewerJs, /if \(res === 'extra'\) \{ await removeAnnotation\(id\); return; \}/);
  assert.match(html, /id="dialog-extra"/, 'третьей кнопке нужен свой узел в разметке');
  assert.match(appJs, /\$\('dialog-extra'\)\.addEventListener\('click', \(\) => closeDialog\('extra'\)\)/);
  assert.match(appJs, /\$\('dialog-extra'\)\.hidden = !extraText;/);
});

/* ================= 12. мёртвые правила CSS ================= */

test('правила от удалённой разметки убраны', () => {
  for (const sel of ['.btn-row', '.questions-block', '.q-status', '.q-text', '.q-why',
    '.q-answered', '.q-row', '.cl-provider', '.cl-warn']) {
    assert.ok(!new RegExp(`^\\${sel}[\\s,{]`, 'm').test(css), `правило ${sel} описывает несуществующий узел`);
  }
});

test('живые классы карточек согласования на месте', () => {
  for (const sel of ['.pc-actions', '.pc-variant', '.pc-decisions', '.qw-opt', '.compare-list']) {
    assert.ok(new RegExp(`\\${sel}[\\s,{.:]`).test(css), `правило ${sel} должно остаться`);
  }
});

/* ================= 13. единицы чертежа ================= */

test('клиент не показывает «код undefined (принято: метры)»', () => {
  assert.match(viewerJs, /function unitsLabel\(raw\)/);
  assert.match(viewerJs, /код\\s\+\(undefined\|null\|nan\)/);
  assert.match(viewerJs, /единицы: \$\{unitsLabel\(s\['единицы'\]\)\}/);
  assert.match(viewerJs, /coordinateSystem: unitsLabel\(/, 'в выделение тоже уходит человеческая формулировка');
});

/* ================= 4. штриховка зон ================= */

test('шаг штриховки задаётся в пикселях экрана и масштабируется', () => {
  const one = ZoneStyle.patternSvg('setback', 'zh-', 1);
  const ten = ZoneStyle.patternSvg('setback', 'zh-', 10);
  assert.match(one, /width="7" height="7"/);
  assert.match(ten, /width="70" height="70"/, 'шаг обязан расти вместе с масштабом');
  assert.match(ten, /stroke-width="14"/, 'толщина линии масштабируется вместе с шагом');
});

test('без масштаба образцы совпадают с прежними — серверный рендер PNG/PDF не меняется', () => {
  for (const kind of ZoneStyle.KINDS) {
    const z = ZoneStyle.zone(kind);
    const expected = `<pattern id="cs-${kind}" width="${z.spacing}" height="${z.spacing}" ` +
      `patternTransform="rotate(${z.angle})" patternUnits="userSpaceOnUse">` +
      `<line x1="0" y1="0" x2="0" y2="${z.spacing}" stroke="${z.color}" stroke-width="1.4" opacity=".85"/>` +
      '</pattern>';
    assert.strictEqual(ZoneStyle.patternSvg(kind, 'cs-'), expected, `образец ${kind} без масштаба должен быть прежним`);
  }
  assert.strictEqual(ZoneStyle.defs('cs-'), `<defs>${ZoneStyle.KINDS.map((k) => ZoneStyle.patternSvg(k, 'cs-')).join('')}</defs>`);
});

test('unitsPerPixel честно считает единицы плана на пиксель и не делит на ноль', () => {
  assert.strictEqual(ZoneStyle.unitsPerPixel(300, 150), 2);
  assert.strictEqual(ZoneStyle.unitsPerPixel(0, 150), 1);
  assert.strictEqual(ZoneStyle.unitsPerPixel(300, 0), 1);
  assert.strictEqual(ZoneStyle.unitsPerPixel(undefined, undefined), 1);
});

test('rescaleDefs пересчитывает уже вставленные образцы — при зуме сцена не пересобирается', () => {
  const nodes = {};
  for (const kind of ZoneStyle.KINDS) {
    const line = { attrs: {}, setAttribute(n, v) { this.attrs[n] = String(v); } };
    nodes[`#zh-${kind}`] = {
      attrs: {}, setAttribute(n, v) { this.attrs[n] = String(v); }, firstElementChild: line, line,
    };
  }
  const svg = { querySelectorAll() { return []; }, querySelector(sel) { return nodes[sel] || null; } };
  ZoneStyle.rescaleDefs(svg, 'zh-', 4);
  const z = ZoneStyle.zone('setback');
  assert.strictEqual(nodes['#zh-setback'].attrs.width, String(z.spacing * 4));
  assert.strictEqual(nodes['#zh-setback'].line.attrs.y2, String(z.spacing * 4));
  assert.strictEqual(nodes['#zh-setback'].line.attrs['stroke-width'], '5.6');
});

test('вьювер и миниатюры считают штриховку от размера на экране', () => {
  assert.match(viewerJs, /window\.ZoneStyle\.rescaleDefs\(state\.svg, 'zh-', px\)/, 'зум обязан пересчитывать штриховку');
  // Список зон уходит в defs третьим доводом: цвет штриховки принадлежит
  // объекту-источнику, а не типу ограничения. Четвёртым — группы показа:
  // когда зон много, план рисуется одной штриховкой на правило, и образец
  // нужен ещё и на группу.
  assert.match(viewerJs, /defs\('zh-', hatchScale\(\), zones, groups\)/);
  assert.match(viewerJs, /ZS\.unitsPerPixel\(span, o\.pxWidth \|\| 150\)/);
  assert.match(viewerJs, /function thumbPrefix\(scale\)/, 'у миниатюр разного масштаба должны быть разные id образцов');
  assert.ok(!/defs\('th-'/.test(viewerJs), 'общий префикс th- давал одну штриховку на все схемы документа');
});

/* ================= 14. версии ассетов ================= */

test('версии изменённых ассетов подняты', () => {
  const version = (name) => {
    const m = new RegExp(`${name.replace('.', '\\.')}\\?v=(\\d+)`).exec(html);
    assert.ok(m, `в index.html должен быть ${name}?v=`);
    return Number(m[1]);
  };
  assert.ok(version('styles.css') >= 41, 'styles.css правился — версия должна вырасти');
  assert.ok(version('app.js') >= 42, 'app.js правился — версия должна вырасти');
  assert.ok(version('auth.js') >= 3, 'auth.js правился — версия должна вырасти');
  assert.ok(version('viewer.js') >= 10, 'viewer.js правился — версия должна вырасти');
  assert.ok(version('zone-style.js') >= 2, 'zone-style.js правился — версия должна вырасти');
});

/* ================= просьбы владельца из прошлых кругов ================= */

test('значок «Настройки» — шестерёнка, а заголовок страницы полный', () => {
  const nav = /<button class="nav-item" data-screen="settings"[\s\S]*?<\/button>/.exec(html)[0];
  assert.match(nav, /<circle cx="12" cy="12" r="3\.1"\/>/, 'у шестерёнки должна быть втулка');
  assert.match(html, /<title>Enso-nexus — платформа автоматического проектирования<\/title>/);
});

test('«Извлечённые факты» — раскрывающийся список, а сайдбар убирается значком', () => {
  assert.match(html, /<details id="facts-card"[^>]*class="card card-fold"/);
  assert.match(html, /id="sidebar-toggle"/);
  assert.match(appJs, /\$\('sidebar-toggle'\)\.addEventListener\('click', toggleSidebar\)/);
});

test('страницы ошибок оформлены в стиле платформы', () => {
  for (const name of ['cf-5xx.html', 'cf-1xxx.html', 'landing.html']) {
    const page = fs.readFileSync(path.join(PUBLIC, 'error-pages', name), 'utf8');
    assert.match(page, /Enso-nexus/, `${name}: бренд обязателен`);
    assert.match(page, /--bg: #f3efe6/, `${name}: палитра платформы обязательна`);
    assert.match(page, /prefers-color-scheme: dark/, `${name}: тёмная тема обязательна`);
  }
});

/* ================= общие требования проекта ================= */

test('встроенных скриптов в index.html нет — CSP script-src \'self\'', () => {
  assert.ok(!/<script(?![^>]*\ssrc=)[^>]*>[\s\S]*?<\/script>/.test(html),
    'встроенный <script> запрещён политикой безопасности');
  assert.ok(!/\son(click|input|change|load|submit)=/.test(html), 'обработчиков в атрибутах быть не должно');
});
