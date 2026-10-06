'use strict';
/**
 * Кадры сцены офиса с фиксированных камер (В1, критик): headless Chrome с
 * Metal (`channel: 'chrome'`) или Chromium со SwiftShader. Кадр берётся
 * через canvas.toDataURL после ручного renderer.render — `page.screenshot`
 * ждёт rAF и виснет, панель браузера Claude в скрытом состоянии тоже.
 *
 *   node scripts/office-frames.js [http://127.0.0.1:3215] [outDir] [--chrome]
 */
const fs = require('fs');
const path = require('path');

/** Камеры по зонам: 2–3 на зону; at — где стоит камера, look — куда смотрит. */
const CAMERAS = [
  { id: 'workplace-1', zone: 'workplace', at: [-6.5, 1.6, -15.5], look: [-7.5, 1.0, -11.5] },
  { id: 'workplace-2', zone: 'workplace', at: [4.5, 1.5, -12.2], look: [1.0, 0.9, -14.0] },
  { id: 'workplace-3', zone: 'workplace', at: [-2.0, 1.6, 17.0], look: [-4.6, 1.0, 19.4] },
  { id: 'furnishing-1', zone: 'furnishing', at: [0, 1.6, 21.5], look: [0, 1.2, 12] },
  { id: 'furnishing-2', zone: 'furnishing', at: [-9.5, 1.6, 15.5], look: [-12.5, 1.2, 17.5] },
  { id: 'furnishing-3', zone: 'furnishing', at: [0, 2.3, 9.0], look: [0, 0.6, -9.0] },     // над столом-голограммой, на амфитеатр и экран
  { id: 'exterior-1', zone: 'exterior', at: [0, 1.7, 34.0], look: [0, 2.0, 20.0] },
  { id: 'exterior-2', zone: 'exterior', at: [-46, 5.5, 46.0], look: [-25, 2.0, 24.0] },    // мастерская и переход с юго-запада (прежняя точка стояла внутри павильона)
  { id: 'exterior-3', zone: 'exterior', at: [32, 3.0, 20.0], look: [26, 2.0, 12.0] },
];

async function captureFrames(baseUrl, outDir, { chrome = false, cameras = CAMERAS, width = 1280, height = 800 } = {}) {
  const pw = require('playwright');
  const browser = await pw.chromium.launch({
    headless: true, channel: chrome ? 'chrome' : undefined,
    args: chrome ? ['--use-angle=metal', '--ignore-gpu-blocklist'] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
  });
  fs.mkdirSync(outDir, { recursive: true });
  const out = [];
  try {
    const page = await browser.newPage({ viewport: { width, height } });
    await page.goto(`${baseUrl}/office.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__office && window.__office.scene && window.__office.scene.walk, null, { timeout: 180000, polling: 250 });
    await page.evaluate(() => { window.__office.paused = true; window.__office.scene.walk.lock = () => {}; });
    for (const cam of cameras) {
      const dataUrl = await page.evaluate(async (c) => {
        const sc = window.__office.scene;
        sc.camera.position.set(c.at[0], c.at[1], c.at[2]);
        sc.camera.lookAt(c.look[0], c.look[1], c.look[2]);
        sc.camera.updateMatrixWorld(true);
        sc.renderer.shadowMap.needsUpdate = true;
        sc.renderer.render(sc.scene, sc.camera);
        sc.renderer.render(sc.scene, sc.camera);
        return sc.renderer.domElement.toDataURL('image/png');
      }, cam);
      const file = path.join(outDir, `${cam.id}.png`);
      fs.writeFileSync(file, Buffer.from(dataUrl.split(',')[1], 'base64'));
      out.push({ ...cam, file });
    }
  } finally {
    await browser.close();
  }
  return out;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const base = args.find((a) => /^https?:/.test(a)) || 'http://127.0.0.1:3215';
  const outDir = args.find((a) => !/^https?:/.test(a) && !a.startsWith('--')) || path.join(process.cwd(), 'office-frames');
  captureFrames(base, outDir, { chrome: args.includes('--chrome') }).then((r) => {
    for (const f of r) console.log(f.id, f.file);
  }).catch((err) => { console.error('кадры не сняты:', err.message); process.exit(2); });
}

module.exports = { captureFrames, CAMERAS };
