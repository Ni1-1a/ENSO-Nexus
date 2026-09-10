'use strict';
/**
 * Модуль «Анализ ТЗ» — отдельная страница /tz.html.
 *
 * Вход общий с платформой: auth.js кладёт токен человека в localStorage,
 * сюда он приходит через window.Auth и уходит на сервер заголовком
 * X-User-Token — все маршруты /api/tz требуют его.
 *
 * Экраны — состояния одной страницы, адрес — в hash:
 *   #/        список проектов
 *   #/p/:id   карточка проекта (документ, настройки, прогоны)
 *   #/r/:rid  прогон: прогресс, затем отчёт с находками и решениями
 */
(function () {
  const $ = (id) => document.getElementById(id);
  // контекст проекта платформы: ?project=<id> в адресе, читает общий каркас
  const projectId = () => (window.EnsoShell && window.EnsoShell.projectId) || '';
  const projectQuery = () => (projectId() ? `?project=${encodeURIComponent(projectId())}` : '');


  const SEV_ORDER = ['БЛОКЕР', 'СУЩЕСТВЕННО', 'ЗАМЕЧАНИЕ', 'РЕКОМЕНДАЦИЯ'];
  const RUN_LABEL = { queued: 'в очереди', running: 'идёт', done: 'готово', failed: 'ошибка' };
  const CAT_LABEL = {
    'полнота': 'полнота', 'формулировка': 'формулировка', 'противоречие': 'противоречие',
    'нормативная_база': 'нормативная база', 'ИРД': 'ИРД', 'формат_XML': 'формат XML',
  };

  const state = {
    fixes: {},          // правки прогона: findingId → {variants, chosenText, …}
    fixDrafts: {},      // ненабранное «своё» по замечаниям: перерисовка списка его не стирает
    fixesLoaded: false, // правки прогона уже пришли с сервера (иначе блок не рисуем)
    route: { name: 'projects' },
    providers: [],          // из /api/health — уже отфильтровано по человеку и адресу
    checklists: [],         // из /api/tz/meta
    project: null,
    runs: [],
    run: null,
    filters: { severity: '', category: '' },
  };
  let pollTimer = null;

  /* ---------------- помощники ---------------- */

  function h(tag, attrs, ...kids) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) {
      if (kid === null || kid === undefined) continue;
      node.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return node;
  }

  let toastTimer = null;
  function toast(text, type = 'info') {
    const el = $('toast');
    el.textContent = text;
    el.dataset.type = type;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, type === 'error' ? 6000 : 3000);
  }

  function fmtDateTime(value) {
    if (!value) return '—';
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? String(value)
      : `${d.toLocaleDateString('ru-RU')} ${d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`;
  }

  /** «104 знака» для коротких текстов, «46 тыс. знаков» для длинных. */
  function fmtChars(n) {
    const num = Number(n) || 0;
    return num < 10000 ? `${num} знак.` : `${Math.round(num / 1000)} тыс. знаков`;
  }

  function saveBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  }

  function userHeaders() {
    const hh = {};
    if (window.Auth && window.Auth.token) hh['X-User-Token'] = window.Auth.token;
    return hh;
  }

  async function api(path, options = {}) {
    const headers = Object.assign(userHeaders(), options.headers);
    if (options.json !== undefined) {
      headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(options.json);
    }
    let res;
    try {
      res = await fetch(`/api/tz${path}`, { ...options, headers });
    } catch {
      const e = new Error('Сервер сейчас недоступен — попробуйте чуть позже');
      e.offline = true;
      throw e;
    }
    let data = null;
    try { data = await res.json(); } catch { /* файлы и пустые ответы */ }
    if (!res.ok) {
      if (data && data.needLogin) { localStorage.removeItem('enso-pilot1-auth'); location.reload(); }
      const err = new Error((data && data.error) || `Ошибка сервера (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  async function apiBlob(path, filename) {
    const res = await fetch(`/api/tz${path}`, { headers: userHeaders() });
    if (!res.ok) {
      let msg = `Ошибка сервера (${res.status})`;
      try { msg = (await res.json()).error || msg; } catch { /* не JSON */ }
      throw new Error(msg);
    }
    saveBlob(await res.blob(), filename);
  }

  /* ---------------- провайдеры и мета ---------------- */

  async function loadHealth() {
    try {
      let data = null;
      // каркас уже получил /health с теми же заголовками — второй запрос на загрузке ни к чему
      if (window.EnsoShell && window.EnsoShell.ready) { await window.EnsoShell.ready; data = window.EnsoShell.health; }
      if (!data) {
        const res = await fetch('/api/health', { headers: userHeaders() });
        data = await res.json();
      }
      state.providers = (data.providers || []).filter((p) => p.id !== 'demo');
    } catch { state.providers = []; }
  }

  async function loadMeta() {
    try { state.checklists = (await api('/meta')).checklists || []; } catch { state.checklists = []; }
  }

  function fillChecklistSelect(sel, chosen) {
    sel.innerHTML = '';
    for (const c of state.checklists) {
      sel.append(h('option', { value: c.id, selected: c.id === chosen || null },
        `${c.label} (${c.section}, ${c.itemCount} пунктов)`));
    }
  }

  /** Пикер модели — как на «Этапе 1»: список провайдеров с сервера, у недоступных причина. */
  function fillProviderSelect(provSel, modelSel, chosenProvider, chosenModel, noteEl) {
    provSel.innerHTML = '';
    provSel.append(h('option', { value: '' }, '— выберите нейросеть —'));
    for (const p of state.providers) {
      provSel.append(h('option', {
        value: p.id,
        disabled: p.available === false || null,
        selected: p.id === chosenProvider || null,
      }, p.available === false ? `${p.label} — ${p.note || 'недоступно'}` : p.label));
    }
    const fillModels = () => {
      const p = state.providers.find((x) => x.id === provSel.value) || null;
      modelSel.innerHTML = '';
      const models = (p && p.models) || [];
      if (!models.length) {
        modelSel.append(h('option', { value: '' }, p ? 'модель по умолчанию' : '—'));
      } else {
        for (const m of models) {
          modelSel.append(h('option', { value: m, selected: m === chosenModel || null }, m));
        }
      }
      if (noteEl) {
        const info = p && p.modelsInfo && p.modelsInfo.find((x) => x.id === modelSel.value);
        noteEl.hidden = !(info && info.note);
        noteEl.textContent = (info && info.note) || '';
      }
    };
    provSel.onchange = fillModels;
    if (noteEl) modelSel.onchange = fillModels;
    fillModels();
  }

  /* ---------------- маршрутизация ---------------- */

  function parseHash() {
    const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
    if (parts[0] === 'p' && parts[1]) return { name: 'project', projectId: parts[1] };
    if (parts[0] === 'r' && parts[1]) return { name: 'run', runId: parts[1] };
    return { name: 'projects' };
  }

  function showScreen(id) {
    for (const s of document.querySelectorAll('.tz-screen')) s.classList.toggle('active', s.id === id);
  }

  function crumbs(items) {
    const nav = $('tz-crumbs');
    nav.innerHTML = '';
    if (!items || !items.length) { nav.hidden = true; return; }
    nav.hidden = false;
    // разметка как у нормоконтроля: .sep между звеньями, .here — текущее
    items.forEach((it, i) => {
      if (i) nav.append(h('span', { class: 'sep' }, '/'));
      nav.append(it.href ? h('a', { href: it.href }, it.label) : h('span', { class: 'here' }, it.label));
    });
  }

  async function route() {
    clearInterval(pollTimer);
    pollTimer = null;
    state.route = parseHash();
    try {
      if (state.route.name === 'project') await showProject(state.route.projectId);
      else if (state.route.name === 'run') await showRun(state.route.runId);
      else await showProjects();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  /* ---------------- экран: проекты ---------------- */

  async function showProjects() {
    showScreen('tz-s-projects');
    // место обсуждения снимается вместе с уходом: иначе выделение в списке
    // заданий уходило бы моделью как «замечание из прошлого прогона»
    if (window.FragChat) FragChat.setContext();
    crumbs(null);
    const box = $('tz-projects');
    const errBox = $('tz-projects-error');
    errBox.hidden = true;
    try {
      const data = await api(`/projects${projectQuery()}`);
      box.innerHTML = '';
      const list = data.projects || [];
      $('tz-projects-empty').hidden = !!list.length;
      for (const p of list) {
        const cl = state.checklists.find((c) => c.id === p.checklist);
        box.append(h('button', {
          class: 'tz-project-card list-card', type: 'button',
          onclick: () => { location.hash = `#/p/${p.id}`; },
        },
        h('span', { class: 'list-card-name' }, p.name),
        h('span', { class: 'list-card-sub' }, cl ? cl.label : p.checklist),
        h('span', { class: 'list-card-meta' },
          h('span', {}, p.ai_provider ? `модель: ${p.ai_provider}${p.ai_model ? ` (${p.ai_model})` : ''}` : 'модель не выбрана'),
          h('span', {}, p.has_document ? `${p.document_name || 'текст'} · ${fmtChars(p.document_chars)}` : 'документ не загружен')),
        h('span', { class: 'list-card-foot' },
          p.run_count
            ? [h('span', { class: 'tz-badge', 'data-run': p.last_run_status || '' }, RUN_LABEL[p.last_run_status] || p.last_run_status || '—'),
              h('span', { class: 'tz-badge' }, `прогонов: ${p.run_count}`)]
            : h('span', { class: 'tz-badge' }, 'прогонов ещё не было')),
        ));
      }
    } catch (err) {
      box.innerHTML = '';
      $('tz-projects-empty').hidden = true;
      errBox.textContent = `Не удалось получить список заданий: ${err.message}`;
      errBox.hidden = false;
    }
  }

  /* ---------------- экран: проект ---------------- */

  async function showProject(id) {
    showScreen('tz-s-project');
    if (window.FragChat) FragChat.setContext();
    const errBox = $('pj-error');
    errBox.hidden = true;
    // экран не должен показывать прошлое задание, пока грузится новое
    $('pj-name').textContent = 'Загрузка…';
    $('pj-sub').textContent = '';
    crumbs([{ label: 'Задания', href: '#/' }, { label: '…' }]);
    let data;
    try {
      data = await api(`/projects/${encodeURIComponent(id)}`);
    } catch (err) {
      if (err.status === 404) {
        // задания нет (удалено или адрес выдуман) — на список, а не пустой экран
        toast('Задание не найдено — возможно, удалено', 'error');
        location.hash = '#/';
        return;
      }
      errBox.textContent = `Не удалось открыть задание: ${err.message}`;
      errBox.hidden = false;
      return;
    }
    state.project = data.project;
    state.runs = data.runs || [];
    const p = state.project;
    crumbs([{ label: 'Задания', href: '#/' }, { label: p.name }]);
    $('pj-name').textContent = p.name;
    $('pj-sub').textContent = `создан ${fmtDateTime(p.created_at)}${p.created_by_name ? ` · ${p.created_by_name}` : ''}`;

    renderDocState();
    fillChecklistSelect($('pj-checklist'), p.checklist);
    // нейросеть проекта платформы: показываем, какая работает (выбор — в свойствах проекта)
    const ai = (window.EnsoShell && window.EnsoShell.project) || null;
    const prov = (ai && ai.ai_provider) || p.ai_provider || '';
    const mdl = (ai && ai.ai_model) || p.ai_model || '';
    const known = state.providers.find((x) => x.id === prov);
    $('pj-ai').textContent = prov
      ? `${known ? known.label : prov}${mdl ? ` · ${mdl}` : ''}`
      : 'не выбрана — откройте «Свойства проекта» на главной';
    $('pj-ai').dataset.empty = prov ? '' : '1';
    $('pj-funding').value = (p.object && p.object.funding) || '';
    renderRuns();

    // живой прогон — обновлять список, пока не закончится
    if (state.runs.some((r) => ['queued', 'running'].includes(r.status))) {
      pollTimer = setInterval(async () => {
        try {
          const fresh = await api(`/projects/${encodeURIComponent(id)}`);
          state.runs = fresh.runs || [];
          renderRuns();
          if (!state.runs.some((r) => ['queued', 'running'].includes(r.status))) {
            clearInterval(pollTimer);
            pollTimer = null;
          }
        } catch { /* сеть мигнула — следующий тик */ }
      }, 3000);
    }
  }

  function renderDocState() {
    const p = state.project;
    const box = $('pj-doc-state');
    box.innerHTML = '';
    if (p.document_chars) {
      box.append(h('span', { class: 'ok' },
        `Загружен: ${p.document_name || 'вставленный текст'} · ${fmtChars(p.document_chars)}`));
      if (p.document_note) box.append(h('span', { class: 'hint' }, ` — ${p.document_note}`));
    } else {
      box.append(h('span', { class: 'none' }, 'Текст ТЗ ещё не загружен.'));
    }
  }

  function renderRuns() {
    const tbody = $('pj-runs');
    tbody.innerHTML = '';
    $('pj-runs-empty').hidden = !!state.runs.length;
    for (const r of state.runs) {
      tbody.append(h('tr', { class: 'row-link', onclick: () => { location.hash = `#/r/${r.id}`; } },
        h('td', {}, fmtDateTime(r.created_at)),
        h('td', {}, `${r.provider}${r.model ? ` (${r.model})` : ''}`),
        h('td', {}, h('span', { class: 'tz-badge', 'data-run': r.status },
          r.status === 'running' && r.progress ? r.progress : (RUN_LABEL[r.status] || r.status))),
        h('td', {}, r.verdict_status || (r.status === 'failed' ? (r.error_text || 'ошибка') : '—')),
        h('td', {}, r.readiness_percent != null ? `${r.readiness_percent} %` : '—'),
        h('td', { class: 'row-actions' }, h('button', {
          class: 'btn btn-quiet btn-sm', type: 'button',
          onclick: (e) => { e.stopPropagation(); location.hash = `#/r/${r.id}`; },
        }, 'Открыть')),
      ));
    }
  }

  async function saveSettings() {
    const note = $('pj-settings-note');
    note.hidden = true;
    try {
      const object = { ...(state.project.object || {}) };
      const funding = $('pj-funding').value;
      if (funding) object.funding = funding; else delete object.funding;
      const data = await api(`/projects/${encodeURIComponent(state.project.id)}`, {
        method: 'PATCH',
        json: {
          checklist: $('pj-checklist').value,
          object,
        },
      });
      state.project = { ...state.project, ...data.project, document_text: undefined };
      toast('Настройки сохранены');
    } catch (err) {
      note.textContent = err.message;
      note.hidden = false;
    }
  }

  async function saveText() {
    const text = $('pj-text').value.trim();
    if (!text) { toast('Текст пуст', 'error'); return; }
    try {
      const data = await api(`/projects/${encodeURIComponent(state.project.id)}/document`, {
        method: 'PUT', json: { text, name: 'вставленный текст' },
      });
      state.project.document_chars = data.document.chars;
      state.project.document_name = data.document.name;
      state.project.document_note = '';
      renderDocState();
      toast(`Текст сохранён: ${fmtChars(data.document.chars)}`);
    } catch (err) { toast(err.message, 'error'); }
  }

  async function uploadFile(file) {
    const fd = new FormData();
    fd.append('file', file, file.name);
    try {
      const data = await api(`/projects/${encodeURIComponent(state.project.id)}/document/file`, { method: 'POST', body: fd });
      state.project.document_chars = data.document.chars;
      state.project.document_name = data.document.name;
      state.project.document_note = data.document.note || '';
      renderDocState();
      toast(`Файл разобран: ${fmtChars(data.document.chars)}${data.document.note ? ` — ${data.document.note}` : ''}`,
        data.document.note ? 'error' : 'info');
    } catch (err) { toast(err.message, 'error'); }
  }

  async function startAnalyze() {
    const btn = $('pj-analyze');
    btn.disabled = true;
    try {
      const data = await api(`/projects/${encodeURIComponent(state.project.id)}/analyze`, { method: 'POST', json: {} });
      location.hash = `#/r/${data.runId}`;
    } catch (err) {
      // на 409 сервер называет уже идущий прогон — ведём человека к нему
      toast(err.message, 'error');
    } finally { btn.disabled = false; }
  }

  async function deleteProject() {
    const ok = await window.EnsoShell.confirm({
      title: `Удалить задание «${state.project.name}»?`,
      message: 'Задание уйдёт из списка. Прогоны останутся в базе.',
      confirmText: 'Удалить', danger: true,
    });
    if (!ok) return;
    try {
      await api(`/projects/${encodeURIComponent(state.project.id)}`, { method: 'DELETE' });
      state.project = null;
      toast('Задание удалено');
      location.hash = '#/';
    } catch (err) { toast(err.message, 'error'); }
  }

  /* ---------------- экран: прогон / отчёт ---------------- */

  async function showRun(rid) {
    showScreen('tz-s-run');
    $('r-error').hidden = true;
    $('r-title').textContent = 'Загрузка…';
    $('r-sub').textContent = '';
    crumbs([{ label: 'Задания', href: '#/' }, { label: '…' }]);
    const myRoute = state.route; // ответ опроса, пришедший после ухода с экрана, экран не возвращает
    let data;
    try {
      data = await api(`/runs/${encodeURIComponent(rid)}`);
    } catch (err) {
      if (err.status === 404) { toast('Прогон не найден — возможно, удалён', 'error'); location.hash = '#/'; return; }
      $('r-error').textContent = `Не удалось открыть результат: ${err.message}`;
      $('r-error').hidden = false;
      return;
    }
    state.run = data.run;
    const run = state.run;
    /*
     * Правки — СВОИ у каждого прогона, а идентификаторы находок сквозные
     * (F-001, F-002…) и повторяются в каждом. Без сброса на карточке свежего
     * прогона висела бы формулировка из прошлого — и «Записать редакцию»
     * записала бы чужой текст (рецензия 10.09.2026).
     */
    state.fixes = {};
    state.fixDrafts = {};
    state.fixesLoaded = false;
    // место обсуждения фрагментов на этой странице (frag-chat.js)
    if (window.FragChat) FragChat.setContext({ entityId: run.id, anchor: `задание «${run.project_name || ''}»` });
    crumbs([{ label: 'Задания', href: '#/' }, { label: run.project_name || 'Задание', href: `#/p/${run.project_id}` }, { label: 'Результат' }]);
    $('r-title').textContent = 'Результат проверки';
    $('r-sub').textContent = `${fmtDateTime(run.created_at)} · ${run.provider}${run.model ? ` (${run.model})` : ''}${run.started_by_name ? ` · запустил: ${run.started_by_name}` : ''}`;

    if (['queued', 'running'].includes(run.status)) {
      $('r-progress').hidden = false;
      $('r-report').hidden = true;
      $('r-progress-text').textContent = run.progress || 'в очереди…';
      pollTimer = setInterval(async () => {
        try {
          const fresh = await api(`/runs/${rid}`);
          state.run = fresh.run;
          if (['queued', 'running'].includes(fresh.run.status)) {
            $('r-progress-text').textContent = fresh.run.progress || 'выполняется…';
          } else {
            clearInterval(pollTimer);
            pollTimer = null;
            if (state.route === myRoute) await showRun(rid);
          }
        } catch { /* сеть мигнула — следующий тик */ }
      }, 2500);
      return;
    }

    $('r-progress').hidden = true;
    if (run.status === 'failed') {
      $('r-report').hidden = true;
      $('r-error').textContent = `Прогон не удался: ${run.error_text || 'причина не записана'}`;
      $('r-error').hidden = false;
      return;
    }
    $('r-report').hidden = false;
    renderReport();
  }

  function renderReport() {
    const run = state.run;
    const result = run.result || {};
    const v = result.verdict || {};
    const o = result.object || {};

    const box = $('r-verdict');
    box.innerHTML = '';
    box.dataset.status = v.status || '';
    box.append(
      h('div', { class: 'item' }, h('span', { class: 'lbl' }, 'Статус'), h('span', { class: 'big' }, v.status || '—')),
      h('div', { class: 'item' }, h('span', { class: 'lbl' }, 'Готовность'), h('span', { class: 'big' }, `${v.readiness_percent ?? 0} %`)),
      h('div', { class: 'item' }, h('span', { class: 'lbl' }, 'Блокирующих'), h('span', { class: 'big' }, String(v.blocking_count ?? 0))),
      h('div', { class: 'item' }, h('span', { class: 'lbl' }, 'Объект'),
        h('span', {}, `${o.kind || '—'} · ${o.checklist_label || ''} · финансирование: ${o.funding || 'неизвестно'}`)),
    );
    if ((v.top_risks || []).length) {
      box.append(h('ul', { class: 'risks' }, v.top_risks.map((r) => h('li', {}, r))));
    }
    if (result.norm_check_note) box.append(h('p', { class: 'tz-note-offline' }, `⚠ ${result.norm_check_note}`));

    renderFindings();
    loadFixes();

    const matrix = result.checklist_matrix || [];
    const tbody = $('r-matrix');
    tbody.innerHTML = '';
    $('r-matrix-count').textContent = `${matrix.filter((m) => m.status === 'ЕСТЬ').length} из ${matrix.length} — ЕСТЬ`;
    for (const m of matrix) {
      tbody.append(h('tr', {},
        h('td', {}, h('div', {}, m.item), h('div', { class: 'hint' }, m.source + (m.form307 ? ` · 307/пр: ${m.form307}` : ''))),
        h('td', {}, h('span', { class: 'tz-badge', 'data-status': m.status }, m.status)),
        h('td', {}, m.znp_ref || '—'),
        h('td', {}, m.note || ''),
      ));
    }

    const unv = result.unverified || [];
    $('r-unverified-count').textContent = String(unv.length);
    const ul = $('r-unverified');
    ul.innerHTML = '';
    for (const u of unv) ul.append(h('li', {}, `${u.what} — ${u.why}`));
  }

  function renderFindings() {
    const run = state.run;
    const findings = (run.result && run.result.findings) || [];
    const list = findings.filter((f) =>
      (!state.filters.severity || f.severity === state.filters.severity)
      && (!state.filters.category || f.category === state.filters.category));

    // чипы по серьёзности — как счётчики замечаний в нормоконтроле
    const countsBox = $('r-counts');
    countsBox.innerHTML = '';
    const chips = SEV_ORDER
      .map((s) => [s, findings.filter((f) => f.severity === s).length])
      .filter(([, n]) => n)
      .map(([s, n]) => h('span', { class: 'tz-badge', 'data-sev': s }, `${s}: ${n}`));
    if (chips.length) countsBox.append(...chips); else countsBox.textContent = 'находок нет';

    const box = $('r-findings');
    box.innerHTML = '';
    $('r-findings-empty').hidden = !!list.length;
    for (const f of list) box.append(renderFinding(f));
  }

  function renderFinding(f) {
    const run = state.run;
    const d = (run.decisions || {})[f.id] || null;
    // подпись места для обсуждения выделенного фрагмента (frag-chat.js):
    // выделив цитату или формулировку, человек спрашивает именно об этом замечании
    const card = h('div', {
      class: 'tz-finding', 'data-decision': d ? d.decision : '',
      'data-frag-entity': run.id,
      'data-frag-anchor': `замечание ${f.id}${f.znp_ref ? `, ${f.znp_ref}` : ''}`,
    });
    card.append(h('div', { class: 'head' },
      h('span', { class: 'fid' }, f.id),
      h('span', { class: 'tz-badge', 'data-sev': f.severity }, f.severity),
      h('span', { class: 'tz-badge' }, CAT_LABEL[f.category] || f.category),
      h('span', { class: 'ref' }, f.znp_ref || ''),
      f.needs_human ? h('span', { class: 'tz-badge' }, 'нужна проверка человеком') : null,
    ));
    if (f.quote) card.append(h('blockquote', {}, `«${f.quote}»`));
    card.append(h('p', { class: 'problem' }, f.problem));
    const sources = (f.sources && f.sources.length ? f.sources : (f.requirement_source ? [f.requirement_source] : []));
    for (const s of sources) {
      card.append(h('p', { class: 'row' }, `Источник: ${[s.doc, s.clause].filter(Boolean).join(', ')}${s.status ? ` — ${s.status}` : ''}`));
    }
    if (f.consequence) card.append(h('p', { class: 'row' }, `Последствие: ${f.consequence}`));
    if (f.proposed_text) card.append(h('div', { class: 'proposed' }, `Предлагаемая формулировка: ${f.proposed_text}`));

    const decide = h('div', { class: 'decide' });
    const btnA = h('button', { class: 'btn btn-quiet btn-sm', type: 'button' }, d && d.decision === 'accepted' ? '✓ Принято' : 'Принять');
    const btnR = h('button', { class: 'btn btn-quiet btn-sm', type: 'button' }, d && d.decision === 'rejected' ? '✕ Отклонено' : 'Отклонить');
    const setDecision = async (decision) => {
      try {
        const cur = (state.run.decisions || {})[f.id];
        const next = cur && cur.decision === decision ? null : decision; // повторный клик снимает решение
        const res = await api(`/runs/${run.id}/findings/${f.id}/decision`, { method: 'POST', json: { decision: next } });
        if (!state.run.decisions) state.run.decisions = {};
        if (res.decision) state.run.decisions[f.id] = res.decision;
        else delete state.run.decisions[f.id];
        renderFindings();
      } catch (err) { toast(err.message, 'error'); }
    };
    btnA.addEventListener('click', () => setDecision('accepted'));
    btnR.addEventListener('click', () => setDecision('rejected'));
    decide.append(btnA, btnR);
    if (d) decide.append(h('span', { class: 'who' }, `${d.by || ''} · ${fmtDateTime(d.at)}`));
    card.append(decide);
    card.append(renderFix(f));
    return card;
  }

  /* ---------------- предложения по заполнению (10.09.2026) ---------------- */

  /**
   * Блок «как это записать в ТЗ»: несколько формулировок от модели и своё поле.
   *
   * Правило то же, что у решений: пишет человек. Модель предлагает варианты,
   * человек выбирает один или пишет собственный — и только выбранное попадает
   * в исправленную редакцию ТЗ.
   */
  function renderFix(f) {
    // правки ещё не пришли — блока нет вовсе: пустой блок читался бы как «правок нет»
    if (!state.fixesLoaded) return h('div', { class: 'tz-fix-wait' }, 'Формулировки загружаются…');
    const fix = state.fixes[f.id] || null;
    const box = h('div', { class: 'tz-fix' });
    const head = h('div', { class: 'tz-fix-head' },
      h('span', { class: 'tz-fix-title' }, 'Как записать в ТЗ'),
      fix && fix.chosenText ? h('span', { class: 'tz-badge', 'data-sev': 'ok' }, 'формулировка принята') : null);
    box.append(head);

    const list = h('div', { class: 'tz-fix-variants' });
    const own = h('textarea', {
      class: 'tz-fix-own', rows: '3',
      placeholder: 'Свой вариант: напишите текст пункта так, как он должен стоять в ТЗ',
    });
    /*
     * Ненабранное «своё» держится в state: renderFindings() пересобирает ВЕСЬ
     * список, и текст, набранный в замечании A, пропадал от любого действия в
     * замечании B — на боевом ТЗ с полусотней замечаний это потеря работы.
     */
    if (state.fixDrafts[f.id] !== undefined) own.value = state.fixDrafts[f.id];
    else if (fix && fix.chosenKind === 'own') own.value = fix.chosenText;
    own.addEventListener('input', () => { state.fixDrafts[f.id] = own.value; });

    const apply = async (text, kind) => {
      try {
        const res = await api(`/runs/${state.run.id}/findings/${f.id}/fix`, { method: 'PUT', json: { text, kind } });
        state.fixes[f.id] = res.fix;
        delete state.fixDrafts[f.id];       // принятое стало сохранённым
        toast(text ? 'Формулировка принята — войдёт в исправленное ТЗ' : 'Формулировка снята');
        renderFindings();
        // полоса «дальше» рисовалась только при загрузке: кнопки «Скачать» и
        // «Проверить заново» появлялись лишь после F5 (рецензия 10.09.2026)
        renderRevisionBar();
      } catch (err) { toast(err.message, 'error'); }
    };

    const drawVariants = () => {
      list.innerHTML = '';
      const variants = (state.fixes[f.id] && state.fixes[f.id].variants) || [];
      for (const v of variants) {
        const chosen = state.fixes[f.id] && state.fixes[f.id].chosenKind === 'variant'
          && state.fixes[f.id].chosenText === v.text;
        const item = h('div', { class: 'tz-fix-variant', 'data-chosen': chosen ? '1' : null });
        item.append(h('div', { class: 'tz-fix-vhead' },
          h('span', { class: 'tz-fix-vtitle' }, v.title),
          v.needsCheck ? h('span', { class: 'tz-badge' }, 'нужны данные заказчика') : null));
        item.append(h('p', { class: 'tz-fix-text' }, v.text));
        if (v.why) item.append(h('p', { class: 'tz-fix-why' }, v.why));
        const take = h('button', { class: 'btn btn-quiet btn-sm', type: 'button' }, chosen ? '✓ Выбрано' : 'Взять этот');
        take.addEventListener('click', () => apply(chosen ? '' : v.text, 'variant'));
        const edit = h('button', { class: 'btn btn-ghost btn-sm', type: 'button' }, 'Править у себя');
        edit.addEventListener('click', () => { own.value = v.text; own.focus(); });
        item.append(h('div', { class: 'tz-fix-vfoot' }, take, edit));
        list.append(item);
      }
    };
    drawVariants();

    const ask = h('button', { class: 'btn btn-primary btn-sm', type: 'button' },
      (state.fixes[f.id] && state.fixes[f.id].variants.length) ? 'Предложить ещё' : 'Предложить формулировки');
    ask.addEventListener('click', async () => {
      ask.disabled = true;
      const was = ask.textContent;
      ask.textContent = 'Модель пишет варианты…';
      try {
        const res = await api(`/runs/${state.run.id}/findings/${f.id}/suggest`, { method: 'POST', json: {} });
        state.fixes[f.id] = res.fix;
        renderFindings();
        renderRevisionBar();
      } catch (err) {
        toast(err.message, 'error');
        ask.textContent = was;
        ask.disabled = false;
      }
    });

    const saveOwn = h('button', { class: 'btn btn-quiet btn-sm', type: 'button' }, 'Принять свой вариант');
    saveOwn.addEventListener('click', () => apply(own.value.trim(), 'own'));
    const clear = h('button', { class: 'btn btn-ghost btn-sm', type: 'button' }, 'Снять формулировку');
    clear.addEventListener('click', () => apply('', ''));

    box.append(list, own, h('div', { class: 'tz-fix-foot' }, ask, saveOwn,
      fix && fix.chosenText ? clear : null));
    return box;
  }

  /** Правки прогона: их держит сервер, клиент только показывает и меняет. */
  async function loadFixes() {
    if (!state.run) return;
    const runId = state.run.id;
    try {
      const data = await api(`/runs/${runId}/fixes`);
      if (!state.run || state.run.id !== runId) return;   // ушли на другой прогон
      state.fixes = {};
      for (const fx of data.fixes || []) state.fixes[fx.findingId] = fx;
      state.fixesLoaded = true;
      renderFindings();
      renderRevisionBar();
    } catch (err) {
      // молчать нельзя: человек увидел бы пустой блок правок и решил, что их нет
      state.fixesLoaded = false;
      renderFindings();
      toast(`Не удалось загрузить принятые формулировки: ${err.message}`, 'error');
    }
  }

  /**
   * Полоса «дальше»: собрать исправленное ТЗ, скачать его и проверить заново.
   * Появляется, как только принята хотя бы одна формулировка.
   */
  function renderRevisionBar() {
    const bar = $('r-revision');
    if (!bar) return;
    const accepted = Object.values(state.fixes).filter((f) => f.chosenText).length;
    bar.hidden = !accepted;
    if (!accepted) return;
    $('r-revision-count').textContent = accepted === 1
      ? 'Принята 1 формулировка'
      : `Принято формулировок: ${accepted}`;
  }

  /* ---------------- новый проект ---------------- */

  function openNewProject() {
    $('np-form').reset();
    $('np-error').hidden = true;
    fillChecklistSelect($('np-checklist'), 'production');
    modalOpener = document.activeElement;

    // название — из проекта платформы, как в нормоконтроле
    const pp = window.EnsoShell && window.EnsoShell.project;
    if (pp) $('np-name').value = pp.full_name || pp.name || '';
    $('np-modal').hidden = false;
    setTimeout(() => { $('np-name').focus(); $('np-name').select(); }, 0);
  }
  let modalOpener = null;
  function closeNewProject() {
    $('np-modal').hidden = true;
    if (modalOpener && modalOpener.isConnected && modalOpener.offsetParent !== null) modalOpener.focus();
    else if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
    modalOpener = null;
  }

  async function submitNewProject(e) {
    e.preventDefault();
    const errBox = $('np-error');
    errBox.hidden = true;
    const name = $('np-name').value.trim();
    if (!name) { errBox.textContent = 'Нужно название задания.'; errBox.hidden = false; return; }
    const btn = $('np-submit');
    btn.disabled = true; // двойной Enter заводил два задания
    try {
      const data = await api('/projects', {
        method: 'POST',
        json: {
          name,
          projectId: projectId(),
          checklist: $('np-checklist').value,
          // нейросеть наследуется от проекта платформы — модуль её не спрашивает
        },
      });
      closeNewProject();
      location.hash = `#/p/${data.project.id}`;
    } catch (err) {
      errBox.textContent = err.message;
      errBox.hidden = false;
    } finally {
      btn.disabled = false;
    }
  }

  /* ---------------- кто вошёл ---------------- */

  function renderUserBox() {
    // блок человека теперь рисует общий каркас (shell.js)
    if (window.EnsoShell) window.EnsoShell.renderUser();
  }

  /* ---------------- запуск ---------------- */

  function wireStatic() {
    $('tz-new-project').addEventListener('click', openNewProject);
    $('np-form').addEventListener('submit', submitNewProject);
    $('np-close').addEventListener('click', closeNewProject);
    $('np-cancel').addEventListener('click', closeNewProject);
    $('np-modal').addEventListener('click', (e) => { if (e.target === $('np-modal')) closeNewProject(); });
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || $('np-modal').hidden) return;
      const dlg = $('shell-dialog');
      if (dlg && !dlg.hidden) return; // диалог поверх окна закрывает каркас
      closeNewProject();
    });

    $('pj-save').addEventListener('click', saveSettings);
    $('pj-text-save').addEventListener('click', saveText);
    $('pj-analyze').addEventListener('click', startAnalyze);
    $('pj-delete').addEventListener('click', deleteProject);

    const dz = $('pj-dropzone');
    const input = $('pj-file');
    dz.addEventListener('click', () => input.click());
    dz.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
    input.addEventListener('change', () => { if (input.files[0]) uploadFile(input.files[0]); input.value = ''; });
    dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('dragover'); });
    dz.addEventListener('dragleave', () => dz.classList.remove('dragover'));
    dz.addEventListener('drop', (e) => {
      e.preventDefault();
      dz.classList.remove('dragover');
      if (e.dataTransfer && e.dataTransfer.files[0]) uploadFile(e.dataTransfer.files[0]);
    });

    // исправленное ТЗ: скачать, записать редакцию в задание, проверить заново
    const revNote = () => $('r-revision-note');
    $('r-download-tz').addEventListener('click', () => {
      if (!state.run) return;
      window.location.href = `/api/tz/runs/${state.run.id}/revision.docx`;
    });
    $('r-apply-revision').addEventListener('click', async () => {
      if (!state.run) return;
      const btn = $('r-apply-revision');
      btn.disabled = true;
      try {
        const res = await api(`/runs/${state.run.id}/revision?apply=1`, { method: 'POST', json: {} });
        revNote().textContent = `Редакция записана в задание: принято формулировок ${res.applied}, `
          + `по месту цитаты ${res.placement.filter((x) => x.placed === 'по месту цитаты').length}, `
          + `в дополнения ${res.placement.filter((x) => x.placed === 'в дополнения').length}. `
          + 'Следующая проверка пойдёт по ней.';
        revNote().hidden = false;
        toast('Редакция записана в задание');
      } catch (err) { toast(err.message, 'error'); } finally { btn.disabled = false; }
    });
    $('r-recheck').addEventListener('click', async () => {
      if (!state.run) return;
      const btn = $('r-recheck');
      btn.disabled = true;
      try {
        // сначала записываем редакцию: проверять заново прежний текст бессмысленно
        await api(`/runs/${state.run.id}/revision?apply=1`, { method: 'POST', json: {} });
        const started = await api(`/projects/${state.run.project_id}/analyze`, { method: 'POST', json: {} });
        toast('Проверка запущена по исправленному ТЗ');
        location.hash = `#/r/${started.runId}`;
      } catch (err) { toast(err.message, 'error'); } finally { btn.disabled = false; }
    });
    $('rf-severity').addEventListener('change', () => { state.filters.severity = $('rf-severity').value; renderFindings(); });
    $('rf-category').addEventListener('change', () => { state.filters.category = $('rf-category').value; renderFindings(); });
    $('r-export-xlsx').addEventListener('click', () =>
      apiBlob(`/runs/${encodeURIComponent(state.run.id)}/export.xlsx`, 'Реестр замечаний ТЗ.xlsx').catch((err) => toast(err.message, 'error')));
    $('r-export-docx').addEventListener('click', () =>
      apiBlob(`/runs/${encodeURIComponent(state.run.id)}/export.docx`, 'Заключение по проверке ТЗ.docx').catch((err) => toast(err.message, 'error')));

    window.addEventListener('hashchange', route);
  }

  async function init() {
    window.Auth.init();
    await window.Auth.start();
    renderUserBox();
    if (window.EnsoShell) await window.EnsoShell.start();
    wireStatic();
    await Promise.all([loadHealth(), loadMeta()]);
    await route();
  }

  document.addEventListener('DOMContentLoaded', init);
}());
