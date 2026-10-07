// The spreadsheet's recorded daily history starts in September 2018 — used
// only to bound how far back the year dropdown offers, not fetched
// dynamically (the history section as a whole already tolerates a
// period/year with no rows via the "No data" status message).
const EARLIEST_YEAR = 2018;

const MONTH_NAMES = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
];

const els = {
    statusLine: document.getElementById("status-line"),
    unitToggle: document.getElementById("unit-toggle"),
    rangeModeMonth: document.getElementById("range-mode-month"),
    rangeModeYear: document.getElementById("range-mode-year"),
    monthSelect: document.getElementById("history-month"),
    yearSelect: document.getElementById("history-year"),
    historyPrev: document.getElementById("history-prev"),
    historyNext: document.getElementById("history-next"),
    historyTableSection: document.getElementById("history-table-section"),
    historyTableBody: document.getElementById("history-table-body"),
    historyTableFoot: document.getElementById("history-table-foot"),
};

let useMetric = localStorage.getItem("units") === "metric";
let rangeMode = "month"; // "month" | "year"
let days = [];
// Per-day record low/high/precip (and the year each happened), across every
// year on record for the selected month — null in year mode, where the
// table doesn't show. Keyed by day-of-month via recordsByDay() below.
let monthRecords = null;

function fToC(f) {
    return (f - 32) * (5 / 9);
}

function inToMm(inches) {
    return inches * 25.4;
}

// Unlike toFixed() alone, kept as a named helper to match the rest of the
// app's formatting calls (script.js/forecast.js both have their own copy).
function formatFixed(value, places) {
    return value.toFixed(places);
}

function pad2(n) {
    return String(n).padStart(2, "0");
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

// Date's month argument is 0-indexed, so passing the 1-indexed `month`
// itself (not month - 1) rolls over to the next month's day 0 — i.e. this
// month's last day.
function daysInMonth(year, month) {
    return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

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

function populateSelects() {
    for (const [i, name] of MONTH_NAMES.entries()) {
        const opt = document.createElement("option");
        opt.value = String(i + 1);
        opt.textContent = name;
        els.monthSelect.appendChild(opt);
    }

    const { year: currentYear } = pacificToday();
    for (let y = currentYear; y >= EARLIEST_YEAR; y--) {
        const opt = document.createElement("option");
        opt.value = String(y);
        opt.textContent = String(y);
        els.yearSelect.appendChild(opt);
    }
}

function updateControlsVisibility() {
    els.monthSelect.hidden = rangeMode === "year";
    els.rangeModeMonth.setAttribute("aria-pressed", String(rangeMode === "month"));
    els.rangeModeYear.setAttribute("aria-pressed", String(rangeMode === "year"));
    updateNavButtons();
}

// The arrows walk the same bounds the controls themselves are built from —
// the year <select>'s own [EARLIEST_YEAR, current year] range, and (in
// month mode) the current Pacific month as the forward limit — so they
// never land on a selection the dropdowns couldn't already produce.
function updateNavButtons() {
    const { year: todayYear, month: todayMonth } = pacificToday();
    const year = Number(els.yearSelect.value);

    if (rangeMode === "year") {
        els.historyNext.disabled = year >= todayYear;
        els.historyPrev.disabled = year <= EARLIEST_YEAR;
        return;
    }

    const month = Number(els.monthSelect.value);
    els.historyNext.disabled = year > todayYear || (year === todayYear && month >= todayMonth);
    els.historyPrev.disabled = year < EARLIEST_YEAR || (year === EARLIEST_YEAR && month <= 1);
}

function shiftHistory(delta) {
    let year = Number(els.yearSelect.value);

    if (rangeMode === "year") {
        els.yearSelect.value = String(year + delta);
    } else {
        let month = Number(els.monthSelect.value) + delta;
        if (month < 1) {
            month = 12;
            year -= 1;
        } else if (month > 12) {
            month = 1;
            year += 1;
        }
        els.yearSelect.value = String(year);
        els.monthSelect.value = String(month);
    }

    updateNavButtons();
    fetchHistory();
}

function currentRange() {
    const year = Number(els.yearSelect.value);
    if (rangeMode === "year") {
        return { start: `${year}-01-01`, end: `${year}-12-31` };
    }
    const month = Number(els.monthSelect.value);
    return {
        start: `${year}-${pad2(month)}-01`,
        end: `${year}-${pad2(month)}-${pad2(daysInMonth(year, month))}`,
    };
}

// Anchored at UTC noon (rather than midnight) so the date this represents
// can't shift a calendar day in either direction under any timezone math
// downstream — these are day-level aggregates with no timezone of their
// own, not real instants.
function dayToMs(dateString) {
    const [y, m, d] = dateString.split("-").map(Number);
    return Date.UTC(y, m - 1, d, 12);
}

function dayAxisLabel(ms) {
    const d = new Date(ms);
    return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
}

const monthAxisFmt = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short" });
function yearAxisLabel(ms) {
    return monthAxisFmt.format(new Date(ms));
}

// Each point is a whole day, not a moment within one, so the tooltip's time
// line shows the date instead of the shared chart engine's default clock
// time (which would otherwise show the UTC-noon anchor's Pacific clock time,
// e.g. "5:00 AM" — meaningless for a daily aggregate).
const tooltipDateFmt = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" });
function tooltipDateLabel(ms) {
    return tooltipDateFmt.format(new Date(ms));
}

function renderHistoryTempChart(points, xDomain) {
    const card = chartCard("history-temp");
    const tempUnit = useMetric ? "°C" : "°F";
    const convert = (f) => (useMetric ? fToC(f) : f);
    // Climatological averages share their recorded counterpart's hue, just
    // faded — so "this year ran hot" reads as a solid line pulling away from
    // its own lighter shadow, not as six unrelated series.
    const AVG_OPACITY = 0.4;
    const series = [
        { color: "var(--chart-red)", label: "High", getValue: (p) => (typeof p.highF === "number" ? convert(p.highF) : null) },
        {
            color: "var(--chart-red)",
            label: "Avg High",
            opacity: AVG_OPACITY,
            getValue: (p) => (typeof p.avgHighF === "number" ? convert(p.avgHighF) : null),
        },
        { color: "var(--chart-secondary)", label: "Mean", getValue: (p) => (typeof p.meanF === "number" ? convert(p.meanF) : null) },
        {
            color: "var(--chart-secondary)",
            label: "Avg Mean",
            opacity: AVG_OPACITY,
            getValue: (p) => (typeof p.avgMeanF === "number" ? convert(p.avgMeanF) : null),
        },
        { color: "var(--accent-rain)", label: "Low", getValue: (p) => (typeof p.lowF === "number" ? convert(p.lowF) : null) },
        {
            color: "var(--accent-rain)",
            label: "Avg Low",
            opacity: AVG_OPACITY,
            getValue: (p) => (typeof p.avgLowF === "number" ? convert(p.avgLowF) : null),
        },
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
        xAxisFormat: rangeMode === "year" ? yearAxisLabel : dayAxisLabel,
        tooltipTimeFormat: tooltipDateLabel,
    });
}

function renderHistoryRainChart(points, xDomain) {
    const card = chartCard("history-rain");
    const rainUnit = useMetric ? "mm" : "in";
    const convert = (inches) => (useMetric ? inToMm(inches) : inches);
    const places = useMetric ? 1 : 2;
    const series = [
        {
            color: "var(--accent-rain)",
            label: "Precip",
            mode: "bar",
            getValue: (p) => (typeof p.precipIn === "number" ? convert(p.precipIn) : null),
        },
    ];
    renderTimeChart({
        wrapEl: card.querySelector(".chart-wrap"),
        xaxisEl: card.querySelector(".chart-xaxis"),
        points,
        xDomain,
        series,
        height: 140,
        minZero: true,
        yFormat: (v) => `${formatFixed(v, places)} ${rainUnit}`,
        xAxisFormat: rangeMode === "year" ? yearAxisLabel : dayAxisLabel,
        tooltipTimeFormat: tooltipDateLabel,
    });
}

function clearCharts() {
    for (const svg of document.querySelectorAll(".history .chart-svg")) {
        while (svg.firstChild) svg.removeChild(svg.firstChild);
    }
}

function dayOfMonth(dateString) {
    return Number(dateString.slice(8, 10));
}

function tempCellText(f) {
    if (typeof f !== "number") return "–";
    const tempUnit = useMetric ? "°C" : "°F";
    return `${formatFixed(useMetric ? fToC(f) : f, 1)}${tempUnit}`;
}

function rainCellText(inches) {
    if (typeof inches !== "number") return "–";
    const rainUnit = useMetric ? "mm" : "in";
    const places = useMetric ? 1 : 2;
    return `${formatFixed(useMetric ? inToMm(inches) : inches, places)} ${rainUnit}`;
}

function average(values) {
    const nums = values.filter((v) => typeof v === "number" && !Number.isNaN(v));
    return nums.length > 0 ? nums.reduce((sum, v) => sum + v, 0) / nums.length : null;
}

function total(values) {
    return values.filter((v) => typeof v === "number" && !Number.isNaN(v)).reduce((sum, v) => sum + v, 0);
}

function appendCell(row, text) {
    const td = document.createElement("td");
    td.textContent = text;
    row.appendChild(td);
}

// A record cell carries both the value and the year it happened, the year
// in a smaller/muted span — appendCell alone can't express that.
function appendRecordCell(row, value, year, formatFn) {
    const td = document.createElement("td");
    if (typeof value === "number") {
        td.appendChild(document.createTextNode(formatFn(value)));
        if (typeof year === "number") {
            const yearSpan = document.createElement("span");
            yearSpan.className = "record-year";
            yearSpan.textContent = ` (${year})`;
            td.appendChild(yearSpan);
        }
    } else {
        td.textContent = "–";
    }
    row.appendChild(td);
}

function clearTable() {
    els.historyTableSection.hidden = true;
    els.historyTableBody.innerHTML = "";
    els.historyTableFoot.innerHTML = "";
}

// The table only makes sense for a single month — a year's worth of rows
// (365) would be unreadable — so it stays hidden in year mode regardless of
// whether `days` has data.
function renderHistoryTable() {
    if (rangeMode !== "month" || days.length === 0) {
        clearTable();
        return;
    }

    els.historyTableSection.hidden = false;
    els.historyTableBody.innerHTML = "";
    els.historyTableFoot.innerHTML = "";

    const recordsByDay = new Map((monthRecords ?? []).map((r) => [r.day, r]));

    for (const d of days) {
        const row = document.createElement("tr");
        const record = recordsByDay.get(dayOfMonth(d.date));

        appendCell(row, String(dayOfMonth(d.date)));
        appendCell(row, tempCellText(d.highF));
        appendCell(row, tempCellText(d.lowF));
        appendCell(row, tempCellText(d.avgHighF));
        appendCell(row, tempCellText(d.avgLowF));
        appendRecordCell(row, record?.recordHighF, record?.recordHighYear, tempCellText);
        appendRecordCell(row, record?.recordLowF, record?.recordLowYear, tempCellText);
        appendCell(row, rainCellText(d.precipIn));
        appendRecordCell(row, record?.recordPrecipIn, record?.recordPrecipYear, rainCellText);

        els.historyTableBody.appendChild(row);
    }

    // Cumulative row: averages for the temperature columns, a total for
    // rain — the record columns have no sensible single-row aggregate, so
    // they're left blank rather than, say, the single coldest/hottest/
    // wettest record of the month (which would read as "the record for the
    // whole month" and overstate what it actually means).
    const footRow = document.createElement("tr");
    appendCell(footRow, "Month");
    appendCell(footRow, tempCellText(average(days.map((d) => d.highF))));
    appendCell(footRow, tempCellText(average(days.map((d) => d.lowF))));
    appendCell(footRow, tempCellText(average(days.map((d) => d.avgHighF))));
    appendCell(footRow, tempCellText(average(days.map((d) => d.avgLowF))));
    appendCell(footRow, "–");
    appendCell(footRow, "–");
    appendCell(footRow, rainCellText(total(days.map((d) => d.precipIn))));
    appendCell(footRow, "–");
    els.historyTableFoot.appendChild(footRow);
}

function render() {
    els.unitToggle.textContent = useMetric ? "°C" : "°F";

    if (days.length === 0) {
        clearCharts();
        clearTable();
        return;
    }

    const points = days.map((d) => ({
        t: dayToMs(d.date),
        highF: d.highF,
        meanF: d.meanF,
        lowF: d.lowF,
        precipIn: d.precipIn,
        avgHighF: d.avgHighF,
        avgMeanF: d.avgMeanF,
        avgLowF: d.avgLowF,
    }));
    // A single-row month (e.g. viewing the current month on its first day)
    // would otherwise collapse the x-domain to one instant and divide by
    // zero in the chart's scale — padded a half day either side instead.
    const xDomain = points.length > 1
        ? [points[0].t, points[points.length - 1].t]
        : [points[0].t - 12 * 60 * 60 * 1000, points[0].t + 12 * 60 * 60 * 1000];

    renderHistoryTempChart(points, xDomain);
    renderHistoryRainChart(points, xDomain);
    renderHistoryTable();
}

// Guards against an in-flight request resolving after a newer one — the
// spreadsheet's backend doesn't guarantee responses land in request order,
// so without this a slow small request (say, a month) could overwrite a
// slower-starting but already-finished large one (a year) if the user
// switches the selection again before the first settles.
let fetchToken = 0;

async function fetchJson(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Request failed: ${res.status} ${res.body}`);
    return res.json();
}

async function fetchHistory() {
    const token = ++fetchToken;
    const { start, end } = currentRange();
    const isMonthMode = rangeMode === "month";
    const month = Number(els.monthSelect.value);
    setStatus("Loading history…");

    const historyPromise = fetchJson(`/api/history-range?start=${start}&end=${end}`);
    // Records are a nice-to-have on top of the main history fetch — a
    // failure here shouldn't blank out the charts, so it's caught on its
    // own and just leaves the table's record columns as "–".
    const recordsPromise = isMonthMode
        ? fetchJson(`/api/month-records?month=${month}`).catch((err) => {
              console.error(err);
              return null;
          })
        : Promise.resolve(null);

    try {
        const [historyData, recordsData] = await Promise.all([historyPromise, recordsPromise]);
        if (!historyData || !Array.isArray(historyData.days)) throw new Error("Unexpected response shape");
        if (token !== fetchToken) return;

        days = historyData.days;
        monthRecords = isMonthMode && recordsData && Array.isArray(recordsData.days) ? recordsData.days : null;
        setStatus(days.length === 0 ? "No data available for this period." : "");
        render();
    } catch (err) {
        if (token !== fetchToken) return;
        days = [];
        monthRecords = null;
        setStatus("Unable to load history right now.", "error");
        render();
    }
}

function setRangeMode(mode) {
    rangeMode = mode;
    updateControlsVisibility();
    fetchHistory();
}

els.unitToggle.addEventListener("click", () => {
    useMetric = !useMetric;
    localStorage.setItem("units", useMetric ? "metric" : "imperial");
    render();
});

els.rangeModeMonth.addEventListener("click", () => setRangeMode("month"));
els.rangeModeYear.addEventListener("click", () => setRangeMode("year"));
els.historyPrev.addEventListener("click", () => shiftHistory(-1));
els.historyNext.addEventListener("click", () => shiftHistory(1));
els.monthSelect.addEventListener("change", () => {
    updateNavButtons();
    fetchHistory();
});
els.yearSelect.addEventListener("change", () => {
    updateNavButtons();
    fetchHistory();
});

populateSelects();
const today = pacificToday();
els.monthSelect.value = String(today.month);
els.yearSelect.value = String(today.year);
updateControlsVisibility();
fetchHistory();

// This page has no other reason to fetch live station data, so the banner
// swap (shared with the dashboard/forecast pages via banner.js) runs on its
// own independent poll.
fetchCurrentForBanner();
setInterval(fetchCurrentForBanner, BANNER_POLL_INTERVAL_MS);
