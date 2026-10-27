/* ============================================================
   ELG FMS — ANNEX (PRUDENTIAL PRODUCT BROCHURES)
   ============================================================

   Reads data/brochures.json (written every 2 weeks by the
   "Fetch Brochures" workflow, scripts/fetch_brochures.py) and
   lists every product with links to its brochures and other
   documents on prudential.com.sg.

   Brochures open in a popup, from the copy the workflow saved in
   the Brochure/ folder (or, if there's no copy yet, from
   Prudential's site through Google's document viewer).

   Loaded the first time the Annex is opened, so it never slows
   down the rest of the dashboard.
   ============================================================ */

const DATA_URL = "data/brochures.json";

const GROUP_ORDER = ["Health", "Life", "Wealth", "Legacy Planning", "SRS", "Other"];

const state = {
    loading: null,
    data: null,
    error: null,
    group: "ALL",
    search: ""
};

let bound = false;


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

function safeUrl(value) {
    const url = String(value ?? "");

    return /^https:\/\//i.test(url) ? url : "";
}

function formatSgtDate(iso) {
    if (!iso) return "—";

    const date = new Date(iso);

    if (Number.isNaN(date.getTime())) return "—";

    return date.toLocaleDateString("en-GB", {
        day: "2-digit",
        month: "short",
        year: "numeric",
        timeZone: "Asia/Singapore"
    });
}

function docLabel(doc) {
    if (doc.kind === "brochure") {
        return doc.lang === "CN" ? "Brochure (中文)" : "Brochure (EN)";
    }

    return doc.lang ? `${doc.label} (${doc.lang === "CN" ? "中文" : doc.lang})` : doc.label;
}

/* Brochure/<name>.pdf saved by the workflow (same site) */
function localFile(doc) {
    const file = String(doc.file ?? "");

    return /^Brochure\/[A-Za-z0-9._-]+\.pdf$/.test(file) ? file : "";
}

function matches(product, term) {
    if (!term) return true;

    const haystack = [
        product.name,
        product.group,
        ...placementsOf(product).flatMap(place => [place.group, place.category]),
        ...(Array.isArray(product.tags) ? product.tags : []),
        ...(product.categories ?? []),
        product.description,
        ...(product.documents ?? []).map(doc => doc.label)
    ].join(" ").toLowerCase();

    return term
        .toLowerCase()
        .split(/\s+/)
        .filter(Boolean)
        .every(word => haystack.includes(word));
}


/* ============================================================
   RENDER
   ============================================================ */

function renderCard(product) {
    const docs = product.documents ?? [];

    const brochures = docs.filter(doc => doc.kind === "brochure" && safeUrl(doc.url));

    // Every label that applies - no limit: each place Prudential lists
    // it (e.g. "Critical Illness", "Whole Life") plus Prudential's own tags
    const tags = [...new Set([
        ...placementsOf(product).map(place => place.category && place.category !== place.group ? place.category : place.group),
        ...(Array.isArray(product.tags) ? product.tags : [])
    ].filter(Boolean))]
        .map(tag => `<span class="news-tag annex-tag">${escapeHtml(tag)}</span>`)
        .join("");

    const page = safeUrl(product.pageUrl);

    return `
        <article class="annex-card">

            <h3 class="annex-card-name">
                ${page ? `
                    <a
                        class="annex-card-link"
                        href="${escapeHtml(page)}"
                        target="_blank"
                        rel="noopener noreferrer"
                        title="Open the ${escapeHtml(product.name)} page on prudential.com.sg"
                    >${escapeHtml(product.name)}</a>
                ` : escapeHtml(product.name)}
            </h3>

            ${tags ? `<div class="annex-card-tags">${tags}</div>` : ""}

            ${product.description ? `<p class="annex-card-desc">${escapeHtml(product.description)}</p>` : ""}

            <div class="annex-card-actions">
                ${brochures.map(doc => `
                    <button
                        type="button"
                        class="annex-doc"
                        data-annex-pdf="${escapeHtml(doc.url)}"
                        data-annex-file="${escapeHtml(localFile(doc))}"
                        data-annex-title="${escapeHtml(product.name)}"
                        data-annex-label="${escapeHtml(docLabel(doc))}"
                    >${escapeHtml(docLabel(doc))}</button>
                `).join("")}
            </div>

        </article>
    `;
}

/*
 * Every place Prudential lists a product (a plan can sit under
 * Health > Critical Illness AND Life > Whole Life), in the site's
 * own order. Older lists without placements fall back to the group.
 */
function placementsOf(product) {
    if (Array.isArray(product.placements) && product.placements.length) {
        return product.placements;
    }

    return [{ group: product.group, category: product.group, order: [99, 0, 0] }];
}

function compareOrder(a, b) {
    for (let index = 0; index < 3; index += 1) {
        const diff = (a[index] ?? 0) - (b[index] ?? 0);
        if (diff) return diff;
    }
    return 0;
}

function renderGroups(products) {
    const container = qs("#annex-groups");

    if (!container) return;

    const counts = new Map();

    for (const product of products) {
        for (const group of new Set(placementsOf(product).map(place => place.group))) {
            counts.set(group, (counts.get(group) ?? 0) + 1);
        }
    }

    const groups = GROUP_ORDER.filter(group => counts.has(group));

    if (state.group !== "ALL" && !counts.has(state.group)) {
        state.group = "ALL";
    }

    const chip = (value, label, count) => `
        <button
            type="button"
            class="annex-chip ${state.group === value ? "active" : ""}"
            data-annex-group="${escapeHtml(value)}"
            role="tab"
            aria-selected="${state.group === value}"
        >${escapeHtml(label)}<span class="annex-chip-count">${count}</span></button>
    `;

    container.innerHTML =
        chip("ALL", "All", products.length) +
        groups.map(group => chip(group, group, counts.get(group))).join("");
}

function render() {
    const list = qs("#annex-list");
    const status = qs("#annex-status");

    if (!list || !status) return;

    if (state.error) {
        status.textContent = "";
        list.innerHTML = `
            <div class="annex-empty">
                The brochure list isn't available yet. It appears after the
                “Fetch Brochures” workflow has run on GitHub.
            </div>
        `;
        return;
    }

    if (!state.data) {
        status.textContent = "Loading brochures…";
        list.innerHTML = "";
        return;
    }

    const all = (state.data.products ?? []).filter(product => (product.documents ?? []).length);

    renderGroups(all);

    const shown = all.filter(product =>
        (state.group === "ALL" || placementsOf(product).some(place => place.group === state.group)) &&
        matches(product, state.search)
    );

    const brochureCount = shown.reduce(
        (sum, product) => sum + (product.documents ?? []).filter(doc => doc.kind === "brochure").length,
        0
    );

    status.textContent =
        `${shown.length} product${shown.length === 1 ? "" : "s"} · ${brochureCount} brochure${brochureCount === 1 ? "" : "s"}`;

    if (!shown.length) {
        list.innerHTML = `<div class="annex-empty">No product matches your search.</div>`;
        return;
    }

    // group -> category -> [{ order, product }], as Prudential sorts them
    const byGroup = new Map();

    for (const product of shown) {
        for (const place of placementsOf(product)) {
            if (state.group !== "ALL" && place.group !== state.group) continue;

            if (!byGroup.has(place.group)) byGroup.set(place.group, new Map());

            const categories = byGroup.get(place.group);
            const category = place.category || place.group;

            if (!categories.has(category)) categories.set(category, []);

            categories.get(category).push({ order: place.order ?? [99, 0, 0], product });
        }
    }

    list.innerHTML = [...byGroup.entries()]
        .sort((a, b) => {
            const rank = group => {
                const index = GROUP_ORDER.indexOf(group);
                return index < 0 ? 99 : index;
            };
            return rank(a[0]) - rank(b[0]);
        })
        .map(([group, categories]) => {
            const sections = [...categories.entries()]
                .map(([category, items]) => ({
                    category,
                    items: items.sort((a, b) => compareOrder(a.order, b.order)),
                    first: items.reduce((min, item) => compareOrder(item.order, min) < 0 ? item.order : min, items[0].order)
                }))
                .sort((a, b) => compareOrder(a.first, b.first));

            return `
                <section class="annex-group" aria-label="${escapeHtml(group)}">
                    <h2 class="annex-group-title">${escapeHtml(group)}</h2>
                    ${sections.map(section => `
                        ${section.category !== group ? `<h3 class="annex-subgroup-title">${escapeHtml(section.category)}</h3>` : ""}
                        <div class="annex-grid">
                            ${section.items.map(item => renderCard(item.product)).join("")}
                        </div>
                    `).join("")}
                </section>
            `;
        })
        .join("");
}


/* ============================================================
   PDF POPUP
   - Brochure saved in the Brochure/ folder: drawn page by page
     with PDF.js (works the same on desktop and phones).
   - Not saved (yet): shown through Google's document viewer,
     since Prudential's site doesn't allow its PDFs inside other
     websites.
   ============================================================ */

const PDFJS_URL = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.min.mjs";
const PDFJS_WORKER = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.worker.min.mjs";

let pdfjsPromise = null;

const viewer = {
    doc: null,
    token: 0,
    zoom: 1,
    observer: null
};

function loadPdfJs() {
    if (!pdfjsPromise) {
        pdfjsPromise = import(PDFJS_URL)
            .then(pdfjs => {
                pdfjs.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
                return pdfjs;
            })
            .catch(error => {
                pdfjsPromise = null;
                throw error;
            });
    }

    return pdfjsPromise;
}

function viewerUrl(url) {
    return `https://docs.google.com/viewer?embedded=true&url=${encodeURIComponent(url)}`;
}

function ensurePdfDialog() {
    let dialog = qs("#annex-pdf-dialog");

    if (dialog) return dialog;

    dialog = document.createElement("dialog");
    dialog.id = "annex-pdf-dialog";
    dialog.className = "news-dialog annex-pdf-dialog";
    dialog.setAttribute("aria-labelledby", "annex-pdf-title");

    dialog.innerHTML = `
        <div class="annex-pdf">

            <header class="annex-pdf-header">

                <div class="annex-pdf-heading">
                    <span id="annex-pdf-label" class="annex-pdf-label"></span>
                    <h2 id="annex-pdf-title" class="annex-pdf-title"></h2>
                </div>

                <div class="annex-pdf-actions">
                    <div class="annex-pdf-zoom" data-annex-zoom-group>
                        <button type="button" class="annex-pdf-button" data-annex-zoom="-1" aria-label="Zoom out" title="Zoom out">−</button>
                        <button type="button" class="annex-pdf-button" data-annex-zoom="0" title="Fit to width">Fit</button>
                        <button type="button" class="annex-pdf-button" data-annex-zoom="1" aria-label="Zoom in" title="Zoom in">+</button>
                    </div>
                    <button type="button" class="annex-pdf-button" data-annex-pdf-reload title="Reload the viewer">Reload</button>
                    <a class="annex-pdf-button" data-annex-pdf-download download title="Download the PDF">Download</a>
                    <a class="annex-pdf-button" data-annex-pdf-open target="_blank" rel="noopener noreferrer" title="Open the PDF in a new tab">Open ↗</a>
                    <button type="button" class="news-popup-close" data-annex-pdf-close aria-label="Close" title="Close">×</button>
                </div>

            </header>

            <div class="annex-pdf-body">
                <div class="annex-pdf-loading" data-annex-pdf-loading>Loading PDF…</div>
                <div class="annex-pdf-pages" data-annex-pdf-pages></div>
                <iframe
                    class="annex-pdf-frame"
                    title="Brochure"
                    referrerpolicy="no-referrer"
                    allow="fullscreen"
                    hidden
                ></iframe>
            </div>

        </div>
    `;

    document.body.appendChild(dialog);

    const frame = dialog.querySelector("iframe");
    const loading = dialog.querySelector("[data-annex-pdf-loading]");

    frame.addEventListener("load", () => {
        if (frame.getAttribute("src")) loading.hidden = true;
    });

    dialog.querySelector("[data-annex-pdf-close]").addEventListener("click", () => dialog.close());

    dialog.querySelector("[data-annex-pdf-reload]").addEventListener("click", () => {
        const src = frame.dataset.src;
        if (!src) return;
        loading.hidden = false;
        frame.src = "about:blank";
        setTimeout(() => { frame.src = src; }, 50);
    });

    dialog.querySelectorAll("[data-annex-zoom]").forEach(button => {
        button.addEventListener("click", () => {
            const step = Number(button.dataset.annexZoom);
            viewer.zoom = step === 0
                ? 1
                : Math.min(3, Math.max(0.5, Math.round((viewer.zoom + step * 0.25) * 100) / 100));
            layoutPages(dialog);
        });
    });

    dialog.addEventListener("click", event => {
        if (event.target === dialog) dialog.close();
    });

    dialog.addEventListener("close", () => {
        document.body.classList.remove("has-news-dialog");
        resetViewer(dialog);
    });

    let resizeTimer = null;
    window.addEventListener("resize", () => {
        if (!dialog.open || !viewer.doc) return;
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => layoutPages(dialog), 200);
    });

    return dialog;
}

function resetViewer(dialog) {
    viewer.token += 1;
    viewer.observer?.disconnect();
    viewer.observer = null;
    viewer.doc?.destroy?.();
    viewer.doc = null;
    viewer.zoom = 1;

    const frame = dialog.querySelector("iframe");
    frame.removeAttribute("src");
    frame.dataset.src = "";
    frame.hidden = true;

    dialog.querySelector("[data-annex-pdf-pages]").innerHTML = "";
}

/* Size every page box for the current width/zoom; draw the visible ones. */
function layoutPages(dialog) {
    const container = dialog.querySelector("[data-annex-pdf-pages]");

    if (!viewer.doc || !container) return;

    // "Fit": the popup's width, but no wider than 960px on big screens
    const available = Math.max(200, Math.min(container.clientWidth - 24, 960));
    const width = Math.round(available * viewer.zoom);

    container.querySelectorAll(".annex-pdf-page").forEach(page => {
        const ratio = Number(page.dataset.ratio) || 1.414;
        page.style.width = `${width}px`;
        page.style.height = `${Math.round(width * ratio)}px`;
        page.dataset.drawnWidth = "";
        page.querySelector("canvas")?.remove();
    });

    container.querySelectorAll(".annex-pdf-page").forEach(page => {
        const box = page.getBoundingClientRect();
        const view = container.getBoundingClientRect();
        if (box.bottom > view.top - 400 && box.top < view.bottom + 400) drawPage(page);
    });
}

async function drawPage(pageBox) {
    const token = viewer.token;
    const width = parseFloat(pageBox.style.width);

    if (!viewer.doc || !width || pageBox.dataset.drawnWidth === String(width) || pageBox.dataset.drawing === "1") return;

    pageBox.dataset.drawing = "1";

    try {
        const page = await viewer.doc.getPage(Number(pageBox.dataset.page));
        if (token !== viewer.token) return;

        const base = page.getViewport({ scale: 1 });
        const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
        const viewport = page.getViewport({ scale: (width / base.width) * pixelRatio });

        const canvas = document.createElement("canvas");
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);

        await page.render({ canvas, canvasContext: canvas.getContext("2d"), viewport }).promise;
        if (token !== viewer.token) return;

        pageBox.querySelector("canvas")?.remove();
        pageBox.appendChild(canvas);
        pageBox.dataset.drawnWidth = String(width);
    } catch (error) {
        console.warn("ELG FMS: brochure page failed.", error);
    } finally {
        pageBox.dataset.drawing = "";
    }
}

async function showLocalPdf(dialog, file, url) {
    const token = viewer.token;
    const container = dialog.querySelector("[data-annex-pdf-pages]");
    const loading = dialog.querySelector("[data-annex-pdf-loading]");

    try {
        const pdfjs = await loadPdfJs();
        const doc = await pdfjs.getDocument({ url: file }).promise;

        if (token !== viewer.token) {
            doc.destroy();
            return;
        }

        viewer.doc = doc;

        // Page boxes with the right shape (first page's ratio until each is read)
        const first = await doc.getPage(1);
        const firstView = first.getViewport({ scale: 1 });
        const ratio = firstView.height / firstView.width;

        container.innerHTML = Array.from({ length: doc.numPages }, (_, index) => `
            <div class="annex-pdf-page" data-page="${index + 1}" data-ratio="${ratio}" aria-label="Page ${index + 1}"></div>
        `).join("");

        viewer.observer = new IntersectionObserver(entries => {
            entries.forEach(entry => {
                if (entry.isIntersecting) drawPage(entry.target);
            });
        }, { root: container, rootMargin: "400px 0px" });

        container.querySelectorAll(".annex-pdf-page").forEach(page => viewer.observer.observe(page));

        loading.hidden = true;
        layoutPages(dialog);

        // Correct each page's shape (brochures can mix sizes)
        for (let number = 2; number <= doc.numPages; number += 1) {
            if (token !== viewer.token) return;
            const page = await doc.getPage(number);
            const view = page.getViewport({ scale: 1 });
            const box = container.querySelector(`[data-page="${number}"]`);
            const pageRatio = view.height / view.width;
            if (box && Math.abs(pageRatio - ratio) > 0.01) {
                box.dataset.ratio = String(pageRatio);
                box.style.height = `${Math.round(parseFloat(box.style.width) * pageRatio)}px`;
            }
        }
    } catch (error) {
        console.warn("ELG FMS: saved brochure couldn't be shown; using the online viewer.", error);
        if (token === viewer.token) showOnlinePdf(dialog, url);
    }
}

function showOnlinePdf(dialog, url) {
    const frame = dialog.querySelector("iframe");
    const src = viewerUrl(url);

    dialog.classList.add("is-online");
    dialog.querySelector("[data-annex-pdf-pages]").innerHTML = "";
    dialog.querySelector("[data-annex-pdf-loading]").hidden = false;

    frame.hidden = false;
    frame.dataset.src = src;
    frame.src = src;
}

function openPdf(url, file, title, label, options = {}) {
    if (!safeUrl(url) && !file) return;

    const dialog = ensurePdfDialog();

    resetViewer(dialog);

    dialog.querySelector("#annex-pdf-title").textContent = title || "Brochure";
    dialog.querySelector("#annex-pdf-label").textContent = label || "";
    dialog.querySelector("[data-annex-pdf-loading]").hidden = false;

    const open = dialog.querySelector("[data-annex-pdf-open]");
    const download = dialog.querySelector("[data-annex-pdf-download]");

    open.href = file || url;

    // Saved copy: a real download. Not saved yet: Prudential's file
    // opens in a new tab, where it can be saved (their site doesn't
    // allow downloading it from another website directly).
    download.hidden = options.download === false;
    download.href = file || url;
    download.target = "_blank";
    download.rel = "noopener noreferrer";
    if (file) {
        download.setAttribute("download", file.split("/").pop());
    } else {
        download.removeAttribute("download");
    }

    document.body.classList.add("has-news-dialog");

    if (!dialog.open) dialog.showModal();

    if (file) {
        dialog.classList.remove("is-online");
        showLocalPdf(dialog, file, url);
    } else {
        showOnlinePdf(dialog, url);
    }
}


/* ============================================================
   EVENTS + LOADING
   ============================================================ */

function bind() {
    if (bound) return;

    bound = true;

    qs("#annex-search")?.addEventListener("input", event => {
        state.search = event.target.value.trim();
        render();
    });

    qs("#annex-list")?.addEventListener("click", event => {
        const button = event.target.closest("[data-annex-pdf]");

        if (!button) return;

        openPdf(
            button.dataset.annexPdf,
            button.dataset.annexFile,
            button.dataset.annexTitle,
            button.dataset.annexLabel
        );
    });

    qs("#annex-groups")?.addEventListener("click", event => {
        const chip = event.target.closest("[data-annex-group]");

        if (!chip) return;

        state.group = chip.dataset.annexGroup;
        render();
    });
}

async function load() {
    try {
        const response = await fetch(DATA_URL, { cache: "no-cache" });

        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        state.data = await response.json();
        state.error = null;

        const updated = qs("#annex-updated");

        if (updated) {
            updated.textContent = formatSgtDate(state.data.generatedAtUtc);
        }
    } catch (error) {
        console.warn("ELG FMS: brochures failed to load.", error);
        state.error = error;
    }

    render();
}

/**
 * Called every time the Annex page is shown; loads the data once.
 */
function openAnnex() {
    bind();

    if (!state.loading) {
        state.loading = load();
    }

    return state.loading;
}


export {
    openAnnex,
    openPdf
};
