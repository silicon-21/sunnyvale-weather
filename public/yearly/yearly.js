// "Yearly Comparisons" page: season-over-season rain totals/timeseries and
// year-over-year mean temperature, all computed client-side from a single
// bulk fetch of the full daily history (spreadsheet-backed, via the same
// /api/history-range endpoint the History page uses). Unlike that page,
// there's no meaningful subset of "the whole record" to re-fetch on a
// control change, so this loads once on page load and never re-fetches.

// The spreadsheet's recorded daily history starts in September 2018, so the
// rain season starting July 2018 ("2018-19") is the earliest one with any
// data — July and August 2018 specifically are known to have had zero
// rainfall (confirmed, not just "no data"), handled in monthPrecipTotal().
const EARLIEST_SEASON_YEAR = 2018;

// The rain season always runs July through June (see getRainSeasonStart in
// src/index.js) — this walks those 12 months in that order, independent of
// calendar-year order.
const SEASON_MONTHS = [7, 8, 9, 10, 11, 12, 1, 2, 3, 4, 5, 6];

// Used by the season rainfall chart only — the yearly temperature chart's
// lines are colored by recency instead (see tempSeriesStyle). Rotates for
// however many seasons are on record — currently 9, comfortably under this
// palette's length, chosen for pairwise contrast rather than drawn from the
// smaller set of colors already used elsewhere (those were picked for 2-3
// fixed roles like "high/mean/low," not for telling apart many same-role
// series at a glance).
const SERIES_COLORS = [
    "var(--accent-rain)",
    "var(--chart-red)",
    "var(--chart-green)",
    "var(--chart-secondary)",
    "var(--chart-tertiary)",
    "var(--chart-teal)",
    "var(--chart-pink)",
    "var(--chart-slate)",
    "var(--chart-brown)",
];

// Both multi-series charts weight their lines by recency: the current
// season/year reads as the clear "main" line, last season/year a step down,
// and everything older recedes to the same thin weight rather than fading
// out individually — there isn't a natural "oldest is thinnest" gradient the
// way there is for the temperature chart's color fade below.
const LINE_WIDTH_OLDER = 1.25;
const LINE_WIDTH_PREVIOUS = 2;
const LINE_WIDTH_CURRENT = 3.25;

function strokeWidthForIndex(index, total) {
    if (index === total - 1) return LINE_WIDTH_CURRENT;
    if (index === total - 2) return LINE_WIDTH_PREVIOUS;
    return LINE_WIDTH_OLDER;
}

// The temperature lines run much closer together than the rainfall ones, so
// a 9-color rainbow there just reads as clutter — instead only the current
// year gets a real color (yellow, against the chart's otherwise cool/neutral
// palette elsewhere), last year is a solid mid-gray, and every older year
// fades toward the background the further back it is, via opacity on the
// same gray rather than ever-lighter literal shades (which would need to be
// redefined per light/dark theme).
const TEMP_OLDER_MIN_OPACITY = 0.18;
const TEMP_OLDER_MAX_OPACITY = 0.55;
const TEMP_PREVIOUS_OPACITY = 0.75;

function tempSeriesStyle(index, total) {
    if (index === total - 1) {
        return { color: "var(--chart-current-year)", opacity: 1 };
    }
    if (index === total - 2) {
        return { color: "var(--text-secondary)", opacity: TEMP_PREVIOUS_OPACITY };
    }
    const olderCount = total - 2;
    const opacity =
        olderCount <= 1
            ? (TEMP_OLDER_MIN_OPACITY + TEMP_OLDER_MAX_OPACITY) / 2
            : TEMP_OLDER_MIN_OPACITY + (TEMP_OLDER_MAX_OPACITY - TEMP_OLDER_MIN_OPACITY) * (index / (olderCount - 1));
    return { color: "var(--text-secondary)", opacity };
}

const els = {
    statusLine: document.getElementById("status-line"),
    unitToggle: document.getElementById("unit-toggle"),
    seasonTableBody: document.getElementById("season-rain-table-body"),
};

let useMetric = localStorage.getItem("units") === "metric";
let days = [];
// Today's rain so far, from the live station reading rather than the
// spreadsheet (whose row for today is always still blank) — null until
// loadAll()'s /api/current fetch resolves, or if it fails.
let todayLiveRainIn = null;

function pad2(n) {
    return String(n).padStart(2, "0");
}

function seasonLabel(startYear) {
    return `${startYear}-${String((startYear + 1) % 100).padStart(2, "0")}`;
}

function currentSeasonStartYear(today) {
    return today.month >= 7 ? today.year : today.year - 1;
}

function seasonStartYears(today) {
    const years = [];
    for (let y = EARLIEST_SEASON_YEAR; y <= currentSeasonStartYear(today); y++) years.push(y);
    return years;
}

function appendCell(row, text) {
    const td = document.createElement("td");
    td.textContent = text;
    row.appendChild(td);
}

function rainCellText(inches) {
    if (typeof inches !== "number") return "–";
    const rainUnit = useMetric ? "mm" : "in";
    const places = useMetric ? 1 : 2;
    return `${formatFixed(useMetric ? inToMm(inches) : inches, places)} ${rainUnit}`;
}

// The spreadsheet's row for today is always still blank (it only gets
// filled in once the day is over), so today's precip comes from the live
// station reading instead — same source, and same reasoning, as the
// dashboard's own season rain jar (seasonToYesterdayIn + today's
// dailyrainin). Every other date is read from the spreadsheet as normal.
// Returns null if today's live reading isn't available (yet, or the fetch
// failed) and there's nothing in the spreadsheet for that date either.
function precipForDate(byDate, dateStr, todayStr, todayLiveRainIn) {
    if (dateStr === todayStr) {
        return typeof todayLiveRainIn === "number" ? todayLiveRainIn : null;
    }
    const row = byDate.get(dateStr);
    return row && typeof row.precipIn === "number" ? row.precipIn : null;
}

// Sums one calendar month's precip, or null if the month has no rows at
// all yet (a season's not-yet-reached future months) — except July/August
// 2018, which predate the spreadsheet but are known to have had no rain, so
// they're reported as a real zero rather than a blank.
function monthPrecipTotal(byDate, calYear, calMonth, todayStr, todayLiveRainIn) {
    let sum = 0;
    let any = false;
    const dim = daysInMonth(calYear, calMonth);
    for (let d = 1; d <= dim; d++) {
        const dateStr = `${calYear}-${pad2(calMonth)}-${pad2(d)}`;
        const precip = precipForDate(byDate, dateStr, todayStr, todayLiveRainIn);
        if (typeof precip === "number") {
            sum += precip;
            any = true;
        }
    }
    if (any) return sum;
    if (calYear === 2018 && (calMonth === 7 || calMonth === 8)) return 0;
    return null;
}

function renderSeasonRainTable(byDate, today, todayLiveRainIn) {
    const todayStr = `${today.year}-${pad2(today.month)}-${pad2(today.day)}`;
    els.seasonTableBody.innerHTML = "";
    for (const startYear of seasonStartYears(today)) {
        const row = document.createElement("tr");
        appendCell(row, seasonLabel(startYear));

        let seasonTotal = 0;
        let anyMonth = false;
        for (const month of SEASON_MONTHS) {
            const calYear = month >= 7 ? startYear : startYear + 1;
            const total = monthPrecipTotal(byDate, calYear, month, todayStr, todayLiveRainIn);
            appendCell(row, rainCellText(total));
            if (typeof total === "number") {
                seasonTotal += total;
                anyMonth = true;
            }
        }
        appendCell(row, anyMonth ? rainCellText(seasonTotal) : "–");

        els.seasonTableBody.appendChild(row);
    }
}

// Synthetic season axis: Jul 1 - Jun 30, anchored at a non-leap reference
// year for the Jul-Dec half and a leap one for the Jan-Jun half, so every
// season's Feb 29 (when it has one) lands on a real slot regardless of
// whether that particular season's own year was leap.
const SEASON_REF_YEAR_JUL_DEC = 2003;
const SEASON_REF_YEAR_JAN_JUN = 2004;

function seasonAxisMs(month, day) {
    const year = month >= 7 ? SEASON_REF_YEAR_JUL_DEC : SEASON_REF_YEAR_JAN_JUN;
    return Date.UTC(year, month - 1, day, 12);
}

function seasonDates() {
    const dates = [];
    for (const month of SEASON_MONTHS) {
        const refYear = month >= 7 ? SEASON_REF_YEAR_JUL_DEC : SEASON_REF_YEAR_JAN_JUN;
        for (let day = 1; day <= daysInMonth(refYear, month); day++) dates.push({ month, day });
    }
    return dates;
}

const seasonAxisFmt = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric" });
function seasonAxisLabel(ms) {
    return seasonAxisFmt.format(new Date(ms));
}

// One cumulative-precip series per season, sharing the synthetic day-of-
// season x-axis above. A day with no row just carries the running total
// forward (consistent with the table's "no rain" reading of the two known
// pre-spreadsheet months) rather than breaking the line; a day past today
// (only possible for the current, still-in-progress season) stops the line
// instead of projecting a flat tail out to June 30. Today itself is still
// plotted — see precipForDate for where its value actually comes from.
function aggregateSeasonRain(byDate, today, startYears, todayLiveRainIn) {
    const todayStr = `${today.year}-${pad2(today.month)}-${pad2(today.day)}`;
    const dates = seasonDates();
    const points = dates.map(({ month, day }) => ({ t: seasonAxisMs(month, day) }));

    for (const startYear of startYears) {
        const key = `s${startYear}`;
        let cum = 0;
        for (let i = 0; i < dates.length; i++) {
            const { month, day } = dates[i];
            const calYear = month >= 7 ? startYear : startYear + 1;
            const dateStr = `${calYear}-${pad2(month)}-${pad2(day)}`;
            if (dateStr > todayStr) {
                points[i][key] = null;
                continue;
            }
            const precip = precipForDate(byDate, dateStr, todayStr, todayLiveRainIn);
            if (typeof precip === "number") cum += precip;
            points[i][key] = cum;
        }
    }
    return points;
}

function renderLegend(card, entries) {
    const legend = card.querySelector(".chart-legend");
    legend.innerHTML = "";
    for (const { color, label } of entries) {
        const item = document.createElement("span");
        item.className = "legend-item";
        const swatch = document.createElement("span");
        swatch.className = "legend-swatch";
        swatch.style.setProperty("--swatch", color);
        item.appendChild(swatch);
        item.appendChild(document.createTextNode(label));
        legend.appendChild(item);
    }
}

function renderSeasonRainChart(points, startYears) {
    const card = chartCard("season-rain");
    const rainUnit = useMetric ? "mm" : "in";
    const convert = (inches) => (useMetric ? inToMm(inches) : inches);
    const places = useMetric ? 1 : 2;

    const series = startYears.map((startYear, i) => {
        const key = `s${startYear}`;
        return {
            color: SERIES_COLORS[i % SERIES_COLORS.length],
            label: seasonLabel(startYear),
            strokeWidth: strokeWidthForIndex(i, startYears.length),
            getValue: (p) => (typeof p[key] === "number" ? convert(p[key]) : null),
        };
    });
    renderLegend(card, series);

    renderTimeChart({
        wrapEl: card.querySelector(".chart-wrap"),
        xaxisEl: card.querySelector(".chart-xaxis"),
        points,
        xDomain: [seasonAxisMs(7, 1), seasonAxisMs(6, 30)],
        series,
        height: 360,
        minZero: true,
        yFormat: (v) => `${formatFixed(v, places)} ${rainUnit}`,
        xAxisFormat: seasonAxisLabel,
        tooltipTimeFormat: seasonAxisLabel,
        yTickDecimals: places,
        yTickPreferredStep: useMetric ? 5 : 1,
    });
}

// Synthetic calendar-year axis: Jan 1 - Dec 31, anchored at a leap reference
// year so a Feb 29 in any leap year on record has a slot to land on.
const YEAR_REF_YEAR = 2004;

function yearlyAxisMs(month, day) {
    return Date.UTC(YEAR_REF_YEAR, month - 1, day, 12);
}

function yearlyDates() {
    const dates = [];
    for (let month = 1; month <= 12; month++) {
        for (let day = 1; day <= daysInMonth(YEAR_REF_YEAR, month); day++) dates.push({ month, day });
    }
    return dates;
}

const yearlyAxisFmt = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric" });
function yearlyAxisLabel(ms) {
    return yearlyAxisFmt.format(new Date(ms));
}

// One mean-temperature series per calendar year. Unlike the rain chart,
// there's no "carry forward" here — a missing day is a genuine gap in the
// line, not an implied unchanged value — and a day past today again just
// stops the current year's line rather than it being absent in the first
// place (there are no future rows to be absent).
function aggregateYearlyTemp(byDate, today, years) {
    const todayStr = `${today.year}-${pad2(today.month)}-${pad2(today.day)}`;
    const dates = yearlyDates();
    const points = dates.map(({ month, day }) => ({ t: yearlyAxisMs(month, day) }));

    for (const year of years) {
        const key = `y${year}`;
        for (let i = 0; i < dates.length; i++) {
            const { month, day } = dates[i];
            const dateStr = `${year}-${pad2(month)}-${pad2(day)}`;
            if (dateStr > todayStr) {
                points[i][key] = null;
                continue;
            }
            const row = byDate.get(dateStr);
            points[i][key] = row && typeof row.meanF === "number" ? row.meanF : null;
        }
    }
    return points;
}

function renderYearlyTempChart(points, years) {
    const card = chartCard("yearly-temp");
    const tempUnit = useMetric ? "°C" : "°F";
    const convert = (f) => (useMetric ? fToC(f) : f);

    const series = years.map((year, i) => {
        const key = `y${year}`;
        const { color, opacity } = tempSeriesStyle(i, years.length);
        return {
            color,
            opacity,
            label: String(year),
            strokeWidth: strokeWidthForIndex(i, years.length),
            getValue: (p) => (typeof p[key] === "number" ? convert(p[key]) : null),
        };
    });
    renderLegend(card, series);

    renderTimeChart({
        wrapEl: card.querySelector(".chart-wrap"),
        xaxisEl: card.querySelector(".chart-xaxis"),
        points,
        xDomain: [yearlyAxisMs(1, 1), yearlyAxisMs(12, 31)],
        series,
        height: 360,
        yFormat: (v) => `${formatFixed(v, 1)}${tempUnit}`,
        yAxisFormat: (v) => `${formatFixed(v, 0)}°`,
        xAxisFormat: yearlyAxisLabel,
        tooltipTimeFormat: yearlyAxisLabel,
    });
}

function clearCharts() {
    for (const svg of document.querySelectorAll("#season-rain-charts .chart-svg, #yearly-temp-charts .chart-svg")) {
        while (svg.firstChild) svg.removeChild(svg.firstChild);
    }
}

function render() {
    els.unitToggle.textContent = useMetric ? "°C" : "°F";

    if (days.length === 0) {
        els.seasonTableBody.innerHTML = "";
        clearCharts();
        return;
    }

    const byDate = new Map(days.map((d) => [d.date, d]));
    const today = pacificToday();
    const startYears = seasonStartYears(today);
    const years = [];
    for (let y = EARLIEST_SEASON_YEAR; y <= today.year; y++) years.push(y);

    renderSeasonRainTable(byDate, today, todayLiveRainIn);
    renderSeasonRainChart(aggregateSeasonRain(byDate, today, startYears, todayLiveRainIn), startYears);
    renderYearlyTempChart(aggregateYearlyTemp(byDate, today, years), years);
}

async function fetchJson(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Request failed: ${res.status}`);
    return res.json();
}

// The whole page is one bulk fetch of the entire daily record, computed
// client-side from there — there's no narrower "range" a user could pick
// that would make a second request worthwhile the way the History page's
// month/year controls do.
async function loadAll() {
    setStatus("Loading full history…");
    const today = pacificToday();
    const todayStr = `${today.year}-${pad2(today.month)}-${pad2(today.day)}`;

    const historyPromise = fetchJson(`/api/history-range?start=${EARLIEST_SEASON_YEAR}-07-01&end=${todayStr}`);
    // Best-effort, same spirit as the dashboard's own rain jars: the live
    // station reading only ever stands in for today's not-yet-finalized
    // spreadsheet row, so a failure here just leaves today's point as a flat
    // carry-forward (as if nothing had fallen yet) rather than failing the
    // whole page.
    const currentPromise = fetchJson("/api/current").catch(() => null);

    try {
        const [data, current] = await Promise.all([historyPromise, currentPromise]);
        if (!data || !Array.isArray(data.days)) throw new Error("Unexpected response shape");
        days = data.days;
        todayLiveRainIn = typeof current?.dailyrainin === "number" ? current.dailyrainin : null;
        setStatus(days.length === 0 ? "No data available." : "");
        render();
    } catch (err) {
        days = [];
        todayLiveRainIn = null;
        setStatus("Unable to load yearly comparisons right now.", "error");
        render();
    }
}

els.unitToggle.addEventListener("click", () => {
    useMetric = !useMetric;
    localStorage.setItem("units", useMetric ? "metric" : "imperial");
    render();
});

loadAll();

// This page has no other reason to fetch live station data, so the banner
// swap (shared with the other pages via banner.js) runs on its own
// independent poll.
fetchCurrentForBanner();
setInterval(fetchCurrentForBanner, BANNER_POLL_INTERVAL_MS);
