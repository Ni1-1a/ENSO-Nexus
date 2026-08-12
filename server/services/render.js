'use strict';
/**
 * Растеризация SVG в PNG через headless-браузер.
 *
 * Браузер поднимается один раз и живёт до остановки сервера: запускать Chromium
 * на каждый crop — это секунда ожидания и лишние сотни мегабайт рядом с моделями
 * LM Studio. Простаивающий браузер закрывается по таймеру.
 *
 * Модуль намеренно ничего не знает про план: на вход — готовая разметка SVG,
 * на выход — картинка. Что рисовать, решает вызывающий.
 */
const IDLE_SHUTDOWN_MS = 5 * 60 * 1000;

let browserPromise = null;
let idleTimer = null;

async function getBrowser() {
  if (!browserPromise) {
    const { chromium } = require('playwright');
    browserPromise = chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] })
      .catch((err) => { browserPromise = null; throw err; });
  }
  return browserPromise;
}

function touchIdle() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { close().catch(() => {}); }, IDLE_SHUTDOWN_MS);
  if (idleTimer.unref) idleTimer.unref(); // таймер не должен держать процесс
}

/**
 * SVG → PNG.
 * @param {string} svg     полная разметка <svg>…</svg>
 * @param {object} opts    {width, height, scale} — размер холста в пикселях
 * @returns {Buffer} PNG
 */
async function svgToPng(svg, { width = 900, height = 600, scale = 2 } = {}) {
  const browser = await getBrowser();
  const page = await browser.newPage({
    viewport: { width: Math.round(width), height: Math.round(height) },
    deviceScaleFactor: scale,
  });
  try {
    // белый фон: на прозрачном тонкие линии плана теряются в интерфейсе модели
    await page.setContent(
      `<!doctype html><meta charset="utf-8">
       <style>html,body{margin:0;padding:0;background:#fff}svg{display:block}</style>
       ${svg}`,
      { waitUntil: 'load', timeout: 15000 },
    );
    return await page.screenshot({ type: 'png' });
  } finally {
    await page.close().catch(() => {});
    touchIdle();
  }
}

/**
 * HTML → PDF. Печатается именно страница, а не картинка: в файле остаётся живой
 * текст, его можно искать и копировать, а таблицы верстаются сами.
 */
async function htmlToPdf(html, { format = 'A4', header = '', footer = '', margin = null } = {}) {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setContent(html, { waitUntil: 'load', timeout: 30000 });
    /*
     * Колонтитулы печатает БРАУЗЕР, а не вёрстка.
     *
     * Номер страницы и их общее число в HTML взять неоткуда: разбиение на
     * страницы происходит уже при печати. Без колонтитула комплект на двадцать
     * листов приходит без единого номера — такой документ нельзя ни обсудить
     * по телефону, ни сшить, ни проверить на комплектность.
     */
    const opts = { format, printBackground: true };
    if (header || footer) {
      opts.displayHeaderFooter = true;
      opts.headerTemplate = header || '<span></span>';
      opts.footerTemplate = footer || '<span></span>';
      // поля должны вмещать колонтитулы, иначе они срезаются
      opts.margin = margin || { top: '18mm', bottom: '16mm', left: '14mm', right: '12mm' };
    } else if (margin) {
      opts.margin = margin;
    }
    return await page.pdf(opts);
  } finally {
    await page.close().catch(() => {});
    touchIdle();
  }
}

async function close() {
  if (!browserPromise) return;
  const b = await browserPromise.catch(() => null);
  browserPromise = null;
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  if (b) await b.close().catch(() => {});
}

/** Доступен ли рендер вообще (браузер мог быть не установлен). */
async function available() {
  try { await getBrowser(); touchIdle(); return true; } catch { return false; }
}

module.exports = { svgToPng, htmlToPdf, close, available };
