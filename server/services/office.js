'use strict';

/**
 * «Виртуальный офис» — демо-витрина платформы (страница /office.html).
 *
 * Жёсткое правило вида: зал ЧИТАЕТ боевые данные и не пишет туда ни байта.
 * Всё своё — чат секретаря и агентов, журнал посещений, кэш миниатюр —
 * живёт в отдельной базе data/office.db и в папке data/office-thumbs.
 * Единственное исключение — учёт обращений к моделям: чат зала считается
 * обычным обращением (служебная сессия status='service' + usage_events),
 * ровно как у «Проверки документа».
 */

const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const config = require('../config');
const { db } = require('../db');
const projects = require('./projects');

const now = () => new Date().toISOString();

/* ---------------- своя база ---------------- */

let officeDb = null;

function odb() {
  if (officeDb) return officeDb;
  fs.mkdirSync(config.dataDir, { recursive: true });
  officeDb = new DatabaseSync(path.join(config.dataDir, 'office.db'));
  officeDb.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS office_messages (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,              -- concierge | agent:<module> | feature:<id>
      project_id TEXT NOT NULL DEFAULT '',
      user_name TEXT NOT NULL DEFAULT '',
      role TEXT NOT NULL,              -- user | assistant
      content TEXT NOT NULL,
      provider TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_office_messages ON office_messages(kind, project_id, created_at);
    CREATE TABLE IF NOT EXISTS office_visits (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL DEFAULT '',
      user_name TEXT NOT NULL DEFAULT '',
      host TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS office_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  return officeDb;
}

/* ---------------- персоны зала ---------------- */

/**
 * Агент за столом — модуль платформы (решение владельца, вариант «а»).
 * Имена вымышленные; настоящие данные — только в журнале и сводке.
 */
const PERSONAS = [
  {
    module: 'tz', name: 'Марина Ткачёва', role: 'Инженер по исходным данным',
    blurb: 'Разбираю задание на проектирование: три прохода по чек-листам, дедупликация находок, выгрузки в XLSX и DOCX.',
    skills: ['чек-листы ТЗ', 'три прохода анализа', 'дедупликация находок', 'экспорт XLSX/DOCX'],
    prompts: ['tz-classify', 'tz-completeness', 'tz-findings'],
  },
  {
    module: 'site', name: 'Глеб Каменев', role: 'Главный геометр',
    blurb: 'Сажаю здание на участок: границы по точкам ГПЗУ, зоны ограничений, варианты пятна и комплект с чертежом. Координаты считает движок, не модель.',
    skills: ['поворотные точки ГПЗУ', 'зоны ограничений', 'варианты посадки', 'DXF/DWG'],
    prompts: ['system-prompt', 'restriction-extract', 'parcel-source'],
  },
  {
    module: 'doc', name: 'Ирина Соболева', role: 'Эксперт по документации',
    blurb: 'Проверяю документы по профильным промптам библиотеки и веду замену A→B под проверку.',
    skills: ['автоподбор промпта', 'ссылки на НТД', 'замена A→B', 'экспорт отчёта'],
    prompts: ['doccheck-classify', 'doccheck-run', 'doccheck-ab'],
  },
  {
    module: 'normo', name: 'Павел Строев', role: 'Нормоконтролёр',
    blurb: 'Веду комплекты нормоконтроля: правила, проверки версий, диффы и заключение DOCX.',
    skills: ['правила нормоконтроля', 'версии разделов', 'диффы', 'заключение DOCX'],
    prompts: ['normo-check', 'normo-coverage', 'normo-extract-requirements'],
  },
  {
    module: 'gge', name: 'Светлана Орлова', role: 'Входной контроль ГГЭ',
    blurb: 'Проверяю комплект перед экспертизой: имена и размеры по приказу 783/пр, текстовый слой, реквизиты и даты.',
    skills: ['приказ 783/пр', 'текстовый слой', 'сверка реквизитов', 'развилки дат'],
    prompts: [],
  },
  {
    module: 'akty', name: 'Артём Акимов', role: 'Инженер ПТО',
    blurb: 'Собираю акты АОСР: читаю реестры XLSX, готовлю черновики из шаблона DOCX и сверяю даты.',
    skills: ['реестры XLSX', 'черновики АОСР', 'сверка дат'],
    prompts: [],
  },
];

const SECRETARY = {
  module: 'lobby', name: 'Вера Лаврова', role: 'Администратор',
  blurb: 'Встречаю гостей, помогаю выбрать проект и рассказываю, как устроена платформа.',
};

const TEA_MASTER = {
  module: 'lounge', name: 'Даниил Чагин', role: 'Мастер чайной церемонии',
  blurb: 'Завариваю чай для зала и знаю о чае больше, чем платформа о нормативах.',
};

function personaByModule(module) {
  return PERSONAS.find((p) => p.module === module) || null;
}

/* ---------------- сцена ---------------- */

function latestSiteSession(projectId) {
  // последняя активная сессия проекта, у которой есть план — по ней живут
  // стол, журнал геометра и центральный экран
  const rows = db.prepare(`
    SELECT s.id, s.updated_at, s.job_status FROM sessions s
    WHERE s.project_id = ? AND s.status = 'active'
    ORDER BY s.updated_at DESC LIMIT 20`).all(projectId);
  for (const s of rows) {
    const plan = db.prepare('SELECT id FROM plans WHERE session_id = ? ORDER BY version DESC LIMIT 1').get(s.id);
    if (plan) return { ...s, planId: plan.id };
  }
  return rows[0] ? { ...rows[0], planId: null } : null;
}

function slimGeometry(obj) {
  if (!obj) return null;
  const g = obj.geometry || {};
  const out = { type: g.type || 'polygon' };
  if (g.type === 'multipolygon') {
    out.polygons = (g.polygons || []).map((p) => ({ points: p.points, holes: p.holes || [] }));
  } else {
    out.points = g.points || [];
    out.holes = g.holes || [];
  }
  return out;
}

/**
 * Геометрия для стола: участок, зоны, допустимая территория и варианты
 * посадки. Только ЧТЕНИЕ сохранённого: ensurePlan здесь не зовётся — витрина
 * не имеет права запускать разбор чертежей и пересчёт зон.
 */
function tableGeometry(sessionId) {
  const planRow = db.prepare('SELECT * FROM plans WHERE session_id = ? ORDER BY version DESC LIMIT 1').get(sessionId);
  if (!planRow) return null;
  let site;
  try { site = JSON.parse(planRow.geometry); } catch { return null; }
  try {
    site = require('./geometry/plan').applyUserEdits(sessionId, site);
  } catch { /* правки не приложились — показываем чистый разбор */ }

  let zones = [];
  let buildable = null;
  try {
    const z = require('./geometry/zones').latest(sessionId);
    const built = z && z.zones;
    if (built) {
      zones = (built.restrictions || []).map((r) => ({
        id: r.id,
        kind: (r.properties && r.properties.kind) || 'other',
        label: (r.properties && (r.properties.sourceLabel || r.properties.statusLabel)) || 'зона',
        geometry: slimGeometry(r),
        areaM2: (r.properties && r.properties.areaM2) || null,
      }));
      if (built.buildable) {
        const b = built.buildable;
        buildable = {
          geometry: b.geometry ? slimGeometry(b) : null,
          areaM2: b.areaM2 ?? (b.properties && b.properties.areaM2) ?? null,
          sharePercent: b.sharePercent ?? null,
        };
      }
    }
  } catch { /* зоны — надстройка, их отсутствие стол не роняет */ }

  let run = null;
  try {
    const r = require('./geometry/placement-runs').latestRun(sessionId);
    if (r) {
      run = {
        createdAt: r.createdAt,
        criterion: r.criterion,
        variants: (r.variants || []).map((v) => ({
          id: v.id,
          number: v.number,
          footprint: v.footprint,
          floors: (v.metrics && v.metrics.floors) || (r.requirements && r.requirements.floors) || 1,
          areaM2: (v.metrics && v.metrics.areaM2) || null,
          status: v.status,
          statusLabel: v.statusLabel,
          selected: !!v.selected,
        })),
      };
    }
  } catch { /* вариантов может не быть — стол покажет один участок */ }

  const objects = []
    .concat(site.buildings || [], site.utilities || [], site.existingObjects || [])
    .slice(0, 220)
    .map((o) => ({
      id: o.id, type: o.type,
      geometry: slimGeometry(o),
      label: (o.properties && (o.properties.userLabel || o.properties.label)) || '',
      heightM: (o.properties && o.properties.heightM) || null,
      decision: (o.properties && o.properties.decision) || '',
    }));

  return {
    parcel: site.parcel ? { geometry: slimGeometry(site.parcel), areaM2: site.parcel.properties && site.parcel.properties.areaM2 } : null,
    zones,
    buildable,
    run,
    objects,
    units: site.coordinateSystem ? (site.coordinateSystem.sourceUnits || '') : '',
  };
}

function journalTail(sessionId, limit = 20) {
  return db.prepare('SELECT stage, detail, level, created_at FROM events WHERE session_id = ? ORDER BY id DESC LIMIT ?')
    .all(sessionId, limit)
    .map((e) => ({ stage: e.stage, detail: e.detail, level: e.level, at: e.created_at }))
    .reverse();
}

function sessionDocs(sessionId) {
  return db.prepare('SELECT id, original_name, ext, size FROM files WHERE session_id = ? ORDER BY created_at LIMIT 12')
    .all(sessionId)
    .map((f) => ({ id: f.id, name: f.original_name, ext: String(f.ext || '').toLowerCase(), size: f.size }));
}

async function sceneData({ projectId = '', user = null, host = '' }) {
  // Без проекта зал живёт тоже: лобби, фишки и общие цифры платформы. Так
  // гость без входа видит витрину, не получая ни байта чужих проектных данных.
  let project = null;
  let summary = null;
  let session = null;
  if (projectId) {
    project = projects.byId(projectId);
    if (!project || !projects.canSee(project, user)) { const e = new Error('Проект не найден'); e.status = 404; throw e; }
    summary = (await projects.summarize([project.id], user))[project.id];
    session = latestSiteSession(project.id);
  }

  let progress = null;
  let journal = [];
  let docs = [];
  let geometry = null;
  if (session) {
    try { progress = require('./progress').get(session.id) || null; } catch { progress = null; }
    journal = journalTail(session.id);
    docs = sessionDocs(session.id);
    geometry = tableGeometry(session.id);
  }

  let stats = null;
  try {
    const o = require('./stats').overview({ userId: '', days: 30 });
    stats = {
      days: 30,
      requests: o.totals.requests || 0,
      tokens: (o.totals.inputTokens || 0) + (o.totals.outputTokens || 0),
      costUsd: o.totals.costUsd || 0,
      byDay: (o.byDay || []).slice(-14),
      byProvider: (o.byProvider || []).slice(0, 8),
    };
  } catch { stats = null; }

  let balances = [];
  try {
    balances = (await require('./balance').forProviders(30)).map((x) => ({
      id: x.id,
      label: x.label,
      availableUsd: (x.balance && x.balance.availableUsd !== undefined) ? x.balance.availableUsd : null,
      spentUsd: x.ownSpentUsd ?? null,
      note: (x.balance && x.balance.note) || '',
    }));
  } catch { balances = []; }

  return {
    project: project ? { id: project.id, name: project.name, fullName: project.full_name || '', client: project.client || '', stage: project.stage || '' } : null,
    modules: summary,
    session: session ? { id: session.id, jobStatus: session.job_status, updatedAt: session.updated_at } : null,
    progress,
    journal,
    docs,
    geometry,
    stats,
    balances,
    personas: { agents: PERSONAS.map(({ prompts, ...p }) => p), secretary: SECRETARY, teaMaster: TEA_MASTER },
    now: now(),
  };
}

/* ---------------- карточка агента ---------------- */

function agentCard({ module, projectId, user = null }) {
  const persona = personaByModule(module);
  if (!persona) { const e = new Error('Такого агента в зале нет'); e.status = 404; throw e; }
  const prompts = require('./prompts');
  const files = [];
  for (const name of persona.prompts) {
    try {
      const text = prompts.load(name);
      files.push({ name: `prompts/${name}.md`, excerpt: text.slice(0, 1200), length: text.length });
    } catch { /* промт мог переехать — карточка не падает */ }
  }
  let journal = [];
  if (module === 'site' && projectId) {
    const session = latestSiteSession(projectId);
    if (session) journal = journalTail(session.id, 40);
  }
  return { persona: { ...persona, prompts: undefined }, promptFiles: files, journal };
}

/* ---------------- чат зала ---------------- */

const CHAT_KINDS = /^(concierge|agent:(tz|site|doc|normo|gge|akty)|feature:(cube|chess|go|tea|drafting|model|level))$/;

function chatHistory({ kind, projectId = '', limit = 50 }) {
  if (!CHAT_KINDS.test(kind)) { const e = new Error('Неизвестный собеседник'); e.status = 400; throw e; }
  return odb().prepare('SELECT role, content, provider, model, created_at FROM office_messages WHERE kind = ? AND project_id = ? ORDER BY created_at DESC LIMIT ?')
    .all(kind, projectId, limit)
    .map((m) => ({ role: m.role, content: m.content, provider: m.provider, model: m.model, at: m.created_at }))
    .reverse();
}

function saveMessage({ kind, projectId = '', userName = '', role, content, provider = '', model = '' }) {
  odb().prepare('INSERT INTO office_messages (id, kind, project_id, user_name, role, content, provider, model, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(crypto.randomUUID(), kind, projectId, userName, role, content, provider, model, now());
}

function recordVisit({ projectId = '', userName = '', host = '' }) {
  odb().prepare('INSERT INTO office_visits (id, project_id, user_name, host, created_at) VALUES (?,?,?,?,?)')
    .run(crypto.randomUUID(), projectId, userName, host, now());
}

/**
 * Служебная сессия учёта обращений зала — одна на проект, живёт в основной
 * базе со status='service' (в списках сессий её нет), указатель — в office.db.
 */
function ensureServiceSession(projectId, user, host = '') {
  const key = `session:${projectId || 'lobby'}`;
  const meta = odb().prepare('SELECT value FROM office_meta WHERE key = ?').get(key);
  if (meta) {
    const row = db.prepare('SELECT id, origin_host FROM sessions WHERE id = ?').get(meta.value);
    if (row) {
      if (host && row.origin_host !== host) db.prepare('UPDATE sessions SET origin_host = ? WHERE id = ?').run(host, row.id);
      return row.id;
    }
  }
  const id = crypto.randomUUID();
  db.prepare(`INSERT INTO sessions (id, token, token_hash, status, device_id, user_id, prompt_version, origin_host, title, project_id, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, '', crypto.createHash('sha256').update(crypto.randomBytes(32)).digest('hex'), 'service', '',
    (user && user.id) || '', config.promptVersion, host,
    'Виртуальный офис', projectId || 'legacy', now(), now());
  odb().prepare('INSERT OR REPLACE INTO office_meta (key, value) VALUES (?,?)').run(key, id);
  return id;
}

async function pickRoute({ user, host, provider = '', model = '' }) {
  const providers = require('./providers');
  if (provider) {
    const check = await providers.validateChoice(provider, model || undefined, user, host);
    if (!check.ok) { const e = new Error(check.error); e.status = 422; throw e; }
    return { provider, model: model || undefined };
  }
  const list = await providers.listProvidersFor(user, host);
  const first = list.find((p) => p.available);
  if (!first) { const e = new Error('Ни одна модель сейчас недоступна — зал отвечает только текстом декораций'); e.status = 503; throw e; }
  return { provider: first.id, model: undefined };
}

function moduleLines(summary) {
  const NAMES = { tz: '1 · Анализ ТЗ', site: '2 · Посадка здания', doc: '3 · Проверка документа', normo: '4 · Нормоконтроль', gge: '5 · Контроль ГГЭ', akty: '6 · Акты (АОСР)' };
  return Object.entries(NAMES)
    .map(([k, label]) => `${label}: ${summary && summary[k] ? summary[k].line : 'нет данных'}`)
    .join('\n');
}

async function chat({ kind, projectId = '', message, user = null, host = '', provider = '', model = '' }) {
  if (!CHAT_KINDS.test(kind)) { const e = new Error('Неизвестный собеседник'); e.status = 400; throw e; }
  const text = String(message || '').trim();
  if (!text) { const e = new Error('Пустое сообщение'); e.status = 422; throw e; }
  if (text.length > 4000) { const e = new Error('Сообщение длиннее 4000 знаков'); e.status = 422; throw e; }

  const prompts = require('./prompts');
  const adapter = require('./claude/adapter');

  let project = null;
  let summary = null;
  if (projectId) {
    project = projects.byId(projectId);
    if (!project || !projects.canSee(project, user)) { const e = new Error('Проект не найден'); e.status = 404; throw e; }
    summary = (await projects.summarize([project.id], user))[project.id];
  }

  let system;
  if (kind === 'concierge') {
    system = prompts.load('office-concierge', {
      userName: (user && user.name) || 'гость',
      projectName: project ? project.name : 'проект пока не выбран',
      modules: summary ? moduleLines(summary) : 'проект не выбран — сводки нет',
    });
  } else if (kind.startsWith('agent:')) {
    const persona = personaByModule(kind.slice(6));
    if (!persona) { const e = new Error('Такого агента в зале нет'); e.status = 404; throw e; }
    const stateLine = summary && summary[persona.module] ? summary[persona.module].line : 'нет данных';
    system = prompts.load('office-agent', {
      name: persona.name, role: persona.role, blurb: persona.blurb,
      skills: persona.skills.join(', '),
      projectName: project ? project.name : 'проект не выбран',
      stateLine,
    });
  } else {
    const TOPICS = {
      cube: 'кубик Рубика: устройство, рекорды, метод Коцембы, история Эрнё Рубика',
      chess: 'шахматы: знаменитые партии, дебюты, чемпионы мира, шахматные движки',
      go: 'го: знаменитые партии, Го Сэйгэн, AlphaGo, правила и философия игры',
      tea: 'чай и чайная церемония: сорта, заваривание, история',
      drafting: 'кульман, чертёжное дело и история инженерной графики',
      model: 'архитектурные макеты и промышленное проектирование',
      level: 'геодезия: нивелир, теодолит, съёмка местности',
    };
    system = prompts.load('office-feature', { topic: TOPICS[kind.slice(8)] || kind.slice(8) });
  }

  const history = chatHistory({ kind, projectId, limit: 12 })
    .map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }));

  const route = await pickRoute({ user, host, provider, model });
  const sessionId = ensureServiceSession(projectId, user, host);

  const out = await adapter.plainCall({
    system,
    messages: [...history, { role: 'user', content: text }],
    sessionId,
    route,
    maxTokens: 1200,
  });

  const reply = (out.text || '').trim() || 'Секретарь молчит — попробуйте ещё раз.';
  const userName = (user && user.name) || '';
  saveMessage({ kind, projectId, userName, role: 'user', content: text });
  saveMessage({ kind, projectId, userName, role: 'assistant', content: reply, provider: route.provider, model: route.model || '' });
  return { reply, provider: route.provider, model: route.model || '', truncated: !!out.truncated };
}

/* ---------------- миниатюры документов ---------------- */

const THUMB_DIR = () => path.join(config.dataDir, 'office-thumbs');

/**
 * Миниатюра первой страницы PDF для нижней полосы центрального экрана.
 * Кэш живёт в папке офиса; исходный файл только читается.
 */
async function docThumb({ fileId, projectId, user = null }) {
  const f = db.prepare(`
    SELECT f.id, f.stored_path, f.ext, f.session_id, s.project_id FROM files f
    JOIN sessions s ON s.id = f.session_id
    WHERE f.id = ?`).get(fileId);
  if (!f || (projectId && f.project_id !== projectId)) { const e = new Error('Файл не найден'); e.status = 404; throw e; }
  const project = projects.byId(f.project_id);
  if (!project || !projects.canSee(project, user)) { const e = new Error('Файл не найден'); e.status = 404; throw e; }
  if (String(f.ext || '').toLowerCase() !== 'pdf') { const e = new Error('Миниатюры есть только у PDF'); e.status = 404; throw e; }

  let srcStat;
  try { srcStat = fs.statSync(f.stored_path); } catch { const e = new Error('Файл не найден'); e.status = 404; throw e; }

  fs.mkdirSync(THUMB_DIR(), { recursive: true });
  const thumbPath = path.join(THUMB_DIR(), `${f.id}-${Math.round(srcStat.mtimeMs)}.png`);
  if (fs.existsSync(thumbPath)) return thumbPath;

  const { execFile } = require('node:child_process');
  const os = require('node:os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'office-thumb-'));
  await new Promise((resolve, reject) => {
    execFile('pdftoppm', ['-f', '1', '-l', '1', '-r', '36', '-png', f.stored_path, path.join(tmp, 'p')],
      { timeout: 20000 }, (err) => (err ? reject(err) : resolve()));
  });
  const made = fs.readdirSync(tmp).find((x) => x.endsWith('.png'));
  if (!made) { const e = new Error('Миниатюра не получилась'); e.status = 500; throw e; }
  fs.copyFileSync(path.join(tmp, made), thumbPath);
  fs.rmSync(tmp, { recursive: true, force: true });
  return thumbPath;
}

module.exports = {
  sceneData, agentCard, chat, chatHistory, recordVisit, docThumb,
  PERSONAS, SECRETARY, TEA_MASTER,
  // открыто для тестов
  ensureServiceSession, odb, tableGeometry, latestSiteSession,
};
