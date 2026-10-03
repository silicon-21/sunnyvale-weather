// Shared SVG time-series chart engine, used by the dashboard's history
// graphs (script.js) and the forecast page's hourly graphs (forecast.js).
// Every chart renders into a fixed CHART_W x `height` viewBox that scales
// with its container via the SVG's own width:100%, so hover math has to work
// in viewBox units (see ensureChartHover) rather than screen pixels.

const CHART_W = 600;
const CHART_PAD = { left: 36, right: 8, top: 10, bottom: 6 };
const X_TICK_FRACTIONS = [0, 0.25, 0.5, 0.75, 1];

const clockFmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", hour: "numeric", minute: "2-digit" });
function formatClockTime(ms) {
    return clockFmt.format(new Date(ms));
}

function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
}

function svgEl(tag, attrs) {
    const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
    return el;
}

// Pads the data's own min/max rather than using fixed scales — these are
// auto-scaled so e.g. a calm day's wind chart isn't all flat line at the
// bottom of a 0-40 scale. minZero forces the floor to 0 for quantities that
// can't go negative.
function niceDomain(values, { minZero = false } = {}) {
    const nums = values.filter((v) => typeof v === "number" && !Number.isNaN(v));
    if (nums.length === 0) return [0, 1];
    const min = Math.min(...nums);
    const max = Math.max(...nums);
    if (minZero) return [0, max <= 0 ? 1 : max * 1.15];
    if (min === max) return [min - 1, max + 1];
    const pad = (max - min) * 0.15;
    return [min - pad, max + pad];
}

function autoTicks([lo, hi], count) {
    const ticks = [];
    for (let i = 0; i <= count; i++) ticks.push(lo + ((hi - lo) * i) / count);
    return ticks;
}

// Five labels under the plot, evenly spaced at X_TICK_FRACTIONS. Defaults to
// the dashboard's fixed day-boundary labels (every dashboard chart spans
// exactly one Pacific midnight-to-midnight day); pass `xAxisFormat` to derive
// labels from the chart's actual xDomain instead — needed wherever the
// domain isn't a full day.
function renderXAxisLabels(xaxisEl, xDomain, xAxisFormat) {
    xaxisEl.innerHTML = "";
    const labels = xAxisFormat
        ? X_TICK_FRACTIONS.map((frac) => xAxisFormat(xDomain[0] + frac * (xDomain[1] - xDomain[0])))
        : ["12am", "6am", "12pm", "6pm", "12am"];
    for (const label of labels) {
        const span = document.createElement("span");
        span.textContent = label;
        xaxisEl.appendChild(span);
    }
}

// Hover/touch crosshair + tooltip, bound once per chart and driven off
// whatever `wrapEl._chartState` the most recent render left behind — so a
// re-render just swaps the state the listener reads, no listener churn.
function ensureChartHover(wrapEl) {
    if (wrapEl.dataset.hoverBound) return;
    wrapEl.dataset.hoverBound = "1";
    const svg = wrapEl.querySelector(".chart-svg");
    const tooltip = wrapEl.querySelector(".chart-tooltip");

    function update(clientX) {
        const state = wrapEl._chartState;
        if (!state) return;
        const rect = svg.getBoundingClientRect();
        if (rect.width === 0) return;

        // The plotted data only spans [state.plotLeft, state.plotRight] of the
        // viewBox (the rest is the y-axis label gutter), so the cursor
        // fraction has to be measured against that inset range, not the full
        // SVG width — otherwise every lookup resolves to a later point than
        // the cursor's actual position.
        const localX = clamp(clientX - rect.left, 0, rect.width);
        const viewBoxX = (localX / rect.width) * CHART_W;
        const { plotLeft, plotRight } = state;
        const relX = clamp((viewBoxX - plotLeft) / (plotRight - plotLeft), 0, 1);
        const xValue = state.xDomain[0] + relX * (state.xDomain[1] - state.xDomain[0]);

        let nearest = null;
        let nearestDist = Infinity;
        for (const p of state.points) {
            const d = Math.abs(p.t - xValue);
            if (d < nearestDist) {
                nearestDist = d;
                nearest = p;
            }
        }
        if (!nearest) return;

        const px = state.scaleX(nearest.t);
        state.crosshair.setAttribute("x1", px);
        state.crosshair.setAttribute("x2", px);
        state.crosshair.removeAttribute("display");

        tooltip.innerHTML = "";
        const timeEl = document.createElement("div");
        timeEl.className = "tooltip-time";
        timeEl.textContent = (state.tooltipTimeFormat ?? formatClockTime)(nearest.t);
        tooltip.appendChild(timeEl);

        for (const s of state.series) {
            const value = s.getValue(nearest);
            if (typeof value !== "number" || Number.isNaN(value)) continue;
            const format = s.format ?? state.yFormat;
            const row = document.createElement("div");
            row.className = "tooltip-row";
            const dot = document.createElement("span");
            dot.className = "tooltip-dot";
            dot.style.background = s.color;
            row.appendChild(dot);
            const text = document.createElement("span");
            text.textContent = s.label ? `${s.label}: ${format(value)}` : format(value);
            row.appendChild(text);
            tooltip.appendChild(row);
        }

        tooltip.hidden = false;
        const wrapWidth = wrapEl.clientWidth;
        const tooltipWidth = tooltip.offsetWidth;
        const pxReal = (px / CHART_W) * wrapWidth;
        let left = pxReal + 10;
        if (left + tooltipWidth > wrapWidth) left = pxReal - tooltipWidth - 10;
        tooltip.style.left = `${clamp(left, 0, Math.max(0, wrapWidth - tooltipWidth))}px`;
    }

    function hide() {
        tooltip.hidden = true;
        if (wrapEl._chartState) wrapEl._chartState.crosshair.setAttribute("display", "none");
    }

    svg.addEventListener("pointermove", (e) => update(e.clientX));
    svg.addEventListener("pointerdown", (e) => update(e.clientX));
    svg.addEventListener("pointerleave", hide);
}

// Width (in viewBox units) for one bar in a `mode: "bar"` series — derived
// from the typical spacing between the chart's own points (so it adapts to
// a month of daily bars vs. a year of them) rather than a fixed constant,
// leaving a visible gap between bars.
function barWidth(pts, scaleX, plotWidth) {
    if (pts.length < 2) return plotWidth * 0.1;
    const gaps = pts.slice(1).map((p, i) => scaleX(p.t) - scaleX(pts[i].t)).sort((a, b) => a - b);
    const median = gaps[Math.floor(gaps.length / 2)];
    return Math.max(median * 0.7, 1);
}

// Generic time-series renderer shared by every chart on both pages. `series`
// entries are { color, label, getValue(point), area?, mode?, format?, opacity? }.
// `opacity` (line mode only) fades a series — e.g. a climatological average
// plotted in the same hue as its recorded counterpart, but lighter.
// Per-series `mode: "scatter"` (overriding the chart-level default) draws
// dots instead of a connected line — used for wind direction, which wraps at
// 0/360, and for event-like readings (a gust, say) rather than a continuous
// quantity. `mode: "bar"` draws one rect per point, anchored to the 0
// baseline — used for daily/monthly rainfall totals, where each point is a
// discrete period rather than a continuous reading. `format` overrides the
// chart-level `yFormat` for that series' tooltip row only — used when series
// share one scale but not a unit (rain total vs. rate). `xAxisFormat`
// overrides the default fixed day-boundary x-axis labels — see
// renderXAxisLabels. `tooltipTimeFormat` overrides the tooltip's own time
// line (default: a clock time) — needed wherever a point represents a whole
// day rather than a moment within one.
function renderTimeChart({
    wrapEl,
    xaxisEl,
    points,
    xDomain,
    series,
    height,
    yFormat,
    yAxisFormat,
    xAxisFormat,
    tooltipTimeFormat,
    mode = "line",
    yDomain: yDomainOverride,
    yTicks: yTicksOverride,
    minZero = false,
}) {
    const svg = wrapEl.querySelector(".chart-svg");
    svg.setAttribute("viewBox", `0 0 ${CHART_W} ${height}`);
    while (svg.firstChild) svg.removeChild(svg.firstChild);

    const yDomain = yDomainOverride ?? niceDomain(points.flatMap((p) => series.map((s) => s.getValue(p))), { minZero });
    const axisFormat = yAxisFormat ?? yFormat;

    const plotLeft = CHART_PAD.left;
    const plotRight = CHART_W - CHART_PAD.right;
    const plotTop = CHART_PAD.top;
    const plotBottom = height - CHART_PAD.bottom;

    const scaleX = (t) => plotLeft + ((t - xDomain[0]) / (xDomain[1] - xDomain[0])) * (plotRight - plotLeft);
    const scaleY = (v) => plotBottom - ((v - yDomain[0]) / (yDomain[1] - yDomain[0])) * (plotBottom - plotTop);

    // Vertical gridlines at the same times the x-axis labels mark.
    for (const frac of X_TICK_FRACTIONS) {
        const x = plotLeft + frac * (plotRight - plotLeft);
        svg.appendChild(svgEl("line", { x1: x, x2: x, y1: plotTop, y2: plotBottom, class: "chart-grid-line" }));
    }

    const yTicks = yTicksOverride ?? autoTicks(yDomain, 4).map((v) => ({ value: v, label: axisFormat(v) }));
    for (const tick of yTicks) {
        const y = scaleY(tick.value);
        svg.appendChild(svgEl("line", { x1: plotLeft, x2: plotRight, y1: y, y2: y, class: "chart-grid-line" }));
        const text = svgEl("text", { x: 2, y: y + 3, class: "chart-axis-text" });
        text.textContent = tick.label;
        svg.appendChild(text);
    }

    for (const s of series) {
        const seriesMode = s.mode ?? mode;
        const pts = points
            .map((p) => ({ t: p.t, v: s.getValue(p) }))
            .filter((p) => typeof p.v === "number" && !Number.isNaN(p.v));
        if (pts.length === 0) continue;

        if (seriesMode === "scatter") {
            for (const p of pts) {
                const dot = svgEl("circle", { cx: scaleX(p.t), cy: scaleY(p.v), r: 2.4, class: "chart-scatter-dot" });
                dot.style.fill = s.color;
                svg.appendChild(dot);
            }
            continue;
        }

        if (seriesMode === "bar") {
            const width = barWidth(pts, scaleX, plotRight - plotLeft);
            const baseline = scaleY(Math.max(yDomain[0], 0));
            for (const p of pts) {
                const cx = scaleX(p.t);
                const y = scaleY(p.v);
                const rect = svgEl("rect", {
                    x: cx - width / 2,
                    y: Math.min(y, baseline),
                    width,
                    height: Math.abs(baseline - y),
                    class: "chart-bar",
                });
                rect.style.fill = s.color;
                svg.appendChild(rect);
            }
            continue;
        }

        if (s.area) {
            const baseline = scaleY(Math.max(yDomain[0], 0));
            let d = `M ${scaleX(pts[0].t)},${baseline}`;
            for (const p of pts) d += ` L ${scaleX(p.t)},${scaleY(p.v)}`;
            d += ` L ${scaleX(pts[pts.length - 1].t)},${baseline} Z`;
            const area = svgEl("path", { d, class: "chart-series-area" });
            area.style.fill = s.color;
            svg.appendChild(area);
        }

        let d = `M ${scaleX(pts[0].t)},${scaleY(pts[0].v)}`;
        for (const p of pts.slice(1)) d += ` L ${scaleX(p.t)},${scaleY(p.v)}`;
        const path = svgEl("path", { d, class: "chart-series-line", "vector-effect": "non-scaling-stroke" });
        path.style.stroke = s.color;
        if (typeof s.opacity === "number") path.style.opacity = s.opacity;
        svg.appendChild(path);
    }

    const crosshair = svgEl("line", {
        x1: plotLeft,
        x2: plotLeft,
        y1: plotTop,
        y2: plotBottom,
        class: "chart-crosshair",
        "vector-effect": "non-scaling-stroke",
        display: "none",
    });
    svg.appendChild(crosshair);

    wrapEl._chartState = { xDomain, points, series, scaleX, yFormat, tooltipTimeFormat, crosshair, plotLeft, plotRight };
    ensureChartHover(wrapEl);

    renderXAxisLabels(xaxisEl, xDomain, xAxisFormat);
}
