'use strict';
/**
 * Аудит сцены «Виртуального офиса» (В1) в безголовом Chromium: открывает
 * office.html на стенде, ждёт сборку сцены, зовёт `__office.audit('all')` и
 * печатает дефекты по зонам. Тот же модуль использует tests/office.test.js.
 *
 *   node scripts/office-audit.js [http://127.0.0.1:3215] [--json out.json] [--journal office-audit-journal.md --note "круг 3"]
 *   зонды: --probe <re> (габариты по имени), --children <re> (дети контейнера),
 *          --near x,y,z,r (все меши у точки, в т.ч. безымянные), --lowverts <re> --limit y
 *
 * Панель браузера Claude и Playwright-скриншоты ждут rAF и виснут — поэтому
 * здесь `waitForFunction` с polling, пауза цикла (`__office.paused`) и
 * никаких screenshot. WebGL в безголовом Chromium — SwiftShader, сцене это
 * безразлично: аудит считает геометрию, а не кадры.
 */
const fs = require('fs');
const path = require('path');

async function runAudit(baseUrl, { timeoutMs = 180000, browserPath = '', probe = '', children = '', lowverts = '', limit = 0.5, near = null } = {}) {
  const opts = { probe, children, lowverts, limit, near };
  const pw = require('playwright');
  const browser = await pw.chromium.launch({
    headless: true, executablePath: browserPath || undefined,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--disable-gpu-vsync'],
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    await page.goto(`${baseUrl}/office.html?lite=1&nomerge=1`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__office && window.__office.scene && window.__office.scene.walk, null, { timeout: timeoutMs, polling: 250 });
    await page.evaluate(() => { window.__office.paused = true; if (window.__office.scene.walk) window.__office.scene.walk.lock = () => {}; });
    if (opts.lowverts) {
      // вершины склеенных мешей контейнера ниже порога: где именно склейка уходит под пол
      return await page.evaluate(([pat, limit]) => {
        const sc = window.__office.scene; const THREE = sc.THREE; const re = new RegExp(pat, 'i'); const out = [];
        sc.scene.updateMatrixWorld(true);
        const v = new THREE.Vector3();
        sc.scene.traverse((o) => {
          if (!o.name || !re.test(o.name)) return;
          for (const c of o.children) {
            if (!c.isMesh || !c.geometry || !c.geometry.attributes.position) continue;
            const pos = c.geometry.attributes.position; const cells = new Map();
            for (let i = 0; i < pos.count; i++) {
              v.fromBufferAttribute(pos, i).applyMatrix4(c.matrixWorld);
              if (v.y >= limit) continue;
              const k = `${Math.round(v.x)},${Math.round(v.z)}`;
              const e = cells.get(k) || { x: Math.round(v.x), z: Math.round(v.z), n: 0, minY: 99 };
              e.n += 1; e.minY = Math.min(e.minY, +v.y.toFixed(2)); cells.set(k, e);
            }
            if (cells.size) out.push({ mesh: c.name || c.geometry.type, cells: [...cells.values()].slice(0, 20) });
          }
        });
        return out;
      }, [opts.lowverts, opts.limit]);
    }
    if (opts.children) {
      // дети контейнера с габаритами: безымянные предметы находятся по месту
      return await page.evaluate((pat) => {
        const sc = window.__office.scene; const THREE = sc.THREE; const re = new RegExp(pat, 'i'); const out = [];
        sc.scene.updateMatrixWorld(true);
        const firstName = (o) => { let f = ''; o.traverse((c) => { if (!f && c.name) f = c.name; }); return f; };
        sc.scene.traverse((o) => {
          if (!o.name || !re.test(o.name)) return;
          for (const c of o.children) {
            const b = new THREE.Box3().setFromObject(c);
            if (!Number.isFinite(b.min.y)) continue;
            out.push({ name: c.name || firstName(c) || c.type, geom: c.geometry ? c.geometry.type : c.type, min: [b.min.x, b.min.y, b.min.z].map((v) => +v.toFixed(2)), max: [b.max.x, b.max.y, b.max.z].map((v) => +v.toFixed(2)) });
          }
        });
        return out;
      }, opts.children);
    }
    if (opts.near) {
      // зонд по месту: все меши, чья мировая коробка накрывает точку (x, y, z) с запасом r — для безымянных предметов
      return await page.evaluate(([x, y, z, r]) => {
        const sc = window.__office.scene; const THREE = sc.THREE; const out = [];
        sc.scene.updateMatrixWorld(true);
        const path = (o) => { const p = []; let q = o; while (q && p.length < 4) { if (q.name) p.unshift(q.name); q = q.parent; } return p.join('/'); };
        sc.scene.traverse((o) => {
          if (!o.isMesh && !o.isInstancedMesh) return;
          const b = new THREE.Box3().setFromObject(o);
          if (!Number.isFinite(b.min.y)) return;
          if (b.min.x - r > x || b.max.x + r < x || b.min.y - r > y || b.max.y + r < y || b.min.z - r > z || b.max.z + r < z) return;
          const size = b.getSize(new THREE.Vector3());
          if (size.x > 60 || size.z > 60) return;   // газон, панорама, кольцо целиком — не нужны
          out.push({ path: path(o) || '(без имени)', geom: o.geometry ? o.geometry.type : o.type, air: !!(o.userData && o.userData.airborne), min: [b.min.x, b.min.y, b.min.z].map((v) => +v.toFixed(2)), max: [b.max.x, b.max.y, b.max.z].map((v) => +v.toFixed(2)) });
        });
        return out;
      }, opts.near);
    }
    if (opts.probe) {
      // зонд: мировые габариты предметов по регулярному выражению
      // await обязателен: return без него отдаёт промис, а finally тут же закрывает браузер
      return await page.evaluate((pat) => {
        const sc = window.__office.scene; const THREE = sc.THREE; const re = new RegExp(pat, 'i'); const out = [];
        sc.scene.updateMatrixWorld(true);
        sc.scene.traverse((o) => {
          const name = (o.userData && o.userData.unit) || o.name || '';
          if (!name || !re.test(name) || out.length > 80) return;
          const b = new THREE.Box3().setFromObject(o);
          out.push({ name, type: o.type, geom: o.geometry ? o.geometry.type : '', zone: (o.userData && o.userData.zone) || '', min: [b.min.x, b.min.y, b.min.z].map((v) => +v.toFixed(3)), max: [b.max.x, b.max.y, b.max.z].map((v) => +v.toFixed(3)) });
        });
        return out;
      }, opts.probe);
    }
    const result = await page.evaluate(async () => {
      const r = await window.__office.audit('all');
      // строки — только простые значения
      return JSON.parse(JSON.stringify(r));
    });
    const stats = await page.evaluate(() => {
      let meshes = 0, instanced = 0, zones = {};
      window.__office.scene.scene.traverse((o) => {
        if (o.isInstancedMesh) instanced += 1; else if (o.isMesh) meshes += 1;
      });
      for (const c of window.__office.scene.scene.children) { const z = (c.userData && c.userData.zone) || 'unzoned'; zones[z] = (zones[z] || 0) + 1; }
      return { meshes, instanced, topLevelByZone: zones };
    });
    return { ...result, stats, errors };
  } finally {
    await browser.close();
  }
}

function summarize(r) {
  const lines = [];
  for (const [z, c] of Object.entries(r.counts)) lines.push(`${z.padEnd(11)} парящих ${String(c.floating).padStart(4)}  пересечений ${String(c.overlaps).padStart(4)}  экстерьер ${String(c.exterior).padStart(3)}`);
  lines.push(`всего ${r.total} · исключено по списку: пересечений ${r.excepted.overlaps}, парящих ${r.excepted.floating}`);
  return lines.join('\n');
}

function appendJournal(file, r, note) {
  const row = `| ${new Date().toISOString().slice(0, 16).replace('T', ' ')} | ${note || ''} | ${ZONES.map((z) => `${r.counts[z].floating}/${r.counts[z].overlaps}/${r.counts[z].exterior}`).join(' | ')} | ${r.counts.unzoned ? `${r.counts.unzoned.floating}/${r.counts.unzoned.overlaps}` : '0/0'} | **${r.total}** |\n`;
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, `# Журнал аудита сцены офиса (В1)\n\nЧисло дефектов по зонам на каждом круге: парящие / пересечения / экстерьер. Ноль во всех зонах — условие приёмки; исключения — public/office-audit-exceptions.mjs, у каждой строки причина.\n\n| когда | круг | workplace | furnishing | exterior | без зоны | всего |\n|---|---|---|---|---|---|---|\n`);
  }
  fs.appendFileSync(file, row);
}
const ZONES = ['workplace', 'furnishing', 'exterior'];

if (require.main === module) {
  const args = process.argv.slice(2);
  const base = args.find((a) => /^https?:/.test(a)) || 'http://127.0.0.1:3215';
  const jsonOut = args.includes('--json') ? args[args.indexOf('--json') + 1] : '';
  const journal = args.includes('--journal') ? args[args.indexOf('--journal') + 1] : '';
  const note = args.includes('--note') ? args[args.indexOf('--note') + 1] : '';
  const probe = args.includes('--probe') ? args[args.indexOf('--probe') + 1] : '';
  const children = args.includes('--children') ? args[args.indexOf('--children') + 1] : '';
  const lowverts = args.includes('--lowverts') ? args[args.indexOf('--lowverts') + 1] : '';
  if (lowverts) {
    const limit = args.includes('--limit') ? Number(args[args.indexOf('--limit') + 1]) : 0.5;
    runAudit(base, { lowverts, limit }).then((rows) => { for (const r of rows) console.log(r.mesh, JSON.stringify(r.cells)); process.exit(0); })
      .catch((err) => { console.error('вершины:', err.message); process.exit(2); });
    return;
  }
  if (children) {
    runAudit(base, { children }).then((rows) => { for (const r of rows) console.log(`${String(r.name).slice(0, 36).padEnd(37)} ${String(r.geom).padEnd(18)} y ${r.min[1]} … ${r.max[1]}  x ${r.min[0]} … ${r.max[0]}  z ${r.min[2]} … ${r.max[2]}`); process.exit(0); })
      .catch((err) => { console.error('дети:', err.message); process.exit(2); });
    return;
  }
  const near = args.includes('--near') ? args[args.indexOf('--near') + 1].split(',').map(Number) : null;
  if (near) {
    runAudit(base, { near }).then((rows) => { for (const r of rows) console.log(`${r.path.slice(0, 60).padEnd(61)} ${r.geom.padEnd(18)}${r.air ? ' air' : '    '} y ${r.min[1]} … ${r.max[1]}  x ${r.min[0]} … ${r.max[0]}  z ${r.min[2]} … ${r.max[2]}`); process.exit(0); })
      .catch((err) => { console.error('зонд по месту:', err.message); process.exit(2); });
    return;
  }
  if (probe) {
    runAudit(base, { probe }).then((rows) => { for (const r of rows) console.log(`${r.name.padEnd(40)} ${r.geom.padEnd(18)} y ${r.min[1]} … ${r.max[1]}  x ${r.min[0]} … ${r.max[0]}  z ${r.min[2]} … ${r.max[2]}`); process.exit(0); })
      .catch((err) => { console.error('зонд:', err.message); process.exit(2); });
    return;
  }
  runAudit(base).then((r) => {
    console.log(summarize(r));
    console.log('сцена:', JSON.stringify(r.stats));
    if (r.errors.length) console.log('ошибки страницы:', r.errors.slice(0, 5));
    const top = (list, n = 12) => list.slice(0, n).map((x) => `  ${JSON.stringify(x)}`).join('\n');
    for (const z of [...ZONES, 'unzoned']) {
      const v = r.zones[z];
      if (!v) continue;
      if (v.floating.length) console.log(`\n[${z}] парящие (${v.floating.length}):\n${top(v.floating)}`);
      if (v.overlaps.length) console.log(`\n[${z}] пересечения (${v.overlaps.length}):\n${top(v.overlaps)}`);
      if (v.exterior.length) console.log(`\n[${z}] экстерьер (${v.exterior.length}):\n${top(v.exterior)}`);
    }
    if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(r, null, 1));
    if (journal) appendJournal(path.resolve(journal), r, note);
    process.exit(0);
  }).catch((err) => { console.error('аудит не выполнен:', err.message); process.exit(2); });
}

module.exports = { runAudit, summarize, appendJournal, ZONES };
