from __future__ import annotations

import csv
import io
import urllib.request

URL = "https://hirose-fx.co.jp/swap/lionfx_swap.csv"

req = urllib.request.Request(URL, headers={"User-Agent": "Mozilla/5.0 USDTRY-swap-watch/1.0"})
with urllib.request.urlopen(req, timeout=30) as r:
    raw = r.read()

print("bytes", len(raw))
for enc in ("utf-8-sig", "cp932", "shift_jis", "utf-8"):
    try:
        text = raw.decode(enc)
        print("encoding", enc)
        break
    except UnicodeDecodeError:
        pass
else:
    text = raw.decode("cp932", errors="replace")
    print("encoding", "cp932-replace")

print("head-text")
print("\n".join(text.splitlines()[:12]))
print("rows")
reader = csv.reader(io.StringIO(text))
for i, row in enumerate(reader):
    print(i, repr(row))
    if i >= 15:
        break
