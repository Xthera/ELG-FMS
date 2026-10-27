/* ============================================================
   ELG FMS — MARKET INDICES
   ============================================================

   data/indices.json (written daily by scripts/fetch_indices.py)
   holds each index's daily closing levels. This module:

   - loads it (a missing file is not an error: the site shows
     "Index data isn't available yet");
   - converts each index into the same shape as a fund record,
     so the comparison chart, Fund Explorer and Monitoring can
     reuse their fund code (the "BID" of an index is its close);
   - renders the Indices section of Market Performance;
   - handles the "Prudential Funds | Indices" selector on Market
     Performance and Monitoring (remembered in this browser).
   ============================================================ */

import {
    calculateAllPerformance,
    formatReturnPercent,
    formatDisplayDate
} from "./performance.js";


const DATA_PATH = "data/indices.json";

const DATASET_KEY_PREFIX = "vgrat-fms-dataset-";

const PERIODS = ["DD", "WW", "MM", "YY", "SI"];

const DEFAULT_PERIOD = "MM";


const state = {
    records: [],
    history: [],
    historyIndex: new Map(),
    byId: new Map(),
    performance: null,
    period: DEFAULT_PERIOD,
    tabsBound: false
};


/* ---------- helpers ---------- */

const qs = (selector, root = document) => root.querySelector(selector);

function escapeHtml(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

function setText(selector, text) {
    const element = qs(selector);

    if (element) element.textContent = text;
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

/* 5422.16 -> "5,422.16" */
function formatLevel(value) {
    const number = Number(value);

    return Number.isFinite(number)
        ? number.toLocaleString("en-SG", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
        : "—";
}

function percentText(value) {
    return value === null || value === undefined || !Number.isFinite(Number(value))
        ? "-"
        : `${Number(value).toFixed(2)}%`;
}

/* "2026-10-23" -> "23/10/2026" (same as Prudential's valuation dates) */
function slashDate(iso) {
    const [year, month, day] = String(iso ?? "").split("-");

    return year ? `${day}/${month}/${year}` : "";
}

/* "2000-01-03" -> "03-Jan-2000" */
function dashDate(iso) {
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const [year, month, day] = String(iso ?? "").split("-");

    return year ? `${day}-${months[Number(month) - 1]}-${year}` : "";
}


/* ============================================================
   DATA
   ============================================================ */

/* An index in the shape of a funds.json record */
function toFundRecord(index) {
    const r = index.returns ?? {};

    return {
        isIndex: true,
        fundIdentifier: index.id,
        fundCode: index.code,
        fundName: index.name,
        pruAccessName: index.symbol,
        prudentialUrl: null,
        indexSymbol: index.symbol,
        indexSource: index.source,
        indexExchange: index.exchange,
        fund: {
            fundCurrency: index.currency,
            unitCurrency: index.currency,
            assetClass: index.region || "Global",
            assetSubClass: index.region || null,
            riskClassification: null,
            bidPrice: formatLevel(index.latestClose),
            offerPrice: null,
            valuationDate: slashDate(index.latestDate),
            inceptionDate: dashDate(index.firstDate),
            cumulativeYtd: percentText(r.ytd),
            cumulative1m: percentText(r.m1),
            cumulative3m: percentText(r.m3),
            cumulative6m: percentText(r.m6),
            cumulative1y: percentText(r.y1),
            cumulative3y: percentText(r.y3),
            cumulative5y: percentText(r.y5),
            annualised3y: percentText(r.a3),
            annualised5y: percentText(r.a5),
            annualised10y: percentText(r.a10),
            annualisedSinceLaunch: percentText(r.sinceStart),
            fundObjective: index.description || null,
            investmentManager: null,
            hasDividend: false,
            dividendHistory: [],
            paymentModes: []
        },
        research: {
            geographic1: index.region || null,
            geographic2: null,
            sector1: null,
            sector2: null
        },
        topHoldings: { status: "index", holdings: [] },
        updateStatus: index.updateStatus ?? null
    };
}

async function loadIndices() {
    try {
        const response = await fetch(DATA_PATH, { cache: "no-cache" });

        if (!response.ok) return null;

        const data = await response.json();

        return Array.isArray(data?.indices) ? data : null;
    } catch (error) {
        console.warn("ELG FMS: index data not available.", error);
        return null;
    }
}

/* Build the shared records once the file has loaded */
function setIndexData(data) {
    const indices = Array.isArray(data?.indices) ? data.indices : [];

    state.records = indices
        .filter(index => index?.id && Array.isArray(index.observations) && index.observations.length)
        .map(toFundRecord)
        .sort((a, b) => String(a.fundName).localeCompare(String(b.fundName)));

    state.byId = new Map(state.records.map(record => [record.fundIdentifier, record]));

    state.historyIndex = new Map();
    state.history = [];

    for (const index of indices) {
        if (!state.byId.has(index.id)) continue;

        const observations = index.observations
            .map(([date, close]) => ({ date, bidPrice: Number(close) }))
            .filter(item => item.date && Number.isFinite(item.bidPrice) && item.bidPrice > 0);

        state.historyIndex.set(index.id, observations);
        state.history.push({ fundIdentifier: index.id, fundCode: index.code, bidHistory: { observations } });
    }

    return {
        records: state.records,
        historyIndex: state.historyIndex,
        generatedAtUtc: data?.generatedAtUtc ?? null,
        source: data?.source ?? "",
        sourceNote: data?.sourceNote ?? ""
    };
}


/* ============================================================
   MARKET PERFORMANCE: INDICES SECTION
   ============================================================ */

function renderTable(selector, rows, emptyMessage) {
    const body = qs(selector);

    if (!body) return;

    if (!rows?.length) {
        body.innerHTML = `<tr><td colspan="5" class="empty-state">${escapeHtml(emptyMessage)}</td></tr>`;
        return;
    }

    body.innerHTML = rows
        .map((row, position) => {
            const record = state.byId.get(row.fundIdentifier);
            const value = Number(row.returnPercent);

            return `
                <tr class="performance-row" data-fund-identifier="${escapeHtml(row.fundIdentifier)}">
                    <td class="rank-cell">${position + 1}</td>
                    <td class="fund-cell">
                        <div class="fund-name">${escapeHtml(row.fundName)}</div>
                        <div class="fund-meta">${escapeHtml([record?.fund?.assetSubClass, record?.fund?.fundCurrency].filter(Boolean).join(" · "))}</div>
                    </td>
                    <td class="fund-code-cell">${escapeHtml(row.fundCode ?? "—")}</td>
                    <td class="return-cell ${value >= 0 ? "return-positive" : "return-negative"}" data-label="Return">
                        <span class="return-pill">${formatReturnPercent(value)}</span>
                    </td>
                    <td class="bid-cell" data-label="Level">${escapeHtml(formatLevel(row.currentBid))}</td>
                </tr>
            `;
        })
        .join("");
}

function renderPerformance() {
    const performance = state.performance?.[state.period] ?? null;

    document.querySelectorAll("[data-index-period]").forEach(button => {
        const active = button.dataset.indexPeriod === state.period;

        button.classList.toggle("active", active);
        button.setAttribute("aria-selected", String(active));
    });

    if (!performance) {
        setText("#index-eligible-count", "—");
        setText("#index-eligible-meta", state.records.length ? "No valid comparison" : "No index data yet");
        ["#index-top-winner-return", "#index-top-winner-name", "#index-top-loser-return", "#index-top-loser-name"].forEach(id => setText(id, "—"));
        setText("#index-as-of", "Latest close: —");
        setText("#index-target-date", "Comparison target: —");
        renderTable("#index-winners-table-body", [], "No index data available.");
        renderTable("#index-losers-table-body", [], "No index data available.");
        return;
    }


    setText("#index-eligible-count", String(performance.totalEligibleFunds));
    setText("#index-eligible-meta", `${performance.totalEligibleFunds} indices with valid comparison data`);
    setText("#index-as-of", `Latest close: ${formatDisplayDate(performance.asOfDate)}`);
    setText(
        "#index-target-date",
        performance.type === "inception"
            ? "Compared with each index's first close on record"
            : `Comparison target: ${formatDisplayDate(performance.targetDate)}`
    );

    const winner = performance.winners?.[0];
    const loser = performance.losers?.[0];

    setText("#index-top-winner-return", winner ? formatReturnPercent(winner.returnPercent) : "—");
    setText("#index-top-winner-name", winner?.fundName ?? "No valid result");
    setText("#index-top-loser-return", loser ? formatReturnPercent(loser.returnPercent) : "—");
    setText("#index-top-loser-name", loser?.fundName ?? "No valid result");

    setText("#index-winners-title", `Top ${performance.winners.length || 10} Performer`);
    setText("#index-losers-title", `Lower ${performance.losers.length || 10} Performer`);

    renderTable("#index-winners-table-body", performance.winners, "No valid result for this period.");
    renderTable("#index-losers-table-body", performance.losers, "No valid result for this period.");
}

function bindTabs() {
    if (state.tabsBound) return;

    state.tabsBound = true;

    document.querySelectorAll("[data-index-period]").forEach(button => {
        button.addEventListener("click", () => {
            if (!PERIODS.includes(button.dataset.indexPeriod)) return;

            state.period = button.dataset.indexPeriod;
            renderPerformance();
        });
    });
}

function initializeIndexPerformance(info) {
    bindTabs();

    const available = state.records.length > 0;

    const unavailable = qs("#index-unavailable");

    if (unavailable) unavailable.hidden = available;

    state.performance = available
        ? calculateAllPerformance(state.records, state.history, 10, state.historyIndex)
        : null;

    // Most recent close across all indices, for the page header
    const latest = state.history
        .map(record => record.bidHistory.observations.at(-1)?.date)
        .filter(Boolean)
        .sort()
        .pop();

    setText("#index-latest-close-date", latest ? formatDisplayDate(latest) : "—");

    const note = qs("#index-source-note");

    if (note) {
        note.textContent = available
            ? `Source: ${info?.source || "public market data"}. ${info?.sourceNote || ""} Index levels are not fund prices and exclude dividends.`.trim()
            : "";
    }

    renderPerformance();
}


/* ============================================================
   PRUDENTIAL FUNDS / INDICES SELECTOR
   Market Performance and Monitoring show one data set at a time,
   chosen with the "Prudential Funds | Indices" tabs (remembered
   per page in this browser), like the Fund Explorer.
   ============================================================ */

function showDataset(container, dataset) {
    container.querySelectorAll("[data-market-block]").forEach(block => {
        block.hidden = block.dataset.marketBlock !== dataset;
    });

    // Page header facts that belong to one data set (e.g. "Latest BID
    // observation" for funds, "Latest index close" for indices)
    container.closest(".page-view")?.querySelectorAll("[data-header-for]").forEach(element => {
        element.hidden = element.dataset.headerFor !== dataset;
    });

    container.querySelectorAll("[data-market-dataset]").forEach(button => {
        const active = button.dataset.marketDataset === dataset;

        button.classList.toggle("active", active);
        button.setAttribute("aria-selected", String(active));
    });
}

function initializeDatasetTabs(onChange = () => {}) {
    document.querySelectorAll("[data-market-blocks]").forEach(container => {
        if (container.dataset.tabsBound === "true") return;

        container.dataset.tabsBound = "true";

        const key = DATASET_KEY_PREFIX + container.dataset.marketBlocks;
        const saved = readStorage(key);

        showDataset(container, saved === "indices" ? "indices" : "funds");

        container.addEventListener("click", event => {
            const button = event.target.closest("[data-market-dataset]");

            if (!button || !container.contains(button)) return;

            const dataset = button.dataset.marketDataset === "indices" ? "indices" : "funds";

            writeStorage(key, dataset);
            showDataset(container, dataset);

            // Charts drawn while their section was hidden need redrawing
            requestAnimationFrame(() => onChange(dataset));
        });
    });
}


export {
    loadIndices,
    setIndexData,
    initializeIndexPerformance,
    initializeDatasetTabs,
    formatLevel
};
