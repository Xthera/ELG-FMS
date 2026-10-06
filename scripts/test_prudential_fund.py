#!/usr/bin/env python3

"""
VGrat FMS - Prudential ALL-FUND INFORMATION CAPTURE

MASTER SOURCE
=============

Funds Links.xlsm

Column A:
    Prudential fund URL

Column B:
    Exact PruAccess fund name


PURPOSE
=======

Capture ALL AVAILABLE PUBLIC PRUDENTIAL FUND INFORMATION
fund-by-fund.

This script is intentionally designed as a RAW CAPTURE LAYER.

It does NOT depend only on:

    ilpfunds.json
    ilpseries.json

Instead it captures:

    - every JSON response
    - every JSON-like API response
    - every Prudential API/network response that can be read
    - ilpfunds.json
    - ilpseries.json
    - rendered HTML
    - visible text
    - request metadata
    - response metadata
    - response headers
    - discovered document URLs
    - discovered Prudential URLs
    - generic extracted fund information

The raw Prudential responses are preserved.

Later scripts such as build_funds_data.py can parse these
raw captures into the final VGrat FMS schema.

WORKFLOW
========

Funds Links.xlsm
        |
        v
Read every populated URL in Column A
        |
        v
Open one Prudential fund page
        |
        +---- Capture ALL network requests
        |
        +---- Capture ALL network responses
        |
        +---- Capture JSON
        |
        +---- Capture API responses
        |
        +---- Capture HTML
        |
        +---- Capture visible text
        |
        +---- Discover documents
        |
        v
Save EVERYTHING for that fund
        |
        v
Next fund


OUTPUT
======

output_prudential_json/
    run_summary.json

    funds/
        001_row_2_<fund name>/
            fund_info.json

            page.json
            rendered.html
            visible_text.txt

            requests.json
            responses.json
            discovered_urls.json

            json/
                response_001.json
                response_002.json
                ...

            important/
                ilpfunds_001.json
                ilpseries_001.json
                ...

            extracted_fund_info.json
            summary.json

        002_row_3_<fund name>/
            ...


IMPORTANT DESIGN RULE
=====================

RAW CAPTURE FIRST.

Do not rely on the parsed/extracted fields as the source of truth.

The raw Prudential responses remain available for later parsing.
"""


import asyncio
import json
import re
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urljoin, urlparse

from openpyxl import load_workbook
from playwright.async_api import async_playwright


# ============================================================
# CONFIGURATION
# ============================================================

EXCEL_FILE = Path("Funds Links.xlsm")

OUTPUT_DIR = Path("output_prudential_json")
FUNDS_OUTPUT_DIR = OUTPUT_DIR / "funds"

PAGE_TIMEOUT_MS = 120000
JAVASCRIPT_WAIT_MS = 15000
LAZY_LOAD_WAIT_MS = 5000
DELAY_BETWEEN_FUNDS_MS = 1000

# Additional waiting after scrolling.
SECONDARY_WAIT_MS = 3000

# Capture only reasonably sized response bodies.
# This prevents a very large binary response from consuming
# excessive memory.
MAX_RESPONSE_BODY_BYTES = 25 * 1024 * 1024

# These are important, but are NOT the complete capture list.
IMPORTANT_PARTS = [
    "ilpfunds.json",
    "ilpseries.json",
]

# Content types which are useful for the raw information layer.
JSON_CONTENT_TYPES = [
    "application/json",
    "application/ld+json",
    "text/json",
]

TEXT_CONTENT_TYPES = [
    "text/plain",
    "text/html",
    "application/xhtml+xml",
    "application/json",
    "application/ld+json",
    "text/json",
]

DOCUMENT_EXTENSIONS = [
    ".pdf",
    ".xlsx",
    ".xls",
    ".csv",
    ".doc",
    ".docx",
]


# ============================================================
# GENERAL HELPERS
# ============================================================

def utc_now():
    return datetime.now(timezone.utc).isoformat()


def safe_filename(value):
    value = str(value or "").strip()

    if not value:
        return "unnamed"

    value = re.sub(
        r'[<>:"/\\|?*]',
        "_",
        value
    )

    value = re.sub(
        r"\s+",
        " ",
        value
    )

    value = value.strip(" .")

    if not value:
        return "unnamed"

    return value[:120]


def save_json(path, data):
    path.parent.mkdir(
        parents=True,
        exist_ok=True
    )

    path.write_text(
        json.dumps(
            data,
            indent=2,
            ensure_ascii=False
        ),
        encoding="utf-8"
    )


def save_text(path, text):
    path.parent.mkdir(
        parents=True,
        exist_ok=True
    )

    path.write_text(
        text or "",
        encoding="utf-8"
    )


def normalize_text(value):
    if value is None:
        return None

    if isinstance(value, str):
        value = re.sub(
            r"\s+",
            " ",
            value
        ).strip()

        return value or None

    return value


def is_json_content_type(content_type):
    content_type = (
        content_type or ""
    ).lower()

    return any(
        value in content_type
        for value in JSON_CONTENT_TYPES
    )


def is_text_content_type(content_type):
    content_type = (
        content_type or ""
    ).lower()

    return any(
        value in content_type
        for value in TEXT_CONTENT_TYPES
    )


def is_document_url(url):
    lower_url = (
        url or ""
    ).lower()

    parsed = urlparse(lower_url)

    path = parsed.path

    return any(
        path.endswith(extension)
        for extension in DOCUMENT_EXTENSIONS
    )


def is_prudential_url(url):
    if not url:
        return False

    hostname = (
        urlparse(url)
        .hostname
        or ""
    ).lower()

    return (
        hostname.endswith(
            "prudential.com.sg"
        )
        or hostname.endswith(
            "prudential.com"
        )
    )


def url_basename(url):
    try:
        path = urlparse(url).path

        name = Path(path).name

        if name:
            return name

    except Exception:
        pass

    return ""


def response_is_interesting(
    url,
    content_type,
    resource_type
):
    """
    Decide whether a network response should have its body
    captured.

    IMPORTANT:

    This is deliberately broad.

    We do not only capture ilpfunds.json / ilpseries.json.
    """

    lower_url = (
        url or ""
    ).lower()

    lower_content_type = (
        content_type or ""
    ).lower()

    lower_resource_type = (
        resource_type or ""
    ).lower()

    # Explicit important Prudential JSON.
    if any(
        part.lower() in lower_url
        for part in IMPORTANT_PARTS
    ):
        return True

    # JSON content.
    if is_json_content_type(
        lower_content_type
    ):
        return True

    # Fetch/XHR frequently carries the fund data.
    if lower_resource_type in (
        "xhr",
        "fetch"
    ):
        return True

    # URLs which strongly suggest API/data content.
    data_keywords = [
        "api",
        ".json",
        "fund",
        "funds",
        "price",
        "performance",
        "dividend",
        "distribution",
        "series",
        "valuation",
        "investment",
        "asset",
        "risk",
        "holding",
        "allocation",
        "portfolio",
    ]

    if any(
        keyword in lower_url
        for keyword in data_keywords
    ):
        return True

    return False


# ============================================================
# EXCEL
# ============================================================

def load_funds_from_excel():
    """
    Read every populated URL from Column A.

    Column A controls the fund universe.

    Column B is retained as the exact PruAccess fund name.
    """

    if not EXCEL_FILE.exists():
        raise FileNotFoundError(
            f"Excel file not found: "
            f"{EXCEL_FILE.resolve()}"
        )

    workbook = load_workbook(
        EXCEL_FILE,
        read_only=True,
        data_only=True
    )

    try:
        worksheet = workbook.active

        funds = []

        for row_number in range(
            2,
            worksheet.max_row + 1
        ):
            url_value = worksheet.cell(
                row=row_number,
                column=1
            ).value

            name_value = worksheet.cell(
                row=row_number,
                column=2
            ).value

            if url_value is None:
                continue

            url = str(
                url_value
            ).strip()

            if not url:
                continue

            fund_name = ""

            if name_value is not None:
                fund_name = str(
                    name_value
                ).strip()

            funds.append({
                "excelRow": row_number,
                "prudentialUrl": url,
                "excelPruAccessName": fund_name,
            })

        return funds

    finally:
        workbook.close()


# ============================================================
# GENERIC JSON SEARCH
# ============================================================

def recursively_collect_key_values(
    value,
    output,
    path=""
):
    """
    Walk arbitrary JSON and retain every scalar value.

    This allows the script to discover information even if
    Prudential changes the exact JSON nesting structure.
    """

    if isinstance(value, dict):

        for key, child in value.items():

            child_path = (
                f"{path}.{key}"
                if path
                else str(key)
            )

            output.append({
                "path": child_path,
                "key": str(key),
                "value": child
            })

            recursively_collect_key_values(
                child,
                output,
                child_path
            )

    elif isinstance(value, list):

        for index, child in enumerate(value):

            child_path = (
                f"{path}[{index}]"
            )

            recursively_collect_key_values(
                child,
                output,
                child_path
            )


def find_first_matching_value(
    entries,
    names
):
    names = {
        str(name).lower()
        for name in names
    }

    for entry in entries:

        key = (
            str(
                entry.get("key", "")
            ).lower()
        )

        if key in names:

            value = entry.get(
                "value"
            )

            if value not in (
                None,
                "",
                [],
                {}
            ):
                return value

    return None


def build_extracted_fund_info(
    json_documents
):
    """
    Generic extraction layer.

    This does NOT replace raw JSON.

    It simply creates a convenient normalized view of fields
    which can be recognized.

    Unknown fields remain available in the raw JSON files.
    """

    entries = []

    for document in json_documents:

        data = document.get(
            "data"
        )

        recursively_collect_key_values(
            data,
            entries
        )

    aliases = {
        "fundIdentifier": [
            "fundIdentifier",
            "fundId",
            "fundID",
            "citicode",
            "citiCode",
            "fundIdentifierCode",
            "code",
        ],

        "fundCode": [
            "fundCode",
            "code",
            "shortCode",
        ],

        "fundName": [
            "fundName",
            "name",
            "fund_name",
        ],

        "fundCurrency": [
            "fundCurrency",
            "currency",
            "fundCurrencyCode",
        ],

        "unitCurrency": [
            "unitCurrency",
            "unitCurrencyCode",
        ],

        "assetClass": [
            "assetClass",
            "assetClassName",
        ],

        "assetSubClass": [
            "assetSubClass",
            "assetSubclass",
            "assetSubClassName",
        ],

        "riskClassification": [
            "riskClassification",
            "riskClass",
            "riskClassificationName",
        ],

        "bidPrice": [
            "bidPrice",
            "bid",
            "bidprice",
            "currentBidPrice",
        ],

        "offerPrice": [
            "offerPrice",
            "offer",
            "offerprice",
            "currentOfferPrice",
        ],

        "valuationDate": [
            "valuationDate",
            "priceDate",
            "bidDate",
            "valuation_date",
        ],

        "inceptionDate": [
            "inceptionDate",
            "launchDate",
            "fundInceptionDate",
        ],

        "cumulativeYtd": [
            "cumulativeYtd",
            "ytd",
            "ytdReturn",
            "cumulativeYTD",
        ],

        "cumulative1m": [
            "cumulative1m",
            "oneMonth",
            "oneMonthReturn",
            "1m",
            "1M",
        ],

        "cumulative3m": [
            "cumulative3m",
            "threeMonth",
            "threeMonthReturn",
            "3m",
            "3M",
        ],

        "cumulative6m": [
            "cumulative6m",
            "sixMonth",
            "sixMonthReturn",
            "6m",
            "6M",
        ],

        "cumulative1y": [
            "cumulative1y",
            "oneYear",
            "oneYearReturn",
            "1y",
            "1Y",
        ],

        "cumulative3y": [
            "cumulative3y",
            "threeYear",
            "threeYearReturn",
            "3y",
            "3Y",
        ],

        "cumulative5y": [
            "cumulative5y",
            "fiveYear",
            "fiveYearReturn",
            "5y",
            "5Y",
        ],

        "annualised3y": [
            "annualised3y",
            "annualized3y",
            "annualisedThreeYear",
            "annualizedThreeYear",
        ],

        "annualised5y": [
            "annualised5y",
            "annualized5y",
            "annualisedFiveYear",
            "annualizedFiveYear",
        ],

        "annualised10y": [
            "annualised10y",
            "annualized10y",
            "annualisedTenYear",
            "annualizedTenYear",
        ],

        "annualisedSinceLaunch": [
            "annualisedSinceLaunch",
            "annualizedSinceLaunch",
            "annualisedSinceInception",
            "annualizedSinceInception",
        ],

        "factsheetUrl": [
            "factsheetUrl",
            "factSheetUrl",
            "factsheet",
            "factSheet",
        ],

        "prospectusUrl": [
            "prospectusUrl",
            "prospectus",
        ],

        "productHighlightSheetUrl": [
            "productHighlightSheetUrl",
            "productHighlightsSheetUrl",
            "phsUrl",
            "phs",
        ],

        "annualReportUrl": [
            "annualReportUrl",
            "annualReport",
        ],

        "fundObjective": [
            "fundObjective",
            "investmentObjective",
            "objective",
        ],

        "investmentManager": [
            "investmentManager",
            "manager",
            "fundManager",
            "investmentManagers",
        ],

        "hasDividend": [
            "hasDividend",
            "dividend",
            "isDividend",
            "dividendFund",
        ],

        "dividendRate": [
            "dividendRate",
            "distributionRate",
        ],

        "dividendUnit": [
            "dividendUnit",
            "distributionUnit",
        ],
    }

    extracted = {}

    for output_name, possible_names in aliases.items():

        extracted[output_name] = (
            find_first_matching_value(
                entries,
                possible_names
            )
        )

    return {
        "fund": extracted,
        "discoveredJsonFields": entries,
    }


# ============================================================
# RESPONSE BODY PARSING
# ============================================================

async def safely_read_response_body(
    response
):
    try:

        body = await response.body()

        if not body:
            return None, None

        if len(body) > MAX_RESPONSE_BODY_BYTES:
            return None, (
                "response body exceeds "
                f"{MAX_RESPONSE_BODY_BYTES} bytes"
            )

        content_type = (
            response.headers.get(
                "content-type",
                ""
            )
        )

        if is_text_content_type(
            content_type
        ):

            try:
                text = body.decode(
                    "utf-8",
                    errors="replace"
                )

            except Exception:
                text = body.decode(
                    "latin-1",
                    errors="replace"
                )

            return text, None

        return None, (
            "non-text content type"
        )

    except Exception as e:

        return None, repr(e)


def try_parse_json(text):
    if not text:
        return None

    try:
        return json.loads(
            text
        )

    except Exception:
        return None


# ============================================================
# PROCESS ONE FUND
# ============================================================

async def process_fund(
    browser,
    fund,
    fund_number,
    total_funds
):

    excel_row = fund[
        "excelRow"
    ]

    prudential_url = fund[
        "prudentialUrl"
    ]

    excel_pruaccess_name = fund[
        "excelPruAccessName"
    ]

    name_part = safe_filename(
        excel_pruaccess_name
    )

    fund_dir = (
        FUNDS_OUTPUT_DIR
        / (
            f"{fund_number:03d}"
            f"_row_{excel_row}"
            f"_{name_part}"
        )
    )

    json_dir = fund_dir / "json"
    important_dir = fund_dir / "important"

    fund_dir.mkdir(
        parents=True,
        exist_ok=True
    )

    json_dir.mkdir(
        parents=True,
        exist_ok=True
    )

    important_dir.mkdir(
        parents=True,
        exist_ok=True
    )

    print()
    print("=" * 90)
    print(
        f"FUND {fund_number}/{total_funds}"
    )
    print(
        f"Excel row: {excel_row}"
    )
    print(
        "PruAccess name:",
        excel_pruaccess_name
        or "(Column B blank)"
    )
    print(
        "URL:",
        prudential_url
    )
    print("=" * 90)

    started_at = utc_now()

    save_json(
        fund_dir / "fund_info.json",
        {
            "fundNumber": fund_number,
            "excelRow": excel_row,
            "prudentialUrl": prudential_url,
            "excelPruAccessName": (
                excel_pruaccess_name
            ),
            "startedAtUtc": started_at,
        }
    )

    captured_requests = []
    captured_responses = []

    json_documents = []

    discovered_urls = set()

    response_counter = 0
    important_counter = {}

    context = await browser.new_context(
        viewport={
            "width": 1440,
            "height": 1000
        },
        java_script_enabled=True,
    )

    page = await context.new_page()

    # --------------------------------------------------------
    # REQUEST HANDLER
    # --------------------------------------------------------

    async def handle_request(request):

        url = request.url

        if is_prudential_url(url):
            discovered_urls.add(url)

        if is_document_url(url):
            discovered_urls.add(url)

        captured_requests.append({
            "timestampUtc": utc_now(),
            "method": request.method,
            "url": url,
            "resourceType": request.resource_type,
            "isPrudentialUrl": (
                is_prudential_url(url)
            ),
            "isDocumentUrl": (
                is_document_url(url)
            ),
            "postData": request.post_data,
            "headers": await request.all_headers(),
        })

    # --------------------------------------------------------
    # RESPONSE HANDLER
    # --------------------------------------------------------

    async def handle_response(response):

        nonlocal response_counter

        url = response.url

        content_type = (
            response.headers.get(
                "content-type",
                ""
            )
        )

        interesting = response_is_interesting(
            url=url,
            content_type=content_type,
            resource_type=response.request.resource_type
        )

        if is_prudential_url(url):
            discovered_urls.add(url)

        if is_document_url(url):
            discovered_urls.add(url)

        if not interesting:
            return

        response_counter += 1

        response_id = (
            f"{response_counter:04d}"
        )

        print()
        print(
            "CAPTURE:",
            response_id
        )
        print(
            "STATUS:",
            response.status
        )
        print(
            "TYPE:",
            response.request.resource_type
        )
        print(
            "CONTENT:",
            content_type
        )
        print(
            "URL:",
            url
        )

        body_text = None
        body_error = None

        body_text, body_error = (
            await safely_read_response_body(
                response
            )
        )

        parsed_json = None

        if body_text is not None:
            parsed_json = try_parse_json(
                body_text
            )

        is_json = (
            parsed_json is not None
            or is_json_content_type(
                content_type
            )
        )

        response_record = {
            "responseNumber": response_counter,
            "responseId": response_id,
            "timestampUtc": utc_now(),
            "url": url,
            "status": response.status,
            "statusText": response.status_text,
            "contentType": content_type,
            "resourceType": (
                response.request.resource_type
            ),
            "requestMethod": (
                response.request.method
            ),
            "isPrudentialUrl": (
                is_prudential_url(url)
            ),
            "isImportantJson": any(
                part.lower() in url.lower()
                for part in IMPORTANT_PARTS
            ),
            "isJson": is_json,
            "bodyCaptured": (
                body_text is not None
            ),
            "bodyError": body_error,
            "headers": await response.all_headers(),
        }

        # ----------------------------------------------------
        # Save JSON response
        # ----------------------------------------------------

        if parsed_json is not None:

            filename = (
                f"response_{response_counter:04d}.json"
            )

            output_file = (
                json_dir / filename
            )

            save_json(
                output_file,
                parsed_json
            )

            json_documents.append({
                "responseNumber": response_counter,
                "responseId": response_id,
                "filename": str(
                    output_file.relative_to(
                        fund_dir
                    )
                ),
                "url": url,
                "contentType": content_type,
                "data": parsed_json,
            })

            response_record[
                "jsonFilename"
            ] = str(
                output_file.relative_to(
                    fund_dir
                )
            )

            # ------------------------------------------------
            # Preserve important named responses separately.
            # ------------------------------------------------

            lower_url = url.lower()

            for important_part in IMPORTANT_PARTS:

                if (
                    important_part.lower()
                    in lower_url
                ):

                    count = (
                        important_counter.get(
                            important_part,
                            0
                        )
                        + 1
                    )

                    important_counter[
                        important_part
                    ] = count

                    safe_part = safe_filename(
                        important_part
                    ).replace(
                        ".",
                        "_"
                    )

                    important_filename = (
                        f"{safe_part}_"
                        f"{count:03d}.json"
                    )

                    save_json(
                        important_dir
                        / important_filename,
                        parsed_json
                    )

                    response_record[
                        "importantFilename"
                    ] = str(
                        (
                            important_dir
                            / important_filename
                        ).relative_to(
                            fund_dir
                        )
                    )

                    print(
                        "IMPORTANT JSON:",
                        important_part
                    )

        # ----------------------------------------------------
        # Save raw text where JSON parsing failed.
        # ----------------------------------------------------

        elif body_text is not None:

            filename = (
                f"response_{response_counter:04d}.txt"
            )

            save_text(
                json_dir / filename,
                body_text
            )

            response_record[
                "rawTextFilename"
            ] = str(
                (
                    json_dir / filename
                ).relative_to(
                    fund_dir
                )
            )

        captured_responses.append(
            response_record
        )

    page.on(
        "request",
        handle_request
    )

    page.on(
        "response",
        handle_response
    )

    try:

        # ----------------------------------------------------
        # OPEN PAGE
        # ----------------------------------------------------

        print()
        print(
            "Opening Prudential page..."
        )

        navigation_error = None

        try:

            await page.goto(
                prudential_url,
                wait_until="domcontentloaded",
                timeout=PAGE_TIMEOUT_MS
            )

        except Exception as e:

            navigation_error = repr(e)

            print()
            print(
                "PAGE NAVIGATION ERROR:"
            )
            print(
                navigation_error
            )
            print(
                "Continuing because network "
                "requests may already have fired."
            )

        # ----------------------------------------------------
        # JAVASCRIPT WAIT
        # ----------------------------------------------------

        print()
        print(
            "Waiting for Prudential JavaScript..."
        )

        await page.wait_for_timeout(
            JAVASCRIPT_WAIT_MS
        )

        # ----------------------------------------------------
        # SCROLL PAGE
        # ----------------------------------------------------

        try:

            await page.evaluate(
                """
                window.scrollTo(
                    0,
                    document.body.scrollHeight
                );
                """
            )

        except Exception as e:

            print(
                "Scroll warning:",
                repr(e)
            )

        await page.wait_for_timeout(
            LAZY_LOAD_WAIT_MS
        )

        # ----------------------------------------------------
        # SCROLL BACK TOP
        # ----------------------------------------------------

        try:

            await page.evaluate(
                """
                window.scrollTo(
                    0,
                    0
                );
                """
            )

        except Exception:
            pass

        await page.wait_for_timeout(
            SECONDARY_WAIT_MS
        )

        # ----------------------------------------------------
        # SECOND FULL PAGE SCROLL
        # ----------------------------------------------------

        try:

            await page.evaluate(
                """
                window.scrollTo(
                    0,
                    document.body.scrollHeight
                );
                """

            )

        except Exception:
            pass

        await page.wait_for_timeout(
            SECONDARY_WAIT_MS
        )

        # ----------------------------------------------------
        # RENDERED HTML
        # ----------------------------------------------------

        try:

            html = await page.content()

            save_text(
                fund_dir / "rendered.html",
                html
            )

        except Exception as e:

            print(
                "Could not save rendered HTML:",
                repr(e)
            )

        # ----------------------------------------------------
        # VISIBLE TEXT
        # ----------------------------------------------------

        try:

            visible_text = (
                await page.locator(
                    "body"
                ).inner_text()
            )

            save_text(
                fund_dir / "visible_text.txt",
                visible_text
            )

        except Exception as e:

            print(
                "Could not save visible text:",
                repr(e)
            )

        # ----------------------------------------------------
        # PAGE URL
        # ----------------------------------------------------

        try:

            current_url = page.url

        except Exception:

            current_url = prudential_url

        # ----------------------------------------------------
        # DISCOVER URLs FROM PAGE HTML
        # ----------------------------------------------------

        try:

            page_urls = await page.evaluate(
                """
                () => {
                    const urls = [];

                    for (const a of document.querySelectorAll('a[href]')) {
                        urls.push(a.href);
                    }

                    for (const link of document.querySelectorAll('link[href]')) {
                        urls.push(link.href);
                    }

                    for (const script of document.querySelectorAll('script[src]')) {
                        urls.push(script.src);
                    }

                    for (const element of document.querySelectorAll('[src]')) {
                        urls.push(element.src);
                    }

                    return urls;
                }
                """
            )

            for url in page_urls:

                if not url:
                    continue

                absolute_url = urljoin(
                    current_url,
                    url
                )

                if (
                    is_prudential_url(
                        absolute_url
                    )
                ):
                    discovered_urls.add(
                        absolute_url
                    )

        except Exception as e:

            print(
                "URL discovery warning:",
                repr(e)
            )

        # ----------------------------------------------------
        # SAVE REQUESTS
        # ----------------------------------------------------

        save_json(
            fund_dir / "requests.json",
            captured_requests
        )

        # ----------------------------------------------------
        # SAVE RESPONSE INDEX
        # ----------------------------------------------------

        save_json(
            fund_dir / "responses.json",
            captured_responses
        )

        # ----------------------------------------------------
        # SAVE DISCOVERED URL INDEX
        # ----------------------------------------------------

        discovered_url_records = []

        for url in sorted(
            discovered_urls
        ):

            discovered_url_records.append({
                "url": url,
                "isPrudentialUrl": (
                    is_prudential_url(url)
                ),
                "isDocumentUrl": (
                    is_document_url(url)
                ),
                "filename": url_basename(
                    url
                ),
            })

        save_json(
            fund_dir / "discovered_urls.json",
            discovered_url_records
        )

        # ----------------------------------------------------
        # EXTRACT GENERIC FUND INFORMATION
        # ----------------------------------------------------

        extracted = (
            build_extracted_fund_info(
                json_documents
            )
        )

        extracted_fund = (
            extracted.get(
                "fund",
                {}
            )
        )

        # ----------------------------------------------------
        # Do NOT override raw data.
        #
        # The values below are only a convenience layer.
        # ----------------------------------------------------

        extracted_record = {
            "excelRow": excel_row,
            "fundIdentifier": (
                extracted_fund.get(
                    "fundIdentifier"
                )
            ),
            "fundCode": (
                extracted_fund.get(
                    "fundCode"
                )
            ),
            "fundName": (
                extracted_fund.get(
                    "fundName"
                )
                or excel_pruaccess_name
            ),
            "pruAccessName": (
                excel_pruaccess_name
            ),
            "prudentialUrl": (
                prudential_url
            ),
            "fund": extracted_fund,
            "source": {
                "rawJsonDirectory": (
                    "json/"
                ),
                "importantJsonDirectory": (
                    "important/"
                ),
                "responsesIndex": (
                    "responses.json"
                ),
                "requestsIndex": (
                    "requests.json"
                ),
                "renderedHtml": (
                    "rendered.html"
                ),
                "visibleText": (
                    "visible_text.txt"
                ),
            },
            "capture": {
                "jsonDocuments": len(
                    json_documents
                ),
                "networkResponsesCaptured": len(
                    captured_responses
                ),
                "networkRequestsCaptured": len(
                    captured_requests
                ),
                "discoveredUrls": len(
                    discovered_urls
                ),
            },
        }

        save_json(
            fund_dir
            / "extracted_fund_info.json",
            extracted_record
        )

        # ----------------------------------------------------
        # SUMMARY
        # ----------------------------------------------------

        finished_at = utc_now()

        important_counts = {}

        for part in IMPORTANT_PARTS:

            important_counts[
                part
            ] = important_counter.get(
                part,
                0
            )

        summary = {
            "status": (
                "success"
                if (
                    captured_responses
                    or json_documents
                )
                else "no_data"
            ),

            "fundNumber": fund_number,

            "excelRow": excel_row,

            "prudentialUrl": (
                prudential_url
            ),

            "excelPruAccessName": (
                excel_pruaccess_name
            ),

            "currentPageUrl": (
                current_url
            ),

            "startedAtUtc": started_at,

            "completedAtUtc": finished_at,

            "navigationError": (
                navigation_error
            ),

            "networkRequestsCaptured": len(
                captured_requests
            ),

            "networkResponsesCaptured": len(
                captured_responses
            ),

            "jsonResponsesCaptured": len(
                json_documents
            ),

            "importantJsonCaptured": (
                important_counts
            ),

            "discoveredUrls": len(
                discovered_urls
            ),

            "outputDirectory": str(
                fund_dir
            ),

            "rawCapture": {
                "requests": (
                    "requests.json"
                ),
                "responses": (
                    "responses.json"
                ),
                "jsonDirectory": (
                    "json/"
                ),
                "importantDirectory": (
                    "important/"
                ),
                "renderedHtml": (
                    "rendered.html"
                ),
                "visibleText": (
                    "visible_text.txt"
                ),
                "discoveredUrls": (
                    "discovered_urls.json"
                ),
            },

            "extractedFundInfo": (
                "extracted_fund_info.json"
            ),
        }

        save_json(
            fund_dir / "summary.json",
            summary
        )

        status = summary[
            "status"
        ]

        print()
        print(
            "FUND STATUS:",
            status.upper()
        )

        print(
            "Network requests:",
            len(captured_requests)
        )

        print(
            "Network responses:",
            len(captured_responses)
        )

        print(
            "JSON responses:",
            len(json_documents)
        )

        print(
            "ilpfunds.json:",
            important_counts.get(
                "ilpfunds.json",
                0
            )
        )

        print(
            "ilpseries.json:",
            important_counts.get(
                "ilpseries.json",
                0
            )
        )

        print(
            "Discovered URLs:",
            len(discovered_urls)
        )

        return {
            "status": status,
            "fundNumber": fund_number,
            "excelRow": excel_row,
            "prudentialUrl": prudential_url,
            "excelPruAccessName": (
                excel_pruaccess_name
            ),
            "networkRequestsCaptured": len(
                captured_requests
            ),
            "networkResponsesCaptured": len(
                captured_responses
            ),
            "jsonResponsesCaptured": len(
                json_documents
            ),
            "importantJsonCaptured": (
                important_counts
            ),
            "discoveredUrls": len(
                discovered_urls
            ),
            "outputDirectory": str(
                fund_dir
            ),
        }

    except Exception as e:

        print()
        print(
            "FUND EXTRACTION ERROR:"
        )
        print(
            repr(e)
        )

        error_record = {
            "status": "failed",
            "fundNumber": fund_number,
            "excelRow": excel_row,
            "prudentialUrl": prudential_url,
            "excelPruAccessName": (
                excel_pruaccess_name
            ),
            "error": repr(e),
            "outputDirectory": str(
                fund_dir
            ),
        }

        save_json(
            fund_dir / "summary.json",
            error_record
        )

        return error_record

    finally:

        await page.close()
        await context.close()


# ============================================================
# MAIN
# ============================================================

async def main():

    print()
    print("=" * 90)
    print(
        "VGrat FMS - PRUDENTIAL "
        "ALL-FUND INFORMATION CAPTURE"
    )
    print("=" * 90)

    OUTPUT_DIR.mkdir(
        parents=True,
        exist_ok=True
    )

    FUNDS_OUTPUT_DIR.mkdir(
        parents=True,
        exist_ok=True
    )

    print()
    print(
        "Reading:",
        EXCEL_FILE
    )

    funds = load_funds_from_excel()

    total_funds = len(
        funds
    )

    print()
    print(
        "Funds found in Column A:",
        total_funds
    )

    if total_funds == 0:

        print()
        print(
            "ERROR: No populated fund URLs found."
        )

        return

    results = []

    successful = 0
    no_data = 0
    failed = 0

    started_at = utc_now()

    async with async_playwright() as p:

        browser = await p.chromium.launch(
            headless=True
        )

        try:

            for fund_number, fund in enumerate(
                funds,
                start=1
            ):

                result = await process_fund(
                    browser=browser,
                    fund=fund,
                    fund_number=fund_number,
                    total_funds=total_funds
                )

                results.append(
                    result
                )

                if result["status"] == "success":
                    successful += 1

                elif result["status"] == "no_data":
                    no_data += 1

                else:
                    failed += 1

                # ------------------------------------------------
                # Progressive run summary
                # ------------------------------------------------

                progress_summary = {
                    "status": "running",

                    "startedAtUtc": (
                        started_at
                    ),

                    "lastUpdatedAtUtc": (
                        utc_now()
                    ),

                    "totalFunds": (
                        total_funds
                    ),

                    "processedFunds": len(
                        results
                    ),

                    "remainingFunds": (
                        total_funds
                        - len(results)
                    ),

                    "successfulFunds": (
                        successful
                    ),

                    "noDataFunds": (
                        no_data
                    ),

                    "failedFunds": (
                        failed
                    ),

                    "results": results,
                }

                save_json(
                    OUTPUT_DIR
                    / "run_summary.json",
                    progress_summary
                )

                if fund_number < total_funds:

                    await asyncio.sleep(
                        DELAY_BETWEEN_FUNDS_MS
                        / 1000
                    )

        finally:

            await browser.close()

    # --------------------------------------------------------
    # FINAL SUMMARY
    # --------------------------------------------------------

    final_summary = {
        "status": (
            "completed"
            if failed == 0
            else "completed_with_failures"
        ),

        "startedAtUtc": (
            started_at
        ),

        "completedAtUtc": (
            utc_now()
        ),

        "totalFunds": (
            total_funds
        ),

        "processedFunds": len(
            results
        ),

        "successfulFunds": (
            successful
        ),

        "noDataFunds": (
            no_data
        ),

        "failedFunds": (
            failed
        ),

        "results": results,
    }

    save_json(
        OUTPUT_DIR
        / "run_summary.json",
        final_summary
    )

    print()
    print("=" * 90)
    print(
        "PRUDENTIAL ALL-FUND "
        "INFORMATION CAPTURE COMPLETE"
    )
    print("=" * 90)

    print(
        "Total funds:",
        total_funds
    )

    print(
        "Successful:",
        successful
    )

    print(
        "No data:",
        no_data
    )

    print(
        "Failed:",
        failed
    )

    print()
    print(
        "Output directory:"
    )

    print(
        OUTPUT_DIR.resolve()
    )

    print()
    print(
        "Run summary:"
    )

    print(
        (
            OUTPUT_DIR
            / "run_summary.json"
        ).resolve()
    )

    print("=" * 90)


# ============================================================
# ENTRY POINT
# ============================================================

if __name__ == "__main__":
    asyncio.run(main())
