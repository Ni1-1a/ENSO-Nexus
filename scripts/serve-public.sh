#!/usr/bin/env bash
# ENSO Nexus Pilot 1 — публичный запуск с этого компьютера.
# Поднимает сервер приложения и бесплатный туннель Cloudflare (без аккаунта),
# не даёт Mac уснуть, пишет публичный URL в logs/public-url.txt.
#
# Запуск:   bash scripts/serve-public.sh
# Остановка: bash scripts/serve-public.sh stop
set -u
cd "$(dirname "$0")/.."
mkdir -p logs

if [[ "${1:-}" == "stop" ]]; then
  [[ -f logs/pids ]] && kill $(cat logs/pids) 2>/dev/null
  rm -f logs/pids logs/public-url.txt
  echo "Остановлено."
  exit 0
fi

# уже запущено?
if [[ -f logs/pids ]] && kill -0 $(cut -d' ' -f1 logs/pids) 2>/dev/null; then
  echo "Уже запущено. Публичный URL: $(cat logs/public-url.txt 2>/dev/null || echo '…см. logs/tunnel.log')"
  exit 0
fi

# caffeinate -i: Mac не уходит в сон, пока работает сервер (крышку не закрывать)
caffeinate -i npm start > logs/server.log 2>&1 &
SERVER_PID=$!
cloudflared tunnel --url http://localhost:3000 --no-autoupdate > logs/tunnel.log 2>&1 &
TUNNEL_PID=$!
echo "$SERVER_PID $TUNNEL_PID" > logs/pids

URL=""
for _ in $(seq 1 30); do
  sleep 1
  URL=$(grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' logs/tunnel.log | head -1 || true)
  [[ -n "$URL" ]] && break
done

if [[ -z "$URL" ]]; then
  echo "Не удалось получить URL туннеля — см. logs/tunnel.log"
  exit 1
fi
echo "$URL" > logs/public-url.txt
echo "Приложение опубликовано: $URL"
echo "(URL меняется при каждом перезапуске туннеля; сервер работает, пока включён этот компьютер)"
