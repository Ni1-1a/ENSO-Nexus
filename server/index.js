'use strict';
const config = require('./config');
const { createApp, startCleanup } = require('./app');

/** In auto mode without an Anthropic key: use a local OpenAI-compatible server (LM Studio) if reachable. */
async function probeLocalAi() {
  if (config.aiProviderEnv !== 'auto' || config.aiMode !== 'mock') return;
  try {
    const res = await fetch(`${config.localAiBaseUrl}/models`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return;
    const data = await res.json();
    const ids = (data.data || []).map((m) => m.id);
    if (!ids.length) return;
    if (!ids.includes(config.localAiModel)) {
      const fallback = ids.find((id) => !id.includes('embedding'));
      if (!fallback) return;
      console.log(`[local-ai] модель ${config.localAiModel} не найдена, использую ${fallback}`);
      config.localAiModel = fallback;
    }
    config.aiMode = 'local';
  } catch { /* локальный сервер недоступен — остаёмся в mock */ }
}

(async () => {
  await probeLocalAi();
  const app = createApp();
  startCleanup();
  app.listen(config.port, () => {
    console.log(`ENSO Nexus Pilot 1 Web — http://localhost:${config.port}`);
    const label = config.aiMode === 'live' ? `live (${config.anthropicModel})`
      : config.aiMode === 'local' ? `local (${config.localAiModel} @ ${config.localAiBaseUrl})`
      : 'mock — задайте ANTHROPIC_API_KEY или запустите LM Studio';
    console.log(`AI mode: ${label}`);
  });
})();
