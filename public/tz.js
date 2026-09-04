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
    fillProviderSelect($('pj-provider'), $('pj-model'), p.ai_provider, p.ai_model, $('pj-provider-note'));
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
      box.append(h('span', { class: 'none' }, 'Текст ЗнП ещё не загружен.'));
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
          provider: $('pj-provider').value,
          model: $('pj-model').value,
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
    const card = h('div', { class: 'tz-finding', 'data-decision': d ? d.decision : '' });
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
    return card;
  }

  /* ---------------- новый проект ---------------- */

  function openNewProject() {
    $('np-form').reset();
    $('np-error').hidden = true;
    fillChecklistSelect($('np-checklist'), 'production');
    modalOpener = document.activeElement;
    fillProviderSelect($('np-provider'), $('np-model'), '', '', null);
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
          provider: $('np-provider').value,
          model: $('np-model').value,
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
