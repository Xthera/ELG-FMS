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
        label: "Illustration at 4.25% (rate of return 3.60%)",
        rate: 0.036,
        accumulation: 0.025,
        bonus: { 5: 0.065, 10: 0.055 }
    },
    lower: {
        label: "Illustration at 3.00% (rate of return 2.60%)",
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
let chart = null;


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

function money(value, digits = 0) {
    if (!Number.isFinite(value)) {
        return "–";
    }
    return "$" + value.toLocaleString("en-SG", {
        minimumFractionDigits: digits,
        maximumFractionDigits: digits
    });
}

function pct(value, digits = 2) {
    return Number.isFinite(value) ? (value * 100).toFixed(digits) + "%" : "–";
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function formatDate(iso) {
    if (!iso) {
        return "–";
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
        box.innerHTML = `<span class="ib-status is-warn">No history for ${escapeHtml(info.label)} yet</span>`
            + (failure ? ` The last update couldn't fetch it (${escapeHtml(formatDate(String(failure.lastAttemptUtc ?? "").slice(0, 10)))}): ${escapeHtml(failure.message ?? "")}` : "");
        return;
    }
    const status = series.updateStatus?.status ?? "ok";
    box.innerHTML = `
        <span class="ib-status ${status === "ok" ? "is-ok" : "is-warn"}">${status === "ok" ? "Up to date" : "Last update failed – showing saved history"}</span>
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

function renderResults() {
    const box = qs("#ib-results");
    const list = problems();

    if (list.length) {
        box.innerHTML = `<div class="calc-problems">Can't calculate yet:<ul>${list.map(p => `<li>${escapeHtml(p)}</li>`).join("")}</ul></div>`;
        destroyChart();
        return;
    }

    const result = project(state, rateSource());
    const info = indexInfo(state.index);
    const isHistory = state.basis === "history";
    const actualMonths = result.months.filter(row => row.source === "actual");

    const basisText = isHistory
        ? `Historical replay: first segment created ${formatDate(fifteenth(state.start))}, ${info.label}, participation rate ${pct(state.pr, 0)}. ${actualMonths.length} of 168 non-guaranteed payouts use actual index returns; the rest use ${pct(state.rate)}.`
        : `${SCENARIOS[state.scenario]?.label ?? `Custom rate of return ${pct(state.rate)}`} applied to every segment.`;

    // Monthly cash benefit by policy year band
    const bands = [];
    for (let y = 1; y <= 15; y += 1) {
        const rows = result.months.filter(row => row.m > (y - 1) * 12 && row.m <= y * 12);
        const amounts = rows.map(row => row.cash);
        bands.push({ y, min: Math.min(...amounts), max: Math.max(...amounts), f: rows[rows.length - 1].factor });
    }

    const yearRows = result.years.map(row => `
        <tr>
            <td>${row.year}</td>
            <td>${money(row.paid)}</td>
            <td>${money(bands[row.year - 1].min, 2)}${bands[row.year - 1].max - bands[row.year - 1].min > 0.005 ? ` – ${money(bands[row.year - 1].max, 2)}` : ""}</td>
            <td>${money(row.guaranteed)}</td>
            <td>${money(row.nonGuaranteed)}</td>
            <td>${money(row.cumulative)}</td>
            ${state.option === "accumulate" ? `<td>${money(row.accumulated)}</td>` : ""}
            <td>${money(row.death)}</td>
            <td>${row.maturity == null ? "" : money(row.maturity)}</td>
        </tr>`).join("");

    const segmentTable = isHistory ? `
        <details class="ib-details" open>
            <summary class="calc-section-title">Segment by segment (${actualMonths.length} matured)</summary>
            <div class="calc-table-wrap">
                <table class="data-table calc-table ib-table">
                    <thead><tr>
                        <th>Payout month</th><th>Segment created</th><th>Matures</th>
                        <th>Level at start</th><th>Level at maturity</th><th>Index return</th>
                        <th>Rate of return</th><th>Factor</th><th>Monthly cash benefit</th><th></th>
                    </tr></thead>
                    <tbody>
                    ${result.months.filter(row => row.m >= 13).map(row => {
                        const seg = row.segment;
                        const actual = row.source === "actual";
                        return `<tr class="${actual ? "" : "ib-projected"}">
                            <td>${row.m} · ${formatMonth(seg.matures)}</td>
                            <td>${formatDate(seg.created)}</td>
                            <td>${formatDate(seg.matures)}</td>
                            <td>${actual ? seg.startLevel.toFixed(3) : ""}</td>
                            <td>${actual ? seg.endLevel.toFixed(3) : ""}</td>
                            <td class="${actual ? (seg.indexReturn < 0 ? "is-negative" : "is-positive") : ""}">${actual ? pct(seg.indexReturn) : ""}</td>
                            <td>${pct(row.rate)}</td>
                            <td>${row.factor.toFixed(1)}</td>
                            <td>${money(row.cash, 2)}</td>
                            <td>${actual ? "Actual" : "Assumed"}</td>
                        </tr>`;
                    }).join("")}
                    </tbody>
                </table>
            </div>
        </details>` : "";

    box.innerHTML = `
        <p class="settings-help ib-basis">${escapeHtml(basisText)}</p>

        <div class="calc-tiles ib-tiles">
            ${tile("Total premiums", money(result.totalPremiums), `${money(state.premium)} a year for ${state.term} years`)}
            ${tile("Monthly cash benefit, months 1–12", money(result.months[0].cash, 2), "Guaranteed")}
            ${isHistory
                ? tile("Monthly cash benefit, month 180", money(result.months[POLICY_MONTHS - 1].cash, 2), result.months[POLICY_MONTHS - 1].source === "actual" ? "Actual index return" : `Assumed ${pct(state.rate)}`)
                : tile(`Monthly cash benefit from month ${state.term === 5 ? 61 : 121}`, money(result.months[POLICY_MONTHS - 1].cash, 2), "Factor 1.0 until maturity")}
            ${tile("Total cash benefit", money(result.totalCash), `${money(result.totalGuaranteedCash)} guaranteed`)}
            ${tile(state.option === "accumulate" ? "Accumulated cash benefit at maturity" : "Maturity value", money(state.option === "accumulate" ? result.accumulatedCash : result.maturityBase + result.maturityBonus), state.option === "accumulate" ? `at ${pct(state.accumulation)} a year (non-guaranteed)` : `${money(result.maturityBase)} guaranteed + ${money(result.maturityBonus)} bonus`)}
            ${tile("Total benefit at maturity", money(result.totalBenefit), `${pct(result.totalBenefit / result.totalPremiums, 0)} of premiums · yield ${pct(result.irr)} a year`)}
        </div>

        <h3 class="calc-section-title">Year by year</h3>
        <div class="calc-table-wrap">
            <table class="data-table calc-table ib-table">
                <thead><tr>
                    <th>End of year</th><th>Premiums paid</th><th>Monthly cash benefit</th>
                    <th>Guaranteed cash</th><th>Non-guaranteed cash</th><th>Total cash to date</th>
                    ${state.option === "accumulate" ? "<th>Accumulated value</th>" : ""}
                    <th>Death benefit</th><th>Maturity value</th>
                </tr></thead>
                <tbody>${yearRows}</tbody>
            </table>
        </div>

        ${segmentTable}

        <p class="settings-help ib-footnote">
            Death benefit shown is 101% of premiums paid${state.option === "accumulate" ? " plus accumulated cash benefit" : ""} (105% if accidental: ${money(result.years[14].accidentalDeath)} at year 15); the policy pays the higher of this and 101% of the surrender value, which isn't shown because the pack doesn't give surrender values.
            Only the first 12 months of cash benefit and 102% of Face Value at maturity are guaranteed.
            ${isHistory ? "Actual segment participation rates are declared by Prudential each month; this replay uses one rate for every segment. Past performance is not indicative of future performance." : ""}
        </p>`;

    renderBacktest();
}

function destroyChart() {
    if (chart) {
        chart.destroy();
        chart = null;
    }
}

function renderBacktest() {
    const card = qs("#ib-backtest");
    if (!active) {
        card.hidden = true;
        return;
    }
    const series = seriesFor(state.index);
    const info = indexInfo(state.index);
    const pr = state.basis === "history" ? state.pr : info.avgPr;
    const segments = allSegments(series, pr);

    if (!segments.length) {
        card.hidden = true;
        destroyChart();
        return;
    }
    card.hidden = false;

    const rates = segments.map(s => s.rate).sort((a, b) => a - b);
    const average = rates.reduce((s, r) => s + r, 0) / rates.length;
    const median = rates[Math.floor(rates.length / 2)];
    const zero = rates.filter(r => r === 0).length;
    const recent = segments.slice(-60);
    const recentAverage = recent.reduce((s, r) => s + r.rate, 0) / recent.length;

    qs("#ib-backtest-summary").innerHTML = `
        <div class="calc-tiles ib-tiles">
            ${tile("Segments in saved history", segments.length.toLocaleString("en-SG"), `${formatMonth(segments[0].created)} – ${formatMonth(segments[segments.length - 1].created)}`)}
            ${tile("Average rate of return", pct(average), `at ${pct(pr, 0)} participation · median ${pct(median)}`)}
            ${tile("Last 60 segments", pct(recentAverage), "average rate of return")}
            ${tile("Segments paying nothing", `${zero} (${pct(zero / segments.length, 0)})`, "index fell over the 12 months")}
            ${tile("Best segment", pct(rates[rates.length - 1]), "rate of return")}
            ${tile("Illustration rates", "2.60% / 3.60%", "for comparison")}
        </div>`;

    if (typeof window.Chart !== "function") {
        return;
    }
    destroyChart();
    const css = getComputedStyle(document.documentElement);
    const accent = css.getPropertyValue("--accent").trim() || "#4f8cff";
    const muted = css.getPropertyValue("--text-muted").trim() || "#888";
    const grid = css.getPropertyValue("--border-subtle").trim() || "rgba(128,128,128,0.2)";

    chart = new window.Chart(qs("#ib-chart"), {
        type: "line",
        data: {
            labels: segments.map(s => formatMonth(s.created)),
            datasets: [
                {
                    label: "Index return (12 months)",
                    data: segments.map(s => +(s.indexReturn * 100).toFixed(2)),
                    borderColor: muted,
                    borderWidth: 1,
                    pointRadius: 0,
                    tension: 0.2
                },
                {
                    label: `Rate of return at ${pct(pr, 0)} participation`,
                    data: segments.map(s => +(s.rate * 100).toFixed(2)),
                    borderColor: accent,
                    backgroundColor: accent + "33",
                    borderWidth: 2,
                    pointRadius: 0,
                    fill: true,
                    tension: 0.2
                }
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

function render() {
    renderForm();
    renderDataStatus();
    renderResults();
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
    qs("#ib-results-card").hidden = !on;
    if (!on) {
        qs("#ib-backtest").hidden = true;
    }

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
