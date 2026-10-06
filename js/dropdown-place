/* ============================================================
   VGRAT FMS — FIT A FUND DROPDOWN ON SCREEN
   ============================================================
   Used by every "add a fund" search list (Market Performance
   compare, Monitoring watchlist, Fund Explorer holdings search,
   Report Generation funds and boosters).

   Opens the list downwards when there is room, otherwise upwards,
   and keeps it clear of the sticky header, the footer bar and the
   phone bottom menu. The card around the picker must not clip it
   (see .has-dropdown-picker in style.css).
   ============================================================ */

const MAX_HEIGHT = 280;
const MIN_HEIGHT = 120;
const GAP = 12;

function placeDropdown(list) {
    if (!list) return;

    list.classList.remove("opens-up");
    list.style.maxHeight = "";

    const input = list.parentElement?.querySelector("input");

    if (!input) return;

    const box = input.getBoundingClientRect();

    // Lowest point the list may reach: above the footer / phone menu
    let limit = window.innerHeight;

    for (const selector of [".site-footer", ".main-nav"]) {
        const bar = document.querySelector(selector)?.getBoundingClientRect();

        if (bar && bar.top > box.bottom && bar.top < limit && bar.width > window.innerWidth * 0.6) {
            limit = bar.top;
        }
    }

    const top = Math.max(document.querySelector(".site-header")?.getBoundingClientRect().bottom ?? 0, 0);

    const below = limit - box.bottom - GAP;
    const above = box.top - top - GAP;
    const wanted = Math.min(MAX_HEIGHT, list.scrollHeight + 2);

    if (below >= wanted || below >= above) {
        list.style.maxHeight = `${Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, below))}px`;
    } else {
        list.classList.add("opens-up");
        list.style.maxHeight = `${Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, above))}px`;
    }
}

export { placeDropdown };
