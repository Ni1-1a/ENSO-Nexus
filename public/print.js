'use strict';
/**
 * Вкладка «Разбор PDF по форматам» — отдельная страница /print.html вне
 * каркаса проектов (как виртуальный офис). Один экран сверху вниз: файлы →
 * параметры → «Разобрать» → корзины с пакетами на печать.
 *
 * Файлы льются на сервер сразу после добавления, кусками по limits.chunkBytes:
 * через Cloudflare тело запроса больше 100 МБ не проходит, а один файл РД
 * весит 268 МБ. Кусок повторяется до трёх раз, сбой одного файла не мешает
 * остальным. Пакет корзины открывается во вкладке по короткоживущему билету —
 * заголовок X-User-Token в адрес вкладки не передать.
 */
(function () {
  const $ = (id) => document.getElementById(id);
  const SETTINGS_KEY = 'enso-print-settings';
  const RETRIES = 3;

  const S = {
    limits: null, park: null, poppler: true,
    job: null,            // публичный вид разбора с сервера
    queue: [],            // { file: File, id, name } — ждут загрузки
    uploading: false,
    local: new Map(),     // id файла → { progress 0..1, error }
    pollTimer: null,
    ticket: null, ticketAt: 0, ticketUrls: new Map(), ticketTimer: null,
    records: null,
  };

  /* ---------------- утилиты ---------------- */

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
    toastTimer = setTimeout(() => { el.hidden = true; }, type === 'error' ? 6000 : 3000);
  }

  function showError(msg) {
    const box = $('pr-error');
    box.textContent = msg;
    box.hidden = false;
    toast(msg, 'error');
  }
  function clearError() { $('pr-error').hidden = true; }

  function headers(extra) {
    const hh = { ...(extra || {}) };
    if (window.Auth && window.Auth.token) hh['X-User-Token'] = window.Auth.token;
    return hh;
  }

  async function api(path, opts = {}) {
    let res;
    try {
      res = await fetch(path, { ...opts, headers: headers(opts.headers) });
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
    const ct = res.headers.get('content-type') || '';
    return ct.includes('application/json') ? res.json() : res;
  }

  // GET и DELETE идут без тела: fetch с телом у GET бросает TypeError ещё до запроса
  const json = (method, path, body) => api(path, ['POST', 'PUT', 'PATCH'].includes(method)
    ? { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }
    : { method });

  function fmtBytes(n) {
    if (n < 1024) return `${n} Б`;
    if (n < 1048576) return `${Math.round(n / 1024)} КБ`;
    if (n < 1073741824) return `${(n / 1048576).toFixed(n < 10485760 ? 1 : 0)} МБ`;
    return `${(n / 1073741824).toFixed(2)} ГБ`;
  }
  function plural(n, one, few, many) {
    const m10 = n % 10;
    const m100 = n % 100;
    const word = m10 === 1 && m100 !== 11 ? one : (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20) ? few : many);
    return `${n} ${word}`;
  }
  const isPdf = (f) => /\.pdf$/i.test(f.name) || f.type === 'application/pdf';
  const editable = (job) => !job || ['new', 'done', 'error', 'cancelled', 'interrupted'].includes(job.status);

  /* ---------------- настройки ---------------- */

  function readSettings() {
    return {
      tolerance: Number($('pr-tol').value),
      box: $('pr-box').value,
      scanOnly: $('pr-scan').checked,
      multiplesOwn: $('pr-mult').checked,
      plusOwn: $('pr-plus').checked,
      plusRolls: $('pr-plus-rolls').checked,
    };
  }
  function applySettings(st) {
    if (!st) return;
    if (st.tolerance !== undefined) $('pr-tol').value = st.tolerance;
    if (st.box) $('pr-box').value = st.box;
    for (const [id, key] of [['pr-scan', 'scanOnly'], ['pr-mult', 'multiplesOwn'], ['pr-plus', 'plusOwn'], ['pr-plus-rolls', 'plusRolls']]) {
      if (st[key] !== undefined) $(id).checked = !!st[key];
    }
  }
  function saveSettings() {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(readSettings())); } catch { /* приватный режим */ }
  }
  function loadSettings() {
    try { applySettings(JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null')); } catch { /* пусто */ }
  }

  /* ---------------- файлы ---------------- */

  function renderFiles() {
    const ul = $('pr-files');
    ul.innerHTML = '';
    const files = (S.job && S.job.files) || [];
    let total = 0;
    for (const f of files) {
      total += f.size;
      const loc = S.local.get(f.id) || {};
      let st = 'wait';
      let meta = 'ожидает загрузки';
      if (loc.error) { st = 'error'; meta = loc.error; }
      else if (f.complete) { st = 'done'; meta = f.pages ? `${plural(f.pages, 'страница', 'страницы', 'страниц')}` : 'загружен'; }
      else if (loc.progress > 0 || (S.uploading && S.queue[0] && S.queue[0].id === f.id)) { st = 'up'; meta = `загрузка ${Math.round((loc.progress || 0) * 100)} %`; }
      else if (f.received > 0) { st = 'error'; meta = `загружено ${f.received} из ${f.chunks} кусков — добавьте файл заново`; }
      if (f.problem) { st = 'error'; meta = f.problem; }
      const row = h('li', { class: 'pr-file', 'data-st': st },
        h('span', { class: 'pr-file-name', title: f.name }, f.name),
        h('span', { class: 'pr-file-meta' }, `${fmtBytes(f.size)} · ${meta}`),
        h('button', {
          class: 'icon-btn', type: 'button', title: 'Убрать', 'aria-label': `Убрать ${f.name}`,
          disabled: !editable(S.job) || (S.uploading && S.queue.some((q) => q.id === f.id)) ? true : null,
          onclick: () => removeFile(f),
        }, '×'),
        h('div', { class: 'pr-file-bar' }, h('div', { style: `width:${Math.round((loc.progress || 0) * 100)}%` })));
      ul.append(row);
    }
    const note = $('pr-files-note');
    if (!files.length) {
      note.textContent = S.limits ? `До ${S.limits.maxFiles} файлов, до ${fmtBytes(S.limits.maxFileBytes)} каждый и ${fmtBytes(S.limits.maxTotalBytes)} на разбор. Разбор хранится ${plural(S.limits.ttlHours, 'час', 'часа', 'часов')}; новый разбор стирает предыдущий.` : '';
    } else {
      const done = files.filter((f) => f.complete).length;
      note.textContent = `${plural(files.length, 'файл', 'файла', 'файлов')}, ${fmtBytes(total)}${done < files.length ? ` · загружено ${done} из ${files.length}` : ''}`;
    }
    renderRunButton();
  }

  async function ensureJob() {
    if (S.job && editable(S.job)) return S.job;
    if (S.job && !editable(S.job)) throw new Error('Разбор идёт — дождитесь окончания или остановите его');
    const data = await json('POST', '/api/print/jobs');
    S.job = data.job;
    S.local.clear();
    S.records = null;
    hideResult();
    return S.job;
  }

  async function addFiles(list) {
    const files = [...list].filter(isPdf);
    if (!files.length) { toast('Нужны PDF-файлы', 'error'); return; }
    clearError();
    if (!S.poppler) { showError('На сервере нет poppler (pdfinfo) — разбор невозможен, сообщите владельцу платформы'); return; }
    let job;
    try { job = await ensureJob(); } catch (err) { showError(err.message); return; }
    for (const file of files) {
      const name = file.webkitRelativePath && file.webkitRelativePath.includes('/') ? file.name : file.name;
      try {
        const data = await json('POST', `/api/print/jobs/${job.id}/files`, { name, size: file.size });
        job.files.push(data.file);
        S.local.set(data.file.id, { progress: 0 });
        S.queue.push({ file, id: data.file.id, name: data.file.name });
      } catch (err) {
        toast(err.message, 'error');
      }
    }
    if (job.status !== 'new') { job.status = 'new'; job.summary = null; job.packages = []; hideResult(); }
    renderFiles();
    pump();
  }

  /** Загрузчик: один файл за раз, кусок за куском, с повтором. */
  async function pump() {
    if (S.uploading) return;
    S.uploading = true;
    try {
      while (S.queue.length) {
        const item = S.queue[0];
        const job = S.job;
        if (!job || !job.files.some((f) => f.id === item.id)) { S.queue.shift(); continue; }
        try {
          await uploadFile(job, item);
        } catch (err) {
          S.local.set(item.id, { progress: 0, error: err.message });
        }
        S.queue.shift();
        renderFiles();
      }
    } finally {
      S.uploading = false;
      renderFiles();
    }
  }

  async function uploadFile(job, item) {
    const entry = job.files.find((f) => f.id === item.id);
    const chunkSize = entry.chunkSize || S.limits.chunkBytes;
    const chunks = entry.chunks;
    for (let n = 0; n < chunks; n += 1) {
      const start = n * chunkSize;
      const blob = item.file.slice(start, Math.min(item.file.size, start + chunkSize));
      let lastErr = null;
      for (let attempt = 1; attempt <= RETRIES; attempt += 1) {
        try {
          const data = await putChunk(`/api/print/jobs/${job.id}/files/${item.id}/chunks/${n}`, blob, (sent) => {
            S.local.set(item.id, { progress: (start + sent) / item.file.size });
            renderFileProgress(item.id);
          });
          Object.assign(entry, data.file);
          lastErr = null;
          break;
        } catch (err) {
          lastErr = err;
          if (err.fatal) break;
          await new Promise((r) => setTimeout(r, 800 * attempt));
        }
      }
      if (lastErr) throw lastErr;
    }
    S.local.set(item.id, { progress: 1 });
    if (!entry.complete) throw new Error('файл дошёл не целиком — добавьте его заново');
  }

  function putChunk(url, blob, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', url);
      for (const [k, v] of Object.entries(headers({ 'Content-Type': 'application/octet-stream' }))) xhr.setRequestHeader(k, v);
      xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded); };
      xhr.onload = () => {
        let data = null;
        try { data = JSON.parse(xhr.responseText); } catch { /* не JSON */ }
        if (xhr.status >= 200 && xhr.status < 300) { resolve(data || {}); return; }
        if (data && data.needLogin) { localStorage.removeItem('enso-pilot1-auth'); location.reload(); return; }
        const err = new Error((data && data.error) || `Ошибка сервера (${xhr.status})`);
        // 4xx — повтор не поможет (кусок вне диапазона, файл убран); 5xx и обрыв — повторяем
        err.fatal = xhr.status >= 400 && xhr.status < 500 && xhr.status !== 408 && xhr.status !== 429;
        reject(err);
      };
      xhr.onerror = () => reject(new Error('связь оборвалась'));
      xhr.ontimeout = () => reject(new Error('сервер не ответил вовремя'));
      xhr.timeout = 10 * 60 * 1000;
      xhr.send(blob);
    });
  }

  function renderFileProgress(id) {
    const rows = $('pr-files').querySelectorAll('.pr-file');
    const files = (S.job && S.job.files) || [];
    const i = files.findIndex((f) => f.id === id);
    const row = rows[i];
    if (!row) return;
    const loc = S.local.get(id) || {};
    row.dataset.st = 'up';
    row.querySelector('.pr-file-meta').textContent = `${fmtBytes(files[i].size)} · загрузка ${Math.round((loc.progress || 0) * 100)} %`;
    row.querySelector('.pr-file-bar > div').style.width = `${Math.round((loc.progress || 0) * 100)}%`;
  }

  async function removeFile(f) {
    if (!S.job) return;
    try {
      const data = await json('DELETE', `/api/print/jobs/${S.job.id}/files/${f.id}`);
      S.job = data.job;
      S.local.delete(f.id);
      S.queue = S.queue.filter((q) => q.id !== f.id);
      hideResult();
      renderFiles();
    } catch (err) { toast(err.message, 'error'); }
  }

  async function clearAll() {
    if (S.job && !editable(S.job)) { toast('Сначала остановите разбор', 'error'); return; }
    if (S.job) {
      try { await json('DELETE', `/api/print/jobs/${S.job.id}`); } catch (err) { toast(err.message, 'error'); return; }
    }
    S.job = null;
    S.queue = [];
    S.local.clear();
    S.records = null;
    hideResult();
    renderFiles();
  }

  /** Перетаскивание папок: обход через webkitGetAsEntry, файлы — рекурсивно. */
  async function filesFromDrop(dt) {
    const items = dt.items ? [...dt.items] : [];
    const entries = items.map((it) => (it.webkitGetAsEntry ? it.webkitGetAsEntry() : null)).filter(Boolean);
    if (!entries.length || !entries.some((e) => e.isDirectory)) return [...dt.files];
    const out = [];
    const walk = async (entry) => {
      if (entry.isFile) {
        const file = await new Promise((res, rej) => entry.file(res, rej));
        out.push(file);
      } else if (entry.isDirectory) {
        const reader = entry.createReader();
        let batch;
        do {
          batch = await new Promise((res, rej) => reader.readEntries(res, rej));
          for (const e of batch) await walk(e);
        } while (batch.length);
      }
    };
    for (const e of entries) await walk(e);
    return out;
  }

  /* ---------------- запуск и прогресс ---------------- */

  function renderRunButton() {
    const btn = $('pr-run');
    const job = S.job;
    if (job && job.status === 'running') {
      btn.textContent = 'Остановить';
      btn.disabled = false;
      return;
    }
    btn.textContent = 'Разобрать';
    const files = (job && job.files) || [];
    btn.disabled = !files.length || S.uploading || files.some((f) => !f.complete);
  }

  async function onRun() {
    const job = S.job;
    if (!job) { toast('Добавьте PDF', 'error'); return; }
    if (job.status === 'running') {
      try { await json('POST', `/api/print/jobs/${job.id}/cancel`); $('pr-note').textContent = 'останавливаю…'; } catch (err) { toast(err.message, 'error'); }
      return;
    }
    clearError();
    saveSettings();
    try {
      const data = await json('POST', `/api/print/jobs/${job.id}/run`, readSettings());
      S.job = data.job;
      S.records = null;
      hideResult();
      renderFiles();
      renderProgress();
      poll();
    } catch (err) { showError(err.message); }
  }

  const PHASES = { analyze: 'анализ страниц', split: 'разрезание на листы', merge: 'сборка пакетов', done: 'готово' };

  function renderProgress() {
    const job = S.job;
    const box = $('pr-progress');
    if (!job || job.status !== 'running') { box.hidden = true; return; }
    box.hidden = false;
    const p = job.progress || {};
    const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
    $('pr-progress-fill').style.width = `${pct}%`;
    $('pr-progress-text').textContent = `${PHASES[p.phase] || p.phase || ''}: ${p.done || 0} из ${p.total || 0}${p.label ? ` · ${p.label}` : ''}`;
    $('pr-note').textContent = '';
  }

  function poll() {
    clearTimeout(S.pollTimer);
    if (!S.job) return;
    S.pollTimer = setTimeout(async () => {
      try {
        const data = await json('GET', `/api/print/jobs/${S.job.id}`);
        S.job = data.job;
      } catch (err) {
        $('pr-note').textContent = `связь: ${err.message}`;
        poll();
        return;
      }
      renderFiles();
      renderProgress();
      if (S.job.status === 'running') { poll(); return; }
      onFinished();
    }, 1000);
  }

  function onFinished() {
    const job = S.job;
    renderRunButton();
    if (job.status === 'done') { renderResult(); return; }
    if (job.status === 'cancelled') { $('pr-note').textContent = 'Остановлено: исходники на месте, пакеты не собраны.'; return; }
    showError(job.error || 'Разбор не удался');
  }

  /* ---------------- результат ---------------- */

  function hideResult() {
    $('pr-result').hidden = true;
    $('pr-sheets-wrap').hidden = true;
    $('pr-sheets').textContent = 'Показать все листы';
    S.ticket = null;
    S.ticketUrls.clear();
  }

  function renderResult() {
    const job = S.job;
    const sum = job.summary;
    if (!sum) return;
    $('pr-result').hidden = false;
    const problems = job.problems || [];
    $('pr-note').textContent = '';
    $('pr-summary').textContent = `${plural(sum.pages, 'лист', 'листа', 'листов')} из ${plural(sum.files, 'файла', 'файлов', 'файлов')}`
      + (job.settings && job.settings.scanOnly ? ' · только анализ, пакеты не собирались' : ` · пакетов: ${job.packages.length}, ${fmtBytes(sum.packageBytes || 0)}`)
      + (problems.length ? ` · проблем: ${problems.length}` : '');

    const pkgByBucket = new Map(job.packages.map((p) => [p.bucket, p]));
    const box = $('pr-buckets');
    box.innerHTML = '';
    for (const b of sum.buckets) {
      const pkg = pkgByBucket.get(b.bucket);
      const formats = Object.entries(b.formats || {}).map(([k, v]) => `${k}: ${v}`).join(', ');
      const card = h('div', { class: 'pr-bucket', 'data-kind': b.bucket.startsWith('_') ? 'review' : (b.bucket.startsWith('НС') ? 'nc' : 'std') },
        h('div', { class: 'pr-bucket-head' },
          h('span', { class: 'pr-bucket-name' }, b.bucket.replace(/^_/, '').replace(/_/g, ' ')),
          h('span', { class: 'pr-bucket-count' }, plural(b.count, 'лист', 'листа', 'листов'))),
        h('div', { class: 'pr-bucket-carrier' }, b.carrier),
        b.rollWidth ? h('div', { class: 'pr-bucket-meters' }, `рулон ${b.rollWidth} мм · ${b.meters.toFixed(1)} пог. м`) : null,
        formats ? h('div', { class: 'pr-bucket-formats' }, formats) : null,
        // ссылка с target=_blank: браузер не считает её всплывающим окном; адрес
        // подставляется, как только получен билет, до того — запасной путь через openPackage
        pkg ? h('a', {
          class: 'btn btn-primary btn-sm pr-open', href: '#', target: '_blank', rel: 'noopener', 'data-file': pkg.file,
          onclick: (e) => { if (e.currentTarget.getAttribute('href') === '#') { e.preventDefault(); openPackage(pkg); } },
        }, 'Открыть для печати') : null,
        pkg ? h('span', { class: 'pr-bucket-size' }, `${pkg.file} · ${fmtBytes(pkg.bytes)}`) : null);
      box.append(card);
    }

    const rolls = $('pr-rolls');
    rolls.innerHTML = '';
    for (const r of sum.rollMeters || []) {
      rolls.append(h('tr', {}, h('td', {}, `${r.width}`), h('td', {}, r.meters.toFixed(1))));
    }
    $('pr-rolls-card').hidden = !(sum.rollMeters || []).length;

    const pl = $('pr-problems');
    pl.innerHTML = '';
    for (const p of problems) pl.append(h('li', {}, p));
    $('pr-problems-card').hidden = !problems.length;

    if (job.packages.length) ensureTicket().then(linkPackages).catch(() => { /* билет возьмём при нажатии */ });
  }

  /** Адреса пакетов по свежему билету — в ссылки карточек. */
  function linkPackages() {
    for (const a of document.querySelectorAll('.pr-open')) {
      const url = S.ticketUrls.get(a.dataset.file);
      a.setAttribute('href', url || '#');
    }
  }

  /** Билет живёт limits.ticketMinutes; обновляем заранее, чтобы клик открывал вкладку синхронно. */
  async function ensureTicket() {
    const ttlMs = ((S.limits && S.limits.ticketMinutes) || 30) * 60 * 1000;
    if (S.ticket && Date.now() - S.ticketAt < ttlMs * 0.8) return S.ticket;
    const data = await json('POST', `/api/print/jobs/${S.job.id}/tickets`);
    S.ticket = data.ticket;
    S.ticketAt = Date.now();
    S.ticketUrls = new Map(data.packages.map((p) => [p.file, p.url]));
    linkPackages();
    // билет живёт ограниченно — ссылки обновляются заранее, пока страница открыта
    clearTimeout(S.ticketTimer);
    S.ticketTimer = setTimeout(() => { if (S.job && S.job.status === 'done') ensureTicket().catch(() => {}); }, ttlMs * 0.7);
    return S.ticket;
  }

  function openPackage(pkg) {
    const ttlMs = ((S.limits && S.limits.ticketMinutes) || 30) * 60 * 1000;
    const fresh = S.ticket && Date.now() - S.ticketAt < ttlMs * 0.8 && S.ticketUrls.get(pkg.file);
    if (fresh) { window.open(S.ticketUrls.get(pkg.file), '_blank', 'noopener'); return; }
    // окно открываем СЕЙЧАС, в обработчике клика — иначе блокировщик всплывающих окон его съест
    const w = window.open('', '_blank');
    ensureTicket().then(() => {
      const url = S.ticketUrls.get(pkg.file);
      if (!url) throw new Error('Пакет не найден в разборе');
      if (w) w.location.href = url; else window.open(url, '_blank', 'noopener');
    }).catch((err) => {
      if (w) w.close();
      showError(err.message);
    });
  }

  async function downloadReport(kind) {
    const job = S.job;
    if (!job) return;
    try {
      const res = await api(`/api/print/jobs/${job.id}/report.${kind}`);
      const blob = res instanceof Response ? await res.blob() : new Blob([JSON.stringify(res, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = kind === 'csv' ? '_ОТЧЁТ.csv' : '_ОТЧЁТ.json';
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (err) { toast(err.message, 'error'); }
  }

  async function toggleSheets() {
    const wrap = $('pr-sheets-wrap');
    if (!wrap.hidden) { wrap.hidden = true; $('pr-sheets').textContent = 'Показать все листы'; return; }
    if (!S.records) {
      try {
        const data = await json('GET', `/api/print/jobs/${S.job.id}?records=1`);
        S.records = data.records || [];
      } catch (err) { toast(err.message, 'error'); return; }
    }
    const tb = $('pr-sheets-body');
    tb.innerHTML = '';
    const frag = document.createDocumentFragment();
    for (const r of S.records) {
      frag.append(h('tr', {},
        h('td', { title: r.source }, r.source), h('td', {}, r.page), h('td', {}, `${Math.round(r.width)}×${Math.round(r.height)}`),
        h('td', {}, r.rotate || 0), h('td', {}, r.kind), h('td', {}, r.format === '-' ? '—' : r.format), h('td', {}, r.bucket),
        h('td', {}, r.carrier), h('td', {}, r.rollWidth ? r.cut : '—'),
        h('td', {}, r.package ? `${r.package.replace(/^ПАКЕТ_/, '').replace(/\.pdf$/, '')} · ${r.packagePage}` : '—'),
        h('td', {}, r.note || '')));
    }
    tb.append(frag);
    wrap.hidden = false;
    $('pr-sheets').textContent = 'Скрыть листы';
  }

  /* ---------------- запуск страницы ---------------- */

  function renderUser() {
    const u = window.Auth && window.Auth.user;
    $('pb-user').textContent = u ? [u.lastName, u.firstName].filter(Boolean).join(' ') : '';
  }

  async function init() {
    window.Auth.init();
    await window.Auth.start();
    renderUser();
    loadSettings();

    try {
      const park = await json('GET', '/api/print/park');
      S.limits = park.limits;
      S.park = park.park;
      S.poppler = !!(park.tools && park.tools.pdfinfo);
      S.qpdf = !!(park.tools && park.tools.qpdf);
      const rolls = park.park.rolls.map((r) => r.width).join(' / ');
      const plus = park.park.plusRolls.map((r) => r.width).join(' / ');
      $('pr-park-note').textContent = `Парк: листы ${park.park.sheets.map((s) => s.bucket).join(' и ')}, рулоны ${rolls} мм${plus ? `; по флагу — ${plus} мм` : ''}. Формат — по ГОСТ 2.301-68 с допуском; носитель — по короткой стороне листа.`;
      if (!S.poppler) showError('На сервере нет poppler (pdfinfo) — разбор невозможен, сообщите владельцу платформы');
      else if (!S.qpdf) showError('На сервере нет qpdf — будет только анализ, пакеты на печать не соберутся');
    } catch (err) { showError(err.message); }

    try {
      const data = await json('GET', '/api/print/jobs');
      S.job = data.job;
    } catch (err) { showError(err.message); }
    renderFiles();
    if (S.job) {
      applySettings(S.job.settings);
      if (S.job.status === 'running') { renderProgress(); poll(); } else if (S.job.status === 'done') renderResult();
      else if (S.job.status === 'interrupted' || S.job.status === 'error') showError(S.job.error || 'Прошлый разбор не завершился');
    }

    const dz = $('pr-dz');
    const input = $('pr-input');
    const inputDir = $('pr-input-dir');
    dz.addEventListener('click', () => input.click());
    dz.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
    input.addEventListener('change', () => { addFiles(input.files); input.value = ''; });
    inputDir.addEventListener('change', () => { addFiles(inputDir.files); inputDir.value = ''; });
    $('pr-add').addEventListener('click', () => input.click());
    $('pr-add-dir').addEventListener('click', () => inputDir.click());
    $('pr-clear').addEventListener('click', clearAll);
    dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('dragover'); });
    dz.addEventListener('dragleave', () => dz.classList.remove('dragover'));
    dz.addEventListener('drop', async (e) => {
      e.preventDefault();
      dz.classList.remove('dragover');
      if (!e.dataTransfer) return;
      try { addFiles(await filesFromDrop(e.dataTransfer)); } catch (err) { toast(err.message, 'error'); }
    });
    for (const id of ['pr-tol', 'pr-box', 'pr-scan', 'pr-mult', 'pr-plus', 'pr-plus-rolls']) $(id).addEventListener('change', saveSettings);
    $('pr-run').addEventListener('click', onRun);
    $('pr-csv').addEventListener('click', () => downloadReport('csv'));
    $('pr-json').addEventListener('click', () => downloadReport('json'));
    $('pr-sheets').addEventListener('click', toggleSheets);
    window.addEventListener('beforeunload', (e) => {
      if (S.uploading) { e.preventDefault(); e.returnValue = ''; }
    });
  }

  document.addEventListener('DOMContentLoaded', init);
}());
