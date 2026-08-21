'use strict';
/**
 * Вопрос модели по выделенной области плана (ТЗ, п. 34).
 *
 * Собирает семь частей контекста: изображение области, её координаты, объекты
 * внутри рамки, ограничения внутри рамки, документы проекта, извлечённые факты
 * и сам вопрос. Отправить один скриншот — прямо запрещено: по картинке нельзя
 * ответить, сколько метров до границы.
 */
const adapter = require('../claude/adapter');
const { buildDocumentBlocks } = require('../claude/memory');
const registry = require('../ai/registry');
const selection = require('./selection');
const progress = require('../progress');
const render = require('../render');
const pipeline = require('../pipeline');
const { db } = require('../../db');
const prompts = require('../prompts');

/**
 * @param {string} sessionId
 * @param {object} opts {annotation, site, question, route, signal}
 * @returns {object} {answer, context: {чтоПопало, изображение}}
 */
async function ask(sessionId, { annotation, site, question, route, signal = null }) {
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
  adapter.checkBudget(session);

  const rect = annotation.geometry.points;
  progress.set(sessionId, {
    phase: 'preparing', provider: route.provider, model: adapter.resolveModel(route),
    label: 'Сбор контекста по выделенной области…',
  });

  const hits = selection.objectsIn(site, rect);
  const restrictionHits = hits.filter((h) => h.layer === 'restrictions');
  const objectHits = hits.filter((h) => h.layer !== 'restrictions');

  const messages = [];

  // 1–2. изображение области и её координаты
  let cropAttached = false;
  if (registry.supports(route, 'vision')) {
    try {
      progress.set(sessionId, { phase: 'preparing', label: 'Отрисовка выделенной области…' });
      const svg = selection.cropSvg(site, rect);
      const png = await render.svgToPng(svg, { width: 900, height: 640, scale: 2 });
      messages.push({
        role: 'user',
        content: [
          { type: 'text', text: '<selection_image>Выделенная область плана. Рамка обведена пунктиром.</selection_image>' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png.toString('base64') } },
        ],
      });
      cropAttached = true;
    } catch (err) {
      // без картинки ответ хуже, но текстовая часть полна — молча не падаем
      console.warn('[selection] crop не отрисован:', err.message);
    }
  }

  messages.push({
    role: 'user',
    content: `<selection_area>\n${selection.describeArea(rect, site)}\n</selection_area>`,
  });

  // 3–4. объекты и ограничения внутри рамки
  messages.push({
    role: 'user',
    content: `<objects_in_selection>\n${selection.describeHits(objectHits)}\n</objects_in_selection>`,
  });
  messages.push({
    role: 'user',
    content: `<restrictions_in_selection>\n${restrictionHits.length
      ? selection.describeHits(restrictionHits)
      : 'Зоны ограничений для этого плана ещё не рассчитаны либо в область не попали.'}\n</restrictions_in_selection>`,
  });

  // 5. документы проекта
  try {
    const { blocks, manifest } = await buildDocumentBlocks(sessionId, registry.documentMode(route));
    if (manifest.length) messages.push({ role: 'user', content: `<project_files>\n${manifest.join('\n')}\n</project_files>` });
    if (blocks.length) messages.push({ role: 'user', content: blocks });
  } catch (err) {
    console.warn('[selection] документы не приложены:', err.message);
  }

  // 6. извлечённые факты проекта
  const facts = db.prepare('SELECT key, value, source FROM facts WHERE session_id = ? ORDER BY created_at LIMIT 60').all(sessionId);
  if (facts.length) {
    messages.push({
      role: 'user',
      content: `<project_facts>\n${facts.map((f) => `- ${f.key} = ${f.value} (${f.source})`).join('\n')}\n</project_facts>`,
    });
  }

  // 7. вопрос пользователя
  const commentPart = annotation.comment ? `Комментарий к области: «${annotation.comment}».\n` : '';
  messages.push({ role: 'user', content: `${commentPart}Вопрос: ${question}` });

  progress.set(sessionId, {
    phase: 'generating', provider: route.provider, model: adapter.resolveModel(route),
    label: 'Модель отвечает по выделенной области…',
  });

  const out = await adapter.plainCall({ system: prompts.load('ask-selection'), messages, sessionId, route, signal });
  const answer = (out.text || '').trim() || 'Модель не вернула ответ.';

  return {
    answer,
    context: {
      изображениеПриложено: cropAttached,
      объектовВОбласти: objectHits.length,
      ограниченийВОбласти: restrictionHits.length,
      файловПроекта: db.prepare('SELECT COUNT(*) AS c FROM files WHERE session_id = ?').get(sessionId).c,
      фактов: facts.length,
    },
  };
}

/** Запись вопроса и ответа в ленту проекта; возвращает id сообщения с ответом. */
function recordInChat(sessionId, { annotation, question, answer }) {
  const area = annotation.geometry.points;
  const b = require('./site-geometry').bounds(area);
  const head = `[Вопрос по области плана X ${Math.round(b.minX)}…${Math.round(b.maxX)}, ` +
    `Y ${Math.round(b.minY)}…${Math.round(b.maxY)}] `;
  pipeline.addMessage(sessionId, 'user', 'chat', head + question);
  const row = db.prepare("SELECT id FROM messages WHERE session_id = ? AND role = 'user' ORDER BY created_at DESC LIMIT 1").get(sessionId);
  pipeline.addMessage(sessionId, 'assistant', 'chat', answer);
  const reply = db.prepare("SELECT id FROM messages WHERE session_id = ? AND role = 'assistant' ORDER BY created_at DESC LIMIT 1").get(sessionId);
  return { questionMessageId: row && row.id, answerMessageId: reply && reply.id };
}

module.exports = { ask, recordInChat };
