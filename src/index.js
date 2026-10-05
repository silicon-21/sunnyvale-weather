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

// Approximate station location, used only to resolve the NWS forecast
// gridpoint and active alerts — the National Weather Service's grid
// resolution (~2.5km) makes a precise rooftop coordinate unnecessary.
const STATION_LAT = 37.3688;
const STATION_LON = -122.0363;

// api.weather.gov asks every client to identify itself in the User-Agent
// (no API key is used). This is a generic app identifier, not tied to any
// individual.
const NWS_USER_AGENT = "sunnyvale-weather-dashboard (Cloudflare Worker)";

export default {
    async fetch(request, env) {
        const url = new URL(request.url);

        if (url.pathname === "/api/current") {
            return handleCurrent(env);
        }

        if (url.pathname === "/api/history") {
            return handleHistory(env, url.searchParams.get("date"));
        }

        if (url.pathname === "/api/season-rain") {
            return handleSeasonRain();
        }

        if (url.pathname === "/api/month-rain") {
            return handleMonthRain();
        }

        if (url.pathname === "/api/forecast") {
            return handleForecast();
        }

        if (url.pathname === "/api/history-range") {
            return handleHistoryRange(url.searchParams.get("start"), url.searchParams.get("end"));
        }

        if (url.pathname === "/api/month-records") {
            return handleMonthRecords(url.searchParams.get("month"));
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
// single 24-hour history pull, plus the day's raw points for the graphs. The
// station reports every 5 minutes, so the API's max limit (288) lines up
// exactly with a 24-hour window, newest first.
//
// `requestedDate` (a "YYYY-MM-DD" Pacific date string, from the graphs' date
// picker) switches this to a specific past day instead of today: the
// upstream request is bounded with `endDate` at that day's Pacific midnight,
// and the today-only stats (todayHigh/sunshineHours/yesterday delta) are
// skipped, since those are the main dashboard's and always mean *today*
// regardless of what the graphs are showing.
async function handleHistory(env, requestedDate) {
    const { AMBIENT_API_KEY, AMBIENT_APPLICATION_KEY, AMBIENT_MAC_ADDRESS } = env;

    if (!AMBIENT_API_KEY || !AMBIENT_APPLICATION_KEY || !AMBIENT_MAC_ADDRESS) {
        return jsonResponse({ error: "Server is missing Ambient Weather credentials." }, 500);
    }

    const now = new Date();
    const isValidDateString = typeof requestedDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(requestedDate);
    const isToday = !isValidDateString || requestedDate === pacificDateString(now);
    const { dayStartMs, dayEndMs } = isToday ? pacificDayBoundsMs(now) : pacificDayBoundsMs(parsePacificDateString(requestedDate));

    const upstreamUrl = new URL(`https://api.ambientweather.net/v1/devices/${AMBIENT_MAC_ADDRESS}`);
    upstreamUrl.searchParams.set("apiKey", AMBIENT_API_KEY);
    upstreamUrl.searchParams.set("applicationKey", AMBIENT_APPLICATION_KEY);
    if (isToday) {
        upstreamUrl.searchParams.set("limit", "288");
    } else {
        // A few extra past a full day's 288 readings, so that if Ambient's
        // `endDate` bound turns out to be inclusive of the next day's first
        // reading, that doesn't crowd the target day's own first reading out
        // of the limit — the explicit dayStartMs/dayEndMs filter below trims
        // back to exactly the requested day either way.
        upstreamUrl.searchParams.set("limit", "300");
        upstreamUrl.searchParams.set("endDate", String(dayEndMs));
    }

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

    // A "sunshine hour" is an hour where solar radiation clears 120 W/m^2. At a
    // 5-minute reporting interval that's 12 datapoints per hour, so counting
    // the day's datapoints above the threshold and dividing by 12 gives hours.
    const SUNSHINE_THRESHOLD_WM2 = 120;
    const SUNSHINE_POINTS_PER_HOUR = 12;

    let dayHigh = null;
    let dayLow = null;
    let sunshinePoints = 0;
    const points = [];
    for (const r of readings) {
        if (r.dateutc < dayStartMs || r.dateutc >= dayEndMs) continue;
        if (typeof r.tempf === "number") {
            if (dayHigh === null || r.tempf > dayHigh) dayHigh = r.tempf;
            if (dayLow === null || r.tempf < dayLow) dayLow = r.tempf;
        }
        if (typeof r.solarradiation === "number" && r.solarradiation > SUNSHINE_THRESHOLD_WM2) {
            sunshinePoints++;
        }
        points.push({
            t: r.dateutc,
            tempf: r.tempf,
            feelsLike: r.feelsLike,
            dewPoint: r.dewPoint,
            windspeedmph: r.windspeedmph,
            windgustmph: r.windgustmph,
            winddir: r.winddir,
            dailyrainin: r.dailyrainin,
            hourlyrainin: r.hourlyrainin,
            baromrelin: r.baromrelin,
            solarradiation: r.solarradiation,
        });
    }
    points.sort((a, b) => a.t - b.t);

    if (!isToday) {
        // A past day is immutable once it's over, so this can cache much
        // longer than "today," which is still filling in.
        return jsonResponse({ dayStartMs, dayEndMs, points }, 200, { "cache-control": "public, max-age=86400" });
    }

    const sunshineHours = sunshinePoints / SUNSHINE_POINTS_PER_HOUR;
    const dayAgoMs = Date.now() - 24 * 60 * 60 * 1000;
    const yesterday = readings.reduce((closest, r) =>
        Math.abs(r.dateutc - dayAgoMs) < Math.abs(closest.dateutc - dayAgoMs) ? r : closest
    );

    return jsonResponse(
        {
            todayHigh: dayHigh,
            todayLow: dayLow,
            yesterdayTempF: typeof yesterday?.tempf === "number" ? yesterday.tempf : null,
            yesterdayAt: yesterday?.dateutc ?? null,
            sunshineHours,
            dayStartMs,
            dayEndMs,
            points,
        },
        200,
        { "cache-control": "public, max-age=120" }
    );
}

function pacificUtcOffsetMinutes(date) {
    const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Los_Angeles",
        timeZoneName: "shortOffset",
    }).formatToParts(date);
    const offset = parts.find((p) => p.type === "timeZoneName")?.value ?? "GMT-8";
    const match = offset.match(/GMT([+-]\d+)/);
    return match ? Number(match[1]) * 60 : -480;
}

// A Pacific calendar day's [start, end) bounds, in UTC ms, derived from that
// instant's current UTC offset rather than hardcoding PST/PDT.
function pacificDayBoundsMs(date) {
    const offsetMinutes = pacificUtcOffsetMinutes(date);
    const { year, month, day } = pacificDateParts(date);
    const dayStartMs = Date.UTC(year, month - 1, day, 0, 0, 0) - offsetMinutes * 60_000;
    return { dayStartMs, dayEndMs: dayStartMs + 24 * 60 * 60 * 1000 };
}

// A "YYYY-MM-DD" date string has no instant of its own — this just needs
// *some* instant on that calendar date to resolve PST vs. PDT for it, so
// noon UTC (safely clear of the date's actual midnight boundaries in either
// direction) stands in.
function parsePacificDateString(dateString) {
    const [year, month, day] = dateString.split("-").map(Number);
    return new Date(Date.UTC(year, month - 1, day, 12));
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

// Daily high/mean/low temperature and precipitation over an arbitrary date
// range, sourced from the same hand-maintained spreadsheet as the rain
// tiles — Ambient Weather's own history endpoint only retains a rolling
// window, not the years of daily data the History tab's month/year charts
// need. `start`/`end` are both required "YYYY-MM-DD" strings.
async function handleHistoryRange(start, end) {
    const isDateString = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
    if (!isDateString(start) || !isDateString(end)) {
        return jsonResponse({ error: "start and end must be YYYY-MM-DD dates." }, 400);
    }

    const { rows, error } = await fetchSheetRows(start, end);
    if (error) return jsonResponse({ error }, 502);

    return jsonResponse(
        {
            days: rows.map((row) => ({
                date: row["Date"],
                highF: typeof row["High Temp (F)"] === "number" ? row["High Temp (F)"] : null,
                meanF: typeof row["Daily Mean (F)"] === "number" ? row["Daily Mean (F)"] : null,
                lowF: typeof row["Low Temp (F)"] === "number" ? row["Low Temp (F)"] : null,
                precipIn: typeof row["Precip (in)"] === "number" ? row["Precip (in)"] : null,
                avgHighF: typeof row["Avg High Temp (F)"] === "number" ? row["Avg High Temp (F)"] : null,
                avgMeanF: typeof row["Avg Daily Mean(F)"] === "number" ? row["Avg Daily Mean(F)"] : null,
                avgLowF: typeof row["Avg Low Temp (F)"] === "number" ? row["Avg Low Temp (F)"] : null,
            })),
        },
        200,
        { "cache-control": "public, max-age=3600" }
    );
}

// The spreadsheet's recorded daily history starts in September 2018 — see
// the matching client-side constant in history.js.
const EARLIEST_YEAR = 2018;

// Date's month argument is 0-indexed, so passing the 1-indexed `month`
// itself (not month - 1) rolls over to the next month's day 0 — i.e. this
// month's last day.
function daysInMonth(year, month) {
    return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

// Per-day temperature/rain records for a given calendar month, across every
// year the spreadsheet has data for — backs the History tab's monthly table.
// Queried as one request per year (rather than one big multi-year range)
// since only ~1/12th of each year's rows are actually wanted.
async function handleMonthRecords(monthParam) {
    const month = Number(monthParam);
    if (!Number.isInteger(month) || month < 1 || month > 12) {
        return jsonResponse({ error: "month must be an integer from 1 to 12." }, 400);
    }

    const { year: currentYear } = pacificDateParts(new Date());
    const years = [];
    for (let y = EARLIEST_YEAR; y <= currentYear; y++) years.push(y);

    const monthStr = String(month).padStart(2, "0");
    const results = await Promise.all(
        years.map((y) => fetchSheetRows(`${y}-${monthStr}-01`, `${y}-${monthStr}-${String(daysInMonth(y, month)).padStart(2, "0")}`))
    );

    // Keyed by day-of-month (1-31); tracks the record low/high/precip seen
    // for that day across every year fetched above, and which year set it.
    const byDay = new Map();
    for (let i = 0; i < years.length; i++) {
        const { rows, error } = results[i];
        if (error || !rows) continue;
        const year = years[i];

        for (const row of rows) {
            const day = Number(row["Date"]?.slice(8, 10));
            if (!day) continue;

            let entry = byDay.get(day);
            if (!entry) {
                entry = {
                    day,
                    recordLowF: null,
                    recordLowYear: null,
                    recordHighF: null,
                    recordHighYear: null,
                    recordPrecipIn: null,
                    recordPrecipYear: null,
                };
                byDay.set(day, entry);
            }

            const lowF = row["Low Temp (F)"];
            if (typeof lowF === "number" && (entry.recordLowF === null || lowF < entry.recordLowF)) {
                entry.recordLowF = lowF;
                entry.recordLowYear = year;
            }

            const highF = row["High Temp (F)"];
            if (typeof highF === "number" && (entry.recordHighF === null || highF > entry.recordHighF)) {
                entry.recordHighF = highF;
                entry.recordHighYear = year;
            }

            const precipIn = row["Precip (in)"];
            if (typeof precipIn === "number" && (entry.recordPrecipIn === null || precipIn > entry.recordPrecipIn)) {
                entry.recordPrecipIn = precipIn;
                entry.recordPrecipYear = year;
            }
        }
    }

    const days = Array.from(byDay.values()).sort((a, b) => a.day - b.day);
    return jsonResponse({ month, days }, 200, { "cache-control": "public, max-age=3600" });
}

// NWS's forecast is keyed off a gridpoint resolved from lat/lon, and active
// alerts are queried directly by point — fetched in parallel since neither
// depends on the other. The periods array is the only thing the client
// needs for the day/night forecast cards; alerts come through as-is.
async function handleForecast() {
    const pointsUrl = `https://api.weather.gov/points/${STATION_LAT},${STATION_LON}`;
    const alertsUrl = `https://api.weather.gov/alerts/active?point=${STATION_LAT},${STATION_LON}`;

    const [pointsResult, alertsResult] = await Promise.all([fetchNws(pointsUrl), fetchNws(alertsUrl)]);

    if (pointsResult.error) {
        return jsonResponse({ error: pointsResult.error }, 502);
    }

    const forecastUrl = pointsResult.data?.properties?.forecast;
    const forecastHourlyUrl = pointsResult.data?.properties?.forecastHourly;
    if (!forecastUrl || !forecastHourlyUrl) {
        return jsonResponse({ error: "NWS did not return a forecast gridpoint." }, 502);
    }

    const [forecastResult, forecastHourlyResult] = await Promise.all([fetchNws(forecastUrl), fetchNws(forecastHourlyUrl)]);
    if (forecastResult.error) {
        return jsonResponse({ error: forecastResult.error }, 502);
    }

    const periods = forecastResult.data?.properties?.periods ?? [];
    // The hourly endpoint can briefly 500 even when the daily forecast
    // succeeds — not worth failing the whole response over, since the day
    // tiles/detail panel don't depend on it.
    const hourlyPeriods = forecastHourlyResult.error ? [] : forecastHourlyResult.data?.properties?.periods ?? [];
    const alerts = alertsResult.error ? [] : alertsResult.data?.features ?? [];

    return jsonResponse(
        {
            periods: periods.map((p) => ({
                name: p.name,
                startTime: p.startTime,
                endTime: p.endTime,
                isDaytime: p.isDaytime,
                temperature: p.temperature,
                temperatureUnit: p.temperatureUnit,
                probabilityOfPrecipitation: p.probabilityOfPrecipitation?.value ?? null,
                windSpeed: p.windSpeed,
                windDirection: p.windDirection,
                icon: p.icon,
                shortForecast: p.shortForecast,
                detailedForecast: p.detailedForecast,
            })),
            hourlyPeriods: hourlyPeriods.map((p) => ({
                startTime: p.startTime,
                endTime: p.endTime,
                temperature: p.temperature,
                temperatureUnit: p.temperatureUnit,
                dewpointF: fahrenheitFromNwsQuantity(p.dewpoint),
                probabilityOfPrecipitation: p.probabilityOfPrecipitation?.value ?? null,
                windSpeed: p.windSpeed,
                windDirection: p.windDirection,
                shortForecast: p.shortForecast,
            })),
            alerts: alerts.map((f) => ({
                id: f.properties.id,
                event: f.properties.event,
                severity: f.properties.severity,
                headline: f.properties.headline,
                areaDesc: f.properties.areaDesc,
                effective: f.properties.effective,
                expires: f.properties.expires,
                description: f.properties.description,
                instruction: f.properties.instruction,
            })),
        },
        200,
        { "cache-control": "public, max-age=600" }
    );
}

// NWS's hourly periods report dewpoint as a { value, unitCode } quantity
// (wmoUnit:degC), unlike the whole-period temperature's plain-F convention —
// normalized to °F here so the client only ever deals in one unit per field.
function fahrenheitFromNwsQuantity(quantity) {
    if (typeof quantity?.value !== "number") return null;
    const isCelsius = typeof quantity.unitCode === "string" && quantity.unitCode.endsWith("degC");
    return isCelsius ? (quantity.value * 9) / 5 + 32 : quantity.value;
}

async function fetchNws(url) {
    let response;
    try {
        response = await fetch(url, {
            headers: { "User-Agent": NWS_USER_AGENT, Accept: "application/geo+json" },
        });
    } catch (err) {
        return { error: "Failed to reach the National Weather Service." };
    }

    if (!response.ok) {
        return { error: `National Weather Service returned ${response.status}` };
    }

    return { data: await response.json() };
}

function jsonResponse(body, status, extraHeaders = {}) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json", ...extraHeaders },
    });
}
