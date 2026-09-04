'use strict';
/**
 * Модуль «Нормоконтроль» — отдельная страница /normo.html.
 *
 * Вход общий с платформой: auth.js кладёт токен человека в localStorage
 * (ключ enso-pilot1-auth), сюда он приходит через window.Auth и уходит на
 * сервер заголовком X-User-Token — все маршруты /api/normo требуют его.
 *
 * Экраны — состояния одной страницы, адрес — в hash, чтобы перезагрузка
 * возвращала туда же:
 *   #/            список проектов
 *   #/p/:id       карточка проекта (состав разделов)
 *   #/p/:id/s/:sid  история версий раздела
 *   #/v/:vid      версия: файлы, прогон, замечания, журнал
 */
(function () {
  const $ = (id) => document.getElementById(id);
  // контекст проекта платформы: ?project=<id> в адресе, читает общий каркас
  const projectId = () => (window.EnsoShell && window.EnsoShell.projectId) || '';
  const projectQuery = () => (projectId() ? `?project=${encodeURIComponent(projectId())}` : '');


  /* ---------------- словари ---------------- */

  const SEVERITIES = ['critical', 'major', 'minor', 'remark'];
  const SEV_LABEL = {
    critical: 'Критические',
    major: 'Значительные',
    minor: 'Незначительные',
    remark: 'Примечания',
  };
  const SEV_ONE = { critical: 'критично', major: 'значительное', minor: 'незначительное', remark: 'примечание' };
  const STATUS_LABEL = {
    open: 'открыто',
    fixed: 'устранено',
    rejected: 'отклонено',
    accepted_with_deviation: 'принято с отступлением',
  };
  const VERIF_LABEL = {
    auto: 'автопроверка',
    needs_human: 'нужна проверка человеком',
    human_confirmed: 'подтверждено человеком',
    human_rejected: 'отклонено человеком',
  };
  const ORIGIN_LABEL = { deterministic: 'детерминированная', llm: 'модель', manual: 'вручную' };
  const OUT_LABEL = { ok: 'выполнено, чисто', finding: 'замечание', skipped: 'пропущено', error: 'ошибка' };
  const LOC_LABEL = { file: 'файл', place: 'место', page: 'стр.', section: 'раздел' };

  /* ---------------- состояние ---------------- */

  const state = {
    route: { name: 'projects' },
    project: null,          // проект текущего экрана (карточка/раздел)
    version: null,          // версия текущего экрана
    run: null,              // прогон версии (журнал)
    findings: [],
    uploadCtx: null,        // { projectId, section } для окна загрузки
  };

  /* ---------------- мелкие помощники ---------------- */

  function h(tag, attrs, ...kids) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k === 'html') node.innerHTML = v; // только для доверенной разметки, данных тут нет
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

  function fmtDate(value) {
    if (!value) return '—';
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleDateString('ru-RU');
  }
  function fmtDateTime(value) {
    if (!value) return '—';
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? String(value)
      : `${d.toLocaleDateString('ru-RU')} ${d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`;
  }
  function fmtSize(bytes) {
    const n = Number(bytes) || 0;
    if (n < 1024) return `${n} Б`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} КБ`;
    return `${(n / 1024 / 1024).toFixed(1)} МБ`;
  }
  function plural(n, one, few, many) {
    const m10 = n % 10; const m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
    return many;
  }

  function saveBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  }

  /* ---------------- обращения к API модуля ---------------- */

  function userHeaders() {
    const hh = {};
    if (window.Auth && window.Auth.token) hh['X-User-Token'] = window.Auth.token;
    return hh;
  }

  async function api(path, options = {}) {
    const headers = Object.assign(userHeaders(), options.headers);
    if (options.json !== undefined) {
      headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(options.json);
    }
    let res;
    try {
      res = await fetch(`/api/normo${path}`, { ...options, headers });
    } catch {
      const e = new Error('Сервер сейчас недоступен — попробуйте чуть позже');
      e.offline = true;
      throw e;
    }
    let data = null;
    try { data = await res.json(); } catch { /* файлы и пустые ответы */ }
    if (!res.ok) {
      // вход истёк или снят — возвращаем человека на экран входа, а не сыплем ошибками
      if (data && data.needLogin) { localStorage.removeItem('enso-pilot1-auth'); location.reload(); }
      const err = new Error((data && data.error) || `Ошибка сервера (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  /* ---------------- маршрутизация ---------------- */

  function parseHash() {
    const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
    if (parts[0] === 'p' && parts[1] && parts[2] === 's' && parts[3]) {
      return { name: 'section', projectId: parts[1], sectionId: parts[3] };
    }
    if (parts[0] === 'p' && parts[1]) return { name: 'project', projectId: parts[1] };
    if (parts[0] === 'v' && parts[1]) return { name: 'version', versionId: parts[1] };
    return { name: 'projects' };
  }

  function showScreen(name) {
    for (const s of document.querySelectorAll('.nm-screen')) {
      s.classList.toggle('active', s.id === `nm-s-${name}`);
    }
  }

  function setCrumbs(items) {
    const nav = $('nm-crumbs');
    nav.innerHTML = '';
    if (!items || !items.length) { nav.hidden = true; return; }
    nav.hidden = false;
    items.forEach((it, i) => {
      if (i) nav.append(h('span', { class: 'sep' }, '/'));
      nav.append(it.href
        ? h('a', { href: it.href }, it.text)
        : h('span', { class: 'here' }, it.text));
    });
  }

  async function route() {
    const r = state.route = parseHash();
    try {
      if (r.name === 'projects') await showProjects();
      else if (r.name === 'project') await showProject(r.projectId);
      else if (r.name === 'section') await showSection(r.projectId, r.sectionId);
      else if (r.name === 'version') await showVersion(r.versionId);
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  /* ---------------- экран: проекты ---------------- */

  async function loadHealth() {
    const line = $('nm-health');
    try {
      const data = await api('/health');
      const rules = data.rules || {};
      line.textContent = `База подключена · правил в каталоге: ${rules.count ?? '—'}`
        + (rules.hash ? ` · каталог ${rules.hash}` : '');
    } catch (err) {
      line.textContent = err.offline
        ? 'Сервер недоступен — попробуйте чуть позже'
        : `Хранилище нормоконтроля недоступно: ${err.message}`;
    }
  }

  async function showProjects() {
    showScreen('projects');
    setCrumbs(null);
    const grid = $('nm-projects');
    const errBox = $('nm-projects-error');
    errBox.hidden = true;
    grid.innerHTML = '';
    grid.append(h('p', { class: 'hint' }, 'Загрузка комплектов…'));
    let projects;
    try {
      ({ projects } = await api(`/projects${projectQuery()}`));
    } catch (err) {
      grid.innerHTML = '';
      $('nm-projects-empty').hidden = true;
      errBox.textContent = err.offline
        ? 'Сервер сейчас недоступен. Список комплектов появится, как только связь восстановится.'
        : `Не удалось получить список комплектов: ${err.message}`;
      errBox.hidden = false;
      return;
    }
    grid.innerHTML = '';
    $('nm-projects-empty').hidden = projects.length > 0;
    for (const p of projects) grid.append(projectCard(p));
  }

  function projectCard(p) {
    const open = Number(p.open_findings) || 0;
    return h('button', {
      class: 'nm-proj-card', type: 'button',
      onclick: () => { location.hash = `#/p/${p.id}`; },
    },
    h('span', { class: 'nm-proj-name' }, p.name),
    p.customer ? h('span', { class: 'nm-proj-customer' }, p.customer) : null,
    h('span', { class: 'nm-proj-meta' },
      h('span', {}, `стадия ${p.stage}`),
      h('span', {}, p.object_kind || ''),
      h('span', {}, `начат ${fmtDate(p.date_started)}`)),
    h('span', { class: 'nm-proj-foot' },
      h('span', { class: `nm-badge ${open ? 'bad' : 'ok'}` },
        open ? `${open} ${plural(open, 'замечание', 'замечания', 'замечаний')}` : 'открытых замечаний нет'),
      h('span', { class: 'nm-badge muted' }, `разделов: ${Number(p.sections_count) || 0}`),
      p.local_only ? h('span', { class: 'nm-badge warn', title: 'Документы не уходят в облачные модели' }, 'только локальные') : null));
  }

  /* ---------------- экран: карточка проекта ---------------- */

  async function fetchProject(id) {
    const { project } = await api(`/projects/${encodeURIComponent(id)}`);
    return project;
  }

  async function showProject(id) {
    showScreen('project');
    const errBox = $('pj-error');
    errBox.hidden = true;
    $('pj-name').textContent = 'Загрузка…';
    $('pj-sub').textContent = '';
    $('pj-meta').innerHTML = '';
    $('pj-sections').innerHTML = '';
    setCrumbs([{ text: 'Комплекты', href: '#/' }, { text: '…' }]);
    let project;
    try {
      project = state.project = await fetchProject(id);
    } catch (err) {
      $('pj-name').textContent = 'Комплект не открылся';
      errBox.textContent = err.status === 404
        ? 'Такого комплекта нет — возможно, он удалён.'
        : `Не удалось открыть комплект: ${err.message}`;
      errBox.hidden = false;
      return;
    }
    setCrumbs([{ text: 'Комплекты', href: '#/' }, { text: project.name }]);
    $('pj-name').textContent = project.name;
    $('pj-sub').textContent = project.customer ? `Заказчик: ${project.customer}` : 'Состав и версии разделов';

    const meta = $('pj-meta');
    meta.append(
      h('span', { class: 'nm-chip' }, 'стадия ', h('b', {}, project.stage)),
      h('span', { class: 'nm-chip' }, 'объект ', h('b', {}, project.object_kind || '—')),
      h('span', { class: 'nm-chip' }, 'начат ', h('b', {}, fmtDate(project.date_started))));
    if (project.local_only) {
      meta.append(h('span', { class: 'nm-chip', title: 'Документы комплекта не уходят в облачные модели' },
        h('b', {}, 'только локальные модели')));
    }

    const tbody = $('pj-sections');
    $('pj-sections-empty').hidden = (project.sections || []).length > 0;
    for (const s of project.sections || []) {
      const open = Number(s.open_findings) || 0;
      const row = h('tr', {
        class: 'nm-row-link',
        onclick: () => { location.hash = `#/p/${project.id}/s/${s.id}`; },
      },
      h('td', { class: 'nm-code' }, s.code),
      h('td', { class: 'name' }, s.name),
      h('td', {}, s.current_version_id
        ? `№ ${s.current_version_no} от ${fmtDate(s.current_uploaded_at)}`
        : h('span', { class: 'hint' }, 'не загружалась')),
      h('td', {}, s.current_version_id
        ? h('span', { class: `nm-badge ${open ? 'bad' : 'ok'}` }, String(open))
        : h('span', { class: 'nm-badge muted' }, '—')),
      h('td', { class: 'nm-actions' },
        h('button', {
          class: 'btn btn-quiet btn-sm', type: 'button',
          onclick: (e) => { e.stopPropagation(); openUpload(project, s); },
        }, 'Загрузить версию')));
      tbody.append(row);
    }
  }

  /* ---------------- экран: история версий раздела ---------------- */

  async function showSection(projectId, sectionId) {
    showScreen('section');
    const errBox = $('sec-error');
    errBox.hidden = true;
    $('sec-title').textContent = 'Загрузка…';
    $('sec-sub').textContent = '';
    $('sec-versions').innerHTML = '';
    $('sec-diff').hidden = true;
    $('sec-diff-controls').hidden = true;
    setCrumbs([{ text: 'Комплекты', href: '#/' }, { text: '…' }]);

    let project;
    let versions;
    try {
      project = state.project = (state.project && String(state.project.id) === String(projectId))
        ? state.project : await fetchProject(projectId);
      ({ versions } = await api(`/sections/${encodeURIComponent(sectionId)}/versions`));
    } catch (err) {
      $('sec-title').textContent = 'Раздел не открылся';
      errBox.textContent = `Не удалось открыть раздел: ${err.message}`;
      errBox.hidden = false;
      return;
    }
    const section = (project.sections || []).find((s) => String(s.id) === String(sectionId));
    if (!section) {
      $('sec-title').textContent = 'Раздел не найден';
      errBox.textContent = 'Такого раздела в составе комплекта нет — возможно, состав меняли.';
      errBox.hidden = false;
      return;
    }
    setCrumbs([
      { text: 'Комплекты', href: '#/' },
      { text: project.name, href: `#/p/${project.id}` },
      { text: `Раздел ${section.code}` },
    ]);
    $('sec-title').textContent = `${section.code} — ${section.name}`;
    $('sec-sub').textContent = `История версий · комплект «${project.name}»`;
    $('sec-upload').onclick = () => openUpload(project, section);

    const tbody = $('sec-versions');
    $('sec-empty').hidden = versions.length > 0;
    for (const v of versions) {
      const open = Number(v.open_findings) || 0;
      tbody.append(h('tr', {
        class: 'nm-row-link',
        onclick: () => { location.hash = `#/v/${v.id}`; },
      },
      h('td', { class: 'nm-code' }, `№ ${v.version_no}${v.is_current ? ' · актуальная' : ''}`),
      h('td', {}, v.stage),
      h('td', {}, fmtDateTime(v.uploaded_at)),
      h('td', {}, v.author || '—'),
      h('td', {}, h('span', { class: `nm-badge ${open ? 'bad' : 'ok'}` }, String(open))),
      h('td', { class: 'nm-actions' },
        h('button', {
          class: 'btn btn-quiet btn-sm', type: 'button',
          onclick: (e) => { e.stopPropagation(); location.hash = `#/v/${v.id}`; },
        }, 'Открыть'))));
    }

    // сравнение версий: кнопка уже на месте, сервер ответит чуть позже
    if (versions.length >= 2) {
      const from = $('sec-diff-from');
      const to = $('sec-diff-to');
      from.innerHTML = ''; to.innerHTML = '';
      for (const v of versions) {
        from.append(h('option', { value: v.id }, `№ ${v.version_no}`));
        to.append(h('option', { value: v.id }, `№ ${v.version_no}`));
      }
      from.value = versions[1].id; // предпоследняя
      to.value = versions[0].id;   // последняя
      $('sec-diff-controls').hidden = false;
      $('sec-diff-btn').onclick = () => runDiff(sectionId, from.value, to.value);
    }
  }

  async function runDiff(sectionId, from, to) {
    const box = $('sec-diff');
    const body = $('sec-diff-body');
    try {
      const data = await api(`/sections/${encodeURIComponent(sectionId)}/diff?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
      body.innerHTML = '';
      const items = (data && data.diff && data.diff.items) || [];
      if (!items.length) {
        body.append(h('p', { class: 'empty-state' }, 'Отличий между выбранными версиями не найдено.'));
      }
      const KIND = { added: 'добавлено', removed: 'удалено', changed: 'изменено' };
      for (const it of items) {
        if (typeof it === 'string') { body.append(h('div', { class: 'nm-diff-item' }, it)); continue; }
        const locus = it.locus || {};
        const where = [locus.file, locus.para ? `абзац ${locus.para}` : null].filter(Boolean).join(' · ');
        const row = h('div', { class: 'nm-diff-item' },
          h('span', { class: `nm-badge ${it.kind === 'removed' ? 'bad' : it.kind === 'added' ? 'ok' : 'warn'}` },
            KIND[it.kind] || it.kind || '?'),
          ' ', it.summary || '',
          where ? h('p', { class: 'nm-f-loc' }, where) : null);
        if (it.oldText) row.append(h('pre', { class: 'nm-quote' }, `было: ${it.oldText}`));
        if (it.newText) row.append(h('pre', { class: 'nm-quote' }, `стало: ${it.newText}`));
        body.append(row);
      }
      box.hidden = false;
    } catch (err) {
      if (err.status === 404) toast('Сравнение версий появится чуть позже — кнопка уже на месте', 'info');
      else toast(`Сравнение не удалось: ${err.message}`, 'error');
    }
  }

  /* ---------------- экран: версия ---------------- */

  async function showVersion(versionId) {
    showScreen('version');
    const errBox = $('v-error');
    errBox.hidden = true;
    $('v-title').textContent = 'Загрузка…';
    $('v-sub').textContent = '';
    $('v-files').innerHTML = '';
    $('v-findings').innerHTML = '';
    $('v-findings-empty').hidden = true;
    $('v-journal').innerHTML = '';
    $('v-journal-count').textContent = '';
    $('v-counts').innerHTML = '';
    setRunBadge('…', 'muted');
    $('v-run-note').textContent = 'Загрузка…';
    setCrumbs([{ text: 'Комплекты', href: '#/' }, { text: '…' }]);

    let version;
    try {
      ({ version } = await api(`/versions/${encodeURIComponent(versionId)}`));
    } catch (err) {
      $('v-title').textContent = 'Версия не открылась';
      errBox.textContent = err.status === 404
        ? 'Такой версии нет — возможно, её раздел удалили из состава.'
        : `Не удалось открыть версию: ${err.message}`;
      errBox.hidden = false;
      return;
    }
    state.version = version;

    // имя проекта — для пути наверху; ошибка тут не мешает работе с версией
    let project = null;
    try {
      project = (state.project && String(state.project.id) === String(version.project_id))
        ? state.project : await fetchProject(version.project_id);
      state.project = project;
    } catch { /* путь соберём без имени проекта */ }
    setCrumbs([
      { text: 'Комплекты', href: '#/' },
      project ? { text: project.name, href: `#/p/${version.project_id}` } : { text: 'Комплект', href: `#/p/${version.project_id}` },
      { text: `Раздел ${version.section_code}`, href: `#/p/${version.project_id}/s/${version.section_id}` },
      { text: `Версия № ${version.version_no}` },
    ]);
    $('v-title').textContent = `${version.section_code} — версия № ${version.version_no}`;
    const subParts = [
      `стадия ${version.stage}`,
      `загружена ${fmtDateTime(version.uploaded_at)}`,
      version.author ? `автор: ${version.author}` : null,
      version.is_current ? 'актуальная' : 'не актуальная',
    ].filter(Boolean);
    $('v-sub').textContent = subParts.join(' · ') + (version.note ? ` · ${version.note}` : '');

    const files = $('v-files');
    for (const f of version.files || []) {
      const ext = (f.original_name.split('.').pop() || '').slice(0, 6);
      files.append(h('li', { class: 'file-item' },
        h('span', { class: 'file-ext' }, ext),
        h('span', { class: 'name' }, f.original_name),
        h('span', { class: 'meta' }, fmtSize(f.size_bytes))));
    }
    if (!(version.files || []).length) {
      files.append(h('li', { class: 'empty-state' }, 'Файлов в версии нет.'));
    }

    $('v-recheck').onclick = () => recheck(version.id);
    $('v-report').onclick = () => downloadReport(version);
    $('vf-status').onchange = () => loadFindings(version.id);
    $('vf-severity').onchange = () => loadFindings(version.id);

    await Promise.all([loadRun(version.id), loadFindings(version.id)]);
  }

  function setRunBadge(text, kind) {
    const badge = $('v-run-status');
    badge.textContent = text;
    badge.className = `nm-badge nm-run-badge ${kind}`;
  }

  /**
   * Прогон версии. POST /check без force идемпотентен: тот же комплект файлов
   * при том же каталоге правил отдаёт готовый прогон из кэша, не гоняя проверки
   * заново, — поэтому открытие версии им же и получает журнал.
   */
  async function loadRun(versionId, { force = false } = {}) {
    setRunBadge('выполняется…', 'warn');
    $('v-run-note').textContent = force ? 'Проверка запущена заново…' : 'Загрузка прогона…';
    try {
      const started = await api(`/versions/${encodeURIComponent(versionId)}/check`, { method: 'POST', json: force ? { force: true } : {} });
      const { run } = await api(`/runs/${started.runId}`);
      state.run = run;
      renderRun(run, started.cached);
    } catch (err) {
      state.run = null;
      setRunBadge('не выполнен', 'bad');
      $('v-run-note').textContent = err.offline
        ? 'Сервер недоступен — прогон не получен.'
        : `Прогон не получился: ${err.message}`;
      $('v-journal-count').textContent = '';
      $('v-journal').innerHTML = '';
    }
  }

  function renderRun(run, cached) {
    const statusMap = {
      done: ['выполнен', 'ok'],
      running: ['выполняется', 'warn'],
      failed: ['ошибка', 'bad'],
    };
    const [label, kind] = statusMap[run.status] || [run.status, 'muted'];
    setRunBadge(label, kind);
    const journal = run.journal || [];
    const findings = run.findings || [];
    const noteParts = [
      `правил проверено: ${journal.length}`,
      `замечаний в прогоне: ${findings.length}`,
      run.finished_at ? `закончен ${fmtDateTime(run.finished_at)}` : null,
      cached ? 'результат из кэша — комплект файлов и каталог правил не менялись' : null,
    ].filter(Boolean);
    $('v-run-note').textContent = run.status === 'failed' && run.error
      ? `Прогон упал: ${run.error}`
      : noteParts.join(' · ');

    const tbody = $('v-journal');
    tbody.innerHTML = '';
    $('v-journal-count').textContent = journal.length
      ? `${journal.length} ${plural(journal.length, 'правило', 'правила', 'правил')}` : '';
    for (const row of journal) {
      tbody.append(h('tr', {},
        h('td', { class: 'nm-code' }, row.rule_id),
        h('td', { class: `out-${row.outcome}` }, OUT_LABEL[row.outcome] || row.outcome),
        h('td', { class: 'nm-skip-reason' }, row.skip_reason || ''),
        h('td', { class: 'num' }, String(row.duration_ms ?? ''))));
    }
    if (!journal.length) {
      tbody.append(h('tr', {}, h('td', { colspan: '4', class: 'hint' }, 'Журнал пуст.')));
    }
  }

  async function recheck(versionId) {
    const btn = $('v-recheck');
    btn.disabled = true;
    try {
      await loadRun(versionId, { force: true });
      await loadFindings(versionId);
      toast('Проверка выполнена заново');
    } finally {
      btn.disabled = false;
    }
  }

  /* ---------------- замечания ---------------- */

  async function loadFindings(versionId) {
    const box = $('v-findings');
    const empty = $('v-findings-empty');
    const status = $('vf-status').value;
    const severity = $('vf-severity').value;
    const q = new URLSearchParams();
    if (status) q.set('status', status);
    if (severity) q.set('severity', severity);
    try {
      const { findings } = await api(`/versions/${encodeURIComponent(versionId)}/findings${q.toString() ? `?${q}` : ''}`);
      state.findings = findings;
      renderFindings();
    } catch (err) {
      box.innerHTML = '';
      empty.hidden = false;
      empty.textContent = `Замечания не загрузились: ${err.message}`;
    }
  }

  function renderFindings() {
    const box = $('v-findings');
    const empty = $('v-findings-empty');
    const filtered = $('vf-status').value || $('vf-severity').value;
    box.innerHTML = '';

    const counts = $('v-counts');
    counts.innerHTML = '';
    for (const sev of SEVERITIES) {
      const n = state.findings.filter((f) => f.severity === sev).length;
      if (n) counts.append(h('span', { class: `nm-badge sev-${sev}` }, `${SEV_ONE[sev]}: ${n}`));
    }

    if (!state.findings.length) {
      empty.hidden = false;
      empty.textContent = filtered
        ? 'По выбранным фильтрам замечаний нет.'
        : 'Замечаний по этой версии нет — проверка прошла чисто.';
      return;
    }
    empty.hidden = true;

    for (const sev of SEVERITIES) {
      const list = state.findings.filter((f) => f.severity === sev);
      if (!list.length) continue;
      const group = h('div', { class: `nm-group sev-${sev}` },
        h('div', { class: 'nm-group-head' },
          h('span', { class: 'dot', 'aria-hidden': 'true' }),
          `${SEV_LABEL[sev]} — ${list.length}`));
      for (const f of list) group.append(findingCard(f));
      box.append(group);
    }
  }

  function findingCard(f) {
    const card = h('div', { class: `nm-finding sev-${f.severity}${f.status !== 'open' ? ' settled' : ''}` });

    const top = h('div', { class: 'nm-f-top' },
      h('span', { class: 'nm-f-rule' }, f.rule_id),
      h('span', {}, `проверка: ${ORIGIN_LABEL[f.origin] || f.origin}`),
      h('span', {}, VERIF_LABEL[f.verification] || f.verification));
    if (f.confidence !== null && f.confidence !== undefined) {
      top.append(h('span', {}, `уверенность ${Number(f.confidence).toFixed(2)}`));
    }
    top.append(h('span', { class: `nm-badge sev-${f.severity}` }, SEV_ONE[f.severity] || f.severity));
    card.append(top);

    card.append(h('p', { class: 'nm-f-wording' }, f.wording));
    if (f.doc_quote) card.append(h('pre', { class: 'nm-quote' }, f.doc_quote));

    const ntd = h('p', { class: 'nm-f-ntd' }, 'Основание: ', h('b', {}, f.ntd + (f.ntd_clause ? `, п. ${f.ntd_clause}` : '')));
    card.append(ntd);
    if (f.ntd_quote) card.append(h('pre', { class: 'nm-quote' }, f.ntd_quote));

    const loc = f.location && typeof f.location === 'object' ? f.location : null;
    if (loc && Object.keys(loc).length) {
      const parts = Object.entries(loc)
        .filter(([, v]) => v !== null && v !== undefined && v !== '')
        .map(([k, v]) => `${LOC_LABEL[k] || k}: ${v}`);
      if (parts.length) card.append(h('p', { class: 'nm-f-loc' }, parts.join(' · ')));
    }
    if (f.fix_hint) card.append(h('p', { class: 'nm-f-fix' }, f.fix_hint));

    /* решения человека: подтверждение находки и статус работы над ней */
    const confirmBtn = h('button', {
      class: `btn btn-quiet btn-sm${f.verification === 'human_confirmed' ? ' picked' : ''}`,
      type: 'button',
      title: 'Замечание справедливо — подтверждаю',
      onclick: () => patchFinding(f.id, { verification: 'human_confirmed' }),
    }, f.verification === 'human_confirmed' ? 'Подтверждено' : 'Подтвердить');
    const rejectBtn = h('button', {
      class: `btn btn-quiet btn-sm${f.verification === 'human_rejected' ? ' picked-no' : ''}`,
      type: 'button',
      title: 'Проверка ошиблась — замечание снимаю',
      onclick: () => patchFinding(f.id, { verification: 'human_rejected' }),
    }, f.verification === 'human_rejected' ? 'Отклонено' : 'Отклонить');

    const statusSel = h('select', {
      'aria-label': 'Статус замечания',
      onchange: (e) => patchFinding(f.id, { status: e.target.value }),
    });
    for (const [value, label] of Object.entries(STATUS_LABEL)) {
      statusSel.append(h('option', { value, selected: f.status === value }, label));
    }

    card.append(h('div', { class: 'nm-f-controls' },
      confirmBtn, rejectBtn,
      h('span', { class: 'nm-spacer' }),
      h('span', { class: 'nm-f-status-label' }, 'статус:'),
      statusSel));
    return card;
  }

  async function patchFinding(id, body) {
    try {
      const { finding } = await api(`/findings/${id}`, { method: 'PATCH', json: body });
      const i = state.findings.findIndex((f) => String(f.id) === String(id));
      // фильтр по статусу мог перестать пропускать замечание — честнее перечитать список
      const statusFilter = $('vf-status').value;
      if (body.status && statusFilter && body.status !== statusFilter) {
        await loadFindings(state.version.id);
      } else {
        if (i >= 0) state.findings[i] = finding;
        renderFindings();
      }
      toast(body.verification
        ? (body.verification === 'human_confirmed' ? 'Замечание подтверждено' : 'Замечание отклонено человеком')
        : `Статус: ${STATUS_LABEL[body.status] || body.status}`);
    } catch (err) {
      toast(`Не сохранилось: ${err.message}`, 'error');
    }
  }

  /* ---------------- заключение ---------------- */

  async function downloadReport(version) {
    const btn = $('v-report');
    btn.disabled = true;
    try {
      const data = await api(`/versions/${version.id}/reports`, { method: 'POST', json: {} });
      // сервер отдаёт {report:{id,…}}; reportId — запасной вариант из раннего ТЗ
      const reportId = (data.report && data.report.id) || data.reportId;
      const res = await fetch(`/api/normo/reports/${reportId}/file?format=docx`, { headers: userHeaders() });
      if (!res.ok) throw Object.assign(new Error(`Файл не отдан (${res.status})`), { status: res.status });
      const blob = await res.blob();
      saveBlob(blob, `Заключение_${version.section_code}_v${version.version_no}.docx`);
    } catch (err) {
      if (err.status === 404) toast('Заключение появится чуть позже — кнопка уже на месте', 'info');
      else toast(`Заключение не сформировано: ${err.message}`, 'error');
    } finally {
      btn.disabled = false;
    }
  }

  /* ---------------- окно: новый проект ---------------- */

  function openNewProject() {
    $('np-error').hidden = true;
    $('np-form').reset();
    $('np-date').value = new Date().toISOString().slice(0, 10);
    // проект платформы уже знает объект, заказчика и стадию — подставляем
    const pp = window.EnsoShell && window.EnsoShell.project;
    if (pp) {
      $('np-name').value = pp.full_name || pp.name || '';
      $('np-customer').value = pp.client || '';
      if (['П', 'Р', 'П+Р'].includes(pp.stage)) $('np-stage').value = pp.stage;
    }
    $('np-modal').hidden = false;
    setTimeout(() => $('np-name').focus(), 40);
  }
  function closeNewProject() { $('np-modal').hidden = true; }

  async function submitNewProject(e) {
    e.preventDefault();
    const errBox = $('np-error');
    errBox.hidden = true;
    const name = $('np-name').value.trim();
    const dateStarted = $('np-date').value;
    if (!name) { errBox.textContent = 'Дайте комплекту название.'; errBox.hidden = false; $('np-name').focus(); return; }
    if (!dateStarted) { errBox.textContent = 'Укажите дату начала разработки.'; errBox.hidden = false; $('np-date').focus(); return; }
    const btn = $('np-submit');
    btn.disabled = true;
    try {
      const { project } = await api('/projects', {
        method: 'POST',
        json: {
          name,
          platformProjectId: projectId(),
          customer: $('np-customer').value.trim() || undefined,
          stage: $('np-stage').value,
          objectKind: $('np-kind').value,
          dateStarted,
          localOnly: $('np-local').checked,
        },
      });
      closeNewProject();
      toast(`Комплект «${project.name}» создан — разделов в составе: ${(project.sections || []).length}`);
      location.hash = `#/p/${project.id}`;
    } catch (err) {
      errBox.textContent = err.message;
      errBox.hidden = false;
    } finally {
      btn.disabled = false;
    }
  }

  /* ---------------- окно: загрузка версии ---------------- */

  let upFiles = [];

  function openUpload(project, section) {
    state.uploadCtx = { projectId: project.id, section };
    upFiles = [];
    $('up-form').reset();
    $('up-list').innerHTML = '';
    $('up-error').hidden = true;
    $('up-submit').disabled = true;
    $('up-title').textContent = `Загрузить версию — ${section.code} «${section.name}»`;
    // стадия версии по умолчанию — из стадии проекта; у «П+Р» первой идёт П
    $('up-stage').value = project.stage === 'Р' ? 'Р' : 'П';
    const u = window.Auth && window.Auth.user;
    if (u && !$('up-author').value) {
      $('up-author').value = `${u.lastName || ''} ${u.firstName || ''}`.trim();
    }
    $('up-modal').hidden = false;
  }
  function closeUpload() { $('up-modal').hidden = true; state.uploadCtx = null; }

  function acceptFiles(list) {
    const next = [...upFiles, ...list];
    if (next.length > 40) {
      $('up-error').textContent = 'Не больше 40 файлов в одной версии.';
      $('up-error').hidden = false;
      return;
    }
    $('up-error').hidden = true;
    upFiles = next;
    renderUpList();
  }

  function renderUpList() {
    const ul = $('up-list');
    ul.innerHTML = '';
    upFiles.forEach((f, i) => {
      const ext = (f.name.split('.').pop() || '').slice(0, 6);
      ul.append(h('li', { class: 'file-item' },
        h('span', { class: 'file-ext' }, ext),
        h('span', { class: 'name' }, f.name),
        h('span', { class: 'meta' }, fmtSize(f.size)),
        h('button', {
          class: 'icon-btn', type: 'button', 'aria-label': `Убрать ${f.name}`,
          onclick: () => { upFiles.splice(i, 1); renderUpList(); },
        }, '×')));
    });
    $('up-submit').disabled = !upFiles.length;
  }

  async function submitUpload(e) {
    e.preventDefault();
    if (!state.uploadCtx || !upFiles.length) return;
    const { projectId, section } = state.uploadCtx;
    const errBox = $('up-error');
    errBox.hidden = true;
    const btn = $('up-submit');
    btn.disabled = true;
    btn.textContent = 'Загружается…';
    try {
      const fd = new FormData();
      for (const f of upFiles) fd.append('files', f, f.name);
      fd.append('stage', $('up-stage').value);
      if ($('up-author').value.trim()) fd.append('author', $('up-author').value.trim());
      if ($('up-note').value.trim()) fd.append('note', $('up-note').value.trim());
      const data = await api(`/projects/${encodeURIComponent(projectId)}/sections/${encodeURIComponent(section.code)}/versions`, {
        method: 'POST',
        body: fd,
      });
      closeUpload();
      const check = data.check || {};
      if (check.error) {
        toast(`Версия № ${data.version.version_no} загружена, но проверка не запустилась: ${check.error}`, 'error');
      } else {
        toast(`Версия № ${data.version.version_no} загружена, проверка ${check.cached ? 'взята из кэша' : 'выполнена'}`);
      }
      state.project = null; // счётчики раздела изменились — перечитать при возврате
      location.hash = `#/v/${data.version.id}`;
      if (state.route.name === 'version' && String(state.route.versionId) === String(data.version.id)) route();
    } catch (err) {
      errBox.textContent = err.message;
      errBox.hidden = false;
    } finally {
      btn.disabled = !upFiles.length;
      btn.textContent = 'Загрузить и проверить';
    }
  }

  /* ---------------- кто вошёл ---------------- */

  function renderUserBox() {
    // блок человека теперь рисует общий каркас (shell.js)
    if (window.EnsoShell) window.EnsoShell.renderUser();
  }

  /* ---------------- запуск ---------------- */

  function wireStatic() {
    $('nm-new-project').addEventListener('click', openNewProject);
    $('np-form').addEventListener('submit', submitNewProject);
    $('np-close').addEventListener('click', closeNewProject);
    $('np-cancel').addEventListener('click', closeNewProject);
    $('np-modal').addEventListener('click', (e) => { if (e.target === $('np-modal')) closeNewProject(); });

    $('up-form').addEventListener('submit', submitUpload);
    $('up-close').addEventListener('click', closeUpload);
    $('up-cancel').addEventListener('click', closeUpload);
    $('up-modal').addEventListener('click', (e) => { if (e.target === $('up-modal')) closeUpload(); });

    const dz = $('up-dropzone');
    const input = $('up-files');
    dz.addEventListener('click', () => input.click());
    dz.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
    input.addEventListener('change', () => { acceptFiles([...input.files]); input.value = ''; });
    dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('dragover'); });
    dz.addEventListener('dragleave', () => dz.classList.remove('dragover'));
    dz.addEventListener('drop', (e) => {
      e.preventDefault();
      dz.classList.remove('dragover');
      if (e.dataTransfer && e.dataTransfer.files) acceptFiles([...e.dataTransfer.files]);
    });

    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (!$('np-modal').hidden) closeNewProject();
      else if (!$('up-modal').hidden) closeUpload();
    });

    window.addEventListener('hashchange', route);
  }

  async function init() {
    window.Auth.init();
    await window.Auth.start();
    renderUserBox();
    if (window.EnsoShell) await window.EnsoShell.start();
    wireStatic();
    // /health идёт ПЕРВЫМ и дожидается ответа: схема БД модуля разворачивается
    // лениво при первом запросе, и два параллельных первых запроса устраивают
    // гонку миграции (CREATE EXTENSION падает на 23505). Один запрос вперёд —
    // и остальным миграция уже не нужна.
    await loadHealth();
    await route();
  }

  document.addEventListener('DOMContentLoaded', init);
}());
