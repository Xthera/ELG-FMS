/* ELG FMS - CHARTS
 * ===================
 *
 * Optional Chart.js helpers.
 * The dashboard must remain functional even if Chart.js is unavailable.
 */

const chartRegistry = new Map();

function getChartConstructor() {
    return window.Chart ?? null;
}

function getCssVariable(name, fallback) {
    const value = getComputedStyle(document.documentElement)
        .getPropertyValue(name)
        .trim();

    return value || fallback;
}

function getThemeColors() {
    return {
        text: getCssVariable("--text-primary", "#f5f7fa"),
        muted: getCssVariable("--text-secondary", "#9aa4b2"),
        grid: getCssVariable("--border-subtle", "rgba(255,255,255,0.08)"),
        positive: getCssVariable("--positive", "#32c48d"),
        negative: getCssVariable("--negative", "#ef6b73"),
        accent: getCssVariable("--accent", "#4f8cff"),
        surface: getCssVariable("--bg-surface-raised", getCssVariable("--bg-surface", "#111827")),
        border: getCssVariable("--border-medium", "rgba(128,128,128,0.35)")
    };
}

/* ------------------------------------------------------------
 * COLOUR CODING FOR NEWS CHARTS
 *
 * - Importance uses a fixed status-style scale
 *   (High = red, Medium = amber, Low = grey).
 * - Category uses fixed slots for its known vocabulary.
 * - Asset class / geography / sector: each name keeps the
 *   colour it was first given (colour follows the item, not
 *   its rank), using the validated 8-colour series palette.
 *   A 9th+ name in the same chart falls back to grey.
 * ------------------------------------------------------------ */

const SERIES_SLOTS = 8;

const FIXED_COLOR_SLOTS = {
    Category: {
        MARKET: 0,
        ECONOMIC: 1,
        TECHNOLOGY: 2,
        GEOPOLITICAL: 3
    }
};

const colorAssignments = new Map();

function seriesColor(slot) {
    return getCssVariable(`--series-${slot + 1}`, "#3987e5");
}

/*
 * Assign a colour to every item shown in one chart.
 *
 * - Known categories keep their fixed slot.
 * - Other items keep the slot they had last time when it is
 *   still free, so colours stay stable across filter changes.
 * - Anything new takes the next free slot. A chart shows at
 *   most 8 items, so every bar always gets a colour.
 */
function colorsForItems(chartKey, names) {
    const fixed = FIXED_COLOR_SLOTS[chartKey] ?? {};

    if (!colorAssignments.has(chartKey)) {
        colorAssignments.set(chartKey, new Map());
    }

    const remembered = colorAssignments.get(chartKey);

    const slots = new Map();
    const used = new Set();

    // 1. fixed vocabulary
    for (const name of names) {
        if (Object.prototype.hasOwnProperty.call(fixed, name)) {
            slots.set(name, fixed[name]);
            used.add(fixed[name]);
        }
    }

    // 2. remembered slots that are still free
    for (const name of names) {
        if (slots.has(name)) continue;

        const previous = remembered.get(name);

        if (previous !== undefined && !used.has(previous)) {
            slots.set(name, previous);
            used.add(previous);
        }
    }

    // 3. next free slot for everything else
    for (const name of names) {
        if (slots.has(name)) continue;

        let slot = 0;

        while (used.has(slot) && slot < SERIES_SLOTS) slot += 1;

        slots.set(name, slot % SERIES_SLOTS);
        used.add(slot);
    }

    for (const [name, slot] of slots) {
        remembered.set(name, slot);
    }

    return names.map(name => seriesColor(slots.get(name)));
}

function importanceColor(name, colors) {
    const key = String(name).toUpperCase();

    if (key === "HIGH") return colors.negative;
    if (key === "MEDIUM") return getCssVariable("--series-4", "#c98500");

    return colors.muted;
}

/* Text-size multiplier chosen on the Settings page. */
function getFontScale() {
    const value = parseFloat(getCssVariable("--font-scale", "1"));

    return Number.isFinite(value) && value > 0 ? value : 1;
}

function getCanvas(canvasId) {
    return document.getElementById(canvasId);
}

function destroyChart(canvasId) {
    const chart = chartRegistry.get(canvasId);

    if (!chart) {
        return;
    }

    try {
        chart.destroy();
    } catch {
        // Ignore cleanup errors.
    }

    chartRegistry.delete(canvasId);
}

function destroyAllCharts() {
    for (const canvasId of chartRegistry.keys()) {
        destroyChart(canvasId);
    }
}

function createChart(canvasId, config) {
    const ChartConstructor = getChartConstructor();

    if (!ChartConstructor) {
        return null;
    }

    const canvas = getCanvas(canvasId);

    if (!canvas) {
        return null;
    }

    destroyChart(canvasId);

    // Slightly larger default chart text (axis labels, tooltips).
    if (ChartConstructor.defaults?.font) {
        ChartConstructor.defaults.font.size = Math.round(13 * getFontScale());
    }

    const chart = new ChartConstructor(canvas, config);

    chartRegistry.set(canvasId, chart);

    return chart;
}

function getBaseOptions() {
    const colors = getThemeColors();

    return {
        responsive: true,
        maintainAspectRatio: false,

        plugins: {
            legend: {
                labels: {
                    color: colors.text,
                    usePointStyle: true
                }
            },

            tooltip: {
                backgroundColor: colors.surface,
                titleColor: colors.text,
                bodyColor: colors.text,
                borderColor: colors.border,
                borderWidth: 1
            }
        },

        scales: {
            x: {
                ticks: {
                    color: colors.muted
                },

                grid: {
                    color: colors.grid
                }
            },

            y: {
                ticks: {
                    color: colors.muted
                },

                grid: {
                    color: colors.grid
                }
            }
        }
    };
}

function createPerformanceChart(
    canvasId,
    labels,
    winners,
    losers
) {
    if (!labels?.length) {
        return null;
    }

    const colors = getThemeColors();

    return createChart(canvasId, {
        type: "bar",

        data: {
            labels,

            datasets: [
                {
                    label: "Winners",
                    data: winners,
                    backgroundColor: colors.positive,
                    borderRadius: 4
                },

                {
                    label: "Losers",
                    data: losers,
                    backgroundColor: colors.negative,
                    borderRadius: 4
                }
            ]
        },

        options: getBaseOptions()
    });
}

function createPerformanceLineChart(
    canvasId,
    labels,
    values
) {
    if (!labels?.length) {
        return null;
    }

    const colors = getThemeColors();

    return createChart(canvasId, {
        type: "line",

        data: {
            labels,

            datasets: [
                {
                    label: "Performance",
                    data: values,
                    borderColor: colors.accent,
                    backgroundColor: colors.accent,
                    tension: 0.25,
                    pointRadius: 3
                }
            ]
        },

        options: getBaseOptions()
    });
}

function createNewsSentimentChart(
    canvasId,
    statistics
) {
    if (!statistics) {
        return null;
    }

    const colors = getThemeColors();

    /*
     * getNewsStatistics() returns flat lower-case counters
     * (positive / neutral / negative / mixed).
     */
    const labels = [
        "Positive",
        "Neutral",
        "Mixed",
        "Negative"
    ];

    const values = [
        statistics.positive ?? 0,
        statistics.neutral ?? 0,
        statistics.mixed ?? 0,
        statistics.negative ?? 0
    ];

    if (!values.some(value => value > 0)) {
        destroyChart(canvasId);
        return null;
    }

    /*
     * Horizontal bar chart in a fixed order, matching the
     * other news charts. Each bar keeps its sentiment colour;
     * the axis labels name the bars, so no legend is needed.
     */
    const base = getBaseOptions();

    return createChart(canvasId, {
        type: "bar",

        data: {
            labels,

            datasets: [
                {
                    label: "Articles",
                    data: values,

                    backgroundColor: [
                        colors.positive,
                        colors.muted,
                        getCssVariable("--series-4", "#c98500"),
                        colors.negative
                    ],

                    borderRadius: 4,
                    maxBarThickness: 22
                }
            ]
        },

        options: {
            ...base,

            indexAxis: "y",

            plugins: {
                ...base.plugins,

                legend: {
                    display: false
                }
            },

            scales: {
                ...base.scales,

                x: {
                    ...base.scales.x,

                    beginAtZero: true,

                    ticks: {
                        ...base.scales.x.ticks,
                        precision: 0
                    }
                }
            }
        }
    });
}

function createNewsCategoryChart(
    canvasId,
    statistics
) {
    return createNewsDistributionChart(
        canvasId,
        "Category",
        statistics?.categories
    );
}

function createNewsImportanceChart(
    canvasId,
    statistics
) {
    if (!statistics) {
        destroyChart(canvasId);
        return null;
    }

    /*
     * Fixed High -> Medium -> Low order (not sorted by count).
     */
    return createNewsDistributionChart(
        canvasId,
        "Importance",
        {
            High: statistics.high ?? 0,
            Medium: statistics.medium ?? 0,
            Low: statistics.low ?? 0
        },
        { keepOrder: true }
    );
}

function createNewsAssetClassChart(
    canvasId,
    statistics
) {
    return createNewsDistributionChart(
        canvasId,
        "Asset Class",
        statistics?.assetClasses
    );
}

function createNewsGeographyChart(
    canvasId,
    statistics
) {
    return createNewsDistributionChart(
        canvasId,
        "Geography",
        statistics?.geographies
    );
}

function createNewsSectorChart(
    canvasId,
    statistics
) {
    return createNewsDistributionChart(
        canvasId,
        "Sector",
        statistics?.sectors
    );
}

function createNewsDistributionChart(
    canvasId,
    label,
    source,
    { keepOrder = false, limit = 8 } = {}
) {
    if (!source) {
        destroyChart(canvasId);
        return null;
    }

    let entries = Array.isArray(source)
        ? source.map(item => [
            item.name ?? item.label ?? "Unknown",
            Number(item.value ?? item.count ?? 0)
        ])
        : Object.entries(source);

    /*
     * Largest first, top N only, so long lists stay readable.
     */
    if (!keepOrder) {
        entries = entries
            .sort((a, b) => Number(b[1]) - Number(a[1]))
            .slice(0, limit);
    }

    if (!entries.length || !entries.some(([, value]) => Number(value) > 0)) {
        destroyChart(canvasId);
        return null;
    }

    const colors = getThemeColors();

    return createChart(canvasId, {
        type: "bar",

        data: {
            labels: entries.map(([key]) => key),

            datasets: [
                {
                    label,
                    data: entries.map(([, value]) => Number(value) || 0),
                    backgroundColor: label === "Importance"
                        ? entries.map(([key]) => importanceColor(key, colors))
                        : colorsForItems(label, entries.map(([key]) => key)),
                    borderRadius: 4,
                    maxBarThickness: 22
                }
            ]
        },

        options: {
            ...getBaseOptions(),

            indexAxis: "y",

            plugins: {
                ...getBaseOptions().plugins,

                /* Bars are named on the axis; no legend needed. */
                legend: {
                    display: false
                }
            }
        }
    });
}

/*
 * Called when the dashboard theme changes.
 *
 * The existing chart instances are destroyed because their colours
 * are based on CSS variables. The application recreates the charts
 * after the theme change.
 */
function updateChartsForTheme() {
    destroyAllCharts();
}

function refreshChartsForTheme() {
    updateChartsForTheme();
}


/* ============================================================
   LINE MOTION
   New lines draw from left to right; removed lines fade out.
   Done with a clip window / transparency over the finished
   chart, so it stays smooth even with thousands of points.
   ============================================================ */

const motionReduced = () =>
    Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);

const lineMotionPlugin = {
    id: "zlLineMotion",

    beforeDatasetDraw(chart, args) {
        const state = chart.$zlMotion;
        if (!state) return;

        const ctx = chart.ctx;
        ctx.save();
        state.saved = (state.saved ?? 0) + 1;

        if (state.fade?.has(args.index)) {
            ctx.globalAlpha = state.alpha;
        }

        if (state.reveal?.has(args.index) && state.progress < 1) {
            const { left, right, top, bottom } = chart.chartArea;
            ctx.beginPath();
            ctx.rect(left - 4, top - 6, (right - left) * state.progress + 4, bottom - top + 12);
            ctx.clip();
        }
    },

    afterDatasetDraw(chart) {
        const state = chart.$zlMotion;
        if (state?.saved) {
            state.saved -= 1;
            chart.ctx.restore();
        }
    },

    afterDatasetsDraw(chart) {
        // Glowing pen tip at the front of each line being drawn
        const state = chart.$zlMotion;
        if (!state?.reveal || state.progress >= 1) return;

        const { left, right } = chart.chartArea;
        const x = left + (right - left) * state.progress;
        const ctx = chart.ctx;

        for (const index of state.reveal) {
            const meta = chart.getDatasetMeta(index);
            if (!meta || meta.hidden || !meta.data?.length) continue;

            let point = null;
            for (const element of meta.data) {
                if (element.skip || !Number.isFinite(element.y)) continue;
                if (element.x > x) break;
                point = element;
            }
            if (!point) continue;

            const color = chart.data.datasets[index]?.borderColor ?? "#ffffff";
            ctx.save();
            ctx.shadowColor = color;
            ctx.shadowBlur = 10;
            ctx.fillStyle = color;
            ctx.beginPath();
            ctx.arc(point.x, point.y, 3.5, 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();
        }
    }
};

function runChartMotion(chart, state, duration, step, done) {
    if (!chart || motionReduced()) {
        done?.();
        return;
    }

    chart.$zlMotion = state;
    const started = performance.now();

    const frame = now => {
        if (!chart.ctx || chart.$zlMotion !== state) return;   // destroyed or replaced

        const t = Math.min(1, (now - started) / duration);
        step(t);
        chart.draw();

        if (t < 1) {
            requestAnimationFrame(frame);
        } else {
            chart.$zlMotion = null;
            done?.();
        }
    };

    requestAnimationFrame(frame);
}

const easeInOut = t => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

/* Draw the given datasets (indexes) from start to end. */
function revealChartLines(chart, indexes, duration = 1200) {
    const reveal = new Set(indexes);
    if (!chart || !reveal.size) return;

    const state = { reveal, progress: 0 };
    runChartMotion(chart, state, duration, t => { state.progress = easeInOut(t); });
}

/* Fade the given datasets (indexes) away, then call done. */
function fadeChartLines(chart, indexes, done, duration = 320) {
    const fade = new Set(indexes);
    if (!chart || !fade.size) {
        done?.();
        return;
    }

    const state = { fade, alpha: 1 };
    runChartMotion(chart, state, duration, t => { state.alpha = 1 - t; }, done);
}

export {
    chartRegistry,
    lineMotionPlugin,
    revealChartLines,
    fadeChartLines,
    getFontScale,
    createChart,
    createPerformanceChart,
    createPerformanceLineChart,
    createNewsSentimentChart,
    createNewsCategoryChart,
    createNewsImportanceChart,
    createNewsAssetClassChart,
    createNewsGeographyChart,
    createNewsSectorChart,
    destroyChart,
    destroyAllCharts,
    updateChartsForTheme,
    refreshChartsForTheme
};
