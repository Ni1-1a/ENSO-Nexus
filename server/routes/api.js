'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const config = require('../config');
const { db, now } = require('../db');
const { sanitizeFilename, validateUpload } = require('../services/validation');
const pipeline = require('../services/pipeline');
const stages = require('../services/stages');
const { rateLimit, sessionAuth, userAuth, optionalUser, sessionOwner } = require('../middleware');

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxFileSizeBytes + 1024, files: 5 },
});

const generalLimit = rateLimit(config.rateLimitGeneral, 'general');
const expensiveLimit = rateLimit(config.rateLimitExpensive, 'expensive');
router.use(generalLimit);

/* ---------- health ---------- */
router.get('/health', optionalUser, async (req, res) => {
  // CORS: страница-вход на GitHub Pages проверяет доступность сервера перед переходом
  res.setHeader('Access-Control-Allow-Origin', '*');
  let kb = { enabled: false };
  let providers = [];
  try { kb = require('../services/kb').status(); } catch {}
  // список зависит от того, кто спрашивает: облачные модели видит только тот,
  // кому они разрешены. Ответ этой ручки уходит и анониму (её опрашивает
  // страница-вход), поэтому фильтр обязан работать и без токена человека.
  try { providers = await require('../services/providers').listProvidersFor(req.user); } catch {}
  res.json({
    ok: true,
    kb,
    providers,
    kbBases: config.kbBases.map((b) => ({ id: b.id, label: b.label })),
    aiMode: config.aiMode,
    model: config.aiMode === 'live' ? config.anthropicModel
      : config.aiMode === 'local' ? config.localAiModel : null,
    // локальная связка: текстовая модель анализа + vision-модель для графики/сканов
    localBundle: { text: config.localAiModel, vision: config.localAiOcrModel },
    promptVersion: config.promptVersion,
    limits: {
      maxFileSizeMb: Math.round(config.maxFileSizeBytes / 1048576),
      maxTotalUploadMb: Math.round(config.maxTotalUploadBytes / 1048576),
      maxFiles: config.maxFilesPerSession,
      allowedExtensions: config.allowedExtensions,
      visionMaxPages: config.visionMaxPages,
      maxMessageLength: config.maxMessageLength,
      sessionTtlHours: config.sessionTtlHours,
    },
  });
});

/* ---------- вход на платформу ---------- */
const users = require('../services/users');
// Вход без пароля: ограничитель попыток — единственная компенсация перебора ФИО,
// поэтому потолок на соединение здесь жёстче обычного. Подставленный
// X-Forwarded-For заводит новое ведро посетителя, но не новое ведро соединения.
const authLimit = rateLimit(config.rateLimitAuth, 'auth', { peerFactor: 5 });

/** Состояние входа: нужен ли он вообще и какой сейчас режим регистрации. */
router.get('/auth/state', (req, res) => {
  const s = users.state();
  res.json({ requireLogin: config.requireLogin, registration: s.registration });
});

/**
 * Регистрация и вход — одна дверь.
 *
 * Ответ намеренно ОДИНАКОВ для нового и существующего имени: иначе форма
 * входа превращается в проверялку, кто зарегистрирован на платформе.
 * Наружу уходит либо токен, либо «ждите одобрения», либо «проверьте написание».
 */
router.post('/auth/enter', authLimit, express.json(), (req, res) => {
  const result = users.enter({
    lastName: req.body?.lastName,
    firstName: req.body?.firstName,
    ip: req.ip,
    deviceId: normDeviceId(req.body?.deviceId),
  });
  if (result.status === 'invalid') {
    return res.status(400).json({
      status: 'invalid',
      error: 'Проверьте написание: фамилия и имя — буквы, дефис или апостроф, до 60 символов.',
    });
  }
  if (result.status === 'pending') {
    return res.json({
      status: 'pending',
      message: 'Заявка отправлена. Доступ откроется, когда владелец платформы её одобрит.',
    });
  }
  res.json({ status: 'active', token: result.token, user: result.user });
});

/** Кто вошёл. Ответ используется, чтобы не показывать экран входа заново. */
router.get('/auth/me', optionalUser, (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Не выполнен вход', needLogin: true });
  if (!req.user.approved) return res.json({ status: 'pending', user: users.publicUser(req.user) });
  res.json({ status: 'active', user: users.publicUser(req.user) });
});

router.post('/auth/logout', optionalUser, express.json(), (req, res) => {
  if (req.userToken) users.logout(req.userToken);
  res.json({ ok: true });
});

/* ---------- sessions ---------- */
/** ID устройства: случайная строка, которую браузер хранит у себя. */
function normDeviceId(v) {
  const s = String(v || '').trim();
  return /^[\w-]{8,64}$/.test(s) ? s : '';
}

router.post('/sessions', expensiveLimit, userAuth, express.json(), (req, res) => {
  const id = crypto.randomUUID();
  const token = crypto.randomBytes(32).toString('hex');
  const deviceId = normDeviceId(req.body?.deviceId);
  db.prepare('INSERT INTO sessions (id, token, device_id, user_id, prompt_version, created_at, updated_at) VALUES (?,?,?,?,?,?,?)')
    .run(id, token, deviceId, (req.user && req.user.id) || '', config.promptVersion, now(), now());
  pipeline.logEvent(id, 'Сессия создана');
  res.status(201).json({ id, token });
});

/* ---------- проекты человека (несколько проектов параллельно) ---------- */
/**
 * Список проектов. Раньше он собирался по ID устройства; теперь, когда есть
 * вход, — по человеку: свои проекты видно с любого устройства. Привязка к
 * устройству осталась как запасной путь для проектов, заведённых до входа.
 */
router.get('/devices/:deviceId/sessions', userAuth, (req, res) => {
  const deviceId = normDeviceId(req.params.deviceId);
  if (!deviceId) return res.status(400).json({ error: 'Некорректный ID устройства' });
  const userId = (req.user && req.user.id) || '';
  // Ответ содержит токены проектов, поэтому маршрут закрыт входом. Отдаём
  // СВОИ проекты плюс «ничьи» проекты этого же устройства — те, что заведены
  // до появления входа: они подхватятся и закрепятся при первом открытии.
  const sessions = db.prepare(`
    SELECT s.id, s.token, s.title, s.job_status AS jobStatus,
           s.created_at AS createdAt, s.updated_at AS updatedAt,
           (SELECT COUNT(*) FROM files f WHERE f.session_id = s.id) AS files
    FROM sessions s
    WHERE s.status = 'active'
      AND ((? <> '' AND s.user_id = ?) OR (s.user_id = '' AND s.device_id = ?))
    ORDER BY s.updated_at DESC LIMIT 50`).all(userId, userId, deviceId);
  res.json({ sessions });
});

/* привязать существующую сессию к устройству (миграция старых сессий) */
router.post('/sessions/:id/device', sessionAuth, optionalUser, sessionOwner, express.json(), (req, res) => {
  const deviceId = normDeviceId(req.body?.deviceId);
  if (!deviceId) return res.status(400).json({ error: 'Некорректный ID устройства' });
  db.prepare('UPDATE sessions SET device_id = ? WHERE id = ?').run(deviceId, req.session.id);
  // проект, заведённый до входа, закрепляется за вошедшим — но чужой не отбираем
  if (req.user && req.user.approved && !req.session.user_id) {
    db.prepare('UPDATE sessions SET user_id = ? WHERE id = ?').run(req.user.id, req.session.id);
  }
  res.json({ ok: true });
});

function sessionView(session) {
  const adapter = require('../services/claude/adapter');
  const progress = require('../services/progress');
  const route = adapter.effectiveProvider(session);
  const files = db.prepare('SELECT id, original_name AS name, size, ext, created_at FROM files WHERE session_id = ? ORDER BY created_at').all(session.id);
  const messages = db.prepare('SELECT id, role, kind, content, created_at FROM messages WHERE session_id = ? ORDER BY created_at, rowid').all(session.id);
  const parseOpts = (s) => { try { const a = JSON.parse(s); return Array.isArray(a) ? a : []; } catch { return []; } };
  const questions = db.prepare('SELECT id, text, why, status, answer, options, created_at FROM questions WHERE session_id = ? ORDER BY created_at').all(session.id)
    .map((q) => ({ ...q, options: parseOpts(q.options) }));
  // новые события первыми — журнал в UI строится снизу вверх
  const events = db.prepare('SELECT stage, detail, level, created_at FROM events WHERE session_id = ? ORDER BY id DESC LIMIT 50').all(session.id);
  const results = db.prepare('SELECT id, filename, title, format, size, created_at FROM results WHERE session_id = ? ORDER BY created_at').all(session.id);
  const facts = db.prepare('SELECT key, value, source FROM facts WHERE session_id = ? ORDER BY created_at').all(session.id);
  return {
    id: session.id,
    title: session.title || '',
    jobStatus: session.job_status,
    comment: session.comment,
    settings: {
      aiProvider: session.ai_provider || '',
      aiModel: session.ai_model || '',
      kbChoice: session.kb_choice || 'main',
    },
    aiRequests: session.ai_requests,
    // расход сессии: токены и стоимость облачных запросов (локальные бесплатны)
    usage: {
      inputTokens: session.input_tokens,
      outputTokens: session.output_tokens,
      costUsd: session.cost_usd || 0,
      aiRequests: session.ai_requests,
      // служебные вызовы (распознавание страниц, конспекты) считаются отдельно:
      // они не расходуют лимит проекта, но работа не должна пропадать из отчёта
      aiSubrequests: session.ai_subrequests || 0,
    },
    // действующий маршрут AI этой сессии — для бейджа в шапке
    ai: { provider: route.provider, model: adapter.resolveModel(route) },
    // порядок работы (стандартный или загруженный пользователем Excel)
    workplan: require('../services/workplan').forSession(session),
    jobProgress: progress.get(session.id),
    // этап работы: по нему интерфейс понимает, чего сейчас ждут от человека
    stage: session.stage || 'idle',
    stageLabel: stages.STAGE_LABELS[session.stage] || '',
    // «помощник отвечает» — это НЕ тяжёлая задача: карточка прогресса,
    // виджет уточнений и точка проекта живут по job_status и не должны
    // гаснуть на каждую реплику в диалоге
    chatBusy: pipeline.isChatBusy(session.id),
    pendingChats: pipeline.pendingChatCount(session.id),
    // требования к зданию, найденные в фактах: подставляются в форму согласования.
    // null — значит в исходных данных их нет и спросить придётся человека
    suggestedRequirements: stages.requirementsFromFacts(session.id),
    createdAt: session.created_at,
    updatedAt: session.updated_at,
    files, messages, questions, events, results, facts,
  };
}

router.get('/sessions/:id', sessionAuth, (req, res) => {
  res.json(sessionView(req.session));
});

router.get('/sessions/:id/status', sessionAuth, (req, res) => {
  const events = db.prepare('SELECT stage, detail, level, created_at FROM events WHERE session_id = ? ORDER BY id DESC LIMIT 50').all(req.session.id);
  res.json({ jobStatus: req.session.job_status, events });
});

router.get('/sessions/:id/messages', sessionAuth, (req, res) => {
  const messages = db.prepare('SELECT id, role, kind, content, created_at FROM messages WHERE session_id = ? ORDER BY created_at').all(req.session.id);
  res.json({ messages });
});

router.delete('/sessions/:id', sessionAuth, sessionOwner, (req, res) => {
  deleteSessionData(req.session.id);
  res.json({ ok: true });
});

function deleteSessionData(sessionId) {
  // Задачу сначала прерываем: иначе она продолжает считать уже удалённый проект
  // (и тратить токены), а её записи в журнал падают на внешнем ключе.
  try { pipeline.cancelJob(sessionId); } catch { /* нечего прерывать */ }
  for (const table of ['files', 'results']) {
    const rows = db.prepare(`SELECT stored_path FROM ${table} WHERE session_id = ?`).all(sessionId);
    for (const r of rows) { try { fs.unlinkSync(r.stored_path); } catch {} }
  }
  for (const dir of [path.join(config.dataDir, 'uploads', sessionId), path.join(config.dataDir, 'outputs', sessionId)]) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
  // plan_zones внешнего ключа на sessions не имеет намеренно (запись живёт
  // при версии плана, а не при проекте), поэтому каскад её не заберёт —
  // чистим руками, иначе полигоны удалённых проектов остаются в базе навсегда
  try { require('../services/geometry/zones').clear(sessionId); } catch { /* таблицы может не быть */ }
  db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId); // cascades to child tables
}

/* ---------- files ---------- */
router.post('/sessions/:id/files', sessionAuth, sessionOwner, expensiveLimit, upload.array('files', 5), (req, res) => {
  const uploaded = [];
  const errors = [];
  const incoming = req.files || [];
  if (!incoming.length) return res.status(400).json({ error: 'Файлы не переданы' });

  for (const f of incoming) {
    const originalName = sanitizeFilename(Buffer.from(f.originalname, 'latin1').toString('utf8'));
    const existing = db.prepare('SELECT size FROM files WHERE session_id = ?').all(req.session.id);
    const check = validateUpload({ originalName, buffer: f.buffer }, existing);
    if (!check.ok) { errors.push({ name: originalName, error: check.error }); continue; }

    const id = crypto.randomUUID();
    const dir = path.join(config.dataDir, 'uploads', req.session.id);
    fs.mkdirSync(dir, { recursive: true });
    const storedPath = path.join(dir, `${id}_${originalName}`);
    // path traversal guard: resolved path must stay inside the session dir
    if (!path.resolve(storedPath).startsWith(path.resolve(dir) + path.sep)) {
      errors.push({ name: originalName, error: 'Недопустимое имя файла' });
      continue;
    }
    fs.writeFileSync(storedPath, f.buffer);
    db.prepare('INSERT INTO files (id, session_id, original_name, stored_path, size, ext, mime, created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(id, req.session.id, originalName, storedPath, f.buffer.length, check.ext, f.mimetype || '', now());
    uploaded.push({ id, name: originalName, size: f.buffer.length, ext: check.ext });
  }
  if (uploaded.length) {
    pipeline.logEvent(req.session.id, 'Файлы загружены', uploaded.map((u) => u.name).join(', '));
    // автоназвание проекта — из первого загруженного файла
    if (!req.session.title) {
      db.prepare('UPDATE sessions SET title = ? WHERE id = ?').run(uploaded[0].name.slice(0, 60), req.session.id);
    }
  }
  const status = uploaded.length ? 200 : 400;
  res.status(status).json({ uploaded, errors });
});

router.delete('/sessions/:id/files/:fileId', sessionAuth, sessionOwner, (req, res) => {
  const row = db.prepare('SELECT * FROM files WHERE id = ? AND session_id = ?').get(req.params.fileId, req.session.id);
  if (!row) return res.status(404).json({ error: 'Файл не найден' });
  // вместе с файлом удаляются ВСЕ его разборы, лежащие рядом: иначе удалённый
  // чертёж продолжает лежать на диске в разобранном виде — имена слоёв,
  // габариты и все надписи (services/cad.js, doc-vision.js, doc-digest.js)
  for (const suffix of ['', '.vision.md', '.cad.v2.md', '.digest.md']) {
    try { fs.unlinkSync(row.stored_path + suffix); } catch {}
  }
  require('../services/geometry/plan').invalidate(row.stored_path); // кэш разбора чертежа
  db.prepare('DELETE FROM files WHERE id = ?').run(row.id);
  pipeline.logEvent(req.session.id, 'Файл удалён', row.original_name);
  res.json({ ok: true });
});

/* ---------- план участка: геометрия, версии и аннотации ---------- */

/**
 * Комментарий к области плана — репликой в ленту проекта.
 *
 * Место в тексте называется координатами и площадью: «нельзя строить» без
 * привязки к месту через неделю не значит ничего. Роль — user: это слова
 * человека, а не ответ модели.
 */
function noteInChat(sessionId, annotation) {
  const G = require('../services/geometry/site-geometry');
  const pts = (annotation.geometry && annotation.geometry.points) || [];
  const b = pts.length ? G.bounds(pts) : null;
  const area = pts.length >= 3 ? Math.round(G.polygonArea(pts)) : 0;
  const where = b
    ? `X ${Math.round(b.minX)}…${Math.round(b.maxX)}, Y ${Math.round(b.minY)}…${Math.round(b.maxY)}${area ? `, ≈${area} м²` : ''}`
    : 'без координат';
  const who = annotation.author ? ` · ${annotation.author}` : '';
  pipeline.addMessage(sessionId, 'user', 'comment',
    `[Комментарий к области плана: ${where}${who}]\n${annotation.comment.trim()}`);
}

/** Правка свойств объекта — тоже репликой: это решение человека по конкретному объекту. */
function objectEditInChat(sessionId, saved) {
  const layers = require('../services/geometry/layers');
  const nameOf = (id) => (layers.get(id) ? layers.get(id).label : id);
  const rel = require('../services/geometry/object-edits').RELOCATION_LABELS;
  const p = saved.patch || {};
  const src = saved.parser || {};
  const bits = [];
  if (p.type) bits.push(`тип: ${nameOf(p.type)} (разбор считал «${nameOf(src.type)}»)`);
  if (p.label) bits.push(`назначение: ${p.label}`);
  if (p.relocation) bits.push(rel[p.relocation] || p.relocation);
  if (!bits.length && !p.comment) return;
  pipeline.addMessage(sessionId, 'user', 'comment',
    `[Правка объекта плана со слоя «${src.sourceLayer || '—'}»]\n` +
    bits.join('; ') + (p.comment ? `\n${p.comment}` : ''));
}
// Разбор чертежей детерминирован и модель не зовёт, поэтому отдаётся синхронно.
router.get('/sessions/:id/plan', sessionAuth, async (req, res, next) => {
  try {
    const planSvc = require('../services/geometry/plan');
    const annotations = require('../services/geometry/annotations');
    const objectEdits = require('../services/geometry/object-edits');
    // правки человека накладывает сам ensurePlan — там же, где их видят пересчёт
    // ограничений, подбор вариантов, выгрузка и анализ. Здесь список нужен только
    // интерфейсу: показать, что именно исправлено, и дать кнопку отмены
    const { planId, version, site } = await planSvc.ensurePlan(req.session.id);
    const edits = objectEdits.list(req.session.id);
    res.json({
      plan: site,
      planId,
      version,
      annotations: annotations.list(req.session.id, planId),
      objectEdits: edits,
      // перечень слоёв отдаётся сервером, а не дублируется в разметке: список
      // общий с разбором чертежа и с выгрузкой DXF (services/geometry/layers.js)
      layers: require('../services/geometry/layers').forUi(),
      summary: require('../services/geometry/site-geometry').summary(site),
      // граница ЗУ из документа: интерфейс обязан показать, что участок взят
      // не из чертежа, и дать её пересобрать или отменить
      parcelSource: require('../services/geometry/parcel-source').get(req.session.id),
    });
  } catch (err) { next(err); }
});

/* ---------- границы участка по координатам из документа ---------- */
/**
 * Топосъёмка границ ЗУ может не содержать вовсе — тогда участком становится
 * случайный контур покрытия, и вся дальнейшая арифметика бесполезна. Координаты
 * характерных точек есть в ГПЗУ таблицей: этот маршрут просит модель перенести
 * их оттуда, либо принимает уже готовые точки от человека.
 *
 * Полигон, порядок осей и сверку с заявленной площадью считает КОД
 * (services/geometry/parcel-source.js), а не модель.
 */
router.post('/sessions/:id/plan/parcel-source', sessionAuth, sessionOwner, express.json(), async (req, res, next) => {
  try {
    const parcelSource = require('../services/geometry/parcel-source');
    const body = req.body || {};

    if (Array.isArray(body.points) && body.points.length >= 3) {
      // точки набраны человеком — модель не нужна
      const saved = parcelSource.save(req.session.id, {
        points: body.points,
        meta: { ...(body.meta || {}), sourceDocument: (body.meta && body.meta.sourceDocument) || 'введено вручную' },
        author: String(body.author || ''),
      });
      pipeline.logEvent(req.session.id, 'Границы участка заданы координатами', `${saved.points.length} точек`);
      return res.json({ ok: true, source: saved, by: 'user' });
    }

    const { db } = require('../db');
    const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(req.session.id);
    const route = require('../services/claude/adapter').effectiveProvider(session);
    const planSvc = require('../services/geometry/plan');
    const { site } = await planSvc.ensurePlan(req.session.id, { raw: true });
    const found = await parcelSource.extract(req.session.id, { site, route });
    if (!found.found) return res.status(404).json({ error: found.note || 'Координат границы участка в документах не найдено' });
    pipeline.logEvent(req.session.id, 'Границы участка взяты из документа',
      `${found.points.length} точек, «${found.meta.sourceDocument || 'документ'}»`);
    res.json({ ok: true, source: parcelSource.get(req.session.id), by: 'model' });
  } catch (err) { next(err); }
});

router.delete('/sessions/:id/plan/parcel-source', sessionAuth, sessionOwner, (req, res) => {
  const ok = require('../services/geometry/parcel-source').remove(req.session.id);
  if (!ok) return res.status(404).json({ error: 'Границы из документа для этого проекта не сохранены' });
  pipeline.logEvent(req.session.id, 'Границы участка из документа отменены — снова берутся из чертежа');
  res.json({ ok: true });
});

/* ---------- свойства объекта плана: правка человеком ---------- */
// Разбор угадывает тип по имени слоя и ошибается; человек, глядя на план, знает
// правду. Правка применяется к плану, переживает переразбор и уходит в выгрузку
// для дообучения (services/geometry/object-edits.js).
router.post('/sessions/:id/plan/objects/:objectId', sessionAuth, sessionOwner, express.json(), async (req, res, next) => {
  try {
    const planSvc = require('../services/geometry/plan');
    const objectEdits = require('../services/geometry/object-edits');
    // снимок берём с ЧИСТОГО разбора: обучающий пример должен хранить догадку
    // разбора, а не её же, уже исправленную прошлой правкой
    const { planId, site } = await planSvc.ensurePlan(req.session.id, { raw: true });
    const found = objectEdits.findObject(site, req.params.objectId);
    if (!found) return res.status(404).json({ error: 'Объект не найден в текущей версии плана' });
    const saved = objectEdits.save(req.session.id, {
      planId,
      objectId: req.params.objectId,
      layer: found.layer,
      object: found.obj,
      patch: req.body || {},
      author: String((req.body && req.body.author) || ''),
    });
    const p = saved.patch;
    pipeline.logEvent(req.session.id, 'Свойства объекта плана исправлены',
      `${req.params.objectId}: ${[p.type && `тип → ${p.type}`, p.label && `назначение «${p.label}»`,
        p.relocation && `решение: ${p.relocation}`].filter(Boolean).join(', ') || 'комментарий'}`);
    objectEditInChat(req.session.id, saved);
    res.json(saved);
  } catch (err) {
    if (/Недопустим|пустая|не указан/i.test(err.message)) return res.status(400).json({ error: err.message });
    next(err);
  }
});

router.delete('/sessions/:id/plan/objects/:objectKey', sessionAuth, sessionOwner, (req, res) => {
  const ok = require('../services/geometry/object-edits').remove(req.session.id, req.params.objectKey);
  if (!ok) return res.status(404).json({ error: 'Правка не найдена' });
  pipeline.logEvent(req.session.id, 'Правка свойств объекта отменена', req.params.objectKey);
  res.json({ ok: true });
});

/**
 * Чертёж исходной обстановки по слоям — сразу после разбора, не дожидаясь
 * выбора варианта.
 *
 * Комплект на этапе 7 отдаёт чертёж ПО ВЫБРАННОМУ ВАРИАНТУ, то есть в конце
 * маршрута. А разложенная по слоям обстановка с правками человека нужна раньше:
 * ради неё объекты и переназначают. Геометрия берётся через ensurePlan, значит
 * с уже применёнными правками; слои — из общего перечня (geometry/layers.js).
 *
 * AutoCAD не опрашивается: мост ждёт его ответа до 90 секунд и требует
 * разрешения в «Универсальном доступе», а кнопка обязана отдавать файл сразу.
 * DWG собирает конвертер LibreDWG; если он недоступен, честно уходит DXF —
 * формат назван в имени файла и в заголовке X-Drawing-Format, подмены нет.
 */
router.get('/sessions/:id/plan/drawing', sessionAuth, async (req, res, next) => {
  const fsMod = require('fs');
  const pathMod = require('path');
  let dir = null;
  try {
    const planSvc = require('../services/geometry/plan');
    const cadDrawing = require('../services/cad/drawing');
    const { site } = await planSvc.ensurePlan(req.session.id);
    const hasGeometry = site.parcel || ['buildings', 'redLines', 'utilities', 'existingObjects']
      .some((k) => (site[k] || []).length);
    if (!hasGeometry) {
      return res.status(400).json({ error: 'В плане нет геометрии: загрузите чертёж DWG или DXF.' });
    }

    const wantDxf = String(req.query.format || '').toLowerCase() === 'dxf';
    dir = fsMod.mkdtempSync(pathMod.join(config.dataDir, 'plan-cad-'));
    const built = await cadDrawing.buildDrawing(site, {
      title: req.session.title || 'План участка',
      subtitle: `Enso-nexus · объекты по слоям · ${new Date(now()).toLocaleDateString('ru-RU')}`,
      dir, acad: false,
    });

    const file = !wantDxf && built.dwgPath ? built.dwgPath : built.dxfPath;
    const format = file === built.dxfPath ? 'dxf' : 'dwg';
    const body = fsMod.readFileSync(file);
    pipeline.logEvent(req.session.id, 'Выгружен чертёж по слоям',
      `${pathMod.basename(file)}, слоёв: ${built.spec.layers.length}, сущностей: ${built.spec.entities.length}`);
    res.setHeader('X-Drawing-Format', format);
    res.setHeader('X-Drawing-Layers', String(built.spec.layers.length));
    res.setHeader('Content-Type', format === 'dwg' ? 'image/vnd.dwg' : 'application/dxf');
    res.setHeader('Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(pathMod.basename(file))}`);
    res.send(body);
  } catch (err) {
    next(err);
  } finally {
    if (dir) { try { fsMod.rmSync(dir, { recursive: true, force: true }); } catch { /* временная папка */ } }
  }
});

// Выгрузка для дообучения: «что увидел разбор → что сказал человек», по строке на правку
router.get('/sessions/:id/plan/corrections.jsonl', sessionAuth, (req, res) => {
  const body = require('../services/geometry/object-edits').exportJsonl(req.session.id);
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="object-corrections.jsonl"');
  res.send(body);
});

router.post('/sessions/:id/annotations', sessionAuth, sessionOwner, express.json(), (req, res, next) => {
  try {
    const annotations = require('../services/geometry/annotations');
    const created = annotations.create(req.session.id, {
      planId: req.body?.planId,
      geometry: req.body?.geometry,
      geometryType: req.body?.geometryType,
      comment: req.body?.comment,
      author: req.body?.author,
      coordinateSystem: req.body?.coordinateSystem,
      metadata: req.body?.metadata,
    });
    pipeline.logEvent(req.session.id, 'Добавлено выделение на плане', (created.comment || '').slice(0, 120));
    // Комментарий уходит РЕПЛИКОЙ В ЛЕНТУ. Раньше он жил только на плане: чтобы
    // вспомнить, что и где написано, приходилось открывать план и обходить рамки
    // мышью. В ленте он ищется, читается подряд и попадает в контекст анализа.
    if ((created.comment || '').trim()) noteInChat(req.session.id, created);
    res.status(201).json(created);
  } catch (err) {
    if (/требует|привязана/.test(err.message)) return res.status(400).json({ error: err.message });
    next(err);
  }
});

router.post('/sessions/:id/annotations/:aid', sessionAuth, sessionOwner, express.json(), (req, res, next) => {
  try {
    const annotations = require('../services/geometry/annotations');
    const before = annotations.list(req.session.id).find((a) => a.id === req.params.aid);
    const updated = annotations.update(req.session.id, req.params.aid, req.body || {});
    // в ленту уходит только ИЗМЕНЁННЫЙ комментарий: сохранение без правки текста
    // (например, смена статуса) реплику не плодит
    if (updated && (updated.comment || '').trim() && (!before || before.comment !== updated.comment)) {
      noteInChat(req.session.id, updated);
    }
    if (!updated) return res.status(404).json({ error: 'Выделение не найдено' });
    res.json(updated);
  } catch (err) {
    if (/требует/.test(err.message)) return res.status(400).json({ error: err.message });
    next(err);
  }
});

/**
 * Предупреждения к ответу: разбор чертежа (`site.warnings`) и движок
 * ограничений (`built.warnings`) в одном списке, без повторов.
 *
 * Код намеренно устойчив к отсутствию поля: движок и worker их возвращают не
 * всегда, а падать из-за недостающего массива предупреждений — глупо.
 */
function collectWarnings(site, built = {}) {
  const seen = new Set();
  const out = [];
  for (const w of [...((site && site.warnings) || []), ...((built && built.warnings) || [])]) {
    const item = typeof w === 'string'
      ? { code: '', message: w }
      : { code: (w && w.code) || '', message: (w && w.message) || String(w) };
    if (!item.message || seen.has(item.message)) continue;
    seen.add(item.message);
    out.push(item);
  }
  return out;
}

/** Расчёт зон ограничений: модель формулирует правила, движок строит полигоны. */
router.post('/sessions/:id/plan/restrictions', sessionAuth, sessionOwner, expensiveLimit, express.json(), async (req, res, next) => {
  try {
    const planSvc = require('../services/geometry/plan');
    const extract = require('../services/geometry/restriction-extract');
    const adapter = require('../services/claude/adapter');

    const { planId, site } = await planSvc.ensurePlan(req.session.id);
    if (!site.parcel) return res.status(400).json({ error: 'Границы участка не определены — от чего считать ограничения, неизвестно.' });

    const route = adapter.effectiveProvider(req.session);
    const extracted = await extract.extract(req.session.id, { site, route });
    // построение зон — в отдельном потоке: булевы операции блокируют HTTP (ТЗ, п. 76)
    const built = await require('../services/geometry/queue').run('restrictions', { site, rules: extracted.rules });

    /*
     * Зоны сохраняются ВМЕСТЕ С ПРАВИЛАМИ и отдельно от разбора чертежа.
     *
     * Раньше здесь стояло `UPDATE plans SET geometry`, то есть план с уже
     * наложенными правками человека затирал в таблице чистый разбор, а зоны
     * замерзали на этом мгновении: пометил здание под снос — варианты посадки
     * всё равно считались по старому пятну. Теперь запись живёт в `plan_zones`,
     * и `ensurePlan` пересобирает зоны по тем же правилам, как только решения
     * человека изменятся (services/geometry/zones.js).
     */
    require('../services/geometry/zones').save(req.session.id, planId, { rules: extracted.rules, built });
    site.restrictions = built.restrictions;
    site.zoneGroups = built.zoneGroups || [];
    site.buildable = built.buildable;

    pipeline.logEvent(req.session.id, 'Рассчитаны зоны ограничений',
      `построено ${built.restrictions.length} по ${(built.zoneGroups || []).length} правилам, `
      + `не построено ${built.unresolved.length}`);
    res.json({
      planId,
      restrictions: built.restrictions,
      zoneGroups: built.zoneGroups || [],
      buildable: built.buildable,
      attributes: built.attributes,
      unresolved: built.unresolved.map((u) => ({ kind: u.kind, reason: u.reason })),
      conflicts: extracted.conflicts,
      missingData: extracted.missingData,
      // предупреждения разбора чертежа и движка ограничений: молча терять их
      // нельзя — «единицы не заданы, приняты метры» меняет весь масштаб
      warnings: collectWarnings(site, built),
      stats: { ...extracted.stats, ...built.stats },
    });
  } catch (err) { next(err); }
});

/** Вопрос модели по выделенной области: мультимодальный контекст (ТЗ, п. 34). */
router.post('/sessions/:id/annotations/:aid/ask', sessionAuth, sessionOwner, expensiveLimit, express.json(), async (req, res, next) => {
  try {
    const question = String(req.body?.question ?? '').trim();
    if (!question) return res.status(400).json({ error: 'Пустой вопрос' });
    if (question.length > config.maxMessageLength) {
      return res.status(400).json({ error: `Вопрос длиннее ${config.maxMessageLength} символов` });
    }
    const annotations = require('../services/geometry/annotations');
    const found = annotations.list(req.session.id).find((a) => a.id === req.params.aid);
    if (!found) return res.status(404).json({ error: 'Выделение не найдено' });

    const planSvc = require('../services/geometry/plan');
    const askSvc = require('../services/geometry/ask-selection');
    const adapter = require('../services/claude/adapter');
    const { site } = await planSvc.ensurePlan(req.session.id);
    const route = adapter.effectiveProvider(req.session);

    const { answer, context } = await askSvc.ask(req.session.id, { annotation: found, site, question, route });
    const ids = askSvc.recordInChat(req.session.id, { annotation: found, question, answer });
    if (ids.answerMessageId) annotations.update(req.session.id, found.id, { linkedMessageId: ids.answerMessageId, status: 'answered' });
    res.json({ answer, context, ...ids });
  } catch (err) { next(err); }
});

router.delete('/sessions/:id/annotations/:aid', sessionAuth, sessionOwner, (req, res) => {
  const ok = require('../services/geometry/annotations').remove(req.session.id, req.params.aid);
  if (!ok) return res.status(404).json({ error: 'Выделение не найдено' });
  res.json({ ok: true });
});

/* ---------- порядок работы (Excel-карта порядка анализа) ---------- */
const workplanSvc = require('../services/workplan');

// стандартный порядок — без авторизации, чтобы можно было скачать шаблон до создания сессии
router.get('/workplan/default.xlsx', (req, res) => {
  const buf = workplanSvc.buildXlsx(workplanSvc.DEFAULT_STEPS);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="workplan-default.xlsx"');
  res.send(buf);
});

// текущий порядок работы сессии (пользовательский или стандартный) как Excel
router.get('/sessions/:id/workplan.xlsx', sessionAuth, (req, res) => {
  const wp = workplanSvc.forSession(req.session);
  const buf = workplanSvc.buildXlsx(wp.steps);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="workplan.xlsx"');
  res.send(buf);
});

// загрузка своего Excel с порядком работы
router.post('/sessions/:id/workplan', sessionAuth, sessionOwner, expensiveLimit, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Файл не передан' });
  const name = sanitizeFilename(Buffer.from(req.file.originalname, 'latin1').toString('utf8'));
  if (!/\.xlsx$/i.test(name)) return res.status(400).json({ error: 'Нужен файл Excel (.xlsx)' });
  if (req.file.buffer.length > 2 * 1024 * 1024) return res.status(400).json({ error: 'Файл больше 2 МБ' });
  const parsed = workplanSvc.parseXlsx(req.file.buffer);
  if (!parsed.ok) return res.status(400).json({ error: parsed.error });
  db.prepare('UPDATE sessions SET workplan = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify({ name, steps: parsed.steps }), now(), req.session.id);
  pipeline.logEvent(req.session.id, 'Загружен пользовательский порядок работы', `${name} — шагов: ${parsed.steps.length}`);
  res.json({ ok: true, name, steps: parsed.steps });
});

// вернуть стандартный порядок работы
router.delete('/sessions/:id/workplan', sessionAuth, sessionOwner, (req, res) => {
  db.prepare("UPDATE sessions SET workplan = '', updated_at = ? WHERE id = ?").run(now(), req.session.id);
  pipeline.logEvent(req.session.id, 'Порядок работы сброшен на стандартный');
  res.json({ ok: true });
});

/* ---------- settings: нейросеть и база знаний ---------- */
router.post('/sessions/:id/settings', sessionAuth, sessionOwner, express.json(), async (req, res, next) => {
  try {
    const { aiProvider, aiModel, kbChoice } = req.body || {};
    const updates = {};
    if (aiProvider !== undefined) {
      if (aiProvider === '') {
        updates.ai_provider = ''; updates.ai_model = '';
      } else {
        const check = await require('../services/providers')
          .validateChoice(String(aiProvider), aiModel ? String(aiModel) : '', req.user);
        if (!check.ok) return res.status(400).json({ error: check.error });
        updates.ai_provider = String(aiProvider);
        updates.ai_model = aiModel ? String(aiModel) : '';
        // модель тяжела для этой машины — не запрет, а предупреждение в журнал:
        // решение принимает владелец машины, платформа только называет цену
        if (check.warning) {
          pipeline.logEvent(req.session.id, 'Выбрана тяжёлая для машины модель',
            `${aiProvider}: ${aiModel} — ${check.warning}`, 'warn');
        }
      }
    }
    if (kbChoice !== undefined) {
      if (!config.kbBases.some((b) => b.id === kbChoice)) {
        return res.status(400).json({ error: 'Неизвестная база знаний' });
      }
      updates.kb_choice = String(kbChoice);
    }
    if (typeof req.body?.title === 'string') {
      const title = req.body.title.trim().slice(0, 120);
      // пустое название вернуть нечем: в сайдбаре проект снова становится
      // «Новый проект», и среди нескольких проектов его не различить
      if (!title) return res.status(400).json({ error: 'Название проекта не может быть пустым' });
      updates.title = title;
    }
    if (!Object.keys(updates).length) return res.status(400).json({ error: 'Нет изменений' });
    const sets = Object.keys(updates).map((k) => `${k} = ?`).join(', ');
    db.prepare(`UPDATE sessions SET ${sets}, updated_at = ? WHERE id = ?`)
      .run(...Object.values(updates), now(), req.session.id);
    pipeline.logEvent(req.session.id, 'Настройки анализа изменены',
      [updates.ai_provider !== undefined ? `нейросеть: ${updates.ai_provider || 'по умолчанию'}${updates.ai_model ? ` (${updates.ai_model})` : ''}` : '',
       updates.kb_choice ? `база: ${updates.kb_choice}` : ''].filter(Boolean).join(', '));
    res.json({ ok: true });
  } catch (err) { next(err); }
});

/* ---------- comment / messages ---------- */
router.post('/sessions/:id/comment', sessionAuth, sessionOwner, express.json(), (req, res) => {
  const text = String(req.body?.comment ?? '').slice(0, config.maxMessageLength);
  db.prepare('UPDATE sessions SET comment = ?, updated_at = ? WHERE id = ?').run(text, now(), req.session.id);
  if (text) pipeline.addMessage(req.session.id, 'user', 'comment', text);
  res.json({ ok: true });
});

/**
 * Одна лента и одно поле ввода: отдельного режима «Анализ» больше нет —
 * анализ запускается своей кнопкой, а здесь идёт разговор.
 *
 * Сообщение принимается ВСЕГДА, даже когда сервер занят: оно сразу попадает
 * в ленту, а ответ приходит после освобождения слота. Раньше поле ввода
 * блокировалось на всё время анализа, и спросить по ходу дела было нельзя.
 *
 * До первого анализа написанное здесь — это ещё и указания к исходным данным:
 * текст закрепляется в `sessions.comment` и уходит в промпт каждого прогона,
 * даже когда сама реплика уже выпала из окна последних сообщений.
 */
router.post('/sessions/:id/messages', sessionAuth, sessionOwner, expensiveLimit, express.json(), (req, res, next) => {
  try {
    const text = String(req.body?.text ?? '').trim();
    if (!text) return res.status(400).json({ error: 'Пустое сообщение' });
    if (text.length > config.maxMessageLength) {
      return res.status(400).json({ error: `Сообщение длиннее ${config.maxMessageLength} символов` });
    }

    pipeline.addMessage(req.session.id, 'user', 'chat', text);
    // автоназвание проекта — из первого сообщения пользователя
    if (!req.session.title) {
      db.prepare('UPDATE sessions SET title = ? WHERE id = ?').run(text.slice(0, 60), req.session.id);
    }

    const filesCount = db.prepare('SELECT COUNT(*) AS c FROM files WHERE session_id = ?').get(req.session.id).c;
    const asComment = stages.get(req.session.id) === 'idle' && filesCount > 0;
    if (asComment) pinAsDataComment(req.session.id, text);

    const { queued } = pipeline.enqueueChat(req.session.id);
    return res.status(202).json({ ok: true, queued, pinnedAsComment: asComment });
  } catch (err) { return next(err); }
});

/**
 * Дописать реплику к закреплённому комментарию к исходным данным.
 * При переполнении отбрасываются САМЫЕ СТАРЫЕ строки целиком: резать посреди
 * слова нельзя — обрывок уходит в промпт и в запрос к базе знаний.
 */
function pinAsDataComment(sessionId, text) {
  const row = db.prepare('SELECT comment FROM sessions WHERE id = ?').get(sessionId);
  const lines = String((row && row.comment) || '').split('\n').filter((l) => l.trim());
  const norm = (l) => l.trim().toLowerCase().replace(/\s+/g, ' ');
  if (lines.some((l) => norm(l) === norm(text))) return; // ту же мысль дважды не пишем
  lines.push(text);
  while (lines.join('\n').length > config.maxMessageLength && lines.length > 1) lines.shift();
  db.prepare('UPDATE sessions SET comment = ?, updated_at = ? WHERE id = ?')
    .run(lines.join('\n'), now(), sessionId);
}

/* ---------- варианты посадки, мероприятия, выбор и комплект ---------- */

router.get('/placement/criteria', (req, res) => {
  res.json({ criteria: require('../services/geometry/variants').CRITERIA });
});

/** Генерация четырёх различающихся вариантов (ТЗ, п. 43). */
router.post('/sessions/:id/plan/variants', sessionAuth, sessionOwner, expensiveLimit, express.json(), async (req, res, next) => {
  try {
    const planSvc = require('../services/geometry/plan');
    const queue = require('../services/geometry/queue');
    const V = require('../services/geometry/variants');
    const runs = require('../services/geometry/placement-runs');

    const { planId, site } = await planSvc.ensurePlan(req.session.id);
    if (!site.parcel) return res.status(400).json({ error: 'Границы участка не определены — размещать не в чем.' });

    const requirements = req.body?.requirements || {};
    const criterion = String(req.body?.criterion || 'maxArea');
    const gen = await queue.run('placement', {
      site, buildable: site.buildable || null, requirements, options: { limit: 400 },
    });
    if (gen.errors.length) return res.status(400).json({ error: gen.errors.join(' ') });

    const { variants, notes } = V.build(site, gen.candidates, { criterion });
    const runId = runs.saveRun(req.session.id, {
      planId, requirements, criterion, variants,
      stats: { перебрано: gen.tried, найдено: gen.total, отобрано: variants.length },
    });
    pipeline.logEvent(req.session.id, 'Сгенерированы варианты посадки',
      `вариантов ${variants.length}, кандидатов ${gen.total}`);
    res.json({ runId, ...runs.latestRun(req.session.id), notes });
  } catch (err) { next(err); }
});

router.get('/sessions/:id/plan/variants', sessionAuth, (req, res) => {
  const run = require('../services/geometry/placement-runs').latestRun(req.session.id);
  res.json(run || { variants: [] });
});

/**
 * Кто принял решение. Подпись обязательна (ТЗ, п. 46), но заставлять клиента
 * присылать ФИО не нужно: человек уже вошёл под своим именем.
 */
function decisionAuthor(req) {
  const explicit = String(req.body?.decidedBy || '').trim();
  if (explicit) return explicit;
  const u = req.user;
  return u ? `${u.lastName} ${u.firstName}`.trim() : '';
}

/** Решение по мероприятию, затрагивающему критический объект (ТЗ, п. 46). */
router.post('/sessions/:id/plan/actions/:actionId', sessionAuth, sessionOwner, express.json(), (req, res, next) => {
  try {
    const decidedBy = decisionAuthor(req);
    const updated = require('../services/geometry/placement-runs')
      .decideAction(req.session.id, req.params.actionId, { decision: req.body?.decision, decidedBy });
    if (!updated) return res.status(404).json({ error: 'Мероприятие не найдено' });
    pipeline.logEvent(req.session.id, 'Решение по мероприятию',
      `${req.body?.decision === 'allow' ? 'разрешено' : 'запрещено'}, принял ${decidedBy}`);
    res.json(updated);
  } catch (err) {
    if (/Решение должно|Нужно указать/.test(err.message)) return res.status(400).json({ error: err.message });
    next(err);
  }
});

/**
 * Решения по мероприятиям варианта одним списком.
 *
 * Возвращает { ok } либо строку ошибки: вызывается перед выбором варианта,
 * чтобы путь «вариант требует решения → решил → выбрал» проходился одним
 * запросом, а не тремя.
 */
function applyDecisions(req, variantId) {
  const list = Array.isArray(req.body?.decisions) ? req.body.decisions : [];
  if (!list.length) return { ok: true };
  const runs = require('../services/geometry/placement-runs');
  const variant = runs.getVariant(req.session.id, variantId);
  if (!variant) return { ok: false, status: 404, error: 'Вариант не найден' };
  const decidedBy = decisionAuthor(req);
  for (const d of list) {
    const actionId = String((d && d.actionId) || '');
    if (!variant.actions.some((a) => a.id === actionId)) {
      return { ok: false, status: 404, error: `Мероприятие ${actionId} не относится к варианту ${variant.number}` };
    }
    try {
      runs.decideAction(req.session.id, actionId, { decision: d && d.decision, decidedBy });
    } catch (err) {
      return { ok: false, status: 400, error: err.message };
    }
    pipeline.logEvent(req.session.id, 'Решение по мероприятию',
      `${d && d.decision === 'allow' ? 'разрешено' : 'запрещено'}, принял ${decidedBy}`);
  }
  return { ok: true };
}

/**
 * Назначение варианта выбранным (ТЗ, п. 53).
 *
 * Вместе с выбором принимаются решения по мероприятиям: вариант со статусом
 * «требует решения» иначе невозможно выбрать вовсе, и путь встаёт в тупик.
 * Тело: { decisions: [{ actionId, decision: 'allow'|'forbid' }], decidedBy? }.
 */
router.post('/sessions/:id/plan/variants/:variantId/select', sessionAuth, sessionOwner, express.json(), (req, res, next) => {
  try {
    const applied = applyDecisions(req, req.params.variantId);
    if (!applied.ok) return res.status(applied.status).json({ error: applied.error });
    const chosen = require('../services/geometry/placement-runs').select(req.session.id, req.params.variantId);
    if (!chosen) return res.status(404).json({ error: 'Вариант не найден' });
    pipeline.logEvent(req.session.id, 'Выбран вариант посадки', `вариант ${chosen.number}`);
    res.json(chosen);
  } catch (err) {
    if (/не принято решений/.test(err.message)) return res.status(409).json({ error: err.message });
    next(err);
  }
});

/** Комплект по выбранному варианту: PDF формируется сервером (ТЗ, п. 54). */
router.post('/sessions/:id/plan/export', sessionAuth, sessionOwner, expensiveLimit, express.json(), async (req, res, next) => {
  try {
    const runs = require('../services/geometry/placement-runs');
    const planSvc = require('../services/geometry/plan');
    const exportSvc = require('../services/geometry/export');
    const annotations = require('../services/geometry/annotations');

    const variant = runs.selected(req.session.id);
    if (!variant) return res.status(400).json({ error: 'Вариант не выбран — комплект формировать не по чему.' });
    const { planId, site } = await planSvc.ensurePlan(req.session.id);
    const { created, notes } = await exportSvc.buildPackage(req.session.id, {
      session: req.session,
      site,
      variant,
      restrictions: site.restrictions || [],
      buildable: site.buildable || null,
      annotations: annotations.list(req.session.id, planId),
    });
    pipeline.logEvent(req.session.id, 'Сформирован комплект', created.map((c) => c.filename).join(', '));
    for (const note of notes) pipeline.logEvent(req.session.id, 'Выгрузка чертежа', note, 'warn');
    res.json({ created, notes });
  } catch (err) { next(err); }
});

/* ---------- согласование этапов в ленте диалога ---------- */

/** Требования к зданию из тела запроса или из фактов анализа. */
function resolveRequirements(sessionId, body) {
  const num = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null);
  const raw = (body && body.requirements) || {};
  const explicit = {
    areaM2: num(raw.areaM2), floors: num(raw.floors),
    width: num(raw.width), length: num(raw.length),
  };
  if (explicit.areaM2 || (explicit.width && explicit.length)) return explicit;

  const fromFacts = stages.requirementsFromFacts(sessionId);
  if (fromFacts) {
    return {
      areaM2: fromFacts.areaM2, floors: fromFacts.floors,
      width: fromFacts.width, length: fromFacts.length,
    };
  }
  return null;
}

/** Схема зон согласована — переходим к вариантам посадки. */
router.post('/sessions/:id/stages/zones/approve', sessionAuth, sessionOwner, expensiveLimit, express.json(), async (req, res, next) => {
  try {
    if (stages.get(req.session.id) !== 'zones_review') {
      return res.status(409).json({ error: 'Схема зон сейчас не на согласовании — обновите страницу.' });
    }
    const requirements = resolveRequirements(req.session.id, req.body);
    if (!requirements) {
      return res.status(400).json({
        error: 'Не хватает требований к зданию: укажите площадь застройки (или габариты) и этажность. ' +
          'В исходных данных их найти не удалось, а придумывать их нельзя.',
        needsRequirements: true,
      });
    }
    pipeline.addMessage(req.session.id, 'user', 'answer', 'Схема запретных зон согласована.');
    pipeline.logEvent(req.session.id, 'Схема зон согласована пользователем');
    await pipeline.startVariantsStage(req.session.id, requirements);
    res.json({ ok: true, requirements });
  } catch (err) { next(err); }
});

/** Замечания к схеме зон — зоны считаются заново с их учётом. */
router.post('/sessions/:id/stages/zones/revise', sessionAuth, sessionOwner, expensiveLimit, express.json(), async (req, res, next) => {
  try {
    const note = String(req.body?.note || '').trim();
    if (!note) return res.status(400).json({ error: 'Замечание пустое — писать в промпт нечего.' });
    stages.addNote(req.session.id, 'zones', note);
    pipeline.addMessage(req.session.id, 'user', 'comment', `Замечание к схеме зон: ${note}`);
    pipeline.logEvent(req.session.id, 'Замечание к схеме зон', note.slice(0, 200));
    await pipeline.startZonesStage(req.session.id);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

/** Замечания к вариантам — четвёрка генерируется заново. */
router.post('/sessions/:id/stages/variants/revise', sessionAuth, sessionOwner, expensiveLimit, express.json(), async (req, res, next) => {
  try {
    const note = String(req.body?.note || '').trim();
    if (!note) return res.status(400).json({ error: 'Замечание пустое — переделывать не по чему.' });
    stages.addNote(req.session.id, 'variants', note);
    const requirements = resolveRequirements(req.session.id, req.body);
    if (!requirements) return res.status(400).json({ error: 'Не заданы требования к зданию.', needsRequirements: true });
    requirements.notes = stages.notes(req.session.id, 'variants').join('; ');
    pipeline.addMessage(req.session.id, 'user', 'comment', `Замечание к вариантам: ${note}`);
    pipeline.logEvent(req.session.id, 'Замечание к вариантам посадки', note.slice(0, 200));
    await pipeline.startVariantsStage(req.session.id, requirements);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

/**
 * Вариант согласован — собираем чертёж.
 *
 * Тело необязательное: { variantId?, decisions?: [{ actionId, decision }], decidedBy? }.
 * С `variantId` маршрут сам выбирает вариант и сам принимает решения по его
 * мероприятиям — иначе вариант со статусом «требует решения» согласовать
 * нечем, и в прогоне, где таких вариантов большинство, работа встаёт совсем.
 */
router.post('/sessions/:id/stages/variants/approve', sessionAuth, sessionOwner, expensiveLimit, express.json(), async (req, res, next) => {
  try {
    const runs = require('../services/geometry/placement-runs');
    const variantId = String(req.body?.variantId || '');
    if (variantId) {
      const applied = applyDecisions(req, variantId);
      if (!applied.ok) return res.status(applied.status).json({ error: applied.error });
      try {
        if (!runs.select(req.session.id, variantId)) return res.status(404).json({ error: 'Вариант не найден' });
      } catch (err) {
        if (/не принято решений/.test(err.message)) return res.status(409).json({ error: err.message });
        throw err;
      }
    }
    const chosen = runs.selected(req.session.id);
    if (!chosen) {
      return res.status(400).json({
        error: 'Сначала выберите вариант.',
        // подсказка клиенту: выбор из ПРОШЛОГО прогона не считается
        runId: runs.latestRunId(req.session.id),
      });
    }
    pipeline.addMessage(req.session.id, 'user', 'answer', `Вариант ${chosen.number} согласован — собрать чертёж.`);
    pipeline.logEvent(req.session.id, 'Вариант согласован', `вариант ${chosen.number}`);
    await pipeline.startDrawingStage(req.session.id);
    res.json({ ok: true, variant: chosen.number });
  } catch (err) { next(err); }
});

/** Доступность выгрузки DWG: показывается в карточке чертежа честно, до запуска. */
router.get('/cad/status', async (req, res) => {
  const probe = await require('../services/cad/acad-bridge').probe();
  res.json({
    dwg: probe.available,
    reason: probe.reason,
    appName: config.acad.appName,
    converterFallback: config.acad.allowConverterFallback,
  });
});

/* ---------- база критической инфраструктуры (ТЗ, п. 45) ---------- */

router.get('/critical-objects', (req, res) => {
  res.json({ objects: require('../services/geometry/critical-objects').list() });
});

router.get('/sessions/:id/critical-objects/unknown', sessionAuth, async (req, res, next) => {
  try {
    const { site } = await require('../services/geometry/plan').ensurePlan(req.session.id);
    res.json({ unknown: require('../services/geometry/critical-objects').unknownIn(site) });
  } catch (err) { next(err); }
});

router.post('/critical-objects', userAuth, express.json(), (req, res, next) => {
  try {
    const saved = require('../services/geometry/critical-objects').remember({
      sourceLayer: req.body?.sourceLayer,
      label: req.body?.label,
      classification: req.body?.classification,
      basis: req.body?.basis,
      validatedBy: req.body?.validatedBy,
      note: req.body?.note,
    });
    res.status(201).json(saved);
  } catch (err) {
    if (/Нужно указать|Неизвестная классификация|Пустое имя/.test(err.message)) {
      return res.status(400).json({ error: err.message });
    }
    next(err);
  }
});

/* ---------- отмена выполняющейся обработки ---------- */
router.post('/sessions/:id/cancel', sessionAuth, sessionOwner, express.json(), (req, res) => {
  const ok = pipeline.cancelJob(req.session.id);
  if (!ok) return res.status(400).json({ error: 'Сейчас нет выполняющейся обработки' });
  res.json({ ok: true });
});

/* ---------- processing ---------- */
router.post('/sessions/:id/process', sessionAuth, sessionOwner, expensiveLimit, express.json(), (req, res, next) => {
  // Задание пользователя ДОПОЛНЯЕТ порядок работы, а не подменяет его: подмена
  // выкидывала бы все шаги из настроек ради одной фразы из поля ввода.
  const extra = String(req.body?.instruction || '').trim().slice(0, config.maxMessageLength);
  Promise.resolve(pipeline.startProcessing(req.session.id, { extraInstruction: extra })).then(
    () => res.status(202).json({ ok: true, jobStatus: 'queued' }),
    (err) => next(err),
  );
});

/* ---------- сравнение моделей ---------- */
router.post('/sessions/:id/compare', sessionAuth, sessionOwner, expensiveLimit, express.json(), async (req, res, next) => {
  try {
    const models = Array.isArray(req.body?.models) ? req.body.models : [];
    if (models.length < 2 || models.length > 4) {
      return res.status(400).json({ error: 'Выберите от 2 до 4 моделей для сравнения' });
    }
    const providersSvc = require('../services/providers');
    const routes = [];
    for (const m of models) {
      const provider = String(m?.provider || '');
      const model = m?.model ? String(m.model) : '';
      const check = await providersSvc.validateChoice(provider, model, req.user);
      if (!check.ok) return res.status(400).json({ error: check.error });
      routes.push({ provider, model });
    }
    await pipeline.startComparison(req.session.id, routes, req.body?.instruction ? String(req.body.instruction).slice(0, config.maxMessageLength) : '');
    res.status(202).json({ ok: true, jobStatus: 'queued' });
  } catch (err) { next(err); }
});

/* ---------- clarifying questions ---------- */
router.post('/sessions/:id/questions/:qid/answer', sessionAuth, sessionOwner, expensiveLimit, express.json(), (req, res, next) => {
  const answer = String(req.body?.answer ?? '').trim();
  if (!answer) return res.status(400).json({ error: 'Пустой ответ' });
  if (answer.length > config.maxMessageLength) {
    return res.status(400).json({ error: `Ответ длиннее ${config.maxMessageLength} символов` });
  }
  const q = db.prepare('SELECT * FROM questions WHERE id = ? AND session_id = ?').get(req.params.qid, req.session.id);
  if (!q) return res.status(404).json({ error: 'Вопрос не найден' });
  db.prepare("UPDATE questions SET status = 'answered', answer = ?, answered_at = ? WHERE id = ?").run(answer, now(), q.id);
  pipeline.addMessage(req.session.id, 'user', 'answer', `${q.text} — ${answer}`);
  pipeline.logEvent(req.session.id, 'Получен ответ на уточняющий вопрос');

  const pending = db.prepare("SELECT COUNT(*) AS c FROM questions WHERE session_id = ? AND status = 'pending'").get(req.session.id).c;
  const continueNow = req.body?.continue !== false && pending === 0;
  if (continueNow) {
    // Круги уточнений считаются: на каждый ответ модель охотно придумывает
    // новый вопрос, и без потолка разговор не заканчивается никогда — проверено
    // живым прогоном, четыре круга подряд и ни одного результата.
    const closed = db.prepare(
      "SELECT COUNT(*) AS c FROM questions WHERE session_id = ? AND status IN ('answered','closed')",
    ).get(req.session.id).c;
    const enough = closed >= config.maxClarificationAnswers;
    if (enough) pipeline.logEvent(req.session.id, 'Уточнения исчерпаны', `ответов ${closed} — работаем на допущениях`);
    Promise.resolve(pipeline.startProcessing(req.session.id, {
      instruction: enough
        ? 'Пользователь уже ответил на все уточняющие вопросы (см. память сессии). БОЛЬШЕ ВОПРОСОВ НЕ ЗАДАВАЙ: ' +
          'верни status="completed". Чего не хватает — прими разумное допущение и перечисли его в assumptions, ' +
          'а неустранимое — в warnings. Отчёт обязан быть выпущен.'
        : 'Пользователь ответил на уточняющие вопросы (см. память сессии). Продолжи обработку с учётом ответов. ' +
          'Задавай новый вопрос ТОЛЬКО если без него расчёт невозможен; всё остальное принимай допущением.',
    })).then(
      () => res.json({ ok: true, continued: true, pending }),
      (err) => next(err),
    );
  } else {
    res.json({ ok: true, continued: false, pending });
  }
});

/* ---------- пропуск уточняющего вопроса (кнопка «Пропустить») ---------- */
router.post('/sessions/:id/questions/:qid/skip', sessionAuth, sessionOwner, express.json(), (req, res, next) => {
  const q = db.prepare('SELECT * FROM questions WHERE id = ? AND session_id = ?').get(req.params.qid, req.session.id);
  if (!q) return res.status(404).json({ error: 'Вопрос не найден' });
  if (q.status !== 'pending') return res.status(400).json({ error: 'Вопрос уже закрыт' });
  db.prepare("UPDATE questions SET status = 'closed', answered_at = ? WHERE id = ?").run(now(), q.id);
  pipeline.logEvent(req.session.id, 'Вопрос пропущен пользователем', q.text.slice(0, 120));

  const pending = db.prepare("SELECT COUNT(*) AS c FROM questions WHERE session_id = ? AND status = 'pending'").get(req.session.id).c;
  if (pending === 0) {
    Promise.resolve(pipeline.startProcessing(req.session.id, {
      instruction: 'Пользователь ответил на часть уточняющих вопросов, остальные пропустил (см. память сессии). ' +
        'Продолжи обработку: учитывай полученные ответы, а недостающие данные закрой явными допущениями в assumptions — не выдавая предположения за точные значения.',
    })).then(
      () => res.json({ ok: true, continued: true, pending }),
      (err) => next(err),
    );
  } else {
    res.json({ ok: true, continued: false, pending });
  }
});

/* ---------- results ---------- */
router.get('/sessions/:id/results', sessionAuth, (req, res) => {
  const results = db.prepare('SELECT id, filename, title, format, size, created_at FROM results WHERE session_id = ? ORDER BY created_at').all(req.session.id);
  res.json({ results });
});

router.get('/sessions/:id/results/:resultId/download', sessionAuth, (req, res) => {
  const row = db.prepare('SELECT * FROM results WHERE id = ? AND session_id = ?').get(req.params.resultId, req.session.id);
  if (!row) return res.status(404).json({ error: 'Файл не найден' });
  const base = path.resolve(config.dataDir, 'outputs', req.session.id);
  const resolved = path.resolve(row.stored_path);
  if (!resolved.startsWith(base + path.sep)) return res.status(403).json({ error: 'Доступ запрещён' });
  res.download(resolved, row.filename);
});

module.exports = { router, deleteSessionData };
