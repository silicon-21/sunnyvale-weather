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
    dateStatus: document.getElementById("date-status"),
    datePrev: document.getElementById("date-prev"),
    dateNext: document.getElementById("date-next"),
    dateToday: document.getElementById("date-today"),
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
    const tempUnit = useMetric ? "°C" : "°F";
    const speedUnit = useMetric ? "km/h" : "mph";
    const pressureUnit = useMetric ? "hPa" : "inHg";
    const rainUnit = useMetric ? "mm" : "in";

    els.unitToggle.textContent = tempUnit;

    renderBanner(latest?.tempf);
    renderTemp(tempUnit);
    renderWind(speedUnit);
    renderPressure(pressureUnit);
    renderRain(rainUnit);
    renderSolar();
    renderCharts();

    updateLastUpdatedLabel();
}

// Each field is checked individually, not just `latest` as a whole — a
// console that's lost radio contact with the outdoor sensor array still
// reports baromrelin (see fetchCurrent), so `latest` can be a real, fresh
// object missing tempf/humidity/etc. specifically.
function renderTemp(tempUnit) {
    const tile = els.tiles.temp;
    const hasTemp = typeof latest?.tempf === "number";
    const temp = hasTemp ? (useMetric ? fToC(latest.tempf) : latest.tempf) : null;
    const hasFeelsLike = typeof latest?.feelsLike === "number";
    const feelsLike = hasFeelsLike ? (useMetric ? fToC(latest.feelsLike) : latest.feelsLike) : null;
    const hasDewPoint = typeof latest?.dewPoint === "number";
    const dewPoint = hasDewPoint ? (useMetric ? fToC(latest.dewPoint) : latest.dewPoint) : null;

    tile.querySelector(".temp-ring .num").textContent = hasTemp ? formatFixed(temp, 1) : "–";
    tile.querySelector(".temp-ring .unit").textContent = tempUnit;
    tile.querySelector(".temp-ring").style.setProperty("--temp-color", hasTemp ? tempColor(latest.tempf) : "var(--text-muted)");
    tile.querySelector(".humidity").textContent = typeof latest?.humidity === "number" ? `${round(latest.humidity, 0)}%` : "–";
    tile.querySelector(".dew-point").textContent = hasDewPoint ? `${formatFixed(dewPoint, 1)}${tempUnit}` : "–";
    tile.querySelector(".feels-like strong").textContent = hasFeelsLike ? `${formatFixed(feelsLike, 1)}${tempUnit}` : "–";

    renderYesterdayDelta(tile, tempUnit);
    renderTempRange(tile, tempUnit);
}

function renderYesterdayDelta(tile, tempUnit) {
    const el = tile.querySelector(".yesterday-delta");
    if (typeof latest?.tempf !== "number" || !history || typeof history.yesterdayTempF !== "number") {
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
    // Month range = spreadsheet's high/low through yesterday, widened by
    // today's own live high/low — same "spreadsheet through yesterday plus
    // today live" split used for month rain, for the same reason (avoids a
    // bad same-day spreadsheet row skewing the month). On the 1st of the
    // month there's no "through yesterday" data yet, so this naturally
    // collapses to just today's range, which is correct in that case.
    let monthLow = null;
    let monthHigh = null;
    if (monthRain) {
        monthLow = monthRain.monthLowThroughYesterdayF;
        monthHigh = monthRain.monthHighThroughYesterdayF;
        if (typeof history?.todayLow === "number") {
            monthLow = typeof monthLow === "number" ? Math.min(monthLow, history.todayLow) : history.todayLow;
        }
        if (typeof history?.todayHigh === "number") {
            monthHigh = typeof monthHigh === "number" ? Math.max(monthHigh, history.todayHigh) : history.todayHigh;
        }
    }

    // Today's bar is scaled and positioned within the month's range once
    // that's known, so it reads as "today sits here within the month" —
    // until then (the spreadsheet-backed month data loads later than
    // today's live reading) it just stays at its initial full width rather
    // than flash a scaled bar with nothing yet to scale against. The month
    // row itself is never scaled — it's always the full-width reference.
    const scale =
        typeof monthLow === "number" && typeof monthHigh === "number" && monthHigh > monthLow
            ? { min: monthLow, max: monthHigh }
            : null;
    setRangeRow(tile, "today", history?.todayLow, history?.todayHigh, tempUnit, scale);

    // Only render the month row once the spreadsheet fetch has actually
    // succeeded at least once — otherwise this would silently collapse to
    // just today's (much narrower) range and look like a real month answer.
    setRangeRow(tile, "month", monthRain ? monthLow : null, monthRain ? monthHigh : null, tempUnit, null);
}

function setRangeRow(tile, range, lowF, highF, tempUnit, scale) {
    const row = tile.querySelector(`.temp-range[data-range="${range}"]`);
    const bar = row.querySelector(".range-bar");
    const lowEl = row.querySelector(".range-low");
    const highEl = row.querySelector(".range-high");
    // Reset any previous collision nudge before re-measuring below — stale
    // offsets would otherwise throw off this render's overlap check.
    lowEl.style.transform = "";
    highEl.style.transform = "";

    if (typeof lowF !== "number" || typeof highF !== "number") {
        lowEl.textContent = "–";
        highEl.textContent = "–";
        bar.style.removeProperty("--range-left");
        bar.style.removeProperty("--range-right");
        return;
    }

    const low = useMetric ? fToC(lowF) : lowF;
    const high = useMetric ? fToC(highF) : highF;
    lowEl.textContent = `${formatFixed(low, 1)}${tempUnit}`;
    highEl.textContent = `${formatFixed(high, 1)}${tempUnit}`;

    if (scale) {
        const span = scale.max - scale.min;
        bar.style.setProperty("--range-left", `${clamp(((lowF - scale.min) / span) * 100, 0, 100)}%`);
        bar.style.setProperty("--range-right", `${clamp(((scale.max - highF) / span) * 100, 0, 100)}%`);
    } else {
        bar.style.removeProperty("--range-left");
        bar.style.removeProperty("--range-right");
    }

    separateRangeLabels(lowEl, highEl);
}

// When today's range is scaled down to a narrow sliver of the month's bar,
// the low/high labels (each anchored to its own edge of that sliver) can end
// up close enough to collide. Nudges them apart by half the overlap each, in
// opposite directions, so both stay readable without moving the tick marks
// they label.
function separateRangeLabels(lowEl, highEl) {
    const lowRect = lowEl.getBoundingClientRect();
    const highRect = highEl.getBoundingClientRect();
    const overlap = lowRect.right - highRect.left;
    if (overlap <= 0) return;

    const push = overlap / 2 + 3;
    lowEl.style.transform = `translateX(-${push}px)`;
    highEl.style.transform = `translateX(${push}px)`;
}

function renderWind(speedUnit) {
    const tile = els.tiles.wind;
    const hasSpeed = typeof latest?.windspeedmph === "number";
    const windSpeed = hasSpeed ? (useMetric ? mphToKmh(latest.windspeedmph) : latest.windspeedmph) : null;
    const hasGust = typeof latest?.windgustmph === "number";
    const windGust = hasGust ? (useMetric ? mphToKmh(latest.windgustmph) : latest.windgustmph) : null;

    tile.querySelector(".num").textContent = hasSpeed ? round(windSpeed) : "–";
    tile.querySelector(".unit").textContent = speedUnit;
    tile.querySelector(".gust").textContent = hasGust ? `G ${round(windGust)} ${speedUnit}` : `G – ${speedUnit}`;
    // Missing winddir just leaves the compass arrow at its last known
    // position rather than snapping it to a misleading 0deg.
    if (typeof latest?.winddir === "number") {
        tile.querySelector(".compass").style.setProperty("--deg", `${latest.winddir}deg`);
    }
}

function pressureAngleToInHg(deg) {
    return PRESSURE_MID_INHG + (deg / 90) * PRESSURE_HALF_RANGE_INHG;
}

function renderPressure(pressureUnit) {
    const tile = els.tiles.pressure;
    const hasPressure = typeof latest?.baromrelin === "number";
    const pressurePlaces = useMetric ? 0 : 2;

    if (hasPressure) {
        const pressure = useMetric ? inHgToHpa(latest.baromrelin) : latest.baromrelin;
        const angle = clamp(
            ((latest.baromrelin - PRESSURE_MID_INHG) / PRESSURE_HALF_RANGE_INHG) * 90,
            -PRESSURE_MAX_ANGLE,
            PRESSURE_MAX_ANGLE
        );
        tile.querySelector(".pressure-value .num").textContent = formatFixed(pressure, pressurePlaces);
        tile.querySelector(".needle").style.setProperty("--deg", `${angle}deg`);
    } else {
        tile.querySelector(".pressure-value .num").textContent = "–";
    }
    tile.querySelector(".pressure-value .unit").textContent = pressureUnit;

    for (const label of tile.pressureTickLabels) {
        const valueInHg = pressureAngleToInHg(label.deg);
        const value = useMetric ? inHgToHpa(valueInHg) : valueInHg;
        label.el.textContent = formatFixed(value, pressurePlaces);
    }
}

function renderRain(rainUnit) {
    const tile = els.tiles.rain;
    const jars = tile.querySelectorAll(".jar");
    const hasDaily = typeof latest?.dailyrainin === "number";

    if (hasDaily) {
        setJar(jars[0], latest.dailyrainin, RAIN_JAR_MAX_IN.day, rainUnit);
    } else {
        clearJar(jars[0]);
    }

    // Month total = spreadsheet sum through yesterday + today's live station
    // reading, rather than trusting the station's own running monthly total,
    // since the spreadsheet and station occasionally disagree after a
    // station hiccup. Today's own contribution just drops out (treated as 0)
    // when the live reading is unavailable, rather than blocking the whole
    // jar on it.
    if (monthRain && typeof monthRain.monthToYesterdayIn === "number") {
        setJar(jars[1], monthRain.monthToYesterdayIn + (hasDaily ? latest.dailyrainin : 0), RAIN_JAR_MAX_IN.month, rainUnit);
    }

    if (seasonRain && typeof seasonRain.seasonRainIn === "number") {
        setJar(jars[2], seasonRain.seasonRainIn, RAIN_JAR_MAX_IN.season, rainUnit);
    }
}

function clearJar(jarEl) {
    jarEl.querySelector(".jar-fill").style.setProperty("--fill", "4%");
    jarEl.querySelector(".jar-value").textContent = "–";
}

function setJar(jarEl, amountIn, maxIn, rainUnit) {
    const amount = useMetric ? inToMm(amountIn) : amountIn;
    const fillPercent = clamp((amountIn / maxIn) * 100, 4, 100);

    jarEl.querySelector(".jar-fill").style.setProperty("--fill", `${fillPercent}%`);
    jarEl.querySelector(".jar-value").textContent = `${formatFixed(amount, useMetric ? 1 : 2)} ${rainUnit}`;
}

function renderSolar() {
    const tile = els.tiles.solar;
    const hasSolar = typeof latest?.solarradiation === "number";
    const corePercent = hasSolar ? clamp((latest.solarradiation / SOLAR_MAX_WM2) * 100, 0, 100) : 0;

    tile.querySelector(".sun-core").style.setProperty("--core-size", `${corePercent}%`);
    tile.querySelector(".solar-value .num").textContent = hasSolar ? round(latest.solarradiation, 0) : "–";

    const hoursEl = tile.querySelector(".sunshine-hours .num");
    hoursEl.textContent =
        history && typeof history.sunshineHours === "number" ? formatFixed(history.sunshineHours, 1) : "–";
}

// ---- History charts ----
// All six charts share one x-domain (today's Pacific day, from the history
// response) and read from the same `points` array, so a single generic
// renderer + hover/tooltip handler (both in chart.js, shared with the
// forecast page's hourly charts) covers all of them.

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
        if (!res.ok) throw new Error(`Request failed: ${res.status} ${res.body}`);
        const data = await res.json();
        // baromrelin is measured by the console itself, so it's still
        // reported even when the console has lost radio contact with the
        // outdoor sensor array (which is exactly when tempf and the rest go
        // missing) — a far more reliable "is the station still reporting at
        // all" signal than tempf.
        if (!data || typeof data.baromrelin !== "number" || typeof data.dateutc !== "number") {
            throw new Error("Unexpected response shape");
        }
        latest = data;
        readingAt = data.dateutc;
        setStatus("");
    } catch (err) {
        console.error(err);
        setStatus("Unable to load weather data right now.", "error");
    }
    // Always re-render, success or failure — the charts below come from
    // /api/history independently of this fetch, and the tiles above degrade
    // to "–" placeholders on their own rather than leaving the whole page
    // stuck on its initial state.
    render();
}

async function fetchHistory() {
    try {
        const res = await fetch("/api/history");
        if (!res.ok) throw new Error(`Request failed: ${res.status} ${res.body}`);
        history = await res.json();
    } catch (err) {
        console.error(err);
        return;
    }
    render();
}

async function fetchSeasonRain() {
    try {
        const res = await fetch("/api/season-rain");
        if (!res.ok) throw new Error(`Request failed: ${res.status} ${res.body}`);
        seasonRain = await res.json();
    } catch (err) {
        console.error(err);
        setTimeout(fetchSeasonRain, SHEET_RAIN_RETRY_DELAY_MS);
        return;
    }
    render();
}

async function fetchMonthRain() {
    try {
        const res = await fetch("/api/month-rain");
        if (!res.ok) throw new Error(`Request failed: ${res.status} ${res.body}`);
        monthRain = await res.json();
    } catch (err) {
        console.error(err);
        setTimeout(fetchMonthRain, SHEET_RAIN_RETRY_DELAY_MS);
        return;
    }
    render();
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
    els.dateToday.disabled = isToday;

    if (isToday) {
        chartDate = null;
        dayHistory = null;
        setDateStatus("");
        render();
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

function goToToday() {
    const today = pacificDateParts(new Date());
    applyDateChange(today.year, today.month, today.day);
}

async function fetchDayHistory(dateString) {
    setDateStatus(`Loading ${dateString}…`);
    try {
        const res = await fetch(`/api/history?date=${dateString}`);
        if (!res.ok) throw new Error(`Request failed: ${res.status} ${res.body}`);
        const data = await res.json();
        if (chartDate !== dateString) return; // superseded by a newer selection
        dayHistory = data;
        setDateStatus(Array.isArray(data.points) && data.points.length > 0 ? "" : "No data available for that day.");
        render();
    } catch (err) {
        console.error(err);
        if (chartDate !== dateString) return;
        dayHistory = null;
        setDateStatus("Unable to load that day's data.", "error");
        render();
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
    els.dateToday.disabled = true;

    els.datePrev.addEventListener("click", () => shiftChartDate(-1));
    els.dateNext.addEventListener("click", () => shiftChartDate(1));
    els.dateToday.addEventListener("click", goToToday);
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
