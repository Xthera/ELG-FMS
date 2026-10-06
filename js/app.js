/* ============================================================
   ELG FMS — APPLICATION CONTROLLER
   ============================================================

   Main responsibilities:
   - Application startup
   - Data loading
   - Theme management
   - View/navigation management
   - Market Performance rendering
   - Market News rendering
   - Chart rendering
   - Application status/error handling

   Data sources:
   - data/funds.json
   - data/bid_history.json
   - data/market_news/analysis/current.json
   ============================================================ */

import {
    loadFundData,
    loadFundsOnly,
    loadMarketNews
} from "./data-loader.js";

import {
    calculateAllPerformance,
    buildBidHistoryIndex,
    formatReturnPercent,
    formatBid,
    formatDisplayDate
} from "./performance.js";

import {
    createNewsState,
    getVisibleNews,
    getAvailableCategories,
    getAvailableYears,
    formatNewsDate,
    getNewsStatistics
} from "./market-news.js";

import {
    createNewsSentimentChart,
    createNewsCategoryChart,
    createNewsImportanceChart,
    createNewsAssetClassChart,
    createNewsGeographyChart,
    createNewsSectorChart,
    updateChartsForTheme,
    destroyAllCharts
} from "./charts.js";

import {
    createFundLinker
} from "./news-fund-links.js";

import {
    renderNewsCard
} from "./news-cards.js";

import {
    openNewsHistory,
    refreshNewsHistory
} from "./news-history.js";

import {
    initializeFundExplorer,
    setFundExplorerHistory,
    refreshFundExplorerChart,
    openFundProfile
} from "./fund-explorer.js";

import {
    enhanceSelects
} from "./custom-select.js";

import {
    initializeUpdateSchedule,
    setLoadedUpdateTime
} from "./update-schedule.js";

import {
    initializeReports
} from "./reports.js";

import {
    initializePlanCalculator
} from "./plan-calculator.js";

import {
    initializeMonitoring
} from "./monitoring.js";

import {
    initializeFundCompare,
    refreshFundCompare
} from "./fund-compare.js";


/* ============================================================
   APPLICATION STATE
   ============================================================ */

const state = {

    initialized: false,

    loading: true,

    error: null,

    data: {

        funds: [],

        bidHistory: [],

        marketNews: {

            analyses: [],

            generatedAtSgt: null,

            timezone: null,

            timezoneLabel: null,

            windowDays: null,

            articleCount: 0

        }

    },

    performance: {

        DD: null,

        WW: null,

        MM: null,

        YY: null,

        SI: null

    },

    selectedPeriod: "MM",

    currentView: "performance",

    lastPageView: "performance",

    news: {

        initialized: false,

        state: null,

        visibleItems: [],

        tab: "current",

        search: "",

        category: "ALL",

        importance: "ALL",

        sentiment: "ALL",

        fund: "ALL",

        assetClass: "ALL",

        geography: "ALL",

        sector: "ALL"

    }

};


/*
 * Links news articles to the funds they may affect.
 * Built once fund data has loaded.
 */
let fundLinker = null;


/* ============================================================
   CONSTANTS
   ============================================================ */

const STORAGE_KEYS = {

    theme: "vgrat-fms-theme",
    accent: "vgrat-fms-accent",

    view: "vgrat-fms-view",

    performancePeriod: "vgrat-fms-performance-period",

    navCollapsed: "vgrat-fms-nav-collapsed",

    fontSize: "vgrat-fms-font-size"

};


const VALID_VIEWS = [

    "performance",

    "news",

    "fund-explorer",

    "monitoring",

    "reports",

    "calculator",

    "settings"

];


const VALID_PERIODS = [

    "DD",

    "WW",

    "MM",

    "YY",

    "SI"

];


/* ============================================================
   DOM HELPERS
   ============================================================ */

function qs(selector, parent = document) {

    return parent.querySelector(selector);

}


function qsa(selector, parent = document) {

    return Array.from(parent.querySelectorAll(selector));

}


function setText(selector, value) {

    const element = qs(selector);

    if (!element) {

        return;

    }

    element.textContent = value ?? "—";

}


function escapeHtml(value) {

    if (value === null || value === undefined) {

        return "";

    }

    return String(value)

        .replace(/&/g, "&amp;")

        .replace(/</g, "&lt;")

        .replace(/>/g, "&gt;")

        .replace(/"/g, "&quot;")

        .replace(/'/g, "&#039;");

}


function escapeAttribute(value) {

    return escapeHtml(value);

}


/* ============================================================
   THEME
   ============================================================ */

/*
 * Themes. Each one is built on the dark or the light base (so all
 * the dark / light specific styling still applies) plus an optional
 * variant that swaps the background, card, border and text colours.
 * "auto" follows the device's light / dark setting.
 */
const THEMES = {
    dark:     { base: "dark",  variant: null,       label: "Dark",     icon: "☾" },
    dim:      { base: "dark",  variant: "dim",      label: "Dim",      icon: "◐" },
    midnight: { base: "dark",  variant: "midnight", label: "Midnight", icon: "●" },
    light:    { base: "light", variant: null,       label: "Light",    icon: "☀" },
    sepia:    { base: "light", variant: "sepia",    label: "Sepia",    icon: "❧" },
    auto:     { base: null,    variant: null,       label: "Auto",     icon: "◑" }
};

const deviceLightQuery =
    window.matchMedia
        ? window.matchMedia("(prefers-color-scheme: light)")
        : null;

let currentThemeChoice = "dark";


function getStoredTheme() {

    try {

        const stored = localStorage.getItem(
            STORAGE_KEYS.theme
        );

        if (THEMES[stored]) {

            return stored;

        }

    } catch {

        // Ignore localStorage failures.

    }

    return "dark";

}


function resolveTheme(choice) {

    if (choice !== "auto") {

        return THEMES[choice] ?? THEMES.dark;

    }

    const deviceIsLight =
        deviceLightQuery?.matches ?? false;

    return {
        ...(deviceIsLight ? THEMES.light : THEMES.dark),
        label: "Auto",
        icon: "◑"
    };

}


function applyTheme(theme, { save = true } = {}) {

    const choice =
        THEMES[theme]
            ? theme
            : "dark";

    currentThemeChoice = choice;

    const resolved =
        resolveTheme(choice);

    const root =
        document.documentElement;

    root.dataset.theme =
        resolved.base;

    if (resolved.variant) {

        root.dataset.variant = resolved.variant;

    } else {

        delete root.dataset.variant;

    }

    const isLight =
        resolved.base === "light";


    const button = qs("#theme-toggle");

    if (button) {

        const icon = qs(".theme-icon", button);

        const label = qs(".theme-label", button);

        button.setAttribute(
            "aria-pressed",
            String(isLight)
        );

        button.setAttribute(
            "aria-label",
            `Theme: ${resolved.label}. Switch to ${isLight ? "a dark" : "a light"} theme`
        );

        button.title =
            `Theme: ${resolved.label} · click to switch to ${isLight ? "dark" : "light"}`;

        if (icon) {

            icon.textContent =
                resolved.icon;

        }

        if (label) {

            label.textContent =
                resolved.label;

        }

    }


    qsa("[data-theme-option]").forEach(
        option => {

            const active =
                option.dataset.themeOption === choice;

            option.classList.toggle("active", active);

            option.setAttribute("aria-pressed", String(active));

        }
    );


    if (save) {

        try {

            localStorage.setItem(
                STORAGE_KEYS.theme,
                choice
            );

        } catch {

            // Ignore localStorage failures.

        }

    }

    /*
     * Give Chart.js a chance to update after CSS variables
     * have changed.
     */
    requestAnimationFrame(() => {

        try {

            updateChartsForTheme();

            refreshFundCompare();

            refreshFundExplorerChart();

            if (state.currentView === "news") {
                renderNewsCharts();
            }

        } catch {

            // Chart layer is optional.

        }

    });

}


function initializeTheme() {

    applyTheme(
        getStoredTheme(),
        { save: false }
    );

    // "Follow device" reacts when the device switches day / night.
    deviceLightQuery?.addEventListener?.(
        "change",
        () => {

            if (currentThemeChoice === "auto") {

                applyTheme("auto", { save: false });

            }

        }
    );

}


function initializeThemeToggle() {

    const button = qs("#theme-toggle");

    if (!button) {

        return;

    }

    /*
     * Quick switch between the dark and light families:
     * any dark theme -> Light, any light theme -> Dark.
     */
    button.addEventListener(
        "click",
        () => {

            const isLight =
                document.documentElement.dataset.theme ===
                "light";

            applyTheme(
                isLight
                    ? "dark"
                    : "light"
            );

        }
    );

}


/* ============================================================
   SETTINGS - TEXT SIZE
   ============================================================ */

const FONT_SCALE_MIN = 0.8;

const FONT_SCALE_MAX = 1.4;

/* Older saved choices from the previous button version */
const NAMED_FONT_SCALES = {
    small: 0.9,
    default: 1,
    large: 1.15,
    xlarge: 1.3
};


function normalizeFontScale(value) {

    const number =
        NAMED_FONT_SCALES[value] ??
        parseFloat(value);


    if (!Number.isFinite(number)) {

        return 1;

    }


    return Math.min(
        FONT_SCALE_MAX,
        Math.max(
            FONT_SCALE_MIN,
            Math.round(number * 100) / 100
        )
    );

}


let chartRedrawTimer = null;


function applyFontScale(
    value,
    options = {}
) {

    const scale =
        normalizeFontScale(value);


    document.documentElement.style.setProperty(
        "--font-scale",
        String(scale)
    );


    const percent =
        `${Math.round(scale * 100)}%`;


    const slider =
        qs("#font-size-slider");


    if (slider) {

        slider.value =
            String(Math.round(scale * 100));

        slider.setAttribute(
            "aria-valuetext",
            percent
        );

    }


    const output =
        qs("#font-size-value");


    if (output) {

        output.textContent =
            percent;

    }


    if (options.save !== false) {

        setStoredValue(
            STORAGE_KEYS.fontSize,
            String(scale)
        );

    }


    /*
     * Charts draw text on a canvas: redraw them once the
     * slider settles (same path as a theme change).
     */
    clearTimeout(chartRedrawTimer);

    chartRedrawTimer = setTimeout(() => {

        try {

            updateChartsForTheme();

            refreshFundCompare();

            refreshFundExplorerChart();

            if (state.currentView === "news") {
                renderNewsCharts();
            }

        } catch {

            // Chart layer is optional.

        }

    }, 150);

}


function initializeSettings() {

    applyFontScale(
        getStoredValue(
            STORAGE_KEYS.fontSize,
            "1"
        ),
        {
            save: false
        }
    );


    const slider =
        qs("#font-size-slider");


    if (slider) {

        // Live while dragging
        slider.addEventListener(
            "input",
            () => applyFontScale(
                Number(slider.value) / 100
            )
        );

    }


    qs("#font-size-reset")
        ?.addEventListener(
            "click",
            () => applyFontScale(1)
        );


    qsa("[data-theme-option]").forEach(
        option => {

            option.addEventListener(
                "click",
                () => applyTheme(
                    option.dataset.themeOption
                )
            );

        }
    );


    qsa("[data-accent-option]").forEach(
        option => {

            option.addEventListener(
                "click",
                () => applyAccent(
                    option.dataset.accentOption,
                    { save: true }
                )
            );

        }
    );

    applyAccent(
        getStoredValue(STORAGE_KEYS.accent, "steel")
    );

}


/* ============================================================
   COLOUR PALETTE
   ============================================================ */

const ACCENT_PALETTES = [
    "steel",
    "ocean",
    "gold",
    "teal",
    "violet",
    "rose"
];

function applyAccent(accent, { save = false } = {}) {

    const name =
        ACCENT_PALETTES.includes(accent)
            ? accent
            : "steel";

    document.documentElement.dataset.accent = name;

    qsa("[data-accent-option]").forEach(
        option => {

            const active =
                option.dataset.accentOption === name;

            option.classList.toggle("active", active);

            option.setAttribute("aria-pressed", String(active));

        }
    );

    if (!save) {

        return;

    }

    setStoredValue(
        STORAGE_KEYS.accent,
        name
    );

    // Charts read colours once; redraw them with the new accent.
    requestAnimationFrame(() => {

        try {

            updateChartsForTheme();

            refreshFundCompare();

            refreshFundExplorerChart();

            if (state.currentView === "news") {
                renderNewsCharts();
            }

        } catch {

            // Charts are optional.

        }

    });

}


/* ============================================================
   MENU TOGGLE
   ============================================================ */

function applyNavCollapsed(collapsed) {

    const shell =
        qs("#app");

    const button =
        qs("#nav-toggle");


    if (shell) {

        shell.classList.toggle(
            "nav-collapsed",
            collapsed
        );

    }


    if (button) {

        const label =
            collapsed
                ? "Expand menu"
                : "Minimise menu";

        button.setAttribute(
            "aria-expanded",
            String(!collapsed)
        );

        button.setAttribute(
            "aria-label",
            label
        );

        button.title =
            label;

    }


    try {

        localStorage.setItem(
            STORAGE_KEYS.navCollapsed,
            collapsed ? "1" : "0"
        );

    } catch {

        // Ignore localStorage failures.

    }


    /*
     * Charts resize to the new content width.
     */
    requestAnimationFrame(() => {

        window.dispatchEvent(
            new Event("resize")
        );

    });

}


function initializeNavToggle() {

    let collapsed = false;


    try {

        collapsed =
            localStorage.getItem(
                STORAGE_KEYS.navCollapsed
            ) === "1";

    } catch {

        collapsed = false;

    }


    applyNavCollapsed(collapsed);


    const button =
        qs("#nav-toggle");


    if (!button) {

        return;

    }


    button.addEventListener(
        "click",
        () => {

            const shell =
                qs("#app");

            applyNavCollapsed(
                !shell?.classList.contains(
                    "nav-collapsed"
                )
            );

        }
    );

}


/* ============================================================
   APPLICATION STATUS
   ============================================================ */

function setApplicationStatus(
    status,
    message
) {

    const container =
        qs("#app-status");

    const text =
        qs("#app-status-text");

    if (!container) {

        return;

    }

    container.classList.remove(

        "is-loading",

        "is-ready",

        "is-error"

    );

    container.classList.add(

        `is-${status}`

    );

    container.setAttribute(
        "aria-busy",
        status === "loading"
            ? "true"
            : "false"
    );

    if (text) {

        text.textContent =
            message;

    }

}


function setLoadingState() {

    setApplicationStatus(
        "loading",
        "Loading data…"
    );

}


function setReadyState() {

    setApplicationStatus(
        "ready",
        "Data loaded"
    );

}


function setErrorState(message) {

    setApplicationStatus(
        "error",
        "Data error"
    );

    const container =
        qs("#application-error");

    if (!container) {

        return;

    }

    container.innerHTML = `

        <div class="error-panel">

            <div class="error-panel-title">
                Unable to load ELG FMS data
            </div>

            <div class="error-panel-message">
                ${escapeHtml(message)}
            </div>

            <button
                type="button"
                class="error-retry-button"
                data-action="retry"
            >
                Retry
            </button>

        </div>

    `;

    container.classList.add(
        "is-visible"
    );

    const retry =
        qs(
            '[data-action="retry"]',
            container
        );

    if (retry) {

        retry.addEventListener(
            "click",
            () => {

                window.location.reload();

            }
        );

    }

}


/* ============================================================
   LOCAL STORAGE HELPERS
   ============================================================ */

function getStoredValue(
    key,
    fallback
) {

    try {

        const value =
            localStorage.getItem(key);

        return value ?? fallback;

    } catch {

        return fallback;

    }

}


function setStoredValue(
    key,
    value
) {

    try {

        localStorage.setItem(
            key,
            value
        );

    } catch {

        // Ignore localStorage failures.

    }

}


/* ============================================================
   NAVIGATION
   ============================================================ */

function normalizeView(view) {

    return VALID_VIEWS.includes(view)
        ? view
        : "performance";

}


function setCurrentView(
    view,
    options = {}
) {

    const normalizedView =
        normalizeView(view);

    /*
     * Remember the last regular page, so a second click on
     * Settings can return to it.
     */
    if (
        normalizedView !== "settings"
    ) {

        state.lastPageView =
            normalizedView;

    }


    state.currentView =
        normalizedView;

    setStoredValue(
        STORAGE_KEYS.view,
        normalizedView
    );


    /* ----------------------------------------
       Navigation links
    ----------------------------------------- */

    qsa("[data-view-target]").forEach(
        link => {

            const target =
                link.dataset.viewTarget;

            const active =
                target === normalizedView;

            link.classList.toggle(
                "active",
                active
            );

            if (
                link.hasAttribute(
                    "aria-current"
                )
            ) {

                link.setAttribute(
                    "aria-current",
                    active
                        ? "page"
                        : "false"
                );

            }

        }
    );


    /* ----------------------------------------
       View panels
    ----------------------------------------- */

    qsa("[data-view-panel]").forEach(
        panel => {

            const target =
                panel.dataset.viewPanel;

            const active =
                target === normalizedView;

            panel.classList.toggle(
                "is-active",
                active
            );

            panel.hidden =
                !active;

        }
    );


    /* ----------------------------------------
       Legacy / explicit IDs
    ----------------------------------------- */

    const legacyMap = {

        performance:
            "#market-performance-view",

        news:
            "#market-news-view",

        "fund-explorer":
            "#fund-explorer-view",

        monitoring:
            "#monitoring-view",
        reports:
            "#reports-view",

        calculator:
            "#calculator-view",

        settings:
            "#settings-view"

    };


    Object.entries(
        legacyMap
    ).forEach(
        ([key, selector]) => {

            const element =
                qs(selector);

            if (!element) {

                return;

            }

            element.hidden =
                key !== normalizedView;

        }
    );


    /* ----------------------------------------
       News chart refresh
    ----------------------------------------- */

    if (
        normalizedView === "news" &&
        state.news.initialized
    ) {

        requestAnimationFrame(
            () => {

                renderNewsCharts();

            }
        );

    }


    /* ----------------------------------------
       URL hash
    ----------------------------------------- */

    if (
        options.updateHash !== false
    ) {

        const hash =
            normalizedView === "performance"
                ? "#market-performance"
                : normalizedView === "news"
                    ? "#market-news"
                    : normalizedView === "fund-explorer"
                        ? "#fund-explorer"
                        : normalizedView === "settings"
                            ? "#settings"
                            : normalizedView === "reports"
                                ? "#report-generation"
                                : normalizedView === "calculator"
                                    ? "#plan-calculator"
                                    : "#monitoring";

        if (
            window.location.hash !== hash
        ) {

            history.replaceState(
                null,
                "",
                hash
            );

        }

    }

}


function getViewFromHash() {

    const hash =
        window.location.hash
            .replace("#", "")
            .trim()
            .toLowerCase();

    const map = {

        "market-performance":
            "performance",

        "performance":
            "performance",

        "market-news":
            "news",

        "news":
            "news",

        "fund-explorer":
            "fund-explorer",

        "monitoring":
            "monitoring",

        "report-generation":
            "reports",

        "reports":
            "reports",

        "plan-calculator":
            "calculator",

        "calculator":
            "calculator",

        "settings":
            "settings"

    };

    return map[hash] ?? null;

}


const RESUME_VIEW_KEY =
    "vgrat-fms-resume-view";


/*
 * Refresh: reload the page so every file is fetched again
 * (fetch uses "no-cache", so unchanged files come back quickly
 * as 304s) and return to the page currently open.
 */
function refreshData() {

    const button =
        qs("#refresh-data");

    if (button) {

        button.disabled = true;

        button.classList.add("is-refreshing");

        button.setAttribute("aria-busy", "true");

    }

    try {

        sessionStorage.setItem(
            RESUME_VIEW_KEY,
            state.currentView ?? "performance"
        );

    } catch {

        // Without sessionStorage the page opens on Market Performance.

    }

    window.location.reload();

}


function initializeNavigation() {

    qsa("[data-view-target]").forEach(
        element => {

            element.addEventListener(
                "click",
                event => {

                    event.preventDefault();

                    /*
                     * Every menu click opens the page at the top.
                     */
                    window.scrollTo({
                        top: 0,
                        left: 0,
                        behavior: "instant"
                    });

                    const target =
                        element.dataset.viewTarget;


                    /*
                     * Settings acts as a toggle: clicking it
                     * again returns to the page you came from.
                     */
                    if (
                        target === "settings" &&
                        state.currentView === "settings"
                    ) {

                        setCurrentView(
                            state.lastPageView ??
                            "performance"
                        );

                        return;

                    }


                    setCurrentView(
                        target
                    );

                }
            );

        }
    );


    /*
     * Every visit (or reload) opens on Market Performance at the
     * top of the page, on phone and desktop alike. The last page
     * and any #page in the address are not restored.
     */
    if ("scrollRestoration" in history) {

        history.scrollRestoration = "manual";

    }

    window.scrollTo({
        top: 0,
        left: 0,
        behavior: "instant"
    });

    /*
     * Exception: the Refresh button reloads the page and asks to
     * come back to the page you were on (one time only).
     */
    let resumeView = null;

    try {

        resumeView =
            sessionStorage.getItem(RESUME_VIEW_KEY);

        sessionStorage.removeItem(RESUME_VIEW_KEY);

    } catch {

        resumeView = null;

    }

    setCurrentView(
        VALID_VIEWS.includes(resumeView)
            ? resumeView
            : "performance",
        {
            updateHash: true
        }
    );


    qs("#refresh-data")
        ?.addEventListener(
            "click",
            refreshData
        );


    window.addEventListener(
        "hashchange",
        () => {

            const view =
                getViewFromHash();

            if (view) {

                setCurrentView(
                    view,
                    {
                        updateHash: false
                    }
                );

            }

        }
    );

}


/* ============================================================
   PERFORMANCE
   ============================================================ */

function normalizePeriod(period) {

    return VALID_PERIODS.includes(period)
        ? period
        : "DD";

}


function setSelectedPeriod(
    period
) {

    const normalizedPeriod =
        normalizePeriod(period);

    state.selectedPeriod =
        normalizedPeriod;

    setStoredValue(
        STORAGE_KEYS.performancePeriod,
        normalizedPeriod
    );


    qsa("[data-period]").forEach(
        button => {

            const active =
                button.dataset.period ===
                normalizedPeriod;

            button.classList.toggle(
                "active",
                active
            );

            button.setAttribute(
                "aria-selected",
                String(active)
            );

        }
    );


    renderSelectedPerformance();

}


function initializePerformanceTabs() {

    qsa("[data-period]").forEach(
        button => {

            button.addEventListener(
                "click",
                () => {

                    setSelectedPeriod(
                        button.dataset.period
                    );

                }
            );

        }
    );


    /*
     * The performer section always opens on M-M (month over
     * month); a period picked during the visit isn't carried
     * over to the next one.
     */
    setSelectedPeriod(
        "MM"
    );

}


function buildPerformanceResults() {

    if (
        !state.data.funds.length ||
        !state.data.bidHistory.length
    ) {

        state.performance = {

            DD: null,

            WW: null,

            MM: null,

            YY: null,

            SI: null

        };

        return;

    }


    /*
     * Build the BID history index once and share it with
     * the performance tables and the fund comparison chart.
     */
    const historyIndex =
        buildBidHistoryIndex(
            state.data.bidHistory
        );


    state.performance =
        calculateAllPerformance(

            state.data.funds,

            state.data.bidHistory,

            10,

            historyIndex

        );




    // Monitoring: watchlist alerts + unusual moves scan.
    try {

        initializeMonitoring({
            funds: state.data.funds,
            historyIndex,
            openProfile: id => openFundProfile(id)
        });

    } catch (error) {

        console.warn(
            "ELG FMS: monitoring failed.",
            error
        );

    }


    // Plan Calculator: PRUVantage Assure II / Wealth III illustrations.
    try {

        initializePlanCalculator({
            funds: state.data.funds
        });

    } catch (error) {

        console.warn(
            "ELG FMS: plan calculator failed.",
            error
        );

    }


    // Report Generation: investment growth from actual BID prices.
    try {

        initializeReports({
            funds: state.data.funds,
            historyIndex
        });

    } catch (error) {

        console.warn(
            "ELG FMS: report generation failed.",
            error
        );

    }


    // Price chart in the Fund Explorer profile popup.
    try {

        setFundExplorerHistory(
            historyIndex
        );

    } catch (error) {

        console.warn(
            "ELG FMS: fund profile chart failed.",
            error
        );

    }


    try {

        initializeFundCompare({
            funds: state.data.funds,
            historyIndex
        });

    } catch (error) {

        console.warn(
            "ELG FMS: fund comparison chart failed.",
            error
        );

    }

}


function getSelectedPerformance() {

    return state.performance[
        state.selectedPeriod
    ] ?? null;

}


function renderPerformanceSummary(
    performance
) {

    if (!performance) {

        setText(
            "#selected-period-label",
            state.selectedPeriod
        );

        setText(
            "#selected-period-description",
            "No performance data available"
        );

        setText(
            "#performance-period-title",
            "Performance"
        );

        setText(
            "#performance-period-description",
            "No performance data available."
        );

        setText(
            "#performance-eligible-count",
            "—"
        );

        setText(
            "#eligible-fund-count",
            "—"
        );

        setText(
            "#performance-as-of",
            "Latest BID: —"
        );

        setText(
            "#latest-valuation-date",
            "—"
        );

        setText(
            "#performance-target-date",
            "Comparison target: —"
        );

        setText(
            "#top-winner-return",
            "—"
        );

        setText(
            "#top-winner-name",
            "—"
        );

        setText(
            "#top-loser-return",
            "—"
        );

        setText(
            "#top-loser-name",
            "—"
        );

        return;

    }


    setText(
        "#selected-period-label",
        performance.label
    );


    setText(
        "#selected-period-description",
        performance.description
    );


    setText(
        "#performance-period-title",
        performance.label
    );


    setText(
        "#performance-period-description",
        performance.description
    );


    setText(
        "#performance-eligible-count",
        `${performance.totalEligibleFunds} funds with valid comparison data`
    );


    setText(
        "#eligible-fund-count",
        performance.totalEligibleFunds
    );


    setText(
        "#performance-as-of",
        `Latest BID: ${formatDisplayDate(
            performance.asOfDate
        )}`
    );


    setText(
        "#latest-valuation-date",
        formatDisplayDate(
            performance.asOfDate
        )
    );


    setText(
        "#performance-target-date",
        performance.type === "inception"
            ? "Compared with each fund's first BID on record"
            : `Comparison target: ${formatDisplayDate(
                performance.targetDate
            )}`
    );


    const winner =
        performance.winners?.[0] ?? null;


    const loser =
        performance.losers?.[0] ?? null;


    if (winner) {

        setText(
            "#top-winner-return",
            formatReturnPercent(
                winner.returnPercent
            )
        );

        setText(
            "#top-winner-name",
            winner.fundName
        );

    } else {

        setText(
            "#top-winner-return",
            "—"
        );

        setText(
            "#top-winner-name",
            "No valid result"
        );

    }


    if (loser) {

        setText(
            "#top-loser-return",
            formatReturnPercent(
                loser.returnPercent
            )
        );

        setText(
            "#top-loser-name",
            loser.fundName
        );

    } else {

        setText(
            "#top-loser-return",
            "—"
        );

        setText(
            "#top-loser-name",
            "No valid result"
        );

    }

}


function renderPerformanceTable(
    selector,
    rows,
    emptyMessage
) {

    const tbody =
        qs(selector);

    if (!tbody) {

        return;

    }


    if (!rows || rows.length === 0) {

        tbody.innerHTML = `

            <tr>

                <td
                    colspan="5"
                    class="empty-state"
                >
                    ${escapeHtml(emptyMessage)}
                </td>

            </tr>

        `;

        return;

    }


    tbody.innerHTML =
        rows.map(
            (row, index) => {

                const returnValue =
                    Number(row.returnPercent);


                const returnClass =
                    returnValue >= 0
                        ? "return-positive"
                        : "return-negative";


                const fundName =
                    escapeHtml(
                        row.fundName
                    );


                const fundCode =
                    escapeHtml(
                        row.fundCode ??
                        "—"
                    );


                const bid =
                    formatBid(
                        row.currentBid
                    );


                return `

                    <tr
                        class="performance-row"
                        data-fund-identifier="${escapeAttribute(
                            row.fundIdentifier ??
                            ""
                        )}"
                    >

                        <td class="rank-cell">
                            ${index + 1}
                        </td>


                        <td class="fund-cell">

                            <div class="fund-name">
                                ${fundName}
                            </div>

                            <div class="fund-meta">
                                ${
                                    escapeHtml(
                                        row.currency ??
                                        ""
                                    )
                                }
                            </div>

                        </td>


                        <td class="fund-code-cell">
                            ${fundCode}
                        </td>


                        <td
                            class="return-cell ${returnClass}"
                            data-label="Return"
                        >
                            <span class="return-pill">${formatReturnPercent(
                                returnValue
                            )}</span>
                        </td>


                        <td class="bid-cell" data-label="BID">
                            ${escapeHtml(bid)}
                        </td>

                    </tr>

                `;

            }
        ).join("");

}


function renderPerformanceTables(
    performance
) {

    if (!performance) {

        renderPerformanceTable(
            "#winners-table-body",
            [],
            "No performance data available."
        );

        renderPerformanceTable(
            "#losers-table-body",
            [],
            "No performance data available."
        );

        return;

    }


    renderPerformanceTable(

        "#winners-table-body",

        performance.winners,

        "No valid winners for this period."

    );


    renderPerformanceTable(

        "#losers-table-body",

        performance.losers,

        "No valid losers for this period."

    );

}


function renderSelectedPerformance() {

    const performance =
        getSelectedPerformance();


    renderPerformanceSummary(
        performance
    );


    renderPerformanceTables(
        performance
    );
}


function initializePerformance() {

    buildPerformanceResults();

    renderSelectedPerformance();

}


/* ============================================================
   MARKET NEWS
   ============================================================ */

let newsControlsBound = false;


function initializeMarketNews() {

    /*
     * Bind filter and tab listeners only once, even if
     * the application data is reloaded.
     */
    if (!newsControlsBound) {

        initializeNewsFilters();

        initializeNewsTabs();

        newsControlsBound = true;

    }


    /*
     * createNewsState() expects the full market-news
     * object (with .analyses), which initializeNewsState()
     * provides.
     */
    initializeNewsState();

    renderNewsMetadata();

}


function renderNewsFilterOptions() {

    const select =
        qs("#market-news-category");

    if (!select) {

        return;

    }


    const analyses =
        state.news?.state?.analyses ??
        [];


    const categories =
        getAvailableCategories(
            analyses
        );


    const currentValue =
        state.news.category;


    select.innerHTML = `

        <option value="ALL">
            All
        </option>

        ${categories
            .filter(
                category =>
                    category !== "ALL"
            )
            .map(
                category => `

                    <option
                        value="${escapeAttribute(
                            category
                        )}"
                    >
                        ${escapeHtml(
                            category
                        )}
                    </option>

                `
            )
            .join("")}

    `;


    if (
        currentValue !== "ALL" &&
        categories.includes(
            currentValue
        )
    ) {

        select.value =
            currentValue;

    } else {

        select.value =
            "ALL";

        state.news.category =
            [];

    }

}

/*
 * Asset class / geography / sector options, most frequent
 * first, with the article count in brackets.
 */
function renderNewsTagOptions() {

    const analyses =
        state.news?.state?.analyses ??
        [];


    const fill = (selector, field, allLabel, current) => {

        const select =
            qs(selector);


        if (!select) {

            return "ALL";

        }


        const counts =
            new Map();


        for (const article of analyses) {

            for (const value of new Set(article[field] ?? [])) {

                counts.set(
                    value,
                    (counts.get(value) ?? 0) + 1
                );

            }

        }


        const sorted =
            [...counts.entries()]
                .sort(
                    (a, b) =>
                        b[1] - a[1] ||
                        String(a[0]).localeCompare(String(b[0]))
                );


        select.innerHTML =
            `<option value="ALL">${escapeHtml(allLabel)}</option>` +
            sorted
                .map(
                    ([value, count]) =>
                        `<option value="${escapeAttribute(value)}">${escapeHtml(value)} (${count})</option>`
                )
                .join("");


        const keep =
            current !== "ALL" &&
            counts.has(current);


        select.value =
            keep
                ? current
                : "ALL";


        return select.value;

    };


    // Options only; the selection is restored by renderNewsDynamicOptions()
    fill("#market-news-asset", "assetClasses", "All", "ALL");

    fill("#market-news-geography", "geographies", "All", "ALL");

    fill("#market-news-sector", "sectors", "All", "ALL");


    renderFilterIndicators();

}


/*
 * Values chosen in a (multi-select) filter, without "ALL".
 */
function selectedFilterValues(selector) {

    const select =
        qs(selector);

    if (!select) {

        return [];

    }

    return [...select.selectedOptions]
        .map(option => option.value)
        .filter(value => value && value !== "ALL");

}


/* A news filter value as a list ("ALL" / "" / [] -> []) */
function filterList(value) {

    if (Array.isArray(value)) {

        return value.filter(item => item && item !== "ALL");

    }

    return value && value !== "ALL"
        ? [value]
        : [];

}


function hasNewsFilters() {

    return Boolean(state.news.search) ||
        ["category", "importance", "sentiment", "fund", "assetClass", "geography", "sector"]
            .some(key => filterList(state.news[key]).length > 0);

}


/*
 * Highlight active filters and show "Clear filters".
 */
function renderFilterIndicators() {

    const selectors = [
        "#market-news-category",
        "#market-news-importance",
        "#market-news-sentiment",
        "#market-news-asset",
        "#market-news-geography",
        "#market-news-sector",
        "#market-news-fund"
    ];


    let active =
        Boolean(
            qs("#market-news-search")
                ?.value
                ?.trim()
        );


    for (const selector of selectors) {

        const select =
            qs(selector);


        if (!select) {

            continue;

        }


        const filtered =
            selectedFilterValues(selector).length > 0;


        select.classList.toggle(
            "is-filtered",
            filtered
        );


        active =
            active ||
            filtered;

    }


    const clear =
        qs("#market-news-clear");


    if (clear) {

        clear.hidden =
            !active;

    }

}


function clearNewsFilters() {

    const search =
        qs("#market-news-search");


    if (search) {

        search.value =
            "";

    }


    [
        "#market-news-category",
        "#market-news-importance",
        "#market-news-sentiment",
        "#market-news-asset",
        "#market-news-geography",
        "#market-news-sector",
        "#market-news-fund"
    ].forEach(
        selector => {

            const select =
                qs(selector);


            if (select) {

                select.value =
                    "ALL";

            }

        }
    );


    updateNewsFilters();

}


function updateNewsFilters() {

    state.news.search =
        qs("#market-news-search")
            ?.value
            ?.trim()
            ?? "";


    // Multi-select filters: an empty list means "All"
    state.news.category = selectedFilterValues("#market-news-category");
    state.news.importance = selectedFilterValues("#market-news-importance");
    state.news.sentiment = selectedFilterValues("#market-news-sentiment");
    state.news.fund = selectedFilterValues("#market-news-fund");
    state.news.assetClass = selectedFilterValues("#market-news-asset");
    state.news.geography = selectedFilterValues("#market-news-geography");
    state.news.sector = selectedFilterValues("#market-news-sector");


    renderNewsDynamicOptions();

    renderFilterIndicators();

    renderNewsSummary();

    renderMarketNews();

}


function initializeNewsFilters() {

    const search =
        qs("#market-news-search");


    const category =
        qs("#market-news-category");


    const importance =
        qs("#market-news-importance");


    const sentiment =
        qs("#market-news-sentiment");


    if (search) {

        search.addEventListener(
            "input",
            updateNewsFilters
        );

    }


    if (category) {

        category.addEventListener(
            "change",
            updateNewsFilters
        );

    }


    if (importance) {

        importance.addEventListener(
            "change",
            updateNewsFilters
        );

    }


    if (sentiment) {

        sentiment.addEventListener(
            "change",
            updateNewsFilters
        );

    }


    [
        "#market-news-fund",
        "#market-news-asset",
        "#market-news-geography",
        "#market-news-sector"
    ].forEach(
        selector => {

            qs(selector)
                ?.addEventListener(
                    "change",
                    updateNewsFilters
                );

        }
    );


    qs("#market-news-clear")
        ?.addEventListener(
            "click",
            clearNewsFilters
        );

}


/*
 * Articles that pass the Market News filters. `override` replaces
 * some filter values (e.g. { assetClass: "ALL" }) without touching
 * the page state; used to work out each dropdown's options.
 */
function getFilteredNews(override = null) {

    if (!state.news.state) {

        return [];

    }


    const f =
        override
            ? { ...state.news, ...override }
            : state.news;


    /*
     * Synchronize the application-level controls with the
     * Market News module state (a copy when only probing).
     */
    const moduleState =
        override
            ? { ...state.news.state }
            : state.news.state;


    moduleState.searchTerm =
        f.search ?? "";

    // Category / importance / sentiment are multi-select, so they are
    // filtered here instead of by the single-value news module.
    moduleState.selectedCategory = "ALL";

    moduleState.selectedImportance = "ALL";

    moduleState.selectedSentiment = "ALL";


    const visible =
        getVisibleNews(
            moduleState
        );


    // Within one filter: any of the chosen values (OR).
    // Across filters: all must match (AND).
    const matchesOne = (value, wanted) => {

        const list = filterList(wanted);

        return !list.length || list.includes(String(value ?? "").toUpperCase()) || list.includes(value);

    };

    const matchesAny = (values, wanted) => {

        const list = filterList(wanted);

        return !list.length ||
            (Array.isArray(values) && values.some(value => list.includes(value)));

    };


    const tagged =
        visible.filter(
            article =>
                matchesOne(article.category, f.category) &&
                matchesOne(article.importance, f.importance) &&
                matchesOne(article.sentiment, f.sentiment) &&
                matchesAny(article.assetClasses, f.assetClass) &&
                matchesAny(article.geographies, f.geography) &&
                matchesAny(article.sectors, f.sector)
        );


    const funds =
        filterList(f.fund);


    if (
        !funds.length ||
        !fundLinker
    ) {

        return tagged;

    }


    return tagged.filter(
        article =>
            fundLinker
                .linkArticle(article)
                .some(
                    link =>
                        funds.includes(link.fundId)
                )
    );

}


/* ============================================================
   DYNAMIC NEWS FILTERS
   Each dropdown lists only the options that still have articles
   given every OTHER filter, with live counts.
   ============================================================ */

const NEWS_FILTERS = [
    { key: "category",   selector: "#market-news-category",   allLabel: "All", single: article => article.category },
    { key: "importance", selector: "#market-news-importance", allLabel: "All", single: article => article.importance, order: ["HIGH", "MEDIUM", "LOW"] },
    { key: "sentiment",  selector: "#market-news-sentiment",  allLabel: "All", single: article => article.sentiment, order: ["POSITIVE", "NEUTRAL", "MIXED", "NEGATIVE"] },
    { key: "assetClass", selector: "#market-news-asset",      allLabel: "All", many: article => article.assetClasses },
    { key: "geography",  selector: "#market-news-geography",  allLabel: "All", many: article => article.geographies },
    { key: "sector",     selector: "#market-news-sector",     allLabel: "All", many: article => article.sectors },
    { key: "fund",       selector: "#market-news-fund",       allLabel: "All funds", fund: true }
];

/* Display names for option values (kept from the original options) */
const newsOptionLabels =
    new Map();

function newsOptionLabel(selector, value) {

    if (!newsOptionLabels.has(selector)) {

        newsOptionLabels.set(selector, new Map());

    }

    const labels =
        newsOptionLabels.get(selector);

    if (!labels.has(value)) {

        const option =
            [...(qs(selector)?.options ?? [])]
                .find(item => item.value === value);

        const text =
            (option?.dataset.label ?? option?.textContent ?? value)
                .trim()
                .replace(/\s*\(\d+\)$/, "");

        labels.set(
            value,
            text || value
        );

    }

    return labels.get(value);

}

function renderNewsDynamicOptions() {

    if (!state.news.state) {

        return;

    }

    for (const filter of NEWS_FILTERS) {

        const select =
            qs(filter.selector);

        if (!select) {

            continue;

        }

        // Remember labels before rebuilding the options
        [...select.options].forEach(
            option => newsOptionLabel(filter.selector, option.value)
        );

        const articles =
            getFilteredNews({ [filter.key]: [] });

        const counts =
            new Map();

        for (const article of articles) {

            let values = [];

            if (filter.single) {

                values = [filter.single(article)];

            } else if (filter.many) {

                values = filter.many(article) ?? [];

            } else if (filter.fund && fundLinker) {

                values = fundLinker
                    .linkArticle(article)
                    .map(link => link.fundId);

            }

            for (const value of new Set(values.filter(Boolean))) {

                counts.set(
                    value,
                    (counts.get(value) ?? 0) + 1
                );

            }

        }

        let values =
            [...counts.keys()];

        if (filter.order) {

            values.sort(
                (a, b) =>
                    (filter.order.indexOf(a) + 99) % 99 -
                    (filter.order.indexOf(b) + 99) % 99
            );

        } else {

            values.sort(
                (a, b) =>
                    counts.get(b) - counts.get(a) ||
                    newsOptionLabel(filter.selector, a).localeCompare(newsOptionLabel(filter.selector, b))
            );

        }

        const current =
            filterList(state.news[filter.key]);

        // Keep the current choices listed even if they have no articles now
        for (const value of [...current].reverse()) {

            if (!counts.has(value)) {

                values.unshift(value);

            }

        }

        // Fund lists are always in alphabetical order of fund name
        // (the "(CODE)" after the name is ignored when sorting)
        if (filter.fund) {

            const fundName = value =>
                newsOptionLabel(filter.selector, value).replace(/\s*\([A-Z0-9]+\)$/, "");

            values.sort(
                (a, b) =>
                    fundName(a).localeCompare(fundName(b))
            );

        }

        const html =
            `<option value="ALL" data-label="${escapeAttribute(filter.allLabel)}">${escapeHtml(filter.allLabel)} (${articles.length})</option>` +
            values
                .map(value => {

                    const label =
                        newsOptionLabel(filter.selector, value);

                    return `<option value="${escapeAttribute(value)}" data-label="${escapeAttribute(label)}">${escapeHtml(label)} (${counts.get(value) ?? 0})</option>`;

                })
                .join("");

        if (select.dataset.optionsHtml !== html) {

            select.innerHTML = html;

            select.dataset.optionsHtml = html;

        }

        // Restore the selection ("All" when nothing is chosen)
        for (const option of select.options) {

            option.selected = current.length
                ? current.includes(option.value)
                : option.value === "ALL";

        }

        select.dispatchEvent(new Event("vselect:sync"));

    }

}


function renderNewsSummary() {

    const visible =
        getFilteredNews();


    const total =
        state.data.marketNews?.analyses?.length ??
        0;


    const count =
        qs("#market-news-count");


    if (!count) {

        return;

    }


    if (
        hasNewsFilters()
    ) {

        count.textContent =
            `${visible.length} of ${total} articles`;

    } else {

        count.textContent =
            `${visible.length} analyzed articles`;

    }

}


function renderMarketNews() {

    /*
     * IMPORTANT:
     *
     * #market-news-current is the entire current-news panel.
     *
     * #market-news-articles is the actual article rendering
     * container.
     *
     * This is the selector correction made in this version.
     */
    const container =
        qs("#market-news-articles");


    if (!container) {

        return;

    }


    const articles =
        getFilteredNews();


    if (
        !articles ||
        articles.length === 0
    ) {

        container.innerHTML = `

            <div class="empty-news-state">

                <div class="empty-news-icon">
                    ◈
                </div>

                <h3>
                    No matching market news
                </h3>

                <p>
                    No articles match the current
                    search and filter criteria.
                </p>

            </div>

        `;

        renderNewsCharts();

        return;

    }


    const selectedFund =
        filterList(state.news.fund);


    container.innerHTML =
        articles.map(
            article =>
                renderNewsCard(
                    article,
                    fundLinker
                        ? fundLinker.linkArticle(article)
                        : [],
                    selectedFund
                )
        ).join("");


    renderNewsCharts();

}


function renderNewsCharts() {

    if (!state.news.state) {

        return;

    }


    const articles =
        getFilteredNews();


    const statistics =
        getNewsStatistics(
            articles
        );


    try {

        createNewsSentimentChart(
            "news-sentiment-chart",
            statistics
        );

        createNewsCategoryChart(
            "news-category-chart",
            statistics
        );

        createNewsImportanceChart(
            "news-importance-chart",
            statistics
        );

        createNewsAssetClassChart(
            "news-asset-class-chart",
            statistics
        );

        createNewsGeographyChart(
            "news-geography-chart",
            statistics
        );

        createNewsSectorChart(
            "news-sector-chart",
            statistics
        );

    } catch (error) {

        /*
         * Charts are optional.
         * A chart failure must never prevent
         * Market News articles from rendering.
         */
        console.warn(
            "ELG FMS: chart rendering failed.",
            error
        );

    }

}

/*
 * Earliest publication date in the current 14-day window
 * (SGT). The History tab starts from the month before it.
 */
function getCurrentWindowStartDate() {

    const dates =
        (state.data.marketNews?.analyses ?? [])
            .map(
                article =>
                    String(
                        article.publishedAtSgt ?? ""
                    ).slice(0, 10)
            )
            .filter(
                date =>
                    /^\d{4}-\d{2}-\d{2}$/.test(date)
            )
            .sort();


    return dates[0] ?? null;

}


function initializeNewsTabs() {

    qsa("[data-news-tab]").forEach(
        button => {

            button.addEventListener(
                "click",
                () => {

                    const tab =
                        button.dataset.newsTab;


                    if (
                        tab !== "current" &&
                        tab !== "history"
                    ) {

                        return;

                    }


                    state.news.tab =
                        tab;


                    qsa("[data-news-tab]")
                        .forEach(
                            other => {

                                const active =
                                    other.dataset.newsTab ===
                                    tab;


                                other.classList.toggle(
                                    "active",
                                    active
                                );


                                other.setAttribute(
                                    "aria-selected",
                                    String(active)
                                );

                            }
                        );


                    const currentPanel =
                        qs(
                            "#market-news-current"
                        );


                    const historyPanel =
                        qs(
                            "#market-news-history"
                        );


                    if (currentPanel) {

                        currentPanel.hidden =
                            tab !== "current";

                    }


                    if (historyPanel) {

                        historyPanel.hidden =
                            tab !== "history";

                    }


                    if (tab === "history") {

                        openNewsHistory({
                            startDate:
                                getCurrentWindowStartDate(),
                            getLinker:
                                () => fundLinker
                        });

                    }


                    if (tab === "current") {

                        requestAnimationFrame(
                            () => {

                                renderNewsCharts();

                            }
                        );

                    }

                }
            );

        }
    );

}


function renderNewsMetadata() {

    const news =
        state.data.marketNews;


    if (!news) {

        return;

    }


    setText(
        "#market-news-generated",
        news.generatedAtSgt
            ? formatNewsDate(
                news.generatedAtSgt,
                {
                    includeTime: true
                }
            )
            : "—"
    );


    const windowLabel =
        news.windowDays
            ? `${news.windowDays}-day rolling window`
            : "Rolling window";


    setText(
        "#market-news-window",
        windowLabel
    );


    renderNewsSummary();

}


function initializeNewsState() {

    const marketNews =
        state.data.marketNews ?? {
            analyses: [],
            generatedAtSgt: null,
            timezone: "Asia/Singapore",
            timezoneLabel: "SGT",
            windowDays: 14,
            articleCount: 0
        };


    state.news.state =
        createNewsState(
            marketNews
        );


    state.news.initialized =
        true;


    state.news.search =
        "";

    state.news.category = [];

    state.news.importance = [];

    state.news.sentiment = [];

    state.news.fund = [];

    state.news.assetClass = [];

    state.news.geography = [];

    state.news.sector = [];


    const fundSelect =
        qs("#market-news-fund");


    if (fundSelect) {

        fundSelect.value =
            "ALL";

    }


    /*
     * Keep the module's internal filter state
     * synchronized with the application state.
     */
    state.news.state.searchTerm =
        "";

    state.news.state.selectedCategory =
        "ALL";

    state.news.state.selectedImportance =
        "ALL";

    state.news.state.selectedSentiment =
        "ALL";


    renderNewsFilterOptions();

    renderNewsTagOptions();

    renderNewsDynamicOptions();

    renderNewsSummary();

    renderMarketNews();

}


/* ============================================================
   APPLICATION DATA
   ============================================================ */

async function loadApplication() {

    state.loading = true;

    state.error = null;

    setLoadingState();


    const errorPanel =
        qs("#application-error");


    if (errorPanel) {

        errorPanel.classList.remove(
            "is-visible"
        );

        errorPanel.innerHTML = "";

    }


    /*
     * Load the two data sets independently so each view
     * renders as soon as its own data arrives. The small
     * market-news file no longer waits for the large
     * bid_history.json download.
     */
    /*
     * Fund Explorer needs data/funds.json only, so it renders
     * as soon as that file arrives - before the large BID
     * history finishes downloading.
     */
    const fundsOnly =
        loadFundsOnly();


    const explorerTask =
        fundsOnly.then(
            ({ funds, raw }) => {

                setLoadedUpdateTime(
                    "funds",
                    raw?.generatedAtUtc ?? null
                );

                try {

                    initializeFundExplorer({
                        funds,
                        generatedAtUtc:
                            raw?.generatedAtUtc ?? null
                    });

                } catch (error) {

                    console.warn(
                        "ELG FMS: fund explorer failed.",
                        error
                    );

                }

            }
        );


    const fundTask =
        loadFundData(fundsOnly).then(
            fundData => {

                state.data.funds =
                    fundData.funds ??
                    [];

                state.data.bidHistory =
                    fundData.bidHistory ??
                    [];

                initializePerformance();

                updateFundUniverseStatus();

                initializeNewsFundLinks();

            }
        );


    const newsTask =
        loadMarketNews().then(
            marketNews => {

                setLoadedUpdateTime(
                    "analysis",
                    marketNews?.generatedAtSgt ?? null
                );

                state.data.marketNews =
                    marketNews ?? {

                        analyses: [],

                        generatedAtSgt: null,

                        timezone: null,

                        timezoneLabel: null,

                        windowDays: null,

                        articleCount: 0

                    };

                initializeMarketNews();

            }
        );


    const results =
        await Promise.allSettled([
            explorerTask,
            fundTask,
            newsTask
        ]);


    state.loading = false;


    const failure =
        results.find(
            result =>
                result.status === "rejected"
        );


    if (!failure) {

        state.initialized = true;

        setReadyState();

        return;

    }


    const error =
        failure.reason instanceof Error
            ? failure.reason
            : new Error(
                String(failure.reason)
            );


    console.error(
        "ELG FMS application initialization failed:",
        error
    );


    state.initialized = false;

    state.error = error;

    setErrorState(
        error.message
    );

}


/* ============================================================
   NEWS ↔ FUND LINKS
   ============================================================ */

function renderNewsFundOptions() {

    if (!fundLinker) {

        return;

    }


    const options =
        fundLinker.funds
            .map(
                fund => `
                    <option value="${escapeAttribute(
                        fund.fundIdentifier ??
                        fund.fundCode ??
                        ""
                    )}">
                        ${escapeHtml(fund.fundName ?? "")}${
                            fund.fundCode
                                ? ` (${escapeHtml(fund.fundCode)})`
                                : ""
                        }
                    </option>
                `
            )
            .join("");


    ["#market-news-fund", "#history-fund"].forEach(
        selector => {

            const select =
                qs(selector);


            if (!select) {

                return;

            }


            const current =
                select.value;


            select.innerHTML =
                `<option value="ALL">All funds</option>` +
                options;


            select.value =
                [...select.options].some(
                    option =>
                        option.value === current
                )
                    ? current
                    : "ALL";

        }
    );

}


function initializeNewsFundLinks() {

    try {

        fundLinker =
            createFundLinker(
                state.data.funds
            );

    } catch (error) {

        console.warn(
            "ELG FMS: news fund links failed.",
            error
        );

        fundLinker = null;

        return;

    }


    renderNewsFundOptions();


    if (state.news.initialized) {

        renderNewsDynamicOptions();

        renderNewsSummary();

        renderMarketNews();

    }


    refreshNewsHistory();

}


/* ============================================================
   FUND UNIVERSE STATUS
   ============================================================ */

function updateFundUniverseStatus() {

    const fundCount =
        state.data.funds.length;


    const element =
        qs("[data-fund-universe-count]");


    if (element) {

        element.textContent =
            String(fundCount);

    }


    /*
     * If the footer contains a dynamic fund count,
     * update it without requiring a dedicated element.
     */
    const footerSource =
        qs(".footer-source");


    if (
        footerSource &&
        fundCount > 0 &&
        !footerSource.dataset.initialized
    ) {

        footerSource.textContent =
            `Prudential Singapore fund data · ${fundCount} funds`;

        footerSource.dataset.initialized =
            "true";

    }

}


/* ============================================================
   WINDOW RESIZE
   ============================================================ */

function initializeResizeHandling() {

    let resizeTimer = null;


    window.addEventListener(
        "resize",
        () => {

            clearTimeout(
                resizeTimer
            );


            resizeTimer =
                setTimeout(
                    () => {

                        if (
                            state.currentView ===
                            "news"
                        ) {

                            try {

                                renderNewsCharts();

                            } catch {

                                // Ignore chart resize errors.

                            }

                        }

                    },
                    150
                );

        }
    );

}


/* ============================================================
   APPLICATION DIAGNOSTICS
   ============================================================ */

function exposeDiagnostics() {

    window.VGratFMS = {

        getState() {

            return state;

        },

        getPerformance(
            period = state.selectedPeriod
        ) {

            return state.performance[
                normalizePeriod(period)
            ];

        },

        getNews() {

            return {

                ...state.news,

                visibleItems:
                    getFilteredNews()

            };

        },

        reload() {

            return loadApplication();

        }

    };

}


/* ============================================================
   INITIALIZATION
   ============================================================ */

async function initializeApplication() {

    initializeTheme();

    initializeThemeToggle();

    initializeNavToggle();

    initializeSettings();

    /*
     * Filter dropdowns (Market News, Fund Explorer, Monitoring):
     * themed menus whose highlight follows the colour palette.
     * Phones keep the native picker.
     */
    try {
        enhanceSelects(".main-content select:not(#explorer-sort-mobile)");
    } catch (error) {
        console.warn("ELG FMS: dropdown styling failed.", error);
    }

    try {
        initializeUpdateSchedule();
    } catch (error) {
        console.warn("ELG FMS: update schedule failed.", error);
    }

    initializeNavigation();

    initializePerformanceTabs();

    initializeResizeHandling();

    exposeDiagnostics();

    await loadApplication();

}


/* ============================================================
   DOM READY
   ============================================================ */

if (
    document.readyState ===
    "loading"
) {

    document.addEventListener(
        "DOMContentLoaded",
        () => {

            initializeApplication()
                .catch(
                    error => {

                        console.error(
                            "ELG FMS startup error:",
                            error
                        );

                        setErrorState(
                            error instanceof Error
                                ? error.message
                                : String(error)
                        );

                    }
                );

        },
        {
            once: true
        }
    );

} else {

    initializeApplication()
        .catch(
            error => {

                console.error(
                    "ELG FMS startup error:",
                    error
                );

                setErrorState(
                    error instanceof Error
                        ? error.message
                        : String(error)
                );

            }
        );

}


/* ============================================================
   END OF FILE
   ============================================================ */
