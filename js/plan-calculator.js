/* ============================================================
   ELG FMS — PLAN CALCULATOR
   PRUVantage Assure II (PVA) and PRUVantage Wealth III (PVW)
   ============================================================
   Projects a regular-premium policy year by year at the
   investment return(s) you enter, following the rules in the
   product information packs:

   - Welcome Bonus (years 1-3, by account, premium term and
     annualised premium)
   - Promotion Bonus Units (only when
     "Promotion Reference for PVA PVW/promotion.json" exists and
     the policy start date is inside its promotion period)
   - Loyalty Bonus 0.5% a year of the Growth + Flex Account value
   - Administration charge (% of account value, monthly)
   - PVA only: sum assured (103% -> 160% of premiums paid),
     Wealth Assure Value and monthly assurance charges
   - Surrender charge, death benefit
   - The return entered grows the account value; BID prices are kept at today's price,
     which already include each fund's continuing investment
     charge, so no fund charge is deducted separately

   Checked against the sample policy illustrations in both packs
   (4% and 8%, with the illustrated funds' charges taken off the
   return): the account values match to the dollar.

   Allowed funds = the cells highlighted yellow in
   "PVA PVW Funds List.xlsx" (one sheet per plan). Both plans are
   SGD only. The Flex Account can hold dividend-paying funds only,
   except PVW 3- and 5-year terms (Flex only, any allowed fund).
   ============================================================ */

import { placeDropdown } from "./dropdown-place.js";
import { createChart, destroyChart } from "./charts.js";

const FUNDS_LIST_URL = "PVA PVW Funds List.xlsx";
const PROMO_URL = "Promotion Reference for PVA PVW/promotion.json";
const FUNDS_LIST_FALLBACK_URL = "data/plan-funds.json";   // saved copy, used only if the .xlsx can't be read

const ALLOCATION_STEP = 5;
const MONTHLY_MODAL_FACTOR = 0.0834;   // assurance charge (PVA pack, Appendix A)


/* Assurance charges for Death and Accidental Disability, per S$1,000 sum at risk a year,
   by age next birthday: [Male smoker, Male non-smoker, Female smoker, Female non-smoker]
   (PRUVantage Assure II pack, Appendix A) */
const ASSURANCE_RATES = {
    1: [0.57, 0.57, 0.57, 0.57],
    2: [0.57, 0.57, 0.57, 0.57],
    3: [0.57, 0.57, 0.57, 0.57],
    4: [0.57, 0.57, 0.57, 0.57],
    5: [0.57, 0.57, 0.57, 0.57],
    6: [0.57, 0.57, 0.57, 0.57],
    7: [0.57, 0.57, 0.57, 0.57],
    8: [0.57, 0.57, 0.57, 0.57],
    9: [0.57, 0.57, 0.57, 0.57],
    10: [0.57, 0.57, 0.57, 0.57],
    11: [0.6, 0.6, 0.62, 0.62],
    12: [0.74, 0.74, 0.75, 0.75],
    13: [0.84, 0.84, 0.86, 0.86],
    14: [0.84, 0.84, 0.86, 0.86],
    15: [0.84, 0.84, 0.86, 0.86],
    16: [0.84, 0.84, 0.86, 0.86],
    17: [0.84, 0.84, 0.86, 0.86],
    18: [0.84, 0.84, 0.86, 0.86],
    19: [0.84, 0.84, 0.86, 0.86],
    20: [0.86, 0.84, 0.87, 0.86],
    21: [0.86, 0.84, 0.87, 0.86],
    22: [0.86, 0.84, 0.87, 0.86],
    23: [0.86, 0.84, 0.87, 0.86],
    24: [0.86, 0.84, 0.87, 0.86],
    25: [0.86, 0.84, 0.87, 0.86],
    26: [0.86, 0.84, 0.87, 0.86],
    27: [0.86, 0.84, 0.87, 0.86],
    28: [0.86, 0.84, 0.87, 0.86],
    29: [0.86, 0.84, 0.87, 0.86],
    30: [0.86, 0.84, 0.87, 0.86],
    31: [0.86, 0.84, 0.87, 0.86],
    32: [0.86, 0.84, 0.87, 0.86],
    33: [0.86, 0.84, 0.87, 0.86],
    34: [0.92, 0.84, 0.87, 0.86],
    35: [0.99, 0.84, 0.87, 0.86],
    36: [1.08, 0.84, 0.89, 0.86],
    37: [1.16, 0.89, 0.89, 0.86],
    38: [1.28, 0.95, 0.96, 0.87],
    39: [1.41, 1.02, 1.04, 0.89],
    40: [1.56, 1.08, 1.11, 0.92],
    41: [1.74, 1.17, 1.22, 0.95],
    42: [1.94, 1.31, 1.35, 1.02],
    43: [2.16, 1.44, 1.5, 1.11],
    44: [2.42, 1.61, 1.67, 1.23],
    45: [2.67, 1.79, 1.85, 1.37],
    46: [2.99, 2.0, 2.06, 1.5],
    47: [3.32, 2.22, 2.3, 1.7],
    48: [3.69, 2.42, 2.55, 1.77],
    49: [4.1, 2.61, 2.84, 1.92],
    50: [4.56, 2.94, 3.15, 2.09],
    51: [5.04, 3.27, 3.5, 2.31],
    52: [5.55, 3.57, 3.9, 2.55],
    53: [6.14, 3.95, 4.31, 2.84],
    54: [6.75, 4.35, 4.77, 3.17],
    55: [7.5, 4.79, 5.27, 3.5],
    56: [8.66, 5.28, 5.81, 3.87],
    57: [9.99, 5.79, 6.41, 4.28],
    58: [11.43, 6.35, 7.04, 4.73],
    59: [12.93, 6.78, 7.73, 5.18],
    60: [14.51, 7.23, 8.46, 5.67],
    61: [16.14, 7.89, 9.24, 6.23],
    62: [17.87, 8.67, 10.79, 6.81],
    63: [19.64, 9.53, 12.78, 7.46],
    64: [21.53, 10.46, 14.7, 8.15],
    65: [23.66, 11.48, 16.61, 8.87],
    66: [26.09, 12.66, 18.54, 9.8],
    67: [28.8, 14.0, 20.63, 10.92],
    68: [31.86, 15.47, 22.97, 12.15],
    69: [35.18, 17.09, 25.53, 13.53],
    70: [38.75, 18.84, 28.31, 15.0],
    71: [44.57, 23.04, 32.54, 18.36],
    72: [45.72, 23.63, 33.36, 18.84],
    73: [50.36, 26.04, 36.48, 20.61],
    74: [55.5, 28.7, 39.99, 22.59],
    75: [60.92, 31.5, 43.65, 24.65],
    76: [66.68, 34.52, 47.69, 27.6],
    77: [72.24, 37.89, 51.44, 31.28],
    78: [78.15, 41.57, 55.46, 34.16],
    79: [84.47, 45.57, 59.76, 37.37],
    80: [91.19, 49.91, 64.38, 40.82],
    81: [98.37, 54.6, 69.33, 44.61],
    82: [105.98, 59.72, 74.6, 48.72],
    83: [114.06, 65.24, 80.15, 53.13],
    84: [122.58, 71.18, 85.94, 57.86],
    85: [131.58, 77.6, 91.88, 62.82],
    86: [140.99, 84.45, 97.8, 67.94],
    87: [150.74, 91.76, 103.5, 73.1],
    88: [160.76, 99.47, 108.78, 78.09],
    89: [170.9, 107.52, 113.52, 82.89],
    90: [181.08, 115.88, 117.81, 87.51],
    91: [191.36, 124.56, 123.63, 92.3],
    92: [202.02, 133.77, 135.6, 97.89],
    93: [213.54, 143.76, 148.41, 108.89],
    94: [226.46, 155.03, 162.11, 119.0],
    95: [241.34, 168.06, 179.91, 131.3],
    96: [258.72, 190.53, 203.1, 142.86],
    97: [278.99, 217.04, 229.05, 169.29],
    98: [302.13, 239.25, 258.12, 204.0],
    99: [327.96, 264.42, 307.44, 247.88],
    100: [342.2, 272.28, 323.79, 257.07],
    101: [357.06, 280.4, 341.04, 266.61],
    102: [372.57, 288.74, 359.18, 276.48],
    103: [388.76, 297.33, 378.29, 286.74],
    104: [405.63, 306.17, 398.43, 297.36],
    105: [427.98, 323.04, 420.69, 314.75],
    106: [450.12, 339.74, 442.73, 331.95],
    107: [472.05, 356.3, 464.57, 349.01],
    108: [493.82, 372.72, 486.23, 365.91],
    109: [515.42, 389.01, 507.74, 382.7],
    110: [536.88, 405.21, 529.11, 399.38],
    111: [559.25, 422.09, 551.39, 416.78],
    112: [582.53, 439.67, 574.59, 434.96],
    113: [606.8, 457.97, 598.79, 453.9],
    114: [632.06, 477.05, 624.0, 473.69],
    115: [658.38, 496.91, 650.27, 494.34],
    116: [685.8, 517.61, 677.64, 515.88],
    117: [714.36, 539.16, 706.17, 538.37],
    118: [744.12, 561.62, 735.9, 561.83],
    119: [775.1, 585.0, 766.88, 586.32],
    120: [807.38, 609.36, 799.16, 611.88],
};

/* ============================================================
   PRODUCT RULES (from the product information packs)
   ============================================================ */

// Surrender charge, % of Growth + Flex Account value, by policy year
const SC_5 = [1, 1, 0.6, 0.5, 0.4, 0.3, 0.2, 0.1];
const SC_10 = [1, 1, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2, 0.1];
const SC_15 = [1, 1, 0.8, 0.7, 0.6, 0.5, 0.45, 0.4, 0.35, 0.3, 0.25, 0.2, 0.15, 0.1, 0.05];
const SC_20 = [1, 1, 0.8, 0.7, 0.6, 0.5, 0.45, 0.45, 0.4, 0.4, 0.35, 0.3, 0.25, 0.2, 0.12, 0.1, 0.08, 0.08, 0.05, 0.05];
const SC_25 = [1, 1, 0.8, 0.75, 0.7, 0.65, 0.6, 0.55, 0.5, 0.45, 0.4, 0.35, 0.3, 0.25, 0.2, 0.18, 0.18, 0.15, 0.15, 0.1, 0.1, 0.08, 0.08, 0.05, 0.05];

const PLANS = {
    PVA: {
        key: "PVA",
        name: "PRUVantage Assure II",
        sheetMatch: /assure/i,
        packDate: "8 Jul 2024",
        terms: [5, 10, 15, 20, 25],
        premium: { 5: [10000, 3000000], 10: [5000, 1500000], 15: [3600, 1000000], 20: [2400, 750000], 25: [1800, 600000] },
        maxAge: { 5: 75, 10: 70, 15: 65, 20: 60, 25: 55 },
        admin: { 5: [0.033, 8], 10: [0.029, 10], 15: [0.029, 10], 20: [0.026, 12], 25: [0.026, 12] },
        // Welcome Bonus: [min annualised premium, [yr1, yr2, yr3]] — highest band that the premium reaches
        welcome: {
            growth: {
                5: [[0, [0.01, 0.02, 0.02]], [30000, [0.02, 0.03, 0.03]]],
                10: [[0, [0.05, 0.06, 0.09]], [12000, [0.08, 0.12, 0.15]]],
                15: [[3600, [0.10, 0.15, 0.20]]],
                20: [[2400, [0.12, 0.18, 0.25]]],
                25: [[1800, [0.15, 0.20, 0.30]]]
            },
            flex: {
                5: [[0, [0.01, 0.01, 0]], [30000, [0.01, 0.01, 0.01]]],
                10: [[0, [0.01, 0.02, 0.02]], [12000, [0.02, 0.03, 0.05]]],
                15: [[3600, [0.04, 0.06, 0.10]]],
                20: [[2400, [0.06, 0.09, 0.15]]],
                25: [[1800, [0.08, 0.12, 0.20]]]
            }
        },
        loyaltyFrom: term => term + 1,       // every year after the premium term
        growthAllowed: () => true,
        flexDividendOnly: () => true,
        surrender: { 5: SC_5, 10: SC_10, 15: SC_15, 20: SC_20, 25: SC_25 },
        hasSumAssured: true
    },
    PVW: {
        key: "PVW",
        name: "PRUVantage Wealth III (SGD)",
        sheetMatch: /wealth/i,
        packDate: "3 Jun 2026",
        terms: [3, 5, 10, 15, 20],
        premium: { 3: [60000, 5000000], 5: [36000, 3000000], 10: [24000, 1500000], 15: [18000, 1000000], 20: [15000, 750000] },
        maxAge: { 3: 77, 5: 75, 10: 70, 15: 65, 20: 60 },
        admin: { 3: [0.029, 8], 5: [0.029, 8], 10: [0.027, 10], 15: [0.027, 10], 20: [0.025, 12] },
        welcome: {
            growth: {
                10: [[24000, [0.18, 0.16, 0.16]]],
                15: [[18000, [0.23, 0.21, 0.21]]],
                20: [[15000, [0.25, 0.25, 0.25]]]
            },
            flex: {
                3: [[60000, [0.01, 0, 0]], [100000, [0.03, 0, 0]]],
                5: [[36000, [0.05, 0, 0]]],
                10: [[24000, [0.08, 0.03, 0.02]]],
                15: [[18000, [0.12, 0.06, 0.05]]],
                20: [[15000, [0.15, 0.09, 0.08]]]
            }
        },
        loyaltyFrom: term => ({ 3: 6, 5: 6, 10: 11, 15: 16, 20: 21 }[term]),
        growthAllowed: term => term >= 10,
        flexDividendOnly: term => term >= 10,
        surrender: { 3: SC_5, 5: SC_5, 10: SC_10, 15: SC_15, 20: SC_20 },
        hasSumAssured: false
    }
};


const calc = {
    initialized: false,
    funds: [],
    fundByCode: new Map(),
    allowed: { PVA: [], PVW: [] },       // fund codes allowed per plan (yellow cells)
    unmatched: { PVA: [], PVW: [] },
    listStatus: "loading",                // loading | ok | error
    listError: "",
    listSource: "xlsx",                   // xlsx | fallback
    promo: null,
    promoStatus: "loading",               // loading | ok | none | error
    plan: "PVA",
    accounts: { growth: [], flex: [] },   // [{ code, weight }]
    timer: null
};


/* ============================================================
   HELPERS
   ============================================================ */

const qs = (selector, root = document) => root.querySelector(selector);

function escapeHtml(value) {
    return String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}

function money(value) {
    if (value === null || value === undefined || !Number.isFinite(value)) return "—";

    const sign = value < 0 ? "−" : "";

    return `${sign}S$${Math.abs(Math.round(value)).toLocaleString("en-SG")}`;
}

/* Money with cents when the amount isn't a whole dollar (premium limits) */
function moneyExact(value) {
    if (!Number.isFinite(value)) return "—";

    const cents = Math.abs(value - Math.round(value)) > 0.004;

    return `S$${value.toLocaleString("en-SG", { minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: cents ? 2 : 0 })}`;
}

function pct(value, digits = 2) {
    const text = (value * 100).toFixed(digits);

    // trim trailing zeros after the decimal point only (4.50 -> 4.5, 100 stays 100)
    return `${digits > 0 ? text.replace(/\.?0+$/, "") : text}%`;
}

function formatDate(iso) {
    if (!iso) return "—";

    const [y, m, d] = iso.split("-").map(Number);
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

    return `${String(d).padStart(2, "0")} ${months[m - 1]} ${y}`;
}

function todayIso() {
    const now = new Date();
    const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000);

    return local.toISOString().slice(0, 10);
}

function band(table, premium) {
    if (!Array.isArray(table)) return null;

    let found = null;

    for (const [min, rates] of table) {
        if (premium >= min) found = rates;
    }

    return found;
}

function fundName(code) {
    return calc.fundByCode.get(code)?.fundName ?? code;
}

function paysDividend(code) {
    const details = calc.fundByCode.get(code)?.fund ?? {};

    return details.hasDividend === true || String(details.hasDividend).toLowerCase() === "true";
}

/* Current BID price published by Prudential (data/funds.json) */
function bidPrice(code) {
    const details = calc.fundByCode.get(code)?.fund ?? {};
    const value = Number(String(details.bidPrice ?? "").replace(/[^0-9.\-]/g, ""));

    return Number.isFinite(value) && String(details.bidPrice ?? "").trim() ? value : null;
}

function bidDate(code) {
    return String(calc.fundByCode.get(code)?.fund?.valuationDate ?? "").trim();
}


/* ============================================================
   READ "PVA PVW Funds List.xlsx" IN THE BROWSER
   An .xlsx file is a zip of XML files. Unzip with the browser's
   own DecompressionStream, then read each sheet's column A and
   keep the cells whose fill is yellow.
   ============================================================ */

async function inflateRaw(bytes) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));

    return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function readZip(buffer) {
    const view = new DataView(buffer);
    const bytes = new Uint8Array(buffer);
    const files = new Map();

    let eocd = -1;

    for (let i = buffer.byteLength - 22; i >= Math.max(0, buffer.byteLength - 65557); i -= 1) {
        if (view.getUint32(i, true) === 0x06054b50) {
            eocd = i;
            break;
        }
    }

    if (eocd < 0) throw new Error("Not a valid .xlsx file");

    const count = view.getUint16(eocd + 10, true);
    let offset = view.getUint32(eocd + 16, true);
    const decoder = new TextDecoder();

    for (let n = 0; n < count; n += 1) {
        if (view.getUint32(offset, true) !== 0x02014b50) break;

        const method = view.getUint16(offset + 10, true);
        const size = view.getUint32(offset + 20, true);
        const nameLength = view.getUint16(offset + 28, true);
        const extraLength = view.getUint16(offset + 30, true);
        const commentLength = view.getUint16(offset + 32, true);
        const local = view.getUint32(offset + 42, true);
        const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength));

        const localName = view.getUint16(local + 26, true);
        const localExtra = view.getUint16(local + 28, true);
        const start = local + 30 + localName + localExtra;

        files.set(name, { method, data: bytes.subarray(start, start + size) });

        offset += 46 + nameLength + extraLength + commentLength;
    }

    return {
        async text(name) {
            const entry = files.get(name);

            if (!entry) return null;

            const raw = entry.method === 8 ? await inflateRaw(entry.data) : entry.data;

            return decoder.decode(raw);
        }
    };
}

function xml(text) {
    return new DOMParser().parseFromString(text, "application/xml");
}

function byTag(node, tag) {
    return [...node.getElementsByTagName(tag)];
}

function isYellow(fill) {
    const pattern = fill ? byTag(fill, "patternFill")[0] : null;

    if (!pattern || (pattern.getAttribute("patternType") ?? "") === "none") return false;

    const color = byTag(pattern, "fgColor")[0];

    if (!color) return false;

    const rgb = (color.getAttribute("rgb") ?? "").toUpperCase();

    return rgb.endsWith("FFFF00") || color.getAttribute("indexed") === "13";
}

async function readAllowedFunds() {
    const response = await fetch(encodeURI(FUNDS_LIST_URL), { cache: "no-cache" });

    if (!response.ok) throw new Error(`"${FUNDS_LIST_URL}" not found (${response.status})`);

    const zip = await readZip(await response.arrayBuffer());

    const strings = byTag(xml(await zip.text("xl/sharedStrings.xml") ?? "<sst/>"), "si")
        .map(si => byTag(si, "t").map(t => t.textContent).join(""));

    const styles = xml(await zip.text("xl/styles.xml") ?? "<styleSheet/>");
    const fills = byTag(byTag(styles, "fills")[0] ?? styles, "fill");
    const xfs = byTag(byTag(styles, "cellXfs")[0] ?? styles, "xf");
    const yellowStyle = xfs.map(xf => isYellow(fills[Number(xf.getAttribute("fillId") ?? 0)]));

    const workbook = xml(await zip.text("xl/workbook.xml"));
    const rels = xml(await zip.text("xl/_rels/workbook.xml.rels"));
    const target = new Map(byTag(rels, "Relationship").map(r => [r.getAttribute("Id"), r.getAttribute("Target")]));

    const sheets = [];

    for (const sheet of byTag(workbook, "sheet")) {
        const id = sheet.getAttribute("r:id") ?? sheet.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id");
        let path = target.get(id) ?? "";

        path = path.startsWith("/") ? path.slice(1) : `xl/${path}`;

        const doc = xml(await zip.text(path) ?? "<worksheet/>");
        const names = [];

        for (const cell of byTag(doc, "c")) {
            const ref = cell.getAttribute("r") ?? "";

            if (!/^A\d+$/.test(ref) || ref === "A1") continue;

            const type = cell.getAttribute("t");
            const raw = type === "inlineStr"
                ? byTag(cell, "t").map(t => t.textContent).join("")
                : byTag(cell, "v")[0]?.textContent ?? "";
            const value = type === "s" ? strings[Number(raw)] : raw;

            if (value && yellowStyle[Number(cell.getAttribute("s") ?? 0)]) names.push(value.trim());
        }

        sheets.push({ name: sheet.getAttribute("name") ?? "", names });
    }

    return sheets;
}

function normaliseName(name) {
    return String(name ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

function applyFundList(sheets) {
    const byAccessName = new Map(calc.funds.map(fund => [normaliseName(fund.pruAccessName), fund]));

    for (const plan of Object.values(PLANS)) {
        const sheet = sheets.find(item => plan.sheetMatch.test(item.name));
        const codes = [];
        const unmatched = [];

        for (const name of sheet?.names ?? []) {
            const fund = byAccessName.get(normaliseName(name));

            // SGD plans: USD share classes are never allowed
            if (fund && String(fund.fund?.unitCurrency ?? "SGD").toUpperCase() === "SGD") codes.push(fund.fundCode);
            else if (!fund) unmatched.push(name);
        }

        calc.allowed[plan.key] = [...new Set(codes)].sort((a, b) => fundName(a).localeCompare(fundName(b)));
        calc.unmatched[plan.key] = unmatched;
    }
}


/* ============================================================
   PROMOTION ("Promotion Reference for PVA PVW/promotion.json")
   ============================================================ */

async function loadPromotion() {
    try {
        const response = await fetch(encodeURI(PROMO_URL), { cache: "no-cache" });

        if (!response.ok) {
            calc.promo = null;
            calc.promoStatus = "none";
            return;
        }

        calc.promo = await response.json();
        calc.promoStatus = "ok";
    } catch {
        calc.promo = null;
        calc.promoStatus = "none";
    }
}

/* Promotion bonus rate for the inputs, or a reason why none applies */
function promotionFor(input, shares) {
    if (calc.promoStatus !== "ok" || !calc.promo) {
        return { applies: false, reason: "No promotion file in the “Promotion Reference for PVA PVW” folder, so no promotion units are included." };
    }

    const promo = calc.promo;
    const start = promo.period?.start ?? "";
    const end = promo.period?.end ?? "";
    const name = promo.name ?? "Promotion";

    if (!input.startDate || (start && input.startDate < start) || (end && input.startDate > end)) {
        return { applies: false, reason: `${name} runs ${formatDate(start)} – ${formatDate(end)}. The policy start date (${formatDate(input.startDate)}) is outside it, so no promotion units are included.` };
    }

    const tiers = promo.plans?.[input.plan]?.terms?.[String(input.term)];

    if (!Array.isArray(tiers) || !tiers.length) {
        return { applies: false, reason: `${name} has no promotion units for a ${input.term}-year premium term.` };
    }

    const tier = [...tiers].sort((a, b) => a.minAnnualPremium - b.minAnnualPremium)
        .filter(item => input.premium >= item.minAnnualPremium)
        .pop();

    if (!tier) {
        const lowest = Math.min(...tiers.map(item => item.minAnnualPremium));

        return { applies: false, reason: `${name}: the ${input.term}-year term needs an annualised premium of at least ${money(lowest)} for promotion units.` };
    }

    const groups = promo.fundGroups ?? {};
    const cioCodes = groups.cioFunds?.codes ?? [];
    const siiCodes = groups.strategicInvestIncome?.codes ?? [];

    const cioShare = shares.filter(item => cioCodes.includes(item.code)).reduce((sum, item) => sum + item.share, 0);
    const siiShare = shares.filter(item => siiCodes.includes(item.code)).reduce((sum, item) => sum + item.share, 0);

    const rate = (tier.cioFunds / 100) * cioShare + (tier.strategicInvestIncome / 100) * siiShare;

    if (rate <= 0) {
        return {
            applies: false,
            reason: `${name}: promotion units are only given on premium invested in the ${groups.cioFunds?.label ?? "PRUPrime CIO Funds"} (${pct(tier.cioFunds / 100)}) or the ${groups.strategicInvestIncome?.label ?? "PRULink StrategicInvest Income Fund"} (${pct(tier.strategicInvestIncome / 100)}). None of the chosen funds qualify.`,
            tier
        };
    }

    return {
        applies: true,
        name,
        tier,
        rate,
        cioShare,
        siiShare,
        amount: input.premium * rate,
        period: { start, end },
        labels: { cio: groups.cioFunds?.label ?? "PRUPrime CIO Funds", sii: groups.strategicInvestIncome?.label ?? "PRULink StrategicInvest Income Fund" }
    };
}


/* ============================================================
   PROJECTION ENGINE
   Monthly steps, one "sleeve" per chosen fund in each account so that
   dividends can follow each fund's own rate and the account's option.
   Premiums are paid at the start of each payment period.
   Order each month: premium + bonuses -> Wealth Assure Value ->
   admin charge -> assurance charge (PVA) -> account value growth ->
   dividends (on payout months) -> Loyalty Bonus (end of eligible years).
   Charges and the Loyalty Bonus are spread over the sleeves in
   proportion to their value, the same as cancelling / adding units.

   Dividends (product information packs):
   - Growth Account: reinvested automatically for the first 10 policy
     years; paying them out is only allowed after 10 years from the
     cover start date (with 10 years, or 5 for a 5-year term, of
     premiums paid).
   - Flex Account: reinvested or paid out, with no restriction.
   The BID price is kept at today's price throughout: premiums, bonuses
   and reinvested dividends buy units at that price, and each dividend
   is units held × the dividend per unit. The expected return grows
   the account value only. A reinvested dividend buys more units; a
   paid-out dividend leaves the policy as cash.
   ============================================================ */

function project(input, grossReturn, promotion) {
    const plan = PLANS[input.plan];
    const [adminRate, adminYears] = plan.admin[input.term];
    const surrender = plan.surrender[input.term] ?? [];
    const loyaltyFrom = plan.loyaltyFrom(input.term);
    const bands = {
        growth: band(plan.welcome.growth[input.term], input.premium) ?? [0, 0, 0],
        flex: band(plan.welcome.flex[input.term], input.premium) ?? [0, 0, 0]
    };
    // Fund charges are already reflected in BID prices, so the return
    // entered is used as is (net of fund charges).
    const monthly = Math.pow(1 + grossReturn, 1 / 12) * (1 - (input.fundCharge ?? 0) / 12);
    const rateColumn = (input.sex === "F" ? 2 : 0) + (input.smoker ? 0 : 1);   // MS, MN, FS, FN
    const lifetimePremium = input.premium * input.term;
    const wavCap = Math.max(20000000, 3 * lifetimePremium);
    const perYear = input.frequency ?? 1;

    // One sleeve per fund per account. Without fund details (e.g. tests)
    // fall back to a single sleeve per account.
    const shares = input.shares?.length
        ? input.shares
        : [["growth", input.growthShare], ["flex", input.flexShare]].filter(([, share]) => share > 0).map(([account, share]) => ({ code: null, account, share }));

    const sleeves = shares.map(item => {
        const dividend = item.code ? dividendInfo(item.code) : null;

        return {
            ...item,
            value: 0,
            units: 0,                                   // units held (BID price kept at today's price)
            price: item.code ? bidPrice(item.code) : null,
            dividend,
            promoRate: item.code && promotion?.applies ? promotionRateFor(item.code, promotion.tier) : 0
        };
    });

    const total = () => sleeves.reduce((sum, sleeve) => sum + sleeve.value, 0);
    // Charges and the Loyalty Bonus cancel / add units in proportion
    const scale = factor => sleeves.forEach(sleeve => { sleeve.value *= factor; sleeve.units *= factor; });
    // Investment return grows the account value only; units stay the same
    const grow = factor => sleeves.forEach(sleeve => { sleeve.value *= factor; });
    const buy = (sleeve, amount) => {
        sleeve.value += amount;

        if (sleeve.price) sleeve.units += amount / sleeve.price;
    };
    const payingOut = (account, y) => account === "flex"
        ? input.dividends?.flex === "payout"
        : input.dividends?.growth === "payout" && y >= 11 && input.age + y - 1 >= (input.dividends.growthStartAge ?? input.age + 10);

    let wealthAssure = 0;
    let paid = 0;
    let dividendsPaidTotal = 0;
    let lapsed = false;

    const rows = [];
    let year = null;

    for (let m = 0; m < input.years * 12; m += 1) {
        const y = Math.floor(m / 12) + 1;
        const age = input.age + y - 1;

        if (m % 12 === 0) {
            year = { year: y, age, premium: 0, welcome: 0, promotion: 0, loyalty: 0, adminCharge: 0, assuranceCharge: 0, dividendsReinvested: 0, dividendsPaid: 0, payouts: 0, payoutFrequency: null };
        }

        // Regular premium paid at the start of each period (yearly,
        // half-yearly, quarterly or monthly); bonuses are given on each one
        if (m % (12 / perYear) === 0 && y <= input.term && !lapsed) {
            const regular = input.premium / perYear;

            for (const sleeve of sleeves) {
                const premium = regular * sleeve.share;
                const welcome = y <= 3 ? premium * (bands[sleeve.account][y - 1] ?? 0) : 0;
                const promo = y === 1 ? premium * sleeve.promoRate : 0;

                buy(sleeve, premium + welcome + promo);
                year.welcome += welcome;
                year.promotion += promo;
            }

            // Promotion given as a whole (no fund detail): spread with the premium
            if (y === 1 && promotion?.applies && !sleeves.some(sleeve => sleeve.promoRate > 0)) {
                const promo = promotion.amount / perYear;

                sleeves.forEach(sleeve => buy(sleeve, promo * sleeve.share));
                year.promotion += promo;
            }

            paid += regular;
            year.premium += regular;
        }

        const sumAssured = plan.hasSumAssured ? Math.min(1.03 + 0.03 * (y - 1), 1.60) * paid : null;

        if (!lapsed) {
            let account = total();

            if (plan.hasSumAssured) wealthAssure = Math.min(wavCap, Math.max(wealthAssure, account));

            if (y <= adminYears && account > 0) {
                const charge = account * adminRate / 12;

                scale(1 - adminRate / 12);
                year.adminCharge += charge;
                account -= charge;
            }

            if (plan.hasSumAssured && account > 0) {
                const rate = (ASSURANCE_RATES[Math.min(age, 120)] ?? ASSURANCE_RATES[120])[rateColumn];
                const atRisk = Math.max(sumAssured, wealthAssure, account) - account;
                const charge = Math.min(account, rate / 1000 * atRisk * MONTHLY_MODAL_FACTOR);

                scale(1 - charge / account);
                year.assuranceCharge += charge;
            }

            grow(monthly);

            // Dividends at the end of each payout month
            let paidThisMonth = false;

            for (const sleeve of sleeves) {
                const info = sleeve.dividend;

                if (!info || (m + 1) % info.everyMonths !== 0) continue;

                // Dividend = units held × dividend per unit (at the static BID price)
                const amount = sleeve.units * info.perUnit;

                if (payingOut(sleeve.account, y)) {
                    year.dividendsPaid += amount;
                    dividendsPaidTotal += amount;
                    paidThisMonth = true;
                    year.payoutFrequency = year.payoutFrequency && year.payoutFrequency !== info.frequencyLabel ? "mixed" : info.frequencyLabel;
                } else {
                    buy(sleeve, amount);
                    year.dividendsReinvested += amount;
                }
            }

            if (paidThisMonth) year.payouts += 1;

            if (m % 12 === 11 && y >= loyaltyFrom) {
                const bonus = total() * 0.005;

                scale(1.005);
                year.loyalty = bonus;
            }

            account = total();

            if (plan.hasSumAssured) wealthAssure = Math.min(wavCap, Math.max(wealthAssure, account));

            if (account <= 0) {
                scale(0);
                lapsed = true;
            }
        }

        if (m % 12 === 11) {
            const account = total();
            // PVW guarantee: 101% (105% accidental) of premiums paid less dividend payments
            const guaranteedBase = Math.max(0, paid - dividendsPaidTotal);
            const deathBenefit = lapsed
                ? 0
                : plan.hasSumAssured
                    ? Math.max(sumAssured, wealthAssure, account)
                    : Math.max(1.01 * guaranteedBase, account);

            rows.push({
                ...year,
                paid,
                dividendsPaidTotal,
                guaranteedDeath: plan.hasSumAssured ? null : 1.01 * guaranteedBase,
                sumAssured,
                wealthAssure: plan.hasSumAssured ? wealthAssure : null,
                account,
                surrenderValue: account * (1 - (surrender[y - 1] ?? 0)),
                deathBenefit,
                accidentalDeath: plan.hasSumAssured || lapsed ? null : Math.max(1.05 * guaranteedBase, account),
                lapsed
            });
        }
    }

    return rows;
}

/* Promotion rate for one fund under a promotion tier */
function promotionRateFor(code, tier) {
    const groups = calc.promo?.fundGroups ?? {};

    if ((groups.cioFunds?.codes ?? []).includes(code)) return (tier?.cioFunds ?? 0) / 100;
    if ((groups.strategicInvestIncome?.codes ?? []).includes(code)) return (tier?.strategicInvestIncome ?? 0) / 100;

    return 0;
}

/* Latest declared dividend of a fund, as a yield on the current BID
   price, with the payout frequency from the gaps between ex-dates. */
function dividendInfo(code) {
    const details = calc.fundByCode.get(code)?.fund ?? {};

    if (!paysDividend(code)) return null;

    const history = (Array.isArray(details.dividendHistory) ? details.dividendHistory : [])
        .filter(item => /^\d{4}-\d{2}-\d{2}$/.test(String(item?.exDate ?? "")) && Number(item.rate) > 0)
        .sort((a, b) => b.exDate.localeCompare(a.exDate));

    const price = bidPrice(code);
    const unit = String(details.dividendUnit ?? "").trim().toLowerCase();

    if (!history.length || !price) return null;

    const latest = history[0];
    const perUnit = unit.startsWith("%") ? price * Number(latest.rate) / 100
        : unit.includes("cent") ? Number(latest.rate) / 100
        : null;

    if (!perUnit) return null;

    // Payout frequency from the median gap between recent ex-dates
    let perYear = 12;

    if (history.length >= 2) {
        const recent = history.slice(0, 7).map(item => Date.parse(item.exDate));
        const gaps = recent.slice(1).map((time, i) => (recent[i] - time) / 86400000).sort((a, b) => a - b);
        const median = gaps[Math.floor(gaps.length / 2)];

        perYear = median <= 45 ? 12 : median <= 120 ? 4 : median <= 220 ? 2 : 1;
    }

    const yieldPerPayout = perUnit / price;

    return {
        latest,
        unitLabel: unit.startsWith("%") ? "%" : "cents",
        perUnit,
        perYear,
        everyMonths: 12 / perYear,
        yieldPerPayout,
        yieldPerYear: yieldPerPayout * perYear,
        frequencyLabel: { 12: "monthly", 4: "quarterly", 2: "half-yearly", 1: "yearly" }[perYear]
    };
}


/* ============================================================
   INPUTS
   ============================================================ */

function readInput() {
    const plan = calc.plan;
    const term = Number(qs("#calc-term")?.value) || PLANS[plan].terms[0];
    const growthAllowed = PLANS[plan].growthAllowed(term);
    const growthPct = growthAllowed ? Number(qs("#calc-growth")?.value) || 0 : 0;
    const frequency = FREQUENCIES[qs("#calc-frequency")?.value] ? Number(qs("#calc-frequency").value) : 1;
    const regular = Number(qs("#calc-premium")?.value) || 0;
    const returnText = qs("#calc-return")?.value.trim() ?? "";
    const returns = returnText === "" ? [] : [Number(returnText)];
    const yearsChoice = qs("#calc-years")?.value ?? "30";
    const dob = qs("#calc-dob")?.value ?? "";
    const startDate = qs("#calc-start")?.value || todayIso();
    const age = ageNextBirthday(dob, startDate);

    const growthShare = growthPct / 100;
    const flexShare = 1 - growthShare;

    // Overall share of each fund in the premium (both accounts)
    const shares = [];

    for (const [account, share] of [["growth", growthShare], ["flex", flexShare]]) {
        if (share <= 0) continue;

        for (const item of calc.accounts[account]) {
            shares.push({ code: item.code, account, share: share * (Number(item.weight) || 0) / 100 });
        }
    }


    return {
        plan,
        term,
        regular,
        frequency,
        premium: regular * frequency,          // annualised premium
        age,
        sex: qs("#calc-sex")?.value === "F" ? "F" : "M",
        smoker: qs("#calc-smoker")?.value === "Y",
        startDate,
        dob,
        growthPct,
        growthShare,
        flexShare,
        shares,
        fundCharge: 0,
        dividends: {
            growth: qs("#calc-div-growth")?.value === "payout" ? "payout" : "reinvest",
            growthStartAge: qs("#calc-div-age")?.value.trim() ? Number(qs("#calc-div-age").value) : null,
            flex: qs("#calc-div-flex")?.value === "payout" ? "payout" : "reinvest"
        },
        returns,
        years: yearsChoice === "age100" ? Math.max(1, 100 - age + 1) : Number(yearsChoice) || 30
    };
}


function formatUnits(value) {
    if (value === null || !Number.isFinite(value)) return "—";

    return value.toLocaleString("en-SG", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/* Units each chosen fund buys with its premiums (a year, and each payment, before bonuses),
   at the fund's current BID price */
function fundUnits(input) {
    const list = [];

    for (const [account, share] of [["growth", input.growthShare], ["flex", input.flexShare]]) {
        if (share <= 0) continue;

        calc.accounts[account].forEach((item, index) => {
            const price = bidPrice(item.code);
            const amount = input.premium * share * (Number(item.weight) || 0) / 100;

            const perAmount = amount / (input.frequency ?? 1);

            list.push({ account, index, code: item.code, price, amount, units: price ? amount / price : null, perAmount, perUnits: price ? perAmount / price : null });
        });
    }

    return list;
}

/* Payments a year -> label */
const FREQUENCIES = { 1: "yearly", 2: "half-yearly", 4: "quarterly", 12: "monthly" };
const FREQUENCY_UNIT = { 1: "a year", 2: "a half-year", 4: "a quarter", 12: "a month" };

function frequencyOf() {
    const value = Number(qs("#calc-frequency")?.value);

    return FREQUENCIES[value] ? value : 1;
}

/* Age next birthday on the policy start date, from the date of birth */
function ageNextBirthday(dob, onDate) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dob ?? "") || !/^\d{4}-\d{2}-\d{2}$/.test(onDate ?? "")) return null;

    const [by, bm, bd] = dob.split("-").map(Number);
    const [sy, sm, sd] = onDate.split("-").map(Number);
    let last = sy - by;

    if (sm < bm || (sm === bm && sd < bd)) last -= 1;

    return last < 0 ? null : last + 1;
}

function accountTotal(account) {
    return calc.accounts[account].reduce((sum, item) => sum + (Number(item.weight) || 0), 0);
}

function validate(input) {
    const plan = PLANS[input.plan];
    const problems = [];
    const [minP, maxP] = plan.premium[input.term];

    if (calc.listStatus === "error") problems.push(`The allowed fund list couldn't be read: ${calc.listError}`);

    if (!input.dob) {
        problems.push("Enter the life assured's date of birth.");
    } else if (input.dob > todayIso() || input.age === null) {
        problems.push("The date of birth can't be in the future or after the policy start date.");
    } else if (input.age < 1 || input.age > plan.maxAge[input.term]) {
        problems.push(`Age next birthday is ${input.age}. It must be 1 to ${plan.maxAge[input.term]} for a ${input.term}-year premium term.`);
    }

    if (!input.premium) problems.push("Enter the regular premium.");

    else if (!(input.premium >= minP && input.premium <= maxP)) {
        problems.push(`The ${FREQUENCIES[input.frequency]} premium for a ${input.term}-year term must be ${moneyExact(minP / input.frequency)} to ${moneyExact(maxP / input.frequency)} (annualised ${money(minP)} to ${money(maxP)}).`);
    }

    if (input.growthPct % ALLOCATION_STEP !== 0 || input.growthPct < 0 || input.growthPct > 100) {
        problems.push("The Growth / Flex Account split must be in steps of 5%.");
    }

    for (const [account, share, label] of [["growth", input.growthShare, "Growth Account"], ["flex", input.flexShare, "Flex Account"]]) {
        if (share <= 0) continue;

        const items = calc.accounts[account];
        const total = accountTotal(account);

        if (!items.length) problems.push(`Add at least one fund to the ${label}.`);
        else if (Math.abs(total - 100) > 0.001) problems.push(`${label} funds add up to ${total}%. They need to total 100%.`);

        if (items.some(item => !(Number(item.weight) > 0) || Number(item.weight) % ALLOCATION_STEP !== 0)) {
            problems.push(`${label} fund allocations must be at least 5%, in steps of 5%.`);
        }

        const allowed = allowedFor(account, input);

        for (const item of items) {
            if (!allowed.includes(item.code)) problems.push(`${fundName(item.code)} isn't allowed in the ${label} for this plan / term.`);
        }
    }

    if (input.dividends?.growth === "payout" && growthHasDividends(input) && Number.isInteger(input.age)) {
        const earliest = earliestPayoutAge(input);
        const chosen = input.dividends.growthStartAge;

        if (chosen === null) problems.push("Enter the age when Growth Account dividend payouts start.");
        else if (!Number.isInteger(chosen) || chosen < earliest) {
            problems.push(`Growth Account dividends can be paid out only from age ${earliest} (policy year 11, 10 years after the cover start date).`);
        }
    }

    if (!input.returns.length) problems.push("Enter the expected return rate.");
    else if (input.returns.some(value => !Number.isFinite(value) || value < -20 || value > 30)) {
        problems.push("The expected return rate must be between −20% and 30% a year.");
    }

    return problems;
}

/* Funds that may go into an account for the current plan / term */
function allowedFor(account, input = { plan: calc.plan, term: Number(qs("#calc-term")?.value) }) {
    const plan = PLANS[input.plan];
    const list = calc.allowed[input.plan] ?? [];

    if (account === "growth") return plan.growthAllowed(input.term) ? list : [];

    return plan.flexDividendOnly(input.term) ? list.filter(paysDividend) : list;
}


/* ============================================================
   SETUP FORM
   ============================================================ */

function renderPlanChoice() {
    document.querySelectorAll("[data-calc-plan]").forEach(button => {
        const active = button.dataset.calcPlan === calc.plan;

        button.classList.toggle("active", active);
        button.setAttribute("aria-checked", String(active));
    });

    const plan = PLANS[calc.plan];
    const termSelect = qs("#calc-term");
    const current = Number(termSelect?.value);

    if (termSelect) {
        termSelect.innerHTML = plan.terms
            .map(term => `<option value="${term}">${term} years</option>`)
            .join("");
        termSelect.value = String(plan.terms.includes(current) ? current : plan.terms.includes(10) ? 10 : plan.terms[0]);
        termSelect.dispatchEvent(new Event("vselect:sync"));
    }

    // Smoker / sex only matter for PVA assurance charges
    qs("#calc-pva-only")?.toggleAttribute("hidden", !plan.hasSumAssured);

    renderTermRules();
}

function renderTermRules() {
    const input = { plan: calc.plan, term: Number(qs("#calc-term")?.value) };
    const plan = PLANS[input.plan];
    const [minP, maxP] = plan.premium[input.term];
    const growthAllowed = plan.growthAllowed(input.term);
    const growth = qs("#calc-growth");

    // Limits for the chosen plan and premium term, shown under the boxes
    const ageLimits = qs("#calc-age-limits");

    if (ageLimits) ageLimits.dataset.maxAge = String(plan.maxAge[input.term]);

    updateLimitWarnings();

    if (growth) {
        // Growth Account is the primary account; when the term has no
        // Growth Account (PVW 3 / 5 years) it is locked at 0%.
        if (!growthAllowed) {
            growth.value = "0";
        } else if (growth.disabled) {
            growth.value = "100";
        }

        growth.disabled = !growthAllowed;
        growth.closest(".vselect")?.querySelector(".vselect-button")?.toggleAttribute("disabled", !growthAllowed);
        growth.dispatchEvent(new Event("vselect:sync"));
        calc.lastGrowth = Number(growth.value);
    }

    const split = qs("#calc-split-note");

    if (split) {
        split.textContent = growthAllowed
            ? "Growth Account: any allowed fund. Flex Account: dividend-paying funds only. Split in steps of 5%, fixed for the premium term."
            : "3- and 5-year terms: 100% of premiums go into the Flex Account, which can hold any allowed fund.";
    }

    // Drop funds that are no longer allowed in an account
    for (const account of ["growth", "flex"]) {
        const allowed = allowedFor(account, input);

        calc.accounts[account] = calc.accounts[account].filter(item => allowed.includes(item.code));
    }

    renderAccounts();
}

/* Turn the limit notes red when the value is outside them */
function updateLimitWarnings() {
    const plan = PLANS[calc.plan];
    const term = Number(qs("#calc-term")?.value);
    const [minP, maxP] = plan.premium[term] ?? [0, Infinity];
    const frequency = frequencyOf();
    const regular = Number(qs("#calc-premium")?.value);
    const premium = regular * frequency;
    const premiumLimits = qs("#calc-premium-limits");
    const premiumInput = qs("#calc-premium");
    const dob = qs("#calc-dob")?.value ?? "";
    const age = ageNextBirthday(dob, qs("#calc-start")?.value || todayIso());
    const maxAge = plan.maxAge[term];
    const ageLimits = qs("#calc-age-limits");

    // Limits are set on the annualised premium; show them per payment
    if (premiumLimits) {
        premiumLimits.textContent = `Min ${moneyExact(minP / frequency)} · Max ${moneyExact(maxP / frequency)} ${FREQUENCY_UNIT[frequency]}`
            + (frequency > 1 && regular > 0 ? ` · Annualised ${money(premium)}` : "");
        premiumLimits.classList.toggle("is-off", !(premium >= minP && premium <= maxP));
    }

    if (premiumInput) {
        premiumInput.min = String(minP / frequency);
        premiumInput.max = String(maxP / frequency);
    }

    if (ageLimits) {
        ageLimits.textContent = age
            ? `Age next birthday: ${age} · Entry age 1 – ${maxAge}`
            : `Entry age 1 – ${maxAge} (age next birthday)`;
        ageLimits.classList.toggle("is-off", Boolean(dob) && !(age >= 1 && age <= maxAge));
    }
}

function accountMarkup(account, share) {
    const label = account === "growth" ? "Growth Account" : "Flex Account";
    const items = calc.accounts[account];
    const total = accountTotal(account);
    const allowedCount = allowedFor(account).length;

    return `
        <div class="calc-account" data-calc-account="${account}">
            <div class="calc-account-head">
                <strong>${label} · ${Math.round(share * 100)}%</strong>
                <span class="settings-help">${allowedCount} allowed fund${allowedCount === 1 ? "" : "s"}${account === "flex" && PLANS[calc.plan].flexDividendOnly(Number(qs("#calc-term")?.value)) ? " (dividend-paying only)" : ""}</span>
            </div>

            <div class="report-picker-row">
                <div class="compare-picker report-picker">
                    <input type="search" autocomplete="off" placeholder="Add a fund to the ${label}…" aria-label="Search funds for the ${label}" data-calc-search="${account}">
                    <ul class="compare-suggestions" role="listbox" data-calc-suggestions="${account}" hidden></ul>
                </div>

                <button type="button" class="news-clear-filters" data-calc-split="${account}">Split equally</button>

                <span class="report-total ${items.length ? (Math.abs(total - 100) < 0.001 ? "is-ok" : "is-off") : ""}" data-calc-total="${account}">Total ${total}%</span>
            </div>

            <div class="table-wrap">
                <table class="data-table report-funds-table">
                    <thead>
                        <tr>
                            <th scope="col">Fund</th>
                            <th scope="col">BID price</th>
                            <th scope="col">Allocation</th>
                            <th scope="col" class="calc-units-head">Units bought<div class="calc-th-note">each premium, before bonuses</div></th>
                            <th scope="col"><span class="sr-only">Remove</span></th>
                        </tr>
                    </thead>
                    <tbody>
                        ${items.length ? items.map((item, index) => `
                            <tr>
                                <td>
                                    <div class="fund-name">${escapeHtml(fundName(item.code))}</div>
                                    <div class="fund-meta">${escapeHtml(item.code)}${dividendTag(item.code)}${promoTag(item.code)}</div>
                                </td>
                                <td class="calc-charge-cell">${bidPrice(item.code) === null ? "—" : `S$${bidPrice(item.code).toFixed(4)}`}${bidDate(item.code) ? `<div class="fund-meta">${escapeHtml(bidDate(item.code))}</div>` : ""}</td>
                                <td class="report-weight-cell">
                                    <input type="number" min="5" max="100" step="5" value="${item.weight}" data-calc-weight="${account}:${index}" aria-label="Allocation % for ${escapeHtml(fundName(item.code))}">
                                    <span>%</span>
                                </td>
                                <td class="calc-units-cell" data-calc-units="${account}:${index}">—</td>
                                <td class="report-remove-cell">
                                    <button type="button" class="compare-remove" data-calc-remove="${account}:${index}" aria-label="Remove ${escapeHtml(fundName(item.code))}" title="Remove">×</button>
                                </td>
                            </tr>
                        `).join("") : `<tr><td colspan="5" class="report-empty">Add funds above.</td></tr>`}
                    </tbody>
                </table>
            </div>
        </div>
    `;
}

/* "Dividend 0.51 cents · Monthly (≈6.43% a year)" */
function dividendText(code) {
    if (!paysDividend(code)) return "";

    const info = dividendInfo(code);

    if (!info) return "Pays dividends";

    const rate = info.unitLabel === "%" ? `${info.latest.rate}%` : `${info.latest.rate} cents per unit`;
    const frequency = info.frequencyLabel.charAt(0).toUpperCase() + info.frequencyLabel.slice(1);

    return `Dividend ${rate} · ${frequency} payout (≈${pct(info.yieldPerYear)} a year)`;
}

function dividendTag(code) {
    const text = dividendText(code);

    return text ? ` · ${text}` : "";
}

function promoTag(code) {
    const groups = calc.promo?.fundGroups;

    if (calc.promoStatus !== "ok" || !groups) return "";

    if ((groups.cioFunds?.codes ?? []).includes(code) || (groups.strategicInvestIncome?.codes ?? []).includes(code)) {
        return ` · <span class="calc-promo-tag">promotion fund</span>`;
    }

    return "";
}

function renderAccounts() {
    const box = qs("#calc-accounts");

    if (!box) return;

    const term = Number(qs("#calc-term")?.value);
    const growthAllowed = PLANS[calc.plan].growthAllowed(term);
    const growthPct = growthAllowed ? Number(qs("#calc-growth")?.value) || 0 : 0;
    const flexInput = qs("#calc-flex");

    if (flexInput) flexInput.value = `${100 - growthPct}%`;

    if (calc.listStatus === "loading") {
        box.innerHTML = `<p class="settings-help">Loading the allowed fund list…</p>`;
        return;
    }

    if (calc.listStatus === "error") {
        box.innerHTML = `<p class="report-error">Couldn't read “${escapeHtml(FUNDS_LIST_URL)}”: ${escapeHtml(calc.listError)}</p>`;
        return;
    }

    const parts = [];

    if (growthPct > 0) parts.push(accountMarkup("growth", growthPct / 100));
    if (growthPct < 100) parts.push(accountMarkup("flex", 1 - growthPct / 100));

    box.innerHTML = parts.join("");
}

function renderSuggestions(account) {
    const input = qs(`[data-calc-search="${account}"]`);
    const list = qs(`[data-calc-suggestions="${account}"]`);

    if (!input || !list) return;

    const query = input.value.trim().toLowerCase();
    const chosen = new Set(calc.accounts[account].map(item => item.code));

    const matches = allowedFor(account).filter(code => {
        if (chosen.has(code)) return false;
        if (!query) return true;

        return fundName(code).toLowerCase().includes(query) || code.toLowerCase().includes(query);
    });

    list.innerHTML = matches.length
        ? matches.map(code => `
            <li class="compare-suggestion" role="option" data-calc-add="${account}:${escapeHtml(code)}">
                <span class="compare-suggestion-name">${escapeHtml(fundName(code))}</span>
                <span class="compare-suggestion-code">${escapeHtml(code)}${bidPrice(code) === null ? "" : ` · BID ${bidPrice(code).toFixed(4)}`}</span>
                ${paysDividend(code) ? `<span class="calc-suggestion-dividend">${escapeHtml(dividendText(code))}</span>` : ""}
            </li>
        `).join("")
        : `<li class="compare-suggestion-empty">No more allowed funds</li>`;

    list.hidden = false;
    placeDropdown(list);
}

function splitEqually(account) {
    const items = calc.accounts[account];
    const n = items.length;

    if (!n) return;

    const steps = 100 / ALLOCATION_STEP;
    const base = Math.floor(steps / n);
    let remainder = steps - base * n;

    calc.accounts[account] = items.map(item => {
        const extra = remainder > 0 ? 1 : 0;

        remainder -= extra;

        return { ...item, weight: (base + extra) * ALLOCATION_STEP };
    });
}


/* ============================================================
   RESULTS
   ============================================================ */

/* Live status: promotion, Welcome Bonus, what's missing, Generate button.
   Any change hides projected values until Generate is clicked again. */
function render() {
    const input = readInput();
    const problems = [...new Set(validate(input))];
    const promoBox = qs("#calc-promo-status");
    const missing = qs("#calc-missing");
    const generate = qs("#calc-generate");

    const promotion = problems.length ? null : promotionFor(input, input.shares);

    if (promoBox) promoBox.innerHTML = promoStatusMarkup(input, promotion);

    const units = fundUnits(input);

    for (const item of units) {
        const cell = qs(`[data-calc-units="${item.account}:${item.index}"]`);

        if (cell) {
            cell.innerHTML = input.premium > 0 && item.units !== null
                ? `${formatUnits(item.perUnits)}<div class="fund-meta">${money(item.perAmount)}${input.frequency > 1 ? ` · ${input.frequency}× a year` : ""}</div>`
                : "—";
        }
    }

    renderWelcome(input, units);
    renderDividendOptions(input);

    if (missing) {
        missing.hidden = !problems.length;
        missing.innerHTML = problems.length
            ? `<strong>Before you generate:</strong><ul>${problems.map(text => `<li>${escapeHtml(text)}</li>`).join("")}</ul>`
            : "";
    }

    if (generate) generate.disabled = problems.length > 0;
}

/* Earliest age (next birthday) for Growth Account dividend payouts:
   the start of policy year 11 (10 years after the cover start date) */
function earliestPayoutAge(input) {
    return Number.isInteger(input.age) && input.age > 0 ? input.age + 10 : null;
}

function growthHasDividends(input) {
    return input.growthShare > 0 && input.shares.some(item => item.account === "growth" && item.share > 0 && paysDividend(item.code));
}

/* Dividend options, shown only for accounts holding dividend-paying funds */
function renderDividendOptions(input) {
    const hasDividends = account => input.shares.some(item => item.account === account && item.share > 0 && paysDividend(item.code));
    const growthOn = input.growthShare > 0 && hasDividends("growth");
    const flexOn = input.flexShare > 0 && hasDividends("flex");

    qs("#calc-div-growth-field")?.toggleAttribute("hidden", !growthOn);

    // Payout start age (Growth Account, paid out)
    const ageField = qs("#calc-div-age-field");
    const ageInput = qs("#calc-div-age");
    const ageNote = qs("#calc-div-age-note");
    const showAge = growthOn && input.dividends.growth === "payout";
    const earliest = earliestPayoutAge(input);

    ageField?.toggleAttribute("hidden", !showAge);

    if (showAge && ageInput) {
        if (ageNote) {
            const chosen = input.dividends.growthStartAge;

            ageNote.textContent = earliest
                ? `Earliest age: ${earliest} (policy year 11)`
                : "Enter the date of birth to see the earliest age";
            ageNote.classList.toggle("is-off", Boolean(earliest && chosen !== null && (!Number.isInteger(chosen) || chosen < earliest)));
        }
    }

    // Highlight the box while the age is below the earliest allowed
    if (ageInput) {
        const chosen = input.dividends.growthStartAge;

        // Empty or below the earliest age: highlighted, and Generate stays off
        ageInput.classList.toggle("calc-input-off", Boolean(showAge && earliest && (chosen === null || !Number.isInteger(chosen) || chosen < earliest)));
    }
    qs("#calc-div-flex-field")?.toggleAttribute("hidden", !flexOn);

    const note = qs("#calc-div-note");

    if (!note) return;

    const lines = [];

    if (growthOn) {
        lines.push(`Growth Account: dividends are reinvested automatically for the first 10 policy years. They can be paid out only after 10 years from the cover start date, once ${input.term === 5 ? "5" : "10"} years of premiums have been paid.`);
    }

    if (flexOn) lines.push("Flex Account: dividends can be reinvested or paid out, with no restriction.");

    note.hidden = !lines.length;
    note.innerHTML = lines.map(escapeHtml).join("<br>");
}

/* Welcome Bonus for the premium term and accounts chosen. The bonus is
   given as extra units: a % of the units the premium buys in each fund. */
function renderWelcome(input, units = fundUnits(input)) {
    const box = qs("#calc-welcome");

    if (!box) return;

    const plan = PLANS[input.plan];
    const [minP, maxP] = plan.premium[input.term] ?? [0, 0];

    if (!(input.premium >= minP && input.premium <= maxP)) {
        box.hidden = true;
        box.innerHTML = "";
        return;
    }

    // No values until the units are worked out: every account in use needs
    // its funds chosen, allocations totalling 100% and a BID price for each
    const unitsReady = [["growth", input.growthShare], ["flex", input.flexShare]]
        .filter(([, share]) => share > 0)
        .every(([account]) => {
            const items = calc.accounts[account];

            return items.length > 0
                && Math.abs(accountTotal(account) - 100) < 0.001
                && units.filter(item => item.account === account).every(item => item.units !== null && item.units > 0);
        });

    if (!unitsReady) {
        box.hidden = false;
        box.innerHTML = `<strong>Welcome Bonus</strong><p class="settings-help">Add funds to each account (allocations totalling 100%) to work out the units bought and the bonus units.</p>`;
        return;
    }

    const rows = [];

    for (const [account, share, label] of [["growth", input.growthShare, "Growth Account"], ["flex", input.flexShare, "Flex Account"]]) {
        if (share <= 0) continue;

        const rates = band(plan.welcome[account][input.term], input.premium);

        if (!rates || !rates.some(rate => rate > 0)) continue;

        const funds = units.filter(item => item.account === account && item.amount > 0);

        if (funds.length) {
            for (const fund of funds) {
                rows.push({
                    name: fundName(fund.code),
                    meta: `${fund.code} · ${label}`,
                    baseUnits: fund.perUnits,
                    base: fund.perAmount,
                    rates,
                    amounts: rates.map(rate => fund.amount * rate),
                    units: rates.map(rate => fund.units === null ? null : fund.units * rate)
                });
            }
        } else {
            const base = input.premium * share;

            rows.push({
                name: `${label} · ${Math.round(share * 100)}%`,
                meta: "add funds to see units",
                baseUnits: null,
                base: base / input.frequency,
                rates,
                amounts: rates.map(rate => base * rate),
                units: rates.map(() => null)
            });
        }
    }

    box.hidden = false;

    if (!rows.length) {
        box.innerHTML = `<strong>Welcome Bonus</strong><p class="settings-help">Not applicable for this premium term, premium and account split.</p>${promotionUnitsMarkup(input, units)}`;
        return;
    }

    const sum = list => list.reduce((a, b) => a + (b ?? 0), 0);
    const total = sum(rows.map(row => sum(row.amounts)));
    const yearTotals = [0, 1, 2].map(i => sum(rows.map(row => row.amounts[i])));
    const unitCell = (unitsValue, amount, rate) => `${unitsValue === null ? money(amount) : `${formatUnits(unitsValue)} units`}<div class="calc-th-note">${unitsValue === null ? "" : `${money(amount)} · `}${pct(rate, 0)}</div>`;

    box.innerHTML = `
        <div class="calc-welcome-head">
            <strong>Welcome Bonus</strong>
            <span>Total ${money(total)}</span>
        </div>
        <div class="table-wrap">
            <table class="data-table calc-welcome-table">
                <thead>
                    <tr>
                        <th scope="col">Fund</th>
                        <th scope="col">Units bought<div class="calc-th-note">each premium, before bonuses</div></th>
                        <th scope="col">Year 1</th>
                        <th scope="col">Year 2</th>
                        <th scope="col">Year 3</th>
                        <th scope="col">Total bonus</th>
                    </tr>
                </thead>
                <tbody>
                    ${rows.map(row => `
                        <tr>
                            <td><div class="fund-name">${escapeHtml(row.name)}</div><div class="fund-meta">${escapeHtml(row.meta)}</div></td>
                            <td>${row.baseUnits === null ? "—" : formatUnits(row.baseUnits)}<div class="calc-th-note">${money(row.base)}</div></td>
                            ${row.amounts.map((amount, i) => `<td>${unitCell(row.units[i], amount, row.rates[i])}</td>`).join("")}
                            <td><strong>${row.units.every(v => v !== null) ? `${formatUnits(sum(row.units))} units` : money(sum(row.amounts))}</strong>${row.units.every(v => v !== null) ? `<div class="calc-th-note">${money(sum(row.amounts))}</div>` : ""}</td>
                        </tr>
                    `).join("")}
                    ${rows.length > 1 ? `<tr class="calc-welcome-total"><td>Total value</td><td>${money(input.regular)}</td>${yearTotals.map(v => `<td>${money(v)}</td>`).join("")}<td><strong>${money(total)}</strong></td></tr>` : ""}
                </tbody>
            </table>
        </div>
        <p class="settings-help">Bonus units = units bought with each premium × the Welcome Bonus rate, on every premium in policy years 1–3. Year columns show the total for the year (${input.term}-year term, ${money(input.regular)} ${FREQUENCIES[input.frequency]}, annualised ${money(input.premium)}). Units use the current BID price, kept the same for every premium.</p>
        ${promotionUnitsMarkup(input, units)}
    `;
}

/* Promotion bonus units, shown under the Welcome Bonus once the
   premium reaches a promotion tier (and the start date is in the period) */
function promotionUnitsMarkup(input, units) {
    const promotion = promotionFor(input, input.shares);

    if (!promotion.applies) return "";

    const groups = calc.promo?.fundGroups ?? {};
    const rateFor = code => (groups.cioFunds?.codes ?? []).includes(code) ? promotion.tier.cioFunds / 100
        : (groups.strategicInvestIncome?.codes ?? []).includes(code) ? promotion.tier.strategicInvestIncome / 100
        : 0;

    const rows = units
        .map(item => ({ ...item, rate: rateFor(item.code) }))
        .filter(item => item.rate > 0 && item.amount > 0);

    if (!rows.length) return "";

    const total = rows.reduce((sum, item) => sum + item.amount * item.rate, 0);

    return `
        <div class="calc-welcome-head calc-promo-units-head">
            <strong>Promotion Bonus</strong>
            <span>Total ${money(total)}</span>
        </div>
        <div class="table-wrap">
            <table class="data-table calc-welcome-table">
                <thead>
                    <tr>
                        <th scope="col">Fund</th>
                        <th scope="col">Units bought<div class="calc-th-note">each premium, before bonuses</div></th>
                        <th scope="col">Rate</th>
                        <th scope="col">Year 1 bonus</th>
                    </tr>
                </thead>
                <tbody>
                    ${rows.map(item => `
                        <tr>
                            <td><div class="fund-name">${escapeHtml(fundName(item.code))}</div><div class="fund-meta">${escapeHtml(item.code)} · ${item.account === "growth" ? "Growth Account" : "Flex Account"}</div></td>
                            <td>${formatUnits(item.perUnits)}<div class="calc-th-note">${money(item.perAmount)}</div></td>
                            <td>${pct(item.rate)}</td>
                            <td><strong>${item.units === null ? money(item.amount * item.rate) : `${formatUnits(item.units * item.rate)} units`}</strong>${item.units === null ? "" : `<div class="calc-th-note">${money(item.amount * item.rate)}</div>`}</td>
                        </tr>
                    `).join("")}
                </tbody>
            </table>
        </div>
        <p class="settings-help">${escapeHtml(promotion.name)}: bonus units = units bought in the promotion funds with the first-year premiums × the promotion rate; Year 1 bonus is the total for the year (tier from ${money(promotion.tier.minAnnualPremium)} a year, ${input.term}-year term).</p>
    `;
}

/* Projected values: only after Generate */
function renderResults() {
    const out = qs("#calc-results");
    const dialog = qs("#calc-results-dialog");

    if (!out) return;

    const input = readInput();

    if (validate(input).length) {
        render();
        return;
    }

    const promotion = promotionFor(input, input.shares);

    const plan = PLANS[input.plan];
    const scenarios = input.returns.map(rate => ({ rate: rate / 100, rows: project(input, rate / 100, promotion) }));
    const base = scenarios[0].rows;

    const totalPremium = input.premium * input.term;
    const welcomeTotal = base.reduce((sum, row) => sum + row.welcome, 0);
    const promoTotal = base.reduce((sum, row) => sum + row.promotion, 0);
    const loyaltyFrom = plan.loyaltyFrom(input.term);

    const growthBand = band(plan.welcome.growth[input.term], input.premium) ?? [0, 0, 0];
    const flexBand = band(plan.welcome.flex[input.term], input.premium) ?? [0, 0, 0];

    const termRow = base[input.term - 1];
    const hasDividendFunds = input.shares.some(item => item.share > 0 && dividendInfo(item.code));
    const reinvestedTotal = base.reduce((sum, row) => sum + row.dividendsReinvested, 0);
    const paidOutTotal = base.reduce((sum, row) => sum + row.dividendsPaid, 0);
    const showPaid = paidOutTotal > 0;
    const frequencies = [...new Set(base.map(row => row.payoutFrequency).filter(Boolean))];
    const payoutLabel = frequencies.length === 1 && frequencies[0] !== "mixed" ? frequencies[0] : null;
    const scenarioHead = scenarios.map(s => `<th colspan="${2 + (showPaid ? 3 : 0)}" class="calc-scenario-head">At expected return rate of ${pct(s.rate)} a year</th>`).join("");
    const scenarioCols = scenarios.map(() => `
        <th>Account value</th>
        <th>Death benefit</th>
        ${showPaid ? `
            <th>Dividend paid out<div class="calc-th-note">${payoutLabel ? `each ${payoutLabel} payout` : "each payout"}</div></th>
            <th>Dividends paid out<div class="calc-th-note">to date</div></th>
            <th>Total net value<div class="calc-th-note">account value + dividends paid out</div></th>` : ""}
    `).join("");

    out.innerHTML = `
        <div class="calc-tiles">
            <div class="calc-tile">
                <span>Total premiums</span>
                <strong>${money(totalPremium)}</strong>
                <em>${money(input.regular)} ${FREQUENCIES[input.frequency]} for ${input.term} years${input.frequency > 1 ? ` (annualised ${money(input.premium)})` : ""}</em>
            </div>
            <div class="calc-tile">
                <span>Welcome Bonus</span>
                <strong>${money(welcomeTotal)}</strong>
                <em>${welcomeSummary(input, growthBand, flexBand)}</em>
            </div>
            <div class="calc-tile ${promotion?.applies ? "is-promo" : ""}">
                <span>Promotion bonus units</span>
                <strong>${promotion?.applies ? money(promoTotal) : "—"}</strong>
                <em>${promotion?.applies ? `${pct(promotion.rate)} of first-year premium` : "not included"}</em>
            </div>
            <div class="calc-tile">
                <span>Loyalty Bonus</span>
                <strong>0.5% a year</strong>
                <em>of Growth + Flex Account value, from policy year ${loyaltyFrom}</em>
            </div>
            <div class="calc-tile">
                <span>${plan.hasSumAssured ? "Sum assured" : "Death benefit (guaranteed)"}</span>
                <strong>${plan.hasSumAssured ? money(termRow?.sumAssured) : money(1.01 * totalPremium)}</strong>
                <em>${plan.hasSumAssured
                    ? `at end of premium term (${pct(Math.min(1.03 + 0.03 * (input.term - 1), 1.6), 0)} of premiums), rising to ${money(1.6 * totalPremium)}`
                    : `101% of premiums paid (105% for accidental death)${showPaid ? ", less dividend payments" : ""}`}</em>
            </div>
            <div class="calc-tile">
                <span>Expected return rate</span>
                <strong>${input.returns[0]}% a year</strong>
                <em>${hasDividendFunds
                    ? `Account value growth, plus dividends over ${base.length} years: ${[reinvestedTotal > 0.5 ? `${money(reinvestedTotal)} reinvested` : "", paidOutTotal > 0.5 ? `${money(paidOutTotal)} paid out` : ""].filter(Boolean).join(", ")}`
                    : "Account value growth, net of fund charges"}</em>
            </div>
        </div>

        <h3 class="calc-section-title">Projection chart</h3>
        <div class="calc-chart-card">
            <div class="calc-chart-legend" aria-hidden="true">
                ${chartSeries(plan, showPaid).map(item => `<span><i class="calc-swatch ${item.dashed ? "is-dashed" : ""}" style="--swatch:${item.color}"></i>${escapeHtml(item.label)}</span>`).join("")}
            </div>
            ${gainMilestones(base, input.term)}
            <div class="calc-chart-wrap">
                <canvas id="calc-chart" role="img" aria-label="Projected values by policy year; the same figures are in the policy illustration table below"></canvas>
            </div>
        </div>

        <h3 class="calc-section-title">Policy illustration</h3>
        <div class="table-wrap calc-table-wrap">
            <table class="data-table calc-table">
                <thead>
                    <tr>
                        <th rowspan="2">End of year / age</th>
                        <th rowspan="2">Premiums paid to date</th>
                        ${plan.hasSumAssured ? `<th rowspan="2">Sum assured<div class="calc-th-note">guaranteed</div></th>` : `<th rowspan="2">Guaranteed death benefit</th>`}
                        ${scenarioHead}
                    </tr>
                    <tr>${scenarioCols}</tr>
                </thead>
                <tbody>
                    ${base.map((row, i) => `
                        <tr class="${row.year === input.term ? "calc-row-term" : ""}">
                            <td>${row.year} / ${row.age}</td>
                            <td>${money(row.paid)}</td>
                            <td>${plan.hasSumAssured ? money(row.sumAssured) : money(row.guaranteedDeath)}</td>
                            ${scenarios.map(s => {
                                const r = s.rows[i];

                                return `
                                    <td>${r.lapsed ? "Lapsed" : money(r.account)}</td>
                                    <td>${r.lapsed ? "—" : money(r.deathBenefit)}</td>
                                    ${showPaid ? `
                                        <td>${r.payouts ? `${money(r.dividendsPaid / r.payouts)}<div class="calc-th-note">×${r.payouts} · ${money(r.dividendsPaid)} a year</div>` : "—"}</td>
                                        <td>${r.dividendsPaidTotal ? money(r.dividendsPaidTotal) : "—"}</td>
                                        <td><strong>${money(r.account + r.dividendsPaidTotal)}</strong></td>` : ""}
                                `;
                            }).join("")}
                        </tr>
                    `).join("")}
                </tbody>
            </table>
        </div>

        <details class="calc-details">
            <summary>Bonuses, charges${hasDividendFunds ? " and dividends" : ""} by year (at ${pct(scenarios[0].rate)})</summary>
            <div class="table-wrap calc-table-wrap">
                <table class="data-table calc-table">
                    <thead>
                        <tr>
                            <th>Year / age</th>
                            <th>Premium</th>
                            <th>Welcome Bonus</th>
                            <th>Promotion units</th>
                            <th>Loyalty Bonus</th>
                            <th>Admin charge</th>
                            ${plan.hasSumAssured ? "<th>Assurance charge</th>" : ""}
                            ${hasDividendFunds ? "<th>Dividends reinvested</th><th>Dividends paid out</th>" : ""}
                        </tr>
                    </thead>
                    <tbody>
                        ${base.map(row => `
                            <tr>
                                <td>${row.year} / ${row.age}</td>
                                <td>${row.premium ? money(row.premium) : "—"}</td>
                                <td>${row.welcome ? money(row.welcome) : "—"}</td>
                                <td>${row.promotion ? money(row.promotion) : "—"}</td>
                                <td>${row.loyalty ? money(row.loyalty) : "—"}</td>
                                <td>${row.adminCharge ? money(row.adminCharge) : "—"}</td>
                                ${plan.hasSumAssured ? `<td>${row.assuranceCharge ? money(row.assuranceCharge) : "—"}</td>` : ""}
                                ${hasDividendFunds ? `<td>${row.dividendsReinvested ? money(row.dividendsReinvested) : "—"}</td><td>${row.dividendsPaid ? money(row.dividendsPaid) : "—"}</td>` : ""}
                            </tr>
                        `).join("")}
                    </tbody>
                </table>
            </div>
        </details>

        <div class="calc-notes">
            <strong>How this is worked out.</strong>
            ${escapeHtml(plan.name)} rules from the product information pack (${escapeHtml(plan.packDate)}).
            Premiums (${escapeHtml(FREQUENCIES[input.frequency])}) are assumed paid at the start of each payment period, with the Welcome Bonus given on each premium.
            The expected return grows the account value each month; the BID price is kept at today's price, so every premium,
            bonus and reinvested dividend buys units at that price. Fund charges are already reflected in the BID price, so no fund
            charge is deducted separately.
            ${hasDividendFunds ? `Dividend-paying funds pay their latest declared dividend per unit at their usual frequency, on the units held. ${dividendNotes(input)}` : ""}
            Administration charge:
            ${pct(plan.admin[input.term][0], 1)} a year of the account value for the first ${plan.admin[input.term][1]} years.
            ${plan.hasSumAssured ? `Assurance charges use the ${input.sex === "F" ? "female" : "male"} ${input.smoker ? "smoker" : "non-smoker"} rates on the sum at risk.` : "There is no assurance charge."}

            ${promotion?.applies ? `Promotion units (“${escapeHtml(promotion.name)}”) are credited with the first-year premium; a clawback may apply if the promotion funds are switched out on or before day 180.` : ""}
            These are illustrations only; returns are not guaranteed and actual values will differ.
        </div>
    `;

    const subtitle = qs("#calc-results-subtitle");

    if (subtitle) {
        subtitle.textContent = `${plan.name} · ${money(input.regular)} ${FREQUENCIES[input.frequency]} for ${input.term} years · age ${input.age} next birthday · ${input.returns[0]}% a year`;
    }

    if (dialog && !dialog.open) dialog.showModal?.();

    out.closest(".calc-dialog-body")?.scrollTo(0, 0);

    // Draw after the popup is open so the chart can size itself
    drawProjectionChart(plan, base, showPaid);
}

/* % gain of total net value (account value + dividends paid out)
   over the premiums paid to date */
function netGain(row) {
    if (!row || !(row.paid > 0)) return null;

    return (row.account + row.dividendsPaidTotal) / row.paid - 1;
}

function signedPct(value) {
    if (value === null || !Number.isFinite(value)) return "—";

    return `${value >= 0 ? "+" : "−"}${(Math.abs(value) * 100).toFixed(1)}%`;
}

function gainMilestones(rows, term) {
    const years = [...new Set([term, 10, 20, 30, rows.length].filter(year => year >= 1 && year <= rows.length))].sort((a, b) => a - b);

    return `
        <div class="calc-gain-row">
            <span class="calc-gain-title">Total net value vs premiums paid</span>
            ${years.map(year => {
                const row = rows[year - 1];
                const gain = netGain(row);

                return `
                    <span class="calc-gain-chip ${gain !== null && gain < 0 ? "is-down" : "is-up"}">
                        <em>Year ${year} · age ${row.age}${year === term ? " · end of premium term" : ""}</em>
                        <strong>${signedPct(gain)}</strong>
                    </span>
                `;
            }).join("")}
        </div>
    `;
}

/* Chart series: colour follows the measure, never its rank */
function cssVar(name, fallback) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

function chartSeries(plan, showPaid) {
    const list = [
        { key: "account", label: "Account value", color: cssVar("--series-1", "#3987e5") }
    ];

    if (showPaid) {
        list.push({ key: "dividends", label: "Dividends paid out to date", color: cssVar("--series-2", "#d95926") });
        list.push({ key: "net", label: "Total net value (account value + dividends paid out)", color: cssVar("--series-3", "#199e70") });
    }

    // Reference line, not a category: neutral ink, dashed
    list.push({ key: "paid", label: "Premiums paid to date", color: cssVar("--text-muted", "#8b98a5"), dashed: true });

    return list;
}

function drawProjectionChart(plan, rows, showPaid) {
    if (!window.Chart) return;

    const text = cssVar("--text-primary", "#e6edf3");
    const muted = cssVar("--text-muted", "#8b98a5");
    const grid = cssVar("--border-subtle", "rgba(255,255,255,0.08)");
    const surface = cssVar("--bg-surface", "#101821");
    const border = cssVar("--border-medium", "rgba(255,255,255,0.15)");

    const valueOf = {
        account: row => row.lapsed ? 0 : row.account,
        dividends: row => row.dividendsPaidTotal,
        net: row => row.account + row.dividendsPaidTotal,
        paid: row => row.paid
    };

    const series = chartSeries(plan, showPaid);
    const compact = value => {
        const abs = Math.abs(value);

        if (abs >= 1e6) return `S$${(value / 1e6).toFixed(abs >= 1e7 ? 0 : 1)}m`;
        if (abs >= 1e3) return `S$${Math.round(value / 1e3)}k`;

        return `S$${Math.round(value)}`;
    };

    destroyChart("calc-chart");

    createChart("calc-chart", {
        type: "line",
        data: {
            labels: rows.map(row => String(row.year)),
            datasets: series.map(item => ({
                label: item.label,
                data: rows.map(valueOf[item.key]),
                borderColor: item.color,
                backgroundColor: item.color,
                borderWidth: 2,
                borderDash: item.dashed ? [5, 4] : [],
                pointRadius: 0,
                pointHoverRadius: 5,
                pointHoverBorderWidth: 2,
                pointHoverBorderColor: surface,
                tension: 0
            }))
        },
        plugins: [{
            id: "calcCrosshair",
            afterDatasetsDraw(chart) {
                const active = chart.tooltip?.getActiveElements?.() ?? [];

                if (!active.length) return;

                const x = active[0].element.x;
                const { top, bottom } = chart.chartArea;
                const ctx = chart.ctx;

                ctx.save();
                ctx.beginPath();
                ctx.moveTo(x, top);
                ctx.lineTo(x, bottom);
                ctx.lineWidth = 1;
                ctx.strokeStyle = border;
                ctx.stroke();
                ctx.restore();
            }
        }],
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: false,
            interaction: { mode: "index", intersect: false },
            plugins: {
                legend: { display: false },
                tooltip: {
                    backgroundColor: surface,
                    titleColor: text,
                    bodyColor: text,
                    borderColor: border,
                    borderWidth: 1,
                    padding: 10,
                    boxPadding: 4,
                    usePointStyle: true,
                    callbacks: {
                        title: items => {
                            const row = rows[items[0]?.dataIndex];

                            return row ? `End of policy year ${row.year} · age ${row.age}` : "";
                        },
                        label: item => ` ${item.dataset.label}: ${money(item.raw)}`,
                        footer: items => {
                            const row = rows[items[0]?.dataIndex];
                            const gain = netGain(row);

                            return gain === null ? "" : `Gain vs premiums paid: ${signedPct(gain)}`;
                        }
                    },
                    footerColor: text
                }
            },
            scales: {
                x: {
                    title: { display: true, text: "Policy year", color: muted },
                    ticks: { color: muted, maxRotation: 0, autoSkip: true, maxTicksLimit: 12 },
                    grid: { display: false },
                    border: { color: grid }
                },
                y: {
                    beginAtZero: true,
                    ticks: { color: muted, callback: value => compact(value), maxTicksLimit: 6 },
                    grid: { color: grid },
                    border: { display: false }
                }
            }
        }
    });
}

function dividendNotes(input) {
    const parts = [];

    if (input.growthShare > 0 && input.shares.some(item => item.account === "growth" && dividendInfo(item.code))) {
        parts.push(input.dividends.growth === "payout"
            ? `Growth Account dividends are reinvested until age ${input.dividends.growthStartAge} (policy year ${input.dividends.growthStartAge - input.age + 1}) and paid out from then on; the product rules allow payouts only from policy year 11.`
            : "Growth Account dividends are reinvested (automatic for the first 10 policy years).");
    }

    if (input.flexShare > 0 && input.shares.some(item => item.account === "flex" && dividendInfo(item.code))) {
        parts.push(input.dividends.flex === "payout"
            ? "Flex Account dividends are paid out in cash and leave the policy."
            : "Flex Account dividends are reinvested.");
    }

    if (!PLANS[input.plan].hasSumAssured && parts.some(text => text.includes("paid out"))) {
        parts.push("The guaranteed death benefit is 101% of premiums paid less dividend payments.");
    }

    if (PLANS[input.plan].hasSumAssured && parts.some(text => text.includes("paid out"))) {
        parts.push("Paying out dividends lowers the account value and so the Wealth Assure Value.");
    }

    return parts.join(" ");
}

function welcomeSummary(input, growthBand, flexBand) {
    const parts = [];

    if (input.growthShare > 0) parts.push(`Growth ${growthBand.map(r => pct(r, 0)).join(" / ")}`);
    if (input.flexShare > 0) parts.push(`Flex ${flexBand.map(r => pct(r, 0)).join(" / ")}`);

    return parts.length ? `${parts.join(" · ")} (years 1–3)` : "";
}

function promoStatusMarkup(input, promotion) {
    if (calc.promoStatus === "loading") return `<p class="settings-help">Checking the promotion folder…</p>`;

    if (calc.promoStatus !== "ok") {
        return `<div class="calc-promo is-off"><strong>No promotion.</strong> No promotion file found in the “Promotion Reference for PVA PVW” folder, so no promotion units are included.</div>`;
    }

    const promo = calc.promo;
    const head = `<strong>${escapeHtml(promo.name ?? "Promotion")}</strong> · ${formatDate(promo.period?.start)} – ${formatDate(promo.period?.end)}`;

    if (!promotion) return `<div class="calc-promo">${head}. Complete the setup to see whether it applies.</div>`;

    if (!promotion.applies) return `<div class="calc-promo is-off">${head}<br>${escapeHtml(promotion.reason)}</div>`;

    const parts = [];

    if (promotion.cioShare > 0) parts.push(`${pct(promotion.tier.cioFunds / 100)} on the ${pct(promotion.cioShare, 0)} in ${escapeHtml(promotion.labels.cio)}`);
    if (promotion.siiShare > 0) parts.push(`${pct(promotion.tier.strategicInvestIncome / 100)} on the ${pct(promotion.siiShare, 0)} in the ${escapeHtml(promotion.labels.sii)}`);


    return `
        <div class="calc-promo is-on">
            ${head} — <strong>applies</strong>: ${money(promotion.amount)} of bonus units
            (${parts.join(" + ")}; tier from ${money(promotion.tier.minAnnualPremium)} a year, ${input.term}-year term).
        </div>
    `;
}

function schedule() {
    updateLimitWarnings();
    window.clearTimeout(calc.timer);
    calc.timer = window.setTimeout(render, 120);
}


/* ============================================================
   EVENTS
   ============================================================ */

function bindEvents() {
    qs("#calc-plan-choice")?.addEventListener("click", event => {
        const option = event.target.closest("[data-calc-plan]");

        if (!option || option.dataset.calcPlan === calc.plan) return;

        calc.plan = option.dataset.calcPlan;
        renderPlanChoice();
        render();
    });

    qs("#calc-term")?.addEventListener("change", () => {
        renderTermRules();
        render();
    });

    qs("#calc-growth")?.addEventListener("change", () => {
        const field = qs("#calc-growth");
        const value = Math.min(100, Math.max(0, Math.round((Number(field.value) || 0) / ALLOCATION_STEP) * ALLOCATION_STEP));

        field.value = String(value);

        if (calc.lastGrowth === value) return;

        calc.lastGrowth = value;
        renderAccounts();
        render();
    });

    for (const selector of ["#calc-premium", "#calc-frequency", "#calc-dob", "#calc-sex", "#calc-smoker", "#calc-start", "#calc-return", "#calc-years", "#calc-div-growth", "#calc-div-flex", "#calc-div-age"]) {
        qs(selector)?.addEventListener("input", schedule);
        qs(selector)?.addEventListener("change", schedule);
    }

    const dialog = qs("#calc-results-dialog");

    qs("[data-calc-close]")?.addEventListener("click", () => dialog?.close());

    // Close when clicking the dimmed area outside the popup
    dialog?.addEventListener("click", event => {
        if (event.target === dialog) dialog.close();
    });

    // Choosing "Paid out" fills in the earliest age once; the box can then be cleared
    qs("#calc-div-growth")?.addEventListener("change", () => {
        const ageInput = qs("#calc-div-age");

        if (qs("#calc-div-growth").value !== "payout" || !ageInput || ageInput.value.trim()) return;

        const earliest = earliestPayoutAge(readInput());

        if (earliest) ageInput.value = String(earliest);
    });

    qs("#calc-generate")?.addEventListener("click", () => {
        window.clearTimeout(calc.timer);
        renderResults();
    });

    const box = qs("#calc-accounts");
    const pair = value => {
        const [account, rest] = String(value).split(/:(.*)/s);

        return [account, rest];
    };

    box?.addEventListener("focusin", event => {
        const search = event.target.closest("[data-calc-search]");

        if (search) renderSuggestions(search.dataset.calcSearch);
    });

    box?.addEventListener("input", event => {
        const search = event.target.closest("[data-calc-search]");

        if (search) {
            renderSuggestions(search.dataset.calcSearch);
            return;
        }

        const weight = event.target.closest("[data-calc-weight]");

        if (weight) {
            const [account, index] = pair(weight.dataset.calcWeight);
            const item = calc.accounts[account][Number(index)];

            if (item) item.weight = Math.max(0, Number(weight.value) || 0);

            const total = accountTotal(account);
            const chip = qs(`[data-calc-total="${account}"]`);

            if (chip) {
                chip.textContent = `Total ${total}%`;
                chip.classList.toggle("is-ok", Math.abs(total - 100) < 0.001);
                chip.classList.toggle("is-off", Math.abs(total - 100) >= 0.001);
            }

            schedule();
        }
    });

    box?.addEventListener("change", event => {
        const weight = event.target.closest("[data-calc-weight]");

        if (!weight) return;

        const [account, index] = pair(weight.dataset.calcWeight);
        const item = calc.accounts[account][Number(index)];

        if (item) item.weight = Math.min(100, Math.max(ALLOCATION_STEP, Math.round((Number(weight.value) || 0) / ALLOCATION_STEP) * ALLOCATION_STEP));

        renderAccounts();
        render();
    });

    box?.addEventListener("focusout", event => {
        const search = event.target.closest("[data-calc-search]");

        if (!search) return;

        setTimeout(() => {
            const list = qs(`[data-calc-suggestions="${search.dataset.calcSearch}"]`);

            if (list) list.hidden = true;
        }, 150);
    });

    box?.addEventListener("mousedown", event => {
        const option = event.target.closest("[data-calc-add]");

        if (!option) return;

        event.preventDefault();

        const [account, code] = pair(option.dataset.calcAdd);

        if (calc.accounts[account].some(item => item.code === code)) return;

        calc.accounts[account].push({ code, weight: 0 });
        splitEqually(account);
        renderAccounts();
        render();
    });

    box?.addEventListener("click", event => {
        const remove = event.target.closest("[data-calc-remove]");

        if (remove) {
            const [account, index] = pair(remove.dataset.calcRemove);

            calc.accounts[account].splice(Number(index), 1);
            renderAccounts();
            render();
            return;
        }

        const split = event.target.closest("[data-calc-split]");

        if (split) {
            splitEqually(split.dataset.calcSplit);
            renderAccounts();
            render();
        }
    });

    box?.addEventListener("keydown", event => {
        if (event.key !== "Escape") return;

        const search = event.target.closest("[data-calc-search]");
        const list = search ? qs(`[data-calc-suggestions="${search.dataset.calcSearch}"]`) : null;

        if (list) list.hidden = true;
    });
}


/* ============================================================
   PUBLIC API
   ============================================================ */

async function initializePlanCalculator({ funds }) {
    calc.funds = funds ?? [];
    calc.fundByCode = new Map(calc.funds.map(fund => [fund.fundCode, fund]));

    if (!calc.initialized) {
        calc.initialized = true;

        const start = qs("#calc-start");

        if (start && !start.value) start.value = todayIso();

        bindEvents();
        renderPlanChoice();
    }

    calc.listStatus = "loading";
    calc.promoStatus = "loading";
    renderAccounts();
    render();

    await Promise.all([
        (async () => {
            try {
                applyFundList(await readAllowedFunds());
                calc.listStatus = "ok";
                calc.listSource = "xlsx";
            } catch (error) {
                // Spreadsheet unavailable: fall back to the saved copy
                try {
                    const response = await fetch(FUNDS_LIST_FALLBACK_URL, { cache: "no-cache" });

                    if (!response.ok) throw new Error("no saved copy");

                    applyFundList((await response.json()).sheets ?? []);
                    calc.listStatus = "ok";
                    calc.listSource = "fallback";
                } catch {
                    calc.listStatus = "error";
                    calc.listError = error?.message ?? String(error);
                }
            }
        })(),
        loadPromotion()
    ]);

    const note = qs("#calc-list-note");

    if (note && calc.listStatus === "ok") {
        const unmatched = [...calc.unmatched.PVA, ...calc.unmatched.PVW];

        note.textContent =
            (calc.listSource === "xlsx"
                ? `Allowed funds from “${FUNDS_LIST_URL}” (highlighted cells): `
                : `“${FUNDS_LIST_URL}” couldn't be read, so the saved copy of its highlighted funds is used: `) +
            `${calc.allowed.PVA.length} for PRUVantage Assure II, ` +
            `${calc.allowed.PVW.length} for PRUVantage Wealth III.` +
            (unmatched.length ? ` Not recognised: ${[...new Set(unmatched)].join(", ")}.` : "");
    }

    renderTermRules();
    render();
}


export {
    initializePlanCalculator,
    project,
    PLANS
};
