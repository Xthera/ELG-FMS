/* ============================================================
   VGRAT FMS — FUND EXPLORER
   ============================================================

   1. Fund list    searchable, sortable table of every fund
                   with filters (asset class, risk, geography,
                   sector, dividend) and a "holds company"
                   search across top-10 holdings.
   2. Profile      click a fund for a popup with its facts,
                   objective, Prudential's published returns,
                   top holdings, dividends and documents.

   Data source: data/funds.json ONLY (no BID history). Returns
   are Prudential's published figures as at the fund's
   valuation date.
   ============================================================ */

const PRUDENTIAL_ORIGIN = "https://www.prudential.com.sg";

const RISK_ORDER = {
    "Lower Risk": 1,
    "Low to Medium Risk": 2,
    "Medium to High Risk": 3,
    "Higher Risk": 4
};

const explorer = {
    initialized: false,
    funds: [],
    rows: [],
    filters: {
        search: "",
        holding: "",
        assetClass: "ALL",
        risk: "ALL",
        geography: "ALL",
        sector: "ALL",
        dividend: "ALL"
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

function fillSelect(selector, values, allLabel, labelFor = value => value) {
    const select = qs(selector);

    if (!select) return;

    const current = select.value || "ALL";

    select.innerHTML =
        `<option value="ALL">${escapeHtml(allLabel)}</option>` +
        values
            .map(value => `<option value="${escapeHtml(value)}">${escapeHtml(labelFor(value))}</option>`)
            .join("");

    select.value = values.includes(current) ? current : "ALL";
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

function renderFilterOptions() {
    const rows = explorer.rows;

    const assetCounts = countBy(rows, row => [row.assetClass]);
    fillSelect(
        "#explorer-asset",
        [...assetCounts.keys()].sort(),
        "All asset classes",
        value => `${value} (${assetCounts.get(value)})`
    );

    const riskCounts = countBy(rows, row => [row.risk]);
    fillSelect(
        "#explorer-risk",
        [...riskCounts.keys()].sort((a, b) => (RISK_ORDER[a] ?? 99) - (RISK_ORDER[b] ?? 99)),
        "All risk levels",
        value => `${value} (${riskCounts.get(value)})`
    );

    const geoCounts = countBy(rows, row => row.geographies);
    fillSelect(
        "#explorer-geography",
        [...geoCounts.keys()].sort((a, b) => geoCounts.get(b) - geoCounts.get(a) || a.localeCompare(b)),
        "All geographies",
        value => `${value} (${geoCounts.get(value)})`
    );

    const sectorCounts = countBy(rows, row => row.sectors);
    fillSelect(
        "#explorer-sector",
        [...sectorCounts.keys()].sort((a, b) => sectorCounts.get(b) - sectorCounts.get(a) || a.localeCompare(b)),
        "All sectors",
        value => `${value} (${sectorCounts.get(value)})`
    );

    const holdingsList = qs("#explorer-holding-options");

    if (holdingsList) {
        const names = new Set();

        for (const row of rows) {
            for (const holding of row.holdings) {
                if (holding?.name) names.add(holding.name);
            }
        }

        holdingsList.innerHTML = [...names]
            .sort()
            .map(name => `<option value="${escapeHtml(name)}"></option>`)
            .join("");
    }
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

function getVisibleRows() {
    const f = explorer.filters;
    const search = f.search.trim().toLowerCase();
    const holding = f.holding.trim().toLowerCase();

    let rows = explorer.rows.filter(row => {
        if (search && !row.searchText.includes(search)) return false;
        if (f.assetClass !== "ALL" && row.assetClass !== f.assetClass) return false;
        if (f.risk !== "ALL" && row.risk !== f.risk) return false;
        if (f.geography !== "ALL" && !row.geographies.includes(f.geography)) return false;
        if (f.sector !== "ALL" && !row.sectors.includes(f.sector)) return false;
        if (f.dividend === "YES" && !row.hasDividend) return false;
        if (f.dividend === "NO" && row.hasDividend) return false;
        if (holding && holdingMatches(row, holding).length === 0) return false;

        return true;
    });

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

    const rows = getVisibleRows();
    const holdingTerm = explorer.filters.holding.trim().toLowerCase();

    const active = Object.entries(explorer.filters).some(([key, value]) =>
        key === "search" || key === "holding" ? value.trim() !== "" : value !== "ALL"
    );

    if (count) {
        count.textContent = active
            ? `${rows.length} of ${explorer.rows.length} funds`
            : `${explorer.rows.length} funds`;
    }

    if (clear) clear.hidden = !active;

    document.querySelectorAll("[data-explorer-filter]").forEach(control => {
        const filtered = control.tagName === "SELECT"
            ? control.value !== "ALL"
            : control.value.trim() !== "";

        control.classList.toggle("is-filtered", filtered);
    });

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
                <td colspan="8" class="empty-state">No funds match these filters.</td>
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

            const cell = value => `<td class="return-cell ${returnClass(value)}">${formatPercent(value)}</td>`;

            return `
                <tr class="explorer-row" data-fund-open="${escapeHtml(row.id)}" tabindex="0" role="button">
                    <td class="fund-cell">
                        <div class="fund-name">${escapeHtml(row.name)}</div>
                        <div class="fund-meta">
                            ${escapeHtml(row.code)}${row.hasDividend ? ` · <span class="explorer-dividend-tag">Dividend</span>` : ""}
                        </div>
                        ${holdingNote}
                    </td>
                    <td>${escapeHtml(row.assetClass)}</td>
                    <td><span class="risk-pill risk-${row.riskOrder}">${escapeHtml(row.risk)}</span></td>
                    <td class="bid-cell">${row.bid !== null ? row.bid.toFixed(4) : "—"}</td>
                    ${cell(row.ytd)}
                    ${cell(row.m1)}
                    ${cell(row.y1)}
                    ${cell(row.y3)}
                </tr>
            `;
        })
        .join("");
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
    const cumulative = [
        ["YTD", details.cumulativeYtd],
        ["1M", details.cumulative1m],
        ["3M", details.cumulative3m],
        ["6M", details.cumulative6m],
        ["1Y", details.cumulative1y],
        ["3Y", details.cumulative3y],
        ["5Y", details.cumulative5y]
    ];

    const annualised = [
        ["3Y", details.annualised3y],
        ["5Y", details.annualised5y],
        ["10Y", details.annualised10y],
        ["Since launch", details.annualisedSinceLaunch]
    ];

    const cells = items => items
        .map(([label, raw]) => {
            const value = parsePercent(raw);

            return `
                <div class="fund-return">
                    <span class="fund-return-label">${escapeHtml(label)}</span>
                    <span class="fund-return-value ${returnClass(value)}">${formatPercent(value)}</span>
                </div>
            `;
        })
        .join("");

    return `
        <section class="news-popup-section">
            <h3 class="news-popup-label">Cumulative returns</h3>
            <div class="fund-returns">${cells(cumulative)}</div>
        </section>

        <section class="news-popup-section">
            <h3 class="news-popup-label">Annualised returns</h3>
            <div class="fund-returns">${cells(annualised)}</div>
        </section>

        <p class="fund-source-note">
            Published by Prudential as at ${escapeHtml(details.valuationDate || "the latest valuation date")}.
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
            <h3 class="news-popup-label">Top ${holdings.length} holdings</h3>

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

            <p class="fund-source-note">
                From the factsheet${top.factsheetDataAsAt ? `, data as at ${escapeHtml(top.factsheetDataAsAt)}` : ""}.
            </p>
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

    return `
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

function openProfile(id) {
    const row = explorer.rows.find(item => item.id === id);

    if (!row) return;

    explorer.profile.id = id;

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

                <button type="button" class="news-popup-close" aria-label="Close" title="Close" data-fund-close>×</button>
            </header>

            <h2 id="fund-dialog-title" class="news-popup-title">${escapeHtml(row.name)}</h2>

            <div class="news-card-badges news-popup-badges">
                <span class="news-badge news-category">${escapeHtml(row.assetClass)}</span>
                <span class="risk-pill risk-${row.riskOrder}">${escapeHtml(row.risk)}</span>
                ${row.hasDividend ? `<span class="news-badge explorer-dividend-badge">Pays dividend</span>` : ""}
            </div>

            <div class="news-popup-body">

                <div class="fund-facts">
                    ${fact("BID price", details.bidPrice)}
                    ${fact("Offer price", details.offerPrice)}
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

                ${holdingsSection(fund, row.holdings)}

                ${dividendSection(details)}

                ${documentsSection(fund)}

            </div>

        </div>
    `;

    qs("[data-fund-close]", dialog)?.addEventListener("click", () => dialog.close());

    document.body.classList.add("has-news-dialog");

    if (!dialog.open) dialog.showModal();

    qs(".news-popup-body", dialog)?.scrollTo(0, 0);
}


/* ============================================================
   EVENTS
   ============================================================ */

function bindEvents() {
    const filterMap = {
        "#explorer-search": "search",
        "#explorer-holding": "holding",
        "#explorer-asset": "assetClass",
        "#explorer-risk": "risk",
        "#explorer-geography": "geography",
        "#explorer-sector": "sector",
        "#explorer-dividend": "dividend"
    };

    for (const [selector, key] of Object.entries(filterMap)) {
        const control = qs(selector);

        if (!control) continue;

        const update = () => {
            explorer.filters[key] = control.value ?? (key === "search" || key === "holding" ? "" : "ALL");
            renderTable();
        };

        control.addEventListener(control.tagName === "SELECT" ? "change" : "input", update);
    }

    qs("#explorer-clear")?.addEventListener("click", () => {
        for (const [selector, key] of Object.entries(filterMap)) {
            const control = qs(selector);
            const empty = key === "search" || key === "holding" ? "" : "ALL";

            if (control) control.value = empty;

            explorer.filters[key] = empty;
        }

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
        const row = event.target.closest("[data-fund-open]");

        if (row) openProfile(row.dataset.fundOpen);
    });

    body?.addEventListener("keydown", event => {
        if (event.key !== "Enter" && event.key !== " ") return;

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

function initializeFundExplorer({ funds }) {
    explorer.funds = Array.isArray(funds) ? funds : [];
    explorer.rows = explorer.funds.map(buildRow).filter(row => row.id);

    renderFilterOptions();

    if (!explorer.initialized) {
        bindEvents();
        explorer.initialized = true;
    }

    renderTable();
}

export {
    initializeFundExplorer,
    openProfile as openFundProfile
};
