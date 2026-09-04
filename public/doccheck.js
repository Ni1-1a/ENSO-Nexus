'use strict';
/**
 * Модуль «Проверка документа» + «Замена A→B» — отдельная страница /doccheck.html.
 * Устройство повторяет tz.js: hash-роутер, X-User-Token из window.Auth,
 * опрос прогона таймером.
 *
 *   #/         списки проверок и сравнений
 *   #/c/:id    карточка проверки (документ, тип, промпт, модель, прогоны)
 *   #/r/:rid   результат прогона
 *   #/ab/:id   сравнение A→B
 */
(function () {
  const $ = (id) => document.getElementById(id);
  // контекст проекта платформы: ?project=<id> в адресе, читает общий каркас
  const projectId = () => (window.EnsoShell && window.EnsoShell.projectId) || '';
  const projectQuery = () => (projectId() ? `?project=${encodeURIComponent(projectId())}` : '');


  const RUN_LABEL = { queued: 'в очереди', running: 'идёт', done: 'готово', failed: 'ошибка', draft: 'черновик' };
  const AB_STATUSES = ['ПОДТВЕРЖДЕНО', 'ТРЕБУЕТ ПРОВЕРКИ', 'НЕ СООТВЕТСТВУЕТ', 'НЕТ ДАННЫХ'];
  const AB_KINDS = [
    ['req', 'Требования проекта / ТЗ'],
    ['a', 'Документы модели A (проектная)'],
    ['b', 'Документы модели B (предлагаемая)'],
  ];

  const state = {
    providers: [],
    types: [],           // из /api/doccheck/meta
    check: null,
    runs: [],
    run: null,
    ab: null,
    newKind: 'check',    // что создаёт модальное окно: check | ab
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
    toastTimer = setTimeout(() => { el.hidden = true; }, type === 'error' ? 6000 : 3500);
  }

  function fmtDateTime(value) {
    if (!value) return '—';
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? String(value)
      : `${d.toLocaleDateString('ru-RU')} ${d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`;
  }

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
      res = await fetch(`/api/doccheck${path}`, { ...options, headers });
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
      err.runId = data && data.runId;
      throw err;
    }
    return data;
  }

  async function apiBlob(path, filename) {
    const res = await fetch(`/api/doccheck${path}`, { headers: userHeaders() });
    if (!res.ok) {
      let msg = `Ошибка сервера (${res.status})`;
      try { msg = (await res.json()).error || msg; } catch { /* не JSON */ }
      throw new Error(msg);
    }
    saveBlob(await res.blob(), filename);
  }

  /* ---------------- мета и провайдеры ---------------- */

  async function loadHealth() {
    try {
      const res = await fetch('/api/health', { headers: userHeaders() });
      const data = await res.json();
      state.providers = (data.providers || []).filter((p) => p.id !== 'demo');
    } catch { state.providers = []; }
  }

  async function loadMeta() {
    try { state.types = (await api('/meta')).types || []; } catch { state.types = []; }
  }

  const typeById = (id) => state.types.find((t) => t.id === id) || null;

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
    if (parts[0] === 'c' && parts[1]) return { name: 'check', id: parts[1] };
    if (parts[0] === 'r' && parts[1]) return { name: 'run', id: parts[1] };
    if (parts[0] === 'ab' && parts[1]) return { name: 'ab', id: parts[1] };
    return { name: 'list' };
  }

  function showScreen(id) {
    for (const s of document.querySelectorAll('.mod-screen')) s.classList.toggle('active', s.id === id);
  }

  function crumbs(items) {
    const nav = $('dc-crumbs');
    nav.innerHTML = '';
    if (!items || !items.length) { nav.hidden = true; return; }
    nav.hidden = false;
    items.forEach((it, i) => {
      if (i) nav.append(' / ');
      nav.append(it.href ? h('a', { href: it.href }, it.label) : h('span', {}, it.label));
    });
  }

  async function route() {
    clearInterval(pollTimer);
    pollTimer = null;
    const r = parseHash();
    try {
      if (r.name === 'check') await showCheck(r.id);
      else if (r.name === 'run') await showRun(r.id);
      else if (r.name === 'ab') await showAb(r.id);
      else await showList();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  /* ---------------- экран: списки ---------------- */

  async function showList() {
    showScreen('dc-s-list');
    crumbs(null);
    const errBox = $('dc-list-error');
    errBox.hidden = true;
    try {
      const [checks, abs] = await Promise.all([api(`/checks${projectQuery()}`), api(`/ab${projectQuery()}`)]);
      const box = $('dc-checks');
      box.innerHTML = '';
      const list = checks.checks || [];
      $('dc-checks-empty').hidden = !!list.length;
      for (const c of list) {
        const type = typeById(c.chosen_type || c.detected_type);
        box.append(h('button', {
          class: 'mod-card-btn', type: 'button',
          onclick: () => { location.hash = `#/c/${c.id}`; },
        },
        h('h3', {}, c.name),
        h('span', { class: 'meta' }, c.has_document
          ? `${c.document_name || 'текст'} · ${fmtChars(c.document_chars)}` : 'документ не загружен'),
        h('span', { class: 'meta' }, type ? `тип: ${type.label}${c.chosen_type ? ' (выбран человеком)' : ''}` : 'тип ещё не определён'),
        h('span', { class: 'meta' }, c.ai_provider ? `модель: ${c.ai_provider}${c.ai_model ? ` (${c.ai_model})` : ''}` : 'модель не выбрана'),
        h('span', { class: 'meta' },
          c.run_count
            ? ['прогонов: ', String(c.run_count), ' · последний: ',
              h('span', { class: 'mod-badge', 'data-run': c.last_run_status || '' }, RUN_LABEL[c.last_run_status] || c.last_run_status || '—')]
            : 'прогонов не было'),
        ));
      }

      const abBox = $('ab-list');
      abBox.innerHTML = '';
      const abList = abs.list || [];
      $('ab-empty').hidden = !!abList.length;
      for (const a of abList) {
        const s = a.summary || {};
        abBox.append(h('button', {
          class: 'mod-card-btn', type: 'button',
          onclick: () => { location.hash = `#/ab/${a.id}`; },
        },
        h('h3', {}, a.name),
        h('span', { class: 'meta' }, `A: ${a.a_names || '—'}`),
        h('span', { class: 'meta' }, `B: ${a.b_names || '—'}`),
        h('span', { class: 'meta' },
          h('span', { class: 'mod-badge', 'data-run': a.status }, RUN_LABEL[a.status] || a.status),
          a.status === 'done' && s.rows_count
            ? ` строк: ${s.rows_count} · не соответствует: ${s['НЕ СООТВЕТСТВУЕТ'] || 0} · нет данных: ${s['НЕТ ДАННЫХ'] || 0}`
            : ''),
        ));
      }
    } catch (err) {
      errBox.textContent = err.message;
      errBox.hidden = false;
    }
  }

  /* ---------------- экран: карточка проверки ---------------- */

  function fillTypeSelect(sel, chosen, detected) {
    sel.innerHTML = '';
    sel.append(h('option', { value: '' }, detected
      ? `автоматически (${(typeById(detected) || { label: detected }).label})`
      : 'автоматически (по документу)'));
    for (const t of state.types) {
      if (t.id === 'neizvestno') continue;
      sel.append(h('option', { value: t.id, selected: t.id === chosen || null }, t.label));
    }
  }

  function fillPromptSelect(sel, typeId, chosenPromptId) {
    sel.innerHTML = '';
    const t = typeById(typeId);
    if (!t || !t.promptId) {
      sel.append(h('option', { value: '' }, t && t.note ? t.note : 'определится по типу документа'));
      sel.disabled = true;
      return;
    }
    sel.disabled = false;
    sel.append(h('option', { value: '' }, `основной: ${t.promptTitle}`));
    for (const alt of t.alternatives) {
      sel.append(h('option', { value: alt, selected: alt === chosenPromptId || null }, alt));
    }
  }

  async function showCheck(id) {
    showScreen('dc-s-check');
    const errBox = $('c-error');
    errBox.hidden = true;
    let data;
    try {
      data = await api(`/checks/${encodeURIComponent(id)}`);
    } catch (err) {
      if (err.status === 404) { toast('Проверка не найдена — возможно, удалена', 'error'); location.hash = '#/'; return; }
      errBox.textContent = err.message;
      errBox.hidden = false;
      return;
    }
    state.check = data.check;
    state.runs = data.runs || [];
    const c = state.check;
    crumbs([{ label: 'Проверки', href: '#/' }, { label: c.name }]);
    $('c-name').textContent = c.name;
    $('c-sub').textContent = `создана ${fmtDateTime(c.created_at)}${c.created_by_name ? ` · ${c.created_by_name}` : ''}`;

    renderCheckDoc();
    fillTypeSelect($('c-type'), c.chosen_type, c.detected_type);
    fillPromptSelect($('c-prompt'), c.chosen_type || c.detected_type, c.chosen_prompt_id);
    $('c-type').onchange = () => fillPromptSelect($('c-prompt'), $('c-type').value || c.detected_type, '');
    $('c-type-note').textContent = c.detected_type
      ? `Система определила: ${(typeById(c.detected_type) || { label: c.detected_type }).label} (${c.detected_via}${c.detected_evidence ? `, признак: «${c.detected_evidence}»` : ''}). Выбор человека сильнее.`
      : 'Тип определится при загрузке документа; здесь его можно задать вручную.';
    fillProviderSelect($('c-provider'), $('c-model'), c.ai_provider, c.ai_model, $('c-provider-note'));
    renderCheckRuns();

    if (state.runs.some((r) => ['queued', 'running'].includes(r.status))) {
      pollTimer = setInterval(async () => {
        try {
          const fresh = await api(`/checks/${encodeURIComponent(id)}`);
          state.runs = fresh.runs || [];
          renderCheckRuns();
          if (!state.runs.some((r) => ['queued', 'running'].includes(r.status))) {
            clearInterval(pollTimer);
            pollTimer = null;
          }
        } catch { /* сеть мигнула — следующий тик */ }
      }, 3000);
    }
  }

  function renderCheckDoc() {
    const c = state.check;
    const box = $('c-doc-state');
    box.innerHTML = '';
    if (c.document_chars) {
      box.append(h('span', { class: 'ok' }, `Загружен: ${c.document_name || 'вставленный текст'} · ${fmtChars(c.document_chars)}`));
      if (c.document_note) box.append(h('span', { class: 'hint' }, ` — ${c.document_note}`));
    } else {
      box.append(h('span', { class: 'none' }, 'Документ ещё не загружен. Загрузка сама запускает проверку.'));
    }
  }

  function renderCheckRuns() {
    const tbody = $('c-runs');
    tbody.innerHTML = '';
    $('c-runs-empty').hidden = !!state.runs.length;
    for (const r of state.runs) {
      tbody.append(h('tr', { class: 'mod-run-row', style: 'cursor:pointer', onclick: () => { location.hash = `#/r/${r.id}`; } },
        h('td', {}, fmtDateTime(r.created_at)),
        h('td', {}, r.provider ? `${r.provider}${r.model ? ` (${r.model})` : ''}` : 'без модели'),
        h('td', {}, [r.doc_type ? (typeById(r.doc_type) || { label: r.doc_type }).label : '—',
          r.prompt_id ? ` · ${r.prompt_id}` : ''].join('')),
        h('td', {}, h('span', { class: 'mod-badge', 'data-run': r.status },
          r.status === 'running' && r.progress ? r.progress : (RUN_LABEL[r.status] || r.status))),
        h('td', {}, r.findings_count != null ? String(r.findings_count) : (r.status === 'failed' ? (r.error_text || 'ошибка') : '—')),
        h('td', {}, h('a', { href: `#/r/${r.id}`, onclick: (e) => e.stopPropagation() }, 'открыть')),
      ));
    }
  }

  async function saveCheckSettings() {
    const note = $('c-settings-note');
    note.hidden = true;
    try {
      const data = await api(`/checks/${encodeURIComponent(state.check.id)}`, {
        method: 'PATCH',
        json: {
          provider: $('c-provider').value,
          model: $('c-model').value,
          chosen_type: $('c-type').value,
          chosen_prompt_id: $('c-prompt').value,
        },
      });
      state.check = { ...state.check, ...data.check };
      toast('Настройки сохранены');
    } catch (err) {
      note.textContent = err.message;
      note.hidden = false;
    }
  }

  function afterDocumentSaved(data, note) {
    state.check.document_chars = data.document.chars;
    state.check.document_name = data.document.name;
    state.check.document_note = note || '';
    renderCheckDoc();
    if (data.runId) {
      toast('Документ загружен — проверка запустилась');
      location.hash = `#/r/${data.runId}`;
    } else {
      toast('Документ сохранён; прогон уже идёт — откройте его из списка', 'error');
    }
  }

  async function saveCheckText() {
    const text = $('c-text').value.trim();
    if (!text) { toast('Текст пуст', 'error'); return; }
    try {
      const data = await api(`/checks/${encodeURIComponent(state.check.id)}/document`, {
        method: 'PUT', json: { text, name: 'вставленный текст' },
      });
      afterDocumentSaved(data, '');
    } catch (err) { toast(err.message, 'error'); }
  }

  async function uploadCheckFile(file) {
    const fd = new FormData();
    fd.append('file', file, file.name);
    try {
      const data = await api(`/checks/${encodeURIComponent(state.check.id)}/document/file`, { method: 'POST', body: fd });
      afterDocumentSaved(data, data.document.note || '');
    } catch (err) { toast(err.message, 'error'); }
  }

  async function startCheckRun() {
    const btn = $('c-analyze');
    btn.disabled = true;
    try {
      const data = await api(`/checks/${encodeURIComponent(state.check.id)}/analyze`, { method: 'POST', json: {} });
      location.hash = `#/r/${data.runId}`;
    } catch (err) {
      if (err.status === 409 && err.runId) location.hash = `#/r/${err.runId}`;
      else toast(err.message, 'error');
    } finally { btn.disabled = false; }
  }

  async function deleteCheck() {
    const ok = await window.EnsoShell.confirm({ title: `Удалить проверку «${state.check.name}»?`, message: 'Прогоны останутся в базе.', confirmText: 'Удалить', danger: true });
    if (!ok) return;
    try {
      await api(`/checks/${encodeURIComponent(state.check.id)}`, { method: 'DELETE' });
      toast('Проверка удалена');
      location.hash = '#/';
    } catch (err) { toast(err.message, 'error'); }
  }

  /* ---------------- экран: прогон ---------------- */

  async function showRun(rid) {
    showScreen('dc-s-run');
    $('r-error').hidden = true;
    let data;
    try {
      data = await api(`/runs/${rid}`);
    } catch (err) {
      $('r-error').textContent = err.message;
      $('r-error').hidden = false;
      return;
    }
    state.run = data.run;
    const run = state.run;
    crumbs([{ label: 'Проверки', href: '#/' }, { label: 'Проверка', href: `#/c/${run.check_id}` }, { label: 'Результат' }]);
    $('r-sub').textContent = `${fmtDateTime(run.created_at)}${run.provider ? ` · ${run.provider}${run.model ? ` (${run.model})` : ''}` : ' · без модели'}${run.started_by_name ? ` · запустил: ${run.started_by_name}` : ''}`;

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
            await showRun(rid);
          }
        } catch { /* сеть мигнула */ }
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
    renderRunReport();
  }

  function renderRunReport() {
    const run = state.run;
    const result = run.result || {};
    const cls = result.classification || {};
    const routed = result.routed;

    const box = $('r-class');
    box.innerHTML = '';
    box.append(
      h('div', { class: 'item' }, h('span', { class: 'lbl' }, 'Тип документа'), h('span', { class: 'big' }, cls.label || '—')),
      h('div', { class: 'item' }, h('span', { class: 'lbl' }, 'Как определён'),
        h('span', {}, `${cls.via || '—'}${cls.confidence && cls.via === 'модель' ? ` · уверенность: ${cls.confidence}` : ''}`)),
      routed
        ? h('div', { class: 'item' }, h('span', { class: 'lbl' }, 'Промпт'),
          h('span', {}, `${routed.prompt_title}`),
          h('span', { class: 'note' }, routed.prompt_source ? `источник: ${routed.prompt_source}` : ''))
        : h('div', { class: 'item' }, h('span', { class: 'lbl' }, 'Профильная проверка'), h('span', {}, 'не запускалась')),
    );
    if (cls.evidence) box.append(h('p', { class: 'note' }, `Признак: «${cls.evidence}»`));
    if (cls.kind_note) box.append(h('p', { class: 'note' }, cls.kind_note));

    const findings = result.findings || [];
    $('r-counts').textContent = findings.length
      ? `исправить: ${findings.filter((f) => f.action === 'исправить').length} · проверить: ${findings.filter((f) => f.action === 'проверить').length} · нет данных: ${findings.filter((f) => f.action === 'нет данных').length}`
      : '';
    const fbox = $('r-findings');
    fbox.innerHTML = '';
    $('r-findings-empty').hidden = !!findings.length;
    for (const f of findings) fbox.append(renderRunFinding(f));

    const missing = result.missing_data || [];
    $('r-missing').hidden = !missing.length;
    const ml = $('r-missing-list');
    ml.innerHTML = '';
    for (const m of missing) ml.append(h('li', {}, m));

    const refs = result.ntd_refs || [];
    $('r-refs-count').textContent = String(refs.length);
    const tbody = $('r-refs');
    tbody.innerHTML = '';
    for (const ref of refs) {
      tbody.append(h('tr', {},
        h('td', {}, h('div', {}, ref.code), ref.registry ? h('div', { class: 'hint' }, ref.registry.title) : null),
        h('td', {}, String(ref.count)),
        h('td', {}, h('span', { class: 'mod-badge', 'data-st': ref.verdict }, ref.verdict)),
        h('td', {}, ref.places && ref.places[0] ? `стр. ${ref.places[0].line}: ${ref.places[0].text}` : '—'),
      ));
    }

    const unv = result.unverified || [];
    $('r-unverified-count').textContent = String(unv.length);
    const ul = $('r-unverified');
    ul.innerHTML = '';
    for (const u of unv) ul.append(h('li', {}, `${u.what} — ${u.why}`));
  }

  function renderRunFinding(f) {
    const run = state.run;
    const d = (run.decisions || {})[f.id] || null;
    const card = h('div', { class: 'mod-finding', 'data-decision': d ? d.decision : '' });
    card.append(h('div', { class: 'head' },
      h('span', { class: 'fid' }, f.id),
      h('span', { class: 'mod-badge', 'data-act': f.action }, f.action),
      h('span', { class: 'mod-badge' }, f.kind || ''),
      h('span', { class: 'ref' }, f.where || ''),
      f.needs_human ? h('span', { class: 'mod-badge' }, 'нужна проверка человеком') : null,
    ));
    card.append(h('p', { class: 'problem' }, f.what));
    if (f.quote) card.append(h('blockquote', {}, `«${f.quote}»`));
    if (f.standard) {
      card.append(h('p', { class: 'row' },
        `Стандарт: ${f.standard}${f.clause ? ` · пункт ${f.clause} (уверенность: ${f.clause_confidence || 'низкая'}) — гипотеза, сверить по официальному тексту` : ' · пункт моделью не назван'}`));
    }

    const decide = h('div', { class: 'decide' });
    const btnA = h('button', { class: 'btn btn-quiet btn-sm', type: 'button' }, d && d.decision === 'accepted' ? '✓ Принято' : 'Принять');
    const btnR = h('button', { class: 'btn btn-quiet btn-sm', type: 'button' }, d && d.decision === 'rejected' ? '✕ Отклонено' : 'Отклонить');
    const setDecision = async (decision) => {
      try {
        const cur = (state.run.decisions || {})[f.id];
        const next = cur && cur.decision === decision ? null : decision;
        const res = await api(`/runs/${run.id}/findings/${f.id}/decision`, { method: 'POST', json: { decision: next } });
        if (!state.run.decisions) state.run.decisions = {};
        if (res.decision) state.run.decisions[f.id] = res.decision;
        else delete state.run.decisions[f.id];
        renderRunReport();
      } catch (err) { toast(err.message, 'error'); }
    };
    btnA.addEventListener('click', () => setDecision('accepted'));
    btnR.addEventListener('click', () => setDecision('rejected'));
    decide.append(btnA, btnR);
    if (d) decide.append(h('span', { class: 'who' }, `${d.by || ''} · ${fmtDateTime(d.at)}`));
    card.append(decide);
    return card;
  }

  /* ---------------- экран: замена A→B ---------------- */

  async function showAb(id) {
    showScreen('dc-s-ab');
    $('ab-error').hidden = true;
    let data;
    try {
      data = await api(`/ab/${encodeURIComponent(id)}`);
    } catch (err) {
      if (err.status === 404) { toast('Сравнение не найдено — возможно, удалено', 'error'); location.hash = '#/'; return; }
      $('ab-error').textContent = err.message;
      $('ab-error').hidden = false;
      return;
    }
    state.ab = data.ab;
    const a = state.ab;
    crumbs([{ label: 'Проверки', href: '#/' }, { label: `A→B: ${a.name}` }]);
    $('ab-name').textContent = a.name;
    $('ab-sub').textContent = `создано ${fmtDateTime(a.created_at)}${a.created_by_name ? ` · ${a.created_by_name}` : ''}`;
    fillProviderSelect($('ab-provider'), $('ab-model'), a.ai_provider, a.ai_model, null);
    renderAbDocs();
    renderAbStatus();

    if (a.status === 'running') {
      pollTimer = setInterval(async () => {
        try {
          const fresh = await api(`/ab/${encodeURIComponent(id)}`);
          state.ab = fresh.ab;
          renderAbStatus();
          if (fresh.ab.status !== 'running') {
            clearInterval(pollTimer);
            pollTimer = null;
          }
        } catch { /* сеть мигнула */ }
      }, 2500);
    }
  }

  function renderAbDocs() {
    const a = state.ab;
    const box = $('ab-docs');
    box.innerHTML = '';
    for (const [kind, label] of AB_KINDS) {
      const names = a[`${kind}_names`];
      const chars = a[`${kind}_chars`];
      const wrap = h('div', { style: 'margin-bottom: 14px;' });
      wrap.append(h('div', { class: 'mod-doc-state' },
        h('strong', {}, label),
        h('span', { class: names ? 'ok' : 'none' },
          names ? ` — ${names}${chars ? ` · ${fmtChars(chars)}` : ''}` : ' — не загружено'),
        names ? h('button', {
          class: 'btn btn-quiet btn-sm', type: 'button', style: 'margin-left: 8px;',
          onclick: async () => {
            try {
              const res = await api(`/ab/${encodeURIComponent(a.id)}/docs/${kind}`, { method: 'DELETE' });
              state.ab = res.ab;
              renderAbDocs();
            } catch (err) { toast(err.message, 'error'); }
          },
        }, 'очистить') : null));
      const dz = h('div', { class: 'mod-dz-mini', tabindex: '0', role: 'button' },
        h('strong', {}, 'Добавить файл'), ' (DOCX, PDF, TXT) или перетащите сюда');
      const input = h('input', { type: 'file', accept: '.docx,.pdf,.txt,.md', hidden: true });
      const send = async (file) => {
        const fd = new FormData();
        fd.append('file', file, file.name);
        try {
          const res = await api(`/ab/${encodeURIComponent(a.id)}/docs/${kind}/file`, { method: 'POST', body: fd });
          state.ab = res.ab;
          renderAbDocs();
          if (res.note) toast(res.note, 'error');
        } catch (err) { toast(err.message, 'error'); }
      };
      dz.addEventListener('click', () => input.click());
      dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('dragover'); });
      dz.addEventListener('dragleave', () => dz.classList.remove('dragover'));
      dz.addEventListener('drop', (e) => {
        e.preventDefault();
        dz.classList.remove('dragover');
        if (e.dataTransfer && e.dataTransfer.files[0]) send(e.dataTransfer.files[0]);
      });
      input.addEventListener('change', () => { if (input.files[0]) send(input.files[0]); input.value = ''; });
      wrap.append(dz, input);
      box.append(wrap);
    }
  }

  function renderAbStatus() {
    const a = state.ab;
    $('ab-status').textContent = a.status === 'running' ? (a.progress || 'идёт…')
      : a.status === 'failed' ? `ошибка: ${a.error_text}` : a.status === 'done' ? 'протокол готов' : '';
    $('ab-run').disabled = a.status === 'running';
    $('ab-result').hidden = !(a.status === 'done' && a.result);
    if (a.status === 'done' && a.result) renderAbResult();
  }

  function renderAbResult() {
    const a = state.ab;
    const result = a.result;
    const s = result.summary || {};
    $('ab-summary').textContent = `строк: ${s.rows_count || 0} · подтверждено: ${s['ПОДТВЕРЖДЕНО'] || 0} · требует проверки: ${s['ТРЕБУЕТ ПРОВЕРКИ'] || 0} · не соответствует: ${s['НЕ СООТВЕТСТВУЕТ'] || 0} · нет данных: ${s['НЕТ ДАННЫХ'] || 0}`;

    const tbody = $('ab-rows');
    tbody.innerHTML = '';
    for (const row of result.rows || []) {
      const d = (a.decisions || {})[row.id] || null;
      const sel = h('select', {}, h('option', { value: '' }, '—'),
        AB_STATUSES.map((st) => h('option', { value: st, selected: d && d.decision === st || null }, st)));
      sel.addEventListener('change', async () => {
        try {
          let comment = '';
          if (sel.value) {
            const typed = await window.EnsoShell.prompt({ title: 'Комментарий к решению', label: 'Можно оставить пустым', value: d ? d.comment || '' : '' });
            if (typed === null) { sel.value = d ? d.decision || '' : ''; return; }
            comment = typed;
          }
          const res = await api(`/ab/${encodeURIComponent(a.id)}/rows/${row.id}/decision`, {
            method: 'POST', json: { decision: sel.value || null, comment },
          });
          if (!state.ab.decisions) state.ab.decisions = {};
          if (res.decision) state.ab.decisions[row.id] = res.decision;
          else delete state.ab.decisions[row.id];
          renderAbResult();
        } catch (err) { toast(err.message, 'error'); }
      });
      tbody.append(h('tr', {},
        h('td', {}, row.category),
        h('td', {}, row.param),
        h('td', {}, row.requirement || '—'),
        h('td', {}, row.value_a || '—'),
        h('td', {}, row.value_b || '—'),
        h('td', {}, row.unit || ''),
        h('td', {}, row.source_b ? `${row.source_b}${row.page_b ? `, ${row.page_b}` : ''}` : (row.value_b ? 'НЕТ ИСТОЧНИКА' : '—')),
        h('td', {}, h('span', { class: 'mod-badge', 'data-st': row.status }, row.status)),
        h('td', {}, row.risk || ''),
        h('td', {}, h('div', { class: 'mod-row-decide' }, sel,
          d ? h('span', { class: 'hint' }, `${d.by || ''}${d.comment ? ` — ${d.comment}` : ''}`) : null)),
      ));
    }

    const lists = [
      ['Каких параметров не хватает', result.missing_params],
      ['Вопросы производителю / поставщику', result.supplier_questions],
      ['Затронутые смежные разделы', result.affected_sections],
      ['Проверить в первую очередь', result.priority_rows],
      ['Не удалось проверить', (result.unverified || []).map((u) => `${u.what} — ${u.why}`)],
    ];
    const ul = $('ab-lists');
    ul.innerHTML = '';
    for (const [title, items] of lists) {
      if (!items || !items.length) continue;
      ul.append(h('li', {}, h('strong', {}, `${title}: `), items.join('; ')));
    }
  }

  async function saveAb() {
    try {
      const res = await api(`/ab/${encodeURIComponent(state.ab.id)}`, {
        method: 'PATCH',
        json: { provider: $('ab-provider').value, model: $('ab-model').value },
      });
      state.ab = res.ab;
      toast('Сохранено');
    } catch (err) { toast(err.message, 'error'); }
  }

  async function runAb() {
    try {
      await api(`/ab/${encodeURIComponent(state.ab.id)}`, {
        method: 'PATCH', json: { provider: $('ab-provider').value, model: $('ab-model').value },
      });
      await api(`/ab/${encodeURIComponent(state.ab.id)}/run`, { method: 'POST', json: {} });
      await showAb(state.ab.id);
    } catch (err) { toast(err.message, 'error'); }
  }

  async function deleteAb() {
    const ok = await window.EnsoShell.confirm({ title: `Удалить сравнение «${state.ab.name}»?`, confirmText: 'Удалить', danger: true });
    if (!ok) return;
    try {
      await api(`/ab/${encodeURIComponent(state.ab.id)}`, { method: 'DELETE' });
      toast('Сравнение удалено');
      location.hash = '#/';
    } catch (err) { toast(err.message, 'error'); }
  }

  /* ---------------- модальное окно создания ---------------- */

  function openNew(kind) {
    state.newKind = kind;
    $('nc-form').reset();
    $('nc-error').hidden = true;
    $('nc-title').textContent = kind === 'ab' ? 'Новое сравнение A → B' : 'Новая проверка';
    fillProviderSelect($('nc-provider'), $('nc-model'), '', '', null);
    $('nc-modal').hidden = false;
    $('nc-name').focus();
  }
  function closeNew() { $('nc-modal').hidden = true; }

  async function submitNew(e) {
    e.preventDefault();
    const errBox = $('nc-error');
    errBox.hidden = true;
    const name = $('nc-name').value.trim();
    if (!name) { errBox.textContent = 'Нужно название.'; errBox.hidden = false; return; }
    try {
      const payload = { name, projectId: projectId(), provider: $('nc-provider').value, model: $('nc-model').value };
      if (state.newKind === 'ab') {
        const data = await api('/ab', { method: 'POST', json: payload });
        closeNew();
        location.hash = `#/ab/${data.ab.id}`;
      } else {
        const data = await api('/checks', { method: 'POST', json: payload });
        closeNew();
        location.hash = `#/c/${data.check.id}`;
      }
    } catch (err) {
      errBox.textContent = err.message;
      errBox.hidden = false;
    }
  }

  /* ---------------- кто вошёл ---------------- */

  function renderUserBox() {
    // блок человека теперь рисует общий каркас (shell.js)
    if (window.EnsoShell) window.EnsoShell.renderUser();
  }

  /* ---------------- запуск ---------------- */

  function wireStatic() {
    $('dc-new').addEventListener('click', () => openNew('check'));
    $('ab-new').addEventListener('click', () => openNew('ab'));
    $('nc-form').addEventListener('submit', submitNew);
    $('nc-close').addEventListener('click', closeNew);
    $('nc-cancel').addEventListener('click', closeNew);
    $('nc-modal').addEventListener('click', (e) => { if (e.target === $('nc-modal')) closeNew(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('nc-modal').hidden) closeNew(); });

    $('c-save').addEventListener('click', saveCheckSettings);
    $('c-text-save').addEventListener('click', saveCheckText);
    $('c-analyze').addEventListener('click', startCheckRun);
    $('c-delete').addEventListener('click', deleteCheck);

    const dz = $('c-dropzone');
    const input = $('c-file');
    dz.addEventListener('click', () => input.click());
    dz.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
    input.addEventListener('change', () => { if (input.files[0]) uploadCheckFile(input.files[0]); input.value = ''; });
    dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('dragover'); });
    dz.addEventListener('dragleave', () => dz.classList.remove('dragover'));
    dz.addEventListener('drop', (e) => {
      e.preventDefault();
      dz.classList.remove('dragover');
      if (e.dataTransfer && e.dataTransfer.files[0]) uploadCheckFile(e.dataTransfer.files[0]);
    });

    $('r-export').addEventListener('click', () =>
      apiBlob(`/runs/${encodeURIComponent(state.run.id)}/export.xlsx`, 'Проверка документа.xlsx').catch((err) => toast(err.message, 'error')));

    $('ab-save').addEventListener('click', saveAb);
    $('ab-run').addEventListener('click', runAb);
    $('ab-delete').addEventListener('click', deleteAb);
    $('ab-export').addEventListener('click', () =>
      apiBlob(`/ab/${encodeURIComponent(state.ab.id)}/export.xlsx`, 'Протокол сравнения A-B.xlsx').catch((err) => toast(err.message, 'error')));

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
