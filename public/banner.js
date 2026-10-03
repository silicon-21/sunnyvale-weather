// Shared "swap the banner photo when it's hot out" logic, used by all three
// pages. The dashboard already polls /api/current every minute for its own
// tiles and just feeds that reading in; the forecast and history pages
// don't otherwise fetch live station data, so they poll independently via
// fetchCurrentForBanner() — kept separate from each page's own fetch/render
// cycle so a slow or failed request there never holds up the banner, and
// vice versa.

const BANNER_NORMAL_SRC = "banner.jpg";
const BANNER_HEAT_SRC = "heatabnormal.png";
const HEAT_BANNER_THRESHOLD_F = 90;
const BANNER_POLL_INTERVAL_MS = 60_000;
const HEAT_ABNORMAL = "https://www.youtube.com/watch?v=b2NTglk9tvI";

// Always keyed on raw °F so it doesn't flip based on the page's display unit.
function renderBanner(tempf) {
    if (typeof tempf !== "number") return;
    const banner = document.getElementById("banner");
    if (!banner) return;

    const isHeat = tempf >= HEAT_BANNER_THRESHOLD_F;
    const targetSrc = isHeat ? BANNER_HEAT_SRC : BANNER_NORMAL_SRC;
    if (!banner.getAttribute("src").endsWith(targetSrc)) {
        banner.src = targetSrc;
        banner.alt = isHeat ? "Heat abnormal" : "Fog over the hills above Sunnyvale";
    }

    // The banner is only a link to the music video while it's actually
    // showing the heat-abnormal photo — an <a> with no href attribute isn't
    // focusable or clickable, so this alone disables it the rest of the time.
    const link = document.getElementById("banner-link");
    if (link) {
        if (isHeat) {
            link.href = HEAT_ABNORMAL;
        } else {
            link.removeAttribute("href");
        }
    }
}

async function fetchCurrentForBanner() {
    try {
        const res = await fetch("/api/current");
        if (!res.ok) return;
        const data = await res.json();
        renderBanner(data?.tempf);
    } catch (err) {
        // Non-critical — banner just stays on whatever it was last set to.
    }
}
