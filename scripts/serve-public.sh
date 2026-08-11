#!/usr/bin/env bash
# ENSO Nexus Pilot 1 — публичный запуск с этого компьютера (самовосстанавливающийся).
# Сервер приложения + ИМЕННОЙ туннель Cloudflare (enso-nexus, постоянный адрес
# https://app.enso-nexus.ru) + watchdog: при падении сервера или туннеля всё
# перезапускается само. Конфиг туннеля: ~/.cloudflared/config.yml.
#
# Запуск:    bash scripts/serve-public.sh
# Остановка: bash scripts/serve-public.sh stop
set -u
cd "$(dirname "$0")/.."
mkdir -p logs

PUBLIC_URL="https://app.enso-nexus.ru"

start_server() {
  # caffeinate -i: Mac не уходит в сон, пока работает сервер (крышку не закрывать)
  caffeinate -i npm start >> logs/server.log 2>&1 &
  echo $! > logs/server.pid
}

start_tunnel() {
  : > logs/tunnel.log
  cloudflared tunnel run enso-nexus >> logs/tunnel.log 2>&1 &
  echo $! > logs/tunnel.pid
  local ok=""
  for _ in $(seq 1 30); do
    sleep 1
    grep -q 'Registered tunnel connection' logs/tunnel.log && { ok=1; break; }
  done
  if [ -n "$ok" ]; then
    echo "$PUBLIC_URL" > logs/public-url.txt
    bash scripts/update-public-link.sh >> logs/watchdog.log 2>&1 || true
  fi
  [ -n "$ok" ] && echo "$PUBLIC_URL"
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
  echo "Уже запущено. Адрес: $PUBLIC_URL (также enso-nexus.ru)"
  exit 0
fi

start_server
URL=$(start_tunnel)
if [ -z "$URL" ]; then
  echo "Не удалось подключить туннель — см. logs/tunnel.log"
  exit 1
fi
echo "Приложение опубликовано: $URL (также https://enso-nexus.ru)"
echo "Старая ссылка https://ni1-1a.github.io/ENSO-Nexus/ перенаправляет туда же"

# watchdog: каждую минуту проверяет сервер и туннель, чинит упавшее
# (сервер перезапускается только после ДВУХ подряд неудачных проверок — под пиковой
# нагрузкой LM Studio машина может коротко «замирать», рестарт убил бы активную задачу)
(
  server_fails=0
  while true; do
    sleep 60
    if curl -s -m 10 -o /dev/null http://localhost:3000/api/health; then
      server_fails=0
    else
      server_fails=$((server_fails + 1))
      if [ "$server_fails" -ge 2 ]; then
        echo "$(date '+%F %T') сервер недоступен (${server_fails} проверки) — перезапуск" >> logs/watchdog.log
        kill "$(cat logs/server.pid 2>/dev/null)" 2>/dev/null
        start_server
        server_fails=0
        sleep 8
      fi
    fi
    # именной туннель сам держит 4 резервных соединения — чиним только мёртвый процесс
    # (проверка по публичному URL убрана: при задержках DNS/сети она убивала живой туннель)
    if ! kill -0 "$(cat logs/tunnel.pid 2>/dev/null)" 2>/dev/null; then
      echo "$(date '+%F %T') процесс туннеля умер — перезапуск" >> logs/watchdog.log
      start_tunnel >> logs/watchdog.log
    fi
  done
) > /dev/null 2>&1 &
echo $! > logs/watchdog.pid
