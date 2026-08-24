#!/usr/bin/env bash
# Очередь VLM-OCR документов базы знаний.
# Формат заданий (TSV): <папка-документа> \t <путь к PDF> \t <страницы, напр. 1-101>
# Возобновляемая: уже распознанные страницы пропускаются, порядок — из файла заданий.
# По завершении всех документов — автоматическая переиндексация базы.
#
# Запуск:   nohup bash scripts/kb-ocr-queue.sh > /dev/null 2>&1 &
# Прогресс: tail -f logs/kb-ocr-queue.log
set -u
cd "$(dirname "$0")/.."
JOBS="${1:-scripts/kb-ocr-jobs.tsv}"
LOG=logs/kb-ocr-queue.log
mkdir -p logs

echo "$(date '+%F %T') ЗАПУСК ОЧЕРЕДИ ($(grep -cv '^#' "$JOBS" 2>/dev/null || echo '?') заданий)" >> "$LOG"
while IFS=$'\t' read -r doc pdf pages; do
  [ -z "${doc:-}" ] && continue
  case "$doc" in \#*) continue ;; esac
  echo "$(date '+%F %T') === $doc (стр. $pages) ===" >> "$LOG"
  node --env-file-if-exists=.env scripts/kb-vlm-ocr.js --doc "$doc" --pdf "$pdf" --pages "$pages" >> "$LOG" 2>&1 \
    || echo "$(date '+%F %T') !!! ошибка на «$doc» — очередь продолжается" >> "$LOG"
done < "$JOBS"

# Переиндексация по завершении — не всегда: пока идёт переразбивка базы, чанки
# пересобираются из НОВОЙ структуры, и индекс по старой только сбивает поиск.
if [ "${KB_OCR_REINDEX:-1}" = "1" ]; then
  echo "$(date '+%F %T') === ФИНАЛЬНАЯ ПЕРЕИНДЕКСАЦИЯ ===" >> "$LOG"
  npm run kb:index >> "$LOG" 2>&1
else
  echo "$(date '+%F %T') === переиндексация пропущена (KB_OCR_REINDEX=0) ===" >> "$LOG"
fi
echo "$(date '+%F %T') === ОЧЕРЕДЬ ЗАВЕРШЕНА ===" >> "$LOG"
