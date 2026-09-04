'use strict';
/**
 * Вкладка «Входной контроль ГГЭ» — отдельная страница /gge.html, один экран.
 * Проверка stateless: файлы + реквизиты + даты уходят одним запросом,
 * отчёт приходит сразу.
 */
(function () {
  const $ = (id) => document.getElementById(id);
  // контекст проекта платформы: ?project=<id> в адресе, читает общий каркас
  const projectId = () => (window.EnsoShell && window.EnsoShell.projectId) || '';
  const projectQuery = () => (projectId() ? `?project=${encodeURIComponent(projectId())}` : '');


  const DEFAULT_FIELDS = ['Название объекта', 'Застройщик', 'ИНН застройщика', 'Кадастровый номер участка', 'Шифр проекта'];
  const state = { files: [] };

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

  /* ---------------- файлы ---------------- */

  function renderFiles() {
    const ul = $('f-list');
    ul.innerHTML = '';
    state.files.forEach((f, i) => {
      ul.append(h('li', {},
        `${f.name} (${Math.round(f.size / 1024)} КБ) `,
        h('a', { href: '#', onclick: (e) => { e.preventDefault(); state.files.splice(i, 1); renderFiles(); } }, 'убрать')));
    });
  }

  function addFiles(list) {
    for (const f of list) state.files.push(f);
    renderFiles();
  }

  /* ---------------- реквизиты ---------------- */

  function addKvRow(name = '', value = '') {
    const row = h('div', { class: 'mod-kv' },
      h('input', { placeholder: 'Реквизит', value: name }),
      h('input', { placeholder: 'Эталонное значение (посимвольно)', value }));
    $('kv-box').append(row);
  }

  function collectFields() {
    const out = {};
    for (const row of $('kv-box').querySelectorAll('.mod-kv')) {
      const [nameEl, valEl] = row.querySelectorAll('input');
      const name = nameEl.value.trim();
      const value = valEl.value;
      if (name && value.trim()) out[name] = value;
    }
    return out;
  }

  /* ---------------- проверка ---------------- */

  async function runCheck() {
    const btn = $('gg-run');
    if (!state.files.length) { toast('Добавьте хотя бы один файл комплекта', 'error'); return; }
    btn.disabled = true;
    $('gg-note').textContent = 'проверка идёт…';
    try {
      const fd = new FormData();
      for (const f of state.files) fd.append('files', f, f.name);
      fd.append('fields', JSON.stringify(collectFields()));
      fd.append('taskDate', $('dt-task').value.trim());
      fd.append('fgisDate', $('dt-fgis').value.trim());
      let res;
      try {
        res = await fetch(`/api/gge/check${projectQuery()}`, { method: 'POST', headers: userHeaders(), body: fd });
      } catch {
        throw new Error('Сервер сейчас недоступен — попробуйте чуть позже');
      }
      if (!res.ok) {
        let msg = `Ошибка сервера (${res.status})`;
        try {
          const data = await res.json();
          if (data && data.needLogin) { localStorage.removeItem('enso-pilot1-auth'); location.reload(); }
          msg = (data && data.error) || msg;
        } catch { /* не JSON */ }
        throw new Error(msg);
      }
      renderResult(await res.json());
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      btn.disabled = false;
      $('gg-note').textContent = '';
    }
  }

  function renderResult(data) {
    $('gg-result').hidden = false;
    $('gg-note').textContent = `файлов: ${data.summary.files} · проблем с именами: ${data.summary.filename_problems} · сканов: ${data.summary.scan_pdfs} · реквизитов с расхождениями: ${data.summary.requisite_problems}`;

    const tbody = $('gg-files');
    tbody.innerHTML = '';
    const layerByFile = Object.fromEntries((data.textLayers || []).map((t) => [t.file, t]));
    for (const f of data.filenames || []) {
      const layer = layerByFile[f.file] || {};
      tbody.append(h('tr', {},
        h('td', {}, f.file),
        h('td', {}, f.ok
          ? h('span', { class: 'mod-badge', 'data-st': 'ПОДТВЕРЖДЕНО' }, 'ок')
          : h('span', { class: 'mod-badge', 'data-st': 'НЕ СООТВЕТСТВУЕТ' }, (f.problems || []).join('; '))),
        h('td', {}, layer.skipped
          ? h('span', { class: 'hint' }, layer.skipped)
          : layer.ok === false
            ? h('span', { class: 'mod-badge', 'data-st': 'НЕ СООТВЕТСТВУЕТ' }, layer.detail || 'текстового слоя нет')
            : h('span', { class: 'mod-badge', 'data-st': 'ПОДТВЕРЖДЕНО' }, layer.pages ? `${layer.pages} стр., текст есть` : 'текст есть')),
      ));
    }

    const reqBox = $('gg-reqs');
    reqBox.innerHTML = '';
    $('gg-req-card').hidden = !(data.requisites || []).length;
    for (const r of data.requisites || []) {
      const card = h('div', { class: 'mod-finding' });
      card.append(h('div', { class: 'head' },
        h('strong', {}, r.field),
        h('span', { class: 'ref' }, `«${r.value}»`),
        r.ok ? h('span', { class: 'mod-badge', 'data-st': 'ПОДТВЕРЖДЕНО' }, 'везде точно') : null));
      for (const d of r.docs || []) {
        card.append(h('p', { class: 'row' },
          h('span', { class: 'mod-badge', 'data-st': d.status }, d.status), ` ${d.file}`,
          d.found ? h('span', {}, ` — найдено: «${d.found}»`) : null,
          d.detail ? h('span', {}, ` — ${d.detail}`) : null));
      }
      reqBox.append(card);
    }

    const forks = $('gg-forks');
    forks.innerHTML = '';
    for (const r of (data.forks && data.forks.rules) || []) {
      forks.append(h('li', {},
        h('span', { class: 'mod-badge', 'data-st': r.applies ? 'ПОДТВЕРЖДЕНО' : 'НЕТ ДАННЫХ' }, r.applies ? 'применимо' : 'не применимо'),
        ` ${r.rule} — ${r.explanation}`));
    }
    const missing = $('gg-forks-missing');
    missing.innerHTML = '';
    for (const m of (data.forks && data.forks.missing) || []) {
      missing.append(h('li', {}, `Не хватает: ${m}`));
    }

    const notes = $('gg-notes');
    notes.innerHTML = '';
    for (const n of data.notes || []) notes.append(h('li', {}, n));
  }

  /* ---------------- кто вошёл ---------------- */

  function renderUserBox() {
    // блок человека теперь рисует общий каркас (shell.js)
    if (window.EnsoShell) window.EnsoShell.renderUser();
  }

  /* ---------------- запуск ---------------- */

  async function init() {
    window.Auth.init();
    await window.Auth.start();
    renderUserBox();
    if (window.EnsoShell) await window.EnsoShell.start();

    const dz = $('f-dz');
    const input = $('f-input');
    dz.addEventListener('click', () => input.click());
    dz.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
    input.addEventListener('change', () => { addFiles(input.files); input.value = ''; });
    dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('dragover'); });
    dz.addEventListener('dragleave', () => dz.classList.remove('dragover'));
    dz.addEventListener('drop', (e) => {
      e.preventDefault();
      dz.classList.remove('dragover');
      if (e.dataTransfer) addFiles(e.dataTransfer.files);
    });

    for (const f of DEFAULT_FIELDS) addKvRow(f, '');
    $('kv-add').addEventListener('click', () => addKvRow('', ''));
    $('gg-run').addEventListener('click', runCheck);
  }

  document.addEventListener('DOMContentLoaded', init);
}());
