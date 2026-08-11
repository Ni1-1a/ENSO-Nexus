#!/usr/bin/env bash
# ENSO Nexus Pilot 1 — ЗАПУСК (например, после перезагрузки Mac).
# Если всё уже запущено — просто скажет об этом, ничего не сломает.
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
cd "$(dirname "$0")/.."

echo "════════════════════════════════════════════════"
echo "  ENSO Nexus Pilot 1 — запуск сервера"
echo "════════════════════════════════════════════════"
echo
bash scripts/serve-public.sh
echo
echo "Напоминание: для локальной модели должен быть запущен LM Studio."
echo
read -n 1 -s -r -p "Нажмите любую клавишу, чтобы закрыть окно…" || true
echo
