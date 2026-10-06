/* ============================================================
   ELG FMS — MARKET NEWS HISTORY
   ============================================================

   Browses the archived AI analyses stored as

       data/market_news/analysis/history/YYYY/MM/YYYY-MM-DD.json

   Articles move into the archive once they fall outside the
   14-day current window.

   GitHub Pages cannot list folders, so for the selected month
   every day is requested once (in parallel); days without a
   file simply return 404 and are skipped. Results are cached
   per month.
   ============================================================ */

import {
    loadHistoryDate,
    isHistoryNotFoundError,
    sortByPublishedDate
} from "./market-news.js";

import {
    renderNewsCard
} from "./news-cards.js";


const history = {
    initialized: false,
    loading: false,
    year: null,
    month: null,          // 1-12
    maxYear: null,
    maxMonth: null,
    days: [],             // [{ date, analyses }]
    selectedDay: "ALL",
    selectedFund: "ALL",
    cache: new Map(),
    getLinker: () => null,
    requestToken: 0
};


/* ============================================================
   HELPERS
   ============================================================ */

function qs(selector) {
    return document.querySelector(selector);
}

function escapeHtml(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

function pad(number) {
    return String(number).padStart(2, "0");
}

function todaySgt() {
    return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Singapore" });
}

function monthKey(year, month) {
    return `${year}-${pad(month)}`;
}

function monthLabel(year, month) {
    return new Date(Date.UTC(year, month - 1, 1)).toLocaleDateString("en-SG", {
        timeZone: "UTC",
        month: "long",
        year: "numeric"
    });
}

function dayLabel(isoDate) {
    const [year, month, day] = isoDate.split("-").map(Number);

    return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString("en-SG", {
        timeZone: "UTC",
        weekday: "short",
        day: "2-digit",
        month: "short"
    });
}

function shiftMonth(year, month, delta) {
    const date = new Date(Date.UTC(year, month - 1 + delta, 1));

    return [date.getUTCFullYear(), date.getUTCMonth() + 1];
}

function isAfterMax(year, month) {
    return year > history.maxYear || (year === history.maxYear && month > history.maxMonth);
}


/* ============================================================
   LOADING
   ============================================================ */

async function loadMonth(year, month) {
    const key = monthKey(year, month);

    if (history.cache.has(key)) {
        return history.cache.get(key);
    }

    const today = todaySgt();
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();

    const dates = [];

    for (let day = 1; day <= lastDay; day += 1) {
        const date = `${year}-${pad(month)}-${pad(day)}`;

        if (date > today) break;

        dates.push(date);
    }

    const results = await Promise.all(
        dates.map(async date => {
            try {
                const data = await loadHistoryDate(date);

                return {
                    date,
                    analyses: sortByPublishedDate(
                        (data.analyses ?? []).filter(article => article.relevant !== false)
                    )
                };
            } catch (error) {
                if (!isHistoryNotFoundError(error)) {
                    console.warn(`ELG FMS: history ${date} failed.`, error);
                }

                return null;
            }
        })
    );

    const days = results
        .filter(day => day && day.analyses.length > 0)
        .sort((a, b) => (a.date < b.date ? 1 : -1));

    history.cache.set(key, days);

    return days;
}


/* ============================================================
   RENDERING
   ============================================================ */

function renderMonthNav() {
    const label = qs("#history-month-label");

    if (label) {
        label.textContent = monthLabel(history.year, history.month);
    }

    const [nextYear, nextMonth] = shiftMonth(history.year, history.month, 1);

    const next = qs('[data-history-month="1"]');

    if (next) {
        next.disabled = isAfterMax(nextYear, nextMonth) || history.loading;
    }

    const previous = qs('[data-history-month="-1"]');

    if (previous) {
        previous.disabled = history.loading;
    }
}

function renderDays() {
    const container = qs("#history-days");

    if (!container) return;

    if (history.loading || history.days.length === 0) {
        container.innerHTML = "";
        return;
    }

    const total = history.days.reduce((sum, day) => sum + day.analyses.length, 0);

    const chip = (value, text, count) => {
        const active = history.selectedDay === value;

        return `
            <button
                type="button"
                class="history-day${active ? " active" : ""}"
                data-history-day="${escapeHtml(value)}"
                role="tab"
                aria-selected="${active}"
            >
                ${escapeHtml(text)}
                <span class="history-day-count">${count}</span>
            </button>
        `;
    };

    container.innerHTML =
        chip("ALL", "All days", total) +
        history.days.map(day => chip(day.date, dayLabel(day.date), day.analyses.length)).join("");
}

function renderArticles() {
    const list = qs("#history-articles");
    const status = qs("#history-status");

    if (!list || !status) return;

    if (history.loading) {
        status.textContent = `Searching the archive for ${monthLabel(history.year, history.month)}…`;
        list.innerHTML = `<div class="loading-state">Loading archived news…</div>`;
        return;
    }

    if (history.days.length === 0) {
        status.textContent = "";
        list.innerHTML = `
            <div class="empty-news-state">
                <div class="empty-news-icon">◫</div>
                <h3>No archived news for ${escapeHtml(monthLabel(history.year, history.month))}</h3>
                <p>
                    News moves into the archive once it is older than the
                    14-day Current window. Use ‹ to check earlier months.
                </p>
            </div>
        `;
        return;
    }

    const linker = history.getLinker();
    const fund = history.selectedFund;

    const days = history.selectedDay === "ALL"
        ? history.days
        : history.days.filter(day => day.date === history.selectedDay);

    let shown = 0;
    let total = 0;

    const sections = days.map(day => {
        const cards = day.analyses
            .map(article => {
                total += 1;

                const links = linker ? linker.linkArticle(article) : [];

                if (fund !== "ALL" && !links.some(link => link.fundId === fund)) {
                    return "";
                }

                shown += 1;

                return renderNewsCard(article, links, fund !== "ALL" ? fund : null);
            })
            .join("");

        if (!cards) return "";

        return `
            <section class="history-day-group">
                <h3 class="history-day-heading">${escapeHtml(dayLabel(day.date))}</h3>
                <div class="news-list">${cards}</div>
            </section>
        `;
    }).join("");

    status.textContent = fund !== "ALL"
        ? `${shown} of ${total} archived articles linked to this fund`
        : `${total} archived articles`;

    list.innerHTML = sections || `
        <div class="empty-news-state">
            <div class="empty-news-icon">◈</div>
            <h3>No archived news linked to this fund</h3>
            <p>Try another day, another month, or All funds.</p>
        </div>
    `;
}

function render() {
    renderMonthNav();
    renderDays();
    renderArticles();
}


/* ============================================================
   NAVIGATION
   ============================================================ */

async function goToMonth(year, month) {
    if (isAfterMax(year, month)) return;

    history.year = year;
    history.month = month;
    history.selectedDay = "ALL";
    history.loading = true;

    const token = ++history.requestToken;

    render();

    const days = await loadMonth(year, month);

    if (token !== history.requestToken) return;

    history.days = days;
    history.loading = false;

    render();
}

function bindEvents() {
    document.querySelectorAll("[data-history-month]").forEach(button => {
        button.addEventListener("click", () => {
            const [year, month] = shiftMonth(
                history.year,
                history.month,
                Number(button.dataset.historyMonth)
            );

            goToMonth(year, month);
        });
    });

    qs("#history-days")?.addEventListener("click", event => {
        const button = event.target.closest("[data-history-day]");

        if (!button) return;

        history.selectedDay = button.dataset.historyDay;

        renderDays();
        renderArticles();
    });

    qs("#history-fund")?.addEventListener("change", event => {
        history.selectedFund = event.target.value || "ALL";

        renderArticles();
    });
}


/* ============================================================
   PUBLIC API
   ============================================================ */

/**
 * Called the first time the History tab is opened.
 *
 * @param {object}   options
 * @param {string}   options.startDate  ISO date the current window starts
 * @param {Function} options.getLinker  returns the fund linker (or null)
 */
function openNewsHistory({ startDate, getLinker }) {
    history.getLinker = getLinker ?? history.getLinker;

    if (history.initialized) {
        renderArticles();
        return;
    }

    history.initialized = true;

    const today = todaySgt();

    history.maxYear = Number(today.slice(0, 4));
    history.maxMonth = Number(today.slice(5, 7));

    /*
     * Start at the month just before the current window,
     * where the newest archived articles are.
     */
    const anchor = startDate && /^\d{4}-\d{2}-\d{2}$/.test(startDate)
        ? startDate
        : today;

    const [year, month, day] = anchor.split("-").map(Number);

    const dayBefore = new Date(Date.UTC(year, month - 1, day - 1));

    bindEvents();

    goToMonth(dayBefore.getUTCFullYear(), dayBefore.getUTCMonth() + 1);
}

/**
 * Re-render with fresh fund links (e.g. once fund data loads).
 */
function refreshNewsHistory() {
    if (history.initialized && !history.loading) {
        renderArticles();
    }
}


export {
    openNewsHistory,
    refreshNewsHistory
};
