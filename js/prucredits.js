/* ============================================================
   ELG FMS — PRUCREDIT$ CALCULATOR
   ============================================================

   Works out production credit (PruCredit$) from policy premiums:

     eligible base = annualised premium
                     (monthly × 12, quarterly × 4, half-yearly × 2)
                   = 10% of premium for single premiums / lump sums
                   = the amount entered, for "other eligible base"
     PRUActive Family Care (term-based): 8-year term 80%,
                   9-year 90%, 10 years and above 100% of the base
     PruCredit$    = eligible base × the product's multiplier

   Premiums can be added from screenshots / photos (read in the
   browser with Tesseract OCR - nothing is uploaded anywhere),
   pasted as text, or typed in.

   Multipliers: PRUCredits Multiplier Table (July 2026), plus
   OAI 012/26 (PRUActive Protect II, 2 Sep 2026) and OAI 014/26
   (PRUActive Family Care, 7 Oct 2026). Not exhaustive; the
   OneAgency Instruction takes precedence if rates differ.
   ============================================================ */

const TESSERACT_URL = "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js";


/* ============================================================
   MULTIPLIER TABLE
   [name, category, multiplier, source, family]
   family: links riders to their base plan when a rider name is
   shared (e.g. "Early Protect" on PRUActive Protect / Protect II)
   ============================================================ */

const JUL = "Jul 2026";
const OAI12 = "OAI 012/26 · 2 Sep 2026";
const OAI14 = "OAI 014/26 · 7 Oct 2026";

const RATES = [
    ["PRUShield Extra", "Medical", 2.5, JUL],
    ["PRUShield As Charged", "Medical", 2.5, JUL],

    ["PRUActive Link Guard", "Protection", 1.5, JUL],
    ["PRUVantage Legacy Index", "Protection", 1.5, JUL],
    ["PRUVantage Legacy Index (Multipay)", "Protection", 1.5, JUL],
    ["PRUApex Legacy Index II", "Protection", 1.5, JUL],
    ["PRUApex Legacy Index II (Multipay)", "Protection", 1.5, JUL],
    ["PRUPersonal Accident", "Protection", 1.5, JUL],
    ["PRUActive Life V", "Protection", 1.5, JUL, "pal5"],
    ["PRUFirst Promise", "Protection", 1.5, JUL],
    ["PRULife Vantage Achiever Prime II", "Protection", 1.5, JUL],
    ["PRUMum", "Protection", 1.5, JUL],
    ["PRUMortgage Refund Premier", "Protection", 1.5, JUL],
    ["PRUActive Link Guard-Investment Booster (Lumpsum / Regular)", "Protection", 1, JUL],
    ["PRUVantage Legacy Index - Top up/additional premium", "Protection", 1, JUL],
    ["PRUVantage Legacy Index (Multipay) - Top up/additional premium", "Protection", 1, JUL],
    ["PRUApex Legacy Index II - Top up/additional premium", "Protection", 1, JUL],
    ["PRUApex Legacy Index II (Multipay) - Top up/additional premium", "Protection", 1, JUL],
    ["PRUActive Crisis Guard (upon auto-renewal)", "Protection", 1, JUL],
    ["PRULady", "Protection", 6, JUL],
    ["PRUMan", "Protection", 6, JUL],
    ["PRUEarly Stage Crisis Cover (Basic)", "Protection", 6, JUL],
    ["PRUActive Protect", "Protection", 3, JUL, "pap"],
    ["PRUVital Cover", "Protection", 3, JUL],
    ["PRUCancer 360", "Protection", 3, JUL],
    ["PRUActive Crisis Guard (upon inception)", "Protection", 3, JUL],
    ["PRUActive Term", "Protection", 3, JUL, "pat"],
    ["PRUSafe Income", "Protection", 3, JUL],
    ["PRUHospital Care360", "Protection", 3, JUL],
    ["PRUMortgage", "Protection", 3, JUL],

    ["Disability Provider III", "Riders", 10, JUL],
    ["Vital Cover Disability", "Riders", 10, JUL],
    ["Crisis Waiver III", "Riders", 8, JUL],
    ["Early Stage Crisis Waiver", "Riders", 8, JUL],
    ["Payer Security Plus", "Riders", 8, JUL],
    ["Early Payer Security", "Riders", 8, JUL],
    ["Crisis Care III (PRUActive Term)", "Riders", 3, JUL, "pat"],
    ["Early Crisis Care (PRUActive Life V)", "Riders", 3, JUL, "pal5"],
    ["SimpleTerm", "Riders", 3, JUL],
    ["Life Protect Plus (PRUActive Protect)", "Riders", 3, JUL, "pap"],
    ["Early Crisis Protect", "Riders", 1.5, JUL],
    ["Crisis Care (PRUActive Life V)", "Riders", 1.5, JUL, "pal5"],
    ["Accident Assist", "Riders", 1.5, JUL],
    ["Early Protect (PRUActive Protect)", "Riders", 6, JUL, "pap"],
    ["Early Protect Plus (PRUActive Protect)", "Riders", 6, JUL, "pap"],
    ["Monthly Benefit (PRUActive Protect)", "Riders", 6, JUL, "pap"],
    ["Protect Plus (PRUActive Protect)", "Riders", 6, JUL, "pap"],
    ["Severe Infections Protect (PRUActive Protect)", "Riders", 6, JUL, "pap"],
    ["Recovery Aid", "Riders", 2, JUL],
    ["Fracture Care", "Riders", 2, JUL],
    ["Increase in Death Benefit Rider (PRUActive Term)", "Riders", 2, JUL, "pat"],

    ["PRUActive Retirement II (incl. Premier)", "Savings & investment", 1, JUL],
    ["PRULink SuperGrowth A/C - Cash", "Savings & investment", 1, JUL],
    ["PRULink InvestGrowth - Cash / SRS", "Savings & investment", 1, JUL],
    ["PRULink FlexGrowth - Cash / SRS", "Savings & investment", 1, JUL],
    ["PRUSelect Vantage (incl. Premier)", "Savings & investment", 1, JUL],
    ["PRUWealth Plus (RP & SP)", "Savings & investment", 1, JUL],
    ["PRUWealth (USD) - SP", "Savings & investment", 1, JUL],
    ["PRUWealth Income/PRUWealth Income (USD)", "Savings & investment", 1, JUL],
    ["PRUActive Cash", "Savings & investment", 1, JUL],
    ["PRUActive Saver III (RP & SP)", "Savings & investment", 1, JUL],
    ["PRUVantage Assure (RP & SP)", "Savings & investment", 1, JUL],
    ["PRULifetime Income Plus (RP & SP)", "Savings & investment", 1, JUL],
    ["PRUVantage Wealth III (incl. Investment Booster)", "Savings & investment", 1, JUL],
    ["PRUVantage Prosper (SGD and USD)", "Savings & investment", 1, JUL],
    ["PRUAssure IndexRewards", "Savings & investment", 1, JUL],
    ["PRUIndex Lifetime Income (SGD and USD)", "Savings & investment", 1, JUL],
    ["PRUApex MultiGen Wealth USD (RP)", "Savings & investment", 1, JUL],
    ["PRUApex MultiGen Wealth USD (SP)", "Savings & investment", 1, JUL],
    ["PRUIndex Income Boost", "Savings & investment", 0.8, JUL],

    ["PRULink SuperGrowth A/C - CPF", "CPFIS", 0.25, JUL],
    ["PRULink SuperSaver A/C - CPF", "CPFIS", 0.25, JUL],
    ["PRULink InvestGrowth SP OA - Top up/eTop up", "CPFIS", 0.25, JUL],
    ["PRULink InvestGrowth SP SA - Top up/eTop up", "CPFIS", 0.25, JUL],

    ["PRUActive Protect II", "Protection", 3, OAI12, "pap2"],
    ["Protect Plus (PRUActive Protect II)", "Riders", 6, OAI12, "pap2"],
    ["Early Protect (PRUActive Protect II)", "Riders", 6, OAI12, "pap2"],
    ["Early Protect Plus (PRUActive Protect II)", "Riders", 6, OAI12, "pap2"],
    ["Life Protect Plus (PRUActive Protect II)", "Riders", 3, OAI12, "pap2"],
    ["Severe Infections Protect (PRUActive Protect II)", "Riders", 6, OAI12, "pap2"],
    ["Monthly Benefit - 1 Year Payout (PRUActive Protect II)", "Riders", 6, OAI12, "pap2"],
    ["Monthly Benefit - 2 Years Payout (PRUActive Protect II)", "Riders", 6, OAI12, "pap2"],
    ["Monthly Benefit - 3 Years Payout (PRUActive Protect II)", "Riders", 6, OAI12, "pap2"],
    ["Crisis Waiver III (PRUActive Protect II)", "Riders", 8, OAI12, "pap2"],
    ["Early Crisis Waiver (PRUActive Protect II)", "Riders", 8, OAI12, "pap2"],

    ["PRUActive Family Care", "Protection", 1.5, OAI14, "familycare"],
    ["TPD On PRUActive Family Care", "Riders", 1.5, OAI14, "familycare"],
    ["Crisis Care (PRUActive Family Care)", "Riders", 1.5, OAI14, "familycare"],
    ["Parent Guard (PRUActive Family Care)", "Riders", 1.5, OAI14, "familycare"],
    ["Early Crisis Care (PRUActive Family Care)", "Riders", 3, OAI14, "familycare"]
].map(([name, category, multiplier, source, family = ""], index) => ({
    id: `p${index}`,
    name,
    category,
    multiplier,
    source,
    family,
    termBased: family === "familycare"
}));

const BY_ID = new Map(RATES.map(product => [product.id, product]));

const CATEGORY_ORDER = ["Medical", "Protection", "Riders", "Savings & investment", "CPFIS"];

const FREQUENCIES = [
    { value: "monthly", label: "Monthly", factor: 12 },
    { value: "quarterly", label: "Quarterly", factor: 4 },
    { value: "half", label: "Half-yearly", factor: 2 },
    { value: "annual", label: "Annual", factor: 1 },
    { value: "single", label: "Single premium", factor: 0.1 },
    { value: "base", label: "Other eligible base", factor: 1 }
];

const FREQ = new Map(FREQUENCIES.map(item => [item.value, item]));

const TERMS = [
    { value: "10", label: "10 years or more (100%)", factor: 1 },
    { value: "9", label: "9 years (90%)", factor: 0.9 },
    { value: "8", label: "8 years (80%)", factor: 0.8 }
];

const TERM = new Map(TERMS.map(item => [item.value, item]));


/* ============================================================
   STATE
   ============================================================ */

const state = {
    policies: [],        // [{ id, title, source, status, items: [...] }]
    view: "calc",
    search: "",
    nextId: 1
};

let root = null;
let bound = false;
let tesseractPromise = null;
let ocrWorkerPromise = null;


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

function newId() {
    state.nextId += 1;
    return `x${state.nextId}`;
}

function money(value) {
    return `S$${Number(value || 0).toLocaleString("en-SG", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function credits(value) {
    return Number(value || 0).toLocaleString("en-SG", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function multiplierText(value) {
    return `${Number(value).toLocaleString("en-SG", { maximumFractionDigits: 2 })}×`;
}

function normalise(text) {
    return String(text ?? "")
        .toLowerCase()
        .replace(/[®™$]/g, "")
        .replace(/\bii\b|\bil\b|\b2\b/g, "ii")
        .replace(/[^a-z0-9]+/g, "");
}

function shortName(name) {
    return name.replace(/\s*\([^)]*\)\s*$/, "").trim();
}

function levenshtein(a, b) {
    if (a === b) return 0;
    let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
    for (let i = 1; i <= a.length; i += 1) {
        const current = [i];
        for (let j = 1; j <= b.length; j += 1) {
            current[j] = Math.min(
                current[j - 1] + 1,
                previous[j] + 1,
                previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
            );
        }
        previous = current;
    }
    return previous[b.length];
}


/* ============================================================
   CALCULATION
   ============================================================ */

function itemResult(item) {
    const product = BY_ID.get(item.productId);
    const premium = Number(item.premium);
    const frequency = FREQ.get(item.frequency);

    if (!product || !frequency || !(premium > 0)) {
        return { complete: false, base: 0, credits: 0, product };
    }

    if (product.termBased && !TERM.has(item.term)) {
        return { complete: false, base: 0, credits: 0, product, needsTerm: true };
    }

    let base = premium * frequency.factor;

    if (product.termBased) {
        base *= TERM.get(item.term).factor;
    }

    return {
        complete: true,
        base,
        credits: base * product.multiplier,
        product
    };
}

function totals() {
    let base = 0;
    let total = 0;
    let complete = 0;
    let count = 0;

    for (const policy of state.policies) {
        for (const item of policy.items) {
            count += 1;
            const result = itemResult(item);
            if (result.complete) {
                complete += 1;
                base += result.base;
                total += result.credits;
            }
        }
    }

    return { base, total, complete, count };
}


/* ============================================================
   READING PREMIUM TEXT (pasted, or from a screenshot)
   ============================================================ */

const NAME_INDEX = RATES.flatMap(product => {
    const keys = new Set([normalise(product.name), normalise(shortName(product.name))]);
    // "PRUActive Link Guard" is often written "PRUActive LinkGuard"
    for (const key of [...keys]) keys.add(key.replace(/linkguard/g, "linkguard"));
    return [...keys].filter(Boolean).map(key => ({ key, product }));
}).sort((a, b) => b.key.length - a.key.length);

function familyOfText(text) {
    const t = normalise(text);
    if (/pruactivefamilycare/.test(t)) return "familycare";
    if (/pruactiveprotectii/.test(t)) return "pap2";
    if (/pruactiveprotect/.test(t)) return "pap";
    if (/pruactivelifev/.test(t)) return "pal5";
    if (/pruactiveterm/.test(t)) return "pat";
    return "";
}

/*
 * Best product for a line of text. A rider name shared by several
 * plans ("Early Protect") goes to the plan of the policy it's on.
 */
function matchProduct(text, family = "") {
    const t = normalise(text);
    if (!t) return null;

    const hits = NAME_INDEX.filter(entry => entry.key.length >= 4 && t.includes(entry.key));

    if (hits.length) {
        const longest = hits[0].key.length;
        const best = hits.filter(entry => entry.key.length === longest).map(entry => entry.product);
        const unique = [...new Set(best)];

        // "PRUActive Protect" also matches inside "PRUActive Protect II"
        if (unique.length === 1) return unique[0];

        return unique.find(product => product.family === family)
            ?? unique.find(product => !product.family)
            ?? unique[0];
    }

    // Close spelling (OCR mistakes): compare the words before the amount
    const words = t.slice(0, 48);
    let best = null;
    let bestScore = Infinity;

    for (const entry of NAME_INDEX) {
        if (entry.key.length < 6) continue;
        const piece = words.slice(0, entry.key.length);
        const distance = levenshtein(piece, entry.key);
        const score = distance / entry.key.length;
        if (score < bestScore || (score === bestScore && entry.product.family === family)) {
            bestScore = score;
            best = entry.product;
        }
    }

    return bestScore <= 0.2 ? best : null;
}

function frequencyOfText(text) {
    // "Monthly Benefit" is a rider name, not a payment frequency
    const t = String(text).toLowerCase().replace(/monthly\s*benefit/g, "");
    if (/single|lump\s*sum|one[-\s]?time/.test(t)) return "single";
    if (/half[-\s]?year|semi[-\s]?annual|6[-\s]?monthly/.test(t)) return "half";
    if (/quarter/.test(t)) return "quarterly";
    if (/month|\bmthly\b|\bp\.?m\.?\b/.test(t)) return "monthly";
    if (/annual|yearly|\bp\.?a\.?\b|per\s+year/.test(t)) return "annual";
    return "";
}

function amountOfText(text) {
    const matches = [...String(text).replace(/[Oo](?=\d)|(?<=\d)[Oo]/g, "0")
        .matchAll(/(?:S\s?\$|SGD|US\$|\$)?\s*(\d{1,3}(?:[,\s]\d{3})+(?:\.\d{1,2})?|\d+\.\d{1,2}|\d{2,})/g)]
        .map(match => Number(match[1].replace(/[,\s]/g, "")))
        .filter(value => value > 0 && value < 10_000_000);

    return matches.length ? matches[matches.length - 1] : null;
}

/*
 * -> { items: [{productId, premium, frequency, term}], frequency, family, title }
 * One premium per line: the plan / rider name, then its premium.
 * A line with a name but no premium takes the next line's amount.
 */
function parsePremiumText(text) {
    const lines = String(text).split(/\r?\n/).map(line => line.trim()).filter(Boolean);

    const family = familyOfText(text);
    const frequency = frequencyOfText(text);
    const items = [];

    let pending = null;

    for (const line of lines) {
        const product = matchProduct(line, family);
        const amount = amountOfText(line.replace(/\b(19|20)\d{2}\b/g, ""));
        const lineFrequency = frequencyOfText(line);

        if (product && amount) {
            items.push({ productId: product.id, premium: amount, frequency: lineFrequency || frequency || "", term: "" });
            pending = null;
        } else if (product) {
            pending = product;
        } else if (pending && amount) {
            items.push({ productId: pending.id, premium: amount, frequency: lineFrequency || frequency || "", term: "" });
            pending = null;
        }
    }

    // Same plan read twice (e.g. a heading and a table row): keep one
    const seen = new Set();
    const unique = items.filter(item => {
        const key = `${item.productId}|${item.premium}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });

    const base = unique.map(item => BY_ID.get(item.productId)).find(p => p && p.category !== "Riders");

    return {
        items: unique,
        frequency,
        family,
        title: base?.name ?? (unique[0] ? BY_ID.get(unique[0].productId)?.name : "")
    };
}


/* ============================================================
   SCREENSHOTS (OCR in the browser)
   ============================================================ */

function loadTesseract() {
    if (window.Tesseract) return Promise.resolve(window.Tesseract);

    if (!tesseractPromise) {
        tesseractPromise = new Promise((resolve, reject) => {
            const script = document.createElement("script");
            script.src = TESSERACT_URL;
            script.async = true;
            script.onload = () => window.Tesseract ? resolve(window.Tesseract) : reject(new Error("OCR missing"));
            script.onerror = () => {
                tesseractPromise = null;
                reject(new Error("The text reader couldn't load (check the internet connection)."));
            };
            document.head.appendChild(script);
        });
    }

    return tesseractPromise;
}

function ocrWorker() {
    if (!ocrWorkerPromise) {
        ocrWorkerPromise = loadTesseract()
            .then(Tesseract => Tesseract.createWorker("eng"))
            .catch(error => {
                ocrWorkerPromise = null;
                throw error;
            });
    }
    return ocrWorkerPromise;
}

async function readImage(file, policy) {
    try {
        policy.status = "Reading screenshot…";
        render();

        const worker = await ocrWorker();
        const { data } = await worker.recognize(file);
        const parsed = parsePremiumText(data?.text ?? "");

        policy.items = parsed.items.map(item => ({ ...item, id: newId(), frequency: item.frequency || parsed.frequency || "" }));
        policy.frequency = parsed.frequency;
        policy.title = parsed.title || policy.title;
        policy.status = parsed.items.length
            ? ""
            : "No plan or premium could be read from this screenshot. Add the items below, or try a clearer screenshot.";
    } catch (error) {
        console.warn("ELG FMS: screenshot couldn't be read.", error);
        policy.status = `Couldn't read this screenshot: ${error.message || error}`;
    }

    render();
}

function addImages(files) {
    const images = [...files].filter(file => /^image\//.test(file.type));

    for (const file of images) {
        const policy = {
            id: newId(),
            title: "Screenshot",
            source: file.name || "Pasted screenshot",
            frequency: "",
            status: "Waiting…",
            items: []
        };
        state.policies.push(policy);
        readImage(file, policy);
    }

    render();
}


/* ============================================================
   ACTIONS
   ============================================================ */

function addFromText(text) {
    // A blank line starts a new policy
    const blocks = String(text).split(/\n\s*\n/).map(block => block.trim()).filter(Boolean);
    let added = 0;

    for (const block of blocks) {
        const parsed = parsePremiumText(block);
        if (!parsed.items.length) continue;
        state.policies.push({
            id: newId(),
            title: parsed.title || "Pasted premiums",
            source: "Pasted text",
            frequency: parsed.frequency,
            status: "",
            items: parsed.items.map(item => ({ ...item, id: newId() }))
        });
        added += parsed.items.length;
    }

    return added;
}

function addManual() {
    state.policies.push({
        id: newId(),
        title: "Manual entry",
        source: "Added by hand",
        frequency: "",
        status: "",
        items: [{ id: newId(), productId: "", premium: "", frequency: "", term: "" }]
    });
}

function addExample() {
    const pap = RATES.find(p => p.name === "PRUActive Protect");
    const early = RATES.find(p => p.name === "Early Protect (PRUActive Protect)");
    state.policies.push({
        id: newId(),
        title: "PRUActive Protect",
        source: "Example policy",
        frequency: "monthly",
        status: "",
        items: [
            { id: newId(), productId: pap.id, premium: 100, frequency: "monthly", term: "" },
            { id: newId(), productId: early.id, premium: 20, frequency: "monthly", term: "" }
        ]
    });
}

function findItem(policyId, itemId) {
    const policy = state.policies.find(p => p.id === policyId);
    return { policy, item: policy?.items.find(i => i.id === itemId) };
}

function downloadBreakdown() {
    const rows = [["Policy", "Source", "Plan / rider", "Multiplier", "Premium (S$)", "Frequency", "Term", "Eligible base (S$)", "PruCredit$"]];

    for (const policy of state.policies) {
        for (const item of policy.items) {
            const result = itemResult(item);
            rows.push([
                policy.title,
                policy.source,
                result.product?.name ?? "",
                result.product ? result.product.multiplier : "",
                item.premium,
                FREQ.get(item.frequency)?.label ?? "",
                result.product?.termBased ? (TERM.get(item.term)?.label ?? "") : "",
                result.complete ? result.base.toFixed(2) : "",
                result.complete ? result.credits.toFixed(2) : "not included"
            ]);
        }
    }

    const total = totals();
    rows.push([]);
    rows.push(["Total", "", "", "", "", "", "", total.base.toFixed(2), total.total.toFixed(2)]);

    const csv = rows.map(row => row.map(cell => {
        const text = String(cell ?? "");
        return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    }).join(",")).join("\r\n");

    const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `prucredits-breakdown-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 2000);
}


/* ============================================================
   RENDER
   ============================================================ */

function productOptions(selectedId) {
    const groups = CATEGORY_ORDER.map(category => {
        const options = RATES
            .filter(product => product.category === category)
            .map(product => `<option value="${product.id}" ${product.id === selectedId ? "selected" : ""}>${escapeHtml(product.name)} · ${multiplierText(product.multiplier)}</option>`)
            .join("");
        return `<optgroup label="${escapeHtml(category)}">${options}</optgroup>`;
    }).join("");

    return `<option value="" ${selectedId ? "" : "selected"}>Choose plan / rider…</option>${groups}`;
}

function frequencyOptions(selected, placeholder = "Frequency…") {
    return `<option value="" ${selected ? "" : "selected"}>${placeholder}</option>` +
        FREQUENCIES.map(f => `<option value="${f.value}" ${f.value === selected ? "selected" : ""}>${f.label}</option>`).join("");
}

function termOptions(selected) {
    return `<option value="" ${selected ? "" : "selected"}>Premium term…</option>` +
        TERMS.map(t => `<option value="${t.value}" ${t.value === selected ? "selected" : ""}>${t.label}</option>`).join("");
}

function renderItem(policy, item) {
    const result = itemResult(item);
    const product = result.product;

    let note = "";
    if (!product) note = "Choose the plan or rider";
    else if (!(Number(item.premium) > 0)) note = "Enter the premium";
    else if (!FREQ.has(item.frequency)) note = "Choose the frequency";
    else if (result.needsTerm) note = "Choose the premium term";

    return `
        <div class="pc-item ${result.complete ? "" : "is-incomplete"}" data-pc-item="${item.id}">
            <label class="pc-field pc-field-product">
                <span>Plan / rider</span>
                <select data-pc-edit="productId">${productOptions(item.productId)}</select>
            </label>
            <label class="pc-field pc-field-premium">
                <span>Premium (S$)</span>
                <input type="number" inputmode="decimal" min="0" step="0.01" value="${escapeHtml(item.premium)}" data-pc-edit="premium" placeholder="0.00">
            </label>
            <label class="pc-field pc-field-frequency">
                <span>Frequency</span>
                <select data-pc-edit="frequency">${frequencyOptions(item.frequency)}</select>
            </label>
            ${product?.termBased ? `
                <label class="pc-field pc-field-term">
                    <span>Premium term</span>
                    <select data-pc-edit="term">${termOptions(item.term)}</select>
                </label>
            ` : ""}
            <div class="pc-item-result">
                <span class="pc-item-multiplier">${product ? multiplierText(product.multiplier) : "—"}</span>
                <strong>${result.complete ? credits(result.credits) : "—"}</strong>
                <small>${result.complete ? `base ${money(result.base)}` : escapeHtml(note)}</small>
            </div>
            <button type="button" class="pc-remove" data-pc-remove-item aria-label="Remove this item" title="Remove">×</button>
        </div>
    `;
}

function renderPolicy(policy, index) {
    const subtotal = policy.items.reduce((sum, item) => sum + itemResult(item).credits, 0);

    return `
        <section class="performance-card pc-policy" data-pc-policy="${policy.id}">
            <div class="card-header pc-policy-header">
                <div>
                    <div class="card-eyebrow">POLICY ${String(index + 1).padStart(2, "0")} · ${escapeHtml(policy.source)}</div>
                    <h3 class="card-title">${escapeHtml(policy.title || "Policy")}</h3>
                </div>
                <div class="pc-policy-actions">
                    <button type="button" class="pc-link-button" data-pc-remove-policy>Remove policy</button>
                </div>
            </div>
            ${policy.status ? `<p class="pc-status">${escapeHtml(policy.status)}</p>` : ""}
            <div class="pc-items">
                ${policy.items.map(item => renderItem(policy, item)).join("")}
            </div>
            <div class="pc-policy-footer">
                <button type="button" class="pc-link-button" data-pc-add-item>＋ Add plan / rider</button>
                <span>Policy total <strong>${credits(subtotal)}</strong> PruCredit$</span>
            </div>
        </section>
    `;
}

function renderReference() {
    const term = state.search.trim().toLowerCase();
    const rows = RATES.filter(product =>
        !term || `${product.name} ${product.category} ${product.source}`.toLowerCase().includes(term)
    );

    if (!rows.length) {
        return `<p class="pc-empty">No product matches “${escapeHtml(state.search)}”.</p>`;
    }

    return CATEGORY_ORDER
        .filter(category => rows.some(product => product.category === category))
        .map(category => `
            <h3 class="annex-group-title pc-ref-group">${escapeHtml(category)}</h3>
            <div class="pc-ref-list">
                ${rows.filter(product => product.category === category).map(product => `
                    <div class="pc-ref-row">
                        <div>
                            <div class="pc-ref-name">${escapeHtml(product.name)}</div>
                            <div class="pc-ref-source">${escapeHtml(product.source)}${product.termBased ? " · term-based production credit" : ""}</div>
                        </div>
                        <strong class="pc-ref-multiplier">${multiplierText(product.multiplier)}</strong>
                    </div>
                `).join("")}
            </div>
        `).join("");
}

function render() {
    if (!root) return;

    root.querySelectorAll("[data-pc-view]").forEach(button => {
        const active = button.dataset.pcView === state.view;
        button.classList.toggle("active", active);
        button.setAttribute("aria-selected", String(active));
    });

    root.querySelector("[data-pc-panel='calc']").hidden = state.view !== "calc";
    root.querySelector("[data-pc-panel='ref']").hidden = state.view !== "ref";

    if (state.view === "ref") {
        root.querySelector("[data-pc-reference]").innerHTML = renderReference();
        return;
    }

    renderSummary();

    const list = root.querySelector("[data-pc-policies]");

    list.innerHTML = state.policies.length
        ? state.policies.map(renderPolicy).join("")
        : `<p class="pc-empty">No premiums added yet. Add screenshots, paste the premium text, or add the plans by hand.</p>`;
}

function renderSummary() {
    const total = totals();

    root.querySelector("[data-pc-total]").textContent = credits(total.total);
    root.querySelector("[data-pc-base]").textContent = money(total.base);
    root.querySelector("[data-pc-count]").textContent = `${total.complete} / ${total.count}`;
    root.querySelector("[data-pc-summary-note]").textContent =
        !total.count ? "Add premiums to see your production."
        : total.complete === total.count ? "All items are included."
        : `${total.count - total.complete} item${total.count - total.complete === 1 ? "" : "s"} still need details (marked below) and aren't counted yet.`;
    // Download only once a plan / rider has been added
    root.querySelector("[data-pc-download-bar]").hidden =
        !state.policies.some(policy => policy.items.some(item => BY_ID.has(item.productId)));
    root.querySelector("[data-pc-clear]").hidden = !state.policies.length;
}

/* While typing a premium: update that row, its policy and the totals
   in place, so the field keeps focus. */
function refreshRow(policy, item) {
    const row = root.querySelector(`[data-pc-item="${item.id}"]`);
    if (!row) return;

    const fresh = document.createElement("div");
    fresh.innerHTML = renderItem(policy, item);
    const freshRow = fresh.firstElementChild;

    row.classList.toggle("is-incomplete", freshRow.classList.contains("is-incomplete"));
    row.querySelector(".pc-item-result").replaceWith(freshRow.querySelector(".pc-item-result"));

    const subtotal = policy.items.reduce((sum, entry) => sum + itemResult(entry).credits, 0);
    const box = root.querySelector(`[data-pc-policy="${policy.id}"] .pc-policy-footer strong`);
    if (box) box.textContent = credits(subtotal);

    renderSummary();
}


/* ============================================================
   EVENTS
   ============================================================ */

function bind() {
    if (bound || !root) return;
    bound = true;

    const fileInput = root.querySelector("[data-pc-file]");
    const cameraInput = root.querySelector("[data-pc-camera]");
    const drop = root.querySelector("[data-pc-drop]");

    root.querySelectorAll("[data-pc-view]").forEach(button => {
        button.addEventListener("click", () => {
            state.view = button.dataset.pcView;
            render();
        });
    });

    root.querySelector("[data-pc-search]")?.addEventListener("input", event => {
        state.search = event.target.value;
        render();
    });

    root.querySelector("[data-pc-choose]").addEventListener("click", () => fileInput.click());
    /*
     * Phones / tablets: "Take a photo" opens the camera.
     * Computers: "Take a screenshot" captures a screen, window or
     * browser tab the user picks (e.g. the PRUAccess / illustration
     * page), and reads it like any other screenshot.
     */
    const photoButton = root.querySelector("[data-pc-photo]");

    photoButton.textContent = useCamera() ? "Take a photo" : "Take a screenshot";

    photoButton.addEventListener("click", async () => {
        if (useCamera()) {
            cameraInput.click();
            return;
        }

        const message = root.querySelector("[data-pc-message]");

        try {
            message.textContent = "Choose the screen, window or tab with the premiums…";
            const file = await captureScreen();
            message.textContent = "Screenshot taken, reading…";
            addImages([file]);
        } catch (error) {
            message.textContent = error?.name === "NotAllowedError"
                ? "Screenshot cancelled."
                : "Your browser can't take screenshots here. Take one with your computer (e.g. Win+Shift+S or ⌘+Shift+4), then paste it with Ctrl+V / ⌘V or choose it.";
        }
    });
    fileInput.addEventListener("change", () => { addImages(fileInput.files); fileInput.value = ""; });
    cameraInput.addEventListener("change", () => { addImages(cameraInput.files); cameraInput.value = ""; });

    drop.addEventListener("click", event => {
        if (!event.target.closest("button")) fileInput.click();
    });
    drop.addEventListener("dragover", event => { event.preventDefault(); drop.classList.add("is-over"); });
    drop.addEventListener("dragleave", () => drop.classList.remove("is-over"));
    drop.addEventListener("drop", event => {
        event.preventDefault();
        drop.classList.remove("is-over");
        addImages(event.dataTransfer?.files ?? []);
    });

    const message = root.querySelector("[data-pc-message]");

    /*
     * Paste anywhere on the PruCredit$ page (Ctrl+V / ⌘V, or the
     * phone's Paste): screenshots are read, premium text is added.
     */
    function handlePaste(clipboard) {
        const images = [
            ...[...(clipboard?.files ?? [])],
            ...[...(clipboard?.items ?? [])]
                .filter(item => item.kind === "file" && /^image\//.test(item.type))
                .map(item => item.getAsFile())
                .filter(Boolean)
        ].filter(file => /^image\//.test(file.type));

        // files and items can list the same image twice
        const unique = images.filter((file, index) =>
            images.findIndex(other => other.size === file.size && other.type === file.type) === index
        );

        if (unique.length) {
            addImages(unique);
            message.textContent = `${unique.length} screenshot${unique.length === 1 ? "" : "s"} pasted, reading…`;
            return true;
        }

        const text = clipboard?.getData?.("text/plain") ?? "";

        if (text.trim()) {
            const added = addFromText(text);
            message.textContent = added
                ? `${added} item${added === 1 ? "" : "s"} added from the pasted text.`
                : "No plan with a premium was recognised in the pasted text. Add a screenshot, or add the plans manually.";
            render();
            return true;
        }

        return false;
    }

    document.addEventListener("paste", event => {
        if (!root || root.closest("[hidden]")) return;
        // Typing into a field: let the field take the paste
        if (event.target.closest?.("textarea, input, select")) return;
        if (handlePaste(event.clipboardData)) {
            event.preventDefault();
        }
    });

    root.querySelector("[data-pc-manual]").addEventListener("click", () => { addManual(); render(); });
    root.querySelector("[data-pc-example]").addEventListener("click", () => {
        addExample();
        root.querySelector("[data-pc-message]").textContent = "Example added: PRUActive Protect S$100 + Early Protect S$20, monthly.";
        render();
    });
    root.querySelector("[data-pc-clear]").addEventListener("click", () => {
        state.policies = [];
        root.querySelector("[data-pc-message]").textContent = "";
        render();
    });
    root.querySelector("[data-pc-download]").addEventListener("click", downloadBreakdown);

    const list = root.querySelector("[data-pc-policies]");

    list.addEventListener("input", event => {
        const field = event.target.closest("[data-pc-edit]");
        if (!field || field.dataset.pcEdit !== "premium") return;
        const { policy, item } = findItem(
            field.closest("[data-pc-policy]").dataset.pcPolicy,
            field.closest("[data-pc-item]").dataset.pcItem
        );
        if (item) {
            item.premium = field.value;
            refreshRow(policy, item);
        }
    });

    list.addEventListener("change", event => {
        const policyBox = event.target.closest("[data-pc-policy]");
        if (!policyBox) return;
        const policy = state.policies.find(p => p.id === policyBox.dataset.pcPolicy);

        const field = event.target.closest("[data-pc-edit]");
        if (!field || field.dataset.pcEdit === "premium") return;
        const { item } = findItem(policy.id, field.closest("[data-pc-item]").dataset.pcItem);
        if (item) {
            item[field.dataset.pcEdit] = field.value;
            if (field.dataset.pcEdit === "productId" && !BY_ID.get(field.value)?.termBased) item.term = "";
            if (field.dataset.pcEdit === "productId" && policy.title === "Manual entry" && BY_ID.get(field.value)) {
                policy.title = BY_ID.get(field.value).name;
            }
            render();
        }
    });

    list.addEventListener("click", event => {
        const policyBox = event.target.closest("[data-pc-policy]");
        if (!policyBox) return;
        const policy = state.policies.find(p => p.id === policyBox.dataset.pcPolicy);

        if (event.target.closest("[data-pc-remove-policy]")) {
            state.policies = state.policies.filter(p => p !== policy);
            render();
        } else if (event.target.closest("[data-pc-remove-item]")) {
            const itemId = event.target.closest("[data-pc-item]").dataset.pcItem;
            policy.items = policy.items.filter(item => item.id !== itemId);
            if (!policy.items.length) state.policies = state.policies.filter(p => p !== policy);
            render();
        } else if (event.target.closest("[data-pc-add-item]")) {
            policy.items.push({ id: newId(), productId: "", premium: "", frequency: policy.items[0]?.frequency ?? "", term: "" });
            render();
        }
    });
}

/* Camera on phones and tablets; screenshot on computers */
function useCamera() {
    const touch = window.matchMedia("(pointer: coarse)").matches || navigator.maxTouchPoints > 1;
    const canCapture = !!navigator.mediaDevices?.getDisplayMedia;
    return touch || !canCapture;
}

/* One frame of a screen / window / tab the user picks, as a PNG file */
async function captureScreen() {
    const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { displaySurface: "window" },
        audio: false
    });

    try {
        const video = document.createElement("video");
        video.muted = true;
        video.playsInline = true;
        video.srcObject = stream;

        await new Promise((resolve, reject) => {
            video.onloadedmetadata = resolve;
            video.onerror = reject;
        });
        await video.play();

        // Let the browser's "sharing" prompt disappear first
        await new Promise(resolve => setTimeout(resolve, 400));

        const canvas = document.createElement("canvas");
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);

        const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/png"));

        if (!blob) throw new Error("Screenshot failed");

        return new File([blob], "Screenshot", { type: "image/png" });
    } finally {
        stream.getTracks().forEach(track => track.stop());
    }
}

function initializePruCredits() {
    root = document.querySelector("[data-prucredits]");
    if (!root) return;
    bind();
    render();
}


export {
    initializePruCredits,
    parsePremiumText,
    itemResult
};
