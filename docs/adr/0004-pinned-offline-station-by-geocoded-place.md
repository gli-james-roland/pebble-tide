# Pinned offline station selected by a geocoded place name

Status: superseded by ADR 0006

## Decision

The user can pin a Station for offline use by typing a **place name** (e.g. "Tofino BC", "Sydney Australia") into the phone config page instead of relying on GPS. On Save, PKJS geocodes the place via a public geocoder (OSM Nominatim, no API key, identifying `User-Agent`), runs the existing `geo.nearestUsableStation` over the cached catalog against the geocoded coordinates, and the result becomes the **Pinned Station** — the Tracked Station, overriding Auto/GPS selection (see CONTEXT.md). Pinning then fetches the chosen **Offline Range** (7/15/30/45 Days) for that Station and sends it to the watch.

The config page stays a self-contained `data:` URI. It collects `{ mode, place, range }` and returns it via the `pebblejs://close` round-trip; all resolution happens in PKJS afterward. Because that round-trip is one-shot, the resolved Station is shown **after the fact**: the watch displays the Pinned Station name (plus the existing far-warning flag if it sits >500 km from the place), and the next time config opens it shows "Pinned: <station> — ~<N> km from '<place>'".

## Context

Selection today is automatic: the nearest Usable Station to the device's GPS position. The offline use case is the opposite — the user wants a Station for a place they are *not* at yet, with no internet on arrival. That requires manual selection over the full catalog (~4,269 Usable Stations: NOAA 3,450, BOM 737, DFO 82).

The config surface is a sandboxed `data:` URI page (no Clay support for the gabbro/flint targets, and the app runs no backend — it is pure client plus public APIs). A `data:` URI has an opaque origin: it cannot `fetch` a catalog or geocoder, and there is no live channel to PKJS during the config session. So an in-page searchable list would have to inline the whole catalog (~180 KB URL-encoded), which is at the risky edge for `Pebble.openURL` and rebuilt on every open.

Geocoding a place sidesteps both problems: the page carries no catalog, and the heavy lifting (geocode + nearest) runs in PKJS, which *does* have network. It also reuses the app's core model — "nearest Usable Station to a location" — applied to a typed location instead of GPS, so the contract the user already understands carries over unchanged.

## Considered options

- **Inline searchable station list.** Inline the ~180 KB trimmed catalog into the `data:` URI, filter in-page, pick the exact Station. Zero new dependencies and exact-station choice, but bets on a 180 KB `data:` URI surviving `openURL` on every platform, and may force trimming coverage (e.g. NOAA reference-only).
- **Hosted config page.** Move config off the `data:` URI to a hosted page that fetches the catalog and geocodes live, with confirm-before-download. The cleanest picker, but adds a backend/hosting dependency the project has deliberately avoided.
- **Type a place, pin the nearest (chosen).** No catalog inlined, no backend; reuses `geo.nearestUsableStation`. Costs one external geocoder dependency and gives the *nearest* Station to the place rather than a hand-picked one — which is the same contract Auto mode already provides.

## Consequences

- A new external dependency: the geocoder. Nominatim is keyless but its usage policy discourages systematic use; volume is bounded because lookups are user-initiated and occasional. Photon is the drop-in fallback if volume ever becomes a concern.
- Selection is confirm-*after*, not confirm-before. An ambiguous place ("Sydney" → Australia vs Nova Scotia) is caught by the watch's far-warning and the config "Pinned: X, ~N km" line, then corrected by re-pinning with a more specific place. Confirm-before would require the hosted-page route.
- Pinning needs connectivity (it is the download-ahead moment). A geocode/network failure leaves the current Tracked Station unchanged and surfaces an error on the next config open.
- The pin (mode, place, resolved station, range) is persisted on the phone and drives skip-geolocation behavior on later launches (see ADR 0005 / lifecycle).
