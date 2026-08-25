#!/usr/bin/env python3
"""Выгрузка истории канала @ai_prompt_eng в _raw/telegram/ai_prompt_eng.jsonl (Этап 0-Б).

Режимы:
  --login   единоразовая интерактивная авторизация (телефон -> код из Telegram
            -> при включённой двухфакторке облачный пароль). Запускает Никита
            сам в терминале; создаёт локальный файл сессии enso_normo.session.
  (без флага)  неинтерактивная дозагрузка: берёт min_id из уже собранного
            jsonl и выкачивает только новые посты. Без авторизованной сессии
            не спрашивает ничего — завершается с подсказкой про --login.

Креды: TG_API_ID / TG_API_HASH из .env в корне Web/ (в git не попадает).
Скрипт только читает канал; ничего не отправляет и не помечает прочитанным.
"""
import argparse
import json
import random
import sys
import time
from pathlib import Path

from dotenv import dotenv_values
from telethon.sync import TelegramClient
from telethon.errors import FloodWaitError

HERE = Path(__file__).resolve().parent
WEB_ROOT = HERE.parent.parent.parent          # .../Pilot 1/Web
ENV = dotenv_values(WEB_ROOT / ".env")
CHANNEL = "ai_prompt_eng"
OUT = WEB_ROOT / "нормоконтроль" / "_raw" / "telegram" / f"{CHANNEL}.jsonl"
SESSION = HERE / "enso_normo"                 # -> enso_normo.session рядом со скриптом


def die(msg: str) -> None:
    print(f"ОШИБКА: {msg}", file=sys.stderr)
    sys.exit(1)


def get_client() -> TelegramClient:
    api_id, api_hash = ENV.get("TG_API_ID", "").strip(), ENV.get("TG_API_HASH", "").strip()
    if not api_id.isdigit() or not api_hash:
        die("заполни TG_API_ID (число) и TG_API_HASH в Web/.env (my.telegram.org -> API development tools)")
    return TelegramClient(str(SESSION), int(api_id), api_hash)


def last_collected_id() -> int:
    if not OUT.exists():
        return 0
    last = 0
    with OUT.open(encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                last = max(last, json.loads(line)["id"])
    return last


def fetch(client: TelegramClient) -> None:
    min_id = last_collected_id()
    print(f"канал: @{CHANNEL}; уже собрано до id={min_id}; качаю новое…")
    entity = client.get_entity(CHANNEL)
    got = 0
    OUT.parent.mkdir(parents=True, exist_ok=True)
    with OUT.open("a", encoding="utf-8") as f:
        it = client.iter_messages(entity, reverse=True, min_id=min_id)
        while True:
            try:
                msg = next(it)
            except StopIteration:
                break
            except FloodWaitError as e:
                wait = e.seconds + random.randint(2, 10)
                print(f"FloodWait: сплю {wait} с…")
                time.sleep(wait)
                continue
            if msg.id <= min_id:
                continue
            f.write(json.dumps({
                "id": msg.id,
                "date": msg.date.isoformat() if msg.date else None,
                "text": msg.text or "",
                "link": f"https://t.me/{CHANNEL}/{msg.id}",
                "has_media": msg.media is not None,
            }, ensure_ascii=False) + "\n")
            got += 1
            if got % 200 == 0:
                print(f"  …{got} постов (id={msg.id})")
    print(f"готово: +{got} постов, всего в {OUT.name}: до id={last_collected_id()}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--login", action="store_true", help="интерактивная авторизация (запускать вручную)")
    args = ap.parse_args()
    client = get_client()
    if args.login:
        with client:          # спросит телефон, код, при 2FA — облачный пароль
            me = client.get_me()
            print(f"авторизовано: {me.first_name or ''} (id={me.id}). Сессия: {SESSION}.session")
        return
    client.connect()
    if not client.is_user_authorized():
        die(f"сессии нет. Запусти один раз вручную:\n  {HERE}/.venv/bin/python {Path(__file__).name} --login")
    with client:
        fetch(client)


if __name__ == "__main__":
    main()
