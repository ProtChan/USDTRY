from __future__ import annotations

import json
import math
from datetime import date

from align_market_day import enrich_payload
from build_data import OUT, build_swap_payload


def finite_number(value) -> bool:
    return isinstance(value, (int, float)) and math.isfinite(float(value))


def validate_payload(payload: dict) -> None:
    meta = payload.get("meta") or {}
    rows = payload.get("data") or []
    if not rows:
        raise RuntimeError("validation: no rows")

    dates = [row.get("date") for row in rows]
    if any(not value for value in dates):
        raise RuntimeError("validation: row without date")
    if dates != sorted(dates) or len(dates) != len(set(dates)):
        raise RuntimeError("validation: dates must be unique and sorted")
    if meta.get("latest_date") != dates[-1] or meta.get("records") != len(rows):
        raise RuntimeError("validation: metadata does not match rows")

    for index, row in enumerate(rows):
        days = int(row.get("days") or 0)
        sell_yen = float(row.get("sell_yen") or 0)
        per_day = row.get("sell_yen_per_day")
        if days > 0:
            expected = sell_yen / days
            if not finite_number(per_day) or abs(float(per_day) - expected) > 1e-5:
                raise RuntimeError(f"validation: swap normalization mismatch at {row['date']}")
        elif per_day is not None:
            raise RuntimeError(f"validation: 0-day row must not have per-day swap at {row['date']}")

        rate_date_a = row.get("usdtry_rate_date")
        rate_date_b = row.get("usdjpy_rate_date")
        if rate_date_a != rate_date_b:
            raise RuntimeError(f"validation: cross-rate dates differ at {row['date']}")

        if finite_number(row.get("usdtry_rep_rate")) and finite_number(row.get("usdjpy_rep_rate")):
            implied_tryjpy = float(row["usdjpy_rep_rate"]) / float(row["usdtry_rep_rate"])
            if not finite_number(row.get("tryjpy_rep_rate")) or abs(float(row["tryjpy_rep_rate"]) - implied_tryjpy) > 1e-6:
                raise RuntimeError(f"validation: TRYJPY cross-rate mismatch at {row['date']}")

        if index + 1 < len(rows) and row.get("fx_cost_jpy_total") is not None:
            next_row = rows[index + 1]
            if row.get("usdtry_next_date") != next_row.get("date"):
                raise RuntimeError(f"validation: FX interval target mismatch at {row['date']}")
            interval_days = (date.fromisoformat(next_row["date"]) - date.fromisoformat(row["date"])).days
            if int(row.get("fx_interval_calendar_days") or 0) != max(1, interval_days):
                raise RuntimeError(f"validation: interval-day mismatch at {row['date']}")
            daily = row.get("fx_cost_jpy_per_day")
            expected_daily = float(row["fx_cost_jpy_total"]) / max(1, interval_days)
            if not finite_number(daily) or abs(float(daily) - expected_daily) > 1e-5:
                raise RuntimeError(f"validation: FX daily mismatch at {row['date']}")

    multi_day = [row for row in rows if int(row.get("days") or 0) >= 3]
    if not multi_day:
        raise RuntimeError("validation: no multi-day swap events found")


def main() -> None:
    payload = build_swap_payload()
    enrich_payload(payload)
    validate_payload(payload)
    payload["meta"]["pipeline"] = "scripts/update_data.py"
    payload["meta"]["pipeline_version"] = 2
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(
        f"pipeline complete: rows={len(payload['data'])} "
        f"latest={payload['meta']['latest_date']} "
        f"multi_day={sum(1 for row in payload['data'] if int(row.get('days') or 0) >= 3)}"
    )


if __name__ == "__main__":
    main()
