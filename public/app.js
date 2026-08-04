'use strict';
/* ENSO Nexus Pilot 1 — client. Talks only to the same-origin backend API. */

const $ = (id) => document.getElementById(id);
const state = {
  session: null,          // {id, token}
  view: null,             // last session view from server
  polling: null,
  limits: null,
  uploading: false,
};

const LS_KEY = 'enso-pilot1-session';

/* ---------------- API ---------------- */
async function api(path, options = {}) {
  const headers = Object.assign({}, options.headers);
  if (state.session) headers.Authorization = `Bearer ${state.session.token}`;
  if (options.json !== undefined) {
    headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(options.json);
  }
  const res = await fetch(`/api${path}`, { ...options, headers });
  let data = null;
  try { data = await res.json(); } catch { /* downloads etc. */ }
  if (!res.ok) {
    const message = (data && data.error) || `Ошибка сервера (${res.status})`;
    const err = new Error(message);
    err.status = res.status;
    throw err;
  }
  return data;
}

/* ---------------- session lifecycle ---------------- */
async function newSession() {
  const created = await api('/sessions', { method: 'POST' });
  state.session = { id: created.id, token: created.token };
  localStorage.setItem(LS_KEY, JSON.stringify(state.session));
  await refresh();
  toast('Создана новая сессия');
}

async function restoreOrCreate() {
  const saved = localStorage.getItem(LS_KEY);
  if (saved) {
    try {
      state.session = JSON.parse(saved);
      await refresh();
      return;
    } catch (err) {
      if (err.status !== 404) console.warn(err);
      state.session = null;
      localStorage.removeItem(LS_KEY);
    }
  }
  await newSession();
}

async function deleteSession() {
  if (!state.session) return;
  if (!confirm('Удалить сессию вместе со всеми загруженными файлами и результатами?')) return;
  try { await api(`/sessions/${state.session.id}`, { method: 'DELETE' }); } catch (err) { console.warn(err); }
  localStorage.removeItem(LS_KEY);
  state.session = null;
  state.view = null;
  await newSession();
  toast('Сессия удалена, создана новая');
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
  completed: 'Задача завершена',
  failed: 'Произошла ошибка',
};
const KIND_LABELS = { comment: 'комментарий', answer: 'ответ на вопрос', error: 'ошибка' };
const Q_LABELS = { pending: 'ожидает ответа', answered: 'отвечен', needs_followup: 'требует уточнения', closed: 'закрыт' };

function fmtSize(bytes) {
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} МБ`;
  return `${Math.max(1, Math.round(bytes / 1024))} КБ`;
}

function render() {
  const v = state.view;
  const has = !!v;
  $('btn-delete-session').disabled = !has;
  $('btn-process').disabled = !has || !v.files.length || ['queued', 'running'].includes(v.jobStatus);
  $('chat-input').disabled = !has || ['queued', 'running'].includes(v.jobStatus);
  $('btn-send').disabled = $('chat-input').disabled;
  if (!has) return;

  // files
  $('file-list').innerHTML = v.files.map((f) => `
    <li class="file-item">
      <span class="file-ext">${esc(f.ext)}</span>
      <span class="name">${esc(f.name)}<br><span class="meta">${fmtSize(f.size)} · загружен</span></span>
      <button class="icon-btn" data-del-file="${f.id}" aria-label="Удалить файл ${esc(f.name)}" title="Удалить">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 7h16M10 11v6m4-6v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>
      </button>
    </li>`).join('');

  if (!document.activeElement || document.activeElement.id !== 'comment') {
    $('comment').value = v.comment || '';
  }

  // настройки анализа
  const busy = ['queued', 'running'].includes(v.jobStatus);
  $('sel-model').disabled = busy;
  $('sel-kb').disabled = busy || !$('sel-kb').options.length;
  updateCompareButton();
  if (v.settings && document.activeElement !== $('sel-model')) {
    $('sel-model').value = v.settings.aiProvider ? `${v.settings.aiProvider}|${v.settings.aiModel || ''}` : '';
    if ($('sel-model').selectedIndex === -1) $('sel-model').value = '';
  }
  if (v.settings && document.activeElement !== $('sel-kb')) {
    $('sel-kb').value = v.settings.kbChoice || 'main';
  }

  // status + events
  $('job-status').dataset.status = v.jobStatus;
  $('job-status').textContent = STATUS_LABELS[v.jobStatus] || v.jobStatus;
  $('events-log').innerHTML = v.events.map((e) => `
    <li class="ev-${e.level}">${esc(e.stage)}${e.detail ? ` — ${esc(e.detail)}` : ''}
      <span class="meta">(${new Date(e.created_at).toLocaleTimeString('ru-RU')})</span></li>`).join('');
  if (['queued', 'running'].includes(v.jobStatus)) $('events-details').open = true;

  // chat
  const chatEl = $('chat');
  const nearBottom = chatEl.scrollHeight - chatEl.scrollTop - chatEl.clientHeight < 80;
  const msgs = v.messages.filter((m) => m.kind !== 'comment');
  chatEl.innerHTML = msgs.length ? msgs.map((m) => {
    const cls = m.kind === 'error' ? 'msg-error' : m.role === 'user' ? 'msg-user' : 'msg-assistant';
    const kind = KIND_LABELS[m.kind] ? `<span class="msg-kind">${KIND_LABELS[m.kind]}</span>` : '';
    return `<div class="msg ${cls}">${kind}${md(m.content)}</div>`;
  }).join('') : '<p class="msg-empty">Загрузите исходные данные (ГПЗУ, ТЗ, топосъёмку) и запустите обработку — помощник проанализирует материалы и при необходимости задаст уточняющие вопросы.</p>';
  if (nearBottom) chatEl.scrollTop = chatEl.scrollHeight;

  // questions
  const pending = v.questions.filter((q) => q.status === 'pending');
  const others = v.questions.filter((q) => q.status !== 'pending');
  $('questions-block').hidden = v.questions.length === 0;
  $('questions-list').innerHTML = [
    ...pending.map((q) => `
      <div class="question">
        <span class="q-status" data-s="pending">${Q_LABELS.pending}</span>
        <p class="q-text">${esc(q.text)}</p>
        ${q.why ? `<p class="q-why">${esc(q.why)}</p>` : ''}
        <div class="q-row">
          <input type="text" id="qa-${q.id}" maxlength="4000" placeholder="Ваш ответ…" aria-label="Ответ на вопрос">
          <button class="btn btn-primary btn-sm" data-answer="${q.id}" type="button">Ответить</button>
        </div>
      </div>`),
    ...others.map((q) => `
      <div class="question">
        <span class="q-status" data-s="${esc(q.status)}">${Q_LABELS[q.status] || esc(q.status)}</span>
        <p class="q-text">${esc(q.text)}</p>
        ${q.answer ? `<p class="q-answered">Ответ: ${esc(q.answer)}</p>` : ''}
      </div>`),
  ].join('');

  // results
  $('results-empty').hidden = v.results.length > 0;
  $('results-list').innerHTML = v.results.map((r) => `
    <li class="result-item">
      <span class="file-ext">${esc(r.format)}</span>
      <span class="name">${esc(r.filename)}<br><span class="meta">${esc(r.title)} · ${fmtSize(r.size)}</span></span>
      <button class="icon-btn dl" data-download="${r.id}" data-name="${esc(r.filename)}"
              aria-label="Скачать ${esc(r.filename)}" title="Скачать">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 4v12m0 0l-5-5m5 5l5-5M4 20h16"/></svg>
      </button>
    </li>`).join('');

  // facts
  $('facts-card').hidden = v.facts.length === 0;
  $('facts-list').innerHTML = v.facts.map((f) =>
    `<div><dt>${esc(f.key)}</dt><dd>${esc(f.value)}${f.source ? ` <span class="meta">(${esc(f.source)})</span>` : ''}</dd></div>`).join('');
}

/* ---------------- настройки анализа (нейросеть + база) ---------------- */
function renderSettingsOptions(health) {
  const sel = $('sel-model');
  sel.innerHTML = '<option value="">По умолчанию (как настроен сервер)</option>';
  for (const p of health.providers || []) {
    const group = document.createElement('optgroup');
    group.label = p.label + (p.available ? '' : ` — ${p.note}`);
    const models = p.models.length ? p.models : ['(модели не найдены)'];
    for (const m of models) {
      const opt = document.createElement('option');
      opt.value = `${p.id}|${p.models.length ? m : ''}`;
      opt.textContent = m;
      opt.disabled = !p.available;
      group.appendChild(opt);
    }
    sel.appendChild(group);
  }
  const kbSel = $('sel-kb');
  kbSel.innerHTML = '';
  for (const b of health.kbBases || []) {
    const opt = document.createElement('option');
    const count = (health.kb.bases || []).find((x) => x.id === b.id)?.chunks;
    opt.value = b.id;
    opt.textContent = `${b.label}${count !== undefined ? ` (${count} фрагм.)` : ''}`;
    kbSel.appendChild(opt);
  }

  // чекбоксы доступных моделей для сравнения
  const list = $('compare-list');
  list.innerHTML = '';
  for (const p of health.providers || []) {
    if (!p.available) continue;
    for (const m of p.models) {
      const label = document.createElement('label');
      label.innerHTML = `<input type="checkbox" data-provider="${esc(p.id)}" data-model="${esc(m)}">` +
        `<span>${esc(m)}</span><span class="cl-provider">${esc(p.label)}</span>`;
      list.appendChild(label);
    }
  }
  list.addEventListener('change', updateCompareButton);
  updateCompareButton();
}

function selectedCompareModels() {
  return [...document.querySelectorAll('#compare-list input:checked')]
    .map((cb) => ({ provider: cb.dataset.provider, model: cb.dataset.model }));
}

function updateCompareButton() {
  const n = selectedCompareModels().length;
  const busy = state.view && ['queued', 'running'].includes(state.view.jobStatus);
  $('btn-compare').disabled = busy || n < 2 || n > 4 || !state.view || !state.view.files.length;
  $('btn-compare').textContent = n >= 2 ? `Запустить сравнение (${n})` : 'Запустить сравнение (выберите 2–4)';
}

async function saveSettings(patch) {
  try {
    await api(`/sessions/${state.session.id}/settings`, { method: 'POST', json: patch });
    toast('Настройки сохранены');
  } catch (err) {
    toast(err.message, 'error');
  }
  await refresh().catch(() => {});
}

/* ---------------- data flow ---------------- */
async function refresh() {
  if (!state.session) return;
  state.view = await api(`/sessions/${state.session.id}`);
  render();
  managePolling();
}

function managePolling() {
  const active = state.view && ['queued', 'running'].includes(state.view.jobStatus);
  if (active && !state.polling) {
    state.polling = setInterval(async () => {
      try { await refresh(); } catch (err) { console.warn(err); }
    }, 1800);
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
    headers: { Authorization: `Bearer ${state.session.token}` },
  });
  if (!res.ok) { toast('Не удалось скачать файл', 'error'); return; }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
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
async function init() {
  try {
    const health = await api('/health');
    state.limits = health.limits;
    $('ai-badge').textContent = health.aiMode === 'live' ? `AI: ${health.model}`
      : health.aiMode === 'local' ? `Локальная модель: ${health.model}` : 'ДЕМО-РЕЖИМ';
    $('ai-badge').dataset.mode = health.aiMode;
    $('mock-banner').hidden = health.aiMode !== 'mock';
    $('ttl-hours').textContent = health.limits.sessionTtlHours;
    $('limits-line').textContent =
      `Форматы: ${health.limits.allowedExtensions.join(', ')} · до ${health.limits.maxFileSizeMb} МБ/файл · ` +
      `до ${health.limits.maxFiles} файлов · всего до ${health.limits.maxTotalUploadMb} МБ`;
    renderSettingsOptions(health);
  } catch (err) {
    toast('Сервер недоступен: ' + err.message, 'error');
    return;
  }
  await restoreOrCreate().catch((err) => toast(err.message, 'error'));

  $('btn-new-session').addEventListener('click', () => {
    localStorage.removeItem(LS_KEY);
    state.session = null;
    newSession().catch((err) => toast(err.message, 'error'));
  });
  $('btn-delete-session').addEventListener('click', () => deleteSession().catch((err) => toast(err.message, 'error')));

  const dz = $('dropzone');
  const fi = $('file-input');
  dz.addEventListener('click', () => fi.click());
  dz.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fi.click(); } });
  fi.addEventListener('change', () => { uploadFiles(fi.files); fi.value = ''; });
  ['dragover', 'dragenter'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('dragover'); }));
  ['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('dragover'); }));
  dz.addEventListener('drop', (e) => uploadFiles(e.dataTransfer.files));

  $('sel-model').addEventListener('change', () => {
    const [aiProvider, aiModel] = ($('sel-model').value || '|').split('|');
    saveSettings({ aiProvider, aiModel });
  });
  $('sel-kb').addEventListener('change', () => saveSettings({ kbChoice: $('sel-kb').value }));

  $('btn-compare').addEventListener('click', async () => {
    const models = selectedCompareModels();
    try {
      await api(`/sessions/${state.session.id}/compare`, { method: 'POST', json: { models } });
      toast(`Сравнение ${models.length} моделей запущено — это займёт несколько минут`);
      $('compare-details').open = false;
      await refresh();
    } catch (err) { toast(err.message, 'error'); }
  });

  $('btn-save-comment').addEventListener('click', async () => {
    try {
      await api(`/sessions/${state.session.id}/comment`, { method: 'POST', json: { comment: $('comment').value } });
      toast('Комментарий сохранён');
      await refresh();
    } catch (err) { toast(err.message, 'error'); }
  });

  $('btn-process').addEventListener('click', async () => {
    try {
      await api(`/sessions/${state.session.id}/process`, { method: 'POST', json: {} });
      toast('Обработка запущена');
      await refresh();
    } catch (err) { toast(err.message, 'error'); }
  });

  $('chat-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = $('chat-input').value.trim();
    if (!text) return;
    try {
      await api(`/sessions/${state.session.id}/messages`, { method: 'POST', json: { text } });
      $('chat-input').value = '';
      await refresh();
    } catch (err) { toast(err.message, 'error'); }
  });

  document.body.addEventListener('click', async (e) => {
    const delBtn = e.target.closest('[data-del-file]');
    if (delBtn) {
      try {
        await api(`/sessions/${state.session.id}/files/${delBtn.dataset.delFile}`, { method: 'DELETE' });
        await refresh();
      } catch (err) { toast(err.message, 'error'); }
      return;
    }
    const ansBtn = e.target.closest('[data-answer]');
    if (ansBtn) {
      const qid = ansBtn.dataset.answer;
      const input = $(`qa-${qid}`);
      const answer = input.value.trim();
      if (!answer) { toast('Введите ответ', 'error'); return; }
      ansBtn.disabled = true;
      try {
        const res = await api(`/sessions/${state.session.id}/questions/${qid}/answer`, { method: 'POST', json: { answer } });
        toast(res.continued ? 'Ответ принят, обработка продолжена' : `Ответ принят. Осталось вопросов: ${res.pending}`);
        await refresh();
      } catch (err) {
        toast(err.message, 'error');
        ansBtn.disabled = false;
      }
      return;
    }
    const dlBtn = e.target.closest('[data-download]');
    if (dlBtn) download(dlBtn.dataset.download, dlBtn.dataset.name);
  });
}

init();
