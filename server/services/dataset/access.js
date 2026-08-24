'use strict';
/**
 * Допуск к модулю «Датасет».
 *
 * Пока модуль открыт всем вошедшим (config.datasetOpen, решение владельца
 * 2026-08-24). DATASET_OPEN=0 включает проверку личного флага `dataset` из
 * users.json; владелец платформы допущен всегда. Право ПОДТВЕРЖДАТЬ пары
 * отдельно не выдаётся: подтверждает любой допущенный к модулю — фиксация
 * ФИО и аудит делают каждое решение именным.
 */
const config = require('../../config');

/** Может ли человек работать с датасетом. Без входа (REQUIRE_LOGIN=0) — можно. */
function allowed(user) {
  if (!config.requireLogin) return true;
  if (!user || !user.approved) return false;
  return config.datasetOpen || user.owner === true || user.dataset === true;
}

/** Express-middleware после userAuth: у req.user уже проверено одобрение. */
function datasetAccess(req, res, next) {
  if (allowed(req.user)) return next();
  return res.status(403).json({ error: 'Доступ к модулю «Датасет» не открыт — обратитесь к владельцу платформы' });
}

module.exports = { allowed, datasetAccess };
