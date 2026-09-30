// Worker entry point: serves the static dashboard from the assets binding and
// proxies /api/current to Ambient Weather, so the API key and application key
// never reach the browser. Set AMBIENT_API_KEY, AMBIENT_APPLICATION_KEY, and
// AMBIENT_MAC_ADDRESS as Worker environment variables/secrets (dashboard, or
// .dev.vars locally) — never commit them.

// Apps Script webapp backing a hand-maintained daily-observations spreadsheet.
// Not a secret (it's a public webapp URL), but proxied here for a consistent
// architecture and to sidestep its redirect-to-googleusercontent.com hop.
const SHEETS_API_URL =
    "https://script.google.com/macros/s/AKfycbw0LodV_rPSxFXvf1jOOE-oYzU4jJq_-RagrsP8VMAbDmnMdNBf5PaHnf39GRt5dCN-4g/exec";

export default {
    async fetch(request, env) {
        const url = new URL(request.url);

        if (url.pathname === "/api/current") {
            return handleCurrent(env);
        }

        if (url.pathname === "/api/history") {
            return handleHistory(env);
        }

        if (url.pathname === "/api/season-rain") {
            return handleSeasonRain();
        }

        if (url.pathname === "/api/month-rain") {
            return handleMonthRain();
        }

        return env.ASSETS.fetch(request);
    },
};

async function handleCurrent(env) {
    const { AMBIENT_API_KEY, AMBIENT_APPLICATION_KEY, AMBIENT_MAC_ADDRESS } = env;

    if (!AMBIENT_API_KEY || !AMBIENT_APPLICATION_KEY || !AMBIENT_MAC_ADDRESS) {
        return jsonResponse({ error: "Server is missing Ambient Weather credentials." }, 500);
    }

    // /v1/devices (no MAC in the path) returns each device's `lastData` — Ambient
    // Weather's persistent last-known-reading snapshot. /v1/devices/{mac} is the
    // historical-data endpoint (for graphs) and can come back empty if the
    // station hasn't reported within its retention window, even though the
    // device itself still has a valid last reading.
    const upstreamUrl = new URL("https://api.ambientweather.net/v1/devices");
    upstreamUrl.searchParams.set("apiKey", AMBIENT_API_KEY);
    upstreamUrl.searchParams.set("applicationKey", AMBIENT_APPLICATION_KEY);

    let upstream;
    try {
        upstream = await fetch(upstreamUrl);
    } catch (err) {
        return jsonResponse({ error: "Failed to reach Ambient Weather." }, 502);
    }

    if (!upstream.ok) {
        return jsonResponse(
            { error: `Ambient Weather returned ${upstream.status}` },
            upstream.status === 429 ? 429 : 502
        );
    }

    const devices = await upstream.json();
    const device = Array.isArray(devices)
        ? devices.find((d) => d.macAddress === AMBIENT_MAC_ADDRESS) ?? devices[0]
        : null;

    if (!device?.lastData) {
        return jsonResponse({ error: "No data returned for this station." }, 502);
    }

    return jsonResponse(device.lastData, 200, { "cache-control": "public, max-age=30" });
}

// Today's high/low and the "from yesterday" comparison, both derived from a
// single 24-hour history pull. The station reports every 5 minutes, so the
// API's max limit (288) lines up exactly with a 24-hour window, newest first.
async function handleHistory(env) {
    const { AMBIENT_API_KEY, AMBIENT_APPLICATION_KEY, AMBIENT_MAC_ADDRESS } = env;

    if (!AMBIENT_API_KEY || !AMBIENT_APPLICATION_KEY || !AMBIENT_MAC_ADDRESS) {
        return jsonResponse({ error: "Server is missing Ambient Weather credentials." }, 500);
    }

    const upstreamUrl = new URL(`https://api.ambientweather.net/v1/devices/${AMBIENT_MAC_ADDRESS}`);
    upstreamUrl.searchParams.set("apiKey", AMBIENT_API_KEY);
    upstreamUrl.searchParams.set("applicationKey", AMBIENT_APPLICATION_KEY);
    upstreamUrl.searchParams.set("limit", "288");

    let upstream;
    try {
        upstream = await fetch(upstreamUrl);
    } catch (err) {
        return jsonResponse({ error: "Failed to reach Ambient Weather." }, 502);
    }

    if (!upstream.ok) {
        return jsonResponse(
            { error: `Ambient Weather returned ${upstream.status}` },
            upstream.status === 429 ? 429 : 502
        );
    }

    const readings = await upstream.json();
    if (!Array.isArray(readings) || readings.length === 0) {
        return jsonResponse({ error: "No history returned for this station." }, 502);
    }

    // Bucket by Pacific calendar day so "today" means the station's local day,
    // not a rolling 24 hours.
    const dayFmt = new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/Los_Angeles",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    });
    const today = dayFmt.format(new Date());

    // A "sunshine hour" is an hour where solar radiation clears 120 W/m^2. At a
    // 5-minute reporting interval that's 12 datapoints per hour, so counting
    // today's datapoints above the threshold and dividing by 12 gives hours.
    const SUNSHINE_THRESHOLD_WM2 = 120;
    const SUNSHINE_POINTS_PER_HOUR = 12;

    let todayHigh = null;
    let todayLow = null;
    let sunshinePoints = 0;
    for (const r of readings) {
        if (dayFmt.format(new Date(r.dateutc)) !== today) continue;
        if (typeof r.tempf === "number") {
            if (todayHigh === null || r.tempf > todayHigh) todayHigh = r.tempf;
            if (todayLow === null || r.tempf < todayLow) todayLow = r.tempf;
        }
        if (typeof r.solarradiation === "number" && r.solarradiation > SUNSHINE_THRESHOLD_WM2) {
            sunshinePoints++;
        }
    }
    const sunshineHours = sunshinePoints / SUNSHINE_POINTS_PER_HOUR;

    const dayAgoMs = Date.now() - 24 * 60 * 60 * 1000;
    const yesterday = readings.reduce((closest, r) =>
        Math.abs(r.dateutc - dayAgoMs) < Math.abs(closest.dateutc - dayAgoMs) ? r : closest
    );

    return jsonResponse(
        {
            todayHigh,
            todayLow,
            yesterdayTempF: typeof yesterday?.tempf === "number" ? yesterday.tempf : null,
            yesterdayAt: yesterday?.dateutc ?? null,
            sunshineHours,
        },
        200,
        { "cache-control": "public, max-age=120" }
    );
}

function pacificDateParts(date) {
    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/Los_Angeles",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).formatToParts(date);
    const get = (type) => Number(parts.find((p) => p.type === type).value);
    return { year: get("year"), month: get("month"), day: get("day") };
}

function pacificDateString(date) {
    const { year, month, day } = pacificDateParts(date);
    return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

// The user's rain season always starts July 1st — not a meteorological
// quarter — and rolls into the next calendar year's Jan-Jun stretch.
function getRainSeasonStart(now) {
    const { year, month } = pacificDateParts(now);
    const seasonYear = month >= 7 ? year : year - 1;
    return `${seasonYear}-07-01`;
}

// Fetches the spreadsheet's daily rows over [startDate, endDate] (endDate
// omitted means "through today", per the sheet API's own default).
async function fetchSheetRows(startDate, endDate) {
    const upstreamUrl = new URL(SHEETS_API_URL);
    upstreamUrl.searchParams.set("start", startDate);
    if (endDate) upstreamUrl.searchParams.set("end", endDate);

    let upstream;
    try {
        upstream = await fetch(upstreamUrl);
    } catch (err) {
        return { error: "Failed to reach weather spreadsheet." };
    }

    if (!upstream.ok) {
        return { error: `Spreadsheet API returned ${upstream.status}` };
    }

    const rows = await upstream.json();
    if (!Array.isArray(rows)) {
        return { error: "Unexpected spreadsheet response shape." };
    }

    return { rows };
}

function sumPrecip(rows) {
    return rows.reduce((sum, row) => {
        const precip = row["Precip (in)"];
        return sum + (typeof precip === "number" ? precip : 0);
    }, 0);
}

function tempRange(rows) {
    let high = null;
    let low = null;
    for (const row of rows) {
        const rowHigh = row["High Temp (F)"];
        const rowLow = row["Low Temp (F)"];
        if (typeof rowHigh === "number" && (high === null || rowHigh > high)) high = rowHigh;
        if (typeof rowLow === "number" && (low === null || rowLow < low)) low = rowLow;
    }
    return { high, low };
}

// Season-to-date rain, summed from the spreadsheet — Ambient Weather's device
// only tracks day/week/month/year/total rain, nothing season-scoped.
async function handleSeasonRain() {
    const startDate = getRainSeasonStart(new Date());

    const { rows, error } = await fetchSheetRows(startDate);
    if (error) return jsonResponse({ error }, 502);

    return jsonResponse(
        { seasonRainIn: sumPrecip(rows), seasonStart: startDate },
        200,
        { "cache-control": "public, max-age=3600" }
    );
}

// Month-to-date rain and temperature range, both computed as the
// spreadsheet's figures through *yesterday* — the client combines these with
// today's live station reading. Kept separate because the spreadsheet and
// the station occasionally disagree on today's still-in-progress numbers
// (station hiccups), so a bad spreadsheet row for today can't throw off the
// whole month.
async function handleMonthRain() {
    const now = new Date();
    const { year, month } = pacificDateParts(now);
    const monthStart = `${year}-${String(month).padStart(2, "0")}-01`;
    const yesterday = pacificDateString(new Date(now.getTime() - 24 * 60 * 60 * 1000));

    if (yesterday < monthStart) {
        return jsonResponse(
            { monthToYesterdayIn: 0, monthHighThroughYesterdayF: null, monthLowThroughYesterdayF: null, monthStart },
            200,
            { "cache-control": "public, max-age=3600" }
        );
    }

    const { rows, error } = await fetchSheetRows(monthStart, yesterday);
    if (error) return jsonResponse({ error }, 502);

    const { high, low } = tempRange(rows);

    return jsonResponse(
        {
            monthToYesterdayIn: sumPrecip(rows),
            monthHighThroughYesterdayF: high,
            monthLowThroughYesterdayF: low,
            monthStart,
        },
        200,
        { "cache-control": "public, max-age=3600" }
    );
}

function jsonResponse(body, status, extraHeaders = {}) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json", ...extraHeaders },
    });
}
