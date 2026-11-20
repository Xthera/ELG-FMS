// ============================================================
// SMOOTH OPENING
// Whatever opens after a click or key press flows in instead of
// popping up:
//   - panels and sections that appear (tabs, show/hide areas)
//     grow open or fade up,
//   - drop-down menus slide down,
//   - <details> sections (e.g. News overview, Alert rules) open
//     and close smoothly,
//   - pop-up windows (fund profile, news, annex, changelog) fade
//     and rise in, and fade out on close,
//   - tables and lists fade when their rows change.
// Only reacts to the user's own clicks / keys, so automatic
// updates (timers, data loading) never flicker. Turned off when
// the device asks for reduced motion.
// ============================================================

const EASE = "cubic-bezier(.2, .8, .2, 1)";
const reduceQuery = window.matchMedia?.("(prefers-reduced-motion: reduce)");
const reduced = () => Boolean(reduceQuery?.matches);

let lastInput = 0;
const markInput = () => { lastInput = performance.now(); };
document.addEventListener("pointerdown", markInput, true);
document.addEventListener("keydown", markInput, true);
const userCaused = () => performance.now() - lastInput < 1500;

const skip = el =>
    reduced() || !el.isConnected || el.closest("[data-no-motion]") || typeof el.animate !== "function";

/* ---------- animations ---------- */

function fadeRise(el) {
    el.animate(
        [{ opacity: 0, transform: "translateY(10px)" }, { opacity: 1, transform: "none" }],
        { duration: 320, easing: EASE }
    );
}

function dropDown(el) {
    el.animate(
        [
            { opacity: 0, transform: "translateY(-6px) scaleY(0.96)", transformOrigin: "top center" },
            { opacity: 1, transform: "none", transformOrigin: "top center" }
        ],
        { duration: 180, easing: EASE }
    );
}

function growOpen(el) {
    const height = el.offsetHeight;
    if (!height) return;

    const cs = getComputedStyle(el);
    const previousOverflow = el.style.overflow;
    el.style.overflow = "hidden";

    const animation = el.animate(
        [
            { height: "0px", opacity: 0, paddingTop: "0px", paddingBottom: "0px", marginTop: "0px", marginBottom: "0px" },
            {
                height: `${height}px`, opacity: 1,
                paddingTop: cs.paddingTop, paddingBottom: cs.paddingBottom,
                marginTop: cs.marginTop, marginBottom: cs.marginBottom
            }
        ],
        { duration: 300, easing: EASE }
    );

    const done = () => { el.style.overflow = previousOverflow; };
    animation.onfinish = done;
    animation.oncancel = done;
}

function softRefresh(el) {
    if (el._motionAt && performance.now() - el._motionAt < 300) return;
    el._motionAt = performance.now();
    el.animate([{ opacity: 0.35 }, { opacity: 1 }], { duration: 240, easing: "ease-out" });
}

/* ---------- things that appear (hidden removed) ---------- */

const isFloating = el => /^(absolute|fixed)$/.test(getComputedStyle(el).position);

const observer = new MutationObserver(records => {
    if (!userCaused() || reduced()) return;

    const shown = [];
    const hiddenParents = new Set();
    const refreshed = new Set();

    for (const record of records) {
        const el = record.target;

        if (record.type === "attributes") {
            if (el.hidden) {
                if (el.parentElement) hiddenParents.add(el.parentElement);
            } else if (record.oldValue !== null) {
                shown.push(el);
            }
            continue;
        }

        // Rows / items replaced in a table or list
        if (record.type === "childList" && [...record.addedNodes].some(n => n.nodeType === 1)) {
            const box = el.closest("tbody, .news-list, .compare-suggestions, .explorer-list, .monitor-lists");
            if (box) refreshed.add(box);
        }
    }

    for (const el of shown) {
        if (skip(el)) continue;

        if (isFloating(el)) {
            dropDown(el);
        } else if (
            el.matches(".page-view, .market-block") ||
            hiddenParents.has(el.parentElement) ||   // one panel swapped for another
            el.offsetHeight > 520
        ) {
            fadeRise(el);
        } else {
            growOpen(el);
        }
    }

    for (const box of refreshed) {
        if (!skip(box) && !box.closest("#update-schedule")) softRefresh(box);
    }
});

observer.observe(document.body, {
    subtree: true,
    attributes: true,
    attributeFilter: ["hidden"],
    attributeOldValue: true,
    childList: true
});

/* ---------- <details> open / close ---------- */

document.addEventListener("click", event => {
    const summary = event.target.closest?.("summary");
    const details = summary?.parentElement;

    if (!(details instanceof HTMLDetailsElement) || summary !== details.querySelector(":scope > summary")) return;
    if (reduced() || typeof details.animate !== "function") return;

    event.preventDefault();

    details._motion?.cancel();

    const opening = !details.open;
    const start = details.offsetHeight;

    let end;
    if (opening) {
        details.open = true;
        end = details.offsetHeight;
    } else {
        details.open = false;
        end = details.offsetHeight;
        details.open = true;
    }

    details.style.overflow = "hidden";

    const animation = details.animate(
        [{ height: `${start}px` }, { height: `${end}px` }],
        { duration: opening ? 320 : 240, easing: EASE }
    );

    details._motion = animation;

    animation.onfinish = () => {
        if (!opening) details.open = false;
        details.style.overflow = "";
        details._motion = null;
    };

    animation.oncancel = () => {
        details.style.overflow = "";
        details._motion = null;
    };
});

/* ---------- pop-up windows (<dialog>) ---------- */

if (window.HTMLDialogElement) {
    const proto = HTMLDialogElement.prototype;
    const nativeClose = proto.close;
    const nativeShowModal = proto.showModal;
    const CLOSE_MS = 190;

    proto.close = function (returnValue) {
        if (!this.open) return;
        if (reduced()) return nativeClose.call(this, returnValue);
        if (this._closing) return;

        this.classList.add("is-closing");
        this._closing = setTimeout(() => {
            this._closing = null;
            this.classList.remove("is-closing");
            nativeClose.call(this, returnValue);
        }, CLOSE_MS);
    };

    proto.showModal = function () {
        if (this._closing) {
            // Re-opened while fading out: stay open
            clearTimeout(this._closing);
            this._closing = null;
            this.classList.remove("is-closing");
            if (this.open) return;
        }
        return nativeShowModal.call(this);
    };

    // Esc key: fade out too
    document.addEventListener("cancel", event => {
        if (event.target instanceof HTMLDialogElement && !reduced()) {
            event.preventDefault();
            event.target.close();
        }
    }, true);
}
