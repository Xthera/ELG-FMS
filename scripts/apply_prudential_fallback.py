#!/usr/bin/env python3

"""
USE BACKUP PRICES WHEN PRUACCESS IS DOWN
========================================

Runs after build_funds_data.py. Only touches funds that PruAccess could
not update in this run (updateStatus "stale", or "website" from an
earlier backup run). For each of them, when the Prudential website
(see fetch_prudential_prices.py) has a newer price:

  - the latest BID is added to the fund's price history,
  - the fund's BID / offer price, valuation date and published returns
    are refreshed,
  - updateStatus becomes "website", so the dashboard can say the latest
    price came from the Prudential website.

Funds that PruAccess updated are never changed: PruAccess stays the
master source. When PruAccess works again, the next run rebuilds the
full history from PruAccess and replaces any backup prices.

DATES
-----
The website's "valuation date" is one dealing day behind the date
PruAccess gives the same price (website 16/11 = PruAccess 17 Nov;
checked across every fund on several days). So a website price is
filed under the next Singapore business day after its valuation date,
matching the PruAccess history.

Backup prices are marked "source": "prudential-website" in
data/bid_history.json. They have 4 decimals (PruAccess has 5).

No price is estimated or interpolated: only prices published by
Prudential are added, one per run at most.
"""

from __future__ import annotations

import json
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any

try:
    import holidays
except ImportError:          # still works, just without public holidays
    holidays = None


ROOT = Path(__file__).resolve().parents[1]
FUNDS_FILE = ROOT / "data" / "funds.json"
BIDS_FILE = ROOT / "data" / "bid_history.json"
PRICES_FILE = ROOT / "output_prudential_prices" / "prices.json"

MAX_PRICE_AGE_HOURS = 36
SOURCE = "prudential-website"

# Fields in data/funds.json -> fund that the website refreshes
FUND_FIELDS = (
    "bidPrice", "offerPrice", "valuationDate",
    "cumulativeYtd", "cumulative1m", "cumulative3m", "cumulative6m",
    "cumulative1y", "cumulative3y", "cumulative5y",
    "annualised3y", "annualised5y", "annualised10y", "annualisedSinceLaunch",
)


def load(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def write(path: Path, data: Any, compact: bool) -> None:
    text = (
        json.dumps(data, ensure_ascii=False, separators=(",", ":"))
        if compact
        else json.dumps(data, ensure_ascii=False, indent=2)
    )
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(text + "\n", encoding="utf-8")
    temporary.replace(path)


def parse_price(value: Any) -> float | None:
    try:
        number = float(str(value).replace("$", "").replace(",", "").strip())
    except (TypeError, ValueError):
        return None
    return number if number > 0 else None


def sg_holidays(years: list[int]) -> set[date]:
    if holidays is None:
        return set()
    try:
        return set(holidays.Singapore(years=years).keys())
    except Exception:
        return set()


def next_business_day(day: date, closed: set[date]) -> date:
    day += timedelta(days=1)
    while day.weekday() >= 5 or day in closed:
        day += timedelta(days=1)
    return day


def main() -> int:
    print("=" * 60)
    print("BACKUP PRICES - apply where PruAccess did not update")
    print("=" * 60)

    if not PRICES_FILE.exists():
        print("No backup prices this run (output_prudential_prices/prices.json missing). Nothing to do.")
        return 0

    prices_doc = load(PRICES_FILE)
    fetched = datetime.fromisoformat(prices_doc["fetchedAtUtc"])
    age_hours = (datetime.now(timezone.utc) - fetched).total_seconds() / 3600

    if age_hours > MAX_PRICE_AGE_HOURS:
        print(f"Backup prices are {age_hours:.0f} hours old. Not used.")
        return 0

    prices = prices_doc.get("funds") or {}
    funds_doc = load(FUNDS_FILE)
    bids_doc = load(BIDS_FILE)
    bids_by_row = {record.get("excelRow"): record for record in bids_doc.get("funds") or []}

    this_year = datetime.now().year
    closed = sg_holidays([this_year - 1, this_year, this_year + 1])

    applied, skipped = [], []

    for fund in funds_doc.get("funds") or []:
        status = fund.get("updateStatus") or {}

        if status.get("status") not in ("stale", "website"):
            continue        # PruAccess updated this fund: leave it alone

        name = fund.get("fundName")
        code = fund.get("fundIdentifier")
        entry = prices.get(code)
        bid_record = bids_by_row.get(fund.get("excelRow"))

        if not entry or bid_record is None:
            skipped.append(f"{name}: no backup price")
            continue

        record = entry["record"]
        bid = parse_price(record.get("bidPrice"))
        valuation = datetime.strptime(record["valuationDate"], "%d/%m/%Y").date()
        price_date = next_business_day(valuation, closed)

        history = bid_record.get("bidHistory") or {}
        observations = history.get("observations") or []

        if bid is None or not observations:
            skipped.append(f"{name}: no usable price or no earlier history")
            continue

        details = fund.get("fund") or {}
        try:
            current = datetime.strptime(str(details.get("valuationDate")), "%d/%m/%Y").date()
        except ValueError:
            current = date.min

        # Prices to file, oldest first: the one already in the published
        # details (from the last good Prudential read) and today's.
        candidates = []
        current_bid = parse_price(details.get("bidPrice"))
        if current_bid is not None and current != date.min:
            candidates.append((next_business_day(current, closed), current_bid))
        candidates.append((price_date, bid))

        added = False

        for day, price in sorted(set(candidates)):
            if day.isoformat() > observations[-1].get("date", ""):
                observations.append({"date": day.isoformat(), "bidPrice": price, "source": SOURCE})
                added = True

        if added:
            history["observations"] = observations
            history["observationCount"] = len(observations)
            history["endDate"] = observations[-1]["date"] and datetime.strptime(observations[-1]["date"], "%Y-%m-%d").strftime("%d-%b-%Y")
            bid_record["bidHistory"] = history

        # Refresh the published details when the website is newer

        if valuation > current:
            for key in FUND_FIELDS:
                if key in record:
                    details[key] = record[key]
            fund["fund"] = details

        from_website = observations[-1].get("source") == SOURCE

        if not added and valuation <= current and not from_website:
            skipped.append(f"{name}: website price ({record['valuationDate']}) is not newer")
            continue

        new_status = {
            **{k: v for k, v in status.items() if k != "status"},
            "status": "website",
            "priceSource": SOURCE,
            "websiteValuationDate": record["valuationDate"],
            "websitePriceDate": price_date.isoformat(),
            "websiteFetchedUtc": prices_doc["fetchedAtUtc"],
        }
        fund["updateStatus"] = new_status
        bid_record["updateStatus"] = new_status

        applied.append(f"{name}: BID {bid} filed as {price_date.isoformat()} (website {record['valuationDate']})")

    summary = funds_doc.setdefault("summary", {})
    summary["websiteFallbackFunds"] = len(applied)
    summary["websiteFallbackUtc"] = prices_doc["fetchedAtUtc"] if applied else None

    write(FUNDS_FILE, funds_doc, compact=False)
    write(BIDS_FILE, bids_doc, compact=True)

    for line in applied:
        print("  used   ", line)
    for line in skipped:
        print("  skipped", line)

    print()
    print(f"Backup prices used for {len(applied)} fund(s); {len(skipped)} skipped.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
