'use strict';
/**
 * Защита от zip-бомб в docx/xlsx: adm-zip распаковывает запись целиком по
 * первому getData(), а cut() режет строку уже ПОСЛЕ. document.xml, сжатый
 * 1000:1, из 40-мегабайтного файла давал строку на гигабайты и валил процесс.
 * Заявленный в заголовке размер известен до распаковки — им и ограничиваемся.
 */
const config = require('../config');

/** Данные записи архива, если её заявленный размер в пределах ZIP_ENTRY_MB; иначе 422. */
function entryData(entry, what = 'Документ') {
  const size = entry && entry.header ? Number(entry.header.size) || 0 : 0;
  if (size > config.zipEntryBytes) {
    const err = new Error(`${what}: содержимое архива слишком велико при распаковке — `
      + `${Math.ceil(size / 1048576)} МБ при пределе ${Math.round(config.zipEntryBytes / 1048576)} МБ`);
    err.status = 422;
    throw err;
  }
  return entry.getData();
}

module.exports = { entryData };
