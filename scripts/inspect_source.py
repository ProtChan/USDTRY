from __future__ import annotations

import csv
import io
import re
import urllib.request

UA = {"User-Agent": "Mozilla/5.0 USDTRY-swap-watch/1.0"}

# CSV structure
csv_url = "https://hirose-fx.co.jp/swap/lionfx_swap.csv"
req = urllib.request.Request(csv_url, headers=UA)
with urllib.request.urlopen(req, timeout=30) as r:
    raw = r.read()
print("csv-bytes", len(raw))
for enc in ("utf-8-sig", "cp932", "shift_jis", "utf-8"):
    try:
        text = raw.decode(enc)
        print("csv-encoding", enc)
        break
    except UnicodeDecodeError:
        pass
reader = csv.reader(io.StringIO(text))
for i, row in enumerate(reader):
    print("csv-row", i, repr(row[:10]), "...", len(row))
    if i >= 3:
        break

# HTML structure / navigation
page_url = "https://hirose-fx.co.jp/contents/news/Swap"
req = urllib.request.Request(page_url, headers=UA)
with urllib.request.urlopen(req, timeout=30) as r:
    page_raw = r.read()
    ctype = r.headers.get_content_charset()
print("html-bytes", len(page_raw), "charset", ctype)
for enc in (ctype, "utf-8", "cp932", "shift_jis"):
    if not enc:
        continue
    try:
        html = page_raw.decode(enc)
        print("html-encoding", enc)
        break
    except UnicodeDecodeError:
        pass

for line in html.splitlines():
    if "USD/TRY" in line or "hrsCrpNo" in line or "param=select" in line:
        clean = re.sub(r"\s+", " ", line).strip()
        if clean:
            print("HTML", clean[:1000])

print("nav-hrefs", re.findall(r'href=[\"\']([^\"\']*(?:hrsCrpNo|param=select)[^\"\']*)[\"\']', html)[:20])
