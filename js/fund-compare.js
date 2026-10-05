/* ============================================================
   VGRAT FMS — FUND COMPARISON CHART
   ============================================================

   Interactive line chart that compares the BID price path of
   up to 8 selected funds, rebased to 100 at the start of the
   chosen range so funds with different prices are comparable.

   Ranges: 1M · 3M · 6M · 1Y · 3Y · 5Y · 10Y · Since Inception

   - Each fund keeps its colour while selected (colour follows
     the fund, never its position).
   - Base value = latest actual BID on or before the range
     start. Funds younger than the range start from their
     first BID on record (flagged in the table).
   - The table under the chart is the legend and the
     accessible data view.
   ============================================================ */

import {
    createChart,
    destroyChart
} from "./charts.js";


/* ============================================================
   CONSTANTS
   ============================================================ */

const CANVAS_ID = "fund-compare-chart";

const MAX_FUNDS = 8;

const MAX_POINTS = 600;

const STORAGE_KEYS = {
    funds: "vgrat-fms-compare-funds",
    range: "vgrat-fms-compare-range"
};

const RANGES = {
    "1M": { label: "1M", description: "1 month", months: 1 },
    "3M": { label: "3M", description: "3 months", months: 3 },
    "6M": { label: "6M", description: "6 months", months: 6 },
    "1Y": { label: "1Y", description: "1 year", months: 12 },
    "3Y": { label: "3Y", description: "3 years", months: 36 },
    "5Y": { label: "5Y", description: "5 years", months: 60 },
    "10Y": { label: "10Y", description: "10 years", months: 120 },
    "SI": { label: "SI", description: "Since inception", months: null }
};

const DEFAULT_RANGE = "1Y";


/* ============================================================
   STATE
   ============================================================ */

const compare = {
    initialized: false,
    funds: [],
    index: new Map(),
    fundById: new Map(),
    selected: [],          // [{ id, slot }]
    range: DEFAULT_RANGE,
    rows: []
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
        // Ignore storage failures.
    }
}

function getCssVariable(name, fallback) {
    const value = getComputedStyle(document.documentElement)
        .getPropertyValue(name)
        .trim();

    return value || fallback;
}

function seriesColor(slot) {
    return getCssVariable(`--series-${slot + 1}`, "#3987e5");
}

function fundId(fund) {
    return String(
        fund?.fundIdentifier ??
        fund?.fundCode ??
        fund?.excelRow ??
        fund?.fundName ??
        ""
    );
}

/*
 * Subtract whole months from an ISO date (UTC, clamped to
 * month end so 31 Mar - 1M = 28/29 Feb).
 */
function subtractMonths(isoDate, months) {
    const [year, month, day] = isoDate.split("-").map(Number);

    const target = new Date(Date.UTC(year, month - 1 - months, 1));

    const lastDay = new Date(Date.UTC(
        target.getUTCFullYear(),
        target.getUTCMonth() + 1,
        0
    )).getUTCDate();

    target.setUTCDate(Math.min(day, lastDay));

    return target.toISOString().slice(0, 10);
}

function lastIndexOnOrBefore(observations, date) {
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

function formatDate(isoDate, withYear = true) {
    if (!isoDate) {
        return "—";
    }

    const [year, month, day] = isoDate.split("-").map(Number);

    return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString(
        "en-SG",
        withYear
            ? { timeZone: "UTC", day: "2-digit", month: "short", year: "numeric" }
            : { timeZone: "UTC", day: "2-digit", month: "short" }
    );
}

function formatPercent(value) {
    if (!Number.isFinite(value)) {
        return "—";
    }

    const sign = value > 0 ? "+" : "";

    return `${sign}${value.toFixed(2)}%`;
}


/* ============================================================
   SELECTION
   ============================================================ */

function nextFreeSlot() {
    const used = new Set(compare.selected.map(item => item.slot));

    for (let slot = 0; slot < MAX_FUNDS; slot += 1) {
        if (!used.has(slot)) {
            return slot;
        }
    }

    return -1;
}

function isSelected(id) {
    return compare.selected.some(item => item.id === id);
}

function addFund(id) {
    if (
        !id ||
        isSelected(id) ||
        !compare.index.has(id) ||
        compare.selected.length >= MAX_FUNDS
    ) {
        return;
    }

    compare.selected.push({ id, slot: nextFreeSlot() });

    persistSelection();
    render();
}

function removeFund(id) {
    compare.selected = compare.selected.filter(item => item.id !== id);

    persistSelection();
    render();
}

function persistSelection() {
    writeStorage(
        STORAGE_KEYS.funds,
        JSON.stringify(compare.selected.map(item => item.id))
    );
}

function setRange(range) {
    compare.range = RANGES[range] ? range : DEFAULT_RANGE;

    writeStorage(STORAGE_KEYS.range, compare.range);

    document
        .querySelectorAll("[data-compare-range]")
        .forEach(button => {
            const active = button.dataset.compareRange === compare.range;

            button.classList.toggle("active", active);
            button.setAttribute("aria-selected", String(active));
        });

    render();
}


/* ============================================================
   SERIES CONSTRUCTION
   ============================================================ */

function buildSeries() {
    const selected = compare.selected
        .map(item => ({
            ...item,
            fund: compare.fundById.get(item.id),
            observations: compare.index.get(item.id) ?? []
        }))
        .filter(item => item.fund && item.observations.length > 0);

    if (selected.length === 0) {
        return { labels: [], series: [], startDate: null, endDate: null };
    }

    const endDate = selected
        .map(item => item.observations[item.observations.length - 1].date)
        .sort()
        .pop();

    const range = RANGES[compare.range];

    const startDate = range.months === null
        ? null
        : subtractMonths(endDate, range.months);

    const series = selected.map(item => {
        const observations = item.observations;

        let baseIndex = 0;
        let partial = false;

        if (startDate) {
            baseIndex = lastIndexOnOrBefore(observations, startDate);

            if (baseIndex === -1) {
                baseIndex = 0;
                partial = true;
            }
        }

        const endIndex = lastIndexOnOrBefore(observations, endDate);

        const windowObs = observations.slice(baseIndex, endIndex + 1);

        const baseBid = windowObs[0]?.bidPrice ?? null;

        const points = new Map();

        for (const observation of windowObs) {
            points.set(observation.date, {
                bid: observation.bidPrice,
                value: (observation.bidPrice / baseBid) * 100
            });
        }

        const first = windowObs[0] ?? null;
        const last = windowObs[windowObs.length - 1] ?? null;

        return {
            id: item.id,
            slot: item.slot,
            fund: item.fund,
            points,
            partial: startDate ? partial : false,
            baseDate: first?.date ?? null,
            baseBid,
            lastDate: last?.date ?? null,
            lastBid: last?.bidPrice ?? null,
            change: first && last
                ? ((last.bidPrice - first.bidPrice) / first.bidPrice) * 100
                : null
        };
    });

    /*
     * Shared date axis (union of every fund's dates), thinned
     * for long ranges so the chart stays fast. The final date
     * is always kept.
     */
    const allDates = new Set();

    for (const item of series) {
        for (const date of item.points.keys()) {
            allDates.add(date);
        }
    }

    let labels = [...allDates].sort();

    if (labels.length > MAX_POINTS) {
        const step = Math.ceil(labels.length / MAX_POINTS);
        const lastLabel = labels[labels.length - 1];

        /*
         * Always keep every fund's first and last point so each
         * line starts exactly at 100 and ends at its latest BID.
         */
        const required = new Set([lastLabel]);

        for (const item of series) {
            if (item.baseDate) required.add(item.baseDate);
            if (item.lastDate) required.add(item.lastDate);
        }

        labels = labels.filter(
            (date, position) => position % step === 0 || required.has(date)
        );
    }

    return { labels, series, startDate, endDate };
}


/* ============================================================
   CHART
   ============================================================ */

const crosshairPlugin = {
    id: "vgratCrosshair",

    afterDatasetsDraw(chart) {
        const active = chart.tooltip?.getActiveElements?.() ?? [];

        if (!active.length) {
            return;
        }

        const x = active[0].element.x;
        const { top, bottom } = chart.chartArea;
        const context = chart.ctx;

        context.save();
        context.beginPath();
        context.moveTo(x, top);
        context.lineTo(x, bottom);
        context.lineWidth = 1;
        context.strokeStyle = getCssVariable("--border-medium", "rgba(128,128,128,0.4)");
        context.stroke();
        context.restore();
    }
};

function renderChart(model) {
    const canvasWrap = qs("#fund-compare-canvas-wrap");
    const empty = qs("#fund-compare-empty");

    if (!model.series.length) {
        destroyChart(CANVAS_ID);

        if (canvasWrap) canvasWrap.hidden = true;
        if (empty) empty.hidden = false;

        return;
    }

    if (canvasWrap) canvasWrap.hidden = false;
    if (empty) empty.hidden = true;

    if (!window.Chart) {
        return;
    }

    const text = getCssVariable("--text-primary", "#e6edf3");
    const muted = getCssVariable("--text-muted", "#8b98a5");
    const grid = getCssVariable("--border-subtle", "rgba(255,255,255,0.08)");
    const surface = getCssVariable("--bg-surface", "#101821");
    const border = getCssVariable("--border-medium", "rgba(255,255,255,0.15)");

    const { labels, series } = model;

    const spanYears =
        labels.length > 1
            ? (Date.parse(labels[labels.length - 1]) - Date.parse(labels[0])) /
              (365.25 * 24 * 3600 * 1000)
            : 0;

    const datasets = series.map(item => {
        const color = seriesColor(item.slot);

        return {
            label: item.fund.fundName ?? item.id,
            data: labels.map(date => item.points.get(date)?.value ?? null),
            borderColor: color,
            backgroundColor: color,
            borderWidth: 2,
            pointRadius: 0,
            pointHoverRadius: 4,
            pointHoverBorderWidth: 2,
            pointHoverBorderColor: surface,
            spanGaps: true,
            tension: 0
        };
    });

    createChart(CANVAS_ID, {
        type: "line",

        data: { labels, datasets },

        plugins: [crosshairPlugin],

        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: false,

            interaction: {
                mode: "index",
                intersect: false
            },

            plugins: {
                legend: {
                    display: false
                },

                tooltip: {
                    backgroundColor: surface,
                    titleColor: text,
                    bodyColor: text,
                    borderColor: border,
                    borderWidth: 1,
                    padding: 10,
                    boxPadding: 4,
                    usePointStyle: true,

                    filter: item => item.raw !== null && item.raw !== undefined,

                    itemSort: (a, b) => b.raw - a.raw,

                    callbacks: {
                        title: items => formatDate(items[0]?.label),

                        label: item => {
                            const source = series[item.datasetIndex];
                            const point = source.points.get(item.label);
                            const change = item.raw - 100;
                            const name = source.fund.fundCode || source.id;
                            const bid = point ? ` · BID ${point.bid.toFixed(5)}` : "";

                            return ` ${name}  ${formatPercent(change)}${bid}`;
                        },

                        labelPointStyle: () => ({
                            pointStyle: "circle",
                            rotation: 0
                        })
                    }
                }
            },

            scales: {
                x: {
                    grid: {
                        display: false
                    },

                    border: {
                        color: grid
                    },

                    ticks: {
                        color: muted,
                        maxRotation: 0,
                        autoSkip: true,
                        maxTicksLimit: 7,
                        font: { size: 10 },

                        callback(value) {
                            const label = this.getLabelForValue(value);

                            if (!label) return "";

                            if (spanYears > 2) {
                                return label.slice(0, 4);
                            }

                            return formatDate(label, spanYears > 0.9);
                        }
                    }
                },

                y: {
                    grid: {
                        color: grid
                    },

                    border: {
                        display: false
                    },

                    ticks: {
                        color: muted,
                        font: { size: 10 },
                        maxTicksLimit: 6,
                        callback: value => formatPercent(Number(value) - 100)
                    }
                }
            }
        }
    });
}


/* ============================================================
   TABLE (legend + data view)
   ============================================================ */

function renderTable(model) {
    const body = qs("#fund-compare-table-body");

    if (!body) {
        return;
    }

    if (!model.series.length) {
        body.innerHTML = "";
        return;
    }

    body.innerHTML = model.series
        .map(item => {
            const color = seriesColor(item.slot);
            const changeClass = item.change >= 0 ? "return-positive" : "return-negative";

            const since = item.partial
                ? `<span class="compare-partial" title="This fund's price history starts after the range start">from ${escapeHtml(formatDate(item.baseDate))}</span>`
                : escapeHtml(formatDate(item.baseDate));

            return `
                <tr>
                    <td>
                        <div class="compare-fund-cell">
                            <span class="compare-swatch" style="background:${color}"></span>
                            <span class="compare-fund-name">${escapeHtml(item.fund.fundName ?? item.id)}</span>
                        </div>
                    </td>
                    <td class="fund-code-cell">${escapeHtml(item.fund.fundCode ?? "—")}</td>
                    <td>${since}</td>
                    <td class="return-cell ${changeClass}">${escapeHtml(formatPercent(item.change))}</td>
                    <td class="bid-cell">${item.lastBid !== null ? item.lastBid.toFixed(5) : "—"}</td>
                    <td class="compare-remove-cell">
                        <button
                            type="button"
                            class="compare-remove"
                            data-remove-fund="${escapeHtml(item.id)}"
                            aria-label="Remove ${escapeHtml(item.fund.fundName ?? item.id)}"
                            title="Remove"
                        >×</button>
                    </td>
                </tr>
            `;
        })
        .join("");
}


/* ============================================================
   PICKER
   ============================================================ */

function renderPickerState() {
    const input = qs("#fund-compare-search");
    const count = qs("#fund-compare-count");

    const full = compare.selected.length >= MAX_FUNDS;

    if (input) {
        input.disabled = full;
        input.placeholder = full
            ? `Maximum ${MAX_FUNDS} funds — remove one to add another`
            : "Add a fund to compare…";
    }

    if (count) {
        count.textContent = `${compare.selected.length} / ${MAX_FUNDS} funds`;
    }
}

function getMatches(term) {
    const query = term.trim().toLowerCase();

    return compare.funds
        .filter(fund => {
            const id = fundId(fund);

            if (isSelected(id) || !compare.index.has(id)) {
                return false;
            }

            if (!query) {
                return true;
            }

            return (
                String(fund.fundName ?? "").toLowerCase().includes(query) ||
                String(fund.fundCode ?? "").toLowerCase().includes(query)
            );
        })
        .slice(0, 50);
}

function renderSuggestions() {
    const input = qs("#fund-compare-search");
    const list = qs("#fund-compare-suggestions");

    if (!input || !list) {
        return;
    }

    const matches = getMatches(input.value);

    if (!matches.length) {
        list.innerHTML = `<li class="compare-suggestion-empty">No matching funds</li>`;
    } else {
        list.innerHTML = matches
            .map((fund, position) => `
                <li
                    class="compare-suggestion${position === 0 ? " is-highlighted" : ""}"
                    role="option"
                    data-add-fund="${escapeHtml(fundId(fund))}"
                >
                    <span class="compare-suggestion-name">${escapeHtml(fund.fundName ?? "")}</span>
                    <span class="compare-suggestion-code">${escapeHtml(fund.fundCode ?? "")}</span>
                </li>
            `)
            .join("");
    }

    list.hidden = false;
    input.setAttribute("aria-expanded", "true");
}

function closeSuggestions() {
    const input = qs("#fund-compare-search");
    const list = qs("#fund-compare-suggestions");

    if (list) list.hidden = true;
    if (input) input.setAttribute("aria-expanded", "false");
}

function moveHighlight(direction) {
    const items = [...document.querySelectorAll("#fund-compare-suggestions .compare-suggestion")];

    if (!items.length) {
        return;
    }

    let current = items.findIndex(item => item.classList.contains("is-highlighted"));

    items[current]?.classList.remove("is-highlighted");

    current = (current + direction + items.length) % items.length;

    items[current].classList.add("is-highlighted");
    items[current].scrollIntoView({ block: "nearest" });
}

function bindEvents() {
    const input = qs("#fund-compare-search");
    const list = qs("#fund-compare-suggestions");
    const table = qs("#fund-compare-table-body");

    document
        .querySelectorAll("[data-compare-range]")
        .forEach(button => {
            button.addEventListener("click", () => setRange(button.dataset.compareRange));
        });

    if (input) {
        input.addEventListener("focus", renderSuggestions);
        input.addEventListener("input", renderSuggestions);

        input.addEventListener("keydown", event => {
            if (event.key === "ArrowDown") {
                event.preventDefault();
                moveHighlight(1);
            } else if (event.key === "ArrowUp") {
                event.preventDefault();
                moveHighlight(-1);
            } else if (event.key === "Enter") {
                event.preventDefault();

                const highlighted = qs("#fund-compare-suggestions .is-highlighted");

                if (highlighted) {
                    addFund(highlighted.dataset.addFund);
                    input.value = "";
                    renderSuggestions();
                }
            } else if (event.key === "Escape") {
                closeSuggestions();
                input.blur();
            }
        });
    }

    if (list) {
        /*
         * mousedown (not click) so the choice registers before
         * the input loses focus and closes the list.
         */
        list.addEventListener("mousedown", event => {
            const item = event.target.closest("[data-add-fund]");

            if (!item) {
                return;
            }

            event.preventDefault();

            addFund(item.dataset.addFund);

            if (input) {
                input.value = "";
            }

            if (compare.selected.length >= MAX_FUNDS) {
                closeSuggestions();
            } else {
                renderSuggestions();
            }
        });
    }

    document.addEventListener("click", event => {
        if (!event.target.closest(".compare-picker")) {
            closeSuggestions();
        }
    });

    if (table) {
        table.addEventListener("click", event => {
            const button = event.target.closest("[data-remove-fund]");

            if (button) {
                removeFund(button.dataset.removeFund);
            }
        });
    }
}


/* ============================================================
   RENDER
   ============================================================ */

function render() {
    if (!compare.initialized) {
        return;
    }

    const model = buildSeries();

    compare.rows = model.series;

    const rangeLabel = qs("#fund-compare-range-label");

    if (rangeLabel) {
        const range = RANGES[compare.range];

        rangeLabel.textContent = model.endDate
            ? range.months === null
                ? `Since inception · to ${formatDate(model.endDate)}`
                : `${formatDate(model.startDate)} – ${formatDate(model.endDate)}`
            : "";
    }

    renderPickerState();
    renderChart(model);
    renderTable(model);
}


/* ============================================================
   PUBLIC API
   ============================================================ */

/**
 * @param {object}   options
 * @param {Array}    options.funds          fund records (funds.json)
 * @param {Map}      options.historyIndex   id -> sorted [{date, bidPrice}]
 * @param {string[]} options.defaultFundIds used when nothing is saved
 */
function initializeFundCompare({ funds, historyIndex, defaultFundIds = [] }) {
    compare.funds = [...(funds ?? [])].sort((a, b) =>
        String(a.fundName ?? "").localeCompare(String(b.fundName ?? ""))
    );

    compare.index = historyIndex ?? new Map();

    compare.fundById = new Map(compare.funds.map(fund => [fundId(fund), fund]));

    let savedIds = [];

    try {
        savedIds = JSON.parse(readStorage(STORAGE_KEYS.funds) ?? "[]");
    } catch {
        savedIds = [];
    }

    const initialIds = (Array.isArray(savedIds) && savedIds.length ? savedIds : defaultFundIds)
        .filter(id => compare.index.has(id) && compare.fundById.has(id))
        .slice(0, MAX_FUNDS);

    compare.selected = initialIds.map((id, slot) => ({ id, slot }));

    if (!compare.initialized) {
        bindEvents();
    }

    compare.initialized = true;

    setRange(readStorage(STORAGE_KEYS.range) ?? DEFAULT_RANGE);
}

function refreshFundCompare() {
    render();
}

export {
    initializeFundCompare,
    refreshFundCompare
};
