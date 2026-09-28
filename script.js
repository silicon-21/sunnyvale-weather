const REFRESH_INTERVAL_MS = 60_000;
const STALE_AFTER_MS = 5 * 60_000;

const els = {
    statusLine: document.getElementById("status-line"),
    lastUpdated: document.getElementById("last-updated"),
    unitToggle: document.getElementById("unit-toggle"),
    refreshButton: document.getElementById("refresh-button"),
    tiles: {
        temp: document.querySelector('[data-tile="temp"]'),
        humidity: document.querySelector('[data-tile="humidity"]'),
        wind: document.querySelector('[data-tile="wind"]'),
        pressure: document.querySelector('[data-tile="pressure"]'),
        rain: document.querySelector('[data-tile="rain"]'),
        solar: document.querySelector('[data-tile="solar"]'),
    },
};

let useMetric = localStorage.getItem("units") === "metric";
let latest = null;
let readingAt = null;

const WIND_COMPASS = [
    "N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
    "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW",
];

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

function compassDirection(deg) {
    const index = Math.round(((deg % 360) / 22.5)) % 16;
    return WIND_COMPASS[index];
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

    const temp = useMetric ? fToC(latest.tempf) : latest.tempf;
    const feelsLike = useMetric ? fToC(latest.feelsLike) : latest.feelsLike;
    const dewPoint = useMetric ? fToC(latest.dewPoint) : latest.dewPoint;

    setTile("temp", round(temp), tempUnit, {
        ".feels-like": `${round(feelsLike)}${tempUnit}`,
    });

    setTile("humidity", round(latest.humidity, 0), "%", {
        ".dew-point": `${round(dewPoint)}${tempUnit}`,
    });

    const windSpeed = useMetric ? mphToKmh(latest.windspeedmph) : latest.windspeedmph;
    const windGust = useMetric ? mphToKmh(latest.windgustmph) : latest.windgustmph;
    setTile("wind", round(windSpeed), speedUnit, {
        ".gust": `${round(windGust)} ${speedUnit}`,
        ".dir": compassDirection(latest.winddir),
    });

    const pressure = useMetric ? inHgToHpa(latest.baromrelin) : latest.baromrelin;
    setTile("pressure", round(pressure, useMetric ? 0 : 2), pressureUnit, {
        ".trend": "Relative pressure",
    });

    const dailyRain = useMetric ? inToMm(latest.dailyrainin) : latest.dailyrainin;
    const rainRate = useMetric ? inToMm(latest.hourlyrainin) : latest.hourlyrainin;
    setTile("rain", round(dailyRain, useMetric ? 1 : 2), rainUnit, {
        ".rain-rate": `${round(rainRate, useMetric ? 1 : 2)} ${rainUnit}/hr`,
    });

    setTile("solar", round(latest.solarradiation, 0), "W/m²", {
        ".uv": latest.uv,
    });

    updateLastUpdatedLabel();
}

function setTile(tileName, value, unit, subFields) {
    const tile = els.tiles[tileName];
    if (!tile) return;
    tile.querySelector(".num").textContent = value;
    tile.querySelector(".unit").textContent = unit;
    for (const [selector, text] of Object.entries(subFields)) {
        const el = tile.querySelector(selector);
        if (el) el.textContent = text;
    }
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

fetchCurrent();
setInterval(fetchCurrent, REFRESH_INTERVAL_MS);
setInterval(updateLastUpdatedLabel, 1000);
