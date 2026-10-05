/* VGRAT FMS - CHARTS
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
        grid: getCssVariable("--border", "rgba(255,255,255,0.08)"),
        positive: getCssVariable("--positive", "#32c48d"),
        negative: getCssVariable("--negative", "#ef6b73"),
        accent: getCssVariable("--accent", "#4f8cff"),
        surface: getCssVariable("--surface", "#111827")
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

function colorForItem(chartKey, name) {
    const fixed = FIXED_COLOR_SLOTS[chartKey];

    if (fixed && Object.prototype.hasOwnProperty.call(fixed, name)) {
        return seriesColor(fixed[name]);
    }

    if (!colorAssignments.has(chartKey)) {
        colorAssignments.set(chartKey, new Map());
    }

    const assigned = colorAssignments.get(chartKey);

    if (!assigned.has(name)) {
        const fixedCount = fixed ? Object.keys(fixed).length : 0;
        const slot = fixedCount + assigned.size;

        assigned.set(name, slot < SERIES_SLOTS ? slot : null);
    }

    const slot = assigned.get(name);

    return slot === null
        ? getCssVariable("--text-faint", "#566572")
        : seriesColor(slot);
}

function importanceColor(name, colors) {
    const key = String(name).toUpperCase();

    if (key === "HIGH") return colors.negative;
    if (key === "MEDIUM") return getCssVariable("--series-4", "#c98500");

    return colors.muted;
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
                borderColor: colors.grid,
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
                    backgroundColor: entries.map(([key]) =>
                        label === "Importance"
                            ? importanceColor(key, colors)
                            : colorForItem(label, key)
                    ),
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

export {
    chartRegistry,
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
