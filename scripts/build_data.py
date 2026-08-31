from __future__ import annotations

import html as html_lib
import json
import math
import re
import statistics
import time
import urllib.parse
import urllib.request
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

BASE = "https://hirose-fx.co.jp"
SOURCE_PAGE = f"{BASE}/contents/news/Swap"
SOURCE_CSV = f"{BASE}/swap/lionfx_swap.csv"
YAHOO_CHART = "https://query1.finance.yahoo.com/v8/finance/chart"
START_DATE = date(2026, 7, 1)
OUT = Path("data/usdtry.json")
UA = {"User-Agent": "Mozilla/5.0 USDTRY-swap-watch/1.1"}
DATE_RE = re.compile(r"(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日")


def fetch_bytes(url: str, attempts: int = 3) -> bytes:
    last_error: Exception | None = None
    for attempt in range(attempts):
        try:
            req = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, timeout=30) as response:
                return response.read()
        except Exception as exc:
            last_error = exc
            if attempt + 1 < attempts:
                time.sleep(2.0 + attempt * 2.0)
    assert last_error is not None
    raise last_error


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
    text = strip_tags(without_links)
    matches = DATE_RE.findall(text)
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
    for href, body in anchor_pattern.findall(page_html):
        text = strip_tags(body)
        if "<<" not in text:
            continue
        match = DATE_RE.search(text)
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


def yahoo_hourly_daily_median(symbol: str) -> dict[str, dict[str, float | int]]:
    """Return a robust daily representative price from the median of hourly closes.

    We deliberately do not use the day's high or low. Grouping is by UTC calendar
    date so the calculation is deterministic on every Actions run.
    """
    period1 = int(datetime.combine(START_DATE - timedelta(days=3), datetime.min.time(), tzinfo=timezone.utc).timestamp())
    period2 = int((datetime.now(timezone.utc) + timedelta(days=1)).timestamp())
    query = urllib.parse.urlencode(
        {
            "period1": period1,
            "period2": period2,
            "interval": "1h",
            "includePrePost": "false",
            "events": "history",
        }
    )
    symbol_path = urllib.parse.quote(symbol, safe="")
    url = f"{YAHOO_CHART}/{symbol_path}?{query}"
    payload = json.loads(fetch_bytes(url).decode("utf-8"))
    result = (payload.get("chart") or {}).get("result") or []
    if not result:
        raise RuntimeError(f"Yahoo chart returned no result for {symbol}: {(payload.get('chart') or {}).get('error')}")

    body = result[0]
    timestamps = body.get("timestamp") or []
    quote = ((body.get("indicators") or {}).get("quote") or [{}])[0]
    closes = quote.get("close") or []
    grouped: dict[str, list[float]] = defaultdict(list)

    for ts, close in zip(timestamps, closes):
        if close is None:
            continue
        value = float(close)
        if not math.isfinite(value) or value <= 0:
            continue
        day = datetime.fromtimestamp(int(ts), timezone.utc).date().isoformat()
        grouped[day].append(value)

    if not grouped:
        raise RuntimeError(f"Yahoo chart returned no usable hourly closes for {symbol}")

    return {
        day: {
            "median": round(float(statistics.median(values)), 8),
            "samples": len(values),
        }
        for day, values in grouped.items()
        if values
    }


def enrich_market_rates(data: list[dict]) -> bool:
    """Attach representative rates and signed JPY FX P/L for a USD/TRY short.

    Short USD/TRY P/L in TRY = -lot * (USDTRY_t - USDTRY_t-1).
    The TRY P/L is converted with that day's representative TRY/JPY cross and,
    when Hirose grants multiple swap days, divided by the same accrual-day count.
    Negative values therefore mean FX loss and positive values mean FX gain.
    """
    try:
        usdtry = yahoo_hourly_daily_median("USDTRY=X")
        time.sleep(0.7)
        usdjpy = yahoo_hourly_daily_median("USDJPY=X")
    except Exception as exc:
        print(f"market-rate enrichment skipped: {exc}")
        return False

    for row in data:
        day = row["date"]
        a = usdtry.get(day)
        b = usdjpy.get(day)
        if a and b:
            row["usdtry_rep_rate"] = a["median"]
            row["usdjpy_rep_rate"] = b["median"]
            row["tryjpy_rep_rate"] = round(float(b["median"]) / float(a["median"]), 8)
            row["usdtry_rate_samples"] = int(a["samples"])
            row["usdjpy_rate_samples"] = int(b["samples"])

    previous: dict | None = None
    for row in data:
        usdtry_now = row.get("usdtry_rep_rate")
        tryjpy_now = row.get("tryjpy_rep_rate")
        if not (isinstance(usdtry_now, (int, float)) and isinstance(tryjpy_now, (int, float))):
            row["usdtry_change"] = None
            row["fx_pnl_jpy_total"] = None
            row["fx_pnl_jpy_per_day"] = None
            continue

        if previous is None:
            row["usdtry_change"] = None
            row["fx_pnl_jpy_total"] = None
            row["fx_pnl_jpy_per_day"] = None
        else:
            delta = float(usdtry_now) - float(previous["usdtry_rep_rate"])
            pnl_try = -float(row.get("lot_size") or 1000) * delta
            pnl_jpy_total = pnl_try * float(tryjpy_now)
            days = int(row.get("days") or 0)
            row["usdtry_change"] = round(delta, 8)
            row["fx_pnl_jpy_total"] = round(pnl_jpy_total, 6)
            row["fx_pnl_jpy_per_day"] = round(pnl_jpy_total / days, 6) if days > 0 else None

        previous = row

    return True


def static_meta_for(data: list[dict]) -> dict:
    return {
        "pair": "USD/TRY",
        "side": "sell",
        "description": "Hirose LION FX USD/TRY sell swap plus representative-rate FX P/L, JPY normalized per accrual day",
        "start_date": START_DATE.isoformat(),
        "latest_date": data[-1]["date"],
        "lot_size": 1000,
        "source_page": SOURCE_PAGE,
        "source_csv": SOURCE_CSV,
        "market_rate_source": "Yahoo Finance chart API: USDTRY=X and USDJPY=X",
        "market_rate_method": "UTC calendar-day median of 1-hour closing prices; daily high/low are not used",
        "normalization": "swap=sell_yen/days; fx_pnl=short USDTRY representative-rate change converted via representative TRYJPY, then divided by days; 0-day rows are null",
        "fx_pnl_sign": "negative=FX loss for USDTRY short, positive=FX gain",
        "records": len(data),
    }


def main() -> None:
    existing = load_existing()
    by_date = {item["date"]: item for item in existing.get("data", []) if item.get("date")}
    existing_dates = [date.fromisoformat(d) for d in by_date]
    existing_latest = max(existing_dates) if existing_dates else None

    current_url = SOURCE_PAGE
    page_html = fetch_html(current_url)
    current_date = parse_current_date(page_html)
    fetched = 0

    while current_date >= START_DATE:
        values = parse_usdtry_row(page_html)
        old = by_date.get(current_date.isoformat(), {})
        candidate = {
            **old,
            "date": current_date.isoformat(),
            **values,
            "source_url": current_url,
        }
        by_date[candidate["date"]] = candidate
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
        if prev_date < START_DATE:
            break

        current_date, current_url = prev_date, prev_url
        time.sleep(0.5)
        page_html = fetch_html(current_url)

    data = [by_date[k] for k in sorted(by_date) if date.fromisoformat(k) >= START_DATE]
    if not data:
        raise RuntimeError("No USD/TRY data collected")
    if date.fromisoformat(data[0]["date"]) != START_DATE:
        raise RuntimeError(f"Backfill did not reach {START_DATE}: first={data[0]['date']}")

    enriched = enrich_market_rates(data)
    if enriched:
        fx_count = sum(1 for row in data if row.get("fx_pnl_jpy_per_day") is not None)
        print(f"market-rate enrichment complete: {fx_count} FX P/L observations")

    static_meta = static_meta_for(data)
    old_meta = existing.get("meta", {})
    relevant_old_meta = {key: old_meta.get(key) for key in static_meta}
    if existing.get("data") == data and relevant_old_meta == static_meta:
        print(f"already up to date: {data[-1]['date']}")
        return

    meta = {
        **static_meta,
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "pages_fetched_this_run": fetched,
    }

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({"meta": meta, "data": data}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {OUT}: {len(data)} records, latest={data[-1]['date']}, fetched={fetched}")


if __name__ == "__main__":
    main()
