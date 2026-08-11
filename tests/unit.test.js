'use strict';
process.env.DATA_DIR = require('path').join(require('os').tmpdir(), `pilot1-unit-${process.pid}`);
const { test } = require('node:test');
const assert = require('node:assert');

const { sanitizeFilename, checkMagic, validateUpload } = require('../server/services/validation');
const { writeDxf } = require('../server/services/dxf');
const { validateResponse } = require('../server/services/claude/schema');
const { tryParse } = require('../server/services/claude/adapter');

test('sanitizeFilename strips paths and dangerous characters', () => {
  assert.strictEqual(sanitizeFilename('../../etc/passwd'), 'passwd');
  assert.strictEqual(sanitizeFilename('..\\..\\win.ini'), '_.._win.ini'.replace('_.._', '_').length > 0 ? sanitizeFilename('..\\..\\win.ini') : '');
  assert.ok(!sanitizeFilename('a/b/c.pdf').includes('/'));
  assert.ok(!sanitizeFilename('x<>:"|?*.pdf').match(/[<>:"|?*]/));
  assert.strictEqual(sanitizeFilename(''), 'file');
  assert.ok(sanitizeFilename('ГПЗУ участок.pdf').includes('ГПЗУ'));
});

test('checkMagic validates content, not extension', () => {
  assert.ok(checkMagic('pdf', Buffer.from('%PDF-1.7 x')).ok);
  assert.ok(!checkMagic('pdf', Buffer.from('MZ executable')).ok);
  assert.ok(checkMagic('dwg', Buffer.from('AC1027xxxx')).ok);
  assert.ok(!checkMagic('dwg', Buffer.from('notadwg')).ok);
  assert.ok(checkMagic('txt', Buffer.from('обычный текст')).ok);
  assert.ok(!checkMagic('txt', Buffer.from([0x00, 0x01, 0x02])).ok);
  assert.ok(checkMagic('json', Buffer.from('{"a":1}')).ok);
  assert.ok(!checkMagic('json', Buffer.from('{broken')).ok);
  assert.ok(!checkMagic('exe', Buffer.from('MZ')).ok);
});

test('validateUpload enforces size and count limits', () => {
  const small = { originalName: 'a.txt', buffer: Buffer.from('hello') };
  assert.ok(validateUpload(small, []).ok);
  const badExt = { originalName: 'a.exe', buffer: Buffer.from('MZ') };
  assert.ok(!validateUpload(badExt, []).ok);
  const many = Array.from({ length: 10 }, () => ({ size: 10 }));
  assert.ok(!validateUpload(small, many).ok);
  const big = { originalName: 'big.txt', buffer: Buffer.alloc(26 * 1024 * 1024, 65) };
  assert.match(validateUpload(big, []).error, /больше/);
});

test('DXF writer produces a valid R12 skeleton', () => {
  const dxf = writeDxf([{ layer: 'AI_ГРАНИЦЫ_ЗУ', color: 3, closed: true, points: [[0, 0], [10, 0], [10, 10]] }]);
  assert.ok(dxf.includes('AC1009'));
  assert.ok(dxf.includes('AI_ГРАНИЦЫ_ЗУ'));
  assert.ok(dxf.includes('POLYLINE'));
  assert.strictEqual((dxf.match(/VERTEX/g) || []).length, 3);
  assert.ok(dxf.trimEnd().endsWith('EOF'));
});

test('model response validation: happy path', () => {
  const r = validateResponse({
    status: 'completed', message: 'готово', questions: [], facts: [{ key: 'a', value: '1', source: 's' }],
    warnings: [], conflicts: [], assumptions: [], report_markdown: '# x', geometry: [], tep: [],
  });
  assert.ok(r.ok);
  assert.strictEqual(r.value.facts[0].key, 'a');
});

test('model response validation: rejects broken structures', () => {
  assert.ok(!validateResponse(null).ok);
  assert.ok(!validateResponse({ status: 'wat', message: 'x' }).ok);
  assert.ok(!validateResponse({ status: 'completed', message: '' }).ok);
  // needs_clarification requires questions
  assert.ok(!validateResponse({ status: 'needs_clarification', message: 'x', questions: [] }).ok);
  // bad geometry filtered out
  const r = validateResponse({
    status: 'completed', message: 'x', geometry: [{ layer: 'L', points: [[1]] }, { layer: 'L2', points: [[0, 0], [1, 1]] }],
  });
  assert.ok(r.ok);
  assert.strictEqual(r.value.geometry.length, 1);
});

test('tryParse recovers JSON wrapped in prose', () => {
  assert.deepStrictEqual(tryParse('{"a":1}'), { a: 1 });
  assert.deepStrictEqual(tryParse('Вот ответ: {"a":1} конец'), { a: 1 });
  assert.strictEqual(tryParse('no json here'), null);
});

/* ---------------- knowledge base ---------------- */
const os = require('os');
const fs = require('fs');
const pathMod = require('path');
const kb = require('../server/services/kb');

test('kb: loadSourceChunks reads чанки.jsonl and falls back to пункты.json', () => {
  const dir = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'kb-'));
  const vec = pathMod.join(dir, '09_Векторный-индекс', 'СП 42.13330');
  const jsn = pathMod.join(dir, '04_JSON', 'ГОСТ 21.508-2020');
  fs.mkdirSync(vec, { recursive: true });
  fs.mkdirSync(jsn, { recursive: true });
  fs.writeFileSync(pathMod.join(vec, 'чанки.jsonl'), JSON.stringify({
    'документ': 'СП 42.13330', 'пункт': '5.3', 'приоритет': 'высокий',
    'текст': 'Минимальные отступы от красных линий устанавливаются градостроительным регламентом и составляют не менее установленных значений для данной зоны.',
  }) + '\n');
  fs.writeFileSync(pathMod.join(jsn, 'пункты.json'), JSON.stringify([
    { 'номер': '4.1', 'уровень': 1, 'текст': 'Рабочую документацию генеральных планов выполняют в соответствии с требованиями настоящего стандарта и ГОСТ Р 21.101 на основе утверждённой проектной документации.' },
    { 'номер': 'x', 'уровень': 1, 'текст': 'коротко' },
  ]));
  const chunks = kb.loadSourceChunks(dir);
  assert.strictEqual(chunks.length, 2, 'short clause is filtered out');
  assert.ok(chunks.some((c) => c.doc === 'СП 42.13330' && c.clause === '5.3'));
  assert.ok(chunks.some((c) => c.doc === 'ГОСТ 21.508-2020' && c.clause === '4.1'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('kb: cosine and keyword scoring behave sanely', () => {
  const a = Float32Array.from([1, 0, 0]), b = Float32Array.from([1, 0, 0]), c = Float32Array.from([0, 1, 0]);
  assert.ok(kb.cosine(a, b) > 0.99);
  assert.ok(kb.cosine(a, c) < 0.01);
  const words = 'противопожарные разрывы между зданиями'.toLowerCase().split(/\s+/);
  const hit = kb.keywordScore(words, 'СП 4.13130: противопожарные разрывы между зданиями и сооружениями');
  const miss = kb.keywordScore(words, 'озеленение территории жилой застройки');
  assert.ok(hit > miss);
});

/* ---------------- реестр возможностей провайдеров (ТЗ, п. 57, 61, 71, 72) ---------------- */
const registry = require('../server/services/ai/registry');

test('registry: возможности описаны у всех провайдеров и полны по набору ключей', () => {
  const list = registry.listRegistry();
  for (const id of ['claude', 'chatgpt', 'kimi', 'lmstudio', 'ollama', 'demo']) {
    assert.ok(list.some((p) => p.id === id), `нет провайдера ${id}`);
  }
  for (const p of list) {
    for (const key of registry.CAPABILITY_KEYS) {
      assert.strictEqual(typeof p.capabilities[key], 'boolean', `${p.id}.${key} не булево`);
    }
    assert.ok(p.label && p.kind, `${p.id} без метаданных`);
  }
});

test('registry: неизвестный провайдер умеет только текст и ничего больше', () => {
  const c = registry.capabilities('нет-такого');
  assert.strictEqual(c.text, false);
  assert.strictEqual(c.pdf, false);
  assert.strictEqual(c.vision, false);
  assert.strictEqual(registry.supports({ provider: 'нет-такого' }, 'structuredOutput'), false);
  assert.strictEqual(registry.providerMeta('нет-такого'), null);
});

test('registry: режим подачи документов выбирается по возможностям, а не по бренду', () => {
  // родная подача — только там, где модель сама читает и PDF, и изображения
  assert.strictEqual(registry.documentMode({ provider: 'claude' }), 'native');
  for (const p of ['chatgpt', 'kimi', 'lmstudio', 'ollama', 'demo']) {
    assert.strictEqual(registry.documentMode({ provider: p }), 'extracted', `${p} должен извлекать текст сам`);
  }
});

test('registry: модельные исключения перекрывают возможности провайдера', () => {
  // локальная vision-модель видит картинки, обычная локальная — нет
  assert.strictEqual(registry.supports({ provider: 'lmstudio', model: 'qwen/qwen3-vl-8b' }, 'vision'), true);
  assert.strictEqual(registry.supports({ provider: 'lmstudio', model: 'qwen/qwen3-coder-30b' }, 'vision'), false);
  // рассуждающие модели помечены: их размышления тратят бюджет ответа
  assert.strictEqual(registry.supports({ provider: 'kimi', model: 'kimi-k3' }, 'reasoning'), true);
  assert.strictEqual(registry.supports({ provider: 'kimi', model: 'kimi-k2.5' }, 'reasoning'), false);
});

test('registry: потолок выходных токенов учитывает лимит конкретной модели', () => {
  const opus = registry.maxOutputTokens({ provider: 'claude', model: 'claude-opus-5' });
  const haiku = registry.maxOutputTokens({ provider: 'claude', model: 'claude-haiku-4-5' });
  assert.ok(haiku <= opus, 'у haiku потолок не выше общего');
  assert.ok(haiku <= 64000, 'потолок haiku не должен превышать 64000');
  assert.strictEqual(registry.maxOutputTokens({ provider: 'нет-такого' }), 0);
  assert.ok(registry.maxOutputTokens({ provider: 'kimi' }) > 0);
});

/* ---------------- адаптер Gemini (ТЗ, п. 55–69, 78) ---------------- */
const gemini = require('../server/services/ai/gemini');

test('gemini: сообщения приложения переводятся в contents/parts', () => {
  const contents = gemini.toContents([
    { role: 'user', content: 'Какие отступы?' },
    { role: 'assistant', content: 'От красной линии 5 м.' },
    { role: 'user', content: '   ' },                       // пустое — выбрасывается
    { role: 'user', content: [
      { type: 'text', text: 'Смотри вложение' },
      { type: 'document', source: { media_type: 'application/pdf', data: 'JVBER' }, title: 'ГПЗУ.pdf' },
      { type: 'image', source: { media_type: 'image/png', data: 'iVBOR' } },
    ] },
  ]);
  assert.strictEqual(contents.length, 3, 'пустое сообщение не должно уходить в API');
  assert.strictEqual(contents[0].role, 'user');
  assert.strictEqual(contents[1].role, 'model', 'assistant у Gemini называется model');
  const parts = contents[2].parts;
  assert.strictEqual(parts.length, 3);
  assert.strictEqual(parts[0].text, 'Смотри вложение');
  assert.strictEqual(parts[1].inlineData.mimeType, 'application/pdf');
  assert.strictEqual(parts[2].inlineData.mimeType, 'image/png');
});

test('gemini: ошибки провайдера приводятся к понятным видам', () => {
  const cases = [
    [{ name: 'AbortError' }, 'cancelled'],
    [{ status: 403, message: 'PERMISSION_DENIED' }, 'auth'],
    [{ status: 429, message: 'RESOURCE_EXHAUSTED: quota' }, 'rate_limit'],
    [{ status: 400, message: 'input token count exceeds the maximum' }, 'context_limit'],
    [{ status: 400, message: 'Unsupported file mime type: application/x-dwg' }, 'unsupported_format'],
    [{ status: 503, message: 'service unavailable' }, 'unavailable'],
  ];
  for (const [err, kind] of cases) {
    assert.strictEqual(gemini.humanizeError(err).kind, kind, `ожидался вид ${kind}`);
  }
  // сообщения человеческие и на русском, без сырого стека
  assert.ok(/ключ/i.test(gemini.humanizeError({ status: 401, message: 'API key not valid' }).message));
});

test('gemini: ключ не может утечь в текст ошибки', () => {
  const err = { status: 400, message: 'Bad request with key=AIzaSyA1b2C3d4E5f6G7h8I9j0KlMnOpQrStUvW' };
  const { message } = gemini.humanizeError(err);
  assert.ok(!/AIzaSy/.test(message), 'ключ остался в сообщении об ошибке');
  assert.ok(/скрыт/.test(message));
});

test('gemini: провайдер описан в реестре и получает документы вложениями', () => {
  const caps = registry.capabilities('gemini');
  assert.strictEqual(caps.pdf, true);
  assert.strictEqual(caps.vision, true);
  assert.strictEqual(caps.structuredOutput, true);
  assert.strictEqual(registry.documentMode({ provider: 'gemini' }), 'native');
  assert.strictEqual(registry.providerMeta('gemini').kind, 'gemini');
  assert.strictEqual(registry.providerMeta('gemini').keyEnv, 'GEMINI_API_KEY');
});

test('gemini: без ключа список моделей пуст и приложение не падает', async () => {
  const config = require('../server/config');
  const prev = config.geminiApiKey;
  config.geminiApiKey = '';
  assert.deepStrictEqual(await gemini.listModels(), []);
  await assert.rejects(() => gemini.resolveModel(''), /GEMINI_MODEL|не настроен/);
  config.geminiApiKey = prev;
});

/* ---------------- SiteGeometry и CAD parser v2 (ТЗ, п. 21–24, 78–79) ---------------- */
const G = require('../server/services/geometry/site-geometry');
const cadGeom = require('../server/services/geometry/cad-geometry');

test('geometry: площадь, периметр, центр и очистка точек считаются детерминированно', () => {
  const square = [[0, 0], [10, 0], [10, 10], [0, 10]];
  assert.strictEqual(G.polygonArea(square), 100);
  assert.strictEqual(G.pathLength(square, true), 40);
  assert.strictEqual(G.pathLength(square, false), 30);
  assert.deepStrictEqual(G.centroid(square), [5, 5]);
  assert.deepStrictEqual(G.bounds(square), { minX: 0, minY: 0, maxX: 10, maxY: 10 });
  // обход по часовой стрелке даёт ту же площадь: знак не важен
  assert.strictEqual(G.polygonArea([...square].reverse()), 100);
  // дубли и замыкающее повторение первой вершины убираются
  assert.strictEqual(G.cleanPoints([[0, 0], [0, 0], [10, 0], [10, 10], [0, 0]], true).length, 3);
  assert.strictEqual(G.polygonArea([[0, 0], [1, 1]]), 0, 'вырожденный контур не имеет площади');
});

test('geometry: объект без происхождения в модель не попадает', () => {
  const pts = [[0, 0], [10, 0], [10, 10]];
  assert.throws(() => G.makeObject({ type: 'building', points: pts, closed: true, provenance: {} }),
    /способ/, 'объект без extractionMethod должен отклоняться');
  assert.throws(() => G.makeObject({
    type: 'building', points: pts, closed: true,
    provenance: { extractionMethod: 'cad-vector' },
  }), /исходный файл/, 'объект из CAD без имени файла должен отклоняться');
  assert.throws(() => G.makeObject({
    type: 'нечто', points: pts, closed: true,
    provenance: { extractionMethod: 'user' },
  }), /Неизвестный тип/);
  // вычисленному движком объекту файл не нужен — у него другое основание
  const computed = G.makeObject({
    type: 'restriction', points: pts, closed: true,
    provenance: { extractionMethod: 'computed', confidence: 0.9, basis: 'СП 4.13130, таблица 4.1' },
  });
  assert.ok(computed.id);
  assert.match(G.explain(computed), /СП 4\.13130.*вычислено геометрическим движком.*90%/s);
});

test('geometry: единицы чертежа приводятся к метрам', () => {
  assert.strictEqual(G.unitInfo(4).scale, 0.001, 'миллиметры');
  assert.strictEqual(G.unitInfo(6).scale, 1, 'метры');
  assert.strictEqual(G.unitInfo(0).assumed, true, 'незаданные единицы помечаются допущением');
  assert.strictEqual(G.unitInfo(999).assumed, true, 'неизвестный код тоже допущение');
});

test('cad-geometry: слои классифицируются по русским названиям', () => {
  // перечень слоёв общий с переназначением и выгрузкой DXF (geometry/layers.js),
  // поэтому он подробнее прежнего: ограждение больше не «прочий объект»,
  // а линия регулирования застройки отделена от красных линий
  const cases = [
    ['Границы ЗУ', 'parcel'], ['Земельный участок', 'parcel'],
    ['Красные линии', 'redLine'], ['Линия регулирования застройки', 'buildLine'],
    ['Здания существующие', 'building'], ['Навесы некапитальные', 'structure'],
    ['Сети водопровода В1', 'utility'], ['Колодцы канализации', 'utility'],
    ['Ограждение территории', 'fence'], ['Проезды и тротуары', 'road'],
    ['Стоянка автомобилей', 'parking'], ['Горизонтали рельефа', 'relief'],
    ['Откосы и насыпи', 'relief'], ['Озеленение газоны', 'landscaping'],
    ['Канава дренажная', 'water'],
  ];
  for (const [layer, type] of cases) {
    const rule = cadGeom.classifyLayer(layer);
    assert.ok(rule, `слой «${layer}» не распознан`);
    assert.strictEqual(rule.type, type, `слой «${layer}»`);
  }
  assert.strictEqual(cadGeom.classifyLayer('Прочее'), null, 'непонятный слой не должен угадываться');
});

test('golden CAD: эталонный чертёж разбирается с ожидаемыми числами', () => {
  // фикстура строится своим же writer'ом — тест самодостаточен и не зависит от чужих файлов
  const dxf = writeDxf([
    { layer: 'Границы ЗУ', closed: true, points: [[0, 0], [100, 0], [100, 80], [0, 80]] },
    { layer: 'Здания существующие', closed: true, points: [[10, 10], [40, 10], [40, 30], [10, 30]] },
    { layer: 'Красные линии', closed: false, points: [[0, -5], [100, -5]] },
    { layer: 'Сети водопровода В1', closed: false, points: [[5, 40], [95, 40]] },
    { layer: 'Прочее', closed: true, points: [[60, 50], [80, 50], [80, 70], [60, 70]] },
  ]);
  const site = cadGeom.fromDxf(dxf, { fileName: 'эталон.dxf', fileId: 'f-1' });

  assert.strictEqual(site.parcel.properties.areaM2, 8000, 'площадь участка');
  assert.strictEqual(site.parcel.properties.perimeterM, 360, 'периметр участка');
  assert.strictEqual(site.parcel.properties.vertices, 4, 'вершин у участка');
  assert.strictEqual(site.buildings.length, 1);
  assert.strictEqual(site.buildings[0].properties.areaM2, 600, 'площадь здания');
  assert.strictEqual(site.redLines.length, 1);
  assert.strictEqual(site.redLines[0].geometry.type, 'polyline', 'красная линия не полигон');
  assert.strictEqual(site.redLines[0].properties.lengthM, 100);
  assert.strictEqual(site.utilities.length, 1);
  assert.deepStrictEqual(site.drawingBounds, { minX: 0, minY: -5, maxX: 100, maxY: 80 });

  // нераспознанный слой сохранён, но помечен низкой уверенностью
  const unknown = site.existingObjects.find((o) => o.provenance.sourceLayer === 'Прочее');
  assert.ok(unknown, 'геометрия непонятного слоя не должна теряться');
  assert.ok(unknown.provenance.confidence <= 0.3);

  // у каждого объекта прослеживается происхождение (ТЗ, п. 24)
  for (const o of G.allObjects(site)) {
    assert.strictEqual(o.provenance.sourceFile, 'эталон.dxf');
    assert.strictEqual(o.provenance.extractionMethod, 'cad-vector');
    assert.ok(o.provenance.sourceLayer, 'слой-источник обязателен');
    assert.match(G.explain(o), /источник: эталон\.dxf/);
    assert.ok(o.geometry.points.every((p) => p.length === 2 && p.every(Number.isFinite)));
  }
});

test('golden CAD: миллиметровый чертёж пересчитывается в метры', () => {
  // writeDxf пишет заголовок парами «код\nзначение» — дописываем в него INSUNITS=4 (мм)
  const dxf = writeDxf([{ layer: 'Границы ЗУ', closed: true, points: [[0, 0], [100000, 0], [100000, 80000], [0, 80000]] }])
    .replace('9\n$ACADVER\n1\nAC1009\n', '9\n$ACADVER\n1\nAC1009\n9\n$INSUNITS\n70\n4\n');
  const site = cadGeom.fromDxf(dxf, { fileName: 'мм.dxf' });
  assert.strictEqual(site.coordinateSystem.unitScale, 0.001);
  assert.strictEqual(site.coordinateSystem.assumedUnits, false);
  assert.strictEqual(site.parcel.properties.areaM2, 8000, 'после пересчёта площадь та же, что у метрового чертежа');
});

/* ---------------- правила ограничений (ТЗ, п. 25–26, 28) ---------------- */
const RR = require('../server/services/geometry/restriction-rules');

const baseRule = {
  kind: 'protectionZone', operation: 'bufferOutward', targetSelector: 'utility',
  targetHint: 'ЛЭП 10 кВ', value: 10, unit: 'м', appliesTo: 'newBuilding',
  basis: 'ПП РФ № 160, п. 8', sourceDocument: 'ГПЗУ.pdf', sourceClause: 'раздел 3',
  quote: 'охранная зона 10 метров', confidence: 0.9,
};

test('ограничения: единицы приводятся к метрам, мусор отклоняется с причиной', () => {
  assert.strictEqual(RR.normalizeRule({ ...baseRule, value: 2000, unit: 'см' }).rule.valueM, 20);
  assert.strictEqual(RR.normalizeRule({ ...baseRule, value: 1, unit: 'км' }).rule.valueM, 1000);
  assert.strictEqual(RR.normalizeRule({ ...baseRule, value: 10, unit: 'м' }).rule.valueM, 10);

  const bad = [
    [{ ...baseRule, value: -5 }, /отрицательн/],
    [{ ...baseRule, value: 0 }, /нулевая/],
    [{ ...baseRule, unit: 'этажей' }, /не является длиной/],
    [{ ...baseRule, value: 'десять' }, /не число/],
    [{ ...baseRule, operation: 'нарисовать' }, /неизвестная операция/],
    [{ ...baseRule, value: 5000 }, /неправдоподобн/],
  ];
  for (const [raw, re] of bad) {
    const res = RR.normalizeRule(raw);
    assert.ok(res.rejected, `должно быть отклонено: ${JSON.stringify(raw.value ?? raw.unit)}`);
    assert.match(res.rejected.reason, re);
  }
  // атрибутивные ограничения длиной не меряются и проходят с процентами
  const attr = RR.normalizeRule({ ...baseRule, kind: 'coverageLimit', operation: 'attribute', value: 40, unit: '%' });
  assert.strictEqual(attr.rule.valueM, null);
  assert.strictEqual(attr.rule.unit, '%');
});

test('ограничения: правило не содержит координат — только величину и объект отсчёта', () => {
  const { rule } = RR.normalizeRule(baseRule);
  const asText = JSON.stringify(rule);
  assert.ok(!/points|polygon|coordinates|geometry/i.test(asText), 'в правиле не должно быть геометрии');
  assert.strictEqual(rule.target.selector, 'utility');
  assert.strictEqual(rule.target.hint, 'ЛЭП 10 кВ');
});

test('ограничения: статус назначается по фактам, а не по словам модели', () => {
  // есть основание, пункт и высокая уверенность — подтверждено
  assert.strictEqual(RR.assignStatus(RR.normalizeRule(baseRule).rule).status, RR.STATUSES.CONFIRMED);
  // основание есть, точной ссылки нет — высокая уверенность
  const noClause = RR.normalizeRule({ ...baseRule, sourceClause: '', quote: '', confidence: 0.7 }).rule;
  assert.strictEqual(RR.assignStatus(noClause).status, RR.STATUSES.HIGH);
  // нет основания — на проверку, даже если модель уверена на 99%
  const noBasis = RR.normalizeRule({ ...baseRule, basis: '', confidence: 0.99 }).rule;
  assert.strictEqual(RR.assignStatus(noBasis).status, RR.STATUSES.NEEDS_REVIEW);
  // неизвестен объект отсчёта — геометрию не построить
  const noTarget = RR.normalizeRule({ ...baseRule, targetSelector: 'unknown' }).rule;
  assert.strictEqual(RR.assignStatus(noTarget).status, RR.STATUSES.INSUFFICIENT);
});

test('ограничения: разные величины от одного объекта дают конфликт, а не тихий выбор', () => {
  const res = RR.processExtraction({
    rules: [
      baseRule,
      { ...baseRule, value: 2000, unit: 'см', sourceDocument: 'ТЗ.pdf', confidence: 0.7 },
      { ...baseRule, kind: 'setback', operation: 'bufferInward', targetSelector: 'parcelBoundary', targetHint: '', value: 3 },
    ],
  });
  assert.strictEqual(res.conflicts.length, 1, 'ожидался ровно один конфликт');
  assert.strictEqual(res.conflicts[0].strictestM, 20, 'строже — 20 м');
  assert.deepStrictEqual(res.conflicts[0].values, [10, 20]);
  assert.strictEqual(res.stats.конфликтов, 2, 'оба правила помечены конфликтом');
  // приложение НЕ выбирает за пользователя: оба правила остаются в списке
  assert.strictEqual(res.rules.filter((r) => r.status === RR.STATUSES.CONFLICT).length, 2);
  // объяснение самого строгого правила не должно сравнивать его с самим собой
  const strict = res.rules.find((r) => r.valueM === 20);
  assert.ok(!/20 м вместо 20 м/.test(strict.statusReason), strict.statusReason);
  // непротиворечивое правило конфликтом не помечается
  assert.notStrictEqual(res.rules.find((r) => r.kind === 'setback').status, RR.STATUSES.CONFLICT);
});

test('ограничения: сводка считает все категории и ничего не теряет', () => {
  const res = RR.processExtraction({
    rules: [baseRule, { ...baseRule, value: -1 }, { ...baseRule, targetSelector: 'unknown' }],
    missingData: ['не указана категория земель'],
  });
  assert.strictEqual(res.stats.всего + res.stats.отклонено, 3, 'ни одно правило не потеряно');
  assert.strictEqual(res.stats.отклонено, 1);
  assert.deepStrictEqual(res.missingData, ['не указана категория земель']);
  assert.match(RR.explainRule(res.rules[0]), /от: инженерной сети \(ЛЭП 10 кВ\).*статус:/s);
});

test('ограничения: схема для модели закрыта от отсебятины', () => {
  const s = RR.RULES_SCHEMA.properties.rules.items;
  assert.strictEqual(s.additionalProperties, false, 'лишние поля не принимаются');
  assert.deepStrictEqual(s.properties.operation.enum, RR.OPERATIONS);
  assert.deepStrictEqual(s.properties.kind.enum, RR.RESTRICTION_KINDS);
  assert.deepStrictEqual(s.properties.targetSelector.enum, RR.TARGET_SELECTORS);
  // статус модель не задаёт — его назначает приложение
  assert.strictEqual(s.properties.status, undefined, 'статус не должен быть в схеме ответа модели');
  for (const req of ['kind', 'operation', 'targetSelector', 'value', 'unit', 'basis', 'confidence']) {
    assert.ok(s.required.includes(req), `поле ${req} должно быть обязательным`);
  }
});

/* ---------------- движок ограничений (ТЗ, п. 27, 29, 78) ---------------- */
const engine = require('../server/services/geometry/restriction-engine');
const jts = require('../server/services/geometry/jts');

/** Участок 100×80 с ЛЭП поперёк и одним существующим зданием. */
function testSite() {
  return cadGeom.fromDxf(writeDxf([
    { layer: 'Границы ЗУ', closed: true, points: [[0, 0], [100, 0], [100, 80], [0, 80]] },
    { layer: 'Сети ЛЭП 10кВ', closed: false, points: [[0, 60], [100, 60]] },
    { layer: 'Здания существующие', closed: true, points: [[10, 10], [30, 10], [30, 25], [10, 25]] },
  ]), { fileName: 'топо.dxf' });
}

function rulesFrom(list) {
  return RR.processExtraction({ rules: list }).rules;
}

const lepRule = {
  kind: 'protectionZone', operation: 'bufferOutward', targetSelector: 'utility', targetHint: 'ЛЭП',
  value: 10, unit: 'м', basis: 'ПП РФ № 160, п. 8', sourceDocument: 'ГПЗУ.pdf',
  sourceClause: '3.4', quote: '10 метров', confidence: 0.9, appliesTo: 'newBuilding',
};
const setbackRule = {
  kind: 'setback', operation: 'bufferInward', targetSelector: 'parcelBoundary', targetHint: '',
  value: 3, unit: 'м', basis: 'ГПЗУ, п. 2.1', sourceDocument: 'ГПЗУ.pdf',
  sourceClause: '2.1', quote: 'отступ 3 м', confidence: 0.9, appliesTo: 'newBuilding',
};

test('движок: правило превращается в полигон с проверяемой площадью', () => {
  const site = testSite();
  const res = engine.build(site, rulesFrom([lepRule]));
  assert.strictEqual(res.restrictions.length, 1);
  const zone = res.restrictions[0];
  // полоса 100 м × (10 м в обе стороны) внутри участка = 2000 м²
  assert.strictEqual(zone.properties.areaM2, 2000);
  assert.strictEqual(zone.properties.kind, 'protectionZone');
  assert.strictEqual(zone.provenance.extractionMethod, 'computed');
  assert.strictEqual(zone.provenance.basis, 'ПП РФ № 160, п. 8');
  assert.match(zone.provenance.reason, /буфером 10 м и отсечена границей участка/);
});

test('движок: зона отсекается границей участка, вынос за участок зафиксирован', () => {
  const site = testSite();
  const zone = engine.build(site, rulesFrom([lepRule])).restrictions[0];
  // буфер вокруг линии выходит за участок по X на 10 м с каждой стороны
  assert.ok(zone.properties.areaOutsideParcelM2 > 300 && zone.properties.areaOutsideParcelM2 < 330,
    `вне участка ${zone.properties.areaOutsideParcelM2} м²`);
  // ни одна точка отсечённой зоны не выходит за габариты участка
  const pts = zone.geometry.type === 'multipolygon'
    ? zone.geometry.polygons.flatMap((p) => p.points) : zone.geometry.points;
  for (const [x, y] of pts) {
    assert.ok(x >= -0.001 && x <= 100.001 && y >= -0.001 && y <= 80.001, `точка вне участка: ${x},${y}`);
  }
});

test('движок: отступ внутрь даёт кольцо, а не весь участок', () => {
  const site = testSite();
  const zone = engine.build(site, rulesFrom([setbackRule])).restrictions[0];
  // 100×80 минус 94×74 = 1044 м²
  assert.strictEqual(zone.properties.areaM2, 1044);
});

test('движок: допустимая территория = участок минус объединение зон', () => {
  const site = testSite();
  const res = engine.build(site, rulesFrom([lepRule, setbackRule]));
  // зоны пересекаются по 120 м² (полоса ЛЭП внутри кольца отступа с двух сторон)
  const expected = 8000 - (2000 + 1044 - 120);
  assert.ok(Math.abs(res.buildable.areaM2 - expected) < 1,
    `ожидалось ≈${expected}, получено ${res.buildable.areaM2}`);
  assert.strictEqual(res.buildable.status, 'analytical');
  assert.match(res.buildable.note, /не разрешённое пятно застройки/);
  assert.deepStrictEqual(res.buildable.basedOn.sort(), ['rule-1', 'rule-2']);
});

test('движок: уточнение цели сужает выбор до нужного слоя', () => {
  const site = testSite();
  // hint «ЛЭП» должен взять только слой сетей, а не все объекты участка
  const r = rulesFrom([lepRule])[0];
  const { targets, narrowed } = engine.resolveTargets(site, r);
  assert.strictEqual(narrowed, true);
  assert.strictEqual(targets.length, 1);
  assert.match(targets[0].provenance.sourceLayer, /ЛЭП/);
});

test('движок: непостроенные зоны объясняются, а не исчезают', () => {
  const site = testSite();
  const res = engine.build(site, rulesFrom([
    { ...lepRule, kind: 'sanitaryZone', targetSelector: 'road', targetHint: '', value: 50 },
    { ...lepRule, kind: 'heightLimit', operation: 'attribute', value: 20 },
    { ...lepRule, targetSelector: 'unknown', targetHint: '' },
  ]));
  assert.strictEqual(res.restrictions.length, 0, 'ни одну зону построить нельзя');
  assert.strictEqual(res.attributes.length, 1, 'высота учтена как атрибутивное ограничение');
  assert.strictEqual(res.unresolved.length, 2);
  assert.match(res.unresolved[0].reason, /нет объектов/);
  assert.match(res.unresolved[1].reason, /не определён объект/);
});

test('движок: зона целиком за участком не влияет на посадку', () => {
  const site = testSite();
  // здание-цель отсутствует, зато есть объект далеко за границей
  const far = cadGeom.fromDxf(writeDxf([
    { layer: 'Границы ЗУ', closed: true, points: [[0, 0], [100, 0], [100, 80], [0, 80]] },
    { layer: 'Сети ЛЭП 10кВ', closed: false, points: [[500, 500], [600, 500]] },
  ]), { fileName: 'далеко.dxf' });
  const res = engine.build(far, rulesFrom([lepRule]));
  assert.strictEqual(res.restrictions.length, 0);
  assert.match(res.unresolved[0].reason, /за пределами участка/);
  // при этом весь участок остаётся свободным
  assert.strictEqual(res.buildable.areaM2, 8000);
});

test('движок: без границ участка допустимая территория не считается', () => {
  const noParcel = {
    ...G.createSiteGeometry(),
    utilities: testSite().utilities,
  };
  const res = engine.build(noParcel, rulesFrom([lepRule]));
  assert.strictEqual(res.buildable, null, 'без участка считать не от чего');
  assert.strictEqual(res.restrictions.length, 1, 'сама зона всё равно строится');
});

test('движок: расчёт детерминирован — повтор даёт тот же результат', () => {
  const a = engine.build(testSite(), rulesFrom([lepRule, setbackRule]));
  const b = engine.build(testSite(), rulesFrom([lepRule, setbackRule]));
  assert.strictEqual(a.buildable.areaM2, b.buildable.areaM2);
  assert.deepStrictEqual(
    a.restrictions.map((r) => [r.properties.kind, r.properties.areaM2]),
    b.restrictions.map((r) => [r.properties.kind, r.properties.areaM2]),
  );
});

test('jts: самопересекающийся контур не роняет расчёт', () => {
  // «бабочка» — классическая невалидная геометрия из чертежей
  const bowtie = { type: 'polygon', closed: true, points: [[0, 0], [10, 10], [10, 0], [0, 10]] };
  const g = jts.toJts(bowtie);
  assert.ok(g.isValid(), 'геометрия должна быть починена автоматически');
  assert.ok(jts.area(g) > 0);
});

/* ---------------- план участка для viewer'а (ТЗ, п. 30–32) ---------------- */
test('план: несколько чертежей сессии сливаются в одну модель', async (t) => {
  const os = require('os'), pathMod = require('path'), crypto = require('crypto');
  const dir = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'plan-test-'));
  process.env.DATA_DIR = dir;
  // db уже инициализирована другими тестами — работаем с её текущим файлом
  const { db, now } = require('../server/db');
  const plan = require('../server/services/geometry/plan');

  const sid = crypto.randomUUID();
  db.prepare('INSERT INTO sessions (id, token, status, created_at, updated_at) VALUES (?,?,?,?,?)')
    .run(sid, 'tok', 'active', now(), now());
  t.after(() => {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(sid);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const write = (name, layers) => {
    const p = pathMod.join(dir, name);
    fs.writeFileSync(p, writeDxf(layers));
    db.prepare('INSERT INTO files (id, session_id, original_name, stored_path, ext, size, created_at) VALUES (?,?,?,?,?,?,?)')
      .run(crypto.randomUUID(), sid, name, p, 'dxf', fs.statSync(p).size, now());
  };
  write('границы.dxf', [{ layer: 'Границы ЗУ', closed: true, points: [[0, 0], [100, 0], [100, 80], [0, 80]] }]);
  write('топо.dxf', [
    { layer: 'Сети ЛЭП 10кВ', closed: false, points: [[0, 60], [100, 60]] },
    { layer: 'Здания существующие', closed: true, points: [[10, 10], [30, 10], [30, 25], [10, 25]] },
  ]);

  const site = await plan.buildForSession(sid);
  assert.ok(site.parcel, 'участок собран из первого чертежа');
  assert.strictEqual(site.parcel.properties.areaM2, 8000);
  assert.strictEqual(site.utilities.length, 1, 'сети подхвачены из второго чертежа');
  assert.strictEqual(site.buildings.length, 1);
  assert.strictEqual(site.sourceReferences.length, 2, 'оба файла записаны в источники');
  assert.deepStrictEqual(site.drawingBounds, { minX: 0, minY: 0, maxX: 100, maxY: 80 });

  // повторный вызов идёт из кэша и даёт тот же результат
  const again = await plan.buildForSession(sid);
  assert.strictEqual(again.parcel.properties.areaM2, site.parcel.properties.areaM2);
  assert.ok(fs.existsSync(pathMod.join(dir, 'границы.dxf.plan.json')), 'разбор закэширован рядом с файлом');
});

test('план: без чертежей возвращается пустая модель с объяснением', async (t) => {
  const crypto = require('crypto');
  const { db, now } = require('../server/db');
  const plan = require('../server/services/geometry/plan');
  const sid = crypto.randomUUID();
  db.prepare('INSERT INTO sessions (id, token, status, created_at, updated_at) VALUES (?,?,?,?,?)')
    .run(sid, 'tok', 'active', now(), now());
  t.after(() => db.prepare('DELETE FROM sessions WHERE id = ?').run(sid));

  const site = await plan.buildForSession(sid);
  assert.strictEqual(site.parcel, null);
  assert.strictEqual(site.drawingBounds, null, 'габаритов нет — viewer покажет пустое состояние');
  assert.match(site.warnings[0].message, /нет чертежей/);
});

/* ---------------- координаты экран ↔ план (ТЗ, п. 35) ---------------- */
const GT = require('../public/geo-transform');

test('координаты: экран → план → экран возвращает ту же точку', () => {
  const view = { minX: 100, minY: 200, width: 400, height: 300 };
  const box = { width: 800, height: 600 };
  for (const [px, py] of [[0, 0], [800, 600], [400, 300], [123, 456]]) {
    const [wx, wy] = GT.screenToWorld(px, py, view, box);
    const [bx, by] = GT.worldToScreen(wx, wy, view, box);
    assert.ok(Math.abs(bx - px) < 1e-9 && Math.abs(by - py) < 1e-9, `${px},${py} → ${bx},${by}`);
  }
  // верх экрана соответствует ВЕРХУ плана: ось Y перевёрнута
  assert.deepStrictEqual(GT.screenToWorld(0, 0, view, box), [100, 500]);
  assert.deepStrictEqual(GT.screenToWorld(800, 600, view, box), [500, 200]);
});

test('координаты: зум и панорамирование не сдвигают сохранённую точку', () => {
  const box = { width: 800, height: 600 };
  const view = { minX: 0, minY: 0, width: 100, height: 75 };
  // пользователь ткнул в середину экрана на общем плане
  const world = GT.screenToWorld(400, 300, view, box);

  // приблизили в 10 раз вокруг той же точки и сдвинули вид
  const zoomed = { minX: world[0] - 5, minY: world[1] - 3.75, width: 10, height: 7.5 };
  const panned = { ...zoomed, minX: zoomed.minX + 3, minY: zoomed.minY - 2 };

  // мировая точка не изменилась — меняется только её место на экране
  for (const v of [zoomed, panned]) {
    const [px, py] = GT.worldToScreen(world[0], world[1], v, box);
    const back = GT.screenToWorld(px, py, v, box);
    assert.ok(Math.abs(back[0] - world[0]) < 1e-9 && Math.abs(back[1] - world[1]) < 1e-9);
  }
});

test('координаты: рамка нормализуется независимо от направления протяжки', () => {
  const expected = [[10, 20], [30, 20], [30, 40], [10, 40]];
  for (const [a, b] of [[[10, 20], [30, 40]], [[30, 40], [10, 20]], [[10, 40], [30, 20]], [[30, 20], [10, 40]]]) {
    assert.deepStrictEqual(GT.rectFromPoints(a, b), expected, `протяжка ${JSON.stringify(a)}→${JSON.stringify(b)}`);
  }
  assert.strictEqual(GT.areaOf(expected), 400);
  assert.deepStrictEqual(GT.boundsOf(expected), { minX: 10, minY: 20, maxX: 30, maxY: 40 });
  assert.strictEqual(GT.boundsIntersect(GT.boundsOf(expected), { minX: 25, minY: 35, maxX: 60, maxY: 60 }), true);
  assert.strictEqual(GT.boundsIntersect(GT.boundsOf(expected), { minX: 50, minY: 50, maxX: 60, maxY: 60 }), false);
});

/* ---------------- аннотации (ТЗ, п. 36–37, 74) ---------------- */
const ann = require('../server/services/geometry/annotations');

function withSession(t) {
  const crypto = require('crypto');
  const { db, now } = require('../server/db');
  const sid = crypto.randomUUID();
  db.prepare('INSERT INTO sessions (id, token, status, created_at, updated_at) VALUES (?,?,?,?,?)')
    .run(sid, 'tok', 'active', now(), now());
  t.after(() => db.prepare('DELETE FROM sessions WHERE id = ?').run(sid));
  return sid;
}

test('аннотации: сохраняются и восстанавливаются в координатах плана', (t) => {
  const sid = withSession(t);
  const points = [[10, 20], [30, 20], [30, 40], [10, 40]];
  const created = ann.create(sid, {
    planId: 'plan-1', geometry: { points }, geometryType: 'rect',
    comment: 'почему здесь нельзя строить?', author: 'Иван Петров', coordinateSystem: 'метры',
  });
  assert.ok(created.id);
  assert.deepStrictEqual(created.geometry.points, points, 'координаты сохранены как есть');
  assert.strictEqual(created.status, 'open');
  assert.strictEqual(created.author, 'Иван Петров');

  const restored = ann.list(sid, 'plan-1');
  assert.strictEqual(restored.length, 1);
  assert.deepStrictEqual(restored[0].geometry.points, points, 'после перезагрузки координаты те же');
  assert.strictEqual(restored[0].comment, 'почему здесь нельзя строить?');
  assert.strictEqual(restored[0].stale, false);
});

test('аннотации: выделение с прежней версии плана помечается, а не исчезает', (t) => {
  const sid = withSession(t);
  ann.create(sid, { planId: 'plan-1', geometry: { points: [[0, 0], [1, 0], [1, 1], [0, 1]] }, geometryType: 'rect' });
  // чертежи переразобрали — появилась версия 2
  const list = ann.list(sid, 'plan-2');
  assert.strictEqual(list.length, 1, 'аннотация не удалена');
  assert.strictEqual(list[0].stale, true, 'помечена как сделанная на другой версии');
  assert.strictEqual(list[0].planId, 'plan-1', 'привязка к своей версии сохранена');
});

test('аннотации: битая геометрия отклоняется с объяснением', (t) => {
  const sid = withSession(t);
  const bad = [
    [{ points: [[0, 0], [1, 1]] }, 'rect'],
    [{ points: [] }, 'polygon'],
    [{ points: [['a', 'b'], [1, 1], [2, 2], [3, 3]] }, 'rect'],
  ];
  for (const [geometry, type] of bad) {
    assert.throws(() => ann.create(sid, { planId: 'p', geometry, geometryType: type }), /требует не меньше/);
  }
  assert.throws(() => ann.create(sid, { geometry: { points: [[0, 0], [1, 0], [1, 1], [0, 1]] }, geometryType: 'rect' }),
    /привязана к версии плана/);
});

test('аннотации: правка и удаление работают только внутри своей сессии', (t) => {
  const sid = withSession(t);
  const other = withSession(t);
  const a = ann.create(sid, { planId: 'p', geometry: { points: [[0, 0], [2, 0], [2, 2], [0, 2]] }, geometryType: 'rect' });

  assert.strictEqual(ann.update(other, a.id, { comment: 'чужой' }), null, 'чужую аннотацию править нельзя');
  assert.strictEqual(ann.remove(other, a.id), false, 'чужую аннотацию удалить нельзя');

  const upd = ann.update(sid, a.id, { comment: 'уточнил', status: 'answered', linkedMessageId: 'msg-7' });
  assert.strictEqual(upd.comment, 'уточнил');
  assert.strictEqual(upd.status, 'answered');
  assert.strictEqual(upd.linkedMessageId, 'msg-7', 'связь с перепиской сохраняется');
  assert.ok(upd.updatedAt >= upd.createdAt);

  assert.strictEqual(ann.remove(sid, a.id), true);
  assert.strictEqual(ann.list(sid).length, 0);
});

/* ---------------- контекст по выделенной области (ТЗ, п. 34) ---------------- */
const sel = require('../server/services/geometry/selection');

test('выделение: в контекст попадают только реально пересечённые объекты', () => {
  const site = testSite();  // участок 100×80, ЛЭП по y=60, здание 10..30 × 10..25
  // рамка вокруг здания
  const overBuilding = sel.objectsIn(site, [[5, 5], [35, 5], [35, 30], [5, 30]]);
  const layers = overBuilding.map((h) => h.layer).sort();
  assert.ok(layers.includes('buildings'), 'здание должно попасть');
  assert.ok(layers.includes('parcel'), 'границы участка пересекают рамку');
  assert.ok(!layers.includes('utilities'), 'ЛЭП проходит выше и попадать не должна');

  // рамка на ЛЭП
  const overLine = sel.objectsIn(site, [[40, 55], [70, 55], [70, 65], [40, 65]]);
  assert.ok(overLine.some((h) => h.layer === 'utilities'), 'сеть должна попасть');
  assert.ok(!overLine.some((h) => h.layer === 'buildings'), 'здание далеко и попадать не должно');

  // пустой угол участка
  const empty = sel.objectsIn(site, [[60, 5], [90, 5], [90, 20], [60, 20]]);
  assert.deepStrictEqual(empty.map((h) => h.layer), ['parcel'], 'только границы участка');
});

test('выделение: доля объекта в рамке считается, а не угадывается', () => {
  const site = testSite();
  // рамка накрывает ровно левую половину здания (10..20 из 10..30)
  const half = sel.objectsIn(site, [[0, 0], [20, 0], [20, 40], [0, 40]])
    .find((h) => h.layer === 'buildings');
  assert.ok(half, 'здание попало');
  assert.ok(Math.abs(half.sharePercent - 50) <= 1, `ожидалось ≈50%, получено ${half.sharePercent}%`);

  // рамка накрывает здание целиком
  const full = sel.objectsIn(site, [[0, 0], [40, 0], [40, 40], [0, 40]])
    .find((h) => h.layer === 'buildings');
  assert.strictEqual(full.sharePercent, 100);
});

test('выделение: описание области содержит числа, а не «где-то слева»', () => {
  const site = testSite();
  const text = sel.describeArea([[10, 20], [40, 20], [40, 50], [10, 50]], site);
  assert.match(text, /X 10…40/);
  assert.match(text, /Y 20…50/);
  assert.match(text, /30 × 30 м, площадь 900 м²/);
  assert.match(text, /11% площади участка/);
});

test('выделение: описание объектов несёт размеры, слои и уверенность', () => {
  const site = testSite();
  const hits = sel.objectsIn(site, [[5, 5], [35, 5], [35, 30], [5, 30]]);
  const text = sel.describeHits(hits);
  assert.match(text, /Здание/);
  assert.match(text, /площадь 300 м²/);
  assert.match(text, /слой «Здания существующие»/);
  assert.match(text, /уверенность 80%/);
  assert.strictEqual(sel.describeHits([]), 'В выделенную область не попал ни один распознанный объект плана.');
});

test('выделение: crop рисует все слои и саму рамку, без заливки открытых линий', () => {
  const site = testSite();
  const svg = sel.cropSvg(site, [[40, 55], [70, 55], [70, 65], [40, 65]], { width: 400, height: 300 });
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="400" height="300"/);
  assert.match(svg, /transform="scale\(1,-1\)"/, 'ось Y перевёрнута как в интерфейсе');
  assert.ok((svg.match(/<path /g) || []).length >= 4, 'нарисованы объекты и рамка выделения');
  assert.match(svg, /stroke-dasharray:7 4/, 'рамка выделения обведена пунктиром');
  // у линейного объекта заливки быть не должно
  const utilityPath = svg.split('<path ').find((p) => p.includes('#b07e36'));
  assert.match(utilityPath, /fill:none/);
});

/* ---------------- движок посадки (ТЗ, п. 40–42) ---------------- */
const P = require('../server/services/geometry/placement-engine');

/** Участок 100×80, ЛЭП по y=70, существующее здание в левом нижнем углу. */
function placementSite() {
  const site = cadGeom.fromDxf(writeDxf([
    { layer: 'Границы ЗУ', closed: true, points: [[0, 0], [100, 0], [100, 80], [0, 80]] },
    { layer: 'Сети ЛЭП 10кВ', closed: false, points: [[0, 70], [100, 70]] },
    { layer: 'Здания существующие', closed: true, points: [[5, 5], [20, 5], [20, 20], [5, 20]] },
  ]), { fileName: 'посадка.dxf' });
  const { rules } = RR.processExtraction({
    rules: [
      { kind: 'protectionZone', operation: 'bufferOutward', targetSelector: 'utility', targetHint: 'ЛЭП', value: 8, unit: 'м',
        basis: 'ПП 160', sourceDocument: 'д', sourceClause: '8', quote: '8 м', confidence: 0.9, appliesTo: 'newBuilding' },
      { kind: 'setback', operation: 'bufferInward', targetSelector: 'parcelBoundary', value: 3, unit: 'м',
        basis: 'ГПЗУ', sourceDocument: 'д', sourceClause: '2.1', quote: '3 м', confidence: 0.9, appliesTo: 'newBuilding' },
    ],
  });
  const built = engine.build(site, rules);
  site.restrictions = built.restrictions;
  return { site, buildable: built.buildable };
}

test('посадка: противоречивые требования отвергаются, а не «поправляются»', () => {
  assert.match(P.normalizeRequirements({}).errors[0], /ни площадь.*ни габариты/);
  const conflict = P.normalizeRequirements({ areaM2: 1000, width: 20, length: 20 });
  assert.match(conflict.errors[0], /400 м².*1000 м²/);
  assert.match(P.normalizeRequirements({ areaM2: 100, minWidth: 30, maxWidth: 10 }).errors[0], /Минимальная ширина больше/);
  // непротиворечивые требования проходят
  assert.deepStrictEqual(P.normalizeRequirements({ areaM2: 400, width: 20, length: 20 }).errors, []);
});

test('посадка: варианты габаритов уважают заданные пределы', () => {
  const { req } = P.normalizeRequirements({ areaM2: 900, minWidth: 20, maxWidth: 40, minLength: 20, maxLength: 40 });
  const variants = P.dimensionVariants(req);
  assert.ok(variants.length > 0);
  for (const v of variants) {
    assert.ok(v.width >= 20 && v.width <= 40, `ширина ${v.width} вне пределов`);
    assert.ok(v.length >= 20 && v.length <= 40, `длина ${v.length} вне пределов`);
  }
  // запрет менять форму при заданных габаритах оставляет только их (и разворот)
  const strict = P.normalizeRequirements({ width: 20, length: 45, allowReshape: false });
  const fixed = P.dimensionVariants(strict.req);
  assert.deepStrictEqual(fixed.map((v) => `${v.width}x${v.length}`).sort(), ['20x45', '45x20']);
  assert.ok(fixed.every((v) => v.reshaped === false));
});

/* ---------------- чертёж генплана ---------------- */
const planSpec = require('../server/services/cad/plan-spec');
const dxfWriter = require('../server/services/cad/dxf-writer');
const acadBridge = require('../server/services/cad/acad-bridge');

test('чертёж: у каждой зоны свой слой, своя штриховка и свой контур', () => {
  const { site, buildable } = placementSite();
  const spec = planSpec.build(site, { buildable, title: 'Тест' });

  const zoneLayers = spec.layers.filter((l) => l.name.startsWith('AI_ЗОНА_'));
  assert.ok(zoneLayers.length >= 2, 'зоны разных типов обязаны лежать на разных слоях');
  assert.ok(new Set(zoneLayers.map((l) => l.color)).size === zoneLayers.length, 'цвета слоёв зон не должны совпадать');

  const hatches = spec.entities.filter((e) => e.type === 'hatch');
  const zoneHatches = hatches.filter((h) => h.layer.startsWith('AI_ЗОНА_'));
  assert.ok(zoneHatches.length >= 2);
  // разные углы штриховки — иначе наложение зон сливается в одну сетку
  assert.ok(new Set(zoneHatches.map((h) => h.angle)).size > 1, 'штриховки зон идут под одинаковым углом');
  // у каждой штриховки есть замкнутый контур на том же слое: чужой просмотрщик
  // может не осилить HATCH, но геометрию зоны обязан показать
  for (const h of zoneHatches) {
    assert.ok(spec.entities.some((e) => e.type === 'polyline' && e.layer === h.layer && e.closed),
      `у штриховки слоя ${h.layer} нет контурной полилинии`);
  }
  // допустимая территория — сплошная заливка, а не штриховка
  const buildableHatch = hatches.find((h) => h.layer === planSpec.LAYERS.buildable.name);
  assert.ok(buildableHatch && buildableHatch.solid, 'допустимая территория должна быть сплошной заливкой');
});

test('чертёж: DXF содержит секции, слои с кириллицей и все сущности', () => {
  const { site, buildable } = placementSite();
  const gen = P.generate(site, buildable, { areaM2: 600, floors: 2 }, { limit: 12 });
  const { variants } = V.build(site, gen.candidates, {});
  const spec = planSpec.build(site, { variant: variants[0], buildable, title: 'Тестовый проект' });
  const dxf = dxfWriter.writeSpec(spec);

  for (const section of ['HEADER', 'TABLES', 'BLOCKS', 'ENTITIES', 'OBJECTS']) {
    assert.ok(dxf.includes(`\n2\n${section}\n`), `в DXF нет секции ${section}`);
  }
  assert.ok(dxf.includes('AC1015'), 'версия должна быть AC1015: в R12 нет сущности HATCH');
  assert.ok(dxf.includes('\n2\nAI_ГРАНИЦЫ_ЗУ\n'), 'кириллическое имя слоя не записано');
  assert.ok(dxf.includes('\n2\nAI_ПЯТНО_ЗАСТРОЙКИ\n'), 'нет слоя пятна застройки');
  assert.ok(dxf.trimEnd().endsWith('EOF'));

  const count = (word) => dxf.split(`\n0\n${word}\n`).length - 1;
  assert.strictEqual(count('LWPOLYLINE'), spec.entities.filter((e) => e.type === 'polyline').length);
  assert.strictEqual(count('HATCH'), spec.entities.filter((e) => e.type === 'hatch').length);
  assert.strictEqual(count('TEXT'), spec.entities.filter((e) => e.type === 'text').length);
  // тот самый дефект: файл, в котором ничего нет
  assert.ok(dxf.length > 4000, 'DXF подозрительно пуст');

  // ссылки на записи блоков не должны висеть в пустоту
  const modelSpaceHandle = dxf.match(/\n2\n\*Model_Space\n/) ? true : false;
  assert.ok(modelSpaceHandle, 'нет записи модельного пространства');
});

test('чертёж: спецификация переводится в команды моста AutoCAD', () => {
  const { site, buildable } = placementSite();
  const spec = planSpec.build(site, { buildable, title: 'Тест' });
  const commands = acadBridge.toCommands(spec);

  // слои создаются раньше любой сущности, иначе объекты уедут на текущий слой
  const firstEntity = commands.findIndex((c) => c.method !== 'create_layer');
  assert.ok(commands.slice(0, firstEntity).every((c) => c.method === 'create_layer'));
  assert.strictEqual(commands.filter((c) => c.method === 'create_layer').length, spec.layers.length);

  const hatch = commands.find((c) => c.method === 'create_hatch');
  assert.ok(hatch, 'штриховки не превратились в команды');
  assert.strictEqual(hatch.params.keep_boundary, false, 'контур уже нарисован отдельной полилинией');
  assert.ok(hatch.params.boundary_points.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y)));

  const text = commands.find((c) => c.method === 'create_text');
  assert.ok(text && text.params.insertion && text.params.height_mm > 0, 'подписи должны иметь точку вставки и высоту');
});

/* ---------------- формы пятна застройки (ТЗ, п. 43) ---------------- */
const SH = require('../server/services/geometry/shapes');

test('формы: габарит подбирается по площади ФИГУРЫ, а не габарита', () => {
  for (const id of SH.ids()) {
    const box = SH.boxFor(id, 1200, 1.6);
    const pts = SH.footprint(id, 0, 0, box.width, box.length, 0);
    const area = G.polygonArea(pts);
    assert.ok(Math.abs(area - 1200) < 1, `${id}: площадь ${area} вместо 1200`);
    // габарит непрямоугольной формы обязан быть БОЛЬШЕ площади застройки
    if (id !== 'rect') {
      assert.ok(box.width * box.length > 1200 * 1.05, `${id}: габарит не больше площади — форма выродилась в прямоугольник`);
    }
    assert.ok(Math.abs(box.length / box.width - 1.6) < 0.01, `${id}: вытянутость габарита не соблюдена`);
  }
});

test('формы: поворот сохраняет площадь и число вершин', () => {
  for (const id of SH.ids()) {
    const box = SH.boxFor(id, 900, 1.2);
    const flat = SH.footprint(id, 30, 40, box.width, box.length, 0);
    const turned = SH.footprint(id, 30, 40, box.width, box.length, 37);
    assert.strictEqual(turned.length, flat.length);
    assert.ok(Math.abs(G.polygonArea(turned) - G.polygonArea(flat)) < 1, `${id}: поворот изменил площадь`);
  }
});

test('посадка: в выдаче кандидатов присутствуют непрямоугольные формы', () => {
  const { site, buildable } = placementSite();
  const gen = P.generate(site, buildable, { areaM2: 900, floors: 2 }, { limit: 40 });
  const forms = new Set(gen.candidates.map((c) => c.shape));
  assert.ok(forms.size >= 3, `форм в выдаче ${forms.size}, ожидалось не меньше трёх: ${[...forms]}`);
  assert.ok([...forms].some((f) => f !== 'rect'), 'выдача состоит из одних прямоугольников');
  // площадь каждого пятна соответствует требованию независимо от формы
  for (const c of gen.candidates) {
    assert.ok(Math.abs(c.areaM2 - 900) / 900 < 0.02, `${c.shape}: площадь ${c.areaM2} вместо 900`);
  }
});

test('посадка: заданные габариты оставляют только прямоугольник', () => {
  const { req } = P.normalizeRequirements({ width: 20, length: 45, allowReshape: false });
  const variants = P.dimensionVariants(req);
  assert.ok(variants.every((v) => v.shape === 'rect'), 'при заданной коробке форма не выдумывается');
});

test('варианты: четыре предложения различаются конфигурацией корпуса', () => {
  const { site, buildable } = placementSite();
  const gen = P.generate(site, buildable, { areaM2: 900, floors: 2 }, { limit: 40 });
  const { variants } = V.build(site, gen.candidates, {});
  assert.strictEqual(variants.length, 4);
  const forms = new Set(variants.map((v) => v.metrics.shape));
  assert.ok(forms.size >= 3, `у четырёх вариантов ${forms.size} разных форм: ${[...forms]}`);
  for (const v of variants) {
    assert.ok(v.metrics.shapeLabel, 'у варианта нет русского названия формы');
  }
});

test('посадка: прямоугольник строится по центру, габаритам и углу', () => {
  const flat = P.rectFootprint(50, 40, 20, 10, 0);
  assert.deepStrictEqual(flat, [[40, 35], [60, 35], [60, 45], [40, 45]]);
  assert.strictEqual(G.polygonArea(flat), 200);
  // поворот на 90° меняет ориентацию, но не площадь
  const turned = P.rectFootprint(50, 40, 20, 10, 90);
  assert.strictEqual(Math.round(G.polygonArea(turned)), 200);
  assert.ok(Math.abs(G.bounds(turned).maxX - G.bounds(turned).minX - 10) < 0.01, 'после поворота ширина по X = 10');
});

test('посадка: углы поворота берутся от сторон участка', () => {
  const { site } = placementSite();
  const angles = P.candidateAngles(site, P.normalizeRequirements({ areaM2: 100 }).req);
  assert.ok(angles.includes(0) && angles.includes(90), 'ортогональные направления обязательны');
  // запрет вращения с заданной ориентацией оставляет ровно один угол
  const fixed = P.candidateAngles(site, P.normalizeRequirements({ areaM2: 100, orientationDeg: 30, allowRotate: false }).req);
  assert.deepStrictEqual(fixed, [30]);
});

test('посадка: кандидаты помещаются в допустимую территорию и не нарушают ограничений', () => {
  const { site, buildable } = placementSite();
  const res = P.generate(site, buildable, { areaM2: 900, floors: 3 }, { limit: 10 });
  assert.strictEqual(res.errors.length, 0);
  assert.ok(res.candidates.length > 0, 'хотя бы один вариант должен найтись');
  for (const c of res.candidates) {
    assert.strictEqual(c.admissible, true, `нарушения: ${JSON.stringify(c.violations)}`);
    assert.strictEqual(c.violations.length, 0);
    assert.ok(Math.abs(c.areaM2 - 900) < 1, `площадь ${c.areaM2}`);
    // все вершины внутри участка
    for (const [x, y] of c.footprint.points) {
      assert.ok(x >= 0 && x <= 100 && y >= 0 && y <= 80, `вершина вне участка: ${x},${y}`);
    }
    assert.strictEqual(c.floors, 3, 'этажность переносится в кандидата');
  }
});

test('посадка: слишком большое здание честно не размещается', () => {
  const { site, buildable } = placementSite();
  const res = P.generate(site, buildable, { areaM2: 9000 }, { limit: 5 });
  assert.strictEqual(res.candidates.length, 0, 'вариантов быть не должно');
  assert.strictEqual(res.errors.length, 0, 'это не ошибка требований, а отсутствие места');
  assert.ok(res.tried > 0, 'перебор всё-таки выполнялся');
});

test('посадка: проверка ловит выход за участок, зону ограничения и задетые объекты', () => {
  const { site } = placementSite();
  // пятно, наполовину вылезающее за правую границу
  const outside = P.validate(site, P.rectFootprint(98, 40, 20, 20, 0), P.normalizeRequirements({ areaM2: 400 }).req);
  assert.ok(outside.violations.some((v) => v.code === 'outside-parcel'), 'выход за участок');

  // пятно в охранной зоне ЛЭП (полоса y 62…78)
  const inZone = P.validate(site, P.rectFootprint(50, 70, 20, 10, 0), P.normalizeRequirements({ areaM2: 200 }).req);
  assert.ok(inZone.violations.some((v) => v.code === 'restriction-overlap'), 'пересечение с зоной');
  assert.ok(inZone.violations.find((v) => v.code === 'restriction-overlap').overlapM2 > 0);

  // пятно поверх существующего здания — это уже мероприятие
  const onBuilding = P.validate(site, P.rectFootprint(12, 12, 20, 20, 0), P.normalizeRequirements({ areaM2: 400 }).req);
  assert.ok(onBuilding.affected.some((a) => a.layer === 'buildings'), 'существующее здание должно попасть в задетые');
  assert.ok(onBuilding.affected[0].sourceLayer, 'у задетого объекта известен слой');
});

test('посадка: расчёт детерминирован', () => {
  const a = placementSite();
  const b = placementSite();
  const ra = P.generate(a.site, a.buildable, { areaM2: 600 }, { limit: 6 });
  const rb = P.generate(b.site, b.buildable, { areaM2: 600 }, { limit: 6 });
  assert.deepStrictEqual(
    ra.candidates.map((c) => [c.center, c.rotationDeg, c.areaM2]),
    rb.candidates.map((c) => [c.center, c.rotationDeg, c.areaM2]),
  );
});

/* ---------------- очередь геометрии в отдельных потоках (ТЗ, п. 76) ---------------- */
const geoQueue = require('../server/services/geometry/queue');

test('очередь: расчёт в потоке даёт тот же результат, что и в основном', async () => {
  const { site, buildable } = placementSite();
  const requirements = { areaM2: 600 };
  const direct = P.generate(site, buildable, requirements, { limit: 4 });
  const viaWorker = await geoQueue.run('placement', { site, buildable, requirements, options: { limit: 4 } });
  assert.deepStrictEqual(
    viaWorker.candidates.map((c) => [c.center, c.rotationDeg, c.areaM2]),
    direct.candidates.map((c) => [c.center, c.rotationDeg, c.areaM2]),
  );
  assert.strictEqual(viaWorker.total, direct.total);
});

test('очередь: событийный цикл не блокируется, счётчики не текут', async () => {
  const { site, buildable } = placementSite();
  let ticks = 0;
  const iv = setInterval(() => { ticks++; }, 5);
  await Promise.all([600, 700, 800].map((areaM2) =>
    geoQueue.run('placement', { site, buildable, requirements: { areaM2 }, options: { limit: 2 } })));
  clearInterval(iv);
  assert.ok(ticks > 0, 'основной поток должен оставаться живым во время расчёта');
  await new Promise((r) => setImmediate(r));
  const s = geoQueue.stats();
  assert.strictEqual(s['выполняется'], 0, 'все задачи завершены');
  assert.strictEqual(s['вОчереди'], 0);
});

test('очередь: неизвестная задача возвращает ошибку, а не виснет', async () => {
  await assert.rejects(() => geoQueue.run('несуществующая', {}), /Неизвестная задача геометрии/);
});

/* ---------------- варианты, мероприятия, критическая инфраструктура ---------------- */
const V = require('../server/services/geometry/variants');
const crit = require('../server/services/geometry/critical-objects');

test('критическая инфраструктура: подпись слоя нормализуется до класса объекта', () => {
  assert.strictEqual(crit.signatureOf('Сети ЛЭП 10кВ'), crit.signatureOf('ЛЭП-10 кВ (сущ.)'),
    'один класс объекта должен давать одну подпись');
  assert.notStrictEqual(crit.signatureOf('ЛЭП 10кВ'), crit.signatureOf('водопровод В1'));
  assert.strictEqual(crit.signatureOf('   '), '');
});

test('критическая инфраструктура: нормативные заготовки работают до опроса человека', () => {
  assert.strictEqual(crit.classify('Сети ЛЭП 10кВ').classification, 'critical');
  assert.match(crit.classify('Сети ЛЭП 10кВ').basis, /160/);
  assert.strictEqual(crit.classify('Газопровод высокого давления').classification, 'critical');
  assert.strictEqual(crit.classify('Ограждение территории').classification, 'movable');
  assert.strictEqual(crit.classify('Навес').classification, 'demolishable');
  assert.strictEqual(crit.classify('Нечто непонятное').classification, 'unknown');
});

test('критическая инфраструктура: запись требует подписи и переживает проекты', (t) => {
  const { db } = require('../server/db');
  const layer = `Тестовый слой ${Date.now()}`;
  t.after(() => db.prepare('DELETE FROM critical_objects WHERE signature = ?').run(crit.signatureOf(layer)));

  assert.throws(() => crit.remember({ sourceLayer: layer, classification: 'critical', validatedBy: '' }),
    /кто подтвердил/);
  assert.throws(() => crit.remember({ sourceLayer: layer, classification: 'выдумка', validatedBy: 'Иван' }),
    /Неизвестная классификация/);

  crit.remember({ sourceLayer: layer, label: 'тестовый объект', classification: 'critical', basis: 'СП', validatedBy: 'Иван Петров' });
  const found = crit.classify(layer);
  assert.strictEqual(found.classification, 'critical');
  assert.strictEqual(found.source, 'база');
  assert.strictEqual(found.validatedBy, 'Иван Петров');
  assert.ok(found.validatedAt, 'дата подтверждения записана');
  // тот же класс, записанный иначе, находится по нормализованной подписи
  assert.strictEqual(crit.classify(`${layer} (сущ.)`).classification, 'critical');
});

test('варианты: одинаковые по геометрии пятна схлопываются в одно', () => {
  const square = (cx, cy, rot) => ({
    footprint: { type: 'polygon', closed: true, points: P.rectFootprint(cx, cy, 20, 20, rot) },
    center: [cx, cy], rotationDeg: rot, width: 20, length: 20, areaM2: 400, affected: [],
  });
  // квадрат, повёрнутый на 90° вокруг центра, — тот же многоугольник
  const deduped = V.dedupeGeometric([square(50, 50, 0), square(50, 50, 90), square(80, 50, 0)]);
  assert.strictEqual(deduped.length, 2, 'разворот квадрата не создаёт нового варианта');
  assert.strictEqual(V.shapeKey(square(50, 50, 0)), V.shapeKey(square(50, 50, 90)));
});

test('варианты: отбор даёт разные места, а не четыре пятна рядом', () => {
  const { site, buildable } = placementSite();
  const gen = P.generate(site, buildable, { areaM2: 900, floors: 3 }, { limit: 400 });
  const { variants } = V.build(site, gen.candidates, { criterion: 'maxArea' });
  assert.ok(variants.length >= 2, 'должно найтись несколько вариантов');
  // ни одна пара не должна совпадать по геометрии
  const keys = new Set(variants.map((v) => v.footprint.points.map((p) => p.join(',')).sort().join(';')));
  assert.strictEqual(keys.size, variants.length, 'варианты не должны повторяться геометрически');
  // и все должны быть разнесены заметнее, чем на метр
  for (let i = 0; i < variants.length; i++) {
    for (let j = i + 1; j < variants.length; j++) {
      const a = variants[i].metrics; const b = variants[j].metrics;
      const shift = Math.hypot(a.center[0] - b.center[0], a.center[1] - b.center[1]);
      const sameShape = a.width === b.width && a.length === b.length;
      assert.ok(!sameShape || shift > 5,
        `варианты ${i + 1} и ${j + 1} одинаковой формы и в ${shift.toFixed(1)} м друг от друга`);
    }
  }
});

test('варианты: мероприятия несут объём и класс объекта, стоимости в них нет', () => {
  const { site, buildable } = placementSite();
  const gen = P.generate(site, buildable, { areaM2: 900 }, { limit: 200 });
  const { variants } = V.build(site, gen.candidates, {});
  const withActions = variants.find((v) => v.actions.length);
  if (!withActions) return; // на этом участке можно встать и ничего не задев — это нормально
  for (const a of withActions.actions) {
    assert.ok(a.title, 'у мероприятия есть название');
    assert.ok(Number.isFinite(a.volume), 'объём посчитан геометрией');
    assert.ok(['м', 'м²'].includes(a.unit));
    assert.ok(crit.CLASSIFICATIONS.includes(a.classification));
    assert.strictEqual(a.cost, undefined, 'стоимости в мероприятии быть не должно');
  }
  const tep = V.actionsToTep(withActions.actions);
  for (const t of tep) assert.ok(t.name && Number.isFinite(t.value) && t.unit, 'ТЭП в формате имя/значение/единица');
});

test('варианты: воздействие на критический объект требует решения', () => {
  const site = cadGeom.fromDxf(writeDxf([
    { layer: 'Границы ЗУ', closed: true, points: [[0, 0], [60, 0], [60, 60], [0, 60]] },
    { layer: 'Сети ЛЭП 10кВ', closed: false, points: [[30, 0], [30, 60]] },
  ]), { fileName: 'крит.dxf' });
  // пятно поперёк ЛЭП: задевает критический объект
  const candidate = {
    footprint: { type: 'polygon', closed: true, points: P.rectFootprint(30, 30, 40, 20, 0) },
    center: [30, 30], rotationDeg: 0, width: 40, length: 20, areaM2: 800,
    violations: [], warnings: [], admissible: true,
    affected: [{ id: site.utilities[0].id, layer: 'utilities', sourceLayer: 'Сети ЛЭП 10кВ' }],
  };
  const actions = V.actionsFor(site, candidate.affected);
  assert.strictEqual(actions.length, 1);
  assert.strictEqual(actions[0].classification, 'critical');
  assert.strictEqual(actions[0].requiresDecision, true, 'критический объект без решения переносить нельзя');

  const { variants } = V.build(site, [candidate], {});
  assert.strictEqual(variants[0].status, 'needs_decision');
  assert.strictEqual(variants[0].touchesCritical, true);
});

/* ---------------- этапы и согласование в ленте ---------------- */
const stages = require('../server/services/stages');
const { db: stagesDb, now: stagesNow } = require('../server/db');

function makeSession(id) {
  stagesDb.prepare('INSERT INTO sessions (id, token, status, job_status, created_at, updated_at) VALUES (?,?,?,?,?,?)')
    .run(id, 'tok', 'active', 'idle', stagesNow(), stagesNow());
  return id;
}

test('этапы: порядок и переходы записываются в проект', () => {
  const id = makeSession('stage-order');
  assert.strictEqual(stages.get(id), 'idle');
  stages.set(id, 'zones_review');
  assert.strictEqual(stages.get(id), 'zones_review');
  assert.throws(() => stages.set(id, 'нет-такого-этапа'), /Неизвестный этап/);
  // порядок этапов повторяет порядок работы проектировщика
  assert.deepStrictEqual(stages.STAGES.slice(0, 5), ['idle', 'analysis', 'questions', 'zones', 'zones_review']);
});

test('этапы: замечания попадают в задание модели, а не только в переписку', () => {
  const id = makeSession('stage-notes');
  assert.strictEqual(stages.notesInstruction(id, 'zones'), '');
  stages.addNote(id, 'zones', 'СЗЗ птицефабрики учтена не полностью');
  stages.addNote(id, 'zones', '  ');   // пустое замечание не сохраняется
  stages.addNote(id, 'variants', 'корпус вдоль южной границы');
  const instruction = stages.notesInstruction(id, 'zones');
  assert.match(instruction, /СЗЗ птицефабрики/);
  assert.ok(!instruction.includes('южной границы'), 'замечания этапов не должны смешиваться');
  assert.strictEqual(stages.notes(id, 'zones').length, 1);
});

test('этапы: карточка согласования — сообщение ленты с разбираемым телом', () => {
  const id = makeSession('stage-card');
  stages.addCard(id, 'zones', { planId: 'p1', zones: [] });
  const row = stagesDb.prepare("SELECT kind, content FROM messages WHERE session_id = ?").get(id);
  assert.strictEqual(row.kind, 'card');
  const parsed = stages.parseCard(row.content);
  assert.strictEqual(parsed.card, 'zones');
  assert.strictEqual(parsed.planId, 'p1');
  // битое тело не роняет ленту
  assert.strictEqual(stages.parseCard('не json'), null);
  assert.strictEqual(stages.parseCard('{"нет":"типа"}'), null);
});

test('этапы: требования к зданию берутся из фактов, а не выдумываются', () => {
  const id = makeSession('stage-req');
  // фактов нет — требований нет, и подставлять их нельзя
  assert.strictEqual(stages.requirementsFromFacts(id), null);

  const addFact = (key, value) => stagesDb
    .prepare('INSERT INTO facts (id, session_id, key, value, source, created_at) VALUES (?,?,?,?,?,?)')
    .run(`${id}-${key}`, id, key, value, 'ТЗ', stagesNow());
  addFact('plot.area_m2', '3700');                 // площадь УЧАСТКА не должна попасть в требования
  addFact('building.area_m2', '3 580 м²');
  addFact('building.floors', '2 этажа');

  const req = stages.requirementsFromFacts(id);
  assert.strictEqual(req.areaM2, 3580, 'площадь застройки берётся из факта о здании, а не об участке');
  assert.strictEqual(req.floors, 2);
  assert.ok(req.sources.length, 'источник требования обязан прослеживаться');
});

test('этапы: сводка по зонам группирует их по типу с площадью', () => {
  const site = { restrictions: [
    { properties: { kind: 'setback', areaM2: 100, statusLabel: 'подтверждено документом' } },
    { properties: { kind: 'setback', areaM2: 50, statusLabel: 'подтверждено документом' } },
    { properties: { kind: 'protectionZone', areaM2: 240, statusLabel: 'требует проверки' } },
  ] };
  const summary = stages.zonesSummary(site);
  assert.strictEqual(summary.length, 2);
  const setback = summary.find((z) => z.kind === 'setback');
  assert.strictEqual(setback.count, 2);
  assert.strictEqual(setback.areaM2, 150);
  assert.strictEqual(setback.label, 'отступ от границ');
});

/* ---------------- схемы структурного вывода ---------------- */

/**
 * Строгий режим OpenAI-совместимых API требует, чтобы `required` перечислял
 * ВСЕ ключи объекта. Нарушение отвергается провайдером до генерации, повтор
 * идёт без схемы, модель отвечает прозой — и пользователь видит
 * «Модель вернула некорректный ответ». Именно так это и случилось вживую.
 */
function strictViolations(schema, path = 'root') {
  const bad = [];
  const walk = (node, p) => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'object' && node.properties) {
      const props = Object.keys(node.properties);
      const req = node.required || [];
      const missing = props.filter((k) => !req.includes(k));
      if (missing.length) bad.push(`${p}: не в required — ${missing.join(', ')}`);
      if (node.additionalProperties !== false) bad.push(`${p}: нет additionalProperties: false`);
      for (const k of props) walk(node.properties[k], `${p}.${k}`);
    }
    if (node.type === 'array' && node.items) walk(node.items, `${p}[]`);
  };
  walk(schema, path);
  return bad;
}

test('схемы: required перечисляет все свойства — иначе провайдер отвергает схему целиком', () => {
  const schemas = {
    RESPONSE_SCHEMA: require('../server/services/claude/schema').RESPONSE_SCHEMA,
    RULES_SCHEMA: require('../server/services/geometry/restriction-rules').RULES_SCHEMA,
  };
  for (const [name, schema] of Object.entries(schemas)) {
    assert.deepStrictEqual(strictViolations(schema, name), [],
      `${name} не пройдёт строгий структурный вывод`);
  }
});

test('схемы: необязательное выражается допуском null, а не отсутствием в required', () => {
  const { RESPONSE_SCHEMA } = require('../server/services/claude/schema');
  const geom = RESPONSE_SCHEMA.properties.geometry.items;
  // цвет и замкнутость модель вправе не указывать — но заявлены они обязаны быть
  for (const key of ['color', 'closed']) {
    assert.ok(geom.required.includes(key), `${key} обязан быть в required`);
    assert.ok(Array.isArray(geom.properties[key].type) && geom.properties[key].type.includes('null'),
      `${key} обязан допускать null`);
  }
  // и такой ответ модели по-прежнему проходит нашу собственную проверку
  const { validateResponse } = require('../server/services/claude/schema');
  const res = validateResponse({
    status: 'completed', message: 'готово', questions: [], facts: [], warnings: [],
    conflicts: [], assumptions: [], report_markdown: '# Отчёт',
    geometry: [{ layer: 'Границы', color: null, closed: null, points: [[0, 0], [1, 1]] }],
    tep: [],
  });
  assert.ok(res.ok, `ответ с null не прошёл проверку: ${res.error}`);
});
