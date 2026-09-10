/* Обсуждение выделенного фрагмента — общее для всех страниц платформы.
 *
 * Замечание владельца 10.09.2026, п. 4: «выделяешь часть текста — можно открыть
 * промежуточный чат для обсуждения данного фрагмента; чат должен получать
 * доступ к контексту, о чём идёт речь».
 *
 * Устройство ровно такое: выделение → капсула «Обсудить» → боковая панель с
 * разговором. Вместе с текстом на сервер уходит МЕСТО: проект, модуль, запись
 * (задание, прогон, проверка), подпись места и абзацы вокруг выделения. Без
 * места модель отвечает вообще, а человек смотрит на конкретный пункт.
 *
 * Подключается на каждой странице после shell.js и ничего от неё не требует,
 * кроме заголовков входа. Страница может уточнить место двумя способами:
 *   FragChat.setContext({entityId, anchor})    — для всей страницы;
 *   data-frag-entity / data-frag-anchor        — на любом предке фрагмента.
 * Элемент с data-no-frag из обсуждения исключён целиком.
 */
(function () {
  'use strict';

  const MIN_CHARS = 12;          // «м²» и одно слово обсуждать нечего
  const MAX_CHARS = 6000;        // столько же принимает сервер
  const AROUND = 700;            // абзацы вокруг: по столько знаков в каждую сторону

  const state = {
    entityId: '',
    anchor: '',
    thread: null,
    sending: false,
    open: false,
    pending: null,               // выделение, ждущее нажатия на капсулу
  };

  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  /**
   * Скромная разметка ответа: модели пишут markdown, и без разбора звёздочки
   * с решётками оставались в тексте. Экранирование идёт ПЕРВЫМ — дальше
   * работаем уже с безопасной строкой.
   */
  function md(text) {
    const lines = esc(text).split('\n');
    const inline = (x) => x
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    let html = '';
    let list = false;
    let code = false;
    for (const raw of lines) {
      const line = raw.trimEnd();
      if (/^```/.test(line)) {                       // ограда блока кода
        if (code) { html += '</pre>'; code = false; } else { if (list) { html += '</ul>'; list = false; } html += '<pre>'; code = true; }
        continue;
      }
      if (code) { html += `${line}\n`; continue; }
      const li = line.match(/^\s*[-*•]\s+(.*)/);
      if (li) {
        if (!list) { html += '<ul>'; list = true; }
        html += `<li>${inline(li[1])}</li>`;
        continue;
      }
      if (list) { html += '</ul>'; list = false; }
      const h = line.match(/^(#{1,4})\s+(.*)/);
      if (h) html += `<p class="fc-h">${inline(h[2])}</p>`;
      else if (line.trim()) html += `<p>${inline(line)}</p>`;
    }
    if (list) html += '</ul>';
    if (code) html += '</pre>';
    return html || '<p></p>';
  }

  const headers = () => {
    const h = { 'Content-Type': 'application/json' };
    if (window.Auth && window.Auth.token) h['X-User-Token'] = window.Auth.token;
    return h;
  };

  const loggedIn = () => !!(window.Auth && window.Auth.token);

  async function api(url, opts = {}) {
    const res = await fetch(url, { ...opts, headers: headers(), cache: 'no-store' });
    let data = null;
    try { data = await res.json(); } catch { data = null; }
    if (!res.ok) throw new Error((data && data.error) || `Ошибка сервера (${res.status})`);
    return data;
  }

  /* ---------------- где выделено ---------------- */

  const shellModule = () => (window.EnsoShell && window.EnsoShell.module)
    || document.body.dataset.module || '';
  const shellProject = () => {
    if (window.EnsoShell && window.EnsoShell.projectId) return window.EnsoShell.projectId;
    return new URLSearchParams(location.search).get('project') || '';
  };

  /** Ближайший предок с подписью места: карточка находки, строка таблицы, раздел. */
  function placeOf(node) {
    let el = node && (node.nodeType === 1 ? node : node.parentElement);
    const out = { entityId: state.entityId, anchor: state.anchor };
    while (el && el !== document.body) {
      if (!out.anchorFound && el.dataset && el.dataset.fragAnchor) {
        out.anchor = el.dataset.fragAnchor; out.anchorFound = true;
      }
      if (!out.entityFound && el.dataset && el.dataset.fragEntity) {
        out.entityId = el.dataset.fragEntity; out.entityFound = true;
      }
      el = el.parentElement;
    }
    return { entityId: out.entityId || '', anchor: out.anchor || '' };
  }

  /**
   * Абзацы вокруг фрагмента: модель должна видеть, из чего он вырван.
   *
   * Ищем НОРМАЛИЗОВАННОЕ в НОРМАЛИЗОВАННОМ. Выделение уже склеено по пробелам
   * (onSelection), а текст карточки полон переносов строк и границ элементов,
   * поэтому прямой поиск промахивался на любом выделении длиннее строки — и
   * вместо окружения модели уходило начало СОВСЕМ ДРУГОЙ находки (рецензия
   * 10.09.2026). Не нашли — отдаём пустоту: без окружения лучше, чем с чужим.
   */
  function aroundOf(range, fragment) {
    let el = range.commonAncestorContainer;
    if (el.nodeType !== 1) el = el.parentElement;
    let scope = el;
    while (scope && scope !== document.body) {
      if (scope.dataset && scope.dataset.fragScope !== undefined) break;
      if (scope.scrollHeight > 40 && scope.innerText && scope.innerText.length > fragment.length + 80) break;
      scope = scope.parentElement;
    }
    const raw = ((scope && scope.innerText) || '').replace(/ /g, ' ');
    if (!raw) return '';
    /* Карта «позиция в склеенном → позиция в исходном»: искать надо в склеенном,
       а резать исходный, иначе в промпт уйдёт текст без единого перевода строки. */
    const map = [];
    let flat = '';
    let space = false;
    for (let i = 0; i < raw.length; i += 1) {
      if (/\s/.test(raw[i])) {
        if (flat && !space) { flat += ' '; map.push(i); space = true; }
        continue;
      }
      flat += raw[i]; map.push(i); space = false;
    }
    const needle = fragment.replace(/\s+/g, ' ').trim();
    const key = needle.slice(0, 60);
    const at = key ? flat.indexOf(key) : -1;
    if (at < 0) return '';
    const from = map[Math.max(0, at - AROUND)] ?? 0;
    const endFlat = Math.min(flat.length - 1, at + needle.length + AROUND);
    const to = (map[endFlat] ?? raw.length - 1) + 1;
    return (from > 0 ? '…' : '') + raw.slice(from, to) + (to < raw.length ? '…' : '');
  }

  /* ---------------- капсула у выделения ---------------- */

  let pill = null;

  function hidePill() {
    if (pill) pill.hidden = true;
    state.pending = null;
  }

  function showPill(rect) {
    if (!pill) {
      pill = document.createElement('button');
      pill.type = 'button';
      pill.className = 'fc-pill';
      pill.innerHTML = '<span aria-hidden="true">✦</span> Обсудить';
      pill.addEventListener('mousedown', (e) => e.preventDefault());   // не сбивать выделение
      pill.addEventListener('click', () => { if (state.pending) openFor(state.pending); });
      document.body.appendChild(pill);
    }
    pill.hidden = false;
    const w = pill.offsetWidth || 118;
    const left = Math.min(window.innerWidth - w - 12, Math.max(12, rect.left + rect.width / 2 - w / 2));
    const top = rect.top > 56 ? rect.top - 44 : rect.bottom + 10;
    pill.style.left = `${Math.round(left)}px`;
    pill.style.top = `${Math.round(top)}px`;
  }

  /** Годится ли выделение: не в поле ввода, не в самой панели, не в запретной зоне. */
  function usable(range) {
    let el = range.commonAncestorContainer;
    if (el.nodeType !== 1) el = el.parentElement;
    while (el && el !== document.body) {
      const tag = el.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable) return false;
      if (el.id === 'fc-panel' || (el.dataset && el.dataset.noFrag !== undefined)) return false;
      el = el.parentElement;
    }
    return true;
  }

  function onSelection() {
    if (!loggedIn()) return hidePill();
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return hidePill();
    const text = sel.toString().replace(/\s+/g, ' ').trim();
    if (text.length < MIN_CHARS) return hidePill();
    const range = sel.getRangeAt(0);
    if (!usable(range)) return hidePill();
    const rect = range.getBoundingClientRect();
    if (!rect || (!rect.width && !rect.height)) return hidePill();
    const place = placeOf(range.commonAncestorContainer);
    state.pending = {
      fragment: text.slice(0, MAX_CHARS),
      context: aroundOf(range, text),
      entityId: place.entityId,
      anchor: place.anchor,
    };
    showPill(rect);
  }

  /* ---------------- панель разговора ---------------- */

  let panel = null;
  let list = null;
  let input = null;
  let info = null;
  let quote = null;
  let openerFocus = null;

  /**
   * Панель начинается ПОД шапкой: она не модальная, затемнения под ней нет, и
   * накрытая ею капсула с бургером (единственный вход в настройки и выход)
   * переставала нажиматься. Высота считается по факту — на узком экране
   * капсула переносится в несколько строк.
   */
  function placePanel() {
    if (!panel) return;
    let bottom = 0;
    for (const sel of ['#banners', '#topbar', '.topbar', '.mobile-bar']) {
      const el = document.querySelector(sel);
      if (!el || el.hidden || !el.offsetParent) continue;
      // считаем только ЗАКРЕПЛЁННЫЕ элементы шапки: они и остаются поверх
      const pos = getComputedStyle(el).position;
      if (pos !== 'fixed' && pos !== 'sticky') continue;
      const r = el.getBoundingClientRect();
      if (r.height) bottom = Math.max(bottom, r.bottom);
    }
    // шапка выше трети экрана — значит мерить нечего, панели нужно место
    // (высота окна бывает нулевой в скрытой вкладке — тогда берём разумную)
    const vh = window.innerHeight || document.documentElement.clientHeight || 800;
    const cap = vh * 0.34;
    panel.style.setProperty('--fc-top', `${Math.round(bottom > 0 && bottom < cap ? bottom + 8 : 12)}px`);
  }

  function buildPanel() {
    panel = document.createElement('aside');
    panel.id = 'fc-panel';
    panel.className = 'fc-panel';
    panel.hidden = true;
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Обсуждение фрагмента');
    panel.innerHTML = `
      <div class="fc-head">
        <div class="fc-title">Обсуждение фрагмента</div>
        <div class="fc-place" id="fc-place"></div>
        <button type="button" class="fc-close" id="fc-close" aria-label="Закрыть">×</button>
      </div>
      <blockquote class="fc-quote" id="fc-quote"></blockquote>
      <div class="fc-list" id="fc-list" aria-live="polite"></div>
      <form class="fc-form" id="fc-form">
        <textarea id="fc-input" rows="2" maxlength="4000" placeholder="Спросите об этом фрагменте: что не так, как переписать, чем грозит"></textarea>
        <button type="submit" class="btn btn-primary fc-send">Спросить</button>
      </form>`;
    document.body.appendChild(panel);
    list = panel.querySelector('#fc-list');
    input = panel.querySelector('#fc-input');
    info = panel.querySelector('#fc-place');
    quote = panel.querySelector('#fc-quote');
    panel.querySelector('#fc-close').addEventListener('click', close);
    panel.querySelector('#fc-form').addEventListener('submit', (e) => { e.preventDefault(); send(); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); }
    });
  }

  const MODULE_LABEL = {
    tz: 'Анализ ТЗ', site: 'Посадка здания', doc: 'Проверка документа',
    normo: 'Нормоконтроль', gge: 'Контроль ГГЭ', akty: 'Акты (АОСР)',
    office: 'Виртуальный офис', dataset: 'Датасет',
  };

  function renderPlace(sel) {
    const project = (window.EnsoShell && window.EnsoShell.project && window.EnsoShell.project.name) || '';
    const parts = [MODULE_LABEL[shellModule()] || 'Платформа', project, sel.anchor].filter(Boolean);
    info.textContent = parts.join(' · ');
  }

  function renderMessages() {
    const msgs = (state.thread && state.thread.messages) || [];
    if (!msgs.length) {
      list.innerHTML = '<p class="fc-empty">Модель видит выделенный фрагмент, текст вокруг него и место, откуда он взят. Спросите, что с ним не так или как его переписать.</p>';
    } else {
      list.innerHTML = msgs.map((m) => `
        <div class="fc-msg fc-${m.role === 'assistant' ? 'ai' : 'me'}">
          <div class="fc-who">${esc(m.role === 'assistant' ? (m.model || m.provider || 'Нейросеть') : (m.author_name || 'Вы'))}</div>
          <div class="fc-text">${m.role === 'assistant' ? md(m.content) : esc(m.content).replace(/\n/g, '<br>')}</div>
        </div>`).join('');
    }
    if (state.sending) {
      list.insertAdjacentHTML('beforeend', '<div class="fc-msg fc-ai fc-wait"><div class="fc-text">Модель думает…</div></div>');
    }
    list.scrollTop = list.scrollHeight;
  }

  function setError(text) {
    list.insertAdjacentHTML('beforeend', `<div class="fc-msg fc-err"><div class="fc-text">${esc(text)}</div></div>`);
    list.scrollTop = list.scrollHeight;
  }

  async function openFor(sel) {
    if (!panel) buildPanel();
    openerFocus = document.activeElement;
    hidePill();
    // боковое меню платформы и панель обсуждения занимают одно место
    if (window.EnsoShell && EnsoShell.closeDrawer) { try { EnsoShell.closeDrawer(); } catch { /* нет каркаса */ } }
    window.getSelection().removeAllRanges();
    state.open = true;
    panel.hidden = false;
    placePanel();
    quote.textContent = sel.fragment;
    renderPlace(sel);
    state.thread = null;
    list.innerHTML = '<p class="fc-empty">Открываю обсуждение…</p>';
    input.value = '';
    try {
      const out = await api('/api/fragment-chat/threads', {
        method: 'POST',
        body: JSON.stringify({
          projectId: shellProject(),
          module: shellModule(),
          entityId: sel.entityId,
          anchor: sel.anchor,
          fragment: sel.fragment,
          context: sel.context,
        }),
      });
      state.thread = out.thread;
      renderMessages();
      input.focus();
    } catch (err) {
      list.innerHTML = '';
      setError(err.message);
    }
  }

  async function send() {
    if (!state.thread || state.sending) return;
    const text = input.value.trim();
    if (!text) return;
    state.sending = true;
    const shown = { role: 'user', content: text, author_name: 'Вы' };
    state.thread.messages = (state.thread.messages || []).concat([shown]);
    input.disabled = true;
    renderMessages();
    try {
      const out = await api(`/api/fragment-chat/threads/${encodeURIComponent(state.thread.id)}/messages`, {
        method: 'POST',
        body: JSON.stringify({ message: text }),
      });
      state.sending = false;
      input.disabled = false;
      input.value = '';                       // чистим ТОЛЬКО после успеха
      state.thread.messages.push({ role: 'assistant', content: out.reply, provider: out.provider, model: out.model });
      renderMessages();
    } catch (err) {
      /*
       * Сервер при неудаче не сохранил ничего — значит и в ленте реплики быть
       * не должно, а набранный вопрос обязан остаться в поле: иначе после 429
       * от облака или обрыва его приходилось набирать заново.
       */
      state.sending = false;
      input.disabled = false;
      state.thread.messages = state.thread.messages.filter((m) => m !== shown);
      renderMessages();
      setError(err.message);
      input.focus();
    }
  }

  function close() {
    if (!state.open) return;
    state.open = false;
    panel.hidden = true;
    if (openerFocus && openerFocus.focus) { try { openerFocus.focus(); } catch { /* элемент исчез */ } }
  }

  /* ---------------- подписки ---------------- */

  document.addEventListener('mouseup', () => setTimeout(onSelection, 0));
  document.addEventListener('keyup', (e) => { if (e.shiftKey || (e.key || '').startsWith('Arrow')) setTimeout(onSelection, 0); });
  /*
   * На тач-экране выделяют долгим нажатием и перетаскиванием маркеров, а
   * `mouseup` при этом не приходит вовсе — по одному ему функция «на всей
   * платформе» на телефоне не работала (рецензия 10.09.2026). Поэтому капсулу
   * показывает и `selectionchange`, с задержкой: пока маркер тащат, событие
   * летит десятками в секунду.
   */
  let selTimer = 0;
  document.addEventListener('selectionchange', () => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) { hidePill(); return; }
    clearTimeout(selTimer);
    selTimer = setTimeout(onSelection, 220);
  });
  document.addEventListener('touchend', () => setTimeout(onSelection, 60));
  window.addEventListener('scroll', hidePill, true);
  window.addEventListener('resize', () => { hidePill(); if (state.open) placePanel(); });
  /*
   * Escape закрывает ОДНО окно. Обработчик стоит на перехвате и глушит
   * остальные: у главной свой обработчик, который иначе тем же нажатием
   * схлопывал полноэкранный план под панелью.
   */
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !state.open) return;
    if (document.querySelector('.modal-backdrop:not([hidden])')) return;  // диалог каркаса выше
    e.stopImmediatePropagation();
    close();
  }, true);

  window.FragChat = {
    /** Место страницы. Без аргументов — сброс: уходя с маршрута, страница обязана его снять. */
    setContext({ entityId = '', anchor = '' } = {}) { state.entityId = entityId; state.anchor = anchor; },
    open: openFor,
    close,
    get thread() { return state.thread; },
  };
})();
