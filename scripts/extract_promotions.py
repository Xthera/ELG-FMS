#!/usr/bin/env python3

"""
Prudential Singapore Promotions Extractor
=========================================

Source:
    https://www.prudential.com.sg/en/promos-and-rewards/promotions/

Purpose:
    Discover Prudential Singapore promotion pages and extract
    structured promotion information into data/promotions.json.

The extractor intentionally discovers promotion URLs from the
live Prudential promotions page rather than maintaining a
hardcoded promotion list.

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
# PATHS
# ============================================================

ROOT = Path(__file__).resolve().parent.parent

DATA_DIR = ROOT / "data"
OUTPUT_FILE = DATA_DIR / "promotions.json"


# ============================================================
# SOURCE
# ============================================================

SOURCE_URL = (
    "https://www.prudential.com.sg/"
    "en/promos-and-rewards/promotions/"
)

SOURCE_NAME = "Prudential Singapore"

BASE_URL = "https://www.prudential.com.sg"


# ============================================================
# HTTP CONFIGURATION
# ============================================================

REQUEST_TIMEOUT = 30

REQUEST_DELAY_SECONDS = 0.5

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/154.0.0.0 Safari/537.36"
)

HEADERS = {
    "User-Agent": USER_AGENT,
    "Accept": (
        "text/html,application/xhtml+xml,"
        "application/xml;q=0.9,image/avif,"
        "image/webp,*/*;q=0.8"
    ),
    "Accept-Language": "en-SG,en;q=0.9",
    "Cache-Control": "no-cache",
}


# ============================================================
# SESSION
# ============================================================

SESSION = requests.Session()
SESSION.headers.update(HEADERS)


# ============================================================
# LOGGING
# ============================================================

def log(message: str) -> None:
    timestamp = datetime.now().strftime(
        "%Y-%m-%d %H:%M:%S"
    )

    print(
        f"[{timestamp}] {message}",
        flush=True,
    )


# ============================================================
# TEXT UTILITIES
# ============================================================

def clean_text(value: str | None) -> str:
    if not value:
        return ""

    value = value.replace("\xa0", " ")

    value = re.sub(
        r"[ \t\r\n]+",
        " ",
        value,
    )

    return value.strip()


def clean_multiline_text(value: str | None) -> str:
    if not value:
        return ""

    value = value.replace("\xa0", " ")

    lines = []

    for line in value.splitlines():
        line = clean_text(line)

        if line:
            lines.append(line)

    return "\n".join(lines)


def unique_preserve_order(values: list[str]) -> list[str]:
    result = []
    seen = set()

    for value in values:
        value = clean_text(value)

        if not value:
            continue

        key = value.casefold()

        if key in seen:
            continue

        seen.add(key)
        result.append(value)

    return result


# ============================================================
# URL UTILITIES
# ============================================================

def normalize_url(url: str) -> str:
    if not url:
        return ""

    url = url.strip()

    absolute = urljoin(
        BASE_URL,
        url,
    )

    parsed = urlparse(absolute)

    # Remove URL fragments.
    parsed = parsed._replace(
        fragment=""
    )

    return parsed.geturl()


def is_prudential_url(url: str) -> bool:
    try:
        parsed = urlparse(url)

        hostname = (
            parsed.hostname or ""
        ).lower()

        return (
            parsed.scheme in (
                "http",
                "https",
            )
            and (
                hostname == "prudential.com.sg"
                or hostname.endswith(
                    ".prudential.com.sg"
                )
            )
        )

    except Exception:
        return False


def is_promotions_listing_url(url: str) -> bool:
    parsed = urlparse(url)

    path = parsed.path.rstrip("/").lower()

    return path in (
        "/en/promos-and-rewards/promotions",
        "/en/products/promotions",
        "/products/promotions",
    )


def looks_like_promotion_url(url: str) -> bool:
    if not is_prudential_url(url):
        return False

    parsed = urlparse(url)

    path = parsed.path.lower()

    if is_promotions_listing_url(url):
        return False

    promotion_paths = (
        "/en/products/promotions/",
        "/en/promos-and-rewards/promotions/",
        "/products/promotions/",
    )

    return any(
        path.startswith(prefix)
        for prefix in promotion_paths
    )


# ============================================================
# HTTP
# ============================================================

def fetch_page(url: str) -> str:
    log(f"GET {url}")

    response = SESSION.get(
        url,
        timeout=REQUEST_TIMEOUT,
    )

    response.raise_for_status()

    if not response.text.strip():
        raise RuntimeError(
            "Received an empty HTML response"
        )

    log(
        f"HTTP {response.status_code} | "
        f"{len(response.content):,} bytes"
    )

    return response.text


# ============================================================
# HTML UTILITIES
# ============================================================

def soup_from_html(html: str) -> BeautifulSoup:
    return BeautifulSoup(
        html,
        "html.parser",
    )


def extract_page_title(
    soup: BeautifulSoup,
) -> str:
    h1 = soup.find("h1")

    if h1:
        value = clean_text(
            h1.get_text(
                " ",
                strip=True,
            )
        )

        if value:
            return value

    title = soup.find("title")

    if title:
        value = clean_text(
            title.get_text(
                " ",
                strip=True,
            )
        )

        if value:
            value = re.sub(
                r"\s*\|\s*Prudential.*$",
                "",
                value,
                flags=re.I,
            )

            return value.strip()

    return ""


def extract_page_text(
    soup: BeautifulSoup,
) -> str:
    """
    Extract readable text while removing website
    navigation and technical elements.
    """

    # Work on a copy so that other extraction operations
    # are not affected.
    working = BeautifulSoup(
        str(soup),
        "html.parser",
    )

    for tag in working.find_all(
        [
            "script",
            "style",
            "noscript",
            "svg",
            "nav",
            "footer",
            "form",
            "iframe",
        ]
    ):
        tag.decompose()

    # Remove obvious cookie / accessibility overlays.
    for tag in working.find_all(
        attrs={
            "aria-hidden": "true"
        }
    ):
        tag.decompose()

    text = working.get_text(
        "\n",
        strip=True,
    )

    return clean_multiline_text(text)


def extract_headings(
    soup: BeautifulSoup,
) -> list[str]:
    headings = []

    for tag in soup.find_all(
        [
            "h1",
            "h2",
            "h3",
            "h4",
        ]
    ):
        value = clean_text(
            tag.get_text(
                " ",
                strip=True,
            )
        )

        if value:
            headings.append(value)

    return unique_preserve_order(
        headings
    )


# ============================================================
# LISTING PAGE
# ============================================================

def extract_listing_promotions(
    html: str,
) -> list[dict]:
    """
    Discover promotion cards from the Prudential
    promotions landing page.

    We inspect links rather than relying on a fragile
    CSS class because CMS markup can change.
    """

    soup = soup_from_html(html)

    discovered = []

    seen_urls = set()

    for link in soup.find_all(
        "a",
        href=True,
    ):
        href = normalize_url(
            link.get("href", "")
        )

        if not looks_like_promotion_url(
            href
        ):
            continue

        if href in seen_urls:
            continue

        seen_urls.add(href)

        anchor_text = clean_text(
            link.get_text(
                " ",
                strip=True,
            )
        )

        # ----------------------------------------------------
        # Try to find the containing promotion card.
        # ----------------------------------------------------

        container = None

        for parent in link.parents:

            if parent.name not in (
                "div",
                "article",
                "li",
                "section",
            ):
                continue

            text = clean_text(
                parent.get_text(
                    " ",
                    strip=True,
                )
            )

            if len(text) >= 20:
                container = parent

            # Stop after reaching a reasonable card.
            if len(text) >= 80:
                break

        card_text = ""

        if container is not None:
            card_text = clean_text(
                container.get_text(
                    " ",
                    strip=True,
                )
            )

        title = anchor_text

        # ----------------------------------------------------
        # If the anchor says "Learn more", inspect headings
        # in the card.
        # ----------------------------------------------------

        if (
            not title
            or title.casefold() in {
                "learn more",
                "read more",
                "find out more",
                "click here",
            }
        ):
            if container is not None:

                heading = container.find(
                    [
                        "h1",
                        "h2",
                        "h3",
                        "h4",
                        "strong",
                    ]
                )

                if heading:
                    title = clean_text(
                        heading.get_text(
                            " ",
                            strip=True,
                        )
                    )

        # ----------------------------------------------------
        # Look for card description.
        # ----------------------------------------------------

        summary = ""

        if container is not None:

            candidates = []

            for tag in container.find_all(
                [
                    "p",
                    "div",
                    "span",
                ]
            ):

                value = clean_text(
                    tag.get_text(
                        " ",
                        strip=True,
                    )
                )

                if (
                    value
                    and value != title
                    and len(value) >= 15
                    and len(value) <= 500
                ):
                    candidates.append(value)

            if candidates:
                # Prefer the shortest useful text after
                # excluding navigation phrases.
                candidates = [
                    x
                    for x in candidates
                    if x.casefold()
                    not in {
                        "learn more",
                        "read more",
                    }
                ]

                if candidates:
                    summary = min(
                        candidates,
                        key=len,
                    )

        # ----------------------------------------------------
        # Avoid obvious false positives.
        # ----------------------------------------------------

        if not title:
            continue

        if title.casefold() in {
            "learn more",
            "read more",
            "terms and conditions",
            "terms & conditions",
        }:
            continue

        discovered.append(
            {
                "title": title,
                "summary": summary,
                "url": href,
            }
        )

    return discovered


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


def parse_date(
    value: str,
) -> str | None:

    value = clean_text(value)

    formats = (
        "%d %B %Y",
        "%d %b %Y",
        "%B %d %Y",
        "%B %d, %Y",
        "%b %d %Y",
        "%b %d, %Y",
    )

    for fmt in formats:

        try:
            parsed = datetime.strptime(
                value,
                fmt,
            ).date()

            return parsed.isoformat()

        except ValueError:
            continue

    return None


def extract_date_ranges(
    text: str,
) -> list[dict]:

    ranges = []

    for pattern in DATE_RANGE_PATTERNS:

        for match in pattern.finditer(
            text
        ):

            start = parse_date(
                match.group(1)
            )

            end = parse_date(
                match.group(2)
            )

            if not start or not end:
                continue

            item = {
                "start": start,
                "end": end,
            }

            if item not in ranges:
                ranges.append(item)

    ranges.sort(
        key=lambda item: (
            item["start"],
            item["end"],
        )
    )

    return ranges


def determine_status(
    periods: list[dict],
    today: date,
) -> str:

    if not periods:
        return "unknown"

    for period in periods:

        try:
            start = date.fromisoformat(
                period["start"]
            )

            end = date.fromisoformat(
                period["end"]
            )

        except ValueError:
            continue

        if start <= today <= end:
            return "active"

    # If all periods are in the future.
    future = False

    for period in periods:

        try:
            start = date.fromisoformat(
                period["start"]
            )

            if start > today:
                future = True

        except ValueError:
            pass

    if future:
        return "upcoming"

    return "expired"


# ============================================================
# STRUCTURED TEXT EXTRACTION
# ============================================================

def extract_lines(
    text: str,
) -> list[str]:

    return [
        clean_text(line)
        for line in text.splitlines()
        if clean_text(line)
    ]


def find_matching_lines(
    lines: list[str],
    keywords: tuple[str, ...],
) -> list[str]:

    matches = []

    for line in lines:

        lowered = line.casefold()

        if any(
            keyword.casefold() in lowered
            for keyword in keywords
        ):
            matches.append(line)

    return unique_preserve_order(
        matches
    )


def extract_payment_modes(
    text: str,
) -> list[str]:

    modes = []

    mode_patterns = {
        "monthly": r"\bmonthly\b",
        "quarterly": r"\bquarterly\b",
        "half-yearly": (
            r"\bhalf[- ]yearly\b"
        ),
        "annually": (
            r"\bannually\b|\bannual\b"
        ),
    }

    for name, pattern in mode_patterns.items():

        if re.search(
            pattern,
            text,
            flags=re.I,
        ):
            modes.append(name)

    return modes


def extract_eligible_plans(
    text: str,
) -> list[str]:

    """
    Conservative extraction.

    We only return plan names that appear verbatim
    in the page text.
    """

    patterns = [
        r"PRUActive Term",
        r"PRUActive Protect II",
        r"PRUActive Life V",
        r"PRUActive Family Care",
        r"PRUVantage Assure II",
        r"PRUVantage Wealth III",
        r"PRUVantage Wealth II",
        r"PRUVantage Prosper",
        r"PRUVantage Legacy Index",
        r"PRUHospital Care360",
        r"PRULife Vantage Achiever Prime II",
        r"PRU Wealth Plus",
        r"PRU Wealth",
        r"PRUUnited Wealth",
        r"PRULink StrategicInvest Income Fund",
        r"PRUPrime CIO Conservative Fund",
        r"PRUPrime CIO Balanced Fund",
        r"PRUPrime CIO Growth Fund",
    ]

    found = []

    for pattern in patterns:

        matches = re.findall(
            pattern,
            text,
            flags=re.I,
        )

        for match in matches:
            found.append(match)

    return unique_preserve_order(
        found
    )


def extract_reward_lines(
    lines: list[str],
) -> list[str]:

    keywords = (
        "%",
        "discount",
        "reward",
        "bonus units",
        "voucher",
        "cashback",
        "miles",
        "complimentary",
        "premium",
        "promotion bonus",
    )

    return find_matching_lines(
        lines,
        keywords,
    )


# ============================================================
# DETAIL PAGE
# ============================================================

def extract_detail_page(
    promotion: dict,
    today: date,
) -> dict:

    url = promotion["url"]

    result = {
        "title": promotion.get(
            "title",
            "",
        ),
        "summary": promotion.get(
            "summary",
            "",
        ),
        "url": url,
        "promotionPeriods": [],
        "status": "unknown",
        "eligiblePlans": [],
        "paymentModes": [],
        "rewardsAndDiscounts": [],
        "headings": [],
        "details": "",
        "extractionStatus": "pending",
        "error": None,
    }

    try:
        html = fetch_page(url)

        soup = soup_from_html(html)

        title = extract_page_title(
            soup
        )

        if title:
            result["title"] = title

        text = extract_page_text(
            soup
        )

        lines = extract_lines(
            text
        )

        periods = extract_date_ranges(
            text
        )

        result["promotionPeriods"] = periods

        result["status"] = determine_status(
            periods,
            today,
        )

        result["eligiblePlans"] = (
            extract_eligible_plans(
                text
            )
        )

        result["paymentModes"] = (
            extract_payment_modes(
                text
            )
        )

        result["rewardsAndDiscounts"] = (
            extract_reward_lines(
                lines
            )
        )

        result["headings"] = (
            extract_headings(
                soup
            )
        )

        result["details"] = text

        result["extractionStatus"] = (
            "success"
        )

        result["error"] = None

    except Exception as exc:

        result["extractionStatus"] = (
            "error"
        )

        result["error"] = str(exc)

        log(
            f"ERROR: {url} -> {exc}"
        )

    return result


# ============================================================
# DEDUPLICATION
# ============================================================

def deduplicate_promotions(
    promotions: list[dict],
) -> list[dict]:

    result = []

    seen = set()

    for promotion in promotions:

        url = normalize_url(
            promotion.get(
                "url",
                "",
            )
        )

        if not url:
            continue

        key = url.casefold()

        if key in seen:
            continue

        seen.add(key)

        promotion["url"] = url

        result.append(
            promotion
        )

    return result


# ============================================================
# JSON OUTPUT
# ============================================================

def write_output(
    promotions: list[dict],
    retrieved_date: str,
    retrieved_timestamp: str,
) -> None:

    DATA_DIR.mkdir(
        parents=True,
        exist_ok=True,
    )

    output = {
        "schemaVersion": "1.0",
        "source": {
            "name": SOURCE_NAME,
            "url": SOURCE_URL,
        },
        "retrievedDate": retrieved_date,
        "retrievedTimestamp": retrieved_timestamp,
        "promotionCount": len(promotions),
        "promotions": promotions,
    }

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


# ============================================================
# MAIN
# ============================================================

def main() -> int:

    log("=" * 72)
    log(
        "PRUDENTIAL SINGAPORE "
        "PROMOTIONS EXTRACTOR"
    )
    log("=" * 72)

    # --------------------------------------------------------
    # Singapore calendar date.
    # --------------------------------------------------------

    from zoneinfo import ZoneInfo

    singapore_now = datetime.now(
        ZoneInfo("Asia/Singapore")
    )

    retrieved_date = (
        singapore_now.date().isoformat()
    )

    retrieved_timestamp = (
        singapore_now.isoformat()
    )

    today = singapore_now.date()

    log(
        f"Singapore date: "
        f"{retrieved_date}"
    )

    log(
        f"Source: {SOURCE_URL}"
    )

    # --------------------------------------------------------
    # Landing page.
    # --------------------------------------------------------

    try:
        landing_html = fetch_page(
            SOURCE_URL
        )

    except Exception as exc:

        log(
            f"FATAL: Could not retrieve "
            f"promotions page: {exc}"
        )

        return 1

    # --------------------------------------------------------
    # Discover promotion URLs.
    # --------------------------------------------------------

    promotions = (
        extract_listing_promotions(
            landing_html
        )
    )

    promotions = (
        deduplicate_promotions(
            promotions
        )
    )

    log(
        f"Discovered "
        f"{len(promotions)} "
        f"promotion page(s)"
    )

    if not promotions:

        log(
            "FATAL: No promotion pages "
            "were discovered."
        )

        return 1

    # --------------------------------------------------------
    # Detail pages.
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
            promotion,
            today,
        )

        extracted.append(
            result
        )

        if (
            index < len(promotions)
            and REQUEST_DELAY_SECONDS > 0
        ):
            time.sleep(
                REQUEST_DELAY_SECONDS
            )

    # --------------------------------------------------------
    # Stable sorting.
    #
    # Active
    # Upcoming
    # Unknown
    # Expired
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
                item.get(
                    "status",
                    "unknown",
                ),
                99,
            ),
            item.get(
                "title",
                "",
            ).casefold(),
            item.get(
                "url",
                "",
            ),
        )
    )

    # --------------------------------------------------------
    # Write output.
    # --------------------------------------------------------

    write_output(
        extracted,
        retrieved_date,
        retrieved_timestamp,
    )

    # --------------------------------------------------------
    # Statistics.
    # --------------------------------------------------------

    success_count = sum(
        1
        for item in extracted
        if item.get(
            "extractionStatus"
        ) == "success"
    )

    error_count = sum(
        1
        for item in extracted
        if item.get(
            "extractionStatus"
        ) == "error"
    )

    active_count = sum(
        1
        for item in extracted
        if item.get(
            "status"
        ) == "active"
    )

    upcoming_count = sum(
        1
        for item in extracted
        if item.get(
            "status"
        ) == "upcoming"
    )

    expired_count = sum(
        1
        for item in extracted
        if item.get(
            "status"
        ) == "expired"
    )

    log("-" * 72)
    log("EXTRACTION SUMMARY")
    log("-" * 72)
    log(
        f"Promotions discovered : "
        f"{len(extracted)}"
    )
    log(
        f"Successful             : "
        f"{success_count}"
    )
    log(
        f"Errors                 : "
        f"{error_count}"
    )
    log(
        f"Active                 : "
        f"{active_count}"
    )
    log(
        f"Upcoming               : "
        f"{upcoming_count}"
    )
    log(
        f"Expired                : "
        f"{expired_count}"
    )
    log(
        f"Output                 : "
        f"{OUTPUT_FILE}"
    )
    log("=" * 72)

    # --------------------------------------------------------
    # Do not fail merely because an individual page failed.
    #
    # The landing page and other promotions can still be
    # successfully updated.
    # --------------------------------------------------------

    return 0


if __name__ == "__main__":
    sys.exit(main())
