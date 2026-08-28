'use strict';
/**
 * Самый ранний скрипт страницы: решает, что показать первым — экран входа
 * или приложение.
 *
 * Обычный приём «инлайновый скрипт в <head>» здесь не работает: заголовок
 * безопасности разрешает только `script-src 'self'`, инлайн блокируется.
 * Поэтому отдельный файл, подключённый в <head> без defer — он выполняется
 * до отрисовки тела, и приложение не успевает мигнуть перед экраном входа.
 */
(function () {
  var KEY = 'enso-pilot1-auth';
  var saved = null;
  try { saved = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { saved = null; }
  // «app» — токен есть, показываем приложение и проверяем токен уже фоном;
  // «auth» — токена нет, сразу экран входа.
  document.documentElement.dataset.boot = saved && saved.token ? 'app' : 'auth';

  // Тема применяется здесь же, а не только в app.js: страницы-модули
  // (tz, normo, doccheck, akty, gge) иначе не знали про выбор человека
  // и открывались светлыми при тёмной платформе. Ранний запуск заодно
  // убирает мигание светлого кадра до применения тёмной темы.
  var theme = null;
  try { theme = localStorage.getItem('enso-pilot1-theme'); } catch (e) { theme = null; }
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
})();
