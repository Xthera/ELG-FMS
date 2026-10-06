/* ============================================================
   ELG FMS — UPDATE SCHEDULE (Settings page)
   ============================================================
   Live countdowns to the next automatic data updates.

   The times below copy the schedules in .github/workflows.
   If a workflow's cron changes, update UPDATE_JOBS to match.

     Fund details    build_funds_data.yml   cron "0 16,4 * * *"
                     -> daily 00:00 SGT and 12:00 SGT
     Market refresh  market-news.yml        cron "20 16,19,22,1,4,7,10,13 * * *"
                     -> every 3 hours from 00:20 SGT
     Market analysis market-news-analysis.yml
                     -> runs when a market refresh finishes
                        (no clock time of its own)

   GitHub often starts scheduled runs 5–30 minutes late, so a
   countdown reaching zero means "due", not "done".
   ============================================================ */

const SGT_OFFSET_MINUTES = 8 * 60;

const ANALYSIS_DELAY_MINUTES = 15;   // typical gap after a market refresh
const DUE_GRACE_MINUTES = 60;        // after this, a missing run is "late"
const REFRESH_SOURCES_MS = 5 * 60 * 1000;

const UPDATE_JOBS = [
    {
        key: "funds",
        name: "Fund details",
        detail: "BID prices, returns, holdings, dividends",
        scheduleText: "Twice daily, 00:00 and 12:00 SGT",
        utcSlots: [[16, 0], [4, 0]],
        source: "data/funds.json",
        stampOf: raw => raw?.generatedAtUtc ?? null
    },
    {
        key: "news",
        name: "Market refresh",
        detail: "News collected from CNBC",
        scheduleText: "Every 3 hours from 00:20 SGT",
        utcSlots: [16, 19, 22, 1, 4, 7, 10, 13].map(hour => [hour, 20]),
        source: "data/market_news/current.json",
        stampOf: raw => raw?.generatedAtSgt ?? null
    },
    {
        key: "analysis",
        name: "Market analysis",
        detail: "AI analysis of the collected news",
        scheduleText: `Right after each market refresh (about ${ANALYSIS_DELAY_MINUTES} min later)`,
        utcSlots: [16, 19, 22, 1, 4, 7, 10, 13].map(hour => [hour, 20 + ANALYSIS_DELAY_MINUTES]),
        approximate: true,
        source: "data/market_news/analysis/current.json",
        stampOf: raw => raw?.generatedAtSgt ?? null
    }
];

const schedule = {
    initialized: false,
    timer: null,
    lastSourceCheck: 0,
    published: new Map(),   // key -> Date of latest file on the site
    loaded: new Map()       // key -> Date of the data this page is showing
};


/* ============================================================
   HELPERS
   ============================================================ */

const qs = (selector, root = document) => root.querySelector(selector);

function parseDate(value) {
    if (!value) return null;

    const date = new Date(value);

    return Number.isNaN(date.getTime()) ? null : date;
}

/* All scheduled run times (UTC) between two dates. */
function slotTimes(job, from, to) {
    const times = [];
    const day = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate() - 1));

    while (day <= to) {
        for (const [hour, minute] of job.utcSlots) {
            const time = new Date(day);

            time.setUTCHours(hour, 0, 0, 0);
            time.setUTCMinutes(minute);
            times.push(time);
        }

        day.setUTCDate(day.getUTCDate() + 1);
    }

    return times.sort((a, b) => a - b);
}

function previousAndNext(job, now) {
    const from = new Date(now.getTime() - 2 * 86400000);
    const to = new Date(now.getTime() + 2 * 86400000);
    const times = slotTimes(job, from, to);

    let previous = null;
    let next = null;

    for (const time of times) {
        if (time <= now) previous = time;
        else if (!next) next = time;
    }

    return { previous, next };
}

function pad(number) {
    return String(number).padStart(2, "0");
}

function formatCountdown(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;

    return hours > 0
        ? `${hours}h ${pad(minutes)}m ${pad(seconds)}s`
        : `${minutes}m ${pad(seconds)}s`;
}

function formatAgo(ms) {
    const minutes = Math.max(0, Math.round(ms / 60000));

    if (minutes < 60) return `${minutes} min`;

    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;

    return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

/* Dates are always shown in Singapore time. */
function formatSgt(date, { withDay = true } = {}) {
    if (!date) return "—";

    const sgt = new Date(date.getTime() + SGT_OFFSET_MINUTES * 60000);
    const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

    let hours = sgt.getUTCHours();
    const suffix = hours >= 12 ? "pm" : "am";

    hours = hours % 12 || 12;

    const time = `${hours}:${pad(sgt.getUTCMinutes())} ${suffix}`;

    return withDay
        ? `${days[sgt.getUTCDay()]} ${pad(sgt.getUTCDate())} ${months[sgt.getUTCMonth()]}, ${time} SGT`
        : `${time} SGT`;
}


/* ============================================================
   DATA TIMESTAMPS
   ============================================================ */

/* Latest timestamps actually published on the site. "no-cache"
   revalidates with the server, so unchanged files cost a 304. */
async function refreshPublishedStamps() {
    schedule.lastSourceCheck = Date.now();

    await Promise.all(UPDATE_JOBS.map(async job => {
        try {
            const response = await fetch(job.source, { cache: "no-cache" });

            if (!response.ok) return;

            const stamp = parseDate(job.stampOf(await response.json()));

            if (stamp) schedule.published.set(job.key, stamp);
        } catch {
            // Offline or blocked: keep whatever we had.
        }
    }));

    render();
}

function setLoadedUpdateTime(key, value) {
    const date = parseDate(value);

    if (date) schedule.loaded.set(key, date);
}


/* ============================================================
   RENDER
   ============================================================ */

function statusFor(job, now) {
    const { previous, next } = previousAndNext(job, now);
    const lastUpdate = schedule.published.get(job.key) ?? schedule.loaded.get(job.key) ?? null;

    // The latest scheduled run hasn't produced new data yet.
    const waiting = previous && (!lastUpdate || lastUpdate < previous);
    const sincePrevious = previous ? now - previous : 0;

    let tone = "ok";
    let label = "Up to date";

    if (waiting && sincePrevious <= DUE_GRACE_MINUTES * 60000) {
        tone = "due";
        label = `Updating now · due ${formatAgo(sincePrevious)} ago`;
    } else if (waiting) {
        tone = "late";
        label = `Running late · due ${formatAgo(sincePrevious)} ago`;
    }

    const loaded = schedule.loaded.get(job.key);
    const newerOnSite = loaded && lastUpdate && lastUpdate > loaded;

    return { next, lastUpdate, tone, label, newerOnSite };
}

function render() {
    const root = qs("#update-schedule");

    if (!root) return;

    const view = qs("#settings-view");

    if (view?.hidden) return;

    const now = new Date();

    for (const job of UPDATE_JOBS) {
        const row = qs(`[data-schedule-job="${job.key}"]`, root);

        if (!row) continue;

        const status = statusFor(job, now);

        qs("[data-schedule-countdown]", row).textContent =
            (job.approximate ? "≈ " : "") + formatCountdown(status.next - now);

        qs("[data-schedule-next]", row).textContent =
            `Next: ${job.approximate ? "about " : ""}${formatSgt(status.next)}`;

        qs("[data-schedule-last]", row).textContent =
            `Last updated: ${formatSgt(status.lastUpdate)}`;

        const chip = qs("[data-schedule-status]", row);

        chip.textContent = status.label;
        chip.dataset.tone = status.tone;

        const reload = qs("[data-schedule-reload]", row);

        if (reload) reload.hidden = !status.newerOnSite;
    }
}

function rowMarkup(job) {
    return `
        <li class="schedule-row" data-schedule-job="${job.key}">
            <div class="schedule-main">
                <div class="schedule-name">${job.name}</div>
                <div class="schedule-detail">${job.detail}</div>
                <div class="schedule-when">${job.scheduleText}</div>
            </div>

            <div class="schedule-timer">
                <div class="schedule-countdown" data-schedule-countdown>—</div>
                <div class="schedule-next" data-schedule-next></div>
            </div>

            <div class="schedule-foot">
                <span class="schedule-status" data-schedule-status data-tone="ok">—</span>
                <span class="schedule-last" data-schedule-last></span>
                <button type="button" class="schedule-reload" data-schedule-reload hidden>New data published · Reload</button>
            </div>
        </li>
    `;
}


/* ============================================================
   INIT
   ============================================================ */

function tick() {
    const view = qs("#settings-view");

    if (!view || view.hidden) return;

    if (Date.now() - schedule.lastSourceCheck > REFRESH_SOURCES_MS) {
        refreshPublishedStamps();
    }

    render();
}

function initializeUpdateSchedule() {
    if (schedule.initialized) return;

    const list = qs("#update-schedule-list");

    if (!list) return;

    schedule.initialized = true;

    list.innerHTML = UPDATE_JOBS.map(rowMarkup).join("");

    list.addEventListener("click", event => {
        if (event.target.closest("[data-schedule-reload]")) {
            window.location.reload();
        }
    });

    // Re-check as soon as Settings is opened.
    const view = qs("#settings-view");

    if (view) {
        new MutationObserver(() => {
            if (!view.hidden) {
                refreshPublishedStamps();
                render();
            }
        }).observe(view, { attributes: true, attributeFilter: ["hidden"] });
    }

    schedule.timer = window.setInterval(tick, 1000);

    tick();
}


export {
    initializeUpdateSchedule,
    setLoadedUpdateTime,
    UPDATE_JOBS
};
