#!/usr/bin/env python3

"""
VGrat FMS - Prudential Promotions Extractor
============================================

Extracts Prudential Singapore promotions from:

https://www.prudential.com.sg/en/promos-and-rewards/promotions/

The extractor:

1. Downloads the Prudential promotions landing page.
2. Identifies promotion cards / links.
3. Follows each promotion detail page.
4. Extracts:
   - promotion title
   - summary
   - URL
   - promotion period
   - page text
   - eligible plans
   - discount / reward information
   - status
5. Writes structured JSON.

Output:
    data/promotions.json

Dependencies:
    requests
    beautifulsoup4
"""

from __future__ import annotations

import json
import re
import sys
import time
from datetime import date, datetime
from pathlib import Path
from urllib.parse import urljoin, urlparse

import requests
from bs4 import BeautifulSoup


# ============================================================
# CONFIGURATION
# ============================================================

ROOT = Path(__file__).resolve().parent

OUTPUT_DIR = ROOT / "data"
OUTPUT_FILE = OUTPUT_DIR / "promotions.json"

SOURCE_URL = (
    "https://www.prudential.com.sg/en/promos-and-rewards/promotions/"
)

BASE_URL = "https://www.prudential.com.sg"

REQUEST_TIMEOUT = 30

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/154.0.0.0 Safari/537.36"
)

HEADERS = {
    "User-Agent": USER_AGENT,
    "Accept": (
        "text/html,application/xhtml+xml,application/xml;"
        "q=0.9,image/avif,image/webp,*/*;q=0.8"
    ),
    "Accept-Language": "en-SG,en;q=0.9",
    "Cache-Control": "no-cache",
}


# ============================================================
# SESSION
# ============================================================

session = requests.Session()
session.headers.update(HEADERS)


# ============================================================
# LOGGING
# ============================================================

def log(message: str) -> None:
    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{timestamp}] {message}", flush=True)


# ============================================================
# HTTP
# ============================================================

def fetch(url: str) -> str:
    """
    Download a page and return HTML.
    """

    log(f"GET {url}")

    response = session.get(
        url,
        timeout=REQUEST_TIMEOUT,
    )

    response.raise_for_status()

    log(
        f"HTTP {response.status_code} "
        f"({len(response.content):,} bytes)"
    )

    return response.text


# ============================================================
# TEXT CLEANING
# ============================================================

def clean_text(value: str | None) -> str:
    if not value:
        return ""

    value = value.replace("\xa0", " ")

    value = re.sub(r"\s+", " ", value)

    return value.strip()


def unique_preserve_order(values):
    result = []

    seen = set()

    for value in values:
        value = clean_text(value)

        if not value:
            continue

        key = value.lower()

        if key in seen:
            continue

        seen.add(key)
        result.append(value)

    return result


# ============================================================
# URL HANDLING
# ============================================================

def normalize_url(url: str) -> str:
    """
    Convert relative Prudential URLs into absolute URLs.
    """

    url = url.strip()

    if not url:
        return ""

    absolute = urljoin(BASE_URL, url)

    parsed = urlparse(absolute)

    # Remove fragments.
    absolute = parsed._replace(fragment="").geturl()

    return absolute


def is_prudential_url(url: str) -> bool:
    parsed = urlparse(url)

    return (
        parsed.scheme in ("http", "https")
        and parsed.netloc.lower().endswith("prudential.com.sg")
    )


# ============================================================
# DATE EXTRACTION
# ============================================================

MONTHS = (
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
)

MONTH_PATTERN = "|".join(MONTHS)

DATE_RANGE_PATTERNS = [
    re.compile(
        rf"\b("
        rf"\d{{1,2}}\s+{MONTH_PATTERN}\s+\d{{4}}"
        rf")\s*(?:to|-|–|—)\s*("
        rf"\d{{1,2}}\s+{MONTH_PATTERN}\s+\d{{4}}"
        rf")",
        re.I,
    ),
    re.compile(
        rf"\b("
        rf"{MONTH_PATTERN}\s+\d{{1,2}},?\s+\d{{4}}"
        rf")\s*(?:to|-|–|—)\s*("
        rf"{MONTH_PATTERN}\s+\d{{1,2}},?\s+\d{{4}}"
        rf")",
        re.I,
    ),
]


def parse_date(value: str) -> str | None:
    value = clean_text(value)

    formats = [
        "%d %B %Y",
        "%d %b %Y",
        "%B %d %Y",
        "%B %d, %Y",
        "%b %d %Y",
        "%b %d, %Y",
    ]

    for fmt in formats:
        try:
            return datetime.strptime(value, fmt).date().isoformat()
        except ValueError:
            pass

    return None


def extract_promotion_period(text: str) -> dict:
    """
    Extract the first explicit promotion period found.

    If the promotion contains multiple periods, preserve them
    separately under additionalPeriods.
    """

    periods = []

    for pattern in DATE_RANGE_PATTERNS:

        for match in pattern.finditer(text):

            start_raw = clean_text(match.group(1))
            end_raw = clean_text(match.group(2))

            start = parse_date(start_raw)
            end = parse_date(end_raw)

            if not start or not end:
                continue

            period = {
                "start": start,
                "end": end,
            }

            if period not in periods:
                periods.append(period)

    if not periods:
        return {
            "promotionPeriod": None,
            "additionalPeriods": [],
        }

    return {
        "promotionPeriod": periods[0],
        "additionalPeriods": periods[1:],
    }


# ============================================================
# STATUS
# ============================================================

def determine_status(period: dict | None) -> str:
    if not period:
        return "unknown"

    try:
        start = date.fromisoformat(period["start"])
        end = date.fromisoformat(period["end"])
    except Exception:
        return "unknown"

    today = date.today()

    if today < start:
        return "upcoming"

    if today > end:
        return "expired"

    return "active"


# ============================================================
# PROMOTION TITLE DETECTION
# ============================================================

PROMOTION_KEYWORDS = (
    "promotion",
    "reward",
    "campaign",
    "lucky draw",
    "discount",
    "smart moves",
    "celebrating",
    "protect today",
    "thank you",
    "bonds",
)


def looks_like_promotion_title(value: str) -> bool:
    text = clean_text(value).lower()

    if not text:
        return False

    return any(
        keyword in text
        for keyword in PROMOTION_KEYWORDS
    )


# ============================================================
# LANDING PAGE EXTRACTION
# ============================================================

def extract_listing_promotions(html: str) -> list[dict]:
    """
    Extract promotion cards from the landing page.

    This intentionally does not depend on one fragile CSS class.
    Prudential's CMS markup can change, so we inspect links and
    surrounding card content.
    """

    soup = BeautifulSoup(html, "html.parser")

    promotions = []

    seen_urls = set()

    # --------------------------------------------------------
    # First pass:
    # Find links that appear to point to promotion pages.
    # --------------------------------------------------------

    for link in soup.find_all("a", href=True):

        href = normalize_url(link.get("href", ""))

        if not href:
            continue

        if not is_prudential_url(href):
            continue

        parsed = urlparse(href)

        path = parsed.path.lower()

        # Promotion detail pages normally live under these
        # Prudential areas.
        if "/promotion" not in path and "/promos-and-rewards/" not in path:
            continue

        # Don't treat the landing page itself as a promotion.
        normalized_path = path.rstrip("/")

        if normalized_path in (
            "/en/promos-and-rewards/promotions",
            "/products/promotions",
        ):
            continue

        if href in seen_urls:
            continue

        title = clean_text(link.get_text(" ", strip=True))

        # ----------------------------------------------------
        # If the anchor itself has no useful title, inspect
        # the surrounding card.
        # ----------------------------------------------------

        container = (
            link.find_parent(
                ["article", "li", "section", "div"],
                limit=4,
            )
        )

        card_text = ""

        if container:
            card_text = clean_text(
                container.get_text(" ", strip=True)
            )

        summary = ""

        if card_text:
            if title:
                summary = card_text.replace(title, "", 1).strip()

            if len(summary) > 500:
                summary = summary[:500].rstrip() + "..."

        # Ignore obvious navigation / legal links.
        combined = f"{title} {summary}".lower()

        if not looks_like_promotion_title(combined):
            continue

        seen_urls.add(href)

        promotions.append(
            {
                "title": title,
                "summary": summary,
                "url": href,
            }
        )

    return promotions


# ============================================================
# DETAIL PAGE EXTRACTION
# ============================================================

def extract_page_text(soup: BeautifulSoup) -> str:
    """
    Extract readable page text while removing navigation,
    scripts, styles and form elements.
    """

    soup_copy = BeautifulSoup(str(soup), "html.parser")

    for tag in soup_copy(
        [
            "script",
            "style",
            "noscript",
            "svg",
            "nav",
            "footer",
            "form",
        ]
    ):
        tag.decompose()

    text = soup_copy.get_text("\n", strip=True)

    lines = []

    for line in text.splitlines():
        line = clean_text(line)

        if line:
            lines.append(line)

    return "\n".join(lines)


def extract_headings(soup: BeautifulSoup) -> list[str]:
    headings = []

    for tag in soup.find_all(
        ["h1", "h2", "h3", "h4"]
    ):
        text = clean_text(
            tag.get_text(" ", strip=True)
        )

        if text:
            headings.append(text)

    return unique_preserve_order(headings)


def extract_eligible_plans(text: str) -> list[str]:
    """
    Attempts to extract common Prudential plan names.

    This is intentionally conservative. It does not invent
    products from generic wording.
    """

    known_patterns = [
        r"PRUActive Term",
        r"PRUActive Protect II",
        r"PRUActive Life V",
        r"PRUActive Family Care",
        r"PRUVantage Assure II",
        r"PRUVantage Wealth III",
        r"PRUVantage Prosper",
        r"PRUHospital Care360",
        r"PRUShield EasySwitch",
        r"PRULink StrategicInvest Income Fund",
        r"PRUPrime CIO Conservative Fund",
        r"PRUPrime CIO Balanced Fund",
        r"PRUPrime CIO Growth Fund",
    ]

    found = []

    for pattern in known_patterns:

        if re.search(
            pattern,
            text,
            flags=re.I,
        ):
            match = re.search(
                pattern,
                text,
                flags=re.I,
            )

            if match:
                found.append(match.group(0))

    return unique_preserve_order(found)


def extract_rewards_and_discounts(text: str) -> list[str]:
    """
    Extract sentences containing common promotion value terms.
    """

    sentences = re.split(
        r"(?<=[.!?])\s+",
        clean_text(text),
    )

    keywords = (
        "%",
        "discount",
        "reward",
        "voucher",
        "bonus",
        "cashback",
        "miles",
        "complimentary",
        "promotion bonus",
    )

    matches = []

    for sentence in sentences:

        sentence = clean_text(sentence)

        if not sentence:
            continue

        lowered = sentence.lower()

        if any(
            keyword.lower() in lowered
            for keyword in keywords
        ):
            if len(sentence) <= 500:
                matches.append(sentence)

    return unique_preserve_order(matches)


def extract_detail_page(
    promotion: dict,
) -> dict:

    url = promotion["url"]

    try:
        html = fetch(url)

    except Exception as exc:

        log(
            f"ERROR fetching promotion: "
            f"{url} -> {exc}"
        )

        promotion["extractionStatus"] = "error"
        promotion["error"] = str(exc)

        return promotion

    soup = BeautifulSoup(
        html,
        "html.parser",
    )

    page_text = extract_page_text(soup)

    headings = extract_headings(soup)

    period_data = extract_promotion_period(
        page_text
    )

    status = determine_status(
        period_data["promotionPeriod"]
    )

    plans = extract_eligible_plans(
        page_text
    )

    rewards = extract_rewards_and_discounts(
        page_text
    )

    # --------------------------------------------------------
    # Prefer H1 as authoritative title.
    # --------------------------------------------------------

    h1 = soup.find("h1")

    if h1:
        h1_text = clean_text(
            h1.get_text(" ", strip=True)
        )

        if h1_text:
            promotion["title"] = h1_text

    promotion.update(
        {
            "promotionPeriod": period_data[
                "promotionPeriod"
            ],
            "additionalPeriods": period_data[
                "additionalPeriods"
            ],
            "status": status,
            "eligiblePlans": plans,
            "rewardsAndDiscounts": rewards,
            "headings": headings,
            "details": page_text,
            "extractionStatus": "success",
        }
    )

    return promotion


# ============================================================
# MAIN
# ============================================================

def main() -> int:

    log("=" * 70)
    log("VGrat FMS - PRUDENTIAL PROMOTIONS EXTRACTOR")
    log("=" * 70)

    log(f"Source: {SOURCE_URL}")

    # --------------------------------------------------------
    # Download landing page
    # --------------------------------------------------------

    try:
        html = fetch(SOURCE_URL)

    except Exception as exc:

        log(f"FATAL: Unable to download promotions page: {exc}")

        return 1

    # --------------------------------------------------------
    # Extract promotion cards
    # --------------------------------------------------------

    promotions = extract_listing_promotions(
        html
    )

    log(
        f"Found {len(promotions)} promotion links"
    )

    if not promotions:

        log(
            "WARNING: No promotions were extracted."
        )

        return 1

    # --------------------------------------------------------
    # Extract each detail page
    # --------------------------------------------------------

    extracted = []

    for index, promotion in enumerate(
        promotions,
        start=1,
    ):

        log(
            f"[{index}/{len(promotions)}] "
            f"{promotion.get('title', '')}"
        )

        result = extract_detail_page(
            promotion
        )

        extracted.append(result)

        # Be polite to Prudential's servers.
        if index < len(promotions):
            time.sleep(0.5)

    # --------------------------------------------------------
    # Sort:
    #
    # active first
    # upcoming second
    # unknown third
    # expired last
    # --------------------------------------------------------

    status_order = {
        "active": 0,
        "upcoming": 1,
        "unknown": 2,
        "expired": 3,
    }

    extracted.sort(
        key=lambda item: (
            status_order.get(
                item.get("status"),
                99,
            ),
            item.get("title", "").lower(),
        )
    )

    # --------------------------------------------------------
    # Build output
    # --------------------------------------------------------

    output = {
        "source": "Prudential Singapore",
        "sourceUrl": SOURCE_URL,
        "retrievedDate": date.today().isoformat(),
        "retrievedTimestamp": datetime.now().astimezone().isoformat(),
        "promotionCount": len(extracted),
        "promotions": extracted,
    }

    # --------------------------------------------------------
    # Write JSON
    # --------------------------------------------------------

    OUTPUT_DIR.mkdir(
        parents=True,
        exist_ok=True,
    )

    with OUTPUT_FILE.open(
        "w",
        encoding="utf-8",
    ) as file:

        json.dump(
            output,
            file,
            ensure_ascii=False,
            indent=2,
        )

        file.write("\n")

    # --------------------------------------------------------
    # Summary
    # --------------------------------------------------------

    active = sum(
        1
        for item in extracted
        if item.get("status") == "active"
    )

    upcoming = sum(
        1
        for item in extracted
        if item.get("status") == "upcoming"
    )

    expired = sum(
        1
        for item in extracted
        if item.get("status") == "expired"
    )

    errors = sum(
        1
        for item in extracted
        if item.get("extractionStatus") == "error"
    )

    log("=" * 70)
    log("EXTRACTION COMPLETE")
    log("=" * 70)

    log(f"Total promotions : {len(extracted)}")
    log(f"Active           : {active}")
    log(f"Upcoming         : {upcoming}")
    log(f"Expired          : {expired}")
    log(f"Errors           : {errors}")
    log(f"Output           : {OUTPUT_FILE}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
