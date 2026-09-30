const REFRESH_INTERVAL_MS = 60_000;
const STALE_AFTER_MS = 15 * 60_000;
const SHEETS_API_URL = "https://script.google.com/macros/s/AKfycbw0LodV_rPSxFXvf1jOOE-oYzU4jJq_-RagrsP8VMAbDmnMdNBf5PaHnf39GRt5dCN-4g/exec";

// Visual scale caps for the rain jars — not measured maxima, just what reads
// as "nearly full" for a Sunnyvale day/month.
const RAIN_JAR_MAX_IN = { day: 1, month: 6 };

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
    [20, [28, 92, 171]], // deep blue
    [45, [57, 135, 229]], // blue
    [60, [27, 175, 122]], // teal green
    [75, [237, 161, 0]], // amber
    [90, [235, 104, 52]], // orange
    [105, [208, 59, 59]], // red
];

const els = {
    statusLine: document.getElementById("status-line"),
    lastUpdated: document.getElementById("last-updated"),
    unitToggle: document.getElementById("unit-toggle"),
    refreshButton: document.getElementById("refresh-button"),
    tiles: {
        temp: document.querySelector('[data-tile="temp"]'),
        wind: document.querySelector('[data-tile="wind"]'),
        pressure: document.querySelector('[data-tile="pressure"]'),
        rain: document.querySelector('[data-tile="rain"]'),
        solar: document.querySelector('[data-tile="solar"]'),
    },
};

let useMetric = localStorage.getItem("units") === "metric";
let latest = null;
let readingAt = null;

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

    renderTemp(tempUnit);
    renderWind(speedUnit);
    renderPressure(pressureUnit);
    renderRain(rainUnit);
    renderSolar();

    updateLastUpdatedLabel();
}

function renderTemp(tempUnit) {
    const tile = els.tiles.temp;
    const temp = useMetric ? fToC(latest.tempf) : latest.tempf;
    const feelsLike = useMetric ? fToC(latest.feelsLike) : latest.feelsLike;
    const dewPoint = useMetric ? fToC(latest.dewPoint) : latest.dewPoint;

    tile.querySelector(".temp-ring .num").textContent = round(temp);
    tile.querySelector(".temp-ring .unit").textContent = tempUnit;
    tile.querySelector(".temp-ring").style.setProperty("--temp-color", tempColor(latest.tempf));
    tile.querySelector(".humidity").textContent = `${round(latest.humidity, 0)}%`;
    tile.querySelector(".dew-point").textContent = `${round(dewPoint)}${tempUnit}`;
    tile.querySelector(".feels-like strong").textContent = `${round(feelsLike)}${tempUnit}`;
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

    tile.querySelector(".pressure-value .num").textContent = round(pressure, useMetric ? 0 : 2);
    tile.querySelector(".pressure-value .unit").textContent = pressureUnit;
    tile.querySelector(".needle").style.setProperty("--deg", `${angle}deg`);

    for (const label of tile.pressureTickLabels) {
        const valueInHg = pressureAngleToInHg(label.deg);
        const value = useMetric ? inHgToHpa(valueInHg) : valueInHg;
        label.el.textContent = round(value, useMetric ? 0 : 1);
    }
}

function renderRain(rainUnit) {
    const tile = els.tiles.rain;
    const jars = tile.querySelectorAll(".jar");

    setJar(jars[0], latest.dailyrainin, RAIN_JAR_MAX_IN.day, rainUnit);
    setJar(jars[1], latest.monthlyrainin, RAIN_JAR_MAX_IN.month, rainUnit);
}

function setJar(jarEl, amountIn, maxIn, rainUnit) {
    const amount = useMetric ? inToMm(amountIn) : amountIn;
    const fillPercent = clamp((amountIn / maxIn) * 100, 4, 100);

    jarEl.querySelector(".jar-fill").style.setProperty("--fill", `${fillPercent}%`);
    jarEl.querySelector(".jar-value").textContent = `${round(amount, useMetric ? 1 : 2)} ${rainUnit}`;
}

function renderSolar() {
    const tile = els.tiles.solar;
    const corePercent = clamp((latest.solarradiation / SOLAR_MAX_WM2) * 100, 0, 100);

    tile.querySelector(".sun-core").style.setProperty("--core-size", `${corePercent}%`);
    tile.querySelector(".solar-value .num").textContent = round(latest.solarradiation, 0);
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

fetchCurrent();
setInterval(fetchCurrent, REFRESH_INTERVAL_MS);
setInterval(updateLastUpdatedLabel, 1000);
