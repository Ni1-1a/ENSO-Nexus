#!/usr/bin/env bash
# ENSO Nexus Pilot 1 — публичный запуск с этого компьютера (самовосстанавливающийся).
# Сервер приложения + бесплатный туннель Cloudflare + watchdog: при падении сервера
# или туннеля всё перезапускается само, постоянная ссылка (GitHub Pages) обновляется.
#
# Запуск:    bash scripts/serve-public.sh
# Остановка: bash scripts/serve-public.sh stop
set -u
cd "$(dirname "$0")/.."
mkdir -p logs

start_server() {
  # caffeinate -i: Mac не уходит в сон, пока работает сервер (крышку не закрывать)
  caffeinate -i npm start >> logs/server.log 2>&1 &
  echo $! > logs/server.pid
}

start_tunnel() {
  : > logs/tunnel.log
  cloudflared tunnel --url http://localhost:3000 --no-autoupdate >> logs/tunnel.log 2>&1 &
  echo $! > logs/tunnel.pid
  local url=""
  for _ in $(seq 1 30); do
    sleep 1
    url=$(grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' logs/tunnel.log | head -1 || true)
    [ -n "$url" ] && break
  done
  if [ -n "$url" ]; then
    echo "$url" > logs/public-url.txt
    bash scripts/update-public-link.sh >> logs/watchdog.log 2>&1 || true
  fi
  echo "$url"
}

stop_all() {
  for f in watchdog.pid server.pid tunnel.pid; do
    [ -f "logs/$f" ] && kill "$(cat "logs/$f")" 2>/dev/null
    rm -f "logs/$f"
  done
  rm -f logs/pids logs/public-url.txt
}

if [ "${1:-start}" = "stop" ]; then
  stop_all
  echo "Остановлено."
  exit 0
fi

if [ -f logs/server.pid ] && kill -0 "$(cat logs/server.pid)" 2>/dev/null; then
  echo "Уже запущено. Текущий адрес: $(cat logs/public-url.txt 2>/dev/null || echo '—')"
  echo "Постоянная ссылка: https://ni1-1a.github.io/ENSO-Nexus/"
  exit 0
fi

start_server
URL=$(start_tunnel)
if [ -z "$URL" ]; then
  echo "Не удалось получить URL туннеля — см. logs/tunnel.log"
  exit 1
fi
echo "Приложение опубликовано: $URL"
echo "Постоянная ссылка (не меняется): https://ni1-1a.github.io/ENSO-Nexus/"

# watchdog: каждую минуту проверяет сервер и туннель, чинит упавшее
(
  while true; do
    sleep 60
    if ! curl -s -m 5 -o /dev/null http://localhost:3000/api/health; then
      echo "$(date '+%F %T') сервер недоступен — перезапуск" >> logs/watchdog.log
      kill "$(cat logs/server.pid 2>/dev/null)" 2>/dev/null
      start_server
      sleep 8
    fi
    url=$(cat logs/public-url.txt 2>/dev/null || true)
    ok=0
    for _ in 1 2; do
      curl -s -m 10 -o /dev/null "$url/api/health" && { ok=1; break; }
      sleep 5
    done
    if [ "$ok" = 0 ]; then
      echo "$(date '+%F %T') туннель недоступен — перезапуск" >> logs/watchdog.log
      kill "$(cat logs/tunnel.pid 2>/dev/null)" 2>/dev/null
      start_tunnel >> logs/watchdog.log
    fi
  done
) > /dev/null 2>&1 &
echo $! > logs/watchdog.pid
