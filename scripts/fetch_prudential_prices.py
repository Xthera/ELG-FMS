#!/usr/bin/env python3

"""
BACKUP PRICE SOURCE - Prudential Singapore website
==================================================

PruAccess is the main source of BID prices. When PruAccess is down,
this script reads the latest published prices from Prudential's own
fund pages (www.prudential.com.sg), which come from Prudential's data
provider FE fundinfo.

For every fund in data/funds.json it reads the same data the fund page
itself loads:

    <fund page>/_jcr_content.ilpfunds.json?citicodes=<fund identifier>

which gives the BID and offer price, the valuation date and the
published returns.

The site is protected against bots, so a real (headless) Chromium
browser opens one fund page first and then asks for each fund's data
from inside that browser session. If a direct request is refused, the
fund's own page is opened and its data is captured as it loads.

Output
------

    output_prudential_prices/prices.json        one record per fund
    output_prudential_prices/run_summary.json   counts and failures

Nothing in data/ is changed here. scripts/apply_prudential_fallback.py
decides whether these prices are used.

Exit code: 0 when at least one fund was read, 1 otherwise. The
workflow step is continue-on-error, so a failure never stops the build.
"""

from __future__ import annotations

import asyncio
import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from playwright.async_api import async_playwright


ROOT = Path(__file__).resolve().parents[1]
FUNDS_FILE = ROOT / "data" / "funds.json"
OUTPUT_DIR = ROOT / "output_prudential_prices"

PAGE_TIMEOUT_MS = 60_000
REQUEST_TIMEOUT_MS = 30_000
SETTLE_MS = 5_000
ATTEMPTS = 3

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36"
)


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def save_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def read_funds() -> list[dict]:
    """Fund page URL + Prudential fund identifier (citicode) per fund."""

    data = json.loads(FUNDS_FILE.read_text(encoding="utf-8"))
    funds = []

    for record in data.get("funds") or []:
        url = str(record.get("prudentialUrl") or "").strip()
        code = str(record.get("fundIdentifier") or "").strip()

        if url.startswith("http") and code:
            funds.append({
                "excelRow": record.get("excelRow"),
                "fundName": record.get("fundName"),
                "fundIdentifier": code,
                "pageUrl": url,
            })

    return funds


def api_url(page_url: str, code: str) -> str:
    base = page_url.split("?")[0].split("#")[0]
    base = re.sub(r"\.html$", "", base)
    return f"{base}/_jcr_content.ilpfunds.json?citicodes={code}"


def parse_price(value: Any) -> float | None:
    try:
        number = float(str(value).replace("$", "").replace(",", "").strip())
    except (TypeError, ValueError):
        return None
    return number if number > 0 else None


def check_record(payload: Any, code: str) -> dict:
    """The fund's record from an ilpfunds.json reply, or raise."""

    records = payload if isinstance(payload, list) else [payload]

    for record in records:
        if isinstance(record, dict) and str(record.get("fundIdentifier", "")).strip() == code:
            if parse_price(record.get("bidPrice")) is None:
                raise ValueError(f"no usable BID price ({record.get('bidPrice')!r})")
            try:
                datetime.strptime(str(record.get("valuationDate")), "%d/%m/%Y")
            except ValueError:
                raise ValueError(f"bad valuation date ({record.get('valuationDate')!r})")
            return record

    raise ValueError("fund not found in the reply")


async def read_direct(context, fund: dict) -> dict:
    response = await context.request.get(
        api_url(fund["pageUrl"], fund["fundIdentifier"]),
        timeout=REQUEST_TIMEOUT_MS,
        headers={"Accept": "application/json, text/javascript, */*", "Referer": fund["pageUrl"]},
    )

    if response.status != 200:
        raise RuntimeError(f"HTTP {response.status}")

    text = await response.text()

    try:
        payload = json.loads(text)
    except json.JSONDecodeError:
        raise RuntimeError("reply was not JSON (likely a bot check page)")

    return check_record(payload, fund["fundIdentifier"])


async def read_via_page(page, fund: dict) -> dict:
    captured: list[Any] = []

    async def on_response(response):
        if "ilpfunds.json" in response.url.lower():
            try:
                captured.append(await response.json())
            except Exception:
                pass

    page.on("response", on_response)

    try:
        await page.goto(fund["pageUrl"], wait_until="domcontentloaded", timeout=PAGE_TIMEOUT_MS)

        for _ in range(20):
            if captured:
                break
            await page.wait_for_timeout(500)
    finally:
        page.remove_listener("response", on_response)

    for payload in captured:
        try:
            return check_record(payload, fund["fundIdentifier"])
        except ValueError:
            continue

    raise RuntimeError("fund page did not load its price data")


async def main() -> int:
    funds = read_funds()
    started = utc_now()
    prices: dict[str, dict] = {}
    failed: list[dict] = []

    print("=" * 60)
    print("BACKUP PRICES - www.prudential.com.sg")
    print("=" * 60)
    print(f"Funds to read: {len(funds)}")

    if not funds:
        print("No funds with a Prudential page URL in data/funds.json.")
        return 1

    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(headless=True)
        context = await browser.new_context(
            user_agent=USER_AGENT,
            locale="en-SG",
            viewport={"width": 1366, "height": 900},
        )
        page = await context.new_page()

        # Open one fund page first so the site's bot check sets its cookies
        try:
            await page.goto(funds[0]["pageUrl"], wait_until="domcontentloaded", timeout=PAGE_TIMEOUT_MS)
            await page.wait_for_timeout(SETTLE_MS)
        except Exception as error:
            print(f"WARNING: first fund page did not open: {error}")

        for index, fund in enumerate(funds, start=1):
            label = f"[{index}/{len(funds)}] {fund['fundIdentifier']} {fund['fundName']}"
            errors = []
            record = None

            for attempt in range(1, ATTEMPTS + 1):
                try:
                    record = await read_direct(context, fund)
                    break
                except Exception as error:
                    errors.append(f"direct #{attempt}: {error}")

                try:
                    record = await read_via_page(page, fund)
                    break
                except Exception as error:
                    errors.append(f"page #{attempt}: {error}")

                await asyncio.sleep(2 * attempt)

            if record:
                prices[fund["fundIdentifier"]] = {
                    "excelRow": fund["excelRow"],
                    "fundName": fund["fundName"],
                    "pageUrl": fund["pageUrl"],
                    "record": record,
                }
                print(f"{label}: BID {record.get('bidPrice')} as at {record.get('valuationDate')}")
            else:
                failed.append({**fund, "errors": errors})
                print(f"{label}: FAILED - {errors[-1] if errors else 'unknown'}")

        await browser.close()

    finished = utc_now()

    save_json(OUTPUT_DIR / "prices.json", {
        "source": "https://www.prudential.com.sg (data provider: FE fundinfo)",
        "fetchedAtUtc": finished,
        "funds": prices,
    })

    save_json(OUTPUT_DIR / "run_summary.json", {
        "startedAtUtc": started,
        "finishedAtUtc": finished,
        "fundCount": len(funds),
        "read": len(prices),
        "failed": len(failed),
        "failures": failed,
    })

    print()
    print(f"Read {len(prices)} of {len(funds)} funds; {len(failed)} failed.")

    return 0 if prices else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
