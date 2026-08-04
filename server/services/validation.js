'use strict';
const path = require('path');
const config = require('../config');

/** Sanitize a user-supplied file name: strip paths, control chars, limit length. */
function sanitizeFilename(name) {
  const base = path.basename(String(name || 'file'))
    .replace(/[\x00-\x1f<>:"\/\\|?*]/g, '_')
    .replace(/^\.+/, '_')
    .trim();
  const cut = base.length > 120 ? base.slice(-120) : base;
  return cut || 'file';
}

function extOf(name) {
  return path.extname(String(name || '')).slice(1).toLowerCase();
}

/** Magic-byte / content check — extension alone is not trusted. */
function checkMagic(ext, buf) {
  if (!buf || buf.length === 0) return { ok: false, reason: 'Файл пуст' };
  const head = buf.subarray(0, 16);
  const ascii = head.toString('latin1');
  switch (ext) {
    case 'pdf':
      return ascii.startsWith('%PDF') ? { ok: true } : { ok: false, reason: 'Файл не является PDF' };
    case 'dwg':
      return ascii.startsWith('AC10') || ascii.startsWith('AC2') || ascii.startsWith('AC6')
        ? { ok: true } : { ok: false, reason: 'Файл не является DWG' };
    case 'docx': {
      const zip = head[0] === 0x50 && head[1] === 0x4b;
      return zip ? { ok: true } : { ok: false, reason: 'Файл не является DOCX' };
    }
    case 'png':
      return head[0] === 0x89 && ascii.slice(1, 4) === 'PNG' ? { ok: true } : { ok: false, reason: 'Файл не является PNG' };
    case 'jpg':
    case 'jpeg':
      return head[0] === 0xff && head[1] === 0xd8 ? { ok: true } : { ok: false, reason: 'Файл не является JPEG' };
    case 'dxf':
    case 'txt':
    case 'md':
    case 'csv':
    case 'json': {
      // must look like text: no NUL bytes in first 4 KB
      const probe = buf.subarray(0, 4096);
      for (let i = 0; i < probe.length; i++) {
        if (probe[i] === 0) return { ok: false, reason: 'Файл не является текстовым' };
      }
      if (ext === 'json') {
        try { JSON.parse(buf.toString('utf8')); } catch { return { ok: false, reason: 'Некорректный JSON' }; }
      }
      return { ok: true };
    }
    default:
      return { ok: false, reason: `Формат .${ext} не поддерживается` };
  }
}

function validateUpload({ originalName, buffer }, sessionFiles) {
  const ext = extOf(originalName);
  if (!config.allowedExtensions.includes(ext)) {
    return { ok: false, error: `Формат .${ext || '?'} не поддерживается. Разрешены: ${config.allowedExtensions.join(', ')}` };
  }
  if (buffer.length > config.maxFileSizeBytes) {
    return { ok: false, error: `Файл больше ${Math.round(config.maxFileSizeBytes / 1048576)} МБ` };
  }
  if (sessionFiles.length >= config.maxFilesPerSession) {
    return { ok: false, error: `В сессии не может быть больше ${config.maxFilesPerSession} файлов` };
  }
  const total = sessionFiles.reduce((s, f) => s + f.size, 0) + buffer.length;
  if (total > config.maxTotalUploadBytes) {
    return { ok: false, error: `Суммарный объём загрузки превышает ${Math.round(config.maxTotalUploadBytes / 1048576)} МБ` };
  }
  const magic = checkMagic(ext, buffer);
  if (!magic.ok) return { ok: false, error: magic.reason };
  return { ok: true, ext };
}

module.exports = { sanitizeFilename, extOf, checkMagic, validateUpload };
