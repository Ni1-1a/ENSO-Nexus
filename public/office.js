'use strict';
/**
 * «Виртуальный офис» — оркестратор страницы: данные, панель-«бумага»,
 * чат с секретарём и агентами, звук зала и голос, опрос платформы раз в 10 с.
 * Сцена — office-scene.js, игры — office-games.js.
 */

import { OfficeScene } from './office-scene.js?v=5';
import { RubikApp, ChessApp, GoApp } from './office-games.js?v=5';

const $ = (id) => document.getElementById(id);
const D = window.OfficeData;

/** имя для обращения: у /auth/me поля lastName/firstName, name нет */
function userFirstName() {
  const u = state.user;
  if (!u) return '';
  return u.firstName || String(u.name || '').split(' ').slice(-1)[0] || '';
}

/* ---------------- состояние ---------------- */

const state = {
  token: '', user: null,
  projectId: new URLSearchParams(location.search).get('project')
    || localStorage.getItem('enso-office-project') || '',
  tv: new URLSearchParams(location.search).get('tv') === '1',
  data: null,
  scene: null,
  apps: {},
  dock: { context: null, tab: 'info' },
  sound: false,
  walk: false,
  paused: false,
  factIndex: {},
  visited: false,
};

function authHeaders() {
  return state.token ? { 'X-User-Token': state.token } : {};
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { ...(opts.headers || {}), ...authHeaders() },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Сервер ответил ${res.status}`);
  return data;
}

function toast(text, ms = 3200) {
  const el = $('office-toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.hidden = true; }, ms);
}

/* ---------------- звук зала ---------------- */

const Sound = {
  ctx: null, ambient: null,
  ensure() {
    if (this.ctx) return;
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    // эмбиент: шум вентиляции + низкий гул
    const noise = this.ctx.createBufferSource();
    const len = this.ctx.sampleRate * 2;
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const ch = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      last = last * 0.97 + (Math.random() * 2 - 1) * 0.03;
      ch[i] = last * 3;
    }
    noise.buffer = buf; noise.loop = true;
    // фон офиса: очень тихий низкий гул вентиляции, без «самолёта» (было 420 Гц / 0.05)
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 140;
    const gain = this.ctx.createGain();
    gain.gain.value = 0.012;
    noise.connect(lp).connect(gain).connect(this.ctx.destination);
    noise.start();
    this.ambient = gain;
  },
  setOn(on) {
    if (on) { this.ensure(); this.ctx.resume(); this.ambient.gain.value = 0.012; }
    else if (this.ambient) this.ambient.gain.value = 0;
  },
  step() {
    if (!state.sound || !this.ctx) return;
    const t = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    const len = Math.floor(this.ctx.sampleRate * 0.08);
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < len; i++) ch[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
    src.buffer = buf;
    const lp = this.ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 700 + Math.random() * 300;
    const g = this.ctx.createGain(); g.gain.value = 0.07;
    src.connect(lp).connect(g).connect(this.ctx.destination);
    src.start(t);
  },
  click() {
    if (!state.sound || !this.ctx) return;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.value = 1800 + Math.random() * 900;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.012 + Math.random() * 0.008, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.03);
    osc.connect(g).connect(this.ctx.destination);
    osc.start(t); osc.stop(t + 0.035);
  },
};

function speak(text) {
  if (!state.sound || !('speechSynthesis' in window)) return;
  try {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'ru-RU';
    const voice = speechSynthesis.getVoices().find((v) => v.lang.startsWith('ru'));
    if (voice) u.voice = voice;
    u.rate = 1.02; u.pitch = 1.05;
    speechSynthesis.speak(u);
  } catch { /* голоса может не быть — зал не немеет, текст всегда виден */ }
}

/* ---------------- панель-«бумага» ---------------- */

function openDock(context) {
  state.dock.context = context;
  $('dock').hidden = false;
  $('dock').classList.add('open');
  setTab(context.defaultTab || 'info');
  $('dock-title').textContent = context.title || 'Зал';
  $('dock-sub').textContent = context.sub || '';
  renderInfo();
  renderHistory();
  loadChat();
}

function closeDock() {
  $('dock').classList.remove('open');
  state.dock.context = null;
}

function setTab(tab) {
  state.dock.tab = tab;
  for (const b of $('dock-tabs').querySelectorAll('[role="tab"]')) {
    b.setAttribute('aria-selected', String(b.dataset.tab === tab));
  }
  for (const pane of document.querySelectorAll('.dock-pane')) pane.classList.remove('active');
  $(`dock-${tab}`).classList.add('active');
}

function esc(s) {
  const div = document.createElement('div');
  div.textContent = String(s ?? '');
  return div.innerHTML;
}

function stateDot(s) { return `<span class="dot st-${esc(s || 'none')}"></span>`; }

/* --- вкладка «Информация» --- */

function renderInfo() {
  const ctx = state.dock.context;
  const el = $('dock-info');
  if (!ctx) { el.innerHTML = ''; return; }
  el.innerHTML = ctx.renderInfo ? ctx.renderInfo() : '';
  if (ctx.afterInfo) ctx.afterInfo(el);
}

/* --- вкладка «История» --- */

function renderHistory() {
  const ctx = state.dock.context;
  const el = $('dock-history');
  el.innerHTML = ctx && ctx.renderHistory ? ctx.renderHistory() : '<p class="muted">Здесь пока пусто.</p>';
  if (ctx && ctx.afterHistory) ctx.afterHistory(el);
}

/* --- вкладка «Чат» --- */

async function loadChat() {
  const ctx = state.dock.context;
  const log = $('chat-log');
  if (!ctx || !ctx.chatKind) {
    log.innerHTML = '<p class="muted">У этого предмета нет собеседника — загляните в «Информацию».</p>';
    $('chat-form').hidden = true;
    return;
  }
  $('chat-form').hidden = false;
  log.innerHTML = '<p class="muted">Загружаю беседу…</p>';
  try {
    const res = await api(`/api/office/chat?kind=${encodeURIComponent(ctx.chatKind)}&project=${encodeURIComponent(state.projectId)}`);
    log.innerHTML = '';
    for (const m of res.messages) appendChat(m.role, m.content, m.model);
    if (!res.messages.length && ctx.chatHello) appendChat('assistant', ctx.chatHello);
  } catch (err) {
    log.innerHTML = `<p class="muted">${esc(err.message)}</p>`;
  }
}

function appendChat(role, content, model = '') {
  const log = $('chat-log');
  const div = document.createElement('div');
  div.className = `chat-msg ${role}`;
  div.textContent = content;
  if (model && role === 'assistant') {
    const meta = document.createElement('div');
    meta.className = 'chat-meta';
    meta.textContent = model;
    div.appendChild(meta);
  }
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
  return div;
}

async function sendChat(text) {
  const ctx = state.dock.context;
  if (!ctx || !ctx.chatKind) return;
  appendChat('user', text);
  const busy = appendChat('assistant', 'думает…');
  busy.classList.add('busy');
  try {
    const res = await api('/api/office/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: ctx.chatKind, projectId: state.projectId, message: text }),
    });
    busy.classList.remove('busy');
    busy.textContent = res.reply;
    const meta = document.createElement('div');
    meta.className = 'chat-meta';
    meta.textContent = [res.provider, res.model].filter(Boolean).join(' · ');
    busy.appendChild(meta);
    if (ctx.chatKind === 'concierge') speak(res.reply);
  } catch (err) {
    busy.classList.remove('busy');
    busy.textContent = `Не получилось: ${err.message}`;
  }
}

/* ---------------- контексты панели ---------------- */

function factBlock(topic) {
  const facts = D.facts[topic] || [];
  if (!facts.length) return '';
  const i = state.factIndex[topic] || 0;
  return `
    <h3>Интересный факт</h3>
    <div class="dock-fact" id="fact-text">${esc(facts[i % facts.length])}</div>
    <div class="dock-actions">
      <button class="btn" id="fact-next" type="button">Ещё факт</button>
      <button class="btn" id="fact-ai" type="button">Спросить модель</button>
    </div>`;
}

function wireFacts(el, topic) {
  const next = el.querySelector('#fact-next');
  if (next) next.onclick = () => {
    state.factIndex[topic] = (state.factIndex[topic] || 0) + 1;
    el.querySelector('#fact-text').textContent = D.facts[topic][state.factIndex[topic] % D.facts[topic].length];
  };
  const ai = el.querySelector('#fact-ai');
  if (ai) ai.onclick = () => {
    setTab('chat');
    $('chat-input').value = 'Расскажи что-нибудь новое по этой теме';
    $('chat-form').requestSubmit();
  };
}

function agentContext(module) {
  const persona = (state.data && state.data.personas.agents.find((p) => p.module === module)) || { name: module, role: '', blurb: '', skills: [] };
  return {
    title: persona.name,
    sub: `${persona.role} · модуль «${D.moduleNames[module]}»`,
    chatKind: `agent:${module}`,
    chatHello: `Здравствуйте! Я ${persona.name}, ${persona.role.toLowerCase()}. Спрашивайте про мой модуль.`,
    renderInfo() {
      const s = state.data && state.data.modules ? state.data.modules[module] : null;
      return `
        <p>${esc(persona.blurb)}</p>
        <h3>Навыки</h3>
        <ul class="dock-chips">${persona.skills.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
        <h3>Состояние модуля</h3>
        <div class="mod-state"><div class="row">${stateDot(s && s.state)}<span class="ln">${esc(s ? s.line : 'проект не выбран')}</span></div></div>
        <div id="agent-prompts"><p class="muted">Загружаю промты роли…</p></div>`;
    },
    afterInfo(el) {
      api(`/api/office/agent/${module}?project=${encodeURIComponent(state.projectId)}`).then((res) => {
        const box = el.querySelector('#agent-prompts');
        if (!box) return;
        if (!res.promptFiles.length) { box.innerHTML = '<p class="muted">У этой роли нет открытых промтов — её ведёт детерминированный код.</p>'; return; }
        box.innerHTML = '<h3>Промты роли</h3>' + res.promptFiles.map((f) =>
          `<p class="muted">${esc(f.name)} · ${f.length} знаков</p><div class="dock-prompt">${esc(f.excerpt)}${f.length > f.excerpt.length ? '…' : ''}</div>`).join('');
      }).catch(() => {});
    },
    renderHistory() {
      const j = (state.data && state.data.journal) || [];
      if (module !== 'site' || !j.length) return '<p class="muted">Журнал ведёт модуль «Посадка здания» — у остальных история в самих модулях.</p>';
      return `<ul class="dock-journal">${j.map((e) =>
        `<li class="${esc(e.level)}"><span class="t">${esc(new Date(e.at).toLocaleTimeString('ru-RU'))}</span>${esc(e.stage)}: ${esc(e.detail || '')}</li>`).join('')}</ul>`;
    },
  };
}

function screenContext() {
  return {
    title: 'Центральный экран',
    sub: state.data && state.data.project ? state.data.project.name : 'проект не выбран',
    chatKind: 'concierge',
    renderInfo() {
      const d = state.data;
      if (!d || !d.modules) return '<p class="muted">Выберите проект в лобби — сводка появится здесь и на экране.</p>';
      const rows = Object.keys(D.moduleNames).map((m) => {
        const s = d.modules[m] || { state: 'none', line: '' };
        return `<div class="row">${stateDot(s.state)}<span class="nm">${esc(D.moduleNames[m])}</span><span class="ln">${esc(s.line)}</span></div>`;
      }).join('');
      const money = d.stats ? `<h3>Расход за 30 дней</h3><p>$${d.stats.costUsd.toFixed(2)} · ${d.stats.requests} обращений · ${Math.round(d.stats.tokens / 1000)}k токенов</p>` : '';
      const bal = (d.balances || []).map((b) => `<div class="row"><span class="nm">${esc(b.label)}</span><span class="ln">${b.availableUsd === null ? esc(b.note || '—') : '$' + Number(b.availableUsd).toFixed(2)}</span></div>`).join('');
      return `<h3>Модули проекта</h3><div class="mod-state">${rows}</div>${money}
        ${bal ? `<h3>Счета моделей</h3><div class="mod-state">${bal}</div>` : ''}`;
    },
    renderHistory() {
      const j = (state.data && state.data.journal) || [];
      if (!j.length) return '<p class="muted">Событий пока нет.</p>';
      return `<ul class="dock-journal">${j.map((e) =>
        `<li class="${esc(e.level)}"><span class="t">${esc(new Date(e.at).toLocaleTimeString('ru-RU'))}</span>${esc(e.stage)}: ${esc(e.detail || '')}</li>`).join('')}</ul>`;
    },
  };
}

function tableContext(extra = null) {
  return {
    title: 'Стол проекта',
    sub: 'участок, зоны и варианты посадки',
    chatKind: 'concierge',
    renderInfo() {
      const g = state.data && state.data.geometry;
      if (!g || !g.parcel) return '<p class="muted">План появится, когда модуль «Посадка здания» разберёт чертёж проекта.</p>';
      const zoneRows = (g.zones || []).slice(0, 12).map((z) => {
        const st = window.ZoneStyle.zone(z.kind);
        return `<div class="row"><span class="dot" style="background:${st.color}"></span><span class="ln">${esc(st.label)} · ${esc(z.label)}${z.areaM2 ? ` · ${z.areaM2} м²` : ''}</span></div>`;
      }).join('');
      const run = g.run;
      const variants = run ? run.variants.map((v) =>
        `<button class="btn${v.id === (state.varId || (run.variants.find((x) => x.selected) || run.variants[0] || {}).id) ? ' btn-primary' : ''}" data-variant="${esc(v.id)}" type="button">№${v.number}${v.floors ? ` · ${v.floors} эт.` : ''}</button>`).join('') : '';
      return `
        <dl class="dock-kv">
          <dt>Участок</dt><dd>${g.parcel.areaM2 ? g.parcel.areaM2 + ' м²' : 'площадь не посчитана'}</dd>
          <dt>Зон ограничений</dt><dd>${(g.zones || []).length}</dd>
          <dt>Допустимая территория</dt><dd>${g.buildable && g.buildable.areaM2 ? g.buildable.areaM2 + ' м²' + (g.buildable.sharePercent !== null && g.buildable.sharePercent !== undefined ? ` (${g.buildable.sharePercent}% участка)` : '') : 'не посчитана'}</dd>
        </dl>
        ${extra ? `<h3>Выбранный объект</h3><p>${esc(extra)}</p>` : ''}
        ${variants ? `<h3>Варианты посадки</h3><div class="dock-actions">${variants}</div>` : ''}
        ${zoneRows ? `<h3>Зоны на столе</h3><div class="mod-state">${zoneRows}</div>` : ''}`;
    },
    afterInfo(el) {
      for (const b of el.querySelectorAll('[data-variant]')) {
        b.onclick = () => {
          state.varId = b.dataset.variant;
          state.scene.setVariant(state.varId);
          renderInfo();
        };
      }
    },
    renderHistory() {
      const g = state.data && state.data.geometry;
      if (!g || !g.run) return '<p class="muted">Запусков подбора ещё не было.</p>';
      return `<div class="h-item"><span class="t">${esc(new Date(g.run.createdAt).toLocaleString('ru-RU'))}</span><br>
        Подбор вариантов: ${g.run.variants.length} шт., критерий «${esc(g.run.criterion || 'по умолчанию')}»</div>`;
    },
  };
}

function secretaryContext() {
  const s = D.greetings;
  const name = userFirstName();
  return {
    title: (state.data ? state.data.personas.secretary.name : 'Секретарь'),
    sub: 'администратор зала',
    chatKind: 'concierge',
    defaultTab: 'chat',
    chatHello: (state.user ? s.named : s.guest).replace('{name}', name),
    renderInfo() {
      return `<p>${esc(state.data ? state.data.personas.secretary.blurb : '')}</p>
        <div class="dock-actions">
          <button class="btn" id="sec-project" type="button">Сменить проект</button>
          <button class="btn" id="sec-tour" type="button">Показать зал</button>
        </div>`;
    },
    afterInfo(el) {
      el.querySelector('#sec-project').onclick = showProjectPick;
      el.querySelector('#sec-tour').onclick = () => { closeDock(); setView('hall'); state.scene.goTo('hall'); };
    },
  };
}

function posterContext(info) {
  const p = D.posters[info.id] || { title: 'Постер', text: '' };
  return {
    title: p.title,
    sub: info.series === 'mech' ? 'серия «Механика» · чёрный фон, красная рама' : 'серия «Кодекс» · сепия и зеркальное письмо',
    chatKind: null,
    renderInfo() {
      return `<p>${esc(p.text)}</p><p class="muted">Композиция построена по золотому сечению: предмет стоит в точке φ, рама — прямоугольник 1 : 1,618.</p>`;
    },
  };
}

function bookContext(info) {
  const bases = (info.bases || []).map((b) => (b === 'verified' ? 'верифицированная' : 'общая')).join(', ');
  return {
    title: info.name,
    sub: `норматив базы знаний · ${info.chunks} фрагментов`,
    chatKind: null,
    renderInfo() {
      return `<p>Этот корешок — настоящий документ базы знаний платформы: по нему ищут выдержки нормоконтроль, «Проверка документа» и извлечение ограничений.</p>
        <dl class="dock-kv"><dt>Фрагментов</dt><dd>${info.chunks}</dd><dt>База</dt><dd>${esc(bases || 'общая')}</dd></dl>
        <p class="muted">Толщина корешка на полке пропорциональна числу фрагментов.</p>`;
    },
  };
}

function placeContext(p, topic) {
  const more = D.facts_more[topic] || [];
  return {
    title: p.title,
    sub: p.sub,
    chatKind: null,
    renderInfo() {
      const i = state.factIndex[topic] || 0;
      return `<p>${esc(p.text)}</p>${more.length ? `<h3>Интересный факт</h3><div class="dock-fact" id="fact-text">${esc(more[i % more.length])}</div>
        <div class="dock-actions"><button class="btn" id="fact-next" type="button">Ещё факт</button></div>` : ''}`;
    },
    afterInfo(el) {
      const next = el.querySelector('#fact-next');
      if (next) next.onclick = () => { state.factIndex[topic] = (state.factIndex[topic] || 0) + 1; el.querySelector('#fact-text').textContent = more[state.factIndex[topic] % more.length]; };
    },
  };
}

function plaqueContext(index) {
  const pl = D.plaques[index] || { title: '', sub: '' };
  return {
    title: pl.title,
    sub: 'табличка лобби',
    renderInfo() { return `<p>${esc(pl.sub)}</p><p class="muted">Все цифры — настоящие: их держат тесты и журнал платформы.</p>`; },
  };
}

/* --- предметы и игры --- */

function itemContext(item) {
  const meta = D.items[item] || { title: item, sub: '', topic: null };
  const base = {
    title: meta.title,
    sub: meta.sub,
    chatKind: meta.topic ? `feature:${meta.topic}` : null,
    chatHello: 'Нажмите «Спросить модель» во вкладке «Информация» — расскажу новое.',
  };

  if (item === 'cube') {
    return {
      ...base,
      renderInfo() {
        const app = state.apps.cube;
        const sol = app ? app.solution : [];
        const at = app ? app.solutionAt : 0;
        const steps = sol.length
          ? `<h3>Сборка (${at} из ${sol.length})</h3><p class="cube-steps">${sol.map((m, i) => i === at ? `<b>${esc(m)}</b>` : esc(m)).join(' ')}</p>
             <div class="dock-actions"><button class="btn btn-primary" id="cube-step" type="button">Следующий ход</button></div>`
          : '';
        return `
          <p>Настоящий эмулятор: крутите гранями, запутайте — и стол соберёт его алгоритмом Коцембы, показывая каждый ход.</p>
          <div class="game-toolbar">
            <button class="btn" id="cube-scramble" type="button">Запутать</button>
            <button class="btn btn-primary" id="cube-solve" type="button">Как собрать?</button>
            <button class="btn" id="cube-reset" type="button">Собранный</button>
          </div>
          <div class="game-toolbar">
            ${['U', "U'", 'D', "D'", 'L', "L'", 'R', "R'", 'F', "F'", 'B', "B'"].map((m) => `<button class="btn" data-cube-move="${m}" type="button">${m}</button>`).join('')}
          </div>
          ${steps}
          ${factBlock('cube')}`;
      },
      afterInfo(el) {
        const app = ensureCube();
        el.querySelector('#cube-scramble').onclick = () => { app.scramble(); renderInfo(); };
        el.querySelector('#cube-reset').onclick = () => { app.reset(); renderInfo(); };
        el.querySelector('#cube-solve').onclick = async () => {
          toast('Считаю сборку — первый раз солвер готовится несколько секунд…');
          await app.solve();
          renderInfo();
        };
        const step = el.querySelector('#cube-step');
        if (step) step.onclick = () => { app.stepNext(); renderInfo(); };
        for (const b of el.querySelectorAll('[data-cube-move]')) {
          b.onclick = () => { app.manual(b.dataset.cubeMove); renderInfo(); };
        }
        wireFacts(el, 'cube');
      },
      renderHistory() { return '<p class="muted">У кубика вместо истории — факты во вкладке «Информация».</p>'; },
    };
  }

  if (item === 'chess') {
    return {
      ...base,
      renderInfo() {
        const app = state.apps.chess;
        const replayControls = app && app.mode === 'replay'
          ? `<div class="dock-actions">
              <button class="btn" id="ch-prev" type="button">← ход</button>
              <button class="btn btn-primary" id="ch-next" type="button">ход →</button>
              <button class="btn" id="ch-exit" type="button">К игре</button>
            </div><p>${esc(app.replay.game.story)}</p>`
          : '';
        return `
          <p>Доска как в маковских «Шахматах»: дерево, объём, движок отвечает за чёрных. Кликните по своей фигуре на столе — и по клетке хода.</p>
          <p class="game-status">${esc(app ? app.status() : 'Кликните по доске на столе')}</p>
          <div class="game-toolbar">
            <button class="btn" id="ch-new" type="button">Новая партия</button>
            <button class="btn" id="ch-undo" type="button">Отменить ход</button>
          </div>
          ${replayControls}
          ${factBlock('chess')}`;
      },
      afterInfo(el) {
        const app = ensureChess();
        el.querySelector('#ch-new').onclick = () => app.newGame();
        el.querySelector('#ch-undo').onclick = () => app.undo();
        const prev = el.querySelector('#ch-prev');
        if (prev) prev.onclick = () => app.replayStep(-1);
        const next = el.querySelector('#ch-next');
        if (next) next.onclick = () => app.replayStep(1);
        const exit = el.querySelector('#ch-exit');
        if (exit) exit.onclick = () => app.newGame();
        wireFacts(el, 'chess');
      },
      renderHistory() {
        return `<p class="muted">Знаменитые партии: с ходами — проигрываются на доске, остальные — истории.</p>
          <ul class="game-list">${D.chessGames.map((game) =>
            `<li data-game="${esc(game.id)}"><b>${esc(game.title)}</b> ${game.moves ? '· ▸ на доске' : ''}<span class="sub">${esc(game.players)} · ${esc(game.year)}</span></li>`).join('')}</ul>`;
      },
      afterHistory(el) {
        for (const li of el.querySelectorAll('[data-game]')) {
          li.onclick = () => {
            const game = D.chessGames.find((x) => x.id === li.dataset.game);
            if (game.moves) {
              ensureChess().startReplay(game);
              setTab('info');
              renderInfo();
              state.scene.focusAnchor('chess');
            } else {
              setTab('info');
              $('dock-info').innerHTML = `<h3>${esc(game.title)}</h3><p class="muted">${esc(game.players)} · ${esc(game.year)}</p><p>${esc(game.story)}</p>${factBlock('chess')}`;
              wireFacts($('dock-info'), 'chess');
            }
          };
        }
      },
    };
  }

  if (item === 'go') {
    return {
      ...base,
      renderInfo() {
        const app = state.apps.go;
        return `
          <p>Доска 9×9: вы чёрными, бот белыми. Кликайте по пересечениям на столе. Пас завершает игру и считает очки.</p>
          <p class="game-status">${esc(app ? app.status() : 'Кликните по доске на столе')}</p>
          <div class="game-toolbar">
            <button class="btn" id="go-new" type="button">Новая игра</button>
            <button class="btn" id="go-pass" type="button">Пас</button>
          </div>
          ${factBlock('go')}`;
      },
      afterInfo(el) {
        const app = ensureGo();
        el.querySelector('#go-new').onclick = () => app.newGame();
        el.querySelector('#go-pass').onclick = () => app.pass();
        wireFacts(el, 'go');
      },
      renderHistory() {
        return `<ul class="game-list">${D.goGames.map((g) =>
          `<li data-go-game="${esc(g.id)}"><b>${esc(g.title)}</b><span class="sub">${esc(g.players)} · ${esc(g.year)}</span></li>`).join('')}</ul>`;
      },
      afterHistory(el) {
        for (const li of el.querySelectorAll('[data-go-game]')) {
          li.onclick = () => {
            const g = D.goGames.find((x) => x.id === li.dataset.goGame);
            setTab('info');
            $('dock-info').innerHTML = `<h3>${esc(g.title)}</h3><p class="muted">${esc(g.players)} · ${esc(g.year)}</p><p>${esc(g.story)}</p>${factBlock('go')}`;
            wireFacts($('dock-info'), 'go');
          };
        }
      },
    };
  }

  // чай, кульман, макет, нивелир — информация + факты
  return {
    ...base,
    renderInfo() {
      const blurbs = {
        tea: `<p>${esc(state.data ? state.data.personas.teaMaster.name : 'Мастер')} заваривает улун по всем правилам гунфу-ча. Присаживайтесь — и спросите его о чае.</p>`,
        drafting: '<p>Кульман с чертежом ГПЗУ — так сажали здания до платформы. Сегодня то же самое делает модуль «Посадка здания», только за минуты и с провенансом каждого числа.</p>',
        model: '<p>Макет АВИВАК-2 — пилот платформы. Двухэтажный корпус прошёл посадку ступенчатой формой: 9 из 9 конфигураций в «Варианте 3.1».</p>',
        level: '<p>Нивелир на штативе — напоминание, откуда берутся высоты в проекте: от нуля Кронштадтского футштока.</p>',
      };
      return (blurbs[item] || '') + factBlock(meta.topic);
    },
    afterInfo(el) { wireFacts(el, meta.topic); },
  };
}

/* ---------------- игры ---------------- */

function ensureCube() {
  if (!state.apps.cube) {
    const anchor = state.scene.itemAnchors.get('cube');
    state.apps.cube = new RubikApp(anchor.group, state.scene.pickables);
    state.apps.cube.onState = () => { if (state.dock.context && state.dock.context.title === D.items.cube.title) { /* панель перерисует renderInfo по действию */ } };
  }
  return state.apps.cube;
}

function ensureChess() {
  if (!state.apps.chess) {
    const anchor = state.scene.itemAnchors.get('chess');
    state.apps.chess = new ChessApp(anchor.group, state.scene.pickables);
    state.apps.chess.onState = () => {
      if (state.dock.context && state.dock.context.chatKind === 'feature:chess') renderInfo();
    };
  }
  return state.apps.chess;
}

function ensureGo() {
  if (!state.apps.go) {
    const anchor = state.scene.itemAnchors.get('go');
    state.apps.go = new GoApp(anchor.group, state.scene.pickables);
    state.apps.go.onState = () => {
      if (state.dock.context && state.dock.context.chatKind === 'feature:go') renderInfo();
    };
  }
  return state.apps.go;
}

/* ---------------- выбор проекта ---------------- */

async function showProjectPick() {
  const box = $('project-pick');
  const list = $('pp-list');
  box.hidden = false;
  list.innerHTML = '<p class="pp-note">Загружаю проекты…</p>';
  $('pp-empty').hidden = true;
  if (!state.token) {
    list.innerHTML = '';
    $('pp-empty').hidden = false;
    return;
  }
  try {
    const res = await api('/api/projects');
    const projects = res.projects || res.list || [];
    list.innerHTML = '';
    if (!projects.length) { $('pp-empty').hidden = false; return; }
    for (const p of projects) {
      const b = document.createElement('button');
      b.type = 'button';
      b.innerHTML = `${esc(p.name)}<span class="sub">${esc([p.client, p.stage].filter(Boolean).join(' · ') || 'проект платформы')}</span>`;
      b.onclick = () => {
        box.hidden = true;
        setProject(p.id, p.name);
      };
      list.appendChild(b);
    }
  } catch (err) {
    list.innerHTML = `<p class="pp-note">${esc(err.message)}</p>`;
  }
}

function setProject(id, name) {
  state.projectId = id;
  localStorage.setItem('enso-office-project', id);
  const url = new URL(location.href);
  url.searchParams.set('project', id);
  history.replaceState(null, '', url);
  $('ob-project').textContent = name || 'проект';
  refresh(true);
  toast(`Открываю «${name}» — сводка на центральном экране`);
  speak(`Открываю проект ${name}`);
}

/* ---------------- данные ---------------- */

async function refresh(force = false) {
  try {
    const data = await api(`/api/office/scene?project=${encodeURIComponent(state.projectId)}`);
    state.data = data;
    if (data.project) $('ob-project').textContent = data.project.name;
    state.scene.setSceneData(data);
    if (state.dock.context) { renderInfo(); }
  } catch (err) {
    if (/не найден/i.test(err.message) && state.projectId) {
      // проект закрыт для этого посетителя — честно падаем в режим без проекта
      state.projectId = '';
      localStorage.removeItem('enso-office-project');
      refresh();
      return;
    }
    if (force) toast(err.message);
  }
}

/* ---------------- вход и пролёт ---------------- */

async function pickupAuth() {
  try {
    const saved = JSON.parse(localStorage.getItem('enso-pilot1-auth') || 'null');
    if (saved && saved.token) {
      const res = await fetch('/api/auth/me', { headers: { 'X-User-Token': saved.token } });
      if (res.ok) {
        const data = await res.json();
        if (data.status === 'active') {
          state.token = saved.token;
          state.user = data.user;
        }
      }
    }
  } catch { /* гость */ }
}

/**
 * Вход: секретарь здоровается в лобби, дальше человек идёт сам.
 * Вступительный пролёт камеры убран по решению владельца 10.09.2026 —
 * он отнимал семь секунд у каждого показа и мешал сразу осмотреться.
 */
async function runIntroFlight(withGreeting = true) {
  const hint = $('intro-hint');
  state.scene.goTo('lobby', 0);
  setView('lobby');
  if (withGreeting) {
    state.scene.wave(3);
    const text = (state.user ? D.greetings.named : D.greetings.guest).replace('{name}', userFirstName());
    $('intro-text').textContent = text;
    hint.hidden = false;
    speak(text);
    setTimeout(() => { hint.hidden = true; }, 6000);
  } else {
    hint.hidden = true;
  }
}

function setView(view) {
  for (const b of document.querySelectorAll('.ob-views button')) {
    b.classList.toggle('active', b.dataset.goto === view);
  }
}

/* ---------------- прогулка ---------------- */

function setWalk(on) {
  state.walk = on;
  state.scene.setWalk(on);
  $('ob-walk').setAttribute('aria-pressed', String(on));
  $('ob-walk').querySelector('use').setAttribute('href', on ? '#i-orbit' : '#i-walk');
  $('walk-hint').hidden = !on;
  $('crosshair').hidden = !on;
  $('hover-tag').hidden = true;
  if (on) {
    closeDock();
    if (!matchMedia('(pointer: coarse)').matches) state.scene.walk.lock();
    setTimeout(() => { $('walk-hint').hidden = true; }, 7000);
  }
}

function hoverLabel(info) {
  if (!info) return '';
  switch (info.kind) {
    case 'agent': { const p = state.data && state.data.personas.agents.find((x) => x.module === info.module); return p ? `${p.name} · ${D.moduleNames[info.module]}` : D.moduleNames[info.module]; }
    case 'secretary': return state.data ? `${state.data.personas.secretary.name} · администратор` : 'Секретарь';
    case 'screen': return 'Центральный экран';
    case 'table': return 'Стол проекта';
    case 'zone': return `Зона: ${info.label}`;
    case 'building': return `Вариант №${info.variant.number}`;
    case 'plaque': { const pl = D.plaques[info.index]; return pl ? `${pl.title} — ${pl.sub}` : 'табличка'; }
    case 'item': return D.items[info.item] ? D.items[info.item].title : info.item;
    case 'poster': return D.posters[info.id] ? D.posters[info.id].title : 'постер';
    case 'vehicle': return D.vehicles[info.id] ? D.vehicles[info.id].title : 'экспонат';
    case 'aquarium': return 'Аквариум';
    case 'reactor': return 'Реактор · макет';
    case 'room': return D.places[info.id] ? D.places[info.id].title : 'помещение';
    case 'book': return `${info.name} · ${info.chunks} фрагментов`;
    case 'art': return D.arts && D.arts[info.id] ? D.arts[info.id].title : 'картина';
    case 'walker': return (D.walkers && D.walkers[info.index]) || 'коллега';
    case 'chess-square': return 'Шахматы';
    case 'go-point': return 'Го';
    default: return '';
  }
}

/* ---------------- сборка ---------------- */

async function main() {
  if (state.tv) document.body.dataset.tv = '1';

  await pickupAuth();

  const dark = document.documentElement.dataset.theme === 'dark'
    || (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  // ?lite=1 — облегчённый режим (без зеркала, теней и сглаживания): слабые машины и автономные проверки
  const mobile = matchMedia('(max-width: 700px), (pointer: coarse) and (max-width: 1100px)').matches
    || new URLSearchParams(location.search).get('lite') === '1';

  // сборка зала занимает несколько секунд — честно говорим об этом до первого кадра
  toast('Собираю зал…', 12000);
  await new Promise((r) => setTimeout(r, 30));
  state.scene = new OfficeScene($('scene'), { dark, reducedMotion: reduced, mobile });
  $('office-toast').hidden = true;
  state.scene.onTypingTick = () => Sound.click();
  state.scene.onPick = handlePick;

  // тема может смениться в другой вкладке платформы
  new MutationObserver(() => {
    const d = document.documentElement.dataset.theme === 'dark'
      || (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);
    state.scene.setTheme(d);
  }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

  // предметы на столах — сразу, чтобы зал не был пустым
  ensureCube(); ensureChess(); ensureGo();

  $('office-bar').hidden = false;

  // кнопки
  for (const b of document.querySelectorAll('.ob-views button')) {
    b.onclick = () => {
      setView(b.dataset.goto);
      if (b.dataset.goto === 'lobby') state.scene.goTo('lobby');
      else if (b.dataset.goto === 'screen') { state.scene.goTo('screen'); openDock(screenContext()); }
      else if (b.dataset.goto === 'table') { state.scene.goTo('table'); openDock(tableContext()); }
      else state.scene.goTo('hall');
    };
  }
  // крылья: аквариум, переговорная, библиотека, мастерская, реактор
  $('ob-place').onchange = () => {
    const id = $('ob-place').value;
    if (!id) return;
    setView('');
    state.scene.focusAnchor(id);
    if (D.places[id]) openDock(placeContext(D.places[id], id));
    $('ob-place').value = '';
  };
  $('ob-project').onclick = showProjectPick;
  $('ob-sound').onclick = () => {
    state.sound = !state.sound;
    Sound.setOn(state.sound);
    $('ob-sound').querySelector('use').setAttribute('href', state.sound ? '#i-sound-on' : '#i-sound-off');
    $('ob-sound').setAttribute('aria-pressed', String(state.sound));
    if (!state.sound && 'speechSynthesis' in window) speechSynthesis.cancel();
  };
  // прогулка от первого лица
  $('ob-walk').onclick = () => setWalk(!state.walk);
  document.addEventListener('keydown', (e) => {
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    if (e.code === 'KeyF') setWalk(!state.walk);
  });
  state.scene.walk.onStep = () => Sound.step();
  state.scene.walk.onLockChange = (locked) => { $('crosshair').hidden = !locked; if (!locked && state.walk) $('walk-hint').hidden = false; };
  $('dock-close').onclick = closeDock;
  for (const b of $('dock-tabs').querySelectorAll('[role="tab"]')) {
    b.onclick = () => setTab(b.dataset.tab);
  }
  $('chat-form').onsubmit = (e) => {
    e.preventDefault();
    const text = $('chat-input').value.trim();
    if (!text) return;
    $('chat-input').value = '';
    sendChat(text);
  };
  $('intro-skip').onclick = () => { $('intro-hint').hidden = true; state.scene.skipFlythrough(); };
  $('project-pick').onclick = (e) => { if (e.target === $('project-pick')) $('project-pick').hidden = true; };

  // кадры — ДО пролёта: его завершение живёт внутри update(), и цикл,
  // запущенный после await, никогда бы не начался (поймано живым прогоном)
  let last = performance.now();
  const tick = () => {
    const now = performance.now();
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (state.paused) { requestAnimationFrame(frame); return; }
    state.scene.update(dt);
    for (const app of Object.values(state.apps)) if (app.update) app.update(dt);
    if (state.walk) {
      hoverAcc += dt;
      if (hoverAcc > 0.15) {
        hoverAcc = 0;
        const label = hoverLabel(state.scene.hoverCenter());
        const tag = $('hover-tag');
        tag.hidden = !label;
        if (label) tag.textContent = label;
      }
    }
  };
  let hoverAcc = 0;
  const frame = () => { tick(); requestAnimationFrame(frame); };
  requestAnimationFrame(frame);
  // rAF замирает в фоновой вкладке (превью, второй монитор): запасной таймер
  // держит анимацию и пролёт живыми, пока вкладка скрыта
  setInterval(() => { if (document.hidden) tick(); }, 33);

  // корешки библиотеки — документы базы знаний платформы
  api('/api/office/kb-docs').then((r) => state.scene.setBooks(r.docs || [])).catch(() => {});

  // первый заход
  await refresh(true);
  api('/api/office/visit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId: state.projectId }) }).catch(() => {});

  if (state.tv) {
    state.scene.goTo('hall', 0);
    state.scene.controls.autoRotate = true;
    state.scene.controls.autoRotateSpeed = 0.4;
  } else {
    await runIntroFlight(true);
    if (!state.projectId && state.token) showProjectPick();
  }

  // опрос платформы
  setInterval(refresh, 10000);
}

/* ---------------- клики по сцене ---------------- */

function handlePick(info) {
  switch (info.kind) {
    case 'agent':
      state.scene.focusAnchor(`agent:${info.module}`);
      openDock(agentContext(info.module));
      break;
    case 'secretary':
      state.scene.focusAnchor('secretary');
      state.scene.wave(2.5);
      openDock(secretaryContext());
      break;
    case 'screen':
      state.scene.goTo('screen');
      setView('screen');
      openDock(screenContext());
      break;
    case 'table':
      state.scene.goTo('table');
      setView('table');
      openDock(tableContext());
      break;
    case 'zone':
      openDock(tableContext(`${info.label}${info.zone && info.zone.areaM2 ? ` · ${info.zone.areaM2} м²` : ''}`));
      break;
    case 'building': {
      const v = info.variant;
      openDock(tableContext(`Вариант №${v.number}: ${v.floors} эт., пятно ${v.areaM2 ? v.areaM2 + ' м²' : '—'} · ${v.statusLabel || ''}`));
      break;
    }
    case 'plaque':
      openDock(plaqueContext(info.index));
      break;
    case 'item':
      state.scene.focusAnchor(info.item);
      openDock(itemContext(info.item));
      break;
    case 'poster':
      openDock(posterContext(info));
      break;
    case 'vehicle':
      openDock(placeContext(D.vehicles[info.id], 'garage'));
      break;
    case 'aquarium':
      openDock(placeContext(D.places.aquarium, 'aquarium'));
      break;
    case 'reactor':
      openDock(placeContext(D.places.reactor, 'reactor'));
      break;
    case 'room':
      openDock(placeContext(D.places[info.id], info.id));
      break;
    case 'book':
      openDock(bookContext(info));
      break;
    case 'art':
      openDock(placeContext(D.arts[info.id] || { title: 'Картина', sub: '', text: '' }, 'reactor'));
      break;
    case 'walker':
      toast(`${(D.walkers && D.walkers[info.index]) || 'Коллега'} — идёт по делам`);
      break;
    case 'chess-square':
      ensureChess().clickSquare(info.square);
      if (!state.dock.context || state.dock.context.chatKind !== 'feature:chess') openDock(itemContext('chess'));
      else renderInfo();
      break;
    case 'go-point':
      ensureGo().play(info.index);
      if (!state.dock.context || state.dock.context.chatKind !== 'feature:go') openDock(itemContext('go'));
      else renderInfo();
      break;
    default:
      break;
  }
}

// ручка для отладки в консоли; данными страницы не является
window.__office = state;
state.pick = handlePick;

main().catch((err) => {
  toast(`Зал не открылся: ${err.message}`, 8000);
  console.error(err);
});
