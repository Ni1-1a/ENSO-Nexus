'use strict';
/* ENSO Nexus Pilot 1 — client. Talks only to the same-origin backend API. */

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
};

const LS_KEY = 'enso-pilot1-session';
const THEME_KEY = 'enso-pilot1-theme';

/* ---------------- тема оформления ---------------- */
function applyTheme(mode) {
  if (mode === 'light' || mode === 'dark') document.documentElement.dataset.theme = mode;
  else delete document.documentElement.dataset.theme;
  const seg = $('theme-seg');
  if (seg) {
    for (const b of seg.querySelectorAll('button[data-theme]')) {
      b.setAttribute('aria-checked', String(b.dataset.theme === mode));
    }
  }
}
applyTheme(localStorage.getItem(THEME_KEY) || 'auto');

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
  $('btn-delete-session-side').disabled = !has;
  $('btn-process').disabled = !has || !v.files.length || ['queued', 'running'].includes(v.jobStatus);
  $('chat-input').disabled = !has || ['queued', 'running'].includes(v.jobStatus);
  $('btn-send').disabled = $('chat-input').disabled;
  updateAiBadge();
  renderProgress();
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
    setModelSelect(v.settings.aiProvider ? `${v.settings.aiProvider}|${v.settings.aiModel || ''}` : '');
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

/* ---------------- бейдж действующей нейросети ---------------- */
const PROVIDER_LABELS = { claude: 'Claude', chatgpt: 'ChatGPT', lmstudio: 'Локальная модель', ollama: 'Ollama', demo: 'ДЕМО-РЕЖИМ' };

function updateAiBadge() {
  const ai = state.view && state.view.ai;
  let text, mode;
  if (ai && ai.provider) {
    text = ai.provider === 'demo' ? 'ДЕМО-РЕЖИМ'
      : `${PROVIDER_LABELS[ai.provider] || ai.provider}: ${ai.model || '…'}`;
    mode = ai.provider === 'demo' ? 'mock'
      : (ai.provider === 'claude' || ai.provider === 'chatgpt') ? 'live' : 'local';
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
    if (progressTimer) { clearInterval(progressTimer); progressTimer = null; }
    return;
  }
  const p = v.jobProgress || null;
  if (card.hidden) $('btn-cancel-job').disabled = false; // новая задача — кнопка снова активна
  card.hidden = false;
  $('progress-title').textContent = v.jobStatus === 'queued' ? 'Задача в очереди' : 'Выполняется анализ';
  $('progress-model').textContent = p && p.model
    ? `${PROVIDER_LABELS[p.provider] || p.provider || 'Модель'} · ${p.model}` : '';
  $('progress-label').textContent = (p && p.label) || 'Ожидание начала обработки…';

  const bar = $('progress-bar');
  const phase = p && p.phase;
  if (phase && PHASE_PERCENT[phase] !== undefined) {
    let pct = PHASE_PERCENT[phase];
    // на генерации полоса растёт с числом токенов, асимптотически к 90%
    if (phase === 'generating') pct = 50 + Math.round(40 * (1 - Math.exp(-(p.tokensOut || 0) / 3000)));
    bar.classList.remove('indeterminate');
    bar.style.width = `${pct}%`;
  } else {
    bar.classList.add('indeterminate');
    bar.style.width = '';
  }

  const tok = $('progress-tokens');
  if (p && p.tokensOut > 0) {
    tok.hidden = false;
    tok.textContent = `Сгенерировано токенов: ~${p.tokensOut.toLocaleString('ru-RU')}`;
  } else tok.hidden = true;

  const stepIdx = PROGRESS_STEPS.findIndex((s) => s.phase === phase);
  $('progress-steps').innerHTML = PROGRESS_STEPS.map((s, i) => {
    const cls = stepIdx < 0 ? '' : i < stepIdx ? 'done' : i === stepIdx ? 'current' : '';
    const ico = cls === 'done' ? CHECK_SVG : cls === 'current' ? '<span class="step-spinner"></span>' : '';
    return `<li class="${cls}"><span class="step-ico">${ico}</span>${s.label}</li>`;
  }).join('');

  // поправка часов — только при реальном обновлении прогресса, иначе таймер замирает
  if (p && p.updatedAt && p.updatedAt !== state.lastProgressUpdatedAt) {
    state.progressClockOffset = Date.now() - p.updatedAt;
    state.lastProgressUpdatedAt = p.updatedAt;
  }
  if (!progressTimer) progressTimer = setInterval(updateElapsed, 500);
  updateElapsed();
}

function updateElapsed() {
  const p = state.view && state.view.jobProgress;
  if (!p || !p.startedAt) { $('progress-elapsed').textContent = ''; return; }
  const s = Math.max(0, Math.floor((Date.now() - state.progressClockOffset - p.startedAt) / 1000));
  $('progress-elapsed').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/* ---------------- настройки анализа (нейросеть + база) ---------------- */
/** Ставит значение select модели; недоступную сохранённую модель показывает честно, не сбрасывая. */
function setModelSelect(value) {
  const sel = $('sel-model');
  const stale = sel.querySelector('option[data-missing]');
  if (stale) stale.remove();
  sel.value = value;
  if (sel.selectedIndex === -1 && value) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = `${value.split('|')[1] || value} (недоступна сейчас)`;
    opt.dataset.missing = '1';
    sel.appendChild(opt);
    sel.value = value;
  }
  updateModelNote();
}

/** Подсказка под select: параметры выбранной локальной модели или предупреждение. */
function updateModelNote() {
  const note = $('model-note');
  const sel = $('sel-model');
  const opt = sel.selectedOptions[0];
  if (opt && opt.dataset.missing) {
    note.hidden = false;
    note.textContent = 'Сохранённая модель сейчас недоступна — проверьте, запущен ли её сервер (LM Studio/Ollama). Запросы будут завершаться ошибкой, пока модель не появится.';
    return;
  }
  const b = state.health && state.health.localBundle;
  if (!sel.value && state.health && state.health.aiMode === 'local' && b) {
    note.hidden = false;
    note.textContent = `Текст и анализ: ${b.text} · Графика и сканы: ${b.vision} · документы изучаются последовательно перед анализом`;
    return;
  }
  const [provider, model] = (sel.value || '|').split('|');
  const info = provider === 'lmstudio' && state.health
    ? (state.health.providers || []).find((p) => p.id === 'lmstudio')?.modelsInfo?.find((m) => m.id === model)
    : null;
  if (info) {
    const parts = [`контекст ${(info.context || 0).toLocaleString('ru-RU')} токенов`];
    if (info.sizeGb) parts.push(`${info.sizeGb} ГБ`);
    parts.push(info.loaded ? 'сейчас загружена в память' : 'загрузится при первом запросе (1–2 мин)');
    if (info.note) parts.push(info.note);
    note.hidden = false;
    note.textContent = parts.join(' · ');
  } else {
    note.hidden = true;
    note.textContent = '';
  }
}

const PROVIDER_SHORT = { claude: 'Anthropic', chatgpt: 'OpenAI', lmstudio: 'LM Studio', ollama: 'Ollama' };

function renderSettingsOptions(health) {
  const sel = $('sel-model');
  const kbSelPrev = $('sel-kb').value;
  const modelPrev = sel.value;
  const comparePrev = new Set(selectedCompareModels().map((m) => `${m.provider}|${m.model}`));
  const providers = health.providers || [];

  sel.innerHTML = '';
  const defOpt = document.createElement('option');
  defOpt.value = '';
  defOpt.textContent = health.aiMode === 'local' && health.localBundle
    ? 'Локальная связка: текст + графика (рекомендуется)'
    : 'По умолчанию (как настроен сервер)';
  sel.appendChild(defOpt);

  const GROUPS = [
    { label: 'Облачные модели', ids: ['claude', 'chatgpt'] },
    { label: 'Локальные модели', ids: ['lmstudio', 'ollama'] },
    { label: 'Прочее', ids: ['demo'] },
  ];
  for (const g of GROUPS) {
    const members = providers.filter((p) => g.ids.includes(p.id));
    if (!members.length) continue;
    const group = document.createElement('optgroup');
    group.label = g.label;
    for (const p of members) {
      const models = p.models.length ? p.models : ['(модели не найдены)'];
      for (const m of models) {
        const opt = document.createElement('option');
        opt.value = `${p.id}|${p.models.length ? m : ''}`;
        const suffix = p.available ? (PROVIDER_SHORT[p.id] || p.label) : p.note;
        opt.textContent = p.id === 'demo' ? p.label : `${m} — ${suffix}`;
        opt.disabled = !p.available;
        group.appendChild(opt);
      }
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
      label.querySelector('input').checked = comparePrev.has(`${p.id}|${m}`);
      list.appendChild(label);
    }
  }

  // после перестройки innerHTML браузер сбрасывает значения — восстанавливаем сами,
  // не полагаясь на render() (он пропускает восстановление, пока select в фокусе)
  const s = state.view && state.view.settings;
  setModelSelect(s ? (s.aiProvider ? `${s.aiProvider}|${s.aiModel || ''}` : '') : modelPrev);
  $('sel-kb').value = s ? (s.kbChoice || 'main') : kbSelPrev;

  updateCompareButton();
  updateModelNote();
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

function managePolling() {
  const active = state.view && ['queued', 'running'].includes(state.view.jobStatus);
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
    headers: { Authorization: `Bearer ${state.session.token}` },
  });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    toast((data && data.error) || `Не удалось скачать файл (${res.status})`, 'error');
    return;
  }
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
/** Загружает /health: список провайдеров и моделей, лимиты; обновляет настройки и бейдж. */
async function loadHealth() {
  const health = await api('/health');
  state.health = health;
  state.limits = health.limits;
  $('mock-banner').hidden = health.aiMode !== 'mock';
  $('ttl-hours').textContent = health.limits.sessionTtlHours;
  $('ttl-hours-2').textContent = health.limits.sessionTtlHours;
  $('limits-line').textContent =
    `Форматы: ${health.limits.allowedExtensions.join(', ')} · до ${health.limits.maxFileSizeMb} МБ/файл · ` +
    `до ${health.limits.maxFiles} файлов · всего до ${health.limits.maxTotalUploadMb} МБ`;
  renderSettingsOptions(health);
  if (state.view) render(); // восстановить значения select'ов после перестройки опций
  updateAiBadge();
}

async function init() {
  // чисто клиентские обработчики — работают даже при недоступном сервере
  // навигация по экранам (Анализ / Нормоконтроль / Настройки)
  for (const btn of document.querySelectorAll('.nav-item[data-screen]')) {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.nav-item').forEach((b) => b.classList.toggle('active', b === btn));
      document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('active', s.id === `screen-${btn.dataset.screen}`));
    });
  }

  // переключатель темы
  $('theme-seg').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-theme]');
    if (!btn) return;
    localStorage.setItem(THEME_KEY, btn.dataset.theme);
    applyTheme(btn.dataset.theme);
  });

  $('compare-list').addEventListener('change', updateCompareButton);

  // /health с повторами: без него интерфейс не наполнить
  for (let attempt = 1; ; attempt++) {
    try {
      await loadHealth();
      break;
    } catch (err) {
      toast(`Сервер недоступен: ${err.message} — повтор через ${Math.min(15, 3 * attempt)} с`, 'error');
      await new Promise((r) => setTimeout(r, Math.min(15000, 3000 * attempt)));
    }
  }
  await restoreOrCreate().catch((err) => toast(err.message, 'error'));

  $('btn-new-session').addEventListener('click', startNewSession);
  $('btn-new-session-side').addEventListener('click', startNewSession);
  $('btn-delete-session').addEventListener('click', () => deleteSession().catch((err) => toast(err.message, 'error')));
  $('btn-delete-session-side').addEventListener('click', () => deleteSession().catch((err) => toast(err.message, 'error')));
  $('btn-cancel-job').addEventListener('click', cancelJob);

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
    updateModelNote();
    saveSettings({ aiProvider, aiModel });
  });
  $('sel-kb').addEventListener('change', () => saveSettings({ kbChoice: $('sel-kb').value }));

  $('btn-compare').addEventListener('click', async () => {
    const models = selectedCompareModels();
    try {
      await api(`/sessions/${state.session.id}/compare`, { method: 'POST', json: { models } });
      toast(`Сравнение ${models.length} моделей запущено — это займёт несколько минут`);
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
