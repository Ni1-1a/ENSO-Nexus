'use strict';
/**
 * Вход на платформу по «Фамилия Имя».
 *
 * Пароля нет — это решение владельца. Отсюда поведение экрана: список людей
 * не показывается и не подсказывается, ответ сервера одинаков для нового и
 * существующего имени, а частота попыток ограничена на сервере.
 *
 * Состояние экрана — одно: атрибут `data-state` на контейнере.
 *   enter   — Фамилия и Имя, кнопка «Войти на платформу»
 *   pending — заявка отправлена, ждём одобрения владельца
 *   fail    — сервер недоступен
 */
(function () {
  const AUTH_KEY = 'enso-pilot1-auth';
  const DEVICE_KEY = 'enso-pilot1-device';
  const el = (id) => document.getElementById(id);

  /**
   * ID устройства нужен серверу уже при входе, а заводил его позже app.js
   * (ensureDevice при восстановлении сессии). Из-за этого при ПЕРВОМ входе
   * deviceId уходил пустым, и устройство человеку не записывалось никогда.
   * Ключ тот же, что в app.js: созданное здесь оно и подхватит.
   */
  function ensureDeviceId() {
    let d = localStorage.getItem(DEVICE_KEY);
    if (!d) {
      d = (crypto.randomUUID ? crypto.randomUUID() : `d-${Date.now()}-${Math.random().toString(16).slice(2)}`);
      localStorage.setItem(DEVICE_KEY, d);
    }
    return d;
  }

  const state = { user: null, token: '', mode: 'free', requireLogin: true };

  function stored() {
    try { return JSON.parse(localStorage.getItem(AUTH_KEY) || 'null'); } catch { return null; }
  }
  function remember(token, user) {
    state.token = token;
    state.user = user;
    localStorage.setItem(AUTH_KEY, JSON.stringify({ token, user }));
  }
  function forget() {
    state.token = '';
    state.user = null;
    localStorage.removeItem(AUTH_KEY);
  }

  function setState(name) { el('auth-screen').dataset.state = name; }
  function setBusy(on) { el('auth-screen').dataset.busy = on ? '1' : ''; }

  function showError(text) {
    const box = el('auth-error');
    box.textContent = text || '';
    box.hidden = !text;
  }

  /* ---------------- показ и уход экрана ---------------- */

  function show() {
    document.documentElement.dataset.boot = 'auth';
    const screen = el('auth-screen');
    screen.hidden = false;
    setState('enter');
    setTimeout(() => el('auth-last').focus(), 60);
  }

  /**
   * Уход экрана — «снятый лист»: карточка приподнимается и уходит вверх,
   * подложка растворяется, приложение проявляется под ней. Двигаются только
   * transform и opacity: любое другое свойство дёргает вёрстку на слабых машинах.
   *
   * При «уменьшить движение» переход мгновенный — глобальное правило гасит
   * длительности, поэтому здесь просто не ждём.
   */
  function leaveToApp() {
    const screen = el('auth-screen');
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    document.documentElement.dataset.boot = 'app';
    if (reduced) {
      screen.hidden = true;
      return Promise.resolve();
    }
    screen.classList.add('auth-leaving');
    document.body.classList.add('app-arriving');
    return new Promise((resolve) => {
      setTimeout(() => {
        screen.hidden = true;
        screen.classList.remove('auth-leaving');
        setTimeout(() => document.body.classList.remove('app-arriving'), 520);
        resolve();
      }, 520);
    });
  }

  /* ---------------- обращения к серверу ---------------- */

  async function post(path, body) {
    const res = await fetch(`/api${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data };
  }

  async function loadMode() {
    try {
      const res = await fetch('/api/auth/state');
      // Сервер может быть старее статики: браузер уже получил новый app.js,
      // а перезапуск ещё не случился. Тогда входа на сервере нет вовсе —
      // и запирать человека перед несуществующей дверью нельзя.
      if (!res.ok) return { requireLogin: false, legacy: true };
      const data = await res.json();
      state.mode = data.registration || 'free';
      el('auth-mode-note').textContent = state.mode === 'approval'
        ? 'Регистрация по одобрению: новое имя попадёт в заявки, доступ откроет владелец платформы.'
        : 'Регистрация свободная: впервые введённые фамилия и имя сразу становятся вашим входом.';
      return data;
    } catch {
      return null;
    }
  }

  async function submit(e) {
    if (e) e.preventDefault();
    const lastName = el('auth-last').value.trim();
    const firstName = el('auth-first').value.trim();
    if (!lastName || !firstName) {
      showError('Заполните фамилию и имя.');
      (lastName ? el('auth-first') : el('auth-last')).focus();
      return;
    }
    showError('');
    setBusy(true);
    try {
      const deviceId = ensureDeviceId();
      const { status, data } = await post('/auth/enter', { lastName, firstName, deviceId });
      if (data.status === 'active') {
        remember(data.token, data.user);
        await leaveToApp();
        if (window.onAuthEntered) window.onAuthEntered(data.user);
        return;
      }
      if (data.status === 'pending') {
        el('auth-pending-name').textContent = `${lastName} ${firstName}`;
        setState('pending');
        return;
      }
      showError(data.error || (status === 429
        ? 'Слишком много попыток подряд. Подождите минуту.'
        : 'Не удалось войти. Попробуйте ещё раз.'));
    } catch {
      setState('fail');
    } finally {
      setBusy(false);
    }
  }

  /** Повторная проверка из состояния «заявка на рассмотрении». */
  async function recheck() {
    setBusy(true);
    try {
      await submit(null);
    } finally { setBusy(false); }
  }

  /* ---------------- запуск ---------------- */

  /**
   * Возвращает токен, когда человек внутри. Приложение стартует только после
   * этого — иначе первые же запросы уйдут без входа и вернут 401.
   */
  async function start() {
    const saved = stored();
    // вход мог быть выключен на сервере (REQUIRE_LOGIN=0) — тогда экран не нужен
    const mode = await loadMode();
    state.requireLogin = !(mode && mode.requireLogin === false);
    if (mode && mode.requireLogin === false) {
      document.documentElement.dataset.boot = 'app';
      el('auth-screen').hidden = true;
      return '';
    }

    if (saved && saved.token) {
      try {
        const res = await fetch('/api/auth/me', { headers: { 'X-User-Token': saved.token } });
        if (res.ok) {
          const data = await res.json();
          if (data.status === 'active') {
            state.token = saved.token;
            state.user = data.user;
            document.documentElement.dataset.boot = 'app';
            el('auth-screen').hidden = true;
            return state.token;
          }
        }
        // сервер ответил и не признал токен — забываем его
        forget();
      } catch {
        // сервер не ответил: токен НЕ трогаем — после восстановления связи человек
        // останется внутри (раньше forget() стоял после try/catch и стирал токен и тут)
      }
    }

    show();
    return new Promise((resolve) => {
      window.onAuthEntered = () => resolve(state.token);
    });
  }

  function init() {
    el('auth-form').addEventListener('submit', submit);
    el('auth-recheck').addEventListener('click', recheck);
    el('auth-another').addEventListener('click', () => { setState('enter'); el('auth-last').focus(); });
    el('auth-retry').addEventListener('click', () => { setState('enter'); loadMode(); });
    for (const id of ['auth-last', 'auth-first']) {
      el(id).addEventListener('input', () => showError(''));
    }
  }

  window.Auth = {
    init, start,
    get token() { return state.token; },
    get user() { return state.user; },
    /** Требуется ли вход на этом сервере: при REQUIRE_LOGIN=0 выходить неоткуда. */
    get requireLogin() { return state.requireLogin; },
    /**
     * Выход. Сервер уведомляется ДО перезагрузки: раньше запрос уходил в
     * `location.reload()` следующей строкой и браузер обрывал его на полпути —
     * токен оставался живым на сервере, хотя в браузере его уже не было.
     * Ответа не ждём дольше двух секунд: недоступный сервер не должен
     * запирать человека внутри записи.
     */
    async signOut() {
      const token = state.token;
      forget();
      try {
        await fetch('/api/auth/logout', {
          method: 'POST',
          headers: { 'X-User-Token': token },
          signal: AbortSignal.timeout(2000),
        });
      } catch { /* сервер недоступен — локально мы уже вышли */ }
      location.reload();
    },
  };
}());
