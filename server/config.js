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
  localAiModel: process.env.LOCAL_AI_MODEL || 'qwen/qwen3-vl-30b',
  localAiMaxTokens: int('LOCAL_AI_MAX_TOKENS', 8192),
  localAiDocCharLimit: int('LOCAL_AI_DOC_CHAR_LIMIT', 24000),

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

  promptVersion: '1.0.0',
};

// Static resolution; 'auto' may be upgraded mock → local by the startup probe in index.js.
config.aiMode =
  config.aiProviderEnv === 'anthropic' ? 'live' :
  config.aiProviderEnv === 'local' ? 'local' :
  config.aiProviderEnv === 'mock' ? 'mock' :
  config.anthropicApiKey ? 'live' : 'mock';

module.exports = config;
