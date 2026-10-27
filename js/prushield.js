/* ============================================================
   ELG FMS — PRUSHIELD PREMIUM CALCULATOR
   ============================================================

   Yearly PRUShield premium (MediShield Life + additional private
   cover + optional PRUExtra rider) and the MediSave / cash split,
   from the premium table effective 1 May 2026 (incl. 9% GST).

   Inputs: residency / pass, age next birthday, base plan, rider,
   PRUWell Reward (riders that have one).

   Rules:
   - SC / PR: MediShield Life fully from MediSave; the private
     top-up from MediSave up to the Additional Withdrawal Limit
     (AWL), the rest in cash.
   - Foreigner (Type 1): full premium in cash.
   - Foreigner (Type 2, dependant of an SC / PR): MediSave up to
     MediShield Life + AWL, the rest in cash.
   - Riders are always paid in cash.
   ============================================================ */


import { placeDropdown } from "./dropdown-place.js";


/* ---------- data: arrays indexed by age next birthday 1..101 (101 = above 100) ---------- */

function R(ranges) {
    const a = [];

    ranges.forEach(([lo, hi, v]) => {
        for (let i = lo; i <= hi; i += 1) a[i] = v;
    });

    return a;
}

function L(list) {
    const a = [];

    list.forEach((v, i) => { a[i + 1] = v; });

    if (a.length <= 101) a[101] = a[100];

    return a;
}

const MSL = R([[1,20,200],[21,30,295],[31,40,503],[41,50,637],[51,60,903],[61,65,1131],[66,70,1326],[71,73,1643],[74,75,1816],[76,78,2027],[79,80,2187],[81,83,2303],[84,85,2616],[86,90,2785],[91,101,2826]]);
const AWL = R([[1,40,300],[41,70,600],[71,101,900]]);

const PLANS = {
    premier: { name: "PRUShield Premier", pass: ["sc","pr","t1","t2"], aip: L([300,300,300,300,300,297,293,288,284,272,272,272,279,279,279,279,279,279,300,300,300,300,300,300,300,307,307,307,307,307,432,465,483,483,483,492,500,504,509,516,903,938,948,960,977,982,988,997,1007,1030,1507,1601,1694,1780,1869,1966,2064,2138,2188,2258,2739,2801,2881,2946,2994,3856,4146,4283,4393,4493,5146,5399,5518,5742,6299,6512,6938,7249,7501,8021,8437,8956,9580,9958,10314,10574,10929,11284,11642,11846,12009,12109,12209,12830,12903,12993,13075,13075,13075,13075]) },
    plus: { name: "PRUShield Plus", pass: ["sc","pr","t1","t2"], aip: R([[1,20,85],[21,30,77],[31,35,113],[36,40,152],[41,45,208],[46,50,251],[51,53,319],[54,60,357],[61,63,484],[64,65,600],[66,68,972],[69,70,1075],[71,73,1533],[74,74,1776],[75,75,1949],[76,76,2342],[77,78,2734],[79,80,2772],[81,83,3063],[84,85,3554],[86,90,3812],[91,93,3920],[94,95,4272],[96,98,4443],[99,101,4826]]) },
    standard: { name: "PRUShield Standard Plan", pass: ["sc","pr","t1","t2"], aip: R([[1,20,41.77],[21,30,48.90],[31,40,64.18],[41,50,110.02],[51,55,143.64],[56,60,182.35],[61,65,254.67],[66,70,403.40],[71,73,621.40],[74,75,759.94],[76,78,959.61],[79,80,1032.95],[81,83,1178.63],[84,85,1225.49],[86,88,1442.47],[89,90,1620.74],[91,93,1778.64],[94,95,1979.32],[96,98,2191.21],[99,101,2416.34]]) },
    a: { name: "PRUShield A", renewal: true, pass: ["sc","pr"], aip: R([[1,30,68.25],[31,40,92.70],[41,50,171.14],[51,55,254.67],[56,60,268.93],[61,65,480.82],[66,70,806.80],[71,73,1304.94],[74,75,1532.11],[76,78,2256.40],[79,80,2168.79],[81,83,1915.14],[84,85,2216.67],[86,90,2407.17],[91,93,4091.07],[94,95,4374.26],[96,98,4407.88],[99,101,4759.33]]) },
    b: { name: "PRUShield B", renewal: true, pass: ["sc","pr"], aip: R([[1,30,39.73],[31,40,52.97],[41,50,78.44],[51,55,81.50],[56,60,91.68],[61,65,179.29],[66,70,354.50],[71,73,645.85],[74,75,749.76],[76,78,1156.21],[79,80,1084.91],[81,83,828.20],[84,85,862.83],[86,90,941.27],[91,93,1986.45],[94,95,2164.72],[96,98,2186.11],[99,101,2406.15]]) }
};

const ALL = ["sc","pr","t1","t2"];

const RIDERS = {
    premierCare: { name: "PRUExtra Premier Care", base: "premier", pass: ALL, reward: 0.2, prem: L([756,754,749,737,724,701,678,655,631,607,577,579,581,583,585,587,591,597,604,611,618,625,633,641,649,657,665,673,681,690,709,727,746,757,770,783,801,821,843,864,963,1040,1115,1191,1226,1247,1268,1291,1315,1342,1468,1570,1671,1773,1943,2114,2232,2356,2472,2670,2940,3184,3416,3576,3790,4050,4300,4550,4770,4990,5190,5524,5744,6025,6275,6507,6709,6910,7110,7298,7486,7674,7786,7898,8018,8222,8422,8622,8767,8908,8963,9013,9061,9159,9255,9321,9387,9456,9554,9652,9652]) },
    preferredCare: { name: "PRUExtra Preferred Care", base: "premier", pass: ALL, prem: L([332,330,329,325,318,308,298,287,276,265,260,261,262,263,264,265,266,267,268,269,273,278,282,284,286,288,290,293,296,299,304,309,316,324,332,341,350,360,375,394,430,469,515,541,553,565,577,588,600,612,658,707,746,786,828,897,979,1032,1098,1184,1279,1373,1470,1566,1646,1745,1850,1969,2085,2200,2305,2410,2518,2641,2752,2866,2978,3088,3198,3302,3407,3510,3600,3690,3780,3870,3965,4063,4159,4192,4225,4257,4321,4385,4429,4474,4517,4584,4649,4715,4715]) },
    premierCoPay: { name: "PRUExtra Premier CoPay", base: "premier", pass: ALL, renewal: true, reward: 0.2, prem: L([1147,1143,1135,1116,1097,1063,1027,992,954,919,874,877,879,881,883,887,893,900,905,909,974,980,986,992,996,998,1000,1015,1028,1041,1090,1116,1131,1147,1159,1169,1184,1201,1217,1235,1605,1637,1795,1850,1857,1885,1900,1905,1913,1918,2440,2465,2521,2709,2783,3355,3398,3410,3746,3895,4760,4855,5206,5418,5440,6580,7046,7493,7550,7585,8280,8370,8703,9129,9508,9859,10165,10469,10772,11057,11343,11627,11706,11785,12148,12457,12760,13063,13284,13497,13581,13656,13729,13877,14023,14123,14223,14324,14476,14624]) },
    preferredCoPay: { name: "PRUExtra Preferred CoPay", base: "premier", pass: ALL, renewal: true, reward: 0.2, prem: L([664,660,657,650,635,614,593,573,551,531,506,508,510,511,512,513,515,517,520,522,565,565,568,569,570,571,577,585,593,603,636,646,655,664,671,681,690,699,709,717,945,958,1050,1081,1085,1089,1093,1096,1100,1104,1415,1424,1456,1566,1605,1944,1957,1963,2165,2247,2757,2806,3009,3132,3132,3820,4079,4337,4369,4400,4802,4837,5036,5282,5503,5731,5956,6175,6396,6604,6814,7019,7076,7135,7400,7665,7930,8125,8318,8383,8449,8514,8642,8769,8858,8947,9034,9167,9298,9429]) },
    premierLiteCoPay: { name: "PRUExtra Premier Lite CoPay", base: "premier", pass: ALL, renewal: true, prem: L([464,462,459,454,447,432,418,403,388,374,356,357,358,359,360,361,363,364,366,368,382,385,390,395,400,402,406,412,418,425,438,451,458,465,473,480,486,492,499,505,625,670,710,730,758,765,770,772,775,778,948,997,1020,1095,1126,1305,1335,1382,1455,1515,1850,1885,2020,2105,2115,2555,2735,2910,2930,2945,3270,3386,3520,3692,3846,3988,4112,4235,4358,4472,4646,4761,4900,5000,5100,5226,5353,5479,5573,5662,5700,5730,5800,5891,5953,5995,6037,6081,6145,6207]) },
    extraPremier: { name: "PRUExtra Premier", base: "premier", pass: ALL, renewal: true, reward: 0.2, prem: L([1687,1677,1669,1644,1614,1564,1513,1459,1401,1354,1287,1295,1300,1302,1304,1308,1318,1330,1343,1360,1428,1441,1450,1459,1464,1469,1474,1492,1511,1538,1608,1647,1670,1693,1712,1736,1757,1780,1807,1831,2395,2445,2660,2704,2720,2736,2753,2768,2784,2809,3250,3620,3721,3992,4099,4945,5001,5021,5519,5728,7016,7134,7653,7973,7990,9590,10377,11034,11137,11150,11162,11219,11639,12110,12533,12967,13308,13633,13955,14273,14576,14878,15178,15261,15345,15728,16115,16498,16779,17061,17156,17251,17344,17531,17716,17843,17970,18098,18291,18479]) },
    extraPremierLite: { name: "PRUExtra Premier Lite", base: "premier", pass: ALL, renewal: true, prem: L([947,947,947,941,919,873,842,815,783,754,718,721,722,724,726,728,734,740,742,747,806,814,818,824,827,829,830,840,851,862,899,923,935,948,958,958,970,984,996,1010,1306,1336,1459,1508,1514,1535,1550,1553,1560,1563,1978,2004,2049,2194,2261,2714,2757,2767,3032,3162,3853,3941,4211,4394,4412,5317,5708,6069,6114,6143,6610,6660,6845,7082,7292,7487,7657,7825,7993,8152,8310,8468,8512,8556,8757,8929,9097,9265,9388,9506,9552,9594,9635,9717,9798,9853,9909,9965,10049,10131]) },
    plusCare: { name: "PRUExtra Plus Care", base: "plus", pass: ALL, prem: R([[1,5,167],[6,20,170],[21,40,174],[41,50,243],[51,55,355],[56,60,480],[61,65,665],[66,70,868],[71,73,1108],[74,75,1291],[76,78,1443],[79,80,1469],[81,83,1561],[84,85,1623],[86,88,1739],[89,90,1841],[91,93,1898],[94,95,1955],[96,98,2012],[99,101,2072]]) },
    plusCoPay: { name: "PRUExtra Plus CoPay", base: "plus", pass: ALL, renewal: true, prem: R([[1,20,258],[21,30,264],[31,40,289],[41,50,360],[51,55,507],[56,60,693],[61,65,959],[66,70,1250],[71,73,1584],[74,75,1862],[76,78,2065],[79,80,2226],[81,83,2365],[84,85,2459],[86,88,2635],[89,90,2790],[91,93,2875],[94,95,2962],[96,98,3049],[99,101,3140]]) },
    plusLiteCoPay: { name: "PRUExtra Plus Lite CoPay", base: "plus", pass: ALL, renewal: true, prem: R([[1,20,177],[21,30,183],[31,40,201],[41,50,252],[51,55,360],[56,60,481],[61,65,666],[66,70,869],[71,73,1117],[74,75,1292],[76,78,1474],[79,80,1626],[81,83,1784],[84,85,1884],[86,88,2075],[89,90,2137],[91,93,2202],[94,95,2268],[96,98,2335],[99,101,2404]]) },
    extraPlus: { name: "PRUExtra Plus", base: "plus", pass: ALL, renewal: true, reward: 0.1, prem: R([[1,20,355],[21,30,381],[31,40,437],[41,50,594],[51,55,852],[56,60,1140],[61,65,1579],[66,70,2025],[71,73,2353],[74,75,2714],[76,78,3023],[79,80,3265],[81,83,3468],[84,88,3606],[89,90,3891],[91,93,3988],[94,95,4084],[96,98,4181],[99,101,4283]]) },
    extraPlusLite: { name: "PRUExtra Plus Lite", base: "plus", pass: ["sc","pr"], renewal: true, prem: R([[1,20,233],[21,30,239],[31,40,261],[41,50,326],[51,55,468],[56,60,625],[61,65,866],[66,70,1130],[71,73,1454],[74,75,1683],[76,78,1924],[79,80,2118],[81,83,2313],[84,85,2451],[86,88,2581],[89,90,2781],[91,93,2850],[94,95,2913],[96,98,2981],[99,101,3050]]) }
};

const PASS_HINT = {
    local: "MediShield Life is paid fully by MediSave; the private top-up can use MediSave up to the Additional Withdrawal Limit.",
    t1: "Foreigners pay the full PRUShield premium in cash.",
    t2: "Full premium is shown; MediSave from an SC / PR payer can cover part of it.",
    t2Note: "The payer may use MediSave up to the withdrawal limit only if the insured is their spouse, child or parent."
};


/* ---------- helpers ---------- */

const $ = id => document.getElementById(id);

const fmt = value => "S$" + value.toLocaleString("en-SG", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const r2 = value => Math.round(value * 100) / 100;

function escapeHtml(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

function option(value, text) {
    const element = document.createElement("option");

    element.value = value;
    element.textContent = text;

    return element;
}


/* ---------- form ---------- */

/*
 * Age: typed as age next birthday, or worked out from the date of
 * birth (age today + 1). The result goes into #shield-age (1-101,
 * 101 = above 100), which the premium tables use.
 */
let ageMode = "anb";

function ageNextBirthday(dobText, today = new Date()) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dobText || "");
    if (!match) return null;

    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const dob = new Date(year, month - 1, day);

    if (Number.isNaN(dob.getTime()) || dob > today) return null;

    let age = today.getFullYear() - year;
    const birthdayPassed =
        today.getMonth() + 1 > month ||
        (today.getMonth() + 1 === month && today.getDate() >= day);

    if (!birthdayPassed) age -= 1;

    return { age, anb: age + 1 };
}

function updateAge() {
    const hint = $("shield-age-hint");
    const hidden = $("shield-age");
    let anb = null;

    if (ageMode === "dob") {
        const result = ageNextBirthday($("shield-dob").value);

        if (!$("shield-dob").value) {
            hint.textContent = "Enter the date of birth; the age next birthday is worked out from today's date.";
        } else if (!result) {
            hint.textContent = "Please enter a valid date of birth (not in the future).";
        } else {
            anb = result.anb;
            hint.textContent = `Age next birthday ${result.anb > 101 ? "above 100" : result.anb} (age ${result.age} today).`;
        }
    } else {
        const raw = $("shield-anb").value.trim();
        const typed = /^above\s*100$/i.test(raw) ? 101 : Number(raw);

        if (!raw) {
            hint.textContent = "Type the age next birthday (1 to 100, or 101 for above 100).";
        } else if (!Number.isInteger(typed) || typed < 1) {
            hint.textContent = "Age next birthday must be a whole number from 1.";
        } else {
            anb = typed;
            hint.textContent = typed > 100
                ? "Above 100: the age 101 rates are used."
                : "Age next birthday = current age + 1.";
        }
    }

    hint.classList.toggle("is-error", anb === null);

    if (anb !== null) {
        hidden.value = String(Math.min(101, Math.max(1, anb)));
        return true;
    }

    return false;
}

function setAgeMode(mode) {
    ageMode = mode === "dob" ? "dob" : "anb";

    document.querySelectorAll("[data-age-mode]").forEach(button => {
        const active = button.dataset.ageMode === ageMode;
        button.classList.toggle("active", active);
        button.setAttribute("aria-selected", String(active));
    });

    $("shield-anb-box").hidden = ageMode !== "anb";
    closeAgeList();
    $("shield-dob").hidden = ageMode !== "dob";

    // Carry the age across: DOB -> fill ANB, so switching back keeps it
    if (ageMode === "anb" && $("shield-dob").value) {
        const result = ageNextBirthday($("shield-dob").value);
        if (result) $("shield-anb").value = String(Math.min(101, result.anb));
    }

    if (updateAge()) calculate();
}

/* ---------- age next birthday: type it, or pick from the list ---------- */

function ageLabel(age) {
    return age === 101 ? "Above 100" : String(age);
}

function closeAgeList() {
    const list = $("shield-anb-list");
    if (!list) return;
    list.hidden = true;
    $("shield-anb").setAttribute("aria-expanded", "false");
}

function openAgeList() {
    const list = $("shield-anb-list");
    const input = $("shield-anb");
    const current = Number($("shield-age").value) || 35;

    list.innerHTML = "";

    for (let age = 1; age <= 101; age += 1) {
        const item = document.createElement("li");
        item.id = `shield-anb-option-${age}`;
        item.setAttribute("role", "option");
        item.dataset.age = String(age);
        item.textContent = ageLabel(age);
        item.setAttribute("aria-selected", String(age === current));
        list.appendChild(item);
    }

    list.hidden = false;
    input.setAttribute("aria-expanded", "true");
    // Open downwards, or upwards when there's no room (phone menu, footer)
    placeDropdown(list);
    highlightAge(current, true);
}

function highlightAge(age, scroll) {
    const list = $("shield-anb-list");
    list.querySelectorAll(".is-active").forEach(item => item.classList.remove("is-active"));
    const item = list.querySelector(`[data-age="${age}"]`);
    if (!item) return;
    item.classList.add("is-active");
    $("shield-anb").setAttribute("aria-activedescendant", item.id);
    // Scroll only inside the list, never the page
    if (scroll) {
        const top = item.offsetTop;
        const bottom = top + item.offsetHeight;
        if (top < list.scrollTop) list.scrollTop = top - 4;
        else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight + 4;
    }
}

function chooseAge(age) {
    $("shield-anb").value = ageLabel(age);
    closeAgeList();
    if (updateAge()) calculate();
}

function bindAgeCombo() {
    const input = $("shield-anb");
    const list = $("shield-anb-list");
    const toggle = $("shield-anb-toggle");

    toggle.addEventListener("click", () => {
        if (list.hidden) {
            openAgeList();
            // Phones: don't pop up the keyboard (or scroll) when picking from the list
            if (!window.matchMedia("(pointer: coarse)").matches) {
                input.focus({ preventScroll: true });
            }
        } else {
            closeAgeList();
        }
    });

    // Picking with mouse / touch (mousedown so the input keeps focus)
    list.addEventListener("mousedown", event => {
        const item = event.target.closest("[data-age]");
        if (!item) return;
        event.preventDefault();
        chooseAge(Number(item.dataset.age));
    });

    input.addEventListener("keydown", event => {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            if (list.hidden) openAgeList();
            const active = list.querySelector(".is-active");
            const current = Number(active?.dataset.age ?? $("shield-age").value ?? 35);
            const next = Math.min(101, Math.max(1, current + (event.key === "ArrowDown" ? 1 : -1)));
            highlightAge(next, true);
        } else if (event.key === "Enter" && !list.hidden) {
            const active = list.querySelector(".is-active");
            if (active) {
                event.preventDefault();
                chooseAge(Number(active.dataset.age));
            }
        } else if (event.key === "Escape") {
            closeAgeList();
        }
    });

    // While typing, jump the open list to the typed age
    input.addEventListener("input", () => {
        const typed = Number(input.value.trim());
        if (!list.hidden && Number.isInteger(typed) && typed >= 1) {
            highlightAge(Math.min(101, typed), true);
        }
    });

    // Clicking ▾ shouldn't take the focus away from the box
    toggle.addEventListener("mousedown", event => event.preventDefault());

    input.addEventListener("blur", () => setTimeout(() => {
        if (document.activeElement !== input) closeAgeList();
    }, 150));

    document.addEventListener("click", event => {
        if (!event.target.closest("#shield-anb-box")) closeAgeList();
    });
}

function fillAges() {
    bindAgeCombo();

    const today = new Date();
    const pad = value => String(value).padStart(2, "0");

    $("shield-dob").max = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
    $("shield-dob").min = `${today.getFullYear() - 120}-01-01`;

    updateAge();
}

function fillPlans() {
    const pass = $("shield-pass").value;
    const select = $("shield-plan");
    const current = select.value;

    select.innerHTML = "";

    Object.entries(PLANS).forEach(([key, plan]) => {
        if (!plan.pass.includes(pass)) return;

        select.appendChild(option(key, plan.name + (plan.renewal ? " (renewal only)" : "")));
    });

    if ([...select.options].some(item => item.value === current)) select.value = current;
}

function fillRiders() {
    const pass = $("shield-pass").value;
    const plan = $("shield-plan").value;
    const select = $("shield-rider");
    const current = select.value;

    select.innerHTML = "";
    select.appendChild(option("", "No rider"));

    const open = [];
    const renewal = [];

    Object.entries(RIDERS).forEach(([key, rider]) => {
        if (rider.base !== plan || !rider.pass.includes(pass)) return;

        (rider.renewal ? renewal : open).push([key, rider]);
    });

    const group = (list, label, suffix) => {
        if (!list.length) return;

        const element = document.createElement("optgroup");

        element.label = label;
        list.forEach(([key, rider]) => element.appendChild(option(key, rider.name + suffix)));
        select.appendChild(element);
    };

    group(open, "Available for new applications", "");
    group(renewal, "Withdrawn – renewal only", " (renewal only)");

    select.disabled = select.options.length === 1;

    if ([...select.options].some(item => item.value === current)) select.value = current;
}


/* ---------- calculation ---------- */

function calculate() {
    const pass = $("shield-pass").value;
    const age = Number($("shield-age").value);
    const planKey = $("shield-plan").value;
    const riderKey = $("shield-rider").value;
    const plan = PLANS[planKey];
    const rider = RIDERS[riderKey];

    if (!plan) return;

    const local = pass === "sc" || pass === "pr";
    const msl = MSL[age];
    const aip = plan.aip[age];
    const awl = AWL[age];
    const rows = [];
    const notes = [];

    let medisave = 0;
    let cash = 0;

    if (local) {
        const aipMs = Math.min(aip, awl);
        const aipCash = r2(aip - aipMs);

        rows.push(["MediShield Life", "Paid by MediSave", msl]);
        rows.push([
            `${plan.name} additional private cover`,
            `MediSave up to ${fmt(awl)} (AWL)` + (aipCash > 0 ? `, cash ${fmt(aipCash)}` : ""),
            aip
        ]);

        medisave += msl + aipMs;
        cash += aipCash;
    } else {
        const full = r2(msl + aip);

        rows.push([
            `${plan.name} (full premium)`,
            pass === "t1" ? "Cash only" : `MediSave limit ${fmt(msl + awl)}`,
            full
        ]);

        if (pass === "t2") {
            const fromMediSave = Math.min(full, msl + awl);

            medisave += fromMediSave;
            cash += r2(full - fromMediSave);
        } else {
            cash += full;
        }
    }

    const rewardWrap = $("shield-reward-wrap");
    const rewardOn = Boolean(rider?.reward) && $("shield-reward").checked;

    if (rider) {
        const standard = rider.prem[age];
        const value = rewardOn ? r2(standard * (1 - rider.reward)) : standard;

        rows.push([
            `${rider.name} rider`,
            rewardOn ? `Cash · standard ${fmt(standard)} less ${rider.reward * 100}% PRUWell Reward` : "Cash only",
            value
        ]);

        cash += value;
    }

    medisave = r2(medisave);
    cash = r2(cash);

    const total = r2(medisave + cash);

    // PRUWell Reward toggle only for riders that have one
    rewardWrap.hidden = !rider?.reward;

    if (rider?.reward) {
        $("shield-reward-label").textContent = `Apply ${rider.reward * 100}% PRUWell Reward on rider (no claims, standard terms)`;
    }

    if (age > 75) notes.push(["warn", "Maximum entry age is 75 (age next birthday). Premiums above 75 apply to renewals only."]);
    if (plan.renewal) notes.push(["warn", `${plan.name} is withdrawn from new business; shown for renewals only.`]);
    if (rider?.renewal) notes.push(["warn", `${rider.name} is withdrawn from new business and mid-term add; renewal only.`]);
    if (pass === "t2") notes.push(["info", PASS_HINT.t2Note]);
    if (!Object.values(RIDERS).some(item => item.base === planKey)) notes.push(["info", "No PRUExtra rider attaches to this base plan."]);

    $("shield-notes").innerHTML = notes
        .map(([tone, text]) => `<div class="shield-note ${tone === "info" ? "is-info" : "is-warn"}">${escapeHtml(text)}</div>`)
        .join("");

    $("shield-pass-hint").textContent = local ? PASS_HINT.local : pass === "t1" ? PASS_HINT.t1 : PASS_HINT.t2;

    $("shield-rows").innerHTML = rows
        .map(([name, detail, value]) => `
            <tr>
                <td>${escapeHtml(name)}<span class="shield-sub">${escapeHtml(detail)}</span></td>
                <td class="shield-num">${fmt(value)}</td>
            </tr>
        `)
        .join("") + `
            <tr class="shield-sum">
                <td>Total per year</td>
                <td class="shield-num">${fmt(total)}</td>
            </tr>
        `;

    $("shield-total").textContent = fmt(total);
    $("shield-context").textContent =
        `Age next birthday ${age === 101 ? "above 100" : age} · ${$("shield-pass").selectedOptions[0]?.textContent ?? ""}`;
    $("shield-ms-amt").textContent = fmt(medisave);
    $("shield-cash-amt").textContent = fmt(cash);

    const share = total ? (medisave / total) * 100 : 0;

    $("shield-bar-ms").style.width = `${share}%`;
    $("shield-bar-cash").style.width = `${100 - share}%`;
}


/* ---------- public ---------- */

let initialized = false;

function initializePruShield() {
    if (initialized || !$("shield-pass")) return;

    initialized = true;

    fillAges();
    fillPlans();
    $("shield-plan").value = "premier";
    fillRiders();
    $("shield-rider").value = "premierCare";

    $("shield-pass").addEventListener("change", () => { fillPlans(); fillRiders(); calculate(); });
    $("shield-plan").addEventListener("change", () => { fillRiders(); calculate(); });
    $("shield-anb").addEventListener("input", () => { if (updateAge()) calculate(); });
    $("shield-dob").addEventListener("input", () => { if (updateAge()) calculate(); });
    $("shield-dob").addEventListener("change", () => { if (updateAge()) calculate(); });
    document.querySelectorAll("[data-age-mode]").forEach(button => {
        button.addEventListener("click", () => setAgeMode(button.dataset.ageMode));
    });
    $("shield-rider").addEventListener("change", calculate);
    $("shield-reward").addEventListener("change", calculate);

    calculate();
}

export {
    initializePruShield
};
