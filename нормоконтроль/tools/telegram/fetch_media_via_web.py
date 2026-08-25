#!/usr/bin/env python3
"""Скачивание вложений канала @ai_prompt_eng через зеркало t.me/s (Этап 0-Б).

Зеркало отдаёт напрямую только фото (background-image на CDN) и часть видео
(<video src=...>). Файлы-документы (PDF/DOCX) через зеркало НЕ раздаются —
для них фиксируем только имя файла из блока документа (manifest), добирать
их нужно экспортом из Telegram Desktop или через MTProto.

Результат:
  _raw/telegram/media/<postid>_<n>.<ext>  — скачанные фото/видео
  _raw/telegram/media_manifest.jsonl      — по каждому посту с медиа: что нашли,
                                            что скачали, что недоступно
"""
import html
import json
import re
import time
import urllib.request
from pathlib import Path

CHANNEL = "ai_prompt_eng"
HERE = Path(__file__).resolve().parent
RAW = HERE.parent.parent / "_raw" / "telegram"
MEDIA = RAW / "media"
MANIFEST = RAW / "media_manifest.jsonl"
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"


def get(url: str, binary: bool = False):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=60) as r:
        data = r.read()
    return data if binary else data.decode("utf-8", "replace")


def ext_of(url: str, default: str) -> str:
    m = re.search(r"\.(jpe?g|png|gif|webp|mp4|mov)(?:$|\?)", url, re.I)
    return m.group(1).lower() if m else default


def main() -> None:
    MEDIA.mkdir(parents=True, exist_ok=True)
    done = set()
    if MANIFEST.exists():
        with MANIFEST.open(encoding="utf-8") as f:
            done = {json.loads(l)["id"] for l in f if l.strip()}

    records = {}
    before = None
    while True:
        url = f"https://t.me/s/{CHANNEL}" + (f"?before={before}" if before else "")
        page = get(url)
        blocks = re.split(r'<div class="tgme_widget_message_wrap', page)[1:]
        if not blocks:
            break
        ids = []
        for b in blocks:
            m = re.search(rf'data-post="{CHANNEL}/(\d+)"', b)
            if not m:
                continue
            mid = int(m.group(1))
            ids.append(mid)
            if mid in done or mid in records:
                continue
            photos = re.findall(r"class=\"tgme_widget_message_photo_wrap[^\"]*\"[^>]*background-image:url\('([^']+)'\)", b)
            videos = re.findall(r'<video[^>]+src="([^"]+)"', b)
            docs = [html.unescape(t).strip() for t in re.findall(
                r'class="tgme_widget_message_document_title[^"]*"[^>]*>(.*?)</div>', b, re.S)]
            docs = [re.sub(r"<[^>]+>", "", d) for d in docs]
            if photos or videos or docs:
                records[mid] = {"photos": photos, "videos": videos, "docs": docs}
        lowest = min(ids) if ids else 1
        print(f"страница before={before}: {len(ids)} постов, с медиа всего {len(records)}")
        if lowest <= 1:
            break
        before = lowest
        time.sleep(1.5)

    saved = skipped_docs = 0
    with MANIFEST.open("a", encoding="utf-8") as mf:
        for mid in sorted(records):
            rec = records[mid]
            files = []
            for i, u in enumerate(rec["photos"], 1):
                name = f"{mid}_{i}.{ext_of(u, 'jpg')}"
                (MEDIA / name).write_bytes(get(u, binary=True))
                files.append(name)
                saved += 1
                time.sleep(0.5)
            for i, u in enumerate(rec["videos"], 1):
                name = f"{mid}_v{i}.{ext_of(u, 'mp4')}"
                try:
                    (MEDIA / name).write_bytes(get(u, binary=True))
                    files.append(name)
                    saved += 1
                except Exception as e:
                    files.append(f"видео не скачалось: {e}")
                time.sleep(0.5)
            skipped_docs += len(rec["docs"])
            mf.write(json.dumps({
                "id": mid,
                "link": f"https://t.me/{CHANNEL}/{mid}",
                "saved": files,
                "documents_unavailable": rec["docs"],
            }, ensure_ascii=False) + "\n")
    print(f"скачано файлов: {saved}; документов, недоступных через зеркало: {skipped_docs}")
    print(f"опись: {MANIFEST}")


if __name__ == "__main__":
    main()
