# Tide data model: merged hilo + hourly curve, fixed weekly scale

Status: accepted

## Decision

For each station we fetch two IWLS prediction series over a 7-day window and merge them: `wlp-hilo` (the exact high/low extrema, with true event times and heights) and `wlp` sampled at 60-minute resolution (the curve shape between extrema). The two are combined into a single time-ordered polyline, so the curve passes through the exact turning points while the hourly samples carry the limb shape. The graph uses one fixed vertical scale across the whole week, and heights are stored in metres as the source of truth.

## Context

This runs on Pebble hardware. App RAM, the AppMessage transport, and persistent storage (256 bytes per field) are all tight, so the cached week has to stay near 1 KB. The continuous `wlp` series returns 1,440 points per day at native resolution, roughly 10,000 points per week, which does not fit. The water in the Pacific Northwest is mixed semidiurnal with strong diurnal inequality, so the model has to show two unequal highs and two unequal lows per day and any genuine double-tide reversal.

## Considered options

- **Hilo only, with cosine interpolation between extrema.** Smallest payload and exact high/low times, but the synthetic curve cannot show a stand or shoulder (a flattening that never reverses, so it is not an extremum and never appears in the hilo series).
- **Downsampled continuous `wlp` only, computing extrema on-watch.** Real curve shape, but high/low times land on sample boundaries (off by up to half the sample interval) and the labeled heights drift from the true peak.
- **Both series, merged (chosen).** Exact extrema from `wlp-hilo` for the labels, hourly `wlp` for the shape including shoulders, merged so the marker always sits on the curve. About 196 points per week, well under 1 KB.

## Consequences

The cache format and the rendering pipeline both assume this merged shape: extrema and hourly samples share one sorted list, and the renderer expects the curve to already pass through every labeled marker. Changing to a single-series model later means reworking both the packed blob format (which carries a version byte for exactly this reason) and the draw code. The fixed weekly vertical scale means a low-range neap window looks visually flat; this is intentional, since every extremum is also labeled with its exact height, so no precision is lost and the spring/neap rhythm stays visually honest.
