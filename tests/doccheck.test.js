'use strict';
/* Модуль «Проверка документа»: библиотека промптов и маршруты типов,
 * классификация маркерами, перечень ссылок на НТД, полный прогон с
 * подменённой моделью, решения, экспорт, замена A→B.
 * Живой сервер на эфемерном порту — по образцу tests/tz.test.js. */
const os = require('os');
const path = require('path');
const fs = require('fs');
process.env.DATA_DIR = path.join(os.tmpdir(), `pilot1-doccheck-${process.pid}`);
process.env.ANTHROPIC_API_KEY = '';
process.env.USERS_FILE = path.join(os.tmpdir(), `pilot1-doccheck-users-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
process.env.RATE_LIMIT_GENERAL = '1000';
process.env.RATE_LIMIT_EXPENSIVE = '1000';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const AdmZip = require('adm-zip');
const { createApp } = require('../server/app');
const doclib = require('../server/services/doclib');
const ntdRefs = require('../server/services/doccheck/ntd-refs');
const analyze = require('../server/services/doccheck/analyze');
const ab = require('../server/services/doccheck/ab');
const dcStore = require('../server/services/doccheck/store');

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
async function login(lastName = 'Инженер', firstName = 'Тест') {
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

/* ---------------- библиотека и маршруты типов ---------------- */

test('doclib: каждый маршрут типов указывает на существующие промпты библиотеки', () => {
  for (const [type, route] of Object.entries(doclib.ROUTES)) {
    const main = doclib.byId(route.promptId);
    assert.ok(main.body.length > 40, `${type}: тело промпта ${route.promptId} подозрительно короткое`);
    assert.strictEqual(main.id, route.promptId, `${type}: id во фронтматтере не равен имени файла`);
    if (route.systemId) {
      const sys = doclib.byId(route.systemId);
      assert.ok(sys.body.length > 40, `${type}: каркас ${route.systemId} пуст`);
    }
    for (const alt of route.alternatives) {
      assert.ok(doclib.byId(alt).body.length > 20, `${type}: альтернатива ${alt} не читается`);
    }
  }
});

test('doclib: маркеры — один тип уверенно, несколько типов честно неоднозначно', () => {
  const ks2 = doclib.classifyByMarkers('акт.pdf', 'Унифицированная форма КС-2. Акт о приёмке выполненных работ');
  assert.strictEqual(ks2.type, 'ks2');
  const smeta = doclib.classifyByMarkers('смета.xlsx.pdf', 'ЛОКАЛЬНАЯ СМЕТА № 02-01 на устройство фундаментов');
  assert.strictEqual(smeta.type, 'smeta');
  // смета И ведомость сразу — неоднозначно, тип не выдумывается
  const both = doclib.classifyByMarkers('док.pdf', 'Локальная смета… Ведомость объёмов работ…');
  assert.strictEqual(both.type, null);
  assert.ok(both.candidates.length >= 2);
  // график MS Project узнаётся по пространству имён XML
  const msp = doclib.classifyByMarkers('гпр.xml',
    '<?xml version="1.0"?><Project xmlns="http://schemas.microsoft.com/project"><Name>Объект</Name>');
  assert.strictEqual(msp.type, 'grafik');
});

test('doclib: meta отдаёт типы с заголовками промптов', () => {
  const meta = doclib.meta();
  const ar = meta.find((t) => t.id === 'razdel-ar');
  assert.ok(ar && ar.promptTitle && ar.alternatives.length === 14);
  assert.ok(meta.find((t) => t.id === 'tz').note, 'у ТЗ обязана быть подсказка про модуль «Анализ ТЗ»');
});

/* ---------------- перечень ссылок на НТД ---------------- */

test('ntd-refs: шифры извлекаются с местами, статусы сверяются с реестром', () => {
  const text = [
    'Раздел выполнен по ГОСТ 21.002-2014 и ГОСТ Р 21.1101-2013.',
    'Отопление — по СП 60.13330.2020, смета — по приказу № 421/пр.',
    'Безопасность — 384-ФЗ. Выдуманный документ: СП 999.99999.',
  ].join('\n');
  const { refs } = ntdRefs.extract(text);
  const byCode = Object.fromEntries(refs.map((r) => [ntdRefs.normalizeCode(r.code), r]));

  const alive = byCode['ГОСТ 21.002-2014'];
  assert.ok(alive, 'действующий ГОСТ не извлечён');
  assert.match(alive.verdict, /действует/);
  assert.strictEqual(alive.places[0].line, 1);

  const replaced = byCode['ГОСТ Р 21.1101-2013'];
  assert.ok(replaced, 'заменённый ГОСТ не извлечён');
  assert.match(replaced.verdict, /заменён|утратил/);

  const unknown = byCode['СП 999.99999'];
  assert.ok(unknown, 'неизвестный СП не извлечён');
  assert.strictEqual(unknown.verdict, 'нет в реестре');

  assert.ok(byCode['384-ФЗ'], 'ссылка на ФЗ не извлечена');
  assert.ok(byCode['№ 421/ПР'] || byCode['421/ПР'], 'приказ /пр не извлечён');
});

/* ---------------- маршруты и прогоны ---------------- */

test('проверка документа: без входа доступа нет', async () => {
  const r = await api('/api/doccheck/checks');
  assert.strictEqual(r.status, 401);
});

let checkId = '';

test('проверка документа: загрузка текста БЕЗ модели — прогон сам стартует и честно говорит, чего не хватило', async () => {
  userToken = await login();
  assert.ok(userToken, 'вход не выдал токен');
  const created = await api('/api/doccheck/checks', { method: 'POST', ...json({ name: 'Договор (тест)' }) });
  assert.strictEqual(created.status, 201);
  checkId = created.body.check.id;

  const put = await api(`/api/doccheck/checks/${checkId}/document`, {
    method: 'PUT',
    ...json({ text: 'ДОГОВОР ПОДРЯДА № 7. Заказчик обязуется… Работы по СП 48.13330.2019.', name: 'договор.txt' }),
  });
  assert.strictEqual(put.status, 200);
  assert.ok(put.body.runId, 'автозапуск прогона не случился');

  let run = null;
  for (let i = 0; i < 200; i++) {
    const r = await api(`/api/doccheck/runs/${put.body.runId}`, { headers: asUser() });
    run = r.body.run;
    if (['done', 'failed'].includes(run.status)) break;
    await new Promise((res) => setTimeout(res, 25));
  }
  assert.strictEqual(run.status, 'done', `прогон не завершился: ${run && run.error_text}`);
  // тип определён кодом по маркерам, без модели
  assert.strictEqual(run.result.classification.type, 'dogovor');
  assert.strictEqual(run.result.classification.via, 'маркеры');
  // профильная проверка не запускалась, и это проговорено
  assert.strictEqual(run.result.routed, null);
  assert.ok(run.result.unverified.some((u) => /модель не выбрана/.test(u.what)));
  // а перечень НТД собран детерминированно
  assert.ok(run.result.ntd_refs.some((r) => /СП 48\.13330/.test(r.code)));
});

function fakeDocModel({ schemaName }) {
  if (schemaName === 'doccheck_classify') {
    return { text: JSON.stringify({ doc_type: 'razdel-kzh', kind_note: 'ПЗ КЖ', confidence: 'высокая', evidence: 'Бетон B25' }) };
  }
  return {
    text: JSON.stringify({
      findings: [
        {
          what: 'Класс бетона в ПЗ (B25) расходится со спецификацией (B20)',
          where: 'ПЗ стр. 4 / спецификация табл. 2',
          quote: 'плиты из бетона B25',
          standard: 'СП 63.13330', clause: '6.1.1', clause_confidence: null,
          action: 'исправить', kind: 'коллизия',
        },
        {
          what: 'Масса оборудования выросла — влияние на опору не оценено',
          where: 'спецификация поз. 8',
          quote: null, standard: null, clause: null, clause_confidence: null,
          action: 'проверить', kind: 'неполнота',
        },
      ],
      missing_data: ['узлы армирования'],
      notes: null,
    }),
  };
}

test('проверка документа: полный прогон с подменённой моделью — маршрут, находки Д4/Д1, решение, экспорт', async () => {
  analyze._setCallFn(async (args) => fakeDocModel(args));
  try {
    const created = await api('/api/doccheck/checks', { method: 'POST', ...json({ name: 'КЖ (тест)' }) });
    const id = created.body.check.id;
    // модель прямо в хранилище: validateChoice в тестовом окружении скажет
    // «LM Studio недоступен», а прогон идёт через подменённый вызов
    dcStore.updateCheck(id, { ai_provider: 'lmstudio', ai_model: 'test-model' });

    // текст без однозначных маркеров → классификацию делает (подменённая) модель
    const put = await api(`/api/doccheck/checks/${id}/document`, {
      method: 'PUT', ...json({ text: 'Пояснительная записка. Бетон B25. Плиты перекрытия по СП 63.13330.2018.', name: 'пз.txt' }),
    });
    assert.strictEqual(put.status, 200);
    const runId = put.body.runId;

    let run = null;
    for (let i = 0; i < 200; i++) {
      const r = await api(`/api/doccheck/runs/${runId}`, { headers: asUser() });
      run = r.body.run;
      if (['done', 'failed'].includes(run.status)) break;
      await new Promise((res) => setTimeout(res, 25));
    }
    assert.strictEqual(run.status, 'done', `прогон не завершился: ${run && run.error_text}`);
    const result = run.result;
    assert.strictEqual(result.classification.type, 'razdel-kzh');
    assert.strictEqual(result.classification.via, 'модель');
    // маршрут выбран автоматически и записан в прогон
    assert.strictEqual(result.routed.prompt_id, 'dop-kr-k01');
    assert.strictEqual(run.prompt_id, 'dop-kr-k01');
    assert.ok(run.prompt_sha256.length === 64, 'sha промпта не снят');
    // Д4: пункт без флага уверенности получает «низкая», находка с пунктом — needs_human
    const first = result.findings.find((f) => f.clause === '6.1.1');
    assert.strictEqual(first.clause_confidence, 'низкая');
    assert.strictEqual(first.needs_human, true);
    // Д1: «проверить» — needs_human
    const second = result.findings.find((f) => f.action === 'проверить');
    assert.strictEqual(second.needs_human, true);
    // Hermes-предупреждение о пунктах — в unverified
    assert.ok(result.unverified.some((u) => /гипотезы/.test(u.what)));

    // решение ставит человек, ФИО пишет сервер
    const set = await api(`/api/doccheck/runs/${runId}/findings/${first.id}/decision`, {
      method: 'POST', ...json({ decision: 'accepted' }),
    });
    assert.strictEqual(set.status, 200);
    assert.match(set.body.decision.by, /Инженер/);

    // экспорт: два листа, решение живое
    const xlsx = await fetch(`${base}/api/doccheck/runs/${runId}/export.xlsx`, { headers: asUser() });
    assert.strictEqual(xlsx.status, 200);
    const zip = new AdmZip(Buffer.from(await xlsx.arrayBuffer()));
    const sheet1 = zip.getEntry('xl/worksheets/sheet1.xml').getData().toString('utf8');
    const sheet2 = zip.getEntry('xl/worksheets/sheet2.xml').getData().toString('utf8');
    assert.match(sheet1, /принято/);
    assert.match(sheet1, /6\.1\.1/);
    assert.match(sheet2, /СП 63\.13330/);
  } finally {
    analyze._setCallFn(null);
  }
});

test('проверка документа: выбор человека сильнее догадки — chosen_type перенаправляет маршрут', async () => {
  analyze._setCallFn(async ({ schemaName }) => {
    assert.notStrictEqual(schemaName, 'doccheck_classify', 'при chosen_type классификация модели не зовётся');
    return fakeDocModel({ schemaName });
  });
  try {
    const created = await api('/api/doccheck/checks', { method: 'POST', ...json({ name: 'Выбор человека (тест)' }) });
    const id = created.body.check.id;
    dcStore.updateCheck(id, { ai_provider: 'lmstudio', ai_model: 'test-model' });
    await api(`/api/doccheck/checks/${id}/document`, {
      method: 'PUT', ...json({ text: 'Произвольный текст без маркеров и с бетоном.', name: 'x.txt' }),
    });
    // дождаться авто-прогона, затем человек выбирает тип и перезапускает
    await new Promise((r) => setTimeout(r, 200));
    const patch = await api(`/api/doccheck/checks/${id}`, { method: 'PATCH', ...json({ chosen_type: 'razdel-kzh' }) });
    assert.strictEqual(patch.status, 200);
    const started = await api(`/api/doccheck/checks/${id}/analyze`, { method: 'POST', ...json({}) });
    assert.strictEqual(started.status, 202);
    let run = null;
    for (let i = 0; i < 200; i++) {
      const r = await api(`/api/doccheck/runs/${started.body.runId}`, { headers: asUser() });
      run = r.body.run;
      if (['done', 'failed'].includes(run.status)) break;
      await new Promise((res) => setTimeout(res, 25));
    }
    assert.strictEqual(run.status, 'done', `прогон не завершился: ${run && run.error_text}`);
    assert.strictEqual(run.result.classification.via, 'человек');
    assert.strictEqual(run.result.routed.prompt_id, 'dop-kr-k01');
  } finally {
    analyze._setCallFn(null);
  }
});

/* ---------------- замена A→B ---------------- */

test('замена A→B: без документов обеих моделей прогон отказывает', async () => {
  const created = await api('/api/doccheck/ab', { method: 'POST', ...json({ name: 'Насос (тест)' }) });
  assert.strictEqual(created.status, 201);
  const id = created.body.ab.id;
  ab._setCallFn(async () => { throw new Error('модель не должна была вызываться'); });
  try {
    await api(`/api/doccheck/ab/${id}/docs/a`, { method: 'PUT', ...json({ text: 'Паспорт A: расход 18 м3/ч', name: 'паспорт-A.txt' }) });
    const started = await api(`/api/doccheck/ab/${id}/run`, { method: 'POST', ...json({}) });
    assert.strictEqual(started.status, 202); // прогон стартует фоном…
    let row = null;
    for (let i = 0; i < 200; i++) {
      const r = await api(`/api/doccheck/ab/${id}`, { headers: asUser() });
      row = r.body.ab;
      if (['done', 'failed'].includes(row.status)) break;
      await new Promise((res) => setTimeout(res, 25));
    }
    assert.strictEqual(row.status, 'failed'); // …и честно падает с причиной
    assert.match(row.error_text, /обеих моделей/);
  } finally {
    ab._setCallFn(null);
  }
});

test('замена A→B: протокол с подменённой моделью — статусы, «нет источника», решение инженера, xlsx', async () => {
  ab._setCallFn(async () => ({
    text: JSON.stringify({
      rows: [
        {
          category: 'Электрика', param: 'Мощность двигателя', requirement: '≤ 4.0',
          value_a: '4.0', value_b: '5.5', unit: 'кВт', source_b: 'Паспорт B', page_b: '7',
          status: 'НЕ СООТВЕТСТВУЕТ', risk: 'ЭО',
        },
        {
          // значение B без источника — код понижает ПОДТВЕРЖДЕНО до ТРЕБУЕТ ПРОВЕРКИ
          category: 'Рабочий режим', param: 'Напор', requirement: '22',
          value_a: '22', value_b: '22', unit: 'м', source_b: null, page_b: null,
          status: 'ПОДТВЕРЖДЕНО', risk: null,
        },
        {
          category: 'Комплектность', param: 'Частотный преобразователь', requirement: 'в комплекте',
          value_a: 'есть', value_b: null, unit: null, source_b: null, page_b: null,
          status: 'НЕТ ДАННЫХ', risk: 'комплектность',
        },
      ],
      missing_params: ['температура среды'],
      supplier_questions: ['подтвердите комплектацию частотником'],
      affected_sections: ['ЭО'],
      priority_rows: ['Мощность двигателя'],
    }),
  }));
  try {
    const created = await api('/api/doccheck/ab', { method: 'POST', ...json({ name: 'Насос 2 (тест)' }) });
    const id = created.body.ab.id;
    const { db } = dcStore;
    db.prepare('UPDATE doccheck_ab SET ai_provider = ?, ai_model = ? WHERE id = ?').run('lmstudio', 'test-model', id);
    await api(`/api/doccheck/ab/${id}/docs/req`, { method: 'PUT', ...json({ text: 'ТЗ: мощность ≤ 4 кВт', name: 'тз.txt' }) });
    await api(`/api/doccheck/ab/${id}/docs/a`, { method: 'PUT', ...json({ text: 'Паспорт A', name: 'a.txt' }) });
    await api(`/api/doccheck/ab/${id}/docs/b`, { method: 'PUT', ...json({ text: 'Паспорт B', name: 'b.txt' }) });
    const started = await api(`/api/doccheck/ab/${id}/run`, { method: 'POST', ...json({}) });
    assert.strictEqual(started.status, 202);

    let row = null;
    for (let i = 0; i < 200; i++) {
      const r = await api(`/api/doccheck/ab/${id}`, { headers: asUser() });
      row = r.body.ab;
      if (['done', 'failed'].includes(row.status)) break;
      await new Promise((res) => setTimeout(res, 25));
    }
    assert.strictEqual(row.status, 'done', `сравнение не завершилось: ${row && row.error_text}`);
    const rows = row.result.rows;
    assert.strictEqual(rows.length, 3);
    const napor = rows.find((r) => r.param === 'Напор');
    assert.strictEqual(napor.status, 'ТРЕБУЕТ ПРОВЕРКИ', 'значение без источника не понижено');
    assert.strictEqual(napor.no_source, true);
    assert.strictEqual(row.result.summary['НЕ СООТВЕТСТВУЕТ'], 1);

    // решение инженера — из четырёх статусов протокола
    const bad = await api(`/api/doccheck/ab/${id}/rows/${rows[0].id}/decision`, { method: 'POST', ...json({ decision: 'подходит' }) });
    assert.strictEqual(bad.status, 400);
    const set = await api(`/api/doccheck/ab/${id}/rows/${rows[0].id}/decision`, {
      method: 'POST', ...json({ decision: 'НЕ СООТВЕТСТВУЕТ', comment: 'кабель и защита не тянут 5,5 кВт' }),
    });
    assert.strictEqual(set.status, 200);
    assert.match(set.body.decision.by, /Инженер/);

    const xlsx = await fetch(`${base}/api/doccheck/ab/${id}/export.xlsx`, { headers: asUser() });
    assert.strictEqual(xlsx.status, 200);
    const zip = new AdmZip(Buffer.from(await xlsx.arrayBuffer()));
    const sheet = zip.getEntry('xl/worksheets/sheet1.xml').getData().toString('utf8');
    assert.match(sheet, /НЕТ ИСТОЧНИКА/);
    assert.match(sheet, /кабель и защита/);
    assert.match(sheet, /Вопросы производителю/);
  } finally {
    ab._setCallFn(null);
  }
});
