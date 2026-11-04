#!/usr/bin/env python3
"""
ELG FMS - FETCH PRUINDEX INCOME BOOST INDICES

Daily end-of-day levels for the three indices PRUIndex Income Boost
(Series 1) can link to. None of them is on Yahoo Finance, so they are
read from each index provider's own public website:

    UBSMSTS   UBS Multi Asset Strategy Tactical Rotation (SGD) Index
              - Excel "Historical index level (SGD)" on the UBS MASTR page
                (UBS refreshes it about once a month)
    SPXFCSGD  S&P 500 FC TCA 0.50% Decrement Index (SGD)
              - S&P Dow Jones Indices index page data (last 10 years)
    BXIISC6S  Shiller Barclays CAPE Allocator 6 Dynamic Risk Control (SGD)
              - Barclays Indices index page data (full history from 2004)

HISTORY IS BUILT UP OVER TIME
data/income_boost_indices.json is never rebuilt from scratch: every run
merges what the sources return today into what is already saved.
  - Dates the source still has: today's value is kept (providers can
    correct a recent level).
  - Dates the source no longer has (e.g. S&P only gives 10 years):
    the saved value is kept, so the history keeps growing.
  - If a provider re-bases its index (all levels change by the same
    factor), the older saved levels are rescaled to the new base so the
    series stays continuous.

UBS and S&P refuse plain scripted requests from cloud servers (bot
protection), so when a plain request fails the source is fetched again
with a headless Chromium browser (Playwright): it opens the provider's
page and downloads the data from inside it, as a visitor's browser does.

A source that fails keeps its saved history and is marked "stale"; one
that has never worked is listed under "failures" with the reason. The
script exits with an error only if nothing could be saved at all.
These are the providers' unofficial website data, so a source may stop
working if a provider changes its site.
"""

from __future__ import annotations

import base64
import io
import json
import os
import re
import sys
import time
from datetime import date, datetime, timezone
from pathlib import Path
from statistics import median
from urllib.parse import urljoin

import requests
from openpyxl import load_workbook


ROOT = Path(__file__).resolve().parent.parent
OUTPUT_FILE = ROOT / "data" / "income_boost_indices.json"

RETRIES = 3
TIMEOUT = 60
MIN_POINTS = 20               # a fetch with fewer points is treated as failed
REBASE_TOLERANCE = 0.01       # 1% median gap on overlapping dates = re-based

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
    ),
    "Accept": "application/json,text/html,application/xhtml+xml,*/*",
    "Accept-Language": "en-US,en;q=0.9",
}

UBS_PAGE = (
    "https://www.ubs.com/global/en/investment-bank/"
    "multi-asset-strategy-tactical-rotation-index/exusa.html"
)
SP_PAGE = (
    "https://www.spglobal.com/spdji/en/indices/multi-asset/"
    "sp-500-fc-tca-050-decrement-index-sgd"
)
SP_DATA = (
    "https://www.spglobal.com/spdji/en/util/redesign/index-data/"
    "get-performance-data-for-datawidget-redesign.dot"
)
SP_INDEX_ID = "92478699"
BARCLAYS_PAGE = "https://indices.cib.barclays/IM/12/en/indices/details.app;ticker=BXIISC6S"
BARCLAYS_DATA = (
    "https://indices.cib.barclays/IM/12/en/restful/api/v1/"
    "IndexTimeSeriesData.app?tickers=BXIISC6S"
)

INDICES = [
    {
        "code": "UBSMSTS",
        "name": "UBS Multi Asset Strategy Tactical Rotation SGD Hedged Index",
        "shortName": "UBS MASTR SGD Hedged",
        "provider": "UBS",
        "ticker": "UBSMSTS Index",
        "currency": "SGD",
        "sourceUrl": UBS_PAGE,
    },
    {
        "code": "SPXFCSGD",
        "name": "S&P 500 FC TCA 0.50% Decrement Index (SGD) ER",
        "shortName": "S&P 500 FC Index (SGD Hedged)",
        "provider": "S&P Dow Jones Indices",
        "ticker": f"S&P index id {SP_INDEX_ID}",
        "currency": "SGD",
        "sourceUrl": SP_PAGE,
    },
    {
        "code": "BXIISC6S",
        "name": "Shiller Barclays CAPE Allocator 6 Dynamic Risk Control (SGD) Index",
        "shortName": "Barclays Shiller Allocator Index (SGD)",
        "provider": "Barclays",
        "ticker": "BXIISC6S",
        "currency": "SGD",
        "sourceUrl": BARCLAYS_PAGE,
    },
]


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

def get(url: str, params: dict | None = None, headers: dict | None = None, retries: int = RETRIES) -> requests.Response:
    last_error = None

    for attempt in range(1, retries + 1):
        try:
            response = requests.get(
                url,
                params=params,
                headers={**HEADERS, **(headers or {})},
                timeout=TIMEOUT,
            )

            if response.status_code == 200:
                return response

            sample = " ".join(response.text[:120].split())
            last_error = RuntimeError(f"HTTP {response.status_code} ({sample})")
        except requests.RequestException as error:
            last_error = error

        if attempt < retries:
            time.sleep(3 * attempt)

    raise RuntimeError(f"{url}: {last_error}")


def iso_from_epoch_ms(value: float) -> str:
    return datetime.fromtimestamp(value / 1000, tz=timezone.utc).date().isoformat()


def to_date(value) -> date | None:
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    if isinstance(value, str):
        text = value.strip()
        for fmt in ("%Y-%m-%d", "%d/%m/%Y", "%m/%d/%Y", "%d-%b-%Y", "%d %b %Y", "%Y%m%d"):
            try:
                return datetime.strptime(text, fmt).date()
            except ValueError:
                pass
    return None


def to_level(value) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value) if value > 0 else None
    if isinstance(value, str):
        try:
            number = float(value.replace(",", "").strip())
            return number if number > 0 else None
        except ValueError:
            return None
    return None


# ---------------------------------------------------------------------------
# sources - each returns {iso_date: level}
# ---------------------------------------------------------------------------

class HeadlessBrowser:
    """One Chromium for the whole run, started only if a source needs it."""

    def __init__(self) -> None:
        self._playwright = None
        self._browser = None
        self._context = None

    def open(self, url: str):
        if self._context is None:
            from playwright.sync_api import sync_playwright

            self._playwright = sync_playwright().start()
            self._browser = self._playwright.chromium.launch(
                args=["--disable-blink-features=AutomationControlled"]
            )
            self._context = self._browser.new_context(
                user_agent=HEADERS["User-Agent"],
                locale="en-US",
                viewport={"width": 1366, "height": 900},
            )
            self._context.add_init_script(
                "Object.defineProperty(navigator, 'webdriver', { get: () => undefined })"
            )

        page = self._context.new_page()
        response = page.goto(url, wait_until="domcontentloaded", timeout=90_000)

        if response is not None and response.status >= 400:
            raise RuntimeError(f"browser got HTTP {response.status} for {url}")

        page.wait_for_timeout(4_000)   # let the site's own scripts settle
        return page

    def fetch_text(self, page, url: str) -> str:
        return page.evaluate(
            """async url => {
                const r = await fetch(url, { credentials: "include" });
                if (!r.ok) throw new Error("HTTP " + r.status);
                return await r.text();
            }""",
            url,
        )

    def fetch_bytes(self, page, url: str) -> bytes:
        encoded = page.evaluate(
            """async url => {
                const r = await fetch(url, { credentials: "include" });
                if (!r.ok) throw new Error("HTTP " + r.status);
                const bytes = new Uint8Array(await r.arrayBuffer());
                let text = "";
                for (let i = 0; i < bytes.length; i += 0x8000) {
                    text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
                }
                return btoa(text);
            }""",
            url,
        )
        return base64.b64decode(encoded)

    def close(self) -> None:
        for item in (self._context, self._browser):
            try:
                if item is not None:
                    item.close()
            except Exception:
                pass
        if self._playwright is not None:
            self._playwright.stop()


BROWSER = HeadlessBrowser()


def with_browser_fallback(plain, browser) -> dict[str, float]:
    try:
        return plain()
    except Exception as plain_error:
        print(f"plain request refused ({plain_error}); trying headless browser ... ", end="", flush=True)
        try:
            return browser()
        except Exception as browser_error:
            raise RuntimeError(f"{plain_error} | headless browser: {browser_error}") from browser_error


def fetch_barclays() -> dict[str, float]:
    payload = get(BARCLAYS_DATA).json()
    rows = payload["BXIISC6S"]["indexData"]

    return {
        iso_from_epoch_ms(stamp): float(level)
        for stamp, level in rows
        if to_level(level)
    }


SP_PARAMS = {
    "indexId": SP_INDEX_ID,
    "language_id": "1",
    "getchildindex": "true",
    "returntype": "T-",
    "currencycode": "SGD",
    "currencyChangeFlag": "false",
    "hybridIndexes": "",
    "period": "all",
}


def parse_sp(payload: dict) -> dict[str, float]:
    rows = payload["indexLevelsHolder"]["indexLevels"]
    levels = {}

    for row in rows:
        day = to_date(row.get("formattedEffectiveDate", ""))
        level = to_level(row.get("indexValue"))

        if day is None and row.get("effectiveDate"):
            day = date.fromisoformat(iso_from_epoch_ms(row["effectiveDate"]))

        if day and level:
            levels[day.isoformat()] = level

    return levels


def fetch_sp() -> dict[str, float]:
    def plain():
        return parse_sp(get(SP_DATA, params=SP_PARAMS, headers={"Referer": SP_PAGE}, retries=2).json())

    def browser():
        page = BROWSER.open(SP_PAGE)
        try:
            url = requests.Request("GET", SP_DATA, params=SP_PARAMS).prepare().url
            return parse_sp(json.loads(BROWSER.fetch_text(page, url)))
        finally:
            page.close()

    return with_browser_fallback(plain, browser)


def ubs_link(page_html: str) -> str:
    # The SGD file's name changes with each refresh, e.g.
    # ubsmsts-index-level-2026-aug26.xlsx
    links = re.findall(r'href="([^"]*ubsmsts-index-level[^"]*\.xlsx)"', page_html, flags=re.I)

    if not links:
        raise RuntimeError("SGD index level file not found on the UBS page")

    return urljoin(UBS_PAGE, links[0])


def parse_ubs(workbook_bytes: bytes) -> dict[str, float]:
    workbook = load_workbook(io.BytesIO(workbook_bytes), read_only=True, data_only=True)
    levels = {}

    # First sheet: column A date, column B UBSMSTS level (header row first).
    # Layout-agnostic: the first date cell and the first positive number
    # after it are the date and the level.
    for row in workbook.worksheets[0].iter_rows(values_only=True):
        day = None
        for cell in row:
            if day is None:
                day = to_date(cell)
                continue
            level = to_level(cell)
            if level:
                levels[day.isoformat()] = level
                break

    return levels


def fetch_ubs() -> dict[str, float]:
    def plain():
        link = ubs_link(get(UBS_PAGE, retries=2).text)
        return parse_ubs(get(link, retries=2).content)

    def browser():
        page = BROWSER.open(UBS_PAGE)
        try:
            return parse_ubs(BROWSER.fetch_bytes(page, ubs_link(page.content())))
        finally:
            page.close()

    return with_browser_fallback(plain, browser)


FETCHERS = {
    "UBSMSTS": fetch_ubs,
    "SPXFCSGD": fetch_sp,
    "BXIISC6S": fetch_barclays,
}


# ---------------------------------------------------------------------------
# merge
# ---------------------------------------------------------------------------

def merge(saved: dict[str, float], fetched: dict[str, float]) -> tuple[dict[str, float], str | None]:
    """Keep every saved date, take today's values where the source has them."""
    note = None
    overlap = sorted(set(saved) & set(fetched))

    if len(overlap) >= 5:
        ratio = median(fetched[day] / saved[day] for day in overlap[-250:])

        if abs(ratio - 1) > REBASE_TOLERANCE:
            saved = {day: level * ratio for day, level in saved.items()}
            note = f"Index re-based by the provider; saved history rescaled by {ratio:.6f}."

    merged = {**saved, **fetched}
    return dict(sorted(merged.items())), note


def load_saved() -> dict[str, dict]:
    if not OUTPUT_FILE.exists():
        return {}

    try:
        data = json.loads(OUTPUT_FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        print(f"WARNING: could not read {OUTPUT_FILE.name}: {error}")
        return {}

    return {item["code"]: item for item in data.get("indices", [])}


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------

def main() -> int:
    now = datetime.now(timezone.utc).replace(microsecond=0).isoformat()
    saved_records = load_saved()
    output = []
    summary = []
    failures = {}
    published = 0

    for config in INDICES:
        code = config["code"]
        previous = saved_records.get(code, {})
        saved_levels = {day: float(level) for day, level in previous.get("observations", [])}
        status = previous.get("updateStatus", {})

        print(f"{code:<9} ", end="", flush=True)

        try:
            fetched = FETCHERS[code]()

            if len(fetched) < MIN_POINTS:
                raise RuntimeError(f"only {len(fetched)} levels returned")

            levels, note = merge(saved_levels, fetched)
            added = len(set(levels) - set(saved_levels))
            status = {
                "status": "ok",
                "lastAttemptUtc": now,
                "lastSuccessUtc": now,
                "message": note or f"{len(fetched)} levels from source, {added} new.",
            }
            print(f"ok  {len(fetched)} from source, {added} new, {len(levels)} saved")

        except Exception as error:  # keep the saved history on any failure
            levels = dict(sorted(saved_levels.items()))
            status = {
                **status,
                "status": "stale" if levels else "missing",
                "lastAttemptUtc": now,
                "message": f"Fetch failed: {error}",
            }
            print(f"FAILED  {error}  (kept {len(levels)} saved levels)")

        if not levels:
            failures[code] = {"name": config["name"], **status}
            summary.append(f"| {code} | missing | 0 | - | {status['message']} |")
            continue

        observations = [[day, round(level, 6)] for day, level in levels.items()]
        latest_day, latest_level = observations[-1]

        output.append({
            **config,
            "firstDate": observations[0][0],
            "latestDate": latest_day,
            "latestLevel": latest_level,
            "observationCount": len(observations),
            "updateStatus": status,
            "observations": observations,
        })
        published += 1
        summary.append(
            f"| {code} | {status['status']} | {len(observations)} | {latest_day} | {status['message']} |"
        )

    BROWSER.close()

    if not published:
        print("ERROR: no index could be saved.")
        return 1

    OUTPUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_FILE.write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "generatedAtUtc": now,
                "product": "PRUIndex Income Boost (Series 1)",
                "sourceNote": (
                    "End-of-day levels from each index provider's public website. "
                    "History is accumulated: dates a source no longer returns are kept."
                ),
                "indexCount": len(output),
                "failures": failures,
                "indices": output,
            },
            separators=(",", ":"),
        ),
        encoding="utf-8",
    )
    print(f"Wrote {OUTPUT_FILE.relative_to(ROOT)} ({published} indices)")

    summary_file = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary_file:
        with open(summary_file, "a", encoding="utf-8") as handle:
            handle.write("### PRUIndex Income Boost indices\n\n")
            handle.write("| Index | Status | Saved levels | Latest | Note |\n|---|---|---|---|---|\n")
            handle.write("\n".join(summary) + "\n")

    return 0


if __name__ == "__main__":
    sys.exit(main())
