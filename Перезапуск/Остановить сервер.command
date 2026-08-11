#!/usr/bin/env bash
# ENSO Nexus Pilot 1 — ПОЛНАЯ ОСТАНОВКА (сервер, туннель, watchdog).
# Приложение станет недоступно, пока не запустите снова.
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
cd "$(dirname "$0")/.."

echo "════════════════════════════════════════════════"
echo "  ENSO Nexus Pilot 1 — остановка сервера"
echo "════════════════════════════════════════════════"
echo
bash scripts/serve-public.sh stop
echo
echo "Остановлено. Запустить снова — «Запустить сервер.command»."
echo
read -n 1 -s -r -p "Нажмите любую клавишу, чтобы закрыть окно…" || true
echo
