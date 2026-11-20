// ============================================================
// STYLE (Settings > Style): Glass or Classic
// Sets <html data-style="..."> and remembers the choice in this
// browser. The page's first script already applied the saved
// choice before drawing, so this only wires up the buttons.
// ============================================================

const STORAGE_KEY = "elg-fms-style";
const STYLES = ["glass", "classic"];

function currentStyle() {
    const value = document.documentElement.dataset.style;
    return STYLES.includes(value) ? value : "glass";
}

function markButtons(style) {
    document.querySelectorAll("[data-style-option]").forEach(button => {
        const active = button.dataset.styleOption === style;
        button.classList.toggle("active", active);
        button.setAttribute("aria-pressed", String(active));
    });
}

function applyStyle(style) {
    const choice = STYLES.includes(style) ? style : "glass";
    document.documentElement.dataset.style = choice;
    try {
        localStorage.setItem(STORAGE_KEY, choice);
    } catch {
        /* storage unavailable: still applies for this visit */
    }
    markButtons(choice);
}

// One listener on the page, so the buttons work whenever they appear
document.addEventListener("click", event => {
    const button = event.target.closest?.("[data-style-option]");
    if (button) applyStyle(button.dataset.styleOption);
});

markButtons(currentStyle());
