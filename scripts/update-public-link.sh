#!/usr/bin/env bash
# Публикует на GitHub Pages (ветка gh-pages) приёмную и страницы ошибок.
# Единственный источник правды — public/error-pages/ в ветке main:
#   landing.html -> index.html       приёмная https://ni1-1a.github.io/ENSO-Nexus/
#   cf-5xx.html  -> error-5xx.html   страница Cloudflare при 5xx
#   cf-1xxx.html -> error-1033.html  страница Cloudflare при 1033 (туннель не поднят)
# Раньше index.html генерировался прямо здесь, и каждый запуск serve-public.sh
# затирал приёмную, выложенную вручную.
set -euo pipefail
cd "$(dirname "$0")/.."

SRC=public/error-pages
for f in landing.html cf-5xx.html cf-1xxx.html; do
  [[ -f "$SRC/$f" ]] || { echo "нет файла $SRC/$f — публиковать нечего" >&2; exit 1; }
done

# Адрес нужен только для сообщения и текста коммита: страницы ведут на постоянный
# https://enso-nexus.com и от поднятого туннеля не зависят, поэтому скрипт можно
# вызывать отдельно, чтобы перевыложить поправленные страницы.
URL=$(cat logs/public-url.txt 2>/dev/null || true)
URL=${URL:-https://enso-nexus.com}

WT=$(mktemp -d)
trap 'rm -rf "$WT"' EXIT

# ветка gh-pages: синхронизируем с origin, либо создаём пустую
git fetch origin gh-pages >/dev/null 2>&1 || true
if git show-ref --verify --quiet refs/remotes/origin/gh-pages; then
  git branch -f gh-pages origin/gh-pages >/dev/null 2>&1
  git worktree add "$WT" gh-pages >/dev/null
elif git show-ref --verify --quiet refs/heads/gh-pages; then
  git worktree add "$WT" gh-pages >/dev/null
else
  git worktree add --detach "$WT" >/dev/null
  git -C "$WT" checkout --orphan gh-pages >/dev/null 2>&1
  git -C "$WT" rm -rf --quiet . 2>/dev/null || true
fi

# Приёмная сама проверяет /api/health (CORS) и открывает платформу, как только та
# поднимется; страницы ошибок Cloudflare показывает вместо своих стандартных.
cp "$SRC/landing.html" "$WT/index.html"
cp "$SRC/cf-5xx.html"  "$WT/error-5xx.html"
cp "$SRC/cf-1xxx.html" "$WT/error-1033.html"
touch "$WT/.nojekyll"   # иначе GitHub Pages прогонит файлы через Jekyll

git -C "$WT" add -A
if git -C "$WT" -c commit.gpgsign=false commit -m "Приёмная и страницы ошибок -> $URL" >/dev/null 2>&1; then
  git -C "$WT" push origin gh-pages >/dev/null
  echo "Приёмная обновлена: https://ni1-1a.github.io/ENSO-Nexus/ -> $URL"
else
  echo "Страницы не менялись — публикация не требуется."
fi
git worktree remove --force "$WT" 2>/dev/null || true
git worktree prune   # убирает записи о временных worktree, стёртых по trap EXIT
