/* ============================================================
   ELG FMS — MONITORING
   ============================================================

   1. Watchlist + alerts
        Funds the viewer stars (saved in this browser), with
        1D / 1W / 1M moves, distance from the 52-week high and
        alert badges for the viewer's own limits.

   2. Unusual moves scan (all funds)
        - Unusual daily / weekly moves: bigger than N x the
          fund's usual move over the last 12 months
        - New 52-week highs / lows
        - Furthest below their 52-week high

   Data: data/bid_history.json (actual BID observations only)
         data/funds.json        (names, codes)

   Nothing is estimated: every figure compares actual BID
   observations. "Usual move" = standard deviation of the
   fund's observation-to-observation returns over the past
   12 months (the latest move itself excluded).
   ============================================================ */

import { placeDropdown } from "./dropdown-place.js";
import {
    getWatchlist,
    isWatched,
    addToWatchlist,
    removeFromWatchlist,
    onWatchlistChange
} from "./watchlist.js";


/* Returns over periods longer than 1 year are shown annualised
   (p.a.); 1 year and shorter stay cumulative. Years = calendar
   days / 365.25, with a few days' slack so a 1-year range that
   spans a leap day still counts as 1 year. */
const ANNUALISE_ABOVE_YEARS = 1.02;

function yearsBetweenIso(fromIso, toIso) {
    const from = Date.parse(`${fromIso}T00:00:00Z`);
    const to = Date.parse(`${toIso}T00:00:00Z`);

    return Number.isFinite(from) && Number.isFinite(to) ? (to - from) / (365.25 * 86400000) : 0;
}

function periodReturn(fromValue, toValue, fromIso, toIso) {
    if (!(fromValue > 0) || !Number.isFinite(toValue)) return { value: null, annualised: false };

    const years = yearsBetweenIso(fromIso, toIso);

    if (years > ANNUALISE_ABOVE_YEARS) {
        return { value: (Math.pow(toValue / fromValue, 1 / years) - 1) * 100, annualised: true };
    }

    return { value: (toValue / fromValue - 1) * 100, annualised: false };
}


/* ============================================================
   One monitor per data set (Prudential funds, indices).
   createMonitor(cfg) builds an independent Watchlist & alerts
   + Unusual moves pair inside cfg.root(), with element ids
   prefixed by cfg.prefix. Alert rules are shared.
   ============================================================ */

function createMonitor(cfg) {

    const STORAGE_KEYS = {
        rules: "vgrat-fms-alert-rules",                       // shared by funds and indices
        sensitivity: `vgrat-fms-${cfg.storage}unusual-sensitivity`,
        layout: `vgrat-fms-${cfg.storage}unusual-layout`,
        range: `vgrat-fms-${cfg.storage}watchlist-range`
    };

    /* Watchlist change period: picked by the viewer, remembered in this browser */
    const WATCH_RANGES = {
        "1D": { label: "1 day" },
        "1W": { label: "1 week", days: 7 },
        "1M": { label: "1 month", months: 1 },
        "3M": { label: "3 months", months: 3 },
        "6M": { label: "6 months", months: 6 },
        "1Y": { label: "1 year", months: 12 },
        "3Y": { label: "3 years", months: 36 },
        "5Y": { label: "5 years", months: 60 }
    };

    const WATCH_RANGE_ORDER = Object.keys(WATCH_RANGES);

    const DEFAULT_WATCH_RANGES = ["1M", "3M", "6M"];

    /* The five Unusual moves lists, in their default order. */
    const UNUSUAL_LISTS = [
        { key: "day", title: "Unusual daily moves" },
        { key: "week", title: "Unusual weekly moves" },
        { key: "highs", title: "New 52-week highs" },
        { key: "lows", title: "New 52-week lows" },
        { key: "furthest", title: "Furthest below 52-week high" }
    ];

    const DEFAULT_LAYOUT = {
        order: UNUSUAL_LISTS.map(list => list.key),
        hidden: []
    };

    const DEFAULT_RULES = {
        dayMove: { enabled: true, value: 2, direction: "both" },    // 1D move >= value %
        // direction: "down" (fall), "up" (rise) or "both"
        weekDrop: { enabled: true, value: 3, direction: "down" },   // 1W move >= value %
        monthDrop: { enabled: true, value: 5, direction: "down" },  // 1M move >= value %
        fromHigh: { enabled: true, value: 10, direction: "down" },  // down: below 52W high / up: above 52W low
        newHigh: { enabled: true },
        newLow: { enabled: true }
    };

    const MIN_RETURNS_FOR_USUAL_MOVE = 60;

    const LIST_LIMIT = 10;


    const monitor = {
        initialized: false,
        funds: [],
        fundById: new Map(),
        metrics: new Map(),        // id -> metrics
        asOf: null,
        rules: structuredClone(DEFAULT_RULES),
        sensitivity: 2,
        layout: structuredClone(DEFAULT_LAYOUT),
        history: new Map(),        // id -> BID observations
        ranges: [...DEFAULT_WATCH_RANGES],   // periods shown, in WATCH_RANGE_ORDER
        openProfile: () => {}
    };


    /* ============================================================
       HELPERS
       ============================================================ */

    function qs(selector, parent = cfg.root()) {
        return parent.querySelector(selector);
    }

    function escapeHtml(value) {
        return String(value ?? "")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    }

    function readStorage(key) {
        try {
            return localStorage.getItem(key);
        } catch {
            return null;
        }
    }

    function writeStorage(key, value) {
        try {
            localStorage.setItem(key, value);
        } catch {
            // ignore
        }
    }

    function fundId(fund) {
        return String(fund?.fundIdentifier ?? fund?.fundCode ?? fund?.fundName ?? "");
    }

    function isoMinusDays(iso, days) {
        const date = new Date(`${iso}T00:00:00Z`);

        date.setUTCDate(date.getUTCDate() - days);

        return date.toISOString().slice(0, 10);
    }

    function isoMinusMonths(iso, months) {
        const [year, month, day] = iso.split("-").map(Number);
        const target = new Date(Date.UTC(year, month - 1 - months, 1));
        const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();

        target.setUTCDate(Math.min(day, lastDay));

        return target.toISOString().slice(0, 10);
    }

    /* Index of the latest observation on or before `date`, else -1. */
    function indexOnOrBefore(observations, date) {
        let low = 0;
        let high = observations.length - 1;
        let result = -1;

        while (low <= high) {
            const middle = (low + high) >> 1;

            if (observations[middle].date <= date) {
                result = middle;
                low = middle + 1;
            } else {
                high = middle - 1;
            }
        }

        return result;
    }

    function pct(from, to) {
        return from > 0 ? ((to - from) / from) * 100 : null;
    }

    function formatPercent(value, digits = 2) {
        if (value === null || value === undefined || !Number.isFinite(value)) return "—";

        const sign = value > 0 ? "+" : "";

        return `${sign}${value.toFixed(digits)}%`;
    }

    function returnClass(value) {
        if (value === null || value === undefined || !Number.isFinite(value) || value === 0) return "";

        return value > 0 ? "return-positive" : "return-negative";
    }

    function formatDate(iso) {
        if (!iso) return "—";

        const [year, month, day] = iso.split("-").map(Number);

        return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString("en-SG", {
            timeZone: "UTC",
            day: "2-digit",
            month: "short",
            year: "numeric"
        });
    }

    function pill(value, digits = 2) {
        return `
            <span class="return-cell ${returnClass(value)}">
                <span class="return-pill">${escapeHtml(formatPercent(value, digits))}</span>
            </span>
        `;
    }


    /* ============================================================
       METRICS (per fund, from actual BID observations)
       ============================================================ */

    function computeMetrics(observations) {
        if (!Array.isArray(observations) || observations.length < 2) return null;

        const n = observations.length;
        const latest = observations[n - 1];
        const previous = observations[n - 2];

        const weekIndex = indexOnOrBefore(observations, isoMinusDays(latest.date, 7));
        const monthIndex = indexOnOrBefore(observations, isoMinusMonths(latest.date, 1));

        const d1 = pct(previous.bidPrice, latest.bidPrice);
        const w1 = weekIndex >= 0 && weekIndex < n - 1 ? pct(observations[weekIndex].bidPrice, latest.bidPrice) : null;
        const m1 = monthIndex >= 0 && monthIndex < n - 1 ? pct(observations[monthIndex].bidPrice, latest.bidPrice) : null;

        // 52-week yearObs (by calendar date, latest included)
        const yearStart = isoMinusDays(latest.date, 365);
        const firstInYear = observations.findIndex(item => item.date > yearStart);
        const yearObs = observations.slice(firstInYear < 0 ? n - 1 : firstInYear);

        const hasFullYear = observations[0].date <= yearStart;

        const high52 = Math.max(...yearObs.map(item => item.bidPrice));
        const low52 = Math.min(...yearObs.map(item => item.bidPrice));

        const priorWindow = yearObs.slice(0, -1);

        const priorHigh = priorWindow.length ? Math.max(...priorWindow.map(item => item.bidPrice)) : null;
        const priorLow = priorWindow.length ? Math.min(...priorWindow.map(item => item.bidPrice)) : null;

        const newHigh = hasFullYear && priorHigh !== null && latest.bidPrice > priorHigh;
        const newLow = hasFullYear && priorLow !== null && latest.bidPrice < priorLow;

        const fromHigh = pct(high52, latest.bidPrice);

        // Usual move: stdev of observation-to-observation returns in
        // the 52-week yearObs, EXCLUDING the latest move.
        const returns = [];

        for (let index = 1; index < yearObs.length - 1; index += 1) {
            const value = pct(yearObs[index - 1].bidPrice, yearObs[index].bidPrice);

            if (value !== null) returns.push(value);
        }

        let usual = null;

        if (returns.length >= MIN_RETURNS_FOR_USUAL_MOVE) {
            const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
            const variance = returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (returns.length - 1);

            usual = Math.sqrt(variance);
        }

        const weekSteps = weekIndex >= 0 ? n - 1 - weekIndex : null;
        const usualWeek = usual !== null && weekSteps ? usual * Math.sqrt(weekSteps) : null;

        return {
            latestDate: latest.date,
            latestBid: latest.bidPrice,
            previousDate: previous.date,
            previousBid: previous.bidPrice,
            weekDate: weekIndex >= 0 ? observations[weekIndex].date : null,
            weekBid: weekIndex >= 0 ? observations[weekIndex].bidPrice : null,
            priorHigh,
            priorLow,
            d1,
            w1,
            m1,
            high52,
            low52,
            fromHigh,
            fromLow: pct(low52, latest.bidPrice),
            newHigh,
            newLow,
            hasFullYear,
            usual,
            usualWeek,
            zDay: usual ? d1 / usual : null,
            zWeek: usualWeek && w1 !== null ? w1 / usualWeek : null
        };
    }


    /* ============================================================
       ALERTS (watchlist)
       ============================================================ */

    function alertsFor(metrics) {
        if (!metrics) return [];

        const rules = monitor.rules;
        const alerts = [];

        // 1D / 1W / 1M: falls, rises or both, depending on the rule's direction
        const moveAlert = (rule, value, label) => {
            if (!rule.enabled || value === null || value === undefined) return;

            const direction = rule.direction ?? (rule === rules.dayMove ? "both" : "down");
            const hit =
                (direction !== "up" && value <= -rule.value) ||
                (direction !== "down" && value >= rule.value);

            if (hit) {
                alerts.push({ tone: value < 0 ? "negative" : "positive", text: `${label} ${formatPercent(value)}` });
            }
        };

        moveAlert(rules.dayMove, metrics.d1, "1D");
        moveAlert(rules.weekDrop, metrics.w1, "1W");
        moveAlert(rules.monthDrop, metrics.m1, "1M");

        // 52 weeks: below the high (down), above the low (up), or both
        if (rules.fromHigh.enabled) {
            const direction = rules.fromHigh.direction ?? "down";

            if (direction !== "up" && metrics.fromHigh !== null && metrics.fromHigh <= -rules.fromHigh.value) {
                alerts.push({ tone: "negative", text: `${formatPercent(metrics.fromHigh, 1)} from 52W high` });
            }

            if (direction !== "down" && metrics.fromLow !== null && metrics.fromLow !== undefined && metrics.fromLow >= rules.fromHigh.value) {
                alerts.push({ tone: "positive", text: `${formatPercent(metrics.fromLow, 1)} above 52W low` });
            }
        }

        if (rules.newHigh.enabled && metrics.newHigh) {
            alerts.push({ tone: "positive", text: "New 52W high" });
        }

        if (rules.newLow.enabled && metrics.newLow) {
            alerts.push({ tone: "negative", text: "New 52W low" });
        }

        return alerts;
    }


    /* ============================================================
       RENDER: WATCHLIST
       ============================================================ */

    /* Latest BID: the price Prudential publishes on the fund page
       (data/funds.json, same as the Fund Explorer list), with its
       valuation date. Falls back to the latest BID in the price
       history if the published price is missing. The 1D / 1W / 1M
       and 52-week figures are still worked out from the history. */
    function latestBidCell(id, metrics) {
        const details = monitor.fundById.get(id)?.fund ?? {};
        const published = Number(String(details.bidPrice ?? "").replace(/[^0-9.\-]/g, ""));

        if (String(details.bidPrice ?? "").trim() && Number.isFinite(published)) {
            const date = String(details.valuationDate ?? "").trim();

            return `${published.toLocaleString("en-SG", { minimumFractionDigits: cfg.publishedDigits, maximumFractionDigits: cfg.publishedDigits, useGrouping: cfg.digits === 2 })}${date ? `<div class="fund-meta">${escapeHtml(date)}</div>` : ""}`;
        }

        return metrics
            ? `${metrics.latestBid.toFixed(cfg.digits)}<div class="fund-meta">${escapeHtml(formatDate(metrics.latestDate))}</div>`
            : "—";
    }

    function fundCell(id) {
        const fund = monitor.fundById.get(id);

        return `
            <div class="fund-name">${escapeHtml(fund?.fundName ?? id)}</div>
            <div class="fund-meta">${escapeHtml(fund?.fundCode ?? "")}</div>
        `;
    }

    /* BID change over the chosen period, ending at the fund's latest price.
       Needs a price on or before the period start (else "—"). */
    function rangeChange(id, key) {
        const obs = monitor.history.get(id);
        const range = WATCH_RANGES[key];

        if (!Array.isArray(obs) || obs.length < 2 || !range) return null;

        const latest = obs[obs.length - 1];
        let index;

        if (!range.days && !range.months) {
            index = obs.length - 2;
        } else {
            const start = range.days
                ? isoMinusDays(latest.date, range.days)
                : isoMinusMonths(latest.date, range.months);

            index = indexOnOrBefore(obs, start);
        }

        if (index < 0 || index >= obs.length - 1) return null;

        // Longer than 1 year: annualised (p.a.)
        const change = periodReturn(obs[index].bidPrice, latest.bidPrice, obs[index].date, latest.date);

        return {
            value: change.value,
            annualised: change.annualised,
            fromDate: obs[index].date,
            fromBid: obs[index].bidPrice,
            toBid: latest.bidPrice
        };
    }

    /* "30 Sep 26": compact start date under each period change */
    function shortDate(iso) {
        const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
        const [year, month, day] = String(iso ?? "").split("-");

        return year ? `${day} ${months[Number(month) - 1]} ${year.slice(2)}` : "—";
    }

    function renderRangeTabs() {
        cfg.root().querySelectorAll("[data-watch-range]").forEach(button => {
            const active = monitor.ranges.includes(button.dataset.watchRange);

            button.classList.toggle("active", active);
            button.setAttribute("aria-pressed", String(active));
        });

        const row = qs(`#${cfg.prefix}watchlist-head-row`);

        if (row) {
            row.innerHTML = `
                <th scope="col"><span class="sr-only">Watching</span></th>
                <th scope="col">${cfg.Noun}</th>
                <th scope="col">Latest ${cfg.price}</th>
                ${monitor.ranges.map(key => `<th scope="col" class="monitor-range-cell">${escapeHtml(key)}${(WATCH_RANGES[key].months ?? 0) > 12 ? ` <span class="monitor-pa">p.a.</span>` : ""}</th>`).join("")}
                <th scope="col" class="monitor-high-cell">From 52W high</th>
                <th scope="col">Alerts</th>
            `;
        }

        const table = qs(`#${cfg.prefix}watchlist-body`)?.closest("table");

        if (table) {
            table.dataset.rangeCount = String(monitor.ranges.length);
            table.style.setProperty("--monitor-range-count", String(monitor.ranges.length));
        }
    }

    /* Turn a period on or off (at least one stays on); remembered in this browser */
    function toggleWatchRange(range) {
        if (!WATCH_RANGES[range]) return;

        const on = monitor.ranges.includes(range);

        if (on && monitor.ranges.length === 1) return;

        const next = on ? monitor.ranges.filter(key => key !== range) : [...monitor.ranges, range];

        monitor.ranges = WATCH_RANGE_ORDER.filter(key => next.includes(key));
        writeStorage(STORAGE_KEYS.range, JSON.stringify(monitor.ranges));
        renderRangeTabs();
        renderWatchlist();
    }

    function loadWatchRanges() {
        const saved = readStorage(STORAGE_KEYS.range);

        if (!saved) return;

        let list;

        try {
            list = JSON.parse(saved);
        } catch {
            list = saved;   // earlier versions saved a single period, e.g. "3Y"
        }

        if (!Array.isArray(list)) list = [list];

        const valid = WATCH_RANGE_ORDER.filter(key => list.includes(key));

        if (valid.length) monitor.ranges = valid;
    }

    function renderWatchlist() {
        const body = qs(`#${cfg.prefix}watchlist-body`);
        const summary = qs(`#${cfg.prefix}watchlist-summary`);

        if (!body) return;

        const ids = getWatchlist().filter(id => monitor.fundById.has(id));

        if (!ids.length) {
            if (summary) summary.textContent = `No ${cfg.plural} watched yet`;

            body.innerHTML = `
                <tr>
                    <td colspan="${5 + monitor.ranges.length}" class="empty-state monitor-empty">
                        Add ${cfg.plural} above, or click <strong>☆ Watch</strong> in any Fund Explorer profile.
                    </td>
                </tr>
            `;
            return;
        }

        let alertCount = 0;
        let fundsWithAlerts = 0;

        const rows = ids.map(id => {
            const metrics = monitor.metrics.get(id);
            const alerts = alertsFor(metrics);

            alertCount += alerts.length;
            if (alerts.length) fundsWithAlerts += 1;

            return { id, metrics, alerts };
        });

        // Funds with alerts first, then by name.
        rows.sort((a, b) =>
            (b.alerts.length > 0) - (a.alerts.length > 0) ||
            String(monitor.fundById.get(a.id)?.fundName).localeCompare(String(monitor.fundById.get(b.id)?.fundName))
        );

        if (summary) {
            summary.textContent = alertCount
                ? `${alertCount} alert${alertCount === 1 ? "" : "s"} on ${fundsWithAlerts} of ${ids.length} ${ids.length === 1 ? cfg.noun : cfg.plural}`
                : `${ids.length} ${ids.length === 1 ? cfg.noun : cfg.plural} watched · no alerts`;
        }

        body.innerHTML = rows
            .map(({ id, metrics, alerts }) => `
                <tr class="monitor-row${alerts.length ? " has-alerts" : ""}" data-monitor-open="${escapeHtml(id)}" tabindex="0">
                    <td class="monitor-star-cell">
                        <button type="button" class="monitor-star is-on" data-unwatch="${escapeHtml(id)}" title="Stop watching" aria-label="Stop watching">★</button>
                    </td>
                    <td class="fund-cell">${fundCell(id)}</td>
                    <td class="bid-cell" data-label="Latest ${cfg.price}">
                        ${latestBidCell(id, metrics)}
                    </td>
                    ${monitor.ranges.map(key => {
                        const change = rangeChange(id, key);

                        return `<td class="monitor-range-cell" data-label="${escapeHtml(key)}${(WATCH_RANGES[key].months ?? 0) > 12 ? " p.a." : ""}" title="${change ? `${escapeHtml(WATCH_RANGES[key].label)}${change.annualised ? ", annualised" : ""}: since ${escapeHtml(formatDate(change.fromDate))}` : "Not enough price history"}">${pill(change?.value ?? null)}${change ? `<div class="fund-meta">${change.annualised ? "p.a. " : ""}from ${escapeHtml(shortDate(change.fromDate))}</div>` : `<div class="fund-meta">no history</div>`}</td>`;
                    }).join("")}
                    <td class="monitor-high-cell" data-label="From high">${pill(metrics?.fromHigh, 1)}</td>
                    <td class="monitor-alerts-cell">
                        ${alerts.length
                            ? alerts.map(alert => `<span class="monitor-alert ${alert.tone}">${escapeHtml(alert.text)}</span>`).join("")
                            : `<span class="monitor-ok">No alerts</span>`}
                    </td>
                </tr>
            `)
            .join("");
    }


    /* ============================================================
       RENDER: UNUSUAL MOVES
       ============================================================ */

    /* "1.11198 → 1.10792" BID range line for the Unusual moves lists */
    function bidRange(fromLabel, fromBid, toBid, fromDate = null, toDate = null) {
        if (fromBid === null || fromBid === undefined || toBid === null || toBid === undefined) return "";

        const short = date => {
            const [, month, day] = String(date).split("-").map(Number);
            const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

            return month ? `${String(day).padStart(2, "0")} ${months[month - 1]}` : "";
        };

        const when = fromDate ? ` <span class="monitor-range-date">(${escapeHtml(short(fromDate))})</span>` : "";

        const latestWhen = toDate ? ` <span class="monitor-range-date">(${escapeHtml(short(toDate))})</span>` : "";

        return `${escapeHtml(fromLabel)} ${Number(fromBid).toFixed(cfg.digits)}${when} → ${Number(toBid).toFixed(cfg.digits)}${latestWhen}`;
    }

    function listRows(items, valueOf, detailOf, digits = 2, rangeOf = null) {
        if (!items.length) {
            return `<li class="monitor-list-empty">None today</li>`;
        }

        return items
            .map(({ id, metrics }) => `
                <li class="monitor-list-row" data-monitor-open="${escapeHtml(id)}" tabindex="0">
                    <div class="monitor-list-fund">
                        ${fundCell(id)}
                    </div>
                    <div class="monitor-list-value">
                        ${pill(valueOf(metrics), digits)}
                        <div class="fund-meta">${detailOf(metrics)}</div>
                    </div>
                    ${rangeOf ? `<div class="monitor-range">${rangeOf(metrics)}</div>` : ""}
                    ${isWatched(id) ? `<span class="monitor-list-star" title="On your watchlist">★</span>` : ""}
                </li>
            `)
            .join("");
    }

    function renderUnusual() {
        const container = qs(`#${cfg.prefix}unusual-lists`);
        const asOf = qs(`#${cfg.prefix}unusual-asof`);

        if (!container) return;

        if (asOf) asOf.textContent = monitor.asOf ? `Latest ${cfg.price} ${formatDate(monitor.asOf)}` : "";

        const all = [...monitor.metrics.entries()]
            .map(([id, metrics]) => ({ id, metrics }))
            .filter(item => item.metrics);

        const k = monitor.sensitivity;

        const unusualDay = all
            .filter(item => item.metrics.zDay !== null && Math.abs(item.metrics.zDay) >= k)
            .sort((a, b) => Math.abs(b.metrics.zDay) - Math.abs(a.metrics.zDay))
            .slice(0, LIST_LIMIT);

        const unusualWeek = all
            .filter(item => item.metrics.zWeek !== null && Math.abs(item.metrics.zWeek) >= k)
            .sort((a, b) => Math.abs(b.metrics.zWeek) - Math.abs(a.metrics.zWeek))
            .slice(0, LIST_LIMIT);

        const highs = all
            .filter(item => item.metrics.newHigh)
            .sort((a, b) => (b.metrics.d1 ?? 0) - (a.metrics.d1 ?? 0));

        const lows = all
            .filter(item => item.metrics.newLow)
            .sort((a, b) => (a.metrics.d1 ?? 0) - (b.metrics.d1 ?? 0));

        const furthest = all
            .filter(item => item.metrics.fromHigh !== null && item.metrics.fromHigh < 0)
            .sort((a, b) => a.metrics.fromHigh - b.metrics.fromHigh)
            .slice(0, LIST_LIMIT);

        const times = value => `${(Math.abs(value)).toFixed(1)}× usual`;

        const cards = {
            day: {
                hint: `Latest move ≥ ${k}× the ${cfg.noun}'s usual daily move`,
                items: listRows(unusualDay, m => m.d1, m => `${times(m.zDay)} (usual ±${m.usual.toFixed(2)}%)`, 2, m => bidRange(cfg.price, m.previousBid, m.latestBid, m.previousDate, m.latestDate))
            },
            week: {
                hint: `1-week move ≥ ${k}× the ${cfg.noun}'s usual weekly move`,
                items: listRows(unusualWeek, m => m.w1, m => `${times(m.zWeek)} (usual ±${m.usualWeek.toFixed(2)}%)`, 2, m => bidRange(cfg.price, m.weekBid, m.latestBid, m.weekDate, m.latestDate))
            },
            highs: {
                hint: `Latest ${cfg.price} above every ${cfg.price} of the past year`,
                items: listRows(highs, m => m.d1, m => "Above the previous 52-week high", 2, m => bidRange("Prev. high", m.priorHigh, m.latestBid, null, m.latestDate))
            },
            lows: {
                hint: `Latest ${cfg.price} below every ${cfg.price} of the past year`,
                items: listRows(lows, m => m.d1, m => "Below the previous 52-week low", 2, m => bidRange("Prev. low", m.priorLow, m.latestBid, null, m.latestDate))
            },
            furthest: {
                hint: `Current ${cfg.price} vs the highest ${cfg.price} of the past year`,
                items: listRows(furthest, m => m.fromHigh, m => "From its 52-week high", 1, m => bidRange("52W high", m.high52, m.latestBid, null, m.latestDate))
            }
        };

        const visible = monitor.layout.order.filter(key => !monitor.layout.hidden.includes(key));

        container.innerHTML = visible.length
            ? visible
                .map((key, index) => {
                    const list = UNUSUAL_LISTS.find(item => item.key === key);
                    const { hint, items } = cards[key];

                    return `
                        <section class="monitor-list-card" data-unusual-card="${key}" draggable="true">
                            <header>
                                <div class="monitor-list-heading">
                                    <span class="monitor-list-grip" aria-hidden="true" title="Drag to move">⋮⋮</span>
                                    <h3>${escapeHtml(list.title)}</h3>
                                    <div class="monitor-list-tools">
                                        <button type="button" data-unusual-move="-1" data-key="${key}" title="Move earlier" aria-label="Move ${escapeHtml(list.title)} earlier" ${index === 0 ? "disabled" : ""}>‹</button>
                                        <button type="button" data-unusual-move="1" data-key="${key}" title="Move later" aria-label="Move ${escapeHtml(list.title)} later" ${index === visible.length - 1 ? "disabled" : ""}>›</button>
                                        <button type="button" data-unusual-hide="${key}" title="Remove this list" aria-label="Remove ${escapeHtml(list.title)}">×</button>
                                    </div>
                                </div>
                                <span>${escapeHtml(hint)}</span>
                            </header>
                            <ol class="monitor-list">${items}</ol>
                        </section>
                    `;
                })
                .join("")
            : `<p class="monitor-lists-empty">All lists are removed. Use “Show” above to bring them back.</p>`;

        renderHiddenBar();
    }

    function renderHiddenBar() {
        const bar = qs(`#${cfg.prefix}unusual-hidden-bar`);

        if (!bar) return;

        const hidden = monitor.layout.hidden;
        const customised = hidden.length > 0 ||
            monitor.layout.order.join() !== DEFAULT_LAYOUT.order.join();

        bar.hidden = !customised;

        bar.innerHTML = `
            ${hidden.length
                ? `<span class="unusual-hidden-label">Removed:</span>
                   ${hidden
                       .map(key => {
                           const list = UNUSUAL_LISTS.find(item => item.key === key);

                           return `<button type="button" class="unusual-restore" data-unusual-show="${key}" title="Show this list again">+ ${escapeHtml(list?.title ?? key)}</button>`;
                       })
                       .join("")}`
                : `<span class="unusual-hidden-label">Custom layout</span>`}
            <button type="button" class="unusual-reset" data-unusual-reset>Reset layout</button>
        `;
    }


    /* ============================================================
       UNUSUAL MOVES LAYOUT (order + removed lists)
       ============================================================ */

    function loadLayout() {
        const known = DEFAULT_LAYOUT.order;

        try {
            const saved = JSON.parse(readStorage(STORAGE_KEYS.layout) ?? "null");

            if (saved && Array.isArray(saved.order)) {
                const order = saved.order.filter(key => known.includes(key));

                // Lists added in future versions go to the end.
                for (const key of known) if (!order.includes(key)) order.push(key);

                const hidden = Array.isArray(saved.hidden)
                    ? saved.hidden.filter(key => known.includes(key))
                    : [];

                return { order, hidden };
            }
        } catch {
            // fall through to default
        }

        return structuredClone(DEFAULT_LAYOUT);
    }

    function saveLayout() {
        writeStorage(STORAGE_KEYS.layout, JSON.stringify(monitor.layout));
    }

    /* Move a list one step among the lists currently shown. */
    function moveList(key, step) {
        const visible = monitor.layout.order.filter(item => !monitor.layout.hidden.includes(item));
        const position = visible.indexOf(key);
        const target = visible[position + step];

        if (position < 0 || !target) return;

        moveListTo(key, target, step > 0);
    }

    /* Place `key` before (or after) `targetKey` in the full order. */
    function moveListTo(key, targetKey, after = false) {
        if (key === targetKey) return;

        const order = monitor.layout.order.filter(item => item !== key);
        const index = order.indexOf(targetKey);

        if (index < 0) return;

        order.splice(after ? index + 1 : index, 0, key);

        monitor.layout.order = order;
        saveLayout();
        renderUnusual();
    }

    function bindLayoutEvents() {
        const container = qs(`#${cfg.prefix}unusual-lists`);
        const bar = qs(`#${cfg.prefix}unusual-hidden-bar`);

        container?.addEventListener("click", event => {
            const move = event.target.closest("[data-unusual-move]");

            if (move) {
                event.stopPropagation();
                moveList(move.dataset.key, Number(move.dataset.unusualMove));

                // keep keyboard focus on the moved list's button
                qs(`[data-unusual-card="${move.dataset.key}"] [data-unusual-move="${move.dataset.unusualMove}"]`)?.focus();
                return;
            }

            const hide = event.target.closest("[data-unusual-hide]");

            if (hide) {
                event.stopPropagation();

                if (!monitor.layout.hidden.includes(hide.dataset.unusualHide)) {
                    monitor.layout.hidden.push(hide.dataset.unusualHide);
                }

                saveLayout();
                renderUnusual();
            }
        });

        bar?.addEventListener("click", event => {
            const show = event.target.closest("[data-unusual-show]");

            if (show) {
                monitor.layout.hidden = monitor.layout.hidden.filter(key => key !== show.dataset.unusualShow);
                saveLayout();
                renderUnusual();
                return;
            }

            if (event.target.closest("[data-unusual-reset]")) {
                monitor.layout = structuredClone(DEFAULT_LAYOUT);
                saveLayout();
                renderUnusual();
            }
        });

        // Drag and drop (mouse); phones use the ‹ › buttons.
        let dragging = null;

        container?.addEventListener("dragstart", event => {
            const card = event.target.closest?.("[data-unusual-card]");

            if (!card) return;

            dragging = card.dataset.unusualCard;
            card.classList.add("is-dragging");

            try {
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("text/plain", dragging);
            } catch {
                // ignore
            }
        });

        container?.addEventListener("dragover", event => {
            const card = event.target.closest?.("[data-unusual-card]");

            if (!dragging || !card) return;

            event.preventDefault();

            container.querySelectorAll(".is-drop-target").forEach(item => item.classList.remove("is-drop-target"));

            if (card.dataset.unusualCard !== dragging) card.classList.add("is-drop-target");
        });

        container?.addEventListener("drop", event => {
            const card = event.target.closest?.("[data-unusual-card]");

            if (!dragging || !card) return;

            event.preventDefault();

            const order = monitor.layout.order;
            const after = order.indexOf(dragging) < order.indexOf(card.dataset.unusualCard);

            moveListTo(dragging, card.dataset.unusualCard, after);
            dragging = null;
        });

        container?.addEventListener("dragend", () => {
            dragging = null;

            container.querySelectorAll(".is-dragging, .is-drop-target").forEach(item =>
                item.classList.remove("is-dragging", "is-drop-target")
            );
        });
    }


    /* ============================================================
       ALERT RULES FORM
       ============================================================ */

    function loadRules() {
        try {
            const saved = JSON.parse(readStorage(STORAGE_KEYS.rules) ?? "null");

            if (saved && typeof saved === "object") {
                for (const key of Object.keys(DEFAULT_RULES)) {
                    if (saved[key]) monitor.rules[key] = { ...DEFAULT_RULES[key], ...saved[key] };
                }
            }
        } catch {
            // keep defaults
        }

        const sensitivity = Number(readStorage(STORAGE_KEYS.sensitivity));

        if ([2, 2.5, 3].includes(sensitivity)) monitor.sensitivity = sensitivity;
    }

    function syncRuleInputs() {
        for (const [key, rule] of Object.entries(monitor.rules)) {
            const toggle = qs(`[data-rule-enabled="${key}"]`);
            const input = qs(`[data-rule-value="${key}"]`);

            if (toggle) toggle.checked = Boolean(rule.enabled);

            const direction = qs(`[data-rule-direction="${key}"]`);

            if (direction && rule.direction) direction.value = rule.direction;
            if (input && rule.value !== undefined) {
                input.value = String(rule.value);
                input.disabled = !rule.enabled;
            }
        }

        const select = qs(`#${cfg.prefix}unusual-sensitivity`);

        if (select) select.value = String(monitor.sensitivity);
    }

    function saveRules() {
        writeStorage(STORAGE_KEYS.rules, JSON.stringify(monitor.rules));
        document.dispatchEvent(new CustomEvent("vgrat-alert-rules-change", { detail: cfg.prefix }));
    }


    /* ============================================================
       PICKER (add to watchlist)
       ============================================================ */

    function renderSuggestions() {
        const input = qs(`#${cfg.prefix}watchlist-search`);
        const list = qs(`#${cfg.prefix}watchlist-suggestions`);

        if (!input || !list) return;

        const query = input.value.trim().toLowerCase();

        const matches = monitor.funds
            .filter(fund => {
                const id = fundId(fund);

                if (isWatched(id) || !monitor.metrics.has(id)) return false;
                if (!query) return true;

                return (
                    String(fund.fundName ?? "").toLowerCase().includes(query) ||
                    String(fund.fundCode ?? "").toLowerCase().includes(query)
                );
            });
        // All funds are listed (no cut-off), so every fund can be picked
        // from the dropdown without having to search for it.

        list.innerHTML = matches.length
            ? matches
                .map((fund, index) => `
                    <li class="compare-suggestion" role="option" data-watch-add="${escapeHtml(fundId(fund))}">
                        <span class="compare-suggestion-name">${escapeHtml(fund.fundName ?? "")}</span>
                        <span class="compare-suggestion-code">${escapeHtml(fund.fundCode ?? "")}</span>
                    </li>
                `)
                .join("")
            : `<li class="compare-suggestion-empty">No matching ${cfg.plural}</li>`;

        list.hidden = false;
        placeDropdown(list);
    }

    function closeSuggestions() {
        const list = qs(`#${cfg.prefix}watchlist-suggestions`);

        if (list) list.hidden = true;
    }


    /* ============================================================
       EVENTS
       ============================================================ */

    function openFromEvent(event) {
        if (event.target.closest("[data-unwatch]")) return;

        const row = event.target.closest("[data-monitor-open]");

        if (row) monitor.openProfile(row.dataset.monitorOpen);
    }

    function bindEvents() {
        const input = qs(`#${cfg.prefix}watchlist-search`);
        const list = qs(`#${cfg.prefix}watchlist-suggestions`);

        input?.addEventListener("focus", renderSuggestions);
        input?.addEventListener("input", renderSuggestions);

        input?.addEventListener("keydown", event => {
            if (event.key === "Enter") {
                event.preventDefault();

                const first = qs(`#${cfg.prefix}watchlist-suggestions [data-watch-add]`);

                if (first) {
                    addToWatchlist(first.dataset.watchAdd);
                    input.value = "";
                    renderSuggestions();
                }
            } else if (event.key === "Escape") {
                closeSuggestions();
                input.blur();
            }
        });

        list?.addEventListener("mousedown", event => {
            const item = event.target.closest("[data-watch-add]");

            if (!item) return;

            event.preventDefault();
            addToWatchlist(item.dataset.watchAdd);

            if (input) input.value = "";

            renderSuggestions();
        });

        document.addEventListener("click", event => {
            if (!qs(".watchlist-picker")?.contains(event.target)) closeSuggestions();
        });

        // Alert rules are shared: another section changed them
        document.addEventListener("vgrat-alert-rules-change", event => {
            if (event.detail === cfg.prefix) return;

            loadRules();
            syncRuleInputs();
            renderWatchlist();
        });

        const view = cfg.root();

        view?.addEventListener("click", event => {
            const unwatch = event.target.closest("[data-unwatch]");

            if (unwatch) {
                event.stopPropagation();
                removeFromWatchlist(unwatch.dataset.unwatch);
                return;
            }

            openFromEvent(event);
        });

        view?.addEventListener("keydown", event => {
            if (event.key === "Enter") openFromEvent(event);
        });

        // Alert rules
        cfg.root().querySelectorAll("[data-rule-enabled]").forEach(toggle => {
            toggle.addEventListener("change", () => {
                const key = toggle.dataset.ruleEnabled;

                monitor.rules[key].enabled = toggle.checked;
                saveRules();
                syncRuleInputs();
                renderWatchlist();
            });
        });

        cfg.root().querySelectorAll("[data-rule-value]").forEach(field => {
            // Update as you type; ignore repeat events with no change
            // (so leaving the box doesn't redraw the table mid-click).
            const update = () => {
                const key = field.dataset.ruleValue;
                const value = Number(field.value);

                if (!Number.isFinite(value) || value <= 0) return;
                if (value === monitor.rules[key].value) return;

                monitor.rules[key].value = value;
                saveRules();
                renderWatchlist();
            };

            field.addEventListener("input", update);
            field.addEventListener("change", update);
        });

        cfg.root().querySelectorAll("[data-rule-direction]").forEach(select => {
            select.addEventListener("change", () => {
                const key = select.dataset.ruleDirection;

                if (!["down", "up", "both"].includes(select.value)) return;

                monitor.rules[key].direction = select.value;
                saveRules();
                renderWatchlist();
            });
        });

        qs("#alert-rules-reset")?.addEventListener("click", () => {
            monitor.rules = structuredClone(DEFAULT_RULES);
            saveRules();
            syncRuleInputs();
            renderWatchlist();
        });

        qs(`#${cfg.prefix}unusual-sensitivity`)?.addEventListener("change", event => {
            monitor.sensitivity = Number(event.target.value) || 2;
            writeStorage(STORAGE_KEYS.sensitivity, String(monitor.sensitivity));
            renderUnusual();
        });

        onWatchlistChange(() => {
            renderWatchlist();
            renderUnusual();
        });
    }


    /* ============================================================
       PUBLIC API
       ============================================================ */

    /**
     * @param {object}   options
     * @param {Array}    options.funds         funds.json records
     * @param {Map}      options.historyIndex  id -> sorted BID observations
     * @param {Function} options.openProfile   opens the Fund Explorer profile
     */
    function initializeMonitoring({ funds, historyIndex, openProfile }) {
        monitor.funds = [...(funds ?? [])].sort((a, b) =>
            String(a.fundName ?? "").localeCompare(String(b.fundName ?? ""))
        );

        monitor.fundById = new Map(monitor.funds.map(fund => [fundId(fund), fund]));
        monitor.openProfile = openProfile ?? monitor.openProfile;

        monitor.metrics = new Map();
        monitor.history = new Map();

        for (const fund of monitor.funds) {
            const id = fundId(fund);
            const observations = historyIndex?.get(id);
            const metrics = computeMetrics(observations);

            if (Array.isArray(observations)) monitor.history.set(id, observations);

            if (metrics) monitor.metrics.set(id, metrics);
        }

        monitor.asOf = [...monitor.metrics.values()]
            .map(item => item.latestDate)
            .sort()
            .pop() ?? null;

        if (!monitor.initialized) {
            loadWatchRanges();

            cfg.root().querySelectorAll("[data-watch-range]").forEach(button => {
                button.addEventListener("click", () => toggleWatchRange(button.dataset.watchRange));
            });

            loadRules();
            monitor.layout = loadLayout();
            bindEvents();
            bindLayoutEvents();
            monitor.initialized = true;
        }

        syncRuleInputs();
        renderRangeTabs();

        const loading = document.querySelector("#monitoring-loading");

        if (loading) loading.hidden = true;

        renderWatchlist();
        renderUnusual();
    }

    return {
        initialize: initializeMonitoring,
        computeMetrics
    };
}


const fundMonitor = createMonitor({
    root: () => document.querySelector('[data-monitor-block="funds"]') ?? document,
    prefix: "",
    storage: "",
    noun: "fund",
    Noun: "Fund",
    plural: "funds",
    price: "BID",
    digits: 5,
    publishedDigits: 4
});

const indexMonitor = createMonitor({
    root: () => document.querySelector('[data-monitor-block="indices"]') ?? document.createElement("div"),
    prefix: "index-",
    storage: "index-",
    noun: "index",
    Noun: "Index",
    plural: "indices",
    price: "close",
    digits: 2,
    publishedDigits: 2
});

function initializeMonitoring(options) {
    fundMonitor.initialize(options);
}

function initializeIndexMonitoring(options) {
    indexMonitor.initialize(options);
}

const computeMetrics = fundMonitor.computeMetrics;

export {
    initializeMonitoring,
    initializeIndexMonitoring,
    computeMetrics
};
