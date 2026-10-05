/* ============================================================
   VGRAT FMS
   Data Loader
   ============================================================ */

/*
    Responsibilities
    ----------------
    1. Load funds.json
    2. Load bid_history.json
    3. Load market-news analysis/current.json
    4. Validate the basic response structure
    5. Return normalized application data

    This file does NOT:
    - Calculate returns
    - Rank funds
    - Render HTML
    - Handle navigation
    - Modify production data
*/


/* ============================================================
   01. DATA PATHS
   ============================================================ */

const DATA_PATHS = {
    funds: "data/funds.json",

    bidHistory: "data/bid_history.json",

    marketNewsAnalysis:
        "data/market_news/analysis/current.json"
};


/* ============================================================
   02. GENERIC JSON LOADER
   ============================================================ */

async function loadJson(path) {

    /*
     * "no-cache" still checks the server for a newer file on
     * every visit, but lets the browser reuse its cached copy
     * when nothing has changed (HTTP 304). "no-store" forced
     * the full ~6 MB bid_history.json to download every time.
     */
    const response = await fetch(path, {
        cache: "no-cache"
    });


    if (!response.ok) {

        throw new Error(
            `Unable to load ${path} ` +
            `(HTTP ${response.status})`
        );

    }


    let data;

    try {

        data = await response.json();

    } catch (error) {

        throw new Error(
            `Invalid JSON returned from ${path}`
        );

    }


    return data;
}


/* ============================================================
   03. FUNDS DATA VALIDATION
   ============================================================ */

function validateFundsData(data) {

    if (!data || typeof data !== "object") {

        throw new Error(
            "funds.json returned an invalid data structure."
        );

    }


    /*
        The production funds.json is expected to contain
        fund records at the top level.

        We deliberately do not enforce a hardcoded fund count.
    */

    const possibleFunds = Array.isArray(data)
        ? data
        : Array.isArray(data.funds)
            ? data.funds
            : Object.values(data);


    if (!Array.isArray(possibleFunds)) {

        throw new Error(
            "Unable to identify fund records in funds.json."
        );

    }


    return possibleFunds;
}


/* ============================================================
   04. BID HISTORY VALIDATION
   ============================================================ */

function validateBidHistoryData(data) {

    if (!data || typeof data !== "object") {

        throw new Error(
            "bid_history.json returned an invalid data structure."
        );

    }


    if (!Array.isArray(data.funds)) {

        throw new Error(
            "bid_history.json does not contain a valid funds array."
        );

    }


    return data.funds;
}


/* ============================================================
   05. MARKET NEWS ANALYSIS VALIDATION
   ============================================================ */

function validateMarketNewsData(data) {

    if (!data || typeof data !== "object") {

        throw new Error(
            "Market news analysis returned an invalid data structure."
        );

    }


    if (!Array.isArray(data.analyses)) {

        throw new Error(
            "Market news analysis does not contain an analyses array."
        );

    }


    return data;
}


/* ============================================================
   06. LOAD FUND DATA
   ============================================================ */

async function loadFundData() {

    const [
        fundsRaw,
        bidHistoryRaw
    ] = await Promise.all([
        loadJson(DATA_PATHS.funds),
        loadJson(DATA_PATHS.bidHistory)
    ]);


    const funds = validateFundsData(fundsRaw);

    const bidHistory =
        validateBidHistoryData(bidHistoryRaw);


    return {
        funds,
        bidHistory,

        raw: {
            funds: fundsRaw,
            bidHistory: bidHistoryRaw
        }
    };
}


/* ============================================================
   07. LOAD MARKET NEWS
   ============================================================ */

async function loadMarketNews() {

    const marketNewsRaw =
        await loadJson(
            DATA_PATHS.marketNewsAnalysis
        );


    const marketNews =
        validateMarketNewsData(
            marketNewsRaw
        );


    return {
        analyses: marketNews.analyses,

        generatedAtSgt:
            marketNews.generatedAtSgt ?? null,

        timezone:
            marketNews.timezone ?? null,

        timezoneLabel:
            marketNews.timezoneLabel ?? null,

        windowDays:
            marketNews.windowDays ?? null,

        articleCount:
            marketNews.articleCount ??
            marketNews.analyses.length,

        raw: marketNews
    };
}


/* ============================================================
   08. LOAD ALL APPLICATION DATA
   ============================================================ */

async function loadApplicationData() {

    const [
        fundData,
        marketNews
    ] = await Promise.all([
        loadFundData(),
        loadMarketNews()
    ]);


    return {

        funds:
            fundData.funds,

        bidHistory:
            fundData.bidHistory,

        marketNews: {

            analyses:
                marketNews.analyses,

            generatedAtSgt:
                marketNews.generatedAtSgt,

            timezone:
                marketNews.timezone,

            timezoneLabel:
                marketNews.timezoneLabel,

            windowDays:
                marketNews.windowDays,

            articleCount:
                marketNews.articleCount
        },

        raw: {

            funds:
                fundData.raw.funds,

            bidHistory:
                fundData.raw.bidHistory,

            marketNews:
                marketNews.raw
        }
    };
}


/* ============================================================
   09. PUBLIC API
   ============================================================ */

export {
    DATA_PATHS,
    loadJson,
    loadFundData,
    loadMarketNews,
    loadApplicationData
};
