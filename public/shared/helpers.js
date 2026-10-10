// Small utility functions and constants shared by every page's own script
// (dashboard/script.js, forecast/forecast.js, history/history.js) — pulled
// out here once they started drifting as copy-pasted duplicates. Loaded as
// a plain global <script>, same as chart.js/banner.js.

// Temperature ring/line color, interpolated between stops (always keyed on
// raw °F so it doesn't shift when the unit toggle flips to Celsius) — shared
// by the dashboard's temperature ring and the forecast's day-tile temps.
const TEMP_COLOR_STOPS = [
    [15, [28, 92, 171]], // deep blue
    [30, [57, 135, 229]], // blue
    [45, [27, 175, 122]], // teal green
    [60, [252, 236, 3]], // yellow
    [75, [237, 161, 0]], // amber
    [90, [208, 59, 59]], // red
    [105, [181, 0, 131]], // magenta
];

function fToC(f) {
    return (f - 32) * (5 / 9);
}

function inHgToHpa(inHg) {
    return inHg * 33.8639;
}

function hpaToInHg(hpa) {
    return hpa / 33.8639;
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

// Every page's status line follows the same text + optional [data-state]
// pattern, driven off that page's own `els.statusLine`.
function setStatus(text, state) {
    els.statusLine.textContent = text;
    if (state) {
        els.statusLine.setAttribute("data-state", state);
    } else {
        els.statusLine.removeAttribute("data-state");
    }
}

function chartCard(name) {
    return document.querySelector(`.chart-card[data-chart="${name}"]`);
}

// Date's month argument is 0-indexed, so passing the 1-indexed `month`
// itself (not month - 1) rolls over to the next month's day 0 — i.e. this
// month's last day.
function daysInMonth(year, month) {
    return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

const pacificPartsFmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
});
function pacificToday() {
    const parts = pacificPartsFmt.formatToParts(new Date());
    const get = (type) => Number(parts.find((p) => p.type === type).value);
    return { year: get("year"), month: get("month"), day: get("day") };
}
