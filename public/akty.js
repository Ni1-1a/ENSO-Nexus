'use strict';
/**
 * Вкладка «Акты (АОСР)» — отдельная страница /akty.html, один экран.
 * Оба конвейера детерминированные и stateless: файлы уходят, результат
 * приходит, на сервере ничего не хранится.
 */
(function () {
  const $ = (id) => document.getElementById(id);

  const state = {
    registry: null,   // { file, headers, rowCount }
    template: null,   // { file, keys }
    acts: null,       // File
    journal: null,    // File
  };

  function h(tag, attrs, ...kids) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') node.className = v;
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

  function userHeaders() {
    const hh = {};
    if (window.Auth && window.Auth.token) hh['X-User-Token'] = window.Auth.token;
    return hh;
  }

  async function apiForm(path, fd) {
    let res;
    try {
      res = await fetch(`/api/akty${path}`, { method: 'POST', headers: userHeaders(), body: fd });
    } catch {
      throw new Error('Сервер сейчас недоступен — попробуйте чуть позже');
    }
    return res;
  }

  async function readError(res) {
    let msg = `Ошибка сервера (${res.status})`;
    try {
      const data = await res.json();
      if (data && data.needLogin) { localStorage.removeItem('enso-pilot1-auth'); location.reload(); }
      msg = (data && data.error) || msg;
    } catch { /* не JSON */ }
    return msg;
  }

  function saveBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  }

  /* ---------------- зоны загрузки ---------------- */

  function wireDropzone(dzId, inputId, onFile) {
    const dz = $(dzId);
    const input = $(inputId);
    dz.addEventListener('click', () => input.click());
    dz.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
    input.addEventListener('change', () => { if (input.files[0]) onFile(input.files[0]); input.value = ''; });
    dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('dragover'); });
    dz.addEventListener('dragleave', () => dz.classList.remove('dragover'));
    dz.addEventListener('drop', (e) => {
      e.preventDefault();
      dz.classList.remove('dragover');
      if (e.dataTransfer && e.dataTransfer.files[0]) onFile(e.dataTransfer.files[0]);
    });
  }

  /* ---------------- конвейер ---------------- */

  function refreshGenerateState() {
    const ready = !!(state.registry && state.template);
    $('g-run').disabled = !ready;
    if (state.registry && state.template) {
      // сверка плейсхолдеров с колонками ДО генерации — человеку видно, что совпало
      const missing = state.template.keys.filter((k) => !state.registry.headers.includes(k));
      $('g-note').textContent = missing.length
        ? `плейсхолдеры без колонки в реестре: ${missing.join(', ')} — в актах будет «{НЕТ ДАННЫХ}»`
        : 'все плейсхолдеры шаблона нашли свои колонки';
    } else {
      $('g-note').textContent = '';
    }
  }

  async function onRegistry(file) {
    const fd = new FormData();
    fd.append('registry', file, file.name);
    const res = await apiForm('/registry/preview', fd);
    if (!res.ok) { toast(await readError(res), 'error'); return; }
    const data = await res.json();
    state.registry = { file, headers: data.headers, rowCount: data.rowCount };
    const box = $('g-reg-info');
    box.innerHTML = '';
    box.append(h('div', {}, `${file.name} · строк данных: ${data.rowCount}`));
    box.append(h('div', {}, `колонки: ${data.headers.join(' · ')}`));
    refreshGenerateState();
  }

  async function onTemplate(file) {
    const fd = new FormData();
    fd.append('template', file, file.name);
    const res = await apiForm('/template/preview', fd);
    if (!res.ok) { toast(await readError(res), 'error'); return; }
    const data = await res.json();
    state.template = { file, keys: data.keys };
    const box = $('g-tpl-info');
    box.innerHTML = '';
    box.append(h('div', {}, `${file.name}`));
    box.append(h('div', {}, data.keys.length
      ? `плейсхолдеры: ${data.keys.map((k) => `{{${k}}}`).join(' · ')}`
      : 'в шаблоне нет плейсхолдеров {{…}} — подставлять нечего'));
    refreshGenerateState();
  }

  async function runGenerate() {
    const btn = $('g-run');
    btn.disabled = true;
    try {
      const fd = new FormData();
      fd.append('registry', state.registry.file, state.registry.file.name);
      fd.append('template', state.template.file, state.template.file.name);
      const res = await apiForm('/generate', fd);
      if (!res.ok) { toast(await readError(res), 'error'); return; }
      let report = null;
      try { report = JSON.parse(decodeURIComponent(res.headers.get('x-akty-report') || '')); } catch { report = null; }
      saveBlob(await res.blob(), 'Черновики актов.zip');
      const box = $('g-report');
      box.hidden = false;
      box.innerHTML = '';
      if (report) {
        box.append(h('div', {}, `Сгенерировано актов: ${report.total}.`));
        if (report.unknownKeys && report.unknownKeys.length) {
          box.append(h('div', {}, `Плейсхолдеры без колонки (везде «{НЕТ ДАННЫХ}»): ${report.unknownKeys.join(', ')}`));
        }
        if (report.withGaps && report.withGaps.length) {
          box.append(h('div', {}, `Актов с пропусками: ${report.withGaps.length} — подробности в «ОТЧЁТ-пропуски.txt» внутри архива.`));
        } else {
          box.append(h('div', {}, 'Пропусков данных нет.'));
        }
        box.append(h('div', {}, 'Каждый черновик проверяется инженером до подписи — конвейер ничего не выдумывает, но и не проверяет за вас.'));
      }
      toast('Пачка актов скачана');
    } finally { btn.disabled = false; }
  }

  /* ---------------- сверка дат ---------------- */

  function refreshDatesState() {
    $('d-run').disabled = !(state.acts && state.journal);
  }

  async function runDates() {
    const btn = $('d-run');
    btn.disabled = true;
    try {
      const fd = new FormData();
      fd.append('acts', state.acts, state.acts.name);
      fd.append('journal', state.journal, state.journal.name);
      const res = await apiForm('/dates', fd);
      if (!res.ok) { toast(await readError(res), 'error'); return; }
      const data = await res.json();
      $('d-result').hidden = false;
      $('d-note').textContent = `актов: ${data.rows.length} · конфликтов: ${data.conflicts}`;

      const tbody = $('d-rows');
      tbody.innerHTML = '';
      for (const r of data.rows) {
        tbody.append(h('tr', {},
          h('td', {}, r.act_no),
          h('td', {}, r.work || '—'),
          h('td', {}, r.act_date || '—'),
          h('td', {}, r.journal_date ? `${r.journal_date}${r.journal_text ? ` — ${r.journal_text}` : ''}` : '—'),
          h('td', {}, r.days_diff == null ? '—' : (r.days_diff > 0 ? `+${r.days_diff} дн.` : `${r.days_diff} дн.`)),
          h('td', {}, r.conflict
            ? h('span', { class: 'mod-badge', 'data-st': 'НЕ СООТВЕТСТВУЕТ' }, r.conflict)
            : h('span', { class: 'mod-badge', 'data-st': 'ПОДТВЕРЖДЕНО' }, 'нет')),
        ));
      }

      const un = $('d-unmatched');
      un.innerHTML = '';
      if (data.unmatchedJournal && data.unmatchedJournal.length) {
        un.hidden = false;
        un.append(h('div', {}, h('strong', {}, `Записи журнала без пары (${data.unmatchedJournal.length}):`)));
        for (const j of data.unmatchedJournal.slice(0, 20)) {
          un.append(h('div', {}, `— ${j.date || 'дата не разобрана'}: ${j.text}`));
        }
      } else un.hidden = true;

      const wl = $('d-warnings');
      wl.innerHTML = '';
      for (const w of data.warnings || []) wl.append(h('li', {}, w));
    } finally { btn.disabled = false; refreshDatesState(); }
  }

  /* ---------------- кто вошёл ---------------- */

  function renderUserBox() {
    const box = $('ak-user');
    const u = (window.Auth && window.Auth.user) || null;
    if (!u || !window.Auth.requireLogin) { box.hidden = true; return; }
    const last = String(u.lastName || '').trim();
    const first = String(u.firstName || '').trim();
    box.hidden = false;
    $('ak-user-name').textContent = `${last} ${first}`.trim();
    $('ak-user-initials').textContent = `${last.slice(0, 1)}${first.slice(0, 1)}`.toUpperCase();
  }

  /* ---------------- запуск ---------------- */

  async function init() {
    window.Auth.init();
    await window.Auth.start();
    renderUserBox();

    wireDropzone('g-reg-dz', 'g-reg-file', (f) => onRegistry(f).catch((e) => toast(e.message, 'error')));
    wireDropzone('g-tpl-dz', 'g-tpl-file', (f) => onTemplate(f).catch((e) => toast(e.message, 'error')));
    $('g-run').addEventListener('click', () => runGenerate().catch((e) => toast(e.message, 'error')));

    wireDropzone('d-acts-dz', 'd-acts-file', (f) => {
      state.acts = f;
      $('d-acts-info').textContent = f.name;
      refreshDatesState();
    });
    wireDropzone('d-jrn-dz', 'd-jrn-file', (f) => {
      state.journal = f;
      $('d-jrn-info').textContent = f.name;
      refreshDatesState();
    });
    $('d-run').addEventListener('click', () => runDates().catch((e) => toast(e.message, 'error')));

    $('ak-sign-out').addEventListener('click', () => window.Auth.signOut());
  }

  document.addEventListener('DOMContentLoaded', init);
}());
