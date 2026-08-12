'use strict';
/* Enso-nexus — client. Talks only to the same-origin backend API.
   Ключи localStorage сохраняют историческое имя enso-pilot1-*: переименование
   разлогинило бы пользователей и потеряло их настройки. */

const $ = (id) => document.getElementById(id);
const state = {
  session: null,          // {id, token}
  view: null,             // last session view from server
  health: null,           // last /health (providers, limits)
  polling: null,
  limits: null,
  uploading: false,
  progressClockOffset: 0,   // поправка часов клиента относительно сервера
  lastProgressUpdatedAt: 0, // updatedAt последнего учтённого обновления прогресса
  qwId: null,               // id вопроса, показанного в виджете уточнений
  qBatchTotal: 0,           // размер текущей пачки вопросов (для счётчика «2/4»)
  deviceId: '',             // ID устройства — к нему привязана история проектов
  deviceSessions: [],       // список сессий устройства (для сайдбара «Проекты»)
  offline: false,           // сервер недоступен (Mac выключен / нет связи)
  offlineTimer: null,       // таймер автопроверки связи
  plan: null,               // план участка для схем в карточках ленты
  run: null,                // последний запуск вариантов посадки
  cardsLoading: false,      // защита от повторной загрузки данных карточек
  processing: false,        // запрос на запуск анализа уже ушёл — второй платный прогон не нужен
};

/** Данные карточек привязаны к проекту: при смене проекта их надо забыть. */
function resetCardData() {
  state.plan = null;
  state.run = null;
  state.cardsLoading = false;
}

const DEVICE_KEY = 'enso-pilot1-device';
const LS_KEY = 'enso-pilot1-session';
const THEME_KEY = 'enso-pilot1-theme';
const LOG_OPEN_KEY = 'enso-pilot1-log-open';   // «Журнал этапов»: состояние управляет только пользователь

/* ---------------- боковая панель ----------------
   Сворачивается значком, как в Claude Code: состояние применяется до первой
   отрисовки, поэтому панель не «моргает» свёрнутой при каждой перезагрузке. */
const SIDEBAR_KEY = 'enso-pilot1-sidebar';

function applySidebar(collapsed) {
  const shell = $('shell');
  const btn = $('sidebar-toggle');
  if (!shell || !btn) return;
  shell.classList.toggle('sidebar-collapsed', collapsed);
  btn.setAttribute('aria-expanded', String(!collapsed));
  btn.setAttribute('aria-label', collapsed ? 'Развернуть боковую панель' : 'Свернуть боковую панель');
  btn.title = `${collapsed ? 'Развернуть' : 'Свернуть'} панель (⌘\\ или Ctrl+\\)`;
}
applySidebar(localStorage.getItem(SIDEBAR_KEY) === '1');

function toggleSidebar() {
  const collapsed = !$('shell').classList.contains('sidebar-collapsed');
  localStorage.setItem(SIDEBAR_KEY, collapsed ? '1' : '0');
  applySidebar(collapsed);
  // меню проекта прибито к координатам кнопки, а она уезжает вместе с панелью.
  // Закрываем здесь, а не в applySidebar: та вызывается ещё до объявления
  // closeSessMenu и уронила бы весь скрипт — страница осталась бы пустой.
  closeSessMenu();
}

/* ---------------- плашки-предупреждения ----------------
   Плашки лежат стопкой в контейнере #banners и накрыли бы верх приложения,
   поэтому их суммарная высота уезжает в --banners-h: на неё сдвигаются
   сайдбар, содержимое и значок панели (см. styles.css). Высота меняется не
   только при показе плашки, но и при переносе строк на узком экране —
   отсюда ResizeObserver, а не разовый замер. */
function measureBanners() {
  const box = $('banners');
  if (!box) return;
  const h = Math.round(box.getBoundingClientRect().height);
  document.documentElement.style.setProperty('--banners-h', `${h}px`);
}

function watchBanners() {
  const box = $('banners');
  if (!box) return;
  measureBanners();
  if (typeof ResizeObserver === 'function') new ResizeObserver(measureBanners).observe(box);
  else window.addEventListener('resize', measureBanners);
}

/** Показать или скрыть плашку и сразу пересчитать высоту стопки. */
function setBanner(id, show) {
  const el = $(id);
  if (!el || el.hidden === !show) return;
  el.hidden = !show;
  measureBanners();
}

/* ---------------- тема оформления ---------------- */
const THEME_META_COLORS = { light: '#f3efe6', dark: '#201c17' };

function syncThemeColor() {
  const meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) return;
  const stored = localStorage.getItem(THEME_KEY) || 'auto';
  const dark = stored === 'dark' ||
    (stored === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  meta.content = dark ? THEME_META_COLORS.dark : THEME_META_COLORS.light;
}

function applyTheme(mode) {
  if (mode === 'light' || mode === 'dark') document.documentElement.dataset.theme = mode;
  else delete document.documentElement.dataset.theme;
  const seg = $('theme-seg');
  if (seg) {
    for (const b of seg.querySelectorAll('button[data-theme]')) {
      b.setAttribute('aria-checked', String(b.dataset.theme === mode));
    }
  }
  syncThemeColor();
}
applyTheme(localStorage.getItem(THEME_KEY) || 'auto');
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', syncThemeColor);

/* ---------------- API ---------------- */
// статусы Cloudflare, означающие «туннель/сервер не отвечает» (машина выключена и т.п.)
const GATEWAY_DOWN = new Set([502, 503, 504, 520, 521, 522, 523, 524, 530]); // 530 = Cloudflare 1033, туннель не подключён

/** Режим «сервер недоступен»: плашка + автопроверка связи каждые 10 с. */
function setOffline(on) {
  if (state.offline === on) return;
  state.offline = on;
  setBanner('offline-banner', on);
  if (on && !state.offlineTimer) {
    state.offlineTimer = setInterval(async () => {
      try {
        const r = await fetch('/api/health', { cache: 'no-store' });
        if (r.ok) {
          clearInterval(state.offlineTimer);
          state.offlineTimer = null;
          setOffline(false);
          toast('Связь с сервером восстановлена');
          loadHealth().catch(() => {});
          refresh().catch(() => {});
          loadDeviceSessions().catch(() => {});
        }
      } catch { /* всё ещё недоступен — ждём следующей проверки */ }
    }, 10000);
  }
}

async function api(path, options = {}) {
  const headers = Object.assign({}, options.headers);
  if (state.session) headers.Authorization = `Bearer ${state.session.token}`;
  // токен человека идёт ОТДЕЛЬНЫМ заголовком: в Authorization уже живёт токен
  // проекта, и смешивать два разных ключа в одном месте нельзя
  if (window.Auth && window.Auth.token) headers['X-User-Token'] = window.Auth.token;
  if (options.json !== undefined) {
    headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(options.json);
  }
  let res;
  try {
    res = await fetch(`/api${path}`, { ...options, headers });
  } catch (err) {
    // сеть не ответила вовсе — сервер выключен или нет интернета
    setOffline(true);
    const e = new Error('Сервер сейчас недоступен — проверяем связь, попробуйте чуть позже');
    e.offline = true;
    throw e;
  }
  if (GATEWAY_DOWN.has(res.status)) {
    setOffline(true);
    const e = new Error('Сервер сейчас недоступен — проверяем связь, попробуйте чуть позже');
    e.offline = true;
    e.status = res.status;
    throw e;
  }
  if (state.offline) setOffline(false); // сервер ответил — связь есть
  let data = null;
  try { data = await res.json(); } catch { /* downloads etc. */ }
  if (!res.ok) {
    const message = (data && data.error) || `Ошибка сервера (${res.status})`;
    const err = new Error(message);
    err.status = res.status;
    // вход истёк или снят — возвращаем человека на экран входа, а не сыплем ошибками
    if (data && data.needLogin) { localStorage.removeItem('enso-pilot1-auth'); location.reload(); }
    throw err;
  }
  return data;
}

/** Заголовки доступа: токен проекта и токен человека вместе. */
function authHeaders(sessionToken) {
  const h = {};
  if (sessionToken) h.Authorization = `Bearer ${sessionToken}`;
  if (window.Auth && window.Auth.token) h['X-User-Token'] = window.Auth.token;
  return h;
}

/* ---------------- стилизованные диалоги (вместо prompt/confirm) ---------------- */
let dialogResolve = null;

/**
 * Диалог в стиле приложения. fields: [{key, label, value, placeholder, maxLength}].
 * Без fields — это подтверждение (message + кнопки).
 * Возвращает объект значений по key либо null при отмене.
 * `extraText` добавляет третью, разрушающую кнопку; её нажатие возвращает
 * строку 'extra' — так удаление живёт в том же окне, где правка.
 */
function appDialog({
  title, message = '', fields = [], confirmText = 'ОК', cancelText = 'Отмена', danger = false, extraText = '',
}) {
  return new Promise((resolve) => {
    if (dialogResolve) dialogResolve(null); // предыдущий незакрытый диалог — отменяем
    dialogResolve = resolve;
    $('dialog-title').textContent = title;
    $('dialog-message').textContent = message;
    $('dialog-message').hidden = !message;
    const wrap = $('dialog-fields');
    wrap.innerHTML = '';
    for (const [i, f] of fields.entries()) {
      const label = document.createElement('label');
      const caption = document.createElement('span');
      caption.textContent = f.label;
      const input = document.createElement('input');
      input.type = 'text';
      input.value = f.value || '';
      input.maxLength = f.maxLength || 120;
      if (f.placeholder) input.placeholder = f.placeholder;
      input.dataset.key = f.key || String(i);
      label.append(caption, input);
      wrap.appendChild(label);
    }
    wrap.hidden = !fields.length;
    $('dialog-ok').textContent = confirmText;
    $('dialog-cancel').textContent = cancelText;
    $('dialog-extra').textContent = extraText;
    $('dialog-extra').hidden = !extraText;
    $('dialog-ok').classList.toggle('btn-danger', danger);
    $('dialog-ok').classList.toggle('btn-primary', !danger);
    $('dialog-modal').hidden = false;
    const first = wrap.querySelector('input');
    if (first) { first.focus(); first.select(); } else $('dialog-ok').focus();
  });
}

function closeDialog(result) {
  $('dialog-modal').hidden = true;
  if (dialogResolve) { dialogResolve(result); dialogResolve = null; }
}

function dialogValues() {
  const out = {};
  for (const inp of $('dialog-fields').querySelectorAll('input')) out[inp.dataset.key] = inp.value.trim();
  return out;
}

/* ---------------- устройство и список проектов ---------------- */
function ensureDevice() {
  let d = localStorage.getItem(DEVICE_KEY);
  if (!d) {
    d = crypto.randomUUID();
    localStorage.setItem(DEVICE_KEY, d);
  }
  state.deviceId = d;
}

/** Список сессий устройства для сайдбара «Проекты». */
async function loadDeviceSessions() {
  if (!state.deviceId) return;
  try {
    const data = await api(`/devices/${state.deviceId}/sessions`);
    state.deviceSessions = data.sessions || [];
    renderSessionsList();
  } catch (err) { console.warn('[projects]', err.message); }
}

/* Статус проекта — цветная точка того же семейства, что индикатор нейросети
   внизу сайдбара. Эмодзи (⏳ ❓ ✓ ⚠) убраны: они рисуются шрифтом системы,
   выпадают из типографики и в тёмной теме светятся своим цветом. */
const SESS_STATUS = {
  queued: 'в очереди',
  running: 'выполняется',
  needs_clarification: 'есть вопросы',
  awaiting_approval: 'ждёт решения',
  completed: 'завершена',
  failed: 'ошибка',
};

function renderSessionsList() {
  const items = state.deviceSessions.map((s) => {
    const active = state.session && s.id === state.session.id;
    const date = new Date(s.updatedAt || s.createdAt).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
    const status = SESS_STATUS[s.jobStatus] || '';
    const meta = [date, s.files ? `файлов: ${s.files}` : '', status].filter(Boolean).join(' · ');
    return `<li class="sess-item${active ? ' active' : ''}" data-sess="${s.id}">
      <span class="sess-title">${esc(s.title || 'Новый проект')}</span>
      <span class="sess-meta"><span class="sess-dot" data-status="${esc(s.jobStatus || 'idle')}"
            aria-hidden="true"></span>${esc(meta)}</span>
      <button class="sess-more" type="button" data-more="${s.id}" tabindex="-1"
              aria-label="Действия с проектом ${esc(s.title || 'Новый проект')}" title="Действия">⋮</button></li>`;
  });
  syncList($('sessions-list'), items);
}

async function switchSession(id) {
  const s = state.deviceSessions.find((x) => x.id === id);
  if (!s || (state.session && state.session.id === id)) return;
  state.session = { id: s.id, token: s.token };
  localStorage.setItem(LS_KEY, JSON.stringify(state.session));
  state.qwId = null;
  state.qBatchTotal = 0;
  resetCardData();
  await refresh();
  renderSessionsList();
}

async function renameSession(id) {
  const s = state.deviceSessions.find((x) => x.id === id);
  if (!s) return;
  const res = await appDialog({
    title: 'Название проекта',
    fields: [{ key: 'title', label: 'Как назвать проект', value: s.title || '', placeholder: 'Например: Школа в Горбунках', maxLength: 120 }],
    confirmText: 'Сохранить',
  });
  if (res === null) return;
  // пустое название сервер отвергает с 400: не отправляем его вовсе и говорим,
  // в чём дело, — иначе безымянный проект не отличить от соседнего
  if (!String(res.title || '').trim()) {
    toast('Название проекта не может быть пустым', 'error');
    return;
  }
  try {
    const r = await fetch(`/api/sessions/${id}/settings`, {
      method: 'POST',
      headers: { ...authHeaders(s.token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: res.title }),
    });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Не удалось переименовать проект');
    await loadDeviceSessions();
  } catch (err) { toast(err.message, 'error'); }
}

/* ---------------- меню проекта: «⋮», двойной клик, долгое нажатие, свайп ---------------- */
let sessMenuFor = null;

function openSessMenu(id, anchor) {
  const menu = $('sess-menu');
  sessMenuFor = id;
  menu.hidden = false; // сначала показать, потом мерить: у скрытого нет размеров
  const r = anchor.getBoundingClientRect();
  const top = Math.min(r.bottom + 4, window.innerHeight - menu.offsetHeight - 8);
  const left = Math.min(r.left, window.innerWidth - menu.offsetWidth - 8);
  menu.style.top = `${Math.max(8, top)}px`;
  menu.style.left = `${Math.max(8, left)}px`;
  menu.querySelector('.sess-menu-item').focus();
}

function closeSessMenu() {
  sessMenuFor = null;
  $('sess-menu').hidden = true;
  document.querySelectorAll('.sess-item.swiped').forEach((el) => el.classList.remove('swiped'));
}

function initSessionsList() {
  const list = $('sessions-list');

  list.addEventListener('click', (e) => {
    const more = e.target.closest('[data-more]');
    if (more) { e.stopPropagation(); openSessMenu(more.dataset.more, more); return; }
    const li = e.target.closest('.sess-item');
    if (li) switchSession(li.dataset.sess).catch((err) => toast(err.message, 'error'));
  });
  list.addEventListener('dblclick', (e) => {
    const li = e.target.closest('.sess-item');
    if (li) openSessMenu(li.dataset.sess, li);
  });

  // touch: долгое нажатие открывает меню, свайп влево обнажает «⋮».
  // Сам жест ничего не удаляет — нужно ещё нажать пункт меню.
  let touch = null;
  list.addEventListener('touchstart', (e) => {
    const li = e.target.closest('.sess-item');
    if (!li) return;
    touch = { li, x: e.touches[0].clientX, y: e.touches[0].clientY, moved: false };
    touch.timer = setTimeout(() => { if (touch && !touch.moved) openSessMenu(li.dataset.sess, li); }, 500);
  }, { passive: true });
  list.addEventListener('touchmove', (e) => {
    if (!touch) return;
    const dx = e.touches[0].clientX - touch.x;
    const dy = e.touches[0].clientY - touch.y;
    if (Math.abs(dx) > 8 || Math.abs(dy) > 8) { touch.moved = true; clearTimeout(touch.timer); }
    if (dx < -40 && Math.abs(dy) < 30) touch.li.classList.add('swiped');
    if (dx > 20) touch.li.classList.remove('swiped');
  }, { passive: true });
  list.addEventListener('touchend', () => { if (touch) clearTimeout(touch.timer); touch = null; }, { passive: true });

  $('sess-menu').addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]');
    if (!act || !sessMenuFor) return;
    const id = sessMenuFor;
    closeSessMenu();
    if (act.dataset.act === 'rename') renameSession(id);
    if (act.dataset.act === 'delete') deleteSession(id).catch((err) => toast(err.message, 'error'));
  });
  document.addEventListener('click', (e) => {
    if (!$('sess-menu').hidden && !e.target.closest('#sess-menu') && !e.target.closest('[data-more]')) closeSessMenu();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSessMenu(); });
  window.addEventListener('resize', closeSessMenu);
}

/* ---------------- session lifecycle ---------------- */
async function newSession() {
  const created = await api('/sessions', { method: 'POST', json: { deviceId: state.deviceId } });
  state.session = { id: created.id, token: created.token };
  localStorage.setItem(LS_KEY, JSON.stringify(state.session));
  state.qwId = null;
  state.qBatchTotal = 0;
  resetCardData();
  await refresh();
  loadDeviceSessions().catch(() => {});
  toast('Создан новый проект');
}

async function restoreOrCreate() {
  ensureDevice();
  const saved = localStorage.getItem(LS_KEY);
  if (saved) {
    try {
      state.session = JSON.parse(saved);
      await refresh();
      // привязать сессию к устройству (миграция старых сессий) и показать список
      api(`/sessions/${state.session.id}/device`, { method: 'POST', json: { deviceId: state.deviceId } })
        .then(() => loadDeviceSessions()).catch(() => loadDeviceSessions());
      return;
    } catch (err) {
      if (err.status !== 404) console.warn(err);
      state.session = null;
      localStorage.removeItem(LS_KEY);
    }
  }
  // история по ID устройства: если на устройстве уже есть проекты — открываем последний
  await loadDeviceSessions();
  if (state.deviceSessions.length) {
    await switchSession(state.deviceSessions[0].id);
    return;
  }
  await newSession();
}

/** Удаление проекта: из меню (любой проект по id) или текущего, если id не задан. */
async function deleteSession(id = null) {
  const target = id || (state.session && state.session.id);
  if (!target) return;
  const listed = state.deviceSessions.find((x) => x.id === target);
  const ok = await appDialog({
    title: `Удалить проект${listed && listed.title ? ` «${listed.title}»` : ''}?`,
    message: 'Проект будет удалён вместе со всеми файлами, перепиской и результатами. Действие необратимо (копии итоговых отчётов останутся в архиве прогонов на сервере).',
    confirmText: 'Удалить',
    danger: true,
  });
  if (ok === null) return;
  const token = (state.session && state.session.id === target)
    ? state.session.token
    : (listed && listed.token);
  try {
    const res = await fetch(`/api/sessions/${target}`, { method: 'DELETE', headers: authHeaders(token) });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      toast(data.error || `Не удалось удалить проект (${res.status})`, 'error');
      return;
    }
  } catch (err) {
    toast('Сервер не ответил — проект не удалён', 'error');
    return;
  }

  // удалили чужой проект — текущий остаётся открытым, обновляем только список
  if (state.session && state.session.id !== target) {
    await loadDeviceSessions();
    toast('Проект удалён');
    return;
  }
  localStorage.removeItem(LS_KEY);
  state.session = null;
  state.view = null;
  await loadDeviceSessions();
  if (state.deviceSessions.length) {
    await switchSession(state.deviceSessions[0].id);
    toast('Проект удалён — открыт предыдущий');
  } else {
    await newSession();
    toast('Проект удалён, создан новый');
  }
}

function startNewSession() {
  localStorage.removeItem(LS_KEY);
  state.session = null;
  newSession().catch((err) => toast(err.message, 'error'));
}

async function cancelJob() {
  const btns = [$('btn-cancel-job')];
  btns.forEach((b) => { b.disabled = true; });
  try {
    await api(`/sessions/${state.session.id}/cancel`, { method: 'POST', json: {} });
    toast('Обработка прерывается…');
  } catch (err) {
    toast(err.message, 'error');
    btns.forEach((b) => { b.disabled = false; });
  }
}

/* ---------------- rendering ---------------- */
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* minimal safe markdown: headings, bold, italics, code, lists, paragraphs */
function md(text) {
  const lines = esc(text).split('\n');
  let html = '', inList = false;
  const inline = (s) => s
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|\s)\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
  for (const raw of lines) {
    const line = raw.trimEnd();
    const h = line.match(/^(#{1,4})\s+(.*)/);
    const li = line.match(/^[-*]\s+(.*)/);
    if (li) {
      if (!inList) { html += '<ul>'; inList = true; }
      html += `<li>${inline(li[1])}</li>`;
      continue;
    }
    if (inList) { html += '</ul>'; inList = false; }
    if (h) html += `<h${h[1].length + 2}>${inline(h[2])}</h${h[1].length + 2}>`;
    else if (line.trim()) html += `<p>${inline(line)}</p>`;
  }
  if (inList) html += '</ul>';
  return html;
}

const STATUS_LABELS = {
  idle: 'Ожидает данных',
  queued: 'Задача в очереди…',
  running: 'Выполняется анализ…',
  needs_clarification: 'Требуется уточнение — ответьте на вопросы',
  awaiting_approval: 'Ждёт вашего решения в диалоге',
  completed: 'Задача завершена',
  failed: 'Произошла ошибка',
};
const KIND_LABELS = { comment: 'комментарий', answer: 'ответ на вопрос', error: 'ошибка' };

function fmtSize(bytes) {
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} МБ`;
  return `${Math.max(1, Math.round(bytes / 1024))} КБ`;
}

/** Обновляет innerHTML только при реальном изменении разметки: опрос каждые 1,2 с
 * пересоздаёт узлы, из-за чего перезапускаются CSS-анимации (item-in, msg-in)
 * и списки мигают. Возвращает true, если DOM был перестроен. */
function setHTML(el, html) {
  if (el.__html === html) return false;
  el.__html = html;
  el.innerHTML = html;
  return true;
}

/** Переносит атрибуты корневого узла записи: класс, data-*, aria-* и прочее.
 * Без этого обновление «по месту» меняло только содержимое, а атрибуты
 * оставались от прежней записи — строка проекта показывала одно название,
 * а `data-sess` на ней указывал на другой проект, и клик открывал не тот. */
function syncAttrs(cur, want) {
  for (const attr of want.attributes) {
    if (cur.getAttribute(attr.name) !== attr.value) cur.setAttribute(attr.name, attr.value);
  }
  for (const name of cur.getAttributeNames()) {
    if (!want.hasAttribute(name)) cur.removeAttribute(name);
  }
}

/** Инкрементальное обновление списка (items — массив HTML-строк, по одному
 * корневому элементу на запись): неизменённые узлы не трогаем; изменённые
 * с тем же тегом обновляем по месту вместе с атрибутами — узел не
 * пересоздаётся, и CSS-анимация появления не перезапускается;
 * новые добавляем в конец. Возвращает true, если DOM менялся. */
const listTmp = document.createElement('div');
function syncList(el, items) {
  const prev = el.__items || [];
  let changed = false;
  while (el.children.length > items.length) { el.removeChild(el.lastElementChild); changed = true; }
  for (let i = 0; i < items.length; i++) {
    if (prev[i] === items[i] && el.children[i]) continue;
    listTmp.innerHTML = items[i];
    const want = listTmp.firstElementChild;
    if (!want) continue;
    const cur = el.children[i];
    if (!cur) el.appendChild(want);
    else if (cur.tagName === want.tagName) {
      syncAttrs(cur, want);
      if (cur.innerHTML !== want.innerHTML) cur.innerHTML = want.innerHTML;
    } else cur.replaceWith(want);
    changed = true;
  }
  el.__items = items;
  return changed;
}

function render() {
  const v = state.view;
  const has = !!v;
  // state.processing закрывает окно между нажатием и ответом сервера: без него
  // четыре быстрых клика давали четыре платных прогона
  $('btn-process').disabled = !has || !v.files.length || state.processing
    || ['queued', 'running'].includes(v.jobStatus);
  // Писать можно всегда, даже пока идёт анализ: сообщение сразу попадает
  // в ленту, а ответ приходит, как только освободится очередь.
  $('chat-input').disabled = !has;
  $('btn-send').disabled = !has;
  $('chat-hint').textContent = chatHint(v);
  updateAiBadge();
  renderProgress();
  if (!has) return;

  // строка активного проекта в сайдбаре: свежие название и статус без запроса
  const mine = state.deviceSessions.find((x) => x.id === v.id);
  if (mine && (mine.title !== v.title || mine.jobStatus !== v.jobStatus)) {
    mine.title = v.title;
    mine.jobStatus = v.jobStatus;
    renderSessionsList();
  }

  // files
  syncList($('file-list'), v.files.map((f) => `
    <li class="file-item">
      <span class="file-ext">${esc(f.ext)}</span>
      <span class="name">${esc(f.name)}<br><span class="meta">${fmtSize(f.size)} · загружен</span></span>
      <button class="icon-btn" data-del-file="${f.id}" aria-label="Удалить файл ${esc(f.name)}" title="Удалить">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 7h16M10 11v6m4-6v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>
      </button>
    </li>`));

  // настройки анализа (каскад: провайдер → модель)
  const busy = ['queued', 'running'].includes(v.jobStatus);
  $('sel-provider').disabled = busy;
  $('sel-model').disabled = busy || !$('sel-provider').value;
  $('sel-kb').disabled = busy || !$('sel-kb').options.length;
  updateCompareButton();
  const pickerFocused = [$('sel-provider'), $('sel-model')].includes(document.activeElement);
  if (v.settings && !pickerFocused) {
    const cur = currentPick();
    if (cur.provider !== (v.settings.aiProvider || '') || cur.model !== (v.settings.aiModel || '')) {
      setModelSelect(v.settings.aiProvider || '', v.settings.aiModel || '');
    }
  }
  if (v.settings && document.activeElement !== $('sel-kb')) {
    $('sel-kb').value = v.settings.kbChoice || 'main';
  }
  // подписи в свёрнутых заголовках берут действующую связку из view.ai,
  // а он приходит позже /health — обновляем на каждом рендере
  updateSettingsValues();

  // этапы работы (стандартные или загруженный Excel).
  // Подпись показывается только для пользовательского файла: у стандартного
  // порядка название дублировало бы заголовок карточки.
  const wp = v.workplan;
  if (wp && wp.steps) {
    $('workplan-name').hidden = !!wp.isDefault;
    $('workplan-name').textContent = wp.isDefault ? '' : `Загружен пользовательский: ${wp.name}`;
    $('btn-workplan-reset').hidden = !!wp.isDefault;
    $('btn-workplan-upload').disabled = busy;
    $('btn-workplan-reset').disabled = busy;
    syncList($('workplan-steps'), wp.steps.map((s) => `
      <li><strong>${esc(s.n)}. ${esc(s.title)}</strong>${s.detail ? ` — ${esc(s.detail)}` : ''}${s.norms ? ` <span class="meta">[${esc(s.norms)}]</span>` : ''}</li>`));
  }

  // status + events
  $('job-status').dataset.status = v.jobStatus;
  $('job-status').textContent = STATUS_LABELS[v.jobStatus] || v.jobStatus;

  // расход сессии: входные/выходные токены и стоимость (облачные модели платные, локальные — нет)
  const u = v.usage;
  if (u && (u.inputTokens > 0 || u.outputTokens > 0)) {
    const cost = u.costUsd > 0
      ? `стоимость ≈ $${u.costUsd.toFixed(u.costUsd < 0.1 ? 4 : 2)}`
      : 'бесплатно';
    $('usage-line').textContent =
      `Токены за сессию: ↑ ${u.inputTokens.toLocaleString('ru-RU')} входных · ` +
      `↓ ${u.outputTokens.toLocaleString('ru-RU')} выходных · ${cost}` +
      // служебные запросы показываются отдельно: они не расходуют лимит проекта,
      // но за них платят, и «запросов: 3» при семнадцати распознанных страницах врёт
      (u.aiRequests ? ` · запросов: ${u.aiRequests}` : '') +
      (u.aiSubrequests ? ` (+${u.aiSubrequests} служебных)` : '');
    $('usage-line').hidden = false;
  } else {
    $('usage-line').hidden = true;
  }
  // журнал строится снизу вверх: новые события приходят с сервера первыми;
  // раскрытием блока управляет только пользователь (см. init) — опрос его не трогает
  syncList($('events-log'), v.events.map((e) => `
    <li class="ev-${e.level}">${esc(e.stage)}${e.detail ? ` — ${esc(e.detail)}` : ''}
      <span class="meta">(${new Date(e.created_at).toLocaleTimeString('ru-RU')})</span></li>`));

  // chat (прокрутка — по контейнеру #chat, сообщения — в #chat-messages);
  // у проекта одна лента: отдельных чатов-тредов больше нет
  const chatEl = $('chat');
  const nearBottom = chatEl.scrollHeight - chatEl.scrollTop - chatEl.clientHeight < 80;
  // Комментарии больше не прячутся: отдельного поля для них нет, и замечание
  // к этапу обязано быть видно там же, где на него отвечают.
  const msgs = v.messages;
  // сколько последних реплик человека ещё ждут ответа — их помечаем в ленте
  const pendingFrom = v.pendingChats > 0 ? msgs.length - v.pendingChats : msgs.length;
  const emptyText = 'Это лента проекта. Здесь можно спрашивать помощника, писать указания к исходным данным ' +
    'и согласовывать схему зон и варианты посадки — всё в одном разговоре.';
  // у каждого вида карточки живая — только последняя: после замечания приходит
  // новая, а на прежней оставались рабочие кнопки со старыми цифрами
  const lastCardAt = {};
  msgs.forEach((m, i) => { const c = cardOf(m); if (c) lastCardAt[c.card] = i; });
  const msgItems = msgs.length ? msgs.map((m, i) => {
    const card = cardOf(m);
    if (card) {
      // карточка согласования: схема, метрики и кнопки прямо в ленте
      return `<div class="msg msg-assistant msg-card"><h3 class="msg-card-title">${esc(CARD_TITLES[card.card] || '')}</h3>${cardHtml(card, lastCardAt[card.card] === i)}</div>`;
    }
    const cls = m.kind === 'error' ? 'msg-error' : m.role === 'user' ? 'msg-user' : 'msg-assistant';
    const kind = KIND_LABELS[m.kind] ? `<span class="msg-kind">${KIND_LABELS[m.kind]}</span>` : '';
    const waiting = m.role === 'user' && m.kind === 'chat' && i >= pendingFrom
      ? '<span class="msg-waiting">ждёт ответа</span>' : '';
    return `<div class="msg ${cls}">${kind}${md(m.content)}${waiting}</div>`;
  }) : [`<p class="msg-empty">${emptyText}</p>`];
  const chatChanged = syncList($('chat-messages'), msgItems);
  ensureCardData(v).catch(() => {});

  // уточняющие вопросы — компактный виджет над полем ввода (по одному за раз)
  renderQuestionWidget(v);
  if (chatChanged && nearBottom) chatEl.scrollTop = chatEl.scrollHeight;

  // results
  $('results-empty').hidden = v.results.length > 0;
  syncList($('results-list'), v.results.map((r) => `
    <li class="result-item">
      <span class="file-ext">${esc(r.format)}</span>
      <span class="name">${esc(r.filename)}<br><span class="meta">${esc(r.title)} · ${fmtSize(r.size)}</span></span>
      <button class="icon-btn dl" data-download="${r.id}" data-name="${esc(r.filename)}"
              aria-label="Скачать ${esc(r.filename)}" title="Скачать">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 4v12m0 0l-5-5m5 5l5-5M4 20h16"/></svg>
      </button>
    </li>`));

  // facts
  $('facts-card').hidden = v.facts.length === 0;
  $('facts-count').textContent = v.facts.length ? String(v.facts.length) : '';
  syncList($('facts-list'), v.facts.map((f) =>
    `<div><dt>${esc(f.key)}</dt><dd>${esc(f.value)}${f.source ? ` <span class="meta">(${esc(f.source)})</span>` : ''}</dd></div>`));
}

/* ---------------- карточки согласования в ленте ----------------
   План участка живёт не отдельной вкладкой, а карточкой в диалоге: система
   показывает схему там же, где разговаривает, и ждёт «согласовано» или
   замечания. Полный разбор — по клику, на весь экран. */

/** Тело карточки: сервер кладёт в сообщение JSON, а не текст. */
function cardOf(message) {
  if (message.kind !== 'card') return null;
  try {
    const data = JSON.parse(message.content);
    return data && data.card ? data : null;
  } catch { return null; }
}

/** Штриховка типа зоны для легенды — те же цвет и угол, что и на плане. */
function swatchStyle(kind) {
  const z = window.ZoneStyle.zone(kind);
  const step = Math.max(4, z.spacing);
  return `background: repeating-linear-gradient(${z.angle}deg, ${z.color} 0 1.5px, transparent 1.5px ${step}px);` +
    `border: 1px solid ${z.color}`;
}

const EXPAND_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">' +
  '<path d="M9 4H4v5M15 20h5v-5M20 9V4h-5M4 15v5h5" stroke-linecap="round" stroke-linejoin="round"/></svg>';

/** Схема участка как «чертёжный лист» с кнопкой разворота. */
function sheetHtml(footprint) {
  const svg = state.plan ? window.PlanViewer.thumbSvg({ plan: state.plan, footprint }) : '';
  if (!svg) return '<p class="pc-note">Схема появится, когда план участка будет разобран.</p>';
  return `<button class="pc-sheet" type="button" data-open-plan="1" aria-label="Открыть план на весь экран">
    ${svg}<span class="pc-expand" aria-hidden="true">${EXPAND_ICON}</span></button>`;
}

/** Блок кнопок карточки согласования или объяснение, почему их нет.
 * Кнопки живут ТОЛЬКО на последней карточке своего вида: после замечания
 * в ленту приходит новая карточка, а на старой оставались рабочие
 * «Согласовать»/«Замечания» — человек соглашался, глядя на прежние цифры. */
function cardActionsHtml(fresh, buttons) {
  if (!fresh) return '<p class="pc-stale">Карточка устарела: ниже в ленте есть свежая, решение принимается там.</p>';
  return `<div class="pc-actions">${buttons}</div>`;
}

/**
 * «Что стоит указать вручную» — отдельный блок карточки согласования.
 *
 * Это не предупреждения и не ошибки: это работа, которую платформа сделать не
 * может, а человек делает двумя кликами по плану. Раньше всё это лежало
 * россыпью среди причин непостроенных зон, и разница между «свободно 286 м²»
 * и «свободно 1582 м²» пряталась в строке «уточнение не совпало ни с одним
 * слоем». У каждого пункта своя цена в метрах — совет без цены пролистывают.
 */
function manualHintsHtml(hints) {
  if (!hints || !hints.length) return '';
  const items = hints.slice(0, 4).map((h) => {
    const gain = h.gainM2 ? `<b class="mh-gain">${h.gainM2} м²</b> ` : '';
    const open = h.objectIds && h.objectIds.length
      ? ` <button class="mh-open" type="button" data-open-plan="1" data-focus="${esc(h.objectIds.join(','))}">показать на плане</button>`
      : ' <button class="mh-open" type="button" data-open-plan="1">открыть план</button>';
    return `<li>${gain}${esc(h.text)}${open}</li>`;
  }).join('');
  return `<div class="pc-hints">
    <p class="pc-hints-head">Что стоит указать вручную — платформа этого знать не может</p>
    <ul class="pc-hints-list">${items}</ul>
  </div>`;
}

/**
 * Образец конкретного объекта: угол штриховки — от типа ограничения,
 * цвет — от объекта. Тот же цвет ложится на план, в отчёт и в чертёж.
 */
function sourceSwatchStyle(kind, color) {
  const z = window.ZoneStyle.zone(kind);
  const step = Math.max(4, z.spacing);
  return `background: repeating-linear-gradient(${z.angle}deg, ${color} 0 1.5px, transparent 1.5px ${step}px);` +
    `border: 1px solid ${color}`;
}

function zonesCardHtml(data, fresh) {
  const zones = data.zones || [];
  /*
   * Легенда карточки — ПО ОБЪЕКТАМ, если сервер их прислал.
   *
   * Перечень типов («охранная зона · 958 м²») не отвечает на вопрос, который
   * человек задаёт, глядя на схему: что убрать, чтобы места стало больше.
   * Убрать можно только объект, поэтому строка легенды — объект: его цвет,
   * его имя, какие зоны он даёт и во сколько метров участка обходится.
   * Старые карточки в ленте останутся с прежней легендой по типам — тело
   * карточки заморожено на момент отправки, и это правильно.
   */
  const sources = data.sources || [];
  const legend = sources.length
    ? sources.slice(0, 12).map((s) =>
      `<span class="pc-legend-item" title="${esc(s.layer ? `слой «${s.layer}»` : s.label)}">`
      + `<span class="pc-swatch" style="${sourceSwatchStyle((s.kinds && s.kinds[0]) || 'other', s.color)}"></span>`
      + `${esc(s.label)} · ${esc((s.kinds || []).join(', '))} · ${s.areaM2} м²</span>`).join('')
      + (sources.length > 12 ? `<span class="pc-legend-item">…и ещё ${sources.length - 12} объектов</span>` : '')
    : zones.map((z) =>
      `<span class="pc-legend-item"><span class="pc-swatch" style="${swatchStyle(z.kind)}"></span>${esc(z.label)} · ${z.areaM2} м²${z.count > 1 ? ` · ${z.count} шт.` : ''}</span>`).join('');
  const b = data.buildable;
  const problems = [
    ...(data.unresolved || []).map((u) => `Не построено «${esc(u.kind)}»: ${esc(u.reason)}`),
    ...(data.conflicts || []).map((c) => esc(c)),
    ...(data.missingData || []).slice(0, 4).map((m) => `Не хватает данных: ${esc(m)}`),
  ];
  const done = state.view && ['variants', 'variants_review', 'drawing', 'done'].includes(state.view.stage);
  return `<div class="pc">
    ${sheetHtml(null)}
    <div class="pc-legend">${legend || '<span class="pc-legend-item">Зоны ограничений не построены</span>'}
      <span class="pc-legend-item"><span class="pc-swatch" style="background: rgba(164,64,47,.20); border:1px solid #a4402f"></span>запретная зона — под краской</span>
      <span class="pc-legend-item"><span class="pc-swatch" style="background: rgba(126,176,138,.45); border:1px solid #6f9e78"></span>допустимая территория</span>
    </div>
    <div class="pc-facts">
      ${b ? `<span>Допустимо под застройку: <b>${b.areaM2} м²</b> (${b.sharePercent}% участка)</span>` : '<span>Допустимая территория не рассчитана</span>'}
      ${b && b.forbidden ? `<span>Запрещено: <b>${b.forbidden.areaM2} м²</b> (${b.forbidden.sharePercent}%)</span>` : ''}
      <span>Зон построено: <b>${zones.reduce((s, z) => s + z.count, 0)}</b></span>
    </div>
    ${manualHintsHtml(data.manualHints)}
    ${problems.length ? `<p class="pc-note">${problems.slice(0, 5).join('<br>')}</p>` : ''}
    ${done
      ? '<div class="pc-done">✓ Схема согласована</div>'
      : cardActionsHtml(fresh,
        '<button class="btn btn-primary btn-sm" type="button" data-stage-act="zones-approve">Согласовать</button>' +
        '<button class="btn btn-quiet btn-sm" type="button" data-stage-act="zones-revise">Замечания</button>')}
  </div>`;
}

/**
 * Подпись статуса варианта считается по ЖИВОМУ полю `status`.
 * `metrics.statusLabel` заморожен на момент генерации: после решения по
 * мероприятию вариант становится допустимым, а замороженная подпись
 * продолжала уверять, что он «требует вашего решения» — выглядело так,
 * будто кнопка решения не сработала.
 */
const VARIANT_STATUS_LABELS = {
  admissible: 'допустим',
  needs_decision: 'требует вашего решения',
  violations: 'есть нарушения',
  rejected: 'отклонён',
};

function variantStatusLabel(vv) {
  return VARIANT_STATUS_LABELS[vv.status] || vv.statusLabel || vv.status || '';
}

/** Мероприятие по критическому объекту: пока по нему нет решения, вариант
 * выбрать нельзя. Кнопок решения в интерфейсе не было совсем, и путь вставал
 * в тупик — сервер отвечал 409, а нажать было нечего. */
function actionsHtml(vv, fresh) {
  const acts = (vv.actions || []).filter((a) => a.requiresDecision);
  if (!acts.length) return '';
  const DECISION = { allow: 'разрешено', forbid: 'запрещено' };
  const rows = acts.map((a) => {
    const volume = Number.isFinite(a.volume) ? ` · ${a.volume}${a.unit ? ` ${esc(a.unit)}` : ''}` : '';
    const head = `<span class="pc-act-title">${esc(a.title)}${volume}</span>`;
    if (a.decision) {
      return `<li class="pc-act"><span class="pc-act-done" data-d="${esc(a.decision)}">${DECISION[a.decision] || esc(a.decision)}</span>${head}</li>`;
    }
    if (!fresh) return `<li class="pc-act">${head}<span class="pc-act-wait">решение не принято</span></li>`;
    return `<li class="pc-act">${head}
      <span class="pc-act-btns">
        <button class="btn btn-primary btn-sm" type="button" data-decide="${esc(a.id)}" data-decision="allow">Разрешить</button>
        <button class="btn btn-danger btn-sm" type="button" data-decide="${esc(a.id)}" data-decision="forbid">Запретить</button>
      </span></li>`;
  }).join('');
  return `<div class="pc-decisions">
    <p class="pc-decisions-head">Вариант ${vv.number}: воздействие на критические объекты — нужно ваше решение</p>
    <ul class="pc-acts">${rows}</ul></div>`;
}

function variantsCardHtml(data, fresh) {
  const run = state.run;
  if (!run || !Array.isArray(run.variants)) {
    return '<div class="pc"><p class="pc-note">Варианты загружаются…</p></div>';
  }
  // Пустой запуск — законный исход («места нет»), а не вечная загрузка:
  // раньше карточка навсегда застревала на «Варианты загружаются…» без кнопок.
  if (!run.variants.length) {
    return `<div class="pc">
      <p class="pc-note">Подходящих вариантов посадки не найдено: с текущими требованиями и запретными зонами
      здание на участок не встаёт. Измените требования или снимите часть ограничений замечанием.</p>
      ${cardActionsHtml(fresh,
    '<button class="btn btn-primary btn-sm" type="button" data-stage-act="variants-revise">Переделать с замечанием</button>')}
    </div>`;
  }
  const badge = { admissible: 'ok', needs_decision: 'wait', violations: 'bad', rejected: 'bad' };
  const cards = run.variants.map((vv) => {
    const statusText = variantStatusLabel(vv);
    const m = vv.metrics || {};
    const svg = state.plan ? window.PlanViewer.thumbSvg({ plan: state.plan, footprint: vv.footprint }) : '';
    // кнопки решений лежат РЯДОМ с кнопкой варианта, а не внутри неё:
    // вложенная <button> в <button> — недопустимая разметка, браузер её рвёт
    return `<div class="pc-variant-wrap">
      <button class="pc-variant${vv.selected ? ' selected' : ''}" type="button" data-pick-variant="${esc(vv.id)}">
      <h4>Вариант ${vv.number}<span class="vw-badge ${badge[vv.status] || 'wait'}">${esc(statusText)}</span></h4>
      ${svg}
      <span class="pc-shape">${esc(m.shapeLabel || 'прямоугольник')}${m.shapeNote ? ` — ${esc(m.shapeNote)}` : ''}</span>
      <span class="pc-metrics"><span>${m.areaM2} м²</span><span>${m.width} × ${m.length} м</span>
        <span>${m.rotationDeg}°</span>${m.floors ? `<span>${m.floors} эт.</span>` : ''}
        ${m.affectedCount ? `<span>задето ${m.affectedCount}</span>` : ''}
        ${m.removedCount ? `<span title="Решение о сносе или переносе уже принято — воздействием варианта это не считается, но в ТЭП попадает">под снос ${m.removedCount} · ${m.removedAreaM2} м²</span>` : ''}</span>
      </button>
      ${actionsHtml(vv, fresh)}
    </div>`;
  }).join('');
  const picked = run.variants.find((vv) => vv.selected);
  const done = state.view && ['drawing', 'done'].includes(state.view.stage);
  return `<div class="pc">
    <div class="pc-variants">${cards}</div>
    ${(data.notes || []).length ? `<p class="pc-note">${(data.notes || []).map(esc).join(' ')}</p>` : ''}
    ${done
      ? `<div class="pc-done">✓ Вариант ${picked ? picked.number : ''} согласован</div>`
      : cardActionsHtml(fresh,
        `<button class="btn btn-primary btn-sm" type="button" data-stage-act="variants-approve"${picked ? '' : ' disabled'}>
            ${picked ? `Согласовать вариант ${picked.number} и собрать чертёж` : 'Выберите вариант'}</button>
          <button class="btn btn-quiet btn-sm" type="button" data-stage-act="variants-revise">Переделать с замечанием</button>`)}
  </div>`;
}

function drawingCardHtml(data) {
  const files = (data.files || []).map((f) =>
    `<li class="result-item"><span class="file-ext">${esc(f.format)}</span>
      <span class="name">${esc(f.filename)}<br><span class="meta">${fmtSize(f.size)}</span></span>
      <button class="icon-btn dl" type="button" data-download="${esc(f.id)}" data-name="${esc(f.filename)}"
              aria-label="Скачать ${esc(f.filename)}" title="Скачать">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 4v12m0 0l-5-5m5 5l5-5M4 20h16"/></svg>
      </button></li>`).join('');
  const dwg = (data.files || []).some((f) => f.format === 'dwg');
  return `<div class="pc">
    ${sheetHtml(null)}
    <div class="pc-facts"><span>Чертёж по варианту <b>${data.variantNumber}</b></span>
      <span>${dwg ? 'DWG готов' : 'DWG не собран — отдан DXF'}</span></div>
    <ul class="results-list" style="padding: 0 12px 10px">${files}</ul>
    ${(data.notes || []).length ? `<p class="pc-note">${(data.notes || []).map(esc).join('<br>')}</p>` : ''}
  </div>`;
}

/** `fresh` — это последняя карточка своего вида в ленте; только у неё живые кнопки. */
function cardHtml(data, fresh) {
  if (data.card === 'zones') return zonesCardHtml(data, fresh);
  if (data.card === 'variants') return variantsCardHtml(data, fresh);
  if (data.card === 'drawing') return drawingCardHtml(data);
  return '';
}

const CARD_TITLES = {
  zones: 'Запретные зоны и допустимая территория',
  variants: 'Четыре варианта посадки',
  drawing: 'Чертёж готов',
};

/**
 * Данные для карточек подгружаются один раз: план участка для схем и последний
 * запуск для вариантов. Опрос ленты идёт раз в 1,2 с — тянуть их каждый раз
 * значило бы перечитывать чертежи по кругу.
 */
async function ensureCardData(v) {
  const cards = v.messages.map(cardOf).filter(Boolean);
  if (!cards.length || state.cardsLoading) return;
  const needPlan = !state.plan;
  const needRun = cards.some((c) => c.card === 'variants') && !state.run;
  if (!needPlan && !needRun) return;
  state.cardsLoading = true;
  try {
    if (needPlan) {
      const data = await api(`/sessions/${state.session.id}/plan`);
      state.plan = data.plan;
    }
    if (needRun) state.run = await api(`/sessions/${state.session.id}/plan/variants`);
    render();
  } catch (err) {
    console.warn('[cards]', err.message);
  } finally {
    state.cardsLoading = false;
  }
}

/** Действия карточек: согласование, замечания, выбор варианта. */
async function stageAction(act) {
  const id = state.session && state.session.id;
  if (!id) return;
  try {
    if (act === 'zones-approve') {
      const req = await askRequirements();
      if (req === null) return;
      await api(`/sessions/${id}/stages/zones/approve`, { method: 'POST', json: { requirements: req } });
      toast('Схема согласована — подбираю варианты посадки');
    } else if (act === 'zones-revise') {
      const res = await appDialog({
        title: 'Замечания к схеме зон',
        message: 'Замечание уйдёт в задание модели, и зоны будут построены заново.',
        fields: [{ key: 'note', label: 'Что не так', placeholder: 'Например: СЗЗ птицефабрики учтена не полностью', maxLength: 1000 }],
        confirmText: 'Пересчитать зоны',
      });
      if (res === null || !res.note) return;
      await api(`/sessions/${id}/stages/zones/revise`, { method: 'POST', json: { note: res.note } });
      toast('Зоны пересчитываются с учётом замечания');
    } else if (act === 'variants-approve') {
      await api(`/sessions/${id}/stages/variants/approve`, { method: 'POST', json: {} });
      toast('Собираю чертёж');
    } else if (act === 'variants-revise') {
      const res = await appDialog({
        title: 'Переделать варианты',
        message: 'Замечание учитывается при новом подборе. Требования к зданию можно уточнить здесь же.',
        fields: [
          { key: 'note', label: 'Что изменить', placeholder: 'Например: нужен корпус вдоль южной границы', maxLength: 1000 },
          { key: 'areaM2', label: 'Площадь застройки, м² (пусто — как было)', value: '', maxLength: 12 },
          { key: 'floors', label: 'Этажность (пусто — как было)', value: '', maxLength: 4 },
        ],
        confirmText: 'Подобрать заново',
      });
      if (res === null || !res.note) return;
      await api(`/sessions/${id}/stages/variants/revise`, {
        method: 'POST',
        json: { note: res.note, requirements: { areaM2: Number(res.areaM2) || undefined, floors: Number(res.floors) || undefined } },
      });
      state.run = null;
      toast('Подбираю варианты заново');
    }
    await refresh();
  } catch (err) {
    toast(err.message, 'error');
    // «Сначала выберите вариант» приходит, когда выбор остался в прошлом прогоне:
    // перечитываем запуск, чтобы карточка показывала настоящее состояние
    if (act.startsWith('variants')) {
      state.run = null;
      await refresh().catch(() => {});
    }
  }
}

/**
 * Решение по мероприятию, затрагивающему критический объект (ТЗ, п. 46).
 * Пока решения нет, вариант выбрать нельзя: сервер отвечает 409. Кто принял
 * решение — записывается в мероприятие, поэтому имя берётся из входа.
 */
async function decideAction(actionId, decision) {
  const id = state.session && state.session.id;
  if (!id) return;
  const u = (window.Auth && window.Auth.user) || null;
  const decidedBy = u ? `${u.lastName} ${u.firstName}`.trim() : '';
  if (!decidedBy) { toast('Решение подписывается именем — войдите на платформу заново', 'error'); return; }
  const ok = await appDialog({
    title: decision === 'allow' ? 'Разрешить воздействие?' : 'Запретить воздействие?',
    message: decision === 'allow'
      ? `Мероприятие будет считаться согласованным. Решение записывается от вашего имени: ${decidedBy}.`
      : `Мероприятие будет запрещено, а вариант — отклонён. Решение записывается от вашего имени: ${decidedBy}.`,
    confirmText: decision === 'allow' ? 'Разрешить' : 'Запретить',
    danger: decision === 'forbid',
  });
  if (ok === null) return;
  try {
    await api(`/sessions/${id}/plan/actions/${actionId}`, { method: 'POST', json: { decision, decidedBy } });
    state.run = await api(`/sessions/${id}/plan/variants`);
    toast(decision === 'allow' ? 'Воздействие разрешено' : 'Воздействие запрещено');
    render();
  } catch (err) { toast(err.message, 'error'); }
}

/** Требования к зданию: подставляются из фактов, но подтверждает их человек. */
async function askRequirements() {
  const s = (state.view && state.view.suggestedRequirements) || null;
  const res = await appDialog({
    title: 'Требования к зданию',
    message: s
      ? `Из исходных данных: ${s.sources.slice(0, 3).join('; ')}. Проверьте и подтвердите.`
      : 'В исходных данных требования к зданию не найдены — укажите их, иначе варианты будут не про этот объект.',
    fields: [
      { key: 'areaM2', label: 'Площадь застройки, м²', value: s && s.areaM2 ? String(s.areaM2) : '', maxLength: 12 },
      { key: 'floors', label: 'Этажность', value: s && s.floors ? String(s.floors) : '', maxLength: 4 },
    ],
    confirmText: 'Подобрать варианты',
  });
  if (res === null) return null;
  const areaM2 = Number(String(res.areaM2).replace(',', '.'));
  if (!(areaM2 > 0)) { toast('Площадь застройки обязательна', 'error'); return null; }
  return { areaM2, floors: Number(res.floors) || undefined };
}

/* ---------------- виджет уточняющих вопросов (стиль Claude Code) ---------------- */
function renderQuestionWidget(v) {
  const w = $('question-widget');
  const pending = (v.questions || []).filter((q) => q.status === 'pending');
  if (!pending.length) {
    w.hidden = true;
    state.qwId = null;
    state.qBatchTotal = 0;
    return;
  }
  const busy = ['queued', 'running'].includes(v.jobStatus);
  const q = pending[0];
  // счётчик «2/4»: размер пачки запоминается, позиция = отвеченные + 1
  if (!state.qBatchTotal) state.qBatchTotal = pending.length;
  state.qBatchTotal = Math.max(state.qBatchTotal, pending.length);
  $('qw-counter').textContent = `${state.qBatchTotal - pending.length + 1}/${state.qBatchTotal}`;
  if (q.id !== state.qwId) { // новый вопрос — свежие варианты и чистое поле
    state.qwId = q.id;
    $('qw-input').value = '';
    // номер варианта — это НОМЕР КЛАВИШИ (1..9), а не украшение: обработчик
    // ниже по файлу отвечает на нажатие цифры. aria-hidden — чтобы читалка не
    // склеивала «до 1 кВ» и «1» в одну строку
    setHTML($('qw-options'), (q.options || []).map((o, i) => {
      const key = i < 9 ? String(i + 1) : '';
      return `<button type="button" class="qw-opt" data-opt="${esc(o)}"${key ? ` data-hotkey="${key}" title="Клавиша ${key}"` : ''}>` +
        `<span class="qw-opt-text">${esc(o)}</span>${key ? `<span class="qw-num" aria-hidden="true">${key}</span>` : ''}</button>`;
    }).join(''));
  }
  $('qw-title').textContent = q.text;
  $('qw-why').textContent = q.why || '';
  $('qw-why').hidden = !q.why;
  w.hidden = false;
  for (const el of w.querySelectorAll('button, input')) el.disabled = busy;
  $('qw-send').disabled = busy || !$('qw-input').value.trim();
}

async function answerCurrentQuestion(answer) {
  const qid = state.qwId;
  if (!qid || !state.session) return;
  for (const el of $('question-widget').querySelectorAll('button, input')) el.disabled = true;
  try {
    const res = await api(`/sessions/${state.session.id}/questions/${qid}/answer`, { method: 'POST', json: { answer } });
    toast(res.continued ? 'Ответ принят, обработка продолжена' : `Ответ принят. Осталось вопросов: ${res.pending}`);
  } catch (err) { toast(err.message, 'error'); }
  await refresh().catch(() => {});
}

async function skipCurrentQuestion() {
  const qid = state.qwId;
  if (!qid || !state.session) return;
  for (const el of $('question-widget').querySelectorAll('button, input')) el.disabled = true;
  try {
    const res = await api(`/sessions/${state.session.id}/questions/${qid}/skip`, { method: 'POST', json: {} });
    toast(res.continued ? 'Вопрос пропущен, обработка продолжена' : `Вопрос пропущен. Осталось: ${res.pending}`);
  } catch (err) { toast(err.message, 'error'); }
  await refresh().catch(() => {});
}

/* ---------------- бейдж действующей нейросети ---------------- */
// короткие имена для бейджа и карточки прогресса (единый принцип: имя продукта)
const PROVIDER_LABELS = { claude: 'Claude', chatgpt: 'ChatGPT', kimi: 'Kimi', gemini: 'Gemini', lmstudio: 'LM Studio', ollama: 'Ollama', demo: 'Демо-режим' };
const CLOUD_PROVIDERS = ['claude', 'chatgpt', 'kimi', 'gemini'];

function updateAiBadge() {
  const ai = state.view && state.view.ai;
  let text, mode;
  if (ai && ai.provider) {
    text = ai.provider === 'demo' ? 'ДЕМО-РЕЖИМ'
      : `${PROVIDER_LABELS[ai.provider] || ai.provider}: ${ai.model || '…'}`;
    mode = ai.provider === 'demo' ? 'mock'
      : CLOUD_PROVIDERS.includes(ai.provider) ? 'live' : 'local';
  } else if (state.health) {
    const h = state.health;
    text = h.aiMode === 'live' ? `AI: ${h.model}`
      : h.aiMode === 'local' ? `Локальная модель: ${h.model}` : 'ДЕМО-РЕЖИМ';
    mode = h.aiMode;
  } else return;
  $('ai-badge-text').textContent = text;
  $('ai-badge').dataset.mode = mode;
  $('ai-badge').title = `Действующая нейросеть: ${text}`;
}

/* ---------------- живой индикатор выполнения ---------------- */
const PROGRESS_STEPS = [
  { phase: 'preparing', label: 'Подготовка контекста' },
  { phase: 'reading_docs', label: 'Изучение документации (графика и сканы)' },
  { phase: 'retrieving', label: 'Поиск в базе знаний' },
  { phase: 'loading_model', label: 'Загрузка модели' },
  { phase: 'waiting_model', label: 'Обработка запроса моделью' },
  { phase: 'generating', label: 'Генерация ответа' },
  { phase: 'validating', label: 'Проверка структуры ответа' },
  { phase: 'saving', label: 'Сохранение результатов' },
];
const PHASE_PERCENT = { preparing: 6, reading_docs: 15, retrieving: 24, loading_model: 32, waiting_model: 44, generating: 50, validating: 92, saving: 97 };
const CHECK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';

let progressTimer = null;
function renderProgress() {
  const v = state.view;
  const card = $('progress-card');
  const active = v && ['queued', 'running'].includes(v.jobStatus);
  if (!active) {
    card.hidden = true;
    $('progress-title').classList.remove('live'); // анимация текста живёт только во время работы
    if (progressTimer) { clearInterval(progressTimer); progressTimer = null; }
    return;
  }
  const p = v.jobProgress || null;
  if (card.hidden) $('btn-cancel-job').disabled = false; // новая задача — кнопка снова активна
  card.hidden = false;
  $('progress-title').textContent = v.jobStatus === 'queued' ? 'Задача в очереди' : 'Выполняется анализ';
  $('progress-title').classList.add('live');
  /*
   * В шапке прогресса стоит модель, которая работает ПРЯМО СЕЙЧАС, и рядом —
   * чем она занята. Раньше здесь был только идентификатор, и во время
   * распознавания сканов он менялся: выбранная модель не видит изображения,
   * страницы уходят локальной vision-модели, а выглядело это как «после запуска
   * подменили модель». Модель не подменялась — менялась работа.
   */
  const ROLE_LABELS = { ocr: 'распознаёт сканы', analysis: 'ведёт разбор' };
  $('progress-model').textContent = p && p.model
    ? `${PROVIDER_LABELS[p.provider] || p.provider || 'Модель'} · ${p.model}`
      + (ROLE_LABELS[p.role] ? ` — ${ROLE_LABELS[p.role]}` : '')
    : '';
  $('progress-label').textContent = (p && p.label) || 'Ожидание начала обработки…';

  const bar = $('progress-bar');
  const phase = p && p.phase;
  const pct = progressPct(p);
  if (pct !== null) {
    bar.classList.remove('indeterminate');
    bar.style.width = `${pct}%`;
  } else {
    bar.classList.add('indeterminate');
    bar.style.width = '';
  }

  const tok = $('progress-tokens');
  if (p && p.tokensOut > 0) {
    tok.hidden = false;
    // для облачных моделей — живая оценка стоимости уже сгенерированных выходных токенов
    const price = cloudPriceFor(p.provider, p.model);
    const cost = price ? ` · выходные ≈ $${((p.tokensOut * price.output) / 1e6).toFixed(4)}` : '';
    tok.textContent = `Сгенерировано токенов: ~${p.tokensOut.toLocaleString('ru-RU')}${cost}`;
  } else tok.hidden = true;

  const stepIdx = PROGRESS_STEPS.findIndex((s) => s.phase === phase);
  setHTML($('progress-steps'), PROGRESS_STEPS.map((s, i) => {
    const cls = stepIdx < 0 ? '' : i < stepIdx ? 'done' : i === stepIdx ? 'current' : '';
    const ico = cls === 'done' ? CHECK_SVG : cls === 'current' ? '<span class="step-spinner"></span>' : '';
    return `<li class="${cls}"><span class="step-ico">${ico}</span>${s.label}</li>`;
  }).join(''));

  // поправка часов — только при реальном обновлении прогресса, иначе таймер замирает
  if (p && p.updatedAt && p.updatedAt !== state.lastProgressUpdatedAt) {
    state.progressClockOffset = Date.now() - p.updatedAt;
    state.lastProgressUpdatedAt = p.updatedAt;
  }
  if (!progressTimer) progressTimer = setInterval(updateElapsed, 500);
  updateElapsed();
}

/** Процент выполнения по фазе (для полосы и оценки времени); null — фаза неизвестна. */
function progressPct(p) {
  const phase = p && p.phase;
  if (!phase || PHASE_PERCENT[phase] === undefined) return null;
  let pct = PHASE_PERCENT[phase];
  // на генерации полоса растёт с числом токенов, асимптотически к 90%
  if (phase === 'generating') pct = 50 + Math.round(40 * (1 - Math.exp(-(p.tokensOut || 0) / 3000)));
  return pct;
}

function updateElapsed() {
  const p = state.view && state.view.jobProgress;
  if (!p || !p.startedAt) { $('progress-elapsed').textContent = ''; return; }
  const s = Math.max(0, Math.floor((Date.now() - state.progressClockOffset - p.startedAt) / 1000));
  let text = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  // ориентировочный остаток: прошло/прогресс × остаток прогресса (грубая оценка)
  const pct = progressPct(p);
  if (pct !== null && pct >= 15 && s >= 25) {
    const eta = Math.round((s * (100 - pct)) / pct);
    text += eta < 60 ? ' · осталось ≈ меньше минуты' : ` · осталось ≈ ${Math.ceil(eta / 60)} мин`;
  }
  $('progress-elapsed').textContent = text;
}

/** Тариф облачной модели {input, output} за 1 млн токенов из /health, либо null. */
function cloudPriceFor(provider, model) {
  if (!CLOUD_PROVIDERS.includes(provider)) return null;
  const info = (state.health?.providers || []).find((x) => x.id === provider)
    ?.modelsInfo?.find((m) => m.id === model);
  return info && info.price ? info.price : null;
}

/* ---------------- подсказка под полем ввода ----------------
   Переключателя режимов больше нет: лента одна, поле одно. Подсказка
   объясняет, что сейчас случится с написанным, — это и заменяет собой
   бывшую надпись «Комментарий к данным» над отдельным полем. */
function chatHint(v) {
  if (!v) return '';
  if (v.pendingChats > 0 && !v.chatBusy) {
    return v.pendingChats === 1
      ? 'Вопрос принят — отвечу, как освобожусь.'
      : `Вопросов в очереди: ${v.pendingChats} — отвечу, как освобожусь.`;
  }
  if (v.chatBusy) return 'Помощник печатает ответ…';
  if (['queued', 'running'].includes(v.jobStatus)) {
    return 'Идёт работа — пишите: сообщение встанет в ленту, ответ придёт следом.';
  }
  if (v.stage === 'idle' && v.files.length) {
    return 'До запуска анализа написанное здесь идёт в указания к исходным данным.';
  }
  if (v.jobStatus === 'awaiting_approval') return 'Жду вашего решения по карточке выше — замечания можно писать и сюда.';
  return '';
}

/* ---------------- настройки анализа (нейросеть + база) ---------------- */
/** Первый уровень выбора: провайдеры в порядке отображения. */
const PROVIDER_MENU = [
  { id: 'claude', label: 'Claude (Anthropic)' },
  { id: 'chatgpt', label: 'ChatGPT (OpenAI)' },
  { id: 'kimi', label: 'Kimi (Moonshot AI)' },
  // порядок совпадает с server/services/providers.js: список моделей, доступность
  // и подпись «нужен ключ» приходят живыми из /health, здесь только пункт меню
  { id: 'gemini', label: 'Gemini (Google)' },
  { id: 'lmstudio', label: 'LM Studio (локально)' },
  { id: 'ollama', label: 'Ollama (локально)' },
  { id: 'demo', label: 'Демо-режим (без AI)' },
];

function providerInfo(id) {
  return (state.health?.providers || []).find((p) => p.id === id) || null;
}

function modelOptionLabel(p, m) {
  const info = (p.modelsInfo || []).find((x) => x.id === m);
  if (info && info.price) return `${m} · $${info.price.input}/$${info.price.output} за 1М`;
  // облачная модель без тарифа в справочнике — говорим честно
  if (CLOUD_PROVIDERS.includes(p.id)) return `${m} · тариф неизвестен`;
  return m;
}

/** Текущий выбор в каскаде: { provider, model }. */
function currentPick() {
  const provider = $('sel-provider').value || '';
  return { provider, model: provider ? ($('sel-model').value || '') : '' };
}

/** Первый уровень: список провайдеров. */
function fillProviderSelect() {
  const sel = $('sel-provider');
  const prev = sel.value;
  sel.innerHTML = '';
  const defOpt = document.createElement('option');
  defOpt.value = '';
  defOpt.textContent = state.health?.aiMode === 'local' && state.health.localBundle
    ? 'По умолчанию: локальная связка текст + графика'
    : 'По умолчанию (как настроен сервер)';
  sel.appendChild(defOpt);
  for (const item of PROVIDER_MENU) {
    const p = providerInfo(item.id);
    if (!p) continue;
    const opt = document.createElement('option');
    opt.value = item.id;
    opt.textContent = p.available ? item.label : `${item.label} — ${p.note}`;
    opt.disabled = !p.available;
    sel.appendChild(opt);
  }
  sel.disabled = false;
  sel.value = prev;
  if (sel.selectedIndex === -1) sel.value = '';
}

/** Второй уровень: модели выбранного провайдера; desired — сохранённая модель. */
function fillModelSelect(providerId, desired = '') {
  const sel = $('sel-model');
  sel.innerHTML = '';
  const p = providerId ? providerInfo(providerId) : null;
  if (!p) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = '— провайдер по умолчанию —';
    sel.appendChild(opt);
    sel.disabled = true;
    updateModelNote();
    return;
  }
  sel.disabled = false;
  const models = p.models.length ? p.models : [''];
  for (const m of models) {
    const opt = document.createElement('option');
    opt.value = m;
    opt.textContent = m ? modelOptionLabel(p, m) : '(модели не найдены)';
    sel.appendChild(opt);
  }
  if (desired) {
    sel.value = desired;
    if (sel.selectedIndex === -1) {
      // сохранённая модель сейчас не в списке — показываем честно, не сбрасывая
      const opt = document.createElement('option');
      opt.value = desired;
      opt.textContent = `${desired} (недоступна сейчас)`;
      opt.dataset.missing = '1';
      sel.appendChild(opt);
      sel.value = desired;
    }
  }
  updateModelNote();
}

/** Ставит оба уровня каскада из настроек сессии. */
function setModelSelect(providerId, model) {
  const sel = $('sel-provider');
  sel.value = providerId || '';
  if (sel.selectedIndex === -1) sel.value = '';
  fillModelSelect(sel.value, model || '');
}

/** Подсказка под select: тариф облачной модели или параметры локальной. */
/** Подпись под селектором модели: тариф/контекст плюс строка возможностей. */
function updateModelNote() {
  updateModelNoteBase();          // у базовой много ранних return — возможности дописываем поверх
  appendCapabilityLine($('model-note'), currentPick().provider);
  renderModelAbout();
}

/**
 * Описание выбранной модели: что это и для чего её брать.
 *
 * До этого пикер показывал только идентификатор и тариф — «meta/llama-3.3-70b»,
 * «qwen/qwen3-vl-8b». По такому списку выбрать нельзя: не видно ни того, что
 * модель умеет, ни того, годится ли она для комплекта ИД. Тексты приходят
 * с сервера из реестра (services/ai/registry.js), а не пишутся в разметке.
 */
function renderModelAbout() {
  const box = $('model-about');
  if (!box) return;
  const { provider, model } = currentPick();
  const p = provider ? providerInfo(provider) : null;
  const about = p && (p.modelsInfo || []).find((m) => m.id === (model || (p.models || [])[0]))?.about;
  if (!about) { box.hidden = true; box.innerHTML = ''; return; }
  const list = (items, cls) => (items && items.length
    ? `<ul class="ma-list ${cls}">${items.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>` : '');
  box.hidden = false;
  box.innerHTML =
    `<p class="ma-head"><span class="ma-tier">${esc(about.tier)}</span> ${esc(about.summary)}</p>`
    + list(about.strengths, 'ma-plus')
    + list(about.limits, 'ma-minus')
    + (about.bestFor ? `<p class="ma-best"><strong>Когда выбирать:</strong> ${esc(about.bestFor)}</p>` : '');
}

function updateModelNoteBase() {
  const note = $('model-note');
  const { provider, model } = currentPick();
  const opt = $('sel-model').selectedOptions[0];
  if (opt && opt.dataset.missing) {
    note.hidden = false;
    note.textContent = 'Сохранённая модель сейчас недоступна — проверьте, запущен ли её сервер. Запросы будут завершаться ошибкой, пока модель не появится.';
    return;
  }
  const b = state.health && state.health.localBundle;
  if (!provider && state.health && state.health.aiMode === 'local' && b) {
    note.hidden = false;
    note.textContent = `Текст и анализ: ${b.text} · Графика и сканы: ${b.vision} · документы изучаются последовательно перед анализом`;
    return;
  }
  // облачная модель: тариф за 1 млн токенов
  const price = cloudPriceFor(provider, model);
  if (price) {
    note.hidden = false;
    note.textContent = `Тариф: $${price.input} за 1 млн входных · $${price.output} за 1 млн выходных токенов. ` +
      'Запросы платные (по API-ключу); стоимость сессии видна в карточке «Статус».';
    return;
  }
  if (CLOUD_PROVIDERS.includes(provider) && model) {
    note.hidden = false;
    note.textContent = 'Тариф этой модели неизвестен приложению: запросы всё равно платные, ' +
      'но их стоимость НЕ попадёт в счётчик сессии. Точные цены — на сайте провайдера. ' +
      'Надёжнее выбирать модели с указанным тарифом (они в начале списка).';
    return;
  }
  const info = provider === 'lmstudio'
    ? providerInfo('lmstudio')?.modelsInfo?.find((m) => m.id === model)
    : null;
  if (info) {
    // контекст показываем ФАКТИЧЕСКИЙ — с каким модель загрузится на этой машине.
    // Если он урезан против желаемого, об этом сказано прямо: иначе подпись
    // обещает 32 тыс. токенов там, где будет 8 тыс., и «документ не поместился»
    // выглядит необъяснимым.
    /*
     * Контекст показывается ВМЕСТЕ с паспортным максимумом модели.
     *
     * В LM Studio владелец видит «Модель поддерживает до 262 144 токенов», а
     * здесь стояло голое «контекст 98 304» — и число выглядело занижённым без
     * причины. Причин две, и они разные: не хватает памяти под KV-кэш либо
     * упёрлись в осознанный потолок машины (LOCAL_AI_CONTEXT: при полном окне
     * prefill идёт больше девяти минут). Обе называются вслух.
     */
    const ctx = info.context || 0;
    const max = info.modelMaxContext || 0;
    let why = '';
    if (max && ctx < max) {
      why = info.wantContext && ctx < info.wantContext
        ? ' — урезан: не хватает памяти под KV-кэш'
        : ' — ограничение платформы LOCAL_AI_CONTEXT, чтобы ответ не ждать минутами';
    }
    const parts = [`контекст ${ctx.toLocaleString('ru-RU')}`
      + (max ? ` из ${max.toLocaleString('ru-RU')} токенов модели` : ' токенов') + why];
    if (info.sizeGb) parts.push(`${info.sizeGb} ГБ`);
    parts.push(info.loaded ? 'сейчас загружена в память' : 'загрузится при первом запросе (1–2 мин)');
    if (info.note) parts.push(info.note);
    note.hidden = false;
    note.textContent = parts.join(' · ');
    note.classList.toggle('hint-warn', !!info.heavy);
  } else {
    note.hidden = true;
    note.textContent = '';
  }
}

/** Подпись «что умеет модель» — по capabilities из реестра, а не по названию. */
const CAP_LABELS = {
  vision: 'видит изображения',
  pdf: 'читает PDF целиком',
  structuredOutput: 'строгий JSON',
  reasoning: 'размышляет перед ответом',
  tools: 'вызов инструментов',
  streaming: 'потоковый ответ',
};

function appendCapabilityLine(note, provider) {
  const caps = capabilitiesFor(provider);
  if (!caps) return;
  const able = Object.keys(CAP_LABELS).filter((k) => caps[k]).map((k) => CAP_LABELS[k]);
  if (!able.length) return;
  const line = `Возможности: ${able.join(' · ')}`;
  note.hidden = false;
  note.textContent = note.textContent ? `${note.textContent}\n${line}` : line;
}

function capabilitiesFor(provider) {
  const id = provider || (state.health && state.health.aiMode === 'local' ? 'lmstudio' : '');
  const p = id && providerInfo(id);
  return (p && p.capabilities) || null;
}

function renderSettingsOptions(health) {
  const kbSelPrev = $('sel-kb').value;
  const pickPrev = currentPick();
  const comparePrev = new Set(selectedCompareModels().map((m) => `${m.provider}|${m.model}`));

  fillProviderSelect();

  const kbSel = $('sel-kb');
  kbSel.innerHTML = '';
  for (const b of health.kbBases || []) {
    const opt = document.createElement('option');
    const count = (health.kb.bases || []).find((x) => x.id === b.id)?.chunks;
    opt.value = b.id;
    opt.textContent = `${b.label}${count !== undefined ? ` (${count} фрагм.)` : ''}`;
    kbSel.appendChild(opt);
  }

  // сравнение моделей: чекбоксы, сгруппированные по провайдерам (раскрывающиеся)
  const list = $('compare-list');
  const openPrev = new Set([...list.querySelectorAll('details[open]')].map((d) => d.dataset.provider));
  list.innerHTML = '';
  for (const item of PROVIDER_MENU) {
    const p = providerInfo(item.id);
    if (!p || !p.available || item.id === 'demo' || !p.models.length) continue;
    const det = document.createElement('details');
    det.className = 'cl-group';
    det.dataset.provider = item.id;
    const hasChecked = p.models.some((m) => comparePrev.has(`${item.id}|${m}`));
    if (openPrev.has(item.id) || hasChecked) det.open = true;
    const sum = document.createElement('summary');
    sum.textContent = `${item.label} · моделей: ${p.models.length}`;
    det.appendChild(sum);
    for (const m of p.models) {
      const label = document.createElement('label');
      label.innerHTML = `<input type="checkbox" data-provider="${esc(item.id)}" data-model="${esc(m)}">` +
        `<span>${esc(modelOptionLabel(p, m))}</span>`;
      label.querySelector('input').checked = comparePrev.has(`${item.id}|${m}`);
      det.appendChild(label);
    }
    list.appendChild(det);
  }

  // после перестройки innerHTML браузер сбрасывает значения — восстанавливаем сами,
  // не полагаясь на render() (он пропускает восстановление, пока select в фокусе)
  const s = state.view && state.view.settings;
  if (s) setModelSelect(s.aiProvider || '', s.aiModel || '');
  else setModelSelect(pickPrev.provider, pickPrev.model);
  $('sel-kb').value = s ? (s.kbChoice || 'main') : kbSelPrev;

  updateCompareButton();
  updateModelNote();
  updateSettingsValues();
}

function selectedCompareModels() {
  return [...document.querySelectorAll('#compare-list input:checked')]
    .map((cb) => ({ provider: cb.dataset.provider, model: cb.dataset.model }));
}

function updateCompareButton() {
  const n = selectedCompareModels().length;
  const busy = state.view && ['queued', 'running'].includes(state.view.jobStatus);
  const noFiles = !state.view || !state.view.files.length;
  $('btn-compare').disabled = busy || n < 2 || n > 4 || noFiles;
  // кнопка объясняет, почему заблокирована
  let label = `Запустить сравнение (моделей: ${n})`;
  if (n < 2) label = 'Запустить сравнение — выберите 2–4 модели';
  else if (n > 4) label = `Слишком много моделей (${n}) — максимум 4`;
  else if (noFiles) label = 'Сначала загрузите исходные данные в проект';
  else if (busy) label = 'Дождитесь завершения текущей задачи…';
  $('btn-compare').textContent = label;
}

async function saveSettings(patch) {
  try {
    await api(`/sessions/${state.session.id}/settings`, { method: 'POST', json: patch });
    toast('Настройки сохранены');
  } catch (err) {
    toast(err.message, 'error');
  }
  await refresh().catch((err) => console.warn('refresh after settings:', err));
  loadHealth().catch((err) => console.warn('health after settings:', err));
}

/* ---------------- data flow ---------------- */
async function refresh() {
  if (!state.session) return;
  state.view = await api(`/sessions/${state.session.id}`);
  render();
  managePolling();
}

/** Этапы, на которых сервер работает сам и лента обязана обновляться. */
const WORKING_STAGES = ['analysis', 'zones', 'variants', 'drawing'];

function managePolling() {
  // Опрос не должен обрываться на стыке этапов: анализ уже поставил статус
  // «завершён», а следующий этап ещё не успел взять слот очереди — в этот
  // зазор лента замерла бы до перезагрузки страницы.
  const v = state.view;
  const active = v && (['queued', 'running'].includes(v.jobStatus)
    || WORKING_STAGES.includes(v.stage)
    // ответ помощника и отложенные вопросы job_status не меняют, но ленту
    // обновлять надо — иначе ответ появится только после перезагрузки
    || v.chatBusy || v.pendingChats > 0);
  if (active && !state.polling) {
    state.polling = setInterval(async () => {
      try { await refresh(); } catch (err) { console.warn(err); }
    }, 1200);
  } else if (!active && state.polling) {
    clearInterval(state.polling);
    state.polling = null;
  }
}

/* ---------------- uploads ---------------- */
async function uploadFiles(fileList) {
  if (!state.session || state.uploading) return;
  const files = [...fileList];
  if (!files.length) return;
  state.uploading = true;
  const dz = $('dropzone');
  dz.classList.add('dragover');
  try {
    for (let i = 0; i < files.length; i += 5) {
      const fd = new FormData();
      files.slice(i, i + 5).forEach((f) => fd.append('files', f));
      toast(`Файлы загружаются… (${Math.min(i + 5, files.length)}/${files.length})`);
      const res = await api(`/sessions/${state.session.id}/files`, { method: 'POST', body: fd });
      for (const e of res.errors || []) toast(`${e.name}: ${e.error}`, 'error');
      if ((res.uploaded || []).length) toast(`Загружено файлов: ${res.uploaded.length}`);
    }
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    state.uploading = false;
    dz.classList.remove('dragover');
    await refresh().catch(() => {});
  }
}

/* ---------------- downloads ---------------- */
async function download(resultId, filename) {
  const res = await fetch(`/api/sessions/${state.session.id}/results/${resultId}/download`, {
    headers: authHeaders(state.session.token),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    toast((data && data.error) || `Не удалось скачать файл (${res.status})`, 'error');
    return;
  }
  const blob = await res.blob();
  saveBlob(blob, filename);
}

function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

// текущий порядок работы сессии как Excel — им же можно править и загружать обратно
async function downloadWorkplan() {
  if (!state.session) return;
  try {
    const res = await fetch(`/api/sessions/${state.session.id}/workplan.xlsx`, {
      headers: authHeaders(state.session.token),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      toast((data && data.error) || `Не удалось скачать файл (${res.status})`, 'error');
      return;
    }
    saveBlob(await res.blob(), 'Порядок работы.xlsx');
  } catch { toast('Сервер сейчас недоступен — попробуйте чуть позже', 'error'); }
}

/* ---------------- разделы настроек (выпадающие списки) ---------------- */
const SET_OPEN_KEY = 'enso-pilot1-settings-open';

/**
 * Разделы настроек — равноправные аккордеоны. Открыт всегда один: настройки
 * читаются сверху вниз списком заголовков, а не простынёй из четырёх карточек.
 * В свёрнутом виде каждый заголовок показывает действующее значение — ради
 * этого раздел и сворачивают, а не ради экономии места.
 */
function initSettingsGroups() {
  const stack = $('settings-stack');
  const groups = [...stack.querySelectorAll('.set-group')];
  const saved = localStorage.getItem(SET_OPEN_KEY);
  if (saved !== null) {
    for (const g of groups) g.open = g.dataset.group === saved;
  }
  for (const g of groups) {
    g.addEventListener('toggle', () => {
      if (!g.open) {
        // закрыли последний открытый — запоминаем «все свёрнуты»
        if (!groups.some((x) => x.open)) localStorage.setItem(SET_OPEN_KEY, '');
        return;
      }
      for (const other of groups) if (other !== g) other.open = false;
      localStorage.setItem(SET_OPEN_KEY, g.dataset.group);
    });
  }
  // значок «i» внутри summary не должен разворачивать раздел
  stack.addEventListener('click', (e) => {
    const btn = e.target.closest('.info-btn[data-info]');
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    const info = SETTINGS_INFO[btn.dataset.info];
    if (info) openInfoModal(info.title, info.html());
  });
  updateSettingsValues();
}

/** Модель без префикса поставщика: «qwen/qwen3-coder-30b» → «qwen3-coder-30b». */
function shortModel(model) {
  return String(model || '').split('/').pop();
}

/** Подписи действующих значений в свёрнутых заголовках разделов. */
function updateSettingsValues() {
  // В заголовке показывается ДЕЙСТВУЮЩАЯ связка, а не подпись пункта списка:
  // у пункта «по умолчанию» подпись описательная и в строку не влезает —
  // получалось «По умолчанию: локальная связка текст + гр…».
  const ai = state.view && state.view.ai;
  $('set-value-ai').textContent = ai && ai.provider
    ? (ai.provider === 'demo' ? 'Демо-режим'
      : `${PROVIDER_LABELS[ai.provider] || ai.provider} · ${shortModel(ai.model) || '…'}`)
    : 'не выбрана';

  const kbSel = $('sel-kb');
  // счётчик фрагментов в заголовок не выносим: важно, какая база, а не сколько в ней кусков
  $('set-value-kb').textContent = kbSel.selectedOptions[0]
    ? kbSel.selectedOptions[0].textContent.replace(/\s*\(\d[\d\s]*фрагм\.\)\s*$/, '')
    : 'не выбрана';

  // «Этапы»: в свёрнутом заголовке важно одно — стандартный порядок или свой файл
  const wp = state.view && state.view.workplan;
  $('set-value-workplan').textContent = !wp || !wp.steps ? ''
    : wp.isDefault ? `стандартные (${wp.steps.length})`
      : `свой файл: ${wp.name}`;

  const n = selectedCompareModels().length;
  $('set-value-compare').textContent = n ? `выбрано моделей: ${n}` : 'не запущено';

  const theme = localStorage.getItem(THEME_KEY) || 'auto';
  $('set-value-theme').textContent = { auto: 'Авто', light: 'Светлая', dark: 'Тёмная' }[theme] || 'Авто';
}

const SETTINGS_INFO = {
  // Требования к файлу описаны по фактическому разбору (services/workplan.js):
  // колонки, потолки длин, 2–40 шагов, 2 МБ. Расходиться справке и парсеру нельзя —
  // человек соберёт файл по описанию и получит отказ без объяснимой причины.
  workplan: {
    title: 'Этапы — порядок анализа и свой файл',
    html: () => {
      const wp = (state.view && state.view.workplan) || null;
      const own = wp && !wp.isDefault;
      return `
        <h4>Что это</h4>
        <p>Список шагов, по которым модель разбирает проект: что проверить, в каком порядке
           и на какой норматив опереться. От классификации документов и границ участка
           до пожарных проездов и оформления чертежа.</p>
        <p><strong>Платформа работает ровно по этому списку — другого у неё нет.</strong>
           Он целиком уходит модели вместе с документами, и разделы отчёта собираются
           по его шагам. Если здесь четырнадцать шагов, то и разбор идёт по четырнадцати:
           скрытого порядка «где-то внутри» не существует.</p>
        <ul>
          <li class="${own ? 'im-no' : 'im-ok'}">${own
            ? `Сейчас действует свой файл: «${esc(wp.name)}» — шагов: ${wp.steps.length}`
            : `Сейчас действует стандартный порядок — шагов: ${wp ? wp.steps.length : '…'}`}</li>
        </ul>
        <h4>Что скачивается</h4>
        <p>Кнопка со стрелкой вниз отдаёт <strong>действующий</strong> порядок файлом
           <code>workplan.xlsx</code>: один лист «Порядок работы», строка заголовка и по строке
           на шаг. Это же и есть образец для своего файла — проще скачать и переписать, чем
           собирать с нуля.</p>
        <h4>Каким должен быть свой файл</h4>
        <ul>
          <li>Формат <strong>.xlsx</strong> (не .xls и не .csv), <strong>до 2 МБ</strong>.</li>
          <li>Читается <strong>первый лист</strong>, остальные игнорируются.</li>
          <li>Колонки строго по местам: <strong>A — №</strong>, <strong>B — Этап</strong>,
              <strong>C — Содержание</strong>, <strong>D — Нормативная база / результат</strong>.</li>
          <li>Строка заголовка распознаётся по словам «№», «Номер», «Шаг», «Этап», «Название»,
              «Step», «Title» и пропускается; можно и без неё.</li>
          <li>Шагов — <strong>от 2 до 40</strong>. Всё сверх сорока отбрасывается, меньше двух —
              файл отклоняется целиком.</li>
          <li>Длина обрезается: № — 8 знаков, «Этап» — 200, «Содержание» — 500,
              «Нормативная база» — 300.</li>
          <li>Строка, где пусты и «Этап», и «Содержание», пропускается. Если заполнено только
              «Содержание», названием шага станет оно. Названия короче трёх знаков отбрасываются.</li>
        </ul>
        <h4>Как формулировать шаги</h4>
        <ul>
          <li><strong>Один шаг — одна проверяемая задача.</strong> «Охранные зоны сетей» —
              шаг; «Разобраться с инженеркой» — не шаг: по нему нельзя понять, выполнен он или нет.</li>
          <li><strong>«Этап» — короткое название</strong> (в него смотрят в списке и в заголовках
              отчёта), <strong>«Содержание» — что именно проверить</strong>, одним предложением.</li>
          <li><strong>В «Нормативной базе» — конкретный документ и пункт</strong>
              («СП 4.13130 п. 6.1.2, табл. 3»), а не «пожарные нормы». От точности ссылки зависит
              статус ограничения: без основания правило получает пометку «требует проверки».</li>
          <li><strong>Порядок строк — это порядок выполнения.</strong> Шаг, которому нужен
              результат другого, должен стоять ниже.</li>
          <li>Нумерация в колонке «№» своя, любая (0, 1, 1.1) — она только подпись.</li>
        </ul>
        <h4>На что это влияет</h4>
        <p>Свой порядок <strong>заменяет стандартный целиком</strong>: модель ведёт разбор
           строго по вашим шагам и по ним же собирает разделы отчёта. Не меняются при этом
           ни формат ответа, ни геометрический движок — координаты зон, площади и пятна застройки
           считает код, а не список шагов.</p>
        <p class="hint">Настройка принадлежит проекту, а не платформе: в соседнем проекте порядок
           останется стандартным. Кнопка возврата (круговая стрелка) появляется, только когда
           загружен свой файл, и возвращает стандартные шаги, ничего больше не трогая.</p>`;
    },
  },
  ai: {
    title: 'Нейросеть — как выбирается и на что влияет',
    html: () => {
      const v = state.view;
      const provider = $('sel-provider').value;
      const p = provider ? providerInfo(provider) : null;
      const caps = capabilitiesFor(provider) || {};
      const cap = (ok, text) => `<li class="${ok ? 'im-ok' : 'im-no'}">${ok ? '✓' : '✗'} ${text}</li>`;
      return `
        <h4>Что делает выбранная модель</h4>
        <p>Она читает исходные данные проекта, извлекает факты, задаёт уточняющие вопросы
           и формулирует правила ограничений. <strong>Геометрию она не считает</strong>:
           координаты зон, площади и пятна застройки строит детерминированный движок —
           поэтому смена модели не меняет чертёж, а меняет качество интерпретации документов.</p>
        <h4>Возможности выбранного провайдера</h4>
        <ul>
          ${cap(!!caps.vision, 'Видит изображения — нужен для сканов и вопросов по области плана')}
          ${cap(!!caps.pdf, 'Читает PDF целиком, без предварительного распознавания')}
          ${cap(!!caps.structuredOutput, 'Строгий JSON — правила ограничений приходят без разбора текста')}
          ${cap(!!caps.reasoning, 'Размышляет перед ответом')}
          ${cap(!!caps.tools, 'Вызов инструментов')}
        </ul>
        <h4>Деньги и доступность</h4>
        <p>${p && p.local
          ? 'Это локальная модель: запросы бесплатны, но нужен запущенный сервер (LM Studio / Ollama) на той же машине.'
          : 'Это облачная модель: запросы платные, по API-ключу на сервере. Расход за сессию — в карточке «Статус».'}</p>
        ${v ? `<p class="hint">Настройка сохраняется у проекта «${esc(v.title || 'без названия')}», а не глобально:
          разные проекты могут работать на разных моделях.</p>` : ''}`;
    },
  },
  kb: {
    title: 'База знаний — что это и как участвует в анализе',
    html: () => {
      const kb = (state.health && state.health.kb) || {};
      const bases = kb.bases || [];
      return `
        <h4>Зачем</h4>
        <p>Нормативные требования модель берёт не из памяти, а из проиндексированных НТД.
           Перед ответом по смыслу вопроса подбираются подходящие фрагменты документов
           и подмешиваются в контекст — вместе со ссылкой на документ и пункт.</p>
        <h4>Доступные базы</h4>
        <ul>${bases.length
          ? bases.map((b) => `<li>${esc(b.label || b.id)} — фрагментов: ${b.chunks}</li>`).join('')
          : '<li class="im-no">Базы не проиндексированы: анализ пойдёт без нормативных выдержек</li>'}</ul>
        <h4>Что важно помнить</h4>
        <ul>
          <li>База даёт <strong>основание</strong> для правила ограничения. Правило без основания
              получает статус «требует проверки» — даже если модель уверена в нём.</li>
          <li>Смена базы не пересчитывает уже построенные зоны: нужно запустить расчёт заново.</li>
        </ul>`;
    },
  },
  compare: { title: 'Сравнение моделей — как это работает', html: () => compareInfoHtml() },
};

/* ---------------- информационное окно (значок «i») ---------------- */
function openInfoModal(title, html) {
  $('info-modal-title').textContent = title;
  $('info-modal-body').innerHTML = html;
  $('info-modal').hidden = false;
}

function closeInfoModal() {
  $('info-modal').hidden = true;
}

/** Справка по сравнению моделей: живой чек-лист готовности + полное описание. */
function compareInfoHtml() {
  const v = state.view;
  const n = selectedCompareModels().length;
  const files = v ? v.files.length : 0;
  const busy = v && ['queued', 'running'].includes(v.jobStatus);
  const check = (ok, text) => `<li class="${ok ? 'im-ok' : 'im-no'}">${ok ? '✓' : '✗'} ${text}</li>`;
  return `
    <h4>Что нужно для запуска — состояние сейчас</h4>
    <ul>
      ${check(files > 0, files > 0
        ? `Исходные данные загружены (файлов: ${files})`
        : 'Загрузите исходные данные в активный проект (карточка «Исходные данные» на экране «Этап 1») — сравнение выполняет полный анализ этих файлов')}
      ${check(n >= 2 && n <= 4, `Отметьте галочками 2–4 модели (сейчас выбрано: ${n})`)}
      ${check(true, 'Модели должны быть доступны: облачным нужен API-ключ на сервере, локальным — запущенный LM Studio/Ollama. Недоступные показаны серым и недоступны для выбора')}
      ${check(!busy, busy
        ? 'Сейчас выполняется другая задача — дождитесь её завершения или прервите'
        : 'Очередь свободна — других задач не выполняется')}
    </ul>
    <h4>Как выполняется сравнение</h4>
    <ol>
      <li>Каждая выбранная модель <strong>по очереди</strong> выполняет один и тот же полный анализ проекта — по активному порядку работы, с документами, конспектами, фактами и базой знаний. Очередь последовательная: локальные модели делят одну LM Studio.</li>
      <li>Для каждой модели замеряются <strong>время ответа и расход токенов</strong>; стоимость облачных запросов добавляется в счётчик сессии (карточка «Статус»).</li>
      <li>Факты, вопросы и результаты проекта при сравнении <strong>не изменяются</strong> — прогоны идут «в песочнице».</li>
      <li>Итог: <strong>сводная таблица</strong> в ленте анализа (статус, время, токены, число фактов и вопросов у каждой модели) и файл <strong>СРАВНЕНИЕ-МОДЕЛЕЙ.md</strong> с полными ответами всех моделей — он появляется в «Результатах» и навсегда сохраняется в архиве прогонов.</li>
      <li>Сравнение можно остановить кнопкой «Прервать» — уже выполненные модели попадут в файл.</li>
    </ol>
    <p class="hint">Ориентир по времени: локальная модель — 5–15 минут на прогон (зависит от объёма документов), облачные заметно быстрее. Три модели — соответственно, суммарное время трёх прогонов.</p>`;
}

/* ---------------- toast ---------------- */
let toastTimer = null;
function toast(text, type = 'info') {
  const el = $('toast');
  el.textContent = text;
  el.dataset.type = type;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, type === 'error' ? 6000 : 3000);
}

/* ---------------- wiring ---------------- */
/** Загружает /health: список провайдеров и моделей, лимиты; обновляет настройки и бейдж. */
async function loadHealth() {
  const health = await api('/health');
  state.health = health;
  state.limits = health.limits;
  setBanner('mock-banner', health.aiMode === 'mock');
  // локальная нейросеть не отвечает — предупреждаем, а не роняем ошибку при запуске
  const lm = (health.providers || []).find((p) => p.id === 'lmstudio');
  setBanner('local-ai-banner', health.aiMode === 'local' && (!lm || !lm.available));
  // срок хранения в интерфейсе больше не показывается (§13): сам механизм TTL
  // и архив прогонов на сервере работают как раньше
  $('limits-line').textContent =
    `Форматы: ${health.limits.allowedExtensions.join(', ')} · до ${health.limits.maxFileSizeMb} МБ/файл · ` +
    `до ${health.limits.maxFiles} файлов · всего до ${health.limits.maxTotalUploadMb} МБ · ` +
    `PDF-сканы: до ${health.limits.visionMaxPages || 50} стр.`;
  renderSettingsOptions(health);
  if (state.view) render(); // восстановить значения select'ов после перестройки опций
  updateAiBadge();
}

async function init() {
  // Вход — раньше всего: без него первые же запросы вернут 401.
  // Приложение стартует только после того, как человек внутри.
  window.Auth.init();
  await window.Auth.start();

  // чисто клиентские обработчики — работают даже при недоступном сервере
  // навигация по экранам (Этап 1 / Нормоконтроль / Настройки)
  for (const btn of document.querySelectorAll('.nav-item[data-screen]')) {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.nav-item').forEach((b) => b.classList.toggle('active', b === btn));
      document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('active', s.id === `screen-${btn.dataset.screen}`));
    });
  }
  // viewer живёт в отдельном файле, но пользуется общим диалогом и общим api()
  window.appDialog = appDialog;
  window.appToast = toast;
  // вьюверу нужны те же заголовки и то же сохранение файла, что и остальному
  // приложению: свои копии однажды разъедутся с authHeaders — забытый
  // X-User-Token уже ломал кнопку «Удалить проект», причём молча
  window.appAuthHeaders = authHeaders;
  window.appSaveBlob = saveBlob;
  window.PlanViewer.init();
  $('vw-reload').addEventListener('click', () => window.PlanViewer.load(api, state.session));
  $('plan-modal-close').addEventListener('click', () => window.PlanViewer.close());

  // стопка плашек: высота уходит в --banners-h, чтобы ничего не перекрывать
  watchBanners();

  // боковая панель: значок и та же горячая клавиша, что в Claude Code
  $('sidebar-toggle').addEventListener('click', toggleSidebar);
  document.addEventListener('keydown', (e) => {
    if (e.key === '\\' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); toggleSidebar(); }
  });
  initSettingsGroups();

  // переключатель темы
  $('theme-seg').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-theme]');
    if (!btn) return;
    localStorage.setItem(THEME_KEY, btn.dataset.theme);
    applyTheme(btn.dataset.theme);
    updateSettingsValues();
  });

  $('compare-list').addEventListener('change', () => { updateCompareButton(); updateSettingsValues(); });

  $('info-modal-close').addEventListener('click', closeInfoModal);
  $('info-modal').addEventListener('click', (e) => {
    if (e.target === $('info-modal')) closeInfoModal(); // клик по подложке
  });
  // Esc закрывает верхнее из открытых окон: справка → диалог → план
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!$('info-modal').hidden) { closeInfoModal(); return; }
    if (!$('dialog-modal').hidden) { closeDialog(null); return; }
    if (window.PlanViewer.isOpen()) window.PlanViewer.close();
  });

  // стилизованный диалог ввода/подтверждения
  $('dialog-ok').addEventListener('click', () => closeDialog(dialogValues()));
  $('dialog-cancel').addEventListener('click', () => closeDialog(null));
  $('dialog-extra').addEventListener('click', () => closeDialog('extra'));
  $('dialog-modal').addEventListener('click', (e) => {
    if (e.target === $('dialog-modal')) closeDialog(null);
  });
  $('dialog-fields').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); closeDialog(dialogValues()); }
  });

  // виджет уточняющих вопросов: варианты, свой ответ, пропуск
  $('qw-options').addEventListener('click', (e) => {
    const btn = e.target.closest('.qw-opt');
    if (btn && !btn.disabled) answerCurrentQuestion(btn.dataset.opt);
  });
  $('qw-send').addEventListener('click', () => {
    const val = $('qw-input').value.trim();
    if (val) answerCurrentQuestion(val);
  });
  $('qw-input').addEventListener('input', () => {
    $('qw-send').disabled = !$('qw-input').value.trim();
  });
  $('qw-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const val = $('qw-input').value.trim();
      if (val) answerCurrentQuestion(val);
    }
  });
  $('qw-skip').addEventListener('click', skipCurrentQuestion);

  // горячие клавиши 1..9 на варианты ответа: номер у варианта нарисован именно
  // как клавиша, и раньше нажатие цифры не делало ничего.
  // Пока открыто любое модальное окно или курсор в поле ввода — цифра остаётся
  // обычным символом.
  document.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (!/^[1-9]$/.test(e.key)) return;
    const w = $('question-widget');
    if (w.hidden) return;
    if (!$('dialog-modal').hidden || !$('info-modal').hidden || window.PlanViewer.isOpen()) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    const btn = w.querySelector(`.qw-opt[data-hotkey="${e.key}"]`);
    if (!btn || btn.disabled) return;
    e.preventDefault();
    answerCurrentQuestion(btn.dataset.opt);
  });

  // «Журнал этапов»: раскрытием управляет только пользователь — состояние
  // запоминается и не сбрасывается опросом (закрыли — остаётся закрытым)
  const logDetails = $('events-details');
  logDetails.open = localStorage.getItem(LOG_OPEN_KEY) === '1';
  logDetails.addEventListener('toggle', () => {
    localStorage.setItem(LOG_OPEN_KEY, logDetails.open ? '1' : '0');
  });

  // раскрывашки этапов больше нет: список живёт в разделе «Этапы» настроек,
  // и сам раздел ею и является — вторая внутри выглядела бы двойным сворачиванием

  // /health с повторами: без него интерфейс не наполнить
  for (let attempt = 1; ; attempt++) {
    try {
      await loadHealth();
      break;
    } catch (err) {
      if (!err.offline) toast(`Сервер сейчас недоступен — повторная попытка через ${Math.min(15, 3 * attempt)} с`, 'error');
      await new Promise((r) => setTimeout(r, Math.min(15000, 3000 * attempt)));
    }
  }
  // периодическое обновление доступности провайдеров (LM Studio мог включиться/выключиться)
  setInterval(() => { if (!state.offline) loadHealth().catch(() => {}); }, 60000);
  await restoreOrCreate().catch((err) => toast(err.message, 'error'));

  $('btn-new-session-side').addEventListener('click', startNewSession);

  initSessionsList();
  setInterval(() => loadDeviceSessions().catch(() => {}), 30000);
  $('btn-cancel-job').addEventListener('click', cancelJob);

  const dz = $('dropzone');
  const fi = $('file-input');
  dz.addEventListener('click', () => fi.click());
  dz.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fi.click(); } });
  fi.addEventListener('change', () => { uploadFiles(fi.files); fi.value = ''; });
  ['dragover', 'dragenter'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('dragover'); }));
  ['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('dragover'); }));
  dz.addEventListener('drop', (e) => uploadFiles(e.dataTransfer.files));

  // каскад выбора: провайдер → модель
  $('sel-provider').addEventListener('change', () => {
    const provider = $('sel-provider').value;
    const p = provider ? providerInfo(provider) : null;
    fillModelSelect(provider, p && p.models.length ? p.models[0] : '');
    const { model } = currentPick();
    saveSettings({ aiProvider: provider, aiModel: provider ? model : '' });
  });
  $('sel-model').addEventListener('change', () => {
    updateModelNote();
    saveSettings({ aiProvider: $('sel-provider').value, aiModel: $('sel-model').value });
  });
  $('sel-kb').addEventListener('change', () => saveSettings({ kbChoice: $('sel-kb').value }));

  // порядок работы (Excel)
  $('btn-workplan-download').addEventListener('click', () => downloadWorkplan());
  $('btn-workplan-upload').addEventListener('click', () => $('workplan-file').click());
  $('workplan-file').addEventListener('change', async () => {
    const f = $('workplan-file').files[0];
    $('workplan-file').value = '';
    if (!f || !state.session) return;
    const fd = new FormData();
    fd.append('file', f);
    try {
      const res = await api(`/sessions/${state.session.id}/workplan`, { method: 'POST', body: fd });
      toast(`Порядок работы загружен: шагов — ${res.steps.length}`);
      await refresh();
    } catch (err) { toast(err.message, 'error'); }
  });
  $('btn-workplan-reset').addEventListener('click', async () => {
    try {
      await api(`/sessions/${state.session.id}/workplan`, { method: 'DELETE' });
      toast('Возвращён стандартный порядок работы');
      await refresh();
    } catch (err) { toast(err.message, 'error'); }
  });

  $('btn-compare').addEventListener('click', async () => {
    const models = selectedCompareModels();
    try {
      await api(`/sessions/${state.session.id}/compare`, { method: 'POST', json: { models } });
      toast(`Сравнение ${models.length} моделей запущено — это займёт несколько минут`);
      await refresh();
    } catch (err) { toast(err.message, 'error'); }
  });

  $('btn-process').addEventListener('click', async () => {
    // блокируем СИНХРОННО: пока летит запрос, повторное нажатие запускало
    // ещё один полноценный (и платный) прогон
    if (state.processing) return;
    state.processing = true;
    $('btn-process').disabled = true;
    try {
      await api(`/sessions/${state.session.id}/process`, { method: 'POST', json: {} });
      toast('Обработка запущена');
    } catch (err) { toast(err.message, 'error'); } finally {
      await refresh().catch(() => {});
      state.processing = false;
      render();
    }
  });

  $('chat-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = $('chat-input').value.trim();
    if (!text) return;
    try {
      const res = await api(`/sessions/${state.session.id}/messages`, { method: 'POST', json: { text } });
      $('chat-input').value = '';
      if (res && res.queued) toast('Сообщение принято — отвечу, как освобожусь');
      await refresh();
    } catch (err) { toast(err.message, 'error'); }
  });

  document.body.addEventListener('click', async (e) => {
    // карточки согласования в ленте
    const openPlan = e.target.closest('[data-open-plan]');
    if (openPlan) {
      // «показать на плане» из подсказки несёт идентификаторы объектов —
      // без них человек искал бы нужную линию среди шестидесяти девяти глазами
      const focus = (openPlan.dataset.focus || '').split(',').filter(Boolean);
      window.PlanViewer.open(api, state.session, { focus });
      return;
    }
    const stageBtn = e.target.closest('[data-stage-act]');
    if (stageBtn) {
      stageBtn.disabled = true;
      await stageAction(stageBtn.dataset.stageAct);
      stageBtn.disabled = false;
      return;
    }
    const decideBtn = e.target.closest('[data-decide]');
    if (decideBtn) {
      decideBtn.disabled = true;
      await decideAction(decideBtn.dataset.decide, decideBtn.dataset.decision);
      decideBtn.disabled = false;
      return;
    }
    const pick = e.target.closest('[data-pick-variant]');
    if (pick) {
      try {
        await api(`/sessions/${state.session.id}/plan/variants/${pick.dataset.pickVariant}/select`, { method: 'POST', json: {} });
        state.run = await api(`/sessions/${state.session.id}/plan/variants`);
        render();
      } catch (err) { toast(err.message, 'error'); }
      return;
    }

    const delBtn = e.target.closest('[data-del-file]');
    if (delBtn) {
      try {
        await api(`/sessions/${state.session.id}/files/${delBtn.dataset.delFile}`, { method: 'DELETE' });
        await refresh();
      } catch (err) { toast(err.message, 'error'); }
      return;
    }
    const dlBtn = e.target.closest('[data-download]');
    if (dlBtn) download(dlBtn.dataset.download, dlBtn.dataset.name);
  });
}

init();
