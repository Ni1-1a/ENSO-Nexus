'use strict';
// Показываем ровно тот адрес, который не нашёлся, — иначе непонятно,
// где именно опечатка. Пишем текстом, разметка сюда не попадает.
// Пустая рамка на корневом адресе выглядела бы недорисованной — прячем.
(function () {
  var el = document.getElementById('path');
  if (!el) return;
  var p = decodeURI(location.pathname) + location.search;
  if (p && p !== '/') el.textContent = p; else el.hidden = true;
}());
