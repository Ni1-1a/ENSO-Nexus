#!/usr/bin/env bash
# Резервная копия Enso-nexus: база SQLite (согласованная копия через VACUUM INTO,
# сервер останавливать не нужно), users.json, PostgreSQL нормоконтроля (pg_dump),
# загрузки и результаты сессий, файлы нормоконтроля. Хранятся ВСЕ копии — скрипт
# ничего не удаляет (решение владельца 02.09.2026); место на диске — ваша забота.
#
#   ./scripts/backup.sh                 # копия в ./backups/<дата-время>/
#   BACKUP_DIR=/opt/enso-backups ./scripts/backup.sh
#   SKIP_PG=1 ./scripts/backup.sh       # без Postgres (нет pg_dump или базы)
#
# Переменные, как у сервера: DATA_DIR, USERS_FILE, NORMO_DATABASE_URL, NORMO_DATA_DIR.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DATA_DIR="${DATA_DIR:-$ROOT/data}"
USERS_FILE="${USERS_FILE:-$ROOT/users.json}"
NORMO_DATA_DIR="${NORMO_DATA_DIR:-$DATA_DIR/normo}"
NORMO_DATABASE_URL="${NORMO_DATABASE_URL:-postgresql://127.0.0.1:5433/enso_normo}"
BACKUP_DIR="${BACKUP_DIR:-$ROOT/backups}"
STAMP="$(date +%Y%m%d-%H%M%S)"
DEST="$BACKUP_DIR/$STAMP"
umask 077
mkdir -p "$DEST"
chmod 700 "$BACKUP_DIR" "$DEST" 2>/dev/null || true

# SQLite: VACUUM INTO даёт целостную копию при работающем сервере (WAL учитывается)
if [ -f "$DATA_DIR/app.db" ]; then
  node -e "const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(process.argv[1], { readOnly: true }); db.exec(\"VACUUM INTO '\" + process.argv[2].replace(/'/g, \"''\") + \"'\"); db.close();" "$DATA_DIR/app.db" "$DEST/app.db"
  echo "app.db: $(du -h "$DEST/app.db" | cut -f1)"
else
  echo "app.db не найден в $DATA_DIR — пропуск"
fi

# люди платформы
if [ -f "$USERS_FILE" ]; then cp -p "$USERS_FILE" "$DEST/users.json"; echo "users.json: скопирован"; fi

# нормоконтроль: PostgreSQL + файлы
if [ "${SKIP_PG:-0}" != "1" ]; then
  if command -v pg_dump >/dev/null 2>&1; then
    if pg_dump "$NORMO_DATABASE_URL" -Fc -f "$DEST/enso_normo.dump" 2>"$DEST/pg_dump.err"; then
      rm -f "$DEST/pg_dump.err"; echo "enso_normo.dump: $(du -h "$DEST/enso_normo.dump" | cut -f1)"
    else
      echo "pg_dump не удался — см. $DEST/pg_dump.err"
    fi
  else
    echo "pg_dump не установлен — база нормоконтроля не скопирована"
  fi
fi
if [ -d "$NORMO_DATA_DIR" ]; then tar -czf "$DEST/normo-files.tgz" -C "$(dirname "$NORMO_DATA_DIR")" "$(basename "$NORMO_DATA_DIR")"; echo "normo-files.tgz: $(du -h "$DEST/normo-files.tgz" | cut -f1)"; fi

# загрузки, результаты, архив прогонов, файлы проверок документов
PARTS=()
for d in uploads outputs archive doccheck; do [ -d "$DATA_DIR/$d" ] && PARTS+=("$d"); done
if [ "${#PARTS[@]}" -gt 0 ]; then tar -czf "$DEST/data-files.tgz" -C "$DATA_DIR" "${PARTS[@]}"; echo "data-files.tgz: $(du -h "$DEST/data-files.tgz" | cut -f1)"; fi

chmod 600 "$DEST"/* 2>/dev/null || true
echo "Копия готова: $DEST"
