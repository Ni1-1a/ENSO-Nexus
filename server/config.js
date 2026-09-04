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
  /*
   * Своя точка входа: через неё запросы идут не напрямую, а через шлюз на маке
   * (`mac/ai-gateway.js`, маршрут `/cloud/anthropic`).
   *
   * Зачем. Сервер платформы стоит в Москве, а Россия в списке поддерживаемых
   * стран Anthropic отсутствует — обращение с этой машины нарушает их условия
   * само по себе, независимо от того, кто его затеял. Мак стоит там, где
   * владелец, и наружу ходит он. Настоящий ключ при этом остаётся на маке:
   * сюда достаточно вписать любую непустую строку, чтобы провайдер считался
   * настроенным, — шлюз всё равно заменит её своим ключом.
   *
   * Пусто — прежнее поведение: SDK идёт в api.anthropic.com напрямую.
   */
  anthropicBaseUrl: process.env.ANTHROPIC_BASE_URL || '',
  /*
   * Отдельный ключ администратора организации (sk-ant-admin…) — только для
   * отчёта о расходе на вкладке «Статистика». Обычный рабочий ключ такие
   * ручки не открывает, а этот, наоборот, не годится для запросов к моделям:
   * поэтому два поля, а не одно. Ключ необязателен — без него расход берётся
   * из собственного счётчика платформы.
   */
  anthropicAdminKey: process.env.ANTHROPIC_ADMIN_KEY || '',
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
  localAiModel: process.env.LOCAL_AI_MODEL || 'qwen/qwen3.8-27b', // чат/анализ (структурный JSON)
  localAiOcrModel: process.env.LOCAL_AI_OCR_MODEL || 'qwen/qwen3-vl-30b', // vision-модель для VLM-OCR
  localAiMaxTokens: int('LOCAL_AI_MAX_TOKENS', 12288),
  localAiTimeoutMs: int('LOCAL_AI_TIMEOUT', 480000), // очередь LM Studio может быть занята (OCR и др.)
  localAiDocCharLimit: int('LOCAL_AI_DOC_CHAR_LIMIT', 45000),
  // Размер контекста при явной загрузке моделей (см. services/model-manager.js).
  // Значения подобраны под 48 ГБ RAM: модель + KV-кэш помещаются в лимит Metal.
  localAiContext: int('LOCAL_AI_CONTEXT', 32768),
  localAiOcrContext: int('LOCAL_AI_OCR_CONTEXT', 65536),
  /*
   * Поочерёдная работа моделей: одна загрузилась → отработала → выгрузилась.
   *
   * Держать чат-модель и модель распознавания рядом имело смысл, пока обе
   * помещались в бюджет (16 + 5 ГБ). С qwen3.5-35b-a3b (20,6 ГБ весов + 9 ГБ KV)
   * свободных остаётся 5 ГБ, и любое соседство означает работу впритык: система
   * сжимает память, часть весов уходит в подкачку, ответы замедляются в разы.
   * По одной — каждой достаётся весь бюджет, а переключений за анализ два:
   * распознавание идёт одним блоком по всем страницам, потом работает чат-модель.
   *
   * LOCAL_AI_EXCLUSIVE=0 возвращает прежнее поведение — вытеснять только при
   * нехватке памяти. Пригодится на машине, где обе модели заведомо помещаются.
   */
  localAiExclusive: process.env.LOCAL_AI_EXCLUSIVE !== '0',
  // «Изучение документации»: сколько страниц PDF-скана распознаёт vision-модель на файл
  visionMaxPages: int('VISION_MAX_PAGES', 50),

  // Upload limits (documented in UI via /api/health)
  maxFileSizeBytes: int('MAX_FILE_SIZE_MB', 25) * 1024 * 1024,
  maxTotalUploadBytes: int('MAX_TOTAL_UPLOAD_MB', 60) * 1024 * 1024,
  maxFilesPerSession: int('MAX_FILES_PER_SESSION', 10),
  allowedExtensions: ['pdf', 'dwg', 'dxf', 'docx', 'txt', 'md', 'json', 'csv', 'png', 'jpg', 'jpeg'],
  // Потолок текста ОДНОГО документа в модулях «Анализ ТЗ» и «Проверка документа»
  // (символов): больше — честный 422 с числами, а не 26-мегабайтный txt в SQLite
  docCharLimit: int('DOC_CHAR_LIMIT', 1_500_000),
  /*
   * Потолок ОДНОГО запроса с файлами (по Content-Length) и потолок содержимого
   * одной записи zip (docx/xlsx) до распаковки. Аудит 02.09.2026: нормоконтроль
   * и ГГЭ принимали 40 × 90 МБ в память, а adm-zip распаковывал document.xml без
   * оглядки на заявленный размер — zip-бомба на 40 МБ давала строку на гигабайты.
   */
  uploadTotalBytes: int('UPLOAD_TOTAL_MB', 200) * 1024 * 1024,
  zipEntryBytes: int('ZIP_ENTRY_MB', 50) * 1024 * 1024,

  // Dialogue / cost limits
  maxMessageLength: int('MAX_MESSAGE_LENGTH', 4000),
  maxAiRequestsPerSession: int('MAX_AI_REQUESTS_PER_SESSION', 25),
  maxTokensPerSession: int('MAX_TOKENS_PER_SESSION', 2000000),
  /*
   * Общая касса обращений к модели на ОДИН анализ и глубина склейки обрезанного
   * ответа. Прежние 4 и 2 выбирались одним неудачным прогоном насквозь (вызов +
   * два продолжения + повтор), и вместо отчёта человек получал «Потрачено
   * обращений к модели: 4 из 4» — на локальной 8B-модели это был штатный исход.
   * Касса остаётся конечной намеренно: безнадёжный прогон обязан кончаться.
   */
  maxAnalysisCalls: int('MAX_ANALYSIS_CALLS', 12),
  /**
   * Промежуточный проверяющий (adversary) перед отправкой ответа пользователю:
   * черновик уходит той же модели на проверку противоречий фактам сессии,
   * выдуманных оснований и ухода от вопроса; вердикт «revise» возвращает ответ
   * автору на одну доработку (см. services/claude/adversary.js). Проверка —
   * служебное обращение: счётчик запросов проекта не расходует, токены считает.
   * ADVERSARY_REVIEW=0 выключает целиком — ответы уходят как есть.
   */
  adversaryReview: process.env.ADVERSARY_REVIEW !== '0',
  maxContinuations: int('MAX_CONTINUATIONS', 4),
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
  // База «Верифицировано»: собственный разбор документов по пунктам и таблицам
  // (Knowledge-Base-Верифицировано, см. её README) — отдельный каталог со
  // своими чанками. Документы, попавшие сюда, из общей базы больше не
  // выдаются: старый разбор регэкспами на них и рассыпался (см. kb.js).
  kbVerifiedDir: process.env.KB_VERIFIED_DIR || '',
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

  /**
   * GigaChat (Сбер) — облачная модель, доступная из России: сервер платформы
   * стоит в Москве и ходит к ней напрямую, без шлюза на маке.
   *
   * Авторизация двухступенчатая: в .env живёт постоянный ключ авторизации
   * (Basic, выдаёт кабинет developers.sber.ru), а к API ходит короткоживущий
   * access_token — обменом занимается services/ai/gigachat.js.
   *
   * TLS-сертификат у API выдан НУЦ Минцифры, в комплекте Node его нет:
   * процессу платформы нужен NODE_EXTRA_CA_CERTS с российским корневым
   * сертификатом, иначе обмен ключа на токен падает на проверке цепочки.
   */
  gigachatAuthKey: process.env.GIGACHAT_AUTH_KEY || '',
  // GIGACHAT_API_PERS — физлицо; GIGACHAT_API_B2B / GIGACHAT_API_CORP — юрлицо
  gigachatScope: process.env.GIGACHAT_SCOPE || 'GIGACHAT_API_PERS',
  gigachatModel: process.env.GIGACHAT_MODEL || 'GigaChat-2',
  gigachatBaseUrl: process.env.GIGACHAT_BASE_URL || 'https://gigachat.devices.sberbank.ru/api/v1',
  gigachatOauthUrl: process.env.GIGACHAT_OAUTH_URL || 'https://ngw.devices.sberbank.ru:9443/api/v2/oauth',
  // Потолок ответа в справочнике Сбера не зафиксирован — консервативные 4096
  // до живой проверки с ключом; обрезанный ответ дочитывается продолжениями
  gigachatMaxTokens: int('GIGACHAT_MAX_TOKENS', 4096),

  /**
   * YandexGPT — через OpenAI-совместимый слой Yandex Cloud, тоже напрямую
   * с российского сервера. Ключ API и каталог (folder) выдаёт консоль
   * Yandex Cloud; короткое имя модели («yandexgpt/latest») адаптер дополняет
   * до полного URI gpt://<каталог>/<модель> перед отправкой.
   */
  yandexApiKey: process.env.YANDEX_API_KEY || '',
  yandexFolderId: process.env.YANDEX_FOLDER_ID || '',
  yandexModel: process.env.YANDEX_MODEL || 'yandexgpt/latest',
  yandexBaseUrl: process.env.YANDEX_BASE_URL || 'https://llm.api.cloud.yandex.net/v1',
  yandexMaxTokens: int('YANDEX_MAX_TOKENS', 8000),

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
  /**
   * Облачные провайдеры, открытые ВСЕМ вошедшим, через запятую.
   *
   * Гейт `cloudAi` в users.json — всё или ничего, а решение владельца бывает
   * тоньше: «Kimi всем, остальное только мне» (2026-08-20). Список именно
   * белый: провайдер попадает в общий доступ, только если его сюда вписали,
   * поэтому забытая переменная означает «никому», а не «всем».
   *
   *   CLOUD_AI_OPEN_PROVIDERS=kimi
   */
  cloudAiOpenProviders: new Set(
    (process.env.CLOUD_AI_OPEN_PROVIDERS || '')
      .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
  ),
  /**
   * Имена платформы, на которых облачные модели вообще предлагаются.
   *
   * У платформы два адреса, и за ними разные аудитории: на `.com` работает
   * облако, `.ru` остаётся на локальных моделях. Разделение по имени, а не по
   * списку людей: список пришлось бы вести руками на каждого нового человека,
   * а имя приходит с каждым запросом само (nginx передаёт `Host`).
   *
   * Список белый и по умолчанию пустой: не задан — ограничения нет, облако
   * доступно на любом имени. Так было до появления второго домена, и так
   * работают чужие копии платформы.
   *
   *   CLOUD_AI_HOSTS=enso-nexus.com,www.enso-nexus.com
   */
  cloudAiHosts: new Set(
    (process.env.CLOUD_AI_HOSTS || '')
      .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
  ),
  /**
   * Какие облачные провайдеры привязаны к именам из CLOUD_AI_HOSTS.
   *
   * Разделение доменов неравномерное: Claude, ChatGPT и Gemini живут только
   * на `.com` — их условия не поддерживают Россию, и на `.ru` их нет ни у
   * кого, включая владельца. Kimi, GigaChat и YandexGPT из России доступны,
   * поэтому к именам не привязываются и работают на любом адресе.
   *
   * Пустой список сохраняет прежнее поведение — к именам привязаны ВСЕ
   * облачные: сужение привязки — осознанное действие владельца, а забытая
   * переменная не имеет права молча открыть западное облако на `.ru`.
   *
   *   CLOUD_AI_HOSTS_PROVIDERS=claude,chatgpt,gemini
   */
  cloudAiHostsProviders: new Set(
    (process.env.CLOUD_AI_HOSTS_PROVIDERS || '')
      .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
  ),
  // Попытки входа лимитируются отдельно и жёстче обычных запросов:
  // вход без пароля — значит перебор имён должен упираться в лимит
  rateLimitAuth: int('RATE_LIMIT_AUTH', 12),
  /*
   * Срок жизни токена человека без активности, дней (аудит 02.09.2026: токен
   * в браузере был бессрочным). Активность продлевает срок сама; после паузы
   * дольше срока — просто вход заново по ФИО. 0 — бессрочно.
   */
  userTokenDays: int('USER_TOKEN_DAYS', 30),

  /**
   * Модуль «Датасет»: сбор обучающих пар для LoRA-дообучения локальных моделей.
   *
   * Пока модуль открыт ВСЕМ вошедшим (решение владельца 2026-08-24). Флаг
   * `"dataset": true` в users.json уже понимается: DATASET_OPEN=0 включает
   * проверку по флагу, и доступ остаётся у владельца и помеченных людей.
   * Умолчание «открыт» здесь осознанное исключение из правила «забытая
   * переменная = никому»: это внутренний инструмент разметки, а не облако.
   */
  datasetOpen: process.env.DATASET_OPEN !== '0',
  // Модель генерации черновиков пар (меняется в настройках модуля; это умолчание).
  // qwen3-coder-30b держит строгий JSON — черновик всё равно читает человек.
  datasetGenProvider: process.env.DATASET_GEN_PROVIDER || 'lmstudio',
  datasetGenModel: process.env.DATASET_GEN_MODEL || 'qwen/qwen3-coder-30b',

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

  // 1.4.x: правило «площадь застройки ≠ общая площадь» с раздельными ключами фактов;
  // бренд Enso-nexus вместо «ENSO Nexus Pilot 1»; появился проверяющий перед отправкой
  promptVersion: '1.4.0',

  // Модуль «Нормоконтроль»: своя БД PostgreSQL + pgvector (порт 5433 — на 5432
  // живёт системный PostgreSQL 18 без pgvector) и своё файловое хранилище.
  // База знаний модуля (rules/, templates/, knowledge/) — каталог «нормоконтроль» в корне Web.
  normoDatabaseUrl: process.env.NORMO_DATABASE_URL || 'postgresql://127.0.0.1:5433/enso_normo',
  normoDataDir: process.env.NORMO_DATA_DIR || path.join(__dirname, '..', 'data', 'normo'),
  normoKbDir: process.env.NORMO_KB_DIR || path.join(__dirname, '..', 'нормоконтроль'),
  // NORMO_LLM=0 выключает смысловые LLM-проверки (детерминированный слой работает всегда)
  normoLlmEnabled: process.env.NORMO_LLM !== '0',
};

// Базы знаний: главная всегда 'main'; остальные подключаются при наличии каталога.
const path2 = require('path');
const fs2 = require('fs');
config.kbBases = [];
if (config.kbDir) config.kbBases.push({ id: 'main', label: 'Общая база', dir: config.kbDir });

/*
 * «Верифицировано» — документы, разобранные по пунктам и таблицам моделью и
 * пересчитанные по исходнику. Каталог ищется рядом с основной базой, как и у
 * базы Гриши, но подключается только если он ЕСТЬ: пустая база в пикере хуже,
 * чем её отсутствие — человек выберет её и получит поиск ни по чему.
 */
const verifiedDir = config.kbVerifiedDir ||
  (config.kbDir ? path2.join(path2.dirname(config.kbDir), 'Knowledge-Base-Верифицировано') : '');
if (verifiedDir && fs2.existsSync(verifiedDir)) {
  config.kbBases.push({ id: 'verified', label: 'Верифицировано (разбор по пунктам и таблицам)', dir: verifiedDir });
}

/*
 * База Гриши из выбора убрана.
 *
 * Она никогда не была отдельным собранием: это фильтр «коллекция НТД_Гриша»
 * поверх общей базы плюс его собственные отметки. Список документов у неё тот
 * же, что у «Верифицировано» (см. README верифицированной базы), а разбор —
 * старый, регулярными выражениями. В пикере она читалась третьей базой и
 * выглядела двойником верифицированной; фрагментов собственных отметок в
 * индексе оставался ровно один.
 *
 * Каталог и заметка-коллекция сознательно НЕ удаляются: если понадобится
 * вернуть, достаточно снова добавить сюда строку.
 */

// Static resolution; 'auto' may be upgraded mock → local by the startup probe in index.js.
config.aiMode =
  config.aiProviderEnv === 'anthropic' ? 'live' :
  config.aiProviderEnv === 'local' ? 'local' :
  config.aiProviderEnv === 'mock' ? 'mock' :
  config.anthropicApiKey ? 'live' : 'mock';

module.exports = config;
