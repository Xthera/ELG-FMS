/* ============================================================
   ELG FMS — NEWS LIST ROWS + ARTICLE POPUP
   ============================================================

   Shared by Market News (current) and History.

   List:   each article is one row showing its title
           (with a small date on the right).
   Click:  opens a popup with
             - Summary
             - Investor impact
             - Reasoning
           plus the source link, badges, tags and the funds
           the article may affect.
   ============================================================ */

import {
    formatNewsDateTime,
    formatNewsDate
} from "./market-news.js";


/*
 * Article registry: rows only carry a key; the popup looks
 * the full record up here.
 */
const registry = new Map();

let dialogBound = false;


/* ============================================================
   HELPERS
   ============================================================ */

function escapeHtml(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

function safeUrl(value) {
    const url = String(value ?? "");

    return /^https?:\/\//i.test(url) ? url : "";
}

function importanceClass(value) {
    const normalized = String(value ?? "").toUpperCase();

    if (normalized === "HIGH") return "news-importance-high";
    if (normalized === "LOW") return "news-importance-low";

    return "news-importance-medium";
}

function sentimentClass(value) {
    const normalized = String(value ?? "").toUpperCase();

    if (normalized === "POSITIVE") return "news-sentiment-positive";
    if (normalized === "NEGATIVE") return "news-sentiment-negative";
    if (normalized === "MIXED") return "news-sentiment-mixed";

    return "news-sentiment-neutral";
}

function articleKey(article) {
    return String(article.articleId ?? article.url ?? article.title ?? "");
}

function tagGroup(label, values) {
    if (!Array.isArray(values) || values.length === 0) {
        return "";
    }

    return `
        <div class="news-popup-tags-row">
            <span class="news-popup-label">${escapeHtml(label)}</span>
            <div class="news-tags">
                ${values.map(value => `<span class="news-tag">${escapeHtml(value)}</span>`).join("")}
            </div>
        </div>
    `;
}

function section(label, text, extraClass = "") {
    if (!text) {
        return "";
    }

    return `
        <section class="news-popup-section ${extraClass}">
            <h3 class="news-popup-label">${escapeHtml(label)}</h3>
            <p>${escapeHtml(text)}</p>
        </section>
    `;
}


/* ============================================================
   LIST ROW
   ============================================================ */

/**
 * @param {object} article        analysis record
 * @param {Array}  links          from createFundLinker().linkArticle
 * @param {string|string[]} [selectedFund] fund id(s) currently filtered on
 */
function renderNewsCard(article, links = [], selectedFund = null) {
    const key = articleKey(article);

    registry.set(key, { article, links, selectedFund });

    return `
        <button
            type="button"
            class="news-row"
            data-news-open="${escapeHtml(key)}"
            aria-haspopup="dialog"
        >
            <span
                class="news-row-dot ${importanceClass(article.importance)}"
                title="${escapeHtml(`${article.importance ?? "MEDIUM"} importance`)}"
                aria-hidden="true"
            ></span>

            <span class="news-row-title">${escapeHtml(article.title ?? "Untitled article")}</span>

            <span class="news-row-date">${escapeHtml(formatNewsDate(article.publishedAtSgt))}</span>
        </button>
    `;
}


/* ============================================================
   POPUP
   ============================================================ */

function ensureDialog() {
    let dialog = document.getElementById("news-dialog");

    if (!dialog) {
        dialog = document.createElement("dialog");
        dialog.id = "news-dialog";
        dialog.className = "news-dialog";
        dialog.setAttribute("aria-labelledby", "news-dialog-title");

        document.body.appendChild(dialog);
    }

    if (!dialogBound) {
        dialogBound = true;

        /* Close on backdrop click */
        dialog.addEventListener("click", event => {
            if (event.target === dialog) {
                dialog.close();
            }
        });

        dialog.addEventListener("close", () => {
            document.body.classList.remove("has-news-dialog");
        });

        /* Open from any list row (current or history) */
        document.addEventListener("click", event => {
            const row = event.target.closest("[data-news-open]");

            if (row) {
                openArticle(row.dataset.newsOpen);
            }
        });
    }

    return dialog;
}

function renderLinkedFunds(links, selectedFund) {
    if (!links.length) {
        return `
            <section class="news-popup-section">
                <h3 class="news-popup-label">Funds that may be affected</h3>
                <p class="news-popup-muted">No direct fund link for this article.</p>
            </section>
        `;
    }

    return `
        <details class="news-popup-funds">
            <summary>
                <span class="news-popup-label">Funds that may be affected (${links.length})</span>
            </summary>

            <ul class="news-linked-funds">
                ${links.map(link => `
                    <li class="${(Array.isArray(selectedFund) ? selectedFund.includes(link.fundId) : link.fundId === selectedFund) ? "is-selected" : ""}">
                        <span class="news-linked-code">${escapeHtml(link.fundCode)}</span>
                        <span class="news-linked-name">${escapeHtml(link.fundName)}</span>
                        <span class="news-linked-reason">${escapeHtml(link.reasons.join(" · "))}</span>
                    </li>
                `).join("")}
            </ul>

            <p class="news-link-note">
                Linked where the fund's researched geography and sector match
                the article (and the asset class fits). An indication of
                possible exposure, not a holdings analysis.
            </p>
        </details>
    `;
}

function openArticle(key) {
    const entry = registry.get(key);

    if (!entry) {
        return;
    }

    const { article, links, selectedFund } = entry;

    const dialog = ensureDialog();

    const url = safeUrl(article.url);

    dialog.innerHTML = `
        <div class="news-popup">

            <header class="news-popup-header">

                <div class="news-popup-meta">
                    <span class="news-source">${escapeHtml(article.source ?? "Unknown source")}</span>
                    <span class="news-date">${escapeHtml(formatNewsDateTime(article.publishedAtSgt))}</span>
                </div>

                <button
                    type="button"
                    class="news-popup-close"
                    aria-label="Close"
                    title="Close"
                    data-news-close
                >×</button>

            </header>

            <h2 id="news-dialog-title" class="news-popup-title">
                ${escapeHtml(article.title ?? "Untitled article")}
            </h2>

            <div class="news-card-badges news-popup-badges">
                <span class="news-badge news-category" data-category="${escapeHtml(String(article.category ?? "MARKET").toUpperCase())}">${escapeHtml(article.category ?? "MARKET")}</span>
                <span class="news-badge ${importanceClass(article.importance)}">${escapeHtml(article.importance ?? "MEDIUM")}</span>
                <span class="news-badge ${sentimentClass(article.sentiment)}">${escapeHtml(article.sentiment ?? "NEUTRAL")}</span>
            </div>

            <div class="news-popup-body">

                ${section("Summary", article.summary)}

                ${section("Investor impact", article.investorImpact, "news-popup-impact")}

                ${section("Reasoning", article.reasoning)}

                <div class="news-popup-tags">
                    ${tagGroup("Asset classes", article.assetClasses)}
                    ${tagGroup("Geographies", article.geographies)}
                    ${tagGroup("Sectors", article.sectors)}
                </div>

                ${renderLinkedFunds(links, selectedFund)}

            </div>

            ${url ? `
                <footer class="news-popup-footer">
                    <a
                        class="news-popup-link"
                        href="${escapeHtml(url)}"
                        target="_blank"
                        rel="noopener noreferrer"
                    >Read the full article on ${escapeHtml(article.source ?? "source")} ↗</a>
                </footer>
            ` : ""}

        </div>
    `;

    dialog.querySelector("[data-news-close]")?.addEventListener("click", () => dialog.close());

    document.body.classList.add("has-news-dialog");

    if (!dialog.open) {
        dialog.showModal();
    }

    dialog.querySelector(".news-popup-body")?.scrollTo(0, 0);
}


/* Bind the row click handler as soon as the module loads. */
if (typeof document !== "undefined") {
    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", ensureDialog, { once: true });
    } else {
        ensureDialog();
    }
}


export {
    renderNewsCard,
    openArticle
};
