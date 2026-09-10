from __future__ import annotations

import html as html_lib
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
UA = {"User-Agent": "Mozilla/5.0 USDTRY-swap-watch/2.0"}
DATE_RE = re.compile(r"(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日")

RAW_ROW_KEYS = (
    "date",
    "days",
    "lot_size",
    "sell_points",
    "buy_points",
    "sell_yen",
    "buy_yen",
    "sell_yen_per_day",
    "source_url",
)


def fetch_bytes(url: str, attempts: int = 3) -> bytes:
    last_error: Exception | None = None
    for attempt in range(attempts):
        try:
            request = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(request, timeout=30) as response:
                return response.read()
        except Exception as exc:
            last_error = exc
            if attempt + 1 < attempts:
                time.sleep(2 + attempt * 2)
    assert last_error is not None
    raise last_error


def fetch_html(url: str) -> str:
    raw = fetch_bytes(url)
    for encoding in ("utf-8", "cp932", "shift_jis"):
        try:
            return raw.decode(encoding)
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", errors="replace")


def strip_tags(fragment: str) -> str:
    fragment = re.sub(r"<br\s*/?>", " ", fragment, flags=re.I)
    fragment = re.sub(r"<[^>]+>", "", fragment)
    return " ".join(html_lib.unescape(fragment).replace("\xa0", " ").split())


def parse_number(value: str) -> float:
    value = value.replace(",", "").strip()
    if not value:
        raise ValueError("empty numeric cell")
    return float(value)


def parse_current_date(page_html: str) -> date:
    pair_pos = page_html.find("USD/JPY")
    prefix = page_html[:pair_pos] if pair_pos >= 0 else page_html[:12000]
    without_links = re.sub(r"<a\b[^>]*>.*?</a>", " ", prefix, flags=re.I | re.S)
    matches = DATE_RE.findall(strip_tags(without_links))
    if not matches:
        raise RuntimeError("Current swap date not found in Hirose page")
    y, m, d = map(int, matches[-1])
    return date(y, m, d)


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

    return {
        "days": days,
        "lot_size": lot_size,
        "sell_points": sell_points,
        "buy_points": buy_points,
        "sell_yen": sell_yen,
        "buy_yen": buy_yen,
        "sell_yen_per_day": round(sell_yen / days, 6) if days > 0 else None,
    }


def previous_link(page_html: str) -> tuple[date, str] | None:
    pattern = re.compile(r"<a\s+[^>]*href=[\"']([^\"']+)[\"'][^>]*>(.*?)</a>", flags=re.I | re.S)
    for href, body in pattern.findall(page_html):
        text = strip_tags(body)
        if "<<" not in text:
            continue
        match = DATE_RE.search(text)
        if not match:
            continue
        y, m, d = map(int, match.groups())
        return date(y, m, d), urllib.parse.urljoin(BASE, html_lib.unescape(href))
    return None


def load_existing() -> dict:
    if not OUT.exists():
        return {"meta": {}, "data": []}
    return json.loads(OUT.read_text(encoding="utf-8"))


def raw_row(row: dict) -> dict:
    return {key: row.get(key) for key in RAW_ROW_KEYS if key in row}


def build_swap_payload() -> dict:
    existing = load_existing()
    existing_rows = {
        row["date"]: raw_row(row)
        for row in existing.get("data", [])
        if row.get("date") and date.fromisoformat(row["date"]) >= START_DATE
    }
    existing_latest = max((date.fromisoformat(key) for key in existing_rows), default=None)

    current_url = SOURCE_PAGE
    page_html = fetch_html(current_url)
    current_date = parse_current_date(page_html)
    fetched = 0

    while current_date >= START_DATE:
        values = parse_usdtry_row(page_html)
        candidate = {
            "date": current_date.isoformat(),
            **values,
            "source_url": current_url,
        }
        existing_rows[candidate["date"]] = candidate
        fetched += 1
        print(
            f"swap {current_date.isoformat()} days={values['days']} "
            f"sell_yen={values['sell_yen']} per_day={values['sell_yen_per_day']}"
        )

        if existing_latest is not None and current_date <= existing_latest:
            break

        previous = previous_link(page_html)
        if previous is None:
            break
        previous_date, previous_url = previous
        if previous_date >= current_date:
            raise RuntimeError(f"Previous link did not move backward: {current_date} -> {previous_date}")
        if previous_date < START_DATE:
            break

        current_date, current_url = previous_date, previous_url
        time.sleep(0.5)
        page_html = fetch_html(current_url)

    data = [existing_rows[key] for key in sorted(existing_rows)]
    if not data:
        raise RuntimeError("No USD/TRY swap data collected")
    if date.fromisoformat(data[0]["date"]) != START_DATE:
        raise RuntimeError(f"Backfill did not reach {START_DATE}: first={data[0]['date']}")

    meta = {
        "schema_version": 2,
        "pair": "USD/TRY",
        "side": "sell",
        "lot_size": 1000,
        "start_date": START_DATE.isoformat(),
        "latest_date": data[-1]["date"],
        "records": len(data),
        "source_page": SOURCE_PAGE,
        "source_csv": SOURCE_CSV,
        "swap_source": "Hirose LION FX published swap table",
        "swap_normalization": "sell_yen / published accrual days; 0-day rows have no per-day value",
        "swap_updated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "pages_fetched_this_run": fetched,
    }
    return {"meta": meta, "data": data}


def main() -> None:
    payload = build_swap_payload()
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(
        f"wrote raw swap stage: {len(payload['data'])} records, "
        f"latest={payload['meta']['latest_date']}"
    )


if __name__ == "__main__":
    main()
