from __future__ import annotations

import csv
import html as html_lib
import io
import json
import re
import time
import urllib.parse
import urllib.request
from datetime import date, datetime, timezone
from pathlib import Path

BASE = "https://hirose-fx.co.jp"
SOURCE_PAGE = f"{BASE}/contents/news/Swap"
SOURCE_CSV = f"{BASE}/swap/lionfx_swap.csv"
START_DATE = date(2026, 7, 1)
OUT = Path("data/usdtry.json")
UA = {"User-Agent": "Mozilla/5.0 (compatible; USDTRY-Swap-Watch/1.0; +https://github.com/ProtChan/USDTRY)"}


def fetch_bytes(url: str, attempts: int = 3) -> bytes:
    last_error: Exception | None = None
    for attempt in range(attempts):
        try:
            req = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, timeout=30) as response:
                return response.read()
        except Exception as exc:  # network retries are intentionally broad
            last_error = exc
            if attempt + 1 < attempts:
                time.sleep(1.0 + attempt)
    assert last_error is not None
    raise last_error


def latest_csv_date() -> date:
    raw = fetch_bytes(SOURCE_CSV)
    text = raw.decode("cp932")
    rows = csv.reader(io.StringIO(text))
    latest: date | None = None
    for row in rows:
        if not row or not re.fullmatch(r"\d{4}/\d{2}/\d{2}", row[0].strip()):
            continue
        latest = datetime.strptime(row[0].strip(), "%Y/%m/%d").date()
    if latest is None:
        raise RuntimeError("Could not determine latest date from Hirose CSV")
    return latest


def strip_tags(fragment: str) -> str:
    fragment = re.sub(r"<br\s*/?>", " ", fragment, flags=re.I)
    fragment = re.sub(r"<[^>]+>", "", fragment)
    return " ".join(html_lib.unescape(fragment).replace("\xa0", " ").split())


def parse_number(value: str) -> float:
    value = value.replace(",", "").strip()
    if not value:
        raise ValueError("empty numeric cell")
    return float(value)


def parse_usdtry_row(page_html: str) -> dict:
    pair_match = re.search(r">\s*USD/TRY\s*<", page_html, flags=re.I)
    if not pair_match:
        raise RuntimeError("USD/TRY row not found")
    row_start = page_html.rfind("<tr", 0, pair_match.start())
    row_end = page_html.find("</tr>", pair_match.end())
    if row_start < 0 or row_end < 0:
        raise RuntimeError("USD/TRY table row boundaries not found")
    row_html = page_html[row_start : row_end + len("</tr>")]
    cells = [strip_tags(x) for x in re.findall(r"<td[^>]*>(.*?)</td>", row_html, flags=re.I | re.S)]
    if len(cells) < 7 or cells[0].replace(" ", "") != "USD/TRY":
        raise RuntimeError(f"Unexpected USD/TRY row: {cells!r}")

    days = int(parse_number(cells[1]))
    lot_size = int(parse_number(cells[2]))
    sell_points = parse_number(cells[3])
    buy_points = parse_number(cells[4])
    sell_yen = parse_number(cells[5])
    buy_yen = parse_number(cells[6])
    per_day = round(sell_yen / days, 6) if days > 0 else None

    return {
        "days": days,
        "lot_size": lot_size,
        "sell_points": sell_points,
        "buy_points": buy_points,
        "sell_yen": sell_yen,
        "buy_yen": buy_yen,
        "sell_yen_per_day": per_day,
    }


def previous_link(page_html: str) -> tuple[date, str] | None:
    anchor_pattern = re.compile(r"<a\s+[^>]*href=[\"']([^\"']+)[\"'][^>]*>(.*?)</a>", flags=re.I | re.S)
    date_pattern = re.compile(r"(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日")
    for href, body in anchor_pattern.findall(page_html):
        text = strip_tags(body)
        if "<<" not in text:
            continue
        match = date_pattern.search(text)
        if not match:
            continue
        y, m, d = map(int, match.groups())
        url = urllib.parse.urljoin(BASE, html_lib.unescape(href))
        return date(y, m, d), url
    return None


def fetch_html(url: str) -> str:
    raw = fetch_bytes(url)
    for encoding in ("utf-8", "cp932", "shift_jis"):
        try:
            return raw.decode(encoding)
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", errors="replace")


def load_existing() -> dict:
    if not OUT.exists():
        return {"meta": {}, "data": []}
    return json.loads(OUT.read_text(encoding="utf-8"))


def main() -> None:
    existing = load_existing()
    by_date = {item["date"]: item for item in existing.get("data", []) if item.get("date")}
    existing_dates = [date.fromisoformat(d) for d in by_date]
    existing_latest = max(existing_dates) if existing_dates else None

    current_date = latest_csv_date()
    current_url = SOURCE_PAGE
    fetched = 0

    while current_date >= START_DATE:
        page_html = fetch_html(current_url)
        values = parse_usdtry_row(page_html)
        by_date[current_date.isoformat()] = {
            "date": current_date.isoformat(),
            **values,
            "source_url": current_url,
        }
        fetched += 1
        print(
            f"{current_date.isoformat()} days={values['days']} "
            f"sell_yen={values['sell_yen']} per_day={values['sell_yen_per_day']}"
        )

        if existing_latest is not None and current_date <= existing_latest:
            break

        prev = previous_link(page_html)
        if prev is None:
            break
        prev_date, prev_url = prev
        if prev_date >= current_date:
            raise RuntimeError(f"Previous link did not move backward: {current_date} -> {prev_date}")
        current_date, current_url = prev_date, prev_url
        time.sleep(0.12)

    data = [by_date[k] for k in sorted(by_date) if date.fromisoformat(k) >= START_DATE]
    if not data:
        raise RuntimeError("No USD/TRY data collected")

    if date.fromisoformat(data[0]["date"]) != START_DATE:
        raise RuntimeError(f"Backfill did not reach {START_DATE}: first={data[0]['date']}")

    meta = {
        "pair": "USD/TRY",
        "side": "sell",
        "description": "Hirose LION FX USD/TRY sell swap, JPY converted and normalized per accrual day",
        "start_date": START_DATE.isoformat(),
        "latest_date": data[-1]["date"],
        "lot_size": 1000,
        "source_page": SOURCE_PAGE,
        "source_csv": SOURCE_CSV,
        "normalization": "sell_yen / days when days > 0; 0-day rows are kept with sell_yen_per_day=null",
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "records": len(data),
        "pages_fetched_this_run": fetched,
    }

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({"meta": meta, "data": data}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {OUT}: {len(data)} records, latest={data[-1]['date']}, fetched={fetched}")


if __name__ == "__main__":
    main()
