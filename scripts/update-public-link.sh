#!/usr/bin/env bash
# Обновляет постоянную ссылку-вход (GitHub Pages, ветка gh-pages):
# страница https://ni1-1a.github.io/ENSO-Nexus/ всегда перенаправляет
# на текущий публичный URL приложения из logs/public-url.txt.
set -euo pipefail
cd "$(dirname "$0")/.."

URL=$(cat logs/public-url.txt 2>/dev/null || true)
if [[ -z "$URL" ]]; then
  echo "logs/public-url.txt пуст — сначала запустите scripts/serve-public.sh" >&2
  exit 1
fi

WT=$(mktemp -d)
trap 'rm -rf "$WT"' EXIT

# ветка gh-pages: берём с origin, либо создаём пустую
if git fetch origin gh-pages 2>/dev/null; then
  git worktree add --detach "$WT" origin/gh-pages >/dev/null
  git -C "$WT" switch -c gh-pages >/dev/null 2>&1 || git -C "$WT" checkout -b gh-pages >/dev/null 2>&1
else
  git worktree add --detach "$WT" >/dev/null
  git -C "$WT" checkout --orphan gh-pages >/dev/null 2>&1
  git -C "$WT" rm -rf --quiet . 2>/dev/null || true
fi

cat > "$WT/index.html" <<HTML
<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>ENSO Nexus · Pilot 1 — переход к приложению</title>
  <meta http-equiv="refresh" content="0; url=$URL">
  <style>
    body { font-family: system-ui, sans-serif; display: grid; place-items: center; min-height: 90vh; background: #f6f7fb; color: #1e1b4b; }
    .card { text-align: center; padding: 2rem; }
    a { color: #4f46e5; font-weight: 600; }
  </style>
</head>
<body>
  <div class="card">
    <h1>ENSO Nexus · Pilot 1</h1>
    <p>Переходим к приложению…</p>
    <p><a href="$URL">$URL</a></p>
    <p style="color:#64748b;font-size:.85rem">Если переход не сработал, сервер сейчас выключен — попробуйте позже.</p>
  </div>
  <script>location.replace('$URL');</script>
</body>
</html>
HTML
touch "$WT/.nojekyll"

git -C "$WT" add -A
if git -C "$WT" -c commit.gpgsign=false commit -m "redirect -> $URL" >/dev/null 2>&1; then
  git -C "$WT" push origin gh-pages >/dev/null
  echo "Постоянная ссылка обновлена: https://ni1-1a.github.io/ENSO-Nexus/ -> $URL"
else
  echo "URL не изменился — обновление не требуется."
fi
git worktree remove --force "$WT" 2>/dev/null || true
