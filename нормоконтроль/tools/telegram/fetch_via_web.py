#!/usr/bin/env python3
"""Выгрузка истории публичного канала @ai_prompt_eng через веб-зеркало t.me/s (Этап 0-Б).

Запасной путь вместо MTProto (my.telegram.org отдавал ERROR при создании приложения):
зеркало t.me/s/<канал> отдаёт полную историю публичного канала по HTTPS без
какой-либо авторизации. Формат выгрузки тот же, что и у fetch_ai_prompt_eng.py:
jsonl с полями id, date, text, link, has_media.

Повторный запуск дозагружает только новое (min_id = максимальный собранный id).
Ограничения зеркала: нет служебных сообщений; текст восстанавливается из HTML
(инлайн-разметка отбрасывается, ссылки сохраняются как "текст [url]").
"""
import html
import json
import re
import sys
import time
import urllib.request
from pathlib import Path

CHANNEL = "ai_prompt_eng"
HERE = Path(__file__).resolve().parent
OUT = HERE.parent.parent / "_raw" / "telegram" / f"{CHANNEL}.jsonl"
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"


def get(url: str) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read().decode("utf-8", "replace")


def text_from_html(fragment: str) -> str:
    t = fragment
    t = re.sub(r"<br\s*/?>", "\n", t)
    # ссылки: <a href="url">текст</a> -> текст [url] (если текст сам не url)
    def link(m):
        href, inner = m.group(1), re.sub(r"<[^>]+>", "", m.group(2))
        inner = html.unescape(inner).strip()
        return inner if inner == href or href.startswith("https://t.me/") and not inner else f"{inner} [{href}]"
    t = re.sub(r'<a[^>]+href="([^"]+)"[^>]*>(.*?)</a>', link, t, flags=re.S)
    t = re.sub(r"<[^>]+>", "", t)
    return html.unescape(t).strip()


def parse_page(page: str):
    """Возвращает [(id, date_iso, text, has_media)] в порядке следования на странице."""
    out = []
    blocks = re.split(r'<div class="tgme_widget_message_wrap', page)[1:]
    for b in blocks:
        m = re.search(rf'data-post="{CHANNEL}/(\d+)"', b)
        if not m:
            continue
        mid = int(m.group(1))
        dm = re.search(r'<time datetime="([^"]+)"', b)
        tm = re.search(r'<div class="tgme_widget_message_text[^"]*"[^>]*>(.*?)</div>', b, re.S)
        has_media = bool(re.search(r"message_(photo|video|document|voice|roundvideo|sticker)_", b))
        out.append((mid, dm.group(1) if dm else None, text_from_html(tm.group(1)) if tm else "", has_media))
    return out


def main() -> None:
    known = set()
    if OUT.exists():
        with OUT.open(encoding="utf-8") as f:
            for line in f:
                if line.strip():
                    known.add(json.loads(line)["id"])
    min_known = max(known) if known else 0

    collected = {}
    url = f"https://t.me/s/{CHANNEL}"
    before = None
    while True:
        page = get(url if before is None else f"{url}?before={before}")
        msgs = parse_page(page)
        if not msgs:
            break
        for mid, date, text, media in msgs:
            if mid not in known:
                collected[mid] = (date, text, media)
        lowest = min(m[0] for m in msgs)
        print(f"страница before={before}: посты {lowest}..{max(m[0] for m in msgs)}; собрано {len(collected)}")
        if lowest <= 1 or lowest <= min_known:
            break
        before = lowest
        time.sleep(1.5)

    if not collected:
        print("нового нет")
        return
    OUT.parent.mkdir(parents=True, exist_ok=True)
    with OUT.open("a", encoding="utf-8") as f:
        for mid in sorted(collected):
            date, text, media = collected[mid]
            f.write(json.dumps({
                "id": mid, "date": date, "text": text,
                "link": f"https://t.me/{CHANNEL}/{mid}", "has_media": media,
            }, ensure_ascii=False) + "\n")
    total = len(known) + len(collected)
    print(f"дописано {len(collected)} постов; всего в файле {total}; диапазон id 1..{max(collected)}")


if __name__ == "__main__":
    sys.exit(main())
