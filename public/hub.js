'use strict';
/**
 * Главная страница после редизайна (2026-09-02): экраны «Проекты» и «Стол
 * проекта», окно проекта (создать / свойства / удалить) и переключатель вида
 * в настройках. Экран модуля «Посадка здания» (бывший «Этап 1») остаётся за
 * app.js — здесь только маршрут к нему.
 *
 * Адрес — единственный источник состояния главной:
 *   /                       список проектов
 *   /?project=<id>          стол проекта
 *   /?project=<id>&module=site   модуль 2 «Посадка здания»
 *   /?screen=settings|stats|dataset[&project=<id>]   разделы платформы
 *   /?goto=<модуль>         список проектов с подсказкой, куда откроется проект
 *   /?new=1                 сразу окно нового проекта
 */
(function () {
  const $ = (id) => document.getElementById(id);
  const S = window.EnsoShell;
  if (!S) return;
  const { esc, svg, ICONS, MODULES } = S;
  const params = new URLSearchParams(location.search);
  const PLATFORM_SCREENS = ['settings', 'stats', 'dataset'];
  const STAGES = ['предпроект', 'П', 'Р', 'П+Р', 'стройка'];
  const VIEW_DESC = {
    a: 'Панель проектов слева, полоса стадий над содержимым. Ближе всего к прежнему виду.',
    b: 'Капсула сверху, проект открывается столом из шести модулей. Самый воздушный.',
    c: 'Узкая колонка, проект как вертикальная лента модулей, рейка с номерами слева.',
    d: 'Лист с рамкой, закладки модулей и основная надпись — как лист проекта.',
  };
  const goto = String(params.get('goto') || '');
  const gotoModule = MODULES.find((m) => m.key === goto) || null;
  // ?goto=<модуль> вместе с проектом — сразу в модуль, список не нужен
  if (gotoModule && S.projectId) { location.replace(S.moduleHref(gotoModule.key)); return; }
  const missing = String(params.get('missing') || '');
  /** Служебные параметры (new, missing, project без проекта) не должны переживать F5. */
  function cleanUrl(keep) {
    const q = new URLSearchParams();
    if (keep && S.projectId) q.set('project', S.projectId);
    if (params.get('screen')) q.set('screen', params.get('screen'));
    if (gotoModule) q.set('goto', gotoModule.key);
    const qs = q.toString();
    history.replaceState(null, '', location.pathname + (qs ? `?${qs}` : ''));
  }

  function decideScreen() {
    const s = params.get('screen');
    if (PLATFORM_SCREENS.includes(s)) return s;
    if (S.projectId && params.get('module') === 'site') return 'analysis';
    if (S.projectId) return 'hub';
    return 'projects';
  }

  /** Экраны переключает app.js по клику на .nav-item[data-screen]; до его
   *  готовности классы выставляем сами, а «Статистику» дощёлкиваем позже:
   *  её данные тянет только обработчик app.js. */
  function showScreen(name) {
    document.querySelectorAll('#screen-nav .nav-item').forEach((b) => b.classList.toggle('active', b.dataset.screen === name));
    document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('active', s.id === `screen-${name}`));
    S.setScreen(name);
    if (name === 'stats' || name === 'dataset') {
      let tries = 0;
      const click = () => {
        if (window.appAuthHeaders) { const b = document.querySelector(`#screen-nav .nav-item[data-screen="${name}"]`); if (b) b.click(); return; }
        if (tries++ < 60) setTimeout(click, 250);
      };
      click();
    }
  }

  /* ---------------- список проектов ---------------- */

  function projectCard(p, i) {
    const sum = p.summary || {};
    const startedN = MODULES.filter((m) => sum[m.key] && (sum[m.key].count > 0 || !['none', 'off'].includes(sum[m.key].state))).length;
    const last = MODULES.map((m) => ({ m, s: sum[m.key] })).filter((x) => x.s && x.s.at).sort((a, b) => (a.s.at < b.s.at ? 1 : -1))[0];
    const href = gotoModule ? S.moduleHref(gotoModule.key, p.id) : S.projectHref(p.id);
    return `<div class="proj-card ${p.id === 'legacy' ? 'pc-legacy' : ''}" data-id="${esc(p.id)}" data-n="${i + 1}">
      <a class="pc-link" href="${esc(href)}" aria-label="${gotoModule ? esc(`Открыть «${gotoModule.name}» в проекте ${p.name}`) : `Открыть проект ${esc(p.name)}`}"></a>
      <div class="pc-head">
        <div><div class="pc-name">${esc(p.name)}</div>${p.full_name ? `<div class="pc-full">${esc(p.full_name)}</div>` : ''}</div>
        ${p.id === 'legacy' ? '<span class="pill pill-soft pc-stage">ранние работы</span>' : p.stage ? `<span class="pill pill-acc pc-stage">${esc(p.stage)}</span>` : '<span class="pc-stage"></span>'}
      </div>
      <div class="pc-meta">${esc([p.client || (p.id === 'legacy' ? '' : 'заказчик не указан'), p.created_at ? `начат ${S.fmtDate(p.created_at)}` : ''].filter(Boolean).join(' · '))}</div>
      <div class="pc-foot">
        <span class="pc-bar">${MODULES.map((m) => `<span data-state="${esc((sum[m.key] && sum[m.key].state) || 'none')}"></span>`).join('')}</span>
        <div class="pc-line">
          <span>${startedN ? `${startedN} из 6 модулей начаты` : 'модули не начаты'}${last ? ` · последнее: ${esc(lowerFirst(last.m.name))}, ${S.fmtDate(last.s.at)}` : ''}</span>
          <span class="pc-open">${gotoModule ? `Открыть «${esc(gotoModule.name)}»` : 'Открыть'} ${svg(ICONS.arrowRight)}</span>
        </div>
      </div>
      ${p.can_edit === false ? '' : `<button class="icon-btn pc-more" type="button" data-more="${esc(p.id)}" aria-label="Свойства проекта ${esc(p.name)}" title="Свойства проекта">⋯</button>`}
    </div>`;
  }

  function renderProjects() {
    const list = $('projects-list');
    if (!list) return;
    const keep = focusKey(list);
    const projects = S.projects || [];
    // список не получен — это не «проектов нет», а ошибка связи
    $('projects-empty').hidden = !!projects.length || S.projectsError;
    $('projects-eyebrow').textContent = projects.length ? `Enso-nexus · ${plural(projects.length, 'проект', 'проекта', 'проектов')}` : 'Enso-nexus';
    list.innerHTML = projects.map(projectCard).join('') + `
      <button class="proj-new" type="button" id="proj-new-card">
        <span class="pn-plus">${svg(ICONS.plus)}</span>
        <span class="pn-title">Новый проект</span>
        <span class="pn-sub">Название, стадия, заказчик — и модули появятся сами</span>
      </button>`;
    refocus(list, keep);
    const note = $('projects-goto');
    if (S.projectsError && !projects.length) {
      note.textContent = 'Список проектов не получен — сервер недоступен. Повторю через полминуты.';
      note.hidden = false;
    } else if (gotoModule) {
      note.textContent = `Выберите проект, в котором открыть модуль «${gotoModule.name}», или заведите новый.`;
      note.hidden = false;
    } else note.hidden = true;
  }

  /** «Контроль ГГЭ» → «контроль ГГЭ»: строчной становится только первая буква, аббревиатуры целы. */
  function lowerFirst(str) { return str ? str.charAt(0).toLowerCase() + str.slice(1) : ''; }
  function plural(n, one, few, many) {
    const m10 = n % 10; const m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return `${n} ${one}`;
    if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return `${n} ${few}`;
    return `${n} ${many}`;
  }

  /* ---------------- стол проекта ---------------- */

  /** Ключ элемента с фокусом внутри box — чтобы вернуть фокус после innerHTML. */
  function focusKey(box) {
    const el = document.activeElement;
    if (!el || !box.contains(el)) return null;
    const t = el.closest('[href], [data-more]');
    if (!t) return null;
    return t.hasAttribute('href') ? `[href="${CSS.escape(t.getAttribute('href'))}"]` : `[data-more="${CSS.escape(t.dataset.more)}"]`;
  }
  function refocus(box, key) {
    if (!key) return;
    const el = box.querySelector(key);
    if (el) el.focus();
  }

  function renderHub() {
    const box = $('hub-modules');
    const p = S.project;
    if (!box || !p) return;
    const sum = p.summary || {};
    const keep = focusKey(box);
    box.innerHTML = MODULES.map((m) => {
      const s = sum[m.key] || { state: 'none', line: 'Не запускался' };
      return `<a class="hub-tile" data-state="${esc(s.state)}" href="${esc(S.moduleHref(m.key))}" aria-label="${esc(`${m.n} · ${m.name} — ${s.line}`)}">
        <div class="ht-head">
          <span class="ht-num">${m.n}</span>
          ${svg(ICONS[m.key])}
          <span class="ht-text"><span class="ht-name">${esc(m.name)}</span></span>
          <span class="ht-arrow">${svg(ICONS.arrowRight)}</span>
        </div>
        <p class="ht-sub">${esc(m.sub)}</p>
        <p class="ht-line"><span class="mn-dot" data-state="${esc(s.state)}"></span><span>${esc(s.line)}</span></p>
      </a>`;
    }).join('');
    refocus(box, keep);
    const running = MODULES.filter((m) => sum[m.key] && sum[m.key].state === 'run');
    const note = $('hub-note');
    if (running.length) {
      note.innerHTML = `<span class="mn-dot" data-state="run"></span>${esc(running.map((m) => `${m.name}: ${sum[m.key].line}`).join(' · '))}`;
      note.hidden = false;
    } else note.hidden = true;
    renderHeadActions();
  }

  function renderHeadActions() {
    const box = $('ph-actions');
    if (!box || !S.project) return;
    if ($('hub-edit')) return; // уже стоит — не пересоздавать (фокус, повторные обработчики)
    if (S.project.can_edit === false) { box.innerHTML = '<span class="pill pill-soft">общий проект</span>'; return; }
    box.innerHTML = `<button class="btn btn-ghost" type="button" id="hub-edit">Свойства проекта</button>`;
    $('hub-edit').addEventListener('click', () => openProjectModal(S.project));
  }

  /* ---------------- окно проекта ---------------- */

  let modalProject = null;
  let modalOpener = null; // куда вернуть фокус после закрытия окна

  function openProjectModal(project) {
    modalProject = project || null;
    modalOpener = document.activeElement;
    const m = $('proj-modal');
    $('pm-title').textContent = project ? 'Свойства проекта' : 'Новый проект';
    $('pm-name').value = project ? project.name : '';
    $('pm-full').value = project ? project.full_name || '' : '';
    $('pm-client').value = project ? project.client || '' : '';
    const stageSel = $('pm-stage');
    stageSel.innerHTML = ['<option value="">не указана</option>', ...STAGES.map((s) => `<option value="${esc(s)}">${esc(s)}</option>`)].join('');
    if (project && project.stage && !STAGES.includes(project.stage)) stageSel.insertAdjacentHTML('beforeend', `<option value="${esc(project.stage)}">${esc(project.stage)}</option>`);
    stageSel.value = project ? project.stage || '' : 'П';
    $('pm-error').hidden = true;
    $('pm-submit').textContent = project ? 'Сохранить' : 'Создать проект';
    // «Ранние работы» — приёмник всего, что было до проектов: его не удаляют
    $('pm-delete').hidden = !project || project.id === 'legacy';
    m.hidden = false;
    setTimeout(() => $('pm-name').focus(), 30);
  }
  function closeProjectModal() {
    $('proj-modal').hidden = true;
    if (modalOpener && modalOpener.isConnected && modalOpener.offsetParent !== null) modalOpener.focus();
    else if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
    modalOpener = null;
  }

  async function submitProjectModal(e) {
    e.preventDefault();
    const err = $('pm-error');
    err.hidden = true;
    const body = {
      name: $('pm-name').value.trim(),
      fullName: $('pm-full').value.trim(),
      client: $('pm-client').value.trim(),
      stage: $('pm-stage').value,
    };
    if (!body.name) { err.textContent = 'Дайте проекту короткое имя.'; err.hidden = false; $('pm-name').focus(); return; }
    const btn = $('pm-submit');
    btn.disabled = true;
    try {
      const res = await fetch(modalProject ? `/api/projects/${encodeURIComponent(modalProject.id)}` : '/api/projects', {
        method: modalProject ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json', ...S.headers() },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error((data && data.error) || `Ошибка сервера (${res.status})`);
      closeProjectModal();
      if (modalProject) {
        S.setProject(data.project);
        renderHub();
        renderProjects();
        if (window.appToast) window.appToast('Проект сохранён');
      } else {
        location.href = gotoModule ? S.moduleHref(gotoModule.key, data.project.id) : S.projectHref(data.project.id);
      }
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
    } finally {
      btn.disabled = false;
    }
  }

  async function deleteProject() {
    if (!modalProject) return;
    const p = modalProject;
    const ok = await S.confirm({
      title: `Удалить проект «${p.name}»?`,
      message: 'Проект уйдёт из списка вместе со всем, что в нём заведено. Записи в базе остаются.',
      confirmText: 'Удалить', danger: true,
    });
    if (!ok) return;
    let res;
    try {
      res = await fetch(`/api/projects/${encodeURIComponent(p.id)}`, { method: 'DELETE', headers: S.headers() });
    } catch {
      $('pm-error').textContent = 'Сервер сейчас недоступен — попробуйте чуть позже'; $('pm-error').hidden = false; return;
    }
    if (!res.ok) { const d = await res.json().catch(() => null); $('pm-error').textContent = (d && d.error) || `Ошибка сервера (${res.status})`; $('pm-error').hidden = false; return; }
    closeProjectModal();
    location.href = '/';
  }

  /* ---------------- настройки: вид ---------------- */

  function renderViewSeg() {
    const box = $('view-seg');
    if (!box) return;
    box.innerHTML = Object.entries(S.VIEWS).map(([k, name]) => `
      <button type="button" class="view-option" data-view="${k}" aria-pressed="${S.view === k}">
        <span class="vo-name"><span class="vo-key">${k.toUpperCase()}</span>${esc(name)}</span>
        <span class="vo-sub">${esc(VIEW_DESC[k])}</span>
      </button>`).join('');
    const val = $('set-value-view');
    if (val) val.textContent = `${S.view.toUpperCase()} · ${S.VIEWS[S.view]}`;
  }

  /* ---------------- запуск ---------------- */

  const screen = decideScreen();
  showScreen(screen);
  // на экране настроек с module=site восстанавливается сессия посадки — её разделы видны
  if (screen === 'analysis' || (screen === 'settings' && params.get('module') === 'site')) S.setModule('site');
  renderViewSeg();

  document.addEventListener('enso:head', renderHeadActions);

  S.ready.then(() => {
    // проект из адреса не найден — честно в список
    if (S.projectId && !S.project && screen !== 'projects') {
      if (S.projectsError) {
        if (window.appToast) window.appToast('Список проектов не получен — сервер недоступен', 'error');
      } else {
        if (window.appToast) window.appToast('Проект не найден или удалён — выберите другой', 'error');
        S.setModule('');       // иначе app.js примет адрес за модуль «Посадка» и заведёт сессию
        cleanUrl(false);
      }
      showScreen('projects');
    }
    if (missing && window.appToast) window.appToast('Проект не найден или удалён — выберите другой', 'error');
    if (missing) cleanUrl(false);
    S.setScreen(S.screen); // перерисовать заголовок с данными
    renderProjects();
    renderHub();
    if (params.get('new') === '1') { openProjectModal(null); cleanUrl(true); }
  });
  // список проектов обновляется вместе со сводкой раз в полминуты — статусы модулей живые
  setInterval(() => {
    if (document.hidden) return;
    S.reload().then((changed) => { if (changed) { renderProjects(); renderHub(); } }).catch(() => {});
  }, 30000);

  document.addEventListener('click', (e) => {
    const more = e.target.closest('.pc-more');
    if (more) {
      e.preventDefault();
      const p = (S.projects || []).find((x) => x.id === more.dataset.more);
      if (p) openProjectModal(p);
      return;
    }
    if (e.target.closest('#proj-new-card') || e.target.closest('#btn-new-project')) { openProjectModal(null); return; }
    const opt = e.target.closest('.view-option');
    if (opt) { S.applyView(opt.dataset.view); renderViewSeg(); renderProjects(); renderHub(); }
  });
  $('proj-form').addEventListener('submit', submitProjectModal);
  $('pm-cancel').addEventListener('click', closeProjectModal);
  $('pm-close').addEventListener('click', closeProjectModal);
  $('pm-delete').addEventListener('click', deleteProject);
  $('proj-modal').addEventListener('click', (e) => { if (e.target === $('proj-modal')) closeProjectModal(); });
  // Escape закрывает только верхнее окно: диалог подтверждения поверх свойств проекта закрывает app.js
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || $('proj-modal').hidden) return;
    const dlg = $('dialog-modal');
    if (dlg && !dlg.hidden) return;
    closeProjectModal();
  });
})();
