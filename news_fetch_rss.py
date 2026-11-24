"""Собирает свежие AI-новости компаний из RSS (официальные блоги + Google News).

Дописывает в файл вывода в том же формате, что news_fetch.py.
Аргументы: <файл вывода> <дней назад>
"""
import gzip
import html
import re
import sys
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime

out_path, days = sys.argv[1], int(sys.argv[2])
cutoff = datetime.now(timezone.utc) - timedelta(days=days)
MAX_PER_FEED = 12

FEEDS = [
    ("OpenAI", "https://openai.com/news/rss.xml"),
    ("Google AI", "https://blog.google/technology/ai/rss/"),
    ("DeepMind", "https://deepmind.google/blog/rss.xml"),
    ("Meta", "https://about.fb.com/news/feed/"),
]


def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0", "Accept-Encoding": "gzip"})
    raw = urllib.request.urlopen(req, timeout=30).read()
    if raw[:2] == b"\x1f\x8b":
        raw = gzip.decompress(raw)
    return raw.decode("utf-8", "replace")


def parse_date(s):
    if not s:
        return None
    try:
        return parsedate_to_datetime(s)
    except Exception:
        pass
    try:
        return datetime.fromisoformat(s.strip().replace("Z", "+00:00"))
    except Exception:
        return None


def strip(t):
    if not t:
        return ""
    t = re.sub(r"<[^>]+>", " ", t)
    return html.unescape(re.sub(r"\s+", " ", t)).strip()


with open(out_path, "a", encoding="utf-8") as f:
    for label, url in FEEDS:
        try:
            root = ET.fromstring(fetch(url))
        except Exception as e:
            print(label, "error:", e)
            continue
        ns = ""
        m = re.match(r"\{(.+)\}", root.tag)
        if m:
            ns = m.group(1)
        items = root.findall(".//item")
        if not items:
            items = root.findall(".//{%s}entry" % ns) if ns else root.findall(".//entry")
        posts = []
        for it in items:
            def gt(tag):
                e = it.find(tag)
                if e is None and ns:
                    e = it.find("{%s}%s" % (ns, tag))
                return e.text if e is not None else ""

            title = strip(gt("title"))
            le = it.find("link")
            if le is None and ns:
                le = it.find("{%s}link" % ns)
            link = ""
            if le is not None:
                link = (le.text or "").strip() or le.get("href", "")
            date = parse_date(gt("pubDate") or gt("published") or gt("updated") or gt("date"))
            desc = strip(gt("description") or gt("summary") or gt("content"))[:500]
            if date and date < cutoff:
                continue
            if not title and not desc:
                continue
            posts.append((date, link, title, desc))
        posts = posts[:MAX_PER_FEED]
        f.write(f"\n########## {label}: {len(posts)} постов\n")
        for date, link, title, desc in posts:
            when = f"{date:%d.%m %H:%M}" if date else "?"
            text = title + ("\n" + desc if desc and desc != title else "")
            f.write(f"=== {when} | RSS | {link}\n{text}\n\n")
        print(label, len(posts))
