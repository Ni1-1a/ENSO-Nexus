'use strict';
/**
 * Библиотека верифицированных промптов канала «AI песочница инженера»
 * (`библиотека-промптов/` в корне проекта) + маршрутизация «тип документа →
 * промпт» для модуля «Проверка документа».
 *
 * Библиотека — ДАННЫЕ, а не runtime-промпты (см. CLAUDE.md): этот сервис —
 * единственное место кода, читающее её. Тексты в файлах верифицированы
 * владельцем и уходят модели ДОСЛОВНО, как задание; обвязка (роль, правила
 * вывода, формат JSON) живёт в prompts/doccheck-run.md и подставляет тело
 * библиотечного промпта как {{task}}.
 *
 * Кэш — по mtime и размеру файла, как в prompts.js: правка промпта действует
 * со следующего прогона без перезапуска. Индекс «id → файл» пересобирается,
 * когда меняется состав ролевых папок.
 */
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', '..', 'библиотека-промптов');

// Папки, которые не являются ролевыми (промптов в них нет)
const SKIP_DIRS = new Set(['каталоги']);

/* ---------------- чтение файлов библиотеки ---------------- */

function parsePromptFile(raw) {
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(raw);
  if (!m) return null;
  const meta = {};
  for (const line of m[1].split('\n')) {
    const mm = /^([a-z_]+):\s*(.*)$/.exec(line);
    if (mm) meta[mm[1]] = mm[2].trim();
  }
  const body = m[2].trim();
  if (!meta.id || !body) return null;
  return { meta, body };
}

/** id → путь файла; пересобирается при изменении состава папок. */
let indexCache = null; // { key, byId: Map<id, file> }

function dirKey() {
  const parts = [];
  for (const entry of fs.readdirSync(DIR, { withFileTypes: true })) {
    if (!entry.isDirectory() || SKIP_DIRS.has(entry.name)) continue;
    const st = fs.statSync(path.join(DIR, entry.name));
    parts.push(`${entry.name}:${st.mtimeMs}`);
  }
  return parts.sort().join('|');
}

function buildIndex() {
  const key = dirKey();
  if (indexCache && indexCache.key === key) return indexCache;
  const byId = new Map();
  for (const entry of fs.readdirSync(DIR, { withFileTypes: true })) {
    if (!entry.isDirectory() || SKIP_DIRS.has(entry.name)) continue;
    const roleDir = path.join(DIR, entry.name);
    for (const f of fs.readdirSync(roleDir)) {
      if (!f.endsWith('.md')) continue;
      // id по договорённости равен имени файла без расширения — это
      // проверяется тестом; читать все 400 файлов ради индекса не нужно
      byId.set(f.slice(0, -3), path.join(roleDir, f));
    }
  }
  indexCache = { key, byId };
  return indexCache;
}

/** текст и мета промпта по id; кэш по mtime+size */
const fileCache = new Map();

function byId(id) {
  const { byId: idx } = buildIndex();
  const file = idx.get(id);
  if (!file) throw new Error(`Промпт «${id}» не найден в библиотеке промптов`);
  const st = fs.statSync(file);
  const hit = fileCache.get(id);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.entry;
  const parsed = parsePromptFile(fs.readFileSync(file, 'utf8'));
  if (!parsed) throw new Error(`Промпт «${id}» не разобран: нет фронтматтера или пустое тело (${file})`);
  const entry = { id, file, ...parsed.meta, body: parsed.body };
  fileCache.set(id, { mtimeMs: st.mtimeMs, size: st.size, entry });
  return entry;
}

/* ---------------- типы документов и маршруты ---------------- */

/**
 * Маршрут: какой промпт библиотеки запускается для типа документа.
 * `system` — необязательный промпт-каркас (двухуровневая механика пособий АР
 * и ПТО: роль и правила один раз, короткая задача поверх). `alternatives` —
 * что предложить человеку, если он хочет другую проверку того же документа.
 */
const ROUTES = {
  'razdel-ar': {
    // умолчание — проверка 6 «Состав раздела по ПП № 87»: единственная из
    // пятнадцати, которой достаточно самого раздела; сверки со смежниками
    // (1–5) остаются альтернативами на выбор человека
    label: 'Раздел АР',
    promptId: 'proekt-ar-nk-06',
    systemId: 'proekt-ar-nk-karkas',
    alternatives: ['proekt-ar-nk-01', 'proekt-ar-nk-02', 'proekt-ar-nk-03', 'proekt-ar-nk-04',
      'proekt-ar-nk-05', 'proekt-ar-nk-07', 'proekt-ar-nk-08', 'proekt-ar-nk-09', 'proekt-ar-nk-10',
      'proekt-ar-nk-11', 'proekt-ar-nk-12', 'proekt-ar-nk-13', 'proekt-ar-nk-14', 'proekt-ar-nk-15'],
  },
  'razdel-kzh': {
    // полное Пособие нормоконтролёра КР v4 (передано владельцем 28.08.2026):
    // системная промпт-настройка (Приложение Г) + 20 комплектов К01–К20;
    // умолчание — К01 (классы бетона и маркировка), самая частая точка возврата
    label: 'Раздел КЖ / КР (железобетон)',
    promptId: 'dop-kr-k01',
    systemId: 'dop-kr-nastroika',
    alternatives: ['dop-kr-k02', 'dop-kr-k03', 'dop-kr-k04', 'dop-kr-k05', 'dop-kr-k06',
      'dop-kr-k07', 'dop-kr-k08', 'dop-kr-k09', 'dop-kr-k10', 'dop-kr-k11', 'dop-kr-k12',
      'dop-kr-k13', 'dop-kr-k14', 'dop-kr-k15', 'dop-kr-k16', 'dop-kr-k17', 'dop-kr-k18',
      'dop-kr-k19', 'dop-kr-k20', 'nk-kzh-normokontrol', 'nk-kzh-km-tekhproverki',
      'dop-hermes-v2-format', 'dop-kr-mini-universalnyj'],
  },
  'razdel-km': {
    label: 'Раздел КМ (металл)',
    promptId: 'nk-km-normokontrol',
    alternatives: ['nk-kzh-km-tekhproverki', 'dop-hermes-v2-format'],
  },
  'razdel-ov-vk': {
    label: 'Раздел ОВ / ВК',
    promptId: 'nk-ovvk-standards-normokontrol',
    alternatives: ['nk-ov-eo-sverka-elektropitanie'],
  },
  'razdel-pzu': {
    label: 'Раздел ПЗУ / генплан',
    promptId: 'proekt-pzu-1-polnyj',
    alternatives: ['proekt-pzu-2-polnyj', 'proekt-pzu-3-polnyj', 'proekt-pzu-4-polnyj', 'proekt-pzu-5-polnyj'],
  },
  'razdel-pos': {
    label: 'Раздел ПОС',
    promptId: 'nk-pos-chetyre-rezhima',
    alternatives: ['nk-pos-filtry-nakhodok'],
  },
  'razdel-pb': {
    label: 'Раздел ПБ (мероприятия)',
    promptId: 'kniga-2-05-ekspertiza-mpb-pb',
    alternatives: [],
  },
  'smeta': {
    label: 'Локальная смета',
    promptId: 'smeta-normokontrol-lokalnoj-smety',
    alternatives: ['smeta-proverka-primenimosti-rascenok', 'smeta-proverka-obosnovanij-koefficientov'],
  },
  'vor': {
    label: 'Ведомость объёмов работ',
    promptId: 'smeta-proverka-gotovogo-vor',
    alternatives: ['post-321-vor-specifikaciya'],
  },
  'ks2': {
    label: 'Акт КС-2',
    promptId: 'post-093-ks2-proverka',
    alternatives: [],
  },
  'akt-aosr': {
    label: 'Акт освидетельствования (АОСР)',
    promptId: 'ptg-pto-06-proverka-akta',
    systemId: 'ptg-pto-karkas',
    alternatives: ['ptg-pto-04-khronologiya', 'ptg-pto-12-podpisanty'],
  },
  'dogovor': {
    label: 'Договор подряда',
    promptId: 'ptg-gip-sudebnyy-shchit',
    alternatives: ['post-056-dogovor-podryada'],
  },
  'tu': {
    label: 'Технические условия',
    promptId: 'post-140-tu-rasshifrovka',
    alternatives: ['post-140-tu-plan'],
  },
  'oformlenie': {
    label: 'Том ПД: оформление по ГОСТ Р 21.101',
    promptId: 'post-195-gost-21101-2026',
    alternatives: [],
  },
  'grafik': {
    // промпт из комментариев к посту 165, передан владельцем 28.08.2026;
    // XML из MS Project читается как текст
    label: 'График проекта (ГПР / MS Project)',
    promptId: 'dop-post-165-grafik-riski',
    alternatives: ['kniga-3-03-kriticheskij-put'],
  },
};

/** Типы, которые классификатор может назвать, но прогон по ним не делается. */
const SPECIAL_TYPES = {
  tz: {
    label: 'Задание на проектирование (ТЗ/ЗнП)',
    note: 'Для ТЗ на платформе есть отдельный модуль «Анализ ТЗ» — проверка там полнее: чек-листы состава, вердикт готовности, экспорт заключения.',
  },
  neizvestno: {
    label: 'Тип не определён',
    note: 'Выберите тип документа вручную — и проверка запустится нужным промптом.',
  },
};

const DOC_TYPES = [...Object.keys(ROUTES), ...Object.keys(SPECIAL_TYPES)];

/* ---------------- детерминированная классификация ---------------- */

/**
 * Маркеры типа: ищутся в имени файла и первых страницах текста. Порядок
 * значим — специфичное раньше общего. Совпал ровно ОДИН тип → уверенный
 * ответ кода; ноль или несколько → решает модель (или человек).
 */
const MARKERS = [
  ['ks2', ['кс-2', 'кс-3', 'акт о приемке выполненных работ', 'акт о приёмке выполненных работ']],
  ['akt-aosr', ['акт освидетельствования скрытых работ', 'освидетельствования скрытых', 'аоср']],
  ['vor', ['ведомость объемов работ', 'ведомость объёмов работ']],
  ['smeta', ['локальная смета', 'локальный сметный расчет', 'локальный сметный расчёт',
    'сводный сметный расчет', 'сводный сметный расчёт']],
  ['tz', ['задание на проектирование', 'техническое задание']],
  ['dogovor', ['договор подряда', 'договор строительного подряда', 'договор генерального подряда']],
  ['tu', ['технические условия на подключение', 'технические условия подключения',
    'точка присоединения', 'условия подключения к сетям']],
  ['razdel-pb', ['мероприятия по обеспечению пожарной безопасности']],
  ['razdel-pos', ['проект организации строительства', 'стройгенплан', 'строительный генеральный план']],
  ['razdel-ov-vk', ['отопление, вентиляция и кондиционирование', 'отопление и вентиляция',
    'водоснабжение и водоотведение', 'общеобменная вентиляция', 'система водоотведения']],
  ['razdel-km', ['конструкции металлические', 'металлокаркас', 'металлоконструкци']],
  ['razdel-kzh', ['конструкции железобетонные', 'защитный слой бетона', 'схема армирования',
    'конструктивные и объемно-планировочные', 'конструктивные и объёмно-планировочные']],
  ['razdel-ar', ['архитектурные решения']],
  ['razdel-pzu', ['планировочная организация земельного участка', 'градостроительный план земельного участка']],
  ['grafik', ['schemas.microsoft.com/project', 'график производства работ', 'календарно-сетевой график']],
];

const CLASSIFY_HEAD = 12_000; // маркеры ищутся по началу документа: титул и общие данные

function classifyByMarkers(filename, text) {
  const hay = `${String(filename || '')}\n${String(text || '').slice(0, CLASSIFY_HEAD)}`.toLowerCase();
  const hits = [];
  for (const [type, words] of MARKERS) {
    const word = words.find((w) => hay.includes(w));
    if (word) hits.push({ type, evidence: word });
  }
  if (hits.length === 1) return { ...hits[0], via: 'маркеры' };
  return { type: null, candidates: hits.map((x) => x.type), via: 'маркеры' };
}

/* ---------------- справочное ---------------- */

function typeLabel(type) {
  if (ROUTES[type]) return ROUTES[type].label;
  if (SPECIAL_TYPES[type]) return SPECIAL_TYPES[type].label;
  return type || '—';
}

/** Мета для интерфейса: типы с промптами (и заголовками из библиотеки). */
function meta() {
  const types = [];
  for (const [type, route] of Object.entries(ROUTES)) {
    let promptTitle = route.promptId;
    try { promptTitle = byId(route.promptId).title || route.promptId; } catch { /* нет файла — увидит тест */ }
    // альтернативы — с заголовками из библиотеки: голые id (dop-kr-k02…) человеку ничего не говорят
    const alternativeTitles = route.alternatives.map((id) => {
      let title = id;
      try { title = byId(id).title || id; } catch { /* нет файла — увидит тест */ }
      return { id, title };
    });
    types.push({ id: type, label: route.label, promptId: route.promptId, promptTitle,
      alternatives: route.alternatives, alternativeTitles });
  }
  for (const [type, sp] of Object.entries(SPECIAL_TYPES)) {
    types.push({ id: type, label: sp.label, promptId: null, promptTitle: null, note: sp.note, alternatives: [] });
  }
  return types;
}

module.exports = { DIR, byId, ROUTES, SPECIAL_TYPES, DOC_TYPES, classifyByMarkers, typeLabel, meta };
