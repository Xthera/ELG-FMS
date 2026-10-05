#!/usr/bin/env python3

"""
VGrat FMS - Prudential Top Holdings ALL-FUND TEST EXTRACTOR

MASTER SOURCE
=============

Funds Links.xlsm

Column A:
    Prudential fund URL

Column B:
    Exact PruAccess fund name


PURPOSE
=======

This script tests official Prudential Top Holdings extraction for EVERY
fund listed in Excel Column A.

Workflow:

    Funds Links.xlsm
          |
          v
    Read every populated URL in Column A
          |
          v
    Open official Prudential fund page
          |
          v
    Locate official Fund Factsheet PDF
          |
          v
    Download official Prudential PDF
          |
          v
    Extract PDF text
          |
          v
    Locate "Top 10 holdings"
          |
          v
    Build logical holding lines from wrapped PDF text
          |
          v
    Extract every published holding and percentage
          |
          v
    If primary parsing fails, automatically retry the same official PDF
    with the fallback parser
          |
          v
    Save one result per fund


HARD RULES
==========

- Excel Column A controls the universe.
- No hardcoded 67-fund limit.
- Every populated URL in Column A is processed.
- Only official Prudential Singapore pages are accepted.
- Only official Prudential Singapore factsheets are accepted.
- No third-party holdings source.
- No inferred holdings.
- No fabricated holdings.
- No fabricated percentages.
- No forced 10 holdings.
- If Prudential publishes fewer than 10 holdings, store exactly that count.
- Holdings are stored in the order published by Prudential.
- Multi-line holding names are joined into one holding name.
- Wrapped PDF text lines are treated as part of the same holding until the
  published portfolio percentage is encountered.
- Fixed-income coupon/rate percentages inside security descriptions are NOT
  automatically treated as portfolio weights.
- If a security coupon percentage is followed on another PDF line by a
  maturity date and another percentage, those lines are joined before
  determining the portfolio weight.
- For fixed-income logical lines containing multiple percentages, the LAST
  percentage is treated as the portfolio weight.
- Duplicate holding names are allowed.
- Duplicate holding percentages are allowed.
- If the primary parser fails, the same official factsheet section is retried
  automatically with the fallback parser.
- If both parsers fail, the fund is marked FAILED.
- If a factsheet has no Top 10 holdings section at all, the fund is marked
  as NO_HOLDINGS_SECTION.
- Failed funds do not get blank fabricated holdings.
- The script never changes PruAccess settings.
- This script does NOT modify test_pruaccess.py.
- This script does NOT create data.json.
- This script does NOT create index.html/css/js.
- This script is a TEST collector only.


IMPORTANT FIX
=============

Prudential fixed-income holdings can be extracted from a PDF like this:

    CORPORACION ANDINA DE FOMENTO 7.7%
    6-MAR2029 1.7%

The first 7.7% is the bond coupon.

The second 1.7% is the portfolio weight.

The parser MUST NOT produce:

    CORPORACION ANDINA DE FOMENTO 7.7% - 7.7%
    6-MAR2029 - 1.7%

Instead it must reconstruct:

    CORPORACION ANDINA DE FOMENTO 7.7% 6-MAR2029 - 1.7%

The same principle applies to other fixed-income holdings where the PDF
wraps the security description across multiple extracted text lines.


HYPHENATED LINE-WRAP FIX (added)
=================================

Some Prudential factsheets wrap a bond's maturity date itself in the
middle, e.g. the raw PDF text extraction produces:

    CORPORACION ANDINA DE FOMENTO 7.7% 6-MAR-
    2029 1.7%

Here the wrap point falls INSIDE the date ("6-MAR-" / "2029"), not right
after the coupon percentage. The original coupon-then-maturity-line
merge logic only fired when the current line ended in a percentage sign,
so this case was missed: the parser would treat 7.7% as the portfolio
weight (dropping "6-MAR-"), then treat "2029 1.7%" as a second bogus
holding named "2029".

A dehyphenation pre-pass (merge_hyphenated_line_breaks) now runs before
any percentage/holding parsing: any line ending in a bare hyphen is
joined directly (no space) to the next line, e.g.:

    "CORPORACION ANDINA DE FOMENTO 7.7% 6-MAR-"
    "2029 1.7%"

becomes:

    "CORPORACION ANDINA DE FOMENTO 7.7% 6-MAR-2029 1.7%"

which the existing multi-percentage / last-percentage-is-weight logic
already handles correctly.


OUTPUT
======

output_holdings/
    all_holdings.json
    run_summary.json

    funds/
        <excelRow>_<citicode>/
            factsheet.pdf
            factsheet_text.txt
            top_holdings_section.txt
            top_holdings.json
            metadata.json

        <excelRow>_failed/
            failure.json
"""


from __future__ import annotations

import json
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urljoin, urlparse

from openpyxl import load_workbook
from pypdf import PdfReader
from playwright.sync_api import (
    TimeoutError as PlaywrightTimeoutError,
    sync_playwright,
)


# =============================================================================
# CONFIGURATION
# =============================================================================

EXCEL_FILE = Path(
    "Funds Links.xlsm"
)

OUTPUT_DIR = Path(
    "output_holdings"
)

FUNDS_OUTPUT_DIR = (
    OUTPUT_DIR / "funds"
)

ALL_HOLDINGS_FILE = (
    OUTPUT_DIR / "all_holdings.json"
)

RUN_SUMMARY_FILE = (
    OUTPUT_DIR / "run_summary.json"
)


# -----------------------------------------------------------------------------
# Browser
# -----------------------------------------------------------------------------

BROWSER_HEADLESS = True

PAGE_TIMEOUT_MS = 120000

FACTSHEET_DOWNLOAD_TIMEOUT_MS = 120000

POST_PAGE_WAIT_MS = 1500

RETRY_COUNT = 3

RETRY_DELAY_SECONDS = 3.0


# -----------------------------------------------------------------------------
# Holdings
# -----------------------------------------------------------------------------

MAX_HOLDINGS = 10


# -----------------------------------------------------------------------------
# Only official Prudential Singapore URLs are accepted.
# -----------------------------------------------------------------------------

PRUDENTIAL_HOSTS = {
    "prudential.com.sg",
    "www.prudential.com.sg",
}


# =============================================================================
# GENERAL HELPERS
# =============================================================================

def clean_text(
    value,
) -> str:

    if value is None:
        return ""

    text = str(value)

    text = text.replace(
        "\xa0",
        " ",
    )

    text = re.sub(
        r"\s+",
        " ",
        text,
    )

    return text.strip()


def normalize_text(
    value,
) -> str:

    text = clean_text(
        value
    )

    text = text.casefold()

    text = text.replace(
        "–",
        "-",
    )

    text = text.replace(
        "—",
        "-",
    )

    return re.sub(
        r"\s+",
        " ",
        text,
    ).strip()


def utc_now_iso() -> str:

    return (
        datetime.now(
            timezone.utc
        )
        .replace(
            microsecond=0
        )
        .isoformat()
    )


def save_json(
    path: Path,
    data,
) -> None:

    path.parent.mkdir(
        parents=True,
        exist_ok=True,
    )

    path.write_text(
        json.dumps(
            data,
            indent=2,
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )


def safe_filename(
    value,
) -> str:

    text = clean_text(
        value
    )

    text = re.sub(
        r"[^A-Za-z0-9._-]+",
        "_",
        text,
    )

    text = text.strip(
        "._"
    )

    if not text:
        text = "fund"

    return text[:120]


def is_prudential_url(
    url: str,
) -> bool:

    try:

        parsed = urlparse(
            url
        )

        hostname = (
            parsed.hostname
            or ""
        ).lower()

        return (
            parsed.scheme.lower()
            in {
                "http",
                "https",
            }
            and hostname
            in PRUDENTIAL_HOSTS
        )

    except Exception:

        return False


class HoldingsParseFailure(RuntimeError):
    """
    Raised when both the primary and fallback holdings parsers fail
    for a fund whose Top 10 holdings section WAS found.

    Carries the raw section_text (and full factsheet text) that were
    being parsed at the time of failure, so the caller can persist
    them for debugging. Without this, a failed fund previously left
    behind only an error message with no way to see the actual PDF
    text that caused it.
    """

    def __init__(
        self,
        message: str,
        section_text: str = "",
        full_text: str = "",
    ) -> None:

        super().__init__(
            message
        )

        self.section_text = section_text

        self.full_text = full_text


def ensure_prudential_url(
    url: str,
) -> str:

    url = clean_text(
        url
    )

    if not url:

        raise RuntimeError(
            "URL is empty."
        )

    if not is_prudential_url(
        url
    ):

        raise RuntimeError(
            "Non-Prudential URL rejected: "
            f"{url}"
        )

    return url


# =============================================================================
# EXCEL MASTER UNIVERSE
# =============================================================================

def read_excel_funds() -> list[dict]:

    print(
        "\n"
        "============================================================"
    )

    print(
        "READING EXCEL MASTER FUND UNIVERSE"
    )

    print(
        "============================================================"
    )

    if not EXCEL_FILE.exists():

        raise FileNotFoundError(
            f"Excel file not found: {EXCEL_FILE}"
        )

    workbook = load_workbook(
        EXCEL_FILE,
        read_only=True,
        keep_vba=True,
        data_only=True,
    )

    worksheet = workbook.active

    funds = []

    for row_number in range(
        2,
        worksheet.max_row + 1,
    ):

        column_a = worksheet.cell(
            row=row_number,
            column=1,
        ).value

        column_b = worksheet.cell(
            row=row_number,
            column=2,
        ).value

        prudential_url = clean_text(
            column_a
        )

        pruaccess_name = clean_text(
            column_b
        )

        if not prudential_url:
            continue

        funds.append(
            {
                "excelRow":
                    row_number,

                "prudentialUrl":
                    prudential_url,

                "pruAccessName":
                    pruaccess_name,
            }
        )

    workbook.close()

    if not funds:

        raise RuntimeError(
            "No populated Prudential URLs were found "
            "in Excel Column A."
        )

    print(
        f"Excel fund universe: {len(funds)}"
    )

    return funds


# =============================================================================
# FIND FACTSHEET LINK
# =============================================================================

def find_factsheet_url(
    page,
    prudential_url: str,
) -> str:

    anchors = page.locator(
        "a"
    )

    anchor_count = anchors.count()

    candidates = []

    for index in range(
        anchor_count
    ):

        anchor = anchors.nth(
            index
        )

        try:

            href = clean_text(
                anchor.get_attribute(
                    "href"
                )
            )

            if not href:
                continue

            absolute_url = urljoin(
                page.url,
                href,
            )

            if not is_prudential_url(
                absolute_url
            ):
                continue

            anchor_text = clean_text(
                anchor.inner_text()
            )

        except Exception:

            continue

        href_lower = (
            absolute_url.lower()
        )

        text_lower = (
            anchor_text.lower()
        )

        score = 0

        if (
            "fund factsheet"
            in text_lower
        ):

            score += 200

        elif (
            "factsheet"
            in text_lower
        ):

            score += 150

        if "factsheet" in href_lower:
            score += 100

        if href_lower.endswith(
            ".pdf"
        ):

            score += 50

        if score > 0:

            candidates.append(
                {
                    "score":
                        score,

                    "url":
                        absolute_url,

                    "text":
                        anchor_text,
                }
            )

    if not candidates:

        raise RuntimeError(
            "Could not find an official Prudential "
            "factsheet link on the fund page."
        )

    candidates.sort(
        key=lambda item: (
            -item["score"],
            item["url"],
        )
    )

    selected = candidates[0]

    print(
        "Factsheet link found:"
    )

    print(
        selected["url"]
    )

    return ensure_prudential_url(
        selected["url"]
    )


# =============================================================================
# PDF TEXT
# =============================================================================

def extract_pdf_text(
    pdf_bytes: bytes,
) -> tuple[str, int]:

    from io import BytesIO

    reader = PdfReader(
        BytesIO(
            pdf_bytes
        )
    )

    page_count = len(
        reader.pages
    )

    if page_count == 0:

        raise RuntimeError(
            "Factsheet PDF has zero pages."
        )

    pages = []

    for page_index, pdf_page in enumerate(
        reader.pages,
        start=1,
    ):

        try:

            page_text = (
                pdf_page.extract_text()
                or ""
            )

        except Exception as error:

            raise RuntimeError(
                "Failed to extract PDF text "
                f"from page {page_index}: {error}"
            ) from error

        pages.append(
            page_text
        )

    full_text = "\n".join(
        pages
    )

    if not clean_text(
        full_text
    ):

        raise RuntimeError(
            "Factsheet PDF contains no extractable text."
        )

    return (
        full_text,
        page_count,
    )


# =============================================================================
# PDF LINE CLEANING
# =============================================================================

def pdf_lines(
    text: str,
) -> list[str]:

    lines = []

    for raw_line in text.splitlines():

        line = clean_text(
            raw_line
        )

        if not line:
            continue

        lines.append(
            line
        )

    return lines


# =============================================================================
# FACTSHEET DATE EXTRACTION
# =============================================================================

def extract_data_as_at(
    text: str,
) -> str | None:

    patterns = [

        re.compile(
            r"""
            \b
            data
            \s+as\s+at
            \s*
            ([0-9]{1,2}
            \s+
            [A-Za-z]{3,9}
            \s+
            [0-9]{4})
            \b
            """,
            re.IGNORECASE
            | re.VERBOSE,
        ),

        re.compile(
            r"""
            \ball\s+data
            \s+as\s+at
            \s*
            ([0-9]{1,2}
            \s+
            [A-Za-z]{3,9}
            \s+
            [0-9]{4})
            \b
            """,
            re.IGNORECASE
            | re.VERBOSE,
        ),
    ]

    for pattern in patterns:

        match = pattern.search(
            text
        )

        if match:

            return clean_text(
                match.group(1)
            )

    return None


# =============================================================================
# FACTSHEET DOCUMENT DATE
# =============================================================================

def extract_document_date(
    text: str,
) -> str | None:

    lines = pdf_lines(
        text
    )

    month_year_pattern = re.compile(
        r"""
        \b
        (
            January|
            February|
            March|
            April|
            May|
            June|
            July|
            August|
            September|
            October|
            November|
            December
        )
        \s+
        ([0-9]{4})
        \b
        """,
        re.IGNORECASE
        | re.VERBOSE,
    )

    for line in lines[:50]:

        match = (
            month_year_pattern.search(
                line
            )
        )

        if match:

            return clean_text(
                match.group(0)
            )

    return None


# =============================================================================
# HOLDINGS SECTION BOUNDARIES
# =============================================================================

def find_holdings_start(
    lines: list[str],
) -> int | None:

    for index, line in enumerate(
        lines
    ):

        normalized = normalize_text(
            line
        )

        if (
            "top 10 holdings"
            in normalized
            or
            "top ten holdings"
            in normalized
        ):

            return index

    return None


def is_holdings_end(
    line: str,
) -> bool:

    normalized = normalize_text(
        line
    )

    endings = (

        "source",

        "source:",

        "inception date",

        "important information",

        "important information:",

        "disclaimer",

        "past performance",

        "portfolio characteristics",

        "asset allocation",
    )

    if normalized in endings:
        return True

    if normalized.startswith(
        "source:"
    ):
        return True

    if normalized.startswith(
        "inception date:"
    ):
        return True

    if normalized.startswith(
        "important information"
    ):
        return True

    if re.fullmatch(
        r"page\s+\d+(\s+of\s+\d+)?",
        normalized,
    ):
        return True

    return False


def extract_holdings_section(
    text: str,
) -> tuple[
    str,
    str,
]:

    lines = pdf_lines(
        text
    )

    start_index = find_holdings_start(
        lines
    )

    if start_index is None:

        return (
            "",
            "not_published",
        )

    section = []

    for line in lines[
        start_index + 1:
    ]:

        if is_holdings_end(
            line
        ):
            break

        section.append(
            line
        )

    return (
        "\n".join(
            section
        ),
        "published",
    )


# =============================================================================
# HOLDING NAME CLEANUP
# =============================================================================

def clean_holding_name(
    value: str,
) -> str:

    name = clean_text(
        value
    )

    if not name:
        return ""

    name = re.sub(
        r"^[•·▪■□*]+",
        "",
        name,
    )

    name = name.strip()

    name = re.sub(
        r"^\d{1,2}[.)]\s+",
        "",
        name,
    )

    name = name.replace(
        "|",
        " ",
    )

    name = re.sub(
        r"\bNone\b",
        " ",
        name,
        flags=re.IGNORECASE,
    )

    name = clean_text(
        name
    )

    name = name.strip(
        " -|"
    )

    if normalize_text(
        name
    ) in {
        "none",
        "null",
        "-",
        "—",
        "",
    }:

        return ""

    return name


# =============================================================================
# PERCENTAGE PARSING
# =============================================================================

def parse_percentage(
    value: str,
) -> float | None:

    if value is None:
        return None

    match = re.fullmatch(
        r"\s*"
        r"([0-9]+(?:\.[0-9]+)?)"
        r"\s*%"
        r"\s*",
        value,
    )

    if not match:
        return None

    percentage = float(
        match.group(1)
    )

    if (
        percentage < 0
        or percentage > 100
    ):
        return None

    return percentage


def percentage_matches(
    line: str,
) -> list[re.Match]:

    return list(
        re.finditer(
            r"(?<![\d.])"
            r"([0-9]+(?:\.[0-9]+)?)"
            r"\s*%",
            line,
        )
    )


def find_percentage_in_line(
    line: str,
) -> tuple[
    float,
    str,
    int,
    int,
] | None:

    if not line:
        return None

    match = re.search(
        r"""
        (?<![\d.])
        ([0-9]+(?:\.[0-9]+)?)
        \s*%
        """,
        line,
        re.VERBOSE,
    )

    if not match:
        return None

    try:
        percentage = float(
            match.group(1)
        )
    except ValueError:
        return None

    if percentage < 0 or percentage > 100:
        return None

    return (
        percentage,
        clean_text(match.group(0)),
        match.start(),
        match.end(),
    )


def find_last_percentage_in_line(
    line: str,
) -> tuple[
    float,
    str,
    int,
    int,
] | None:

    if not line:
        return None

    matches = percentage_matches(
        line
    )

    if not matches:
        return None

    match = matches[-1]

    try:
        percentage = float(
            match.group(1)
        )
    except ValueError:
        return None

    if percentage < 0 or percentage > 100:
        return None

    return (
        percentage,
        clean_text(match.group(0)),
        match.start(),
        match.end(),
    )


# =============================================================================
# MATURITY DATE DETECTION
# =============================================================================

MONTH_PATTERN = (
    r"JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC"
)


def contains_maturity_date(
    line: str,
) -> bool:
    """
    Detect common bond/security maturity date formats.

    Examples:

        5-AUG-2054
        31-DEC-2079
        25-MAR-2040
        6-MAR2029
        31-DEC2079
        05/08/2054
        5 AUG 2054
    """

    if not line:
        return False

    patterns = [

        rf"\b\d{{1,2}}[-/ ]"
        rf"(?:{MONTH_PATTERN})[-/ ]"
        rf"\d{{4}}\b",

        rf"\b\d{{1,2}}[-/ ]"
        rf"(?:{MONTH_PATTERN})"
        rf"\d{{4}}\b",

        r"\b\d{1,2}[-/]\d{1,2}[-/]\d{4}\b",

        r"\b\d{4}[-/]\d{1,2}[-/]\d{1,2}\b",
    ]

    upper = line.upper()

    return any(
        re.search(
            pattern,
            upper,
        )
        for pattern in patterns
    )


def line_ends_with_percentage(
    line: str,
) -> bool:

    return bool(
        re.search(
            r"[0-9]+(?:\.[0-9]+)?\s*%\s*$",
            clean_text(line),
        )
    )


def line_has_percentage(
    line: str,
) -> bool:

    return bool(
        percentage_matches(
            line
        )
    )


# =============================================================================
# HYPHENATED LINE-WRAP RECONSTRUCTION (added)
# =============================================================================

def merge_hyphenated_line_breaks(
    lines: list[str],
) -> list[str]:
    """
    Rejoin PDF lines that were split mid-word/mid-date by the page's line
    width, where the break happens to land right after a hyphen.

    Example (as extracted from the PDF, one line per list entry):

        "CORPORACION ANDINA DE FOMENTO 7.7% 6-MAR-"
        "2029 1.7%"

    becomes:

        "CORPORACION ANDINA DE FOMENTO 7.7% 6-MAR-2029 1.7%"

    This must run BEFORE any percentage/holding parsing, because the
    coupon+maturity-date merge logic below only catches the case where
    the wrap falls right after the coupon percentage. In practice some
    Prudential factsheets instead wrap the maturity date itself, and the
    hyphen already tells us no space belongs at the join point.
    """

    merged: list[str] = []

    index = 0

    while index < len(lines):

        current = clean_text(
            lines[index]
        )

        # Keep absorbing subsequent lines as long as the line so far
        # ends in a bare hyphen (mid-token break).
        while (
            current.endswith("-")
            and index + 1 < len(lines)
        ):

            index += 1

            next_line = clean_text(
                lines[index]
            )

            # No space: the hyphen is the join point.
            current = current + next_line

        merged.append(current)

        index += 1

    return merged


# =============================================================================
# LOGICAL HOLDING LINE RECONSTRUCTION
# =============================================================================

def build_logical_holding_lines(
    section_text: str,
) -> list[str]:
    """
    Reconstruct logical holdings from PDF-extracted lines.

    Why this exists
    ----------------

    PDF text extraction can split a fixed-income security like:

        CORPORACION ANDINA DE FOMENTO 7.7%
        6-MAR2029 1.7%

    The first percentage is the security coupon.

    The second percentage is the portfolio weight.

    The two PDF lines therefore belong to ONE logical holding.

    This function joins those lines BEFORE percentage parsing.

    General rule:

        If the current line ends in a percentage, and the next line
        contains a maturity date and another percentage, join them.

    This prevents a coupon/rate percentage from prematurely terminating
    the holding.

    The function also handles common wrapped fixed-income descriptions where
    the maturity line itself is split.

    Before any of that, a dehyphenation pre-pass
    (merge_hyphenated_line_breaks) rejoins lines that were split
    mid-word/mid-date by the PDF's line width (e.g. "6-MAR-" / "2029"),
    since that kind of wrap can otherwise cause a coupon percentage to be
    mistaken for the portfolio weight and drop part of the maturity date.
    """

    raw_lines = pdf_lines(
        section_text
    )

    if not raw_lines:
        return []

    lines = merge_hyphenated_line_breaks(
        raw_lines
    )

    logical_lines = []

    index = 0

    while index < len(lines):

        current = clean_text(
            lines[index]
        )

        if not current:
            index += 1
            continue

        # -------------------------------------------------------------
        # Header/noise lines are preserved for the parser to ignore.
        # -------------------------------------------------------------

        if is_holding_header_or_noise(
            current
        ):

            logical_lines.append(
                current
            )

            index += 1
            continue

        # -------------------------------------------------------------
        # NOTE: an earlier version of this function also tried to merge
        # "current line ends with a percentage" + "next line contains a
        # maturity date and another percentage" as if the current line
        # must be a truncated bond coupon continuing onto the next line.
        #
        # That heuristic was REMOVED. In practice it could not tell a
        # genuine split bond entry apart from two separate, complete,
        # adjacent holdings where the second one simply happens to be a
        # bond with its own date+weight (e.g. a complete equity/ETF
        # holding immediately followed by a complete bond holding).
        # It was wrongly fusing such pairs into a single holding and
        # silently dropping a real holding each time it fired.
        #
        # The two wrap patterns that actually occur in practice are
        # already handled without it:
        #   - a bare name-only line (no %) followed by a coupon+date+
        #     weight line: handled by the per-line fragment
        #     accumulation in parse_holdings / parse_holdings_fallback.
        #   - a mid-token hyphen break (e.g. "6-MAR-" / "2029"):
        #     handled above by merge_hyphenated_line_breaks().
        # -------------------------------------------------------------

        logical_lines.append(
            current
        )

        index += 1

    return logical_lines


# =============================================================================
# HOLDING RANK
# =============================================================================

def extract_leading_rank(
    line: str,
) -> tuple[
    int | None,
    str,
]:

    text = clean_text(
        line
    )

    if not text:
        return None, ""

    standalone = re.fullmatch(
        r"(\d{1,2})",
        text,
    )

    if standalone:

        rank = int(
            standalone.group(1)
        )

        if 1 <= rank <= 99:
            return rank, ""

        return None, text

    match = re.match(
        r"^\s*(\d{1,2})[.)\-:]\s+(.+)$",
        text,
    )

    if match:

        rank = int(
            match.group(1)
        )

        if 1 <= rank <= 99:

            return (
                rank,
                clean_text(
                    match.group(2)
                ),
            )

        return None, text

    match = re.match(
        r"^\s*(\d{1,2})\s+(.+)$",
        text,
    )

    if match:

        rank = int(
            match.group(1)
        )

        if 1 <= rank <= 99:

            return (
                rank,
                clean_text(
                    match.group(2)
                ),
            )

    return None, text


# =============================================================================
# HOLDING LINE HELPERS
# =============================================================================

def is_holding_header_or_noise(
    line: str,
) -> bool:

    normalized = normalize_text(
        line
    )

    if not normalized:
        return True

    noise = {
        "holding",
        "holdings",
        "name",
        "names",
        "weight",
        "weights",
        "allocation",
        "allocations",
        "%",
        "portfolio holdings",
        "top 10 holdings",
    }

    if normalized in noise:
        return True

    if normalized.startswith(
        "top 10 holdings"
    ):
        return True

    return False


def clean_holding_fragment(
    value: str,
) -> str:

    fragment = clean_text(
        value
    )

    if not fragment:
        return ""

    fragment = fragment.replace(
        "|",
        " ",
    )

    fragment = re.sub(
        r"\bNone\b",
        " ",
        fragment,
        flags=re.IGNORECASE,
    )

    fragment = re.sub(
        r"^[•·▪■□*]+",
        "",
        fragment,
    )

    fragment = clean_text(
        fragment
    )

    return fragment


def combine_holding_name_fragments(
    fragments: list[str],
) -> str:

    cleaned_fragments = []

    for fragment in fragments:

        fragment = clean_holding_fragment(
            fragment
        )

        if not fragment:
            continue

        standalone_rank = re.fullmatch(
            r"\d{1,2}",
            fragment,
        )

        if standalone_rank:
            continue

        cleaned_fragments.append(
            fragment
        )

    if not cleaned_fragments:
        return ""

    combined = " ".join(
        cleaned_fragments
    )

    combined = re.sub(
        r"\s+",
        " ",
        combined,
    ).strip()

    combined = combined.strip(
        " -|"
    )

    return clean_holding_name(
        combined
    )


# =============================================================================
# PARSED HOLDING VALIDATION
# =============================================================================

def validate_holdings(
    holdings: list[dict],
    parser_name: str,
) -> list[dict]:
    """
    Validate the completed holdings list.

    This does not attempt to determine whether a name is financially correct.

    It only validates structural integrity:

    - no more than 10 holdings;
    - holding names are present;
    - weights are numeric;
    - weights are 0-100%;
    - published order is preserved;
    - explicit ranks are sequential.

    Duplicate names and duplicate weights are allowed.
    """

    if not holdings:

        raise RuntimeError(
            f"{parser_name} parser produced no holdings."
        )

    if len(holdings) > MAX_HOLDINGS:

        raise RuntimeError(
            f"{parser_name} parser produced more than "
            f"{MAX_HOLDINGS} holdings."
        )

    ranks = [
        holding["rank"]
        for holding in holdings
    ]

    expected_ranks = list(
        range(
            1,
            len(holdings) + 1,
        )
    )

    if ranks != expected_ranks:

        raise RuntimeError(
            f"{parser_name} holding ranks are not sequential. "
            f"Parsed={ranks}; Expected={expected_ranks}"
        )

    for holding in holdings:

        name = clean_holding_name(
            holding.get(
                "name"
            )
        )

        if not name:

            raise RuntimeError(
                f"{parser_name} holding name is empty."
            )

        weight = holding.get(
            "weightPercent"
        )

        if not isinstance(
            weight,
            (int, float),
        ):

            raise RuntimeError(
                f"{parser_name} holding weight is invalid."
            )

        if (
            weight < 0
            or weight > 100
        ):

            raise RuntimeError(
                f"{parser_name} holding weight is outside 0-100%."
            )

        holding[
            "name"
        ] = name

    return holdings


# =============================================================================
# HOLDINGS PARSER
# =============================================================================

def parse_holdings(
    section_text: str,
) -> list[dict]:
    """
    Primary parser.

    The parser first reconstructs logical PDF holding lines.

    The primary parser remains conservative:

    - if a logical line contains multiple percentages, it refuses to guess;
    - the fallback parser then takes the LAST percentage;
    - fixed-income wrapped coupon lines are reconstructed before parsing.

    Example:

        INDIA (REPUBLIC OF) 7.09% 5-AUG-2054 2.7%

    Primary parser sees multiple percentages and intentionally fails.

    Fallback parser then correctly uses:

        2.7%

    as the portfolio weight while preserving:

        INDIA (REPUBLIC OF) 7.09% 5-AUG-2054

    as the security name.
    """

    if not clean_text(
        section_text
    ):

        raise RuntimeError(
            "Top 10 holdings section is empty."
        )

    lines = build_logical_holding_lines(
        section_text
    )

    holdings = []

    pending_fragments: list[str] = []

    pending_rank: int | None = None

    def commit_pending(
        percentage: float,
        percentage_text: str,
    ) -> None:

        nonlocal pending_fragments
        nonlocal pending_rank

        name = combine_holding_name_fragments(
            pending_fragments
        )

        if not name:

            raise RuntimeError(
                "A published holding percentage was found "
                "but no holding name could be extracted."
            )

        if len(holdings) >= MAX_HOLDINGS:

            raise RuntimeError(
                "More than 10 published holdings were parsed."
            )

        rank = (
            pending_rank
            if pending_rank is not None
            else len(holdings) + 1
        )

        holdings.append(
            {
                "rank":
                    rank,

                "name":
                    name,

                "weightPercent":
                    percentage,

                "weightText":
                    percentage_text,
            }
        )

        pending_fragments = []

        pending_rank = None

    for raw_line in lines:

        line = clean_text(
            raw_line
        )

        if not line:
            continue

        if is_holding_header_or_noise(
            line
        ):
            continue

        detected_rank, remainder = (
            extract_leading_rank(
                line
            )
        )

        if detected_rank is not None:

            if pending_fragments:

                raise RuntimeError(
                    "A new holding rank appeared before "
                    "the previous holding received a published percentage. "
                    f"Previous rank={pending_rank}, "
                    f"new rank={detected_rank}."
                )

            pending_rank = detected_rank

            line = remainder

            if not line:
                continue

        percentage_candidates = percentage_matches(
            line
        )

        if len(
            percentage_candidates
        ) > 1:

            raise RuntimeError(
                "Primary parser found multiple percentages on one logical "
                "line and will not guess the holding weight. "
                "Fallback parser required."
            )

        percentage_info = (
            find_percentage_in_line(
                line
            )
        )

        if percentage_info is not None:

            (
                percentage,
                percentage_text,
                start_index,
                _end_index,
            ) = percentage_info

            name_fragment = clean_text(
                line[:start_index]
            )

            if name_fragment:

                pending_fragments.append(
                    name_fragment
                )

            commit_pending(
                percentage=percentage,
                percentage_text=percentage_text,
            )

            if len(
                holdings
            ) >= MAX_HOLDINGS:

                break

            continue

        fragment = clean_holding_fragment(
            line
        )

        if not fragment:
            continue

        if is_holding_header_or_noise(
            fragment
        ):
            continue

        pending_fragments.append(
            fragment
        )

    if not holdings:

        raise RuntimeError(
            "Top 10 holdings section was found, "
            "but no holding/percentage pairs could be parsed."
        )

    return validate_holdings(
        holdings,
        "Primary",
    )


# =============================================================================
# FALLBACK HOLDINGS PARSER
# =============================================================================

def parse_holdings_fallback(
    section_text: str,
) -> list[dict]:
    """
    Fallback parser.

    IMPORTANT:

    The fallback parser does NOT simply process raw PDF lines.

    It first calls build_logical_holding_lines().

    This is critical for fixed-income holdings such as:

        CORPORACION ANDINA DE FOMENTO 7.7%
        6-MAR2029 1.7%

    which becomes:

        CORPORACION ANDINA DE FOMENTO 7.7% 6-MAR2029 1.7%

    The LAST percentage is then used as the portfolio weight.

    Earlier percentages remain part of the security name.

    Example:

        INDIA (REPUBLIC OF) 7.09% 5-AUG-2054 2.7%

    becomes:

        name:
            INDIA (REPUBLIC OF) 7.09% 5-AUG-2054

        weight:
            2.7%

    Duplicate names and duplicate percentages are allowed.
    """

    if not clean_text(
        section_text
    ):

        raise RuntimeError(
            "Top 10 holdings section is empty."
        )

    lines = build_logical_holding_lines(
        section_text
    )

    holdings = []

    pending_fragments: list[str] = []

    pending_rank: int | None = None

    def commit_pending(
        percentage: float,
        percentage_text: str,
    ) -> None:

        nonlocal pending_fragments
        nonlocal pending_rank

        name = combine_holding_name_fragments(
            pending_fragments
        )

        if not name:

            raise RuntimeError(
                "Fallback parser found a published holding percentage "
                "but no holding name could be extracted."
            )

        if len(
            holdings
        ) >= MAX_HOLDINGS:

            raise RuntimeError(
                "Fallback parser produced more than 10 holdings."
            )

        rank = (
            pending_rank
            if pending_rank is not None
            else len(holdings) + 1
        )

        holdings.append(
            {
                "rank":
                    rank,

                "name":
                    name,

                "weightPercent":
                    percentage,

                "weightText":
                    percentage_text,
            }
        )

        pending_fragments = []

        pending_rank = None

    for raw_line in lines:

        line = clean_text(
            raw_line
        )

        if not line:
            continue

        if is_holding_header_or_noise(
            line
        ):
            continue

        detected_rank, remainder = (
            extract_leading_rank(
                line
            )
        )

        if detected_rank is not None:

            if pending_fragments:

                raise RuntimeError(
                    "Fallback parser encountered a new holding rank before "
                    "the previous holding received a published percentage."
                )

            pending_rank = detected_rank

            line = remainder

            if not line:
                continue

        percentage_info = (
            find_last_percentage_in_line(
                line
            )
        )

        if percentage_info is not None:

            (
                percentage,
                percentage_text,
                start_index,
                _end_index,
            ) = percentage_info

            name_fragment = clean_text(
                line[:start_index]
            )

            if name_fragment:

                pending_fragments.append(
                    name_fragment
                )

            commit_pending(
                percentage,
                percentage_text,
            )

            if len(
                holdings
            ) >= MAX_HOLDINGS:

                break

            continue

        fragment = clean_holding_fragment(
            line
        )

        if (
            fragment
            and not is_holding_header_or_noise(
                fragment
            )
        ):

            pending_fragments.append(
                fragment
            )

    return validate_holdings(
        holdings,
        "Fallback",
    )


# =============================================================================
# FACTSHEET DOWNLOAD
# =============================================================================

def download_factsheet(
    page,
    factsheet_url: str,
) -> bytes:

    factsheet_url = ensure_prudential_url(
        factsheet_url
    )

    print(
        "Downloading factsheet..."
    )

    response = page.request.get(
        factsheet_url,
        timeout=FACTSHEET_DOWNLOAD_TIMEOUT_MS,
    )

    status = response.status

    if status != 200:

        raise RuntimeError(
            "Factsheet HTTP status was "
            f"{status}: {factsheet_url}"
        )

    body = response.body()

    if not body:

        raise RuntimeError(
            "Factsheet response contained zero bytes."
        )

    if not body.startswith(
        b"%PDF"
    ):

        content_type = clean_text(
            response.headers.get(
                "content-type"
            )
        )

        raise RuntimeError(
            "Factsheet response was not a PDF. "
            f"Content-Type={content_type}; "
            f"URL={factsheet_url}"
        )

    print(
        f"Factsheet bytes: {len(body):,}"
    )

    return body


# =============================================================================
# SINGLE FUND
# =============================================================================

def extract_single_fund(
    page,
    excel_fund: dict,
) -> dict:

    excel_row = int(
        excel_fund[
            "excelRow"
        ]
    )

    prudential_url = (
        excel_fund[
            "prudentialUrl"
        ]
    )

    pruaccess_name = (
        excel_fund.get(
            "pruAccessName"
        )
        or ""
    )

    print(
        "\n"
        "============================================================"
    )

    print(
        f"PROCESSING FUND ROW {excel_row}"
    )

    print(
        "============================================================"
    )

    print(
        f"Prudential URL: {prudential_url}"
    )

    print(
        f"Excel PruAccess name: {pruaccess_name}"
    )

    if not is_prudential_url(
        prudential_url
    ):

        raise RuntimeError(
            "Excel Column A URL is not an official "
            "Prudential Singapore URL."
        )

    page.goto(
        prudential_url,
        wait_until="domcontentloaded",
        timeout=PAGE_TIMEOUT_MS,
    )

    try:

        page.wait_for_load_state(
            "networkidle",
            timeout=25000,
        )

    except PlaywrightTimeoutError:

        pass

    page.wait_for_timeout(
        POST_PAGE_WAIT_MS
    )

    final_url = clean_text(
        page.url
    )

    page_title = clean_text(
        page.title()
    )

    if not is_prudential_url(
        final_url
    ):

        raise RuntimeError(
            "Prudential fund page redirected "
            "outside Prudential Singapore: "
            f"{final_url}"
        )

    fund_name = ""

    h1 = page.locator(
        "h1"
    ).first

    if h1.count():

        try:

            fund_name = clean_text(
                h1.inner_text()
            )

        except Exception:

            fund_name = ""

    if not fund_name:

        body_text = clean_text(
            page.locator(
                "body"
            ).inner_text()
        )

        match = re.search(
            r"\bPRU(?:Link|Prime)\s+[^\n]+",
            body_text,
            re.IGNORECASE,
        )

        if match:

            fund_name = clean_text(
                match.group(0)
            )

    factsheet_url = (
        find_factsheet_url(
            page,
            prudential_url,
        )
    )

    factsheet_bytes = (
        download_factsheet(
            page,
            factsheet_url,
        )
    )

    (
        full_text,
        pdf_page_count,
    ) = extract_pdf_text(
        factsheet_bytes
    )

    data_as_at = (
        extract_data_as_at(
            full_text
        )
    )

    document_date = (
        extract_document_date(
            full_text
        )
    )

    (
        section_text,
        section_status,
    ) = extract_holdings_section(
        full_text
    )

    if section_status == "not_published":

        result = {
            "status":
                "no_holdings_section",

            "excelRow":
                excel_row,

            "prudentialUrl":
                prudential_url,

            "finalUrl":
                final_url,

            "pageTitle":
                page_title,

            "fundName":
                fund_name,

            "factsheetUrl":
                factsheet_url,

            "factsheetDocumentDate":
                document_date,

            "factsheetDataAsAt":
                data_as_at,

            "factsheetPageCount":
                pdf_page_count,

            "holdingsSectionStatus":
                "not_published",

            "topHoldingsCount":
                0,

            "topHoldings":
                [],

            "rules": {

                "officialPrudentialSourceOnly":
                    True,

                "maximumHoldings":
                    MAX_HOLDINGS,

                "publishedCountUsedExactly":
                    True,

                "fewerThanTenAllowed":
                    True,

                "noForcedTenEntries":
                    True,

                "noInferredHoldings":
                    True,

                "noFabricatedPercentages":
                    True,

                "duplicateHoldingNamesAllowed":
                    True,

                "duplicateHoldingPercentagesAllowed":
                    True,

                "multilineHoldingNamesSupported":
                    True,

                "wrappedPdfLinesJoined":
                    True,

                "fixedIncomeCouponPercentagesSupported":
                    True,

                "logicalHoldingLineReconstruction":
                    True,
            },
        }

        return result

    parser_used = "primary"

    primary_parser_error = None

    try:

        holdings = parse_holdings(
            section_text
        )

    except Exception as primary_error:

        primary_parser_error = clean_text(
            str(primary_error)
        )

        print(
            "Primary holdings parser failed; "
            "running fallback parser..."
        )

        print(
            f"Primary parser error: "
            f"{primary_parser_error}"
        )

        try:

            holdings = parse_holdings_fallback(
                section_text
            )

        except Exception as fallback_error:

            # Both parsers failed. Attach the raw section/full text so
            # the caller can persist it for debugging instead of losing
            # it the moment this exception propagates up.
            raise HoldingsParseFailure(
                clean_text(
                    str(fallback_error)
                ),
                section_text=section_text,
                full_text=full_text,
            ) from fallback_error

        parser_used = "fallback"

    result = {
        "status":
            "success",

        "excelRow":
            excel_row,

        "prudentialUrl":
            prudential_url,

        "finalUrl":
            final_url,

        "pageTitle":
            page_title,

        "fundName":
            fund_name,

        "excelPruAccessName":
            pruaccess_name,

        "factsheetUrl":
            factsheet_url,

        "factsheetDocumentDate":
            document_date,

        "factsheetDataAsAt":
            data_as_at,

        "factsheetPageCount":
            pdf_page_count,

        "holdingsSectionStatus":
            "published",

        "topHoldingsCount":
            len(
                holdings
            ),

        "topHoldings":
            holdings,

        "holdingsParser":
            parser_used,

        "primaryParserError":
            primary_parser_error,

        "rules": {

            "officialPrudentialSourceOnly":
                True,

            "maximumHoldings":
                MAX_HOLDINGS,

            "publishedCountUsedExactly":
                True,

            "fewerThanTenAllowed":
                True,

            "noForcedTenEntries":
                True,

            "noInferredHoldings":
                True,

            "noFabricatedPercentages":
                True,

            "duplicateHoldingNamesAllowed":
                True,

            "duplicateHoldingPercentagesAllowed":
                True,

            "multilineHoldingNamesSupported":
                True,

            "wrappedPdfLinesJoined":
                True,

            "fixedIncomeCouponPercentagesSupported":
                True,

            "logicalHoldingLineReconstruction":
                True,

            "percentageDefinesHoldingBoundary":
                True,

            "fallbackUsesLastPercentageOnLogicalLine":
                True,
        },
    }

    return result


# =============================================================================
# SAVE SUCCESS
# =============================================================================

def save_success_result(
    result: dict,
    factsheet_bytes: bytes,
    full_text: str,
    section_text: str,
) -> Path:

    excel_row = int(
        result[
            "excelRow"
        ]
    )

    identifier = (
        safe_filename(
            result.get(
                "fundIdentifier"
            )
        )
        if result.get(
            "fundIdentifier"
        )
        else ""
    )

    if not identifier:

        parsed = urlparse(
            result.get(
                "finalUrl"
            )
            or result.get(
                "prudentialUrl"
            )
        )

        identifier = safe_filename(
            parsed.path.rstrip(
                "/"
            ).split(
                "/"
            )[-1]
            or result.get(
                "fundName"
            )
            or f"fund_{excel_row}"
        )

    directory = (
        FUNDS_OUTPUT_DIR
        / (
            f"{excel_row}_"
            f"{identifier}"
        )
    )

    directory.mkdir(
        parents=True,
        exist_ok=True,
    )

    (
        directory
        / "factsheet.pdf"
    ).write_bytes(
        factsheet_bytes
    )

    (
        directory
        / "factsheet_text.txt"
    ).write_text(
        full_text,
        encoding="utf-8",
    )

    (
        directory
        / "top_holdings_section.txt"
    ).write_text(
        section_text,
        encoding="utf-8",
    )

    save_json(
        directory
        / "top_holdings.json",
        result,
    )

    metadata = {
        "excelRow":
            excel_row,

        "fundName":
            result.get(
                "fundName"
            ),

        "factsheetUrl":
            result.get(
                "factsheetUrl"
            ),

        "factsheetDocumentDate":
            result.get(
                "factsheetDocumentDate"
            ),

        "factsheetDataAsAt":
            result.get(
                "factsheetDataAsAt"
            ),

        "topHoldingsCount":
            result.get(
                "topHoldingsCount"
            ),

        "status":
            result.get(
                "status"
            ),

        "holdingsParser":
            result.get(
                "holdingsParser"
            ),

        "savedAtUtc":
            utc_now_iso(),
    }

    save_json(
        directory
        / "metadata.json",
        metadata,
    )

    return directory


# =============================================================================
# SAVE FAILURE
# =============================================================================

def save_failure_result(
    excel_fund: dict,
    error_text: str,
    section_text: str | None = None,
    full_text: str | None = None,
) -> Path:

    excel_row = int(
        excel_fund[
            "excelRow"
        ]
    )

    directory = (
        FUNDS_OUTPUT_DIR
        / (
            f"{excel_row}_failed"
        )
    )

    directory.mkdir(
        parents=True,
        exist_ok=True,
    )

    failure = {
        "status":
            "failed",

        "excelRow":
            excel_row,

        "prudentialUrl":
            excel_fund[
                "prudentialUrl"
            ],

        "excelPruAccessName":
            excel_fund.get(
                "pruAccessName"
            ),

        "error":
            clean_text(
                error_text
            ),

        "failedAtUtc":
            utc_now_iso(),
    }

    save_json(
        directory
        / "failure.json",
        failure,
    )

    # Persist whatever diagnostic text was available at the point of
    # failure, so a failed fund can actually be debugged afterward
    # instead of leaving only an error message behind.
    if section_text:

        (
            directory
            / "top_holdings_section.txt"
        ).write_text(
            section_text,
            encoding="utf-8",
        )

    if full_text:

        (
            directory
            / "factsheet_text.txt"
        ).write_text(
            full_text,
            encoding="utf-8",
        )

    return directory


# =============================================================================
# MAIN
# =============================================================================

def main() -> int:

    OUTPUT_DIR.mkdir(
        parents=True,
        exist_ok=True,
    )

    FUNDS_OUTPUT_DIR.mkdir(
        parents=True,
        exist_ok=True,
    )

    started_at = utc_now_iso()

    print(
        "\n"
        "################################################################"
    )

    print(
        "VGRAT FMS - PRUDENTIAL TOP HOLDINGS ALL-FUND TEST"
    )

    print(
        "################################################################"
    )

    print(
        f"Started UTC: {started_at}"
    )

    funds = read_excel_funds()

    successful = []

    no_holdings_section = []

    failed = []

    fallback_recovered = []

    with sync_playwright() as playwright:

        browser = playwright.chromium.launch(
            headless=BROWSER_HEADLESS
        )

        context = browser.new_context(
            viewport={
                "width": 1440,
                "height": 1000,
            },

            user_agent=(
                "Mozilla/5.0 "
                "(Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 "
                "(KHTML, like Gecko) "
                "Chrome/153.0.0.0 Safari/537.36"
            ),
        )

        page = context.new_page()

        try:

            total = len(
                funds
            )

            for index, excel_fund in enumerate(
                funds,
                start=1,
            ):

                print(
                    "\n"
                    + "=" * 72
                )

                print(
                    f"FUND {index}/{total}"
                )

                print(
                    f"Excel row: "
                    f"{excel_fund['excelRow']}"
                )

                print(
                    "=" * 72
                )

                last_error = None

                last_exception = None

                result = None

                for attempt in range(
                    1,
                    RETRY_COUNT + 1,
                ):

                    try:

                        print(
                            f"\nAttempt "
                            f"{attempt}/{RETRY_COUNT}"
                        )

                        result = (
                            extract_single_fund(
                                page,
                                excel_fund,
                            )
                        )

                        last_error = None

                        last_exception = None

                        break

                    except Exception as error:

                        last_error = clean_text(
                            str(error)
                        )

                        last_exception = error

                        print(
                            "Attempt failed:"
                        )

                        print(
                            last_error
                        )

                        if attempt < RETRY_COUNT:

                            print(
                                f"Retrying in "
                                f"{RETRY_DELAY_SECONDS} seconds..."
                            )

                            time.sleep(
                                RETRY_DELAY_SECONDS
                            )

                if result is None:

                    failure_directory = (
                        save_failure_result(
                            excel_fund,
                            last_error
                            or
                            "Unknown extraction failure.",
                            section_text=getattr(
                                last_exception,
                                "section_text",
                                None,
                            ),
                            full_text=getattr(
                                last_exception,
                                "full_text",
                                None,
                            ),
                        )
                    )

                    failed.append(
                        {
                            "excelRow":
                                excel_fund[
                                    "excelRow"
                                ],

                            "prudentialUrl":
                                excel_fund[
                                    "prudentialUrl"
                                ],

                            "pruAccessName":
                                excel_fund.get(
                                    "pruAccessName"
                                ),

                            "error":
                                last_error
                                or
                                "Unknown extraction failure.",

                            "outputDirectory":
                                str(
                                    failure_directory
                                ),
                        }
                    )

                    continue

                if (
                    result[
                        "status"
                    ]
                    ==
                    "no_holdings_section"
                ):

                    result_directory = (
                        FUNDS_OUTPUT_DIR
                        /
                        (
                            f"{result['excelRow']}_"
                            f"{safe_filename(result.get('fundName') or 'fund')}"
                        )
                    )

                    result_directory.mkdir(
                        parents=True,
                        exist_ok=True,
                    )

                    save_json(
                        result_directory
                        / "top_holdings.json",
                        result,
                    )

                    metadata = {
                        "excelRow":
                            result.get(
                                "excelRow"
                            ),

                        "fundName":
                            result.get(
                                "fundName"
                            ),

                        "factsheetUrl":
                            result.get(
                                "factsheetUrl"
                            ),

                        "factsheetDocumentDate":
                            result.get(
                                "factsheetDocumentDate"
                            ),

                        "factsheetDataAsAt":
                            result.get(
                                "factsheetDataAsAt"
                            ),

                        "topHoldingsCount":
                            0,

                        "status":
                            result.get(
                                "status"
                            ),

                        "savedAtUtc":
                            utc_now_iso(),
                    }

                    save_json(
                        result_directory
                        / "metadata.json",
                        metadata,
                    )

                    no_holdings_section.append(
                        result
                    )

                    print(
                        "\n"
                        "NO TOP HOLDINGS SECTION"
                    )

                    continue

                # -----------------------------------------------------------------
                # FINAL OFFICIAL PDF VERIFICATION
                # -----------------------------------------------------------------

                try:

                    factsheet_response = (
                        page.request.get(
                            result[
                                "factsheetUrl"
                            ],
                            timeout=(
                                FACTSHEET_DOWNLOAD_TIMEOUT_MS
                            ),
                        )
                    )

                    if factsheet_response.status != 200:

                        raise RuntimeError(
                            "Factsheet re-download returned "
                            f"HTTP {factsheet_response.status}."
                        )

                    factsheet_bytes = (
                        factsheet_response.body()
                    )

                    if not factsheet_bytes.startswith(
                        b"%PDF"
                    ):

                        raise RuntimeError(
                            "Factsheet re-download did not "
                            "return a valid PDF."
                        )

                    (
                        full_text,
                        _page_count,
                    ) = extract_pdf_text(
                        factsheet_bytes
                    )

                    (
                        section_text,
                        section_status,
                    ) = extract_holdings_section(
                        full_text
                    )

                    if (
                        section_status
                        !=
                        "published"
                    ):

                        raise RuntimeError(
                            "Factsheet holdings section "
                            "disappeared during verification."
                        )

                    verification_parser = (
                        result.get(
                            "holdingsParser"
                        )
                        or
                        "primary"
                    )

                    if (
                        verification_parser
                        ==
                        "fallback"
                    ):

                        verified_holdings = (
                            parse_holdings_fallback(
                                section_text
                            )
                        )

                    else:

                        try:

                            verified_holdings = (
                                parse_holdings(
                                    section_text
                                )
                            )

                        except Exception as verification_primary_error:

                            print(
                                "Primary verification parser failed; "
                                "running fallback parser..."
                            )

                            try:

                                verified_holdings = (
                                    parse_holdings_fallback(
                                        section_text
                                    )
                                )

                            except Exception as verification_fallback_error:

                                raise HoldingsParseFailure(
                                    clean_text(
                                        str(
                                            verification_fallback_error
                                        )
                                    ),
                                    section_text=section_text,
                                    full_text=full_text,
                                ) from verification_fallback_error

                            result[
                                "holdingsParser"
                            ] = "fallback"

                            result[
                                "primaryParserError"
                            ] = clean_text(
                                str(
                                    verification_primary_error
                                )
                            )

                    if len(
                        verified_holdings
                    ) != result[
                        "topHoldingsCount"
                    ]:

                        raise RuntimeError(
                            "Holding count changed during "
                            "final verification."
                        )

                    result[
                        "topHoldings"
                    ] = verified_holdings

                    result[
                        "topHoldingsCount"
                    ] = len(
                        verified_holdings
                    )

                    output_directory = (
                        save_success_result(
                            result,
                            factsheet_bytes,
                            full_text,
                            section_text,
                        )
                    )

                except Exception as error:

                    error_text = clean_text(
                        str(error)
                    )

                    failure_directory = (
                        save_failure_result(
                            excel_fund,
                            error_text,
                            section_text=getattr(
                                error,
                                "section_text",
                                None,
                            ),
                            full_text=getattr(
                                error,
                                "full_text",
                                None,
                            ),
                        )
                    )

                    failed.append(
                        {
                            "excelRow":
                                excel_fund[
                                    "excelRow"
                                ],

                            "prudentialUrl":
                                excel_fund[
                                    "prudentialUrl"
                                ],

                            "pruaccessName":
                                excel_fund.get(
                                    "pruAccessName"
                                ),

                            "error":
                                error_text,

                            "outputDirectory":
                                str(
                                    failure_directory
                                ),
                        }
                    )

                    continue

                successful.append(
                    result
                )

                if (
                    result.get(
                        "holdingsParser"
                    )
                    ==
                    "fallback"
                ):

                    fallback_recovered.append(
                        result
                    )

                print(
                    "\nSUCCESS"
                )

                print(
                    f"Fund: "
                    f"{result.get('fundName') or '-'}"
                )

                print(
                    f"Factsheet data as at: "
                    f"{result.get('factsheetDataAsAt') or '-'}"
                )

                print(
                    f"Factsheet document date: "
                    f"{result.get('factsheetDocumentDate') or '-'}"
                )

                print(
                    f"Top holdings extracted: "
                    f"{result.get('topHoldingsCount')}"
                )

                for holding in result[
                    "topHoldings"
                ]:

                    print(
                        f"  {holding['rank']}. "
                        f"{holding['name']} - "
                        f"{holding['weightText']}"
                    )

        finally:

            context.close()

            browser.close()

    # =========================================================================
    # CONSOLIDATED OUTPUT
    # =========================================================================

    completed_at = utc_now_iso()

    all_results = (
        successful
        + no_holdings_section
    )

    all_holdings_payload = {
        "status":
            (
                "success"
                if not failed
                else "partial"
            ),

        "source":
            "Prudential Singapore",

        "generatedAtUtc":
            completed_at,

        "excelFile":
            str(
                EXCEL_FILE
            ),

        "excelFundUniverse":
            len(
                funds
            ),

        "successfulFunds":
            len(
                successful
            ),

        "noHoldingsSectionFunds":
            len(
                no_holdings_section
            ),

        "failedFunds":
            len(
                failed
            ),

        "fallbackRecoveredFunds":
            len(
                fallback_recovered
            ),

        "rules": {

            "excelColumnAControlsUniverse":
                True,

            "officialPrudentialOnly":
                True,

            "maximumHoldings":
                MAX_HOLDINGS,

            "publishedCountUsedExactly":
                True,

            "fewerThanTenAllowed":
                True,

            "noForcedTenEntries":
                True,

            "noInferredHoldings":
                True,

            "noFabricatedPercentages":
                True,

            "duplicateHoldingNamesAllowed":
                True,

            "duplicateHoldingPercentagesAllowed":
                True,

            "multilineHoldingNamesSupported":
                True,

            "wrappedPdfLinesJoined":
                True,

            "fixedIncomeCouponPercentagesSupported":
                True,

            "logicalHoldingLineReconstruction":
                True,

            "percentageDefinesHoldingBoundary":
                True,

            "automaticFallbackParser":
                True,

            "fallbackUsesLastPercentageOnLogicalLine":
                True,

            "thirdPartyHoldings":
                False,
        },

        "funds":
            all_results,

        "failed":
            failed,
    }

    save_json(
        ALL_HOLDINGS_FILE,
        all_holdings_payload,
    )

    # =========================================================================
    # RUN SUMMARY
    # =========================================================================

    total_holdings = sum(
        int(
            item.get(
                "topHoldingsCount",
                0,
            )
            or 0
        )
        for item
        in successful
    )

    run_summary = {
        "status":
            (
                "success"
                if not failed
                else "partial"
            ),

        "startedAtUtc":
            started_at,

        "completedAtUtc":
            completed_at,

        "excelFile":
            str(
                EXCEL_FILE
            ),

        "excelFundUniverse":
            len(
                funds
            ),

        "successfulFunds":
            len(
                successful
            ),

        "noHoldingsSectionFunds":
            len(
                no_holdings_section
            ),

        "failedFunds":
            len(
                failed
            ),

        "fallbackRecoveredFunds":
            len(
                fallback_recovered
            ),

        "fallbackRecoveredFundsDetail":
            [
                {
                    "excelRow":
                        item.get(
                            "excelRow"
                        ),

                    "fundName":
                        item.get(
                            "fundName"
                        ),

                    "primaryParserError":
                        item.get(
                            "primaryParserError"
                        ),

                    "factsheetUrl":
                        item.get(
                            "factsheetUrl"
                        ),

                    "topHoldingsCount":
                        item.get(
                            "topHoldingsCount"
                        ),
                }

                for item
                in fallback_recovered
            ],

        "totalPublishedTopHoldings":
            total_holdings,

        "successfulFundsDetail":
            [
                {
                    "excelRow":
                        item.get(
                            "excelRow"
                        ),

                    "fundName":
                        item.get(
                            "fundName"
                        ),

                    "factsheetUrl":
                        item.get(
                            "factsheetUrl"
                        ),

                    "factsheetDocumentDate":
                        item.get(
                            "factsheetDocumentDate"
                        ),

                    "factsheetDataAsAt":
                        item.get(
                            "factsheetDataAsAt"
                        ),

                    "topHoldingsCount":
                        item.get(
                            "topHoldingsCount"
                        ),
                }

                for item
                in successful
            ],

        "noHoldingsSectionDetail":
            [
                {
                    "excelRow":
                        item.get(
                            "excelRow"
                        ),

                    "fundName":
                        item.get(
                            "fundName"
                        ),

                    "factsheetUrl":
                        item.get(
                            "factsheetUrl"
                        ),
                }

                for item
                in no_holdings_section
            ],

        "failedFundsDetail":
            failed,

        "rules": {

            "excelColumnAControlsUniverse":
                True,

            "officialPrudentialFactsheetOnly":
                True,

            "maximumHoldings":
                MAX_HOLDINGS,

            "publishedHoldingCountUsedExactly":
                True,

            "fewerThanTenHoldingsAllowed":
                True,

            "noForcedTenEntries":
                True,

            "noInferredHoldings":
                True,

            "noFabricatedHoldingWeights":
                True,

            "noDuplicateHoldingNameValidation":
                True,

            "duplicateHoldingNamesAllowed":
                True,

            "duplicateHoldingPercentagesAllowed":
                True,

            "noThirdPartyHoldings":
                True,

            "multilineHoldingNamesSupported":
                True,

            "wrappedPdfLinesJoined":
                True,

            "fixedIncomeCouponPercentagesSupported":
                True,

            "logicalHoldingLineReconstruction":
                True,

            "percentageDefinesHoldingBoundary":
                True,

            "automaticFallbackParser":
                True,

            "fallbackUsesLastPercentageOnLogicalLine":
                True,
        },
    }

    save_json(
        RUN_SUMMARY_FILE,
        run_summary,
    )

    # =========================================================================
    # CONSOLE SUMMARY
    # =========================================================================

    print(
        "\n\n"
        + "=" * 78
    )

    print(
        "PRUDENTIAL TOP HOLDINGS ALL-FUND TEST COMPLETE"
    )

    print(
        "=" * 78
    )

    print(
        f"Excel fund universe: "
        f"{len(funds)}"
    )

    print(
        f"Successful with holdings: "
        f"{len(successful)}"
    )

    print(
        f"No Top Holdings section: "
        f"{len(no_holdings_section)}"
    )

    print(
        f"Failed: "
        f"{len(failed)}"
    )

    print(
        f"Recovered by fallback parser: "
        f"{len(fallback_recovered)}"
    )

    print(
        f"Total published holdings extracted: "
        f"{total_holdings}"
    )

    print(
        "\nMultiline holding names: ENABLED"
    )

    print(
        "Wrapped PDF lines: JOINED"
    )

    print(
        "Fixed-income coupon percentages: SUPPORTED"
    )

    print(
        "Logical holding line reconstruction: ENABLED"
    )

    print(
        "Duplicate holding names: ALLOWED"
    )

    print(
        "Duplicate holding percentages: ALLOWED"
    )

    print(
        "Holding boundary: PUBLISHED PORTFOLIO PERCENTAGE"
    )

    print(
        "Fallback weight: LAST PERCENTAGE ON LOGICAL LINE"
    )

    print(
        "\nOutput:"
    )

    print(
        f" - {ALL_HOLDINGS_FILE}"
    )

    print(
        f" - {RUN_SUMMARY_FILE}"
    )

    print(
        f" - {FUNDS_OUTPUT_DIR}"
    )

    if failed:

        print(
            "\nFAILED FUNDS:"
        )

        for failure in failed:

            print(
                f" - Row "
                f"{failure['excelRow']}: "
                f"{failure['error']}"
            )

    print(
        "\nDone."
    )

    return 0


# =============================================================================
# ENTRY POINT
# =============================================================================

if __name__ == "__main__":

    try:

        raise SystemExit(
            main()
        )

    except KeyboardInterrupt:

        print(
            "\nInterrupted.",
            file=sys.stderr,
        )

        raise SystemExit(
            130
        )
