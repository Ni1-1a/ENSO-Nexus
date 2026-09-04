'use strict';
/**
 * База критической инфраструктуры (ТЗ, п. 45–46).
 *
 * Хранит не конкретные объекты конкретного проекта, а КЛАССЫ: «ЛЭП 10 кВ»,
 * «газопровод высокого давления», «канализационный коллектор». Один раз
 * подтверждённый ответ работает во всех будущих проектах — именно этого просил
 * владелец: спросить один раз и больше не переспрашивать.
 *
 * Каждая запись несёт подпись того, кто подтвердил, и дату. Для инженерного
 * решения, на которое потом ссылаются, «кто-то когда-то отметил» не годится.
 */
const crypto = require('crypto');
const { db, now } = require('../../db');

const CLASSIFICATIONS = ['keep', 'movable', 'demolishable', 'critical', 'unknown'];

const LABELS = {
  keep: 'оставить на месте',
  movable: 'потенциально перенести',
  demolishable: 'потенциально демонтировать',
  critical: 'критический объект',
  unknown: 'недостаточно данных',
};

/**
 * Нормализованная подпись класса объекта. Из имени слоя вычищается всё, что
 * относится к оформлению чертежа, и остаётся суть: «Сети ЛЭП 10кВ» и
 * «ЛЭП-10 кВ (сущ.)» должны попасть в одну запись базы.
 */
/** Слова, которые есть в одном названии слоя и нет в другом, хотя объект тот же. */
const NOISE = /^(сущ|существующ\w*|проектируем\w*|проект|демонтируем\w*|слой|layer|сет[ьи]|сетей|лини[яйи]|линий|наружн\w*|подземн\w*|воздушн\w*|new|old)$/;

function signatureOf(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/\(.*?\)/g, ' ')
    // «10кВ» и «10 кВ» — одно и то же: цифры отделяются от букв
    .replace(/(\d)([a-zа-я])/g, '$1 $2')
    .replace(/([a-zа-я])(\d)/g, '$1 $2')
    .replace(/[^a-zа-я0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter((w) => w && !NOISE.test(w))
    .sort()
    .join(' ')
    .slice(0, 200);
}

/**
 * Заготовки: то, что критично по нормативам всегда, без опроса человека.
 * Это не «мнение модели», а прямое следствие охранных зон и требований к сетям.
 */
const SEED_RULES = [
  { re: /лэп|воздушн\w*\s*лини|электропередач|кабельн\w*\s*лини/i, classification: 'critical', label: 'линия электропередачи', basis: 'ПП РФ № 160 — охранная зона' },
  { re: /газопровод|газоснаб/i, classification: 'critical', label: 'газопровод', basis: 'ПП РФ № 878 — охранная зона' },
  { re: /коллектор|канализ|напорн\w*\s*канализ/i, classification: 'critical', label: 'канализационный коллектор', basis: 'СП 32.13330' },
  { re: /водопровод|водовод/i, classification: 'critical', label: 'водопровод', basis: 'СП 31.13330' },
  { re: /теплотрасс|теплосет|тепловая\s*сеть/i, classification: 'critical', label: 'тепловая сеть', basis: 'СП 124.13330' },
  { re: /связ[иь]|кабел\w*\s*связи|волоконн/i, classification: 'critical', label: 'линия связи', basis: 'ПП РФ № 578 — охранная зона' },
  { re: /ограждени|забор/i, classification: 'movable', label: 'ограждение', basis: '' },
  { re: /навес|сарай|времен\w*\s*строени/i, classification: 'demolishable', label: 'временное строение', basis: '' },
  { re: /газон|озеленен|кустарник|благоустр/i, classification: 'movable', label: 'элемент благоустройства', basis: '' },
];

/** Что известно о классе объекта: сперва база, потом заготовки, иначе — неизвестно. */
function classify(sourceLayer) {
  const signature = signatureOf(sourceLayer);
  if (!signature) return { classification: 'unknown', label: '', source: 'none', signature };

  const saved = db.prepare('SELECT * FROM critical_objects WHERE signature = ?').get(signature);
  if (saved) {
    return {
      classification: saved.classification,
      label: saved.label,
      basis: saved.basis || '',
      validatedBy: saved.validated_by || '',
      validatedAt: saved.validated_at || '',
      source: 'база',
      signature,
    };
  }
  for (const rule of SEED_RULES) {
    if (rule.re.test(String(sourceLayer || ''))) {
      return { classification: rule.classification, label: rule.label, basis: rule.basis, source: 'норматив', signature };
    }
  }
  return { classification: 'unknown', label: '', basis: '', source: 'none', signature };
}

/**
 * Запись решения человека. Подпись обязательна: без неё запись бессмысленна,
 * потому что сослаться будет не на кого.
 */
function remember({ sourceLayer, label, classification, basis = '', validatedBy, note = '' }) {
  if (classification === undefined || classification === null || classification === '') {
    throw new Error('Не указана классификация объекта');
  }
  if (!CLASSIFICATIONS.includes(classification)) throw new Error(`Неизвестная классификация: ${classification}`);
  if (!String(validatedBy || '').trim()) throw new Error('Нужно указать, кто подтвердил классификацию');
  const signature = signatureOf(sourceLayer);
  if (!signature) throw new Error('Пустое имя слоя — класс объекта определить не по чему');

  const existing = db.prepare('SELECT id FROM critical_objects WHERE signature = ?').get(signature);
  const ts = now();
  if (existing) {
    db.prepare('UPDATE critical_objects SET label = ?, classification = ?, basis = ?, validated_by = ?, validated_at = ?, note = ? WHERE id = ?')
      .run(String(label || sourceLayer).slice(0, 200), classification, String(basis).slice(0, 300),
        String(validatedBy).slice(0, 120), ts, String(note).slice(0, 1000), existing.id);
    return { ...classify(sourceLayer), updated: true };
  }
  db.prepare('INSERT INTO critical_objects (id, signature, label, classification, basis, validated_by, validated_at, note, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(crypto.randomUUID(), signature, String(label || sourceLayer).slice(0, 200), classification,
      String(basis).slice(0, 300), String(validatedBy).slice(0, 120), ts, String(note).slice(0, 1000), ts);
  return { ...classify(sourceLayer), updated: false };
}

/** Всё содержимое базы — для экрана настроек и для отчёта. */
function list() {
  return db.prepare('SELECT * FROM critical_objects ORDER BY classification, label').all().map((r) => ({
    id: r.id,
    signature: r.signature,
    label: r.label,
    classification: r.classification,
    classificationLabel: LABELS[r.classification] || r.classification,
    basis: r.basis || '',
    validatedBy: r.validated_by || '',
    validatedAt: r.validated_at || '',
    note: r.note || '',
  }));
}

/** Классы объектов проекта, о которых база ещё ничего не знает — их и спрашивать. */
function unknownIn(site) {
  const seen = new Map();
  for (const key of ['utilities', 'existingObjects', 'buildings']) {
    for (const obj of site[key] || []) {
      const layer = obj.provenance.sourceLayer || '';
      const info = classify(layer);
      if (info.classification !== 'unknown') continue;
      if (!seen.has(info.signature)) seen.set(info.signature, { signature: info.signature, sourceLayer: layer, objects: 0 });
      seen.get(info.signature).objects++;
    }
  }
  return [...seen.values()];
}

module.exports = { classify, remember, list, unknownIn, signatureOf, CLASSIFICATIONS, LABELS, SEED_RULES };
