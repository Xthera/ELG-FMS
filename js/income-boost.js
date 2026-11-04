/* ============================================================
   PRUINDEX INCOME BOOST (SERIES 1) CALCULATOR
   Source: PRUIndex Income Boost Product Information Pack
   (accurate as at 2 September 2025). Checked against the pack's
   sample Policy Illustration and yield comparison tables.

   Face Value = total premiums payable.
   Months 1-12:   guaranteed  2.3% x f0 x FV / 12
   Months 13-180: max(0, index return x participation rate)
                  x FV x factor / 12
                  factor starts at f0 (0.2 for 5-pay, 0.1 for 10-pay)
                  and rises by f0 each policy year until it is 1.
   Maturity:      102% x FV + non-guaranteed maturity bonus.
   Accumulate:    cash benefits earn interest, compounded, from the
                  start of the month they are paid.

   Index levels: data/income_boost_indices.json, built up daily by
   the "Fetch Income Boost Indices" workflow.
   ============================================================ */

const DATA_URL = "data/income_boost_indices.json";
const POLICY_MONTHS = 180;

const INDEXES = [
    {
        code: "UBSMSTS",
        label: "UBS MASTR SGD Hedged Index",
        fullName: "UBS Multi Asset Strategy Tactical Rotation SGD Hedged Index",
        avgPr: 0.43,
        minPr: 0.10
    },
    {
        code: "SPXFCSGD",
        label: "S&P 500 FC Index (SGD Hedged)",
        fullName: "S&P 500 FC TCA 0.50% Decrement Index (SGD) ER",
        avgPr: 0.34,
        minPr: 0.05
    },
    {
        code: "BXIISC6S",
        label: "Barclays Shiller Allocator Index (SGD)",
        fullName: "Shiller Barclays CAPE® Allocator 6 Dynamic Risk Control (SGD) Index",
        avgPr: 0.59,
        minPr: 0.09
    }
];

// From the pack's Policy Illustration (Barclays index) and yield tables.
// The 10-pay maturity bonus at the lower rate isn't shown in the pack:
// it is scaled from the 5-pay figures and marked as an estimate.
const SCENARIOS = {
    current: {
        label: "Illustration at 4.25% (rate of return 3.6%)",
        rate: 0.036,
        accumulation: 0.025,
        bonus: { 5: 0.065, 10: 0.055 }
    },
    lower: {
        label: "Illustration at 3.00% (rate of return 2.6%)",
        rate: 0.026,
        accumulation: 0.0125,
        bonus: { 5: 0.035, 10: 0.03 },
        bonusEstimate: { 10: true }
    }
};

const PREMIUM_LIMITS = {
    5: { min: 5000, max: 3000000 },
    10: { min: 2400, max: 1500000 }
};

const STORAGE_KEY = "elg-fms-income-boost";

const state = {
    term: 5,
    premium: 5000,
    index: "BXIISC6S",
    option: "payout",
    basis: "illustration",
    scenario: "current",
    rate: 0.036,
    bonus: 0.065,
    accumulation: 0.025,
    pr: 0.59,
    start: ""
};

let initialized = false;
let active = false;          // Income Boost is the chosen plan
let data = null;
let dataError = null;


/* ------------------------------------------------------------
   formatting
------------------------------------------------------------- */

const qs = (selector, root = document) => root.querySelector(selector);
const qsa = (selector, root = document) => [...root.querySelectorAll(selector)];

function escapeHtml(value) {
    return String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;");
}

// Same money format as the PVA / PVW Plan Calculator (js/plan-calculator.js):
// whole dollars "S$25,000"; with digits = 2, cents only when the amount
// isn't a whole dollar ("S$9.58", "S$75"); "—" when there is no value.
function money(value, digits = 0) {
    if (value === null || value === undefined || !Number.isFinite(value)) {
        return "—";
    }
    const sign = value < 0 ? "−" : "";
    const abs = Math.abs(value);
    if (digits > 0 && Math.abs(abs - Math.round(abs)) > 0.004) {
        return `${sign}S$${abs.toLocaleString("en-SG", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    }
    return `${sign}S$${Math.round(abs).toLocaleString("en-SG")}`;
}

// Same as the Plan Calculator: trailing zeros trimmed (3.60 -> 3.6%, 59.00 -> 59%)
function pct(value, digits = 2) {
    if (!Number.isFinite(value)) {
        return "—";
    }
    const text = (value * 100).toFixed(digits);
    return `${digits > 0 ? text.replace(/\.?0+$/, "") : text}%`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function formatDate(iso) {
    if (!iso) {
        return "—";
    }
    const [y, m, d] = iso.split("-").map(Number);
    return `${d} ${MONTHS[m - 1]} ${y}`;
}

function formatMonth(iso) {
    const [y, m] = iso.split("-").map(Number);
    return `${MONTHS[m - 1]} ${y}`;
}

// The 15th of the month `offset` months after `iso` (YYYY-MM or YYYY-MM-DD)
function fifteenth(iso, offset = 0) {
    const [y, m] = iso.split("-").map(Number);
    const index = y * 12 + (m - 1) + offset;
    const year = Math.floor(index / 12);
    const month = (index % 12) + 1;
    return `${year}-${String(month).padStart(2, "0")}-15`;
}


/* ------------------------------------------------------------
   product rules
------------------------------------------------------------- */

function firstFactor(term) {
    return term === 5 ? 0.2 : 0.1;
}

// Factor applied to payout month m (1-180)
function factor(term, m) {
    const f0 = firstFactor(term);
    if (m <= 12) {
        return f0;
    }
    const year = Math.floor((m - 13) / 12);
    return Math.min(1, Math.round(f0 * (year + 1) * 10) / 10);
}

function indexInfo(code) {
    return INDEXES.find(item => item.code === code) ?? INDEXES[2];
}

function seriesFor(code) {
    return data?.indices?.find(item => item.code === code) ?? null;
}

// Level on a date: the last close on or before it (previous trading day)
function levelOn(series, iso) {
    const rows = series.observations;
    let lo = 0;
    let hi = rows.length - 1;
    let found = -1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (rows[mid][0] <= iso) {
            found = mid;
            lo = mid + 1;
        } else {
            hi = mid - 1;
        }
    }
    return found < 0 ? null : { date: rows[found][0], level: rows[found][1] };
}

// One 12-month segment created on `created`
function segment(series, created, pr) {
    const matures = fifteenth(created, 12);
    if (!series || created < series.firstDate || matures > series.latestDate) {
        return null;
    }
    const start = levelOn(series, created);
    const end = levelOn(series, matures);
    if (!start || !end) {
        return null;
    }
    const indexReturn = end.level / start.level - 1;
    return {
        created,
        matures,
        startLevel: start.level,
        endLevel: end.level,
        indexReturn,
        rate: Math.max(0, indexReturn * pr)
    };
}

/*
   Project the policy. rateFor(m) gives the rate of return used for
   payout month m >= 13, plus any segment details.
*/
function project({ term, premium, option, bonus, accumulation }, rateFor) {
    const fv = premium * term;
    const f0 = firstFactor(term);
    const monthlyInterest = Math.pow(1 + accumulation, 1 / 12) - 1;
    const months = [];

    for (let m = 1; m <= POLICY_MONTHS; m += 1) {
        if (m <= 12) {
            months.push({
                m,
                guaranteed: (0.023 * f0 * fv) / 12,
                nonGuaranteed: 0,
                factor: f0,
                rate: null,
                source: "guaranteed"
            });
            continue;
        }
        const info = rateFor(m);
        const f = factor(term, m);
        months.push({
            m,
            guaranteed: 0,
            nonGuaranteed: (info.rate * fv * f) / 12,
            factor: f,
            rate: info.rate,
            source: info.source,
            segment: info.segment ?? null
        });
    }

    months.forEach(row => {
        row.cash = row.guaranteed + row.nonGuaranteed;
    });

    // Accumulated value at the end of month `upTo`
    const accumulatedAt = upTo => months
        .filter(row => row.m <= upTo)
        .reduce((sum, row) => sum + row.cash * Math.pow(1 + monthlyInterest, upTo + 1 - row.m), 0);

    const years = [];
    let cumulative = 0;

    for (let y = 1; y <= 15; y += 1) {
        const rows = months.filter(row => row.m > (y - 1) * 12 && row.m <= y * 12);
        const g = rows.reduce((s, r) => s + r.guaranteed, 0);
        const ng = rows.reduce((s, r) => s + r.nonGuaranteed, 0);
        cumulative += g + ng;
        const paid = premium * Math.min(y, term);
        const accumulated = option === "accumulate" ? accumulatedAt(y * 12) : 0;
        years.push({
            year: y,
            paid,
            guaranteed: g,
            nonGuaranteed: ng,
            cumulative,
            accumulated,
            death: 1.01 * paid + accumulated,
            accidentalDeath: 1.05 * paid + accumulated,
            maturity: y === 15 ? 1.02 * fv + bonus * fv + accumulated : null
        });
    }

    const totalCash = cumulative;
    const totalGuaranteedCash = months.reduce((s, r) => s + r.guaranteed, 0);
    const accumulatedCash = option === "accumulate" ? accumulatedAt(POLICY_MONTHS) : 0;
    const maturityBase = 1.02 * fv;
    const maturityBonus = bonus * fv;
    const cashAtMaturity = option === "accumulate" ? accumulatedCash : totalCash;
    const totalBenefit = maturityBase + maturityBonus + cashAtMaturity;

    // Yield: premiums at the start of each policy year; payouts counted
    // at the start of their month (matches the pack's illustrated yields)
    const flows = [];
    for (let y = 0; y < term; y += 1) {
        flows.push([12 * y, -premium]);
    }
    if (option === "payout") {
        months.forEach(row => flows.push([row.m - 1, row.cash]));
        flows.push([POLICY_MONTHS, maturityBase + maturityBonus]);
    } else {
        flows.push([POLICY_MONTHS, maturityBase + maturityBonus + accumulatedCash]);
    }

    return {
        fv,
        months,
        years,
        totalCash,
        totalGuaranteedCash,
        accumulatedCash,
        cashAtMaturity,
        maturityBase,
        maturityBonus,
        totalBenefit,
        totalPremiums: fv,
        irr: irr(flows)
    };
}

function irr(flows) {
    const value = rate => flows.reduce((sum, [t, amount]) => sum + amount / Math.pow(1 + rate, t / 12), 0);
    let lo = -0.5;
    let hi = 0.5;
    if (value(lo) * value(hi) > 0) {
        return NaN;
    }
    for (let i = 0; i < 200; i += 1) {
        const mid = (lo + hi) / 2;
        if (value(mid) > 0) {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    return (lo + hi) / 2;
}

// Every monthly segment that has fully matured in the saved history
function allSegments(series, pr) {
    if (!series) {
        return [];
    }
    const list = [];
    let created = fifteenth(series.firstDate, series.firstDate.slice(8) > "15" ? 1 : 0);
    while (fifteenth(created, 12) <= series.latestDate) {
        const seg = segment(series, created, pr);
        if (seg) {
            list.push(seg);
        }
        created = fifteenth(created, 1);
    }
    return list;
}


/* ------------------------------------------------------------
   inputs
------------------------------------------------------------- */

function readNumber(id, fallback) {
    const value = Number(String(qs(id)?.value ?? "").replace(/[^0-9.\-]/g, ""));
    return Number.isFinite(value) && String(qs(id)?.value ?? "").trim() !== "" ? value : fallback;
}

function applyScenario(name) {
    state.scenario = name;
    const scenario = SCENARIOS[name];
    if (!scenario) {
        return;
    }
    state.rate = scenario.rate;
    state.accumulation = scenario.accumulation;
    state.bonus = scenario.bonus[state.term];
    qs("#ib-rate").value = (state.rate * 100).toFixed(2);
    qs("#ib-acc").value = (state.accumulation * 100).toFixed(2);
    qs("#ib-bonus").value = (state.bonus * 100).toFixed(2);
}

function syncFromInputs() {
    state.premium = readNumber("#ib-premium", 0);
    state.index = qs("#ib-index").value;
    state.rate = readNumber("#ib-rate", 0) / 100;
    state.bonus = readNumber("#ib-bonus", 0) / 100;
    state.accumulation = readNumber("#ib-acc", 0) / 100;
    state.pr = readNumber("#ib-pr", indexInfo(state.index).avgPr * 100) / 100;
    state.start = qs("#ib-start").value;
}

function save() {
    try {
        const { term, premium, index, option, basis, scenario } = state;
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ term, premium, index, option, basis, scenario }));
    } catch {
        /* storage unavailable */
    }
}

function restore() {
    try {
        const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
        if (saved && typeof saved === "object") {
            if ([5, 10].includes(saved.term)) state.term = saved.term;
            if (Number(saved.premium) > 0) state.premium = Number(saved.premium);
            if (INDEXES.some(item => item.code === saved.index)) state.index = saved.index;
            if (["payout", "accumulate"].includes(saved.option)) state.option = saved.option;
            if (["illustration", "history"].includes(saved.basis)) state.basis = saved.basis;
            if (["current", "lower", "custom"].includes(saved.scenario)) state.scenario = saved.scenario;
        }
    } catch {
        /* storage unavailable */
    }
}

function setChoice(selector, attr, value) {
    qsa(selector).forEach(button => {
        const active = button.dataset[attr] === String(value);
        button.classList.toggle("active", active);
        button.setAttribute(button.getAttribute("role") === "tab" ? "aria-selected" : "aria-checked", String(active));
    });
}

function problems() {
    const list = [];
    const limits = PREMIUM_LIMITS[state.term];
    const info = indexInfo(state.index);

    if (!(state.premium > 0)) {
        list.push("Enter the annual premium.");
    } else if (state.premium < limits.min || state.premium > limits.max) {
        list.push(`Annual premium for ${state.term}-pay must be ${money(limits.min)} to ${money(limits.max)}.`);
    } else if (Math.round(state.premium) % 10 !== 0) {
        list.push("The premium must be in multiples of $10.");
    }
    if (state.rate < 0) {
        list.push("The rate of return can't be negative (the guaranteed minimum is 0%).");
    }
    if (state.basis === "history") {
        if (state.pr < info.minPr) {
            list.push(`The participation rate can't be below the guaranteed minimum of ${pct(info.minPr, 0)} for this index.`);
        }
        const series = seriesFor(state.index);
        if (!series) {
            list.push("No saved history for this index yet. Run the \"Fetch Income Boost Indices\" workflow once to start building it.");
        } else if (!state.start) {
            list.push("Choose the first segment month.");
        }
    }
    return list;
}


/* ------------------------------------------------------------
   rendering
------------------------------------------------------------- */

function renderDataStatus() {
    const box = qs("#ib-data-status");
    const info = indexInfo(state.index);
    const series = seriesFor(state.index);

    if (dataError && !data) {
        box.innerHTML = `<span class="ib-status is-warn">Index history not available yet</span> Run the "Fetch Income Boost Indices" workflow once to start building it.`;
        return;
    }
    if (!data) {
        box.textContent = "Loading index history…";
        return;
    }
    if (!series) {
        const failure = data.failures?.[state.index];
        const blocked = /HTTP 403/.test(failure?.message ?? "");
        const reason = blocked
            ? "The index provider's website doesn't allow automatic downloads, so this history is added by hand: save the provider's 10Y Export into data/manual (see data/manual/README.txt)."
            : failure
                ? `The last update couldn't fetch it (${formatDate(String(failure.lastAttemptUtc ?? "").slice(0, 10))}).`
                : "It will appear after the next index update.";
        box.innerHTML = `<span class="ib-status is-warn">No history for ${escapeHtml(info.label)} yet</span> `
            + `<span${failure ? ` title="${escapeHtml(failure.message ?? "")}"` : ""}>${escapeHtml(reason)} Illustration rates work as normal.</span>`;
        return;
    }
    const status = series.updateStatus?.status ?? "ok";
    // S&P blocks automatic updates; its levels come from data/manual
    const fromManual = status !== "ok" && /data\/manual/.test(series.updateStatus?.message ?? "");
    box.innerHTML = `
        <span class="ib-status ${status === "ok" || fromManual ? "is-ok" : "is-warn"}">${status === "ok" ? "Up to date" : fromManual ? "From your manual export" : "Last update failed – showing saved history"}</span>
        <strong>${escapeHtml(info.fullName)}</strong> ·
        ${Number(series.latestLevel).toLocaleString("en-SG", { maximumFractionDigits: 3 })} on ${formatDate(series.latestDate)} ·
        history ${formatDate(series.firstDate)} – ${formatDate(series.latestDate)} (${series.observationCount.toLocaleString("en-SG")} days) ·
        <a href="${escapeHtml(series.sourceUrl)}" target="_blank" rel="noopener">source</a>`;
}

function renderForm() {
    setChoice("[data-ib-term]", "ibTerm", state.term);
    setChoice("[data-ib-option]", "ibOption", state.option);
    setChoice("[data-ib-basis]", "ibBasis", state.basis);

    const info = indexInfo(state.index);
    const limits = PREMIUM_LIMITS[state.term];
    qs("#ib-premium-note").textContent =
        `Face Value ${money(state.premium * state.term)} · ${state.term}-pay range ${money(limits.min)} – ${money(limits.max)} a year`;
    qs("#ib-history").hidden = state.basis !== "history";
    qs("#ib-rate-label").textContent = state.basis === "history"
        ? "Rate of return for segments not matured yet (%)"
        : "Rate of return (%)";
    qs("#ib-pr-note").textContent =
        `Average ${pct(info.avgPr, 0)} as shown in the Policy Illustration; guaranteed minimum ${pct(info.minPr, 0)}.`;
    qs("#ib-bonus-note").textContent = SCENARIOS[state.scenario]?.bonusEstimate?.[state.term]
        ? "Estimate: the pack doesn't show this figure for 10-pay at the lower rate."
        : "Non-guaranteed. From the pack's illustrations.";

    const series = seriesFor(state.index);
    const startInput = qs("#ib-start");
    if (series) {
        const first = fifteenth(series.firstDate, series.firstDate.slice(8) > "15" ? 1 : 0);
        startInput.min = first.slice(0, 7);
        startInput.max = series.latestDate.slice(0, 7);
        if (!startInput.value || startInput.value < startInput.min || startInput.value > startInput.max) {
            // Default: the latest start that has 5 years of matured segments
            const fiveBack = fifteenth(series.latestDate, -(12 * 5 + 12));
            startInput.value = (fiveBack >= first ? fiveBack : first).slice(0, 7);
        }
        state.start = startInput.value;
    }
}

function rateSource() {
    if (state.basis !== "history") {
        return () => ({ rate: state.rate, source: "assumed" });
    }
    const series = seriesFor(state.index);
    const firstCreated = fifteenth(state.start);
    return m => {
        const created = fifteenth(firstCreated, m - 13);
        const seg = segment(series, created, state.pr);
        return seg
            ? { rate: seg.rate, source: "actual", segment: seg }
            : { rate: state.rate, source: "assumed", segment: { created, matures: fifteenth(created, 12) } };
    };
}

function tile(label, value, note = "") {
    return `<div class="calc-tile"><span>${label}</span><strong>${value}</strong>${note ? `<em>${note}</em>` : ""}</div>`;
}

/* ------------------------------------------------------------
   form state: like PVA/PVW, the projection is only worked out when
   Generate is clicked; until the form is complete the button stays
   disabled and "Before you generate" lists what's missing
------------------------------------------------------------- */

function renderValidation() {
    const list = problems();
    const missing = qs("#ib-missing");
    const generate = qs("#ib-generate");

    if (missing) {
        missing.hidden = !list.length;
        missing.innerHTML = list.length
            ? `<strong>Before you generate:</strong><ul>${list.map(text => `<li>${escapeHtml(text)}</li>`).join("")}</ul>`
            : "";
    }
    if (generate) {
        generate.disabled = list.length > 0;
    }
}

function render() {
    renderForm();
    renderDataStatus();
    renderValidation();
}


/* ------------------------------------------------------------
   Projected values popup (shared with PVA/PVW: #calc-results-dialog)
------------------------------------------------------------- */

const charts = {};

function destroyCharts() {
    for (const key of Object.keys(charts)) {
        charts[key]?.destroy();
        delete charts[key];
    }
}

function cssVar(name, fallback) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

// The scenarios shown side by side in the Policy illustration table
function scenarioList() {
    if (state.basis === "history") {
        return [{
            key: "history",
            head: `Historical replay · first segment ${formatDate(fifteenth(state.start))} · participation ${pct(state.pr, 0)}`,
            inputs: { ...state },
            rateFor: rateSource()
        }];
    }
    if (state.scenario === "custom") {
        return [{
            key: "custom",
            head: `At rate of return of ${pct(state.rate)} a year`,
            inputs: { ...state },
            rateFor: () => ({ rate: state.rate, source: "assumed" })
        }];
    }
    return [
        ["lower", "3.00%"],
        ["current", "4.25%"]
    ].map(([key, illustrated]) => {
        const scenario = SCENARIOS[key];
        return {
            key,
            head: `At ${illustrated} illustrated investment return (rate of return ${pct(scenario.rate)})`,
            inputs: { ...state, rate: scenario.rate, bonus: scenario.bonus[state.term], accumulation: scenario.accumulation },
            rateFor: () => ({ rate: scenario.rate, source: "assumed" })
        };
    });
}

function generate() {
    const out = qs("#calc-results");
    const dialog = qs("#calc-results-dialog");

    if (!out || problems().length) {
        renderValidation();
        return;
    }

    const info = indexInfo(state.index);
    const isHistory = state.basis === "history";
    const accumulate = state.option === "accumulate";
    const scenarios = scenarioList().map(item => ({ ...item, result: project(item.inputs, item.rateFor) }));
    const main = scenarios.find(item => item.key === state.scenario) ?? scenarios[scenarios.length - 1];
    const r = main.result;
    const actual = r.months.filter(row => row.source === "actual").length;
    const fullFrom = state.term === 5 ? 61 : 121;

    const scenarioHead = scenarios.map(item => `<th colspan="3" class="calc-scenario-head">${escapeHtml(item.head)}</th>`).join("");
    const scenarioCols = scenarios.map(() => `
        <th>Monthly cash benefit<div class="calc-th-note">in the year's last month</div></th>
        <th>${accumulate ? "Accumulated cash benefit" : "Cash benefit paid to date"}</th>
        <th>Maturity value<div class="calc-th-note">${accumulate ? "incl. accumulated cash benefit" : "102% of Face Value + bonus"}</div></th>
    `).join("");

    const segmentRows = isHistory ? r.months.filter(row => row.m >= 13).map(row => {
        const seg = row.segment;
        const isActual = row.source === "actual";
        return `<tr class="${isActual ? "" : "ib-projected"}">
            <td>Month ${row.m} · ${formatMonth(seg.matures)}</td>
            <td>${formatDate(seg.created)}</td>
            <td>${formatDate(seg.matures)}</td>
            <td>${isActual ? seg.startLevel.toFixed(3) : "—"}</td>
            <td>${isActual ? seg.endLevel.toFixed(3) : "—"}</td>
            <td class="${isActual ? (seg.indexReturn < 0 ? "is-negative" : "is-positive") : ""}">${isActual ? pct(seg.indexReturn) : "—"}</td>
            <td>${pct(row.rate)}</td>
            <td>${row.factor.toFixed(1)}</td>
            <td>${money(row.cash, 2)}</td>
            <td>${isActual ? "Actual" : "Assumed"}</td>
        </tr>`;
    }).join("") : "";

    const segments = allSegments(seriesFor(state.index), isHistory ? state.pr : info.avgPr);
    const backtest = segments.length ? (() => {
        const rates = segments.map(s => s.rate).sort((a, b) => a - b);
        const average = rates.reduce((sum, value) => sum + value, 0) / rates.length;
        const zero = rates.filter(value => value === 0).length;
        const recent = segments.slice(-60);
        const recentAverage = recent.reduce((sum, s) => sum + s.rate, 0) / recent.length;
        const pr = isHistory ? state.pr : info.avgPr;
        return `
        <details class="calc-details" ${isHistory ? "open" : ""}>
            <summary>Every 12-month segment in the saved ${escapeHtml(info.label)} history (at ${pct(pr, 0)} participation)</summary>
            <div class="calc-tiles">
                ${tile("Segments in saved history", segments.length.toLocaleString("en-SG"), `${formatMonth(segments[0].created)} – ${formatMonth(segments[segments.length - 1].created)}`)}
                ${tile("Average rate of return", pct(average), `median ${pct(rates[Math.floor(rates.length / 2)])}`)}
                ${tile("Last 60 segments", pct(recentAverage), "average rate of return")}
                ${tile("Segments paying nothing", `${zero} (${pct(zero / segments.length, 0)})`, "index fell over the 12 months")}
                ${tile("Best segment", pct(rates[rates.length - 1]), "rate of return")}
                ${tile("Illustration rates", "2.6% / 3.6%", "for comparison")}
            </div>
            <div class="calc-chart-card">
                <div class="calc-chart-wrap"><canvas id="ib-backtest-chart" role="img" aria-label="Index return and rate of return for every 12-month segment"></canvas></div>
            </div>
        </details>`;
    })() : "";

    out.innerHTML = `
        <div class="calc-tiles">
            ${tile("Total premiums", money(r.totalPremiums), `${money(state.premium)} a year for ${state.term} years · Face Value ${money(r.fv)}`)}
            ${tile("Monthly cash benefit, months 1–12", money(r.months[0].cash, 2), "Guaranteed")}
            ${isHistory
                ? tile("Monthly cash benefit, month 180", money(r.months[POLICY_MONTHS - 1].cash, 2), `${actual} of 168 payouts use actual index returns`)
                : tile(`Monthly cash benefit from month ${fullFrom}`, money(r.months[POLICY_MONTHS - 1].cash, 2), `at ${pct(main.inputs.rate)} rate of return`)}
            ${tile(accumulate ? "Accumulated cash benefit" : "Total cash benefit", money(accumulate ? r.accumulatedCash : r.totalCash), `${money(r.totalGuaranteedCash)} guaranteed${accumulate ? ` · ${pct(main.inputs.accumulation)} interest` : ""}`)}
            ${tile("Maturity value", money(r.maturityBase + r.maturityBonus), `${money(r.maturityBase)} guaranteed + ${money(r.maturityBonus)} bonus`)}
            ${tile("Total benefit at maturity", money(r.totalBenefit), `${pct(r.totalBenefit / r.totalPremiums, 0)} of premiums · yield ${pct(r.irr)} a year`)}
        </div>

        <h3 class="calc-section-title">Projection chart</h3>
        <div class="calc-chart-card">
            <div class="calc-chart-wrap">
                <canvas id="ib-projection-chart" role="img" aria-label="Cash benefit paid each policy year; the same figures are in the policy illustration table below"></canvas>
            </div>
        </div>

        <h3 class="calc-section-title">Policy illustration</h3>
        <div class="table-wrap calc-table-wrap">
            <table class="data-table calc-table">
                <thead>
                    <tr>
                        <th rowspan="2">End of Policy Year</th>
                        <th rowspan="2">Premiums paid to date</th>
                        <th rowspan="2">Guaranteed death benefit<div class="calc-th-note">101% of premiums paid</div></th>
                        ${scenarioHead}
                    </tr>
                    <tr>${scenarioCols}</tr>
                </thead>
                <tbody>
                    ${r.years.map((row, i) => `
                        <tr class="${row.year === state.term ? "calc-row-term" : ""}">
                            <td>Policy Year ${row.year}</td>
                            <td>${money(row.paid)}</td>
                            <td>${money(1.01 * row.paid)}</td>
                            ${scenarios.map(item => {
                                const y = item.result.years[i];
                                return `
                                    <td>${money(y.monthly ?? item.result.months[row.year * 12 - 1].cash, 2)}</td>
                                    <td>${money(accumulate ? y.accumulated : y.cumulative)}</td>
                                    <td>${y.maturity == null ? "—" : `<strong>${money(y.maturity)}</strong>`}</td>`;
                            }).join("")}
                        </tr>`).join("")}
                </tbody>
            </table>
        </div>

        <details class="calc-details">
            <summary>Cash benefit by year (${escapeHtml(main.head.replace(/^At /, "at "))})</summary>
            <div class="table-wrap calc-table-wrap">
                <table class="data-table calc-table">
                    <thead><tr>
                        <th>End of Policy Year</th><th>Factor</th><th>Guaranteed cash benefit</th><th>Non-guaranteed cash benefit</th><th>Paid in the year</th><th>Paid to date</th>${accumulate ? "<th>Accumulated value</th>" : ""}
                    </tr></thead>
                    <tbody>
                        ${r.years.map(row => `
                            <tr>
                                <td>Policy Year ${row.year}</td>
                                <td>${r.months[row.year * 12 - 1].factor.toFixed(1)}</td>
                                <td>${row.guaranteed ? money(row.guaranteed) : "—"}</td>
                                <td>${row.nonGuaranteed ? money(row.nonGuaranteed) : "—"}</td>
                                <td>${money(row.guaranteed + row.nonGuaranteed)}</td>
                                <td>${money(row.cumulative)}</td>
                                ${accumulate ? `<td>${money(row.accumulated)}</td>` : ""}
                            </tr>`).join("")}
                    </tbody>
                </table>
            </div>
        </details>

        ${isHistory ? `
        <details class="calc-details" open>
            <summary>Segment by segment (${actual} of 168 matured in the saved history)</summary>
            <div class="table-wrap calc-table-wrap">
                <table class="data-table calc-table ib-table">
                    <thead><tr>
                        <th>Payout</th><th>Segment created</th><th>Matures</th><th>Level at start</th><th>Level at maturity</th>
                        <th>Index return</th><th>Rate of return</th><th>Factor</th><th>Monthly cash benefit</th><th></th>
                    </tr></thead>
                    <tbody>${segmentRows}</tbody>
                </table>
            </div>
        </details>` : ""}

        ${backtest}

        <div class="calc-notes">
            <strong>How this is worked out.</strong>
            PRUIndex Income Boost (Series 1) rules from the product information pack (2 September 2025). Face Value is the total premiums payable (${money(r.fv)}).
            Months 1–12 pay a guaranteed 2.3% × ${firstFactor(state.term).toFixed(1)} × Face Value a year. From month 13, each month pays that segment's 12-month index return × participation rate (never below 0%) × Face Value × factor ÷ 12;
            the factor starts at ${firstFactor(state.term).toFixed(1)} and rises by ${firstFactor(state.term).toFixed(1)} each policy year until it reaches 1.0 from month ${fullFrom}.
            ${isHistory
                ? `Historical replay uses the saved ${escapeHtml(info.fullName)} levels on the 15th of each month (previous trading day if needed) with one participation rate for every segment; segments that haven't matured yet use ${pct(state.rate)}. Actual participation rates are declared by Prudential each month, and past performance is not indicative of future performance.`
                : "The illustration rates are the Policy Illustration's rates of return; they are the same for every index."}
            At maturity the policy pays 102% of Face Value plus a non-guaranteed maturity bonus${accumulate ? ", plus the accumulated cash benefit, which earns non-guaranteed interest from the month each payment is made" : ""}.
            The death benefit shown is 101% of premiums paid (105% for accidental death)${accumulate ? " plus accumulated cash benefit" : ""}; the policy pays the higher of this and 101% of the surrender value, which isn't shown because the pack doesn't give surrender values.
            The yield assumes premiums at the start of each policy year. These are illustrations only; only the first 12 months of cash benefit and 102% of Face Value at maturity are guaranteed.
        </div>`;

    const title = qs("#calc-results-title");
    const subtitle = qs("#calc-results-subtitle");
    if (title) {
        title.textContent = "Projected values";
    }
    if (subtitle) {
        subtitle.textContent = `PRUIndex Income Boost · ${money(state.premium)} yearly for ${state.term} years · ${info.label} · ${accumulate ? "Accumulate" : "Pay out"}`;
    }

    if (dialog && !dialog.open) {
        dialog.showModal?.();
    }
    out.closest(".calc-dialog-body")?.scrollTo(0, 0);

    // Draw after the popup is open so the charts can size themselves
    drawCharts(main, segments, isHistory ? state.pr : info.avgPr);
}

function drawCharts(main, segments, pr) {
    destroyCharts();
    if (typeof window.Chart !== "function") {
        return;
    }

    const muted = cssVar("--text-muted", "#8b98a5");
    const grid = cssVar("--border-subtle", "rgba(255,255,255,0.08)");
    const accent = cssVar("--accent", "#8fb6d9");
    const guaranteed = cssVar("--series-3", "#199e70");
    const nonGuaranteed = cssVar("--series-4", "#c98500");
    const compact = value => Math.abs(value) >= 1e6 ? `S$${(value / 1e6).toFixed(1)}m` : Math.abs(value) >= 1e3 ? `S$${Math.round(value / 1e3)}k` : `S$${Math.round(value)}`;
    const years = main.result.years;

    const projection = qs("#ib-projection-chart");
    if (projection) {
        charts.projection = new window.Chart(projection, {
            data: {
                labels: years.map(row => `Year ${row.year}`),
                datasets: [
                    { type: "bar", label: "Guaranteed cash benefit", data: years.map(row => +row.guaranteed.toFixed(2)), backgroundColor: guaranteed, stack: "cash", yAxisID: "y" },
                    { type: "bar", label: "Non-guaranteed cash benefit", data: years.map(row => +row.nonGuaranteed.toFixed(2)), backgroundColor: nonGuaranteed, stack: "cash", yAxisID: "y" },
                    { type: "line", label: main.inputs.option === "accumulate" ? "Accumulated cash benefit" : "Cash benefit paid to date", data: years.map(row => +(main.inputs.option === "accumulate" ? row.accumulated : row.cumulative).toFixed(2)), borderColor: accent, backgroundColor: accent, pointRadius: 2, tension: 0.2, yAxisID: "y1" }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                interaction: { mode: "index", intersect: false },
                plugins: {
                    legend: { labels: { color: muted } },
                    tooltip: { callbacks: { label: ctx => `${ctx.dataset.label}: ${money(ctx.parsed.y, 2)}` } }
                },
                scales: {
                    x: { stacked: true, ticks: { color: muted }, grid: { color: grid } },
                    y: { stacked: true, beginAtZero: true, title: { display: true, text: "Paid in the year", color: muted }, ticks: { color: muted, callback: compact }, grid: { color: grid } },
                    y1: { position: "right", beginAtZero: true, title: { display: true, text: "To date", color: muted }, ticks: { color: muted, callback: compact }, grid: { drawOnChartArea: false } }
                }
            }
        });
    }

    const backtest = qs("#ib-backtest-chart");
    if (backtest && segments.length) {
        charts.backtest = new window.Chart(backtest, {
            type: "line",
            data: {
                labels: segments.map(s => formatMonth(s.created)),
                datasets: [
                    { label: "Index return (12 months)", data: segments.map(s => +(s.indexReturn * 100).toFixed(2)), borderColor: muted, borderWidth: 1, pointRadius: 0, tension: 0.2 },
                    { label: `Rate of return at ${pct(pr, 0)} participation`, data: segments.map(s => +(s.rate * 100).toFixed(2)), borderColor: accent, backgroundColor: accent + "33", borderWidth: 2, pointRadius: 0, fill: true, tension: 0.2 }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                interaction: { mode: "index", intersect: false },
                plugins: {
                    legend: { labels: { color: muted } },
                    tooltip: { callbacks: { label: ctx => `${ctx.dataset.label}: ${ctx.parsed.y.toFixed(2)}%` } }
                },
                scales: {
                    x: { ticks: { color: muted, maxTicksLimit: 10 }, grid: { color: grid } },
                    y: { ticks: { color: muted, callback: v => v + "%" }, grid: { color: grid } }
                }
            }
        });
    }
}


/* ------------------------------------------------------------
   setup
------------------------------------------------------------- */

async function loadData() {
    try {
        const response = await fetch(DATA_URL, { cache: "no-cache" });
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        data = await response.json();
    } catch (error) {
        dataError = error;
        console.warn("ELG FMS: Income Boost index history not loaded.", error);
    }
}

function bind() {
    const root = qs("#ib-setup");

    qsa("[data-ib-term]", root).forEach(button => button.addEventListener("click", () => {
        state.term = Number(button.dataset.ibTerm);
        if (state.scenario !== "custom") {
            applyScenario(state.scenario);
        }
        update();
    }));

    qsa("[data-ib-option]", root).forEach(button => button.addEventListener("click", () => {
        state.option = button.dataset.ibOption;
        update();
    }));

    qsa("[data-ib-basis]", root).forEach(button => button.addEventListener("click", () => {
        state.basis = button.dataset.ibBasis;
        update();
    }));

    qs("#ib-scenario").addEventListener("change", event => {
        if (event.target.value === "custom") {
            state.scenario = "custom";
        } else {
            applyScenario(event.target.value);
        }
        update();
    });

    ["#ib-rate", "#ib-bonus", "#ib-acc"].forEach(id => qs(id).addEventListener("input", () => {
        state.scenario = "custom";
        qs("#ib-scenario").value = "custom";
        update();
    }));

    qs("#ib-index").addEventListener("change", () => {
        qs("#ib-pr").value = (indexInfo(qs("#ib-index").value).avgPr * 100).toFixed(0);
        update();
    });

    ["#ib-premium", "#ib-pr", "#ib-start"].forEach(id => qs(id).addEventListener("input", update));

    qs("#ib-generate")?.addEventListener("click", generate);
}

function update() {
    syncFromInputs();
    save();
    render();
}

function initializeIncomeBoost() {
    if (initialized) {
        return;
    }
    initialized = true;

    restore();

    const select = qs("#ib-index");
    select.innerHTML = INDEXES.map(item => `<option value="${item.code}">${escapeHtml(item.label)}</option>`).join("");
    select.value = state.index;
    qs("#ib-premium").value = state.premium;
    qs("#ib-pr").value = (indexInfo(state.index).avgPr * 100).toFixed(0);
    qs("#ib-scenario").value = state.scenario;
    applyScenario(state.scenario === "custom" ? "current" : state.scenario);
    if (state.scenario === "custom") {
        state.scenario = "custom";
        qs("#ib-scenario").value = "custom";
    }

    bind();
    syncFromInputs();
    render();

    loadData().then(() => {
        syncFromInputs();
        if (active) {
            render();
        }
    });
}

/* ------------------------------------------------------------
   PLAN CALCULATOR: Income Boost is a third plan choice next to
   PRUVantage Assure II / Wealth III. Choosing it hides their
   fields and shows these; choosing either of them switches back.
   (js/plan-calculator.js only reacts to [data-calc-plan] buttons.)
------------------------------------------------------------- */

const PVA_DESCRIPTION_KEY = "pvaDescription";

function showIncomeBoost(on) {
    active = on;

    const card = qs(".calc-setup-card");
    const ibButton = qs("[data-ib-plan]");
    const description = qs("#calc-page-description");

    card?.classList.toggle("is-income-boost", on);
    qs("#ib-setup").hidden = !on;

    ibButton?.classList.toggle("active", on);
    ibButton?.setAttribute("aria-checked", String(on));

    if (description) {
        description.dataset[PVA_DESCRIPTION_KEY] ??= description.textContent.trim();
        description.textContent = on
            ? "Project a PRUIndex Income Boost policy's monthly cash benefit and maturity value at the Policy Illustration rates, or replay it against the index's actual history."
            : description.dataset[PVA_DESCRIPTION_KEY];
    }

    if (on) {
        qsa("[data-calc-plan]").forEach(button => {
            button.classList.remove("active");
            button.setAttribute("aria-checked", "false");
        });
        initializeIncomeBoost();
        render();
    } else {
        destroyCharts();
    }
}

export function initializeIncomeBoostPlan() {
    const choice = qs("#calc-plan-choice");

    if (!choice || !qs("#ib-setup")) {
        return;
    }

    choice.addEventListener("click", event => {
        if (event.target.closest("[data-ib-plan]")) {
            if (!active) {
                showIncomeBoost(true);
            }
            return;
        }

        const plan = event.target.closest("[data-calc-plan]");

        if (plan && active) {
            showIncomeBoost(false);
            // plan-calculator.js ignores a click on the plan it already
            // has, so mark the chosen one here as well
            plan.classList.add("active");
            plan.setAttribute("aria-checked", "true");
        }
    });
}

// For tests
export const _internal = { project, factor, segment, allSegments, irr, fifteenth, SCENARIOS };
