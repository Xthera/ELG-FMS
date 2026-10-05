#!/usr/bin/env python3

"""
VGrat FMS - Prudential Top Holdings FAILED-FUND RECOVERY 2

PURPOSE
=======

Recover ONLY funds that still failed during Recovery 1:

    scripts/test_prudential_holdings.py

Recovery 1 remains untouched.

RECOVERY SOURCE
===============

1. output_holdings_recovery/run_summary.json
       |
       v
   stillFailedFundsDetail
       |
       v
2. Funds Links.xlsm
       |
       v
   authoritative Excel URL + PruAccess name
       |
       v
3. Official Prudential Singapore fund page
       |
       v
4. Official Prudential factsheet PDF
       |
       v
5. Normal PDF extraction
       |
       v
6. Primary holdings parser
       |
       v
7. Fallback holdings parser
       |
       v
8. Spatial PDF recovery
       |
       v
9. Exact official-PDF re-download
       |
       v
10. Exact extraction/signature verification


IMPORTANT
=========

This script is a SEPARATE recovery script.

It does NOT modify:

    scripts/test_prudential_holdings.py

It does NOT expand the universe.

It does NOT use PruAccess to discover holdings.

It does NOT use third-party holdings sources.

It does NOT fabricate holdings.

It does NOT estimate percentages.

It does NOT use fuzzy matching.

It does NOT use proximity matching between arbitrary names and
percentages.

It does NOT silently accept a different result during final verification.


HARD RULES
==========

- Recovery 1 stillFailedFundsDetail controls the Recovery 2 universe.
- Funds Links.xlsm controls the authoritative URL and Excel row.
- Only official Prudential Singapore URLs are accepted.
- Only official Prudential Singapore factsheets are accepted.
- No third-party holdings sources.
- No inferred holdings.
- No fabricated holdings.
- No fabricated percentages.
- No forced ten holdings.
- Fewer than ten published holdings is valid.
- Duplicate holding names are allowed.
- Duplicate holding percentages are allowed.
- Published order must be preserved.
- Fixed-income coupon percentages may occur inside holding names.
- The last percentage on a logical fixed-income line is the portfolio
  weight when fallback parsing is required.
- A hyphenated PDF line break is rejoined before percentage parsing.
- Spatial recovery MUST still pass the reconstructed section through
  the fallback parser.
- Spatial recovery does NOT independently pair names and percentages
  using coordinate proximity.
- Final verification downloads the official PDF again.
- Final verification runs the extraction engine again.
- Final verification requires the exact same:
      rank
      holding name
      weight
  signature.
- If exact verification fails, the fund remains FAILED.
- A recovery result never overwrites the baseline result.
"""


from __future__ import annotations

import json
import re
import sys
import time
from io import BytesIO
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

RECOVERY_1_RUN_SUMMARY_FILE = Path(
    "output_holdings_recovery/run_summary.json"
)

RECOVERY_OUTPUT_DIR = Path(
    "output_holdings_recovery_2"
)

RECOVERY_FUNDS_OUTPUT_DIR = (
    RECOVERY_OUTPUT_DIR / "funds"
)

RECOVERY_RUN_SUMMARY_FILE = (
    RECOVERY_OUTPUT_DIR / "run_summary.json"
)


# =============================================================================
# BROWSER
# =============================================================================

BROWSER_HEADLESS = True

PAGE_TIMEOUT_MS = 120000

FACTSHEET_DOWNLOAD_TIMEOUT_MS = 120000

POST_PAGE_WAIT_MS = 1500

RETRY_COUNT = 3

RETRY_DELAY_SECONDS = 3.0


# =============================================================================
# HOLDINGS
# =============================================================================

MAX_HOLDINGS = 10


# =============================================================================
# OFFICIAL PRUDENTIAL HOSTS
# =============================================================================

PRUDENTIAL_HOSTS = {
    "prudential.com.sg",
    "www.prudential.com.sg",
}


# =============================================================================
# SPATIAL RECOVERY
# =============================================================================

SPATIAL_MIN_NAME_LENGTH = 3

SPATIAL_MAX_LINES_AFTER_HEADING = 80


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


class HoldingsParseFailure(RuntimeError):

    def __init__(
        self,
        message: str,
        section_text: str = "",
        full_text: str = "",
        diagnostics: dict | None = None,
    ) -> None:

        super().__init__(
            message
        )

        self.section_text = section_text

        self.full_text = full_text

        self.diagnostics = (
            diagnostics
            or {}
        )


# =============================================================================
# BASELINE
# =============================================================================

def load_recovery_1_run_summary() -> dict:

    if not RECOVERY_1_RUN_SUMMARY_FILE.exists():

        raise FileNotFoundError(
            "Recovery 1 source run summary not found: "
            f"{RECOVERY_1_RUN_SUMMARY_FILE}"
        )

    data = json.loads(
        RECOVERY_1_RUN_SUMMARY_FILE.read_text(
            encoding="utf-8"
        )
    )

    if not isinstance(
        data,
        dict,
    ):

        raise RuntimeError(
            "Baseline run summary is not a JSON object."
        )

    failed = data.get(
        "stillFailedFundsDetail"
    )

    if not isinstance(
        failed,
        list,
    ):

        raise RuntimeError(
            "Baseline run summary does not contain "
            "a valid stillFailedFundsDetail list."
        )

    return data


# =============================================================================
# EXCEL MASTER UNIVERSE
# =============================================================================

def read_excel_funds() -> dict[int, dict]:

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

    funds = {}

    try:

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

            funds[row_number] = {
                "excelRow":
                    row_number,

                "prudentialUrl":
                    prudential_url,

                "pruAccessName":
                    pruaccess_name,
            }

    finally:

        workbook.close()

    if not funds:

        raise RuntimeError(
            "No populated Prudential URLs were found "
            "in Excel Column A."
        )

    return funds


def build_recovery_universe(
    recovery_1: dict,
    excel_funds: dict[int, dict],
) -> list[dict]:

    failed_entries = recovery_1.get(
        "stillFailedFundsDetail"
    )

    if not isinstance(
        failed_entries,
        list,
    ):

        raise RuntimeError(
            "Recovery 1 stillFailedFundsDetail is invalid."
        )

    recovery = []

    seen_rows = set()

    for failure in failed_entries:

        if not isinstance(
            failure,
            dict,
        ):

            raise RuntimeError(
                "A stillFailedFundsDetail entry is not an object."
            )

        if "excelRow" not in failure:

            raise RuntimeError(
                "A Recovery 1 failure entry has no excelRow."
            )

        try:

            excel_row = int(
                failure[
                    "excelRow"
                ]
            )

        except Exception as error:

            raise RuntimeError(
                "Recovery 1 failure contains an invalid excelRow: "
                f"{failure.get('excelRow')}"
            ) from error

        if excel_row in seen_rows:

            raise RuntimeError(
                f"Duplicate Recovery 1 failed excelRow: {excel_row}"
            )

        seen_rows.add(
            excel_row
        )

        if excel_row not in excel_funds:

            raise RuntimeError(
                "Recovery 1 failed row "
                f"{excel_row} does not exist in Excel."
            )

        excel_fund = excel_funds[
            excel_row
        ]

        baseline_url = clean_text(
            failure.get(
                "prudentialUrl"
            )
        )

        baseline_name = clean_text(
            failure.get(
                "pruAccessName"
            )
            or
            failure.get(
                "excelPruAccessName"
            )
        )

        excel_url = clean_text(
            excel_fund[
                "prudentialUrl"
            ]
        )

        excel_name = clean_text(
            excel_fund.get(
                "pruAccessName"
            )
        )

        if (
            baseline_url
            and
            baseline_url
            !=
            excel_url
        ):

            raise RuntimeError(
                "Recovery 1 URL does not match Excel for "
                f"row {excel_row}."
            )

        if (
            baseline_name
            and
            excel_name
            and
            baseline_name
            !=
            excel_name
        ):

            raise RuntimeError(
                "Recovery 1 PruAccess name does not match Excel for "
                f"row {excel_row}."
            )

        recovery.append(
            {
                "excelRow":
                    excel_row,

                "prudentialUrl":
                    excel_url,

                "pruAccessName":
                    excel_name,

                "baselineFailure":
                    failure,
            }
        )

    return recovery


# =============================================================================
# FACTSHEET DISCOVERY
# =============================================================================

def find_factsheet_url(
    page,
) -> str:

    anchors = page.locator(
        "a"
    )

    count = anchors.count()

    candidates = []

    for index in range(
        count
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

        if "fund factsheet" in text_lower:
            score += 200

        elif "factsheet" in text_lower:
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
            "Could not find an official Prudential factsheet link."
        )

    candidates.sort(
        key=lambda item: (
            -item["score"],
            item["url"],
        )
    )

    return ensure_prudential_url(
        candidates[0]["url"]
    )


# =============================================================================
# PDF DOWNLOAD
# =============================================================================

def download_factsheet(
    page,
    factsheet_url: str,
) -> bytes:

    factsheet_url = ensure_prudential_url(
        factsheet_url
    )

    response = page.request.get(
        factsheet_url,
        timeout=FACTSHEET_DOWNLOAD_TIMEOUT_MS,
    )

    if response.status != 200:

        raise RuntimeError(
            "Factsheet HTTP status was "
            f"{response.status}."
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
            f"Content-Type={content_type}"
        )

    return body


# =============================================================================
# PDF TEXT
# =============================================================================

def extract_pdf_text(
    pdf_bytes: bytes,
) -> tuple[str, int]:

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

    for page_number, pdf_page in enumerate(
        reader.pages,
        start=1,
    ):

        try:

            text = (
                pdf_page.extract_text()
                or ""
            )

        except Exception as error:

            raise RuntimeError(
                "Failed to extract PDF text from page "
                f"{page_number}: {error}"
            ) from error

        pages.append(
            text
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
# PDF LINES
# =============================================================================

def pdf_lines(
    text: str,
) -> list[str]:

    result = []

    for raw_line in text.splitlines():

        line = clean_text(
            raw_line
        )

        if line:
            result.append(
                line
            )

    return result


# =============================================================================
# FACTSHEET DATES
# =============================================================================

def extract_data_as_at(
    text: str,
) -> str | None:

    patterns = [

        re.compile(
            r"\bdata\s+as\s+at\s*"
            r"([0-9]{1,2}\s+[A-Za-z]{3,9}\s+[0-9]{4})\b",
            re.IGNORECASE,
        ),

        re.compile(
            r"\ball\s+data\s+as\s+at\s*"
            r"([0-9]{1,2}\s+[A-Za-z]{3,9}\s+[0-9]{4})\b",
            re.IGNORECASE,
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


def extract_document_date(
    text: str,
) -> str | None:

    pattern = re.compile(
        r"\b("
        r"January|February|March|April|May|June|July|"
        r"August|September|October|November|December"
        r")\s+([0-9]{4})\b",
        re.IGNORECASE,
    )

    for line in pdf_lines(
        text
    )[:50]:

        match = pattern.search(
            line
        )

        if match:

            return clean_text(
                match.group(0)
            )

    return None


# =============================================================================
# HOLDINGS SECTION
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

    if normalized in {
        "source",
        "source:",
        "inception date",
        "important information",
        "important information:",
        "disclaimer",
        "past performance",
        "portfolio characteristics",
        "asset allocation",
    }:

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
) -> tuple[str, str]:

    lines = pdf_lines(
        text
    )

    start = find_holdings_start(
        lines
    )

    if start is None:

        return (
            "",
            "not_published",
        )

    section = []

    for line in lines[
        start + 1:
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
# NAME CLEANING
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
        "",
        "none",
        "null",
        "-",
        "—",
    }:

        return ""

    return name


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

    return clean_text(
        fragment
    )


def combine_holding_name_fragments(
    fragments: list[str],
) -> str:

    cleaned = []

    for fragment in fragments:

        fragment = clean_holding_fragment(
            fragment
        )

        if not fragment:
            continue

        if re.fullmatch(
            r"\d{1,2}",
            fragment,
        ):

            continue

        cleaned.append(
            fragment
        )

    if not cleaned:
        return ""

    # PDF text extraction can split a decimal coupon across physical
    # fragments, e.g. ``2.`` + ``95%``.  A normal space-join would turn that
    # into ``2. 95%`` and clean_holding_name() could then mistake ``2.`` for
    # a holding rank.  Join decimal fragments without inserting a space.
    combined_parts = []

    for fragment in cleaned:
        if (
            combined_parts
            and re.search(r"\d+\.$", combined_parts[-1])
            and re.match(r"^\d+(?:%|\b)", fragment)
        ):
            combined_parts[-1] += fragment
        else:
            combined_parts.append(fragment)

    combined = " ".join(
        combined_parts
    )

    combined = re.sub(
        r"\s+",
        " ",
        combined,
    ).strip()

    return clean_holding_name(
        combined
    )


# =============================================================================
# PERCENTAGES
# =============================================================================

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
) -> tuple[float, str, int, int] | None:

    matches = percentage_matches(
        line
    )

    if not matches:
        return None

    match = matches[0]

    value = float(
        match.group(1)
    )

    if not 0 <= value <= 100:
        return None

    return (
        value,
        clean_text(
            match.group(0)
        ),
        match.start(),
        match.end(),
    )


def find_last_percentage_in_line(
    line: str,
) -> tuple[float, str, int, int] | None:

    matches = percentage_matches(
        line
    )

    if not matches:
        return None

    match = matches[-1]

    value = float(
        match.group(1)
    )

    if not 0 <= value <= 100:
        return None

    return (
        value,
        clean_text(
            match.group(0)
        ),
        match.start(),
        match.end(),
    )


# =============================================================================
# RANKS
# =============================================================================

def extract_leading_rank(
    line: str,
) -> tuple[int | None, str]:

    text = clean_text(
        line
    )

    if not text:
        return (
            None,
            "",
        )

    match = re.match(
        r"^\s*(\d{1,2})[.)\-:]\s*(.*)$",
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

    return (
        None,
        text,
    )


# =============================================================================
# NOISE
# =============================================================================

def is_holding_header_or_noise(
    line: str,
) -> bool:

    normalized = normalize_text(
        line
    )

    if not normalized:
        return True

    if normalized in {
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
    }:

        return True

    if normalized.startswith(
        "top 10 holdings"
    ):

        return True

    if normalized.startswith(
        "top ten holdings"
    ):

        return True

    return False


# =============================================================================
# HYPHENATED LINE RECONSTRUCTION
# =============================================================================

def merge_hyphenated_line_breaks(
    lines: list[str],
) -> list[str]:

    merged = []

    index = 0

    while index < len(lines):

        current = clean_text(
            lines[index]
        )

        while (
            current.endswith("-")
            and
            index + 1 < len(lines)
        ):

            index += 1

            next_line = clean_text(
                lines[index]
            )

            current = (
                current
                +
                next_line
            )

        merged.append(
            current
        )

        index += 1

    return merged


# =============================================================================
# LOGICAL LINES
# =============================================================================

def build_logical_holding_lines(
    section_text: str,
) -> list[str]:

    raw_lines = pdf_lines(
        section_text
    )

    if not raw_lines:
        return []

    return merge_hyphenated_line_breaks(
        raw_lines
    )


# =============================================================================
# VALIDATION
# =============================================================================

def validate_holdings(
    holdings: list[dict],
    parser_name: str,
) -> list[dict]:

    if not holdings:

        raise RuntimeError(
            f"{parser_name} parser produced no holdings."
        )

    if len(holdings) > MAX_HOLDINGS:

        raise RuntimeError(
            f"{parser_name} parser produced more than "
            f"{MAX_HOLDINGS} holdings."
        )

    expected = list(
        range(
            1,
            len(holdings) + 1,
        )
    )

    ranks = [
        item[
            "rank"
        ]
        for item in holdings
    ]

    if ranks != expected:

        raise RuntimeError(
            f"{parser_name} parser ranks invalid. "
            f"Parsed={ranks}; Expected={expected}"
        )

    for holding in holdings:

        name = clean_holding_name(
            holding.get(
                "name"
            )
        )

        if not name:

            raise RuntimeError(
                f"{parser_name} parser produced an empty holding name."
            )

        weight = holding.get(
            "weightPercent"
        )

        if not isinstance(
            weight,
            (int, float),
        ):

            raise RuntimeError(
                f"{parser_name} parser produced an invalid weight."
            )

        if not 0 <= weight <= 100:

            raise RuntimeError(
                f"{parser_name} parser produced weight outside 0-100."
            )

        holding[
            "name"
        ] = name

    return holdings


# =============================================================================
# PRIMARY PARSER
# =============================================================================

def parse_holdings(
    section_text: str,
) -> list[dict]:

    lines = build_logical_holding_lines(
        section_text
    )

    if not lines:

        raise RuntimeError(
            "Holdings section is empty."
        )

    holdings = []

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
                    "Primary parser encountered a new rank "
                    "before the previous holding received a weight."
                )

            pending_rank = detected_rank

            line = remainder

            if not line:
                continue

        matches = percentage_matches(
            line
        )

        if len(matches) > 1:

            raise RuntimeError(
                "Primary parser found multiple percentages on "
                "one logical line."
            )

        percentage_info = (
            find_percentage_in_line(
                line
            )
        )

        if percentage_info:

            (
                weight,
                weight_text,
                start,
                _end,
            ) = percentage_info

            fragment = clean_text(
                line[:start]
            )

            if fragment:
                pending_fragments.append(
                    fragment
                )

            name = combine_holding_name_fragments(
                pending_fragments
            )

            if not name:

                raise RuntimeError(
                    "Primary parser found a percentage "
                    "without a holding name."
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
                        weight,

                    "weightText":
                        weight_text,
                }
            )

            pending_fragments = []

            pending_rank = None

            if len(holdings) >= MAX_HOLDINGS:

                break

            continue

        fragment = clean_holding_fragment(
            line
        )

        if fragment:
            pending_fragments.append(
                fragment
            )

    return validate_holdings(
        holdings,
        "Primary",
    )


# =============================================================================
# FALLBACK PARSER
# =============================================================================

def parse_holdings_fallback(
    section_text: str,
) -> list[dict]:

    lines = build_logical_holding_lines(
        section_text
    )

    if not lines:

        raise RuntimeError(
            "Fallback parser received an empty section."
        )

    holdings = []

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
                    "Fallback parser encountered a new rank "
                    "before the previous holding received a weight."
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

        if percentage_info:

            (
                weight,
                weight_text,
                start,
                _end,
            ) = percentage_info

            fragment = clean_text(
                line[:start]
            )

            if fragment:
                pending_fragments.append(
                    fragment
                )

            name = combine_holding_name_fragments(
                pending_fragments
            )

            if not name:

                raise RuntimeError(
                    "Fallback parser found a percentage "
                    "without a holding name."
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
                        weight,

                    "weightText":
                        weight_text,
                }
            )

            pending_fragments = []

            pending_rank = None

            if len(holdings) >= MAX_HOLDINGS:

                break

            continue

        fragment = clean_holding_fragment(
            line
        )

        if fragment:

            pending_fragments.append(
                fragment
            )

    return validate_holdings(
        holdings,
        "Fallback",
    )


# =============================================================================
# HOLDING SIGNATURE
# =============================================================================

def holding_signature(
    holdings: list[dict],
) -> list[tuple]:

    signature = []

    for holding in holdings:

        signature.append(
            (
                int(
                    holding[
                        "rank"
                    ]
                ),

                normalize_text(
                    holding[
                        "name"
                    ]
                ),

                float(
                    holding[
                        "weightPercent"
                    ]
                ),
            )
        )

    return signature


# =============================================================================
# SPATIAL PDF EXTRACTION
# =============================================================================

def positioned_pdf_lines(
    pdf_bytes: bytes,
) -> list[dict]:

    reader = PdfReader(
        BytesIO(
            pdf_bytes
        )
    )

    all_lines = []

    for page_number, page in enumerate(
        reader.pages,
        start=1,
    ):

        fragments = []

        def visitor_text(
            text,
            cm,
            tm,
            font_dict,
            font_size,
        ):

            value = clean_text(
                text
            )

            if not value:
                return

            try:

                x = float(
                    tm[4]
                )

                y = float(
                    tm[5]
                )

            except Exception:

                return

            fragments.append(
                {
                    "text":
                        value,

                    "x":
                        x,

                    "y":
                        y,

                    "fontSize":
                        float(
                            font_size
                            or
                            0
                        ),
                }
            )

        try:

            page.extract_text(
                visitor_text=visitor_text
            )

        except Exception:

            continue

        fragments.sort(
            key=lambda item: (
                -item["y"],
                item["x"],
            )
        )

        page_lines = []

        tolerance = 3.0

        for fragment in fragments:

            if not page_lines:

                page_lines.append(
                    {
                        "page":
                            page_number,

                        "y":
                            fragment[
                                "y"
                            ],

                        "fragments":
                            [
                                fragment
                            ],
                    }
                )

                continue

            current = page_lines[
                -1
            ]

            if abs(
                current["y"]
                -
                fragment["y"]
            ) <= tolerance:

                current[
                    "fragments"
                ].append(
                    fragment
                )

            else:

                page_lines.append(
                    {
                        "page":
                            page_number,

                        "y":
                            fragment[
                                "y"
                            ],

                        "fragments":
                            [
                                fragment
                            ],
                    }
                )

        for line in page_lines:

            fragments_sorted = sorted(
                line[
                    "fragments"
                ],
                key=lambda item: item[
                    "x"
                ],
            )

            text = clean_text(
                " ".join(
                    item[
                        "text"
                    ]
                    for item
                    in fragments_sorted
                )
            )

            if not text:
                continue

            all_lines.append(
                {
                    "page":
                        line[
                            "page"
                        ],

                    "y":
                        line[
                            "y"
                        ],

                    "xMin":
                        min(
                            item[
                                "x"
                            ]
                            for item
                            in fragments_sorted
                        ),

                    "xMax":
                        max(
                            item[
                                "x"
                            ]
                            for item
                            in fragments_sorted
                        ),

                    "text":
                        text,
                }
            )

    return all_lines


def find_spatial_heading(
    lines: list[dict],
) -> int | None:

    for index, line in enumerate(
        lines
    ):

        normalized = normalize_text(
            line[
                "text"
            ]
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


def spatial_line_has_weight(
    line: dict,
) -> bool:

    return bool(
        percentage_matches(
            line[
                "text"
            ]
        )
    )


def build_spatial_candidates(
    lines: list[dict],
    heading_index: int,
) -> list[dict]:

    heading = lines[
        heading_index
    ]

    heading_page = heading[
        "page"
    ]

    heading_y = heading[
        "y"
    ]

    candidates = []

    for index in range(
        heading_index + 1,
        min(
            len(lines),
            heading_index
            +
            SPATIAL_MAX_LINES_AFTER_HEADING
            +
            1,
        ),
    ):

        line = lines[
            index
        ]

        if line[
            "page"
        ] != heading_page:

            break

        text = clean_text(
            line[
                "text"
            ]
        )

        if not text:
            continue

        if is_holdings_end(
            text
        ):

            break

        if normalize_text(
            text
        ) in {
            "name",
            "holding",
            "holdings",
            "weight",
            "weights",
            "allocation",
        }:

            continue

        candidates.append(
            line
        )

    return candidates


def choose_spatial_left_column(
    lines: list[dict],
) -> list[dict]:

    if not lines:
        return []

    weight_lines = [
        line
        for line in lines
        if spatial_line_has_weight(
            line
        )
    ]

    if not weight_lines:
        return []

    rightmost_weight_x = max(
        line[
            "xMax"
        ]
        for line
        in weight_lines
    )

    # The holdings name column normally occupies the area left of the
    # portfolio-weight column. We do not pair coordinates here.
    # We only reconstruct the textual left-side section.
    boundary = rightmost_weight_x

    selected = []

    for line in lines:

        text = line[
            "text"
        ]

        if not text:
            continue

        if line[
            "xMin"
        ] < boundary:

            selected.append(
                line
            )

    return selected


def spatial_lines_to_section(
    lines: list[dict],
) -> str:

    if not lines:
        return ""

    def line_x_min(line: dict) -> float:
        # Recovery 3 positioned rows use {page, y, fragments, text};
        # older spatial rows may also contain xMin.  Never let diagnostic
        # formatting fail with KeyError("xMin") and mask the real parser
        # error.
        if "xMin" in line:
            try:
                return float(line["xMin"])
            except (TypeError, ValueError):
                pass

        fragments = line.get("fragments") or []
        xs = []

        for fragment in fragments:
            try:
                xs.append(float(fragment["x"]))
            except (KeyError, TypeError, ValueError):
                continue

        return min(xs) if xs else float("inf")

    # Preserve PDF reading order.
    lines = sorted(
        lines,
        key=lambda item: (
            item.get("page", 0),
            -float(item.get("y", 0)),
            line_x_min(item),
        )
    )

    return "\n".join(
        clean_text(line.get("text", ""))
        for line in lines
        if clean_text(line.get("text", ""))
    )


def extract_spatial_fallback(
    pdf_bytes: bytes,
) -> tuple[
    list[dict],
    str,
    dict,
]:

    lines = positioned_pdf_lines(
        pdf_bytes
    )

    diagnostics = {
        "positionedLineCount":
            len(lines),

        "headingFound":
            False,

        "candidateLineCount":
            0,

        "selectedLineCount":
            0,

        "parser":
            "fallback",
    }

    heading_index = find_spatial_heading(
        lines
    )

    if heading_index is None:

        raise RuntimeError(
            "Spatial recovery could not locate "
            "Top 10 holdings heading."
        )

    diagnostics[
        "headingFound"
    ] = True

    candidate_lines = (
        build_spatial_candidates(
            lines,
            heading_index,
        )
    )

    diagnostics[
        "candidateLineCount"
    ] = len(
        candidate_lines
    )

    selected_lines = (
        choose_spatial_left_column(
            candidate_lines
        )
    )

    diagnostics[
        "selectedLineCount"
    ] = len(
        selected_lines
    )

    section = spatial_lines_to_section(
        selected_lines
    )

    if not section:

        raise RuntimeError(
            "Spatial recovery reconstructed an empty "
            "Top 10 holdings section."
        )

    # IMPORTANT:
    #
    # Spatial recovery is only allowed to reconstruct the section.
    # It MUST then use the normal fallback parser.
    holdings = parse_holdings_fallback(
        section
    )

    diagnostics[
        "parsedHoldingCount"
    ] = len(
        holdings
    )

    return (
        holdings,
        section,
        diagnostics,
    )


# =============================================================================
# NEXT-STAGE FIXED-INCOME RECOVERY
# =============================================================================


def parse_holdings_fixed_income_recovery(
    section_text: str,
) -> list[dict]:
    """
    Conservative fixed-income recovery parser.

    This parser is deliberately used ONLY after the complete Recovery 2
    engine has failed a fund.  It is designed for official Prudential
    fixed-income tables where a security description can legitimately
    contain coupon percentages, for example:

        SINGAPORE (REPUBLIC OF) 2.375% 1-JUL-2039 5.8%

    The LAST percentage on a logical holding line is treated as the
    published portfolio weight.  Earlier percentages remain part of the
    security description and are never discarded.

    No coordinate pairing, fuzzy matching, estimation, interpolation, or
    third-party data is used.
    """

    lines = build_logical_holding_lines(
        section_text
    )

    if not lines:
        raise RuntimeError(
            "Fixed-income recovery parser received an empty section."
        )

    holdings = []
    pending_fragments = []
    pending_rank = None
    multiple_percentage_lines = 0
    weight_lines = 0

    for raw_line in lines:
        line = clean_text(raw_line)

        if not line:
            continue

        if is_holding_header_or_noise(line):
            continue

        detected_rank, remainder = extract_leading_rank(line)

        if detected_rank is not None:
            # A new published rank cannot appear until the preceding holding
            # has been completed.  This prevents accidental cross-row pairing.
            if pending_fragments:
                raise RuntimeError(
                    "Fixed-income parser encountered a new rank before "
                    "the previous holding received a published weight."
                )

            pending_rank = detected_rank
            line = remainder

            if not line:
                continue

        matches = percentage_matches(line)

        if len(matches) > 1:
            multiple_percentage_lines += 1

        percentage_info = find_last_percentage_in_line(line)

        if percentage_info:
            (
                weight,
                weight_text,
                start,
                _end,
            ) = percentage_info

            fragment = clean_text(line[:start])

            if fragment:
                pending_fragments.append(fragment)

            name = combine_holding_name_fragments(
                pending_fragments
            )

            if not name:
                raise RuntimeError(
                    "Fixed-income parser found a published percentage "
                    "without a holding name."
                )

            rank = (
                pending_rank
                if pending_rank is not None
                else len(holdings) + 1
            )

            holdings.append(
                {
                    "rank": rank,
                    "name": name,
                    "weightPercent": weight,
                    "weightText": weight_text,
                }
            )

            weight_lines += 1
            pending_fragments = []
            pending_rank = None

            if len(holdings) >= MAX_HOLDINGS:
                break

            continue

        fragment = clean_holding_fragment(line)

        if fragment:
            pending_fragments.append(fragment)

    if pending_fragments:
        raise RuntimeError(
            "Fixed-income parser reached the end of the holdings section "
            "with an incomplete holding that has no published weight."
        )

    if not holdings:
        raise RuntimeError(
            "Fixed-income parser found no published holdings."
        )

    # This stage exists specifically for the fixed-income ambiguity.  Require
    # actual evidence of the ambiguity rather than silently becoming another
    # generic parser for an unrelated failed fund.
    if multiple_percentage_lines == 0:
        raise RuntimeError(
            "Fixed-income recovery evidence not found: no logical holding "
            "line contained multiple percentages."
        )

    holdings = validate_holdings(
        holdings,
        "Fixed-income recovery",
    )

    ranks = [
        item["rank"]
        for item in holdings
    ]

    expected_ranks = list(
        range(
            1,
            len(holdings) + 1,
        )
    )

    if ranks != expected_ranks:
        raise RuntimeError(
            "Fixed-income recovery published ranks are not sequential. "
            f"Parsed={ranks}; Expected={expected_ranks}"
        )

    return holdings


def extract_fixed_income_recovery_engine(
    pdf_bytes: bytes,
) -> dict:
    """
    Run the next specialised recovery engine against an official PDF.

    The normal text extraction and official Top Holdings section locator are
    reused.  Only the holding parser changes.
    """

    (
        full_text,
        page_count,
    ) = extract_pdf_text(pdf_bytes)

    (
        section_text,
        section_status,
    ) = extract_holdings_section(full_text)

    if section_status == "not_published":
        return {
            "status": "no_holdings_section",
            "holdings": [],
            "parser": None,
            "fixedIncomeParserError": None,
            "fullText": full_text,
            "sectionText": "",
            "pageCount": page_count,
        }

    try:
        holdings = parse_holdings_fixed_income_recovery(
            section_text
        )
    except Exception as error:
        raise HoldingsParseFailure(
            "Fixed-income recovery parser failed: "
            f"{clean_text(str(error))}",
            section_text=section_text,
            full_text=full_text,
            diagnostics={
                "fixedIncomeParserError": clean_text(str(error)),
            },
        ) from error

    return {
        "status": "success",
        "holdings": holdings,
        "parser": "fixed_income_table",
        "fixedIncomeParserError": None,
        "fullText": full_text,
        "sectionText": section_text,
        "pageCount": page_count,
    }


def recover_single_fund_fixed_income(
    page,
    excel_fund: dict,
) -> dict:
    """
    Re-download the official Prudential factsheet for one fund and run ONLY
    the specialised fixed-income recovery parser.
    """

    excel_row = int(
        excel_fund["excelRow"]
    )

    prudential_url = ensure_prudential_url(
        excel_fund["prudentialUrl"]
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

    final_url = clean_text(page.url)

    if not is_prudential_url(final_url):
        raise RuntimeError(
            "Fixed-income recovery page redirected outside Prudential "
            f"Singapore: {final_url}"
        )

    page_title = clean_text(page.title())
    fund_name = extract_fund_page_name(page)
    factsheet_url = find_factsheet_url(page)

    print(
        f"Fixed-income recovery row {excel_row}: "
        f"{fund_name or '-'}"
    )

    factsheet_bytes = download_factsheet(
        page,
        factsheet_url,
    )

    engine = extract_fixed_income_recovery_engine(
        factsheet_bytes
    )

    if engine["status"] == "no_holdings_section":
        return {
            "status": "no_holdings_section",
            "excelRow": excel_row,
            "prudentialUrl": prudential_url,
            "finalUrl": final_url,
            "pageTitle": page_title,
            "fundName": fund_name,
            "excelPruAccessName": excel_fund.get("pruAccessName"),
            "factsheetUrl": factsheet_url,
            "factsheetPageCount": engine["pageCount"],
            "factsheetDocumentDate": extract_document_date(
                engine["fullText"]
            ),
            "factsheetDataAsAt": extract_data_as_at(
                engine["fullText"]
            ),
            "topHoldingsCount": 0,
            "topHoldings": [],
            "holdingsParser": None,
            "recoveryEngine": "fixed_income_no_holdings_section",
            "recoveryStage": "recovery2_next",
            "_factsheetBytes": factsheet_bytes,
            "_fullText": engine["fullText"],
            "_sectionText": "",
        }

    holdings = engine["holdings"]

    return {
        "status": "success",
        "excelRow": excel_row,
        "prudentialUrl": prudential_url,
        "finalUrl": final_url,
        "pageTitle": page_title,
        "fundName": fund_name,
        "excelPruAccessName": excel_fund.get("pruAccessName"),
        "factsheetUrl": factsheet_url,
        "factsheetDocumentDate": extract_document_date(
            engine["fullText"]
        ),
        "factsheetDataAsAt": extract_data_as_at(
            engine["fullText"]
        ),
        "factsheetPageCount": engine["pageCount"],
        "holdingsSectionStatus": "published",
        "topHoldingsCount": len(holdings),
        "topHoldings": holdings,
        "holdingsParser": engine["parser"],
        "recoveryEngine": "fixed_income_table",
        "recoveryStage": "recovery2_next",
        "primaryParserError": None,
        "fallbackParserError": None,
        "spatialRecoveryError": None,
        "spatialDiagnostics": None,
        "fixedIncomeParserError": None,
        "_factsheetBytes": factsheet_bytes,
        "_fullText": engine["fullText"],
        "_sectionText": engine["sectionText"],
    }




# =============================================================================
# EXTRACTION ENGINE
# =============================================================================

def extract_with_recovery_engine(
    pdf_bytes: bytes,
) -> dict:

    (
        full_text,
        page_count,
    ) = extract_pdf_text(
        pdf_bytes
    )

    (
        section_text,
        section_status,
    ) = extract_holdings_section(
        full_text
    )

    if section_status == "not_published":

        return {
            "status":
                "no_holdings_section",

            "holdings":
                [],

            "parser":
                None,

            "primaryParserError":
                None,

            "fallbackParserError":
                None,

            "spatialRecoveryError":
                None,

            "fullText":
                full_text,

            "sectionText":
                "",

            "pageCount":
                page_count,

            "spatialDiagnostics":
                None,
        }

    primary_error = None

    try:

        holdings = parse_holdings(
            section_text
        )

        return {
            "status":
                "success",

            "holdings":
                holdings,

            "parser":
                "primary",

            "primaryParserError":
                None,

            "fallbackParserError":
                None,

            "spatialRecoveryError":
                None,

            "fullText":
                full_text,

            "sectionText":
                section_text,

            "pageCount":
                page_count,

            "spatialDiagnostics":
                None,
        }

    except Exception as error:

        primary_error = clean_text(
            str(error)
        )

    fallback_error = None

    try:

        holdings = parse_holdings_fallback(
            section_text
        )

        return {
            "status":
                "success",

            "holdings":
                holdings,

            "parser":
                "fallback",

            "primaryParserError":
                primary_error,

            "fallbackParserError":
                None,

            "spatialRecoveryError":
                None,

            "fullText":
                full_text,

            "sectionText":
                section_text,

            "pageCount":
                page_count,

            "spatialDiagnostics":
                None,
        }

    except Exception as error:

        fallback_error = clean_text(
            str(error)
        )

    spatial_error = None

    try:

        (
            spatial_holdings,
            spatial_section,
            spatial_diagnostics,
        ) = extract_spatial_fallback(
            pdf_bytes
        )

        return {
            "status":
                "success",

            "holdings":
                spatial_holdings,

            "parser":
                "spatial_fallback",

            "primaryParserError":
                primary_error,

            "fallbackParserError":
                fallback_error,

            "spatialRecoveryError":
                None,

            "fullText":
                full_text,

            "sectionText":
                spatial_section,

            "pageCount":
                page_count,

            "spatialDiagnostics":
                spatial_diagnostics,
        }

    except Exception as error:

        spatial_error = clean_text(
            str(error)
        )

    raise HoldingsParseFailure(
        "All recovery extraction engines failed. "
        f"Primary={primary_error}; "
        f"Fallback={fallback_error}; "
        f"Spatial={spatial_error}",
        section_text=section_text,
        full_text=full_text,
        diagnostics={
            "primaryParserError":
                primary_error,

            "fallbackParserError":
                fallback_error,

            "spatialRecoveryError":
                spatial_error,
        },
    )


# =============================================================================
# FUND PAGE
# =============================================================================

def extract_fund_page_name(
    page,
) -> str:

    try:

        h1 = page.locator(
            "h1"
        ).first

        if h1.count():

            name = clean_text(
                h1.inner_text()
            )

            if name:
                return name

    except Exception:

        pass

    try:

        body = clean_text(
            page.locator(
                "body"
            ).inner_text()
        )

        match = re.search(
            r"\bPRU(?:Link|Prime)\s+[^\n]+",
            body,
            re.IGNORECASE,
        )

        if match:

            return clean_text(
                match.group(0)
            )

    except Exception:

        pass

    return ""


# =============================================================================
# SINGLE FUND RECOVERY
# =============================================================================

def recover_single_fund(
    page,
    excel_fund: dict,
) -> dict:

    excel_row = int(
        excel_fund[
            "excelRow"
        ]
    )

    prudential_url = ensure_prudential_url(
        excel_fund[
            "prudentialUrl"
        ]
    )

    print(
        "\n"
        + "=" * 72
    )

    print(
        f"RECOVERY 2 - FUND ROW {excel_row}"
    )

    print(
        "=" * 72
    )

    print(
        f"URL: {prudential_url}"
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

    if not is_prudential_url(
        final_url
    ):

        raise RuntimeError(
            "Fund page redirected outside Prudential Singapore: "
            f"{final_url}"
        )

    page_title = clean_text(
        page.title()
    )

    fund_name = extract_fund_page_name(
        page
    )

    factsheet_url = find_factsheet_url(
        page
    )

    print(
        f"Fund: {fund_name or '-'}"
    )

    print(
        f"Factsheet: {factsheet_url}"
    )

    factsheet_bytes = download_factsheet(
        page,
        factsheet_url,
    )

    engine = extract_with_recovery_engine(
        factsheet_bytes
    )

    if engine[
        "status"
    ] == "no_holdings_section":

        return {
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

            "excelPruAccessName":
                excel_fund.get(
                    "pruAccessName"
                ),

            "factsheetUrl":
                factsheet_url,

            "factsheetPageCount":
                engine[
                    "pageCount"
                ],

            "factsheetDocumentDate":
                extract_document_date(
                    engine[
                        "fullText"
                    ]
                ),

            "factsheetDataAsAt":
                extract_data_as_at(
                    engine[
                        "fullText"
                    ]
                ),

            "topHoldingsCount":
                0,

            "topHoldings":
                [],

            "holdingsParser":
                None,

            "recoveryEngine":
                "no_holdings_section",

            "_factsheetBytes":
                factsheet_bytes,

            "_fullText":
                engine[
                    "fullText"
                ],

            "_sectionText":
                "",
        }

    holdings = engine[
        "holdings"
    ]

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
            excel_fund.get(
                "pruAccessName"
            ),

        "factsheetUrl":
            factsheet_url,

        "factsheetDocumentDate":
            extract_document_date(
                engine[
                    "fullText"
                ]
            ),

        "factsheetDataAsAt":
            extract_data_as_at(
                engine[
                    "fullText"
                ]
            ),

        "factsheetPageCount":
            engine[
                "pageCount"
            ],

        "holdingsSectionStatus":
            "published",

        "topHoldingsCount":
            len(
                holdings
            ),

        "topHoldings":
            holdings,

        "holdingsParser":
            engine[
                "parser"
            ],

        "primaryParserError":
            engine[
                "primaryParserError"
            ],

        "fallbackParserError":
            engine[
                "fallbackParserError"
            ],

        "spatialRecoveryError":
            engine[
                "spatialRecoveryError"
            ],

        "spatialDiagnostics":
            engine[
                "spatialDiagnostics"
            ],

        "_factsheetBytes":
            factsheet_bytes,

        "_fullText":
            engine[
                "fullText"
            ],

        "_sectionText":
            engine[
                "sectionText"
            ],
    }

    return result


# =============================================================================
# EXACT FINAL VERIFICATION
# =============================================================================

def verify_exact_against_official_pdf(
    page,
    result: dict,
    extraction_engine=None,
) -> dict:

    print(
        "FINAL VERIFICATION: downloading official PDF again..."
    )

    factsheet_url = ensure_prudential_url(
        result[
            "factsheetUrl"
        ]
    )

    response = page.request.get(
        factsheet_url,
        timeout=FACTSHEET_DOWNLOAD_TIMEOUT_MS,
    )

    if response.status != 200:

        raise RuntimeError(
            "Final verification factsheet download returned "
            f"HTTP {response.status}."
        )

    verification_bytes = response.body()

    if not verification_bytes.startswith(
        b"%PDF"
    ):

        raise RuntimeError(
            "Final verification response was not a PDF."
        )

    if extraction_engine is None:
        extraction_engine = extract_with_recovery_engine

    verification_engine = extraction_engine(
        verification_bytes
    )

    if verification_engine[
        "status"
    ] != "success":

        raise RuntimeError(
            "Final verification could not extract published holdings."
        )

    original_holdings = result[
        "topHoldings"
    ]

    verified_holdings = (
        verification_engine[
            "holdings"
        ]
    )

    original_signature = holding_signature(
        original_holdings
    )

    verified_signature = holding_signature(
        verified_holdings
    )

    if (
        original_signature
        !=
        verified_signature
    ):

        diagnostics = {
            "originalSignature":
                original_signature,

            "verifiedSignature":
                verified_signature,

            "originalHoldings":
                original_holdings,

            "verifiedHoldings":
                verified_holdings,

            "verificationParser":
                verification_engine[
                    "parser"
                ],

            "verificationPrimaryParserError":
                verification_engine[
                    "primaryParserError"
                ],

            "verificationFallbackParserError":
                verification_engine[
                    "fallbackParserError"
                ],

            "verificationSpatialDiagnostics":
                verification_engine.get(
                    "spatialDiagnostics"
                ),

            "verificationFixedIncomeParserError":
                verification_engine.get(
                    "fixedIncomeParserError"
                ),
        }

        raise HoldingsParseFailure(
            "EXACT VERIFICATION FAILED: the re-downloaded "
            "official Prudential PDF produced a different "
            "rank/name/weight signature.",
            section_text=verification_engine[
                "sectionText"
            ],
            full_text=verification_engine[
                "fullText"
            ],
            diagnostics=diagnostics,
        )

    return {
        "verified":
            True,

        "verifiedParser":
            verification_engine[
                "parser"
            ],

        "verifiedHoldingCount":
            len(
                verified_holdings
            ),

        "verifiedSignature":
            verified_signature,

        "verificationFactsheetBytes":
            verification_bytes,

        "verificationFullText":
            verification_engine[
                "fullText"
            ],

        "verificationSectionText":
            verification_engine[
                "sectionText"
            ],
    }


# =============================================================================
# OUTPUT HELPERS
# =============================================================================

def recovery_directory(
    result: dict,
) -> Path:

    excel_row = int(
        result[
            "excelRow"
        ]
    )

    identifier = safe_filename(
        result.get(
            "fundName"
        )
        or
        urlparse(
            result.get(
                "finalUrl"
            )
            or
            result.get(
                "prudentialUrl"
            )
        ).path.rstrip(
            "/"
        ).split(
            "/"
        )[-1]
        or
        f"fund_{excel_row}"
    )

    return (
        RECOVERY_FUNDS_OUTPUT_DIR
        /
        f"{excel_row}_{identifier}"
    )


def save_success(
    result: dict,
    verification: dict,
) -> Path:

    directory = recovery_directory(
        result
    )

    directory.mkdir(
        parents=True,
        exist_ok=True,
    )

    verification_bytes = (
        verification[
            "verificationFactsheetBytes"
        ]
    )

    verification_full_text = (
        verification[
            "verificationFullText"
        ]
    )

    verification_section = (
        verification[
            "verificationSectionText"
        ]
    )

    (
        directory
        /
        "factsheet.pdf"
    ).write_bytes(
        verification_bytes
    )

    (
        directory
        /
        "factsheet_text.txt"
    ).write_text(
        verification_full_text,
        encoding="utf-8",
    )

    (
        directory
        /
        "top_holdings_section.txt"
    ).write_text(
        verification_section,
        encoding="utf-8",
    )

    clean_result = {
        key:
            value
        for key, value
        in result.items()
        if not key.startswith("_")
    }

    clean_result[
        "verification"
    ] = {
        "verified":
            True,

        "verifiedParser":
            verification[
                "verifiedParser"
            ],

        "verifiedHoldingCount":
            verification[
                "verifiedHoldingCount"
            ],

        "exactSignatureMatch":
            True,

        "verifiedAtUtc":
            utc_now_iso(),
    }

    save_json(
        directory
        /
        "top_holdings.json",
        clean_result,
    )

    save_json(
        directory
        /
        "recovery_diagnostics.json",
        {
            "recoveryEngine":
                result.get(
                    "recoveryEngine"
                ),

            "holdingsParser":
                result.get(
                    "holdingsParser"
                ),

            "primaryParserError":
                result.get(
                    "primaryParserError"
                ),

            "fallbackParserError":
                result.get(
                    "fallbackParserError"
                ),

            "spatialRecoveryError":
                result.get(
                    "spatialRecoveryError"
                ),

            "spatialDiagnostics":
                result.get(
                    "spatialDiagnostics"
                ),

            "verification":
                {
                    "verifiedParser":
                        verification[
                            "verifiedParser"
                        ],

                    "exactSignatureMatch":
                        True,
                },

            "savedAtUtc":
                utc_now_iso(),
        },
    )

    save_json(
        directory
        /
        "metadata.json",
        {
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
                result.get(
                    "topHoldingsCount"
                ),

            "holdingsParser":
                result.get(
                    "holdingsParser"
                ),

            "verificationParser":
                verification.get(
                    "verifiedParser"
                ),

            "exactVerification":
                True,

            "savedAtUtc":
                utc_now_iso(),
        },
    )

    return directory


def save_no_holdings_section(
    result: dict,
) -> Path:

    directory = recovery_directory(
        result
    )

    directory.mkdir(
        parents=True,
        exist_ok=True,
    )

    clean_result = {
        key:
            value
        for key, value
        in result.items()
        if not key.startswith("_")
    }

    clean_result[
        "recoveryEngine"
    ] = "no_holdings_section"

    save_json(
        directory
        /
        "top_holdings.json",
        clean_result,
    )

    (
        directory
        /
        "factsheet_text.txt"
    ).write_text(
        result.get(
            "_fullText"
        )
        or
        "",
        encoding="utf-8",
    )

    save_json(
        directory
        /
        "metadata.json",
        {
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

            "status":
                "no_holdings_section",

            "savedAtUtc":
                utc_now_iso(),
        },
    )

    return directory


def save_failure(
    excel_fund: dict,
    error_text: str,
    attempt_diagnostics: list[dict],
    section_text: str | None = None,
    full_text: str | None = None,
    diagnostics: dict | None = None,
) -> Path:

    excel_row = int(
        excel_fund[
            "excelRow"
        ]
    )

    directory = (
        RECOVERY_FUNDS_OUTPUT_DIR
        /
        f"{excel_row}_failed"
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

        "attempts":
            attempt_diagnostics,

        "failedAtUtc":
            utc_now_iso(),
    }

    save_json(
        directory
        /
        "failure.json",
        failure,
    )

    if section_text:

        (
            directory
            /
            "top_holdings_section.txt"
        ).write_text(
            section_text,
            encoding="utf-8",
        )

    if full_text:

        (
            directory
            /
            "factsheet_text.txt"
        ).write_text(
            full_text,
            encoding="utf-8",
        )

    if diagnostics:

        save_json(
            directory
            /
            "recovery_diagnostics.json",
            diagnostics,
        )

    return directory


# =============================================================================
# NEXT RECOVERY FAILURE OUTPUT
# =============================================================================

def save_next_recovery_failure(
    excel_fund: dict,
    error_text: str,
    attempt_diagnostics: list[dict],
    section_text: str | None = None,
    full_text: str | None = None,
    diagnostics: dict | None = None,
) -> Path:
    """Save next-stage diagnostics without destroying the Recovery 2 result."""

    excel_row = int(excel_fund["excelRow"])

    directory = (
        RECOVERY_FUNDS_OUTPUT_DIR
        / f"{excel_row}_failed"
    )

    directory.mkdir(
        parents=True,
        exist_ok=True,
    )

    failure = {
        "status": "failed",
        "recoveryStage": "recovery2_next",
        "recoveryMethod": "fixed_income_table",
        "excelRow": excel_row,
        "prudentialUrl": excel_fund["prudentialUrl"],
        "excelPruAccessName": excel_fund.get("pruAccessName"),
        "error": clean_text(error_text),
        "attempts": attempt_diagnostics,
        "failedAtUtc": utc_now_iso(),
    }

    save_json(
        directory / "recovery2_next_failure.json",
        failure,
    )

    if section_text:
        (
            directory / "recovery2_next_top_holdings_section.txt"
        ).write_text(
            section_text,
            encoding="utf-8",
        )

    if full_text:
        (
            directory / "recovery2_next_factsheet_text.txt"
        ).write_text(
            full_text,
            encoding="utf-8",
        )

    if diagnostics:
        save_json(
            directory / "recovery2_next_diagnostics.json",
            diagnostics,
        )

    return directory





# =============================================================================
# RECOVERY 3 CONFIGURATION
# =============================================================================

# Recovery 3 is deliberately independent from Recovery 2's output directory.
# Recovery 2 remains the source of the failed-fund universe only.
RECOVERY_2_RUN_SUMMARY_FILE = Path(
    "output_holdings_recovery_2/run_summary.json"
)

RECOVERY_3_OUTPUT_DIR = Path(
    "output_holdings_recovery_3"
)

RECOVERY_3_FUNDS_OUTPUT_DIR = (
    RECOVERY_3_OUTPUT_DIR / "funds"
)

RECOVERY_3_RUN_SUMMARY_FILE = (
    RECOVERY_3_OUTPUT_DIR / "run_summary.json"
)

# Rebind the shared output helpers inherited from Recovery 2 so that every
# Recovery 3 evidence file is written only under output_holdings_recovery_3.
RECOVERY_OUTPUT_DIR = RECOVERY_3_OUTPUT_DIR
RECOVERY_FUNDS_OUTPUT_DIR = RECOVERY_3_FUNDS_OUTPUT_DIR
RECOVERY_RUN_SUMMARY_FILE = RECOVERY_3_RUN_SUMMARY_FILE


# =============================================================================
# RECOVERY 3 SOURCE / UNIVERSE
# =============================================================================

def load_recovery_2_run_summary() -> dict:
    if not RECOVERY_2_RUN_SUMMARY_FILE.exists():
        raise FileNotFoundError(
            "Recovery 2 run summary not found: "
            f"{RECOVERY_2_RUN_SUMMARY_FILE}"
        )

    with RECOVERY_2_RUN_SUMMARY_FILE.open(
        "r",
        encoding="utf-8",
    ) as handle:
        summary = json.load(handle)

    if not isinstance(summary, dict):
        raise RuntimeError(
            "Recovery 2 run summary is not a JSON object."
        )

    return summary


def build_recovery_3_universe(
    recovery_2: dict,
    excel_funds: dict[int, dict],
) -> list[dict]:
    """
    Build Recovery 3 strictly from Recovery 2's final failedFundsDetail.

    No Excel rows are hardcoded.  Funds Links.xlsm remains authoritative for
    the URL and fund metadata.
    """

    failed_detail = recovery_2.get(
        "failedFundsDetail",
        [],
    )

    if not isinstance(failed_detail, list):
        raise RuntimeError(
            "Recovery 2 failedFundsDetail is not a list."
        )

    universe = []
    seen_rows = set()

    for item in failed_detail:
        if not isinstance(item, dict):
            continue

        if item.get("excelRow") is None:
            raise RuntimeError(
                "Recovery 2 failedFundsDetail contains an item without "
                "excelRow."
            )

        row = int(item["excelRow"])

        if row in seen_rows:
            continue

        if row not in excel_funds:
            raise RuntimeError(
                "Recovery 2 failed fund row is missing from Funds Links.xlsm: "
                f"row {row}"
            )

        excel_fund = dict(excel_funds[row])

        recorded_url = clean_text(
            item.get("prudentialUrl") or ""
        )
        excel_url = clean_text(
            excel_fund.get("prudentialUrl") or ""
        )

        if recorded_url and recorded_url != excel_url:
            raise RuntimeError(
                "Recovery 2 failed-fund URL does not match the authoritative "
                f"Excel URL for row {row}."
            )

        universe.append(excel_fund)
        seen_rows.add(row)

    universe.sort(
        key=lambda item: int(item["excelRow"])
    )

    return universe


# =============================================================================
# RECOVERY 3 PHYSICAL PDF TABLE EXTRACTION
# =============================================================================

def positioned_pdf_rows_recovery3(
    pdf_bytes: bytes,
) -> list[dict]:
    """
    Extract PDF text while preserving physical fragments.

    Unlike the Recovery 2 fixed-income parser, Recovery 3 retains the actual
    text fragments and their physical table columns.  The parser then
    reconstructs the published rows from the table itself.

    This is column reconstruction, not arbitrary name/percentage proximity
    pairing.  A percentage is considered a portfolio weight only when it is
    physically located in the detected weight column of the Top Holdings
    table.
    """

    reader = PdfReader(
        BytesIO(pdf_bytes)
    )

    rows = []

    for page_number, page in enumerate(
        reader.pages,
        start=1,
    ):
        fragments = []

        def visitor_text(
            text,
            cm,
            tm,
            font_dict,
            font_size,
        ):
            value = clean_text(text)
            if not value:
                return

            try:
                x = float(tm[4])
                y = float(tm[5])
            except Exception:
                return

            fragments.append(
                {
                    "text": value,
                    "x": x,
                    "y": y,
                    "fontSize": float(font_size or 0),
                }
            )

        try:
            page.extract_text(
                visitor_text=visitor_text
            )
        except Exception:
            continue

        fragments.sort(
            key=lambda item: (-item["y"], item["x"])
        )

        page_rows = []
        tolerance = 3.0

        for fragment in fragments:
            if not page_rows:
                page_rows.append(
                    {
                        "page": page_number,
                        "y": fragment["y"],
                        "fragments": [fragment],
                    }
                )
                continue

            current = page_rows[-1]

            if abs(current["y"] - fragment["y"]) <= tolerance:
                current["fragments"].append(fragment)
            else:
                page_rows.append(
                    {
                        "page": page_number,
                        "y": fragment["y"],
                        "fragments": [fragment],
                    }
                )

        for row in page_rows:
            row["fragments"] = sorted(
                row["fragments"],
                key=lambda item: item["x"],
            )

            row["text"] = clean_text(
                " ".join(
                    fragment["text"]
                    for fragment in row["fragments"]
                )
            )

            if row["text"]:
                rows.append(row)

    return rows


def percentage_fragment_recovery3(
    text: str,
) -> bool:
    return bool(
        re.fullmatch(
            r"\(?\s*\d+(?:\.\d+)?\s*%\s*\)?",
            clean_text(text),
        )
    )


def recovery3_percentage_value(
    text: str,
) -> tuple[float, str] | None:
    value = clean_text(text)

    match = re.fullmatch(
        r"\(?\s*(\d+(?:\.\d+)?)\s*%\s*\)?",
        value,
    )

    if not match:
        return None

    numeric = float(match.group(1))

    if numeric < 0 or numeric > 100:
        return None

    return numeric, value


def recovery3_find_heading(
    rows: list[dict],
) -> int | None:
    for index, row in enumerate(rows):
        normalized = normalize_text(row["text"])

        if (
            "top 10 holdings" in normalized
            or "top ten holdings" in normalized
        ):
            return index

    return None


def recovery3_is_table_end(
    text: str,
) -> bool:
    normalized = normalize_text(text)

    if is_holdings_end(text):
        return True

    end_markers = (
        "asset allocation",
        "asset class",
        "geographical allocation",
        "geographic allocation",
        "sector allocation",
        "country allocation",
        "performance",
        "risk classification",
        "fund facts",
        "fund information",
        "disclaimer",
    )

    return any(
        marker in normalized
        for marker in end_markers
    )


def recovery3_detect_weight_column(
    rows: list[dict],
) -> float | None:
    """
    Detect the physical x-position of the published portfolio-weight column.

    Fixed-income security names can contain percentages, so the weight column
    is detected from percentage fragments occurring on genuine maturity-bearing
    holding rows first.  This prevents unrelated percentages elsewhere on the
    factsheet from influencing the selected column.
    """

    maturity_re = re.compile(
        r"\b\d{1,2}-(?:JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)-\d{4}\b",
        re.IGNORECASE,
    )

    maturity_rows = [
        row
        for row in rows
        if maturity_re.search(
            clean_text(row["text"])
        )
    ]

    source_rows = (
        maturity_rows
        if len(maturity_rows) >= 2
        else rows
    )

    candidates = []

    for row in source_rows:
        for fragment in row["fragments"]:
            parsed = recovery3_percentage_value(
                fragment["text"]
            )

            if parsed is None:
                continue

            candidates.append(
                {
                    "x": fragment["x"],
                    "value": parsed[0],
                    "page": row["page"],
                }
            )

    if not candidates:
        return None

    positions = sorted(
        item["x"]
        for item in candidates
    )

    clusters = []

    for x in positions:
        if (
            not clusters
            or x - clusters[-1][-1] > 35
        ):
            clusters.append([x])
        else:
            clusters[-1].append(x)

    if not clusters:
        return None

    repeated = [
        cluster
        for cluster in clusters
        if len(cluster) >= 2
    ]

    selected = (
        repeated[-1]
        if repeated
        else clusters[-1]
    )

    return sum(selected) / len(selected)


def recovery3_weight_fragment(
    row: dict,
    weight_column_x: float,
) -> tuple[int, float, str] | None:
    """
    Return the percentage fragment physically belonging to the table's
    detected weight column.
    """

    candidates = []

    for index, fragment in enumerate(row["fragments"]):
        parsed = recovery3_percentage_value(
            fragment["text"]
        )

        if parsed is None:
            continue

        distance = abs(
            fragment["x"] - weight_column_x
        )

        candidates.append(
            (
                distance,
                index,
                parsed[0],
                parsed[1],
            )
        )

    if not candidates:
        return None

    candidates.sort(
        key=lambda item: item[0]
    )

    distance, index, value, value_text = candidates[0]

    # A row is a member of the weight column only when the percentage is
    # physically in the detected table column.  This prevents coupon values
    # in the security description from becoming portfolio weights.
    if distance > 45:
        return None

    return index, value, value_text


def recovery3_clean_name_fragment(
    text: str,
) -> str:
    value = clean_text(text)

    value = re.sub(
        r"^[•·\-–—]+\s*",
        "",
        value,
    )

    value = re.sub(
        r"^\(?\d{1,2}\)?[\.:\-]\s*",
        "",
        value,
    )

    return clean_text(value)


def recovery3_strip_rank(
    text: str,
) -> tuple[int | None, str]:
    value = clean_text(text)

    match = re.match(
        r"^\s*(\d{1,2})[\.)\-:]?\s+(.*)$",
        value,
    )

    if not match:
        return None, value

    return int(match.group(1)), clean_text(match.group(2))


def recovery3_reconstruct_table(
    rows: list[dict],
) -> tuple[list[dict], dict]:
    """
    Reconstruct the published fixed-income Top Holdings table from its
    physical PDF layout.

    IMPORTANT:

    The maturity/security description is the PRIMARY row anchor.

    A fixed-income security can be extracted as multiple physical PDF lines,
    for example:

        SEATRIUM FINANCIAL SERVICES PTE LTD
        2.95% 28-APR-2031
        1.6%

    The portfolio weight therefore cannot be required to share the exact
    PositionedLine as the maturity date.

    Recovery 3 first identifies the physical portfolio-weight column, then
    identifies the published maturity rows.  Each logical holding block is
    the physical table region between two consecutive maturity rows.  Any
    percentage physically located in the established weight column inside
    that block is the portfolio weight for that maturity row.

    This is structural table reconstruction.  It is NOT arbitrary nearest
    name/percentage matching.
    """

    if not rows:
        raise RuntimeError(
            "Recovery 3 received an empty physical Top Holdings table."
        )

    maturity_re = re.compile(
        r"\b\d{1,2}-(?:JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)-\d{4}\b",
        re.IGNORECASE,
    )

    def is_header_or_noise(text: str) -> bool:
        normalized = normalize_text(text)

        return normalized in {
            "name",
            "holding",
            "holdings",
            "weight",
            "weights",
            "allocation",
            "security",
            "security name",
            "%",
        } or normalized.startswith("top 10 holdings") or normalized.startswith(
            "top ten holdings"
        )

    # ------------------------------------------------------------------
    # 1. Identify genuine fixed-income maturity rows.
    # ------------------------------------------------------------------
    maturity_row_indices = [
        index
        for index, row in enumerate(rows)
        if maturity_re.search(clean_text(row["text"]))
    ]

    if not maturity_row_indices:
        raise RuntimeError(
            "Recovery 3 could not find any fixed-income maturity rows."
        )

    # The weight column is detected from maturity-bearing rows, preserving
    # the existing protection against unrelated percentages elsewhere on the
    # factsheet.
    weight_column_x = recovery3_detect_weight_column(rows)

    if weight_column_x is None:
        raise RuntimeError(
            "Recovery 3 could not detect the physical portfolio-weight column."
        )

    WEIGHT_COLUMN_TOLERANCE = 18.0

    holdings = []
    reconstructed_blocks = []
    rejected_blocks = []
    used_y_values = []
    multiple_percentage_rows = 0
    ambiguous_weight_blocks = 0

    # ------------------------------------------------------------------
    # 2. Reconstruct one physical block per maturity row.
    #
    # Block N starts immediately after the previous maturity row and ends
    # immediately before the next maturity row.  This is the critical fix:
    # a wrapped issuer line, maturity continuation line, and standalone
    # portfolio-weight line all belong to the same logical holding block.
    # ------------------------------------------------------------------
    for maturity_position, maturity_index in enumerate(
        maturity_row_indices
    ):
        previous_maturity_index = (
            maturity_row_indices[maturity_position - 1]
            if maturity_position > 0
            else -1
        )

        next_maturity_index = (
            maturity_row_indices[maturity_position + 1]
            if maturity_position + 1 < len(maturity_row_indices)
            else len(rows)
        )

        # The physical PDF order for fixed-income holdings is not always
        # ``issuer -> maturity -> weight``.  In this factsheet the SEATRIUM
        # holding is physically laid out as:
        #
        #     SEATRIUM FINANCIAL SERVICES PTE LTD   1.6%
        #     2.95% 28-APR-2031
        #
        # Therefore the logical block for a maturity row starts immediately
        # after the PREVIOUS maturity row and ends AT the CURRENT maturity
        # row.  This keeps an issuer/weight line that precedes its maturity
        # attached to that same security, while keeping HSBC and BPCE in
        # their own blocks.
        block_start = previous_maturity_index + 1
        block_end = maturity_index

        block_rows = rows[
            block_start:block_end + 1
        ]

        if not block_rows:
            rejected_blocks.append(
                {
                    "maturityRowIndex": maturity_index,
                    "reason": "empty_physical_block",
                }
            )
            continue

        # --------------------------------------------------------------
        # Security-name side of the table.
        # Only fragments physically left of the portfolio-weight column
        # are allowed into the security description.
        # --------------------------------------------------------------
        name_fragments = []

        for block_row in block_rows:
            if is_header_or_noise(block_row["text"]):
                continue

            for fragment in block_row["fragments"]:
                if fragment["x"] >= (
                    weight_column_x - WEIGHT_COLUMN_TOLERANCE
                ):
                    continue

                fragment_text = recovery3_clean_name_fragment(
                    fragment["text"]
                )

                if fragment_text:
                    name_fragments.append(
                        fragment_text
                    )

        name = combine_holding_name_fragments(
            name_fragments
        )

        if not name:
            rejected_blocks.append(
                {
                    "maturityRowIndex": maturity_index,
                    "reason": "empty_security_name",
                    "blockText": clean_text(
                        " ".join(
                            row["text"]
                            for row in block_rows
                        )
                    ),
                }
            )
            continue

        if not maturity_re.search(name):
            rejected_blocks.append(
                {
                    "maturityRowIndex": maturity_index,
                    "reason": "security_name_lost_maturity_date",
                    "blockText": name,
                }
            )
            continue

        # --------------------------------------------------------------
        # Portfolio-weight side of the same physical block.
        # --------------------------------------------------------------
        weight_candidates = []

        for row_index in range(
            block_start,
            block_end + 1,
        ):
            row = rows[row_index]

            for fragment_index, fragment in enumerate(
                row["fragments"]
            ):
                parsed = recovery3_percentage_value(
                    fragment["text"]
                )

                if parsed is None:
                    continue

                distance = abs(
                    fragment["x"] - weight_column_x
                )

                if distance > WEIGHT_COLUMN_TOLERANCE:
                    continue

                weight_candidates.append(
                    {
                        "rowIndex": row_index,
                        "fragmentIndex": fragment_index,
                        "x": fragment["x"],
                        "y": fragment["y"],
                        "value": parsed[0],
                        "text": parsed[1],
                    }
                )

        # Deduplicate identical PDF fragments.
        unique_weight_candidates = []

        for candidate in weight_candidates:
            duplicate = False

            for existing in unique_weight_candidates:
                if (
                    abs(existing["y"] - candidate["y"]) <= 3.0
                    and abs(existing["x"] - candidate["x"]) <= 12.0
                    and abs(existing["value"] - candidate["value"]) < 0.0001
                ):
                    duplicate = True
                    break

            if not duplicate:
                unique_weight_candidates.append(
                    candidate
                )

        if len(unique_weight_candidates) != 1:
            ambiguous_weight_blocks += 1

            rejected_blocks.append(
                {
                    "maturityRowIndex": maturity_index,
                    "reason": (
                        "expected_exactly_one_weight_column_percentage"
                    ),
                    "candidateCount": len(
                        unique_weight_candidates
                    ),
                    "weightCandidates": unique_weight_candidates,
                    "blockText": clean_text(
                        " ".join(
                            row["text"]
                            for row in block_rows
                        )
                    ),
                    "securityName": name,
                }
            )
            continue

        weight = unique_weight_candidates[0]

        # --------------------------------------------------------------
        # Preserve coupon/rate percentages in the security name.
        # Only the physically anchored weight is excluded from the name.
        # --------------------------------------------------------------
        name = clean_holding_name(
            name
        )

        name = re.sub(
            r"\s+(?=\d{1,2}-(?:JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)-\d{4}\b)",
            " ",
            name,
            flags=re.IGNORECASE,
        )

        if not name:
            continue

        percentage_count = len(
            percentage_matches(name)
        ) + 1

        if percentage_count > 1:
            multiple_percentage_rows += 1

        holdings.append(
            {
                "rank": len(holdings) + 1,
                "name": name,
                "weightPercent": weight["value"],
                "weightText": weight["text"],
                "percentageCountOnPhysicalRow": percentage_count,
            }
        )

        used_y_values.append(
            round(weight["y"], 2)
        )

        reconstructed_blocks.append(
            {
                "maturityRowIndex": maturity_index,
                "startRowIndex": block_start,
                "endRowIndex": block_end,
                "physicalLineCount": len(block_rows),
                "maturityY": round(
                    rows[maturity_index]["y"],
                    2,
                ),
                "weightY": round(
                    weight["y"],
                    2,
                ),
                "weightX": round(
                    weight["x"],
                    2,
                ),
                "weightText": weight["text"],
                "weightValue": weight["value"],
                "reconstructedName": name,
                "percentageCount": percentage_count,
            }
        )

        if len(holdings) >= MAX_HOLDINGS:
            break

    if not holdings:
        raise RuntimeError(
            "Recovery 3 reconstructed no valid fixed-income Top Holdings "
            "rows from the physical maturity/weight table structure."
        )

    # The maturity rows were processed in published top-to-bottom order.
    # Reassign ranks after rejected blocks have been removed.
    for rank, holding in enumerate(
        holdings,
        start=1,
    ):
        holding["rank"] = rank

    holdings = validate_holdings(
        holdings,
        "Recovery 3 physical table parser",
    )

    ranks = [
        int(item["rank"])
        for item in holdings
    ]

    expected_ranks = list(
        range(1, len(holdings) + 1)
    )

    if ranks != expected_ranks:
        raise RuntimeError(
            "Recovery 3 published ranks are not sequential. "
            f"Parsed={ranks}; Expected={expected_ranks}"
        )

    diagnostics = {
        "weightColumnX": round(
            weight_column_x,
            2,
        ),
        "candidateLineCount": len(
            maturity_row_indices
        ),
        "weightedCandidateLineCount": sum(
            1
            for block in reconstructed_blocks
            if block.get("weightText")
        ),
        "weightAnchorCount": len(
            reconstructed_blocks
        ),
        "processedPhysicalRows": len(rows),
        "weightRows": len(holdings),
        "multiplePercentageRows": multiple_percentage_rows,
        "ambiguousWeightBlocks": ambiguous_weight_blocks,
        "usedRows": len(holdings),
        "usedYValues": used_y_values,
        "reconstructedBlocks": reconstructed_blocks,
        "rejectedBlocks": rejected_blocks,
        "algorithm": "maturity_anchored_inclusive_physical_pdf_table_reconstruction",
    }

    return holdings, diagnostics

def extract_recovery3_table_engine(
    pdf_bytes: bytes,
) -> dict:
    """Run the Recovery 3 physical PDF-table extraction engine."""

    full_text, page_count = extract_pdf_text(
        pdf_bytes
    )

    positioned_rows = positioned_pdf_rows_recovery3(
        pdf_bytes
    )

    heading_index = recovery3_find_heading(
        positioned_rows
    )

    if heading_index is None:
        # Preserve the existing official Top Holdings section distinction.
        _, section_status = extract_holdings_section(
            full_text
        )

        if section_status == "not_published":
            return {
                "status": "no_holdings_section",
                "holdings": [],
                "parser": None,
                "fullText": full_text,
                "sectionText": "",
                "pageCount": page_count,
                "primaryParserError": None,
                "fallbackParserError": None,
                "spatialDiagnostics": None,
                "fixedIncomeParserError": None,
                "recovery3ParserError": None,
            }

        raise HoldingsParseFailure(
            "Recovery 3 could not locate the Top Holdings heading in the "
            "physical PDF layout.",
            section_text="",
            full_text=full_text,
            diagnostics={
                "recovery3ParserError": "Top Holdings heading not found "
                "in positioned PDF text.",
            },
        )

    heading_page = positioned_rows[heading_index]["page"]
    table_rows = []

    # Start after the heading.  Allow the table to continue onto following
    # pages, but stop as soon as a clear subsequent section is encountered.
    for row in positioned_rows[heading_index + 1:]:
        if row["page"] < heading_page:
            continue

        text = clean_text(row["text"])

        if not text:
            continue

        if recovery3_is_table_end(text):
            break

        table_rows.append(row)

        # Ten published holdings is the maximum expected Top Holdings table.
        # A small buffer is retained for multiline rows and repeated headers.
        if len(table_rows) >= 100:
            break

    if not table_rows:
        raise HoldingsParseFailure(
            "Recovery 3 found the Top Holdings heading but no physical table "
            "rows followed it.",
            section_text="",
            full_text=full_text,
            diagnostics={
                "recovery3ParserError": "No physical table rows after heading.",
            },
        )

    try:
        holdings, diagnostics = recovery3_reconstruct_table(
            table_rows
        )
    except Exception as error:
        raise HoldingsParseFailure(
            "Recovery 3 physical table parser failed: "
            f"{clean_text(str(error))}",
            section_text=spatial_lines_to_section(
                table_rows
            ),
            full_text=full_text,
            diagnostics={
                "recovery3ParserError": clean_text(str(error)),
                "recovery3Diagnostics": {
                    "headingPage": heading_page,
                    "tableRowCount": len(table_rows),
                },
            },
        ) from error

    return {
        "status": "success",
        "holdings": holdings,
        "parser": "recovery3_physical_table",
        "fullText": full_text,
        "sectionText": spatial_lines_to_section(
            table_rows
        ),
        "pageCount": page_count,
        "primaryParserError": None,
        "fallbackParserError": None,
        "spatialDiagnostics": None,
        "fixedIncomeParserError": None,
        "recovery3ParserError": None,
        "recovery3Diagnostics": diagnostics,
    }


def recover_single_fund_recovery3(
    page,
    excel_fund: dict,
) -> dict:
    """Recover one Recovery 2 failure using the Recovery 3 table engine."""

    excel_row = int(
        excel_fund["excelRow"]
    )

    prudential_url = ensure_prudential_url(
        excel_fund["prudentialUrl"]
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

    final_url = clean_text(page.url)

    if not is_prudential_url(final_url):
        raise RuntimeError(
            "Recovery 3 page redirected outside Prudential Singapore: "
            f"{final_url}"
        )

    page_title = clean_text(page.title())
    fund_name = extract_fund_page_name(page)
    factsheet_url = find_factsheet_url(page)

    print(
        f"Recovery 3 row {excel_row}: "
        f"{fund_name or '-'}"
    )

    factsheet_bytes = download_factsheet(
        page,
        factsheet_url,
    )

    engine = extract_recovery3_table_engine(
        factsheet_bytes
    )

    if engine["status"] == "no_holdings_section":
        return {
            "status": "no_holdings_section",
            "excelRow": excel_row,
            "prudentialUrl": prudential_url,
            "finalUrl": final_url,
            "pageTitle": page_title,
            "fundName": fund_name,
            "excelPruAccessName": excel_fund.get("pruAccessName"),
            "factsheetUrl": factsheet_url,
            "factsheetPageCount": engine["pageCount"],
            "factsheetDocumentDate": extract_document_date(
                engine["fullText"]
            ),
            "factsheetDataAsAt": extract_data_as_at(
                engine["fullText"]
            ),
            "topHoldingsCount": 0,
            "topHoldings": [],
            "holdingsParser": None,
            "recoveryEngine": "recovery3_physical_table_no_holdings_section",
            "recoveryStage": "recovery3",
            "_factsheetBytes": factsheet_bytes,
            "_fullText": engine["fullText"],
            "_sectionText": "",
        }

    holdings = engine["holdings"]

    return {
        "status": "success",
        "excelRow": excel_row,
        "prudentialUrl": prudential_url,
        "finalUrl": final_url,
        "pageTitle": page_title,
        "fundName": fund_name,
        "excelPruAccessName": excel_fund.get("pruAccessName"),
        "factsheetUrl": factsheet_url,
        "factsheetDocumentDate": extract_document_date(
            engine["fullText"]
        ),
        "factsheetDataAsAt": extract_data_as_at(
            engine["fullText"]
        ),
        "factsheetPageCount": engine["pageCount"],
        "holdingsSectionStatus": "published",
        "topHoldingsCount": len(holdings),
        "topHoldings": holdings,
        "holdingsParser": engine["parser"],
        "recoveryEngine": "recovery3_physical_table",
        "recoveryStage": "recovery3",
        "primaryParserError": None,
        "fallbackParserError": None,
        "spatialRecoveryError": None,
        "spatialDiagnostics": None,
        "fixedIncomeParserError": None,
        "recovery3ParserError": engine.get("recovery3ParserError"),
        "recovery3Diagnostics": engine.get("recovery3Diagnostics"),
        "_factsheetBytes": factsheet_bytes,
        "_fullText": engine["fullText"],
        "_sectionText": engine["sectionText"],
    }


# =============================================================================
# RECOVERY 3 MAIN
# =============================================================================

def main() -> int:
    RECOVERY_3_OUTPUT_DIR.mkdir(
        parents=True,
        exist_ok=True,
    )

    RECOVERY_3_FUNDS_OUTPUT_DIR.mkdir(
        parents=True,
        exist_ok=True,
    )

    started_at = utc_now_iso()

    print("\n" + "#" * 78)
    print("VGRAT FMS - PRUDENTIAL TOP HOLDINGS RECOVERY 3")
    print("#" * 78)
    print(f"Started UTC: {started_at}")

    recovery_2 = load_recovery_2_run_summary()
    excel_funds = read_excel_funds()

    recovery_3_universe = build_recovery_3_universe(
        recovery_2,
        excel_funds,
    )

    print("\nRECOVERY 2 SOURCE")
    print(
        f"Recovery 2 status: {recovery_2.get('status')}"
    )
    print(
        f"Recovery 2 final failed funds: "
        f"{recovery_2.get('failedFunds')}"
    )
    print(
        f"Recovery 3 universe: {len(recovery_3_universe)} failed fund(s)"
    )

    if not recovery_3_universe:
        completed_at = utc_now_iso()

        summary = {
            "status": "nothing_to_recover",
            "startedAtUtc": started_at,
            "completedAtUtc": completed_at,
            "recoveryStage": "recovery3",
            "recovery2RunSummary": str(
                RECOVERY_2_RUN_SUMMARY_FILE
            ),
            "excelFile": str(EXCEL_FILE),
            "recovery2FinalFailedFunds": int(
                recovery_2.get("failedFunds", 0) or 0
            ),
            "recovery3Universe": 0,
            "recoveredFunds": 0,
            "noHoldingsSectionFunds": 0,
            "failedFunds": 0,
            "totalPublishedTopHoldingsRecovered": 0,
            "rules": {
                "recovery2FinalFailedFundsOnly": True,
                "officialPrudentialOnly": True,
                "noThirdPartyHoldings": True,
                "noInferredHoldings": True,
                "noFabricatedHoldings": True,
                "noFabricatedPercentages": True,
                "noFuzzyMatching": True,
                "noArbitraryCoordinateProximityPairing": True,
                "physicalTableColumnReconstruction": True,
                "exactFinalVerification": True,
            },
        }

        save_json(
            RECOVERY_3_RUN_SUMMARY_FILE,
            summary,
        )

        print("\nNothing to recover.")
        return 0

    recovered = []
    no_holdings_section = []
    failed = []

    playwright_error = None

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(
            headless=True
        )

        context = browser.new_context(
            accept_downloads=True,
        )

        page = context.new_page()

        try:
            for index, excel_fund in enumerate(
                recovery_3_universe,
                start=1,
            ):
                excel_row = int(
                    excel_fund["excelRow"]
                )

                print(
                    "\n"
                    + "-" * 78
                )
                print(
                    f"Recovery 3 fund {index}/{len(recovery_3_universe)} "
                    f"| Excel row {excel_row}"
                )
                print(
                    f"URL: {excel_fund['prudentialUrl']}"
                )

                attempt_diagnostics = []
                result = None
                last_exception = None

                try:
                    result = recover_single_fund_recovery3(
                        page,
                        excel_fund,
                    )

                    attempt_diagnostics.append({
                        "stage": "recovery3",
                        "status": result.get("status"),
                        "parser": result.get("holdingsParser"),
                    })

                except Exception as error:
                    last_exception = error
                    attempt_diagnostics.append({
                        "stage": "recovery3",
                        "status": "failed",
                        "error": clean_text(str(error)),
                    })

                if result is None:
                    directory = save_failure(
                        excel_fund,
                        clean_text(
                            str(last_exception)
                            if last_exception
                            else "Unknown Recovery 3 failure."
                        ),
                        attempt_diagnostics,
                        diagnostics={
                            "recovery3ParserError": clean_text(
                                str(last_exception)
                            ) if last_exception else None,
                        },
                    )

                    failed.append({
                        "excelRow": excel_row,
                        "prudentialUrl": excel_fund["prudentialUrl"],
                        "pruAccessName": excel_fund.get("pruAccessName"),
                        "error": clean_text(
                            str(last_exception)
                            if last_exception
                            else "Unknown Recovery 3 failure."
                        ),
                        "outputDirectory": str(directory),
                        "attempts": attempt_diagnostics,
                    })
                    continue

                if result["status"] == "no_holdings_section":
                    directory = save_no_holdings_section(
                        result
                    )
                    result["outputDirectory"] = str(directory)
                    no_holdings_section.append(result)

                    print(
                        "Recovery 3 result: NO TOP HOLDINGS SECTION"
                    )
                    continue

                # -------------------------------------------------------------
                # Exact final verification against a fresh official PDF.
                # -------------------------------------------------------------
                try:
                    verification = verify_exact_against_official_pdf(
                        page,
                        result,
                        extraction_engine=extract_recovery3_table_engine,
                    )

                    result["exactVerification"] = {
                        "verified": True,
                        "verifiedParser": verification["verifiedParser"],
                        "verifiedHoldingCount": verification[
                            "verifiedHoldingCount"
                        ],
                        "verifiedSignature": verification[
                            "verifiedSignature"
                        ],
                    }

                    directory = save_success(
                        result,
                        verification,
                    )

                    result["outputDirectory"] = str(directory)
                    recovered.append(result)

                    print("\nRECOVERY 3 SUCCESS")
                    print(
                        f"Fund: {result.get('fundName') or '-'}"
                    )
                    print(
                        f"Parser: {result.get('holdingsParser') or '-'}"
                    )
                    print(
                        f"Holdings: {result.get('topHoldingsCount')}"
                    )
                    print("Exact final verification: PASS")

                    for holding in result["topHoldings"]:
                        print(
                            f"  {holding['rank']}. "
                            f"{holding['name']} - "
                            f"{holding['weightText']}"
                        )

                except Exception as error:
                    last_exception = error
                    diagnostics = {}

                    if isinstance(error, HoldingsParseFailure):
                        diagnostics = error.diagnostics

                    directory = save_failure(
                        excel_fund,
                        clean_text(str(error)),
                        attempt_diagnostics,
                        section_text=(
                            error.section_text
                            if isinstance(error, HoldingsParseFailure)
                            else result.get("_sectionText")
                        ),
                        full_text=(
                            error.full_text
                            if isinstance(error, HoldingsParseFailure)
                            else result.get("_fullText")
                        ),
                        diagnostics=diagnostics,
                    )

                    failed.append({
                        "excelRow": excel_row,
                        "prudentialUrl": excel_fund["prudentialUrl"],
                        "pruAccessName": excel_fund.get("pruAccessName"),
                        "error": clean_text(str(error)),
                        "outputDirectory": str(directory),
                        "attempts": attempt_diagnostics,
                    })

                    print(
                        "RECOVERY 3 FAILED: "
                        f"{clean_text(str(error))}"
                    )

        except Exception as error:
            playwright_error = clean_text(str(error))

        finally:
            context.close()
            browser.close()

    completed_at = utc_now_iso()

    total_holdings = sum(
        int(item.get("topHoldingsCount", 0) or 0)
        for item in recovered
    )

    summary = {
        "status": "success" if not failed else "completed_with_failures",
        "startedAtUtc": started_at,
        "completedAtUtc": completed_at,
        "recoveryStage": "recovery3",
        "recoveryMethod": "physical_pdf_table_column_reconstruction",
        "recovery2RunSummary": str(
            RECOVERY_2_RUN_SUMMARY_FILE
        ),
        "excelFile": str(EXCEL_FILE),
        "recovery2FinalFailedFunds": int(
            recovery_2.get("failedFunds", 0) or 0
        ),
        "recovery3Universe": len(recovery_3_universe),
        "recoveredFunds": len(recovered),
        "noHoldingsSectionFunds": len(no_holdings_section),
        "failedFunds": len(failed),
        "totalPublishedTopHoldingsRecovered": total_holdings,
        "playwrightError": playwright_error,
        "recovery3InputRows": [
            int(item["excelRow"])
            for item in recovery_3_universe
        ],
        "recoveredFundsDetail": [
            {
                "excelRow": item.get("excelRow"),
                "fundName": item.get("fundName"),
                "prudentialUrl": item.get("prudentialUrl"),
                "factsheetUrl": item.get("factsheetUrl"),
                "holdingsParser": item.get("holdingsParser"),
                "topHoldingsCount": item.get("topHoldingsCount"),
                "outputDirectory": item.get("outputDirectory"),
            }
            for item in recovered
        ],
        "failedFundsDetail": failed,
        "noHoldingsSectionDetail": [
            {
                "excelRow": item.get("excelRow"),
                "fundName": item.get("fundName"),
                "prudentialUrl": item.get("prudentialUrl"),
                "factsheetUrl": item.get("factsheetUrl"),
                "outputDirectory": item.get("outputDirectory"),
            }
            for item in no_holdings_section
        ],
        "rules": {
            "recovery2FinalFailedFundsOnly": True,
            "officialPrudentialOnly": True,
            "officialFactsheetOnly": True,
            "noThirdPartyHoldings": True,
            "noInferredHoldings": True,
            "noFabricatedHoldings": True,
            "noFabricatedPercentages": True,
            "noFuzzyMatching": True,
            "noArbitraryCoordinateProximityPairing": True,
            "physicalTableColumnReconstruction": True,
            "fixedIncomeCouponPercentagesPreserved": True,
            "publishedOrderPreserved": True,
            "fewerThanTenPublishedHoldingsAllowed": True,
            "exactFinalVerification": True,
            "freshOfficialPdfVerification": True,
        },
    }

    save_json(
        RECOVERY_3_RUN_SUMMARY_FILE,
        summary,
    )

    print("\n" + "#" * 78)
    print("RECOVERY 3 COMPLETE")
    print("#" * 78)
    print(f"Recovery 3 universe: {len(recovery_3_universe)}")
    print(f"Recovered: {len(recovered)}")
    print(f"No Top Holdings section: {len(no_holdings_section)}")
    print(f"Failed: {len(failed)}")
    print(f"Top Holdings recovered: {total_holdings}")
    print(
        f"Summary: {RECOVERY_3_RUN_SUMMARY_FILE}"
    )

    return 0 if not failed else 1


if __name__ == "__main__":
    raise SystemExit(main())
