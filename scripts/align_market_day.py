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
JST = ZoneInfo("Asia/Tokyo")
EXCLUDED_START_HOUR = 5
EXCLUDED_END_HOUR = 9
UA = {"User-Agent": "Mozilla/5.0 USDTRY-swap-watch/1.6"}


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


def yahoo_hourly_fixed_daily_median(symbol: str) -> dict[str, dict[str, float | int]]:
    """Build a stable JST-calendar-day representative rate.

    USD/TRY repeatedly reprices around the rollover / thin-liquidity window. To avoid
    using that transient 05:00-08:59 JST move as the day's representative level, those
    four hourly closes are excluded and the median of the remaining closes is used.
    """
    period1 = int(
        datetime.combine(
            START_DATE - timedelta(days=MARKET_HISTORY_DAYS),
            datetime.min.time(),
            tzinfo=timezone.utc,
        ).timestamp()
    )
    period2 = int((datetime.now(timezone.utc) + timedelta(days=2)).timestamp())
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
        local = datetime.fromtimestamp(int(ts), timezone.utc).astimezone(JST)
        if EXCLUDED_START_HOUR <= local.hour < EXCLUDED_END_HOUR:
            continue
        grouped[local.date().isoformat()].append(value)

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


def main() -> None:
    payload = json.loads(OUT.read_text(encoding="utf-8"))
    data = payload.get("data") or []
    if not data:
        raise RuntimeError("No swap data to enrich")

    usdtry = yahoo_hourly_fixed_daily_median("USDTRY=X")
    time.sleep(0.7)
    usdjpy = yahoo_hourly_fixed_daily_median("USDJPY=X")

    # First attach one fixed representative rate to every Hirose calendar row.
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

    # Assign FX P/L to the SAME starting Hirose row as its swap credit.
    # Example: Thursday's row contains Thursday->Friday FX deterioration and Thursday's
    # 3-day swap credit. This makes the economic holding interval line up on one x-axis.
    for index, row in enumerate(data):
        day = date.fromisoformat(row["date"])
        row["usdtry_prev_date"] = None
        row["usdtry_prev_rate"] = None
        row["usdtry_next_date"] = None
        row["usdtry_next_rate"] = None
        row["usdtry_change"] = None
        row["fx_interval_calendar_days"] = None
        row["fx_cost_jpy_total"] = None
        row["fx_cost_jpy_per_day"] = None
        row["fx_cost_jpy_accrual_total"] = None
        row["usdtry_7d_ref_date"] = None
        row["usdtry_7d_ref_rate"] = None
        row["usdtry_7d_change_pct"] = None
        row["fx_cost_7d_jpy_per_day"] = None

        usdtry_now = row.get("usdtry_rep_rate")
        usdjpy_now = row.get("usdjpy_rep_rate")
        if not (
            isinstance(usdtry_now, (int, float))
            and isinstance(usdjpy_now, (int, float))
        ):
            continue

        lot_usd = float(row.get("lot_size") or 1000)

        # DAILY / interval FX: current Hirose row -> next Hirose row.
        # Divide only by elapsed calendar days, NOT by swap accrual days. Therefore a
        # Thursday triple-swap row keeps its full one-day Thu->Fri FX move.
        if index + 1 < len(data):
            next_row = data[index + 1]
            next_date = date.fromisoformat(next_row["date"])
            next_usdtry = next_row.get("usdtry_rep_rate")
            next_usdjpy = next_row.get("usdjpy_rep_rate")
            if isinstance(next_usdtry, (int, float)) and isinstance(next_usdjpy, (int, float)):
                delta = float(next_usdtry) - float(usdtry_now)
                next_tryjpy = float(next_usdjpy) / float(next_usdtry)
                loss_jpy_total = lot_usd * delta * next_tryjpy
                interval_days = max(1, (next_date - day).days)
                row["usdtry_next_date"] = next_row["date"]
                row["usdtry_next_rate"] = round(float(next_usdtry), 8)
                row["usdtry_change"] = round(delta, 8)
                row["fx_interval_calendar_days"] = interval_days
                row["fx_cost_jpy_total"] = round(loss_jpy_total, 6)
                row["fx_cost_jpy_per_day"] = round(loss_jpy_total / interval_days, 6)
                row["fx_cost_jpy_accrual_total"] = round(loss_jpy_total, 6)

        # 7AVG remains a smooth backward-looking 7-calendar-day deterioration rate,
        # now based on the same stable fixed-rate definition.
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
        "description": "Hirose LION FX USD/TRY swap plus stable-hourly fixed-rate FX cost aligned to the same holding interval",
        "market_rate_source": "Yahoo Finance chart API: USDTRY=X and USDJPY=X",
        "market_rate_method": "JST calendar-day median of 1-hour closes excluding 05:00-08:59 JST; daily high/low are not used",
        "market_rate_history_start": (START_DATE - timedelta(days=MARKET_HISTORY_DAYS)).isoformat(),
        "fx_cost_method": "DAILY = current Hirose-row fixed USDTRY to next Hirose-row fixed USDTRY, assigned to the starting row and converted at the next row TRYJPY; divide by elapsed calendar days. 7AVG = backward-looking 7-calendar-day USDTRY deterioration / 7",
        "normalization": "swap=sell_yen/Hirose accrual days; DAILY FX cost=interval FX loss/elapsed calendar days, never divided by Hirose swap accrual days",
        "fx_cost_sign": "positive=FX loss/cost for USDTRY short, negative=FX gain",
        "market_day_boundary": "JST calendar day with 05:00-08:59 excluded from representative-rate calculation",
        "excluded_hours_jst": "05:00-08:59",
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    })

    OUT.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    daily_count = sum(1 for row in data if row.get("fx_cost_jpy_per_day") is not None)
    avg7_count = sum(1 for row in data if row.get("fx_cost_7d_jpy_per_day") is not None)
    print(
        f"stable fixed-rate enrichment complete: daily={daily_count}, "
        f"rolling7={avg7_count}, first={data[0]['date']}"
    )


if __name__ == "__main__":
    main()
