'use strict';
/**
 * Общий каркас всех страниц платформы (2026-09-02): «сначала проект, потом модуль».
 *
 * Подключается на КАЖДОЙ странице перед её собственным скриптом и строит хром
 * синхронно, до того как app.js/tz.js/… начнут искать свои узлы: капсулу
 * (варианты b/c/d), панель проектов (вариант a), навигацию по шести модулям,
 * блок человека (#user-box) и индикатор нейросети (#ai-badge). DOM один, а
 * раскладку выбирает атрибут html[data-view] (shell.css).
 *
 * Контекст проекта — ?project=<id> в адресе каждой страницы. Страница-модуль
 * без проекта уходит на список проектов: модуль вне проекта не существует.
 *
 * Данные (список проектов со сводкой, /health) приходят после входа:
 * страница зовёт EnsoShell.start() после window.Auth.start(); если забыла —
 * каркас дождётся токена сам.
 */
(function () {
  const VIEW_KEY = 'enso-pilot1-view';
  const VIEWS = { a: 'Досье', b: 'Стол проекта', c: 'Лента', d: 'Штамп' };
  const DEFAULT_VIEW = 'b';
  const ID_RE = /^[\w-]{1,64}$/;

  /** Порядок модулей — порядок надобности проекту. Ключи общие с сервером. */
  const MODULES = [
    { key: 'tz', n: 1, name: 'Анализ ТЗ', sub: 'Задание на проектирование', href: '/tz.html' },
    { key: 'site', n: 2, name: 'Посадка здания', sub: 'Исходные данные, ограничения, пятно, чертёж', href: '/', query: 'module=site' },
    { key: 'doc', n: 3, name: 'Проверка документа', sub: 'Разделы по мере готовности · замена A→B', href: '/doccheck.html' },
    { key: 'normo', n: 4, name: 'Нормоконтроль', sub: 'Комплект документации целиком', href: '/normo.html' },
    { key: 'gge', n: 5, name: 'Контроль ГГЭ', sub: 'Реквизиты и формат перед экспертизой', href: '/gge.html' },
    { key: 'akty', n: 6, name: 'Акты (АОСР)', sub: 'Исполнительная документация на стройке', href: '/akty.html' },
  ];
  const PLATFORM = [
    { key: 'dataset', name: 'Датасет' },
    { key: 'stats', name: 'Статистика' },
    { key: 'settings', name: 'Настройки' },
  ];

  const svg = (inner, extra = '') => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"${extra}>${inner}</svg>`;
  const DOC = '<path d="M6 3h9l4 4v14H6z" stroke-linejoin="round"/><path d="M15 3v4h4"/>';
  const ICONS = {
    tz: DOC + '<path d="M9 12h6M9 16h4" stroke-linecap="round"/>',
    site: '<path d="M4 5h16v12H4z" stroke-linejoin="round"/><path d="M8 21h8M12 17v4"/><path d="M8 9l3 3 2-2 3 3" stroke-linecap="round" stroke-linejoin="round"/>',
    doc: DOC + '<circle cx="11" cy="13" r="3.2"/><path d="M13.4 15.4L16 18" stroke-linecap="round"/>',
    normo: DOC + '<path d="M9.5 14.5l2 2 3.5-4" stroke-linecap="round" stroke-linejoin="round"/>',
    gge: DOC + '<path d="M9 13l2 2 4-5" stroke-linecap="round" stroke-linejoin="round"/><path d="M9 18h6" stroke-linecap="round"/>',
    akty: DOC + '<path d="M9 12h6M9 16h6M9 8h3" stroke-linecap="round"/>',
    back: '<path d="M14 6l-6 6 6 6" stroke-linecap="round" stroke-linejoin="round"/>',
    chev: '<path d="M6 9l6 6 6-6" stroke-linecap="round" stroke-linejoin="round"/>',
    plus: '<path d="M12 5v14M5 12h14" stroke-linecap="round"/>',
    out: '<path d="M15 17v1.5A1.5 1.5 0 0 1 13.5 20h-7A1.5 1.5 0 0 1 5 18.5v-13A1.5 1.5 0 0 1 6.5 4h7A1.5 1.5 0 0 1 15 5.5V7" stroke-linecap="round" stroke-linejoin="round"/><path d="M10 12h10m0 0l-3-3m3 3l-3 3" stroke-linecap="round" stroke-linejoin="round"/>',
    dataset: '<path d="M4 6c0-1.5 3.6-2.5 8-2.5s8 1 8 2.5-3.6 2.5-8 2.5S4 7.5 4 6z" stroke-linejoin="round"/><path d="M4 6v6c0 1.5 3.6 2.5 8 2.5s8-1 8-2.5V6" stroke-linecap="round"/><path d="M4 12v6c0 1.5 3.6 2.5 8 2.5s8-1 8-2.5v-6" stroke-linecap="round"/>',
    stats: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2" stroke-linecap="round"/>',
    settings: '<circle cx="12" cy="12" r="3.1"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1" stroke-linecap="round"/>',
    toggle: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M9.5 4v16"/>',
    arrowRight: '<path d="M5 12h13M13 6l6 6-6 6" stroke-linecap="round" stroke-linejoin="round"/>',
  };

  const params = new URLSearchParams(location.search);
  const normId = (v) => (ID_RE.test(String(v || '').trim()) ? String(v).trim() : '');
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  let view = DEFAULT_VIEW;
  try { const v = localStorage.getItem(VIEW_KEY); if (VIEWS[v]) view = v; } catch { /* приватный режим */ }

  const state = {
    view,
    page: document.body.dataset.page || 'module',       // index | module
    module: document.body.dataset.module || '',         // tz | site | doc | normo | gge | akty | ''
    screen: '',                                          // index: projects | hub | analysis | settings | stats | dataset
    projectId: normId(params.get('project')),
    project: null,
    projects: [],
    health: null,
    started: false,
    projectsError: false,   // список проектов не получен (обрыв, перезапуск сервера)
    sig: '',                // подпись последних данных: перерисовка только при изменении
  };
  let readyResolve;
  const ready = new Promise((r) => { readyResolve = r; });

  const $ = (id) => document.getElementById(id);

  function fmtDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;
  }
  function moduleHref(m, pid = state.projectId) {
    const q = [`project=${encodeURIComponent(pid)}`];
    if (m.query) q.push(m.query);
    return `${m.href}?${q.join('&')}`;
  }
  function platformHref(key) {
    return `/?screen=${key}${state.projectId ? `&project=${encodeURIComponent(state.projectId)}` : ''}`;
  }
  function projectHref(pid) {
    // со страницы модуля — тот же модуль в другом проекте, с главной — стол проекта
    if (state.page === 'module') {
      const m = MODULES.find((x) => x.key === state.module);
      if (m) return moduleHref(m, pid);
    }
    return `/?project=${encodeURIComponent(pid)}`;
  }
  const started = (s) => s && s.state !== 'none';
  const projectBar = (p) => `<span class="pc-bar">${MODULES.map((m) => `<span data-state="${esc((p.summary && p.summary[m.key] && p.summary[m.key].state) || 'none')}"></span>`).join('')}</span>`;

  /* ---------------- построение хрома: синхронно, до скриптов страницы ---------------- */

  function build() {
    document.documentElement.dataset.view = state.view;
    const chrome = $('chrome');
    if (!chrome) return;
    chrome.innerHTML = `
      <button id="sidebar-toggle" class="sidebar-toggle" type="button" aria-expanded="true" aria-controls="sidebar"
              aria-label="Свернуть боковую панель" title="Свернуть панель (⌘\\ или Ctrl+\\)">${svg(ICONS.toggle)}</button>
      <div class="mobile-bar"><span class="brand-name">Enso-nexus</span></div>
      <button id="sidebar-scrim" class="sidebar-scrim" type="button" tabindex="-1" aria-label="Закрыть боковую панель" hidden></button>
      <aside class="sidebar" id="sidebar" aria-label="Проекты">
        <div class="brand"><a class="brand-name" href="/" style="color:inherit;text-decoration:none">Enso-nexus</a></div>
        <a id="sb-new-project" class="btn btn-quiet sb-new" href="/?new=1">${svg(ICONS.plus)}Новый проект</a>
        <div class="sb-projects">
          <p class="sessions-head">Проекты</p>
          <ul id="sb-projects-list" class="sb-list"></ul>
        </div>
        <div class="sidebar-foot" id="sb-foot">
          <nav class="sb-platform" id="sb-platform" aria-label="Платформа"></nav>
        </div>
      </aside>
      <header id="topbar" class="topbar glass-bar">
        <a class="tb-brand" href="/" title="Все проекты">${svg(ICONS.back)}<span class="brand-name">Enso-nexus</span></a>
        <span class="tb-sep">/</span>
        <div class="tb-project" id="tb-project">
          <button id="tb-switch" class="tb-switch" type="button" aria-expanded="false" aria-controls="tb-menu">Проекты ${svg(ICONS.chev)}</button>
          <div id="tb-menu" class="tb-menu" hidden></div>
        </div>
        <span class="tb-sep tb-sep-module">/</span>
        <span id="module-pill" class="module-pill"></span>
        <span class="tb-spacer"></span>
        <nav class="tb-platform" id="tb-platform" aria-label="Платформа"></nav>
      </header>
      <nav id="module-nav" class="module-nav" aria-label="Модули проекта"></nav>
      <div id="ai-badge" class="ai-badge" title="Действующая нейросеть"><span class="ai-dot" aria-hidden="true"></span><span id="ai-badge-text">Подключение…</span></div>
      <div id="user-box" class="user-box" hidden>
        <span class="user-avatar" id="user-initials" aria-hidden="true"></span>
        <span class="user-name" id="user-name"></span>
        <button id="btn-sign-out" class="icon-btn user-out" type="button" aria-label="Выйти из записи" title="Выйти из записи">${svg(ICONS.out)}</button>
      </div>
      <div id="sheet-stamp" class="sheet-stamp" aria-hidden="true"></div>`;

    const content = $('content');
    if (content) {
      const head = document.createElement('div');
      head.id = 'project-head';
      head.className = 'project-head';
      head.innerHTML = '<div class="ph-text" id="ph-text"></div>';
      content.prepend(head);
    }
    slot();
    renderPlatformLinks();
  }

  /** Раскладка общих узлов по варианту: один DOM, четыре места. */
  function slot() {
    const nav = $('module-nav'); const ai = $('ai-badge'); const user = $('user-box'); const stamp = $('sheet-stamp');
    const topbar = $('topbar'); const head = $('project-head'); const foot = $('sb-foot'); const content = $('content');
    if (!nav || !topbar) return;
    if (state.view === 'a') {
      if (head) head.append(nav);
      if (foot) foot.append(ai, user);
    } else {
      if (state.view === 'b') $('module-pill').after(nav);
      else if (state.view === 'c') { if (head) head.prepend(nav); }
      else topbar.after(nav);
      topbar.append(ai, user);
    }
    if (content && stamp) content.append(stamp);
  }

  function applyView(v) {
    if (!VIEWS[v]) return;
    state.view = v;
    try { localStorage.setItem(VIEW_KEY, v); } catch { /* приватный режим */ }
    document.documentElement.dataset.view = v;
    slot();
    renderAll();
  }

  /* ---------------- данные ---------------- */

  function headers() {
    const h = {};
    if (window.Auth && window.Auth.token) h['X-User-Token'] = window.Auth.token;
    return h;
  }
  async function getJson(url) {
    const res = await fetch(url, { headers: headers(), cache: 'no-store' });
    let data = null;
    try { data = await res.json(); } catch { data = null; }
    if (!res.ok) {
      if (data && data.needLogin) { localStorage.removeItem('enso-pilot1-auth'); location.reload(); }
      throw new Error((data && data.error) || `Ошибка сервера (${res.status})`);
    }
    return data;
  }

  async function reload() {
    const [projects, health] = await Promise.all([
      getJson('/api/projects').then((d) => d.projects || []).catch(() => null),
      getJson('/api/health').catch(() => null),
    ]);
    state.projectsError = projects === null;
    if (projects) {
      state.projects = projects;
      state.project = state.projectId ? projects.find((p) => p.id === state.projectId) || null : null;
    }
    if (health) state.health = health;
    // главная опрашивает список каждые полминуты: без изменений DOM не трогаем,
    // иначе каждые 30 с теряется фокус и скринридер читает список заново
    const sig = JSON.stringify([state.projects, state.projectId, state.projectsError,
      health && health.aiMode, health && health.model, health && health.dataset]);
    const changed = sig !== state.sig;
    state.sig = sig;
    if (changed) renderAll();
    document.dispatchEvent(new CustomEvent('enso:project', { detail: { project: state.project, projects: state.projects, changed } }));
    return changed;
  }

  /** Список не получен: пробуем снова, пока не получим; тогда уже решаем про редирект. */
  function retryLater() {
    setTimeout(async () => {
      await reload();
      if (state.projectsError) { retryLater(); return; }
      if (state.page === 'module' && state.module && !state.project) goMissing();
    }, 10000);
  }
  function goMissing() {
    location.replace(`/?goto=${encodeURIComponent(state.module)}&missing=${encodeURIComponent(state.projectId)}`);
  }

  async function start() {
    if (state.started) return ready;
    state.started = true;
    renderUser();
    await reload();
    if (state.page === 'module' && state.module && !state.project) {
      if (state.projectsError) {
        // список проектов не получен (обрыв связи, перезапуск сервера): остаёмся на
        // месте с открытым hash-маршрутом и пробуем снова — уходить нельзя
        retryLater();
      } else {
        // проекта нет в списке (удалён или выдуман): проект выбирают на главной
        goMissing();
        return ready;
      }
    }
    readyResolve(state);
    return ready;
  }

  /* ---------------- отрисовка ---------------- */

  function renderAll() {
    renderUser();
    renderAi();
    renderSwitcher();
    renderSidebarProjects();
    renderModuleNav();
    renderPill();
    renderHead();
    renderPlatformLinks();
    renderStamp();
    renderTitle();
  }

  function renderUser() {
    const box = $('user-box');
    if (!box) return;
    const u = (window.Auth && window.Auth.user) || null;
    if (!u || !window.Auth.requireLogin) { box.hidden = true; return; }
    const last = String(u.lastName || '').trim();
    const first = String(u.firstName || '').trim();
    box.hidden = false;
    $('user-name').textContent = `${last} ${first}`.trim();
    $('user-initials').textContent = `${last.slice(0, 1)}${first.slice(0, 1)}`.toUpperCase();
  }

  /** Индикатор нейросети: на главной его перерисует app.js своим выбором проекта. */
  function renderAi() {
    const h = state.health;
    const badge = $('ai-badge');
    if (!h || !badge || state.page === 'index') return;
    const mode = h.aiMode || 'mock';
    const model = h.model || '';
    // те же слова, что у бейджа на главной (app.js updateAiBadge)
    const text = mode === 'mock' ? 'ДЕМО-РЕЖИМ'
      : mode === 'local' ? `Локальная модель: ${model}` : model || 'Облачная модель';
    $('ai-badge-text').textContent = text;
    badge.dataset.mode = mode;
    badge.title = `Действующая нейросеть: ${text}`;
  }

  function renderSwitcher() {
    const btn = $('tb-switch'); const menu = $('tb-menu');
    if (!btn || !menu) return;
    btn.innerHTML = `${esc(state.project ? state.project.name : 'Проекты')} ${svg(ICONS.chev)}`;
    btn.title = state.project ? (state.project.full_name || state.project.name) : 'Выбрать проект';
    if (!menu.hidden) return; // открытое меню не пересобираем под курсором
    const items = [`<a href="/"><span class="tm-name">Все проекты</span></a>`, '<div class="tm-sep"></div>'];
    for (const p of state.projects) {
      const active = state.project && p.id === state.project.id;
      items.push(`<a href="${esc(projectHref(p.id))}" class="${active ? 'tm-active' : ''}">
        <span class="tm-name">${esc(p.name)}</span>
        <span class="tm-meta">${esc([p.stage, p.client].filter(Boolean).join(' · ') || p.full_name || '')}</span></a>`);
    }
    if (!state.projects.length) items.push('<span class="tm-meta" style="padding:8px 10px">Проектов пока нет</span>');
    items.push('<div class="tm-sep"></div>', `<a href="/?new=1" id="tb-new-project"><span class="tm-name">Новый проект</span></a>`);
    menu.innerHTML = items.join('');
  }

  function renderSidebarProjects() {
    const list = $('sb-projects-list');
    if (!list) return;
    list.innerHTML = state.projects.map((p) => `<li><a class="sb-item ${state.project && p.id === state.project.id ? 'active' : ''}" href="${esc(projectHref(p.id))}">
      <span class="sb-name">${esc(p.name)}</span>
      <span class="sb-meta">${esc([p.stage, p.client].filter(Boolean).join(' · ') || p.full_name || '')}</span>
      ${projectBar(p)}</a></li>`).join('');
  }

  function renderModuleNav() {
    const nav = $('module-nav');
    if (!nav) return;
    if (!state.project) { nav.innerHTML = ''; return; }
    const sum = state.project.summary || {};
    nav.innerHTML = MODULES.map((m) => {
      const s = sum[m.key] || { state: 'none', line: '' };
      const active = state.module === m.key;
      return `<a class="mn-item ${active ? 'active' : ''}" data-module="${m.key}" data-state="${esc(s.state)}"
          href="${esc(moduleHref(m))}" title="${esc(`${m.n} · ${m.name}${s.line ? ` — ${s.line}` : ''}`)}" ${active ? 'aria-current="page"' : ''}>
        <span class="mn-head"><span class="mn-num">${m.n}</span><span class="mn-name">${esc(m.name)}</span></span>
        <span class="mn-body"><span class="mn-dot"></span><span class="mn-line">${esc(s.line)}</span></span>
      </a>`;
    }).join('');
  }

  function activeModule() { return MODULES.find((m) => m.key === state.module) || null; }

  function renderPill() {
    const pill = $('module-pill');
    if (!pill) return;
    const m = activeModule();
    pill.textContent = m && state.project ? `${m.n} · ${m.name}` : '';
  }

  function renderHead() {
    const box = $('ph-text');
    if (!box) return;
    const p = state.project;
    const m = activeModule();
    const head = $('project-head');
    const done = () => {
      // пустой блок не должен занимать место (у него margin-bottom)
      const nav = $('module-nav');
      const navHere = nav && nav.parentElement === head && nav.innerHTML.trim();
      if (head) head.hidden = !box.innerHTML.trim() && !navHere;
    };
    if (!p) {
      box.innerHTML = state.projectsError && state.projectId
        ? '<p class="ph-line ph-error">Список проектов не получен — сводка недоступна, повторю через 10 с</p>'
        : '';
      done();
      return;
    }
    if (state.page === 'index' && state.screen === 'hub') {
      const meta = [p.client, p.stage, p.created_at ? `начат ${fmtDate(p.created_at)}` : ''].filter(Boolean).join(' · ');
      box.innerHTML = `<div>
          <p class="ph-eyebrow">${esc(meta || 'Проект')}</p>
          <h1 class="ph-name">${esc(p.name)}</h1>
          ${p.full_name ? `<p class="ph-full">${esc(p.full_name)}</p>` : ''}
        </div>
        <div class="ph-actions" id="ph-actions"></div>`;
      document.dispatchEvent(new CustomEvent('enso:head'));
    } else if (m) {
      box.innerHTML = `<p class="ph-line">${esc(p.name)} · модуль ${m.n} из 6</p>`;
    } else {
      box.innerHTML = '';
    }
    done();
  }

  function renderPlatformLinks() {
    const allowed = (key) => key !== 'dataset' || (state.health && state.health.dataset && state.health.dataset.allowed);
    const html = PLATFORM.filter((x) => allowed(x.key)).map((x) => `<a href="${esc(platformHref(x.key))}" class="${state.screen === x.key ? 'active' : ''}" title="${esc(x.name)}">${svg(ICONS[x.key])}<span>${esc(x.name)}</span></a>`).join('');
    for (const id of ['tb-platform', 'sb-platform']) { const el = $(id); if (el) el.innerHTML = html; }
  }

  /** Основная надпись листа (вариант d): объект, заказчик, раздел, исполнитель, дата. */
  function renderStamp() {
    const st = $('sheet-stamp');
    if (!st) return;
    const p = state.project; const m = activeModule();
    const u = (window.Auth && window.Auth.user) || null;
    const who = u ? `${u.lastName || ''} ${u.firstName || ''}`.trim() : '';
    const today = fmtDate(new Date().toISOString());
    const rows = p
      ? [['Объект', p.full_name || p.name, 'Стадия', p.stage || '—'],
        ['Заказчик', p.client || '—', 'Модуль', m ? `${m.n} / 6` : '—'],
        ['Раздел', m ? m.name : (state.screen === 'hub' ? 'Стол проекта' : 'Лист'), 'Начат', fmtDate(p.created_at) || '—'],
        ['Исполнитель', who || '—', 'Дата', today]]
      : [['Платформа', 'Enso-nexus', 'Листов', '1'],
        ['Документ', state.screen === 'settings' ? 'Настройки' : state.screen === 'stats' ? 'Статистика' : state.screen === 'dataset' ? 'Датасет' : 'Ведомость проектов', 'Лист', '1'],
        ['Исполнитель', who || '—', 'Дата', today]];
    st.innerHTML = `<div class="st-grid">${rows.map(([k, v, k2, v2]) =>
      `<div class="st-k">${esc(k)}</div><div class="st-v" title="${esc(v)}">${esc(v)}</div><div class="st-k">${esc(k2)}</div><div class="st-v">${esc(v2)}</div>`).join('')}</div>`;
  }

  function renderTitle() {
    const m = activeModule();
    const parts = [];
    if (m && state.project) parts.push(m.name);
    else if (state.screen === 'settings') parts.push('Настройки');
    else if (state.screen === 'stats') parts.push('Статистика');
    else if (state.screen === 'dataset') parts.push('Датасет');
    if (state.project) parts.push(state.project.name);
    else if (!m) parts.push('Проекты');
    parts.push('Enso-nexus');
    document.title = parts.join(' — ');
  }

  /* ---------------- поведение ---------------- */

  function wire() {
    const btn = $('tb-switch'); const menu = $('tb-menu');
    if (btn && menu) {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        menu.hidden = !menu.hidden;
        btn.setAttribute('aria-expanded', String(!menu.hidden));
      });
      document.addEventListener('click', (e) => {
        if (!menu.hidden && !e.target.closest('#tb-project')) { menu.hidden = true; btn.setAttribute('aria-expanded', 'false'); }
      });
      document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !menu.hidden) { menu.hidden = true; btn.setAttribute('aria-expanded', 'false'); } });
    }
    // на главной панелью, выходом и темой управляет app.js; на модулях — каркас
    if (state.page !== 'index') {
      const signOut = $('btn-sign-out');
      if (signOut) {
        signOut.addEventListener('click', async () => {
          // то же подтверждение, что на главной (app.js signOut)
          const ok = await confirmDialog({ title: 'Выйти из записи?', message: 'Проекты и загруженные файлы останутся на месте.', confirmText: 'Выйти' });
          if (ok && window.Auth) window.Auth.signOut();
        });
      }
      const shell = $('shell'); const toggle = $('sidebar-toggle'); const scrim = $('sidebar-scrim');
      const narrow = () => window.matchMedia('(max-width: 800px)').matches;
      const stored = () => { try { return localStorage.getItem('enso-pilot1-sidebar') === '1'; } catch { return false; } };
      const apply = (collapsed) => {
        shell.classList.toggle('sidebar-collapsed', collapsed);
        toggle.setAttribute('aria-expanded', String(!collapsed));
        toggle.setAttribute('aria-label', collapsed ? 'Показать боковую панель' : 'Свернуть боковую панель');
        toggle.title = `${collapsed ? 'Показать' : 'Свернуть'} панель (⌘\\ или Ctrl+\\)`;
        scrim.hidden = collapsed || !narrow();
      };
      apply(narrow() ? true : stored());
      const toggleSidebar = () => {
        const collapsed = !shell.classList.contains('sidebar-collapsed');
        apply(collapsed);
        if (!narrow()) { try { localStorage.setItem('enso-pilot1-sidebar', collapsed ? '1' : '0'); } catch { /* приватный режим */ } }
      };
      toggle.addEventListener('click', toggleSidebar);
      scrim.addEventListener('click', () => apply(true));
      document.addEventListener('keydown', (e) => {
        if (e.key === '\\' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); toggleSidebar(); }
        if (e.key === 'Escape' && narrow() && !shell.classList.contains('sidebar-collapsed')) apply(true);
      });
      window.matchMedia('(max-width: 800px)').addEventListener('change', (e) => apply(e.matches ? true : stored()));
    }
    // страница забыла позвать start(): дождаться токена и стартовать самим
    let tries = 0;
    const tick = () => {
      if (state.started) return;
      // вход выключен на сервере (REQUIRE_LOGIN=0) — токена не будет, стартуем без него
      if (window.Auth && (window.Auth.token || window.Auth.requireLogin === false)) { start(); return; }
      if (tries++ < 60) setTimeout(tick, 500);
    };
    setTimeout(tick, 800);
  }

  /* ---------------- диалог подтверждения/ввода: один на все страницы ---------------- */

  let dialogResolve = null;
  function ensureDialog() {
    let box = $('shell-dialog');
    if (box) return box;
    box = document.createElement('div');
    box.id = 'shell-dialog';
    box.className = 'modal-backdrop';
    box.hidden = true;
    box.innerHTML = `<div class="modal modal-sm" role="dialog" aria-modal="true" aria-labelledby="shell-dialog-title">
      <div class="modal-head"><h3 id="shell-dialog-title"></h3></div>
      <form class="modal-body" id="shell-dialog-form" novalidate>
        <p id="shell-dialog-message" class="dialog-message" hidden></p>
        <div id="shell-dialog-fields" class="dialog-fields"></div>
      </form>
      <div class="dialog-foot">
        <button id="shell-dialog-cancel" class="btn btn-quiet" type="button">Отмена</button>
        <button id="shell-dialog-ok" class="btn btn-primary" type="button">ОК</button>
      </div></div>`;
    document.body.append(box);
    const close = (result) => { box.hidden = true; if (dialogResolve) { dialogResolve(result); dialogResolve = null; } };
    const values = () => { const out = {}; for (const inp of box.querySelectorAll('input')) out[inp.dataset.key] = inp.value.trim(); return out; };
    $('shell-dialog-ok').addEventListener('click', () => close(values()));
    $('shell-dialog-cancel').addEventListener('click', () => close(null));
    $('shell-dialog-form').addEventListener('submit', (e) => { e.preventDefault(); close(values()); });
    box.addEventListener('click', (e) => { if (e.target === box) close(null); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !box.hidden) close(null); });
    return box;
  }
  /** Тот же контракт, что appDialog в app.js: null — отмена, объект полей — подтверждение. */
  function dialog({ title, message = '', fields = [], confirmText = 'ОК', cancelText = 'Отмена', danger = false }) {
    if (window.appDialog) return window.appDialog({ title, message, fields, confirmText, cancelText, danger });
    const box = ensureDialog();
    return new Promise((resolve) => {
      if (dialogResolve) dialogResolve(null);
      dialogResolve = resolve;
      $('shell-dialog-title').textContent = title;
      $('shell-dialog-message').textContent = message;
      $('shell-dialog-message').hidden = !message;
      const wrap = $('shell-dialog-fields');
      wrap.innerHTML = '';
      fields.forEach((f, i) => {
        const label = document.createElement('label');
        const caption = document.createElement('span'); caption.textContent = f.label || '';
        const input = document.createElement('input');
        input.type = 'text'; input.value = f.value || ''; input.maxLength = f.maxLength || 300;
        if (f.placeholder) input.placeholder = f.placeholder;
        input.dataset.key = f.key || String(i);
        label.append(caption, input); wrap.append(label);
      });
      wrap.hidden = !fields.length;
      $('shell-dialog-ok').textContent = confirmText;
      $('shell-dialog-cancel').textContent = cancelText;
      $('shell-dialog-ok').classList.toggle('btn-danger', danger);
      $('shell-dialog-ok').classList.toggle('btn-primary', !danger);
      box.hidden = false;
      const first = wrap.querySelector('input');
      if (first) { first.focus(); first.select(); } else $('shell-dialog-ok').focus();
    });
  }
  const confirmDialog = async (opts) => (await dialog(opts)) !== null;
  const promptDialog = async ({ title, label, value = '', placeholder = '', confirmText = 'Сохранить', maxLength }) => {
    const r = await dialog({ title, fields: [{ key: 'v', label, value, placeholder, maxLength }], confirmText });
    return r === null ? null : r.v;
  };

  build();
  wire();

  window.EnsoShell = {
    VIEWS, MODULES, ready, start, reload, applyView,
    get view() { return state.view; },
    get projectId() { return state.projectId; },
    get project() { return state.project; },
    get projects() { return state.projects; },
    get module() { return state.module; },
    get health() { return state.health; },
    get projectsError() { return state.projectsError; },
    get screen() { return state.screen; },
    setModule(key) { state.module = key || ''; renderAll(); },
    setScreen(name) { state.screen = name || ''; renderAll(); },
    setProject(p) { state.project = p; if (p) { const i = state.projects.findIndex((x) => x.id === p.id); if (i >= 0) state.projects[i] = p; } renderAll(); },
    renderUser,
    moduleHref: (key, pid) => { const m = MODULES.find((x) => x.key === key); return m ? moduleHref(m, pid || state.projectId) : '/'; },
    projectHref: (pid) => `/?project=${encodeURIComponent(pid)}`,
    fmtDate, esc, svg, ICONS, headers, getJson,
    dialog, confirm: confirmDialog, prompt: promptDialog,
  };
})();
