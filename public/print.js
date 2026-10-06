'use strict';
/**
 * Вкладка «Разбор PDF по форматам» — отдельная страница /print.html вне
 * каркаса проектов (как виртуальный офис). Один экран сверху вниз: файлы →
 * параметры → «Разобрать» → корзины с пакетами → скачать → переплёт → время
 * печати → нормоконтроль тома.
 *
 * Файлы льются на сервер сразу после добавления, кусками по limits.chunkBytes:
 * через Cloudflare тело запроса больше 100 МБ не проходит, а один файл РД
 * весит 268 МБ. Кусок повторяется до трёх раз, сбой одного файла не мешает
 * остальным. Пакеты и отчёты открываются и скачиваются по короткоживущему
 * билету — обычными ссылками, а не blob: Safari теряет жест пользователя у
 * a.download, созданного после await (А5).
 */
(function () {
  const $ = (id) => document.getElementById(id);
  const SETTINGS_KEY = 'enso-print-settings';
  const RETRIES = 3;

  const S = {
    limits: null, park: null, poppler: true, qpdf: true, pdftotext: true, owner: false,
    job: null,            // публичный вид разбора с сервера
    queue: [],            // { file: File, id, name } — ждут загрузки
    uploading: false,
    local: new Map(),     // id файла → { progress 0..1, error }
    pollTimer: null,
    ticket: null, ticketAt: 0, ticketUrls: new Map(), ticketDownloads: new Map(), ticketReports: {}, ticketZip: '', ticketTimer: null,
    records: null, sort: { key: '', dir: 1 },
    bindings: [], bindingDefaults: null,
    printers: [], presets: [], modeTitles: {},
    fold: null,
    tomeCheck: null,
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
    for (const kid of kids.flat(Infinity)) {
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
  function fmtDur(sec) {
    const s = Math.round(sec);
    if (s < 60) return `${s} с`;
    const m = Math.round(s / 60);
    if (m < 60) return `${m} мин`;
    const hh = Math.floor(m / 60), mm = m % 60;
    return `${hh} ч ${String(mm).padStart(2, '0')} мин`;
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
      grouping: $('pr-grouping').value,
      maxPackageMb: Number($('pr-max-mb').value) || 0,
      maxPackagePages: Number($('pr-max-pages').value) || 0,
    };
  }
  function applySettings(st) {
    if (!st) return;
    if (st.tolerance !== undefined) $('pr-tol').value = st.tolerance;
    if (st.box) $('pr-box').value = st.box;
    if (st.grouping) $('pr-grouping').value = st.grouping;
    if (st.maxPackageMb !== undefined) $('pr-max-mb').value = st.maxPackageMb || 0;
    if (st.maxPackagePages !== undefined) $('pr-max-pages').value = st.maxPackagePages || 0;
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
      const name = file.name;
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

  const PHASES = { analyze: 'анализ страниц', split: 'деление по пределу', merge: 'сборка пакетов', done: 'готово' };

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
    $('bd-result').innerHTML = '';
    $('sc-result').innerHTML = '';
    $('tc-result').innerHTML = '';
    $('tc-export').hidden = true;
    S.ticket = null;
    S.ticketUrls.clear();
    S.ticketDownloads.clear();
    S.ticketReports = {};
    S.ticketZip = '';
  }

  function renderResult() {
    const job = S.job;
    const sum = job.summary;
    if (!sum) return;
    $('pr-result').hidden = false;
    const problems = job.problems || [];
    $('pr-note').textContent = '';
    $('pr-summary').textContent = `${plural(sum.pages, 'лист', 'листа', 'листов')} из ${plural(sum.files, 'файла', 'файлов', 'файлов')}`
      + (job.settings && job.settings.scanOnly ? ' · только анализ, пакеты не собирались' : ` · пакетов: ${job.packages.length}${sum.parts ? ` (частей: ${sum.parts})` : ''}, ${fmtBytes(sum.packageBytes || 0)}`)
      + (sum.grouping === 'tomes' ? ` · томов: ${sum.tomes}` : '')
      + (problems.length ? ` · проблем: ${problems.length}` : '');

    // А2: физические листы и приведённые листы — две разные величины, подписаны обе
    const totals = $('pr-totals');
    totals.innerHTML = '';
    const ph = sum.physical || { sheetsA4: 0, sheetsA3: 0 };
    const rd = sum.reduced || { a4: 0, a3: 0 };
    totals.append(
      h('div', { class: 'pr-total' }, h('b', {}, `${ph.sheetsA4} А4 + ${ph.sheetsA3} А3`), h('span', {}, 'физических листов бумаги в листовые принтеры (А4: А4, А5, НС на листе А4; А3: А3, НС на листе А3). Рулоны — ниже, в погонных метрах')),
      h('div', { class: 'pr-total' }, h('b', {}, `${rd.a4} А4 · ${rd.a3} А3`), h('span', {}, `приведённых листов по площади (А3 = 2 А4, А0 = 16 А4, НС — вверх): объём для договора и сметы на печать. ГОСТ ${rd.a4Gost || 0} + НС ${rd.a4Nc || 0}. Слои сложенного листа в томе — другая величина, см. «Переплёт»`)),
    );

    const pkgByBucket = new Map();
    for (const p of job.packages) {
      if (!pkgByBucket.has(p.bucket)) pkgByBucket.set(p.bucket, []);
      pkgByBucket.get(p.bucket).push(p);
    }
    const box = $('pr-buckets');
    box.innerHTML = '';
    for (const b of sum.buckets) {
      const pkgs = pkgByBucket.get(b.bucket) || [];
      const formats = Object.entries(b.formats || {}).map(([k, v]) => `${k}: ${v}`).join(', ');
      const kind = b.bucket.startsWith('_') ? 'review' : (b.bucket.startsWith('НС') ? 'nc' : 'std');
      const card = h('div', { class: 'pr-bucket', 'data-kind': kind },
        h('div', { class: 'pr-bucket-head' },
          h('span', { class: 'pr-bucket-name' }, b.bucket.replace(/^_/, '').replace(/_/g, ' ')),
          h('span', { class: 'pr-bucket-count' }, plural(b.count, 'лист', 'листа', 'листов'))),
        h('div', { class: 'pr-bucket-carrier' }, (b.carriers || []).length > 1 ? b.carriers.map((c) => `${c.carrier}: ${c.count}`).join(' · ') : b.carrier),
        b.rollWidth ? h('div', { class: 'pr-bucket-meters' }, `рулон ${b.rollWidth} мм · ${b.meters.toFixed(1)} пог. м`) : null,
        formats ? h('div', { class: 'pr-bucket-formats' }, formats) : null,
        // А1: разбивка НС по фактическим размерам, по ширине, потом по длине
        b.sizes && b.sizes.length ? h('div', { class: 'pr-bucket-sizes' }, b.sizes.map((s, i) => [i ? ', ' : '', h('b', {}, s.label), ` — ${s.count}`])) : null,
        pkgs.length === 1 && sum.grouping !== 'tomes' ? packageLinks(pkgs[0]) : null,
        pkgs.length > 1 && sum.grouping !== 'tomes' ? h('div', { class: 'pr-bucket-links' }, pkgs.map((p) => packageChip(p))) : null,
        pkgs.length && sum.grouping === 'tomes' ? h('div', { class: 'pr-bucket-size' }, `пакетов по томам: ${pkgs.length} · ${fmtBytes(pkgs.reduce((s, p) => s + p.bytes, 0))}`) : null);
      box.append(card);
    }

    // А4: пакеты по томам
    const tc = $('pr-tomes-card');
    if (sum.grouping === 'tomes') {
      tc.hidden = false;
      const list = $('pr-tomes');
      list.innerHTML = '';
      for (const t of job.tomes || []) {
        const pk = job.packages.filter((p) => p.tome && p.tome.fileId === t.fileId);
        list.append(h('div', { class: 'pr-tome' },
          h('div', { class: 'pr-tome-head' }, h('b', {}, t.title), h('span', {}, `${t.name}${t.recognized ? '' : ' · марка не распознана, заголовок — имя файла'} · пакетов ${pk.length}`)),
          h('div', { class: 'pr-tome-pkgs' }, pk.map((p) => packageChip(p)))));
      }
    } else tc.hidden = true;

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

    renderDownloads();
    renderBindingInputs();
    if (job.binding) renderBinding(job.binding);
    if (job.schedule) renderSchedule(job.schedule);
    if (job.tomeCheck) renderTomeCheck(job.tomeCheck);
    ensureTicket().then(linkPackages).catch(() => { /* билет возьмём при нажатии */ });
  }

  /** Кнопки пакета: открыть во вкладке и скачать — обе обычные ссылки, адрес подставляется по билету. */
  function packageLinks(pkg) {
    return h('div', { class: 'pr-bucket-links' },
      h('a', { class: 'btn btn-primary btn-sm pr-open', href: '#', target: '_blank', rel: 'noopener', 'data-file': pkg.file, onclick: (e) => openGuard(e, pkg, false) }, 'Открыть для печати'),
      h('a', { class: 'btn btn-quiet btn-sm pr-dl', href: '#', 'data-file': pkg.file, onclick: (e) => openGuard(e, pkg, true) }, 'Скачать'),
      h('span', { class: 'pr-bucket-size' }, `${pkg.file} · ${fmtBytes(pkg.bytes)}`));
  }

  function packageChip(p) {
    return h('span', { class: 'pr-pkg', 'data-oversize': p.oversize ? '1' : null, title: `${p.file} · ${fmtBytes(p.bytes)}${p.oversize ? ' · лист больше предела' : ''}` },
      h('a', { class: 'pr-open', href: '#', target: '_blank', rel: 'noopener', 'data-file': p.file, onclick: (e) => openGuard(e, p, false) }, p.file.replace(/\.pdf$/i, '')),
      h('span', {}, fmtBytes(p.bytes)),
      h('a', { class: 'pr-dl', href: '#', 'data-file': p.file, title: 'Скачать', 'data-file-dl': '1', onclick: (e) => openGuard(e, p, true) }, '↓'));
  }

  /** Ссылка без адреса (билет ещё не пришёл) — берём билет и открываем сами. */
  function openGuard(e, pkg, download) {
    if (e.currentTarget.getAttribute('href') !== '#') return;
    e.preventDefault();
    openPackage(pkg, download);
  }

  function renderDownloads() {
    const box = $('pr-downloads');
    box.innerHTML = '';
    box.append(
      h('a', { class: 'btn btn-primary btn-sm pr-zip', href: '#', onclick: (e) => { if (e.currentTarget.getAttribute('href') === '#') { e.preventDefault(); ensureTicket().then(() => { if (S.ticketZip) location.href = S.ticketZip; }).catch((err) => showError(err.message)); } } }, 'Скачать всё (ZIP)'),
      h('a', { class: 'btn btn-quiet btn-sm pr-rep', href: '#', 'data-report': '_ОТЧЁТ.csv', onclick: reportGuard }, 'Скачать CSV'),
      h('a', { class: 'btn btn-quiet btn-sm pr-rep', href: '#', 'data-report': '_ОТЧЁТ.json', onclick: reportGuard }, 'Скачать JSON'),
    );
    if (S.job.summary.grouping === 'tomes') {
      $('pr-map-links').innerHTML = '';
      $('pr-map-links').append(
        h('a', { class: 'btn btn-quiet btn-sm pr-rep', href: '#', 'data-report': 'карта_сборки.html', 'data-inline': '1', target: '_blank', rel: 'noopener', onclick: reportGuard }, 'Карта сборки (печатная)'),
        h('a', { class: 'btn btn-quiet btn-sm pr-rep', href: '#', 'data-report': 'карта_сборки.csv', onclick: reportGuard }, 'Карта сборки CSV'));
    }
  }

  function reportGuard(e) {
    const a = e.currentTarget;
    if (a.getAttribute('href') !== '#') return;
    e.preventDefault();
    const name = a.dataset.report;
    const w = a.dataset.inline ? window.open('', '_blank') : null;
    ensureTicket().then(() => {
      const r = S.ticketReports[name];
      if (!r) throw new Error('Отчёт ещё не готов');
      if (w) w.location.href = r.url; else location.href = r.download;
    }).catch((err) => { if (w) w.close(); showError(err.message); });
  }

  /** Адреса пакетов и отчётов по свежему билету — в ссылки карточек. */
  function linkPackages() {
    for (const a of document.querySelectorAll('.pr-open')) a.setAttribute('href', S.ticketUrls.get(a.dataset.file) || '#');
    for (const a of document.querySelectorAll('.pr-dl')) a.setAttribute('href', S.ticketDownloads.get(a.dataset.file) || '#');
    for (const a of document.querySelectorAll('.pr-rep')) {
      const r = S.ticketReports[a.dataset.report];
      a.setAttribute('href', r ? (a.dataset.inline ? r.url : r.download) : '#');
    }
    for (const a of document.querySelectorAll('.pr-zip')) a.setAttribute('href', S.ticketZip || '#');
  }

  /** Билет живёт limits.ticketMinutes; обновляем заранее, чтобы клик открывал вкладку синхронно. */
  async function ensureTicket() {
    const ttlMs = ((S.limits && S.limits.ticketMinutes) || 30) * 60 * 1000;
    if (S.ticket && Date.now() - S.ticketAt < ttlMs * 0.8) return S.ticket;
    const data = await json('POST', `/api/print/jobs/${S.job.id}/tickets`);
    S.ticket = data.ticket;
    S.ticketAt = Date.now();
    S.ticketUrls = new Map(data.packages.map((p) => [p.file, p.url]));
    S.ticketDownloads = new Map(data.packages.map((p) => [p.file, p.download]));
    S.ticketReports = data.reports || {};
    S.ticketZip = data.zip || '';
    linkPackages();
    // билет живёт ограниченно — ссылки обновляются заранее, пока страница открыта
    clearTimeout(S.ticketTimer);
    S.ticketTimer = setTimeout(() => { if (S.job && S.job.status === 'done') ensureTicket().catch(() => {}); }, ttlMs * 0.7);
    // вкладка могла лежать в фоне дольше срока билета — при возврате билет обновляется
    return S.ticket;
  }

  function openPackage(pkg, download) {
    const ttlMs = ((S.limits && S.limits.ticketMinutes) || 30) * 60 * 1000;
    const fresh = S.ticket && Date.now() - S.ticketAt < ttlMs * 0.8 && S.ticketUrls.get(pkg.file);
    if (fresh) {
      if (download) location.href = S.ticketDownloads.get(pkg.file);
      else window.open(S.ticketUrls.get(pkg.file), '_blank', 'noopener');
      return;
    }
    // окно открываем СЕЙЧАС, в обработчике клика — иначе блокировщик всплывающих окон его съест
    const w = download ? null : window.open('', '_blank');
    ensureTicket().then(() => {
      const url = download ? S.ticketDownloads.get(pkg.file) : S.ticketUrls.get(pkg.file);
      if (!url) throw new Error('Пакет не найден в разборе');
      if (download) location.href = url;
      else if (w) w.location.href = url; else window.open(url, '_blank', 'noopener');
    }).catch((err) => {
      if (w) w.close();
      showError(err.message);
    });
  }

  /* ---------------- таблица листов с сортировкой ---------------- */

  async function toggleSheets() {
    const wrap = $('pr-sheets-wrap');
    if (!wrap.hidden) { wrap.hidden = true; $('pr-sheets').textContent = 'Показать все листы'; return; }
    if (!S.records) {
      try {
        const data = await json('GET', `/api/print/jobs/${S.job.id}?records=1`);
        S.records = data.records || [];
      } catch (err) { toast(err.message, 'error'); return; }
    }
    renderSheets();
    wrap.hidden = false;
    $('pr-sheets').textContent = 'Скрыть листы';
  }

  function renderSheets() {
    const tb = $('pr-sheets-body');
    tb.innerHTML = '';
    const rows = S.records.slice();
    const { key, dir } = S.sort;
    if (key) {
      rows.sort((a, b) => {
        const va = a[key], vb = b[key];
        const c = typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va ?? '').localeCompare(String(vb ?? ''), 'ru', { numeric: true });
        return c * dir || a.source.localeCompare(b.source, 'ru', { numeric: true }) || a.page - b.page;
      });
    }
    for (const th of $('pr-sheets-table').querySelectorAll('th[data-sort]')) th.classList.toggle('asc', th.dataset.sort === key && dir === 1), th.classList.toggle('desc', th.dataset.sort === key && dir === -1);
    const frag = document.createDocumentFragment();
    for (const r of rows) {
      frag.append(h('tr', {},
        h('td', { title: r.source }, r.source), h('td', {}, r.page), h('td', {}, `${Math.round(r.width)}×${Math.round(r.height)}`),
        h('td', {}, r.rotate || 0), h('td', {}, r.kind), h('td', {}, r.format === '-' ? '—' : r.format), h('td', {}, r.bucket),
        h('td', {}, r.carrier), h('td', {}, r.rollWidth ? r.cut : '—'),
        h('td', {}, r.package ? `${r.package.replace(/^ПАКЕТ_/, '').replace(/\.pdf$/, '')} · ${r.packagePage}` : '—'),
        h('td', {}, r.note || '')));
    }
    tb.append(frag);
  }

  function onSortClick(e) {
    const th = e.target.closest('th[data-sort]');
    if (!th || !S.records) return;
    const key = th.dataset.sort;
    if (S.sort.key === key) S.sort.dir = -S.sort.dir; else S.sort = { key, dir: 1 };
    renderSheets();
  }

  /* ---------------- переплёт (А6) и модель складывания (Б2) ---------------- */

  function renderBindingInputs() {
    const sel = $('bd-binding');
    if (!sel.options.length) for (const b of S.bindings) sel.append(h('option', { value: b.id }, b.title));
    const d = S.bindingDefaults;
    const st = (S.job.binding && S.job.binding.settings) || d;
    if (!st) return;
    $('bd-copies').value = st.copies; $('bd-binding').value = st.binding; $('bd-gsm').value = st.gsm;
    $('bd-cover').value = st.coverMm; $('bd-backing').value = st.backingMm; $('bd-reserve').value = st.reservePct;
    $('bd-fold').value = st.foldPreset; $('bd-inserts').checked = !!st.inserts;
    $('bd-custom-wrap').hidden = st.foldPreset !== 'custom';
    for (const f of ['a3', 'a2', 'a1', 'a0']) { const v = (st.foldTable || {})[`А${f.slice(1)}`]; if (v) $(`bd-c-${f}`).value = v; }
    $('sc-copies').value = st.copies || 1;
  }

  function readBinding() {
    const perTome = {};
    for (const inp of document.querySelectorAll('[data-tome-copies]')) {
      const v = Number(inp.value);
      if (inp.value !== '' && Number.isFinite(v)) perTome[inp.dataset.tomeCopies] = v;
    }
    const foldTable = {};
    if ($('bd-fold').value === 'custom') for (const f of ['a3', 'a2', 'a1', 'a0']) foldTable[`А${f.slice(1)}`] = Number($(`bd-c-${f}`).value);
    return {
      copies: Number($('bd-copies').value), binding: $('bd-binding').value, gsm: Number($('bd-gsm').value),
      coverMm: Number($('bd-cover').value), backingMm: Number($('bd-backing').value), reservePct: Number($('bd-reserve').value),
      foldPreset: $('bd-fold').value, foldTable, inserts: $('bd-inserts').checked, perTome,
    };
  }

  async function runBinding() {
    $('bd-note').textContent = 'считаю…';
    try {
      const data = await json('POST', `/api/print/jobs/${S.job.id}/binding`, readBinding());
      S.job.binding = data;
      renderBinding(data);
      $('bd-note').textContent = '';
    } catch (err) { $('bd-note').textContent = ''; showError(err.message); }
  }

  function renderBinding(b) {
    const box = $('bd-result');
    box.innerHTML = '';
    const st = b.settings;
    const rows = b.tomes.map((t) => h('tr', {},
      h('td', {}, t.tome.title),
      h('td', {}, t.sheets),
      h('td', {}, h('input', { type: 'number', min: 0, max: 999, value: t.copies, 'data-tome-copies': t.tome.fileId, style: 'width:64px' })),
      h('td', {}, `${t.layersMax} / ${t.layersSpine}`),
      h('td', {}, `${t.thicknessMaxMm} / ${t.thicknessSpineMm}`),
      h('td', {}, `${t.blockMm}${t.books > 1 ? ` (${t.books} кн. по ${t.blockPerBookMm})` : ''}`),
      h('td', {}, t.spring ? `${t.spring.diameterMm} мм${t.spring.inch ? ` (${t.spring.inch}″)` : ''} · до ${t.spring.sheets} л.` : (st.binding === 'folder' ? '—' : 'нет')),
      h('td', {}, st.inserts ? `${t.insertsPerBook} × ${st.insertMm} мм` : '—'),
      h('td', { class: 'hint' }, t.note || '')));
    box.append(
      h('div', { class: 'mod-table-wrap' }, h('table', { class: 'stat-table pr-table-sm' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Том'), h('th', {}, 'Листов'), h('th', {}, 'Экз.'), h('th', {}, 'Слоёв: всего / в подшивке'), h('th', {}, 'Толщина, мм: кромка / корешок'), h('th', {}, 'Блок, мм'), h('th', {}, 'Пружина'), h('th', {}, 'Вкладышей на книгу'), h('th', {}, 'Примечание'))),
        h('tbody', {}, rows))));
    const p = b.purchase;
    const cards = [
      h('div', { class: 'pr-total' }, h('b', {}, `${p.books}`), h('span', {}, `книг к переплёту (${p.bindingTitle}), запас ${p.reservePct} %`)),
      ...p.springs.map((s) => h('div', { class: 'pr-total' }, h('b', {}, `${s.count} → ${s.withReserve}`), h('span', {}, `пружин ${s.diameterMm} мм${s.inch ? ` (${s.inch}″)` : ''}`))),
      h('div', { class: 'pr-total' }, h('b', {}, `${p.covers.count} → ${p.covers.withReserve}`), h('span', {}, `обложек ${st.coverMm} мм`)),
      h('div', { class: 'pr-total' }, h('b', {}, `${p.backings.count} → ${p.backings.withReserve}`), h('span', {}, `подложек ${st.backingMm} мм`)),
    ];
    if (p.inserts) cards.push(h('div', { class: 'pr-total' }, h('b', {}, `${p.inserts.count} → ${p.inserts.withReserve}`), h('span', {}, `вкладышей ${p.inserts.thicknessMm} мм в корешок`)));
    box.append(h('h3', {}, 'На закупку'), h('div', { class: 'bd-purchase' }, cards));
    const verify = b.tomes.find((t) => t.verify);
    if (verify) box.append(h('p', { class: 'hint' }, `Таблица пружин — у поставщика по ссылке в конфиге расходников; ${verify.verify}.`));
    $('sc-copies').value = st.copies || 1;
  }

  async function toggleFold() {
    const box = $('bd-fold');
    if (!box.hidden) { box.hidden = true; return; }
    if (!S.fold) {
      try { S.fold = await json('GET', '/api/print/fold'); } catch (err) { showError(err.message); return; }
    }
    box.innerHTML = '';
    const t = S.fold.table;
    box.append(
      h('p', { class: 'hint' }, `Схема: ${S.fold.sources.gost}. «ГОСТ» — наибольшее число слоёв по схеме (столбцов панелей × строк), в скобках — слоёв в зоне подшивки; «уголок» — сколько слоёв добавляет диагональный загиб верхних строк (у кромки подшивки, не в самой толстой зоне). Владельческие 7, 11 и 23 = ГОСТ + уголок: А2 6+1, А1 10+1, А0 21+2; у А3 уголка нет — 3 = 3.`),
      h('div', { class: 'mod-table-wrap' }, h('table', { class: 'stat-table pr-table-sm' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Формат'), h('th', {}, 'Лист, мм'), h('th', {}, 'Панели по ширине'), h('th', {}, 'Строк'), h('th', {}, 'ГОСТ: слоёв (в подшивке)'), h('th', {}, 'Уголок'), h('th', {}, 'Прикидка'), h('th', {}, 'Владелец'), h('th', {}, 'По площади, А4'))),
        h('tbody', {}, t.map((r) => h('tr', {}, h('td', {}, r.format), h('td', {}, r.size), h('td', {}, r.columns.join(' | ')), h('td', {}, r.rows), h('td', {}, `${r.gost} (${r.gostBinding})`), h('td', {}, `+${r.gostCorner}`), h('td', {}, r.estimate), h('td', {}, r.owner ?? '—'), h('td', {}, r.area)))))),
      h('div', { class: 'bd-fold-grid' }, Object.entries(S.fold.svg).filter(([k]) => k !== 'А5' && k !== 'А4').map(([k, svg]) => {
        const fig = h('figure', {});
        fig.innerHTML = svg;
        fig.append(h('figcaption', {}, `${k}: линии сгиба по порядку, поле подшивки с отверстиями, основная надпись справа внизу`));
        return fig;
      })));
    box.hidden = false;
  }

  /* ---------------- время печати (А3) ---------------- */

  async function loadPrinters() {
    const data = await json('GET', '/api/print/printers');
    S.printers = data.printers; S.presets = data.presets; S.owner = data.owner; S.modeTitles = data.modeTitles || {};
    const sel = $('pk-preset');
    sel.innerHTML = '';
    for (const p of S.presets) sel.append(h('option', { value: p.id }, p.name));
    renderPark();
  }

  async function runSchedule() {
    $('sc-note').textContent = 'считаю…';
    try {
      if (!S.printers.length) await loadPrinters();
      const ids = [...document.querySelectorAll('[data-printer-use]')].filter((c) => c.checked).map((c) => c.dataset.printerUse);
      const data = await json('POST', `/api/print/jobs/${S.job.id}/schedule`, {
        mode: $('sc-mode').value, duplex: $('sc-duplex').checked, copies: Number($('sc-copies').value) || 1,
        printerIds: ids.length ? ids : undefined,
      });
      S.job.schedule = data;
      renderSchedule(data);
      $('sc-note').textContent = '';
    } catch (err) { $('sc-note').textContent = ''; showError(err.message); }
  }

  function renderSchedule(plan) {
    const box = $('sc-result');
    box.innerHTML = '';
    box.append(h('div', { class: 'sc-summary' },
      h('div', { class: 'pr-total' }, h('b', {}, `≈ ${fmtDur(plan.makespanSec)}`), h('span', {}, `будет готово через (вилка ${fmtDur(plan.lowSec)} … ${fmtDur(plan.highSec)}), ${plural(plan.copies, 'экземпляр', 'экземпляра', 'экземпляров')}, режим «${S.modeTitles[plan.mode] || plan.mode}»`)),
      h('div', { class: 'pr-total' }, h('b', {}, fmtDur(plan.machineSec)), h('span', {}, 'суммарное машинное время по всем принтерам')),
      h('div', { class: 'pr-total' }, h('b', {}, `${plan.queues.filter((q) => q.queue.length).length} из ${plan.queues.length}`), h('span', {}, 'принтеров занято'))));
    const span = Math.max(1, plan.makespanSec);
    const tl = h('div', { class: 'sc-timeline' });
    for (const q of plan.queues) {
      const bar = h('div', { class: 'sc-bar' });
      let cursor = 0;
      for (const item of q.queue) {
        if (item.warmupSec) { bar.append(h('div', { class: 'sc-seg', 'data-kind': 'warm', style: `left:${(cursor / span) * 100}%;width:${(item.warmupSec / span) * 100}%`, title: `прогрев ${fmtDur(item.warmupSec)}` })); cursor += item.warmupSec; }
        if (item.rollChangeSec) { bar.append(h('div', { class: 'sc-seg', 'data-kind': 'change', style: `left:${(cursor / span) * 100}%;width:${(item.rollChangeSec / span) * 100}%`, title: `смена рулона ${fmtDur(item.rollChangeSec)}` })); cursor += item.rollChangeSec; }
        const parts = item.parts || {};
        bar.append(h('div', { class: 'sc-seg', style: `left:${(cursor / span) * 100}%;width:${(item.sec / span) * 100}%`,
          title: `${item.label}: ${fmtDur(item.sec)} (печать ${fmtDur(parts.print || 0)}, RIP ${fmtDur(parts.rip || 0)}, отрез ${fmtDur(parts.cut || 0)}, первая ${fmtDur(parts.first || 0)}; коэффициент ${item.factor}${item.mode ? `, режим ${S.modeTitles[item.mode] || item.mode}` : ''})` }, item.label));
        cursor += item.sec;
      }
      tl.append(h('div', { class: 'sc-row' },
        h('div', { class: 'sc-row-name', title: q.printer.name }, q.printer.name, q.rollChanges ? h('span', { class: 'hint' }, ` · смен рулона: ${q.rollChanges}`) : null),
        bar,
        h('div', {}, q.totalSec ? `${fmtDur(q.lowSec)}…${fmtDur(q.highSec)}` : '—')));
    }
    box.append(tl);
    if (plan.skipped.length) {
      box.append(h('div', { class: 'sc-skipped' }, 'Не распределено: ', h('ul', {}, plan.skipped.map((s) => h('li', {}, `${s.label}: ${s.why}`)))));
    }
    box.append(h('p', { class: 'hint' }, 'Паспортные скорости — в карточках принтеров (ссылки на источники там же). Рулонный: «с на А1» на рулоне 36″ с подачей А1 поперёк (594 мм протяжки) → протяжка v = 594 / t мм/с; время отреза = длина отреза / v. Листовой: 60 / стр·мин на лист. Накладные — оценки, их правит оператор; калибровка по факту подстраивает коэффициент.'));
  }

  function renderPark() {
    const list = $('pk-list');
    list.innerHTML = '';
    $('pk-note').textContent = `Общий парк офиса правит владелец платформы${S.owner ? ' (это вы)' : ''}; личные принтеры каждый добавляет себе сам. Цифры пресетов — из паспортов производителя, ссылка в карточке.`;
    for (const p of S.printers) {
      const canEdit = p.scope === 'personal' || S.owner;
      const speed = p.type === 'sheet'
        ? `до ${p.sheet.maxSheet}; А4 ${p.sheet.ppmA4.mono || '—'}/${p.sheet.ppmA4.color || '—'} стр/мин, А3 ${p.sheet.ppmA3.mono || '—'}/${p.sheet.ppmA3.color || '—'}${p.sheet.duplex ? ', дуплекс' : ''}`
        : `рулоны: ${p.roll.loaded.join(', ') || '—'} мм (на полке ${p.roll.stock.join(', ') || '—'}), до ${p.roll.maxWidthMm} мм, держателей ${p.roll.holders}; с на А1: ${['draft', 'normal', 'best'].map((m) => `${S.modeTitles[m] || m} ${p.roll.modes[m] ? (p.roll.modes[m].secPerA1 || (p.roll.modes[m].a1PerHour ? Math.round(3600 / p.roll.modes[m].a1PerHour) : '—')) : '—'}`).join(', ')}`;
      const o = p.overhead || {};
      const est = S.job && S.job.schedule ? S.job.schedule.queues.find((q) => q.printer.id === p.id) : null;
      const estInp = h('input', { type: 'number', min: 1, step: 1, placeholder: 'оценка, с', value: est && est.totalSec ? est.totalSec : '' });
      const actInp = h('input', { type: 'number', min: 1, step: 1, placeholder: 'факт, с' });
      list.append(h('div', { class: 'pk-item', 'data-off': p.enabled === false ? '1' : null },
        h('div', {}, h('label', { class: 'pk-check' }, h('input', { type: 'checkbox', checked: p.enabled !== false ? true : null, 'data-printer-use': p.id }), ' ', h('b', {}, p.name)), ` · ${p.scope === 'office' ? 'парк офиса' : 'личный'} · коэффициент ${p.factor || 1}${(p.history || []).length ? ` (калибровок: ${p.history.length})` : ''}`),
        h('div', { class: 'hint' }, speed),
        h('div', { class: 'hint' }, `накладные: прогрев ${o.warmupSec || 0} с, первая страница ${o.firstPageSec || 0} с, RIP ${o.ripSecPerMb || 0} с/МБ + ${o.ripSecPerSheet || 0} с/лист${p.type === 'roll' ? `, отрез ${o.cutSec || 0} с, смена рулона ${o.rollChangeSec || 0} с` : ''}, вилка ±${p.uncertaintyPct ?? 25} %`),
        p.source && p.source.url ? h('div', { class: 'hint' }, 'источник: ', h('a', { href: p.source.url, target: '_blank', rel: 'noopener' }, p.source.url.replace(/^https?:\/\//, '').slice(0, 70)), p.source.note ? ` — ${p.source.note.slice(0, 160)}${p.source.note.length > 160 ? '…' : ''}` : '') : null,
        h('div', { class: 'pr-actions' },
          canEdit ? h('button', { class: 'btn btn-quiet btn-sm', type: 'button', onclick: () => openPrinterForm(p) }, 'Править') : null,
          canEdit ? h('button', { class: 'btn btn-quiet btn-sm', type: 'button', onclick: () => removePrinter(p) }, 'Убрать') : null,
          canEdit ? h('span', { class: 'pk-cal' }, 'калибровка: ', estInp, actInp, h('button', { class: 'btn btn-quiet btn-sm', type: 'button', onclick: () => calibrate(p, estInp.value, actInp.value) }, 'Внести факт')) : h('span', { class: 'hint' }, 'правит владелец'))));
    }
  }

  async function removePrinter(p) {
    if (!window.confirm(`Убрать «${p.name}» из парка?`)) return;
    try { await json('DELETE', `/api/print/printers/${encodeURIComponent(p.id)}`); await loadPrinters(); } catch (err) { showError(err.message); }
  }

  async function calibrate(p, est, act) {
    try {
      await json('POST', `/api/print/printers/${encodeURIComponent(p.id)}/calibrate`, { estimatedSec: Number(est), actualSec: Number(act) });
      toast('Коэффициент пересчитан');
      await loadPrinters();
    } catch (err) { showError(err.message); }
  }

  async function addFromPreset() {
    try {
      await json('POST', '/api/print/printers', { presetId: $('pk-preset').value, scope: S.owner ? 'office' : 'personal' });
      await loadPrinters();
    } catch (err) { showError(err.message); }
  }

  /** Форма принтера: поля по типу; что не паспорт — пусто, не выдумано. */
  function openPrinterForm(p) {
    const isNew = !p;
    const type = p ? p.type : 'roll';
    const v = (path, d = '') => { try { return path.split('.').reduce((o, k) => o[k], p) ?? d; } catch { return d; } };
    const f = $('pk-form');
    f.innerHTML = '';
    f.dataset.id = p ? p.id : '';
    f.dataset.scope = p ? p.scope : (S.owner ? 'office' : 'personal');
    $('pk-modal-title').textContent = isNew ? 'Новый принтер' : `Принтер: ${p.name}`;
    const field = (label, name, value, attrs = {}) => h('label', {}, label, h('input', { name, value: value ?? '', ...attrs }));
    f.append(
      field('Название', 'name', v('name'), { class: 'pk-full', maxlength: 120 }),
      h('label', {}, 'Тип', h('select', { name: 'type', onchange: (e) => { openPrinterForm({ ...(p || { name: f.name.value }), type: e.target.value, id: p ? p.id : undefined, scope: f.dataset.scope }); } }, h('option', { value: 'sheet', selected: type === 'sheet' ? true : null }, 'листовой'), h('option', { value: 'roll', selected: type === 'roll' ? true : null }, 'рулонный (плоттер)'))),
      h('label', {}, 'Где', h('select', { name: 'scope', disabled: !isNew ? true : null }, h('option', { value: 'personal', selected: f.dataset.scope === 'personal' ? true : null }, 'личный парк'), S.owner ? h('option', { value: 'office', selected: f.dataset.scope === 'office' ? true : null }, 'парк офиса') : null)),
      h('label', { class: 'pk-check' }, h('input', { type: 'checkbox', name: 'enabled', checked: !p || p.enabled !== false ? true : null }), 'участвует в расчёте'),
    );
    if (type === 'sheet') {
      f.append(h('fieldset', {}, h('legend', {}, 'Листовой'),
        h('label', {}, 'Максимальный лист', h('select', { name: 'maxSheet' }, ['А4', 'А3', 'SRA3'].map((s) => h('option', { value: s, selected: v('sheet.maxSheet') === s ? true : null }, s)))),
        field('А4 ч/б, стр/мин', 'ppmA4mono', v('sheet.ppmA4.mono'), { type: 'number', min: 0, step: 0.1 }),
        field('А4 цвет, стр/мин', 'ppmA4color', v('sheet.ppmA4.color'), { type: 'number', min: 0, step: 0.1 }),
        field('А3 ч/б, стр/мин', 'ppmA3mono', v('sheet.ppmA3.mono'), { type: 'number', min: 0, step: 0.1 }),
        field('А3 цвет, стр/мин', 'ppmA3color', v('sheet.ppmA3.color'), { type: 'number', min: 0, step: 0.1 }),
        field('Дуплекс А4, изобр/мин', 'ipmDuplexA4', v('sheet.ipmDuplexA4'), { type: 'number', min: 0, step: 0.1 }),
        h('label', { class: 'pk-check' }, h('input', { type: 'checkbox', name: 'duplex', checked: v('sheet.duplex') ? true : null }), 'дуплекс'),
        h('label', { class: 'pk-check' }, h('input', { type: 'checkbox', name: 'color', checked: v('sheet.color') ? true : null }), 'цветной')));
    } else {
      const modes = v('roll.modes', {}) || {};
      const secOf = (m) => (modes[m] ? (modes[m].secPerA1 || (modes[m].a1PerHour ? Math.round(36000 / modes[m].a1PerHour) / 10 : '')) : '');
      f.append(h('fieldset', {}, h('legend', {}, 'Рулонный'),
        field('Наибольшая ширина, мм', 'maxWidthMm', v('roll.maxWidthMm'), { type: 'number', min: 200, max: 2000 }),
        h('label', {}, 'Держателей рулона', h('select', { name: 'holders' }, [1, 2].map((n) => h('option', { value: n, selected: Number(v('roll.holders', 1)) === n ? true : null }, n)))),
        field('Заряжено сейчас, мм (через запятую)', 'loaded', (v('roll.loaded', []) || []).join(', '), { placeholder: '841, 594' }),
        field('На полке, мм (через запятую)', 'stock', (v('roll.stock', []) || []).join(', '), { placeholder: '297, 420, 594, 841, 914' }),
        field('Черновой: с на А1', 'draftSec', secOf('draft'), { type: 'number', min: 0, step: 0.1, placeholder: 'из паспорта' }),
        field('Обычный: с на А1', 'normalSec', secOf('normal'), { type: 'number', min: 0, step: 0.1, placeholder: 'пусто — нет в паспорте' }),
        field('Наилучший: с на А1', 'bestSec', secOf('best'), { type: 'number', min: 0, step: 0.1, placeholder: 'пусто — нет в паспорте' }),
        h('label', {}, 'Режим по умолчанию', h('select', { name: 'defaultMode' }, ['draft', 'normal', 'best'].map((m) => h('option', { value: m, selected: v('roll.defaultMode') === m ? true : null }, S.modeTitles[m] || m))))));
    }
    f.append(h('fieldset', {}, h('legend', {}, 'Накладные (оценки, правит оператор)'),
      field('Прогрев, с', 'warmupSec', v('overhead.warmupSec', 0), { type: 'number', min: 0 }),
      field('До первой страницы, с', 'firstPageSec', v('overhead.firstPageSec', 0), { type: 'number', min: 0, step: 0.1 }),
      field('RIP, с на МБ PDF', 'ripSecPerMb', v('overhead.ripSecPerMb', 0), { type: 'number', min: 0, step: 0.1 }),
      field('RIP, с на лист', 'ripSecPerSheet', v('overhead.ripSecPerSheet', 0), { type: 'number', min: 0, step: 0.1 }),
      type === 'roll' ? field('Отрез, с на лист', 'cutSec', v('overhead.cutSec', 0), { type: 'number', min: 0, step: 0.1 }) : null,
      type === 'roll' ? field('Смена рулона, с', 'rollChangeSec', v('overhead.rollChangeSec', 0), { type: 'number', min: 0 }) : null,
      field('Вилка, ±%', 'uncertaintyPct', v('uncertaintyPct', 25), { type: 'number', min: 0, max: 90 }),
      field('Коэффициент', 'factor', v('factor', 1), { type: 'number', min: 0.2, max: 5, step: 0.01 })));
    f.append(field('Источник цифр (ссылка)', 'sourceUrl', v('source.url'), { class: 'pk-full', placeholder: 'https://… паспорт производителя' }),
      h('label', { class: 'pk-full' }, 'Строка паспорта', h('textarea', { name: 'sourceNote', rows: 2 }, v('source.note'))));
    $('pk-form-note').textContent = '';
    $('pk-modal').hidden = false;
  }

  async function savePrinterForm() {
    const f = $('pk-form');
    const g = (n) => (f.elements[n] ? f.elements[n].value : '');
    const num = (n) => (g(n) === '' ? null : Number(g(n)));
    const list = (n) => g(n).split(/[,;\s]+/).map(Number).filter((x) => Number.isFinite(x) && x > 0);
    const type = g('type');
    const body = {
      name: g('name'), type, enabled: f.elements.enabled.checked, scope: g('scope'),
      overhead: { warmupSec: num('warmupSec') ?? 0, firstPageSec: num('firstPageSec') ?? 0, ripSecPerMb: num('ripSecPerMb') ?? 0, ripSecPerSheet: num('ripSecPerSheet') ?? 0, cutSec: num('cutSec') ?? 0, rollChangeSec: num('rollChangeSec') ?? 0 },
      uncertaintyPct: num('uncertaintyPct') ?? 25, factor: num('factor') ?? 1,
      source: { url: g('sourceUrl'), note: g('sourceNote') },
    };
    if (type === 'sheet') {
      body.sheet = { maxSheet: g('maxSheet'), duplex: f.elements.duplex.checked, color: f.elements.color.checked,
        ppmA4: { mono: num('ppmA4mono'), color: num('ppmA4color') }, ppmA3: { mono: num('ppmA3mono'), color: num('ppmA3color') }, ipmDuplexA4: num('ipmDuplexA4') };
    } else {
      const mode = (n) => (num(n) ? { secPerA1: num(n) } : null);
      body.roll = { holders: Number(g('holders')), maxWidthMm: num('maxWidthMm'), loaded: list('loaded'), stock: list('stock'),
        modes: { draft: mode('draftSec'), normal: mode('normalSec'), best: mode('bestSec') }, defaultMode: g('defaultMode') };
    }
    try {
      if (f.dataset.id) await json('PUT', `/api/print/printers/${encodeURIComponent(f.dataset.id)}`, body);
      else await json('POST', '/api/print/printers', body);
      $('pk-modal').hidden = true;
      await loadPrinters();
    } catch (err) { $('pk-form-note').textContent = err.message; }
  }

  /* ---------------- нормоконтроль тома (Б3) ---------------- */

  async function runTomeCheck() {
    $('tc-note').textContent = 'читаю текстовый слой пакетов…';
    $('tc-run').disabled = true;
    try {
      const data = await json('POST', `/api/print/jobs/${S.job.id}/tome-check`);
      S.job.tomeCheck = data;
      renderTomeCheck(data);
      $('tc-note').textContent = '';
    } catch (err) { $('tc-note').textContent = ''; showError(err.message); } finally { $('tc-run').disabled = false; }
  }

  const SEV = { critical: 'критично', major: 'существенно', minor: 'незначительно', remark: 'замечание' };

  function renderTomeCheck(r) {
    const box = $('tc-result');
    box.innerHTML = '';
    S.tomeCheck = r;
    const s = r.summary || {};
    box.append(h('p', { class: 'h2-note' }, `Томов: ${s.tomes}, замечаний: ${s.findings} (${Object.entries(s.bySeverity || {}).map(([k, v]) => `${SEV[k] || k}: ${v}`).join(', ') || 'нет'}); по проверкам: ${Object.entries(s.byCheck || {}).map(([k, v]) => `${k}: ${v}`).join(', ') || '—'}. Листов с текстовым слоем ${r.textPages}, без него ${r.textMissing}.`));
    if (r.notes && r.notes.length) box.append(h('ul', { class: 'mod-unverified' }, r.notes.map((n) => h('li', {}, n))));
    for (const t of r.tomes) {
      box.append(h('h3', {}, `${t.tome.title} · ${t.sheets} л. · слоёв по модели ${t.layersMax} (по площади ${t.a4ByArea} А4)${t.claimed.length ? ` · «Листов»: ${t.claimed.map((c) => `${c.claimed}${c.claimed === c.actual ? ' ✓' : ` ≠ ${c.actual}`}`).join(', ')}` : ''}`));
      if (!t.findings.length) { box.append(h('p', { class: 'hint' }, 'замечаний нет')); continue; }
      for (const f of t.findings) {
        box.append(h('div', { class: 'tc-finding', 'data-sev': f.severity },
          h('div', { class: 'tc-meta' }, `${f.rule_id} · ${SEV[f.severity] || f.severity}${f.verification === 'needs_human' ? ' · требует проверки человеком' : ''}${f.location.page ? ` · лист ${f.location.page}` : ''} · ${f.ntd}${f.ntd_clause ? `, ${f.ntd_clause}` : ''}`),
          h('div', {}, f.wording),
          f.fix_hint ? h('div', { class: 'tc-fix' }, f.fix_hint) : null));
      }
    }
    $('tc-export').hidden = !r.findings.length;
  }

  function exportTomeCheck() {
    if (!S.tomeCheck) return;
    const payload = { app: 'Enso-nexus · Разбор PDF по форматам · нормоконтроль тома', at: S.tomeCheck.at, job: S.job.id, findings: S.tomeCheck.findings };
    const a = document.createElement('a');
    a.href = `data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(payload, null, 2))}`;
    a.download = 'замечания_нормоконтроль_тома.json';
    document.body.append(a); a.click(); a.remove();
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
      S.bindings = park.bindings || [];
      S.bindingDefaults = park.bindingDefaults;
      S.owner = !!park.owner;
      S.poppler = !!(park.tools && park.tools.pdfinfo);
      S.qpdf = !!(park.tools && park.tools.qpdf);
      S.pdftotext = !!(park.tools && park.tools.pdftotext);
      const rolls = park.park.rolls.map((r) => r.width).join(' / ');
      const plus = park.park.plusRolls.map((r) => r.width).join(' / ');
      $('pr-park-note').textContent = `Парк носителей: листы ${park.park.sheets.map((s) => s.bucket).join(' и ')}, рулоны ${rolls} мм${plus ? `; по флагу — ${plus} мм` : ''}. Формат — по ГОСТ 2.301-68 с допуском; носитель — по короткой стороне листа.`;
      if (!S.poppler) showError('На сервере нет poppler (pdfinfo) — разбор невозможен, сообщите владельцу платформы');
      else if (!S.qpdf) showError('На сервере нет qpdf — будет только анализ, пакеты на печать не соберутся');
      if (!S.pdftotext) $('tc-note').textContent = 'на сервере нет pdftotext — проверки «Листов» и «Формат» недоступны';
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
    for (const id of ['pr-tol', 'pr-box', 'pr-scan', 'pr-mult', 'pr-plus', 'pr-plus-rolls', 'pr-grouping', 'pr-max-mb', 'pr-max-pages']) $(id).addEventListener('change', saveSettings);
    $('pr-run').addEventListener('click', onRun);
    $('pr-sheets').addEventListener('click', toggleSheets);
    $('pr-sheets-table').querySelector('thead').addEventListener('click', onSortClick);
    $('bd-run').addEventListener('click', runBinding);
    $('bd-fold').addEventListener('change', () => { $('bd-custom-wrap').hidden = $('bd-fold').value !== 'custom'; });
    $('bd-fold-show').addEventListener('click', toggleFold);
    $('sc-run').addEventListener('click', runSchedule);
    $('pk-toggle').addEventListener('click', async () => {
      const w = $('pk-wrap');
      if (w.hidden) { try { await loadPrinters(); } catch (err) { showError(err.message); return; } }
      w.hidden = !w.hidden;
    });
    $('pk-add-preset').addEventListener('click', addFromPreset);
    $('pk-add-blank').addEventListener('click', () => openPrinterForm(null));
    $('pk-save').addEventListener('click', savePrinterForm);
    $('pk-cancel').addEventListener('click', () => { $('pk-modal').hidden = true; });
    $('pk-modal').addEventListener('click', (e) => { if (e.target === $('pk-modal')) $('pk-modal').hidden = true; });
    $('tc-run').addEventListener('click', runTomeCheck);
    $('tc-export').addEventListener('click', exportTomeCheck);
    document.addEventListener('visibilitychange', () => { if (!document.hidden && S.job && S.job.status === 'done') ensureTicket().catch(() => {}); });
    window.addEventListener('beforeunload', (e) => {
      if (S.uploading) { e.preventDefault(); e.returnValue = ''; }
    });
  }

  document.addEventListener('DOMContentLoaded', init);
}());
