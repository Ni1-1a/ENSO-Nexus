#!/usr/bin/env bash
# ENSO Nexus Pilot 1 — ПОЛНЫЙ ПЕРЕЗАПУСК (сервер + туннель + watchdog).
# Двойной клик по этому файлу открывает Терминал и выполняет перезапуск.
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
cd "$(dirname "$0")/.."

echo "════════════════════════════════════════════════"
echo "  ENSO Nexus Pilot 1 — перезапуск сервера"
echo "════════════════════════════════════════════════"
echo

# Предупредить, если прямо сейчас выполняется анализ (перезапуск его прервёт)
BUSY=$(node -e '
const { DatabaseSync } = require("node:sqlite");
try {
  const db = new DatabaseSync("data/app.db", { readOnly: true });
  console.log(db.prepare("SELECT COUNT(*) c FROM sessions WHERE job_status IN (\x27queued\x27,\x27running\x27)").get().c);
} catch { console.log(0); }' 2>/dev/null || echo 0)
if [ "$BUSY" != "0" ]; then
  echo "⚠  Сейчас выполняется задач: $BUSY — перезапуск ПРЕРВЁТ их."
  read -r -p "Всё равно перезапустить? (y/N) " a
  if [ "$a" != "y" ] && [ "$a" != "Y" ]; then
    echo "Отменено."
    read -n 1 -s -r -p "Нажмите любую клавишу, чтобы закрыть…" || true
    exit 0
  fi
fi

bash scripts/serve-public.sh stop
sleep 2
bash scripts/serve-public.sh
echo
echo "Проверка… "
sleep 3
if curl -s -m 10 -o /dev/null http://localhost:3000/api/health; then
  echo "✓ Сервер работает. Адрес: https://app.enso-nexus.ru"
else
  echo "✗ Сервер не ответил — посмотрите logs/server.log"
fi
echo
read -n 1 -s -r -p "Нажмите любую клавишу, чтобы закрыть окно…" || true
echo
