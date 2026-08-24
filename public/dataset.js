'use strict';
/**
 * Экран «Датасет»: загрузка документов, валидация пар, история, настройки.
 *
 * Живёт отдельным файлом по образцу viewer.js и пользуется общими помощниками
 * app.js: window.appDialog, appToast, appAuthHeaders, appSaveBlob. Свои копии
 * заводить нельзя — забытый X-User-Token уже ломал кнопки платформы молча.
 *
 * Пункт меню скрыт, пока сервер не подтвердит допуск (/api/health →
 * dataset.allowed): показывать дверь, которая не откроется, хуже, чем не
 * показать её вовсе.
 */
(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const state = {
    docs: [],
    valDocId: '',
    valState: '',
    elements: [],
    currentElementId: '',
    currentPairs: [],
    // несохранённые правки полей пар: elementId → pairId → {question, answer};
    // переживают переход между элементами, но не перезагрузку страницы
    drafts: new Map(),
    hist: { page: 1, total: 0, validatedTotal: 0 },
    pollTimer: null,
  };

  /* ---------------- транспорт ---------------- */

  async function api(path, opts = {}) {
    const res = await fetch(`/api/dataset${path}`, {
      ...opts,
      headers: { ...(opts.headers || {}), ...window.appAuthHeaders() },
    });
    let data = null;
    try { data = await res.json(); } catch { /* не-JSON (файл) сюда не ходит */ }
    if (!res.ok) {
      const err = new Error((data && data.error) || `Ошибка сервера (${res.status})`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }
  const json = (obj) => ({ headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });

  /* ---------------- вкладки ---------------- */

  const PANES = ['docs', 'validate', 'history', 'settings'];
  let activePane = 'docs';

  function showPane(name) {
    activePane = name;
    for (const p of PANES) {
      $(`ds-pane-${p}`).hidden = p !== name;
      document.querySelector(`.ds-tab[data-ds-tab="${p}"]`).classList.toggle('active', p === name);
    }
    if (name === 'docs') loadDocs();
    if (name === 'validate') initValidate();
    if (name === 'history') loadHistory();
    if (name === 'settings') loadSettings();
  }

  function screenActive() {
    return document.getElementById('screen-dataset').classList.contains('active');
  }

  /* ---------------- документы ---------------- */

  const DOC_STATUS = {
    queued: 'в очереди',
    chunking: 'нарезка',
    generating: 'генерация черновиков',
    ready: 'готов',
    failed: 'ошибка',
  };

  async function loadDocs() {
    try {
      const { documents } = await api('/documents');
      state.docs = documents;
      renderDocs();
      fillDocSelects();
      // пока идёт обработка — опрашиваем; экран невидим — не опрашиваем
      const busy = documents.some((d) => ['queued', 'chunking', 'generating'].includes(d.processing_status));
      clearTimeout(state.pollTimer);
      if (busy && screenActive()) state.pollTimer = setTimeout(loadDocs, 2000);
    } catch (err) {
      $('ds-doc-list').innerHTML = `<p class="hint">${esc(err.message)}</p>`;
    }
  }

  function renderDocs() {
    const box = $('ds-doc-list');
    if (!state.docs.length) {
      box.innerHTML = '<p class="hint">Документов пока нет — загрузите первый выше.</p>';
      return;
    }
    box.innerHTML = state.docs.map((d) => {
      const status = DOC_STATUS[d.processing_status] || d.processing_status;
      const busy = ['queued', 'chunking', 'generating'].includes(d.processing_status);
      const meta = [
        `${d.format}, ${Math.round(d.size / 1024)} КБ`,
        d.uploaded_by_name && `загрузил: ${d.uploaded_by_name}`,
        new Date(d.uploaded_at).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' }),
        d.elements ? `элементов: ${d.elements}, пройдено: ${d.done}` : '',
        d.pairs ? `пар: ${d.pairs}` : '',
      ].filter(Boolean).join(' · ');
      return `<div class="ds-doc" data-doc="${esc(d.id)}">
        <div class="ds-doc-main">
          <span class="ds-doc-name">${esc(d.filename)}</span>
          <span class="ds-doc-meta hint">${esc(meta)}</span>
          ${d.progress ? `<span class="ds-doc-meta hint">${esc(d.progress)}</span>` : ''}
          ${d.error_text ? `<span class="ds-doc-error">${esc(d.error_text)}</span>` : ''}
        </div>
        <span class="ds-status ds-status-${esc(d.processing_status)}">${esc(status)}${busy ? '…' : ''}</span>
        <span class="ds-doc-actions">
          <button class="btn btn-quiet btn-sm" data-act="validate" ${busy ? 'disabled' : ''}>Валидировать</button>
          <button class="btn btn-quiet btn-sm" data-act="generate" ${busy ? 'disabled' : ''}
                  title="Сгенерировать черновики для текстовых элементов без пары">Черновики</button>
        </span>
      </div>`;
    }).join('');
  }

  async function uploadFile(file) {
    if (!file) return;
    const form = new FormData();
    form.append('file', file);
    $('ds-dropzone').classList.add('ds-busy');
    try {
      const res = await api('/documents', { method: 'POST', body: form });
      if (res.duplicate) {
        window.appToast(`Такой файл уже загружен: «${res.document.filename}» — открыт существующий`, 'info');
      } else {
        window.appToast(`Файл принят: ${res.document.filename}. Нарезка и черновики идут в фоне.`, 'success');
      }
      loadDocs();
    } catch (err) {
      window.appToast(err.message, 'error');
    } finally {
      $('ds-dropzone').classList.remove('ds-busy');
    }
  }

  /* ---------------- валидация ---------------- */

  const EL_STATE = { no_pairs: 'без пары', in_progress: 'в работе', done: 'пройден', deferred: 'отложен' };

  function fillDocSelects() {
    const options = state.docs.map((d) => `<option value="${esc(d.id)}">${esc(d.filename)}</option>`).join('');
    const val = $('ds-val-doc');
    const prev = val.value || state.valDocId;
    val.innerHTML = options || '<option value="">документов нет</option>';
    if (prev && state.docs.some((d) => d.id === prev)) val.value = prev;
    state.valDocId = val.value;

    const hist = $('ds-hist-doc');
    const prevH = hist.value;
    hist.innerHTML = `<option value="">все</option>${options}`;
    if (prevH && state.docs.some((d) => d.id === prevH)) hist.value = prevH;
  }

  async function initValidate() {
    if (!state.docs.length) await loadDocs();
    if (state.valDocId) loadElements();
  }

  async function loadElements(keepCurrent = false) {
    if (!state.valDocId) return;
    try {
      const q = state.valState ? `?state=${state.valState}` : '';
      const { elements, progress } = await api(`/documents/${state.valDocId}/elements${q}`);
      state.elements = elements;
      $('ds-val-progress').textContent = `провалидировано ${progress.done} из ${progress.total} элементов`;
      if (!keepCurrent || !elements.some((e) => e.element_id === state.currentElementId)) {
        state.currentElementId = elements.length ? elements[0].element_id : '';
      }
      renderElementList();
      if (state.currentElementId) await openElement(state.currentElementId, true);
      else renderElement(null, []);
    } catch (err) {
      window.appToast(err.message, 'error');
    }
  }

  function renderElementList() {
    $('ds-el-list').innerHTML = state.elements.map((e) => `
      <li class="ds-el-item${e.element_id === state.currentElementId ? ' active' : ''}" data-el="${esc(e.element_id)}">
        <span class="ds-el-dot" data-state="${esc(e.state)}" title="${esc(EL_STATE[e.state] || e.state)}"></span>
        <span class="ds-el-no">${e.order_index + 1}</span>
        <span class="ds-el-prev">${e.kind === 'table' ? '⊞ ' : ''}${esc(e.preview.slice(0, 60))}…</span>
      </li>`).join('') || '<li class="hint">Элементов с таким фильтром нет</li>';
  }

  async function openElement(elementId, silent = false) {
    try {
      const { element, pairs } = await api(`/elements/${elementId}`);
      state.currentElementId = elementId;
      state.currentPairs = pairs;
      renderElementList();
      renderElement(element, pairs);
    } catch (err) {
      if (!silent) window.appToast(err.message, 'error');
    }
  }

  function linkOf(elementId) {
    return state.elements.find((e) => e.element_id === elementId) || null;
  }

  function renderElement(element, pairs) {
    const buttonsOff = !element;
    for (const id of ['ds-add-pair', 'ds-defer', 'ds-next']) $(id).disabled = buttonsOff;
    if (!element) {
      $('ds-el-title').textContent = 'Элемент';
      $('ds-el-content').textContent = 'Выберите элемент слева';
      $('ds-pairs').innerHTML = '';
      return;
    }
    const link = linkOf(element.id);
    $('ds-el-title').textContent = `Элемент ${link ? link.order_index + 1 : ''} · ${element.kind === 'table' ? 'таблица' : 'текст'} · ~${element.token_count} ток.`;
    $('ds-el-content').textContent = element.content;
    $('ds-defer').textContent = link && link.state === 'deferred' ? 'Вернуть в работу' : 'Пропустить';
    renderPairs(pairs);
  }

  const PAIR_STATUS = { draft: 'черновик', pending: 'на валидации', validated: 'валидирован', rejected: 'отклонён' };

  function renderPairs(pairs) {
    const drafts = state.drafts.get(state.currentElementId) || {};
    const cards = pairs.map((p) => {
      const d = drafts[p.id] || {};
      const q = d.question !== undefined ? d.question : p.question;
      const a = d.answer !== undefined ? d.answer : p.answer;
      const validatedLine = p.validated_by_name
        ? `<span class="hint">Валидировал: ${esc(p.validated_by_name)} · ${new Date(p.validated_at).toLocaleString('ru-RU')}</span>` : '';
      return `<div class="ds-pair" data-pair="${esc(p.id)}" data-updated="${esc(p.updated_at)}">
        <div class="ds-pair-head">
          <span class="ds-status ds-status-${esc(p.status)}">${esc(PAIR_STATUS[p.status] || p.status)}</span>
          <span class="hint">${p.origin === 'auto' ? `модель (промпт ${esc(p.prompt_version)})` : 'вручную'}</span>
          ${validatedLine}
        </div>
        <label class="ds-pair-label">Вопрос
          <textarea class="ds-q" rows="2">${esc(q)}</textarea>
        </label>
        <label class="ds-pair-label">Эталонный ответ
          <textarea class="ds-a" rows="4">${esc(a)}</textarea>
        </label>
        <div class="ds-pair-actions">
          <button class="btn btn-primary btn-sm" data-act="validate" type="button">Подтвердить</button>
          <button class="btn btn-quiet btn-sm" data-act="reject" type="button">Отклонить</button>
          <button class="btn btn-quiet btn-sm" data-act="save" type="button">Сохранить</button>
          <button class="btn btn-quiet btn-sm ds-del" data-act="delete" type="button" title="Убрать пару (мягкое удаление)">Удалить</button>
        </div>
      </div>`;
    });
    // несохранённая новая пара
    if (drafts.__new) {
      cards.push(`<div class="ds-pair ds-pair-new" data-pair="__new">
        <div class="ds-pair-head"><span class="ds-status ds-status-pending">новая пара</span></div>
        <label class="ds-pair-label">Вопрос<textarea class="ds-q" rows="2">${esc(drafts.__new.question || '')}</textarea></label>
        <label class="ds-pair-label">Эталонный ответ<textarea class="ds-a" rows="4">${esc(drafts.__new.answer || '')}</textarea></label>
        <div class="ds-pair-actions">
          <button class="btn btn-primary btn-sm" data-act="create" type="button">Создать</button>
          <button class="btn btn-quiet btn-sm" data-act="discard" type="button">Убрать</button>
        </div>
      </div>`);
    }
    $('ds-pairs').innerHTML = cards.join('') || '<p class="hint">Пар нет — модель не справилась или элемент табличный. Добавьте пару вручную.</p>';
  }

  /** Запомнить правки полей, не дёргая сервер: вызовется при вводе. */
  function stashDraft(pairId, field, value) {
    let el = state.drafts.get(state.currentElementId);
    if (!el) { el = {}; state.drafts.set(state.currentElementId, el); }
    el[pairId] = { ...(el[pairId] || {}), [field]: value };
  }

  function pairCard(pairId) {
    return document.querySelector(`.ds-pair[data-pair="${CSS.escape(pairId)}"]`);
  }

  function readCard(card) {
    return { question: card.querySelector('.ds-q').value, answer: card.querySelector('.ds-a').value };
  }

  function clearDraft(pairId) {
    const el = state.drafts.get(state.currentElementId);
    if (el) delete el[pairId];
  }

  /** Пара изменена в полях? Сравнение с тем, что пришло с сервера. */
  function isDirty(pairId, card) {
    const pair = state.currentPairs.find((p) => p.id === pairId);
    if (!pair) return false;
    const cur = readCard(card);
    return cur.question !== pair.question || cur.answer !== pair.answer;
  }

  async function withConflictDialog(fn) {
    try {
      return await fn();
    } catch (err) {
      if (err.status === 409 && err.data) {
        const reread = await window.appDialog({
          title: 'Пара изменена параллельно',
          message: `${err.message}`,
          confirmText: 'Перечитать',
          cancelText: 'Оставить как есть',
        });
        if (reread) {
          clearDraft(currentPairIdIn(err));
          await openElement(state.currentElementId, true);
        }
        return null;
      }
      throw err;
    }
  }
  // id пары для очистки черновика при конфликте кладёт вызывающий код
  let conflictPairId = '';
  function currentPairIdIn() { return conflictPairId; }

  /** Сохранить правку (если есть) и вернуть свежий updated_at пары. */
  async function ensureSaved(pairId) {
    const card = pairCard(pairId);
    const pair = state.currentPairs.find((p) => p.id === pairId);
    if (!card || !pair) return null;
    if (!isDirty(pairId, card)) return pair.updated_at;
    const { question, answer } = readCard(card);
    const res = await api(`/pairs/${pairId}`, { method: 'PATCH', ...json({ question, answer, expectedUpdatedAt: card.dataset.updated }) });
    clearDraft(pairId);
    return res.pair.updated_at;
  }

  async function actValidate(pairId) {
    conflictPairId = pairId;
    const done = await withConflictDialog(async () => {
      const updatedAt = await ensureSaved(pairId);
      await api(`/pairs/${pairId}/validate`, { method: 'POST', ...json({ expectedUpdatedAt: updatedAt }) });
      return true;
    });
    if (done) {
      window.appToast('Пара подтверждена', 'success');
      await afterPairChange();
    }
  }

  async function actReject(pairId) {
    conflictPairId = pairId;
    const done = await withConflictDialog(async () => {
      const updatedAt = await ensureSaved(pairId);
      await api(`/pairs/${pairId}/reject`, { method: 'POST', ...json({ expectedUpdatedAt: updatedAt }) });
      return true;
    });
    if (done) {
      window.appToast('Пара отклонена', 'info');
      await afterPairChange();
    }
  }

  async function actSave(pairId) {
    conflictPairId = pairId;
    const done = await withConflictDialog(() => ensureSaved(pairId));
    if (done) {
      window.appToast('Правка сохранена — пара ждёт валидации', 'success');
      await afterPairChange();
    }
  }

  async function actDelete(pairId) {
    const ok = await window.appDialog({
      title: 'Удалить пару?',
      message: 'Пара уйдёт из реестра и из экспорта. Удаление мягкое — при необходимости её вернут из базы.',
      confirmText: 'Удалить', danger: true,
    });
    if (!ok) return;
    await api(`/pairs/${pairId}`, { method: 'DELETE' });
    clearDraft(pairId);
    window.appToast('Пара удалена', 'info');
    await afterPairChange();
  }

  async function actCreate() {
    const card = pairCard('__new');
    if (!card) return;
    const { question, answer } = readCard(card);
    try {
      await api(`/elements/${state.currentElementId}/pairs`, { method: 'POST', ...json({ question, answer }) });
      const el = state.drafts.get(state.currentElementId);
      if (el) delete el.__new;
      window.appToast('Пара создана и ждёт валидации', 'success');
      await afterPairChange();
    } catch (err) {
      window.appToast(err.message, 'error');
    }
  }

  /** После изменения пары: обновить элемент, список и прогресс, остаться на месте. */
  async function afterPairChange() {
    await loadElements(true);
  }

  async function actDefer() {
    const link = linkOf(state.currentElementId);
    if (!link) return;
    const off = link.state === 'deferred';
    await api(`/documents/${state.valDocId}/elements/${state.currentElementId}/defer`, { method: 'POST', ...json({ off }) });
    window.appToast(off ? 'Элемент возвращён в работу' : 'Элемент отложен — он остаётся в списке', 'info');
    await loadElements(true);
    if (!off) nextElement();
  }

  function nextElement() {
    if (!state.elements.length) return;
    const i = state.elements.findIndex((e) => e.element_id === state.currentElementId);
    const next = state.elements[(i + 1) % state.elements.length];
    if (next) openElement(next.element_id);
  }

  /** Пара «в фокусе» для горячих клавиш: где курсор, иначе первая. */
  function focusedPairId() {
    const active = document.activeElement && document.activeElement.closest && document.activeElement.closest('.ds-pair');
    if (active && active.dataset.pair !== '__new') return active.dataset.pair;
    const first = document.querySelector('#ds-pairs .ds-pair:not(.ds-pair-new)');
    return first ? first.dataset.pair : '';
  }

  /* ---------------- история ---------------- */

  function histParams() {
    const p = new URLSearchParams();
    const q = $('ds-hist-q').value.trim();
    if (q) p.set('q', q);
    for (const [id, key] of [['ds-hist-status', 'status'], ['ds-hist-doc', 'document'], ['ds-hist-validator', 'validator'],
      ['ds-hist-kind', 'kind'], ['ds-hist-origin', 'origin'], ['ds-hist-from', 'from'], ['ds-hist-to', 'to'], ['ds-hist-sort', 'sort']]) {
      const v = $(id).value;
      if (v) p.set(key, v);
    }
    p.set('page', String(state.hist.page));
    return p.toString();
  }

  async function loadHistory() {
    try {
      const data = await api(`/pairs?${histParams()}`);
      state.hist.total = data.total;
      state.hist.validatedTotal = data.validatedTotal;
      renderHistory(data);
    } catch (err) {
      $('ds-hist-body').innerHTML = `<tr><td colspan="8" class="hint">${esc(err.message)}</td></tr>`;
    }
  }

  function renderHistory(data) {
    // валидаторы — без потери выбранного
    const vSel = $('ds-hist-validator');
    const prevV = vSel.value;
    vSel.innerHTML = `<option value="">все</option>${data.facets.validators.map((v) => `<option value="${esc(v)}">${esc(v)}</option>`).join('')}`;
    if (prevV && data.facets.validators.includes(prevV)) vSel.value = prevV;

    $('ds-hist-body').innerHTML = data.items.map((it) => `
      <tr data-pair="${esc(it.id)}" data-element="${esc(it.element_id)}" data-updated="${esc(it.updated_at)}">
        <td class="name"><button class="ds-el-open" type="button" title="Полный текст элемента">${esc(it.preview.slice(0, 80))}…</button>
          ${it.document_id ? `<span class="hint">${esc(it.filename || '')}${Number.isInteger(it.order_index) ? `, элемент ${it.order_index + 1}` : ''}</span>` : ''}</td>
        <td>${esc(it.descr || (it.kind === 'table' ? 'таблица' : ''))}</td>
        <td class="ds-cell-q">${esc(it.question)}</td>
        <td class="ds-cell-a">${esc(it.answer)}</td>
        <td><span class="ds-status ds-status-${esc(it.status)}">${esc(PAIR_STATUS[it.status] || it.status)}</span></td>
        <td>${esc(it.validated_by_name)}</td>
        <td class="num">${it.validated_at ? new Date(it.validated_at).toLocaleString('ru-RU') : ''}</td>
        <td class="ds-row-actions">
          <button class="btn btn-quiet btn-sm" data-act="edit" type="button" title="Редактировать">✎</button>
          <button class="btn btn-quiet btn-sm ds-del" data-act="delete" type="button" title="Удалить (мягко)">✕</button>
        </td>
      </tr>`).join('') || '<tr><td colspan="8" class="hint">Ничего не найдено</td></tr>';

    const pages = Math.max(1, Math.ceil(data.total / data.per));
    $('ds-hist-page').textContent = `${data.page} / ${pages} · всего: ${data.total}`;
    $('ds-hist-prev').disabled = data.page <= 1;
    $('ds-hist-next').disabled = data.page >= pages;
    $('ds-hist-summary').textContent = `Валидировано всего: ${data.validatedTotal} — столько пар уйдёт в экспорт (фильтры на экспорт не влияют)`;
    for (const id of ['ds-export', 'ds-export-split']) {
      $(id).disabled = !data.validatedTotal;
      $(id).title = data.validatedTotal ? '' : 'Валидированных пар пока нет — экспортировать нечего';
    }
  }

  /** Инлайн-правка ряда истории: ячейки вопроса и ответа становятся полями. */
  function editHistoryRow(tr) {
    if (tr.classList.contains('editing')) return;
    tr.classList.add('editing');
    const qCell = tr.querySelector('.ds-cell-q');
    const aCell = tr.querySelector('.ds-cell-a');
    const q = qCell.textContent;
    const a = aCell.textContent;
    qCell.innerHTML = `<textarea class="ds-q" rows="2">${esc(q)}</textarea>`;
    aCell.innerHTML = `<textarea class="ds-a" rows="3">${esc(a)}</textarea>`;
    const actions = tr.querySelector('.ds-row-actions');
    actions.innerHTML = `
      <button class="btn btn-primary btn-sm" data-act="save-row" type="button">Сохранить</button>
      <button class="btn btn-quiet btn-sm" data-act="cancel-row" type="button">Отмена</button>`;
  }

  async function saveHistoryRow(tr) {
    const pairId = tr.dataset.pair;
    try {
      await api(`/pairs/${pairId}`, {
        method: 'PATCH',
        ...json({
          question: tr.querySelector('.ds-q').value,
          answer: tr.querySelector('.ds-a').value,
          expectedUpdatedAt: tr.dataset.updated,
        }),
      });
      window.appToast('Правка сохранена — пара ждёт валидации', 'success');
      loadHistory();
    } catch (err) {
      if (err.status === 409) {
        const reread = await window.appDialog({
          title: 'Пара изменена параллельно', message: err.message,
          confirmText: 'Перечитать', cancelText: 'Отмена',
        });
        if (reread) loadHistory();
        return;
      }
      window.appToast(err.message, 'error');
    }
  }

  async function showElementModal(elementId) {
    try {
      const { element } = await api(`/elements/${elementId}`);
      $('ds-modal-title').textContent = element.kind === 'table' ? 'Элемент · таблица' : 'Элемент · текст';
      $('ds-modal-meta').textContent = `${element.descr || ''} · ~${element.token_count} ток.`;
      $('ds-modal-content').textContent = element.content;
      $('ds-modal').hidden = false;
    } catch (err) {
      window.appToast(err.message, 'error');
    }
  }

  /* ---------------- экспорт ---------------- */

  async function doExport(split) {
    const btn = $(split ? 'ds-export-split' : 'ds-export');
    btn.disabled = true;
    try {
      const res = await fetch(`/api/dataset/export${split ? '?split=1' : ''}`, { headers: window.appAuthHeaders() });
      if (!res.ok) {
        let msg = `Ошибка сервера (${res.status})`;
        try { msg = (await res.json()).error || msg; } catch {}
        throw new Error(msg);
      }
      const disposition = res.headers.get('Content-Disposition') || '';
      const m = disposition.match(/filename="([^"]+)"/);
      const blob = await res.blob();
      window.appSaveBlob(blob, (m && m[1]) || (split ? 'dataset-split.zip' : 'dataset.jsonl'));
      window.appToast(`Экспортировано пар: ${res.headers.get('X-Dataset-Pairs') || '—'}`, 'success');
    } catch (err) {
      window.appToast(err.message, 'error');
    } finally {
      btn.disabled = !state.hist.validatedTotal;
    }
  }

  /* ---------------- настройки ---------------- */

  async function loadSettings() {
    try {
      const { settings } = await api('/settings');
      $('ds-set-prompt').value = settings.gen_prompt;
      $('ds-set-prompt-version').textContent = settings.gen_prompt_version;
      $('ds-set-provider').value = settings.ai_provider;
      $('ds-set-model').value = settings.ai_model;
      $('ds-set-seed').value = settings.seed;
    } catch (err) {
      window.appToast(err.message, 'error');
    }
  }

  async function saveSettings() {
    try {
      const { settings } = await api('/settings', {
        method: 'PUT',
        ...json({
          gen_prompt: $('ds-set-prompt').value,
          ai_provider: $('ds-set-provider').value,
          ai_model: $('ds-set-model').value,
          seed: $('ds-set-seed').value,
        }),
      });
      $('ds-set-prompt-version').textContent = settings.gen_prompt_version;
      window.appToast(`Настройки сохранены (промпт: ${settings.gen_prompt_version})`, 'success');
    } catch (err) {
      window.appToast(err.message, 'error');
    }
  }

  /* ---------------- события ---------------- */

  function wire() {
    for (const tab of document.querySelectorAll('.ds-tab')) {
      tab.addEventListener('click', () => showPane(tab.dataset.dsTab));
    }
    // пункт меню кликнули — обновить документы (обработку экрана делает app.js)
    $('nav-dataset').addEventListener('click', () => showPane(activePane));

    // загрузка
    const dz = $('ds-dropzone');
    const input = $('ds-file-input');
    dz.addEventListener('click', () => input.click());
    dz.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
    input.addEventListener('change', () => { uploadFile(input.files[0]); input.value = ''; });
    dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('dragging'); });
    dz.addEventListener('dragleave', () => dz.classList.remove('dragging'));
    dz.addEventListener('drop', (e) => {
      e.preventDefault();
      dz.classList.remove('dragging');
      uploadFile(e.dataTransfer.files[0]);
    });

    // документы: действия по кнопкам
    $('ds-doc-list').addEventListener('click', async (e) => {
      const btn = e.target.closest('button[data-act]');
      if (!btn) return;
      const docId = btn.closest('.ds-doc').dataset.doc;
      if (btn.dataset.act === 'validate') {
        state.valDocId = docId;
        showPane('validate');
        $('ds-val-doc').value = docId;
        loadElements();
      }
      if (btn.dataset.act === 'generate') {
        try {
          await api(`/documents/${docId}/generate`, { method: 'POST', ...json({}) });
          window.appToast('Генерация черновиков запущена в фоне', 'info');
          loadDocs();
        } catch (err) { window.appToast(err.message, 'error'); }
      }
    });

    // валидация
    $('ds-val-doc').addEventListener('change', () => { state.valDocId = $('ds-val-doc').value; loadElements(); });
    $('ds-val-state').addEventListener('change', () => { state.valState = $('ds-val-state').value; loadElements(); });
    $('ds-el-list').addEventListener('click', (e) => {
      const li = e.target.closest('.ds-el-item');
      if (li) openElement(li.dataset.el);
    });
    $('ds-pairs').addEventListener('input', (e) => {
      const card = e.target.closest('.ds-pair');
      if (!card) return;
      const field = e.target.classList.contains('ds-q') ? 'question' : e.target.classList.contains('ds-a') ? 'answer' : '';
      if (field) stashDraft(card.dataset.pair, field, e.target.value);
    });
    $('ds-pairs').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-act]');
      if (!btn) return;
      const card = btn.closest('.ds-pair');
      const pairId = card.dataset.pair;
      const act = btn.dataset.act;
      if (act === 'validate') actValidate(pairId);
      else if (act === 'reject') actReject(pairId);
      else if (act === 'save') actSave(pairId);
      else if (act === 'delete') actDelete(pairId);
      else if (act === 'create') actCreate();
      else if (act === 'discard') {
        const el = state.drafts.get(state.currentElementId);
        if (el) delete el.__new;
        renderPairs(state.currentPairs);
      }
    });
    $('ds-add-pair').addEventListener('click', () => {
      stashDraft('__new', 'question', (state.drafts.get(state.currentElementId) || {}).__new?.question || '');
      renderPairs(state.currentPairs);
      const card = pairCard('__new');
      if (card) card.querySelector('.ds-q').focus();
    });
    $('ds-defer').addEventListener('click', actDefer);
    $('ds-next').addEventListener('click', nextElement);

    // горячие клавиши — только на активном экране «Датасет», вкладка «Валидация»
    document.addEventListener('keydown', (e) => {
      if (!screenActive() || activePane !== 'validate') return;
      if (!(e.metaKey || e.ctrlKey)) return;
      const pairId = focusedPairId();
      if (e.key === 'Enter' && pairId) { e.preventDefault(); actValidate(pairId); }
      else if (e.key === 'Backspace' && pairId) { e.preventDefault(); actReject(pairId); }
      else if (e.key === '.') { e.preventDefault(); actDefer(); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); nextElement(); }
    });

    // история
    let searchTimer = null;
    $('ds-hist-q').addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => { state.hist.page = 1; loadHistory(); }, 300);
    });
    for (const id of ['ds-hist-status', 'ds-hist-doc', 'ds-hist-validator', 'ds-hist-kind', 'ds-hist-origin', 'ds-hist-from', 'ds-hist-to', 'ds-hist-sort']) {
      $(id).addEventListener('change', () => { state.hist.page = 1; loadHistory(); });
    }
    $('ds-hist-prev').addEventListener('click', () => { state.hist.page--; loadHistory(); });
    $('ds-hist-next').addEventListener('click', () => { state.hist.page++; loadHistory(); });
    $('ds-hist-body').addEventListener('click', (e) => {
      const open = e.target.closest('.ds-el-open');
      const tr = e.target.closest('tr[data-pair]');
      if (!tr) return;
      if (open) return showElementModal(tr.dataset.element);
      const btn = e.target.closest('button[data-act]');
      if (!btn) return;
      const act = btn.dataset.act;
      if (act === 'edit') editHistoryRow(tr);
      else if (act === 'cancel-row') loadHistory();
      else if (act === 'save-row') saveHistoryRow(tr);
      else if (act === 'delete') {
        window.appDialog({
          title: 'Удалить пару?',
          message: 'Пара уйдёт из реестра и из экспорта (мягкое удаление).',
          confirmText: 'Удалить', danger: true,
        }).then(async (ok) => {
          if (!ok) return;
          try { await api(`/pairs/${tr.dataset.pair}`, { method: 'DELETE' }); loadHistory(); } catch (err) { window.appToast(err.message, 'error'); }
        });
      }
    });
    $('ds-export').addEventListener('click', () => doExport(false));
    $('ds-export-split').addEventListener('click', () => doExport(true));

    // настройки
    $('ds-set-save').addEventListener('click', saveSettings);

    // модалка элемента
    $('ds-modal-close').addEventListener('click', () => { $('ds-modal').hidden = true; });
    $('ds-modal').addEventListener('click', (e) => { if (e.target === $('ds-modal')) $('ds-modal').hidden = true; });
  }

  /* ---------------- запуск ---------------- */

  async function boot() {
    // app.js инициализируется асинхронно (вход, health) — дожидаемся помощников
    for (let i = 0; i < 100 && !(window.appAuthHeaders && window.appToast); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    if (!window.appAuthHeaders) return;
    try {
      const res = await fetch('/api/health', { headers: window.appAuthHeaders() });
      const health = await res.json();
      if (!health.dataset || !health.dataset.allowed) return; // пункт меню остаётся скрытым
      const limits = health.limits || {};
      if (limits.maxFileSizeMb) {
        $('ds-limits').textContent = `Один файл до ${limits.maxFileSizeMb} МБ: ${(limits.allowedExtensions || []).join(', ')}`;
      }
      $('nav-dataset').hidden = false;
      wire();
      loadDocs();
    } catch { /* сервер недоступен — экран входа платформы разберётся сам */ }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
