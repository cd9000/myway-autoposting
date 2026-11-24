"""Собирает свежие посты публичных каналов из веб-превью t.me/s/<channel>.

Аргументы: <файл вывода> <дней назад> <канал> [<канал> ...]
"""
import html
import re
import sys
import urllib.request
from datetime import datetime, timedelta, timezone

out_path, days, channels = sys.argv[1], int(sys.argv[2]), sys.argv[3:]
cutoff = datetime.now(timezone.utc) - timedelta(days=days)
MAX_PAGES = 15

with open(out_path, "w", encoding="utf-8") as f:
    for channel in channels:
        posts = {}
        before = None
        for _ in range(MAX_PAGES):
            url = f"https://t.me/s/{channel}" + (f"?before={before}" if before else "")
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            try:
                page = urllib.request.urlopen(req, timeout=30).read().decode("utf-8")
            except Exception as e:
                print(channel, "error:", e)
                break
            blocks = re.split(r'<div class="tgme_widget_message_wrap', page)[1:]
            ids, oldest = [], None
            for b in blocks:
                m = re.search(r'data-post="([^"/]+)/(\d+)"', b)
                if not m:
                    continue
                pid = int(m.group(2))
                ids.append(pid)
                d = re.search(r'<time datetime="([^"]+)"', b)
                when = datetime.fromisoformat(d.group(1)) if d else None
                if when and (oldest is None or when < oldest):
                    oldest = when
                if when and when < cutoff:
                    continue
                t = re.search(r'<div class="tgme_widget_message_text[^"]*"[^>]*>(.*?)</div>', b, re.S)
                text = t.group(1) if t else ""
                text = re.sub(r"<br\s*/?>", "\n", text)
                text = html.unescape(re.sub(r"<[^>]+>", "", text)).strip()
                v = re.search(r'tgme_widget_message_views">([^<]+)<', b)
                if text:
                    posts[pid] = (when, v.group(1) if v else "?", f"https://t.me/{m.group(1)}/{pid}", text)
            if not ids or (oldest and oldest < cutoff) or min(ids) <= 1:
                break
            before = min(ids)
        f.write(f"\n########## {channel}: {len(posts)} постов\n")
        for pid in sorted(posts):
            when, views, link, text = posts[pid]
            f.write(f"=== {when:%d.%m %H:%M} | {views} | {link}\n{text}\n\n")
        print(channel, len(posts))
