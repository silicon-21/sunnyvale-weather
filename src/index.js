// Worker entry point: serves the static dashboard from the assets binding and
// proxies /api/current to Ambient Weather, so the API key and application key
// never reach the browser. Set AMBIENT_API_KEY, AMBIENT_APPLICATION_KEY, and
// AMBIENT_MAC_ADDRESS as Worker environment variables/secrets (dashboard, or
// .dev.vars locally) — never commit them.

export default {
    async fetch(request, env) {
        const url = new URL(request.url);

        if (url.pathname === "/api/current") {
            return handleCurrent(env);
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

function jsonResponse(body, status, extraHeaders = {}) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json", ...extraHeaders },
    });
}
