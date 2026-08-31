from __future__ import annotations

import json
import math
import statistics
import time
import urllib.parse
import urllib.request
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

OUT = Path("data/usdtry.json")
YAHOO_CHART = "https://query1.finance.yahoo.com/v8/finance/chart"
START_DATE = date(2026, 7, 1)
MARKET_HISTORY_DAYS = 16
NY = ZoneInfo("America/New_York")
UA = {"User-Agent": "Mozilla/5.0 USDTRY-swap-watch/1.5"}


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
                time.sleep(2 + attempt * 2)
    assert last_error is not None
    raise last_error


def hirose_trade_date(ts: int) -> str:
    """Map a timestamp to the FX trade date using the 17:00 New York rollover.

    Bars from 17:00 New York onward belong to the next FX trade date. This tracks
    US daylight-saving changes automatically (06:00 JST in summer, 07:00 JST in winter).
    """
    local = datetime.fromtimestamp(int(ts), timezone.utc).astimezone(NY)
    trade_day = local.date() + timedelta(days=1) if local.hour >= 17 else local.date()
    return trade_day.isoformat()


def yahoo_hourly_trade_day_median(symbol: str) -> dict[str, dict[str, float | int]]:
    # Fetch enough pre-history to calculate both the 7-day view and the 7/1 daily
    # change against the prior market day, while swap rows themselves still start 7/1.
    period1 = int(
        datetime.combine(
            START_DATE - timedelta(days=MARKET_HISTORY_DAYS),
            datetime.min.time(),
            tzinfo=timezone.utc,
        ).timestamp()
    )
    period2 = int((datetime.now(timezone.utc) + timedelta(days=1)).timestamp())
    query = urllib.parse.urlencode({
        "period1": period1,
        "period2": period2,
        "interval": "1h",
        "includePrePost": "false",
        "events": "history",
    })
    symbol_path = urllib.parse.quote(symbol, safe="")
    payload = json.loads(fetch_bytes(f"{YAHOO_CHART}/{symbol_path}?{query}").decode("utf-8"))
    result = (payload.get("chart") or {}).get("result") or []
    if not result:
        raise RuntimeError(f"Yahoo chart returned no result for {symbol}: {(payload.get('chart') or {}).get('error')}")

    body = result[0]
    timestamps = body.get("timestamp") or []
    closes = (((body.get("indicators") or {}).get("quote") or [{}])[0]).get("close") or []
    grouped: dict[str, list[float]] = defaultdict(list)

    for ts, close in zip(timestamps, closes):
        if close is None:
            continue
        value = float(close)
        if not math.isfinite(value) or value <= 0:
            continue
        grouped[hirose_trade_date(int(ts))].append(value)

    return {
        day: {"median": round(float(statistics.median(values)), 8), "samples": len(values)}
        for day, values in grouped.items()
        if values
    }


def on_or_before(
    series: dict[str, dict[str, float | int]],
    target: date,
    lookback: int = 4,
):
    for offset in range(lookback + 1):
        key = (target - timedelta(days=offset)).isoformat()
        if key in series:
            return key, series[key]
    return None


def previous_market_day(
    series: dict[str, dict[str, float | int]],
    target: date,
    lookback: int = 7,
):
    for offset in range(1, lookback + 1):
        key = (target - timedelta(days=offset)).isoformat()
        if key in series:
            return key, series[key]
    return None


def main() -> None:
    payload = json.loads(OUT.read_text(encoding="utf-8"))
    data = payload.get("data") or []
    if not data:
        raise RuntimeError("No swap data to enrich")

    usdtry = yahoo_hourly_trade_day_median("USDTRY=X")
    time.sleep(0.7)
    usdjpy = yahoo_hourly_trade_day_median("USDJPY=X")

    for row in data:
        day = date.fromisoformat(row["date"])
        a_match = on_or_before(usdtry, day, 1)
        b_match = on_or_before(usdjpy, day, 1)
        if not (a_match and b_match):
            for key in (
                "usdtry_rep_rate", "usdjpy_rep_rate", "tryjpy_rep_rate",
                "usdtry_rate_date", "usdjpy_rate_date",
                "usdtry_rate_samples", "usdjpy_rate_samples",
            ):
                row[key] = None
            continue

        a_date, a = a_match
        b_date, b = b_match
        usdtry_now = float(a["median"])
        usdjpy_now = float(b["median"])
        row["usdtry_rep_rate"] = usdtry_now
        row["usdjpy_rep_rate"] = usdjpy_now
        row["tryjpy_rep_rate"] = round(usdjpy_now / usdtry_now, 8)
        row["usdtry_rate_date"] = a_date
        row["usdjpy_rate_date"] = b_date
        row["usdtry_rate_samples"] = int(a["samples"])
        row["usdjpy_rate_samples"] = int(b["samples"])

    for row in data:
        day = date.fromisoformat(row["date"])
        row["usdtry_prev_date"] = None
        row["usdtry_prev_rate"] = None
        row["usdtry_change"] = None
        row["fx_cost_jpy_total"] = None
        row["fx_cost_jpy_per_day"] = None
        row["fx_cost_jpy_accrual_total"] = None
        row["usdtry_7d_ref_date"] = None
        row["usdtry_7d_ref_rate"] = None
        row["usdtry_7d_change_pct"] = None
        row["fx_cost_7d_jpy_per_day"] = None

        usdtry_now = row.get("usdtry_rep_rate")
        usdjpy_now = row.get("usdjpy_rep_rate")
        tryjpy_now = row.get("tryjpy_rep_rate")
        if not (
            isinstance(usdtry_now, (int, float))
            and isinstance(usdjpy_now, (int, float))
            and isinstance(tryjpy_now, (int, float))
        ):
            continue

        lot_usd = float(row.get("lot_size") or 1000)
        accrual_days = int(row.get("days") or 0)

        # DAILY: compare the trade-day median against the immediately preceding
        # available market trade day. This gives 2026-07-01 a 2026-06-30 reference.
        previous = previous_market_day(usdtry, day, 7)
        if previous:
            prev_date, prev = previous
            prev_rate = float(prev["median"])
            delta = float(usdtry_now) - prev_rate
            loss_jpy_total = lot_usd * delta * float(tryjpy_now)
            row["usdtry_prev_date"] = prev_date
            row["usdtry_prev_rate"] = round(prev_rate, 8)
            row["usdtry_change"] = round(delta, 8)
            row["fx_cost_jpy_total"] = round(loss_jpy_total, 6)
            row["fx_cost_jpy_per_day"] = (
                round(loss_jpy_total / accrual_days, 6) if accrual_days > 0 else None
            )
            row["fx_cost_jpy_accrual_total"] = round(loss_jpy_total, 6)

        # 7AVG: use a genuine 7-calendar-day deterioration rate from market data,
        # not a moving average of displayed DAILY rows. Pre-history lets this exist
        # from the first displayed swap date (2026-07-01).
        reference = on_or_before(usdtry, day - timedelta(days=7), 4)
        if reference:
            ref_date, ref = reference
            ref_rate = float(ref["median"])
            if ref_rate > 0:
                seven_day_change = float(usdtry_now) / ref_rate - 1.0
                fx_7d_per_day = lot_usd * float(usdjpy_now) * (seven_day_change / 7.0)
                row["usdtry_7d_ref_date"] = ref_date
                row["usdtry_7d_ref_rate"] = round(ref_rate, 8)
                row["usdtry_7d_change_pct"] = round(seven_day_change * 100.0, 8)
                row["fx_cost_7d_jpy_per_day"] = round(fx_7d_per_day, 6)

    meta = payload.setdefault("meta", {})
    meta.update({
        "description": "Hirose LION FX USD/TRY swap plus NY-close-aligned daily and rolling-7-day FX cost",
        "market_rate_source": "Yahoo Finance chart API: USDTRY=X and USDJPY=X",
        "market_rate_method": "Median of 1-hour closes grouped by Hirose/FX trade day at 17:00 America/New_York rollover; daily high/low are not used",
        "market_rate_history_start": (START_DATE - timedelta(days=MARKET_HISTORY_DAYS)).isoformat(),
        "fx_cost_method": "DAILY = prior available market trade-day representative-rate change; 7AVG = 7-calendar-day USDTRY deterioration / 7, both converted to JPY",
        "normalization": "swap=sell_yen/days; DAILY FX cost is divided by Hirose accrual days; 7AVG is a 7-calendar-day deterioration rate normalized directly to one day",
        "fx_cost_sign": "positive=FX loss/cost for USDTRY short, negative=FX gain",
        "market_day_boundary": "17:00 America/New_York (06:00 JST during US DST, 07:00 JST during US standard time)",
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    })

    OUT.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    daily_count = sum(1 for row in data if row.get("fx_cost_jpy_per_day") is not None)
    avg7_count = sum(1 for row in data if row.get("fx_cost_7d_jpy_per_day") is not None)
    print(
        f"aligned market-day enrichment complete: daily={daily_count}, "
        f"rolling7={avg7_count}, first={data[0]['date']}"
    )


if __name__ == "__main__":
    main()
