// ============================================================
// CHANGELOG POPUP
//
// The version number in the footer (#app-version) opens a popup
// listing data/changelog.json, newest version first.
//
// To release a new version: add an entry at the TOP of
// "versions" in data/changelog.json. The footer label updates
// itself from that first entry.
// ============================================================

const SOURCE = "data/changelog.json";

let cache = null;

function escapeHtml(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

function formatDate(iso) {
    const date = new Date(`${iso}T00:00:00`);
    if (Number.isNaN(date.getTime())) return escapeHtml(iso);
    return date.toLocaleDateString("en-SG", { day: "numeric", month: "short", year: "numeric" });
}

async function loadChangelog() {
    if (cache) return cache;
    const response = await fetch(`${SOURCE}?v=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    cache = Array.isArray(data?.versions) ? data.versions : [];
    return cache;
}

function versionMarkup(entry, index) {
    const sections = (entry.sections || [])
        .filter(section => (section.items || []).length)
        .map(section => `
            <section class="changelog-section">
                <h4 class="changelog-section-title" data-kind="${escapeHtml(String(section.title || "").toLowerCase())}">${escapeHtml(section.title)}</h4>
                <ul class="changelog-list">
                    ${section.items.map(item => `<li>${escapeHtml(item)}</li>`).join("")}
                </ul>
            </section>
        `).join("");

    return `
        <article class="changelog-version${index === 0 ? " is-latest" : ""}">
            <header class="changelog-version-header">
                <h3 class="changelog-version-number">${escapeHtml(entry.version)}</h3>
                ${index === 0 ? `<span class="changelog-badge">Latest</span>` : ""}
                ${entry.date ? `<time class="changelog-date" datetime="${escapeHtml(entry.date)}">${formatDate(entry.date)}</time>` : ""}
            </header>
            ${entry.summary ? `<p class="changelog-summary">${escapeHtml(entry.summary)}</p>` : ""}
            ${sections}
        </article>
    `;
}

function ensureDialog() {
    let dialog = document.getElementById("changelog-dialog");
    if (dialog) return dialog;

    dialog = document.createElement("dialog");
    dialog.id = "changelog-dialog";
    dialog.className = "news-dialog changelog-dialog";
    dialog.setAttribute("aria-labelledby", "changelog-title");

    dialog.innerHTML = `
        <div class="changelog">
            <header class="changelog-header">
                <div>
                    <span class="changelog-eyebrow">ELG FMS</span>
                    <h2 id="changelog-title" class="changelog-title">Changelog</h2>
                </div>
                <button type="button" class="news-popup-close" data-changelog-close aria-label="Close" title="Close">×</button>
            </header>
            <div class="changelog-body" data-changelog-body></div>
        </div>
    `;

    document.body.appendChild(dialog);

    dialog.querySelector("[data-changelog-close]").addEventListener("click", () => dialog.close());

    dialog.addEventListener("click", event => {
        if (event.target === dialog) dialog.close();
    });

    dialog.addEventListener("close", () => {
        document.body.classList.remove("has-news-dialog");
        document.getElementById("app-version")?.focus({ preventScroll: true });
    });

    return dialog;
}

async function openChangelog() {
    const dialog = ensureDialog();
    const body = dialog.querySelector("[data-changelog-body]");

    body.innerHTML = `<p class="changelog-status">Loading changelog…</p>`;
    document.body.classList.add("has-news-dialog");
    if (!dialog.open) dialog.showModal();
    body.scrollTop = 0;

    try {
        const versions = await loadChangelog();
        body.innerHTML = versions.length
            ? versions.map(versionMarkup).join("")
            : `<p class="changelog-status">No changes recorded yet.</p>`;
    } catch (error) {
        body.innerHTML = `<p class="changelog-status">The changelog couldn't be loaded. Please try again later.</p>`;
    }
}

function initializeChangelog() {
    const trigger = document.getElementById("app-version");
    if (!trigger) return;

    trigger.addEventListener("click", openChangelog);

    // Keep the footer label in step with the newest entry
    loadChangelog()
        .then(versions => {
            const latest = versions[0]?.version;
            if (latest) {
                trigger.textContent = latest;
                trigger.setAttribute("aria-label", `Version ${latest} – view changelog`);
            }
        })
        .catch(() => {});
}

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initializeChangelog);
} else {
    initializeChangelog();
}
