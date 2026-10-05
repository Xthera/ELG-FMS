/* ============================================================
   VGRAT FMS
   MARKET NEWS MODULE
   ============================================================

   Data sources:
   - Current:
       data/market_news/analysis/current.json

   - Historical:
       data/market_news/analysis/history/YYYY/MM/YYYY-MM-DD.json

   The frontend displays the AI-analysis output only.
   Raw CNBC collector files are not used here.
============================================================ */

import {
    loadJson
} from "./data-loader.js";


/* ============================================================
   CONSTANTS
============================================================ */

const MARKET_NEWS_PATHS = {

    current:
        "data/market_news/analysis/current.json",

    historyRoot:
        "data/market_news/analysis/history"

};


const NEWS_CATEGORIES = [
    "MARKET",
    "ECONOMIC",
    "TECHNOLOGY",
    "GEOPOLITICAL"
];


const IMPORTANCE_ORDER = {
    HIGH: 0,
    MEDIUM: 1,
    LOW: 2
};


const SENTIMENT_ORDER = {
    NEGATIVE: 0,
    NEUTRAL: 1,
    POSITIVE: 2
};


/* ============================================================
   DATE HELPERS
============================================================ */

function parseNewsDate(
    value
) {

    if (
        typeof value !== "string" ||
        !value
    ) {

        return null;
    }


    const timestamp =
        Date.parse(
            value
        );


    if (
        !Number.isFinite(
            timestamp
        )
    ) {

        return null;
    }


    return new Date(
        timestamp
    );
}


function formatNewsDate(
    value
) {

    const date =
        parseNewsDate(
            value
        );


    if (!date) {
        return "—";
    }


    return date.toLocaleDateString(
        "en-SG",
        {
            day: "2-digit",
            month: "short",
            year: "numeric",
            timeZone: "Asia/Singapore"
        }
    );
}


function formatNewsTime(
    value
) {

    const date =
        parseNewsDate(
            value
        );


    if (!date) {
        return "—";
    }


    return date.toLocaleTimeString(
        "en-SG",
        {
            hour: "2-digit",
            minute: "2-digit",
            timeZone: "Asia/Singapore"
        }
    );
}


function formatNewsDateTime(
    value
) {

    const date =
        parseNewsDate(
            value
        );


    if (!date) {
        return "—";
    }


    return date.toLocaleString(
        "en-SG",
        {
            day: "2-digit",
            month: "short",
            year: "numeric",
            hour: "2-digit",
            minute: "2-digit",
            timeZone: "Asia/Singapore"
        }
    );
}


/* ============================================================
   HISTORY PATH
============================================================ */

function buildHistoryPath(
    date
) {

    if (
        typeof date !== "string" ||
        !/^\d{4}-\d{2}-\d{2}$/.test(date)
    ) {

        throw new Error(
            `Invalid history date: ${date}`
        );
    }


    const [
        year,
        month
    ] =
        date.split("-");


    return (
        `${MARKET_NEWS_PATHS.historyRoot}/` +
        `${year}/${month}/${date}.json`
    );
}


/* ============================================================
   DATA NORMALISATION
============================================================ */

function normaliseAnalysis(
    article
) {

    if (
        !article ||
        typeof article !== "object"
    ) {

        return null;
    }


    return {

        articleId:
            article.articleId ??
            "",

        relevant:
            article.relevant !== false,

        category:
            String(
                article.category ??
                "MARKET"
            ).toUpperCase(),

        sentiment:
            String(
                article.sentiment ??
                "NEUTRAL"
            ).toUpperCase(),

        importance:
            String(
                article.importance ??
                "MEDIUM"
            ).toUpperCase(),

        summary:
            article.summary ??
            "",

        assetClasses:
            normaliseArray(
                article.assetClasses
            ),

        geographies:
            normaliseArray(
                article.geographies
            ),

        sectors:
            normaliseArray(
                article.sectors
            ),

        investorImpact:
            article.investorImpact ??
            "",

        reasoning:
            article.reasoning ??
            "",

        fundMonitoringRelevant:
            article.fundMonitoringRelevant === true,

        source:
            article.source ??
            "CNBC",

        title:
            article.title ??
            "Untitled article",

        publishedAtSgt:
            article.publishedAtSgt ??
            null,

        url:
            article.url ??
            "",

        collectorCategory:
            article.collectorCategory ??
            "",

        collectorRelevanceScore:
            article.collectorRelevanceScore ??
            null,

        collectorRelevanceReason:
            article.collectorRelevanceReason ??
            "",

        collectedAtSgt:
            article.collectedAtSgt ??
            null

    };
}


function normaliseArray(
    value
) {

    if (
        !Array.isArray(
            value
        )
    ) {

        return [];
    }


    return value
        .map(
            item =>
                String(item).trim()
        )
        .filter(
            Boolean
        );
}


/* ============================================================
   LOAD CURRENT NEWS
============================================================ */

async function loadCurrentMarketNews() {

    const raw =
        await loadJson(
            MARKET_NEWS_PATHS.current
        );


    if (
        !raw ||
        typeof raw !== "object"
    ) {

        throw new Error(
            "Market news analysis returned invalid data."
        );
    }


    if (
        !Array.isArray(
            raw.analyses
        )
    ) {

        throw new Error(
            "Market news analysis does not contain an analyses array."
        );
    }


    const analyses =
        raw.analyses
            .map(
                normaliseAnalysis
            )
            .filter(
                Boolean
            );


    return {

        generatedAtSgt:
            raw.generatedAtSgt ??
            null,

        timezone:
            raw.timezone ??
            "Asia/Singapore",

        timezoneLabel:
            raw.timezoneLabel ??
            "SGT",

        windowDays:
            Number(
                raw.windowDays ??
                14
            ),

        articleCount:
            Number(
                raw.articleCount ??
                analyses.length
            ),

        analyses,

        raw

    };
}


/* ============================================================
   LOAD HISTORICAL NEWS
============================================================ */

async function loadHistoricalMarketNews(
    date
) {

    const path =
        buildHistoryPath(
            date
        );


    const raw =
        await loadJson(
            path
        );


    if (
        !raw ||
        typeof raw !== "object"
    ) {

        throw new Error(
            `Historical market news returned invalid data for ${date}.`
        );
    }


    if (
        !Array.isArray(
            raw.analyses
        )
    ) {

        throw new Error(
            `Historical market news for ${date} does not contain an analyses array.`
        );
    }


    const analyses =
        raw.analyses
            .map(
                normaliseAnalysis
            )
            .filter(
                Boolean
            );


    return {

        date,

        generatedAtSgt:
            raw.generatedAtSgt ??
            null,

        timezone:
            raw.timezone ??
            "Asia/Singapore",

        timezoneLabel:
            raw.timezoneLabel ??
            "SGT",

        windowDays:
            raw.windowDays ??
            null,

        articleCount:
            Number(
                raw.articleCount ??
                analyses.length
            ),

        analyses,

        raw

    };
}


/* ============================================================
   FILTERING
============================================================ */

function filterRelevantNews(
    analyses
) {

    if (
        !Array.isArray(
            analyses
        )
    ) {

        return [];
    }


    return analyses.filter(
        article =>
            article.relevant !== false
    );
}


function filterFundRelevantNews(
    analyses
) {

    if (
        !Array.isArray(
            analyses
        )
    ) {

        return [];
    }


    return analyses.filter(
        article =>
            article.relevant !== false &&
            article.fundMonitoringRelevant === true
    );
}


function filterByCategory(
    analyses,
    category
) {

    if (
        !Array.isArray(
            analyses
        )
    ) {

        return [];
    }


    if (
        !category ||
        category === "ALL"
    ) {

        return [
            ...analyses
        ];
    }


    const normalized =
        String(
            category
        ).toUpperCase();


    return analyses.filter(
        article =>
            article.category ===
            normalized
    );
}


function filterBySentiment(
    analyses,
    sentiment
) {

    if (
        !sentiment ||
        sentiment === "ALL"
    ) {

        return [
            ...(analyses || [])
        ];
    }


    const normalized =
        String(
            sentiment
        ).toUpperCase();


    return (
        analyses || []
    ).filter(
        article =>
            article.sentiment ===
            normalized
    );
}


function filterByImportance(
    analyses,
    importance
) {

    if (
        !importance ||
        importance === "ALL"
    ) {

        return [
            ...(analyses || [])
        ];
    }


    const normalized =
        String(
            importance
        ).toUpperCase();


    return (
        analyses || []
    ).filter(
        article =>
            article.importance ===
            normalized
    );
}


/* ============================================================
   SEARCH
============================================================ */

function searchNews(
    analyses,
    searchTerm
) {

    if (
        !Array.isArray(
            analyses
        )
    ) {

        return [];
    }


    const query =
        String(
            searchTerm ??
            ""
        )
            .trim()
            .toLowerCase();


    if (!query) {

        return [
            ...analyses
        ];
    }


    return analyses.filter(
        article => {

            const searchableText = [

                article.title,

                article.summary,

                article.investorImpact,

                article.source,

                article.category,

                article.sentiment,

                article.importance,

                ...article.assetClasses,

                ...article.geographies,

                ...article.sectors

            ]
                .filter(
                    Boolean
                )
                .join(" ")
                .toLowerCase();


            return searchableText.includes(
                query
            );
        }
    );
}


/* ============================================================
   SORTING
============================================================ */

function sortByPublishedDate(
    analyses,
    direction = "desc"
) {

    const multiplier =
        direction === "asc"
            ? 1
            : -1;


    return [
        ...(analyses || [])
    ].sort(
        (
            a,
            b
        ) => {

            const dateA =
                parseNewsDate(
                    a.publishedAtSgt
                );


            const dateB =
                parseNewsDate(
                    b.publishedAtSgt
                );


            const timeA =
                dateA
                    ? dateA.getTime()
                    : 0;


            const timeB =
                dateB
                    ? dateB.getTime()
                    : 0;


            return (
                (timeA - timeB) *
                multiplier
            );
        }
    );
}


function sortByImportance(
    analyses
) {

    return [
        ...(analyses || [])
    ].sort(
        (
            a,
            b
        ) => {

            const importanceA =
                IMPORTANCE_ORDER[
                    a.importance
                ] ??
                99;


            const importanceB =
                IMPORTANCE_ORDER[
                    b.importance
                ] ??
                99;


            if (
                importanceA !==
                importanceB
            ) {

                return (
                    importanceA -
                    importanceB
                );
            }


            return comparePublishedDates(
                a,
                b
            );
        }
    );
}


function sortBySentiment(
    analyses
) {

    return [
        ...(analyses || [])
    ].sort(
        (
            a,
            b
        ) => {

            const sentimentA =
                SENTIMENT_ORDER[
                    a.sentiment
                ] ??
                99;


            const sentimentB =
                SENTIMENT_ORDER[
                    b.sentiment
                ] ??
                99;


            if (
                sentimentA !==
                sentimentB
            ) {

                return (
                    sentimentA -
                    sentimentB
                );
            }


            return comparePublishedDates(
                a,
                b
            );
        }
    );
}


function comparePublishedDates(
    a,
    b
) {

    const dateA =
        parseNewsDate(
            a?.publishedAtSgt
        );


    const dateB =
        parseNewsDate(
            b?.publishedAtSgt
        );


    const timeA =
        dateA
            ? dateA.getTime()
            : 0;


    const timeB =
        dateB
            ? dateB.getTime()
            : 0;


    return timeB - timeA;
}


/* ============================================================
   AGGREGATION
============================================================ */

function getNewsStatistics(
    analyses
) {

    const articles =
        filterRelevantNews(
            analyses
        );


    const statistics = {

        total:
            articles.length,

        high:
            0,

        medium:
            0,

        low:
            0,

        positive:
            0,

        neutral:
            0,

        negative:
            0,

        mixed:
            0,

        fundMonitoringRelevant:
            0,

        categories:
            {},

        assetClasses:
            {},

        geographies:
            {},

        sectors:
            {}

    };


    for (
        const article
        of articles
    ) {

        const importance =
            String(
                article.importance ||
                "MEDIUM"
            ).toLowerCase();


        if (
            Object.prototype.hasOwnProperty.call(
                statistics,
                importance
            )
        ) {

            statistics[
                importance
            ]++;
        }


        const sentiment =
            String(
                article.sentiment ||
                "NEUTRAL"
            ).toLowerCase();


        if (
            Object.prototype.hasOwnProperty.call(
                statistics,
                sentiment
            )
        ) {

            statistics[
                sentiment
            ]++;
        }


        if (
            article.fundMonitoringRelevant
        ) {

            statistics
                .fundMonitoringRelevant++;
        }


        incrementCounter(
            statistics.categories,
            article.category
        );


        for (
            const assetClass
            of article.assetClasses
        ) {

            incrementCounter(
                statistics.assetClasses,
                assetClass
            );
        }


        for (
            const geography
            of article.geographies
        ) {

            incrementCounter(
                statistics.geographies,
                geography
            );
        }


        for (
            const sector
            of article.sectors
        ) {

            incrementCounter(
                statistics.sectors,
                sector
            );
        }
    }


    return statistics;
}


function incrementCounter(
    object,
    key
) {

    if (!key) {
        return;
    }


    object[key] =
        (object[key] || 0) +
        1;
}


/* ============================================================
   TOPIC EXTRACTION
============================================================ */

function getTopItems(
    counter,
    limit = 5
) {

    return Object.entries(
        counter || {}
    )
        .sort(
            (
                a,
                b
            ) => {

                if (
                    b[1] !==
                    a[1]
                ) {

                    return (
                        b[1] -
                        a[1]
                    );
                }


                return a[0]
                    .localeCompare(
                        b[0]
                    );
            }
        )
        .slice(
            0,
            limit
        )
        .map(
            ([name, count]) => ({
                name,
                count
            })
        );
}


/* ============================================================
   AVAILABLE CATEGORY HELPERS
============================================================ */

function getAvailableCategories(
    analyses
) {

    const categories =
        new Set();


    for (
        const article
        of analyses || []
    ) {

        if (
            article.category
        ) {

            categories.add(
                article.category
            );
        }
    }


    return [
        "ALL",
        ...[
            ...categories
        ].sort()
    ];
}


function getAvailableYears(
    analyses
) {

    const years =
        new Set();


    for (
        const article
        of analyses || []
    ) {

        const date =
            parseNewsDate(
                article.publishedAtSgt
            );


        if (!date) {
            continue;
        }


        years.add(
            date.toLocaleString(
                "en-SG",
                {
                    year: "numeric",
                    timeZone: "Asia/Singapore"
                }
            )
        );
    }


    return [
        ...years
    ]
        .map(
            Number
        )
        .sort(
            (a, b) =>
                b - a
        );
}


/* ============================================================
   ARTICLE DISPLAY MODEL
============================================================ */

/*
 * Keeps presentation code separate from the raw analysis
 * schema.
 */

function toDisplayArticle(
    article
) {

    if (!article) {
        return null;
    }


    return {

        id:
            article.articleId,

        title:
            article.title,

        source:
            article.source,

        url:
            article.url,

        category:
            article.category,

        sentiment:
            article.sentiment,

        importance:
            article.importance,

        summary:
            article.summary,

        investorImpact:
            article.investorImpact,

        assetClasses:
            [...article.assetClasses],

        geographies:
            [...article.geographies],

        sectors:
            [...article.sectors],

        fundMonitoringRelevant:
            article.fundMonitoringRelevant,

        publishedAt:
            article.publishedAtSgt,

        publishedDate:
            formatNewsDate(
                article.publishedAtSgt
            ),

        publishedTime:
            formatNewsTime(
                article.publishedAtSgt
            )

    };
}


/* ============================================================
   MARKET NEWS STATE
============================================================ */

function createNewsState(
    currentNews
) {

    const analyses =
        sortByPublishedDate(
            filterRelevantNews(
                currentNews?.analyses
            )
        );


    return {

        source:
            "analysis/current.json",

        generatedAtSgt:
            currentNews?.generatedAtSgt ??
            null,

        timezone:
            currentNews?.timezone ??
            "Asia/Singapore",

        timezoneLabel:
            currentNews?.timezoneLabel ??
            "SGT",

        windowDays:
            currentNews?.windowDays ??
            14,

        articleCount:
            currentNews?.articleCount ??
            analyses.length,

        analyses,

        selectedCategory:
            "ALL",

        selectedSentiment:
            "ALL",

        selectedImportance:
            "ALL",

        searchTerm:
            "",

        sort:
            "published-desc"

    };
}


/* ============================================================
   APPLY FILTERS
============================================================ */

function getVisibleNews(
    state
) {

    if (!state) {
        return [];
    }


    let result =
        [...(
            state.analyses ||
            []
        )];


    result =
        filterByCategory(
            result,
            state.selectedCategory
        );


    result =
        filterBySentiment(
            result,
            state.selectedSentiment
        );


    result =
        filterByImportance(
            result,
            state.selectedImportance
        );


    result =
        searchNews(
            result,
            state.searchTerm
        );


    switch (
        state.sort
    ) {

        case "importance":

            result =
                sortByImportance(
                    result
                );

            break;


        case "sentiment":

            result =
                sortBySentiment(
                    result
                );

            break;


        case "published-asc":

            result =
                sortByPublishedDate(
                    result,
                    "asc"
                );

            break;


        case "published-desc":

        default:

            result =
                sortByPublishedDate(
                    result,
                    "desc"
                );

            break;
    }


    return result;
}


/* ============================================================
   HISTORY DATE UTILITIES
============================================================ */

/*
 * The history directory is:
 *
 * history/
 *   YYYY/
 *     MM/
 *       YYYY-MM-DD.json
 *
 * GitHub Pages does not provide a directory API, therefore
 * this module does not attempt to discover files by listing
 * folders.
 *
 * A specific date is requested directly.
 */

async function loadHistoryDate(
    date
) {

    return loadHistoricalMarketNews(
        date
    );
}


/* ============================================================
   ERROR HELPERS
============================================================ */

function isHistoryNotFoundError(
    error
) {

    if (!error) {
        return false;
    }


    const message =
        String(
            error.message ||
            error
        );


    return (
        message.includes(
            "HTTP 404"
        ) ||
        message.includes(
            "Unable to load"
        )
    );
}


/* ============================================================
   PUBLIC API
============================================================ */

export {

    MARKET_NEWS_PATHS,

    NEWS_CATEGORIES,

    loadCurrentMarketNews,

    loadHistoricalMarketNews,

    loadHistoryDate,

    buildHistoryPath,

    normaliseAnalysis,

    filterRelevantNews,

    filterFundRelevantNews,

    filterByCategory,

    filterBySentiment,

    filterByImportance,

    searchNews,

    sortByPublishedDate,

    sortByImportance,

    sortBySentiment,

    getNewsStatistics,

    getTopItems,

    getAvailableCategories,

    getAvailableYears,

    toDisplayArticle,

    createNewsState,

    getVisibleNews,

    formatNewsDate,

    formatNewsTime,

    formatNewsDateTime,

    parseNewsDate,

    isHistoryNotFoundError

};
