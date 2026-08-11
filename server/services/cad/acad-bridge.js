'use strict';
/**
 * Мост к AutoCAD for Mac: спецификация чертежа → настоящий DWG.
 *
 * Записать DWG самостоятельно нельзя — формат закрытый, а конвертер libredwg
 * на этой машине портит имена слоёв. Поэтому файл создаёт сам AutoCAD:
 * сервер передаёт мосту (claude-acad-bridge.lsp) команды создания слоёв,
 * полилиний, штриховок и подписей, а затем просит выгрузить построенное
 * через -WBLOCK в отдельный DWG.
 *
 * Текущий чертёж пользователя не меняется: всё созданное удаляется сразу
 * после выгрузки, а -WBLOCK пишет новый файл, не переименовывая открытый.
 *
 * Транспорт — тот же файловый JSON-RPC, что у MCP-коннектора:
 *   <exchange>/requests/req-<id>.json  →  <exchange>/responses/res-<id>.json
 * Триггер — AppleScript, который вводит CLAUDE-PUMP в командную строку AutoCAD.
 */
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const config = require('../../config');
const planSpec = require('./plan-spec');

const POLL_INTERVAL_MS = 200;
const RETRIGGER_AT_MS = [5000, 15000];

/**
 * Раскладки, при которых AppleScript способен напечатать латиницу.
 * При русской «CLAUDE-PUMP» приходит в AutoCAD искажённым, мост такой команды
 * не знает, и отказ выглядит как «AutoCAD не отвечает» — причём через раз,
 * в зависимости от того, что было включено в этот момент.
 */
const LATIN_LAYOUT_RE = /US|ABC|British|Australian|Canadian|Irish|Colemak|Dvorak|German|French|Spanish|Italian|Portuguese|Polish|Czech|Turkish|Norwegian|Swedish|Danish|Finnish|Dutch|Belgian|Swiss/i;

/** Идентификатор текущей раскладки или '' , если узнать не удалось. */
function currentKeyboardLayout() {
  try {
    return require('child_process')
      .execFileSync('defaults', ['read', 'com.apple.HIToolbox', 'AppleCurrentKeyboardLayoutInputSourceID'],
        { encoding: 'utf8', timeout: 4000 })
      .trim();
  } catch {
    return '';
  }
}

/** AutoCAD не отвечает: не запущен, мост не загружен или висит модальный диалог. */
class AcadUnavailableError extends Error {}
/** Мост ответил ошибкой по протоколу. */
class AcadRpcError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function exchangeDir() {
  return config.acad.exchangeDir
    || path.join(os.homedir(), 'Library', 'Application Support', 'ClaudeAcadMCP', 'exchange');
}

/**
 * Доступность моста — только то, что можно проверить не трогая AutoCAD:
 * включён ли путь в настройках и запущено ли приложение. Загружен ли LISP,
 * узнать заранее нельзя — это выяснится по таймауту первого запроса.
 */
async function probe() {
  if (!config.acad.enabled) {
    return { available: false, reason: 'Мост AutoCAD выключен в настройках сервера (ACAD_ENABLED=0)' };
  }
  const dir = exchangeDir();
  try {
    await fsp.mkdir(path.join(dir, 'requests'), { recursive: true });
    await fsp.mkdir(path.join(dir, 'responses'), { recursive: true });
  } catch (err) {
    return { available: false, reason: `Папка обмена недоступна: ${err.message}` };
  }
  const running = await isAppRunning(config.acad.appName);
  if (!running) {
    return {
      available: false,
      reason: `Приложение «${config.acad.appName}» не запущено — DWG создать некому. ` +
        'Откройте AutoCAD, загрузите мост (APPLOAD → claude-acad-bridge.lsp) и повторите выгрузку.',
    };
  }
  return { available: true, reason: '' };
}

/**
 * Сколько окон у приложения — только для ПОДСКАЗКИ при таймауте.
 *
 * Мост живёт внутри документа: `acaddoc.lsp` выполняется при открытии чертежа,
 * и в пустом AutoCAD команду вводить некуда. Но заранее по этому признаку
 * отказывать нельзя: AutoCAD не всегда отдаёт свои окна System Events, и
 * рабочая выгрузка сорвалась бы по ложному поводу. Поэтому счёт окон только
 * уточняет причину, когда ответа и так не пришло.
 *
 * -1 — узнать не удалось; тогда подсказка не добавляется.
 */
function countWindows(appName) {
  return new Promise((resolve) => {
    const script = `tell application "System Events" to tell process "${appName}" to return count of windows`;
    execFile('osascript', ['-e', script], { timeout: 8000 }, (err, stdout) => {
      if (err) return resolve(-1);
      const n = parseInt(String(stdout).trim(), 10);
      resolve(Number.isFinite(n) ? n : -1);
    });
  });
}

function isAppRunning(appName) {
  return new Promise((resolve) => {
    // pgrep по имени процесса: AppleScript для проверки поднял бы приложение
    execFile('pgrep', ['-f', appName.replace(/\s+/g, '.*')], (err, stdout) => {
      resolve(!err && String(stdout).trim().length > 0);
    });
  });
}

class AcadClient {
  constructor() {
    this.dir = exchangeDir();
    this.appName = config.acad.appName;
    this.trigger = config.acad.trigger;
    this.timeoutMs = config.acad.timeoutMs;
    this.prefix = `enso${Date.now().toString(36)}`;
    this.seq = 0;
    // Последняя ошибка автотриггера: без неё отказ выглядел как «AutoCAD не
    // ответил», хотя на деле macOS не дала ввести команду в чужое окно.
    this.triggerError = '';
  }

  async request(method, params = {}, { signal } = {}) {
    const requests = path.join(this.dir, 'requests');
    const responses = path.join(this.dir, 'responses');
    await fsp.mkdir(requests, { recursive: true });
    await fsp.mkdir(responses, { recursive: true });

    this.seq += 1;
    const id = `${this.prefix}-${this.seq}`;
    const reqPath = path.join(requests, `req-${id}.json`);
    const resPath = path.join(responses, `res-${id}.json`);

    // Кириллица уходит \uXXXX: мост держит строки в кодовой странице чертежа
    // и разворачивает эскейпы сам — файл запроса остаётся чистым ASCII.
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params })
      .replace(/[\u0080-\uffff]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);
    await fsp.writeFile(`${reqPath}.tmp`, payload, 'utf8');
    await fsp.rename(`${reqPath}.tmp`, reqPath);

    if (this.trigger === 'auto') this.pump();

    const started = Date.now();
    const retriggers = [...RETRIGGER_AT_MS];
    for (;;) {
      if (signal && signal.aborted) {
        await fsp.rm(reqPath, { force: true });
        throw Object.assign(new Error('Выгрузка прервана'), { name: 'AbortError' });
      }
      const elapsed = Date.now() - started;
      if (elapsed > this.timeoutMs) {
        await fsp.rm(reqPath, { force: true }); // не оставляем «висящий» запрос
        // Ни одного окна — почти всегда значит «чертёж не открыт»: мост живёт
        // внутри документа, и вводить команду в пустой AutoCAD некуда.
        const noDocHint = (await countWindows(this.appName)) === 0
          ? ' Похоже, в AutoCAD не открыт ни один чертёж: мост загружается вместе с документом. ' +
            'Откройте любой чертёж и повторите выгрузку.'
          : '';
        throw new AcadUnavailableError(
          (this.triggerError
            // причина известна точно — не заставляем искать её среди пяти общих советов
            ? `AutoCAD не получил команду: ${this.triggerError}`
            : `AutoCAD не ответил за ${Math.round(this.timeoutMs / 1000)} с. ` +
              'Надёжнее всего включить режим сервера: введите CLAUDE-SERVE в командной строке ' +
              'AutoCAD и повторите выгрузку — платформа сама остановит его, когда закончит. ' +
              'Автоввод команды работает только при английской раскладке: при русской ' +
              'macOS печатает в AutoCAD не те буквы, и он ждёт команду, которой нет.'
          ) + noDocHint,
        );
      }
      if (this.trigger === 'auto' && retriggers.length && elapsed >= retriggers[0]) {
        retriggers.shift();
        this.pump();
      }
      let raw = null;
      try { raw = await fsp.readFile(resPath, 'utf8'); } catch { /* ответа ещё нет */ }
      if (raw && raw.trim()) {
        await fsp.rm(resPath, { force: true });
        return parseResponse(raw, method);
      }
      await delay(POLL_INTERVAL_MS);
    }
  }

  /**
   * Активирует AutoCAD и вводит CLAUDE-PUMP. Ошибка триггера не фатальна.
   *
   * Команда НЕ печатается буквами: `keystroke "CLAUDE-PUMP"` пропускает текст
   * через текущую раскладку, и при русской в AutoCAD прилетает «CLфффф-ффMфг».
   * Мост такой команды не знает, запрос висит до таймаута, а со стороны это
   * выглядит как «AutoCAD не отвечает» — и воспроизводится через раз, потому
   * что зависит от того, какая раскладка была включена в этот момент.
   * Поэтому команда кладётся в буфер обмена и вставляется через ⌘V: сочетания
   * с Command macOS сопоставляет по физической клавише, раскладка им не важна.
   * Прежнее содержимое буфера возвращается на место.
   */
  pump() {
    // Русская раскладка превращает CLAUDE-PUMP в мусор ещё до AutoCAD.
    // Печатать вслепую бессмысленно: лучше сразу назвать причину.
    const layout = currentKeyboardLayout();
    if (layout && !LATIN_LAYOUT_RE.test(layout)) {
      this.triggerError = 'включена нелатинская раскладка клавиатуры ' +
        `(${layout.replace(/^com\.apple\.keylayout\./, '')}), и macOS печатает в AutoCAD не те буквы. ` +
        'Переключите раскладку на английскую и повторите выгрузку — либо введите CLAUDE-SERVE ' +
        'в командной строке AutoCAD, тогда клавиатура не нужна вовсе.';
      return;
    }
    const script = [
      // текстовый буфер сохраняем; на картинке в буфере `the clipboard as text`
      // бросит ошибку — тогда просто не восстанавливаем, работа важнее
      'set savedClip to missing value',
      'try',
      '  set savedClip to (the clipboard as text)',
      'end try',
      'set the clipboard to "CLAUDE-PUMP"',
      `tell application "${this.appName}" to activate`,
      'delay 0.3',
      'tell application "System Events"',
      '  key code 53',
      '  key code 53',
      '  keystroke "v" using command down',
      '  delay 0.1',
      '  key code 36',
      'end tell',
      'delay 0.2',
      'if savedClip is not missing value then set the clipboard to savedClip',
    ].join('\n');
    execFile('osascript', ['-e', script], (err, stdout, stderr) => {
      if (!err) { this.triggerError = ''; return; }
      const raw = String(stderr || err.message);
      // 1002 — macOS запретила процессу отправлять нажатия клавиш. Это не
      // «AutoCAD занят», а невыданное разрешение, и чинится оно в одном месте.
      this.triggerError = /\(-?1002\)|not allowed to send keystrokes|нажатий клавиш/i.test(raw)
        ? 'macOS не разрешает вводить команды в чужое окно. Системные настройки → ' +
          'Конфиденциальность и безопасность → Универсальный доступ: включите программу, ' +
          'из которой запущен сервер (Терминал или Claude Code). Либо переведите мост в ручной ' +
          'режим (ACAD_TRIGGER=manual) и вводите CLAUDE-PUMP в AutoCAD сами.'
        : `автотриггер CLAUDE-PUMP не сработал: ${raw.trim().slice(0, 200)}`;
      console.warn('[acad] триггер CLAUDE-PUMP не сработал:', raw.trim().slice(0, 300));
    });
  }
}

function parseResponse(raw, method) {
  let message;
  try {
    message = JSON.parse(raw);
  } catch {
    throw new AcadRpcError(-32700, `Мост вернул невалидный JSON на «${method}»: ${raw.slice(0, 200)}`);
  }
  if (message.error) throw new AcadRpcError(message.error.code, message.error.message);
  return message.result;
}

/* ---------------- спецификация → команды моста ---------------- */

/**
 * Спецификация превращается в поток команд. Порядок важен: слои создаются
 * первыми, иначе сущность уедет на текущий слой и потеряет цвет.
 */
function toCommands(spec) {
  const commands = [];
  for (const layer of spec.layers || []) {
    commands.push({
      method: 'create_layer',
      params: { name: layer.name, color: layer.color, linetype: layer.linetype || 'Continuous' },
    });
  }
  for (const e of spec.entities || []) {
    if (e.type === 'polyline' && e.points && e.points.length >= 2) {
      commands.push({
        method: 'create_polyline',
        params: {
          layer: e.layer, closed: !!e.closed, width_mm: e.width || 0,
          points: e.points.map(([x, y]) => ({ x, y })),
        },
      });
    } else if (e.type === 'hatch' && e.boundary && e.boundary.length >= 3) {
      // угол и шаг берутся из общего места со writer'ом DXF: два пути одного
      // комплекта обязаны получить одни и те же параметры образца
      const params = planSpec.hatchParams(e);
      const holes = (e.holes || []).filter((h) => h && h.length >= 3)
        .map((h) => h.map(([x, y]) => ({ x, y })));
      commands.push({
        // Штатный create_hatch моста заливает ОДИН контур, и кольцевая зона
        // отступа закрашивалась целиком. Отверстия умеет create_hatch_holes
        // из scripts/enso-acad-export.lsp; если его не загрузили, вызов
        // откатывается на штатную команду — с оговоркой в предупреждениях.
        method: holes.length ? 'create_hatch_holes' : 'create_hatch',
        fallback: holes.length ? 'create_hatch' : null,
        params: {
          layer: e.layer,
          pattern: params.pattern,
          // масштаб образца задаётся шагом штриховки в метрах чертежа
          scale: params.scale,
          angle_deg: params.angle,
          keep_boundary: false,   // контур уже нарисован отдельной полилинией
          boundary_points: e.boundary.map(([x, y]) => ({ x, y })),
          holes,
        },
      });
    } else if (e.type === 'text' && e.point) {
      commands.push({
        method: 'create_text',
        params: {
          layer: e.layer, text: e.text, align: e.align === 'center' ? 'center' : 'left',
          insertion: { x: e.point[0], y: e.point[1] },
          height_mm: e.height || 1,
          rotation_deg: e.rotation || 0,
        },
      });
    }
  }
  return commands;
}

/**
 * Построить чертёж в AutoCAD и выгрузить его в DWG.
 *
 * @param {object} spec      спецификация из plan-spec.build
 * @param {string} dwgPath   куда записать DWG (файл будет перезаписан)
 * @param {function} onStep  колбэк прогресса (сделано, всего)
 * @returns {{path:string, entities:number, warnings:string[]}}
 */
async function exportDwg(spec, dwgPath, { onStep = null, signal = null } = {}) {
  const check = await probe();
  if (!check.available) throw new AcadUnavailableError(check.reason);

  const client = new AcadClient();
  const commands = toCommands(spec);
  const handles = [];
  const warnings = [];

  try {
    for (let i = 0; i < commands.length; i++) {
      const { method, params, fallback } = commands[i];
      let result;
      try {
        result = await client.request(method, params, { signal });
      } catch (err) {
        // Мост старой сборки не знает расширенных команд. Терять из-за этого
        // весь чертёж нельзя: строим тем, что он умеет, и говорим, чего лишились.
        if (!fallback || !(err instanceof AcadRpcError) || err.code !== -32601) throw err;
        const note = 'Мост AutoCAD не знает команду «' + method + '»: зона с вырезом залита целиком. ' +
          'Загрузите scripts/enso-acad-export.lsp через APPLOAD, чтобы кольцевые зоны рисовались верно.';
        if (!warnings.includes(note)) warnings.push(note);
        result = await client.request(fallback, params, { signal });
      }
      for (const h of (result && result.created_handles) || []) handles.push(h);
      for (const w of (result && result.warnings) || []) {
        if (!warnings.includes(w)) warnings.push(w);
      }
      if (onStep) onStep(i + 1, commands.length + 1);
    }
    if (!handles.length) {
      throw new AcadRpcError(-32003, 'AutoCAD не создал ни одной сущности — выгружать нечего');
    }

    // -WBLOCK спросил бы о замене существующего файла, а отвечать в пакетном
    // режиме некому: убираем файл заранее
    await fsp.rm(dwgPath, { force: true });
    const exported = await client.request('export_dwg', { path: dwgPath, handles }, { signal });
    if (onStep) onStep(commands.length + 1, commands.length + 1);
    return {
      path: dwgPath,
      entities: (exported && exported.exported_count) || handles.length,
      warnings,
    };
  } finally {
    // чертёж пользователя обязан остаться таким, каким был
    if (handles.length) {
      try {
        await client.request('delete_entities', { handles });
      } catch (err) {
        console.warn('[acad] временные сущности не удалены:', err.message);
      }
    }
    // Режим сервера блокирует AutoCAD на всё своё окно ожидания. Работа
    // закончена — отпускаем приложение сразу, а не держим человека ещё
    // несколько минут в застывшем окне.
    await releaseServeMode();
  }
}

/**
 * Останавливает режим сервера моста (CLAUDE-SERVE) флагом STOP в папке обмена.
 *
 * Режим сервера — единственный способ работать без клавиатуры: при русской
 * раскладке AppleScript не может напечатать «CLAUDE-PUMP» (в AutoCAD прилетает
 * мусор вроде «CLфффф-ффMфг»), и автотриггер бесполезен. Зато пока цикл
 * крутится, AutoCAD не отвечает на действия человека — поэтому выключаем его
 * при первой же возможности.
 */
async function releaseServeMode() {
  try {
    await fsp.writeFile(path.join(exchangeDir(), 'STOP'), '');
  } catch { /* нет папки обмена — значит и останавливать нечего */ }
}

/**
 * Запасной путь без AutoCAD: конвертер LibreDWG.
 *
 * Он не всегда сохраняет кириллические имена слоёв (зависит от кодовой
 * страницы исходного DXF), поэтому применяется только когда AutoCAD закрыт,
 * и результат помечается в описании файла как «получен конвертером».
 */
function convertDxfToDwg(dxfPath, dwgPath) {
  return new Promise((resolve, reject) => {
    execFile('dxf2dwg', ['-y', '--as', 'r2000', '-o', dwgPath, dxfPath], (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`Конвертер dxf2dwg не справился: ${String(stderr || err.message).slice(0, 300)}`));
        return;
      }
      if (!fs.existsSync(dwgPath)) {
        reject(new Error('Конвертер dxf2dwg завершился, но файл не появился'));
        return;
      }
      resolve({ path: dwgPath, converter: 'libredwg' });
    });
  });
}

module.exports = {
  probe, exportDwg, convertDxfToDwg, toCommands, exchangeDir,
  AcadUnavailableError, AcadRpcError,
};
