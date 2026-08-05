'use strict';
/**
 * Живой прогресс обработки per session (в памяти процесса).
 * Отдаётся в session view как jobProgress и рисуется индикатором на фронте.
 *
 * phase: preparing | retrieving | loading_model | waiting_model | generating |
 *        validating | saving | null
 */
const state = new Map();

function set(sessionId, patch) {
  const prev = state.get(sessionId) || { startedAt: Date.now() };
  const next = { ...prev, ...patch, updatedAt: Date.now() };
  if (patch.phase && patch.phase !== prev.phase) next.phaseStartedAt = Date.now();
  state.set(sessionId, next);
}

function get(sessionId) {
  return state.get(sessionId) || null;
}

function clear(sessionId) {
  state.delete(sessionId);
}

module.exports = { set, get, clear };
