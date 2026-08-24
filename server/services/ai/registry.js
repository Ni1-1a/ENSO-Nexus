'use strict';
/**
 * Реестр AI-провайдеров и моделей: возможности (capabilities) и лимиты.
 *
 * Единственное место, где записано, что умеет конкретная модель. Пайплайн и
 * интерфейс спрашивают возможности, а не бренд: вместо «если Claude — отправить
 * PDF» пишется «если провайдер умеет pdf — отправить PDF». Благодаря этому новый
 * провайдер подключается добавлением записи сюда, без правок бизнес-логики.
 *
 * Возможности намеренно консервативны: неизвестная модель считается умеющей
 * только текст. Лучше лишний раз извлечь текст самим, чем отправить PDF модели,
 * которая его не прочитает, и получить пустой анализ.
 */
const config = require('../../config');

/** Полный набор признаков (ТЗ, п. 57). */
const CAPABILITY_KEYS = [
  'text', 'vision', 'pdf', 'streaming', 'structuredOutput',
  'tools', 'reasoning', 'fileUpload', 'embeddings',
];

const NONE = Object.freeze(CAPABILITY_KEYS.reduce((a, k) => ({ ...a, [k]: false }), {}));

function caps(on) {
  return Object.freeze({ ...NONE, text: true, ...on });
}

/**
 * Базовые возможности провайдера. Поле kind говорит, каким адаптером
 * пользоваться: anthropic (свой SDK), openai-compat (общий REST), demo.
 */
const PROVIDERS = {
  claude: {
    id: 'claude',
    label: 'Claude (Anthropic)',
    kind: 'anthropic',
    cloud: true,
    keyEnv: 'ANTHROPIC_API_KEY',
    caps: caps({ vision: true, pdf: true, streaming: true, structuredOutput: true, tools: true, reasoning: true }),
    maxOutputTokens: () => config.anthropicMaxTokens,
    defaultModel: () => config.anthropicModel,
  },
  chatgpt: {
    id: 'chatgpt',
    label: 'ChatGPT (OpenAI)',
    kind: 'openai-compat',
    cloud: true,
    keyEnv: 'OPENAI_API_KEY',
    caps: caps({ vision: true, streaming: true, structuredOutput: true, tools: true, reasoning: true, fileUpload: true }),
    maxOutputTokens: () => config.openaiMaxTokens,
    defaultModel: () => config.openaiModel,
  },
  kimi: {
    id: 'kimi',
    label: 'Kimi (Moonshot AI)',
    kind: 'openai-compat',
    cloud: true,
    keyEnv: 'KIMI_API_KEY',
    caps: caps({ vision: true, streaming: true, structuredOutput: true, tools: true }),
    maxOutputTokens: () => config.kimiMaxTokens,
    defaultModel: () => config.kimiModel,
  },
  gemini: {
    id: 'gemini',
    label: 'Gemini (Google)',
    kind: 'gemini',
    cloud: true,
    keyEnv: 'GEMINI_API_KEY',
    // Gemini читает PDF и изображения сам — документы уходят вложениями
    caps: caps({
      vision: true, pdf: true, streaming: true, structuredOutput: true,
      tools: true, reasoning: true, fileUpload: true, embeddings: true,
    }),
    maxOutputTokens: () => config.geminiMaxTokens,
    defaultModel: () => config.geminiModel,
  },
  gigachat: {
    id: 'gigachat',
    label: 'GigaChat (Сбер)',
    kind: 'openai-compat',
    cloud: true,
    keyEnv: 'GIGACHAT_AUTH_KEY',
    // structuredOutput оптимистичен намеренно: отвергнутая схема ловится
    // адаптером и повторяется в режиме «просто JSON», а без попытки строгий
    // ответ не получить вовсе. Зрение у GigaChat есть только через загрузку
    // файлов — этого пути у адаптера нет, поэтому vision честно false.
    caps: caps({ streaming: true, structuredOutput: true }),
    maxOutputTokens: () => config.gigachatMaxTokens,
    defaultModel: () => config.gigachatModel,
  },
  yandexgpt: {
    id: 'yandexgpt',
    label: 'YandexGPT (Яндекс)',
    kind: 'openai-compat',
    cloud: true,
    keyEnv: 'YANDEX_API_KEY',
    caps: caps({ streaming: true, structuredOutput: true }),
    maxOutputTokens: () => config.yandexMaxTokens,
    defaultModel: () => config.yandexModel,
  },
  lmstudio: {
    id: 'lmstudio',
    label: 'LM Studio (локально)',
    kind: 'openai-compat',
    cloud: false,
    caps: caps({ streaming: true, structuredOutput: true, embeddings: true }),
    maxOutputTokens: () => config.localAiMaxTokens,
    defaultModel: () => config.localAiModel,
  },
  ollama: {
    id: 'ollama',
    label: 'Ollama (локально)',
    kind: 'openai-compat',
    cloud: false,
    // json_schema Ollama принимает через OpenAI-совместимый слой — так работает и сейчас
    caps: caps({ streaming: true, structuredOutput: true }),
    maxOutputTokens: () => config.localAiMaxTokens,
    defaultModel: () => '',
  },
  'openai-compat': {
    id: 'openai-compat',
    label: 'OpenAI-совместимый сервер',
    kind: 'openai-compat',
    cloud: false,
    caps: caps({ streaming: true, structuredOutput: true }),
    maxOutputTokens: () => config.localAiMaxTokens,
    defaultModel: () => '',
  },
  demo: {
    id: 'demo',
    label: 'Демо-режим (без AI)',
    kind: 'demo',
    cloud: false,
    caps: caps({}),
    maxOutputTokens: () => 0,
    defaultModel: () => 'demo',
  },
};

/**
 * Уточнения по конкретным моделям: срабатывает первое совпадение.
 * Здесь живут исключения из базовых возможностей провайдера.
 */
const MODEL_RULES = [
  // Anthropic: у haiku потолок ответа вдвое ниже остальных
  { provider: 'claude', match: /haiku/i, limits: { maxOutputTokens: 64000 } },

  // Локальные: зрение есть только у vision-моделей, их и зовём для OCR
  { provider: 'lmstudio', match: /-vl|vision|llava|qwen2?-?vl/i, on: { vision: true } },
  // «Мыслящие» локальные модели тратят бюджет ответа на размышления
  { provider: 'lmstudio', match: /qwq|-r1|reason|think/i, on: { reasoning: true } },

  // Kimi K2+: размышления внутри того же лимита выходных токенов
  { provider: 'kimi', match: /^kimi-(k[3-9]|latest)/i, on: { reasoning: true } },

  // OpenAI: nano/mini дешевле, но лимит ответа тот же; отдельных правил не нужно
];

/* ---------------- описания: что это за модель и когда её брать ---------------- */

/**
 * Описания моделей — здесь, а не в разметке.
 *
 * Пикер показывал голый идентификатор («meta/llama-3.3-70b», «qwen/qwen3-vl-8b»)
 * и цену. По такому списку выбрать нельзя: не видно ни того, что модель умеет,
 * ни того, для какой работы она годится. Формулировки написаны про ЗАДАЧИ
 * платформы — чтение ГПЗУ и сканов, извлечение ограничений с нормативом,
 * строгий JSON, — а не про абстрактный «интеллект».
 *
 * Порядок значим: срабатывает первое совпадение, поэтому частные правила
 * (haiku, -vl, конкретные семейства) стоят выше общего правила провайдера.
 *
 *  tier      — короткая пометка для списка: «сильная», «быстрая», «зрение»…
 *  summary   — одна фраза: что это и чем берёт
 *  strengths — в чём выигрывает на задачах платформы
 *  limits    — чем придётся заплатить
 *  bestFor   — когда выбирать именно её
 */
const MODEL_NOTES = [
  {
    provider: 'claude', match: /haiku/i, tier: 'быстрая',
    summary: 'Младшая модель Anthropic: отвечает быстро и стоит заметно дешевле старших.',
    strengths: ['Дёшево обходятся длинные переписки и повторные прогоны', 'Аккуратно держит формат JSON'],
    limits: ['Потолок ответа вдвое ниже старших — длинный отчёт приходится дробить', 'На противоречивых нормах ошибается чаще старших'],
    bestFor: 'Черновые прогоны, уточняющие вопросы, разбор простых документов.',
  },
  {
    provider: 'claude', match: /opus/i, tier: 'самая сильная',
    summary: 'Старшая модель Anthropic: лучший на платформе разбор нормативов и многокритериальных решений.',
    strengths: [
      'Находит противоречия между ТЗ, ГПЗУ и СП, а не сглаживает их',
      'Читает PDF и сканы сама, без предварительного распознавания',
      'Даёт ссылку на пункт норматива, а не «по нормам»',
    ],
    limits: ['Самый дорогой тариф', 'Отвечает медленнее младших'],
    bestFor: 'Извлечение ограничений, нормоконтроль, спорные исходные данные — там, где ошибка дороже токенов.',
  },
  {
    provider: 'claude', match: /sonnet|fable/i, tier: 'рабочая',
    summary: 'Средняя модель Anthropic: почти качество старшей при заметно меньшей цене.',
    strengths: ['Хорошо держит длинный контекст комплекта ИД', 'Читает PDF и сканы сама', 'Устойчивый строгий JSON'],
    limits: ['На редких и спорных нормах уступает opus'],
    bestFor: 'Повседневная работа: анализ комплекта, ответы по нормам, сборка отчёта.',
  },
  {
    provider: 'chatgpt', match: /nano|mini/i, tier: 'быстрая',
    summary: 'Младшие модели OpenAI: дёшево и быстро, качество разбора норм среднее.',
    strengths: ['Низкая цена при большом объёме документов'],
    limits: ['Пункты нормативов путает чаще старших', 'Длинные таблицы читает неаккуратно'],
    bestFor: 'Проверка гипотез и черновые прогоны, когда точность ссылок пока не важна.',
  },
  {
    provider: 'chatgpt', match: /./, tier: 'сильная',
    summary: 'Старшие модели OpenAI: сильный общий разбор текста и уверенный строгий JSON.',
    strengths: ['Хорошо структурирует требования из ТЗ', 'Видит изображения — годится для вопросов по области плана'],
    limits: ['PDF целиком не читает: сканы идут через распознавание', 'Тариф выше локальных моделей (они бесплатны)'],
    bestFor: 'Извлечение требований и фактов из текстовых ТЗ и ТХ.',
  },
  {
    provider: 'gemini', match: /flash|lite/i, tier: 'быстрая',
    summary: 'Быстрые модели Google: дёшево читают большие комплекты документов целиком.',
    strengths: ['Огромное окно контекста — весь комплект ИД помещается разом', 'PDF и сканы читает сама'],
    limits: ['На тонких нормативных различиях уступает старшим'],
    bestFor: 'Первый проход по толстому комплекту: что вообще есть в документах.',
  },
  {
    provider: 'gemini', match: /./, tier: 'сильная',
    summary: 'Модели Google: читают PDF и изображения напрямую, окно контекста самое большое.',
    strengths: [
      'Семнадцатистраничный скан ГПЗУ уходит вложением, без потерь распознавания',
      'Весь комплект ИД помещается в один запрос',
    ],
    limits: ['Строгую JSON-схему принимает не всегда — адаптер один раз повторяет запрос без неё'],
    bestFor: 'Сканы и большие комплекты: ГПЗУ, тома ТЗ, выписки.',
  },
  {
    provider: 'kimi', match: /./, tier: 'бюджетная',
    summary: 'Moonshot AI: длинный контекст за небольшие деньги.',
    strengths: ['Дёшево держит длинную переписку и большой комплект'],
    limits: ['Русскую нормативную терминологию знает хуже Claude и Gemini', 'PDF не читает — сканы идут через распознавание'],
    bestFor: 'Долгие диалоги и черновой разбор, когда бюджет важнее точности ссылок.',
  },
  {
    provider: 'gigachat', match: /max/i, tier: 'сильная, облако РФ',
    summary: 'Старшая модель Сбера: облачная нейросеть, доступная из России напрямую, без шлюзов.',
    strengths: ['Работает с российского сервера без обходных путей', 'Русский язык и деловая лексика для модели родные'],
    limits: ['PDF и сканы не читает — документы идут через распознавание', 'Нормативную базу знает поверхностнее Claude и Gemini — опирается на базу знаний'],
    bestFor: 'Основное облако на адресе .ru: анализ комплекта и диалог, когда западные модели недоступны.',
  },
  {
    provider: 'gigachat', match: /./, tier: 'облако РФ',
    summary: 'Модель Сбера: облачная нейросеть, доступная из России напрямую, без шлюзов.',
    strengths: ['Работает с российского сервера без обходных путей', 'Отвечает быстрее и дешевле старшей Max'],
    limits: ['PDF и сканы не читает — документы идут через распознавание', 'На противоречивых нормах уступает старшим моделям'],
    bestFor: 'Диалог и разбор текстовых документов на адресе .ru.',
  },
  {
    provider: 'yandexgpt', match: /lite/i, tier: 'быстрая, облако РФ',
    summary: 'Младшая модель Яндекса: дёшево и быстро, тарифицируется в рублях через Yandex Cloud.',
    strengths: ['Доступна с российского сервера напрямую', 'Низкая цена при большом объёме переписки'],
    limits: ['PDF и сканы не читает — документы идут через распознавание', 'Сложный разбор нормативов не для неё'],
    bestFor: 'Уточняющие вопросы и черновые прогоны на адресе .ru.',
  },
  {
    provider: 'yandexgpt', match: /./, tier: 'облако РФ',
    summary: 'Модель Яндекса: облачная нейросеть, доступная из России; тарифицируется в рублях через Yandex Cloud.',
    strengths: ['Доступна с российского сервера напрямую', 'Уверенно держит русскую деловую и нормативную лексику'],
    limits: ['PDF и сканы не читает — документы идут через распознавание', 'Окно контекста меньше западных флагманов — большой комплект придётся резать'],
    bestFor: 'Анализ текстовых документов и диалог на адресе .ru.',
  },
  {
    provider: 'lmstudio', match: /-vl|vision|llava/i, tier: 'зрение, локальная',
    summary: 'Локальная модель со зрением: распознаёт сканы и чертёжную графику прямо на этой машине.',
    strengths: ['Бесплатна и не отправляет документы наружу', 'Таблицы со скана отдаёт разметкой, а не «стеной текста»'],
    limits: ['Мелкий шрифт и рукописные пометки читает с ошибками', 'Для текстового анализа слабее — её роль распознавание'],
    bestFor: 'Распознавание сканов ГПЗУ и выписок, когда облако недоступно.',
  },
  {
    // Размер берётся из имени: 13…49 млрд параметров — рабочий средний класс.
    // Перечислять «30b|32b|35b» поштучно нельзя: gemma-4-31b мимо такого списка
    // проходила и получала описание «небольшая модель» при своих 27 ГБ весов.
    provider: 'lmstudio', match: /(?:^|[^\d])(1[3-9]|[2-4]\d)\s?b(?![a-z\d])|coder/i, tier: 'рабочая, локальная',
    summary: 'Локальная модель среднего размера: бесплатна, документы не покидают машину.',
    strengths: ['Устойчиво держит строгий JSON — правила ограничений приходят разобранными', 'Ничего не стоит и не зависит от ключей'],
    limits: [
      'Нормативы знает поверхностно — опирается на базу знаний, а не на память',
      'На большом комплекте отвечает минутами',
      'Занимает почти всю оперативную память',
    ],
    bestFor: 'Основная рабочая лошадка без облака: разбор документов, ограничения, чат.',
  },
  {
    // 50 млрд параметров и выше: на 48 ГБ такие живут впритык или не живут
    provider: 'lmstudio', match: /(?:^|[^\d])([5-9]\d|\d{3})\s?b(?![a-z\d])/i, tier: 'тяжёлая, локальная',
    summary: 'Крупная локальная модель: качество выше средних, но требовательна к памяти.',
    strengths: ['Рассуждает заметно лучше моделей на 8–30 млрд параметров'],
    limits: ['На 48 ГБ памяти помещается впритык или не помещается вовсе', 'Загружается минутами, отвечает медленно'],
    bestFor: 'Разовые сложные разборы, когда время не жмёт, а облако использовать нельзя.',
  },
  {
    provider: 'lmstudio', match: /./, tier: 'лёгкая, локальная',
    summary: 'Небольшая локальная модель: быстрая и бесплатная, но простая.',
    strengths: ['Запускается за секунды и почти не занимает память'],
    limits: [
      'На комплекте из ГПЗУ, ТЗ и топосъёмки регулярно упирается в лимит ответа',
      'Половину ограничений пропускает — проверено на боевых данных',
    ],
    bestFor: 'Проверка того, что платформа жива, и совсем простые вопросы. Для анализа комплекта ИД брать не стоит.',
  },
  {
    provider: 'ollama', match: /./, tier: 'локальная',
    summary: 'Локальная модель через Ollama: бесплатна, работает без интернета.',
    strengths: ['Документы не покидают машину'],
    limits: ['Возможности зависят от того, что скачано; зрения и чтения PDF, как правило, нет'],
    bestFor: 'Работа без облака, когда LM Studio не используется.',
  },
  {
    provider: 'demo', match: /./, tier: 'без AI',
    summary: 'Заглушка без обращений к модели: платформа отвечает заранее заготовленным текстом.',
    strengths: ['Ничего не стоит и работает мгновенно', 'Годится, чтобы проверить загрузку файлов, план и чертёж'],
    limits: ['Документы не читаются: факты и ограничения не извлекаются'],
    bestFor: 'Проверка интерфейса и геометрии без расхода токенов.',
  },
];

/**
 * Описание пары «провайдер + модель» для интерфейса.
 * Неизвестный провайдер описания не получает — выдумывать его нечестно.
 */
function describe(provider, model = '') {
  const note = MODEL_NOTES.find((n) => n.provider === provider && n.match.test(model || ''));
  if (!note) return null;
  const { tier, summary, strengths, limits, bestFor } = note;
  return { tier, summary, strengths: [...strengths], limits: [...limits], bestFor };
}

/** Возможности пары «провайдер + модель». Неизвестный провайдер — только текст. */
function capabilities(provider, model = '') {
  const p = PROVIDERS[provider];
  if (!p) return NONE;
  let result = { ...p.caps };
  for (const rule of MODEL_RULES) {
    if (rule.provider === provider && rule.match.test(model || '') && rule.on) {
      result = { ...result, ...rule.on };
    }
  }
  return Object.freeze(result);
}

/** Короткая проверка одной возможности: supports(route, 'pdf'). */
function supports(route, capability) {
  if (!route || !route.provider) return false;
  return !!capabilities(route.provider, route.model)[capability];
}

/** Потолок выходных токенов для маршрута с учётом модельных исключений. */
function maxOutputTokens(route) {
  const p = PROVIDERS[route && route.provider];
  if (!p) return 0;
  const base = p.maxOutputTokens();
  for (const rule of MODEL_RULES) {
    if (rule.provider === route.provider && rule.match.test(route.model || '') && rule.limits) {
      return Math.min(base, rule.limits.maxOutputTokens);
    }
  }
  return base;
}

/**
 * Как подавать документы этому маршруту:
 *  'native'    — PDF и картинки уходят вложениями, модель читает их сама;
 *  'extracted' — PDF разбирается текстом, сканы и картинки идут через VLM-OCR.
 * Решает не бренд, а наличие обеих возможностей: чтения PDF и зрения.
 */
function documentMode(route) {
  return supports(route, 'pdf') && supports(route, 'vision') ? 'native' : 'extracted';
}

/** Метаданные провайдера (label, kind, облачный ли, какой ключ нужен). */
function providerMeta(provider) {
  const p = PROVIDERS[provider];
  if (!p) return null;
  const { id, label, kind, cloud, keyEnv } = p;
  return { id, label, kind, cloud: !!cloud, keyEnv: keyEnv || '' };
}

/** Модель по умолчанию для провайдера (когда в сессии выбран только провайдер). */
function defaultModel(provider) {
  const p = PROVIDERS[provider];
  return p ? p.defaultModel() : '';
}

/** Все известные провайдеры с возможностями — для /api/health и интерфейса. */
function listRegistry() {
  return Object.keys(PROVIDERS).map((id) => ({
    ...providerMeta(id),
    capabilities: capabilities(id, defaultModel(id)),
  }));
}

module.exports = {
  CAPABILITY_KEYS,
  MODEL_NOTES,
  describe,
  capabilities,
  supports,
  maxOutputTokens,
  documentMode,
  providerMeta,
  defaultModel,
  listRegistry,
};
