#!/usr/bin/env bash
# Собирает всё, чего нет в git, в один каталог для переноса на Windows.
# Запускается НА МАКЕ. Ничего не удаляет и не меняет — только читает и копирует.
#
#   bash "win/scripts/собрать-пакет-на-маке.sh" [куда] [--with-kb]
#
#   куда        каталог назначения (по умолчанию ~/Desktop/enso-win-пакет)
#   --with-kb   положить в пакет и базу знаний (≈673 МБ; иначе копировать отдельно)
set -euo pipefail

WEB="$(cd "$(dirname "$0")/../.." && pwd)"          # …/Pilot 1/Web
PILOT="$(dirname "$WEB")"                            # …/Pilot 1
NEXUS="$(dirname "$PILOT")"                          # …/ENSO-Nexus

DEST="${HOME}/Desktop/enso-win-пакет"
WITH_KB=0
for arg in "$@"; do
  case "$arg" in
    --with-kb) WITH_KB=1 ;;
    -*) echo "неизвестный ключ: $arg" >&2; exit 1 ;;
    *) DEST="$arg" ;;
  esac
done

echo "Проект: $WEB"
echo "Пакет:  $DEST"
echo

# ── База копируется только при остановленном сервере ──────────────────────
# SQLite в режиме WAL держит часть свежих записей в app.db-wal. Копия на ходу
# теряет их молча — поэтому лучше отказаться, чем увезти обрезанную базу.
if lsof -ti tcp:3000 >/dev/null 2>&1; then
  echo "На порту 3000 кто-то слушает — похоже, сервер запущен."
  echo "Остановите его и повторите:  bash scripts/serve-public.sh stop"
  exit 1
fi

mkdir -p "$DEST/web" "$DEST/cloudflared"

copy() {  # copy <источник> <куда> <описание>
  if [ -e "$1" ]; then
    cp -R "$1" "$2"
    echo "  ✓ $3"
  else
    echo "  — $3: не найдено ($1)"
  fi
}

echo "Секреты и данные проекта:"
copy "$WEB/.env"        "$DEST/web/.env"        ".env (ключи API и лимиты)"
copy "$WEB/users.json"  "$DEST/web/users.json"  "users.json (люди платформы)"
copy "$WEB/data"        "$DEST/web/data"        "data/ (база, загрузки, результаты, архив)"

echo
echo "Ключи туннеля Cloudflare:"
copy "$HOME/.cloudflared/config.yml" "$DEST/cloudflared/config.yml" "config.yml"
copy "$HOME/.cloudflared/cert.pem"     "$DEST/cloudflared/cert.pem"     "cert.pem (.com)"
copy "$HOME/.cloudflared/cert-ru.pem"  "$DEST/cloudflared/cert-ru.pem"  "cert-ru.pem (.ru)"
for f in "$HOME"/.cloudflared/*.json; do
  [ -e "$f" ] || continue
  cp "$f" "$DEST/cloudflared/"
  echo "  ✓ ключ туннеля $(basename "$f")"
done

echo
echo "Исходные данные пилота (на них проверяется прогон):"
copy "$PILOT/Исходные данные" "$DEST/Исходные данные" "Исходные данные/"

if [ "$WITH_KB" = 1 ]; then
  echo
  echo "База знаний (долго, ≈673 МБ):"
  copy "$NEXUS/Knowledge-Base"        "$DEST/Knowledge-Base"        "Knowledge-Base/"
  copy "$NEXUS/Knowledge-Base-Гриша"  "$DEST/Knowledge-Base-Гриша"  "Knowledge-Base-Гриша/"
fi

# ── Памятка внутрь пакета ─────────────────────────────────────────────────
cat > "$DEST/КУДА-ЭТО-КЛАСТЬ.txt" <<'TXT'
Пакет для переноса Enso-nexus на Windows
========================================

На Windows сначала:   git clone https://github.com/Ni1-1a/ENSO-Nexus.git C:\Enso\web

Затем разложить из этого пакета:

  web\.env              → C:\Enso\web\.env          (поправить: LOCAL_AI_BASE_URL на адрес
                          мака, OLLAMA_BASE_URL на localhost, KB_DIR, ACAD_ENABLED=0)
  web\users.json        → C:\Enso\web\users.json
  web\data\             → C:\Enso\web\data\   (здесь же индекс базы знаний, 12,5 тыс. чанков)
  cloudflared\*         → C:\Users\<имя>\.cloudflared\
                          в config.yml переписать credentials-file на путь Windows
  Исходные данные\      → куда удобно, это материал для проверочного прогона
  Knowledge-Base\       → куда решите (KB_DIR). Не срочно: поиск работает от индекса
                          в data\app.db, папка нужна только для переиндексации.

Дальше — открыть Claude Code в C:\Enso\web и вставить промт из
win\ПРОМТ-для-вставки.txt

ВАЖНО: пока туннель не переехал, на маке он должен быть остановлен —
два коннектора у одного туннеля означают, что люди попадают то на мак,
то на Windows.
TXT

echo
echo "Размер пакета:"
du -sh "$DEST"
echo
echo "Готово: $DEST"
echo "Внутри — КУДА-ЭТО-КЛАСТЬ.txt с раскладкой по папкам."
