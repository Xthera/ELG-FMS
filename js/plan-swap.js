// ============================================================
// SMOOTH PLAN SWITCH (Plan Calculator)
//
// Switching between PRUVantage Assure II, PRUVantage Wealth III and
// PRUIndex Income Boost changes the setup form in place: rows appear
// or disappear and the card changes height. smoothSwap() measures the
// card, lets the change happen, then eases the card to its new height
// and fades the form in, so it flows instead of snapping.
//
// Several changes made by the same click (plan-calculator.js and
// income-boost.js both react to it) are merged into one animation.
// ============================================================

const EASE = "cubic-bezier(.2, .8, .2, 1)";
const DURATION = 340;

const reduceQuery = window.matchMedia?.("(prefers-reduced-motion: reduce)");

let pending = null;

export function smoothSwap(card, change) {
    const canAnimate =
        card &&
        typeof card.animate === "function" &&
        card.offsetHeight > 0 &&
        !reduceQuery?.matches;

    if (!canAnimate) {
        change();
        return;
    }

    if (!pending) {
        card.getAnimations?.().forEach(animation => animation.cancel());
        pending = { card, before: card.getBoundingClientRect().height };
        requestAnimationFrame(finish);
    }

    change();
}

function finish() {
    const { card, before } = pending;
    pending = null;

    const after = card.getBoundingClientRect().height;

    if (Math.abs(after - before) > 1) {
        const overflow = card.style.overflow;
        card.style.overflow = "hidden";

        const animation = card.animate(
            [{ height: `${before}px` }, { height: `${after}px` }],
            { duration: DURATION, easing: EASE }
        );

        const done = () => { card.style.overflow = overflow; };
        animation.onfinish = done;
        animation.oncancel = done;
    }

    // Fade the form below the plan buttons (the buttons stay still)
    const form = card.querySelector(".report-form") || card;

    [...form.children].slice(1).forEach(part => {
        if (part.hidden || !part.offsetHeight) return;

        part.animate(
            [{ opacity: 0, transform: "translateY(8px)" }, { opacity: 1, transform: "none" }],
            { duration: DURATION, easing: EASE }
        );
    });
}
