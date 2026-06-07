# Curve drawn as a cosine between extrema; drop the hourly series

Status: accepted (supersedes the curve approach in ADR 0001)

## Decision

The tide curve is generated on the watch as a cosine between each pair of consecutive high/low extrema, rather than from sampled hourly water levels. Because the curve no longer needs intermediate samples, we fetch and cache only the `wlp-hilo` extrema (plus per-day sunrise/sunset). The hourly `wlp` series and the on-watch merged polyline are gone.

## Context

ADR 0001 merged `wlp-hilo` with a 60-minute `wlp` series so the drawn line would follow the real predicted shape, including shallow-water "shoulders" that are not turning points. After building the dark-theme redesign we chose the cosine-between-extrema look: it is smooth, reads cleanly on the small round screen, and is what the reference design we liked uses. A cosine between an adjacent high and low matches the dominant tide shape closely, and its 50% crossing falls at the time midpoint (so mid-tide markers and the interpolated "now" level stay consistent with the drawn curve).

## Consequences

- The cache shrinks from ~196 points/week to ~28 extrema/week; only one API call per refresh instead of two.
- We lose the non-reversing shoulders/stands that ADR 0001 deliberately preserved. This is accepted: on a glanceable watch face the cosine shape is good enough, and the diurnal inequality and any genuine double-tide (a real reversal, which still appears as extra extrema) are retained.
- The blob format is unchanged (it still carries `{epoch, heightCm, kind}` points); we simply send only extrema. Older caches that still contain hourly points render identically, since the curve builder uses the extrema and ignores plain samples.
