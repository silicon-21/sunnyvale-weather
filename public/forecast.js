const REFRESH_INTERVAL_MS = 10 * 60_000;
// Matches the dashboard's own refresh cadence so both tabs flip the banner
// at roughly the same time, off the same live station reading.
const CURRENT_REFRESH_INTERVAL_MS = 60_000;

const BANNER_NORMAL_SRC = "banner.jpg";
const BANNER_HEAT_SRC = "heatabnormal.png";
const HEAT_BANNER_THRESHOLD_F = 90;

// Same stops as the dashboard's temperature ring, so a forecast high reads
// as the same color a live reading of that temperature would.
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
    alertsSection: document.getElementById("alerts-section"),
    forecastDays: document.getElementById("forecast-days"),
    forecastDaysScroll: document.querySelector(".forecast-days-scroll"),
    forecastDaysPrev: document.getElementById("forecast-days-prev"),
    forecastDaysNext: document.getElementById("forecast-days-next"),
    forecastDetail: document.getElementById("forecast-detail"),
    banner: document.getElementById("banner"),
};

let useMetric = localStorage.getItem("units") === "metric";
let forecast = null;

// The day currently shown in the detail panel below the day tiles — a
// "YYYY-MM-DD" key from groupPeriodsByDay, null until the first fetch picks
// the first group as the default.
let selectedDayKey = null;

function fToC(f) {
    return (f - 32) * (5 / 9);
}

function round(value, places = 1) {
    const factor = 10 ** places;
    return Math.round(value * factor) / factor;
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

// Mirrors the dashboard's own banner swap, off the same live station
// reading — kept independent of the forecast fetch/render cycle so a slow
// or failed NWS request never holds up the banner, and vice versa.
function renderBanner(tempf) {
    const isHeat = tempf >= HEAT_BANNER_THRESHOLD_F;
    const targetSrc = isHeat ? BANNER_HEAT_SRC : BANNER_NORMAL_SRC;
    if (!els.banner.getAttribute("src").endsWith(targetSrc)) {
        els.banner.src = targetSrc;
        els.banner.alt = isHeat ? "Heat abnormal" : "Fog over the hills above Sunnyvale";
    }
}

async function fetchCurrentForBanner() {
    try {
        const res = await fetch("/api/current");
        if (!res.ok) return;
        const data = await res.json();
        if (typeof data?.tempf === "number") renderBanner(data.tempf);
    } catch (err) {
        // Non-critical — banner just stays on whatever it was last set to.
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

function formatAgo(ms) {
    const seconds = Math.round(ms / 1000);
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.round(minutes / 60);
    return `${Math.round(hours)}h ago`;
}

function severityColorVar(severity) {
    return severity === "Extreme" || severity === "Severe" ? "var(--status-critical)" : "var(--status-warning)";
}

function renderAlerts() {
    const alerts = forecast?.alerts ?? [];
    els.alertsSection.innerHTML = "";
    els.alertsSection.hidden = alerts.length === 0;

    for (const alert of alerts) {
        const card = document.createElement("article");
        card.className = "alert-card";
        card.style.setProperty("--alert-color", severityColorVar(alert.severity));

        const heading = document.createElement("h3");
        heading.textContent = alert.event;
        card.appendChild(heading);

        const area = document.createElement("p");
        area.className = "alert-area";
        area.textContent = alert.areaDesc;
        card.appendChild(area);

        const headline = document.createElement("p");
        headline.className = "alert-headline";
        headline.textContent = alert.headline;
        card.appendChild(headline);

        if (alert.description) {
            const details = document.createElement("details");
            const summary = document.createElement("summary");
            summary.textContent = "Details";
            details.appendChild(summary);
            const detail = document.createElement("p");
            detail.className = "alert-detail";
            detail.textContent = [alert.description, alert.instruction].filter(Boolean).join("\n\n");
            details.appendChild(detail);
            card.appendChild(details);
        }

        els.alertsSection.appendChild(card);
    }
}

// NWS's startTime/endTime strings already carry the forecast office's local
// UTC offset (Pacific, for us), so the date portion of startTime is already
// the right local calendar date — no timezone math needed to group periods
// by day. A leading night-only period (e.g. "Tonight", once today's daytime
// period has passed) naturally ends up as a group with only a nightPeriod.
function groupPeriodsByDay(periods) {
    const groups = [];
    const byKey = new Map();
    for (const period of periods) {
        const dateKey = period.startTime.slice(0, 10);
        let group = byKey.get(dateKey);
        if (!group) {
            group = { dateKey, dayPeriod: null, nightPeriod: null };
            byKey.set(dateKey, group);
            groups.push(group);
        }
        if (period.isDaytime) {
            group.dayPeriod = period;
        } else {
            group.nightPeriod = period;
        }
    }
    return groups;
}

function periodTempF(period) {
    return period.temperatureUnit === "F" ? period.temperature : (period.temperature * 9) / 5 + 32;
}

function makeTempSpan(period) {
    const tempF = periodTempF(period);
    const temp = useMetric ? fToC(tempF) : tempF;
    const unit = useMetric ? "°C" : "°F";

    const span = document.createElement("span");
    span.className = "forecast-temp-value";
    span.style.setProperty("--temp-color", tempColor(tempF));
    span.textContent = `${round(temp, 0)}${unit}`;
    return span;
}

function makeIcon(period, className) {
    const icon = document.createElement("img");
    icon.className = className;
    icon.src = period.icon;
    icon.alt = period.shortForecast;
    icon.loading = "lazy";
    return icon;
}

function renderForecastDays() {
    const groups = groupPeriodsByDay(forecast?.periods ?? []);
    els.forecastDays.innerHTML = "";

    for (const group of groups) {
        const primary = group.dayPeriod ?? group.nightPeriod;

        const card = document.createElement("button");
        card.type = "button";
        card.className = "forecast-day-card";
        card.setAttribute("aria-pressed", String(group.dateKey === selectedDayKey));
        card.addEventListener("click", () => {
            selectedDayKey = group.dateKey;
            renderForecastDays();
            renderForecastDetail();
        });

        const name = document.createElement("p");
        name.className = "forecast-name";
        name.textContent = primary.name;
        card.appendChild(name);

        card.appendChild(makeIcon(primary, "forecast-icon"));

        const short = document.createElement("p");
        short.className = "forecast-short";
        short.textContent = primary.shortForecast;
        card.appendChild(short);

        const temps = document.createElement("p");
        temps.className = "forecast-temps";
        temps.appendChild(makeTempSpan(group.dayPeriod ?? group.nightPeriod));
        if (group.dayPeriod && group.nightPeriod) {
            const sep = document.createElement("span");
            sep.className = "temp-sep";
            sep.textContent = "|";
            temps.appendChild(sep);
            temps.appendChild(makeTempSpan(group.nightPeriod));
        }
        card.appendChild(temps);

        els.forecastDays.appendChild(card);
    }
}

function renderForecastDetail() {
    const groups = groupPeriodsByDay(forecast?.periods ?? []);
    const group = groups.find((g) => g.dateKey === selectedDayKey) ?? groups[0];
    els.forecastDetail.innerHTML = "";
    if (!group) return;

    for (const period of [group.dayPeriod, group.nightPeriod]) {
        if (!period) continue;

        const wrap = document.createElement("div");
        wrap.className = "forecast-detail-period";

        const heading = document.createElement("h3");
        heading.textContent = period.name;
        wrap.appendChild(heading);

        wrap.appendChild(makeIcon(period, "forecast-icon"));

        const detail = document.createElement("p");
        detail.textContent = period.detailedForecast;
        wrap.appendChild(detail);

        els.forecastDetail.appendChild(wrap);
    }
}

function mphToKmh(mph) {
    return mph * 1.60934;
}

function chartCard(name) {
    return document.querySelector(`.chart-card[data-chart="${name}"]`);
}

// NWS's hourly windSpeed comes as a free-form string ("2 mph", occasionally
// a range like "5 to 10 mph") — averaging whatever numbers are in it is good
// enough for a chart (the daily cards already show the fuller range text).
function windSpeedMph(speedStr) {
    const nums = (speedStr.match(/\d+(\.\d+)?/g) ?? []).map(Number);
    if (nums.length === 0) return null;
    return nums.reduce((a, b) => a + b, 0) / nums.length;
}

const COMPASS_DEGREES = {
    N: 0, NNE: 22.5, NE: 45, ENE: 67.5, E: 90, ESE: 112.5, SE: 135, SSE: 157.5,
    S: 180, SSW: 202.5, SW: 225, WSW: 247.5, W: 270, WNW: 292.5, NW: 315, NNW: 337.5,
};
function windDirDegrees(dirStr) {
    return COMPASS_DEGREES[dirStr] ?? null;
}

// The chart now spans several days at once, so every axis label carries the
// weekday alongside the hour — "6am" alone would be ambiguous once the same
// hour recurs across the range.
const hourFmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", hour: "numeric", hour12: true });
const weekdayFmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", weekday: "short" });
function hourAxisLabel(ms) {
    const parts = hourFmt.formatToParts(new Date(ms));
    const hour = parts.find((p) => p.type === "hour").value;
    const dayPeriod = parts.find((p) => p.type === "dayPeriod").value.toLowerCase();
    return `${weekdayFmt.format(new Date(ms))} ${hour}${dayPeriod}`;
}

function hourlyPoints() {
    return (forecast?.hourlyPeriods ?? []).map((p) => ({
        t: new Date(p.startTime).getTime(),
        tempF: p.temperatureUnit === "F" ? p.temperature : (p.temperature * 9) / 5 + 32,
        dewpointF: p.dewpointF,
        pop: p.probabilityOfPrecipitation,
        windSpeedMph: windSpeedMph(p.windSpeed),
        windDirDeg: windDirDegrees(p.windDirection),
    }));
}

function renderHourlyTempChart(points, xDomain) {
    const card = chartCard("hourly-temp");
    const tempUnit = useMetric ? "°C" : "°F";
    const convert = (f) => (useMetric ? fToC(f) : f);
    const series = [
        {
            color: "var(--chart-green)",
            label: "Dew point",
            getValue: (p) => (typeof p.dewpointF === "number" ? convert(p.dewpointF) : null),
        },
        { color: "var(--chart-red)", label: "Temp", getValue: (p) => convert(p.tempF) },
    ];
    renderTimeChart({
        wrapEl: card.querySelector(".chart-wrap"),
        xaxisEl: card.querySelector(".chart-xaxis"),
        points,
        xDomain,
        series,
        height: 180,
        yFormat: (v) => `${round(v, 0)}${tempUnit}`,
        yAxisFormat: (v) => `${round(v, 0)}°`,
        xAxisFormat: hourAxisLabel,
    });
}

function renderHourlyWindSpeedChart(points, xDomain) {
    const card = chartCard("hourly-wind-speed");
    const speedUnit = useMetric ? "km/h" : "mph";
    const convert = (mph) => (useMetric ? mphToKmh(mph) : mph);
    const series = [
        {
            color: "var(--accent-rain)",
            label: "Speed",
            getValue: (p) => (typeof p.windSpeedMph === "number" ? convert(p.windSpeedMph) : null),
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
        xAxisFormat: hourAxisLabel,
    });
}

const WIND_DIR_TICKS = [
    { value: 0, label: "N" },
    { value: 90, label: "E" },
    { value: 180, label: "S" },
    { value: 270, label: "W" },
    { value: 360, label: "N" },
];

function renderHourlyWindDirChart(points, xDomain) {
    const card = chartCard("hourly-wind-dir");
    const series = [{ color: "var(--accent-rain)", label: "Direction", getValue: (p) => p.windDirDeg }];
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
        xAxisFormat: hourAxisLabel,
    });
}

function renderHourlyPopChart(points, xDomain) {
    const card = chartCard("hourly-pop");
    const series = [
        { color: "var(--accent-rain)", label: "Chance", area: true, getValue: (p) => (typeof p.pop === "number" ? p.pop : null) },
    ];
    renderTimeChart({
        wrapEl: card.querySelector(".chart-wrap"),
        xaxisEl: card.querySelector(".chart-xaxis"),
        points,
        xDomain,
        series,
        height: 180,
        yDomain: [0, 100],
        yTicks: [0, 25, 50, 75, 100].map((v) => ({ value: v, label: `${v}%` })),
        yFormat: (v) => `${round(v, 0)}%`,
        xAxisFormat: hourAxisLabel,
    });
}

function clearHourlyCharts() {
    for (const name of ["hourly-temp", "hourly-wind-speed", "hourly-wind-dir", "hourly-pop"]) {
        const svg = chartCard(name)?.querySelector(".chart-svg");
        if (svg) while (svg.firstChild) svg.removeChild(svg.firstChild);
    }
}

function renderHourlyCharts() {
    const periods = forecast?.hourlyPeriods ?? [];
    const points = hourlyPoints();
    if (points.length === 0) {
        clearHourlyCharts();
        return;
    }

    const xDomain = [points[0].t, new Date(periods[periods.length - 1].endTime).getTime()];
    renderHourlyTempChart(points, xDomain);
    renderHourlyWindSpeedChart(points, xDomain);
    renderHourlyWindDirChart(points, xDomain);
    renderHourlyPopChart(points, xDomain);
}

function updateForecastDaysArrows() {
    const el = els.forecastDaysScroll;
    const maxScroll = el.scrollWidth - el.clientWidth;
    els.forecastDaysPrev.disabled = el.scrollLeft <= 1;
    els.forecastDaysNext.disabled = el.scrollLeft >= maxScroll - 1;
}

function scrollForecastDays(direction) {
    els.forecastDaysScroll.scrollBy({ left: direction * els.forecastDaysScroll.clientWidth * 0.9, behavior: "smooth" });
}

function render() {
    els.unitToggle.textContent = useMetric ? "°C" : "°F";
    renderAlerts();
    renderForecastDays();
    renderForecastDetail();
    renderHourlyCharts();
    updateForecastDaysArrows();
}

async function fetchForecast() {
    try {
        const res = await fetch("/api/forecast");
        if (!res.ok) throw new Error(`Request failed: ${res.status}`);
        const data = await res.json();
        if (!data || !Array.isArray(data.periods)) throw new Error("Unexpected response shape");

        forecast = data;
        if (selectedDayKey === null) {
            const groups = groupPeriodsByDay(data.periods);
            selectedDayKey = groups[0]?.dateKey ?? null;
        }
        setStatus("");
        els.lastUpdated.textContent = `Forecast updated ${formatAgo(0)}`;
        render();
    } catch (err) {
        setStatus("Unable to load the forecast right now.", "error");
    }
}

els.unitToggle.addEventListener("click", () => {
    useMetric = !useMetric;
    localStorage.setItem("units", useMetric ? "metric" : "imperial");
    render();
});

els.refreshButton.addEventListener("click", () => {
    fetchForecast();
    fetchCurrentForBanner();
});

els.forecastDaysPrev.addEventListener("click", () => scrollForecastDays(-1));
els.forecastDaysNext.addEventListener("click", () => scrollForecastDays(1));
els.forecastDaysScroll.addEventListener("scroll", updateForecastDaysArrows);
window.addEventListener("resize", updateForecastDaysArrows);

fetchForecast();
fetchCurrentForBanner();
setInterval(fetchForecast, REFRESH_INTERVAL_MS);
setInterval(fetchCurrentForBanner, CURRENT_REFRESH_INTERVAL_MS);
