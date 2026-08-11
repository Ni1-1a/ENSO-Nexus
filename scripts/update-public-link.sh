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

# Страница-вход сначала проверяет доступность сервера (/api/health с CORS):
# доступен — переходим; нет — честно пишем «сервер сейчас недоступен» и
# автоматически проверяем каждые 15 секунд, переходя как только он оживёт.
cat > "$WT/index.html" <<HTML
<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>ENSO Nexus · Pilot 1 — переход к приложению</title>
  <style>
    body { font-family: system-ui, sans-serif; display: grid; place-items: center; min-height: 90vh; background: #f3efe6; color: #33302a; }
    .card { text-align: center; padding: 2rem; max-width: 440px; }
    a { color: #b95740; font-weight: 600; }
    .muted { color: #8a8474; font-size: .85rem; }
    .spinner { display: inline-block; width: 14px; height: 14px; border: 2px solid #d8d0c0; border-top-color: #b95740; border-radius: 50%; animation: spin 1s linear infinite; vertical-align: -2px; margin-right: 6px; }
    @keyframes spin { to { transform: rotate(360deg); } }
    #offline { display: none; }
  </style>
</head>
<body>
  <div class="card">
    <h1>ENSO Nexus · Pilot 1</h1>
    <p id="checking"><span class="spinner"></span>Проверяем доступность сервера…</p>
    <div id="offline">
      <p><strong>Сервер сейчас недоступен.</strong></p>
      <p class="muted">Скорее всего, компьютер с приложением выключен или нет связи.
         Страница проверяет доступность каждые 15 секунд и откроет приложение автоматически,
         как только сервер появится. Можно просто оставить вкладку открытой.</p>
      <p class="muted" id="tries"></p>
    </div>
    <p><a href="$URL">$URL</a></p>
  </div>
  <script>
    var URL_APP = '$URL';
    var tries = 0;
    function check() {
      tries++;
      var ctrl = new AbortController();
      var t = setTimeout(function () { ctrl.abort(); }, 7000);
      fetch(URL_APP + '/api/health', { cache: 'no-store', signal: ctrl.signal })
        .then(function (r) {
          clearTimeout(t);
          if (r.ok) { location.replace(URL_APP); return; }
          offline();
        })
        .catch(function () { clearTimeout(t); offline(); });
    }
    function offline() {
      document.getElementById('checking').style.display = 'none';
      document.getElementById('offline').style.display = 'block';
      document.getElementById('tries').textContent = 'Проверок выполнено: ' + tries;
      setTimeout(check, 15000);
    }
    check();
  </script>
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
