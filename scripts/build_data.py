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
UA = {"User-Agent": "Mozilla/5.0 USDTRY-swap-watch/1.2"}
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
    # Seven-day deterioration needs a reference before the first displayed date.
    period1 = int(datetime.combine(START_DATE - timedelta(days=12), datetime.min.time(), tzinfo=timezone.utc).timestamp())
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


def rate_on_or_before(series: dict[str, dict[str, float | int]], target: date, max_lookback: int = 4) -> tuple[str, dict[str, float | int]] | None:
    for offset in range(max_lookback + 1):
        key = (target - timedelta(days=offset)).isoformat()
        value = series.get(key)
        if value:
            return key, value
    return None


def enrich_market_rates(data: list[dict]) -> bool:
    """Attach robust representative rates and rolling 7-day FX deterioration cost.

    The user's intended cost model is:
      weekly deterioration = USDTRY_now / USDTRY_7d_reference - 1
      daily deterioration  = weekly deterioration / 7
      JPY cost per day      = lot_USD * representative_USDJPY * daily deterioration

    Positive values mean FX loss/cost for a USD/TRY short; negative values mean
    the seven-day move was favorable (FX gain). For multi-day swap accrual rows,
    the associated total FX cost is per-day cost * accrual days, so normalizing
    that total by accrual days returns the same daily cost.
    """
    try:
        usdtry = yahoo_hourly_daily_median("USDTRY=X")
        time.sleep(0.7)
        usdjpy = yahoo_hourly_daily_median("USDJPY=X")
    except Exception as exc:
        print(f"market-rate enrichment skipped: {exc}")
        return False

    for row in data:
        day_date = date.fromisoformat(row["date"])
        current_usdtry = rate_on_or_before(usdtry, day_date, 1)
        current_usdjpy = rate_on_or_before(usdjpy, day_date, 1)

        if current_usdtry and current_usdjpy:
            usdtry_date, a = current_usdtry
            usdjpy_date, b = current_usdjpy
            usdtry_now = float(a["median"])
            usdjpy_now = float(b["median"])
            row["usdtry_rep_rate"] = usdtry_now
            row["usdjpy_rep_rate"] = usdjpy_now
            row["tryjpy_rep_rate"] = round(usdjpy_now / usdtry_now, 8)
            row["usdtry_rate_date"] = usdtry_date
            row["usdjpy_rate_date"] = usdjpy_date
            row["usdtry_rate_samples"] = int(a["samples"])
            row["usdjpy_rate_samples"] = int(b["samples"])

            reference = rate_on_or_before(usdtry, day_date - timedelta(days=7), 4)
            if reference:
                ref_date, ref = reference
                ref_rate = float(ref["median"])
                weekly_change = usdtry_now / ref_rate - 1.0
                daily_change = weekly_change / 7.0
                lot_usd = float(row.get("lot_size") or 1000)
                fx_cost_per_day = lot_usd * usdjpy_now * daily_change
                accrual_days = int(row.get("days") or 0)

                row["usdtry_7d_ref_date"] = ref_date
                row["usdtry_7d_ref_rate"] = round(ref_rate, 8)
                row["usdtry_7d_change_pct"] = round(weekly_change * 100.0, 8)
                row["usdtry_daily_change_pct"] = round(daily_change * 100.0, 8)
                row["fx_cost_jpy_per_day"] = round(fx_cost_per_day, 6)
                row["fx_cost_jpy_accrual_total"] = round(fx_cost_per_day * accrual_days, 6)
            else:
                row["usdtry_7d_ref_date"] = None
                row["usdtry_7d_ref_rate"] = None
                row["usdtry_7d_change_pct"] = None
                row["usdtry_daily_change_pct"] = None
                row["fx_cost_jpy_per_day"] = None
                row["fx_cost_jpy_accrual_total"] = None
        else:
            row["fx_cost_jpy_per_day"] = None
            row["fx_cost_jpy_accrual_total"] = None

        # Remove the superseded previous-day P/L fields so the JSON has one
        # unambiguous FX-cost definition.
        for old_key in ("usdtry_change", "fx_pnl_jpy_total", "fx_pnl_jpy_per_day"):
            row.pop(old_key, None)

    return True


def static_meta_for(data: list[dict]) -> dict:
    return {
        "pair": "USD/TRY",
        "side": "sell",
        "description": "Hirose LION FX USD/TRY sell swap plus rolling 7-day representative-rate FX deterioration cost",
        "start_date": START_DATE.isoformat(),
        "latest_date": data[-1]["date"],
        "lot_size": 1000,
        "source_page": SOURCE_PAGE,
        "source_csv": SOURCE_CSV,
        "market_rate_source": "Yahoo Finance chart API: USDTRY=X and USDJPY=X",
        "market_rate_method": "UTC calendar-day median of 1-hour closing prices; daily high/low are not used",
        "fx_cost_method": "(USDTRY representative rate / representative rate about 7 calendar days earlier - 1) / 7 * lot_USD * representative USDJPY",
        "normalization": "swap=sell_yen/days; FX deterioration uses rolling 7-calendar-day percentage change divided by 7; multi-day accrual total=fx_cost_per_day*days",
        "fx_cost_sign": "positive=FX loss/cost for USDTRY short, negative=FX gain",
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
        fx_count = sum(1 for row in data if row.get("fx_cost_jpy_per_day") is not None)
        print(f"market-rate enrichment complete: {fx_count} rolling FX-cost observations")

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
