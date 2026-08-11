'use strict';
const path = require('path');

function int(name, def) {
  const v = parseInt(process.env[name], 10);
  return Number.isFinite(v) ? v : def;
}

const config = {
  port: int('PORT', 3000),
  // Слушаем только локальный интерфейс: снаружи ходят через cloudflared.
  // На 0.0.0.0 заголовок X-Forwarded-For подделывается напрямую из локальной
  // сети, и ограничитель попыток входа обходится одной строкой.
  bindHost: process.env.BIND_HOST || '127.0.0.1',
  /**
   * Кому верить в X-Forwarded-For (значение `trust proxy` для Express).
   *
   * По умолчанию `loopback`: сервер слушает 127.0.0.1 и стоит за cloudflared,
   * никаких других хопов нет. Прежнее `1` означало «верить любому, кто прислал
   * заголовок» — и ограничитель попыток входа обходился одной строкой с чужой
   * машины, стоило BIND_HOST стать 0.0.0.0.
   *
   * TRUST_PROXY: `0`/`false` — не верить никому (req.ip = адрес соединения);
   * `loopback` (по умолчанию); число хопов; список адресов/подсетей через запятую.
   */
  trustProxy: (() => {
    const raw = (process.env.TRUST_PROXY || '').trim();
    if (!raw) return 'loopback';
    if (/^(0|false|off|no)$/i.test(raw)) return false;
    if (/^\d+$/.test(raw)) return parseInt(raw, 10);
    return raw.includes(',') ? raw.split(',').map((s) => s.trim()).filter(Boolean) : raw;
  })(),
  dataDir: process.env.DATA_DIR || path.join(__dirname, '..', 'data'),
  // Постоянный архив результатов ВСЕХ прогонов всех пользователей: копии файлов
  // складываются сюда при каждом завершённом анализе и переживают удаление сессий и TTL
  archiveDir: process.env.ARCHIVE_DIR || path.join(process.env.DATA_DIR || path.join(__dirname, '..', 'data'), 'archive'),
  publicBaseUrl: process.env.PUBLIC_BASE_URL || '',

  // Anthropic
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
  anthropicModel: process.env.ANTHROPIC_MODEL || 'claude-opus-5',
  // Потолок API у моделей Claude — 128000 выходных токенов (больше задать нельзя);
  // ответы идут стримингом, поэтому большие значения безопасны. Thinking у Claude
  // 5-го поколения включён по умолчанию и расходует часть этого же лимита.
  anthropicMaxTokens: Math.min(int('ANTHROPIC_MAX_TOKENS', 16384), 128000),
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
  visionMaxPages: int('VISION_MAX_PAGES', 50),

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
  // Потолок кругов уточнений: после стольких отвеченных вопросов анализ обязан
  // выпустить отчёт на допущениях. Без потолка модель спрашивает бесконечно.
  maxClarificationAnswers: int('MAX_CLARIFICATION_ANSWERS', 8),

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
  /**
   * Во сколько раз общий лимит на СОКЕТНЫЙ адрес больше лимита на посетителя.
   *
   * Адрес посетителя приходит заголовком от cloudflared, а подделать заголовок
   * может любой процесс на этой же машине — и получить сколько угодно новых
   * вёдер. Этот потолок считается по адресу TCP-соединения, заголовками не
   * обходится и держит перебор в рамках, даже если весь тоннель — один адрес.
   */
  rateLimitPeerFactor: int('RATE_LIMIT_PEER_FACTOR', 20),

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
  openaiModel: process.env.OPENAI_MODEL || 'gpt-5.6-terra', // актуальная средняя модель OpenAI (2026-08)
  openaiBaseUrl: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
  // GPT-5.x — reasoning-модели: max_completion_tokens включает и токены размышлений.
  // Потолок API семейства GPT-5.6 — 128000 выходных токенов.
  openaiMaxTokens: Math.min(int('OPENAI_MAX_TOKENS', 16384), 128000),
  // minimal | low | medium | high; пусто — не отправлять параметр
  openaiReasoningEffort: process.env.OPENAI_REASONING_EFFORT ?? 'low',
  ollamaBaseUrl: process.env.OLLAMA_BASE_URL || 'http://localhost:11434/v1',

  // Kimi (Moonshot AI) — OpenAI-совместимый API, ключ с platform.moonshot.ai
  kimiApiKey: process.env.KIMI_API_KEY || '',
  kimiModel: process.env.KIMI_MODEL || 'kimi-k2.6',
  kimiBaseUrl: process.env.KIMI_BASE_URL || 'https://api.moonshot.ai/v1',
  // Окно моделей Moonshot — 262144 токена, отдельного потолка на ответ у API нет
  // (проверено запросом 2026-08-08: max_tokens=262144 принимается). kimi-k3 —
  // рассуждающая модель: размышления расходуют этот же лимит, поэтому урезать его
  // нельзя — иначе весь бюджет уходит на мысли и ответ приходит пустым.
  kimiMaxTokens: Math.min(int('KIMI_MAX_TOKENS', 262144), 262144),

  // Google Gemini — нативная интеграция через официальный @google/genai.
  // Ключ только на сервере: во фронтенд, в SQLite и в логи он не попадает.
  geminiApiKey: process.env.GEMINI_API_KEY || '',
  // Модель не зашита: пусто — берётся первая доступная аккаунту из API
  geminiModel: process.env.GEMINI_MODEL || '',
  // Своя точка входа нужна для Vertex AI и корпоративных прокси
  geminiBaseUrl: process.env.GEMINI_BASE_URL || '',
  geminiMaxTokens: int('GEMINI_MAX_TOKENS', 65536),

  // Люди платформы: список ФИО, режим регистрации и последние адреса.
  // Файл лежит в КОРНЕ проекта, а не в public/ — та папка раздаётся статикой.
  usersFile: process.env.USERS_FILE || path.join(__dirname, '..', 'users.json'),
  // Вход можно выключить на время отладки: REQUIRE_LOGIN=0
  requireLogin: process.env.REQUIRE_LOGIN !== '0',
  /**
   * Облачные модели — только людям с `"cloudAi": true` в `users.json`.
   *
   * Условия OpenAI, Anthropic и Google ограничивают не только доступ самого
   * владельца ключа, но и предоставление доступа другим людям. Один ключ на
   * всех вошедших — это ровно то, за что аккаунт OpenAI деактивировали
   * 2026-08-10. Проверка живёт в `services/ai/cloud-access.js`.
   *
   * CLOUD_AI_OPEN=1 возвращает прежнее поведение (облако всем) — нужно тестам
   * и отладке, в боевой конфигурации ставить нельзя.
   */
  cloudAiOpen: process.env.CLOUD_AI_OPEN === '1',
  // Попытки входа лимитируются отдельно и жёстче обычных запросов:
  // вход без пароля — значит перебор имён должен упираться в лимит
  rateLimitAuth: int('RATE_LIMIT_AUTH', 12),

  // Мост к AutoCAD for Mac: через него получается настоящий DWG.
  // Записать DWG на сервере нельзя — формат закрытый; файл строит сам AutoCAD.
  acad: {
    enabled: process.env.ACAD_ENABLED !== '0',
    exchangeDir: process.env.ACAD_EXCHANGE_DIR || '',
    appName: process.env.ACAD_APP_NAME || 'AutoCAD 2027',
    // auto — сервер сам вводит CLAUDE-PUMP через AppleScript (нужен «Универсальный доступ»);
    // manual — команду в AutoCAD вводит человек (или заранее запущен CLAUDE-SERVE)
    trigger: process.env.ACAD_TRIGGER === 'manual' ? 'manual' : 'auto',
    timeoutMs: int('ACAD_TIMEOUT_MS', 90000),
    // запасной путь без AutoCAD: конвертер LibreDWG (кириллицу в именах слоёв
    // держит не всегда, поэтому результат помечается как полученный конвертером)
    allowConverterFallback: process.env.ACAD_CONVERTER_FALLBACK !== '0',
  },

  promptVersion: '1.3.0', // 1.3.x: у уточняющих вопросов появились варианты ответов (options)
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
