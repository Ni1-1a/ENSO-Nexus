'use strict';
/* Модуль «Датасет»: переходы статусов, дедупликация, запреты API, экспорт.
 * Живой сервер на эфемерном порту — по образцу tests/api.test.js.
 * Вызов модели подменён (_setCallFn): живой LM Studio тестам не нужна. */
const os = require('os');
const path = require('path');
const fs = require('fs');
process.env.DATA_DIR = path.join(os.tmpdir(), `pilot1-dataset-${process.pid}`);
process.env.ANTHROPIC_API_KEY = '';
process.env.USERS_FILE = path.join(os.tmpdir(), `pilot1-dataset-users-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
process.env.RATE_LIMIT_GENERAL = '1000';
process.env.RATE_LIMIT_EXPENSIVE = '1000';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { createApp } = require('../server/app');
const generate = require('../server/services/dataset/generate');

let server, base;

before(async () => {
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server.close();
  fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
  fs.rmSync(process.env.USERS_FILE, { force: true });
});

const api = async (p, opts = {}) => {
  const res = await fetch(base + p, opts);
  let body = null;
  try { body = await res.clone().json(); } catch { body = await res.text(); }
  return { status: res.status, body, res };
};

let userToken = '';
async function login(lastName = 'Валидаторов', firstName = 'Тест') {
  const { body } = await api('/api/auth/enter', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lastName, firstName }),
  });
  return body.token || '';
}
const asUser = (token = userToken) => ({ 'X-User-Token': token });
const json = (obj, token = userToken) => ({
  headers: { 'Content-Type': 'application/json', ...asUser(token) },
  body: JSON.stringify(obj),
});

/** Загрузка текстового файла в датасет и ожидание конца обработки. */
async function uploadText(name, content) {
  const form = new FormData();
  form.append('file', new File([content], name, { type: 'text/plain' }));
  const up = await api('/api/dataset/documents', { method: 'POST', headers: asUser(), body: form });
  if (up.status !== 201 && !(up.body && up.body.duplicate)) return up;
  const id = up.body.document.id;
  for (let i = 0; i < 200; i++) {
    const { body } = await api(`/api/dataset/documents/${id}`, { headers: asUser() });
    if (['ready', 'failed'].includes(body.document.processing_status)) return { ...up, doc: body.document };
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('документ не обработался за отведённое время');
}

/* Мелкие абзацы «гибридная» нарезка склеивает в один элемент, поэтому для
 * проверки дедупа абзац должен один занимать больше половины потолка. */
const PARA = (n) => `Пункт ${n}: расстояние между зданиями принимается не менее двенадцати метров по СП 4.13130 для соответствующей степени огнестойкости.`;
/* Абзац почти в потолок элемента (8000 симв.): гибридная склейка тогда не
 * дотягивается до соседнего абзаца, и общий фрагмент двух документов даёт
 * байт в байт одинаковый элемент — на этом стоит проверка дедупа. */
const BIG = (tag) => {
  let s = `Раздел ${tag}. `;
  while (s.length < 7400) s += `Требование раздела ${tag}: противопожарные расстояния между зданиями I и II степени огнестойкости принимаются по таблице 1 СП 4.13130 с учётом класса конструктивной пожарной опасности. `;
  return s.trim();
};
const TABLE = '| Степень огнестойкости | Расстояние, м | Примечание |\n| I, II | 6 | без проёмов |\n| III | 8 | обычное исполнение |';

const okDraft = ({ messages }) => ({
  text: JSON.stringify({
    question: 'Какое минимальное расстояние требует этот фрагмент?',
    answer: 'Фрагмент требует принимать расстояние по СП 4.13130 — не менее приведённого в нём значения.',
  }),
});
const downModel = () => { throw new Error('модель недоступна (тест)'); };

test('датасет: без входа доступа нет', async () => {
  const r = await api('/api/dataset/documents');
  assert.strictEqual(r.status, 401);
});

test('датасет: загрузка → элементы → черновики текстовым, таблицам — нет', async () => {
  userToken = await login();
  generate._setCallFn(okDraft);
  const first = await uploadText('норматив.txt', `${PARA('5.3.1')}\n\n${PARA('5.3.2')}\n\n${TABLE}\n\n${PARA('5.3.3')}`);
  assert.strictEqual(first.status, 201);
  assert.strictEqual(first.doc.processing_status, 'ready', first.doc.error_text);
  const docId = first.doc.id;

  const els = (await api(`/api/dataset/documents/${docId}/elements`, { headers: asUser() })).body.elements;
  const tables = els.filter((e) => e.kind === 'table');
  const texts = els.filter((e) => e.kind === 'text');
  assert.strictEqual(tables.length, 1, 'таблица должна стать отдельным элементом');
  assert.ok(texts.length >= 1);
  // черновики: у КАЖДОГО текстового есть, у таблицы — нет
  for (const t of texts) assert.ok(t.pairs >= 1, 'текстовый элемент остался без черновика');
  assert.strictEqual(tables[0].pairs, 0, 'таблица не должна уходить в автогенерацию');
  const draft = (await api(`/api/dataset/elements/${texts[0].element_id}`, { headers: asUser() })).body.pairs[0];
  assert.strictEqual(draft.status, 'draft');
  assert.strictEqual(draft.origin, 'auto');
  assert.ok(draft.prompt_version, 'черновик без версии промпта');

  // повторная загрузка того же файла — тот же документ, без дублей
  const again = await uploadText('норматив.txt', `${PARA('5.3.1')}\n\n${PARA('5.3.2')}\n\n${TABLE}\n\n${PARA('5.3.3')}`);
  assert.strictEqual(again.body.duplicate, true);
  assert.strictEqual(again.body.document.id, docId);
  const els2 = (await api(`/api/dataset/documents/${docId}/elements`, { headers: asUser() })).body.elements;
  assert.strictEqual(els2.length, els.length);
  assert.strictEqual(els2.reduce((s, e) => s + e.pairs, 0), els.reduce((s, e) => s + e.pairs, 0));
});

test('датасет: упавшая генерация оставляет элемент «без пары», пара создаётся вручную', async () => {
  generate._setCallFn(downModel);
  const a = await uploadText('док-а.txt', `${BIG('ОБЩИЙ')}\n\n${BIG('А1')}`);
  assert.strictEqual(a.doc.processing_status, 'ready', a.doc.error_text);
  const elsA = (await api(`/api/dataset/documents/${a.doc.id}/elements`, { headers: asUser() })).body.elements;
  assert.strictEqual(elsA.length, 2);
  for (const e of elsA) assert.strictEqual(e.state, 'no_pairs', 'после падения генерации элемент обязан остаться без пары');

  const shared = elsA.find((e) => e.preview.includes('ОБЩИЙ'));
  const pair = (await api(`/api/dataset/elements/${shared.element_id}/pairs`, {
    method: 'POST', ...json({ question: 'По какой таблице принимаются расстояния?', answer: 'По таблице 1 СП 4.13130.' }),
  })).body.pair;
  assert.strictEqual(pair.status, 'pending');

  // тот же фрагмент в другом документе переиспользует элемент и его пары
  await api(`/api/dataset/pairs/${pair.id}/validate`, { method: 'POST', ...json({}) });
  const b = await uploadText('док-б.txt', `${BIG('ОБЩИЙ')}\n\n${BIG('Б1')}`);
  const elsB = (await api(`/api/dataset/documents/${b.doc.id}/elements`, { headers: asUser() })).body.elements;
  const sharedB = elsB.find((e) => e.preview.includes('ОБЩИЙ'));
  assert.ok(sharedB, 'общий элемент не найден во втором документе');
  assert.strictEqual(sharedB.element_id, shared.element_id, 'общий фрагмент обязан переиспользовать элемент');
  assert.strictEqual(sharedB.state, 'done', 'валидированная пара обязана пережить повторную загрузку');
  const pairs = (await api(`/api/dataset/elements/${shared.element_id}`, { headers: asUser() })).body.pairs;
  assert.strictEqual(pairs.length, 1);
  assert.strictEqual(pairs[0].status, 'validated');
});

test('датасет: две ручные пары к одному элементу живут рядом', async () => {
  generate._setCallFn(downModel);
  const doc = (await uploadText('двойной.txt', BIG('ДВА'))).doc;
  const el = (await api(`/api/dataset/documents/${doc.id}/elements`, { headers: asUser() })).body.elements[0];
  for (const q of ['Первый вопрос по разделу?', 'Второй вопрос по разделу?']) {
    await api(`/api/dataset/elements/${el.element_id}/pairs`, {
      method: 'POST', ...json({ question: q, answer: 'Расстояния принимаются по таблице 1 СП 4.13130.' }),
    });
  }
  const pairs = (await api(`/api/dataset/elements/${el.element_id}`, { headers: asUser() })).body.pairs;
  assert.strictEqual(pairs.length, 2);
  for (const p of pairs) await api(`/api/dataset/pairs/${p.id}/validate`, { method: 'POST', ...json({}) });
  const hist = await api(`/api/dataset/pairs?document=${doc.id}`, { headers: asUser() });
  assert.strictEqual(hist.body.items.length, 2);
  for (const item of hist.body.items) assert.strictEqual(item.status, 'validated');
});

test('датасет: переходы статусов и очистка ФИО при правке', async () => {
  generate._setCallFn(downModel);
  const doc = (await uploadText('переходы.txt', BIG('ПЕРЕХОДЫ'))).doc;
  const el = (await api(`/api/dataset/documents/${doc.id}/elements`, { headers: asUser() })).body.elements[0];

  const created = (await api(`/api/dataset/elements/${el.element_id}/pairs`, {
    method: 'POST', ...json({ question: 'Что нормируется?', answer: 'Противопожарное расстояние.' }),
  })).body.pair;
  assert.strictEqual(created.status, 'pending');
  assert.strictEqual(created.validated_by_name, '');

  const validated = (await api(`/api/dataset/pairs/${created.id}/validate`, { method: 'POST', ...json({}) })).body.pair;
  assert.strictEqual(validated.status, 'validated');
  assert.strictEqual(validated.validated_by_name, 'Валидаторов Тест');
  assert.ok(validated.validated_at);

  // правка валидированной пары сбрасывает статус и чистит ФИО с датой
  const edited = (await api(`/api/dataset/pairs/${created.id}`, {
    method: 'PATCH', ...json({ question: 'Что именно нормируется?', answer: 'Противопожарное расстояние между зданиями.', expectedUpdatedAt: validated.updated_at }),
  })).body.pair;
  assert.strictEqual(edited.status, 'pending');
  assert.strictEqual(edited.validated_by_name, '');
  assert.strictEqual(edited.validated_at, '');

  const rejected = (await api(`/api/dataset/pairs/${created.id}/reject`, { method: 'POST', ...json({ expectedUpdatedAt: edited.updated_at }) })).body.pair;
  assert.strictEqual(rejected.status, 'rejected');
  // отклонённую нельзя подтвердить без правки
  const cantValidate = await api(`/api/dataset/pairs/${created.id}/validate`, { method: 'POST', ...json({}) });
  assert.strictEqual(cantValidate.status, 400);
  const revived = (await api(`/api/dataset/pairs/${created.id}`, {
    method: 'PATCH', ...json({ question: 'Что нормируется этим пунктом?', answer: 'Расстояние между зданиями.', expectedUpdatedAt: rejected.updated_at }),
  })).body.pair;
  assert.strictEqual(revived.status, 'pending');

  // optimistic lock: правка со старым отпечатком отклоняется с 409 и называет автора
  const conflict = await api(`/api/dataset/pairs/${created.id}`, {
    method: 'PATCH', ...json({ question: 'Устаревшая правка?', answer: 'Не пройдёт.', expectedUpdatedAt: validated.updated_at }),
  });
  assert.strictEqual(conflict.status, 409);
  assert.ok(conflict.body.updatedAt);
});

test('датасет: validated и чужое ФИО через API не проходят', async () => {
  generate._setCallFn(downModel);
  const doc = (await uploadText('запреты.txt', BIG('ЗАПРЕТЫ'))).doc;
  const el = (await api(`/api/dataset/documents/${doc.id}/elements`, { headers: asUser() })).body.elements[0];

  const sneaky = (await api(`/api/dataset/elements/${el.element_id}/pairs`, {
    method: 'POST', ...json({
      question: 'Хитрый вопрос?', answer: 'Хитрый ответ.',
      status: 'validated', validated_by_name: 'Чужой Человек', validated_at: '2020-01-01',
    }),
  })).body.pair;
  assert.strictEqual(sneaky.status, 'pending');
  assert.strictEqual(sneaky.validated_by_name, '');

  const patched = (await api(`/api/dataset/pairs/${sneaky.id}`, {
    method: 'PATCH', ...json({
      question: 'Хитрый вопрос номер два?', answer: 'Хитрый ответ.',
      status: 'validated', validated_by_name: 'Чужой Человек', expectedUpdatedAt: sneaky.updated_at,
    }),
  })).body.pair;
  assert.strictEqual(patched.status, 'pending');
  assert.strictEqual(patched.validated_by_name, '');

  // подтверждение пишет ТЕКУЩЕГО человека, а не переданного в теле
  const validated = (await api(`/api/dataset/pairs/${sneaky.id}/validate`, {
    method: 'POST', ...json({ validated_by_name: 'Чужой Человек' }),
  })).body.pair;
  assert.strictEqual(validated.validated_by_name, 'Валидаторов Тест');
});

test('датасет: «Пропустить» не трогает пары, удаление мягкое', async () => {
  generate._setCallFn(downModel);
  const doc = (await uploadText('отложенные.txt', BIG('ОТЛОЖЕНО'))).doc;
  const el = (await api(`/api/dataset/documents/${doc.id}/elements`, { headers: asUser() })).body.elements[0];
  const pair = (await api(`/api/dataset/elements/${el.element_id}/pairs`, {
    method: 'POST', ...json({ question: 'Вопрос для отложенного?', answer: 'Ответ по фрагменту.' }),
  })).body.pair;

  const deferred = await api(`/api/dataset/documents/${doc.id}/elements/${el.element_id}/defer`, { method: 'POST', ...json({}) });
  assert.strictEqual(deferred.body.state, 'deferred');
  const after1 = (await api(`/api/dataset/elements/${el.element_id}`, { headers: asUser() })).body.pairs[0];
  assert.strictEqual(after1.status, pair.status);

  const list = await api(`/api/dataset/documents/${doc.id}/elements?state=deferred`, { headers: asUser() });
  assert.ok(list.body.elements.some((e) => e.element_id === el.element_id));

  await api(`/api/dataset/pairs/${pair.id}`, { method: 'DELETE', headers: asUser() });
  assert.strictEqual((await api(`/api/dataset/elements/${el.element_id}`, { headers: asUser() })).body.pairs.length, 0);
  await api(`/api/dataset/pairs/${pair.id}/restore`, { method: 'POST', ...json({}) });
  assert.strictEqual((await api(`/api/dataset/elements/${el.element_id}`, { headers: asUser() })).body.pairs.length, 1);
});

test('датасет: история фильтруется и ищет по тексту', async () => {
  const all = await api('/api/dataset/pairs?status=validated', { headers: asUser() });
  assert.ok(all.body.total >= 2);
  for (const item of all.body.items) assert.strictEqual(item.status, 'validated');
  // слово живёт в ТЕКСТЕ ЭЛЕМЕНТА (BIG) — поиск обязан находить и по нему
  const search = await api(`/api/dataset/pairs?q=${encodeURIComponent('противопожарные')}`, { headers: asUser() });
  assert.ok(search.body.total >= 1, 'поиск по слову из текста элемента ничего не нашёл');
  assert.ok(all.body.facets.validators.includes('Валидаторов Тест'));
});

test('датасет: экспорт — только валидированные, формат строк, детерминизм', async () => {
  const validatedTotal = (await api('/api/dataset/pairs', { headers: asUser() })).body.validatedTotal;
  assert.ok(validatedTotal >= 2);

  const exp1 = await fetch(`${base}/api/dataset/export`, { headers: asUser() });
  assert.strictEqual(exp1.status, 200);
  const text1 = await exp1.text();
  const lines = text1.split('\n').filter(Boolean);
  const meta = JSON.parse(lines[0]);
  assert.ok(meta.meta && meta.meta.system_prompt_sha256, 'нет служебной строки с версией промпта');
  assert.strictEqual(meta.meta.pairs, validatedTotal);
  assert.strictEqual(lines.length, validatedTotal + 1, 'в экспорте не ровно все валидированные пары');
  for (const line of lines.slice(1)) {
    const row = JSON.parse(line);
    assert.deepStrictEqual(row.messages.map((m) => m.role), ['system', 'user', 'assistant']);
    assert.ok(row.messages[1].content.includes('\n\n'), 'в user нет пустой строки между элементом и вопросом');
    assert.ok(row.messages[2].content.trim());
  }
  assert.ok(!text1.startsWith('﻿'), 'BOM недопустим');
  assert.ok(!text1.includes('\r'), 'переводы строк должны быть LF');
  assert.ok(text1.includes('огнестойкости'), 'ensure_ascii=false: кириллица должна быть без \\u-эскейпов');

  const text2 = await (await fetch(`${base}/api/dataset/export`, { headers: asUser() })).text();
  assert.strictEqual(text1, text2, 'повторный экспорт дал другие байты');
});

test('датасет: разбиение train/valid без пересечения по элементам, воспроизводимо', () => {
  const exporter = require('../server/services/dataset/exporter');
  const one = exporter.buildSplitExport();
  const two = exporter.buildSplitExport();
  assert.strictEqual(one.train + one.valid, one.pairs, 'части в сумме не дают исходное число записей');
  assert.ok(one.valid >= 1);
  assert.ok(one.buffer.equals(two.buffer), 'повторный экспорт с тем же seed дал другие байты');

  const AdmZip = require('adm-zip');
  const zip = new AdmZip(one.buffer);
  const readElements = (name) => zip.readAsText(name).split('\n').filter(Boolean).slice(1)
    .map((l) => {
      const c = JSON.parse(l).messages[1].content;
      return c.slice(0, c.lastIndexOf('\n\n')); // текст элемента без вопроса
    });
  const trainEls = new Set(readElements('train.jsonl'));
  for (const el of readElements('valid.jsonl')) assert.ok(!trainEls.has(el), 'элемент попал и в train, и в valid');
});

test('датасет: непригодные ответы модели пару не создают', () => {
  const { unfitReason } = generate;
  const el = 'Текст элемента про расстояния.';
  assert.ok(unfitReason(null, el));
  assert.ok(unfitReason({ question: '', answer: 'Ответ.' }, el));
  assert.ok(unfitReason({ question: 'Вопрос?', answer: '' }, el));
  assert.ok(unfitReason({ question: 'Коротко', answer: 'Ответ.' }, el), 'без «?» и короче 10 символов — непригоден');
  assert.ok(unfitReason({ question: 'Вопрос про текст?', answer: el }, el), 'дословный повтор элемента — непригоден');
  assert.strictEqual(unfitReason({ question: 'Какое расстояние требуется?', answer: 'Не менее 12 м.' }, el), null);
  // длинный вопрос без «?» пригоден — условие ТЗ двойное
  assert.strictEqual(unfitReason({ question: 'Опишите требования пункта к расстояниям.', answer: 'Не менее 12 м.' }, el), null);
});

test('датасет: нарезка — таблицы целиком, служебные строки и коротыши отбрасываются', () => {
  const { chunkText, ELEMENT_MAX_CHARS } = require('../server/services/dataset/ingest');
  const text = `стр. 3\n\n${PARA('4.1')}\n\n${TABLE}\n\n- 7 -\n\nОК.\n\n${PARA('4.2')}`;
  const els = chunkText(text);
  assert.ok(els.every((e) => e.content.length <= ELEMENT_MAX_CHARS));
  const tbl = els.filter((e) => e.kind === 'table');
  assert.strictEqual(tbl.length, 1);
  assert.strictEqual(tbl[0].content, TABLE); // таблица не разрезана и не склеена с текстом
  assert.ok(!els.some((e) => /стр\. 3|- 7 -/.test(e.content)), 'служебные строки попали в элементы');
  assert.ok(!els.some((e) => e.content === 'ОК.'), 'коротыш прошёл фильтр 50 символов');

  // длинная таблица режется строго по строкам, каждая часть начинается с шапки
  const rows = Array.from({ length: 400 }, (_, i) => `| ${i} | значение ${i} | примечание к строке номер ${i} |`);
  const parts = chunkText(`| № | Значение | Примечание |\n${rows.join('\n')}`);
  assert.ok(parts.length > 1, 'длинная таблица не разрезана');
  for (const part of parts) {
    assert.strictEqual(part.kind, 'table');
    assert.ok(part.content.startsWith('| № | Значение | Примечание |'), 'часть таблицы без шапки');
    assert.ok(part.content.length <= ELEMENT_MAX_CHARS);
    const headerCount = part.content.split('\n').filter((l) => l === '| № | Значение | Примечание |').length;
    assert.strictEqual(headerCount, 1, 'шапка внутри части продублировалась');
  }
  // строки таблицы не потерялись и не порваны
  const joined = parts.map((p) => p.content).join('\n');
  for (const i of [0, 199, 399]) assert.ok(joined.includes(`| ${i} | значение ${i} |`));

  // гибрид: мелкие абзацы склеиваются до потолка, а не остаются кусками чанкера
  const many = Array.from({ length: 30 }, (_, i) => PARA(`10.${i}`)).join('\n\n');
  const merged = chunkText(many);
  assert.ok(merged.length < 30, 'мелкие абзацы не склеились');
  assert.ok(merged.every((e) => e.content.length <= ELEMENT_MAX_CHARS));
});
