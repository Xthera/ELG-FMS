/* ============================================================
   ELG FMS — FUND EXPLORER
   ============================================================

   1. Fund list    searchable, sortable table of every fund
                   with filters (asset class, risk, geography,
                   sector, dividend) and a "holds company"
                   search across top-10 holdings.
   2. Profile      click a fund for a popup with its facts,
                   objective, Prudential's published returns,
                   top holdings, dividends and documents.

   Data sources:
     - data/funds.json         fund details, published returns,
                               holdings, dividends, documents
     - data/bid_history.json   ONLY for the profile's price
                               chart (shared with Market
                               Performance, so no extra
                               download)
   ============================================================ */

import { placeDropdown } from "./dropdown-place.js";
import {
    createChart,
    destroyChart,
    getFontScale
} from "./charts.js";

import {
    isWatched,
    toggleWatchlist,
    onWatchlistChange
} from "./watchlist.js";

const PROFILE_CHART_ID = "fund-profile-chart";

/* Profile chart ranges (months back from the latest BID). */
const PROFILE_RANGES = [
    ["3M", 3],
    ["6M", 6],
    ["1Y", 12],
    ["3Y", 36],
    ["5Y", 60],
    ["10Y", 120],
    ["SI", null],
    ["CUSTOM", null]
];

const PRUDENTIAL_ORIGIN = "https://www.prudential.com.sg";

/* Payment modes as published by Prudential (data/funds.json) */
const PAYMENT_MODE_ORDER = ["Cash", "SRS", "CPF-OA", "CPF-SA", "CPF"];

function paymentChips(modes) {
    return modes
        .map(mode => `<span class="payment-chip">${escapeHtml(mode)}</span>`)
        .join("");
}

const RISK_ORDER = {
    "Lower Risk": 1,
    "Low to Medium Risk": 2,
    "Medium to High Risk": 3,
    "Higher Risk": 4
};

const explorer = {
    initialized: false,
    historyIndex: null,          // set when bid_history.json arrives
    chart: {
        fundId: null,
        range: "1Y",
        from: null,              // custom range (ISO dates)
        to: null
    },
    funds: [],
    rows: [],
    filters: {
        search: "",
        holding: "",
        // Multi-select filters: [] means "All"
        assetClass: [],
        risk: [],
        geography: [],
        sector: [],
        dividend: [],
        payment: []
    },
    sort: { key: "name", direction: "asc" },
    profile: { id: null }
};


/* ============================================================
   HELPERS
   ============================================================ */

function qs(selector, parent = document) {
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

function isBlank(value) {
    const text = String(value ?? "").trim();
    return !text || text === "-" || text === "—";
}

/* "4.14%" -> 4.14 ; "-" -> null */
function parsePercent(value) {
    if (isBlank(value)) return null;

    const number = Number(String(value).replace(/[%,\s]/g, ""));

    return Number.isFinite(number) ? number : null;
}

/* "$1.1079" -> 1.1079 */
function parsePrice(value) {
    if (isBlank(value)) return null;

    const number = Number(String(value).replace(/[^0-9.\-]/g, ""));

    return Number.isFinite(number) ? number : null;
}

function formatPercent(value) {
    if (value === null || value === undefined) return "—";

    const sign = value > 0 ? "+" : "";

    return `${sign}${value.toFixed(2)}%`;
}

function returnClass(value) {
    if (value === null || value === undefined) return "";

    return value >= 0 ? "return-positive" : "return-negative";
}

function absoluteUrl(path) {
    if (isBlank(path)) return "";

    const text = String(path).trim();

    if (/^https?:\/\//i.test(text)) return text;
    if (text.startsWith("/")) return PRUDENTIAL_ORIGIN + text;

    return "";
}

function fundId(fund) {
    return String(fund?.fundIdentifier ?? fund?.fundCode ?? fund?.fundName ?? "");
}

function formatIsoDate(isoDate) {
    if (!isoDate) return "—";

    const [year, month, day] = isoDate.split("-").map(Number);

    return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString("en-SG", {
        timeZone: "UTC",
        day: "2-digit",
        month: "short",
        year: "numeric"
    });
}

function cleanGeo(value) {
    return isBlank(value) ? null : String(value).trim();
}


/* ============================================================
   ROW MODEL
   ============================================================ */

function buildRow(fund) {
    const details = fund.fund ?? {};
    const research = fund.research ?? {};

    const geographies = [research.geographic1, research.geographic2].map(cleanGeo).filter(Boolean);
    const sectors = [research.sector1, research.sector2].map(cleanGeo).filter(Boolean);

    const holdings = Array.isArray(fund.topHoldings?.holdings)
        ? fund.topHoldings.holdings
        : [];

    return {
        id: fundId(fund),
        fund,
        name: fund.fundName ?? "",
        code: fund.fundCode ?? "",
        paymentModes: Array.isArray(details.paymentModes) ? details.paymentModes.filter(Boolean) : [],
        assetClass: details.assetClass ?? "—",
        assetSubClass: details.assetSubClass ?? "",
        risk: details.riskClassification ?? "—",
        riskOrder: RISK_ORDER[details.riskClassification] ?? 99,
        bid: parsePrice(details.bidPrice),
        valuationDate: details.valuationDate ?? "",
        ytd: parsePercent(details.cumulativeYtd),
        m1: parsePercent(details.cumulative1m),
        y1: parsePercent(details.cumulative1y),
        y3: parsePercent(details.cumulative3y),
        hasDividend: Boolean(details.hasDividend),
        geographies,
        sectors,
        holdings,
        searchText: `${fund.fundName ?? ""} ${fund.fundCode ?? ""} ${fund.pruAccessName ?? ""}`.toLowerCase()
    };
}


/* ============================================================
   FILTER OPTIONS
   ============================================================ */

/* Values ticked in a multi-select filter, without "ALL" */
function selectedValues(select) {
    return select
        ? [...select.selectedOptions].map(option => option.value).filter(value => value && value !== "ALL")
        : [];
}

function fillSelect(selector, values, allLabel, labelFor = value => value) {
    const select = qs(selector);

    if (!select) return;

    const current = selectedValues(select);

    // Keep the current choices listed even if they now have no matches,
    // so the dropdown never silently changes what you picked.
    const list = [...current.filter(value => !values.includes(value)), ...values];

    const html =
        `<option value="ALL" data-label="${escapeHtml(allLabel)}">${escapeHtml(allLabel)}</option>` +
        list
            .map(value => `<option value="${escapeHtml(value)}">${escapeHtml(labelFor(value))}</option>`)
            .join("");

    // Only touch the DOM when something changed
    if (select.dataset.optionsHtml !== html) {
        select.innerHTML = html;
        select.dataset.optionsHtml = html;
    }

    for (const option of select.options) {
        option.selected = current.length ? current.includes(option.value) : option.value === "ALL";
    }

    select.dispatchEvent(new Event("vselect:sync"));
}

function countBy(rows, pick) {
    const counts = new Map();

    for (const row of rows) {
        for (const value of new Set(pick(row))) {
            counts.set(value, (counts.get(value) ?? 0) + 1);
        }
    }

    return counts;
}

/*
 * Dynamic filters: each dropdown lists only the options that still
 * have funds given every OTHER filter (search, holding and the other
 * dropdowns), with live counts. Runs on every filter change.
 */
function renderFilterOptions() {
    const rowsWithout = key => explorer.rows.filter(row => rowMatches(row, explorer.filters, key));
    const label = counts => value => `${value} (${counts.get(value) ?? 0})`;

    const assetRows = rowsWithout("assetClass");
    const assetCounts = countBy(assetRows, row => [row.assetClass]);
    fillSelect(
        "#explorer-asset",
        [...assetCounts.keys()].sort(),
        `All asset classes (${assetRows.length})`,
        label(assetCounts)
    );

    const riskRows = rowsWithout("risk");
    const riskCounts = countBy(riskRows, row => [row.risk]);
    fillSelect(
        "#explorer-risk",
        [...riskCounts.keys()].sort((a, b) => (RISK_ORDER[a] ?? 99) - (RISK_ORDER[b] ?? 99)),
        `All risk levels (${riskRows.length})`,
        label(riskCounts)
    );

    const geoRows = rowsWithout("geography");
    const geoCounts = countBy(geoRows, row => row.geographies);
    fillSelect(
        "#explorer-geography",
        [...geoCounts.keys()].sort((a, b) => geoCounts.get(b) - geoCounts.get(a) || a.localeCompare(b)),
        `All geographies (${geoRows.length})`,
        label(geoCounts)
    );

    const sectorRows = rowsWithout("sector");
    const sectorCounts = countBy(sectorRows, row => row.sectors);
    fillSelect(
        "#explorer-sector",
        [...sectorCounts.keys()].sort((a, b) => sectorCounts.get(b) - sectorCounts.get(a) || a.localeCompare(b)),
        `All sectors (${sectorRows.length})`,
        label(sectorCounts)
    );

    const dividendRows = rowsWithout("dividend");
    const dividendCounts = countBy(dividendRows, row => [row.hasDividend ? "YES" : "NO"]);
    fillSelect(
        "#explorer-dividend",
        ["YES", "NO"].filter(value => dividendCounts.has(value)),
        `All funds (${dividendRows.length})`,
        value => `${value === "YES" ? "Pays dividend" : "No dividend"} (${dividendCounts.get(value) ?? 0})`
    );

    // Payment mode (shown only once funds.json has payment modes)
    const anyPayment = explorer.rows.some(row => row.paymentModes.length);
    const paymentLabel = document.querySelector("[data-payment-filter]");

    if (paymentLabel) paymentLabel.hidden = !anyPayment;

    if (anyPayment) {
        const paymentRows = rowsWithout("payment");
        const paymentCounts = countBy(paymentRows, row => row.paymentModes);

        fillSelect(
            "#explorer-payment",
            PAYMENT_MODE_ORDER.filter(mode => paymentCounts.has(mode)),
            `All payment modes (${paymentRows.length})`,
            label(paymentCounts)
        );
    }

    // Funds-holding suggestions follow the other filters too
    explorer.holdingNames = holdingNamesFor(rowsWithout("holding"));
}

function holdingNamesFor(rows) {
    // Group spellings that differ only by case ("NVIDIA Corp" / "NVIDIA CORP")
    const holdingGroups = new Map();

    for (const row of rows) {
        const seen = new Set();

        for (const holding of row.holdings) {
            const name = String(holding?.name ?? "").trim();
            const key = name.toLowerCase();

            if (!name || seen.has(key)) continue;

            seen.add(key);

            const group = holdingGroups.get(key) ?? { count: 0, spellings: new Map() };

            group.count += 1;
            group.spellings.set(name, (group.spellings.get(name) ?? 0) + 1);
            holdingGroups.set(key, group);
        }
    }

    return [...holdingGroups.values()]
        .map(group => ({
            name: [...group.spellings.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0],
            count: group.count
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
}


/* ============================================================
   HOLDINGS PICKER (scrollable suggestion list)
   ============================================================ */

function renderHoldingSuggestions() {
    const input = qs("#explorer-holding");
    const list = qs("#explorer-holding-options");

    if (!input || !list) return;

    const query = input.value.trim().toLowerCase();
    const names = explorer.holdingNames ?? [];

    const matches = query
        ? names
            .filter(item => item.name.toLowerCase().includes(query))
            .sort((a, b) =>
                Number(!a.name.toLowerCase().startsWith(query)) - Number(!b.name.toLowerCase().startsWith(query)) ||
                a.name.localeCompare(b.name)
            )
        : names;

    list.innerHTML = matches.length
        ? matches
            .map((item, index) => `
                <li class="compare-suggestion" role="option" data-holding-pick="${escapeHtml(item.name)}">
                    <span class="compare-suggestion-name">${escapeHtml(item.name)}</span>
                    <span class="compare-suggestion-code">${item.count} fund${item.count === 1 ? "" : "s"}</span>
                </li>
            `)
            .join("")
        : `<li class="compare-suggestion-empty">No matching holdings</li>`;

    list.hidden = false;
    placeDropdown(list);
    list.scrollTop = 0;
    input.setAttribute("aria-expanded", "true");
}

function closeHoldingSuggestions() {
    const list = qs("#explorer-holding-options");

    if (list) list.hidden = true;

    qs("#explorer-holding")?.setAttribute("aria-expanded", "false");
}

function pickHolding(name) {
    const input = qs("#explorer-holding");

    if (!input) return;

    input.value = name;
    explorer.filters.holding = name;
    closeHoldingSuggestions();
    renderTable();
}

function moveHoldingHighlight(step) {
    const items = [...document.querySelectorAll("#explorer-holding-options [data-holding-pick]")];

    if (!items.length) return;

    const current = items.findIndex(item => item.classList.contains("is-highlighted"));
    const next = Math.min(Math.max(current + step, 0), items.length - 1);

    items.forEach((item, index) => item.classList.toggle("is-highlighted", index === next));
    items[next].scrollIntoView({ block: "nearest" });
}

function bindHoldingPicker() {
    const input = qs("#explorer-holding");
    const list = qs("#explorer-holding-options");

    if (!input || !list) return;

    input.addEventListener("focus", renderHoldingSuggestions);
    input.addEventListener("input", renderHoldingSuggestions);
    input.addEventListener("blur", () => setTimeout(closeHoldingSuggestions, 120));

    input.addEventListener("keydown", event => {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();

            if (list.hidden) renderHoldingSuggestions();

            moveHoldingHighlight(event.key === "ArrowDown" ? 1 : -1);
        } else if (event.key === "Enter") {
            const item = qs("#explorer-holding-options .is-highlighted[data-holding-pick]");

            if (!list.hidden && item) {
                event.preventDefault();
                pickHolding(item.dataset.holdingPick);
            }
        } else if (event.key === "Escape") {
            closeHoldingSuggestions();
        }
    });

    // mousedown keeps focus in the input; scrolling the list works normally
    list.addEventListener("mousedown", event => {
        event.preventDefault();

        const item = event.target.closest("[data-holding-pick]");

        if (item) pickHolding(item.dataset.holdingPick);
    });
}


/* ============================================================
   FILTER + SORT
   ============================================================ */

function holdingMatches(row, term) {
    if (!term) return [];

    return row.holdings.filter(holding =>
        String(holding?.name ?? "").toLowerCase().includes(term)
    );
}

/* Does a fund pass the filters? `skip` ignores one filter
   (used to work out each dropdown's remaining options). */
/* Does a fund pass the filters? `skip` ignores one filter
   (used to work out each dropdown's remaining options).
   Within a filter any ticked value matches (OR); filters combine with AND. */
function rowMatches(row, f, skip = null) {
    const search = f.search.trim().toLowerCase();
    const holding = f.holding.trim().toLowerCase();
    const one = (list, value) => !list.length || list.includes(value);
    const any = (list, values) => !list.length || values.some(value => list.includes(value));

    if (skip !== "search" && search && !row.searchText.includes(search)) return false;
    if (skip !== "assetClass" && !one(f.assetClass, row.assetClass)) return false;
    if (skip !== "risk" && !one(f.risk, row.risk)) return false;
    if (skip !== "geography" && !any(f.geography, row.geographies)) return false;
    if (skip !== "sector" && !any(f.sector, row.sectors)) return false;
    if (skip !== "dividend" && !one(f.dividend, row.hasDividend ? "YES" : "NO")) return false;
    if (skip !== "holding" && holding && holdingMatches(row, holding).length === 0) return false;
    if (skip !== "payment" && !any(f.payment, row.paymentModes)) return false;

    return true;
}

function getVisibleRows() {
    let rows = explorer.rows.filter(row => rowMatches(row, explorer.filters));

    const { key, direction } = explorer.sort;
    const factor = direction === "asc" ? 1 : -1;

    const value = row => {
        switch (key) {
            case "code": return row.code;
            case "asset": return row.assetClass;
            case "risk": return row.riskOrder;
            case "bid": return row.bid;
            case "ytd": return row.ytd;
            case "m1": return row.m1;
            case "y1": return row.y1;
            case "y3": return row.y3;
            default: return row.name;
        }
    };

    rows = [...rows].sort((a, b) => {
        const va = value(a);
        const vb = value(b);

        // Missing values always last
        if (va === null || va === undefined) return 1;
        if (vb === null || vb === undefined) return -1;

        if (typeof va === "number" && typeof vb === "number") {
            return (va - vb) * factor || a.name.localeCompare(b.name);
        }

        return String(va).localeCompare(String(vb)) * factor || a.name.localeCompare(b.name);
    });

    return rows;
}


/* ============================================================
   TABLE
   ============================================================ */

function renderTable() {
    const body = qs("#explorer-table-body");
    const count = qs("#explorer-count");
    const clear = qs("#explorer-clear");

    if (!body) return;

    renderFilterOptions();

    const rows = getVisibleRows();
    const holdingTerm = explorer.filters.holding.trim().toLowerCase();

    const active = Object.entries(explorer.filters).some(([key, value]) =>
        Array.isArray(value) ? value.length > 0 : String(value ?? "").trim() !== ""
    );

    if (count) {
        count.textContent = active
            ? `${rows.length} of ${explorer.rows.length} funds`
            : `${explorer.rows.length} funds`;
    }

    if (clear) clear.hidden = !active;

    document.querySelectorAll("[data-explorer-filter]").forEach(control => {
        const filtered = control.tagName === "SELECT"
            ? selectedValues(control).length > 0
            : control.value.trim() !== "";

        control.classList.toggle("is-filtered", filtered);
    });

    const sortSelect = qs("#explorer-sort-mobile");

    if (sortSelect) {
        const value = `${explorer.sort.key}:${explorer.sort.direction}`;

        if (![...sortSelect.options].some(option => option.value === value)) {
            sortSelect.querySelector("option[data-custom]")?.remove();
            sortSelect.insertAdjacentHTML("beforeend", `<option value="${value}" data-custom>Custom</option>`);
        }

        sortSelect.value = value;
    }

    document.querySelectorAll("[data-explorer-sort]").forEach(header => {
        const isActive = header.dataset.explorerSort === explorer.sort.key;

        header.classList.toggle("is-sorted", isActive);
        header.setAttribute(
            "aria-sort",
            isActive ? (explorer.sort.direction === "asc" ? "ascending" : "descending") : "none"
        );

        const arrow = qs(".sort-arrow", header);

        if (arrow) {
            arrow.textContent = isActive ? (explorer.sort.direction === "asc" ? "▲" : "▼") : "";
        }
    });

    if (!rows.length) {
        body.innerHTML = `
            <tr>
                <td colspan="9" class="empty-state">No funds match these filters.</td>
            </tr>
        `;
        return;
    }

    body.innerHTML = rows
        .map(row => {
            const matches = holdingMatches(row, holdingTerm);

            const holdingNote = matches.length
                ? `<div class="explorer-holding-match">Holds ${matches
                    .map(holding => `${escapeHtml(holding.name)} ${escapeHtml(holding.weightText ?? "")}`)
                    .join(", ")}</div>`
                : "";

            const cell = (value, label) => `<td class="return-cell ${returnClass(value)}" data-label="${label}">${formatPercent(value)}</td>`;

            return `
                <tr class="explorer-row" data-fund-open="${escapeHtml(row.id)}" tabindex="0" role="button">
                    <td class="fund-cell">
                        <div class="explorer-fund-wrap">
                            ${watchStarButton(row.id, row.name)}
                            <div class="explorer-fund-text">
                                <div class="fund-name">${escapeHtml(row.name)}</div>
                                <div class="fund-meta">
                                    ${escapeHtml(row.code)}${row.hasDividend ? ` · <span class="explorer-dividend-tag">Dividend</span>` : ""}
                                </div>
                                ${holdingNote}
                            </div>
                        </div>
                    </td>
                    <td class="explorer-payment-cell" data-label="Payment mode">${row.paymentModes.length ? `<div class="payment-chips">${paymentChips(row.paymentModes)}</div>` : "—"}</td>
                    <td class="explorer-asset-cell">${escapeHtml(row.assetClass)}</td>
                    <td class="explorer-risk-cell"><span class="risk-pill risk-${row.riskOrder}">${escapeHtml(row.risk)}</span></td>
                    <td class="bid-cell" data-label="BID price">${row.bid !== null ? row.bid.toFixed(4) : "—"}</td>
                    ${cell(row.ytd, "YTD")}
                    ${cell(row.m1, "1M")}
                    ${cell(row.y1, "1Y")}
                    ${cell(row.y3, "3Y")}
                </tr>
            `;
        })
        .join("");
}


/* ============================================================
   WATCHLIST STAR (list rows)
   ============================================================ */

function watchStarButton(id, name) {
    const on = isWatched(id);

    return `<button
        type="button"
        class="explorer-star${on ? " is-on" : ""}"
        data-explorer-watch="${escapeHtml(id)}"
        aria-pressed="${on}"
        aria-label="${on ? "Remove" : "Add"} ${escapeHtml(name)} ${on ? "from" : "to"} your watchlist"
        title="${on ? "Watching · click to remove from your watchlist" : "Add to your Monitoring watchlist"}"
    >${on ? "★" : "☆"}</button>`;
}

/* Keep stars (list) and the popup button in step with the watchlist,
   whichever page changed it. */
function syncWatchButtons() {
    document.querySelectorAll("[data-explorer-watch]").forEach(button => {
        const id = button.dataset.explorerWatch;
        const on = isWatched(id);
        const name = button.closest("tr")?.querySelector(".fund-name")?.textContent.trim() ?? "fund";

        button.classList.toggle("is-on", on);
        button.setAttribute("aria-pressed", String(on));
        button.setAttribute("aria-label", `${on ? "Remove" : "Add"} ${name} ${on ? "from" : "to"} your watchlist`);
        button.title = on ? "Watching · click to remove from your watchlist" : "Add to your Monitoring watchlist";
        button.textContent = on ? "★" : "☆";
    });

    document.querySelectorAll("[data-fund-watch]").forEach(button => {
        const on = isWatched(button.dataset.fundWatch);

        button.classList.toggle("is-on", on);
        button.setAttribute("aria-pressed", String(on));
        button.textContent = on ? "★ Watching" : "☆ Watch";
    });
}


/* ============================================================
   PROFILE POPUP
   ============================================================ */

function ensureDialog() {
    let dialog = document.getElementById("fund-dialog");

    if (!dialog) {
        dialog = document.createElement("dialog");
        dialog.id = "fund-dialog";
        dialog.className = "news-dialog fund-dialog";
        dialog.setAttribute("aria-labelledby", "fund-dialog-title");

        dialog.addEventListener("click", event => {
            if (event.target === dialog) dialog.close();
        });

        dialog.addEventListener("close", () => {
            document.body.classList.remove("has-news-dialog");
            destroyChart(PROFILE_CHART_ID);
        });

        document.body.appendChild(dialog);
    }

    return dialog;
}

function fact(label, value) {
    if (isBlank(value)) return "";

    return `
        <div class="fund-fact">
            <span class="fund-fact-label">${escapeHtml(label)}</span>
            <span class="fund-fact-value">${escapeHtml(value)}</span>
        </div>
    `;
}

function returnsTable(details) {
    /*
     * One row: short periods are cumulative, long periods
     * (3Y and longer) are annualised (per annum).
     */
    const returns = [
        ["YTD", details.cumulativeYtd, false],
        ["1M", details.cumulative1m, false],
        ["3M", details.cumulative3m, false],
        ["6M", details.cumulative6m, false],
        ["1Y", details.cumulative1y, false],
        ["3Y", details.annualised3y, true],
        ["5Y", details.annualised5y, true],
        ["10Y", details.annualised10y, true],
        ["Since launch", details.annualisedSinceLaunch, true]
    ];

    const cells = returns
        .map(([label, raw, annualised]) => {
            const value = parsePercent(raw);

            return `
                <div class="fund-return${annualised ? " is-annualised" : ""}">
                    <span class="fund-return-label">
                        ${escapeHtml(label)}${annualised ? ` <span class="fund-return-pa">p.a.</span>` : ""}
                    </span>
                    <span class="fund-return-value ${returnClass(value)}">${formatPercent(value)}</span>
                </div>
            `;
        })
        .join("");

    return `
        <section class="news-popup-section">
            <h3 class="news-popup-label">Returns</h3>
            <div class="fund-returns">${cells}</div>
        </section>

        <p class="fund-source-note">
            YTD to 1Y are cumulative; 3Y, 5Y, 10Y and Since launch are annualised (p.a.).
        </p>
    `;
}

function holdingsSection(fund, holdings) {
    const top = fund.topHoldings ?? {};

    if (!holdings.length) {
        return `
            <section class="news-popup-section">
                <h3 class="news-popup-label">Top holdings</h3>
                <p class="news-popup-muted">The factsheet does not publish a holdings list for this fund.</p>
            </section>
        `;
    }

    const max = Math.max(...holdings.map(holding => Number(holding.weightPercent) || 0), 1);
    const term = explorer.filters.holding.trim().toLowerCase();

    return `
        <section class="news-popup-section">
            <div class="fund-section-heading">
                <h3 class="news-popup-label">Top ${holdings.length} holdings</h3>
                ${top.factsheetDataAsAt ? `<span class="fund-heading-date">Data as at ${escapeHtml(top.factsheetDataAsAt)}</span>` : ""}
            </div>

            <ol class="fund-holdings">
                ${holdings
                    .map(holding => {
                        const weight = Number(holding.weightPercent) || 0;
                        const highlighted = term && String(holding.name ?? "").toLowerCase().includes(term);

                        return `
                            <li class="${highlighted ? "is-highlighted" : ""}">
                                <span class="fund-holding-rank">${escapeHtml(holding.rank ?? "")}</span>
                                <span class="fund-holding-name">${escapeHtml(holding.name ?? "")}</span>
                                <span class="fund-holding-bar" aria-hidden="true">
                                    <span style="width:${((weight / max) * 100).toFixed(1)}%"></span>
                                </span>
                                <span class="fund-holding-weight">${escapeHtml(holding.weightText ?? `${weight}%`)}</span>
                            </li>
                        `;
                    })
                    .join("")}
            </ol>

        </section>
    `;
}

function formatRate(rate, unit) {
    const number = Number(rate);
    const text = Number.isFinite(number) ? number.toFixed(2) : String(rate ?? "");

    // Unit as published in funds.json:
    //   "%", "% p.a.", "% per payout" -> "1.25%"
    //   "S$", "SGD", "US$"            -> "S$1.25"
    //   "cents per unit" etc.         -> "1.25 cents per unit"
    const clean = String(unit ?? "").trim();

    if (!clean) return text;
    if (clean.startsWith("%")) return `${text}%`;
    if (/^(S\$|US\$|\$|SGD|USD)$/i.test(clean)) return `${clean}${/^[A-Z]+$/i.test(clean) ? " " : ""}${text}`;

    return `${text} ${clean}`;
}

/* Payout frequency, worked out from the gaps between the most recent
   ex-dividend dates (Prudential's data has no frequency field). */
const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function payoutPeriod(history) {
    const dates = history
        .map(item => String(item?.exDate ?? ""))
        .filter(date => /^\d{4}-\d{2}-\d{2}$/.test(date))
        .sort()
        .reverse();

    if (dates.length < 2) {
        return { label: "Not enough history", months: [], last: dates[0] ?? null };
    }

    const recent = dates.slice(0, 7);
    const gaps = [];

    for (let i = 1; i < recent.length; i += 1) {
        gaps.push((Date.parse(recent[i - 1]) - Date.parse(recent[i])) / 86400000);
    }

    gaps.sort((a, b) => a - b);

    const median = gaps[Math.floor(gaps.length / 2)];

    const label =
        median <= 45 ? "Monthly"
        : median <= 120 ? "Quarterly"
        : median <= 220 ? "Half-yearly"
        : median <= 400 ? "Yearly"
        : "Irregular";

    // Usual payout months, from the payments in the latest 12 months
    const lastTime = Date.parse(dates[0]);
    const months = [...new Set(
        dates
            .filter(date => lastTime - Date.parse(date) < 360 * 86400000)
            .map(date => Number(date.slice(5, 7)) - 1)
    )].sort((a, b) => a - b);

    return { label, months, last: dates[0] };
}

function dividendSection(details) {
    if (!details.hasDividend) return "";

    const history = Array.isArray(details.dividendHistory) ? details.dividendHistory : [];
    const unit = details.dividendUnit ?? "";

    if (!history.length) {
        return `
            <section class="news-popup-section">
                <h3 class="news-popup-label">Dividends</h3>
                <p>This fund pays dividends.</p>
            </section>
        `;
    }

    const period = payoutPeriod(history);
    const latest = [...history].sort((a, b) => String(b.exDate).localeCompare(String(a.exDate)))[0];
    const usualMonths = period.label === "Monthly"
        ? "every month"
        : period.months.length && period.label !== "Irregular"
            ? period.months.map(month => MONTH_SHORT[month]).join(", ")
            : "";

    return `
        <section class="news-popup-section">
            <h3 class="news-popup-label">Dividend payout</h3>

            <div class="fund-payout">
                <div class="fund-payout-item">
                    <span>Payout frequency</span>
                    <strong>${escapeHtml(period.label)}</strong>
                    ${usualMonths ? `<em>${period.label === "Monthly" ? "Paid every month" : `Usually ${escapeHtml(usualMonths)}`}</em>` : period.label === "Not enough history" ? `<em>Only one payout on record</em>` : ""}
                </div>
                <div class="fund-payout-item">
                    <span>Last payout</span>
                    <strong>${escapeHtml(formatIsoDate(latest?.exDate))}</strong>
                    <em>${escapeHtml(formatRate(latest?.rate, unit))}</em>
                </div>
            </div>

            <p class="fund-source-note">Payout frequency worked out from the dates of recent payouts (ex-dividend dates).</p>
        </section>

        <section class="news-popup-section">
            <h3 class="news-popup-label">Dividend history${unit ? ` (${escapeHtml(unit)})` : ""}</h3>

            <div class="fund-dividends">
                ${history
                    .slice(0, 12)
                    .map(item => `
                        <div class="fund-dividend">
                            <span>${escapeHtml(formatIsoDate(item.exDate))}</span>
                            <strong>${escapeHtml(formatRate(item.rate, unit))}</strong>
                        </div>
                    `)
                    .join("")}
            </div>

            ${history.length > 12 ? `<p class="fund-source-note">Latest 12 of ${history.length} payouts shown.</p>` : ""}

            ${details.dividendUnitSource === "default" ? `
                <p class="fund-source-note">
                    Prudential did not show a unit for this fund's payouts; the default unit is displayed.
                </p>
            ` : ""}
        </section>
    `;
}

function documentsSection(fund) {
    const details = fund.fund ?? {};

    const links = [
        ["Fund page", fund.prudentialUrl],
        ["Factsheet", details.factsheetUrl],
        ["Product highlights", details.productHighlightSheetUrl],
        ["Prospectus", details.prospectusUrl],
        ["Annual report", details.annualReportUrl]
    ]
        .map(([label, url]) => [label, absoluteUrl(url)])
        .filter(([, url]) => url);

    if (!links.length) return "";

    return `
        <section class="news-popup-section">
            <h3 class="news-popup-label">Documents</h3>

            <div class="fund-documents">
                ${links
                    .map(([label, url]) => `
                        <a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)} ↗</a>
                    `)
                    .join("")}
            </div>
        </section>
    `;
}

/* ============================================================
   PROFILE PRICE CHART
   ============================================================
   Actual BID prices only. Gaps between dates are joined with
   a straight line; nothing is interpolated.
   ============================================================ */

function isoMinusMonths(isoDate, months) {
    const [year, month, day] = isoDate.split("-").map(Number);
    const target = new Date(Date.UTC(year, month - 1 - months, 1));
    const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();

    target.setUTCDate(Math.min(day, lastDay));

    return target.toISOString().slice(0, 10);
}

function chartSectionHtml() {
    const buttons = PROFILE_RANGES
        .map(([key]) => `
            <button
                type="button"
                class="compare-range-tab"
                data-profile-range="${key}"
                role="tab"
                aria-selected="false"
            >${key === "CUSTOM" ? "Custom" : key}</button>
        `)
        .join("");

    return `
        <section class="news-popup-section fund-chart-section">

            <div class="fund-chart-header">
                <div class="fund-section-heading">
                    <h3 class="news-popup-label">BID price</h3>
                    <span id="fund-chart-summary" class="fund-heading-date"></span>
                </div>

                <div class="compare-range-selector" role="tablist" aria-label="Chart range">
                    ${buttons}
                </div>
            </div>

            <div id="fund-chart-custom" class="fund-chart-custom" hidden>
                <label>
                    <span>From</span>
                    <input id="fund-chart-from" type="date">
                </label>
                <label>
                    <span>To</span>
                    <input id="fund-chart-to" type="date">
                </label>
                <span id="fund-chart-custom-error" class="fund-chart-error" role="alert"></span>
            </div>

            <div id="fund-chart-wrap" class="fund-chart-wrap">
                <canvas
                    id="${PROFILE_CHART_ID}"
                    role="img"
                    aria-label="BID price history for this fund"
                ></canvas>
            </div>

            <p id="fund-chart-status" class="news-popup-muted fund-chart-status" hidden></p>

        </section>
    `;
}

function setChartStatus(message) {
    const status = qs("#fund-chart-status");
    const wrap = qs("#fund-chart-wrap");

    if (status) {
        status.textContent = message ?? "";
        status.hidden = !message;
    }

    if (wrap) {
        wrap.hidden = Boolean(message);
    }

    // No chart drawn -> no range summary either.
    if (message) {
        const summary = qs("#fund-chart-summary");

        if (summary) summary.textContent = "";
    }
}

function renderProfileChart() {
    const dialog = document.getElementById("fund-dialog");

    if (!dialog?.open || !qs("#fund-chart-wrap")) return;

    const { fundId, range } = explorer.chart;

    document.querySelectorAll("[data-profile-range]").forEach(button => {
        const active = button.dataset.profileRange === range;

        button.classList.toggle("active", active);
        button.setAttribute("aria-selected", String(active));
    });

    const custom = qs("#fund-chart-custom");

    if (custom) custom.hidden = range !== "CUSTOM";

    if (!explorer.historyIndex) {
        destroyChart(PROFILE_CHART_ID);
        setChartStatus("Loading price history…");
        return;
    }

    const observations = explorer.historyIndex.get(fundId) ?? [];

    if (!observations.length) {
        destroyChart(PROFILE_CHART_ID);
        setChartStatus("No BID price history is available for this fund.");
        return;
    }

    const first = observations[0].date;
    const last = observations[observations.length - 1].date;

    // Custom inputs: bounded to the available history.
    const fromInput = qs("#fund-chart-from");
    const toInput = qs("#fund-chart-to");
    const error = qs("#fund-chart-custom-error");

    for (const input of [fromInput, toInput]) {
        if (input) {
            input.min = first;
            input.max = last;
        }
    }

    let start = first;
    let end = last;

    if (range === "CUSTOM") {
        explorer.chart.from ??= isoMinusMonths(last, 12) < first ? first : isoMinusMonths(last, 12);
        explorer.chart.to ??= last;

        if (fromInput && !fromInput.value) fromInput.value = explorer.chart.from;
        if (toInput && !toInput.value) toInput.value = explorer.chart.to;

        start = explorer.chart.from;
        end = explorer.chart.to;

        if (start > end) {
            if (error) error.textContent = "“From” must be before “To”.";
            destroyChart(PROFILE_CHART_ID);
            setChartStatus("Choose a start date before the end date.");
            return;
        }

        if (error) error.textContent = "";
    } else {
        const months = PROFILE_RANGES.find(([key]) => key === range)?.[1];

        if (months) {
            const target = isoMinusMonths(last, months);

            // Start from the latest actual BID on or before the target.
            let base = observations[0];

            for (const observation of observations) {
                if (observation.date <= target) base = observation;
                else break;
            }

            start = base.date;
        }
    }

    const points = observations.filter(item => item.date >= start && item.date <= end);

    if (points.length < 2) {
        destroyChart(PROFILE_CHART_ID);
        setChartStatus("Not enough BID prices in this date range.");
        return;
    }

    setChartStatus("");

    const firstPoint = points[0];
    const lastPoint = points[points.length - 1];
    const change = ((lastPoint.bidPrice - firstPoint.bidPrice) / firstPoint.bidPrice) * 100;

    const summary = qs("#fund-chart-summary");

    if (summary) {
        summary.innerHTML = `
            ${escapeHtml(formatIsoDate(firstPoint.date))} – ${escapeHtml(formatIsoDate(lastPoint.date))}
            · <span class="${returnClass(change)}">${escapeHtml(formatPercent(change))}</span>
        `;
    }

    if (!window.Chart) {
        setChartStatus("Chart library unavailable.");
        return;
    }

    const style = getComputedStyle(document.documentElement);
    const css = (name, fallback) => style.getPropertyValue(name).trim() || fallback;

    const lineColor = css("--series-1", "#3987e5");
    const muted = css("--text-muted", "#8b98a5");
    const grid = css("--border-subtle", "rgba(255,255,255,0.08)");
    const surface = css("--bg-surface", "#101821");
    const text = css("--text-primary", "#edf2f6");
    const border = css("--border-medium", "#2a3947");
    const scale = getFontScale();

    const spanYears = (Date.parse(lastPoint.date) - Date.parse(firstPoint.date)) / (365.25 * 864e5);

    const crosshair = {
        id: "fundProfileCrosshair",
        afterDatasetsDraw(chart) {
            const active = chart.tooltip?.getActiveElements?.() ?? [];

            if (!active.length) return;

            const x = active[0].element.x;
            const { top, bottom } = chart.chartArea;

            chart.ctx.save();
            chart.ctx.beginPath();
            chart.ctx.moveTo(x, top);
            chart.ctx.lineTo(x, bottom);
            chart.ctx.lineWidth = 1;
            chart.ctx.strokeStyle = border;
            chart.ctx.stroke();
            chart.ctx.restore();
        }
    };

    createChart(PROFILE_CHART_ID, {
        type: "line",

        data: {
            labels: points.map(point => point.date),

            datasets: [
                {
                    label: "BID price",
                    data: points.map(point => point.bidPrice),
                    borderColor: lineColor,
                    backgroundColor: lineColor,
                    borderWidth: 2,
                    pointRadius: 0,
                    pointHoverRadius: 4,
                    pointHoverBorderColor: surface,
                    pointHoverBorderWidth: 2,
                    tension: 0
                }
            ]
        },

        plugins: [crosshair],

        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: false,

            interaction: { mode: "index", intersect: false },

            plugins: {
                legend: { display: false },

                tooltip: {
                    backgroundColor: surface,
                    titleColor: text,
                    bodyColor: text,
                    borderColor: border,
                    borderWidth: 1,
                    padding: 10,
                    displayColors: false,

                    callbacks: {
                        title: items => formatIsoDate(items[0]?.label),
                        label: item => {
                            const value = Number(item.raw);
                            const fromStart = ((value - firstPoint.bidPrice) / firstPoint.bidPrice) * 100;

                            return [
                                `BID ${value.toFixed(5)}`,
                                `${formatPercent(fromStart)} since ${formatIsoDate(firstPoint.date)}`
                            ];
                        }
                    }
                }
            },

            scales: {
                x: {
                    grid: { display: false },
                    border: { color: grid },

                    ticks: {
                        color: muted,
                        maxRotation: 0,
                        autoSkip: true,
                        maxTicksLimit: 6,
                        font: { size: Math.round(12 * scale) },

                        callback(value) {
                            const label = this.getLabelForValue(value);

                            if (!label) return "";

                            return spanYears > 2 ? label.slice(0, 4) : formatIsoDate(label);
                        }
                    }
                },

                y: {
                    grid: { color: grid },
                    border: { display: false },

                    ticks: {
                        color: muted,
                        maxTicksLimit: 5,
                        font: { size: Math.round(12 * scale) }
                    }
                }
            }
        }
    });
}

function bindChartControls(dialog) {
    dialog.querySelectorAll("[data-profile-range]").forEach(button => {
        button.addEventListener("click", () => {
            explorer.chart.range = button.dataset.profileRange;
            renderProfileChart();
        });
    });

    const fromInput = qs("#fund-chart-from", dialog);
    const toInput = qs("#fund-chart-to", dialog);

    fromInput?.addEventListener("change", () => {
        if (fromInput.value) explorer.chart.from = fromInput.value;
        renderProfileChart();
    });

    toInput?.addEventListener("change", () => {
        if (toInput.value) explorer.chart.to = toInput.value;
        renderProfileChart();
    });
}

function openProfile(id) {
    const row = explorer.rows.find(item => item.id === id);

    if (!row) return;

    explorer.profile.id = id;

    // New fund: reset the custom range, keep the chosen preset.
    explorer.chart.fundId = id;
    explorer.chart.from = null;
    explorer.chart.to = null;

    if (explorer.chart.range === "CUSTOM") explorer.chart.range = "1Y";

    const fund = row.fund;
    const details = fund.fund ?? {};
    const dialog = ensureDialog();

    dialog.innerHTML = `
        <div class="news-popup">

            <header class="news-popup-header">
                <div class="news-popup-meta">
                    <span class="news-source">${escapeHtml(row.code)}</span>
                    <span class="news-date">${escapeHtml(details.fundCurrency ?? "")}</span>
                </div>

                <div class="fund-popup-actions">
                    <button
                        type="button"
                        class="fund-watch-toggle${isWatched(id) ? " is-on" : ""}"
                        data-fund-watch="${escapeHtml(id)}"
                        aria-pressed="${isWatched(id)}"
                        title="Add to / remove from your Monitoring watchlist"
                    >${isWatched(id) ? "★ Watching" : "☆ Watch"}</button>

                    <button type="button" class="news-popup-close" aria-label="Close" title="Close" data-fund-close>×</button>
                </div>
            </header>

            <h2 id="fund-dialog-title" class="news-popup-title">${escapeHtml(row.name)}</h2>

            <div class="fund-popup-badge-row">

                <div class="news-card-badges news-popup-badges">
                    <span class="news-badge news-category">${escapeHtml(row.assetClass)}</span>
                    <span class="risk-pill risk-${row.riskOrder}">${escapeHtml(row.risk)}</span>
                    ${row.hasDividend ? `<span class="news-badge explorer-dividend-badge">Pays dividend</span>` : ""}
                </div>

                ${details.valuationDate ? `
                    <span class="fund-published-date">
                        Published by Prudential as at ${escapeHtml(details.valuationDate)}
                    </span>
                ` : ""}

            </div>

            <div class="news-popup-body">

                <div class="fund-facts">
                    ${fact("BID price", details.bidPrice)}
                    ${fact("Offer price", details.offerPrice)}
                    ${row.paymentModes.length ? `
                        <div class="fund-fact">
                            <span class="fund-fact-label">Payment mode</span>
                            <span class="fund-fact-value payment-chips">${paymentChips(row.paymentModes)}</span>
                        </div>
                    ` : ""}
                    ${details.hasDividend && Array.isArray(details.dividendHistory) && details.dividendHistory.length ? (() => {
                        const period = payoutPeriod(details.dividendHistory);
                        const months = period.label !== "Monthly" && period.label !== "Irregular" && period.months.length
                            ? ` (${period.months.map(month => MONTH_SHORT[month]).join(", ")})`
                            : "";

                        return fact("Payout frequency", period.label === "Not enough history" ? "One payout on record" : `${period.label}${months}`);
                    })() : ""}
                    ${fact("Valuation date", details.valuationDate)}
                    ${fact("Inception", details.inceptionDate)}
                    ${fact("Sub-class", details.assetSubClass)}
                    ${fact("Geography", row.geographies.join(", "))}
                    ${fact("Sector", row.sectors.join(", "))}
                </div>

                ${!isBlank(details.fundObjective) ? `
                    <section class="news-popup-section">
                        <h3 class="news-popup-label">Objective</h3>
                        <p>${escapeHtml(details.fundObjective)}</p>
                    </section>
                ` : ""}

                ${!isBlank(details.investmentManager) ? `
                    <section class="news-popup-section">
                        <h3 class="news-popup-label">Investment manager</h3>
                        <p>${escapeHtml(details.investmentManager)}</p>
                    </section>
                ` : ""}

                ${returnsTable(details)}

                ${chartSectionHtml()}

                ${holdingsSection(fund, row.holdings)}

                ${dividendSection(details)}

                ${documentsSection(fund)}

            </div>

        </div>
    `;

    qs("[data-fund-close]", dialog)?.addEventListener("click", () => dialog.close());

    bindChartControls(dialog);

    qs("[data-fund-watch]", dialog)?.addEventListener("click", event => {
        // The watchlist listener updates this button and the list stars.
        toggleWatchlist(event.currentTarget.dataset.fundWatch);
    });

    document.body.classList.add("has-news-dialog");

    if (!dialog.open) dialog.showModal();

    qs(".news-popup-body", dialog)?.scrollTo(0, 0);

    requestAnimationFrame(renderProfileChart);
}


/* ============================================================
   EVENTS
   ============================================================ */

function bindEvents() {
    bindHoldingPicker();

    const filterMap = {
        "#explorer-search": "search",
        "#explorer-holding": "holding",
        "#explorer-asset": "assetClass",
        "#explorer-risk": "risk",
        "#explorer-geography": "geography",
        "#explorer-sector": "sector",
        "#explorer-dividend": "dividend",
        "#explorer-payment": "payment"
    };

    for (const [selector, key] of Object.entries(filterMap)) {
        const control = qs(selector);

        if (!control) continue;

        const update = () => {
            explorer.filters[key] = control.tagName === "SELECT"
                ? selectedValues(control)
                : control.value ?? "";
            renderTable();
        };

        control.addEventListener(control.tagName === "SELECT" ? "change" : "input", update);
    }

    qs("#explorer-clear")?.addEventListener("click", () => {
        for (const [selector, key] of Object.entries(filterMap)) {
            const control = qs(selector);
            const isSelect = control?.tagName === "SELECT";

            if (control) control.value = isSelect ? "ALL" : "";

            explorer.filters[key] = isSelect ? [] : "";
        }

        renderTable();
    });

    qs("#explorer-sort-mobile")?.addEventListener("change", event => {
        const [key, direction] = event.target.value.split(":");

        if (!key) return;

        explorer.sort.key = key;
        explorer.sort.direction = direction === "desc" ? "desc" : "asc";
        renderTable();
    });

    document.querySelectorAll("[data-explorer-sort]").forEach(header => {
        const activate = () => {
            const key = header.dataset.explorerSort;

            if (explorer.sort.key === key) {
                explorer.sort.direction = explorer.sort.direction === "asc" ? "desc" : "asc";
            } else {
                explorer.sort.key = key;
                // numbers: best first; text: A-Z
                explorer.sort.direction = ["name", "code", "asset", "risk"].includes(key) ? "asc" : "desc";
            }

            renderTable();
        };

        header.addEventListener("click", activate);

        header.addEventListener("keydown", event => {
            if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                activate();
            }
        });
    });

    const body = qs("#explorer-table-body");

    body?.addEventListener("click", event => {
        // Star: add / remove from the watchlist without opening the popup
        const star = event.target.closest("[data-explorer-watch]");

        if (star) {
            event.stopPropagation();
            toggleWatchlist(star.dataset.explorerWatch);
            return;
        }

        const row = event.target.closest("[data-fund-open]");

        if (row) openProfile(row.dataset.fundOpen);
    });

    onWatchlistChange(syncWatchButtons);

    body?.addEventListener("keydown", event => {
        if (event.key !== "Enter" && event.key !== " ") return;

        if (event.target.closest("[data-explorer-watch]")) return;

        const row = event.target.closest("[data-fund-open]");

        if (row) {
            event.preventDefault();
            openProfile(row.dataset.fundOpen);
        }
    });
}


/* ============================================================
   PUBLIC API
   ============================================================ */

/*
 * "Data updated" in the page header: when funds.json was
 * built (shown in Singapore time), plus Prudential's
 * valuation date for the prices.
 */
function renderUpdated(generatedAtUtc) {
    const updated = qs("#explorer-updated");
    const valuation = qs("#explorer-valuation");

    if (updated) {
        const date = generatedAtUtc ? new Date(generatedAtUtc) : null;

        updated.textContent = date && !Number.isNaN(date.getTime())
            ? date.toLocaleString("en-SG", {
                timeZone: "Asia/Singapore",
                day: "2-digit",
                month: "short",
                year: "numeric",
                hour: "2-digit",
                minute: "2-digit"
            }) + " SGT"
            : "—";
    }

    if (valuation) {
        const dates = [...new Set(
            explorer.rows
                .map(row => row.valuationDate)
                .filter(Boolean)
        )];

        valuation.textContent = dates.length === 1
            ? `Prices as at ${dates[0]}`
            : dates.length
                ? `Prices as at ${dates.sort().pop()} (latest)`
                : "";
    }
}

function initializeFundExplorer({ funds, generatedAtUtc = null }) {
    explorer.funds = Array.isArray(funds) ? funds : [];
    explorer.rows = explorer.funds.map(buildRow).filter(row => row.id);

    renderFilterOptions();

    renderUpdated(generatedAtUtc);

    if (!explorer.initialized) {
        bindEvents();
        explorer.initialized = true;
    }

    renderTable();
}

/**
 * Called once bid_history.json has loaded (shared with Market
 * Performance). Redraws the chart if a profile is open.
 */
function setFundExplorerHistory(historyIndex) {
    explorer.historyIndex = historyIndex ?? null;

    renderProfileChart();
}

/* Redraw the open profile chart (theme / text size change). */
function refreshFundExplorerChart() {
    renderProfileChart();
}

export {
    initializeFundExplorer,
    setFundExplorerHistory,
    refreshFundExplorerChart,
    openProfile as openFundProfile
};
