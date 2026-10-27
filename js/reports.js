/* ============================================================
   ELG FMS — REPORT GENERATION (investment growth)
   ============================================================
   Builds a client-ready "Investment Growth Report" from the
   actual BID price history (data/bid_history.json):

   - a portfolio of up to 8 funds with a % split
   - an initial lump sum plus optional regular top-ups
     (monthly / quarterly / half-yearly / yearly)
   - optional investment boosters: one-off extra amounts on a
     chosen date, each with its own fund allocation
   - units are bought at the BID price on the first price date
     on or after each investment date (no sales charge)
   - value on any date = units held x BID on or before that date
   - dividends paid out by distribution funds are NOT added back

   The report prints cleanly (Print / Save as PDF) on a white
   A4 page whatever theme the site is using.
   ============================================================ */

import { getFontScale } from "./charts.js";
import { placeDropdown } from "./dropdown-place.js";

const MAX_FUNDS = 8;

const FREQUENCIES = {
    none: { label: "No top-ups", months: 0 },
    monthly: { label: "Monthly", months: 1 },
    quarterly: { label: "Quarterly", months: 3 },
    "half-yearly": { label: "Half-yearly", months: 6 },
    yearly: { label: "Yearly", months: 12 }
};

const PRINT_COLORS = ["#1f5f99", "#c0661f", "#1a8a62", "#b38600", "#b0456f", "#2e7d32", "#6a5acd", "#c0392b"];

const report = {
    initialized: false,
    funds: [],
    fundById: new Map(),
    index: new Map(),
    selected: [],          // [{ id, weight }]
    paymentMode: null,     // "Cash" | "SRS" | "CPF-OA" | "CPF-SA"
    requestedStart: null,  // start date as typed in the Premium step
    booster: null,         // investment booster: null | "no" | "yes"
    dividendMode: "cash",  // dividends: "cash" (paid out) | "reinvest"
    boosters: [],          // [{ date, amount, selected: [{ id, weight }] }]
    switching: null,       // fund switching: null | "no" | "yes"
    switches: [],          // [{ date, fromId, portion, selected: [{ id, weight }] }]
    charts: [],
    lastResult: null
};


/* ============================================================
   HELPERS
   ============================================================ */

const qs = (selector, root = document) => root.querySelector(selector);

function escapeHtml(value) {
    return String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}

function fundId(fund) {
    return String(fund?.fundIdentifier ?? fund?.fundCode ?? fund?.excelRow ?? "");
}

function observationsFor(id) {
    const list = report.index.get(id);

    return Array.isArray(list) ? list : [];
}

const PAYMENT_MODES = ["Cash", "SRS", "CPF-OA", "CPF-SA"];

const PAYMENT_LABELS = {
    "Cash": "Cash",
    "SRS": "SRS (Supplementary Retirement Scheme)",
    "CPF-OA": "CPF Ordinary Account (CPFIS-OA)",
    "CPF-SA": "CPF Special Account (CPFIS-SA)"
};

function paymentModesOf(id) {
    const modes = report.fundById.get(id)?.fund?.paymentModes;

    return Array.isArray(modes) ? modes : [];
}

function acceptsPayment(id, mode = report.paymentMode) {
    return Boolean(mode) && paymentModesOf(id).includes(mode);
}

/* Allocation steps of 5% */
const ALLOCATION_STEP = 5;

function roundToStep(value) {
    const number = Number(value) || 0;

    return Math.min(100, Math.max(ALLOCATION_STEP, Math.round(number / ALLOCATION_STEP) * ALLOCATION_STEP));
}

function currencyOf(id) {
    const details = report.fundById.get(id)?.fund ?? {};

    return String(details.unitCurrency ?? details.fundCurrency ?? "SGD").toUpperCase();
}

function money(value, currency) {
    if (value === null || value === undefined || !Number.isFinite(value)) return "—";

    const prefix = currency === "USD" ? "US$" : currency === "SGD" ? "S$" : `${currency} `;
    const sign = value < 0 ? "−" : "";

    return `${sign}${prefix}${Math.abs(value).toLocaleString("en-SG", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function percent(value, digits = 2, signed = true) {
    if (value === null || value === undefined || !Number.isFinite(value)) return "—";

    const sign = signed && value > 0 ? "+" : value < 0 ? "−" : "";

    return `${sign}${Math.abs(value).toFixed(digits)}%`;
}

function formatDate(iso) {
    if (!iso) return "—";

    const [year, month, day] = String(iso).split("-").map(Number);
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

    return `${String(day).padStart(2, "0")} ${months[month - 1]} ${year}`;
}

function addMonths(iso, months) {
    const [year, month, day] = iso.split("-").map(Number);
    const target = new Date(Date.UTC(year, month - 1 + months, 1));
    const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();

    target.setUTCDate(Math.min(day, lastDay));

    return target.toISOString().slice(0, 10);
}

function yearsBetween(a, b) {
    return (Date.parse(b) - Date.parse(a)) / (365.25 * 86400000);
}

/* first observation on or after the date (buying) */
function priceOnOrAfter(observations, iso) {
    let low = 0;
    let high = observations.length - 1;
    let found = -1;

    while (low <= high) {
        const mid = (low + high) >> 1;

        if (observations[mid].date >= iso) {
            found = mid;
            high = mid - 1;
        } else {
            low = mid + 1;
        }
    }

    return found >= 0 ? observations[found] : null;
}

/* last observation on or before the date (valuing) */
function priceOnOrBefore(observations, iso) {
    let low = 0;
    let high = observations.length - 1;
    let found = -1;

    while (low <= high) {
        const mid = (low + high) >> 1;

        if (observations[mid].date <= iso) {
            found = mid;
            low = mid + 1;
        } else {
            high = mid - 1;
        }
    }

    return found >= 0 ? observations[found] : null;
}

/* Money-weighted annual return (XIRR) of dated cash flows */
function xirr(flows) {
    if (flows.length < 2) return null;

    const t0 = Date.parse(flows[0].date);
    const value = rate => flows.reduce(
        (sum, flow) => sum + flow.amount / Math.pow(1 + rate, (Date.parse(flow.date) - t0) / (365.25 * 86400000)),
        0
    );

    let low = -0.9999;
    let high = 10;
    let fLow = value(low);
    const fHigh = value(high);

    if (!Number.isFinite(fLow) || !Number.isFinite(fHigh) || fLow * fHigh > 0) return null;

    for (let step = 0; step < 200; step += 1) {
        const mid = (low + high) / 2;
        const fMid = value(mid);

        if (Math.abs(fMid) < 1e-7) return mid * 100;

        if (fLow * fMid < 0) {
            high = mid;
        } else {
            low = mid;
            fLow = fMid;
        }
    }

    return ((low + high) / 2) * 100;
}


/* ============================================================
   DATE LIMITS FOR THE CHOSEN FUNDS
   ============================================================ */

function dateLimits() {
    const ids = report.selected.map(item => item.id);

    if (!ids.length) return null;

    let earliest = null;
    let latest = null;

    for (const id of ids) {
        const obs = observationsFor(id);

        if (!obs.length) return null;

        const first = obs[0].date;
        const last = obs[obs.length - 1].date;

        if (!earliest || first > earliest) earliest = first;
        if (!latest || last < latest) latest = last;
    }

    return earliest <= latest ? { earliest, latest } : null;
}

/* Price range across every fund that accepts the chosen payment mode.
   Used for the Premium step, before any fund has been picked. */
function paymentRange() {
    let earliest = null;
    let latest = null;

    for (const fund of report.funds) {
        const id = fundId(fund);

        if (!acceptsPayment(id)) continue;

        const obs = observationsFor(id);

        if (!obs.length) continue;

        if (!earliest || obs[0].date < earliest) earliest = obs[0].date;
        if (!latest || obs[obs.length - 1].date > latest) latest = obs[obs.length - 1].date;
    }

    return earliest ? { earliest, latest } : null;
}


/* ============================================================
   CALCULATION
   ============================================================ */

/* Year-by-year rows: each calendar year end in the period + the end date */
function buildYearRows(series, firstDate, endDate) {
    const rows = [];

    if (!series.length) return rows;

    const firstYear = Number(firstDate.slice(0, 4));
    const lastYear = Number(endDate.slice(0, 4));

    const pointOnOrBefore = iso => {
        let found = null;

        for (const point of series) {
            if (point.date <= iso) found = point;
            else break;
        }

        return found;
    };

    for (let year = firstYear; year <= lastYear; year += 1) {
        const target = year === lastYear ? endDate : `${year}-12-31`;
        const point = pointOnOrBefore(target);

        if (!point) continue;
        if (rows.length && rows[rows.length - 1].date === point.date) continue;

        const dividends = point.dividends ?? 0;
        const gain = point.value + dividends - point.invested;

        rows.push({
            label: year === lastYear ? `${formatDate(point.date)} (latest)` : `End ${year}`,
            date: point.date,
            invested: point.invested,
            value: point.value,
            dividends,
            gain,
            gainPct: point.invested ? (gain / point.invested) * 100 : null
        });
    }

    return rows;
}

/* ============================================================
   DIVIDENDS
   Uses each fund's dividend history (data/funds.json):
   - "%" units: payout per unit = rate % x BID on the ex-date
   - "cent(s) per unit": payout per unit = rate / 100
   Units held = units bought before the ex-date.
   cash      -> the payout is kept as cash (counted in gain/loss)
   reinvest  -> the payout buys more units at the BID on/after
                the ex-date (not counted as money invested)
   ============================================================ */

function dividendKind(unit) {
    const text = String(unit ?? "").trim().toLowerCase();

    if (text.startsWith("%")) return "percent";
    if (text.includes("cent")) return "cents";

    return null;
}

function fundPaysDividends(id) {
    const details = report.fundById.get(id)?.fund ?? {};

    return Boolean(details.hasDividend) && Array.isArray(details.dividendHistory) && details.dividendHistory.length > 0;
}

function applyDividends(funds, mode, end) {
    for (const entry of funds) {
        entry.dividends = [];

        const details = entry.fund?.fund ?? {};
        const kind = dividendKind(details.dividendUnit);

        if (!details.hasDividend || !kind || !entry.purchases.length) continue;

        const history = (Array.isArray(details.dividendHistory) ? details.dividendHistory : [])
            .filter(item => /^\d{4}-\d{2}-\d{2}$/.test(String(item?.exDate ?? "")) && Number(item.rate) > 0)
            .sort((a, b) => a.exDate.localeCompare(b.exDate));

        for (const item of history) {
            if (item.exDate > end) continue;

            const held = entry.purchases
                .filter(p => p.date < item.exDate)
                .reduce((sum, p) => sum + p.units, 0);

            if (held <= 0) continue;

            let perUnit;

            if (kind === "percent") {
                const price = priceOnOrBefore(entry.obs, item.exDate);

                if (!price) continue;

                perUnit = price.bidPrice * Number(item.rate) / 100;
            } else {
                perUnit = Number(item.rate) / 100;
            }

            const payout = { exDate: item.exDate, rate: Number(item.rate), units: held, cash: held * perUnit, reinvested: false };

            if (mode === "reinvest") {
                const buy = priceOnOrAfter(entry.obs, item.exDate);

                if (buy && buy.date <= end) {
                    const units = payout.cash / buy.bidPrice;

                    entry.purchases.push({ date: buy.date, amount: 0, units, bid: buy.bidPrice, reinvest: true });
                    entry.purchases.sort((x, y) => x.date.localeCompare(y.date));

                    payout.reinvested = true;
                    payout.reinvestDate = buy.date;
                    payout.reinvestUnits = units;
                }
            }

            entry.dividends.push(payout);
        }
    }
}

function calculate(input) {
    const { lumpSum, topUp, frequency, start, end, term } = input;
    const months = FREQUENCIES[frequency]?.months ?? 0;

    // Payment term: regular top-ups are paid for this many years from
    // the start date (empty = until the end date).
    const termEnd = term > 0 ? addMonths(start, term * 12) : null;

    // Investment dates: the start date, then every period after it
    const investDates = [start];

    if (topUp > 0 && months > 0) {
        let next = addMonths(start, months);

        while (next <= end && (!termEnd || next < termEnd)) {
            investDates.push(next);
            next = addMonths(next, months);
        }
    }

    const skipped = [];

    // One holding per fund: the main portfolio first, then any fund
    // that only appears in a booster.
    const holdings = new Map();

    const holding = id => {
        if (!holdings.has(id)) {
            holdings.set(id, {
                id,
                weight: 0,
                boosterOnly: true,
                slot: holdings.size,
                obs: observationsFor(id),
                purchases: [],
                fund: report.fundById.get(id)
            });
        }

        return holdings.get(id);
    };

    // Fund switches, in date order (several on one day: as entered)
    const switches = (input.switches ?? [])
        .map((item, order) => ({ ...item, order }))
        .sort((a, b) => a.date.localeCompare(b.date) || a.order - b.order);

    const purchaseBids = new Map();

    for (const item of report.selected) {
        const entry = holding(item.id);

        entry.weight = item.weight;
        entry.boosterOnly = false;

        // BID prices entered by the user (optional):
        //  end BID      -> the fund is valued at this price on the end date
        //  purchase BID -> the first (lump-sum) purchase is bought at it
        const endBid = Number(item.endBid);
        const purchaseBid = Number(item.purchaseBid);

        if (endBid > 0) {
            entry.obs = [
                ...entry.obs.filter(observation => observation.date < end),
                { date: end, bidPrice: endBid, manual: true }
            ];
            entry.endBidManual = true;
        }

        if (purchaseBid > 0) purchaseBids.set(item.id, purchaseBid);
    }

    // Allocation of each premium / top-up. A switch of 100% of a fund
    // also redirects that fund's share of later top-ups to the funds
    // switched into (same split).
    const baseAllocation = new Map(report.selected.map(item => [item.id, item.weight / 100]));

    const allocationOn = date => {
        const allocation = new Map(baseAllocation);

        for (const item of switches) {
            if (item.date > date) break;
            if (Number(item.portion) < 100) continue;

            const share = allocation.get(item.fromId) ?? 0;

            if (!(share > 0)) continue;

            allocation.set(item.fromId, 0);

            for (const target of item.selected) {
                allocation.set(target.id, (allocation.get(target.id) ?? 0) + share * (Number(target.weight) / 100));
            }
        }

        return allocation;
    };

    investDates.forEach((date, index) => {
        const total = index === 0 ? lumpSum + topUp : topUp;

        if (!(total > 0)) return;

        for (const [id, share] of allocationOn(date)) {
            const amount = total * share;

            if (!(amount > 0)) continue;

            const entry = holding(id);

            if (entry.boosterOnly) entry.switchedIn = true;

            const price = priceOnOrAfter(entry.obs, date);

            if (index === 0 && purchaseBids.has(id)) {
                const bid = purchaseBids.get(id);
                const buyDate = price && price.date <= end ? price.date : date;

                entry.purchases.push({ date: buyDate, amount, units: amount / bid, bid, manual: true });
                entry.purchaseBidManual = true;
                continue;
            }

            if (!price || price.date > end) {
                // No BID price yet for this date (after the latest price)
                skipped.push({ date, amount });
                continue;
            }

            entry.purchases.push({ date: price.date, amount, units: amount / price.bidPrice, bid: price.bidPrice });
        }
    });

    // Investment boosters: one-off amounts on their own date and split
    for (const booster of input.boosters ?? []) {
        for (const item of booster.selected) {
            const entry = holding(item.id);
            const amount = booster.amount * (item.weight / 100);

            if (amount <= 0) continue;

            const price = priceOnOrAfter(entry.obs, booster.date);

            if (!price || price.date > end) {
                skipped.push({ date: booster.date, amount });
                continue;
            }

            entry.purchases.push({ date: price.date, amount, units: amount / price.bidPrice, bid: price.bidPrice, booster: true });
        }
    }

    // Switch targets need a holding too
    for (const item of switches) {
        for (const target of item.selected) {
            const entry = holding(target.id);

            if (entry.boosterOnly) entry.switchedIn = true;
        }
    }

    const funds = [...holdings.values()].map(entry => ({
        ...entry,
        purchases: entry.purchases.sort((x, y) => x.date.localeCompare(y.date))
    }));

    const dividendMode = input.dividendMode === "reinvest" ? "reinvest" : "cash";

    /*
     * Fund switches, one by one in date order: units are sold at the
     * BID on (or after) the switch date and the proceeds buy the new
     * funds at their BID on that day. Units held include dividends
     * reinvested up to then. The cost moves with the units, so the
     * total invested doesn't change.
     */
    const switchLog = [];
    const fundOf = id => funds.find(entry => entry.id === id);

    for (const item of switches) {
        const from = fundOf(item.fromId);
        const portion = Math.min(100, Math.max(0, Number(item.portion) || 0)) / 100;
        const log = { ...item, executed: false };

        switchLog.push(log);

        if (!from || !(portion > 0)) continue;

        // BID entered for the switch (optional), else the published one
        const published = priceOnOrAfter(from.obs, item.date);
        const sell = item.sellBid > 0
            ? { date: published && published.date <= end ? published.date : item.date, bidPrice: item.sellBid, manual: true }
            : published;

        if (!sell || sell.date > end) {
            log.reason = "no price yet";
            continue;
        }

        // Units held on the switch day, with dividends reinvested so far
        const trial = funds.map(entry => ({ ...entry, purchases: entry.purchases.map(p => ({ ...p })) }));

        applyDividends(trial, dividendMode, sell.date);

        const held = trial.find(entry => entry.id === from.id).purchases
            .filter(p => p.date <= sell.date)
            .reduce((sum, p) => sum + p.units, 0);

        if (!(held > 1e-9)) {
            log.reason = "no units held";
            continue;
        }

        const units = held * portion;
        const value = units * sell.bidPrice;
        const cost = from.purchases
            .filter(p => p.date <= sell.date)
            .reduce((sum, p) => sum + p.amount, 0) * portion;

        const buys = [];

        for (const target of item.selected) {
            const to = fundOf(target.id);
            const share = Number(target.weight) / 100;
            const buy = !to ? null
                : target.buyBid > 0
                    ? { date: sell.date, bidPrice: target.buyBid, manual: true }
                    : priceOnOrAfter(to.obs, sell.date);

            if (!to || !(share > 0) || !buy || buy.date > end) continue;

            buys.push({ to, share, buy });
        }

        const shares = buys.reduce((sum, b) => sum + b.share, 0);

        if (!buys.length || !(shares > 0)) {
            log.reason = "no price for the new fund";
            continue;
        }

        from.purchases.push({ date: sell.date, amount: -cost, units: -units, bid: sell.bidPrice, switchOut: true, flowValue: value });

        log.executed = true;
        log.sellDate = sell.date;
        log.sellBid = sell.bidPrice;
        log.sellManual = !!sell.manual;
        log.units = units;
        log.value = value;
        log.into = [];

        for (const { to, share, buy } of buys) {
            const part = share / shares;
            const boughtUnits = (value * part) / buy.bidPrice;

            to.purchases.push({ date: buy.date, amount: cost * part, units: boughtUnits, bid: buy.bidPrice, switchIn: true, flowValue: value * part, manual: !!buy.manual });
            log.into.push({ id: to.id, value: value * part, units: boughtUnits, bid: buy.bidPrice, date: buy.date, manual: !!buy.manual });
        }

        for (const entry of funds) entry.purchases.sort((x, y) => x.date.localeCompare(y.date));
    }

    // Dividends: paid out as cash, or reinvested into more units
    applyDividends(funds, dividendMode, end);

    // All price dates in the period, across the chosen funds
    const dateSet = new Set();

    for (const fund of funds) {
        for (const observation of fund.obs) {
            if (observation.date >= start && observation.date <= end) dateSet.add(observation.date);
        }
    }

    const dates = [...dateSet].sort();

    for (const fund of funds) fund.series = [];

    const series = dates.map(date => {
        let value = 0;
        let invested = 0;
        let dividends = 0;

        for (const fund of funds) {
            const bought = fund.purchases.filter(p => p.date <= date);
            const units = bought.reduce((sum, p) => sum + p.units, 0);
            const spent = bought.reduce((sum, p) => sum + p.amount, 0);
            const price = priceOnOrBefore(fund.obs, date);
            const fundValue = price ? units * price.bidPrice : 0;
            const cash = fund.dividends
                .filter(d => !d.reinvested && d.exDate <= date)
                .reduce((sum, d) => sum + d.cash, 0);

            invested += spent;
            value += fundValue;
            dividends += cash;

            if (spent > 0) fund.series.push({ date, value: fundValue, invested: spent, dividends: cash });
        }

        return { date, value, invested, dividends };
    }).filter(point => point.invested > 0);

    const endDate = series.length ? series[series.length - 1].date : end;

    const perFund = funds.map(fund => {
        const units = fund.purchases.reduce((sum, p) => sum + p.units, 0);
        const invested = fund.purchases.reduce((sum, p) => sum + p.amount, 0);
        const boosterInvested = fund.purchases.filter(p => p.booster).reduce((sum, p) => sum + p.amount, 0);
        const endPrice = priceOnOrBefore(fund.obs, endDate);
        const value = endPrice ? units * endPrice.bidPrice : 0;
        const paid = fund.dividends.filter(d => d.exDate <= endDate);
        const dividendCash = paid.filter(d => !d.reinvested).reduce((sum, d) => sum + d.cash, 0);
        const dividendTotal = paid.reduce((sum, d) => sum + d.cash, 0);
        const reinvestedUnits = fund.purchases.filter(p => p.reinvest).reduce((sum, p) => sum + p.units, 0);
        const switchedOut = fund.purchases.filter(p => p.switchOut);
        const switchedIn = fund.purchases.filter(p => p.switchIn);
        const gain = value + dividendCash - invested;

        return {
            ...fund,
            units,
            invested,
            boosterInvested,
            startBid: fund.purchases[0]?.bid ?? null,
            startDate: fund.purchases[0]?.date ?? null,
            startBidManual: !!fund.purchases[0]?.manual,
            endBid: endPrice?.bidPrice ?? null,
            endDate: endPrice?.date ?? null,
            endBidManual: !!endPrice?.manual,
            averageCost: units - reinvestedUnits > 1e-9 && invested > 0 ? invested / (units - reinvestedUnits) : null,
            switchedOutValue: switchedOut.reduce((sum, p) => sum + p.flowValue, 0),
            switchedInValue: switchedIn.reduce((sum, p) => sum + p.flowValue, 0),
            fullySwitchedOut: switchedOut.length > 0 && units <= 1e-9,
            value,
            dividendCash,
            dividendTotal,
            dividendPayouts: paid,
            reinvestedUnits,
            buys: fund.purchases.filter(p => !p.reinvest && !p.switchIn && !p.switchOut).length,
            gain,
            gainPct: invested ? (gain / invested) * 100 : null,
            annualised: fund.series.length && yearsBetween(fund.series[0].date, endDate) >= 1
                ? xirr([
                    ...fund.purchases.filter(p => p.amount > 0 && !p.switchIn).map(p => ({ date: p.date, amount: -p.amount })),
                    ...fund.purchases.filter(p => p.switchIn).map(p => ({ date: p.date, amount: -p.flowValue })),
                    ...fund.purchases.filter(p => p.switchOut).map(p => ({ date: p.date, amount: p.flowValue })),
                    ...paid.filter(d => !d.reinvested).map(d => ({ date: d.exDate, amount: d.cash })),
                    { date: endDate, amount: value }
                ].sort((a, b) => a.date.localeCompare(b.date)))
                : null,
            yearRows: buildYearRows(fund.series, fund.series[0]?.date ?? start, endDate)
        };
    });

    const totalInvested = perFund.reduce((sum, fund) => sum + fund.invested, 0);
    const totalValue = perFund.reduce((sum, fund) => sum + fund.value, 0);
    const totalDividendCash = perFund.reduce((sum, fund) => sum + fund.dividendCash, 0);
    const totalDividends = perFund.reduce((sum, fund) => sum + fund.dividendTotal, 0);

    // Cash flows for the annualised (money-weighted) return
    const flowMap = new Map();
    let contributionDates = new Set();

    for (const fund of perFund) {
        for (const purchase of fund.purchases) {
            if (!(purchase.amount > 0)) continue;   // reinvested dividends are not new money
            if (purchase.switchIn || purchase.switchOut) continue;   // switches move money, they don't add it

            contributionDates.add(purchase.date);
            flowMap.set(purchase.date, (flowMap.get(purchase.date) ?? 0) - purchase.amount);
        }

        for (const payout of fund.dividendPayouts) {
            if (payout.reinvested) continue;

            flowMap.set(payout.exDate, (flowMap.get(payout.exDate) ?? 0) + payout.cash);
        }
    }

    const flows = [...flowMap.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([date, amount]) => ({ date, amount }));

    flows.push({ date: endDate, amount: totalValue });

    const firstDate = series[0]?.date ?? start;
    const annualised = yearsBetween(firstDate, endDate) >= 1 ? xirr(flows) : null;

    const yearRows = buildYearRows(series, firstDate, endDate);

    return {
        input,
        firstDate,
        endDate,
        series,
        perFund,
        totalInvested,
        totalValue,
        gain: totalValue + totalDividendCash - totalInvested,
        gainPct: totalInvested ? ((totalValue + totalDividendCash - totalInvested) / totalInvested) * 100 : null,
        totalDividendCash,
        totalDividends,
        dividendMode: input.dividendMode === "reinvest" ? "reinvest" : "cash",
        hasDividends: perFund.some(fund => fund.dividendPayouts.length),
        annualised,
        contributions: contributionDates.size,
        yearRows,
        requestedEnd: end,
        priceDateBeforeEnd: endDate < end,
        manualBids: perFund.some(fund => fund.startBidManual || fund.endBidManual) ||
            switchLog.some(item => item.executed && (item.sellManual || item.into.some(into => into.manual))),
        switches: switchLog,
        boosters: input.boosters ?? [],
        boosterTotal: (input.boosters ?? []).reduce((sum, booster) => sum + booster.amount, 0),
        skippedAmount: skipped.reduce((sum, item) => sum + item.amount, 0),
        skippedCount: new Set(skipped.map(item => item.date)).size
    };
}


/* ============================================================
   SETUP FORM
   ============================================================ */

function renderSelected() {
    const body = qs("#report-funds-body");
    const total = qs("#report-allocation-total");

    if (!body) return;

    if (!report.selected.length) {
        body.innerHTML = `<tr><td colspan="4" class="report-empty">Add funds above (up to ${MAX_FUNDS}).</td></tr>`;
    } else {
        body.innerHTML = report.selected
            .map((item, index) => {
                const fund = report.fundById.get(item.id);

                const edited = Number(item.purchaseBid) > 0 || Number(item.endBid) > 0;

                return `
                    <tr>
                        <td>
                            <div class="fund-name">${escapeHtml(fund?.fundName ?? item.id)}</div>
                            <div class="fund-meta">${escapeHtml(fund?.fundCode ?? "")} · ${escapeHtml(currencyOf(item.id))}</div>
                            <button type="button" class="report-bid-toggle${edited ? " is-edited" : ""}" data-report-bid-toggle="${index}" aria-expanded="${item.bidOpen ? "true" : "false"}">
                                ${edited ? "BID price changed" : "Change BID price"} ${item.bidOpen ? "▴" : "▾"}
                            </button>
                        </td>
                        <td class="report-weight-cell">
                            <input type="number" min="5" max="100" step="5" value="${item.weight}" data-report-weight="${index}" aria-label="Allocation % for ${escapeHtml(fund?.fundName ?? item.id)}">
                            <span>%</span>
                        </td>
                        <td class="report-remove-cell">
                            <button type="button" class="compare-remove" data-report-remove="${index}" aria-label="Remove ${escapeHtml(fund?.fundName ?? item.id)}" title="Remove">×</button>
                        </td>
                    </tr>
                    ${item.bidOpen ? `
                        <tr class="report-bid-row">
                            <td colspan="3">
                                <div class="report-bid-fields">
                                    <label class="report-bid-field">
                                        <span>Purchase BID</span>
                                        <input type="text" inputmode="decimal" value="${escapeHtml(item.purchaseBid ?? "")}" data-report-bid="${index}" data-bid-kind="purchaseBid" aria-label="Purchase BID price for ${escapeHtml(fund?.fundName ?? item.id)}">
                                        <em data-report-bid-hint="purchaseBid-${index}"></em>
                                    </label>
                                    <label class="report-bid-field">
                                        <span>End-date BID</span>
                                        <input type="text" inputmode="decimal" value="${escapeHtml(item.endBid ?? "")}" data-report-bid="${index}" data-bid-kind="endBid" aria-label="End-date BID price for ${escapeHtml(fund?.fundName ?? item.id)}">
                                        <em data-report-bid-hint="endBid-${index}"></em>
                                    </label>
                                    <button type="button" class="pc-link-button" data-report-bid-clear="${index}">Use published prices</button>
                                </div>
                            </td>
                        </tr>
                    ` : ""}
                `;
            })
            .join("");
    }

    const sum = report.selected.reduce((acc, item) => acc + (Number(item.weight) || 0), 0);

    if (total) {
        total.textContent = `Total ${Math.round(sum * 100) / 100}%`;
        total.classList.toggle("is-ok", Math.abs(sum - 100) < 0.01);
        total.classList.toggle("is-off", report.selected.length > 0 && Math.abs(sum - 100) >= 0.01);
    }

    syncDateLimits();
    updateBidHints();
    updateSteps();
}

/*
 * Under each "Change BID price" box: the published price it replaces
 * (for the current start / end dates). Empty box = published price.
 */
function updateBidHints() {
    const start = qs("#report-start")?.value ?? "";
    const end = qs("#report-end")?.value ?? "";

    report.selected.forEach((item, index) => {
        const obs = observationsFor(item.id);

        const purchaseHint = qs(`[data-report-bid-hint="purchaseBid-${index}"]`);
        if (purchaseHint) {
            const price = start ? priceOnOrAfter(obs, start) : null;
            purchaseHint.textContent = price
                ? `Published: ${price.bidPrice.toFixed(5)} on ${formatDate(price.date)}. Used for the initial investment only.`
                : "Used for the initial investment only.";
        }

        const endHint = qs(`[data-report-bid-hint="endBid-${index}"]`);
        if (endHint) {
            const price = end ? priceOnOrBefore(obs, end) : null;
            endHint.textContent = price
                ? `Published: ${price.bidPrice.toFixed(5)} on ${formatDate(price.date)}. Values the fund on ${end ? formatDate(end) : "the end date"}.`
                : "Values the fund on the end date.";
        }

        qs(`[data-report-bid="${index}"][data-bid-kind="purchaseBid"]`)?.setAttribute("placeholder", "Published price");
        qs(`[data-report-bid="${index}"][data-bid-kind="endBid"]`)?.setAttribute("placeholder", "Published price");
    });
}

function syncDateLimits() {
    const startInput = qs("#report-start");
    const endInput = qs("#report-end");
    const note = qs("#report-date-note");
    const adjust = qs("#report-date-adjust");
    const fundLimits = dateLimits();
    const limits = fundLimits ?? paymentRange();

    if (!startInput || !endInput) return;

    if (adjust) {
        adjust.hidden = true;
        adjust.textContent = "";
    }

    if (!limits) {
        startInput.removeAttribute("min");
        startInput.removeAttribute("max");
        endInput.removeAttribute("min");
        endInput.removeAttribute("max");
        if (note) note.textContent = "";
        return;
    }

    const today = new Date().toISOString().slice(0, 10);

    // Start: must fall within the price history.
    startInput.min = limits.earliest;
    startInput.max = limits.latest;

    // End: any date from the first price onwards (not limited to the
    // latest BID date). The report states the price date actually used.
    endInput.min = limits.earliest;
    endInput.max = today;     // no future dates

    if (!endInput.value || endInput.value < limits.earliest || endInput.value > today) {
        endInput.value = today;
    }

    if (!startInput.value) {
        const threeYears = addMonths(limits.latest, -36);

        startInput.value = threeYears > limits.earliest ? threeYears : limits.earliest;
    }

    // Funds picked after the premium was set can have a shorter price
    // history: move the start date into range and say so in step 4.
    // The date typed in step 3 is kept, so removing that fund restores it.
    if (report.requestedStart) startInput.value = report.requestedStart;

    const requested = startInput.value;

    if (startInput.value < limits.earliest) startInput.value = limits.earliest;
    if (startInput.value > limits.latest) startInput.value = limits.latest;

    if (fundLimits && adjust && requested !== startInput.value) {
        const late = report.selected
            .filter(item => observationsFor(item.id)[0]?.date === limits.earliest)
            .map(item => report.fundById.get(item.id)?.fundCode ?? item.id);

        adjust.textContent = requested < limits.earliest
            ? `Start date moved from ${formatDate(requested)} to ${formatDate(startInput.value)}, because ${late.join(", ") || "a chosen fund"} prices begin then. You can change it in step 3.`
            : `Start date moved from ${formatDate(requested)} to ${formatDate(startInput.value)}, the latest price shared by the chosen funds. You can change it in step 3.`;
        adjust.hidden = false;
    }

    if (note) {
        const scope = fundLimits
            ? "Price history for the chosen funds"
            : `Price history for ${PAYMENT_LABELS[report.paymentMode] ?? report.paymentMode ?? "the"} funds`;

        note.textContent =
            `${scope}: ${formatDate(limits.earliest)} to ${formatDate(limits.latest)}. ` +
            `The end date can be up to today; if it is after ${formatDate(limits.latest)}, the report values the portfolio at that latest BID price and says so.` +
            (fundLimits ? "" : " Some funds start later; adding one may move the start date.");
    }
}

function splitEqually() {
    const n = report.selected.length;

    if (!n) return;

    // Whole 5% steps: e.g. 3 funds -> 35 / 35 / 30
    const steps = 100 / ALLOCATION_STEP;
    const base = Math.floor(steps / n);
    let remainder = steps - base * n;

    report.selected = report.selected.map(item => {
        const extra = remainder > 0 ? 1 : 0;

        remainder -= extra;

        return { ...item, weight: (base + extra) * ALLOCATION_STEP };
    });

    renderSelected();
}

function addFund(id) {
    if (!id || report.selected.some(item => item.id === id) || report.selected.length >= MAX_FUNDS) return;

    if (!acceptsPayment(id)) return;

    report.selected.push({ id, weight: 0 });
    splitEqually();
}

function renderSuggestions() {
    const input = qs("#report-fund-search");
    const list = qs("#report-fund-suggestions");

    if (!input || !list) return;

    const query = input.value.trim().toLowerCase();
    const chosen = new Set(report.selected.map(item => item.id));

    const matches = report.funds
        .filter(fund => {
            const id = fundId(fund);

            if (chosen.has(id) || !observationsFor(id).length) return false;
            if (!acceptsPayment(id)) return false;
            if (!query) return true;

            return (
                String(fund.fundName ?? "").toLowerCase().includes(query) ||
                String(fund.fundCode ?? "").toLowerCase().includes(query)
            );
        });

    list.innerHTML = matches.length
        ? matches
            .map(fund => `
                <li class="compare-suggestion" role="option" data-report-add="${escapeHtml(fundId(fund))}">
                    <span class="compare-suggestion-name">${escapeHtml(fund.fundName ?? "")}</span>
                    <span class="compare-suggestion-code">${escapeHtml(fund.fundCode ?? "")} · ${escapeHtml(currencyOf(fundId(fund)))}</span>
                </li>
            `)
            .join("")
        : `<li class="compare-suggestion-empty">${report.selected.length >= MAX_FUNDS ? `Maximum ${MAX_FUNDS} funds` : `No matching funds that accept ${escapeHtml(report.paymentMode ?? "this payment mode")}`}</li>`;

    list.hidden = false;
    placeDropdown(list);
}

function closeSuggestions() {
    const list = qs("#report-fund-suggestions");

    if (list) list.hidden = true;
}

/* ============================================================
   STEP-BY-STEP SETUP
   1 Client & adviser -> 2 Payment mode -> 3 Premium
   -> 4 Funds & allocation -> 5 Investment booster.
   Each step appears once the one before is done.
   ============================================================ */

/* Payment term: empty, or a whole number of years from 1 to 99 */
function termValid(text) {
    const value = String(text ?? "").trim();

    if (!value) return true;

    const years = Number(value);

    return Number.isInteger(years) && years >= 1 && years <= 99;
}

function premiumDone() {
    const lump = Number(qs("#report-lump")?.value) || 0;
    const topUp = Number(qs("#report-topup")?.value) || 0;
    const frequency = qs("#report-frequency")?.value ?? "monthly";
    const start = qs("#report-start")?.value ?? "";
    const end = qs("#report-end")?.value ?? "";
    const today = new Date().toISOString().slice(0, 10);

    if (lump < 0 || topUp < 0) return false;
    if (lump <= 0 && topUp <= 0) return false;
    if (topUp > 0 && frequency === "none") return false;
    if (!termValid(qs("#report-term")?.value ?? "")) return false;
    if (!start || !end || start >= end || end > today) return false;

    return true;
}

function stepDone(step) {
    if (step === 1) {
        return Boolean(qs("#report-client")?.value.trim()) && Boolean(qs("#report-adviser")?.value.trim());
    }

    if (step === 2) return stepDone(1) && Boolean(report.paymentMode);

    if (step === 3) return stepDone(2) && premiumDone();

    if (step === 4) {
        const sum = report.selected.reduce((acc, item) => acc + (Number(item.weight) || 0), 0);

        return stepDone(3) && report.selected.length > 0 && Math.abs(sum - 100) < 0.01;
    }

    if (step === 5) {
        if (!stepDone(4)) return false;
        if (report.booster === "no") return true;
        if (report.booster !== "yes" || !report.boosters.length) return false;

        const input = readInput();

        return report.boosters.every((booster, index) => !boosterProblem(booster, index, input));
    }

    if (step === 6) {
        if (!stepDone(5)) return false;
        if (report.switching === "no") return true;
        if (report.switching !== "yes" || !report.switches.length) return false;

        const input = readInput();

        return report.switches.every((item, index) => !switchProblem(item, index, input));
    }

    return false;
}

function updateSteps() {
    const show = {
        2: stepDone(1),
        3: stepDone(2),
        4: stepDone(3),
        5: stepDone(4),
        6: stepDone(5)
    };

    for (const [step, visible] of Object.entries(show)) {
        const section = qs(`[data-report-step="${step}"]`);

        if (section) section.hidden = !visible;
    }

    for (const step of [1, 2, 3, 4, 5, 6]) {
        qs(`[data-report-step="${step}"]`)?.classList.toggle("is-done", stepDone(step));
    }

    renderDividendChoice();

    // Generate is only clickable once every step is complete
    const generate = qs("#report-form .report-generate[type=submit]");

    if (generate) generate.disabled = !stepDone(6);

    report.boosters.forEach((_, index) => refreshBoosterStatus(index));

    const note = qs("#report-payment-note");

    if (note) {
        const eligible = report.funds.filter(fund => acceptsPayment(fundId(fund)) && observationsFor(fundId(fund)).length).length;

        note.textContent = report.paymentMode
            ? `Showing the ${eligible} funds that accept ${PAYMENT_LABELS[report.paymentMode] ?? report.paymentMode}.`
            : "";
    }
}

function renderPaymentOptions() {
    const container = qs("#report-payment-options");

    if (!container) return;

    const counts = new Map(PAYMENT_MODES.map(mode => [
        mode,
        report.funds.filter(fund => paymentModesOf(fundId(fund)).includes(mode) && observationsFor(fundId(fund)).length).length
    ]));

    const available = PAYMENT_MODES.filter(mode => counts.get(mode) > 0);

    container.innerHTML = available.length
        ? available
            .map(mode => `
                <button
                    type="button"
                    class="report-payment-option${report.paymentMode === mode ? " active" : ""}"
                    role="radio"
                    aria-checked="${report.paymentMode === mode}"
                    data-report-payment="${escapeHtml(mode)}"
                >
                    <span class="report-payment-name">${escapeHtml(mode)}</span>
                    <span class="report-payment-desc">${escapeHtml(PAYMENT_LABELS[mode] ?? mode)}</span>
                    <span class="report-payment-count">${counts.get(mode)} funds</span>
                </button>
            `)
            .join("")
        : `<p class="settings-help">Payment modes aren't in the fund data yet. Run Build Funds Data to add them.</p>`;
}

function setPaymentMode(mode) {
    if (!PAYMENT_MODES.includes(mode) || report.paymentMode === mode) return;

    report.paymentMode = mode;

    // Drop funds that don't accept the new payment mode
    const removed = report.selected.filter(item => !acceptsPayment(item.id, mode));

    if (removed.length) {
        report.selected = report.selected.filter(item => acceptsPayment(item.id, mode));
    }

    for (const booster of report.boosters) {
        booster.selected = booster.selected.filter(item => acceptsPayment(item.id, mode));
    }

    for (const item of report.switches) {
        item.selected = item.selected.filter(target => acceptsPayment(target.id, mode));
    }

    renderPaymentOptions();
    renderBoosters();
    renderSwitches();

    if (removed.length && report.selected.length) {
        splitEqually();
    } else {
        renderSelected();
    }

    const note = qs("#report-payment-note");

    if (note && removed.length) {
        note.textContent +=
            ` Removed ${removed.length} fund${removed.length === 1 ? "" : "s"} that ${removed.length === 1 ? "doesn't" : "don't"} accept ${mode}: ` +
            `${removed.map(item => report.fundById.get(item.id)?.fundCode ?? item.id).join(", ")}.`;
    }
}

/* ============================================================
   INVESTMENT BOOSTERS (step 5)
   One-off extra investments, each with its own date, amount and
   fund allocation (5% steps, total 100%). There can be several.
   ============================================================ */

function newBooster() {
    return {
        date: "",
        amount: "",
        selected: report.selected.map(item => ({ id: item.id, weight: item.weight }))
    };
}

function boosterSum(booster) {
    return booster.selected.reduce((acc, item) => acc + (Number(item.weight) || 0), 0);
}

function boosterProblem(booster, index, input) {
    const label = `Booster ${index + 1}`;
    const code = id => report.fundById.get(id)?.fundCode ?? id;

    if (!booster.date) return `${label}: choose a date.`;

    if (!(Number(booster.amount) > 0)) return `${label}: enter an amount above 0.`;

    if (!booster.selected.length) return `${label}: add at least one fund.`;

    if (booster.selected.some(item => !(Number(item.weight) > 0) || Number(item.weight) % ALLOCATION_STEP !== 0)) {
        return `${label}: allocations must be in steps of ${ALLOCATION_STEP}%.`;
    }

    const sum = boosterSum(booster);

    if (Math.abs(sum - 100) >= 0.01) return `${label}: the allocation adds up to ${Math.round(sum * 100) / 100}%. It needs to total 100%.`;

    if (input?.start && booster.date < input.start) return `${label}: the date must be on or after the start date (${formatDate(input.start)}).`;

    if (input?.end && booster.date > input.end) return `${label}: the date must be on or before the end date (${formatDate(input.end)}).`;

    for (const item of booster.selected) {
        if (!acceptsPayment(item.id)) return `${label}: ${code(item.id)} doesn't accept ${report.paymentMode}.`;

        const obs = observationsFor(item.id);

        if (!obs.length) return `${label}: no price history for ${code(item.id)}.`;

        if (obs[0].date > booster.date) {
            return `${label}: ${code(item.id)} prices begin on ${formatDate(obs[0].date)}, after the booster date.`;
        }
    }

    return null;
}

function boosterRows(booster, index) {
    if (!booster.selected.length) {
        return `<tr><td colspan="3" class="report-empty">Add funds for this booster (up to ${MAX_FUNDS}).</td></tr>`;
    }

    return booster.selected
        .map((item, slot) => {
            const fund = report.fundById.get(item.id);
            const name = escapeHtml(fund?.fundName ?? item.id);

            return `
                <tr>
                    <td>
                        <div class="fund-name">${name}</div>
                        <div class="fund-meta">${escapeHtml(fund?.fundCode ?? "")} · ${escapeHtml(currencyOf(item.id))}</div>
                    </td>
                    <td class="report-weight-cell">
                        <input type="number" min="5" max="100" step="5" value="${item.weight}" data-booster-weight="${index}:${slot}" aria-label="Booster ${index + 1} allocation % for ${name}">
                        <span>%</span>
                    </td>
                    <td class="report-remove-cell">
                        <button type="button" class="compare-remove" data-booster-fund-remove="${index}:${slot}" aria-label="Remove ${name} from booster ${index + 1}" title="Remove">×</button>
                    </td>
                </tr>
            `;
        })
        .join("");
}

function boosterMarkup(booster, index) {
    const start = qs("#report-start")?.value ?? "";
    const end = qs("#report-end")?.value ?? "";

    return `
        <div class="report-booster" data-booster="${index}">
            <div class="report-booster-head">
                <strong>Booster ${index + 1}</strong>
                <button type="button" class="compare-remove" data-booster-remove="${index}" aria-label="Remove booster ${index + 1}" title="Remove booster">×</button>
            </div>

            <div class="report-grid report-booster-grid">
                <label class="report-field">
                    <span>Date</span>
                    <input type="date" data-booster-field="date" data-booster-index="${index}" value="${escapeHtml(booster.date)}"${start ? ` min="${start}"` : ""}${end ? ` max="${end}"` : ""}>
                </label>

                <label class="report-field">
                    <span>Amount</span>
                    <input type="number" min="0" step="100" inputmode="decimal" placeholder="e.g. 5000" data-booster-field="amount" data-booster-index="${index}" value="${escapeHtml(booster.amount)}">
                </label>
            </div>

            <div class="report-picker-row">
                <div class="compare-picker report-picker">
                    <input type="search" autocomplete="off" placeholder="Add a fund to this booster…" aria-label="Search funds to add to booster ${index + 1}" data-booster-search="${index}">
                    <ul class="compare-suggestions" role="listbox" data-booster-suggestions="${index}" hidden></ul>
                </div>

                <button type="button" class="news-clear-filters" data-booster-copy="${index}">Same as main allocation</button>
                <button type="button" class="news-clear-filters" data-booster-split="${index}">Split equally</button>

                <span class="report-total" data-booster-total="${index}">Total 0%</span>
            </div>

            <div class="table-wrap">
                <table class="data-table report-funds-table">
                    <thead>
                        <tr>
                            <th scope="col">Fund</th>
                            <th scope="col">Allocation</th>
                            <th scope="col"><span class="sr-only">Remove</span></th>
                        </tr>
                    </thead>
                    <tbody>${boosterRows(booster, index)}</tbody>
                </table>
            </div>

            <p class="settings-help report-booster-status" data-booster-status="${index}"></p>
        </div>
    `;
}

function refreshBoosterStatus(index) {
    const booster = report.boosters[index];

    if (!booster) return;

    const sum = boosterSum(booster);
    const total = qs(`[data-booster-total="${index}"]`);

    if (total) {
        total.textContent = `Total ${Math.round(sum * 100) / 100}%`;
        total.classList.toggle("is-ok", Math.abs(sum - 100) < 0.01);
        total.classList.toggle("is-off", booster.selected.length > 0 && Math.abs(sum - 100) >= 0.01);
    }

    const status = qs(`[data-booster-status="${index}"]`);

    if (status) {
        const problem = boosterProblem(booster, index, readInput());

        status.textContent = problem ? problem.replace(/^Booster \d+: /, "To do: ") : "Booster ready.";
        status.classList.toggle("is-ok", !problem);
    }
}

function renderBoosters() {
    if (report.switching === "yes") queueMicrotask(renderSwitches);

    const list = qs("#report-booster-list");
    const add = qs("#report-booster-add");
    const yes = report.booster === "yes";

    document.querySelectorAll("[data-report-booster]").forEach(button => {
        const active = button.dataset.reportBooster === report.booster;

        button.classList.toggle("active", active);
        button.setAttribute("aria-checked", String(active));
    });

    if (list) {
        list.hidden = !yes;
        list.innerHTML = yes ? report.boosters.map(boosterMarkup).join("") : "";
    }

    if (add) add.hidden = !yes;

    updateSteps();
}

function splitBooster(booster) {
    const n = booster.selected.length;

    if (!n) return;

    const steps = 100 / ALLOCATION_STEP;
    const base = Math.floor(steps / n);
    let remainder = steps - base * n;

    booster.selected = booster.selected.map(item => {
        const extra = remainder > 0 ? 1 : 0;

        remainder -= extra;

        return { ...item, weight: (base + extra) * ALLOCATION_STEP };
    });
}

function renderBoosterSuggestions(index) {
    const booster = report.boosters[index];
    const input = qs(`[data-booster-search="${index}"]`);
    const list = qs(`[data-booster-suggestions="${index}"]`);

    if (!booster || !input || !list) return;

    const query = input.value.trim().toLowerCase();
    const chosen = new Set(booster.selected.map(item => item.id));

    const matches = booster.selected.length >= MAX_FUNDS ? [] : report.funds.filter(fund => {
        const id = fundId(fund);

        if (chosen.has(id) || !observationsFor(id).length || !acceptsPayment(id)) return false;
        if (!query) return true;

        return (
            String(fund.fundName ?? "").toLowerCase().includes(query) ||
            String(fund.fundCode ?? "").toLowerCase().includes(query)
        );
    });

    list.innerHTML = matches.length
        ? matches
            .map(fund => `
                <li class="compare-suggestion" role="option" data-booster-add-fund="${index}:${escapeHtml(fundId(fund))}">
                    <span class="compare-suggestion-name">${escapeHtml(fund.fundName ?? "")}</span>
                    <span class="compare-suggestion-code">${escapeHtml(fund.fundCode ?? "")} · ${escapeHtml(currencyOf(fundId(fund)))}</span>
                </li>
            `)
            .join("")
        : `<li class="compare-suggestion-empty">${booster.selected.length >= MAX_FUNDS ? `Maximum ${MAX_FUNDS} funds` : `No matching funds that accept ${escapeHtml(report.paymentMode ?? "this payment mode")}`}</li>`;

    list.hidden = false;
    placeDropdown(list);
}

function setFrequency(value) {
    const frequency = qs("#report-frequency");

    if (!frequency || frequency.value === value) return;

    frequency.value = value;
    frequency.dispatchEvent(new Event("vselect:sync"));
}

function syncTopUpFrequency() {
    const frequency = qs("#report-frequency");
    const topUp = Number(qs("#report-topup")?.value) || 0;

    if (!frequency) return;

    if (topUp <= 0) {
        setFrequency("none");
    } else if (frequency.value === "none") {
        setFrequency("monthly");
    }
}

/* Dividends choice: only shown when a chosen fund (main portfolio
   or a booster) pays dividends */
function renderDividendChoice() {
    const box = qs("#report-dividend-choice");

    if (!box) return;

    const ids = [
        ...report.selected.map(item => item.id),
        ...(report.booster === "yes" ? report.boosters.flatMap(booster => booster.selected.map(item => item.id)) : []),
        ...(report.switching === "yes" ? report.switches.flatMap(item => item.selected.map(target => target.id)) : [])
    ];

    box.hidden = !ids.some(fundPaysDividends);

    box.querySelectorAll("[data-report-dividend]").forEach(button => {
        const active = button.dataset.reportDividend === report.dividendMode;

        button.classList.toggle("active", active);
        button.setAttribute("aria-checked", String(active));
    });
}

function bindBoosterEvents() {
    qs("#report-booster-choice")?.addEventListener("click", event => {
        const option = event.target.closest("[data-report-booster]");

        if (!option) return;

        report.booster = option.dataset.reportBooster;

        if (report.booster === "yes" && !report.boosters.length) report.boosters.push(newBooster());

        renderBoosters();
    });

    qs("#report-booster-add")?.addEventListener("click", () => {
        report.boosters.push(newBooster());
        renderBoosters();

        const last = qs(`[data-booster="${report.boosters.length - 1}"] [data-booster-field="date"]`);

        last?.focus();
    });

    const list = qs("#report-booster-list");

    if (!list) return;

    const pair = value => {
        const [index, rest] = String(value).split(/:(.*)/s);

        return [Number(index), rest];
    };

    list.addEventListener("input", event => {
        const field = event.target.closest("[data-booster-field]");

        if (field) {
            const booster = report.boosters[Number(field.dataset.boosterIndex)];

            if (booster) booster[field.dataset.boosterField] = field.value;

            updateSteps();
            return;
        }

        const weight = event.target.closest("[data-booster-weight]");

        if (weight) {
            const [index, slot] = pair(weight.dataset.boosterWeight);
            const item = report.boosters[index]?.selected[Number(slot)];

            if (item) item.weight = Math.max(0, Number(weight.value) || 0);

            updateSteps();
            return;
        }

        const search = event.target.closest("[data-booster-search]");

        if (search) renderBoosterSuggestions(Number(search.dataset.boosterSearch));
    });

    // Snap booster allocations to 5% steps
    list.addEventListener("change", event => {
        const weight = event.target.closest("[data-booster-weight]");

        if (!weight) return;

        const [index, slot] = pair(weight.dataset.boosterWeight);
        const item = report.boosters[index]?.selected[Number(slot)];

        if (item) item.weight = roundToStep(weight.value);

        renderBoosters();
    });

    list.addEventListener("focusin", event => {
        const search = event.target.closest("[data-booster-search]");

        if (search) renderBoosterSuggestions(Number(search.dataset.boosterSearch));
    });

    list.addEventListener("focusout", event => {
        const search = event.target.closest("[data-booster-search]");

        if (!search) return;

        setTimeout(() => {
            const suggestions = qs(`[data-booster-suggestions="${search.dataset.boosterSearch}"]`);

            if (suggestions) suggestions.hidden = true;
        }, 150);
    });

    list.addEventListener("keydown", event => {
        if (event.key === "Escape" && event.target.closest("[data-booster-search]")) {
            const suggestions = qs(`[data-booster-suggestions="${event.target.dataset.boosterSearch}"]`);

            if (suggestions) suggestions.hidden = true;
        }
    });

    list.addEventListener("mousedown", event => {
        const option = event.target.closest("[data-booster-add-fund]");

        if (!option) return;

        event.preventDefault();

        const [index, id] = pair(option.dataset.boosterAddFund);
        const booster = report.boosters[index];

        if (!booster || booster.selected.some(item => item.id === id) || booster.selected.length >= MAX_FUNDS) return;

        booster.selected.push({ id, weight: 0 });
        splitBooster(booster);
        renderBoosters();
    });

    list.addEventListener("click", event => {
        const removeBooster = event.target.closest("[data-booster-remove]");

        if (removeBooster) {
            report.boosters.splice(Number(removeBooster.dataset.boosterRemove), 1);
            renderBoosters();
            return;
        }

        const removeFund = event.target.closest("[data-booster-fund-remove]");

        if (removeFund) {
            const [index, slot] = pair(removeFund.dataset.boosterFundRemove);

            report.boosters[index]?.selected.splice(Number(slot), 1);
            renderBoosters();
            return;
        }

        const copy = event.target.closest("[data-booster-copy]");

        if (copy) {
            const booster = report.boosters[Number(copy.dataset.boosterCopy)];

            if (booster) booster.selected = report.selected.map(item => ({ id: item.id, weight: item.weight }));

            renderBoosters();
            return;
        }

        const split = event.target.closest("[data-booster-split]");

        if (split) {
            const booster = report.boosters[Number(split.dataset.boosterSplit)];

            if (booster) splitBooster(booster);

            renderBoosters();
        }
    });
}

/* ============================================================
   FUND SWITCHING (step 6)
   Each switch: a date, the fund switched out of, how much of its
   units (%), and the fund(s) switched into (5% steps, total 100%).
   A 100% switch also sends that fund's later top-ups to the new
   fund(s). There can be several switches.
   ============================================================ */

function newSwitch() {
    return { date: "", fromId: "", portion: "100", sellBid: "", selected: [] };
}

/* Published BID used for a switch (grey hint in the BID boxes) */
function publishedBid(id, date, side = "after") {
    if (!id || !date) return "Published price";

    const obs = observationsFor(id);
    const price = side === "after" ? priceOnOrAfter(obs, date) : priceOnOrBefore(obs, date);

    return price ? `${price.bidPrice.toFixed(5)} (published ${formatDate(price.date)})` : "Published price";
}

/* Funds that can be switched out of on a date: the main portfolio,
   boosters bought by then, and funds switched into earlier */
function switchSources(index) {
    const item = report.switches[index];
    const date = item?.date || "9999-12-31";
    const ids = [];
    const add = id => { if (id && !ids.includes(id)) ids.push(id); };

    report.selected.forEach(fund => add(fund.id));

    if (report.booster === "yes") {
        report.boosters
            .filter(booster => booster.date && booster.date <= date)
            .forEach(booster => booster.selected.forEach(fund => add(fund.id)));
    }

    report.switches.forEach((other, otherIndex) => {
        if (otherIndex === index || !other.date) return;
        if (other.date < date || (other.date === date && otherIndex < index)) {
            other.selected.forEach(fund => add(fund.id));
        }
    });

    return ids;
}

function switchSum(item) {
    return item.selected.reduce((acc, target) => acc + (Number(target.weight) || 0), 0);
}

function switchProblem(item, index, input) {
    const label = `Switch ${index + 1}`;
    const code = id => report.fundById.get(id)?.fundCode ?? id;

    if (!item.date) return `${label}: choose a date.`;

    if (input?.start && item.date < input.start) return `${label}: the date must be on or after the start date (${formatDate(input.start)}).`;

    if (input?.end && item.date > input.end) return `${label}: the date must be on or before the end date (${formatDate(input.end)}).`;

    if (!item.fromId) return `${label}: choose the fund to switch out of.`;

    if (!switchSources(index).includes(item.fromId)) {
        return `${label}: ${code(item.fromId)} isn't held on ${formatDate(item.date)}. Choose another fund or date.`;
    }

    const portion = Number(item.portion);

    if (!(portion > 0 && portion <= 100)) return `${label}: the units to switch must be from 1% to 100%.`;

    if (!item.selected.length) return `${label}: add the fund(s) to switch into.`;

    if (item.selected.some(target => target.id === item.fromId)) return `${label}: a fund can't be switched into itself.`;

    if (item.selected.some(target => !(Number(target.weight) > 0) || Number(target.weight) % ALLOCATION_STEP !== 0)) {
        return `${label}: the split must be in steps of ${ALLOCATION_STEP}%.`;
    }

    const sum = switchSum(item);

    if (Math.abs(sum - 100) >= 0.01) return `${label}: the split adds up to ${Math.round(sum * 100) / 100}%. It needs to total 100%.`;

    if (String(item.sellBid ?? "").trim() && !(Number(item.sellBid) > 0)) {
        return `${label}: the switch-out BID must be a price above 0, or left empty to use the published price.`;
    }

    for (const target of item.selected) {
        if (String(target.buyBid ?? "").trim() && !(Number(target.buyBid) > 0)) {
            return `${label}: the BID for ${code(target.id)} must be a price above 0, or left empty to use the published price.`;
        }

        if (!acceptsPayment(target.id)) return `${label}: ${code(target.id)} doesn't accept ${report.paymentMode}.`;

        const obs = observationsFor(target.id);

        if (!obs.length) return `${label}: no price history for ${code(target.id)}.`;

        if (obs[0].date > item.date) return `${label}: ${code(target.id)} prices begin on ${formatDate(obs[0].date)}, after the switch date.`;
    }

    return null;
}

function switchRows(item, index) {
    if (!item.selected.length) {
        return `<tr><td colspan="4" class="report-empty">Add the fund(s) to switch into (up to ${MAX_FUNDS}).</td></tr>`;
    }

    return item.selected
        .map((target, slot) => {
            const fund = report.fundById.get(target.id);
            const name = escapeHtml(fund?.fundName ?? target.id);

            return `
                <tr>
                    <td>
                        <div class="fund-name">${name}</div>
                        <div class="fund-meta">${escapeHtml(fund?.fundCode ?? "")} · ${escapeHtml(currencyOf(target.id))}</div>
                    </td>
                    <td class="report-weight-cell">
                        <input type="number" min="5" max="100" step="5" value="${target.weight}" data-switch-weight="${index}:${slot}" aria-label="Switch ${index + 1} split % for ${name}">
                        <span>%</span>
                    </td>
                    <td class="report-switch-bid-cell">
                        <input type="text" inputmode="decimal" placeholder="${escapeHtml(publishedBid(target.id, item.date, "after"))}" value="${escapeHtml(target.buyBid ?? "")}" data-switch-buy-bid="${index}:${slot}" aria-label="Switch ${index + 1} BID price for ${name}">
                    </td>
                    <td class="report-remove-cell">
                        <button type="button" class="compare-remove" data-switch-fund-remove="${index}:${slot}" aria-label="Remove ${name} from switch ${index + 1}" title="Remove">×</button>
                    </td>
                </tr>
            `;
        })
        .join("");
}

function switchMarkup(item, index) {
    const start = qs("#report-start")?.value ?? "";
    const end = qs("#report-end")?.value ?? "";
    const sources = switchSources(index);

    const options = [`<option value="">Choose a fund…</option>`]
        .concat(sources.map(id => {
            const fund = report.fundById.get(id);
            return `<option value="${escapeHtml(id)}" ${id === item.fromId ? "selected" : ""}>${escapeHtml(fund?.fundName ?? id)} (${escapeHtml(fund?.fundCode ?? "")})</option>`;
        }))
        .join("");

    return `
        <div class="report-booster report-switch" data-switch="${index}">
            <div class="report-booster-head">
                <strong>Switch ${index + 1}</strong>
                <button type="button" class="compare-remove" data-switch-remove="${index}" aria-label="Remove switch ${index + 1}" title="Remove switch">×</button>
            </div>

            <div class="report-grid report-switch-grid">
                <label class="report-field">
                    <span>Date</span>
                    <input type="date" data-switch-field="date" data-switch-index="${index}" value="${escapeHtml(item.date)}"${start ? ` min="${start}"` : ""}${end ? ` max="${end}"` : ""}>
                </label>

                <label class="report-field report-switch-from">
                    <span>Switch out of</span>
                    <select data-switch-field="fromId" data-switch-index="${index}">${options}</select>
                </label>

                <label class="report-field">
                    <span>Units to switch</span>
                    <span class="report-weight-cell report-switch-portion">
                        <input type="number" min="1" max="100" step="5" inputmode="decimal" data-switch-field="portion" data-switch-index="${index}" value="${escapeHtml(item.portion)}">
                        <span>%</span>
                    </span>
                </label>

                <label class="report-field">
                    <span>Switch-out BID</span>
                    <input type="text" inputmode="decimal" placeholder="${escapeHtml(publishedBid(item.fromId, item.date, "after"))}" data-switch-field="sellBid" data-switch-index="${index}" value="${escapeHtml(item.sellBid ?? "")}">
                </label>
            </div>

            <p class="settings-help report-switch-bid-note">BID prices: leave empty to use the published price shown in grey, or type the actual price.</p>

            <p class="settings-help report-switch-help">Switch into:${Number(item.portion) >= 100 ? " later top-ups for the fund switched out also go to these funds." : ""}</p>

            <div class="report-picker-row">
                <div class="compare-picker report-picker">
                    <input type="search" autocomplete="off" placeholder="Add a fund to switch into…" aria-label="Search funds to switch into (switch ${index + 1})" data-switch-search="${index}">
                    <ul class="compare-suggestions" role="listbox" data-switch-suggestions="${index}" hidden></ul>
                </div>

                <button type="button" class="news-clear-filters" data-switch-split="${index}">Split equally</button>

                <span class="report-total" data-switch-total="${index}">Total 0%</span>
            </div>

            <div class="table-wrap">
                <table class="data-table report-funds-table">
                    <thead>
                        <tr>
                            <th scope="col">Fund</th>
                            <th scope="col">Split</th>
                            <th scope="col" class="report-switch-bid-head">BID price</th>
                            <th scope="col"><span class="sr-only">Remove</span></th>
                        </tr>
                    </thead>
                    <tbody>${switchRows(item, index)}</tbody>
                </table>
            </div>

            <p class="settings-help report-booster-status" data-switch-status="${index}"></p>
        </div>
    `;
}

function refreshSwitchStatus(index) {
    const item = report.switches[index];

    if (!item) return;

    const sum = switchSum(item);
    const total = qs(`[data-switch-total="${index}"]`);

    if (total) {
        total.textContent = `Total ${Math.round(sum * 100) / 100}%`;
        total.classList.toggle("is-ok", Math.abs(sum - 100) < 0.01);
        total.classList.toggle("is-off", item.selected.length > 0 && Math.abs(sum - 100) >= 0.01);
    }

    const status = qs(`[data-switch-status="${index}"]`);

    if (status) {
        const problem = switchProblem(item, index, readInput());

        status.textContent = problem ? problem.replace(/^Switch \d+: /, "To do: ") : "Switch ready.";
        status.classList.toggle("is-ok", !problem);
    }
}

function renderSwitches() {
    const list = qs("#report-switch-list");
    const add = qs("#report-switch-add");
    const yes = report.switching === "yes";

    document.querySelectorAll("[data-report-switching]").forEach(button => {
        const active = button.dataset.reportSwitching === report.switching;

        button.classList.toggle("active", active);
        button.setAttribute("aria-checked", String(active));
    });

    if (list) {
        list.hidden = !yes;
        list.innerHTML = yes ? report.switches.map(switchMarkup).join("") : "";
    }

    if (add) add.hidden = !yes;

    updateSteps();

    if (yes) report.switches.forEach((_, index) => refreshSwitchStatus(index));
}

function splitSwitch(item) {
    const n = item.selected.length;

    if (!n) return;

    const steps = 100 / ALLOCATION_STEP;
    const base = Math.floor(steps / n);
    let remainder = steps - base * n;

    item.selected = item.selected.map(target => {
        const extra = remainder > 0 ? 1 : 0;

        remainder -= extra;

        return { ...target, weight: (base + extra) * ALLOCATION_STEP };
    });
}

function renderSwitchSuggestions(index) {
    const item = report.switches[index];
    const input = qs(`[data-switch-search="${index}"]`);
    const list = qs(`[data-switch-suggestions="${index}"]`);

    if (!item || !input || !list) return;

    const query = input.value.trim().toLowerCase();
    const chosen = new Set([...item.selected.map(target => target.id), item.fromId]);

    const matches = item.selected.length >= MAX_FUNDS ? [] : report.funds.filter(fund => {
        const id = fundId(fund);

        if (chosen.has(id) || !observationsFor(id).length || !acceptsPayment(id)) return false;
        if (!query) return true;

        return (
            String(fund.fundName ?? "").toLowerCase().includes(query) ||
            String(fund.fundCode ?? "").toLowerCase().includes(query)
        );
    });

    list.innerHTML = matches.length
        ? matches
            .map(fund => `
                <li class="compare-suggestion" role="option" data-switch-add-fund="${index}:${escapeHtml(fundId(fund))}">
                    <span class="compare-suggestion-name">${escapeHtml(fund.fundName ?? "")}</span>
                    <span class="compare-suggestion-code">${escapeHtml(fund.fundCode ?? "")} · ${escapeHtml(currencyOf(fundId(fund)))}</span>
                </li>
            `)
            .join("")
        : `<li class="compare-suggestion-empty">${item.selected.length >= MAX_FUNDS ? `Maximum ${MAX_FUNDS} funds` : `No matching funds that accept ${escapeHtml(report.paymentMode ?? "this payment mode")}`}</li>`;

    list.hidden = false;
    placeDropdown(list);
}

function bindSwitchEvents() {
    qs("#report-switch-choice")?.addEventListener("click", event => {
        const option = event.target.closest("[data-report-switching]");

        if (!option) return;

        report.switching = option.dataset.reportSwitching;

        if (report.switching === "yes" && !report.switches.length) report.switches.push(newSwitch());

        renderSwitches();
    });

    qs("#report-switch-add")?.addEventListener("click", () => {
        report.switches.push(newSwitch());
        renderSwitches();

        qs(`[data-switch="${report.switches.length - 1}"] [data-switch-field="date"]`)?.focus();
    });

    const list = qs("#report-switch-list");

    if (!list) return;

    const pair = value => {
        const [index, rest] = String(value).split(/:(.*)/s);

        return [Number(index), rest];
    };

    list.addEventListener("input", event => {
        const field = event.target.closest("[data-switch-field]");

        if (field) {
            const index = Number(field.dataset.switchIndex);
            const item = report.switches[index];

            if (item) item[field.dataset.switchField] = field.value;

            refreshSwitchStatus(index);
            updateSteps();
            return;
        }

        const weight = event.target.closest("[data-switch-weight]");

        if (weight) {
            const [index, slot] = pair(weight.dataset.switchWeight);
            const target = report.switches[index]?.selected[Number(slot)];

            if (target) target.weight = Math.max(0, Number(weight.value) || 0);

            refreshSwitchStatus(index);
            updateSteps();
            return;
        }

        const buyBid = event.target.closest("[data-switch-buy-bid]");

        if (buyBid) {
            const [index, slot] = pair(buyBid.dataset.switchBuyBid);
            const target = report.switches[index]?.selected[Number(slot)];

            if (target) target.buyBid = buyBid.value.trim();

            refreshSwitchStatus(index);
            updateSteps();
            return;
        }

        const search = event.target.closest("[data-switch-search]");

        if (search) renderSwitchSuggestions(Number(search.dataset.switchSearch));
    });

    list.addEventListener("change", event => {
        const field = event.target.closest("[data-switch-field]");

        // Date / fund / % changed: redraw (the fund list depends on the date)
        if (field && field.dataset.switchField === "sellBid") return;

        if (field) {
            const item = report.switches[Number(field.dataset.switchIndex)];

            if (item) {
                item[field.dataset.switchField] = field.value;

                if (field.dataset.switchField === "fromId") {
                    item.selected = item.selected.filter(target => target.id !== field.value);
                }
            }

            renderSwitches();
            return;
        }

        const weight = event.target.closest("[data-switch-weight]");

        if (!weight) return;

        const [index, slot] = pair(weight.dataset.switchWeight);
        const target = report.switches[index]?.selected[Number(slot)];

        if (target) target.weight = roundToStep(weight.value);

        renderSwitches();
    });

    list.addEventListener("focusin", event => {
        const search = event.target.closest("[data-switch-search]");

        if (search) renderSwitchSuggestions(Number(search.dataset.switchSearch));
    });

    list.addEventListener("focusout", event => {
        const search = event.target.closest("[data-switch-search]");

        if (!search) return;

        setTimeout(() => {
            const suggestions = qs(`[data-switch-suggestions="${search.dataset.switchSearch}"]`);

            if (suggestions) suggestions.hidden = true;
        }, 150);
    });

    list.addEventListener("keydown", event => {
        if (event.key === "Escape" && event.target.closest("[data-switch-search]")) {
            const suggestions = qs(`[data-switch-suggestions="${event.target.dataset.switchSearch}"]`);

            if (suggestions) suggestions.hidden = true;
        }
    });

    list.addEventListener("mousedown", event => {
        const option = event.target.closest("[data-switch-add-fund]");

        if (!option) return;

        event.preventDefault();

        const [index, id] = pair(option.dataset.switchAddFund);
        const item = report.switches[index];

        if (!item || item.selected.some(target => target.id === id) || item.selected.length >= MAX_FUNDS) return;

        item.selected.push({ id, weight: 0 });
        splitSwitch(item);
        renderSwitches();
    });

    list.addEventListener("click", event => {
        const remove = event.target.closest("[data-switch-remove]");

        if (remove) {
            report.switches.splice(Number(remove.dataset.switchRemove), 1);
            renderSwitches();
            return;
        }

        const removeFund = event.target.closest("[data-switch-fund-remove]");

        if (removeFund) {
            const [index, slot] = pair(removeFund.dataset.switchFundRemove);

            report.switches[index]?.selected.splice(Number(slot), 1);
            renderSwitches();
            return;
        }

        const split = event.target.closest("[data-switch-split]");

        if (split) {
            const item = report.switches[Number(split.dataset.switchSplit)];

            if (item) splitSwitch(item);

            renderSwitches();
        }
    });
}

function readInput() {
    const number = selector => {
        const value = Number(String(qs(selector)?.value ?? "").replace(/[^0-9.]/g, ""));

        return Number.isFinite(value) ? value : 0;
    };

    return {
        clientName: qs("#report-client")?.value.trim() ?? "",
        adviserName: qs("#report-adviser")?.value.trim() ?? "",
        adviserContact: qs("#report-contact")?.value.trim() ?? "",
        paymentMode: report.paymentMode,
        lumpSum: number("#report-lump"),
        topUp: number("#report-topup"),
        frequency: qs("#report-frequency")?.value ?? "monthly",
        term: number("#report-term"),
        termText: qs("#report-term")?.value.trim() ?? "",
        start: qs("#report-start")?.value ?? "",
        end: qs("#report-end")?.value ?? "",
        boosterChoice: report.booster,
        dividendMode: report.dividendMode,
        boosters: report.booster === "yes"
            ? report.boosters.map(booster => ({
                date: booster.date,
                amount: Number(booster.amount) || 0,
                selected: booster.selected.map(item => ({ id: item.id, weight: Number(item.weight) || 0 }))
            }))
            : [],
        switchingChoice: report.switching,
        switches: report.switching === "yes"
            ? report.switches.map(item => ({
                date: item.date,
                fromId: item.fromId,
                portion: Number(item.portion) || 0,
                sellBid: Number(item.sellBid) > 0 ? Number(item.sellBid) : null,
                selected: item.selected.map(target => ({
                    id: target.id,
                    weight: Number(target.weight) || 0,
                    buyBid: Number(target.buyBid) > 0 ? Number(target.buyBid) : null
                }))
            }))
            : []
    };
}

function validate(input) {
    if (!input.clientName) return "Enter the client name.";

    if (!input.adviserName) return "Enter your name (Prepared by).";

    if (!input.paymentMode) return "Choose a payment mode.";

    if (!report.selected.length) return "Add at least one fund.";

    if (report.selected.some(item => !acceptsPayment(item.id, input.paymentMode))) {
        return `Some chosen funds don't accept ${input.paymentMode}. Remove them first.`;
    }

    if (report.selected.some(item => Number(item.weight) % ALLOCATION_STEP !== 0)) {
        return `Allocations must be in steps of ${ALLOCATION_STEP}% (5%, 10%, 15% …).`;
    }

    const sum = report.selected.reduce((acc, item) => acc + (Number(item.weight) || 0), 0);

    if (Math.abs(sum - 100) >= 0.01) return `The allocation adds up to ${Math.round(sum * 100) / 100}%. It needs to total 100%.`;

    if (report.selected.some(item => !(Number(item.weight) > 0))) return "Every fund needs an allocation above 0%. Remove funds you don't want.";

    for (const item of report.selected) {
        for (const [key, label] of [["purchaseBid", "purchase BID"], ["endBid", "end-date BID"]]) {
            const text = String(item[key] ?? "").trim();
            if (text && !(Number(text) > 0)) {
                const name = report.fundById.get(item.id)?.fundName ?? item.id;
                return `The ${label} for ${name} must be a price above 0, or left empty to use the published price.`;
            }
        }
    }

    const currencies = new Set([
        ...report.selected.map(item => currencyOf(item.id)),
        ...input.boosters.flatMap(booster => booster.selected.map(item => currencyOf(item.id))),
        ...input.switches.flatMap(item => item.selected.map(target => currencyOf(target.id)))
    ]);

    if (currencies.size > 1) return `The chosen funds are in different currencies (${[...currencies].join(" and ")}). Pick funds in one currency for a report.`;

    if (input.lumpSum <= 0 && input.topUp <= 0) return "Enter an initial investment, a regular top-up, or both.";

    if (input.topUp > 0 && input.frequency === "none") return "Choose how often the regular top-up is made.";

    if (!termValid(input.termText)) return "The payment term must be a whole number of years (1 to 99), or left empty.";

    const limits = dateLimits();

    if (!limits) return "No overlapping price history for these funds.";

    if (!input.start || !input.end) return "Choose a start and end date.";

    if (input.start >= input.end) return "The start date must be before the end date.";

    const today = new Date().toISOString().slice(0, 10);

    if (input.end > today) return `The end date can't be in the future. Choose ${formatDate(today)} or earlier.`;

    if (input.start < limits.earliest || input.start > limits.latest) {
        return `Choose a start date between ${formatDate(limits.earliest)} and ${formatDate(limits.latest)}.`;
    }

    if (input.boosterChoice !== "yes" && input.boosterChoice !== "no") return "Choose whether to add an investment booster (step 5).";

    if (input.boosterChoice === "yes") {
        if (!report.boosters.length) return "Add a booster, or choose No in step 5.";

        for (const [index, booster] of report.boosters.entries()) {
            const problem = boosterProblem(booster, index, input);

            if (problem) return problem;
        }
    }

    if (input.switchingChoice !== "yes" && input.switchingChoice !== "no") return "Choose whether to add a fund switch (step 6).";

    if (input.switchingChoice === "yes") {
        if (!report.switches.length) return "Add a fund switch, or choose No in step 6.";

        for (const [index, item] of report.switches.entries()) {
            const problem = switchProblem(item, index, input);

            if (problem) return problem;
        }
    }

    return null;
}


/* ============================================================
   REPORT OUTPUT
   ============================================================ */

function renderReport(result) {
    const sheet = qs("#report-sheet");
    const wrap = qs("#report-output");

    if (!sheet || !wrap) return;

    const { input, perFund } = result;
    const currency = currencyOf(perFund[0].id);
    const m = value => money(value, currency);
    const tone = value => (value > 0 ? "is-up" : value < 0 ? "is-down" : "");
    const frequency = FREQUENCIES[input.topUp > 0 ? input.frequency : "none"];
    const today = formatDate(new Date().toISOString().slice(0, 10));

    const mainFunds = perFund.filter(fund => !fund.boosterOnly);
    const boosterCount = result.boosters.length;
    const switchesDone = (result.switches ?? []).filter(item => item.executed);
    const switchesSkipped = (result.switches ?? []).filter(item => !item.executed);

    // Allocation column: main funds show their %, others how they were bought
    const allocationText = fund => {
        const out = fund.fullySwitchedOut ? `<div class="rpt-muted">switched out</div>` : "";
        if (!fund.boosterOnly) return `${fund.weight}%${out}`;
        if (fund.switchedIn && fund.boosterInvested > 0) return `Switch &amp; booster${out}`;
        if (fund.switchedIn) return `Switched in${out}`;
        return `Booster only${out}`;
    };

    const planText = [
        input.lumpSum > 0 ? `${m(input.lumpSum)} invested on ${formatDate(result.firstDate)}` : "",
        input.topUp > 0
            ? `${m(input.topUp)} ${frequency.label.toLowerCase()} top-ups${input.term > 0 ? ` for ${input.term} year${input.term === 1 ? "" : "s"}` : ""}`
            : ""
    ].filter(Boolean).join(" plus ");

    const code = id => report.fundById.get(id)?.fundCode ?? id;

    const divCash = result.dividendMode === "cash";
    const showDiv = result.hasDividends;

    const dividendTile = (cash, total, payouts) => showDiv && payouts ? `
        <div class="rpt-tile">
            <span>${divCash ? "Dividends received" : "Dividends reinvested"}</span>
            <strong>${m(divCash ? cash : total)}</strong>
            <em>${divCash ? "paid out as cash, included in gain / loss" : "used to buy more units"}</em>
        </div>
    ` : "";

    // Dividends grouped by calendar year (fund pages)
    const dividendsByYear = payouts => {
        const years = new Map();

        for (const payout of payouts) {
            const year = payout.exDate.slice(0, 4);
            const row = years.get(year) ?? { year, count: 0, cash: 0, units: 0 };

            row.count += 1;
            row.cash += payout.cash;
            row.units += payout.reinvestUnits ?? 0;
            years.set(year, row);
        }

        return [...years.values()].sort((a, b) => a.year.localeCompare(b.year));
    };

    const pageHead = title => `
        <div class="rpt-running-head">
            <span>Investment Growth Report${input.clientName ? ` · ${escapeHtml(input.clientName)}` : ""}</span>
            <span>${escapeHtml(title)}</span>
        </div>
    `;

    const published = value => {
        const text = String(value ?? "").trim();

        if (!text || text === "-" || text === "None") return `<td>—</td>`;

        return `<td class="${tone(parseFloat(text))}">${escapeHtml(text)}</td>`;
    };

    const CUMULATIVE = [["YTD", "cumulativeYtd"], ["1 month", "cumulative1m"], ["3 months", "cumulative3m"], ["6 months", "cumulative6m"], ["1 year", "cumulative1y"], ["3 years", "cumulative3y"], ["5 years", "cumulative5y"]];
    const ANNUALISED = [["3 years", "annualised3y"], ["5 years", "annualised5y"], ["10 years", "annualised10y"], ["Since launch", "annualisedSinceLaunch"]];

    const fundPage = (fund, index) => {
        const details = fund.fund?.fund ?? {};
        const name = escapeHtml(fund.fund?.fundName ?? fund.id);
        const color = PRINT_COLORS[fund.slot % PRINT_COLORS.length];
        const purchases = fund.buys;
        const boosterBuys = fund.purchases.filter(p => p.booster).length;
        const pays = fund.dividendPayouts.length > 0;
        const fundDivCash = pays && divCash;

        return `
            <section class="rpt-page rpt-fund-page">
                ${pageHead(`Fund ${index + 1} of ${perFund.length}`)}

                <div class="rpt-fund-title">
                    <i class="rpt-swatch rpt-swatch-lg" style="background:${color}"></i>
                    <div>
                        <h2>${name}</h2>
                        <div class="rpt-muted">
                            ${escapeHtml(fund.fund?.fundCode ?? "")} · ${escapeHtml(details.assetClass ?? "—")}${details.assetSubClass ? ` (${escapeHtml(details.assetSubClass)})` : ""}
                            · ${escapeHtml(details.riskClassification ?? "—")} · ${escapeHtml(currencyOf(fund.id))}
                        </div>
                    </div>
                </div>

                <section class="rpt-tiles${pays ? " rpt-tiles-5" : ""}">
                    <div class="rpt-tile">
                        <span>Invested</span>
                        <strong>${m(fund.invested)}</strong>
                        <em>${fund.boosterInvested > 0 ? `incl. ${m(fund.boosterInvested)} booster` : `${purchases} investment${purchases === 1 ? "" : "s"}`}</em>
                    </div>
                    <div class="rpt-tile">
                        <span>Value on ${escapeHtml(formatDate(fund.endDate ?? result.endDate))}</span>
                        <strong>${m(fund.value)}</strong>
                        <em>${fund.units.toLocaleString("en-SG", { minimumFractionDigits: 4, maximumFractionDigits: 4 })} units</em>
                    </div>
                    ${dividendTile(fund.dividendCash, fund.dividendTotal, pays)}
                    <div class="rpt-tile ${tone(fund.gain)}">
                        <span>Gain / loss</span>
                        <strong>${m(fund.gain)}</strong>
                        <em>${percent(fund.gainPct)} on amount invested</em>
                    </div>
                    <div class="rpt-tile ${tone(fund.annualised ?? 0)}">
                        <span>Annualised return</span>
                        <strong>${fund.annualised === null ? "—" : percent(fund.annualised)}</strong>
                        <em>${fund.annualised === null ? "shown for periods of 1 year or more" : "per year, money-weighted"}</em>
                    </div>
                </section>

                <section class="rpt-section">
                    <h3>Value of this holding</h3>
                    <div class="rpt-chart-wrap rpt-chart-wrap-fund">
                        <canvas data-fund-chart="${index}" aria-label="Value of ${name} compared with the amount invested"></canvas>
                    </div>
                    <div class="rpt-legend">
                        <span><i style="background:${color}"></i>Holding value</span>
                        <span><i class="rpt-legend-dash"></i>Amount invested</span>
                    </div>
                </section>

                <section class="rpt-section">
                    <h3>This holding</h3>
                    <div class="rpt-facts-grid">
                        <div><span>Allocation</span><strong>${allocationText(fund)}</strong></div>
                        <div><span>First purchase</span><strong>${escapeHtml(formatDate(fund.startDate))}</strong><em>at BID ${fund.startBid === null ? "—" : fund.startBid.toFixed(5)}${fund.startBidManual ? " (entered)" : ""}</em></div>
                        <div><span>Purchases</span><strong>${purchases}</strong>${boosterBuys ? `<em>${boosterBuys} from boosters</em>` : ""}</div>
                        <div><span>Average cost</span><strong>${fund.averageCost === null ? "—" : fund.averageCost.toFixed(5)}</strong></div>
                        <div><span>BID on ${escapeHtml(formatDate(fund.endDate ?? result.endDate))}</span><strong>${fund.endBid === null ? "—" : fund.endBid.toFixed(5)}</strong>${fund.endBidManual ? "<em>entered</em>" : ""}</div>
                        <div><span>Payment modes</span><strong>${escapeHtml((Array.isArray(details.paymentModes) ? details.paymentModes : []).join(", ") || "—")}</strong></div>
                        ${switchesDone.filter(item => item.fromId === fund.id).map(item => `
                            <div><span>Switched out ${escapeHtml(formatDate(item.sellDate))}</span><strong>${m(item.value)}</strong><em>${Number(item.portion) >= 100 ? "all units" : `${Number(item.portion)}% of units`} into ${item.into.map(into => escapeHtml(code(into.id))).join(" + ")}</em></div>
                        `).join("")}
                        ${switchesDone.flatMap(item => item.into.filter(into => into.id === fund.id).map(into => `
                            <div><span>Switched in ${escapeHtml(formatDate(into.date))}</span><strong>${m(into.value)}</strong><em>from ${escapeHtml(code(item.fromId))} at BID ${into.bid.toFixed(5)}${into.manual ? " (entered)" : ""}</em></div>
                        `)).join("")}
                    </div>
                </section>

                <section class="rpt-section">
                    <h3>Year by year</h3>
                    <table class="rpt-table rpt-table-years">
                        <thead>
                            <tr>
                                <th>As at</th>
                                <th>Amount invested</th>
                                <th>Holding value</th>
                                ${fundDivCash ? `<th>Dividends received</th>` : ""}
                                <th>Gain / loss</th>
                                <th>Return on invested</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${fund.yearRows.map(row => `
                                <tr>
                                    <td>${escapeHtml(row.label)}</td>
                                    <td>${m(row.invested)}</td>
                                    <td>${m(row.value)}</td>
                                    ${fundDivCash ? `<td>${m(row.dividends)}</td>` : ""}
                                    <td class="${tone(row.gain)}">${m(row.gain)}</td>
                                    <td class="${tone(row.gain)}">${percent(row.gainPct)}</td>
                                </tr>
                            `).join("")}
                        </tbody>
                    </table>
                </section>

                ${pays ? `
                    <section class="rpt-section">
                        <h3>Dividends by year</h3>
                        <table class="rpt-table rpt-table-years">
                            <thead>
                                <tr>
                                    <th>Year</th>
                                    <th>Payouts</th>
                                    <th>${divCash ? "Paid out as cash" : "Dividends reinvested"}</th>
                                    ${divCash ? "" : "<th>Units bought</th>"}
                                </tr>
                            </thead>
                            <tbody>
                                ${dividendsByYear(fund.dividendPayouts).map(row => `
                                    <tr>
                                        <td>${row.year}</td>
                                        <td>${row.count}</td>
                                        <td>${m(row.cash)}</td>
                                        ${divCash ? "" : `<td>${row.units.toLocaleString("en-SG", { minimumFractionDigits: 4, maximumFractionDigits: 4 })}</td>`}
                                    </tr>
                                `).join("")}
                            </tbody>
                        </table>
                    </section>
                ` : ""}

                <section class="rpt-section">
                    <h3>Published fund performance</h3>
                    <table class="rpt-table rpt-table-perf">
                        <thead>
                            <tr><th>Cumulative</th>${CUMULATIVE.map(([label]) => `<th>${label}</th>`).join("")}</tr>
                        </thead>
                        <tbody>
                            <tr><td>Fund</td>${CUMULATIVE.map(([, key]) => published(details[key])).join("")}</tr>
                        </tbody>
                    </table>
                    <table class="rpt-table rpt-table-perf">
                        <thead>
                            <tr><th>Annualised</th>${ANNUALISED.map(([label]) => `<th>${label}</th>`).join("")}</tr>
                        </thead>
                        <tbody>
                            <tr><td>Fund</td>${ANNUALISED.map(([, key]) => published(details[key])).join("")}</tr>
                        </tbody>
                    </table>
                    <div class="rpt-muted rpt-perf-note">
                        Prudential's published figures${details.valuationDate ? ` as at ${escapeHtml(details.valuationDate)}` : ""}${details.inceptionDate ? ` · fund launched ${escapeHtml(details.inceptionDate)}` : ""}.
                        These are the fund's own returns, not this client's.
                    </div>
                </section>
            </section>
        `;
    };

    sheet.innerHTML = `
        <section class="rpt-page rpt-page-summary">
        <header class="rpt-header">
            <h2 class="rpt-title">Investment Growth Report</h2>
            <div class="rpt-subtitle">
                ${escapeHtml(formatDate(result.firstDate))} to ${escapeHtml(formatDate(result.requestedEnd))}
                <span class="rpt-subtitle-sep">·</span> Report date ${escapeHtml(today)}
            </div>

            <div class="rpt-meta">
                <div><span>Prepared for</span><strong>${escapeHtml(input.clientName || "—")}</strong></div>
                <div><span>Prepared by</span><strong>${escapeHtml(input.adviserName || "—")}</strong></div>
                ${input.adviserContact ? `<div><span>Contact</span><strong>${escapeHtml(input.adviserContact)}</strong></div>` : ""}
            </div>
        </header>

        ${result.priceDateBeforeEnd ? `
            <section class="rpt-note">
                <strong>Price date:</strong> the latest BID price available is for
                ${escapeHtml(formatDate(result.endDate))}, so the portfolio is valued at that date
                (end date requested: ${escapeHtml(formatDate(result.requestedEnd))}).
                ${result.skippedCount ? `${result.skippedCount} investment${result.skippedCount === 1 ? "" : "s"} totalling ${m(result.skippedAmount)} scheduled after ${escapeHtml(formatDate(result.endDate))} ${result.skippedCount === 1 ? "is" : "are"} not included, as no price is available yet.` : ""}
            </section>
        ` : ""}

        ${result.manualBids ? `
            <section class="rpt-note">
                <strong>BID prices entered:</strong>
                ${[
                    ...result.perFund.filter(fund => fund.startBidManual || fund.endBidManual).map(fund => {
                        const parts = [];
                        if (fund.startBidManual) parts.push(`initial purchase at ${fund.startBid.toFixed(5)}`);
                        if (fund.endBidManual) parts.push(`valued at ${fund.endBid.toFixed(5)} on ${escapeHtml(formatDate(fund.endDate))}`);
                        return `${escapeHtml(fund.fund?.fundCode || fund.fund?.fundName || fund.id)} (${parts.join("; ")})`;
                    }),
                    ...switchesDone.filter(item => item.sellManual || item.into.some(into => into.manual)).map(item => {
                        const parts = [];
                        if (item.sellManual) parts.push(`${escapeHtml(code(item.fromId))} out at ${item.sellBid.toFixed(5)}`);
                        item.into.filter(into => into.manual).forEach(into => parts.push(`${escapeHtml(code(into.id))} in at ${into.bid.toFixed(5)}`));
                        return `switch on ${escapeHtml(formatDate(item.sellDate))} (${parts.join("; ")})`;
                    })
                ].join(", ")}.
                These were entered by the adviser instead of the published BID price; all other prices are as published.
            </section>
        ` : ""}

        <section class="rpt-plan">
            <strong>Investment plan:</strong> ${escapeHtml(planText)}, paid by <strong>${escapeHtml(PAYMENT_LABELS[input.paymentMode] ?? input.paymentMode ?? "—")}</strong>, across ${mainFunds.length} fund${mainFunds.length === 1 ? "" : "s"}
            (${mainFunds.map(fund => `${escapeHtml(fund.fund?.fundCode ?? "")} ${fund.weight}%`).join(", ")})${boosterCount ? `,
            plus ${boosterCount} investment booster${boosterCount === 1 ? "" : "s"} totalling ${m(result.boosterTotal)}` : ""}${switchesDone.length ? `,
            with ${switchesDone.length} fund switch${switchesDone.length === 1 ? "" : "es"}` : ""}.
            ${switchesDone.length ? `<span class="rpt-plan-switches"><strong>Switches carried out:</strong> ${switchesDone.map(item =>
                `${escapeHtml(formatDate(item.sellDate))}: ${Number(item.portion) >= 100 ? "all" : `${Number(item.portion)}%`} of ${escapeHtml(code(item.fromId))} (${m(item.value)}) into ${item.into.map(into => escapeHtml(code(into.id))).join(" + ")}`
            ).join("; ")}.</span>` : ""}
            ${showDiv ? `Dividends are <strong>${divCash ? "paid out as cash" : "reinvested"}</strong>.` : ""}
        </section>


        <section class="rpt-tiles${showDiv ? " rpt-tiles-5" : ""}">
            <div class="rpt-tile">
                <span>Total invested</span>
                <strong>${m(result.totalInvested)}</strong>
                <em>${result.contributions} investment${result.contributions === 1 ? "" : "s"}</em>
            </div>
            <div class="rpt-tile">
                <span>Value on ${escapeHtml(formatDate(result.endDate))}</span>
                <strong>${m(result.totalValue)}</strong>
                <em>${result.priceDateBeforeEnd ? "latest available BID price" : "at BID price"}</em>
            </div>
            ${dividendTile(result.totalDividendCash, result.totalDividends, true)}
            <div class="rpt-tile ${tone(result.gain)}">
                <span>Gain / loss</span>
                <strong>${m(result.gain)}</strong>
                <em>${percent(result.gainPct)} on amount invested</em>
            </div>
            <div class="rpt-tile ${tone(result.annualised ?? 0)}">
                <span>Annualised return</span>
                <strong>${result.annualised === null ? "—" : percent(result.annualised)}</strong>
                <em>${result.annualised === null ? "shown for periods of 1 year or more" : "per year, money-weighted"}</em>
            </div>
        </section>

        ${boosterCount ? `
            <section class="rpt-section">
                <h3>Investment boosters</h3>
                <table class="rpt-table rpt-table-boosters">
                    <thead>
                        <tr>
                            <th>Booster</th>
                            <th>Date</th>
                            <th>Amount</th>
                            <th>Fund allocation</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${result.boosters.map((booster, index) => `
                            <tr>
                                <td>Booster ${index + 1}</td>
                                <td>${escapeHtml(formatDate(booster.date))}</td>
                                <td>${m(booster.amount)}</td>
                                <td>${booster.selected.map(item => `${escapeHtml(code(item.id))} ${item.weight}%`).join(", ")}</td>
                            </tr>
                        `).join("")}
                    </tbody>
                </table>
            </section>
        ` : ""}

        <section class="rpt-section">
            <h3>Growth of the investment</h3>
            <div class="rpt-chart-wrap">
                <canvas id="report-chart" aria-label="Portfolio value compared with the amount invested"></canvas>
            </div>
            <div class="rpt-legend">
                <span><i style="background:#1f5f99"></i>Portfolio value</span>
                <span><i class="rpt-legend-dash"></i>Total invested</span>
            </div>
        </section>

        ${switchesDone.length || switchesSkipped.length ? `
            <section class="rpt-section">
                <h3>Fund switches</h3>
                <table class="rpt-table rpt-table-switches">
                    <thead>
                        <tr>
                            <th>Date</th>
                            <th>Switched out of</th>
                            <th>Units switched</th>
                            <th>Value</th>
                            <th>Switched into</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${switchesDone.map(item => `
                            <tr>
                                <td>${escapeHtml(formatDate(item.sellDate))}</td>
                                <td><strong>${escapeHtml(code(item.fromId))}</strong><div class="rpt-muted">${Number(item.portion) >= 100 ? "all units" : `${Number(item.portion)}% of units`} at BID ${item.sellBid.toFixed(5)}${item.sellManual ? " (entered)" : ""}</div></td>
                                <td>${item.units.toLocaleString("en-SG", { minimumFractionDigits: 4, maximumFractionDigits: 4 })}</td>
                                <td>${m(item.value)}</td>
                                <td>${item.into.map(into => `<div><strong>${escapeHtml(code(into.id))}</strong> ${m(into.value)}<div class="rpt-muted">${into.units.toLocaleString("en-SG", { minimumFractionDigits: 4, maximumFractionDigits: 4 })} units at BID ${into.bid.toFixed(5)}${into.manual ? " (entered)" : ""}</div></div>`).join("")}</td>
                            </tr>
                        `).join("")}
                        ${switchesSkipped.map(item => `
                            <tr>
                                <td>${escapeHtml(formatDate(item.date))}</td>
                                <td><strong>${escapeHtml(code(item.fromId))}</strong></td>
                                <td colspan="3" class="rpt-muted">Not made: ${escapeHtml(item.reason === "no units held" ? "no units of this fund were held on that date" : item.reason === "no price yet" ? "no BID price is available yet for that date" : "no BID price for the new fund on that date")}.</td>
                            </tr>
                        `).join("")}
                    </tbody>
                </table>
                ${switchesDone.some(item => Number(item.portion) >= 100) ? `<p class="rpt-muted rpt-switch-note">After a switch of all units, that fund's share of later top-ups goes to the fund(s) switched into.</p>` : ""}
            </section>
        ` : ""}

        <section class="rpt-section">
            <h3>Portfolio breakdown</h3>
            <table class="rpt-table${showDiv ? " rpt-table-wide" : ""}">
                <thead>
                    <tr>
                        <th>Fund</th>
                        <th>Allocation</th>
                        <th>Invested</th>
                        <th>Units held</th>
                        <th>Average cost</th>
                        <th>BID on ${escapeHtml(formatDate(result.endDate))}</th>
                        <th>Value</th>
                        ${showDiv ? `<th>Dividends</th>` : ""}
                        <th>Gain / loss</th>
                    </tr>
                </thead>
                <tbody>
                    ${perFund.map(fund => `
                        <tr>
                            <td>
                                <i class="rpt-swatch" style="background:${PRINT_COLORS[fund.slot % PRINT_COLORS.length]}"></i>
                                <strong>${escapeHtml(fund.fund?.fundName ?? fund.id)}</strong>
                                <div class="rpt-muted">${escapeHtml(fund.fund?.fundCode ?? "")}</div>
                            </td>
                            <td>${allocationText(fund)}</td>
                            <td>${m(fund.invested)}${fund.boosterInvested > 0 ? `<div class="rpt-muted">incl. ${m(fund.boosterInvested)} booster</div>` : ""}</td>
                            <td>${fund.units.toLocaleString("en-SG", { minimumFractionDigits: 4, maximumFractionDigits: 4 })}</td>
                            <td>${fund.averageCost === null ? "—" : fund.averageCost.toFixed(5)}</td>
                            <td>${fund.endBid === null ? "—" : fund.endBid.toFixed(5)}${fund.endBidManual ? `<div class="rpt-muted">entered</div>` : ""}</td>
                            <td>${m(fund.value)}</td>
                            ${showDiv ? `<td>${fund.dividendPayouts.length ? `${m(divCash ? fund.dividendCash : fund.dividendTotal)}<div class="rpt-muted">${divCash ? "cash" : "reinvested"}</div>` : "—"}</td>` : ""}
                            <td class="${tone(fund.gain)}">${m(fund.gain)}<div class="rpt-muted">${percent(fund.gainPct)}</div></td>
                        </tr>
                    `).join("")}
                </tbody>
                <tfoot>
                    <tr>
                        <td>Total</td>
                        <td>100%</td>
                        <td>${m(result.totalInvested)}</td>
                        <td></td>
                        <td></td>
                        <td></td>
                        <td>${m(result.totalValue)}</td>
                        ${showDiv ? `<td>${m(divCash ? result.totalDividendCash : result.totalDividends)}</td>` : ""}
                        <td class="${tone(result.gain)}">${m(result.gain)}<div class="rpt-muted">${percent(result.gainPct)}</div></td>
                    </tr>
                </tfoot>
            </table>
        </section>

        </section>

        <section class="rpt-page">
            ${pageHead("Year by year · About the funds")}

        <section class="rpt-section">
            <h3>Year by year</h3>
            <table class="rpt-table rpt-table-years">
                <thead>
                    <tr>
                        <th>As at</th>
                        <th>Total invested</th>
                        <th>Portfolio value</th>
                        ${showDiv && divCash ? `<th>Dividends received</th>` : ""}
                        <th>Gain / loss</th>
                        <th>Return on invested</th>
                    </tr>
                </thead>
                <tbody>
                    ${result.yearRows.map(row => `
                        <tr>
                            <td>${escapeHtml(row.label)}</td>
                            <td>${m(row.invested)}</td>
                            <td>${m(row.value)}</td>
                            ${showDiv && divCash ? `<td>${m(row.dividends)}</td>` : ""}
                            <td class="${tone(row.gain)}">${m(row.gain)}</td>
                            <td class="${tone(row.gain)}">${percent(row.gainPct)}</td>
                        </tr>
                    `).join("")}
                </tbody>
            </table>
        </section>

        <section class="rpt-section rpt-funds">
            <h3>About the funds</h3>
            ${perFund.map(fund => {
                const details = fund.fund?.fund ?? {};

                return `
                    <div class="rpt-fund">
                        <div class="rpt-fund-head">
                            <i class="rpt-swatch" style="background:${PRINT_COLORS[fund.slot % PRINT_COLORS.length]}"></i>
                            <strong>${escapeHtml(fund.fund?.fundName ?? fund.id)}</strong>
                            <span class="rpt-muted">${escapeHtml(fund.fund?.fundCode ?? "")}</span>
                        </div>
                        <div class="rpt-fund-facts">
                            <span><b>Asset class:</b> ${escapeHtml(details.assetClass ?? "—")}${details.assetSubClass ? ` (${escapeHtml(details.assetSubClass)})` : ""}</span>
                            <span><b>Risk:</b> ${escapeHtml(details.riskClassification ?? "—")}</span>
                            <span><b>Currency:</b> ${escapeHtml(currencyOf(fund.id))}</span>
                            <span><b>First purchase:</b> ${escapeHtml(formatDate(fund.startDate))} at BID ${fund.startBid === null ? "—" : fund.startBid.toFixed(5)}${fund.startBidManual ? " (entered)" : ""}</span>
                        </div>
                        ${details.fundObjective ? `<p>${escapeHtml(String(details.fundObjective).replace(/\s+/g, " ").trim())}</p>` : ""}
                    </div>
                `;
            }).join("")}
        </section>

        <footer class="rpt-disclaimer">
            <strong>Important notes.</strong>
            This is a historical illustration based on actual published BID prices of the funds between the dates shown${result.manualBids ? ", except the BID prices marked as entered, which were provided by the adviser" : ""}.
            Units are assumed to be bought at the BID price on the first pricing day on or after each investment date, with no
            sales charge, fees or taxes deducted.${switchesDone.length ? " Fund switches are made at the BID prices on the first pricing day on or after the switch date, with no switching charge; the amount invested moves with the units switched." : ""} ${showDiv
                ? (divCash
                    ? "Dividends are worked out from each fund's published dividend history (units held before the ex-dividend date x the declared rate) and treated as paid out in cash on the ex-dividend date; they are added to the gain / loss."
                    : "Dividends are worked out from each fund's published dividend history (units held before the ex-dividend date x the declared rate) and reinvested at the BID price on or after the ex-dividend date.")
                : "Dividends paid out by distribution funds are not included, so the figures for those funds may understate their total return."} Past performance is not necessarily indicative of
            future performance. The value of units and the income from them may fall as well as rise. This report is for
            illustration only and does not constitute financial advice or an offer to buy or sell any investment.
            Please refer to the fund's prospectus and product highlights sheet before investing.
            <div class="rpt-source">Source: Prudential Singapore fund prices. Generated ${escapeHtml(today)}.</div>
        </footer>
        </section>

        ${perFund.map(fundPage).join("")}
    `;

    // Show the report in the A4 preview popup (before printing)
    if (!wrap.open) wrap.showModal?.();

    document.body.classList.add("has-news-dialog");

    qs(".report-paper-area", wrap)?.scrollTo(0, 0);

    fitPages(sheet);
    renderChart(result);


}

/* ============================================================
   FIT EACH REPORT PAGE ON ONE A4 SHEET
   Page 1 = summary to portfolio breakdown, page 2 = year by year
   and about the funds, then one page per fund. A page whose content
   is taller than the A4 printable area is scaled down slightly
   (CSS zoom) so it never spills onto an extra sheet.
   ============================================================ */

const MM = 96 / 25.4;
const PRINT_WIDTH_PX = (210 - 2 * 12) * MM;      // @page margin 12mm
const PRINT_HEIGHT_PX = (297 - 2 * 12) * MM - 8; // small safety gap
const MIN_ZOOM = 0.6;

function fitPages(sheet) {
    for (const page of sheet.querySelectorAll(".rpt-page")) {
        let body = page.querySelector(":scope > .rpt-page-body");

        if (!body) {
            body = document.createElement("div");
            body.className = "rpt-page-body";
            body.append(...page.childNodes);
            page.append(body);
        }

        // Measure at the printed width
        body.style.zoom = "";
        body.style.width = `${PRINT_WIDTH_PX}px`;

        const height = body.scrollHeight;

        body.style.width = "";

        if (height > PRINT_HEIGHT_PX) {
            body.style.zoom = String(Math.max(MIN_ZOOM, Math.floor((PRINT_HEIGHT_PX / height) * 1000) / 1000));
        }
    }
}

function buildChart(canvas, series, currency, color, labels) {
    const ChartConstructor = window.Chart;

    if (!canvas || !ChartConstructor) return null;

    const font = Math.round(11 * getFontScale());
    const fill = color.length === 7 ? `${color}1a` : color;

    return new ChartConstructor(canvas, {
        type: "line",
        data: {
            labels: series.map(point => point.date),
            datasets: [
                {
                    label: labels[0],
                    data: series.map(point => point.value),
                    borderColor: color,
                    backgroundColor: fill,
                    fill: true,
                    borderWidth: 2,
                    pointRadius: 0,
                    tension: 0
                },
                {
                    label: labels[1],
                    data: series.map(point => point.invested),
                    borderColor: "#7a8590",
                    borderDash: [5, 4],
                    borderWidth: 1.5,
                    pointRadius: 0,
                    stepped: true,
                    fill: false
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: false,
            interaction: { mode: "index", intersect: false },
            plugins: {
                legend: { display: false },
                tooltip: {
                    backgroundColor: "#ffffff",
                    titleColor: "#1b2530",
                    bodyColor: "#1b2530",
                    borderColor: "#cfd6dd",
                    borderWidth: 1,
                    callbacks: {
                        title: items => formatDate(items[0]?.label),
                        label: item => `${item.dataset.label}: ${money(item.parsed.y, currency)}`
                    }
                }
            },
            scales: {
                x: {
                    type: "category",
                    ticks: {
                        color: "#5b6670",
                        font: { size: font },
                        maxTicksLimit: 8,
                        autoSkip: true,
                        callback(value) {
                            const label = this.getLabelForValue(value);

                            return formatDate(label).slice(3);
                        }
                    },
                    grid: { color: "#eef1f4" }
                },
                y: {
                    ticks: {
                        color: "#5b6670",
                        font: { size: font },
                        callback: value => money(value, currency).replace(/\.00$/, "")
                    },
                    grid: { color: "#eef1f4" }
                }
            }
        }
    });
}

function renderChart(result) {
    for (const chart of report.charts) chart?.destroy?.();

    report.charts = [];

    const currency = currencyOf(result.perFund[0].id);

    report.charts.push(buildChart(qs("#report-chart"), result.series, currency, "#1f5f99", ["Portfolio value", "Total invested"]));

    result.perFund.forEach((fund, index) => {
        report.charts.push(buildChart(
            qs(`[data-fund-chart="${index}"]`),
            fund.series,
            currency,
            PRINT_COLORS[fund.slot % PRINT_COLORS.length],
            ["Holding value", "Amount invested"]
        ));
    });

    report.charts = report.charts.filter(Boolean);
}


/* ============================================================
   EVENTS
   ============================================================ */

function bindEvents() {
    const search = qs("#report-fund-search");
    const list = qs("#report-fund-suggestions");

    search?.addEventListener("focus", renderSuggestions);
    search?.addEventListener("input", renderSuggestions);
    search?.addEventListener("blur", () => setTimeout(closeSuggestions, 150));

    search?.addEventListener("keydown", event => {
        if (event.key === "Enter") {
            event.preventDefault();

            if (!search.value.trim()) return;

            const first = qs("#report-fund-suggestions [data-report-add]");

            if (first) {
                addFund(first.dataset.reportAdd);
                search.value = "";
                renderSuggestions();
            }
        } else if (event.key === "Escape") {
            closeSuggestions();
            search.blur();
        }
    });

    list?.addEventListener("mousedown", event => {
        event.preventDefault();

        const item = event.target.closest("[data-report-add]");

        if (!item) return;

        addFund(item.dataset.reportAdd);
        search.value = "";
        renderSuggestions();
    });

    for (const selector of ["#report-client", "#report-adviser"]) {
        qs(selector)?.addEventListener("input", updateSteps);
    }

    bindBoosterEvents();
    bindSwitchEvents();

    qs("#report-dividend-choice")?.addEventListener("click", event => {
        const option = event.target.closest("[data-report-dividend]");

        if (!option) return;

        report.dividendMode = option.dataset.reportDividend === "reinvest" ? "reinvest" : "cash";
        renderDividendChoice();
    });

    // Premium (step 3)
    qs("#report-start")?.addEventListener("change", event => {
        report.requestedStart = event.target.value || null;
        syncDateLimits();
    });

    // Keep the booster date limits in line with the premium dates
    for (const selector of ["#report-start", "#report-end"]) {
        qs(selector)?.addEventListener("change", () => {
            if (report.booster === "yes") renderBoosters();
            if (report.switching === "yes") renderSwitches();
        });
    }

    for (const selector of ["#report-lump", "#report-topup", "#report-frequency", "#report-term", "#report-start", "#report-end"]) {
        qs(selector)?.addEventListener("input", updateSteps);
        qs(selector)?.addEventListener("change", updateSteps);
    }

    qs("#report-payment-options")?.addEventListener("click", event => {
        const option = event.target.closest("[data-report-payment]");

        if (option) setPaymentMode(option.dataset.reportPayment);
    });

    const body = qs("#report-funds-body");

    // Snap allocations to 5% steps when the box is left / Enter pressed
    body?.addEventListener("change", event => {
        const field = event.target.closest("[data-report-weight]");

        if (!field) return;

        report.selected[Number(field.dataset.reportWeight)].weight = roundToStep(field.value);
        renderSelected();
    });

    // Typing a BID price: keep the value (no re-render, so the box keeps focus)
    body?.addEventListener("input", event => {
        const field = event.target.closest("[data-report-bid]");

        if (!field) return;

        const item = report.selected[Number(field.dataset.reportBid)];
        item[field.dataset.bidKind] = field.value.trim();

        const row = field.closest("tr")?.previousElementSibling;
        const toggle = row?.querySelector("[data-report-bid-toggle]");
        if (toggle) {
            const edited = Number(item.purchaseBid) > 0 || Number(item.endBid) > 0;
            toggle.classList.toggle("is-edited", edited);
            toggle.firstChild.textContent = `${edited ? "BID price changed" : "Change BID price"} `;
        }
    });

    body?.addEventListener("input", event => {
        const field = event.target.closest("[data-report-weight]");

        if (!field) return;

        report.selected[Number(field.dataset.reportWeight)].weight = Math.max(0, Number(field.value) || 0);

        const sum = report.selected.reduce((acc, item) => acc + (Number(item.weight) || 0), 0);
        const total = qs("#report-allocation-total");

        if (total) {
            total.textContent = `Total ${Math.round(sum * 100) / 100}%`;
            total.classList.toggle("is-ok", Math.abs(sum - 100) < 0.01);
            total.classList.toggle("is-off", Math.abs(sum - 100) >= 0.01);
        }

        updateSteps();
    });

    body?.addEventListener("click", event => {
        const toggle = event.target.closest("[data-report-bid-toggle]");

        if (toggle) {
            const item = report.selected[Number(toggle.dataset.reportBidToggle)];
            item.bidOpen = !item.bidOpen;
            renderSelected();
            return;
        }

        const clear = event.target.closest("[data-report-bid-clear]");

        if (clear) {
            const item = report.selected[Number(clear.dataset.reportBidClear)];
            item.purchaseBid = "";
            item.endBid = "";
            renderSelected();
            return;
        }

        const remove = event.target.closest("[data-report-remove]");

        if (!remove) return;

        report.selected.splice(Number(remove.dataset.reportRemove), 1);
        renderSelected();
    });

    qs("#report-split")?.addEventListener("click", splitEqually);

    ["#report-start", "#report-end"].forEach(selector => {
        qs(selector)?.addEventListener("change", updateBidHints);
        qs(selector)?.addEventListener("input", updateBidHints);
    });

    // Top-up frequency follows the regular top-up amount:
    // empty / 0 -> "No top-ups"; an amount -> Monthly (if it was "No top-ups").
    // The initial lump sum is never affected by the frequency.
    qs("#report-topup")?.addEventListener("input", () => {
        syncTopUpFrequency();
        updateSteps();
    });

    qs("#report-topup")?.addEventListener("change", () => {
        syncTopUpFrequency();
        updateSteps();
    });

    // Choosing "No top-ups" clears the top-up amount; choosing a
    // frequency with no amount goes back to "No top-ups".
    qs("#report-frequency")?.addEventListener("change", () => {
        const frequency = qs("#report-frequency");
        const topUpInput = qs("#report-topup");

        if (!frequency || !topUpInput) return;

        if (frequency.value === "none") {
            topUpInput.value = "";
        } else if (!(Number(topUpInput.value) > 0)) {
            setFrequency("none");
        }

        updateSteps();
    });

    syncTopUpFrequency();

    qs("#report-form")?.addEventListener("submit", event => {
        event.preventDefault();

        const error = qs("#report-error");
        const input = readInput();
        const problem = validate(input);

        if (error) {
            error.textContent = problem ?? "";
            error.hidden = !problem;
        }

        if (problem) return;

        const result = calculate(input);

        if (!result.series.length) {
            if (error) {
                error.textContent = "No prices were found in this period for the chosen funds.";
                error.hidden = false;
            }

            return;
        }

        report.lastResult = result;
        renderReport(result);
    });

    const dialog = qs("#report-output");

    dialog?.querySelector("[data-report-close]")?.addEventListener("click", () => dialog.close());

    dialog?.addEventListener("click", event => {
        if (event.target === dialog) dialog.close();
    });

    dialog?.addEventListener("close", () => {
        // Not when it was only re-opened for printing
        if (!dialog.open) document.body.classList.remove("has-news-dialog");
    });

    // A modal popup sits in the browser's "top layer", which Chrome
    // prints at its on-screen size with the dark backdrop around it
    // (black border, right side cut off). For printing, re-open it as
    // a normal in-page popup, then put the modal back afterwards.
    const flattenForPrint = () => {
        if (!dialog?.open || !dialog.matches(":modal")) return;

        report.printFlattened = true;
        dialog.close();
        dialog.show();
    };

    const restoreAfterPrint = () => {
        if (!report.printFlattened || !dialog) return;

        report.printFlattened = false;
        dialog.close();
        dialog.showModal();
        document.body.classList.add("has-news-dialog");
    };

    qs("#report-print")?.addEventListener("click", () => {
        document.body.classList.add("is-printing-report");
        flattenForPrint();

        // Let Chart.js resize for the page before printing
        requestAnimationFrame(() => {
            window.print();
        });
    });

    // Resize the chart to the printed page width (and back afterwards),
    // whether printing starts from the button or Ctrl+P.
    const resizeChart = () => {
        try {
            for (const chart of report.charts) chart?.resize?.();
        } catch {
            // ignore
        }
    };

    window.addEventListener("beforeprint", () => {
        flattenForPrint();
        resizeChart();
    });

    window.matchMedia?.("print").addEventListener?.("change", resizeChart);

    window.addEventListener("afterprint", () => {
        document.body.classList.remove("is-printing-report");
        restoreAfterPrint();
        resizeChart();
    });
}


/* ============================================================
   CLEAR ON LEAVE
   Nothing entered here is saved (no browser storage, nothing sent).
   Leaving the Report Generation page wipes the form, the chosen
   funds, boosters and any generated report.
   ============================================================ */

function resetReport() {
    const dialog = qs("#report-output");

    if (dialog?.open) dialog.close();

    for (const chart of report.charts) chart?.destroy?.();

    report.charts = [];
    report.selected = [];
    report.paymentMode = null;
    report.requestedStart = null;
    report.booster = null;
    report.boosters = [];
    report.switching = null;
    report.switches = [];
    report.dividendMode = "cash";
    report.lastResult = null;

    const sheet = qs("#report-sheet");

    if (sheet) sheet.innerHTML = "";

    qs("#report-form")?.reset();

    for (const selector of ["#report-start", "#report-end"]) {
        const field = qs(selector);

        if (field) {
            field.value = "";
            field.removeAttribute("min");
            field.removeAttribute("max");
        }
    }

    const error = qs("#report-error");

    if (error) {
        error.textContent = "";
        error.hidden = true;
    }

    const note = qs("#report-payment-note");

    if (note) note.textContent = "";

    closeSuggestions();

    syncTopUpFrequency();
    qs("#report-frequency")?.dispatchEvent(new Event("vselect:sync"));

    renderPaymentOptions();
    renderBoosters();
    renderSwitches();
    renderSelected();
}

function watchLeavingPage() {
    const view = qs("#reports-view");

    if (!view) return;

    let wasVisible = !view.hidden;

    new MutationObserver(() => {
        const visible = !view.hidden;

        if (wasVisible && !visible) resetReport();

        wasVisible = visible;
    }).observe(view, { attributes: true, attributeFilter: ["hidden"] });
}


/* ============================================================
   PUBLIC API
   ============================================================ */

function initializeReports({ funds, historyIndex }) {
    report.funds = [...(funds ?? [])].sort((a, b) =>
        String(a.fundName ?? "").localeCompare(String(b.fundName ?? ""))
    );

    report.fundById = new Map(report.funds.map(fund => [fundId(fund), fund]));
    report.index = historyIndex ?? new Map();

    if (!report.initialized) {
        bindEvents();
        watchLeavingPage();
        report.initialized = true;
    }

    const loading = qs("#report-loading");

    if (loading) loading.hidden = true;

    const form = qs("#report-form");

    if (form) form.hidden = false;

    renderPaymentOptions();
    renderSelected();
}


export {
    initializeReports,
    calculate as calculateInvestmentGrowth
};
