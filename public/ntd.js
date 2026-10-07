'use strict';
/**
 * Модуль «Вопрос по нормам» — отдельная страница /ntd.html, один экран:
 * форма вопроса, ответ со ссылками (статус у каждой — от кода) и список
 * вопросов проекта. Открытый ответ — в hash: #/q/:id.
 *
 * Контекст проекта (?project=) читает общий каркас; нейросеть — та, что
 * выбрана у проекта. Ответ готовится на сервере в фоне — страница опрашивает
 * вопрос, пока он не станет done или failed.
 */
(function () {
  const $ = (id) => document.getElementById(id);
  const projectId = () => (window.EnsoShell && window.EnsoShell.projectId) || '';

  const STATUS_LABEL = { queued: 'в очереди', running: 'идёт', done: 'готово', failed: 'ошибка' };
  const CITE_LABEL = { confirmed: 'подтверждено', partial: 'сверить', registry: 'по реестру', unknown: 'не найдено' };
  const MODE_LABEL = { vector: 'по смыслу (векторы)', keyword: 'по словам — эмбеддинги недоступны', none: 'база пуста' };
  const POLL_MS = 2500;

  const state = { meta: null, questions: [], current: null, sending: false, listError: false };
  let pollTimer = null;

  /* ---------------- помощники ---------------- */

  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

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

  function fmtDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const mi = String(d.getMinutes()).padStart(2, '0');
    return `${dd}.${mm}.${d.getFullYear()} ${hh}:${mi}`;
  }

  function plural(n, one, few, many) {
    const m10 = n % 10; const m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return `${n} ${one}`;
    if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return `${n} ${few}`;
    return `${n} ${many}`;
  }

  /**
   * Скромная разметка ответа (как в обсуждении фрагмента): экранирование идёт
   * ПЕРВЫМ, затем абзацы, списки и жирный; ссылки [n] становятся переходами
   * к выдержке.
   */
  function md(text) {
    const lines = esc(text).split('\n');
    const inline = (x) => x
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\[(\d{1,2})\]/g, (m, n) => `<a class="nt-ref" href="#nt-ex-${n}" data-n="${n}" title="Выдержка ${n}">[${n}]</a>`);
    let html = '';
    let list = false;
    for (const raw of lines) {
      const line = raw.trimEnd();
      const li = line.match(/^\s*[-*•]\s+(.*)/);
      if (li) {
        if (!list) { html += '<ul>'; list = true; }
        html += `<li>${inline(li[1])}</li>`;
        continue;
      }
      if (list) { html += '</ul>'; list = false; }
      if (line.trim()) html += `<p>${inline(line.replace(/^#{1,4}\s+/, ''))}</p>`;
    }
    if (list) html += '</ul>';
    return html || '<p></p>';
  }

  const headers = () => {
    const hh = { 'Content-Type': 'application/json' };
    if (window.Auth && window.Auth.token) hh['X-User-Token'] = window.Auth.token;
    return hh;
  };

  async function api(url, opts = {}) {
    const res = await fetch(url, { ...opts, headers: headers(), cache: 'no-store' });
    let data = null;
    try { data = await res.json(); } catch { data = null; }
    if (!res.ok) {
      if (data && data.needLogin) { localStorage.removeItem('enso-pilot1-auth'); location.reload(); }
      throw new Error((data && data.error) || `Ошибка сервера (${res.status})`);
    }
    return data;
  }

  function setError(id, text) {
    const el = $(id);
    el.textContent = text || '';
    el.hidden = !text;
  }

  /* ---------------- справочное: базы, корпус, нейросеть ---------------- */

  async function loadMeta() {
    try {
      state.meta = await api('/api/ntd/meta');
    } catch (err) {
      state.meta = null;
      setError('nt-error', `Справочные данные модуля не получены: ${err.message}`);
      return;
    }
    const m = state.meta;
    const sel = $('nt-kb');
    sel.innerHTML = '';
    const counts = new Map(((m.kb && m.kb.bases) || []).map((b) => [b.id, b.chunks]));
    for (const b of m.bases || []) {
      const n = counts.get(b.id);
      sel.append(h('option', { value: b.id }, `${b.label}${n ? ` (${plural(n, 'фрагмент', 'фрагмента', 'фрагментов')})` : ''}`));
    }
    const kbNote = $('nt-kb-note');
    if (!m.bases || !m.bases.length || !(m.kb && m.kb.enabled)) {
      kbNote.textContent = 'База знаний на сервере не подключена (KB_DIR) — спросить нечего.';
      $('nt-ask').disabled = true;
    } else if (!m.kb.chunks) {
      kbNote.textContent = 'Индекс базы пуст — выполните npm run kb:index на сервере.';
      $('nt-ask').disabled = true;
    } else if (m.kb.withVectors < m.kb.chunks / 2) {
      kbNote.textContent = 'У большинства фрагментов нет векторов: поиск пойдёт по словам, а не по смыслу.';
    } else {
      kbNote.textContent = '«Общая база» — все документы, лучший разбор из имеющихся; «Верифицировано» — только пересчитанные по исходнику.';
    }
    const corpus = m.corpus || { available: false, reason: '' };
    $('nt-corpus-wrap').hidden = !corpus.available;
    $('nt-corpus-off').hidden = corpus.available;
    if (corpus.available) {
      $('nt-corpus-note').textContent = `${plural(corpus.docs.length, 'документ', 'документа', 'документов')} нормоконтроля: ${corpus.docs.map((d) => d.code).join(', ')}`;
    } else {
      $('nt-corpus-off').textContent = `Корпус нормоконтроля не подключён: ${corpus.reason || 'недоступен'}`;
    }
  }

  function renderAiNote() {
    const p = window.EnsoShell && window.EnsoShell.project;
    const note = $('nt-ai-note');
    if (!p) { note.textContent = ''; return; }
    if (p.ai_provider) {
      note.textContent = `Отвечает нейросеть проекта: ${p.ai_provider}${p.ai_model ? ` (${p.ai_model})` : ''}`;
      note.classList.remove('hint-warn');
    } else {
      note.textContent = 'У проекта не выбрана нейросеть — откройте «Свойства проекта» на главной.';
      note.classList.add('hint-warn');
    }
  }

  /* ---------------- вопрос ---------------- */

  async function ask() {
    if (state.sending) return;
    const text = $('nt-q').value.trim();
    if (!text) { setError('nt-error', 'Задайте вопрос — искать нечего.'); $('nt-q').focus(); return; }
    setError('nt-error', '');
    state.sending = true;
    $('nt-ask').disabled = true;
    try {
      const out = await api('/api/ntd/questions', {
        method: 'POST',
        body: JSON.stringify({
          projectId: projectId(),
          question: text,
          kb: $('nt-kb').value || undefined,
          corpus: !!($('nt-corpus') && $('nt-corpus').checked && !$('nt-corpus-wrap').hidden),
        }),
      });
      state.current = out.question;
      location.hash = `#/q/${encodeURIComponent(out.question.id)}`;
      renderAnswer();
      startPoll(out.question.id);
      loadList();
    } catch (err) {
      setError('nt-error', err.message);
    } finally {
      state.sending = false;
      $('nt-ask').disabled = false;
    }
  }

  function stopPoll() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  }

  function startPoll(id) {
    stopPoll();
    pollTimer = setInterval(async () => {
      if (document.hidden) return;
      try {
        const out = await api(`/api/ntd/questions/${encodeURIComponent(id)}`);
        if (!state.current || state.current.id !== id) { stopPoll(); return; }
        state.current = out.question;
        renderAnswer();
        if (out.question.status === 'done' || out.question.status === 'failed') {
          stopPoll();
          loadList();
        }
      } catch (err) {
        // обрыв связи — продолжаем опрашивать; сервер сам доведёт ответ
        $('nt-a-progress').textContent = `связь прервана: ${err.message} — продолжаю опрос`;
      }
    }, POLL_MS);
  }

  async function openQuestion(id) {
    stopPoll();
    try {
      const out = await api(`/api/ntd/questions/${encodeURIComponent(id)}`);
      state.current = out.question;
      renderAnswer();
      if (['queued', 'running'].includes(out.question.status)) startPoll(id);
      $('nt-answer').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (err) {
      state.current = null;
      $('nt-answer').hidden = true;
      toast(err.message, 'error');
      location.hash = '#/';
    }
  }

  async function removeCurrent() {
    const q = state.current;
    if (!q) return;
    const ok = window.EnsoShell
      ? await window.EnsoShell.confirm({ title: 'Удалить вопрос?', message: 'Ответ и ссылки исчезнут из истории проекта.', confirmText: 'Удалить', danger: true })
      : window.confirm('Удалить вопрос?');
    if (!ok) return;
    try {
      await api(`/api/ntd/questions/${encodeURIComponent(q.id)}`, { method: 'DELETE' });
      stopPoll();
      state.current = null;
      $('nt-answer').hidden = true;
      location.hash = '#/';
      toast('Вопрос удалён');
      loadList();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  /* ---------------- ответ ---------------- */

  function renderAnswer() {
    const q = state.current;
    const box = $('nt-answer');
    if (!q) { box.hidden = true; return; }
    box.hidden = false;
    if (window.FragChat) window.FragChat.setContext({ entityId: q.id, anchor: 'ответ по нормам' });

    $('nt-a-question').textContent = q.question;
    $('nt-a-status').innerHTML = `<span class="mod-badge" data-run="${esc(q.status)}">${esc(STATUS_LABEL[q.status] || q.status)}</span>`;
    const base = (state.meta && (state.meta.bases || []).find((b) => b.id === q.kb)) || null;
    $('nt-a-meta').textContent = [
      fmtDate(q.createdAt),
      q.createdByName || '',
      q.provider ? `${q.provider}${q.model ? ` (${q.model})` : ''}` : '',
      base ? base.label : q.kb,
      q.corpus ? 'с корпусом нормоконтроля' : '',
    ].filter(Boolean).join(' · ');

    const running = q.status === 'queued' || q.status === 'running';
    $('nt-a-progress').hidden = !running;
    if (running) $('nt-a-progress').textContent = q.progress || (q.status === 'queued' ? 'в очереди…' : 'идёт…');
    setError('nt-a-error', q.status === 'failed' ? (q.error || 'Ответ не получен') : '');

    const body = $('nt-a-body');
    const r = q.result;
    body.hidden = !(q.status === 'done' && r);
    $('nt-cites-card').hidden = !(q.status === 'done' && r);
    $('nt-excerpts-card').hidden = !(q.status === 'done' && q.excerpts);
    $('nt-delete').hidden = !canEdit(q);
    if (q.status !== 'done' || !r) return;

    body.innerHTML = r.found
      ? md(r.answer)
      : `<div class="nt-notfound">${md(r.answer)}</div>`;

    // ссылки
    const ul = $('nt-cites');
    ul.innerHTML = '';
    const cites = r.citations || [];
    for (const c of cites) {
      ul.append(h('li', { class: 'nt-cite', 'data-status': c.status, id: c.excerpt ? `nt-cite-${c.excerpt}` : null },
        h('div', { class: 'nt-cite-head' },
          h('span', { class: 'mod-badge', 'data-cite': c.status, title: c.label || '' }, CITE_LABEL[c.status] || c.status),
          h('span', { class: 'nt-cite-doc' }, `${c.doc || 'документ не назван'}${c.clause ? `, п. ${c.clause}` : ''}`),
          c.excerpt ? h('a', { class: 'nt-ref', href: `#nt-ex-${c.excerpt}`, 'data-n': String(c.excerpt) }, `[${c.excerpt}]`) : null,
          c.registry && c.registry.status ? h('span', { class: 'mod-badge', 'data-st': c.registry.status }, c.registry.status) : null),
        c.claim ? h('p', { class: 'nt-cite-claim' }, c.claim) : null,
        c.quote ? h('p', { class: 'nt-cite-quote' }, `«${c.quote}»`) : null,
        c.note ? h('p', { class: 'nt-cite-note' }, c.note) : null));
    }
    if (!cites.length) ul.append(h('li', { class: 'empty-state' }, r.found ? 'Модель не дала ни одной ссылки.' : 'Ссылок нет: в базе ответа не нашлось.'));
    const counts = r.counts || {};
    $('nt-cites-counts').innerHTML = cites.length
      ? [['confirmed', 'подтверждено'], ['partial', 'сверить'], ['registry', 'по реестру'], ['unknown', 'не найдено']]
        .filter(([k]) => counts[k])
        .map(([k, label]) => `<span class="mod-badge" data-cite="${k}">${label}: ${counts[k]}</span>`).join(' ')
      : '';

    const fill = (wrapId, listId, items, render) => {
      const list = $(listId);
      list.innerHTML = '';
      for (const it of items || []) list.append(h('li', {}, render ? render(it) : it));
      $(wrapId).hidden = !(items && items.length);
    };
    const notes = [...(r.notes || [])];
    for (const u of r.uncited || []) notes.push(`${u.code} — назван в ответе без ссылки на выдержку: ${u.label}${u.registry && u.registry.status ? ` (реестр: ${u.registry.status})` : ''}`);
    fill('nt-notes-wrap', 'nt-notes', notes);
    fill('nt-missing-wrap', 'nt-missing', r.missing);
    fill('nt-anomalies-wrap', 'nt-anomalies', r.anomalies);

    // выдержки
    const s = r.search || {};
    const parts = [
      `База «${s.kbLabel || q.kb}»: ${plural(s.kbCount || 0, 'выдержка', 'выдержки', 'выдержек')}, поиск ${MODE_LABEL[s.mode] || s.mode || '—'}`,
      s.corpus === 'ok' ? `корпус нормоконтроля: ${plural(s.corpusCount || 0, 'выдержка', 'выдержки', 'выдержек')}` : '',
      s.corpus === 'unavailable' ? `корпус нормоконтроля недоступен: ${s.corpusNote || ''}` : '',
      r.modelCalled === false ? 'модель не вызывалась' : '',
    ].filter(Boolean);
    $('nt-search-line').textContent = parts.join(' · ');
    const exs = q.excerpts || [];
    $('nt-excerpts-count').textContent = exs.length ? String(exs.length) : '';
    const el = $('nt-excerpts');
    el.innerHTML = '';
    for (const e of exs) {
      el.append(h('li', { class: 'nt-excerpt', id: `nt-ex-${e.n}` },
        h('div', { class: 'nt-excerpt-head' }, `[${e.n}] ${e.doc}${e.clause ? `, п. ${e.clause}` : ''}${e.source === 'corpus' ? ' · корпус нормоконтроля' : ''}`),
        h('div', { class: 'nt-excerpt-text' }, e.text || '')));
    }
    if (!exs.length) el.append(h('li', { class: 'empty-state' }, 'Выдержек не найдено.'));
  }

  function canEdit(q) {
    const u = window.Auth && window.Auth.user;
    const p = window.EnsoShell && window.EnsoShell.project;
    if (window.Auth && window.Auth.requireLogin === false) return true;
    if (p && p.can_edit) return true;
    return !!(u && q.createdBy && u.id === q.createdBy);
  }

  /** Переход к выдержке по [n]: раскрыть список и подсветить, hash не трогать. */
  function gotoExcerpt(n) {
    const fold = $('nt-excerpts-card');
    if (fold.hidden) return;
    fold.open = true;
    const el = $(`nt-ex-${n}`);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.style.outline = '2px solid color-mix(in srgb, var(--accent) 55%, transparent)';
    setTimeout(() => { el.style.outline = ''; }, 1800);
  }

  /* ---------------- список ---------------- */

  async function loadList() {
    const pid = projectId();
    if (!pid) return;
    try {
      const out = await api(`/api/ntd/questions?project=${encodeURIComponent(pid)}`);
      state.questions = out.questions || [];
      state.listError = false;
    } catch (err) {
      state.listError = true;
      setError('nt-list-error', `Список вопросов не получен: ${err.message}`);
      return;
    }
    setError('nt-list-error', '');
    renderList();
  }

  function renderList() {
    const box = $('nt-list');
    box.innerHTML = '';
    const items = state.questions;
    $('nt-list-empty').hidden = !!items.length || state.listError;
    for (const q of items) {
      const c = q.counts || {};
      const active = state.current && state.current.id === q.id;
      box.append(h('button', {
        class: `mod-card-btn list-card${active ? ' active' : ''}`, type: 'button',
        'aria-current': active ? 'true' : null,
        onclick: () => { location.hash = `#/q/${encodeURIComponent(q.id)}`; },
      },
      h('span', { class: 'list-card-name nt-q-text' }, q.question.length > 160 ? `${q.question.slice(0, 160)}…` : q.question),
      h('span', { class: 'list-card-meta' },
        h('span', {}, fmtDate(q.createdAt)),
        q.createdByName ? h('span', {}, q.createdByName) : null,
        h('span', {}, q.provider ? `${q.provider}${q.model ? ` (${q.model})` : ''}` : 'модель не указана')),
      h('span', { class: 'list-card-foot' },
        h('span', { class: 'mod-badge', 'data-run': q.status }, STATUS_LABEL[q.status] || q.status),
        q.status === 'done' && q.found === false ? h('span', { class: 'mod-badge', 'data-cite': 'partial' }, 'в базе ответа нет') : null,
        q.status === 'done' && c.confirmed ? h('span', { class: 'mod-badge', 'data-cite': 'confirmed' }, `подтверждено: ${c.confirmed}`) : null,
        q.status === 'done' && (c.partial || c.registry) ? h('span', { class: 'mod-badge', 'data-cite': 'partial' }, `сверить: ${(c.partial || 0) + (c.registry || 0)}`) : null,
        q.status === 'done' && c.unknown ? h('span', { class: 'mod-badge', 'data-cite': 'unknown' }, `не найдено: ${c.unknown}`) : null)));
    }
  }

  /* ---------------- маршрут и запуск ---------------- */

  function route() {
    const m = /^#\/q\/([\w-]+)$/.exec(location.hash || '');
    if (m) { openQuestion(decodeURIComponent(m[1])); return; }
    stopPoll();
    state.current = null;
    $('nt-answer').hidden = true;
    if (window.FragChat) window.FragChat.setContext({});
    renderList();
  }

  function wire() {
    $('nt-ask').addEventListener('click', ask);
    $('nt-q').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); ask(); }
    });
    $('nt-again').addEventListener('click', () => {
      if (state.current) $('nt-q').value = state.current.question;
      $('nt-q').focus();
      $('nt-ask-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    $('nt-delete').addEventListener('click', removeCurrent);
    document.addEventListener('click', (e) => {
      const a = e.target.closest('a.nt-ref');
      if (!a) return;
      e.preventDefault();
      gotoExcerpt(a.dataset.n);
    });
    window.addEventListener('hashchange', route);
    document.addEventListener('enso:project', renderAiNote);
  }

  async function init() {
    window.Auth.init();
    await window.Auth.start();
    if (window.EnsoShell) { window.EnsoShell.renderUser(); await window.EnsoShell.start(); }
    wire();
    renderAiNote();
    await loadMeta();
    await loadList();
    route();
  }

  document.addEventListener('DOMContentLoaded', init);
}());
