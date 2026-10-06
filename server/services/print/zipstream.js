'use strict';
/**
 * Потоковый ZIP без сжатия (STORE) — «Скачать всё (ZIP)» (А5).
 *
 * adm-zip собирает архив в памяти и для 400 МБ пакетов не годится, а PDF всё
 * равно не жмутся. Здесь архив пишется прямо в ответ: локальный заголовок →
 * байты файла → дескриптор данных (CRC и размеры известны только после
 * прохода, флаг 3) → центральный каталог. Временного файла на диске нет.
 * ZIP64 включается, когда размер записи или смещение не помещаются в 32 бита
 * (пакеты комплекта могут весить больше 4 ГБ). CRC32 считает node:zlib.
 *
 * Новых зависимостей нет: npm install на VPS из-за этого не нужен.
 */
const fs = require('fs');
const zlib = require('zlib');

const ZIP64_LIMIT = 0xFFFFFFFF;

function dosTime(d) {
  const t = ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | ((d.getSeconds() >> 1) & 31);
  const dt = (((d.getFullYear() - 1980) & 127) << 9) | (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31);
  return { t, d: dt };
}

function u16(n) { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; }
function u32(n) { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; }
function u64(n) { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; }

/**
 * entries: [{ name (UTF-8), path, size, mtime }]. Пишет в writable (res) и
 * резолвится по завершении. Прерванный клиент останавливает чтение файла.
 */
function streamZip(writable, entries, { onAbort } = {}) {
  return new Promise((resolve, reject) => {
    let offset = 0;
    const central = [];
    let aborted = false;
    const fail = (err) => { if (!aborted) { aborted = true; if (onAbort) onAbort(err); reject(err); } };
    writable.on('close', () => { if (!writable.writableFinished) fail(new Error('клиент оборвал скачивание')); });
    writable.on('error', fail);

    const write = (buf) => new Promise((res) => {
      offset += buf.length;
      if (writable.write(buf)) res(); else writable.once('drain', res);
    });

    (async () => {
      for (const e of entries) {
        const name = Buffer.from(e.name, 'utf8');
        const { t, d } = dosTime(e.mtime || new Date());
        const big = e.size >= ZIP64_LIMIT || offset >= ZIP64_LIMIT;
        const localOffset = offset;
        // локальный заголовок: размеры и CRC нули (флаг 3), ZIP64-extra при нужде
        const extra = big ? Buffer.concat([u16(0x0001), u16(16), u64(0), u64(0)]) : Buffer.alloc(0);
        await write(Buffer.concat([
          u32(0x04034b50), u16(big ? 45 : 20), u16(0x0808), u16(0), u16(t), u16(d),
          u32(0), u32(big ? ZIP64_LIMIT : 0), u32(big ? ZIP64_LIMIT : 0), u16(name.length), u16(extra.length), name, extra,
        ]));
        let crc = 0;
        let size = 0;
        await new Promise((res, rej) => {
          const rs = fs.createReadStream(e.path);
          rs.on('data', (chunk) => {
            crc = zlib.crc32(chunk, crc);
            size += chunk.length;
            offset += chunk.length;
            if (!writable.write(chunk)) { rs.pause(); writable.once('drain', () => rs.resume()); }
          });
          rs.on('end', res);
          rs.on('error', rej);
          writable.once('close', () => rs.destroy());
        });
        if (aborted) return;
        // дескриптор данных
        await write(big
          ? Buffer.concat([u32(0x08074b50), u32(crc), u64(size), u64(size)])
          : Buffer.concat([u32(0x08074b50), u32(crc), u32(size), u32(size)]));
        central.push({ name, t, d, crc, size, localOffset, big: big || localOffset >= ZIP64_LIMIT });
      }
      const cdStart = offset;
      for (const c of central) {
        const z64 = c.size >= ZIP64_LIMIT || c.localOffset >= ZIP64_LIMIT;
        const extra = z64 ? Buffer.concat([u16(0x0001), u16(24), u64(c.size), u64(c.size), u64(c.localOffset)]) : Buffer.alloc(0);
        await write(Buffer.concat([
          u32(0x02014b50), u16(z64 ? 45 : 20), u16(z64 ? 45 : 20), u16(0x0808), u16(0), u16(c.t), u16(c.d),
          u32(c.crc), u32(z64 ? ZIP64_LIMIT : c.size), u32(z64 ? ZIP64_LIMIT : c.size),
          u16(c.name.length), u16(extra.length), u16(0), u16(0), u16(0), u32(0), u32(z64 ? ZIP64_LIMIT : c.localOffset), c.name, extra,
        ]));
      }
      const cdSize = offset - cdStart;
      const needZip64 = central.length >= 0xFFFF || cdStart >= ZIP64_LIMIT || cdSize >= ZIP64_LIMIT || central.some((c) => c.big);
      if (needZip64) {
        const eocd64Offset = offset;
        await write(Buffer.concat([
          u32(0x06064b50), u64(44), u16(45), u16(45), u32(0), u32(0),
          u64(central.length), u64(central.length), u64(cdSize), u64(cdStart),
        ]));
        await write(Buffer.concat([u32(0x07064b50), u32(0), u64(eocd64Offset), u32(1)]));
      }
      await write(Buffer.concat([
        u32(0x06054b50), u16(0), u16(0),
        u16(Math.min(central.length, 0xFFFF)), u16(Math.min(central.length, 0xFFFF)),
        u32(Math.min(cdSize, ZIP64_LIMIT)), u32(Math.min(cdStart, ZIP64_LIMIT)), u16(0),
      ]));
      writable.end();
      resolve({ entries: central.length, bytes: offset });
    })().catch(fail);
  });
}

module.exports = { streamZip };
