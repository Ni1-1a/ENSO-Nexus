'use strict';
const path = require('path');

function int(name, def) {
  const v = parseInt(process.env[name], 10);
  return Number.isFinite(v) ? v : def;
}

const config = {
  port: int('PORT', 3000),
  dataDir: process.env.DATA_DIR || path.join(__dirname, '..', 'data'),
  publicBaseUrl: process.env.PUBLIC_BASE_URL || '',

  // Anthropic
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
  anthropicModel: process.env.ANTHROPIC_MODEL || 'claude-opus-5',
  anthropicMaxTokens: int('ANTHROPIC_MAX_TOKENS', 8192),
  anthropicRequestTimeoutMs: int('ANTHROPIC_REQUEST_TIMEOUT', 300000),
  anthropicMaxRetries: int('ANTHROPIC_MAX_RETRIES', 3),

  // Local model (OpenAI-compatible server, e.g. LM Studio)
  aiProviderEnv: (process.env.AI_PROVIDER || 'auto').toLowerCase(), // auto | anthropic | local | mock
  localAiBaseUrl: process.env.LOCAL_AI_BASE_URL || 'http://localhost:1234/v1',
  localAiModel: process.env.LOCAL_AI_MODEL || 'qwen/qwen3-coder-30b', // чат/анализ (структурный JSON)
  localAiOcrModel: process.env.LOCAL_AI_OCR_MODEL || 'qwen/qwen3-vl-30b', // vision-модель для VLM-OCR
  localAiMaxTokens: int('LOCAL_AI_MAX_TOKENS', 12288),
  localAiTimeoutMs: int('LOCAL_AI_TIMEOUT', 480000), // очередь LM Studio может быть занята (OCR и др.)
  localAiDocCharLimit: int('LOCAL_AI_DOC_CHAR_LIMIT', 45000),
  // Размер контекста при явной загрузке моделей (см. services/model-manager.js).
  // Значения подобраны под 48 ГБ RAM: модель + KV-кэш помещаются в лимит Metal.
  localAiContext: int('LOCAL_AI_CONTEXT', 32768),
  localAiOcrContext: int('LOCAL_AI_OCR_CONTEXT', 16384),
  // «Изучение документации»: сколько страниц PDF-скана распознаёт vision-модель на файл
  visionMaxPages: int('VISION_MAX_PAGES', 12),

  // Upload limits (documented in UI via /api/health)
  maxFileSizeBytes: int('MAX_FILE_SIZE_MB', 25) * 1024 * 1024,
  maxTotalUploadBytes: int('MAX_TOTAL_UPLOAD_MB', 60) * 1024 * 1024,
  maxFilesPerSession: int('MAX_FILES_PER_SESSION', 10),
  allowedExtensions: ['pdf', 'dwg', 'dxf', 'docx', 'txt', 'md', 'json', 'csv', 'png', 'jpg', 'jpeg'],

  // Dialogue / cost limits
  maxMessageLength: int('MAX_MESSAGE_LENGTH', 4000),
  maxAiRequestsPerSession: int('MAX_AI_REQUESTS_PER_SESSION', 25),
  maxTokensPerSession: int('MAX_TOKENS_PER_SESSION', 2000000),
  maxConcurrentJobs: int('MAX_CONCURRENT_JOBS', 2),

  // Memory management
  recentMessagesInContext: int('RECENT_MESSAGES_IN_CONTEXT', 24),
  compactAfterMessages: int('COMPACT_AFTER_MESSAGES', 40),

  // Sessions
  sessionTtlHours: int('SESSION_TTL_HOURS', 72),
  cleanupIntervalMinutes: int('CLEANUP_INTERVAL_MINUTES', 30),

  // Rate limiting (per IP)
  rateLimitWindowMs: int('RATE_LIMIT_WINDOW_MS', 60000),
  rateLimitGeneral: int('RATE_LIMIT_GENERAL', 120),
  rateLimitExpensive: int('RATE_LIMIT_EXPENSIVE', 12),

  // Knowledge bases (RAG) — несколько баз, выбор в интерфейсе per session
  kbDir: process.env.KB_DIR || '',
  kbGrishaDir: process.env.KB_GRISHA_DIR || '',
  // Заметка-коллекция Obsidian: перечисленные в ней документы основной базы
  // образуют базу Гриши (вместе с его локальными отметками)
  kbGrishaCollection: process.env.KB_GRISHA_COLLECTION || '',
  kbEmbeddingModel: process.env.KB_EMBEDDING_MODEL || 'text-embedding-qwen3-embedding-0.6b',
  kbTopK: int('KB_TOP_K', 6),

  // Дополнительные AI-провайдеры (выбор в интерфейсе per session)
  openaiApiKey: process.env.OPENAI_API_KEY || '',
  openaiModel: process.env.OPENAI_MODEL || 'gpt-5.2',
  openaiBaseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
  ollamaBaseUrl: process.env.OLLAMA_BASE_URL || 'http://localhost:11434/v1',

  promptVersion: '1.2.1', // 1.2.x: DWG/DXF приходят выжимкой из CAD-чертежа (+контуры зданий/границ)
};

// Базы знаний: главная всегда 'main'; база Гриши подключается при наличии каталога.
const path2 = require('path');
config.kbBases = [];
if (config.kbDir) config.kbBases.push({ id: 'main', label: 'Общая база', dir: config.kbDir });
const grishaDir = config.kbGrishaDir ||
  (config.kbDir ? path2.join(path2.dirname(config.kbDir), 'Knowledge-Base-Гриша') : '');
if (grishaDir) config.kbBases.push({ id: 'grisha', label: 'База Гриши (коллекция НТД + отметки)', dir: grishaDir });
if (!config.kbGrishaCollection && config.kbDir) {
  config.kbGrishaCollection = path2.join(config.kbDir, '07_Заметки', 'Коллекции', 'НТД_Гриша.md');
}

// Static resolution; 'auto' may be upgraded mock → local by the startup probe in index.js.
config.aiMode =
  config.aiProviderEnv === 'anthropic' ? 'live' :
  config.aiProviderEnv === 'local' ? 'local' :
  config.aiProviderEnv === 'mock' ? 'mock' :
  config.anthropicApiKey ? 'live' : 'mock';

module.exports = config;
