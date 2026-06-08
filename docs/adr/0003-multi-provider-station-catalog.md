# Multi-provider station catalog: dynamic per-provider fetch, merged selection

Status: accepted

## Decision

The app draws stations from two Providers — DFO (Canada, IWLS) and NOAA (US, CO-OPS) — instead of a single hand-trimmed DFO list. Each Provider's full catalog is fetched at runtime, filtered to Usable Stations, trimmed to `{id, name, lat, lng, provider}`, and stored as an independent per-Provider slice in a phone-side cache (`{dfo:{stations,fetchedAt}, noaa:{stations,fetchedAt}}`). Station selection runs the existing nearest-by-haversine over the union of all slices; the chosen station carries its `provider`, which selects the fetch adapter for that station's hilo predictions.

A small seed catalog (~15 KB) ships in the pkjs bundle as the offline / first-run fallback. On a first run with no real cache, the app awaits the live catalog fetch before selecting (one-time cost) so an out-of-seed-region user gets a correct nearby station; on every later run it selects instantly from the cache and refreshes in the background. Catalog slices refresh on a long TTL or an app/blob version bump, independently per Provider — a failed fetch keeps that Provider's last-good slice.

The two Providers' responses are normalised behind a per-Provider adapter so the rest of the pipeline stays Provider-agnostic. Each adapter exposes catalog fetch/parse, a hilo URL builder, and a `parseHilo` that returns the common `{epoch, heightCm, kind}` point shape. DFO's `parseHilo` runs the existing neighbour-comparison `classifyExtrema`; NOAA's reads `type` (H/L) directly. NOAA is queried with `datum=MLLW`, `units=metric`, `time_zone=gmt`, so heights are in metres and `t` parses as a UTC instant consistent with DFO's epochs.

## Context

The curated list in CONTEXT.md ("Station List") was a hand-trimmed subset of DFO, which limited coverage to BC even though IWLS covers all of Canada, and excluded the US entirely. The goal is coverage, and the curation step was the thing blocking it. NOAA's `type=tidepredictions` catalog and DFO's `operating` + `wlp-hilo` flags do the filtering the hand-trim used to do, so the curation can be dropped without admitting junk stations.

The catalog lives and is selected on the phone (pkjs), not the watch, so a ~460 KB merged catalog in localStorage is fine — the watch only ever receives the packed blob for one station. The constraint is the `.pbw`: bundling the full catalog would take it from ~172 KB to ~630 KB. The two Providers also diverge in schema (classification, value type, time base, datum, usability flag), so a single code path cannot consume both raw.

## Considered options

- **Static curated merge.** Keep bundling a hand-maintained list, hand-add NOAA stations. Preserves offline-by-default and the curation principle, but coverage grows only via app updates and the maintenance burden scales with every region added.
- **Dynamic, geo-routed (one Provider by region).** Fetch only the Provider for the user's coarse region. Smaller payload, but border regions (Vancouver vs Seattle, the Great Lakes) pick the wrong side or miss a closer cross-border station, breaking the "nearest" promise.
- **Dynamic union, cached, with seed fallback (chosen).** Fetch both full catalogs, filter and merge, cache per-Provider, select over the union. Best coverage and correct cross-border selection, at the cost of a runtime fetch and a larger phone-side cache.

## Consequences

- The "Station List" and "Usable Station" definitions become Provider-specific (see CONTEXT.md). A new "Provider" term threads through selection, caching, and fetch.
- Selection is now async on a cold start: the launch path must tolerate a catalog that arrives after `ready`. The seed bounds the worst case (offline first run shows a seed station with the existing far-flag).
- Per-Provider cache slices mean one API being down degrades only that country's coverage, and TTLs are independent. The cache schema and the `provider` tag on every station become load-bearing; changing them later touches selection, caching, and the adapters.
- The blob format and all watch C code are unchanged — the feature is entirely phone-side. The watch stays Provider-agnostic because adapters normalise to `{epoch, heightCm, kind}` before packing.
- Heights come relative to different datums per Provider (DFO chart datum, NOAA MLLW). Because only one station is shown at a time, the curve and labels stay internally consistent; no cross-datum comparison ever occurs.
