# UK tides via the keyless EasyTide endpoints

Status: accepted

## Decision

The UK Provider (British Isles: UK, Ireland, Channel Islands, Isle of Man) draws from the UK Hydrographic Office's **EasyTide** consumer endpoints, not the official keyed Admiralty UK Tidal API.

Two endpoints, both unauthenticated:

- Catalog: `https://easytide.admiralty.co.uk/Home/GetStations` returns a GeoJSON FeatureCollection of every Admiralty station (`properties.Id`, `properties.Name`, `properties.Country`, `geometry.coordinates [lon, lat]`). The adapter keeps only British-Isles `Country` values and trims to `{id, name, lat, lng, provider:'uk'}` — the same per-Provider catalog slice every other Provider produces.
- Predictions: `https://easytide.admiralty.co.uk/Home/GetPredictionData?stationId=<Id>` returns JSON with a `tidalEventList` of `{eventType (0=High, 1=Low), dateTime, height}`. `parseHilo` maps each to the common `{epoch, heightCm, kind}` shape: `epoch = Date.parse(dateTime + 'Z') / 1000`, `heightCm = round(height * 100)`, `kind = eventType === 0 ? 1 : 2`.

`dateTime` is UTC (the Admiralty API documents its event times as GMT, and EasyTide is the same backend), so it parses with a trailing `Z` exactly like NOAA and DFO — no timezone handling. Heights are metres above Chart Datum; because only one station is shown at a time, the datum stays internally consistent (see ADR 0003). The adapter slots into the existing registry with no watch-side change.

## Context

There is no keyless, official UK tide-prediction API. The authoritative source is the UKHO Admiralty UK Tidal API, whose free Discovery tier **requires a subscription key** and a registered agreement. Every existing Provider (DFO, NOAA, BOM) is keyless and backend-free; the app ships no server to hide a key behind, and a key embedded in the pkjs bundle is extractable and would share one quota across all users (and likely breach the API terms).

EasyTide is UKHO's own public website for the same predictions. Its front-end calls `GetStations` and `GetPredictionData` from the browser without a caller-side key — the Admiralty key lives server-side on UKHO's box. Hitting those endpoints directly gives us official UKHO data, keyless, with a GeoJSON catalog (coordinates included) and JSON high/low events that map onto the existing adapter contract. The cost is that these are undocumented consumer endpoints we are not formally licensed to consume programmatically, and they serve only the current day plus six (about 8 days).

The other keyless options were rejected: BBC Coast & Sea, tidetimes.org.uk, tides4fishing, and TideCheck are unofficial third-party sites with no API, "all rights reserved" terms, and HTML that breaks without warning. NTSLF is official and keyless with a 28-day horizon, but exposes no documented data endpoint (its pages load predictions dynamically) and lists only ~60 ports with no machine-readable coordinates.

## Considered options

- **UKHO Discovery API with a user-supplied key.** Each UK user registers for a free key and pastes it into config. Unambiguously within terms, 607 stations, documented JSON. Rejected as the default because it breaks the app's keyless, zero-setup promise that holds for every other region; kept as the fallback if EasyTide ever blocks us.
- **Embed a shared Discovery key in the bundle.** Simplest code, but the key is extractable, the free quota is shared across all installs (one bad actor exhausts it for everyone), and it likely violates the API agreement. Rejected.
- **NTSLF or third-party scraping.** Keyless but either undocumented and sparse (NTSLF) or unofficial, fragile, and ToS-dubious (BBC, tidetimes, tides4fishing). Rejected on reliability and terms.
- **Keyless EasyTide endpoints (chosen).** Official data, keyless, no backend, no user setup, a real catalog with coordinates, and a clean fit to the adapter contract — accepting undocumented endpoints and an ~8-day horizon.

## Consequences

- **The 45-day offline range cannot be reached for UK stations.** `GetPredictionData` returns a fixed ~8-day window and ignores any date range. Auto Mode (the short daily window) works fully; a Pinned Region of UK stations caches only the ~8 days returned, not the user's chosen Offline Range. The region download already stores whatever points come back, so this degrades gracefully rather than failing.
- **The endpoints are undocumented and unlicensed for this use.** UKHO could change the response shape or block non-browser clients at any time, which would break UK coverage with no warning. The adapter is isolated behind the registry, so a break degrades only UK (per ADR 0003's per-Provider failure isolation), and the documented recovery path is the UKHO Discovery API with a user-supplied key.
- **Be a polite client.** One station per user, cached hard and refreshed on the existing slow cadence, keeps request volume low. Catalog fetches reuse the existing per-Provider TTL.
- **The British-Isles `Country` filter is load-bearing.** `GetStations` returns the global Admiralty set; the whitelist of `Country` values is what scopes the Provider to the UK and keeps it from overlapping BOM/NOAA elsewhere. The exact value set must be confirmed against the live response.
- **The "Provider is keyless, backend-free, dynamically-cataloged" invariant holds** for UK, but only by using a consumer endpoint instead of the vendor's intended API. That tension is the reason this ADR exists.
