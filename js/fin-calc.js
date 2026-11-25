// ============================================================
// FINANCIAL CALCULATOR (Calculators > Financial)
//
// Twelve everyday planning calculators for client conversations:
//
//   Savings & investing   Investment growth · Savings goal · Returns (CAGR / XIRR)
//   Loans & property      Loan repayment · Property affordability · Refinancing
//   Retirement & CPF      Retirement needs · Drawdown · CPF growth to 55
//   Protection & other    Protection needs · Inflation · Dividend income
//
// Each tool is described once in TOOLS (its fields and a compute()
// function); the form, results, chart, table, copyable summary and
// printable client report are all drawn from that description.
//
// Singapore rules used (checked November 2026):
//   CPF interest      OA 2.5%, SA/MA/RA 4% (floor to 31 Dec 2027);
//                     extra 1% on first $60,000 (OA counts up to $20,000)
//   CPF contributions 2026 rates by age, OW ceiling $8,000/month,
//                     annual salary ceiling $102,000, 2026 allocation ratios
//   Retirement sums   2026 BRS $110,200, FRS $220,400, ERS $440,800;
//                     FRS 2027 $228,200; BHS 2026 $79,000
//   Property loans    TDSR 55%, MSR 30% (HDB / EC), stress-test rate 4%
//                     (bank), HDB loan floor 3%, LTV 75% (55% for long
//                     tenures), HDB loan rate 2.6%
//   Protection        Basic Financial Planning Guide: 9x annual income
//                     death/TPD, 4x critical illness, 3-6 months emergency
// ============================================================

import { createChart, destroyChart } from "./charts.js";

const STORAGE_KEY = "elg-fms-fincalc";

const RULES_FILE = "data/finance_rules.json";

// Built-in copy of the reference data, used until data/finance_rules.json
// (kept up to date by the "Update finance rules" GitHub workflow) loads
const DEFAULT_RULES = {"cpf":{"interest":{"period":"1 October 2026 to 31 December 2026","oa":2.5,"smra":4.0,"hdbLoan":2.6},"extraInterest":{"below55":{"rate":1.0,"cap":60000,"oaCap":20000}},"contribution":{"effective":"2026-01","bands":[{"label":"35 years & below","maxAge":35,"employer":17,"employee":20},{"label":"Above 35 - 45 years","maxAge":45,"employer":17,"employee":20},{"label":"Above 45 - 50 years","maxAge":50,"employer":17,"employee":20},{"label":"Above 50 - 55 years","maxAge":55,"employer":17,"employee":20},{"label":"Above 55 - 60 years","maxAge":60,"employer":16,"employee":18},{"label":"Above 60 - 65 years","maxAge":65,"employer":12.5,"employee":12.5},{"label":"Above 65 - 70 years","maxAge":70,"employer":9,"employee":7.5},{"label":"Above 70 years","maxAge":999,"employer":7.5,"employee":5}]},"allocation":{"effective":"2026-01","bands":[{"label":"35 years & below","maxAge":35,"oa":0.6217,"sa":0.1621,"ma":0.2162},{"label":"Above 35 - 45 years","maxAge":45,"oa":0.5677,"sa":0.1891,"ma":0.2432},{"label":"Above 45 - 50 years","maxAge":50,"oa":0.5136,"sa":0.2162,"ma":0.2702},{"label":"Above 50 - 55 years","maxAge":55,"oa":0.4055,"sa":0.3108,"ma":0.2837},{"label":"Above 55 - 60 years","maxAge":60,"oa":0.353,"sa":0.3382,"ma":0.3088},{"label":"Above 60 - 65 years","maxAge":65,"oa":0.14,"sa":0.44,"ma":0.42},{"label":"Above 65 - 70 years","maxAge":70,"oa":0.0607,"sa":0.303,"ma":0.6363},{"label":"Above 70 years","maxAge":999,"oa":0.08,"sa":0.08,"ma":0.84}]},"owCeiling":{"effective":"2026-01","value":8000},"annualCeiling":102000,"frsByYear":{"2022":192000,"2023":198800,"2024":205800,"2025":213000,"2026":220400,"2027":228200},"frsGrowth":0.035,"bhs":{"year":2026,"value":79000,"growth":0.046}},"property":{"tdsr":0.55,"msr":0.3,"bankStress":4.0,"hdbFloor":3.0,"variableHaircut":0.7,"ltv":0.75,"ltvLong":0.55,"minCash":0.05,"minCashLong":0.1,"reviewed":"2026-11-25","bsd":{"effective":"15 Feb 2023","bands":[[180000,0.01],[180000,0.02],[640000,0.03],[500000,0.04],[1500000,0.05],[null,0.06]]}},"protection":{"lifeMultiple":9,"ciMultiple":4,"emergencyMonths":[3,6]},"sources":{"cpfOpenData":"https://data.gov.sg/collections/40/view","frs":"https://data.gov.sg/datasets/d_b212dff55c98a4c0b3d3d850bf744ad7/view","cpfInterest":"https://www.cpf.gov.sg/service/article/how-are-cpf-interest-rates-determined","bhs":"https://www.cpf.gov.sg/service/article/what-is-the-basic-healthcare-sum","bsd":"https://www.iras.gov.sg/taxes/stamp-duty/for-property/buying-or-acquiring-property/buyer's-stamp-duty-(bsd)","property":"https://www.mas.gov.sg/regulation/explainers/new-private-property-measures"}};

let RULES = DEFAULT_RULES;
let RULES_META = { checkedUtc: null, status: {}, loaded: false };

function mergeRules(base, extra) {
    if (!extra || typeof extra !== "object" || Array.isArray(extra)) return extra ?? base;
    const out = { ...base };
    for (const [key, value] of Object.entries(extra)) {
        out[key] = value && typeof value === "object" && !Array.isArray(value) && base?.[key] && typeof base[key] === "object" && !Array.isArray(base[key])
            ? mergeRules(base[key], value)
            : value;
    }
    return out;
}

async function loadRules() {
    try {
        const day = new Date().toISOString().slice(0, 10);
        const response = await fetch(`${RULES_FILE}?d=${day}`, { cache: "no-cache" });
        if (!response.ok) return;
        const doc = await response.json();
        const { status, checkedUtc, updatedUtc, ...values } = doc;
        RULES = mergeRules(DEFAULT_RULES, values);
        RULES_META = { checkedUtc, updatedUtc, status: status ?? {}, loaded: true };
    } catch {
        /* offline or file missing: keep the built-in copy */
    }
}

// ------------------------------------------------------------
// Tool definitions
// ------------------------------------------------------------

const GROUPS = [
    { id: "save", label: "Savings & investing" },
    { id: "loan", label: "Loans & property" },
    { id: "retire", label: "Retirement & CPF" },
    { id: "other", label: "Protection & other" }
];

const TOOLS = [

    {
        id: "growth",
        group: "save",
        name: "Investment growth",
        blurb: "Grow a lump sum and/or regular monthly investments at an expected return.",
        fields: [
            { key: "initial", label: "Starting amount", type: "money", value: 10000 },
            { key: "monthly", label: "Monthly investment", type: "money", value: 500 },
            { key: "step", label: "Increase monthly investment each year by", type: "percent", value: 0, min: 0, max: 50 },
            { key: "rate", label: "Expected return (% a year)", type: "percent", value: 5, min: -20, max: 30 },
            { key: "years", label: "Years", type: "years", value: 20, min: 1, max: 60 },
            { key: "timing", label: "Invest at", type: "choice", value: "start", options: [["start", "Start of month"], ["end", "End of month"]] },
            { key: "inflation", label: "Inflation, for today's dollars (% a year)", type: "percent", value: 2, min: 0, max: 15 }
        ],
        compute: computeGrowth
    },

    {
        id: "goal",
        group: "save",
        name: "Savings goal",
        blurb: "How much to save each month to reach a target amount.",
        fields: [
            { key: "target", label: "Target amount", type: "money", value: 200000 },
            { key: "todays", label: "Target is in", type: "choice", value: "today", options: [["today", "Today's dollars"], ["future", "Future dollars"]] },
            { key: "inflation", label: "Inflation (% a year)", type: "percent", value: 2, min: 0, max: 15, showIf: v => v.todays === "today" },
            { key: "years", label: "Years to goal", type: "years", value: 10, min: 1, max: 60 },
            { key: "current", label: "Savings set aside already", type: "money", value: 20000 },
            { key: "rate", label: "Expected return (% a year)", type: "percent", value: 4, min: -20, max: 30 },
            { key: "timing", label: "Save at", type: "choice", value: "start", options: [["start", "Start of month"], ["end", "End of month"]] }
        ],
        compute: computeGoal
    },

    {
        id: "returns",
        group: "save",
        name: "Returns (CAGR / XIRR)",
        blurb: "Work out the annualised return of an investment, from a start and end value, or from every top-up and withdrawal.",
        fields: [
            { key: "mode", label: "Method", type: "choice", value: "cagr", options: [["cagr", "Start & end value (CAGR)"], ["irr", "Every cash flow (XIRR)"]] },
            { key: "start", label: "Amount invested", type: "money", value: 10000, showIf: v => v.mode === "cagr" },
            { key: "end", label: "Value now", type: "money", value: 15000, showIf: v => v.mode === "cagr" },
            { key: "income", label: "Dividends / payouts received", type: "money", value: 0, showIf: v => v.mode === "cagr" },
            { key: "years", label: "Years held", type: "number", value: 5, min: 0.1, max: 80, step: 0.1, showIf: v => v.mode === "cagr" },
            { key: "flows", label: "Cash flows", type: "flows", value: defaultFlows(), showIf: v => v.mode === "irr" },
            { key: "valueNow", label: "Value now", type: "money", value: 21000, showIf: v => v.mode === "irr" },
            { key: "valueDate", label: "Value as at", type: "date", value: todayIso(), showIf: v => v.mode === "irr" }
        ],
        compute: computeReturns
    },

    {
        id: "loan",
        group: "loan",
        name: "Loan repayment",
        blurb: "Monthly instalment, total interest and repayment schedule, with optional extra payments.",
        fields: [
            { key: "amount", label: "Loan amount", type: "money", value: 500000 },
            { key: "rate", label: "Interest rate (% a year)", type: "percent", value: 2.6, min: 0, max: 30, rule: "hdbLoan" },
            { key: "years", label: "Loan tenure (years)", type: "years", value: 25, min: 1, max: 40 },
            { key: "extra", label: "Extra payment each month (optional)", type: "money", value: 0 }
        ],
        compute: computeLoan
    },

    {
        id: "afford",
        group: "loan",
        name: "Property affordability",
        blurb: "Maximum loan and property price under MAS TDSR / MSR rules, LTV limits and the cash and CPF available.",
        fields: [
            { key: "property", label: "Property", type: "select", value: "hdb", options: [["hdb", "HDB flat"], ["ec", "EC from developer"], ["private", "Private property / resale EC"]] },
            { key: "lender", label: "Loan from", type: "choice", value: "bank", options: [["bank", "Bank"], ["hdb", "HDB"]], showIf: v => v.property === "hdb" },
            { key: "age", label: "Borrowers' average age", type: "years", value: 35, min: 21, max: 64 },
            { key: "fixed", label: "Fixed monthly income (gross, all borrowers)", type: "money", value: 10000 },
            { key: "variable", label: "Variable monthly income (bonus / commission, average)", type: "money", value: 0 },
            { key: "debts", label: "Other monthly debt payments (car, cards, loans)", type: "money", value: 0 },
            { key: "rate", label: "Actual loan interest rate (% a year)", type: "percent", value: 2.6, min: 0, max: 15, rule: "hdbLoan" },
            { key: "tenure", label: "Loan tenure wanted (years)", type: "years", value: 25, min: 5, max: 35 },
            { key: "cash", label: "Cash available for the purchase", type: "money", value: 100000 },
            { key: "cpf", label: "CPF OA available for the purchase", type: "money", value: 100000 }
        ],
        compute: computeAfford
    },

    {
        id: "refi",
        group: "loan",
        name: "Refinancing",
        blurb: "Compare the current loan with a new rate: monthly saving, interest saved and break-even.",
        fields: [
            { key: "balance", label: "Outstanding loan", type: "money", value: 400000 },
            { key: "years", label: "Remaining tenure (years)", type: "years", value: 20, min: 1, max: 35 },
            { key: "oldRate", label: "Current rate (% a year)", type: "percent", value: 3.5, min: 0, max: 15 },
            { key: "newRate", label: "New rate (% a year)", type: "percent", value: 2.6, min: 0, max: 15 },
            { key: "costs", label: "Switching costs (legal, valuation, penalty)", type: "money", value: 3000 },
            { key: "period", label: "Compare over (years, e.g. lock-in)", type: "years", value: 3, min: 1, max: 35 }
        ],
        compute: computeRefi
    },

    {
        id: "retire",
        group: "retire",
        name: "Retirement needs",
        blurb: "How big a nest egg is needed for the retirement income wanted, and whether current savings get there.",
        fields: [
            { key: "age", label: "Current age", type: "years", value: 35, min: 18, max: 80 },
            { key: "retireAge", label: "Retire at age", type: "years", value: 65, min: 40, max: 85 },
            { key: "lifeAge", label: "Plan to age", type: "years", value: 90, min: 60, max: 110 },
            { key: "need", label: "Monthly income wanted (today's dollars)", type: "money", value: 4000 },
            { key: "other", label: "Other monthly income in retirement, e.g. CPF LIFE (today's dollars)", type: "money", value: 1500 },
            { key: "inflation", label: "Inflation (% a year)", type: "percent", value: 2.5, min: 0, max: 15 },
            { key: "savings", label: "Retirement savings today", type: "money", value: 100000 },
            { key: "monthly", label: "Saving each month until retirement", type: "money", value: 1000 },
            { key: "rateBefore", label: "Return before retirement (% a year)", type: "percent", value: 5, min: -10, max: 20 },
            { key: "rateAfter", label: "Return during retirement (% a year)", type: "percent", value: 3.5, min: -10, max: 20 }
        ],
        compute: computeRetire
    },

    {
        id: "drawdown",
        group: "retire",
        name: "How long will it last",
        blurb: "How long savings last with regular withdrawals, and the most that can be withdrawn for a chosen period.",
        fields: [
            { key: "capital", label: "Savings at the start", type: "money", value: 500000 },
            { key: "withdraw", label: "Monthly withdrawal", type: "money", value: 2500 },
            { key: "step", label: "Increase withdrawal each year by (%)", type: "percent", value: 2, min: 0, max: 15 },
            { key: "rate", label: "Return on the remaining savings (% a year)", type: "percent", value: 4, min: -10, max: 20 },
            { key: "age", label: "Age at the start", type: "years", value: 65, min: 18, max: 100 },
            { key: "target", label: "Should last for (years)", type: "years", value: 25, min: 1, max: 60 }
        ],
        compute: computeDrawdown
    },

    {
        id: "cpf",
        group: "retire",
        name: "CPF growth to 55",
        blurb: "Project Ordinary, Special and MediSave balances to 55 with 2026 contribution, allocation and interest rules.",
        fields: [
            { key: "age", label: "Current age", type: "years", value: 30, min: 16, max: 54 },
            { key: "salary", label: "Monthly salary (gross)", type: "money", value: 5000 },
            { key: "bonus", label: "Bonus (months of salary a year)", type: "number", value: 2, min: 0, max: 24, step: 0.5 },
            { key: "growth", label: "Salary increase each year (%)", type: "percent", value: 3, min: 0, max: 20 },
            { key: "oa", label: "Ordinary Account now", type: "money", value: 20000 },
            { key: "sa", label: "Special Account now", type: "money", value: 10000 },
            { key: "ma", label: "MediSave Account now", type: "money", value: 15000 },
            { key: "to", label: "Project to age", type: "years", value: 55, min: 17, max: 55 }
        ],
        compute: computeCpf
    },

    {
        id: "protect",
        group: "other",
        name: "Protection needs",
        blurb: "Death / TPD and critical illness cover needed versus cover already held, plus the emergency fund.",
        fields: [
            { key: "income", label: "Annual income", type: "money", value: 72000 },
            { key: "years", label: "Years of income to replace (death / TPD)", type: "number", value: 9, min: 0, max: 40, step: 1 },
            { key: "debts", label: "Debts to clear (mortgage, loans)", type: "money", value: 300000 },
            { key: "education", label: "Children's education fund", type: "money", value: 0 },
            { key: "final", label: "Final expenses", type: "money", value: 20000 },
            { key: "assets", label: "Savings & investments that could be used", type: "money", value: 50000 },
            { key: "lifeCover", label: "Existing death / TPD cover", type: "money", value: 200000 },
            { key: "ciYears", label: "Years of income for critical illness", type: "number", value: 4, min: 0, max: 15, step: 1 },
            { key: "ciCover", label: "Existing critical illness cover", type: "money", value: 100000 },
            { key: "expenses", label: "Monthly expenses", type: "money", value: 4000 },
            { key: "emergency", label: "Emergency savings now", type: "money", value: 15000 }
        ],
        compute: computeProtect
    },

    {
        id: "inflation",
        group: "other",
        name: "Inflation",
        blurb: "What an amount will cost in future, or what a future amount is worth today.",
        fields: [
            { key: "mode", label: "Work out", type: "choice", value: "future", options: [["future", "Future cost of today's amount"], ["today", "Today's value of a future amount"]] },
            { key: "amount", label: "Amount", type: "money", value: 100000 },
            { key: "years", label: "Years", type: "years", value: 20, min: 1, max: 80 },
            { key: "rate", label: "Inflation (% a year)", type: "percent", value: 2.5, min: 0, max: 20 }
        ],
        compute: computeInflation
    },

    {
        id: "dividend",
        group: "other",
        name: "Dividend income",
        blurb: "Income from a dividend-paying investment (REITs, bank shares, distribution funds), reinvested or paid out.",
        fields: [
            { key: "amount", label: "Amount invested", type: "money", value: 100000 },
            { key: "yield", label: "Dividend yield (% a year)", type: "percent", value: 5.5, min: 0, max: 30 },
            { key: "divGrowth", label: "Dividend growth (% a year)", type: "percent", value: 1, min: -20, max: 20 },
            { key: "priceGrowth", label: "Price growth (% a year)", type: "percent", value: 0, min: -20, max: 20 },
            { key: "years", label: "Years", type: "years", value: 20, min: 1, max: 60 },
            { key: "freq", label: "Paid", type: "select", value: "4", options: [["12", "Monthly"], ["4", "Quarterly"], ["2", "Half-yearly"], ["1", "Yearly"]] },
            { key: "reinvest", label: "Dividends", type: "choice", value: "payout", options: [["payout", "Paid out"], ["reinvest", "Reinvested"]] },
            { key: "monthly", label: "Add each month (optional)", type: "money", value: 0 }
        ],
        compute: computeDividend
    }
];

// ------------------------------------------------------------
// Formatting and maths helpers
// ------------------------------------------------------------

function todayIso() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function defaultFlows() {
    const year = new Date().getFullYear();
    return [
        { date: `${year - 5}-01-15`, kind: "in", amount: 10000 },
        { date: `${year - 3}-01-15`, kind: "in", amount: 5000 },
        { date: `${year - 1}-06-15`, kind: "out", amount: 1000 }
    ];
}

const money = (value, dp = 0) => {
    if (!Number.isFinite(value)) return "–";
    const sign = value < 0 ? "−" : "";
    return `${sign}S$${Math.abs(value).toLocaleString("en-SG", { minimumFractionDigits: dp, maximumFractionDigits: dp })}`;
};

const pct = (value, dp = 2) => Number.isFinite(value) ? `${(value * 100).toFixed(dp)}%` : "–";

const plain = value => Number(Number(value).toFixed(2)).toString();

const monthlyRate = annualPct => Math.pow(1 + annualPct / 100, 1 / 12) - 1;

const escapeHtml = value => String(value ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function yearsMonths(months) {
    const y = Math.floor(months / 12);
    const m = Math.round(months - y * 12);
    if (m === 12) return `${y + 1} years`;
    return [y ? `${y} year${y === 1 ? "" : "s"}` : "", m ? `${m} month${m === 1 ? "" : "s"}` : ""].filter(Boolean).join(" ") || "0 months";
}

function annuityPayment(principal, ratePerPeriod, periods) {
    if (periods <= 0) return principal;
    if (Math.abs(ratePerPeriod) < 1e-12) return principal / periods;
    return principal * ratePerPeriod / (1 - Math.pow(1 + ratePerPeriod, -periods));
}

function annuityPresentValue(payment, ratePerPeriod, periods) {
    if (periods <= 0) return 0;
    if (Math.abs(ratePerPeriod) < 1e-12) return payment * periods;
    return payment * (1 - Math.pow(1 + ratePerPeriod, -periods)) / ratePerPeriod;
}

function bisect(fn, low, high, iterations = 200) {
    let fLow = fn(low);
    for (let i = 0; i < iterations; i++) {
        const mid = (low + high) / 2;
        const fMid = fn(mid);
        if (Math.abs(fMid) < 1e-9) return mid;
        if ((fMid > 0) === (fLow > 0)) { low = mid; fLow = fMid; } else { high = mid; }
    }
    return (low + high) / 2;
}

// Singapore Buyer's Stamp Duty for residential property (rates from 15 Feb 2023)
function buyersStampDuty(price) {
    const bands = (RULES.property.bsd?.bands ?? []).map(([size, rate]) => [size ?? Infinity, rate]);
    let left = price, duty = 0;
    for (const [size, rate] of bands) {
        const part = Math.min(left, size);
        duty += part * rate;
        left -= part;
        if (left <= 0) break;
    }
    return duty;
}

// ------------------------------------------------------------
// Calculators
// ------------------------------------------------------------

function computeGrowth(v) {
    const m = monthlyRate(v.rate);
    const months = Math.round(v.years * 12);
    let value = v.initial, paid = v.initial, contribution = v.monthly;
    const rows = [];

    for (let month = 1; month <= months; month++) {
        if (v.timing === "start") { value += contribution; paid += contribution; }
        value *= 1 + m;
        if (v.timing !== "start") { value += contribution; paid += contribution; }

        if (month % 12 === 0) {
            const year = month / 12;
            rows.push({ year, paid, value, growth: value - paid, real: value / Math.pow(1 + v.inflation / 100, year) });
            contribution *= 1 + v.step / 100;
        }
    }

    const last = rows.at(-1);

    return {
        tiles: [
            { label: `Value after ${v.years} years`, value: money(last.value), strong: true },
            { label: "Total invested", value: money(last.paid) },
            { label: "Investment growth", value: money(last.growth), note: last.value ? `${pct(last.growth / last.value, 0)} of the final value` : "" },
            { label: "In today's dollars", value: money(last.real), note: `At ${plain(v.inflation)}% inflation a year` }
        ],
        chart: {
            labels: rows.map(r => `Yr ${r.year}`),
            series: [
                { label: "Value", data: rows.map(r => r.value), color: 1, fill: true },
                { label: "Total invested", data: rows.map(r => r.paid), color: "muted", dashed: true }
            ]
        },
        table: {
            head: ["Year", "Total invested", "Value", "Growth", "Today's dollars"],
            rows: rows.map(r => [r.year, money(r.paid), money(r.value), money(r.growth), money(r.real)])
        },
        summary: [
            `Starting with ${money(v.initial)} and investing ${money(v.monthly)} a month${v.step ? ` (rising ${plain(v.step)}% a year)` : ""} at ${plain(v.rate)}% a year,`,
            `the investment could grow to ${money(last.value)} in ${v.years} years, from ${money(last.paid)} invested.`,
            `That is about ${money(last.real)} in today's dollars at ${plain(v.inflation)}% inflation.`
        ]
    };
}

function computeGoal(v) {
    const m = monthlyRate(v.rate);
    const n = Math.round(v.years * 12);
    const target = v.todays === "today" ? v.target * Math.pow(1 + v.inflation / 100, v.years) : v.target;
    const grownCurrent = v.current * Math.pow(1 + m, n);
    const need = target - grownCurrent;
    let factor = Math.abs(m) < 1e-12 ? n : (Math.pow(1 + m, n) - 1) / m;
    if (v.timing === "start") factor *= 1 + m;
    const monthly = need > 0 ? need / factor : 0;

    const rows = [];
    let value = v.current, paid = v.current;
    for (let month = 1; month <= n; month++) {
        if (v.timing === "start") { value += monthly; paid += monthly; }
        value *= 1 + m;
        if (v.timing !== "start") { value += monthly; paid += monthly; }
        if (month % 12 === 0 || month === n) rows.push({ year: Math.ceil(month / 12), value, paid });
    }

    const notes = [];
    if (need <= 0) notes.push(`Savings already set aside should reach the target on their own: they could grow to ${money(grownCurrent)}.`);

    return {
        tiles: [
            { label: "Save each month", value: money(monthly, 0), strong: true, note: `For ${v.years} years` },
            { label: "Target", value: money(target), note: v.todays === "today" ? `${money(v.target)} today, at ${plain(v.inflation)}% inflation` : "In future dollars" },
            { label: "Existing savings grow to", value: money(grownCurrent) },
            { label: "Total you'll put in", value: money(v.current + monthly * n) }
        ],
        chart: {
            labels: rows.map(r => `Yr ${r.year}`),
            series: [
                { label: "Savings", data: rows.map(r => r.value), color: 1, fill: true },
                { label: "Target", data: rows.map(() => target), color: 3, dashed: true },
                { label: "Total put in", data: rows.map(r => r.paid), color: "muted", dashed: true }
            ]
        },
        table: {
            head: ["Year", "Total put in", "Savings"],
            rows: rows.map(r => [r.year, money(r.paid), money(r.value)])
        },
        notes,
        summary: [
            `To reach ${money(target)} in ${v.years} years${v.todays === "today" ? ` (${money(v.target)} in today's dollars)` : ""},`,
            need > 0
                ? `save about ${money(monthly)} a month, on top of the ${money(v.current)} already set aside, at ${plain(v.rate)}% a year.`
                : `the ${money(v.current)} already set aside is enough at ${plain(v.rate)}% a year.`
        ]
    };
}

function xirr(flows) {
    const t0 = flows[0].date.getTime();
    const f = rate => flows.reduce((sum, cf) => sum + cf.amount / Math.pow(1 + rate, (cf.date.getTime() - t0) / (365 * 86400000)), 0);

    let low = -0.9999, high = 10;
    if (f(low) * f(high) > 0) return NaN;
    return bisect(f, low, high, 300);
}

function computeReturns(v) {
    if (v.mode === "cagr") {
        const total = v.end + v.income;
        const gain = total - v.start;
        const cagr = v.start > 0 && v.years > 0 && total > 0 ? Math.pow(total / v.start, 1 / v.years) - 1 : NaN;
        const rows = [];
        for (let y = 0; y <= Math.ceil(v.years); y++) {
            const t = Math.min(y, v.years);
            rows.push({ year: plain(t), value: v.start * Math.pow(1 + cagr, t) });
        }
        return {
            tiles: [
                { label: "Annualised return (CAGR)", value: pct(cagr), strong: true },
                { label: "Total return", value: v.start ? pct(gain / v.start) : "–" },
                { label: "Gain", value: money(gain) },
                { label: "Years held", value: plain(v.years) }
            ],
            chart: {
                labels: rows.map(r => `Yr ${r.year}`),
                series: [{ label: "Value at the annualised return", data: rows.map(r => r.value), color: 1, fill: true }]
            },
            notes: v.income ? ["Dividends and payouts received are counted as if received at the end."] : [],
            summary: [
                `${money(v.start)} grew to ${money(v.end)}${v.income ? ` plus ${money(v.income)} of payouts` : ""} over ${plain(v.years)} years:`,
                `a total return of ${v.start ? pct(gain / v.start) : "–"}, or ${pct(cagr)} a year.`
            ]
        };
    }

    const flows = (v.flows ?? [])
        .filter(row => row.date && Number(row.amount) > 0)
        .map(row => ({ date: new Date(row.date), amount: row.kind === "out" ? Number(row.amount) : -Number(row.amount), kind: row.kind }))
        .filter(row => !Number.isNaN(row.date.getTime()));

    const problems = [];
    if (!flows.some(row => row.amount < 0)) problems.push("Add at least one amount invested.");
    const valueDate = new Date(v.valueDate);
    if (Number.isNaN(valueDate.getTime())) problems.push("Enter the date of the value now.");
    if (problems.length) return { problems };

    const all = [...flows, { date: valueDate, amount: v.valueNow, kind: "value" }].sort((a, b) => a.date - b.date);
    const rate = xirr(all);
    const invested = flows.filter(r => r.amount < 0).reduce((s, r) => s - r.amount, 0);
    const received = flows.filter(r => r.amount > 0).reduce((s, r) => s + r.amount, 0);
    const gain = received + v.valueNow - invested;
    const fmtDate = d => d.toLocaleDateString("en-SG", { day: "numeric", month: "short", year: "numeric" });

    return {
        tiles: [
            { label: "Annualised return (XIRR)", value: Number.isFinite(rate) ? pct(rate) : "–", strong: true },
            { label: "Total invested", value: money(invested) },
            { label: "Withdrawn + value now", value: money(received + v.valueNow) },
            { label: "Gain", value: money(gain), note: invested ? `${pct(gain / invested)} in total` : "" }
        ],
        table: {
            head: ["Date", "Cash flow", "Amount"],
            rows: all.map(r => [fmtDate(r.date), r.kind === "value" ? "Value now" : r.amount < 0 ? "Invested" : "Withdrawn / received", money(Math.abs(r.amount))])
        },
        notes: Number.isFinite(rate) ? [] : ["The return could not be worked out from these cash flows. Check the dates and amounts."],
        summary: [
            `Investing ${money(invested)} in total, receiving ${money(received)} and holding ${money(v.valueNow)} now`,
            `works out to an annualised return (XIRR) of ${Number.isFinite(rate) ? pct(rate) : "–"}.`
        ]
    };
}

function amortise(principal, annualPct, months, extra = 0) {
    const j = annualPct / 1200;
    const payment = annuityPayment(principal, j, months);
    let balance = principal, interestTotal = 0, month = 0;
    const years = [];
    let yearInterest = 0, yearPrincipal = 0, yearPaid = 0;

    while (balance > 0.005 && month < months + 1) {
        month++;
        const interest = balance * j;
        const pay = Math.min(balance + interest, payment + extra);
        const principalPart = pay - interest;
        balance -= principalPart;
        interestTotal += interest;
        yearInterest += interest; yearPrincipal += principalPart; yearPaid += pay;

        if (month % 12 === 0 || balance <= 0.005) {
            years.push({ year: Math.ceil(month / 12), paid: yearPaid, interest: yearInterest, principal: yearPrincipal, balance: Math.max(0, balance), interestTotal });
            yearInterest = yearPrincipal = yearPaid = 0;
        }
    }

    return { payment, months: month, interestTotal, years };
}

function computeLoan(v) {
    const n = Math.round(v.years * 12);
    const base = amortise(v.amount, v.rate, n);
    const withExtra = v.extra > 0 ? amortise(v.amount, v.rate, n, v.extra) : null;
    const used = withExtra ?? base;

    const tiles = [
        { label: "Monthly instalment", value: money(base.payment, 2), strong: true, note: withExtra ? `+ ${money(v.extra)} extra = ${money(base.payment + v.extra, 2)}` : `${v.years} years at ${plain(v.rate)}%` },
        { label: "Total interest", value: money(used.interestTotal) },
        { label: "Total repaid", value: money(v.amount + used.interestTotal) }
    ];

    if (withExtra) {
        tiles.push({ label: "Paid off in", value: yearsMonths(withExtra.months), note: `${yearsMonths(n - withExtra.months)} sooner, saving ${money(base.interestTotal - withExtra.interestTotal)} interest` });
    } else {
        tiles.push({ label: "Interest share", value: pct(base.interestTotal / (v.amount + base.interestTotal), 0), note: "Of everything repaid" });
    }

    const labels = base.years.map(r => `Yr ${r.year}`);
    const series = [{ label: "Balance", data: base.years.map(r => r.balance), color: 1, fill: !withExtra }];
    if (withExtra) series.push({ label: "Balance with extra payments", data: base.years.map((r, i) => withExtra.years[i]?.balance ?? 0), color: 3 });
    series.push({ label: "Interest paid to date", data: base.years.map(r => r.interestTotal), color: 2, dashed: true });

    return {
        tiles,
        chart: { labels, series },
        table: {
            head: ["Year", "Paid", "Principal", "Interest", "Balance"],
            rows: used.years.map(r => [r.year, money(r.paid), money(r.principal), money(r.interest), money(r.balance)])
        },
        notes: ["Interest is worked out monthly at the yearly rate ÷ 12, as Singapore home loans are."],
        summary: [
            `A ${money(v.amount)} loan over ${v.years} years at ${plain(v.rate)}% a year costs ${money(base.payment, 2)} a month,`,
            `with ${money(used.interestTotal)} of interest in total${withExtra ? ` (paying ${money(v.extra)} extra a month clears it in ${yearsMonths(withExtra.months)})` : ""}.`
        ]
    };
}

function computeAfford(v) {
    const P = RULES.property;
    const hdbLoan = v.property === "hdb" && v.lender === "hdb";
    const income = v.fixed + v.variable * P.variableHaircut;
    const notes = [];
    const problems = [];

    let assessRate, maxTenure, ltv, minCash, tenure;

    if (hdbLoan) {
        assessRate = Math.max(P.hdbFloor, v.rate);
        maxTenure = Math.min(25, 65 - v.age);
        tenure = Math.min(v.tenure, maxTenure);
        ltv = P.ltv;
        minCash = 0;
    } else {
        assessRate = Math.max(P.bankStress, v.rate);
        maxTenure = v.property === "private" ? 35 : 30;
        tenure = Math.min(v.tenure, maxTenure);
        const longLimit = v.property === "private" ? 30 : 25;
        const long = tenure > longLimit || v.age + tenure > 65;
        ltv = long ? P.ltvLong : P.ltv;
        minCash = long ? P.minCashLong : P.minCash;
        if (long) notes.push(`A tenure over ${longLimit} years, or one that runs past age 65, lowers the loan limit to ${Math.round(P.ltvLong * 100)}% of the price, with at least ${Math.round(P.minCashLong * 100)}% in cash.`);
    }

    if (tenure < 1) {
        problems.push("At this age the loan tenure would be too short. Lower the borrowers' average age.");
        return { problems };
    }
    if (tenure < v.tenure) notes.push(`Tenure capped at ${tenure} years (${hdbLoan ? "HDB loans: up to 25 years and to age 65" : `bank loans for ${v.property === "private" ? "private property: up to 35" : "HDB flats and ECs: up to 30"} years`}).`);

    const tdsrRoom = P.tdsr * income - v.debts;
    const msrRoom = (v.property === "hdb" || v.property === "ec") ? P.msr * income : Infinity;
    const maxInstalment = Math.max(0, hdbLoan ? msrRoom : Math.min(tdsrRoom, msrRoom));
    const msrLabel = `MSR ${Math.round(P.msr * 100)}%`, tdsrLabel = `TDSR ${Math.round(P.tdsr * 100)}%`;
    const binding = hdbLoan ? msrLabel : (msrRoom < tdsrRoom ? msrLabel : tdsrLabel);

    const n = tenure * 12;
    const maxLoan = annuityPresentValue(maxInstalment, assessRate / 1200, n);
    const priceByLoan = maxLoan / ltv;

    // Highest price the cash + CPF can support (down payment + stamp duty)
    const fundsOk = price => {
        const down = price * (1 - ltv);
        const bsd = buyersStampDuty(price);
        return v.cash >= price * minCash && v.cash + v.cpf >= down + bsd;
    };
    let priceByFunds = 0;
    if (fundsOk(1000)) {
        let low = 1000, high = 20000000;
        if (fundsOk(high)) priceByFunds = high;
        else {
            for (let i = 0; i < 80; i++) {
                const mid = (low + high) / 2;
                if (fundsOk(mid)) low = mid; else high = mid;
            }
            priceByFunds = low;
        }
    }

    const price = Math.min(priceByLoan, priceByFunds);
    const loan = Math.min(maxLoan, price * ltv);
    const actualPayment = annuityPayment(loan, v.rate / 1200, n);
    const down = price * (1 - ltv);
    const bsd = buyersStampDuty(price);
    const cashNeeded = price * minCash;
    const limitedBy = priceByFunds < priceByLoan ? "cash and CPF available" : `loan limit (${binding})`;

    notes.push(`The loan is assessed at ${plain(assessRate)}% a year (${hdbLoan ? `HDB's ${plain(P.hdbFloor)}% floor` : `MAS's ${plain(P.bankStress)}% stress-test rate`}, or the actual rate if higher), not the rate actually paid.`);
    if (v.variable) notes.push(`Variable income counts at ${Math.round(P.variableHaircut * 100)}%, as banks apply a ${Math.round((1 - P.variableHaircut) * 100)}% haircut.`);
    notes.push("Excludes Additional Buyer's Stamp Duty (assumes a Singapore citizen's first property), legal fees and any housing grants.");

    return {
        tiles: [
            { label: "Maximum property price", value: money(price), strong: true, note: `Limited by ${limitedBy}` },
            { label: "Maximum loan", value: money(loan), note: `${Math.round(ltv * 100)}% LTV · ${tenure} years` },
            { label: "Monthly instalment", value: money(actualPayment, 0), note: `At the actual ${plain(v.rate)}%` },
            { label: "Down payment + stamp duty", value: money(down + bsd), note: `Min. cash ${money(cashNeeded)} · BSD ${money(bsd)}` }
        ],
        chart: {
            type: "bar",
            labels: ["Monthly income counted", hdbLoan ? msrLabel : `${tdsrLabel} − other debts`, ...(msrRoom < Infinity && !hdbLoan ? [msrLabel] : []), "Instalment at assessed rate", "Instalment at actual rate"],
            series: [{
                label: "S$ a month",
                data: [income, hdbLoan ? msrRoom : tdsrRoom, ...(msrRoom < Infinity && !hdbLoan ? [msrRoom] : []), annuityPayment(loan, assessRate / 1200, n), actualPayment],
                color: 1
            }]
        },
        table: {
            head: ["Item", "Amount"],
            rows: [
                [`Income counted (fixed + ${Math.round(P.variableHaircut * 100)}% of variable)`, money(income)],
                [`TDSR limit (${Math.round(P.tdsr * 100)}% − other debts)`, hdbLoan ? "Not applied to HDB loans" : money(tdsrRoom)],
                [`MSR limit (${Math.round(P.msr * 100)}%)`, msrRoom < Infinity ? money(msrRoom) : "Not applied to private property"],
                ["Maximum instalment allowed", money(maxInstalment)],
                ["Assessed interest rate", `${plain(assessRate)}%`],
                ["Maximum loan from income", money(maxLoan)],
                ["Price supported by the loan", money(priceByLoan)],
                ["Price supported by cash + CPF", money(priceByFunds)],
                ["Down payment", money(down)],
                ["of which at least in cash", money(cashNeeded)],
                ["Buyer's Stamp Duty", money(bsd)]
            ]
        },
        notes,
        summary: [
            `With ${money(income)} a month of income counted and ${money(v.debts)} of other debts, the maximum loan is about ${money(loan)} over ${tenure} years,`,
            `for a property of up to ${money(price)} (${limitedBy}). The instalment would be about ${money(actualPayment)} a month at ${plain(v.rate)}%.`
        ]
    };
}

function computeRefi(v) {
    const n = Math.round(v.years * 12);
    const oldLoan = amortise(v.balance, v.oldRate, n);
    const newLoan = amortise(v.balance, v.newRate, n);
    const saving = oldLoan.payment - newLoan.payment;
    const months = Math.min(n, Math.round(v.period * 12));

    // Interest each way, month by month, for break-even and the comparison period
    const jo = v.oldRate / 1200, jn = v.newRate / 1200;
    let bo = v.balance, bn = v.balance, saved = 0, breakEven = null, savedInPeriod = null;
    const rows = [];
    for (let m = 1; m <= n; m++) {
        const io = bo * jo, inew = bn * jn;
        bo -= oldLoan.payment - io; bn -= newLoan.payment - inew;
        saved += io - inew;
        if (breakEven === null && saved >= v.costs) breakEven = m;
        if (m % 12 === 0) rows.push({ year: m / 12, saved: saved - v.costs });
        if (m === months) savedInPeriod = saved;
    }

    const net = (savedInPeriod ?? saved) - v.costs;

    return {
        tiles: [
            { label: "New monthly instalment", value: money(newLoan.payment, 2), strong: true, note: `Was ${money(oldLoan.payment, 2)}` },
            { label: "Saving each month", value: money(saving, 2) },
            { label: `Net saving over ${v.period} year${v.period === 1 ? "" : "s"}`, value: money(net), note: "Interest saved minus switching costs" },
            { label: "Break-even", value: breakEven ? yearsMonths(breakEven) : "Not within the tenure", note: v.costs ? `To recover ${money(v.costs)}` : "" }
        ],
        chart: {
            labels: rows.map(r => `Yr ${r.year}`),
            series: [{ label: "Net saving to date (after costs)", data: rows.map(r => r.saved), color: 3, fill: true }]
        },
        table: {
            head: ["", "Current loan", "New loan"],
            rows: [
                ["Interest rate", `${plain(v.oldRate)}%`, `${plain(v.newRate)}%`],
                ["Monthly instalment", money(oldLoan.payment, 2), money(newLoan.payment, 2)],
                ["Total interest over the remaining tenure", money(oldLoan.interestTotal), money(newLoan.interestTotal)]
            ]
        },
        notes: net < 0 ? ["Over this period the switching costs are larger than the interest saved."] : [],
        summary: [
            `Refinancing ${money(v.balance)} from ${plain(v.oldRate)}% to ${plain(v.newRate)}% cuts the instalment by ${money(saving, 2)} a month`,
            `and saves ${money(net)} over ${v.period} years after ${money(v.costs)} of costs${breakEven ? `, breaking even after ${yearsMonths(breakEven)}` : ""}.`
        ]
    };
}

function computeRetire(v) {
    const problems = [];
    if (v.retireAge <= v.age) problems.push("Retirement age must be after the current age.");
    if (v.lifeAge <= v.retireAge) problems.push("Plan to an age after retirement.");
    if (problems.length) return { problems };

    const inf = v.inflation / 100;
    const yearsTo = v.retireAge - v.age;
    const yearsIn = v.lifeAge - v.retireAge;
    const gapToday = Math.max(0, v.need - v.other);
    const firstYear = gapToday * 12 * Math.pow(1 + inf, yearsTo);
    const r = v.rateAfter / 100;
    const ratio = (1 + inf) / (1 + r);
    const needed = Math.abs(r - inf) < 1e-9
        ? firstYear * yearsIn
        : firstYear * (1 - Math.pow(ratio, yearsIn)) / (r - inf) * (1 + r);

    const mb = monthlyRate(v.rateBefore);
    const nb = yearsTo * 12;
    const fvFactor = Math.abs(mb) < 1e-12 ? nb : (Math.pow(1 + mb, nb) - 1) / mb;
    const projected = v.savings * Math.pow(1 + mb, nb) + v.monthly * fvFactor;
    const gap = needed - projected;
    const extraMonthly = gap > 0 ? gap / fvFactor : 0;

    // Year-by-year path: save until retirement, then draw the gap
    const rows = [];
    let balance = v.savings, runsOut = null;
    for (let age = v.age; age < v.lifeAge; age++) {
        if (age < v.retireAge) {
            for (let m = 0; m < 12; m++) balance = balance * (1 + mb) + v.monthly;
        } else {
            const draw = gapToday * 12 * Math.pow(1 + inf, age - v.age);
            balance = (balance - draw) * (1 + r);
            if (balance < 0 && runsOut === null) runsOut = age + 1;
        }
        rows.push({ age: age + 1, balance: Math.max(0, balance) });
    }

    return {
        tiles: [
            { label: `Nest egg needed at ${v.retireAge}`, value: money(needed), strong: true, note: `For ${money(gapToday)}/month in today's dollars, ${yearsIn} years` },
            { label: "Projected savings", value: money(projected), note: `At ${plain(v.rateBefore)}% a year` },
            { label: gap > 0 ? "Shortfall" : "Surplus", value: money(Math.abs(gap)), tone: gap > 0 ? "bad" : "good" },
            gap > 0
                ? { label: "Extra saving needed", value: `${money(extraMonthly)}/month`, note: runsOut ? `Otherwise savings run out at about age ${runsOut}` : "" }
                : { label: "Money lasts", value: runsOut ? `To age ${runsOut}` : `Beyond ${v.lifeAge}` }
        ],
        chart: {
            labels: rows.map(r => String(r.age)),
            series: [{ label: "Retirement savings", data: rows.map(r => r.balance), color: 1, fill: true }],
            xTitle: "Age"
        },
        table: {
            head: ["Item", "Amount"],
            rows: [
                ["Income wanted (today's dollars)", `${money(v.need)}/month`],
                ["Less other retirement income", `${money(v.other)}/month`],
                ["Gap to fund from savings (today's dollars)", `${money(gapToday)}/month`],
                [`Gap in the first year of retirement (age ${v.retireAge})`, `${money(firstYear / 12)}/month`],
                ["Savings needed at retirement", money(needed)],
                ["Projected savings at retirement", money(projected)]
            ]
        },
        notes: ["Withdrawals rise with inflation each year. Other income, such as CPF LIFE, is assumed to keep pace with inflation."],
        summary: [
            `For ${money(v.need)} a month in today's dollars from age ${v.retireAge} to ${v.lifeAge} (with ${money(v.other)} from other sources), about ${money(needed)} is needed at retirement.`,
            gap > 0
                ? `Current savings are projected to reach ${money(projected)}: a shortfall of ${money(gap)}, or about ${money(extraMonthly)} more a month.`
                : `Current savings are projected to reach ${money(projected)}, which is enough.`
        ]
    };
}

function runDrawdown(capital, withdraw, step, rate, maxMonths = 1200) {
    const m = monthlyRate(rate);
    let balance = capital, w = withdraw, total = 0, month = 0;
    const years = [];
    while (month < maxMonths) {
        if (balance <= 0) break;
        const take = Math.min(balance, w);
        balance -= take; total += take;
        balance *= 1 + m;
        month++;
        if (month % 12 === 0) { years.push({ year: month / 12, balance: Math.max(0, balance), total }); w *= 1 + step / 100; }
        if (balance <= 0.005) { if (month % 12) years.push({ year: Math.ceil(month / 12), balance: 0, total }); break; }
    }
    return { months: month, lasts: balance > 0.005, total, years };
}

function computeDrawdown(v) {
    const run = runDrawdown(v.capital, v.withdraw, v.step, v.rate);
    const forever = run.lasts;
    const sustainable = bisect(w => runDrawdown(v.capital, w, v.step, v.rate, v.target * 12).lasts ? 1 : -1, 0, v.capital, 60);

    return {
        tiles: [
            { label: "Savings last", value: forever ? "100+ years" : yearsMonths(run.months), strong: true, note: forever ? "" : `To about age ${v.age + Math.floor(run.months / 12)}` },
            { label: "Total withdrawn", value: money(run.total), note: forever ? "Over 100 years" : "" },
            { label: `Most you can take for ${v.target} years`, value: `${money(sustainable)}/month`, note: v.step ? `Rising ${plain(v.step)}% a year` : "" },
            { label: "Withdrawal rate", value: pct(v.withdraw * 12 / v.capital, 1), note: "First year, of starting savings" }
        ],
        chart: {
            labels: run.years.map(r => String(v.age + r.year)),
            series: [{ label: "Savings left", data: run.years.map(r => r.balance), color: 1, fill: true }],
            xTitle: "Age"
        },
        table: {
            head: ["Age", "Withdrawn to date", "Savings left"],
            rows: run.years.map(r => [v.age + r.year, money(r.total), money(r.balance)])
        },
        summary: [
            `Withdrawing ${money(v.withdraw)} a month${v.step ? ` (rising ${plain(v.step)}% a year)` : ""} from ${money(v.capital)} earning ${plain(v.rate)}% a year,`,
            forever ? "the savings are not used up." : `the savings last about ${yearsMonths(run.months)}, to around age ${v.age + Math.floor(run.months / 12)}.`,
            `To last ${v.target} years, withdraw up to about ${money(sustainable)} a month.`
        ]
    };
}

function monthLabel(ym) {
    const m = /^(\d{4})-(\d{2})$/.exec(String(ym ?? ""));
    return m ? new Date(Number(m[1]), Number(m[2]) - 1, 1).toLocaleDateString("en-SG", { month: "long", year: "numeric" }) : String(ym ?? "");
}

function cpfBand(age) {
    // Contribution and allocation rates for the age band (from the reference data)
    const pick = list => list.find(band => age <= band.maxAge) ?? list.at(-1);
    const c = pick(RULES.cpf.contribution.bands);
    const a = pick(RULES.cpf.allocation.bands);
    return { total: (c.employer + c.employee) / 100, employee: c.employee / 100, alloc: [a.oa, a.sa, a.ma] };
}

function computeCpf(v) {
    const C = RULES.cpf;
    const oaRate = C.interest.oa, smraRate = C.interest.smra;
    const extra = C.extraInterest.below55;
    const owCeiling = C.owCeiling.value;
    const bhsYear = C.bhs.year;
    const problems = [];
    if (v.to <= v.age) problems.push("Project to an age after the current age.");
    if (v.age >= 55) problems.push("This projects CPF up to age 55. For 55 and above, use Retirement needs.");
    if (problems.length) return { problems };

    const startYear = new Date().getFullYear();
    let oa = v.oa, sa = v.sa, ma = v.ma, salary = v.salary;
    const rows = [];

    for (let age = v.age; age < v.to; age++) {
        const year = startYear + (age - v.age);
        const band = cpfBand(age);
        const bhs = C.bhs.value * Math.pow(1 + C.bhs.growth, Math.max(0, year - bhsYear));
        const ow = Math.min(salary, owCeiling);
        const awCeiling = Math.max(0, C.annualCeiling - ow * 12);
        const aw = Math.min(salary * v.bonus, awCeiling);
        let oaInt = 0, saInt = 0, maInt = 0, extraInt = 0, contributed = 0;

        for (let month = 1; month <= 12; month++) {
            // Interest is worked out monthly on the balance and credited at year end
            oaInt += oa * oaRate / 1200;
            saInt += sa * smraRate / 1200;
            maInt += ma * smraRate / 1200;
            const extraBase = Math.min(oa, extra.oaCap) + sa + ma;
            extraInt += Math.min(extraBase, extra.cap) * extra.rate / 1200;

            let wage = ow + (month === 12 ? aw : 0);
            const c = wage * band.total;
            contributed += c;
            const toMa = c * band.alloc[2];
            const toSa = c * band.alloc[1];
            oa += c - toMa - toSa;
            sa += toSa;
            ma += toMa;
            if (ma > bhs) { sa += ma - bhs; ma = bhs; }
        }

        oa += oaInt; sa += saInt + extraInt; ma += maInt;
        if (ma > bhs) { sa += ma - bhs; ma = bhs; }

        rows.push({ age: age + 1, year, oa, sa, ma, total: oa + sa + ma, contributed, interest: oaInt + saInt + maInt + extraInt });
        salary *= 1 + v.growth / 100;
    }

    const last = rows.at(-1);
    const year55 = startYear + (55 - v.age);
    const frsYears = Object.keys(C.frsByYear).map(Number).sort((a, b) => a - b);
    const lastFrsYear = frsYears.at(-1);
    const frs = C.frsByYear[year55] ?? C.frsByYear[lastFrsYear] * Math.pow(1 + C.frsGrowth, Math.max(0, year55 - lastFrsYear));
    const reach55 = v.to === 55;

    return {
        tiles: [
            { label: `Total CPF at ${last.age}`, value: money(last.total), strong: true },
            { label: "Ordinary Account", value: money(last.oa) },
            { label: "Special Account", value: money(last.sa), note: reach55 ? `${pct(last.sa / frs, 0)} of the est. FRS` : "" },
            { label: "MediSave Account", value: money(last.ma) },
            ...(reach55 ? [{ label: `Est. Full Retirement Sum (${year55})`, value: money(frs), note: last.oa + last.sa >= frs ? "OA + SA could meet it" : `OA + SA short by ${money(frs - last.oa - last.sa)}` }] : [])
        ],
        chart: {
            stacked: true,
            labels: rows.map(r => String(r.age)),
            series: [
                { label: "Ordinary Account", data: rows.map(r => r.oa), color: 1, fill: true },
                { label: "Special Account", data: rows.map(r => r.sa), color: 3, fill: true },
                { label: "MediSave Account", data: rows.map(r => r.ma), color: 2, fill: true }
            ],
            xTitle: "Age"
        },
        table: {
            head: ["Age", "Year", "Contributions", "Interest", "OA", "SA", "MA", "Total"],
            rows: rows.map(r => [r.age, r.year, money(r.contributed), money(r.interest), money(r.oa), money(r.sa), money(r.ma), money(r.total)])
        },
        notes: [
            `Contribution rates from ${monthLabel(C.contribution.effective)} (${Math.round(cpfBand(v.age).total * 100)}% at age ${v.age}), Ordinary Wage ceiling ${money(owCeiling)} a month, ${money(C.annualCeiling)} a year in total. Interest: OA ${plain(oaRate)}%, SA/MA ${plain(smraRate)}% (${C.interest.period || "current quarter"}), extra ${plain(extra.rate)}% on the first ${money(extra.cap)} (OA up to ${money(extra.oaCap)}) paid into the SA.`,
            `MediSave above the Basic Healthcare Sum (${money(C.bhs.value)} in ${bhsYear}, assumed to rise ${pct(C.bhs.growth, 1)} a year) flows to the SA. The Full Retirement Sum after ${lastFrsYear} is assumed to rise ${pct(C.frsGrowth, 1)} a year.`,
            "Assumes no withdrawals (e.g. housing), no top-ups and that rates stay as today."
        ],
        summary: [
            `Earning ${money(v.salary)} a month (+${plain(v.bonus)} months' bonus, rising ${plain(v.growth)}% a year), CPF could grow from ${money(v.oa + v.sa + v.ma)} to about ${money(last.total)} by age ${last.age}:`,
            `OA ${money(last.oa)}, SA ${money(last.sa)}, MA ${money(last.ma)}.`
        ]
    };
}

function computeProtect(v) {
    const lifeNeed = v.income * v.years + v.debts + v.education + v.final - v.assets;
    const lifeGap = Math.max(0, lifeNeed - v.lifeCover);
    const ciNeed = v.income * v.ciYears;
    const ciGap = Math.max(0, ciNeed - v.ciCover);
    const emergencyLow = v.expenses * 3, emergencyHigh = v.expenses * 6;
    const emergencyGap = Math.max(0, emergencyLow - v.emergency);

    return {
        tiles: [
            { label: "Death / TPD cover gap", value: money(lifeGap), strong: true, tone: lifeGap > 0 ? "bad" : "good", note: `Need ${money(Math.max(0, lifeNeed))}, have ${money(v.lifeCover)}` },
            { label: "Critical illness cover gap", value: money(ciGap), tone: ciGap > 0 ? "bad" : "good", note: `Need ${money(ciNeed)}, have ${money(v.ciCover)}` },
            { label: "Emergency fund target", value: `${money(emergencyLow)} – ${money(emergencyHigh)}`, note: emergencyGap ? `${money(emergencyGap)} short of 3 months` : "Has at least 3 months" },
            { label: `Guideline (${RULES.protection.lifeMultiple}x / ${RULES.protection.ciMultiple}x income)`, value: `${money(v.income * RULES.protection.lifeMultiple)} / ${money(v.income * RULES.protection.ciMultiple)}`, note: "Death & TPD / critical illness" }
        ],
        chart: {
            type: "bar",
            labels: ["Death / TPD", "Critical illness", "Emergency fund"],
            series: [
                { label: "Needed", data: [Math.max(0, lifeNeed), ciNeed, emergencyLow], color: 2 },
                { label: "Already have", data: [v.lifeCover, v.ciCover, v.emergency], color: 1 }
            ]
        },
        table: {
            head: ["Death / TPD need", "Amount"],
            rows: [
                [`Income replacement (${plain(v.years)} years)`, money(v.income * v.years)],
                ["Debts to clear", money(v.debts)],
                ["Children's education", money(v.education)],
                ["Final expenses", money(v.final)],
                ["Less savings & investments", `−${money(v.assets)}`],
                ["Total need", money(Math.max(0, lifeNeed))],
                ["Less existing cover", `−${money(v.lifeCover)}`],
                ["Gap", money(lifeGap)]
            ]
        },
        notes: ["Guideline from the Basic Financial Planning Guide (MoneySense, MAS and industry): death and TPD cover of 9x annual income, critical illness 4x, and an emergency fund of 3–6 months of expenses."],
        summary: [
            `Death / TPD: need about ${money(Math.max(0, lifeNeed))} against ${money(v.lifeCover)} of cover, a gap of ${money(lifeGap)}.`,
            `Critical illness: need about ${money(ciNeed)} against ${money(v.ciCover)}, a gap of ${money(ciGap)}.`,
            `Emergency fund: aim for ${money(emergencyLow)} to ${money(emergencyHigh)} (has ${money(v.emergency)}).`
        ]
    };
}

function computeInflation(v) {
    const factor = Math.pow(1 + v.rate / 100, v.years);
    const future = v.mode === "future";
    const result = future ? v.amount * factor : v.amount / factor;
    const rows = [];
    for (let y = 0; y <= v.years; y++) {
        const f = Math.pow(1 + v.rate / 100, y);
        rows.push({ year: y, value: future ? v.amount * f : v.amount / f });
    }

    return {
        tiles: future
            ? [
                { label: `Cost in ${v.years} years`, value: money(result), strong: true, note: `Of ${money(v.amount)} today` },
                { label: "Increase", value: money(result - v.amount), note: pct(factor - 1, 0) },
                { label: "Today's money buys", value: pct(1 / factor, 0), note: "Of what it buys now" }
            ]
            : [
                { label: "Worth in today's dollars", value: money(result), strong: true, note: `${money(v.amount)} in ${v.years} years` },
                { label: "Lost to inflation", value: money(v.amount - result), note: pct(1 - 1 / factor, 0) },
                { label: "Return needed to keep up", value: `${plain(v.rate)}% a year` }
            ],
        chart: {
            labels: rows.map(r => `Yr ${r.year}`),
            series: [{ label: future ? "Cost" : "Value in today's dollars", data: rows.map(r => r.value), color: 1, fill: true }]
        },
        summary: [future
            ? `At ${plain(v.rate)}% inflation, what costs ${money(v.amount)} today will cost about ${money(result)} in ${v.years} years.`
            : `At ${plain(v.rate)}% inflation, ${money(v.amount)} in ${v.years} years is worth about ${money(result)} today.`]
    };
}

function computeDividend(v) {
    const f = Number(v.freq) || 4;
    const reinvest = v.reinvest === "reinvest";
    let price = 1, units = v.amount, dpu = v.yield / 100, paidOut = 0, totalDiv = 0, invested = v.amount;
    const priceStep = Math.pow(1 + v.priceGrowth / 100, 1 / f);
    const rows = [];

    for (let year = 1; year <= v.years; year++) {
        let yearDiv = 0;
        for (let p = 1; p <= f; p++) {
            const add = v.monthly * 12 / f;
            if (add) { units += add / price; invested += add; }
            price *= priceStep;
            const div = units * dpu / f;
            yearDiv += div; totalDiv += div;
            if (reinvest) units += div / price; else paidOut += div;
        }
        rows.push({ year, div: yearDiv, value: units * price, paidOut, invested });
        dpu *= 1 + v.divGrowth / 100;
    }

    const first = rows[0], last = rows.at(-1);

    return {
        tiles: [
            { label: "Dividends in year 1", value: money(first.div), strong: true, note: `About ${money(first.div / 12)} a month` },
            { label: `Dividends in year ${v.years}`, value: money(last.div), note: `${pct(last.div / last.invested, 1)} yield on amount invested` },
            { label: "Total dividends", value: money(totalDiv), note: reinvest ? "All reinvested" : "All paid out" },
            { label: "Investment value at the end", value: money(last.value), note: `${money(last.invested)} invested` }
        ],
        chart: {
            type: "bar",
            labels: rows.map(r => `Yr ${r.year}`),
            series: [{ label: "Dividends for the year", data: rows.map(r => r.div), color: 3 }]
        },
        table: {
            head: ["Year", "Dividends", reinvest ? "Value (reinvested)" : "Value", "Paid out to date"],
            rows: rows.map(r => [r.year, money(r.div), money(r.value), money(r.paidOut)])
        },
        notes: ["Dividends and prices are assumed to change smoothly; actual payouts vary and are not guaranteed. Singapore dividends and REIT distributions to individuals are generally tax-free."],
        summary: [
            `${money(v.amount)} at a ${plain(v.yield)}% yield pays about ${money(first.div)} in the first year (${money(first.div / 12)} a month)${reinvest ? ", reinvested" : ""}.`,
            `Over ${v.years} years that is ${money(totalDiv)} in dividends, with the investment worth about ${money(last.value)} at the end.`
        ]
    };
}

// ------------------------------------------------------------
// Rendering
// ------------------------------------------------------------

const state = {
    tool: "growth",
    values: {},
    client: "",
    last: null,
    initialized: false,
    timer: 0,
    chartKey: "",
    lastTool: ""
};

const qs = (selector, root = document) => root.querySelector(selector);

function loadState() {
    try {
        const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
        if (saved && typeof saved === "object") {
            if (TOOLS.some(t => t.id === saved.tool)) state.tool = saved.tool;
            state.values = saved.values ?? {};
            state.client = saved.client ?? "";
        }
    } catch { /* storage unavailable */ }
}

function saveState() {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ tool: state.tool, values: state.values, client: state.client }));
    } catch { /* storage unavailable */ }
}

function tool() {
    return TOOLS.find(t => t.id === state.tool) ?? TOOLS[0];
}

function fieldDefault(field) {
    if (field.rule === "hdbLoan") return RULES.cpf.interest.hdbLoan ?? field.value;
    return Array.isArray(field.value) ? structuredClone(field.value) : field.value;
}

function valuesFor(t) {
    const saved = state.values[t.id] ?? {};
    const values = {};
    for (const field of t.fields) {
        values[field.key] = saved[field.key] ?? fieldDefault(field);
    }
    return values;
}

const RULE_TOOLS = new Set(["loan", "afford", "cpf", "protect"]);

function rulesFootnote(toolId) {
    if (!RULE_TOOLS.has(toolId)) return "";
    const fmt = iso => iso ? new Date(iso).toLocaleDateString("en-SG", { day: "numeric", month: "short", year: "numeric" }) : "";
    const failed = Object.entries(RULES_META.status ?? {}).filter(([, s]) => s && s.ok === false);
    const checked = RULES_META.checkedUtc ? `checked ${fmt(RULES_META.checkedUtc)}` : "built-in copy";
    const source = toolId === "afford"
        ? `Stamp duty from IRAS (rates from ${RULES.property.bsd?.effective || "–"}); TDSR / MSR / LTV limits reviewed ${fmt(RULES.property.reviewed)}.`
        : toolId === "protect"
            ? "Guideline from the Basic Financial Planning Guide (MoneySense)."
            : `CPF rates from CPF Board and data.gov.sg (interest for ${RULES.cpf.interest.period || "the current quarter"}).`;
    const warning = failed.length ? ` Some sources couldn't be read on the last check, so earlier values are used for: ${failed.map(([k]) => k).join(", ")}.` : "";
    return `Reference data ${checked}, updated automatically. ${source}${warning}`;
}

function numericValues(t, raw) {
    const values = {};
    const problems = [];
    for (const field of t.fields) {
        const value = raw[field.key];
        if (["money", "percent", "number", "years"].includes(field.type)) {
            const visible = !field.showIf || field.showIf(raw);
            const text = String(value ?? "").trim();
            const number = text === "" ? NaN : Number(text);
            if (visible && !Number.isFinite(number)) problems.push(`Enter ${field.label.toLowerCase()}.`);
            else if (visible && field.type === "money" && number < 0) problems.push(`${field.label} can't be negative.`);
            else if (visible && field.min !== undefined && number < field.min) problems.push(`${field.label}: at least ${field.min}.`);
            else if (visible && field.max !== undefined && number > field.max) problems.push(`${field.label}: at most ${field.max}.`);
            values[field.key] = Number.isFinite(number) ? number : 0;
        } else {
            values[field.key] = value;
        }
    }
    return { values, problems };
}

function renderPicker() {
    const box = qs("#fin-picker");
    if (!box) return;
    const hadFocus = box.contains(document.activeElement);
    box.innerHTML = GROUPS.map(group => `
        <div class="fin-group">
            <span class="fin-group-label">${escapeHtml(group.label)}</span>
            <div class="report-payment-options fin-tools" role="radiogroup" aria-label="${escapeHtml(group.label)}">
                ${TOOLS.filter(t => t.group === group.id).map(t => `
                    <button type="button" class="report-payment-option${t.id === state.tool ? " active" : ""}" role="radio" aria-checked="${t.id === state.tool}" data-fin-tool="${t.id}">
                        <span class="report-payment-name">${escapeHtml(t.name)}</span>
                    </button>`).join("")}
            </div>
        </div>`).join("");
    if (hadFocus) box.querySelector(`[data-fin-tool="${state.tool}"]`)?.focus();
}

function fieldHtml(field, value, raw) {
    const hidden = field.showIf && !field.showIf(raw) ? " hidden" : "";
    const id = `fin-${field.key}`;

    if (field.type === "choice") {
        return `<div class="report-field fin-field fin-field-choice" data-fin-wrap="${field.key}"${hidden}>
            <span>${escapeHtml(field.label)}</span>
            <div class="report-payment-options fin-choice" role="radiogroup" aria-label="${escapeHtml(field.label)}">
                ${field.options.map(([v, label]) => `<button type="button" class="report-payment-option${v === value ? " active" : ""}" role="radio" aria-checked="${v === value}" data-fin-choice="${field.key}" data-value="${escapeHtml(v)}"><span class="report-payment-name">${escapeHtml(label)}</span></button>`).join("")}
            </div>
        </div>`;
    }

    if (field.type === "select") {
        return `<label class="filter-control report-field fin-field" data-fin-wrap="${field.key}"${hidden}>
            <span>${escapeHtml(field.label)}</span>
            <select id="${id}" data-fin-field="${field.key}">
                ${field.options.map(([v, label]) => `<option value="${escapeHtml(v)}"${v === value ? " selected" : ""}>${escapeHtml(label)}</option>`).join("")}
            </select>
        </label>`;
    }

    if (field.type === "date") {
        return `<label class="report-field fin-field" data-fin-wrap="${field.key}"${hidden}>
            <span>${escapeHtml(field.label)}</span>
            <input id="${id}" type="date" data-fin-field="${field.key}" value="${escapeHtml(value)}">
        </label>`;
    }

    if (field.type === "flows") {
        const rows = (value ?? []).map((row, i) => `
            <div class="fin-flow-row" data-fin-flow="${i}">
                <input type="date" aria-label="Date" data-fin-flow-key="date" value="${escapeHtml(row.date)}">
                <select aria-label="Type" data-fin-flow-key="kind">
                    <option value="in"${row.kind !== "out" ? " selected" : ""}>Invested</option>
                    <option value="out"${row.kind === "out" ? " selected" : ""}>Withdrawn / received</option>
                </select>
                <input type="number" min="0" step="100" inputmode="decimal" aria-label="Amount (S$)" placeholder="S$" data-fin-flow-key="amount" value="${escapeHtml(row.amount)}">
                <button type="button" class="fin-flow-remove" data-fin-flow-remove="${i}" aria-label="Remove this cash flow">×</button>
            </div>`).join("");
        return `<div class="report-field fin-field fin-field-wide" data-fin-wrap="${field.key}"${hidden}>
            <span>${escapeHtml(field.label)}</span>
            <div class="fin-flows">${rows}</div>
            <button type="button" class="fin-flow-add" data-fin-flow-add>+ Add cash flow</button>
        </div>`;
    }

    const step = field.step ?? (field.type === "money" ? 100 : field.type === "percent" ? 0.1 : 1);
    const prefix = field.type === "money" ? "S$" : "";
    return `<label class="report-field fin-field" data-fin-wrap="${field.key}"${hidden}>
        <span>${escapeHtml(field.label)}</span>
        <div class="fin-input${prefix ? " has-prefix" : ""}${field.type === "percent" ? " has-suffix" : ""}">
            ${prefix ? `<i aria-hidden="true">${prefix}</i>` : ""}
            <input id="${id}" type="number" inputmode="decimal" step="${step}"${field.min !== undefined ? ` min="${field.min}"` : field.type === "money" ? ' min="0"' : ""}${field.max !== undefined ? ` max="${field.max}"` : ""} data-fin-field="${field.key}" value="${escapeHtml(value)}">
            ${field.type === "percent" ? '<i aria-hidden="true">%</i>' : ""}
        </div>
    </label>`;
}

function renderForm() {
    const t = tool();
    const raw = valuesFor(t);
    qs("#fin-tool-title").textContent = t.name;
    qs("#fin-tool-blurb").textContent = t.blurb;
    qs("#fin-fields").innerHTML = t.fields.map(field => fieldHtml(field, raw[field.key], raw)).join("");
    const client = qs("#fin-client");
    if (client && client.value !== state.client) client.value = state.client;
}

function refreshVisibility() {
    const t = tool();
    const raw = valuesFor(t);
    for (const field of t.fields) {
        const wrap = qs(`[data-fin-wrap="${field.key}"]`);
        if (wrap) wrap.hidden = Boolean(field.showIf && !field.showIf(raw));
    }
}

function cssVar(name, fallback) {
    const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return value || fallback;
}

function seriesColor(key) {
    if (key === "muted") return cssVar("--text-muted", "#8b98a5");
    return cssVar(`--series-${key}`, ["#3987e5", "#d95926", "#199e70", "#c98500"][(Number(key) || 1) - 1]);
}

function withAlpha(color, alpha) {
    const c = color.trim();
    if (c.startsWith("#")) {
        const hex = c.length === 4 ? c.slice(1).split("").map(x => x + x).join("") : c.slice(1, 7);
        const n = parseInt(hex, 16);
        return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
    }
    const m = c.match(/rgba?\(([^)]+)\)/);
    if (m) {
        const [r, g, b] = m[1].split(",").map(s => s.trim());
        return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    }
    return c;
}

function compactMoney(value) {
    const abs = Math.abs(value);
    if (abs >= 1e6) return `S$${(value / 1e6).toFixed(abs >= 1e7 ? 0 : 1)}m`;
    if (abs >= 1e3) return `S$${Math.round(value / 1e3)}k`;
    return `S$${Math.round(value)}`;
}

function drawChart(chart) {
    const wrap = qs("#fin-chart-wrap");
    if (!chart || !window.Chart) { destroyChart("fin-chart"); state.chartKey = ""; if (wrap) wrap.hidden = true; return; }
    wrap.hidden = false;

    // Same chart, new numbers: move the existing lines / bars smoothly
    const key = `${state.tool}|${chart.type ?? "line"}|${chart.stacked ? 1 : 0}|${chart.series.map(s => s.label).join("/")}|${document.documentElement.dataset.theme}|${document.documentElement.dataset.accent}|${document.documentElement.dataset.variant}`;
    const existing = window.Chart.getChart?.("fin-chart");
    if (existing && key === state.chartKey) {
        existing.data.labels = chart.labels;
        chart.series.forEach((s, i) => { if (existing.data.datasets[i]) existing.data.datasets[i].data = s.data; });
        existing.update(reducedMotion() ? "none" : undefined);
        return;
    }
    state.chartKey = key;
    destroyChart("fin-chart");

    const text = cssVar("--text-primary", "#e6edf3");
    const muted = cssVar("--text-muted", "#8b98a5");
    const grid = cssVar("--border-subtle", "rgba(255,255,255,0.08)");
    const surface = cssVar("--bg-surface", "#101821");
    const border = cssVar("--border-medium", "rgba(255,255,255,0.15)");
    const bar = chart.type === "bar";

    createChart("fin-chart", {
        type: bar ? "bar" : "line",
        data: {
            labels: chart.labels,
            datasets: chart.series.map(s => {
                const color = seriesColor(s.color);
                return {
                    label: s.label,
                    data: s.data,
                    borderColor: color,
                    backgroundColor: bar ? withAlpha(color, 0.75) : (s.fill ? withAlpha(color, chart.stacked ? 0.35 : 0.12) : color),
                    fill: !bar && s.fill ? (chart.stacked ? "stack" : "origin") : false,
                    borderWidth: 2,
                    borderDash: s.dashed ? [5, 4] : [],
                    borderRadius: bar ? 4 : 0,
                    pointRadius: 0,
                    pointHoverRadius: 4,
                    tension: 0.15,
                    stack: chart.stacked ? "cpf" : undefined
                };
            })
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: reducedMotion() ? false : { duration: 650, easing: "easeOutCubic" },
            interaction: { mode: "index", intersect: false },
            plugins: {
                legend: { display: chart.series.length > 1, labels: { color: text, boxWidth: 12, usePointStyle: true } },
                tooltip: {
                    backgroundColor: surface, titleColor: text, bodyColor: text, borderColor: border, borderWidth: 1, padding: 10,
                    callbacks: { label: item => ` ${item.dataset.label}: ${money(item.parsed.y)}` }
                }
            },
            scales: {
                x: { stacked: Boolean(chart.stacked), grid: { display: false }, ticks: { color: muted, maxTicksLimit: 10, autoSkip: true }, title: chart.xTitle ? { display: true, text: chart.xTitle, color: muted } : undefined },
                y: { stacked: Boolean(chart.stacked), grid: { color: grid }, ticks: { color: muted, callback: compactMoney }, beginAtZero: true }
            }
        }
    });
}

function renderResults() {
    const t = tool();
    const raw = valuesFor(t);
    const { values, problems } = numericValues(t, raw);
    let result = problems.length ? { problems } : null;

    if (!result) {
        try { result = t.compute(values); }
        catch (error) { console.error(error); result = { problems: ["Something went wrong with these numbers. Please check them."] }; }
    }

    state.last = { tool: t, values, raw, result };

    const problemsBox = qs("#fin-problems");
    const body = qs("#fin-result-body");

    if (result.problems?.length) {
        problemsBox.hidden = false;
        problemsBox.innerHTML = `<strong>Check these first:</strong><ul>${result.problems.map(p => `<li>${escapeHtml(p)}</li>`).join("")}</ul>`;
        body.hidden = true;
        destroyChart("fin-chart");
        return;
    }

    problemsBox.hidden = true;
    body.hidden = false;

    const previousKey = qs("#fin-tiles .fin-tile.is-key strong")?.textContent;
    qs("#fin-tiles").innerHTML = result.tiles.map(tile => `
        <div class="calc-tile fin-tile${tile.strong ? " is-key" : ""}${tile.tone ? ` is-${tile.tone}` : ""}">
            <span>${escapeHtml(tile.label)}</span>
            <strong>${escapeHtml(tile.value)}</strong>
            ${tile.note ? `<em>${escapeHtml(tile.note)}</em>` : ""}
        </div>`).join("");

    const keyValue = qs("#fin-tiles .fin-tile.is-key strong");
    if (keyValue && previousKey && previousKey !== keyValue.textContent && !reducedMotion() && state.lastTool === t.id) {
        keyValue.animate([{ opacity: 0.35, transform: "translateY(3px)" }, { opacity: 1, transform: "none" }], { duration: 260, easing: EASE });
    }
    state.lastTool = t.id;

    drawChart(result.chart);

    const tableWrap = qs("#fin-table-details");
    if (result.table) {
        tableWrap.hidden = false;
        qs("#fin-table").innerHTML = `<thead><tr>${result.table.head.map(h => `<th>${escapeHtml(h)}</th>`).join("")}</tr></thead>
            <tbody>${result.table.rows.map(row => `<tr>${row.map(cell => `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`).join("")}</tbody>`;
    } else {
        tableWrap.hidden = true;
    }

    const notes = [...(result.notes ?? [])];
    const footnote = rulesFootnote(t.id);
    qs("#fin-notes").innerHTML = notes.map(n => `<p>${escapeHtml(n)}</p>`).join("")
        + (footnote ? `<p class="fin-rules-note">${escapeHtml(footnote)}</p>` : "");
}

function schedule() {
    clearTimeout(state.timer);
    state.timer = setTimeout(() => { renderResults(); saveState(); }, 120);
}

function setValue(key, value) {
    const t = tool();
    state.values[t.id] = { ...valuesFor(t), [key]: value };
}

// ------------------------------------------------------------
// Smooth switching between calculators (follows the dashboard's
// motion: off when the device asks for reduced motion)
// ------------------------------------------------------------

const EASE = "cubic-bezier(.2, .8, .2, 1)";

function reducedMotion() {
    return Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
}

function smoothSwitch(change) {
    const cards = [qs(".fin-input-card"), qs(".fin-result-card")].filter(Boolean);
    if (reducedMotion() || !cards.length || typeof cards[0].animate !== "function") { change(); return; }

    cards.forEach(card => card.getAnimations().forEach(a => a.cancel()));
    const before = cards.map(card => card.getBoundingClientRect().height);
    change();

    cards.forEach((card, i) => {
        const after = card.getBoundingClientRect().height;
        if (Math.abs(after - before[i]) > 1) {
            const overflow = card.style.overflow;
            card.style.overflow = "hidden";
            const anim = card.animate([{ height: `${before[i]}px` }, { height: `${after}px` }], { duration: 380, easing: EASE });
            anim.onfinish = anim.oncancel = () => { card.style.overflow = overflow; };
        }
    });

    const parts = [
        ...qs(".fin-input-card").querySelectorAll(".fin-card-head, .fin-field:not([hidden])"),
        ...qs(".fin-result-card").querySelectorAll(".fin-tile, #fin-chart-wrap:not([hidden]), #fin-table-details:not([hidden]), #fin-notes")
    ];
    parts.forEach((part, i) => {
        part.animate(
            [{ opacity: 0, transform: "translateY(10px)" }, { opacity: 1, transform: "none" }],
            { duration: 360, delay: Math.min(i, 12) * 22, easing: EASE, fill: "backwards" }
        );
    });
}

// ------------------------------------------------------------
// Sharing: copy a summary, print a client report
// ------------------------------------------------------------

function summaryText() {
    const last = state.last;
    if (!last || last.result.problems?.length) return "";
    const date = new Date().toLocaleDateString("en-SG", { day: "numeric", month: "long", year: "numeric" });
    const lines = [
        `${last.tool.name}${state.client ? ` · ${state.client}` : ""} (${date})`,
        "",
        ...last.result.tiles.map(tile => `• ${tile.label}: ${tile.value}${tile.note ? ` (${tile.note})` : ""}`),
        "",
        ...(last.result.summary ?? []),
        "",
        "Illustration only, based on the assumptions shown; actual results will differ. Not financial advice."
    ];
    return lines.join("\n");
}

async function copySummary(button) {
    const text = summaryText();
    if (!text) return;
    let ok = false;
    try { await navigator.clipboard.writeText(text); ok = true; }
    catch {
        const area = document.createElement("textarea");
        area.value = text; area.style.position = "fixed"; area.style.opacity = "0";
        document.body.append(area); area.select();
        try { ok = document.execCommand("copy"); } catch { ok = false; }
        area.remove();
    }
    const label = button.textContent;
    button.textContent = ok ? "Copied ✓" : "Copy failed";
    setTimeout(() => { button.textContent = label; }, 1600);
}

function inputRows(last) {
    return last.tool.fields
        .filter(field => !field.showIf || field.showIf(last.raw))
        .filter(field => field.type !== "flows")
        .map(field => {
            const v = last.raw[field.key];
            let shown = v;
            if (field.type === "money") shown = money(Number(v));
            else if (field.type === "percent") shown = `${plain(v)}%`;
            else if (field.type === "choice" || field.type === "select") shown = field.options.find(o => o[0] === v)?.[1] ?? v;
            return [field.label, shown];
        });
}

// The chart again, in print colours on white, for the client report
function printChartImage(chart) {
    if (!chart || !window.Chart) return "";
    const palette = { 1: "#1b6fd1", 2: "#d0612b", 3: "#16956a", 4: "#b07a00", muted: "#7a8691" };
    const canvas = document.createElement("canvas");
    canvas.width = 1600; canvas.height = 640;
    const bar = chart.type === "bar";
    let image = "";
    try {
        const c = new window.Chart(canvas, {
            type: bar ? "bar" : "line",
            data: {
                labels: chart.labels,
                datasets: chart.series.map(s => {
                    const color = palette[s.color] ?? palette[1];
                    return {
                        label: s.label, data: s.data, borderColor: color,
                        backgroundColor: bar ? withAlpha(color, 0.8) : (s.fill ? withAlpha(color, chart.stacked ? 0.35 : 0.12) : color),
                        fill: !bar && s.fill ? (chart.stacked ? "stack" : "origin") : false,
                        borderWidth: 3, borderDash: s.dashed ? [8, 6] : [], borderRadius: bar ? 4 : 0,
                        pointRadius: 0, tension: 0.15, stack: chart.stacked ? "cpf" : undefined
                    };
                })
            },
            options: {
                responsive: false, animation: false, devicePixelRatio: 1,
                plugins: { legend: { display: chart.series.length > 1, labels: { color: "#1b2430", font: { size: 22 }, boxWidth: 22 } }, tooltip: { enabled: false } },
                scales: {
                    x: { stacked: Boolean(chart.stacked), grid: { display: false }, ticks: { color: "#4a5560", font: { size: 20 }, maxTicksLimit: 12 }, title: chart.xTitle ? { display: true, text: chart.xTitle, color: "#4a5560", font: { size: 20 } } : undefined },
                    y: { stacked: Boolean(chart.stacked), beginAtZero: true, grid: { color: "#e3e7eb" }, ticks: { color: "#4a5560", font: { size: 20 }, callback: compactMoney } }
                }
            },
            plugins: [{ id: "white", beforeDraw: ch => { const x = ch.ctx; x.save(); x.fillStyle = "#ffffff"; x.fillRect(0, 0, ch.width, ch.height); x.restore(); } }]
        });
        image = canvas.toDataURL("image/png");
        c.destroy();
    } catch { image = ""; }
    return image;
}

function printReport() {
    const last = state.last;
    if (!last || last.result.problems?.length) return;

    const image = printChartImage(last.result.chart);

    const date = new Date().toLocaleDateString("en-SG", { day: "numeric", month: "long", year: "numeric" });
    const site = document.title.split(/\s[—–|-]\s/)[0].trim();
    const r = last.result;

    const html = `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(last.tool.name)}${state.client ? ` – ${escapeHtml(state.client)}` : ""}</title>
<style>
  *{box-sizing:border-box} body{font:13px/1.5 -apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#1b2430;margin:28px}
  h1{font-size:22px;margin:0 0 2px} .sub{color:#5b6672;margin-bottom:18px}
  .tiles{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin:12px 0 16px}
  .tile{border:1px solid #d5dbe1;border-radius:8px;padding:10px}
  .tile span{display:block;font-size:10px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:#5b6672}
  .tile strong{display:block;font-size:17px;margin-top:2px} .tile em{display:block;font-style:normal;color:#5b6672;font-size:11px}
  .tile.key{border-color:#1b6fd1;background:#f2f7fd}
  h2{font-size:14px;margin:18px 0 6px} table{width:100%;border-collapse:collapse;font-size:12px}
  th,td{border-bottom:1px solid #e3e7eb;padding:5px 6px;text-align:right} th:first-child,td:first-child{text-align:left}
  th{background:#f5f7f9} img{width:100%;max-height:300px;object-fit:contain;margin-top:6px}
  .summary p{margin:4px 0} .fine{color:#6a7480;font-size:11px;margin-top:18px;border-top:1px solid #e3e7eb;padding-top:8px}
  @media print{body{margin:12mm} .tiles{grid-template-columns:repeat(4,1fr)} tr{break-inside:avoid}}
</style></head><body>
<h1>${escapeHtml(last.tool.name)}</h1>
<div class="sub">${state.client ? `Prepared for ${escapeHtml(state.client)} · ` : ""}${escapeHtml(date)} · ${escapeHtml(site)}</div>
<div class="tiles">${r.tiles.map(t => `<div class="tile${t.strong ? " key" : ""}"><span>${escapeHtml(t.label)}</span><strong>${escapeHtml(t.value)}</strong>${t.note ? `<em>${escapeHtml(t.note)}</em>` : ""}</div>`).join("")}</div>
<div class="summary">${(r.summary ?? []).map(s => `<p>${escapeHtml(s)}</p>`).join("")}</div>
${image ? `<img src="${image}" alt="Chart">` : ""}
<h2>Assumptions</h2>
<table><tbody>${inputRows(last).map(([k, v]) => `<tr><td>${escapeHtml(k)}</td><td>${escapeHtml(v)}</td></tr>`).join("")}</tbody></table>
${r.table ? `<h2>Details</h2><table><thead><tr>${r.table.head.map(h => `<th>${escapeHtml(h)}</th>`).join("")}</tr></thead><tbody>${r.table.rows.map(row => `<tr>${row.map(c => `<td>${escapeHtml(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>` : ""}
<div class="fine">${[...(r.notes ?? []), rulesFootnote(last.tool.id)].filter(Boolean).map(n => `<p>${escapeHtml(n)}</p>`).join("")}<p>This illustration is based on the assumptions shown and is for discussion only. Returns, rates and rules can change, and actual results will differ. It is not financial advice or a recommendation.</p></div>
</body></html>`;

    openPrintPreview(html, `${last.tool.name}${state.client ? ` · ${state.client}` : ""}`);
}

// Preview popup (same look as Report Generation's preview): the report on
// an A4 page, with Print / Save as PDF and a close button
function printDialog() {
    let dialog = qs("#fin-print-dialog");
    if (dialog) return dialog;

    dialog = document.createElement("dialog");
    dialog.id = "fin-print-dialog";
    dialog.className = "report-dialog fin-print-dialog";
    dialog.setAttribute("aria-labelledby", "fin-print-title");
    dialog.innerHTML = `
        <div class="report-toolbar">
            <div class="report-toolbar-title">
                <strong id="fin-print-title">Report preview</strong>
                <span class="settings-help" id="fin-print-sub">A4 · this is how the PDF will look</span>
            </div>
            <div class="report-toolbar-actions">
                <button type="button" class="report-generate" data-fin-print-go>⎙ Print / Save as PDF</button>
                <button type="button" class="report-close" data-fin-print-close aria-label="Close preview" title="Close">×</button>
            </div>
        </div>
        <div class="report-paper-area fin-print-area">
            <iframe class="fin-print-frame" title="Report preview"></iframe>
        </div>`;
    document.body.append(dialog);

    const frame = dialog.querySelector("iframe");
    const go = dialog.querySelector("[data-fin-print-go]");
    go.addEventListener("click", () => {
        try { frame.contentWindow.focus(); frame.contentWindow.print(); }
        catch { window.print(); }
        go.focus();     // so Esc closes the preview afterwards
    });
    dialog.querySelector("[data-fin-print-close]").addEventListener("click", () => dialog.close());
    dialog.addEventListener("click", event => { if (event.target === dialog) dialog.close(); });

    // Grow the page to the report's full length
    frame.addEventListener("load", () => {
        try {
            const doc = frame.contentDocument;
            frame.style.height = `${Math.max(600, doc.documentElement.scrollHeight + 4)}px`;
            doc.addEventListener("keydown", event => { if (event.key === "Escape") dialog.close(); });
        } catch { /* keep the default height */ }
    });
    return dialog;
}

function openPrintPreview(html, subtitle) {
    const dialog = printDialog();
    dialog.querySelector("#fin-print-title").textContent = "Report preview";
    dialog.querySelector("#fin-print-sub").textContent = `A4 · ${subtitle}`;
    const frame = dialog.querySelector("iframe");
    frame.style.height = "";
    frame.srcdoc = html;
    if (!dialog.open) dialog.showModal();
    dialog.querySelector(".report-paper-area").scrollTop = 0;
}

// ------------------------------------------------------------
// Events
// ------------------------------------------------------------

function bindEvents() {
    const root = qs("#fin-calc");

    root.addEventListener("click", event => {
        const pick = event.target.closest("[data-fin-tool]");
        if (pick) {
            if (pick.dataset.finTool === state.tool) return;
            state.tool = pick.dataset.finTool;
            smoothSwitch(() => {
                renderPicker();
                renderForm();
                renderResults();
            });
            saveState();
            return;
        }

        const choice = event.target.closest("[data-fin-choice]");
        if (choice) {
            setValue(choice.dataset.finChoice, choice.dataset.value);
            choice.parentElement.querySelectorAll("[data-fin-choice]").forEach(b => {
                const on = b === choice;
                b.classList.toggle("active", on);
                b.setAttribute("aria-checked", String(on));
            });
            refreshVisibility();
            schedule();
            return;
        }

        if (event.target.closest("[data-fin-flow-add]")) {
            const t = tool();
            const flows = [...(valuesFor(t).flows ?? [])];
            flows.push({ date: todayIso(), kind: "in", amount: "" });
            setValue("flows", flows);
            renderForm();
            schedule();
            return;
        }

        const remove = event.target.closest("[data-fin-flow-remove]");
        if (remove) {
            const t = tool();
            const flows = [...(valuesFor(t).flows ?? [])];
            flows.splice(Number(remove.dataset.finFlowRemove), 1);
            setValue("flows", flows);
            renderForm();
            schedule();
            return;
        }

        if (event.target.closest("[data-fin-copy]")) { copySummary(event.target.closest("[data-fin-copy]")); return; }
        if (event.target.closest("[data-fin-print]")) { printReport(); return; }
        if (event.target.closest("[data-fin-reset]")) {
            delete state.values[tool().id];
            smoothSwitch(() => {
                renderForm();
                renderResults();
            });
            saveState();
        }
    });

    const onInput = event => {
        const field = event.target.closest("[data-fin-field]");
        if (field) {
            setValue(field.dataset.finField, field.value);
            refreshVisibility();
            schedule();
            return;
        }

        const flowInput = event.target.closest("[data-fin-flow-key]");
        if (flowInput) {
            const index = Number(flowInput.closest("[data-fin-flow]").dataset.finFlow);
            const t = tool();
            const flows = (valuesFor(t).flows ?? []).map(row => ({ ...row }));
            flows[index][flowInput.dataset.finFlowKey] = flowInput.value;
            setValue("flows", flows);
            schedule();
            return;
        }

        if (event.target.id === "fin-client") {
            state.client = event.target.value.trim();
            schedule();
        }
    };

    root.addEventListener("input", onInput);
    root.addEventListener("change", onInput);

    // Charts follow theme changes
    new MutationObserver(() => { if (!qs("#fin-calc")?.closest("[hidden]")) renderResults(); })
        .observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-accent", "data-variant", "data-style"] });
}

export async function initializeFinanceCalculator() {
    if (!qs("#fin-calc")) return;
    if (state.initialized) { renderResults(); return; }
    state.initialized = true;
    loadState();
    renderPicker();
    renderForm();
    bindEvents();
    renderResults();
    await loadRules();          // latest reference data, then redraw with it
    renderForm();
    renderResults();
}

// For tests
export const _test = { setRules: r => { RULES = mergeRules(DEFAULT_RULES, r); }, rulesFootnote, TOOLS, computeGrowth, computeGoal, computeReturns, computeLoan, computeAfford, computeRefi, computeRetire, computeDrawdown, computeCpf, computeProtect, computeInflation, computeDividend, buyersStampDuty, xirr };
