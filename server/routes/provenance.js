'use strict';
/**
 * Происхождение и структурный журнал сессии посадки (/api/sessions/:id/…).
 *
 *   GET /provenance/graph           — граф связей сессии (живой, из таблиц)
 *   GET /provenance/of/:nodeId      — цепочка «откуда это» для узла
 *   GET /journal?limit=             — события журнала со ссылками и причинами
 *
 * Доступ — тот же, что у плана: токен сессии (`sessionAuth`). Граф строится
 * из тех же таблиц, что читает вьювер, поэтому отдельных прав у него нет.
 */
const express = require('express');
const { sessionAuth } = require('../middleware');
const core = require('../../public/provenance-core.js');
const graphSvc = require('../services/geometry/provenance-graph');
const journal = require('../services/journal');

const router = express.Router();

/** `?include=<objectId>,…` — добавить в граф объекты плана, которые ни в чём не участвуют. */
function includeOf(req) {
  return String(req.query.include || '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 20);
}

router.get('/sessions/:id/provenance/graph', sessionAuth, async (req, res, next) => {
  try {
    res.json(await graphSvc.build(req.session.id, { includeObjects: includeOf(req) }));
  } catch (err) { next(err); }
});

router.get('/sessions/:id/provenance/of/:nodeId', sessionAuth, async (req, res, next) => {
  try {
    const raw = String(req.params.nodeId || '');
    let graph = await graphSvc.build(req.session.id);
    let id = graphSvc.resolveNodeId(graph, raw);
    // объект, который ни в чём не участвует, в общий граф не попадает — но «откуда это» у него есть: файл и слой
    if (!id && raw.startsWith('object:')) {
      graph = await graphSvc.build(req.session.id, { includeObjects: [raw.slice(7)] });
      id = graphSvc.resolveNodeId(graph, raw);
    }
    if (!id) {
      return res.status(404).json({
        error: 'Узел не найден в графе происхождения: сущность могла исчезнуть после переразбора плана.',
        nodeId: String(req.params.nodeId || '').slice(0, 200),
      });
    }
    const down = Math.max(0, Math.min(6, Number(req.query.down) || 1));
    const chain = core.chain(graph, id, { down });
    res.json({
      ...chain,
      planId: graph.planId,
      version: graph.version,
      // что в цепочке оборвано — честно, с причиной у каждого узла
      missing: [chain.node, ...chain.ancestors].filter((n) => n.orphan).map((n) => ({ id: n.id, label: n.label, why: n.why })),
    });
  } catch (err) { next(err); }
});

router.get('/sessions/:id/journal', sessionAuth, (req, res) => {
  const events = journal.list(req.session.id, { limit: req.query.limit || 200 });
  res.json({ events, stats: journal.stats(req.session.id) });
});

module.exports = { router };
