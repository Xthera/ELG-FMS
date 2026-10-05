#!/usr/bin/env python3

"""
VGrat FMS - Prudential Top Holdings FAILED-FUND RECOVERY

PURPOSE
=======

Recover ONLY the funds that failed in the frozen baseline:

    scripts/test_prudential_holdings.py

The frozen baseline is NOT modified.

This recovery script reuses the proven extraction logic from the
all-fund Prudential Top Holdings extractor:

    Funds Links.xlsm
          |
          v
    Frozen baseline run_summary.json
          |
          v
    failedFundsDetail
          |
          v
    Validate failed fund against Excel Column A / Column B
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
    Extract complete PDF text
          |
          v
    Locate "Top 10 holdings"
          |
          v
    PRIMARY holdings parser
          |
          | failure
          v
    TEXT FALLBACK parser
          |
          | failure
          v
    SPATIAL PDF FALLBACK
          |
          v
    parse reconstructed visual section
          |
          v
    Re-download official PDF
          |
          v
    Re-run the SAME extraction engine
          |
          v
    Compare exact holdings/signature
          |
          v
    Save recovered result


IMPORTANT
=========

This script is a RECOVERY TEST ONLY.

It does NOT:

- modify test_prudential_holdings.py
- modify test_pruaccess.py
- modify data.json
- modify index.html
- modify CSS
- modify JS
- modify the baseline output
- add funds to the universe
- invent holdings
- invent percentages
- estimate percentages
- interpolate percentages
- use third-party holdings sources
- force ten holdings
- use name/percentage proximity matching
- use broad fuzzy matching to pair a name with a percentage

Only the failed funds recorded in the frozen baseline's:

    failedFundsDetail

are processed.


MASTER SOURCES
==============

Funds Links.xlsm

Column A:
    Prudential fund URL.
    This controls the master universe.

Column B:
    Exact PruAccess fund name.

Frozen baseline:

    output_holdings/run_summary.json


OUTPUT
======

output_holdings_recovery/
    run_summary.json

    funds/
        <excelRow>_<identifier>/
            factsheet.pdf
            factsheet_text.txt
            top_holdings_section.txt
            top_holdings.json
            metadata.json

            pdf_visual_lines.json
            recovery_diagnostics.json

        <excelRow>_failed/
            failure.json
            recovery_diagnostics.json


PARSER ORDER
============

1. Primary text parser

2. Text fallback parser

3. Spatial PDF fallback

The spatial fallback reconstructs the physical left-side Top Holdings
column and then passes that reconstructed section through the proven
fallback parser.

No independent proximity-based name/percentage pairing is performed.
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

BASELINE_RUN_SUMMARY_FILE = Path(
    "output_holdings/run_summary.json"
)

RECOVERY_OUTPUT_DIR = Path(
    "output_holdings_recovery"
)

RECOVERY_FUNDS_OUTPUT_DIR = (
    RECOVERY_OUTPUT_DIR / "funds"
)

RECOVERY_RUN_SUMMARY_FILE = (
    RECOVERY_OUTPUT_DIR / "run_summary.json"
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
# Official Prudential Singapore only.
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
    """
    Normalize whitespace while preserving meaningful text.
    """

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
    """
    Case-insensitive comparison helper.
    """

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


# =============================================================================
# BASELINE
# =============================================================================

def load_baseline_run_summary() -> dict:
    """
    Load the frozen baseline run summary.

    The recovery universe is determined ONLY from:

        failedFundsDetail

    No fallback to alternative failure keys is permitted.
    """

    if not BASELINE_RUN_SUMMARY_FILE.exists():

        raise FileNotFoundError(
            "Frozen baseline run summary not found: "
            f"{BASELINE_RUN_SUMMARY_FILE}"
        )

    try:

        data = json.loads(
            BASELINE_RUN_SUMMARY_FILE.read_text(
                encoding="utf-8"
            )
        )

    except Exception as error:

        raise RuntimeError(
            "Could not read frozen baseline run summary: "
            f"{error}"
        ) from error

    if not isinstance(
        data,
        dict,
    ):

        raise RuntimeError(
            "Frozen baseline run summary is not a JSON object."
        )

    if "failedFundsDetail" not in data:

        raise RuntimeError(
            "Frozen baseline run summary does not contain "
            "the required failedFundsDetail field."
        )

    failed_detail = data[
        "failedFundsDetail"
    ]

    if not isinstance(
        failed_detail,
        list,
    ):

        raise RuntimeError(
            "failedFundsDetail must be a list."
        )

    return data


# =============================================================================
# EXCEL MASTER UNIVERSE
# =============================================================================

def read_excel_funds() -> dict[int, dict]:
    """
    Read every populated URL from Excel Column A.

    Returns:

        {
            excel_row: {
                excelRow,
                prudentialUrl,
                pruAccessName
            }
        }
    """

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

    funds_by_row = {}

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

        funds_by_row[
            row_number
        ] = {
            "excelRow":
                row_number,

            "prudentialUrl":
                prudential_url,

            "pruAccessName":
                pruaccess_name,
        }

    workbook.close()

    if not funds_by_row:

        raise RuntimeError(
            "No populated Prudential URLs were found "
            "in Excel Column A."
        )

    print(
        f"Excel fund universe: {len(funds_by_row)}"
    )

    return funds_by_row


def build_recovery_universe(
    baseline: dict,
    excel_funds: dict[int, dict],
) -> list[dict]:
    """
    Build recovery universe strictly from baseline failedFundsDetail.

    Every failed baseline row must exist in Excel.

    The Prudential URL and PruAccess name used by recovery are taken from
    Excel, while the baseline failure is retained for diagnostics.
    """

    failed_detail = baseline[
        "failedFundsDetail"
    ]

    recovery = []

    seen_rows = set()

    for failure in failed_detail:

        if not isinstance(
            failure,
            dict,
        ):

            raise RuntimeError(
                "failedFundsDetail contains a non-object entry."
            )

        if "excelRow" not in failure:

            raise RuntimeError(
                "A failedFundsDetail entry has no excelRow."
            )

        try:

            excel_row = int(
                failure[
                    "excelRow"
                ]
            )

        except Exception as error:

            raise RuntimeError(
                "Invalid excelRow in failedFundsDetail: "
                f"{failure.get('excelRow')}"
            ) from error

        if excel_row in seen_rows:

            raise RuntimeError(
                "Duplicate failed excelRow in baseline: "
                f"{excel_row}"
            )

        seen_rows.add(
            excel_row
        )

        if excel_row not in excel_funds:

            raise RuntimeError(
                "Baseline failed row "
                f"{excel_row} does not exist in Funds Links.xlsm."
            )

        excel_fund = excel_funds[
            excel_row
        ]

        baseline_url = clean_text(
            failure.get(
                "prudentialUrl"
            )
        )

        excel_url = clean_text(
            excel_fund.get(
                "prudentialUrl"
            )
        )

        if (
            baseline_url
            and
            normalize_text(
                baseline_url
            )
            !=
            normalize_text(
                excel_url
            )
        ):

            raise RuntimeError(
                "Baseline/Excel Prudential URL mismatch "
                f"for row {excel_row}.\n"
                f"Baseline: {baseline_url}\n"
                f"Excel:    {excel_url}"
            )

        baseline_pruaccess_name = clean_text(
            failure.get(
                "pruAccessName"
            )
        )

        excel_pruaccess_name = clean_text(
            excel_fund.get(
                "pruAccessName"
            )
        )

        if (
            baseline_pruaccess_name
            and
            excel_pruaccess_name
            and
            normalize_text(
                baseline_pruaccess_name
            )
            !=
            normalize_text(
                excel_pruaccess_name
            )
        ):

            raise RuntimeError(
                "Baseline/Excel PruAccess name mismatch "
                f"for row {excel_row}.\n"
                f"Baseline: {baseline_pruaccess_name}\n"
                f"Excel:    {excel_pruaccess_name}"
            )

        recovery.append(
            {
                "excelRow":
                    excel_row,

                "prudentialUrl":
                    excel_url,

                "pruAccessName":
                    excel_pruaccess_name,

                "baselineFailure":
                    failure,
            }
        )

    recovery.sort(
        key=lambda item: item[
            "excelRow"
        ]
    )

    return recovery


# =============================================================================
# FIND FACTSHEET LINK
# =============================================================================

def find_factsheet_url(
    page,
    prudential_url: str,
) -> str:
    """
    Locate the official Fund Factsheet link.

    Ranking:

        1. Anchor text contains "Fund Factsheet"
        2. Anchor text contains "Factsheet"
        3. Href contains "factsheet"
        4. PDF extension
    """

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
    """
    Extract all available text from the official PDF.
    """

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
# SPATIAL PDF EXTRACTION
# =============================================================================

def _positioned_pdf_lines(
    pdf_bytes: bytes,
) -> list[dict]:
    """
    Extract PDF text together with physical x/y position.

    This function does not create holdings.

    It only reconstructs visible PDF lines.
    """

    reader = PdfReader(
        BytesIO(
            pdf_bytes
        )
    )

    all_lines = []

    for page_number, pdf_page in enumerate(
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

            if text is None:
                return

            raw = str(text)

            if not raw.strip():
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

            parts = raw.splitlines()

            if not parts:
                parts = [raw]

            for part_index, part in enumerate(
                parts
            ):

                part = clean_text(
                    part
                )

                if not part:
                    continue

                adjusted_y = y

                if part_index:

                    try:

                        adjusted_y = (
                            y
                            -
                            (
                                float(
                                    font_size
                                    or 8
                                )
                                *
                                part_index
                                *
                                1.15
                            )
                        )

                    except Exception:

                        adjusted_y = y

                fragments.append(
                    {
                        "x0":
                            x,

                        "x1":
                            x,

                        "y":
                            adjusted_y,

                        "text":
                            part,
                    }
                )

        try:

            pdf_page.extract_text(
                visitor_text=visitor_text
            )

        except Exception:

            continue

        groups = []

        y_tolerance = 3.0

        for fragment in sorted(
            fragments,
            key=lambda item: (
                -item["y"],
                item["x0"],
            ),
        ):

            target = None

            for group in groups:

                if (
                    abs(
                        group["y"]
                        -
                        fragment["y"]
                    )
                    <=
                    y_tolerance
                ):

                    target = group

                    break

            if target is None:

                target = {
                    "page":
                        page_number,

                    "y":
                        fragment["y"],

                    "fragments":
                        [],
                }

                groups.append(
                    target
                )

            target[
                "fragments"
            ].append(
                fragment
            )

            target[
                "y"
            ] = (
                sum(
                    item["y"]
                    for item
                    in target[
                        "fragments"
                    ]
                )
                /
                len(
                    target[
                        "fragments"
                    ]
                )
            )

        for group in groups:

            fragments_sorted = sorted(
                group[
                    "fragments"
                ],
                key=lambda item: item[
                    "x0"
                ],
            )

            text_parts = []

            x0 = None
            x1 = None

            for fragment in fragments_sorted:

                text_parts.append(
                    fragment[
                        "text"
                    ]
                )

                x0 = (
                    fragment["x0"]
                    if x0 is None
                    else min(
                        x0,
                        fragment["x0"],
                    )
                )

                x1 = (
                    fragment["x1"]
                    if x1 is None
                    else max(
                        x1,
                        fragment["x1"],
                    )
                )

            line_text = clean_text(
                " ".join(
                    text_parts
                )
            )

            if not line_text:
                continue

            all_lines.append(
                {
                    "page":
                        page_number,

                    "y":
                        group["y"],

                    "x0":
                        x0 or 0.0,

                    "x1":
                        x1 or 0.0,

                    "text":
                        line_text,

                    "fragments":
                        fragments_sorted,
                }
            )

    return all_lines


def _is_spatial_top_holdings_heading(
    text: str,
) -> bool:

    normalized = normalize_text(
        text
    )

    return bool(
        re.search(
            r"\btop\s+(?:10|ten)\s+holdings",
            normalized,
            re.IGNORECASE,
        )
    )


def _spatial_column_boundary(
    page_lines: list[dict],
    heading: dict,
    page_width: float,
) -> float:
    """
    Find the right edge of the Top Holdings visual column.

    Prudential frequently places another table beside Top Holdings.
    """

    heading_x = heading[
        "x0"
    ]

    heading_y = heading[
        "y"
    ]

    explicit_right_headers = []

    for line in page_lines:

        if (
            abs(
                line["y"]
                -
                heading_y
            )
            >
            45
        ):

            continue

        for fragment in line.get(
            "fragments",
            [],
        ):

            if (
                fragment["x0"]
                <=
                heading_x + 20
            ):

                continue

            normalized = normalize_text(
                fragment[
                    "text"
                ]
            )

            if any(
                marker in normalized
                for marker in (
                    "dividend history",
                    "distribution history",
                    "date",
                    "frequency",
                    "performance history",
                )
            ):

                explicit_right_headers.append(
                    fragment[
                        "x0"
                    ]
                )

    if explicit_right_headers:

        return (
            min(
                explicit_right_headers
            )
            -
            8.0
        )

    nearby_x = []

    for line in page_lines:

        if (
            heading_y - 70
            <=
            line["y"]
            <=
            heading_y - 5
        ):

            for fragment in line.get(
                "fragments",
                [],
            ):

                if (
                    fragment["x0"]
                    >
                    heading_x + 20
                ):

                    nearby_x.append(
                        fragment[
                            "x0"
                        ]
                    )

    if nearby_x:

        candidate = min(
            nearby_x
        )

        if (
            candidate
            >
            heading_x
            +
            page_width * 0.18
        ):

            return (
                candidate
                -
                8.0
            )

    return max(
        heading_x + 180.0,
        page_width * 0.68,
    )


def _build_spatial_holdings_section(
    page_lines: list[dict],
    heading: dict,
    page_width: float,
) -> tuple[str, list[dict]]:
    """
    Build the visual Top Holdings section.

    Returns:

        section_text
        selected_visual_lines
    """

    left_edge = max(
        0.0,
        heading["x0"] - 15.0,
    )

    right_edge = _spatial_column_boundary(
        page_lines,
        heading,
        page_width,
    )

    selected = []

    for line in page_lines:

        if (
            line["y"]
            >=
            heading["y"] - 2.0
        ):

            continue

        if (
            line["y"]
            <
            heading["y"] - 420.0
        ):

            continue

        if (
            line["x1"]
            <
            left_edge
        ):

            continue

        if (
            line["x0"]
            >=
            right_edge
        ):

            continue

        cropped_fragments = []

        for fragment in line.get(
            "fragments",
            [],
        ):

            if (
                fragment["x1"]
                <
                left_edge
            ):

                continue

            if (
                fragment["x0"]
                >=
                right_edge
            ):

                continue

            cropped_fragments.append(
                fragment
            )

        if not cropped_fragments:
            continue

        cropped_fragments.sort(
            key=lambda item: item[
                "x0"
            ]
        )

        cropped_text = clean_text(
            " ".join(
                fragment["text"]
                for fragment
                in cropped_fragments
            )
        )

        if not cropped_text:
            continue

        normalized = normalize_text(
            cropped_text
        )

        if normalized in {
            "dividend history",
            "distribution history",
            "date",
            "frequency",
        }:

            continue

        if _is_spatial_top_holdings_heading(
            cropped_text
        ):

            break

        if is_holdings_end(
            cropped_text
        ):

            break

        cropped_line = dict(
            line
        )

        cropped_line[
            "text"
        ] = cropped_text

        cropped_line[
            "fragments"
        ] = cropped_fragments

        cropped_line[
            "x0"
        ] = min(
            fragment["x0"]
            for fragment
            in cropped_fragments
        )

        cropped_line[
            "x1"
        ] = max(
            fragment["x1"]
            for fragment
            in cropped_fragments
        )

        selected.append(
            cropped_line
        )

    selected.sort(
        key=lambda item: -item["y"]
    )

    output = []

    weight_rows = 0

    for line in selected:

        text = clean_text(
            line["text"]
        )

        if not text:
            continue

        output.append(
            text
        )

        if (
            find_last_percentage_in_line(
                text
            )
            is not None
        ):

            weight_rows += 1

        if (
            weight_rows
            >=
            MAX_HOLDINGS
        ):

            break

    return (
        "\n".join(output),
        selected,
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
# FACTSHEET DATES
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
) -> tuple[str, str]:

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
# PERCENTAGES
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
        or
        percentage > 100
    ):

        return None

    return percentage


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

    if (
        percentage < 0
        or
        percentage > 100
    ):

        return None

    return (
        percentage,
        clean_text(
            match.group(0)
        ),
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

    matches = list(
        re.finditer(
            r"(?<![\d.])"
            r"([0-9]+(?:\.[0-9]+)?)"
            r"\s*%",
            line,
        )
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

    if (
        percentage < 0
        or
        percentage > 100
    ):

        return None

    return (
        percentage,
        clean_text(
            match.group(0)
        ),
        match.start(),
        match.end(),
    )


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
# PRIMARY HOLDINGS PARSER
# =============================================================================

def parse_holdings(
    section_text: str,
) -> list[dict]:
    """
    Proven primary parser.

    A holding is created only after a published percentage is encountered.

    The primary parser deliberately refuses a logical line containing more
    than one percentage because it cannot safely determine which percentage
    is the portfolio weight.
    """

    if not clean_text(
        section_text
    ):

        raise RuntimeError(
            "Top 10 holdings section is empty."
        )

    lines = pdf_lines(
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

        if len(
            holdings
        ) >= MAX_HOLDINGS:

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

            if (
                pending_fragments
                and
                pending_rank is not None
            ):

                raise RuntimeError(
                    "A new holding rank appeared before "
                    "the previous holding received a published "
                    "percentage. "
                    f"Previous rank={pending_rank}, "
                    f"new rank={detected_rank}."
                )

            if (
                pending_fragments
                and
                pending_rank is None
            ):

                raise RuntimeError(
                    "A new holding rank appeared before "
                    "the previous holding received a published "
                    "percentage."
                )

            pending_rank = detected_rank

            line = remainder

            if not line:
                continue

        percentage_info = (
            find_percentage_in_line(
                line
            )
        )

        percentage_candidates = re.findall(
            r"(?<![\d.])"
            r"([0-9]+(?:\.[0-9]+)?)"
            r"\s*%",
            line,
        )

        if len(
            percentage_candidates
        ) > 1:

            raise RuntimeError(
                "Primary parser found multiple percentages "
                "on one logical line and will not guess the "
                "holding weight. Fallback parser required."
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

    if len(
        holdings
    ) > MAX_HOLDINGS:

        raise RuntimeError(
            "Parser produced more than 10 holdings."
        )

    ranks = [
        holding["rank"]
        for holding
        in holdings
    ]

    explicit_ranks_present = any(
        holding["rank"] != position
        for position, holding
        in enumerate(
            holdings,
            start=1,
        )
    )

    if explicit_ranks_present:

        expected_ranks = list(
            range(
                1,
                len(
                    holdings
                ) + 1,
            )
        )

        if ranks != expected_ranks:

            raise RuntimeError(
                "Holding ranks are not sequential. "
                f"Parsed={ranks}; "
                f"Expected={expected_ranks}"
            )

    for holding in holdings:

        name = clean_holding_name(
            holding.get(
                "name"
            )
        )

        if not name:

            raise RuntimeError(
                "Holding name is empty."
            )

        weight = holding.get(
            "weightPercent"
        )

        if not isinstance(
            weight,
            (int, float),
        ):

            raise RuntimeError(
                "Holding weight is invalid."
            )

        if (
            weight < 0
            or
            weight > 100
        ):

            raise RuntimeError(
                "Holding weight is outside 0-100%."
            )

        holding[
            "name"
        ] = name

    return holdings


# =============================================================================
# FALLBACK HOLDINGS PARSER
# =============================================================================

def parse_holdings_fallback(
    section_text: str,
) -> list[dict]:
    """
    Proven fallback parser.

    Important difference:

        LAST percentage on a logical line = portfolio weight.

    This preserves earlier percentages that belong to fixed-income security
    names, such as coupon/rate values.
    """

    if not clean_text(
        section_text
    ):

        raise RuntimeError(
            "Top 10 holdings section is empty."
        )

    lines = pdf_lines(
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
                "Fallback parser found a published holding "
                "percentage but no holding name could be extracted."
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
                    "Fallback parser encountered a new holding "
                    "rank before the previous holding received "
                    "a published percentage."
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

        if (
            fragment
            and
            not is_holding_header_or_noise(
                fragment
            )
        ):

            pending_fragments.append(
                fragment
            )

    if not holdings:

        raise RuntimeError(
            "Fallback parser found the Top 10 holdings "
            "section but could not extract any "
            "holding/percentage pairs."
        )

    ranks = [
        holding["rank"]
        for holding
        in holdings
    ]

    expected_ranks = list(
        range(
            1,
            len(
                holdings
            ) + 1,
        )
    )

    if ranks != expected_ranks:

        raise RuntimeError(
            "Fallback holding ranks are not sequential. "
            f"Parsed={ranks}; "
            f"Expected={expected_ranks}"
        )

    for holding in holdings:

        name = clean_holding_name(
            holding.get(
                "name"
            )
        )

        weight = holding.get(
            "weightPercent"
        )

        if not name:

            raise RuntimeError(
                "Fallback holding name is empty."
            )

        if (
            not isinstance(
                weight,
                (int, float),
            )
            or
            weight < 0
            or
            weight > 100
        ):

            raise RuntimeError(
                "Fallback holding weight is invalid."
            )

        holding[
            "name"
        ] = name

    return holdings


# =============================================================================
# SPATIAL FALLBACK
# =============================================================================

def extract_holdings_spatial_fallback(
    pdf_bytes: bytes,
) -> tuple[
    list[dict],
    str,
    list[dict],
    dict,
]:
    """
    Recover Top Holdings from physical PDF layout.

    The spatial layer DOES NOT independently pair names and percentages.

    Instead:

        PDF coordinates
            |
            v
        visual Top Holdings section
            |
            v
        proven fallback parser
            |
            v
        holdings

    This is the same architecture used by the supplied working script.
    """

    positioned = _positioned_pdf_lines(
        pdf_bytes
    )

    if not positioned:

        raise RuntimeError(
            "Spatial PDF fallback could not extract "
            "positioned text."
        )

    candidates = []

    pages = sorted(
        {
            line["page"]
            for line
            in positioned
        }
    )

    for page_number in pages:

        page_lines = [
            line
            for line
            in positioned
            if line["page"]
            ==
            page_number
        ]

        if not page_lines:
            continue

        max_x = max(
            line["x1"]
            for line
            in page_lines
        )

        min_x = min(
            line["x0"]
            for line
            in page_lines
        )

        page_width = max(
            595.0,
            max_x + 20.0,
            min_x + 595.0,
        )

        headings = [
            line
            for line
            in page_lines
            if _is_spatial_top_holdings_heading(
                line["text"]
            )
        ]

        for heading in headings:

            (
                section,
                visual_lines,
            ) = _build_spatial_holdings_section(
                page_lines,
                heading,
                page_width,
            )

            if not clean_text(
                section
            ):
                continue

            try:

                holdings = parse_holdings_fallback(
                    section
                )

            except Exception as error:

                candidates.append(
                    {
                        "page":
                            page_number,

                        "heading":
                            heading,

                        "section":
                            section,

                        "visualLines":
                            visual_lines,

                        "holdings":
                            None,

                        "error":
                            clean_text(
                                str(error)
                            ),
                    }
                )

                continue

            candidates.append(
                {
                    "page":
                        page_number,

                    "heading":
                        heading,

                    "section":
                        section,

                    "visualLines":
                        visual_lines,

                    "holdings":
                        holdings,

                    "error":
                        None,
                }
            )

    valid = [
        candidate
        for candidate
        in candidates
        if candidate.get(
            "holdings"
        )
    ]

    if not valid:

        errors = [
            candidate.get(
                "error"
            )
            for candidate
            in candidates
            if candidate.get(
                "error"
            )
        ]

        detail = (
            "; ".join(
                errors[:3]
            )
            if errors
            else
            "No usable Top Holdings visual candidate was found."
        )

        raise RuntimeError(
            "Spatial PDF fallback failed: "
            f"{detail}"
        )

    valid.sort(
        key=lambda candidate: (
            len(
                candidate[
                    "holdings"
                ]
            ),
            sum(
                len(
                    item["name"]
                )
                for item
                in candidate[
                    "holdings"
                ]
            ),
        ),
        reverse=True,
    )

    selected = valid[0]

    print(
        "Spatial PDF fallback recovered Top Holdings "
        f"from page {selected['page']} with "
        f"{len(selected['holdings'])} holdings."
    )

    diagnostics = {
        "candidateCount":
            len(candidates),

        "validCandidateCount":
            len(valid),

        "selectedPage":
            selected.get(
                "page"
            ),

        "candidates":
            [
                {
                    "page":
                        candidate.get(
                            "page"
                        ),

                    "section":
                        candidate.get(
                            "section"
                        ),

                    "holdings":
                        candidate.get(
                            "holdings"
                        ),

                    "error":
                        candidate.get(
                            "error"
                        ),
                }
                for candidate
                in candidates
            ],
    }

    return (
        selected[
            "holdings"
        ],
        selected[
            "section"
        ],
        selected[
            "visualLines"
        ],
        diagnostics,
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
# EXTRACTION ENGINE
# =============================================================================

def extract_holdings_with_proven_engine(
    factsheet_bytes: bytes,
) -> dict:
    """
    Run the same parser sequence as the supplied working script.

    Returns a complete extraction diagnostic.

    No candidate-ranking by name/percentage proximity is used.
    """

    (
        full_text,
        pdf_page_count,
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
        ==
        "not_published"
    ):

        return {
            "status":
                "no_holdings_section",

            "fullText":
                full_text,

            "pdfPageCount":
                pdf_page_count,

            "sectionText":
                "",

            "holdings":
                [],

            "holdingsParser":
                None,

            "holdingsSectionExtraction":
                "pdf_text",

            "primaryParserError":
                None,

            "fallbackParserError":
                None,

            "spatialDiagnostics":
                None,

            "spatialVisualLines":
                [],
        }

    parser_used = "primary"

    primary_parser_error = None

    fallback_parser_error = None

    selected_section_text = (
        section_text
    )

    spatial_visual_lines = []

    spatial_diagnostics = None

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

            parser_used = "fallback"

        except Exception as fallback_error:

            fallback_parser_error = clean_text(
                str(fallback_error)
            )

            print(
                "Text fallback parser failed; "
                "running spatial PDF fallback..."
            )

            print(
                f"Text fallback parser error: "
                f"{fallback_parser_error}"
            )

            (
                holdings,
                selected_section_text,
                spatial_visual_lines,
                spatial_diagnostics,
            ) = extract_holdings_spatial_fallback(
                factsheet_bytes
            )

            parser_used = "spatial_fallback"

    return {
        "status":
            "success",

        "fullText":
            full_text,

        "pdfPageCount":
            pdf_page_count,

        "sectionText":
            selected_section_text,

        "holdings":
            holdings,

        "holdingsParser":
            parser_used,

        "holdingsSectionExtraction":
            (
                "pdf_coordinates"
                if parser_used == "spatial_fallback"
                else "pdf_text"
            ),

        "primaryParserError":
            primary_parser_error,

        "fallbackParserError":
            fallback_parser_error,

        "spatialDiagnostics":
            spatial_diagnostics,

        "spatialVisualLines":
            spatial_visual_lines,
    }


# =============================================================================
# HOLDING SIGNATURE
# =============================================================================

def holding_signature(
    holdings: list[dict],
) -> list[tuple]:
    """
    Exact normalized signature.

    This is used for final verification.

    There is no fuzzy matching.
    """

    signature = []

    for item in holdings:

        try:

            rank = int(
                item.get(
                    "rank",
                    0,
                )
            )

            name = clean_text(
                item.get(
                    "name"
                )
            )

            weight = float(
                item.get(
                    "weightPercent"
                )
            )

        except Exception as error:

            raise RuntimeError(
                "Invalid holding encountered while "
                f"building verification signature: {error}"
            ) from error

        signature.append(
            (
                rank,
                name,
                weight,
            )
        )

    return signature


# =============================================================================
# SINGLE FAILED FUND
# =============================================================================

def extract_single_failed_fund(
    page,
    excel_fund: dict,
) -> dict:
    """
    Extract one failed fund using the proven parser engine.
    """

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
        f"RECOVERING FAILED FUND ROW {excel_row}"
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

    # -------------------------------------------------------------------------
    # Open official Prudential page.
    # -------------------------------------------------------------------------

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

    # -------------------------------------------------------------------------
    # Fund name.
    # -------------------------------------------------------------------------

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

    # -------------------------------------------------------------------------
    # Factsheet.
    # -------------------------------------------------------------------------

    factsheet_url = find_factsheet_url(
        page,
        prudential_url,
    )

    factsheet_bytes = download_factsheet(
        page,
        factsheet_url,
    )

    # -------------------------------------------------------------------------
    # Proven extraction engine.
    # -------------------------------------------------------------------------

    extraction = (
        extract_holdings_with_proven_engine(
            factsheet_bytes
        )
    )

    if (
        extraction["status"]
        ==
        "no_holdings_section"
    ):

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
                pruaccess_name,

            "factsheetUrl":
                factsheet_url,

            "factsheetDocumentDate":
                extract_document_date(
                    extraction[
                        "fullText"
                    ]
                ),

            "factsheetDataAsAt":
                extract_data_as_at(
                    extraction[
                        "fullText"
                    ]
                ),

            "factsheetPageCount":
                extraction[
                    "pdfPageCount"
                ],

            "holdingsSectionStatus":
                "not_published",

            "topHoldingsCount":
                0,

            "topHoldings":
                [],

            "holdingsParser":
                None,

            "holdingsSectionExtraction":
                extraction[
                    "holdingsSectionExtraction"
                ],

            "primaryParserError":
                None,

            "fallbackParserError":
                None,

            "spatialDiagnostics":
                None,

            "spatialVisualLines":
                [],
        }

    holdings = extraction[
        "holdings"
    ]

    if not holdings:

        raise RuntimeError(
            "Extraction engine returned success "
            "but no holdings."
        )

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
            extract_document_date(
                extraction[
                    "fullText"
                ]
            ),

        "factsheetDataAsAt":
            extract_data_as_at(
                extraction[
                    "fullText"
                ]
            ),

        "factsheetPageCount":
            extraction[
                "pdfPageCount"
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
            extraction[
                "holdingsParser"
            ],

        "holdingsSectionExtraction":
            extraction[
                "holdingsSectionExtraction"
            ],

        "primaryParserError":
            extraction[
                "primaryParserError"
            ],

        "fallbackParserError":
            extraction[
                "fallbackParserError"
            ],

        "spatialDiagnostics":
            extraction[
                "spatialDiagnostics"
            ],

        "spatialVisualLines":
            extraction[
                "spatialVisualLines"
            ],

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

            "percentageDefinesHoldingBoundary":
                True,

            "automaticFallbackParser":
                True,

            "fallbackUsesLastPercentageOnLogicalLine":
                True,

            "spatialPdfFallback":
                True,

            "spatialFallbackUsesOfficialPdfCoordinates":
                True,

            "spatialFallbackOnlyAfterTextParsersFail":
                True,

            "noProximityNameWeightMatching":
                True,
        },
    }

    return {
        "result":
            result,

        "factsheetBytes":
            factsheet_bytes,

        "fullText":
            extraction[
                "fullText"
            ],

        "sectionText":
            extraction[
                "sectionText"
            ],
    }


# =============================================================================
# FINAL OFFICIAL PDF VERIFICATION
# =============================================================================

def verify_extraction_against_same_official_pdf_engine(
    page,
    result: dict,
) -> dict:
    """
    Final verification.

    The official factsheet is downloaded again.

    The SAME proven extraction engine is run again.

    The original and verification holdings must have identical:

        rank
        name
        published weight

    No name/percentage proximity matching is used.

    This prevents a transient or parser-state result from being accepted.
    """

    factsheet_url = ensure_prudential_url(
        result[
            "factsheetUrl"
        ]
    )

    print(
        "\n"
        "Final official PDF verification..."
    )

    response = page.request.get(
        factsheet_url,
        timeout=FACTSHEET_DOWNLOAD_TIMEOUT_MS,
    )

    if response.status != 200:

        raise RuntimeError(
            "Final factsheet verification returned "
            f"HTTP {response.status}."
        )

    factsheet_bytes = response.body()

    if not factsheet_bytes.startswith(
        b"%PDF"
    ):

        raise RuntimeError(
            "Final factsheet verification did not "
            "return a PDF."
        )

    extraction = (
        extract_holdings_with_proven_engine(
            factsheet_bytes
        )
    )

    if (
        extraction["status"]
        !=
        "success"
    ):

        raise RuntimeError(
            "Final official PDF verification could not "
            "recover a published Top Holdings section."
        )

    original_holdings = result.get(
        "topHoldings",
        [],
    )

    verified_holdings = extraction[
        "holdings"
    ]

    original_signature = holding_signature(
        original_holdings
    )

    verified_signature = holding_signature(
        verified_holdings
    )

    if len(
        verified_holdings
    ) != result[
        "topHoldingsCount"
    ]:

        raise RuntimeError(
            "Holding count changed during final official "
            "PDF verification. "
            f"Original={result['topHoldingsCount']}; "
            f"Verified={len(verified_holdings)}."
        )

    if (
        verified_signature
        !=
        original_signature
    ):

        raise RuntimeError(
            "Holding names or published weights changed "
            "during final official PDF verification.\n"
            f"Original={original_signature}\n"
            f"Verified={verified_signature}"
        )

    return {
        "verified":
            True,

        "factsheetBytes":
            factsheet_bytes,

        "fullText":
            extraction[
                "fullText"
            ],

        "sectionText":
            extraction[
                "sectionText"
            ],

        "verifiedHoldings":
            verified_holdings,

        "verifiedParser":
            extraction[
                "holdingsParser"
            ],

        "verifiedExtractionMode":
            extraction[
                "holdingsSectionExtraction"
            ],

        "verifiedPrimaryParserError":
            extraction[
                "primaryParserError"
            ],

        "verifiedFallbackParserError":
            extraction[
                "fallbackParserError"
            ],

        "verifiedSpatialDiagnostics":
            extraction[
                "spatialDiagnostics"
            ],

        "verifiedSpatialVisualLines":
            extraction[
                "spatialVisualLines"
            ],
    }


# =============================================================================
# SAVE RECOVERY SUCCESS
# =============================================================================

def save_recovery_success(
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

    parsed = urlparse(
        result.get(
            "finalUrl"
        )
        or
        result.get(
            "prudentialUrl"
        )
    )

    identifier = safe_filename(
        parsed.path.rstrip(
            "/"
        ).split(
            "/"
        )[-1]
        or
        result.get(
            "fundName"
        )
        or
        f"fund_{excel_row}"
    )

    directory = (
        RECOVERY_FUNDS_OUTPUT_DIR
        /
        f"{excel_row}_{identifier}"
    )

    directory.mkdir(
        parents=True,
        exist_ok=True,
    )

    (
        directory
        /
        "factsheet.pdf"
    ).write_bytes(
        factsheet_bytes
    )

    (
        directory
        /
        "factsheet_text.txt"
    ).write_text(
        full_text,
        encoding="utf-8",
    )

    (
        directory
        /
        "top_holdings_section.txt"
    ).write_text(
        section_text,
        encoding="utf-8",
    )

    save_json(
        directory
        /
        "top_holdings.json",
        result,
    )

    if result.get(
        "spatialVisualLines"
    ):

        save_json(
            directory
            /
            "pdf_visual_lines.json",
            result[
                "spatialVisualLines"
            ],
        )

    diagnostics = {
        "excelRow":
            result.get(
                "excelRow"
            ),

        "fundName":
            result.get(
                "fundName"
            ),

        "holdingsParser":
            result.get(
                "holdingsParser"
            ),

        "holdingsSectionExtraction":
            result.get(
                "holdingsSectionExtraction"
            ),

        "primaryParserError":
            result.get(
                "primaryParserError"
            ),

        "fallbackParserError":
            result.get(
                "fallbackParserError"
            ),

        "spatialDiagnostics":
            result.get(
                "spatialDiagnostics"
            ),

        "topHoldingsCount":
            result.get(
                "topHoldingsCount"
            ),

        "topHoldings":
            result.get(
                "topHoldings"
            ),

        "finalVerification":
            result.get(
                "finalVerification"
            ),

        "savedAtUtc":
            utc_now_iso(),
    }

    save_json(
        directory
        /
        "recovery_diagnostics.json",
        diagnostics,
    )

    metadata = {
        "excelRow":
            excel_row,

        "fundName":
            result.get(
                "fundName"
            ),

        "prudentialUrl":
            result.get(
                "prudentialUrl"
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

        "status":
            result.get(
                "status"
            ),

        "recoveryVerified":
            True,

        "savedAtUtc":
            utc_now_iso(),
    }

    save_json(
        directory
        /
        "metadata.json",
        metadata,
    )

    return directory


# =============================================================================
# SAVE RECOVERY FAILURE
# =============================================================================

def save_recovery_failure(
    excel_fund: dict,
    error_text: str,
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

        "baselineFailure":
            excel_fund.get(
                "baselineFailure"
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
        /
        "failure.json",
        failure,
    )

    if diagnostics is not None:

        save_json(
            directory
            /
            "recovery_diagnostics.json",
            diagnostics,
        )

    return directory


# =============================================================================
# RECOVERY FUND PROCESS
# =============================================================================

def process_recovery_fund(
    page,
    excel_fund: dict,
) -> tuple[
    dict | None,
    dict,
]:

    last_error = None

    diagnostics = {
        "excelRow":
            excel_fund[
                "excelRow"
            ],

        "baselineFailure":
            excel_fund.get(
                "baselineFailure"
            ),

        "attempts":
            [],
    }

    for attempt in range(
        1,
        RETRY_COUNT + 1,
    ):

        attempt_diagnostic = {
            "attempt":
                attempt,

            "status":
                "started",
        }

        try:

            print(
                "\n"
                f"Recovery attempt "
                f"{attempt}/{RETRY_COUNT}"
            )

            extracted = (
                extract_single_failed_fund(
                    page,
                    excel_fund,
                )
            )

            # -------------------------------------------------------------
            # A no-holdings-section result is valid only if the official
            # factsheet genuinely contains no Top Holdings heading.
            # -------------------------------------------------------------

            if (
                extracted.get(
                    "status"
                )
                ==
                "no_holdings_section"
            ):

                result = extracted

                attempt_diagnostic[
                    "status"
                ] = "no_holdings_section"

                diagnostics[
                    "attempts"
                ].append(
                    attempt_diagnostic
                )

                return (
                    result,
                    diagnostics,
                )

            result = extracted[
                "result"
            ]

            attempt_diagnostic[
                "initialParser"
            ] = result.get(
                "holdingsParser"
            )

            attempt_diagnostic[
                "initialCount"
            ] = result.get(
                "topHoldingsCount"
            )

            attempt_diagnostic[
                "initialHoldings"
            ] = result.get(
                "topHoldings"
            )

            # -------------------------------------------------------------
            # Final official PDF verification.
            # -------------------------------------------------------------

            verification = (
                verify_extraction_against_same_official_pdf_engine(
                    page,
                    result,
                )
            )

            result[
                "topHoldings"
            ] = verification[
                "verifiedHoldings"
            ]

            result[
                "topHoldingsCount"
            ] = len(
                verification[
                    "verifiedHoldings"
                ]
            )

            result[
                "holdingsParser"
            ] = verification[
                "verifiedParser"
            ]

            result[
                "holdingsSectionExtraction"
            ] = verification[
                "verifiedExtractionMode"
            ]

            result[
                "primaryParserError"
            ] = verification[
                "verifiedPrimaryParserError"
            ]

            result[
                "fallbackParserError"
            ] = verification[
                "verifiedFallbackParserError"
            ]

            result[
                "spatialDiagnostics"
            ] = verification[
                "verifiedSpatialDiagnostics"
            ]

            result[
                "spatialVisualLines"
            ] = verification[
                "verifiedSpatialVisualLines"
            ]

            result[
                "finalVerification"
            ] = {
                "verified":
                    True,

                "verificationMethod":
                    "same_official_pdf_extraction_engine",

                "nameWeightProximityMatching":
                    False,

                "verifiedAtUtc":
                    utc_now_iso(),
            }

            attempt_diagnostic[
                "status"
            ] = "success"

            attempt_diagnostic[
                "verifiedParser"
            ] = result.get(
                "holdingsParser"
            )

            attempt_diagnostic[
                "verifiedCount"
            ] = result.get(
                "topHoldingsCount"
            )

            attempt_diagnostic[
                "verifiedHoldings"
            ] = result.get(
                "topHoldings"
            )

            diagnostics[
                "attempts"
            ].append(
                attempt_diagnostic
            )

            return (
                {
                    "result":
                        result,

                    "factsheetBytes":
                        verification[
                            "factsheetBytes"
                        ],

                    "fullText":
                        verification[
                            "fullText"
                        ],

                    "sectionText":
                        verification[
                            "sectionText"
                        ],
                },
                diagnostics,
            )

        except Exception as error:

            last_error = clean_text(
                str(error)
            )

            attempt_diagnostic[
                "status"
            ] = "failed"

            attempt_diagnostic[
                "error"
            ] = last_error

            diagnostics[
                "attempts"
            ].append(
                attempt_diagnostic
            )

            print(
                "Recovery attempt failed:"
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

    raise RuntimeError(
        last_error
        or
        "Unknown recovery failure."
    )


# =============================================================================
# MAIN
# =============================================================================

def main() -> int:

    RECOVERY_OUTPUT_DIR.mkdir(
        parents=True,
        exist_ok=True,
    )

    RECOVERY_FUNDS_OUTPUT_DIR.mkdir(
        parents=True,
        exist_ok=True,
    )

    started_at = utc_now_iso()

    print(
        "\n"
        "################################################################"
    )

    print(
        "VGRAT FMS - PRUDENTIAL FAILED-FUND HOLDINGS RECOVERY"
    )

    print(
        "################################################################"
    )

    print(
        f"Started UTC: {started_at}"
    )

    print(
        "\n"
        "IMPORTANT:"
    )

    print(
        "Frozen baseline will NOT be modified."
    )

    print(
        "test_pruaccess.py will NOT be modified."
    )

    print(
        "Only baseline failedFundsDetail will be processed."
    )

    print(
        "No proximity-based name/weight matching is used."
    )

    # -------------------------------------------------------------------------
    # Load frozen baseline.
    # -------------------------------------------------------------------------

    baseline = load_baseline_run_summary()

    print(
        "\n"
        "Frozen baseline:"
    )

    print(
        f"Status: "
        f"{baseline.get('status')}"
    )

    print(
        f"Excel fund universe: "
        f"{baseline.get('excelFundUniverse')}"
    )

    print(
        f"Successful funds: "
        f"{baseline.get('successfulFunds')}"
    )

    print(
        f"Failed funds: "
        f"{baseline.get('failedFunds')}"
    )

    # -------------------------------------------------------------------------
    # Load Excel.
    # -------------------------------------------------------------------------

    excel_funds = read_excel_funds()

    recovery_universe = build_recovery_universe(
        baseline,
        excel_funds,
    )

    print(
        "\n"
        "Recovery universe:"
    )

    print(
        f"Failed funds from frozen baseline: "
        f"{len(recovery_universe)}"
    )

    if not recovery_universe:

        completed_at = utc_now_iso()

        summary = {
            "status":
                "nothing_to_recover",

            "startedAtUtc":
                started_at,

            "completedAtUtc":
                completed_at,

            "baselineRunSummary":
                str(
                    BASELINE_RUN_SUMMARY_FILE
                ),

            "excelFile":
                str(
                    EXCEL_FILE
                ),

            "baselineExcelFundUniverse":
                baseline.get(
                    "excelFundUniverse"
                ),

            "baselineSuccessfulFunds":
                baseline.get(
                    "successfulFunds"
                ),

            "baselineFailedFunds":
                baseline.get(
                    "failedFunds"
                ),

            "recoveryUniverse":
                0,

            "recoveredFunds":
                0,

            "stillFailedFunds":
                0,

            "recoveredFundsDetail":
                [],

            "stillFailedFundsDetail":
                [],

            "rules": {
                "frozenBaselineUntouched":
                    True,

                "testPrudentialHoldingsUntouched":
                    True,

                "testPruaccessUntouched":
                    True,

                "failedFundsDetailIsExclusiveRecoveryUniverse":
                    True,

                "officialPrudentialOnly":
                    True,

                "noThirdPartyHoldings":
                    True,

                "noInferredHoldings":
                    True,

                "noFabricatedPercentages":
                    True,

                "noProximityNameWeightMatching":
                    True,
            },
        }

        save_json(
            RECOVERY_RUN_SUMMARY_FILE,
            summary,
        )

        print(
            "\nNo failed funds require recovery."
        )

        return 0

    print(
        "\nFunds selected for recovery:"
    )

    for fund in recovery_universe:

        print(
            f" - Row "
            f"{fund['excelRow']}: "
            f"{fund['pruAccessName'] or '-'}"
        )

    recovered = []

    still_failed = []

    # -------------------------------------------------------------------------
    # Browser.
    # -------------------------------------------------------------------------

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
                recovery_universe
            )

            for index, excel_fund in enumerate(
                recovery_universe,
                start=1,
            ):

                print(
                    "\n"
                    + "=" * 72
                )

                print(
                    f"RECOVERY FUND {index}/{total}"
                )

                print(
                    f"Excel row: "
                    f"{excel_fund['excelRow']}"
                )

                print(
                    "=" * 72
                )

                diagnostics = None

                try:

                    (
                        recovered_package,
                        diagnostics,
                    ) = process_recovery_fund(
                        page,
                        excel_fund,
                    )

                    if (
                        recovered_package
                        is None
                    ):

                        raise RuntimeError(
                            "Recovery returned no result."
                        )

                    # ---------------------------------------------------------
                    # Valid no-holdings-section case.
                    # ---------------------------------------------------------

                    if (
                        recovered_package.get(
                            "status"
                        )
                        ==
                        "no_holdings_section"
                    ):

                        result = recovered_package

                        row = int(
                            result[
                                "excelRow"
                            ]
                        )

                        directory = (
                            RECOVERY_FUNDS_OUTPUT_DIR
                            /
                            f"{row}_"
                            f"{safe_filename(result.get('fundName') or 'fund')}"
                        )

                        directory.mkdir(
                            parents=True,
                            exist_ok=True,
                        )

                        save_json(
                            directory
                            /
                            "top_holdings.json",
                            result,
                        )

                        save_json(
                            directory
                            /
                            "recovery_diagnostics.json",
                            diagnostics,
                        )

                        metadata = {
                            "excelRow":
                                row,

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

                            "recoveryVerified":
                                True,

                            "savedAtUtc":
                                utc_now_iso(),
                        }

                        save_json(
                            directory
                            /
                            "metadata.json",
                            metadata,
                        )

                        recovered.append(
                            {
                                "result":
                                    result,

                                "outputDirectory":
                                    str(
                                        directory
                                    ),

                                "recoveryType":
                                    "no_holdings_section",
                            }
                        )

                        print(
                            "\nRECOVERED:"
                        )

                        print(
                            f"Row {row}: "
                            "official factsheet has no "
                            "Top Holdings section."
                        )

                        continue

                    # ---------------------------------------------------------
                    # Normal successful holdings result.
                    # ---------------------------------------------------------

                    result = recovered_package[
                        "result"
                    ]

                    directory = save_recovery_success(
                        result=result,
                        factsheet_bytes=recovered_package[
                            "factsheetBytes"
                        ],
                        full_text=recovered_package[
                            "fullText"
                        ],
                        section_text=recovered_package[
                            "sectionText"
                        ],
                    )

                    recovered.append(
                        {
                            "result":
                                result,

                            "outputDirectory":
                                str(
                                    directory
                                ),

                            "recoveryType":
                                "holdings",
                        }
                    )

                    print(
                        "\nRECOVERED:"
                    )

                    print(
                        f"Row {result['excelRow']}: "
                        f"{result.get('fundName') or '-'}"
                    )

                    print(
                        f"Parser: "
                        f"{result.get('holdingsParser')}"
                    )

                    print(
                        f"Holdings: "
                        f"{result.get('topHoldingsCount')}"
                    )

                    print(
                        "Final verification: PASSED"
                    )

                    for holding in result[
                        "topHoldings"
                    ]:

                        print(
                            f"  {holding['rank']}. "
                            f"{holding['name']} - "
                            f"{holding['weightText']}"
                        )

                except Exception as error:

                    error_text = clean_text(
                        str(error)
                    )

                    failure_directory = (
                        save_recovery_failure(
                            excel_fund,
                            error_text,
                            diagnostics,
                        )
                    )

                    still_failed.append(
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

                            "baselineFailure":
                                excel_fund.get(
                                    "baselineFailure"
                                ),

                            "error":
                                error_text,

                            "outputDirectory":
                                str(
                                    failure_directory
                                ),
                        }
                    )

                    print(
                        "\nSTILL FAILED:"
                    )

                    print(
                        f"Row "
                        f"{excel_fund['excelRow']}: "
                        f"{error_text}"
                    )

        finally:

            context.close()

            browser.close()

    # =========================================================================
    # SUMMARY
    # =========================================================================

    completed_at = utc_now_iso()

    recovered_holdings_funds = [
        item
        for item
        in recovered
        if item.get(
            "recoveryType"
        )
        ==
        "holdings"
    ]

    recovered_no_section = [
        item
        for item
        in recovered
        if item.get(
            "recoveryType"
        )
        ==
        "no_holdings_section"
    ]

    total_recovered_holdings = sum(
        int(
            item[
                "result"
            ].get(
                "topHoldingsCount",
                0,
            )
            or 0
        )
        for item
        in recovered_holdings_funds
    )

    recovery_status = (
        "success"
        if not still_failed
        else
        (
            "partial"
            if recovered
            else
            "failed"
        )
    )

    run_summary = {
        "status":
            recovery_status,

        "startedAtUtc":
            started_at,

        "completedAtUtc":
            completed_at,

        "baselineRunSummary":
            str(
                BASELINE_RUN_SUMMARY_FILE
            ),

        "excelFile":
            str(
                EXCEL_FILE
            ),

        "baselineStatus":
            baseline.get(
                "status"
            ),

        "baselineExcelFundUniverse":
            baseline.get(
                "excelFundUniverse"
            ),

        "baselineSuccessfulFunds":
            baseline.get(
                "successfulFunds"
            ),

        "baselineFailedFunds":
            baseline.get(
                "failedFunds"
            ),

        "recoveryUniverse":
            len(
                recovery_universe
            ),

        "recoveredFunds":
            len(
                recovered
            ),

        "recoveredFundsWithHoldings":
            len(
                recovered_holdings_funds
            ),

        "recoveredNoHoldingsSectionFunds":
            len(
                recovered_no_section
            ),

        "stillFailedFunds":
            len(
                still_failed
            ),

        "totalRecoveredPublishedTopHoldings":
            total_recovered_holdings,

        "recoveredFundsDetail":
            [
                {
                    "excelRow":
                        item[
                            "result"
                        ].get(
                            "excelRow"
                        ),

                    "fundName":
                        item[
                            "result"
                        ].get(
                            "fundName"
                        ),

                    "factsheetUrl":
                        item[
                            "result"
                        ].get(
                            "factsheetUrl"
                        ),

                    "holdingsParser":
                        item[
                            "result"
                        ].get(
                            "holdingsParser"
                        ),

                    "holdingsSectionExtraction":
                        item[
                            "result"
                        ].get(
                            "holdingsSectionExtraction"
                        ),

                    "topHoldingsCount":
                        item[
                            "result"
                        ].get(
                            "topHoldingsCount"
                        ),

                    "topHoldings":
                        item[
                            "result"
                        ].get(
                            "topHoldings"
                        ),

                    "finalVerification":
                        item[
                            "result"
                        ].get(
                            "finalVerification"
                        ),

                    "outputDirectory":
                        item.get(
                            "outputDirectory"
                        ),

                    "recoveryType":
                        item.get(
                            "recoveryType"
                        ),
                }
                for item
                in recovered
            ],

        "stillFailedFundsDetail":
            still_failed,

        "rules": {
            "frozenBaselineUntouched":
                True,

            "testPrudentialHoldingsUntouched":
                True,

            "testPruaccessUntouched":
                True,

            "failedFundsDetailIsExclusiveRecoveryUniverse":
                True,

            "excelColumnAControlsMasterUniverse":
                True,

            "officialPrudentialFactsheetOnly":
                True,

            "officialPrudentialSingaporeOnly":
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

            "duplicateHoldingNamesAllowed":
                True,

            "duplicateHoldingPercentagesAllowed":
                True,

            "multilineHoldingNamesSupported":
                True,

            "wrappedPdfLinesJoined":
                True,

            "percentageDefinesHoldingBoundary":
                True,

            "automaticFallbackParser":
                True,

            "fallbackUsesLastPercentageOnLogicalLine":
                True,

            "spatialPdfFallback":
                True,

            "spatialFallbackUsesOfficialPdfCoordinates":
                True,

            "spatialFallbackOnlyAfterTextParsersFail":
                True,

            "noThirdPartyHoldings":
                True,

            "noProximityNameWeightMatching":
                True,

            "finalVerificationUsesSameOfficialPdfEngine":
                True,

            "finalVerificationRequiresExactSignature":
                True,
        },
    }

    save_json(
        RECOVERY_RUN_SUMMARY_FILE,
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
        "PRUDENTIAL FAILED-FUND HOLDINGS RECOVERY COMPLETE"
    )

    print(
        "=" * 78
    )

    print(
        f"Frozen baseline universe: "
        f"{baseline.get('excelFundUniverse')}"
    )

    print(
        f"Baseline successful: "
        f"{baseline.get('successfulFunds')}"
    )

    print(
        f"Baseline failed: "
        f"{baseline.get('failedFunds')}"
    )

    print(
        f"Recovery universe: "
        f"{len(recovery_universe)}"
    )

    print(
        f"Recovered: "
        f"{len(recovered)}"
    )

    print(
        f"Recovered with holdings: "
        f"{len(recovered_holdings_funds)}"
    )

    print(
        f"Recovered with no holdings section: "
        f"{len(recovered_no_section)}"
    )

    print(
        f"Still failed: "
        f"{len(still_failed)}"
    )

    print(
        f"Total recovered published holdings: "
        f"{total_recovered_holdings}"
    )

    print(
        "\nExtraction engine:"
    )

    print(
        " - Primary PDF text parser"
    )

    print(
        " - Text fallback parser"
    )

    print(
        " - Spatial PDF fallback"
    )

    print(
        " - Same parser re-run during final verification"
    )

    print(
        " - Exact rank/name/weight signature verification"
    )

    print(
        "\nProhibited:"
    )

    print(
        " - No name/percentage proximity matching"
    )

    print(
        " - No fuzzy holding matching"
    )

    print(
        " - No fabricated percentages"
    )

    print(
        " - No inferred holdings"
    )

    print(
        " - No third-party holdings"
    )

    print(
        "\nOutput:"
    )

    print(
        f" - {RECOVERY_RUN_SUMMARY_FILE}"
    )

    print(
        f" - {RECOVERY_FUNDS_OUTPUT_DIR}"
    )

    if recovered:

        print(
            "\nRECOVERED FUNDS:"
        )

        for item in recovered:

            result = item[
                "result"
            ]

            print(
                f" - Row "
                f"{result.get('excelRow')}: "
                f"{result.get('fundName') or '-'} "
                f"("
                f"{result.get('topHoldingsCount', 0)} holdings"
                f")"
            )

    if still_failed:

        print(
            "\nSTILL FAILED FUNDS:"
        )

        for failure in still_failed:

            print(
                f" - Row "
                f"{failure['excelRow']}: "
                f"{failure['error']}"
            )

    print(
        "\nDone."
    )

    # -------------------------------------------------------------------------
    # IMPORTANT:
    #
    # Partial recovery is a valid test result. Therefore the script returns
    # zero even when some funds remain failed. GitHub Actions can then upload
    # the diagnostics artifact instead of treating a legitimate recovery
    # result as a workflow crash.
    # -------------------------------------------------------------------------

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

    except Exception as error:

        print(
            "\nFATAL RECOVERY ERROR:",
            file=sys.stderr,
        )

        print(
            clean_text(
                str(error)
            ),
            file=sys.stderr,
        )

        raise SystemExit(
            1
        )
