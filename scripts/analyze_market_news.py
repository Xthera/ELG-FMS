#!/usr/bin/env python3

"""
VGrat FMS - MARKET NEWS AI ANALYZER
===================================

Reads:
    data/market_news/current.json

Writes:
    data/market_news/analysis/current.json
    data/market_news/analysis/history/YYYY/MM/YYYY-MM-DD.json

IMPORTANT
---------
The collector's current.json is READ-ONLY.

Collector article schema:
    {
        "id": "...",
        "source": "CNBC",
        "title": "...",
        "publishedAtSgt": "...",
        "url": "...",
        "category": "...",
        "relevanceScore": 91,
        "relevanceReason": "...",
        "summary": "...",
        "feeds": [...],
        "collectedAtSgt": "..."
    }

Analyzer behaviour:
    - Sequential processing
    - Exactly one article per Gemini request
    - Newest article first
    - No batching
    - No retries
    - Stop immediately on ANY failure
    - Save every successful article immediately
    - Previously saved successes remain on disk after a later failure
    - Collector current.json is never modified

Rolling window:
    - 14 publication days
    - Publication date comes from collector publishedAtSgt
    - Current analysis contains articles within the rolling window
    - Older analyses are archived by publication date:
          history/YYYY/MM/YYYY-MM-DD.json

Recovery:
    - Existing analysis records are identified by articleId
    - publishedAtSgt is NOT required inside an analysis record
    - If missing/invalid, the analyzer first recovers it from
      collector current.json
    - If not found there, the analyzer searches analysis history
    - If publication date still cannot be determined, execution stops

Environment:
    GEMINI_API_KEY       required
    MARKET_NEWS_MODEL    optional
                         default: 

Python:
    Standard library only
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple


# ============================================================
# CONFIGURATION
# ============================================================

ROOT = Path(__file__).resolve().parent.parent

NEWS_FILE = ROOT / "data" / "market_news" / "current.json"

ANALYSIS_DIR = ROOT / "data" / "market_news" / "analysis"
ANALYSIS_CURRENT_FILE = ANALYSIS_DIR / "current.json"
HISTORY_DIR = ANALYSIS_DIR / "history"

MODEL = os.environ.get(
    "MARKET_NEWS_MODEL",
    "gemini-3.5-flash-lite",
)

API_KEY = os.environ.get("GEMINI_API_KEY", "").strip()

GEMINI_URL = (
    "https://generativelanguage.googleapis.com/"
    f"v1beta/models/{MODEL}:generateContent"
)

ROLLING_DAYS = 14

REQUEST_TIMEOUT_SECONDS = 120


# ============================================================
# REQUIRED ANALYSIS FIELDS
# ============================================================

REQUIRED_ANALYSIS_FIELDS = {
    "articleId",
    "relevant",
    "category",
    "sentiment",
    "importance",
    "summary",
    "assetClasses",
    "geographies",
    "sectors",
    "investorImpact",
    "reasoning",
    "fundMonitoringRelevant",
}


VALID_CATEGORIES = {
    "MARKET",
    "ECONOMIC",
    "TECHNOLOGY",
    "GEOPOLITICAL",
    "REJECT",
}

VALID_SENTIMENTS = {
    "POSITIVE",
    "NEGATIVE",
    "NEUTRAL",
    "MIXED",
}

VALID_IMPORTANCE = {
    "HIGH",
    "MEDIUM",
    "LOW",
}


# ============================================================
# LOGGING
# ============================================================

def log(message: str = "") -> None:
    timestamp = datetime.now(
        timezone(timedelta(hours=8))
    ).strftime("%Y-%m-%d %H:%M:%S")

    print(f"[{timestamp}] {message}", flush=True)


def separator() -> None:
    log("=" * 70)


# ============================================================
# EXCEPTIONS
# ============================================================

class AnalysisError(Exception):
    """Expected analyzer failure."""


# ============================================================
# JSON HELPERS
# ============================================================

def load_json(path: Path, description: str) -> Any:
    if not path.exists():
        raise AnalysisError(
            f"{description} does not exist: {path}"
        )

    try:
        with path.open("r", encoding="utf-8") as f:
            return json.load(f)
    except json.JSONDecodeError as exc:
        raise AnalysisError(
            f"{description} contains invalid JSON: {exc}"
        ) from exc
    except OSError as exc:
        raise AnalysisError(
            f"Unable to read {description}: {exc}"
        ) from exc


def atomic_write_json(path: Path, data: Any) -> None:
    """
    Atomically replace a JSON file.

    This is important because every successful analysis is saved
    immediately. A partially-written JSON file must never be left
    behind.
    """

    path.parent.mkdir(parents=True, exist_ok=True)

    temp_path = path.with_suffix(
        path.suffix + ".tmp"
    )

    try:
        with temp_path.open(
            "w",
            encoding="utf-8",
            newline="\n",
        ) as f:
            json.dump(
                data,
                f,
                ensure_ascii=False,
                indent=2,
            )
            f.write("\n")

        temp_path.replace(path)

    except OSError as exc:
        try:
            if temp_path.exists():
                temp_path.unlink()
        except OSError:
            pass

        raise AnalysisError(
            f"Unable to write {path}: {exc}"
        ) from exc


# ============================================================
# DATETIME HELPERS
# ============================================================

SGT = timezone(timedelta(hours=8))


def parse_sgt_datetime(value: Any) -> Optional[datetime]:
    """
    Parse an ISO-8601 timestamp.

    Returns an aware datetime converted to SGT.

    Examples accepted:
        2026-10-03T20:55:31+08:00
        2026-10-03T20:55:31Z
    """

    if not isinstance(value, str):
        return None

    value = value.strip()

    if not value:
        return None

    try:
        normalized = value

        if normalized.endswith("Z"):
            normalized = normalized[:-1] + "+00:00"

        dt = datetime.fromisoformat(normalized)

        if dt.tzinfo is None:
            return None

        return dt.astimezone(SGT)

    except (TypeError, ValueError, OverflowError):
        return None


def publication_date_from_timestamp(value: Any) -> Optional[str]:
    dt = parse_sgt_datetime(value)

    if dt is None:
        return None

    return dt.date().isoformat()


# ============================================================
# COLLECTOR INPUT
# ============================================================

def validate_collector_article(
    article: Any,
    index: int,
) -> Dict[str, Any]:

    if not isinstance(article, dict):
        raise AnalysisError(
            f"Article at index {index} is not a JSON object."
        )

    required = [
        "id",
        "source",
        "title",
        "publishedAtSgt",
        "url",
    ]

    for field in required:
        value = article.get(field)

        if not isinstance(value, str) or not value.strip():
            raise AnalysisError(
                f"Article at index {index} has invalid {field}."
            )

    published_dt = parse_sgt_datetime(
        article["publishedAtSgt"]
    )

    if published_dt is None:
        raise AnalysisError(
            f"Article {article['id']} has invalid publishedAtSgt."
        )

    return article


def load_collector_articles() -> Tuple[
    List[Dict[str, Any]],
    Dict[str, Dict[str, Any]],
]:
    log("Loading collector current.json...")

    data = load_json(
        NEWS_FILE,
        "Collector current.json",
    )

    if not isinstance(data, dict):
        raise AnalysisError(
            "Collector current.json root must be a JSON object."
        )

    articles = data.get("articles")

    if not isinstance(articles, list):
        raise AnalysisError(
            "Collector current.json has no valid 'articles' array."
        )

    validated: List[Dict[str, Any]] = []
    by_id: Dict[str, Dict[str, Any]] = {}

    for index, article in enumerate(articles):
        article = validate_collector_article(
            article,
            index,
        )

        article_id = article["id"]

        if article_id in by_id:
            raise AnalysisError(
                f"Duplicate collector article ID: {article_id}"
            )

        by_id[article_id] = article
        validated.append(article)

    validated.sort(
        key=lambda article: parse_sgt_datetime(
            article["publishedAtSgt"]
        ),
        reverse=True,
    )

    log(f"Loaded {len(validated)} collector article(s).")

    return validated, by_id


# ============================================================
# ANALYSIS CURRENT FILE
# ============================================================

def normalize_existing_analysis_root(
    data: Any,
) -> Tuple[Dict[str, Any], List[Dict[str, Any]]]:

    if data is None:
        root = {
            "generatedAtSgt": None,
            "timezone": "Asia/Singapore",
            "timezoneLabel": "SGT",
            "windowDays": ROLLING_DAYS,
            "analyses": [],
        }

        return root, []

    if not isinstance(data, dict):
        raise AnalysisError(
            "Existing analysis/current.json root must be a JSON object."
        )

    analyses = data.get("analyses")

    if analyses is None:
        analyses = []

    if not isinstance(analyses, list):
        raise AnalysisError(
            "Existing analysis/current.json has invalid 'analyses'."
        )

    normalized: List[Dict[str, Any]] = []

    for index, record in enumerate(analyses):

        if not isinstance(record, dict):
            raise AnalysisError(
                f"Existing analysis at index {index} is not a JSON object."
            )

        article_id = record.get("articleId")

        if not isinstance(article_id, str) or not article_id.strip():
            raise AnalysisError(
                f"Existing analysis at index {index} has no valid articleId."
            )

        normalized.append(record)

    root = dict(data)
    root["analyses"] = normalized

    return root, normalized


def load_existing_analysis() -> Tuple[
    Dict[str, Any],
    List[Dict[str, Any]],
]:
    log("Loading existing analysis/current.json...")

    if not ANALYSIS_CURRENT_FILE.exists():
        log("No existing analysis/current.json found.")
        log("Starting with an empty analysis set.")

        root = {
            "generatedAtSgt": None,
            "timezone": "Asia/Singapore",
            "timezoneLabel": "SGT",
            "windowDays": ROLLING_DAYS,
            "analyses": [],
        }

        return root, []

    data = load_json(
        ANALYSIS_CURRENT_FILE,
        "Existing analysis/current.json",
    )

    root, analyses = normalize_existing_analysis_root(data)

    log(
        f"Loaded {len(analyses)} existing current analysis record(s)."
    )

    return root, analyses


# ============================================================
# HISTORY
# ============================================================

def history_files() -> List[Path]:
    if not HISTORY_DIR.exists():
        return []

    return sorted(
        HISTORY_DIR.glob("*/*/*.json")
    )


def load_history_records() -> Tuple[
    Dict[str, Dict[str, Any]],
    Dict[str, str],
]:
    """
    Returns:

        records_by_id:
            articleId -> analysis record

        publication_date_by_id:
            articleId -> YYYY-MM-DD

    History is scanned so the analyzer can:
        - avoid re-analysis
        - recover metadata
        - maintain archive integrity
    """

    records_by_id: Dict[str, Dict[str, Any]] = {}
    publication_date_by_id: Dict[str, str] = {}

    files = history_files()

    if not files:
        return records_by_id, publication_date_by_id

    log(
        f"Scanning {len(files)} analysis history file(s)..."
    )

    for path in files:

        data = load_json(
            path,
            f"Analysis history file {path}",
        )

        if isinstance(data, dict):
            records = data.get("analyses", [])

        elif isinstance(data, list):
            records = data

        else:
            raise AnalysisError(
                f"History file {path} has invalid JSON structure."
            )

        if not isinstance(records, list):
            raise AnalysisError(
                f"History file {path} has invalid 'analyses'."
            )

        for index, record in enumerate(records):

            if not isinstance(record, dict):
                raise AnalysisError(
                    f"History file {path}, record {index} "
                    f"is not a JSON object."
                )

            article_id = record.get("articleId")

            if not isinstance(article_id, str) or not article_id.strip():
                raise AnalysisError(
                    f"History file {path}, record {index} "
                    f"has no valid articleId."
                )

            if article_id in records_by_id:
                raise AnalysisError(
                    f"Duplicate articleId found in analysis history: "
                    f"{article_id}"
                )

            records_by_id[article_id] = record

            publication_date = publication_date_from_timestamp(
                record.get("publishedAtSgt")
            )

            if publication_date:
                publication_date_by_id[
                    article_id
                ] = publication_date

    log(
        f"Loaded {len(records_by_id)} archived analysis record(s)."
    )

    return records_by_id, publication_date_by_id


# ============================================================
# PUBLICATION DATE RECOVERY
# ============================================================

def recover_publication_timestamp(
    article_id: str,
    analysis_record: Dict[str, Any],
    collector_by_id: Dict[str, Dict[str, Any]],
    history_by_id: Dict[str, Dict[str, Any]],
) -> Optional[str]:

    """
    Recover publication timestamp in this priority:

        1. Collector current.json
        2. Existing analysis record
        3. Archived history

    Collector wins because it is the authoritative source for
    article metadata.
    """

    # --------------------------------------------------------
    # 1. Collector
    # --------------------------------------------------------

    collector_article = collector_by_id.get(article_id)

    if collector_article:
        timestamp = collector_article.get(
            "publishedAtSgt"
        )

        if parse_sgt_datetime(timestamp):
            return timestamp

    # --------------------------------------------------------
    # 2. Existing current analysis
    # --------------------------------------------------------

    timestamp = analysis_record.get(
        "publishedAtSgt"
    )

    if parse_sgt_datetime(timestamp):
        return timestamp

    # --------------------------------------------------------
    # 3. History
    # --------------------------------------------------------

    history_record = history_by_id.get(article_id)

    if history_record:
        timestamp = history_record.get(
            "publishedAtSgt"
        )

        if parse_sgt_datetime(timestamp):
            return timestamp

    return None


def enrich_existing_record_metadata(
    record: Dict[str, Any],
    collector_by_id: Dict[str, Dict[str, Any]],
    history_by_id: Dict[str, Dict[str, Any]],
) -> Dict[str, Any]:

    article_id = record["articleId"]

    collector_article = collector_by_id.get(
        article_id
    )

    if collector_article:
        # Collector is authoritative.
        record["publishedAtSgt"] = collector_article[
            "publishedAtSgt"
        ]

        record.setdefault(
            "source",
            collector_article["source"],
        )

        record.setdefault(
            "title",
            collector_article["title"],
        )

        record.setdefault(
            "url",
            collector_article["url"],
        )

    else:
        recovered = recover_publication_timestamp(
            article_id,
            record,
            collector_by_id,
            history_by_id,
        )

        if recovered:
            record["publishedAtSgt"] = recovered

    return record


# ============================================================
# ROLLING WINDOW
# ============================================================

def calculate_cutoff_date(
    collector_articles: List[Dict[str, Any]],
) -> datetime.date:

    """
    The rolling window is based on the newest publication date
    present in the collector data.

    Example:

        newest publication date = 2026-10-03

        14 publication days means keep:
            2026-09-20 through 2026-10-03

    """

    if not collector_articles:
        return datetime.now(SGT).date() - timedelta(
            days=ROLLING_DAYS - 1
        )

    newest_dt = parse_sgt_datetime(
        collector_articles[0]["publishedAtSgt"]
    )

    if newest_dt is None:
        raise AnalysisError(
            "Unable to determine newest collector publication date."
        )

    newest_date = newest_dt.date()

    return newest_date - timedelta(
        days=ROLLING_DAYS - 1
    )


# ============================================================
# ARCHIVE PATH
# ============================================================

def history_path_for_date(
    publication_date: str,
) -> Path:

    try:
        dt = datetime.strptime(
            publication_date,
            "%Y-%m-%d",
        )

    except ValueError as exc:
        raise AnalysisError(
            f"Invalid publication date: {publication_date}"
        ) from exc

    return (
        HISTORY_DIR
        / f"{dt.year:04d}"
        / f"{dt.month:02d}"
        / f"{publication_date}.json"
    )


# ============================================================
# HISTORY WRITE
# ============================================================

def load_history_day(
    path: Path,
) -> List[Dict[str, Any]]:

    if not path.exists():
        return []

    data = load_json(
        path,
        f"History file {path}",
    )

    if isinstance(data, dict):
        records = data.get("analyses", [])

    elif isinstance(data, list):
        records = data

    else:
        raise AnalysisError(
            f"History file {path} has invalid structure."
        )

    if not isinstance(records, list):
        raise AnalysisError(
            f"History file {path} has invalid analyses array."
        )

    return records


def archive_record(
    record: Dict[str, Any],
) -> None:

    article_id = record.get("articleId")

    if not isinstance(article_id, str) or not article_id:
        raise AnalysisError(
            "Cannot archive analysis without articleId."
        )

    publication_date = publication_date_from_timestamp(
        record.get("publishedAtSgt")
    )

    if publication_date is None:
        raise AnalysisError(
            f"Analysis {article_id} has invalid publishedAtSgt; "
            f"cannot determine archive date."
        )

    path = history_path_for_date(
        publication_date
    )

    existing = load_history_day(path)

    existing_by_id: Dict[str, Dict[str, Any]] = {}

    for existing_record in existing:

        if not isinstance(existing_record, dict):
            raise AnalysisError(
                f"History file {path} contains a non-object record."
            )

        existing_id = existing_record.get(
            "articleId"
        )

        if not isinstance(existing_id, str) or not existing_id:
            raise AnalysisError(
                f"History file {path} contains a record "
                f"without articleId."
            )

        existing_by_id[existing_id] = existing_record

    if article_id not in existing_by_id:
        existing.append(record)

    else:
        # Preserve existing archived record.
        # Never create duplicate history entries.
        pass

    existing.sort(
        key=lambda item: (
            parse_sgt_datetime(
                item.get("publishedAtSgt")
            )
            or datetime.min.replace(
                tzinfo=SGT
            )
        ),
        reverse=True,
    )

    root = {
        "date": publication_date,
        "timezone": "Asia/Singapore",
        "timezoneLabel": "SGT",
        "articleCount": len(existing),
        "analyses": existing,
    }

    atomic_write_json(
        path,
        root,
    )


# ============================================================
# ARCHIVE OLD CURRENT ANALYSES
# ============================================================

def archive_expired_current_records(
    current_records: List[Dict[str, Any]],
    collector_by_id: Dict[str, Dict[str, Any]],
    history_by_id: Dict[str, Dict[str, Any]],
    cutoff_date,
) -> List[Dict[str, Any]]:

    remaining: List[Dict[str, Any]] = []

    archived_count = 0

    for record in current_records:

        article_id = record["articleId"]

        record = enrich_existing_record_metadata(
            record,
            collector_by_id,
            history_by_id,
        )

        publication_date = publication_date_from_timestamp(
            record.get("publishedAtSgt")
        )

        if publication_date is None:

            raise AnalysisError(
                f"Analysis {article_id} has invalid "
                f"publishedAtSgt; cannot determine archive date."
            )

        publication_dt = datetime.strptime(
            publication_date,
            "%Y-%m-%d",
        ).date()

        if publication_dt < cutoff_date:

            archive_record(record)

            archived_count += 1

        else:
            remaining.append(record)

    if archived_count:
        log(
            f"Archived {archived_count} expired analysis record(s)."
        )

    return remaining


# ============================================================
# GEMINI PROMPT
# ============================================================

def build_prompt(
    article: Dict[str, Any],
) -> str:

    """
    The article metadata comes directly from collector current.json.

    The model is instructed to return JSON only.
    """

    article_json = json.dumps(
        {
            "id": article["id"],
            "source": article["source"],
            "title": article["title"],
            "publishedAtSgt": article["publishedAtSgt"],
            "url": article["url"],
            "category": article.get("category"),
            "relevanceScore": article.get(
                "relevanceScore"
            ),
            "relevanceReason": article.get(
                "relevanceReason"
            ),
            "summary": article.get("summary"),
            "feeds": article.get("feeds"),
        },
        ensure_ascii=False,
        indent=2,
    )

    return f"""
You are the market-news intelligence analyst for VGrat FMS.

Analyze exactly ONE article.

The article below comes from CNBC and has already passed the
collector's relevance filtering.

ARTICLE:
{article_json}

Return ONLY a valid JSON object.

Do not return markdown.
Do not return a code block.
Do not add commentary before or after the JSON.

Required JSON fields:

{{
  "articleId": "string",
  "relevant": true,
  "category": "MARKET | ECONOMIC | TECHNOLOGY | GEOPOLITICAL | REJECT",
  "sentiment": "POSITIVE | NEGATIVE | NEUTRAL | MIXED",
  "importance": "HIGH | MEDIUM | LOW",
  "summary": "string",
  "assetClasses": ["string"],
  "geographies": ["string"],
  "sectors": ["string"],
  "investorImpact": "string",
  "reasoning": "string",
  "fundMonitoringRelevant": true
}}

Rules:

1. articleId MUST exactly equal the article's id.
2. relevant MUST be a boolean.
3. category MUST be exactly one of:
   MARKET, ECONOMIC, TECHNOLOGY, GEOPOLITICAL, REJECT.
4. sentiment MUST be exactly one of:
   POSITIVE, NEGATIVE, NEUTRAL, MIXED.
5. importance MUST be exactly one of:
   HIGH, MEDIUM, LOW.
6. assetClasses, geographies and sectors MUST be JSON arrays.
7. Do not invent specific securities, companies, figures,
   events or facts that are not supported by the article.
8. summary must accurately explain the article.
9. investorImpact should explain why the article matters,
   or does not matter, to investors.
10. reasoning should explain the classification and significance.
11. fundMonitoringRelevant MUST be a boolean.
12. If the article is not meaningful for fund/investment monitoring,
    set fundMonitoringRelevant to false.
13. Keep the analysis concise but useful.
""".strip()


# ============================================================
# GEMINI API
# ============================================================

def extract_response_text(
    response_data: Dict[str, Any],
) -> str:

    candidates = response_data.get(
        "candidates"
    )

    if not isinstance(candidates, list) or not candidates:
        raise AnalysisError(
            "Gemini response contains no candidates."
        )

    candidate = candidates[0]

    if not isinstance(candidate, dict):
        raise AnalysisError(
            "Gemini candidate has invalid structure."
        )

    content = candidate.get("content")

    if not isinstance(content, dict):
        raise AnalysisError(
            "Gemini response has no valid content."
        )

    parts = content.get("parts")

    if not isinstance(parts, list) or not parts:
        raise AnalysisError(
            "Gemini response has no content parts."
        )

    texts: List[str] = []

    for part in parts:
        if not isinstance(part, dict):
            continue

        text_value = part.get("text")

        if isinstance(text_value, str):
            texts.append(text_value)

    if not texts:
        raise AnalysisError(
            "Gemini response contains no text."
        )

    return "".join(texts).strip()


def call_gemini(
    article: Dict[str, Any],
) -> Dict[str, Any]:

    if not API_KEY:
        raise AnalysisError(
            "GEMINI_API_KEY environment variable is not set."
        )

    prompt = build_prompt(article)

    payload = {
        "contents": [
            {
                "role": "user",
                "parts": [
                    {
                        "text": prompt,
                    }
                ],
            }
        ],
        "generationConfig": {
            "temperature": 0,
            "responseMimeType": "application/json",
            "responseSchema": {
                "type": "OBJECT",
                "properties": {
                    "articleId": {
                        "type": "STRING",
                    },
                    "relevant": {
                        "type": "BOOLEAN",
                    },
                    "category": {
                        "type": "STRING",
                        "enum": [
                            "MARKET",
                            "ECONOMIC",
                            "TECHNOLOGY",
                            "GEOPOLITICAL",
                            "REJECT",
                        ],
                    },
                    "sentiment": {
                        "type": "STRING",
                        "enum": [
                            "POSITIVE",
                            "NEGATIVE",
                            "NEUTRAL",
                            "MIXED",
                        ],
                    },
                    "importance": {
                        "type": "STRING",
                        "enum": [
                            "HIGH",
                            "MEDIUM",
                            "LOW",
                        ],
                    },
                    "summary": {
                        "type": "STRING",
                    },
                    "assetClasses": {
                        "type": "ARRAY",
                        "items": {
                            "type": "STRING",
                        },
                    },
                    "geographies": {
                        "type": "ARRAY",
                        "items": {
                            "type": "STRING",
                        },
                    },
                    "sectors": {
                        "type": "ARRAY",
                        "items": {
                            "type": "STRING",
                        },
                    },
                    "investorImpact": {
                        "type": "STRING",
                    },
                    "reasoning": {
                        "type": "STRING",
                    },
                    "fundMonitoringRelevant": {
                        "type": "BOOLEAN",
                    },
                },
                "required": [
                    "articleId",
                    "relevant",
                    "category",
                    "sentiment",
                    "importance",
                    "summary",
                    "assetClasses",
                    "geographies",
                    "sectors",
                    "investorImpact",
                    "reasoning",
                    "fundMonitoringRelevant",
                ],
            },
        },
    }

    request_body = json.dumps(
        payload,
        ensure_ascii=False,
    ).encode("utf-8")

    request = urllib.request.Request(
        GEMINI_URL,
        data=request_body,
        headers={
            "Content-Type": "application/json",
            "x-goog-api-key": API_KEY,
        },
        method="POST",
    )

    log("Sending Gemini request...")

    try:
        with urllib.request.urlopen(
            request,
            timeout=REQUEST_TIMEOUT_SECONDS,
        ) as response:

            raw = response.read()

            status = response.status

    except urllib.error.HTTPError as exc:

        try:
            body = exc.read().decode(
                "utf-8",
                errors="replace",
            )
        except Exception:
            body = ""

        if exc.code == 429:
            raise AnalysisError(
                "Gemini API returned HTTP 429 "
                "(rate limit / quota limit). "
                "Stopping immediately; no retry."
            )

        if exc.code == 503:
            raise AnalysisError(
                "Gemini API returned HTTP 503 "
                "(service unavailable). "
                "Stopping immediately; no retry."
            )

        raise AnalysisError(
            f"Gemini API returned HTTP {exc.code}. "
            f"Response: {body[:2000]}"
        )

    except urllib.error.URLError as exc:
        raise AnalysisError(
            f"Gemini API network error: {exc.reason}. "
            "Stopping immediately; no retry."
        ) from exc

    except TimeoutError as exc:
        raise AnalysisError(
            "Gemini API request timed out. "
            "Stopping immediately; no retry."
        ) from exc

    except Exception as exc:
        raise AnalysisError(
            f"Unexpected Gemini request error: {exc}. "
            "Stopping immediately; no retry."
        ) from exc

    if status != 200:
        raise AnalysisError(
            f"Gemini API returned unexpected HTTP status {status}."
        )

    try:
        response_data = json.loads(
            raw.decode(
                "utf-8"
            )
        )

    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise AnalysisError(
            f"Gemini response is not valid JSON: {exc}"
        ) from exc

    text = extract_response_text(
        response_data
    )

    try:
        result = json.loads(text)

    except json.JSONDecodeError as exc:
        raise AnalysisError(
            f"Gemini returned invalid analysis JSON: {exc}. "
            f"Raw response: {text[:3000]}"
        ) from exc

    if not isinstance(result, dict):
        raise AnalysisError(
            "Gemini analysis result is not a JSON object."
        )

    return result


# ============================================================
# ANALYSIS VALIDATION
# ============================================================

def validate_analysis(
    result: Dict[str, Any],
    article: Dict[str, Any],
) -> Dict[str, Any]:

    missing = REQUIRED_ANALYSIS_FIELDS - set(
        result.keys()
    )

    if missing:
        raise AnalysisError(
            "Gemini analysis is missing required field(s): "
            + ", ".join(sorted(missing))
        )

    article_id = result.get(
        "articleId"
    )

    if article_id != article["id"]:
        raise AnalysisError(
            "Gemini returned incorrect articleId. "
            f"Expected {article['id']}, got {article_id}."
        )

    if not isinstance(
        result["relevant"],
        bool,
    ):
        raise AnalysisError(
            "Gemini field 'relevant' must be boolean."
        )

    if result["category"] not in VALID_CATEGORIES:
        raise AnalysisError(
            f"Invalid category: {result['category']}"
        )

    if result["sentiment"] not in VALID_SENTIMENTS:
        raise AnalysisError(
            f"Invalid sentiment: {result['sentiment']}"
        )

    if result["importance"] not in VALID_IMPORTANCE:
        raise AnalysisError(
            f"Invalid importance: {result['importance']}"
        )

    if not isinstance(
        result["summary"],
        str,
    ) or not result["summary"].strip():

        raise AnalysisError(
            "Gemini field 'summary' must be a non-empty string."
        )

    for field in (
        "assetClasses",
        "geographies",
        "sectors",
    ):
        value = result.get(field)

        if not isinstance(value, list):
            raise AnalysisError(
                f"Gemini field '{field}' must be an array."
            )

        for item in value:
            if not isinstance(item, str):
                raise AnalysisError(
                    f"Gemini field '{field}' must contain "
                    f"only strings."
                )

    for field in (
        "investorImpact",
        "reasoning",
    ):
        value = result.get(field)

        if not isinstance(value, str) or not value.strip():
            raise AnalysisError(
                f"Gemini field '{field}' must be a non-empty string."
            )

    if not isinstance(
        result["fundMonitoringRelevant"],
        bool,
    ):
        raise AnalysisError(
            "Gemini field 'fundMonitoringRelevant' must be boolean."
        )

    # --------------------------------------------------------
    # Attach authoritative collector metadata.
    # --------------------------------------------------------

    final_record = dict(result)

    final_record["articleId"] = article["id"]
    final_record["source"] = article["source"]
    final_record["title"] = article["title"]
    final_record["publishedAtSgt"] = article[
        "publishedAtSgt"
    ]
    final_record["url"] = article["url"]

    # Preserve useful collector classification information.
    if "category" in article:
        final_record["collectorCategory"] = article[
            "category"
        ]

    if "relevanceScore" in article:
        final_record["collectorRelevanceScore"] = article[
            "relevanceScore"
        ]

    if "relevanceReason" in article:
        final_record["collectorRelevanceReason"] = article[
            "relevanceReason"
        ]

    if "collectedAtSgt" in article:
        final_record["collectedAtSgt"] = article[
            "collectedAtSgt"
        ]

    return final_record


# ============================================================
# CURRENT FILE ENVELOPE
# ============================================================

def build_current_output(
    records: List[Dict[str, Any]],
) -> Dict[str, Any]:

    records_sorted = sorted(
        records,
        key=lambda record: (
            parse_sgt_datetime(
                record.get("publishedAtSgt")
            )
            or datetime.min.replace(
                tzinfo=SGT
            )
        ),
        reverse=True,
    )

    return {
        "generatedAtSgt": datetime.now(
            SGT
        ).isoformat(),

        "timezone": "Asia/Singapore",

        "timezoneLabel": "SGT",

        "windowDays": ROLLING_DAYS,

        "articleCount": len(records_sorted),

        "analyses": records_sorted,
    }


# ============================================================
# IMMEDIATE SAVE
# ============================================================

def save_current_analysis(
    records: List[Dict[str, Any]],
) -> None:

    output = build_current_output(
        records
    )

    atomic_write_json(
        ANALYSIS_CURRENT_FILE,
        output,
    )


# ============================================================
# MAIN
# ============================================================

def main() -> int:

    separator()
    log("VGrat FMS - MARKET NEWS AI ANALYZER")
    separator()

    log(f"Model: {MODEL}")
    log(f"Input: {NEWS_FILE.relative_to(ROOT)}")
    log(
        "Output: "
        f"{ANALYSIS_CURRENT_FILE.relative_to(ROOT)}"
    )
    log(
        "Mode: sequential / 1 article per request / newest first"
    )
    log("Retry: DISABLED")
    log("Failure behaviour: STOP IMMEDIATELY")
    log(
        f"Rolling window: {ROLLING_DAYS} publication days"
    )

    try:

        # ----------------------------------------------------
        # LOAD COLLECTOR
        # ----------------------------------------------------

        collector_articles, collector_by_id = (
            load_collector_articles()
        )

        # ----------------------------------------------------
        # LOAD CURRENT ANALYSIS
        # ----------------------------------------------------

        analysis_root, current_records = (
            load_existing_analysis()
        )

        # ----------------------------------------------------
        # LOAD HISTORY
        # ----------------------------------------------------

        history_by_id, history_publication_dates = (
            load_history_records()
        )

        # ----------------------------------------------------
        # RECOVER / VALIDATE EXISTING RECORDS
        # ----------------------------------------------------

        log("Validating existing analysis records...")

        recovered_count = 0

        for record in current_records:

            article_id = record["articleId"]

            before = record.get(
                "publishedAtSgt"
            )

            enriched = enrich_existing_record_metadata(
                record,
                collector_by_id,
                history_by_id,
            )

            after = enriched.get(
                "publishedAtSgt"
            )

            if (
                not parse_sgt_datetime(before)
                and parse_sgt_datetime(after)
            ):
                recovered_count += 1

                log(
                    f"Recovered publishedAtSgt for existing "
                    f"analysis {article_id}."
                )

        if recovered_count:
            log(
                f"Recovered publication metadata for "
                f"{recovered_count} existing analysis record(s)."
            )

        # ----------------------------------------------------
        # DETERMINE ROLLING CUTOFF
        # ----------------------------------------------------

        cutoff_date = calculate_cutoff_date(
            collector_articles
        )

        newest_date = (
            parse_sgt_datetime(
                collector_articles[0]["publishedAtSgt"]
            ).date()
            if collector_articles
            else datetime.now(SGT).date()
        )

        log(
            f"Newest collector publication date: "
            f"{newest_date.isoformat()}"
        )

        log(
            f"14-day cutoff date: "
            f"{cutoff_date.isoformat()}"
        )

        # ----------------------------------------------------
        # ARCHIVE EXPIRED CURRENT RECORDS
        # ----------------------------------------------------

        current_records = archive_expired_current_records(
            current_records,
            collector_by_id,
            history_by_id,
            cutoff_date,
        )

        # Save cleanup/recovery before any Gemini request.
        save_current_analysis(
            current_records
        )

        # ----------------------------------------------------
        # BUILD PROCESSED ID SET
        # ----------------------------------------------------

        processed_ids: Set[str] = set()

        for record in current_records:
            processed_ids.add(
                record["articleId"]
            )

        processed_ids.update(
            history_by_id.keys()
        )

        # ----------------------------------------------------
        # DETERMINE NEW ARTICLES
        # ----------------------------------------------------

        pending_articles: List[
            Dict[str, Any]
        ] = []

        for article in collector_articles:

            article_id = article["id"]

            if article_id in processed_ids:
                continue

            publication_date = publication_date_from_timestamp(
                article["publishedAtSgt"]
            )

            if publication_date is None:
                raise AnalysisError(
                    f"Article {article_id} has invalid "
                    f"publishedAtSgt."
                )

            publication_dt = datetime.strptime(
                publication_date,
                "%Y-%m-%d",
            ).date()

            if publication_dt < cutoff_date:
                # Article is already outside the current rolling
                # window. It should not be analyzed.
                continue

            pending_articles.append(
                article
            )

        log(
            f"Existing/current/history processed IDs: "
            f"{len(processed_ids)}"
        )

        log(
            f"New article(s) requiring Gemini analysis: "
            f"{len(pending_articles)}"
        )

        if not pending_articles:
            log("No new articles require analysis.")

            analysis_root = build_current_output(
                current_records
            )

            atomic_write_json(
                ANALYSIS_CURRENT_FILE,
                analysis_root,
            )

            separator()
            log("ANALYZER COMPLETED")
            separator()

            return 0

        # ----------------------------------------------------
        # PROCESS ONE ARTICLE AT A TIME
        # ----------------------------------------------------

        total_pending = len(
            pending_articles
        )

        successful = 0

        for position, article in enumerate(
            pending_articles,
            start=1,
        ):

            article_id = article["id"]

            publication_date = publication_date_from_timestamp(
                article["publishedAtSgt"]
            )

            log()
            log("-" * 70)
            log(
                f"ARTICLE {position}/{total_pending}"
            )
            log(
                f"ID: {article_id}"
            )
            log(
                f"Published: {article['publishedAtSgt']}"
            )
            log(
                f"Title: {article['title']}"
            )
            log("-" * 70)

            # ------------------------------------------------
            # EXACTLY ONE GEMINI REQUEST
            # ------------------------------------------------

            result = call_gemini(
                article
            )

            # ------------------------------------------------
            # VALIDATE BEFORE SAVE
            # ------------------------------------------------

            final_record = validate_analysis(
                result,
                article,
            )

            # ------------------------------------------------
            # IMMEDIATE SAVE
            # ------------------------------------------------

            current_records.append(
                final_record
            )

            save_current_analysis(
                current_records
            )

            successful += 1

            log(
                f"SUCCESS: Article {article_id} "
                f"saved immediately."
            )

            log(
                f"Successful analyses this run: "
                f"{successful}"
            )

            # ------------------------------------------------
            # DO NOT SLEEP / DO NOT RETRY
            # ------------------------------------------------

        # ----------------------------------------------------
        # FINALIZE
        # ----------------------------------------------------

        save_current_analysis(
            current_records
        )

        separator()
        log("ANALYZER COMPLETED")
        separator()

        log(
            f"Successful analyses this run: {successful}"
        )

        log(
            f"Total current analyses: "
            f"{len(current_records)}"
        )

        log(
            "All successful results were saved immediately."
        )

        return 0

    except AnalysisError as exc:

        separator()
        log("ANALYZER STOPPED")
        separator()

        log(str(exc))

        separator()
        log(
            "No further Gemini requests will be made."
        )
        log(
            "Previously successful analyses remain saved on disk."
        )
        separator()

        return 1

    except KeyboardInterrupt:

        separator()
        log("ANALYZER INTERRUPTED")
        separator()

        log(
            "No further Gemini requests will be made."
        )
        log(
            "Previously successful analyses remain saved on disk."
        )
        separator()

        return 1

    except Exception as exc:

        separator()
        log("ANALYZER STOPPED")
        separator()

        log(
            f"Unexpected code/runtime error: "
            f"{type(exc).__name__}: {exc}"
        )

        separator()
        log(
            "No further Gemini requests will be made."
        )
        log(
            "Previously successful analyses remain saved on disk."
        )
        separator()

        return 1


if __name__ == "__main__":
    sys.exit(main())
