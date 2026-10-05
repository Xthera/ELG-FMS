/* ============================================================
   VGRAT FMS
   MARKET PERFORMANCE ENGINE
   ============================================================

   Calculates:
   - D-D  = Day over Day
   - W-W  = Week over Week
   - M-M  = Month over Month
   - Y-Y  = Year over Year

   IMPORTANT:
   - Uses actual BID observations only.
   - Does NOT use cumulative performance fields.
   - Does NOT forward-fill missing dates.
   - Each fund uses its own latest actual BID observation.
   - Historical comparison = latest actual observation
     on or before the target comparison date.
============================================================ */


/* ============================================================
   PERFORMANCE PERIOD DEFINITIONS
============================================================ */

const PERFORMANCE_PERIODS = {

    DD: {
        key: "DD",
        label: "D-D",
        description: "Day over Day",
        type: "days",
        amount: 1
    },

    WW: {
        key: "WW",
        label: "W-W",
        description: "Week over Week",
        type: "days",
        amount: 7
    },

    MM: {
        key: "MM",
        label: "M-M",
        description: "Month over Month",
        type: "months",
        amount: 1
    },

    YY: {
        key: "YY",
        label: "Y-Y",
        description: "Year over Year",
        type: "years",
        amount: 1
    },

    SI: {
        key: "SI",
        label: "S-I",
        description: "Since Inception",
        type: "inception",
        amount: 0
    }

};


/* ============================================================
   DATE HELPERS
============================================================ */

/*
 * Production dates are expected to be:
 *
 * YYYY-MM-DD
 *
 * We deliberately use UTC internally so that Singapore
 * browser timezone conversions cannot move a date backwards
 * or forwards.
 */

function parseISODate(
    value
) {

    if (
        typeof value !== "string" ||
        !/^\d{4}-\d{2}-\d{2}$/.test(value)
    ) {

        return null;
    }


    const [
        year,
        month,
        day
    ] = value
        .split("-")
        .map(Number);


    const date =
        new Date(
            Date.UTC(
                year,
                month - 1,
                day
            )
        );


    if (
        date.getUTCFullYear() !== year ||
        date.getUTCMonth() !== month - 1 ||
        date.getUTCDate() !== day
    ) {

        return null;
    }


    return date;
}


function formatISODate(
    date
) {

    if (!(date instanceof Date)) {
        return null;
    }


    if (
        Number.isNaN(
            date.getTime()
        )
    ) {

        return null;
    }


    const year =
        date.getUTCFullYear();


    const month =
        String(
            date.getUTCMonth() + 1
        ).padStart(
            2,
            "0"
        );


    const day =
        String(
            date.getUTCDate()
        ).padStart(
            2,
            "0"
        );


    return `${year}-${month}-${day}`;
}


function subtractPeriod(
    dateString,
    period
) {

    const date =
        parseISODate(
            dateString
        );


    if (
        !date ||
        !period
    ) {

        return null;
    }


    switch (
        period.type
    ) {

        case "days":

            date.setUTCDate(
                date.getUTCDate() -
                period.amount
            );

            break;


        case "months":

            date.setUTCMonth(
                date.getUTCMonth() -
                period.amount
            );

            break;


        case "years":

            date.setUTCFullYear(
                date.getUTCFullYear() -
                period.amount
            );

            break;


        default:

            return null;
    }


    return formatISODate(
        date
    );
}


/* ============================================================
   BID VALIDATION
============================================================ */

function normaliseBid(
    value
) {

    const number =
        typeof value === "number"
            ? value
            : Number(value);


    if (
        !Number.isFinite(number) ||
        number <= 0
    ) {

        return null;
    }


    return number;
}


function normaliseObservation(
    observation
) {

    if (
        !observation ||
        typeof observation !== "object"
    ) {

        return null;
    }


    const date =
        typeof observation.date === "string"
            ? observation.date
            : null;


    const parsedDate =
        parseISODate(
            date
        );


    if (!parsedDate) {
        return null;
    }


    const bidPrice =
        normaliseBid(
            observation.bidPrice
        );


    if (
        bidPrice === null
    ) {

        return null;
    }


    return {
        date,
        bidPrice
    };
}


/* ============================================================
   FUND IDENTIFIER MATCHING
============================================================ */

function getFundIdentifier(
    fund
) {

    if (!fund) {
        return "";
    }


    return String(
        fund.fundIdentifier ??
        fund.fundCode ??
        fund.excelRow ??
        fund.fundName ??
        ""
    );
}


function getBidHistoryIdentifier(
    record
) {

    if (!record) {
        return "";
    }


    return String(
        record.fundIdentifier ??
        record.fundCode ??
        record.excelRow ??
        record.fundName ??
        ""
    );
}


/* ============================================================
   BID HISTORY INDEX
============================================================ */

function buildBidHistoryIndex(
    bidHistory
) {

    const index =
        new Map();


    if (
        !Array.isArray(
            bidHistory
        )
    ) {

        return index;
    }


    for (
        const record of bidHistory
    ) {

        const identifier =
            getBidHistoryIdentifier(
                record
            );


        if (!identifier) {
            continue;
        }


        const rawObservations =
            record?.bidHistory?.observations;


        if (
            !Array.isArray(
                rawObservations
            )
        ) {

            continue;
        }


        const observations =
            rawObservations
                .map(
                    normaliseObservation
                )
                .filter(
                    Boolean
                )
                .sort(
                    (
                        a,
                        b
                    ) =>
                        /*
                         * ISO YYYY-MM-DD strings sort correctly
                         * with a plain comparison, which is much
                         * faster than localeCompare().
                         */
                        a.date < b.date
                            ? -1
                            : a.date > b.date
                                ? 1
                                : 0
                );


        if (
            observations.length === 0
        ) {

            continue;
        }


        /*
         * Protect against duplicate dates.
         *
         * If duplicate dates somehow exist, keep the last
         * occurrence in the source array.
         */
        const deduplicated =
            new Map();


        for (
            const observation
            of observations
        ) {

            deduplicated.set(
                observation.date,
                observation
            );
        }


        index.set(
            identifier,
            [...deduplicated.values()]
        );
    }


    return index;
}


/* ============================================================
   HISTORICAL OBSERVATION LOOKUP
============================================================ */

/*
 * Returns the latest actual observation whose date is
 * <= targetDate.
 *
 * This is intentionally NOT:
 *
 * - nearest date
 * - next available date
 * - forward-filled date
 *
 * This preserves the actual BID observation methodology.
 */

function findObservationOnOrBefore(
    observations,
    targetDate
) {

    if (
        !Array.isArray(
            observations
        ) ||
        observations.length === 0 ||
        !targetDate
    ) {

        return null;
    }


    let low =
        0;

    let high =
        observations.length - 1;

    let result =
        null;


    while (
        low <= high
    ) {

        const middle =
            Math.floor(
                (low + high) / 2
            );


        const observation =
            observations[middle];


        if (
            observation.date <=
            targetDate
        ) {

            result =
                observation;

            low =
                middle + 1;

        } else {

            high =
                middle - 1;
        }
    }


    return result;
}


/* ============================================================
   RETURN CALCULATION
============================================================ */

function calculateReturn(
    currentBid,
    historicalBid
) {

    const current =
        normaliseBid(
            currentBid
        );


    const historical =
        normaliseBid(
            historicalBid
        );


    if (
        current === null ||
        historical === null
    ) {

        return null;
    }


    return (
        (current - historical) /
        historical
    ) * 100;
}


/* ============================================================
   SINGLE FUND / PERIOD
============================================================ */

function calculateFundPerformance(
    fund,
    observations,
    period
) {

    if (
        !fund ||
        !Array.isArray(
            observations
        ) ||
        observations.length === 0 ||
        !period
    ) {

        return null;
    }


    /*
     * The current BID is the latest actual observation
     * available for this particular fund.
     */
    const current =
        observations[
            observations.length - 1
        ];


    if (!current) {
        return null;
    }


    /*
     * Since Inception compares against the fund's first
     * BID on record. Every other period uses the latest
     * actual BID on or before the calendar target date.
     */
    let comparisonTarget;

    let historical;


    if (
        period.type === "inception"
    ) {

        historical =
            observations[0];

        comparisonTarget =
            historical?.date ??
            null;

    } else {

        comparisonTarget =
            subtractPeriod(
                current.date,
                period
            );


        if (!comparisonTarget) {
            return null;
        }


        historical =
            findObservationOnOrBefore(
                observations,
                comparisonTarget
            );

    }


    if (!historical) {
        return null;
    }


    /*
     * A historical observation must actually precede
     * the current observation.
     */
    if (
        historical.date >=
        current.date
    ) {

        return null;
    }


    const returnPercent =
        calculateReturn(
            current.bidPrice,
            historical.bidPrice
        );


    if (
        returnPercent === null ||
        !Number.isFinite(
            returnPercent
        )
    ) {

        return null;
    }


    return {

        fundIdentifier:
            fund.fundIdentifier ??
            "",

        fundCode:
            fund.fundCode ??
            "",

        fundName:
            fund.fundName ??
            "Unnamed fund",

        currentBid:
            current.bidPrice,

        currentDate:
            current.date,

        comparisonBid:
            historical.bidPrice,

        comparisonDate:
            historical.date,

        comparisonTargetDate:
            comparisonTarget,

        returnPercent

    };
}


/* ============================================================
   SINGLE PERIOD
============================================================ */

function calculatePerformance(
    funds,
    bidHistory,
    periodKey,
    rankingLimit = 10,
    prebuiltIndex = null
) {

    const period =
        PERFORMANCE_PERIODS[
            periodKey
        ];


    if (!period) {

        throw new Error(
            `Unknown performance period: ${periodKey}`
        );
    }


    if (
        !Array.isArray(
            funds
        )
    ) {

        throw new Error(
            "Funds data must be an array."
        );
    }


    if (
        !Array.isArray(
            bidHistory
        )
    ) {

        throw new Error(
            "BID history must be an array."
        );
    }


    /*
     * Reuse a pre-built index when supplied so the full BID
     * history is only parsed once for all four periods.
     */
    const historyIndex =
        prebuiltIndex ??
        buildBidHistoryIndex(
            bidHistory
        );


    const eligible =
        [];


    /*
     * Process the entire Prudential universe.
     */
    for (
        const fund of funds
    ) {

        const identifier =
            getFundIdentifier(
                fund
            );


        if (!identifier) {
            continue;
        }


        const observations =
            historyIndex.get(
                identifier
            );


        if (
            !observations ||
            observations.length === 0
        ) {

            continue;
        }


        const result =
            calculateFundPerformance(
                fund,
                observations,
                period
            );


        if (!result) {
            continue;
        }


        eligible.push(
            result
        );
    }


    /*
     * Winners:
     *
     * Highest return first.
     *
     * Tie-breaker:
     * fund name, then identifier.
     */
    const winners =
        [...eligible]
            .sort(
                compareWinner
            )
            .slice(
                0,
                Math.max(
                    0,
                    rankingLimit
                )
            )
            .map(
                (result, index) => ({
                    ...result,
                    rank:
                        index + 1
                })
            );


    /*
     * Losers:
     *
     * Lowest return first.
     */
    const losers =
        [...eligible]
            .sort(
                compareLoser
            )
            .slice(
                0,
                Math.max(
                    0,
                    rankingLimit
                )
            )
            .map(
                (result, index) => ({
                    ...result,
                    rank:
                        index + 1
                })
            );


    /*
     * Determine the latest date represented in the
     * eligible universe.
     *
     * Because each fund can have a different latest actual
     * observation, this is informational only.
     */
    let latestDate =
        null;


    for (
        const result of eligible
    ) {

        if (
            latestDate === null ||
            result.currentDate >
            latestDate
        ) {

            latestDate =
                result.currentDate;
        }
    }


    /*
     * Calculate the comparison target based on the
     * latest universe date where possible.
     *
     * This is informational and does not affect the
     * per-fund calculation.
     */
    const targetDate =
        latestDate
            ? subtractPeriod(
                latestDate,
                period
            )
            : null;


    /*
     * Every eligible fund, best to worst, for the
     * full ranked list.
     */
    const all =
        [...eligible]
            .sort(
                compareWinner
            );


    return {

        key:
            period.key,

        label:
            period.label,

        description:
            period.description,

        type:
            period.type,

        amount:
            period.amount,

        totalEligibleFunds:
            eligible.length,

        winners,

        losers,

        all,

        asOfDate:
            latestDate,

        targetDate
    };
}


/* ============================================================
   ALL PERIODS
============================================================ */

function calculateAllPerformance(
    funds,
    bidHistory,
    rankingLimit = 10,
    prebuiltIndex = null
) {

    /*
     * Build the BID history index once and share it across
     * D-D, W-W, M-M and Y-Y (previously rebuilt 4 times).
     */
    const historyIndex =
        prebuiltIndex ??
        buildBidHistoryIndex(
            bidHistory
        );


    const result = {};


    for (
        const key of Object.keys(PERFORMANCE_PERIODS)
    ) {

        result[key] =
            calculatePerformance(
                funds,
                bidHistory,
                key,
                rankingLimit,
                historyIndex
            );
    }


    return result;
}


/* ============================================================
   SORTING
============================================================ */

function compareWinner(
    a,
    b
) {

    const returnDifference =
        b.returnPercent -
        a.returnPercent;


    if (
        returnDifference !== 0
    ) {

        return returnDifference;
    }


    return compareFundNames(
        a,
        b
    );
}


function compareLoser(
    a,
    b
) {

    const returnDifference =
        a.returnPercent -
        b.returnPercent;


    if (
        returnDifference !== 0
    ) {

        return returnDifference;
    }


    return compareFundNames(
        a,
        b
    );
}


function compareFundNames(
    a,
    b
) {

    const nameA =
        String(
            a?.fundName || ""
        ).toLowerCase();


    const nameB =
        String(
            b?.fundName || ""
        ).toLowerCase();


    const nameComparison =
        nameA.localeCompare(
            nameB
        );


    if (
        nameComparison !== 0
    ) {

        return nameComparison;
    }


    return String(
        a?.fundIdentifier || ""
    ).localeCompare(
        String(
            b?.fundIdentifier || ""
        )
    );
}


/* ============================================================
   DISPLAY FORMATTERS
============================================================ */

function formatReturnPercent(
    value
) {

    const number =
        Number(value);


    if (
        !Number.isFinite(
            number
        )
    ) {

        return "—";
    }


    if (
        Math.abs(number) <
        0.0000001
    ) {

        return "0.00%";
    }


    const sign =
        number > 0
            ? "+"
            : "";


    return (
        sign +
        number.toFixed(2) +
        "%"
    );
}


function formatBid(
    value
) {

    const number =
        Number(value);


    if (
        !Number.isFinite(
            number
        )
    ) {

        return "—";
    }


    /*
     * BID history commonly contains five decimal places.
     *
     * Keep five places so the displayed value does not
     * obscure the underlying BID precision.
     */
    return number.toLocaleString(
        "en-SG",
        {
            minimumFractionDigits: 5,
            maximumFractionDigits: 5
        }
    );
}


function formatDisplayDate(
    value
) {

    const date =
        parseISODate(
            value
        );


    if (!date) {
        return "—";
    }


    return date.toLocaleDateString(
        "en-SG",
        {
            timeZone: "UTC",
            day: "2-digit",
            month: "short",
            year: "numeric"
        }
    );
}


/* ============================================================
   PUBLIC API
============================================================ */

export {

    PERFORMANCE_PERIODS,

    parseISODate,

    formatISODate,

    subtractPeriod,

    calculateReturn,

    calculateFundPerformance,

    calculatePerformance,

    calculateAllPerformance,

    buildBidHistoryIndex,

    formatReturnPercent,

    formatBid,

    formatDisplayDate

};
