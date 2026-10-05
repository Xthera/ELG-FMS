#!/usr/bin/env python3

"""
VGrat FMS - CNBC Market News Collector
=====================================

Collect relevant CNBC news for VGrat FMS.

ALL DATE/TIME HANDLING
======================

Singapore Time (SGT) is the authoritative timezone.

Timezone:
    Asia/Singapore
    UTC+08:00
    No daylight-saving-time adjustment

All saved timestamps use SGT:

    publishedAtSgt
    collectedAtSgt
    updatedAtSgt
    generatedAtSgt

Historical archive folders and filenames are also based on the
Singapore calendar date.

FINAL CATEGORIES
================

    MARKET
    ECONOMIC
    TECHNOLOGY
    GEOPOLITICAL
    REJECT

CLASSIFICATION PRINCIPLES
=========================

1. The headline is the primary source of truth.

2. Exact words / phrases are matched using word boundaries.
   This prevents false substring matches such as:

       factory -> actor

3. Hard exclusions are applied to clearly non-financial stories.

4. Strong economic indicators in the headline are sufficient by
   themselves.

5. Financial-market legal and corporate stories are retained.

6. Technology stories require a concrete business, infrastructure,
   semiconductor, AI policy, AI investment, payments, cybersecurity,
   or technology-government angle.

7. Geopolitical stories require a direct economic mechanism such as:

       oil
       energy
       shipping
       Hormuz
       sanctions
       tariffs
       trade
       semiconductor supply
       export controls

8. Description text is supporting evidence only.

9. A generic political/commentary headline cannot be rescued solely
   by economic/geopolitical words appearing in the description.

CURRENT NEWS
============

Rolling window:
    14 days

Maximum current records:
    100

Historical archive:
    unlimited
"""

from __future__ import annotations

import hashlib
import json
import re
from calendar import timegm
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit, urlunsplit
from zoneinfo import ZoneInfo

import feedparser
import requests
import trafilatura
from bs4 import BeautifulSoup


# ============================================================================
# CONFIGURATION
# ============================================================================

SOURCE_NAME = "CNBC"

BASE_DIR = Path(__file__).resolve().parent.parent

NEWS_DIR = BASE_DIR / "data" / "market_news"
HISTORY_DIR = NEWS_DIR / "history"

CURRENT_FILE = NEWS_DIR / "current.json"

WINDOW_DAYS = 14
MAX_CURRENT_ARTICLES = 100

REQUEST_TIMEOUT = 25

# Maximum summary length.
SUMMARY_MAX_CHARS = 500

# ---------------------------------------------------------------------------
# SINGAPORE TIME
# ---------------------------------------------------------------------------
#
# SGT is the authoritative timezone for this collector.
#
# Python's zoneinfo module is part of the Python standard library.
# No additional package is required.
#
# Singapore remains UTC+08:00 throughout the year and does not observe DST.
# ---------------------------------------------------------------------------

SGT = ZoneInfo("Asia/Singapore")

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/154.0.0.0 Safari/537.36"
)


# ============================================================================
# CNBC RSS FEEDS
# ============================================================================

CNBC_FEEDS = {
    "latest": (
        "https://www.cnbc.com/id/100003114/"
        "device/rss/rss.html"
    ),
    "business": (
        "https://www.cnbc.com/id/10001147/"
        "device/rss/rss.html"
    ),
    "finance": (
        "https://www.cnbc.com/id/10000664/"
        "device/rss/rss.html"
    ),
    "economy": (
        "https://www.cnbc.com/id/20910258/"
        "device/rss/rss.html"
    ),
    "technology": (
        "https://www.cnbc.com/id/19854910/"
        "device/rss/rss.html"
    ),
    "world": (
        "https://www.cnbc.com/id/100727362/"
        "device/rss/rss.html"
    ),
}


# ============================================================================
# HARD EXCLUSIONS
# ============================================================================

SPORTS_STRONG = {
    "football",
    "soccer",
    "rugby",
    "cricket",
    "tennis",
    "golf",
    "basketball",
    "baseball",
    "badminton",
    "volleyball",
    "formula 1",
    "formula one",
    "f1",
    "premier league",
    "champions league",
    "world cup",
    "asian games",
    "olympics",
    "olympic games",
    "paralympics",
    "grand slam",
    "gold medal",
    "silver medal",
    "bronze medal",
    "medal",
    "medals",
    "athlete",
    "athletes",
    "player",
    "players",
    "wallabies",
    "bledisloe",
    "goalkeeper",
    "striker",
    "midfielder",
    "defender",
    "wicket",
    "batting",
    "bowling",
    "tournament",
    "tournaments",
    "championship",
    "championships",
    "match",
    "matches",
    "squad",
    "coach",
    "football club",
    "football clubs",
    "man city",
    "manchester city",
    "international football",
    "international rugby",
    "international cricket",
    "ancelotti",
    "vinicius",
}


ENTERTAINMENT_STRONG = {
    "movie",
    "movies",
    "film",
    "films",
    "actor",
    "actors",
    "actress",
    "actresses",
    "singer",
    "singers",
    "concert",
    "concerts",
    "celebrity",
    "celebrities",
    "album",
    "albums",
    "red carpet",
    "box office",
    "television series",
    "tv series",
    "reality show",
    "reality tv",
    "movie role",
    "film role",
    "writers festival",
    "film festival",
    "music festival",
}


LIFESTYLE_STRONG = {
    "bakery",
    "restaurant",
    "restaurants",
    "cafe",
    "coffee shop",
    "recipe",
    "recipes",
    "fashion",
    "beauty",
    "wellness",
    "dating",
    "wedding",
    "birthday",
    "viral video",
    "influencer",
    "pet",
    "pets",
    "food outlet",
    "opening first",
}


ACCIDENT_STRONG = {
    "car crash",
    "car accident",
    "road accident",
    "traffic accident",
    "plane crash",
    "aircraft crash",
    "train crash",
    "train accident",
    "bus crash",
    "building collapse",
    "house fire",
    "flat fire",
    "fire kills",
    "fire killed",
    "dies after fire",
    "died after fire",
    "killed in crash",
    "killed in accident",
    "swept away",
    "avalanche",
    "landslide",
    "drowning",
}


CRIME_STRONG = {
    "murder",
    "murdered",
    "homicide",
    "robbery",
    "robbed",
    "burglary",
    "burglars",
    "drug trafficking",
    "drug trafficker",
    "drugs seized",
    "drug seized",
    "charged with",
    "jailed for",
    "sentenced to jail",
    "sentenced to prison",
    "arrested for",
    "arrested after",
    "police investigation",
    "police said",
    "criminal investigation",
    "crime investigation",
    "assaulted",
    "stole",
    "stolen",
    "thieves",
    "theft",
    "jail for",
    "prison for",
}


WEATHER_STRONG = {
    "weather forecast",
    "rainy days",
    "rainfall",
    "heatwave",
    "heat wave",
    "typhoon",
    "hurricane",
    "tornado",
}


# ============================================================================
# ECONOMIC SIGNALS
# ============================================================================

ECONOMIC_STRONG = {
    "gdp",
    "gross domestic product",
    "inflation",
    "deflation",
    "consumer price index",
    "producer price index",
    "cpi",
    "ppi",
    "pmi",
    "purchasing managers index",
    "economic growth",
    "economic contraction",
    "economic recession",
    "economic outlook",
    "economic activity",
    "economic data",
    "economic indicators",
    "industrial production",
    "industrial output",
    "factory output",
    "factory production",
    "manufacturing output",
    "manufacturing production",
    "manufacturing activity",
    "manufacturing sector",
    "retail sales",
    "consumer spending",
    "consumer confidence",
    "business confidence",
    "employment",
    "unemployment",
    "unemployment rate",
    "jobs data",
    "payroll",
    "payrolls",
    "wage growth",
    "productivity",
    "exports",
    "export growth",
    "imports",
    "import growth",
    "trade surplus",
    "trade deficit",
    "trade balance",
    "trade data",
    "industrial activity",
    "business activity",
    "cost of living",
    "electricity tariffs",
    "gas tariffs",
    "utility tariffs",
    "household tariffs",
}


# ============================================================================
# MARKET SIGNALS
# ============================================================================

MARKET_STRONG = {
    "stock market",
    "stock markets",
    "stocks",
    "shares",
    "share price",
    "share prices",
    "equities",
    "equity market",
    "financial markets",
    "investor",
    "investors",
    "investment",
    "investments",
    "portfolio",
    "portfolios",
    "asset manager",
    "asset managers",
    "asset management",
    "fund manager",
    "fund managers",
    "mutual fund",
    "mutual funds",
    "fundraising",
    "fundraise",
    "funding",
    "funding round",
    "raises",
    "raised",
    "raise",
    "ipo",
    "ipos",
    "initial public offering",
    "listing",
    "listed company",
    "listed companies",
    "earnings",
    "profit",
    "profits",
    "revenue",
    "revenues",
    "dividend",
    "dividends",
    "merger",
    "mergers",
    "acquisition",
    "acquisitions",
    "takeover",
    "takeovers",
    "valuation",
    "valuations",
    "capital expenditure",
    "capex",
    "credit line",
    "credit lines",
    "banking sector",
    "banking",
    "bank",
    "banks",
    "insurance",
    "insurer",
    "insurers",
    "bond",
    "bonds",
    "bond yields",
    "yield",
    "yields",
    "treasury yields",
    "interest rate",
    "interest rates",
    "rate hike",
    "rate hikes",
    "rate cut",
    "rate cuts",
    "central bank",
    "central banks",
    "monetary policy",
    "forex",
    "foreign exchange",
    "currency market",
    "commodities",
    "commodity prices",
    "oil prices",
    "oil rises",
    "oil gains",
    "oil falls",
    "oil down",
    "gold prices",
    "real estate market",
    "property market",
    "property prices",
    "reit",
    "reits",
    "payments",
    "payment",
    "digital payments",
    "mobile payments",
    "fintech",
}


# ============================================================================
# TECHNOLOGY SIGNALS
# ============================================================================

TECHNOLOGY_STRONG = {
    "semiconductor",
    "semiconductors",
    "semiconductor industry",
    "semiconductor sector",
    "chipmaking",
    "chip maker",
    "chipmakers",
    "chip hub",
    "chip hubs",
    "advanced chip",
    "advanced chips",
    "ai chip",
    "ai chips",
    "ai infrastructure",
    "ai infra",
    "data centre",
    "data centres",
    "data center",
    "data centers",
    "cloud computing",
    "technology investment",
    "technology investments",
    "technology funding",
    "technology standards",
    "technology sector",
    "technology company",
    "technology companies",
    "tech company",
    "tech companies",
    "tech executives",
    "technology executives",
    "venture capital",
    "private equity",
    "startup funding",
    "funding round",
    "artificial intelligence",
    "ai sector",
    "ai safety",
    "ai policy",
    "ai regulation",
    "ai regulations",
    "ai investment",
    "ai investments",
    "ai spending",
    "ai capex",
    "ai accord",
    "ai agreement",
    "ai pact",
    "ai safety pact",
    "ai document",
    "ai standards",
    "technology stocktake",
    "digital infrastructure",
    "digital economy",
    "digital payments",
    "mobile payments",
    "fintech",
    "chip programming",
    "chip programming tools",
    "chip development",
    "chip development tools",
    "nvidia",
    "deepseek",
    "openai",
    "anthropic",
    "tesla",
    "apple",
    "microsoft",
    "google",
    "amazon",
    "meta",
    "apple pay",
    "ai hack",
    "cybersecurity",
    "cyber attack",
}


# ============================================================================
# FINANCIAL / LEGAL / CORPORATE SIGNALS
# ============================================================================

FINANCIAL_LEGAL_STRONG = {
    "false trading",
    "market manipulation",
    "securities fraud",
    "securities law",
    "insider trading",
    "insider dealing",
    "shareholder",
    "shareholders",
    "listed company",
    "listed companies",
    "financial misconduct",
    "market-making",
    "market making",
    "market maker",
    "market makers",
    "trading services",
    "brokerage",
    "broker",
    "brokers",
    "securities",
    "stock exchange",
    "exchange operator",
    "financial regulator",
    "financial regulators",
    "banking regulator",
    "banking regulators",
    "market regulator",
    "market regulators",
    "receivership",
    "receiver",
    "receivers",
    "holding company",
    "holding companies",
    "corporate restructuring",
    "corporate restructuring",
    "insolvency",
    "insolvent",
    "liquidation",
    "liquidator",
    "liquidators",
    "winding up",
    "wound up",
    "administrators appointed",
    "administrator appointed",
    "restructuring",
    "restructuring plan",
}


# ============================================================================
# GEOPOLITICAL ECONOMIC IMPACT SIGNALS
# ============================================================================

GEOPOLITICAL_ECONOMIC_STRONG = {
    "sanction",
    "sanctions",
    "export controls",
    "trade restrictions",
    "import restrictions",
    "trade war",
    "tariff",
    "tariffs",
    "shipping disruption",
    "shipping disruptions",
    "shipping route",
    "shipping routes",
    "shipping lanes",
    "strait of hormuz",
    "hormuz",
    "taiwan strait",
    "south china sea",
    "rare earth",
    "rare earths",
    "strategic minerals",
    "energy security",
    "oil supply",
    "oil shipments",
    "oil loading",
    "gas supply",
    "gas shipments",
    "pipeline",
    "pipelines",
    "energy supply",
    "energy exports",
    "energy imports",
    "oil exports",
    "oil imports",
    "trade flows",
    "trade",
    "energy",
    "semiconductor",
    "semiconductors",
    "chip supply",
    "chip supplies",
    "chip exports",
    "chip imports",
}


# ============================================================================
# POLITICAL TERMS
# ============================================================================

POLITICAL_TERMS = {
    "president",
    "prime minister",
    "minister",
    "ministers",
    "lawmaker",
    "lawmakers",
    "politician",
    "politicians",
    "election",
    "elections",
    "political party",
    "political parties",
    "parliament",
    "parliamentary",
    "government",
    "government's",
    "diplomatic",
    "diplomacy",
    "ambassador",
    "bilateral",
    "summit",
    "resignation",
    "resigns",
    "resigned",
    "pledge",
    "pledged",
    "statement",
    "statements",
    "commentary",
    "comment",
}


# ============================================================================
# NON-ECONOMIC POLICY
# ============================================================================

NON_ECONOMIC_POLICY_TERMS = {
    "psle",
    "primary school leaving examination",
    "dsa",
    "direct school admission",
    "school admission",
    "school admissions",
    "education policy",
    "education system",
    "school system",
    "hdb household",
    "hdb households",
    "u-save",
    "s&cc",
    "s&cc rebates",
    "rebates",
}


# ============================================================================
# TEXT MATCHING
# ============================================================================

def normalize_text(
    value: Any,
) -> str:
    if value is None:
        return ""

    text = str(value)

    text = BeautifulSoup(
        text,
        "html.parser",
    ).get_text(
        " ",
        strip=True,
    )

    text = re.sub(
        r"\s+",
        " ",
        text,
    )

    return text.strip()


def phrase_matches(
    text: str,
    phrases: set[str] | list[str],
) -> list[str]:
    """
    Match complete words / phrases.

    IMPORTANT:
    We do NOT use:

        phrase in text

    because that creates errors such as:

        factory -> actor

    Instead each phrase is treated as a word-boundary expression.
    """

    text = normalize_text(
        text
    ).lower()

    matches = []

    for phrase in phrases:
        phrase = phrase.strip().lower()

        if not phrase:
            continue

        pattern = (
            r"(?<!\w)"
            + re.escape(phrase)
            + r"(?!\w)"
        )

        if re.search(
            pattern,
            text,
        ):
            matches.append(
                phrase
            )

    return matches


def has_any_phrase(
    text: str,
    phrases: set[str],
) -> bool:
    return bool(
        phrase_matches(
            text,
            phrases,
        )
    )


# ============================================================================
# SUMMARY SHORTENING
# ============================================================================

def shorten(
    text: str,
    max_chars: int = SUMMARY_MAX_CHARS,
) -> str:
    """
    Safely shorten text for permanent news summaries.

    This helper is intentionally conservative:
    - normalize HTML/whitespace
    - preserve complete sentences where possible
    - never return an oversized summary
    """

    text = normalize_text(
        text
    )

    if not text:
        return ""

    if len(text) <= max_chars:
        return text

    candidate = text[:max_chars]

    sentence_breaks = [
        candidate.rfind(". "),
        candidate.rfind("! "),
        candidate.rfind("? "),
    ]

    best_break = max(
        sentence_breaks
    )

    if best_break >= int(
        max_chars * 0.55
    ):
        return candidate[
            : best_break + 1
        ].strip()

    last_space = candidate.rfind(
        " "
    )

    if last_space >= int(
        max_chars * 0.70
    ):
        return (
            candidate[
                :last_space
            ].rstrip()
            + "..."
        )

    return (
        candidate.rstrip()
        + "..."
    )


# ============================================================================
# SGT DATETIME HELPERS
# ============================================================================

def now_sgt() -> datetime:
    """
    Return the current date/time in Singapore Time.
    """

    return datetime.now(
        SGT
    )


def format_sgt(
    value: datetime,
) -> str:
    """
    Convert an aware datetime to SGT and return an ISO-8601 string.

    Example:

        2026-10-03T02:00:00+08:00
    """

    if value.tzinfo is None:
        value = value.replace(
            tzinfo=SGT
        )

    return (
        value
        .astimezone(
            SGT
        )
        .replace(
            microsecond=0
        )
        .isoformat()
    )


def parse_sgt_datetime(
    value: str,
) -> datetime:
    """
    Parse an ISO timestamp and convert it to SGT.

    Supports both the new SGT format:

        2026-10-03T02:00:00+08:00

    and legacy UTC format:

        2026-10-02T18:00:00Z

    This allows the collector to safely read existing historical
    records created before the SGT migration.
    """

    parsed = datetime.fromisoformat(
        value.replace(
            "Z",
            "+00:00",
        )
    )

    if parsed.tzinfo is None:
        parsed = parsed.replace(
            tzinfo=SGT
        )

    return parsed.astimezone(
        SGT
    )


# ============================================================================
# SPECIALIZED CONTEXT RULES
# ============================================================================

def technology_business_context(
    title: str,
) -> bool:
    """
    Determine whether technology has a concrete economic/business/
    infrastructure/regulatory significance.
    """

    lower = normalize_text(
        title
    ).lower()

    direct_technology_topics = {
        "technology stocktake",
        "ai hack",
        "apple pay",
        "digital payments",
        "mobile payments",
        "fintech",
        "chip programming",
        "chip programming tools",
        "semiconductor industry",
        "semiconductor sector",
        "chip hubs",
        "chip hub",
        "ai infrastructure",
        "ai infra",
        "data centre",
        "data centres",
        "data center",
        "data centers",
        "ai accord",
        "ai agreement",
        "ai pact",
        "ai safety pact",
        "technology standards",
        "ai standards",
        "ai regulation",
        "ai regulations",
        "ai policy",
        "ai investment",
        "ai investments",
        "ai spending",
        "ai capex",
        "cybersecurity",
        "cyber attack",
    }

    if has_any_phrase(
        lower,
        direct_technology_topics,
    ):
        return True

    if has_any_phrase(
        lower,
        {
            "ai",
            "artificial intelligence",
        },
    ):
        if has_any_phrase(
            lower,
            {
                "accord",
                "agreement",
                "pact",
                "standards",
                "regulation",
                "regulations",
                "policy",
                "investment",
                "investments",
                "funding",
                "fund",
                "valuation",
                "ipo",
                "capex",
                "data centre",
                "data center",
                "infrastructure",
                "executives",
                "ceos",
                "safety",
                "hack",
            },
        ):
            return True

    if has_any_phrase(
        lower,
        {
            "chip",
            "chips",
            "semiconductor",
            "semiconductors",
        },
    ):
        if has_any_phrase(
            lower,
            {
                "industry",
                "sector",
                "hub",
                "hubs",
                "race",
                "manufacturing",
                "manufacture",
                "production",
                "exports",
                "imports",
                "supply",
                "programming",
                "tools",
                "investment",
                "investments",
                "nvidia",
                "huawei",
                "deepseek",
            },
        ):
            return True

    if has_any_phrase(
        lower,
        {
            "cybersecurity",
            "cyber attack",
            "ai hack",
        },
    ):
        if has_any_phrase(
            lower,
            {
                "government",
                "technology",
                "tech",
                "company",
                "companies",
                "infrastructure",
                "data",
                "systems",
                "stocktake",
            },
        ):
            return True

    return False


def market_business_context(
    title: str,
) -> bool:
    """
    Detect concrete market/business events.
    """

    lower = normalize_text(
        title
    ).lower()

    if has_any_phrase(
        lower,
        FINANCIAL_LEGAL_STRONG,
    ):
        return True

    if has_any_phrase(
        lower,
        {
            "funding",
            "fundraise",
            "fundraising",
            "raised",
            "raises",
            "raise",
        },
    ):
        if has_any_phrase(
            lower,
            {
                "$",
                "billion",
                "million",
                "valuation",
                "ipo",
                "invest",
                "investment",
                "fund",
            },
        ):
            return True

    if has_any_phrase(
        lower,
        {
            "payment",
            "payments",
            "apple pay",
            "fintech",
        },
    ):
        if has_any_phrase(
            lower,
            {
                "bank",
                "banks",
                "partnership",
                "launches",
                "market",
            },
        ):
            return True

    return False


def is_commentary_title(
    title: str,
) -> bool:
    """
    Identify commentary / analysis / opinion / explainer headlines.

    These are rejected unless they were already captured by a direct
    market/economic/technology/geopolitical title signal.
    """

    title_lower = normalize_text(
        title
    ).lower()

    if re.match(
        r"^\s*commentary\s*:",
        title_lower,
    ):
        return True

    if re.match(
        r"^\s*analysis\s*:",
        title_lower,
    ):
        return True

    if re.match(
        r"^\s*opinion\s*:",
        title_lower,
    ):
        return True

    if re.match(
        r"^\s*explainer\s*:",
        title_lower,
    ):
        return True

    if re.match(
        r"^\s*what\s+is\b",
        title_lower,
    ):
        return True

    if re.match(
        r"^\s*what\s+does\b",
        title_lower,
    ):
        return True

    return False


# ============================================================================
# CLASSIFIER
# ============================================================================

def classify_relevance(
    title: str,
    description: str,
) -> dict[str, Any]:

    title = normalize_text(
        title
    )

    description = normalize_text(
        description
    )

    title_lower = title.lower()
    description_lower = description.lower()

    sports = phrase_matches(
        title_lower,
        SPORTS_STRONG,
    )

    entertainment = phrase_matches(
        title_lower,
        ENTERTAINMENT_STRONG,
    )

    lifestyle = phrase_matches(
        title_lower,
        LIFESTYLE_STRONG,
    )

    accident = phrase_matches(
        title_lower,
        ACCIDENT_STRONG,
    )

    crime = phrase_matches(
        title_lower,
        CRIME_STRONG,
    )

    weather = phrase_matches(
        title_lower,
        WEATHER_STRONG,
    )

    policy = phrase_matches(
        title_lower,
        NON_ECONOMIC_POLICY_TERMS,
    )

    economic = phrase_matches(
        title_lower,
        ECONOMIC_STRONG,
    )

    market = phrase_matches(
        title_lower,
        MARKET_STRONG,
    )

    technology = phrase_matches(
        title_lower,
        TECHNOLOGY_STRONG,
    )

    financial_legal = phrase_matches(
        title_lower,
        FINANCIAL_LEGAL_STRONG,
    )

    geopolitical = phrase_matches(
        title_lower,
        GEOPOLITICAL_ECONOMIC_STRONG,
    )

    political = phrase_matches(
        title_lower,
        POLITICAL_TERMS,
    )

    technology_context = technology_business_context(
        title_lower
    )

    market_context = market_business_context(
        title_lower
    )

    commentary_title = is_commentary_title(
        title_lower
    )

    if financial_legal:
        return {
            "relevant": True,
            "category": "MARKET",
            "score": 100,
            "reason": "financial_market_legal_story",
            "matchedKeywords": financial_legal,
        }

    if market_context:
        return {
            "relevant": True,
            "category": "MARKET",
            "score": 95,
            "reason": "business_market_event",
            "matchedKeywords": [],
        }

    if sports:
        return {
            "relevant": False,
            "category": "REJECT",
            "score": 0,
            "reason": "sports",
            "matchedKeywords": sports,
        }

    if accident:
        return {
            "relevant": False,
            "category": "REJECT",
            "score": 0,
            "reason": "accident_human_interest",
            "matchedKeywords": accident,
        }

    if crime:
        return {
            "relevant": False,
            "category": "REJECT",
            "score": 0,
            "reason": "crime_human_interest",
            "matchedKeywords": crime,
        }

    if entertainment:
        if not (
            market
            or technology_context
            or market_context
        ):
            return {
                "relevant": False,
                "category": "REJECT",
                "score": 0,
                "reason": "entertainment",
                "matchedKeywords": entertainment,
            }

    if lifestyle:
        if not (
            market
            or technology_context
            or market_context
        ):
            return {
                "relevant": False,
                "category": "REJECT",
                "score": 0,
                "reason": "lifestyle",
                "matchedKeywords": lifestyle,
            }

    if weather:
        if not (
            economic
            or market
        ):
            return {
                "relevant": False,
                "category": "REJECT",
                "score": 0,
                "reason": "weather",
                "matchedKeywords": weather,
            }

    if policy:
        if not (
            economic
            or market
            or financial_legal
            or market_context
        ):
            return {
                "relevant": False,
                "category": "REJECT",
                "score": 0,
                "reason": "non_economic_social_policy",
                "matchedKeywords": policy,
            }

    if economic:
        return {
            "relevant": True,
            "category": "ECONOMIC",
            "score": 100 + len(economic),
            "reason": "strong_economic_title",
            "matchedKeywords": economic,
        }

    if market:
        return {
            "relevant": True,
            "category": "MARKET",
            "score": 90 + len(market),
            "reason": "strong_market_title",
            "matchedKeywords": market,
        }

    if technology:
        if technology_context:
            return {
                "relevant": True,
                "category": "TECHNOLOGY",
                "score": 80 + len(technology),
                "reason": "technology_business_or_infrastructure",
                "matchedKeywords": technology,
            }

    if technology_context:
        return {
            "relevant": True,
            "category": "TECHNOLOGY",
            "score": 80,
            "reason": "technology_business_or_infrastructure",
            "matchedKeywords": technology,
        }

    if geopolitical:
        return {
            "relevant": True,
            "category": "GEOPOLITICAL",
            "score": 70 + len(geopolitical),
            "reason": "geopolitical_with_direct_economic_impact",
            "matchedKeywords": geopolitical,
        }

    if commentary_title:
        return {
            "relevant": False,
            "category": "REJECT",
            "score": 0,
            "reason": "political_commentary_without_direct_market_signal",
            "matchedKeywords": [
                "commentary"
            ],
        }

    if political:
        return {
            "relevant": False,
            "category": "REJECT",
            "score": 0,
            "reason": "political_without_market_or_economic_impact",
            "matchedKeywords": political,
        }

    description_economic = phrase_matches(
        description_lower,
        ECONOMIC_STRONG,
    )

    description_market = phrase_matches(
        description_lower,
        MARKET_STRONG,
    )

    description_technology = phrase_matches(
        description_lower,
        TECHNOLOGY_STRONG,
    )

    description_geopolitical = phrase_matches(
        description_lower,
        GEOPOLITICAL_ECONOMIC_STRONG,
    )

    if len(description_economic) >= 2:
        return {
            "relevant": True,
            "category": "ECONOMIC",
            "score": 60 + len(description_economic),
            "reason": "supporting_economic_description",
            "matchedKeywords": description_economic,
        }

    if len(description_market) >= 2:
        return {
            "relevant": True,
            "category": "MARKET",
            "score": 55 + len(description_market),
            "reason": "supporting_market_description",
            "matchedKeywords": description_market,
        }

    if len(description_technology) >= 2:
        if has_any_phrase(
            description_lower,
            {
                "technology",
                "artificial intelligence",
                "semiconductor",
                "chip",
                "ai",
                "digital",
                "cyber",
            },
        ):
            return {
                "relevant": True,
                "category": "TECHNOLOGY",
                "score": 50 + len(description_technology),
                "reason": "supporting_technology_description",
                "matchedKeywords": description_technology,
            }

    if len(description_geopolitical) >= 2:
        return {
            "relevant": True,
            "category": "GEOPOLITICAL",
            "score": 50 + len(description_geopolitical),
            "reason": "supporting_geopolitical_economic_description",
            "matchedKeywords": description_geopolitical,
        }

    return {
        "relevant": False,
        "category": "REJECT",
        "score": 0,
        "reason": "insufficient_market_relevance",
        "matchedKeywords": [],
    }


# ============================================================================
# RSS DATE PARSING
# ============================================================================

def parse_entry_datetime(
    entry: Any,
) -> datetime:
    """
    Parse CNBC RSS time.

    RSS timestamps represent an absolute point in time. We first parse
    them as UTC and immediately convert them to SGT.

    If the feed does not provide a usable timestamp, the current SGT
    time is used.
    """

    parsed = getattr(
        entry,
        "published_parsed",
        None,
    )

    if parsed is None:
        parsed = getattr(
            entry,
            "updated_parsed",
            None,
        )

    if parsed:
        try:
            utc_datetime = datetime.fromtimestamp(
                timegm(parsed),
                tz=timezone.utc,
            )

            return utc_datetime.astimezone(
                SGT
            )

        except Exception:
            pass

    return now_sgt()


# ============================================================================
# RSS FETCH
# ============================================================================

def fetch_feed(
    feed_name: str,
    feed_url: str,
) -> list[dict[str, Any]]:

    print(
        f"\nFetching CNBC feed: {feed_name}"
    )

    try:
        response = requests.get(
            feed_url,
            headers={
                "User-Agent": USER_AGENT,
                "Accept": (
                    "application/rss+xml, "
                    "application/xml, "
                    "text/xml"
                ),
            },
            timeout=REQUEST_TIMEOUT,
        )

        response.raise_for_status()

        parsed = feedparser.parse(
            response.content
        )

        records = []

        for entry in parsed.entries:

            title = normalize_text(
                getattr(
                    entry,
                    "title",
                    "",
                )
            )

            description = normalize_text(
                getattr(
                    entry,
                    "summary",
                    getattr(
                        entry,
                        "description",
                        "",
                    ),
                )
            )

            url = normalize_text(
                getattr(
                    entry,
                    "link",
                    "",
                )
            )

            if not title or not url:
                continue

            published = parse_entry_datetime(
                entry
            )

            records.append(
                {
                    "feed": feed_name,
                    "title": title,
                    "description": description,
                    "url": canonicalize_url(
                        url
                    ),
                    "publishedAtSgt": format_sgt(
                        published
                    ),
                }
            )

        print(
            f"  Entries: {len(records)}"
        )

        return records

    except Exception as exc:

        print(
            "  ERROR:",
            type(exc).__name__,
            str(exc),
        )

        return []


def collect_rss() -> list[dict[str, Any]]:

    records = []

    for feed_name, feed_url in CNBC_FEEDS.items():
        records.extend(
            fetch_feed(
                feed_name,
                feed_url,
            )
        )

    return records


# ============================================================================
# URL CANONICALIZATION
# ============================================================================

def canonicalize_url(
    url: str,
) -> str:

    if not url:
        return ""

    try:
        parts = urlsplit(
            url.strip()
        )

        query = []

        for item in parts.query.split(
            "&"
        ):
            if not item:
                continue

            key = item.split(
                "=",
                1,
            )[0].lower()

            if key.startswith(
                "utm_"
            ):
                continue

            if key in {
                "fbclid",
                "gclid",
                "mc_cid",
                "mc_eid",
            }:
                continue

            query.append(
                item
            )

        return urlunsplit(
            (
                parts.scheme.lower(),
                parts.netloc.lower(),
                parts.path.rstrip("/"),
                "&".join(query),
                "",
            )
        )

    except Exception:
        return url.strip()


# ============================================================================
# ARTICLE ID
# ============================================================================

def article_id(
    source: str,
    url: str,
) -> str:

    raw = (
        f"{source}|"
        f"{canonicalize_url(url)}"
    ).encode(
        "utf-8"
    )

    return hashlib.sha256(
        raw
    ).hexdigest()


# ============================================================================
# ARTICLE EXTRACTION
# ============================================================================

def fetch_article_text(
    url: str,
) -> str:

    response = requests.get(
        url,
        headers={
            "User-Agent": USER_AGENT,
            "Accept": (
                "text/html,"
                "application/xhtml+xml"
            ),
        },
        timeout=REQUEST_TIMEOUT,
    )

    response.raise_for_status()

    html = response.text

    extracted = trafilatura.extract(
        html,
        include_comments=False,
        include_tables=False,
        favor_precision=True,
    )

    if extracted:
        return normalize_text(
            extracted
        )

    soup = BeautifulSoup(
        html,
        "html.parser",
    )

    for tag in soup(
        [
            "script",
            "style",
            "noscript",
            "nav",
            "footer",
            "header",
        ]
    ):
        tag.decompose()

    paragraphs = []

    for paragraph in soup.find_all(
        "p"
    ):

        value = normalize_text(
            paragraph.get_text(
                " ",
                strip=True,
            )
        )

        if len(value) >= 40:
            paragraphs.append(
                value
            )

    return normalize_text(
        " ".join(
            paragraphs
        )
    )


# ============================================================================
# SUMMARY
# ============================================================================

def split_sentences(
    text: str,
) -> list[str]:

    text = normalize_text(
        text
    )

    if not text:
        return []

    return [
        item.strip()
        for item in re.split(
            r"(?<=[.!?])\s+",
            text,
        )
        if len(
            item.strip()
        ) >= 45
    ]


def generate_summary(
    title: str,
    description: str,
    article_text: str,
) -> str:

    sentences = split_sentences(
        article_text
    )

    if not sentences:
        fallback = (
            description
            or title
        )

        return shorten(
            fallback
        )

    important_terms = [
        "stock",
        "stocks",
        "shares",
        "equities",
        "investor",
        "investors",
        "investment",
        "economy",
        "economic",
        "growth",
        "inflation",
        "interest rate",
        "central bank",
        "bank",
        "bond",
        "yield",
        "currency",
        "trade",
        "tariff",
        "oil",
        "energy",
        "technology",
        "semiconductor",
        "chip",
        "artificial intelligence",
        "ai",
        "gdp",
        "manufacturing",
        "factory output",
        "industrial production",
        "exports",
        "imports",
        "ipo",
        "funding",
        "valuation",
        "payments",
        "fintech",
    ]

    scored = []

    for index, sentence in enumerate(
        sentences
    ):

        lower = sentence.lower()

        score = sum(
            1
            for term in important_terms
            if re.search(
                r"(?<!\w)"
                + re.escape(term)
                + r"(?!\w)",
                lower,
            )
        )

        scored.append(
            (
                score,
                -index,
                sentence,
            )
        )

    scored.sort(
        key=lambda item: (
            item[0],
            item[1],
        ),
        reverse=True,
    )

    selected = {
        item[2]
        for item in scored[:3]
    }

    ordered = [
        sentence
        for sentence in sentences
        if sentence in selected
    ][:3]

    return shorten(
        " ".join(
            ordered
        )
    )


# ============================================================================
# JSON HELPERS
# ============================================================================

def load_json(
    path: Path,
    default: Any,
) -> Any:

    if not path.exists():
        return default

    try:
        with path.open(
            "r",
            encoding="utf-8",
        ) as handle:
            return json.load(
                handle
            )

    except Exception as exc:

        print(
            f"WARNING: Failed reading {path}: "
            f"{type(exc).__name__}: {exc}"
        )

        return default


# ============================================================================
# HISTORY
# ============================================================================

def load_existing_history_ids() -> set[str]:

    result = set()

    if not HISTORY_DIR.exists():
        return result

    for path in HISTORY_DIR.rglob(
        "*.json"
    ):

        data = load_json(
            path,
            {},
        )

        for article in data.get(
            "articles",
            [],
        ):

            if isinstance(
                article,
                dict,
            ):

                value = article.get(
                    "id"
                )

                if value:
                    result.add(
                        value
                    )

    return result


def load_all_history_articles() -> list[dict[str, Any]]:

    result = []

    if not HISTORY_DIR.exists():
        return result

    for path in HISTORY_DIR.rglob(
        "*.json"
    ):

        data = load_json(
            path,
            {},
        )

        for article in data.get(
            "articles",
            [],
        ):

            if isinstance(
                article,
                dict,
            ):

                result.append(
                    article
                )

    return result


def history_file_for_date(
    published_at: str,
) -> Path:
    """
    Determine the history file using the Singapore calendar date.

    This is important around midnight.

    Example:

        UTC:
            2026-10-02 18:00

        SGT:
            2026-10-03 02:00

    The article is therefore stored under:

        history/2026/10/2026-10-03.json
    """

    try:
        dt = parse_sgt_datetime(
            published_at
        )

    except Exception:
        dt = now_sgt()

    directory = (
        HISTORY_DIR
        / f"{dt.year:04d}"
        / f"{dt.month:02d}"
    )

    directory.mkdir(
        parents=True,
        exist_ok=True,
    )

    return (
        directory
        / f"{dt.date().isoformat()}.json"
    )


def save_history_article(
    article: dict[str, Any],
) -> bool:

    path = history_file_for_date(
        article[
            "publishedAtSgt"
        ]
    )

    article_date_sgt = parse_sgt_datetime(
        article[
            "publishedAtSgt"
        ]
    ).date().isoformat()

    data = load_json(
        path,
        {
            "date": article_date_sgt,
            "timezone": "Asia/Singapore",
            "timezoneLabel": "SGT",
            "source": SOURCE_NAME,
            "articles": [],
        },
    )

    articles = data.setdefault(
        "articles",
        [],
    )

    existing_ids = {
        item.get(
            "id"
        )
        for item in articles
        if isinstance(
            item,
            dict,
        )
    }

    if article[
        "id"
    ] in existing_ids:
        return False

    articles.append(
        article
    )

    articles.sort(
        key=lambda item: item.get(
            "publishedAtSgt",
            "",
        ),
        reverse=True,
    )

    data[
        "articleCount"
    ] = len(
        articles
    )

    data[
        "updatedAtSgt"
    ] = format_sgt(
        now_sgt()
    )

    with path.open(
        "w",
        encoding="utf-8",
    ) as handle:

        json.dump(
            data,
            handle,
            indent=2,
            ensure_ascii=False,
        )

        handle.write(
            "\n"
        )

    return True


# ============================================================================
# CURRENT INDEX
# ============================================================================

def build_current_index(
    articles: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """
    Build the current 14-day index using SGT.

    Both the current time and article timestamps are normalized to SGT
    before comparison.
    """

    cutoff = (
        now_sgt()
        - timedelta(
            days=WINDOW_DAYS
        )
    )

    unique = {}

    for article in articles:

        timestamp = (
            article.get(
                "publishedAtSgt"
            )
            or article.get(
                "publishedAtUtc"
            )
        )

        if not timestamp:
            continue

        try:
            published = parse_sgt_datetime(
                timestamp
            )

        except Exception:
            continue

        if published < cutoff:
            continue

        article_key = article.get(
            "id"
        )

        if article_key:
            unique[
                article_key
            ] = article

    current = list(
        unique.values()
    )

    current.sort(
        key=lambda item: (
            item.get(
                "publishedAtSgt",
                item.get(
                    "publishedAtUtc",
                    "",
                ),
            )
        ),
        reverse=True,
    )

    return current[
        :MAX_CURRENT_ARTICLES
    ]


def write_current_index(
    articles: list[dict[str, Any]],
) -> None:

    NEWS_DIR.mkdir(
        parents=True,
        exist_ok=True,
    )

    data = {
        "generatedAtSgt": format_sgt(
            now_sgt()
        ),
        "timezone": "Asia/Singapore",
        "timezoneLabel": "SGT",
        "windowDays": WINDOW_DAYS,
        "maxArticles": MAX_CURRENT_ARTICLES,
        "source": SOURCE_NAME,
        "articleCount": len(
            articles
        ),
        "articles": articles,
    }

    with CURRENT_FILE.open(
        "w",
        encoding="utf-8",
    ) as handle:

        json.dump(
            data,
            handle,
            indent=2,
            ensure_ascii=False,
        )

        handle.write(
            "\n"
        )


# ============================================================================
# MAIN
# ============================================================================

def main() -> None:

    print(
        "=" * 80
    )

    print(
        "VGrat FMS - CNBC Market News Collector"
    )

    print(
        "=" * 80
    )

    print(
        "Timezone: Singapore Time (SGT / UTC+08:00)"
    )

    print(
        f"Current SGT time: "
        f"{format_sgt(now_sgt())}"
    )

    print(
        f"Rolling window: {WINDOW_DAYS} days"
    )

    print(
        f"Maximum current records: "
        f"{MAX_CURRENT_ARTICLES}"
    )

    print()

    NEWS_DIR.mkdir(
        parents=True,
        exist_ok=True,
    )

    HISTORY_DIR.mkdir(
        parents=True,
        exist_ok=True,
    )

    started = now_sgt()

    stats = {
        "rssEntries": 0,
        "uniqueEntries": 0,
        "duplicates": 0,
        "relevantMarket": 0,
        "relevantEconomic": 0,
        "relevantTechnology": 0,
        "relevantGeopolitical": 0,
        "relevantArticles": 0,
        "rejectedSports": 0,
        "rejectedEntertainment": 0,
        "rejectedLifestyle": 0,
        "rejectedAccident": 0,
        "rejectedCrime": 0,
        "rejectedPolitical": 0,
        "rejectedSocialPolicy": 0,
        "rejectedGeneral": 0,
        "articleExtractionAttempts": 0,
        "articleExtractionSuccess": 0,
        "articleExtractionFailures": 0,
        "newHistoricalRecords": 0,
    }

    # ------------------------------------------------------------------
    # RSS COLLECTION
    # ------------------------------------------------------------------

    rss_records = collect_rss()

    stats[
        "rssEntries"
    ] = len(
        rss_records
    )

    unique_records = {}

    for record in rss_records:

        url = record.get(
            "url",
            "",
        )

        if not url:
            continue

        key = article_id(
            SOURCE_NAME,
            url,
        )

        if key in unique_records:

            stats[
                "duplicates"
            ] += 1

            feeds = unique_records[
                key
            ].setdefault(
                "feeds",
                [],
            )

            feed = record.get(
                "feed"
            )

            if (
                feed
                and feed not in feeds
            ):
                feeds.append(
                    feed
                )

            continue

        record[
            "id"
        ] = key

        record[
            "feeds"
        ] = [
            record.get(
                "feed",
                "unknown",
            )
        ]

        unique_records[
            key
        ] = record

    stats[
        "uniqueEntries"
    ] = len(
        unique_records
    )

    print()

    print(
        f"RSS entries: "
        f"{stats['rssEntries']}"
    )

    print(
        f"Unique entries: "
        f"{stats['uniqueEntries']}"
    )

    print(
        f"Duplicates: "
        f"{stats['duplicates']}"
    )

    # ------------------------------------------------------------------
    # CLASSIFICATION
    # ------------------------------------------------------------------

    relevant_records = []

    print()

    print(
        "=" * 80
    )

    print(
        "CLASSIFICATION"
    )

    print(
        "=" * 80
    )

    for record in unique_records.values():

        result = classify_relevance(
            record[
                "title"
            ],
            record[
                "description"
            ],
        )

        record[
            "classification"
        ] = result

        title = record[
            "title"
        ]

        if result[
            "relevant"
        ]:

            category = result[
                "category"
            ]

            stats[
                "relevantArticles"
            ] += 1

            if category == "MARKET":
                stats[
                    "relevantMarket"
                ] += 1

            elif category == "ECONOMIC":
                stats[
                    "relevantEconomic"
                ] += 1

            elif category == "TECHNOLOGY":
                stats[
                    "relevantTechnology"
                ] += 1

            elif category == "GEOPOLITICAL":
                stats[
                    "relevantGeopolitical"
                ] += 1

            relevant_records.append(
                record
            )

            print(
                "KEEP:",
                title,
                f"[{category}]",
                f"score={result['score']}",
                f"reason={result['reason']}",
            )

        else:

            reason = result[
                "reason"
            ]

            if reason == "sports":
                stats[
                    "rejectedSports"
                ] += 1

            elif reason == "entertainment":
                stats[
                    "rejectedEntertainment"
                ] += 1

            elif reason == "lifestyle":
                stats[
                    "rejectedLifestyle"
                ] += 1

            elif reason == "accident_human_interest":
                stats[
                    "rejectedAccident"
                ] += 1

            elif reason == "crime_human_interest":
                stats[
                    "rejectedCrime"
                ] += 1

            elif reason in {
                "political_without_market_or_economic_impact",
                "political_commentary_without_direct_market_signal",
            }:
                stats[
                    "rejectedPolitical"
                ] += 1

            elif reason == "non_economic_social_policy":
                stats[
                    "rejectedSocialPolicy"
                ] += 1

            else:
                stats[
                    "rejectedGeneral"
                ] += 1

            print(
                "REJECT:",
                title,
                f"reason={reason}",
            )

    # ------------------------------------------------------------------
    # HISTORY
    # ------------------------------------------------------------------

    existing_ids = (
        load_existing_history_ids()
    )

    for record in relevant_records:

        key = record[
            "id"
        ]

        if key in existing_ids:
            continue

        title = record[
            "title"
        ]

        print()

        print(
            "PROCESS:",
            title,
        )

        stats[
            "articleExtractionAttempts"
        ] += 1

        try:

            article_text = fetch_article_text(
                record[
                    "url"
                ]
            )

            if not article_text:
                raise RuntimeError(
                    "No article text extracted"
                )

            stats[
                "articleExtractionSuccess"
            ] += 1

            summary = generate_summary(
                title,
                record[
                    "description"
                ],
                article_text,
            )

        except Exception as exc:

            stats[
                "articleExtractionFailures"
            ] += 1

            print(
                "  Extraction failed:",
                type(exc).__name__,
                str(exc),
            )

            summary = shorten(
                record[
                    "description"
                ]
            )

            if not summary:
                summary = shorten(
                    title
                )

        classification = record[
            "classification"
        ]

        permanent_record = {
            "id": key,
            "source": SOURCE_NAME,
            "title": title,
            "publishedAtSgt": record[
                "publishedAtSgt"
            ],
            "url": record[
                "url"
            ],
            "category": classification[
                "category"
            ],
            "relevanceScore": classification[
                "score"
            ],
            "relevanceReason": classification[
                "reason"
            ],
            "summary": summary,
            "feeds": record.get(
                "feeds",
                [],
            ),
            "collectedAtSgt": format_sgt(
                now_sgt()
            ),
        }

        if save_history_article(
            permanent_record
        ):

            stats[
                "newHistoricalRecords"
            ] += 1

            existing_ids.add(
                key
            )

            print(
                "  Saved."
            )

    # ------------------------------------------------------------------
    # CURRENT INDEX
    # ------------------------------------------------------------------

    history_articles = (
        load_all_history_articles()
    )

    current_articles = (
        build_current_index(
            history_articles
        )
    )

    write_current_index(
        current_articles
    )

    # ------------------------------------------------------------------
    # FINAL CONSOLE SUMMARY
    # ------------------------------------------------------------------

    finished = now_sgt()

    elapsed_seconds = (
        finished - started
    ).total_seconds()

    print()

    print(
        "=" * 80
    )

    print(
        "COLLECTION COMPLETE"
    )

    print(
        "=" * 80
    )

    print(
        f"Started SGT:            "
        f"{format_sgt(started)}"
    )

    print(
        f"Finished SGT:           "
        f"{format_sgt(finished)}"
    )

    print(
        f"Elapsed seconds:        "
        f"{elapsed_seconds:.2f}"
    )

    print()

    print(
        f"Relevant:               "
        f"{stats['relevantArticles']}"
    )

    print(
        f"  Market:               "
        f"{stats['relevantMarket']}"
    )

    print(
        f"  Economic:             "
        f"{stats['relevantEconomic']}"
    )

    print(
        f"  Technology:           "
        f"{stats['relevantTechnology']}"
    )

    print(
        f"  Geopolitical:         "
        f"{stats['relevantGeopolitical']}"
    )

    print()

    print(
        f"Rejected sports:        "
        f"{stats['rejectedSports']}"
    )

    print(
        f"Rejected entertainment: "
        f"{stats['rejectedEntertainment']}"
    )

    print(
        f"Rejected lifestyle:     "
        f"{stats['rejectedLifestyle']}"
    )

    print(
        f"Rejected accidents:     "
        f"{stats['rejectedAccident']}"
    )

    print(
        f"Rejected crime:         "
        f"{stats['rejectedCrime']}"
    )

    print(
        f"Rejected political:     "
        f"{stats['rejectedPolitical']}"
    )

    print(
        f"Rejected social policy: "
        f"{stats['rejectedSocialPolicy']}"
    )

    print(
        f"Rejected general:       "
        f"{stats['rejectedGeneral']}"
    )

    print()

    print(
        f"New historical:         "
        f"{stats['newHistoricalRecords']}"
    )

    print(
        f"Historical total:       "
        f"{len(history_articles)}"
    )

    print(
        f"Current 14-day total:   "
        f"{len(current_articles)}"
    )

    print(
        f"Current maximum:        "
        f"{MAX_CURRENT_ARTICLES}"
    )

    print()

    print(
        "Timezone used for all saved date/time data:"
    )

    print(
        "Asia/Singapore (SGT / UTC+08:00)"
    )

    print(
        "=" * 80
    )


if __name__ == "__main__":
    main()
