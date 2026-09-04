'use strict';
/**
 * REST проектов платформы. Монтируется в app.js под /api/projects.
 * Все маршруты — за userAuth: проект видят все вошедшие, как и модули.
 */
const express = require('express');
const config = require('../config');
const { rateLimit, userAuth } = require('../middleware');
const projects = require('../services/projects');

const router = express.Router();
router.use(rateLimit(config.rateLimitGeneral, 'projects'));
router.use(userAuth);

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

async function withSummary(rows, user) {
  const summary = await projects.summarize(rows.map((p) => p.id));
  // can_edit — клиенту: у чужого (общего) проекта нет кнопок правки и удаления
  return rows.map((p) => ({ ...p, summary: summary[p.id], can_edit: projects.canEdit(p, user) }));
}

router.get('/', wrap(async (req, res) => {
  res.json({ projects: await withSummary(projects.list(req.user), req.user) });
}));

router.post('/', wrap(async (req, res) => {
  const { name, fullName, client, stage, note } = req.body || {};
  if (typeof name !== 'string' || !name.trim()) return res.status(400).json({ error: 'Нужно короткое имя проекта (name)' });
  const project = projects.create({ name, fullName, client, stage, note, user: req.user });
  res.status(201).json({ project: (await withSummary([project], req.user))[0] });
}));

router.get('/:id', wrap(async (req, res) => {
  const project = projects.byId(projects.normId(req.params.id));
  // чужой проект для человека не существует: 404, а не 403 — нечего подтверждать
  if (!project || !projects.canSee(project, req.user)) return res.status(404).json({ error: 'Проект не найден' });
  res.json({ project: (await withSummary([project], req.user))[0] });
}));

router.patch('/:id', wrap(async (req, res) => {
  const id = projects.normId(req.params.id);
  const project = projects.byId(id);
  if (!project || !projects.canSee(project, req.user)) return res.status(404).json({ error: 'Проект не найден' });
  if (!projects.canEdit(project, req.user)) return res.status(403).json({ error: 'Это чужой проект — править может автор или владелец платформы' });
  const body = req.body || {};
  // проверка ПОСЛЕ trim: null и «   » раньше проходили и записывались как «null» и «»
  if (body.name !== undefined && (body.name === null || (typeof body.name === 'string' && !body.name.trim()))) {
    return res.status(400).json({ error: 'Название не может быть пустым' });
  }
  res.json({ project: (await withSummary([projects.update(id, body)], req.user))[0] });
}));

router.delete('/:id', wrap(async (req, res) => {
  const id = projects.normId(req.params.id);
  const project = projects.byId(id);
  if (!project || !projects.canSee(project, req.user)) return res.status(404).json({ error: 'Проект не найден' });
  // «Ранние работы» не удаляет никто — говорим это раньше, чем «чужой»
  if (id === projects.LEGACY_ID) return res.status(400).json({ error: 'Проект «Ранние работы» удалить нельзя' });
  if (!projects.canEdit(project, req.user)) return res.status(403).json({ error: 'Это чужой проект — удалить может автор или владелец платформы' });
  if (!projects.remove(id)) return res.status(404).json({ error: 'Проект не найден' });
  res.json({ ok: true });
}));

/** Отметка прогона модуля без хранения (акты, ГГЭ). */
router.post('/:id/marks', wrap(async (req, res) => {
  const id = projects.normId(req.params.id);
  const project = projects.byId(id);
  if (project && !projects.canSee(project, req.user)) return res.status(404).json({ error: 'Проект не найден' });
  const { module, note } = req.body || {};
  if (!projects.MODULES.includes(String(module))) return res.status(400).json({ error: 'Неизвестный модуль' });
  if (!projects.MARK_MODULES.includes(String(module))) {
    return res.status(400).json({ error: 'Отметки только у модулей без хранения (gge, akty)' });
  }
  if (!projects.mark(id, String(module), note, req.user)) return res.status(404).json({ error: 'Проект не найден' });
  res.json({ ok: true });
}));

module.exports = { router };
