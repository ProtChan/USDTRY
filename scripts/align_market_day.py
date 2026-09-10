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
UA = {"User-Agent": "Mozilla/5.0 USDTRY-swap-watch/2.0"}


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


def yahoo_hourly_closes(symbol: str) -> dict[str, dict[str, float | int | str]]:
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
        key = local.strftime("%Y-%m-%dT%H")
        points[key] = {
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
    common_keys = set(usdtry).intersection(usdjpy)
    by_day: dict[str, list[str]] = defaultdict(list)
    for key in common_keys:
        by_day[key[:10]].append(key)

    anchors: dict[str, dict[str, float | int | str]] = {}
    for day, keys in by_day.items():
        candidates: list[tuple[int, int, str]] = []
        for key in keys:
            hour = int(key[-2:])
            distance = TARGET_ANCHOR_HOUR_JST - hour
            if 0 <= distance <= MAX_ANCHOR_DISTANCE_HOURS:
                candidates.append((distance, -hour, key))
        if not candidates:
            continue

        _, _, key = min(candidates)
        usdtry_point = usdtry[key]
        usdjpy_point = usdjpy[key]
        usdtry_value = float(usdtry_point["value"])
        usdjpy_value = float(usdjpy_point["value"])
        anchors[day] = {
            "usdtry": round(usdtry_value, 8),
            "usdjpy": round(usdjpy_value, 8),
            "tryjpy": round(usdjpy_value / usdtry_value, 8),
            "timestamp": int(usdtry_point["timestamp"]),
            "hour_jst": int(usdtry_point["hour_jst"]),
            "anchor_distance_hours": TARGET_ANCHOR_HOUR_JST - int(usdtry_point["hour_jst"]),
        }
    return anchors


def on_or_before(series: dict, target: date, lookback: int = 4):
    for offset in range(lookback + 1):
        key = (target - timedelta(days=offset)).isoformat()
        if key in series:
            return key, series[key]
    return None


def enrich_payload(payload: dict) -> dict:
    data = payload.get("data") or []
    if not data:
        raise RuntimeError("No swap rows to enrich")

    usdtry_hourly = yahoo_hourly_closes("USDTRY=X")
    time.sleep(0.7)
    usdjpy_hourly = yahoo_hourly_closes("USDJPY=X")
    anchors = same_timestamp_daily_anchors(usdtry_hourly, usdjpy_hourly)
    if not anchors:
        raise RuntimeError("No common USDTRY/USDJPY fixed-time anchors")

    for row in data:
        day = date.fromisoformat(row["date"])
        match = on_or_before(anchors, day, 1)
        if not match:
            row.update({
                "usdtry_rep_rate": None,
                "usdjpy_rep_rate": None,
                "tryjpy_rep_rate": None,
                "usdtry_rate_date": None,
                "usdjpy_rate_date": None,
                "market_rate_timestamp": None,
                "market_rate_hour_jst": None,
                "market_rate_anchor_distance_hours": None,
                "market_rate_row_method": None,
            })
            continue

        rate_date, anchor = match
        row.update({
            "usdtry_rep_rate": float(anchor["usdtry"]),
            "usdjpy_rep_rate": float(anchor["usdjpy"]),
            "tryjpy_rep_rate": float(anchor["tryjpy"]),
            "usdtry_rate_date": rate_date,
            "usdjpy_rate_date": rate_date,
            "market_rate_timestamp": int(anchor["timestamp"]),
            "market_rate_hour_jst": int(anchor["hour_jst"]),
            "market_rate_anchor_distance_hours": int(anchor["anchor_distance_hours"]),
            "market_rate_row_method": "same-timestamp-hourly-close",
        })

    for index, row in enumerate(data):
        day = date.fromisoformat(row["date"])
        row.update({
            "usdtry_next_date": None,
            "usdtry_next_rate": None,
            "usdtry_change": None,
            "fx_interval_calendar_days": None,
            "fx_cost_jpy_total": None,
            "fx_cost_jpy_per_day": None,
            "usdtry_7d_ref_date": None,
            "usdtry_7d_ref_rate": None,
            "usdtry_7d_change_pct": None,
            "fx_cost_7d_jpy_per_day": None,
        })

        usdtry_now = row.get("usdtry_rep_rate")
        usdjpy_now = row.get("usdjpy_rep_rate")
        if not isinstance(usdtry_now, (int, float)) or not isinstance(usdjpy_now, (int, float)):
            continue

        lot_usd = float(row.get("lot_size") or payload.get("meta", {}).get("lot_size") or 1000)

        if index + 1 < len(data):
            next_row = data[index + 1]
            next_date = date.fromisoformat(next_row["date"])
            next_usdtry = next_row.get("usdtry_rep_rate")
            next_tryjpy = next_row.get("tryjpy_rep_rate")
            if isinstance(next_usdtry, (int, float)) and isinstance(next_tryjpy, (int, float)):
                delta = float(next_usdtry) - float(usdtry_now)
                interval_days = max(1, (next_date - day).days)
                fx_cost_total = lot_usd * delta * float(next_tryjpy)
                row.update({
                    "usdtry_next_date": next_row["date"],
                    "usdtry_next_rate": round(float(next_usdtry), 8),
                    "usdtry_change": round(delta, 8),
                    "fx_interval_calendar_days": interval_days,
                    "fx_cost_jpy_total": round(fx_cost_total, 6),
                    "fx_cost_jpy_per_day": round(fx_cost_total / interval_days, 6),
                })

        reference = on_or_before(anchors, day - timedelta(days=7), 4)
        if reference:
            ref_date, ref = reference
            ref_rate = float(ref["usdtry"])
            if ref_rate > 0:
                seven_day_change = float(usdtry_now) / ref_rate - 1.0
                row.update({
                    "usdtry_7d_ref_date": ref_date,
                    "usdtry_7d_ref_rate": round(ref_rate, 8),
                    "usdtry_7d_change_pct": round(seven_day_change * 100.0, 8),
                    "fx_cost_7d_jpy_per_day": round(
                        lot_usd * float(usdjpy_now) * (seven_day_change / 7.0), 6
                    ),
                })

    meta = payload.setdefault("meta", {})
    meta.update({
        "description": "Hirose USD/TRY sell swap with fixed-time FX-cost intervals",
        "market_rate_source": "Yahoo Finance chart API: USDTRY=X and USDJPY=X",
        "market_rate_method": "same timestamp 1h close at 23:00 JST; fallback to nearest earlier common hour within 3h",
        "market_rate_anchor_hour_jst": TARGET_ANCHOR_HOUR_JST,
        "market_rate_anchor_max_fallback_hours": MAX_ANCHOR_DISTANCE_HOURS,
        "market_rate_history_start": (START_DATE - timedelta(days=MARKET_HISTORY_DAYS)).isoformat(),
        "fx_cost_method": "current fixed-time USDTRY to next Hirose-row fixed-time USDTRY, converted at next-row TRYJPY",
        "fx_cost_daily_method": "interval FX cost divided by elapsed calendar days",
        "fx_cost_sign": "positive=FX loss for USDTRY short; negative=FX gain",
        "market_updated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    })
    return payload


def main() -> None:
    payload = json.loads(OUT.read_text(encoding="utf-8"))
    enrich_payload(payload)
    OUT.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    daily_count = sum(1 for row in payload["data"] if row.get("fx_cost_jpy_per_day") is not None)
    fallback_count = sum(1 for row in payload["data"] if (row.get("market_rate_anchor_distance_hours") or 0) > 0)
    print(f"market enrichment complete: daily={daily_count}, fallback_rows={fallback_count}")


if __name__ == "__main__":
    main()
