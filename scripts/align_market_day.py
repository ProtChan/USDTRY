from __future__ import annotations

import json
import math
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
TARGET_ANCHOR_HOUR_JST = 23
MAX_ANCHOR_DISTANCE_HOURS = 3
EXCLUDED_START_HOUR = 5
EXCLUDED_END_HOUR = 9
UA = {"User-Agent": "Mozilla/5.0 USDTRY-swap-watch/1.7"}


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


def yahoo_hourly_closes(symbol: str) -> dict[str, dict[str, float | int | str]]:
    """Return valid Yahoo 1h closes keyed by JST calendar-hour.

    Keying by local calendar-hour rather than raw epoch makes USD/TRY and USD/JPY
    align to the same labelled hourly observation even if a provider timestamp has a
    small sub-hour offset. Thin rollover observations are excluded completely.
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
    points: dict[str, dict[str, float | int | str]] = {}

    for ts, close in zip(timestamps, closes):
        if close is None:
            continue
        value = float(close)
        if not math.isfinite(value) or value <= 0:
            continue
        local = datetime.fromtimestamp(int(ts), timezone.utc).astimezone(JST)
        if EXCLUDED_START_HOUR <= local.hour < EXCLUDED_END_HOUR:
            continue
        hour_key = local.strftime("%Y-%m-%dT%H")
        points[hour_key] = {
            "value": value,
            "timestamp": int(ts),
            "date": local.date().isoformat(),
            "hour_jst": local.hour,
        }

    if not points:
        raise RuntimeError(f"Yahoo chart returned no usable hourly closes for {symbol}")
    return points


def same_timestamp_daily_anchors(
    usdtry: dict[str, dict[str, float | int | str]],
    usdjpy: dict[str, dict[str, float | int | str]],
) -> dict[str, dict[str, float | int | str]]:
    """Pick one common USDTRY/USDJPY hourly observation per JST day.

    Prefer the 23:00 JST observation. If it is missing, use the closest earlier
    observation within three hours. Both currency pairs must exist for the same
    JST hour, preventing cross-rate conversion from mixing unrelated intraday times.
    """
    common_keys = set(usdtry).intersection(usdjpy)
    by_day: dict[str, list[str]] = defaultdict(list)
    for key in common_keys:
        by_day[key[:10]].append(key)

    anchors: dict[str, dict[str, float | int | str]] = {}
    for day, keys in by_day.items():
        candidates = []
        for key in keys:
            hour = int(key[-2:])
            distance = TARGET_ANCHOR_HOUR_JST - hour
            if 0 <= distance <= MAX_ANCHOR_DISTANCE_HOURS:
                candidates.append((distance, -hour, key))
        if not candidates:
            continue
        _, _, key = min(candidates)
        a = usdtry[key]
        b = usdjpy[key]
        usdtry_value = float(a["value"])
        usdjpy_value = float(b["value"])
        anchors[day] = {
            "usdtry": round(usdtry_value, 8),
            "usdjpy": round(usdjpy_value, 8),
            "tryjpy": round(usdjpy_value / usdtry_value, 8),
            "timestamp": int(a["timestamp"]),
            "hour_jst": int(a["hour_jst"]),
            "anchor_distance_hours": TARGET_ANCHOR_HOUR_JST - int(a["hour_jst"]),
            "method": "same-timestamp-hourly-close",
        }
    return anchors


def on_or_before(
    series: dict[str, dict[str, float | int | str]],
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

    usdtry_hourly = yahoo_hourly_closes("USDTRY=X")
    time.sleep(0.7)
    usdjpy_hourly = yahoo_hourly_closes("USDJPY=X")
    anchors = same_timestamp_daily_anchors(usdtry_hourly, usdjpy_hourly)
    if not anchors:
        raise RuntimeError("No common USDTRY/USDJPY daily anchor observations")

    # Attach one fixed, same-timestamp representative rate to every Hirose row.
    for row in data:
        day = date.fromisoformat(row["date"])
        match = on_or_before(anchors, day, 1)
        if not match:
            for key in (
                "usdtry_rep_rate", "usdjpy_rep_rate", "tryjpy_rep_rate",
                "usdtry_rate_date", "usdjpy_rate_date",
                "usdtry_rate_samples", "usdjpy_rate_samples",
                "market_rate_timestamp", "market_rate_hour_jst",
                "market_rate_anchor_distance_hours", "market_rate_row_method",
            ):
                row[key] = None
            continue

        rate_date, anchor = match
        row["usdtry_rep_rate"] = float(anchor["usdtry"])
        row["usdjpy_rep_rate"] = float(anchor["usdjpy"])
        row["tryjpy_rep_rate"] = float(anchor["tryjpy"])
        row["usdtry_rate_date"] = rate_date
        row["usdjpy_rate_date"] = rate_date
        row["usdtry_rate_samples"] = 1
        row["usdjpy_rate_samples"] = 1
        row["market_rate_timestamp"] = int(anchor["timestamp"])
        row["market_rate_hour_jst"] = int(anchor["hour_jst"])
        row["market_rate_anchor_distance_hours"] = int(anchor["anchor_distance_hours"])
        row["market_rate_row_method"] = str(anchor["method"])

    # Assign FX P/L to the SAME starting Hirose row as its swap credit.
    # For a normal Thursday 3-day row this means 23:00 Thu -> 23:00 Fri.
    # Exceptional 3/4+ day swap rows use the exact same rule; no weekday assumption.
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

        # DAILY / interval FX: current fixed-time observation -> next Hirose row's
        # fixed-time observation. Divide by elapsed calendar days, never swap days.
        if index + 1 < len(data):
            next_row = data[index + 1]
            next_date = date.fromisoformat(next_row["date"])
            next_usdtry = next_row.get("usdtry_rep_rate")
            next_tryjpy = next_row.get("tryjpy_rep_rate")
            if isinstance(next_usdtry, (int, float)) and isinstance(next_tryjpy, (int, float)):
                delta = float(next_usdtry) - float(usdtry_now)
                loss_jpy_total = lot_usd * delta * float(next_tryjpy)
                interval_days = max(1, (next_date - day).days)
                row["usdtry_next_date"] = next_row["date"]
                row["usdtry_next_rate"] = round(float(next_usdtry), 8)
                row["usdtry_change"] = round(delta, 8)
                row["fx_interval_calendar_days"] = interval_days
                row["fx_cost_jpy_total"] = round(loss_jpy_total, 6)
                row["fx_cost_jpy_per_day"] = round(loss_jpy_total / interval_days, 6)
                row["fx_cost_jpy_accrual_total"] = round(loss_jpy_total, 6)

        # 7AVG remains a backward-looking 7-calendar-day deterioration rate, but now
        # both endpoints use the same fixed-time anchor definition.
        reference = on_or_before(anchors, day - timedelta(days=7), 4)
        if reference:
            ref_date, ref = reference
            ref_rate = float(ref["usdtry"])
            if ref_rate > 0:
                seven_day_change = float(usdtry_now) / ref_rate - 1.0
                fx_7d_per_day = lot_usd * float(usdjpy_now) * (seven_day_change / 7.0)
                row["usdtry_7d_ref_date"] = ref_date
                row["usdtry_7d_ref_rate"] = round(ref_rate, 8)
                row["usdtry_7d_change_pct"] = round(seven_day_change * 100.0, 8)
                row["fx_cost_7d_jpy_per_day"] = round(fx_7d_per_day, 6)

    meta = payload.setdefault("meta", {})
    meta.update({
        "description": "Hirose LION FX USD/TRY swap plus same-timestamp fixed-hour FX cost aligned to the same holding interval",
        "market_rate_source": "Yahoo Finance chart API: USDTRY=X and USDJPY=X",
        "market_rate_method": "same-timestamp Yahoo 1h close anchored at 23:00 JST; fallback to nearest earlier common hour within 3h; 05:00-08:59 JST excluded",
        "market_rate_history_start": (START_DATE - timedelta(days=MARKET_HISTORY_DAYS)).isoformat(),
        "fx_cost_method": "DAILY = current Hirose-row fixed-time USDTRY to next Hirose-row fixed-time USDTRY, assigned to the starting row and converted at the next row same-timestamp TRYJPY; divide by elapsed calendar days. 7AVG = backward-looking 7-calendar-day USDTRY deterioration / 7",
        "normalization": "swap=sell_yen/Hirose accrual days; DAILY FX cost=interval FX loss/elapsed calendar days, never divided by Hirose swap accrual days",
        "fx_cost_sign": "positive=FX loss/cost for USDTRY short, negative=FX gain",
        "market_day_boundary": "JST calendar day; same-timestamp anchor preferred at 23:00 JST",
        "market_rate_anchor_hour_jst": TARGET_ANCHOR_HOUR_JST,
        "market_rate_anchor_max_fallback_hours": MAX_ANCHOR_DISTANCE_HOURS,
        "excluded_hours_jst": "05:00-08:59",
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    })

    OUT.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    daily_count = sum(1 for row in data if row.get("fx_cost_jpy_per_day") is not None)
    avg7_count = sum(1 for row in data if row.get("fx_cost_7d_jpy_per_day") is not None)
    fallback_count = sum(
        1 for row in data
        if isinstance(row.get("market_rate_anchor_distance_hours"), int)
        and row["market_rate_anchor_distance_hours"] > 0
    )
    print(
        f"fixed-time market alignment complete: daily={daily_count}, rolling7={avg7_count}, "
        f"fallback_rows={fallback_count}, first={data[0]['date']}"
    )


if __name__ == "__main__":
    main()
