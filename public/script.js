const REFRESH_INTERVAL_MS = 60_000;
const STALE_AFTER_MS = 15 * 60_000;
const SHEET_RAIN_REFRESH_INTERVAL_MS = 60 * 60_000;
const SHEET_RAIN_RETRY_DELAY_MS = 30_000;

// Visual scale caps for the rain jars — not measured maxima, just what reads
// as "nearly full" for a Sunnyvale day/month/season.
const RAIN_JAR_MAX_IN = { day: 1, month: 6, season: 15 };

// Gauge calibration: needle is vertical at "normal" relative pressure, 90deg
// of rotation per 1.25 inHg, clamped to +/-150deg so it can't wrap around.
const PRESSURE_MID_INHG = 29.92;
const PRESSURE_HALF_RANGE_INHG = 1.25;
const PRESSURE_MAX_ANGLE = 150;
const PRESSURE_TICK_DEGS = [-150, -75, 0, 75, 150];

// scaled against a typical clear-sky peak.
const SOLAR_MAX_WM2 = 1000;

const BANNER_NORMAL_SRC = "banner.jpg";
const BANNER_HEAT_SRC = "heatabnormal.png";
const HEAT_BANNER_THRESHOLD_F = 90;

// Temperature ring color, interpolated between stops (always keyed on raw °F
// so it doesn't shift when the unit toggle flips to Celsius).
const TEMP_COLOR_STOPS = [
    [15, [28, 92, 171]], // deep blue
    [30, [57, 135, 229]], // blue
    [45, [27, 175, 122]], // teal green
    [60, [252, 236, 3]], // yellow
    [75, [237, 161, 0]], // amber
    [90, [208, 59, 59]], // red
    [105, [181, 0, 131]], // magenta
];

const els = {
    statusLine: document.getElementById("status-line"),
    lastUpdated: document.getElementById("last-updated"),
    unitToggle: document.getElementById("unit-toggle"),
    refreshButton: document.getElementById("refresh-button"),
    banner: document.getElementById("banner"),
    dateStatus: document.getElementById("date-status"),
    datePrev: document.getElementById("date-prev"),
    dateNext: document.getElementById("date-next"),
    dateMonth: document.getElementById("date-month"),
    dateDay: document.getElementById("date-day"),
    dateYear: document.getElementById("date-year"),
    tiles: {
        temp: document.querySelector('[data-tile="temp"]'),
        wind: document.querySelector('[data-tile="wind"]'),
        pressure: document.querySelector('[data-tile="pressure"]'),
        rain: document.querySelector('[data-tile="rain"]'),
        solar: document.querySelector('[data-tile="solar"]'),
    },
};

const HISTORY_REFRESH_INTERVAL_MS = 5 * 60_000;

let useMetric = localStorage.getItem("units") === "metric";
let latest = null;
let readingAt = null;
let history = null;
let seasonRain = null;
let monthRain = null;

// The graphs' selected date — null means "today" (live, via `history`);
// otherwise a "YYYY-MM-DD" Pacific date string, backed by `dayHistory`.
let chartDate = null;
let dayHistory = null;

function fToC(f) {
    return (f - 32) * (5 / 9);
}

function inHgToHpa(inHg) {
    return inHg * 33.8639;
}

function inToMm(inches) {
    return inches * 25.4;
}

function mphToKmh(mph) {
    return mph * 1.60934;
}

function round(value, places = 1) {
    const factor = 10 ** places;
    return Math.round(value * factor) / factor;
}

// Unlike round(), always pads to the given number of decimal places (e.g.
// "5.0" not "5") so values don't visually jitter in width between renders.
function formatFixed(value, places) {
    return value.toFixed(places);
}

function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
}

function rgbToHex([r, g, b]) {
    return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

function tempColor(tempF) {
    const stops = TEMP_COLOR_STOPS;
    if (tempF <= stops[0][0]) return rgbToHex(stops[0][1]);
    if (tempF >= stops[stops.length - 1][0]) return rgbToHex(stops[stops.length - 1][1]);

    for (let i = 0; i < stops.length - 1; i++) {
        const [t0, c0] = stops[i];
        const [t1, c1] = stops[i + 1];
        if (tempF >= t0 && tempF <= t1) {
            const t = (tempF - t0) / (t1 - t0);
            const rgb = c0.map((v, idx) => Math.round(v + (c1[idx] - v) * t));
            return rgbToHex(rgb);
        }
    }
}

function setStatus(text, state) {
    els.statusLine.textContent = text;
    if (state) {
        els.statusLine.setAttribute("data-state", state);
    } else {
        els.statusLine.removeAttribute("data-state");
    }
}

function render() {
    if (!latest) return;

    const tempUnit = useMetric ? "°C" : "°F";
    const speedUnit = useMetric ? "km/h" : "mph";
    const pressureUnit = useMetric ? "hPa" : "inHg";
    const rainUnit = useMetric ? "mm" : "in";

    els.unitToggle.textContent = tempUnit;

    renderBanner();
    renderTemp(tempUnit);
    renderWind(speedUnit);
    renderPressure(pressureUnit);
    renderRain(rainUnit);
    renderSolar();
    renderCharts();

    updateLastUpdatedLabel();
}

// Always keyed on raw °F (like tempColor()) so it doesn't flip based on the
// display unit.
function renderBanner() {
    const isHeat = latest.tempf >= HEAT_BANNER_THRESHOLD_F;
    const targetSrc = isHeat ? BANNER_HEAT_SRC : BANNER_NORMAL_SRC;
    if (!els.banner.getAttribute("src").endsWith(targetSrc)) {
        els.banner.src = targetSrc;
        els.banner.alt = isHeat ? "Heat abnormal" : "Fog over the hills above Sunnyvale";
    }
}

function renderTemp(tempUnit) {
    const tile = els.tiles.temp;
    const temp = useMetric ? fToC(latest.tempf) : latest.tempf;
    const feelsLike = useMetric ? fToC(latest.feelsLike) : latest.feelsLike;
    const dewPoint = useMetric ? fToC(latest.dewPoint) : latest.dewPoint;

    tile.querySelector(".temp-ring .num").textContent = formatFixed(temp, 1);
    tile.querySelector(".temp-ring .unit").textContent = tempUnit;
    tile.querySelector(".temp-ring").style.setProperty("--temp-color", tempColor(latest.tempf));
    tile.querySelector(".humidity").textContent = `${round(latest.humidity, 0)}%`;
    tile.querySelector(".dew-point").textContent = `${formatFixed(dewPoint, 1)}${tempUnit}`;
    tile.querySelector(".feels-like strong").textContent = `${formatFixed(feelsLike, 1)}${tempUnit}`;

    renderYesterdayDelta(tile, tempUnit);
    renderTempRange(tile, tempUnit);
}

function renderYesterdayDelta(tile, tempUnit) {
    const el = tile.querySelector(".yesterday-delta");
    if (!history || typeof history.yesterdayTempF !== "number") {
        el.textContent = "–";
        return;
    }

    const diffF = latest.tempf - history.yesterdayTempF;
    const diffRaw = useMetric ? diffF * (5 / 9) : diffF;
    const diff = round(diffRaw);
    const arrow = diff > 0 ? "↑" : diff < 0 ? "↓" : "";
    el.textContent = `${arrow} ${formatFixed(Math.abs(diff), 1)}${tempUnit}`.trim();
}

function renderTempRange(tile, tempUnit) {
    setRangeRow(tile, "today", history?.todayLow, history?.todayHigh, tempUnit);

    // Only render the month row once the spreadsheet fetch has actually
    // succeeded at least once — otherwise this would silently collapse to
    // just today's (much narrower) range and look like a real month answer.
    if (!monthRain) {
        setRangeRow(tile, "month", null, null, tempUnit);
        return;
    }

    // Month range = spreadsheet's high/low through yesterday, widened by
    // today's own live high/low — same "spreadsheet through yesterday plus
    // today live" split used for month rain, for the same reason (avoids a
    // bad same-day spreadsheet row skewing the month). On the 1st of the
    // month there's no "through yesterday" data yet, so this naturally
    // collapses to just today's range, which is correct in that case.
    let monthLow = monthRain.monthLowThroughYesterdayF;
    let monthHigh = monthRain.monthHighThroughYesterdayF;
    if (typeof history?.todayLow === "number") {
        monthLow = typeof monthLow === "number" ? Math.min(monthLow, history.todayLow) : history.todayLow;
    }
    if (typeof history?.todayHigh === "number") {
        monthHigh = typeof monthHigh === "number" ? Math.max(monthHigh, history.todayHigh) : history.todayHigh;
    }
    setRangeRow(tile, "month", monthLow, monthHigh, tempUnit);
}

function setRangeRow(tile, range, lowF, highF, tempUnit) {
    const row = tile.querySelector(`.temp-range[data-range="${range}"]`);
    const lowEl = row.querySelector(".range-low");
    const highEl = row.querySelector(".range-high");

    if (typeof lowF !== "number" || typeof highF !== "number") {
        lowEl.textContent = "–";
        highEl.textContent = "–";
        return;
    }

    const low = useMetric ? fToC(lowF) : lowF;
    const high = useMetric ? fToC(highF) : highF;
    lowEl.textContent = `${formatFixed(low, 1)}${tempUnit}`;
    highEl.textContent = `${formatFixed(high, 1)}${tempUnit}`;
}

function renderWind(speedUnit) {
    const tile = els.tiles.wind;
    const windSpeed = useMetric ? mphToKmh(latest.windspeedmph) : latest.windspeedmph;
    const windGust = useMetric ? mphToKmh(latest.windgustmph) : latest.windgustmph;

    tile.querySelector(".num").textContent = round(windSpeed);
    tile.querySelector(".unit").textContent = speedUnit;
    tile.querySelector(".gust").textContent = `G ${round(windGust)} ${speedUnit}`;
    tile.querySelector(".compass").style.setProperty("--deg", `${latest.winddir}deg`);
}

function pressureAngleToInHg(deg) {
    return PRESSURE_MID_INHG + (deg / 90) * PRESSURE_HALF_RANGE_INHG;
}

function renderPressure(pressureUnit) {
    const tile = els.tiles.pressure;
    const pressure = useMetric ? inHgToHpa(latest.baromrelin) : latest.baromrelin;
    const angle = clamp(
        ((latest.baromrelin - PRESSURE_MID_INHG) / PRESSURE_HALF_RANGE_INHG) * 90,
        -PRESSURE_MAX_ANGLE,
        PRESSURE_MAX_ANGLE
    );

    const pressurePlaces = useMetric ? 0 : 2;
    tile.querySelector(".pressure-value .num").textContent = formatFixed(pressure, pressurePlaces);
    tile.querySelector(".pressure-value .unit").textContent = pressureUnit;
    tile.querySelector(".needle").style.setProperty("--deg", `${angle}deg`);

    for (const label of tile.pressureTickLabels) {
        const valueInHg = pressureAngleToInHg(label.deg);
        const value = useMetric ? inHgToHpa(valueInHg) : valueInHg;
        label.el.textContent = formatFixed(value, pressurePlaces);
    }
}

function renderRain(rainUnit) {
    const tile = els.tiles.rain;
    const jars = tile.querySelectorAll(".jar");

    setJar(jars[0], latest.dailyrainin, RAIN_JAR_MAX_IN.day, rainUnit);

    // Month total = spreadsheet sum through yesterday + today's live station
    // reading, rather than trusting the station's own running monthly total,
    // since the spreadsheet and station occasionally disagree after a
    // station hiccup.
    if (monthRain && typeof monthRain.monthToYesterdayIn === "number") {
        setJar(jars[1], monthRain.monthToYesterdayIn + latest.dailyrainin, RAIN_JAR_MAX_IN.month, rainUnit);
    }

    if (seasonRain && typeof seasonRain.seasonRainIn === "number") {
        setJar(jars[2], seasonRain.seasonRainIn, RAIN_JAR_MAX_IN.season, rainUnit);
    }
}

function setJar(jarEl, amountIn, maxIn, rainUnit) {
    const amount = useMetric ? inToMm(amountIn) : amountIn;
    const fillPercent = clamp((amountIn / maxIn) * 100, 4, 100);

    jarEl.querySelector(".jar-fill").style.setProperty("--fill", `${fillPercent}%`);
    jarEl.querySelector(".jar-value").textContent = `${formatFixed(amount, useMetric ? 1 : 2)} ${rainUnit}`;
}

function renderSolar() {
    const tile = els.tiles.solar;
    const corePercent = clamp((latest.solarradiation / SOLAR_MAX_WM2) * 100, 0, 100);

    tile.querySelector(".sun-core").style.setProperty("--core-size", `${corePercent}%`);
    tile.querySelector(".solar-value .num").textContent = round(latest.solarradiation, 0);

    const hoursEl = tile.querySelector(".sunshine-hours .num");
    hoursEl.textContent =
        history && typeof history.sunshineHours === "number" ? formatFixed(history.sunshineHours, 1) : "–";
}

// ---- History charts ----
// All six charts share one x-domain (today's Pacific day, from the history
// response) and read from the same `points` array, so a single generic
// renderer + hover/tooltip handler covers all of them.

const CHART_W = 600;
const CHART_PAD = { left: 36, right: 8, top: 10, bottom: 6 };

const clockFmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", hour: "numeric", minute: "2-digit" });
function formatClockTime(ms) {
    return clockFmt.format(new Date(ms));
}

function svgEl(tag, attrs) {
    const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
    return el;
}

// Pads the data's own min/max rather than using fixed scales (unlike the
// gauges above, which have a known physical range) — these are auto-scaled
// so a calm day's wind chart isn't all flat line at the bottom of a 0-40
// scale. minZero forces the floor to 0 for quantities that can't go negative.
function niceDomain(values, { minZero = false } = {}) {
    const nums = values.filter((v) => typeof v === "number" && !Number.isNaN(v));
    if (nums.length === 0) return [0, 1];
    const min = Math.min(...nums);
    const max = Math.max(...nums);
    if (minZero) return [0, max <= 0 ? 1 : max * 1.15];
    if (min === max) return [min - 1, max + 1];
    const pad = (max - min) * 0.15;
    return [min - pad, max + pad];
}

function autoTicks([lo, hi], count) {
    const ticks = [];
    for (let i = 0; i <= count; i++) ticks.push(lo + ((hi - lo) * i) / count);
    return ticks;
}

function renderXAxisLabels(xaxisEl) {
    if (!xaxisEl || xaxisEl.dataset.rendered) return;
    xaxisEl.dataset.rendered = "1";
    for (const label of ["12am", "6am", "12pm", "6pm", "12am"]) {
        const span = document.createElement("span");
        span.textContent = label;
        xaxisEl.appendChild(span);
    }
}

// Hover/touch crosshair + tooltip, bound once per chart and driven off
// whatever `wrapEl._chartState` the most recent render left behind — so a
// re-render just swaps the state the listener reads, no listener churn.
function ensureChartHover(wrapEl) {
    if (wrapEl.dataset.hoverBound) return;
    wrapEl.dataset.hoverBound = "1";
    const svg = wrapEl.querySelector(".chart-svg");
    const tooltip = wrapEl.querySelector(".chart-tooltip");

    function update(clientX) {
        const state = wrapEl._chartState;
        if (!state) return;
        const rect = svg.getBoundingClientRect();
        if (rect.width === 0) return;

        // The plotted data only spans [state.plotLeft, state.plotRight] of the
        // viewBox (the rest is the y-axis label gutter — wider on dual-axis
        // charts, which label both sides), so the cursor fraction has to be
        // measured against that inset range, not the full SVG width —
        // otherwise every lookup resolves to a later point than the cursor's
        // actual position.
        const localX = clamp(clientX - rect.left, 0, rect.width);
        const viewBoxX = (localX / rect.width) * CHART_W;
        const { plotLeft, plotRight } = state;
        const relX = clamp((viewBoxX - plotLeft) / (plotRight - plotLeft), 0, 1);
        const xValue = state.xDomain[0] + relX * (state.xDomain[1] - state.xDomain[0]);

        let nearest = null;
        let nearestDist = Infinity;
        for (const p of state.points) {
            const d = Math.abs(p.t - xValue);
            if (d < nearestDist) {
                nearestDist = d;
                nearest = p;
            }
        }
        if (!nearest) return;

        const px = state.scaleX(nearest.t);
        state.crosshair.setAttribute("x1", px);
        state.crosshair.setAttribute("x2", px);
        state.crosshair.removeAttribute("display");

        tooltip.innerHTML = "";
        const timeEl = document.createElement("div");
        timeEl.className = "tooltip-time";
        timeEl.textContent = formatClockTime(nearest.t);
        tooltip.appendChild(timeEl);

        for (const s of state.series) {
            const value = s.getValue(nearest);
            if (typeof value !== "number" || Number.isNaN(value)) continue;
            const format = s.format ?? state.yFormat;
            const row = document.createElement("div");
            row.className = "tooltip-row";
            const dot = document.createElement("span");
            dot.className = "tooltip-dot";
            dot.style.background = s.color;
            row.appendChild(dot);
            const text = document.createElement("span");
            text.textContent = s.label ? `${s.label}: ${format(value)}` : format(value);
            row.appendChild(text);
            tooltip.appendChild(row);
        }

        tooltip.hidden = false;
        const wrapWidth = wrapEl.clientWidth;
        const tooltipWidth = tooltip.offsetWidth;
        const pxReal = (px / CHART_W) * wrapWidth;
        let left = pxReal + 10;
        if (left + tooltipWidth > wrapWidth) left = pxReal - tooltipWidth - 10;
        tooltip.style.left = `${clamp(left, 0, Math.max(0, wrapWidth - tooltipWidth))}px`;
    }

    function hide() {
        tooltip.hidden = true;
        if (wrapEl._chartState) wrapEl._chartState.crosshair.setAttribute("display", "none");
    }

    svg.addEventListener("pointermove", (e) => update(e.clientX));
    svg.addEventListener("pointerdown", (e) => update(e.clientX));
    svg.addEventListener("pointerleave", hide);
}

const X_TICK_FRACTIONS = [0, 0.25, 0.5, 0.75, 1];

// Generic time-series renderer used by every chart below. `series` entries
// are { color, label, getValue(point), area?, mode?, format? }. Per-series
// `mode: "scatter"` (overriding the chart-level default) draws dots instead
// of a connected line — used for wind direction, which wraps at 0/360, and
// for wind gust, which reads as a gust event at a moment rather than a
// continuous quantity. `format` overrides the chart-level `yFormat` for that
// series' tooltip row only — used when series share one scale but not a
// unit (rain total vs. rate).
function renderTimeChart({
    wrapEl,
    xaxisEl,
    points,
    xDomain,
    series,
    height,
    yFormat,
    yAxisFormat,
    mode = "line",
    yDomain: yDomainOverride,
    yTicks: yTicksOverride,
    minZero = false,
}) {
    const svg = wrapEl.querySelector(".chart-svg");
    svg.setAttribute("viewBox", `0 0 ${CHART_W} ${height}`);
    while (svg.firstChild) svg.removeChild(svg.firstChild);

    const yDomain = yDomainOverride ?? niceDomain(points.flatMap((p) => series.map((s) => s.getValue(p))), { minZero });
    const axisFormat = yAxisFormat ?? yFormat;

    const plotLeft = CHART_PAD.left;
    const plotRight = CHART_W - CHART_PAD.right;
    const plotTop = CHART_PAD.top;
    const plotBottom = height - CHART_PAD.bottom;

    const scaleX = (t) => plotLeft + ((t - xDomain[0]) / (xDomain[1] - xDomain[0])) * (plotRight - plotLeft);
    const scaleY = (v) => plotBottom - ((v - yDomain[0]) / (yDomain[1] - yDomain[0])) * (plotBottom - plotTop);

    // Vertical gridlines at the same times the x-axis labels mark.
    for (const frac of X_TICK_FRACTIONS) {
        const x = plotLeft + frac * (plotRight - plotLeft);
        svg.appendChild(svgEl("line", { x1: x, x2: x, y1: plotTop, y2: plotBottom, class: "chart-grid-line" }));
    }

    const yTicks = yTicksOverride ?? autoTicks(yDomain, 4).map((v) => ({ value: v, label: axisFormat(v) }));
    for (const tick of yTicks) {
        const y = scaleY(tick.value);
        svg.appendChild(svgEl("line", { x1: plotLeft, x2: plotRight, y1: y, y2: y, class: "chart-grid-line" }));
        const text = svgEl("text", { x: 2, y: y + 3, class: "chart-axis-text" });
        text.textContent = tick.label;
        svg.appendChild(text);
    }

    for (const s of series) {
        const seriesMode = s.mode ?? mode;
        const pts = points
            .map((p) => ({ t: p.t, v: s.getValue(p) }))
            .filter((p) => typeof p.v === "number" && !Number.isNaN(p.v));
        if (pts.length === 0) continue;

        if (seriesMode === "scatter") {
            for (const p of pts) {
                const dot = svgEl("circle", { cx: scaleX(p.t), cy: scaleY(p.v), r: 2.4, class: "chart-scatter-dot" });
                dot.style.fill = s.color;
                svg.appendChild(dot);
            }
            continue;
        }

        if (s.area) {
            const baseline = scaleY(Math.max(yDomain[0], 0));
            let d = `M ${scaleX(pts[0].t)},${baseline}`;
            for (const p of pts) d += ` L ${scaleX(p.t)},${scaleY(p.v)}`;
            d += ` L ${scaleX(pts[pts.length - 1].t)},${baseline} Z`;
            const area = svgEl("path", { d, class: "chart-series-area" });
            area.style.fill = s.color;
            svg.appendChild(area);
        }

        let d = `M ${scaleX(pts[0].t)},${scaleY(pts[0].v)}`;
        for (const p of pts.slice(1)) d += ` L ${scaleX(p.t)},${scaleY(p.v)}`;
        const path = svgEl("path", { d, class: "chart-series-line", "vector-effect": "non-scaling-stroke" });
        path.style.stroke = s.color;
        svg.appendChild(path);
    }

    const crosshair = svgEl("line", {
        x1: plotLeft,
        x2: plotLeft,
        y1: plotTop,
        y2: plotBottom,
        class: "chart-crosshair",
        "vector-effect": "non-scaling-stroke",
        display: "none",
    });
    svg.appendChild(crosshair);

    wrapEl._chartState = { xDomain, points, series, scaleX, yFormat, crosshair, plotLeft, plotRight };
    ensureChartHover(wrapEl);

    renderXAxisLabels(xaxisEl);
}

function chartCard(name) {
    return document.querySelector(`.chart-card[data-chart="${name}"]`);
}

function clearAllCharts() {
    for (const svg of document.querySelectorAll(".chart-svg")) {
        while (svg.firstChild) svg.removeChild(svg.firstChild);
    }
}

// The graphs show either the live "today" data (chartDate === null, sourced
// from `history`, which keeps refreshing) or a specific past day picked via
// the date nav (sourced from the separately-fetched `dayHistory`).
function renderCharts() {
    const source = chartDate ? dayHistory : history;
    const points = source && Array.isArray(source.points) ? source.points : [];
    if (points.length === 0) {
        clearAllCharts();
        return;
    }
    const xDomain = [
        typeof source.dayStartMs === "number" ? source.dayStartMs : points[0].t,
        typeof source.dayEndMs === "number" ? source.dayEndMs : Date.now(),
    ];

    renderTempChart(points, xDomain);
    renderWindSpeedChart(points, xDomain);
    renderWindDirChart(points, xDomain);
    renderRainChart(points, xDomain);
    renderPressureChart(points, xDomain);
    renderSolarChart(points, xDomain);
}

function renderTempChart(points, xDomain) {
    const card = chartCard("temp");
    const tempUnit = useMetric ? "°C" : "°F";
    const convert = (f) => (useMetric ? fToC(f) : f);
    const series = [
        {
            color: "var(--chart-tertiary)",
            label: "Feels like",
            getValue: (p) => (typeof p.feelsLike === "number" ? convert(p.feelsLike) : null),
        },
        {
            color: "var(--chart-green)",
            label: "Dew point",
            getValue: (p) => (typeof p.dewPoint === "number" ? convert(p.dewPoint) : null),
        },
        { color: "var(--chart-red)", label: "Temp", getValue: (p) => (typeof p.tempf === "number" ? convert(p.tempf) : null) },
    ];
    renderTimeChart({
        wrapEl: card.querySelector(".chart-wrap"),
        xaxisEl: card.querySelector(".chart-xaxis"),
        points,
        xDomain,
        series,
        height: 180,
        yFormat: (v) => `${formatFixed(v, 1)}${tempUnit}`,
        yAxisFormat: (v) => `${formatFixed(v, 0)}°`,
    });
}

function renderWindSpeedChart(points, xDomain) {
    const card = chartCard("wind-speed");
    const speedUnit = useMetric ? "km/h" : "mph";
    const convert = (mph) => (useMetric ? mphToKmh(mph) : mph);
    const series = [
        {
            color: "var(--accent-rain)",
            label: "Speed",
            getValue: (p) => (typeof p.windspeedmph === "number" ? convert(p.windspeedmph) : null),
        },
        {
            color: "var(--chart-secondary)",
            label: "Gust",
            mode: "scatter",
            // A gust reading is a momentary event, not a continuous
            // quantity, so it's plotted as dots rather than a line — and a
            // flat 0 just means "no gust recorded," not "gust of 0 mph", so
            // it's left off the chart entirely.
            getValue: (p) => (typeof p.windgustmph === "number" && p.windgustmph > 0 ? convert(p.windgustmph) : null),
        },
    ];
    renderTimeChart({
        wrapEl: card.querySelector(".chart-wrap"),
        xaxisEl: card.querySelector(".chart-xaxis"),
        points,
        xDomain,
        series,
        height: 180,
        minZero: true,
        yFormat: (v) => `${round(v, 0)} ${speedUnit}`,
        yAxisFormat: (v) => `${round(v, 0)}`,
    });
}

const WIND_DIR_TICKS = [
    { value: 0, label: "N" },
    { value: 90, label: "E" },
    { value: 180, label: "S" },
    { value: 270, label: "W" },
    { value: 360, label: "N" },
];

function renderWindDirChart(points, xDomain) {
    const card = chartCard("wind-dir");
    const series = [
        { color: "var(--accent-rain)", label: "Direction", getValue: (p) => (typeof p.winddir === "number" ? p.winddir : null) },
    ];
    renderTimeChart({
        wrapEl: card.querySelector(".chart-wrap"),
        xaxisEl: card.querySelector(".chart-xaxis"),
        points,
        xDomain,
        series,
        height: 180,
        mode: "scatter",
        yDomain: [0, 360],
        yTicks: WIND_DIR_TICKS,
        yFormat: (v) => `${round(v, 0)}°`,
    });
}

function renderRainChart(points, xDomain) {
    const card = chartCard("rain");
    const rainUnit = useMetric ? "mm" : "in";
    const convert = (inches) => (useMetric ? inToMm(inches) : inches);
    const places = useMetric ? 1 : 2;

    // Total (cumulative for the day) and rate (in/hr at a moment) share one
    // scale despite the different units — each series still formats its own
    // tooltip row with its own unit via `format`.
    const series = [
        {
            color: "var(--chart-green-light)",
            label: "Rate",
            format: (v) => `${formatFixed(v, places)} ${rainUnit}/hr`,
            getValue: (p) => (typeof p.hourlyrainin === "number" ? convert(p.hourlyrainin) : null),
        },
        {
            color: "var(--accent-rain)",
            label: "Total",
            area: true,
            format: (v) => `${formatFixed(v, places)} ${rainUnit}`,
            getValue: (p) => (typeof p.dailyrainin === "number" ? convert(p.dailyrainin) : null),
        },
    ];

    renderTimeChart({
        wrapEl: card.querySelector(".chart-wrap"),
        xaxisEl: card.querySelector(".chart-xaxis"),
        points,
        xDomain,
        series,
        height: 180,
        minZero: true,
        yFormat: (v) => `${formatFixed(v, places)} ${rainUnit}`,
        yAxisFormat: (v) => formatFixed(v, places),
    });
}

function renderPressureChart(points, xDomain) {
    const card = chartCard("pressure");
    const pressureUnit = useMetric ? "hPa" : "inHg";
    const convert = (inHg) => (useMetric ? inHgToHpa(inHg) : inHg);
    const places = useMetric ? 0 : 2;
    // A day's pressure range is narrow enough that whole-number hPa ticks
    // (matching the main gauge's rounding) can collide on the auto-scaled
    // axis — one extra decimal here keeps the gridline labels distinct.
    const axisPlaces = useMetric ? 1 : 2;
    const series = [
        {
            color: "var(--text-primary)",
            label: "Pressure",
            // Round to the same precision shown elsewhere (2 places inHg, 0
            // hPa) before plotting — otherwise the line visibly jitters
            // between readings whose displayed/tooltip value never changes,
            // since the raw station reading carries more precision than
            // that.
            getValue: (p) => (typeof p.baromrelin === "number" ? round(convert(p.baromrelin), places) : null),
        },
    ];
    renderTimeChart({
        wrapEl: card.querySelector(".chart-wrap"),
        xaxisEl: card.querySelector(".chart-xaxis"),
        points,
        xDomain,
        series,
        height: 180,
        yFormat: (v) => `${formatFixed(v, places)} ${pressureUnit}`,
        yAxisFormat: (v) => formatFixed(v, axisPlaces),
    });
}

function renderSolarChart(points, xDomain) {
    const card = chartCard("solar");
    const series = [
        {
            color: "var(--accent-sun-core)",
            label: "Solar",
            area: true,
            getValue: (p) => (typeof p.solarradiation === "number" ? p.solarradiation : null),
        },
    ];
    renderTimeChart({
        wrapEl: card.querySelector(".chart-wrap"),
        xaxisEl: card.querySelector(".chart-xaxis"),
        points,
        xDomain,
        series,
        height: 180,
        minZero: true,
        yFormat: (v) => `${round(v, 0)} W/m²`,
        yAxisFormat: (v) => round(v, 0),
    });
}

function formatAgo(ms) {
    const seconds = Math.round(ms / 1000);
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.round(hours / 24);
    return `${days}d ago`;
}

function updateLastUpdatedLabel() {
    if (!readingAt) return;
    const age = Date.now() - readingAt;
    els.lastUpdated.textContent = `Station reading from ${formatAgo(age)}`;

    if (age > STALE_AFTER_MS) {
        setStatus("Station data looks stale — it hasn't reported recently.", "stale");
    }
}

async function fetchCurrent() {
    try {
        const res = await fetch("/api/current");
        if (!res.ok) throw new Error(`Request failed: ${res.status}`);
        const data = await res.json();
        if (!data || typeof data.tempf !== "number" || typeof data.dateutc !== "number") {
            throw new Error("Unexpected response shape");
        }
        latest = data;
        readingAt = data.dateutc;
        setStatus("");
        render();
    } catch (err) {
        console.error(err);
        setStatus("Unable to load weather data right now.", "error");
    }
}

async function fetchHistory() {
    try {
        const res = await fetch("/api/history");
        if (!res.ok) throw new Error(`Request failed: ${res.status}`);
        history = await res.json();
    } catch (err) {
        console.error(err);
        return;
    }
    if (latest) render();
}

async function fetchSeasonRain() {
    try {
        const res = await fetch("/api/season-rain");
        if (!res.ok) throw new Error(`Request failed: ${res.status}`);
        seasonRain = await res.json();
    } catch (err) {
        console.error(err);
        setTimeout(fetchSeasonRain, SHEET_RAIN_RETRY_DELAY_MS);
        return;
    }
    if (latest) render();
}

async function fetchMonthRain() {
    try {
        const res = await fetch("/api/month-rain");
        if (!res.ok) throw new Error(`Request failed: ${res.status}`);
        monthRain = await res.json();
    } catch (err) {
        console.error(err);
        setTimeout(fetchMonthRain, SHEET_RAIN_RETRY_DELAY_MS);
        return;
    }
    if (latest) render();
}

// ---- Graph date navigation ----
// The main dashboard tiles always mean "today" — only the graphs below are
// date-navigable. Picking a non-today date fetches that day's points into
// `dayHistory`, independent of the live `history` object `fetchHistory()`
// keeps refreshing; `renderCharts()` picks between them off `chartDate`.

function pacificDateParts(date) {
    const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Los_Angeles",
        year: "numeric",
        month: "numeric",
        day: "numeric",
    }).formatToParts(date);
    const get = (type) => Number(parts.find((p) => p.type === type).value);
    return { year: get("year"), month: get("month"), day: get("day") };
}

function daysInMonth(year, month) {
    // Date's month argument is 0-indexed, so passing the 1-indexed `month`
    // straight through points at the *next* month — day 0 of that rolls
    // back to the last day of the month actually being asked about.
    return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

// Normalizes via a Date object (so an out-of-range day/month, like day 0 or
// day 35, rolls over to the calendar date it actually means) before clamping
// to today — the day <select>'s own options are always valid, but this
// keeps the function correct for any input, not just ones the UI happens to
// produce.
function clampToToday(year, month, day) {
    const normalized = new Date(Date.UTC(year, month - 1, day, 12));
    const n = { year: normalized.getUTCFullYear(), month: normalized.getUTCMonth() + 1, day: normalized.getUTCDate() };

    const today = pacificDateParts(new Date());
    const pastToday =
        n.year > today.year ||
        (n.year === today.year && n.month > today.month) ||
        (n.year === today.year && n.month === today.month && n.day > today.day);
    return pastToday ? today : n;
}

const DATE_MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// The year <select> only has a fixed lookback window built in; this expands
// it on the fly if navigation (prev-day arrow) ever walks past it, rather
// than silently failing to select an out-of-range year.
function ensureYearOption(year) {
    if ([...els.dateYear.options].some((o) => Number(o.value) === year)) return;
    const today = pacificDateParts(new Date());
    const minYear = Math.min(year, today.year - 10);
    els.dateYear.innerHTML = "";
    for (let y = today.year; y >= minYear; y--) {
        const opt = document.createElement("option");
        opt.value = String(y);
        opt.textContent = String(y);
        els.dateYear.appendChild(opt);
    }
}

function populateDaySelect(year, month, selectedDay) {
    const numDays = daysInMonth(year, month);
    els.dateDay.innerHTML = "";
    for (let d = 1; d <= numDays; d++) {
        const opt = document.createElement("option");
        opt.value = String(d);
        opt.textContent = String(d);
        els.dateDay.appendChild(opt);
    }
    els.dateDay.value = String(Math.min(selectedDay, numDays));
}

function setDateControls(year, month, day) {
    ensureYearOption(year);
    els.dateYear.value = String(year);
    els.dateMonth.value = String(month);
    populateDaySelect(year, month, day);
}

function selectedDateFromControls() {
    return {
        year: Number(els.dateYear.value),
        month: Number(els.dateMonth.value),
        day: Number(els.dateDay.value),
    };
}

function setDateStatus(text, state) {
    els.dateStatus.textContent = text;
    if (state) {
        els.dateStatus.setAttribute("data-state", state);
    } else {
        els.dateStatus.removeAttribute("data-state");
    }
}

function applyDateChange(year, month, day) {
    // Re-validate/re-sync the controls every time (not just on direct
    // input) since a day that was valid for the old month/year — or past
    // today — might not be anymore (e.g. switching from Jan 31 to Feb, or
    // the next-day arrow walking past today).
    const clamped = clampToToday(year, month, day);
    setDateControls(clamped.year, clamped.month, clamped.day);

    const today = pacificDateParts(new Date());
    const isToday = clamped.year === today.year && clamped.month === today.month && clamped.day === today.day;
    els.dateNext.disabled = isToday;

    if (isToday) {
        chartDate = null;
        dayHistory = null;
        setDateStatus("");
        if (latest) render();
        return;
    }

    const dateString = `${clamped.year}-${String(clamped.month).padStart(2, "0")}-${String(clamped.day).padStart(2, "0")}`;
    chartDate = dateString;
    fetchDayHistory(dateString);
}

function shiftChartDate(deltaDays) {
    const { year, month, day } = selectedDateFromControls();
    // Noon UTC sidesteps any DST-boundary ambiguity from just adding a day.
    const base = new Date(Date.UTC(year, month - 1, day, 12));
    base.setUTCDate(base.getUTCDate() + deltaDays);
    applyDateChange(base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate());
}

async function fetchDayHistory(dateString) {
    setDateStatus(`Loading ${dateString}…`);
    try {
        const res = await fetch(`/api/history?date=${dateString}`);
        if (!res.ok) throw new Error(`Request failed: ${res.status}`);
        const data = await res.json();
        if (chartDate !== dateString) return; // superseded by a newer selection
        dayHistory = data;
        setDateStatus(Array.isArray(data.points) && data.points.length > 0 ? "" : "No data available for that day.");
        if (latest) render();
    } catch (err) {
        console.error(err);
        if (chartDate !== dateString) return;
        dayHistory = null;
        setDateStatus("Unable to load that day's data.", "error");
        if (latest) render();
    }
}

function initDateNav() {
    const today = pacificDateParts(new Date());

    DATE_MONTH_NAMES.forEach((name, i) => {
        const opt = document.createElement("option");
        opt.value = String(i + 1);
        opt.textContent = name;
        els.dateMonth.appendChild(opt);
    });

    for (let y = today.year; y >= today.year - 10; y--) {
        const opt = document.createElement("option");
        opt.value = String(y);
        opt.textContent = String(y);
        els.dateYear.appendChild(opt);
    }

    setDateControls(today.year, today.month, today.day);
    els.dateNext.disabled = true;

    els.datePrev.addEventListener("click", () => shiftChartDate(-1));
    els.dateNext.addEventListener("click", () => shiftChartDate(1));
    for (const select of [els.dateYear, els.dateMonth, els.dateDay]) {
        select.addEventListener("change", () => {
            const { year, month, day } = selectedDateFromControls();
            applyDateChange(year, month, day);
        });
    }
}

els.unitToggle.addEventListener("click", () => {
    useMetric = !useMetric;
    localStorage.setItem("units", useMetric ? "metric" : "imperial");
    render();
});

els.refreshButton.addEventListener("click", () => {
    fetchCurrent();
});

function addTickLabels(ringEl, labels) {
    return Object.entries(labels).map(([deg, text]) => {
        const wrap = document.createElement("span");
        wrap.className = "tick-label";
        wrap.style.setProperty("--tick-deg", `${deg}deg`);
        const inner = document.createElement("span");
        inner.textContent = text;
        wrap.appendChild(inner);
        ringEl.appendChild(wrap);
        return { deg: Number(deg), el: inner };
    });
}

// Minor + major tick marks over an arbitrary arc (used for the pressure
// gauge, which only swings +/-150deg and shouldn't tick the unused rest of
// the circle the way the wind compass does).
function addTickMarks(ringEl, { fromDeg, toDeg, minorStep, majorDegs }) {
    const majors = new Set(majorDegs);
    for (let deg = fromDeg; deg <= toDeg; deg += minorStep) {
        const tick = document.createElement("span");
        tick.className = majors.has(deg) ? "tick-mark tick-major" : "tick-mark";
        tick.style.setProperty("--tick-deg", `${deg}deg`);
        ringEl.appendChild(tick);
    }
}

addTickLabels(els.tiles.wind.querySelector(".wind-ring"), { 0: "N", 90: "E", 180: "S", 270: "W" });

const pressureRing = els.tiles.pressure.querySelector(".pressure-ring");
addTickMarks(pressureRing, {
    fromDeg: -PRESSURE_MAX_ANGLE,
    toDeg: PRESSURE_MAX_ANGLE,
    minorStep: 10,
    majorDegs: PRESSURE_TICK_DEGS,
});
els.tiles.pressure.pressureTickLabels = addTickLabels(
    pressureRing,
    Object.fromEntries(PRESSURE_TICK_DEGS.map((deg) => [deg, ""]))
);

initDateNav();

// Staggered so the two initial requests don't land in the same second and
// trip Ambient Weather's per-second rate limit.
fetchCurrent();
setTimeout(fetchHistory, 1500);
fetchSeasonRain();
fetchMonthRain();
setInterval(fetchCurrent, REFRESH_INTERVAL_MS);
setInterval(fetchHistory, HISTORY_REFRESH_INTERVAL_MS);
setInterval(fetchSeasonRain, SHEET_RAIN_REFRESH_INTERVAL_MS);
setInterval(fetchMonthRain, SHEET_RAIN_REFRESH_INTERVAL_MS);
setInterval(updateLastUpdatedLabel, 1000);
